#!/usr/bin/env python3
"""Mine GeoFS's own flight envelope for an aircraft -> race/rivals/envelope-<aircraftId>.json.

The rival generator (race/tools/rival_gen.py) flies computed ghosts against these tables, so the
tables have to describe what GeoFS's aircraft actually does, not a real-world spec sheet. Three
sources, merged per table bin in this order of trust:

  1. mined  real race traces from the leaderboard server (GET /courses, /ghosts, /ghost), bins
            with >= THIN_N samples. HOUSE (robot, autopilot-flown) ghosts are skipped: they only
            ever fly 25 deg of bank at 180 kt and would drag every table down.
  2. lab    a capture from race/tools/envelope_capture.js (read-only bookmarklet flight card),
            passed with --lab FILE. Fills whatever the traces leave thin.
  3. seed   the conservative SEED table below. Fills everything else, and every bin says where
            its number came from (`sources`), so a seed-built rival is never mistaken for a
            measured one.

Traces carry no aircraft tag. A trace is attributed to an aircraft by its course (the course's
aircraftId lock, else race/tools/robot_pilot.js's robotAircraftFor rule: unlocked non-Bush-Cup
courses fly the F-16) AND must pass a speed check for that aircraft (a Cub run on an unlocked
course is not F-16 data). Failures are counted as unattributed, never mined.

Usage:
  python envelope.py                      # aircraft 7, mine the server, write race/rivals/envelope-7.json
  python envelope.py --lab capture.json   # merge a flight-card capture (lab fills thin bins)
  python envelope.py --offline            # use only race/rivals/cache/, no network
"""
from __future__ import annotations

import argparse
import datetime as _dt
import json
import math
import sys
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import rival_common as rc  # noqa: E402

API_BASE = "https://race.finsonly.net"
HOUSE_CALLSIGN = "HOUSE"
THIN_N = 30                       # fewer samples than this in a bin = thin (4 Hz: 7.5 s of flight)
V_EDGES = np.arange(40.0, 500.0, 20.0)   # m/s speed bins: 40-60, ..., 460-480 (humans fly ~400)
ALT_BANDS_M = [[0, 1500], [1500, 4500], [4500, 15000]]
PCT_HI = 97.0                     # p95-p99 per the brief: the upper edge of what pilots do, not the max
JET_P95_MS = 130.0                # a trace whose p95 ground speed is below this is not F-16 flight

# Physical sanity bounds: a mined bin outside these is noise (a 4 Hz corner, a GPS-like glitch),
# never data. They are generous on purpose; the seed and the percentiles do the real work.
# GeoFS does not enforce a structural g limit: real race traces show 10-25 g turns at 350-400 m/s.
BOUNDS = {"n_inst": (1.0, 40.0), "n_sus": (1.0, 40.0), "accel_ms2": (0.0, 25.0), "decel_ms2": (0.0, 30.0),
          "ps_ms": (-50.0, 400.0)}

ENVELOPE_FORMAT = 1


def _v_centers():
    return ((V_EDGES[:-1] + V_EDGES[1:]) / 2).tolist()


