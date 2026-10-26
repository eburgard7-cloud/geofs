"""Gun Game: a ladder of progressively worse planes (race/PROTOCOL.md "Proto 14").

Win a leg and you step down one tier. The first pilot to win a leg on the final tier wins the game;
otherwise, after the game's leg count, whoever is furthest down the ladder wins. An optional
catch-up rule steps a pilot who finishes last twice in a row back UP one tier.

Pure. No sockets, no asyncio, no SQLite, no wall clock: every method takes the server's `now_ms`
(app.py's server_ms()) or `now_s`, and every random draw takes an `rng`. app.py owns one GunGame per
room while a game is on, feeds it the run hooks' leg events (race/server/HOOKS.md), and turns what
it returns into frames, the next leg, and -- once, at the end -- the SQLite rows.

    gg_create -> staging (ladder vote, settings, ready) -> leg vote -> leg -> results -> leg vote -> ...
    a win on the final tier, the last leg, gg_end, the nightly reset or an emptied room -> over

Data, not code: race/data/gungame.json (airframes, class defaults, presets, settings) and
liveries/gungame/ladder.json (each airframe's paint factory, the heat palette). heat_for() is a 1:1
port of tools/gungame_ladder.py; ladder.json's `examples` pin it here and in race.js.

Tier numbers are 1-based and count DOWN the ladder: tier 1 is the best plane, tier n the final one.
"Stepping down" is tier + 1.
"""
import json
import math
import random
import re
from dataclasses import dataclass, field
from typing import Optional

from rogue_engine import next_midnight_s, pacific_day, reset_due  # noqa: F401 -- re-exported for app.py

# ------------------------------------------------------------------------------------- CONFIG
VOTE_S = 20                     # the leg vote between legs (ends early once everyone has voted)
HEAT_STEPS = 8
CLASSES = ("fighter", "airliner", "ga", "glider", "heli", "joke")
EFFECT_FNS = ("cap_pct",)       # extra per-airframe effects: the cap governor only
OVER_REASONS = ("won", "legs", "ended", "nightly", "emptied")
WHY_WON, WHY_CATCH_UP = "won", "catch_up"
CATCH_UP_STREAK = 2             # finishing last this many legs in a row steps you up a tier

STAGING, VOTE, LEG, OVER = "staging", "vote", "leg", "over"
KEY_RE = re.compile(r"^[a-z0-9][a-z0-9_]{0,23}$")
AIRCRAFT_ID_RE = re.compile(r"^[0-9A-Za-z_-]{1,16}$")
MODEL_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,31}$")
COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
CUSTOM = "custom"
NAME_MAX = 48


def heat_for(tier: int, n: int):
    """Heat step (1..8) for tier `tier` (1-based) of an n-tier ladder; "final" for the last tier."""
    if not (isinstance(tier, int) and isinstance(n, int)) or n < 2 or not 1 <= tier <= n:
        raise ValueError(f"tier {tier} of {n}")
    if tier == n:
        return "final"
    return 1 + math.floor((tier - 1) * (HEAT_STEPS - 1) / max(n - 2, 1) + 0.5)


# ------------------------------------------------------------------------------------- catalog
def _num(v, lo, hi) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and lo <= v <= hi


