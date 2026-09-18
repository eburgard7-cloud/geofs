# Relay protocol

This documents `WS /ws/race/{room}` in `race/server/app.py` exactly as implemented today.
It is derived by reading `app.py`, not from race.js's client-side expectations or memory —
if this ever disagrees with `app.py`, `app.py` is right and this file is stale.

The relay carries three things: the **powerups** layer (proto 1, below), the **lobby**
(proto 2) and the **items** layer (proto 3), the last two at the end of this file. They share one
socket and one `Room`; a proto 1 client never sends a lobby or items frame and ignores the ones
it receives.

`joined` advertises a single integer, `PROTO` (currently **3**). A client gates each feature on
it: `>= 2` for the lobby, `>= 3` for the items layer. `LOBBY_PROTO`/`ITEMS_PROTO` in `app.py`
record which version each arrived in and are not sent anywhere.

## Route

```
WS /ws/race/{room}
```

- `room` must match `^[a-z0-9-]{1,32}$` (`ROOM_PATTERN`). A non-matching room is rejected by
  closing the socket with code `1008` before `join` is even possible.
- The client derives `room` from the course hash by default, or a hand-typed code slugged into
  the same shape (see `powerupsRoom()` in race.js). The server does not care where it came from.

## Framing, size, and rate limits

- Every frame is one WebSocket text frame containing one JSON object (`ws.receive_text()` /
  `ws.send_json()`) — no batching, no binary frames.
- **Size cap:** `MAX_WS_MSG_BYTES = 2048`. A frame whose UTF-8 encoding exceeds this closes the
  socket immediately with code `1009`, no `error` frame sent first.
- **Rate limit:** `WS_RATE_LIMIT_PER_S` (env `RACE_WS_RATE_PER_S`, default `20`) messages per
  rolling 1-second window per connection. Exceeding it does **not** close the socket on its
  own — it replies `{"type":"error","detail":"rate limited"}` and drops the message, and
  increments a violation counter.
- **Sustained flood:** after `WS_MAX_VIOLATIONS = 20` rate-limit violations on one connection,
  the socket is closed with code `1008`.
- A message that isn't valid JSON, or doesn't validate against one of the known frame shapes,
  gets `{"type":"error","detail":"<reason, truncated to 200 chars>"}` back; the connection is
  **never** closed for this.

## Session lifecycle

1. Client connects to `/ws/race/{room}`. Server calls `websocket.accept()` unconditionally once
   the room-name regex passes.
2. The **first** application message must be `join`. Any other message type sent before `join`
   gets `{"type":"error","detail":"join first"}` and is otherwise ignored (state is unchanged).
   `join` itself is not restricted to being first by validation — sending it again later just
   attempts to register a second time; see "Join" below for what happens then.
3. On clean or abnormal disconnect (`WebSocketDisconnect` or any exception unwinding the
   handler), the player (if joined) is removed from the room. If the room is now empty, the
   `Room` object itself is dropped from the in-memory `rooms` dict — nothing is persisted
   anywhere; a restart or last-player-leaves both erase all room state.

## Client → relay frames

### `join`
```json
{ "type": "join", "callsign": "string, 1-32 chars", "room": "string, optional, <=32 chars" }
```
- Must be the first message on the connection (see above), with one exception: `ping` (proto 2)
  is answered before `join`, since it measures the socket rather than the player.
- If `room` is present and doesn't equal the URL's `room` path segment, the server replies
  `{"type":"error","detail":"room mismatch"}` and does not join.
- If `callsign` is already registered to another live connection in this room, the server
  replies `{"type":"error","detail":"callsign already connected in this room"}` and does not
  join (no second `Player` object, existing one is untouched).
- On success, a `Player` is created (`gate=0`, `elapsed_ms=0`, `lat`/`lon`=`None`,
  `carrying`=`None`) and the server replies `{"type":"joined","room":"<room>"}`.

### `pos`
```json
{ "type": "pos", "lat": -90..90, "lon": -180..180, "gate": 0..201, "elapsed_ms": 0..21600000,
  "alt": -500..100000 }
```
- Requires a prior successful `join` (otherwise `"join first"`, see above).
- Updates the player's `gate`, `elapsed_ms`, `lat`, `lon` in place. This is the **only** source
  of truth the relay uses for ranking — the server never trusts anything else for a player's
  own progress.