# ------------------------------------------------------------------ seed
def seed_envelope(aircraft_id="7"):
    """The conservative F-16 seed. Deliberately under what GeoFS's F-16 is believed to do, so a
    seed-built rival is beatable; lab/mined data replaces it bin by bin. Numbers:
      Vmax (level, full throttle): 250 m/s (486 kt) below 1.5 km, 270 to 4.5 km, 290 above.
      n_inst: 7.5 g above a 180 m/s corner, scaling with v^2 below it (lift-limited).
      n_sus:  5.5 g above the corner, same v^2 scaling.
      accel (level, full throttle): 9 m/s^2 up to 100 m/s, 1.5 at 250, 0 at 300.
      decel (idle + drag): 8 m/s^2 at 100 m/s rising to 12 at 300.
      roll rate: 180 deg/s."""
    if str(aircraft_id) != "7":
        return None
    vc = np.array(_v_centers())
    corner = 180.0
    n_inst = np.clip(7.5 * (vc / corner) ** 2, 1.0, 7.5)
    n_sus = np.clip(5.5 * (vc / corner) ** 2, 1.0, 5.5)
    accel = np.interp(vc, [100.0, 250.0, 300.0], [9.0, 1.5, 0.0])
    decel = np.interp(vc, [100.0, 300.0], [8.0, 12.0])
    return {
        "vmax_ms": [250.0, 270.0, 290.0],
        "n_inst": n_inst.round(3).tolist(), "n_sus": n_sus.round(3).tolist(),
        "accel_ms2": accel.round(3).tolist(), "decel_ms2": decel.round(3).tolist(),
        "ps_ms": (accel * vc).round(1).tolist(),
        "roll_rate_dps": 180.0, "roll_sign": 1,
    }


# ------------------------------------------------------------------ server download (cached)
def _get_json(url, opener=None, timeout=30):
    op = opener or (lambda u: urllib.request.urlopen(u, timeout=timeout).read())
    return json.loads(op(url))


def cached_get(path, params, cache_dir, offline=False, opener=None):
    """GET API_BASE+path?params as JSON, read-through cached in cache_dir (gitignored)."""
    q = urllib.parse.urlencode(params) if params else ""
    key = (path.strip("/").replace("/", "_") or "root") + ("_" + "_".join(f"{k}-{v}" for k, v in sorted(params.items())) if params else "")
    safe = "".join(ch if ch.isalnum() or ch in "-_." else "_" for ch in key)[:180] + ".json"
    p = Path(cache_dir) / safe
    if p.exists():
        return json.loads(p.read_text(encoding="utf-8"))
    if offline:
        return None
    try:
        data = _get_json(API_BASE + path + ("?" + q if q else ""), opener)
    except Exception as e:  # noqa: BLE001 - a 404 ghost or a dead server is "no data", reported
        print(f"  GET {path} {params}: {e}", file=sys.stderr)
        return None
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(data), encoding="utf-8")
    return data


def decode_trace(enc):
    """traceEncode v1 -> list of [t, lat, lon, alt, hdg, pitch, roll] rows (race.js traceDecode's
    shape; used only to read mined data, never to judge a rival)."""
    if not isinstance(enc, dict) or int(enc.get("v", 0)) != 1:
        return None
    cols = [enc.get(k) for k in ("t", "lat", "lon", "alt", "hdg", "pitch", "roll")]
    if not all(isinstance(c, list) for c in cols) or len({len(c) for c in cols}) != 1:
        return None
    t = np.cumsum(np.asarray(cols[0], dtype=float))
    return np.column_stack([t] + [np.asarray(c, dtype=float) for c in cols[1:]])


def download_traces(metas, cache_dir, offline=False, opener=None):
    """[(course_id, callsign, rows)] for every non-HOUSE ghost on a course the server has runs on."""
    out = []
    courses = cached_get("/courses", {}, cache_dir, offline, opener) or []
    for row in courses:
        h = row.get("course_hash")
        ghosts = cached_get("/ghosts", {"course_hash": h}, cache_dir, offline, opener) or []
        for g in ghosts:
            if g.get("is_house") or str(g.get("callsign", "")).upper() == HOUSE_CALLSIGN:
                continue
            got = cached_get("/ghost", {"course_hash": h, "callsign": g["callsign"]}, cache_dir, offline, opener)
            rows = decode_trace(got.get("trace")) if got else None
            if rows is not None and len(rows) >= 20:
                out.append({"course_id": row.get("course_id"), "course_hash": h, "callsign": g["callsign"],
                            "time_ms": g.get("time_ms"), "rows": rows})
    return out


