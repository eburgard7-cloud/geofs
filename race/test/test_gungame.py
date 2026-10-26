"""Gun Game (proto 14): the pure engine (gungame_engine.py) and its relay wiring in app.py.

Run: cd race/server && python -m pytest ../test/test_gungame.py -q
"""
import contextlib
import copy
import json
import os
import random
import sqlite3
import sys
import time as _time
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
os.environ.setdefault("RACE_MIN_INTERVAL_S", "0")
os.environ.setdefault("RACE_GET_MIN_INTERVAL_S", "0")
os.environ.setdefault("RACE_CLAIM_MIN_INTERVAL_S", "0")
os.environ.setdefault("RACE_TILE_WARM", "0")
os.environ.setdefault("RACE_THUMB_WARM", "0")
os.environ.setdefault("RACE_COURSES_DIR", os.path.join(HERE, "..", "courses"))
sys.path.insert(0, os.path.join(HERE, "..", "server"))
import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import app as appmod  # noqa: E402
import gungame_engine as ge  # noqa: E402

DATA = os.path.join(HERE, "..", "data", "gungame.json")
LADDER = os.path.join(HERE, "..", "..", "liveries", "gungame", "ladder.json")


def _raw():
    with open(DATA, encoding="utf-8") as f:
        raw = json.load(f)
    with open(LADDER, encoding="utf-8") as f:
        lad = json.load(f)
    return raw, lad


@pytest.fixture
def cat():
    c, errs = ge.load_catalog(DATA, LADDER)
    assert errs == [] and c is not None
    return c


def _game(cat, creator="Eric", legs=None, catch_up=None, preset="classic", pilots=("Maggie",)):
    g = ge.GunGame(1, cat, creator, now_ms=1_000_000, now_s=1_790_000_000, seed="t")
    for p in pilots:
        g.add_pilot(p)
    if legs is not None or catch_up is not None:
        assert g.settings(creator, legs=legs, catch_up=catch_up) is None
    if preset != cat.settings["default_preset"]:
        assert g.vote(creator, preset) is None
    assert g.start() is None
    return g


def _leg(g, order, dnf=()):
    """Fly one leg: `order` finishes in that order, `dnf` don't."""
    g.leg_started(list(order) + list(dnf))
    rows = [{"callsign": cs, "status": "finished"} for cs in order] + [{"callsign": cs, "status": "dnf"} for cs in dnf]
    return g.score_leg(rows)


# ------------------------------------------------------------------------------------ catalog
def test_heat_for_matches_ladder_json_examples():
    _, lad = _raw()
    for n, want in lad["examples"].items():
        assert [ge.heat_for(t, int(n)) for t in range(1, int(n) + 1)] == want
    for bad in ((0, 4), (5, 4), (1, 1)):
        with pytest.raises(ValueError):
            ge.heat_for(*bad)


def test_the_shipped_catalog_is_valid_and_lines_up_with_ladder_json(cat):
    _, lad = _raw()
    assert set(cat.airframes) == set(lad["airframes"])
    for k, p in lad["presets"].items():
        assert cat.presets[k]["tiers"] == p["tiers"]
    assert cat.airframes["b737_700"]["factory"] == "b737" and cat.airframes["b737"]["factory"] == "b737max"
    assert cat.airframes["toilet"]["factory"] is None and cat.airframes["toilet"]["base"] == "c172"
    frame = ge.catalog_frame(cat)
    assert set(frame) == {"settings", "airframes", "presets", "heat", "final", "class_defaults", "fallback"}
    assert frame["final"]["color"] == "#f2b81f" and len(frame["heat"]) == 8 and json.dumps(frame)


@pytest.mark.parametrize("mutate, words", [
    (lambda r, lad: r["airframes"]["f16"].update(start_kt=0), "start_kt"),
    (lambda r, lad: r["airframes"]["f16"].update(start_throttle=2), "start_throttle"),
    (lambda r, lad: r["airframes"]["f16"].update(cap_kt="fast"), "cap_kt"),
    (lambda r, lad: r["airframes"]["f16"].update({"class": "rocket"}), "class"),
    (lambda r, lad: r["airframes"]["f16"].pop("name"), "name"),
    (lambda r, lad: r["airframes"]["f16"].update(effects=[{"fn": "boost_charges", "n": 1}]), "effects"),
    (lambda r, lad: r["airframes"]["toilet"].update(base="nope"), "base"),
    (lambda r, lad: r["airframes"]["toilet"].pop("model"), "joke model"),
    (lambda r, lad: r["presets"]["short"].update(tiers=["f16"]), "2-16 tiers"),
    (lambda r, lad: r["presets"]["short"].update(tiers=["toilet", "f16"]), "can only be the last tier"),
    (lambda r, lad: r["presets"]["short"].update(tiers=["f16", "nope"]), "unknown airframe"),
    (lambda r, lad: r["fallback"].update(base="toilet"), "fallback.base"),
    (lambda r, lad: r["class_defaults"].pop(), "catch everything"),
    (lambda r, lad: r["settings"].update(default_preset="nope"), "default_preset"),
    (lambda r, lad: lad["heat"].pop(), "heat"),
    (lambda r, lad: lad["airframes"].pop("cub"), "exactly"),
])
def test_tier_definition_validation_refuses_by_name(mutate, words):
    raw, lad = _raw()
    raw, lad = copy.deepcopy(raw), copy.deepcopy(lad)
    mutate(raw, lad)
    cat, errs = ge.parse_catalog(raw, lad)
    assert cat is None and any(words in e for e in errs), errs


