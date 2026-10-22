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
import sys
from types import SimpleNamespace
from typing import Optional

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

    def entry_blueprint(self, livery_id: str) -> Optional[str]:
        e, shas = self.entries.get(livery_id), self.shas.get(livery_id)
        if not e or not shas or not self.blueprint_ok.get(e["aircraft"]):
            return None
        return blueprint_url(shas[0])

    def public(self) -> dict:
        """What GET /liveries/catalog serves: catalog.json, each entry plus its served `urls` and
        `blueprint_url`."""
        return {**{k: v for k, v in self.raw.items() if k != "liveries"},
                "liveries": [{**e, "urls": self.urls.get(e["id"]),
                              "blueprint_url": self.entry_blueprint(e["id"])}
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
