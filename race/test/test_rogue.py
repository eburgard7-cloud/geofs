"""Roguelike Cup (proto 13): the upgrade catalog, the pure run engine, and the relay glue.

Run: cd race/server && RACE_DB=/tmp/race-test.db python -m pytest ../test/test_server.py ../test/test_dash.py ../test/test_rogue.py -q
"""
import contextlib
import datetime as _dt
import json
import os
import random
import sqlite3
import sys
import time as _time
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
os.environ.setdefault("RACE_DB", "/tmp/race-test.db")
os.environ.setdefault("RACE_MIN_INTERVAL_S", "0")
os.environ.setdefault("RACE_GET_MIN_INTERVAL_S", "0")
os.environ.setdefault("RACE_CLAIM_MIN_INTERVAL_S", "0")
os.environ.setdefault("RACE_TILE_WARM", "0")
os.environ.setdefault("RACE_THUMB_WARM", "0")
os.environ.setdefault("RACE_COURSES_DIR", os.path.join(HERE, "..", "courses"))
sys.path.insert(0, os.path.join(HERE, "..", "server"))
import pytest
from fastapi.testclient import TestClient

import app as appmod
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


# =============================================================================== the relay
def _wait_until(pred, timeout=3.0):
    start = _time.time()
    while _time.time() - start < timeout:
        if pred():
            return True
        _time.sleep(0.02)
    return False


def _join(ws, callsign, proto=None):
    proto = appmod.PROTO if proto is None else proto
    ws.send_json({"type": "join", "callsign": callsign, "client_proto": proto})
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
def _pilots(c, room, names, proto=None):
    with contextlib.ExitStack() as stack:
        wss = {}
        for n in names:
            ws = stack.enter_context(c.websocket_connect(f"/ws/race/{room}"))
            _join(ws, n, (proto or {}).get(n))
            wss[n] = ws
        yield wss


def _course_ids(n=3):
    """Ground-start courses: the relay never offers those a rolling start, so a leg always arms a
    plain countdown (an air-start leg may go to FORMATION, which is the gate race's business)."""
    return [c["course_id"] for c in appmod.COURSES if c["start_type"] == "ground"][:n]


@pytest.fixture
def fast(monkeypatch):
    """A 1 s server-started countdown and a 1 s shop, so a whole run fits in a test."""
    monkeypatch.setattr(appmod, "ROGUE_LEG_LEAD_S", 1)
    monkeypatch.setattr(appmod, "ROGUE_TICK_S", 0.05)
    monkeypatch.setattr(re_, "SHOP_S", 1)


def _finish(room, ws, offset=0):
    rm = appmod.rooms[room]
    go = max(0, appmod.server_ms() - rm.race.start_at_ms + offset)
    ws.send_json({"type": "finish", "race_id": rm.race_id, "go_time_ms": go})


def _dnf(room, ws):
    ws.send_json({"type": "dnf", "race_id": appmod.rooms[room].race_id, "gate": 1})


def _race_leg(room, wss, order, out=()):
    """Wait for the server-started leg to go green, then finish `order` (first wins) and DNF `out`."""
    rm = appmod.rooms[room]
    assert _wait_until(lambda: rm.phase == "racing" and rm.race is not None, 5.0), rm.phase
    for i, n in enumerate(order):
        _finish(room, wss[n], offset=i * 1000)
    for n in out:
        _dnf(room, wss[n])
    assert _wait_until(lambda: rm.phase == "results", 5.0), "the leg never ended"


def test_version_advertises_proto_13_and_rogue():
    with TestClient(appmod.app) as c:
        v = c.get("/version").json()
    assert v["proto"] >= 13 and "rogue" in v["features"]


