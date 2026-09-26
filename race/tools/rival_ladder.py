#!/usr/bin/env python3
"""Rival ladder outputs: the medal-time index, the solved-pace record, and the human sanity check.

  python rival_ladder.py index     # race/rivals/index.json + race/rivals/ladder.json
  python rival_ladder.py report    # markdown: rival times vs human records, solved paces, gaps

index.json is what the Career server, the site and the solo picker read for medal times without
downloading a single trace: one entry per shipped race/rivals/<course_id>.json, sorted by
course_id, [{course_id, course_hash, generator_version, rivals: [{rival_id, name, model, time_ms,
splits_ms}]}]. It is built only from shipped (verified) files, never from .pending.

ladder.json records what the ladder solver derived per course (rival_personas.solve_ladder):
each shipped rival's envelopeFrac, speedCap, solver stage and ratio to DAWG. It comes from the
.pending file whose rival time matches the shipped one; a course with no matching pending file
keeps whatever ladder.json already said about it.

Human records: race.finsonly.net's /courses (via envelope.cached_get, cached under rivals/cache)
when reachable, else race/rivals/records-snapshot.json. Only records on the course's CURRENT hash
count.
"""
from __future__ import annotations

import argparse
import json
import statistics
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import rival_common as rc  # noqa: E402

INDEX_PATH = rc.RIVALS_DIR / "index.json"
LADDER_PATH = rc.RIVALS_DIR / "ladder.json"
SNAPSHOT_PATH = rc.RIVALS_DIR / "records-snapshot.json"
HASHES_PATH = rc.RACE_DIR / "test" / "course_hashes.json"
ORDER = ("steve", "brat", "moo", "dawg")          # slowest to fastest
NOT_COURSE_FILES = {"index.json", "ladder.json", "personas.json", "records-snapshot.json"}


def shipped_files(rivals_dir=None):
    """{course_id: shipped rival file} for every race/rivals/<course_id>.json."""
    d = Path(rivals_dir or rc.RIVALS_DIR)
    out = {}
    for p in sorted(d.glob("*.json")):
        if p.name in NOT_COURSE_FILES or p.name.startswith("envelope-"):
            continue
        f = json.loads(p.read_text(encoding="utf-8"))
        if isinstance(f, dict) and "rivals" in f and "course_id" in f:
            out[f["course_id"]] = f
    return out


def index_entry(f):
    return {"course_id": f["course_id"], "course_hash": f["course_hash"], "generator_version": f["generator_version"],
            "rivals": [{k: r[k] for k in ("rival_id", "name", "model", "time_ms", "splits_ms")} for r in f["rivals"]]}


def build_index(files):
    return [index_entry(files[cid]) for cid in sorted(files)]


def build_ladder(files, pending_dir=None, old=None, personas=None):
    pend = Path(pending_dir or rc.PENDING_DIR)
    old_courses = (old or {}).get("courses", {})
    courses = {}
    for cid in sorted(files):
        f = files[cid]
        p = pend / f"{cid}.json"
        entry = None
        if p.exists():
            pf = json.loads(p.read_text(encoding="utf-8"))
            by = {r["rival_id"]: r for r in pf.get("rivals", [])}
            ok = pf.get("course_hash") == f["course_hash"] and all(
                r["rival_id"] in by and by[r["rival_id"]]["time_ms"] == r["time_ms"] for r in f["rivals"])
            if ok:
                lad = pf.get("ladder") or {}
                dawg_s = (lad.get("dawg") or {}).get("time_s")
                entry = {"course_hash": f["course_hash"], "dawg_model_s": round(dawg_s, 3) if dawg_s else None, "rivals": {}}
                for r in f["rivals"]:
                    pr, lr = by[r["rival_id"]], lad.get(r["rival_id"]) or {}
                    entry["rivals"][r["rival_id"]] = {
                        "envelopeFrac": pr.get("envelopeFrac"), "speedCap": pr.get("speedCap"), "time_ms": r["time_ms"],
                        "stage": lr.get("stage"), "clamped": lr.get("clamped"), "shifted": lr.get("shifted", False),
                        "ratio_target": lr.get("ratio_target")}
        if entry is None and cid in old_courses and old_courses[cid].get("course_hash") == f["course_hash"]:
            entry = old_courses[cid]
        if entry is not None:
            courses[cid] = entry
    ratios = (personas or {}).get("ladder", {}).get("ratios")
    return {"about": "Per-course pace the ladder solver derived (race/tools/rival_personas.py solve_ladder). Written by rival_ladder.py index; never hand-edited.",
            "ratios": ratios, "courses": courses}


