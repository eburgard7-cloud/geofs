"""The Roguelike Cup: a run of legs where results earn parts and parts buy upgrades (race/PROTOCOL.md
"Proto 12").

Pure. No sockets, no asyncio, no SQLite, no wall clock: every method takes the server's `now_ms`
(app.py's server_ms()) or `now_s`, and every random draw takes an `rng`. app.py owns one RogueRun per
room while a run is on, feeds it the run hooks' leg events (race/server/HOOKS.md), and turns what it
returns into frames, the next leg, and -- once, at the end -- the SQLite summary row.

    rogue_start -> leg 1 -> results -> shop (SHOP_S) -> leg 2 -> ... -> last results -> over
    rogue_end, the nightly reset (local midnight Pacific) or an emptied room -> over

The catalog (race/data/upgrades.json) is data: every upgrade and debuff is a list of effect entries
from the closed vocabulary in EFFECT_FNS, validated by validate_catalog(). The relay applies the two
that are relay rules (shield_ms, next_box); the client turns the rest into effects-engine records.

Every tunable number is a module constant below, so a test can monkeypatch it and a reader can
find it.
"""
import datetime as _dt
import json
import random
import re
from dataclasses import dataclass, field
from typing import Optional

# ------------------------------------------------------------------------------------- CONFIG
PARTS_BY_PLACE = (6, 4, 3)      # 1st, 2nd, 3rd among the run's pilots in a leg...
PARTS_OTHER = 2                 # ...any other finisher
PARTS_DNF = 0                   # a DNF / DNS earns nothing (and gets SMOKE_DEBUFF)
LANDING_BONUS_SCORE = 700       # a Dash landing_score above this...
LANDING_BONUS_PARTS = 1         # ...earns this on top
HARD_LANDING_FPM = 900          # a Dash touchdown sinking faster than this gets HARD_LANDING_DEBUFF
HARD_LANDING_DEBUFF = "duct-tape"
SMOKE_DEBUFF = "smoke"
SHOP_S = 30                     # the shop between legs; everyone buys at once
SHOP_OFFERS = 4                 # upgrades offered to each pilot per shop
RARITY_WEIGHTS = {"common": 60, "rare": 30, "epic": 10}
CATCHUP_RARITY = "common"       # last place gets a free random upgrade of this rarity
LEGS_MIN, LEGS_MAX = 3, 6
OVER_REASONS = ("complete", "ended", "nightly", "emptied")
PACIFIC_TZ = "America/Los_Angeles"
PACIFIC_FALLBACK_OFFSET_H = -7  # app.py's RAMP_DAY_OFFSET_H, if the tz database is missing

LEG, SHOP, OVER = "leg", "shop", "over"
ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,31}$")
BOX_ITEMS = ("banana", "goop", "boost", "missile")
SCREENS = ("tint", "fog", "shake", "goop")

# The closed effect vocabulary: fn -> {arg: (kind, required, check)}. Anything else is refused.
_num = (int, float)
EFFECT_FNS = {
    "cap_pct": {"pct": (_num, True, lambda v: -50 <= v <= 50 and v != 0),
                "when": (str, False, lambda v: v == "slipstream"),
                "range_m": (_num, False, lambda v: 0 < v <= 5000)},
    "boost_charges": {"n": (int, True, lambda v: 1 <= v <= 5)},
    "shield_ms": {"ms": (int, True, lambda v: 1 <= v <= 10000)},
    "impulse_on_pitch": {"pitch_deg": (_num, True, lambda v: 1 <= v <= 89),
                         "cooldown_ms": (int, True, lambda v: 0 <= v <= 120000),
                         "delta_mps": (_num, True, lambda v: 0 < v <= 100),
                         "ramp_ms": (int, True, lambda v: 0 <= v <= 10000),
                         "decay_ms": (int, True, lambda v: 0 <= v <= 30000)},
    "screen": {"screen": (str, True, lambda v: v in SCREENS),
               "variant": (str, False, lambda v: bool(ID_RE.match(v)))},
    "next_box": {"item": (str, True, lambda v: v in BOX_ITEMS)},
}


