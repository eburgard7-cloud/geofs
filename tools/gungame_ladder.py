#!/usr/bin/env python3
"""
Gun Game ladder paint: which heat colour each tier wears, for any ladder the group picks.

The paint says how far down the ladder a pilot is, at a glance: tier 1 is cold (Ice), the paint
heats up tier by tier, and the final tier is Gold. It works for any ladder length because the
heat step is the tier's position along the ladder, not its number. Data lives in
liveries/gungame/ladder.json; race.js ports heat_for() 1:1 (the JSON's "examples" are the test
vectors both sides assert).

  python tools/gungame_ladder.py classic           print a preset ladder with its paints
  python tools/gungame_ladder.py --tiers f16 b737 c172 toilet
  python tools/gungame_ladder.py --check           examples in ladder.json match this code
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import livery_common as lc  # noqa: E402

LADDER = lc.LIV / "gungame" / "ladder.json"
STEPS = 8


def load() -> dict:
    return json.loads(LADDER.read_text(encoding="utf-8"))


def heat_for(tier: int, n: int) -> int | str:
    """Heat step (1..8) for tier `tier` (1-based) of an n-tier ladder; "final" for the last tier.
    Tiers 1..n-1 spread evenly over 1..8 (round half up, so JS Math.round gives the same)."""
    if not (isinstance(tier, int) and isinstance(n, int)) or n < 2 or not 1 <= tier <= n:
        raise ValueError(f"tier {tier} of {n}")
    if tier == n:
        return "final"
    span = max(n - 2, 1)
    return 1 + math.floor((tier - 1) * (STEPS - 1) / span + 0.5)


def paint_id(airframe: str, heat, data=None) -> str | None:
    """Spec id of the paint for this airframe + heat, or None when that airframe has no paint
    (joke-model tiers, or an airframe whose UV map isn't built yet)."""
    data = data or load()
    af = data["airframes"].get(airframe)
    if not af or not af.get("factory"):
        return None
    suffix = "final" if heat == "final" else f"heat_{heat}"
    sid = f"{af['factory']}_gg_{suffix}"
    return sid if (lc.LIV / "specs" / f"{sid}.json").is_file() else None


def ladder(tiers: list[str], data=None) -> list[dict]:
    data = data or load()
    n = len(tiers)
    out = []
    for i, af in enumerate(tiers, 1):
        if af not in data["airframes"]:
            raise ValueError(f"unknown airframe '{af}'")
        h = heat_for(i, n)
        out.append({"tier": i, "airframe": af, "heat": h, "paint": paint_id(af, h, data)})
    return out


def check(data=None) -> list[str]:
    data = data or load()
    errs = []
    for key, exp in data["examples"].items():
        n = int(key)
        got = [heat_for(t, n) for t in range(1, n + 1)]
        if got != exp:
            errs.append(f"n={n}: ladder.json says {exp}, code gives {got}")
    for pid, p in data["presets"].items():
        try:
            ladder(p["tiers"], data)
        except ValueError as e:
            errs.append(f"preset {pid}: {e}")
    if len(data["heat"]) != STEPS:
        errs.append(f"heat palette must have {STEPS} steps")
    return errs


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("preset", nargs="?")
    ap.add_argument("--tiers", nargs="+")
    ap.add_argument("--check", action="store_true")
    a = ap.parse_args(argv)
    data = load()
    if a.check:
        errs = check(data)
        print("OK" if not errs else "\n".join(errs))
        sys.exit(1 if errs else 0)
    tiers = a.tiers or data["presets"][a.preset or "classic"]["tiers"]
    for r in ladder(tiers, data):
        print(f"tier {r['tier']:2d}  {r['airframe']:8s} heat {str(r['heat']):6s} "
              f"{r['paint'] or '(no paint: stock / joke model / map not built)'}")


if __name__ == "__main__":
    main()
