#!/usr/bin/env python3
"""Turn a robot test pilot report (race/tools/robot_pilot.js, "Download JSON") into
docs/reports/<date>/ROBOT.md: a results table, per-item detail for everything that did not PASS,
and a list of SUGGESTED fixes.

    python race/tools/robot_report.py robot-report-2026-09-24.json
    python race/tools/robot_report.py report.json --out /tmp/ROBOT.md
    python race/tools/robot_report.py report.json --stdout

Nothing here edits a course or a runway. A suggested fix is a patch-list entry for a human to
review: a course change becomes a new course version through race/tools/add_course.py after
approval, and a runway fix is an `approach` block (or a re-checked threshold) in
race/runways/<id>.json.

The fix rules, per result:
    course  FAIL(terrain|ground on leg n)  raise gates n-1 and n to clear the leg's lowest point by
                                           TERRAIN_MARGIN_M (150 m, check_terrain.py's margin)
            UNREACHABLE (gate below terrain)  raise that gate to TERRAIN_MARGIN_M above it
            UNREACHABLE (leg timeout)     review the gate: the robot never got there in time
            FAIL(missed gate n)           shift the gate toward where the robot actually flew by
                                          (miss - radius + 20 m), or widen its radius to cover it
    approach TERRAIN(c m at d nm)         steepen the glidepath so it clears that point by
                                          TERRAIN_MARGIN_M (capped at MAX_APPROACH_DEG; past the
                                          cap it needs a custom path, i.e. headingOffsetDeg)
            SPAWN_LOW                     spawn closer in, or higher (altOffsetM)
            OFFSET(m)                     re-check thr_lat/thr_lon against GeoFS's own runway
"""
from __future__ import annotations

import argparse
import datetime as _dt
import json
import math
import os
import sys

TERRAIN_MARGIN_M = 150.0
MAX_APPROACH_DEG = 6.0
TCH_M = 15.0
REPORT_V = 1
REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))


def ceil10(x: float) -> int:
    """Pure: round a positive metre figure up to the next 10 m (a bump is never too small)."""
    return int(math.ceil(max(0.0, x) / 10.0) * 10)


def fmt_ms(ms) -> str:
    if ms is None:
        return ""
    s = ms / 1000.0
    return f"{int(s // 60)}:{s % 60:04.1f}"


def _num(v, unit=""):
    return "" if v is None else f"{v:g}{unit}"


def course_fixes(r: dict) -> list[dict]:
    """Pure: suggested fixes for one COURSE result (an entry of report["results"])."""
    log = r.get("log") or {}
    gates = log.get("gates") or []
    abort = log.get("abort") or {}
    cid = r.get("id")
    out = []
    by_n = {g.get("n"): g for g in gates}
    status, reason = r.get("status"), r.get("reason") or ""
    if status == "UNREACHABLE" and reason == "gate below terrain":
        g = by_n.get(r.get("gate")) or {}
        below = -(g.get("gateHaglM") or 0.0)
        out.append({"course": cid, "gate": r.get("gate"), "op": "raise_gate", "by_m": ceil10(below + TERRAIN_MARGIN_M),
                    "why": f"gate {r.get('gate')} sits {below:g} m below the terrain under it"})
    elif status == "UNREACHABLE":
        out.append({"course": cid, "gate": r.get("gate"), "op": "review_gate",
                    "why": f"the leg to gate {r.get('gate')} timed out: check its position and altitude"})
    elif status == "FAIL" and abort.get("reason") in ("terrain", "ground"):
        n = abort.get("gate") or r.get("gate")
        low = abort.get("haglM") if abort.get("haglM") is not None else 0.0
        by = ceil10(TERRAIN_MARGIN_M - low)
        for gate in (n - 1, n):
            if gate and gate >= 1:
                out.append({"course": cid, "gate": gate, "op": "raise_gate", "by_m": by,
                            "why": f"the leg to gate {n} came within {low:g} m of the ground"})
    elif status == "FAIL":
        for g in gates:
            if not g.get("missed"):
                continue
            miss, radius = g.get("missM") or 0.0, g.get("radiusM") or 0.0
            side = g.get("sideM") or 0.0
            out.append({"course": cid, "gate": g.get("n"), "op": "shift_gate",
                        "toward": "right" if side > 0 else "left", "by_m": ceil10(miss - radius + 20),
                        "or_radius_m": ceil10(miss + 20),
                        "why": f"missed by {miss:g} m (radius {radius:g} m), passed on the {'right' if side > 0 else 'left'}"})
    return out


