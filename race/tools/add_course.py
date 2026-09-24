#!/usr/bin/env python3
"""Validate a pasted course JSON and add/update it under race/courses/, keeping
race/courses/index.json in sync.

Automates the manual steps in README.md's "Sharing a course with everyone" section, so
the full loop is: fly -> Alt+G per gate -> Copy JSON (in-sim editor) -> this script ->
commit -> push -> friends click the course list's refresh button.

Usage:
    python race/tools/add_course.py path/to/pasted.json
    cat pasted.json | python race/tools/add_course.py
    python race/tools/add_course.py path/to/pasted.json --force

Validation mirrors Course.normalize() in race.js (2-201 gates, finite lat/lon/alt/radius
within range, name length, id shape) but is intentionally stricter where race.js is
permissive: race.js runs in the browser against a course the player just built and
silently truncates/sanitizes bad input to keep the UI usable; this tool curates the
shared course list everyone fetches, so it rejects and explains instead of guessing.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
COURSES_DIR = REPO_ROOT / "race" / "courses"
INDEX_PATH = COURSES_DIR / "index.json"

MIN_GATES = 2
MAX_GATES = 201
MAX_NAME_LEN = 48
MAX_ID_LEN = 64
MAX_RADIUS_M = 5000
DEFAULT_RADIUS_M = 150  # CONFIG.DEFAULT_RADIUS_M in race.js
MAX_ITEM_BOXES = 24     # MAX_ITEM_BOXES in race.js, and MAX_BOXES in race/server/app.py
SLUG_RE = re.compile(r"^[a-z0-9-]{1,%d}$" % MAX_ID_LEN)


class CourseError(ValueError):
    """A course fails one of Course.normalize()'s rules (or this tool's stricter id/name checks)."""


def _finite(value):
    # JSON booleans are an int subclass in Python; race.js would coerce true/false to
    # 1/0 via unary +, but a boolean masquerading as a coordinate is almost certainly a
    # mistake in pasted JSON, so this tool rejects it rather than silently accepting it.
    if isinstance(value, bool):
        return None
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    if f != f or f in (float("inf"), float("-inf")):  # NaN, +-Infinity
        return None
    return f


def slugify(name: str) -> str:
    """Mirrors race.js's slug(): lowercase, non [a-z0-9] runs collapse to '-', trimmed, capped."""
    s = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return s[:MAX_ID_LEN]


def normalize(raw: dict) -> dict:
    if not isinstance(raw, dict):
        raise CourseError("Course JSON must be an object.")

    gates_in = raw.get("gates")
    if not isinstance(gates_in, list) or len(gates_in) < MIN_GATES:
        raise CourseError(f"A course needs at least {MIN_GATES} gates.")
    if len(gates_in) > MAX_GATES:
        raise CourseError(f"A course can have at most {MAX_GATES} gates.")

    gates = []
    for i, g in enumerate(gates_in):
        if not isinstance(g, dict):
            raise CourseError(f"Gate {i} is invalid.")
        lat = _finite(g.get("lat"))
        lon = _finite(g.get("lon"))
        alt = _finite(g.get("alt"))
        radius_raw = g.get("radius")
        radius = DEFAULT_RADIUS_M if radius_raw is None else _finite(radius_raw)
        if any(v is None for v in (lat, lon, alt, radius)):
            raise CourseError(f"Gate {i} is invalid.")
        if abs(lat) > 90 or abs(lon) > 180 or radius <= 0 or radius > MAX_RADIUS_M:
            raise CourseError(f"Gate {i} is invalid.")
        gates.append({"lat": lat, "lon": lon, "alt": alt, "radius": radius})

    name = str(raw.get("name") or "Untitled course")
    if len(name) > MAX_NAME_LEN:
        raise CourseError(f"name is {len(name)} chars; must be at most {MAX_NAME_LEN}.")

    raw_id = raw.get("id")
    if raw_id:
        cid = str(raw_id)
        if not SLUG_RE.match(cid):
            raise CourseError(f"id {cid!r} must match [a-z0-9-]{{1,{MAX_ID_LEN}}}.")
    else:
        cid = slugify(name)
        if not cid:
            raise CourseError("Could not derive an id from the course name; set 'id' explicitly.")

    version = _finite(raw.get("version"))
    version = version if version else 1
    if version == int(version):
        version = int(version)

    aircraft_id_raw = raw.get("aircraftId")
    aircraft_id = str(aircraft_id_raw) if aircraft_id_raw not in (None, "") else None

    start_type = "air" if raw.get("startType") == "air" else "ground"

    return {"id": cid, "name": name, "version": version, "aircraftId": aircraft_id, "startType": start_type,
            "itemBoxes": normalize_item_boxes(raw), "gates": gates}


