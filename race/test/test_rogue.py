"""Roguelike Cup (proto 12): the upgrade catalog, the pure run engine, and the relay glue.

Run: cd race/server && RACE_DB=/tmp/race-test.db python -m pytest ../test/test_server.py ../test/test_dash.py ../test/test_rogue.py -q
"""
import datetime as _dt
import json
import os
import random
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "server"))
import pytest

import rogue_engine as re_
from rogue_engine import RogueRun

CATALOG_PATH = os.path.join(HERE, "..", "data", "upgrades.json")


def _raw():
    with open(CATALOG_PATH, encoding="utf-8") as f:
        return json.load(f)


def _cat():
    cat, errs = re_.parse_catalog(_raw())
    assert errs == [], errs
    return cat


LEGS = [{"kind": "course", "course_id": "a", "name": "A"}, {"kind": "course", "course_id": "b", "name": "B"},
        {"kind": "dash", "from_icao": "KPDX", "to_icao": "KSEA", "ceiling_ft": None, "name": "KPDX→KSEA"}]


def _run(pilots=("Eric", "Steve"), legs=LEGS, **kw):
    return RogueRun(1, legs, _cat(), list(pilots), now_ms=1_000_000, now_s=1_790_000_000, seed="t", **kw)


def _row(cs, status="finished", **kw):
    return {"callsign": cs, "status": status, **kw}


# =============================================================================== catalog schema
def test_shipped_catalog_is_valid_and_has_the_starter_set():
    cat = _cat()
    assert list(cat.upgrades) == ["tuned-intake", "extra-boost", "shield-capacitor", "slipstream", "climb-kit", "bad-luck-charm"]
    assert set(cat.debuffs) == {"duct-tape", "smoke"}
    assert cat.upgrades["tuned-intake"]["max_stacks"] == 3
    assert cat.upgrades["extra-boost"]["max_stacks"] == 2
    assert cat.upgrades["slipstream"]["effects"][0] == {"fn": "cap_pct", "pct": 4, "when": "slipstream", "range_m": 400}
    assert cat.upgrades["shield-capacitor"]["effects"][0] == {"fn": "shield_ms", "ms": 2000}
    assert cat.upgrades["climb-kit"]["effects"][0]["pitch_deg"] == 15
    assert cat.upgrades["climb-kit"]["effects"][0]["cooldown_ms"] == 10000
    assert cat.upgrades["bad-luck-charm"]["effects"] == [{"fn": "next_box", "item": "missile"}]
    assert cat.debuffs["duct-tape"]["effects"] == [{"fn": "cap_pct", "pct": -5}]
    assert {"fn": "cap_pct", "pct": -10} in cat.debuffs["smoke"]["effects"]


@pytest.mark.parametrize("mutate, needle", [
    (lambda c: c.update(version=2), "version"),
    (lambda c: c["upgrades"][0].update(id="Bad Id"), "bad id"),
    (lambda c: c["upgrades"][1].update(id="tuned-intake"), "duplicate id"),
    (lambda c: c["upgrades"][0].update(rarity="mythic"), "rarity"),
    (lambda c: c["upgrades"][0].update(cost=-1), "cost"),
    (lambda c: c["upgrades"][0].update(cost=True), "cost"),
    (lambda c: c["upgrades"][0].update(max_stacks=0), "max_stacks"),
    (lambda c: c["upgrades"][0].update(name=""), "name"),
    (lambda c: c["upgrades"][0].update(description="x" * 200), "description"),
    (lambda c: c["upgrades"][0].update(effects=[]), "effects"),
    (lambda c: c["upgrades"][0].update(effects=[{"fn": "teleport"}]), "unknown fn"),
    (lambda c: c["upgrades"][0].update(effects=[{"fn": "cap_pct"}]), "needs 'pct'"),
    (lambda c: c["upgrades"][0].update(effects=[{"fn": "cap_pct", "pct": 500}]), "bad 'pct'"),
    (lambda c: c["upgrades"][0].update(effects=[{"fn": "cap_pct", "pct": 5, "extra": 1}]), "unknown arg"),
    (lambda c: c["upgrades"][0].update(effects=[{"fn": "next_box", "item": "nuke"}]), "bad 'item'"),
    (lambda c: c["upgrades"][0].update(surprise=1), "unknown field"),
    (lambda c: c["debuffs"][0].update(legs=0), "legs"),
    (lambda c: c.update(debuffs=[c["debuffs"][1]]), "'duct-tape'"),
    (lambda c: [u.update(rarity="rare") for u in c["upgrades"]], "catch-up"),
    (lambda c: c.update(upgrades=[]), "upgrades must be"),
])
def test_catalog_validation_refuses(mutate, needle):
    raw = _raw()
    mutate(raw)
    errs = re_.validate_catalog(raw)
    assert any(needle in e for e in errs), errs
    assert re_.parse_catalog(raw) == (None, errs)


