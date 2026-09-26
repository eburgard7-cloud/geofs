"""Rival personas (race/rivals/personas.json), the ratio ladder, and the generator's run loop
(race/tools/rival_gen.py's CLI lands here).

Personas are global knobs, never per-course tuning:
  STEVE  flies every gate centre                                           (line "centre")
  BRAT   halfway to DAWG's optimal line, runs wide on N seeded gates per lap (line "half")
  MOO    fully optimized inside gateWindow 0.6                             (line "optimal")
  DAWG   fully optimized inside gateWindow 0.7 -- never the outer 30%      (line "optimal")

The ladder (personas.json "ladder"): DAWG is the optimizer's best line at its own fixed persona
(envelopeFrac 0.98). Every other persona is anchored to DAWG's time on the same course: target =
DAWG time x ONE global ratio per persona (ladder.ratios; never per course). Per course, with the
persona's line held fixed, solve_pace() bisects its pace so the model time lands on the target:
first speedCap (top speed only) at the persona's default envelopeFrac, and only if even speedCap
1.0 is too slow, envelopeFrac up to DAWG's. The solved envelopeFrac/speedCap are derived, not
tuned: they go in race/rivals/ladder.json and the report. rival_verify.js still times the result.
"""
from __future__ import annotations

import hashlib
import json
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import rival_common as rc  # noqa: E402
import rival_gen as R  # noqa: E402

AGL_MARGIN_M = 5.0        # optimize to the floor + this: the terrain penalty is soft, the floor is not
LADDER_ORDER = ("moo", "brat", "steve")   # fastest to slowest after DAWG
MIN_RUNG_STEP = 1.02      # a rung is never less than 2% slower than the rung above it
FINAL_DS_M = 5.0          # rival_gen.fly_line's resolution: the line that ships


def load_personas(path=None):
    p = Path(path) if path else rc.RIVALS_DIR / "personas.json"
    return json.loads(p.read_text(encoding="utf-8"))


def by_id(cfg):
    return {p["rival_id"]: p for p in cfg["personas"]}


