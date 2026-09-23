# Relay protocol

This documents `WS /ws/race/{room}` in `race/server/app.py` exactly as implemented today.
It is derived by reading `app.py`, not from race.js's client-side expectations or memory —
if this ever disagrees with `app.py`, `app.py` is right and this file is stale.

The relay carries five things: the **powerups** layer (proto 1, below), the **lobby**
(proto 2), the **items** layer (proto 3), **results and cups** (proto 4), the **hub, identity,
chat and vote** layer (proto 5) and **modes** (proto 6), the last five at the end of this file. The first four share one
socket and one `Room`; a proto 1 client never sends a lobby, items or results frame and ignores
the ones it receives.

**Proto 5 is the first version to add a second socket**, `WS /ws/hub`, documented in its own
section at the end. `/ws/race/{room}` is otherwise unchanged by it.

`joined` advertises a single integer, `PROTO` (currently **6**). A client gates each feature on
it: `>= 2` for the lobby, `>= 3` for the items layer, `>= 4` for results and cups, `>= 5` for
free-text chat, spectating and the course vote, `>= 6` for a room's `mode`.
`LOBBY_PROTO`/`ITEMS_PROTO`/`RESULTS_PROTO`/`HUB_PROTO`/`MODES_PROTO` in `app.py` record which version each
arrived in and are not sent anywhere.

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
{ "type": "join", "callsign": "string, 1-32 chars", "room": "string, optional, <=32 chars",
  "pilot_token": "string, optional, <=128 chars", "spectate": false,
  "mode": "string, optional, <=16 chars" }
```
`pilot_token` and `spectate` are proto 5, both optional and additive — see "Proto 5" for what
they do. `mode` is proto 6, optional and additive — see "Proto 6". An old client omits all three
and this frame behaves exactly as it always has.
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
{ "type": "joined", "room": "string", "proto": 6, "server_ms": 1234567890123, "mode": "race" }
```
Sent once, immediately after a successful `join`. `proto` and `server_ms` are new in proto 2 —
see "Proto 2: lobby" below for what a client does with them. `mode` is new in proto 6.

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

Proto 5: `order` excludes **opt-in spectators** (`join.spectate`), who are not racing and have no
rank. They still *receive* this frame — see "Spectating" under "Proto 5". A mid-race joiner, who
proto 2 already made `role: "spectator"` without being asked, is still in `order` exactly as
before.

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
  "name": "Steve Sprint", "start_type": "ground" | "air", "gates": 1..201 }
```
`gates` is proto 5, optional and additive: the course's gate count, used only for the room
registry's "gate N of M" line. A 1.1.0 host omits it and the line reads "gate N".
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
{ "type": "chat", "text": "free text, <=240 chars after sanitizing" }        // proto 5
```
The first shape is a fixed enum, not free text. The second is proto 5 and is documented under
"Proto 5"; **exactly one of `code` or `text` must be present**, or it is a validation error.
The rest of this section describes the enum shape, which proto 5 leaves untouched. Broadcast to the whole room, **including the sender** (so one
client's own feed can just render whatever this socket receives, without special-casing its own
message). Any player may send it. An unrecognized code is a validation error, not silently
dropped.

> **Amended in proto 5.** This section used to say "the relay can never be used to relay
> arbitrary strings between clients". That is no longer true: proto 5 adds `chat{text}`, a second
> shape on this same frame name, which carries free text. The enum path documented here is
> unchanged — see "Proto 5: hub, identity, chat and the vote" for the new one and for what the
> relay does and does not do to the text.

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
{ "type": "start", "race_id": 1, "start_at_server_ms": 1234567890123, "racers": ["Steve", "Maggie"],
  "vote": { "course_id": "gorge-run", "name": "Columbia Gorge Run", "votes": { "Steve": "gorge-run" } } }