- `alt` (proto 3, **optional and additive**) updates the player's altitude too. Its presence also
  marks the connection as a proto-3 client, which is what switches off the server-side 2D banana
  check for that player — see `tripped` and `_check_banana` below.
- After updating, the server checks whether this position crosses a live dropped banana
  (`_check_banana`, old clients only), broadcasts fresh standings to the whole room
  (`_broadcast_standings`, one `standings` frame per connected player, each addressed to that
  player's own socket), and may broadcast a `world` frame (`_broadcast_world`, coalesced to at
  most one every `WORLD_MIN_INTERVAL_S` = 0.5 s per room).

### `box`
```json
{ "type": "box", "id": 0..23 }
```
- Requires a prior `join`. `id` (proto 3, optional, default `0`) names which of the course's
  `itemBoxes` was crossed; an old client omits it and means box 0, which is exactly what a
  pre-0.10.0 course's single `itemBox` normalizes to. Out of range is a validation error.
- **Contested (proto 3):** if `room.boxes_dark[id]` is still in the future, the server replies
  with a `box_state` frame carrying that relight time **to the sender only**, performs no roll,
  and leaves `carrying` untouched. Otherwise it marks the box dark for `BOX_RESPAWN_S` (6 s) and
  broadcasts `box_state` to the whole room before the `boxed` broadcast below.
- The server computes the sender's current rank via `Room.ranking()`, calls
  `roll_item(rank, n_players)` (position-weighted table, see `weights_for_rank()`/`ITEMS` in
  `app.py`), stores the rolled item on `player.carrying`, sends
  `{"type":"grant","item":"<item>","box":<id>}` to the sender only, and broadcasts
  `{"type":"boxed","callsign":"<sender>","item":"<item>"}` to every *other* player in the room
  (`_broadcast_boxed`). `item` is always one of `ITEMS = ["nothing","banana","goop","boost",
  "missile"]`; `"nothing"` is a real, weighted outcome, not an absence of a message.
- There is no cooldown or "already carrying" check server-side — a second `box` while already
  carrying something simply overwrites `carrying` with the new roll. (The client enforces
  "once per run" itself; the relay does not.)

### `fire`
```json
{ "type": "fire", "item": "banana" | "goop" | "missile", "heading": 0..360 }
```
`heading` is proto 3, optional and additive: the shooter's current heading, used only to place a
banana behind them. An old client omits it and its banana lands where it is, which is the 0.9.0
behavior.
- Requires a prior `join`. `item` is restricted by the Pydantic model to exactly those three
  literals — `"boost"` and `"nothing"` are structurally impossible in a `fire` frame.
- **Grant-before-fire rule:** rejected unless `item` equals exactly what the server currently
  has recorded as `player.carrying`. On mismatch (including nothing carried, i.e.
  `carrying is None`), the server replies `{"type":"error","detail":"item not carried"}` and
  performs no targeting. This is enforced with `if player.carrying != msg.item`, a plain
  equality check — the string must match exactly.
- On success, `player.carrying` is cleared to `None` first, then `_resolve_fire` runs:
  - **`banana`:** if the shooter has a known `lat`/`lon`, a banana is appended to `room.bananas`
    at a point `BANANA_DROP_BACK_M` (150 m) along the reverse of `heading` — or at the shooter's
    own position when `heading` is absent. It arms `BANANA_ARM_MS` (1500 ms) later, carries the
    shooter's `alt`, and the drop is broadcast to the whole room as `dropped`. The list is capped
    at `MAX_BANANAS` (8) with the oldest evicted (and `cleared` with reason `expired`), and every
    banana expires after `BANANA_TTL_S` (120 s). If the shooter's position is unknown, the banana
    is silently lost — not an error.
  - **`goop` / `missile`:** targets the nearest player *ahead* by rank (`Room.ranking()`, the
    entry immediately before the shooter). If the shooter is already first there is no target:
    the item is **put back** on `player.carrying` and the shooter gets
    `{"type":"refund","item":"<item>","reason":"no_target"}` (proto 3; 0.9.0 silently burned it).
    Otherwise the whole room gets a `fired` frame with a `flight_ms` of
    `clamp(distance_m / 250 * 1000, lo, hi)` — `(1500, 4000)` for a missile, `(1000, 3000)` for
    goop — and the hit is **deferred** for that long (`_resolve_projectile`). There is no longer
    an instant-hit path in either direction.