def test_rogue_start_refusals():
    ids = _course_ids()
    with TestClient(appmod.app) as c, _pilots(c, "rogue-refuse", ["Host", "Pal", "Old"], proto={"Old": 11}) as w:
        w["Old"].send_json({"type": "rogue_start", "legs": [{"course_id": i} for i in ids]})
        assert "the roguelike cup needs a proto-13 client" in _errors(_drain(w["Old"]))
        w["Pal"].send_json({"type": "rogue_start", "legs": [{"course_id": i} for i in ids]})
        assert "host only" in _errors(_drain(w["Pal"]))
        for legs, why in (([{"course_id": ids[0]}] * 2, "a run needs 3-6 legs"),
                          ([{"course_id": ids[0]}] * 7, "a run needs 3-6 legs"),
                          ([{"course_id": "no-such-course"}] + [{"course_id": i} for i in ids[:2]], "unknown course 'no-such-course'"),
                          ([{"dash": {"from_icao": "KPDX", "to_icao": "ZZZZ"}}] + [{"course_id": i} for i in ids[:2]], "unknown airport 'ZZZZ'")):
            w["Host"].send_json({"type": "rogue_start", "legs": legs})
            assert why in _errors(_drain(w["Host"])), why
        w["Host"].send_json({"type": "rogue_start", "cup": "No Such Cup"})
        assert "unknown cup 'No Such Cup'" in _errors(_drain(w["Host"]))
        w["Host"].send_json({"type": "rogue_start", "cup": "x", "legs": []})
        assert any("not both" in e for e in _errors(_drain(w["Host"])))
        w["Host"].send_json({"type": "rogue_buy", "upgrade_id": "tuned-intake"})
        assert "no run in this room" in _errors(_drain(w["Host"]))
        assert appmod.rooms["rogue-refuse"].rogue is None


def test_rogue_off_when_the_catalog_is_invalid(monkeypatch):
    monkeypatch.setattr(appmod, "ROGUE_CATALOG", None)
    with TestClient(appmod.app) as c, _pilots(c, "rogue-off", ["Host"]) as w:
        w["Host"].send_json({"type": "rogue_start", "legs": [{"course_id": i} for i in _course_ids()]})
        assert "the roguelike cup is off on this server" in _errors(_drain(w["Host"]))


