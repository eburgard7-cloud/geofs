#!/usr/bin/env python3
"""End-to-end smoke test for the matchmaking hub (`WS /ws/hub`, relay proto 5).

    pip install websockets          # your machine only — NOT a server dependency
    python race/tools/hub_smoke.py wss://race.finsonly.net/ws/hub
    python race/tools/hub_smoke.py ws://localhost:8000/ws/hub

Why not curl: curl cannot complete a WebSocket session — a plain `curl -sS` never sends the
`Connection: Upgrade` handshake at all. It *can* prove the upgrade survives Caddy/geoblock, which
is the one thing worth checking before running this, so `DEPLOY_CHECKLIST.md` pairs a one-line
`curl -i -N` with this script. Everything past the 101 needs a real client.

What it checks, in order:
  1. hello with NO token          -> welcome{pilot_id, pilot_token, proto: 5}, then presence, rooms
  2. reconnect WITH that token    -> the SAME pilot_id, and the token echoed rather than rotated
  3. a stranger claiming the name -> refused, with the holder named; socket stays open
  4. where / list                 -> presence reflects the reported room and activity
  5. ping_ramp                    -> the OTHER client receives ramp_ping{from}

Read-only apart from what it must create: two `pilots` rows (callsigns prefixed `hub-smoke`) and
one spent ramp ping. It never joins a race room, so it cannot disturb anyone mid-flight.
DEPLOY_CHECKLIST.md ("Hub smoke test") has the cleanup query.

Exits 0 with every check printed, or non-zero on the first failure.
"""
import asyncio
import json
import sys
import time

try:
    import websockets
except ImportError:                                            # pragma: no cover - operator error
    sys.exit("needs the `websockets` package on THIS machine: pip install websockets")

SUFFIX = str(int(time.time()))[-6:]        # so a re-run does not collide with its own leftovers
NAME_A = f"hub-smoke-a{SUFFIX}"
NAME_B = f"hub-smoke-b{SUFFIX}"
RECV_TIMEOUT_S = 10.0

_checks = 0


def ok(what: str) -> None:
    global _checks
    _checks += 1
    print(f"  ok  {what}")


def die(what: str) -> None:
    print(f"FAIL  {what}", file=sys.stderr)
    sys.exit(1)


async def send(ws, frame: dict) -> None:
    await ws.send(json.dumps(frame))


async def recv(ws, *types: str, timeout: float = RECV_TIMEOUT_S) -> dict:
    """Next frame whose type is one of `types` (any type if none given). Everything else is read
    past — presence and rooms land unprompted, which is the point of the hub."""
    deadline = time.monotonic() + timeout
    while True:
        left = deadline - time.monotonic()
        if left <= 0:
            die(f"timed out waiting for {types or 'any frame'}")
        try:
            raw = await asyncio.wait_for(ws.recv(), timeout=left)
        except asyncio.TimeoutError:
            die(f"timed out waiting for {types or 'any frame'}")
        frame = json.loads(raw)
        if not types or frame.get("type") in types:
            return frame


async def hello(ws, callsign: str, token=None, model="b747") -> dict:
    frame = {"type": "hello", "callsign": callsign, "model": model}
    if token is not None:
        frame["pilot_token"] = token
    await send(ws, frame)
    return await recv(ws, "welcome", "error")


