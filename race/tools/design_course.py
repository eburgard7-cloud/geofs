#!/usr/bin/env python3
"""Turn a hand-picked list of waypoints into a course whose gate altitudes hug the terrain
(as low as check_terrain.py's margin allows), optionally snapping waypoints onto the valley floor.

    python race/tools/design_course.py spec.json --out course.json [--preview route.png]

spec.json:
    {"id": "lauterbrunnen-falls", "name": "Lauterbrunnen Falls (easy)", "radius": 150,
     "waypoints": [{"lat": 46.686, "lon": 7.855}, {"lat": 46.598, "lon": 7.909, "snap": 300,
                   "radius": 105, "extra": 50}, ...],
     "boxes": [{"leg": 3, "frac": 0.5, "radius": 110}]}

  radius   gate radius (per waypoint `radius` overrides the spec default)
  snap     move this waypoint to the lowest terrain within `snap` metres (valley floor)
  extra    fly this gate `extra` metres higher than the minimum (e.g. a showpiece high gate)
  boxes    item boxes placed `frac` of the way along leg `leg` (0-based, gate leg -> leg+1), at
           the route's altitude there

Altitudes are fitted by an iterative LP-style raise: every gate starts at terrain + max(margin,
radius) + pad, then any leg sample with clearance < margin + pad (check_terrain.py's exact
sampling, chord sag included) raises the cheaper of its two gates just enough. The result is
then re-checked with check_terrain.check_course(), so a written course always passes at
--margin with the same --source. Terrain: check_terrain.py's sources (default auto).

    python race/tools/design_course.py --fix-starts [course ...] [--source global --cache t.json]

--fix-starts writes a course's `start` block (never hand-typed) for every air-start course that
fails check_terrain.py --starts (no ids = every course; --force rewrites passing ones too):

    "start": {"bearing_deg": 212.5, "min_alt_m": null, "corridor_terrain_max_m": 1432.0,
              "checked_with": {...}}

  bearing_deg              the inbound heading flown into gate 1. The grid, Fly to start and the
                           robot spawn behind gate 1 on bearing_deg + 180, facing bearing_deg. It is
                           the straight-in line within +/-75 deg of gate1->gate2 (nearest first, 5 deg
                           steps) whose whole 12-slot corridor clears the margin at gate 1's altitude,
                           or, when none does, the nearest line within 25 m of the lowest floor.
  min_alt_m                null when that line clears; otherwise a spawn floor, the highest terrain
                           on it + the margin. race.js spawns slot i at max(gate1.alt + 30 i, this).
  corridor_terrain_max_m   the highest terrain on that corridor AND the formation oval: the value
                           race.js's formationAltitudeM() holds the rolling start above.
  checked_with             the source, geometry and course_hash the block was computed for.

`start` is not part of Course.hash() (geometry + aircraft + env only), so writing it never changes
a course_hash: leaderboards and ghosts are untouched (race/test/test_design_course.py proves it).
"""
from __future__ import annotations

import argparse
import datetime
import json
import math
import statistics
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import check_terrain as ct  # noqa: E402

RACING_SPEED_MPS = 154.0     # ~300 kt, for the rough lap-time estimate only
DEFAULT_PAD_M = 15.0


def snap_to_valley(lat, lon, source, search_m, grid=7):
    """Lowest terrain on a (grid x grid) lattice within search_m of (lat, lon)."""
    if not search_m:
        return lat, lon
    pts = []
    for i in range(grid):
        for j in range(grid):
            dn = (i / (grid - 1) - 0.5) * 2 * search_m
            de = (j / (grid - 1) - 0.5) * 2 * search_m
            if dn * dn + de * de > search_m * search_m:
                continue
            pts.append((lat + dn / 111320.0, lon + de / (111320.0 * math.cos(math.radians(lat)))))
    h = source.heights(pts)
    best = min(pts, key=lambda p: h[ct.sample_key(*p)])
    return round(best[0], 6), round(best[1], 6)