# ------------------------------------------------------------------ the ladder's pace solver
def solve_pace(time_at, target_s, frac0, frac_hi, cap_lo=0.3, frac_lo=0.4, tol=0.003, iters=40, switches=4):
    """Pace (envelopeFrac, speedCap) whose time_at(frac, cap) lands within tol (relative) of
    target_s. time_at is non-increasing in both, but NOT continuous: a corner's feasible speed can
    jump between two islands of the envelope (rival_gen.v_limit), so a time can sit in a gap one
    knob can't reach. Three monotone stages pick the first knob:
      A  speedCap in [cap_lo, 1] at frac0            (slower: top speed only)
      B  envelopeFrac in [frac0, frac_hi] at cap 1   (faster, never past DAWG's frac)
      C  envelopeFrac in [frac_lo, frac0] at cap_lo  (slower still: a turn-bound course, where top
                                                      speed alone can't slow it enough)
    If that knob's bisection closes on a jump instead of the target, the fast side of the jump is
    kept and the OTHER knob is bisected from there toward slower (up to `switches` times): the gaps
    of the two knobs are in different places. Every evaluation is at the 4-dp values it returns,
    so the pace that ships is exactly the pace that was timed. Returns {envelopeFrac, speedCap,
    time_s, clamped: None|'high'|'low'|'gap', stage, evals}: 'high' when even (frac_hi, 1) is
    slower than the target, 'low' when even (frac_lo, cap_lo) is faster, 'gap' when no knob lands
    within tol (the closest pace tried is returned)."""
    evals = [0]
    seen = {}

    def f(fr, cap):
        key = (round(fr, 4), round(cap, 4))
        if key not in seen:
            evals[0] += 1
            seen[key] = time_at(*key)
        return seen[key]

    def hit(t):
        return abs(t - target_s) <= tol * target_s

    def out(fr, cap, stage, clamped=None):
        return {"envelopeFrac": round(fr, 4), "speedCap": round(cap, 4), "time_s": f(fr, cap), "clamped": clamped,
                "stage": stage, "evals": evals[0]}

    def bisect(lo, hi, t_of):
        """t_of non-increasing on [lo, hi], t_of(lo) >= target >= t_of(hi). Returns (x, converged):
        the hit, or the fast side of the jump the bracket closed on."""
        a, b = lo, hi
        for _ in range(iters):
            m = round(0.5 * (a + b), 4)
            if m in (round(a, 4), round(b, 4)):
                break
            t = t_of(m)
            if hit(t):
                return m, True
            a, b = (m, b) if t > target_s else (a, m)
        return b, False

    t1 = f(frac0, 1.0)
    if hit(t1):
        return out(frac0, 1.0, "none")
    if t1 < target_s:
        if f(frac0, cap_lo) >= target_s:
            fr, cap, knob, stage = frac0, None, "cap", "A"
            x, conv = bisect(cap_lo, 1.0, lambda c: f(frac0, c))
            cap = x
        else:
            if f(frac_lo, cap_lo) < target_s:
                return out(frac_lo, cap_lo, "C", "low")
            cap, knob, stage = cap_lo, "frac", "C"
            fr, conv = bisect(frac_lo, frac0, lambda x: f(x, cap_lo))
    else:
        if f(frac_hi, 1.0) > target_s:
            return out(frac_hi, 1.0, "B", "high")
        cap, knob, stage = 1.0, "frac", "B"
        fr, conv = bisect(frac0, frac_hi, lambda x: f(x, 1.0))
    for _ in range(switches):
        if conv:
            return out(fr, cap, stage)
        # (fr, cap) is the fast side of a jump: slow down with the other knob from here
        if knob == "frac":
            if f(fr, cap_lo) < target_s:
                break
            knob, stage = "cap", stage + "+cap"
            cap, conv = bisect(cap_lo, cap, lambda c, fr=fr: f(fr, c))
        else:
            if f(frac_lo, cap) < target_s:
                break
            knob, stage = "frac", stage + "+frac"
            fr, conv = bisect(frac_lo, fr, lambda x, cap=cap: f(x, cap))
    if conv:
        return out(fr, cap, stage)
    # Last resort: rows of envelopeFrac (nearest the persona's own first), speedCap bisected in
    # each row that straddles the target. Jumps sit at different speedCaps in different rows.
    rows = sorted({round(frac_lo + k * (frac_hi - frac_lo) / 12, 4) for k in range(13)}, key=lambda x: abs(x - frac0))
    for fr in rows:
        if f(fr, cap_lo) >= target_s >= f(fr, 1.0):
            cap, conv = bisect(cap_lo, 1.0, lambda c, fr=fr: f(fr, c))
            if conv:
                return out(fr, cap, stage + "+rows")
    (fr, cap), _ = min(seen.items(), key=lambda kv: abs(kv[1] - target_s))
    return out(fr, cap, stage, "gap")


def ladder_targets(dawg_s, ratios):
    """{rival_id: target seconds} from DAWG's time and the global ratio table."""
    return {rid: dawg_s * float(ratios[rid]) for rid in LADDER_ORDER}


# ------------------------------------------------------------------ lines per persona
def wide_gates(geom, per_lap, seed_key):
    """Route gate indices BRAT runs wide on: `per_lap` per lap, seeded by the course (stable across
    runs), never the start gate or the finish, turning gates first."""
    h = int(hashlib.sha256(seed_key.encode("utf-8")).hexdigest()[:8], 16)
    rng = np.random.default_rng(h)
    out = []
    for lap in range(geom.laps):
        idx = [i for i in range(1, geom.n - 1) if geom.lap_of[i] == lap]
        turning = [i for i in idx if geom.turn[i] != 0]
        pool = turning if len(turning) >= per_lap else idx
        if not pool:
            continue
        out.extend(sorted(rng.choice(pool, size=min(per_lap, len(pool)), replace=False).tolist()))
    return out