def test_a_two_pilot_three_leg_run_end_to_end(fast):
    ids = _course_ids()
    room = "rogue-e2e-" + uuid.uuid4().hex[:8]
    with TestClient(appmod.app) as c, _pilots(c, room, ["Eric", "Maggie", "Old"], proto={"Old": 10}) as w:
        rm = appmod.rooms[room]
        w["Eric"].send_json({"type": "rogue_start", "legs": [{"course_id": i} for i in ids]})
        assert _wait_until(lambda: rm.rogue is not None and rm.phase == "countdown")
        assert rm.course["course_id"] == ids[0]
        assert set(rm.race.racers) == {"Eric", "Maggie", "Old"}       # everyone readied by the relay
        f = _drain(w["Eric"])
        card = _of(f, "rogue")[0]
        assert card["phase"] == "leg" and card["leg_count"] == 3 and card["legs"][0]["course_id"] == ids[0]
        assert _of(f, "start")
        # Starting, buying and starting events by hand are all closed to a run.
        w["Eric"].send_json({"type": "cup", "name": "Points", "race_count": 3})
        w["Maggie"].send_json({"type": "dash_create", "from_icao": "KPDX", "to_icao": "KSEA"})
        assert appmod.ROGUE_BUSY in _errors(_drain(w["Eric"]))
        assert appmod.ROGUE_BUSY in _errors(_drain(w["Maggie"]))

        # Leg 1: Eric wins, Maggie second (and last: the catch-up).
        _race_leg(room, w, ["Eric", "Maggie", "Old"])
        assert _wait_until(lambda: rm.rogue.phase == "shop")
        f = _drain(w["Maggie"])
        leg = _of(f, "rogue_leg")[0]
        rows = {r["callsign"]: r for r in leg["rows"]}
        assert rows["Eric"]["parts"] == 6 and rows["Maggie"]["parts"] == 4 and rows["Old"]["parts"] == 3
        assert rows["Old"]["free_upgrade"] and rows["Old"]["free_upgrade_name"]
        assert {"why": "1st place", "parts": 6} in rows["Eric"]["reasons"]
        assert leg["landing_scored"] is False
        shop = _of(f, "rogue")[-1]
        assert shop["phase"] == "shop" and shop["shop_deadline_server_ms"] and len(shop["offers"]) == re_.SHOP_OFFERS
        assert rm.linger_task is None                           # the run holds the room on its results
        # Eric buys something on offer that 6 parts covers; a non-offer is refused by name.
        eric_offers = rm.rogue.pilots["Eric"].offers
        rm.rogue.pilots["Eric"].offers = eric_offers = ["tuned-intake"] + [o for o in eric_offers if o != "tuned-intake"][:3]
        w["Eric"].send_json({"type": "rogue_buy", "upgrade_id": "tuned-intake"})
        bought = _of(_drain(w["Eric"]), "rogue")[-1]
        me = next(p for p in bought["pilots"] if p["callsign"] == "Eric")
        assert me["parts"] == 2 and me["owned"] == [{"id": "tuned-intake", "name": "Tuned intake", "stacks": 1}]
        assert {"fn": "cap_pct", "pct": 5, "from": "tuned-intake", "name": "Tuned intake", "stacks": 1, "debuff": False} in me["effects"]
        missing = next(u for u in rm.rogue.catalog.upgrades if u not in eric_offers)
        w["Eric"].send_json({"type": "rogue_buy", "upgrade_id": missing})
        assert any("is not on offer to you" in e for e in _errors(_drain(w["Eric"])))

        # The shop closes on its own and the relay starts leg 2 itself.
        assert _wait_until(lambda: rm.phase == "countdown" and rm.course["course_id"] == ids[1], 5.0)
        w["Eric"].send_json({"type": "rogue_buy", "upgrade_id": "tuned-intake"})
        assert "the shop is closed" in _errors(_drain(w["Eric"]))

        # Leg 2: Maggie DNFs (Smoke next leg).
        _race_leg(room, w, ["Eric", "Old"], out=["Maggie"])
        assert _wait_until(lambda: rm.rogue.phase == "shop")
        assert rm.rogue.pilots["Maggie"].debuffs == {"smoke": 1}
        assert _wait_until(lambda: rm.phase == "countdown" and rm.course["course_id"] == ids[2], 5.0)

        # Leg 3, the last: the run ends with its summary, a HOUSE chat line and its SQLite row.
        _race_leg(room, w, ["Maggie", "Eric", "Old"])
        assert _wait_until(lambda: rm.rogue is None)
        f = _drain(w["Maggie"])
        summary = _of(f, "rogue_summary")[0]
        assert summary["end_reason"] == "complete" and summary["legs_done"] == 3
        assert summary["standings"][0]["callsign"] == "Eric"              # 6 + 6 + 4
        assert rm.rogue_offs == [] and not rm.hooks.has()
        house = [x for x in _of(f, "chat") if x.get("from") == "HOUSE"]
        assert house and house[0]["text"].startswith("Roguelike run over, 3/3 legs: 1. Eric")
        assert rm.linger_task is not None                       # the last leg goes home the usual way
        # The old client raced every leg, never saw a rogue frame, and got the summary in chat.
        old = _drain(w["Old"])
        assert not [x for x in old if x["type"].startswith("rogue")]
        assert any(x["type"] == "chat" and x.get("from") == "HOUSE" for x in old)

    def stored():
        with sqlite3.connect(appmod.DB_PATH) as conn:
            return conn.execute("SELECT room, end_reason, legs_done, summary_json FROM rogue_runs WHERE room = ?",
                                (room,)).fetchall()
    assert _wait_until(lambda: len(stored()) == 1)
    row = stored()[0]
    assert row[:3] == (room, "complete", 3) and json.loads(row[3])["standings"][0]["callsign"] == "Eric"
    with TestClient(appmod.app) as c:
        runs = c.get("/api/rogue/runs").json()["runs"]
        mine = next(r for r in runs if r["room"] == room)
        assert mine["legs_done"] == 3 and mine["standings"][0]["callsign"] == "Eric"
        assert c.get(f"/api/rogue/runs/{mine['id']}").json()["id"] == mine["id"]
        assert c.get("/api/rogue/runs/999999").status_code == 404


def test_shield_capacitor_lengthens_the_relay_shield_cap(fast):
    with TestClient(appmod.app) as c, _pilots(c, "rogue-shield", ["Eric", "Maggie"]) as w:
        rm = appmod.rooms["rogue-shield"]
        w["Eric"].send_json({"type": "fx", "item": "shield", "ms": 9000})
        assert _of(_drain(w["Maggie"]), "fx")[0]["ms"] == appmod.SHIELD_MS
        w["Eric"].send_json({"type": "rogue_start", "legs": [{"course_id": i} for i in _course_ids()]})
        assert _wait_until(lambda: rm.rogue is not None)
        rm.rogue.pilots["Eric"].owned["shield-capacitor"] = 1
        _time.sleep(appmod.FX_MIN_INTERVAL_MS / 1000 + 0.05)
        w["Eric"].send_json({"type": "fx", "item": "shield", "ms": 9000})
        assert _of(_drain(w["Maggie"]), "fx")[-1]["ms"] == appmod.SHIELD_MS + 2000


