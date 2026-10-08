"""ROAM + Dash (proto 11): airports, the pure dash engine, run hooks, and the relay glue.

Run: cd race/server && RACE_DB=/tmp/race-test.db python -m pytest ../test/test_server.py ../test/test_dash.py -q
"""
import os, sys
import contextlib
import io
import json
import time as _time
import uuid
os.environ.setdefault("RACE_DB", "/tmp/race-test.db")
os.environ.setdefault("RACE_MIN_INTERVAL_S", "0")
os.environ.setdefault("RACE_GET_MIN_INTERVAL_S", "0")
os.environ.setdefault("RACE_CLAIM_MIN_INTERVAL_S", "0")
os.environ.setdefault("RACE_TILE_WARM", "0")
os.environ.setdefault("RACE_COURSES_DIR", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "courses"))
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "server"))
sys.path.insert(0, os.path.join(HERE, "..", "server", "airports"))
import pytest
from fastapi.testclient import TestClient
import app as appmod
import airportdb
import build_airports
import diff_geofs


# =============================================================================== helpers
def _wait_until(pred, timeout=2.0):
    start = _time.time()
    while _time.time() - start < timeout:
        if pred():
            return True
        _time.sleep(0.02)
    return False


def _join(ws, callsign, proto=None, **kw):
    """A join; proto 11 (this file's subject) unless told otherwise. proto=0 is an old client."""
    frame = {"type": "join", "callsign": callsign, **kw}
    proto = appmod.PROTO if proto is None else proto
    if proto:
        frame["client_proto"] = proto
    ws.send_json(frame)
    joined = ws.receive_json()
    assert joined["type"] == "joined", joined
    return joined


def _drain(ws):
    """Every frame queued for this socket up to a ping/pong round trip (see test_server.py)."""
    ws.send_json({"type": "ping", "t0": 42.5})
    frames = []
    while True:
        m = ws.receive_json()
        if m["type"] == "pong" and m["t0"] == 42.5:
            return frames
        frames.append(m)


def _of(frames, type_):
    return [f for f in frames if f["type"] == type_]


@contextlib.contextmanager
def _pilots(c, room, names, proto=None):
    """One socket per name, all joined to `room`; the first joiner is host. `proto` per name
    (dict) or for everyone."""
    with contextlib.ExitStack() as stack:
        wss = {}
        for n in names:
            ws = stack.enter_context(c.websocket_connect(f"/ws/race/{room}"))
            _join(ws, n, proto.get(n) if isinstance(proto, dict) else proto)
            wss[n] = ws
        yield wss


def _course():
    """A ground start: an air start with every racer on proto >= 8 would go to FORMATION."""
    return {"type": "course", "course_id": "starter-sprint-seatac", "course_hash": "0a1b2c3d",
            "name": "Starter Sprint", "start_type": "ground"}


def _until(ws, pred, limit=500):
    """Read forward until a frame matches. For frames sent after an await the test cannot see
    (go_home's vote redraw runs in a thread, so `phase` is home a moment before `home` is sent)."""
    for _ in range(limit):
        m = ws.receive_json()
        if pred(m):
            return m
    raise AssertionError("frame never arrived")


def _home(ws):
    return _until(ws, lambda m: m["type"] == "home")


def _start_gate_race(name, wss):
    """Course, everyone ready, start; then skip the countdown (GO was 30 s ago)."""
    rm = appmod.rooms[name]
    host = next(iter(wss.values()))
    if rm.course is None:
        host.send_json(_course())
        assert _wait_until(lambda: rm.course is not None)
    for ws in wss.values():
        ws.send_json({"type": "ready", "ready": True})
    assert _wait_until(lambda: all(p.ready for p in rm.players.values()))
    host.send_json({"type": "start", "lead_s": 5})
    assert _wait_until(lambda: rm.phase == "countdown" and rm.race is not None)
    rm.race.start_at_ms = appmod.server_ms() - 30_000
    rm.phase = "racing"


def _finish_all(name, wss):
    rm = appmod.rooms[name]
    for i, ws in enumerate(wss.values()):
        go = appmod.server_ms() - rm.race.start_at_ms - 2000 + i * 500
        ws.send_json({"type": "finish", "race_id": rm.race_id, "go_time_ms": go})
    assert _wait_until(lambda: rm.phase == "results", 3.0)


def _chat(ws, text):
    ws.send_json({"type": "chat", "text": text})


# =============================================================================== airports
def test_dataset_loads_with_kpdx_and_ksea_and_their_runways():
    db = appmod.AIRPORTS
    assert db is not None and len(db) > 4000, "large + medium airports worldwide"
    pdx, sea = db.get("KPDX"), db.get("ksea")
    assert pdx["name"].startswith("Portland International") and sea["iata"] == "SEA"
    assert {(r["le"], r["he"]) for r in pdx["runways"]} >= {("10L", "28R"), ("10R", "28L")}
    rwy = next(r for r in pdx["runways"] if r["le"] == "10R")
    assert airportdb.runway_has_ends(rwy) and 100 < rwy["hdg"] < 140 and rwy["length_ft"] >= 10000
    assert db.get("PDX") is pdx, "an IATA code resolves through the alias table"
    assert db.get("ZZZZ") is None


def test_search_ranks_exact_code_then_alias_then_names():
    db = appmod.AIRPORTS
    assert db.search("KSEA")[0]["icao"] == "KSEA"
    assert db.search("pdx")[0]["icao"] == "KPDX", "exact IATA beats any prefix match"
    rows = db.search("seattle")
    assert 0 < len(rows) <= 10 and "KSEA" in [r["icao"] for r in rows]
    assert rows[0]["type"] == "large", "large airports first within a tier"
    assert db.search("   ") == []
    assert len(db.search("a")) == 10, "never more than SEARCH_LIMIT"


def test_api_airports_search_and_lookup():
    with TestClient(appmod.app) as c:
        r = c.get("/api/airports", params={"q": "seattle"})
        assert r.status_code == 200
        rows = r.json()["airports"]
        assert len(rows) <= 10 and any(a["icao"] == "KSEA" for a in rows)
        assert "runways" not in rows[0], "search rows stay small"
        one = c.get("/api/airports/kpdx").json()
        assert one["icao"] == "KPDX" and len(one["runways"]) >= 3
        assert c.get("/api/airports/ZZZZ").status_code == 404
        assert c.get("/api/airports", params={"q": ""}).status_code == 422
        assert c.get("/health").json()["airports"] == len(appmod.AIRPORTS)
        assert "airports" in c.get("/version").json()["features"]