def brat_offsets(geom, optimal, persona, seed_key):
    """Halfway to the optimal line, then wide (outside of the turn, wideOffset x radius) on the
    seeded gates."""
    off = geom.full(np.asarray(optimal, dtype=float)).copy()
    off[:geom.n] *= 0.5                 # gates halfway; vias (terrain) stay where the optimal line has them
    wide = wide_gates(geom, int(persona.get("wideGatesPerLap", 2)), seed_key)
    for i in wide:
        side = geom.turn[i] if geom.turn[i] != 0 else 1.0
        off[i] = [side * float(persona.get("wideOffset", 0.8)) * geom.r[i], 0.0]
    return R.clamp_offsets(off, geom.limits(window_of(persona))), wide


def window_of(persona):
    """The usable fraction of each gate radius (never past rival_gen.MAX_USABLE_WINDOW)."""
    return min(float(persona.get("gateWindow", 1.0)), R.MAX_USABLE_WINDOW)


def persona_perf(env, persona, frac=None, cap=None):
    return R.Perf(env, persona["envelopeFrac"] if frac is None else frac, persona.get("speedCap", 1.0) if cap is None else cap)


def _ev(geom, env, persona, terrain, min_agl):
    return R.Evaluator(geom, persona_perf(env, persona), terrain, min_agl, margin=AGL_MARGIN_M)


def repair(ev, off, window, fixed_gates, cap_s):
    """A persona's line that still hits the floor or needs an impossible turn gets its own vias
    (rival_gen.plan_route, on the persona's own geometry copy). A free line (DAWG/MOO) is then
    re-optimized around them. Returns (offsets, report or None when it was already clean)."""
    if R.is_clean(ev.run(off, detail=True)):
        return off, None
    off, rep = R.plan_route(ev, off, window, fixed_gates=fixed_gates)
    if not fixed_gates and rep["vias"]:
        off, _ = optimize_until(ev, window, off, max(2.0, cap_s / 2), 97)
        rep["clean_after_reoptimize"] = R.is_clean(ev.run(off, detail=True))
    return off, rep


def optimize_until(ev, window, init, cap_s, seed, passes=3):
    """rival_gen.optimize, re-run from its own result (fresh step size) until a pass converges or
    gains under 5 ms, at most `passes` times: one capped pass left long courses far from their
    best line (willamette-gauntlet's DAWG: 91 s after one pass, 64 s after three)."""
    off, rep = R.optimize(ev, window, init=init, cap_s=cap_s, seed=seed)
    total = [rep]
    for k in range(1, passes):
        if rep["converged"] and rep["start_cost_s"] - rep["final_cost_s"] < 0.005:
            break
        off, rep = R.optimize(ev, window, init=off, cap_s=cap_s, seed=seed + 10 * k)
        total.append(rep)
    first = dict(total[0])
    first.update({"passes": len(total), "final_cost_s": total[-1]["final_cost_s"], "converged": total[-1]["converged"],
                  "seconds": round(sum(r["seconds"] for r in total), 2), "evals": total[-1]["evals"]})
    return off, first


