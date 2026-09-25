"""Offline tests for the rival generator: race/tools/envelope.py, rival_gen.py (and rival_common.py).

No network and no Node: server data comes from a fake opener, race.js answers (hash, spawn,
encode) are stubbed where a test needs them. The one test that really calls race.js through
race/tools/rival_node.js is skipped when Node isn't available.

Run: cd race && python -m pytest test/test_rivals.py -q
"""
import json
import math
import os
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "tools"))
import envelope as E  # noqa: E402
import rival_common as rc  # noqa: E402

G = rc.G0


# ------------------------------------------------------------------ synthetic flights
def rows_from_enu(enu, t_s, lat0=45.0, lon0=-122.0, roll=None):
    """ENU path (N,3) + times (s) -> trace rows [t_ms, lat, lon, alt, hdg, pitch, roll]."""
    frame = rc.Enu(lat0, lon0, 0.0)
    lat, lon, alt = frame.to_lla(enu)
    n = len(t_s)
    r = np.zeros(n) if roll is None else roll
    return np.column_stack([np.round(np.asarray(t_s) * 1000), np.round(lat, 6), np.round(lon, 6), np.round(alt, 1),
                            np.zeros(n), np.zeros(n), r])


def level_turn(v=250.0, n_load=6.0, secs=40.0, dt=0.25, alt=1000.0):
    w = v * math.sqrt(n_load ** 2 - 1) * G / v / v          # omega = g*sqrt(n^2-1)/v
    t = np.arange(0, secs, dt)
    rad = v / w
    enu = np.column_stack([rad * np.sin(w * t), rad * (1 - np.cos(w * t)), np.full(len(t), alt)])
    return t, enu, w


def straight_accel(v0=150.0, a=5.0, secs=20.0, dt=0.25, alt=500.0):
    t = np.arange(0, secs, dt)
    s = v0 * t + 0.5 * a * t * t
    return t, np.column_stack([np.zeros(len(t)), s, np.full(len(t), alt)])


# ------------------------------------------------------------------ envelope: kinematics + binning
def test_kinematics_level_turn_recovers_load_factor_and_turn_rate():
    t, enu, w = level_turn(v=250.0, n_load=6.0)
    k = E.kinematics(rows_from_enu(enu, t))
    mid = slice(10, -10)
    assert np.median(k["v"][mid]) == pytest.approx(250.0, rel=0.01)
    assert np.median(k["n"][mid]) == pytest.approx(6.0, rel=0.03)
    assert abs(np.median(k["psi_dot"][mid])) == pytest.approx(w / rc.D2R, rel=0.03)
    assert np.max(np.abs(k["gamma"][mid])) < 0.5


def test_kinematics_straight_accel_recovers_tangential_accel():
    t, enu = straight_accel(a=5.0)
    k = E.kinematics(rows_from_enu(enu, t))
    assert np.median(k["a_t"]) == pytest.approx(5.0, abs=0.2)
    assert np.median(k["n"]) == pytest.approx(1.0, abs=0.05)      # level flight is 1 g


def test_kinematics_splits_at_gaps():
    t, enu = straight_accel(secs=30)
    rows = rows_from_enu(enu, t)
    rows[60:, 0] += 5000                       # a 5 s hole
    k = E.kinematics(rows)
    assert set(np.unique(k["seg"])) == {0, 1}


def test_bin_percentile_counts_and_empty_bins():
    v = np.array([45, 50, 55, 250, 251, 252], dtype=float)
    x = np.array([1, 2, 3, 10, 20, 30], dtype=float)
    vals, counts = E.bin_percentile(v, x, np.ones(6, bool), 50.0)
    assert counts[0] == 3 and vals[0] == pytest.approx(2.0)
    b250 = int(np.digitize([250], E.V_EDGES)[0] - 1)
    assert counts[b250] == 3 and vals[b250] == pytest.approx(20.0)
    assert math.isnan(vals[1]) and counts[1] == 0


def test_pava_monotone_and_skips_nan():
    y = [1.0, 3.0, 2.0, float("nan"), 5.0, 4.0]
    inc = E.pava(y, increasing=True)
    fin = inc[np.isfinite(inc)]
    assert np.all(np.diff(fin) >= -1e-12) and math.isnan(inc[3])
    dec = E.pava([5.0, 6.0, 3.0, 4.0], increasing=False)
    assert np.all(np.diff(dec) <= 1e-12)


def test_envelope_binning_on_synthetic_turns_and_straights():
    kins = []
    for v in (210.0, 270.0):
        t, enu, _ = level_turn(v=v, n_load=7.0, secs=60)
        kins.append(E.kinematics(rows_from_enu(enu, t)))
    t, enu = straight_accel(v0=180.0, a=6.0, secs=30)
    kins.append(E.kinematics(rows_from_enu(enu, t)))
    m = E.mine_tables(kins)
    b210 = int(np.digitize([210], E.V_EDGES)[0] - 1)
    assert m["counts"]["n_inst"][b210] >= E.THIN_N
    assert m["n_inst"][b210] == pytest.approx(7.0, rel=0.05)
    accel_bins = [i for i, c in enumerate(m["counts"]["accel_ms2"]) if c >= 10]
    assert accel_bins and all(m["accel_ms2"][i] == pytest.approx(6.0, abs=0.4) for i in accel_bins)