def approach_fixes(r: dict) -> list[dict]:
    """Pure: suggested fixes for one APPROACH result."""
    log = r.get("log") or {}
    rid = r.get("id")
    status = r.get("status")
    out = []
    if status == "TERRAIN":
        glide = log.get("glideDeg") or 3.0
        clear = log.get("minGpClearM")
        at_nm = log.get("minGpClearAtNm")
        abort = log.get("abort") or {}
        if clear is None or at_nm is None:
            clear, at_nm = abort.get("haglM"), abort.get("distNm")
        if clear is not None and at_nm:
            d = at_nm * 1852.0
            path_h = TCH_M + d * math.tan(math.radians(glide))
            need = path_h + (TERRAIN_MARGIN_M - clear)
            angle = math.ceil(math.degrees(math.atan2(need, d)) * 2) / 2
            fix = {"runway": rid, "op": "approach", "approach": {"angleDeg": min(angle, MAX_APPROACH_DEG)},
                   "why": f"the {glide:g} deg path clears terrain by {clear:g} m at {at_nm:g} nm"}
            if angle > MAX_APPROACH_DEG:
                fix["note"] = (f"needs {angle:g} deg to clear it straight in: past {MAX_APPROACH_DEG:g} deg, "
                               "design a custom path (headingOffsetDeg down the valley, shorter distNm)")
            out.append(fix)
    elif status == "SPAWN_LOW":
        spawn = log.get("spawn") or {}
        dist_nm = (spawn.get("distM") or 5556.0) / 1852.0
        low = log.get("spawnHaglM") or 0.0
        out.append({"runway": rid, "op": "approach",
                    "approach": {"distNm": round(max(1.0, dist_nm * 0.6), 1), "altOffsetM": ceil10(TERRAIN_MARGIN_M - low)},
                    "why": f"spawned {low:g} m above terrain"})
    elif status == "OFFSET":
        off = log.get("geofsOffset") or {}
        out.append({"runway": rid, "op": "check_threshold", "crossM": off.get("crossM"), "alongM": off.get("alongM"),
                    "why": "GeoFS draws this runway off the JSON centreline: re-check thr_lat/thr_lon"})
    return out


def suggest_fixes(report: dict) -> list[dict]:
    fixes = []
    for r in report.get("results") or []:
        fixes += approach_fixes(r) if r.get("kind") == "approach" else course_fixes(r)
    return fixes


def _course_row(r: dict) -> str:
    log = r.get("log") or {}
    gates = log.get("gates") or []
    worst = min((g for g in gates if g.get("legMinHaglM") is not None), key=lambda g: g["legMinHaglM"], default=None)
    note = f"lowest {worst['legMinHaglM']:g} m AGL on leg {worst['n']}" if worst else ""
    return f"| `{r.get('id')}` | {r.get('group') or ''} | {r.get('aircraftId') or ''} | {r.get('label')} | {fmt_ms(r.get('timeMs'))} | {note} |"


def _approach_row(r: dict) -> str:
    log = r.get("log") or {}
    at50 = log.get("at50") or {}
    off = log.get("geofsOffset") or {}
    clear = "" if log.get("minGpClearM") is None else f"{log['minGpClearM']:g} m at {log.get('minGpClearAtNm'):g} nm"
    return (f"| `{r.get('id')}` | {r.get('group') or ''} | {r.get('aircraftId') or ''} | {r.get('label')} | "
            f"{_num(log.get('spawnHaglM'), ' m')} | {clear} | {_num(at50.get('crossM'), ' m')} | {_num(off.get('crossM'), ' m')} |")


def _course_detail(r: dict) -> list[str]:
    log = r.get("log") or {}
    lines = [f"### `{r.get('id')}`: {r.get('label')}", ""]
    abort = log.get("abort")
    if abort:
        lines += [f"Aborted: {json.dumps(abort)}", ""]
    gates = log.get("gates") or []
    if gates:
        lines += ["| Gate | Crossed | Miss (m) | Radius (m) | Side (m) | Leg min AGL (m) | AGL at gate (m) | Leg time |",
                  "|---|---|---|---|---|---|---|---|"]
        for g in gates:
            state = "yes" if g.get("crossed") else ("MISSED" if g.get("missed") else "no")
            lines.append(f"| {g.get('n')} | {state} | {_num(g.get('missM'))} | {_num(g.get('radiusM'))} | {_num(g.get('sideM'))} | "
                         f"{_num(g.get('legMinHaglM'))} | {_num(g.get('gateHaglM'))} | {fmt_ms(g.get('legMs'))} |")
        lines.append("")
    return lines


