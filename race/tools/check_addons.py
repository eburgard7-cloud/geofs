#!/usr/bin/env python3
"""Validate race/addons.json and report hotkey collisions with race.js.

    python race/tools/check_addons.py              # schema + SHA check + collisions
    python race/tools/check_addons.py --offline    # schema + collisions only (no network)
    python race/tools/check_addons.py --json       # machine-readable report
    python race/tools/check_addons.py --strict     # collisions are errors too

SHA check: each pinned commit must exist in its repo. Tried in order: the GitHub commits API,
then `git fetch --depth 1 <repo> <sha>` into a throwaway repo (GitHub serves reachable commits
by SHA). If neither can reach GitHub the SHA is reported UNVERIFIED, not failed.

race.js is only read: the Alt+ bindings are extracted from its keydown handler's act table
(`KeyX:` / `DigitN:` keys and `act.KeyX =` assignments), plus Alt+Shift+B.

Exit status: 1 on a schema error or a SHA that does not resolve (or, with --strict, a
collision); 0 otherwise.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
ADDONS_PATH = REPO_ROOT / "race" / "addons.json"
RACE_JS = REPO_ROOT / "race" / "race.js"

FIELDS = ["id", "name", "repo", "sha", "url", "physics", "default", "hotkeys", "notes"]
HOTKEY_FIELDS = {"combo", "action", "strict_modifiers"}
ID_RE = re.compile(r"^[a-z0-9-]{1,48}$")
REPO_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
MODIFIERS = ("Ctrl", "Alt", "Shift", "Meta")


def validate(entries) -> list[str]:
    """Schema errors for the parsed addons.json (empty list = valid)."""
    errs: list[str] = []
    if not isinstance(entries, list) or not entries:
        return ["addons.json must be a non-empty JSON array"]
    seen: set[str] = set()
    for i, e in enumerate(entries):
        where = f"entry {i}"
        if not isinstance(e, dict):
            errs.append(f"{where}: not an object")
            continue
        where = f"entry {i} ({e.get('id', '?')})"
        missing = [f for f in FIELDS if f not in e]
        extra = [f for f in e if f not in FIELDS]
        if missing:
            errs.append(f"{where}: missing {missing}")
        if extra:
            errs.append(f"{where}: unknown fields {extra}")
        if missing:
            continue
        if not isinstance(e["id"], str) or not ID_RE.match(e["id"]):
            errs.append(f"{where}: id must match {ID_RE.pattern}")
        elif e["id"] in seen:
            errs.append(f"{where}: duplicate id")
        seen.add(e["id"])
        if not isinstance(e["name"], str) or not e["name"].strip():
            errs.append(f"{where}: name must be a non-empty string")
        if not isinstance(e["repo"], str) or not REPO_RE.match(e["repo"]):
            errs.append(f"{where}: repo must be owner/name")
        if not isinstance(e["sha"], str) or not SHA_RE.match(e["sha"]):
            errs.append(f"{where}: sha must be a full 40-char lowercase hex commit")
        elif isinstance(e["repo"], str):
            prefix = f"https://cdn.jsdelivr.net/gh/{e['repo']}@{e['sha']}/"
            if not isinstance(e["url"], str) or not e["url"].startswith(prefix) or len(e["url"]) <= len(prefix):
                errs.append(f"{where}: url must be {prefix}<file>")
        if not isinstance(e["physics"], bool):
            errs.append(f"{where}: physics must be a boolean")
        if e["default"] is not False:
            errs.append(f"{where}: default must be false (nothing is enabled by default)")
        if not isinstance(e["notes"], str):
            errs.append(f"{where}: notes must be a string")
        if not isinstance(e["hotkeys"], list):
            errs.append(f"{where}: hotkeys must be a list")
            continue
        for j, hk in enumerate(e["hotkeys"]):
            if not isinstance(hk, dict) or set(hk) != HOTKEY_FIELDS:
                errs.append(f"{where}: hotkey {j} must have exactly {sorted(HOTKEY_FIELDS)}")
                continue
            if parse_combo(hk["combo"]) is None:
                errs.append(f"{where}: hotkey {j} combo {hk['combo']!r} is not like 'Alt+Shift+B' / 'W' / 'Insert'")
            if not isinstance(hk["strict_modifiers"], bool):
                errs.append(f"{where}: hotkey {j} strict_modifiers must be a boolean")
    return errs


def parse_combo(combo):
    """'Alt+Shift+B' -> (frozenset({'Alt','Shift'}), 'B'). None if malformed."""
    if not isinstance(combo, str) or not combo.strip():
        return None
    parts = [p.strip() for p in combo.split("+")]
    key = parts[-1]
    mods = parts[:-1]
    if not key or any(m not in MODIFIERS for m in mods) or len(set(mods)) != len(mods):
        return None
    key = key.upper() if len(key) == 1 else key
    return frozenset(mods), key


def race_hotkeys(src: str) -> set[str]:
    """Alt+ combos race.js binds in its keydown handler, e.g. {'Alt+R', 'Alt+1', 'Alt+Shift+B'}."""
    m = re.search(r"const onKeydown = \(e\) => \{(.*?)\n  \};", src, re.S)
    body = m.group(1) if m else src
    codes = set(re.findall(r"\b(Key[A-Z]|Digit[0-9])\s*:", body))
    codes |= set(re.findall(r"act\.(Key[A-Z]|Digit[0-9])\s*=", body))
    out = {"Alt+" + (c[3:] if c.startswith("Key") else c[5:]) for c in codes}
    if "KeyB" in codes and "e.shiftKey && e.code !== 'KeyB'" in body:
        out.add("Alt+Shift+B")
    return out


def collisions(entries, race_keys: set[str]) -> list[dict]:
    """Addon hotkeys that would fire on a race.js Alt+ binding.

    Exact match (same modifiers + key) always collides. A plain or Shift-less binding whose
    handler does not check modifiers (strict_modifiers false) also fires when Alt is held, so
    it collides with Alt+<same key> too — flagged as 'loose'.
    """
    race = {parse_combo(k) for k in race_keys}
    out = []
    for e in entries:
        for hk in e.get("hotkeys", []):
            p = parse_combo(hk.get("combo"))
            if p is None:
                continue
            mods, key = p
            if (mods, key) in race:
                out.append({"addon": e["id"], "combo": hk["combo"], "race": "+".join(sorted(mods) + [key]), "kind": "exact"})
            elif not hk.get("strict_modifiers") and "Alt" not in mods:
                for rmods, rkey in race:
                    if rkey == key and rmods == mods | {"Alt"}:
                        out.append({"addon": e["id"], "combo": hk["combo"], "race": "+".join(sorted(rmods, key=MODIFIERS.index) + [rkey]), "kind": "loose"})
    return out


def sha_exists(repo: str, sha: str, timeout: float = 30.0) -> str:
    """'ok', 'missing', or 'unverified' (GitHub unreachable)."""
    try:
        req = urllib.request.Request(f"https://api.github.com/repos/{repo}/commits/{sha}",
                                     headers={"Accept": "application/vnd.github+json", "User-Agent": "finsonly-check-addons"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = json.loads(r.read().decode())
            return "ok" if data.get("sha") == sha else "missing"
    except urllib.error.HTTPError as ex:
        if ex.code in (404, 422):
            return "missing"
    except Exception:
        pass
    try:
        with tempfile.TemporaryDirectory() as d:
            subprocess.run(["git", "init", "-q", d], check=True, capture_output=True, timeout=timeout)
            r = subprocess.run(["git", "-C", d, "fetch", "-q", "--depth", "1", f"https://github.com/{repo}", sha],
                               capture_output=True, text=True, timeout=timeout * 2)
            if r.returncode == 0:
                return "ok"
            if "not our ref" in r.stderr or "not found" in r.stderr.lower():
                return "missing"
    except Exception:
        pass
    return "unverified"


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--addons", default=str(ADDONS_PATH))
    ap.add_argument("--race-js", default=str(RACE_JS))
    ap.add_argument("--offline", action="store_true", help="skip the SHA check")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--strict", action="store_true", help="treat hotkey collisions as errors")
    args = ap.parse_args(argv)

    try:
        entries = json.loads(Path(args.addons).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as ex:
        print(f"cannot read {args.addons}: {ex}", file=sys.stderr)
        return 1
    errs = validate(entries)
    rk = race_hotkeys(Path(args.race_js).read_text(encoding="utf-8")) if Path(args.race_js).exists() else set()
    coll = collisions(entries, rk) if not errs else []
    shas = {}
    if not errs and not args.offline:
        shas = {e["id"]: sha_exists(e["repo"], e["sha"]) for e in entries}
    bad_sha = [i for i, s in shas.items() if s == "missing"]

    report = {"schema_errors": errs, "race_hotkeys": sorted(rk), "collisions": coll, "sha": shas,
              "physics": sorted(e["id"] for e in entries if isinstance(e, dict) and e.get("physics")) if not errs else []}
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print(f"addons: {len(entries) if isinstance(entries, list) else 0}  schema: {'OK' if not errs else 'FAIL'}")
        for e in errs:
            print("  schema:", e)
        for i, s in shas.items():
            print(f"  sha {i}: {s.upper()}")
        print("race.js Alt+ hotkeys:", ", ".join(sorted(rk)) or "(none found)")
        if coll:
            for c in coll:
                print(f"  COLLISION ({c['kind']}): {c['addon']} {c['combo']} vs race.js {c['race']}")
        else:
            print("  no hotkey collisions")
        if report["physics"]:
            print("physics-writing addons:", ", ".join(report["physics"]))
    if errs or bad_sha or (args.strict and coll):
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
