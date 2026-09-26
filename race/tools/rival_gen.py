#!/usr/bin/env python3
"""Rival generator: computed "perfect line" ghost traces, flown offline against an aircraft envelope.

A rival is a ghost trace (traceEncode v1, 4 Hz, t = 0 at the gate-1 start) computed by a
quasi-steady-state point-mass lap-time model instead of being flown in the sim. That needs no
physics writes at all: the trace is data, exactly like a recorded human run.

Model (per course, per persona):
  * Line: each route gate gets a crossing point = centre + (lateral, vertical) offset in the plane
    across the local path direction, inside the persona's usable window (gateWindow x radius). A
    C2 natural cubic spline through spawn -> crossings -> run-out gives a path with continuous
    curvature.
  * Speed: v_lim(s) from the envelope's n_inst(v) (gravity included in the normal specific force),
    capped at Vmax(alt). Forward pass from the solo spawn speed with full-throttle accel(v), minus
    the turn drag that makes n_sus(v) the sustained limit, minus g*sin(gamma) (climbing costs
    energy). Backward pass with decel(v) + g*sin(gamma). time = sum(ds / v).
  * Clock: like race.js: t = 0 when the path LEAVES the gate-1 (index 0) sphere, each later gate
    at first contact with its sphere. This is the model's own estimate for the objective only;
    race/tools/rival_verify.js replays the trace through race.js's real Race state machine and is
    the only judge.
  * Terrain: every sample >= minAglM above Terrarium terrain, as a steep penalty inside the
    objective (race/tools/check_terrain.py's TerrariumSource, tiles cached in race/rivals/cache/).
  * Search: seeded coordinate descent over the crossing offsets, with a runtime cap per persona.
  * Attitude: heading from the path, bank = direction of the normal specific force (roll-rate
    limited), pitch = flight-path angle + a small AoA term.

Personas and calibration: race/tools/rival_personas.py. Verification: race/tools/rival_verify.js.

Usage:
  python rival_gen.py --all                 # every F-16 course -> race/rivals/.pending/<id>.json
  python rival_gen.py --course gorge-run    # one course
  then: node rival_verify.js --write        # the judge: writes race/rivals/<id>.json for passes
"""
from __future__ import annotations

import argparse
import json
import math
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import rival_common as rc  # noqa: E402

GENERATOR_VERSION = "rival-gen-1"
TRACE_DT_MS = 250            # CONFIG.TRACE_HZ = 4
EARTH_R = 6371008.8
RUNOUT_M = 300.0
LEAD_POINT_M = 400.0
AGL_PENALTY_S_PER_M2 = 0.05  # 30 m under the floor at one sample costs 45 s: steep, but smooth
MISS_PENALTY_S = 1e4
# The optimizer targets this fraction of n_allow(v), not 100% of it: rival_verify.js re-derives
# g-load from the SHIPPED 4 Hz trace by finite-differencing quantized positions, a coarser and
# differently-sampled reconstruction than the dense (5-20 m) continuous model the line was
# actually optimized against. Aiming exactly at the boundary left a handful of turns reading a
# few percent over the limit once resampled to 4 Hz and re-differentiated; this margin absorbs
# that gap instead of chasing it bin by bin.
G_SAFETY_FRAC = 0.95
AOA_DEG_PER_G = 1.0
AOA_MAX_DEG = 12.0
POST_FINISH_MS = 250         # one sample past the finish, inside the sphere, like a pilot's last frame
                             # (the server accepts a trace ending within 500 ms of the finish)
MAX_USABLE_WINDOW = 0.9      # no line grazes a gate edge: a 20 Hz replay must still touch the sphere
VIA_RANGE_M = 3000.0         # a via point floats this far (lateral/vertical disk) off its leg's chord
VIA_SEPARATION_M = 2000.0    # a second via on the same leg only this far from the first


# ------------------------------------------------------------------ route
def _same_gate(a, b):
    return all(abs(float(a[k]) - float(b[k])) < 1e-9 for k in ("lat", "lon", "alt", "radius"))


