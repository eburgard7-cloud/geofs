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


# ------------------------------------------------------------------ optimizer (rival_gen.py)
import rival_gen as R  # noqa: E402

LAT0, LON0 = 45.0, -122.0


def flat_env(vmax=300.0, accel=10.0, n_inst=9.0, n_sus=6.0, decel=10.0, roll=180.0):
    vc = E._v_centers()
    return {"v_centers": vc, "alt_bands_m": E.ALT_BANDS_M, "vmax_ms": [vmax] * 3,
            "n_inst": [n_inst] * len(vc), "n_sus": [n_sus] * len(vc),
            "accel_ms2": [accel if v < vmax else 0.0 for v in vc], "decel_ms2": [decel] * len(vc),
            "roll_rate_dps": roll, "roll_sign": 1}


def synth_meta(enu_gates, radius=100.0, spawn_back_m=2000.0, v0=150.0, laps=None):
    """A course in race.js's normalized shape from ENU gate centres (frame at LAT0/LON0)."""
    f = rc.Enu(LAT0, LON0, 0.0)
    P = np.asarray(enu_gates, dtype=float)
    lat, lon, alt = f.to_lla(P)
    radii = [radius] * len(P) if np.isscalar(radius) else list(radius)
    gates = [{"lat": float(a), "lon": float(b), "alt": float(c), "radius": float(radii[i])}
             for i, (a, b, c) in enumerate(zip(lat, lon, alt))]
    d = P[1] - P[0]
    d = d / np.linalg.norm(d)
    s = P[0] - spawn_back_m * d
    slat, slon, salt = f.to_lla(s)
    hdg = (math.degrees(math.atan2(d[0], d[1])) + 360) % 360
    course = {"id": "synthetic", "gates": gates, "aircraftId": None, "startType": "air"}
    if laps:
        course["laps"] = laps
    return {"id": "synthetic", "course": course, "aircraftId": "7", "startType": "air",
            "spawn": {"lat": float(slat), "lon": float(slon), "alt": float(salt), "heading": hdg, "speedMs": v0}}


def test_straight_line_time_is_distance_over_vmax():
    gates = [[0, i * 5000.0, 1000.0] for i in range(6)]         # 25 km straight north
    env = flat_env(vmax=300.0)
    geom = R.CourseGeom(synth_meta(gates, radius=100.0, v0=300.0))
    res = R.Evaluator(geom, R.Perf(env, 1.0), None).run(np.zeros((geom.n, 2)), ds=5.0, detail=True)
    raced = 25000.0 - 2 * 100.0                                  # leave sphere 0 -> touch the last sphere
    assert res["missed"] == 0
    assert res["time_s"] == pytest.approx(raced / 300.0, rel=0.003)


def test_straight_line_accel_ramp_from_spawn():
    gates = [[0, i * 5000.0, 1000.0] for i in range(4)]
    env = flat_env(vmax=300.0, accel=10.0)
    geom = R.CourseGeom(synth_meta(gates, radius=100.0, spawn_back_m=2000.0, v0=100.0))
    res = R.Evaluator(geom, R.Perf(env, 1.0), None).run(np.zeros((geom.n, 2)), ds=5.0, detail=True)
    # v^2 = v0^2 + 2 a s: at the start-sphere exit (2100 m from spawn) and on until Vmax
    v_exit = math.sqrt(100.0 ** 2 + 2 * 10.0 * 2100.0)
    t_to_vmax = (300.0 - v_exit) / 10.0
    s_to_vmax = (300.0 ** 2 - v_exit ** 2) / 20.0
    expect = t_to_vmax + (15000.0 - 200.0 - s_to_vmax) / 300.0
    assert res["time_s"] == pytest.approx(expect, rel=0.005)


def test_entry_speed_never_above_the_solo_spawn_maximum():
    gates = [[0, 0, 1000.0], [0, 8000.0, 1000.0], [0, 16000.0, 1000.0]]
    env = flat_env(vmax=400.0, accel=12.0)
    geom = R.CourseGeom(synth_meta(gates, radius=150.0, spawn_back_m=1852.0, v0=92.6))
    res = R.Evaluator(geom, R.Perf(env, 1.0), None).run(np.zeros((geom.n, 2)), ds=5.0, detail=True)
    v_t0 = float(np.interp(res["t0"], res["t"], res["v"]))
    bound = math.sqrt(92.6 ** 2 + 2 * 12.0 * (1852.0 + 150.0))  # best case: full accel from spawn to sphere exit
    assert 92.6 < v_t0 <= bound * 1.001


def test_ninety_degree_corner_speed_dip_matches_n_of_v():
    gates = [[0, 0, 1000.0], [0, 6000.0, 1000.0], [6000.0, 6000.0, 1000.0]]
    env = flat_env(vmax=350.0, n_inst=7.0, n_sus=7.0)     # n_sus = n_inst: no turn-drag bleed, the dip is pure n(v)
    geom = R.CourseGeom(synth_meta(gates, radius=20.0, v0=300.0))
    perf = R.Perf(env, 1.0)
    res = R.Evaluator(geom, perf, None).run(np.zeros((geom.n, 2)), ds=2.0, detail=True)
    i = int(np.argmin(res["v"][100:-100])) + 100
    v = res["v"][i]
    assert v < 300.0                                              # it did have to slow for the corner
    n_at = R.load_factor(np.array([v]), res["terms"]["kap"][i:i + 1], res["terms"]["uperp"][i:i + 1])[0]
    target = 7.0 * R.G_SAFETY_FRAC                                # the optimizer targets a margin under n(v), not the boundary
    assert n_at == pytest.approx(target, rel=0.02)
    n_all = R.load_factor(res["v"], res["terms"]["kap"], res["terms"]["uperp"])
    assert n_all.max() <= 7.0 * 1.02


def test_gate_window_respected_after_optimizing():
    gates = [[0, 0, 1000.0], [0, 4000.0, 1000.0], [3000.0, 6000.0, 1100.0], [6000.0, 4000.0, 1000.0], [9000.0, 6000.0, 1000.0]]
    geom = R.CourseGeom(synth_meta(gates, radius=200.0, v0=200.0))
    ev = R.Evaluator(geom, R.Perf(flat_env(), 0.95), None)
    off, rep = R.optimize(ev, 0.7, init=R.inside_turn_init(geom, 0.7), cap_s=10.0, seed=3)
    assert np.all(np.linalg.norm(off, axis=1) <= 0.7 * geom.r + 1e-6)
    res = ev.run(off, ds=2.0, detail=True)
    for j in range(geom.n):
        closest = np.min(np.linalg.norm(res["pos"] - geom.C[j], axis=1))
        assert closest <= 0.7 * geom.r[j] + 0.5
    assert rep["final_cost_s"] <= rep["start_cost_s"]
    assert set(rep) >= {"sweeps", "evals", "seconds", "converged", "last_sweep_gain_ms"}
    assert rep["final_cost_s"] < ev.run(np.zeros((geom.n, 2)))    # cutting corners inside the window pays


