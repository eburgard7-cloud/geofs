#!/usr/bin/env python3
"""One-time (but idempotent) backfill of record_events from the existing `runs` table.

    python race/tools/backfill_records.py --db /path/to/race.db
    python race/tools/backfill_records.py --db /path/to/race.db --dry-run

record_events (race/server/app.py) is written going forward by post_run() every time a POST /runs
submission beats the current course record. This script reconstructs that history for runs that
already existed before the feature shipped: for each course_hash, in submission order
(created_at), it tracks the running fastest time and inserts one record_events row every time a
run beats it -- exactly the same "strictly faster than the previous best" rule post_run() applies
live.

Idempotent: before inserting a candidate row it checks whether one already exists with the same
(course_hash, callsign, time_ms, created_at) -- deterministic from `runs`, so a re-run recomputes
the identical candidates and inserts nothing new. Safe to run against a database that already has
some live-written record_events rows mixed in (their created_at values come from time.time() at
submission, same column, same uniqueness check).
"""
from __future__ import annotations

import argparse
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))
from app import callsign_key  # noqa: E402  (after sys.path fixup, matches this repo's other tools/*.py)


def backfill(conn: sqlite3.Connection, dry_run: bool = False) -> int:
    """Returns the number of record_events rows inserted (or that WOULD be, if dry_run)."""
    conn.row_factory = sqlite3.Row
    pilots = {r["callsign_key"]: r["pilot_id"] for r in conn.execute(
        "SELECT callsign_key, pilot_id FROM pilots")}
    rows = conn.execute(
        """SELECT course_hash, callsign, time_ms, created_at FROM runs
           ORDER BY course_hash, created_at ASC, id ASC""").fetchall()

    best: dict[str, tuple[str, int]] = {}   # course_hash -> (holder callsign, time_ms)
    inserted = 0
    for r in rows:
        ch, cs, t, created = r["course_hash"], r["callsign"], r["time_ms"], r["created_at"]
        prev = best.get(ch)
        if prev is not None and t >= prev[1]:
            continue
        prev_holder, prev_time_ms = (prev[0], prev[1]) if prev is not None else (None, None)
        best[ch] = (cs, t)
        exists = conn.execute(
            """SELECT 1 FROM record_events
               WHERE course_hash = ? AND callsign = ? AND time_ms = ? AND created_at = ?""",
            (ch, cs, t, created)).fetchone()
        if exists:
            continue
        inserted += 1
        if dry_run:
            print(f"  would insert: {ch} {cs} {t}ms (prev: {prev_holder} {prev_time_ms}ms)")
            continue
        conn.execute(
            """INSERT INTO record_events (course_hash, pilot_id, callsign, time_ms, prev_holder,
                   prev_time_ms, created_at) VALUES (?,?,?,?,?,?,?)""",
            (ch, pilots.get(callsign_key(cs)), cs, t, prev_holder, prev_time_ms, created))
    if not dry_run:
        conn.commit()
    return inserted


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--db", required=True, help="path to race.db")
    p.add_argument("--dry-run", action="store_true", help="report what would be inserted, write nothing")
    args = p.parse_args(argv)

    conn = sqlite3.connect(args.db)
    try:
        conn.execute("SELECT 1 FROM record_events LIMIT 1")
    except sqlite3.OperationalError:
        print("record_events table does not exist yet -- start the server once first "
             "(it runs SCHEMA/migrate() on startup), then re-run this script.", file=sys.stderr)
        return 1
    n = backfill(conn, args.dry_run)
    print(f"{'would insert' if args.dry_run else 'inserted'} {n} record_events row(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
