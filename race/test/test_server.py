"""Run: cd race/server && RACE_DB=/tmp/race-test.db RACE_MIN_INTERVAL_S=0 python -m pytest ../test/test_server.py -q"""
import os, sys, time as _time
import datetime as _dt
import hashlib
import json
import sqlite3
os.environ.setdefault("RACE_DB", "/tmp/race-test.db")
os.environ.setdefault("RACE_MIN_INTERVAL_S", "0")
os.environ.setdefault("RACE_GET_MIN_INTERVAL_S", "0")
os.environ.setdefault("RACE_COURSES_DIR", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "courses"))
if os.path.exists(os.environ["RACE_DB"]): os.remove(os.environ["RACE_DB"])
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "server"))
import pytest
from fastapi.testclient import TestClient
import app as appmod

H = "0a1b2c3d"
def run(**kw):
    base = dict(course_id="steve-sprint", course_hash=H, course_name="Steve Sprint", callsign="Eric",
                time_ms=18519, splits=[8519, 18519], gates=3, length_m=4000, client_version="0.1.0")
    base.update(kw); return base

def test_version_endpoint():
    with TestClient(appmod.app) as c:
        v = c.get("/version").json()
        assert v == {"sha": appmod.GIT_SHA, "version": appmod.SERVER_VERSION, "proto": appmod.PROTO,
                     "courses": len(appmod.COURSES), "started_at": appmod.STARTED_AT}
        assert appmod.GIT_SHA == "unknown", "no RACE_GIT_SHA set for this test run -- the build-arg default"
        assert appmod.STARTED_AT, "set once, in lifespan(), by the TestClient's startup"

def test_flow():
    with TestClient(appmod.app) as c:
        assert c.get("/health").json() == {"ok": True, "courses": len(appmod.COURSES)}
        assert len(appmod.COURSES) > 0
        r = c.post("/runs", json=run()); assert r.status_code == 200, r.text
        assert r.json()["rank"] == 1 and r.json()["improved"]
        r = c.post("/runs", json=run(callsign="Maggie", time_ms=17000, splits=[8000, 17000], model="bratwurst"))
        assert r.json()["rank"] == 1
        r = c.post("/runs", json=run(time_ms=20000, splits=[9000, 20000]))  # slower retry
        assert r.json() == {**r.json(), "rank": 2, "personal_best": 18519, "improved": False}
        board = c.get("/leaderboard", params={"course_hash": H}).json()
        assert [(b["callsign"], b["time_ms"]) for b in board] == [("Maggie", 17000), ("Eric", 18519)]
        assert board[1]["attempts"] == 2 and board[0]["model"] == "bratwurst"
        assert c.get("/courses").json()[0]["racers"] == 2

def test_rejects():
    with TestClient(appmod.app) as c:
        bad = [run(splits=[18519]), run(splits=[9000, 8000], time_ms=8000), run(splits=[8519, 18000]),
               run(time_ms=100, splits=[50, 100]), run(course_hash="XYZ"), run(callsign="   "),
               run(course_id="Bad Id")]
        for b in bad:
            assert c.post("/runs", json=b).status_code == 422, b
        assert c.get("/leaderboard", params={"course_hash": "nope"}).status_code == 422

def test_courses_endpoint_joins_cup_difficulty_length_and_gates_from_the_catalog():
    with TestClient(appmod.app) as c:
        c.post("/runs", json=run(course_id="gorge-run", course_hash="deadbeef", callsign="Joiner"))
        row = next(r for r in c.get("/courses").json() if r["course_id"] == "gorge-run")
        assert row["cup"] == "Cascade Cup" and row["difficulty"] == "easy"
        assert row["length_km"] > 0
        assert len(row["gate_coords"]) == 6


def test_courses_catalog_lists_every_course_raced_or_not():
    with TestClient(appmod.app) as c:
        catalog = c.get("/courses/catalog").json()
        assert len(catalog) == len(appmod.COURSES)
        other = next(x for x in catalog if x["course_id"] == "starter-sprint-seatac")
        assert other["cup"] is None, "no cup in courses/index.json -- groups under 'Other' client-side"
        gorge = next(x for x in catalog if x["course_id"] == "gorge-run")
        assert gorge["cup"] == "Cascade Cup" and gorge["difficulty"] == "easy" and gorge["length_km"] > 0
        assert len(gorge["gate_coords"]) == gorge["gates"]


def test_cors_and_ratelimit():
    appmod.MIN_INTERVAL_S = 5
    appmod._last_post.clear()
    with TestClient(appmod.app) as c:
        pre = c.options("/runs", headers={"Origin": "https://www.geo-fs.com", "Access-Control-Request-Method": "POST",
                                          "Access-Control-Request-Headers": "content-type"})
        assert pre.headers.get("access-control-allow-origin") == "https://www.geo-fs.com"
        evil = c.options("/runs", headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "POST"})
        assert "access-control-allow-origin" not in evil.headers
        assert c.post("/runs", json=run(callsign="Tom")).status_code == 200
        assert c.post("/runs", json=run(callsign="Tom")).status_code == 429
    appmod.MIN_INTERVAL_S = 0


# ---------------------------------------------------------- landing mode scoring

RW = appmod.RUNWAYS["sea-tac-16c"]
RW_ZONE_MID = (RW["zone"]["min_m"] + RW["zone"]["max_m"]) / 2

def touchdown_at(runway, along_m, cross_m, **kw):
    """race/touchdown.js's `touchdown` event at a known (along_m, cross_m) relative to `runway`,
    built with the same offset_point() the powerups relay uses — its exact inverse of
    runway_offsets_m()."""
    lat, lon = appmod.offset_point(runway["thr_lat"], runway["thr_lon"], runway["heading_deg"], along_m)
    lat, lon = appmod.offset_point(lat, lon, runway["heading_deg"] + 90.0, cross_m)
    base = dict(type="touchdown", t_ms=1000, vs_at_contact=-0.3, ias=60.0, bank=0.0, pitch=3.0,
                lat=lat, lon=lon, heading_deg=runway["heading_deg"],
                centerline_offset_m=cross_m, distance_from_threshold_m=along_m)
    base.update(kw)
    return base

def score(touchdown, runway=RW, bounce_count=0, total_rollout_m=50.0):
    return appmod.score_touchdown(touchdown, runway, bounce_count, total_rollout_m)

def landing_attempt(**kw):
    base = dict(runway_id="sea-tac-16c", callsign="Eric", bounce_count=0, total_rollout_m=50.0,
                touchdown=touchdown_at(RW, RW_ZONE_MID, 0.0))
    base.update(kw)
    return base

def test_landing_runway_offsets_round_trips_offset_point():
    lat, lon = appmod.offset_point(RW["thr_lat"], RW["thr_lon"], RW["heading_deg"], 500.0)
    lat, lon = appmod.offset_point(lat, lon, RW["heading_deg"] + 90.0, 30.0)
    along, cross = appmod.runway_offsets_m(RW, lat, lon)
    assert along == pytest.approx(500.0, abs=0.5)
    assert cross == pytest.approx(30.0, abs=0.5)

def test_landing_greaser_outscores_firm_landing():
    greaser = score(touchdown_at(RW, RW_ZONE_MID, 0.0, vs_at_contact=-0.2))
    firm = score(touchdown_at(RW, RW_ZONE_MID, 0.0, vs_at_contact=-3.5))
    assert greaser["score"] > firm["score"]
    assert greaser["breakdown"]["vs_penalty"] < firm["breakdown"]["vs_penalty"]

def test_landing_centerline_penalty_is_symmetric():
    left = score(touchdown_at(RW, RW_ZONE_MID, -25.0))
    right = score(touchdown_at(RW, RW_ZONE_MID, 25.0))
    assert left["score"] == right["score"]
    assert left["breakdown"]["centerline_penalty"] == pytest.approx(right["breakdown"]["centerline_penalty"], abs=0.1)
    assert left["breakdown"]["centerline_penalty"] > 0

def test_landing_distance_from_threshold_penalizes_both_short_and_long():
    on_zone = score(touchdown_at(RW, RW_ZONE_MID, 0.0))
    short = score(touchdown_at(RW, RW["zone"]["min_m"] - 100.0, 0.0))
    long_ = score(touchdown_at(RW, RW["zone"]["max_m"] + 100.0, 0.0))
    assert on_zone["score"] > short["score"]
    assert on_zone["score"] > long_["score"]
    assert short["breakdown"]["zone_penalty"] > 0
    assert long_["breakdown"]["zone_penalty"] > 0

def test_landing_bounces_strictly_reduce_score():
    scores = [score(touchdown_at(RW, RW_ZONE_MID, 0.0), bounce_count=n)["score"] for n in range(4)]
    assert scores == sorted(scores, reverse=True)
    assert len(set(scores)) == len(scores), f"bounces must strictly reduce score, got {scores}"

def test_landing_rollout_matters_more_on_a_short_runway():
    short_rw = appmod.RUNWAYS["friday-harbor-16"]
    mid = (short_rw["zone"]["min_m"] + short_rw["zone"]["max_m"]) / 2
    short_penalty = score(touchdown_at(short_rw, mid, 0.0), short_rw,
                          total_rollout_m=700.0)["breakdown"]["rollout_penalty"]
    long_penalty = score(touchdown_at(RW, RW_ZONE_MID, 0.0),
                         total_rollout_m=700.0)["breakdown"]["rollout_penalty"]
    assert short_penalty > long_penalty
    assert short_penalty > 0

def test_landing_score_is_clamped_to_0_1000():
    catastrophic = score(touchdown_at(RW, RW["zone"]["max_m"] + 2000.0, 300.0, vs_at_contact=-15.0, bank=90.0),
                         bounce_count=10, total_rollout_m=5000.0)
    assert appmod.LANDING_MIN_SCORE <= catastrophic["score"] <= appmod.LANDING_MAX_SCORE

def test_landing_endpoint_ignores_client_supplied_score_and_recomputes():
    with TestClient(appmod.app) as c:
        expected = score(touchdown_at(RW, RW_ZONE_MID, 0.0))["score"]
        payload = landing_attempt(callsign="ScoreLiar")
        payload["score"] = 999999
        payload["touchdown"] = dict(payload["touchdown"], score=999999)
        r = c.post("/landings", json=payload)
        assert r.status_code == 200, r.text
        assert r.json()["score"] == expected
        assert r.json()["score"] != 999999
        assert r.json()["breakdown"]["vs_penalty"] >= 0
        with appmod.connect() as conn:
            stored = conn.execute("SELECT metric_value FROM mode_runs WHERE mode_id = 'landing' AND callsign = ?",
                                  ("ScoreLiar",)).fetchall()
        assert [r[0] for r in stored] == [expected], "the stored metric is the server's score"

def test_landing_ignores_the_clients_own_runway_offsets():
    # 40 m right of centerline by position, but the event claims dead-center and on the zone.
    td = touchdown_at(RW, RW_ZONE_MID, 40.0, centerline_offset_m=0.0, distance_from_threshold_m=RW_ZONE_MID)
    honest = touchdown_at(RW, RW_ZONE_MID, 0.0)
    with TestClient(appmod.app) as c:
        r = c.post("/landings", json=landing_attempt(callsign="OffsetLiar", touchdown=td))
        assert r.status_code == 200, r.text
        assert r.json()["breakdown"]["cross_m"] == pytest.approx(40.0, abs=0.5)
        assert r.json()["score"] < score(honest)["score"]

def test_landing_accepts_exactly_the_touchdown_event_touchdown_js_emits():
    """TouchdownEventIn must be race/touchdown.js's `touchdown` event, key for key: that module
    owns the shape. Read the keys straight out of its events.push({ type: 'touchdown', ... })."""
    import re
    src = open(os.path.join(os.path.dirname(__file__), "..", "touchdown.js"), encoding="utf-8").read()
    block = re.search(r"events\.push\(\{\s*type: 'touchdown',(.*?)\}\);", src, re.S).group(1)
    block = re.sub(r"//[^\n]*", "", block)
    js_keys = {"type"} | set(re.findall(r"(\w+):", block))
    assert js_keys == set(appmod.TouchdownEventIn.model_fields)

def test_landing_unknown_runway_404s():
    with TestClient(appmod.app) as c:
        r = c.post("/landings", json=landing_attempt(runway_id="does-not-exist"))
        assert r.status_code == 404
        r = c.get("/landing-leaderboard", params={"runway_id": "does-not-exist"})
        assert r.status_code == 404

def test_runways_lists_every_loaded_runway_with_its_geometry():
    with TestClient(appmod.app) as c:
        r = c.get("/runways")
        assert r.status_code == 200
        rows = r.json()
        assert [x["id"] for x in rows] == sorted(appmod.RUNWAYS)
        sea = next(x for x in rows if x["id"] == "sea-tac-16c")
        assert sea == {"id": "sea-tac-16c", "name": "Sea-Tac 16C (wide, forgiving)", "thr_lat": 47.4318,
                       "thr_lon": -122.3082, "thr_alt_m": 130.0, "heading_deg": 162.0, "length_m": 3627.0,
                       "width_m": 45.0}
        # Only the public geometry — never the scoring zone or anything a later field adds.
        assert all(set(x) == set(appmod.RUNWAY_PUBLIC_FIELDS) for x in rows)

def test_landing_leaderboard_ranks_the_better_score_first():
    with TestClient(appmod.app) as c:
        rw = appmod.RUNWAYS["sisters-eagle-air-34"]
        mid = (rw["zone"]["min_m"] + rw["zone"]["max_m"]) / 2
        smooth = landing_attempt(runway_id=rw["id"], callsign="Eric", touchdown=touchdown_at(rw, mid, 0.0))
        firm = landing_attempt(runway_id=rw["id"], callsign="Maggie",
                               touchdown=touchdown_at(rw, mid, 0.0, vs_at_contact=-3.5))
        assert c.post("/landings", json=smooth).status_code == 200
        r = c.post("/landings", json=firm)
        assert r.status_code == 200, r.text
        assert r.json()["rank"] == 2 and r.json()["mode"] == "landing"
        board = c.get("/landing-leaderboard", params={"runway_id": rw["id"]}).json()
        assert board["course_hash"] == appmod.runway_hash(rw)
        assert [b["callsign"] for b in board["rows"]] == ["Eric", "Maggie"]
        assert board["rows"][0]["metric_value"] > board["rows"][1]["metric_value"]
        # The same board through the generic proto-6 endpoint.
        generic = c.get("/modes/landing/leaderboard", params={"course_hash": board["course_hash"]}).json()
        assert generic["rows"] == board["rows"]

def test_landing_rejects_malformed_touchdown():
    with TestClient(appmod.app) as c:
        bad = [
            landing_attempt(callsign="   "),
            landing_attempt(bounce_count=-1),
            landing_attempt(touchdown={**touchdown_at(RW, RW_ZONE_MID, 0.0), "lat": 999}),
            landing_attempt(touchdown={**touchdown_at(RW, RW_ZONE_MID, 0.0), "type": "bounce"}),
            landing_attempt(touchdown={k: v for k, v in touchdown_at(RW, RW_ZONE_MID, 0.0).items()
                                       if k != "vs_at_contact"}),
            {k: v for k, v in landing_attempt().items() if k != "total_rollout_m"},
        ]
        for b in bad:
            assert c.post("/landings", json=b).status_code == 422, b

def test_runway_hash_is_8_hex_and_changes_with_version():
    h = appmod.runway_hash(RW)
    assert len(h) == 8 and int(h, 16) >= 0
    assert appmod.runway_hash(dict(RW, version=RW["version"] + 1)) != h
    assert len({appmod.runway_hash(r) for r in appmod.RUNWAYS.values()}) == len(appmod.RUNWAYS)

RUNWAYS_DIR = os.path.join(os.path.dirname(__file__), "..", "runways")


def test_runways_json_files_match_embedded_registry():
    """The server now scores against race/runways/*.json (load_runways); EMBEDDED_RUNWAYS is only
    the fallback for a missing directory. Every file must load, and the embedded three must stay
    byte-for-byte the same as their files so a fallback never changes a score or a board."""
    with open(os.path.join(RUNWAYS_DIR, "index.json")) as f:
        index = json.load(f)
    assert {e["id"] for e in index} == set(appmod.RUNWAYS.keys())
    assert set(appmod.EMBEDDED_RUNWAYS) <= set(appmod.RUNWAYS)
    for entry in index:
        with open(os.path.join(RUNWAYS_DIR, entry["file"]), encoding="utf-8") as f:
            data = json.load(f)
        assert data == appmod.RUNWAYS[entry["id"]], entry["id"]
        assert entry["name"] == data["name"]
        assert entry["file"] == entry["id"] + ".json"
        # touchdown.js's runway shape is a subset, so the same file feeds replay_landing.mjs.
        assert {"thr_lat", "thr_lon", "heading_deg", "length_m", "width_m"} <= set(data)
        assert appmod.validate_runway(data) is data
    for rid, embedded in appmod.EMBEDDED_RUNWAYS.items():
        assert appmod.RUNWAYS[rid] == embedded, rid


# Board keys existing players' landing scores live under. Moving runways from the embedded dict
# to files must not change them (runway_hash is id+version only).
LAUNCH_RUNWAY_HASHES = {rid: appmod.runway_hash(rw) for rid, rw in appmod.EMBEDDED_RUNWAYS.items()}


def test_runway_hashes_are_stable_and_unique():
    for rid, h in LAUNCH_RUNWAY_HASHES.items():
        assert appmod.runway_hash(appmod.RUNWAYS[rid]) == h
        assert h == hashlib.sha256(f"runway:{rid}:1".encode()).hexdigest()[:8]
    hashes = [appmod.runway_hash(r) for r in appmod.RUNWAYS.values()]
    assert len(set(hashes)) == len(hashes)
    for r in appmod.RUNWAYS.values():
        assert appmod.runway_hash(r) == appmod.runway_hash(json.loads(json.dumps(r)))


def _write_runways(tmp_path, runways, index=None):
    for r in runways:
        (tmp_path / (r["id"] + ".json")).write_text(json.dumps(r))
    idx = index if index is not None else [{"id": r["id"], "name": r["name"], "file": r["id"] + ".json"} for r in runways]
    (tmp_path / "index.json").write_text(json.dumps(idx))


def test_load_runways_reads_the_directory(tmp_path):
    extra = dict(appmod.EMBEDDED_RUNWAYS["sea-tac-16c"], id="test-rwy", name="Test")
    _write_runways(tmp_path, [extra])
    got = appmod.load_runways(str(tmp_path))
    assert set(got) == {"test-rwy"}, "a present directory replaces the embedded set, not merges"


def test_load_runways_falls_back_to_embedded_when_missing_or_empty(tmp_path):
    got = appmod.load_runways(str(tmp_path / "nope"))
    assert got == appmod.EMBEDDED_RUNWAYS and got is not appmod.EMBEDDED_RUNWAYS
    (tmp_path / "index.json").write_text("[]")
    assert appmod.load_runways(str(tmp_path)) == appmod.EMBEDDED_RUNWAYS
    (tmp_path / "index.json").write_text("{not json")
    assert appmod.load_runways(str(tmp_path)) == appmod.EMBEDDED_RUNWAYS


def test_load_runways_skips_broken_entries(tmp_path):
    good = dict(appmod.EMBEDDED_RUNWAYS["friday-harbor-16"])
    bad_zone = dict(good, id="bad-zone", zone={"min_m": 500, "max_m": 100})
    bad_lat = dict(good, id="bad-lat", thr_lat=123.0)
    wrong_id = dict(good, id="other")
    _write_runways(tmp_path, [good, bad_zone, bad_lat])
    (tmp_path / "mismatch.json").write_text(json.dumps(wrong_id))
    idx = json.loads((tmp_path / "index.json").read_text())
    idx += [{"id": "mismatch", "name": "x", "file": "mismatch.json"}, {"id": "gone", "name": "x", "file": "gone.json"}]
    (tmp_path / "index.json").write_text(json.dumps(idx))
    assert set(appmod.load_runways(str(tmp_path))) == {"friday-harbor-16"}


def test_validate_runway_rejects_bad_shapes():
    base = appmod.EMBEDDED_RUNWAYS["sea-tac-16c"]
    for bad in ({**base, "id": "Bad Id"}, {**base, "version": 0}, {**base, "version": True},
                {**base, "heading_deg": 400}, {**base, "length_m": "long"}, {**base, "zone": None},
                {**base, "zone": {"min_m": 0, "max_m": 99999}}, {**base, "name": ""}, [], None):
        with pytest.raises(ValueError):
            appmod.validate_runway(bad)


def test_runways_dir_env_override(monkeypatch, tmp_path):
    monkeypatch.setenv("RACE_RUNWAYS_DIR", str(tmp_path))
    assert appmod._default_runways_dir() == str(tmp_path)
    monkeypatch.delenv("RACE_RUNWAYS_DIR")
    assert appmod._default_runways_dir().endswith("runways")


def test_every_runway_has_a_landing_board_endpoint():
    with TestClient(appmod.app) as c:
        for rid in appmod.RUNWAYS:
            r = c.get("/landing-leaderboard", params={"runway_id": rid})
            assert r.status_code == 200, rid
            assert r.json()["course_hash"] == appmod.runway_hash(appmod.RUNWAYS[rid])


# ---------------------------------------------------------- powerups relay (Phase 2)

def test_roll_item_weighting_favors_the_back_of_the_pack():
    # Expected value of the roll, using an arbitrary but monotonic "how good is this item" scale,
    # must increase as rank moves from leader (0) to last place (n-1). This is the actual
    # fairness property the design asks for ("further back = better odds"), not just that the
    # tables differ.
    value = {"nothing": 0, "banana": 1, "goop": 2, "boost": 3, "missile": 4}
    n = 6
    evs = []
    for rank in range(n):
        w = appmod.weights_for_rank(rank, n)
        total = sum(w.values())
        assert total == pytest.approx(100.0), f"rank {rank} weights should normalize to 100: {w}"
        evs.append(sum(w[item] * val for item, val in value.items()) / total)
    assert evs == sorted(evs), f"expected value should be non-decreasing from leader to last: {evs}"
    assert evs[-1] > evs[0], "last place must have strictly better expected odds than the leader"

def test_roll_item_n1_degenerate_case_uses_the_leader_table():
    # Solo racer: no one to catch up to or fall behind, so this should not be treated as "last".
    assert appmod.weights_for_rank(0, 1) == appmod.weights_for_rank(0, 2)

def test_roll_item_samples_deterministically_from_a_stubbed_rng():
    class FixedRng:
        def __init__(self, x): self.x = x
        def uniform(self, a, b): return self.x
    # Leader table (rank 0 of 6), retuned in 0.10.0: nothing=30, banana=45, goop=15, boost=10,
    # missile=0 -> cumulative buckets [0,30] [30,75] [75,90] [90,100] [100,100]
    assert appmod.roll_item(0, 6, rng=FixedRng(10)) == "nothing"
    assert appmod.roll_item(0, 6, rng=FixedRng(60)) == "banana"
    assert appmod.roll_item(0, 6, rng=FixedRng(80)) == "goop"
    assert appmod.roll_item(0, 6, rng=FixedRng(95)) == "boost"
    assert appmod.roll_item(0, 6, rng=FixedRng(100)) != "missile", "the leader never rolls a missile"
    # Last-place table (rank 5 of 6): nothing=0, banana=10, goop=15, boost=35, missile=40
    # -> cumulative buckets [0,0] [0,10] [10,25] [25,60] [60,100]
    assert appmod.roll_item(5, 6, rng=FixedRng(5)) == "banana"
    assert appmod.roll_item(5, 6, rng=FixedRng(20)) == "goop"
    assert appmod.roll_item(5, 6, rng=FixedRng(40)) == "boost"
    assert appmod.roll_item(5, 6, rng=FixedRng(99)) == "missile"


def test_the_retuned_odds_keep_the_leader_in_the_game_and_last_place_off_the_hose():
    """0.10.0 put a row of boxes every third gate, so each weight is drawn four or five times a
    race instead of once. These are the two properties the retune exists to hold."""
    leader = appmod.weights_for_rank(0, 6)
    last = appmod.weights_for_rank(5, 6)
    assert leader["nothing"] == 30 and last["nothing"] == 0
    assert leader["missile"] == 0, "the leader still never gets a missile — that is the one hard rule"
    assert last["missile"] == 40, "…and last place is no longer a 50% missile hose"
    # The leader is not starved: most of their rolls are still a usable item.
    assert sum(v for k, v in leader.items() if k != "nothing") == 70
    for rank in range(6):
        assert sum(appmod.weights_for_rank(rank, 6).values()) == pytest.approx(100.0)

def test_parse_message_accepts_valid_and_rejects_junk():
    assert appmod.parse_message({"type": "join", "callsign": "Eric"}).callsign == "Eric"
    assert appmod.parse_message({"type": "pos", "lat": 1, "lon": 2, "gate": 0, "elapsed_ms": 0}).gate == 0
    appmod.parse_message({"type": "box"})
    assert appmod.parse_message({"type": "fire", "item": "missile"}).item == "missile"
    bad = [
        {"type": "nope"},
        {"type": "join"},
        {"type": "join", "callsign": ""},
        {"type": "pos", "lat": 999, "lon": 0, "gate": 0, "elapsed_ms": 0},
        {"type": "fire", "item": "boost"},   # boost is loadout-only, never a box-relay fire target
        {"type": "fire", "item": "shield"},  # shield is loadout-only, never fired at all
        {"type": "fire"},
        {},
    ]
    for b in bad:
        with pytest.raises(Exception):
            appmod.parse_message(b)

def _recv(ws, skip=("lobby", "world", "box_state", "vote")):
    """Next frame that is not one of the additive broadcasts every socket gets anyway.

    `lobby` (proto 2) lands whenever anyone joins, readies, or the host changes something;
    `world` and `box_state` (proto 3) land on position updates and box pickups; `vote` (proto 5)
    lands on a join and whenever anyone votes. Tests written against the older frames read past
    all of them; a test that cares about one passes `skip=()`.
    """
    while True:
        msg = ws.receive_json()
        if msg["type"] not in skip:
            return msg

def _room_players(name):
    room = appmod.rooms.get(name)
    return set(room.players) if room else set()

def _wait_until(pred, timeout=2.0):
    start = _time.time()
    while _time.time() - start < timeout:
        if pred():
            return True
        _time.sleep(0.02)
    return False

def test_ws_roll_and_targeting_routes_a_fire_to_the_correct_player(monkeypatch):
    monkeypatch.setattr(appmod, "roll_item", lambda rank, n, rng=None: "missile")
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/race/testroom") as leader_ws, \
             c.websocket_connect("/ws/race/testroom") as last_ws:
            leader_ws.send_json({"type": "join", "callsign": "Leader"})
            assert _recv(leader_ws)["type"] == "joined"
            last_ws.send_json({"type": "join", "callsign": "Last"})
            assert _recv(last_ws)["type"] == "joined"

            # Every "pos" broadcasts standings to the whole room (both sockets already joined),
            # so drain both each time or the next expected read on either socket goes stale.
            # `order` is asserted by value; the frame may carry additive fields (positions, 0.9.0)
            # that an older client is expected to ignore.
            leader_ws.send_json({"type": "pos", "lat": 45.0, "lon": -122.0, "gate": 5, "elapsed_ms": 1000})
            for ws in (leader_ws, last_ws):
                assert _recv(ws)["order"] == ["Leader", "Last"]

            last_ws.send_json({"type": "pos", "lat": 45.0, "lon": -122.0, "gate": 1, "elapsed_ms": 500})
            for ws in (leader_ws, last_ws):
                frame = _recv(ws)
                assert frame["order"] == ["Leader", "Last"]
                assert frame["positions"] == {"Leader": [45.0, -122.0], "Last": [45.0, -122.0]}, frame

            last_ws.send_json({"type": "box"})
            assert _recv(last_ws) == {"type": "grant", "item": "missile", "box": 0}
            # Boxing also broadcasts to everyone else — drain it off Leader's socket.
            assert _recv(leader_ws) == {"type": "boxed", "callsign": "Last", "item": "missile"}

            # A client can't ask for a different item than it was granted.
            last_ws.send_json({"type": "fire", "item": "goop"})
            assert _recv(last_ws)["type"] == "error"

            # Proto 3: a fired missile is telegraphed first and resolves flight_ms later.
            last_ws.send_json({"type": "fire", "item": "missile"})
            fired = _recv(leader_ws)
            assert fired["type"] == "fired" and fired["from"] == "Last" and fired["target"] == "Leader"
            assert _recv(last_ws)["type"] == "fired"
            resolved = _recv(leader_ws)
            assert resolved == {"type": "resolved", "id": fired["id"], "item": "missile",
                                "from": "Last", "target": "Leader", "blocked": False, "lost": False}
            assert _recv(leader_ws) == {"type": "hit", "item": "missile", "from": "Last", "id": fired["id"]}

def test_ws_box_broadcasts_what_you_picked_up_to_everyone_else(monkeypatch):
    # Drives the client's kill feed ("Steve boxed a missile"). Deliberately not secret.
    monkeypatch.setattr(appmod, "roll_item", lambda rank, n, rng=None: "goop")
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/race/feedroom") as a_ws, \
             c.websocket_connect("/ws/race/feedroom") as b_ws:
            a_ws.send_json({"type": "join", "callsign": "A"}); assert _recv(a_ws)["type"] == "joined"
            b_ws.send_json({"type": "join", "callsign": "B"}); assert _recv(b_ws)["type"] == "joined"

            a_ws.send_json({"type": "box"})
            assert _recv(a_ws) == {"type": "grant", "item": "goop", "box": 0}
            # B hears about it; A does not get its own boxed broadcast (it already got the grant).
            assert _recv(b_ws) == {"type": "boxed", "callsign": "A", "item": "goop"}

            # Prove A's queue is empty of stray broadcasts by round-tripping a fresh box. Box 0
            # is dark for BOX_RESPAWN_S now (proto 3), so this uses a different one.
            a_ws.send_json({"type": "box", "id": 3})
            assert _recv(a_ws) == {"type": "grant", "item": "goop", "box": 3}


def test_ws_banana_hits_whoever_crosses_it_next(monkeypatch):
    """The server-side 2D fallback, which is what a pre-proto-3 client (no `alt` on `pos`) still
    gets. A proto-3 client trips bananas itself — see the `tripped` tests below."""
    monkeypatch.setattr(appmod, "BANANA_ARM_MS", 0)   # arming is covered by its own test
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/race/bananaroom") as a_ws, \
             c.websocket_connect("/ws/race/bananaroom") as b_ws:
            a_ws.send_json({"type": "join", "callsign": "A"}); assert _recv(a_ws)["type"] == "joined"
            b_ws.send_json({"type": "join", "callsign": "B"}); assert _recv(b_ws)["type"] == "joined"

            a_ws.send_json({"type": "pos", "lat": 10.0, "lon": 20.0, "gate": 0, "elapsed_ms": 0})
            assert _recv(a_ws)["type"] == "standings"
            assert _recv(b_ws)["type"] == "standings"

            # A never had a grant, so its own carrying is None -> the fire is rejected.
            a_ws.send_json({"type": "fire", "item": "banana"})
            assert _recv(a_ws)["type"] == "error"

            # Grant A a banana directly (bypassing the random box roll) and drop it. Proto 3
            # broadcasts the drop to the whole room so everyone can render it.
            appmod.rooms["bananaroom"].players["A"].carrying = "banana"
            a_ws.send_json({"type": "fire", "item": "banana"})
            dropped = _recv(a_ws)
            assert dropped["type"] == "dropped" and dropped["from"] == "A"
            assert _recv(b_ws)["type"] == "dropped"

            # B is far away: no hit, just the usual standings broadcast to both.
            b_ws.send_json({"type": "pos", "lat": 40.0, "lon": 60.0, "gate": 0, "elapsed_ms": 0})
            assert _recv(a_ws)["type"] == "standings"
            assert _recv(b_ws)["type"] == "standings"

            # B moves onto the drop point: cleared to the room, then a hit to B only.
            b_ws.send_json({"type": "pos", "lat": 10.0, "lon": 20.0, "gate": 0, "elapsed_ms": 100})
            assert _recv(b_ws) == {"type": "cleared", "id": dropped["id"], "by": "B", "reason": "hit"}
            assert _recv(b_ws) == {"type": "hit", "item": "banana", "from": "A", "id": dropped["id"]}
            assert _recv(b_ws)["type"] == "standings"
            assert _recv(a_ws)["type"] == "cleared"
            assert _recv(a_ws)["type"] == "standings"
            assert appmod.rooms["bananaroom"].bananas == [], "the banana is consumed after one hit"

def test_ws_message_validation_survives_malformed_input():
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/race/badroom") as ws:
            ws.send_text("not json{{{")
            assert _recv(ws)["type"] == "error"
            ws.send_json({"type": "pos", "lat": 999, "lon": 0, "gate": 0, "elapsed_ms": 0})
            assert _recv(ws)["type"] == "error"
            # the connection is still alive afterward
            ws.send_json({"type": "join", "callsign": "Steve"})
            assert _recv(ws)["type"] == "joined"

def test_ws_oversized_frame_closes_the_connection():
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/race/bigroom") as ws:
            ws.send_text("x" * (appmod.MAX_WS_MSG_BYTES + 100))
            with pytest.raises(Exception):
                _recv(ws)

def test_ws_rate_limit_replies_with_error_once_exceeded():
    orig = appmod.WS_RATE_LIMIT_PER_S
    appmod.WS_RATE_LIMIT_PER_S = 3
    try:
        with TestClient(appmod.app) as c:
            with c.websocket_connect("/ws/race/rateroom") as ws:
                ws.send_json({"type": "join", "callsign": "Flood"})
                assert _recv(ws)["type"] == "joined"
                # A different box each time: proto 3 makes a taken box dark for everyone, so
                # re-boxing the same one would be refused for that reason rather than the limit.
                ws.send_json({"type": "box", "id": 0}); assert _recv(ws)["type"] == "grant"
                ws.send_json({"type": "box", "id": 1}); assert _recv(ws)["type"] == "grant"
                ws.send_json({"type": "box", "id": 2})
                resp = _recv(ws)
                assert resp["type"] == "error" and "rate" in resp["detail"].lower()
    finally:
        appmod.WS_RATE_LIMIT_PER_S = orig

def test_ws_closes_after_repeated_rate_limit_violations():
    orig_limit, orig_max = appmod.WS_RATE_LIMIT_PER_S, appmod.WS_MAX_VIOLATIONS
    # limit=2: the join itself counts as message 1, so the first "box" (message 2) still fits
    # under the limit and succeeds; violations start accumulating from the second "box" onward.
    appmod.WS_RATE_LIMIT_PER_S, appmod.WS_MAX_VIOLATIONS = 2, 2
    try:
        with TestClient(appmod.app) as c:
            with c.websocket_connect("/ws/race/floodroom") as ws:
                ws.send_json({"type": "join", "callsign": "Flood"})
                _recv(ws)
                for i in range(4):
                    ws.send_json({"type": "box", "id": i})
                assert _recv(ws)["type"] == "grant"
                assert _recv(ws)["type"] == "error"
                assert _recv(ws)["type"] == "error"
                with pytest.raises(Exception):
                    _recv(ws)
    finally:
        appmod.WS_RATE_LIMIT_PER_S, appmod.WS_MAX_VIOLATIONS = orig_limit, orig_max