def test_optimizer_is_deterministic_for_a_seed():
    gates = [[0, 0, 1000.0], [0, 4000.0, 1000.0], [3000.0, 6000.0, 1000.0], [6000.0, 4000.0, 1000.0]]
    geom = R.CourseGeom(synth_meta(gates, radius=150.0))
    runs = []
    for _ in range(2):
        ev = R.Evaluator(geom, R.Perf(flat_env(), 0.9), None)
        off, _ = R.optimize(ev, 0.7, cap_s=1e9, seed=7)
        runs.append(off)
    assert np.array_equal(runs[0], runs[1])


def test_terrain_penalty_lifts_the_path_over_a_ridge():
    gates = [[0, 0, 1000.0], [0, 5000.0, 1000.0], [0, 10000.0, 1000.0]]
    frame = rc.Enu(LAT0, LON0, 0.0)

    def terrain(lat, lon):                    # a 980 m ridge 1.4 km past the middle gate (outside its floor ramp)
        p = frame.from_lla(lat, lon, np.zeros(len(lat)))
        return np.where(np.abs(p[:, 1] - 6400.0) < 150.0, 980.0, 0.0)

    geom = R.CourseGeom(synth_meta(gates, radius=150.0, v0=200.0))
    ev = R.Evaluator(geom, R.Perf(flat_env(), 0.95), terrain, min_agl=60.0)
    centre = ev.run(np.zeros((geom.n, 2)), detail=True)
    assert centre["min_agl_m"] < 60.0 and centre["penalty_s"] > 0
    off, _ = R.optimize(ev, 0.7, cap_s=10.0)
    res = ev.run(off, detail=True)
    assert res["min_clear_m"] >= -1.0 and off[1, 1] > 30.0        # it climbed through the top of gate 1


def test_lap_detection_and_native_laps_expansion():
    lap = [{"lat": 45.0 + i * 0.01, "lon": -122.0, "alt": 500.0, "radius": 80.0} for i in range(4)]
    unrolled = lap * 3 + [lap[0]]
    assert R.detect_lap_period(unrolled) == 4
    assert R.detect_lap_period(lap) is None
    route, lap_of, lap_gate, k, laps = R.expand_route({"gates": unrolled})
    assert (k, laps, len(route)) == (4, 3, 13) and lap_of[-1] == 2 and lap_gate[4] == 0
    route, lap_of, lap_gate, k, laps = R.expand_route({"gates": lap, "laps": 3})
    assert (k, laps, len(route)) == (4, 3, 13) and route[-1] == lap[0] and lap_gate[5] == 1


def test_gate_times_on_a_straight_path():
    pos = np.column_stack([np.zeros(1001), np.linspace(0, 10000, 1001), np.full(1001, 1000.0)])
    t = np.linspace(0, 100, 1001)                                  # 100 m/s
    C = np.array([[0, 2000.0, 1000.0], [0, 5000.0, 1000.0], [0, 9000.0, 1000.0]])
    r = np.array([100.0, 50.0, 200.0])
    t0, times = R.gate_times(pos, t, C, r)
    assert t0 == pytest.approx(21.0) and times == pytest.approx([49.5, 88.0])
    _, times = R.gate_times(pos, t, np.array([[0, 2000.0, 1000.0], [500.0, 5000.0, 1000.0]]), np.array([100.0, 50.0]))
    assert times == [None]


def test_spline_passes_through_every_waypoint():
    P = np.array([[0, 0, 0], [100, 50, 10], [300, 0, 20], [500, 200, 0.0]])
    pos, d1, d2, knots = R.natural_spline(P, 5.0)
    assert np.allclose(pos[knots], P, atol=1e-6)
    assert np.allclose(d2[0], 0) and np.allclose(d2[-1], 0)       # natural end conditions


def test_roll_rate_limiter():
    t = np.arange(0, 5, 0.05)
    x = np.where((t > 1) & (t < 3), 80.0, 0.0)
    y = R.rate_limit(x, t, 100.0)
    assert np.max(np.abs(np.diff(y) / np.diff(t))) <= 100.0 + 1e-9
    assert y.max() == pytest.approx(80.0) and y[0] == 0.0


def test_bank_follows_the_turn_and_trace_format():
    gates = [[0, 0, 1000.0], [0, 5000.0, 1000.0], [5000.0, 10000.0, 1000.0]]      # a right turn
    geom = R.CourseGeom(synth_meta(gates, radius=100.0, v0=250.0))
    perf = R.Perf(flat_env(), 1.0)
    res = R.fly_line(geom, perf, np.zeros((geom.n, 2)), None, 60.0)
    hdg, pitch, roll = R.attitude(res, perf)
    kap = np.linalg.norm(res["terms"]["kap"], axis=1)
    apex = int(np.argmax(kap[100:-100])) + 100
    assert roll[apex] > 45                                          # right turn, right wing down: positive roll
    assert np.all(np.abs(np.diff(roll) / np.diff(res["t"])) <= perf.roll_rate + 1e-6)
    rows, splits, time_ms = R.build_trace(res, geom, perf)
    assert rows[0][0] == 0 and rows[-2][0] == time_ms and splits[-1] == time_ms and len(splits) == geom.n - 1
    assert rows[-1][0] == time_ms + R.POST_FINISH_MS <= time_ms + 500     # the server's trace-end tolerance
    assert all(0 < b[0] - a[0] <= 250 for a, b in zip(rows, rows[1:]))
    assert all(len(r) == 7 and 0 <= r[4] < 360 for r in rows)


def test_js_round_is_half_up():
    assert R.js_round(0.25, 1) == 0.3 and R.js_round(-0.25, 1) == -0.2 and R.js_round(2.5, 0) == 3.0


# ------------------------------------------------------------------ personas + calibration (rival_personas.py)
import rival_personas as RP  # noqa: E402


