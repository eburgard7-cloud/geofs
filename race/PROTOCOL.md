# Relay protocol

This documents `WS /ws/race/{room}` in `race/server/app.py` exactly as implemented today.
It is derived by reading `app.py`, not from race.js's client-side expectations or memory —
if this ever disagrees with `app.py`, `app.py` is right and this file is stale.

The relay carries two things: the **powerups** layer (proto 1, below) and the **lobby**
(proto 2, at the end of this file). They share one socket and one `Room`; a proto 1 client
never sends a lobby frame and ignores the ones it receives.

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
{ "type": "pos", "lat": -90..90, "lon": -180..180, "gate": 0..201, "elapsed_ms": 0..21600000 }
```
- Requires a prior successful `join` (otherwise `"join first"`, see above).
- Updates the player's `gate`, `elapsed_ms`, `lat`, `lon` in place. This is the **only** source
  of truth the relay uses for ranking — the server never trusts anything else for a player's
  own progress.
- After updating, the server checks whether this position crosses a live dropped banana
  (`_check_banana`) and then broadcasts fresh standings to the whole room (`_broadcast_standings`,
  one `standings` frame per connected player, each addressed to that player's own socket).

### `box`
```json
{ "type": "box" }
```
- Requires a prior `join`.
- The server computes the sender's current rank via `Room.ranking()`, calls
  `roll_item(rank, n_players)` (position-weighted table, see `weights_for_rank()`/`ITEMS` in
  `app.py`), stores the rolled item on `player.carrying`, sends
  `{"type":"grant","item":"<item>"}` to the sender only, and broadcasts
  `{"type":"boxed","callsign":"<sender>","item":"<item>"}` to every *other* player in the room
  (`_broadcast_boxed`). `item` is always one of `ITEMS = ["nothing","banana","goop","boost",
  "missile"]`; `"nothing"` is a real, weighted outcome, not an absence of a message.
- There is no cooldown or "already carrying" check server-side — a second `box` while already
  carrying something simply overwrites `carrying` with the new roll. (The client enforces
  "once per run" itself; the relay does not.)

### `fire`
```json
{ "type": "fire", "item": "banana" | "goop" | "missile" }
```
- Requires a prior `join`. `item` is restricted by the Pydantic model to exactly those three
  literals — `"boost"` and `"nothing"` are structurally impossible in a `fire` frame.
- **Grant-before-fire rule:** rejected unless `item` equals exactly what the server currently
  has recorded as `player.carrying`. On mismatch (including nothing carried, i.e.
  `carrying is None`), the server replies `{"type":"error","detail":"item not carried"}` and
  performs no targeting. This is enforced with `if player.carrying != msg.item`, a plain
  equality check — the string must match exactly.
- On success, `player.carrying` is cleared to `None` first, then `_resolve_fire` runs:
  - **`banana`:** if the shooter has a known `lat`/`lon`, a banana is dropped at that position
    (`room.banana = {"lat", "lon", "from": shooter.callsign}`), overwriting any banana already
    live in the room (only one banana per room at a time). If the shooter's position is
    unknown, the banana is silently lost — not an error.
  - **`goop` / `missile`:** targets the nearest player *ahead* by rank (`Room.ranking()`,
    the entry immediately before the shooter). If the shooter is already first, there is no
    target and nothing happens. Otherwise the target receives
    `{"type":"hit","item":"<item>","from":"<shooter callsign>"}` — sent to that one player only.

## Relay → client frames

### `joined`
```json
{ "type": "joined", "room": "string", "proto": 2, "server_ms": 1234567890123 }
```
Sent once, immediately after a successful `join`. `proto` and `server_ms` are new in proto 2 —
see "Proto 2: lobby" below for what a client does with them.

### `grant`
```json
{ "type": "grant", "item": "nothing" | "banana" | "goop" | "boost" | "missile" }
```
Sent only to the player who crossed the box, in response to their `box` frame.

### `hit`
```json
{ "type": "hit", "item": "banana" | "goop" | "missile", "from": "string (shooter callsign)" }
```
Sent only to the victim. The victim's own client decides whether to honor it (Shield is a
client-side concept — see `app.py`'s relay header comment: the relay deliberately does not
track shield state).

### `boxed`
```json
{ "type": "boxed", "callsign": "string (who boxed)", "item": "nothing" | "banana" | "goop" | "boost" | "missile" }
```
Broadcast to every player in the room *except* the one who boxed, whenever anyone crosses the
box. Drives the client's kill feed.

### `standings`
```json
{ "type": "standings", "order": ["callsign1", "callsign2", ...] }
```
Broadcast to every connected player (including the sender of the triggering `pos`) after every
`pos` update. `order` is leader-first: most gates passed, ties broken by lower `elapsed_ms`
(`Room.ranking()`). Includes every currently-joined player in the room, full list each time —
not a diff.

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
- All room state (`rooms`, `Room.players`, `Room.banana`) lives in a process-local Python dict —
  in-memory only, no SQLite, no disk. It is intentionally lost on container restart or when a
  room empties. Only finished-race results (via `POST /runs`, unrelated to this WebSocket) are
  ever written to SQLite.

## Versioning

- The relay's `joined` frame carries an integer `proto` field: `{"type":"joined","room":"...",
  "proto": 2, "server_ms": ...}`. Absence of `proto` means protocol version `1` (no server this
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