# ------------------------------------------------------------------------------------- catalog
def _effect_errors(where: str, effects) -> list[str]:
    if not isinstance(effects, list) or not effects:
        return [f"{where}: effects must be a non-empty list"]
    errs = []
    for i, e in enumerate(effects):
        at = f"{where}.effects[{i}]"
        if not isinstance(e, dict) or e.get("fn") not in EFFECT_FNS:
            errs.append(f"{at}: unknown fn {e.get('fn') if isinstance(e, dict) else e!r}")
            continue
        spec = EFFECT_FNS[e["fn"]]
        for k in e:
            if k != "fn" and k not in spec:
                errs.append(f"{at}: unknown arg {k!r} for {e['fn']}")
        for k, (kind, required, ok) in spec.items():
            if k not in e:
                if required:
                    errs.append(f"{at}: {e['fn']} needs {k!r}")
                continue
            v = e[k]
            if isinstance(v, bool) or not isinstance(v, kind) or not ok(v):
                errs.append(f"{at}: bad {k!r} {v!r}")
    return errs


def _text_ok(v, limit: int) -> bool:
    return isinstance(v, str) and 0 < len(v.strip()) <= limit


def validate_catalog(cat) -> list[str]:
    """Every problem with a catalog, or [] for a good one."""
    if not isinstance(cat, dict):
        return ["catalog must be an object"]
    errs = []
    if cat.get("version") != 1:
        errs.append("version must be 1")
    seen = set()
    ups, debs = cat.get("upgrades"), cat.get("debuffs")
    if not isinstance(ups, list) or not ups:
        errs.append("upgrades must be a non-empty list")
        ups = []
    if not isinstance(debs, list):
        errs.append("debuffs must be a list")
        debs = []
    for kind, rows in (("upgrade", ups), ("debuff", debs)):
        for i, u in enumerate(rows):
            where = f"{kind}[{i}]"
            if not isinstance(u, dict):
                errs.append(f"{where}: must be an object")
                continue
            uid = u.get("id")
            if not isinstance(uid, str) or not ID_RE.match(uid):
                errs.append(f"{where}: bad id {uid!r}")
            elif uid in seen:
                errs.append(f"{where}: duplicate id {uid!r}")
            else:
                seen.add(uid)
                where = f"{kind} {uid!r}"
            if not _text_ok(u.get("name"), 32):
                errs.append(f"{where}: name must be 1-32 chars")
            if not _text_ok(u.get("description"), 160):
                errs.append(f"{where}: description must be 1-160 chars")
            if kind == "upgrade":
                if u.get("rarity") not in RARITY_WEIGHTS:
                    errs.append(f"{where}: rarity must be one of {', '.join(RARITY_WEIGHTS)}")
                for k, lo in (("cost", 0), ("max_stacks", 1)):
                    v = u.get(k)
                    if isinstance(v, bool) or not isinstance(v, int) or v < lo or v > 99:
                        errs.append(f"{where}: {k} must be an integer {lo}-99")
                allowed = {"id", "name", "rarity", "cost", "max_stacks", "description", "effects"}
            else:
                v = u.get("legs")
                if isinstance(v, bool) or not isinstance(v, int) or not 1 <= v <= 6:
                    errs.append(f"{where}: legs must be an integer 1-6")
                allowed = {"id", "name", "legs", "description", "effects"}
            for k in u:
                if k not in allowed:
                    errs.append(f"{where}: unknown field {k!r}")
            errs.extend(_effect_errors(where, u.get("effects")))
    ids = {u.get("id") for u in debs if isinstance(u, dict)}
    for need in (HARD_LANDING_DEBUFF, SMOKE_DEBUFF):
        if need not in ids:
            errs.append(f"debuffs must include {need!r}")
    if ups and not any(isinstance(u, dict) and u.get("rarity") == CATCHUP_RARITY for u in ups):
        errs.append(f"upgrades must include at least one {CATCHUP_RARITY!r} (the catch-up grant)")
    return errs


@dataclass
class Catalog:
    upgrades: dict          # id -> row, in file order
    debuffs: dict

    def get(self, uid: str) -> Optional[dict]:
        return self.upgrades.get(uid) or self.debuffs.get(uid)


def parse_catalog(raw) -> tuple[Optional[Catalog], list[str]]:
    errs = validate_catalog(raw)
    if errs:
        return None, errs
    return Catalog({u["id"]: u for u in raw["upgrades"]}, {d["id"]: d for d in raw["debuffs"]}), []


