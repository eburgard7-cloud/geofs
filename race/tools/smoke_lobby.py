#!/usr/bin/env python3
"""End-to-end smoke test for a race-room lobby (`WS /ws/race/{room}`), with 2 or 3 scripted pilots.

    pip install websockets          # your machine only — NOT a server dependency
    python race/tools/smoke_lobby.py                                   # wss://race.finsonly.net
    python race/tools/smoke_lobby.py --url ws://127.0.0.1:8000 --clients 3

It is also run by race/test/test_server.py against a local uvicorn, so the same script is the
check before a deploy and after one.

Steps, each printed PASS / FAIL / SKIP (a step whose prerequisite failed is skipped):
   1. join        every pilot joins a throwaway room `smoke-<hex>`; joined.proto >= 5
   2. presence    every pilot's lobby lists every pilot; the first joiner is host
   3. chat A->B   a typed line from A reaches B as {from, text}
   4. chat B->A   and back
   5. vote        the vote offers at least one REAL course (not only surprise-me); everyone votes it
   6. ready       everyone readies; the lobby shows all of them ready
   7. GO          the host starts; every pilot gets `start` naming all racers and the voted course,
                  with GO in the future on the relay clock
   8. grid        the grid slots race.js would compute for that course are distinct and >= 80 m apart
   9. abort       the host aborts the countdown (so the throwaway race is never scored or written)
  10. spectate    a spectator joins, is listed as one, and is refused a `pos`
  11. leave       the last pilot leaves; everyone else's lobby drops them
  12. handoff     the host leaves; the longest-connected remaining pilot becomes host

Writes nothing to the leaderboard: no run is posted, the race is aborted before GO, and the race
socket never touches `pilots`. The room disappears when the last socket closes.
Exits 0 when every step passed, 1 otherwise.
"""
import argparse
import asyncio
import json
import math
import os
import secrets
import sys
import time

try:
    import websockets
except ImportError:                                            # pragma: no cover - operator error
    sys.exit("needs the `websockets` package on THIS machine: pip install websockets")

SURPRISE_ME = "surprise-me"
GRID_SPEED_MS = 150.0            # race.js CONFIG.FLY_TO_START_SPEED_MS
LEAD_S = 10
HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_COURSES = os.path.normpath(os.path.join(HERE, "..", "courses"))


class StepFailed(Exception):
    pass


class Pilot:
    """One scripted client: a socket, and every frame it has received, in order."""

    def __init__(self, name: str, ws):
        self.name, self.ws, self.frames = name, ws, []
        self._new = asyncio.Event()
        self._task = asyncio.ensure_future(self._reader())

    async def _reader(self):
        try:
            async for raw in self.ws:
                self.frames.append(json.loads(raw))
                self._new.set()
        except Exception:
            pass
        finally:
            self._new.set()

    async def send(self, frame: dict):
        await self.ws.send(json.dumps(frame))

    def mark(self) -> int:
        return len(self.frames)

    async def wait(self, pred, what: str, since: int = 0, timeout: float = 8.0) -> dict:
        deadline = time.monotonic() + timeout
        i = since
        while True:
            while i < len(self.frames):
                f = self.frames[i]
                i += 1
                if pred(f):
                    return f
            left = deadline - time.monotonic()
            if left <= 0:
                raise StepFailed(f"{self.name}: timed out waiting for {what}")
            self._new.clear()
            try:
                await asyncio.wait_for(self._new.wait(), timeout=left)
            except asyncio.TimeoutError:
                raise StepFailed(f"{self.name}: timed out waiting for {what}") from None

    async def close(self):
        try:
            await self.ws.close()
        except Exception:
            pass
        self._task.cancel()


# ---- the grid, exactly as race.js computes it (gridSlot / bearingDeg / destination)
R_EARTH = 6371008.8