def plan_lines(geom, env, cfg, terrain, cap_s, seed, min_agl):
    """(offsets, reports, geometries) per persona for one course. First the shared route: the
    gate-centre line made clean (floor + feasible turns) with vias (rival_gen.plan_vias). DAWG is
    optimized from it; MOO starts from DAWG's line; BRAT is half of DAWG's line plus its wide
    gates; STEVE is the route's centre line. Each persona flies its own copy of the geometry, so a
    line that needs one more via (BRAT's wide gates, say) gets it without moving anyone else's."""
    P = by_id(cfg)
    lines, reports, geoms = {}, {}, {}
    geom.vias = []
    dawg = P["dawg"]
    centre, route = R.plan_vias(_ev(geom, env, dawg, terrain, min_agl), R.MAX_USABLE_WINDOW)

    gd = geom.copy()
    w = window_of(dawg)
    ev = _ev(gd, env, dawg, terrain, min_agl)
    init = gd.full(R.inside_turn_init(gd, w))
    init[:, 1] = centre[:, 1]
    init[gd.n:] = centre[gd.n:]
    off, rep = optimize_until(ev, w, init, cap_s, seed)
    off, rep["repair"] = repair(ev, off, w, False, cap_s)
    rep["route"] = route
    lines["dawg"], reports["dawg"], geoms["dawg"] = off, rep, gd

    moo = P["moo"]
    gm = gd.copy()
    w = window_of(moo)
    ev = _ev(gm, env, moo, terrain, min_agl)
    off, rep = optimize_until(ev, w, lines["dawg"], cap_s, seed + 1)
    off, rep["repair"] = repair(ev, off, w, False, cap_s)
    lines["moo"], reports["moo"], geoms["moo"] = off, rep, gm

    # DAWG is the best line there is. MOO's line lies inside DAWG's window, so if it flies faster
    # at DAWG's own pace (the search found a better basin from its start), DAWG takes it over and
    # re-optimizes from there (monument-valley: MOO 86.8 s vs DAWG 93.3 s before this).
    ev_d = _ev(gm.copy(), env, dawg, terrain, min_agl)
    ev_old = _ev(gd, env, dawg, terrain, min_agl)
    if ev_d.run(lines["moo"]) < ev_old.run(lines["dawg"]) - 1e-3:
        w = window_of(dawg)
        off, rep2 = optimize_until(ev_d, w, lines["moo"], cap_s, seed + 2)
        off, rep2["repair"] = repair(ev_d, off, w, False, cap_s)
        reports["dawg"] = {**rep2, "route": route, "adopted_moo_line": True}
        lines["dawg"], geoms["dawg"] = off, ev_d.g

    brat = P["brat"]
    gb = geoms["dawg"].copy()
    off, wide = brat_offsets(gb, lines["dawg"], brat, geom.meta["id"])
    off, fix = repair(_ev(gb, env, brat, terrain, min_agl), off, window_of(brat), True, cap_s)
    lines["brat"], reports["brat"], geoms["brat"] = off, {"line": "half", "wide_gates": wide, "repair": fix}, gb

    steve = P["steve"]
    gs = geom.copy()
    off, fix = repair(_ev(gs, env, steve, terrain, min_agl), gs.full(centre), window_of(steve), True, cap_s)
    lines["steve"], reports["steve"], geoms["steve"] = off, {"line": "centre", "repair": fix}, gs

    # The search samples every ~20 m; the shipped line is built at 5 m. A terrain spike narrower
    # than the coarse step (angkor-tonle-sap: one ~30 m pixel, 60 m high) can sit between coarse
    # samples: re-check every line at the final resolution with the margin, and lift where needed.
    for rid in lines:
        evf = R.Evaluator(geoms[rid], persona_perf(env, P[rid]), terrain, min_agl, ds=FINAL_DS_M, margin=AGL_MARGIN_M)
        res = evf.run(lines[rid], detail=True)
        if len(res["deficit"]) and res["deficit"].max() > 0:
            lines[rid], lift = R.lift_for_terrain(evf, lines[rid], window_of(P[rid]))
            reports[rid] = {**reports[rid], "fine_lift": lift}
            if not lift["cleared"]:                  # out of gate window: vias, at the fine resolution
                lines[rid], rep = R.plan_route(evf, lines[rid], window_of(P[rid]), fixed_gates=rid in ("steve", "brat"))
                reports[rid]["fine_route"] = rep
    return lines, reports, geoms


