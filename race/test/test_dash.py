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
