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

def _recv(ws, skip=("lobby", "world", "box_state")):
    """Next frame that is not one of the additive broadcasts every socket gets anyway.

    `lobby` (proto 2) lands whenever anyone joins, readies, or the host changes something;
    `world` and `box_state` (proto 3) land on position updates and box pickups. Tests written
    against the older frames read past all three; a test that cares about one passes `skip=()`.
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
            assert joined["proto"] == appmod.PROTO == 3
            assert appmod.LOBBY_PROTO == 2 and appmod.ITEMS_PROTO == 3
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
            assert _recv(host_ws) == {"type": "error", "detail": "no course set"}

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
            assert appmod.rooms["clearroom"].rules == {"powerups": False, "teleport": False}

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
            hit = _recv(old_ws, skip=("lobby", "world", "box_state", "fired", "resolved"))
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
            fx = _recv(lead_ws, skip=("lobby", "world", "box_state"))
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
            assert _recv(a_ws, skip=("lobby", "world")) == {"type": "grant", "item": "boost", "box": 2}
            state = _recv(a_ws, skip=("lobby", "world"))
            assert state["type"] == "box_state" and state["id"] == 2
            assert before + int(appmod.BOX_RESPAWN_S * 1000) <= state["until_server_ms"] <= \
                appmod.server_ms() + int(appmod.BOX_RESPAWN_S * 1000)
            # B is told the box is dark too, before it hears what A picked up.
            assert _recv(b_ws, skip=("lobby", "world"))["type"] == "box_state"
            assert _recv(b_ws, skip=("lobby", "world")) == {"type": "boxed", "callsign": "A", "item": "boost"}

            # B arrives a moment later: refused, with the relight time and no grant.
            b_ws.send_json({"type": "box", "id": 2})
            refusal = _recv(b_ws, skip=("lobby", "world"))
            assert refusal["type"] == "box_state" and refusal["id"] == 2
            assert appmod.rooms["boxroom"].players["B"].carrying is None, "a dark box grants nothing"

            # …and a different box is unaffected.
            b_ws.send_json({"type": "box", "id": 3})
            assert _recv(b_ws, skip=("lobby", "world"))["type"] == "grant"


def test_a_box_that_has_relit_grants_again(monkeypatch):
    monkeypatch.setattr(appmod, "roll_item", lambda rank, n, rng=None: "goop")
    monkeypatch.setattr(appmod, "BOX_RESPAWN_S", 0.0)
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/race/relitroom") as ws:
            _join(ws, "A")
            ws.send_json({"type": "box", "id": 0})
            assert _recv(ws, skip=("lobby", "world", "box_state"))["type"] == "grant"
            ws.send_json({"type": "box", "id": 0})
            assert _recv(ws, skip=("lobby", "world", "box_state"))["type"] == "grant"


def test_a_joiner_is_told_about_live_bananas_and_dark_boxes(monkeypatch):
    monkeypatch.setattr(appmod, "roll_item", lambda rank, n, rng=None: "banana")
    with TestClient(appmod.app) as c:
        with c.websocket_connect("/ws/race/lateroom") as a_ws:
            _join(a_ws, "A")
            a_ws.send_json({"type": "pos", "lat": 45.0, "lon": -122.0, "gate": 1, "elapsed_ms": 0, "alt": 700.0})
            assert _recv(a_ws)["type"] == "standings"
            a_ws.send_json({"type": "box", "id": 5})
            assert _recv(a_ws, skip=("lobby", "world", "box_state"))["type"] == "grant"
            a_ws.send_json({"type": "fire", "item": "banana"})
            dropped = _recv(a_ws, skip=("lobby", "world", "box_state"))
            assert dropped["type"] == "dropped"

            with c.websocket_connect("/ws/race/lateroom") as b_ws:
                b_ws.send_json({"type": "join", "callsign": "B"})
                assert _recv(b_ws, skip=())["type"] == "joined"
                # The catch-up frames land right after `joined`, before the lobby broadcast.
                seen = [_recv(b_ws, skip=("lobby",)) for _ in range(2)]
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
            world = _recv(b_ws, skip=("lobby", "standings"))
            assert world["type"] == "world"
            assert [p["callsign"] for p in world["players"]] == ["A"]
            # An old client that omits alt is still in the frame, at zero — never missing.
            b_ws.send_json({"type": "pos", "lat": 46.0, "lon": -123.0, "gate": 1, "elapsed_ms": 0})
            appmod.rooms["world2room"].world_last -= appmod.WORLD_MIN_INTERVAL_S + 0.1
            b_ws.send_json({"type": "pos", "lat": 46.0, "lon": -123.0, "gate": 2, "elapsed_ms": 10})
            while True:   # read forward past A's own earlier (solo) world frame
                world = _recv(a_ws, skip=("lobby", "standings"))
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