def test_personas_file_has_the_four_rivals_and_one_global_ladder():
    cfg = RP.load_personas()
    P = RP.by_id(cfg)
    assert set(P) == {"steve", "brat", "moo", "dawg"}
    assert (P["steve"]["model"], P["brat"]["model"], P["moo"]["model"], P["dawg"]["model"]) == ("goldfish", "bratwurst", "cow", "hot-dawg")
    assert P["dawg"]["envelopeFrac"] == 0.98 and P["dawg"]["gateWindow"] == 0.7 and P["moo"]["gateWindow"] == 0.6
    assert (P["steve"]["line"], P["brat"]["line"], P["moo"]["line"], P["dawg"]["line"]) == ("centre", "half", "optimal", "optimal")
    lad = cfg["ladder"]
    assert lad["anchor"] == "dawg" and set(lad["ratios"]) == {"moo", "brat", "steve"} and lad["tolerance"] == 0.01
    assert 1.0 < lad["ratios"]["moo"] < lad["ratios"]["brat"] < lad["ratios"]["steve"]
    assert lad["solve_tolerance"] < lad["tolerance"]               # the solve leaves room for the judge's replay
    assert "calibration" not in cfg and cfg["minAglM"] == 60
    for p in cfg["personas"]:                                     # never a per-course knob in the global file
        assert not any(k in p for k in ("courses", "per_course", "overrides"))


def test_solve_pace_stage_a_slows_by_top_speed_only():
    t = lambda fr, cap: 100.0 / (fr * cap)                  # noqa: E731
    sol = RP.solve_pace(t, 150.0, 0.9, 0.98, cap_lo=0.3, tol=0.002)
    assert sol["stage"] == "A" and sol["envelopeFrac"] == 0.9 and sol["clamped"] is None
    assert sol["time_s"] == pytest.approx(150.0, rel=0.002) and sol["speedCap"] == pytest.approx(100.0 / (0.9 * 150.0), rel=0.01)


def test_solve_pace_stage_b_and_c_and_clamps():
    t = lambda fr, cap: 100.0 / (fr * cap)                  # noqa: E731
    sol = RP.solve_pace(t, 104.0, 0.9, 0.98)                # faster than frac0 at cap 1: raise the frac, never past DAWG's
    assert sol["stage"] == "B" and sol["speedCap"] == 1.0 and 0.9 < sol["envelopeFrac"] <= 0.98
    assert RP.solve_pace(t, 90.0, 0.9, 0.98)["clamped"] == "high"
    sol = RP.solve_pace(t, 500.0, 0.9, 0.98, cap_lo=0.3, frac_lo=0.4)   # cap floor still too fast: stage C lowers the frac
    assert sol["stage"] == "C" and sol["speedCap"] == 0.3 and sol["time_s"] == pytest.approx(500.0, rel=0.003)
    assert RP.solve_pace(t, 5000.0, 0.9, 0.98, cap_lo=0.3, frac_lo=0.4)["clamped"] == "low"


def _zigzag_course(laps=1):
    lap = [[0, 0, 1000.0], [0, 4000.0, 1000.0], [3000.0, 6000.0, 1000.0], [6000.0, 4000.0, 1000.0], [6000.0, 0.0, 1000.0]]
    pts = lap * laps + [lap[0]] if laps > 1 else lap
    return R.CourseGeom(synth_meta(pts, radius=150.0, v0=200.0))


def test_brat_runs_wide_on_two_seeded_gates_per_lap():
    geom = _zigzag_course(laps=3)
    assert geom.laps == 3 and geom.K == 5
    wide = RP.wide_gates(geom, 2, "some-course")
    assert wide == RP.wide_gates(geom, 2, "some-course")      # seeded by the course: stable
    assert 0 not in wide and geom.n - 1 not in wide
    per_lap = [sum(1 for i in wide if geom.lap_of[i] == lap) for lap in range(3)]
    assert per_lap == [2, 2, 2]
    optimal = R.inside_turn_init(geom, 0.7, 1.0)
    off, wide2 = RP.brat_offsets(geom, optimal, {"wideGatesPerLap": 2, "wideOffset": 0.8, "gateWindow": 1.0}, "some-course")
    assert wide2 == wide
    for i in range(geom.n):
        if i in wide:
            assert off[i, 0] == pytest.approx(geom.turn[i] * 0.8 * geom.r[i])   # outside of the turn
            assert np.sign(off[i, 0]) != np.sign(optimal[i, 0]) or optimal[i, 0] == 0
        else:
            assert off[i] == pytest.approx(0.5 * optimal[i])                  # halfway to the optimal line


def test_plan_lines_keeps_every_persona_inside_its_window():
    cfg = RP.load_personas()
    geom = _zigzag_course()
    lines, reports, geoms = RP.plan_lines(geom, flat_env(), cfg, None, 3.0, 1, 60.0)
    P = RP.by_id(cfg)
    for rid, off in lines.items():
        w = P[rid].get("gateWindow", 1.0)
        g = geoms[rid]
        assert np.all(np.linalg.norm(off[:g.n], axis=1) <= w * g.r + 1e-6), rid
    assert np.all(lines["steve"][:geom.n] == 0)
    assert reports["dawg"]["sweeps"] >= 1 and "wide_gates" in reports["brat"]
    times = {rid: R.Evaluator(geoms[rid], RP.persona_perf(flat_env(), P[rid]), None).run(lines[rid]) for rid in lines}
    assert times["dawg"] < times["moo"] < times["brat"] < times["steve"]


def test_generate_course_writes_rivals_in_race_js_format(monkeypatch):
    cfg = RP.load_personas()
    meta = synth_meta([[0, 0, 1000.0], [0, 4000.0, 1000.0], [3000.0, 6000.0, 1000.0], [6000.0, 4000.0, 1000.0]], radius=150.0, v0=92.6)
    meta["hash"] = "deadbeef"
    env = dict(flat_env(), envelope_version="seed-1")
    calls = []

    def fake_node(req):
        calls.append(req["op"])
        return [{"v": 1, "n": len(t["samples"])} for t in req["traces"]]
    monkeypatch.setattr(RP.rc, "node_call", fake_node)
    out = RP.generate_course(meta, env, cfg, None, None, cap_s=2.0)
    assert calls == ["encode"]
    assert out["course_hash"] == "deadbeef" and out["envelope_version"] == "seed-1" and out["aircraftId"] == "7"
    assert [r["rival_id"] for r in out["rivals"]] == ["steve", "brat", "moo", "dawg"] and not out["failures"]
    for r in out["rivals"]:
        assert set(r) >= {"rival_id", "name", "model", "time_ms", "splits_ms", "trace"}
        assert len(r["splits_ms"]) == 3 and r["splits_ms"][-1] == r["time_ms"]
        assert r["trace"]["n"] >= r["time_ms"] // 250