def test_load_catalog_never_raises(tmp_path):
    p = tmp_path / "bad.json"
    p.write_text("{nope", encoding="utf-8")
    cat, errs = re_.load_catalog(str(p))
    assert cat is None and errs
    cat, errs = re_.load_catalog(str(tmp_path / "missing.json"))
    assert cat is None and errs
    cat, errs = re_.load_catalog(CATALOG_PATH)
    assert cat is not None and errs == []


# =============================================================================== parts awards
def test_parts_for_by_place():
    assert [re_.parts_for(i, "finished") for i in (1, 2, 3, 4, 7)] == [6, 4, 3, 2, 2]
    assert re_.parts_for(None, "dnf") == 0
    assert re_.parts_for(1, "dnf") == 0


def test_leg_awards_places_among_run_pilots_only():
    run = _run(pilots=("Eric", "Steve", "Maggie", "Moo"))
    rows = [_row("Stranger"), _row("Steve"), _row("Eric"), _row("Maggie"), _row("Moo")]
    a = run.leg_awards(rows, "race", random.Random(1))
    assert "Stranger" not in a
    assert [a[c]["place"] for c in ("Steve", "Eric", "Maggie", "Moo")] == [1, 2, 3, 4]
    assert [a[c]["parts"] for c in ("Steve", "Eric", "Maggie", "Moo")] == [6, 4, 3, 2]
    assert a["Steve"]["reasons"][0] == {"why": "1st place", "parts": 6}


def test_landing_bonus_only_on_a_dash_and_only_above_the_threshold():
    run = _run()
    rows = [_row("Eric", landing={"landing_score": 701, "sink_fpm": 300}),
            _row("Steve", landing={"landing_score": 700, "sink_fpm": 300})]
    a = run.leg_awards(rows, "dash", random.Random(1))
    assert a["Eric"]["parts"] == 6 + 1
    assert {"why": "landing score 701", "parts": 1} in a["Eric"]["reasons"]
    assert a["Steve"]["parts"] == 4
    a = run.leg_awards(rows, "race", random.Random(1))       # a gate leg has no landing to score
    assert a["Eric"]["parts"] == 6


# =============================================================================== catch-up
def test_catchup_last_place_gets_a_free_common_upgrade():
    run = _run(pilots=("Eric", "Steve", "Maggie"))
    rows = [_row("Eric"), _row("Steve"), _row("Maggie", "dnf")]
    a = run.leg_awards(rows, "race", random.Random(3))
    pick = a["Maggie"]["free_upgrade"]
    assert pick and run.catalog.upgrades[pick]["rarity"] == "common"
    assert a["Eric"]["free_upgrade"] is None and a["Steve"]["free_upgrade"] is None
    run.apply_awards(a)
    assert run.pilots["Maggie"].owned == {pick: 1}
    assert run.pilots["Maggie"].parts == 0           # free: no parts spent


def test_catchup_tie_goes_to_the_worse_placed_row():
    run = _run(pilots=("Eric", "Steve", "Maggie"))
    rows = [_row("Eric"), _row("Steve", "dnf"), _row("Maggie", "dnf")]   # the engine orders DNFs too
    a = run.leg_awards(rows, "race", random.Random(1))
    assert a["Maggie"]["free_upgrade"] and a["Steve"]["free_upgrade"] is None


def test_catchup_skips_maxed_commons_and_needs_two_pilots():
    run = _run()
    for u in run.catalog.upgrades.values():
        if u["rarity"] == "common":
            run.pilots["Steve"].owned[u["id"]] = u["max_stacks"]
    a = run.leg_awards([_row("Eric"), _row("Steve")], "race", random.Random(1))
    assert a["Steve"]["free_upgrade"] is None
    assert any("none left" in r["why"] for r in a["Steve"]["reasons"])
    solo = _run(pilots=("Eric",))
    assert solo.leg_awards([_row("Eric")], "race", random.Random(1))["Eric"]["free_upgrade"] is None