def normalize_item_boxes(raw: dict) -> list:
    """The optional powerups item boxes. Mirrors Course.normalizeItemBoxes() in race.js, except
    that race.js silently drops a malformed box (it must never block loading a course over a
    bonus feature) while this tool rejects it — same split as everywhere else in this file, and
    a typo'd box in the shared list would otherwise be invisible until someone flew past it.

    0.10.0 turned the single `itemBox` into a list of up to MAX_ITEM_BOXES. A course file written
    before that still reads, as a one-element list — that is the only reason the legacy key is
    still accepted, and it is never written back out.

    Boxes are NOT part of course_hash(): adding or moving them never resets a leaderboard."""
    boxes = raw.get("itemBoxes")
    if boxes is None:
        legacy = raw.get("itemBox")
        boxes = [] if legacy is None else [legacy]
    elif raw.get("itemBox") is not None:
        raise CourseError("a course sets either itemBoxes (0.10.0) or the legacy itemBox, not both.")
    if not isinstance(boxes, list):
        raise CourseError("itemBoxes must be a list of {lat, lon, alt, radius} objects.")
    if len(boxes) > MAX_ITEM_BOXES:
        raise CourseError(f"a course can have at most {MAX_ITEM_BOXES} item boxes; got {len(boxes)}.")
    return [normalize_item_box(b, i) for i, b in enumerate(boxes)]


def normalize_item_box(raw, index: int = 0) -> dict:
    where = f"itemBoxes[{index}]"
    if not isinstance(raw, dict):
        raise CourseError(f"{where} must be an object with lat/lon/alt (and an optional radius).")
    lat, lon, alt = _finite(raw.get("lat")), _finite(raw.get("lon")), _finite(raw.get("alt"))
    radius_raw = raw.get("radius")
    radius = DEFAULT_RADIUS_M if radius_raw is None else _finite(radius_raw)
    if any(v is None for v in (lat, lon, alt, radius)):
        raise CourseError(f"{where} needs finite lat/lon/alt (and radius, if given).")
    if abs(lat) > 90 or abs(lon) > 180:
        raise CourseError(f"{where} lat/lon out of range: {lat}, {lon}.")
    if radius <= 0 or radius > MAX_RADIUS_M:
        raise CourseError(f"{where} radius must be >0 and <={MAX_RADIUS_M}; got {radius}.")
    return {"lat": lat, "lon": lon, "alt": alt, "radius": radius}


def course_hash(course: dict) -> str:
    """Reimplements Course.hash() from race.js: FNV-1a over rounded geometry + the
    aircraft lock. Used only to name the leaderboard key in messages below; the actual
    --force decision uses a direct gate-value comparison (course_hash's toFixed-style
    rounding is a display nicety, not something to depend on for correctness)."""
    payload = [
        course["aircraftId"],
        [[f"{g['lat']:.6f}", f"{g['lon']:.6f}", f"{g['alt']:.1f}", f"{g['radius']:.1f}"] for g in course["gates"]],
    ]
    s = json.dumps(payload, separators=(",", ":"))
    h = 0x811C9DC5
    for ch in s:
        h ^= ord(ch)
        h = (h * 0x01000193) & 0xFFFFFFFF
    return format(h, "08x")