def test_load_catalog_never_raises(tmp_path):
    cat, errs = ge.load_catalog(str(tmp_path / "missing.json"), LADDER)
    assert cat is None and errs


def test_presets_build_with_heat_colours_and_the_gold_toilet(cat):
    for pid, n in (("short", 4), ("classic", 6), ("long", 10)):
        why, tiers = ge.build_ladder(cat, ge.preset_tiers(cat, pid))
        assert why is None and len(tiers) == n
        assert [t["heat"] for t in tiers] == [ge.heat_for(i, n) for i in range(1, n + 1)]
        assert tiers[-1]["key"] == "toilet" and tiers[-1]["model"] == "toilet-gold" and tiers[-1]["fallback_model"] == "toilet-gold"
        assert tiers[-1]["color"] == "#f2b81f" and tiers[0]["color"] == "#5ec8ff"
    _, classic = ge.build_ladder(cat, ge.preset_tiers(cat, "classic"))
    assert [t["name"] for t in classic] == ["F-16", "737-700", "Cessna 172", "Piper Cub", "Paraglider", "Toilet"]
    assert classic[1]["aircraft_id"] == "4" and classic[2]["aircraft_id"] == "2"
    # the toilet away from the end isn't gold (only a final tier is)
    assert cat.airframes["toilet"]["model"] == "toilet"


def test_custom_ladders_2_to_16_tiers_unknown_names_and_a_joke_final(cat):
    ok = [{"airframe": "f16"}, {"aircraft_id": "3", "name": "Bombardier Dash 8"}, {"aircraft_id": "77", "name": "Zlin Z-50"}, {"airframe": "toilet"}]
    why, tiers = ge.build_ladder(cat, ok)
    assert why is None
    assert tiers[1]["unknown"] and tiers[1]["class"] == "airliner" and tiers[1]["start_kt"] == 250 and tiers[1]["factory"] is None
    assert tiers[2]["class"] == "ga" and tiers[2]["start_kt"] == 100
    assert tiers[3]["model"] == "toilet-gold"
    assert ge.custom_problem(cat.airframes, [{"airframe": "f16"}], cat.settings) == "a ladder needs 2-16 tiers"
    assert ge.custom_problem(cat.airframes, [{"airframe": "cub"}] * 17, cat.settings) == "a ladder needs 2-16 tiers"
    assert ge.custom_problem(cat.airframes, [{"airframe": "cub"}] * 16, cat.settings) is None
    assert ge.custom_problem(cat.airframes, [{"airframe": "toilet"}, {"airframe": "f16"}], cat.settings) == "Toilet can only be the last tier"
    assert ge.custom_problem(cat.airframes, [{"airframe": "f16"}, {"airframe": "nope"}], cat.settings) == "unknown airframe 'nope'"
    assert ge.custom_problem(cat.airframes, [{"airframe": "f16"}, {"aircraft_id": "a b", "name": "X"}], cat.settings) == "tier 2 has no aircraft"
    assert ge.custom_problem(cat.airframes, [{"airframe": "f16"}, {"aircraft_id": "9", "name": "  "}], cat.settings) == "tier 2 needs a name"
    assert ge.classify(cat, "Eurofighter Typhoon")[0] == "fighter" and ge.classify(cat, "Bell 206")[0] == "heli"
    assert ge.classify(cat, "Hot air balloon")[0] == "glider"


# ------------------------------------------------------------------------------------ staging
def test_the_ladder_vote_creator_breaks_ties_and_changes_reset_ready(cat):
    g = ge.GunGame(1, cat, "Eric", 0, 1_790_000_000)
    g.add_pilot("Maggie")
    g.add_pilot("Steve")
    assert g.effective_preset() == "classic"
    for cs in g.pilots:
        g.set_ready(cs, True)
    assert g.vote("Maggie", "short") is None and g.effective_preset() == "short"
    assert not any(p.ready for p in g.pilots.values()), "a change of ladder clears ready"
    g.set_ready("Maggie", True)
    assert g.vote("Eric", "long") is None and g.effective_preset() == "long", "1-1: the creator's vote wins"
    assert g.vote("Steve", "short") is None and g.effective_preset() == "short"
    assert g.vote("Steve", "custom") == "no custom ladder yet (the creator builds it)"
    assert g.vote("Steve", "nope") == "unknown ladder 'nope'"
    assert g.vote("Nobody", "short") == "you are not in this game"
    g.set_ready("Maggie", True)
    assert g.settings("Maggie", legs=5) == "only the game's creator can change that"
    assert g.settings("Eric", legs=0) == "legs must be 1-30" and g.settings("Eric", legs=31) == "legs must be 1-30"
    assert g.settings("Eric", custom=[{"airframe": "toilet"}, {"airframe": "f16"}]) == "Toilet can only be the last tier"
    assert g.pilots["Maggie"].ready, "a refused change resets nothing"
    assert g.settings("Eric", legs=12) is None and g.pilots["Maggie"].ready, "no change: ready stays"
    assert g.settings("Eric", catch_up=False) is None and not g.pilots["Maggie"].ready and g.catch_up is False
    assert g.settings("Eric", custom=[{"airframe": "f16"}, {"airframe": "cub"}]) is None
    assert g.vote("Eric", "custom") is None and g.vote("Steve", "custom") is None and g.effective_preset() == "custom"
    assert [t["name"] for t in g.card()["ladder"]] == ["F-16", "Piper Cub"]
    assert g.all_ready(["Eric", "Maggie", "Steve"]) is False
    for cs in g.pilots:
        g.set_ready(cs, True)
    assert g.all_ready(["Eric", "Maggie"]) is True, "a pilot who left the room doesn't hold up GO"
    assert g.start() is None and g.phase == ge.VOTE and len(g.ladder) == 2 and g.preset_used == "custom"
    assert g.vote("Eric", "short") == "the ladder is set once the game starts"
    assert g.settings("Eric", legs=3) == "settings are locked once the game starts"