### `fx` (proto 3)
```json
{ "type": "fx", "item": "boost" | "shield", "ms": 0..30000 }
```
"My Boost/Shield just lit up." Requires a prior `join`. Rate-limited to one per
`FX_MIN_INTERVAL_MS` (2000 ms) per player; frames inside that window are **silently dropped**, not
errored, because a dropped cosmetic frame is not a problem (a client draws its own effects
locally and never waits for its own echo). Accepted frames are rebroadcast to the whole room
**including the sender** as `{"type":"fx","callsign":..,"item":..,"ms":..}`.

This is cosmetic authority only, with exactly one exception: `item: "shield"` also sets
`player.shield_until = server_ms() + min(ms, SHIELD_MS)`, which is the window
`_resolve_projectile` and `_resolve_banana` check. A shield the relay never saw light up, or one
whose window has passed, blocks nothing.

### `tripped` (proto 3)
```json
{ "type": "tripped", "id": 0.. }
```
"I flew into banana `id`." Requires a prior `join`. Detection moved client-side because a 2 Hz
`pos` ping tunnels straight through a 75 m sphere at race speed; the client runs the same
interpolated 3D segment test the gates use, per frame.

The relay still validates the claim before honoring it:
- the banana must exist and be armed, otherwise the frame is ignored (no error);
- the claimant must have a known position, otherwise ignored;
- that position — the claimant's own most recent `pos`, which is the only position the relay
  ever accepts from them — must be within `BANANA_RADIUS_M + TRIP_SLACK_M` (75 + 400 m) of the
  banana, or the reply is `{"type":"error","detail":"too far from that banana"}` and the banana
  is left alone.

On success the banana is cleared for the room (`cleared`, reason `hit`) and the claimant receives
a `hit`. With the claimant's shield window open it is cleared with reason `blocked` and there is
no `hit`.

## Relay → client frames

### `joined`
```json
{ "type": "joined", "room": "string", "proto": 3, "server_ms": 1234567890123 }
```
Sent once, immediately after a successful `join`. `proto` and `server_ms` are new in proto 2 —
see "Proto 2: lobby" below for what a client does with them.

Immediately after `joined` (and before the `lobby` broadcast), proto 3 sends the joiner whatever
is already live in the room: one `dropped` per banana in `room.bananas`, and one `box_state` per
box still dark. A joiner is never blind to a banana dropped before it arrived.

### `grant`
```json
{ "type": "grant", "item": "nothing" | "banana" | "goop" | "boost" | "missile" }
```
Sent only to the player who crossed the box, in response to their `box` frame.

### `hit`
```json
{ "type": "hit", "item": "banana" | "goop" | "missile", "from": "string (shooter callsign)",
  "id": 42 }
```
Sent only to the victim, and in proto 3 only at **resolution** time — never at launch. `id`
(additive) is the projectile or banana it came from, so a client can tie it to the effect it has
been drawing. An old client on a new relay still receives exactly this frame and still applies the
effect; it just arrives `flight_ms` later than it used to.

Shield is now checked **by the relay** at resolution, from the window a `fx` frame opened, and a
blocked hit produces no `hit` frame at all. The victim's client still applies its own Shield on
receipt as well (`powerupsHit`), which is what keeps an old client correct.

### `world` (proto 3)
```json
{ "type": "world", "players": [ { "callsign": "Steve", "lat": 45.5, "lon": -122.6,
                                  "alt": 1200.0, "gate": 3 } ] }
```
Broadcast to the whole room, **coalesced to at most one every `WORLD_MIN_INTERVAL_S` (0.5 s) per
room** — not one per incoming `pos`. Carries every joined player whose position the relay knows;
a player who has never sent a `pos` is absent rather than present with nulls, and one whose `pos`
carried no `alt` appears with `alt: 0.0`.