# ------------------------------------------------------------------ kinematics
def savgol_coeffs(half, order, deriv, dt):
    """Savitzky-Golay filter weights (window 2*half+1) for the deriv-th derivative, numpy only."""
    x = np.arange(-half, half + 1, dtype=float)
    a = np.vander(x, order + 1, increasing=True)
    pinv = np.linalg.pinv(a)
    return pinv[deriv] * math.factorial(deriv) / (dt ** deriv)


def _savgol(y, half, order, deriv, dt):
    w = savgol_coeffs(half, order, deriv, dt)
    pad = np.pad(y, ((half, half),) + ((0, 0),) * (y.ndim - 1), mode="edge")
    out = np.zeros_like(y, dtype=float)
    for k, wk in enumerate(w):
        out = out + wk * pad[k:k + len(y)]
    return out


def kinematics(rows, dt=None, half=None):
    """Trace rows [t_ms, lat, lon, alt, hdg, pitch, roll, ...] -> dict of per-sample arrays.

    The trace is resampled to a uniform clock (dt: 0.25 s for 4 Hz race traces, 0.05 s for 20 Hz
    lab captures), split at gaps > 1 s, and differentiated with a quadratic Savitzky-Golay window
    of about 2 s. Returns v (m/s), a_t (tangential m/s^2), n (load factor: the specific force
    normal to the velocity, in g), psi_dot (deg/s), gamma (flight-path angle, deg), alt (m),
    roll (deg), roll_rate (deg/s), ps (specific excess power v*dv/dt + g*dh/dt, m/s)."""
    rows = np.asarray(rows, dtype=float)
    t = rows[:, 0] / 1000.0
    if dt is None:
        dt = float(np.median(np.diff(t))) if len(t) > 1 else 0.25
        dt = 0.05 if dt < 0.12 else 0.25
    if half is None:
        half = max(2, int(round(1.0 / dt)))
    keys = ("v", "a_t", "n", "psi_dot", "gamma", "alt", "roll", "roll_rate", "ps", "seg")
    acc = {k: [] for k in keys}
    cut = np.where(np.diff(t) > 1.0)[0]
    starts = np.concatenate([[0], cut + 1])
    ends = np.concatenate([cut + 1, [len(t)]])
    for si, (a, b) in enumerate(zip(starts, ends)):
        if b - a < 2 * half + 3:
            continue
        ts = np.arange(t[a], t[b - 1], dt)
        if len(ts) < 2 * half + 3:
            continue
        enu = rc.Enu(rows[a, 1], rows[a, 2], 0.0)
        p = enu.from_lla(rows[a:b, 1], rows[a:b, 2], rows[a:b, 3])
        P = np.column_stack([np.interp(ts, t[a:b], p[:, k]) for k in range(3)])
        roll_u = np.unwrap(rows[a:b, 6] * rc.D2R) / rc.D2R
        R = np.interp(ts, t[a:b], roll_u)
        vel = _savgol(P, half, 2, 1, dt)
        accv = _savgol(P, half, 2, 2, dt)
        # trim the edges, where the padded filter is biased
        sl = slice(half, len(ts) - half)
        vel, accv, P, R = vel[sl], accv[sl], P[sl], R[sl]
        v = np.linalg.norm(vel, axis=1)
        ok = v > 5.0
        vel, accv, P, R, v = vel[ok], accv[ok], P[ok], R[ok], v[ok]
        if len(v) < 3:
            continue
        vh = vel / v[:, None]
        a_t = np.sum(accv * vh, axis=1)
        f = accv + np.array([0.0, 0.0, rc.G0])            # specific force (what the pilot feels)
        f_perp = f - np.sum(f * vh, axis=1)[:, None] * vh
        n = np.linalg.norm(f_perp, axis=1) / rc.G0
        vhz = np.hypot(vel[:, 0], vel[:, 1])
        psi_dot = np.where(vhz > 1.0, (vel[:, 1] * accv[:, 0] - vel[:, 0] * accv[:, 1]) / np.maximum(vhz, 1.0) ** 2, 0.0) / rc.D2R
        # psi = atan2(vE, vN): d/dt = (vN*aE - vE*aN)/vh^2  (east = x, north = y)
        gamma = np.arcsin(np.clip(vel[:, 2] / v, -1, 1)) / rc.D2R
        roll_rate = np.gradient(R, dt) if len(R) > 1 else np.zeros_like(R)
        ps = v * a_t + rc.G0 * vel[:, 2]
        for k, arr in (("v", v), ("a_t", a_t), ("n", n), ("psi_dot", psi_dot), ("gamma", gamma), ("alt", P[:, 2]),
                       ("roll", R), ("roll_rate", roll_rate), ("ps", ps), ("seg", np.full(len(v), si))):
            acc[k].append(arr)
    return {k: (np.concatenate(acc[k]) if acc[k] else np.zeros(0)) for k in keys}