# ------------------------------------------------------------------------------------ rules
def test_ladder_progression_the_winner_steps_down_everyone_else_stays(cat):
    g = _game(cat, pilots=("Maggie", "Steve"))
    r = _leg(g, ["Maggie", "Eric", "Steve"])
    assert {x["callsign"]: (x["from_tier"], x["to_tier"], x["why"]) for x in r["rows"]} == {
        "Maggie": (1, 2, "won"), "Eric": (1, 1, None), "Steve": (1, 1, None)}
    assert r["over"] is False and r["winner"] is None and r["reason"] is None
    assert [x["place"] for x in r["rows"]] == [1, 2, 3]


def test_a_win_on_the_final_tier_wins_the_game(cat):
    g = _game(cat, preset="short", pilots=("Maggie",), catch_up=False)
    for i in range(3):
        r = _leg(g, ["Maggie", "Eric"])
        assert g.pilots["Maggie"].tier == 2 + i and not r["over"]
    r = _leg(g, ["Maggie", "Eric"])          # on tier 4 of 4: the toilet
    assert r["over"] and r["winner"] == "Maggie" and g.pilots["Maggie"].tier == 4 and r["reason"] == "won"
    assert r["rows"][0]["why"] == "won" and r["rows"][0]["to_tier"] == 4
    assert g.legs_done == 4


def test_after_n_legs_the_furthest_down_the_ladder_wins(cat):
    g = _game(cat, legs=3, pilots=("Maggie", "Steve"), catch_up=False)
    _leg(g, ["Maggie", "Eric", "Steve"])
    _leg(g, ["Steve", "Eric", "Maggie"])
    r = _leg(g, ["Maggie", "Steve", "Eric"])
    assert r["over"] and r["winner"] == "Maggie" and r["reason"] == "legs", "tier 3 beats tier 2"
    g2 = _game(cat, legs=2, pilots=("Maggie",), catch_up=False)
    _leg(g2, ["Maggie", "Eric"])
    r2 = _leg(g2, ["Eric", "Maggie"])
    assert r2["over"] and r2["winner"] == "Eric", "a tier tie: equal wins, the better place in the last leg"


def test_catch_up_last_twice_in_a_row_steps_you_up(cat):
    g = _game(cat, pilots=("Maggie", "Steve"))
    for _ in range(3):
        _leg(g, ["Steve", "Maggie", "Eric"])        # Steve to tier 4
    assert g.pilots["Steve"].tier == 4
    r = _leg(g, ["Eric", "Maggie", "Steve"])      # Steve last once
    assert g.pilots["Steve"].tier == 4 and g.pilots["Steve"].last_streak == 1
    r = _leg(g, ["Eric", "Maggie"], dnf=["Steve"])  # a DNF is last too: twice -> up a tier
    row = next(x for x in r["rows"] if x["callsign"] == "Steve")
    assert (row["from_tier"], row["to_tier"], row["why"], row["place"], row["status"]) == (4, 3, "catch_up", None, "dnf")
    assert g.pilots["Steve"].last_streak == 0
    # Eric was last 3 legs running at tier 1: he can't go above tier 1
    assert g.pilots["Eric"].tier == 3 and g.pilots["Eric"].wins == 2


def test_catch_up_off_streak_resets_and_tier_one_is_the_floor(cat):
    g = _game(cat, pilots=("Maggie",), catch_up=False)
    _leg(g, ["Maggie", "Eric"])
    _leg(g, ["Maggie", "Eric"])
    assert g.pilots["Eric"].tier == 1 and g.pilots["Maggie"].tier == 3
    g2 = _game(cat, pilots=("Maggie", "Steve"))
    _leg(g2, ["Maggie", "Steve", "Eric"])
    _leg(g2, ["Maggie", "Eric", "Steve"])        # Eric not last: his streak resets
    _leg(g2, ["Maggie", "Steve", "Eric"])
    assert g2.pilots["Eric"].tier == 1 and g2.pilots["Eric"].last_streak == 1
    _leg(g2, ["Maggie", "Steve", "Eric"])
    assert g2.pilots["Eric"].tier == 1 and g2.pilots["Eric"].last_streak == 0, "already on tier 1: nowhere up to go"


def test_a_solo_leg_has_no_last_place_and_a_late_joiner_starts_at_tier_one(cat):
    g = _game(cat, pilots=())
    r = _leg(g, ["Eric"])
    assert r["rows"][0]["to_tier"] == 2 and g.multi is False
    new = g.leg_started(["Eric", "Zed"])
    assert new == ["Zed"] and g.pilots["Zed"].tier == 1
    r = g.score_leg([{"callsign": "Zed", "status": "finished"}, {"callsign": "Outsider", "status": "finished"}])
    assert [x["callsign"] for x in r["rows"]] == ["Zed", "Eric"], "a non-game pilot is not placed; an entrant with no row is a DNS"
    assert r["rows"][1]["status"] == "dnf" and g.multi is True