def test_generate_course_fails_a_rival_that_cannot_clear_terrain(monkeypatch):
    cfg = RP.load_personas()
    meta = synth_meta([[0, 0, 1000.0], [0, 4000.0, 1000.0], [0, 8000.0, 1000.0]], radius=100.0, v0=150.0)
    meta["hash"] = "deadbeef"
    monkeypatch.setattr(RP.rc, "node_call", lambda req: [{"v": 1} for _ in req["traces"]])
    # terrain 4 km ABOVE every gate centre: no crossing window and no via (VIA_RANGE_M) gets over it
    wall = lambda lat, lon: np.full(len(lat), 5000.0)       # noqa: E731
    out = RP.generate_course(meta, dict(flat_env(), envelope_version="t"), cfg, wall, None, cap_s=2.0)
    assert not out["rivals"] and {f["rival_id"] for f in out["failures"]} == {"steve", "brat", "moo", "dawg"}
    assert all("min AGL" in f["reason"] for f in out["failures"])


def test_lift_for_terrain_raises_only_the_gate_it_needs():
    gates = [[0, 0, 1000.0], [0, 5000.0, 1000.0], [0, 10000.0, 1000.0], [0, 15000.0, 1000.0]]
    frame = rc.Enu(LAT0, LON0, 0.0)

    def terrain(lat, lon):                    # a 960 m ridge 1.2 km after gate 2 (past its floor ramp)
        p = frame.from_lla(lat, lon, np.zeros(len(lat)))
        return np.where(np.abs(p[:, 1] - 11200.0) < 50.0, 960.0, 0.0)

    geom = R.CourseGeom(synth_meta(gates, radius=150.0, v0=200.0))
    ev = R.Evaluator(geom, R.Perf(flat_env(), 0.8), terrain, min_agl=60.0)
    off, rep = R.lift_for_terrain(ev, np.zeros((geom.n, 2)), 0.9)
    assert rep["cleared"] and set(rep["lifted_rows"]) == {2}
    assert np.all(off[:, 0] == 0) and 15.0 <= off[2, 1] <= 60.0      # just enough, not the whole window
    assert ev.run(off, detail=True)["min_clear_m"] >= 0.0


def test_no_persona_window_reaches_the_gate_edge():
    cfg = RP.load_personas()
    assert all(RP.window_of(p) <= R.MAX_USABLE_WINDOW < 1.0 for p in cfg["personas"])
    assert RP.window_of({"gateWindow": 1.0}) == R.MAX_USABLE_WINDOW


def test_a_ridge_between_gates_gets_a_via_point_and_is_cleared():
    gates = [[0, 0, 500.0], [0, 12000.0, 500.0], [0, 24000.0, 500.0]]
    frame = rc.Enu(LAT0, LON0, 0.0)

    def terrain(lat, lon):                    # a 900 m ridge 40% along leg 0: 400 m above the gates
        p = frame.from_lla(lat, lon, np.zeros(len(lat)))
        return np.where(np.abs(p[:, 1] - 4800.0) < 500.0, 900.0, 0.0)

    geom = R.CourseGeom(synth_meta(gates, radius=100.0, v0=200.0))
    ev = R.Evaluator(geom, R.Perf(flat_env(), 0.9), terrain, min_agl=60.0)
    off, rep = R.plan_vias(ev, 0.7)
    assert rep["cleared"] and 1 <= len(geom.vias) <= 3 and all(v["leg"] == 0 for v in geom.vias)
    assert min(abs(v["frac"] - 0.4) for v in geom.vias) <= 0.1          # at the ridge (a second may shape the climb)
    assert off.shape == (geom.n + geom.m, 2) and off[geom.n:, 1].max() >= 400.0
    assert np.all(np.linalg.norm(off[:geom.n], axis=1) <= 0.7 * geom.r + 1e-6)   # gates stay in their window
    assert ev.run(off, detail=True)["min_clear_m"] >= 0.0
    # and every persona flies through the same via, clear of the ridge
    cfg = RP.load_personas()
    lines, reports, geoms = RP.plan_lines(geom, flat_env(), cfg, terrain, 3.0, 1, 60.0)
    assert reports["dawg"]["route"]["vias"] and all(off.shape == (geoms[rid].n + geoms[rid].m, 2) for rid, off in lines.items())
    for rid, off in lines.items():
        res = R.Evaluator(geoms[rid], RP.persona_perf(flat_env(), RP.by_id(cfg)[rid]), terrain, 60.0).run(off, detail=True)
        assert res["min_clear_m"] >= 0.0, rid


def test_speed_profile_never_dips_below_the_envelope_floor_at_a_sharp_via():
    """Regression: a via point tight enough to demand more deceleration than the envelope allows
    used to make the forward pass fall back to a hardcoded 5 m/s, a physically meaningless crawl
    the envelope says nothing about (n_allow(v) clamps flat below its lowest bin, so gravity alone
    already satisfies it there) that then read back as a spurious over-g violation a few samples
    later. It must floor at perf.vc[0] instead."""
    # A near-hairpin: a waypoint 50 m before a near-180-degree reversal, so the spline's local
    # curvature there demands far more deceleration than any real envelope allows in that distance.
    P = np.array([[0.0, 0.0, 1000.0], [0.0, 5000.0, 1000.0], [50.0, 5050.0, 1000.0], [0.0, 5000.0, 1000.0], [0.0, 0.0, 1000.0]])
    perf = R.Perf(flat_env(vmax=300.0, accel=10.0, decel=10.0, n_inst=8.0), 1.0)
    pos, d1, d2, _ = R.natural_spline(P, 5.0)
    terms = R.path_terms(pos, d1, d2)
    v, t = R.speed_profile(terms, perf, 250.0)
    assert v.min() == pytest.approx(perf.vc[0], abs=1e-6)         # floored, never a spurious crawl below it
    assert np.all(v >= perf.vc[0] - 1e-9)


def test_seed_low_speed_n_floor_is_not_clamped_to_one_g():
    """Regression: n_inst/n_sus used to clamp to exactly 1.0 g below ~90 m/s, meaning the seed said
    a fighter could not turn at all that slow — a terrain-avoidance via then had nowhere to pull
    even a modest g, so its rival failed rival_verify.js's physics check outright."""
    seed = E.seed_envelope("7")
    assert min(seed["n_inst"]) >= 2.0 and min(seed["n_sus"]) >= 1.5
    assert seed["n_inst"][0] >= seed["n_sus"][0]                    # instantaneous still >= sustained