def classify_jet(kin, threshold=JET_P95_MS):
    """True when the trace flies like a jet: p95 speed above threshold."""
    return len(kin["v"]) > 0 and float(np.percentile(kin["v"], 95)) >= threshold


# ------------------------------------------------------------------ binning
def bin_percentile(v, x, mask, pct=PCT_HI, edges=V_EDGES):
    """Per speed bin: (value at percentile pct of x, count). NaN where the bin is empty."""
    vals, counts = [], []
    idx = np.digitize(v, edges) - 1
    for b in range(len(edges) - 1):
        m = mask & (idx == b)
        c = int(np.count_nonzero(m))
        counts.append(c)
        vals.append(float(np.percentile(x[m], pct)) if c else float("nan"))
    return vals, counts


def pava(y, increasing=True, w=None):
    """Pool-adjacent-violators isotonic fit (weighted). NaNs are skipped and left NaN."""
    y = np.asarray(y, dtype=float)
    out = y.copy()
    ok = np.isfinite(y)
    if not ok.any():
        return out
    ys = y[ok] if increasing else -y[ok]
    ws = (np.ones_like(ys) if w is None else np.maximum(np.asarray(w, dtype=float)[ok], 1e-9)).tolist()
    blocks = [[v, wt, 1] for v, wt in zip(ys.tolist(), ws)]
    i = 0
    while i < len(blocks) - 1:
        if blocks[i][0] > blocks[i + 1][0] + 1e-12:
            a, b = blocks[i], blocks[i + 1]
            wt = a[1] + b[1]
            blocks[i] = [(a[0] * a[1] + b[0] * b[1]) / wt, wt, a[2] + b[2]]
            del blocks[i + 1]
            i = max(i - 1, 0)
        else:
            i += 1
    fit = np.concatenate([[b[0]] * b[2] for b in blocks])
    out[ok] = fit if increasing else -fit
    return out


