# Relay protocol

This documents `WS /ws/race/{room}` in `race/server/app.py` exactly as implemented today.
It is derived by reading `app.py`, not from race.js's client-side expectations or memory —
if this ever disagrees with `app.py`, `app.py` is right and this file is stale.

The relay carries four things: the **powerups** layer (proto 1, below), the **lobby**
(proto 2), the **items** layer (proto 3) and **results and cups** (proto 4), the last three at the
end of this file. They share one socket and one `Room`; a proto 1 client never sends a lobby,
items or results frame and ignores the ones it receives.

`joined` advertises a single integer, `PROTO` (currently **4**). A client gates each feature on
it: `>= 2` for the lobby, `>= 3` for the items layer, `>= 4` for results and cups.
`LOBBY_PROTO`/`ITEMS_PROTO`/`RESULTS_PROTO` in `app.py` record which version each arrived in and
are not sent anywhere.

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
   handler), the player (if joined) is removed from the room, and if they were the host the host
   migrates to the longest-connected remaining player. If the room is now empty, its countdown,
   in-flight projectiles and race record are cancelled and the `Room` object itself is dropped from
   the in-memory `rooms` dict — nothing about the room is persisted anywhere; a restart or
   last-player-leaves both erase all room state. If it is not empty, a racer who was still flying is
   recorded as a DNF (`_note_disconnect`, which can be what ends the race) and a `lobby` frame goes
   out.

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
  `carrying`=`None`) and the server replies with `joined` (`room`, `proto`, `server_ms` — see
  "Relay → client frames"), then whatever is already live in the room, then a `lobby` broadcast.
  Two side effects of joining: the first player into an empty room becomes `host`, and anyone who
  joins while `phase` is not `"lobby"` joins as a `spectator`.

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
- After updating, the server records the racer's progress for the results tallies (`_note_pos`,
  proto 4 — only while a race is under way and that racer has no result yet), expires old
  bananas and checks whether this position crosses a live dropped banana (`_check_banana`, the
  crossing check for old clients only), broadcasts fresh standings to the whole room
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
{ "type": "joined", "room": "string", "proto": 4, "server_ms": 1234567890123 }
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
  room empties. Exactly two kinds of thing are ever written to SQLite: leaderboard runs and ghost
  traces via `POST /runs` (unrelated to this WebSocket), and — from proto 4 — one finished lobby
  race and its cup, once, when the race ends ("Proto 4: results and cups" below).

## Versioning

- The relay's `joined` frame carries an integer `proto` field: `{"type":"joined","room":"...",
  "proto": 4, "server_ms": ...}`. Absence of `proto` means protocol version `1` (no server this
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
  `"lobby"`. `"results"` was reserved in proto 2 and is entered in proto 4, when a race ends (see
  "Proto 4: results and cups").
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
`course_id` is `^[a-z0-9-]+$` (1–64), `course_hash` is exactly 8 lowercase hex characters, `name` is
1–48 chars. Sets the room's course and **clears every player's ready flag** — a stale "yes" from before the
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
- Not restricted by phase: a `start` over a countdown, a race in flight or the results replaces
  them (the old countdown is cancelled and the old race record dropped unscored).
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
  "cup": null,
  "players": [ { "callsign": "string", "model": "string", "ready": false, "role": "racer" } ] }
```
`cup` is proto 4 and additive: `null`, or `{ "name": "Friday Night", "race_no": 1, "race_count": 4 }`
for the cup in progress (`race_no` is how many of its races have finished).
Broadcast to the whole room after `join`, `hello`, `ready`, `course`, `rules`, `start`, `abort`,
`back_to_lobby`, `cup`, `rematch`, a disconnect that leaves the room non-empty, the moment the
countdown flips `phase` to `"racing"`, and the moment a race ends and `phase` becomes `"results"`.
`players` is the full list
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


## Proto 4: results and cups

Proto 4 ends a lobby race. Before it, a race simply stopped mattering when people stopped flying;
now every lobby race finishes on one shared results screen, scored with points, and a host can
string races into a **cup** whose points carry from one race to the next.

