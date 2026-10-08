#!/usr/bin/env python3
"""
liveries/catalog.json: every FINSONLY livery the game and the Garage can offer, in one file.

The race server serves it (Garage equip lists, unlock checks) and race.js reads it (applying
paint, Gun Game tier paint). Built from:
  - every spec in liveries/specs/ (its "catalog" block: category, requires, tail, gungame heat)
  - race/campaign/rewards.json for the pack-1 liveries' unlocks (matched by name; read-only)
  - airline.json for Eric's hand-made classics that predate the factory (free, category "classic")

  python tools/livery_catalog.py           write liveries/catalog.json
  python tools/livery_catalog.py --check   fail if the committed file is stale

Requirement kinds (exactly one key, or null = free):
  existing (race/campaign/rewards.json): medal+count, stars, tier, checkride, trophies, cup+medal,
                                         hidden_tier
  new in pack 2: mode ("gungame": applied by the mode, never equipped), gungame_wins,
                 season+place (finished that season at or above `place`)
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import livery_common as lc  # noqa: E402

OUT = lc.LIV / "catalog.json"
REWARDS = lc.ROOT / "race" / "campaign" / "rewards.json"
AIRLINE = lc.ROOT / "airline.json"
CATEGORIES = ["starter", "classic", "career", "season", "reward", "gungame", "custom"]
REQ_KINDS = {
    ("medal", "count"), ("stars",), ("tier",), ("checkride",), ("trophies",), ("cup", "medal"),
    ("hidden_tier",), ("mode",), ("gungame_wins",), ("season", "place"),
}
# factory aircraft -> how the game finds it. geofs_id only where verified (F-16 = 7 from the
# courses' aircraftId); the others are resolved by name from geofs.aircraftList at load.
AIRCRAFT = {
    "f16": {"liveryselector_key": "7", "geofs_id": "7", "geofs_name": "F-16",
            "texture_slots": "one texture: the model's texture.jpg (LiverySelector index 3)"},
    "b757": {"liveryselector_key": "GXD04N_126645_238", "geofs_id": None, "geofs_name": "757",
             "texture_slots": "one texture"},
    "rafale": {"liveryselector_key": "rafale", "geofs_id": None, "geofs_name": "Rafale",
               "texture_slots": "four, LiverySelector order: [normal (upstream), main, specular, "
                                "cockpit (upstream)]"},
}
# hand-made textures in airline.json that aren't real liveries
NOT_LIVERIES = ("UV Test", "UV Test 2", "UVCAL1", "UVCAL2", "UVCAL3", "UVCAL4",
                "UV REGION ID (test)")
REPO_RAW = "https://raw.githubusercontent.com/eburgard7-cloud/geofs/main/"


def _rewards_by_name():
    try:
        r = json.loads(REWARDS.read_text(encoding="utf-8"))
    except OSError:
        return {}
    return {lv["name"]: lv.get("requires") for lv in r.get("liveries", [])}


def build() -> dict:
    import livery_factory as F
    rewards = _rewards_by_name()
    specs = [s for _, s in F.load_specs()]
    names = {(s["aircraft"], s["name"]) for s in specs}
    out = []
    for s in specs:
        c = s.get("catalog", {})
        files = [p.relative_to(lc.ROOT).as_posix() for p in F.out_paths(s)]
        if "category" in c:
            cat, req = c["category"], c.get("requires")
        elif s["name"] in rewards:                       # pack 1: unlocks live in rewards.json
            cat, req = "career", rewards[s["name"]]
        else:
            cat, req = "career", None
        e = {"id": s["id"], "name": s["name"], "aircraft": s["aircraft"], "category": cat,
             "listed": s.get("listed", True), "files": files, "requires": req}
        for k in ("tail", "season"):
            if k in c:
                e[k] = c[k]
        if "gungame" in c:
            e["gungame"] = c["gungame"]
        if "template" in s:
            e["template"] = s["template"]
            e["params"] = s["params"]
        out.append(e)
    # Eric's hand-made classics (airline.json entries the factory didn't make)
    air = json.loads(AIRLINE.read_text(encoding="utf-8"))
    key2ac = {v["liveryselector_key"]: k for k, v in AIRCRAFT.items()}
    for key, ac in air["aircrafts"].items():
        fac = key2ac.get(key)
        if not fac:
            continue
        for lv in ac["liveries"]:
            if lv["name"] in NOT_LIVERIES or (fac, lv["name"]) in names:
                continue
            files = []
            for t in lv["texture"]:
                if t.startswith(REPO_RAW):
                    files.append(t[len(REPO_RAW):])
            slug = "".join(ch if ch.isalnum() else "_" for ch in lv["name"].lower()).strip("_")
            while "__" in slug:
                slug = slug.replace("__", "_")
            out.append({"id": f"classic_{fac}_{slug}", "name": lv["name"], "aircraft": fac,
                        "category": "classic", "listed": True, "files": files,
                        "textures": lv["texture"], "requires": None})
    return {
        "version": 1,
        "_comment": "Generated by tools/livery_catalog.py; do not edit. `files` are repo-relative "
                    "paths (serve them from race.finsonly.net, or raw.githubusercontent at a "
                    "commit). Rafale entries list [main, specular]; the normal and cockpit maps "
                    "are LiverySelector's upstream files (see `textures` on classics).",
        "aircraft": AIRCRAFT,
        "categories": CATEGORIES,
        "requirement_kinds": sorted("+".join(k) for k in REQ_KINDS),
        "liveries": out,
    }


def validate(cat: dict) -> list[str]:
    errs = []
    ids = [e["id"] for e in cat["liveries"]]
    if len(ids) != len(set(ids)):
        errs.append("duplicate ids")
    seen = set()
    for e in cat["liveries"]:
        if e["category"] not in CATEGORIES:
            errs.append(f"{e['id']}: bad category {e['category']}")
        if e["aircraft"] not in AIRCRAFT:
            errs.append(f"{e['id']}: bad aircraft")
        k = (e["aircraft"], e["name"])
        if k in seen:
            errs.append(f"{e['id']}: duplicate name for {e['aircraft']}")
        seen.add(k)
        for f in e["files"]:
            if not (lc.ROOT / f).is_file():
                errs.append(f"{e['id']}: missing file {f}")
        r = e["requires"]
        if r is not None:
            if tuple(sorted(r)) not in {tuple(sorted(x)) for x in REQ_KINDS}:
                errs.append(f"{e['id']}: unknown requirement {r}")
        if e["category"] == "gungame":
            h = e.get("gungame", {}).get("heat")
            if not (h == "final" or (isinstance(h, int) and 1 <= h <= 8)):
                errs.append(f"{e['id']}: gungame heat must be 1..8 or 'final'")
            if r != {"mode": "gungame"}:
                errs.append(f"{e['id']}: gungame paints are mode-applied (requires mode: gungame)")
    return errs


def dump(cat) -> str:
    lines = ["{"]
    items = list(cat.items())
    for i, (k, v) in enumerate(items):
        comma = "," if i < len(items) - 1 else ""
        if k == "liveries":
            lines.append('  "liveries": [')
            lines += ["    " + json.dumps(e) + ("," if j < len(v) - 1 else "") for j, e in enumerate(v)]
            lines.append("  ]" + comma)
        else:
            lines.append(f"  {json.dumps(k)}: {json.dumps(v)}{comma}")
    return "\n".join(lines) + "\n}\n"


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    a = ap.parse_args(argv)
    cat = build()
    errs = validate(cat)
    text = dump(cat)
    if a.check:
        if OUT.read_text(encoding="utf-8") != text:
            errs.append("liveries/catalog.json is stale: python tools/livery_catalog.py")
        print("OK" if not errs else "\n".join(errs))
        sys.exit(1 if errs else 0)
    if errs:
        raise SystemExit("catalog invalid:\n  " + "\n  ".join(errs))
    OUT.write_text(text, encoding="utf-8")
    n = {}
    for e in cat["liveries"]:
        n[e["category"]] = n.get(e["category"], 0) + 1
    print(f"{OUT.relative_to(lc.ROOT)}: {len(cat['liveries'])} liveries {n}")


if __name__ == "__main__":
    main()