# =============================================================================== debuffs
def test_hard_landing_threshold_is_strictly_above_900_fpm():
    run = _run()
    a = run.leg_awards([_row("Eric", landing={"sink_fpm": 901, "landing_score": 100}),
                        _row("Steve", landing={"sink_fpm": -900, "landing_score": 100})], "dash", random.Random(1))
    assert "duct-tape" in a["Eric"]["debuffs_next"]
    assert "duct-tape" not in a["Steve"]["debuffs_next"]


def test_dnf_gets_smoke_and_debuffs_last_exactly_one_leg():
    run = _run()
    run.score_leg([_row("Eric"), _row("Steve", "dnf")], "race", random.Random(1))
    assert run.pilots["Steve"].debuffs == {"smoke": 1}
    effects = run.pilot_effects("Steve")
    assert {"fn": "cap_pct", "pct": -10, "from": "smoke", "name": "Smoke", "stacks": 1, "debuff": True} in effects
    assert any(e["fn"] == "screen" and e["variant"] == "smoke" for e in effects)
    run.open_shop(2_000_000)
    run.close_shop()
    assert run.pilots["Steve"].debuffs == {"smoke": 1}       # still on for the next leg
    run.score_leg([_row("Steve"), _row("Eric")], "race", random.Random(1))
    assert run.pilots["Steve"].debuffs == {}                 # it ran that leg, and is gone


def test_dash_dns_counts_as_a_dnf():
    run = _run()
    a = run.leg_awards([_row("Eric"), _row("Steve", "dns")], "dash", random.Random(1))
    assert a["Steve"]["parts"] == 0 and a["Steve"]["status"] == "dns"
    assert "smoke" in a["Steve"]["debuffs_next"]


# =============================================================================== the shop
def _shop_run():
    run = _run()
    run.score_leg([_row("Eric"), _row("Steve")], "race", random.Random(1))
    run.open_shop(5_000_000)
    return run


def test_shop_offers_are_distinct_seeded_and_skip_maxed():
    run = _shop_run()
    offers = run.pilots["Eric"].offers
    assert len(offers) == re_.SHOP_OFFERS == len(set(offers))
    assert offers == run.shop_offers("Eric")                  # deterministic per seed/leg/pilot
    run.pilots["Eric"].owned["tuned-intake"] = 3
    for _ in range(5):
        assert "tuned-intake" not in run.shop_offers("Eric")


def test_shop_buy_validates_cost_stacks_offer_and_timer():
    run = _shop_run()
    eric = run.pilots["Eric"]                                 # 6 parts after a win
    eric.offers = ["tuned-intake", "climb-kit", "extra-boost"]
    assert run.buy("Eric", "climb-kit", 5_000_001) == "not enough parts (have 6, need 7)"
    assert run.buy("Eric", "slipstream", 5_000_001) == "Slipstream is not on offer to you"
    assert run.buy("Eric", "warp", 5_000_001) == "unknown upgrade 'warp'"
    assert run.buy("Nobody", "tuned-intake", 5_000_001) == "you are not in this run"
    assert run.buy("Eric", "tuned-intake", 5_000_001) is None
    assert eric.parts == 2 and eric.owned == {"tuned-intake": 1}
    eric.parts = 50
    assert run.buy("Eric", "tuned-intake", 5_000_002) is None
    assert run.buy("Eric", "tuned-intake", 5_000_003) is None
    assert run.buy("Eric", "tuned-intake", 5_000_004) == "Tuned intake is already at max (3)"
    deadline = run.shop_deadline_ms
    assert deadline == 5_000_000 + re_.SHOP_S * 1000
    assert run.buy("Eric", "extra-boost", deadline - 1) is None
    assert run.buy("Eric", "extra-boost", deadline) == "the shop is closed"
    run.close_shop()
    assert run.buy("Eric", "extra-boost", 5_000_005) == "the shop is closed"


