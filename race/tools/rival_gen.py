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
  * Terrain: every sample >= its floor above Terrarium terrain, as a steep penalty inside the
    objective (race/tools/check_terrain.py's TerrariumSource, tiles cached in race/rivals/cache/).
    The floor is minAglM (60 m) everywhere except near a gate the course itself puts lower: there
    it is that gate's own centre AGL less GATE_FLOOR_SLACK_M, ramping back to minAglM over
    GATE_FLOOR_RAMP_M (gate_floor_m / floor_profile; rival_verify.js applies the same rule). A
    course that puts a gate 40 m over a river can't make flying through it illegal.
  * Feasibility: the load factor the line needs is checked against the FULL envelope's n_inst(v)
    (the verifier's limit) at every sample. A turn too tight for any speed the envelope covers
    used to be flown at the 50 m/s floor at 30-50 g; now it's a steep penalty the search has to
    remove, by widening the line through via points.
  * Vias: free control points between gates (plan_route), placed where the line hits the terrain
    floor or needs an impossible turn, searched laterally AND vertically (a grid over the plane
    across the leg, then local descent), several per leg if needed, and past a hairpin gate
    (an overshoot via, for a teardrop turn) where the turn itself is the problem.
  * Ground start (GROUND_START): the clock still starts leaving gate 0's sphere; the entry model
    is a standing start at gate 0's centre, full-throttle roll straight toward gate 1.
  * Search: seeded coordinate descent over the crossing offsets, with a runtime cap per persona.
  * Attitude: heading from the path, bank = direction of the normal specific force (roll-rate
    limited), pitch = flight-path angle + a small AoA term.

Personas and the ratio ladder: race/tools/rival_personas.py. Verification: race/tools/rival_verify.js.

Usage:
  python rival_gen.py --all --jobs 4        # every F-16 course -> race/rivals/.pending/<id>.json
  python rival_gen.py --course gorge-run    # one course
  then: node rival_verify.js --write        # the judge: writes race/rivals/<id>.json for passes
"""
from __future__ import annotations

import argparse
import copy
import math
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import rival_common as rc  # noqa: E402

GENERATOR_VERSION = "rival-gen-2"
TRACE_DT_MS = 250            # CONFIG.TRACE_HZ = 4
MIN_TRACE_DT_MS = 50         # no two trace samples closer than this (see build_trace)
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
VIA_SEPARATION_M = 400.0     # a second via on the same leg only this far from the first
VIA_FRAC_RANGE = (-0.6, 1.6)  # a via may sit past either end of its leg's chord (an overshoot)
OVERSHOOT_FRAC = -0.35       # a hairpin's overshoot via: this far PAST the gate, along the outgoing chord
# Via grid search (plan_route): lateral x vertical offsets tried for a new via before local descent.
VIA_GRID_LAT_M = (0.0, 150.0, -150.0, 300.0, -300.0, 600.0, -600.0, 1000.0, -1000.0, 1600.0, -1600.0, 2500.0, -2500.0)
VIA_GRID_UP_M = (0.0, 60.0, 150.0, 300.0, 600.0, 1000.0, 1600.0)
MAX_VIAS = 16
# Terrain floor near a gate the course puts below minAglM (see the module docstring).
GATE_FLOOR_SLACK_M = 5.0
GATE_FLOOR_RAMP_M = 1000.0
# The load factor a line needs over G_SAFETY_FRAC x the full envelope's n_inst(v): s per g^2 per m.
G_PENALTY_S_PER_G2_M = 20.0         # steep: 0.1 g over for 50 m costs 10 s, so a residual excess never buys lap time
# rival_verify.js PHYS_TOL: the generator never ships a line the dense model already says is over
# the envelope by more than the judge's own tolerance; inside it, rival_verify.js decides.
SHIP_G_TOL = 1.02
GROUND_START = True          # ground-start courses get a standing-start entry model


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
        # Ground start: a standing start at gate 0's centre, rolling straight at gate 1 (the clock
        # starts on leaving gate 0's sphere, as for every course). Air start: race.js's solo spawn.
        self.ground = meta.get("startType") == "ground"
        if self.ground:
            self.spawn = self.C[0].copy()
            self.v0 = 0.0
            up0 = up_of(self.spawn[None])[0]
            d = self.C[1] - self.C[0]
        else:
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

    def copy(self):
        """Same course, own via list: a persona that needs extra vias adds them to its own copy."""
        g = copy.copy(self)
        g.vias = list(self.vias)
        return g

    def waypoint_rows(self):
        """path_rows() as flown: a ground start's gate 0 is the standing start itself (its centre),
        so its crossing is not a separate waypoint."""
        rows = self.path_rows()
        return rows[1:] if self.ground else rows

    def waypoints(self, off):
        Q = self.points(off)[self.waypoint_rows()]
        # a ground start's lead point is gate 0's sphere exit: the roll (and the spline's small
        # undershoot on it) stays inside the un-raced start sphere, and the climb is free after it
        lead = self.spawn + (self.r[0] if self.ground else LEAD_POINT_M) * self.spawn_dir
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


def v_limit(terms, perf, iters=14, grid=28):
    """Max speed at each sample: the turn needs no more than n_allow(v) at EVERY speed from the
    envelope's floor up to it, and v <= Vmax(alt).

    Downward-closed on purpose. n_inst(v) jumps (3.9 g at 130 m/s, 7.8 g at 150 m/s), so a corner
    can be feasible at low speed, infeasible just above, and feasible again near corner speed. The
    accel/decel passes only ever lower a sample's speed below this limit, so a limit on the upper
    island let them leave a sample inside the infeasible gap (devils-lake-bluffs: 1.1 g over). And
    a plain bisection landed on whichever boundary its midpoints hit, which flipped with the
    persona's pace (eidfjord-voringsfossen: 25 s between envelopeFrac 0.88 and 0.90). So an
    ascending speed grid finds the first infeasible bin and a bisection refines below it.

    The floor is perf.vc[0] (the envelope's lowest speed bin), not an arbitrary near-zero value:
    below that speed n_allow(v) is a flat extrapolation (np.interp clamps), so the load-factor
    constraint becomes almost trivially satisfiable near v=0 (gravity alone gives n=1) and would
    otherwise return a physically meaningless crawl speed the envelope says nothing about."""
    vcap = perf.vmax(terms["alt"])
    kap, up = terms["kap"], terms["uperp"]
    vmin = float(perf.vc[0])
    allow = lambda v: G_SAFETY_FRAC * perf.n_allow(v)  # noqa: E731 — see G_SAFETY_FRAC
    span = np.maximum(vcap - vmin, 0.0)
    lo = np.full(len(vcap), vmin)
    hi = vcap.copy()
    open_ = np.ones(len(vcap), dtype=bool)           # no infeasible grid speed found yet
    for k in range(1, grid):                         # grid[0] = vmin: the floor, returned if all else fails
        v = vmin + (k / (grid - 1)) * span
        bad = open_ & (load_factor(v, kap, up) > allow(v))
        hi = np.where(bad, v, hi)
        lo = np.where(open_ & ~bad, v, lo)
        open_ &= ~bad
    for _ in range(iters):
        mid = 0.5 * (lo + hi)
        ok = load_factor(mid, kap, up) <= allow(mid)
        lo = np.where(ok & ~open_, mid, lo)
        hi = np.where(ok | open_, hi, mid)
    return np.where(open_, vcap, lo)


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
    # A standing (ground) start begins below VMIN and rolls up to it on full throttle; the VMIN
    # floor applies from the moment the roll reaches it. Every air start begins at or above it.
    v[0] = max(vmin, min(v0, vl[0])) if v0 >= vmin else max(0.0, v0)
    for i in range(n - 1):
        vi = v[i]
        v2 = vi * vi
        n2 = (v2 * v2 * kap2[i] + 2 * v2 * g * kup[i] + g * g * up2[i]) / (g * g)
        a = fr * (look(acc_t, vi) - look(kd_t, vi) * max(n2 - 1.0, 0.0)) - g * sing[i]
        w = v2 + 2 * a * ds[i]
        if vi < vmin:                                  # still on the take-off roll
            vn = math.sqrt(max(w, 0.0))
        else:
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


# ------------------------------------------------------------------ terrain floor
def gate_floor_m(gate_agl_m, min_agl):
    """The floor right at a gate: min_agl, or the gate centre's own AGL less GATE_FLOOR_SLACK_M
    where the course puts the gate lower than that (never below 0). Flying through a gate at its
    centre height is never under the floor."""
    return np.clip(np.minimum(float(min_agl), np.asarray(gate_agl_m, dtype=float) - GATE_FLOOR_SLACK_M), 0.0, float(min_agl))


def floor_profile(lat, lon, glat, glon, grad, gfloor, min_agl):
    """Terrain floor (m AGL) at each (lat, lon): min_agl, lowered near a low gate to its
    gate_floor_m, ramping back linearly from the gate's radius out to radius + GATE_FLOOR_RAMP_M
    of horizontal distance. Horizontal distance is equirectangular about the gate: race/tools/
    rival_verify.js computes exactly the same thing, so the generator and the judge agree."""
    lat = np.asarray(lat, dtype=float)
    lon = np.asarray(lon, dtype=float)
    out = np.full(lat.shape, float(min_agl))
    low = np.nonzero(np.asarray(gfloor, dtype=float) < float(min_agl))[0]
    k = EARTH_R * math.pi / 180.0
    for j in low:
        dx = (lon - glon[j]) * math.cos(math.radians(glat[j])) * k
        dy = (lat - glat[j]) * k
        ramp = np.clip((np.hypot(dx, dy) - grad[j]) / GATE_FLOOR_RAMP_M, 0.0, 1.0)
        out = np.minimum(out, gfloor[j] + (float(min_agl) - gfloor[j]) * ramp)
    return out


# ------------------------------------------------------------------ evaluate a line
class Evaluator:
    """time(offsets) for one course + persona performance, with terrain, g-feasibility and
    gate-miss penalties. min_agl is the course-wide floor (the gate-altitude rule lowers it near
    low gates); margin is added on top everywhere (the optimizer aims a little above the floor)."""

    def __init__(self, geom, perf, terrain=None, min_agl=60.0, ds=None, margin=0.0):
        self.g = geom
        self.perf = perf
        self.terrain = terrain
        self.min_agl = float(min_agl)
        self.margin = float(margin)
        self.ds = ds or float(np.clip(0.6 * geom.r.min(), 5.0, 20.0))
        self.evals = 0
        self.vc = np.asarray(perf.env["v_centers"], dtype=float)
        self.n_full = np.asarray(perf.env["n_inst"], dtype=float)
        self.gates_lla = geom.frame.to_lla(geom.C)
        if terrain is not None:
            glat, glon, galt = self.gates_lla
            self.gate_terrain = self._heights(glat, glon)
            self.gate_floor = gate_floor_m(galt - self.gate_terrain, self.min_agl)
        else:
            self.gate_terrain = None
            self.gate_floor = np.full(geom.n, self.min_agl)

    def _heights(self, lat, lon):
        return self.terrain(lat, lon) if callable(self.terrain) else self.terrain.heights(lat, lon)

    def ground(self, pos):
        if self.terrain is None:
            return np.full(len(pos), -1e9)
        lat, lon, _ = self.g.frame.to_lla(pos)
        return self._heights(lat, lon)

    def floor(self, pos):
        """The terrain floor (no margin) at each point."""
        if self.terrain is None:
            return np.full(len(pos), self.min_agl)
        lat, lon, _ = self.g.frame.to_lla(pos)
        glat, glon, _ = self.gates_lla
        return floor_profile(lat, lon, glat, glon, self.g.r, self.gate_floor, self.min_agl)

    def run(self, off, ds=None, detail=False):
        self.evals += 1
        P = self.g.waypoints(off)
        pos, d1, d2, knots = natural_spline(P, ds or self.ds)
        terms = path_terms(pos, d1, d2)
        v, t = speed_profile(terms, self.perf, self.g.v0)
        t0, times = gate_times(pos, t, self.g.C, self.g.r)
        missed = sum(1 for x in times if x is None) + (t0 is None)
        if self.terrain is not None:
            lat, lon, _ = self.g.frame.to_lla(pos)
            agl = terms["alt"] - self._heights(lat, lon)
            glat, glon, _ = self.gates_lla
            floor = floor_profile(lat, lon, glat, glon, self.g.r, self.gate_floor, self.min_agl)
        else:
            agl = np.full(len(pos), 1e9)
            floor = np.full(len(pos), self.min_agl)
        # only the part from the start gate on is raced; before that is the spawn run-in, which
        # still has to clear terrain but by the course's own start-corridor rules, not ours. A
        # ground start's "run-in" is gate 0's own centre: the raced part begins leaving its sphere.
        k0 = knots[2]
        if t0 is not None:
            k0 = min(k0, int(np.searchsorted(t, t0)))
        # ...and it ends at the finish: the trace carries one sample POST_FINISH_MS on, the model's
        # run-out past that is never raced or shipped (a finish gate by a hillside isn't a crash)
        k1 = len(pos)
        if not missed and times:
            k1 = max(k0 + 1, min(len(pos), int(np.searchsorted(t, times[-1] + 2 * POST_FINISH_MS / 1000.0)) + 1))
        agl, floor = agl[:k1], floor[:k1]
        deficit = np.maximum(0.0, floor[k0:] + self.margin - agl[k0:])
        # the load factor this line needs vs the FULL envelope (the verifier's limit, not the
        # persona's share): a turn no speed can make shows up here, not as a silent 50 m/s crawl
        n_need = load_factor(v, terms["kap"], terms["uperp"])[:k1]
        excess = np.maximum(0.0, n_need[k0:] - G_SAFETY_FRAC * np.maximum(1.0, np.interp(v[k0:k1], self.vc, self.n_full)))
        seg = np.append(terms["ds"], terms["ds"][-1:] if len(terms["ds"]) else [0.0])[k0:k1]
        pen_agl = AGL_PENALTY_S_PER_M2 * float(np.sum(deficit ** 2))
        pen_g = G_PENALTY_S_PER_G2_M * float(np.sum(excess ** 2 * seg))
        pen = pen_agl + pen_g + MISS_PENALTY_S * missed
        total = (times[-1] - t0) if not missed else MISS_PENALTY_S * 10
        cost = total + pen
        if not detail:
            return cost
        clear = agl[k0:] - floor[k0:]
        return {"cost": cost, "time_s": total, "t0": t0, "times": times, "missed": missed, "pos": pos,
                "terms": terms, "v": v, "t": t, "agl": agl, "floor": floor, "knots": knots, "k0": k0,
                "penalty_s": pen, "penalty_agl_s": pen_agl, "penalty_g_s": pen_g, "n_need": n_need,
                "deficit": deficit, "g_excess": excess, "seg": seg,
                "k1": k1, "min_agl_m": float(agl[k0:].min()) if len(agl) > k0 else float("nan"),
                "min_clear_m": float(clear.min()) if len(clear) else float("nan"),
                "g_excess_max": float(excess.max()) if len(excess) else 0.0,
                # over the envelope by more than the judge's tolerance: what rival_gen refuses to ship
                "g_over_max": float(np.max(n_need[k0:] - SHIP_G_TOL * np.maximum(1.0, np.interp(v[k0:k1], self.vc, self.n_full)))) if k1 > k0 else 0.0}


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
    rows = np.array(g.waypoint_rows())
    raised = {}
    it = 0
    for it in range(max_iter):
        res = ev.run(off, detail=True)
        k0 = res["k0"]
        deficit = res["deficit"]
        if not len(deficit) or deficit.max() <= 0:
            return off, {"lifted_rows": raised, "iterations": it, "cleared": True}
        worst = k0 + int(np.argmax(deficit))
        step = float(np.clip(0.5 * deficit.max(), step_m, 100.0))
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


def badness(res):
    """Per-sample penalty density (s) from the raced start on: terrain deficit + g excess."""
    return (AGL_PENALTY_S_PER_M2 * res["deficit"] ** 2, G_PENALTY_S_PER_G2_M * res["g_excess"] ** 2 * res["seg"])


def is_clean(res):
    """Clears the floor (with the evaluator's margin) and never needs more than the envelope."""
    return (not len(res["deficit"]) or res["deficit"].max() <= 0) and res["g_excess_max"] <= 0


def _leg_at(g, res, idx):
    """(leg, frac along that leg's chord) of dense sample idx."""
    rows = g.waypoint_rows()
    row_knots = res["knots"][2:2 + len(rows)]
    pos = int(np.searchsorted(row_knots, idx, side="right")) - 1
    if pos < 0:
        leg = 0
    else:
        r = rows[pos]
        leg = r if r < g.n else g.vias[r - g.n]["leg"]
    leg = min(max(leg, 0), g.n - 2)
    a, b = g.C[leg], g.C[leg + 1]
    d = b - a
    frac = float(np.clip(np.dot(res["pos"][idx] - a, d) / max(np.dot(d, d), 1e-9), 0.05, 0.95))
    return leg, frac


def _via_free(g, leg, frac):
    """No via already on this leg within VIA_SEPARATION_M of frac."""
    L = float(np.linalg.norm(g.C[leg + 1] - g.C[leg]))
    return all(v["leg"] != leg or abs(v["frac"] - frac) * L >= VIA_SEPARATION_M for v in g.vias)


def _grid_via(ev, off):
    """Best (cost, offsets) over VIA_GRID for the newest via row (the last row of off)."""
    best = (ev.run(off), off)
    lim = VIA_RANGE_M
    for lat in VIA_GRID_LAT_M:
        for up in VIA_GRID_UP_M:
            if lat == 0.0 and up == 0.0:
                continue
            trial = off.copy()
            trial[-1] = [lat, up]
            trial[-1:] = clamp_offsets(trial[-1:], np.array([lim]))
            c = ev.run(trial)
            if c < best[0] - 1e-9:
                best = (c, trial)
    return best


def _clusters(res, gap=8):
    """Problem spots on an evaluated line, worst first: [(sample index of the worst sample, total
    penalty, g-dominated)]. Samples within `gap` of each other are one spot."""
    b_agl, b_g = badness(res)
    tot = b_agl + b_g
    idx = np.nonzero(tot > 0)[0]
    if not len(idx):
        return []
    out = []
    for c in np.split(idx, np.nonzero(np.diff(idx) > gap)[0] + 1):
        w = c[int(np.argmax(tot[c]))]
        out.append((res["k0"] + int(w), float(tot[c].sum()), bool(b_g[c].sum() >= b_agl[c].sum())))
    return sorted(out, key=lambda x: -x[1])


def _candidates(g, leg, frac, g_dominated):
    """Via placements to try for one problem spot: the spot itself, and for an impossible turn at
    a gate, overshoots past that gate (flown after it, or before it) and a point on the far leg."""
    cands = [(leg, frac)]
    if g_dominated:
        k = leg if frac < 0.5 else leg + 1            # the gate the impossible turn is at
        if k < g.n - 1:
            cands += [(k, OVERSHOOT_FRAC), (k, 2 * OVERSHOOT_FRAC), (k, 0.15), (k, 0.3)]
        if k >= 1:
            cands += [(k - 1, 1.0 - OVERSHOOT_FRAC), (k - 1, 1.0 - 2 * OVERSHOOT_FRAC), (k - 1, 0.85), (k - 1, 0.7)]
    seen, out = set(), []
    for c in cands:
        key = (c[0], round(c[1], 3))
        if key not in seen and 0 <= c[0] < g.n - 1 and VIA_FRAC_RANGE[0] <= c[1] <= VIA_FRAC_RANGE[1]:
            seen.add(key)
            out.append(c)
    return out


def _polish(ev, window, off, fixed, cap_s, seed, min_step_frac=0.005):
    """Local descent over the free rows; on a fixed-gate line (STEVE/BRAT) the gate crossings then
    get a vertical-only pass too: lift_for_terrain's freedom (up or down inside the window), never
    a lateral move."""
    off, _ = optimize(ev, window, init=off, cap_s=cap_s, fixed=fixed, seed=seed, min_step_frac=min_step_frac)
    if fixed:
        off, _ = optimize(ev, window, init=off, cap_s=cap_s / 2, fixed=[], seed=seed + 1, min_step_frac=min_step_frac, dims=(1,))
    return off


def plan_route(ev, off, window, fixed_gates=True, max_vias=MAX_VIAS, polish_s=4.0, spots=4):
    """Make a line clean (is_clean) by (1) lifting crossings, then (2) adding via points where it
    still hits the terrain floor or needs a turn the envelope can't make. Problem spots are taken
    worst first (up to `spots` of them per round); for each, a new via is tried at the spot's point
    on its leg, and for an impossible turn at a gate, past that gate (an overshoot via, flown just
    after it or just before it: a teardrop turn) or on the far leg. Each candidate is searched over
    a lateral x vertical grid across its leg (VIA_GRID_*); the best that lowers the cost is kept
    and every via is then polished by local descent. Several vias per leg are allowed
    (VIA_SEPARATION_M apart). fixed_gates: the gate crossings never move (STEVE/BRAT); otherwise
    the polish moves them too, inside window. Adds to ev.g.vias. Returns (offsets, report)."""
    g = ev.g
    t_start = time.monotonic()
    off = g.full(np.asarray(off, dtype=float)).copy()
    off, lift = lift_for_terrain(ev, off, window)
    fixed = list(range(g.n)) if fixed_gates else []
    added = []
    stall = None
    while g.m < max_vias:
        res = ev.run(off, detail=True)
        if is_clean(res):
            break
        cost0 = res["cost"]
        kept = False
        for idx, _, g_dom in _clusters(res)[:spots]:
            leg, frac = _leg_at(g, res, idx)
            best = None
            for c_leg, c_frac in _candidates(g, leg, frac, g_dom):
                if not _via_free(g, c_leg, c_frac):
                    continue
                g.add_via(c_leg, c_frac)
                c, trial = _grid_via(ev, np.vstack([off, [[0.0, 0.0]]]))
                g.vias.pop()
                if best is None or c < best[0]:
                    best = (c, trial, c_leg, c_frac)
            if best is None:
                continue
            # A teardrop needs two vias to move together: judge the new one only after every via
            # (and, for a free line, every gate) has re-settled around it.
            g.add_via(best[2], best[3])
            trial = _polish(ev, window, best[1], fixed, polish_s, len(added) + 1)
            if ev.run(trial) < cost0 - 1e-3:
                off, kept = trial, True
                added.append({"leg": best[2], "frac": round(best[3], 3)})
                break
            g.vias.pop()
        if not kept:
            stall = "no new via placement improves the line"
            break
    res = ev.run(off, detail=True)
    if not is_clean(res) and g.m:
        off = _polish(ev, window, off, fixed, 4 * polish_s, 99, min_step_frac=0.002)
        res = ev.run(off, detail=True)
    return off, {"lift": lift, "vias": added, "clean": is_clean(res), "stall": stall,
                 "min_clear_m": round(res["min_clear_m"], 1), "g_excess_max": round(res["g_excess_max"], 2),
                 "seconds": round(time.monotonic() - t_start, 1)}


def plan_vias(ev, window=MAX_USABLE_WINDOW, max_vias=MAX_VIAS):
    """The shared route for a course: the gate-centre line made clean by plan_route, from no vias.
    Every persona starts from these vias (each at its own offsets). Returns (offsets, report)."""
    g = ev.g
    g.vias = []
    off, rep = plan_route(ev, np.zeros((g.n, 2)), window, fixed_gates=True, max_vias=max_vias)
    return off, {**rep, "cleared": rep["clean"]}


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
    # never a sliver between the last 4 Hz sample and the finish: race.js quantizes roll to 0.1 deg,
    # and 0.1-2 deg over 10 ms reads as a 200 deg/s roll (kenai-fjords-exit-glacier BRAT)
    if len(ts) > 1 and 0 < time_ms - ts[-1] < MIN_TRACE_DT_MS:
        ts[-1] = time_ms - MIN_TRACE_DT_MS
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
    """(ok, reason). Courses flown in an aircraft that has an envelope: air starts from race.js's
    solo spawn, ground starts from a standing start at gate 0 (GROUND_START)."""
    if meta.get("error"):
        return False, "race.js rejected the course: " + meta["error"]
    if envelopes.get(meta["aircraftId"]) is None:
        return False, f"no envelope for aircraft {meta['aircraftId']}"
    if len(meta.get("course", {}).get("gates") or []) < 2:
        return False, "fewer than 2 gates"
    if meta.get("startType") != "air" and not GROUND_START:
        return False, "ground start: GROUND_START is off"
    if meta.get("startType") == "air" and not meta.get("spawn"):
        return False, "air start with no solo spawn"
    return True, ""


def main(argv=None):
    import rival_personas as rp
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--course", action="append", default=[], help="course id (repeatable)")
    ap.add_argument("--all", action="store_true", help="every course with an envelope")
    ap.add_argument("--cap-s", type=float, default=30.0, help="optimizer runtime cap per persona (s)")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--personas", default=str(rc.RIVALS_DIR / "personas.json"))
    ap.add_argument("--jobs", type=int, default=1, help="courses generated in parallel (processes)")
    ap.add_argument("--no-terrain", action="store_true", help="skip terrain (tests / dry runs only)")
    args = ap.parse_args(argv)
    return rp.run(args)


if __name__ == "__main__":
    sys.exit(main())