def load_records(offline=True):
    """[{course_id, course_hash, record_ms, callsign?}] -- server first (unless offline), else the snapshot."""
    rows = None
    if not offline:
        try:
            import envelope as E
            rows = E.cached_get("/courses", {}, rc.CACHE_DIR, False)
        except Exception:                     # noqa: BLE001 -- unreachable server: fall back to the snapshot
            rows = None
    if rows:
        return [{"course_id": r.get("course_id"), "course_hash": r.get("course_hash"), "record_ms": r.get("record_ms")}
                for r in rows if r.get("record_ms")], "server"
    snap = json.loads(SNAPSHOT_PATH.read_text(encoding="utf-8"))
    return snap["records"], "snapshot " + snap.get("source", "")


def rung_of(record_ms, times):
    """Where a record lands on the ladder: 'above DAWG' (faster than every rival), 'DAWG-MOO',
    'MOO-BRAT', 'BRAT-STEVE' or 'below STEVE' (slower than every rival)."""
    names = [k for k in ("dawg", "moo", "brat", "steve") if k in times]
    prev = None
    for k in names:
        if record_ms < times[k]:
            return f"above {k.upper()}" if prev is None else f"{prev.upper()}-{k.upper()}"
        prev = k
    return f"below {prev.upper()}" if prev else "-"


def fmt(ms):
    if ms is None:
        return "-"
    s = ms / 1000.0
    return f"{int(s // 60)}:{s % 60:06.3f}"


