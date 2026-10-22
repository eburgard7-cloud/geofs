"""Liveries and the Garage: the catalog index, Garage identity, equips and customs.

No FastAPI and no sockets here: app.py owns the routes and the relay glue, this module owns the
rules and the SQLite rows behind them, so the tests drive it with plain values and a connection
(the same split as dash_engine.py).

The livery tools (tools/livery_*.py) resolve every path from their own location
(tools/livery_common.py: ROOT = tools/..), so the server never moves them: RACE_LIVERY_TOOLS is the
tools/ directory and RACE_LIVERIES_DIR its sibling liveries/. Catalog `files` are relative to
their shared parent (the repo root, or /app/livery in the image).
"""
from __future__ import annotations

import hashlib
import importlib
import json
import os
import secrets
import sqlite3
import sys
from types import SimpleNamespace
from typing import Optional

# Everything the Garage persists. All CREATE ... IF NOT EXISTS, run on every start after app.py's
# own SCHEMA, so an existing race.db gains these tables and nothing else changes.
SCHEMA = """
-- One-time link codes. Generic on purpose: `purpose` 'garage' turns a pilot_token into a garage
-- token for the site/phone (POST /garage/link); phone-dash pairing reuses it with its own purpose.
CREATE TABLE IF NOT EXISTS link_codes (
  code       TEXT PRIMARY KEY,
  purpose    TEXT NOT NULL,
  pilot_id   TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER
);
-- Garage tokens: scoped to garage actions for one pilot, 30 days, revocable. Only the hash is
-- stored, like pilots.token_hash.
CREATE TABLE IF NOT EXISTS garage_tokens (
  token_hash TEXT PRIMARY KEY,
  pilot_id   TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS garage_tokens_pilot ON garage_tokens(pilot_id);
-- What each pilot wears on each aircraft (catalog aircraft keys: f16, b757, ...). livery_id is a
-- catalog id or custom:<id>; NULL (or no row) is stock paint.
CREATE TABLE IF NOT EXISTS livery_equips (
  pilot_id   TEXT NOT NULL,
  aircraft   TEXT NOT NULL,
  livery_id  TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (pilot_id, aircraft)
);
CREATE INDEX IF NOT EXISTS livery_equips_livery ON livery_equips(livery_id);
-- Pilots' own liveries: a recolor (template + params) or an upload. `files` is a JSON list of
-- {sha, ext} in catalog order (the Rafale has [main, spec]); `sha` repeats the main one for lookups.
-- status: approved | pending (uploads, until an admin looks) | rejected (+ reason).
CREATE TABLE IF NOT EXISTS livery_customs (
  id          TEXT PRIMARY KEY,
  pilot_id    TEXT NOT NULL,
  aircraft    TEXT NOT NULL,
  kind        TEXT NOT NULL,
  name        TEXT NOT NULL,
  sha         TEXT NOT NULL,
  files       TEXT NOT NULL,
  template    TEXT,
  params      TEXT,
  render_key  TEXT,
  status      TEXT NOT NULL,
  reason      TEXT,
  created_at  INTEGER NOT NULL,
  reviewed_at INTEGER
);
CREATE INDEX IF NOT EXISTS livery_customs_pilot ON livery_customs(pilot_id, created_at);
CREATE INDEX IF NOT EXISTS livery_customs_sha ON livery_customs(sha);
CREATE INDEX IF NOT EXISTS livery_customs_status ON livery_customs(status, created_at);
-- Finished recolors by (template, cleaned params): the same choices always give the same pixels,
-- so a second pilot (or the same one again) gets the file instantly instead of a 60 s render.
CREATE TABLE IF NOT EXISTS livery_render_cache (
  render_key TEXT PRIMARY KEY,
  template   TEXT NOT NULL,
  aircraft   TEXT NOT NULL,
  files      TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
-- One row per render started / upload accepted, for the per-pilot daily caps (day = ramp_day()).
CREATE TABLE IF NOT EXISTS livery_render_log (
  pilot_id   TEXT NOT NULL,
  day        TEXT NOT NULL,
  kind       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS livery_render_log_day ON livery_render_log(pilot_id, day, kind);
"""


# ----------------------------------------------------------------------------- identity
LINK_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"   # no 0/O, 1/I/L: read off one screen, typed on another
LINK_CODE_LEN = 6
LINK_CODE_TTL_S = 300
GARAGE_TOKEN_TTL_S = 30 * 24 * 3600
PURPOSE_GARAGE = "garage"