def test_bad_luck_charm_makes_the_next_box_a_missile_once(fast):
    with TestClient(appmod.app) as c, _pilots(c, "rogue-box", ["Eric", "Maggie"]) as w:
        rm = appmod.rooms["rogue-box"]
        w["Eric"].send_json({"type": "rogue_start", "legs": [{"course_id": i} for i in _course_ids()]})
        assert _wait_until(lambda: rm.rogue is not None)
        rm.rogue.pilots["Maggie"].pending_box = "missile"
        w["Maggie"].send_json({"type": "box", "id": 3})
        assert _of(_drain(w["Maggie"]), "grant")[0]["item"] == "missile"
        assert rm.rogue.pilots["Maggie"].pending_box is None


def test_the_host_can_end_a_run_and_back_to_lobby_ends_it_too(fast):
    with TestClient(appmod.app) as c, _pilots(c, "rogue-end", ["Eric", "Maggie"]) as w:
        rm = appmod.rooms["rogue-end"]
        w["Eric"].send_json({"type": "rogue_start", "legs": [{"course_id": i} for i in _course_ids()]})
        assert _wait_until(lambda: rm.rogue is not None)
        w["Maggie"].send_json({"type": "rogue_end"})
        assert "host only" in _errors(_drain(w["Maggie"]))
        w["Eric"].send_json({"type": "rogue_end"})
        s = _of(_drain(w["Eric"]), "rogue_summary")[0]
        assert s["end_reason"] == "ended" and s["legs_done"] == 0
        assert rm.rogue is None and rm.phase == "countdown"     # the leg in flight is an ordinary race now
        w["Eric"].send_json({"type": "rogue_start", "legs": [{"course_id": i} for i in _course_ids()]})
        assert "the room is busy (countdown)" in _errors(_drain(w["Eric"]))
        w["Eric"].send_json({"type": "back_to_lobby"})
        assert _wait_until(lambda: rm.phase == "roam")
        w["Eric"].send_json({"type": "rogue_start", "legs": [{"course_id": i} for i in _course_ids()]})
        assert _wait_until(lambda: rm.rogue is not None)
        w["Eric"].send_json({"type": "back_to_lobby"})
        assert _wait_until(lambda: rm.rogue is None and rm.phase == "roam")


def test_a_nightly_reset_ends_the_run(fast, monkeypatch):
    monkeypatch.setattr(re_, "next_midnight_s", lambda now: now + 0.3)
    monkeypatch.setattr(re_, "reset_due", lambda day, now: True)
    with TestClient(appmod.app) as c, _pilots(c, "rogue-night", ["Eric", "Maggie"]) as w:
        rm = appmod.rooms["rogue-night"]
        w["Eric"].send_json({"type": "rogue_start", "legs": [{"course_id": i} for i in _course_ids()]})
        assert _wait_until(lambda: rm.rogue is not None)
        assert _wait_until(lambda: rm.rogue is None, 3.0)
        s = _of(_drain(w["Maggie"]), "rogue_summary")[0]
        assert s["end_reason"] == "nightly"


def test_a_joiner_gets_the_run_card_and_a_rename_keeps_the_pilot(fast):
    with TestClient(appmod.app) as c, _pilots(c, "rogue-join", ["Eric", "Maggie"]) as w:
        rm = appmod.rooms["rogue-join"]
        w["Eric"].send_json({"type": "rogue_start", "legs": [{"course_id": i} for i in _course_ids()]})
        assert _wait_until(lambda: rm.rogue is not None)
        with c.websocket_connect("/ws/race/rogue-join") as late:
            _join(late, "Late")
            assert _of(_drain(late), "rogue")
        w["Maggie"].send_json({"type": "rename", "callsign": "Maggs"})
        assert _wait_until(lambda: "Maggs" in rm.rogue.pilots and "Maggie" not in rm.rogue.pilots)