```
`vote` is proto 5 and additive: the course vote's winner and the tally that produced it, or `null`
when the host picked the course by hand or nobody voted. See "Proto 5".
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


## Proto 5: hub, identity, chat and the vote

Proto 5 is about everything that happens *before* a race, and it is the first version to add a
**second socket**: `WS /ws/hub`. The race relay documented above is otherwise untouched — a pilot
who never opens the hub types a code and flies exactly as they did in 1.1.0.

It brings five things: **pilot identity** (the one piece of proto 5 that touches SQLite), the
**hub channel** (presence + a public room registry), **ping the ramp**, **free-text lobby chat**
on the race socket, and a server-drawn **course vote**.

New client→relay frames on the race socket: `vote`, plus new optional fields on `join`
(`pilot_token`, `spectate`) and `course` (`gates`), and a second shape for `chat`.
New relay→client frames on the race socket: `vote`, plus an additive `vote` field on `start`.
The hub has its own vocabulary, listed below.

### Pilot identity

A callsign used to be a free-text string anyone could type. It is now a **display name owned by a
`pilot_id`** that the server issues.

- On a first hub connect the server mints `{pilot_id (uuid4), pilot_token (a secret)}` and returns
  both in `welcome`. The client stores both in `localStorage`; later connects send the token and
  the server resolves it back to the `pilot_id`.
- **A missing or unknown token is never an error** — it just means "we have not met you", and a
  new pilot is minted.
- The server stores only `sha256(pilot_token)`, so a copy of `race.db` is not a set of working
  credentials. A lost token cannot be recovered, only replaced.
- Ownership is keyed on a **casefolded** callsign (`callsign_key`), so `Eric` and `eric` are one
  pilot rather than two people fighting over a name. The `callsign` column keeps the display form
  exactly as typed, and **every existing read endpoint still keys on `callsign` and is unchanged**.
- Claiming a callsign another *claimed* pilot holds is **refused, by name**, and nothing changes:
  `{"type":"error","detail":"callsign 'Eric' belongs to another pilot — pick another"}`. The socket
  stays open and the client may `hello` again with a different name.
- Renaming (a known token + a free callsign) releases the old name.
- **Freeing a callsign is a manual admin action** — a documented SQL `UPDATE`, not an endpoint.
  See `server/DEPLOY_CHECKLIST.md`. This server has no auth by design and a new secret would be a
  worse trade than a one-line query.

#### Migration

`migrate(conn)` runs on every container start, right after `SCHEMA`, and is a no-op the second
time. `SCHEMA` is all `CREATE … IF NOT EXISTS`, which cannot add a column to a table that already
exists — hence a separate function.

| Change | Note |
|---|---|
| `pilots` table | `pilot_id`, `callsign`, `callsign_key` (UNIQUE), `token_hash` (UNIQUE, NULL = unclaimed), `created_at`, `last_seen`, `ramp_day`, `ramp_count`, `last_ramp_ms` |
| `pilot_id TEXT` added to `runs`, `traces`, `race_results` | `ALTER TABLE ADD COLUMN`: nullable, no default, in place, O(1), no row rewritten |
| Backfill | one pilot per distinct casefolded callsign across those three tables, `token_hash` NULL |

A backfilled row is **unclaimed**: the first pilot to prove that callsign **adopts** it and
inherits its history, and it is locked from then on. A pilot who already has an identity and then
claims an unclaimed name has their old row **merged** into it, so their rows come with them.

This is the first schema change in this project that is not a pure `CREATE … IF NOT EXISTS`, so
**back up `race.db` before deploying it** (DEPLOY_CHECKLIST §7 step 1).

### Route

```
WS /ws/hub
```

No path parameters and no room. Same framing, same 2 KB `MAX_WS_MSG_BYTES` (close `1009`), same
`WS_RATE_LIMIT_PER_S` / `WS_MAX_VIOLATIONS` (close `1008`) as `/ws/race/{room}` — both sockets now
share one `RateGate`. The **first** application message must be `hello`; anything else gets
`{"type":"error","detail":"hello first"}` and changes nothing.

One connection per pilot: a second `hello` resolving to the same `pilot_id` from another socket
**replaces** the first (old socket closed `1001`), so one person is never on the ramp twice. A
second `hello` on the *same* socket is a rename.

### Client → hub frames

| Frame | Shape |
|---|---|
| `hello` | `{ "type":"hello", "pilot_token": "…optional", "callsign": "1–32 chars", "model": "≤32 chars" }` |
| `heartbeat` | `{ "type":"heartbeat" }` — ~0.2 Hz (every ~5 s) |
| `where` | `{ "type":"where", "room": "code or null", "activity": "idle"\|"gate"\|"racing"\|"solo" }` |
| `ping_ramp` | `{ "type":"ping_ramp" }` |
| `list` | `{ "type":"list" }` |

`where.room` must match `ROOM_PATTERN` (`^[a-z0-9-]{1,32}$`) or be `null`. A code that does not
match is **refused with the reason** (`{"type":"error","detail":"not a room code: 'Friday Night!'"}`)
and never silently rewritten into something the pilot did not type.

### Hub → client frames

| Frame | Shape |
|---|---|
| `welcome` | `{ "type":"welcome", "pilot_id": "…", "pilot_token": "…", "proto": 5 }` |
| `presence` | `{ "type":"presence", "pilots": [ { "callsign", "model", "activity", "room", "idle_seconds" } ] }` |
| `rooms` | `{ "type":"rooms", "rooms": [ …registry rows… ] }` |
| `ramp_ping` | `{ "type":"ramp_ping", "from": "callsign" }` |
| `error` | `{ "type":"error", "detail": "≤200 chars" }` |

`welcome.pilot_token` is **echoed** when the server did not mint a new one, so the frame has one
shape and a client can always store what it is handed.

`presence` is sorted busy-first, then by `idle_seconds`, then callsign, so the list does not
reshuffle under the reader every second. `idle_seconds` is how long since that pilot last reported
*doing* something and is `0` while they are doing it — not seconds since their last heartbeat,
which would be a constant 0–5 for everyone and say nothing.

A successful `hello` sends exactly three frames: `welcome`, then `presence`, then `rooms`.

#### Presence, heartbeats and coalescing

- Presence is **in-memory only, never SQLite**. A restart empties it, which is correct: presence
  that outlives the process is a lie about who is online.
- A pilot drops off the list after **2 missed heartbeats** (`HUB_DROP_S` = 15 s: two beats plus a
  grace beat), and that socket is closed `1001`. A half-open TCP connection never raises, so the
  heartbeat is the only thing that can tell the server a pilot is gone.
- `presence` and `rooms` are pushed **on change, coalesced to at most 1 Hz per client**, so a busy
  ramp cannot flood anyone. A quiet ramp still gets its update immediately. One background task at
  1 Hz flushes whatever was held back and reaps stale clients; it starts when the first client
  connects and is cancelled when the last leaves, so an idle server runs no timers.
- `list` is answered immediately rather than on the next tick — it costs one push and it is what a
  panel does when it opens.

### Room registry

A room **self-registers on the first `join` of `/ws/race/{room}`** and is listed publicly to
everyone on the hub. Each row:

```json
{ "code": "friday-night", "host": "Steve", "course": { … } | null,
  "cup": { "name", "race_no", "race_count" } | null, "format": "race" | "cup",
  "status": "boarding" | "launching" | "racing" | "results" | "empty",
  "line": "starts in 4s", "pilots": 3, "callsigns": ["Steve", "Maggie", "Eric"] }
