"""Mode leaderboards (proto 6): create `mode_runs` and backfill it from the legacy `runs` table.

Standalone and stdlib-only on purpose: DEPLOY_CHECKLIST.md runs it against the live race.db from
a throwaway python:3.12-slim container BEFORE the new image is built, so it cannot import app.py
or anything in requirements.txt. app.py also calls migrate_modes() on every start, the same way it
calls migrate(), so a skipped manual step can never leave the new endpoints without their table.

Additive only. It creates one table and one index, and INSERTs into that table. It never DROPs,
ALTERs or UPDATEs anything, and never writes to `runs`: the legacy table and every endpoint that
reads it (GET /leaderboard, /courses, /news, the course vote) are exactly as they were.

Idempotent: every backfilled row carries the legacy `runs.id` it came from in `legacy_run_id`,
which is UNIQUE, and the backfill is INSERT OR IGNORE. A second run inserts nothing.

    python migrate_modes.py --db /data/race.db
"""
import argparse
import json
import os
import sqlite3
import sys

# `metric_value` is the one number a mode ranks on; `direction` says which way is better
# ('asc' = lower wins, 'desc' = higher wins). It is copied onto every row so a row read on its own
# says how to compare it, but ranking always takes the direction from the registry in app.py.
# `course_hash` and `legacy_run_id` are beyond the minimum a mode needs: race boards are keyed on
# the course version (hash), and legacy_run_id is what makes the backfill safe to repeat.
MODE_SCHEMA = """
CREATE TABLE IF NOT EXISTS mode_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pilot_id TEXT,
  callsign TEXT NOT NULL,
  course_id TEXT NOT NULL,
  course_hash TEXT NOT NULL DEFAULT '',
  mode_id TEXT NOT NULL,
  metric_value REAL NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('asc', 'desc')),
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  legacy_run_id INTEGER UNIQUE
);
CREATE INDEX IF NOT EXISTS mode_runs_board ON mode_runs(mode_id, course_hash, callsign, metric_value);
"""


def race_payload(splits, gates, length_m, model, aircraft_id) -> str:
    """The payload_json of a 'race' row: what the legacy row held beyond its time. Shared by the
    backfill here and POST /runs's dual write in app.py, so both produce the same shape."""
    if isinstance(splits, str):
        try:
            splits = json.loads(splits)
        except ValueError:
            splits = []
    return json.dumps({"splits": splits, "gates": gates, "length_m": length_m,
                       "model": model or "", "aircraft_id": aircraft_id or ""},
                      separators=(",", ":"))


def _table_exists(conn: sqlite3.Connection, table: str) -> bool:
    return conn.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
                        (table,)).fetchone() is not None


def _has_column(conn: sqlite3.Connection, table: str, column: str) -> bool:
    return any(r[1] == column for r in conn.execute(f"PRAGMA table_info({table})"))


def migrate_modes(conn: sqlite3.Connection) -> dict:
    """Create mode_runs if missing and copy in every legacy run it does not already hold.
    Returns {"backfilled": n, "present": m}. Does not commit; the caller owns the transaction."""
    conn.executescript(MODE_SCHEMA)
    if not _table_exists(conn, "runs"):
        return {"backfilled": 0, "present": 0}
    # pilot_id arrives on `runs` through app.py's migrate(); a database that has never been
    # opened by a 1.2.0+ server does not have it yet, and the backfill must not require it.
    pilot = "r.pilot_id" if _has_column(conn, "runs", "pilot_id") else "NULL"
    todo = conn.execute(
        f"""SELECT r.id, {pilot} AS pilot_id, r.callsign, r.course_id, r.course_hash, r.time_ms,
                   r.splits, r.gates, r.length_m, r.model, r.aircraft_id, r.created_at
            FROM runs r LEFT JOIN mode_runs m ON m.legacy_run_id = r.id
            WHERE m.id IS NULL ORDER BY r.id""").fetchall()
    before = conn.execute("SELECT COUNT(*) FROM mode_runs WHERE legacy_run_id IS NOT NULL").fetchone()[0]
    conn.executemany(
        """INSERT OR IGNORE INTO mode_runs (pilot_id, callsign, course_id, course_hash, mode_id,
               metric_value, direction, payload_json, created_at, legacy_run_id)
           VALUES (?, ?, ?, ?, 'race', ?, 'asc', ?, ?, ?)""",
        [(r[1], r[2], r[3], r[4], r[5], race_payload(r[6], r[7], r[8], r[9], r[10]), r[11], r[0])
         for r in todo])
    after = conn.execute("SELECT COUNT(*) FROM mode_runs WHERE legacy_run_id IS NOT NULL").fetchone()[0]
    return {"backfilled": after - before, "present": before}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--db", default=os.environ.get("RACE_DB", "/data/race.db"),
                    help="path to race.db (default: $RACE_DB or /data/race.db)")
    args = ap.parse_args(argv)
    if not os.path.exists(args.db):
        print(f"no database at {args.db}", file=sys.stderr)
        return 1
    conn = sqlite3.connect(args.db, timeout=30)
    try:
        with conn:
            res = migrate_modes(conn)
    finally:
        conn.close()
    print(f"mode_runs: {res['backfilled']} backfilled, {res['present']} already present")
    return 0


if __name__ == "__main__":
    sys.exit(main())