def validate_catalog(raw, ladder) -> list[str]:
    """Every problem with gungame.json (`raw`) + ladder.json (`ladder`), in words. [] = valid."""
    errs: list[str] = []
    if not isinstance(raw, dict) or not isinstance(ladder, dict):
        return ["gungame.json and ladder.json must both be objects"]
    st = raw.get("settings")
    if not isinstance(st, dict):
        errs.append("settings missing")
        st = {}
    for k in ("tiers_min", "tiers_max", "legs_min", "legs_max", "legs_default"):
        if not (isinstance(st.get(k), int) and not isinstance(st.get(k), bool) and st.get(k) >= 1):
            errs.append(f"settings.{k} must be a positive integer")
    if not errs:
        if not 2 <= st["tiers_min"] <= st["tiers_max"] <= 16:
            errs.append("settings: need 2 <= tiers_min <= tiers_max <= 16")
        if not st["legs_min"] <= st["legs_default"] <= st["legs_max"] <= 99:
            errs.append("settings: need legs_min <= legs_default <= legs_max <= 99")
    if not isinstance(st.get("catch_up_default"), bool):
        errs.append("settings.catch_up_default must be true or false")
    afs = raw.get("airframes")
    if not isinstance(afs, dict) or not afs:
        return errs + ["airframes missing"]
    for key, af in afs.items():
        where = f"airframe {key!r}"
        if not KEY_RE.match(str(key)):
            errs.append(f"{where}: bad key")
        if not isinstance(af, dict):
            errs.append(f"{where}: not an object")
            continue
        if not (isinstance(af.get("label"), str) and 0 < len(af["label"]) <= 24):
            errs.append(f"{where}: label must be 1-24 chars")
        if af.get("class") not in CLASSES:
            errs.append(f"{where}: class must be one of {', '.join(CLASSES)}")
        if af.get("base") is not None:
            b = afs.get(af["base"])
            if not isinstance(b, dict) or b.get("base") is not None:
                errs.append(f"{where}: base must be a real airframe")
            if not (isinstance(af.get("model"), str) and MODEL_RE.match(af["model"])):
                errs.append(f"{where}: a based airframe needs a joke model")
            if af.get("class") != "joke":
                errs.append(f"{where}: a based airframe is class joke")
        else:
            if not (isinstance(af.get("name"), str) and 0 < len(af["name"]) <= NAME_MAX):
                errs.append(f"{where}: name must be 1-{NAME_MAX} chars")
            if af.get("id_hint") is not None and not AIRCRAFT_ID_RE.match(str(af["id_hint"])):
                errs.append(f"{where}: bad id_hint")
            if af.get("class") == "joke":
                errs.append(f"{where}: a joke airframe needs a base")
        for m in ("model", "final_model", "fallback_model"):
            if af.get(m) is not None and not (isinstance(af[m], str) and MODEL_RE.match(af[m])):
                errs.append(f"{where}: bad {m}")
        if not _num(af.get("start_kt"), 1, 900):
            errs.append(f"{where}: start_kt must be 1-900")
        if not _num(af.get("start_throttle"), 0, 1):
            errs.append(f"{where}: start_throttle must be 0-1")
        if not _num(af.get("cap_kt"), 1, 900):
            errs.append(f"{where}: cap_kt must be 1-900")
        eff = af.get("effects", [])
        if not isinstance(eff, list) or any(not isinstance(e, dict) or e.get("fn") not in EFFECT_FNS
                                            or set(e) != {"fn", "pct"} or not _num(e.get("pct"), -50, 50) for e in eff):
            errs.append(f"{where}: effects must be [{{fn: cap_pct, pct: -50..50}}]")
    fb = raw.get("fallback")
    if not isinstance(fb, dict) or fb.get("base") not in afs or (afs.get(fb.get("base")) or {}).get("base") is not None:
        errs.append("fallback.base must be a real airframe")
    cds = raw.get("class_defaults")
    if not isinstance(cds, list) or not cds:
        errs.append("class_defaults missing")
    else:
        for i, c in enumerate(cds):
            if not isinstance(c, dict) or c.get("class") not in CLASSES or not isinstance(c.get("match"), str):
                errs.append(f"class_defaults[{i}]: needs class and match")
                continue
            try:
                re.compile(c["match"], re.I)
            except re.error:
                errs.append(f"class_defaults[{i}]: bad pattern")
            if not _num(c.get("start_kt"), 1, 900) or not _num(c.get("cap_kt"), 1, 900):
                errs.append(f"class_defaults[{i}]: start_kt / cap_kt must be 1-900")
        if isinstance(cds[-1], dict) and cds[-1].get("match") != "":
            errs.append("class_defaults: the last entry must catch everything (match \"\")")
    presets = raw.get("presets")
    if not isinstance(presets, dict) or not presets:
        errs.append("presets missing")
        presets = {}
    if st.get("default_preset") not in presets:
        errs.append("settings.default_preset must be a preset")
    for pid, p in presets.items():
        if pid == CUSTOM or not KEY_RE.match(str(pid)):
            errs.append(f"preset {pid!r}: bad id")
        tiers = p.get("tiers") if isinstance(p, dict) else None
        if not (isinstance(p, dict) and isinstance(p.get("name"), str) and p["name"]):
            errs.append(f"preset {pid!r}: needs a name")
        if not isinstance(tiers, list):
            errs.append(f"preset {pid!r}: needs tiers")
            continue
        why = custom_problem(afs, [{"airframe": k} for k in tiers], st) if not errs else None
        if why:
            errs.append(f"preset {pid!r}: {why}")
    heat = ladder.get("heat")
    if not (isinstance(heat, list) and len(heat) == HEAT_STEPS
            and all(isinstance(h, dict) and h.get("step") == i + 1 and COLOR_RE.match(str(h.get("color"))) for i, h in enumerate(heat))):
        errs.append(f"ladder.json: heat must be {HEAT_STEPS} steps with colours")
    if not (isinstance(ladder.get("final"), dict) and COLOR_RE.match(str(ladder["final"].get("color")))):
        errs.append("ladder.json: final needs a colour")
    lafs = ladder.get("airframes")
    if not isinstance(lafs, dict) or set(lafs) != set(afs):
        errs.append("ladder.json airframes must be exactly gungame.json's airframes")
    return errs