def test_merge_prefers_mined_then_lab_then_seed_and_flags_thin():
    seed = E.seed_envelope("7")
    nb = len(E.V_EDGES) - 1
    nan = [float("nan")] * nb
    mined = {"counts": {"n_inst": [0] * nb}, "n_inst": list(nan), "vmax_ms": [300.0, float("nan"), float("nan")],
             "vmax_counts": [500, 0, 0]}
    lab = {"counts": {"n_inst": [0] * nb}, "n_inst": list(nan), "vmax_ms": [float("nan")] * 3, "vmax_counts": [0] * 3}
    mined["n_inst"][8], mined["counts"]["n_inst"][8] = 9.0, 100      # good mined bin
    mined["n_inst"][9], mined["counts"]["n_inst"][9] = 30.0, 5       # thin mined bin ...
    lab["n_inst"][9], lab["counts"]["n_inst"][9] = 10.0, 40          # ... the lab fills it
    mined["n_inst"][6], mined["counts"]["n_inst"][6] = 3.0, 4        # thin, no lab: seed + flagged
    tables, sources, counts, thin = E.merge(seed, mined, lab)
    assert sources["n_inst"][8] == "mined" and sources["n_inst"][9] == "lab"
    assert sources["n_inst"][6] == "seed"
    assert any(s.startswith("n_inst@") and "(n=4)" in s for s in thin)
    assert sources["n_inst"][10] == "held" and tables["n_inst"][10] == pytest.approx(tables["n_inst"][9])
    assert sources["vmax_ms"] == ["mined", "held", "held"] and tables["vmax_ms"][0] == 300.0
    assert all(b >= a for a, b in zip(tables["vmax_ms"], tables["vmax_ms"][1:]))
    assert all(s <= i + 1e-9 for s, i in zip(tables["n_sus"], tables["n_inst"]))
    assert np.all(np.diff(tables["n_inst"]) >= -1e-9)


def test_merge_accel_tapers_to_zero_at_top_speed():
    seed = E.seed_envelope("7")
    nb = len(E.V_EDGES) - 1
    mined = {"counts": {"accel_ms2": [0] * nb}, "accel_ms2": [float("nan")] * nb,
             "vmax_ms": [350.0, float("nan"), float("nan")], "vmax_counts": [100, 0, 0]}
    mined["accel_ms2"][10], mined["counts"]["accel_ms2"][10] = 6.0, 200      # 250 m/s bin
    tables, sources, _, _ = E.merge(seed, mined)
    vc = E._v_centers()
    assert tables["accel_ms2"][10] == pytest.approx(6.0, abs=0.1)   # PAVA pools one seed bin in
    over = [a for v, a in zip(vc, tables["accel_ms2"]) if v >= 350]
    assert over and all(a == 0.0 for a in over)
    assert np.all(np.diff(tables["accel_ms2"]) <= 1e-9)


def test_classify_jet_rejects_slow_trace():
    t, enu = straight_accel(v0=40.0, a=0.2, secs=40)
    assert not E.classify_jet(E.kinematics(rows_from_enu(enu, t)))
    t, enu = straight_accel(v0=200.0, a=1.0, secs=40)
    assert E.classify_jet(E.kinematics(rows_from_enu(enu, t)))


def test_roll_column_that_is_not_bank_angle_is_not_mined():
    t, enu, _ = level_turn(v=250.0, n_load=6.0, secs=60)
    rows = rows_from_enu(enu, t, roll=np.full(len(t), 0.8))      # like race.js 1.x traces: |roll| <= 1
    m = E.mine_tables([E.kinematics(rows)])
    assert m["attitude_suspect"] and m["roll_sign"] is None and m["roll_rate_n"] == 0
    # level_turn() turns LEFT (psi falling): a real bank angle of -80 there means roll_sign +1
    # (positive roll = right wing down in a right turn); +80 means the sim's sign is flipped.
    for bank, sign in ((-80.0, 1), (80.0, -1)):
        m = E.mine_tables([E.kinematics(rows_from_enu(enu, t, roll=np.full(len(t), bank)))])
        assert not m["attitude_suspect"] and m["roll_sign"] == sign