def test_nobody_finishes_nobody_moves(cat):
    g = _game(cat, pilots=("Maggie",))
    r = _leg(g, [], dnf=["Eric", "Maggie"])
    assert all(x["from_tier"] == x["to_tier"] for x in r["rows"])


def test_the_leg_vote(cat):
    g = _game(cat)
    cands = [{"choice": "course:a", "kind": "course", "name": "A"}, {"choice": "course:b", "kind": "course", "name": "B"},
             {"choice": "dash:KPDX-KSEA", "kind": "dash", "name": "KPDX→KSEA"}]
    g.open_leg_vote(cands, now_ms=5000, vote_s=20)
    assert g.card()["leg_vote"]["deadline_server_ms"] == 25000
    assert g.leg_vote_cast("Eric", "course:z") == "not a candidate: course:z"
    assert g.leg_vote_cast("Nobody", "course:a") == "you are not in this game"
    assert g.leg_vote_cast("Eric", "dash:KPDX-KSEA") is None and not g.leg_vote_complete(["Eric", "Maggie"])
    assert g.leg_vote_cast("Maggie", "dash:KPDX-KSEA") is None and g.leg_vote_complete(["Eric", "Maggie"])
    pick = g.close_leg_vote(random.Random(1))
    assert pick["choice"] == "dash:KPDX-KSEA" and g.card()["leg"] == {"kind": "dash", "name": "KPDX→KSEA"}
    g.open_leg_vote(cands, now_ms=0)
    assert g.close_leg_vote(random.Random(1))["choice"] in {c["choice"] for c in cands}, "no votes: a draw"


def test_card_summary_results_and_rename(cat):
    g = _game(cat, pilots=("Maggie",))
    g.pilot_ids = {"Eric": "p-eric", "Maggie": "p-mag"}
    _leg(g, ["Maggie", "Eric"])
    g.rename("Maggie", "Mags")
    card = g.card()
    assert card["phase"] == "leg" and card["preset"] == "classic" and len(card["ladder"]) == 6
    assert card["pilots"][0] == {"callsign": "Mags", "tier": 2, "wins": 1, "last_streak": 0, "ready": False}
    g.end("ended")
    s = g.summary(9_000_000)
    assert s["end_reason"] == "ended" and s["winner"] is None and s["standings"][0]["callsign"] == "Mags"
    rows = g.result_rows()
    assert {r["callsign"]: (r["pilot_id"], r["won"], r["tier_reached"], r["counts"]) for r in rows} == {
        "Mags": ("p-mag", False, 2, True), "Eric": ("p-eric", False, 1, True)}
    assert "Gun Game over (ended early)" in ge.summary_line(s)
    g2 = _game(cat, preset="short", pilots=("Maggie",), catch_up=False)
    for _ in range(4):
        _leg(g2, ["Maggie", "Eric"])
    g2.end("won")
    s2 = g2.summary(1)
    assert s2["winner"] == "Maggie" and ge.summary_line(s2).startswith("Gun Game over: Maggie wins! 1. Maggie tier 4/4")
    assert [r["won"] for r in g2.result_rows()] == [True, False]


# =============================================================================== the relay
def _wait_until(pred, timeout=3.0):
    start = _time.time()
    while _time.time() - start < timeout:
        if pred():
            return True
        _time.sleep(0.02)
    return False


def _join(ws, callsign, proto=None, token=None):
    msg = {"type": "join", "callsign": callsign, "client_proto": appmod.PROTO if proto is None else proto}
    if token:
        msg["pilot_token"] = token
    ws.send_json(msg)
    joined = ws.receive_json()
    assert joined["type"] == "joined", joined
    return joined


def _drain(ws):
    ws.send_json({"type": "ping", "t0": 42.5})
    frames = []
    while True:
        m = ws.receive_json()
        if m["type"] == "pong" and m["t0"] == 42.5:
            return frames
        frames.append(m)


def _of(frames, type_):
    return [f for f in frames if f["type"] == type_]


def _errors(frames):
    return [f["detail"] for f in frames if f["type"] == "error"]


@contextlib.contextmanager
def _pilots(c, room, names, proto=None, tokens=None):
    with contextlib.ExitStack() as stack:
        wss = {}
        for n in names:
            ws = stack.enter_context(c.websocket_connect(f"/ws/race/{room}"))
            _join(ws, n, (proto or {}).get(n), (tokens or {}).get(n))
            wss[n] = ws
        yield wss


def _course_ids(n=3):
    """Ground-start courses: a leg always arms a plain countdown (never FORMATION)."""
    appmod.refresh_courses()             # the catalog loads at startup: a test that asks first still sees it
    return [c["course_id"] for c in appmod.COURSES if c["start_type"] == "ground"][:n]


def _cands(dash=False):
    out = [{"choice": "course:" + i, "kind": "course", "name": i, "course_id": i} for i in _course_ids()]
    if dash:
        pdx, sea = appmod.AIRPORTS.get("KPDX"), appmod.AIRPORTS.get("KSEA")
        out.append({"choice": "dash:KPDX-KSEA", "kind": "dash", "name": "KPDX→KSEA", "dep": pdx, "dst": sea, "ceiling_ft": None})
    return out