def test_ws_bad_room_name_is_rejected():
    with TestClient(appmod.app) as c:
        with pytest.raises(Exception):
            with c.websocket_connect("/ws/race/Not Valid!") as ws:
                _recv(ws)

def test_ws_disconnect_cleans_up_an_empty_room():
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/race/cleanuproom") as ws:
            ws.send_json({"type": "join", "callsign": "Ghost"})
            _recv(ws)
            assert _room_players("cleanuproom") == {"Ghost"}
        assert _wait_until(lambda: "cleanuproom" not in appmod.rooms), "empty room should be dropped"

def test_ws_disconnect_keeps_a_room_that_still_has_players():
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/race/partialroom") as ws1:
            ws1.send_json({"type": "join", "callsign": "A"}); ws1.receive_json()
            with c.websocket_connect("/ws/race/partialroom") as ws2:
                ws2.send_json({"type": "join", "callsign": "B"}); ws2.receive_json()
                assert _room_players("partialroom") == {"A", "B"}
            assert _wait_until(lambda: _room_players("partialroom") == {"A"})


# ---------------------------------------------------------- lobby (proto 2)
# The relay, not five local clocks, now decides when a race starts. What these check is the
# trust model: only the host can change the room, a start needs a course and everyone's yes
# (or an explicit force), and a client that predates all of this still races exactly as before.

def _lobby(ws, until=None):
    """Next lobby frame on this socket, skipping anything else it is queued behind. Every
    lobby-affecting change broadcasts one, so a socket accumulates a snapshot per change — a
    test that cares about a particular state passes `until` and reads forward to it rather than
    asserting on whichever snapshot happens to be oldest."""
    while True:
        msg = ws.receive_json()
        if msg["type"] == "lobby" and (until is None or until(msg)):
            return msg

def _join(ws, callsign):
    ws.send_json({"type": "join", "callsign": callsign})
    joined = ws.receive_json()
    assert joined["type"] == "joined", joined
    return joined

def _join8(ws, callsign):
    """A join proving FORMATION_PROTO (proto 8), for the rolling-start tests below."""
    ws.send_json({"type": "join", "callsign": callsign, "client_proto": appmod.FORMATION_PROTO})
    joined = ws.receive_json()
    assert joined["type"] == "joined", joined
    return joined

def _course(**kw):
    base = {"type": "course", "course_id": "starter-sprint-seatac", "course_hash": "0a1b2c3d",
            "name": "Starter Sprint", "start_type": "air"}
    base.update(kw)
    return base

def _by_callsign(lobby):
    return {p["callsign"]: p for p in lobby["players"]}


def test_joined_advertises_proto_2_and_a_server_clock():
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/race/protoroom") as ws:
            before = appmod.server_ms()
            joined = _join(ws, "Eric")
            assert joined["proto"] == appmod.PROTO == 9
            assert appmod.LOBBY_PROTO == 2 and appmod.ITEMS_PROTO == 3 and appmod.RESULTS_PROTO == 4
            assert appmod.HUB_PROTO == 5 and appmod.MODES_PROTO == 6 and appmod.RENAME_PROTO == 7 and appmod.FORMATION_PROTO == 8
            assert before <= joined["server_ms"] <= appmod.server_ms()
            assert joined["room"] == "protoroom"

def test_ping_is_answered_with_the_server_clock_and_the_callers_own_t0():
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/race/pingroom") as ws:
            # Deliberately allowed before join: it measures the socket, not the player.
            ws.send_json({"type": "ping", "t0": 1234.5})
            pong = ws.receive_json()
            assert pong["type"] == "pong" and pong["t0"] == 1234.5
            assert isinstance(pong["server_ms"], int)

def test_first_joiner_is_host_and_the_host_migrates_on_disconnect():
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/race/hostroom") as a_ws:
            _join(a_ws, "A")
            assert _lobby(a_ws)["host"] == "A"
            with c.websocket_connect("/ws/race/hostroom") as b_ws:
                _join(b_ws, "B")
                with c.websocket_connect("/ws/race/hostroom") as c_ws:
                    _join(c_ws, "C")
                    assert _lobby(c_ws)["host"] == "A"
                    assert [p["callsign"] for p in _lobby(b_ws, lambda l: len(l["players"]) == 3)["players"]] == ["A", "B", "C"]
                    # B and C both remain; the host goes to the longer-connected one, B.
                    a_ws.close()
                    assert _wait_until(lambda: appmod.rooms["hostroom"].host == "B")
                    assert _lobby(b_ws, lambda l: l["host"] == "B")["players"][0]["callsign"] == "B"

def test_rename_changes_the_room_visible_callsign_and_broadcasts_presence():
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/race/renameroom") as host_ws, \
             c.websocket_connect("/ws/race/renameroom") as guest_ws:
            _join(host_ws, "Host")
            _join(guest_ws, "Guest")
            guest_ws.send_json({"type": "rename", "callsign": "NewGuest"})
            renamed = _recv(guest_ws, skip=("lobby", "world", "box_state", "vote"))
            assert renamed == {"type": "renamed", "old": "Guest", "new": "NewGuest"}
            assert _recv(host_ws, skip=("lobby", "world", "box_state", "vote")) == renamed
            room = appmod.rooms["renameroom"]
            assert set(room.players) == {"Host", "NewGuest"}
            assert room.players["NewGuest"].callsign == "NewGuest"
            assert _lobby(host_ws, lambda l: {p["callsign"] for p in l["players"]} == {"Host", "NewGuest"})

def test_rename_is_refused_when_the_new_callsign_is_already_in_the_room():
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/race/renameclashroom") as a_ws, \
             c.websocket_connect("/ws/race/renameclashroom") as b_ws:
            _join(a_ws, "Alpha")
            _join(b_ws, "Bravo")
            b_ws.send_json({"type": "rename", "callsign": "Alpha"})
            assert _recv(b_ws) == {"type": "error", "detail": "callsign already connected in this room"}
            room = appmod.rooms["renameclashroom"]
            assert set(room.players) == {"Alpha", "Bravo"}

def test_rename_mid_race_keeps_the_renamed_racer_tallying_correctly():
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/race/renamemidroom") as host_ws:
            _join(host_ws, "Host")
            host_ws.send_json(_course())
            host_ws.send_json({"type": "ready", "ready": True})
            host_ws.send_json({"type": "start", "lead_s": 5, "force": True})
            assert _recv(host_ws)["type"] == "start"
            room = appmod.rooms["renamemidroom"]
            assert "Host" in room.race.racers

            host_ws.send_json({"type": "rename", "callsign": "Renamed"})
            assert _recv(host_ws, skip=("lobby", "world", "box_state", "vote")) == \
                {"type": "renamed", "old": "Host", "new": "Renamed"}
            assert "Renamed" in room.race.racers and "Host" not in room.race.racers
            assert room.race.racers["Renamed"].callsign == "Renamed"
            assert room.host == "Renamed"

            # The renamed racer keeps reporting position/finishing under the new name with no
            # "join first"/unknown-player error — the room re-keyed cleanly, not just cosmetically.
            host_ws.send_json({"type": "pos", "lat": 45.0, "lon": -122.0, "gate": 1, "elapsed_ms": 500})
            standings = _recv(host_ws, skip=("lobby", "world", "box_state", "vote"))
            assert standings["type"] == "standings"
            assert standings["order"] == ["Renamed"]

def test_host_only_frames_are_refused_for_everyone_else():
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/race/permroom") as host_ws, \
             c.websocket_connect("/ws/race/permroom") as guest_ws:
            _join(host_ws, "Host")
            _join(guest_ws, "Guest")
            for frame in (_course(), {"type": "rules", "powerups": False, "teleport": True},
                          {"type": "start", "lead_s": 10, "force": True}, {"type": "abort"},
                          {"type": "back_to_lobby"}):
                guest_ws.send_json(frame)
                assert _recv(guest_ws) == {"type": "error", "detail": "host only"}, frame
            # …and the room is untouched by any of them.
            assert appmod.rooms["permroom"].course is None
            assert appmod.rooms["permroom"].phase == "lobby"

def test_start_is_refused_without_a_course_and_without_everyone_ready():
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/race/gateroom") as host_ws, \
             c.websocket_connect("/ws/race/gateroom") as guest_ws:
            _join(host_ws, "Host")
            _join(guest_ws, "Guest")

            host_ws.send_json({"type": "start", "lead_s": 10})
            assert _recv(host_ws) == {"type": "error", "detail": "no course selected"}

            host_ws.send_json(_course())
            host_ws.send_json({"type": "start", "lead_s": 10})
            assert _recv(host_ws) == {"type": "error", "detail": "not everyone is ready"}

            host_ws.send_json({"type": "ready", "ready": True})
            host_ws.send_json({"type": "start", "lead_s": 10})
            assert _recv(host_ws) == {"type": "error", "detail": "not everyone is ready"}

            guest_ws.send_json({"type": "ready", "ready": True})
            assert _wait_until(lambda: all(p.ready for p in appmod.rooms["gateroom"].players.values()))
            host_ws.send_json({"type": "start", "lead_s": 10})
            start = _recv(host_ws)
            assert start["type"] == "start" and start["racers"] == ["Host", "Guest"]
            assert appmod.rooms["gateroom"].phase == "countdown"

def test_force_start_turns_everyone_who_is_not_ready_into_a_spectator():
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/race/forceroom") as host_ws, \
             c.websocket_connect("/ws/race/forceroom") as afk_ws:
            _join(host_ws, "Host")
            _join(afk_ws, "Afk")
            host_ws.send_json(_course())
            host_ws.send_json({"type": "ready", "ready": True})
            host_ws.send_json({"type": "start", "lead_s": 5, "force": True})

            start = _recv(host_ws)
            assert start["type"] == "start" and start["racers"] == ["Host"]
            assert start["race_id"] == 1
            roles = {cs: p.role for cs, p in appmod.rooms["forceroom"].players.items()}
            assert roles == {"Host": "racer", "Afk": "spectator"}
            # The spectator hears about it too — it needs to stop timing itself.
            assert _recv(afk_ws)["racers"] == ["Host"]

def test_changing_the_course_or_the_rules_clears_every_ready_flag():
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/race/clearroom") as host_ws, \
             c.websocket_connect("/ws/race/clearroom") as guest_ws:
            _join(host_ws, "Host")
            _join(guest_ws, "Guest")
            host_ws.send_json({"type": "ready", "ready": True})
            guest_ws.send_json({"type": "ready", "ready": True})
            assert _wait_until(lambda: all(p.ready for p in appmod.rooms["clearroom"].players.values()))

            host_ws.send_json(_course())
            assert _wait_until(lambda: not any(p.ready for p in appmod.rooms["clearroom"].players.values())), \
                "a course change means nobody has confirmed the new one yet"

            guest_ws.send_json({"type": "ready", "ready": True})
            host_ws.send_json({"type": "ready", "ready": True})
            assert _wait_until(lambda: all(p.ready for p in appmod.rooms["clearroom"].players.values()))
            host_ws.send_json({"type": "rules", "powerups": False, "teleport": False})
            assert _wait_until(lambda: not any(p.ready for p in appmod.rooms["clearroom"].players.values()))
            assert appmod.rooms["clearroom"].rules == {"powerups": False, "teleport": False, "rolling": True}

def test_abort_returns_to_the_lobby_and_keeps_the_ready_flags():
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/race/abortroom") as host_ws:
            _join(host_ws, "Host")
            host_ws.send_json(_course())
            host_ws.send_json({"type": "ready", "ready": True})
            host_ws.send_json({"type": "start", "lead_s": 60})
            assert _recv(host_ws)["type"] == "start"
            assert appmod.rooms["abortroom"].phase == "countdown"

            host_ws.send_json({"type": "abort"})
            assert _recv(host_ws) == {"type": "abort"}
            room = appmod.rooms["abortroom"]
            assert room.phase == "lobby"
            assert room.players["Host"].ready is True, "nobody un-said yes by aborting"
            assert room.start_task is None, "the countdown task is cancelled, not left to fire"

            # Nothing to abort once we are back in the lobby.
            host_ws.send_json({"type": "abort"})
            assert _recv(host_ws) == {"type": "error", "detail": "nothing to abort"}

def test_a_player_joining_mid_countdown_is_a_spectator_until_back_to_lobby():
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/race/lateroom") as host_ws:
            _join(host_ws, "Host")
            host_ws.send_json(_course())
            host_ws.send_json({"type": "ready", "ready": True})
            host_ws.send_json({"type": "start", "lead_s": 60})
            assert _recv(host_ws)["type"] == "start"

            with c.websocket_connect("/ws/race/lateroom") as late_ws:
                _join(late_ws, "Late")
                players = _by_callsign(_lobby(late_ws))
                assert players["Late"]["role"] == "spectator"
                assert players["Host"]["role"] == "racer"

                host_ws.send_json({"type": "back_to_lobby"})
                assert _wait_until(lambda: appmod.rooms["lateroom"].phase == "lobby")
                room = appmod.rooms["lateroom"]
                assert [p.role for p in room.players.values()] == ["racer", "racer"]
                assert not any(p.ready for p in room.players.values()), "back_to_lobby clears ready"

def test_successive_starts_hand_out_increasing_race_ids_and_start_times():
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/race/monoroom") as host_ws:
            _join(host_ws, "Host")
            host_ws.send_json(_course())
            host_ws.send_json({"type": "ready", "ready": True})
            seen = []
            for _ in range(3):
                host_ws.send_json({"type": "start", "lead_s": 5})
                start = _recv(host_ws)
                assert start["type"] == "start"
                # start_at is the server's own clock plus the lead, never a client's.
                assert abs(start["start_at_server_ms"] - (appmod.server_ms() + 5000)) < 1000
                seen.append((start["race_id"], start["start_at_server_ms"]))
                host_ws.send_json({"type": "abort"})
                assert _recv(host_ws)["type"] == "abort"
            assert [r for r, _ in seen] == [1, 2, 3]
            assert [t for _, t in seen] == sorted(t for _, t in seen)

def test_hello_publishes_a_model_and_chat_is_a_closed_enum():
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/race/chatroom") as a_ws, \
             c.websocket_connect("/ws/race/chatroom") as b_ws:
            _join(a_ws, "A")
            _join(b_ws, "B")
            a_ws.send_json({"type": "hello", "model": "bratwurst"})
            assert _wait_until(lambda: appmod.rooms["chatroom"].players["A"].model == "bratwurst")
            assert _lobby(b_ws, lambda l: _by_callsign(l)["A"]["model"] == "bratwurst")

            a_ws.send_json({"type": "chat", "code": "gg"})
            assert _recv(b_ws) == {"type": "chat", "callsign": "A", "code": "gg"}
            assert _recv(a_ws) == {"type": "chat", "callsign": "A", "code": "gg"}, "your own chat echoes back"

            for bad in ("drop dead", "", "GG"):
                a_ws.send_json({"type": "chat", "code": bad})
                assert _recv(a_ws)["type"] == "error", bad

def test_new_message_validation():
    assert appmod.parse_message({"type": "ready", "ready": True}).ready is True
    assert appmod.parse_message({"type": "start", "lead_s": 5}).force is False
    assert appmod.parse_message({"type": "hello", "model": ""}).model == ""
    bad = [
        {"type": "start", "lead_s": 4},                       # below MIN_LEAD_S
        {"type": "start", "lead_s": 61},                      # above MAX_LEAD_S
        {"type": "ready"},
        {"type": "ping"},
        {"type": "hello", "model": "x" * 33},
        {"type": "course", "course_id": "Bad Id", "course_hash": "0a1b2c3d", "name": "n", "start_type": "air"},
        {"type": "course", "course_id": "ok", "course_hash": "nope", "name": "n", "start_type": "air"},
        {"type": "course", "course_id": "ok", "course_hash": "0a1b2c3d", "name": "n", "start_type": "water"},
        {"type": "rules", "powerups": True},
        {"type": "chat", "code": "nope"},
    ]
    for b in bad:
        with pytest.raises(Exception):
            appmod.parse_message(b)

def test_an_old_client_that_never_sends_hello_or_ready_still_races_as_before(monkeypatch):
    """A 0.7.x client knows nothing about the lobby: it joins, pings position, boxes, fires.
    Proto 2 must not have taken any of that away — it only adds frames it can safely ignore."""
    monkeypatch.setattr(appmod, "roll_item", lambda rank, n, rng=None: "missile")
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/race/oldroom") as old_ws, \
             c.websocket_connect("/ws/race/oldroom") as other_ws:
            _join(old_ws, "Old")
            _join(other_ws, "Other")

            # Every pos broadcasts standings to the whole room, so drain both sockets each time.
            old_ws.send_json({"type": "pos", "lat": 45.0, "lon": -122.0, "gate": 5, "elapsed_ms": 1000})
            for ws in (old_ws, other_ws):
                assert _recv(ws)["order"] == ["Old", "Other"]
            other_ws.send_json({"type": "pos", "lat": 45.0, "lon": -122.0, "gate": 1, "elapsed_ms": 500})
            for ws in (old_ws, other_ws):
                assert _recv(ws)["order"] == ["Old", "Other"]

            other_ws.send_json({"type": "box"})
            assert _recv(other_ws)["item"] == "missile"      # `box` is additive on `grant`
            assert _recv(old_ws) == {"type": "boxed", "callsign": "Other", "item": "missile"}
            other_ws.send_json({"type": "fire", "item": "missile"})
            # The instant-hit path is gone, but an old client still receives `hit` — just at
            # resolution time, behind a `fired`/`resolved` pair it does not recognize and ignores.
            hit = _recv(old_ws, skip=("lobby", "world", "box_state", "fired", "resolved", "vote"))
            assert hit["item"] == "missile" and hit["from"] == "Other"
            # Never readied, never said hello, and still a full racer in the room's own view.
            assert appmod.rooms["oldroom"].players["Old"].role == "racer"


# ---------------------------------------------------------- items (proto 3)
# Every offensive item is now something you can see coming: a missile is telegraphed and lands
# flight_ms later, a banana is a real object with a TTL and an arming delay that the client that
# flew into it reports, and boxes are contested. What these check is that the added authority is
# only ever over things the relay can actually verify.

def _fast_flight(monkeypatch, ms=60):
    """Collapse the telegraphed flight so a resolution test runs in milliseconds, not seconds.
    The clamp itself is asserted separately against the real constants (pure, no sockets)."""
    monkeypatch.setattr(appmod, "FLIGHT_CLAMP_MS", {"missile": (ms, ms), "goop": (ms, ms)})


def test_flight_time_is_distance_over_250_clamped_per_item():
    # Pure: no sockets, real constants. 250 m/s, so 250 m of separation is one second in the air.
    assert appmod.flight_ms_for("missile", 250.0) == 1500, "under the floor clamps up"
    assert appmod.flight_ms_for("missile", 500.0) == 2000
    assert appmod.flight_ms_for("missile", 1_000_000.0) == 4000, "over the ceiling clamps down"
    assert appmod.flight_ms_for("missile", 0.0) == 1500
    assert appmod.flight_ms_for("missile", -5.0) == 1500, "a negative distance never goes negative"
    # Goop is the faster, shorter-range one.
    assert appmod.flight_ms_for("goop", 0.0) == 1000
    assert appmod.flight_ms_for("goop", 1_000_000.0) == 3000
    assert appmod.flight_ms_for("goop", 500.0) == 2000


def test_offset_point_puts_a_banana_behind_its_dropper():
    # Pure inverse of _meters_between(): 150 m due south of the drop, for a pilot heading north.
    lat, lon = appmod.offset_point(45.0, -122.0, 180.0, 150.0)
    assert lat < 45.0 and abs(lon + 122.0) < 1e-6
    assert appmod._meters_between(45.0, -122.0, lat, lon) == pytest.approx(150.0, abs=1.0)
    # And due west for a pilot heading east.
    lat2, lon2 = appmod.offset_point(45.0, -122.0, 270.0, 150.0)
    assert lon2 < -122.0 and abs(lat2 - 45.0) < 1e-6
    assert appmod._meters_between(45.0, -122.0, lat2, lon2) == pytest.approx(150.0, abs=1.0)


def test_a_fired_missile_is_telegraphed_first_and_resolves_later(monkeypatch):
    _fast_flight(monkeypatch, 80)
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/race/flightroom") as lead_ws, \
             c.websocket_connect("/ws/race/flightroom") as back_ws:
            _join(lead_ws, "Lead"); _join(back_ws, "Back")
            lead_ws.send_json({"type": "pos", "lat": 45.0, "lon": -122.0, "gate": 5, "elapsed_ms": 1000, "alt": 900.0})
            for ws in (lead_ws, back_ws):
                assert _recv(ws)["type"] == "standings"
            back_ws.send_json({"type": "pos", "lat": 45.0, "lon": -122.01, "gate": 1, "elapsed_ms": 900, "alt": 880.0})
            for ws in (lead_ws, back_ws):
                assert _recv(ws)["type"] == "standings"

            appmod.rooms["flightroom"].players["Back"].carrying = "missile"
            back_ws.send_json({"type": "fire", "item": "missile"})

            # Everyone sees the launch, with the same id and the same flight time, so both
            # clients animate the same projectile and agree on when it lands.
            a, b = _recv(lead_ws), _recv(back_ws)
            assert a == b and a["type"] == "fired"
            assert a["item"] == "missile" and a["from"] == "Back" and a["target"] == "Lead"
            assert a["flight_ms"] == 80

            # …and only then does the hit exist at all.
            assert _recv(lead_ws)["type"] == "resolved"
            assert _recv(lead_ws) == {"type": "hit", "item": "missile", "from": "Back", "id": a["id"]}


def test_a_shield_raised_during_the_flight_blocks_the_hit(monkeypatch):
    """The decision window the flight time exists to create: the shield is checked AT
    RESOLUTION, so popping it after the launch frame still works."""
    _fast_flight(monkeypatch, 250)
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/race/shieldroom") as lead_ws, \
             c.websocket_connect("/ws/race/shieldroom") as back_ws:
            _join(lead_ws, "Lead"); _join(back_ws, "Back")
            lead_ws.send_json({"type": "pos", "lat": 45.0, "lon": -122.0, "gate": 5, "elapsed_ms": 1000, "alt": 900.0})
            for ws in (lead_ws, back_ws):
                _recv(ws)
            back_ws.send_json({"type": "pos", "lat": 45.0, "lon": -122.01, "gate": 1, "elapsed_ms": 900, "alt": 880.0})
            for ws in (lead_ws, back_ws):
                _recv(ws)

            appmod.rooms["shieldroom"].players["Back"].carrying = "missile"
            back_ws.send_json({"type": "fire", "item": "missile"})
            fired = _recv(lead_ws)
            assert fired["type"] == "fired"
            assert _recv(back_ws)["type"] == "fired"

            # Shield up mid-flight.
            lead_ws.send_json({"type": "fx", "item": "shield", "ms": 6000})
            fx = _recv(lead_ws, skip=("lobby", "world", "box_state", "vote"))
            assert fx == {"type": "fx", "callsign": "Lead", "item": "shield", "ms": 6000}
            assert _recv(back_ws)["type"] == "fx"

            resolved = _recv(lead_ws)
            assert resolved["type"] == "resolved" and resolved["blocked"] is True
            assert _recv(back_ws)["type"] == "resolved", "the shooter sees the block too"
            # No `hit` follows a block. Prove the queue is otherwise empty with a round trip.
            lead_ws.send_json({"type": "ping", "t0": 7.0})
            assert _recv(lead_ws)["type"] == "pong"


def test_a_shield_the_relay_never_saw_cannot_block_anything(monkeypatch):
    """The relay trusts the fx frame (friend group), but only as a window: a claim it never
    received, or one older than SHIELD_MS, is not a shield."""
    _fast_flight(monkeypatch, 60)
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/race/noshieldroom") as lead_ws, \
             c.websocket_connect("/ws/race/noshieldroom") as back_ws:
            _join(lead_ws, "Lead"); _join(back_ws, "Back")
            room = appmod.rooms["noshieldroom"]
            assert room.players["Lead"].shield_until == 0, "no shield until one is claimed"
            # An expired claim: the window is in the past, so it blocks nothing.
            room.players["Lead"].shield_until = appmod.server_ms() - 1
            room.players["Lead"].gate = 5
            room.players["Back"].carrying = "missile"
            back_ws.send_json({"type": "fire", "item": "missile"})
            assert _recv(back_ws)["type"] == "fired"
            assert _recv(lead_ws)["type"] == "fired"
            assert _recv(lead_ws)["blocked"] is False
            assert _recv(lead_ws)["type"] == "hit"


def test_an_fx_shield_claim_is_capped_at_the_shield_duration():
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/race/fxcaproom") as ws:
            _join(ws, "Greedy")
            before = appmod.server_ms()
            ws.send_json({"type": "fx", "item": "shield", "ms": 30000})
            assert _recv(ws)["ms"] == appmod.SHIELD_MS, "a 30 s shield claim is capped"
            until = appmod.rooms["fxcaproom"].players["Greedy"].shield_until
            assert before + appmod.SHIELD_MS <= until <= appmod.server_ms() + appmod.SHIELD_MS


def test_fx_is_rate_limited_to_one_per_two_seconds_per_player():
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/race/fxroom") as a_ws, \
             c.websocket_connect("/ws/race/fxroom") as b_ws:
            _join(a_ws, "A"); _join(b_ws, "B")
            # fx goes to the whole room INCLUDING the sender, like `chat` — one client's own
            # feed can then just render whatever its socket receives.
            a_ws.send_json({"type": "fx", "item": "boost", "ms": 4000})
            for ws in (a_ws, b_ws):
                assert _recv(ws) == {"type": "fx", "callsign": "A", "item": "boost", "ms": 4000}
            # Immediately again: dropped, silently (a dropped cosmetic frame is not an error).
            a_ws.send_json({"type": "fx", "item": "boost", "ms": 4000})
            # B's own fx still gets through — the limit is per player, not per room.
            b_ws.send_json({"type": "fx", "item": "shield", "ms": 6000})
            for ws in (a_ws, b_ws):
                nxt = _recv(ws)
                assert nxt == {"type": "fx", "callsign": "B", "item": "shield", "ms": 6000},                     f"A's second fx should have been dropped, got {nxt}"


def test_the_leader_gets_the_item_back_instead_of_burning_it():
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/race/refundroom") as ws:
            _join(ws, "Solo")
            appmod.rooms["refundroom"].players["Solo"].carrying = "missile"
            ws.send_json({"type": "fire", "item": "missile"})
            assert _recv(ws) == {"type": "refund", "item": "missile", "reason": "no_target"}
            assert appmod.rooms["refundroom"].players["Solo"].carrying == "missile"
            # And it is genuinely fireable again once somebody is ahead.
            with c.websocket_connect("/ws/race/refundroom") as lead_ws:
                _join(lead_ws, "Lead")
                appmod.rooms["refundroom"].players["Lead"].gate = 9
                ws.send_json({"type": "fire", "item": "missile"})
                assert _recv(ws)["type"] == "fired"


def test_a_banana_is_dropped_behind_the_shooter_and_arms_late():
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/race/armroom") as a_ws, \
             c.websocket_connect("/ws/race/armroom") as b_ws:
            _join(a_ws, "A"); _join(b_ws, "B")
            a_ws.send_json({"type": "pos", "lat": 45.0, "lon": -122.0, "gate": 1, "elapsed_ms": 0, "alt": 1000.0})
            for ws in (a_ws, b_ws):
                assert _recv(ws)["type"] == "standings"

            room = appmod.rooms["armroom"]
            room.players["A"].carrying = "banana"
            before = appmod.server_ms()
            a_ws.send_json({"type": "fire", "item": "banana", "heading": 0.0})
            dropped = _recv(b_ws)
            assert _recv(a_ws)["type"] == "dropped", "the dropper sees its own banana too"
            assert dropped["type"] == "dropped" and dropped["from"] == "A"
            assert dropped["alt"] == 1000.0, "the drop carries altitude now, so it can be drawn in 3D"
            # 150 m behind a pilot heading due north is 150 m due south.
            assert dropped["lat"] < 45.0
            assert appmod._meters_between(45.0, -122.0, dropped["lat"], dropped["lon"]) == pytest.approx(
                appmod.BANANA_DROP_BACK_M, abs=2.0)
            assert before + appmod.BANANA_ARM_MS <= dropped["armed_at_server_ms"] <= appmod.server_ms() + appmod.BANANA_ARM_MS

            # B trips it immediately: refused, because it is not armed yet — the dropper's
            # wingman does not eat a banana the instant it appears.
            b_ws.send_json({"type": "tripped", "id": dropped["id"]})
            assert len(room.bananas) == 1, "an unarmed banana is not consumed"

            room.bananas[0]["armed_at"] = appmod.server_ms() - 1
            b_ws.send_json({"type": "pos", "lat": dropped["lat"], "lon": dropped["lon"],
                            "gate": 1, "elapsed_ms": 10, "alt": 1000.0})
            for ws in (a_ws, b_ws):
                assert _recv(ws)["type"] == "standings"
            b_ws.send_json({"type": "tripped", "id": dropped["id"]})
            assert _recv(b_ws) == {"type": "cleared", "id": dropped["id"], "by": "B", "reason": "hit"}
            assert _recv(b_ws) == {"type": "hit", "item": "banana", "from": "A", "id": dropped["id"]}
            assert room.bananas == []


def test_a_tripped_claim_from_far_away_is_refused():
    """The one thing the relay takes a client's word for is 'I flew into that' — and it still
    checks the claim against that same client's own last reported position."""
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/race/liarroom") as a_ws, \
             c.websocket_connect("/ws/race/liarroom") as b_ws:
            _join(a_ws, "A"); _join(b_ws, "B")
            a_ws.send_json({"type": "pos", "lat": 45.0, "lon": -122.0, "gate": 1, "elapsed_ms": 0, "alt": 1000.0})
            for ws in (a_ws, b_ws):
                _recv(ws)
            room = appmod.rooms["liarroom"]
            room.players["A"].carrying = "banana"
            a_ws.send_json({"type": "fire", "item": "banana"})
            dropped = _recv(b_ws)
            assert _recv(a_ws)["type"] == "dropped"
            room.bananas[0]["armed_at"] = appmod.server_ms() - 1

            # B is 100 km away and says it hit the banana.
            b_ws.send_json({"type": "pos", "lat": 46.0, "lon": -122.0, "gate": 1, "elapsed_ms": 10, "alt": 1000.0})
            for ws in (a_ws, b_ws):
                _recv(ws)
            b_ws.send_json({"type": "tripped", "id": dropped["id"]})
            err = _recv(b_ws)
            assert err["type"] == "error" and "too far" in err["detail"]
            assert len(room.bananas) == 1, "a refused claim never clears the banana"

            # Just inside radius + slack is accepted — the slack is there so a client that
            # detected the hit two frames of travel ago is still believed.
            near_lat, near_lon = appmod.offset_point(
                dropped["lat"], dropped["lon"], 90.0, appmod.BANANA_RADIUS_M + appmod.TRIP_SLACK_M - 50)
            b_ws.send_json({"type": "pos", "lat": near_lat, "lon": near_lon, "gate": 1, "elapsed_ms": 20, "alt": 1000.0})
            for ws in (a_ws, b_ws):
                _recv(ws)
            b_ws.send_json({"type": "tripped", "id": dropped["id"]})
            assert _recv(b_ws)["type"] == "cleared"
            assert room.bananas == []


def test_a_shielded_pilot_clears_a_banana_without_taking_the_hit():
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/race/bshieldroom") as a_ws, \
             c.websocket_connect("/ws/race/bshieldroom") as b_ws:
            _join(a_ws, "A"); _join(b_ws, "B")
            a_ws.send_json({"type": "pos", "lat": 45.0, "lon": -122.0, "gate": 1, "elapsed_ms": 0, "alt": 1000.0})
            for ws in (a_ws, b_ws):
                _recv(ws)
            room = appmod.rooms["bshieldroom"]
            room.players["A"].carrying = "banana"
            a_ws.send_json({"type": "fire", "item": "banana"})
            dropped = _recv(b_ws)
            _recv(a_ws)
            room.bananas[0]["armed_at"] = appmod.server_ms() - 1

            b_ws.send_json({"type": "fx", "item": "shield", "ms": 6000})
            for ws in (a_ws, b_ws):
                assert _recv(ws)["type"] == "fx"
            b_ws.send_json({"type": "pos", "lat": dropped["lat"], "lon": dropped["lon"],
                            "gate": 1, "elapsed_ms": 10, "alt": 1000.0})
            for ws in (a_ws, b_ws):
                _recv(ws)
            b_ws.send_json({"type": "tripped", "id": dropped["id"]})
            assert _recv(b_ws) == {"type": "cleared", "id": dropped["id"], "by": "B", "reason": "blocked"}
            # Cleared, but no hit — prove it with a round trip.
            b_ws.send_json({"type": "ping", "t0": 1.0})
            assert _recv(b_ws)["type"] == "pong"


def test_the_banana_list_is_capped_and_expires(monkeypatch):
    monkeypatch.setattr(appmod, "MAX_BANANAS", 3)
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/race/bananacaproom") as ws:
            _join(ws, "Dropper")
            ws.send_json({"type": "pos", "lat": 45.0, "lon": -122.0, "gate": 1, "elapsed_ms": 0, "alt": 500.0})
            assert _recv(ws)["type"] == "standings"
            room = appmod.rooms["bananacaproom"]
            ids = []
            for i in range(5):
                room.players["Dropper"].carrying = "banana"
                ws.send_json({"type": "fire", "item": "banana", "heading": float(i * 70)})
                frame = _recv(ws)
                while frame["type"] == "cleared":     # the eviction of the oldest
                    frame = _recv(ws)
                assert frame["type"] == "dropped"
                ids.append(frame["id"])
            assert [b["id"] for b in room.bananas] == ids[-3:], "oldest evicted first, cap held"

            # TTL: a banana older than BANANA_TTL_S is pruned on the next position update, and
            # the room is told so every client can drop its entity.
            room.bananas[0]["dropped_at"] -= int(appmod.BANANA_TTL_S * 1000) + 1
            stale = room.bananas[0]["id"]
            ws.send_json({"type": "pos", "lat": 45.0, "lon": -122.0, "gate": 1, "elapsed_ms": 50, "alt": 500.0})
            cleared = _recv(ws)
            assert cleared == {"type": "cleared", "id": stale, "by": None, "reason": "expired"}
            assert stale not in [b["id"] for b in room.bananas]