def _approach_detail(r: dict) -> list[str]:
    log = r.get("log") or {}
    lines = [f"### `{r.get('id')}`: {r.get('label')}", ""]
    for key in ("abort", "spawn", "at1nm", "atHalfNm", "at50", "geofsOffset"):
        if log.get(key):
            lines.append(f"- **{key}**: `{json.dumps(log[key])}`")
    prof = log.get("profile") or []
    if prof:
        lines.append("- **last mile** (nm: AGL m / above path m): "
                     + ", ".join(f"{p.get('distNm')}: {p.get('haglM')}/{p.get('aboveGpM')}" for p in prof))
    lines.append("")
    return lines


def render(report: dict, source: str = "") -> str:
    """Pure: report JSON -> ROBOT.md text."""
    if report.get("kind") != "robot-report" or report.get("v") != REPORT_V:
        raise ValueError(f"not a v{REPORT_V} robot report")
    results = report.get("results") or []
    counts: dict[str, int] = {}
    for r in results:
        counts[r.get("status")] = counts.get(r.get("status"), 0) + 1
    date = (report.get("generated_at") or "")[:10]
    approach = report.get("mode") == "approach"
    lines = [f"# Robot test pilot: {'approaches' if approach else 'courses'}, {date}", "",
             f"Generated by `race/tools/robot_report.py` from `{source or 'report.json'}` (robot report v{report.get('v')}, "
             f"client {report.get('client_version') or '?'}, generated {report.get('generated_at')}).",
             f"{len(results)} flown: " + ", ".join(f"{n} {s}" for s, n in sorted(counts.items())) + ".", ""]
    lines += ["## Results", ""]
    if approach:
        lines += ["| Runway | Group | Aircraft | Result | Spawn AGL | Glidepath clearance | 50 ft cross-track | GeoFS offset |",
                  "|---|---|---|---|---|---|---|---|"]
        lines += [_approach_row(r) for r in results]
    else:
        lines += ["| Course | Cup | Aircraft | Result | Time | Notes |", "|---|---|---|---|---|---|"]
        lines += [_course_row(r) for r in results]
    lines.append("")
    bad = [r for r in results if r.get("status") != "PASS"]
    if bad:
        lines += ["## Details", ""]
        for r in bad:
            lines += _approach_detail(r) if r.get("kind") == "approach" else _course_detail(r)
    fixes = suggest_fixes(report)
    lines += ["## Suggested fixes (NOT applied)", "",
              "Nothing below has been applied. A course change ships as a new course version through "
              "`race/tools/add_course.py` after approval; a runway fix is an `approach` block (or a "
              "re-checked threshold) in `race/runways/<id>.json`.", ""]
    if fixes:
        lines += ["```json"] + [json.dumps(f) for f in fixes] + ["```", ""]
    else:
        lines += ["None.", ""]
    return "\n".join(lines)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("report", help="the robot's report JSON (Download JSON / Copy JSON)")
    ap.add_argument("--out", help="output path (default docs/reports/<date>/ROBOT.md)")
    ap.add_argument("--date", help="YYYY-MM-DD for the default path (default: the report's own date, else today)")
    ap.add_argument("--stdout", action="store_true", help="print instead of writing a file")
    a = ap.parse_args(argv)
    try:
        with open(a.report, encoding="utf-8") as f:
            report = json.load(f)
        text = render(report, os.path.basename(a.report))
    except (OSError, ValueError) as e:
        print(f"robot_report: {e}", file=sys.stderr)
        return 2
    if a.stdout:
        print(text)
        return 0
    date = a.date or (report.get("generated_at") or "")[:10] or _dt.date.today().isoformat()
    out = a.out or os.path.join(REPO_ROOT, "docs", "reports", date, "ROBOT.md")
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    with open(out, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    print(f"robot_report: wrote {out} ({len(suggest_fixes(report))} suggested fix(es))")
    return 0


if __name__ == "__main__":
    sys.exit(main())