def test_api_airports_has_its_own_rate_gate(monkeypatch):
    monkeypatch.setattr(appmod, "AIRPORT_RATE_PER_S", 1)
    monkeypatch.setattr(appmod, "AIRPORT_BURST", 2)
    monkeypatch.setattr(appmod, "_airport_gates", {})
    with TestClient(appmod.app) as c:
        codes = [c.get("/api/airports", params={"q": "kp"}).status_code for _ in range(3)]
    assert codes == [200, 200, 429]


def test_destination_boundary_is_runway_extents_plus_1km_else_3km_radius():
    sea = appmod.AIRPORTS.get("KSEA")
    rwy = sea["runways"][0]
    mid = ((rwy["le_lat"] + rwy["he_lat"]) / 2, (rwy["le_lon"] + rwy["he_lon"]) / 2)
    assert airportdb.in_destination(sea, *mid)
    assert not airportdb.in_destination(sea, 47.5, -122.0)
    # One east-west runway (KSEA's staggered parallels would blur the edge): 0.9 km past its end
    # is in, 1.3 km is out, and so is 1.3 km abeam.
    one = {"icao": "XONE", "lat": 0.0, "lon": 0.0,
           "runways": [{"le_lat": 0.0, "le_lon": -0.01, "he_lat": 0.0, "he_lon": 0.01, "width_ft": 0}]}
    deg = 1 / 111195.0
    assert airportdb.in_destination(one, 0.0, 0.01 + 900 * deg)
    assert not airportdb.in_destination(one, 0.0, 0.01 + 1300 * deg)
    assert airportdb.in_destination(one, 900 * deg, 0.0)
    assert not airportdb.in_destination(one, 1300 * deg, 0.0)
    bare = {"icao": "XXXX", "lat": 10.0, "lon": 10.0, "runways": [{"le": "09", "he": "27"}]}
    assert airportdb.destination_distance_m(bare, 10.0, 10.02)[1] == "radius"
    assert airportdb.in_destination(bare, 10.0, 10.02)          # ~2.2 km
    assert not airportdb.in_destination(bare, 10.0, 10.04)      # ~4.4 km


AIRPORTS_CSV = '''"id","ident","type","name","latitude_deg","longitude_deg","elevation_ft","continent","iso_country","iso_region","municipality","scheduled_service","icao_code","iata_code","gps_code","local_code","home_link","wikipedia_link","keywords"
1,"KAAA","large_airport","Alpha Intl",45.0,-122.0,100,"NA","US","US-OR","Alpha","yes","KAAA","AAA","KAAA","AAA",,,
2,"X1","medium_airport","Bravo Field",46.0,-121.0,200,"NA","US","US-WA","Bravo","no",,"",KBBB,"X1",,,
3,"US-0003","medium_airport","Charlie Strip",47.0,-120.0,300,"NA","US","US-WA","Charlie","no",,,,,,,
4,"HELI","heliport","Pad",45.1,-122.1,10,"NA","US","US-OR","Alpha","no",,,,,,,
5,"SMOL","small_airport","Tiny",45.2,-122.2,10,"NA","US","US-OR","Alpha","no",,,,,,,
6,"KCLS","closed","Gone",45.3,-122.3,10,"NA","US","US-OR","Alpha","no",,,,,,,
'''
RUNWAYS_CSV = '''"id","airport_ref","airport_ident","length_ft","width_ft","surface","lighted","closed","le_ident","le_latitude_deg","le_longitude_deg","le_elevation_ft","le_heading_degT","le_displaced_threshold_ft","he_ident","he_latitude_deg","he_longitude_deg","he_elevation_ft","he_heading_degT","he_displaced_threshold_ft"
10,1,"KAAA",9000,150,"ASP",1,0,"09",45.0,-122.02,100,90,,"27",45.0,-121.98,100,270,
11,1,"KAAA",5000,100,"ASP",1,1,"18",45.01,-122.0,100,180,,"36",44.99,-122.0,100,0,
12,2,"X1",6000,100,"ASP",1,0,"04",46.0,-121.01,200,,,"22",46.01,-121.0,200,,
13,3,"US-0003",3000,60,"TURF",0,0,"N",,,,,,"S",,,,,
'''


def test_build_airports_keeps_open_large_and_medium_with_open_runways():
    data = build_airports.build(AIRPORTS_CSV, RUNWAYS_CSV)
    by = {a["icao"]: a for a in data["airports"]}
    assert set(by) == {"KAAA", "KBBB", "US-0003"}, "icao_code, else 4-char gps_code, else ident"
    assert by["KAAA"]["type"] == "large" and by["KAAA"]["aliases"] == ["AAA"]
    assert by["KBBB"]["aliases"] == ["X1"]
    assert [r["le"] for r in by["KAAA"]["runways"]] == ["09"], "a closed runway is dropped"
    assert 30 < by["KBBB"]["runways"][0]["hdg"] < 40, "heading computed from the ends when missing"
    assert by["US-0003"]["runways"][0]["le_lat"] is None
    assert data["count"] == 3 and data["source"].startswith("OurAirports")


def test_build_airports_output_is_byte_identical(tmp_path):
    data = build_airports.build(AIRPORTS_CSV, RUNWAYS_CSV)
    a, b = tmp_path / "a.gz", tmp_path / "b.gz"
    build_airports.write_gz(data, str(a))
    build_airports.write_gz(data, str(b))
    assert a.read_bytes() == b.read_bytes()
    db = airportdb.load(str(a))
    assert len(db) == 3 and db.get("AAA")["icao"] == "KAAA"
    assert airportdb.load(str(tmp_path / "missing.gz")) is None