# ------------------------------------------------------------------ one course
def solve_ladder(geoms, lines, env, cfg, min_agl):
    """{rival_id: (envelopeFrac, speedCap)} plus the ladder report for one course: DAWG at its
    fixed persona, every other rung solved to DAWG time x its global ratio (solve_pace), each
    rung at least MIN_RUNG_STEP slower than the one above it (a rung that can't get fast enough
    pushes the ones below it down, and the report says 'shifted')."""
    P = by_id(cfg)
    lad = cfg["ladder"]
    dawg = P["dawg"]
    paces = {"dawg": (float(dawg["envelopeFrac"]), float(dawg.get("speedCap", 1.0)))}
    dres = R.fly_line(geoms["dawg"], R.Perf(env, *paces["dawg"]), lines["dawg"], None, min_agl)
    rep = {"dawg": {"envelopeFrac": paces["dawg"][0], "speedCap": paces["dawg"][1], "time_s": dres["time_s"]}}
    if dres["missed"]:
        return None, rep
    dawg_s = dres["time_s"]
    targets = ladder_targets(dawg_s, lad["ratios"])
    prev = dawg_s
    for rid in LADDER_ORDER:
        target = max(targets[rid], prev * MIN_RUNG_STEP)

        def time_at(fr, cap, rid=rid):
            return R.fly_line(geoms[rid], R.Perf(env, fr, cap), lines[rid], None, min_agl)["time_s"]

        sol = solve_pace(time_at, target, float(P[rid]["envelopeFrac"]), paces["dawg"][0],
                         cap_lo=float(lad.get("speedCap_min", 0.3)), frac_lo=float(lad.get("envelopeFrac_min", 0.4)),
                         tol=float(lad.get("solve_tolerance", 0.003)))
        paces[rid] = (sol["envelopeFrac"], sol["speedCap"])
        rep[rid] = {**sol, "target_s": round(target, 3), "ratio_target": float(lad["ratios"][rid]),
                    "ratio": round(sol["time_s"] / dawg_s, 4), "shifted": target > targets[rid] * (1 + 1e-9)}
        prev = sol["time_s"]
    return paces, rep


def generate_course(meta, env, cfg, terrain, terrain_src, cap_s=30.0, seed=1):
    """All personas for one course -> the pending file dict (traces encoded by race.js)."""
    min_agl = float(cfg.get("minAglM", 60))
    geom = R.CourseGeom(meta)
    t0 = time.monotonic()
    lines, reports, geoms = plan_lines(geom, env, cfg, terrain, cap_s, seed, min_agl)
    paces, ladder = solve_ladder(geoms, lines, env, cfg, min_agl)
    rivals, failures, raw_traces = [], [], []
    for p in cfg["personas"]:
        rid = p["rival_id"]
        if paces is None:
            failures.append({"rival_id": rid, "reason": "DAWG's line misses a gate: no ladder anchor"})
            continue
        g = geoms[rid]
        perf = R.Perf(env, *paces[rid])
        res = R.fly_line(g, perf, lines[rid], terrain, min_agl)
        if res["missed"]:
            failures.append({"rival_id": rid, "reason": f"model path misses {res['missed']} gate(s)", "convergence": reports.get(rid)})
            continue
        if res["min_clear_m"] < 0:
            failures.append({"rival_id": rid, "reason": f"min AGL {res['min_agl_m']:.0f} m is {-res['min_clear_m']:.0f} m under the floor inside the gate window", "convergence": reports.get(rid)})
            continue
        if res["g_over_max"] > 0:
            failures.append({"rival_id": rid, "reason": f"needs {res['g_over_max']:.1f} g more than the envelope allows (a turn too tight at any speed)", "convergence": reports.get(rid)})
            continue
        rows, splits, time_ms = R.build_trace(res, g, perf)
        terrain_m = R.terrain_at_samples(rows, terrain_src)
        off_r = np.linalg.norm(lines[rid][:g.n], axis=1) / g.r
        rivals.append({
            "rival_id": rid, "name": p["name"], "model": p["model"], "time_ms": time_ms, "splits_ms": splits,
            "envelopeFrac": round(float(perf.frac), 4), "gateWindow": p.get("gateWindow", 1.0), "speedCap": round(float(perf.speed_cap), 4),
            "ladder": ladder.get(rid), "convergence": reports.get(rid), "min_agl_m": round(res["min_agl_m"], 1),
            "min_clear_m": round(res["min_clear_m"], 1), "vias": [{"leg": v["leg"], "frac": round(v["frac"], 3)} for v in g.vias],
            "max_window_used": round(float(off_r.max()), 3),
            "v_max_ms": round(float(res["v"].max()), 1), "n_max": round(float(res["n_need"].max()), 2),
            "terrain_m": terrain_m, "_rows": rows,
        })
        raw_traces.append({"samples": rows, "truncated": False})
    if rivals:
        encoded = rc.node_call({"op": "encode", "traces": raw_traces})
        for r, enc in zip(rivals, encoded):
            r["trace"] = enc
            del r["_rows"]
    gates = meta["course"]["gates"]
    gate_terrain = [round(float(terrain_src.height(gt["lat"], gt["lon"])), 1) for gt in gates] if terrain_src is not None else None
    return {
        "course_id": meta["id"], "course_hash": meta["hash"], "aircraftId": meta["aircraftId"],
        "generator_version": R.GENERATOR_VERSION, "envelope_version": env["envelope_version"],
        "personas_version": cfg.get("version"), "minAglM": min_agl, "laps": geom.laps, "lap_gates": geom.K,
        "startType": meta.get("startType"), "gate_terrain_m": gate_terrain,
        "vias": [{"leg": v["leg"], "frac": round(v["frac"], 3)} for v in geoms["dawg"].vias],
        "ladder": ladder, "seconds": round(time.monotonic() - t0, 1), "rivals": rivals, "failures": failures,
    }