def bearing_deg(a, b):
    f1, f2 = math.radians(a["lat"]), math.radians(b["lat"])
    dl = math.radians(b["lon"] - a["lon"])
    y = math.sin(dl) * math.cos(f2)
    x = math.cos(f1) * math.sin(f2) - math.sin(f1) * math.cos(f2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def destination(p, brg, dist_m):
    d, t = dist_m / R_EARTH, math.radians(brg)
    f1, l1 = math.radians(p["lat"]), math.radians(p["lon"])
    f2 = math.asin(math.sin(f1) * math.cos(d) + math.cos(f1) * math.sin(d) * math.cos(t))
    l2 = l1 + math.atan2(math.sin(t) * math.sin(d) * math.cos(f1), math.cos(d) - math.sin(f1) * math.sin(f2))
    return {"lat": math.degrees(f2), "lon": ((math.degrees(l2) + 540) % 360) - 180}


def grid_slot(g1, g2, index, n, lead_s, speed_ms):
    heading = bearing_deg(g1, g2)
    base = destination(g1, (heading + 180) % 360, max(0.0, speed_ms * lead_s))
    lateral = (index - (max(1, n) - 1) / 2) * 80
    perp = (heading + (90 if lateral >= 0 else -90)) % 360
    slot = destination(base, perp, abs(lateral))
    return {"lat": slot["lat"], "lon": slot["lon"], "alt": g1["alt"] + index * 30}


def haversine_m(a, b):
    f1, f2 = math.radians(a["lat"]), math.radians(b["lat"])
    df, dl = f2 - f1, math.radians(b["lon"] - a["lon"])
    s = math.sin(df / 2) ** 2 + math.cos(f1) * math.cos(f2) * math.sin(dl / 2) ** 2
    return 2 * R_EARTH * math.atan2(math.sqrt(s), math.sqrt(1 - s))


def load_course(courses_dir: str, course_id: str) -> dict:
    with open(os.path.join(courses_dir, "index.json"), encoding="utf-8") as f:
        entry = next((e for e in json.load(f) if e["id"] == course_id), None)
    if entry is None:
        raise StepFailed(f"course {course_id!r} is not in {courses_dir}/index.json")
    with open(os.path.join(courses_dir, entry["file"]), encoding="utf-8") as f:
        return json.load(f)


def ws_base(url: str) -> str:
    u = url.rstrip("/")
    if u.startswith("http"):
        u = "ws" + u[4:]
    for suffix in ("/ws/race", "/ws/hub"):
        if u.endswith(suffix):
            u = u[: -len(suffix)]
    return u


async def run(url: str, n_clients: int, courses_dir: str) -> int:
    tag = secrets.token_hex(3)
    room = f"smoke-{tag}"
    base = ws_base(url)
    names = [f"smoke-{c}-{tag}" for c in "abc"[:n_clients]]
    ctx = {"pilots": [], "results": []}
    print(f"smoke_lobby: {base}/ws/race/{room} with {n_clients} pilots")

    async def connect(name, **extra):
        ws = await websockets.connect(f"{base}/ws/race/{room}", open_timeout=10)
        p = Pilot(name, ws)
        await p.send({"type": "join", "callsign": name, "client_proto": 5, **extra})
        joined = await p.wait(lambda f: f.get("type") in ("joined", "error"), "joined")
        if joined["type"] == "error":
            raise StepFailed(f"{name}: join refused: {joined.get('detail')}")
        return p, joined

    def lobby_has(names_, pred=None):
        return lambda f: (f.get("type") == "lobby"
                          and {p["callsign"] for p in f.get("players", [])} == set(names_)
                          and (pred is None or pred(f)))

    async def s_join():
        protos = []
        for name in names:
            p, joined = await connect(name)
            ctx["pilots"].append(p)
            protos.append(joined.get("proto"))
        if not all(isinstance(x, int) and x >= 5 for x in protos):
            raise StepFailed(f"joined.proto {protos}; this client needs >= 5")
        a = ctx["pilots"][0]
        t0 = time.time() * 1000
        await a.send({"type": "ping", "t0": t0})
        pong = await a.wait(lambda f: f.get("type") == "pong" and f.get("t0") == t0, "pong")
        t1 = time.time() * 1000
        ctx["offset"] = pong["server_ms"] + (t1 - t0) / 2 - t1
        return f"proto {protos[0]}, relay clock offset {ctx['offset']:+.0f} ms"

    async def s_presence():
        for p in ctx["pilots"]:
            f = await p.wait(lobby_has(names), f"a lobby listing {names}")
            if f.get("host") != names[0]:
                raise StepFailed(f"{p.name} sees host {f.get('host')!r}, expected {names[0]!r}")
        return f"{len(names)} pilots listed, host {names[0]}"

    async def chat(frm, to):
        text = f"smoke {frm.name} to {to.name} {secrets.token_hex(2)}"
        m = to.mark()
        await frm.send({"type": "chat", "text": text})
        await to.wait(lambda f: f.get("type") == "chat" and f.get("from") == frm.name and f.get("text") == text,
                      "the chat line", since=m)
        return "delivered as {from, text}"

    async def s_vote():
        a = ctx["pilots"][0]
        v = await a.wait(lambda f: f.get("type") == "vote", "a vote frame")
        real = [c["course_id"] for c in v.get("candidates", []) if c.get("course_id") != SURPRISE_ME]
        if not real:
            raise StepFailed(f"no real course among the candidates {v.get('candidates')} - does the server have 0 courses?")
        pick = real[0]
        ctx["pick"] = pick
        for p in ctx["pilots"]:
            await p.send({"type": "vote", "course_id": pick})
        want = {p.name: pick for p in ctx["pilots"]}
        await a.wait(lambda f: f.get("type") == "vote" and f.get("votes") == want, "the tally with every vote")
        return f"{len(real)} real candidates, voted {pick}"

    async def s_ready():
        for p in ctx["pilots"]:
            await p.send({"type": "ready", "ready": True})
        await ctx["pilots"][0].wait(lobby_has(names, lambda f: all(p["ready"] for p in f["players"])), "everyone ready")
        return "all ready"

    async def s_go():
        a = ctx["pilots"][0]
        marks = [p.mark() for p in ctx["pilots"]]
        await a.send({"type": "start", "lead_s": LEAD_S})
        starts = []
        for p, m in zip(ctx["pilots"], marks):
            f = await p.wait(lambda f: f.get("type") in ("start", "error"), "start", since=m)
            if f["type"] == "error":
                raise StepFailed(f"start refused: {f.get('detail')}")
            starts.append(f)
        s = starts[0]
        if set(s.get("racers", [])) != set(names):
            raise StepFailed(f"racers {s.get('racers')} != {names}")
        course = s.get("course")
        if not course:
            raise StepFailed("start carries no `course` - the server predates the lobby reliability pass")
        if course.get("course_id") != ctx["pick"]:
            raise StepFailed(f"start is for {course.get('course_id')!r}, the vote was {ctx['pick']!r}")
        server_now = time.time() * 1000 + ctx["offset"]
        ahead = s["start_at_server_ms"] - server_now
        if not 0 < ahead <= LEAD_S * 1000 + 1500:
            raise StepFailed(f"GO is {ahead:.0f} ms from now on the relay clock")
        ctx["start"] = s
        return f"GO in {ahead / 1000:.1f} s on {course['course_id']} ({course.get('course_hash')})"

    async def s_grid():
        s = ctx["start"]
        raw = load_course(courses_dir, s["course"]["course_id"])
        g1, g2 = raw["gates"][0], raw["gates"][1]
        racers = s["racers"]
        slots = [grid_slot(g1, g2, i, len(racers), LEAD_S, GRID_SPEED_MS) for i in range(len(racers))]
        gaps = [haversine_m(slots[i], slots[j]) for i in range(len(slots)) for j in range(i + 1, len(slots))]
        if len({(round(x["lat"], 7), round(x["lon"], 7), x["alt"]) for x in slots}) != len(slots):
            raise StepFailed("two racers share a grid slot")
        if gaps and min(gaps) < 79:
            raise StepFailed(f"grid slots only {min(gaps):.1f} m apart")
        back = haversine_m(g1, slots[0])
        return f"{len(slots)} distinct slots, min gap {min(gaps):.0f} m, ~{back:.0f} m behind gate 1" if gaps else "1 slot"

    async def s_abort():
        a = ctx["pilots"][0]
        marks = [p.mark() for p in ctx["pilots"]]
        await a.send({"type": "abort"})
        for p, m in zip(ctx["pilots"], marks):
            await p.wait(lambda f: f.get("type") == "abort", "abort", since=m)
        await a.wait(lambda f: f.get("type") == "lobby" and f.get("phase") == "lobby", "the room back in lobby", since=marks[0])
        return "countdown aborted; nothing is scored or written"

    async def s_spectate():
        name = f"smoke-s-{tag}"
        a = ctx["pilots"][0]
        m = a.mark()
        spec, _ = await connect(name, spectate=True)
        ctx["spectator"] = spec
        await a.wait(lobby_has(names + [name], lambda f: any(p["callsign"] == name and p["role"] == "spectator"
                                                              for p in f["players"])), "the spectator listed", since=m)
        m2 = spec.mark()
        await spec.send({"type": "pos", "gate": 0, "elapsed_ms": 0, "lat": 0.0, "lon": 0.0})
        err = await spec.wait(lambda f: f.get("type") == "error", "a refusal of pos", since=m2)
        if "spectators cannot send" not in err.get("detail", ""):
            raise StepFailed(f"pos refusal said {err.get('detail')!r}")
        return "listed as spectator, pos refused"

    async def s_leave():
        leaver = ctx["pilots"][-1]
        rest = [p for p in ctx["pilots"] if p is not leaver] + [ctx["spectator"]]
        marks = [p.mark() for p in rest]
        await leaver.close()
        ctx["pilots"].remove(leaver)
        want = [p.name for p in rest]
        for p, m in zip(rest, marks):
            await p.wait(lobby_has(want), f"a lobby without {leaver.name}", since=m)
        return f"{leaver.name} left; {len(rest)} remain"

    async def s_handoff():
        host = ctx["pilots"][0]
        rest = ctx["pilots"][1:] + [ctx["spectator"]]
        expect = rest[0].name
        marks = [p.mark() for p in rest]
        await host.close()
        ctx["pilots"].remove(host)
        for p, m in zip(rest, marks):
            f = await p.wait(lambda f: f.get("type") == "lobby" and host.name not in {x["callsign"] for x in f["players"]},
                             "a lobby after the host left", since=m)
            if f.get("host") != expect:
                raise StepFailed(f"{p.name} sees host {f.get('host')!r}, expected {expect!r}")
        return f"host passed to {expect}"

    steps = [("join", s_join, None), ("presence", s_presence, "join"),
             ("chat A->B", lambda: chat(ctx["pilots"][0], ctx["pilots"][1]), "join"),
             ("chat B->A", lambda: chat(ctx["pilots"][1], ctx["pilots"][0]), "join"),
             ("vote", s_vote, "join"), ("ready", s_ready, "join"), ("GO", s_go, "vote"),
             ("grid", s_grid, "GO"), ("abort", s_abort, "GO"), ("spectate", s_spectate, "join"),
             ("leave", s_leave, "spectate"), ("handoff", s_handoff, "leave")]
    passed = {}
    try:
        for name, fn, needs in steps:
            if needs and not passed.get(needs):
                print(f"SKIP  {name:<10} (needs {needs})")
                passed[name] = False
                continue
            try:
                detail = await fn()
                passed[name] = True
                print(f"PASS  {name:<10} {detail}")
            except (StepFailed, OSError, asyncio.TimeoutError, websockets.WebSocketException) as e:
                passed[name] = False
                print(f"FAIL  {name:<10} {e}")
    finally:
        for p in ctx["pilots"] + ([ctx["spectator"]] if "spectator" in ctx else []):
            await p.close()
    failed = [k for k, v in passed.items() if not v]
    print(("FAILED: " + ", ".join(failed)) if failed else f"all {len(steps)} steps passed")
    return 1 if failed else 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--url", default="wss://race.finsonly.net", help="relay base URL (ws/wss/http/https)")
    ap.add_argument("--clients", type=int, default=2, choices=(2, 3), help="scripted pilots (2 or 3)")
    ap.add_argument("--courses-dir", default=DEFAULT_COURSES, help="race/courses, for the grid geometry")
    args = ap.parse_args(argv)
    return asyncio.run(run(args.url, args.clients, args.courses_dir))


if __name__ == "__main__":
    sys.exit(main())