def test_diff_geofs_reports_both_sides_aliases_and_moved_airports(tmp_path):
    db = airportdb.AirportDB(build_airports.build(AIRPORTS_CSV, RUNWAYS_CSV))
    geofs = {"KAAA": [45.0, -122.0, 100], "X1": [46.0, -121.0], "ZZZZ": [1, 2],
             "US-0003": [47.3, -120.0]}            # ~33 km off
    d = diff_geofs.diff(geofs, db)
    assert d["only_geofs"] == ["ZZZZ"] and d["only_ours"] == []
    assert d["via_alias"] == [{"geofs": "X1", "ours": "KBBB"}]
    assert [m["icao"] for m in d["position_mismatch"]] == ["US-0003"]
    dump = tmp_path / "geofs.json"
    dump.write_text(json.dumps(geofs))
    src = tmp_path / "ours.gz"
    build_airports.write_gz(build_airports.build(AIRPORTS_CSV, RUNWAYS_CSV), str(src))
    out = io.StringIO()
    old, sys.stdout = sys.stdout, out
    try:
        assert diff_geofs.main([str(dump), "--airports", str(src), "--json"]) == 0
    finally:
        sys.stdout = old
    assert json.loads(out.getvalue())["only_geofs"] == ["ZZZZ"]


def test_every_local_module_app_imports_ships_in_the_image():
    """The build context is an allow-list (.dockerignore) and the Dockerfile COPYs by name, so a new
    server module that is imported but not shipped would only fail on the Unraid box."""
    import re
    root = os.path.join(HERE, "..", "..")
    server = os.path.join(root, "race", "server")
    with open(os.path.join(server, "app.py"), encoding="utf-8") as f:
        src = f.read()
    local = {m for m in re.findall(r"^(?:from|import) (\w+)", src, re.M)
             if os.path.isfile(os.path.join(server, m + ".py"))}
    assert {"airportdb", "migrate_modes"} <= local
    with open(os.path.join(server, "Dockerfile"), encoding="utf-8") as f:
        docker = f.read()
    with open(os.path.join(root, ".dockerignore"), encoding="utf-8") as f:
        ignore = {ln.strip() for ln in f}
    for m in local:
        assert f"race/server/{m}.py" in docker, f"{m}.py is imported by app.py but not COPYed"
        assert f"!race/server/{m}.py" in ignore, f"{m}.py is not in the .dockerignore allow-list"
    assert "COPY race/server/airports/airports.json.gz /app/airports/airports.json.gz" in docker
    assert "!race/server/airports/airports.json.gz" in ignore


# =============================================================================== ROAM
def test_wire_phase_shows_old_clients_the_lobby_for_roam_and_every_dash_phase():
    wp = appmod.wire_phase
    assert wp("roam", 11) == "roam" and wp("dash_running", 11) == "dash_running"
    assert wp("roam", 10) == "lobby" and wp("roam", 0) == "lobby"
    for ph in appmod.DASH_PHASES:
        assert wp(ph, 10) == "lobby", ph
    for ph in ("countdown", "formation", "racing", "results"):
        assert wp(ph, 0) == ph == wp(ph, 11), "gate-race phases are unchanged for everyone"
    assert appmod.Room("x").phase == appmod.HOME_PHASE == "roam"


def test_a_room_is_home_in_roam_and_an_old_client_still_sees_its_lobby():
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/race/roamproj") as new, c.websocket_connect("/ws/race/roamproj") as old:
            assert _join(new, "New")["proto"] == 11
            _join(old, "Old", proto=0)
            assert _of(_drain(new), "lobby")[-1]["phase"] == "roam"
            assert _of(_drain(old), "lobby")[-1]["phase"] == "lobby"
            appmod._get_cache.clear()
            (row,) = [r for r in c.get("/rooms/live").json() if r["room"] == appmod._room_label("roamproj")]
            assert row["phase"] == "lobby" and row["state"] == "roam"


def test_chat_survives_every_phase_of_a_gate_race_and_the_way_home(monkeypatch):
    """Bug: chat did not persist through a cup. Every line now lands live in every phase, and the
    room's log (replayed to a joiner) still holds all of them after the race has gone home."""
    monkeypatch.setattr(appmod, "RESULTS_LINGER_S", 0.3)
    with TestClient(appmod.app) as c, _pilots(c, "chatphases", ["A", "B"]) as w:
        rm = appmod.rooms["chatphases"]
        sent = []
        def say(text):
            _chat(w["A"], text)
            sent.append(text)
            got = [f["text"] for f in _of(_drain(w["B"]), "chat")]
            assert got == [text], (rm.phase, got)
        say("in roam")
        _start_gate_race("chatphases", w)
        say("racing")
        _finish_all("chatphases", w)
        say("results")
        home = _home(w["B"])
        assert home["reason"] == "results_linger" and home["from_phase"] == "results"
        assert rm.phase == appmod.HOME_PHASE, "the results went home"
        _drain(w["B"])
        say("home again")
        with c.websocket_connect("/ws/race/chatphases") as late:
            late.send_json({"type": "join", "callsign": "Late", "client_proto": 11})
            assert late.receive_json()["type"] == "joined"
            log = late.receive_json()
            assert log["type"] == "chat_log"
            assert [l["text"] for l in log["lines"]] == sent
            assert all(l["from"] == "A" and l["server_ms"] > 0 for l in log["lines"])


def test_chat_frames_keep_their_old_shape_for_old_clients_and_old_clients_get_no_log():
    with TestClient(appmod.app) as c, _pilots(c, "chatshape", ["New", "Old"], proto={"New": 11, "Old": 5}) as w:
        w["New"].send_json({"type": "chat", "code": "gg"})
        assert _of(_drain(w["Old"]), "chat") == [{"type": "chat", "callsign": "New", "code": "gg"}]
        _chat(w["New"], "hello")
        assert _of(_drain(w["Old"]), "chat") == [{"type": "chat", "from": "New", "text": "hello"}]
        new = _of(_drain(w["New"]), "chat")
        assert [set(f) for f in new] == [{"type", "callsign", "code", "server_ms"},
                                         {"type", "from", "text", "server_ms"}]
        with c.websocket_connect("/ws/race/chatshape") as late:
            _join(late, "OldLate", proto=5)
            assert not _of(_drain(late), "chat_log"), "an old client is never sent the log"


def test_the_chat_log_survives_the_room_emptying_inside_the_reopen_window():
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/race/chatreopen") as ws:
            _join(ws, "Solo")
            _chat(ws, "before the blip")
            _drain(ws)
        assert _wait_until(lambda: "chatreopen" not in appmod.rooms)
        with c.websocket_connect("/ws/race/chatreopen") as ws:
            _join(ws, "Solo")
            log = _of(_drain(ws), "chat_log")
            assert log and [l["text"] for l in log[0]["lines"]] == ["before the blip"]