def test_v_limit_targets_a_margin_under_n_allow():
    gates = [[0, 0, 1000.0], [0, 6000.0, 1000.0], [6000.0, 6000.0, 1000.0]]
    geom = R.CourseGeom(synth_meta(gates, radius=20.0, v0=300.0))
    perf = R.Perf(flat_env(vmax=350.0, n_inst=6.0), 1.0)
    P = R.natural_spline(geom.waypoints(np.zeros((geom.n, 2))), 2.0)
    terms = R.path_terms(P[0], P[1], P[2])
    vl = R.v_limit(terms, perf)
    n = R.load_factor(vl, terms["kap"], terms["uperp"])
    turning = n > 1.5
    assert turning.any()
    assert np.all(n[turning] <= 6.0 * R.G_SAFETY_FRAC * 1.02)       # within 2% of the SAFETY-scaled target
    assert np.any(n[turning] >= 6.0 * R.G_SAFETY_FRAC * 0.9)        # and it actually uses the margin, not far under it


# ------------------------------------------------------------------ rival-gen-2: the ratio ladder
def test_ladder_solver_lands_within_one_percent_on_a_synthetic_course():
    cfg = RP.load_personas()
    geom = _zigzag_course()
    env = rc.load_envelope("7")
    lines, _, geoms = RP.plan_lines(geom, env, cfg, None, 3.0, 1, 60.0)
    paces, rep = RP.solve_ladder(geoms, lines, env, cfg, 60.0)
    dawg = R.fly_line(geoms["dawg"], R.Perf(env, *paces["dawg"]), lines["dawg"], None, 60.0)["time_s"]
    assert paces["dawg"] == (0.98, 1.0)
    prev = dawg
    for rid in RP.LADDER_ORDER:
        t = R.fly_line(geoms[rid], R.Perf(env, *paces[rid]), lines[rid], None, 60.0)["time_s"]
        assert t / dawg == pytest.approx(cfg["ladder"]["ratios"][rid], rel=cfg["ladder"]["tolerance"]), rid
        assert t > prev and not rep[rid]["clamped"] and not rep[rid]["shifted"]
        prev = t


def test_generate_course_ships_a_strict_ladder(monkeypatch):
    cfg = RP.load_personas()
    meta = synth_meta([[0, 0, 1000.0], [0, 4000.0, 1000.0], [3000.0, 6000.0, 1000.0], [6000.0, 4000.0, 1000.0]], radius=150.0, v0=92.6)
    meta["hash"] = "deadbeef"
    monkeypatch.setattr(RP.rc, "node_call", lambda req: [{"v": 1} for _ in req["traces"]])
    out = RP.generate_course(meta, rc.load_envelope("7"), cfg, None, None, cap_s=2.0)
    t = {r["rival_id"]: r["time_ms"] for r in out["rivals"]}
    assert t["steve"] > t["brat"] > t["moo"] > t["dawg"]
    for rid in RP.LADDER_ORDER:
        assert t[rid] / t["dawg"] == pytest.approx(cfg["ladder"]["ratios"][rid], rel=0.01)
        r = next(x for x in out["rivals"] if x["rival_id"] == rid)
        assert r["ladder"]["ratio_target"] == cfg["ladder"]["ratios"][rid] and 0 < r["speedCap"] <= 1.0


def test_a_rung_that_cannot_get_fast_enough_pushes_the_rungs_below_it_down(monkeypatch):
    cfg = RP.load_personas()
    cfg = json.loads(json.dumps(cfg))
    cfg["ladder"]["ratios"] = {"moo": 1.07, "brat": 1.08, "steve": 1.09}   # rungs closer than MIN_RUNG_STEP
    geom = _zigzag_course()
    env = rc.load_envelope("7")
    lines, _, geoms = RP.plan_lines(geom, env, cfg, None, 2.0, 1, 60.0)
    paces, rep = RP.solve_ladder(geoms, lines, env, cfg, 60.0)
    assert rep["brat"]["shifted"] and rep["steve"]["shifted"]
    assert rep["brat"]["time_s"] >= rep["moo"]["time_s"] * RP.MIN_RUNG_STEP * 0.99
    assert rep["steve"]["time_s"] >= rep["brat"]["time_s"] * RP.MIN_RUNG_STEP * 0.99


# ------------------------------------------------------------------ rival-gen-2: terrain floor near low gates
def test_gate_floor_rule_values():
    assert R.gate_floor_m(40.0, 60.0) == pytest.approx(35.0)       # the course's own 40 m AGL gate, less the slack
    assert R.gate_floor_m(200.0, 60.0) == pytest.approx(60.0)      # a high gate changes nothing
    assert R.gate_floor_m(3.0, 60.0) == pytest.approx(0.0)         # never below the ground
    f = rc.Enu(LAT0, LON0, 0.0)
    east = np.array([[0.0, 0, 0], [100.0, 0, 0], [600.0, 0, 0], [1100.0, 0, 0], [5000.0, 0, 0]])
    lat, lon, _ = f.to_lla(east)
    fl = R.floor_profile(lat, lon, np.array([LAT0]), np.array([LON0]), np.array([100.0]), np.array([35.0]), 60.0)
    assert fl == pytest.approx([35.0, 35.0, 47.5, 60.0, 60.0], abs=0.1)   # flat to the radius, 1 km ramp, then 60


def test_flying_through_a_low_gate_at_its_centre_is_legal():
    """Regression (budapest-danube-chain-bridge, ecola-headland-run, umpqua-dunes-run, tre-cime-loop,
    willamette-gauntlet): the course puts gates under 60 m AGL; the old flat 60 m floor made
    flying through them illegal, and every rival failed or was skipped."""
    gates = [[0, 0, 1040.0], [0, 3000.0, 1040.0], [0, 6000.0, 1040.0]]         # all 40 m over 1000 m terrain
    geom = R.CourseGeom(synth_meta(gates, radius=40.0, v0=150.0))
    flat = lambda lat, lon: np.full(len(lat), 1000.0)                            # noqa: E731
    ev = R.Evaluator(geom, R.Perf(flat_env(), 0.9), flat, min_agl=60.0)
    res = ev.run(np.zeros((geom.n, 2)), detail=True)
    at_gates = [int(np.argmin(np.linalg.norm(res["pos"] - c, axis=1))) for c in geom.C]
    assert all(res["agl"][i] >= res["floor"][i] for i in at_gates)            # through each gate: legal
    assert res["min_clear_m"] < 0                                              # 1.5 km from any gate, 40 m is still too low
    off, rep = R.plan_vias(ev, 0.9)
    assert rep["clean"] or ev.run(off, detail=True)["min_clear_m"] >= 0