@dataclass
class Catalog:
    settings: dict
    airframes: dict             # key -> the gungame.json airframe + "factory" from ladder.json
    class_defaults: list        # [(class, compiled pattern, start_kt, cap_kt)]
    presets: dict
    heat: list
    final: dict
    fallback: dict
    raw_class_defaults: list = field(default_factory=list)


def parse_catalog(raw, ladder) -> tuple[Optional[Catalog], list[str]]:
    errs = validate_catalog(raw, ladder)
    if errs:
        return None, errs
    afs = {k: {**af, "factory": (ladder["airframes"].get(k) or {}).get("factory")} for k, af in raw["airframes"].items()}
    cds = [(c["class"], re.compile(c["match"], re.I), c["start_kt"], c["cap_kt"]) for c in raw["class_defaults"]]
    return Catalog(dict(raw["settings"]), afs, cds, dict(raw["presets"]),
                   [{"step": h["step"], "name": h.get("name"), "color": h["color"]} for h in ladder["heat"]],
                   {"name": ladder["final"].get("name"), "color": ladder["final"]["color"]}, dict(raw["fallback"]),
                   list(raw["class_defaults"])), []


def load_catalog(path: str, ladder_path: str) -> tuple[Optional[Catalog], list[str]]:
    """(catalog, []) or (None, [why]). Never raises."""
    try:
        with open(path, encoding="utf-8") as f:
            raw = json.load(f)
        with open(ladder_path, encoding="utf-8") as f:
            ladder = json.load(f)
    except (OSError, ValueError) as e:
        return None, [str(e)]
    return parse_catalog(raw, ladder)


def catalog_frame(cat: Catalog) -> dict:
    """The `gg_catalog` frame's body: everything the client needs to draw the staging card."""
    return {"settings": dict(cat.settings), "airframes": {k: dict(v) for k, v in cat.airframes.items()},
            "presets": {k: {"name": p["name"], "tiers": list(p["tiers"])} for k, p in cat.presets.items()},
            "heat": [dict(h) for h in cat.heat], "final": dict(cat.final), "class_defaults": [dict(c) for c in cat.raw_class_defaults],
            "fallback": dict(cat.fallback)}