def load_catalog(path: str) -> tuple[Optional[Catalog], list[str]]:
    """(catalog, []) or (None, [why]). Never raises."""
    try:
        with open(path, encoding="utf-8") as f:
            raw = json.load(f)
    except (OSError, ValueError) as e:
        return None, [f"{path}: {e}"]
    return parse_catalog(raw)


# ------------------------------------------------------------------------------------- the clock
def _pacific():
    try:
        from zoneinfo import ZoneInfo
        return ZoneInfo(PACIFIC_TZ)
    except Exception:
        return _dt.timezone(_dt.timedelta(hours=PACIFIC_FALLBACK_OFFSET_H))


def pacific_day(now_s: float) -> str:
    """The local calendar day in Pacific time (DST-aware), e.g. '2026-10-22'. Runs reset when it
    changes, i.e. at local midnight."""
    return _dt.datetime.fromtimestamp(now_s, _pacific()).strftime("%Y-%m-%d")


def next_midnight_s(now_s: float) -> float:
    """Unix seconds of the next local midnight Pacific after now_s."""
    tz = _pacific()
    here = _dt.datetime.fromtimestamp(now_s, tz)
    nxt = _dt.datetime.combine(here.date() + _dt.timedelta(days=1), _dt.time(0, 0), tzinfo=tz)
    return nxt.timestamp()


def reset_due(run_day: str, now_s: float) -> bool:
    return pacific_day(now_s) != run_day


# ------------------------------------------------------------------------------------- the run
def parts_for(place: Optional[int], status: str) -> int:
    """Parts for a place among the run's pilots in a leg (1-based). DNF/DNS earns PARTS_DNF."""
    if status != "finished" or not place or place < 1:
        return PARTS_DNF
    return PARTS_BY_PLACE[place - 1] if place <= len(PARTS_BY_PLACE) else PARTS_OTHER


@dataclass
class RoguePilot:
    callsign: str
    parts: int = 0                                     # spendable balance
    earned: int = 0                                    # everything ever earned (the summary ranks on it)
    owned: dict = field(default_factory=dict)          # upgrade id -> stacks
    debuffs: dict = field(default_factory=dict)        # debuff id -> legs left
    offers: list = field(default_factory=list)         # upgrade ids offered in the current shop
    pending_box: Optional[str] = None                  # next_box: the next box roll is this item
    legs: list = field(default_factory=list)           # [{leg_no, place, status, parts}] per leg flown


def _weighted_pick(rng, pool: list[dict]) -> dict:
    total = sum(RARITY_WEIGHTS.get(u["rarity"], 0) for u in pool)
    if total <= 0:
        return rng.choice(pool)
    x = rng.random() * total
    for u in pool:
        x -= RARITY_WEIGHTS.get(u["rarity"], 0)
        if x < 0:
            return u
    return pool[-1]


