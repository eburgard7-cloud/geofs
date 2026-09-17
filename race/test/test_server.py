"""Run: cd race/server && RACE_DB=/tmp/race-test.db RACE_MIN_INTERVAL_S=0 python -m pytest ../test/test_server.py -q"""
import os, sys, time as _time
os.environ.setdefault("RACE_DB", "/tmp/race-test.db")
os.environ.setdefault("RACE_MIN_INTERVAL_S", "0")
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

def test_flow():
    with TestClient(appmod.app) as c:
        assert c.get("/health").json() == {"ok": True}
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
    # Leader table (rank 0 of 6): nothing=45, banana=45, goop=8, boost=2, missile=0
    # -> cumulative buckets [0,45] [45,90] [90,98] [98,100] [100,100]
    assert appmod.roll_item(0, 6, rng=FixedRng(10)) == "nothing"
    assert appmod.roll_item(0, 6, rng=FixedRng(60)) == "banana"
    assert appmod.roll_item(0, 6, rng=FixedRng(95)) == "goop"
    assert appmod.roll_item(0, 6, rng=FixedRng(99)) == "boost"
    # Last-place table (rank 5 of 6): nothing=0, banana=5, goop=10, boost=35, missile=50
    # -> cumulative buckets [0,0] [0,5] [5,15] [15,50] [50,100]
    assert appmod.roll_item(5, 6, rng=FixedRng(20)) == "boost"
    assert appmod.roll_item(5, 6, rng=FixedRng(99)) == "missile"

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
            assert leader_ws.receive_json()["type"] == "joined"
            last_ws.send_json({"type": "join", "callsign": "Last"})
            assert last_ws.receive_json()["type"] == "joined"

            # Every "pos" broadcasts standings to the whole room (both sockets already joined),
            # so drain both each time or the next expected read on either socket goes stale.
            leader_ws.send_json({"type": "pos", "lat": 45.0, "lon": -122.0, "gate": 5, "elapsed_ms": 1000})
            assert leader_ws.receive_json() == {"type": "standings", "order": ["Leader", "Last"]}
            assert last_ws.receive_json() == {"type": "standings", "order": ["Leader", "Last"]}

            last_ws.send_json({"type": "pos", "lat": 45.0, "lon": -122.0, "gate": 1, "elapsed_ms": 500})
            assert leader_ws.receive_json() == {"type": "standings", "order": ["Leader", "Last"]}
            assert last_ws.receive_json() == {"type": "standings", "order": ["Leader", "Last"]}

            last_ws.send_json({"type": "box"})
            assert last_ws.receive_json() == {"type": "grant", "item": "missile"}
            # Boxing also broadcasts to everyone else — drain it off Leader's socket.
            assert leader_ws.receive_json() == {"type": "boxed", "callsign": "Last", "item": "missile"}

            # A client can't ask for a different item than it was granted.
            last_ws.send_json({"type": "fire", "item": "goop"})
            assert last_ws.receive_json()["type"] == "error"

            last_ws.send_json({"type": "fire", "item": "missile"})
            assert leader_ws.receive_json() == {"type": "hit", "item": "missile", "from": "Last"}

def test_ws_box_broadcasts_what_you_picked_up_to_everyone_else(monkeypatch):
    # Drives the client's kill feed ("Steve boxed a missile"). Deliberately not secret.
    monkeypatch.setattr(appmod, "roll_item", lambda rank, n, rng=None: "goop")
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/race/feedroom") as a_ws, \
             c.websocket_connect("/ws/race/feedroom") as b_ws:
            a_ws.send_json({"type": "join", "callsign": "A"}); assert a_ws.receive_json()["type"] == "joined"
            b_ws.send_json({"type": "join", "callsign": "B"}); assert b_ws.receive_json()["type"] == "joined"

            a_ws.send_json({"type": "box"})
            assert a_ws.receive_json() == {"type": "grant", "item": "goop"}
            # B hears about it; A does not get its own boxed broadcast (it already got the grant).
            assert b_ws.receive_json() == {"type": "boxed", "callsign": "A", "item": "goop"}

            # Prove A's queue is empty of stray broadcasts by round-tripping a fresh box.
            a_ws.send_json({"type": "box"})
            assert a_ws.receive_json() == {"type": "grant", "item": "goop"}