def detect_lap_period(gates):
    """Smallest K such that the gate list is one K-gate lap repeated, closed by gate 0 once more
    (race/docs/LAPS.md's unrolled form: N = K*laps + 1). None for a point-to-point course."""
    n = len(gates)
    for k in range(2, (n - 1) // 2 + 1):
        if (n - 1) % k:
            continue
        if all(_same_gate(gates[i], gates[i + k]) for i in range(n - k)):
            return k
    return None


def expand_route(course):
    """(route gates, lap index per route gate, lap-gate index per route gate, K, laps).

    A native `laps` course (LAPS.md: `gates` = one lap, gate 0 = start/finish) expands to
    gates 0..K-1 x laps + gate 0. It's only honoured when race.js's own normalizer kept `laps`
    (the judge flies what race.js flies); today's shipped circuits are unrolled, and their lap
    structure is detected from the repeated coordinates instead."""
    gates = course["gates"]
    laps = int(course.get("laps") or 1)
    if laps > 1:
        k = len(gates)
        route = [gates[i % k] for i in range(k * laps)] + [gates[0]]
        lap_of = [min(i // k, laps - 1) for i in range(len(route))]
        return route, lap_of, [i % k for i in range(len(route))], k, laps
    k = detect_lap_period(gates)
    if k:
        laps = (len(gates) - 1) // k
        lap_of = [min(i // k, laps - 1) for i in range(len(gates))]
        return list(gates), lap_of, [i % k for i in range(len(gates))], k, laps
    return list(gates), [0] * len(gates), list(range(len(gates))), len(gates), 1


# ------------------------------------------------------------------ geometry
def _unit(v):
    n = np.linalg.norm(v, axis=-1, keepdims=True)
    return v / np.where(n > 1e-12, n, 1.0)


def alt_of(p):
    """Altitude of ENU points (frame at alt 0): z plus the earth's curvature drop."""
    return p[..., 2] + (p[..., 0] ** 2 + p[..., 1] ** 2) / (2 * EARTH_R)


def up_of(p):
    """Local 'up' at ENU points (tilts ~0.9 deg per 100 km from the frame's own up)."""
    return _unit(np.stack([p[..., 0] / EARTH_R, p[..., 1] / EARTH_R, np.ones(p.shape[:-1])], axis=-1))


class CourseGeom:
    """One course in a local ENU frame: gate centres/radii, per-gate crossing basis, spawn."""

    def __init__(self, meta):
        self.meta = meta
        course = meta["course"]
        self.route, self.lap_of, self.lap_gate, self.K, self.laps = expand_route(course)
        lats = [g["lat"] for g in self.route]
        lons = [g["lon"] for g in self.route]
        self.frame = rc.Enu(float(np.mean(lats)), float(np.mean(lons)), 0.0)
        self.C = self.frame.from_lla(lats, lons, [g["alt"] for g in self.route])
        self.r = np.array([float(g["radius"]) for g in self.route])
        sp = meta["spawn"]
        self.spawn = self.frame.from_lla(sp["lat"], sp["lon"], sp["alt"])
        self.v0 = float(sp["speedMs"])
        h = math.radians(sp["heading"])
        up0 = up_of(self.spawn[None])[0]
        d = np.array([math.sin(h), math.cos(h), 0.0])
        self.spawn_dir = _unit(d - np.dot(d, up0) * up0)
        n = len(self.C)
        prev = np.vstack([self.spawn[None], self.C[:-1]])
        d_in = _unit(self.C - prev)
        d_out = np.vstack([_unit(self.C[1:] - self.C[:-1]), d_in[-1:]])
        t = _unit(d_in + d_out)
        bad = np.linalg.norm(d_in + d_out, axis=1) < 1e-6
        t[bad] = d_in[bad]
        up = up_of(self.C)
        self.T = t
        self.L = _unit(np.cross(t, up))              # right of the path
        self.U = _unit(np.cross(self.L, t))          # up, across the path
        # +1 = left turn at this gate, -1 = right, 0 = straight: the outside of the turn is +L for
        # a left turn and -L for a right one (i.e. outside = turn * L).
        turn = np.einsum("ij,ij->i", np.cross(d_in, d_out), up)
        self.turn = np.where(np.abs(turn) > 0.05, np.sign(turn), 0.0)
        self.turn[0] = self.turn[-1] = 0.0
        self.n = n
        # Via points: free control points on a leg (not gates), added only where the line between
        # two gates would fly into terrain (plan_vias). A pilot climbs over or goes round a ridge
        # between gates; so can a rival. They are offset rows n.. in every offsets array.
        self.vias = []

    @property
    def m(self):
        return len(self.vias)

    def add_via(self, leg, frac):
        a, b = self.C[leg], self.C[leg + 1]
        base = a + frac * (b - a)
        t = _unit(b - a)
        up = up_of(base[None])[0]
        L = _unit(np.cross(t, up))
        self.vias.append({"leg": int(leg), "frac": float(frac), "B": base, "L": L, "U": _unit(np.cross(L, t))})

    def path_rows(self):
        """Offset-row indices in flying order: gate 0, its leg's vias, gate 1, ..."""
        order = []
        for i in range(self.n):
            order.append(i)
            order += [self.n + j for _, j in sorted((v["frac"], j) for j, v in enumerate(self.vias) if v["leg"] == i)]
        return order

    def full(self, off):
        """Offsets for gates only (n, 2) -> (n + m, 2), vias at their chord point."""
        off = np.asarray(off, dtype=float)
        if off.shape[0] == self.n + self.m:
            return off
        return np.vstack([off[:self.n], np.zeros((self.m, 2))])

    def limits(self, window):
        return np.concatenate([window * self.r, np.full(self.m, VIA_RANGE_M)])

    def crossings(self, off):
        """off (n, 2) metres (lateral along L, vertical along U) -> crossing points (n, 3)."""
        return self.C + off[:self.n, :1] * self.L + off[:self.n, 1:2] * self.U

    def points(self, off):
        off = self.full(off)
        X = self.crossings(off)
        if not self.m:
            return X
        B = np.array([v["B"] for v in self.vias])
        L = np.array([v["L"] for v in self.vias])
        U = np.array([v["U"] for v in self.vias])
        return np.vstack([X, B + off[self.n:, :1] * L + off[self.n:, 1:2] * U])

    def waypoints(self, off):
        Q = self.points(off)[self.path_rows()]
        lead = self.spawn + LEAD_POINT_M * self.spawn_dir
        runout = Q[-1] + RUNOUT_M * _unit(Q[-1] - Q[-2])
        return np.vstack([self.spawn[None], lead[None], Q, runout[None]])


def clamp_offsets(off, limit):
    """Pull each (lateral, vertical) offset back inside a disk of radius limit[i]."""
    off = np.asarray(off, dtype=float).copy()
    norm = np.linalg.norm(off, axis=1)
    over = norm > limit
    off[over] *= (limit[over] / norm[over])[:, None]
    return off


# ------------------------------------------------------------------ spline
def natural_spline(P, ds):
    """C2 natural cubic spline through P (m, 3), chord-length parameterised, sampled every ~ds.
    Returns (pos, d1, d2, knot_index): derivatives w.r.t. the chord parameter; knot_index[k] is
    the sample index of waypoint k."""
    P = np.asarray(P, dtype=float)
    h = np.linalg.norm(np.diff(P, axis=0), axis=1)
    h = np.maximum(h, 1e-3)
    m = len(P)
    M = np.zeros_like(P)
    if m > 2:
        # tridiagonal system for the second derivatives at interior knots (Thomas algorithm)
        a = h[:-1].copy()
        b = 2 * (h[:-1] + h[1:])
        c = h[1:].copy()
        rhs = 6 * ((P[2:] - P[1:-1]) / h[1:, None] - (P[1:-1] - P[:-2]) / h[:-1, None])
        k = len(b)
        cp = np.zeros(k)
        dp = np.zeros((k, 3))
        cp[0] = c[0] / b[0]
        dp[0] = rhs[0] / b[0]
        for i in range(1, k):
            den = b[i] - a[i] * cp[i - 1]
            cp[i] = c[i] / den if i < k - 1 else 0.0
            dp[i] = (rhs[i] - a[i] * dp[i - 1]) / den
        x = np.zeros((k, 3))
        x[-1] = dp[-1]
        for i in range(k - 2, -1, -1):
            x[i] = dp[i] - cp[i] * x[i + 1]
        M[1:-1] = x
    counts = np.maximum(1, np.ceil(h / ds).astype(int))
    seg = np.repeat(np.arange(m - 1), counts)
    frac = np.concatenate([np.arange(c) / c for c in counts])
    seg = np.append(seg, m - 2)
    frac = np.append(frac, 1.0)
    hs = h[seg][:, None]
    B = frac[:, None]
    A = 1 - B
    P0, P1, M0, M1 = P[seg], P[seg + 1], M[seg], M[seg + 1]
    pos = A * P0 + B * P1 + ((A ** 3 - A) * M0 + (B ** 3 - B) * M1) * hs ** 2 / 6
    d1 = (P1 - P0) / hs - (3 * A ** 2 - 1) / 6 * hs * M0 + (3 * B ** 2 - 1) / 6 * hs * M1
    d2 = A * M0 + B * M1
    knot_index = np.concatenate([[0], np.cumsum(counts)])
    return pos, d1, d2, knot_index


# ------------------------------------------------------------------ envelope, scaled by a persona
class Perf:
    """The envelope tables a persona flies with: every limit x frac (speed also x speedCap)."""

    def __init__(self, env, frac=1.0, speed_cap=1.0):
        self.env = env
        self.frac = float(frac)
        self.speed_cap = float(speed_cap)
        self.vc = np.asarray(env["v_centers"], dtype=float)
        self.n_inst = np.asarray(env["n_inst"], dtype=float)
        self.n_sus = np.asarray(env["n_sus"], dtype=float)
        self.accel = np.asarray(env["accel_ms2"], dtype=float)
        self.decel = np.asarray(env["decel_ms2"], dtype=float)
        # turn drag coefficient: accel(v) - k(v)*(n^2 - 1) = 0 at n = n_sus(v)
        self.kdrag = self.accel / np.maximum(self.n_sus ** 2 - 1.0, 0.25)
        self.roll_rate = float(env["roll_rate_dps"]) * self.frac
        self.roll_sign = int(env.get("roll_sign") or 1)
        self._v0 = float(self.vc[0])
        self._dv = float(self.vc[1] - self.vc[0])
        self._tabs = [t.tolist() for t in (self.accel, self.kdrag, self.decel)]

    def vmax(self, alt):
        return rc.vmax_at(self.env, alt) * self.frac * self.speed_cap

    def n_allow(self, v):
        return np.maximum(1.0, np.interp(v, self.vc, self.n_inst) * self.frac)

    def _lookup(self, tab, v):
        x = (v - self._v0) / self._dv
        if x <= 0:
            return tab[0]
        i = int(x)
        if i >= len(tab) - 1:
            return tab[-1]
        f = x - i
        return tab[i] + (tab[i + 1] - tab[i]) * f


# ------------------------------------------------------------------ speed profile
def path_terms(pos, d1, d2):
    """Per-sample geometry: ds, unit tangent, curvature vector, the across-path part of 'up',
    sin(gamma), altitude."""
    sp = np.linalg.norm(d1, axis=1)
    T = d1 / sp[:, None]
    kap = (d2 - np.einsum("ij,ij->i", d2, T)[:, None] * T) / (sp ** 2)[:, None]
    up = up_of(pos)
    sing = np.einsum("ij,ij->i", up, T)
    uperp = up - sing[:, None] * T
    ds = np.linalg.norm(np.diff(pos, axis=0), axis=1)
    return {"ds": ds, "T": T, "kap": kap, "uperp": uperp, "sing": sing, "alt": alt_of(pos), "up": up}


def load_factor(v, kap, uperp):
    """n = |v^2 kappa + g up_perp| / g: the specific force the wing must make, in g."""
    f = (v ** 2)[..., None] * kap + rc.G0 * uperp
    return np.linalg.norm(f, axis=-1) / rc.G0


def v_limit(terms, perf, iters=26):
    """Max speed at each sample: the turn needs no more than n_allow(v), and v <= Vmax(alt).

    The bisection floor is perf.vc[0] (the envelope's lowest speed bin), not an arbitrary near-zero
    value: below that speed n_allow(v) is a flat extrapolation (np.interp clamps), so the
    load-factor constraint becomes almost trivially satisfiable near v=0 (gravity alone gives
    n=1) and would otherwise let this bisection return a physically meaningless crawl speed the
    envelope says nothing about."""
    vcap = perf.vmax(terms["alt"])
    kap, up = terms["kap"], terms["uperp"]
    lo = np.full(len(vcap), float(perf.vc[0]))
    hi = vcap.copy()
    allow = lambda v: G_SAFETY_FRAC * perf.n_allow(v)  # noqa: E731 — see G_SAFETY_FRAC
    ok_hi = load_factor(hi, kap, up) <= allow(hi)
    for _ in range(iters):
        mid = 0.5 * (lo + hi)
        ok = load_factor(mid, kap, up) <= allow(mid)
        lo = np.where(ok, mid, lo)
        hi = np.where(ok, hi, mid)
    return np.where(ok_hi, vcap, lo)


def speed_profile(terms, perf, v0, vlim=None):
    """Forward (accel) / backward (decel) passes -> speed at each sample and cumulative time.

    Both passes are floored at perf.vc[0] (VMIN, the envelope's lowest speed bin), never at an
    arbitrary near-zero constant. A tight via or a sharp corner can drive the required
    deceleration so hard that v^2 - 2*d*ds goes negative; that means the line demands more than
    the envelope can deliver at speed, not that the aircraft can crawl through it at a handful of
    m/s. Flooring at VMIN keeps every downstream sample (and the physics the verifier re-derives
    from the trace) inside the domain the envelope actually describes, instead of manufacturing a
    near-hover point that reads as a spurious over-g violation a few samples later."""
    if vlim is None:
        vlim = v_limit(terms, perf)
    ds = terms["ds"].tolist()
    kap2 = np.einsum("ij,ij->i", terms["kap"], terms["kap"]).tolist()
    kup = np.einsum("ij,ij->i", terms["kap"], terms["uperp"]).tolist()
    up2 = np.einsum("ij,ij->i", terms["uperp"], terms["uperp"]).tolist()
    sing = terms["sing"].tolist()
    vl = vlim.tolist()
    n = len(vl)
    g = rc.G0
    fr = perf.frac
    vmin = float(perf.vc[0])
    vmin2 = vmin * vmin
    acc_t, kd_t, dec_t = perf._tabs
    look = perf._lookup
    v = [0.0] * n
    v[0] = max(vmin, min(v0, vl[0]))
    for i in range(n - 1):
        vi = v[i]
        v2 = vi * vi
        n2 = (v2 * v2 * kap2[i] + 2 * v2 * g * kup[i] + g * g * up2[i]) / (g * g)
        a = fr * (look(acc_t, vi) - look(kd_t, vi) * max(n2 - 1.0, 0.0)) - g * sing[i]
        w = v2 + 2 * a * ds[i]
        vn = math.sqrt(w) if w > vmin2 else vmin
        v[i + 1] = vn if vn < vl[i + 1] else vl[i + 1]
    for i in range(n - 2, -1, -1):
        vn = v[i + 1]
        d = fr * look(dec_t, vn) + g * sing[i]
        if d < 0.5:
            d = 0.5
        w = vn * vn + 2 * d * ds[i]
        if v[i] * v[i] > w:
            v[i] = math.sqrt(w) if w > vmin2 else vmin
    va = np.asarray(v)
    dt = terms["ds"] / np.maximum(0.5 * (va[:-1] + va[1:]), 1.0)
    return va, np.concatenate([[0.0], np.cumsum(dt)])


# ------------------------------------------------------------------ the model's clock
def gate_times(pos, t, C, r):
    """Model estimate of race.js's clock on a dense path: (start time = leaving sphere 0, [time of
    first contact with each later sphere, in order]). None where a gate is never reached."""
    d0 = np.linalg.norm(pos - C[0], axis=1)
    inside = np.nonzero(d0 <= r[0])[0]
    if not len(inside):
        return None, [None] * (len(C) - 1)
    i = inside[0]
    while i + 1 < len(d0) and d0[i + 1] <= r[0]:
        i += 1
    if i + 1 >= len(d0):
        return None, [None] * (len(C) - 1)
    f = (r[0] - d0[i]) / max(d0[i + 1] - d0[i], 1e-9)
    t_start = t[i] + f * (t[i + 1] - t[i])
    ptr = i + 1
    out = []
    for j in range(1, len(C)):
        dj = np.linalg.norm(pos[ptr:] - C[j], axis=1)
        hit = np.nonzero(dj <= r[j])[0]
        if not len(hit):
            out.extend([None] * (len(C) - j))
            break
        k = ptr + hit[0]
        if k == 0:
            out.append(t[0])
        else:
            da = np.linalg.norm(pos[k - 1] - C[j])
            db = np.linalg.norm(pos[k] - C[j])
            f = (da - r[j]) / max(da - db, 1e-9)
            out.append(t[k - 1] + min(max(f, 0.0), 1.0) * (t[k] - t[k - 1]))
        ptr = k
    return t_start, out


# ------------------------------------------------------------------ terrain
class TerrainGrid:
    """Vectorised bilinear Terrarium lookup: tiles decoded once into numpy arrays. `source` is a
    check_terrain.TerrariumSource (its _tile(x, y) and zoom), so tiles come from its disk cache."""

    def __init__(self, source):
        self.src = source
        self.zoom = source.zoom
        self.tiles = {}

    def _tile(self, tx, ty):
        key = (tx, ty)
        if key not in self.tiles:
            a = np.asarray(self.src._tile(tx, ty), dtype=float)   # check_terrain's own PNG decode
            self.tiles[key] = a[..., 0] * 256.0 + a[..., 1] + a[..., 2] / 256.0 - 32768.0   # terrarium_height()
        return self.tiles[key]

    def heights(self, lat, lon):
        lat = np.clip(np.asarray(lat, dtype=float), -85.05112878, 85.05112878)
        lon = np.asarray(lon, dtype=float)
        n = 256 * 2 ** self.zoom
        px = (lon + 180.0) / 360.0 * n - 0.5
        s = np.sin(np.radians(lat))
        py = (0.5 - np.log((1 + s) / (1 - s)) / (4 * math.pi)) * n - 0.5
        x0 = np.floor(px).astype(np.int64)
        y0 = np.floor(py).astype(np.int64)
        tx, ty = px - x0, py - y0
        out = np.zeros(len(px))
        corners = [(0, 0, (1 - tx) * (1 - ty)), (1, 0, tx * (1 - ty)), (0, 1, (1 - tx) * ty), (1, 1, tx * ty)]
        for dx, dy, w in corners:
            gx = (x0 + dx) % n
            gy = np.clip(y0 + dy, 0, n - 1)
            tix, tiy = gx // 256, gy // 256
            h = np.zeros(len(px))
            for key in set(zip(tix.tolist(), tiy.tolist())):
                m = (tix == key[0]) & (tiy == key[1])
                h[m] = self._tile(*key)[gy[m] % 256, gx[m] % 256]
            out += w * h
        return out


def make_terrain(cache_dir=None):
    """The default terrain: check_terrain's global Terrarium source, tiles cached under
    race/rivals/cache/terrain.tiles (check_terrain.tile_dir_for's naming)."""
    import check_terrain as ct
    cache = Path(cache_dir or rc.CACHE_DIR) / "terrain.json"
    src = ct.TerrariumSource(tile_dir=ct.tile_dir_for(str(cache)))
    return TerrainGrid(src), src


# ------------------------------------------------------------------ evaluate a line
class Evaluator:
    """time(offsets) for one course + persona performance, with terrain + gate-miss penalties."""

    def __init__(self, geom, perf, terrain=None, min_agl=60.0, ds=None):
        self.g = geom
        self.perf = perf
        self.terrain = terrain
        self.min_agl = float(min_agl)
        self.ds = ds or float(np.clip(0.6 * geom.r.min(), 5.0, 20.0))
        self.evals = 0

    def ground(self, pos):
        if self.terrain is None:
            return np.full(len(pos), -1e9)
        lat, lon, _ = self.g.frame.to_lla(pos)
        return self.terrain(lat, lon) if callable(self.terrain) else self.terrain.heights(lat, lon)

    def run(self, off, ds=None, detail=False):
        self.evals += 1
        P = self.g.waypoints(off)
        pos, d1, d2, knots = natural_spline(P, ds or self.ds)
        terms = path_terms(pos, d1, d2)
        v, t = speed_profile(terms, self.perf, self.g.v0)
        t0, times = gate_times(pos, t, self.g.C, self.g.r)
        missed = sum(1 for x in times if x is None) + (t0 is None)
        agl = terms["alt"] - self.ground(pos)
        # only the part from the start gate on is raced; before that is the spawn run-in, which
        # still has to clear terrain but by the course's own start-corridor rules, not ours
        k0 = knots[2]
        deficit = np.maximum(0.0, self.min_agl - agl[k0:])
        pen = AGL_PENALTY_S_PER_M2 * float(np.sum(deficit ** 2)) + MISS_PENALTY_S * missed
        total = (times[-1] - t0) if not missed else MISS_PENALTY_S * 10
        cost = total + pen
        if not detail:
            return cost
        return {"cost": cost, "time_s": total, "t0": t0, "times": times, "missed": missed, "pos": pos,
                "terms": terms, "v": v, "t": t, "agl": agl, "knots": knots, "penalty_s": pen,
                "min_agl_m": float(agl[k0:].min()) if len(agl) > k0 else float("nan")}


# ------------------------------------------------------------------ search
def optimize(ev, window, init=None, cap_s=30.0, seed=1, fixed=None, min_step_frac=0.02, dims=(0, 1)):
    """Seeded coordinate descent over (lateral, vertical) crossing offsets, each inside
    window * radius. fixed: gate indices whose offset is not searched; dims=(1,) searches only the
    vertical (terrain clearance for a line that is otherwise fixed). Returns (offsets, report)."""
    g = ev.g
    limit = g.limits(window)
    off = clamp_offsets(g.full(np.zeros((g.n, 2)) if init is None else init), limit)
    best = ev.run(off)
    rng = np.random.default_rng(seed)
    step = 0.5
    t_start = time.monotonic()
    sweeps = 0
    history = [best]
    converged = False
    fixed = set(fixed or [])
    coords = [(i, d) for i in range(off.shape[0]) for d in dims if i not in fixed]
    while True:
        if time.monotonic() - t_start > cap_s:
            break
        sweeps += 1
        improved = False
        for ci in rng.permutation(len(coords)):
            i, d = coords[ci]
            for sgn in (1.0, -1.0):
                trial = off.copy()
                trial[i, d] += sgn * step * limit[i]
                trial = clamp_offsets(trial, limit)
                if np.allclose(trial[i], off[i]):
                    continue
                c = ev.run(trial)
                if c < best - 1e-6:
                    best, off, improved = c, trial, True
                    break
            if time.monotonic() - t_start > cap_s:
                break
        history.append(best)
        if not improved:
            if step <= min_step_frac:
                converged = True
                break
            step *= 0.5
    rep = {"sweeps": sweeps, "evals": ev.evals, "seconds": round(time.monotonic() - t_start, 2),
           "converged": converged, "final_step_frac": step,
           "last_sweep_gain_ms": round(1000 * float(history[-2] - history[-1]), 1) if len(history) > 1 else 0.0,
           "start_cost_s": round(float(history[0]), 3), "final_cost_s": round(float(history[-1]), 3)}
    return off, rep


def lift_for_terrain(ev, off, window, step_m=5.0, max_iter=400):
    """A fixed line (STEVE's centres, BRAT's sloppy line) that dips under the terrain floor: raise
    only the crossing nearest the worst deficit, a few metres at a time, until it clears or that
    gate's window is used up. Minimal on purpose: unlike optimize(dims=(1,)) it never moves a
    crossing to save time. Returns (offsets, report)."""
    g = ev.g
    off = g.full(np.asarray(off, dtype=float)).copy()
    limit = g.limits(window)
    rows = np.array(g.path_rows())
    raised = {}
    it = 0
    for it in range(max_iter):
        res = ev.run(off, detail=True)
        k0 = res["knots"][2]
        agl = res["agl"][k0:]
        if not len(agl) or agl.min() >= ev.min_agl:
            return off, {"lifted_rows": raised, "iterations": it, "cleared": True}
        worst = k0 + int(np.argmin(agl))
        step = float(np.clip(0.5 * (ev.min_agl - agl.min()), step_m, 100.0))
        row_knots = res["knots"][2:2 + len(rows)]
        moved = False
        for pi in np.argsort(np.abs(row_knots - worst))[:3]:
            ri = int(rows[pi])
            trial = off.copy()
            trial[ri, 1] += step
            trial = clamp_offsets(trial, limit)
            if trial[ri, 1] > off[ri, 1] + 1e-9:
                off = trial
                raised[ri] = round(float(off[ri, 1]), 1)
                moved = True
                break
        if not moved:
            break
    return off, {"lifted_rows": raised, "iterations": it + 1, "cleared": False}


def plan_vias(ev, window=MAX_USABLE_WINDOW, max_vias=12):
    """Add via points where the gate-centre line hits the terrain floor between gates, lifting as
    it goes. Returns (lifted offsets incl. vias, report). The vias belong to the course geometry:
    every persona flies through the same vias, each at its own offsets."""
    g = ev.g
    g.vias = []
    off, rep = lift_for_terrain(ev, np.zeros((g.n, 2)), window)
    added = []
    while not rep["cleared"] and g.m < max_vias:
        res = ev.run(off, detail=True)
        k0 = res["knots"][2]
        worst = k0 + int(np.argmin(res["agl"][k0:]))
        rows = g.path_rows()
        row_knots = res["knots"][2:2 + len(rows)]
        pos = int(np.searchsorted(row_knots, worst, side="right")) - 1
        gates_before = [r for r in rows[:max(pos, 0) + 1] if r < g.n]
        leg = gates_before[-1] if gates_before else 0
        if leg >= g.n - 1:
            break
        a, b = g.C[leg], g.C[leg + 1]
        d = b - a
        frac = float(np.clip(np.dot(res["pos"][worst] - a, d) / np.dot(d, d), 0.05, 0.95))
        near = [v for v in g.vias if v["leg"] == leg and abs(v["frac"] - frac) * np.linalg.norm(d) < VIA_SEPARATION_M]
        if near:
            break            # the via already there is at its limit: this line can't be cleared
        g.add_via(leg, frac)
        added.append({"leg": leg, "frac": round(frac, 3)})
        off, rep = lift_for_terrain(ev, g.full(off), window)
    return off, {**rep, "vias": added}


def inside_turn_init(geom, window, frac=0.5):
    """Starting guess: cut every corner toward its inside, frac of the usable window."""
    off = np.zeros((geom.n, 2))
    off[:, 0] = -geom.turn * frac * window * geom.r
    return off


# ------------------------------------------------------------------ attitude + trace
def rate_limit(x, t, rate):
    """Forward-backward slew limiter: |dx/dt| <= rate, symmetric anticipation (rolls in early)."""
    y = np.asarray(x, dtype=float).copy()
    for i in range(1, len(y)):
        lim = rate * (t[i] - t[i - 1])
        y[i] = min(max(y[i], y[i - 1] - lim), y[i - 1] + lim)
    for i in range(len(y) - 2, -1, -1):
        lim = rate * (t[i + 1] - t[i])
        y[i] = min(max(y[i], y[i + 1] - lim), y[i + 1] + lim)
    return y


def attitude(res, perf):
    """heading, pitch, roll (deg) at every dense sample of an evaluated line."""
    terms, v = res["terms"], res["v"]
    T, kap, uperp, up = terms["T"], terms["kap"], terms["uperp"], terms["up"]
    east = np.array([1.0, 0.0, 0.0])
    north = np.cross(up, east)
    east = np.cross(north, up)
    hdg = (np.degrees(np.arctan2(np.einsum("ij,ij->i", T, east), np.einsum("ij,ij->i", T, north))) + 360.0) % 360.0
    f = (v ** 2)[:, None] * kap + rc.G0 * uperp
    right = _unit(np.cross(T, up))
    upp = _unit(np.cross(right, T))
    bank = np.degrees(np.arctan2(np.einsum("ij,ij->i", f, right), np.einsum("ij,ij->i", f, upp)))
    roll = perf.roll_sign * rate_limit(bank, res["t"], perf.roll_rate)
    n = np.linalg.norm(f, axis=1) / rc.G0
    gamma = np.degrees(np.arcsin(np.clip(terms["sing"], -1, 1)))
    pitch = gamma + np.clip(AOA_DEG_PER_G * n, 0.0, AOA_MAX_DEG)
    return hdg, pitch, roll


def js_round(x, dp):
    """race.js qFixed(): Math.round (half up), not Python's banker's rounding."""
    f = 10.0 ** dp
    return math.floor(x * f + 0.5) / f


def build_trace(res, geom, perf):
    """Dense evaluated line -> trace samples [t, lat, lon, alt, hdg, pitch, roll] at 4 Hz from t = 0
    (leaving the start sphere) through time_ms (finish contact) plus one sample POST_FINISH_MS on,
    quantised like race.js traceQuantize, plus the splits (ms) and the time (ms)."""
    t = res["t"] - res["t0"]
    total = res["times"][-1] - res["t0"]
    time_ms = int(round(total * 1000))
    splits = [int(round((x - res["t0"]) * 1000)) for x in res["times"]]
    splits[-1] = time_ms
    ts = np.arange(0, time_ms, TRACE_DT_MS, dtype=float)
    ts = np.append(ts, time_ms) if time_ms - ts[-1] > 0 else ts
    ts = np.append(ts, time_ms + POST_FINISH_MS)
    tq = ts / 1000.0
    pos = np.column_stack([np.interp(tq, t, res["pos"][:, k]) for k in range(3)])
    lat, lon, alt = geom.frame.to_lla(pos)
    hdg, pitch, roll = attitude(res, perf)
    hu = np.degrees(np.unwrap(np.radians(hdg)))
    h = np.interp(tq, t, hu) % 360.0
    p = np.interp(tq, t, pitch)
    r = np.interp(tq, t, roll)
    rows = []
    for i in range(len(ts)):
        rows.append([int(round(ts[i])), js_round(float(lat[i]), 6), js_round(float(lon[i]), 6), js_round(float(alt[i]), 1),
                     js_round(float(h[i]) % 360.0, 1) % 360.0, js_round(float(p[i]), 1), js_round(float(r[i]), 1)])
    return rows, splits, time_ms


def terrain_at_samples(rows, source):
    """Terrain height at every trace sample, straight from TerrariumSource.height (not the
    optimizer's grid): the verifier's AGL check sidecar."""
    if source is None:
        return None
    return [round(float(source.height(r[1], r[2])), 1) for r in rows]


# ------------------------------------------------------------------ one course
def fly_line(geom, perf, off, terrain, min_agl, final_ds=5.0):
    ev = Evaluator(geom, perf, terrain, min_agl)
    return ev.run(off, ds=min(final_ds, ev.ds), detail=True)


def course_is_eligible(meta, envelopes):
    """(ok, reason). Air-start courses flown in an aircraft that has an envelope."""
    if meta.get("error"):
        return False, "race.js rejected the course: " + meta["error"]
    if envelopes.get(meta["aircraftId"]) is None:
        return False, f"no envelope for aircraft {meta['aircraftId']}"
    if meta.get("startType") != "air" or not meta.get("spawn"):
        return False, "ground start: the solo-spawn entry model is air-start only"
    return True, ""


def main(argv=None):
    import rival_personas as rp
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--course", action="append", default=[], help="course id (repeatable)")
    ap.add_argument("--all", action="store_true", help="every course with an envelope")
    ap.add_argument("--cap-s", type=float, default=30.0, help="optimizer runtime cap per persona (s)")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--personas", default=str(rc.RIVALS_DIR / "personas.json"))
    ap.add_argument("--calibrate", action="store_true", help="fit envelopeFrac per persona to human records first")
    ap.add_argument("--offline", action="store_true", help="no network: cached server data only")
    ap.add_argument("--no-terrain", action="store_true", help="skip terrain (tests / dry runs only)")
    args = ap.parse_args(argv)
    return rp.run(args)


if __name__ == "__main__":
    sys.exit(main())
