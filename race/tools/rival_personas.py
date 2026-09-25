"""Rival personas (race/rivals/personas.json), calibration against human records, and the
generator's run loop (race/tools/rival_gen.py's CLI lands here).

Personas are global knobs, never per-course tuning:
  STEVE  flies every gate centre, speedCap 0.85                       (line "centre")
  BRAT   halfway to DAWG's optimal line, runs wide on N seeded gates per lap (line "half")
  MOO    fully optimized inside gateWindow 0.6                         (line "optimal")
  DAWG   fully optimized inside gateWindow 0.7 -- never the outer 30%  (line "optimal")

Calibration (--calibrate): on courses with a human record (current course hash, record holder's
trace passes the envelope's jet check), fit ONE envelopeFrac per persona so the median of rival
time / record hits that persona's target. With the line held at the persona's own optimized
offsets, only the speed profile depends on envelopeFrac, so the fit is a bisection over a cheap,
monotone function. Fewer than calibration.min_records usable courses: defaults are kept.
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


def load_personas(path=None):
    p = Path(path) if path else rc.RIVALS_DIR / "personas.json"
    return json.loads(p.read_text(encoding="utf-8"))


def by_id(cfg):
    return {p["rival_id"]: p for p in cfg["personas"]}


# ------------------------------------------------------------------ calibration maths
def median_ratio(time_fn, records, frac):
    """Median over record courses of rival time at `frac` / human record."""
    return float(np.median([time_fn(cid, frac) / rec for cid, rec in records]))


def calibrate_frac(time_fn, records, target, lo=0.3, hi=1.0, iters=40):
    """envelopeFrac such that median(time_fn(course, frac) / record) == target.

    time_fn(course_id, frac) -> seconds, non-increasing in frac. records: [(course_id, record_s)].
    Returns {frac, ratio, clamped: None|'low'|'high'}: 'high' when even frac=hi is too slow for
    the target (the rival can't get that fast), 'low' when even frac=lo is too fast."""
    r_hi = median_ratio(time_fn, records, hi)
    if r_hi > target:
        return {"frac": hi, "ratio": r_hi, "clamped": "high"}
    r_lo = median_ratio(time_fn, records, lo)
    if r_lo < target:
        return {"frac": lo, "ratio": r_lo, "clamped": "low"}
    a, b = lo, hi
    for _ in range(iters):
        m = 0.5 * (a + b)
        if median_ratio(time_fn, records, m) > target:
            a = m
        else:
            b = m
    f = 0.5 * (a + b)
    return {"frac": round(f, 4), "ratio": median_ratio(time_fn, records, f), "clamped": None}


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


def persona_perf(env, persona, frac=None):
    return R.Perf(env, persona["envelopeFrac"] if frac is None else frac, persona.get("speedCap", 1.0))


def plan_lines(geom, env, cfg, fracs, terrain, cap_s, seed, min_agl):
    min_agl = min_agl + AGL_MARGIN_M
    """Offsets per persona for one course (+ convergence reports). DAWG is optimized first; MOO
    starts from DAWG's line; BRAT is half of DAWG's line plus its wide gates; STEVE is the centre
    line. A fixed line (STEVE/BRAT) that clips the terrain floor is lifted just enough to clear it
    (rival_gen.lift_for_terrain), reported as terrain_lift."""
    P = by_id(cfg)
    lines, reports = {}, {}
    dawg = P["dawg"]
    ev = R.Evaluator(geom, persona_perf(env, dawg, fracs.get("dawg")), terrain, min_agl)
    w = window_of(dawg)
    via_rep = {"vias": []}
    geom.vias = []
    init = R.inside_turn_init(geom, w)
    if terrain is not None:
        lifted, via_rep = R.plan_vias(ev, w)
        init = geom.full(init)
        init[:, 1] = lifted[:, 1]
        init[geom.n:] = lifted[geom.n:]
    lines["dawg"], reports["dawg"] = R.optimize(ev, w, init=init, cap_s=cap_s, seed=seed)
    reports["dawg"]["vias"] = via_rep.get("vias", [])
    moo = P["moo"]
    ev = R.Evaluator(geom, persona_perf(env, moo, fracs.get("moo")), terrain, min_agl)
    w = window_of(moo)
    lines["moo"], reports["moo"] = R.optimize(ev, w, init=lines["dawg"], cap_s=cap_s, seed=seed + 1)
    brat = P["brat"]
    off, wide = brat_offsets(geom, lines["dawg"], brat, geom.meta["id"])
    lines["brat"], reports["brat"] = off, {"line": "half", "wide_gates": wide}
    lines["steve"], reports["steve"] = geom.full(np.zeros((geom.n, 2))), {"line": "centre"}
    for rid in ("brat", "steve"):
        p = P[rid]
        ev = R.Evaluator(geom, persona_perf(env, p, fracs.get(rid)), terrain, min_agl)
        res = ev.run(lines[rid], detail=True)
        if res["min_agl_m"] < min_agl:
            lines[rid], rep = R.lift_for_terrain(ev, lines[rid], window_of(p))
            reports[rid] = {**reports[rid], "terrain_lift": rep}
    return lines, reports


# ------------------------------------------------------------------ records + calibration run
def record_courses(metas, env, offline=False):
    """[(course_id, record_s)] for courses whose server record is on the CURRENT hash and whose
    record-holder trace passes the jet check. Also returns the rows considered, for the report."""
    import envelope as E
    rows = E.cached_get("/courses", {}, rc.CACHE_DIR, offline) or []
    by_hash = {m["hash"]: cid for cid, m in metas.items() if m.get("hash")}
    out, considered = [], []
    for r in rows:
        cid = by_hash.get(r.get("course_hash"))
        row = {"course_id": r.get("course_id"), "course_hash": r.get("course_hash"), "record_ms": r.get("record_ms"), "used": False}
        considered.append(row)
        if not cid or cid not in metas or not r.get("record_ms"):
            row["why"] = "not the current course version"
            continue
        ghosts = E.cached_get("/ghosts", {"course_hash": r["course_hash"]}, rc.CACHE_DIR, offline) or []
        rec = next((g for g in ghosts if g.get("is_course_record")), None)
        got = E.cached_get("/ghost", {"course_hash": r["course_hash"], "callsign": rec["callsign"]}, rc.CACHE_DIR, offline) if rec else None
        rows_ = E.decode_trace(got.get("trace")) if got else None
        if rows_ is None or not E.classify_jet(E.kinematics(rows_)):
            row["why"] = "record trace missing or not jet-speed"
            continue
        row["used"] = True
        out.append((cid, r["record_ms"] / 1000.0))
    return out, considered


def calibrate(cfg, env, metas, terrain, cap_s, seed, offline=False):
    """{rival_id: frac} plus a report. Lines are optimized once per course at the default fracs
    and held fixed while each persona's envelopeFrac is bisected."""
    cal = cfg.get("calibration", {})
    records, considered = record_courses(metas, env, offline)
    report = {"records": [{"course_id": c, "record_s": s} for c, s in records], "considered": considered,
              "min_records": cal.get("min_records", 5), "targets": cal.get("targets", {}), "result": {}}
    defaults = {p["rival_id"]: p["envelopeFrac"] for p in cfg["personas"]}
    if len(records) < int(cal.get("min_records", 5)):
        report["status"] = f"kept defaults: {len(records)} usable record course(s) < {cal.get('min_records', 5)}"
        return defaults, report
    lo, hi = cal.get("frac_bounds", [0.3, 1.0])
    min_agl = float(cfg.get("minAglM", 60))
    P = by_id(cfg)
    geoms = {cid: R.CourseGeom(metas[cid]) for cid, _ in records}
    lines = {}
    for cid, _ in records:
        lines[cid], _ = plan_lines(geoms[cid], env, cfg, {}, terrain, cap_s, seed, min_agl)
    fracs = {}
    for rid, target in cal.get("targets", {}).items():
        p = P[rid]

        def time_fn(cid, frac, p=p, rid=rid):
            ev = R.Evaluator(geoms[cid], persona_perf(env, p, frac), None, min_agl)
            return ev.run(lines[cid][rid], detail=True)["time_s"]

        res = calibrate_frac(time_fn, records, float(target), lo, hi)
        fracs[rid] = res["frac"]
        report["result"][rid] = {**res, "target": target, "default": defaults[rid]}
    report["status"] = f"calibrated on {len(records)} record courses"
    return {**defaults, **fracs}, report


# ------------------------------------------------------------------ one course
def generate_course(meta, env, cfg, fracs, terrain, terrain_src, cap_s=30.0, seed=1):
    """All personas for one course -> the pending file dict (traces encoded by race.js)."""
    min_agl = float(cfg.get("minAglM", 60))
    geom = R.CourseGeom(meta)
    t0 = time.monotonic()
    lines, reports = plan_lines(geom, env, cfg, fracs, terrain, cap_s, seed, min_agl)
    rivals, failures, raw_traces = [], [], []
    for p in cfg["personas"]:
        rid = p["rival_id"]
        perf = persona_perf(env, p, fracs.get(rid))
        res = R.fly_line(geom, perf, lines[rid], terrain, min_agl)
        if res["missed"]:
            failures.append({"rival_id": rid, "reason": f"model path misses {res['missed']} gate(s)"})
            continue
        if res["min_agl_m"] < min_agl:
            failures.append({"rival_id": rid, "reason": f"min AGL {res['min_agl_m']:.0f} m < {min_agl:.0f} m inside the gate window"})
            continue
        rows, splits, time_ms = R.build_trace(res, geom, perf)
        terrain_m = R.terrain_at_samples(rows, terrain_src)
        off_r = np.linalg.norm(lines[rid][:geom.n], axis=1) / geom.r
        rivals.append({
            "rival_id": rid, "name": p["name"], "model": p["model"], "time_ms": time_ms, "splits_ms": splits,
            "envelopeFrac": round(float(perf.frac), 4), "gateWindow": p.get("gateWindow", 1.0), "speedCap": p.get("speedCap", 1.0),
            "convergence": reports.get(rid), "min_agl_m": round(res["min_agl_m"], 1),
            "max_window_used": round(float(off_r.max()), 3),
            "v_max_ms": round(float(res["v"].max()), 1), "n_max": round(float(R.load_factor(res["v"], res["terms"]["kap"], res["terms"]["uperp"]).max()), 2),
            "terrain_m": terrain_m, "_rows": rows,
        })
        raw_traces.append({"samples": rows, "truncated": False})
    if rivals:
        encoded = rc.node_call({"op": "encode", "traces": raw_traces})
        for r, enc in zip(rivals, encoded):
            r["trace"] = enc
            del r["_rows"]
    return {
        "course_id": meta["id"], "course_hash": meta["hash"], "aircraftId": meta["aircraftId"],
        "generator_version": R.GENERATOR_VERSION, "envelope_version": env["envelope_version"],
        "personas_version": cfg.get("version"), "minAglM": min_agl, "laps": geom.laps, "lap_gates": geom.K,
        "vias": [{"leg": v["leg"], "frac": round(v["frac"], 3)} for v in geom.vias],
        "seconds": round(time.monotonic() - t0, 1), "rivals": rivals, "failures": failures,
    }


# ------------------------------------------------------------------ CLI
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
    (rc.PENDING_DIR / "_skipped.json").write_text(json.dumps(skipped, indent=1), encoding="utf-8")
    terrain, terrain_src = (None, None) if args.no_terrain else R.make_terrain()
    heights = terrain.heights if terrain is not None else None
    fracs = {p["rival_id"]: p["envelopeFrac"] for p in cfg["personas"]}
    if args.calibrate:
        ac_env = envs.get("7")
        f7 = {cid: metas[cid] for cid in selected if metas[cid]["aircraftId"] == "7"}
        fracs, cal = calibrate(cfg, ac_env, f7, heights, args.cap_s, args.seed, args.offline)
        (rc.PENDING_DIR / "_calibration.json").write_text(json.dumps(cal, indent=1, default=float), encoding="utf-8")
        print("calibration: " + cal["status"] + " -> " + ", ".join(f"{k} {v:.3f}" for k, v in fracs.items()), flush=True)
    print(f"{len(selected)} course(s) to generate, {len(skipped)} skipped", flush=True)
    for n, cid in enumerate(selected, 1):
        meta = metas[cid]
        out = generate_course(meta, envs[meta["aircraftId"]], cfg, fracs, heights, terrain_src, args.cap_s, args.seed)
        (rc.PENDING_DIR / f"{cid}.json").write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
        times = " ".join(f"{r['name']} {r['time_ms'] / 1000:.1f}" for r in out["rivals"])
        fails = "; ".join(f"{f['rival_id']}: {f['reason']}" for f in out["failures"])
        print(f"[{n}/{len(selected)}] {cid}: {times}{'  FAIL ' + fails if fails else ''}  ({out['seconds']} s)", flush=True)
    return 0