def test_ws_banana_hits_whoever_crosses_it_next():
    # Every "pos" broadcasts standings to the whole room (both sockets), so each step below
    # drains exactly the messages that step produces from each socket, in FIFO order per socket.
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/race/bananaroom") as a_ws, \
             c.websocket_connect("/ws/race/bananaroom") as b_ws:
            a_ws.send_json({"type": "join", "callsign": "A"}); assert a_ws.receive_json()["type"] == "joined"
            b_ws.send_json({"type": "join", "callsign": "B"}); assert b_ws.receive_json()["type"] == "joined"

            a_ws.send_json({"type": "pos", "lat": 10.0, "lon": 20.0, "gate": 0, "elapsed_ms": 0})
            assert a_ws.receive_json()["type"] == "standings"
            assert b_ws.receive_json()["type"] == "standings"

            # A never had a grant, so its own carrying is None -> the fire is rejected.
            a_ws.send_json({"type": "fire", "item": "banana"})
            assert a_ws.receive_json()["type"] == "error"

            # Grant A a banana directly (bypassing the random box roll) and drop it. A banana
            # fire produces no reply to the shooter, so there's nothing to read here.
            appmod.rooms["bananaroom"].players["A"].carrying = "banana"
            a_ws.send_json({"type": "fire", "item": "banana"})

            # B is far away: no hit, just the usual standings broadcast to both.
            b_ws.send_json({"type": "pos", "lat": 40.0, "lon": 60.0, "gate": 0, "elapsed_ms": 0})
            assert a_ws.receive_json()["type"] == "standings"
            assert b_ws.receive_json()["type"] == "standings"

            # B moves onto the drop point: a hit (to B only), then the usual standings broadcast.
            b_ws.send_json({"type": "pos", "lat": 10.0, "lon": 20.0, "gate": 0, "elapsed_ms": 100})
            assert b_ws.receive_json() == {"type": "hit", "item": "banana", "from": "A"}
            assert b_ws.receive_json()["type"] == "standings"
            assert a_ws.receive_json()["type"] == "standings"
            assert appmod.rooms["bananaroom"].banana is None, "the banana is consumed after one hit"

def test_ws_message_validation_survives_malformed_input():
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/race/badroom") as ws:
            ws.send_text("not json{{{")
            assert ws.receive_json()["type"] == "error"
            ws.send_json({"type": "pos", "lat": 999, "lon": 0, "gate": 0, "elapsed_ms": 0})
            assert ws.receive_json()["type"] == "error"
            # the connection is still alive afterward
            ws.send_json({"type": "join", "callsign": "Steve"})
            assert ws.receive_json()["type"] == "joined"

def test_ws_oversized_frame_closes_the_connection():
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/race/bigroom") as ws:
            ws.send_text("x" * (appmod.MAX_WS_MSG_BYTES + 100))
            with pytest.raises(Exception):
                ws.receive_json()

def test_ws_rate_limit_replies_with_error_once_exceeded():
    orig = appmod.WS_RATE_LIMIT_PER_S
    appmod.WS_RATE_LIMIT_PER_S = 3
    try:
        with TestClient(appmod.app) as c:
            with c.websocket_connect("/ws/race/rateroom") as ws:
                ws.send_json({"type": "join", "callsign": "Flood"})
                assert ws.receive_json()["type"] == "joined"
                ws.send_json({"type": "box"}); assert ws.receive_json()["type"] == "grant"
                ws.send_json({"type": "box"}); assert ws.receive_json()["type"] == "grant"
                ws.send_json({"type": "box"})
                resp = ws.receive_json()
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
                ws.receive_json()
                for _ in range(4):
                    ws.send_json({"type": "box"})
                assert ws.receive_json()["type"] == "grant"
                assert ws.receive_json()["type"] == "error"
                assert ws.receive_json()["type"] == "error"
                with pytest.raises(Exception):
                    ws.receive_json()
    finally:
        appmod.WS_RATE_LIMIT_PER_S, appmod.WS_MAX_VIOLATIONS = orig_limit, orig_max

def test_ws_bad_room_name_is_rejected():
    with TestClient(appmod.app) as c:
        with pytest.raises(Exception):
            with c.websocket_connect("/ws/race/Not Valid!") as ws:
                ws.receive_json()

def test_ws_disconnect_cleans_up_an_empty_room():
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/race/cleanuproom") as ws:
            ws.send_json({"type": "join", "callsign": "Ghost"})
            ws.receive_json()
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
