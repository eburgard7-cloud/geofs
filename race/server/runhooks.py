"""Generic "run" hooks: the seam later event types wrap instead of rewriting an engine.

Both race engines in app.py -- the gate race (a one-off or a cup leg) and the Dash -- emit the same
three events on their room's `RunHooks`. A wrapper such as a Roguelike Cup or Gun Game subscribes to
a room, watches legs start, finish and score, and decides what happens between them. See
race/server/HOOKS.md for the contract and a worked example.

Pure: no FastAPI, no sockets. Subscribers may be plain functions or coroutines; either way a
subscriber that raises is logged and skipped, and can never break the race loop that emitted.
"""
import inspect
import logging
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

LEG_START = "leg_start"        # the clock started: the gate race's GO flip, the Dash's GO
LEG_FINISH = "leg_finish"      # one entrant got a result: finished, or out (dnf / disconnect / timeout)
LEG_RESULTS = "leg_results"    # the leg is scored and its results are up
EVENTS = (LEG_START, LEG_FINISH, LEG_RESULTS)

log = logging.getLogger("race.hooks")


@dataclass
class LegEvent:
    """One hook event. `payload` is per event:

    leg_start   {"entrants": [callsign, ...], "go_server_ms": int, ...engine extras}
    leg_finish  {"callsign": str, "status": "finished" | "dnf", "result": {...engine row}}
    leg_results {"rows": [...public rows, best first], "frame": the results frame as sent}

    `hold_home` only means something on leg_results: a subscriber that sets it takes over the
    room's way back to ROAM (the engine schedules no linger), and must later call app.go_home()
    or start the next leg itself.
    """
    event: str
    engine: str                 # "race" (gate race / cup leg) | "dash"
    room: str                   # the room code
    leg_id: int                 # race_id for a gate race, dash_id for a Dash
    server_ms: int
    payload: dict = field(default_factory=dict)
    hold_home: bool = False


Subscriber = Callable[[LegEvent], Any]


class RunHooks:
    """Per-room subscriber lists. `on()` returns an unsubscribe function."""

    def __init__(self):
        self._subs: dict[str, list[Subscriber]] = {e: [] for e in EVENTS}

    def on(self, event: str, fn: Subscriber) -> Callable[[], None]:
        if event not in self._subs:
            raise ValueError(f"unknown hook event {event!r} (one of {', '.join(EVENTS)})")
        self._subs[event].append(fn)

        def off() -> None:
            try:
                self._subs[event].remove(fn)
            except ValueError:
                pass
        return off

    def has(self, event: Optional[str] = None) -> bool:
        return any(self._subs[e] for e in (EVENTS if event is None else (event,)))

    async def emit(self, ev: LegEvent) -> LegEvent:
        """Call every subscriber in subscription order and return the event (with whatever
        `hold_home` they set). Never raises."""
        for fn in list(self._subs.get(ev.event, ())):
            try:
                out = fn(ev)
                if inspect.isawaitable(out):
                    await out
            except Exception:
                log.exception("run hook %s for %s leg %s in %s failed", ev.event, ev.engine, ev.leg_id, ev.room)
        return ev