@pytest.fixture
def fast(monkeypatch):
    """A 1 s server-started countdown, a quick watcher tick, and a fixed leg-vote draw."""
    monkeypatch.setattr(appmod, "GG_LEG_LEAD_S", 1)
    monkeypatch.setattr(appmod, "GG_TICK_S", 0.05)
    monkeypatch.setattr(appmod, "_gg_leg_candidates_in_thread", lambda callsigns: _cands())


def _finish(room, ws, offset=0):
    rm = appmod.rooms[room]
    go = max(0, appmod.server_ms() - rm.race.start_at_ms + offset)
    ws.send_json({"type": "finish", "race_id": rm.race_id, "go_time_ms": go})


def _dnf(room, ws):
    ws.send_json({"type": "dnf", "race_id": appmod.rooms[room].race_id, "gate": 1})


def _race_leg(room, wss, order, out=()):
    rm = appmod.rooms[room]
    assert _wait_until(lambda: rm.phase == "racing" and rm.race is not None, 5.0), rm.phase
    for i, n in enumerate(order):
        _finish(room, wss[n], offset=i * 1000)
    for n in out:
        _dnf(room, wss[n])
    assert _wait_until(lambda: rm.phase == "results", 5.0), "the leg never ended"


def _ready_all(w, names):
    for n in names:
        w[n].send_json({"type": "gg_ready", "ready": True})
        assert not _errors(_drain(w[n]))


def _vote_leg(rm, w, names, choice):
    assert _wait_until(lambda: rm.gg is not None and rm.gg.phase == ge.VOTE and rm.gg.leg_vote is not None, 5.0)
    for n in names:
        w[n].send_json({"type": "gg_leg_vote", "choice": choice})
    assert _wait_until(lambda: rm.phase in ("countdown", "dash_staging"), 5.0), rm.phase


def _tokens(*names):
    out = {}
    with appmod.connect() as conn:
        for n in names:
            out[n] = appmod.issue_pilot(conn, n)
    return out


def test_version_advertises_proto_14_and_gungame():
    with TestClient(appmod.app) as c:
        v = c.get("/version").json()
    assert v["proto"] == 14 == appmod.GG_PROTO and "gungame" in v["features"]


def test_a_proto_14_joiner_gets_the_catalog_and_an_older_one_does_not():
    with TestClient(appmod.app) as c, _pilots(c, "gg-cat", ["New", "Old"], proto={"Old": 13}) as w:
        cat = _of(_drain(w["New"]), "gg_catalog")
        old = _drain(w["Old"])
    assert len(cat) == 1 and cat[0]["presets"]["classic"]["tiers"][0] == "f16"
    assert cat[0]["airframes"]["b737_700"]["factory"] == "b737" and cat[0]["final"]["color"] == "#f2b81f"
    assert not [f for f in old if f["type"].startswith("gg")]


def test_gg_refusals_by_name(monkeypatch):
    with TestClient(appmod.app) as c, _pilots(c, "gg-refuse", ["Host", "Old"], proto={"Old": 13}) as w:
        w["Old"].send_json({"type": "gg_create"})
        assert "gun game needs a proto-14 client" in _errors(_drain(w["Old"]))
        w["Host"].send_json({"type": "gg_vote", "preset": "short"})
        assert "no gun game in this room" in _errors(_drain(w["Host"]))
        w["Host"].send_json({"type": "gg_create"})
        w["Host"].send_json({"type": "gg_create"})
        assert "a gun game is already on" in _errors(_drain(w["Host"]))
    monkeypatch.setattr(appmod, "GUNGAME_CATALOG", None)
    with TestClient(appmod.app) as c, _pilots(c, "gg-off", ["Host"]) as w:
        f = _drain(w["Host"])
        assert not _of(f, "gg_catalog"), "an off server sends no catalog"
        w["Host"].send_json({"type": "gg_create"})
        assert "gun game is off on this server" in _errors(_drain(w["Host"]))
        assert appmod.rooms["gg-off"].gg is None