def test_bad_luck_charm_forces_one_missile():
    run = _shop_run()
    run.pilots["Eric"].offers = ["bad-luck-charm"]
    assert run.buy("Eric", "bad-luck-charm", 5_000_001) is None
    assert any(e["fn"] == "next_box" for e in run.pilot_effects("Eric"))
    assert run.take_box("Eric") == "missile"
    assert run.take_box("Eric") is None
    assert not any(e["fn"] == "next_box" for e in run.pilot_effects("Eric"))


def test_shield_bonus_from_owned_capacitor():
    run = _shop_run()
    assert run.shield_bonus_ms("Eric") == 0
    run.pilots["Eric"].owned["shield-capacitor"] = 1
    assert run.shield_bonus_ms("Eric") == 2000
    assert run.shield_bonus_ms("Nobody") == 0


def test_card_personalises_offers_only_in_the_shop():
    run = _shop_run()
    c = run.card("Eric")
    assert c["phase"] == "shop" and len(c["offers"]) == re_.SHOP_OFFERS
    assert set(c["offers"][0]) == {"id", "name", "rarity", "cost", "description", "max_stacks", "owned"}
    assert run.card(None)["offers"] == []
    run.close_shop()
    assert run.card("Eric")["offers"] == []


def test_close_shop_advances_and_ends_after_the_last_leg():
    run = _run()
    for i in range(3):
        assert run.current_leg() == LEGS[i]
        run.score_leg([_row("Eric"), _row("Steve")], "race", random.Random(i))
        run.open_shop(1)
        nxt = run.close_shop()
        assert nxt == (LEGS[i + 1] if i < 2 else None)
    assert run.phase == re_.OVER and run.current_leg() is None


def test_leg_count_bounds():
    with pytest.raises(ValueError):
        _run(legs=LEGS[:2])
    with pytest.raises(ValueError):
        _run(legs=LEGS * 3)


def test_summary_ranks_by_parts_earned_and_has_a_chat_line():
    run = _run()
    run.score_leg([_row("Steve"), _row("Eric")], "race", random.Random(1))
    run.end("complete")
    s = run.summary(9)
    assert [x["callsign"] for x in s["standings"]] == ["Steve", "Eric"]
    assert s["standings"][0]["earned"] == 6 and s["standings"][0]["wins"] == 1
    assert s["legs_done"] == 1 and s["end_reason"] == "complete"
    line = re_.summary_line(s)
    assert line.startswith("Roguelike run over, 1/3 legs: 1. Steve 6 parts") and len(line) <= 240
    run.end("nightly")
    assert "(nightly reset)" in re_.summary_line(run.summary(9))


def test_rename_keeps_the_pilot():
    run = _run()
    run.pilots["Eric"].parts = 9
    run.rename("Eric", "Rick")
    assert "Eric" not in run.pilots and run.pilots["Rick"].parts == 9


# =============================================================================== nightly reset
def _pt(y, m, d, hh, mm, dst):
    off = -7 if dst else -8
    return _dt.datetime(y, m, d, hh, mm, tzinfo=_dt.timezone(_dt.timedelta(hours=off))).timestamp()


def test_pacific_day_follows_dst():
    # Summer (PDT, UTC-7): 23:59 and 00:01 local fall either side of midnight.
    assert re_.pacific_day(_pt(2026, 7, 1, 23, 59, True)) == "2026-07-01"
    assert re_.pacific_day(_pt(2026, 7, 2, 0, 1, True)) == "2026-07-02"
    # Winter (PST, UTC-8): a fixed UTC-7 would roll over an hour early, at 23:00 local.
    assert re_.pacific_day(_pt(2026, 12, 1, 23, 30, False)) == "2026-12-01"
    assert re_.pacific_day(_pt(2026, 12, 2, 0, 0, False)) == "2026-12-02"


def test_reset_due_and_next_midnight():
    t = _pt(2026, 12, 1, 22, 0, False)
    day = re_.pacific_day(t)
    assert not re_.reset_due(day, t)
    nxt = re_.next_midnight_s(t)
    assert nxt - t == 2 * 3600
    assert not re_.reset_due(day, nxt - 1)
    assert re_.reset_due(day, nxt)
    # Across the November DST change the night is 25 h long, and midnight is still local midnight.
    t = _pt(2026, 10, 31, 12, 0, True)
    assert re_.next_midnight_s(t) == _pt(2026, 11, 1, 0, 0, True)