This is what lets a client place an effect on another pilot. It adds nothing to the trust model:
every entry is that player's own `pos` coming back out, and nothing in this protocol lets one
client assert another's position. Clients prefer GeoFS's own `multiplayer.users` position when a
callsign can be matched to a live multiplayer user (it is interpolated per frame and therefore
smoother) and fall back to this frame otherwise.

### `fired` (proto 3)
```json
{ "type": "fired", "id": 42, "item": "missile" | "goop", "from": "Steve", "target": "Maggie",
  "flight_ms": 2400 }
```
Broadcast to the whole room the moment a missile or goop is fired. `id` is unique within the room.
`flight_ms` is `clamp(distance_m / 250 * 1000, ...)` per the clamps under `fire` above. Every
client renders the projectile from this; the victim also gets a HUD warning with a bar draining
over `flight_ms`. **Nothing has been hit yet.**

### `resolved` (proto 3)
```json
{ "type": "resolved", "id": 42, "item": "missile", "from": "Steve", "target": "Maggie",
  "blocked": false, "lost": false }
```
Broadcast to the whole room `flight_ms` after the matching `fired`, so every client ends its
projectile at the same moment. `blocked` is true when the target's shield window was open **at
resolution** — which is the entire reason the flight time exists. `lost` is true when the target
disconnected mid-flight, in which case nothing landed anywhere and there is no `hit`.

A `hit` follows on the victim's socket only when `blocked` and `lost` are both false.

### `dropped` (proto 3)
```json
{ "type": "dropped", "id": 43, "lat": 45.5, "lon": -122.6, "alt": 1200.0, "from": "Steve",
  "armed_at_server_ms": 1234567890123 }
```
Broadcast to the whole room when a banana is dropped, and replayed to a joiner for every banana
already live. `armed_at_server_ms` is on the relay's clock — a client converts it through the same
`ping`/`pong` offset the lobby countdown uses. Before that moment the banana cannot hit anyone,
which is what stops a dropper killing the wingman on their tail.

### `cleared` (proto 3)
```json
{ "type": "cleared", "id": 43, "by": "Maggie" | null, "reason": "hit" | "blocked" | "expired" }
```
Broadcast to the whole room when a banana leaves the world: somebody hit it (`hit`), somebody's
shield ate it (`blocked`, no penalty), or it aged out / was evicted past `MAX_BANANAS`
(`expired`, `by` is `null`).

Clients enforce their own TTL on every item entity regardless, so a `cleared` lost to a dropped
socket can never strand a banana on the course.

### `box_state` (proto 3)
```json
{ "type": "box_state", "id": 2, "until_server_ms": 1234567890123 }
```
Broadcast to the whole room when a box is taken, sent to a joiner for every box still dark, and
sent **to the sender alone** as the refusal for a `box` on a box that is already dark. Clients
hide a dark box and fade it back in.

### `refund` (proto 3)
```json
{ "type": "refund", "item": "missile", "reason": "no_target" }
```
Sent to the shooter alone when a `fire` had nowhere to go (they are already in the lead). The item
is back on `player.carrying` and is immediately fireable again.

### `fx` (proto 3)
```json
{ "type": "fx", "callsign": "Steve", "item": "boost" | "shield", "ms": 4000 }
```
Broadcast to the whole room including the sender. Cosmetic — see the client→relay `fx` above for
the one piece of bookkeeping it also drives.

### `boxed`
```json
{ "type": "boxed", "callsign": "string (who boxed)", "item": "nothing" | "banana" | "goop" | "boost" | "missile" }
```
Broadcast to every player in the room *except* the one who boxed, whenever anyone crosses the
box. Drives the client's kill feed.

### `standings`
```json
{ "type": "standings", "order": ["callsign1", "callsign2", ...],
  "positions": { "callsign1": [45.58, -122.6], "callsign2": [45.57, -122.61] } }
```
Broadcast to every connected player (including the sender of the triggering `pos`) after every
`pos` update. `order` is leader-first: most gates passed, ties broken by lower `elapsed_ms`
(`Room.ranking()`). Includes every currently-joined player in the room, full list each time —
not a diff.