def test_staging_votes_settings_and_any_change_resets_ready(fast):
    with TestClient(appmod.app) as c, _pilots(c, "gg-stage", ["Old", "Eric", "Maggie"], proto={"Old": 13}) as w:
        rm = appmod.rooms["gg-stage"]
        w["Maggie"].send_json({"type": "gg_create"})
        card = _of(_drain(w["Eric"]), "gg")[-1]
        assert card["phase"] == "staging" and card["creator"] == "Maggie" and card["preset"] == "classic"
        assert {p["callsign"] for p in card["pilots"]} == {"Eric", "Maggie"}, "an old client isn't on the card"
        assert len(card["ladder"]) == 6 and card["ladder"][-1]["model"] == "toilet-gold" and card["legs"] == 12
        assert not [x for x in _drain(w["Old"]) if x["type"].startswith("gg")]
        # Busy: nothing else starts while the card is up; the old client's start is refused by name.
        w["Old"].send_json({"type": "start", "lead_s": 5})
        assert appmod.GG_BUSY in _errors(_drain(w["Old"]))
        w["Eric"].send_json({"type": "dash_create", "from_icao": "KPDX", "to_icao": "KSEA"})
        w["Eric"].send_json({"type": "rogue_start", "legs": [{"course_id": i} for i in _course_ids()]})
        assert _errors(_drain(w["Eric"])).count(appmod.GG_BUSY) == 2
        # Ready, then a ladder vote that changes the pick clears it.
        w["Eric"].send_json({"type": "gg_ready", "ready": True})
        _drain(w["Eric"])
        assert rm.gg.pilots["Eric"].ready
        w["Eric"].send_json({"type": "gg_vote", "preset": "short"})
        card = _of(_drain(w["Eric"]), "gg")[-1]
        assert card["preset"] == "short" and len(card["ladder"]) == 4 and not rm.gg.pilots["Eric"].ready
        w["Eric"].send_json({"type": "gg_settings", "legs": 5})
        assert "only the game's creator can change that" in _errors(_drain(w["Eric"]))
        w["Maggie"].send_json({"type": "gg_settings", "custom": [{"airframe": "toilet"}, {"airframe": "f16"}]})
        assert "Toilet can only be the last tier" in _errors(_drain(w["Maggie"]))
        w["Eric"].send_json({"type": "gg_ready", "ready": True})
        _drain(w["Eric"])
        w["Maggie"].send_json({"type": "gg_settings", "custom": [{"airframe": "f16"}, {"aircraft_id": "3", "name": "Bombardier Dash 8"},
                                                                 {"airframe": "toilet"}], "legs": 7, "catch_up": False})
        assert not _errors(_drain(w["Maggie"]))
        assert not rm.gg.pilots["Eric"].ready, "a settings change clears ready"
        w["Maggie"].send_json({"type": "gg_vote", "preset": "custom"})
        w["Eric"].send_json({"type": "gg_vote", "preset": "custom"})
        card = _of(_drain(w["Eric"]), "gg")[-1]
        assert card["preset"] == "custom" and card["legs"] == 7 and card["catch_up"] is False
        assert [t["name"] for t in card["ladder"]] == ["F-16", "Bombardier Dash 8", "Toilet"] and card["ladder"][1]["unknown"]
        # Everyone ready: the game starts and the leg vote opens.
        _ready_all(w, ["Eric", "Maggie"])
        assert _wait_until(lambda: rm.gg.phase == ge.VOTE and rm.gg.leg_vote is not None)
        card = _of(_drain(w["Eric"]), "gg")[-1]
        assert card["phase"] == "vote" and len(card["leg_vote"]["candidates"]) == 3
        _time.sleep(1.1)                     # this pilot has sent a lot: stay under the relay's rate limit
        w["Eric"].send_json({"type": "gg_vote", "preset": "short"})
        assert "the game has started" in _errors(_drain(w["Eric"]))
        w["Eric"].send_json({"type": "gg_leg_vote", "choice": "course:nope"})
        assert "not a candidate: course:nope" in _errors(_drain(w["Eric"]))


def test_a_two_pilot_game_to_a_win_on_the_final_tier(fast):
    room = "gg-e2e-" + uuid.uuid4().hex[:8]
    ids = _course_ids()
    eric, mag = "Eric" + room[-4:], "Mag" + room[-4:]
    toks = _tokens(eric, mag)
    with TestClient(appmod.app) as c, _pilots(c, room, [eric, mag, "Old"], proto={"Old": 13},
                                               tokens={eric: toks[eric][1], mag: toks[mag][1]}) as w:
        rm = appmod.rooms[room]
        w[eric].send_json({"type": "gg_create"})
        w[mag].send_json({"type": "gg_vote", "preset": "short"})
        w[eric].send_json({"type": "gg_vote", "preset": "short"})
        _ready_all(w, [eric, mag])
        for leg in range(4):
            _vote_leg(rm, w, [eric, mag], "course:" + ids[leg % 3])
            assert rm.course["course_id"] == ids[leg % 3]
            assert set(rm.race.racers) == {eric, mag}, "only game pilots are readied"
            _race_leg(room, w, [mag, eric])
            if leg < 3:
                assert _wait_until(lambda: rm.gg is not None and rm.gg.legs_done == leg + 1 and rm.gg.phase == ge.VOTE)
                assert rm.linger_task is None, "the game holds the room on its results"
                row = {r["callsign"]: r for r in _of(_drain(w[eric]), "gg_leg")[-1]["rows"]}
                assert (row[mag]["from_tier"], row[mag]["to_tier"], row[mag]["why"]) == (leg + 1, leg + 2, "won")
                assert row[eric]["from_tier"] == row[eric]["to_tier"] == 1
        assert _wait_until(lambda: rm.gg is None)
        f = _drain(w[mag])
        leg = _of(f, "gg_leg")[-1]
        assert leg["winner"] == mag and leg["rows"][0]["why"] == "won" and leg["rows"][0]["from_tier"] == 4
        s = _of(f, "gg_summary")[0]
        assert s["end_reason"] == "won" and s["winner"] == mag and s["legs_done"] == 4
        house = [x for x in _of(f, "chat") if x.get("from") == "HOUSE"]
        assert house and house[-1]["text"].startswith(f"Gun Game over: {mag} wins!")
        assert rm.gg_offs == [] and not rm.hooks.has()
        assert rm.linger_task is not None, "the last leg goes home the usual way"
        old = _drain(w["Old"])
        assert not [x for x in old if x["type"].startswith("gg")]
        assert any(x["type"] == "chat" and x.get("from") == "HOUSE" for x in old)

    def stored():
        with sqlite3.connect(appmod.DB_PATH) as conn:
            return conn.execute("SELECT g.end_reason, g.winner, g.legs_done, r.callsign, r.pilot_id, r.won, r.tier_reached, r.counts "
                                "FROM gungame_games g JOIN gungame_results r ON r.game_id = g.id WHERE g.room = ? "
                                "ORDER BY r.won DESC", (room,)).fetchall()
    assert _wait_until(lambda: len(stored()) == 2)
    rows = stored()
    assert rows[0] == ("won", mag, 4, mag, toks[mag][0], 1, 4, 1)
    assert rows[1] == ("won", mag, 4, eric, toks[eric][0], 0, 1, 1)
    with appmod.connect() as conn:
        assert appmod.GUNGAME_WINS(conn, toks[mag][0]) == 1 and appmod.GUNGAME_WINS(conn, toks[eric][0]) == 0
        ctx = appmod._unlock_ctx(conn, toks[mag][0])
    assert ctx["gungame_wins"] == 1
    assert appmod.livery_unlocked({"gungame_wins": 1}, ctx) and not appmod.livery_unlocked({"gungame_wins": 5}, ctx)