# ------------------------------------------------------------------ CLI
_W = {}


def _json_default(x):
    """numpy scalars/arrays in the diagnostics -> plain JSON."""
    if isinstance(x, np.ndarray):
        return x.tolist()
    if isinstance(x, np.generic):
        return x.item()
    raise TypeError(f"not JSON serializable: {type(x).__name__}")


def _worker_init(no_terrain):
    _W["terrain"], _W["src"] = (None, None) if no_terrain else R.make_terrain()


def _worker(job):
    meta, env, cfg, cap_s, seed = job
    terrain = _W["terrain"].heights if _W.get("terrain") is not None else None
    out = generate_course(meta, env, cfg, terrain, _W.get("src"), cap_s, seed)
    (rc.PENDING_DIR / f"{meta['id']}.json").write_text(json.dumps(out, separators=(",", ":"), default=_json_default), encoding="utf-8")
    times = " ".join(f"{r['name']} {r['time_ms'] / 1000:.1f}" for r in out["rivals"])
    fails = "; ".join(f"{f['rival_id']}: {f['reason']}" for f in out["failures"])
    return f"{meta['id']}: {times}{'  FAIL ' + fails if fails else ''}  ({out['seconds']} s)"


def run(args):
    cfg = load_personas(args.personas)
    courses, cups = rc.load_course_files()
    print(f"loading {len(courses)} courses through race.js ...", flush=True)
    metas = rc.course_metas(courses, cups)
    envs = {}
    for m in metas.values():
        ac = m.get("aircraftId")
        if ac and ac not in envs:
            envs[ac] = rc.load_envelope(ac)
    wanted = args.course or (sorted(metas) if args.all else [])
    if not wanted:
        print("nothing to do: pass --course ID or --all")
        return 2
    selected, skipped = [], []
    for cid in wanted:
        if cid not in metas:
            skipped.append({"course_id": cid, "reason": "no such course"})
            continue
        ok, why = R.course_is_eligible(metas[cid], envs)
        (selected if ok else skipped).append(cid if ok else {"course_id": cid, "aircraftId": metas[cid].get("aircraftId"), "reason": why})
    rc.PENDING_DIR.mkdir(parents=True, exist_ok=True)
    if args.all:
        (rc.PENDING_DIR / "_skipped.json").write_text(json.dumps(skipped, indent=1), encoding="utf-8")
    for sk in skipped:
        print(f"skip {sk['course_id']}: {sk['reason']}", flush=True)
    print(f"{len(selected)} course(s) to generate, {len(skipped)} skipped, {args.jobs} job(s)", flush=True)
    jobs = [(metas[cid], envs[metas[cid]["aircraftId"]], cfg, args.cap_s, args.seed) for cid in selected]
    if args.jobs <= 1:
        _worker_init(args.no_terrain)
        for n, job in enumerate(jobs, 1):
            print(f"[{n}/{len(jobs)}] " + _worker(job), flush=True)
        return 0
    from concurrent.futures import ProcessPoolExecutor
    with ProcessPoolExecutor(args.jobs, initializer=_worker_init, initargs=(args.no_terrain,)) as ex:
        for n, line in enumerate(ex.map(_worker, jobs), 1):
            print(f"[{n}/{len(jobs)}] " + line, flush=True)
    return 0