class RogueRun:
    def __init__(self, run_id: int, legs: list[dict], catalog: Catalog, pilots: list[str],
                 now_ms: int, now_s: float, seed: Optional[str] = None):
        if not LEGS_MIN <= len(legs) <= LEGS_MAX:
            raise ValueError(f"a run needs {LEGS_MIN}-{LEGS_MAX} legs")
        self.run_id = run_id
        self.legs = [dict(x) for x in legs]
        self.catalog = catalog
        self.pilots: dict[str, RoguePilot] = {}
        for cs in pilots:
            self.add_pilot(cs)
        self.legs_done = 0
        self.phase = LEG
        self.shop_deadline_ms: Optional[int] = None
        self.started_ms = now_ms
        self.started_s = now_s
        self.day = pacific_day(now_s)
        self.seed = seed if seed is not None else f"{run_id}:{now_ms}"
        self.leg_entrants: list[str] = []
        self.leg_results: dict[str, dict] = {}   # callsign -> the engine's row (from leg_finish)
        self.last_awards: dict[str, dict] = {}
        self.end_reason: Optional[str] = None

    # -- membership
    def add_pilot(self, callsign: str) -> RoguePilot:
        p = self.pilots.get(callsign)
        if p is None:
            p = self.pilots[callsign] = RoguePilot(callsign)
        return p

    def rename(self, old: str, new: str) -> None:
        p = self.pilots.pop(old, None)
        if p is not None and new not in self.pilots:
            p.callsign = new
            self.pilots[new] = p

    def current_leg(self) -> Optional[dict]:
        return self.legs[self.legs_done] if self.legs_done < len(self.legs) and self.phase != OVER else None

    # -- a leg
    def leg_started(self, entrants: list[str]) -> None:
        self.phase = LEG
        self.leg_entrants = list(entrants)
        self.leg_results = {}
        for cs in entrants:
            self.add_pilot(cs)

    def leg_finished(self, callsign: str, row: dict) -> None:
        self.leg_results[callsign] = dict(row)

    def leg_awards(self, rows: list[dict], engine: str, rng) -> dict[str, dict]:
        """Pure scoring of one leg: callsign -> {place, status, parts, reasons, free_upgrade,
        debuffs_next}. `rows` are the engine's public rows, best first. Only the run's pilots are
        scored; places are among them, so a non-run pilot in the room never costs anyone a part."""
        mine = [r for r in rows if r.get("callsign") in self.pilots]
        out: dict[str, dict] = {}
        place = 0
        for r in mine:
            cs = r["callsign"]
            status = "finished" if r.get("status") == "finished" else "dnf"
            if status == "finished":
                place += 1
            a = {"place": place if status == "finished" else None, "status": r.get("status") or status,
                 "parts": 0, "reasons": [], "free_upgrade": None, "debuffs_next": []}
            base = parts_for(a["place"], status)
            if status == "finished":
                a["reasons"].append({"why": f"{_ordinal(place)} place", "parts": base})
            else:
                a["reasons"].append({"why": "did not finish", "parts": base})
                a["debuffs_next"].append(SMOKE_DEBUFF)
            a["parts"] += base
            landing = r.get("landing") if engine == "dash" else None
            if status == "finished" and isinstance(landing, dict):
                score = landing.get("landing_score")
                if isinstance(score, (int, float)) and score > LANDING_BONUS_SCORE:
                    a["parts"] += LANDING_BONUS_PARTS
                    a["reasons"].append({"why": f"landing score {int(score)}", "parts": LANDING_BONUS_PARTS})
                sink = landing.get("sink_fpm")
                if isinstance(sink, (int, float)) and abs(sink) > HARD_LANDING_FPM:
                    a["debuffs_next"].append(HARD_LANDING_DEBUFF)
                    a["reasons"].append({"why": f"hard landing ({int(abs(sink))} fpm): Duct tape next leg", "parts": 0})
            if SMOKE_DEBUFF in a["debuffs_next"]:
                a["reasons"].append({"why": "Smoke next leg", "parts": 0})
            out[cs] = a
        if len(mine) >= 2:
            last = mine[-1]["callsign"]
            pick = self._catchup_pick(last, rng)
            out[last]["free_upgrade"] = pick
            out[last]["reasons"].append({"why": "catch-up: free " + (self.catalog.upgrades[pick]["name"] if pick else "upgrade (none left)"),
                                         "parts": 0})
        return out

    def _catchup_pick(self, callsign: str, rng) -> Optional[str]:
        owned = self.pilots[callsign].owned
        pool = [u["id"] for u in self.catalog.upgrades.values()
                if u["rarity"] == CATCHUP_RARITY and owned.get(u["id"], 0) < u["max_stacks"]]
        return rng.choice(pool) if pool else None

    def apply_awards(self, awards: dict[str, dict]) -> None:
        """Debuffs that ran this leg tick down first; then the leg's parts, free upgrades and new
        debuffs land. A new debuff therefore lasts through the shop and the whole next leg."""
        for p in self.pilots.values():
            for d in list(p.debuffs):
                p.debuffs[d] -= 1
                if p.debuffs[d] <= 0:
                    del p.debuffs[d]
        for cs, a in awards.items():
            p = self.add_pilot(cs)
            p.parts += a["parts"]
            p.earned += a["parts"]
            if a["free_upgrade"]:
                self._grant(p, a["free_upgrade"])
            for d in a["debuffs_next"]:
                row = self.catalog.debuffs.get(d)
                if row is not None:
                    p.debuffs[d] = max(p.debuffs.get(d, 0), row["legs"])
            p.legs.append({"leg_no": self.legs_done + 1, "place": a["place"], "status": a["status"], "parts": a["parts"]})
        self.last_awards = awards

    def _grant(self, p: RoguePilot, uid: str) -> None:
        p.owned[uid] = p.owned.get(uid, 0) + 1
        for e in self.catalog.upgrades[uid]["effects"]:
            if e["fn"] == "next_box":
                p.pending_box = e["item"]

    def score_leg(self, rows: list[dict], engine: str, rng) -> dict[str, dict]:
        """leg_results: score, apply, count the leg done. Returns the awards."""
        awards = self.leg_awards(rows, engine, rng)
        self.apply_awards(awards)
        self.legs_done += 1
        self.leg_entrants, self.leg_results = [], {}
        return awards

    # -- the shop
    def shop_offers(self, callsign: str) -> list[str]:
        p = self.pilots[callsign]
        rng = random.Random(f"{self.seed}:{self.legs_done}:{callsign}")
        pool = [u for u in self.catalog.upgrades.values() if p.owned.get(u["id"], 0) < u["max_stacks"]]
        picks = []
        while pool and len(picks) < SHOP_OFFERS:
            u = _weighted_pick(rng, pool)
            picks.append(u["id"])
            pool.remove(u)
        return picks

    def open_shop(self, now_ms: int) -> None:
        self.phase = SHOP
        self.shop_deadline_ms = now_ms + SHOP_S * 1000
        for cs, p in self.pilots.items():
            p.offers = self.shop_offers(cs)

    def buy(self, callsign: str, uid: str, now_ms: int) -> Optional[str]:
        """Buy one stack. Returns the refusal, or None (bought)."""
        if self.phase != SHOP or self.shop_deadline_ms is None or now_ms >= self.shop_deadline_ms:
            return "the shop is closed"
        p = self.pilots.get(callsign)
        if p is None:
            return "you are not in this run"
        u = self.catalog.upgrades.get(uid)
        if u is None:
            return f"unknown upgrade {uid!r}"
        if uid not in p.offers:
            return f"{u['name']} is not on offer to you"
        have = p.owned.get(uid, 0)
        if have >= u["max_stacks"]:
            return f"{u['name']} is already at max ({u['max_stacks']})"
        if p.parts < u["cost"]:
            return f"not enough parts (have {p.parts}, need {u['cost']})"
        p.parts -= u["cost"]
        self._grant(p, uid)
        return None

    def close_shop(self) -> Optional[dict]:
        """The shop is over: the next leg (and phase LEG), or None when that was the last leg."""
        self.shop_deadline_ms = None
        for p in self.pilots.values():
            p.offers = []
        if self.legs_done >= len(self.legs):
            self.phase = OVER
            return None
        self.phase = LEG
        return self.legs[self.legs_done]

    def take_box(self, callsign: str) -> Optional[str]:
        """next_box: the forced item for this pilot's next box roll (used up), or None."""
        p = self.pilots.get(callsign)
        if p is None or p.pending_box is None:
            return None
        item, p.pending_box = p.pending_box, None
        return item

    def shield_bonus_ms(self, callsign: str) -> int:
        return sum(e["ms"] * n for uid, n, e in self._effects_of(callsign) if e["fn"] == "shield_ms")

    def _effects_of(self, callsign: str):
        p = self.pilots.get(callsign)
        if p is None:
            return
        for uid, n in p.owned.items():
            for e in self.catalog.upgrades[uid]["effects"]:
                yield uid, n, e
        for uid in p.debuffs:
            for e in self.catalog.debuffs[uid]["effects"]:
                yield uid, 1, e

    def pilot_effects(self, callsign: str) -> list[dict]:
        """What the client applies: each effect entry with where it came from and how many stacks.
        next_box is a relay rule, but it is listed while pending so the client can show it."""
        p = self.pilots.get(callsign)
        out = []
        for uid, n, e in self._effects_of(callsign):
            if e["fn"] == "next_box" and (p is None or p.pending_box is None):
                continue
            row = self.catalog.get(uid)
            out.append({**e, "from": uid, "name": row["name"], "stacks": n,
                        "debuff": uid in self.catalog.debuffs})
        return out

    # -- frames
    def _upgrade_card(self, uid: str, p: RoguePilot) -> dict:
        u = self.catalog.upgrades[uid]
        return {"id": uid, "name": u["name"], "rarity": u["rarity"], "cost": u["cost"],
                "description": u["description"], "max_stacks": u["max_stacks"], "owned": p.owned.get(uid, 0)}

    def _pilot_public(self, p: RoguePilot) -> dict:
        return {"callsign": p.callsign, "parts": p.parts, "earned": p.earned,
                "owned": [{"id": uid, "name": self.catalog.upgrades[uid]["name"], "stacks": n} for uid, n in p.owned.items()],
                "debuffs": [{"id": d, "name": self.catalog.debuffs[d]["name"], "legs_left": n,
                             "description": self.catalog.debuffs[d]["description"]} for d, n in p.debuffs.items()],
                "effects": self.pilot_effects(p.callsign)}

    def card(self, callsign: Optional[str] = None) -> dict:
        """The `rogue` frame's body, personalised with `offers` for `callsign` (empty otherwise)."""
        p = self.pilots.get(callsign) if callsign else None
        return {"run_id": self.run_id, "phase": self.phase, "legs_done": self.legs_done, "leg_count": len(self.legs),
                "legs": [dict(x) for x in self.legs], "shop_deadline_server_ms": self.shop_deadline_ms,
                "pilots": [self._pilot_public(q) for q in self.standings()],
                "offers": [self._upgrade_card(uid, p) for uid in p.offers] if p is not None and self.phase == SHOP else []}

    def leg_frame(self, awards: dict[str, dict], engine: str) -> dict:
        names = self.catalog.upgrades
        return {"run_id": self.run_id, "leg_no": self.legs_done, "leg_count": len(self.legs), "engine": engine,
                "leg": dict(self.legs[self.legs_done - 1]) if self.legs_done else None,
                "landing_scored": engine == "dash",
                "rows": [{"callsign": cs, **a, "free_upgrade_name": names[a["free_upgrade"]]["name"] if a["free_upgrade"] else None,
                          "parts_total": self.pilots[cs].parts}
                         for cs, a in awards.items()]}

    def standings(self) -> list[RoguePilot]:
        """Most parts earned first, then most wins, then callsign."""
        wins = lambda p: sum(1 for x in p.legs if x["place"] == 1)   # noqa: E731
        return sorted(self.pilots.values(), key=lambda p: (-p.earned, -wins(p), p.callsign.casefold()))

    def end(self, reason: str) -> None:
        self.phase = OVER
        self.end_reason = reason
        self.shop_deadline_ms = None

    def summary(self, now_ms: int) -> dict:
        return {"run_id": self.run_id, "end_reason": self.end_reason, "legs_done": self.legs_done,
                "leg_count": len(self.legs), "legs": [dict(x) for x in self.legs], "day": self.day,
                "started_server_ms": self.started_ms, "ended_server_ms": now_ms,
                "standings": [{"pos": i + 1, "callsign": p.callsign, "earned": p.earned, "parts_left": p.parts,
                               "wins": sum(1 for x in p.legs if x["place"] == 1),
                               "upgrades": [{"id": uid, "name": self.catalog.upgrades[uid]["name"], "stacks": n}
                                            for uid, n in p.owned.items()],
                               "legs": list(p.legs)}
                              for i, p in enumerate(self.standings())]}


def summary_line(summary: dict) -> str:
    """The chat line a run ends with: who won and by how much. Display text, at most 240 chars."""
    why = {"complete": "", "ended": " (ended early)", "nightly": " (nightly reset)", "emptied": " (room emptied)"}
    head = f"Roguelike run over{why.get(summary.get('end_reason'), '')}, {summary['legs_done']}/{summary['leg_count']} legs: "
    body = " · ".join(f"{s['pos']}. {s['callsign']} {s['earned']} parts" for s in summary["standings"][:6]) or "nobody scored"
    return (head + body)[:240]


def _ordinal(n: int) -> str:
    return f"{n}{'th' if 10 <= n % 100 <= 20 else {1: 'st', 2: 'nd', 3: 'rd'}.get(n % 10, 'th')}"