def test_gungame_wins_counts_only_games_someone_else_flew():
    pid = "gg-wins-" + uuid.uuid4().hex[:8]
    summary = {"end_reason": "won", "winner": "Solo", "legs_done": 4, "ladder": []}
    appmod.persist_gg("r", summary, [{"callsign": "Solo", "pilot_id": pid, "won": True, "tier_reached": 4, "counts": False}], 1, 2)
    with appmod.connect() as conn:
        assert appmod.GUNGAME_WINS(conn, pid) == 0, "a solo game never unlocks a champion paint"
        assert appmod.GUNGAME_WINS(conn, None) == 0 and appmod.GUNGAME_WINS(conn, "") == 0
    for n in range(1, 11):
        appmod.persist_gg("r", summary, [{"callsign": "Ace", "pilot_id": pid, "won": True, "tier_reached": 4, "counts": True},
                                         {"callsign": "B", "pilot_id": "other-" + pid, "won": False, "tier_reached": 2, "counts": True}], 1, 2)
        with appmod.connect() as conn:
            wins = appmod.GUNGAME_WINS(conn, pid)
        assert wins == n
        for need in (1, 5, 10):
            assert appmod.livery_unlocked({"gungame_wins": need}, {"gungame_wins": wins}) is (n >= need)


def test_back_to_lobby_and_gg_end_end_the_game(fast):
    with TestClient(appmod.app) as c, _pilots(c, "gg-end", ["Eric", "Maggie"]) as w:
        rm = appmod.rooms["gg-end"]
        w["Maggie"].send_json({"type": "gg_create"})
        assert _wait_until(lambda: rm.gg is not None)
        w["Maggie"].send_json({"type": "gg_end"})
        s = _of(_drain(w["Maggie"]), "gg_summary")[0]
        assert s["end_reason"] == "ended" and rm.gg is None
        w["Maggie"].send_json({"type": "gg_create"})
        assert _wait_until(lambda: rm.gg is not None)
        w["Eric"].send_json({"type": "back_to_lobby"})                # Eric is the host
        assert _wait_until(lambda: rm.gg is None and rm.phase == "roam")
        w["Eric"].send_json({"type": "rogue_start", "legs": [{"course_id": i} for i in _course_ids()]})
        assert _wait_until(lambda: rm.rogue is not None)
        w["Maggie"].send_json({"type": "gg_create"})
        assert appmod.ROGUE_BUSY in _errors(_drain(w["Maggie"]))


def test_staging_leavers_creator_handoff_rename_and_a_joiner_gets_the_card(fast):
    with TestClient(appmod.app) as c, _pilots(c, "gg-join", ["Eric", "Maggie"]) as w:
        rm = appmod.rooms["gg-join"]
        with c.websocket_connect("/ws/race/gg-join") as tmp:
            _join(tmp, "Temp")
            w["Eric"].send_json({"type": "gg_create"})
            assert _wait_until(lambda: rm.gg is not None and "Temp" in rm.gg.pilots)
            assert _of(_drain(tmp), "gg")
        assert _wait_until(lambda: "Temp" not in rm.gg.pilots)
        w["Maggie"].send_json({"type": "rename", "callsign": "Maggs"})
        assert _wait_until(lambda: "Maggs" in rm.gg.pilots and "Maggie" not in rm.gg.pilots)
        with c.websocket_connect("/ws/race/gg-join") as late:
            _join(late, "Late")
            f = _drain(late)
            assert _of(f, "gg") and _of(f, "gg_catalog")
    with TestClient(appmod.app) as c, _pilots(c, "gg-hand", ["Eric", "Maggie"]) as w:
        rm = appmod.rooms["gg-hand"]
        with c.websocket_connect("/ws/race/gg-hand") as boss:
            _join(boss, "Boss")
            boss.send_json({"type": "gg_create"})
            assert _wait_until(lambda: rm.gg is not None and rm.gg.creator == "Boss")
        assert _wait_until(lambda: rm.gg.creator in ("Eric", "Maggie"))