def hash_token(token: str) -> str:
    """The same hash as app.py's pilots.token_hash: the database never holds a working token."""
    return hashlib.sha256((token or "").encode("utf-8")).hexdigest()


def new_link_code(rng=None) -> str:
    rng = rng or secrets.SystemRandom()
    return "".join(rng.choice(LINK_ALPHABET) for _ in range(LINK_CODE_LEN))


def normalize_code(code) -> str:
    """Pure: what a person types ('abc-123 ', 'Abc 123') -> 'ABC123'."""
    return "".join(ch for ch in str(code or "").upper() if ch.isalnum())


def issue_link_code(conn: sqlite3.Connection, purpose: str, pilot_id: str, now: int,
                    ttl: int = LINK_CODE_TTL_S, rng=None) -> str:
    """Mint a single-use code for `pilot_id`, valid `ttl` seconds. Codes a day past expiry are swept."""
    conn.execute("DELETE FROM link_codes WHERE expires_at < ?", (now - 86400,))
    for _ in range(50):
        code = new_link_code(rng)
        try:
            conn.execute("INSERT INTO link_codes (code, purpose, pilot_id, created_at, expires_at)"
                         " VALUES (?, ?, ?, ?, ?)", (code, purpose, pilot_id, now, now + ttl))
            return code
        except sqlite3.IntegrityError:      # collides with a live (or recently dead) code: redraw
            continue
    raise RuntimeError("could not mint a link code")


def redeem_link_code(conn: sqlite3.Connection, purpose: str, code, now: int) -> tuple[Optional[str], Optional[str]]:
    """-> (pilot_id, None), or (None, reason) with reason 'unknown' / 'used' / 'expired'. A code
    minted for another purpose is 'unknown' to this one. Single use is the conditional UPDATE:
    two redeems racing for one code can't both win."""
    row = conn.execute("SELECT * FROM link_codes WHERE code = ?", (normalize_code(code),)).fetchone()
    if row is None or row["purpose"] != purpose:
        return None, "unknown"
    if row["used_at"] is not None:
        return None, "used"
    if row["expires_at"] <= now:
        return None, "expired"
    cur = conn.execute("UPDATE link_codes SET used_at = ? WHERE code = ? AND used_at IS NULL AND expires_at > ?",
                       (now, row["code"], now))
    if cur.rowcount != 1:
        return None, "used"
    return row["pilot_id"], None


def issue_garage_token(conn: sqlite3.Connection, pilot_id: str, now: int,
                       ttl: int = GARAGE_TOKEN_TTL_S) -> tuple[str, int]:
    token = "g_" + secrets.token_urlsafe(24)
    conn.execute("INSERT INTO garage_tokens (token_hash, pilot_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
                 (hash_token(token), pilot_id, now, now + ttl))
    return token, now + ttl


def garage_token_pilot(conn: sqlite3.Connection, token: Optional[str], now: int) -> Optional[str]:
    """pilot_id for a live (unexpired, unrevoked) garage token, else None."""
    if not token:
        return None
    row = conn.execute("SELECT pilot_id FROM garage_tokens WHERE token_hash = ? AND revoked_at IS NULL"
                       " AND expires_at > ?", (hash_token(token), now)).fetchone()
    return row["pilot_id"] if row else None


def revoke_garage_token(conn: sqlite3.Connection, token: str, now: int) -> int:
    return conn.execute("UPDATE garage_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL",
                        (now, hash_token(token))).rowcount


def revoke_pilot_garage_tokens(conn: sqlite3.Connection, pilot_id: str, now: int) -> int:
    return conn.execute("UPDATE garage_tokens SET revoked_at = ? WHERE pilot_id = ? AND revoked_at IS NULL",
                        (now, pilot_id)).rowcount


# ----------------------------------------------------------------------------- customs + equips
CUSTOM_PREFIX = "custom:"
AIRCRAFT_RE = r"^[a-z0-9_]{1,32}$"
LIVERY_ID_RE = r"^(custom:[0-9a-f]{12}|[a-z0-9_]{1,64})$"


def parse_livery_id(livery_id: str) -> tuple[str, str]:
    """Pure: 'custom:abc123def456' -> ('custom', 'abc123def456'); anything else is a catalog id."""
    if livery_id.startswith(CUSTOM_PREFIX):
        return "custom", livery_id[len(CUSTOM_PREFIX):]
    return "catalog", livery_id


def custom_files(row) -> list[dict]:
    return json.loads(row["files"])


def custom_urls(row) -> list[str]:
    return [file_url(f["sha"], f["ext"]) for f in custom_files(row)]