def mine_tables(kins):
    """Per-bin percentiles + counts from a list of kinematics dicts (one aircraft's flights)."""
    if not kins:
        z = [float("nan")] * (len(V_EDGES) - 1)
        return {"counts": {}, "vmax_ms": [float("nan")] * len(ALT_BANDS_M), "vmax_counts": [0] * len(ALT_BANDS_M),
                "n_inst": z, "n_sus": z, "accel_ms2": z, "decel_ms2": z, "ps_ms": z, "roll_rate_dps": float("nan"),
                "roll_rate_n": 0, "roll_sign": None, "roll_sign_n": 0}
    cat = {k: np.concatenate([kk[k] for kk in kins]) for k in kins[0]}
    v, a_t, n, pd, gm = cat["v"], cat["a_t"], cat["n"], cat["psi_dot"], cat["gamma"]
    straight = (np.abs(pd) < 1.0) & (np.abs(gm) < 3.0)
    turning = np.abs(pd) > 5.0
    steady = turning & (np.abs(a_t) < 1.0)
    climb = gm > 3.0
    out = {"counts": {}}
    # n_inst at p95, not p99: at 4 Hz a bin's p99 is one or two samples, i.e. a glitch.
    for key, x, mask, pct in (("n_inst", n, turning, 95.0), ("n_sus", n, steady, 90.0),
                              ("accel_ms2", a_t, straight & (a_t > 0), PCT_HI),
                              ("decel_ms2", -a_t, straight & (a_t < 0), PCT_HI),
                              ("ps_ms", cat["ps"], climb, PCT_HI)):
        vals, counts = bin_percentile(v, x, mask, pct)
        out[key] = vals
        out["counts"][key] = counts
    vm, vc = [], []
    for lo, hi in ALT_BANDS_M:
        m = (cat["alt"] >= lo) & (cat["alt"] < hi)
        vc.append(int(np.count_nonzero(m)))
        vm.append(float(np.percentile(v[m], 99.0)) if m.any() else float("nan"))
    out["vmax_ms"], out["vmax_counts"] = vm, vc
    # The trace's roll column is only bank angle if it looks like one. Race traces recorded by
    # race.js through 1.x never leave +/-1.0 (G.roll() reads geofs.animation.values.roll, which
    # behaves like a control deflection or radians, not degrees), so they can't give a roll rate
    # or sign. Say so rather than mine a number out of it.
    roll_p99 = float(np.percentile(np.abs(cat["roll"]), 99.0)) if len(cat["roll"]) else 0.0
    out["roll_column_p99"] = roll_p99
    out["attitude_suspect"] = roll_p99 < 3.0
    rr = np.abs(cat["roll_rate"])
    out["roll_rate_dps"] = float(np.percentile(rr, 99.0)) if len(rr) and not out["attitude_suspect"] else float("nan")
    out["roll_rate_n"] = int(len(rr)) if not out["attitude_suspect"] else 0
    # GeoFS's roll sign: which way the wing goes down in a right turn (psi_dot > 0). Measured, not
    # assumed; the ghost renderer draws whatever sign the recorder stored.
    m = turning & (np.abs(cat["roll"]) > 5.0)
    if np.count_nonzero(m) >= THIN_N and not out["attitude_suspect"]:
        corr = float(np.mean(np.sign(cat["roll"][m]) * np.sign(pd[m])))
        out["roll_sign"] = 1 if corr >= 0 else -1
        out["roll_sign_agreement"] = abs(corr)
    else:
        out["roll_sign"] = None
    out["roll_sign_n"] = int(np.count_nonzero(m))
    return out


def lab_kinematics(capture):
    """A capture from envelope_capture.js -> {step kind: kinematics dict}. Rows are
    [t, lat, lon, alt, hdg, pitch, roll, kias, vsFpm, haglM, step]."""
    if not isinstance(capture, dict) or capture.get("kind") != "fins-envelope-capture":
        raise ValueError("not an envelope_capture.js report (kind != fins-envelope-capture)")
    steps = {s["id"]: s for s in capture.get("steps", [])}
    rows = np.asarray(capture.get("samples", []), dtype=float)
    out = {}
    if not len(rows):
        return out
    for sid, st in steps.items():
        r = rows[rows[:, 10] == sid]
        if len(r) < 30:
            continue
        k = kinematics(r[:, :7], dt=0.05)
        out.setdefault(st["kind"], []).append(k)
    return out