```

- `status` maps from the room's `phase`: `lobby→boarding`, `countdown→launching`, `racing→racing`,
  `results→results`. `empty` is the extra one: a room inside its reopen window has no live phase.
- `line` is the status-specific line: `"starts in Ns"` during `launching`, and
  `"gate N of M — X leads"` during `racing`. `M` comes from the new optional `course.gates`; a
  1.1.0 host omits it and the line reads `"gate N — X leads"`.
- While a room is **live**, every field is projected fresh from the live `Room` on each read —
  nothing is cached or duplicated, so nothing can drift. The registry stores only what a live
  `Room` cannot: the code, the last-known snapshot, and who was host.
- **Expiry:** an entry is dropped `REGISTRY_TTL_S` (10 minutes) after the room's last pilot
  leaves. Pruning is lazy (checked on every read), like `_prune_bananas`. A room that is in fact
  occupied is **never** pruned regardless of its empty marker — occupancy is ground truth.
- **A reopen inside that window keeps the code and the host.** The `Room` object itself is still
  dropped the instant the room empties (unchanged 1.1.0 behavior), and the registry entry outlives
  it; the pilot who reopens the code becomes host by the ordinary first-joiner rule, which is the
  original host whenever they are the one who comes back.
- **No private rooms in this version.** Every registered room is visible to every hub client.
  *Future work:* a `private` flag on the registry entry, set by the host, that withholds the row
  from `rooms` while leaving the code joinable.

### Ping the ramp

`ping_ramp` broadcasts `{"type":"ramp_ping","from":"<callsign>"}` to **every hub client except the
sender**. A successful ping sends nothing back to the sender.

Deliberately scarce, and **not configurable per room** — one server-wide setting:

1. A **60 s cooldown** (`RAMP_COOLDOWN_S`): `{"type":"error","detail":"you can ping again in 43s"}`.
2. A daily cap, `RAMP_PING_PER_DAY` (env `RACE_RAMP_PING_PER_DAY`, default **3**), resetting at
   **local midnight UTC-7** — not UTC, because the point is three pings per *evening* and a UTC
   reset would land mid-session on the west coast. A fixed offset on purpose: no tz database, and
   no DST seam to argue with twice a year.
3. Over the cap names when it comes back:
   `{"type":"error","detail":"you're out of ramp pings for today — 3 more in 4h 12m"}`.

Both counters live **on the `pilots` row**, not in memory, so a redeploy cannot hand everyone
their allowance back. This is the one exception to "proto 5 adds nothing to SQLite but identity",
and it is there because a scarce thing that a container restart refills is not scarce.

### Free-text lobby chat (race socket, not the hub)

```json
{ "type": "chat", "text": "on the runway, 2 min" }     →  { "type": "chat", "from": "Steve", "text": "on the runway, 2 min" }
```

Carried on the **race room socket**, not the hub — it is lobby chat for the room you are in.
Proto 2's `chat{code}` enum is a second, completely unchanged shape on the same frame name;
**exactly one of `code` or `text` must be present** or it is a validation error.

- `CHAT_MAX_CHARS` = **240**. Over-length is **truncated**, not refused.
- Control characters are stripped: whitespace ones (newline, tab, CR) become separators, so
  `"two\nlines"` is two words; everything else unprintable is dropped, so an escape sequence loses
  its `ESC` and lands as inert text. Whitespace runs are collapsed.
- The relay does **not** escape HTML. It carries text; escaping belongs to whatever renders it
  (race.js escapes on render), and escaping here would double-escape there.
- A line with nothing left after cleaning is refused: `{"type":"error","detail":"empty chat line"}`.
- **Its own rate limit**, separate from the socket's 20 msg/s: `CHAT_RATE_PER_S` (env
  `RACE_CHAT_RATE_PER_S`, default 2) with a burst of `CHAT_BURST` = 4. Over budget is
  `{"type":"error","detail":"chat rate limited"}` — an error, never a close, and it does not count
  toward `WS_MAX_VIOLATIONS`.
- **Never persisted.** Not SQLite, not disk, not a log line. This is the only place in the relay
  that carries a string one pilot typed to another, and a chat log is a liability nobody asked for.
  There is a comment at the handler saying so, and a test that scans every table for a sent line.
- **Delivered only to connections that proved proto 5.** An old client has a *working* `chat`
  handler that reads `callsign`/`code`, so this shape would render as a blank `"?: "` line in its
  feed — worse than not receiving it at all. A connection proves proto 5 by sending a
  `pilot_token` or `spectate` on its `join`, or by sending a `chat{text}` of its own. This is
  deliberately conservative: it can under-detect a real proto-5 client that has never visited the
  hub, and never over-detects an old one.

### Spectating

`join` may carry `spectate: true`.

An **opt-in** spectator is excluded from `Room.ranking()`, and therefore from `standings.order`,
from the item-box position weighting, from `start.racers`, from the `RaceRecord` (so they can
never hold a race open or produce a results row), and from the room's **pilot cap**. Their `ready`
flag is ignored by the "not everyone is ready" check. They are refused `pos`, `box`, `fire`,
`finish` and `dnf` — **by name**, e.g. `{"type":"error","detail":"spectators cannot send pos"}` —
and the refusal never closes the socket. `back_to_lobby`, `abort` and `rematch` leave them
spectating rather than putting them back on the grid.

They **do still receive** `standings`, `world`, `lobby`, `start`, `vote` and `results`: they
joined to watch. `_broadcast_standings` now sends to every connection in the room rather than
iterating `ranking()` — those used to be the same set, and a spectator would otherwise be the one
pilot who never gets the standings they came for.

**This is not the same as `role == "spectator"`.** Proto 2 already makes a mid-race joiner a
spectator without being asked; that pilot is **still ranked** and still sends `pos` exactly as in
1.1.0. Only the opt-in flag changes behavior, because only the opt-in flag means the client asked
for it and expects it.

The **pilot cap** is new: `ROOM_MAX_PILOTS` (env `RACE_ROOM_MAX_PILOTS`, default **12**). A
non-spectator joining a full room is refused
`{"type":"error","detail":"room is full (12 pilots)"}`. Spectators walk past it — a full grid with
a crowd watching is the point.

### Course vote

Server-authoritative: the relay draws the candidates and counts the votes, so a client can neither
nominate a course nor decide the winner.

- **Candidates** are drawn once, on the room's first join: `VOTE_CANDIDATES` (3) weighted draws
  plus a fixed `"surprise-me"` wildcard, always last. Weight is `1/(1+n)` where `n` is how many
  runs the pilots *present* have on that course — so a course nobody present has flown is 1.0 and
  one they have ground out twenty times is 0.05. Still possible, just not what comes up on a
  Friday night.
- **The pool comes from `runs`.** The course JSON lives in the repo and is fetched by the *client*
  from `COURSE_BASE`; the container ships `app.py` alone. So a course nobody has posted a time on
  cannot be a candidate — a real limitation, stated here rather than papered over. A server with
  no runs at all offers only the wildcard.
- `{"type":"vote","course_id":"gorge-run"}` — any player may vote, **one active vote each**,
  changeable right up to the launch. A `course_id` that was not drawn is refused by name
  (`{"type":"error","detail":"not a candidate: …"}`); voting after the room leaves `lobby` is
  refused with `"voting is closed once the room launches"`.
- The relay broadcasts `{"type":"vote","candidates":[{course_id,name}],"votes":{callsign:course_id}}`
  on every change, and to a joiner so they can vote without waiting for someone else to move
  first. Additive: an old client has no handler for the type and ignores it.
- **The winner** is most votes; a tie goes to whichever tied candidate the present pilots have
  raced least (the same bias as the draw), and a tie on *that* is broken by the rng — never by
  dict or draw order, which would quietly favour whatever the draw listed first. The wildcard
  resolves to a uniform draw over the whole catalog at launch.
- **Binding only when the host set no course.** A host `course` frame always wins. When the host
  never sent one, the winner becomes `room.course`, which is also what lifts the existing
  `"no course set"` refusal for a voting room. A winner this server cannot resolve to a
  `course_hash` falls through to that refusal unchanged.
- The winner is announced on the `start` frame as an additive field:
  `"vote": {"course_id", "name", "votes": {…}}`, or `null` when the host picked the course or
  nobody voted. The tally is cleared once spent, so the next race in the room votes afresh.

### Trust model additions (proto 5)

- The relay is authoritative for: **which `pilot_id` a token resolves to**, **who owns a
  callsign**, **what a room's registry row says**, **whether a ramp ping is within budget**, **what
  the vote candidates are** and **who won the vote**. A client cannot mint its own `pilot_id`,
  claim a name someone else holds, nominate a course, or decide a vote.
- **`where.room` and `where.activity` are self-reported and cosmetic**, exactly like `pos`. A hub
  client can claim to be anywhere. The authoritative answer to "who is actually in that room" is
  the **registry's**, which is built from live race sockets and never from anything a hub client
  says. Nothing is gated on a `where` claim — it drives a display, and that is all.
- The relay now **does** carry arbitrary strings between clients (`chat{text}`), which the proto-2
  section explicitly promised it never would. That promise is amended there. What the relay
  guarantees instead: the string is stripped of control characters, capped at 240, attributed to
  the connection that sent it (a client cannot put words in another pilot's mouth), rate-limited
  per player, and **never written anywhere**.
- SQLite gains **identity and nothing else**: the `pilots` table (including the two ramp counters)
  and a nullable `pilot_id` column on three existing tables. Presence, the registry, the vote, the
  spectator flags and every chat line are in-memory, and a restart drops all of them.

### Compatibility

**An old client on a proto-5 relay keeps working.** It never opens `/ws/hub`, so it has no
identity and does not need one. Its `join` carries no `pilot_token` and no `spectate`, so it races
as it always has and is never refused for a callsign someone else owns — race-room identity is
**soft**, by design. It never sends `chat{text}` or `vote`, and it is never *sent* a `chat{text}`
(that is the whole reason delivery is gated). It receives the additive `vote` frame and the new
`vote` field on `start` and ignores both, exactly as this file's "Versioning" rule requires. The
one thing it will notice: `joined.proto` is now `5`.

**A proto-5 client on an old relay keeps working.** `/ws/hub` does not exist there, so the panel
reports no hub and the pilot types a code as before. `Relay.proto` stays below 5, so no `vote` is
sent and no `chat{text}` is sent (an old relay would answer each with an `error`), `spectate` and
`pilot_token` on a `join` are ignored as unknown fields, and identity is simply unavailable —
which is not an error state, just a relay that predates it.

### Room state added

Per room: `countdown_start_at_ms` (the registry's "starts in Ns" needs the countdown's absolute
end, which nothing before this kept), `vote_candidates`, `votes`, `vote_seen` and
`host_set_course`. Per player: `proto5`, `spectate` and `chat_gate`.

Module-level and in-memory: `hub` (`pilot_id` → `HubClient`), `_hub_task` (the 1 Hz loop) and
`registry` (room code → `RegistryEntry`). All of it is dropped on restart.

## Proto 6: modes

A **mode** is anything with one number to rank on. The server keeps a registry (`MODES` in
`app.py`); each entry declares an `id`, a `metric_name`, a `direction` (`asc` = lower is better,
`desc` = higher is better) and a payload schema. Exactly two are registered:

| `id` | `metric_name` | `direction` | payload |
|---|---|---|---|
| `race` | `elapsed_ms` | `asc` | `{splits, gates, length_m, model, aircraft_id}` — what a `runs` row holds beyond its time |
| `landing` | `score` (0–1000) | `desc` | `{runway_id, runway_version, touchdown, bounce_count, total_rollout_m, breakdown, model, aircraft_id}`, written by the server only |

The landing score is computed by the server, never the client. A landing arrives on
`POST /landings` as `race/touchdown.js`'s raw `touchdown` event plus its bounce count and settled
rollout; the server scores it against its own runway def (`score_touchdown()`) and stores the
result as a `landing` row with `course_id` = runway id and `course_hash` = `runway_hash()`. Any
`score` a client sends is ignored. See race/README.md "Landing mode scoring".

### Relay

- `join.mode` (optional, a registered `id`) picks the room's mode. **Omitted means `race`.**
- A room's mode is fixed by its first successful join and lasts until the room empties (and is
  deleted). A later `join` for a different mode is refused with
  `{"type":"error","detail":"mode mismatch: this room is playing 'landing'"}`, and one naming an
  unregistered mode with `unknown mode '…'`. Both leave the socket open and the room unclaimed by
  that joiner, like every other refused `join`.
- `joined` carries `proto: 6` and `mode` (the room's mode).
- A lobby race in a room whose mode is not `race` still runs and still sends `results`, but is
  **not** written to `races`/`race_results`: those are time-trial history. Its results stay in
  memory until the mode defines what a lobby result means.

### REST

Unchanged: `POST /runs` and `GET /leaderboard` keep their request, response and table (`runs`).
`POST /runs` now also writes the run into `mode_runs` as `mode_id='race'` in the same transaction.

New:

- `GET /modes` — the registry: `[{id, metric_name, direction, metric_min, metric_max,
  payload_schema}]`, with `payload_schema` as JSON Schema.
- `POST /modes/{mode}/runs` — `{course_id, course_hash, callsign, metric_value, payload,
  client_version?}`. The payload is validated against that mode's schema and `metric_value`
  against its range (`422` otherwise). Same per-IP rate limit as `POST /runs`, shared with it.
  `race` and `landing` answer `400`: race runs have one write path, `POST /runs`, and landings
  have theirs, `POST /landings`, because their score is server-computed. Returns
  `{id, mode, metric_name, rank, personal_best, improved}`, all by the mode's direction.
- `GET /modes/{mode}/leaderboard?course_hash=&limit=` — `{mode, metric_name, direction,
  course_hash, rows: [{rank, callsign, metric_value, created_at, attempts}]}`: each
  pilot's best on that course in that mode, best first by the mode's direction, ties to whoever
  set it first. Always filtered on `mode_id`, so no mode's run can reach another mode's board.
- `POST /landings` — `{runway_id, callsign, touchdown, bounce_count, total_rollout_m,
  aircraft_id?, model?, client_version?}`, `touchdown` being race/touchdown.js's `touchdown` event
  verbatim. Scored server-side and written as a `landing` row; returns `{id, mode, course_hash,
  rank, personal_best, improved, score, breakdown}`. Same shared rate limit.
- `GET /landing-leaderboard?runway_id=&limit=` — a runway's `landing` board looked up by id:
  `{mode, runway_id, course_hash, rows}`, rows as above.

Every ranking query over `mode_runs` gets its aggregate (`MIN`/`MAX`), its `ORDER BY` keyword
and its "strictly better" operator from `direction_sql()`, which maps the two legal directions
onto fixed SQL keywords. Nothing assumes ascending, and nothing a client sends is interpolated
into SQL.

### Persistence

One new table, `mode_runs(pilot_id, callsign, course_id, course_hash, mode_id, metric_value,
direction, payload_json, created_at, legacy_run_id)`. `legacy_run_id` is the `runs.id` a race row
mirrors (UNIQUE). `race/server/migrate_modes.py` creates it and backfills every `runs` row as
`mode_id='race'`; it is additive only (no DROP, ALTER or UPDATE), idempotent through
`legacy_run_id`, and also run by `app.py` on every start. See DEPLOY_CHECKLIST.md §7.

### Compatibility

**An old client on a proto-6 relay keeps working.** Its `join` has no `mode`, so it is a race join
into a race room, exactly as before. `joined` gains a `mode` field it ignores, and `proto` reads
`6`, which passes every `>= N` gate it already has. The one new way it can be refused is joining
a room a proto-6 client opened in another mode, which no pre-6 client can create.

**A proto-6 client on an old relay** sees `proto < 6` and must treat modes as unavailable: an old
relay ignores `join.mode` as an unknown field, so every room there is a race room.
`/modes` answers `404` there, and so does `/modes/{mode}/…`.

### Room state added

Per room: `mode` (`None` until the first successful join).
