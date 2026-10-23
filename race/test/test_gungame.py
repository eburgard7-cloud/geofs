"""Gun Game (proto 14): the pure engine (gungame_engine.py) and its relay wiring in app.py.

Run: cd race/server && RACE_DB=/tmp/race-test.db python -m pytest ../test/test_gungame.py -q
"""
import copy
import json
import os
import random
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "server"))

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