def fit_altitudes(gates, source, margin=ct.DEFAULT_MARGIN_M, pad=DEFAULT_PAD_M, step=ct.DEFAULT_STEP_M,
                  extras=None, max_iter=500, closed=False):
    """Mutates gates[i]['alt'] to the lowest altitudes (greedy) that clear terrain by margin+pad.
    closed=True: the last gate is the first gate again (a circuit lap), so the two are kept at the
    same altitude. Returns (samples, terrain) for reporting."""
    extras = extras or [0.0] * len(gates)
    for g in gates:
        g["alt"] = 0.0
    samples = ct.route_samples(gates, step)
    terr = source.heights([(s["lat"], s["lon"]) for s in samples])
    tval = [terr[ct.sample_key(s["lat"], s["lon"])] for s in samples]
    if any(t is ct.NO_DATA for t in tval):
        raise ct.TerrainError("no terrain data somewhere on the route")
    for s, t in zip(samples, tval):
        if s["kind"] == "gate":
            i = s["gate"]
            gates[i]["alt"] = t + max(margin, gates[i]["radius"]) + pad + extras[i]
    legs = {}
    for s, t in zip(samples, tval):
        if s["kind"] == "leg":
            a, b = s["leg"]
            d = ct.haversine_m((gates[a]["lat"], gates[a]["lon"]), (gates[b]["lat"], gates[b]["lon"]))
            f = s["along_m"] / d
            legs.setdefault(a, []).append((f, t + margin + pad + ct.chord_sag_m(d, f)))
    for _ in range(max_iter):
        changed = False
        for a, cons in legs.items():
            b = a + 1
            for f, need in cons:
                have = gates[a]["alt"] * (1 - f) + gates[b]["alt"] * f
                deficit = need - have
                if deficit > 1e-6:
                    if f < 0.5:
                        gates[a]["alt"] += deficit / (1 - f)
                    else:
                        gates[b]["alt"] += deficit / f
                    changed = True
        if closed:
            top = max(gates[0]["alt"], gates[-1]["alt"])
            if gates[0]["alt"] != top or gates[-1]["alt"] != top:
                gates[0]["alt"] = gates[-1]["alt"] = top
                changed = True
        if not changed:
            break
    for g in gates:
        g["alt"] = round(g["alt"] + 0.05, 1)   # round up-ish so rounding never costs clearance
    return samples, tval


def route_stats(gates, samples, tval, speed_kt=None):
    agl = []
    for s, t in zip(samples, tval):
        if s["kind"] == "leg":
            a, b = s["leg"]
            d = ct.haversine_m((gates[a]["lat"], gates[a]["lon"]), (gates[b]["lat"], gates[b]["lon"]))
            f = s["along_m"] / d
            alt = gates[a]["alt"] + (gates[b]["alt"] - gates[a]["alt"]) * f - ct.chord_sag_m(d, f)
        else:
            alt = gates[s["gate"]]["alt"]
        agl.append(alt - t)
    legs = [ct.haversine_m((gates[i]["lat"], gates[i]["lon"]), (gates[i + 1]["lat"], gates[i + 1]["lon"]))
            for i in range(len(gates) - 1)]
    climbs = [math.degrees(math.atan2(abs(gates[i + 1]["alt"] - gates[i]["alt"]), legs[i])) for i in range(len(legs))]
    turns = []
    for i in range(1, len(gates) - 1):
        b1 = bearing(gates[i - 1], gates[i])
        b2 = bearing(gates[i], gates[i + 1])
        turns.append(abs((b2 - b1 + 540) % 360 - 180))
    return {
        "length_km": round(sum(legs) / 1000, 2), "legs_km": [round(x / 1000, 2) for x in legs],
        "est_time_s": round(sum(legs) / (speed_kt * 0.514444 if speed_kt else RACING_SPEED_MPS)), "min_agl_m": round(min(agl), 1),
        "median_agl_m": round(statistics.median(agl), 1), "max_agl_m": round(max(agl), 1),
        "max_climb_deg": round(max(climbs), 1), "turns_deg": [round(x) for x in turns],
        "terrain_max_m": round(max(tval), 1), "terrain_min_m": round(min(tval), 1),
    }


def bearing(g1, g2):
    p1, p2 = math.radians(g1["lat"]), math.radians(g2["lat"])
    dl = math.radians(g2["lon"] - g1["lon"])
    return (math.degrees(math.atan2(math.sin(dl) * math.cos(p2),
                                    math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl))) + 360) % 360