def _gate_signature(gates):
    return tuple((round(g["lat"], 6), round(g["lon"], 6), round(g["alt"], 1), round(g["radius"], 1)) for g in gates)


def geometry_changed(old: dict, new: dict) -> bool:
    return old.get("aircraftId") != new.get("aircraftId") or _gate_signature(old["gates"]) != _gate_signature(new["gates"])


def load_index() -> list:
    if not INDEX_PATH.exists():
        return []
    return json.loads(INDEX_PATH.read_text(encoding="utf-8"))


def write_index(entries: list) -> None:
    entries = sorted(entries, key=lambda e: e["id"])
    INDEX_PATH.write_text(json.dumps(entries, indent=2) + "\n", encoding="utf-8")


def upsert_index(course: dict, cup: str | None = None, difficulty: str | None = None) -> None:
    """Add/replace the course's index entry. The docs-only `cup`/`difficulty` fields (see
    race/courses/CUPS.md; the server's load_courses() reads them) are kept from the existing
    entry unless new values are given."""
    entries = load_index()
    entry = {"id": course["id"], "name": course["name"], "file": f"{course['id']}.json"}
    for i, e in enumerate(entries):
        if e.get("id") == course["id"]:
            for k in ("cup", "difficulty"):
                if k in e:
                    entry[k] = e[k]
            entries[i] = entry
            break
    else:
        entries.append(entry)
    if cup:
        entry["cup"] = cup
    if difficulty:
        entry["difficulty"] = difficulty
    write_index(entries)


def add_course(raw: dict, force: bool = False, cup: str | None = None, difficulty: str | None = None) -> dict:
    course = normalize(raw)
    course_path = COURSES_DIR / f"{course['id']}.json"

    if course_path.exists():
        existing = json.loads(course_path.read_text(encoding="utf-8"))
        existing_norm = normalize(existing)
        if geometry_changed(existing_norm, course):
            msg = (
                f"course '{course['id']}' already exists with different gate geometry "
                f"(hash {course_hash(existing_norm)} -> {course_hash(course)}); overwriting "
                "resets its leaderboard, since the board is keyed by geometry hash."
            )
            if not force:
                raise CourseError(msg + " Re-run with --force to overwrite anyway.")
            print(f"warning: {msg}", file=sys.stderr)

    COURSES_DIR.mkdir(parents=True, exist_ok=True)
    course_path.write_text(json.dumps(course, indent=2) + "\n", encoding="utf-8")
    upsert_index(course, cup=cup, difficulty=difficulty)
    return course


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("path", nargs="?", help="Path to the course JSON. Omit to read from stdin.")
    ap.add_argument("--force", action="store_true", help="Overwrite an existing course even if its gate geometry changed.")
    ap.add_argument("--cup", help="Cup name for the index entry (docs-only; see race/courses/CUPS.md).")
    ap.add_argument("--difficulty", help="Difficulty tag for the index entry (easy/medium/hard/tight).")
    args = ap.parse_args(argv)

    text = Path(args.path).read_text(encoding="utf-8") if args.path else sys.stdin.read()
    try:
        raw = json.loads(text)
    except json.JSONDecodeError as e:
        print(f"error: not valid JSON: {e}", file=sys.stderr)
        return 1

    try:
        course = add_course(raw, force=args.force, cup=args.cup, difficulty=args.difficulty)
    except CourseError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1

    course_path = COURSES_DIR / f"{course['id']}.json"
    print(f"Wrote {course_path.relative_to(REPO_ROOT)}")
    print(f"Updated {INDEX_PATH.relative_to(REPO_ROOT)}")
    print(f"id={course['id']} name={course['name']!r} gates={len(course['gates'])} "
          f"boxes={len(course['itemBoxes'])} hash={course_hash(course)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