async def main(url: str) -> None:
    print(f"hub smoke test -> {url}")

    # ---- 1. a pilot we have never met
    async with websockets.connect(url) as a:
        welcome = await hello(a, NAME_A)
        if welcome["type"] != "welcome":
            die(f"first hello was refused: {welcome}")
        pilot_id, token = welcome.get("pilot_id"), welcome.get("pilot_token")
        if not pilot_id or not token:
            die(f"welcome is missing an identity: {welcome}")
        if welcome.get("proto") != 5:
            die(f"expected proto 5, got {welcome.get('proto')!r}")
        ok(f"hello with no token minted an identity (proto 5, pilot_id {pilot_id[:8]}…)")

        # welcome is followed by presence then rooms, always.
        presence = await recv(a, "presence")
        if not any(p["callsign"] == NAME_A for p in presence["pilots"]):
            die(f"not on the ramp after hello: {presence}")
        ok(f"presence lists {NAME_A} ({len(presence['pilots'])} pilot(s) on the ramp)")
        rooms = await recv(a, "rooms")
        ok(f"rooms frame arrived ({len(rooms['rooms'])} room(s) listed)")

    # ---- 2. the token resolves to the same pilot next time
    async with websockets.connect(url) as a:
        again = await hello(a, NAME_A, token=token)
        if again["type"] != "welcome":
            die(f"reconnect with a valid token was refused: {again}")
        if again.get("pilot_id") != pilot_id:
            die(f"token resolved to a different pilot: {again.get('pilot_id')} != {pilot_id}")
        if again.get("pilot_token") != token:
            die("an existing token should be echoed, not rotated")
        ok("reconnecting with the stored token is the same pilot_id")
        await recv(a, "presence")
        await recv(a, "rooms")

        # ---- 3. somebody else cannot take the name, and is not disconnected for trying
        async with websockets.connect(url) as b:
            refused = await hello(b, NAME_A.upper())        # ownership is case-insensitive
            if refused["type"] != "error":
                die(f"a claim on a held callsign should be refused, got {refused}")
            if NAME_A not in refused.get("detail", ""):
                die(f"the refusal should name the holder: {refused}")
            ok(f"claiming a held callsign is refused: {refused['detail']!r}")

            second = await hello(b, NAME_B)
            if second["type"] != "welcome":
                die(f"the socket should still be usable after a refusal, got {second}")
            ok(f"the same socket then claimed {NAME_B} — a refusal does not close it")
            await recv(b, "presence")
            await recv(b, "rooms")

            # ---- 4. where / list
            await send(b, {"type": "where", "room": "hub-smoke-room", "activity": "gate"})
            for _ in range(6):
                presence = await recv(a, "presence")
                row = next((p for p in presence["pilots"] if p["callsign"] == NAME_B), None)
                if row and row["room"] == "hub-smoke-room":
                    break
            else:
                die("presence never reflected the reported room")
            if row["activity"] != "gate":
                die(f"activity not reflected: {row}")
            ok("where{room, activity} shows up in everyone's presence")

            await send(b, {"type": "where", "room": "Not A Room Code!", "activity": "idle"})
            bad = await recv(b, "error")
            ok(f"a bad room code is refused, not rewritten: {bad['detail']!r}")

            await send(a, {"type": "list"})
            await recv(a, "presence")
            await recv(a, "rooms")
            ok("list is answered immediately with presence + rooms")

            # ---- 5. ping the ramp. Deliberately scarce: this spends one of three for today.
            await send(a, {"type": "ping_ramp"})
            ping = await recv(b, "ramp_ping", "error")
            if ping["type"] == "error":
                # Over the cap or inside the cooldown from an earlier run — still a working server,
                # and the refusal is the documented behavior, so report it rather than failing.
                ok(f"ping_ramp refused (cap/cooldown working): {ping['detail']!r}")
            else:
                if ping.get("from") != NAME_A:
                    die(f"ramp_ping should name the sender: {ping}")
                ok(f"ping_ramp reached the other client as ramp_ping from {NAME_A}")
                # The sender must NOT receive its own ping.
                await send(a, {"type": "list"})
                echo = await recv(a, "ramp_ping", "presence")
                if echo["type"] == "ramp_ping":
                    die("the sender should never receive its own ramp_ping")
                ok("the sender does not receive its own ramp_ping")

    print(f"\nall {_checks} checks passed")
    print(f"created pilots: {NAME_A}, {NAME_B} — see DEPLOY_CHECKLIST.md for the cleanup query")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__.strip().splitlines()[2].strip())
    asyncio.run(main(sys.argv[1]))