def place_boxes(gates, boxes, source=None, margin=ct.DEFAULT_MARGIN_M):
    """Item boxes on the route line; never below terrain + margin at the box itself (the terrain
    check samples every 250 m, so a box between samples could otherwise sit on a crest)."""
    out = []
    for bx in boxes or []:
        a, f = int(bx["leg"]), float(bx.get("frac", 0.5))
        g1, g2 = gates[a], gates[a + 1]
        lat, lon = ct.interpolate((g1["lat"], g1["lon"]), (g2["lat"], g2["lon"]), f)
        d = ct.haversine_m((g1["lat"], g1["lon"]), (g2["lat"], g2["lon"]))
        alt = g1["alt"] + (g2["alt"] - g1["alt"]) * f - ct.chord_sag_m(d, f)
        if source is not None:
            t = source.heights([(lat, lon)])[ct.sample_key(lat, lon)]
            if t is not ct.NO_DATA:
                alt = max(alt, t + margin)
        out.append({"lat": round(lat, 6), "lon": round(lon, 6), "alt": round(alt, 1), "radius": float(bx.get("radius", 110.0))})
    return out


def design(spec, source, margin=ct.DEFAULT_MARGIN_M, pad=DEFAULT_PAD_M, step=ct.DEFAULT_STEP_M):
    """spec extras: "laps": N (>1) treats the waypoints as ONE lap of a circuit: the lap is closed
    (its first gate repeated at the end, same altitude) and unrolled N times into the course's gate
    list, so gates = lap * N + [lap[0]] with identical coordinates every lap. "startType": "ground"
    for a ground start (default "air"). "speed_kt" sets the lap-time estimate speed."""
    radius = float(spec.get("radius", ct.DEFAULT_MARGIN_M))
    laps = int(spec.get("laps", 1) or 1)
    gates, extras = [], []
    for w in spec["waypoints"]:
        lat, lon = snap_to_valley(w["lat"], w["lon"], source, w.get("snap", 0))
        gates.append({"lat": round(lat, 6), "lon": round(lon, 6), "alt": 0.0, "radius": float(w.get("radius", radius))})
        extras.append(float(w.get("extra", 0.0)))
    if laps > 1:
        gates.append(dict(gates[0]))
        extras.append(extras[0])
    samples, tval = fit_altitudes(gates, source, margin, pad, step, extras, closed=laps > 1)
    lap_stats = None
    if laps > 1:
        lap = gates[:-1]
        lap_stats = route_stats(gates, samples, tval, spec.get("speed_kt"))
        gates = [dict(g) for _ in range(laps) for g in lap] + [dict(lap[0])]
        if len(gates) > 201:
            raise ct.TerrainError(f"{len(gates)} gates after unrolling {laps} laps; the limit is 201")
        samples = ct.route_samples(gates, step)
        h = source.heights([(s["lat"], s["lon"]) for s in samples])
        tval = [h[ct.sample_key(s["lat"], s["lon"])] for s in samples]
    start_type = "ground" if spec.get("startType") == "ground" else "air"
    course = {"id": spec["id"], "name": spec["name"], "version": int(spec.get("version", 1)), "aircraftId": None,
              "startType": start_type, "itemBoxes": place_boxes(gates, spec.get("boxes"), source, margin), "gates": gates}
    check = ct.check_course(json.loads(json.dumps(course)), source, step, margin)
    stats = route_stats(gates, samples, tval, spec.get("speed_kt"))
    if lap_stats:
        stats["laps"] = laps
        stats["lap_gates"] = len(gates[:len(spec["waypoints"])])
        stats["lap_length_km"] = lap_stats["length_km"]
        stats["lap_time_s"] = lap_stats["est_time_s"]
    stats["check_status"] = check["status"]
    stats["check_min_clearance_m"] = round(check["worst"]["clearance_m"], 1) if check["worst"] else None
    return course, stats


# --------------------------------------------------------------------------- --fix-starts
START_SEARCH_SPAN_DEG = 75.0
START_SEARCH_STEP_DEG = 5.0
START_FLOOR_SLACK_M = 25.0