@pytest.mark.skipif(not _have_node(), reason="Node not available (set FINS_NODE)")
def test_verifier_floor_matches_the_generator_floor():
    import subprocess
    pts = [(45.0, -122.0), (45.001, -122.0), (45.0, -121.99), (45.004, -121.995), (45.02, -122.0)]
    gates = [{"lat": 45.0, "lon": -122.0, "alt": 1040.0, "radius": 40.0}, {"lat": 45.01, "lon": -122.0, "alt": 1300.0, "radius": 60.0}]
    gt = [1000.0, 1000.0]
    js = ("const V=require(%s);const f=V.gateFloors(%s,%s,60);console.log(JSON.stringify(%s.map(p=>V.floorAt(p[0],p[1],f,60))));"
          % (json.dumps(str(rc.RACE_DIR / "tools" / "rival_verify.js")), json.dumps(gates), json.dumps(gt), json.dumps(pts)))
    out = json.loads(subprocess.run([rc.node_exe(), "-e", js], capture_output=True, check=True).stdout)
    glat = np.array([g["lat"] for g in gates])
    glon = np.array([g["lon"] for g in gates])
    gf = R.gate_floor_m(np.array([g["alt"] for g in gates]) - np.array(gt), 60.0)
    py = R.floor_profile(np.array([p[0] for p in pts]), np.array([p[1] for p in pts]), glat, glon, np.array([40.0, 60.0]), gf, 60.0)
    assert out == pytest.approx(py.tolist(), abs=1e-6)
    src = (rc.RACE_DIR / "tools" / "rival_verify.js").read_text(encoding="utf-8")
    assert f"GATE_FLOOR_SLACK_M = {R.GATE_FLOOR_SLACK_M:g};" in src and f"GATE_FLOOR_RAMP_M = {R.GATE_FLOOR_RAMP_M:g};" in src


# ------------------------------------------------------------------ rival-gen-2: lateral re-routing + feasible turns
def test_lateral_reroute_clears_a_peak_the_vertical_lift_could_not():
    gates = [[0, 0, 500.0], [0, 12000.0, 500.0], [0, 24000.0, 500.0]]
    frame = rc.Enu(LAT0, LON0, 0.0)

    def terrain(lat, lon):                    # a 5 km peak astride leg 0, 1.2 km wide: over the top is out of reach
        p = frame.from_lla(lat, lon, np.zeros(len(lat)))
        return np.where((np.abs(p[:, 0]) < 600.0) & (np.abs(p[:, 1] - 6000.0) < 600.0), 5000.0, 0.0)

    geom = R.CourseGeom(synth_meta(gates, radius=100.0, v0=200.0))
    ev = R.Evaluator(geom, R.Perf(rc.load_envelope("7"), 0.98), terrain, min_agl=60.0)
    # the old mechanism: lift the crossings, then a via that may only go UP (up to VIA_RANGE_M)
    lifted, rep = R.lift_for_terrain(ev, np.zeros((geom.n, 2)), 0.9)
    assert not rep["cleared"]
    geom.add_via(0, 0.5)
    up_only = np.vstack([lifted, [[0.0, R.VIA_RANGE_M]]])
    assert ev.run(up_only, detail=True)["min_clear_m"] < 0
    geom.vias = []
    off, rep = R.plan_vias(ev, 0.9)
    res = ev.run(off, detail=True)
    assert rep["clean"] and res["min_clear_m"] >= 0 and res["g_over_max"] <= 0
    assert any(abs(off[geom.n + j, 0]) > 600.0 for j in range(geom.m))     # it went round, not over


def test_hairpin_gate_gets_a_feasible_teardrop():
    """Regression (budapest-danube-chain-bridge, cabo-lands-end, devils-lake-bluffs, reine-lofoten,
    paris-le-bourget-1927, chiba-makuhari-slalom, copper-canyon-urique, lake-hood-floatplane-circuit,
    zion-canyon): a ~160-degree turn at a small gate is tighter than the envelope allows at ANY
    speed. The old model floored the speed at 50 m/s and shipped 30-50 g there; the verifier failed
    every rival. It must be a penalty the route removes with vias."""
    env = rc.load_envelope("7")
    gates = [[0, 0, 600.0], [0, 900.0, 600.0], [120.0, 150.0, 600.0], [120.0, -800.0, 600.0]]
    geom = R.CourseGeom(synth_meta(gates, radius=40.0, v0=120.0))
    ev = R.Evaluator(geom, R.Perf(env, 0.98), None, min_agl=60.0)
    centre = ev.run(np.zeros((geom.n, 2)), detail=True)
    assert centre["g_excess_max"] > 1.0 and centre["penalty_g_s"] > 0       # the old silent 50 m/s crawl is now visible
    off, rep = R.plan_vias(ev, 0.9)
    res = ev.run(off, detail=True)
    assert geom.m >= 1 and res["g_over_max"] <= 0 and res["missed"] == 0
    k0, k1 = res["k0"], res["k1"]
    assert np.all(res["n_need"][k0:] <= 1.02 * np.maximum(1.0, np.interp(res["v"][k0:k1], env["v_centers"], env["n_inst"])))


def test_speed_profile_ground_roll_starts_from_rest():
    gates = [[0, 0, 0.0], [0, 3000.0, 50.0], [0, 6000.0, 100.0]]
    meta = synth_meta(gates, radius=150.0)
    meta["startType"] = "ground"
    meta["course"]["startType"] = "ground"
    geom = R.CourseGeom(meta)
    assert geom.ground and geom.v0 == 0.0 and np.allclose(geom.spawn, geom.C[0])
    env = flat_env(accel=9.0)
    res = R.Evaluator(geom, R.Perf(env, 1.0), None).run(np.zeros((geom.n, 2)), ds=2.0, detail=True)
    assert res["v"][0] == 0.0 and res["missed"] == 0
    v_t0 = float(np.interp(res["t0"], res["t"], res["v"]))
    assert v_t0 == pytest.approx(math.sqrt(2 * 9.0 * 150.0), rel=0.05)      # a standing start, out of gate 0's sphere
    ok, why = R.course_is_eligible({"aircraftId": "7", "startType": "ground", "course": meta["course"]}, {"7": env})
    assert ok, why


def test_generate_course_on_a_ground_start(monkeypatch):
    cfg = RP.load_personas()
    gates = [[0, 0, 5.0], [0, 3000.0, 120.0], [0, 6000.0, 120.0], [0, 9000.0, 120.0]]
    meta = synth_meta(gates, radius=150.0)
    meta.update(startType="ground", hash="deadbeef")
    monkeypatch.setattr(RP.rc, "node_call", lambda req: [{"v": 1} for _ in req["traces"]])
    ground = lambda lat, lon: np.zeros(len(lat))                                # noqa: E731
    out = RP.generate_course(meta, rc.load_envelope("7"), cfg, ground, None, cap_s=2.0)
    assert [r["rival_id"] for r in out["rivals"]] == ["steve", "brat", "moo", "dawg"], out["failures"]
    assert out["startType"] == "ground"