def mine_lab(capture):
    """Tables from a lab capture: each flight-card step feeds only the tables it was flown for."""
    by = lab_kinematics(capture)
    cat = lambda kind: {k: np.concatenate([kk[k] for kk in by.get(kind, [])]) for k in (by[kind][0] if by.get(kind) else [])}  # noqa: E731
    out = {"counts": {}}
    z = [float("nan")] * (len(V_EDGES) - 1)
    zc = [0] * (len(V_EDGES) - 1)
    acc = cat("accel")
    if acc:
        vals, cnt = bin_percentile(acc["v"], acc["a_t"], acc["a_t"] > 0, 90.0)
        out["accel_ms2"], out["counts"]["accel_ms2"] = vals, cnt
        vm, vc = [], []
        for lo, hi in ALT_BANDS_M:
            m = (acc["alt"] >= lo) & (acc["alt"] < hi)
            vc.append(int(np.count_nonzero(m)))
            vm.append(float(np.percentile(acc["v"][m], 99.5)) if m.any() else float("nan"))
        out["vmax_ms"], out["vmax_counts"] = vm, vc
    tr = cat("turn")
    if tr:
        vals, cnt = bin_percentile(tr["v"], tr["n"], np.abs(tr["psi_dot"]) > 3.0, 99.0)
        out["n_inst"], out["counts"]["n_inst"] = vals, cnt
        vals, cnt = bin_percentile(tr["v"], tr["n"], (np.abs(tr["psi_dot"]) > 3.0) & (np.abs(tr["a_t"]) < 1.0), 90.0)
        out["n_sus"], out["counts"]["n_sus"] = vals, cnt
    dc = cat("decel")
    if dc:
        vals, cnt = bin_percentile(dc["v"], -dc["a_t"], dc["a_t"] < 0, 90.0)
        out["decel_ms2"], out["counts"]["decel_ms2"] = vals, cnt
    zm = cat("zoom")
    if zm:
        vals, cnt = bin_percentile(zm["v"], zm["ps"], np.ones(len(zm["v"]), bool), 90.0)
        out["ps_ms"], out["counts"]["ps_ms"] = vals, cnt
    rl = cat("roll")
    if rl and float(np.percentile(np.abs(rl["roll"]), 99.0)) >= 3.0:   # same bank-angle guard as mine_tables
        out["roll_rate_dps"] = float(np.percentile(np.abs(rl["roll_rate"]), 99.0))
        out["roll_rate_n"] = int(len(rl["roll_rate"]))
    for k in ("n_inst", "n_sus", "accel_ms2", "decel_ms2", "ps_ms"):
        out.setdefault(k, z)
        out["counts"].setdefault(k, zc)
    out.setdefault("vmax_ms", [float("nan")] * len(ALT_BANDS_M))
    out.setdefault("vmax_counts", [0] * len(ALT_BANDS_M))
    return out


# ------------------------------------------------------------------ merge
MONOTONE = {"n_inst": True, "n_sus": True, "accel_ms2": False, "decel_ms2": True}


def _fill_above(arr, src, key, vc, vtop):
    """Seed bins ABOVE the fastest measured bin would splice a slow spec-sheet number onto a fast
    measured curve. Hold the last measured value there instead (accel: taper it to 0 at vtop, the
    top speed), and mark those bins 'held'. Bins below the slowest measured one keep the seed."""
    meas = [i for i, s in enumerate(src) if s in ("mined", "lab")]
    if not meas:
        return arr
    top = max(meas)
    for i in range(top + 1, len(arr)):
        if key == "accel_ms2":
            span = max(vtop - vc[top], 1.0)
            arr[i] = max(0.0, arr[top] * (1.0 - (vc[i] - vc[top]) / span))
        else:
            arr[i] = arr[top]
        src[i] = "held"
    return arr