`positions` (added 0.9.0, **additive** — a client that does not know the field ignores it, and a
client talking to an older relay that omits it simply has no other racers to draw) maps callsign
to `[lat, lon]` for every joined player whose position the relay knows, i.e. everyone who has sent
at least one `pos`. A player who has not sent one is absent from the map rather than present with
nulls. It is the client's own `pos` data coming back out, so it adds nothing to the trust model:
the relay is still the only collector, and no client can assert another player's position. Its
consumer is the HUD minimap (README "Ghost racing"); the client validates every pair as two
finite, in-range numbers before drawing it and drops anything else.

### `error`
```json
{ "type": "error", "detail": "string, <=200 chars" }
```
Sent to the one connection that caused it. The connection is always left open after an `error`
frame — the only frame-triggered closes in this protocol are the size-cap (`1009`) and
sustained-flood (`1008`) cases, both of which happen *before* any `error` frame logic runs.

## Trust model

- The relay is authoritative for: what item a `box` roll produces, and who a `fire` hits.
  A client cannot request a specific item or a specific target.
- The relay treats `pos` as authoritative *only for that connection's own player* — nothing in
  this protocol lets one client assert or override another player's `gate`/`elapsed_ms`/`lat`/
  `lon`. Ranking used for both `standings` and box weighting is always computed server-side from
  each player's own most recent `pos` frames.
- Proto 3 adds exactly two things the relay takes a client's word for, and validates both:
  a player's **own** shield (via `fx`, capped at `SHIELD_MS`, and only ever believed inside the
  window it opened), and a player's **own** "I flew into that banana" (via `tripped`, refused
  unless that player's own last reported position is within `BANANA_RADIUS_M + TRIP_SLACK_M`).
  Everything else is unchanged: the relay still picks the item, the target, and the moment a
  projectile lands, and no client can assert anything about another player.
- All room state (`rooms`, `Room.players`, `Room.bananas`, `Room.boxes_dark`) lives in a
  process-local Python dict —
  in-memory only, no SQLite, no disk. It is intentionally lost on container restart or when a
  room empties. Only finished-race results (via `POST /runs`, unrelated to this WebSocket) are
  ever written to SQLite.

## Versioning

- The relay's `joined` frame carries an integer `proto` field: `{"type":"joined","room":"...",
  "proto": 3, "server_ms": ...}`. Absence of `proto` means protocol version `1` (no server this
  old exists anymore, but a client still treats a missing/lower `proto` as "no lobby").
- Clients gate any new relay-dependent feature on the `proto` value received in `joined`,
  falling back to old behavior (or disabling the feature with a status-line note) when the
  server reports a lower version than the feature needs, or omits `proto` entirely.
- An unknown frame `type` — in either direction — must never close the socket. The relay's
  existing behavior already satisfies this for client→relay frames (`parse_message` raises
  `ValueError` on an unrecognized `type`, which the handler turns into an `error` frame, socket
  left open); this must remain true as new frame types are added, and any new relay→client
  frame types must be additive so an old client can safely ignore a frame type it doesn't
  recognize.

## Proto 2: lobby

Before proto 2, a group agreed a takeoff time over voice chat and each typed the same
`HH:MM:SS` into their own client's local-clock countdown (race.js's `Countdown` module,
still there — see "Manual sync" below). Proto 2 replaces that with a relay-managed lobby: one
room state, one host, one clock everyone's countdown is measured against, and a start that is
refused until the room actually agrees to it.

### Clock sync

### `ping` / `pong`
```json
{ "type": "ping", "t0": 1234.5 }
{ "type": "pong", "t0": 1234.5, "server_ms": 1234567890123 }
```
- `ping` is the one frame allowed before `join` — it measures the socket's round trip, not a
  player. `t0` is opaque to the server: whatever the client sends comes back unchanged.
- The client is expected to send 5 pings ~200 ms apart on connect and take the minimum-RTT
  sample (see `clockOffset()` in race.js), then re-sync every 60 s. The relay itself has no
  notion of "a sync round" — every `ping` just gets a `pong`.

### Room shape

A `Room` (in-memory, per the trust model below) now additionally holds:

- `host`: the callsign of the first player to join, or `None` for an empty room. On that
  player's disconnect, migrates to the longest-connected remaining player (join order is
  preserved, so this is just the next key in `players`).
- `phase`: one of `"lobby"`, `"countdown"`, `"racing"`, `"results"`. New rooms start in
  `"lobby"`; nothing currently drives a room into `"results"` (reserved for a later change).
- `course`: `null`, or `{course_id, course_hash, name, start_type}` — set only by the host's
  `course` frame.
- `rules`: `{"powerups": bool, "teleport": bool}`, defaulting to both `true`.
- `race_id`: an integer, `0` until the first `start`, incremented on every accepted `start`.
- Per player: `ready` (bool, default `false`), `model` (string ≤32, default `""`, set by
  `hello`), `role` (`"racer"` or `"spectator"`, default `"racer"`).

### Client → relay frames (proto 2)

### `hello`
```json
{ "type": "hello", "model": "string, <=32 chars" }
```
Sets the sender's displayed model. Broadcasts `lobby`.

### `ready`
```json
{ "type": "ready", "ready": true }
```
Sets the sender's ready flag. Broadcasts `lobby`. Any player can send this — it is not host-only.

### `course` (host only)
```json
{ "type": "course", "course_id": "steve-sprint", "course_hash": "0a1b2c3d",
  "name": "Steve Sprint", "start_type": "ground" | "air" }