def test_chat_history_zero_turns_the_log_off(monkeypatch):
    monkeypatch.setattr(appmod, "CHAT_HISTORY_LINES", 0)
    with TestClient(appmod.app) as c, _pilots(c, "chatoff", ["A"]) as w:
        _chat(w["A"], "live only")
        assert _of(_drain(w["A"]), "chat")
        assert not appmod.rooms["chatoff"].chat_log


def test_results_go_home_as_soon_as_every_pilot_dismisses_them(monkeypatch):
    """Bug: results did not return to the lobby. Besides the linger, `dismiss` from everyone who
    can send it takes the room home at once, with an explicit `home` frame."""
    monkeypatch.setattr(appmod, "RESULTS_LINGER_S", 60)
    with TestClient(appmod.app) as c, _pilots(c, "dismissroom", ["A", "B"]) as w:
        rm = appmod.rooms["dismissroom"]
        w["A"].send_json({"type": "dismiss"})
        assert _of(_drain(w["A"]), "error")[-1]["detail"] == "nothing to dismiss"
        _start_gate_race("dismissroom", w)
        _finish_all("dismissroom", w)
        w["A"].send_json({"type": "dismiss"})
        _drain(w["A"])
        assert rm.phase == "results", "one of two dismissed: still up"
        w["B"].send_json({"type": "dismiss"})
        assert _home(w["A"])["reason"] == "dismissed"
        assert rm.phase == appmod.HOME_PHASE
        assert rm.linger_task is None and rm.race is None


def test_an_old_client_never_holds_the_results_open_against_dismiss(monkeypatch):
    monkeypatch.setattr(appmod, "RESULTS_LINGER_S", 60)
    with TestClient(appmod.app) as c, _pilots(c, "dismissmix", ["New", "Old"], proto={"New": 11, "Old": 4}) as w:
        rm = appmod.rooms["dismissmix"]
        _start_gate_race("dismissmix", w)
        _finish_all("dismissmix", w)
        w["New"].send_json({"type": "dismiss"})
        _home(w["New"])
        assert rm.phase == appmod.HOME_PHASE
        seen = []
        _until(w["Old"], lambda m: seen.append(m) or (m["type"] == "lobby" and m["phase"] == "lobby"))
        assert not _of(seen, "home"), "home is a proto-11 frame; the old client is taken home by `lobby`"


def test_every_way_home_sends_home_with_its_reason():
    with TestClient(appmod.app) as c, _pilots(c, "homeways", ["H"]) as w:
        rm = appmod.rooms["homeways"]
        ws = w["H"]
        ws.send_json(_course())
        ws.send_json({"type": "ready", "ready": True})
        ws.send_json({"type": "start", "lead_s": 60})
        assert _wait_until(lambda: rm.phase == "countdown")
        ws.send_json({"type": "abort"})
        frames = _drain(ws)
        types = [f["type"] for f in frames]
        assert types.index("abort") < types.index("home") < len(types) - 1 - types[::-1].index("lobby")
        assert _of(frames, "home")[-1]["reason"] == "abort" and rm.players["H"].ready, "abort keeps ready"
        ws.send_json({"type": "start", "lead_s": 60})
        assert _wait_until(lambda: rm.phase == "countdown")
        ws.send_json({"type": "back_to_lobby"})
        assert _home(ws)["reason"] == "back_to_lobby"
        assert rm.phase == appmod.HOME_PHASE and not rm.players["H"].ready
        _start_gate_race("homeways", w)
        _finish_all("homeways", w)
        ws.send_json({"type": "rematch"})
        home = _home(ws)
        assert home["reason"] == "rematch" and home["from_phase"] == "results" and home["server_ms"] > 0
        assert rm.phase == appmod.HOME_PHASE and rm.course is not None, "a rematch keeps the course"


def test_roam_presence_is_a_coalesced_frame_not_a_standings_fan_out(monkeypatch):
    monkeypatch.setattr(appmod, "ROAM_MIN_INTERVAL_S", 0.0)
    with TestClient(appmod.app) as c, _pilots(c, "presence", ["A", "B", "Old"],
                                               proto={"A": 11, "B": 11, "Old": 4}) as w:
        w["B"].send_json({"type": "pos", "lat": 45.59, "lon": -122.6, "alt_m": 9.0, "on_ground": True,
                          "gs_kt": 3.5, "vs_fpm": 0, "hdg": 119.0})
        frames = _drain(w["A"])
        assert not _of(frames, "standings"), "a ROAM ping is not a race"
        roam = _of(frames, "roam")[-1]
        b = next(p for p in roam["pilots"] if p["callsign"] == "B")
        assert b["on_ground"] is True and b["gs_kt"] == 3.5 and b["hdg"] == 119.0 and b["alt_m"] == 9.0
        assert b["age_ms"] is not None and b["age_ms"] >= 0
        assert not _of(_drain(w["Old"]), "roam"), "presence is a proto-11 frame"
        # An old client's ping still drives the old standings, exactly as before.
        w["Old"].send_json({"type": "pos", "lat": 45.0, "lon": -122.0, "gate": 0, "elapsed_ms": 0})
        assert _of(_drain(w["Old"]), "standings")


def test_pos_validates_the_new_proto_11_fields():
    for bad in ({"gs_kt": -1}, {"gs_kt": 2001}, {"alt_m": 20001}, {"vs_fpm": 40000}, {"hdg": 361},
                {"on_ground": "maybe"}):
        with pytest.raises(Exception):
            appmod.parse_message({"type": "pos", "lat": 45.0, "lon": -122.0, **bad})
    ok = appmod.parse_message({"type": "pos", "lat": 45.0, "lon": -122.0})
    assert ok.gate == 0 and ok.elapsed_ms == 0, "a ROAM ping needs no gate course"


# =============================================================================== run hooks
import asyncio
import runhooks


def test_runhooks_call_in_order_await_coroutines_and_survive_a_broken_subscriber():
    hooks = runhooks.RunHooks()
    seen = []

    def a(ev):
        seen.append(("a", ev.event))

    async def b(ev):
        seen.append(("b", ev.event))
        ev.hold_home = True

    def broken(ev):
        raise RuntimeError("subscriber bug")

    hooks.on(runhooks.LEG_RESULTS, a)
    hooks.on(runhooks.LEG_RESULTS, broken)
    off = hooks.on(runhooks.LEG_RESULTS, b)
    ev = asyncio.run(hooks.emit(runhooks.LegEvent(runhooks.LEG_RESULTS, "race", "r", 1, 0, {})))
    assert seen == [("a", "leg_results"), ("b", "leg_results")] and ev.hold_home
    off()
    off()                                    # unsubscribing twice is harmless
    seen.clear()
    ev = asyncio.run(hooks.emit(runhooks.LegEvent(runhooks.LEG_RESULTS, "race", "r", 2, 0, {})))
    assert seen == [("a", "leg_results")] and not ev.hold_home
    assert hooks.has(runhooks.LEG_RESULTS) and not hooks.has(runhooks.LEG_START)
    with pytest.raises(ValueError):
        hooks.on("leg_whatever", a)