def get_custom(conn: sqlite3.Connection, cid: str):
    return conn.execute("SELECT * FROM livery_customs WHERE id = ?", (cid,)).fetchone()


def insert_custom(conn: sqlite3.Connection, *, pilot_id: str, aircraft: str, kind: str, name: str,
                  files: list[dict], status: str, now: int, template: Optional[str] = None,
                  params: Optional[dict] = None, render_key: Optional[str] = None) -> str:
    cid = secrets.token_hex(6)
    conn.execute(
        """INSERT INTO livery_customs (id, pilot_id, aircraft, kind, name, sha, files, template, params,
               render_key, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
        (cid, pilot_id, aircraft, kind, name, files[0]["sha"],
         json.dumps([{"sha": f["sha"], "ext": f["ext"]} for f in files]), template,
         json.dumps(params, sort_keys=True) if params is not None else None, render_key, status, now))
    return cid


def set_custom_status(conn: sqlite3.Connection, cid: str, status: str, reason: Optional[str], now: int) -> None:
    conn.execute("UPDATE livery_customs SET status = ?, reason = ?, reviewed_at = ? WHERE id = ?",
                 (status, reason, now, cid))


def count_customs(conn: sqlite3.Connection, pilot_id: str) -> int:
    return conn.execute("SELECT COUNT(*) FROM livery_customs WHERE pilot_id = ? AND status != 'rejected'",
                        (pilot_id,)).fetchone()[0]


def check_equip(pilot_id: str, aircraft: str, kind: str, obj, unlocked: bool = True,
                unlock_text: str = "") -> Optional[tuple[int, str]]:
    """Pure: may `pilot_id` wear `obj` (a catalog entry, or a livery_customs row) on `aircraft`?
    None if so, else (HTTP status, message for the pilot). PUT /garage/equip and the relay's
    `livery` frame both ask exactly this."""
    if obj is None:
        return 404, "No such livery."
    if obj["aircraft"] != aircraft:
        return 400, "That livery is for another aircraft."
    if kind == "custom":
        if obj["pilot_id"] != pilot_id:
            return 403, "That's another pilot's livery."
        if obj["status"] == "rejected":
            return 409, "That livery was rejected" + (f": {obj['reason']}" if obj["reason"] else ".")
        return None       # the owner may wear their own pending upload; nobody else sees it
    if obj.get("category") == "gungame" or (obj.get("requires") or {}).get("mode"):
        return 400, "Gun Game paints are applied by the mode, not equipped."
    if not unlocked:
        return 403, f"Locked: {unlock_text}"
    return None


def pilot_equips(conn: sqlite3.Connection, pilot_id: str) -> dict[str, str]:
    """{aircraft: livery_id} for every non-stock equip."""
    return {r["aircraft"]: r["livery_id"] for r in conn.execute(
        "SELECT aircraft, livery_id FROM livery_equips WHERE pilot_id = ? AND livery_id IS NOT NULL", (pilot_id,))}


def set_equip(conn: sqlite3.Connection, pilot_id: str, aircraft: str, livery_id: Optional[str], now: int) -> None:
    conn.execute("""INSERT INTO livery_equips (pilot_id, aircraft, livery_id, updated_at) VALUES (?,?,?,?)
                    ON CONFLICT(pilot_id, aircraft) DO UPDATE SET livery_id = excluded.livery_id,
                    updated_at = excluded.updated_at""", (pilot_id, aircraft, livery_id, now))


def unequip_everywhere(conn: sqlite3.Connection, livery_id: str, now: int) -> list[str]:
    """Back to stock for everyone wearing `livery_id`; -> the pilot_ids that were."""
    pids = [r[0] for r in conn.execute("SELECT pilot_id FROM livery_equips WHERE livery_id = ?", (livery_id,))]
    conn.execute("UPDATE livery_equips SET livery_id = NULL, updated_at = ? WHERE livery_id = ?", (now, livery_id))
    return pids


def resolve_equips(conn: sqlite3.Connection, cat: LiveryCatalog, pilot_id: str) -> dict[str, dict]:
    """{aircraft: {livery_id, urls, pending}} for what the pilot wears and the server can serve.
    A rejected (or deleted) custom, or a catalog entry whose files are gone, reads as stock."""
    out = {}
    for ac, lid in pilot_equips(conn, pilot_id).items():
        if ac not in cat.aircraft:
            continue
        kind, key = parse_livery_id(lid)
        if kind == "catalog":
            urls = cat.urls.get(key)
            if urls:
                out[ac] = {"livery_id": lid, "urls": urls, "pending": False}
            continue
        row = get_custom(conn, key)
        if row is None or row["status"] == "rejected" or row["pilot_id"] != pilot_id:
            continue
        out[ac] = {"livery_id": lid, "urls": custom_urls(row), "pending": row["status"] == "pending"}
    return out


def visible_liveries(resolved: dict[str, dict], own: bool) -> dict[str, Optional[list[str]]]:
    """Pure: what one viewer is told a pilot wears: {aircraft: [url, ...] or None}. A pending
    upload is its owner's alone; everyone else sees stock (None) until it is approved."""
    return {ac: (r["urls"] if own or not r["pending"] else None) for ac, r in resolved.items()}

# Served texture formats. The catalog and every custom are one of these (the factory's and
# tools/livery_upload.py's output contract).
CONTENT_TYPES = {"png": "image/png", "webp": "image/webp", "jpg": "image/jpeg"}
SHA_RE = r"[0-9a-f]{64}"


def file_ext(path: str) -> Optional[str]:
    """Pure: 'png' / 'webp' / 'jpg' for a texture path, None for anything else."""
    ext = os.path.splitext(path)[1].lower().lstrip(".")
    ext = "jpg" if ext == "jpeg" else ext
    return ext if ext in CONTENT_TYPES else None


def file_url(sha: str, ext: str) -> str:
    """Root-relative: the client prefixes its own API base (race.js API_BASE, the site's origin)."""
    return f"/liveries/files/{sha}.{ext}"


def blueprint_url(sha: str) -> str:
    return f"/liveries/blueprint/{sha}.png"


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


class LiveryCatalog:
    """liveries/catalog.json plus a content-addressed index of every file it names.

    `files[sha]` -> {path, ext, aircraft, livery_id, main}; `urls[livery_id]` -> [url, ...] in the
    entry's `files` order, or None when any of its files is missing on disk (the entry is then
    listed but cannot be equipped or served)."""

    def __init__(self, raw: dict, root: str, hash_cache: dict):
        self.raw = raw
        self.root = os.path.realpath(root)
        self.aircraft: dict = raw.get("aircraft", {})
        self.entries: dict[str, dict] = {}
        self.files: dict[str, dict] = {}
        self.urls: dict[str, Optional[list[str]]] = {}
        self.shas: dict[str, Optional[list[str]]] = {}
        # Blueprints need the aircraft's geometry map (liveries/uv/<ac>.json); the Rafale has none.
        self.blueprint_ok = {ac: os.path.isfile(os.path.join(self.root, "liveries", "uv", f"{ac}.json"))
                             for ac in self.aircraft}
        for e in raw.get("liveries", []):
            self.entries[e["id"]] = e
            urls, shas = [], []
            for i, rel in enumerate(e.get("files") or []):
                path = os.path.realpath(os.path.join(self.root, rel))
                ext = file_ext(path)
                # A catalog path that escapes the root, or isn't a texture, is never served.
                if ext is None or not path.startswith(self.root + os.sep) or not os.path.isfile(path):
                    urls = None
                    break
                st = os.stat(path)
                hit = hash_cache.get(path)
                if hit is None or hit[0] != st.st_mtime_ns or hit[1] != st.st_size:
                    hit = (st.st_mtime_ns, st.st_size, sha256_file(path))
                    hash_cache[path] = hit
                sha = hit[2]
                self.files.setdefault(sha, {"path": path, "ext": ext, "aircraft": e["aircraft"],
                                            "livery_id": e["id"], "main": i == 0})
                urls.append(file_url(sha, ext))
                shas.append(sha)
            if not e.get("files"):
                urls = None
            self.urls[e["id"]] = urls
            self.shas[e["id"]] = shas if urls is not None else None

    def __len__(self) -> int:
        return len(self.entries)

    def blueprint_url_for(self, livery_id: str) -> Optional[str]:
        e, shas = self.entries.get(livery_id), self.shas.get(livery_id)
        if not e or not shas or not self.blueprint_ok.get(e["aircraft"]):
            return None
        return blueprint_url(shas[0])

    def public(self) -> dict:
        """What GET /liveries/catalog serves: catalog.json, each entry plus its served `urls` and
        `blueprint_url`."""
        return {**{k: v for k, v in self.raw.items() if k != "liveries"},
                "liveries": [{**e, "urls": self.urls.get(e["id"]),
                              "blueprint_url": self.blueprint_url_for(e["id"])}
                             for e in self.raw["liveries"]]}


def load_catalog(liveries_dir: str, hash_cache: dict) -> LiveryCatalog:
    """Raises OSError / ValueError when catalog.json is missing or unreadable."""
    with open(os.path.join(liveries_dir, "catalog.json"), encoding="utf-8") as f:
        raw = json.load(f)
    if not isinstance(raw, dict) or not isinstance(raw.get("liveries"), list):
        raise ValueError("catalog.json has no liveries list")
    return LiveryCatalog(raw, os.path.dirname(os.path.realpath(liveries_dir)), hash_cache)


def load_tools(tools_dir: str) -> SimpleNamespace:
    """Import tools/livery_{templates,upload,views}.py from `tools_dir`. Raises ImportError (or
    whatever the import raises) when they are missing; the caller turns that into "feature off"."""
    tools_dir = os.path.realpath(tools_dir)
    if not os.path.isfile(os.path.join(tools_dir, "livery_templates.py")):
        raise ImportError(f"no livery tools in {tools_dir}")
    if tools_dir not in sys.path:
        sys.path.insert(0, tools_dir)
    return SimpleNamespace(templates=importlib.import_module("livery_templates"),
                           upload=importlib.import_module("livery_upload"),
                           views=importlib.import_module("livery_views"),
                           common=importlib.import_module("livery_common"))


def tools_problem(tools_dir: str, liveries_dir: str) -> Optional[str]:
    """Pure-ish: the tools read <tools_dir>/../liveries, whatever RACE_LIVERIES_DIR says. A deploy
    that points the two apart would serve one catalog and render with another, so say so."""
    a = os.path.normcase(os.path.realpath(os.path.join(tools_dir, "..", "liveries")))
    b = os.path.normcase(os.path.realpath(liveries_dir))
    return None if a == b else f"livery tools read {a}, but RACE_LIVERIES_DIR is {b}"


# ----------------------------------------------------------------------------- recolor + uploads
def render_key(template: str, cleaned: dict) -> str:
    """Pure: the cache key for a recolor. `cleaned` is clean_params()'s output (defaults filled,
    text uppercased), so two spellings of the same choice share one render."""
    return hashlib.sha256(json.dumps([template, cleaned], sort_keys=True, separators=(",", ":"))
                          .encode("utf-8")).hexdigest()


def cached_render(conn: sqlite3.Connection, key: str) -> Optional[list[dict]]:
    row = conn.execute("SELECT files FROM livery_render_cache WHERE render_key = ?", (key,)).fetchone()
    return json.loads(row["files"]) if row else None


def store_render(conn: sqlite3.Connection, key: str, template: str, aircraft: str, files: list[dict], now: int) -> None:
    conn.execute("INSERT OR IGNORE INTO livery_render_cache (render_key, template, aircraft, files, created_at)"
                 " VALUES (?,?,?,?,?)", (key, template, aircraft,
                                         json.dumps([{"sha": f["sha"], "ext": f["ext"]} for f in files]), now))


def custom_by_key(conn: sqlite3.Connection, pilot_id: str, key: str):
    """The pilot's own (non-rejected) custom from this exact recolor, if they already have one."""
    return conn.execute("SELECT * FROM livery_customs WHERE pilot_id = ? AND render_key = ? AND status != 'rejected'"
                        " ORDER BY created_at LIMIT 1", (pilot_id, key)).fetchone()


def log_render(conn: sqlite3.Connection, pilot_id: str, day: str, kind: str, now: int) -> None:
    conn.execute("INSERT INTO livery_render_log (pilot_id, day, kind, created_at) VALUES (?,?,?,?)",
                 (pilot_id, day, kind, now))
    conn.execute("DELETE FROM livery_render_log WHERE created_at < ?", (now - 8 * 86400,))


def renders_on(conn: sqlite3.Connection, pilot_id: str, day: str, kind: str) -> int:
    return conn.execute("SELECT COUNT(*) FROM livery_render_log WHERE pilot_id = ? AND day = ? AND kind = ?",
                        (pilot_id, day, kind)).fetchone()[0]


def file_still_used(conn: sqlite3.Connection, sha: str) -> bool:
    """Is `sha` still part of a non-rejected custom or a cached render? (Then a reject or delete
    must leave the file on disk.)"""
    like = f'%"{sha}"%'
    return bool(conn.execute("SELECT 1 FROM livery_customs WHERE status != 'rejected' AND files LIKE ? LIMIT 1",
                             (like,)).fetchone()
                or conn.execute("SELECT 1 FROM livery_render_cache WHERE files LIKE ? LIMIT 1", (like,)).fetchone())