def _pdx_ping(ws):
    pdx = appmod.AIRPORTS.get("KPDX")
    ws.send_json({"type": "pos", "lat": pdx["lat"], "lon": pdx["lon"], "alt_m": 10.0, "on_ground": True,
                  "gs_kt": 0.0, "vs_fpm": 0, "hdg": 100.0})


def test_a_dash_leg_opens_a_card_with_everyone_and_goes_when_all_are_ready(fast):
    legs = [{"dash": {"from_icao": "KPDX", "to_icao": "KSEA"}}] + [{"course_id": i} for i in _course_ids(2)]
    with TestClient(appmod.app) as c, _pilots(c, "rogue-dash", ["Eric", "Maggie"]) as w:
        rm = appmod.rooms["rogue-dash"]
        w["Eric"].send_json({"type": "rogue_start", "legs": legs})
        assert _wait_until(lambda: rm.dash is not None and rm.phase == "dash_staging")
        assert set(rm.dash.entrants) == {"Eric", "Maggie"}
        assert rm.rogue.legs[0]["name"] == "KPDX→KSEA"
        for n in ("Eric", "Maggie"):
            _pdx_ping(w[n])
            w[n].send_json({"type": "dash_ready"})
            assert not _errors(_drain(w[n]))
        assert _wait_until(lambda: rm.phase == "dash_countdown", 3.0)
        assert rm.dash.lead_s == appmod.ROGUE_DASH_LEAD_S


def test_a_dash_leg_cancelled_before_go_is_a_washed_out_leg(fast):
    legs = [{"dash": {"from_icao": "KPDX", "to_icao": "KSEA"}}] + [{"course_id": i} for i in _course_ids(2)]
    with TestClient(appmod.app) as c, _pilots(c, "rogue-wash", ["Eric", "Maggie"]) as w:
        rm = appmod.rooms["rogue-wash"]
        w["Eric"].send_json({"type": "rogue_start", "legs": legs})
        assert _wait_until(lambda: rm.dash is not None)
        for n in ("Eric", "Maggie"):
            w[n].send_json({"type": "dash_leave"})
        assert _wait_until(lambda: rm.rogue is not None and rm.rogue.legs_done == 1, 3.0)
        leg = _of(_drain(w["Eric"]), "rogue_leg")[0]
        assert {r["status"] for r in leg["rows"]} == {"dnf"}
        assert rm.rogue.pilots["Eric"].debuffs == {"smoke": 1}
        assert _wait_until(lambda: rm.phase == "countdown", 5.0)     # leg 2 starts after the shop


def test_an_emptied_room_writes_a_run_that_scored_a_leg(fast):
    room = "rogue-empty-" + uuid.uuid4().hex[:8]
    with TestClient(appmod.app) as c:
        with _pilots(c, room, ["Eric", "Maggie"]) as w:
            rm = appmod.rooms[room]
            w["Eric"].send_json({"type": "rogue_start", "legs": [{"course_id": i} for i in _course_ids()]})
            assert _wait_until(lambda: rm.rogue is not None)
            _race_leg(room, w, ["Eric", "Maggie"])
            assert _wait_until(lambda: rm.rogue.phase == "shop")

        def stored():
            with sqlite3.connect(appmod.DB_PATH) as conn:
                return conn.execute("SELECT end_reason, legs_done FROM rogue_runs WHERE room = ?", (room,)).fetchall()
        assert _wait_until(lambda: stored() == [("emptied", 1)])


def test_start_race_returns_the_refusals_the_start_frame_sends():
    """start_race() is the StartMsg branch lifted out unchanged; the refusals come back as strings."""
    import asyncio
    r = appmod.Room("start-race-direct")
    assert asyncio.run(appmod.start_race(r, 5)) == "no course selected"
    r.course = {"course_id": "c", "course_hash": "0a1b2c3d", "name": "C", "start_type": "ground", "gates": []}
    r.players["A"] = appmod.Player(None, "A")
    assert asyncio.run(appmod.start_race(r, 5)) == "not everyone is ready"
    assert asyncio.run(appmod.start_race(r, 5, force=True)) == "nobody is racing"
    r.phase = "dash_staging"
    assert asyncio.run(appmod.start_race(r, 5)) == "a dash is in progress"