def _subscribe_all(rm):
    got = []
    for e in runhooks.EVENTS:
        rm.hooks.on(e, lambda ev: got.append((ev.event, ev.engine, ev.leg_id, ev.payload.get("callsign"))))
    return got


def _flip_countdown_now(c, rm):
    """Run the countdown's GO flip immediately (the real task would wait out lead_s >= 5 s; it
    stands down on its own once it sees the room is no longer counting down)."""
    c.portal.call(appmod._run_countdown, rm, rm.race_id, 0)


def test_the_gate_race_fires_leg_start_each_leg_finish_then_leg_results(monkeypatch):
    monkeypatch.setattr(appmod, "RESULTS_LINGER_S", 0)
    with TestClient(appmod.app) as c, _pilots(c, "hookrace", ["A", "B", "C"]) as w:
        rm = appmod.rooms["hookrace"]
        got = _subscribe_all(rm)
        w["A"].send_json(_course())
        assert _wait_until(lambda: rm.course is not None)
        for ws in w.values():
            ws.send_json({"type": "ready", "ready": True})
        assert _wait_until(lambda: all(p.ready for p in rm.players.values()))
        w["A"].send_json({"type": "start", "lead_s": 5})
        assert _wait_until(lambda: rm.phase == "countdown")
        _flip_countdown_now(c, rm)
        assert rm.phase == "racing" and got == [("leg_start", "race", rm.race_id, None)]
        rm.race.start_at_ms = appmod.server_ms() - 30_000
        w["B"].send_json({"type": "finish", "race_id": rm.race_id, "go_time_ms": 30_000})
        assert _wait_until(lambda: len(got) == 2)
        w["C"].send_json({"type": "dnf", "race_id": rm.race_id, "gate": 1})
        assert _wait_until(lambda: len(got) == 3)
        c.portal.call(appmod._end_race, rm, rm.race)          # A never finished: a straggler
        assert [g[0] for g in got] == ["leg_start", "leg_finish", "leg_finish", "leg_finish", "leg_results"]
        assert [g[3] for g in got[1:4]] == ["B", "C", "A"]
        assert all(g[1] == "race" and g[2] == rm.race_id for g in got)


def test_hold_home_on_leg_results_hands_the_way_home_to_the_wrapper(monkeypatch):
    monkeypatch.setattr(appmod, "RESULTS_LINGER_S", 0.2)
    with TestClient(appmod.app) as c, _pilots(c, "hookhold", ["A"]) as w:
        rm = appmod.rooms["hookhold"]

        def wrapper(ev):
            ev.hold_home = True
        rm.hooks.on(runhooks.LEG_RESULTS, wrapper)
        _start_gate_race("hookhold", w)
        _finish_all("hookhold", w)
        res = _until(w["A"], lambda m: m["type"] == "results")
        assert "lobby_at_server_ms" not in res, "no linger promised: the wrapper owns it"
        _time.sleep(0.6)
        assert rm.phase == "results" and rm.linger_task is None
        c.portal.call(lambda: appmod.go_home(rm, "wrapper_next"))
        assert _home(w["A"])["reason"] == "wrapper_next"


def test_a_subscriber_that_raises_never_breaks_the_race(monkeypatch):
    monkeypatch.setattr(appmod, "RESULTS_LINGER_S", 0)
    with TestClient(appmod.app) as c, _pilots(c, "hookbroken", ["A"]) as w:
        rm = appmod.rooms["hookbroken"]
        for e in runhooks.EVENTS:
            rm.hooks.on(e, lambda ev: 1 / 0)
        _start_gate_race("hookbroken", w)
        _finish_all("hookbroken", w)
        assert _until(w["A"], lambda m: m["type"] == "results")["rows"][0]["callsign"] == "A"


# =============================================================================== dash engine (pure)
import math
import dash_engine as de

PDX = appmod.AIRPORTS.get("KPDX")
SEA = appmod.AIRPORTS.get("KSEA")
T0 = 1_000_000_000          # an arbitrary server_ms
SEA_16L = (47.4475, -122.308)   # mid-runway on KSEA 16L/34R


def _gc(frac):
    """The point `frac` of the way along the KPDX -> KSEA great circle (slerp)."""
    a, b = de._unit(PDX["lat"], PDX["lon"]), de._unit(SEA["lat"], SEA["lon"])
    om = math.acos(max(-1.0, min(1.0, de._dot(a, b))))
    k0, k1 = math.sin((1 - frac) * om) / math.sin(om), math.sin(frac * om) / math.sin(om)
    v = [k0 * a[i] + k1 * b[i] for i in range(3)]
    return math.degrees(math.asin(v[2])), math.degrees(math.atan2(v[1], v[0]))


def _ping(at, lat, lon, alt=10.0, ground=True, gs=0.0):
    return de.Ping(at, lat, lon, alt, ground, gs)


def _eng(ceiling=None, cls=None, names=("A",)):
    """Staged and readied at KPDX's reference point."""
    e = de.DashEngine(7, PDX, SEA, ceiling, cls, names[0], T0)
    for n in names:
        assert e.join(n, "F-16") is None
        e.on_ping(n, _ping(T0, PDX["lat"], PDX["lon"]))
        assert e.ready(n, True, T0) is None
    return e


def _go(e, lead=10):
    assert e.go(lead, T0) is None
    for n in e.entrants:
        e.on_ping(n, _ping(T0 + 5000, PDX["lat"], PDX["lon"]))
    e.on_go(e.go_ms)
    assert e.phase == de.RUNNING
    return e.go_ms


def _fly(e, n, t_ms, frac, alt=6000.0, ground=False, gs=420.0):
    lat, lon = _gc(frac)
    e.on_ping(n, _ping(e.go_ms + t_ms, lat, lon, alt, ground, gs))