Everything is additive, and none of it is a new socket or route. New client→relay frames: `finish`,
`dnf`, `cup`, `rematch`. New relay→client frames: `results_progress`, `results`. The `lobby` frame
gains `cup`. Finished races and cups are also readable over plain HTTP (README "Leaderboard
server"): `GET /races/recent`, `GET /cups/{id}`, `GET /cups`.

### Client → relay frames (proto 4)

### `finish`
```json
{ "type": "finish", "race_id": 3, "go_time_ms": 184213, "splits": [61210, 122400, 184213],
  "best_sector_ms": 61210, "jump_start": false }
```
"I crossed the last gate." Any joined player may send it; the relay decides whether to believe it.
`go_time_ms` is on the **lobby-race clock** — measured from the synced GO, jump-start penalty
included — and is *not* the leaderboard's gate-1 clock, which `POST /runs` still uses. `splits` is
cumulative from the gate-1 crossing and optional (default `[]`, at most 200, non-decreasing);
`best_sector_ms` is optional, and only the fallback for a frame that left `splits` out, because the
relay derives the shortest leg from `splits` when it has them (`best_sector_from`). A client drops
`splits` when the frame would not fit `MAX_WS_MSG_BYTES`.

A finish is accepted only if **all** of these hold, checked in this order; the first that fails is
the reason in the reply:

| Refusal (`detail` is `finish rejected: <reason>`) | When |
|---|---|
| `no race in progress` | the room has no race record (nothing was started, or it was called off) |
| `wrong race` | `race_id` is not the room's current one |
| `the race is over` | the results are already out |
| `not a racer in this race` | the sender was a spectator, or joined after the start |
| `already finished or out` | the sender already has a result — a finish, a `dnf`, or a disconnect |
| `the race has not started` | still in the countdown |
| `time does not match the relay's clock` | `go_time_ms` is more than `FINISH_TOLERANCE_MS` (3000) from `server now − start_at_server_ms` |

A refusal is an `error` frame to the sender alone. It changes nothing, and the connection stays
open. `jump_start: true` moves the window **later** by `JUMP_START_PENALTY_MS` (5000), because a
jump-starter's clock carries that penalty — so claiming a jump start can never buy a faster time.
The relay does not check the flight itself (which gates were crossed); a time that agrees with its
own clock is what it takes, which is this project's usual friend-group posture.

### `dnf`
```json
{ "type": "dnf", "race_id": 3, "gate": 4 }
```
"I am out" — sent on a DQ or a mid-race reset. Same acceptance rules as `finish` minus the time
check (`dnf rejected: <reason>`). `gate` is the last gate the sender reached and is used to order
the DNFs against each other.

### `cup` (host only)
```json
{ "type": "cup", "name": "Friday Night", "race_count": 4 }
```
Starts a cup for the room: `name` 1–32 chars, `race_count` 1–12. Replaces any cup already running
(starting from no points). Accepted only in the `"lobby"` and `"results"` phases; a `cup` mid-race is
refused with `a cup can only change between races`. With no cup, every race is a one-off. Broadcasts
`lobby`.

### `rematch` (host only, results phase only)
```json
{ "type": "rematch" }
```
Same course, `phase` → `"lobby"`, every ready flag cleared, every role back to `"racer"`, the
race record dropped. A cup carries on. Refused with `nothing to rematch` outside `"results"`.
"Next course" is the existing `course` + `back_to_lobby`; `back_to_lobby` and `abort` now also drop
the race record, so a race called off early is **not** scored and does not count towards a cup.

### Relay → client frames (proto 4)

### `results_progress`
```json
{ "type": "results_progress", "race_id": 3,
  "rows": [ { "pos": 1, "callsign": "Steve", "model": "F-16", "go_time_ms": 184213, "gap_ms": 0,
              "status": "finished", "points": 15, "items_used": { "boost": 1 }, "hits_taken": 0,
              "jump_start": false, "gate": null } ],
  "waiting": ["Maggie", "Eric"], "deadline_server_ms": 1234567890123 }
```
Broadcast to the whole room after each accepted `finish`, `dnf` or racer disconnect **that does not
end the race**, once there is a first finisher. `rows` are the finishers so far (same row shape as
`results`); a finisher's place and points are already final, since nobody who finishes later can be
ahead of them. `waiting` is who the room is still waiting for, and `deadline_server_ms` (on the
relay's clock) is when they stop being waited for.

### `results`
```json
{ "type": "results", "race_id": 3,
  "course": { "course_id": "steve-sprint", "course_hash": "0a1b2c3d", "name": "Steve Sprint", "start_type": "air" },
  "rows": [ { "pos": 1, "callsign": "Steve", "model": "F-16", "go_time_ms": 184213, "gap_ms": 0,
              "status": "finished", "points": 15, "items_used": { "boost": 1, "missile": 2 },
              "hits_taken": 0, "jump_start": false, "gate": null },
            { "pos": 2, "callsign": "Maggie", "model": "", "go_time_ms": null, "gap_ms": null,
              "status": "dnf", "points": 0, "items_used": {}, "hits_taken": 3, "jump_start": false, "gate": 4 } ],
  "awards": [ { "key": "sharpshooter", "callsign": "Steve", "detail": "2 hits landed" } ],
  "cup": { "name": "Friday Night", "race_no": 2, "race_count": 4,
           "standings": [ { "callsign": "Steve", "points": 27 }, { "callsign": "Maggie", "points": 12 } ] } }
```
Broadcast to the whole room, spectators included, when the race ends; the room's `phase` becomes
`"results"` and a `lobby` broadcast follows. It is also sent to anyone who joins while `phase` is
`"results"`. `cup` is `null` for a one-off. Rows are best first: finishers by `go_time_ms`
(an exact tie goes to whichever finish the relay accepted first), then DNFs by how far they got.

- `go_time_ms` and `gap_ms` (to the winner) are `null` for a DNF. `gate` is `null` for a finisher and
  the last gate reached for a DNF (additive; not in the original sketch).
- `items_used` is `{item: count}` over `banana`, `goop`, `missile`, `boost`, `shield`; `hits_taken`
  counts hits that landed on that racer — a blocked hit counts for neither side.
- **Points** are 15, 12, 10, 8, 6, 4, 2, 1 by finishing position; a DNF, or 9th and below, scores 0
  (`points_for`). A cup total is the sum over its races, standings ordered by points then callsign.
- **Awards** (`compute_awards`, an award with no qualifying data is omitted): `most_hits_taken`,
  `sharpshooter` (most offensive items that landed), `biggest_comeback` (worst place minus final
  place, at least 2, finishers only), `fastest_sector` (single shortest gate-to-gate leg),
  `clean_race` (a finisher with no hits taken — only when somebody in the race was hit) and
  `jump_starter`. A tie for a one-winner award goes to the better-placed pilot; `clean_race` and
  `jump_starter` list every qualifying pilot, one entry each. `detail` is display text.

### When a race ends

A race is tracked from `start` (`race_id`, the racers as they were at that moment, their models) and
ends when **every racer has a result** or **`RESULTS_TIMEOUT_S` (120) after the first finish**.
A racer's result is a finish, a `dnf`, or a disconnect (a DNF at their last reported gate — a
finisher who then disconnects keeps their finish). At the deadline every remaining racer becomes a
DNF at the last gate they reported. Spectators never hold a race open. The end is idempotent: the
last finisher, the deadline and a disconnect can all arrive together. A start with nobody racing
creates no race record, so nothing ends it and the host's `back_to_lobby` is the way out — which is
also how a room recovers from a client that never sends `finish` (any pre-0.11.0 client).

Tallies (`items_used`, `hits_taken`, `hits_blocked`, `hits_landed`, worst place) come from frames
the relay was already handling — `fire`, `fx`, projectile and banana resolution, `pos` — never from
the client's word, and only while a race is under way and that racer has no result yet, so nothing
thrown in the lobby, and no hit after a pilot has crossed the line, reaches a results row. A
refunded item (the leader's missile with nobody ahead) is not counted as used.

### Persistence

Room state stays in memory. Only a finished race is written to SQLite — once, in a worker thread
(`asyncio.to_thread`) so the event loop never waits on the disk, after `results` has already gone
out. A failed write is logged and dropped; the room carries on. Per room, writes are serialized so
a cup's second race always finds the cup row its first race created.

| Table | Columns |
|---|---|
| `races` | `id`, `room`, `course_hash`, `course_name`, `started_at` (GO, unix s), `cup_id` (NULL for a one-off) |
| `race_results` | `race_id`, `callsign`, `pos`, `go_time_ms`, `status`, `points`, `model`, `stats_json` |
| `cups` | `id`, `room`, `name`, `race_count`, `created_at`, `closed_at` |

`stats_json` holds `items_used`, `hits_taken`, `hits_blocked`, `hits_landed`, `worst_rank`,
`final_rank`, `best_sector_ms`, `jump_start` and `gate`. A cup gets its `cups` row when its first
race finishes and is closed when its last does; starting a new cup in a room also closes that room's
other open cups, so an abandoned one does not sit in the open list forever. `races.id` is a database
id and has nothing to do with the room's in-memory `race_id`. All of it is `CREATE … IF NOT EXISTS`:
re-running the schema on a live database adds what is missing and touches no existing row.

### Compatibility

**An old client on a proto-4 relay keeps working.** It never sends `finish`/`dnf`, so its race
never ends by itself and is never scored — the host's `back_to_lobby` still returns everyone to the
lobby, and nothing is written. It ignores `results`, `results_progress` and the `cup` field.
Mixed rooms work the same way: a proto-4 racer finishing while an old client is still racing waits
out `RESULTS_TIMEOUT_S`, after which the old client is a DNF.

**A proto-4 client on an old relay keeps working.** `Lobby.proto` stays below 4, no `finish`, `dnf`,
`cup` or `rematch` frame is ever sent (an old relay would answer each with an `error`), and the
client shows a local-only results card built from the standings it has, with no points.

### Room state added

`name`, `race` (the `RaceRecord` of the race in flight, or of the one whose results are up),
`last_results` (the `results` frame, replayed to a joiner), `cup` (`{id, name, race_count, race_no,
points}` or `None`; `id` stays `None` until the cup's first race is written) and `persist_lock`.
All in-memory. A restart or an empty room drops a race in flight and a cup in progress — the
races already written survive, because those are SQLite.