def merge(seed, mined, lab=None, thin_n=THIN_N):
    """Per bin: mined when not thin, else lab when not thin, else seed (held/tapered above the
    fastest measured bin). Then monotone-smooth each table (PAVA) and enforce n_sus <= n_inst and
    n >= 1. Returns (tables, sources, counts, thin)."""
    tables, sources, counts, thin = {}, {}, {}, []
    lab = lab or {}
    vc = _v_centers()
    nb = len(ALT_BANDS_M)
    vm, vs, vcn = [], [], []
    for i in range(nb):
        mv, mcn = mined.get("vmax_ms", [float("nan")] * nb)[i], mined.get("vmax_counts", [0] * nb)[i]
        lv, lcn = lab.get("vmax_ms", [float("nan")] * nb)[i], lab.get("vmax_counts", [0] * nb)[i]
        if mcn >= thin_n and math.isfinite(mv) and 50 < mv < 700:
            vm.append(mv), vs.append("mined"), vcn.append(mcn)
        elif lcn >= thin_n and math.isfinite(lv) and 50 < lv < 700:
            vm.append(lv), vs.append("lab"), vcn.append(lcn)
        else:
            vm.append(seed["vmax_ms"][i]), vs.append("seed"), vcn.append(max(mcn, lcn))
            if 0 < max(mcn, lcn) < thin_n:
                thin.append(f"vmax@{ALT_BANDS_M[i][0]}-{ALT_BANDS_M[i][1]}m (n={max(mcn, lcn)})")
    vmax = np.maximum.accumulate(np.array(vm))   # thinner air is never slower
    for i in range(1, nb):
        if vs[i] == "seed" and vmax[i] > vm[i]:
            vs[i] = "held"
    tables["vmax_ms"] = vmax.round(2).tolist()
    sources["vmax_ms"], counts["vmax_ms"] = vs, vcn
    vtop = float(vmax.max())
    for key in ("n_inst", "n_sus", "accel_ms2", "decel_ms2", "ps_ms"):
        lo, hi = BOUNDS[key]
        vals, src, cnt = [], [], []
        mc = mined.get("counts", {}).get(key, [0] * len(vc))
        lc = lab.get("counts", {}).get(key, [0] * len(vc))
        for i in range(len(vc)):
            mv = mined.get(key, [float("nan")] * len(vc))[i]
            lv = lab.get(key, [float("nan")] * len(vc))[i] if lab.get(key) else float("nan")
            if mc[i] >= thin_n and math.isfinite(mv) and lo <= mv <= hi:
                vals.append(mv), src.append("mined"), cnt.append(mc[i])
            elif lc[i] >= thin_n and math.isfinite(lv) and lo <= lv <= hi:
                vals.append(lv), src.append("lab"), cnt.append(lc[i])
            else:
                vals.append(seed[key][i]), src.append("seed"), cnt.append(max(mc[i], lc[i]))
                if 0 < mc[i] < thin_n or 0 < lc[i] < thin_n:
                    thin.append(f"{key}@{vc[i]:.0f}m/s (n={max(mc[i], lc[i])})")
        arr = _fill_above(np.array(vals, dtype=float), src, key, vc, vtop)
        if key in MONOTONE:
            arr = pava(arr, increasing=MONOTONE[key], w=np.maximum(np.array(cnt, float), 1.0))
        if key == "accel_ms2":
            arr = np.where(np.array(vc) >= vtop, 0.0, arr)
        tables[key], sources[key], counts[key] = arr.round(3).tolist(), src, cnt
    tables["n_inst"] = np.maximum(tables["n_inst"], 1.0).round(3).tolist()
    tables["n_sus"] = np.minimum(np.maximum(tables["n_sus"], 1.0), tables["n_inst"]).round(3).tolist()
    for key, nkey in (("roll_rate_dps", "roll_rate_n"),):
        mv, mn = mined.get(key, float("nan")), mined.get(nkey, 0)
        lv, ln = lab.get(key, float("nan")), lab.get(nkey, 0)
        if mn >= thin_n * 4 and math.isfinite(mv) and 20 < mv < 400:
            tables[key], sources[key], counts[key] = round(mv, 1), "mined", mn
        elif ln >= thin_n and math.isfinite(lv) and 20 < lv < 400:
            tables[key], sources[key], counts[key] = round(lv, 1), "lab", ln
        else:
            tables[key], sources[key], counts[key] = seed[key], "seed", max(mn, ln)
    rs = mined.get("roll_sign")
    tables["roll_sign"] = rs if rs in (1, -1) else seed["roll_sign"]
    sources["roll_sign"] = "mined" if rs in (1, -1) else "seed"
    counts["roll_sign"] = mined.get("roll_sign_n", 0)
    return tables, sources, counts, thin