@pytest.mark.skipif(not _have_node(), reason="Node not available (set FINS_NODE)")
def test_node_bridge_reply_over_64_kib_is_not_cut():
    """Regression: rival_node.js exited straight after process.stdout.write(); on a Linux pipe that
    cut every reply at 64 KiB (the 'meta' reply for every course is ~1 MB) and json.loads failed."""
    courses, cups = rc.load_course_files()
    metas = rc.course_metas(courses, cups)
    assert len(metas) == len(courses) and len(json.dumps(metas)) > 65536


# ------------------------------------------------------------------ shipped files + index.json
import rival_ladder as RL  # noqa: E402

PINNED_HASHES = json.loads((rc.RACE_DIR / "test" / "course_hashes.json").read_text(encoding="utf-8"))
SHIPPED = RL.shipped_files()


def validate_index(index, files, hashes):
    """[problems]: index.json must be exactly the shipped files' medal times, sorted, no traces,
    every course_hash the pinned current one."""
    problems = []
    ids = [e.get("course_id") for e in index]
    if ids != sorted(ids):
        problems.append("index.json is not sorted by course_id")
    if set(ids) != set(files):
        problems.append(f"index.json courses {sorted(set(ids) ^ set(files))} do not match the shipped files")
    for e in index:
        if set(e) != {"course_id", "course_hash", "generator_version", "rivals"}:
            problems.append(f"{e.get('course_id')}: keys {sorted(e)}")
        if any(set(r) != {"rival_id", "name", "model", "time_ms", "splits_ms"} for r in e.get("rivals", [])):
            problems.append(f"{e.get('course_id')}: a rival entry has keys other than the five medal fields (no traces)")
        f = files.get(e.get("course_id"))
        if f is not None and e != RL.index_entry(f):
            problems.append(f"{e['course_id']}: index entry does not match race/rivals/{e['course_id']}.json")
        if hashes.get(e.get("course_id")) != e.get("course_hash"):
            problems.append(f"{e.get('course_id')}: course_hash {e.get('course_hash')} is not the current {hashes.get(e.get('course_id'))}")
    return problems


def test_index_validator_catches_every_mismatch():
    files = {"a": {"course_id": "a", "course_hash": "11111111", "generator_version": "g", "rivals": [
        {"rival_id": "dawg", "name": "DAWG", "model": "hot-dawg", "time_ms": 1000, "splits_ms": [500, 1000], "trace": {"v": 1}}]}}
    good = RL.build_index(files)
    assert "trace" not in json.dumps(good) and validate_index(good, files, {"a": "11111111"}) == []
    assert validate_index(good, files, {"a": "22222222"})                               # stale hash
    bad = json.loads(json.dumps(good))
    bad[0]["rivals"][0]["time_ms"] = 999
    assert validate_index(bad, files, {"a": "11111111"})                                # disagrees with its file
    bad = json.loads(json.dumps(good))
    bad[0]["rivals"][0]["trace"] = {"v": 1}
    assert validate_index(bad, files, {"a": "11111111"})                                # a trace leaked in
    assert validate_index(good + [dict(good[0], course_id="0")], files, {"a": "11111111", "0": "11111111"})   # unsorted + extra


def test_shipped_index_matches_every_rival_file():
    index = json.loads((rc.RIVALS_DIR / "index.json").read_text(encoding="utf-8"))
    assert validate_index(index, SHIPPED, PINNED_HASHES) == []


def test_v_limit_is_the_top_of_the_feasible_band_from_the_floor_up():
    """Regression (eidfjord-voringsfossen STEVE: 107 s at envelopeFrac 0.88, 82 s at 0.90; and
    devils-lake-bluffs BRAT 1.1 g over): with n_inst jumping between bins a corner can be feasible
    at low speed, infeasible above it and feasible again near corner speed. v_limit must be the
    top of the band that starts at the envelope floor, found the same way at every pace, so every
    speed the accel/decel passes can leave below it is feasible too."""
    vc = E._v_centers()
    env = {"v_centers": vc, "alt_bands_m": E.ALT_BANDS_M, "vmax_ms": [400.0] * 3,
           "n_inst": [2.0 if v < 140 else 8.0 for v in vc], "n_sus": [2.0] * len(vc),
           "accel_ms2": [8.0] * len(vc), "decel_ms2": [8.0] * len(vc), "roll_rate_dps": 180.0}
    kap = np.array([[0.0, 1.0 / 900.0, 0.0]])                  # a 900 m radius level turn
    up = np.array([[0.0, 0.0, 1.0]])
    terms = {"alt": np.array([500.0]), "kap": kap, "uperp": up}
    tops = []
    for frac in np.linspace(0.85, 1.0, 16):
        perf = R.Perf(env, frac)
        v = R.v_limit(terms, perf)[0]
        below = np.linspace(perf.vc[0], v, 200)
        assert np.all(R.load_factor(below, np.repeat(kap, 200, 0), np.repeat(up, 200, 0)) <= R.G_SAFETY_FRAC * perf.n_allow(below) * 1.001)
        tops.append(v)
    assert max(tops) < 140.0                                    # never the corner-speed island past the gap
    assert all(b >= a - 1e-6 for a, b in zip(tops, tops[1:]))   # monotone in the persona's pace


def test_solve_pace_steps_over_a_gap_with_the_other_knob():
    """Regression: a time that sits inside a jump of one knob (cabo-lands-end BRAT, eidfjord STEVE)
    is reached by switching to the other knob from the jump's fast side."""
    def t(fr, cap):                                            # frac has a 20 s jump at 0.9; cap is smooth
        return (120.0 if fr < 0.9 else 90.0) / cap
    sol = RP.solve_pace(t, 105.0, 0.8, 0.98, cap_lo=0.3)
    assert sol["clamped"] is None and sol["time_s"] == pytest.approx(105.0, rel=0.003)
    assert sol["envelopeFrac"] >= 0.9 and sol["speedCap"] < 1.0 and "+cap" in sol["stage"]
    assert t(sol["envelopeFrac"], sol["speedCap"]) == sol["time_s"]   # the returned (rounded) pace is what was timed