def test_a_late_joiner_enters_at_tier_one_and_a_dash_washout_is_a_dnf(fast, monkeypatch):
    monkeypatch.setattr(appmod, "_gg_leg_candidates_in_thread", lambda callsigns: _cands(dash=True))
    room = "gg-dash-" + uuid.uuid4().hex[:8]
    with TestClient(appmod.app) as c, _pilots(c, room, ["Eric", "Maggie"]) as w:
        rm = appmod.rooms[room]
        w["Eric"].send_json({"type": "gg_create"})
        _ready_all(w, ["Eric", "Maggie"])
        _vote_leg(rm, w, ["Eric", "Maggie"], "course:" + _course_ids()[0])
        _race_leg(room, w, ["Eric", "Maggie"])
        assert _wait_until(lambda: rm.gg.legs_done == 1 and rm.gg.phase == ge.VOTE)
        with c.websocket_connect(f"/ws/race/{room}") as late:
            _join(late, "Late")
            _drain(late)
            _vote_leg(rm, w, ["Eric", "Maggie"], "dash:KPDX-KSEA")
            assert rm.phase == "dash_staging" and set(rm.dash.entrants) == {"Eric", "Maggie", "Late"}
            assert rm.gg.pilots["Late"].tier == 1 and rm.gg.pilots["Eric"].tier == 2
            for ws in (w["Eric"], w["Maggie"], late):
                ws.send_json({"type": "dash_leave"})
            assert _wait_until(lambda: rm.gg is not None and rm.gg.legs_done == 2, 3.0)
            leg = _of(_drain(w["Eric"]), "gg_leg")[-1]
            assert {r["status"] for r in leg["rows"]} == {"dnf"} and all(r["from_tier"] == r["to_tier"] for r in leg["rows"])
            assert _wait_until(lambda: rm.gg.phase == ge.VOTE and rm.gg.leg_vote is not None, 3.0)


def test_a_nightly_reset_ends_the_game(fast, monkeypatch):
    monkeypatch.setattr(ge, "next_midnight_s", lambda now: now + 0.3)
    monkeypatch.setattr(ge, "reset_due", lambda day, now: True)
    with TestClient(appmod.app) as c, _pilots(c, "gg-night", ["Eric", "Maggie"]) as w:
        rm = appmod.rooms["gg-night"]
        w["Eric"].send_json({"type": "gg_create"})
        assert _wait_until(lambda: rm.gg is not None)
        assert _wait_until(lambda: rm.gg is None, 3.0)
        assert _of(_drain(w["Maggie"]), "gg_summary")[0]["end_reason"] == "nightly"


def test_an_emptied_room_writes_a_game_that_scored_a_leg(fast):
    room = "gg-empty-" + uuid.uuid4().hex[:8]
    with TestClient(appmod.app) as c:
        with _pilots(c, room, ["Eric", "Maggie"]) as w:
            rm = appmod.rooms[room]
            w["Eric"].send_json({"type": "gg_create"})
            _ready_all(w, ["Eric", "Maggie"])
            _vote_leg(rm, w, ["Eric", "Maggie"], "course:" + _course_ids()[0])
            _race_leg(room, w, ["Eric", "Maggie"])
            assert _wait_until(lambda: rm.gg.legs_done == 1)

        def stored():
            with sqlite3.connect(appmod.DB_PATH) as conn:
                return conn.execute("SELECT end_reason, legs_done FROM gungame_games WHERE room = ?", (room,)).fetchall()
        assert _wait_until(lambda: stored() == [("emptied", 1)])


def test_the_leg_candidates_draw_courses_and_a_dash_route():
    out = appmod._gg_leg_candidates_in_thread(["Nobody"])
    courses = [c for c in out if c["kind"] == "course"]
    assert len(courses) == appmod.VOTE_CANDIDATES + 1 and courses[-1]["course_id"] == appmod.SURPRISE_ME
    assert all(c["choice"] == "course:" + c["course_id"] for c in courses)
    for d in (c for c in out if c["kind"] == "dash"):
        assert d["choice"].startswith("dash:") and d["dep"]["icao"] and d["dst"]["icao"]


def test_the_rogue_leg_starter_is_shared_and_still_starts_a_run(monkeypatch):
    """The Roguelike Cup's legs start through _wrapped_start_leg now (Gun Game's too)."""
    monkeypatch.setattr(appmod, "ROGUE_LEG_LEAD_S", 1)
    with TestClient(appmod.app) as c, _pilots(c, "gg-rogue-shared", ["Eric", "Maggie"]) as w:
        rm = appmod.rooms["gg-rogue-shared"]
        w["Eric"].send_json({"type": "rogue_start", "legs": [{"course_id": i} for i in _course_ids()]})
        assert _wait_until(lambda: rm.rogue is not None and rm.phase == "countdown")
        assert set(rm.race.racers) == {"Eric", "Maggie"}


def test_an_unlisted_model_needs_no_career_unlock(tmp_path):
    """Regression: adding the unlisted gold toilet to race/models/index.json switched the Career
    off ("no unlock for ['toilet-gold']"). Unlisted models are a mode's to wear, never a reward."""
    ids = appmod._model_ids(appmod.MODELS_DIR)
    assert "toilet" in ids and "toilet-gold" not in ids
    (tmp_path / "index.json").write_text(json.dumps([{"id": "a", "file": "a.glb"}, {"id": "b", "file": "b.glb", "listed": False},
                                                     {"id": "c", "file": "c.glb", "listed": True}]))
    assert appmod._model_ids(str(tmp_path)) == {"a", "c"}
    with TestClient(appmod.app):
        assert appmod.CAMPAIGN_PROBLEMS == [] and appmod.CAMPAIGN is not None