def classify(cat: Catalog, name: str) -> tuple[str, float, float]:
    """(class, start_kt, cap_kt) for an aircraft the catalog doesn't know, from its name. Must agree
    with race.js ggClassify()."""
    for cls, pat, start_kt, cap_kt in cat.class_defaults:
        if pat.search(name or ""):
            return cls, start_kt, cap_kt
    return "ga", 100, 260


def custom_problem(airframes: dict, tiers, settings: dict) -> Optional[str]:
    """Why a ladder ([{airframe} | {aircraft_id, name}]) can't be flown, or None. The refusal words
    match race.js ggValidateCustom()."""
    lo, hi = settings.get("tiers_min", 2), settings.get("tiers_max", 16)
    if not isinstance(tiers, list) or not lo <= len(tiers) <= hi:
        return f"a ladder needs {lo}-{hi} tiers"
    for i, t in enumerate(tiers):
        if not isinstance(t, dict):
            return f"tier {i + 1} has no aircraft"
        if t.get("airframe") is not None:
            af = airframes.get(t["airframe"])
            if not isinstance(af, dict):
                return f"unknown airframe '{str(t['airframe'])[:24]}'"
            if af.get("class") == "joke" and i != len(tiers) - 1:
                return f"{af.get('label') or af.get('name') or t['airframe']} can only be the last tier"
        else:
            if not AIRCRAFT_ID_RE.match(str(t.get("aircraft_id") if t.get("aircraft_id") is not None else "")):
                return f"tier {i + 1} has no aircraft"
            nm = str(t.get("name") or "").strip()
            if not nm or len(nm) > NAME_MAX:
                return f"tier {i + 1} needs a name"
    return None


def build_ladder(cat: Catalog, tiers: list) -> tuple[Optional[str], list[dict]]:
    """A checked ladder spec -> (None, the card's resolved tiers) or (why, [])."""
    why = custom_problem(cat.airframes, tiers, cat.settings)
    if why:
        return why, []
    n = len(tiers)
    out = []
    for i, t in enumerate(tiers):
        heat = heat_for(i + 1, n)
        color = cat.final["color"] if heat == "final" else cat.heat[heat - 1]["color"]
        last = i == n - 1
        if t.get("airframe") is not None:
            key = t["airframe"]
            af = cat.airframes[key]

            def gold(m, af=af):
                return af["final_model"] if m and last and af.get("final_model") and m == af.get("model") else m

            out.append({"key": key, "name": af["label"], "aircraft_id": af.get("id_hint"), "class": af["class"],
                        "start_kt": af["start_kt"], "start_throttle": af["start_throttle"], "cap_kt": af["cap_kt"],
                        "model": gold(af.get("model")), "fallback_model": gold(af.get("fallback_model")),
                        "base": af.get("base"), "factory": af.get("factory"), "heat": heat, "color": color,
                        "unknown": False, "effects": [dict(e) for e in af.get("effects", [])]})
        else:
            name = str(t["name"]).strip()[:NAME_MAX]
            cls, start_kt, cap_kt = classify(cat, name)
            out.append({"key": None, "name": name[:24], "aircraft_id": str(t["aircraft_id"]), "class": cls,
                        "start_kt": start_kt, "start_throttle": 1, "cap_kt": cap_kt, "model": None, "fallback_model": None,
                        "base": None, "factory": None, "heat": heat, "color": color, "unknown": True, "effects": []})
    return None, out


def preset_tiers(cat: Catalog, preset: str) -> list[dict]:
    return [{"airframe": k} for k in cat.presets[preset]["tiers"]]


def clean_custom(tiers) -> list[dict]:
    """A custom ladder as stored and echoed: only the fields a tier spec has."""
    out = []
    for t in tiers if isinstance(tiers, list) else []:
        if isinstance(t, dict) and t.get("airframe") is not None:
            out.append({"airframe": str(t["airframe"])[:24]})
        elif isinstance(t, dict):
            out.append({"aircraft_id": str(t.get("aircraft_id"))[:16], "name": str(t.get("name") or "").strip()[:NAME_MAX]})
    return out