def test_solve_pace_falls_back_to_frac_rows_when_both_knobs_jump():
    def t(fr, cap):                                            # jumps in cap at 0.8 for low fracs only
        base = 100.0 / fr
        return base * (1.3 if (cap < 0.8 and fr < 0.9) else 1.0) / cap ** 0.2
    target = 100.0 / 0.85 * 1.15
    sol = RP.solve_pace(t, target, 0.85, 0.98, cap_lo=0.3, frac_lo=0.4)
    assert sol["clamped"] is None and sol["time_s"] == pytest.approx(target, rel=0.003)


# ------------------------------------------------------------------ human records vs the ladder
def test_rung_of_says_where_a_record_lands():
    t = {"steve": 140, "brat": 112, "moo": 107, "dawg": 100}
    assert RL.rung_of(99, t) == "above DAWG" and RL.rung_of(105, t) == "DAWG-MOO"
    assert RL.rung_of(110, t) == "MOO-BRAT" and RL.rung_of(120, t) == "BRAT-STEVE" and RL.rung_of(150, t) == "below STEVE"
    assert RL.rung_of(120, {"moo": 107, "dawg": 100}) == "below MOO"          # a course missing rungs


def test_records_snapshot_is_on_the_current_course_hashes():
    snap = json.loads(RL.SNAPSHOT_PATH.read_text(encoding="utf-8"))
    assert len(snap["records"]) >= 5 and snap["source"]
    for r in snap["records"]:
        assert PINNED_HASHES[r["course_id"]] == r["course_hash"] and r["record_ms"] > 0


def test_the_global_ladder_puts_the_median_record_between_brat_and_steve():
    """personas.json's ratio table is global, set once from the records (never per course): the
    median casual record must land between BRAT and STEVE, and no record may beat MOO."""
    ratios = RP.load_personas()["ladder"]["ratios"]
    recs = {r["course_id"]: r["record_ms"] for r in json.loads(RL.SNAPSHOT_PATH.read_text(encoding="utf-8"))["records"]}
    rr = [recs[c] / {x["rival_id"]: x["time_ms"] for x in SHIPPED[c]["rivals"]}["dawg"] for c in recs if c in SHIPPED]
    assert len(rr) >= 5
    med = float(np.median(rr))
    assert ratios["brat"] < med < ratios["steve"] and min(rr) > ratios["moo"]


def test_every_shipped_file_keeps_the_v1_shape_and_a_strict_ladder():
    for cid, f in SHIPPED.items():
        assert set(f) == {"course_id", "course_hash", "aircraftId", "generator_version", "envelope_version", "rivals"}, cid
        assert f["generator_version"] == R.GENERATOR_VERSION and f["course_hash"] == PINNED_HASHES.get(cid), cid
        t = {r["rival_id"]: r["time_ms"] for r in f["rivals"]}
        order = [t[k] for k in ("steve", "brat", "moo", "dawg") if k in t]
        assert all(a > b for a, b in zip(order, order[1:])), f"{cid}: not STEVE > BRAT > MOO > DAWG: {t}"
        for r in f["rivals"]:
            assert set(r) == {"rival_id", "name", "model", "time_ms", "splits_ms", "trace"}, cid


def test_every_shipped_rung_is_within_one_percent_of_the_global_ratio():
    cfg = RP.load_personas()
    ladder = json.loads((rc.RIVALS_DIR / "ladder.json").read_text(encoding="utf-8"))
    assert ladder["ratios"] == cfg["ladder"]["ratios"]
    for cid, f in SHIPPED.items():
        t = {r["rival_id"]: r["time_ms"] for r in f["rivals"]}
        lad = ladder["courses"][cid]["rivals"]
        assert set(lad) == set(t), cid
        if "dawg" not in t:
            continue
        for rid in RP.LADDER_ORDER:
            # clamped ('high': can't get that fast; 'low': can't get that slow; 'gap': the target sits
            # in a jump of both knobs) and shifted rungs are the named exceptions in ladder.json
            if rid in t and not lad[rid]["clamped"] and not lad[rid]["shifted"]:
                assert t[rid] / t["dawg"] == pytest.approx(cfg["ladder"]["ratios"][rid], rel=cfg["ladder"]["tolerance"]), (cid, rid)


def test_trace_never_has_a_sliver_before_the_finish_sample():
    """Regression (kenai-fjords-exit-glacier BRAT): a finish 10 ms after the last 4 Hz sample put
    two samples 10 ms apart; the 0.1-degree roll quantization then read as a 200 deg/s roll."""
    gates = [[0, 0, 1000.0], [0, 5000.0, 1000.0], [5000.0, 10000.0, 1000.0]]
    geom = R.CourseGeom(synth_meta(gates, radius=100.0, v0=250.0))
    perf = R.Perf(flat_env(), 1.0)
    res = R.fly_line(geom, perf, np.zeros((geom.n, 2)), None, 60.0)
    for shift in (0.002, 0.01, 0.04, 0.2):                       # finish 2..200 ms past a 250 ms grid point
        r2 = dict(res, times=list(res["times"]))
        base = math.floor((res["times"][-1] - res["t0"]) * 4) / 4
        r2["times"][-1] = res["t0"] + base + shift
        rows, splits, time_ms = R.build_trace(r2, geom, perf)
        dts = [b[0] - a[0] for a, b in zip(rows, rows[1:])]
        assert min(dts) >= R.MIN_TRACE_DT_MS and max(dts) <= R.TRACE_DT_MS and rows[-2][0] == time_ms


def test_every_line_is_rechecked_against_terrain_at_the_final_resolution():
    """Regression (angkor-tonle-sap BRAT: 59 m AGL at one sample): a 30 m-wide spike between the
    search's ~20 m samples was only seen by the 5 m line that ships."""
    gates = [[0, 0, 500.0], [0, 6000.0, 500.0], [0, 12000.0, 500.0]]
    frame = rc.Enu(LAT0, LON0, 0.0)

    def terrain(lat, lon):                    # a 12 m-wide spike, 470 m tall, 3 km from any gate
        p = frame.from_lla(lat, lon, np.zeros(len(lat)))
        return np.where(np.abs(p[:, 1] - 3003.0) < 6.0, 470.0, 0.0)

    geom = R.CourseGeom(synth_meta(gates, radius=300.0, v0=200.0))
    cfg = RP.load_personas()
    lines, reports, geoms = RP.plan_lines(geom, flat_env(), cfg, terrain, 2.0, 1, 60.0)
    for rid, off in lines.items():
        res = R.fly_line(geoms[rid], RP.persona_perf(flat_env(), RP.by_id(cfg)[rid]), off, terrain, 60.0)
        assert res["min_clear_m"] >= 0.0, rid