def report(files, ladder, records, source, hashes, cups):
    out = []
    recs = {r["course_id"]: r for r in records if hashes.get(r["course_id"]) == r.get("course_hash")}
    out.append(f"Records: {source}; {len(recs)} on the current course hash.\n")
    out.append("| Course | STEVE | BRAT | MOO | DAWG | Record | Record/DAWG | Record lands |")
    out.append("|---|---|---|---|---|---|---|---|")
    ratios = []
    for cid in sorted(files, key=lambda c: (c not in recs, c)):
        t = {r["rival_id"]: r["time_ms"] for r in files[cid]["rivals"]}
        rec = recs.get(cid)
        rr = f"{rec['record_ms'] / t['dawg']:.3f}" if rec and "dawg" in t else "-"
        if rec and "dawg" in t:
            ratios.append(rec["record_ms"] / t["dawg"])
        out.append(f"| {cid} | " + " | ".join(fmt(t.get(k)) for k in ORDER) +
                   f" | {fmt(rec['record_ms']) if rec else '-'} | {rr} | {rung_of(rec['record_ms'], t) if rec else '-'} |")
    if ratios:
        out.append(f"\nMedian record/DAWG: {statistics.median(ratios):.3f} over {len(ratios)} record course(s); "
                   f"min {min(ratios):.3f}, max {max(ratios):.3f}.")
    out.append("\n## Solved pace per persona (derived, not tuned)\n")
    out.append("| Persona | courses | envelopeFrac min / median / max | speedCap min / median / max | stages | clamped | shifted | ratio to DAWG min / median / max |")
    out.append("|---|---|---|---|---|---|---|---|")
    for rid in ("moo", "brat", "steve"):
        rows = [(cid, c["rivals"][rid]) for cid, c in ladder.get("courses", {}).items() if rid in c["rivals"]]
        if not rows:
            continue
        fr = [r["envelopeFrac"] for _, r in rows]
        cp = [r["speedCap"] for _, r in rows]
        stages = {}
        for _, r in rows:
            stages[r.get("stage")] = stages.get(r.get("stage"), 0) + 1
        clamped = [f"{cid} ({r['clamped']})" for cid, r in rows if r.get("clamped")]
        shifted = [cid for cid, r in rows if r.get("shifted")]
        rat = [files[cid]["rivals"][[x["rival_id"] for x in files[cid]["rivals"]].index(rid)]["time_ms"] /
               {x["rival_id"]: x["time_ms"] for x in files[cid]["rivals"]}["dawg"]
               for cid, _ in rows if "dawg" in {x["rival_id"] for x in files[cid]["rivals"]}]
        out.append(f"| {rid.upper()} | {len(rows)} | {min(fr):.3f} / {statistics.median(fr):.3f} / {max(fr):.3f} | "
                   f"{min(cp):.3f} / {statistics.median(cp):.3f} / {max(cp):.3f} | "
                   + ", ".join(f"{k}: {v}" for k, v in sorted(stages.items(), key=lambda kv: str(kv[0]))) +
                   f" | {', '.join(clamped) or 'none'} | {', '.join(shifted) or 'none'} | "
                   + (f"{min(rat):.4f} / {statistics.median(rat):.4f} / {max(rat):.4f} |" if rat else "- |"))
    out.append("\n## Career cups\n")
    by_cup = {}
    for cid, cup in cups.items():
        by_cup.setdefault(cup or "(no cup)", []).append(cid)
    out.append("| Cup | courses with all 4 rivals | missing |")
    out.append("|---|---|---|")
    for cup in sorted(by_cup):
        ids = sorted(by_cup[cup])
        full = [c for c in ids if c in files and len(files[c]["rivals"]) == 4]
        miss = [f"{c} ({len(files[c]['rivals']) if c in files else 0}/4)" for c in ids if c not in full]
        out.append(f"| {cup} | {len(full)}/{len(ids)} | {', '.join(miss) or '-'} |")
    return "\n".join(out) + "\n"


def dump_lines(rows):
    """A JSON array, one compact row per line: small diffs, one course per line."""
    return "[\n" + ",\n".join(json.dumps(r, separators=(",", ":")) for r in rows) + "\n]\n"


def dump_ladder(lad):
    head = {k: v for k, v in lad.items() if k != "courses"}
    body = ",\n".join(f"  {json.dumps(cid)}: {json.dumps(c, separators=(',', ':'))}" for cid, c in lad["courses"].items())
    return json.dumps(head, indent=1)[:-2] + (',\n "courses": {\n' + body + "\n }\n}\n" if body else ',\n "courses": {}\n}\n')


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=("index", "report"))
    ap.add_argument("--online", action="store_true", help="report: try the server's records first")
    args = ap.parse_args(argv)
    files = shipped_files()
    if args.cmd == "index":
        INDEX_PATH.write_text(dump_lines(build_index(files)), encoding="utf-8")
        old = json.loads(LADDER_PATH.read_text(encoding="utf-8")) if LADDER_PATH.exists() else None
        personas = json.loads((rc.RIVALS_DIR / "personas.json").read_text(encoding="utf-8"))
        LADDER_PATH.write_text(dump_ladder(build_ladder(files, old=old, personas=personas)), encoding="utf-8")
        print(f"index.json: {len(files)} course(s); ladder.json written")
        return 0
    ladder = json.loads(LADDER_PATH.read_text(encoding="utf-8")) if LADDER_PATH.exists() else {}
    records, source = load_records(offline=not args.online)
    hashes = json.loads(HASHES_PATH.read_text(encoding="utf-8"))
    _, cups = rc.load_course_files()
    sys.stdout.write(report(files, ladder, records, source, hashes, cups))
    return 0


if __name__ == "__main__":
    sys.exit(main())