# ------------------------------------------------------------------------------------- the game
@dataclass
class GGPilot:
    callsign: str
    tier: int = 1
    best_tier: int = 1          # the furthest down the ladder they got (what's stored as tier_reached)
    wins: int = 0
    last_streak: int = 0        # legs in a row finished last
    ready: bool = False
    legs: list = field(default_factory=list)   # [{leg_no, place, status, from_tier, to_tier, why}]


class GunGame:
    def __init__(self, game_id: int, cat: Catalog, creator: str, now_ms: int, now_s: float, seed=None):
        self.game_id = game_id
        self.cat = cat
        self.creator = creator
        self.phase = STAGING
        self.votes: dict[str, str] = {}
        self.custom: Optional[list] = None
        self.legs = int(cat.settings["legs_default"])
        self.catch_up = bool(cat.settings["catch_up_default"])
        self.pilots: dict[str, GGPilot] = {}
        self.pilot_ids: dict[str, str] = {}
        self.ladder: list[dict] = []     # locked at start(); the staging card shows the current pick
        self.preset_used: Optional[str] = None
        self.legs_done = 0
        self.leg_vote: Optional[dict] = None
        self.leg: Optional[dict] = None
        self.leg_entrants: list[str] = []
        self.multi = False               # some scored leg had 2+ game pilots: the win counts
        self.winner: Optional[str] = None
        self.end_reason: Optional[str] = None
        self.started_ms = now_ms
        self.started_s = now_s
        self.day = pacific_day(now_s)
        self.seed = seed if seed is not None else f"{game_id}:{now_ms}"
        self.add_pilot(creator)

    # -- pilots
    def add_pilot(self, callsign: str) -> GGPilot:
        p = self.pilots.get(callsign)
        if p is None:
            p = self.pilots[callsign] = GGPilot(callsign)
        return p

    def remove_pilot(self, callsign: str) -> None:
        """Staging only: a pilot who leaves before GO is off the card."""
        if self.phase == STAGING:
            self.pilots.pop(callsign, None)
            self.votes.pop(callsign, None)

    def rename(self, old: str, new: str) -> None:
        p = self.pilots.pop(old, None)
        if p is not None and new not in self.pilots:
            p.callsign = new
            self.pilots[new] = p
        if old in self.votes:
            self.votes[new] = self.votes.pop(old)
        if self.leg_vote and old in self.leg_vote["votes"]:
            self.leg_vote["votes"][new] = self.leg_vote["votes"].pop(old)
        if old in self.pilot_ids:
            self.pilot_ids[new] = self.pilot_ids.pop(old)
        if self.creator == old:
            self.creator = new
        self.leg_entrants = [new if c == old else c for c in self.leg_entrants]

    # -- staging: the ladder vote, settings, ready
    def effective_preset(self) -> str:
        """The ladder the group has picked: most votes; a tie goes to the creator's vote, then the
        default preset, then the first in name order. No votes: the default preset."""
        tally: dict[str, int] = {}
        for cs, v in self.votes.items():
            if cs in self.pilots and (v in self.cat.presets or (v == CUSTOM and self.custom)):
                tally[v] = tally.get(v, 0) + 1
        if not tally:
            return self.cat.settings["default_preset"]
        top = max(tally.values())
        tied = sorted(k for k, n in tally.items() if n == top)
        mine = self.votes.get(self.creator)
        if mine in tied:
            return mine
        if self.cat.settings["default_preset"] in tied:
            return self.cat.settings["default_preset"]
        return tied[0]

    def current_tiers(self) -> list[dict]:
        p = self.effective_preset()
        return list(self.custom) if p == CUSTOM else preset_tiers(self.cat, p)

    def staging_ladder(self) -> list[dict]:
        if self.ladder:
            return self.ladder
        _, tiers = build_ladder(self.cat, self.current_tiers())
        return tiers

    def vote(self, callsign: str, preset: str) -> Optional[str]:
        """A pilot's ladder vote. The refusal, or None. A change of the effective ladder clears ready."""
        if self.phase != STAGING:
            return "the ladder is set once the game starts"
        if callsign not in self.pilots:
            return "you are not in this game"
        if preset == CUSTOM:
            if not self.custom:
                return "no custom ladder yet (the creator builds it)"
        elif preset not in self.cat.presets:
            return f"unknown ladder '{str(preset)[:24]}'"
        before = self.effective_preset()
        self.votes[callsign] = preset
        if self.effective_preset() != before:
            self.clear_ready()
        return None

    def settings(self, callsign: str, custom=None, legs=None, catch_up=None) -> Optional[str]:
        """The creator's settings card. The refusal, or None. Any change clears everyone's ready."""
        if self.phase != STAGING:
            return "settings are locked once the game starts"
        if callsign != self.creator:
            return "only the game's creator can change that"
        st = self.cat.settings
        if legs is not None and not (isinstance(legs, int) and st["legs_min"] <= legs <= st["legs_max"]):
            return f"legs must be {st['legs_min']}-{st['legs_max']}"
        if custom is not None:
            why = custom_problem(self.cat.airframes, custom, st)
            if why:
                return why
        changed = False
        if custom is not None and clean_custom(custom) != self.custom:
            self.custom, changed = clean_custom(custom), True
        if legs is not None and legs != self.legs:
            self.legs, changed = legs, True
        if catch_up is not None and bool(catch_up) != self.catch_up:
            self.catch_up, changed = bool(catch_up), True
        if changed:
            self.clear_ready()
        return None

    def set_ready(self, callsign: str, ready: bool) -> Optional[str]:
        if self.phase != STAGING:
            return "the game has started"
        p = self.pilots.get(callsign) or self.add_pilot(callsign)
        p.ready = bool(ready)
        return None

    def clear_ready(self) -> None:
        for p in self.pilots.values():
            p.ready = False

    def all_ready(self, present: list[str]) -> bool:
        here = [cs for cs in self.pilots if cs in present]
        return bool(here) and all(self.pilots[cs].ready for cs in here)

    def start(self) -> Optional[str]:
        """Lock the ladder and leave staging. The refusal, or None."""
        why, tiers = build_ladder(self.cat, self.current_tiers())
        if why:
            return why
        self.ladder = tiers
        self.preset_used = self.effective_preset()
        self.phase = VOTE
        for p in self.pilots.values():
            p.ready = False
        return None

    # -- the leg vote between legs
    def open_leg_vote(self, candidates: list[dict], now_ms: int, vote_s: float = None) -> None:
        """candidates: [{choice, kind: course|dash, name, ...spec}]; app.py draws them."""
        self.phase = VOTE
        self.leg = None
        s = VOTE_S if vote_s is None else vote_s
        self.leg_vote = {"candidates": [dict(c) for c in candidates], "votes": {}, "deadline_ms": now_ms + int(s * 1000)}

    def leg_vote_cast(self, callsign: str, choice: str) -> Optional[str]:
        if self.phase != VOTE or not self.leg_vote:
            return "no leg vote is open"
        if callsign not in self.pilots:
            return "you are not in this game"
        if choice not in [c["choice"] for c in self.leg_vote["candidates"]]:
            return f"not a candidate: {str(choice)[:64]}"
        self.leg_vote["votes"][callsign] = choice
        return None

    def leg_vote_complete(self, present: list[str]) -> bool:
        here = [cs for cs in self.pilots if cs in present]
        return bool(self.leg_vote) and bool(here) and all(cs in self.leg_vote["votes"] for cs in here)

    def close_leg_vote(self, rng) -> Optional[dict]:
        """The winning candidate: most votes, a tie (or no votes at all) drawn by `rng`."""
        lv = self.leg_vote
        if not lv or not lv["candidates"]:
            return None
        tally: dict[str, int] = {}
        for v in lv["votes"].values():
            tally[v] = tally.get(v, 0) + 1
        cands = lv["candidates"]
        if tally:
            top = max(tally.values())
            cands = [c for c in cands if tally.get(c["choice"]) == top]
        pick = cands[0] if len(cands) == 1 else rng.choice(cands)
        self.leg_vote = None
        self.leg = dict(pick)
        return pick

    # -- a leg
    def leg_started(self, entrants: list[str]) -> list[str]:
        """The clock started. Pilots new to the game join at tier 1 (returned)."""
        self.phase = LEG
        self.leg_entrants = list(entrants)
        new = [cs for cs in entrants if cs not in self.pilots]
        for cs in entrants:
            self.add_pilot(cs)
        return new

    def score_leg(self, rows: list[dict]) -> dict:
        """leg_results -> the tier moves. `rows` are the engine's public rows, best first; only game
        pilots who flew the leg are placed (a non-game pilot never costs anyone a place).

        - The winner (1st game pilot to finish) steps down a tier; a win on the final tier wins the game.
        - Catch-up (if on, 2+ game pilots in the leg): last place -- every DNF/DNS if anyone didn't
          finish, else the last finisher -- CATCH_UP_STREAK legs in a row steps up a tier (min 1).
        - After the game's last leg, the furthest down the ladder wins (more leg wins, then the better
          place in the last leg, break a tie).

        Returns {rows: [...], winner: callsign | None, over: bool, reason: "won" | "legs" | None}."""
        n = len(self.ladder)
        flown = list(self.leg_entrants)
        by_cs = {r.get("callsign"): r for r in rows if r.get("callsign") in self.pilots}
        for cs in by_cs:
            if cs not in flown:
                flown.append(cs)
        order = [r["callsign"] for r in rows if r.get("callsign") in self.pilots and r.get("status") == "finished"]
        dnf = [cs for cs in flown if cs not in order]
        self.legs_done += 1
        leg_no = self.legs_done
        out_rows, winner, over, reason = [], None, False, None
        if len(flown) >= 2:
            self.multi = True
        last = set(dnf) if dnf else ({order[-1]} if order else set())
        lead = order[0] if order else None
        for place, cs in enumerate(order + dnf, 1):
            p = self.pilots[cs]
            frm = p.tier
            why = None
            finished = cs in order
            if cs == lead:
                p.wins += 1
                p.last_streak = 0
                if p.tier >= n:
                    winner, over, why, reason = cs, True, WHY_WON, "won"
                else:
                    p.tier += 1
                    why = WHY_WON
            elif self.catch_up and len(flown) >= 2 and cs in last:
                p.last_streak += 1
                if p.last_streak >= CATCH_UP_STREAK:
                    p.last_streak = 0
                    if p.tier > 1:
                        p.tier -= 1
                        why = WHY_CATCH_UP
            else:
                p.last_streak = 0
            p.best_tier = max(p.best_tier, p.tier)
            row = {"callsign": cs, "place": place if finished else None,
                   "status": (by_cs.get(cs) or {}).get("status") or ("finished" if finished else "dnf"),
                   "from_tier": frm, "to_tier": p.tier, "why": why}
            p.legs.append({"leg_no": leg_no, **{k: row[k] for k in ("place", "status", "from_tier", "to_tier", "why")}})
            out_rows.append(row)
        if not over and self.legs_done >= self.legs:
            over, reason = True, "legs"
            winner = self.leader(order)
        if over:
            self.winner = winner
        self.leg_entrants = []
        return {"rows": out_rows, "winner": winner, "over": over, "reason": reason}

    def leader(self, last_order: Optional[list] = None) -> Optional[str]:
        """Furthest down the ladder; then more leg wins; then the better place in the last leg."""
        if not self.pilots:
            return None
        pos = {cs: i for i, cs in enumerate(last_order or [])}
        return min(self.pilots.values(), key=lambda p: (-p.tier, -p.wins, pos.get(p.callsign, 99), p.callsign)).callsign

    def standings(self) -> list[GGPilot]:
        return sorted(self.pilots.values(), key=lambda p: (p.callsign != self.winner, -p.tier, -p.wins, p.callsign))

    # -- frames
    def _pilot_public(self, p: GGPilot) -> dict:
        return {"callsign": p.callsign, "tier": p.tier, "wins": p.wins, "last_streak": p.last_streak, "ready": p.ready}

    def card(self) -> dict:
        """The `gg` frame's body."""
        lv = self.leg_vote
        return {"game_id": self.game_id, "phase": self.phase, "creator": self.creator,
                "preset": self.preset_used or self.effective_preset(), "votes": dict(self.votes),
                "custom": [dict(t) for t in self.custom] if self.custom else None,
                "legs": self.legs, "catch_up": self.catch_up, "ladder": [dict(t) for t in self.staging_ladder()],
                "pilots": [self._pilot_public(p) for p in self.standings()], "legs_done": self.legs_done,
                "leg_vote": {"candidates": [{"choice": c["choice"], "kind": c["kind"], "name": c["name"]} for c in lv["candidates"]],
                             "votes": dict(lv["votes"]), "deadline_server_ms": lv["deadline_ms"]} if lv else None,
                "leg": {"kind": self.leg["kind"], "name": self.leg["name"]} if self.leg else None}

    def leg_frame(self, scored: dict) -> dict:
        return {"game_id": self.game_id, "leg_no": self.legs_done, "leg_count": self.legs,
                "leg": {"kind": self.leg["kind"], "name": self.leg["name"]} if self.leg else None,
                "rows": [dict(r) for r in scored["rows"]], "winner": scored["winner"] if scored["over"] else None}

    def end(self, reason: str) -> None:
        if self.end_reason is None:
            self.end_reason = reason
        self.phase = OVER
        self.leg_vote = None

    def summary(self, now_ms: int) -> dict:
        return {"game_id": self.game_id, "end_reason": self.end_reason, "winner": self.winner, "legs_done": self.legs_done,
                "leg_count": self.legs, "preset": self.preset_used, "catch_up": self.catch_up,
                "ladder": [{"name": t["name"], "key": t["key"], "aircraft_id": t["aircraft_id"], "heat": t["heat"]} for t in self.ladder],
                "day": self.day, "started_server_ms": self.started_ms, "ended_server_ms": now_ms,
                "standings": [{"pos": i + 1, "callsign": p.callsign, "tier": p.tier, "best_tier": p.best_tier, "wins": p.wins,
                               "legs": list(p.legs)} for i, p in enumerate(self.standings())]}

    def result_rows(self) -> list[dict]:
        """One row per pilot for `gungame_results`: {callsign, pilot_id, won, tier_reached}. `counts`
        is False for a game nobody else flew a leg of (a solo game never unlocks a champion paint)."""
        return [{"callsign": p.callsign, "pilot_id": self.pilot_ids.get(p.callsign), "won": p.callsign == self.winner,
                 "tier_reached": p.best_tier, "counts": self.multi} for p in self.standings()]


def summary_line(summary: dict) -> str:
    """The HOUSE chat line a game ends with. Display text, at most 240 chars."""
    why = {"won": "", "legs": f" after {summary['legs_done']} legs", "ended": " (ended early)", "nightly": " (nightly reset)",
           "emptied": " (room emptied)"}
    n = len(summary.get("ladder") or []) or "?"
    head = f"Gun Game over{why.get(summary.get('end_reason'), '')}: "
    if summary.get("winner") and summary.get("end_reason") in ("won", "legs"):
        head += f"{summary['winner']} wins! "
    body = " · ".join(f"{s['pos']}. {s['callsign']} tier {s['tier']}/{n}" for s in summary["standings"][:6]) or "nobody flew"
    return (head + body)[:240]


def new_rng(seed) -> random.Random:
    return random.Random(seed)