def start_bearing_candidates(default_inbound, span_deg=START_SEARCH_SPAN_DEG, step_deg=START_SEARCH_STEP_DEG):
    """Pure: inbound headings to try, nearest the gate1->gate2 bearing first (0, +5, -5, +10, ...)."""
    out, k = [round(default_inbound % 360.0, 1)], 1
    while k * step_deg <= span_deg + 1e-9:
        for sign in (1, -1):
            out.append(round((default_inbound + sign * k * step_deg) % 360.0, 1))
        k += 1
    return out


def search_start_bearing(course, source, pace_kt=ct.START_PACE_KT, lead_s=ct.START_MAX_LEAD_S, slots=ct.START_SLOTS,
                         margin=ct.START_MARGIN_M, step=ct.START_STEP_M, span_deg=START_SEARCH_SPAN_DEG,
                         step_deg=START_SEARCH_STEP_DEG):
    """The straight-in line to gate 1 to spawn the grid on. Every candidate's full-grid corridor is
    sampled in one batch; the first (nearest gate1->gate2) that clears `margin` at gate 1's altitude
    wins, else the one with the lowest terrain top. Returns {bearing_deg, terrain_max_m, clears,
    clearance_m, offset_deg, tried}."""
    g1, g2 = course["gates"][0], course["gates"][1]
    default = ct.initial_bearing((g1["lat"], g1["lon"]), (g2["lat"], g2["lon"]))
    dist = pace_kt * ct.KT_MS * lead_s
    cands = start_bearing_candidates(default, span_deg, step_deg)
    per = [ct.start_corridor_samples(g1, b, dist, slots, ct.START_LATERAL_M, step) for b in cands]
    heights = source.heights([(p["lat"], p["lon"]) for pts in per for p in pts])
    tried = []
    for b, pts in zip(cands, per):
        top, _, missing = ct._max_terrain(pts, heights)
        if missing or top is None:
            continue   # a line we can't vouch for is never picked
        tried.append({"bearing_deg": b, "terrain_max_m": top, "clearance_m": g1["alt"] - top,
                      "offset_deg": round(((b - default + 540) % 360) - 180, 1)})
    if not tried:
        raise ct.TerrainError(f"{course['id']}: no terrain data on any start corridor")
    clear = [t for t in tried if t["clearance_m"] >= margin]
    if clear:
        best = clear[0]
    else:
        # No line clears, so a spawn floor is coming anyway: take the nearest line whose floor is
        # within START_FLOOR_SLACK_M of the lowest, rather than swinging 75 deg off for a few metres.
        top = max(t["clearance_m"] for t in tried)
        best = next(t for t in tried if t["clearance_m"] >= top - START_FLOOR_SLACK_M)
    return {**best, "clears": bool(clear), "tried": len(tried)}


def fix_start(course, source, course_hash, margin=ct.START_MARGIN_M, step=ct.START_STEP_M, today=None):
    """The `start` block for a course (see the module docstring)."""
    pick = search_start_bearing(course, source, margin=margin, step=step)
    g1, g2 = course["gates"][0], course["gates"][1]
    oval = ct.formation_samples(g1, g2, ct.START_PACE_KT * ct.KT_MS, step)
    o_top, _, _ = ct._max_terrain(oval, source.heights([(p["lat"], p["lon"]) for p in oval]))
    top = max(pick["terrain_max_m"], o_top if o_top is not None else pick["terrain_max_m"])
    return {
        "bearing_deg": pick["bearing_deg"],
        "min_alt_m": None if pick["clears"] else float(math.ceil(pick["terrain_max_m"] + margin)),
        "corridor_terrain_max_m": float(math.ceil(top)),
        "checked_with": {"tool": "design_course.py --fix-starts", "source": source.name.split(" (cached")[0],
                         "course_hash": course_hash, "pace_kt": ct.START_PACE_KT, "lead_s": ct.START_MAX_LEAD_S,
                         "slots": ct.START_SLOTS, "lateral_m": ct.START_LATERAL_M, "margin_m": margin, "step_m": step,
                         "search_deg": START_SEARCH_SPAN_DEG, "date": (today or datetime.date.today()).isoformat()},
    }