def _land(e, n, t_ms, sink=400, bounced=False, score=850, at=SEA_16L, finish=True):
    """Airborne short final at t-1 s, touchdown at t at 130 kt, roll out to 10 kt by t+4 s, then
    send the finish at t+4.5 s. Returns the finish refusal (None = accepted)."""
    go = e.go_ms
    e.on_ping(n, _ping(go + t_ms - 1000, at[0] + 0.01, at[1], 150.0, False, 140.0))
    for i, gs in enumerate((130.0, 90.0, 50.0, 25.0, 10.0)):
        e.on_ping(n, _ping(go + t_ms + i * 1000, at[0] - i * 0.002, at[1], 130.0, True, gs))
    if not finish:
        return None
    return e.finish(n, t_ms, t_ms + 4000, sink, bounced, score, go + t_ms + 4500)


def test_along_track_progress_is_the_projection_on_the_great_circle():
    assert 200_000 < de.DashEngine(1, PDX, SEA, None, None, "A", 0).distance_m < 215_000
    p0, r0 = de.along_track(PDX, SEA, PDX["lat"], PDX["lon"])
    assert p0 == pytest.approx(0, abs=1e-6) and r0 == pytest.approx(207_906, rel=0.01)
    p1, r1 = de.along_track(PDX, SEA, SEA["lat"], SEA["lon"])
    assert p1 == pytest.approx(1, abs=1e-6) and r1 == pytest.approx(0, abs=1)
    mid = _gc(0.5)
    assert de.along_track(PDX, SEA, *mid)[0] == pytest.approx(0.5, abs=1e-6)
    # 20 km abeam of the midpoint (east): the same progress -- flying wide neither helps nor hurts.
    abeam = (mid[0], mid[1] + 20_000 / (111_195 * math.cos(math.radians(mid[0]))))
    assert de.along_track(PDX, SEA, *abeam)[0] == pytest.approx(0.5, abs=0.02)
    assert de.along_track(PDX, SEA, 44.5, -122.9)[0] == 0.0, "behind the start clamps to 0"
    assert de.along_track(PDX, SEA, 48.5, -122.0)[0] == 1.0, "past the end clamps to 1"


def test_split_crossings_interpolate_and_never_repeat():
    sc = de.split_crossings
    assert sc((1000, 0.20), (2000, 0.30), set()) == [(1, 1500)]
    assert sc((1000, 0.20), (3000, 0.60), set()) == [(1, 1250), (2, 2500)]
    assert sc((1000, 0.20), (3000, 0.60), {1}) == [(2, 2500)]
    assert sc(None, (500, 0.3), set()) == [(1, 500)], "a first ping already past a line takes its time"
    assert sc((1000, 0.30), (2000, 0.20), set()) == []


def test_splits_on_a_synthetic_kpdx_ksea_stream_with_gaps_to_the_leader():
    """Two pilots at 1 Hz: A covers the route in 450 s, B in 500 s. Splits are interpolated to the
    exact quarter, and each carries the gap to whoever crossed that line first."""
    e = _eng(names=("A", "B"))
    _go(e)
    for t in range(0, 501):
        if t <= 450:
            _fly(e, "A", t * 1000, t / 450)
        _fly(e, "B", t * 1000, t / 500)
    splits = [x for x in e.take_events() if x["kind"] == "split"]
    a = {s["split"]: s for s in splits if s["callsign"] == "A"}
    b = {s["split"]: s for s in splits if s["callsign"] == "B"}
    assert [a[i]["t_ms"] for i in (1, 2, 3)] == [112_500, 225_000, 337_500]
    assert [b[i]["t_ms"] for i in (1, 2, 3)] == [125_000, 250_000, 375_000]
    assert [b[i]["gap_ms"] for i in (1, 2, 3)] == [12_500, 25_000, 37_500]
    assert all(a[i]["gap_ms"] == 0 and a[i]["pos"] == 1 and b[i]["pos"] == 2 for i in (1, 2, 3))
    assert [a[i]["pct"] for i in (1, 2, 3)] == [25, 50, 75]
    st = e.standings(e.go_ms + 300_000)
    assert [r["callsign"] for r in st["rows"]] == ["A", "B"] and st["rows"][0]["splits"] == 3


def test_ceiling_penalty_has_a_3s_grace_per_excursion_then_1s_per_whole_second():
    ceiling_m = 10000 * de.FT_M
    e = _eng(ceiling=10000, names=("A", "B", "C"))
    _go(e)
    def excursion(n, start_ms, length_ms):
        for t in range(start_ms, start_ms + length_ms + 1, 100):
            _fly(e, n, t, 0.3, alt=ceiling_m + 50)
        _fly(e, n, start_ms + length_ms + 500, 0.3, alt=ceiling_m - 50)
    excursion("A", 10_000, 2_500)
    excursion("B", 10_000, 6_400)
    excursion("C", 10_000, 5_500)
    excursion("C", 40_000, 5_500)
    assert e.entrants["A"].ceiling_ms == 0, "inside the grace"
    assert e.entrants["B"].ceiling_ms == 3000, "6.4 s above = 3.4 s past the grace = 3 whole seconds"
    assert e.entrants["C"].over_ms == 5000 and e.entrants["C"].ceiling_ms == 5000, "excursions add up"
    pens = [x for x in e.take_events() if x["kind"] == "penalty" and x["callsign"] == "B"]
    assert [p["ms"] for p in pens] == [1000, 2000, 3000]
    nc = _eng(ceiling=None)
    _go(nc)
    _fly(nc, "A", 1000, 0.1, alt=15000)
    _fly(nc, "A", 9000, 0.1, alt=15000)
    assert nc.entrants["A"].ceiling_ms == 0, "no ceiling, no penalty"


def test_jump_start_between_countdown_and_go_costs_15s():
    e = _eng(names=("Clean", "Air", "Fast", "LateRoll"))
    assert e.go(10, T0) is None and e.phase == de.COUNTDOWN
    for n in e.entrants:
        e.on_ping(n, _ping(T0 + 2000, PDX["lat"], PDX["lon"]))
    e.on_ping("Air", _ping(T0 + 4000, PDX["lat"], PDX["lon"], 30, False, 120))
    e.on_ping("Fast", _ping(T0 + 4000, PDX["lat"], PDX["lon"], 10, True, 45))
    for n in ("Clean", "Air", "Fast"):              # all back on the line, stopped, before GO
        e.on_ping(n, _ping(T0 + 9000, PDX["lat"], PDX["lon"]))
    e.on_ping("LateRoll", _ping(T0 + 9500, PDX["lat"], PDX["lon"], 10, True, 31))
    e.on_go(e.go_ms)
    assert {n: x.jump for n, x in e.entrants.items()} == {"Clean": False, "Air": True, "Fast": True,
                                                         "LateRoll": True}
    assert e.entrants["Air"].jump_ms == de.JUMP_START_PENALTY_MS == 15000
    assert all(x.status is None for x in e.entrants.values()), "a jump is a penalty, not a scratch"