def _fake_server(ghost_rows):
    """opener(url) for cached_get: /courses, /ghosts, /ghost; a HOUSE ghost that must be skipped."""
    enc = {"v": 1, "n": len(ghost_rows), "t": [ghost_rows[0][0]] + list(np.diff([r[0] for r in ghost_rows])),
           "lat": [r[1] for r in ghost_rows], "lon": [r[2] for r in ghost_rows], "alt": [r[3] for r in ghost_rows],
           "hdg": [0] * len(ghost_rows), "pitch": [0] * len(ghost_rows), "roll": [0] * len(ghost_rows)}
    enc["t"] = [float(x) for x in enc["t"]]
    calls = []

    def opener(url):
        calls.append(url)
        if "/courses" in url:
            return json.dumps([{"course_id": "c1", "course_hash": "0000abcd"}])
        if "/ghosts" in url:
            return json.dumps([{"callsign": "ACE", "time_ms": 1, "is_house": False},
                               {"callsign": "HOUSE", "time_ms": 1, "is_house": True}])
        if "/ghost" in url:
            assert "HOUSE" not in url
            return json.dumps({"trace": enc})
        raise AssertionError(url)
    return opener, calls


def test_download_skips_house_and_caches(tmp_path):
    t, enu = straight_accel(v0=200.0, secs=20)
    rows = rows_from_enu(enu, t).tolist()
    opener, calls = _fake_server(rows)
    got = E.download_traces({}, tmp_path, opener=opener)
    assert [g["callsign"] for g in got] == ["ACE"]
    n = len(calls)
    again = E.download_traces({}, tmp_path, offline=True)
    assert len(again) == 1 and len(calls) == n
    assert again[0]["rows"][:, 0].tolist() == pytest.approx([r[0] for r in rows])


def test_build_envelope_attributes_by_course_and_speed():
    t, enu, _ = level_turn(v=250.0, n_load=6.0, secs=60)
    fast = {"course_id": "a", "callsign": "X", "rows": rows_from_enu(enu, t)}
    t2, enu2 = straight_accel(v0=40.0, a=0.1, secs=60)
    slow = {"course_id": "a", "callsign": "CUB", "rows": rows_from_enu(enu2, t2)}
    bush = {"course_id": "b", "callsign": "Y", "rows": rows_from_enu(enu, t)}
    metas = {"a": {"aircraftId": "7"}, "b": {"aircraftId": "13"}}
    env, err = E.build_envelope("7", [fast, slow, bush], None, metas)
    assert err is None
    m = env["mining"]
    assert (m["traces_used"], m["traces_unattributed"], m["traces_other_aircraft"]) == (1, 1, 1)
    assert env["envelope_version"].startswith("seed-1")
    env13, err13 = E.build_envelope("13", [], None, metas)
    assert env13 is None and "no seed" in err13["reason"]


def test_lab_capture_routes_steps_to_tables():
    t, enu = straight_accel(v0=150.0, a=7.0, secs=20, dt=0.05)
    acc_rows = rows_from_enu(enu, t)
    tt, enu_t, _ = level_turn(v=210.0, n_load=8.0, secs=30, dt=0.05)
    turn_rows = rows_from_enu(enu_t, tt + 40)
    def pad(r, step):
        return np.column_stack([r, np.zeros((len(r), 3)), np.full(len(r), step)]).tolist()
    cap = {"kind": "fins-envelope-capture", "v": 1, "steps": [{"id": 1, "kind": "accel"}, {"id": 3, "kind": "turn"}],
           "samples": pad(acc_rows, 1) + pad(turn_rows, 3)}
    lab = E.mine_lab(cap)
    good = [a for a, c in zip(lab["accel_ms2"], lab["counts"]["accel_ms2"]) if c >= E.THIN_N]
    assert good and all(a == pytest.approx(7.0, abs=0.5) for a in good)
    b210 = int(np.digitize([210], E.V_EDGES)[0] - 1)
    assert lab["n_inst"][b210] == pytest.approx(8.0, rel=0.05)
    with pytest.raises(ValueError):
        E.mine_lab({"kind": "something-else"})


def test_enu_roundtrip_is_exact():
    f = rc.Enu(47.0, -122.0, 100.0)
    pts = np.array([[0, 0, 0], [5000.0, -3000.0, 800.0], [-40000.0, 60000.0, 3000.0]])
    lat, lon, alt = f.to_lla(pts)
    back = f.from_lla(lat, lon, alt)
    assert np.max(np.abs(back - pts)) < 1e-4


# ------------------------------------------------------------------ race.js via Node (integration)
def _have_node():
    try:
        rc.node_exe()
        return True
    except RuntimeError:
        return False


@pytest.mark.skipif(not _have_node(), reason="Node not available (set FINS_NODE)")
def test_node_bridge_hash_matches_pinned_course_hashes():
    pinned = json.loads((rc.RACE_DIR / "test" / "course_hashes.json").read_text(encoding="utf-8"))
    pinned = pinned if isinstance(pinned, dict) else {}
    courses, cups = rc.load_course_files()
    ids = [i for i in ("gorge-run", "crater-rim", "hood-circuit") if i in courses and i in pinned]
    assert ids
    metas = rc.course_metas({i: courses[i] for i in ids}, cups)
    for i in ids:
        assert metas[i]["hash"] == pinned[i]
        assert metas[i]["aircraftId"] == "7" and metas[i]["spawn"]["speedMs"] == pytest.approx(180 * rc.KT_MS, rel=1e-3)