def with_start(raw, start):
    """The course dict with `start` placed right after startType (every other key, and its order, kept)."""
    out = {}
    for k, v in raw.items():
        if k == "start":
            continue
        out[k] = v
        if k == "startType":
            out["start"] = start
    if "start" not in out:
        out["start"] = start
    return out


def write_course_json(path, course, original_text):
    """Re-serialize in the file's own style (indent 2, ASCII-escaped or not, trailing newline)."""
    text = original_text.replace("\r\n", "\n")   # a Windows checkout (autocrlf) is still the same style
    ascii_ = json.dumps(json.loads(text), indent=2, ensure_ascii=True) + "\n" == text
    Path(path).write_text(json.dumps(course, indent=2, ensure_ascii=ascii_) + "\n", encoding="utf-8")


def main_fix_starts(args):
    import add_course
    ns = argparse.Namespace(source=args.source, cache=args.cache, zoom=ct.TERRARIUM_ZOOM, cesium_level=11, samples_file=None)
    ids = args.targets or ct.all_course_ids()
    rows = []
    try:
        source = ct.make_source(ns)
        for cid in ids:
            path = ct.COURSES_DIR / f"{cid}.json"
            text = path.read_text(encoding="utf-8")
            raw = json.loads(text)
            course = ct.load_course(cid)
            h = add_course.course_hash(course)
            before = ct.check_starts(course, source, margin_m=args.margin, course_hash=h)
            row = {"id": cid, "before": before["min_clearance_m"], "before_status": before["status"],
                   "after": before["min_clearance_m"], "after_status": before["status"], "fix": None}
            if before["status"] == "SKIP" or (before["status"] == "PASS" and not args.force):
                rows.append(row)
                continue
            base = dict(course)
            base.pop("start", None)
            start = fix_start(base, source, h, margin=args.margin)
            fixed = with_start(raw, start)
            after = ct.check_starts(dict(course, start=start), source, margin_m=args.margin, course_hash=h)
            if add_course.course_hash(fixed) != h:
                raise ct.TerrainError(f"{cid}: writing `start` would change course_hash; refusing")
            off = round(((start["bearing_deg"] - before["default_inbound_deg"] + 540) % 360) - 180, 1)
            parts = []
            if abs(off) >= 0.1:
                parts.append(f"bearing {start['bearing_deg']:.1f} ({off:+.0f} deg)")
            if start["min_alt_m"] is not None:
                parts.append(f"spawn floor {start['min_alt_m']:.0f} m")
            parts.append(f"formation over {start['corridor_terrain_max_m']:.0f} m terrain")
            row.update(after=after["min_clearance_m"], after_status=after["status"], fix=", ".join(parts))
            if not args.dry_run:
                write_course_json(path, fixed, text)
            rows.append(row)
    except ct.TerrainError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    if args.json:
        print(json.dumps({"source": source.name, "courses": rows}, indent=2))
    else:
        f = lambda v: "n/a" if v is None else f"{v:.0f}"  # noqa: E731
        print("| course | min clearance before (m) | after (m) | fix applied |\n|---|---:|---:|---|")
        for r in rows:
            if r["fix"]:
                print(f"| {r['id']} | {f(r['before'])} | {f(r['after'])} ({r['after_status']}) | {r['fix']} |")
        print(f"\n{sum(1 for r in rows if r['fix'])} course(s) {'would be ' if args.dry_run else ''}fixed; "
              f"{sum(1 for r in rows if r['fix'] and r['after_status'] != 'PASS')} still not PASS")
    return 1 if any(r["fix"] and r["after_status"] != "PASS" for r in rows) else 0