```
Sets the room's course and **clears every player's ready flag** — a stale "yes" from before the
course changed would let a start proceed with racers who never confirmed the new one. Broadcasts
`lobby`. Rejected with `{"type":"error","detail":"host only"}` for a non-host sender.

### `rules` (host only)
```json
{ "type": "rules", "powerups": true, "teleport": true }
```
Sets the room's rules and, like `course`, clears every ready flag. Broadcasts `lobby`.

### `start` (host only)
```json
{ "type": "start", "lead_s": 5..60, "force": false }
```
- Refused with `{"type":"error","detail":"no course set"}` if `room.course` is `null`.
- Refused with `{"type":"error","detail":"not everyone is ready"}` if any player's `ready` is
  `false` and `force` is not `true`.
- On acceptance: `phase` becomes `"countdown"`, `race_id` increments, every player whose `ready`
  was `false` becomes `role: "spectator"` (a `force` start; everyone-ready starts leave every
  role as `"racer"`), and the relay broadcasts `start` (below) to the whole room, followed by a
  `lobby` broadcast reflecting the new phase/race_id/roles. A server-side asyncio task then
  flips `phase` to `"racing"` at `start_at_server_ms` — no client action needed — unless `abort`
  cancels it first.
- `lead_s` is clamped by validation to `5..60` inclusive; anything else is a validation error
  (generic `error` frame, connection stays open).

### `abort` (host only, countdown phase only)
```json
{ "type": "abort" }
```
Cancels the pending countdown task, returns `phase` to `"lobby"`, and restores every player's
`role` to `"racer"` — **ready flags are left exactly as they were**, since aborting isn't the
same as anyone taking back their "yes". Broadcasts `abort` (below) then `lobby`. Refused with
`{"type":"error","detail":"nothing to abort"}` outside the `"countdown"` phase.

### `chat`
```json
{ "type": "chat", "code": "ready_soon" | "need_2_min" | "gg" | "rematch" | "brb" | "boss_incoming" }
```
A fixed enum, not free text — the relay can never be used to relay arbitrary strings between
clients. Broadcast to the whole room, **including the sender** (so one client's own feed can
just render whatever this socket receives, without special-casing its own message). Any player
may send it. An unrecognized code is a validation error, not silently dropped.

### `back_to_lobby` (host only)
```json
{ "type": "back_to_lobby" }
```
Cancels any pending countdown, sets `phase` to `"lobby"`, **clears every ready flag**, and
restores every player's `role` to `"racer"`. Broadcasts `lobby`.

### Relay → client frames (proto 2)

### `lobby`
```json
{ "type": "lobby", "phase": "lobby", "host": "callsign or null", "course": null,
  "rules": { "powerups": true, "teleport": true }, "race_id": 0,
  "players": [ { "callsign": "string", "model": "string", "ready": false, "role": "racer" } ] }