def test_a_taken_box_goes_dark_for_everyone_and_refuses_a_second_grab(monkeypatch):
    monkeypatch.setattr(appmod, "roll_item", lambda rank, n, rng=None: "boost")
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/race/boxroom") as a_ws, \
             c.websocket_connect("/ws/race/boxroom") as b_ws:
            _join(a_ws, "A"); _join(b_ws, "B")
            before = appmod.server_ms()
            a_ws.send_json({"type": "box", "id": 2})
            assert _recv(a_ws, skip=("lobby", "world", "vote")) == {"type": "grant", "item": "boost", "box": 2}
            state = _recv(a_ws, skip=("lobby", "world", "vote"))
            assert state["type"] == "box_state" and state["id"] == 2
            assert before + int(appmod.BOX_RESPAWN_S * 1000) <= state["until_server_ms"] <= \
                appmod.server_ms() + int(appmod.BOX_RESPAWN_S * 1000)
            # B is told the box is dark too, before it hears what A picked up.
            assert _recv(b_ws, skip=("lobby", "world", "vote"))["type"] == "box_state"
            assert _recv(b_ws, skip=("lobby", "world", "vote")) == {"type": "boxed", "callsign": "A", "item": "boost"}

            # B arrives a moment later: refused, with the relight time and no grant.
            b_ws.send_json({"type": "box", "id": 2})
            refusal = _recv(b_ws, skip=("lobby", "world", "vote"))
            assert refusal["type"] == "box_state" and refusal["id"] == 2
            assert appmod.rooms["boxroom"].players["B"].carrying is None, "a dark box grants nothing"

            # …and a different box is unaffected.
            b_ws.send_json({"type": "box", "id": 3})
            assert _recv(b_ws, skip=("lobby", "world", "vote"))["type"] == "grant"


def test_a_box_that_has_relit_grants_again(monkeypatch):
    monkeypatch.setattr(appmod, "roll_item", lambda rank, n, rng=None: "goop")
    monkeypatch.setattr(appmod, "BOX_RESPAWN_S", 0.0)
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/race/relitroom") as ws:
            _join(ws, "A")
            ws.send_json({"type": "box", "id": 0})
            assert _recv(ws, skip=("lobby", "world", "box_state", "vote"))["type"] == "grant"
            ws.send_json({"type": "box", "id": 0})
            assert _recv(ws, skip=("lobby", "world", "box_state", "vote"))["type"] == "grant"


def test_a_joiner_is_told_about_live_bananas_and_dark_boxes(monkeypatch):
    monkeypatch.setattr(appmod, "roll_item", lambda rank, n, rng=None: "banana")
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/race/lateroom") as a_ws:
            _join(a_ws, "A")
            a_ws.send_json({"type": "pos", "lat": 45.0, "lon": -122.0, "gate": 1, "elapsed_ms": 0, "alt": 700.0})
            assert _recv(a_ws)["type"] == "standings"
            a_ws.send_json({"type": "box", "id": 5})
            assert _recv(a_ws, skip=("lobby", "world", "box_state", "vote"))["type"] == "grant"
            a_ws.send_json({"type": "fire", "item": "banana"})
            dropped = _recv(a_ws, skip=("lobby", "world", "box_state", "vote"))
            assert dropped["type"] == "dropped"

            with c.websocket_connect("/ws/race/lateroom") as b_ws:
                b_ws.send_json({"type": "join", "callsign": "B"})
                assert _recv(b_ws, skip=())["type"] == "joined"
                # The catch-up frames land right after `joined`, before the lobby broadcast.
                seen = [_recv(b_ws, skip=("lobby", "vote")) for _ in range(2)]
                types = [f["type"] for f in seen]
                assert "dropped" in types and "box_state" in types, types
                assert next(f for f in seen if f["type"] == "dropped")["id"] == dropped["id"]
                assert next(f for f in seen if f["type"] == "box_state")["id"] == 5


def test_world_is_coalesced_to_at_most_twice_a_second_per_room():
    """`standings` still goes out per `pos` (unchanged, old clients depend on it). `world` — the
    altitude-carrying frame the item effects are placed from — is throttled, because a race
    sends `pos` at 2 Hz per player and N times that would carry no more information."""
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/race/worldroom") as ws:
            _join(ws, "A")
            frames = []
            for i in range(6):
                ws.send_json({"type": "pos", "lat": 45.0 + i * 0.001, "lon": -122.0,
                              "gate": i, "elapsed_ms": i * 100, "alt": 500.0 + i})
                # Each pos produces a standings frame, and at most sometimes a world frame.
                while True:
                    msg = ws.receive_json()
                    if msg["type"] == "world":
                        frames.append(msg)
                        continue
                    if msg["type"] == "standings":
                        break
            assert len(frames) == 1, f"6 pos frames in well under a second produced {len(frames)} world frames"
            assert frames[0]["players"] == [{"callsign": "A", "lat": 45.0, "lon": -122.0,
                                             "alt": 500.0, "gate": 0}]

            # Past the window, the next pos does broadcast again.
            appmod.rooms["worldroom"].world_last -= appmod.WORLD_MIN_INTERVAL_S + 0.1
            ws.send_json({"type": "pos", "lat": 46.0, "lon": -123.0, "gate": 9, "elapsed_ms": 999, "alt": 1234.0})
            got = [ws.receive_json() for _ in range(2)]
            world = next(f for f in got if f["type"] == "world")
            assert world["players"] == [{"callsign": "A", "lat": 46.0, "lon": -123.0,
                                         "alt": 1234.0, "gate": 9}]


def test_world_omits_a_player_who_never_reported_a_position():
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/race/world2room") as a_ws, \
             c.websocket_connect("/ws/race/world2room") as b_ws:
            _join(a_ws, "A"); _join(b_ws, "B")
            a_ws.send_json({"type": "pos", "lat": 45.0, "lon": -122.0, "gate": 1, "elapsed_ms": 0, "alt": 800.0})
            world = _recv(b_ws, skip=("lobby", "standings", "vote"))
            assert world["type"] == "world"
            assert [p["callsign"] for p in world["players"]] == ["A"]
            # An old client that omits alt is still in the frame, at zero — never missing.
            b_ws.send_json({"type": "pos", "lat": 46.0, "lon": -123.0, "gate": 1, "elapsed_ms": 0})
            appmod.rooms["world2room"].world_last -= appmod.WORLD_MIN_INTERVAL_S + 0.1
            b_ws.send_json({"type": "pos", "lat": 46.0, "lon": -123.0, "gate": 2, "elapsed_ms": 10})
            while True:   # read forward past A's own earlier (solo) world frame
                world = _recv(a_ws, skip=("lobby", "standings", "vote"))
                if len(world["players"]) == 2:
                    break
            assert {p["callsign"]: p["alt"] for p in world["players"]} == {"A": 800.0, "B": 0.0}


def test_the_new_proto_3_frames_validate():
    good = [{"type": "pos", "lat": 1, "lon": 2, "gate": 0, "elapsed_ms": 0, "alt": 1234.5},
            {"type": "box", "id": 7},
            {"type": "fire", "item": "banana", "heading": 271.5},
            {"type": "fx", "item": "shield", "ms": 6000},
            {"type": "fx", "item": "boost", "ms": 0},
            {"type": "tripped", "id": 42}]
    for g in good:
        appmod.parse_message(g)
    bad = [{"type": "box", "id": appmod.MAX_BOXES},        # past the course cap
           {"type": "box", "id": -1},
           {"type": "fire", "item": "banana", "heading": 400},
           {"type": "fx", "item": "missile", "ms": 100},   # fx is cosmetic-only, never offensive
           {"type": "fx", "item": "boost"},                # ms is required
           {"type": "tripped", "id": -1},
           {"type": "tripped"},
           {"type": "pos", "lat": 1, "lon": 2, "gate": 0, "elapsed_ms": 0, "alt": 1e9}]
    for b in bad:
        with pytest.raises(Exception):
            appmod.parse_message(b)


def test_an_old_client_still_gets_a_banana_hit_from_the_server_side_check(monkeypatch):
    """The 2D fallback stays for clients that never send `alt`, and is skipped for ones that do
    — otherwise a proto-3 client would resolve the same banana twice."""
    monkeypatch.setattr(appmod, "BANANA_ARM_MS", 0)
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/race/mixedroom") as new_ws, \
             c.websocket_connect("/ws/race/mixedroom") as old_ws:
            _join(new_ws, "New"); _join(old_ws, "Old")
            new_ws.send_json({"type": "pos", "lat": 45.0, "lon": -122.0, "gate": 1, "elapsed_ms": 0, "alt": 100.0})
            for ws in (new_ws, old_ws):
                _recv(ws)
            room = appmod.rooms["mixedroom"]
            assert room.players["New"].proto3 is True and room.players["Old"].proto3 is False
            room.players["New"].carrying = "banana"
            new_ws.send_json({"type": "fire", "item": "banana"})
            dropped = _recv(old_ws)
            assert dropped["type"] == "dropped"
            _recv(new_ws)

            # The old client flies onto it and is hit by the server's own check, no `tripped`.
            old_ws.send_json({"type": "pos", "lat": dropped["lat"], "lon": dropped["lon"],
                              "gate": 1, "elapsed_ms": 10})
            assert _recv(old_ws)["type"] == "cleared"
            assert _recv(old_ws) == {"type": "hit", "item": "banana", "from": "New", "id": dropped["id"]}


def test_a_proto_3_client_is_not_hit_by_the_server_side_fallback(monkeypatch):
    monkeypatch.setattr(appmod, "BANANA_ARM_MS", 0)
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/race/dupsroom") as a_ws, \
             c.websocket_connect("/ws/race/dupsroom") as b_ws:
            _join(a_ws, "A"); _join(b_ws, "B")
            a_ws.send_json({"type": "pos", "lat": 45.0, "lon": -122.0, "gate": 1, "elapsed_ms": 0, "alt": 100.0})
            for ws in (a_ws, b_ws):
                _recv(ws)
            room = appmod.rooms["dupsroom"]
            room.players["A"].carrying = "banana"
            a_ws.send_json({"type": "fire", "item": "banana"})
            dropped = _recv(b_ws)
            _recv(a_ws)

            # B sits right on it and reports `alt`, so the fallback must not fire: only B's own
            # `tripped` resolves it, exactly once.
            b_ws.send_json({"type": "pos", "lat": dropped["lat"], "lon": dropped["lon"],
                            "gate": 1, "elapsed_ms": 10, "alt": 100.0})
            assert _recv(b_ws)["type"] == "standings"
            assert len(room.bananas) == 1, "the server-side check must not hit a proto-3 client"
            b_ws.send_json({"type": "tripped", "id": dropped["id"]})
            assert _recv(b_ws)["type"] == "cleared"
            assert _recv(b_ws)["type"] == "hit"
            # A second claim for the same (now gone) banana is simply ignored.
            b_ws.send_json({"type": "tripped", "id": dropped["id"]})
            b_ws.send_json({"type": "ping", "t0": 3.0})
            assert _recv(b_ws)["type"] == "pong"


def test_a_target_that_leaves_mid_flight_resolves_as_lost(monkeypatch):
    _fast_flight(monkeypatch, 200)
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/race/lostroom") as back_ws:
            _join(back_ws, "Back")
            with c.websocket_connect("/ws/race/lostroom") as lead_ws:
                _join(lead_ws, "Lead")
                appmod.rooms["lostroom"].players["Lead"].gate = 9
                appmod.rooms["lostroom"].players["Back"].carrying = "missile"
                back_ws.send_json({"type": "fire", "item": "missile"})
                assert _recv(back_ws)["type"] == "fired"
            resolved = _recv(back_ws)
            assert resolved["type"] == "resolved" and resolved["lost"] is True


# ---------------------------------------------------------- ghost traces (0.9.0)

TH = "beef0001"   # a course hash of this file's own, so trace tests never disturb the H board


def make_trace(n=40, step_ms=250, speed_ms=50.0, lat=45.0, lon=-122.0, alt=1000.0, v=1):
    """A well-formed encoded trace: n samples flying north at `speed_ms`, t delta-encoded."""
    dlat = (speed_ms * step_ms / 1000.0) / 111320.0
    return {"v": v, "n": n,
            "t": [0] + [step_ms] * (n - 1),
            "lat": [round(lat + dlat * i, 6) for i in range(n)],
            "lon": [lon] * n,
            "alt": [alt] * n,
            "hdg": [0.0] * n,
            "pitch": [0.0] * n,
            "roll": [0.0] * n}