def render_preview(course, source, out_png, zoom_pad_m=1500, px=360):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    import numpy as np

    lats = [g["lat"] for g in course["gates"]]
    lons = [g["lon"] for g in course["gates"]]
    mlat = sum(lats) / len(lats)
    dlat = zoom_pad_m / 111320.0
    dlon = zoom_pad_m / (111320.0 * math.cos(math.radians(mlat)))
    la0, la1 = min(lats) - dlat, max(lats) + dlat
    lo0, lo1 = min(lons) - dlon, max(lons) + dlon
    aspect = ((lo1 - lo0) * math.cos(math.radians(mlat))) / (la1 - la0)
    ny = px
    nx = max(60, int(px * aspect))
    ys = np.linspace(la1, la0, ny)
    xs = np.linspace(lo0, lo1, nx)
    pts = [(float(y), float(x)) for y in ys for x in xs]
    # Draw from the raw Terrarium tiles, never through the sample cache (100k preview points
    # would bloat it); fall back to whatever source was given.
    raw = source
    for _ in range(3):
        raw = getattr(raw, "inner", None) or getattr(raw, "glob", None) or raw
    h = raw.heights(pts)
    Z = np.array([h[ct.sample_key(*p)] for p in pts], dtype=float).reshape(ny, nx)
    cell = (la1 - la0) * 111320.0 / ny
    gy, gx = np.gradient(Z, cell)
    az, alt = math.radians(315), math.radians(45)
    slope = np.arctan(np.hypot(gx, gy))
    aspect_a = np.arctan2(-gx, gy)
    shade = np.sin(alt) * np.cos(slope) + np.cos(alt) * np.sin(slope) * np.cos(az - aspect_a)
    fig, ax = plt.subplots(figsize=(7, 7 / max(aspect, 0.3)) if aspect > 1 else (7 * aspect + 1, 7), dpi=90)
    ax.imshow(Z, extent=[lo0, lo1, la0, la1], cmap="terrain", alpha=0.85, vmin=min(0, Z.min()), vmax=Z.max())
    ax.imshow(shade, extent=[lo0, lo1, la0, la1], cmap="gray", alpha=0.45)
    ax.plot(lons, lats, "-", color="red", lw=1.6)
    for i, g in enumerate(course["gates"]):
        ax.plot(g["lon"], g["lat"], "o", ms=7, mfc="white", mec="red")
        ax.annotate(f"{i + 1}\n{g['alt']:.0f}", (g["lon"], g["lat"]), fontsize=7, color="black",
                    xytext=(4, 4), textcoords="offset points")
    for b in course.get("itemBoxes", []):
        ax.plot(b["lon"], b["lat"], "s", ms=6, mfc="yellow", mec="black")
    ax.set_title(f"{course['name']}  ({course['id']})", fontsize=9)
    ax.set_aspect(1 / math.cos(math.radians(mlat)))
    fig.tight_layout()
    fig.savefig(out_png)
    plt.close(fig)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("targets", nargs="*", metavar="spec_or_course",
                    help="spec.json to design; with --fix-starts, course ids (default: every course)")
    ap.add_argument("--out")
    ap.add_argument("--fix-starts", action="store_true", help="Write `start` blocks for courses failing check_terrain.py --starts.")
    ap.add_argument("--force", action="store_true", help="--fix-starts: rewrite passing courses' start blocks too.")
    ap.add_argument("--dry-run", action="store_true", help="--fix-starts: report, write nothing.")
    ap.add_argument("--json", action="store_true", help="--fix-starts: machine-readable report.")
    ap.add_argument("--preview")
    ap.add_argument("--source", choices=["auto", "usgs", "global"], default="auto")
    ap.add_argument("--cache", help="check_terrain.py sample cache (also sets the tile cache)")
    ap.add_argument("--margin", type=float, default=ct.DEFAULT_MARGIN_M)
    ap.add_argument("--pad", type=float, default=DEFAULT_PAD_M)
    args = ap.parse_args(argv)
    if args.fix_starts:
        return main_fix_starts(args)
    if len(args.targets) != 1 or not args.out:
        ap.error("designing a course needs exactly one spec.json and --out")
    spec = json.loads(Path(args.targets[0]).read_text(encoding="utf-8"))
    ns = argparse.Namespace(source=args.source, cache=args.cache, zoom=ct.TERRARIUM_ZOOM, cesium_level=11, samples_file=None)
    try:
        source = ct.make_source(ns)
        course, stats = design(spec, source, args.margin, args.pad)
        if args.preview:
            render_preview(course, source, args.preview)
    except ct.TerrainError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    Path(args.out).write_text(json.dumps(course, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"id": course["id"], "source": source.name, **stats}))
    return 0 if stats["check_status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