def version_of(sources):
    flat = [s for v in sources.values() for s in (v if isinstance(v, list) else [v])]
    tag = "seed-1"
    if "lab" in flat:
        tag += "+lab"
    if "mined" in flat:
        tag += "+mined"
    return tag


def build_envelope(aircraft_id, traces, capture=None, metas=None, jet_threshold=JET_P95_MS):
    seed = seed_envelope(aircraft_id)
    if seed is None:
        return None, {"reason": f"no seed table for aircraft {aircraft_id}"}
    used, unattributed, other = [], [], []
    for tr in traces:
        meta = (metas or {}).get(tr["course_id"]) or {}
        ac = meta.get("aircraftId")
        if ac != str(aircraft_id):
            other.append(tr)
            continue
        k = kinematics(tr["rows"])
        if str(aircraft_id) == "7" and not classify_jet(k, jet_threshold):
            unattributed.append(tr)
            continue
        used.append((tr, k))
    mined = mine_tables([k for _, k in used])
    lab = mine_lab(capture) if capture else None
    tables, sources, counts, thin = merge(seed, mined, lab)
    env = {
        "format": ENVELOPE_FORMAT, "aircraftId": str(aircraft_id), "envelope_version": version_of(sources),
        "generated": _dt.date.today().isoformat(), "g": rc.G0,
        "v_edges": V_EDGES.tolist(), "v_centers": _v_centers(), "alt_bands_m": ALT_BANDS_M,
        **tables, "sources": sources, "counts": counts, "thin": thin,
        "mining": {
            "traces_seen": len(traces), "traces_used": len(used), "traces_unattributed": len(unattributed),
            "traces_other_aircraft": len(other), "pilots": sorted({t["callsign"] for t, _ in used}),
            "courses": sorted({t["course_id"] for t, _ in used}),
            "samples": int(sum(len(k["v"]) for _, k in used)),
            "jet_p95_threshold_ms": jet_threshold, "thin_n": THIN_N, "lab": bool(capture),
            "unattributed": [f"{t['course_id']}/{t['callsign']}" for t in unattributed],
            "attitude_suspect": bool(mined.get("attitude_suspect")), "roll_column_p99": mined.get("roll_column_p99"),
        },
    }
    return env, None


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--aircraft", default="7")
    ap.add_argument("--lab", help="envelope_capture.js JSON report to merge")
    ap.add_argument("--offline", action="store_true", help="only use race/rivals/cache/")
    ap.add_argument("--out", help="output path (default race/rivals/envelope-<id>.json)")
    args = ap.parse_args(argv)
    courses, cups = rc.load_course_files()
    metas = rc.course_metas(courses, cups)
    traces = download_traces(metas, rc.CACHE_DIR, args.offline)
    capture = json.loads(Path(args.lab).read_text(encoding="utf-8")) if args.lab else None
    env, err = build_envelope(args.aircraft, traces, capture, metas)
    if env is None:
        print(f"aircraft {args.aircraft}: {err['reason']} and no data — skipped")
        return 2
    out = Path(args.out) if args.out else rc.RIVALS_DIR / f"envelope-{args.aircraft}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(env, indent=1) + "\n", encoding="utf-8")
    m = env["mining"]
    print(f"envelope {env['envelope_version']} -> {out}")
    print(f"  traces: {m['traces_seen']} seen, {m['traces_used']} used ({m['samples']} samples), "
          f"{m['traces_unattributed']} failed the jet check, {m['traces_other_aircraft']} other aircraft")
    for k, src in env["sources"].items():
        s = src if isinstance(src, list) else [src]
        print(f"  {k:14s} " + ", ".join(f"{x}:{s.count(x)}" for x in ("mined", "lab", "seed") if s.count(x)))
    if env["thin"]:
        print("  thin bins (seed used): " + "; ".join(env["thin"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
