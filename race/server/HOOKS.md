# Run hooks

This is the seam that later event types (Roguelike Cup, Gun Game, and whatever comes after) use to
wrap the two race engines without rewriting them. The engines are the **gate race** (a one-off or
a cup leg, in `app.py`) and the **Dash** (`dash_engine.py`, driven by `app.py`). Server-side only.
Nothing here is on the wire, so it needs no proto bump of its own.

Code: `race/server/runhooks.py` (pure). Each `Room` has its own `room.hooks = RunHooks()`.

## Events

Every event is a `LegEvent(event, engine, room, leg_id, server_ms, payload, hold_home=False)`.
`engine` is `"race"` or `"dash"`. `leg_id` is the room's `race_id` for a gate race and the
`dash_id` for a Dash. `server_ms` is the relay's clock when the event fired.

| Event | Fires when | `payload` |
|---|---|---|
| `leg_start` | The clock starts. For a gate race, that's the countdown or FORMATION flipping to `racing`. For a Dash, it's GO, after the re-check scratches anyone off the line. | `entrants` (callsigns), `go_server_ms`; gate race: `course`; Dash: `route_key` |
| `leg_finish` | An entrant gets a result: a finish, a `dnf`, a disconnect, a timeout, or a straggler at the end. Fires once per entrant, in the order the results happened, and always before that leg's `leg_results`. | `callsign`, `status` (`finished` or `dnf`), `result` (the engine's row for that entrant) |
| `leg_results` | The leg is scored. Fires after the room's phase is `results` or `dash_results`, and before the results frame goes out. | `rows` (public rows, best first), `frame` (the results frame about to be sent) |

A leg that never starts fires nothing: an aborted countdown, or a Dash cancelled before GO.

## Contract

- **Subscribe:** `off = room.hooks.on("leg_results", fn)`. `fn(ev)` may be a plain function or a
  coroutine function. `off()` unsubscribes and is safe to call twice. An unknown event name raises
  `ValueError` at subscribe time.
- **Order:** subscribers run in subscription order and are awaited one after another, inside
  the relay's event loop. Keep them quick. A slow subscriber delays the results frame for
  everyone in the room.
- **Failure:** a subscriber that raises is logged (`race.hooks` logger) and skipped. The leg
  carries on as if it weren't there. A hook can never take a room down.
- **Read-only, except one thing:** a subscriber should treat `payload` as read-only. The one thing
  it may change is `ev.hold_home`, on `leg_results`.

### `hold_home`: taking over between legs

By default the room goes home on its own after a leg:

- **Gate race:** `RESULTS_LINGER_S` later, or as soon as everyone dismisses the results.
- **Dash:** `dash_engine.RESULTS_LINGER_MS` later, or when everyone dismisses.

Both routes end in `app.go_home()`, which puts the room in ROAM and sends `home` and `lobby`.

A `leg_results` subscriber that sets `ev.hold_home = True` **takes over that step**:

- **Gate race:** no linger is scheduled, and the results frame carries no `lobby_at_server_ms` or
  `next_leg`.
- **Dash:** the results stay up and neither the linger nor a dismiss sends the room home.

The wrapper is then responsible for what comes next. It either:

- calls `await app.go_home(room, "<reason>", revote=...)` to send everyone home, or
- sets up and starts the next leg itself.

A host `back_to_lobby` still works and goes home regardless.

## Sketch: a Roguelike Cup

```python
from runhooks import LEG_FINISH, LEG_RESULTS

def attach_roguelike(room, legs):
    state = {"leg": 0, "alive": None}

    def on_finish(ev):
        if ev.payload["status"] == "dnf" and state["alive"] is not None:
            state["alive"].discard(ev.payload["callsign"])       # out of the run

    async def on_results(ev):
        ev.hold_home = True                                       # we decide what's next
        state["leg"] += 1
        if state["leg"] >= len(legs) or not state["alive"]:
            await app.go_home(room, "roguelike_over", revote=True)
            return
        room.course = legs[state["leg"]]                          # next leg, same room, same chat
        await app.go_home(room, "roguelike_next")                 # ready-up for it in ROAM

    room.hooks.on(LEG_FINISH, on_finish)
    room.hooks.on(LEG_RESULTS, on_results)
```

Gun Game works the same way: it reads `leg_finish` to award a weapon tier, and `leg_results`
(with `hold_home`) to pick the next leg's course or Dash route.

## Where the engines fire them

| Engine | `leg_start` | `leg_finish` | `leg_results` |
|---|---|---|---|
| gate race (`app.py`) | `_race_leg_start()`, from `_run_countdown()` / `_run_formation()` | `_race_leg_finish()`, from `_accept_finish()`, `_accept_dnf()`, `_note_disconnect()`, and `_end_race()` for stragglers | `_end_race()` |
| Dash (`app.py` glue over `dash_engine.py`) | the engine's `leg_start` event at GO | the engine's `leg_finish` events (finish, dnf, timeout, left, cap) | the engine's `results` event |