def trace_run(n=40, step_ms=250, **kw):
    """A run whose time_ms matches the last sample of the trace it carries."""
    last = (n - 1) * step_ms
    enc = kw.pop("trace", make_trace(n=n, step_ms=step_ms))
    return run(course_hash=TH, time_ms=last, splits=[last // 2, last], gates=3,
               length_m=last / 1000.0 * 50.0, trace=enc, **kw)


def test_decode_trace_round_trips_and_rejects_malformed():
    rows = appmod.decode_trace(make_trace(n=5))
    assert len(rows) == 5
    assert [r[0] for r in rows] == [0, 250, 500, 750, 1000], "t is delta-decoded back to absolute"
    bad = {
        "not an object": "nope",
        "unknown version": make_trace(v=2),
        "ragged columns": {**make_trace(n=4), "lat": [45.0, 45.0]},
        "n mismatch": {**make_trace(n=4), "n": 9},
        "too few samples": make_trace(n=1),
        "too many samples": make_trace(n=appmod.MAX_TRACE_SAMPLES + 1),
        "non-finite": {**make_trace(n=4), "alt": [1000.0, float("nan"), 1000.0, 1000.0]},
        "off-world lat": {**make_trace(n=4), "lat": [45.0, 91.0, 45.0, 45.0]},
        "non-increasing t": {**make_trace(n=4), "t": [0, 250, 0, 250]},
        "missing column": {k: v for k, v in make_trace(n=4).items() if k != "roll"},
    }
    for label, enc in bad.items():
        with pytest.raises(ValueError):
            appmod.decode_trace(enc)


def test_validate_trace_checks_finish_time_speed_and_size():
    good = make_trace(n=40)
    blob, reason = appmod.validate_trace(good, 39 * 250)
    assert reason is None and blob, reason

    # Within the 500 ms tolerance either side of the finish, but not beyond it.
    assert appmod.validate_trace(good, 39 * 250 + 400)[1] is None
    assert "tolerance" in appmod.validate_trace(good, 39 * 250 + 900)[1]
    assert "tolerance" in appmod.validate_trace(good, max(1, 39 * 250 - 900))[1]

    # A sample pair implying faster than MAX_SPEED_MS is a teleport, not a flight.
    fast = make_trace(n=4)
    fast["lat"] = [45.0, 45.0, 48.0, 48.1]   # ~330 km in 250 ms
    assert "speed limit" in appmod.validate_trace(fast, 750)[1]

    # Size cap, checked against the exact blob that would be stored.
    big = make_trace(n=2)
    big["lat"] = [45.0 + i * 1e-9 for i in range(2)]
    big["pad"] = "x" * (appmod.MAX_TRACE_BYTES + 10)
    assert "KB" in appmod.validate_trace(big, 250)[1]


def test_post_runs_stores_a_trace_and_serves_it_back_as_a_ghost():
    with TestClient(appmod.app) as c:
        r = c.post("/runs", json=trace_run(callsign="Eric", model="goldfish"))
        assert r.status_code == 200, r.text
        assert r.json()["trace_saved"] is True and r.json()["trace_reason"] is None

        g = c.get("/ghost", params={"course_hash": TH, "callsign": "Eric"}).json()
        assert g["callsign"] == "Eric" and g["model"] == "goldfish"
        assert g["time_ms"] == 39 * 250
        assert appmod.decode_trace(g["trace"]) == appmod.decode_trace(make_trace(n=40)), "byte-identical round trip"

        # No callsign = the course record holder's ghost.
        c.post("/runs", json=trace_run(n=20, callsign="Maggie"))   # faster: 4750 ms
        rec = c.get("/ghost", params={"course_hash": TH}).json()
        assert rec["callsign"] == "Maggie", "the fastest trace on the course is the default ghost"

        assert c.get("/ghost", params={"course_hash": "0000dead"}).status_code == 404
        assert c.get("/ghost", params={"course_hash": TH, "callsign": "Nobody"}).status_code == 404
        assert c.get("/ghost", params={"course_hash": "nope"}).status_code == 422


def test_only_the_best_trace_per_pilot_per_course_is_kept():
    with TestClient(appmod.app) as c:
        c.post("/runs", json=trace_run(n=20, callsign="Tom"))                      # 4750 ms
        slower = c.post("/runs", json=trace_run(n=40, callsign="Tom")).json()      # 9750 ms
        assert slower["trace_saved"] is False and "faster" in slower["trace_reason"]
        assert c.get("/ghost", params={"course_hash": TH, "callsign": "Tom"}).json()["time_ms"] == 19 * 250

        faster = c.post("/runs", json=trace_run(n=10, callsign="Tom")).json()      # 2250 ms
        assert faster["trace_saved"] is True
        assert c.get("/ghost", params={"course_hash": TH, "callsign": "Tom"}).json()["time_ms"] == 9 * 250

        with appmod.connect() as conn:
            n = conn.execute("SELECT COUNT(*) FROM traces WHERE course_hash = ? AND callsign = ?",
                             (TH, "Tom")).fetchone()[0]
        assert n == 1, "one row per (course, callsign), replaced rather than appended"


def test_an_invalid_trace_drops_the_trace_but_keeps_the_run():
    with TestClient(appmod.app) as c:
        payload = trace_run(n=40, callsign="Sara")
        payload["trace"] = {**make_trace(n=40), "t": [0] + [0] * 39}   # not strictly increasing
        r = c.post("/runs", json=payload)
        assert r.status_code == 200, r.text
        assert r.json()["trace_saved"] is False
        assert "increasing" in r.json()["trace_reason"]
        assert r.json()["rank"] >= 1, "the run itself was still recorded"
        board = c.get("/leaderboard", params={"course_hash": TH}).json()
        assert any(b["callsign"] == "Sara" for b in board), "and shows up on the board"
        assert c.get("/ghost", params={"course_hash": TH, "callsign": "Sara"}).status_code == 404

        # Junk in the trace field is the same story: accepted run, dropped trace.
        payload2 = trace_run(n=40, callsign="Ben")
        payload2["trace"] = {"v": 99}
        r2 = c.post("/runs", json=payload2)
        assert r2.status_code == 200 and r2.json()["trace_saved"] is False
        assert "version" in r2.json()["trace_reason"]

        # A trace field that isn't an object at all is a plain schema error, not a 500.
        payload3 = trace_run(n=40, callsign="Ann")
        payload3["trace"] = "not a trace"
        assert c.post("/runs", json=payload3).status_code == 422


def test_a_run_with_no_trace_is_unchanged():
    with TestClient(appmod.app) as c:
        r = c.post("/runs", json=run(course_hash=TH, callsign="Nina"))
        assert r.status_code == 200 and r.json()["trace_saved"] is False and r.json()["trace_reason"] is None


def test_leaderboard_rows_report_has_ghost():
    with TestClient(appmod.app) as c:
        c.post("/runs", json=trace_run(n=20, callsign="Ghosty"))
        c.post("/runs", json=run(course_hash=TH, callsign="Plain"))
        board = {b["callsign"]: b["has_ghost"] for b in c.get("/leaderboard", params={"course_hash": TH}).json()}
        assert board["Ghosty"] is True
        assert board["Plain"] is False
        old = {b["callsign"]: b["has_ghost"] for b in c.get("/leaderboard", params={"course_hash": H}).json()}
        assert old and all(v is False for v in old.values()), "a board with no traces reports has_ghost false"


def test_migration_is_idempotent_and_leaves_existing_rows_alone():
    with appmod.connect() as conn:
        before = conn.execute("SELECT COUNT(*), COALESCE(SUM(time_ms), 0) FROM runs").fetchone()
        rows_before = conn.execute("SELECT id, callsign, time_ms FROM runs ORDER BY id").fetchall()
        traces_before = conn.execute("SELECT COUNT(*) FROM traces").fetchone()[0]
        # Re-running the whole schema script is exactly what a container restart does.
        conn.executescript(appmod.SCHEMA)
        conn.executescript(appmod.SCHEMA)
        after = conn.execute("SELECT COUNT(*), COALESCE(SUM(time_ms), 0) FROM runs").fetchone()
        rows_after = conn.execute("SELECT id, callsign, time_ms FROM runs ORDER BY id").fetchall()
        assert tuple(before) == tuple(after)
        assert [tuple(r) for r in rows_before] == [tuple(r) for r in rows_after]
        assert conn.execute("SELECT COUNT(*) FROM traces").fetchone()[0] == traces_before


def test_gzip_middleware_is_installed_and_compresses_a_ghost():
    with TestClient(appmod.app) as c:
        c.post("/runs", json=trace_run(n=2000, step_ms=250, callsign="Zip"))
        r = c.get("/ghost", params={"course_hash": TH, "callsign": "Zip"},
                  headers={"accept-encoding": "gzip"})
        assert r.status_code == 200, r.text
        assert r.headers.get("content-encoding") == "gzip"
        assert len(appmod.decode_trace(r.json()["trace"])) == 2000


# ---------------------------------------------------- ghost list and news (0.12.0)
# "Race a friend's ghost": /ghosts is the picker's index over the same `traces` table /ghost
# already reads (no new table, no migration), and /news is the in-game replacement for a Teams
# webhook — read-only over `runs`, the same table POST /runs already writes.

TH2 = "beef0002"
TH3 = "beef0003"
SINCE = 1_700_000_000   # an arbitrary fixed epoch so tests never race real wall-clock time


def ghost_run(course_hash, callsign, n=20, step_ms=250, **kw):
    last = (n - 1) * step_ms
    return run(course_hash=course_hash, callsign=callsign, time_ms=last,
               splits=[last // 2, last], gates=3, length_m=last / 1000.0 * 50.0,
               trace=make_trace(n=n, step_ms=step_ms), **kw)


def _set_created_at(course_hash, callsign, ts):
    with appmod.connect() as conn:
        conn.execute("UPDATE runs SET created_at = ? WHERE course_hash = ? AND callsign = ?",
                     (ts, course_hash, callsign))


def test_ghosts_list_sorts_by_time_and_flags_the_record():
    with TestClient(appmod.app) as c:
        assert c.get("/ghosts", params={"course_hash": TH2}).json() == []
        c.post("/runs", json=ghost_run(TH2, "Slow", n=40))    # 9750 ms
        c.post("/runs", json=ghost_run(TH2, "Fast", n=10))    # 2250 ms
        c.post("/runs", json=ghost_run(TH2, "Mid", n=20))     # 4750 ms
        rows = c.get("/ghosts", params={"course_hash": TH2}).json()
        assert [r["callsign"] for r in rows] == ["Fast", "Mid", "Slow"], rows
        assert [r["is_course_record"] for r in rows] == [True, False, False]
        assert rows[0]["model"] == "" and "recorded_at" in rows[0]
        assert c.get("/ghosts", params={"course_hash": "nope"}).status_code == 422


def test_news_reports_a_beat_after_since_and_nothing_before_it():
    # A callsign of its own: /news scans every course a pilot has ANY time on, so reusing "Eric"
    # (posted on many courses by other tests in this file, always with a real, later created_at)
    # would pick up unrelated beats too.
    with TestClient(appmod.app) as c:
        c.post("/runs", json=run(course_hash=TH3, callsign="NewsBeat", time_ms=20000, splits=[10000, 20000]))
        _set_created_at(TH3, "NewsBeat", SINCE - 1000)
        assert c.get("/news", params={"callsign": "NewsBeat", "since": SINCE}).json() == [], "no beat posted yet"

        c.post("/runs", json=run(course_hash=TH3, callsign="Dave", time_ms=19590, splits=[9500, 19590]))
        _set_created_at(TH3, "Dave", SINCE + 10)

        news = c.get("/news", params={"callsign": "NewsBeat", "since": SINCE}).json()
        assert len(news) == 1, news
        item = news[0]
        assert item["course_hash"] == TH3 and item["beaten_by"] == "Dave"
        assert item["their_time_ms"] == 19590 and item["your_time_ms"] == 20000
        assert item["margin_ms"] == 410 and item["at"] == SINCE + 10
        assert "course_id" in item and "course_name" in item

        # A `since` exactly at the beat's own timestamp does not count it as "after".
        assert c.get("/news", params={"callsign": "NewsBeat", "since": SINCE + 10}).json() == []

        # A run slower than NewsBeat's best, posted after `since`, is not news.
        c.post("/runs", json=run(course_hash=TH3, callsign="Slower", time_ms=25000, splits=[12000, 25000]))
        _set_created_at(TH3, "Slower", SINCE + 20)
        news2 = c.get("/news", params={"callsign": "NewsBeat", "since": SINCE}).json()
        assert len(news2) == 1 and news2[0]["beaten_by"] == "Dave"

        assert c.get("/news", params={"callsign": "Nobody", "since": 0}).json() == [], "no runs at all is not an error"


def test_news_reports_only_the_fastest_beat_per_course():
    # A callsign of its own — /news scans every course a pilot has a time on, so reusing "Eric"
    # here would also pick up the beat test_news_reports_a_beat_after_since_and_nothing_before_it
    # already recorded for them on TH3.
    with TestClient(appmod.app) as c:
        c.post("/runs", json=run(course_hash="beef0004", callsign="NewsFastest", time_ms=20000, splits=[10000, 20000]))
        _set_created_at("beef0004", "NewsFastest", SINCE - 1000)
        c.post("/runs", json=run(course_hash="beef0004", callsign="Dave", time_ms=19000, splits=[9000, 19000]))
        _set_created_at("beef0004", "Dave", SINCE + 10)
        c.post("/runs", json=run(course_hash="beef0004", callsign="Maggie", time_ms=15000, splits=[7000, 15000]))
        _set_created_at("beef0004", "Maggie", SINCE + 20)
        news = c.get("/news", params={"callsign": "NewsFastest", "since": SINCE}).json()
        assert len(news) == 1 and news[0]["beaten_by"] == "Maggie" and news[0]["their_time_ms"] == 15000, \
            "only the fastest beat is reported, not every run that undercut the old best"


def test_news_sorted_newest_first_across_courses():
    with TestClient(appmod.app) as c:
        c.post("/runs", json=run(course_hash="beef0005", callsign="NewsSorted", time_ms=20000, splits=[10000, 20000]))
        _set_created_at("beef0005", "NewsSorted", SINCE - 1000)
        c.post("/runs", json=run(course_hash="beef0006", callsign="NewsSorted", time_ms=20000, splits=[10000, 20000]))
        _set_created_at("beef0006", "NewsSorted", SINCE - 1000)
        c.post("/runs", json=run(course_hash="beef0005", callsign="Dave", time_ms=19000, splits=[9000, 19000]))
        _set_created_at("beef0005", "Dave", SINCE + 10)
        c.post("/runs", json=run(course_hash="beef0006", callsign="Dave", time_ms=19000, splits=[9000, 19000]))
        _set_created_at("beef0006", "Dave", SINCE + 20)
        news = c.get("/news", params={"callsign": "NewsSorted", "since": SINCE}).json()
        assert len(news) == 2
        assert news[0]["at"] == SINCE + 20 and news[1]["at"] == SINCE + 10


def test_standings_positions_are_additive_and_only_ever_a_client_s_own_pos():
    """The minimap's other-racer dots. Every entry comes from that player's OWN pos frames, and a
    player who has not sent one is absent rather than present with nulls."""
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/race/posroom") as a_ws, \
             c.websocket_connect("/ws/race/posroom") as b_ws:
            a_ws.send_json({"type": "join", "callsign": "A"})
            assert _recv(a_ws)["type"] == "joined"
            b_ws.send_json({"type": "join", "callsign": "B"})
            assert _recv(b_ws)["type"] == "joined"

            # Only A has reported a position, so only A is on the map.
            a_ws.send_json({"type": "pos", "lat": 45.5, "lon": -122.5, "gate": 2, "elapsed_ms": 900})
            for ws in (a_ws, b_ws):
                frame = _recv(ws)
                assert frame["positions"] == {"A": [45.5, -122.5]}, frame
                assert "B" not in frame["positions"], "a player who never sent pos is absent, not null"

            b_ws.send_json({"type": "pos", "lat": 46.0, "lon": -123.0, "gate": 1, "elapsed_ms": 500})
            for ws in (a_ws, b_ws):
                frame = _recv(ws)
                assert frame["positions"] == {"A": [45.5, -122.5], "B": [46.0, -123.0]}, frame

            # B moving only ever changes B's entry — nothing in the protocol lets one client
            # assert another's position.
            b_ws.send_json({"type": "pos", "lat": 47.0, "lon": -124.0, "gate": 1, "elapsed_ms": 700})
            for ws in (a_ws, b_ws):
                frame = _recv(ws)
                assert frame["positions"]["A"] == [45.5, -122.5]
                assert frame["positions"]["B"] == [47.0, -124.0]


# ====================================================================================
# Results and cups (proto 4, 0.11.0). The pure half first — points, the finish-time window, every
# award — with plain numbers and no sockets; then the relay half: how a race ends, what a finish
# has to satisfy, what gets tallied, how a cup accumulates, and what reaches SQLite.
# ====================================================================================
import contextlib, json, threading


def _racer(cs, status=None, ms=None, seq=0, gate=0, elapsed=0, model=""):
    r = appmod.Racer(cs, model)
    r.status, r.go_time_ms, r.seq, r.gate, r.elapsed_ms = status, ms, seq, gate, elapsed
    return r


def _row(cs, pos, status="finished", **kw):
    """A result row as build_rows() returns it, with everything an award reads defaulted to 'nothing
    happened', so each award test states only the data that makes it qualify."""
    base = dict(pos=pos, callsign=cs, model="", status=status, points=appmod.points_for(pos, status),
                go_time_ms=60000 + pos * 1000 if status == "finished" else None, gap_ms=None,
                items_used={}, hits_taken=0, jump_start=False, gate=None,
                hits_blocked=0, hits_landed=0, worst_rank=None, best_sector_ms=None)
    base.update(kw)
    return base


def _award(awards, key):
    return [a for a in awards if a["key"] == key]


def test_points_are_15_12_10_8_6_4_2_1_and_a_dnf_scores_nothing():
    assert [appmod.points_for(p, "finished") for p in range(1, 9)] == [15, 12, 10, 8, 6, 4, 2, 1]
    assert appmod.points_for(9, "finished") == 0, "finishing outside the table scores nothing"
    assert appmod.points_for(1, "dnf") == 0 and appmod.points_for(3, "dnf") == 0
    assert appmod.points_for(0, "finished") == 0 and appmod.points_for(-1, "finished") == 0


def test_a_finish_time_must_agree_with_the_relays_clock_within_three_seconds():
    start = 1_000_000
    now = start + 60_000
    assert appmod.finish_time_ok(60_000, now, start)
    assert appmod.finish_time_ok(60_000 + 3000, now, start), "exactly on the edge is inside"
    assert appmod.finish_time_ok(60_000 - 3000, now, start)
    assert not appmod.finish_time_ok(60_000 + 3001, now, start)
    assert not appmod.finish_time_ok(60_000 - 3001, now, start), "nobody finishes a minute in much faster than a minute"
    # A jump-starter's clock carries the 5 s penalty, so the window moves LATER by that much...
    assert appmod.finish_time_ok(65_000, now, start, jump_start=True)
    assert not appmod.finish_time_ok(60_000, now, start, jump_start=True)
    # ...which means claiming a jump start can never buy a faster time than an honest finish would.
    assert not appmod.finish_time_ok(60_000 - 3001, now, start, jump_start=True)
    assert not appmod.finish_time_ok(65_000, now, start, jump_start=False)


def test_best_sector_is_derived_from_the_splits_and_the_claim_is_only_a_fallback():
    assert appmod.best_sector_from([8000, 15000, 30000]) == 7000, "first leg is splits[0]"
    assert appmod.best_sector_from([4000, 15000]) == 4000
    assert appmod.best_sector_from([], 5000) == 5000, "no splits: take the client's word for its own leg"
    assert appmod.best_sector_from([], None) is None and appmod.best_sector_from([], 0) is None
    assert appmod.best_sector_from([9000, 9000, 20000], 1) == 9000, "a lying claim never beats the splits"


def test_rows_order_finishers_by_time_then_dnfs_by_progress():
    racers = [_racer("Slow", "finished", 70000, 1), _racer("Quit", "dnf", gate=2),
              _racer("Fast", "finished", 60000, 2), _racer("Far", "dnf", gate=5),
              _racer("Tie1", "finished", 65000, 3), _racer("Tie2", "finished", 65000, 4)]
    rows = appmod.build_rows(racers)
    assert [r["callsign"] for r in rows] == ["Fast", "Tie1", "Tie2", "Slow", "Far", "Quit"]
    assert [r["pos"] for r in rows] == [1, 2, 3, 4, 5, 6]
    assert [r["gap_ms"] for r in rows] == [0, 5000, 5000, 10000, None, None]
    assert [r["points"] for r in rows] == [15, 12, 10, 8, 0, 0]
    assert rows[4]["go_time_ms"] is None and rows[4]["gate"] == 5 and rows[0]["gate"] is None
    # An exact tie goes to whoever's finish the relay accepted first, and both still get a place.
    assert rows[1]["callsign"] == "Tie1"


def test_public_rows_carry_the_documented_fields_and_none_of_the_award_inputs():
    row = appmod.public_row(appmod.build_rows([_racer("A", "finished", 60000, 1)])[0])
    assert set(row) == {"pos", "callsign", "model", "go_time_ms", "gap_ms", "status", "points",
                        "items_used", "hits_taken", "jump_start", "gate"}


def test_award_most_hits_taken():
    rows = [_row("A", 1, hits_taken=1), _row("B", 2, hits_taken=3), _row("C", 3, hits_taken=3)]
    got = _award(appmod.compute_awards(rows), "most_hits_taken")
    assert got == [{"key": "most_hits_taken", "callsign": "B", "detail": "3 hits"}], "a tie goes to the better-placed pilot"
    assert _award(appmod.compute_awards([_row("A", 1, hits_taken=1)]), "most_hits_taken")[0]["detail"] == "1 hit"
    assert not _award(appmod.compute_awards([_row("A", 1), _row("B", 2)]), "most_hits_taken"), "nobody hit: no award"


def test_award_sharpshooter_counts_only_items_that_landed():
    rows = [_row("A", 1, hits_landed=1), _row("B", 2, hits_landed=2, items_used={"missile": 5}), _row("C", 3)]
    assert _award(appmod.compute_awards(rows), "sharpshooter") == [
        {"key": "sharpshooter", "callsign": "B", "detail": "2 hits landed"}]
    # Firing a lot is not the same thing: five missiles and no hits is no award.
    assert not _award(appmod.compute_awards([_row("A", 1, items_used={"missile": 5})]), "sharpshooter")


def test_award_biggest_comeback_needs_two_places_and_a_finish():
    rows = [_row("A", 1, worst_rank=2), _row("B", 2, worst_rank=5), _row("C", 3, worst_rank=4)]
    assert _award(appmod.compute_awards(rows), "biggest_comeback") == [
        {"key": "biggest_comeback", "callsign": "B", "detail": "5th to 2nd"}]
    # One place is not a comeback, and neither is a DNF however far back it had been.
    assert not _award(appmod.compute_awards([_row("A", 1, worst_rank=2), _row("B", 2, worst_rank=2)]), "biggest_comeback")
    assert not _award(appmod.compute_awards([_row("A", 1, worst_rank=1), _row("B", 2, "dnf", worst_rank=8)]), "biggest_comeback")
    assert _award(appmod.compute_awards([_row("A", 1, worst_rank=3)]), "biggest_comeback")[0]["detail"] == "3rd to 1st"
    assert appmod._ordinal(11) == "11th" and appmod._ordinal(12) == "12th" and appmod._ordinal(22) == "22nd"


def test_award_fastest_sector_skips_pilots_with_no_sector_data():
    rows = [_row("A", 1, best_sector_ms=9210), _row("B", 2, best_sector_ms=7305), _row("C", 3)]
    assert _award(appmod.compute_awards(rows), "fastest_sector") == [
        {"key": "fastest_sector", "callsign": "B", "detail": "7.305 s"}]
    assert not _award(appmod.compute_awards([_row("A", 1), _row("B", 2)]), "fastest_sector")


def test_award_clean_race_only_means_something_when_somebody_was_hit():
    rows = [_row("A", 1), _row("B", 2, hits_taken=2), _row("C", 3), _row("D", 4, "dnf")]
    clean = _award(appmod.compute_awards(rows), "clean_race")
    assert [a["callsign"] for a in clean] == ["A", "C"], "every clean FINISHER, and not the DNF"
    assert clean[0]["detail"] == "no hits taken"
    assert not _award(appmod.compute_awards([_row("A", 1), _row("B", 2)]), "clean_race"), \
        "a race nobody was hit in would hand it to everyone, which says nothing"


def test_award_jump_starter_goes_to_every_jump_starter():
    rows = [_row("A", 1), _row("B", 2, jump_start=True), _row("C", 3, jump_start=True)]
    got = _award(appmod.compute_awards(rows), "jump_starter")
    assert [(a["callsign"], a["detail"]) for a in got] == [("B", "+5 s"), ("C", "+5 s")]
    assert not _award(appmod.compute_awards([_row("A", 1)]), "jump_starter")


def test_awards_with_nothing_to_say_produce_an_empty_list():
    assert appmod.compute_awards([]) == []
    assert appmod.compute_awards([_row("A", 1), _row("B", 2), _row("C", 3, "dnf")]) == []


def test_cup_standings_sort_by_points_then_name():
    assert appmod.cup_standings({"Zed": 12, "Amy": 12, "Bob": 27, "Cy": 0}) == [
        {"callsign": "Bob", "points": 27}, {"callsign": "Amy", "points": 12},
        {"callsign": "Zed", "points": 12}, {"callsign": "Cy", "points": 0}]


def test_results_frames_validate():
    fin = appmod.parse_message({"type": "finish", "race_id": 1, "go_time_ms": 61234,
                                "splits": [8000, 20000, 61234], "best_sector_ms": 8000, "jump_start": True})
    assert fin.go_time_ms == 61234 and fin.jump_start is True and fin.splits == [8000, 20000, 61234]
    bare = appmod.parse_message({"type": "finish", "race_id": 1, "go_time_ms": 61234})
    assert bare.splits == [] and bare.best_sector_ms is None and bare.jump_start is False
    assert appmod.parse_message({"type": "dnf", "race_id": 2, "gate": 4}).gate == 4
    assert appmod.parse_message({"type": "cup", "name": "  Friday  ", "race_count": 4}).name == "Friday"
    assert appmod.parse_message({"type": "rematch"}).type == "rematch"
    for bad in [{"type": "finish", "race_id": 1, "go_time_ms": 0},
                {"type": "finish", "race_id": -1, "go_time_ms": 5},
                {"type": "finish", "race_id": 1, "go_time_ms": 7 * 3600 * 1000},
                {"type": "finish", "race_id": 1, "go_time_ms": 5, "splits": [9, 3]},
                {"type": "finish", "race_id": 1, "go_time_ms": 5, "splits": [1] * 201},
                {"type": "finish", "race_id": 1},
                {"type": "dnf", "race_id": 1, "gate": 202}, {"type": "dnf", "race_id": 1},
                {"type": "cup", "name": "", "race_count": 3}, {"type": "cup", "name": "   ", "race_count": 3},
                {"type": "cup", "name": "x" * 33, "race_count": 3},
                {"type": "cup", "name": "ok", "race_count": 0}, {"type": "cup", "name": "ok", "race_count": 13}]:
        with pytest.raises(Exception):
            appmod.parse_message(bad)


def test_a_finish_with_every_split_a_200_gate_course_can_have_still_fits_one_frame():
    # The reason the client drops `splits` when it would not fit: this is the largest legal one.
    frame = {"type": "finish", "race_id": 99, "go_time_ms": 21_600_000, "splits": [21_600_000] * 200,
             "best_sector_ms": 21_600_000, "jump_start": True}
    assert len(json.dumps(frame, separators=(",", ":")).encode()) < appmod.MAX_WS_MSG_BYTES


# ---- the relay half. These drive real sockets, so a few helpers keep each test about the rule it
# checks rather than about getting a room into the racing phase.

@contextlib.contextmanager
def _pilots(c, room, names):
    """One socket per name, all joined to `room`; the first joiner is host."""
    with contextlib.ExitStack() as stack:
        wss = {}
        for n in names:
            ws = stack.enter_context(c.websocket_connect(f"/ws/race/{room}"))
            _join(ws, n)
            wss[n] = ws
        yield wss


def _drain(ws):
    """Every frame queued for this socket up to a ping/pong round trip. The relay handles one
    socket's frames in order, so whatever it sent in reply to earlier frames is ahead of the pong —
    and unlike a bare receive this cannot hang on a frame that is never coming."""
    ws.send_json({"type": "ping", "t0": 42.5})
    frames = []
    while True:
        m = ws.receive_json()
        if m["type"] == "pong" and m["t0"] == 42.5:
            return frames
        frames.append(m)


def _of(frames, type_):
    return [f for f in frames if f["type"] == type_]


def _go(name, ago_ms=30_000):
    """Skip the 5 s countdown: the room is racing and GO was `ago_ms` ago on the relay's clock."""
    rm = appmod.rooms[name]
    rm.race.start_at_ms = appmod.server_ms() - ago_ms
    rm.phase = "racing"


def _start_race(name, wss, ready=None, go=True):
    """The host sets a course and starts it. Everyone is ready unless `ready` names who is (then
    it is a force start and the rest spectate)."""
    rm = appmod.rooms[name]
    host = next(iter(wss.values()))
    if rm.course is None:       # a later race in the same room keeps its course (and needs no re-ready dance)
        host.send_json(_course())
        assert _wait_until(lambda: rm.course is not None)
    who = list(wss) if ready is None else ready
    for n in who:
        wss[n].send_json({"type": "ready", "ready": True})
    assert _wait_until(lambda: all(rm.players[n].ready for n in who))
    host.send_json({"type": "start", "lead_s": 5, "force": ready is not None})
    assert _wait_until(lambda: rm.phase == "countdown" and rm.race is not None)
    if go:
        _go(name)


def _finish(name, ws, offset=0, **kw):
    """A finish whose time is what the relay's own clock says, plus `offset` (the tolerance is
    +-3000, and offsets are how a test decides who wins)."""
    rm = appmod.rooms[name]
    go = appmod.server_ms() - rm.race.start_at_ms + offset
    ws.send_json({"type": "finish", "race_id": rm.race_id, "go_time_ms": go, **kw})
    return go


def _dnf(name, ws, gate=2):
    ws.send_json({"type": "dnf", "race_id": appmod.rooms[name].race_id, "gate": gate})


def _run_race(name, wss, order, out=()):
    """Everyone in `order` finishes (first = winner, a second apart); everyone in `out` DNFs."""
    for i, n in enumerate(order):
        _finish(name, wss[n], offset=-2500 + i * 1000)
    for n in out:
        _dnf(name, wss[n])
    rm = appmod.rooms[name]
    assert _wait_until(lambda: rm.phase == "results", 3.0), "the race never ended"


def _results_of(ws):
    got = _of(_drain(ws), "results")
    assert got, "no results frame reached this socket"
    return got[-1]


def test_a_race_ends_when_every_racer_has_finished_and_everyone_gets_the_results():
    with TestClient(appmod.app) as c, _pilots(c, "endroom", ["A", "B", "C"]) as w:
        _start_race("endroom", w)
        rm = appmod.rooms["endroom"]
        # Each finish goes out on its own socket, so wait for the relay to take one before the next:
        # neither the order they are handled in nor draining C orders against another socket.
        _finish("endroom", w["B"], offset=-2000)
        assert _wait_until(lambda: rm.race.racers["B"].status == "finished")
        _finish("endroom", w["A"], offset=-1000)
        assert _wait_until(lambda: rm.race.racers["A"].status == "finished")
        frames = _drain(w["C"])
        assert rm.phase == "racing", "one racer is still out there, so it is not over"
        # Each finish tells the room who is still being waited for, and until when.
        prog = _of(frames, "results_progress")
        assert [f["waiting"] for f in prog] == [["A", "C"], ["C"]]
        assert [r["callsign"] for r in prog[-1]["rows"]] == ["B", "A"]
        assert [r["points"] for r in prog[-1]["rows"]] == [15, 12], "a finisher's points are already final"
        assert prog[-1]["race_id"] == rm.race_id
        assert prog[-1]["deadline_server_ms"] - rm.race.first_finish_ms == appmod.RESULTS_TIMEOUT_S * 1000

        _finish("endroom", w["C"], offset=0)
        assert _wait_until(lambda: rm.phase == "results", 3.0)
        for ws in w.values():
            frames = _drain(ws)
            res = _of(frames, "results")[-1]
            assert res["race_id"] == rm.race_id and res["cup"] is None
            assert res["course"] == {"course_id": "starter-sprint-seatac", "course_hash": "0a1b2c3d",
                                     "name": "Starter Sprint", "start_type": "air", "gates": None}
            assert [(r["pos"], r["callsign"], r["status"], r["points"]) for r in res["rows"]] == [
                (1, "B", "finished", 15), (2, "A", "finished", 12), (3, "C", "finished", 10)]
            assert res["rows"][0]["gap_ms"] == 0 and 900 < res["rows"][1]["gap_ms"] < 1200
            assert _of(frames, "lobby")[-1]["phase"] == "results", "the room's phase moved to results"
        assert rm.race.timer is None, "the deadline is cancelled once the race ends"


def test_a_dnf_frame_takes_a_racer_out_and_the_last_finisher_ends_the_race():
    with TestClient(appmod.app) as c, _pilots(c, "dnfroom", ["A", "B"]) as w:
        _start_race("dnfroom", w)
        rm = appmod.rooms["dnfroom"]
        _dnf("dnfroom", w["B"], gate=3)
        assert _wait_until(lambda: rm.race.racers["B"].status == "dnf")
        assert rm.phase == "racing", "A is still flying"
        _finish("dnfroom", w["A"])
        assert _wait_until(lambda: rm.phase == "results", 3.0)
        res = _results_of(w["A"])
        assert [(r["callsign"], r["status"], r["points"], r["go_time_ms"], r["gap_ms"]) for r in res["rows"]] == [
            ("A", "finished", 15, res["rows"][0]["go_time_ms"], 0), ("B", "dnf", 0, None, None)]
        assert res["rows"][1]["gate"] == 3 and res["rows"][1]["pos"] == 2


def test_a_racer_who_disconnects_is_dnf_at_their_last_gate_and_can_end_the_race():
    with TestClient(appmod.app) as c, _pilots(c, "dcroom", ["A", "B"]) as w:
        _start_race("dcroom", w)
        rm = appmod.rooms["dcroom"]
        w["B"].send_json({"type": "pos", "lat": 45.0, "lon": -122.0, "gate": 4, "elapsed_ms": 20000})
        _drain(w["B"])
        _finish("dcroom", w["A"])
        _drain(w["A"])
        assert rm.phase == "racing"
        w["B"].close()
        assert _wait_until(lambda: rm.phase == "results", 3.0), "B leaving was the last thing the race waited on"
        res = _results_of(w["A"])
        b = [r for r in res["rows"] if r["callsign"] == "B"][0]
        assert b["status"] == "dnf" and b["gate"] == 4 and b["points"] == 0


def test_a_finisher_who_disconnects_keeps_their_finish():
    with TestClient(appmod.app) as c, _pilots(c, "keeproom", ["A", "B", "C"]) as w:
        _start_race("keeproom", w)
        rm = appmod.rooms["keeproom"]
        _finish("keeproom", w["B"], offset=-2000)
        _drain(w["B"])
        w["B"].close()
        assert _wait_until(lambda: "B" not in rm.players)
        assert rm.phase == "racing", "A and C are still racing"
        _finish("keeproom", w["A"], offset=-500)
        _finish("keeproom", w["C"], offset=500)
        assert _wait_until(lambda: rm.phase == "results", 3.0)
        res = _results_of(w["A"])
        assert [(r["callsign"], r["status"]) for r in res["rows"]] == [("B", "finished"), ("A", "finished"), ("C", "finished")]


def test_the_deadline_after_the_first_finisher_turns_stragglers_into_dnfs(monkeypatch):
    monkeypatch.setattr(appmod, "RESULTS_TIMEOUT_S", 0.4)
    with TestClient(appmod.app) as c, _pilots(c, "timeoutroom", ["A", "B", "C"]) as w:
        _start_race("timeoutroom", w)
        rm = appmod.rooms["timeoutroom"]
        w["B"].send_json({"type": "pos", "lat": 45.0, "lon": -122.0, "gate": 2, "elapsed_ms": 9000})
        _drain(w["B"])
        assert rm.race.timer is None, "the clock does not start until somebody finishes"
        _finish("timeoutroom", w["A"])
        _drain(w["A"])
        assert rm.race.timer is not None
        assert rm.phase == "racing"
        assert _wait_until(lambda: rm.phase == "results", 3.0), "the deadline should have ended it"
        res = _results_of(w["A"])
        rows = {r["callsign"]: r for r in res["rows"]}
        assert rows["A"]["status"] == "finished" and rows["A"]["pos"] == 1
        assert rows["B"]["status"] == "dnf" and rows["B"]["gate"] == 2, "out at the last gate it reported"
        assert rows["C"]["status"] == "dnf" and rows["C"]["gate"] == 0, "never reported: out at gate 0"
        assert rows["B"]["pos"] < rows["C"]["pos"], "further along ranks higher among the DNFs"
        assert rows["B"]["points"] == rows["C"]["points"] == 0


def test_spectators_do_not_hold_a_race_open():
    with TestClient(appmod.app) as c, _pilots(c, "specroom", ["A", "B", "S"]) as w:
        _start_race("specroom", w, ready=["A", "B"])
        rm = appmod.rooms["specroom"]
        assert rm.players["S"].role == "spectator" and set(rm.race.racers) == {"A", "B"}
        _run_race("specroom", w, ["A", "B"])
        res = _results_of(w["S"])       # the spectator watches the results too
        assert [r["callsign"] for r in res["rows"]] == ["A", "B"]


def test_a_finish_is_refused_unless_it_is_a_racers_first_believable_finish_in_this_race():
    def refusal(ws):
        errs = [f for f in _drain(ws) if f["type"] == "error"]
        assert len(errs) == 1, errs
        return errs[0]["detail"]

    with TestClient(appmod.app) as c, _pilots(c, "refuseroom", ["A", "B", "S"]) as w:
        rm = appmod.rooms["refuseroom"]
        # No race at all yet.
        w["A"].send_json({"type": "finish", "race_id": 0, "go_time_ms": 5000})
        assert refusal(w["A"]) == "finish rejected: no race in progress"

        _start_race("refuseroom", w, ready=["A", "B"], go=False)
        # Started but still counting down (GO is in the future, so a real time cannot be sent yet).
        w["A"].send_json({"type": "finish", "race_id": rm.race_id, "go_time_ms": 5000})
        assert refusal(w["A"]) == "finish rejected: the race has not started"
        _go("refuseroom")

        # A spectator is not in this race.
        _finish("refuseroom", w["S"])
        assert refusal(w["S"]) == "finish rejected: not a racer in this race"
        # Somebody else's race id.
        w["A"].send_json({"type": "finish", "race_id": rm.race_id + 1, "go_time_ms": 30000})
        assert refusal(w["A"]) == "finish rejected: wrong race"
        # A time the relay's own clock disagrees with, in both directions.
        _finish("refuseroom", w["A"], offset=+3600)
        assert refusal(w["A"]) == "finish rejected: time does not match the relay's clock"
        _finish("refuseroom", w["A"], offset=-3600)
        assert refusal(w["A"]) == "finish rejected: time does not match the relay's clock"
        # And a jump-start flag does not move the window earlier.
        _finish("refuseroom", w["A"], offset=-3600, jump_start=True)
        assert refusal(w["A"]) == "finish rejected: time does not match the relay's clock"
        assert rm.race.racers["A"].status is None, "none of that changed anything"

        # The honest one is accepted, and only once.
        _finish("refuseroom", w["A"])
        assert _wait_until(lambda: rm.race.racers["A"].status == "finished")
        first_time = rm.race.racers["A"].go_time_ms
        _finish("refuseroom", w["A"], offset=-1000)
        assert refusal(w["A"]) == "finish rejected: already finished or out"
        assert rm.race.racers["A"].go_time_ms == first_time, "a second finish does not replace the first"

        # A racer who is out cannot come back by finishing...
        _dnf("refuseroom", w["B"])
        assert _wait_until(lambda: rm.phase == "results", 3.0)
        # ...and once the race is over nobody can finish it, or DNF out of it.
        _finish("refuseroom", w["B"])
        assert refusal(w["B"]) == "finish rejected: the race is over"
        _dnf("refuseroom", w["B"])
        assert refusal(w["B"]) == "dnf rejected: the race is over"


def test_a_racer_who_is_out_cannot_finish_and_a_jump_starters_penalty_is_expected():
    with TestClient(appmod.app) as c, _pilots(c, "jsroom", ["A", "B", "C"]) as w:
        _start_race("jsroom", w)
        rm = appmod.rooms["jsroom"]
        _dnf("jsroom", w["B"])
        assert _wait_until(lambda: rm.race.racers["B"].status == "dnf")
        _finish("jsroom", w["B"])
        errs = [f for f in _drain(w["B"]) if f["type"] == "error"]
        assert errs and errs[0]["detail"] == "finish rejected: already finished or out"
        assert rm.race.racers["B"].status == "dnf"
        # A jump-starter's clock has the penalty in it: +5 s over what the relay measured.
        _finish("jsroom", w["A"], offset=appmod.JUMP_START_PENALTY_MS, jump_start=True)
        assert _wait_until(lambda: rm.race.racers["A"].status == "finished")
        assert rm.race.racers["A"].jump_start is True


def test_an_exact_tie_goes_to_whichever_finish_the_relay_took_first():
    with TestClient(appmod.app) as c, _pilots(c, "tieroom", ["A", "B"]) as w:
        _start_race("tieroom", w)
        rm = appmod.rooms["tieroom"]
        rid = rm.race_id
        w["B"].send_json({"type": "finish", "race_id": rid, "go_time_ms": 30_000})
        assert _wait_until(lambda: rm.race.racers["B"].status == "finished")
        w["A"].send_json({"type": "finish", "race_id": rid, "go_time_ms": 30_000})
        assert _wait_until(lambda: rm.phase == "results", 3.0)
        res = _results_of(w["A"])
        assert [(r["callsign"], r["points"]) for r in res["rows"]] == [("B", 15), ("A", 12)]
        assert [r["gap_ms"] for r in res["rows"]] == [0, 0]


def test_a_start_with_nobody_racing_has_no_race_to_score():
    with TestClient(appmod.app) as c, _pilots(c, "emptyroom", ["A"]) as w:
        w["A"].send_json(_course())
        assert _wait_until(lambda: appmod.rooms["emptyroom"].course is not None)
        w["A"].send_json({"type": "start", "lead_s": 5, "force": True})   # A is not ready: A spectates
        assert _wait_until(lambda: appmod.rooms["emptyroom"].phase == "countdown")
        assert appmod.rooms["emptyroom"].race is None


def test_the_relay_tallies_items_hits_and_rank_from_frames_it_already_sees(monkeypatch):
    _fast_flight(monkeypatch, 60)
    with TestClient(appmod.app) as c, _pilots(c, "tallyroom", ["A", "B"]) as w:
        _start_race("tallyroom", w)
        rm = appmod.rooms["tallyroom"]
        racers = rm.race.racers

        # A leads, B is behind: B's worst place so far is 2nd and A's is 1st.
        w["A"].send_json({"type": "pos", "lat": 45.0, "lon": -122.0, "gate": 3, "elapsed_ms": 5000, "alt": 900.0})
        w["B"].send_json({"type": "pos", "lat": 45.0, "lon": -122.01, "gate": 1, "elapsed_ms": 4000, "alt": 880.0})
        _drain(w["A"]); _drain(w["B"])
        assert racers["A"].worst_rank == 1 and racers["B"].worst_rank == 2

        # B fires a missile at A and it lands: one item used, one hit landed, one hit taken.
        rm.players["B"].carrying = "missile"
        w["B"].send_json({"type": "fire", "item": "missile"})
        assert _wait_until(lambda: racers["A"].hits_taken == 1)
        assert racers["B"].items_used == {"missile": 1} and racers["B"].hits_landed == 1
        assert racers["A"].hits_landed == 0 and racers["B"].hits_taken == 0

        # A pops a Shield (an item used), and the next missile is blocked: not a hit, not landed.
        w["A"].send_json({"type": "fx", "item": "shield", "ms": 6000})
        assert _wait_until(lambda: racers["A"].items_used.get("shield") == 1)
        rm.players["B"].carrying = "missile"
        w["B"].send_json({"type": "fire", "item": "missile"})
        assert _wait_until(lambda: racers["A"].hits_blocked == 1)
        assert racers["A"].hits_taken == 1 and racers["B"].hits_landed == 1
        assert racers["B"].items_used == {"missile": 2}

        # The leader has nobody to shoot at: the item is refunded, so it was not used.
        rm.players["A"].carrying = "goop"
        w["A"].send_json({"type": "fire", "item": "goop"})
        assert any(f["type"] == "refund" for f in _drain(w["A"]))
        assert "goop" not in racers["A"].items_used

        # B passes A: A drops to 2nd, so A's worst place is now 2nd too.
        w["B"].send_json({"type": "pos", "lat": 45.0, "lon": -122.0, "gate": 4, "elapsed_ms": 7000, "alt": 900.0})
        _drain(w["B"])
        assert racers["A"].worst_rank == 2 and racers["B"].worst_rank == 2

        # None of it can be reported by a client, and none of it reaches the row until the end.
        _run_race("tallyroom", w, ["B", "A"])
        res = _results_of(w["A"])
        a, b = res["rows"][1], res["rows"][0]
        assert (b["callsign"], b["items_used"], b["hits_taken"]) == ("B", {"missile": 2}, 0)
        assert (a["callsign"], a["items_used"], a["hits_taken"]) == ("A", {"shield": 1}, 1)
        keys = {x["key"]: x["callsign"] for x in res["awards"]}
        assert keys["most_hits_taken"] == "A" and keys["sharpshooter"] == "B" and keys["clean_race"] == "B"


def test_nothing_thrown_outside_a_race_is_tallied():
    with TestClient(appmod.app) as c, _pilots(c, "lobbytallyroom", ["A", "B"]) as w:
        rm = appmod.rooms["lobbytallyroom"]
        rm.players["A"].carrying = "banana"
        w["A"].send_json({"type": "fire", "item": "banana"})
        w["A"].send_json({"type": "fx", "item": "boost", "ms": 4000})
        _drain(w["A"])
        assert rm.race is None, "no race, so nothing to tally onto"
        _start_race("lobbytallyroom", w)
        assert rm.race.racers["A"].items_used == {}, "a lobby-phase throw did not carry into the race"


def test_finishers_stop_collecting_hits():
    # A hit that lands after a pilot crossed the line must not count against their clean race.
    with TestClient(appmod.app) as c, _pilots(c, "afterroom", ["A", "B"]) as w:
        _start_race("afterroom", w)
        rm = appmod.rooms["afterroom"]
        _finish("afterroom", w["A"])
        assert _wait_until(lambda: rm.race.racers["A"].status == "finished")
        appmod._tally(rm, "A", "hits_taken")
        appmod._tally_item(rm, "A", "missile")
        assert rm.race.racers["A"].hits_taken == 0 and rm.race.racers["A"].items_used == {}


# ---- cups

def test_a_cup_carries_points_across_races_and_ends_after_its_last():
    with TestClient(appmod.app) as c, _pilots(c, "cuproom", ["A", "B"]) as w:
        rm = appmod.rooms["cuproom"]
        w["A"].send_json({"type": "cup", "name": "Friday Night", "race_count": 2})
        assert _wait_until(lambda: rm.cup is not None)
        lobby = _of(_drain(w["B"]), "lobby")[-1]
        assert lobby["cup"] == {"name": "Friday Night", "race_no": 0, "race_count": 2}

        # Race 1: A wins.
        _start_race("cuproom", w)
        _run_race("cuproom", w, ["A", "B"])
        r1 = _results_of(w["B"])
        assert r1["cup"] == {"name": "Friday Night", "race_no": 1, "race_count": 2,
                             "standings": [{"callsign": "A", "points": 15}, {"callsign": "B", "points": 12}]}

        # A rematch goes back to the lobby with the course and the cup kept and the ready flags cleared.
        w["A"].send_json({"type": "rematch"})
        assert _wait_until(lambda: rm.phase == "lobby")
        assert rm.course is not None and rm.cup["race_no"] == 1
        assert not any(p.ready for p in rm.players.values())

        # Race 2: B wins, A is out. B 12+15 = 27, A 15+0 = 15.
        _start_race("cuproom", w)
        _run_race("cuproom", w, ["B"], out=["A"])
        frames = _drain(w["A"])
        assert _of(frames, "results")[-1]["cup"] == {
            "name": "Friday Night", "race_no": 2, "race_count": 2,
            "standings": [{"callsign": "B", "points": 27}, {"callsign": "A", "points": 15}]}
        # That was the last race: the cup is over, and the lobby that follows the results says so.
        assert rm.cup is None
        assert _of(frames, "lobby")[-1]["cup"] is None

        # The next race is a one-off.
        w["A"].send_json({"type": "rematch"})
        assert _wait_until(lambda: rm.phase == "lobby")
        _start_race("cuproom", w)
        _run_race("cuproom", w, ["A", "B"])
        assert _results_of(w["A"])["cup"] is None


def test_a_dnf_only_pilot_still_appears_in_the_cup_standings_on_zero():
    with TestClient(appmod.app) as c, _pilots(c, "cupzeroroom", ["A", "B"]) as w:
        w["A"].send_json({"type": "cup", "name": "Zero", "race_count": 3})
        assert _wait_until(lambda: appmod.rooms["cupzeroroom"].cup is not None)
        _start_race("cupzeroroom", w)
        _run_race("cupzeroroom", w, ["A"], out=["B"])
        assert _results_of(w["B"])["cup"]["standings"] == [{"callsign": "A", "points": 15}, {"callsign": "B", "points": 0}]


def test_starting_a_new_cup_replaces_the_old_one_and_only_the_host_or_between_races_may():
    with TestClient(appmod.app) as c, _pilots(c, "cupctlroom", ["A", "B"]) as w:
        rm = appmod.rooms["cupctlroom"]
        # Not the host.
        w["B"].send_json({"type": "cup", "name": "Mine", "race_count": 3})
        assert [f["detail"] for f in _of(_drain(w["B"]), "error")] == ["host only"]
        assert rm.cup is None
        # Out of range is a validation error and changes nothing.
        w["A"].send_json({"type": "cup", "name": "x" * 40, "race_count": 3})
        w["A"].send_json({"type": "cup", "name": "ok", "race_count": 13})
        assert len(_of(_drain(w["A"]), "error")) == 2 and rm.cup is None

        w["A"].send_json({"type": "cup", "name": "First", "race_count": 4})
        assert _wait_until(lambda: rm.cup is not None and rm.cup["name"] == "First")
        w["A"].send_json({"type": "cup", "name": "Second", "race_count": 2})
        assert _wait_until(lambda: rm.cup["name"] == "Second")
        assert rm.cup["race_no"] == 0 and rm.cup["points"] == {}, "a new cup starts from nothing"

        # Not in the middle of a race.
        _start_race("cupctlroom", w)
        w["A"].send_json({"type": "cup", "name": "Mid", "race_count": 2})
        assert [f["detail"] for f in _of(_drain(w["A"]), "error")] == ["a cup can only change between races"]
        assert rm.cup["name"] == "Second"


def test_rematch_is_host_only_and_only_from_the_results():
    with TestClient(appmod.app) as c, _pilots(c, "rematchroom", ["A", "B"]) as w:
        rm = appmod.rooms["rematchroom"]
        w["A"].send_json({"type": "rematch"})
        assert [f["detail"] for f in _of(_drain(w["A"]), "error")] == ["nothing to rematch"]
        _start_race("rematchroom", w)
        _run_race("rematchroom", w, ["A", "B"])
        w["B"].send_json({"type": "rematch"})
        assert [f["detail"] for f in _of(_drain(w["B"]), "error")] == ["host only"]
        assert rm.phase == "results"
        w["A"].send_json({"type": "rematch"})
        assert _wait_until(lambda: rm.phase == "lobby")
        assert rm.race is None and rm.last_results is None and rm.course is not None


def test_back_to_lobby_from_the_results_or_mid_race_does_not_score_anything():
    with TestClient(appmod.app) as c, _pilots(c, "b2lroom", ["A", "B"]) as w:
        rm = appmod.rooms["b2lroom"]
        w["A"].send_json({"type": "cup", "name": "B2L", "race_count": 2})
        assert _wait_until(lambda: rm.cup is not None)
        _start_race("b2lroom", w)
        _finish("b2lroom", w["A"])
        _drain(w["A"])
        w["A"].send_json({"type": "back_to_lobby"})       # host calls it off mid-race
        assert _wait_until(lambda: rm.phase == "lobby")
        assert rm.race is None and rm.cup["race_no"] == 0, "an abandoned race is not a cup race"
        assert not _of(_drain(w["B"]), "results")


def test_a_new_start_over_a_race_in_flight_replaces_it():
    with TestClient(appmod.app) as c, _pilots(c, "restartroom", ["A", "B"]) as w:
        rm = appmod.rooms["restartroom"]
        _start_race("restartroom", w)
        old = rm.race
        _finish("restartroom", w["A"])
        assert _wait_until(lambda: old.timer is not None)
        _start_race("restartroom", w)
        assert rm.race is not old and old.ended and old.timer is None, "the old race's deadline is gone"
        assert rm.race.race_id == old.race_id + 1


def test_a_joiner_during_the_results_is_shown_them():
    with TestClient(appmod.app) as c, _pilots(c, "lateresroom", ["A", "B"]) as w:
        _start_race("lateresroom", w)
        _run_race("lateresroom", w, ["A", "B"])
        with c.websocket_connect("/ws/race/lateresroom") as late:
            _join(late, "Late")
            res = _of(_drain(late), "results")
            assert res and [r["callsign"] for r in res[0]["rows"]] == ["A", "B"]


def test_an_old_client_that_never_finishes_cannot_strand_the_room():
    """A pre-0.11.0 client never sends `finish`, so the race never ends by itself — the host's
    back_to_lobby, which every version has, must still be the way out, and nothing is scored."""
    with TestClient(appmod.app) as c, _pilots(c, "oldfinishroom", ["Old"]) as w:
        rm = appmod.rooms["oldfinishroom"]
        _start_race("oldfinishroom", w)
        w["Old"].send_json({"type": "pos", "lat": 45.0, "lon": -122.0, "gate": 2, "elapsed_ms": 9000})
        _drain(w["Old"])
        assert rm.phase == "racing"
        w["Old"].send_json({"type": "back_to_lobby"})
        assert _wait_until(lambda: rm.phase == "lobby")
        with appmod.connect() as conn:
            assert conn.execute("SELECT COUNT(*) FROM races WHERE room = 'oldfinishroom'").fetchone()[0] == 0


def test_an_empty_room_drops_its_race_and_its_deadline(monkeypatch):
    monkeypatch.setattr(appmod, "RESULTS_TIMEOUT_S", 30)
    with TestClient(appmod.app) as c:
        with _pilots(c, "vanishroom", ["A", "B"]) as w:
            _start_race("vanishroom", w)
            _finish("vanishroom", w["A"])
            rec = appmod.rooms["vanishroom"].race
            assert _wait_until(lambda: rec.timer is not None)
            # The finisher goes first, then the racer still out there: the room empties while the
            # race is undecided, so nobody is left to send results to.
            w["A"].close()
            assert _wait_until(lambda: "A" not in appmod.rooms["vanishroom"].players)
        assert _wait_until(lambda: "vanishroom" not in appmod.rooms)
        assert rec.ended and rec.timer is None, "the 30 s deadline must not outlive the room"


# ---- persistence

def _db_races(room):
    with appmod.connect() as conn:
        return [dict(r) for r in conn.execute(
            "SELECT * FROM races WHERE room = ? ORDER BY id", (room,)).fetchall()]


def _db_results(race_id):
    with appmod.connect() as conn:
        return [dict(r) for r in conn.execute(
            "SELECT * FROM race_results WHERE race_id = ? ORDER BY pos", (race_id,)).fetchall()]


def test_a_finished_race_and_its_cup_round_trip_through_sqlite():
    with TestClient(appmod.app) as c, _pilots(c, "dbroom", ["A", "B", "C"]) as w:
        rm = appmod.rooms["dbroom"]
        w["A"].send_json({"type": "cup", "name": "DB Cup", "race_count": 2})
        assert _wait_until(lambda: rm.cup is not None)

        # Race 1. A jump-starts, so A's clock carries +5 s and B, a beat faster in the air, wins.
        _start_race("dbroom", w, ready=["A", "B", "C"])
        w["B"].send_json({"type": "pos", "lat": 45.0, "lon": -122.0, "gate": 2, "elapsed_ms": 9000, "alt": 800.0})
        _drain(w["B"])
        rm.race.racers["B"].hits_taken = 2                  # what two landed hits would have tallied
        _finish("dbroom", w["A"], offset=appmod.JUMP_START_PENALTY_MS, jump_start=True,
                splits=[8000, 20000, 29000], best_sector_ms=8000)
        _finish("dbroom", w["B"], offset=-500)
        _dnf("dbroom", w["C"], gate=1)
        assert _wait_until(lambda: len(_db_races("dbroom")) == 1, 3.0), "the race was never written"

        (race,) = _db_races("dbroom")
        assert race["course_hash"] == "0a1b2c3d" and race["course_name"] == "Starter Sprint"
        assert race["cup_id"] is not None and abs(race["started_at"] - int(_time.time() - 30)) < 5
        rows = _db_results(race["id"])
        assert [(r["callsign"], r["pos"], r["status"], r["points"]) for r in rows] == [
            ("B", 1, "finished", 15), ("A", 2, "finished", 12), ("C", 3, "dnf", 0)]
        assert rows[2]["go_time_ms"] is None and rows[0]["go_time_ms"] > 0
        stats = {r["callsign"]: json.loads(r["stats_json"]) for r in rows}
        assert stats["B"]["hits_taken"] == 2 and stats["B"]["final_rank"] == 1 and stats["B"]["worst_rank"] >= 1
        assert stats["A"]["jump_start"] is True and stats["A"]["best_sector_ms"] == 8000
        assert stats["C"]["gate"] == 1

        with appmod.connect() as conn:
            cup = dict(conn.execute("SELECT * FROM cups WHERE id = ?", (race["cup_id"],)).fetchone())
        assert (cup["room"], cup["name"], cup["race_count"]) == ("dbroom", "DB Cup", 2)
        assert cup["closed_at"] is None, "one race of two: the cup is still open"
        assert _wait_until(lambda: rm.cup["id"] == race["cup_id"]), "the room learns its cup's id from the write"

        # Race 2 lands under the same cup row, and closing the cup is the last race's doing.
        w["A"].send_json({"type": "rematch"})
        assert _wait_until(lambda: rm.phase == "lobby")
        _start_race("dbroom", w)
        _run_race("dbroom", w, ["A", "B", "C"])
        assert _wait_until(lambda: len(_db_races("dbroom")) == 2, 3.0)
        races = _db_races("dbroom")
        assert races[0]["cup_id"] == races[1]["cup_id"] == cup["id"], "the same cup, not a second row"
        with appmod.connect() as conn:
            assert conn.execute("SELECT COUNT(*) FROM cups WHERE room = 'dbroom'").fetchone()[0] == 1
            assert conn.execute("SELECT closed_at FROM cups WHERE id = ?", (cup["id"],)).fetchone()[0] is not None


def test_a_one_off_race_is_stored_with_no_cup():
    with TestClient(appmod.app) as c, _pilots(c, "oneoffroom", ["A", "B"]) as w:
        _start_race("oneoffroom", w)
        _run_race("oneoffroom", w, ["A", "B"])
        assert _wait_until(lambda: len(_db_races("oneoffroom")) == 1, 3.0)
        assert _db_races("oneoffroom")[0]["cup_id"] is None
        with appmod.connect() as conn:
            assert conn.execute("SELECT COUNT(*) FROM cups WHERE room = 'oneoffroom'").fetchone()[0] == 0


def test_starting_a_new_cup_closes_the_room_s_abandoned_one():
    with TestClient(appmod.app) as c, _pilots(c, "abandonroom", ["A", "B"]) as w:
        rm = appmod.rooms["abandonroom"]
        w["A"].send_json({"type": "cup", "name": "Old Cup", "race_count": 5})
        assert _wait_until(lambda: rm.cup is not None)
        _start_race("abandonroom", w)
        _run_race("abandonroom", w, ["A", "B"])
        assert _wait_until(lambda: len(_db_races("abandonroom")) == 1, 3.0)
        w["A"].send_json({"type": "cup", "name": "New Cup", "race_count": 3})
        assert _wait_until(lambda: rm.cup["name"] == "New Cup")
        w["A"].send_json({"type": "rematch"})
        assert _wait_until(lambda: rm.phase == "lobby")
        _start_race("abandonroom", w)
        _run_race("abandonroom", w, ["B", "A"])
        assert _wait_until(lambda: len(_db_races("abandonroom")) == 2, 3.0)
        with appmod.connect() as conn:
            got = {r["name"]: r["closed_at"] for r in conn.execute(
                "SELECT name, closed_at FROM cups WHERE room = 'abandonroom'").fetchall()}
        assert got["Old Cup"] is not None and got["New Cup"] is None


def test_the_results_write_runs_off_the_event_loop(monkeypatch):
    """persist_race takes 0.6 s here. If it ran on the loop, a ping sent while it is running could
    not be answered until it finished."""
    started = threading.Event()

    def slow_persist(*a, **kw):
        started.set()
        _time.sleep(0.6)
        return {"race_id": 1, "cup_id": None}
    monkeypatch.setattr(appmod, "persist_race", slow_persist)
    with TestClient(appmod.app) as c, _pilots(c, "threadroom", ["A", "B"]) as w:
        _start_race("threadroom", w)
        _run_race("threadroom", w, ["A", "B"])
        assert started.wait(2.0), "the write never started"
        t0 = _time.time()
        _drain(w["A"])
        assert _time.time() - t0 < 0.4, "the relay stopped answering while the write ran"


def test_a_failed_write_is_logged_and_never_takes_the_room_down(monkeypatch, caplog):
    import sqlite3

    def broken(*a, **kw):
        raise sqlite3.OperationalError("disk is full")
    monkeypatch.setattr(appmod, "persist_race", broken)
    with TestClient(appmod.app) as c, _pilots(c, "brokenroom", ["A", "B"]) as w:
        _start_race("brokenroom", w)
        _run_race("brokenroom", w, ["A", "B"])
        res = _results_of(w["A"])
        assert [r["callsign"] for r in res["rows"]] == ["A", "B"], "the results still reach the room"
        assert _wait_until(lambda: any("could not persist" in r.message for r in caplog.records))
        w["A"].send_json({"type": "rematch"})
        assert _wait_until(lambda: appmod.rooms["brokenroom"].phase == "lobby")


def test_the_new_tables_migrate_idempotently_and_leave_old_data_alone():
    with appmod.connect() as conn:
        conn.executescript(appmod.SCHEMA)
        before = {t: conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
                  for t in ("runs", "traces", "cups", "races", "race_results")}
        conn.executescript(appmod.SCHEMA)
        conn.executescript(appmod.SCHEMA)
        after = {t: conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] for t in before}
        assert before == after
        cols = {t: [r[1] for r in conn.execute(f"PRAGMA table_info({t})").fetchall()]
                for t in ("cups", "races", "race_results")}
    assert cols["cups"] == ["id", "room", "name", "race_count", "created_at", "closed_at"]
    assert cols["races"] == ["id", "room", "course_hash", "course_name", "started_at", "cup_id"]
    # 1.2.0 appends pilot_id via migrate()'s ALTER TABLE. Asserted as a PREFIX plus the new
    # column rather than an exact list, so the proto-4 columns are still pinned in their original
    # order (which is what this test is for) while an additive migration does not break it.
    assert cols["race_results"] == ["race_id", "callsign", "pos", "go_time_ms", "status", "points",
                                    "model", "stats_json", "pilot_id"]


def test_the_lobby_frame_gains_a_cup_field_and_nothing_else_moved():
    with TestClient(appmod.app) as c, _pilots(c, "lobbyshaperoom", ["A"]) as w:
        lobby = _of(_drain(w["A"]), "lobby")[-1]
        assert set(lobby) == {"type", "phase", "host", "course", "rules", "race_id", "cup", "players"}
        assert lobby["cup"] is None


# ---- read-only REST and the landing page

import re


def _seed(room, results, cup=None, course_name="REST Course"):
    """Write one finished race straight through persist_race(), the same function the relay uses.
    `results` is [(callsign, status, go_time_ms)] in finishing order."""
    racers = [_racer(cs, status, ms, seq=i + 1, gate=2 if status == "dnf" else 0, model="M" + cs)
              for i, (cs, status, ms) in enumerate(results)]
    return appmod.persist_race(room, {"course_hash": "aa11bb22", "name": course_name},
                               int(_time.time()), appmod.build_rows(racers), cup)


def test_races_recent_lists_newest_first_with_results_and_the_cup_it_belonged_to():
    with TestClient(appmod.app) as c:
        a = _seed("restrecentroom", [("A", "finished", 60000), ("B", "dnf", None)], course_name="First")
        b = _seed("restrecentroom", [("B", "finished", 61000), ("A", "finished", 62000)], course_name="Second",
                  cup={"id": None, "name": "Rest Cup", "race_count": 3, "race_no": 1})
        got = c.get("/races/recent", params={"limit": 100}).json()
        mine = [r for r in got if r["room"] == "restrecentroom"]
        assert [r["id"] for r in mine] == [b["race_id"], a["race_id"]], "newest first"
        newest, oldest = mine
        assert set(newest) == {"id", "room", "course_hash", "course_name", "started_at", "cup_id", "cup_name", "results"}
        assert (newest["course_name"], newest["course_hash"]) == ("Second", "aa11bb22")
        assert newest["cup_id"] == b["cup_id"] and newest["cup_name"] == "Rest Cup"
        assert [(x["pos"], x["callsign"], x["status"], x["points"]) for x in newest["results"]] == [
            (1, "B", "finished", 15), (2, "A", "finished", 12)]
        assert set(newest["results"][0]) == {"callsign", "pos", "go_time_ms", "status", "points", "model"}
        assert newest["results"][0]["go_time_ms"] == 61000 and newest["results"][0]["model"] == "MB"
        assert oldest["cup_id"] is None and oldest["cup_name"] is None
        assert oldest["results"][1] == {"callsign": "B", "pos": 2, "go_time_ms": None, "status": "dnf",
                                        "points": 0, "model": "MB"}


def test_races_recent_limits_and_validates():
    with TestClient(appmod.app) as c:
        _seed("restlimitroom", [("A", "finished", 60000)])
        _seed("restlimitroom", [("A", "finished", 60000)])
        assert len(c.get("/races/recent", params={"limit": 1}).json()) == 1
        assert 1 <= len(c.get("/races/recent").json()) <= 10, "the default is 10"
        assert c.get("/races/recent", params={"limit": 0}).status_code == 422
        assert c.get("/races/recent", params={"limit": 101}).status_code == 422


def test_cup_detail_has_standings_and_the_races_behind_them():
    with TestClient(appmod.app) as c:
        cup = {"id": None, "name": "Detail Cup", "race_count": 2, "race_no": 1}
        r1 = _seed("restcuproom", [("A", "finished", 60000), ("B", "finished", 61000), ("C", "dnf", None)],
                   course_name="Leg 1", cup=cup)
        cup_id = r1["cup_id"]
        body = c.get(f"/cups/{cup_id}").json()
        assert body["open"] is True and body["closed_at"] is None and body["races_run"] == 1

        _seed("restcuproom", [("B", "finished", 59000), ("A", "finished", 60500)], course_name="Leg 2",
              cup={**cup, "id": cup_id, "race_no": 2})
        body = c.get(f"/cups/{cup_id}").json()
        assert set(body) == {"id", "room", "name", "race_count", "created_at", "closed_at", "open",
                             "races_run", "standings", "races"}
        assert (body["id"], body["room"], body["name"], body["race_count"]) == (cup_id, "restcuproom", "Detail Cup", 2)
        assert body["open"] is False and body["closed_at"] is not None, "its last race closed it"
        assert body["races_run"] == 2
        # A and B both scored 15 + 12; the tie is by callsign. C only raced once, and scored nothing.
        assert body["standings"] == [{"callsign": "A", "points": 27, "races": 2, "wins": 1},
                                     {"callsign": "B", "points": 27, "races": 2, "wins": 1},
                                     {"callsign": "C", "points": 0, "races": 1, "wins": 0}]
        assert [(r["course_name"], r["winner"]) for r in body["races"]] == [("Leg 1", "A"), ("Leg 2", "B")]
        assert set(body["races"][0]) == {"id", "course_hash", "course_name", "started_at", "winner"}

        assert c.get("/cups/99999999").status_code == 404
        assert c.get("/cups/not-a-number").status_code == 422


def test_cups_list_filters_by_room_and_by_open():
    with TestClient(appmod.app) as c:
        _seed("restlistroom", [("A", "finished", 60000)], cup={"id": None, "name": "Done", "race_count": 1, "race_no": 1})
        _seed("restlistroom", [("A", "finished", 60000), ("B", "finished", 61000)],
              cup={"id": None, "name": "Running", "race_count": 4, "race_no": 1})
        _seed("restotherroom", [("Z", "finished", 60000)], cup={"id": None, "name": "Elsewhere", "race_count": 4, "race_no": 1})

        mine = c.get("/cups", params={"room": "restlistroom"}).json()
        assert [x["name"] for x in mine] == ["Running", "Done"], "newest first, this room only"
        assert set(mine[0]) == {"id", "room", "name", "race_count", "created_at", "closed_at", "open",
                                "races_run", "standings"}
        assert mine[0]["open"] is True and mine[1]["open"] is False
        assert mine[0]["standings"] == [{"callsign": "A", "points": 15, "races": 1, "wins": 1},
                                        {"callsign": "B", "points": 12, "races": 1, "wins": 0}]

        assert [x["name"] for x in c.get("/cups", params={"room": "restlistroom", "open": 1}).json()] == ["Running"]
        everywhere = {x["name"] for x in c.get("/cups", params={"open": 1, "limit": 100}).json()}
        assert {"Running", "Elsewhere"} <= everywhere and "Done" not in everywhere
        assert c.get("/cups", params={"room": "nosuchroomanywhere"}).json() == []
        assert len(c.get("/cups", params={"limit": 1}).json()) == 1
        assert c.get("/cups", params={"room": "Bad Room!"}).status_code == 422
        assert c.get("/cups", params={"limit": 0}).status_code == 422


def test_the_results_api_is_read_only_and_shares_the_cors_policy():
    with TestClient(appmod.app) as c:
        for path in ("/races/recent", "/cups", "/cups/1", "/"):
            for method in ("post", "put", "patch", "delete"):
                assert getattr(c, method)(path).status_code == 405, (method, path)
        origin = appmod.ORIGINS[0]
        ok_ = c.get("/races/recent", headers={"Origin": origin})
        assert ok_.headers["access-control-allow-origin"] == origin
        bad = c.get("/cups", headers={"Origin": "https://evil.example"})
        assert "access-control-allow-origin" not in bad.headers


def test_the_landing_page_is_a_static_site_with_a_locked_down_csp():
    """0.13.0's redesign: race/server/static/{index.html,site.css,site.js}, served as plain static
    files (StaticFiles(html=True) answers "/"). Google Fonts is the one deliberate external
    request (script-src/connect-src stay same-origin); everything else is 'none'."""
    with TestClient(appmod.app) as c:
        r = c.get("/")
        assert r.status_code == 200 and r.headers["content-type"].startswith("text/html")
        html = r.text
        assert "FINSONLY Racing" in html
        assert '<meta name="robots" content="noindex">' in html
        for heading in ("Departures", "Course records", "Recent races", "Open cups", "Get in the race"):
            assert heading in html
        # It builds the DOM from textContent only: callsigns and course names are client-supplied.
        for banned in ("innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "<script>"):
            assert banned not in html, banned
        csp = r.headers["content-security-policy"]
        assert "default-src 'none'" in csp and "script-src 'self'" in csp
        assert "style-src 'self' https://fonts.googleapis.com" in csp
        assert "font-src https://fonts.gstatic.com" in csp
        assert "connect-src 'self'" in csp and "frame-ancestors 'none'" in csp
        assert r.headers["x-content-type-options"] == "nosniff"
        # The other two static files come from the same mount, and never leak into the CSP as an
        # inline sink (no innerHTML-family DOM writes there either).
        js = c.get("/site.js")
        assert js.status_code == 200 and "text/javascript" in js.headers["content-type"]
        for banned in ("innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval("):
            assert banned not in js.text, banned
        assert c.get("/site.css").status_code == 200
        # Every endpoint the page calls answers with JSON.
        for path in ("/courses", "/courses/catalog", "/races/recent?limit=8", "/cups?open=1&limit=6",
                     "/rooms/live", "/stats", "/bookmarklet"):
            assert c.get(path).status_code == 200, path


def test_stats_and_rooms_live_are_rate_limited_per_ip():
    appmod.GET_MIN_INTERVAL_S = 5
    appmod._last_get.clear()
    try:
        with TestClient(appmod.app) as c:
            assert c.get("/stats").status_code == 200
            assert c.get("/stats").status_code == 429
            # The gate is shared across the two endpoints, same posture as POST /runs vs the
            # per-mode POSTs sharing _post_rate_limit.
            assert c.get("/rooms/live").status_code == 429
    finally:
        appmod.GET_MIN_INTERVAL_S = 0
        appmod._last_get.clear()


def test_hits_landed_by_item_is_tallied_and_reaches_stats_missiles_hit():
    """_tally_item_landed() breaks the existing hits_landed total out by item -- the plain total
    (and every award/results-screen field) is unchanged; only /stats reads the new breakdown."""
    r = appmod.Racer("Shooter")
    room = appmod.Room("statsroom")
    room.phase = "racing"
    room.race = appmod.RaceRecord(1, {"course_hash": "0a1b2c3d", "name": "C"}, appmod.server_ms(), [])
    room.race.racers = {"Shooter": r}
    appmod._tally(room, "Shooter", "hits_landed")
    appmod._tally_item_landed(room, "Shooter", "missile")
    appmod._tally(room, "Shooter", "hits_landed")
    appmod._tally_item_landed(room, "Shooter", "missile")
    appmod._tally(room, "Shooter", "hits_landed")
    appmod._tally_item_landed(room, "Shooter", "goop")
    assert r.hits_landed == 3 and r.hits_landed_by_item == {"missile": 2, "goop": 1}

    r.status, r.go_time_ms = "finished", 10000
    rows = appmod.build_rows([r])
    assert rows[0]["hits_landed"] == 3 and rows[0]["hits_landed_by_item"] == {"missile": 2, "goop": 1}
    assert set(appmod.public_row(rows[0])) == {"pos", "callsign", "model", "go_time_ms", "gap_ms", "status",
                                               "points", "items_used", "hits_taken", "jump_start", "gate"}

    with TestClient(appmod.app) as c:
        appmod._get_cache.clear()
        before = c.get("/stats").json()["missiles_hit"]
        appmod.persist_race("statsroom", {"course_hash": "0a1b2c3d", "name": "C"}, int(_time.time()), rows, None)
        appmod._get_cache.clear()
        assert c.get("/stats").json()["missiles_hit"] == before + 2


def test_stats_endpoint_aggregates_from_sqlite_and_is_cached():
    with TestClient(appmod.app) as c:
        appmod._get_cache.clear()
        before = c.get("/stats").json()
        assert set(before) == {"races", "pilots", "gates", "missiles_hit"}
        c.post("/runs", json=run(callsign="StatsPilot"))
        # Cached: an immediate re-read doesn't yet see the new run.
        assert c.get("/stats").json()["races"] == before["races"]
        appmod._get_cache.clear()
        after = c.get("/stats").json()
        assert after["races"] == before["races"] + 1
        assert after["gates"] == before["gates"] + 3  # run()'s fixture course has 3 gates
        assert after["pilots"] >= before["pilots"]


def test_rooms_live_never_leaks_the_room_code_and_shows_pilots_and_spectators():
    with TestClient(appmod.app) as c:
        appmod._get_cache.clear()
        secret = "top-secret-room-42"
        with c.websocket_connect("/ws/race/" + secret) as a_ws, \
             c.websocket_connect("/ws/race/" + secret) as b_ws:
            _join(a_ws, "Ann")
            b_ws.send_json({"type": "join", "callsign": "Bea", "spectate": True})
            assert b_ws.receive_json()["type"] == "joined"
            assert appmod.rooms[secret].players["Bea"].spectate
            appmod._get_cache.clear()
            body = c.get("/rooms/live")
            raw = body.text
            rows = body.json()
            assert secret not in raw, "the real room code must never reach the page"
            assert "token" not in raw and "chat" not in raw
            (row,) = [r for r in rows if "Ann" in r["pilot_callsigns"]]
            assert row["room"] == appmod._room_label(secret)
            assert len(row["room"]) == 8 and row["room"] != secret
            assert row["phase"] == "lobby" and row["course"] is None and row["gate_progress"] is None
            assert row["pilot_callsigns"] == ["Ann"] and row["spectators"] == 1
        # The socket closed, the room is gone, and an empty room never lists as "live".
        assert _wait_until(lambda: secret not in appmod.rooms)
        appmod._get_cache.clear()
        assert not any(r["room"] == appmod._room_label(secret) for r in c.get("/rooms/live").json())


def test_rooms_live_reports_gate_progress_while_racing():
    with TestClient(appmod.app) as c:
        appmod._get_cache.clear()
        with c.websocket_connect("/ws/race/gateprogroom") as ws:
            _join(ws, "Solo")
            _start_race("gateprogroom", {"Solo": ws})
            ws.send_json({"type": "pos", "lat": 45.0, "lon": -122.0, "gate": 2, "elapsed_ms": 4000})
            assert _wait_until(lambda: appmod.rooms["gateprogroom"].players["Solo"].gate == 2)
            appmod._get_cache.clear()
            (row,) = [r for r in c.get("/rooms/live").json()
                      if r["room"] == appmod._room_label("gateprogroom")]
            assert row["phase"] == "racing"
            assert row["gate_progress"]["gate"] == 2


# ---------------------------------------------------- pilot identity (1.2.0, proto 5)
# A callsign used to be a free-text string anyone could type. It is now a display name owned by a
# server-issued pilot_id. These drive the conn-taking half directly against a scratch database so
# they never depend on what earlier tests happened to leave in the shared one.

def _fresh_db(tmp_path, rows=(), traces=(), results=()):
    """A database at the PRE-1.2.0 shape — the three tables that gain a pilot_id, without it —
    i.e. what a real 1.1.0 race.db looks like the moment before migrate() first runs. Built by
    hand so the test actually exercises ALTER TABLE rather than a table that already had it."""
    path = str(tmp_path / "old.db")
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.executescript("""
      CREATE TABLE runs (id INTEGER PRIMARY KEY AUTOINCREMENT, course_id TEXT NOT NULL,
        course_hash TEXT NOT NULL, course_name TEXT NOT NULL, callsign TEXT NOT NULL,
        aircraft_id TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '', time_ms INTEGER NOT NULL,
        splits TEXT NOT NULL, gates INTEGER NOT NULL, length_m REAL NOT NULL,
        client_version TEXT NOT NULL DEFAULT '', ip TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
      CREATE TABLE traces (course_hash TEXT NOT NULL, callsign TEXT NOT NULL, time_ms INTEGER NOT NULL,
        model TEXT NOT NULL DEFAULT '', trace_blob TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY (course_hash, callsign));
      CREATE TABLE race_results (race_id INTEGER NOT NULL, callsign TEXT NOT NULL, pos INTEGER NOT NULL,
        go_time_ms INTEGER, status TEXT NOT NULL, points INTEGER NOT NULL, model TEXT NOT NULL DEFAULT '',
        stats_json TEXT NOT NULL DEFAULT '{}', PRIMARY KEY (race_id, callsign));
    """)
    for i, cs in enumerate(rows):
        conn.execute("""INSERT INTO runs (course_id, course_hash, course_name, callsign, time_ms,
                        splits, gates, length_m, created_at) VALUES (?,?,?,?,?,?,?,?,?)""",
                     ("c", "0a1b2c3d", "C", cs, 1000 + i, "[]", 2, 100.0, 1700000000))
    for i, cs in enumerate(traces):
        conn.execute("INSERT INTO traces (course_hash, callsign, time_ms, trace_blob, created_at)"
                     " VALUES (?,?,?,?,?)", ("0a1b2c3d", cs, 1000 + i, "{}", 1700000000))
    for i, cs in enumerate(results):
        conn.execute("INSERT INTO race_results (race_id, callsign, pos, status, points)"
                     " VALUES (?,?,?,?,?)", (1, cs, i + 1, "finished", 10))
    conn.commit()
    return conn


def _migrated(conn):
    conn.executescript(appmod.SCHEMA)
    appmod.migrate(conn)
    conn.commit()
    return conn


def test_callsign_key_folds_case_and_trims():
    assert appmod.callsign_key("  Eric ") == "eric"
    assert appmod.callsign_key("ERIC") == appmod.callsign_key("eric") == "eric"
    assert appmod.callsign_key("") == ""
    assert appmod.callsign_key(None) == ""


def test_hash_token_is_stable_and_not_the_token():
    t = "a-secret-token"
    assert appmod.hash_token(t) == appmod.hash_token(t)
    assert t not in appmod.hash_token(t)
    assert len(appmod.hash_token(t)) == 64
    assert appmod.hash_token("a") != appmod.hash_token("b")


def test_ramp_day_rolls_over_at_local_midnight_not_utc():
    # 2026-03-05 06:30 UTC is still 2026-03-04 in UTC-7 — the whole point of the offset.
    utc_morning = _dt.datetime(2026, 3, 5, 6, 30, tzinfo=_dt.timezone.utc).timestamp()
    assert appmod.ramp_day(utc_morning) == "2026-03-04"
    # 07:00 UTC is midnight UTC-7, so the counter rolls there and not an hour earlier.
    assert appmod.ramp_day(utc_morning + 1800) == "2026-03-05"
    assert appmod.ramp_day(utc_morning + 1799) == "2026-03-04"


def test_issue_and_resolve_a_pilot(tmp_path):
    conn = _migrated(_fresh_db(tmp_path))
    pilot_id, token = appmod.issue_pilot(conn, "Eric")
    row = appmod.resolve_pilot(conn, token)
    assert row is not None and row["pilot_id"] == pilot_id
    assert row["callsign"] == "Eric" and row["callsign_key"] == "eric"
    # Only the hash is stored — a copy of the database is not a set of working credentials.
    assert conn.execute("SELECT token_hash FROM pilots WHERE pilot_id = ?",
                        (pilot_id,)).fetchone()["token_hash"] == appmod.hash_token(token)


def test_a_missing_or_unknown_token_is_a_new_pilot_never_an_error(tmp_path):
    conn = _migrated(_fresh_db(tmp_path))
    assert appmod.resolve_pilot(conn, None) is None
    assert appmod.resolve_pilot(conn, "") is None
    assert appmod.resolve_pilot(conn, "not-a-real-token") is None
    row, token, err = appmod.claim_callsign(conn, "not-a-real-token", "Nobody")
    assert err is None and token and row["callsign"] == "Nobody"


def test_claiming_a_callsign_another_pilot_holds_is_refused(tmp_path):
    conn = _migrated(_fresh_db(tmp_path))
    first, token_a, err = appmod.claim_callsign(conn, None, "Eric")
    assert err is None
    # A different pilot, no token, same name in another casing — refused, and nothing changes.
    row, token_b, err = appmod.claim_callsign(conn, None, "eric")
    assert row is None and token_b is None
    assert "Eric" in err and "another pilot" in err
    assert appmod.resolve_pilot(conn, token_a)["pilot_id"] == first["pilot_id"]
    assert conn.execute("SELECT COUNT(*) c FROM pilots").fetchone()["c"] == 1


def test_a_pilot_reconnecting_with_its_token_keeps_the_same_pilot_id(tmp_path):
    conn = _migrated(_fresh_db(tmp_path))
    first, token, _ = appmod.claim_callsign(conn, None, "Eric")
    again, new_token, err = appmod.claim_callsign(conn, token, "Eric")
    assert err is None
    assert again["pilot_id"] == first["pilot_id"]
    # No new token: a client already holding a working one is never told to overwrite it.
    assert new_token is None


def test_a_backfilled_callsign_is_adopted_by_the_first_pilot_to_claim_it(tmp_path):
    conn = _migrated(_fresh_db(tmp_path, rows=["Eric", "Maggie"]))
    backfilled = conn.execute("SELECT * FROM pilots WHERE callsign_key = 'eric'").fetchone()
    assert backfilled["token_hash"] is None, "a backfilled row is unclaimed"
    row, token, err = appmod.claim_callsign(conn, None, "Eric")
    assert err is None and token
    # Same pilot_id as the backfill, so the runs already on the board follow the name.
    assert row["pilot_id"] == backfilled["pilot_id"]
    assert conn.execute("SELECT COUNT(*) c FROM runs WHERE pilot_id = ?",
                        (row["pilot_id"],)).fetchone()["c"] == 1
    # And now it is claimed: the next stranger to try is refused.
    assert appmod.claim_callsign(conn, None, "Eric")[2] is not None


def test_adopting_a_backfilled_name_carries_an_existing_pilots_rows_across(tmp_path):
    conn = _migrated(_fresh_db(tmp_path, rows=["Eric"]))
    # A pilot who installed 1.2.0 fresh under a default name, then types their real callsign.
    mine, token, _ = appmod.claim_callsign(conn, None, "racer")
    conn.execute("INSERT INTO race_results (race_id, callsign, pos, status, points, pilot_id)"
                 " VALUES (2, 'racer', 1, 'finished', 15, ?)", (mine["pilot_id"],))
    row, new_token, err = appmod.claim_callsign(conn, token, "Eric")
    assert err is None and new_token is None
    assert row["callsign"] == "Eric"
    # One pilot, not two: the old row is folded in and its results come with it.
    assert appmod.resolve_pilot(conn, token)["pilot_id"] == row["pilot_id"]
    assert row["pilot_id"] != mine["pilot_id"]
    assert conn.execute("SELECT COUNT(*) c FROM pilots WHERE pilot_id = ?",
                        (mine["pilot_id"],)).fetchone()["c"] == 0
    assert conn.execute("SELECT COUNT(*) c FROM race_results WHERE pilot_id = ?",
                        (row["pilot_id"],)).fetchone()["c"] == 1
    assert conn.execute("SELECT COUNT(*) c FROM runs WHERE pilot_id = ?",
                        (row["pilot_id"],)).fetchone()["c"] == 1


def test_a_pilot_can_rename_and_releases_the_old_callsign(tmp_path):
    conn = _migrated(_fresh_db(tmp_path))
    first, token, _ = appmod.claim_callsign(conn, None, "Eric")
    renamed, _, err = appmod.claim_callsign(conn, token, "Maverick")
    assert err is None and renamed["pilot_id"] == first["pilot_id"]
    assert renamed["callsign"] == "Maverick" and renamed["callsign_key"] == "maverick"
    # 'Eric' is free again, and somebody else may take it.
    other, other_token, err = appmod.claim_callsign(conn, None, "Eric")
    assert err is None and other["pilot_id"] != first["pilot_id"]


def test_a_blank_callsign_is_refused(tmp_path):
    conn = _migrated(_fresh_db(tmp_path))
    assert appmod.claim_callsign(conn, None, "   ")[2] == "callsign cannot be blank"


def test_migration_backfills_one_pilot_per_distinct_callsign(tmp_path):
    conn = _fresh_db(tmp_path, rows=["Eric", "eric", "Maggie"], traces=["Steve"], results=["Maggie"])
    before = conn.execute("SELECT id, callsign, time_ms FROM runs ORDER BY id").fetchall()
    _migrated(conn)
    # 'Eric' and 'eric' are ONE pilot; Steve and Maggie come from the other two tables.
    keys = {r["callsign_key"] for r in conn.execute("SELECT callsign_key FROM pilots")}
    assert keys == {"eric", "maggie", "steve"}
    # Every pre-existing row now carries a pilot_id, and nothing else about it changed.
    for table in appmod.PILOT_ID_TABLES:
        assert conn.execute(f"SELECT COUNT(*) c FROM {table} WHERE pilot_id IS NULL").fetchone()["c"] == 0
    after = conn.execute("SELECT id, callsign, time_ms FROM runs ORDER BY id").fetchall()
    assert [tuple(r) for r in before] == [tuple(r) for r in after]
    # Both casings of the same name resolved to the same pilot.
    ids = {r["pilot_id"] for r in conn.execute("SELECT pilot_id FROM runs WHERE lower(callsign) = 'eric'")}
    assert len(ids) == 1


def test_migration_runs_twice_with_no_second_effect(tmp_path):
    conn = _migrated(_fresh_db(tmp_path, rows=["Eric", "Maggie"]))
    snapshot = [tuple(r) for r in conn.execute("SELECT pilot_id, callsign_key FROM pilots ORDER BY callsign_key")]
    runs_before = [tuple(r) for r in conn.execute("SELECT id, callsign, pilot_id FROM runs ORDER BY id")]
    _migrated(conn)
    _migrated(conn)
    assert [tuple(r) for r in conn.execute(
        "SELECT pilot_id, callsign_key FROM pilots ORDER BY callsign_key")] == snapshot
    assert [tuple(r) for r in conn.execute(
        "SELECT id, callsign, pilot_id FROM runs ORDER BY id")] == runs_before


def test_a_claimed_pilot_is_not_re_minted_by_a_later_migration(tmp_path):
    conn = _migrated(_fresh_db(tmp_path, rows=["Eric"]))
    row, token, _ = appmod.claim_callsign(conn, None, "Eric")
    _migrated(conn)
    # The backfill must not hand the claimed name back to a fresh unclaimed row.
    assert appmod.resolve_pilot(conn, token)["pilot_id"] == row["pilot_id"]
    assert conn.execute("SELECT COUNT(*) c FROM pilots WHERE callsign_key = 'eric'").fetchone()["c"] == 1


# ---------------------------------------------------- the matchmaking hub (1.2.0, proto 5)
# /ws/hub is a second socket; race rooms are untouched by it. Presence is in-memory and keyed on
# the pilot_id the identity block above issues.

class _FakeHubClient:
    """Just enough of HubClient for the pure presence/coalescing helpers."""
    def __init__(self, callsign, activity="idle", room=None, last_busy=0.0, last_push=0.0, dirty=True):
        self.callsign, self.activity, self.room = callsign, activity, room
        self.model, self.last_busy, self.last_push, self.dirty = "b747", last_busy, last_push, dirty


def _drain_ws(ws):
    """Everything the server has already sent and the client has not read yet. Lets a test count
    frames without blocking on one that may never come."""
    out = []
    while _ws_pending(ws):
        out.append(ws.receive_json())
    return out


def _ws_pending(ws):
    """Frames sent but not yet read. Starlette's test session keeps them in a private queue.Queue
    up to 0.37 and a private anyio stream from 0.38 on; requirements.txt allows either."""
    if hasattr(ws, "_send_queue"):
        return ws._send_queue.qsize()
    return ws._send_rx.statistics().current_buffer_used


def _hub_hello(ws, callsign, token=None, model="b747"):
    """Send `hello` and return the `welcome`/`error` it gets back.

    A successful hello deterministically sends exactly three frames — welcome, presence, rooms
    (see ws_hub: _hub_flush(now, always=client) fires right after welcome) — so this reads all
    three rather than stopping at the first, or the presence/rooms pair is left sitting in the
    queue for whatever the test does next to trip over.
    """
    frame = {"type": "hello", "callsign": callsign, "model": model}
    if token is not None:
        frame["pilot_token"] = token
    ws.send_json(frame)
    msg = ws.receive_json()
    if msg["type"] == "welcome":
        assert ws.receive_json()["type"] == "presence"
        assert ws.receive_json()["type"] == "rooms"
    return msg


def _hub_of(frames, *types):
    """Like the race socket's _of, but matches any of several types."""
    return [f for f in frames if f["type"] in types]


def test_rate_gate_allows_its_budget_then_refuses_and_counts():
    g = appmod.RateGate(3)
    assert [g.allow(100.0) for _ in range(4)] == [True, True, True, False]
    assert g.violations == 1
    # The window rolls: a second later the budget is back.
    assert g.allow(101.5) is True
    # `burst` lets a short burst through while holding the same average.
    b = appmod.RateGate(2, burst=4)
    assert [b.allow(50.0) for _ in range(5)] == [True, True, True, True, False]


def test_presence_rows_puts_busy_pilots_first_and_reports_idle_seconds():
    now = 1000.0
    rows = appmod.presence_rows([
        _FakeHubClient("Zeta", activity="idle", last_busy=now - 300),
        _FakeHubClient("Alpha", activity="idle", last_busy=now - 30),
        _FakeHubClient("Maggie", activity="racing", room="friday", last_busy=now - 900),
    ], now)
    assert [r["callsign"] for r in rows] == ["Maggie", "Alpha", "Zeta"]
    # Busy pilots read as 0 idle regardless of when they were last seen doing something else.
    assert rows[0]["idle_seconds"] == 0 and rows[0]["room"] == "friday"
    assert rows[1]["idle_seconds"] == 30 and rows[2]["idle_seconds"] == 300


def test_hub_welcome_issues_an_identity_and_the_same_token_resolves_next_time():
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/hub") as ws:
            welcome = _hub_hello(ws, "HubEric")
            assert welcome["type"] == "welcome"
            assert welcome["proto"] == 5 == appmod.HUB_PROTO
            pilot_id, token = welcome["pilot_id"], welcome["pilot_token"]
            assert pilot_id and token
        # Reconnecting with the stored token is the SAME pilot, not a new one.
        with c.websocket_connect("/ws/hub") as ws:
            again = _hub_hello(ws, "HubEric", token=token)
            assert again["type"] == "welcome"
            assert again["pilot_id"] == pilot_id
            assert again["pilot_token"] == token, "an existing token is echoed, never rotated"


def test_hub_refuses_a_callsign_another_pilot_holds_and_leaves_the_socket_open():
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/hub") as owner:
            _hub_hello(owner, "Taken")
            with c.websocket_connect("/ws/hub") as stranger:
                refused = _hub_hello(stranger, "taken")
                assert refused["type"] == "error"
                assert "Taken" in refused["detail"] and "another pilot" in refused["detail"]
                # Still open, and a different name works on the same socket.
                ok = _hub_hello(stranger, "NotTaken")
                assert ok["type"] == "welcome"


def test_hub_requires_hello_before_anything_else():
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/hub") as ws:
            ws.send_json({"type": "heartbeat"})
            msg = ws.receive_json()
            assert msg == {"type": "error", "detail": "hello first"}
            # Unchanged state: nobody is on the ramp.
            assert appmod.hub == {}


def test_hub_presence_lists_everyone_and_drops_a_pilot_who_disconnects():
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/hub") as a:
            _hub_hello(a, "PresA")
            with c.websocket_connect("/ws/hub") as b:
                _hub_hello(b, "PresB")
                assert _wait_until(lambda: len(appmod.hub) == 2)
                _time.sleep(1.2)                      # past the coalescing window
                b.send_json({"type": "where", "room": "friday", "activity": "racing"})
                frames = []

                def _got_the_update():
                    frames.extend(_hub_of(_drain_ws(a), "presence"))
                    return any(any(p["callsign"] == "PresB" and p["room"] == "friday"
                                   for p in f["pilots"]) for f in frames)
                assert _wait_until(_got_the_update)
                latest = [f for f in frames
                         if any(p["callsign"] == "PresB" and p["room"] == "friday" for p in f["pilots"])][-1]
                by = {p["callsign"]: p for p in latest["pilots"]}
                assert by["PresB"]["room"] == "friday" and by["PresB"]["activity"] == "racing"
                assert by["PresA"]["room"] is None and by["PresA"]["activity"] == "idle"
            # B's socket closed: they come off the list.
            assert _wait_until(lambda: len(appmod.hub) == 1)


def test_hub_where_rejects_a_bad_room_code_and_never_rewrites_it():
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/hub") as ws:
            _hub_hello(ws, "WhereEric")           # consumes welcome+presence+rooms already
            ws.send_json({"type": "where", "room": "Friday Night!", "activity": "gate"})
            # A refusal sends exactly one frame (no flush follows it) — nothing else to drain.
            err = ws.receive_json()
            assert err["type"] == "error" and "not a room code" in err["detail"]
            # Refused, not silently slugged into something the pilot did not type.
            assert appmod.hub[next(iter(appmod.hub))].room is None


def test_hub_presence_is_coalesced_to_at_most_one_push_per_second_per_client():
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/hub") as a, c.websocket_connect("/ws/hub") as b:
            _hub_hello(a, "CoalA")
            _hub_hello(b, "CoalB")
            assert _wait_until(lambda: len(appmod.hub) == 2)
            _time.sleep(1.1)
            _drain_ws(a)
            start = _time.time()
            for i in range(10):                      # a busy ramp: ten changes inside one second
                b.send_json({"type": "where", "room": "coalroom", "activity": "gate" if i % 2 else "solo"})
            _time.sleep(0.4)
            elapsed = _time.time() - start
            pushes = len(_hub_of(_drain_ws(a), "presence"))
            assert elapsed < 1.0, "the burst has to land inside one window for this to mean anything"
            assert pushes <= 1, f"ten changes in {elapsed:.2f}s produced {pushes} pushes"
            # …and the held-back state is not lost: the 1 Hz loop delivers it.
            assert _wait_until(lambda: len(_hub_of(_drain_ws(a), "presence")) >= 1, timeout=3.0)


def test_a_second_connection_for_the_same_pilot_replaces_the_first():
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/hub") as first:
            welcome = _hub_hello(first, "DoubleEric")
            token = welcome["pilot_token"]
            with c.websocket_connect("/ws/hub") as second:
                again = _hub_hello(second, "DoubleEric", token=token)
                assert again["pilot_id"] == welcome["pilot_id"]
                # One pilot, one entry on the ramp — not the same person listed twice.
                assert _wait_until(lambda: len(appmod.hub) == 1)


def test_hub_list_answers_immediately_with_presence_and_rooms():
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/hub") as ws:
            _hub_hello(ws, "ListEric")
            _drain_ws(ws)
            ws.send_json({"type": "list"})
            got = {f["type"] for f in [ws.receive_json(), ws.receive_json()]}
            assert got == {"presence", "rooms"}


def test_hub_rejects_junk_and_race_only_frames_without_closing():
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/hub") as ws:
            _hub_hello(ws, "JunkEric")
            _drain_ws(ws)
            # The hub has its own vocabulary: a race frame is simply not a word it knows.
            ws.send_json({"type": "fire", "item": "missile"})
            assert ws.receive_json()["type"] == "error"
            ws.send_json({"type": "where", "activity": "teleporting"})
            assert ws.receive_json()["type"] == "error"
            # Still alive and still identified.
            ws.send_json({"type": "list"})
            assert _hub_of([ws.receive_json(), ws.receive_json()], "presence")


def test_hub_oversized_frame_closes_the_connection():
    with TestClient(appmod.app) as c:
        with pytest.raises(Exception):
            with c.websocket_connect("/ws/hub") as ws:
                _hub_hello(ws, "BigEric")
                ws.send_json({"type": "where", "room": "x" * 4000, "activity": "idle"})
                for _ in range(5):
                    ws.receive_json()


def test_the_hub_loop_stops_when_the_last_pilot_leaves():
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/hub") as ws:
            _hub_hello(ws, "LoopEric")
            assert _wait_until(lambda: appmod._hub_task is not None)
        assert _wait_until(lambda: appmod._hub_task is None and not appmod.hub)


# ---------------------------------------------------- room registry (1.2.0, proto 5)
# A room self-registers on its first join and stays listed for REGISTRY_TTL_S after its last
# pilot leaves, so a reopen returns to the same code. Live fields are projected fresh from
# `rooms` every time; the registry itself only remembers what survives an empty room.

def test_room_status_line_reports_the_countdown_and_the_leaders_progress():
    room = appmod.Room("statusroom")
    assert appmod.room_status_line(room, 0) == "", "nothing to say about an open lobby"
    room.phase = "countdown"
    room.countdown_start_at_ms = 10_000
    assert appmod.room_status_line(room, 6_000) == "starts in 4s"
    assert appmod.room_status_line(room, 10_500) == "starts in 0s", "never negative"
    room.phase = "racing"
    room.course = {"course_id": "c", "course_hash": "0a1b2c3d", "name": "C",
                   "start_type": "air", "gates": 5}
    room.players["Leader"] = appmod.Player(None, "Leader")
    room.players["Leader"].gate = 3
    room.players["Second"] = appmod.Player(None, "Second")
    room.players["Second"].gate = 2
    assert appmod.room_status_line(room, 0) == "gate 3 of 5 — Leader leads"
    room.course["gates"] = None
    assert appmod.room_status_line(room, 0) == "gate 3 — Leader leads", "no total without it"


def test_registry_projection_reports_format_and_live_room_shape():
    room = appmod.Room("projroom")
    room.host = "Steve"
    room.players["Steve"] = appmod.Player(None, "Steve")
    proj = appmod.registry_projection(room, 0)
    assert proj["host"] == "Steve" and proj["pilots"] == 1 and proj["callsigns"] == ["Steve"]
    assert proj["format"] == "race" and proj["status"] == "boarding"
    room.cup = {"id": None, "name": "Cup", "race_count": 3, "race_no": 0, "points": {}}
    assert appmod.registry_projection(room, 0)["format"] == "cup"


def test_a_room_registers_on_first_join_and_is_listed():
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/race/regroom") as ws:
            _join(ws, "RegPilot")
            rows = appmod.registry_rows(_time.monotonic())
            row = next(r for r in rows if r["code"] == "regroom")
            assert row["host"] == "RegPilot" and row["pilots"] == 1
            assert row["callsigns"] == ["RegPilot"] and row["status"] == "boarding"


def test_a_room_stays_listed_for_the_ttl_after_it_empties_then_expires():
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/race/ttlroom") as ws:
            _join(ws, "TtlHost")
        # The Room object itself is gone (unchanged 1.1.0 behavior; teardown runs asynchronously
        # after the socket's own context manager exits, hence the wait)...
        assert _wait_until(lambda: "ttlroom" not in appmod.rooms)
        # ...but the registry still lists it, empty, with what it last looked like.
        now = _time.monotonic()
        row = next(r for r in appmod.registry_rows(now) if r["code"] == "ttlroom")
        assert row["status"] == "empty" and row["host"] == "TtlHost" and row["pilots"] == 0
        # Past the TTL, it is gone for good.
        assert not any(r["code"] == "ttlroom" for r in appmod.registry_rows(now + appmod.REGISTRY_TTL_S + 1))
        assert "ttlroom" not in appmod.registry


def test_a_reopen_inside_the_window_keeps_the_code_and_the_original_host():
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/race/reoproom") as ws:
            _join(ws, "OrigHost")
        assert _wait_until(lambda: "reoproom" not in appmod.rooms)
        entry_before = appmod.registry["reoproom"]
        assert entry_before.emptied_at is not None
        # The same host reopens it before the window elapses.
        with c.websocket_connect("/ws/race/reoproom") as ws2:
            _join(ws2, "OrigHost")
            # Same entry object, not a fresh one — the code was never actually forgotten.
            assert appmod.registry["reoproom"] is entry_before
            assert appmod.registry["reoproom"].emptied_at is None
            row = next(r for r in appmod.registry_rows(_time.monotonic()) if r["code"] == "reoproom")
            assert row["host"] == "OrigHost" and row["status"] == "boarding"


def test_registry_expiry_does_not_touch_a_room_that_is_still_occupied():
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/race/liveroom") as ws:
            _join(ws, "StillHere")
            # A stale-looking emptied_at on a room that is, in fact, live must never expire it —
            # rooms.get() finding a live Room is what registry_rows treats as ground truth.
            appmod.registry["liveroom"].emptied_at = _time.monotonic() - appmod.REGISTRY_TTL_S - 1
            rows = appmod.registry_rows(_time.monotonic())
            row = next(r for r in rows if r["code"] == "liveroom")
            assert row["status"] == "boarding" and row["pilots"] == 1


def test_the_rooms_frame_over_the_hub_lists_a_race_room():
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/race/hubvisroom") as race_ws:
            _join(race_ws, "HubVisible")
            with c.websocket_connect("/ws/hub") as hub_ws:
                welcome = _hub_hello(hub_ws, "Watcher")
                hub_ws.send_json({"type": "list"})
                frames = [hub_ws.receive_json(), hub_ws.receive_json()]
                rooms_frame = next(f for f in frames if f["type"] == "rooms")
                row = next(r for r in rooms_frame["rooms"] if r["code"] == "hubvisroom")
                assert row["host"] == "HubVisible" and row["pilots"] == 1


# ---------------------------------------------------- ping the ramp (1.2.0, proto 5)
# Deliberately scarce: a per-pilot daily cap plus a cooldown, both stored ON the pilots row so a
# redeploy cannot hand everyone their budget back.

def test_ramp_reset_in_s_counts_down_to_the_next_utc_minus_7_midnight():
    utc_morning = _dt.datetime(2026, 3, 5, 6, 30, tzinfo=_dt.timezone.utc).timestamp()
    # 07:00 UTC is midnight in UTC-7, so from 06:30 UTC that is 1800s away.
    assert appmod.ramp_reset_in_s(utc_morning) == 1800
    assert appmod.ramp_reset_in_s(utc_morning + 1800) == 86400, "landing exactly on it wraps to the next one"


def test_hm_formats_minutes_and_drops_the_hours_when_there_are_none():
    assert appmod._hm(90) == "1m"
    assert appmod._hm(4 * 3600 + 12 * 60) == "4h 12m"
    assert appmod._hm(-5) == "0m", "never negative"


def test_try_ramp_ping_enforces_the_cooldown_then_the_daily_cap(tmp_path):
    conn = _migrated(_fresh_db(tmp_path))
    pilot_id, _ = appmod.issue_pilot(conn, "Ramper")
    conn.commit()
    now = 1_700_000_000.0
    ok, err = appmod.try_ramp_ping(conn, pilot_id, now)
    assert ok and err is None
    # Immediately again: refused by the 60s cooldown, not the daily cap.
    ok, err = appmod.try_ramp_ping(conn, pilot_id, now + 1)
    assert not ok and "again in" in err
    # Past the cooldown, twice more exhausts the default daily budget of 3.
    ok, _ = appmod.try_ramp_ping(conn, pilot_id, now + appmod.RAMP_COOLDOWN_S + 1)
    assert ok
    ok, _ = appmod.try_ramp_ping(conn, pilot_id, now + 2 * (appmod.RAMP_COOLDOWN_S + 1))
    assert ok
    ok, err = appmod.try_ramp_ping(conn, pilot_id, now + 3 * (appmod.RAMP_COOLDOWN_S + 1))
    assert not ok and "out of ramp pings" in err and "3" in err


def test_try_ramp_ping_resets_the_count_on_a_new_local_day(tmp_path):
    conn = _migrated(_fresh_db(tmp_path))
    pilot_id, _ = appmod.issue_pilot(conn, "NextDay")
    conn.commit()
    day1 = _dt.datetime(2026, 3, 5, 12, 0, tzinfo=_dt.timezone.utc).timestamp()
    for i in range(appmod.RAMP_PING_PER_DAY):
        ok, _ = appmod.try_ramp_ping(conn, pilot_id, day1 + i * (appmod.RAMP_COOLDOWN_S + 1))
        assert ok
    ok, err = appmod.try_ramp_ping(conn, pilot_id, day1 + appmod.RAMP_PING_PER_DAY * (appmod.RAMP_COOLDOWN_S + 1))
    assert not ok
    # A day later (and past the cooldown), the budget is back.
    day2 = day1 + 86400
    ok, err = appmod.try_ramp_ping(conn, pilot_id, day2)
    assert ok, err


def test_ramp_ping_broadcasts_to_everyone_but_the_sender():
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/hub") as a, c.websocket_connect("/ws/hub") as b:
            _hub_hello(a, "RampA")
            _hub_hello(b, "RampB")
            a.send_json({"type": "ping_ramp"})
            frames = []

            def _b_saw_it():
                frames.extend(_hub_of(_drain_ws(b), "ramp_ping"))
                return any(f["from"] == "RampA" for f in frames)
            assert _wait_until(_b_saw_it)
            # The sender never gets one addressed to itself — only a presence/rooms churn, if any.
            assert not any(f["from"] == "RampA" for f in _hub_of(_drain_ws(a), "ramp_ping"))


def test_ramp_ping_over_the_cooldown_is_a_named_error_to_the_sender_only():
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/hub") as sender, c.websocket_connect("/ws/hub") as observer:
            _hub_hello(sender, "CappedRamper")
            _hub_hello(observer, "Observer")
            sender.send_json({"type": "ping_ramp"})
            # Confirmed via the observer, since a successful ping sends nothing back to the sender.
            assert _wait_until(lambda: any(f["from"] == "CappedRamper"
                                           for f in _hub_of(_drain_ws(observer), "ramp_ping")))
            sender.send_json({"type": "ping_ramp"})
            err = sender.receive_json()
            assert err["type"] == "error" and "again in" in err["detail"]


# ---------------------------------------------------- free-text lobby chat (1.2.0, proto 5)
# On the RACE socket, not the hub. Proto 2's chat{code} enum is untouched; chat{text} is a second
# shape on the same frame name, delivered only to connections that proved proto 5.

def test_sanitize_chat_strips_control_characters_and_collapses_whitespace():
    assert appmod.sanitize_chat("hello   there") == "hello there"
    assert appmod.sanitize_chat("  padded  ") == "padded"
    # Newlines, tabs and terminal escapes all go: a chat line can never move a cursor or lie
    # about a status line.
    assert appmod.sanitize_chat("two\nlines") == "two lines"
    assert appmod.sanitize_chat("tab\there") == "tab here"
    assert appmod.sanitize_chat("esc\x1b[31mred") == "esc[31mred"
    assert appmod.sanitize_chat("nul\x00byte") == "nulbyte"
    # Nothing left worth repeating is None, not an empty string.
    assert appmod.sanitize_chat("") is None
    assert appmod.sanitize_chat("   ") is None
    assert appmod.sanitize_chat("\x00\x01") is None
    assert appmod.sanitize_chat(None) is None


def test_sanitize_chat_truncates_rather_than_refusing():
    long_line = "x" * 500
    out = appmod.sanitize_chat(long_line, appmod.CHAT_MAX_CHARS)
    assert len(out) == appmod.CHAT_MAX_CHARS == 240
    assert out == "x" * 240


def test_chat_msg_needs_exactly_one_of_code_or_text():
    assert appmod.parse_message({"type": "chat", "code": "gg"}).code == "gg"
    assert appmod.parse_message({"type": "chat", "text": "hi"}).text == "hi"
    for bad in ({"type": "chat"},
                {"type": "chat", "code": "gg", "text": "hi"},
                {"type": "chat", "code": "not_a_code"}):
        with pytest.raises(Exception):
            appmod.parse_message(bad)


def test_free_text_chat_reaches_proto_5_clients_and_never_an_old_one():
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/race/chatroom") as new_a, \
             c.websocket_connect("/ws/race/chatroom") as new_b, \
             c.websocket_connect("/ws/race/chatroom") as old:
            # A pilot_token on the join is what marks a connection as proto 5.
            new_a.send_json({"type": "join", "callsign": "NewA", "pilot_token": "tok-a"})
            assert _recv(new_a)["type"] == "joined"
            new_b.send_json({"type": "join", "callsign": "NewB", "pilot_token": "tok-b"})
            assert _recv(new_b)["type"] == "joined"
            _join(old, "OldClient")            # no token: a 1.1.0 join
            assert appmod.rooms["chatroom"].players["NewA"].proto5 is True
            assert appmod.rooms["chatroom"].players["OldClient"].proto5 is False

            new_a.send_json({"type": "chat", "text": "  line   one  "})
            # The sender is included, and the text arrives sanitized.
            mine = _of(_drain(new_a), "chat")[-1]
            assert mine == {"type": "chat", "from": "NewA", "text": "line one"}
            theirs = _of(_drain(new_b), "chat")[-1]
            assert theirs == {"type": "chat", "from": "NewA", "text": "line one"}
            # The old client gets nothing of the sort — its `chat` handler would render "?: ".
            assert _of(_drain(old), "chat") == []


def test_the_fixed_enum_chat_path_is_unchanged_and_still_reaches_old_clients():
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/race/enumchatroom") as old, \
             c.websocket_connect("/ws/race/enumchatroom") as new:
            _join(old, "EnumOld")
            new.send_json({"type": "join", "callsign": "EnumNew", "pilot_token": "tok"})
            assert _recv(new)["type"] == "joined"
            new.send_json({"type": "chat", "code": "gg"})
            # Proto 2's shape, to the whole room including the old client, unchanged. The sender is
            # drained first: its pong proves the chat was handled (and broadcast) before `old` is read.
            assert _of(_drain(new), "chat")[-1] == {"type": "chat", "callsign": "EnumNew", "code": "gg"}
            assert _of(_drain(old), "chat")[-1] == {"type": "chat", "callsign": "EnumNew", "code": "gg"}


def test_free_text_chat_has_its_own_rate_limit_separate_from_the_socket():
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/race/chatrateroom") as ws:
            ws.send_json({"type": "join", "callsign": "Chatty", "pilot_token": "tok"})
            assert _recv(ws)["type"] == "joined"
            for i in range(appmod.CHAT_BURST + 2):
                ws.send_json({"type": "chat", "text": f"line {i}"})
            frames = _drain(ws)
            delivered = _of(frames, "chat")
            errors = [f for f in frames if f["type"] == "error"]
            # The burst goes through, the rest is refused — and refusal is an error, not a close.
            assert len(delivered) == appmod.CHAT_BURST
            assert errors and all("chat rate limited" in e["detail"] for e in errors)
            # The socket itself is well under its own 20/s, so this limit is genuinely separate.
            ws.send_json({"type": "ping", "t0": 1.0})
            assert _recv(ws, skip=("lobby", "world", "box_state", "chat", "error", "vote"))["type"] == "pong"


def test_an_all_control_character_chat_line_is_refused_not_broadcast():
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/race/emptychatroom") as ws:
            ws.send_json({"type": "join", "callsign": "Blank", "pilot_token": "tok"})
            assert _recv(ws)["type"] == "joined"
            ws.send_json({"type": "chat", "text": "\x00\x01  \x1b"})
            frames = _drain(ws)
            assert _of(frames, "chat") == []
            assert any(f["type"] == "error" and "empty chat line" in f["detail"] for f in frames)


def test_chat_is_never_written_to_the_database():
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/race/nopersistroom") as ws:
            ws.send_json({"type": "join", "callsign": "Secretive", "pilot_token": "tok"})
            assert _recv(ws)["type"] == "joined"
            ws.send_json({"type": "chat", "text": "mysecretchatline"})
            assert _of(_drain(ws), "chat")[-1]["text"] == "mysecretchatline"
    # Nothing anywhere in the schema holds it. Scan every table's every text column.
    with appmod.connect() as conn:
        tables = [r["name"] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")]
        for t in tables:
            rows = conn.execute(f"SELECT * FROM {t}").fetchall()
            for row in rows:
                assert "mysecretchatline" not in " ".join(str(v) for v in tuple(row))


# ---------------------------------------------------- spectating and the course vote (proto 5)

class _FixedRng:
    """A stand-in for `random` that returns the values a test hands it, so a weighted draw and a
    tie-break can be asserted exactly rather than statistically."""
    def __init__(self, randoms=(), randranges=()):
        self._randoms, self._randranges = list(randoms), list(randranges)

    def random(self):
        return self._randoms.pop(0)

    def randrange(self, n):
        return self._randranges.pop(0) % n


def _stats(*ids):
    return [{"course_id": i, "course_hash": f"{n:08x}", "course_name": i.title(), "runs": 1}
            for n, i in enumerate(ids)]


def test_vote_weights_favour_what_the_room_has_raced_least():
    stats = _stats("fresh", "flogged")
    weights = dict((c["course_id"], w) for c, w in appmod.vote_weights(stats, {"flogged": 19}))
    assert weights["fresh"] == 1.0, "nobody present has flown it"
    assert weights["flogged"] == 0.05, "1/(1+19)"
    # Unknown courses default to unseen, i.e. full weight.
    assert dict((c["course_id"], w) for c, w in appmod.vote_weights(stats, {}))["flogged"] == 1.0


def test_vote_candidates_draws_n_distinct_plus_the_surprise_me_wildcard():
    stats = _stats("a", "b", "c", "d", "e")
    picks = appmod.vote_candidates(stats, {}, 3, _FixedRng(randoms=[0.0, 0.0, 0.0]))
    assert len(picks) == 4, "three candidates plus the wildcard"
    assert picks[-1]["course_id"] == appmod.SURPRISE_ME
    ids = [c["course_id"] for c in picks[:-1]]
    assert len(set(ids)) == 3, "distinct: a course cannot be drawn twice"
    # roll 0.0 always lands in the first remaining bucket, so this is the pool order.
    assert ids == ["a", "b", "c"]


def test_vote_candidates_with_a_thin_catalog_offers_what_it_has():
    picks = appmod.vote_candidates(_stats("only"), {}, 3, _FixedRng(randoms=[0.0]))
    assert [c["course_id"] for c in picks] == ["only", appmod.SURPRISE_ME]
    # A server with nothing posted yet has nothing to offer but the wildcard.
    assert [c["course_id"] for c in appmod.vote_candidates([], {}, 3)] == [appmod.SURPRISE_ME]


def test_vote_winner_takes_the_most_votes():
    cands = _stats("a", "b")
    votes = {"P1": "a", "P2": "b", "P3": "b"}
    assert appmod.vote_winner(votes, cands, {})["course_id"] == "b"
    assert appmod.vote_winner({}, cands, {}) is None, "nobody voted"
    # A vote for something that is not a candidate is not counted.
    assert appmod.vote_winner({"P1": "ghost"}, cands, {}) is None


def test_vote_winner_breaks_a_tie_toward_the_least_raced_then_the_rng():
    cands = _stats("a", "b")
    tied = {"P1": "a", "P2": "b"}
    # 'a' has been flown more, so the tie goes to 'b' with no rng involved.
    assert appmod.vote_winner(tied, cands, {"a": 10, "b": 2})["course_id"] == "b"
    # Equally raced: the rng decides, never dict or draw order.
    assert appmod.vote_winner(tied, cands, {"a": 5, "b": 5}, _FixedRng(randranges=[1]))["course_id"] == "b"
    assert appmod.vote_winner(tied, cands, {"a": 5, "b": 5}, _FixedRng(randranges=[0]))["course_id"] == "a"


def _seed_courses(c):
    """The vote's pool is the shared course list (race/courses, via RACE_COURSES_DIR), so there is
    nothing to seed any more; returns the ids a room can be offered."""
    return [row["course_id"] for row in appmod.COURSES]


def test_a_vote_can_be_changed_and_a_non_candidate_is_refused():
    with TestClient(appmod.app) as c:
        _seed_courses(c)
        with c.websocket_connect("/ws/race/voteroom") as ws:
            _join(ws, "Voter")
            room = appmod.rooms["voteroom"]
            assert room.vote_candidates, "the room drew candidates on its first join"
            real = [c2["course_id"] for c2 in room.vote_candidates
                    if c2["course_id"] != appmod.SURPRISE_ME]
            assert len(real) >= 2, "the seeded catalog should offer at least two real courses"
            first, second = real[0], real[1]
            ws.send_json({"type": "vote", "course_id": first})
            assert _of(_drain(ws), "vote")[-1]["votes"] == {"Voter": first}
            # One active vote each: voting again replaces it rather than adding one.
            ws.send_json({"type": "vote", "course_id": second})
            assert _of(_drain(ws), "vote")[-1]["votes"] == {"Voter": second}
            assert len(room.votes) == 1
            # Server-authoritative: a client cannot nominate a course of its own.
            ws.send_json({"type": "vote", "course_id": "not-a-candidate"})
            errs = [f for f in _drain(ws) if f["type"] == "error"]
            assert errs and "not a candidate" in errs[-1]["detail"]


def test_the_vote_wins_only_when_the_host_set_no_course():
    with TestClient(appmod.app) as c:
        _seed_courses(c)
        # (a) No host course: the winner becomes the room's course and is announced.
        with c.websocket_connect("/ws/race/votewinroom") as ws:
            _join(ws, "VoteHost")
            room = appmod.rooms["votewinroom"]
            pick = next(c2["course_id"] for c2 in room.vote_candidates
                        if c2["course_id"] != appmod.SURPRISE_ME)
            ws.send_json({"type": "vote", "course_id": pick})
            _drain(ws)
            ws.send_json({"type": "ready", "ready": True})
            ws.send_json({"type": "start", "lead_s": 5})
            start = _of(_drain(ws), "start")[-1]
            assert start["vote"] is not None
            assert start["vote"]["course_id"] == pick
            assert room.course["course_id"] == pick, "the vote supplied the course"
        # (b) Host picked one by hand: the vote is announced as nothing and the host's course runs.
        with c.websocket_connect("/ws/race/hostwinroom") as ws:
            _join(ws, "HandPicker")
            room = appmod.rooms["hostwinroom"]
            pick = next(c2["course_id"] for c2 in room.vote_candidates
                        if c2["course_id"] != appmod.SURPRISE_ME)
            ws.send_json({"type": "vote", "course_id": pick})
            ws.send_json(_course())               # starter-sprint-seatac, by hand
            ws.send_json({"type": "ready", "ready": True})
            ws.send_json({"type": "start", "lead_s": 5})
            start = _of(_drain(ws), "start")[-1]
            assert start["vote"] is None, "a hand-picked course beats the vote"
            assert room.course["course_id"] == "starter-sprint-seatac"


def test_voting_closes_once_the_room_launches():
    with TestClient(appmod.app) as c:
        _seed_courses(c)
        with c.websocket_connect("/ws/race/voteclosedroom") as ws:
            _join(ws, "Latecomer")
            room = appmod.rooms["voteclosedroom"]
            pick = next(c2["course_id"] for c2 in room.vote_candidates
                        if c2["course_id"] != appmod.SURPRISE_ME)
            ws.send_json(_course())
            ws.send_json({"type": "ready", "ready": True})
            ws.send_json({"type": "start", "lead_s": 5})
            assert _wait_until(lambda: room.phase == "countdown")
            _drain(ws)
            ws.send_json({"type": "vote", "course_id": pick})
            errs = [f for f in _drain(ws) if f["type"] == "error"]
            assert errs and "voting is closed" in errs[-1]["detail"]


# ---- spectating

def test_an_opt_in_spectator_is_out_of_the_ranking_but_still_gets_the_standings():
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/race/specroom") as racer, \
             c.websocket_connect("/ws/race/specroom") as watcher:
            _join(racer, "Racer")
            watcher.send_json({"type": "join", "callsign": "Watcher", "spectate": True})
            assert _recv(watcher)["type"] == "joined"
            room = appmod.rooms["specroom"]
            assert room.players["Watcher"].spectate is True
            assert room.players["Watcher"].role == "spectator"
            # Asking to spectate also proves proto 5 — no older client knew the field.
            assert room.players["Watcher"].proto5 is True
            racer.send_json({"type": "pos", "lat": 45.0, "lon": -122.0, "gate": 1, "elapsed_ms": 100})
            # The pos arrives on the racer's socket; draining the watcher only orders against its own.
            assert _wait_until(lambda: room.players["Racer"].gate == 1)
            standings = _of(_drain(watcher), "standings")[-1]
            # In the frame, out of the order: the whole point of spectating.
            assert standings["order"] == ["Racer"]
            assert room.ranking() == ["Racer"]


def test_a_spectator_is_refused_the_frames_that_mean_racing():
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/race/specrefuseroom") as ws:
            ws.send_json({"type": "join", "callsign": "Bystander", "spectate": True})
            assert _recv(ws)["type"] == "joined"
            for frame, kind in ((
                    {"type": "pos", "lat": 45.0, "lon": -122.0, "gate": 1, "elapsed_ms": 1}, "pos"),
                    ({"type": "box", "id": 0}, "box"),
                    ({"type": "fire", "item": "missile"}, "fire")):
                ws.send_json(frame)
                errs = [f for f in _drain(ws) if f["type"] == "error"]
                assert errs and f"spectators cannot send {kind}" in errs[-1]["detail"], kind
            # Refused, never closed — and the room never took their position.
            assert appmod.rooms["specrefuseroom"].players["Bystander"].lat is None


def test_a_spectator_is_off_the_grid_and_never_holds_up_a_start():
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/race/specgridroom") as racer, \
             c.websocket_connect("/ws/race/specgridroom") as watcher:
            _join(racer, "OnGrid")
            watcher.send_json({"type": "join", "callsign": "OffGrid", "spectate": True})
            assert _recv(watcher)["type"] == "joined"
            racer.send_json(_course())
            racer.send_json({"type": "ready", "ready": True})
            # The spectator never readied, and the start is NOT refused for it.
            racer.send_json({"type": "start", "lead_s": 5})
            start = _of(_drain(racer), "start")[-1]
            assert start["racers"] == ["OnGrid"], "a spectator is not on the grid"
            room = appmod.rooms["specgridroom"]
            assert room.race is not None and list(room.race.racers) == ["OnGrid"]
            # back_to_lobby puts racers back but leaves an opt-in spectator spectating.
            racer.send_json({"type": "back_to_lobby"})
            assert _wait_until(lambda: room.phase == "lobby")
            assert room.players["OffGrid"].role == "spectator"
            assert room.players["OnGrid"].role == "racer"


def test_spectators_do_not_count_toward_the_pilot_cap(monkeypatch):
    monkeypatch.setattr(appmod, "ROOM_MAX_PILOTS", 2)
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/race/caproom") as p1, \
             c.websocket_connect("/ws/race/caproom") as p2, \
             c.websocket_connect("/ws/race/caproom") as watcher, \
             c.websocket_connect("/ws/race/caproom") as p3:
            _join(p1, "Cap1")
            _join(p2, "Cap2")
            # The cap is full of PILOTS, but a spectator walks straight past it.
            watcher.send_json({"type": "join", "callsign": "CapWatcher", "spectate": True})
            assert _recv(watcher)["type"] == "joined"
            # A third pilot is refused, by name and with the number.
            p3.send_json({"type": "join", "callsign": "Cap3"})
            refusal = _recv(p3)
            assert refusal["type"] == "error" and "room is full (2 pilots)" in refusal["detail"]
            assert set(appmod.rooms["caproom"].players) == {"Cap1", "Cap2", "CapWatcher"}


def test_a_mid_race_joiner_still_behaves_exactly_as_it_did_in_1_1_0():
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/race/oldspecroom") as host, \
             c.websocket_connect("/ws/race/oldspecroom") as late:
            _join(host, "MidHost")
            host.send_json(_course())
            host.send_json({"type": "ready", "ready": True})
            host.send_json({"type": "start", "lead_s": 5})
            room = appmod.rooms["oldspecroom"]
            assert _wait_until(lambda: room.phase == "countdown")
            _join(late, "MidJoiner")
            p = room.players["MidJoiner"]
            # proto 2's automatic spectator role, NOT the opt-in flag...
            assert p.role == "spectator" and p.spectate is False
            # ...so they are still ranked, and their pos is still accepted rather than refused.
            late.send_json({"type": "pos", "lat": 45.0, "lon": -122.0, "gate": 1, "elapsed_ms": 10})
            assert _wait_until(lambda: p.lat == 45.0)
            assert "MidJoiner" in room.ranking()
            assert not [f for f in _drain(late) if f["type"] == "error"]


# ------------------------------------------------------------ modes (proto 6)
# mode_runs holds every mode's runs; `race` is also still in the legacy `runs` table, which every
# pre-6 endpoint reads unchanged. Ranking direction comes from the registry, never assumed.
import dataclasses
import migrate_modes as mm


class _DescPayload(appmod.BaseModel):
    """A test-only payload for a test-only desc mode (M1's original client-scored landing shape)."""
    model_config = appmod.ConfigDict(extra="forbid")
    vs_fpm: float = appmod.Field(ge=-3000, le=0)
    centerline_m: float = appmod.Field(ge=0, le=500)
    float_m: float = appmod.Field(ge=0, le=5000)
    bounces: int = appmod.Field(ge=0, le=20)


@pytest.fixture
def desc_mode(monkeypatch):
    """Registers `testdesc`, a generic client-posted desc mode. The real `landing` mode is
    server-scored and refuses POST /modes/landing/runs, so the direction machinery is exercised
    on this instead."""
    monkeypatch.setitem(appmod.MODES, "testdesc",
                        appmod.ModeSpec("testdesc", "score", "desc", _DescPayload, 0, 1000))
    return "testdesc"


def descrun(**kw):
    base = dict(course_id="landing-ksea", course_hash="1a2b3c4d", callsign="Lander", metric_value=700,
                payload={"vs_fpm": -120, "centerline_m": 1.5, "float_m": 150, "bounces": 0})
    base.update(kw); return base


def test_direction_sql_maps_only_the_two_legal_directions_onto_fixed_keywords():
    assert appmod.direction_sql("asc") == ("MIN", "ASC", "<")
    assert appmod.direction_sql("desc") == ("MAX", "DESC", ">")
    for bad in ("ASC", "", "asc; DROP TABLE runs", None):
        with pytest.raises(ValueError):
            appmod.direction_sql(bad)
    assert appmod.is_better("asc", 1, 2) and not appmod.is_better("asc", 2, 1)
    assert appmod.is_better("desc", 2, 1) and not appmod.is_better("desc", 1, 2)
    assert not appmod.is_better("asc", 5, 5) and not appmod.is_better("desc", 5, 5), "a tie is not better"
    assert appmod.is_better("asc", 5, None) and appmod.is_better("desc", 5, None)


def test_the_registry_declares_exactly_race_and_landing():
    assert set(appmod.MODES) == {"race", "landing"}
    race, land = appmod.MODES["race"], appmod.MODES["landing"]
    assert (race.metric_name, race.direction) == ("elapsed_ms", "asc")
    assert (land.metric_name, land.direction) == ("score", "desc")
    with TestClient(appmod.app) as c:
        modes = {m["id"]: m for m in c.get("/modes").json()}
        assert modes["landing"]["direction"] == "desc" and modes["race"]["direction"] == "asc"
        assert "touchdown" in modes["landing"]["payload_schema"]["properties"]
        assert "splits" in modes["race"]["payload_schema"]["properties"]


def test_a_desc_mode_ranks_higher_first_and_flipping_its_direction_flips_the_board(monkeypatch, desc_mode):
    h = "d1d2d3d4"
    with TestClient(appmod.app) as c:
        for cs, score in (("LowScore", 500), ("HighScore", 900), ("MidScore", 700)):
            r = c.post("/modes/testdesc/runs", json=descrun(course_hash=h, callsign=cs, metric_value=score))
            assert r.status_code == 200, r.text
        # The last post is ranked against the other two under desc: 900 beats it, 500 does not.
        assert r.json()["rank"] == 2 and r.json()["personal_best"] == 700
        board = c.get("/modes/testdesc/leaderboard", params={"course_hash": h}).json()
        assert board["direction"] == "desc" and board["metric_name"] == "score"
        assert [(x["rank"], x["callsign"]) for x in board["rows"]] == [
            (1, "HighScore"), (2, "MidScore"), (3, "LowScore")]

        # Same rows, direction flipped in the registry only: the board and the rank must follow.
        monkeypatch.setitem(appmod.MODES, "testdesc",
                            dataclasses.replace(appmod.MODES["testdesc"], direction="asc"))
        board = c.get("/modes/testdesc/leaderboard", params={"course_hash": h}).json()
        assert [x["callsign"] for x in board["rows"]] == ["LowScore", "MidScore", "HighScore"]
        with appmod.connect() as conn:
            assert appmod.mode_rank(conn, "testdesc", h, 700) == 2
            assert appmod.mode_rank(conn, "testdesc", h, 900) == 3
            assert appmod.mode_personal_best(conn, "testdesc", h, "HighScore") == 900


def test_a_desc_personal_best_keeps_the_highest_score(desc_mode):
    h = "e1e2e3e4"
    with TestClient(appmod.app) as c:
        first = c.post("/modes/testdesc/runs", json=descrun(course_hash=h, metric_value=600)).json()
        assert first["improved"] and first["personal_best"] == 600
        worse = c.post("/modes/testdesc/runs", json=descrun(course_hash=h, metric_value=400)).json()
        assert not worse["improved"] and worse["personal_best"] == 600, "lower is worse in a desc mode"
        better = c.post("/modes/testdesc/runs", json=descrun(course_hash=h, metric_value=800)).json()
        assert better["improved"] and better["personal_best"] == 800
        row = c.get("/modes/testdesc/leaderboard", params={"course_hash": h}).json()["rows"][0]
        assert (row["metric_value"], row["attempts"]) == (800, 3)
        assert set(row) == {"rank", "callsign", "metric_value", "created_at", "attempts"}, "no pilot_id on a public board"


def test_race_runs_land_in_both_tables_and_the_two_boards_agree():
    h = "f1f2f3f4"
    with TestClient(appmod.app) as c:
        for cs, t in (("Slow", 30000), ("Fast", 20000), ("Fast", 25000), ("Mid", 22000)):
            assert c.post("/runs", json=run(course_hash=h, callsign=cs, time_ms=t, splits=[t // 2, t])).status_code == 200
        legacy = c.get("/leaderboard", params={"course_hash": h}).json()
        modern = c.get("/modes/race/leaderboard", params={"course_hash": h}).json()
        assert modern["direction"] == "asc" and modern["metric_name"] == "elapsed_ms"
        assert [(x["callsign"], x["time_ms"], x["attempts"]) for x in legacy] == \
               [(x["callsign"], int(x["metric_value"]), x["attempts"]) for x in modern["rows"]] == \
               [("Fast", 20000, 2), ("Mid", 22000, 1), ("Slow", 30000, 1)]
        with appmod.connect() as conn:
            ids = {r[0] for r in conn.execute("SELECT id FROM runs WHERE course_hash = ?", (h,))}
            linked = {r[0] for r in conn.execute(
                "SELECT legacy_run_id FROM mode_runs WHERE course_hash = ? AND mode_id = 'race'", (h,))}
            assert ids == linked, "every dual-written race row points back at its legacy row"


def test_a_non_race_mode_run_never_appears_on_any_race_board(desc_mode):
    h = "a9a8a7a6"
    with TestClient(appmod.app) as c:
        assert c.post("/runs", json=run(course_hash=h, callsign="Racer", time_ms=20000,
                                         splits=[10000, 20000])).status_code == 200
        # Same course hash, same callsign, and a metric that would win outright under asc.
        for cs in ("Racer", "OnlyLands"):
            assert c.post("/modes/testdesc/runs", json=descrun(course_hash=h, callsign=cs,
                                                               metric_value=1)).status_code == 200
        assert [x["callsign"] for x in c.get("/leaderboard", params={"course_hash": h}).json()] == ["Racer"]
        race = c.get("/modes/race/leaderboard", params={"course_hash": h}).json()["rows"]
        assert [(x["callsign"], x["metric_value"], x["attempts"]) for x in race] == [("Racer", 20000, 1)]
        with appmod.connect() as conn:
            assert conn.execute("SELECT COUNT(*) FROM runs WHERE callsign = 'OnlyLands'").fetchone()[0] == 0
        # The race rank does not count landing pilots either.
        r = c.post("/runs", json=run(course_hash=h, callsign="Second", time_ms=25000, splits=[10000, 25000])).json()
        assert r["rank"] == 2
        land = c.get("/modes/testdesc/leaderboard", params={"course_hash": h}).json()["rows"]
        assert {x["callsign"] for x in land} == {"Racer", "OnlyLands"}


def test_a_posted_landing_is_a_landing_mode_run_and_never_reaches_a_race_board():
    rw = appmod.RUNWAYS["friday-harbor-16"]
    h = appmod.runway_hash(rw)
    with TestClient(appmod.app) as c:
        # A race run on the very course_hash the landing board uses, by the same callsign.
        assert c.post("/runs", json=run(course_hash=h, callsign="Both", time_ms=20000,
                                         splits=[10000, 20000])).status_code == 200
        mid = (rw["zone"]["min_m"] + rw["zone"]["max_m"]) / 2
        r = c.post("/landings", json=landing_attempt(runway_id=rw["id"], callsign="Both",
                                                     touchdown=touchdown_at(rw, mid, 0.0)))
        assert r.status_code == 200, r.text
        with appmod.connect() as conn:
            row = conn.execute("""SELECT course_id, course_hash, direction, metric_value, payload_json
                                  FROM mode_runs WHERE mode_id = 'landing' AND callsign = 'Both'""").fetchone()
        assert (row[0], row[1], row[2], row[3]) == (rw["id"], h, "desc", r.json()["score"])
        stored = json.loads(row[4])
        assert stored["touchdown"]["type"] == "touchdown" and stored["runway_version"] == rw["version"]
        assert stored["breakdown"] == r.json()["breakdown"]
        race = c.get("/modes/race/leaderboard", params={"course_hash": h}).json()["rows"]
        assert [(x["callsign"], x["metric_value"]) for x in race] == [("Both", 20000)]
        assert [x["callsign"] for x in c.get("/leaderboard", params={"course_hash": h}).json()] == ["Both"]
        assert len(c.get("/leaderboard", params={"course_hash": h}).json()) == 1


def test_a_client_scored_landing_is_refused_on_the_generic_endpoint():
    with TestClient(appmod.app) as c:
        r = c.post("/modes/landing/runs", json=descrun(course_hash="c0c0c0c0", metric_value=1000))
        assert r.status_code == 400 and "POST /landings" in r.json()["detail"]
        with appmod.connect() as conn:
            assert conn.execute("SELECT COUNT(*) FROM mode_runs WHERE course_hash = 'c0c0c0c0'").fetchone()[0] == 0


def test_mode_posts_are_validated_against_that_modes_schema(desc_mode):
    with TestClient(appmod.app) as c:
        assert c.post("/modes/race/runs", json=descrun()).status_code == 400, "race has one write path"
        assert c.post("/modes/nope/runs", json=descrun()).status_code == 404
        assert c.get("/modes/nope/leaderboard", params={"course_hash": H}).status_code == 404
        assert c.post("/modes/testdesc/runs", json=descrun(metric_value=1001)).status_code == 422
        assert c.post("/modes/testdesc/runs", json=descrun(metric_value=-1)).status_code == 422
        bad = descrun(); bad["payload"] = dict(bad["payload"], vs_fpm=500)
        assert c.post("/modes/testdesc/runs", json=bad).status_code == 422, "climbing is not a touchdown"
        extra = descrun(); extra["payload"] = dict(extra["payload"], elapsed_ms=1)
        assert c.post("/modes/testdesc/runs", json=extra).status_code == 422, "unknown payload keys are refused"
        assert c.post("/modes/testdesc/runs", json=descrun(callsign="  ")).status_code == 422


# ---- migrate_modes.py

def _legacy_db(path, with_pilot_id=False):
    """A pre-proto-6 race.db: the runs table exactly as SCHEMA creates it, a few rows in it."""
    if os.path.exists(path):
        os.remove(path)
    conn = sqlite3.connect(path)
    conn.executescript(appmod.SCHEMA)
    for i, (cs, t) in enumerate((("Old1", 30000), ("Old2", 25000), ("Old1", 28000))):
        conn.execute(
            """INSERT INTO runs (course_id, course_hash, course_name, callsign, aircraft_id, model,
               time_ms, splits, gates, length_m, client_version, ip, created_at)
               VALUES ('old-course', 'b1b2b3b4', 'Old', ?, 'a', 'm', ?, ?, 3, 4000, '0.1', '', ?)""",
            (cs, t, json.dumps([t // 2, t]), 1000 + i))
    if with_pilot_id:
        conn.row_factory = sqlite3.Row      # migrate() reads columns by name, as app.connect() does
        appmod.migrate(conn)
        conn.row_factory = None
    conn.commit()
    return conn


def _snapshot_runs(conn):
    return (conn.execute("SELECT sql FROM sqlite_master WHERE name = 'runs'").fetchone(),
            conn.execute("PRAGMA table_info(runs)").fetchall(),
            conn.execute("SELECT * FROM runs ORDER BY id").fetchall())


def test_migrate_modes_backfills_once_and_is_a_no_op_the_second_time(tmp_path):
    conn = _legacy_db(str(tmp_path / "legacy.db"))
    before = _snapshot_runs(conn)
    sql = []
    conn.set_trace_callback(sql.append)
    with conn:
        assert mm.migrate_modes(conn) == {"backfilled": 3, "present": 0}
    with conn:
        assert mm.migrate_modes(conn) == {"backfilled": 0, "present": 3}
    conn.set_trace_callback(None)
    assert _snapshot_runs(conn) == before, "the legacy table's schema and rows are untouched"
    for stmt in sql:
        head = stmt.lstrip().split(None, 1)[0].upper() if stmt.strip() else ""
        assert head not in ("DROP", "ALTER", "UPDATE", "DELETE"), stmt
    rows = conn.execute("""SELECT mode_id, direction, callsign, metric_value, course_hash, created_at,
                                  payload_json, pilot_id FROM mode_runs ORDER BY legacy_run_id""").fetchall()
    assert [r[:6] for r in rows] == [("race", "asc", "Old1", 30000, "b1b2b3b4", 1000),
                                     ("race", "asc", "Old2", 25000, "b1b2b3b4", 1001),
                                     ("race", "asc", "Old1", 28000, "b1b2b3b4", 1002)]
    assert json.loads(rows[0][6]) == {"splits": [15000, 30000], "gates": 3, "length_m": 4000,
                                      "model": "m", "aircraft_id": "a"}
    assert rows[0][7] is None, "a database without runs.pilot_id backfills NULL, not an error"


def test_migrate_modes_copies_pilot_id_and_the_cli_is_safe_to_run_twice(tmp_path, capsys):
    path = str(tmp_path / "legacy.db")
    conn = _legacy_db(path, with_pilot_id=True)
    conn.close()
    assert mm.main(["--db", path]) == 0
    assert "3 backfilled, 0 already present" in capsys.readouterr().out
    assert mm.main(["--db", path]) == 0
    assert "0 backfilled, 3 already present" in capsys.readouterr().out
    conn = sqlite3.connect(path)
    assert conn.execute("SELECT COUNT(*) FROM mode_runs").fetchone()[0] == 3
    assert conn.execute("""SELECT COUNT(*) FROM mode_runs m JOIN runs r ON r.id = m.legacy_run_id
                           WHERE m.pilot_id IS NOT NULL AND m.pilot_id = r.pilot_id""").fetchone()[0] == 3
    # And the ranking the backfill produces is the legacy ranking.
    conn.row_factory = sqlite3.Row
    assert [r["callsign"] for r in appmod.mode_board_rows(conn, "race", "b1b2b3b4", 10)] == ["Old2", "Old1"]
    assert mm.main(["--db", str(tmp_path / "missing.db")]) == 1


def test_migrate_modes_on_a_database_with_no_runs_table_just_creates_mode_runs(tmp_path):
    conn = sqlite3.connect(str(tmp_path / "empty.db"))
    with conn:
        assert mm.migrate_modes(conn) == {"backfilled": 0, "present": 0}
    assert conn.execute("SELECT name FROM sqlite_master WHERE name = 'runs'").fetchone() is None


# ---- relay: join.mode and the proto-6 joined frame

def test_a_join_without_mode_is_a_race_join_exactly_as_before():
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/race/oldmoderoom") as ws:
            joined = _join(ws, "OldClient")
            # Additive only: the keys an old client reads are all still there with the same meaning.
            assert set(joined) == {"type", "room", "proto", "server_ms", "mode"}
            assert joined["room"] == "oldmoderoom" and joined["proto"] == appmod.PROTO and joined["mode"] == "race"
            assert appmod.rooms["oldmoderoom"].mode == "race"
        with c.websocket_connect("/ws/race/oldmoderoom2") as a, \
             c.websocket_connect("/ws/race/oldmoderoom2") as b:
            b.send_json({"type": "join", "callsign": "NewClient", "mode": "race"})
            assert _recv(b)["mode"] == "race"
            assert _join(a, "OldClient")["mode"] == "race", "an old client still gets into a race room"


def test_a_pre_6_client_is_refused_a_landing_room_and_keeps_its_socket():
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/race/landroom") as new, \
             c.websocket_connect("/ws/race/landroom") as old:
            new.send_json({"type": "join", "callsign": "Lander", "mode": "landing"})
            j = _recv(new)
            assert (j["type"], j["mode"], j["proto"]) == ("joined", "landing", appmod.PROTO)
            old.send_json({"type": "join", "callsign": "OldRacer"})
            err = _recv(old)
            assert err["type"] == "error" and "mode mismatch" in err["detail"] and "landing" in err["detail"]
            assert "OldRacer" not in appmod.rooms["landroom"].players
            old.send_json({"type": "ping", "t0": 1})
            assert _recv(old)["type"] == "pong", "a refused join leaves the socket open"
            # A proto-6 client asking for the right mode gets in.
            old.send_json({"type": "join", "callsign": "OldRacer", "mode": "landing"})
            assert _recv(old)["mode"] == "landing"


def test_an_unknown_mode_is_an_error_and_does_not_claim_the_room():
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/race/badmoderoom") as ws:
            ws.send_json({"type": "join", "callsign": "Typo", "mode": "sumo"})
            err = _recv(ws)
            assert err["type"] == "error" and "unknown mode" in err["detail"]
            assert appmod.rooms["badmoderoom"].mode is None
            assert _join(ws, "Typo")["mode"] == "race"


def test_a_landing_rooms_lobby_race_is_not_written_to_the_race_history():
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/race/landdbroom") as a, \
             c.websocket_connect("/ws/race/landdbroom") as b:
            for ws, cs in ((a, "LA"), (b, "LB")):
                ws.send_json({"type": "join", "callsign": cs, "mode": "landing"})
                assert _recv(ws)["type"] == "joined"
            w = {"LA": a, "LB": b}
            _start_race("landdbroom", w)
            _finish("landdbroom", a, offset=-2000)
            assert _wait_until(lambda: appmod.rooms["landdbroom"].race.racers["LA"].status == "finished")
            _finish("landdbroom", b, offset=-1000)
            assert _wait_until(lambda: appmod.rooms["landdbroom"].phase == "results", 3.0)
            assert _results_of(a)["rows"][0]["callsign"] == "LA", "results still reach the room"
            assert _wait_until(lambda: not appmod._persist_tasks)
            assert _db_races("landdbroom") == []


# ---- redeploy.sh

def test_redeploy_sh_backs_up_then_migrates_then_builds():
    """DEPLOY_CHECKLIST.md's order, enforced on the script: a failed backup or migration must stop
    the deploy before anything is rebuilt. Read statically — no bash or docker needed."""
    path = os.path.join(os.path.dirname(__file__), "..", "server", "redeploy.sh")
    with open(path, encoding="utf-8") as f:
        src = f.read()
    code = "\n".join(line for line in src.splitlines() if not line.lstrip().startswith("#"))
    backup, migrate, build, swap = (code.index(s) for s in (
        ".backup(", "migrate_modes.py --db", "docker build", "docker run -d"))
    assert backup < migrate < build < swap
    assert "run cp " not in code, "a plain cp of a WAL-mode race.db can miss committed rows"
    assert "Caddyfile" not in code and "caddy" not in code.lower()


# ---- course catalog from RACE_COURSES_DIR (lobby reliability pass)
#
# 2026-09-23: the live vote offered only surprise-me and lobby.course stayed null. The pool used to
# be the `runs` table, so an empty or re-pointed database meant an empty vote. It is now the shared
# course list, loaded from disk and baked into the image.

_REPO_COURSES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "courses")
_HASHES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "course_hashes.json")


def test_course_hash_matches_add_course_and_the_shared_fixture():
    """course_hashes.json is ALSO asserted by run.js against race.js's Course.hash(), which is what
    makes this a cross-language check. After editing a course, regenerate it with add_course's
    course_hash() and commit it alongside the course."""
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tools"))
    import add_course
    with open(_HASHES, encoding="utf-8") as f:
        pinned = json.load(f)
    with open(os.path.join(_REPO_COURSES, "index.json"), encoding="utf-8") as f:
        index = json.load(f)
    assert sorted(pinned) == sorted(e["id"] for e in index), "fixture lists every indexed course"
    for e in index:
        with open(os.path.join(_REPO_COURSES, e["file"]), encoding="utf-8") as f:
            raw = json.load(f)
        assert appmod.course_hash(raw) == add_course.course_hash(raw) == pinned[e["id"]], e["id"]


def test_course_hash_includes_env_wind_exactly_as_race_js_does():
    """env_hash_vectors.json is race.js's Course.hash() over the same raw courses (run.js asserts it
    too), so app.py, add_course.py and race.js agree on every env shape, not just the shared list."""
    with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "env_hash_vectors.json"), encoding="utf-8") as f:
        vectors = json.load(f)
    for v in vectors:
        assert appmod.course_hash(v["course"]) == v["hash"], v["label"]
    assert appmod.course_env_hash_part({"env": {"weather": {"windKt": 0, "windDir": 90, "clouds": 50}}}) is None
    assert appmod.course_env_hash_part({"env": {"weather": {"windKt": "7.5", "windDir": 360}}}) == ["wx", 8, 0, 0, 0]


def test_load_courses_reads_every_indexed_course_with_its_hash_and_gate_count():
    rows = appmod.load_courses(_REPO_COURSES)
    with open(_HASHES, encoding="utf-8") as f:
        pinned = json.load(f)
    assert {r["course_id"]: r["course_hash"] for r in rows} == pinned
    assert all(r["gates"] >= 2 and r["start_type"] in ("air", "ground") and r["course_name"] for r in rows)


def test_load_courses_skips_a_broken_entry_and_survives_a_missing_index(tmp_path):
    (tmp_path / "good.json").write_text(json.dumps({"name": "Good", "aircraftId": None, "startType": "air",
        "gates": [{"lat": 1, "lon": 2, "alt": 300, "radius": 150}, {"lat": 1.01, "lon": 2, "alt": 300, "radius": 150}]}))
    (tmp_path / "bad.json").write_text("{not json")
    (tmp_path / "index.json").write_text(json.dumps([
        {"id": "good", "name": "Good", "file": "good.json"},
        {"id": "bad", "name": "Bad", "file": "bad.json"},
        {"id": "gone", "name": "Gone", "file": "gone.json"},
        {"id": "escape", "name": "Escape", "file": "../../etc/passwd"}]))
    assert [r["course_id"] for r in appmod.load_courses(str(tmp_path))] == ["good"]
    assert appmod.load_courses(str(tmp_path / "nowhere")) == []


def test_startup_fails_loudly_when_no_courses_load(tmp_path, monkeypatch):
    monkeypatch.setattr(appmod, "COURSES_DIR", str(tmp_path))
    monkeypatch.setattr(appmod, "COURSES", [])
    with pytest.raises(RuntimeError, match="no courses loaded"):
        with TestClient(appmod.app):
            pass


def test_startup_logs_the_course_count_and_path(capsys):
    with TestClient(appmod.app):
        pass
    out = capsys.readouterr().out
    assert f"courses loaded: {len(appmod.COURSES)} from {appmod.COURSES_DIR}" in out


def test_a_vote_rereads_the_index_so_a_git_pull_needs_no_restart(tmp_path, monkeypatch):
    import shutil
    live = tmp_path / "courses"
    shutil.copytree(_REPO_COURSES, live)
    monkeypatch.setattr(appmod, "COURSES_DIR", str(live))
    with TestClient(appmod.app) as c:
        n = len(appmod.COURSES)
        with open(live / "index.json", encoding="utf-8") as f:
            index = json.load(f)
        shutil.copy(live / "gorge-run.json", live / "pulled-in.json")
        index.append({"id": "pulled-in", "name": "Pulled In", "file": "pulled-in.json"})
        (live / "index.json").write_text(json.dumps(index))
        with c.websocket_connect("/ws/race/pullroom") as ws:
            _join(ws, "Puller")
        assert len(appmod.COURSES) == n + 1
        assert any(r["course_id"] == "pulled-in" for r in appmod.COURSES)
        # A re-read that finds nothing keeps the last good catalog rather than emptying the vote.
        (live / "index.json").write_text("[]")
        assert appmod.refresh_courses() == n + 1


def test_the_vote_offers_courses_nobody_has_raced_and_resolves_them_from_disk():
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/race/freshvote") as ws:
            _join(ws, "Fresh")
            room = appmod.rooms["freshvote"]
            real = [x for x in room.vote_candidates if x["course_id"] != appmod.SURPRISE_ME]
            assert len(real) == appmod.VOTE_CANDIDATES, "a full draw with no runs posted for these"
            pick = real[0]["course_id"]
            ws.send_json({"type": "vote", "course_id": pick})
            ws.send_json({"type": "ready", "ready": True})
            ws.send_json({"type": "start", "lead_s": 5})
            start = _of(_drain(ws), "start")[-1]
            want = next(r for r in appmod.COURSES if r["course_id"] == pick)
            assert room.course == {"course_id": pick, "course_hash": want["course_hash"],
                                   "name": want["course_name"], "start_type": want["start_type"],
                                   "gates": want["gates"]}
            assert start["vote"]["course_id"] == pick


def test_surprise_me_resolves_to_a_real_course_with_a_hash():
    for _ in range(20):
        got = appmod._resolve_course_in_thread(appmod.SURPRISE_ME)
        assert got["course_id"] in {r["course_id"] for r in appmod.COURSES}
        assert len(got["course_hash"]) == 8 and got["gates"] >= 2
    assert appmod._resolve_course_in_thread("no-such-course") is None


def test_go_is_refused_while_no_course_is_selected_even_with_everyone_ready():
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/race/nocourseroom") as ws:
            _join(ws, "Solo")
            ws.send_json({"type": "ready", "ready": True})
            ws.send_json({"type": "start", "lead_s": 5, "force": True})
            errs = _of(_drain(ws), "error")
            assert errs and errs[-1]["detail"] == "no course selected"
            assert appmod.rooms["nocourseroom"].phase == "lobby"


def test_redeploy_sh_builds_from_the_repo_root_and_mounts_courses_read_only():
    path = os.path.join(os.path.dirname(__file__), "..", "server", "redeploy.sh")
    with open(path, encoding="utf-8") as f:
        code = "\n".join(line for line in f.read().splitlines() if not line.lstrip().startswith("#"))
    assert 'docker build -f "$SERVER_DIR/Dockerfile" --build-arg "GIT_SHA=$BUILD_SHA" -t "$IMAGE" "$APP_DIR"' in code
    assert '-v "$COURSES_DIR:/app/courses:ro"' in code and "RACE_COURSES_DIR=/app/courses" in code
    # The empty-database guard runs before the backup, and reads the db read-only.
    assert code.index("mode=ro") < code.index(".backup(")
    assert "--allow-empty-db" in code
    assert 'HEALTH_URL="https://race.finsonly.net/health"' in code and '"courses":' in code


def test_redeploy_sh_only_aborts_on_a_real_wrong_datadir_signal_not_a_zero_count():
    """2a must not treat a genuinely empty new board (runs == 0 on a correct schema) as suspect --
    only a missing db with a prior deploy recorded, a missing `runs` table, or a running
    container pointed at the wrong RACE_DB should trip the abort."""
    path = os.path.join(os.path.dirname(__file__), "..", "server", "redeploy.sh")
    with open(path, encoding="utf-8") as f:
        src = f.read()
    code = "\n".join(line for line in src.splitlines() if not line.lstrip().startswith("#"))
    assert '[ "$RUNS" = "0" ]' not in code.split('ABORT_REASON=""')[1].split("elif")[0], \
        "runs==0 must not feed into ABORT_REASON"
    assert 'STATE_FILE="$DATA_DIR/.deployed_sha"' in code
    assert '"$RUNS" = "missing" ] && [ -f "$STATE_FILE" ]' in code
    assert "'runs' not in tables" in code and "bad-schema" in code
    assert "CONTAINER_RACE_DB" in code and '!= "/app/data/race.db"' in code
    assert 'board is empty (0 runs)' in code
    assert "RACE_ALLOW_EMPTY_DB" in code


def test_redeploy_sh_chowns_and_verifies_write_access_before_backup():
    path = os.path.join(os.path.dirname(__file__), "..", "server", "redeploy.sh")
    with open(path, encoding="utf-8") as f:
        src = f.read()
    code = "\n".join(line for line in src.splitlines() if not line.lstrip().startswith("#"))
    chown, write_test, backup = (code.index(s) for s in
        ("chown -R 99:100 /data", "touch /data/.write-test", ".backup("))
    assert chown < write_test < backup
    assert '--user 99:100 \\' in src and "-v \"$DATA_DIR:/app/data\"" in code


def test_autodeploy_sh_passes_unknown_flags_and_env_through_to_redeploy_sh():
    path = os.path.join(os.path.dirname(__file__), "..", "server", "autodeploy.sh")
    with open(path, encoding="utf-8") as f:
        src = f.read()
    code = "\n".join(line for line in src.splitlines() if not line.lstrip().startswith("#"))
    assert "REDEPLOY_EXTRA_ARGS" in code
    assert 'REDEPLOY_ARGS+=("${REDEPLOY_EXTRA_ARGS[@]}")' in code
    # Rollback also runs the container as 99:100, same as redeploy.sh's own swap.
    assert code.count("--user 99:100 \\") >= 1


# ---- prune.sh: post-PASS cleanup (dangling images + race.db backup rotation)

_SERVER_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "server")


def _bash():
    import shutil
    b = shutil.which("bash")
    # Windows' System32\bash.exe is WSL, which can't see these paths the same way; Git Bash can.
    if not b or "system32" in b.lower():
        pytest.skip("needs a POSIX bash (Git Bash on Windows)")
    return b


def _script_code(name):
    with open(os.path.join(_SERVER_DIR, name), encoding="utf-8") as f:
        return "\n".join(line for line in f.read().splitlines() if not line.lstrip().startswith("#"))


def _run_prune(tmp_path, dry_run=0, n_backups=13, prev_id="sha256:prev", run_id="sha256:run", dangling="sha256:junk"):
    import subprocess
    data = tmp_path / "data"
    data.mkdir()
    for i in range(n_backups):
        # Deliberately written newest-first so mtime order disagrees with name order.
        (data / f"race.db.bak-202609{30 - i:02d}-120000").write_bytes(b"x" * (100 + i))
    (data / "race.db").write_bytes(b"live")
    calls, log = tmp_path / "calls.txt", tmp_path / "deploy.log"
    driver = r'''set -euo pipefail
docker() {
  echo "docker $*" >> "$CALLS"
  case "$1 $2" in
    "image inspect") echo "$PREV_ID" ;;
    "inspect "*) echo "$RUN_ID" ;;
    "images -f") printf '%s\n' "$DANGLING" ;;
    "image prune") printf 'Deleted Images:\ndeleted: sha256:junk\n\nTotal reclaimed space: 1.5GB\n' ;;
  esac
}
. "$PRUNE"
prune_after_pass "$DATA" race race "$DRY" 10 "$LOG"
'''
    env = dict(os.environ, CALLS=calls.as_posix(), PREV_ID=prev_id, RUN_ID=run_id, DANGLING=dangling,
               PRUNE=os.path.join(_SERVER_DIR, "prune.sh").replace("\\", "/"), DATA=data.as_posix(),
               DRY=str(dry_run), LOG=log.as_posix())
    r = subprocess.run([_bash(), "-c", driver], env=env, capture_output=True, text=True, timeout=60)
    assert r.returncode == 0, r.stdout + r.stderr
    left = sorted(p.name for p in data.glob("race.db.bak-*"))
    docker_calls = calls.read_text().splitlines() if calls.exists() else []
    return r.stdout, left, docker_calls, (log.read_text() if log.exists() else ""), data


def test_prune_keeps_the_10_newest_backups_by_name_and_logs_bytes_freed(tmp_path):
    out, left, calls, log, data = _run_prune(tmp_path)
    # Names 20260930..20260918; the three oldest (18, 19, 20) go, with sizes 112+111+110.
    assert left == [f"race.db.bak-202609{d:02d}-120000" for d in range(21, 31)]
    assert (data / "race.db").exists(), "the live db is never a candidate"
    assert "docker image prune -f" in calls
    assert not any("-a" in c.split() or "--all" in c for c in calls), "dangling only, never -a"
    summary = "PRUNE images_reclaimed=1.5GB backups_removed=3 backup_bytes_freed=333 backups_kept=10"
    assert summary in out
    assert summary in log


def test_prune_dry_run_removes_nothing_and_never_calls_docker_prune(tmp_path):
    out, left, calls, log, _ = _run_prune(tmp_path, dry_run=1)
    assert len(left) == 13
    assert not any(c.startswith("docker image prune") for c in calls)
    assert "[dry-run] PRUNE" in out and "backups_removed=3" in out
    assert log == "", "dry-run writes no log"


def test_prune_with_few_backups_removes_none(tmp_path):
    out, left, _, _, _ = _run_prune(tmp_path, n_backups=4)
    assert len(left) == 4 and "backups_removed=0 backup_bytes_freed=0 backups_kept=4" in out


@pytest.mark.parametrize("which", ["prev", "running"])
def test_prune_skips_the_image_prune_if_prev_or_the_running_image_is_dangling(tmp_path, which):
    ids = dict(prev_id="sha256:prev", run_id="sha256:run")
    dangling = ids["prev_id" if which == "prev" else "run_id"]
    out, left, calls, _, _ = _run_prune(tmp_path, dangling="sha256:junk\n" + dangling, **ids)
    assert not any(c.startswith("docker image prune") for c in calls)
    assert "images_reclaimed=0B" in out
    assert len(left) == 10, "backup rotation still runs"


def test_redeploy_sh_prunes_only_after_a_pass_and_honours_no_prune():
    code = _script_code("redeploy.sh")
    assert '. "$(dirname "$0")/prune.sh"' in code
    assert "--no-prune)" in code and "NO_PRUNE=1" in code
    fail_exit = code.index('if [ "$RESULT" != "PASS" ]; then\n  exit 1\nfi')
    real = code.index('prune_after_pass "$DATA_DIR" "$IMAGE" "$CONTAINER" 0')
    assert real > fail_exit, "the real prune runs only once the health check has PASSed"
    assert code.index('if [ "$NO_PRUNE" -eq 1 ]', fail_exit) < real
    # The dry-run preview passes dry_run=1, so it never deletes anything.
    assert 'prune_after_pass "$DATA_DIR" "$IMAGE" "$CONTAINER" 1' in code


def test_autodeploy_sh_prunes_only_after_a_passing_rollback_and_passes_no_prune_through():
    code = _script_code("autodeploy.sh")
    assert '. "$(dirname "$0")/prune.sh"' in code
    i = code.index("--no-prune)")
    block = code[i:code.index(";;", i)]
    assert "NO_PRUNE=1" in block and 'REDEPLOY_EXTRA_ARGS+=("$arg")' in block
    assert code.count("prune_after_pass ") == 1
    ok = code.index('log_line "ROLLBACK $REMOTE_SHA to prev ok"')
    call = code.index("prune_after_pass ")
    assert ok < call < code.index('log_line "ROLLBACK $REMOTE_SHA to prev FAILED"')


def test_the_image_ships_a_course_snapshot_and_a_small_context():
    root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
    with open(os.path.join(root, "race", "server", "Dockerfile"), encoding="utf-8") as f:
        docker = f.read()
    assert "COPY race/courses/ /app/courses/" in docker
    assert "RACE_COURSES_DIR=/app/courses" in docker
    assert "ARG GIT_SHA=unknown" in docker and "RACE_GIT_SHA=$GIT_SHA" in docker
    with open(os.path.join(root, ".dockerignore"), encoding="utf-8") as f:
        ignore = [ln.strip() for ln in f if ln.strip() and not ln.startswith("#")]
    assert ignore[0] == "*", "allow-list: nothing enters the context unless named"
    assert set(ignore[1:]) == {"!race/server/requirements.txt", "!race/server/app.py",
                               "!race/server/migrate_modes.py", "!race/server/static",
                               "!race/server/static/*", "!race/courses/*.json", "!race/runways/*.json",
                               "!race/bookmarklet.txt"}
    assert "COPY race/runways/ /app/runways/" in docker and "RACE_RUNWAYS_DIR=/app/runways" in docker
    assert "COPY race/server/static/ /app/static/" in docker
    assert "COPY race/bookmarklet.txt /app/bookmarklet.txt" in docker


# ---- lobby reliability pass: the send path

def test_client_proto_5_on_join_receives_typed_chat_without_a_pilot_token():
    """A join that races ahead of the hub carries no pilot_token. Before client_proto, that pilot
    was never marked proto 5 and never received a typed line."""
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/race/capchat") as sender, \
             c.websocket_connect("/ws/race/capchat") as early:
            sender.send_json({"type": "join", "callsign": "Sender", "pilot_token": "tok-s"})
            assert _recv(sender)["type"] == "joined"
            early.send_json({"type": "join", "callsign": "Early", "client_proto": 5})
            assert _recv(early)["type"] == "joined"
            assert appmod.rooms["capchat"].players["Early"].proto5 is True
            sender.send_json({"type": "chat", "text": "can you see this"})
            assert _of(_drain(early), "chat")[-1] == {"type": "chat", "from": "Sender", "text": "can you see this"}


def test_client_proto_below_5_is_still_an_old_client():
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/race/capold") as ws:
            ws.send_json({"type": "join", "callsign": "Four", "client_proto": 4})
            assert _recv(ws)["type"] == "joined"
            assert appmod.rooms["capold"].players["Four"].proto5 is False
    with pytest.raises(Exception):
        appmod.parse_message({"type": "join", "callsign": "x", "client_proto": -1})


def test_a_lone_pilot_can_ready_up_and_start_on_their_own_vote():
    """Solo testability: one pilot, one vote, ready, start — no second person needed."""
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/race/lonely") as ws:
            _join(ws, "Lonely")
            room = appmod.rooms["lonely"]
            pick = next(x["course_id"] for x in room.vote_candidates if x["course_id"] != appmod.SURPRISE_ME)
            ws.send_json({"type": "vote", "course_id": pick})
            ws.send_json({"type": "ready", "ready": True})
            ws.send_json({"type": "start", "lead_s": 5})
            start = _of(_drain(ws), "start")[-1]
            assert start["racers"] == ["Lonely"] and room.phase == "countdown"
            assert room.course["course_id"] == pick


# ---- lobby reliability pass: start carries its course

def test_the_start_frame_names_the_course_it_is_for_even_when_the_vote_picked_it():
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/race/startcourse") as ws:
            _join(ws, "Starter")
            room = appmod.rooms["startcourse"]
            pick = next(x["course_id"] for x in room.vote_candidates if x["course_id"] != appmod.SURPRISE_ME)
            ws.send_json({"type": "vote", "course_id": pick})
            ws.send_json({"type": "ready", "ready": True})
            ws.send_json({"type": "start", "lead_s": 5})
            frames = _drain(ws)
            start = _of(frames, "start")[-1]
            assert start["course"] == room.course and start["course"]["course_id"] == pick
            # …and it arrives BEFORE the lobby frame that also carries it, which is why it is needed.
            order = [f["type"] for f in frames if f["type"] in ("start", "lobby")]
            assert order.index("start") < len(order) - 1 and order[-1] == "lobby"


# ---- lobby reliability pass: chat is relayed, never persisted

def test_a_chat_line_reaches_neither_sqlite_nor_any_log_nor_stdout(caplog, capsys):
    import logging
    marker = "zq-chat-marker-7731"
    caplog.set_level(logging.DEBUG)
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/race/nochatlog") as a, c.websocket_connect("/ws/race/nochatlog") as b:
            a.send_json({"type": "join", "callsign": "Talker", "client_proto": 5})
            assert _recv(a)["type"] == "joined"
            b.send_json({"type": "join", "callsign": "Listener", "client_proto": 5})
            assert _recv(b)["type"] == "joined"
            a.send_json({"type": "chat", "text": marker})
            assert _of(_drain(b), "chat")[-1]["text"] == marker, "it was relayed"
    conn = sqlite3.connect(appmod.DB_PATH)
    try:
        for (table,) in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'"):
            for row in conn.execute(f'SELECT * FROM "{table}"'):
                assert marker not in repr(row), f"chat text found in table {table}"
    finally:
        conn.close()
    assert marker not in caplog.text, "chat text reached a log record"
    out = capsys.readouterr()
    assert marker not in out.out and marker not in out.err, "chat text reached stdout/stderr"


def test_the_only_log_and_print_calls_in_app_py_carry_no_chat_text():
    """Static half of the proof: every logging/print call in app.py, by line. None of them is in
    the chat path or formats a message body; a new one has to be looked at and added here."""
    path = os.path.join(os.path.dirname(__file__), "..", "server", "app.py")
    with open(path, encoding="utf-8") as f:
        calls = [ln.strip() for ln in f if ("logging." in ln or "print(" in ln) and not ln.strip().startswith("#")
                 and "import logging" not in ln]
    allowed = ("could not persist race", "hub loop died", "course index unreadable", "course %r skipped",
               "courses loaded:", "bookmarklet unreadable", "no PRIMARY bookmarklet line found",
               "runway index unreadable", "runway %r skipped", "no runways loaded", "runways loaded:")
    assert calls and all(any(a in c for a in allowed) for c in calls), calls


# ---- Proto 8: rolling start / FORMATION phase

def test_start_goes_to_formation_when_every_racer_proves_proto_8_on_an_air_start_course():
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/race/formroom") as host_ws, \
             c.websocket_connect("/ws/race/formroom") as guest_ws:
            _join8(host_ws, "Host")
            _join8(guest_ws, "Guest")
            host_ws.send_json(_course())   # start_type: air, by default
            host_ws.send_json({"type": "ready", "ready": True})
            guest_ws.send_json({"type": "ready", "ready": True})
            assert _wait_until(lambda: all(p.ready for p in appmod.rooms["formroom"].players.values()))
            host_ws.send_json({"type": "start", "lead_s": 20})
            frame = _recv(host_ws, skip=("lobby", "world", "box_state", "vote"))
            assert frame["type"] == "formation", frame
            assert frame["race_id"] == 1
            assert frame["pace_kt"] == appmod.RACE_FORMATION_PACE_KT
            assert frame["pace_s"] == appmod.RACE_FORMATION_PACE_S
            assert [s["callsign"] for s in frame["slots"]] == ["Host", "Guest"], "slot order = ready order"
            assert frame["slots"][0]["index"] == 0 and frame["slots"][1]["index"] == 1
            assert frame["course"]["course_id"] == "starter-sprint-seatac"
            room = appmod.rooms["formroom"]
            assert room.phase == "formation"
            assert room.formation_order == ["Host", "Guest"]
            assert room.formation_green_at_ms == frame["green_at_ms"]
            assert room.race is not None and set(room.race.racers) == {"Host", "Guest"}


def test_a_ground_start_course_never_gets_formation_even_with_proto_8():
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/race/groundroom") as host_ws:
            _join8(host_ws, "Host")
            host_ws.send_json(_course(start_type="ground"))
            host_ws.send_json({"type": "ready", "ready": True})
            host_ws.send_json({"type": "start", "lead_s": 10})
            frame = _recv(host_ws)
            assert frame["type"] == "start", frame
            assert appmod.rooms["groundroom"].phase == "countdown"


def test_an_old_client_in_the_room_falls_back_to_the_grid_for_everyone():
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/race/mixedroom") as host_ws, \
             c.websocket_connect("/ws/race/mixedroom") as old_ws:
            _join8(host_ws, "Host")
            _join(old_ws, "Old")   # no client_proto: an old client
            host_ws.send_json(_course())
            host_ws.send_json({"type": "ready", "ready": True})
            old_ws.send_json({"type": "ready", "ready": True})
            assert _wait_until(lambda: all(p.ready for p in appmod.rooms["mixedroom"].players.values()))
            host_ws.send_json({"type": "start", "lead_s": 10})
            frame = _recv(host_ws, skip=("lobby", "world", "box_state", "vote"))
            assert frame["type"] == "start", "one racer below FORMATION_PROTO means the WHOLE room uses the grid"
            assert appmod.rooms["mixedroom"].phase == "countdown"


def test_the_host_can_turn_rolling_off_and_get_the_grid_on_an_air_start_course():
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/race/norollroom") as host_ws:
            _join8(host_ws, "Host")
            host_ws.send_json(_course())
            host_ws.send_json({"type": "rules", "powerups": True, "teleport": True, "rolling": False})
            host_ws.send_json({"type": "ready", "ready": True})
            host_ws.send_json({"type": "start", "lead_s": 10})
            frame = _recv(host_ws, skip=("lobby", "world", "box_state", "vote"))
            assert frame["type"] == "start"
            assert appmod.rooms["norollroom"].rules == {"powerups": True, "teleport": True, "rolling": False}


def test_a_spectator_never_blocks_or_joins_the_formation():
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/race/specformroom") as host_ws, \
             c.websocket_connect("/ws/race/specformroom") as spec_ws:
            _join8(host_ws, "Host")
            spec_ws.send_json({"type": "join", "callsign": "Watcher", "client_proto": appmod.FORMATION_PROTO,
                                "spectate": True})
            assert spec_ws.receive_json()["type"] == "joined"
            host_ws.send_json(_course())
            host_ws.send_json({"type": "ready", "ready": True})
            host_ws.send_json({"type": "start", "lead_s": 10})
            frame = _recv(host_ws, skip=("lobby", "world", "box_state", "vote"))
            assert frame["type"] == "formation"
            assert [s["callsign"] for s in frame["slots"]] == ["Host"]


def test_formation_drop_moves_the_sender_to_the_back_and_only_the_sender():
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/race/droproom") as a_ws, \
             c.websocket_connect("/ws/race/droproom") as b_ws, \
             c.websocket_connect("/ws/race/droproom") as c_ws:
            _join8(a_ws, "A"); _join8(b_ws, "B"); _join8(c_ws, "C")
            a_ws.send_json(_course())
            for ws in (a_ws, b_ws, c_ws):
                ws.send_json({"type": "ready", "ready": True})
            assert _wait_until(lambda: all(p.ready for p in appmod.rooms["droproom"].players.values()))
            a_ws.send_json({"type": "start", "lead_s": 30})
            frame = _recv(a_ws, skip=("lobby", "world", "box_state", "vote"))
            assert [s["callsign"] for s in frame["slots"]] == ["A", "B", "C"]

            a_ws.send_json({"type": "formation_drop"})
            frame2 = _recv(a_ws, skip=("lobby", "world", "box_state", "vote"))
            assert frame2["type"] == "formation"
            assert [s["callsign"] for s in frame2["slots"]] == ["B", "C", "A"], "A drops to the back"
            assert frame2["race_id"] == frame["race_id"] and frame2["green_at_ms"] == frame["green_at_ms"]
            room = appmod.rooms["droproom"]
            assert room.formation_order == ["B", "C", "A"]

            # A drop from someone NOT in the formation (e.g. stale/duplicate) is a no-op.
            b_ws.send_json({"type": "ready", "ready": False})   # never routed to formation_drop; just proves harmless
            c_ws.send_json({"type": "formation_drop"})
            frame3 = _recv(a_ws, skip=("lobby", "world", "box_state", "vote"))
            assert [s["callsign"] for s in frame3["slots"]] == ["B", "A", "C"], "only C moved"


def test_a_late_ready_during_formation_joins_at_the_back_unless_too_close_to_green():
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/race/lateformroom") as host_ws:
            _join8(host_ws, "Host")
            host_ws.send_json(_course())
            host_ws.send_json({"type": "ready", "ready": True})
            host_ws.send_json({"type": "start", "lead_s": 30})
            frame = _recv(host_ws, skip=("lobby", "world", "box_state", "vote"))
            assert frame["type"] == "formation"

            with c.websocket_connect("/ws/race/lateformroom") as late_ws:
                _join8(late_ws, "Late")
                late_ws.send_json({"type": "ready", "ready": True})
                frame2 = _recv(host_ws, skip=("lobby", "world", "box_state", "vote"))
                assert frame2["type"] == "formation"
                assert [s["callsign"] for s in frame2["slots"]] == ["Host", "Late"]
                room = appmod.rooms["lateformroom"]
                assert "Late" in room.race.racers

            # Too close to green: refused, not queued.
            with c.websocket_connect("/ws/race/lateformroom") as too_late_ws:
                _join8(too_late_ws, "TooLate")
                room = appmod.rooms["lateformroom"]
                room.formation_green_at_ms = appmod.server_ms() + 2000   # inside the 10 s cutoff
                too_late_ws.send_json({"type": "ready", "ready": True})
                err = _recv(too_late_ws)
                assert err == {"type": "error", "detail": "too close to green to join the formation"}
                assert "TooLate" not in room.formation_order


def test_abort_and_back_to_lobby_both_work_from_formation():
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/race/formabortroom") as host_ws:
            _join8(host_ws, "Host")
            host_ws.send_json(_course())
            host_ws.send_json({"type": "ready", "ready": True})
            host_ws.send_json({"type": "start", "lead_s": 30})
            assert _recv(host_ws, skip=("lobby", "world", "box_state", "vote"))["type"] == "formation"

            host_ws.send_json({"type": "abort"})
            assert _recv(host_ws) == {"type": "abort"}
            room = appmod.rooms["formabortroom"]
            assert room.phase == "lobby" and room.formation_order is None and room.start_task is None
            assert room.players["Host"].ready is True

            host_ws.send_json({"type": "start", "lead_s": 30})
            assert _recv(host_ws, skip=("lobby", "world", "box_state", "vote"))["type"] == "formation"
            host_ws.send_json({"type": "back_to_lobby"})
            assert _wait_until(lambda: appmod.rooms["formabortroom"].phase == "lobby")
            room = appmod.rooms["formabortroom"]
            assert room.formation_order is None
            assert not room.players["Host"].ready, "back_to_lobby clears ready, same as from countdown"


def test_formation_flips_to_racing_at_green_and_registry_shows_the_pace_lap():
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/race/greenroom") as host_ws:
            _join8(host_ws, "Host")
            host_ws.send_json(_course())
            host_ws.send_json({"type": "ready", "ready": True})
            host_ws.send_json({"type": "start", "lead_s": 5})
            assert _recv(host_ws, skip=("lobby", "world", "box_state", "vote"))["type"] == "formation"

            room = appmod.rooms["greenroom"]
            status = appmod.room_status_line(room, appmod.server_ms())
            assert "pace lap" in status and "green in" in status, status

            assert _wait_until(lambda: appmod.rooms["greenroom"].phase == "racing", timeout=7)
            assert appmod.rooms["greenroom"].formation_order is None


def test_ready_seq_resets_on_clear_ready_so_the_next_race_reorders_from_who_readies_first():
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/race/reorderroom") as a_ws, \
             c.websocket_connect("/ws/race/reorderroom") as b_ws:
            _join8(a_ws, "A"); _join8(b_ws, "B")
            a_ws.send_json(_course())
            a_ws.send_json({"type": "ready", "ready": True})
            b_ws.send_json({"type": "ready", "ready": True})
            assert _wait_until(lambda: all(p.ready for p in appmod.rooms["reorderroom"].players.values()))
            a_ws.send_json({"type": "start", "lead_s": 30})
            frame = _recv(a_ws, skip=("lobby", "world", "box_state", "vote"))
            assert [s["callsign"] for s in frame["slots"]] == ["A", "B"]

            a_ws.send_json({"type": "back_to_lobby"})
            _wait_until(lambda: appmod.rooms["reorderroom"].phase == "lobby")
            # This time B readies first.
            b_ws.send_json({"type": "ready", "ready": True})
            a_ws.send_json({"type": "ready", "ready": True})
            assert _wait_until(lambda: all(p.ready for p in appmod.rooms["reorderroom"].players.values()))
            a_ws.send_json({"type": "start", "lead_s": 30})
            frame2 = _recv(a_ws, skip=("lobby", "world", "box_state", "vote"))
            assert [s["callsign"] for s in frame2["slots"]] == ["B", "A"], "reordered by THIS race's ready order"


# ---- tools/smoke_lobby.py against a real local uvicorn (the same script that checks live)

@pytest.fixture(scope="module")
def local_relay(tmp_path_factory):
    import socket
    import subprocess
    import urllib.request
    pytest.importorskip("websockets")          # uvicorn[standard] brings it; the script needs it
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    server_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "server")
    env = {**os.environ, "RACE_DB": str(tmp_path_factory.mktemp("smoke") / "race.db"),
           "RACE_COURSES_DIR": _REPO_COURSES, "RACE_MIN_INTERVAL_S": "0"}
    proc = subprocess.Popen([sys.executable, "-m", "uvicorn", "app:app", "--host", "127.0.0.1", "--port", str(port)],
                            cwd=server_dir, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    try:
        deadline = _time.time() + 20
        while True:
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=1) as r:
                    if json.load(r)["courses"] > 0:
                        break
            except Exception:
                if proc.poll() is not None or _time.time() > deadline:
                    raise RuntimeError("local uvicorn did not come up: " + proc.stdout.read().decode(errors="replace"))
                _time.sleep(0.2)
        yield f"ws://127.0.0.1:{port}"
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except Exception:
            proc.kill()


@pytest.mark.parametrize("clients", [2, 3])
def test_smoke_lobby_passes_every_step_against_a_local_relay(local_relay, clients):
    import subprocess
    script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tools", "smoke_lobby.py")
    res = subprocess.run([sys.executable, script, "--url", local_relay, "--clients", str(clients)],
                         capture_output=True, text=True, timeout=120)
    out = res.stdout + res.stderr
    assert res.returncode == 0, out
    assert out.count("PASS") == 12 and "FAIL" not in out and "SKIP" not in out, out


# ==================================================================================
# 0.7-1.0 series: tile proxy, full-race replays, record history, pilots, OG images
# ==================================================================================

# ---------------------------------------------------------- tile proxy

def _tile_env(monkeypatch, tmp_path, proxy=True, imagery="esri", cache_mb=2048.0, min_interval=0.0):
    monkeypatch.setattr(appmod, "TILE_CACHE_DIR", str(tmp_path))
    monkeypatch.setattr(appmod, "RACE_TILE_PROXY", proxy)
    monkeypatch.setattr(appmod, "RACE_IMAGERY", imagery)
    monkeypatch.setattr(appmod, "TILE_CACHE_MB", cache_mb)
    monkeypatch.setattr(appmod, "TILE_MIN_INTERVAL_S", min_interval)
    appmod._last_tile.clear()


def test_tile_terrain_hits_cache_on_second_request(monkeypatch, tmp_path):
    _tile_env(monkeypatch, tmp_path)
    calls = []
    monkeypatch.setattr(appmod, "_tile_http_get", lambda url: calls.append(url) or b"PNGDATA")
    with TestClient(appmod.app) as c:
        r1 = c.get("/tiles/terrain/5/10/12.png")
        assert r1.status_code == 200 and r1.content == b"PNGDATA"
        assert r1.headers["content-type"] == "image/png"
        assert f"max-age={appmod.TILE_CACHE_MAX_AGE_S}" in r1.headers["cache-control"]
        r2 = c.get("/tiles/terrain/5/10/12.png")
        assert r2.content == b"PNGDATA"
    assert calls == ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/5/10/12.png"], \
        "second request must be served from the disk cache, not fetched again"


def test_tile_coords_are_validated_before_touching_disk_or_network(monkeypatch, tmp_path):
    _tile_env(monkeypatch, tmp_path)
    def must_not_fetch(url):
        raise AssertionError("an invalid tile request must never reach the network")
    monkeypatch.setattr(appmod, "_tile_http_get", must_not_fetch)
    with TestClient(appmod.app) as c:
        assert c.get("/tiles/terrain/99/0/0.png").status_code == 400, "z over the source's max zoom"
        assert c.get("/tiles/terrain/5/99999/0.png").status_code == 400, "x out of range at z=5"
        assert c.get("/tiles/terrain/5/0/99999.png").status_code == 400, "y out of range at z=5"
        # Starlette's int path converter accepts a leading "-" (so -1 reaches _valid_tile_coords
        # and is rejected there, 400) but rejects anything that isn't a plain integer outright --
        # "../" or a float segment never matches this route at all, and 404s before any code runs.
        assert c.get("/tiles/terrain/-1/0/0.png").status_code == 400
        assert c.get("/tiles/terrain/5/../../etc/passwd.png").status_code == 404
        assert c.get("/tiles/terrain/1.5/0/0.png").status_code in (404, 422), \
            "a non-integer segment must never reach this code (route match failure or FastAPI validation)"


def test_tile_imagery_switches_source_on_race_imagery_env(monkeypatch, tmp_path):
    _tile_env(monkeypatch, tmp_path, imagery="eox")
    seen = {}
    def fake_get(url):
        seen["url"] = url
        return b"JPEGDATA"
    monkeypatch.setattr(appmod, "_tile_http_get", fake_get)
    with TestClient(appmod.app) as c:
        r = c.get("/tiles/imagery/5/10/12")
        assert r.status_code == 200 and r.headers["content-type"] == "image/jpeg"
        assert "eox.at" in seen["url"]
        attribution = c.get("/tiles/attribution").json()
        assert attribution["imagery_source"] == "eox" and "EOX" in attribution["imagery"]
        assert attribution["terrain"] == appmod.TERRAIN_CREDIT


def test_tile_proxy_disabled_via_env_flag(monkeypatch, tmp_path):
    _tile_env(monkeypatch, tmp_path, proxy=False)
    with TestClient(appmod.app) as c:
        assert c.get("/tiles/terrain/5/10/12.png").status_code == 404
        assert c.get("/tiles/imagery/5/10/12").status_code == 404
        assert c.get("/tiles/attribution").status_code == 404


def test_tile_rate_limit_is_per_ip(monkeypatch, tmp_path):
    _tile_env(monkeypatch, tmp_path, min_interval=10.0)
    monkeypatch.setattr(appmod, "_tile_http_get", lambda url: b"x")
    with TestClient(appmod.app) as c:
        assert c.get("/tiles/terrain/1/0/0.png").status_code == 200
        assert c.get("/tiles/terrain/1/0/1.png").status_code == 429


def test_tile_cache_lru_eviction_drops_the_oldest_first(monkeypatch, tmp_path):
    _tile_env(monkeypatch, tmp_path, cache_mb=0.001)   # ~1 KB cap
    monkeypatch.setattr(appmod, "_tile_http_get", lambda url: b"0" * 600)
    with TestClient(appmod.app) as c:
        c.get("/tiles/terrain/1/0/0.png")
        _time.sleep(0.03)
        c.get("/tiles/terrain/1/0/1.png")
        _time.sleep(0.03)
        c.get("/tiles/terrain/1/1/0.png")   # over the cap now: the oldest tile must be evicted
    remaining = [f for _root, _dirs, files in os.walk(tmp_path) for f in files]
    assert len(remaining) < 3, "the cache must not grow past its cap"


# ---------------------------------------------------------- full-race replays (proto 9)

def _lobby_trace(end_ms):
    return {"v": 1, "t": [0, end_ms], "lat": [45.50, 45.51], "lon": [-122.60, -122.61],
            "alt": [1200.0, 1200.0], "hdg": [90.0, 90.0], "pitch": [0.0, 0.0], "roll": [0.0, 0.0]}


def _wait_for_one_db_race(room):
    assert _wait_until(lambda: len(_db_races(room)) == 1, 3.0), "the race was never persisted"
    return _db_races(room)[0]["id"]


def test_finish_trace_is_stored_and_served_by_the_replay_endpoint():
    with TestClient(appmod.app) as c, _pilots(c, "replayroom", ["A", "B"]) as w:
        _start_race("replayroom", w)
        rm = appmod.rooms["replayroom"]
        go = appmod.server_ms() - rm.race.start_at_ms - 1000
        w["A"].send_json({"type": "finish", "race_id": rm.race_id, "go_time_ms": go,
                          "trace": _lobby_trace(go)})
        _dnf("replayroom", w["B"])   # no trace at all -- a legitimate, documented gap
        assert _wait_until(lambda: rm.phase == "results", 3.0)
        race_id = _wait_for_one_db_race("replayroom")

        r = c.get(f"/races/{race_id}/replay")
        assert r.status_code == 200
        body = r.json()
        assert body["race"]["id"] == race_id and body["race"]["room"] == "replayroom"
        assert {row["callsign"] for row in body["results"]} == {"A", "B"}
        assert [t["callsign"] for t in body["traces"]] == ["A"], "only A sent a trace"
        assert body["traces"][0]["trace"]["v"] == 1
        assert body["traces"][0]["go_elapsed_ms"] == body["traces"][0]["time_ms"]


def test_dnf_trace_is_stored_without_a_time_check():
    with TestClient(appmod.app) as c, _pilots(c, "dnftraceroom", ["A", "B"]) as w:
        _start_race("dnftraceroom", w)
        w["A"].send_json({"type": "dnf", "race_id": appmod.rooms["dnftraceroom"].race_id, "gate": 2,
                          "trace": _lobby_trace(9999)})   # a DNF's trace has no go_time_ms to match
        _finish("dnftraceroom", w["B"])
        assert _wait_until(lambda: appmod.rooms["dnftraceroom"].phase == "results", 3.0)
        race_id = _wait_for_one_db_race("dnftraceroom")
        traces = {t["callsign"]: t for t in c.get(f"/races/{race_id}/replay").json()["traces"]}
        assert "A" in traces and traces["A"]["time_ms"] is None, "a DNF has no finish time"


def test_a_malformed_trace_is_dropped_without_affecting_the_finish():
    with TestClient(appmod.app) as c, _pilots(c, "badtraceroom", ["A", "B"]) as w:
        _start_race("badtraceroom", w)
        rm = appmod.rooms["badtraceroom"]
        go = appmod.server_ms() - rm.race.start_at_ms - 1000
        bad = _lobby_trace(go)
        del bad["lat"]   # missing column -> decode_trace() raises
        w["A"].send_json({"type": "finish", "race_id": rm.race_id, "go_time_ms": go, "trace": bad})
        assert _wait_until(lambda: rm.race.racers["A"].status == "finished")
        assert rm.race.racers["A"].trace_blob is None
        _finish("badtraceroom", w["B"], offset=500)
        assert _wait_until(lambda: rm.phase == "results", 3.0)
        race_id = _wait_for_one_db_race("badtraceroom")
        assert c.get(f"/races/{race_id}/replay").json()["traces"] == []


def test_replay_of_a_race_with_no_traces_at_all():
    with TestClient(appmod.app) as c, _pilots(c, "notraceroom", ["A", "B"]) as w:
        _start_race("notraceroom", w)
        _run_race("notraceroom", w, order=["A", "B"])
        race_id = _wait_for_one_db_race("notraceroom")
        body = c.get(f"/races/{race_id}/replay").json()
        assert body["traces"] == [] and len(body["results"]) == 2


def test_replay_unknown_race_id_404():
    with TestClient(appmod.app) as c:
        assert c.get("/races/999999999/replay").status_code == 404


# ---------------------------------------------------------- record history

def test_record_events_created_when_a_run_beats_the_record():
    with TestClient(appmod.app) as c:
        ch = "abc12345"
        c.post("/runs", json=run(course_hash=ch, callsign="First", time_ms=20000, gates=2,
                                 splits=[20000], length_m=1000))
        r = c.post("/runs", json=run(course_hash=ch, callsign="Second", time_ms=15000, gates=2,
                                     splits=[15000], length_m=1000))
        assert r.status_code == 200
        hist = c.get("/records/history", params={"course_hash": ch}).json()
        assert len(hist) == 2
        assert hist[0]["callsign"] == "Second" and hist[0]["prev_holder"] == "First" \
            and hist[0]["prev_time_ms"] == 20000
        assert hist[1]["callsign"] == "First" and hist[1]["prev_holder"] is None \
            and hist[1]["prev_time_ms"] is None


def test_a_slower_or_tied_run_does_not_create_a_record_event():
    with TestClient(appmod.app) as c:
        ch = "def67890"
        c.post("/runs", json=run(course_hash=ch, callsign="Fast", time_ms=10000, gates=2,
                                 splits=[10000], length_m=1000))
        c.post("/runs", json=run(course_hash=ch, callsign="Slow", time_ms=99000, gates=2,
                                 splits=[99000], length_m=1000))
        c.post("/runs", json=run(course_hash=ch, callsign="Tied", time_ms=10000, gates=2,
                                 splits=[10000], length_m=1000))
        hist = c.get("/records/history", params={"course_hash": ch}).json()
        assert len(hist) == 1 and hist[0]["callsign"] == "Fast"


def test_records_history_limit_and_unknown_course():
    with TestClient(appmod.app) as c:
        assert c.get("/records/history", params={"course_hash": "ffffffff"}).json() == []
        assert c.get("/records/history", params={"course_hash": "ffffffff", "limit": 1000}).status_code == 422
        assert c.get("/records/history", params={"course_hash": "ffffffff", "limit": 1}).status_code == 200


# ---------------------------------------------------------- pilots

def test_pilots_list_and_lookup_by_id_and_by_callsign():
    with TestClient(appmod.app) as c:
        with appmod.connect() as conn:
            pid, _ = appmod.issue_pilot(conn, "AceOfBase")
            conn.commit()
        c.post("/runs", json=run(course_hash="11112222", callsign="AceOfBase", time_ms=5000,
                                 gates=2, splits=[5000], length_m=1000))
        with appmod.connect() as conn:
            appmod.migrate(conn)
            conn.commit()

        assert any(p["pilot_id"] == pid for p in c.get("/pilots").json())

        by_id = c.get(f"/pilots/{pid}").json()
        assert by_id["callsign"] == "AceOfBase"
        assert any(b["course_hash"] == "11112222" and b["time_ms"] == 5000 for b in by_id["personal_bests"])
        assert "pilot_token" not in json.dumps(by_id) and "token_hash" not in json.dumps(by_id)

        by_name = c.get("/pilots/aceofbase").json()
        assert by_name["pilot_id"] == pid


def test_pilot_not_found_404():
    with TestClient(appmod.app) as c:
        assert c.get("/pilots/no-such-pilot-at-all").status_code == 404


def test_pilot_head_to_head_with_and_without_shared_races():
    with TestClient(appmod.app) as c, _pilots(c, "h2hroom", ["H2HRae", "H2HFox"]) as w:
        _start_race("h2hroom", w)
        _finish("h2hroom", w["H2HRae"], offset=-2000)
        _finish("h2hroom", w["H2HFox"], offset=-500)
        assert _wait_until(lambda: appmod.rooms["h2hroom"].phase == "results", 3.0)
        race_id = _wait_for_one_db_race("h2hroom")

        with appmod.connect() as conn:
            rae_id, _ = appmod.issue_pilot(conn, "H2HRae")
            fox_id, _ = appmod.issue_pilot(conn, "H2HFox")
            conn.commit()
            appmod.migrate(conn)
            conn.commit()

        h2h = c.get(f"/pilots/{rae_id}", params={"vs": fox_id}).json()["head_to_head"]
        assert h2h["callsign"] == "H2HFox" and h2h["shared_races"] == 1
        assert h2h["wins"] == 1 and h2h["losses"] == 0

        solo = c.get(f"/pilots/{rae_id}").json()
        assert solo["wins"] >= 1 and solo["race_count"] >= 1

        assert c.get(f"/pilots/{rae_id}", params={"vs": "no-such-pilot"}).json()["head_to_head"] is None

        og = c.get(f"/og/replay/{race_id}.png")
        assert og.status_code == 200 and og.headers["content-type"] == "image/png"


# ---------------------------------------------------------- OG images

def test_og_image_dimensions_and_format_for_a_course():
    with TestClient(appmod.app) as c:
        r = c.get("/og/course/gorge-run.png")
        assert r.status_code == 200 and r.headers["content-type"] == "image/png"
        img = appmod.Image.open(appmod.io.BytesIO(r.content))
        assert img.size == (appmod.OG_W, appmod.OG_H) and img.format == "PNG"


def test_og_image_cache_reuse_does_not_re_render(monkeypatch, tmp_path):
    monkeypatch.setattr(appmod, "TILE_CACHE_DIR", str(tmp_path / "tiles"))
    monkeypatch.setattr(appmod, "OG_CACHE_DIR", str(tmp_path / "og"))
    calls = []
    real = appmod.render_og_image
    def counting(*a, **kw):
        calls.append(1)
        return real(*a, **kw)
    monkeypatch.setattr(appmod, "render_og_image", counting)
    with TestClient(appmod.app) as c:
        c.get("/og/course/gorge-run.png")
        c.get("/og/course/gorge-run.png")
    assert len(calls) == 1, "the second request must be served from the disk cache"


def test_og_image_unknown_id_404s():
    with TestClient(appmod.app) as c:
        assert c.get("/og/course/does-not-exist.png").status_code == 404
        assert c.get("/og/pilot/does-not-exist.png").status_code == 404
        assert c.get("/og/replay/999999999.png").status_code == 404
        assert c.get("/og/record/00000000.png").status_code == 404


def test_og_image_for_a_record(monkeypatch, tmp_path):
    monkeypatch.setattr(appmod, "TILE_CACHE_DIR", str(tmp_path / "tiles"))
    monkeypatch.setattr(appmod, "OG_CACHE_DIR", str(tmp_path / "og"))
    ch = appmod.COURSES[0]["course_hash"]
    with TestClient(appmod.app) as c:
        c.post("/runs", json=run(course_id=appmod.COURSES[0]["course_id"], course_hash=ch,
                                 callsign="OGPilot", time_ms=3000, gates=2, splits=[3000], length_m=1000))
        r = c.get(f"/og/record/{ch}.png")
        assert r.status_code == 200 and r.headers["content-type"] == "image/png"


def test_share_page_has_og_meta_and_redirects_to_the_spa_hash_route():
    with TestClient(appmod.app) as c:
        r = c.get("/share/course/gorge-run", follow_redirects=False)
        assert r.status_code == 200
        assert 'property="og:image" content="/og/course/gorge-run.png"' in r.text
        assert 'url=/#/course/gorge-run' in r.text
        assert c.get("/share/course/does-not-exist-course", follow_redirects=False).status_code == 404