def test_ready_is_gated_on_the_latest_ping_and_rechecked_at_go():
    e = de.DashEngine(1, PDX, SEA, None, None, "A", T0)
    e.join("A")
    assert e.ready("A", True, T0) == "not ready: no position report yet"
    def ping_then_ready(p, now=T0):
        e.on_ping("A", p)
        return e.ready("A", True, now)
    assert ping_then_ready(_ping(T0, PDX["lat"], PDX["lon"], 300, False, 150)) == "not ready: not on the ground"
    assert "moving (35.0 kt" in ping_then_ready(_ping(T0, PDX["lat"], PDX["lon"], gs=35.0))
    far = (PDX["lat"] + 0.04, PDX["lon"])                    # ~4.4 km north
    assert "km from KPDX (max 3 km)" in ping_then_ready(_ping(T0, *far))
    assert ping_then_ready(_ping(T0, PDX["lat"], PDX["lon"]), now=T0 + 6000) == \
        "not ready: no position report for 6 s"
    assert ping_then_ready(_ping(T0, PDX["lat"], PDX["lon"])) is None and e.entrants["A"].ready
    e.on_ping("A", _ping(T0 + 1000, PDX["lat"], PDX["lon"], gs=40.0))
    assert not e.entrants["A"].ready, "ready means the latest ping says so"
    # Re-check at GO: one pilot drifted 4 km off during the countdown, one went silent.
    e = _eng(names=("Good", "Gone", "Quiet"))
    assert e.go(10, T0) is None
    e.on_ping("Good", _ping(T0 + 9000, PDX["lat"], PDX["lon"]))
    e.on_ping("Gone", _ping(T0 + 9000, *far))
    e.on_go(e.go_ms)
    st = {n: (x.status, x.reason) for n, x in e.entrants.items()}
    assert st["Good"] == (None, None)
    assert st["Gone"][0] == "dns" and "km from KPDX at GO" in st["Gone"][1]
    assert st["Quiet"] == ("dns", "no position report at GO")
    assert [x["callsign"] for x in e.take_events() if x["kind"] == "scratched"] == ["Gone", "Quiet"]


def test_nobody_on_the_line_at_go_cancels_the_dash():
    e = _eng()
    e.go(10, T0)
    e.on_go(e.go_ms)                    # A's last ping is 10 s old at GO
    assert e.phase == de.CANCELLED
    assert any(x["kind"] == "cancelled" for x in e.take_events())


def test_a_good_landing_is_scored_touchdown_plus_penalties():
    e = _eng(ceiling=None, names=("A", "B"))
    _go(e)
    for t in range(0, 440):
        _fly(e, "A", t * 1000, min(0.97, t / 440))
        _fly(e, "B", t * 1000, min(0.97, t / 440))
    assert _land(e, "A", 440_000, sink=400) is None
    a = e.entrants["A"]
    assert a.status == "finished" and a.total_ms == 440_000 and a.landing_ms == 0
    e.entrants["B"].jump = True
    assert _land(e, "B", 441_000, sink=750, bounced=False) is None
    b = e.entrants["B"]
    assert b.landing_ms == 3000 and b.total_ms == 441_000 + 15_000 + 3_000
    assert e.phase == de.RESULTS, "everyone has a result"
    rows = e.result_rows()
    assert [(r["pos"], r["callsign"], r["gap_ms"]) for r in rows] == [(1, "A", 0), (2, "B", 19_000)]
    assert rows[1]["penalties"] == {"jump_ms": 15000, "ceiling_ms": 0, "landing_ms": 3000}
    assert rows[0]["landing"] == {"sink_fpm": 400.0, "bounced": False, "landing_score": 850}
    assert rows[0]["splits"][0] is not None
    kinds = [x["kind"] for x in e.take_events()]
    assert kinds.index("leg_start") < kinds.index("leg_finish") < kinds.index("results")


def test_a_touch_and_go_is_not_a_finish():
    e = _eng()
    go = _go(e)
    for t in range(0, 430):
        _fly(e, "A", t * 1000, min(0.97, t / 430))
    # Touchdown at 120 kt on 16L...
    e.on_ping("A", _ping(go + 430_000, *SEA_16L, 130, True, 120))
    e.on_ping("A", _ping(go + 430_500, *SEA_16L, 130, True, 115))
    assert "still moving (120 kt" in e.finish("A", 430_000, 431_000, 300, False, 900, go + 430_600)
    # ...and straight back into the air.
    e.on_ping("A", _ping(go + 431_000, *SEA_16L, 140, False, 125))
    e.on_ping("A", _ping(go + 432_000, SEA_16L[0] - 0.01, SEA_16L[1], 200, False, 130))
    assert e.finish("A", 430_000, 432_000, 300, False, 900, go + 432_500) == "not on the ground"
    assert e.entrants["A"].status is None


def test_a_landing_outside_the_destination_boundary_is_refused():
    e = _eng()
    _go(e)
    for t in range(0, 400):
        _fly(e, "A", t * 1000, t / 440)
    kbfi = (47.53, -122.30)                      # Boeing Field, ~9 km north of KSEA's runways
    why = _land(e, "A", 420_000, at=kbfi)
    assert why.startswith("not at KSEA (") and "km outside" in why
    assert e.entrants["A"].status is None


def test_finish_time_must_sit_between_the_last_airborne_and_first_ground_ping():
    e = _eng()
    go = _go(e)
    for t in range(0, 440):
        _fly(e, "A", t * 1000, min(0.97, t / 440))
    _land(e, "A", 440_000, finish=False)
    now = go + 444_500
    # The relay last saw A airborne at 439 s and first on the ground in KSEA at 440 s.
    assert e.finish("A", 430_000, 444_000, 300, False, 900, now) == "touchdown time does not match the relay's clock"
    assert e.finish("A", 444_000, 444_000, 300, False, 900, now) == "touchdown time does not match the relay's clock"
    assert e.finish("A", 441_000, 440_000, 300, False, 900, now) == "stopped before touching down"
    assert e.finish("A", 440_500, 444_000, 300, False, 900, now) is None


