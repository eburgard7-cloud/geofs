"""Shared helpers for the rival generator (race/tools/envelope.py, rival_gen.py).

Geodesy (WGS84 ECEF <-> geodetic, a local ENU frame), the Node bridge that answers every
race.js question (course hash, normalization, spawn, trace encoding) from race.js itself, and
envelope-table lookups. Nothing here re-implements race.js logic: Course.hash, gridSlot and
traceEncode come back from race/tools/rival_node.js, which loads the real race.js under JSDOM.
"""
from __future__ import annotations

import json
import math
import os
import shutil
import subprocess
from pathlib import Path

import numpy as np

RACE_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = RACE_DIR.parent
COURSES_DIR = RACE_DIR / "courses"
RIVALS_DIR = RACE_DIR / "rivals"
CACHE_DIR = RIVALS_DIR / "cache"
PENDING_DIR = RIVALS_DIR / ".pending"
NODE_BRIDGE = RACE_DIR / "tools" / "rival_node.js"
# CLAUDE.md: Node is not on PATH on the dev machine; this portable build is.
PORTABLE_NODE = Path(r"C:\Users\Eric.Burgard\AppData\Local\nodejs\node-v22.14.0-win-x64\node.exe")

G0 = 9.80665
WGS_A = 6378137.0
WGS_E2 = 6.69437999014e-3
D2R = math.pi / 180.0
KT_MS = 0.514444


# ------------------------------------------------------------------ geodesy
def ecef(lat, lon, alt):
    """race.js's ecef(), vectorised: degrees/metres (arrays or scalars) -> (..., 3) metres."""
    lat = np.asarray(lat, dtype=float) * D2R
    lon = np.asarray(lon, dtype=float) * D2R
    alt = np.asarray(alt, dtype=float)
    s, c = np.sin(lat), np.cos(lat)
    n = WGS_A / np.sqrt(1 - WGS_E2 * s * s)
    return np.stack([(n + alt) * c * np.cos(lon), (n + alt) * c * np.sin(lon), (n * (1 - WGS_E2) + alt) * s], axis=-1)


def geodetic(xyz):
    """ECEF (..., 3) -> (lat, lon, alt) arrays, Bowring's iteration (sub-mm at aircraft altitudes)."""
    xyz = np.asarray(xyz, dtype=float)
    x, y, z = xyz[..., 0], xyz[..., 1], xyz[..., 2]
    lon = np.arctan2(y, x)
    p = np.hypot(x, y)
    lat = np.arctan2(z, p * (1 - WGS_E2))
    for _ in range(6):
        s = np.sin(lat)
        n = WGS_A / np.sqrt(1 - WGS_E2 * s * s)
        alt = p / np.cos(lat) - n
        lat = np.arctan2(z, p * (1 - WGS_E2 * n / (n + alt)))
    s = np.sin(lat)
    n = WGS_A / np.sqrt(1 - WGS_E2 * s * s)
    alt = p / np.cos(lat) - n
    return lat / D2R, lon / D2R, alt


class Enu:
    """A local east-north-up tangent frame at (lat0, lon0, alt0). Exact both ways (via ECEF)."""

    def __init__(self, lat0, lon0, alt0=0.0):
        self.origin = ecef(lat0, lon0, alt0)
        la, lo = lat0 * D2R, lon0 * D2R
        self.rot = np.array([
            [-math.sin(lo), math.cos(lo), 0.0],
            [-math.sin(la) * math.cos(lo), -math.sin(la) * math.sin(lo), math.cos(la)],
            [math.cos(la) * math.cos(lo), math.cos(la) * math.sin(lo), math.sin(la)],
        ])

    def from_lla(self, lat, lon, alt):
        return (ecef(lat, lon, alt) - self.origin) @ self.rot.T

    def to_lla(self, enu):
        return geodetic(np.asarray(enu, dtype=float) @ self.rot + self.origin)

    def up_at(self, enu):
        """The local geodetic 'up' unit vector at each ENU point (the frame's own up drifts ~1 deg
        per 110 km, which matters for gravity over a long course)."""
        lat, lon, _ = self.to_lla(enu)
        la, lo = np.asarray(lat) * D2R, np.asarray(lon) * D2R
        up_ecef = np.stack([np.cos(la) * np.cos(lo), np.cos(la) * np.sin(lo), np.sin(la)], axis=-1)
        return up_ecef @ self.rot.T


# ------------------------------------------------------------------ Node bridge
def node_exe():
    env = os.environ.get("FINS_NODE")
    if env:
        return env
    found = shutil.which("node")
    if found:
        return found
    if PORTABLE_NODE.exists():
        return str(PORTABLE_NODE)
    raise RuntimeError("Node not found: set FINS_NODE to node.exe (CLAUDE.md names the portable build)")


def node_call(request, timeout=300):
    """One request to race/tools/rival_node.js; returns its `result` or raises with its error."""
    proc = subprocess.run([node_exe(), str(NODE_BRIDGE)], input=json.dumps(request).encode("utf-8"),
                          capture_output=True, timeout=timeout)
    if proc.returncode != 0:
        raise RuntimeError(f"rival_node.js exited {proc.returncode}: {proc.stderr.decode('utf-8', 'replace')[:2000]}")
    out = json.loads(proc.stdout.decode("utf-8"))
    if not out.get("ok"):
        raise RuntimeError("rival_node.js: " + str(out.get("error"))[:2000])
    return out["result"]


def load_course_files():
    """{course_id: raw course dict} for every course file, plus {course_id: cup} from index.json."""
    courses, cups = {}, {}
    idx_path = COURSES_DIR / "index.json"
    if idx_path.exists():
        for row in json.loads(idx_path.read_text(encoding="utf-8")):
            if isinstance(row, dict) and row.get("id"):
                cups[row["id"]] = row.get("cup")
    for p in sorted(COURSES_DIR.glob("*.json")):
        if p.name == "index.json":
            continue
        try:
            raw = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if isinstance(raw, dict) and isinstance(raw.get("gates"), list):
            courses[raw.get("id") or p.stem] = raw
    return courses, cups


def course_metas(courses, cups):
    """Course id -> race.js's view of it (hash, normalized course, aircraft, spawn), in one Node call."""
    ids = list(courses)
    res = node_call({"op": "meta", "courses": [dict(courses[i], id=courses[i].get("id") or i) for i in ids], "cups": cups})
    return {i: r for i, r in zip(ids, res)}


# ------------------------------------------------------------------ envelope tables
def table_interp(env, key, v):
    """Linear interpolation of a per-speed-bin envelope table at speed(s) v, clamped at the ends."""
    return np.interp(v, env["v_centers"], env[key])


def vmax_at(env, alt_m):
    """Max level speed for the altitude band containing alt_m (linear between band mid-points)."""
    mids = [(lo + min(hi, lo + 6000)) / 2 for lo, hi in env["alt_bands_m"]]
    return np.interp(alt_m, mids, env["vmax_ms"])


def load_envelope(aircraft_id, path=None):
    p = Path(path) if path else RIVALS_DIR / f"envelope-{aircraft_id}.json"
    if not p.exists():
        return None
    return json.loads(p.read_text(encoding="utf-8"))
