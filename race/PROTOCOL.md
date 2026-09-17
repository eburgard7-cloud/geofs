# Powerups relay protocol

This documents `WS /ws/race/{room}` in `race/server/app.py` exactly as implemented today.
It is derived by reading `app.py`, not from race.js's client-side expectations or memory —
if this ever disagrees with `app.py`, `app.py` is right and this file is stale.

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
- Must be the first message on the connection (see above).
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
{ "type": "joined", "room": "string" }
```
Sent once, immediately after a successful `join`.

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

The relay does not currently send any version field. This section specifies the scheme that a
future change will implement — **not yet implemented**, and no code in `app.py` or `race.js`
currently sends or reads a `proto` field:

- The relay's `joined` frame will carry an integer `proto` field: `{"type":"joined","room":
  "...", "proto": 2}`. Absence of `proto` (as today) means protocol version `1`.
- Clients gate any new relay-dependent feature on the `proto` value received in `joined`,
  falling back to old behavior (or disabling the feature with a status-line note) when the
  server reports a lower version than the feature needs, or omits `proto` entirely.
- An unknown frame `type` — in either direction — must never close the socket. The relay's
  existing behavior already satisfies this for client→relay frames (`parse_message` raises
  `ValueError` on an unrecognized `type`, which the handler turns into an `error` frame, socket
  left open); this must remain true as new frame types are added, and any new relay→client
  frame types must be additive so an old client can safely ignore a frame type it doesn't
  recognize.