```
Broadcast to the whole room after `join`, `hello`, `ready`, `course`, `rules`, `start`, `abort`,
`back_to_lobby`, and a disconnect that leaves the room non-empty. `players` is the full list
every time, in join order — not a diff. A proto 1 client neither expects nor reads this frame;
receiving it and ignoring it is exactly what "additive" requires.

### `start`
```json
{ "type": "start", "race_id": 1, "start_at_server_ms": 1234567890123, "racers": ["Steve", "Maggie"] }
```
Sent once per accepted `start`, to the whole room (spectators included — they still need to know
when the countdown ends). `start_at_server_ms` is computed from the relay's own clock
(`server_ms() + lead_s*1000`), never a client-supplied time. `racers` is every player whose role
became (or stayed) `"racer"` for this start, in join order.

### `abort`
```json
{ "type": "abort" }
```
Sent to the whole room when the host aborts a countdown. Carries no other data — clients read
the room's new phase from the `lobby` broadcast that immediately follows.

### `chat`
```json
{ "type": "chat", "callsign": "string", "code": "gg" }
```
Broadcast to the whole room, including the sender, whenever anyone sends a `chat` frame.

### Trust model additions (proto 2)

- The relay is authoritative for: who the host is, what phase the room is in, whether a `start`
  is allowed, and `start_at_server_ms`. A client cannot promote itself to host, force a phase
  transition other than through `start`/`abort`/`back_to_lobby`, or supply its own start time.
- Lobby state (`host`, `phase`, `course`, `rules`, `race_id`, `ready`, `model`, `role`) lives on
  the same in-memory `Room` as everything else in this file — no persistence, gone on restart or
  when the room empties, same as the powerups relay's existing trust model above.
- A player who joins while `phase` is `"countdown"` or `"racing"` joins as `role: "spectator"`
  — there is no path for a client to join mid-race as a racer short of the host calling
  `back_to_lobby` first.


## Proto 3: items

Proto 3 is entirely about making the powerups layer **visible**. Before it, every offensive item
was a message: a missile was an instant server-side `hit` with no projectile, a banana was an
unseen position check against 2 Hz pings, and nobody could see anyone else's Boost or Shield.

Nothing in it is a new socket, a new route or a new persistence layer. It is a handful of
additive frames (all documented in place above) plus three changes to existing ones:

| Frame | Change |
|---|---|
| `pos` | gains optional `alt`; its presence marks a proto-3 client |
| `box` | gains optional `id`; a dark box is refused with `box_state` |
| `fire` | gains optional `heading`; missile/goop now `fired` → `resolved` instead of an instant `hit` |
| `grant` | gains `box` (which box it came from) |
| `hit` | gains `id`; arrives at resolution, never at launch |

New client→relay: `fx`, `tripped`.
New relay→client: `world`, `fired`, `resolved`, `dropped`, `cleared`, `box_state`, `refund`, `fx`.

### Compatibility

**An old client on a proto-3 relay keeps working.** It never sends `alt`, so the relay keeps
running the server-side 2D banana check for it; it never sends `box.id`, so it means box 0; it
never sends `heading`, so its banana lands where it is. It receives `fired`/`resolved`/`world`
and every other new frame type and ignores them, exactly as this file's "Versioning" rule
requires — and it still gets its `hit`, just at resolution time rather than instantly.

**A proto-3 client on an old relay keeps working.** `Relay.proto` stays below 3, the whole items
layer stays dark, `CONFIG.ITEMS` might as well be false, and the client behaves exactly like
0.9.0 with one note on the status line saying which proto the relay speaks.

### Room state added

- `bananas`: a list of `{id, lat, lon, alt, from, dropped_at, armed_at}`, capped at `MAX_BANANAS`
  (8), each expiring after `BANANA_TTL_S` (120 s).
- `boxes_dark`: `{box id: server_ms it relights at}`.
- `next_id`: ids for projectiles and bananas, unique within the room.
- `world_last`: the monotonic time of the last `world` broadcast, for the 2 Hz coalescing.
- `tasks`: in-flight `_resolve_projectile` tasks, cancelled when the room empties.
- Per player: `alt`, `shield_until`, `last_fx_ms`, `proto3`.

All of it is in-memory like everything else in this file: a restart or an empty room drops every
live banana, dark box and in-flight projectile. Nothing about proto 3 goes to SQLite.