def test_finish_needs_recent_pings_and_a_flight():
    e = _eng()
    go = _go(e)
    e.on_ping("A", _ping(go + 1000, *SEA_16L))
    assert e.finish("A", 1000, 1000, 0, False, 0, go + 1500) == "not enough recent position reports"
    e.on_ping("A", _ping(go + 2000, *SEA_16L))
    assert e.finish("A", 1000, 2000, 0, False, 0, go + 2500) == "never seen airborne", \
        "a 'flight' the relay never saw leave the ground is not one"


def test_landing_penalty_table_boundaries():
    lp = de.landing_penalty
    assert [lp(x, False) for x in (0, 599.9, 600, 899.9, 900, 1200, 1200.5, 3000)] == \
        [0, 0, 3000, 3000, 10000, 10000, 20000, 20000]
    assert lp(100, True) == 20000, "a bounce is the hard landing"
    assert lp(-750, False) == 3000, "sign does not matter"


def test_dnf_explicit_crash_and_30s_without_pings():
    e = _eng(names=("Retire", "Crash", "Quiet", "Flying"))
    go = _go(e)
    assert e.dnf("Retire", "retired", go + 1000) is None
    assert e.dnf("Crash", "crash", go + 2000) is None
    assert e.dnf("Crash", "crash", go + 2000) == "already finished or out"
    assert e.dnf("Flying", "made-up", go + 2000) is None and e.entrants["Flying"].reason == "retired"
    e2 = _eng(names=("Quiet", "Talker"))
    go = _go(e2)
    for t in range(0, 40_001, 1000):
        _fly(e2, "Talker", t, 0.1)
        e2.tick(go + t)
    assert e2.entrants["Quiet"].status == "dnf" and e2.entrants["Quiet"].reason == "timeout"
    assert e2.entrants["Talker"].status is None
    quiet_out = [x for x in e2.take_events() if x["kind"] == "leg_finish"]
    assert quiet_out and quiet_out[0]["callsign"] == "Quiet"


def test_the_dash_ends_ten_minutes_after_the_first_finish():
    e = _eng(names=("A", "B"))
    go = _go(e)
    for t in range(0, 440):
        _fly(e, "A", t * 1000, min(0.97, t / 440))
    assert _land(e, "A", 440_000) is None
    first = e.first_finish_ms
    t = 445_000
    while go + t < first + de.FINISH_WINDOW_AFTER_FIRST_MS - 1000:
        _fly(e, "B", t, 0.6)
        e.tick(go + t)
        t += 5000
    assert e.phase == de.RUNNING, "B is still flying inside the window"
    _fly(e, "B", t, 0.6)
    e.tick(first + de.FINISH_WINDOW_AFTER_FIRST_MS)
    assert e.phase == de.RESULTS and e.entrants["B"].status == "dnf" and e.entrants["B"].reason == "cap"
    assert not e.home_due(e.results_at_ms + de.RESULTS_LINGER_MS - 1)
    assert e.home_due(e.results_at_ms + de.RESULTS_LINGER_MS)
    assert e.dismiss("A") is None and not e.all_dismissed({"A", "B"})
    assert e.all_dismissed({"A"}), "an entrant who left cannot hold the results"


def test_illegal_transitions_are_refused_by_name():
    e = _eng()
    assert e.finish("A", 1, 1, 0, False, 0, T0) == "the dash is not running"
    assert e.go(15, T0).startswith("lead must be one of 10, 20, 30, 45")
    e2 = de.DashEngine(1, PDX, SEA, None, None, "A", T0)
    assert e2.go(10, T0) == "nobody has joined"
    e2.join("A")
    assert e2.go(10, T0) == "not everyone is ready: A"
    assert e2.join("A") == "already in this dash"
    _go(e)
    assert e.join("Late") == "the dash has already started"
    assert e.ready("A", True, T0) == "ready only before the countdown"
    assert e.go(10, T0) == "the dash has already started"
    assert e.cancel() == "only before GO"
    assert e.leave("A", e.go_ms + 1000) is None and e.entrants["A"].reason == "left"
    assert e.phase == de.RESULTS
    # Leaving before GO just leaves; the last one out of a countdown cancels it.
    e3 = _eng(names=("A", "B"))
    assert e3.leave("B", T0) is None and set(e3.entrants) == {"A"}
    e3.go(10, T0)
    assert e3.leave("A", T0 + 1000) is None and e3.phase == de.CANCELLED


def test_route_key_and_create_validation():
    assert de.route_key("KPDX", "KSEA", None, None) == "KPDX>KSEA|none"
    assert de.route_key("KPDX", "KSEA", 10000, "jets") == "KPDX>KSEA|10000|jets"
    db = appmod.AIRPORTS
    assert de.validate_create(db, "KPDX", "ZZZZ", None, None)[0] == "unknown airport 'ZZZZ'"
    assert de.validate_create(db, "kpdx", "PDX", None, None)[0] == "departure and destination are the same airport"
    assert de.validate_create(db, "KPDX", "KSEA", 500, None)[0].startswith("ceiling must be")
    assert de.validate_create(db, "KPDX", "KSEA", None, "Big Jets!")[0].startswith("class must be")
    err, (dep, dst, ceil, cls) = de.validate_create(db, "pdx", "ksea", 18000, " Jets ")
    assert err is None and (dep["icao"], dst["icao"], ceil, cls) == ("KPDX", "KSEA", 18000, "jets")
    assert de.validate_create(None, "KPDX", "KSEA", None, None)[0].startswith("dash unavailable")


def test_the_card_names_why_a_pilot_is_not_ready():
    e = de.DashEngine(3, PDX, SEA, 10000, None, "A", T0)
    e.join("A", "F-16")
    e.on_ping("A", _ping(T0, PDX["lat"], PDX["lon"], 30, False, 140))
    card = e.card(T0)
    assert card["route_key"] == "KPDX>KSEA|10000" and card["from"]["icao"] == "KPDX"
    assert card["to"]["runways"] and 200_000 < card["distance_m"] < 215_000
    assert card["entrants"] == [{"callsign": "A", "model": "F-16", "ready": False, "status": None,
                                 "reason": None, "jump_start": False, "ready_block": "not on the ground"}]
