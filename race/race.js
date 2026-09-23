/*
 * FINSONLY Racing — checkpoint racing layer for GeoFS
 * Single file, no dependencies. Load with the bookmarklet in README.md.
 * Safe to load twice: the same version re-shows the panel, a different version replaces the
 * first (see the instance guard below CONFIG).
 */
(() => {
  'use strict';

  // ---------------------------------------------------------------- config
  const CONFIG = {
    VERSION: '1.4.0',
    COURSE_BASE: 'https://raw.githubusercontent.com/eburgard7-cloud/geofs/main/race/courses/',
    MODEL_BASE: 'https://raw.githubusercontent.com/eburgard7-cloud/geofs/main/race/models/',
    // The deployed relay/leaderboard (README "Deploy" step 6). This was left empty through
    // 1.3.0, which silently disabled the entire hub/room layer in every shipped client: every
    // relay entry point fails closed, and before 1.3.1 it did so without a word — "+ New room"
    // produced no socket, no console line and no message. Empty is still supported (it means
    // leaderboard/relay off, Solo only), but it now says so out loud wherever it bites.
    API_BASE: 'https://race.finsonly.net',
    DEFAULT_RADIUS_M: 150,
    MAX_SPEED_MS: 700,         // ~1360 kt. Faster than this between samples = teleport/slew → DQ
    PAUSE_MOVE_TOLERANCE_M: 50,
    ALT_OFFSET_M: 0,           // visual-only nudge if gates render above/below where they trigger
    COURSE_MAP: true,          // draw gates+route on GeoFS's Leaflet nav map; see README
    COUNTDOWN_LEAD_S: 10,      // default lead time for a host-armed countdown
    TEST_SPACING_M: 2000,
    TEST_COUNT: 6,
    HUD_HZ: 10,
    READY_TIMEOUT_MS: 180000,
    HUD: true,                 // full-viewport race HUD (#fr-hud), separate from the #fr-root settings panel
    SFX_VOLUME: 0.5,           // WebAudio master gain, 0-1; see Sfx module
    // ---- ghost racing (0.9.0). A run is recorded as a trace — a low-rate sample of where you
    // were and how you were pointed, timed from your own gate-1 crossing — and a saved trace is
    // replayed as a ghost you race against, plus the racing line it flew. Everything here is
    // additive and fails closed: no trace, no ghost, no line, and the race itself is untouched.
    TRACE: true,               // record a trace while running; off = nothing is sampled or saved
    TRACE_HZ: 4,               // trace sample rate while Race.state === 'running'
    TRACE_MAX_SAMPLES: 6000,   // hard cap (25 min at 4 Hz); past it recording stops and the trace
                               // is marked truncated, and a truncated trace is never saved
    TRACE_MAX_COURSES: 20,     // LRU cap on locally-stored traces, keyed by course hash
    TRACE_SEARCH_N: 64,        // forward-only search window (samples) for traceNearest()
    GHOST: true,               // replay a saved/remote trace as a translucent ghost aircraft
    GHOST_ALPHA: 0.45,         // ghost translucency — solid enough to chase, clearly not a real pilot
    RACING_LINE: true,         // draw the selected ghost's path ahead of me (Alt+L toggles live)
    LINE_AHEAD_M: 4000,        // how far along the path to draw, in metres of path length
    LINE_REBUILD_HZ: 2,        // how often the drawn window is recomputed — never per frame
    LINE_DELTA_BAND_MS: 300,   // |vs-ghost| inside this reads amber; outside it, green/red
    LINE_SPLINE_STEPS: 12,     // samples per gate-to-gate segment for the no-trace spline
    // "Race a friend's ghost" (0.12.0): up to RIVAL_GHOSTS_MAX ghosts flying at once instead of
    // just the one "Race against" picks. The first ghost picked (the existing "Race against"
    // select above) stays the ONE primary ghost — the racing line and #fr-hud-ghost still color
    // against it alone; everything else is an additive rival with its own model/tag/HUD delta.
    // Reuses the existing /ghost trace fetch and the traces table; adds GET /ghosts (the picker's
    // list) and GET /news (an in-game "someone beat your time" check, no relay, no Teams webhook).
    RIVAL_GHOSTS: true,
    RIVAL_GHOSTS_MAX: 3,       // total ghosts including the primary
    WAYPOINT_BRACKET: true,    // screen-space bracket/edge chevron over the next gate
    HUD_EDGE_INSET_PX: 60,     // a gate closer than this to a viewport edge gets a chevron instead
    MINIMAP: true,             // north-up SVG course map in the HUD's bottom-right corner
    MINIMAP_HZ: 4,             // how often the minimap's moving markers are updated

    POWERUPS: true,            // Powerups module (loadout + relay box/offensive items); see README "Powerups"
    POWERUP_BOOST_MS: 4000,    // Boost effect duration
    POWERUP_BOOST_ADD_MS: 35,  // extra ground speed while boosted, in m/s — kept well under MAX_SPEED_MS
    POWERUP_SHIELD_MS: 6000,   // Shield effect duration
    POWERUP_BANANA_MS: 2500,   // incoming banana: brief wobble + tint
    POWERUP_MISSILE_MS: 3000,  // incoming missile (mustard): short control loss + screen tint
    POWERUP_GOOP_MS: 4000,     // incoming goop: view-obscuring overlay
    POWERUP_POS_HZ: 2,         // how often to ping the relay with position/progress while racing
    POWERUP_RECONNECT_MS: 2000,      // relay reconnect backoff base (doubles per attempt)
    POWERUP_RECONNECT_MAX_MS: 30000, // …capped here
    POWERUP_ROOM: '',          // fixed relay room code; empty = derive one from the course hash
    // ---- items (0.10.0, relay proto 3). Every offensive item is now something you can see
    // coming: a telegraphed projectile you can shield against, a banana that is a real object in
    // the world, boxes that go dark when somebody else takes them. All of it is additive and
    // gated on the relay reporting proto >= 3 — against an older relay the client behaves
    // exactly like 0.9.0, with one note on the status line.
    ITEMS: true,               // the whole 0.10.0 items layer: world entities, projectiles, fx
    ITEM_ENTITY_BUDGET: 40,    // hard cap on live makeItemLayer() entities; oldest evicted first
    ITEM_TTL_MS: 12000,        // client-side TTL on every item entity, even if no clearing frame comes
    BOX_RESPAWN_MS: 6000,      // must match the relay's BOX_RESPAWN_S — a taken box is dark this long
    BOX_ROLL_MS: 1500,         // the item-slot roulette on a grant; the item cannot be fired until it ends
    BANANA_RADIUS_M: 80,       // client-side 3D trip radius; the relay validates within this + 400 m
    BANANA_TTL_MS: 120000,     // matches the relay's BANANA_TTL_S
    PROJECTILE_TRAIL_N: 12,    // trail points kept behind a missile/goop projectile
    BOOST_TRAIL_MS: 1500,      // how much of the boosting aircraft's recent path glows orange
    HIT_SHAKE: true,           // CSS transform jitter on the render canvas when something lands
    // A REAL speed cost for a missile hit, as opposed to a screen effect. Off by default and
    // staying that way until somebody has flown a few races with it on: the shipped hits are
    // cosmetic, and anything that writes to the aircraft is a bigger promise than that. This is
    // a speed write, not a control write — CONFIG.POWERUP_CONTROL_EFFECTS stays false and is
    // untouched by it. See README "Powerups" and "Writing to the aircraft".
    POWERUP_SPEED_PENALTY: false,
    PENALTY_FLOOR_MS: 110,     // the penalty never takes you below this, whatever you were doing
    PENALTY_MS: 1500,          // …and never holds for longer than this
    PENALTY_MIN_AGL_M: 150,    // …and never applies at all below this, when AGL is readable
    // Relay lobby (proto 2, see race/PROTOCOL.md "Proto 2: lobby"). A room agrees ready/course/
    // start instead of everyone typing the same HH:MM:SS into a local-clock countdown. Gated on
    // the server actually reporting proto >= 2 in `joined` — an old server (or no relay at all)
    // means this whole module stays invisible and the manual countdown keeps working exactly as
    // it does today, moved under a "Manual sync (no relay)" details element. Shares the powerups
    // relay socket (CONFIG.POWERUPS/CONFIG.API_BASE) rather than opening a second connection —
    // with POWERUPS off there is no socket at all, so LOBBY has nothing to ride on either.
    LOBBY: true,
    // Shared results (0.11.0, relay proto 4; race/PROTOCOL.md "Proto 4: results and cups"). A lobby
    // race ends on one results screen for the whole room — finish order, points, awards, and a cup's
    // running standings — instead of each pilot's own banner. Rides the lobby, so it also needs
    // CONFIG.LOBBY. Gated on the relay reporting proto >= 4: against an older relay nothing new is
    // sent (no finish/dnf/cup/rematch frame) and a lobby race ends on a local-only card built from
    // the standings this client already has, with no points and one status-line note.
    RESULTS: true,
    JUMP_START_PENALTY_MS: 5000,  // added to Race.goElapsed for crossing gate 1 before GO — no DQ
    // The lobby-first panel (1.3.0, relay proto 5; race/PROTOCOL.md "Proto 5"). The panel opens on
    // a room browser (The Ramp) instead of straight into the classic settings sheet, with a room
    // lobby (The Gate: course vote, pilot grid, chat) and a countdown/grid screen (Launch) as
    // separate screens reached by joining a room. The classic panel is untouched — it's the new
    // shell's "Solo" tab, byte-for-byte the same course/editor/HUD/powerups UI as before.
    // false restores 1.2.0's boot path exactly: classic panel straight onto <body>, the old
    // floating lobby card, and the Hub module (below) is never even constructed — this is the
    // rollback switch if the new shell misbehaves.
    LOBBY_V2: true,
    // Auto-collapse the shell the moment a run actually starts (the lobby countdown hitting GO, or
    // a solo run crossing gate 1), so the race HUD has the screen. The manual collapse control in
    // the top bar is always there regardless of this flag; this only governs the automatic one.
    // Reopening by hand mid-race is honored for the rest of that run.
    SHELL_AUTO_COLLAPSE: true,
    // Free-text lobby chat (race/PROTOCOL.md "Free-text lobby chat"). Gates only the new compose
    // box and outgoing chat{text}; the existing fixed quick-chat buttons (CHAT_CODES) are
    // unaffected, so chat can be turned off without a redeploy if it becomes a problem at work.
    CHAT_ENABLED: true,
    // How often the hub socket sends `heartbeat` (Hz) while the panel is open — 0.2 Hz is one
    // every 5 s, matching the server's own suggested cadence (HUB_DROP_S = 15 s = 3 missed beats).
    RAMP_PRESENCE_HZ: 0.2,
    // Client-side mirror of the server's RAMP_PING_PER_DAY default (app.py, "Ping the ramp"),
    // used only to *display* an estimated remaining count on the Ping button. The server is the
    // real authority — a deploy that overrides RACE_RAMP_PING_PER_DAY just makes this estimate
    // wrong until the next `error` frame corrects the picture; it never blocks a ping itself.
    RAMP_PING_DAILY_CAP: 3,
    // Real control disruption on a hit (aileron bias) is OFF until a probe confirms a safe,
    // writable control hook — nothing in race/tools/probe.js has ever captured GeoFS's control
    // inputs. With this false, offensive hits are screen-effect-only: still fun, zero risk of a
    // stall/dive/DQ. See README "Powerups" and the probe's `controls` section.
    POWERUP_CONTROL_EFFECTS: false,

    // ---- aircraft write path (Boost; fly-to-start). See README "Writing to the aircraft".
    // A probe run confirmed three writable fields on geofs.aircraft.instance: trueAirSpeed and
    // groundSpeed (plain numbers) and velocity (a frame VECTOR object, not a scalar). A number
    // can't be malformed; a velocity vector can, and a malformed one stalls the plane. So:
    //   SAFE_WRITES true  (default) — write only the confirmed scalars, and touch the velocity
    //                       vector only once VELOCITY_FRAME below describes a real logged
    //                       sample of it. Nothing invents a direction.
    //   SAFE_WRITES false — also allow deriving a vector write from the live sample with no
    //                       recorded frame (uniform scale, direction exactly as flown). Still
    //                       never a synthesized vector; this is the in-sim escape hatch.
    SAFE_WRITES: true,
    // The axis frame of geofs.aircraft.instance.velocity, written down from a REAL sample —
    // see G.logVelocityFrame(), the "Log velocity frame" button in the Powerups panel, and
    // README "Capturing the velocity frame". null = never captured, so no vector is ever
    // written. Shape:
    //   { kind: 'array'|'object', comps: [0,1,2] | ['x','y','z'],
    //     fwd: <one of comps>|null,  // component carrying forward speed, if the frame is body-fixed
    //     bodyFixed: <boolean>,      // components hold still as heading changes (sample two headings)
    //     ref: [<the three observed numbers>], refSpeedMs: <observed |v|>,
    //     note: 'hdg 090, level, 180 m/s' }
    VELOCITY_FRAME: null,
    SPEED_WRITE_MARGIN_MS: 50,  // every speed write stays this far under MAX_SPEED_MS
    // Opt-in return of the pre-0.6 Boost: move the aircraft by mutating llaLocation. Unconfirmed
    // write path, so it is not the default — turn it on only if the confirmed scalar writes turn
    // out to be readouts GeoFS overwrites (they can succeed as writes and still do nothing).
    BOOST_LLA_FALLBACK: false,
    // fly-to-start (air-start courses): the airspeed you are left at on gate 1, and how far from
    // gate 1 GeoFS's own reset is still allowed to land before we fall back to state writes.
    FLY_TO_START_SPEED_MS: 150,
    FLY_TO_START_TOLERANCE_M: 250,
    // Debug overlay + console log (lobby reliability pass): client version, relay proto, course
    // count, which UI mounted and why, live socket count, lobby phases, every frame type sent and
    // received, clock offset, GO time, grid slot and the teleport result. Off by default; Alt+D
    // toggles it at runtime (and remembers the choice in this browser).
    DEBUG: false,
  };

  // ------------------------------------------------------------ instance guard
  // One client per tab. The bookmarklet can run again (a second click, or the COMBINED loader
  // after the primary), and before this pass a second copy was the kind of thing that could leave
  // two relay sockets in one room. The same version just re-shows the panel; a DIFFERENT version
  // (a newer main, or the pinned fallback after the primary) tears the first one down completely
  // — sockets closed, loop stopped, DOM removed — before booting, so the two never run side by side.
  window.__finsRaceLoads = (window.__finsRaceLoads || 0) + 1;
  if (window.__finsRace) {
    const prev = window.__finsRace;
    if (prev.version === CONFIG.VERSION || typeof prev.teardown !== 'function') {
      if (prev.version !== CONFIG.VERSION) console.warn('[finsRace] v' + prev.version + ' is already running and cannot be replaced in place — reload the page to switch to v' + CONFIG.VERSION);
      try { prev.ui.toggle(true); } catch (_) {}
      return;
    }
    try { prev.teardown('replaced by v' + CONFIG.VERSION); } catch (e) { console.warn('[finsRace] teardown of v' + prev.version + ' failed:', e); }
    try { delete window.__finsRace; } catch (_) { window.__finsRace = undefined; }
  }

  // ----------------------------------------------------------------- clock
  // One clock for every time-boxed powerup effect: the animation loop's own timestamp, set at
  // the top of loop(). Event-driven entry points (keypresses, relay frames, race events) read
  // it through clockNow() instead of performance.now() directly. A browser's rAF timestamp and
  // performance.now() do share a time origin, so mixing them would *usually* work — but only
  // usually, and an effect armed on one basis and expired on the other never recovers. One
  // source removes the hazard (and lets race/test/run.js drive a synthetic frame clock).
  let frameNow = 0;
  function clockNow() { return frameNow || performance.now(); }

  // --------------------------------------------------------------- storage
  const store = {
    get(k, d) { try { const v = localStorage.getItem('finsRace.' + k); return v == null ? d : JSON.parse(v); } catch (_) { return d; } },
    set(k, v) { try { localStorage.setItem('finsRace.' + k, JSON.stringify(v)); } catch (_) {} },
  };

  // ------------------------------------------- Leaflet map resolution (used by G.leafletMap)
  let _leafletMapCache = null;
  function looksLikeLeafletMap(v) {
    return !!v && typeof v === 'object' && typeof v.addLayer === 'function' && typeof v.getCenter === 'function';
  }
  // One level deep only, per Phase 1: geofs.map may be a wrapper around the real L.Map rather
  // than the map itself. matchContainer, if given, requires an exact `_container` reference
  // match — an identity check, not a guess, used when recovering from the DOM (see leafletMap()).
  function scanForLeafletMap(obj, matchContainer) {
    if (!obj || typeof obj !== 'object') return null;
    let keys;
    try { keys = Object.keys(obj); } catch (_) { return null; }
    for (const k of keys) {
      let v; try { v = obj[k]; } catch (_) { continue; }
      if (looksLikeLeafletMap(v) && (!matchContainer || v._container === matchContainer)) return v;
    }
    return null;
  }

  // ------------------------------------------- aircraft velocity vector (pure helpers)
  // GeoFS's velocity is a vector object whose axis frame we don't get to assume: the probe says
  // it exists and is writable, not what its components mean. So these helpers only ever read a
  // shape and derive a new vector from one GeoFS itself produced — nothing invents a direction,
  // because a malformed velocity vector stalls the plane. They take plain objects, so they stay
  // testable with no live sim (see race/test/run.js).
  const VEC_KEYSETS = [['x', 'y', 'z'], ['0', '1', '2']];
  // What kind of 3-component vector is this, if any? Arrays and {x,y,z}-ish objects both turn up
  // in Cesium/GeoFS code, and a longer array (position+velocity packed together) still exposes
  // its first three.
  function velocityShape(v) {
    if (Array.isArray(v)) {
      return v.length >= 3 && v.slice(0, 3).every((n) => Number.isFinite(+n)) ? { kind: 'array', comps: [0, 1, 2] } : null;
    }
    if (!v || typeof v !== 'object') return null;
    for (const keys of VEC_KEYSETS) {
      if (keys.every((k) => Number.isFinite(+v[k]))) return { kind: 'object', comps: keys.slice() };
    }
    return null;
  }
  const vecRead = (v, comps) => comps.map((k) => +v[k]);
  const vecMag = (a) => Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
  // Does a recorded CONFIG.VELOCITY_FRAME still describe the live object? A GeoFS update that
  // reshapes velocity must not get the old frame's meaning applied to its new numbers.
  function velocityFrameMatches(frame, v) {
    const shape = velocityShape(v);
    if (!frame || !shape || frame.kind !== shape.kind) return false;
    const want = (frame.comps || []).map(String), got = shape.comps.map(String);
    if (want.length !== got.length || want.some((k, i) => k !== got[i])) return false;
    if (frame.fwd != null && !got.includes(String(frame.fwd))) return false;
    return true;
  }
  // The only way a live velocity vector is ever changed: take the observed one and either push
  // its forward component (a body-fixed frame, where "forward" is a real axis and its sign can
  // be read off the observation) or scale the whole vector (direction preserved exactly as
  // flown). Returns null — meaning "write nothing" — unless every component comes out finite
  // and the resulting magnitude lands in (0, capMs].
  function velocityBoosted(observed, comps, fwd, targetMs, capMs) {
    if (!Array.isArray(observed) || observed.length < 3) return null;
    const a = observed.slice(0, 3).map(Number);
    if (!a.every(Number.isFinite)) return null;
    if (!Number.isFinite(targetMs) || targetMs <= 0 || !Number.isFinite(capMs) || targetMs > capMs) return null;
    const mag = vecMag(a);
    let out = null;
    const i = fwd == null ? -1 : comps.map(String).indexOf(String(fwd));
    if (i >= 0 && Math.abs(a[i]) >= 1) {
      // Forward along the body axis. The delta is signed by the observed component, so a frame
      // whose forward axis points aft (-Z forward and the like) still speeds up, not down.
      out = a.slice();
      out[i] = a[i] + Math.sign(a[i]) * (targetMs - mag);
    } else if (mag >= 1) {
      out = a.map((n) => n * (targetMs / mag));
    } else {
      return null;   // at rest: no observed direction to push along, so don't invent one
    }
    if (!out.every(Number.isFinite)) return null;
    const outMag = vecMag(out);
    return outMag > 0 && outMag <= capMs ? out : null;
  }
  // fly-to-start needs a vector for an aircraft that may be sitting still, so there is no live
  // direction to scale. The only honest source is the reference sample recorded in
  // CONFIG.VELOCITY_FRAME.ref — a vector GeoFS itself produced in level cruise — rescaled to
  // the target speed. That is only meaningful in a body-fixed frame, where the components don't
  // depend on where the nose points (heading is set separately, through htr[0]); in an
  // earth-fixed frame the same three numbers would mean "fly east" no matter where gate 2 is,
  // so refuse rather than fling the player off the course line.
  function velocityFromReference(frame, targetMs, capMs) {
    if (!frame || !frame.bodyFixed || !Array.isArray(frame.ref) || frame.ref.length < 3) return null;
    const ref = frame.ref.slice(0, 3).map(Number);
    if (!ref.every(Number.isFinite)) return null;
    const mag = vecMag(ref);
    if (!(mag >= 1)) return null;
    if (!Number.isFinite(targetMs) || targetMs <= 0 || !Number.isFinite(capMs) || targetMs > capMs) return null;
    const out = ref.map((n) => n * (targetMs / mag));
    return out.every(Number.isFinite) && vecMag(out) <= capMs ? out : null;
  }

  // ----------------------------------------------------- level-cruise watcher (pure)
  // Whether the last second or so looked like stable level cruise. The velocity-frame capture
  // needs exactly that: a sample taken mid-turn or mid-climb can't tell a body-fixed frame from
  // an earth-fixed one, and that distinction is the whole reason for capturing it. Fed one
  // sample per frame from loop(); holds numbers only, never GeoFS objects.
  const CruiseWatch = {
    hist: [],
    limits: { windowMs: 1500, needMs: 900, staleMs: 500, hdgDeg: 2, pitchDeg: 3, rollDeg: 5, minSpeedMs: 60 },
    sample(now, s) {
      if (!Number.isFinite(now) || !s) return;
      this.hist.push({ t: now, hd: s.heading, pitch: s.pitch, roll: s.roll, speed: s.speed, paused: !!s.paused });
      const cut = now - this.limits.windowMs;
      while (this.hist.length && this.hist[0].t < cut) this.hist.shift();
    },
    stable(now) {
      const L = this.limits, h = this.hist;
      if (h.length < 2) return false;
      const last = h[h.length - 1];
      if (last.t - h[0].t < L.needMs) return false;
      if (Number.isFinite(now) && now - last.t > L.staleMs) return false;
      for (const s of h) {
        if (s.paused) return false;
        if (![s.hd, s.pitch, s.roll, s.speed].every(Number.isFinite)) return false;
        if (s.speed < L.minSpeedMs) return false;
        if (Math.abs(s.pitch) > L.pitchDeg || Math.abs(s.roll) > L.rollDeg) return false;
        // Heading spread against the oldest sample, wrapped, so 359 -> 001 reads as 2 degrees.
        if (Math.abs(((s.hd - h[0].hd + 540) % 360) - 180) > L.hdgDeg) return false;
      }
      return true;
    },
    reset() { this.hist.length = 0; },
  };

  // --------------------------------------------- GeoFS adapter (all internals here)
  const G = {
    ready() {
      try {
        return !!(window.geofs && geofs.aircraft && geofs.aircraft.instance &&
          geofs.aircraft.instance.llaLocation && geofs.api && geofs.api.viewer && window.Cesium);
      } catch (_) { return false; }
    },
    lla() { const l = geofs.aircraft.instance.llaLocation; return { lat: +l[0], lon: +l[1], alt: +l[2] }; },
    heading() {
      const v = (geofs.animation && geofs.animation.values) || {};
      const hd = v.heading360 ?? v.heading;
      return Number.isFinite(hd) ? ((hd % 360) + 360) % 360 : null;
    },
    kias() { const v = geofs.animation && geofs.animation.values; return v && Number.isFinite(v.kias) ? v.kias : null; },
    paused() { try { return typeof geofs.isPaused === 'function' && !!geofs.isPaused(); } catch (_) { return false; } },
    aircraftId() { try { return String(geofs.aircraft.instance.id ?? ''); } catch (_) { return ''; } },
    callsign() { try { return (geofs.userRecord && geofs.userRecord.callsign) || ''; } catch (_) { return ''; } },
    viewer() { return geofs.api.viewer; },
    model() { return typeof window.__finsModel === 'string' ? window.__finsModel.slice(0, 32) : ''; },

    // ---- model-swap additions. These fields are NOT verified against the live site (see
    // README "Model swaps" and race/tools/probe.js); every method below is marked TODO-PROBE
    // and degrades to a harmless default instead of throwing if the guess is wrong.
    pitch() { // confirmed via probe: animation.values.pitch is a number
      const v = geofs.animation && geofs.animation.values;
      return v && Number.isFinite(v.pitch) ? v.pitch : 0;
    },
    roll() { // confirmed via probe: animation.values.roll is a number
      const v = geofs.animation && geofs.animation.values;
      return v && Number.isFinite(v.roll) ? v.roll : 0;
    },
    scene() { try { return geofs.api.viewer.scene; } catch (_) { return null; } },
    isCockpitView() { // confirmed via probe: geofs.camera.currentModeName / currentMode
      try {
        const cam = geofs.camera;
        if (!cam) return false;
        // Probe: definitions = follow(0) cockpit cockpitless chase free fixed Pilot "Pilot back".
        // "cockpit" and "Pilot"/"Pilot back" are inside views where the stock airframe fills the
        // frame. "cockpitless" is an OUTSIDE view (no airframe) despite the prefix — exclude it.
        if (typeof cam.currentModeName === 'string') {
          const m = cam.currentModeName;
          return /^pilot/i.test(m) || (/^cockpit/i.test(m) && !/^cockpitless/i.test(m));
        }
        // Fallback if a future build drops the name but keeps the definition object.
        const def = cam.currentDefinition;
        if (def && typeof def.insideView === 'boolean') return def.insideView;
        return false;
      } catch (_) { return false; }
    },
    // Confirmed via probe: GeoFS's own scene-graph wrapper nodes (e.g. aircraft.instance.object3d)
    // use .visible, not .show. Cesium.Model instances we create ourselves use .show. Recognize
    // and toggle either.
    isShowable(x) { return !!x && typeof x === 'object' && (typeof x.show === 'boolean' || typeof x.visible === 'boolean'); },
    setShow(x, show) {
      if (!x) return;
      if (typeof x.show === 'boolean') x.show = show;
      if (typeof x.visible === 'boolean') x.visible = show;
    },
    // Bounded, cycle-safe scan for anything duck-typed as showable. Used as a fallback in case
    // a future GeoFS update moves the stock aircraft's visual model off the confirmed .object3d.
    findShowables(root, maxDepth) {
      const out = [], seen = new Set();
      const walk = (obj, depth) => {
        if (!obj || typeof obj !== 'object' || depth > maxDepth || seen.has(obj) || out.length >= 6) return;
        seen.add(obj);
        if (G.isShowable(obj)) { out.push(obj); return; }
        let keys; try { keys = Object.keys(obj); } catch (_) { return; }
        for (const k of keys) {
          if (out.length >= 6) return;
          let v; try { v = obj[k]; } catch (_) { continue; }
          if (v && typeof v === 'object') walk(v, depth + 1);
        }
      };
      walk(root, 0);
      return out;
    },
    // Confirmed via probe: a GeoFS scene-graph node's _children array (one entry per aircraft
    // part — body, wings, ...) each carries its OWN independent .visible, not inherited from the
    // root. Used for both the stock aircraft (mine) and other players' aircraft (others) — a
    // fix that only hid the root left parts still rendering in both cases.
    nodesFor(root) {
      if (!G.isShowable(root)) return [];
      const nodes = [root];
      if (Array.isArray(root._children)) {
        for (const c of root._children) if (G.isShowable(c)) nodes.push(c);
      }
      return nodes;
    },
    stockAircraftNodes() { // confirmed via probe: aircraft.instance.object3d (a .visible node)
      try {
        const inst = geofs.aircraft && geofs.aircraft.instance;
        if (!inst) return [];
        const root = [inst.object3d, inst.model, inst._model, inst.primitive].find(G.isShowable);
        if (!root) return G.findShowables(inst, 2); // fallback if a future update moves it
        return G.nodesFor(root);
      } catch (_) { return []; }
    },
    multiplayerUsers() { // confirmed via probe: the global `multiplayer.users` (an object, not array)
      try {
        const mp = geofs.multiplayer || window.multiplayer;
        if (!mp) return [];
        const raw = mp.users || mp.otherPlayers || mp.slots || mp.instances || mp.players || {};
        const list = Array.isArray(raw) ? raw : Object.values(raw || {});
        return list.map(G.normalizeUser).filter(Boolean);
      } catch (_) { return []; }
    },
    // Confirmed via probe: user.callsign, user.id, user.model (a showable node, null until
    // nearby/rendered). Position/orientation come from user.lastUpdate.co =
    // [lat, lon, alt, headingDeg, pitchDeg, rollDeg]. co[4]/co[5] confirmed as pitch/roll:
    // a live maneuvering user probed as co=[45.56,-122.51,1834,122.46,10.69,1.7] (climbing,
    // slight right bank), matching the local aircraft's htr=[heading,pitch,roll] ordering.
    // Older/alternate shapes are kept as a fallback chain in case a future update changes this.
    normalizeUser(u) {
      try {
        if (!u) return null;
        const callsign = u.callsign || (u.userRecord && u.userRecord.callsign) || u.name || '';
        if (!callsign) return null;
        const id = String(u.id ?? u.acid ?? callsign);
        const co = (u.lastUpdate && u.lastUpdate.co) || (u.referencePoint && u.referencePoint.lla) || null;
        let lat, lon, alt, heading, pitch, roll;
        if (Array.isArray(co)) { [lat, lon, alt, heading, pitch, roll] = co; }
        else if (Array.isArray(u.llaLocation)) { [lat, lon, alt] = u.llaLocation; heading = u.heading; pitch = u.pitch; roll = u.roll; }
        else if (u.position) { ({ lat, lon, alt } = u.position); heading = u.heading; pitch = u.pitch; roll = u.roll; }
        else { lat = u.lat; lon = u.lon; alt = u.alt; heading = u.heading; pitch = u.pitch; roll = u.roll; }
        lat = +lat; lon = +lon; alt = +alt;
        if (![lat, lon, alt].every(Number.isFinite)) return null;
        heading = Number.isFinite(+heading) ? +heading : 0;
        pitch = Number.isFinite(+pitch) ? +pitch : 0;
        roll = Number.isFinite(+roll) ? +roll : 0;
        const root = [u.model, u.object3d, u._model, u.primitive].find(G.isShowable) || null;
        // Same fix as stockAircraftNodes(): root + children, all independently .visible.
        const nodes = root ? G.nodesFor(root) : [];
        return { id, callsign, lat, lon, alt, heading, pitch, roll, nodes };
      } catch (_) { return null; }
    },

    // Resolves the live Leaflet map instance GeoFS draws its nav map into (added for CourseMap;
    // README "Course on the map"). The probe found the Leaflet library and the map's DOM
    // container but not a reachable L.Map instance, so this is unverified against the live
    // site — see README. Never throws; null means "map overlay off" and CourseMap no-ops.
    leafletMap() {
      try {
        if (_leafletMapCache) {
          let alive = false;
          try {
            alive = looksLikeLeafletMap(_leafletMapCache) &&
              (!_leafletMapCache._container || document.contains(_leafletMapCache._container));
          } catch (_) { alive = false; }
          if (alive) return _leafletMapCache;
          _leafletMapCache = null;
        }
        // 1. geofs.map, directly or as a one-level wrapper around the real L.Map.
        let gm; try { gm = geofs.map; } catch (_) { gm = undefined; }
        if (looksLikeLeafletMap(gm)) { _leafletMapCache = gm; return gm; }
        const wrapped = scanForLeafletMap(gm, null);
        if (wrapped) { _leafletMapCache = wrapped; return wrapped; }

        // 2. Recover from the DOM container. Leaflet stamps containers it manages with
        // _leaflet_id, which only confirms Leaflet has touched this element, not which map
        // instance owns it — so also require an exact `_container` match on a candidate found
        // on known map-ish globals. If nothing matches, return null rather than guess.
        let container = null;
        try { container = document.querySelector('.geofs-map-viewport') || document.querySelector('.leaflet-container'); } catch (_) {}
        if (container && container._leaflet_id && typeof L !== 'undefined' && typeof L.Map === 'function') {
          let geofsObj, uiObj;
          try { geofsObj = geofs; } catch (_) { geofsObj = undefined; }
          try { uiObj = ui; } catch (_) { uiObj = undefined; }
          for (const src of [geofsObj, uiObj, window]) {
            const found = scanForLeafletMap(src, container);
            if (found) { _leafletMapCache = found; return found; }
          }
        }
        return null;
      } catch (_) { return null; }
    },

    // ---- aircraft speed writes. THE CONFIRMED PATH: a probe run showed
    // geofs.aircraft.instance.trueAirSpeed and .groundSpeed are writable numbers and .velocity
    // is a writable vector object. Scalars are set outright below; the vector only ever gets a
    // value derived from its own live reading (see the velocity helpers above), because a
    // malformed velocity vector stalls the plane. Everything fails closed and returns what it
    // managed to do — a refused write is a Boost that does nothing, never a crash or a DQ.

    // Every speed this file writes stays this far under the DQ threshold, so a boost at the top
    // end can't be mistaken for a teleport by Race.tick's speed sanity check.
    speedCap() { return Math.max(0, CONFIG.MAX_SPEED_MS - (+CONFIG.SPEED_WRITE_MARGIN_MS || 0)); },
    tas() { try { const n = +geofs.aircraft.instance.trueAirSpeed; return Number.isFinite(n) ? n : null; } catch (_) { return null; } },
    groundSpeedMs() { try { const n = +geofs.aircraft.instance.groundSpeed; return Number.isFinite(n) ? n : null; } catch (_) { return null; } },
    velocityObj() { try { return geofs.aircraft.instance.velocity; } catch (_) { return null; } },
    // Best available "how fast am I going right now", in m/s: the confirmed scalars first, then
    // the magnitude of the velocity vector. null when none of them reads as a finite number,
    // which makes every caller here no-op rather than guess a baseline.
    currentSpeedMs() {
      const t = G.tas();
      if (t != null && t >= 0) return t;
      const g = G.groundSpeedMs();
      if (g != null && g >= 0) return g;
      const v = G.velocityObj(), shape = velocityShape(v);
      return shape ? vecMag(vecRead(v, shape.comps)) : null;
    },
    // Confirmed writable numbers, clamped to speedCap(). Writes both so the two readouts stay
    // consistent with each other, and reports whether either field was actually there.
    setSpeedScalars(ms) {
      try {
        if (!G.ready()) return false;
        const v = Math.max(0, Math.min(G.speedCap(), +ms));
        if (!Number.isFinite(v)) return false;
        const inst = geofs.aircraft.instance;
        let wrote = false;
        if (Number.isFinite(+inst.trueAirSpeed)) { inst.trueAirSpeed = v; wrote = true; }
        if (Number.isFinite(+inst.groundSpeed)) { inst.groundSpeed = v; wrote = true; }
        return wrote;
      } catch (_) { return false; }
    },
    // Write a vector into the live velocity object in place — the same treatment llaLocation
    // gets: GeoFS keeps its object, we only change the numbers inside it. Refuses unless
    // CONFIG.VELOCITY_FRAME still matches the live shape and every component validates, so a
    // GeoFS update that reshapes velocity turns this off instead of corrupting it.
    writeVelocity(out) {
      try {
        if (!G.ready()) return false;
        const v = G.velocityObj(), frame = CONFIG.VELOCITY_FRAME;
        const shape = velocityShape(v);
        if (!shape) return false;
        const comps = frame && velocityFrameMatches(frame, v) ? frame.comps : (CONFIG.SAFE_WRITES ? null : shape.comps);
        if (!comps) return false;
        if (!Array.isArray(out) || out.length < 3 || !out.every(Number.isFinite)) return false;
        if (vecMag(out) > G.speedCap()) return false;
        comps.forEach((k, i) => { v[k] = out[i]; });
        return true;
      } catch (_) { return false; }
    },
    // Boost's write, and the one fly-to-start reuses for "already flying". Two stages on
    // purpose:
    //   1. No CONFIG.VELOCITY_FRAME yet (the shipping default): set the confirmed scalars and
    //      leave the vector alone. The caller then logs a sample so the frame can be recorded.
    //   2. A frame is recorded and still matches the live object: also push the observed vector
    //      forward, clamped under MAX_SPEED_MS.
    // Returns { scalar, vector } — what took, not what was attempted.
    accelerateTo(targetMs) {
      const res = { scalar: false, vector: false };
      try {
        if (!G.ready()) return res;
        const cap = G.speedCap();
        const target = Math.max(0, Math.min(cap, +targetMs));
        if (!Number.isFinite(target) || target <= 0) return res;
        res.scalar = G.setSpeedScalars(target);
        const v = G.velocityObj(), shape = velocityShape(v);
        if (shape) {
          const frame = CONFIG.VELOCITY_FRAME;
          const usable = frame ? velocityFrameMatches(frame, v) : !CONFIG.SAFE_WRITES;
          if (usable) {
            const comps = frame && frame.comps ? frame.comps : shape.comps;
            const out = velocityBoosted(vecRead(v, comps), comps, frame ? frame.fwd : null, target, cap);
            if (out) res.vector = G.writeVelocity(out);
          }
        }
        return res;
      } catch (_) { return res; }
    },
    // Set the velocity vector for an aircraft that may be sitting still, from the reference
    // sample recorded in CONFIG.VELOCITY_FRAME (fly-to-start). Same rule as everywhere else:
    // the numbers come from a vector GeoFS produced, never from one made up here.
    setVelocityFromFrame(targetMs) {
      try {
        if (!G.ready()) return false;
        const frame = CONFIG.VELOCITY_FRAME;
        if (!frame || !velocityFrameMatches(frame, G.velocityObj())) return false;
        const out = velocityFromReference(frame, Math.max(0, Math.min(G.speedCap(), +targetMs)), G.speedCap());
        return out ? G.writeVelocity(out) : false;
      } catch (_) { return false; }
    },
    // Heading write for fly-to-start. htr is [heading, pitch, roll] on the local aircraft; only
    // its first entry is touched, in place, and only if it reads as a finite number already.
    setHeading(deg) {
      try {
        if (!G.ready() || !Number.isFinite(+deg)) return false;
        const htr = geofs.aircraft.instance.htr;
        if (!Array.isArray(htr) || htr.length < 1 || !Number.isFinite(+htr[0])) return false;
        htr[0] = ((+deg % 360) + 360) % 360;
        return true;
      } catch (_) { return false; }
    },
    // The capture aid for CONFIG.VELOCITY_FRAME: dump the LIVE velocity object, plus everything
    // needed to interpret it, to the console. Reads only — it never writes and never calls into
    // GeoFS. Two guards: nothing is logged once a matching frame is recorded (the job is done),
    // and nothing is logged outside stable level cruise, because a sample taken mid-turn or
    // mid-climb can't tell a body-fixed frame from an earth-fixed one. Capped at 4 samples per
    // page load so a held Boost can't flood the console.
    _frameLogs: 0,
    logVelocityFrame(reason, now) {
      try {
        if (!G.ready()) return false;
        const v = G.velocityObj();
        if (CONFIG.VELOCITY_FRAME && velocityFrameMatches(CONFIG.VELOCITY_FRAME, v)) return false;
        if (G._frameLogs >= 4) return false;
        if (!CruiseWatch.stable(Number.isFinite(now) ? now : clockNow())) return false;
        const shape = velocityShape(v);
        let keys = [];
        try { keys = v && typeof v === 'object' ? Object.keys(v).slice(0, 12) : []; } catch (_) {}
        const comps = shape ? vecRead(v, shape.comps) : null;
        const n = ++G._frameLogs;
        const tag = '[finsRace] velocity-frame sample ' + n + '/4 (' + (reason || 'manual') + ')';
        console.log(tag + ' — live geofs.aircraft.instance.velocity:', v);
        console.log(tag + ' — ' + JSON.stringify({
          isArray: Array.isArray(v), typeofV: typeof v, keys,
          kind: shape ? shape.kind : null, comps: shape ? shape.comps : null,
          values: comps, mag: comps ? +vecMag(comps).toFixed(3) : null,
          trueAirSpeed: G.tas(), groundSpeed: G.groundSpeedMs(),
          heading: G.heading(), pitch: G.pitch(), roll: G.roll(), kias: G.kias(),
        }));
        if (n === 1) {
          console.log('[finsRace] Take one sample in level cruise on ~090 and another on ~180. ' +
            'If the three numbers stay put as the heading changes, the frame is body-fixed ' +
            '(bodyFixed: true) and the component that tracks airspeed is `fwd`. If they swap ' +
            'around with heading, it is earth-fixed (bodyFixed: false, fwd: null). Write the ' +
            'result into CONFIG.VELOCITY_FRAME in race.js — see README "Capturing the velocity frame".');
        }
        return true;
      } catch (_) { return false; }
    },

    // ---- reposition, for fly-to-start. Two paths, tried in this order by FlyToStart.run():
    //
    // 1. geofs.resetFlight(), GeoFS's own reposition. Preferred because it re-enters the sim
    //    through GeoFS's code instead of around it, so the aircraft's state stays
    //    self-consistent — which is exactly what raw writes can't promise. Its signature is
    //    unverified, so this is capability-checked before the call (resetFlight has to be a
    //    function, and there has to be an existing coordinate array to edit) and
    //    position-checked after it (did we actually end up at gate 1?). Any failure falls
    //    through to (2) in the same click.
    //
    //    The coordinate array is edited the same way the velocity vector is: copy what GeoFS
    //    produced and replace only the entries we know the meaning of ([lat, lon, alt, heading],
    //    the layout multiplayer's `co` uses), so whatever else it carries survives.
    //
    //    Side effect worth knowing: this leaves GeoFS's own "reset flight" pointing at gate 1
    //    too, until the next flight overwrites it.
    repositionViaReset(t) {
      try {
        if (!G.ready() || !t || ![t.lat, t.lon, t.alt].every(Number.isFinite)) return false;
        if (typeof geofs.resetFlight !== 'function') return false;
        let wrote = 0;
        for (const k of ['lastFlightCoordinates', 'initialCoordinates']) {
          const cur = geofs[k];
          if (!Array.isArray(cur) || cur.length < 3 || !cur.slice(0, 3).every((n) => Number.isFinite(+n))) continue;
          const next = cur.slice();
          next[0] = t.lat; next[1] = t.lon; next[2] = t.alt;
          if (next.length > 3 && Number.isFinite(+next[3]) && Number.isFinite(t.heading)) next[3] = t.heading;
          geofs[k] = next;
          wrote++;
        }
        if (!wrote) return false;
        geofs.resetFlight();
        // Verify rather than trust. GeoFS may well reset to a runway, or to the last flight's
        // coordinates, or anywhere else; if it did, say so and let the caller use raw writes.
        const p = G.lla();
        if (![p.lat, p.lon, p.alt].every(Number.isFinite)) return false;
        const tol = Math.max(0, +CONFIG.FLY_TO_START_TOLERANCE_M || 0);
        const horiz = vlen(sub(ecef(p.lat, p.lon, 0), ecef(t.lat, t.lon, 0)));
        // Altitude is checked separately: landing at gate 1's lat/lon but on the ground is a
        // 300 m miss that a 3D distance check would wave through, and it means spawning on
        // terrain at flying speed.
        return horiz <= tol && Math.abs(p.alt - t.alt) <= tol;
      } catch (_) { return false; }
    },
    // 2. Raw state writes: the unconfirmed path, kept as the fallback. llaLocation is mutated in
    //    place — the same array G.lla() reads every frame — because that array is GeoFS's, and
    //    only the numbers in it are ours to change.
    repositionByState(t) {
      try {
        if (!G.ready() || !t || ![t.lat, t.lon, t.alt].every(Number.isFinite)) return false;
        const l = geofs.aircraft.instance.llaLocation;
        if (!Array.isArray(l) || l.length < 3) return false;
        l[0] = t.lat; l[1] = t.lon; l[2] = t.alt;
        return true;
      } catch (_) { return false; }
    },

    // ---- powerups addition (Boost), LAST RESORT ONLY. This was the 0.5.0 default and is now
    // behind CONFIG.BOOST_LLA_FALLBACK (off), because it mutates llaLocation — an unconfirmed
    // write path. If GeoFS's physics loop overwrites that array from its own state before
    // render, this quietly does nothing; if it doesn't, it moves the aircraft without the rest
    // of its state agreeing, which is the stall risk the confirmed writes above avoid.
    nudgeForward(meters) { // TODO-PROBE
      try {
        if (!G.ready() || !Number.isFinite(meters) || meters === 0) return false;
        const l = geofs.aircraft.instance.llaLocation;
        if (!Array.isArray(l) || l.length < 3) return false;
        const hd = G.heading();
        if (hd == null) return false;
        const q = destination({ lat: +l[0], lon: +l[1] }, hd, meters);
        if (![q.lat, q.lon].every(Number.isFinite)) return false;
        l[0] = q.lat; l[1] = q.lon;
        return true;
      } catch (_) { return false; }
    },

    // ---- screen-space projection, for the HUD's waypoint bracket. Cesium 1.96 has this as
    // Cesium.SceneTransforms.wgs84ToWindowCoordinates(scene, cartesian, result); newer builds
    // renamed it worldToWindowCoordinates and eventually dropped the old name, so both are
    // feature-checked rather than assumed. Returns { x, y } in CSS pixels, or null — which is
    // what a point behind the camera gives (Cesium returns undefined for those), and what any
    // failure gives too, so the caller has exactly one "no pixel" case to handle.
    worldToScreen(lat, lon, alt) {
      try {
        if (!G.ready() || ![+lat, +lon, +alt].every(Number.isFinite)) return null;
        const scene = G.scene();
        const T = window.Cesium && Cesium.SceneTransforms;
        if (!scene || !T) return null;
        const fn = typeof T.wgs84ToWindowCoordinates === 'function' ? T.wgs84ToWindowCoordinates
          : typeof T.worldToWindowCoordinates === 'function' ? T.worldToWindowCoordinates : null;
        if (!fn) return null;
        const p = fn.call(T, scene, Cesium.Cartesian3.fromDegrees(+lon, +lat, +alt));
        if (!p || !Number.isFinite(+p.x) || !Number.isFinite(+p.y)) return null;
        return { x: +p.x, y: +p.y };
      } catch (_) { return null; }
    },

    // ---- items (0.10.0). Where another pilot is, for placing an effect on them.
    //
    // Two sources, in this order. GeoFS's own multiplayer.users is the smooth one — the sim
    // interpolates it per frame, while the relay's `world` frame arrives twice a second — so it
    // wins whenever a callsign can be matched to a live multiplayer user. The match is done here
    // rather than in the items module so every GeoFS internal stays inside this adapter, and it
    // fails closed: no match, or any throw, returns null and the caller falls back to relay data.
    //
    // Matching is on trimmed, case-folded callsign because the relay callsign is typed into this
    // panel while the multiplayer one comes from GeoFS's own user record; they are usually the
    // same string, and when they are not, the relay's own world frame is still there.
    otherPilot(callsign) { // TODO-PROBE (callsign equality against a live GeoFS user list)
      try {
        const want = String(callsign || '').trim().toLowerCase();
        if (!want) return null;
        for (const u of G.multiplayerUsers()) {
          if (String(u.callsign || '').trim().toLowerCase() !== want) continue;
          if (![u.lat, u.lon, u.alt].every(Number.isFinite)) return null;
          return { lat: u.lat, lon: u.lon, alt: u.alt, heading: u.heading, source: 'multiplayer' };
        }
        return null;
      } catch (_) { return null; }
    },
    // The element GeoFS renders into, for the hit shake. DOM only — the shake is a CSS transform
    // on this element and nothing else, never a write to the aircraft. Resolved here so the
    // selector guesswork stays in the adapter with every other GeoFS internal.
    renderCanvas() { // TODO-PROBE
      try {
        const scene = G.scene();
        const c = scene && scene.canvas;
        if (c && c.parentElement) return c.parentElement;
        if (c) return c;
        return document.querySelector('#cesiumContainer') || document.querySelector('.cesium-widget') || null;
      } catch (_) { return null; }
    },
    // Height above ground, for the speed penalty's floor. GeoFS exposes it on the animation
    // values; null means "unknown", and the caller then refuses the penalty rather than guessing.
    aglM() { // TODO-PROBE
      try {
        const v = geofs.animation && geofs.animation.values;
        const agl = v && (v.altitudeAGL ?? v.aglFeet ?? v.groundElevationFeet);
        if (v && Number.isFinite(+v.altitudeAGL)) return +v.altitudeAGL * 0.3048;  // GeoFS reports feet
        return Number.isFinite(+agl) ? +agl * 0.3048 : null;
      } catch (_) { return null; }
    },

    // ---- powerups addition (offensive hits). WHOLLY UNPROBED: no probe.js run has ever
    // captured GeoFS's control inputs, so this is gated behind CONFIG.POWERUP_CONTROL_EFFECTS
    // (default false) rather than guessed at live. Returns false when it can't do anything,
    // and Powerups then falls back to screen-effect-only — which is the shipping default.
    // `bias` is clamped to ±0.35 of a normalized control input: enough for a Mario-Kart wobble,
    // deliberately far short of anything that could stall or invert the aircraft.
    controlWobble(bias) { // TODO-PROBE
      try {
        if (!CONFIG.POWERUP_CONTROL_EFFECTS || !G.ready()) return false;
        const c = window.geofs && geofs.controls;
        if (!c || typeof c.aileron !== 'number') return false;
        c.aileron = Math.max(-0.35, Math.min(0.35, +bias || 0));
        return true;
      } catch (_) { return false; }
    },
  };

  // -------------------------------------------------------------- geometry
  const D2R = Math.PI / 180, WGS_A = 6378137, WGS_E2 = 6.69437999014e-3;
  function ecef(lat, lon, alt) {
    const p = lat * D2R, l = lon * D2R, s = Math.sin(p), c = Math.cos(p);
    const N = WGS_A / Math.sqrt(1 - WGS_E2 * s * s);
    return [(N + alt) * c * Math.cos(l), (N + alt) * c * Math.sin(l), (N * (1 - WGS_E2) + alt) * s];
  }
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const vlen = (a) => Math.sqrt(dot(a, a));
  // Closest approach of segment p0→p1 to c. Returns t∈[0,1] if within r, else -1.
  function segHit(p0, p1, c, r) {
    const d = sub(p1, p0), f = sub(p0, c), dd = dot(d, d);
    const t = dd > 0 ? Math.max(0, Math.min(1, -dot(f, d) / dd)) : 0;
    const q = [f[0] + d[0] * t, f[1] + d[1] * t, f[2] + d[2] * t];
    return vlen(q) <= r ? t : -1;
  }
  function bearingDeg(a, b) {
    const f1 = a.lat * D2R, f2 = b.lat * D2R, dl = (b.lon - a.lon) * D2R;
    const y = Math.sin(dl) * Math.cos(f2);
    const x = Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl);
    return (Math.atan2(y, x) / D2R + 360) % 360;
  }
  function destination(p, brg, dist) {
    const dr = dist / 6371008.8, th = brg * D2R, f1 = p.lat * D2R, l1 = p.lon * D2R;
    const f2 = Math.asin(Math.sin(f1) * Math.cos(dr) + Math.cos(f1) * Math.sin(dr) * Math.cos(th));
    const l2 = l1 + Math.atan2(Math.sin(th) * Math.sin(dr) * Math.cos(f1), Math.cos(dr) - Math.sin(f1) * Math.sin(f2));
    return { lat: f2 / D2R, lon: ((l2 / D2R + 540) % 360) - 180 };
  }

  // ------------------------------------------------------------ formatting
  function fmt(ms) {
    if (!Number.isFinite(ms)) return '-:--.---';
    const neg = ms < 0; ms = Math.abs(Math.round(ms));
    const m = Math.floor(ms / 60000), s = Math.floor(ms / 1000) % 60, r = ms % 1000;
    return (neg ? '-' : '') + m + ':' + String(s).padStart(2, '0') + '.' + String(r).padStart(3, '0');
  }
  const fmtDelta = (ms) => Number.isFinite(ms) ? (ms < 0 ? '−' : '+') + (Math.abs(ms) / 1000).toFixed(3) : '';
  const fmtDist = (m) => m >= 1000 ? (m / 1000).toFixed(1) + ' km' : Math.max(0, Math.round(m)) + ' m';
  const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64) || 'course';

  // ---------------------------------------------------------------- course
  // Mirrors the relay's own MAX_BOXES (race/server/app.py) and add_course.py's cap — a `box`
  // frame carries an id validated against exactly this range.
  const MAX_ITEM_BOXES = 24;
  const Course = {
    normalize(c) {
      if (!c || !Array.isArray(c.gates) || c.gates.length < 2) throw new Error('A course needs at least 2 gates.');
      if (c.gates.length > 201) throw new Error('A course can have at most 201 gates.');
      const gates = c.gates.map((g, i) => {
        const o = { lat: +g.lat, lon: +g.lon, alt: +g.alt, radius: +(g.radius ?? CONFIG.DEFAULT_RADIUS_M) };
        if (![o.lat, o.lon, o.alt, o.radius].every(Number.isFinite) || Math.abs(o.lat) > 90 ||
            Math.abs(o.lon) > 180 || o.radius <= 0 || o.radius > 5000) throw new Error('Gate ' + i + ' is invalid.');
        return o;
      });
      const name = String(c.name || 'Untitled course').slice(0, 48);
      const startType = c.startType === 'air' ? 'air' : 'ground';
      return { id: slug(c.id || name), name, version: +c.version || 1,
        aircraftId: c.aircraftId != null && c.aircraftId !== '' ? String(c.aircraftId) : null, startType,
        itemBoxes: Course.normalizeItemBoxes(c), gates };
    },
    // The contested powerups item boxes: optional, up to MAX_ITEM_BOXES, and NOT part of the
    // race — they don't count for progress and are deliberately left out of Course.hash(), so
    // adding or moving boxes never resets a course's leaderboard. (0.10.0 turned the single
    // `itemBox` into a list; a course written before that is read as a one-element list, which
    // is why the legacy key is still accepted here and in race/tools/add_course.py.)
    normalizeItemBoxes(c) {
      const raw = Array.isArray(c && c.itemBoxes) ? c.itemBoxes
        : (c && c.itemBox ? [c.itemBox] : []);
      const out = [];
      for (const b of raw) {
        const o = Course.normalizeItemBox(b);
        if (o) out.push(o);
        if (out.length >= MAX_ITEM_BOXES) break;
      }
      return out;
    },
    // One box. A malformed box is dropped rather than thrown, matching this normalizer's
    // permissive posture (race/tools/add_course.py is the strict one: it rejects and explains,
    // since it curates the shared list).
    normalizeItemBox(b) {
      if (!b || typeof b !== 'object') return null;
      const o = { lat: +b.lat, lon: +b.lon, alt: +b.alt, radius: +(b.radius ?? CONFIG.DEFAULT_RADIUS_M) };
      if (![o.lat, o.lon, o.alt, o.radius].every(Number.isFinite) || Math.abs(o.lat) > 90 ||
          Math.abs(o.lon) > 180 || o.radius <= 0 || o.radius > 5000) return null;
      return o;
    },
    hash(c) { // FNV-1a over geometry + aircraft rule: same hash = same race
      const s = JSON.stringify([c.aircraftId, c.gates.map((g) => [g.lat.toFixed(6), g.lon.toFixed(6), g.alt.toFixed(1), g.radius.toFixed(1)])]);
      let h = 0x811c9dc5;
      for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
      return (h >>> 0).toString(16).padStart(8, '0');
    },
    length(c) {
      let t = 0;
      for (let i = 1; i < c.gates.length; i++) {
        const a = c.gates[i - 1], b = c.gates[i];
        t += vlen(sub(ecef(a.lat, a.lon, a.alt), ecef(b.lat, b.lon, b.alt)));
      }
      return t;
    },
  };

  // ------------------------------------------------------ gate rendering
  function makeGateLayer(kind) {
    const layer = { ents: [], ok: true };
    const colors = () => ({
      next: Cesium.Color.fromCssColorString('#5be38f').withAlpha(0.35),
      after: Cesium.Color.fromCssColorString('#ff8a3d').withAlpha(0.25),
      later: Cesium.Color.WHITE.withAlpha(0.12),
      draft: Cesium.Color.fromCssColorString('#ff3d8b').withAlpha(0.3),
    });
    layer.clear = () => {
      if (!layer.ents.length) return;
      try { const v = G.viewer(); for (const e of layer.ents) { v.entities.remove(e.ball); v.entities.remove(e.pole); } } catch (_) {}
      layer.ents = [];
    };
    layer.draw = (gates) => {
      layer.clear();
      if (!G.ready()) return;
      try {
        const v = G.viewer(), C = colors(), n = gates.length;
        gates.forEach((g, i) => {
          const alt = g.alt + CONFIG.ALT_OFFSET_M;
          const text = kind === 'draft' ? 'Draft ' + (i + 1)
            : i === 0 ? 'Start' : i === n - 1 ? 'Finish' : 'Gate ' + i;
          const ball = v.entities.add({
            position: Cesium.Cartesian3.fromDegrees(g.lon, g.lat, alt),
            ellipsoid: { radii: new Cesium.Cartesian3(g.radius, g.radius, g.radius),
              material: kind === 'draft' ? C.draft : C.later },
            label: { text, font: 'bold 18px "Trebuchet MS", sans-serif', fillColor: Cesium.Color.WHITE,
              outlineColor: Cesium.Color.BLACK, outlineWidth: 3, style: Cesium.LabelStyle.FILL_AND_OUTLINE,
              pixelOffset: new Cesium.Cartesian2(0, -24), disableDepthTestDistance: Number.POSITIVE_INFINITY },
          });
          const pole = v.entities.add({
            polyline: { positions: Cesium.Cartesian3.fromDegreesArrayHeights([g.lon, g.lat, alt - g.radius, g.lon, g.lat, 0]),
              width: 2, material: Cesium.Color.WHITE.withAlpha(0.35) },
          });
          layer.ents.push({ ball, pole });
        });
        layer.ok = true;
      } catch (e) {
        layer.ok = false;
        console.warn('[finsRace] gate rendering unavailable; HUD still works', e);
      }
    };
    layer.highlight = (next) => {
      if (!layer.ok || kind === 'draft') return;
      const C = colors();
      layer.ents.forEach((e, i) => {
        const show = i >= next;
        e.ball.show = show; e.pole.show = show;
        if (show) e.ball.ellipsoid.material = i === next ? C.next : i === next + 1 ? C.after : C.later;
      });
    };
    return layer;
  }
  // Item boxes get their own factory rather than riding makeGateLayer: they are a slowly
  // rotating yellow cube with a "?" on it, not a sphere, and they have a state a gate does not
  // (dark while somebody else's pickup is on cooldown). Same contract as every other
  // make*Layer: all Cesium lives inside, `ok` says whether it drew, clear() is safe to call
  // twice, and any throw degrades to "no boxes rendered" with one console.warn.
  function makeBoxLayer() {
    const layer = { ok: true, ents: [], mode: 'none', spin: 0 };
    const YELLOW = () => Cesium.Color.fromCssColorString('#ffd23d');

    layer.clear = () => {
      try {
        const v = G.viewer();
        for (const e of layer.ents) { v.entities.remove(e.body); v.entities.remove(e.pole); }
      } catch (_) {}
      layer.ents = [];
      layer.mode = 'none';
    };

    layer.draw = (boxes) => {
      layer.clear();
      if (!G.ready() || !Array.isArray(boxes) || !boxes.length) return;
      try {
        const v = G.viewer();
        // Cesium.BoxGraphics has been in every build this project has ever seen, but a cube
        // needs an orientation to spin and that needs Transforms.headingPitchRollQuaternion.
        // Where either is missing, fall back to the old sphere rather than draw nothing.
        const canCube = !!(window.Cesium && Cesium.Transforms &&
          typeof Cesium.Transforms.headingPitchRollQuaternion === 'function' &&
          typeof Cesium.CallbackProperty === 'function' && Cesium.HeadingPitchRoll);
        layer.mode = canCube ? 'cube' : 'sphere';
        boxes.forEach((b, i) => {
          const alt = b.alt + CONFIG.ALT_OFFSET_M;
          const position = Cesium.Cartesian3.fromDegrees(b.lon, b.lat, alt);
          // The cube is drawn at the box's own radius so what you see is what you have to fly
          // through — the same promise a gate sphere makes.
          const side = Math.max(10, b.radius * 1.4);
          const graphics = canCube
            ? { box: { dimensions: new Cesium.Cartesian3(side, side, side),
                material: YELLOW().withAlpha(0.45), outline: false } }
            : { ellipsoid: { radii: new Cesium.Cartesian3(b.radius, b.radius, b.radius),
                material: YELLOW().withAlpha(0.4) } };
          const body = v.entities.add({
            position,
            ...graphics,
            ...(canCube ? { orientation: new Cesium.CallbackProperty(() => Cesium.Transforms
              .headingPitchRollQuaternion(position, new Cesium.HeadingPitchRoll(layer.spin, 0, 0)), false) } : {}),
            label: { text: '?', font: 'bold 34px "Trebuchet MS", sans-serif', fillColor: YELLOW(),
              outlineColor: Cesium.Color.BLACK, outlineWidth: 4, style: Cesium.LabelStyle.FILL_AND_OUTLINE,
              pixelOffset: new Cesium.Cartesian2(0, -6), disableDepthTestDistance: Number.POSITIVE_INFINITY },
          });
          body.__finsBox = i;
          const pole = v.entities.add({
            polyline: { positions: Cesium.Cartesian3.fromDegreesArrayHeights([b.lon, b.lat, alt - b.radius, b.lon, b.lat, 0]),
              width: 2, material: YELLOW().withAlpha(0.25) },
          });
          layer.ents.push({ body, pole, dark: false });
        });
        layer.ok = true;
      } catch (e) {
        layer.ok = false;
        console.warn('[finsRace] item boxes unavailable; the race is unaffected', e);
        try { layer.clear(); } catch (_) {}
      }
    };

    // A box somebody else just took. Hidden outright while dark; the fade back in is the label
    // and body alpha ramping over the last 800 ms of the cooldown (see tick()).
    layer.setDark = (i, dark) => {
      const e = layer.ents[i];
      if (!layer.ok || !e) return;
      try {
        e.dark = !!dark;
        e.body.show = !dark;
        e.pole.show = !dark;
      } catch (_) {}
    };

    // Called from the animation loop. Two things: the slow spin, and the fade-in of a box whose
    // cooldown is nearly up. `readyAt` is the per-box clock Race keeps (rAF ms), 0 = lit.
    layer.tick = (now, readyAt) => {
      if (!layer.ok || !layer.ents.length) return;
      layer.spin = (now / 4000) % (Math.PI * 2);
      try {
        layer.ents.forEach((e, i) => {
          const until = (readyAt && readyAt[i]) || 0;
          const dark = now < until;
          if (dark !== e.dark) layer.setDark(i, dark);
          if (!dark) {
            const since = until ? now - until : Infinity;
            const a = since < 800 ? 0.1 + 0.35 * (since / 800) : 0.45;
            const mat = e.body.box ? e.body.box.material : e.body.ellipsoid && e.body.ellipsoid.material;
            if (mat && typeof mat === 'object' && 'withAlpha' in mat) {
              if (e.body.box) e.body.box.material = YELLOW().withAlpha(a);
              else e.body.ellipsoid.material = YELLOW().withAlpha(a);
            }
          }
        });
      } catch (_) { /* a box that will not restyle is still a box */ }
    };

    return layer;
  }

  // ---------------------------------------------------- item rendering (Cesium)
  // The ONE Cesium factory for everything the items layer draws in the world: missile and goop
  // projectiles and their splats, bananas, goop blobs trailing a victim, boost trails, shield
  // bubbles. Same contract as makeGateLayer/makeGhostLayer/makeLineLayer — all Cesium lives in
  // here, `ok` says whether it is drawing, clear() is safe to call twice, and any throw degrades
  // to "no item effects" with one console.warn and never reaches the race loop.
  //
  // Two rules this factory exists to enforce, both of which are about a race staying playable
  // rather than about any one effect looking right:
  //
  //  * a HARD entity budget (CONFIG.ITEM_ENTITY_BUDGET). Past it, the oldest entity is evicted.
  //    A ten-minute race with five pilots throwing everything they pick up must not be able to
  //    grow the scene without bound.
  //  * a TTL on EVERY entity, enforced here on the client's own clock. The frame that clears an
  //    effect (`resolved`, `cleared`) can always be the one that gets lost to a dropped socket
  //    or a relay restart; nothing this factory draws is allowed to depend on it arriving.
  function makeItemLayer() {
    const layer = { ok: true, recs: [], byKey: new Map(), evicted: 0 };

    const kill = (rec) => { try { G.viewer().entities.remove(rec.ent); } catch (_) {} };
    const ttlFor = (ms) => { const n = +ms; return Number.isFinite(n) && n > 0 ? n : Math.max(1, +CONFIG.ITEM_TTL_MS || 12000); };

    layer.clear = () => {
      for (const r of layer.recs) kill(r);
      layer.recs = [];
      layer.byKey.clear();
    };
    layer.count = () => layer.recs.length;
    layer.get = (key) => { const r = layer.byKey.get(key); return r ? r.ent : null; };
    layer.keys = () => layer.recs.map((r) => r.key);

    // Add (replacing any entity already under this key). `ttlMs` is the client-side lifetime;
    // a caller that passes nothing usable gets CONFIG.ITEM_TTL_MS, so there is no path to an
    // entity with no deadline at all.
    layer.add = (key, options, ttlMs, now) => {
      if (!layer.ok || !G.ready()) return null;
      layer.drop(key);
      try {
        const ent = G.viewer().entities.add(options);
        ent.__finsItem = key;
        const rec = { key, ent, until: now + ttlFor(ttlMs) };
        layer.recs.push(rec);
        layer.byKey.set(key, rec);
        const budget = Math.max(1, Math.round(+CONFIG.ITEM_ENTITY_BUDGET || 40));
        while (layer.recs.length > budget) {
          const old = layer.recs.shift();
          layer.byKey.delete(old.key);
          kill(old);
          layer.evicted++;
        }
        return ent;
      } catch (e) {
        layer.ok = false;
        console.warn('[finsRace] item effects unavailable; the race is unaffected', e);
        try { layer.clear(); } catch (_) {}
        return null;
      }
    };

    layer.drop = (key) => {
      const rec = layer.byKey.get(key);
      if (!rec) return false;
      layer.byKey.delete(key);
      const i = layer.recs.indexOf(rec);
      if (i >= 0) layer.recs.splice(i, 1);
      kill(rec);
      return true;
    };

    // Push an entity's deadline out — for effects whose real end is known (a banana's server
    // TTL) but which must still never outlive a lost clearing frame by much.
    layer.touch = (key, ttlMs, now) => {
      const rec = layer.byKey.get(key);
      if (rec) rec.until = now + ttlFor(ttlMs);
      return !!rec;
    };

    layer.prune = (now) => {
      for (const rec of layer.recs.slice()) if (now >= rec.until) layer.drop(rec.key);
    };

    // Mutate an existing entity's graphics. Every caller's writes go through here so one bad
    // frame turns the layer off instead of throwing per frame for the rest of the race.
    layer.edit = (key, fn) => {
      const ent = layer.get(key);
      if (!ent || !layer.ok) return false;
      try { fn(ent); return true; }
      catch (e) {
        layer.ok = false;
        console.warn('[finsRace] item effect update failed; dropping item effects', e);
        try { layer.clear(); } catch (_) {}
        return false;
      }
    };

    return layer;
  }

  const RaceGates = makeGateLayer('race');
  const DraftGates = makeGateLayer('draft');
  const ItemBoxGate = makeBoxLayer();

  // ------------------------------------------------- course map (Leaflet nav-map overlay)
  // Draws the current course's gates + route line on GeoFS's own Leaflet nav map, mirroring
  // RaceGates' lifecycle but touching Leaflet instead of Cesium. Wholly additive: it is a
  // second, independent subscriber to the Race event bus (see the events section below) and
  // never touches RaceGates or the race engine. Any throw here degrades to "map overlay off"
  // plus a status line (surfaced in the panel, see UI.E.mapStatus), never breaks the race.
  //
  // If G.leafletMap() is null when a course loads (nav map not open yet), this simply no-ops;
  // the next 'load' (picking a course again, or the map opening) tries again. Simpler than
  // polling for the map to open, and courses are already re-drawn on every load.
  const CourseMap = {
    map: null, group: null, gateLayers: [], routeLine: null, status: '',

    _syncStatus() {
      try { if (UI.E.mapStatus) UI.E.mapStatus.textContent = CONFIG.COURSE_MAP ? this.status : ''; } catch (_) {}
    },

    draw(course) {
      this.clear();
      if (!CONFIG.COURSE_MAP) return;
      try {
        const map = G.leafletMap();
        if (!map) { this.status = 'Course map overlay off: GeoFS map not open (open it with the map button).'; this._syncStatus(); return; }
        this.map = map;
        this.group = L.layerGroup();
        const n = course.gates.length;
        this.gateLayers = course.gates.map((g, i) => {
          const isStart = i === 0, isFinish = i === n - 1;
          const color = isStart ? '#5be38f' : isFinish ? '#ff3d8b' : '#ffffff';
          const circle = L.circle([g.lat, g.lon], {
            radius: g.radius, color, weight: isStart || isFinish ? 3 : 2,
            fillColor: color, fillOpacity: 0.15, opacity: 1,
          });
          const label = isStart ? 'Start' : isFinish ? 'Finish' : 'Gate ' + i;
          circle.bindTooltip(String(i + 1) + ' · ' + label, { permanent: true, direction: 'center', className: 'fr-map-gate' });
          circle.addTo(this.group);
          return circle;
        });
        this.routeLine = L.polyline(course.gates.map((g) => [g.lat, g.lon]), { color: '#ff8a3d', weight: 2, opacity: 0.7 });
        this.routeLine.addTo(this.group);
        this.group.addTo(map);
        this.status = '';
        this._syncStatus();
      } catch (e) {
        this.status = 'Course map overlay off: ' + e.message;
        this.clear(); // clear() resets state but not `status`; keep the message for the panel
        this._syncStatus();
      }
    },

    // Mirrors RaceGates.highlight(next): gates before `next` are "done", `next` itself is
    // current. Leaflet has no per-entity .show, so "hidden" is approximated with near-zero
    // opacity instead of removing the layer, which also avoids fighting bindTooltip's binding.
    highlight(next) {
      if (!CONFIG.COURSE_MAP || !this.gateLayers.length) return;
      try {
        this.gateLayers.forEach((circle, i) => {
          const done = i < next, isNext = i === next, isAfter = i === next + 1;
          circle.setStyle({
            opacity: done ? 0.25 : 1,
            fillOpacity: done ? 0.05 : isNext ? 0.5 : isAfter ? 0.3 : 0.15,
          });
        });
        this.status = '';
      } catch (e) { this.status = 'Course map overlay off: ' + e.message; }
      this._syncStatus();
    },

    clear() {
      try { if (this.map && this.group) this.map.removeLayer(this.group); } catch (_) {}
      this.map = null; this.group = null; this.gateLayers = []; this.routeLine = null;
    },
  };

  // ----------------------------------------------------------- race engine
  // States: idle (no course) → armed → running → finished | dq. Reset returns to armed.
  // Start = leaving the start sphere (standing or flying start). Other gates = first frame the
  // flight path passes within the radius (time interpolated to closest approach within that frame,
  // which is effectively first contact at normal frame rates). Finish = contact with the last gate.
  const Race = {
    course: null, hash: '', lengthM: 0, centers: [], boxCenters: [], boxReadyAt: [],
    state: 'idle', next: 0, elapsed: 0, splits: [], finalMs: null, dqReason: '',
    prev: null, prevT: 0, chk: null, chkT: 0, wasInStart: false,
    // Second clock (Lobby, race/PROTOCOL.md "Proto 2: lobby"): time since a relay-synced GO,
    // independent of the leaderboard's own gate-1-crossing clock (`elapsed`/`splits`/`finalMs`
    // above, untouched by any of this). goAt is null outside a lobby race — that's the signal
    // this whole block uses to know whether it applies at all, no separate "is this a lobby
    // race" flag needed. It runs on Date.now() to match Countdown's own arm(targetMs), not the
    // rAF clock `tick(now)` receives, since it has to agree with every other client's wall clock.
    goAt: null, goElapsed: null, jumpStartMs: 0,
    listeners: [],
    on(fn) { this.listeners.push(fn); },
    emit(ev, data) { for (const fn of this.listeners) { try { fn(ev, data); } catch (e) { console.error('[finsRace]', e); } } },

    load(raw) {
      const c = Course.normalize(raw);
      this.course = c;
      this.hash = Course.hash(c);
      this.lengthM = Course.length(c);
      this.centers = c.gates.map((g) => ecef(g.lat, g.lon, g.alt));
      this.boxCenters = c.itemBoxes.map((b) => ecef(b.lat, b.lon, b.alt));
      RaceGates.draw(c.gates);
      this.reset();
      this.emit('load', c);
      return c;
    },
    // A lobby race this client is in (goAt set, so a synced GO was armed) that is being thrown away
    // while still unfinished — a reset, or the course swapped out from under it. Emitted BEFORE the
    // state changes so a listener still sees `next`; the Results module turns it into a `dnf`.
    // A finished or DQ'd run has already said its piece, and a plain non-lobby run has no GO.
    _abandon() {
      if (this.goAt != null && (this.state === 'armed' || this.state === 'running')) this.emit('abandon', { gate: this.next });
    },
    unload() { this._abandon(); this.course = null; this.boxCenters = []; this.boxReadyAt = []; RaceGates.clear(); this.state = 'idle'; this.clearGo(); this.emit('reset'); },
    // Arms the second clock for a lobby race: atMs is a Date.now()-comparable epoch, exactly
    // what Countdown.arm() itself is driven from (see Lobby.onRelayMessage's 'start' handler).
    armGo(atMs) { this.goAt = Number.isFinite(atMs) ? atMs : null; this.goElapsed = null; this.jumpStartMs = 0; },
    clearGo() { this.goAt = null; this.goElapsed = null; this.jumpStartMs = 0; },
    reset() {
      this._abandon();
      this.state = this.course ? 'armed' : 'idle';
      this.next = 0; this.elapsed = 0; this.splits = []; this.finalMs = null; this.dqReason = '';
      this.chk = null; this.wasInStart = false; this.boxReadyAt = this.boxCenters.map(() => 0);
      this.clearGo();
      if (this.course) {
        RaceGates.highlight(0);
        if (this.prev) this.wasInStart = vlen(sub(this.prev, this.centers[0])) <= this.course.gates[0].radius;
      }
      this.emit('reset');
    },
    dq(reason) {
      this.state = 'dq'; this.dqReason = reason;
      RaceGates.highlight(this.course.gates.length);
      this.emit('dq', reason);
    },

    tick(now) {
      // Runs unconditionally, even before GeoFS is ready: it depends only on the wall clock, and
      // it has to keep counting for every other client in the room regardless of this one's sim.
      if (this.goAt != null) this.goElapsed = Date.now() - this.goAt + this.jumpStartMs;
      if (!G.ready()) return;
      const p = G.lla();
      if (![p.lat, p.lon, p.alt].every(Number.isFinite)) return;
      const e = ecef(p.lat, p.lon, p.alt);
      const paused = G.paused();
      const prev = this.prev, prevT = this.prevT, dt = prev ? Math.max(0, now - prevT) : 0;
      this.prev = e; this.prevT = now;
      this.pos = p;
      if (!prev || !this.course) return;

      // Speed sanity: distance over max(elapsed, 250 ms) so frame jitter can't false-trigger,
      // checked every frame and before gate detection so a teleport can't score gates.
      if (this.state === 'running') {
        if (paused) {
          this.chk = null;
          if (vlen(sub(e, prev)) > CONFIG.PAUSE_MOVE_TOLERANCE_M) return this.dq('Aircraft moved while paused');
        } else {
          if (!this.chk) { this.chk = prev; this.chkT = prevT; }
          const span = now - this.chkT;
          const v = vlen(sub(e, this.chk)) / (Math.max(span, 250) / 1000);
          if (v > CONFIG.MAX_SPEED_MS) return this.dq('Position jumped (' + Math.round(v) + ' m/s)');
          if (span >= 250) { this.chk = e; this.chkT = now; }
        }
      }
      if (paused) return;
      if (this.state === 'running') this.elapsed += dt;
      if (this.state === 'armed') {
        const jumped = vlen(sub(e, prev)) / (Math.max(dt, 250) / 1000) > CONFIG.MAX_SPEED_MS;
        this.detectStart(prev, e, dt, jumped);
      }
      if (this.state === 'running') this.detectGates(prev, e, dt, this.minT || 0);
      if (this.state === 'running') this.detectItemBox(prev, e, now);
      this.minT = 0;
    },

    // The powerups item boxes. Detected with the same interpolated segment test the gates use,
    // so they can't be tunnelled through, but deliberately kept out of the progress/splits path:
    // they never advance `next`, never record a split, and never change `state`. Only while
    // running — you can't farm them while armed. Emits for whoever's listening (the Powerups
    // module, when CONFIG.POWERUPS is on); nothing here depends on that listener.
    //
    // `boxReadyAt[i]` is the one piece of cooldown state Race owns: an rAF timestamp before
    // which box i does not trigger again. It is set locally on a pickup and corrected by the
    // relay's `box_state` (Powerups), which is what makes a box contested rather than per-pilot.
    // Race itself never knows the relay exists.
    detectItemBox(p0, p1, now) {
      const boxes = this.course.itemBoxes;
      for (let i = 0; i < this.boxCenters.length; i++) {
        if (now < (this.boxReadyAt[i] || 0)) continue;
        if (segHit(p0, p1, this.boxCenters[i], boxes[i].radius) < 0) continue;
        this.boxReadyAt[i] = now + (+CONFIG.BOX_RESPAWN_MS || 0);
        this.emit('itembox', { id: i, at: this.elapsed });
        return;   // one box per frame; two overlapping boxes would be a course-authoring bug
      }
    },

    detectStart(p0, p1, dt, jumped) {
      const c = this.centers[0], r = this.course.gates[0].radius;
      const d0 = vlen(sub(p0, c)), d1 = vlen(sub(p1, c));
      const inside = d1 <= r;
      if (jumped) { this.wasInStart = inside; return; }   // repositioning never counts as a start
      let after = -1, t = 0;
      if (this.wasInStart && !inside) {                 // left the sphere
        t = d1 > d0 ? Math.min(1, Math.max(0, (r - d0) / (d1 - d0))) : 1;
        after = (1 - t) * dt;
      } else if (!this.wasInStart && !inside) {         // flew clean through it inside one frame
        const th = segHit(p0, p1, c, r);
        if (th >= 0) { t = th; after = (1 - th) * dt; }
      }
      this.wasInStart = inside;
      if (after < 0) return;
      const req = this.course.aircraftId;
      if (req && G.aircraftId() !== req) return this.dq('This course requires aircraft id ' + req);
      this.state = 'running'; this.elapsed = after; this.next = 1; this.chk = null; this.minT = t;
      // Jump start: only meaningful in a lobby race (goAt set — see armGo()). Crossing before the
      // synced GO is a penalty, not a DQ, since a false start off a bad reaction is still racing.
      if (this.goAt != null) {
        this.jumpStartMs = Date.now() < this.goAt ? (+CONFIG.JUMP_START_PENALTY_MS || 0) : 0;
        this.goElapsed = Date.now() - this.goAt + this.jumpStartMs;
        if (this.jumpStartMs) this.emit('jumpstart', this.jumpStartMs);
      }
      RaceGates.highlight(1);
      this.emit('start');
    },

    detectGates(p0, p1, dt, minT) {
      const gates = this.course.gates;
      for (let guard = 0; guard < 8 && this.state === 'running'; guard++) {
        const i = this.next;
        const t = segHit(p0, p1, this.centers[i], gates[i].radius);
        if (t < 0 || t < minT) return;
        minT = t;
        const at = Math.max(0, Math.round(this.elapsed - (1 - t) * dt));
        this.splits.push(at);
        this.next++;
        if (this.next >= gates.length) {
          this.state = 'finished'; this.finalMs = at;
          RaceGates.highlight(gates.length);
          this.emit('finish', at);
          return;
        }
        RaceGates.highlight(this.next);
        this.emit('gate', { index: i, at });
      }
    },
  };

  // -------------------------------------------------------------------- lobby (proto 2, pure)
  // race/PROTOCOL.md "Proto 2: lobby". Three pure functions, all exported to the test harness
  // the same way the powerups* functions are — no socket, no clock, no Race/Cesium reference.

  // samples = [{t0, t1, server_ms}], one per ping/pong round trip: t0 = local time the ping was
  // sent, t1 = local time the pong arrived, both in the SAME clock the caller will later compare
  // against (Date.now(), to match Countdown's own arm(targetMs)). Picks the minimum-RTT sample —
  // the one least distorted by a queued frame or a GC pause — and estimates offset such that
  // serverMs ≈ localMs + offset. Returns null for an empty list rather than guessing 0, so a
  // caller can tell "never synced" apart from "synced to zero offset".
  function clockOffset(samples) {
    if (!Array.isArray(samples) || !samples.length) return null;
    let best = null, bestRtt = Infinity;
    for (const s of samples) {
      if (!s || ![s.t0, s.t1, s.server_ms].every(Number.isFinite)) continue;
      const rtt = s.t1 - s.t0;
      if (rtt < 0) continue;
      if (rtt < bestRtt) { bestRtt = rtt; best = s; }
    }
    if (!best) return null;
    return best.server_ms + bestRtt / 2 - best.t1;
  }

  // A relay server_ms in this client's Date.now() frame, given clockOffset()'s estimate (server ≈
  // local + offset). Pure; null offset = never synced, and the raw value is the best guess left.
  // With the relay 1.8 s BEHIND this client (2026-09-23), offset is about -1800, so a GO the relay
  // stamps at S lands here at S + 1800.
  function serverToLocalMs(serverMs, offsetMs) {
    return Number.isFinite(offsetMs) ? serverMs - offsetMs : serverMs;
  }

  // Reduces the client's view of the room from relay frames. `state` starts as
  // lobbyInitialState() below; every frame this doesn't recognize passes state through
  // unchanged, which is what lets an old/irrelevant frame type (a powerups `standings`, say)
  // flow through the same pipe with no special-casing.
  function lobbyInitialState() {
    return { phase: null, host: null, course: null, rules: { powerups: true, teleport: true },
      raceId: 0, players: [], start: null, chat: [], cup: null, vote: null };
  }
  // The course vote's live tally (proto 5, race/PROTOCOL.md "Course vote"): null until a `vote`
  // frame arrives (an old relay, or a room where nobody has voted candidates in yet, never sends
  // one). Untrusted input, so shaped defensively rather than trusted whole.
  function lobbyVote(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const candidates = Array.isArray(raw.candidates) ? raw.candidates
      .filter((c) => c && typeof c.course_id === 'string' && typeof c.name === 'string')
      .map((c) => ({ courseId: c.course_id, name: c.name })).slice(0, 8) : [];
    const votes = {};
    if (raw.votes && typeof raw.votes === 'object') {
      for (const [callsign, courseId] of Object.entries(raw.votes)) {
        if (typeof callsign === 'string' && typeof courseId === 'string') votes[callsign] = courseId;
      }
    }
    return { candidates, votes };
  }
  // The `start` frame's additive proto-5 `vote` field: the winning course_id/name and the tally
  // that produced it, or null when the host picked by hand or nobody voted.
  function lobbyStartVote(raw) {
    if (!raw || typeof raw !== 'object' || typeof raw.course_id !== 'string' || typeof raw.name !== 'string') return null;
    const votes = {};
    if (raw.votes && typeof raw.votes === 'object') {
      for (const [callsign, courseId] of Object.entries(raw.votes)) {
        if (typeof callsign === 'string' && typeof courseId === 'string') votes[callsign] = courseId;
      }
    }
    return { courseId: raw.course_id, name: raw.name, votes };
  }
  // The cup in progress, from a `lobby` frame's proto-4 `cup` field: null (a one-off, or a relay too
  // old to have cups) or { name, raceNo, raceCount }. Untrusted input, so validated and clamped.
  function lobbyCup(raw) {
    if (!raw || typeof raw !== 'object' || typeof raw.name !== 'string') return null;
    const count = Math.round(+raw.race_count), no = Math.round(+raw.race_no);
    if (!Number.isFinite(count) || count < 1 || count > 12) return null;
    return { name: raw.name.slice(0, 32), raceNo: Number.isFinite(no) ? Math.max(0, Math.min(count, no)) : 0, raceCount: count };
  }
  function lobbyReduce(state, frame) {
    const s = state || lobbyInitialState();
    if (!frame || typeof frame !== 'object') return s;
    if (frame.type === 'lobby') {
      return { ...s, phase: frame.phase, host: frame.host, course: frame.course || null,
        rules: frame.rules || s.rules, raceId: +frame.race_id || 0,
        players: Array.isArray(frame.players) ? frame.players : [], cup: lobbyCup(frame.cup) };
    }
    if (frame.type === 'start') {
      return { ...s, vote: null, start: { raceId: +frame.race_id || 0, startAtServerMs: +frame.start_at_server_ms || 0,
        racers: Array.isArray(frame.racers) ? frame.racers.map(String) : [], vote: lobbyStartVote(frame.vote) } };
    }
    if (frame.type === 'abort') return { ...s, start: null };
    if (frame.type === 'vote') return { ...s, vote: lobbyVote(frame) };
    // proto 2's fixed-enum chat (`code`) and proto 5's free text (`text`) are two shapes of the
    // same frame name (race/PROTOCOL.md "Free-text lobby chat") — tagged by `kind` here so the
    // Gate chat panel can render either without re-sniffing which field is present.
    if (frame.type === 'chat' && typeof frame.callsign === 'string' && typeof frame.code === 'string') {
      const chat = [{ kind: 'code', callsign: frame.callsign, code: frame.code }, ...s.chat].slice(0, 40);
      return { ...s, chat };
    }
    // The relay sends free text as { from, text } (race/PROTOCOL.md "Free-text lobby chat");
    // through 1.3.x this only accepted `callsign`, so no typed line was ever displayed anywhere.
    const who = typeof frame.from === 'string' ? frame.from : frame.callsign;
    if (frame.type === 'chat' && typeof who === 'string' && typeof frame.text === 'string') {
      const chat = [{ kind: 'text', callsign: who, text: frame.text }, ...s.chat].slice(0, 40);
      return { ...s, chat };
    }
    return s;
  }
  // Can this room be started right now, and on what? Pure (lobby reliability pass). A host-set
  // course is enough; so is a vote with at least one vote cast for a candidate — the relay resolves
  // the winner inside its `start` handler, so waiting for `course` to be set first (what 1.3.x
  // did) deadlocked every voting room: the vote hid the host's picker and start needed a course.
  // Returns { ok, via: 'course'|'vote'|null, why }.
  function lobbyCanStart(state) {
    const s = state || lobbyInitialState();
    if (s.course) return { ok: true, via: 'course', why: '' };
    const v = s.vote, ids = new Set(((v && v.candidates) || []).map((c) => c.courseId));
    const cast = v ? Object.values(v.votes || {}).filter((id) => ids.has(id)).length : 0;
    if (cast > 0) return { ok: true, via: 'vote', why: '' };
    return { ok: false, via: null, why: ids.size ? 'Vote for a course (or the host picks one) to start.' : 'The host needs to pick a course.' };
  }
  // Trim/collapse/clip a chat draft before sending — mirrors the relay's own cleanup
  // (race/PROTOCOL.md: control chars become separators, whitespace runs collapse, CHAT_MAX_CHARS
  // = 240) so the compose box doesn't surprise the sender with what actually goes out. The relay
  // remains the real enforcement point; this is purely a UX nicety.
  function sanitizeChatDraft(raw) {
    return String(raw == null ? '' : raw)
      .replace(/[\r\n\t]/g, ' ')
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 240);
  }

  // Where to put racer `index` (its position in start.racers, 0-based) so that holding
  // FLY_TO_START_SPEED_MS and the gate1->gate2 heading brings it to gate 1 roughly at GO:
  // speedMs*leadS metres behind gate 1 on the reverse bearing, staggered 80 m laterally (centered
  // on the centerline, so a field of racers fans out both sides of it) and 30 m vertically by
  // index so nobody spawns stacked on top of someone else.
  function gridSlot(gate1, gate2, index, n, leadS, speedMs) {
    const heading = bearingDeg(gate1, gate2);
    const behindM = Math.max(0, (+speedMs || 0) * (+leadS || 0));
    const base = destination(gate1, (heading + 180) % 360, behindM);
    const center = (Math.max(1, +n || 1) - 1) / 2;
    const lateral = (index - center) * 80;
    const perp = (heading + (lateral >= 0 ? 90 : -90)) % 360;
    const slot = destination(base, perp, Math.abs(lateral));
    return { lat: slot.lat, lon: slot.lon, alt: gate1.alt + index * 30, heading };
  }
  // Great-circle distance between two {lat, lon} points, metres. Used only for display (the
  // Launch grid list's "X km back" per pilot) — never fed back into a physics write.
  function haversineM(a, b) {
    const f1 = a.lat * D2R, f2 = b.lat * D2R, df = (b.lat - a.lat) * D2R, dl = (b.lon - a.lon) * D2R;
    const s = Math.sin(df / 2) ** 2 + Math.cos(f1) * Math.cos(f2) * Math.sin(dl / 2) ** 2;
    return 6371008.8 * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
  }
  // The Launch screen's grid list: each racer's real gridSlot() (unchanged physics/placement
  // math — see README "Fly to start"/"Writing to the aircraft") plus a real distance-to-gate-1
  // and a Set/Moving status. "Set" means the relay has sent at least one `pos` for that callsign
  // since this countdown armed (`seenPos`, a Set<string> the caller maintains and clears on every
  // new race_id); "Moving" until then. Pure — no live position is invented.
  function launchGridRows(racers, gate1, gate2, leadS, speedMs, seenPos) {
    if (!Array.isArray(racers) || !gate1 || !gate2) return [];
    const n = racers.length;
    return racers.map((callsign, i) => {
      const slot = gridSlot(gate1, gate2, i, n, leadS, speedMs);
      return { callsign, index: i, slot, distanceM: haversineM(gate1, slot),
        status: (seenPos && seenPos.has(callsign)) ? 'set' : 'moving' };
    });
  }
  // Ready / Away / Not-ready (task spec): the race-socket protocol only has a boolean `ready`.
  // Away is composed from a real second signal — the hub's presence row for the same callsign
  // reporting `activity === 'idle'` for at least `thresholdMs` (app.py's presence_rows(), proto 5)
  // — rather than invented. A player with no matching presence row (hub down, or they never
  // opened it) can only ever read as ready/not_ready, never away.
  function awayState(player, presenceRow, thresholdMs) {
    if (!player) return 'not_ready';
    if (player.ready) return 'ready';
    if (presenceRow && presenceRow.activity === 'idle' && (presenceRow.idle_seconds * 1000) >= thresholdMs) return 'away';
    return 'not_ready';
  }
  // Client-only convenience layered on the existing force-start frame (race/PROTOCOL.md `start`):
  // once every non-away player has been ready for `debounceMs` straight, the host's client may
  // fire start{force:true} itself instead of waiting for a click — an away pilot simply falls out
  // the same way a not-ready one already does under force-start (becomes a spectator for that
  // race), so this adds no new server behavior. `everyoneReadyForMs` is how long the "all non-away
  // ready" condition has held, tracked by the caller; null/0 means "not held at all yet".
  function autoStartDecision(players, awayByCallsign, everyoneReadyForMs, debounceMs) {
    if (!Array.isArray(players) || !players.length) return false;
    const engaged = players.filter((p) => (awayByCallsign && awayByCallsign[p.callsign]) !== 'away');
    if (!engaged.length || !engaged.every((p) => p.ready)) return false;
    return Number.isFinite(everyoneReadyForMs) && everyoneReadyForMs >= (+debounceMs || 0);
  }

  // ------------------------------------------------------------ results (proto 4, pure)
  // race/PROTOCOL.md "Proto 4: results and cups". Everything down to the Countdown is a pure
  // function of its arguments — no socket, no clock, no DOM, no Race — so race/test/run.js drives it
  // with plain objects, the way the lobby* and powerups* functions are tested. The Results module
  // (after Lobby) is the impure half that owns the state, the frames and the overlay.

  const RESULT_ITEMS = ['banana', 'goop', 'missile', 'boost', 'shield'];
  const AWARD_LABELS = { most_hits_taken: 'Most hits taken', sharpshooter: 'Sharpshooter',
    biggest_comeback: 'Biggest comeback', fastest_sector: 'Fastest sector', clean_race: 'Clean race',
    jump_starter: 'Jump starter' };
  // The relay closes the socket on a frame over 2048 bytes, and a finish carrying every split a
  // 200-gate course can have is about 1.95 KB. Past this a finish is sent without its splits — the
  // relay only wants them for the fastest-sector award, and the frame carries that number itself.
  const FINISH_FRAME_MAX_BYTES = 1800;
  const MAX_RESULT_ROWS = 16;

  function ordinalOf(n) {
    const v = Math.round(+n) || 0, t = v % 100;
    return v + (t >= 11 && t <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' })[v % 10] || 'th');
  }

  // The shortest gate-to-gate leg. Splits are cumulative from the gate-1 crossing, so the first
  // leg is splits[0] itself. null when there is nothing to measure.
  function bestSectorMs(splits) {
    let best = null, prev = 0;
    for (const s of Array.isArray(splits) ? splits : []) {
      const leg = Math.round(+s) - prev;
      prev = Math.round(+s);
      if (Number.isFinite(leg) && leg > 0 && (best === null || leg < best)) best = leg;
    }
    return best;
  }

  // The lobby-race clock (Race.goElapsed) at the moment of the finishing crossing itself. goElapsed
  // is read at the top of the frame the finish was detected in, while detectGates() interpolates the
  // crossing to somewhere inside that frame: `elapsed - finalMs` is how far short of the frame's end
  // the crossing really was, so taking it back off gives the crossing rather than the frame edge —
  // which is what decides a close finish between two pilots on different frame rates. It is the
  // DIFFERENCE of two clocks and not either alone on purpose: only `elapsed` stops while paused.
  function finishGoTimeMs(goElapsed, elapsed, finalMs) {
    if (![goElapsed, elapsed, finalMs].every(Number.isFinite)) return NaN;
    return Math.max(1, Math.min(21600000, Math.round(goElapsed - Math.max(0, elapsed - finalMs))));
  }

  // The `finish` frame. go_time_ms is on the lobby-race clock (jump-start penalty already in it);
  // the leaderboard's gate-1 clock is a separate number that POST /runs still carries.
  function finishFrame(raceId, goTimeMs, splits, jumpStartMs) {
    const clean = (Array.isArray(splits) ? splits : []).map((x) => Math.round(+x))
      .filter((x) => Number.isFinite(x) && x >= 0 && x <= 21600000).slice(0, 200);
    const best = bestSectorMs(clean);
    const frame = { type: 'finish', race_id: Math.max(0, Math.round(+raceId) || 0), go_time_ms: Math.max(1, Math.min(21600000, Math.round(+goTimeMs) || 1)),
      splits: clean, jump_start: (+jumpStartMs || 0) > 0 };
    if (best !== null) frame.best_sector_ms = best;
    if (JSON.stringify(frame).length > FINISH_FRAME_MAX_BYTES) delete frame.splits;
    return frame;
  }
  const dnfFrame = (raceId, gate) => ({ type: 'dnf', race_id: Math.max(0, Math.round(+raceId) || 0),
    gate: Math.max(0, Math.min(201, Math.round(+gate) || 0)) });

  // ---- receiving: rows and cups arrive off a socket, so every field is checked and clamped.
  function cleanResultRow(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const callsign = typeof raw.callsign === 'string' ? raw.callsign.slice(0, 32) : '';
    const pos = Math.round(+raw.pos);
    const status = raw.status === 'finished' || raw.status === 'dnf' ? raw.status : null;
    if (!callsign || !Number.isFinite(pos) || pos < 1 || !status) return null;
    const num = (v) => (v === null || v === undefined || !Number.isFinite(+v) ? null : Math.round(+v));
    const items = {};
    if (raw.items_used && typeof raw.items_used === 'object') {
      for (const k of RESULT_ITEMS) { const n = Math.round(+raw.items_used[k]); if (n > 0) items[k] = Math.min(n, 999); }
    }
    return { pos, callsign, model: typeof raw.model === 'string' ? raw.model.slice(0, 32) : '', status,
      go_time_ms: status === 'finished' ? num(raw.go_time_ms) : null, gap_ms: status === 'finished' ? num(raw.gap_ms) : null,
      points: num(raw.points), items_used: items, hits_taken: Math.max(0, num(raw.hits_taken) || 0),
      jump_start: raw.jump_start === true, gate: num(raw.gate) };
  }
  function cleanResultCup(raw) {
    const c = lobbyCup(raw);
    if (!c) return null;
    const standings = (Array.isArray(raw.standings) ? raw.standings : []).slice(0, MAX_RESULT_ROWS)
      .map((x) => (x && typeof x.callsign === 'string' && Number.isFinite(+x.points) ? { callsign: x.callsign.slice(0, 32), points: Math.round(+x.points) } : null))
      .filter(Boolean);
    return { ...c, standings };
  }
  function cleanAwards(raw) {
    return (Array.isArray(raw) ? raw : []).slice(0, 12)
      .filter((a) => a && typeof a.key === 'string' && typeof a.callsign === 'string')
      .map((a) => ({ key: a.key.slice(0, 32), callsign: a.callsign.slice(0, 32), detail: typeof a.detail === 'string' ? a.detail.slice(0, 48) : '' }));
  }

  // The results overlay's state. kind: 'none' | 'progress' (finishers so far, others still flying)
  // | 'final' (the relay's `results`) | 'local' (no shared results — see localResultsState).
  function resultsInitialState() {
    return { kind: 'none', raceId: 0, rows: [], waiting: [], deadlineServerMs: 0, course: null, awards: [], cup: null };
  }
  function resultsReduce(state, frame) {
    const s = state || resultsInitialState();
    if (!frame || typeof frame !== 'object') return s;
    if (frame.type !== 'results_progress' && frame.type !== 'results') return s;
    const raceId = Math.round(+frame.race_id);
    if (!Number.isFinite(raceId) || raceId < 0) return s;
    const rows = (Array.isArray(frame.rows) ? frame.rows : []).slice(0, MAX_RESULT_ROWS).map(cleanResultRow).filter(Boolean);
    if (frame.type === 'results_progress') {
      // A progress frame that turns up after the final one, or for an older race, must not undo it.
      if (s.raceId > raceId || (s.kind === 'final' && s.raceId === raceId)) return s;
      return { ...resultsInitialState(), kind: 'progress', raceId, rows,
        waiting: (Array.isArray(frame.waiting) ? frame.waiting : []).filter((x) => typeof x === 'string').map((x) => x.slice(0, 32)).slice(0, MAX_RESULT_ROWS),
        deadlineServerMs: Math.max(0, +frame.deadline_server_ms || 0) };
    }
    if (s.raceId > raceId) return s;
    const c = frame.course && typeof frame.course === 'object' ? frame.course : {};
    return { kind: 'final', raceId, rows, waiting: [], deadlineServerMs: 0,
      course: { course_id: String(c.course_id || '').slice(0, 64), course_hash: String(c.course_hash || '').slice(0, 8), name: String(c.name || '').slice(0, 48) },
      awards: cleanAwards(frame.awards), cup: cleanResultCup(frame.cup) };
  }

  // Display rows for the table. `waiting` names pilots who have no result yet (progress state): they
  // get a placeholder row so the table fills in rather than growing from nothing. Points read "+15";
  // a relay with no points at all (the local card) leaves the column blank.
  function resultsRows(rows, myCallsign, waiting) {
    const out = (Array.isArray(rows) ? rows : []).map((r) => {
      const fin = r.status === 'finished';
      const items = RESULT_ITEMS.reduce((n, k) => n + (r.items_used && +r.items_used[k] > 0 ? +r.items_used[k] : 0), 0);
      return { pos: r.pos, callsign: r.callsign, model: r.model || '', isMe: r.callsign === myCallsign,
        isWinner: fin && r.pos === 1, status: r.status, waiting: false,
        time: fin ? fmt(r.go_time_ms) : r.status === 'dnf' ? 'DNF' : '',
        gap: fin && r.pos > 1 && Number.isFinite(r.gap_ms) ? fmtDelta(r.gap_ms) : '',
        items: items ? String(items) : '–',
        points: Number.isFinite(r.points) ? (r.points > 0 ? '+' + r.points : '0') : '',
        jumpStart: !!r.jump_start, dnfGate: r.status === 'dnf' && Number.isFinite(r.gate) ? r.gate : null };
    });
    for (const cs of Array.isArray(waiting) ? waiting : []) {
      out.push({ pos: null, callsign: cs, model: '', isMe: cs === myCallsign, isWinner: false, status: 'waiting', waiting: true,
        time: '…', gap: '', items: '', points: '', jumpStart: false, dnfGate: null });
    }
    return out;
  }

  // "Steve wins" / "You win!" and the winner's time. `kind` 'local' has no winner to name — only
  // where this pilot stood when they crossed the line.
  function resultsHeadline(rows, myCallsign, kind) {
    const list = Array.isArray(rows) ? rows : [];
    if (kind === 'local') {
      const me = list.find((r) => r.callsign === myCallsign);
      return { text: me ? 'You finished ' + ordinalOf(me.pos) + (list.length > 1 ? ' of ' + list.length : '') : 'Race over',
        sub: 'Your standing as you crossed the line — this relay has no shared results.', winner: null, iWon: false };
    }
    const w = list.find((r) => r.status === 'finished' && r.pos === 1);
    if (!w) return { text: list.length ? 'Nobody finished' : 'Race over', sub: '', winner: null, iWon: false };
    const iWon = w.callsign === myCallsign;
    return { text: iWon ? 'You win!' : w.callsign + ' wins', sub: fmt(w.go_time_ms) + (w.model ? ' · ' + w.model : ''), winner: w.callsign, iWon };
  }

  // "waiting for 2 pilots (01:42)" — the live state a finisher sees while others are still flying.
  function resultsWaitingText(n, remainingMs) {
    const left = Math.max(0, Math.ceil((+remainingMs || 0) / 1000));
    const count = Math.max(0, Math.round(+n) || 0);
    return 'waiting for ' + count + ' pilot' + (count === 1 ? '' : 's') + ' (' +
      String(Math.floor(left / 60)).padStart(2, '0') + ':' + String(left % 60).padStart(2, '0') + ')';
  }

  // "New course record": the winner's run is the top of the board AND was posted after this race's
  // GO. The results frame carries the lobby clock, not the winner's gate-1 time (the number the board
  // holds), so the board is asked instead: the record row is the winner's, and its created_at (the
  // relay's own clock, seconds) is later than the race's start_at_server_ms. A record the winner
  // already held, or somebody else's, is not "new" — and a run that failed to post just means no badge.
  function newRecordBadge(winner, boardRows, startAtServerMs) {
    const top = Array.isArray(boardRows) ? boardRows[0] : null;
    if (!winner || !top || top.callsign !== winner || !Number.isFinite(+top.created_at) || !Number.isFinite(+startAtServerMs)) return false;
    return +top.created_at * 1000 >= +startAtServerMs - 1000;
  }

  // The card for a lobby race on a relay with no shared results (proto < 4): whatever the standings
  // frame last said about the order, and this pilot's own time. No points, no awards, no cup.
  function localResultsState(standings, myCallsign, timeMs, model, raceId) {
    const order = (Array.isArray(standings) ? standings : []).filter((x) => typeof x === 'string').slice(0, MAX_RESULT_ROWS);
    if (!order.includes(myCallsign)) order.push(myCallsign);
    const rows = order.map((cs, i) => ({ pos: i + 1, callsign: cs, model: cs === myCallsign ? String(model || '') : '',
      status: cs === myCallsign ? 'finished' : 'standing', go_time_ms: cs === myCallsign ? timeMs : null, gap_ms: null,
      points: null, items_used: {}, hits_taken: 0, jump_start: false, gate: null }));
    return { ...resultsInitialState(), kind: 'local', raceId: Math.max(0, Math.round(+raceId) || 0), rows };
  }

  // -------------------------------------------------------------- countdown
  // A local, wall-clock-synced "launch" cue (Phase 4, README "Racing an air-start course").
  // Deliberately NOT wired into Race at all beyond reading Race.course to refuse arming with
  // nothing loaded — it never reads or writes Race.state/elapsed/splits, so it can't alter
  // the authoritative, crossing-based timing. There is no network layer here: the host arms a
  // target either N seconds from now, or a specific wall-clock time announced out loud/in chat,
  // and each friend arms their own client to that same target (arm() takes an epoch-ms target,
  // so any client hitting the same moment converges on the same "go").
  const Countdown = {
    target: 0, state: 'idle', timer: 0, listeners: [],
    on(fn) { this.listeners.push(fn); },
    emit(ev, data) { for (const fn of this.listeners) { try { fn(ev, data); } catch (e) { console.error('[finsRace]', e); } } },

    arm(targetMs) {
      if (!Race.course) return false;
      clearTimeout(this.timer);
      this.target = targetMs;
      this.state = 'armed';
      this.emit('armed', this.target);
      this._tick();
      return true;
    },
    armIn(leadS) { return this.arm(Date.now() + Math.max(0, +leadS || 0) * 1000); },
    abort() {
      clearTimeout(this.timer);
      if (this.state === 'idle') return;
      this.state = 'idle';
      this.emit('abort');
    },
    _tick() {
      if (this.state !== 'armed') return;
      const remain = this.target - Date.now();
      if (remain <= 0) { this.state = 'go'; this.emit('go'); return; }
      this.emit('tick', remain);
      this.timer = setTimeout(() => this._tick(), Math.min(remain, 200));
    },
  };

  // --------------------------------------------------------- fly to start
  // Put the player on gate 1, pointed at gate 2, already flying. This is the missing piece for
  // "air" courses, whose first gate is nowhere near a spawn point (README "Racing an air-start
  // course"): without it everyone has to fly out from an airport and converge by eye.
  //
  // It reuses the write path Boost is on — G.repositionViaReset() first, raw state writes as the
  // fallback, then the confirmed speed scalars, then the velocity vector only if
  // CONFIG.VELOCITY_FRAME has been recorded (see README "Writing to the aircraft"). The vector
  // math is not duplicated here; velocityFromReference() is the one place it lives.
  //
  // Timing is untouched: repositioning is a teleport, and Race's start detector already ignores
  // a jump (detectStart's `jumped` guard), so this can neither start nor DQ a run. It re-arms
  // first so a reposition mid-run doesn't leave a half-finished run on the clock.
  const FlyToStart = {
    available() {
      const c = Race.course;
      return !!(c && c.startType === 'air' && Array.isArray(c.gates) && c.gates.length >= 2);
    },
    // Where to put the player: gate 1, facing gate 2, at a flying speed.
    target() {
      if (!this.available()) return null;
      const [g1, g2] = Race.course.gates;
      const speed = Math.max(0, Math.min(G.speedCap(), +CONFIG.FLY_TO_START_SPEED_MS || 0));
      return { lat: g1.lat, lon: g1.lon, alt: g1.alt, heading: bearingDeg(g1, g2), speed };
    },
    run(now) {
      if (!Race.course) return { ok: false, detail: 'Load a course first.' };
      if (!this.available()) return { ok: false, detail: 'Fly to start is for air-start courses with at least 2 gates.' };
      if (!G.ready()) return { ok: false, detail: 'GeoFS is still loading.' };
      const t = this.target();
      if (!t || !Number.isFinite(t.heading)) return { ok: false, detail: 'Could not work out a bearing from gate 1 to gate 2.' };

      Race.reset();
      const how = G.repositionViaReset(t) ? 'resetFlight' : G.repositionByState(t) ? 'state writes' : null;
      if (!how) return { ok: false, detail: 'Could not reposition: neither geofs.resetFlight nor llaLocation took the write.' };

      // Both paths can leave you at rest, so the speed writes go last — the whole point is not
      // to arrive stalled.
      const heading = G.setHeading(t.heading);
      const speed = G.accelerateTo(t.speed);
      const vector = speed.vector || G.setVelocityFromFrame(t.speed);
      if (!vector) G.logVelocityFrame('flyToStart', now);
      return { ok: true, how, heading, scalar: speed.scalar, vector, target: t };
    },
  };

  // ------------------------------------------------------------- powerups
  // Two halves, and the first works without the second:
  //
  //  1. Loadout (no relay): pick 2 self-only defensive items — Boost and/or Shield, duplicates
  //     allowed — before a race. Both act purely on your own aircraft, so they work even with
  //     the relay down or CONFIG.API_BASE empty ("loadout-only mode").
  //  2. Contested boxes + offensive items (needs the relay, see race/server/app.py): flying
  //     through one of the course's item boxes asks the relay for an item; the relay is
  //     authoritative for the roll (weighted so the back of the pack gets better odds), for who
  //     a fired offensive item hits, and (proto 3) for WHEN it hits. Incoming hits are applied
  //     by THIS client to ITSELF, time-boxed and auto-recovering, and Shield is honored here on
  //     receipt as well as by the relay's own shield window — see app.py's relay header for why
  //     that stopped being purely a client concern once hits became deferred.
  //  3. Seeing it happen (proto 3, the `Items` module below): projectiles, bananas, boost
  //     trails, shield bubbles, splats. Entirely additive, entirely gated on Relay.proto >= 3,
  //     and none of it changes what an item does — only whether you can watch it coming.
  //
  // Slots: [0] and [1] are the loadout picks (Alt+1/Alt+2), refilled whenever the race re-arms.
  // [2] is the box slot (Alt+3): only the relay ever fills it, and a new grant overwrites it.
  //
  // All timing/state transitions are pure functions of an explicit `now` (never Date.now()/
  // performance.now() read internally), so race/test/run.js can drive them with a fake clock
  // with no live GeoFS/DOM required. The stateful Powerups object below is a thin wrapper that
  // supplies real clock values at the two places time actually enters the system: a keypress
  // (which reads the shared clockNow(), i.e. the loop's own timestamp) and the
  // per-frame tick (passed the loop's own `now`).
  const POWERUP_ITEMS = ['boost', 'shield'];                  // the loadout pool
  const POWERUP_HIT_ITEMS = ['banana', 'missile', 'goop'];    // relay-only, applied to the victim
  const POWERUP_BOX_SLOT = 2;
  const POWERUP_LABELS = { boost: 'Boost', shield: 'Shield', banana: 'Banana', missile: 'Mustard missile', goop: 'Goop', nothing: 'Nothing' };
  function powerupDurations() {
    return {
      boost: CONFIG.POWERUP_BOOST_MS, shield: CONFIG.POWERUP_SHIELD_MS,
      banana: CONFIG.POWERUP_BANANA_MS, missile: CONFIG.POWERUP_MISSILE_MS, goop: CONFIG.POWERUP_GOOP_MS,
    };
  }
  function powerupsInitialState(loadout) {
    const picks = (Array.isArray(loadout) ? loadout : []).filter((x) => POWERUP_ITEMS.includes(x)).slice(0, 2);
    while (picks.length < 2) picks.push('boost');
    return { loadout: picks.slice(), slots: [picks[0], picks[1], null], effects: {} };
  }
  function powerupsRefill(state) { return { ...state, slots: [state.loadout[0], state.loadout[1], null] }; }
  function powerupsPrune(state, now) {
    const effects = {};
    for (const k of Object.keys(state.effects)) if (state.effects[k] > now) effects[k] = state.effects[k];
    return { ...state, effects };
  }
  // A relay grant always lands in the box slot, replacing whatever was there. "nothing" is a
  // real roll outcome (the leader's most likely one) and just empties the slot.
  function powerupsGrant(state, item) {
    const slots = state.slots.slice();
    slots[POWERUP_BOX_SLOT] = POWERUP_ITEMS.includes(item) || POWERUP_HIT_ITEMS.includes(item) ? item : null;
    return { ...state, slots };
  }
  function powerupsUse(state, slotIndex, now, durationsMs) {
    const item = state.slots[slotIndex];
    if (!item) return { state, item: null };
    const slots = state.slots.slice();
    slots[slotIndex] = null;
    const effects = { ...state.effects };
    // Self items arm their own effect here. Offensive items don't: the relay decides who they
    // hit, so using one only consumes the slot and the caller sends a "fire".
    if (POWERUP_ITEMS.includes(item)) effects[item] = now + (durationsMs[item] || 0);
    return { state: { ...state, slots, effects }, item };
  }
  // An incoming, relay-adjudicated hit. Shield blocks it outright and is consumed in the sense
  // that it keeps running — it just eats this hit. Never applies an unknown item.
  function powerupsHit(state, item, now, durationsMs) {
    if (!POWERUP_HIT_ITEMS.includes(item)) return { state, blocked: false, applied: false };
    if (powerupsActive(state, 'shield', now)) return { state, blocked: true, applied: false };
    const effects = { ...state.effects, [item]: now + (durationsMs[item] || 0) };
    return { state: { ...state, effects }, blocked: false, applied: true };
  }
  function powerupsActive(state, item, now) { return Number.isFinite(state.effects[item]) && state.effects[item] > now; }
  function powerupsBoostedSpeed(baseSpeedMs, addMs, maxSpeedMs) {
    return Math.min(maxSpeedMs, Math.max(0, baseSpeedMs) + Math.max(0, addMs));
  }
  // Which screen effect classes should be live right now. Pure so the overlay is testable.
  function powerupsActiveEffects(state, now) {
    return [...POWERUP_ITEMS, ...POWERUP_HIT_ITEMS].filter((i) => powerupsActive(state, i, now));
  }
  // wss:// URL for the relay, derived from the same CONFIG.API_BASE the leaderboard uses.
  // Empty API_BASE => null => loadout-only mode.
  function powerupsRelayUrl(apiBase, room) {
    if (!apiBase || !room) return null;
    return apiBase.replace(/\/$/, '').replace(/^http/i, 'ws') + '/ws/race/' + room;
  }
  // wss:// URL for the matchmaking hub (race/PROTOCOL.md "Proto 5", WS /ws/hub) — no room, since
  // the hub is one socket shared by the whole panel, not per-race. Same empty-API_BASE => null
  // convention as powerupsRelayUrl.
  function hubUrl(apiBase) {
    if (!apiBase) return null;
    return apiBase.replace(/\/$/, '').replace(/^http/i, 'ws') + '/ws/hub';
  }
  // Rooms must match the relay's own ^[a-z0-9-]{1,32}$. A course hash already does; a
  // hand-typed code gets slugged into shape.
  function powerupsRoom(code, courseHash) {
    const c = code ? slug(code).slice(0, 32) : '';
    return c || (courseHash ? String(courseHash).slice(0, 32) : '');
  }

  // --------------------------------------------------------------- debug log
  // CONFIG.DEBUG / Alt+D (lobby reliability pass). This half is the log every lobby path writes
  // to; the overlay that shows it is Debug.render() further down, next to the Shell. Frames are
  // recorded by TYPE only — never a payload, so a chat line never reaches the console or the
  // overlay. High-rate types (pos/standings/world/ping/pong/heartbeat) are counted, not logged.
  const DEBUG_QUIET_TYPES = new Set(['pos', 'standings', 'world', 'ping', 'pong', 'heartbeat']);
  const Debug = {
    on: false, events: [], counts: { out: {}, in: {}, 'hub-out': {}, 'hub-in': {} },
    facts: {},     // latest value of each labelled fact: clock offset, GO time, grid slot, teleport…
    log(kind, detail) {
      const ev = { t: Date.now(), kind: String(kind), detail: detail == null ? '' : String(detail) };
      this.events.push(ev);
      if (this.events.length > 200) this.events.shift();
      if (this.on) console.info('[finsRace debug] ' + ev.kind + (ev.detail ? ': ' + ev.detail : ''));
      if (this.on && this.render) this.render();
    },
    fact(key, value) {
      this.facts[key] = value;
      this.log(key, typeof value === 'object' ? JSON.stringify(value) : value);
    },
    frame(dir, msg) {
      const type = String((msg && msg.type) || '?');
      const bucket = this.counts[dir] || (this.counts[dir] = {});
      bucket[type] = (bucket[type] || 0) + 1;
      if (!DEBUG_QUIET_TYPES.has(type)) this.log('frame ' + dir, type);
    },
    teardown() { this.on = false; },
  };

  // The relay socket. Nothing here touches GeoFS, and every path fails closed: any throw, any
  // failed connect, any malformed frame leaves the race running in loadout-only mode. It never
  // calls into Race, only into Powerups (which is itself guarded).
  const Relay = {
    ws: null, room: '', status: '', attempts: 0, timer: 0, wantOpen: false,
    // `positions` is the optional half of the standings frame (race/PROTOCOL.md): a relay old
    // enough to send `order` alone leaves this empty, and the minimap then simply draws no
    // other racers. It is never trusted for anything but a dot on a map.
    connected: false, standings: [], positions: null,
    // Proto 3 (race/PROTOCOL.md). `proto` is 0 until a real `joined` proves what the server
    // speaks — never guessed — and every items feature is gated on it being >= 3, so an older
    // relay leaves this client behaving exactly like 0.9.0. `world` is the relay's twice-a-second
    // view of where everyone is: { callsign: {lat, lon, alt, gate} }, used only when GeoFS's own
    // multiplayer positions can't be matched to a callsign.
    proto: 0, world: null,

    enabled() { return !!CONFIG.API_BASE; },

    // opts.spectate (proto 5): join to watch, never to race — see the `join` frame below and
    // race/PROTOCOL.md "Spectating".
    spectate: false,
    // Returns true only when a socket was actually opened. Every caller that puts the pilot on a
    // room screen checks it: before 1.3.1 these guards returned undefined and set a `status` string
    // nobody rendered, so a misconfigured client answered "+ New room" with total silence — no
    // socket, no console line, no message — which is what made it undiagnosable from DevTools.
    connect(room, opts) {
      if (!CONFIG.POWERUPS) { this.status = 'Loadout-only: powerups/relay are off (CONFIG.POWERUPS).'; return false; }
      if (!this.enabled()) {
        this.status = 'Loadout-only: no relay configured (CONFIG.API_BASE is empty).';
        console.warn('[finsRace] no relay configured (CONFIG.API_BASE is empty) — cannot join room', room);
        return false;
      }
      const url = powerupsRelayUrl(CONFIG.API_BASE, room);
      if (!url) {
        this.status = 'Loadout-only: no room to join yet.';
        console.warn('[finsRace] not a usable room code, refusing to connect:', room);
        return false;
      }
      this.wantOpen = true;
      this.room = room;
      this.spectate = !!(opts && opts.spectate);
      this._open(url);
      return true;
    },
    // Sockets this module has opened and not yet seen closed — the debug overlay's socket count,
    // and the thing the lobby reliability tests assert is never more than one.
    live: new Set(),
    // Every handler is removed BEFORE close(). Through 1.3.x disconnect() closed the old socket
    // with its handlers still attached: its late onclose then saw wantOpen=true (the next join
    // had already set it), scheduled a _retry on the OLD url, and that retry tore down the live
    // socket and opened another — churn that could leave two sockets in one room and drop clicks
    // (Relay.send only ever writes to this.ws).
    _detach(ws) {
      if (!ws) return;
      ws.onopen = null; ws.onmessage = null; ws.onerror = null; ws.onclose = null;
      this.live.delete(ws);
      try { ws.close(); } catch (_) {}
    },
    _open(url) {
      clearTimeout(this.timer);
      this._detach(this.ws);
      this.ws = null;
      try {
        const ws = new WebSocket(url);
        this.ws = ws;
        this.live.add(ws);
        this.status = 'Relay: connecting…';
        // Belt and braces on top of _detach(): a handler that somehow fires for a socket that is
        // no longer this.ws must not touch this module's state.
        ws.onopen = () => {
          if (ws !== this.ws) return;
          try {
            this.connected = true; this.attempts = 0;
            this.status = 'Relay: connected (' + this.room + ').';
            const join = { type: 'join', callsign: Powerups.callsign(), room: this.room };
            // Both additive per race/PROTOCOL.md "Proto 5" — an old relay ignores unknown fields.
            // client_proto (lobby reliability pass): what this client speaks, so the relay can
            // deliver free-text chat without waiting for proof. Before it, only a pilot_token marked
            // a proto-5 client, and a join that raced ahead of the hub's welcome had none, so that
            // pilot never received a typed line. An old relay ignores the unknown field.
            join.client_proto = REQUIRED_PROTO;
            const token = CONFIG.LOBBY_V2 ? (Hub.pilotToken || store.get('pilotToken', '')) : '';
            if (token) join.pilot_token = token;
            if (this.spectate) join.spectate = true;
            this.send(join);
            // Clock sync (proto 2) starts on the socket, not on `joined` — race/PROTOCOL.md's
            // `ping` is explicitly allowed before join, since it measures the round trip, not
            // the player. A proto-1 server never answers it; Lobby just never sees a `pong` and
            // stays gated off, same as if CONFIG.LOBBY were false.
            if (CONFIG.LOBBY) Lobby.startClockSync();
            UI.renderPowerups(clockNow());
          } catch (_) {}
        };
        ws.onmessage = (ev) => {
          if (ws !== this.ws) return;
          let msg;
          try { msg = JSON.parse(ev.data); } catch (_) { return; }
          Debug.frame('in', msg);
          try { Powerups.onRelayMessage(msg, clockNow()); }
          catch (e) { console.error('[finsRace] relay frame', msg && msg.type, e); }
          try { if (CONFIG.LOBBY) Lobby.onFrame(msg, clockNow()); }
          catch (e) { reportLobbyError('handling ' + (msg && msg.type) + ' from the relay', e); }
        };
        ws.onerror = () => { if (ws === this.ws) this.status = 'Relay: connection error — loadout-only for now.'; };
        ws.onclose = () => {
          this.live.delete(ws);
          if (ws !== this.ws) return;
          this.connected = false;
          if (!this.wantOpen) { this.status = 'Relay: disconnected.'; return; }
          this._retry(url);
        };
      } catch (e) {
        this.status = 'Loadout-only: relay unavailable (' + e.message + ').';
        this._retry(url);
      }
    },
    // Exponential backoff, capped. A permanently dead relay just means loadout-only forever.
    _retry(url) {
      if (!this.wantOpen) return;
      const wait = Math.min(CONFIG.POWERUP_RECONNECT_MS * Math.pow(2, this.attempts++), CONFIG.POWERUP_RECONNECT_MAX_MS);
      this.status = 'Relay: reconnecting in ' + Math.round(wait / 1000) + 's (loadout still works).';
      clearTimeout(this.timer);
      this.timer = setTimeout(() => { if (this.wantOpen) this._open(url); }, wait);
    },
    disconnect() {
      this.wantOpen = false;
      this.attempts = 0;
      this.standings = []; this.positions = null; this.world = null; this.proto = 0;
      clearTimeout(this.timer);
      this._detach(this.ws);
      this.ws = null;
      this.connected = false;
      this.status = this.enabled() ? 'Relay: idle (connects when a race starts).' : 'Loadout-only: no relay configured (CONFIG.API_BASE is empty).';
      if (CONFIG.LOBBY) Lobby.reset();
    },
    send(obj) {
      try {
        if (!this.ws || this.ws.readyState !== 1) return false;
        this.ws.send(JSON.stringify(obj));
        Debug.frame('out', obj);
        return true;
      } catch (_) { return false; }
    },
  };

  // Any error thrown while handling a lobby control or a lobby frame lands here: always a console
  // error with the stack, and a visible toast once the shell exists. Never swallowed — a silent
  // catch around a click handler is exactly what made the 1.3.x "Ready does nothing" undiagnosable.
  function reportLobbyError(what, e) {
    console.error('[finsRace] lobby error while ' + what, e);
    try { if (CONFIG.LOBBY_V2 && Shell.E.shell) Shell.toast('Something went wrong ' + what + ': ' + ((e && e.message) || e), 'error'); }
    catch (_) {}
  }

  // A fixed, closed set (race/PROTOCOL.md `chat`) — never free text, so the relay can't be used
  // to pass arbitrary strings between clients.
  const CHAT_CODES = ['ready_soon', 'need_2_min', 'gg', 'rematch', 'brb', 'boss_incoming'];
  const CHAT_LABELS = { ready_soon: 'Ready soon', need_2_min: 'Need 2 min', gg: 'GG',
    rematch: 'Rematch?', brb: 'BRB', boss_incoming: 'Boss incoming!' };

  // The relay lobby (proto 2, race/PROTOCOL.md "Proto 2: lobby"). Wraps Relay the same way
  // Powerups does: every method fails closed, nothing here can throw into the race loop, and a
  // proto-1 (or absent) relay just means this module never has anything to show — CONFIG.LOBBY
  // gates whether it's even wired up at all (see the Race-bus subscriber near boot()).
  // The relay proto this client's lobby needs in full (free-text chat, spectating, the course vote
  // — race/PROTOCOL.md "Proto 5"). A lower `joined.proto` still gets the lobby it can support, but
  // never silently: the shell shows a persistent "Server proto X, client needs Y" banner.
  const REQUIRED_PROTO = 5;

  const Lobby = {
    state: lobbyInitialState(),
    proto: 0, joinedSeen: false, offsetMs: null, pingSamples: [], resyncTimer: 0,
    ready: false, countdownArmedFor: null, sentHelloFor: '',
    _prevReady: {}, _prevAllReady: false,

    reset() {
      this.state = lobbyInitialState();
      this.proto = 0; this.joinedSeen = false; this.offsetMs = null; this.pingSamples = [];
      clearTimeout(this.resyncTimer); this.resyncTimer = 0;
      this.ready = false; this.countdownArmedFor = null; this.sentHelloFor = '';
      this._prevReady = {}; this._prevAllReady = false;
      Countdown.abort();
      if (CONFIG.RESULTS) Results.clear();
      UI.applyLegacyGates();
      if (CONFIG.LOBBY_V2) Shell.renderProtoBanner();
    },
    // True once a server old enough to lack the lobby entirely has actually proven that (a real
    // `joined` came back with no/low proto) — never guessed before the first `joined` arrives,
    // which would flash the "no lobby" note for the split second before the answer is known.
    isOldServer() { return this.joinedSeen && this.proto < 2; },

    // ---- clock sync: 5 pings 200 ms apart on connect, then a fresh round every 60 s. Each round
    // starts its own sample window rather than accumulating forever, so a stale sample from
    // minutes ago (taken under different network conditions) can't outvote a fresh one.
    startClockSync() {
      this.pingSamples = [];
      for (let i = 0; i < 5; i++) setTimeout(() => this._ping(), i * 200);
      clearTimeout(this.resyncTimer);
      this.resyncTimer = setTimeout(() => this.startClockSync(), 60000);
    },
    _ping() { Relay.send({ type: 'ping', t0: Date.now() }); },
    _onPong(msg) {
      const t0 = +msg.t0, server_ms = +msg.server_ms;
      if (!Number.isFinite(t0) || !Number.isFinite(server_ms)) return;
      this.pingSamples.push({ t0, t1: Date.now(), server_ms });
      if (this.pingSamples.length > 10) this.pingSamples.shift();
      const off = clockOffset(this.pingSamples);
      if (off == null) return;
      const first = this.offsetMs == null;
      this.offsetMs = off;
      Debug.fact('clock offset ms', Math.round(off));
      // A start that armed before ANY pong (a fresh socket, or one right after a reconnect) was
      // armed on the raw server clock, off by the whole skew — 1.8 s on 2026-09-23. Re-arm it on
      // the first real offset. The grid is not moved again: that teleport has already happened.
      const st = this.state.start;
      if (first && st && this._armedUnsynced === st.raceId && Countdown.state === 'armed') {
        const localAt = this.toLocalMs(st.startAtServerMs);
        Countdown.arm(localAt);
        Race.armGo(localAt);
        Debug.fact('GO local ms (re-armed after first pong)', localAt);
      }
      this._armedUnsynced = null;
    },
    // A relay server_ms turned into this client's own Date.now()-comparable epoch — what
    // Countdown.arm() and Race.armGo() both expect. Falls back to the raw server value before the
    // first pong lands; _onPong() re-arms a countdown that was armed on that fallback.
    toLocalMs(serverMs) { return serverToLocalMs(serverMs, this.offsetMs); },
    _armedUnsynced: null,

    isHost() { return !!this.state.host && this.state.host === Powerups.callsign(); },
    me() { return this.state.players.find((p) => p.callsign === Powerups.callsign()) || null; },
    isSpectator() { const m = this.me(); return !!m && m.role === 'spectator'; },
    allReady() { return this.state.players.length > 0 && this.state.players.every((p) => p.ready); },
    // Visible once the server has proven it speaks proto 2 (a real `pong`/`joined` with proto>=2
    // arrived) — never merely because CONFIG.LOBBY is on, which only gates whether this module
    // is wired up at all, not whether the server can back it.
    active() { return CONFIG.LOBBY && this.proto >= 2; },

    // ---- relay -> client
    onFrame(msg, now) {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'joined') return this._onJoined(msg);
      if (msg.type === 'pong') return this._onPong(msg);
      if (msg.type === 'lobby') return this._onLobby(msg);
      if (msg.type === 'start') return this._onStart(msg);
      if (msg.type === 'abort') {
        this.state = lobbyReduce(this.state, msg); Countdown.abort(); UI.renderLobby();
        if (CONFIG.LOBBY_V2 && Shell.screen === 'launch') Shell.setScreen('gate');
        return;
      }
      if (msg.type === 'results_progress' || msg.type === 'results') { if (CONFIG.RESULTS) Results.onFrame(msg, now); return; }
      // The relay's course vote (race/PROTOCOL.md "Course vote"). lobbyReduce() has handled this
      // frame since it was written and is unit-tested, but nothing ever routed one into it — so
      // through 1.3.0 every `vote` frame was dropped here and the Gate's vote tiles could never
      // appear, however well the server drew its candidates. Additive and gated the same way the
      // outgoing vote() is: a relay below proto 5 never sends one.
      if (msg.type === 'vote') {
        this.state = lobbyReduce(this.state, msg);
        if (CONFIG.LOBBY_V2 && Shell.screen === 'gate') Shell.renderGate();
        UI.renderLobby();
        return;
      }
      if (msg.type === 'chat') {
        this.state = lobbyReduce(this.state, msg);
        const code = String(msg.code || '');
        const who = String(msg.from || msg.callsign || '?');
        Hud.pushFeed(who + ': ' + (typeof msg.text === 'string' ? msg.text : (CHAT_LABELS[code] || code)), now);
        if (CONFIG.LOBBY_V2 && Shell.screen === 'gate') Shell.renderGateChat();
        UI.renderLobby();
        return;
      }
      // Every refusal the relay sends (`host only`, `not everyone is ready`, `no course selected`,
      // `callsign already connected`, `join first`, ...). Through 1.3.x these only reached
      // Relay.status, which is drawn on the Solo tab alone, so on the Gate every refusal was silent.
      if (msg.type === 'error') this._onRelayError(msg);
    },
    _errorShownAt: {},
    _onRelayError(msg) {
      const detail = String(msg.detail || 'error').slice(0, 160);
      Debug.log('relay error', detail);
      if (!CONFIG.LOBBY_V2) return;
      // A refusal repeated by a stream of frames (a spectator's pos, a rate limit) is one toast.
      const t = Date.now();
      if (this._errorShownAt[detail] && t - this._errorShownAt[detail] < 10000) return;
      this._errorShownAt[detail] = t;
      Shell.toast('Relay: ' + detail, 'error');
    },
    _onJoined(msg) {
      this.proto = Number.isFinite(msg.proto) ? msg.proto : 0;
      this.joinedSeen = true;
      if (this.proto >= 2 && this.sentHelloFor !== Relay.room) {
        this.sentHelloFor = Relay.room;
        Relay.send({ type: 'hello', model: G.model() });
      }
      UI.applyLegacyGates();
      if (CONFIG.LOBBY_V2) Shell.renderProtoBanner();
      UI.renderLobby();
    },
    _onLobby(msg) {
      const prevPhase = this.state.phase;
      this.state = lobbyReduce(this.state, msg);
      if (CONFIG.RESULTS) Results.onLobby(prevPhase, this.state.phase);
      // Sfx: a flip on any pilot's ready flag, and once (not per-frame) when the last flip makes
      // everyone ready. Compared against the previous snapshot, not just "is anyone ready", so a
      // `lobby` frame that changes something else (a chat's course info, say) doesn't replay it.
      const nowReady = {};
      let flipped = false;
      for (const p of this.state.players) {
        nowReady[p.callsign] = p.ready;
        if (p.callsign in this._prevReady && this._prevReady[p.callsign] !== p.ready) flipped = true;
      }
      if (flipped) Sfx.play('lobby_ready');
      const allReady = this.allReady();
      if (allReady && !this._prevAllReady) Sfx.play('lobby_all_ready');
      this._prevReady = nowReady;
      this._prevAllReady = allReady;
      const mine = this.me();
      if (mine) this.ready = mine.ready;
      this.maybeLoadCourse(this.state.course);
      if (prevPhase !== this.state.phase) Debug.log('lobby phase', String(prevPhase) + ' -> ' + String(this.state.phase));
      // The Gate re-renders on the frame, not on its 1 Hz tick: a Ready click used to look dead
      // for up to a second.
      if (CONFIG.LOBBY_V2 && Shell.screen === 'gate') Shell.renderGate();
      UI.renderLobby();
      if (CONFIG.RESULTS) Results.focusPicker();
    },
    // The course a start is for: the start frame's own `course` (additive, lobby reliability pass),
    // else the lobby's. It is needed BEFORE arming — the relay sends `start` ahead of the `lobby`
    // frame, so on a vote-won course nobody had it loaded when the start landed, and Countdown.arm()
    // (which needs Race.course) and the grid teleport both silently did nothing.
    _startCourse(msg) {
      const c = msg && msg.course;
      if (c && typeof c === 'object' && typeof c.course_id === 'string' && typeof c.course_hash === 'string') return c;
      return this.state.course;
    },
    _onStart(msg) {
      this.state = lobbyReduce(this.state, msg);
      const start = this.state.start;
      if (!start || this.countdownArmedFor === start.raceId) return;
      this.countdownArmedFor = start.raceId;
      const want = this._startCourse(msg);
      this._startCourseHash = want ? want.course_hash : null;
      Debug.fact('start', { raceId: start.raceId, startAtServerMs: start.startAtServerMs, racers: start.racers,
        course: want ? want.course_id : null });
      if (want && !(Race.course && Race.hash === want.course_hash)) {
        Debug.log('start', 'loading ' + want.course_id + ' before arming');
        if (CONFIG.LOBBY_V2) Shell.setScreen('launch');
        this.maybeLoadCourse(want).then(() => {
          const now = this.state.start;
          if (!now || now.raceId !== start.raceId) return;   // aborted or replaced while loading
          if (!(Race.course && Race.hash === want.course_hash)) {
            if (CONFIG.LOBBY_V2) Shell.toast('Could not load ' + (want.name || want.course_id) + ' for this race; no countdown or grid for you this time.', 'error');
            return;
          }
          this._arm(start);
        }).catch((e) => reportLobbyError('loading the course for this race', e));
        return;
      }
      this._arm(start);
    },
    _startCourseHash: null,
    _arm(start) {
      const localAt = this.toLocalMs(start.startAtServerMs);
      if (this.offsetMs == null) {
        this._armedUnsynced = start.raceId;
        Debug.log('clock', 'armed before the first pong; re-arming when one lands');
        this.startClockSync();
      }
      Debug.fact('GO local ms', localAt);
      // Drop the previous GO first, so re-arming for this countdown is not mistaken for throwing
      // away a lobby race that was still on (Race.reset() reports that as an abandoned race).
      Race.clearGo();
      if (Race.course) Race.reset();          // fresh run for this countdown
      if (CONFIG.RESULTS) Results.clear();
      Countdown.arm(localAt);
      Race.armGo(localAt);                    // after reset(), which would otherwise clear it
      // Fixed once per race_id, independent of whether THIS pilot is racing/spectating/ready to
      // teleport yet — the Launch screen (race.js Shell) needs the same lead/speed pair to show
      // every pilot's grid distance, not just the local one maybeGridTeleport() below repositions.
      this.gridLeadS = Math.max(1, (localAt - Date.now()) / 1000);
      this.gridSpeedMs = Math.max(0, Math.min(G.speedCap(), +CONFIG.FLY_TO_START_SPEED_MS || 0));
      this.maybeGridTeleport(start, localAt);
      UI.renderLobby();
      if (CONFIG.LOBBY_V2) Shell.setScreen('launch');
    },

    // Auto-loads the host's course through the existing course loader (README "Sharing a course
    // with everyone"): shared courses by id first, then a locally-saved copy, and verifies the
    // geometry hash afterward — a stale local copy would otherwise silently race a different
    // course than everyone else.
    // One load per course key at a time: the start frame and the lobby frame right behind it both
    // ask for the same course, and both get the same promise.
    _courseLoadKey: '', _courseLoad: null,
    maybeLoadCourse(course) {
      if (!course) return Promise.resolve(false);
      const key = course.course_id + ':' + course.course_hash;
      if (Race.course && Race.hash === course.course_hash) { this._courseLoadKey = key; return Promise.resolve(true); }
      if (this._courseLoadKey === key && this._courseLoad) return this._courseLoad;
      this._courseLoadKey = key;
      this._courseLoad = this._loadCourse(course).then(() => !!(Race.course && Race.hash === course.course_hash));
      return this._courseLoad;
    },
    async _loadCourse(course) {
      try {
        await Courses.refreshRemote();
        const entry = Courses.remote.find((c) => c.id === course.course_id);
        const raw = entry ? await Courses.fetchRemote(entry.file) : Courses.local()[course.course_id];
        if (!raw) {
          const text = 'This room is on "' + course.name + '", which is not in your course list. Refresh the Courses tab, or import it.';
          UI.status(text);
          if (CONFIG.LOBBY_V2) Shell.toast(text, 'warn');
          return;
        }
        const c = Race.load(raw);
        if (Course.hash(c) !== course.course_hash) {
          UI.banner('COURSE MISMATCH', 'Your copy of ' + c.name + ' differs from the host\'s — refresh (↻) and reload.', 6000);
        }
      } catch (e) {
        UI.status('Could not auto-load ' + course.name + ': ' + e.message);
        if (CONFIG.LOBBY_V2) Shell.toast('Could not load ' + course.name + ': ' + e.message, 'error');
      }
    },

    // Air-start grid (race/PROTOCOL.md "Grid"): only for racers (not spectators), only when the
    // host's rules say teleport, only on an air-start course. leadS is measured from the moment
    // this frame lands, which is close enough to the host's chosen lead — grid placement only
    // needs to be roughly right, not exact, since the pilot is still expected to fly the last
    // stretch under their own control.
    // gridLeadS/gridSpeedMs: the lead time and speed the grid was actually staggered for, cached
    // at the moment this ran so the Launch screen can show a fixed distance-back per pilot rather
    // than one that shrinks as the countdown ticks down (see race.js Shell.renderLaunch()).
    gridLeadS: 0, gridSpeedMs: 0,
    maybeGridTeleport(start, localAt) {
      const skip = (why) => { Debug.fact('teleport', { skipped: why }); return { ok: false, skipped: why }; };
      try {
        const c = Race.course;
        if (!c) return skip('no course loaded');
        if (this._startCourseHash && Race.hash !== this._startCourseHash) return skip('loaded course is not the one this race is on');
        if (c.startType !== 'air') return skip('ground-start course');
        if (!this.state.rules.teleport) return skip('the host turned teleport off');
        if (!G.ready()) return skip('GeoFS not ready');
        const idx = start.racers.indexOf(Powerups.callsign());
        if (idx < 0) return skip('not on the grid (spectating or not ready)');
        const [g1, g2] = c.gates;
        if (!g1 || !g2) return skip('course has fewer than 2 gates');
        const slot = gridSlot(g1, g2, idx, start.racers.length, this.gridLeadS, this.gridSpeedMs);
        return this._teleportTo(slot, this.gridSpeedMs, 'grid slot ' + (idx + 1) + ' of ' + start.racers.length);
      } catch (e) { reportLobbyError('placing you on the grid', e); return { ok: false, error: String(e && e.message) }; }
    },
    // The one reposition path the grid (and the debug "Test grid slot" button) uses: resetFlight
    // first, raw llaLocation/htr writes as the fallback, then heading and the speed scalars — the
    // same writes FlyToStart already ships. Logs which method took and the state before and after,
    // which through 1.3.x was all swallowed by a bare catch.
    _teleportTo(slot, speedMs, label) {
      const snap = () => {
        try {
          const p = G.lla();
          return { lat: +p.lat.toFixed(6), lon: +p.lon.toFixed(6), alt: Math.round(p.alt), heading: Math.round(G.heading()), speedMs: Math.round(G.currentSpeedMs()) };
        } catch (_) { return null; }
      };
      const before = snap();
      const method = G.repositionViaReset(slot) ? 'resetFlight' : G.repositionByState(slot) ? 'llaLocation/htr' : null;
      if (!method) {
        const res = { ok: false, label, method: null, before, slot };
        Debug.fact('teleport', res);
        console.info('[finsRace] teleport to ' + label + ' FAILED: neither resetFlight nor llaLocation took the write ' + JSON.stringify(res));
        if (CONFIG.LOBBY_V2) Shell.toast('Could not move you to the grid. Fly to gate 1 yourself.', 'warn');
        return res;
      }
      G.setHeading(slot.heading);
      const speed = G.accelerateTo(speedMs);
      if (!speed.vector) G.setVelocityFromFrame(speedMs);
      const res = { ok: true, label, method, before, after: snap(), slot: { lat: +slot.lat.toFixed(6), lon: +slot.lon.toFixed(6), alt: Math.round(slot.alt), heading: Math.round(slot.heading) }, speedMs };
      Debug.fact('teleport', res);
      console.info('[finsRace] teleport to ' + label + ' via ' + method + ' ' + JSON.stringify(res));
      return res;
    },
    // DEBUG only (the overlay's "Test grid slot N" button): put THIS pilot in slot n of m for the
    // loaded course, exactly as a real start would, so the teleport can be checked with nobody else.
    testGridSlot(n, m) {
      const c = Race.course;
      if (!c || c.startType !== 'air' || !c.gates || c.gates.length < 2) return { ok: false, skipped: 'load an air-start course first' };
      if (!G.ready()) return { ok: false, skipped: 'GeoFS not ready' };
      const count = Math.max(1, Math.round(+m) || 1), idx = Math.max(0, Math.min(count - 1, Math.round(+n) - 1 || 0));
      const speedMs = Math.max(0, Math.min(G.speedCap(), +CONFIG.FLY_TO_START_SPEED_MS || 0));
      const slot = gridSlot(c.gates[0], c.gates[1], idx, count, CONFIG.COUNTDOWN_LEAD_S, speedMs);
      Race.reset();
      return this._teleportTo(slot, speedMs, 'TEST grid slot ' + (idx + 1) + ' of ' + count);
    },

    // ---- client -> relay (host-only frames are refused server-side for anyone else, so the UI
    // just doesn't render the controls rather than duplicating the check here)
    //
    // Every outgoing lobby frame goes through _send(): a frame that cannot go out (no socket, or
    // one still connecting) says so in a toast instead of vanishing. Relay.send() returning false
    // was ignored by every caller through 1.3.x.
    _send(frame, label) {
      if (Relay.send(frame)) return true;
      const why = !Relay.wantOpen ? 'you are not in a room' : 'still connecting to the relay';
      Debug.log('send failed', frame.type + ' (' + why + ')');
      if (CONFIG.LOBBY_V2) Shell.toast((label || frame.type) + ' not sent: ' + why + '.', 'warn');
      return false;
    },
    setReady(v) {
      const want = !!v;
      if (this._send({ type: 'ready', ready: want }, want ? 'Ready' : 'Not ready')) this.ready = want;
    },
    setCourse(c) { return this._send({ type: 'course', course_id: c.id, course_hash: Course.hash(c), name: c.name, start_type: c.startType }, 'Course pick'); },
    setRules(rules) { return this._send({ type: 'rules', powerups: !!rules.powerups, teleport: !!rules.teleport }, 'Rules change'); },
    startCountdown(leadS, force) {
      return this._send({ type: 'start', lead_s: Math.max(5, Math.min(60, Math.round(+leadS || CONFIG.COUNTDOWN_LEAD_S))), force: !!force }, 'Start');
    },
    abortCountdown() { return this._send({ type: 'abort' }, 'Abort'); },
    backToLobby() { return this._send({ type: 'back_to_lobby' }, 'Back to lobby'); },
    // Proto 4, host only (the relay refuses anyone else). Both are dark against an older relay,
    // which would answer each with an `error` — so the UI never offers them below proto 4.
    rematch() { if (this.proto >= 4) this._send({ type: 'rematch' }, 'Rematch'); },
    startCup(name, raceCount) {
      const n = String(name || '').trim().slice(0, 32);
      const count = Math.max(1, Math.min(12, Math.round(+raceCount) || 1));
      if (this.proto >= 4 && n) this._send({ type: 'cup', name: n, race_count: count }, 'Cup');
    },
    chat(code) { if (CHAT_CODES.includes(code)) this._send({ type: 'chat', code }, 'Chat'); },
    // proto 5 free text (race/PROTOCOL.md "Free-text lobby chat"), distinct from the fixed-enum
    // `chat()` above. Gated on CONFIG.CHAT_ENABLED so the compose box can be turned off without a
    // redeploy; a cleaned-to-empty draft is never sent (matches the relay's own "empty chat line"
    // refusal rather than bothering it with one).
    chatText(text) {
      if (!CONFIG.CHAT_ENABLED) return;
      const cleaned = sanitizeChatDraft(text);
      if (!cleaned) return false;
      if (this.proto < 5) {
        if (CONFIG.LOBBY_V2) Shell.toast('This room\'s relay speaks proto ' + this.proto + '; typed chat needs 5. Quick chat still works.', 'warn');
        return false;
      }
      return this._send({ type: 'chat', text: cleaned }, 'Message');
    },
    // proto 5 course vote (race/PROTOCOL.md "Course vote"). Any player may vote; the relay is
    // authoritative for the candidate list and the winner — this only ever names a candidate the
    // room already offered.
    vote(courseId) {
      if (!courseId) return false;
      if (this.proto < 5) {
        if (CONFIG.LOBBY_V2) Shell.toast('This room\'s relay has no course vote (proto ' + this.proto + ').', 'warn');
        return false;
      }
      return this._send({ type: 'vote', course_id: courseId }, 'Vote');
    },

    // Connects/disconnects the relay for the lobby's own lifecycle, independent of Race.state:
    // people gather, ready up, and chat before any course is even chosen. Called whenever the
    // available room might have changed (course loaded/unloaded, manual room code edited).
    //
    // Under LOBBY_V2 this is a no-op: the shell owns every join (Ramp, room code, ?room= invite),
    // and nothing joins a room on its own — not at boot from the last stored room, not on a course
    // load, not on a Race-bus event. Before the lobby reliability pass it did all three, which is
    // how one tab ended up with a boot-time socket AND a Ramp-join socket to the same room, and how
    // Leave quietly rejoined the room on the next course load.
    syncConnection() {
      if (!CONFIG.LOBBY || !CONFIG.POWERUPS || CONFIG.LOBBY_V2) return;
      const room = Powerups.room();
      if (!room) { if (Relay.wantOpen) Relay.disconnect(); return; }
      if (Relay.wantOpen && Relay.room === room) return;
      Relay.disconnect();
      Relay.connect(room);
    },
    // Explicit join, driven by the Ramp screen's Join/Spectate/Reopen and its "have a room code?"
    // field (race.js Shell module) — as opposed to syncConnection()'s implicit course-hash-derived
    // room. Persists the room the same way a hand-typed room code already does (Powerups.room()),
    // so this and syncConnection() never fight over which room is "current".
    joinRoom(code, opts) {
      const room = powerupsRoom(code, '');
      if (!room) { console.warn('[finsRace] not a usable room code:', code); return false; }
      store.set('powerupRoom', room);
      Relay.disconnect();
      // Propagated, not assumed: a client with no CONFIG.API_BASE cannot join anything, and the
      // caller needs to know that rather than navigating to a Gate screen for a room that has no
      // socket behind it (the 1.3.0 "+ New room does nothing" bug).
      return Relay.connect(room, opts) !== false;
    },
  };

  // ----------------------------------------------------------- hub (proto 5, WS /ws/hub)
  // The matchmaking hub: pilot identity, presence, the public room registry and ping-the-ramp
  // (race/PROTOCOL.md "Proto 5: hub, identity, chat and the vote"). A second, independent socket
  // — the race room socket (Relay/Lobby above) is completely unaffected by this one ever failing
  // to connect, per the protocol's own framing ("a pilot who never opens the hub races exactly as
  // they did in 1.1.0"). Modeled directly on Relay above: same wantOpen/exponential-backoff/
  // fail-closed-send shape, so a dead or misbehaving relay degrades the same way loadout-only
  // mode already does — never a thrown error, never a blocked race.
  //
  // Only constructed/used when CONFIG.LOBBY_V2 — an old-panel rollback never opens this socket.

  // Local-midnight-UTC-7 day bucket (a fixed offset, no tz database — matches app.py's own
  // "local midnight UTC-7" reset rule for RAMP_PING_PER_DAY exactly, PROTOCOL.md "Ping the ramp").
  function rampDayKey(ms) { return Math.floor((ms - 7 * 3600 * 1000) / 86400000); }
  // How many of today's (UTC-7) pings are left, given the timestamps this client has sent. Purely
  // a display estimate — see the Hub module's pingRamp()/onFrame() for how a server refusal
  // corrects it.
  function rampPingsRemaining(sentTimestamps, cap, nowMs) {
    const key = rampDayKey(nowMs);
    const todayCount = (Array.isArray(sentTimestamps) ? sentTimestamps : []).filter((t) => rampDayKey(+t) === key).length;
    return Math.max(0, Math.round(+cap || 0) - todayCount);
  }

  const Hub = {
    ws: null, status: '', attempts: 0, timer: 0, wantOpen: false, connected: false,
    proto: 0, pilotId: '', pilotToken: '',
    presence: [], rooms: [],
    lastError: '',            // e.g. a callsign-claim conflict from `hello`, shown near the field
    heartbeatTimer: 0,
    _lastWhere: null,         // { room, activity } last sent, so an unchanged state resends nothing
    _pingSentAt: 0,           // see pingRamp()/onmessage's optimistic-then-corrected bookkeeping

    enabled() { return CONFIG.LOBBY_V2 && !!CONFIG.API_BASE; },

    // Returns true only when a socket was actually opened — see Relay.connect() above for why
    // these guards stopped being silent in 1.3.1.
    connect() {
      if (!this.enabled()) {
        this.status = CONFIG.LOBBY_V2 ? 'Ramp: no relay configured (CONFIG.API_BASE is empty).' : 'Ramp: off (CONFIG.LOBBY_V2).';
        if (CONFIG.LOBBY_V2) console.warn('[finsRace] no relay configured (CONFIG.API_BASE is empty) — the ramp stays offline');
        return false;
      }
      const url = hubUrl(CONFIG.API_BASE);
      if (!url) { this.status = 'Ramp: no relay configured.'; return false; }
      this.wantOpen = true;
      this.pilotId = store.get('pilotId', '');
      this.pilotToken = store.get('pilotToken', '');
      this._open(url);
      return true;
    },
    // Same detach-before-close rule as Relay._detach(), for the same reason.
    _detach(ws) {
      if (!ws) return;
      ws.onopen = null; ws.onmessage = null; ws.onerror = null; ws.onclose = null;
      try { ws.close(); } catch (_) {}
    },
    _open(url) {
      clearTimeout(this.timer);
      this._detach(this.ws);
      this.ws = null;
      try {
        const ws = new WebSocket(url);
        this.ws = ws;
        this.status = 'Ramp: connecting…';
        ws.onopen = () => {
          if (ws !== this.ws) return;
          try {
            this.connected = true; this.attempts = 0;
            this.status = 'Ramp: connected.';
            this.send({ type: 'hello', pilot_token: this.pilotToken || undefined,
              callsign: Powerups.callsign(), model: G.model() });
            this._startHeartbeat();
          } catch (_) {}
        };
        ws.onmessage = (ev) => {
          if (ws !== this.ws) return;
          let msg;
          try { msg = JSON.parse(ev.data); } catch (_) { return; }
          Debug.frame('hub-in', msg);
          try { this.onFrame(msg, Date.now()); } catch (e) { reportLobbyError('handling ' + (msg && msg.type) + ' from the ramp', e); }
        };
        ws.onerror = () => { if (ws === this.ws) this.status = 'Ramp: connection error.'; };
        ws.onclose = () => {
          if (ws !== this.ws) return;
          this.connected = false;
          clearInterval(this.heartbeatTimer); this.heartbeatTimer = 0;
          if (!this.wantOpen) { this.status = 'Ramp: disconnected.'; return; }
          this.status = 'Ramp disconnected — reconnecting. Racing continues without the ramp.';
          this._retry(url);
        };
      } catch (e) {
        this.status = 'Ramp unavailable (' + e.message + ').';
        this._retry(url);
      }
    },
    _retry(url) {
      if (!this.wantOpen) return;
      const wait = Math.min(CONFIG.POWERUP_RECONNECT_MS * Math.pow(2, this.attempts++), CONFIG.POWERUP_RECONNECT_MAX_MS);
      clearTimeout(this.timer);
      this.timer = setTimeout(() => { if (this.wantOpen) this._open(url); }, wait);
    },
    disconnect() {
      this.wantOpen = false;
      this.attempts = 0;
      clearTimeout(this.timer);
      clearInterval(this.heartbeatTimer); this.heartbeatTimer = 0;
      this._detach(this.ws);
      this.ws = null;
      this.connected = false;
      this.proto = 0; this.presence = []; this.rooms = []; this._lastWhere = null;
      this.status = 'Ramp: idle.';
    },
    send(obj) {
      try {
        if (!this.ws || this.ws.readyState !== 1) return false;
        this.ws.send(JSON.stringify(obj));
        Debug.frame('hub-out', obj);
        return true;
      } catch (_) { return false; }
    },
    _startHeartbeat() {
      clearInterval(this.heartbeatTimer);
      const everyMs = Math.max(1000, Math.round(1000 / (CONFIG.RAMP_PRESENCE_HZ || 0.2)));
      this.heartbeatTimer = setInterval(() => this.send({ type: 'heartbeat' }), everyMs);
    },
    // Self-reported and cosmetic (race/PROTOCOL.md "Trust model additions (proto 5)") — driven by
    // real state changes (Shell navigation, Race/Lobby events), never polled, and a no-op when
    // nothing actually changed so a busy session doesn't spam `where` frames.
    reportWhere(room, activity) {
      const w = { room: room || null, activity };
      if (this._lastWhere && this._lastWhere.room === w.room && this._lastWhere.activity === w.activity) return;
      this._lastWhere = w;
      this.send({ type: 'where', room: w.room, activity: w.activity });
    },
    // Deliberately scarce (race/PROTOCOL.md "Ping the ramp") — the server is authoritative on the
    // cooldown/daily cap; this only records an optimistic local timestamp for the button's
    // estimated "N left today", corrected below if the relay actually refuses it.
    pingRamp() {
      if (!this.connected) return false;
      this._pingSentAt = Date.now();
      const sent = this.send({ type: 'ping_ramp' });
      if (sent) {
        const log = store.get('rampPings', []);
        log.push(this._pingSentAt);
        store.set('rampPings', log.slice(-64));
      }
      return sent;
    },
    pingsRemaining(nowMs) { return rampPingsRemaining(store.get('rampPings', []), CONFIG.RAMP_PING_DAILY_CAP, nowMs); },

    onFrame(msg, now) {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'welcome') {
        this.proto = Number.isFinite(msg.proto) ? msg.proto : 5;
        this.pilotId = String(msg.pilot_id || this.pilotId);
        this.pilotToken = String(msg.pilot_token || this.pilotToken);
        store.set('pilotId', this.pilotId);
        store.set('pilotToken', this.pilotToken);
        this.lastError = '';
        this._lastWhere = null;   // force the next reportWhere() through, post-(re)connect
      } else if (msg.type === 'presence') {
        this.presence = Array.isArray(msg.pilots) ? msg.pilots : [];
      } else if (msg.type === 'rooms') {
        this.rooms = Array.isArray(msg.rooms) ? msg.rooms : [];
      } else if (msg.type === 'ramp_ping') {
        Hud.pushFeed(String(msg.from || '?') + ' pinged the ramp.', now);
        Sfx.play('lobby_chat');
      } else if (msg.type === 'error') {
        const detail = String(msg.detail || 'error');
        // A ping_ramp refused within a few seconds of sending one is that ping's own rejection —
        // roll back the optimistic count and let the real message correct the button. Anything
        // else (most commonly a claim conflict from `hello`) surfaces as this.lastError instead.
        if (this._pingSentAt && now - this._pingSentAt < 4000) {
          this._pingSentAt = 0;
          const log = store.get('rampPings', []);
          log.pop();
          store.set('rampPings', log);
          this.lastError = detail;
        } else {
          this.lastError = detail;
        }
        Debug.log('hub error', detail);
        if (CONFIG.LOBBY_V2 && Shell.E.shell) { Shell.toast('Ramp: ' + detail, 'warn'); this.lastError = ''; }
      }
    },
  };

  // The end of a lobby race (proto 4, race/PROTOCOL.md "Proto 4: results and cups"). Owns three
  // things: telling the relay how this pilot's race ended (`finish`, or `dnf` on a DQ / reset), the
  // results state the relay sends back (progress while others are still flying, then the final
  // table), and the overlay that shows it. Like Lobby it fails closed: every entry point catches, and
  // against a relay below proto 4 it sends nothing at all — a lobby race just ends on a local card.
  //
  // The leaderboard is a separate path and is not touched here: UI.submitRun() still posts the
  // gate-1-clock run exactly as before, so course records stay comparable whether or not a run came
  // out of a lobby.
  const Results = {
    state: resultsInitialState(),
    rev: 0,                  // bumped on every state change, so the overlay knows when to rebuild
    dismissed: '',           // 'kind:raceId' the pilot closed; a newer kind or race brings it back
    announcedRace: -1,       // the race whose "P2 · +12 pts" banner has already shown
    sentFinishFor: null,     // the race id a finish has gone out for — once per race
    owed: null,              // { raceId, gate }: a dnf to send as soon as the race is actually on
    record: false, recordFor: -1, checkAt: [],   // the "new course record" lookup (see lookupRecord)
    wantPicker: false,       // "Next race" asked the lobby overlay to focus its course picker
    lastWaitText: '', _wasVisible: false,

    enabled() { return CONFIG.RESULTS && CONFIG.LOBBY; },
    clear() {
      this.state = resultsInitialState(); this.rev++;
      this.dismissed = ''; this.announcedRace = -1; this.sentFinishFor = null; this.owed = null;
      this.record = false; this.recordFor = -1; this.checkAt = []; this.lastWaitText = '';
      try { if (UI.E.resOverlay) UI.renderResults(); } catch (_) {}
    },

    // A racer in a lobby race that is really on — a synced GO was armed for it, this pilot is on
    // the relay's racer list for it, and the relay speaks the lobby. Anything else (a plain Alt+R
    // run, a spectator, no relay) has no shared result to report.
    inLobbyRace() {
      const st = Lobby.state.start;
      return this.enabled() && Lobby.active() && Race.goAt != null && Lobby.countdownArmedFor != null &&
        !!st && st.racers.includes(Powerups.callsign()) && !Lobby.isSpectator();
    },

    // ---- this pilot -> relay
    onFinish(finalMs) {
      try {
        const raceId = Lobby.countdownArmedFor;
        if (!this.inLobbyRace() || this.sentFinishFor === raceId) return;
        const goTime = finishGoTimeMs(Race.goElapsed, Race.elapsed, finalMs);
        if (!Number.isFinite(goTime)) return;
        // Shared results need proto 4 AND an open socket. Either missing means this pilot still
        // gets a card — a local one — rather than a finish that vanishes without a word.
        if (Lobby.proto >= 4 && Relay.send(finishFrame(raceId, goTime, Race.splits, Race.jumpStartMs))) {
          this.sentFinishFor = raceId;
          return;
        }
        this.state = localResultsState(Relay.standings, Powerups.callsign(), goTime, G.model(), raceId);
        this.dismissed = ''; this.rev++;
        UI.renderResults();
      } catch (e) { console.warn('[finsRace] results finish', e); }
    },
    // A DQ, or a reset/course swap while the lobby race was still on: this pilot is out of it. The
    // relay only takes a dnf once the race has actually started, so one raised during the
    // countdown waits in `owed` until the room's phase flips to 'racing'.
    owe(gate) {
      try {
        if (!this.inLobbyRace()) return;
        this.owed = { raceId: Lobby.countdownArmedFor, gate: Math.max(0, Math.round(+gate) || 0) };
        this.flushDnf();
      } catch (e) { console.warn('[finsRace] results dnf', e); }
    },
    flushDnf() {
      const o = this.owed;
      if (!o) return;
      if (Lobby.proto < 4) { this.owed = null; return; }
      const st = Lobby.state;
      if (st.raceId > o.raceId) { this.owed = null; return; }           // a newer race has replaced it
      if (st.phase !== 'racing' || st.raceId !== o.raceId) return;      // not on yet: keep waiting
      this.owed = null;
      Relay.send(dnfFrame(o.raceId, o.gate));
    },

    // ---- relay -> this pilot
    onFrame(msg, now) {
      try {
        if (!this.enabled() || Lobby.proto < 4) return;
        const before = this.state;
        this.state = resultsReduce(this.state, msg);
        if (this.state === before) return;
        this.rev++;
        this.announce();
        if (this.state.kind === 'final') this.checkAt = [now + 200, now + 3500];
        UI.renderResults();
      } catch (e) { console.warn('[finsRace] results frame', e); }
    },
    // The room's phase changed. Back to the lobby (a rematch, "next race", or the host calling the
    // race off) or into a new countdown means the results are history — and a finished pilot is
    // re-armed so the lobby overlay, which only shows while armed, can appear.
    onLobby(prev, next) {
      try {
        if (!this.enabled()) return;
        if (next === 'lobby' || next === 'countdown') {
          if (this.state.kind !== 'none') this.clear();
          if (next === 'lobby' && (prev === 'results' || prev === 'racing') && Race.course &&
              (Race.state === 'finished' || Race.state === 'dq')) Race.reset();
        }
        this.flushDnf();
      } catch (e) { console.warn('[finsRace] results lobby', e); }
    },
    // My own position and points as a banner, the moment the relay's frame first names them — and
    // the winner's fanfare. Once per race.
    announce() {
      const s = this.state;
      const me = s.rows.find((r) => r.callsign === Powerups.callsign() && r.status === 'finished');
      if (!me || this.announcedRace === s.raceId) return;
      this.announcedRace = s.raceId;
      UI.banner('P' + me.pos + (Number.isFinite(me.points) ? ' · +' + me.points + ' pts' : ''), undefined, 5000);
      if (me.pos === 1) Sfx.play('finish_p1');
    },

    // ---- what the overlay needs to know
    winner() {
      const w = this.state.rows.find((r) => r.status === 'finished' && r.pos === 1);
      return w ? w.callsign : null;
    },
    // Shown once there is something to show, this pilot is out of the air (a still-racing pilot's
    // view is never covered), and they have not closed this particular card.
    visible() {
      if (!this.enabled()) return false;
      const s = this.state;
      if (s.kind === 'none' || this.dismissed === s.kind + ':' + s.raceId) return false;
      return s.kind === 'local' || Race.state !== 'running';
    },
    waitText() {
      const s = this.state;
      return resultsWaitingText(s.waiting.length, Lobby.toLocalMs(s.deadlineServerMs) - Date.now());
    },
    view() {
      if (!this.visible()) return null;
      const s = this.state, me = Powerups.callsign();
      const head = resultsHeadline(s.rows, me, s.kind);
      const progress = s.kind === 'progress', final = s.kind === 'final';
      const rows = resultsRows(s.rows, me, progress ? s.waiting : []);
      return {
        kind: s.kind, headline: head.text, sub: head.sub, iWon: head.iWon, winner: head.winner,
        course: (s.course && s.course.name) || (Race.course && Race.course.name) || '',
        rows, hasPoints: rows.some((r) => r.points !== ''),
        waitText: progress ? this.waitText() : '',
        record: final && this.record && this.recordFor === s.raceId,
        cup: s.cup ? { ...s.cup, over: s.cup.raceNo >= s.cup.raceCount } : null,
        awards: s.awards.map((a) => ({ label: AWARD_LABELS[a.key] || a.key.replace(/_/g, ' '), callsign: a.callsign, detail: a.detail })),
        host: final && Lobby.isHost(), ghost: final && CONFIG.GHOST && !!head.winner,
        challenge: final && CONFIG.RIVAL_GHOSTS && !!Race.course,
      };
    },

    // Once per frame (Powerups.tick's neighbour in loop()): the waiting clock, and the record
    // lookups that came due. Frame-driven instead of timers so a test can step it deterministically.
    tick(now) {
      if (!this.enabled()) return;
      // A card that was held back because this pilot was still racing has to appear the frame they
      // stop (a finish the relay refused as too late, a DQ, a reset) — no relay frame will arrive to
      // trigger a render for them, so the flip itself is what is watched.
      const vis = this.visible();
      if (vis !== this._wasVisible) { this._wasVisible = vis; UI.renderResults(); }
      if (this.state.kind === 'progress' && vis) {
        const text = this.waitText();
        if (text !== this.lastWaitText) { this.lastWaitText = text; UI.renderResults(); }
      }
      if (this.checkAt.length && now >= this.checkAt[0]) { this.checkAt.shift(); this.lookupRecord(); }
    },
    // The winner's gate-1-clock time is what the board holds and what a course record is — the
    // frame only carries the lobby clock — so ask the board: see newRecordBadge(). Looked at twice,
    // because the winner's own POST /runs races the final `results` frame to the relay.
    async lookupRecord() {
      const s = this.state, winner = this.winner();
      if (!LB.enabled() || s.kind !== 'final' || !winner || !s.course || !s.course.course_hash) return;
      const raceId = s.raceId;
      try {
        const board = await LB.top(s.course.course_hash, 3);
        if (this.state.kind !== 'final' || this.state.raceId !== raceId) return;
        const start = Lobby.state.start ? Lobby.state.start.startAtServerMs : NaN;
        if (newRecordBadge(winner, board, start)) { this.record = true; this.recordFor = raceId; UI.renderResults(); }
      } catch (_) { /* no badge is the safe answer */ }
    },

    // "Next race" asked for the course picker. Called at the END of the lobby frame's handling, once
    // the lobby card has been rebuilt for the last time: the host controls are rebuilt on every
    // render (and Race.reset() inside onLobby() triggers one of its own), so a focus given any
    // earlier would be thrown away with the element it was given to.
    focusPicker() {
      // The picker it focuses lives on the old lobby card, which LOBBY_V2 never builds.
      if (CONFIG.LOBBY_V2) { this.wantPicker = false; return; }
      if (!this.wantPicker || Lobby.state.phase !== 'lobby') return;
      const sel = UI.E.lobbyCourseSel;
      if (!sel || !sel.isConnected) return;
      this.wantPicker = false;
      try { sel.focus(); } catch (_) {}
    },

    // ---- the overlay's buttons
    close() { this.dismissed = this.state.kind + ':' + this.state.raceId; UI.renderResults(); },
    // Host: back to the lobby, with the course picker in front of them. The relay clears every
    // ready flag; the lobby frame that follows is what re-arms this client and brings the lobby up.
    nextRace() {
      if (!Lobby.isHost()) return;
      this.wantPicker = true;
      Lobby.backToLobby();
      this.close();
    },
    rematch() {
      if (!Lobby.isHost()) return;
      Lobby.rematch();
      this.close();
    },
    // Everyone: point the Ghost picker at the winner, and go back to the lobby. Only the host can
    // move the ROOM there (a rematch, same course), so for anyone else "back to the lobby" is this
    // client re-arming itself; the lobby overlay comes up when the host lets the room follow.
    raceWinnersGhost() {
      const w = this.winner();
      if (!w || !CONFIG.GHOST) return;
      Ghost.setPick(w);
      UI.renderGhostOptions();
      if (LB.enabled()) UI.refreshBoard();
      UI.status('Ghost: racing ' + w + '’s run.');
      this.close();
      if (Lobby.isHost()) Lobby.rematch();
      else if (Race.course && (Race.state === 'finished' || Race.state === 'dq')) Race.reset();
    },
    // Everyone: a URL a friend can paste into their own browser to load this course with these
    // ghosts pre-picked — see CONFIG.RIVAL_GHOSTS and boot()'s challenge-param handling. Defaults
    // to "beat the winner" when nothing is currently picked, since that's the obvious challenge
    // right off a results screen; any already-picked rivals ride along too.
    copyChallengeLink() {
      const c = Race.course;
      if (!c || !CONFIG.RIVAL_GHOSTS) return;
      const ghosts = [];
      const w = this.winner();
      if (w) ghosts.push(w);
      else if (CONFIG.GHOST && Ghost.pick && Ghost.pick !== GHOST_MINE) ghosts.push(Ghost.pick);
      for (const p of RivalGhosts.extraPicks) {
        if (p && p !== GHOST_MINE && !ghosts.includes(p)) ghosts.push(p);
      }
      const link = buildChallengeLink(location.href, c.id, ghosts.slice(0, RivalGhosts.max()));
      try { navigator.clipboard.writeText(link); UI.status('Challenge link copied: ' + link); }
      catch (_) { UI.status('Challenge link: ' + link + ' (clipboard blocked)'); }
    },
  };

  const Powerups = {
    state: powerupsInitialState(store.get('powerupLoadout', ['boost', 'boost'])),
    feed: [], lastPing: 0, relay: Relay,
    // The box roulette in progress, or null. While this is set the box slot shows a spinning
    // icon and refuses to fire — see tickRoll() and useSlot().
    roll: null,
    // The box this client last crossed and is waiting on an answer for; see onItemBox().
    pendingBox: null,

    callsign() {
      try { return ((UI.E.callsign && UI.E.callsign.value) || store.get('callsign', '') || G.callsign() || 'racer').trim().slice(0, 32) || 'racer'; }
      catch (_) { return 'racer'; }
    },
    room() { return powerupsRoom(CONFIG.POWERUP_ROOM || store.get('powerupRoom', ''), Race.hash); },

    setLoadout(loadout) {
      const picks = (Array.isArray(loadout) ? loadout : []).filter((x) => POWERUP_ITEMS.includes(x)).slice(0, 2);
      store.set('powerupLoadout', picks);
      this.state = powerupsInitialState(picks);
    },
    refill() { this.state = powerupsRefill(this.state); },

    note(text) {
      this.feed.unshift(text);
      if (this.feed.length > 6) this.feed.length = 6;
      if (CONFIG.HUD) Hud.pushFeed(text, clockNow());
    },

    // The roulette's own clock. Ticks the slot icon, plays box_roll_tick, and on the reveal
    // actually grants the item — which is the moment it becomes fireable.
    tickRoll(now) {
      const r = this.roll;
      if (!r) return;
      if (now >= r.until) {
        this.roll = null;
        this.state = powerupsGrant(this.state, r.item);
        Sfx.play('box_grant');
        this.note(r.item === 'nothing' ? 'Box gave you nothing. Rude.' : 'You boxed ' + (POWERUP_LABELS[r.item] || r.item) + ' (Alt+3).');
        UI.renderPowerups(now);
        return;
      }
      if (now - r.lastTick >= 110) { r.lastTick = now; Sfx.play('box_roll_tick'); }
    },
    // What the box slot shows right now: the spinning icon while a roulette is running, else
    // whatever is actually carried.
    rollingItem(now) {
      const r = this.roll;
      return r ? rouletteFrameAt(r.frames, now - r.startedAt, CONFIG.BOX_ROLL_MS) : null;
    },

    useSlot(i, now) {
      if (!CONFIG.POWERUPS) return;
      // An item still spinning is not an item yet.
      if (i === POWERUP_BOX_SLOT && this.roll) { UI.status('Still rolling…'); return; }
      const { state, item } = powerupsUse(this.state, i, now, powerupDurations());
      this.state = state;
      if (item && POWERUP_HIT_ITEMS.includes(item)) {
        // Offensive: the relay adjudicates who it hits. If it can't be sent, the item is spent
        // anyway rather than silently re-usable — simpler than a rollback, and the feed says so.
        const hdg = G.ready() ? G.heading() : null;
        const sent = Relay.send(hdg == null ? { type: 'fire', item } : { type: 'fire', item, heading: hdg });
        Sfx.play('item_use');
        this.note(sent ? 'You fired ' + POWERUP_LABELS[item] + '.' : POWERUP_LABELS[item] + ' fizzled (no relay).');
      } else if (item) {
        Sfx.play(item === 'shield' ? 'shield_up' : 'item_use');
        UI.status(item === 'boost' ? 'Boost!' : 'Shield up.');
        this.note('You used ' + POWERUP_LABELS[item] + '.');
        // Proto 3, cosmetic: tell the room so everyone can see it. The relay rate-limits this to
        // one per two seconds per player and silently drops the rest, which is why my OWN effect
        // is drawn from here rather than from the echo — a dropped cosmetic frame must never be
        // the reason my own boost trail is missing.
        const ms = powerupDurations()[item] || 0;
        if (Items.active()) {
          Relay.send({ type: 'fx', item, ms });
          Items.onFx({ callsign: this.callsign(), item, ms }, now);
        }
      }
      UI.renderPowerups(now);
    },
    isShielded(now) { return powerupsActive(this.state, 'shield', now); },

    // ---- the optional real speed cost of a missile hit (CONFIG.POWERUP_SPEED_PENALTY, OFF by
    // default). Reuses the confirmed 0.6.0 scalar write path and nothing else: it holds
    // trueAirSpeed/groundSpeed at penaltyTarget() for PENALTY_MS. Four things it will not do,
    // each of which is a way this could hurt somebody rather than annoy them:
    //   * go below CONFIG.PENALTY_FLOOR_MS — a penalty that stalls the aircraft is a crash
    //   * apply below CONFIG.PENALTY_MIN_AGL_M, when AGL is readable at all
    //   * stack, so two missiles cannot compound into a standstill
    //   * write a control input; POWERUP_CONTROL_EFFECTS stays false and is untouched here
    // Slowing down can never trip the teleport/slew DQ, which only ever fires on too FAST.
    penaltyUntil: 0, penaltyTo: null,
    armPenalty(now) {
      if (!CONFIG.POWERUP_SPEED_PENALTY) return false;
      if (now < this.penaltyUntil) return false;              // never stacks
      const agl = G.ready() ? G.aglM() : null;
      if (agl != null && agl < (+CONFIG.PENALTY_MIN_AGL_M || 0)) return false;
      const target = penaltyTarget(G.ready() ? G.currentSpeedMs() : null, +CONFIG.PENALTY_FLOOR_MS || 0);
      if (target == null) return false;
      this.penaltyUntil = now + Math.max(0, +CONFIG.PENALTY_MS || 0);
      this.penaltyTo = target;
      return true;
    },
    clearPenalty() { this.penaltyUntil = 0; this.penaltyTo = null; },

    // A relay `box_state` turned into Race's own rAF-clock cooldown for that box. Two clock
    // conversions, both of which already exist: server -> Date.now() via Lobby's measured
    // offset, then Date.now() -> rAF by subtracting the difference measured right here. A frame
    // with a nonsense id or time is dropped rather than darkening a box forever.
    applyBoxState(msg, now) {
      const id = Math.round(+msg.id);
      const untilServer = +msg.until_server_ms;
      if (!Number.isFinite(id) || id < 0 || id >= MAX_ITEM_BOXES) return;
      if (!Number.isFinite(untilServer)) return;
      const untilLocal = CONFIG.LOBBY ? Lobby.toLocalMs(untilServer) : untilServer;
      const remain = Math.max(0, Math.min(2 * (+CONFIG.BOX_RESPAWN_MS || 0), untilLocal - Date.now()));
      if (!Race.boxReadyAt) return;
      Race.boxReadyAt[id] = now + remain;
      // A box_state for the box I just flew through, with no grant ahead of it, is the relay
      // telling me somebody beat me to it (race/PROTOCOL.md `box`).
      const pending = this.pendingBox;
      if (pending && pending.id === id && now < pending.until) {
        this.pendingBox = null;
        Sfx.play('box_dark');
        this.note('Box already taken — back in ' + Math.max(1, Math.round(remain / 1000)) + 's.');
      }
    },

    // A box crossing. The client is authoritative only for "I crossed it"; the relay rolls the
    // item and decides whether the box was still lit (proto 3 makes boxes contested — two
    // pilots arriving together do not both get an item). With no relay, say so instead of
    // self-granting anything. The box is not removed: Race's own cooldown darkens it, and a
    // `box_state` frame corrects that cooldown to whatever the room actually agreed.
    onItemBox(now, id) {
      if (!CONFIG.POWERUPS) return;
      const boxId = Math.max(0, Math.min(MAX_ITEM_BOXES - 1, Math.round(+id || 0)));
      if (CONFIG.LOBBY && Lobby.isSpectator()) { this.note('Spectating — no items.'); UI.renderPowerups(now); return; }
      if (Relay.send({ type: 'box', id: boxId })) {
        Sfx.play('item_use');
        // Remember which box, so a `box_state` that arrives with no `grant` behind it can be
        // recognized as "somebody beat you to it" rather than as somebody else's pickup.
        this.pendingBox = { id: boxId, until: now + 3000 };
        this.note('You hit the item box…');
      } else this.note('Item box needs the relay — nothing rolled.');
      UI.renderPowerups(now);
    },

    // Relay -> client. Everything here is untrusted input off a socket: validate the shape,
    // ignore anything unexpected, never throw (the caller also catches).
    onRelayMessage(msg, now) {
      if (!CONFIG.POWERUPS || !msg || typeof msg !== 'object') return;
      const from = typeof msg.from === 'string' ? msg.from.slice(0, 32) : '';
      const who = typeof msg.callsign === 'string' ? msg.callsign.slice(0, 32) : '';
      if (msg.type === 'grant') {
        const item = String(msg.item || '');
        // Proto 3: the slot spins before it reveals. The item is NOT carried until the reveal
        // ends (see useSlot), so nobody fires a missile they haven't seen yet. Against an older
        // relay (or with CONFIG.ITEMS off) the grant lands instantly, exactly as in 0.9.0.
        this.pendingBox = null;
        if (Items.active() && CONFIG.BOX_ROLL_MS > 0) {
          this.roll = { frames: rouletteFrames(now + (+msg.box || 0), item, 12), item, until: now + CONFIG.BOX_ROLL_MS, startedAt: now, lastTick: 0 };
          this.note('Box roll…');
        } else {
          this.state = powerupsGrant(this.state, item);
          this.note(item === 'nothing' ? 'Box gave you nothing. Rude.' : 'You boxed ' + (POWERUP_LABELS[item] || item) + ' (Alt+3).');
        }
      } else if (msg.type === 'hit') {
        const item = String(msg.item || '');
        const res = powerupsHit(this.state, item, now, powerupDurations());
        this.state = res.state;
        if (res.blocked) { Sfx.play('shield_block'); Items.flashShield(this.callsign(), now); this.note('Shield ate ' + (from ? from + "'s " : 'a ') + (POWERUP_LABELS[item] || item) + '!'); }
        else if (res.applied) {
          Sfx.play('hit');
          // The felt half of a hit: a short shake, and (only if it has been turned on) a real
          // speed cost. Both are victim-side and neither is on the relay's word for anything
          // but "you were hit".
          if (item === 'missile') { Shake.start(500, 7, now); this.armPenalty(now); }
          else if (item === 'banana') Shake.start(250, 5, now);
          this.note(item === 'goop' ? 'You got GRILLED by goop' + (from ? ' from ' + from : '') + '!'
            : item === 'missile' ? 'Mustard missile' + (from ? ' from ' + from : '') + ' — hang on!'
            : 'Banana' + (from ? ' from ' + from : '') + ' — wobble!');
          UI.banner(item === 'goop' ? 'GRILLED' : item === 'missile' ? 'MUSTARD' : 'BANANA', undefined, 1800);
        }
      } else if (msg.type === 'box_state') {
        // Proto 3. Contested boxes: whoever got there first darkens it for everyone. The frame
        // carries a SERVER timestamp, so it goes through the same clock offset the lobby uses
        // before it can mean anything on this client's rAF clock.
        this.applyBoxState(msg, now);
      } else if (msg.type === 'boxed') {
        if (who) this.note(who + ' boxed ' + (POWERUP_LABELS[String(msg.item || '')] || 'something') + '.');
      } else if (msg.type === 'standings') {
        if (Array.isArray(msg.order)) Relay.standings = msg.order.slice(0, 16).map((x) => String(x).slice(0, 32));
        // Optional, additive (race/PROTOCOL.md "Versioning"): { callsign: [lat, lon] }. Validated
        // like everything else off a socket — anything that isn't a pair of in-range finite
        // numbers is dropped rather than drawn somewhere wrong.
        if (msg.positions && typeof msg.positions === 'object') {
          const out = {};
          for (const [cs, pair] of Object.entries(msg.positions).slice(0, 16)) {
            if (!Array.isArray(pair) || pair.length < 2) continue;
            const lat = +pair[0], lon = +pair[1];
            if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
            out[String(cs).slice(0, 32)] = { lat, lon };
          }
          Relay.positions = Object.keys(out).length ? out : null;
        }
      } else if (msg.type === 'world') {
        // Proto 3, additive: where everyone is, twice a second, so effects can be placed on
        // other pilots. Validated like every other socket payload — anything that isn't a
        // finite, in-range position is dropped rather than drawn somewhere wrong.
        if (Array.isArray(msg.players)) {
          const out = {};
          for (const raw of msg.players.slice(0, 16)) {
            if (!raw || typeof raw !== 'object') continue;
            const cs = String(raw.callsign || '').slice(0, 32);
            const lat = +raw.lat, lon = +raw.lon, alt = +raw.alt;
            if (!cs || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
            out[cs] = { lat, lon, alt: Number.isFinite(alt) ? alt : 0, gate: Math.max(0, Math.round(+raw.gate) || 0) };
          }
          Relay.world = Object.keys(out).length ? out : null;
        }
      } else if (msg.type === 'fired') {
        Items.onFired(msg, now);
      } else if (msg.type === 'resolved') {
        Items.onResolved(msg, now);
      } else if (msg.type === 'dropped') {
        Items.onDropped(msg, now);
      } else if (msg.type === 'cleared') {
        Items.onCleared(msg, now);
      } else if (msg.type === 'fx') {
        Items.onFx(msg, now);
      } else if (msg.type === 'refund') {
        // The leader firing with nobody ahead. 0.9.0 silently burned the item; proto 3 hands it
        // back, and the slot fills again so the next press actually does something.
        const item = String(msg.item || '');
        this.state = powerupsGrant(this.state, item);
        this.roll = null;                // already known — no second roulette for a refund
        UI.status('No target ahead.');
        this.note('No target ahead — ' + (POWERUP_LABELS[item] || item) + ' is still yours.');
      } else if (msg.type === 'joined') {
        Relay.proto = Number.isFinite(+msg.proto) ? +msg.proto : 0;
        Relay.status = 'Relay: in room ' + Relay.room + '.' +
          (CONFIG.ITEMS && Relay.proto < 3 ? ' Item effects off: this relay speaks proto ' + Relay.proto + ', they need 3.' : '') +
          (CONFIG.RESULTS && CONFIG.LOBBY && Relay.proto < 4 ? ' Shared results and cups off: this relay speaks proto ' + Relay.proto + ', they need 4.' : '');
      } else if (msg.type === 'error') {
        Relay.status = 'Relay: ' + String(msg.detail || 'error').slice(0, 120);
      }
      UI.renderPowerups(now);
    },

    // Boost's speed write, once per frame while the effect is live. The confirmed fields are
    // speeds, not accelerations, so the boost holds ONE absolute target fixed when it arms:
    // re-deriving target = current + 35 every frame would compound 35 m/s per frame straight
    // into the cap, which is a teleport, not a boost. `wrote` is what the panel reports.
    wrote: { scalar: false, vector: false, lla: false },
    boostUntil: 0, boostTarget: null,
    applyBoost(now, dt) {
      const base = G.currentSpeedMs();
      const cap = G.speedCap();
      const add = Math.max(0, +CONFIG.POWERUP_BOOST_ADD_MS || 0);
      const until = this.state.effects.boost;
      if (until !== this.boostUntil) {   // first frame of this boost: fix the target
        this.boostUntil = until;
        this.boostTarget = base == null ? null : powerupsBoostedSpeed(base, add, cap);
      }
      const target = this.boostTarget;
      // Never slow anyone down: if they are already past the target under their own power, an
      // absolute speed write would be a brake. Skip the frame instead.
      const res = (target != null && base != null && base < target) ? G.accelerateTo(target) : { scalar: false, vector: false };
      // No frame recorded yet => no vector write happened. Log the live one (only in stable
      // level cruise, capped) so it can be written down and stage 2 turned on.
      if (!res.vector) G.logVelocityFrame('boost', now);
      // Opt-in last resort: also move the aircraft the 0.5.0 way. The distance is bounded both
      // by the boost delta and by whatever headroom is left under speedCap(), so measured speed
      // stays at or under speedCap() + POWERUP_BOOST_ADD_MS — still clear of MAX_SPEED_MS.
      let lla = false;
      if (CONFIG.BOOST_LLA_FALLBACK) {
        const headroom = base == null ? add : Math.max(0, cap - base);
        lla = G.nudgeForward(Math.min(add, headroom) * Math.max(0, dt) / 1000);
      }
      this.wrote = { scalar: res.scalar, vector: res.vector, lla };
      return this.wrote;
    },

    // Called once per animation frame; never throws (G.* already fail closed).
    tick(now, dt) {
      if (!CONFIG.POWERUPS) return;
      this.tickRoll(now);
      this.state = powerupsPrune(this.state, now);
      if (powerupsActive(this.state, 'boost', now)) this.applyBoost(now, dt);
      // The speed penalty holds one absolute target for its whole duration, the same way Boost
      // does and for the same reason: these fields are speeds, not accelerations.
      if (now < this.penaltyUntil && this.penaltyTo != null) {
        if (powerupsActive(this.state, 'boost', now)) this.clearPenalty();   // a boost cancels it outright
        else G.setSpeedScalars(this.penaltyTo);
      } else if (this.penaltyUntil) this.clearPenalty();
      Shake.tick(now);
      // Control disruption while a banana/missile is live. Off by default (unprobed hook) — the
      // screen effect below is what actually ships. Oscillates so it wobbles rather than holds
      // a bank in, and stops the instant the effect expires.
      if (CONFIG.POWERUP_CONTROL_EFFECTS) {
        const wob = powerupsActive(this.state, 'banana', now) ? 0.3 : powerupsActive(this.state, 'missile', now) ? 0.2 : 0;
        if (wob) G.controlWobble(Math.sin(now / 120) * wob);
      }
      const spectating = CONFIG.LOBBY && Lobby.isSpectator();
      if (Relay.connected && !spectating && Race.state === 'running' && now - this.lastPing > 1000 / Math.max(0.2, CONFIG.POWERUP_POS_HZ)) {
        this.lastPing = now;
        const p = Race.pos;
        // In a lobby race (Race.goAt set), standings compare against the synced GO everyone
        // shares, not each racer's own gate-1 crossing — the leaderboard clock (Race.elapsed)
        // stays untouched for course-record comparability, but it's the wrong clock to rank a
        // lobby race by (a late starter's gate-1-relative elapsed can't be compared to anyone
        // else's).
        const ms = Race.goAt != null && Number.isFinite(Race.goElapsed) ? Race.goElapsed : Race.elapsed;
        // `alt` is additive (race/PROTOCOL.md proto 3): an old relay ignores it, and a new one
        // also reads its presence as "this client does its own banana detection".
        if (p) Relay.send({ type: 'pos', lat: p.lat, lon: p.lon, alt: +p.alt.toFixed(1), gate: Race.next, elapsed_ms: Math.round(Math.max(0, ms)) });
      }
      Items.tick(now);
      UI.renderEffects(now);
    },
  };


  // ------------------------------------------------------- items (pure helpers)
  // race/PROTOCOL.md proto 3. Everything in this block is a pure function of its arguments —
  // no clock read internally, no Cesium, no DOM, no relay — so race/test/run.js drives it with
  // plain numbers, exactly the way the powerups* functions are tested.

  // Where a projectile is right now. `from` is where the shooter WAS when it launched (fixed);
  // `to` is where the target is RIGHT NOW, re-read every frame — which is what makes the path
  // visibly bend after a moving target instead of flying a straight line to empty air.
  // Endpoints are exact: f=0 is the launch point, f=1 is the target's current position.
  function projectilePos(from, to, elapsedMs, flightMs) {
    if (!from || !to) return null;
    const a = [+from.lat, +from.lon, +from.alt], b = [+to.lat, +to.lon, +to.alt];
    if (![...a, ...b].every(Number.isFinite)) return null;
    const total = Math.max(1, +flightMs || 0);
    const f = Math.max(0, Math.min(1, (+elapsedMs || 0) / total));
    return {
      lat: a[0] + (b[0] - a[0]) * f,
      // Longitude the short way round, so a shot across the antimeridian doesn't fly the long
      // way around the planet. Everything else in this file that touches lon does the same.
      lon: wrap180(a[1] + angleDelta(a[1], b[1]) * f),
      alt: a[2] + (b[2] - a[2]) * f,
      f,
    };
  }
  const wrap180 = (d) => ((+d + 540) % 360) - 180;

  // The box roulette. A grant does not land in the slot instantly: the slot cycles icons for
  // CONFIG.BOX_ROLL_MS and then reveals what the relay actually rolled, and the item cannot be
  // fired until it does. Pure and seeded so the same grant always plays the same spin, and
  // ALWAYS ending on finalItem — the roulette is a reveal, never a second roll.
  const ROULETTE_POOL = ['banana', 'goop', 'boost', 'missile', 'shield', 'nothing'];
  function rouletteFrames(seed, finalItem, count) {
    const n = Math.max(1, Math.round(+count || 12));
    const out = [];
    let x = (Math.round(+seed) || 1) >>> 0;
    for (let i = 0; i < n - 1; i++) {
      x = (Math.imul(x, 1664525) + 1013904223) >>> 0;   // plain LCG; this is a slot machine, not a cipher
      out.push(ROULETTE_POOL[x % ROULETTE_POOL.length]);
    }
    const known = POWERUP_ITEMS.includes(finalItem) || POWERUP_HIT_ITEMS.includes(finalItem) || finalItem === 'nothing';
    out.push(known ? finalItem : 'nothing');
    return out;
  }
  // Which frame of a roulette is showing at `elapsed` into it. Past the end it is the reveal,
  // which is the same value the slot keeps forever after.
  function rouletteFrameAt(frames, elapsedMs, totalMs) {
    if (!Array.isArray(frames) || !frames.length) return null;
    const total = Math.max(1, +totalMs || 0);
    const t = Math.max(0, +elapsedMs || 0);
    if (t >= total) return frames[frames.length - 1];
    return frames[Math.min(frames.length - 1, Math.floor((t / total) * frames.length))];
  }

  // The optional speed penalty's target (CONFIG.POWERUP_SPEED_PENALTY, default OFF). 25% off
  // what you are doing, but never below the floor — a penalty that can stall the aircraft is a
  // crash, not a penalty, and this is the function that makes that impossible to get wrong.
  function penaltyTarget(currentMs, floorMs) {
    const cur = +currentMs, floor = Math.max(0, +floorMs || 0);
    if (!Number.isFinite(cur) || cur <= 0) return null;
    return Math.max(floor, cur * 0.75);
  }

  // ------------------------------------------------------------------ items
  // The visible half of the powerups layer (0.10.0, relay proto 3). Owns every world-space item
  // effect and the HUD's inbound-missile warning. Three rules it never breaks:
  //
  //  * it is gated on Relay.proto >= 3. Against an older relay none of this is wired up at all
  //    and the client behaves exactly like 0.9.0, with one note on the status line.
  //  * every Cesium call goes through makeItemLayer(); nothing here touches the viewer directly.
  //  * nothing here can throw into the race loop — the layer fails closed, and tick() is called
  //    from inside loop()'s own try/catch besides.
  //
  // Positions for other pilots come from G.otherPilot() first (GeoFS's own interpolated
  // multiplayer users, which is smooth) and fall back to the relay's 2 Hz `world` frame.
  const ITEM_COLORS = { missile: '#ffd23d', goop: '#7ad42a', banana: '#ffe14d', boost: '#ff8a3d', shield: '#5bd6ff' };

  const Items = {
    layer: null,
    projectiles: new Map(),   // id -> {id, item, from, target, launchedAt, flightMs, fromPos, trail}
    bananas: new Map(),       // id -> {id, lat, lon, alt, from, armedAt, center}
    gooped: new Map(),        // callsign -> the rAF time their goop runs out; drives the trailing blob
    fx: new Map(),            // callsign -> {boostUntil, shieldUntil, flashUntil, trail: [[t,lon,lat,alt]]}
    claimed: new Set(),       // banana ids this client has already sent a `tripped` for
    inbound: null,            // the projectile aimed at ME, for the HUD warning
    lastIncomingSfx: 0, _lastEcef: null,

    // True once the relay has actually proven it speaks proto 3. Never guessed: an old relay
    // simply never sets Relay.proto, and then this whole module stays dark.
    active() { return CONFIG.ITEMS && CONFIG.POWERUPS && Relay.proto >= 3; },

    ensure() {
      if (!this.layer) this.layer = makeItemLayer();
      return this.layer;
    },
    reset() {
      this.projectiles.clear();
      this.bananas.clear();
      this.gooped.clear();
      this.fx.clear();
      this.claimed.clear();
      this.inbound = null;
      this._lastEcef = null;
      if (this.layer) this.layer.clear();
    },

    // ---- relay frames ---------------------------------------------------
    onFired(msg, now) {
      if (!this.active()) return;
      const id = String(msg.id);
      const item = String(msg.item || '');
      if (!['missile', 'goop'].includes(item)) return;
      const flightMs = Math.max(1, Math.min(10000, +msg.flight_ms || 0));
      const from = String(msg.from || '').slice(0, 32), target = String(msg.target || '').slice(0, 32);
      const fromPos = this.pilotPos(from);
      const p = {
        id, item, from, target, flightMs, launchedAt: now,
        fromPos: fromPos || this.pilotPos(target) || (Race.pos ? { ...Race.pos } : null),
        trail: [],
      };
      this.projectiles.set(id, p);
      const me = Powerups.callsign();
      if (target === me) {
        this.inbound = p;
        this.lastIncomingSfx = 0;
        Sfx.play('incoming');
        UI.banner(item === 'goop' ? 'GOOP INBOUND' : 'MISSILE INBOUND', 'from ' + from, 1400);
        Powerups.note((item === 'goop' ? 'GOOP' : 'MISSILE') + ' INBOUND from ' + from + '!');
      } else if (from === me) {
        Sfx.play('launch');
        Powerups.note('Your ' + POWERUP_LABELS[item] + ' is away — tracking ' + target + '.');
      } else {
        Sfx.play('launch');
        Powerups.note(from + ' fired ' + POWERUP_LABELS[item] + ' at ' + target + '.');
      }
    },

    onResolved(msg, now) {
      if (!this.active()) return;
      const id = String(msg.id);
      const p = this.projectiles.get(id);
      this.projectiles.delete(id);
      if (this.inbound && this.inbound.id === id) this.inbound = null;
      const layer = this.ensure();
      layer.drop('proj:' + id);
      if (msg.lost) return;   // the target left mid-flight; nothing landed anywhere
      const item = String(msg.item || (p && p.item) || 'missile');
      const target = String(msg.target || (p && p.target) || '').slice(0, 32);
      const from = String(msg.from || (p && p.from) || '').slice(0, 32);
      const at = this.pilotPos(target) || (p && p.fromPos) || null;
      if (!at) return;
      if (msg.blocked) {
        this.ring(id, at, now);
        this.flashShield(target, now);
        if (target !== Powerups.callsign()) {   // my own block is already narrated by powerupsHit
          Sfx.play('shield_block');
          Powerups.note(target + "'s shield ate " + from + "'s " + POWERUP_LABELS[item] + '.');
        }
        return;
      }
      if (target !== Powerups.callsign()) {
        Sfx.play('impact');
        Powerups.note(POWERUP_LABELS[item] + ' got ' + target + '!');
      }
      this.splat(id, item, at, now);
      // Goop is the one hit that lasts: the victim gets the screen overlay (via the `hit` frame
      // and powerupsHit), and EVERYONE ELSE gets a green blob trailing their aircraft for the
      // same duration, so from the outside you can see who is currently covered in it.
      if (item === 'goop' && target) this.gooped.set(target, now + (+CONFIG.POWERUP_GOOP_MS || 0));
    },

    // A banana somebody dropped. It is a real object in the world from this moment on: drawn
    // for everyone, armed a moment later, and cleared only by a `cleared` frame or its own TTL.
    onDropped(msg, now) {
      if (!this.active()) return;
      const id = String(msg.id);
      const lat = +msg.lat, lon = +msg.lon, alt = +msg.alt;
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return;
      const from = String(msg.from || '').slice(0, 32);
      // armed_at is a SERVER timestamp; it goes through the same clock offset everything else
      // does before it can mean anything against this client's rAF clock.
      const armedServer = +msg.armed_at_server_ms;
      const armedLocal = Number.isFinite(armedServer)
        ? now + Math.max(0, Math.min(10000, (CONFIG.LOBBY ? Lobby.toLocalMs(armedServer) : armedServer) - Date.now()))
        : now;
      this.bananas.set(id, { id, lat, lon, alt: Number.isFinite(alt) ? alt : 0, from,
        armedAt: armedLocal, center: ecef(lat, lon, Number.isFinite(alt) ? alt : 0) });
      this.drawBanana(id, now);
      Sfx.play('banana_drop');
      if (from === Powerups.callsign()) Powerups.note('Banana away — mind your six.');
      else Powerups.note(from + ' dropped a banana.');
    },

    // A banana left the world: somebody hit it, a shield ate it, or it timed out.
    onCleared(msg, now) {
      if (!this.active()) return;
      const id = String(msg.id);
      const b = this.bananas.get(id);
      this.bananas.delete(id);
      this.claimed.delete(id);
      const layer = this.ensure();
      layer.drop('ban:' + id);
      layer.drop('ban2:' + id);
      const by = String(msg.by || '').slice(0, 32);
      const reason = String(msg.reason || '');
      if (reason === 'expired' || !by) return;   // nobody to narrate
      if (b) this.splat(id, 'banana', b, now);
      if (reason === 'blocked') this.flashShield(by, now);
      if (by === Powerups.callsign()) return;    // powerupsHit already narrated my own hit
      Sfx.play(reason === 'blocked' ? 'shield_block' : 'banana_pop');
      Powerups.note(reason === 'blocked' ? by + "'s shield ate a banana." : by + ' hit a banana!');
    },

    // Somebody's Boost or Shield lit up. Cosmetic in both directions: the relay rebroadcasts
    // it, the client draws it, and nothing about it changes what an item does. (The relay does
    // keep a shield window from the same frame — see race/PROTOCOL.md's trust model — but that
    // is the relay's bookkeeping, not this.)
    onFx(msg, now) {
      if (!this.active()) return;
      const cs = String(msg.callsign || '').slice(0, 32);
      const item = String(msg.item || '');
      if (!cs || !['boost', 'shield'].includes(item)) return;
      const ms = Math.max(0, Math.min(30000, +msg.ms || 0));
      const rec = this.fx.get(cs) || { boostUntil: 0, shieldUntil: 0, flashUntil: 0, trail: [] };
      if (item === 'boost') rec.boostUntil = now + ms; else rec.shieldUntil = now + ms;
      this.fx.set(cs, rec);
      if (cs !== Powerups.callsign()) {
        Sfx.play('fx_other');
        Powerups.note(cs + (item === 'boost' ? ' hit the boost!' : ' put a shield up.'));
      }
    },

    // A shield that just ate something flashes white. Called from wherever a block is learned:
    // a blocked projectile resolution, and a banana cleared with reason 'blocked'.
    flashShield(callsign, now) {
      const rec = this.fx.get(callsign);
      if (rec) rec.flashUntil = now + 350;
    },

    // ---- world-space effects -------------------------------------------
    // An expanding sphere where something landed. 400 ms, then gone — the TTL in the layer is
    // the only thing that ends it, so a lost frame cannot strand it.
    splat(id, item, at, now) {
      const layer = this.ensure();
      const born = now;
      const color = ITEM_COLORS[item] || ITEM_COLORS.missile;
      layer.add('splat:' + id, {
        position: Cesium.Cartesian3.fromDegrees(at.lon, at.lat, at.alt),
        ellipsoid: { radii: new Cesium.Cartesian3(20, 20, 20),
          material: Cesium.Color.fromCssColorString(color).withAlpha(0.55) },
      }, 450, now);
      layer.edit('splat:' + id, (ent) => { ent.__born = born; ent.__splat = color; });
    },
    // A white ring flash: a shield ate it.
    ring(id, at, now) {
      const layer = this.ensure();
      layer.add('ring:' + id, {
        position: Cesium.Cartesian3.fromDegrees(at.lon, at.lat, at.alt),
        ellipsoid: { radii: new Cesium.Cartesian3(40, 40, 40),
          material: Cesium.Color.WHITE.withAlpha(0.5) },
      }, 450, now);
      layer.edit('ring:' + id, (ent) => { ent.__born = now; ent.__ring = true; });
    },

    // Two crossed yellow ellipsoids and a pole to the ground, so a banana reads as an object
    // sitting in the air rather than a stray sphere — the pole is the same trick the gates use.
    // No asset download: this is the whole model. Two entities per banana (the second ellipsoid
    // is the cross), which keeps eight of them well inside the layer's budget.
    drawBanana(id, now) {
      const b = this.bananas.get(id);
      const layer = this.ensure();
      if (!b || !layer.ok || !G.ready()) return;
      const alt = b.alt + CONFIG.ALT_OFFSET_M;
      const yellow = () => Cesium.Color.fromCssColorString(ITEM_COLORS.banana);
      const canRotate = !!(window.Cesium && Cesium.Transforms &&
        typeof Cesium.Transforms.headingPitchRollQuaternion === 'function' && Cesium.HeadingPitchRoll);
      const position = Cesium.Cartesian3.fromDegrees(b.lon, b.lat, alt);
      const ttl = Math.max(1000, +CONFIG.BANANA_TTL_MS || 120000);
      const arm = (roll) => canRotate
        ? { orientation: Cesium.Transforms.headingPitchRollQuaternion(position, new Cesium.HeadingPitchRoll(0, 0, roll)) }
        : {};
      layer.add('ban:' + id, {
        position,
        ellipsoid: { radii: new Cesium.Cartesian3(45, 14, 14), material: yellow().withAlpha(0.8) },
        ...arm(0.6),
        polyline: { positions: Cesium.Cartesian3.fromDegreesArrayHeights([b.lon, b.lat, alt, b.lon, b.lat, 0]),
          width: 2, material: yellow().withAlpha(0.3) },
      }, ttl, now);
      layer.add('ban2:' + id, {
        position,
        ellipsoid: { radii: new Cesium.Cartesian3(45, 14, 14), material: yellow().withAlpha(0.8) },
        ...arm(-0.6),
      }, ttl, now);
    },

    // Where a pilot is: GeoFS's own smooth multiplayer position when the callsign matches,
    // otherwise the relay's `world` frame, otherwise (for me) my own live position.
    pilotPos(callsign) {
      if (!callsign) return null;
      if (callsign === Powerups.callsign() && Race.pos) return { ...Race.pos };
      const mp = G.ready() ? G.otherPilot(callsign) : null;
      if (mp) return mp;
      const w = Relay.world && Relay.world[callsign];
      return w ? { lat: w.lat, lon: w.lon, alt: w.alt, source: 'relay' } : null;
    },

    // ---- per frame ------------------------------------------------------
    tick(now) {
      if (!this.active()) { if (this.layer && this.layer.count()) this.layer.clear(); return; }
      const layer = this.ensure();
      if (!layer.ok) return;
      layer.prune(now);
      this.tickProjectiles(now);
      this.tickBananas(now);
      this.tickGoop(now);
      this.tickFx(now);
      this.tickSplats(now);
      this.tickIncomingSfx(now);
    },

    // Two jobs. The pulse, which is how an armed banana reads differently from one that cannot
    // hurt you yet; and the detection, which moved client-side in proto 3 because the relay's
    // 2 Hz `pos` pings tunnel straight through an 80 m sphere at race speed. The test is the
    // same interpolated segHit() the gates use, in 3D, against this frame's own travel — so it
    // catches the banana at 400 kt for the same reason a gate does.
    //
    // Only while actually racing: a banana is a race hazard, not something to eat while you are
    // still lining up on the start sphere.
    tickBananas(now) {
      const layer = this.layer;
      const me = Powerups.callsign();

      for (const b of this.bananas.values()) {
        const armed = now >= b.armedAt;
        // Pulse once armed, dim and steady before that.
        const a = armed ? 0.55 + 0.3 * (0.5 + 0.5 * Math.sin(now / 180)) : 0.3;
        for (const key of ['ban:' + b.id, 'ban2:' + b.id]) {
          layer.edit(key, (ent) => {
            if (ent.ellipsoid) ent.ellipsoid.material = Cesium.Color.fromCssColorString(ITEM_COLORS.banana).withAlpha(a);
          });
        }
      }

      const p = Race.pos;
      if (!p) { this._lastEcef = null; return; }
      const here = ecef(p.lat, p.lon, p.alt);
      const prev = this._lastEcef;
      this._lastEcef = here;
      if (!prev || Race.state !== 'running') return;
      if (CONFIG.LOBBY && Lobby.isSpectator()) return;
      const r = Math.max(1, +CONFIG.BANANA_RADIUS_M || 80);
      for (const b of this.bananas.values()) {
        if (b.from === me || now < b.armedAt || this.claimed.has(b.id)) continue;
        if (segHit(prev, here, b.center, r) < 0) continue;
        // Claim it exactly once. The relay validates the claim against my own last reported
        // position and is the only thing that can actually clear it or apply the hit.
        this.claimed.add(b.id);
        Relay.send({ type: 'tripped', id: +b.id });
        return;
      }
    },

    tickProjectiles(now) {
      const layer = this.layer;
      for (const p of [...this.projectiles.values()]) {
        const elapsed = now - p.launchedAt;
        // A resolution that never arrived (dropped socket). The layer's TTL would clean the
        // entity up anyway; this drops the bookkeeping with it so the HUD warning clears too.
        if (elapsed > p.flightMs + 3000) {
          this.projectiles.delete(p.id);
          if (this.inbound && this.inbound.id === p.id) this.inbound = null;
          layer.drop('proj:' + p.id);
          continue;
        }
        const to = this.pilotPos(p.target);
        const pos = projectilePos(p.fromPos, to, elapsed, p.flightMs);
        if (!pos) continue;
        p.last = pos;
        p.trail.push([pos.lon, pos.lat, pos.alt]);
        while (p.trail.length > Math.max(2, +CONFIG.PROJECTILE_TRAIL_N || 12)) p.trail.shift();
        const key = 'proj:' + p.id;
        const color = Cesium.Color.fromCssColorString(ITEM_COLORS[p.item] || ITEM_COLORS.missile);
        if (!layer.get(key)) {
          layer.add(key, {
            position: Cesium.Cartesian3.fromDegrees(pos.lon, pos.lat, pos.alt),
            point: { pixelSize: 14, color, outlineColor: Cesium.Color.WHITE.withAlpha(0.8), outlineWidth: 2,
              disableDepthTestDistance: Number.POSITIVE_INFINITY },
            polyline: { positions: Cesium.Cartesian3.fromDegreesArrayHeights(p.trail.flat()),
              width: 5, material: color.withAlpha(0.6),
              arcType: Cesium.ArcType ? Cesium.ArcType.NONE : undefined },
          }, p.flightMs + 1500, now);
        } else {
          layer.edit(key, (ent) => {
            ent.position = Cesium.Cartesian3.fromDegrees(pos.lon, pos.lat, pos.alt);
            if (ent.polyline && p.trail.length >= 2) {
              ent.polyline.positions = Cesium.Cartesian3.fromDegreesArrayHeights(p.trail.flat());
            }
          });
        }
      }
    },

    // A green blob riding whoever is currently gooped. Drawn for other pilots only — my own
    // goop is the screen overlay, and a blob over my own nose would just be a second one.
    tickGoop(now) {
      const layer = this.layer;
      const me = Powerups.callsign();
      for (const [cs, until] of [...this.gooped.entries()]) {
        const key = 'goop:' + cs;
        if (now >= until) { this.gooped.delete(cs); layer.drop(key); continue; }
        if (cs === me) continue;
        const at = this.pilotPos(cs);
        if (!at) continue;
        const color = Cesium.Color.fromCssColorString(ITEM_COLORS.goop).withAlpha(0.7);
        if (!layer.get(key)) {
          layer.add(key, {
            position: Cesium.Cartesian3.fromDegrees(at.lon, at.lat, at.alt),
            ellipsoid: { radii: new Cesium.Cartesian3(18, 18, 14), material: color },
          }, Math.max(500, +CONFIG.POWERUP_GOOP_MS || 4000) + 1000, now);
        } else {
          layer.edit(key, (ent) => {
            ent.position = Cesium.Cartesian3.fromDegrees(at.lon, at.lat, at.alt);
          });
        }
      }
    },

    // Boost trails and shield bubbles, for the pilot flying them and for everyone watching.
    //
    // The boost trail is the last CONFIG.BOOST_TRAIL_MS of that aircraft's positions, sampled
    // here rather than taken from the trace recorder, because it has to work for other pilots
    // too and the recorder only ever records me.
    tickFx(now) {
      const layer = this.layer;
      for (const [cs, rec] of [...this.fx.entries()]) {
        const boosting = now < rec.boostUntil, shielded = now < rec.shieldUntil;
        if (!boosting && !shielded && now > rec.shieldUntil + 1000) { this.fx.delete(cs); }
        const at = this.pilotPos(cs);

        // ---- boost: an orange glow trail behind them
        const bkey = 'fxb:' + cs;
        if (boosting && at) {
          rec.trail.push([now, at.lon, at.lat, at.alt]);
          const keep = Math.max(200, +CONFIG.BOOST_TRAIL_MS || 1500);
          while (rec.trail.length && now - rec.trail[0][0] > keep) rec.trail.shift();
          while (rec.trail.length > 60) rec.trail.shift();
          if (rec.trail.length >= 2) {
            const pts = rec.trail.flatMap(([, lon, lat, alt]) => [lon, lat, alt]);
            const color = Cesium.Color.fromCssColorString(ITEM_COLORS.boost);
            if (!layer.get(bkey)) {
              const glow = typeof Cesium.PolylineGlowMaterialProperty === 'function'
                ? new Cesium.PolylineGlowMaterialProperty({ glowPower: 0.35, color })
                : color.withAlpha(0.8);
              layer.add(bkey, { polyline: { positions: Cesium.Cartesian3.fromDegreesArrayHeights(pts),
                width: 10, material: glow, arcType: Cesium.ArcType ? Cesium.ArcType.NONE : undefined } },
                keep + 1000, now);
            } else {
              layer.touch(bkey, keep + 1000, now);
              layer.edit(bkey, (ent) => { ent.polyline.positions = Cesium.Cartesian3.fromDegreesArrayHeights(pts); });
            }
          }
        } else if (!boosting) {
          rec.trail.length = 0;
          layer.drop(bkey);
        }

        // ---- shield: a translucent cyan bubble, flashing white when it eats something
        const skey = 'fxs:' + cs;
        if (shielded && at) {
          const flashing = now < rec.flashUntil;
          const color = (flashing ? Cesium.Color.WHITE : Cesium.Color.fromCssColorString(ITEM_COLORS.shield))
            .withAlpha(flashing ? 0.75 : 0.22);
          if (!layer.get(skey)) {
            layer.add(skey, {
              position: Cesium.Cartesian3.fromDegrees(at.lon, at.lat, at.alt),
              ellipsoid: { radii: new Cesium.Cartesian3(30, 30, 24), material: color },
            }, Math.max(1000, rec.shieldUntil - now) + 1000, now);
          } else {
            layer.edit(skey, (ent) => {
              ent.position = Cesium.Cartesian3.fromDegrees(at.lon, at.lat, at.alt);
              if (ent.ellipsoid) ent.ellipsoid.material = color;
            });
          }
        } else if (!shielded) {
          layer.drop(skey);
        }
      }
    },

    // Splats expand and fade over their 400 ms. Done by editing radii, not by rebuilding.
    tickSplats(now) {
      const layer = this.layer;
      for (const key of layer.keys()) {
        if (!key.startsWith('splat:') && !key.startsWith('ring:')) continue;
        layer.edit(key, (ent) => {
          const born = +ent.__born || now;
          const f = Math.max(0, Math.min(1, (now - born) / 400));
          const r = ent.__ring ? 40 + 160 * f : 20 + 130 * f;
          if (ent.ellipsoid) {
            ent.ellipsoid.radii = new Cesium.Cartesian3(r, r, r);
            const base = ent.__ring ? Cesium.Color.WHITE : Cesium.Color.fromCssColorString(ent.__splat || ITEM_COLORS.missile);
            ent.ellipsoid.material = base.withAlpha(Math.max(0, 0.55 * (1 - f)));
          }
        });
      }
    },

    // The `incoming` cue, accelerating as the projectile closes. Two beeps a second at launch,
    // eight a second on the last stretch — the sound is the countdown.
    tickIncomingSfx(now) {
      const p = this.inbound;
      if (!p) return;
      const f = Math.max(0, Math.min(1, (now - p.launchedAt) / p.flightMs));
      const interval = 500 - 380 * f;
      if (now - this.lastIncomingSfx < interval) return;
      this.lastIncomingSfx = now;
      Sfx.play('incoming');
    },
  };

  // --------------------------------------------------------------- hit shake
  // A CSS transform jitter on the element GeoFS renders into. DOM style and nothing else: it
  // never touches the aircraft, never touches physics, is removed both on a timer and on reset,
  // and restores whatever transform the element already had. Off under prefers-reduced-motion
  // (the shake IS the motion — there is no non-moving version of it to keep) and off entirely
  // with CONFIG.HIT_SHAKE false.
  const Shake = {
    el: null, prevTransform: null, until: 0, mag: 0,

    reduced() {
      try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); }
      catch (_) { return false; }
    },

    start(ms, mag, now) {
      if (!CONFIG.HIT_SHAKE || this.reduced()) return false;
      const el = G.renderCanvas();
      if (!el || !el.style) return false;
      if (this.el !== el) { this.stop(); this.el = el; this.prevTransform = el.style.transform || ''; }
      // A second hit during a shake extends it and takes the bigger magnitude — never stacks
      // into something that would make the gate unflyable.
      this.until = Math.max(this.until, now + Math.max(0, +ms || 0));
      this.mag = Math.max(this.mag, Math.max(0, +mag || 0));
      return true;
    },

    tick(now) {
      if (!this.el) return;
      if (now >= this.until) { this.stop(); return; }
      const left = (this.until - now);
      // Decays as it ends, so it stops rather than being cut off.
      const a = this.mag * Math.min(1, left / 250);
      const x = Math.sin(now / 17) * a, y = Math.cos(now / 13) * a;
      try { this.el.style.transform = 'translate3d(' + x.toFixed(2) + 'px,' + y.toFixed(2) + 'px,0)'; } catch (_) { this.stop(); }
    },

    stop() {
      const el = this.el;
      this.el = null; this.until = 0; this.mag = 0;
      if (!el) return;
      try { el.style.transform = this.prevTransform || ''; } catch (_) {}
      this.prevTransform = null;
    },
  };

  // ------------------------------------------------------------------------- sfx
  // Pure recipe table first (race/test/run.js asserts every name resolves with no AudioContext
  // at all): oscillator type + a two-point frequency envelope (freq -> freq2) + duration in
  // seconds. Sfx.play() below is the only thing that ever touches WebAudio, and it never throws
  // — a missing/blocked AudioContext, or an unknown name, just means silence.
  const SFX_NAMES = ['count_tick', 'count_go', 'gate', 'gate_pb', 'finish', 'dq', 'box_roll_tick',
    'box_grant', 'item_use', 'shield_up', 'shield_block', 'hit', 'incoming', 'lobby_ready', 'lobby_all_ready',
    // 0.10.0 items. Every visible item event gets a cue as well as a feed line, so you can tell
    // what just happened without reading the top-right corner mid-corner.
    'launch', 'impact', 'banana_drop', 'banana_pop', 'fx_other', 'box_dark',
    // 0.11.0: a fanfare variant of 'finish' for the winner of a lobby race. It layers over the
    // ordinary finish cue rather than replacing it (the winner is only known a moment later).
    'finish_p1'];
  function sfxPatch(name) {
    switch (name) {
      case 'count_tick': return { type: 'square', freq: 440, freq2: 440, duration: 0.07 };
      case 'count_go': return { type: 'sawtooth', freq: 220, freq2: 880, duration: 0.4 };
      case 'gate': return { type: 'sine', freq: 660, freq2: 660, duration: 0.12 };
      case 'gate_pb': return { type: 'sine', freq: 880, freq2: 1320, duration: 0.18 };
      case 'finish': return { type: 'triangle', freq: 440, freq2: 880, duration: 0.6 };
      case 'dq': return { type: 'sawtooth', freq: 200, freq2: 80, duration: 0.5 };
      case 'box_roll_tick': return { type: 'square', freq: 330, freq2: 330, duration: 0.04 };
      case 'box_grant': return { type: 'triangle', freq: 523, freq2: 1046, duration: 0.3 };
      case 'item_use': return { type: 'square', freq: 300, freq2: 500, duration: 0.15 };
      case 'shield_up': return { type: 'sine', freq: 400, freq2: 700, duration: 0.25 };
      case 'shield_block': return { type: 'square', freq: 700, freq2: 300, duration: 0.2 };
      case 'hit': return { type: 'sawtooth', freq: 180, freq2: 60, duration: 0.35 };
      case 'incoming': return { type: 'triangle', freq: 260, freq2: 260, duration: 0.5 };
      case 'lobby_ready': return { type: 'sine', freq: 523, freq2: 523, duration: 0.1 };
      case 'lobby_all_ready': return { type: 'sine', freq: 523, freq2: 1046, duration: 0.35 };
      // ---- items (0.10.0)
      case 'launch': return { type: 'sawtooth', freq: 140, freq2: 520, duration: 0.25 };
      case 'impact': return { type: 'square', freq: 220, freq2: 70, duration: 0.22 };
      case 'banana_drop': return { type: 'triangle', freq: 600, freq2: 260, duration: 0.18 };
      case 'banana_pop': return { type: 'square', freq: 420, freq2: 140, duration: 0.25 };
      case 'fx_other': return { type: 'sine', freq: 300, freq2: 520, duration: 0.14 };
      case 'box_dark': return { type: 'square', freq: 260, freq2: 160, duration: 0.12 };
      case 'finish_p1': return { type: 'square', freq: 523, freq2: 1568, duration: 0.9 };
      default: return null;
    }
  }
  // One lazily-created AudioContext, resumed on the first user gesture (README: the bookmarklet
  // click already counts, and UI.init() also wires the panel). Muted state persists via store.
  // play() never throws: a blocked/missing AudioContext, a muted session, or an unknown name are
  // all silent no-ops, same posture as every G.* method.
  const Sfx = {
    ctx: null, master: null, resumed: false, muted: false,
    init() {
      try { this.muted = !!store.get('sfxMuted', false); } catch (_) {}
      const resume = () => this.resume();
      window.addEventListener('pointerdown', resume, { capture: true, once: true });
      window.addEventListener('keydown', resume, { capture: true, once: true });
    },
    resume() {
      if (this.resumed) return;
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        this.resumed = true; // set even if construction throws below: never retry-loop a broken AC
        this.ctx = new AC();
        this.master = this.ctx.createGain();
        this.master.gain.value = Math.max(0, Math.min(1, +CONFIG.SFX_VOLUME || 0));
        this.master.connect(this.ctx.destination);
        if (this.ctx.state === 'suspended' && typeof this.ctx.resume === 'function') this.ctx.resume().catch(() => {});
      } catch (_) {}
    },
    setMuted(v) { this.muted = !!v; try { store.set('sfxMuted', this.muted); } catch (_) {} },
    play(name) {
      try {
        if (this.muted || !this.ctx || !this.master) return;
        const p = sfxPatch(name);
        if (!p) return;
        const ctx = this.ctx, t0 = ctx.currentTime;
        const osc = ctx.createOscillator(), gain = ctx.createGain();
        osc.type = p.type;
        osc.frequency.setValueAtTime(Math.max(1, p.freq), t0);
        if (p.freq2 !== p.freq) osc.frequency.exponentialRampToValueAtTime(Math.max(1, p.freq2), t0 + p.duration);
        gain.gain.setValueAtTime(0.0001, t0);
        gain.gain.exponentialRampToValueAtTime(0.9, t0 + Math.min(0.01, p.duration / 4));
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + p.duration);
        osc.connect(gain); gain.connect(this.master);
        osc.start(t0); osc.stop(t0 + p.duration + 0.02);
      } catch (_) {}
    },
  };

  // ------------------------------------------------------------------ HUD (pure helpers)
  // Turns Relay.standings (leader-first array of callsigns; see race/PROTOCOL.md's `standings`
  // frame) plus your own callsign into up to 8 tower rows. The relay protocol carries no other
  // player's elapsed time or model — only order — so `gapsMs` (callsign -> ms behind the leader)
  // is an optional, currently-always-empty map kept for a future protocol version (see
  // PROTOCOL.md "Versioning"); until then every row but yours reads blank in that column. This
  // is a real limitation, not a bug — see race/ACCEPTANCE.md step 2.3.
  function hudTowerRows(standings, myCallsign, gapsMs, myModel) {
    if (!Array.isArray(standings) || standings.length < 2) return [];
    const gaps = gapsMs && typeof gapsMs === 'object' ? gapsMs : {};
    return standings.slice(0, 8).map((callsign, i) => ({
      rank: i + 1,
      callsign: String(callsign),
      model: callsign === myCallsign ? String(myModel || '') : '',
      gap: i === 0 ? '' : (Number.isFinite(gaps[callsign]) ? '+' + (gaps[callsign] / 1000).toFixed(1) : ''),
      isMe: callsign === myCallsign,
    }));
  }
  // The top-left position block ("2ND of 5", gap-to-car-ahead). null when solo or the relay
  // hasn't sent a standings frame yet (or you're not in it) — the whole block hides then.
  function hudPositionInfo(standings, myCallsign) {
    if (!Array.isArray(standings) || standings.length < 2) return null;
    const rank = standings.indexOf(myCallsign);
    if (rank < 0) return null;
    return { rank: rank + 1, total: standings.length, ahead: rank > 0 ? String(standings[rank - 1]) : null };
  }
  // Gate pip row: one pip per non-start gate (course.gates[1..N-1], i.e. gateCount-1 pips),
  // 'done' | 'next' | 'remaining'. `next` is Race.next (0 while armed, course.gates.length once
  // finished/dq'd — every pip reads 'done' then).
  function hudPipStates(next, gateCount) {
    const n = Math.max(0, Math.round(+gateCount || 0) - 1);
    // While armed (next === 0, i.e. still inside/approaching the start sphere), the gate you are
    // actually heading for is gate 1, not gate 0 — the start line itself has no pip.
    const target = next === 0 ? 1 : next;
    const out = [];
    for (let i = 0; i < n; i++) {
      const gateIndex = i + 1;
      out.push(gateIndex < target ? 'done' : gateIndex === target ? 'next' : 'remaining');
    }
    return out;
  }

  // ------------------------------------------------------ trace recorder (pure)
  // A trace is one recorded run: { samples: [[t, lat, lon, alt, heading, pitch, roll], ...],
  // truncated: bool }, sampled at CONFIG.TRACE_HZ while Race.state === 'running' and timed from
  // t = 0 at your own gate-1 (start-gate) crossing — i.e. exactly Race.elapsed, the same clock
  // the leaderboard uses. That shared origin is what lets traceSampleAt(trace, Race.elapsed)
  // place a ghost: it launches when YOU launch, not on some absolute wall clock.
  //
  // Everything in this section is pure — no Cesium, no GeoFS, no storage, no clock. The impure
  // half (sampling from the frame, saving to localStorage) is the Recorder module below.

  // Quantization is part of the format, not a display choice: it is what keeps 6000 samples
  // inside a localStorage entry and a POST body. 6 dp of latitude is ~0.1 m, far finer than a
  // gate radius; 0.1 m of altitude and 0.1 deg of attitude are likewise below anything visible.
  const qFixed = (x, dp) => { const f = Math.pow(10, dp); return Math.round(x * f) / f; };
  const wrap360 = (d) => ((d % 360) + 360) % 360;
  // Shortest arc from a to b, signed, in (-180, 180]. The one operation every angle in a trace
  // needs: interpolating 350 -> 10 must cross 360, not run the long way round through 180.
  function angleDelta(a, b) { return ((b - a + 540) % 360) - 180; }
  function angleLerp(a, b, f) { return a + angleDelta(a, b) * f; }
  const headingLerp = (a, b, f) => wrap360(angleLerp(a, b, f));

  function traceEmpty() { return { samples: [], truncated: false }; }

  // One raw per-frame reading -> one quantized sample row, or null if the position is unusable.
  // Attitude that reads as anything but a number becomes 0 rather than dropping the sample: a
  // gap in the path is worse than a ghost that briefly flies wings-level.
  function traceQuantize(s) {
    if (!s) return null;
    const t = Math.round(+s.t), lat = +s.lat, lon = +s.lon, alt = +s.alt;
    if (![t, lat, lon, alt].every(Number.isFinite) || t < 0 || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    const ang = (x) => (Number.isFinite(+x) ? qFixed(+x, 1) : 0);
    return [t, qFixed(lat, 6), qFixed(lon, 6), qFixed(alt, 1), qFixed(wrap360(+s.heading || 0), 1), ang(s.pitch), ang(s.roll)];
  }

  // Append at no more than `hz` samples per second, stopping (and marking the trace truncated)
  // at `max`. Pure: returns the same trace object when nothing was appended, a new one when
  // something was. A truncated trace is never saved — see Recorder.saveIfBest().
  function traceAppend(trace, s, hz, max) {
    const tr = trace && Array.isArray(trace.samples) ? trace : traceEmpty();
    if (tr.truncated) return tr;
    const cap = Math.max(1, Math.round(+max) || 1);
    const q = traceQuantize(s);
    if (!q) return tr;
    const last = tr.samples[tr.samples.length - 1];
    const minGap = 1000 / Math.max(0.1, +hz || 1);
    // Strictly increasing t is a format invariant the server also validates, so a sample at or
    // before the last one is dropped even when the rate gate would have let it through.
    if (last && (q[0] - last[0] < minGap || q[0] <= last[0])) return tr;
    if (tr.samples.length >= cap) return { samples: tr.samples, truncated: true };
    return { samples: tr.samples.concat([q]), truncated: false };
  }

  // Wire format: columnar arrays, t delta-encoded (t[0] absolute, the rest gaps). At 4 Hz the
  // gaps are all ~250, which compresses to almost nothing once GZipMiddleware sees it, and the
  // columnar shape keeps each column's numbers the same magnitude.
  const TRACE_ENC_V = 1;
  function traceEncode(trace) {
    const rows = (trace && Array.isArray(trace.samples) ? trace.samples : []).filter((r) => Array.isArray(r) && r.length >= 7);
    const t = [], lat = [], lon = [], alt = [], hdg = [], pitch = [], roll = [];
    let prevT = 0;
    rows.forEach((r, i) => {
      t.push(i === 0 ? r[0] : r[0] - prevT);
      prevT = r[0];
      lat.push(r[1]); lon.push(r[2]); alt.push(r[3]); hdg.push(r[4]); pitch.push(r[5]); roll.push(r[6]);
    });
    return { v: TRACE_ENC_V, n: rows.length, t, lat, lon, alt, hdg, pitch, roll };
  }
  // The inverse, and the only way an untrusted trace (off the network or out of localStorage)
  // ever becomes one: anything malformed returns null rather than a half-built trace.
  function traceDecode(enc) {
    if (!enc || typeof enc !== 'object' || +enc.v !== TRACE_ENC_V) return null;
    const cols = ['t', 'lat', 'lon', 'alt', 'hdg', 'pitch', 'roll'].map((k) => enc[k]);
    if (!cols.every(Array.isArray)) return null;
    const n = cols[0].length;
    if (!cols.every((c) => c.length === n)) return null;
    if (enc.n != null && +enc.n !== n) return null;
    const samples = [];
    let t = 0;
    for (let i = 0; i < n; i++) {
      t = i === 0 ? +cols[0][0] : t + +cols[0][i];
      const row = [Math.round(t), +cols[1][i], +cols[2][i], +cols[3][i], +cols[4][i], +cols[5][i], +cols[6][i]];
      if (!row.every(Number.isFinite)) return null;
      if (Math.abs(row[1]) > 90 || Math.abs(row[2]) > 180) return null;
      if (i > 0 && row[0] <= samples[i - 1][0]) return null;
      samples.push(row);
    }
    return { samples, truncated: false };
  }

  // Where the ghost is at t. Linear in position, shortest-arc in every angle. Before the first
  // sample it holds the first one (the ghost sits on the start line); after the last it holds
  // the last and reports ended:true, which is how the ghost parks at the finish gate instead of
  // vanishing or flying on forever.
  function traceSampleAt(trace, tMs) {
    const rows = trace && Array.isArray(trace.samples) ? trace.samples : null;
    if (!rows || !rows.length || !Number.isFinite(+tMs)) return null;
    const t = +tMs;
    const at = (r, ended) => ({ lat: r[1], lon: r[2], alt: r[3], heading: r[4], pitch: r[5], roll: r[6], ended: !!ended });
    if (t <= rows[0][0]) return at(rows[0], false);
    const lastRow = rows[rows.length - 1];
    if (t >= lastRow[0]) return at(lastRow, true);
    // Binary search for the segment containing t: at 6000 samples a linear scan at frame rate
    // is pointless work, and this is called from the per-frame ghost update.
    let lo = 0, hi = rows.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (rows[mid][0] <= t) lo = mid; else hi = mid; }
    const a = rows[lo], b = rows[hi];
    const span = b[0] - a[0];
    const f = span > 0 ? (t - a[0]) / span : 0;
    return {
      lat: a[1] + (b[1] - a[1]) * f,
      lon: a[2] + angleDelta(a[2], b[2]) * f,   // longitude is an angle too: +/-180 must not unwind
      alt: a[3] + (b[3] - a[3]) * f,
      heading: headingLerp(a[4], b[4], f),
      pitch: angleLerp(a[5], b[5], f),
      roll: angleLerp(a[6], b[6], f),
      ended: false,
    };
  }

  // Nearest recorded sample to an ECEF point, searching FORWARD ONLY from hintIndex across at
  // most `windowN` samples. Forward-only is the point: a course that crosses its own path (a
  // circuit, a figure-eight) would otherwise snap the racing line back to the earlier pass, and
  // a hint that only ever advances also keeps this O(window) instead of O(n) per frame.
  function traceNearest(trace, point, hintIndex, windowN) {
    const rows = trace && Array.isArray(trace.samples) ? trace.samples : null;
    if (!rows || !rows.length || !Array.isArray(point) || point.length < 3) return null;
    const start = Math.min(rows.length - 1, Math.max(0, Math.round(+hintIndex) || 0));
    const n = Math.max(1, Math.round(+windowN) || 1);
    const end = Math.min(rows.length - 1, start + n);
    let best = start, bestD = Infinity;
    for (let i = start; i <= end; i++) {
      const r = rows[i];
      const d = vlen(sub(ecef(r[1], r[2], r[3]), point));
      if (d < bestD) { bestD = d; best = i; }
    }
    return { index: best, distM: bestD, t: rows[best][0] };
  }

  // "Am I ahead of the ghost right now, and by how much?" — my elapsed time minus the ghost's
  // time at the same PLACE on its path. Negative = I got here sooner = I am ahead, the same
  // sign convention fmtDelta() and the split chip already use.
  //
  // The ghost's time is interpolated along the segment my position projects onto, not just read
  // off the nearest sample: at 4 Hz and 200 m/s consecutive samples are 50 m apart, so snapping
  // to the nearest one would quantize the readout into 250 ms steps.
  function traceDeltaMs(trace, point, myElapsedMs, hintIndex, windowN) {
    const rows = trace && Array.isArray(trace.samples) ? trace.samples : null;
    const near = traceNearest(trace, point, hintIndex, windowN);
    if (!near || !Number.isFinite(+myElapsedMs)) return null;
    const i = near.index;
    let ghostT = rows[i][0], bestD = near.distM;
    // Project onto whichever of the two adjoining segments the point actually falls on.
    for (const j of [i - 1, i]) {
      if (j < 0 || j + 1 >= rows.length) continue;
      const a = ecef(rows[j][1], rows[j][2], rows[j][3]), b = ecef(rows[j + 1][1], rows[j + 1][2], rows[j + 1][3]);
      const d = sub(b, a), dd = dot(d, d);
      if (dd <= 0) continue;
      const f = Math.max(0, Math.min(1, dot(sub(point, a), d) / dd));
      const q = [a[0] + d[0] * f, a[1] + d[1] * f, a[2] + d[2] * f];
      const dist = vlen(sub(q, point));
      if (dist <= bestD) { ghostT = rows[j][0] + (rows[j + 1][0] - rows[j][0]) * f; bestD = dist; }
    }
    return { deltaMs: +myElapsedMs - ghostT, index: i, distM: bestD, ghostMs: ghostT };
  }

  // LRU bookkeeping for locally-stored traces, keyed by course hash. Pure: takes the current
  // index and returns the new one plus the hashes whose blobs the caller should delete. Oldest
  // (by `at`) go first, and re-saving a course refreshes its slot rather than adding a second.
  function traceIndexPut(index, hash, ms, at, cap) {
    const list = (Array.isArray(index) ? index : [])
      .filter((e) => e && typeof e.hash === 'string' && e.hash !== hash)
      .map((e) => ({ hash: e.hash, ms: +e.ms || 0, at: +e.at || 0 }));
    list.push({ hash: String(hash), ms: Math.round(+ms) || 0, at: Math.round(+at) || 0 });
    list.sort((a, b) => a.at - b.at);
    const n = Math.max(1, Math.round(+cap) || 1);
    const cut = Math.max(0, list.length - n);
    return { index: list.slice(cut), drop: list.slice(0, cut).map((e) => e.hash) };
  }

  // -------------------------------------------------- waypoint bracket (pure helpers)
  // Turns "where is the next gate on screen" into "what do I draw, and where". Split out from
  // the HUD because none of it needs a DOM or a camera — only a pixel (or the absence of one),
  // the viewport, and two headings.

  // Shortest turn from `heading` to `bearing`: {dir, deg}, deg in [0, 180]. "Turn right 74°" is
  // the one instruction that works whether or not the gate is on screen.
  function turnInstruction(bearing, heading) {
    // null/undefined explicitly: +null is 0, which would read as "turn to due north".
    if (bearing == null || heading == null) return null;
    if (![+bearing, +heading].every(Number.isFinite)) return null;
    const d = angleDelta(+heading, +bearing);
    return { dir: d >= 0 ? 'right' : 'left', deg: Math.abs(d) };
  }

  // Where the marker goes. `screen` is G.worldToScreen()'s answer — {x, y} in CSS pixels, or
  // null when the point is behind the camera or the projection refused.
  //   { mode: 'bracket', x, y }                 — on screen, inside the inset
  //   { mode: 'edge', x, y, side }              — clamped to the inset edge, draw a chevron
  // A point behind the camera has no pixel at all, so its side comes from the relative bearing
  // instead: anything within 90° of dead astern is "behind you", and which shoulder it is over
  // is exactly the sign of the turn.
  function bracketPlacement(screen, viewport, insetPx, relBearingDeg) {
    const w = Math.max(1, +(viewport && viewport.width) || 1);
    const hgt = Math.max(1, +(viewport && viewport.height) || 1);
    const inset = Math.max(0, +insetPx || 0);
    const minX = Math.min(inset, w / 2), maxX = Math.max(w - inset, w / 2);
    const minY = Math.min(inset, hgt / 2), maxY = Math.max(hgt - inset, hgt / 2);
    if (screen && Number.isFinite(+screen.x) && Number.isFinite(+screen.y)) {
      const x = +screen.x, y = +screen.y;
      if (x >= minX && x <= maxX && y >= minY && y <= maxY) return { mode: 'bracket', x, y };
      const cx = Math.max(minX, Math.min(maxX, x)), cy = Math.max(minY, Math.min(maxY, y));
      // Whichever axis had to move further is the edge it belongs on — a corner then reads as
      // the side the gate is mostly off, which is what a pilot is about to turn towards.
      const side = Math.abs(x - cx) >= Math.abs(y - cy) ? (x < cx ? 'left' : 'right') : (y < cy ? 'up' : 'down');
      return { mode: 'edge', x: cx, y: cy, side };
    }
    const rel = Number.isFinite(+relBearingDeg) ? angleDelta(0, +relBearingDeg) : 0;
    const side = rel >= 0 ? 'right' : 'left';
    return { mode: 'edge', x: side === 'right' ? maxX : minX, y: hgt / 2, side };
  }

  // The bracket's caption: "GATE 4 · 1.8 km · climb 390 ft". Metres in, feet out, because the
  // rest of the HUD already reads altitude in feet.
  // `gate` is either a number (rendered as "GATE 4") or a ready-made name ("START", "FINISH").
  function bracketLabel(gate, distM, dzM) {
    const name = typeof gate === 'string' ? gate : 'GATE ' + gate;
    const bits = [name, fmtDist(Math.max(0, +distM || 0))];
    const dz = +dzM;
    if (Number.isFinite(dz) && Math.abs(dz) >= 15) {
      bits.push((dz > 0 ? 'climb ' : 'descend ') + Math.round(Math.abs(dz) * 3.280839895) + ' ft');
    }
    return bits.join(' · ');
  }
  // The edge chevron's caption: the turn first, because off screen that is the only thing that
  // gets the gate back on screen.
  function chevronLabel(turn, distM, dzM) {
    const bits = [];
    if (turn) bits.push('turn ' + turn.dir + ' ' + Math.round(turn.deg) + '°');
    bits.push(fmtDist(Math.max(0, +distM || 0)));
    const dz = +dzM;
    if (Number.isFinite(dz) && Math.abs(dz) >= 15) {
      bits.push((dz > 0 ? 'climb ' : 'descend ') + Math.round(Math.abs(dz) * 3.280839895) + ' ft');
    }
    return bits.join(' · ');
  }

  // -------------------------------------------------------- minimap (pure helpers)
  // A north-up local equirectangular projection, auto-fitted to the course. Equirectangular is
  // the right call here and not a compromise: a course spans kilometres, not continents, so the
  // cos(lat) scaling below is exact enough that no gate moves a pixel, and it costs two
  // multiplications per point instead of a full map projection every frame.

  // Fit a set of lat/lon points into a w x h box with `pad` pixels of margin. Returns the
  // projection parameters minimapPoint() needs, or null when there is nothing to fit.
  function minimapFit(points, w, h, pad) {
    const pts = (Array.isArray(points) ? points : []).filter((p) => p && Number.isFinite(+p.lat) && Number.isFinite(+p.lon));
    if (!pts.length) return null;
    const lats = pts.map((p) => +p.lat), lons = pts.map((p) => +p.lon);
    const lat0 = (Math.min(...lats) + Math.max(...lats)) / 2;
    const lon0 = (Math.min(...lons) + Math.max(...lons)) / 2;
    const kx = Math.max(0.01, Math.cos(lat0 * D2R));   // degrees of longitude are shorter up here
    // Extents in "equivalent degrees of latitude", so x and y share one scale and the course
    // is never stretched.
    const ex = Math.max(...lons.map((l) => Math.abs(angleDelta(lon0, l)))) * kx;
    const ey = Math.max(...lats.map((l) => Math.abs(l - lat0)));
    const usableW = Math.max(1, (+w || 1) - 2 * (+pad || 0));
    const usableH = Math.max(1, (+h || 1) - 2 * (+pad || 0));
    // A degenerate course (one gate, or a perfectly straight north-south line) has zero extent
    // on an axis; fall back to filling the box rather than dividing by zero.
    const scale = Math.min(ex > 0 ? usableW / (2 * ex) : Infinity, ey > 0 ? usableH / (2 * ey) : Infinity);
    return { lat0, lon0, kx, scale: Number.isFinite(scale) ? scale : 1, cx: (+w || 1) / 2, cy: (+h || 1) / 2 };
  }
  // North-up: +lat goes UP the screen, which is why y is negated.
  function minimapPoint(fit, lat, lon) {
    if (!fit || !Number.isFinite(+lat) || !Number.isFinite(+lon)) return null;
    return {
      x: fit.cx + angleDelta(fit.lon0, +lon) * fit.kx * fit.scale,
      y: fit.cy - (+lat - fit.lat0) * fit.scale,
    };
  }

  // ----------------------------------------------------- personal bests
  const Best = {
    get(hash) { return store.get('best', {})[hash] || null; },
    offer(hash, ms, splits) {
      const all = store.get('best', {}), cur = all[hash];
      if (cur && cur.ms <= ms) return false;
      all[hash] = { ms, splits: splits.slice(), at: Date.now() };
      store.set('best', all);
      return true;
    },
  };


  // ------------------------------------------- trace storage + recorder (impure half)
  // localStorage is the only place a trace lives client-side. One entry per course hash plus a
  // small index, so reading one course's ghost never has to parse the other nineteen. The index
  // is what makes the LRU cap (CONFIG.TRACE_MAX_COURSES) and quota recovery possible — see
  // traceIndexPut() above for the pure half.
  const TraceStore = {
    cap() { return Math.max(1, Math.round(+CONFIG.TRACE_MAX_COURSES) || 20); },
    key(hash) { return 'finsRace.trace.' + hash; },
    read(hash) {
      try { const v = localStorage.getItem(this.key(hash)); return v == null ? null : JSON.parse(v); }
      catch (_) { return null; }
    },
    _write(hash, enc) {
      try { localStorage.setItem(this.key(hash), JSON.stringify(enc)); return true; }
      catch (_) { return false; }   // quota, private mode, disabled storage — all the same to us
    },
    _drop(hash) { try { localStorage.removeItem(this.key(hash)); } catch (_) {} },

    // Save one course's trace, evicting per the LRU cap first. A write that fails is assumed to
    // be a quota error: evict the oldest surviving entry and try again, up to the whole index,
    // then give up silently. A ghost is a nicety — it must never surface an error at a finish.
    save(hash, enc, ms, at) {
      let put = traceIndexPut(store.get('traceIndex', []), hash, ms, at, this.cap());
      for (const h of put.drop) this._drop(h);
      for (let guard = 0; guard <= this.cap(); guard++) {
        if (this._write(hash, enc)) { store.set('traceIndex', put.index); return true; }
        const others = put.index.filter((e) => e.hash !== hash);
        if (!others.length) break;
        const oldest = others.reduce((a, b) => (a.at <= b.at ? a : b));
        this._drop(oldest.hash);
        put = { index: put.index.filter((e) => e.hash !== oldest.hash), drop: [] };
      }
      this._drop(hash);
      store.set('traceIndex', put.index.filter((e) => e.hash !== hash));
      return false;
    },
    entry(hash) { return store.get('traceIndex', []).find((e) => e && e.hash === hash) || null; },
  };

  // Records the run in progress. Sampled from loop() off the same frame data Race.tick reads —
  // Race.pos, plus attitude through G — so it can never disagree with what the race engine saw.
  // Discarded on reset/DQ, saved on a finish that is a personal best and not truncated.
  const Recorder = {
    trace: traceEmpty(), saved: false, status: '',

    reset() { this.trace = traceEmpty(); this.saved = false; },
    truncated() { return !!this.trace.truncated; },
    count() { return this.trace.samples.length; },

    tick() {
      if (!CONFIG.TRACE || Race.state !== 'running' || !Race.pos) return;
      const before = this.trace;
      this.trace = traceAppend(this.trace, {
        t: Race.elapsed, lat: Race.pos.lat, lon: Race.pos.lon, alt: Race.pos.alt,
        heading: G.heading(), pitch: G.pitch(), roll: G.roll(),
      }, CONFIG.TRACE_HZ, CONFIG.TRACE_MAX_SAMPLES);
      if (this.trace.truncated && !before.truncated) {
        this.status = 'Trace stopped at ' + this.count() + ' samples (cap) — this run will not be saved as a ghost.';
      }
    },

    // A finished run's trace is kept only when it is the personal best for this course hash.
    // Best.offer() has already run by the time this is called (see the race-bus subscribers near
    // boot()), so Best.get(hash).ms equals this run's time exactly when this run IS the best.
    saveIfBest(hash, ms) {
      if (!CONFIG.TRACE || !hash || !Number.isFinite(ms)) return false;
      if (this.trace.truncated || this.trace.samples.length < 2) return false;
      const best = Best.get(hash);
      if (best && Number.isFinite(best.ms) && best.ms < ms) return false;
      const ok = TraceStore.save(hash, traceEncode(this.trace), ms, Date.now());
      this.saved = ok;
      this.status = ok ? 'Ghost saved for this course (' + this.count() + ' samples).' : '';
      return ok;
    },

    // The encoded trace to attach to POST /runs, or null when there is nothing worth sending.
    encodedForSubmit() {
      if (!CONFIG.TRACE || this.trace.truncated || this.trace.samples.length < 2) return null;
      return traceEncode(this.trace);
    },
  };
  // --------------------------------------------------------- leaderboard
  const LB = {
    enabled: () => !!CONFIG.API_BASE,
    async submit(payload) {
      const r = await fetch(CONFIG.API_BASE.replace(/\/$/, '') + '/runs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.detail ? JSON.stringify(body.detail).slice(0, 160) : 'HTTP ' + r.status);
      return body;
    },
    async top(hash, limit = 10) {
      const r = await fetch(CONFIG.API_BASE.replace(/\/$/, '') + '/leaderboard?course_hash=' + hash + '&limit=' + limit);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    },
    // One pilot's ghost, or the course record holder's when callsign is empty. A 404 is the
    // normal "nobody has recorded one yet" answer, and an old server with no /ghost route
    // answers 404 too — which reads identically and needs no version check.
    async ghost(hash, callsign) {
      const q = '/ghost?course_hash=' + encodeURIComponent(hash) + (callsign ? '&callsign=' + encodeURIComponent(callsign) : '');
      const r = await fetch(CONFIG.API_BASE.replace(/\/$/, '') + q);
      if (r.status === 404) throw new Error('no ghost recorded for that pick yet');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    },
    // Every ghost on a course, fastest first — the index behind the rival-ghost picker (0.12.0).
    async ghostsList(hash) {
      const r = await fetch(CONFIG.API_BASE.replace(/\/$/, '') + '/ghosts?course_hash=' + encodeURIComponent(hash));
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    },
    // Courses where `callsign`'s best has been beaten since `sinceS` (unix seconds). The in-game
    // replacement for a Teams webhook (0.12.0) — see the News module below.
    async news(callsign, sinceS) {
      const q = '/news?callsign=' + encodeURIComponent(callsign) + '&since=' + encodeURIComponent(Math.max(0, Math.round(+sinceS) || 0));
      const r = await fetch(CONFIG.API_BASE.replace(/\/$/, '') + q);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    },
  };

  // --------------------------------------------------------------- courses
  const Courses = {
    remote: [],
    local() { return store.get('courses', {}); },
    saveLocal(c) { const all = this.local(); all[c.id] = c; store.set('courses', all); },
    deleteLocal(id) { const all = this.local(); delete all[id]; store.set('courses', all); },
    async refreshRemote() {
      try {
        const r = await fetch(CONFIG.COURSE_BASE + 'index.json?t=' + Date.now());
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const list = await r.json();
        this.remote = Array.isArray(list) ? list.filter((x) => x && x.file && x.name) : [];
      } catch (e) {
        this.remote = [];
        console.warn('[finsRace] shared course list unavailable', e);
      }
    },
    async fetchRemote(file) {
      const r = await fetch(CONFIG.COURSE_BASE + encodeURIComponent(file) + '?t=' + Date.now());
      if (!r.ok) throw new Error('Could not download ' + file + ' (HTTP ' + r.status + ')');
      return r.json();
    },
  };

  // ------------------------------------------------ model swap (Cesium adapter section)
  // Everything that touches Cesium/GeoFS primitives for model swapping lives here, same
  // rule as makeGateLayer. Real aircraft/multiplayer property names are unverified — see
  // the TODO-PROBE methods on G above and race/tools/probe.js.
  async function loadModelUrl(url) {
    if (!G.ready()) throw new Error('GeoFS not ready');
    if (!(window.Cesium && Cesium.Model)) throw new Error('Cesium.Model unavailable');
    let model;
    if (typeof Cesium.Model.fromGltfAsync === 'function') model = await Cesium.Model.fromGltfAsync({ url });
    else if (typeof Cesium.Model.fromGltf === 'function') model = Cesium.Model.fromGltf({ url });
    else throw new Error('Cesium.Model.fromGltf(Async) unavailable');
    const scene = G.scene();
    if (!scene) throw new Error('viewer.scene unavailable');
    scene.primitives.add(model);
    return model;
  }
  function destroyModel(model) {
    try { const scene = G.scene(); if (scene) scene.primitives.remove(model); } catch (_) {}
  }
  function applyModelTransform(model, lat, lon, alt, heading, pitch, roll, offset, scale) {
    const off = offset || {};
    const pos = Cesium.Cartesian3.fromDegrees(lon, lat, alt);
    const hpr = new Cesium.HeadingPitchRoll(
      Cesium.Math.toRadians((heading || 0) + (off.headingDeg || 0)),
      Cesium.Math.toRadians((pitch || 0) + (off.pitchDeg || 0)),
      Cesium.Math.toRadians((roll || 0) + (off.rollDeg || 0)));
    model.modelMatrix = Cesium.Transforms.headingPitchRollToFixedFrame(pos, hpr);
    if (Number.isFinite(scale)) model.scale = scale;
  }

  const ModelSwap = {
    index: [], byId: {}, assignments: {}, ready: false, status: '',
    mine: { entry: null, model: null, enabled: false, hideInCockpit: false, loading: false },
    others: new Map(), // callsign-derived id -> { model, entry, node, loading }
    lastScan: 0,

    async init() {
      try {
        const [idx, asn] = await Promise.all([
          fetch(CONFIG.MODEL_BASE + 'index.json?t=' + Date.now()).then((r) => (r.ok ? r.json() : [])).catch(() => []),
          fetch(CONFIG.MODEL_BASE + 'assignments.json?t=' + Date.now()).then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
        ]);
        this.index = Array.isArray(idx) ? idx.filter((m) => m && m.id && m.file) : [];
        this.byId = Object.fromEntries(this.index.map((m) => [m.id, m]));
        this.assignments = {};
        if (asn && typeof asn === 'object') {
          for (const [k, v] of Object.entries(asn)) if (!k.startsWith('_') && this.byId[v]) this.assignments[k] = v;
        }
        this.ready = true;
      } catch (e) { this.status = 'Model list unavailable: ' + e.message; }
    },

    urlFor(entry) { return CONFIG.MODEL_BASE + entry.file; },
    defaultModelId() { const cs = G.callsign(); return (cs && this.assignments[cs]) || ''; },

    async enable(modelId) {
      const entry = this.byId[modelId];
      if (!entry) { await this.disable(); return; }
      this.mine.loading = true;
      try {
        const model = await loadModelUrl(this.urlFor(entry));
        await this._disposeMine();
        this.mine.entry = entry; this.mine.model = model; this.mine.enabled = true;
        window.__finsModel = modelId;
        this.status = '';
      } catch (e) {
        this.mine.enabled = false;
        this.status = 'Could not load ' + modelId + ' (' + e.message + '); flying stock.';
      } finally { this.mine.loading = false; }
    },
    async disable() {
      await this._disposeMine();
      this.mine.enabled = false; this.mine.entry = null;
      window.__finsModel = '';
      this._setStockHidden(false);
    },
    async _disposeMine() {
      if (this.mine.model) destroyModel(this.mine.model);
      this.mine.model = null;
    },
    setHideInCockpit(v) { this.mine.hideInCockpit = !!v; },
    _setStockHidden(hidden) {
      for (const n of G.stockAircraftNodes()) { try { G.setShow(n, !hidden); } catch (_) {} }
    },

    // Called once per animation frame; never throws (falls back to stock + status message).
    tick(now) {
      this._tickMine();
      if (now - this.lastScan > 1000) { this.lastScan = now; this._scanOthers(); }
      this._tickOthersTransforms();
    },
    _tickMine() {
      if (!this.mine.enabled || !this.mine.model) return;
      try {
        if (!G.ready()) return;
        const p = G.lla();
        if (![p.lat, p.lon, p.alt].every(Number.isFinite)) return;
        applyModelTransform(this.mine.model, p.lat, p.lon, p.alt, G.heading(), G.pitch(), G.roll(), this.mine.entry.offset, this.mine.entry.scale);
        this.mine.model.show = !(this.mine.hideInCockpit && G.isCockpitView());
        this._setStockHidden(true);
      } catch (e) {
        this.status = 'Model update failed (' + e.message + '); flying stock.';
        this._disposeMine(); this.mine.enabled = false; this._setStockHidden(false);
      }
    },
    // Returns a promise (resolves once any newly-seen users have finished loading) so tests
    // can await it; tick() itself fires this and forgets, since the next frame will retry.
    _scanOthers() {
      try {
        if (!this.ready) return Promise.resolve();
        const users = G.multiplayerUsers();
        const seen = new Set();
        const spawns = [];
        for (const u of users) {
          const modelId = this.assignments[u.callsign];
          if (!modelId) continue;
          seen.add(u.id);
          const rec = this.others.get(u.id);
          if (rec && rec.modelId === modelId) continue;
          if (rec) this._removeOther(u.id);
          spawns.push(this._spawnOther(u, modelId));
        }
        for (const id of Array.from(this.others.keys())) if (!seen.has(id)) this._removeOther(id);
        return Promise.all(spawns);
      } catch (_) { return Promise.resolve(); }
    },
    async _spawnOther(u, modelId) {
      const entry = this.byId[modelId];
      if (!entry) return;
      const placeholder = { model: null, modelId, entry, nodes: u.nodes || [], loading: true };
      this.others.set(u.id, placeholder);
      try {
        const model = await loadModelUrl(this.urlFor(entry));
        if (this.others.get(u.id) !== placeholder) { destroyModel(model); return; } // left/reassigned mid-load
        placeholder.model = model; placeholder.loading = false;
        for (const n of placeholder.nodes) { try { G.setShow(n, false); } catch (_) {} }
      } catch (_) { this.others.delete(u.id); }
    },
    _removeOther(id) {
      const rec = this.others.get(id);
      if (!rec) return;
      if (rec.model) destroyModel(rec.model);
      for (const n of rec.nodes || []) { try { G.setShow(n, true); } catch (_) {} }
      this.others.delete(id);
    },
    _tickOthersTransforms() {
      if (!this.others.size) return;
      try {
        const byId = new Map(G.multiplayerUsers().map((u) => [u.id, u]));
        for (const [id, rec] of this.others) {
          if (rec.loading || !rec.model) continue;
          const u = byId.get(id);
          if (!u) continue;
          applyModelTransform(rec.model, u.lat, u.lon, u.alt, u.heading, u.pitch, u.roll, rec.entry.offset, rec.entry.scale);
          // Re-fetched and re-hidden every frame, same as _tickMine: GeoFS may regenerate
          // _children or reassert .visible on its own, and a one-time hide at spawn isn't
          // enough to catch that (this was the multiplayer half of the flicker bug).
          rec.nodes = u.nodes || [];
          for (const n of rec.nodes) { try { G.setShow(n, false); } catch (_) {} }
        }
      } catch (_) {}
    },
  };


  // ------------------------------------------------------ ghost rendering (Cesium)
  // Same contract as makeGateLayer: every Cesium/GeoFS call is inside this factory, it never
  // throws into the race loop, it carries an `ok` flag, and it clears itself. A ghost that
  // cannot be drawn is a missing ghost, never a broken race.
  //
  // Three tiers, tried in order: the pilot's own joke model through ModelSwap's existing model
  // path, the goldfish as a stand-in, and finally a plain Cesium point + label, which needs no
  // glTF at all and so works even on a build where Cesium.Model is gone.
  //
  // The ghost is deliberately invisible to everything that deals with other players. It is a
  // scene primitive this file owns, it is never registered in ModelSwap.others, and it is not
  // in multiplayer.users — so _scanOthers()/_tickOthersTransforms() (the multiplayer half of the
  // flicker fix, which re-hides real users' nodes every frame) never sees it, and nothing in
  // this file can mistake it for a real pilot. The `__finsGhost` tag makes that assertable.
  function makeGhostLayer() {
    const layer = { ok: true, mode: 'none', model: null, entity: null, entry: null, label: '', shown: false };

    layer.clear = () => {
      try { if (layer.model) destroyModel(layer.model); } catch (_) {}
      try { if (layer.entity) G.viewer().entities.remove(layer.entity); } catch (_) {}
      layer.model = null; layer.entity = null; layer.entry = null;
      layer.mode = 'none'; layer.label = ''; layer.shown = false;
    };

    // Build the ghost's visual for `modelId` (falling back to the goldfish, then to a point).
    // `label` is what floats above it: "GHOST · <callsign> · <time>".
    layer.load = async (modelId, label) => {
      layer.clear();
      layer.label = String(label || 'GHOST');
      const alpha = Math.max(0.05, Math.min(1, +CONFIG.GHOST_ALPHA || 0.45));
      const ids = [modelId, 'goldfish'].filter((x, i, a) => x && a.indexOf(x) === i);
      for (const id of ids) {
        const entry = ModelSwap.byId[id];
        if (!entry) continue;
        try {
          const model = await loadModelUrl(ModelSwap.urlFor(entry));
          model.__finsGhost = true;          // never a multiplayer user; see the note above
          model.show = false;                // hidden until the race actually starts
          // Translucency: Cesium.Model.color + colorBlendMode, both present in 1.96. Guarded
          // because a future build could drop either, and a solid ghost beats no ghost.
          try {
            if (window.Cesium && Cesium.Color && Cesium.Color.WHITE) model.color = Cesium.Color.WHITE.withAlpha(alpha);
            if (window.Cesium && Cesium.ColorBlendMode) model.colorBlendMode = Cesium.ColorBlendMode.MIX;
          } catch (_) {}
          layer.model = model; layer.entry = entry; layer.mode = id === modelId ? 'model' : 'fallback-model';
          layer.ok = true;
          return layer.mode;
        } catch (_) { /* try the next tier */ }
      }
      // Final tier: a point and a label. No glTF, no primitives — just an entity.
      try {
        const v = G.viewer();
        layer.entity = v.entities.add({
          position: Cesium.Cartesian3.fromDegrees(0, 0, 0),
          point: { pixelSize: 14, color: Cesium.Color.fromCssColorString('#9fd0ff').withAlpha(alpha),
            outlineColor: Cesium.Color.BLACK.withAlpha(alpha), outlineWidth: 2,
            disableDepthTestDistance: Number.POSITIVE_INFINITY },
          label: { text: layer.label, font: 'bold 14px "Trebuchet MS", sans-serif',
            fillColor: Cesium.Color.WHITE.withAlpha(alpha), outlineColor: Cesium.Color.BLACK, outlineWidth: 3,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE, pixelOffset: new Cesium.Cartesian2(0, -20),
            disableDepthTestDistance: Number.POSITIVE_INFINITY },
        });
        layer.entity.__finsGhost = true;
        layer.entity.show = false;
        layer.mode = 'point';
        layer.ok = true;
        return layer.mode;
      } catch (e) {
        layer.ok = false;
        layer.mode = 'none';
        console.warn('[finsRace] ghost rendering unavailable; the race is unaffected', e);
        return 'none';
      }
    };

    // One traceSampleAt() result per frame. `sample` null (or show false) hides the ghost, which
    // is what keeps it off screen before the clock starts.
    layer.update = (sample) => {
      if (!layer.ok) return;
      try {
        const visible = !!sample;
        layer.shown = visible;
        if (layer.model) {
          layer.model.show = visible;
          if (visible) {
            applyModelTransform(layer.model, sample.lat, sample.lon, sample.alt,
              sample.heading, sample.pitch, sample.roll, layer.entry.offset, layer.entry.scale);
          }
        } else if (layer.entity) {
          layer.entity.show = visible;
          if (visible) {
            layer.entity.position = Cesium.Cartesian3.fromDegrees(sample.lon, sample.lat, sample.alt);
            layer.entity.label.text = layer.label;
          }
        }
      } catch (e) {
        layer.ok = false;
        console.warn('[finsRace] ghost update failed; hiding the ghost', e);
        try { layer.clear(); } catch (_) {}
      }
    };

    return layer;
  }

  // ------------------------------------------------------------------- ghost
  // Picks which trace to fly (Off / my best / the course record / a named pilot), fetches it,
  // and drives makeGhostLayer() off Race.elapsed. The choice is remembered per course hash, so
  // going back to a course brings back the ghost you were chasing on it.
  const GHOST_OFF = '', GHOST_MINE = 'mine', GHOST_RECORD = 'record';

  // Shared by Ghost (the primary pick) and RivalGhosts (the extra picks below): resolve a pick
  // value into a decoded trace + display meta, or null/throw exactly as the single-ghost picker
  // always has. Free functions, not methods, so both callers can use them without a `this` bound
  // to the wrong picker.
  function fetchTraceLocalBest(hash) {
    const enc = hash ? TraceStore.read(hash) : null;
    const trace = enc ? traceDecode(enc) : null;
    if (!trace) return null;
    const entry = TraceStore.entry(hash);
    return { trace, meta: { callsign: 'my best', timeMs: entry ? entry.ms : NaN, model: G.model() } };
  }
  async function fetchTraceRemote(hash, pick) {
    if (!LB.enabled()) throw new Error('the leaderboard is off, so only "My best" is available');
    const who = pick === GHOST_RECORD ? '' : pick;
    const body = await LB.ghost(hash, who);
    const trace = traceDecode(body.trace);
    if (!trace) throw new Error('that ghost did not decode');
    return { trace, meta: { callsign: String(body.callsign || '?'), timeMs: +body.time_ms, model: String(body.model || '') } };
  }

  const Ghost = {
    layer: null, pick: GHOST_OFF, trace: null, meta: null, status: '', loading: false,
    _loadKey: '', hint: 0, delta: null,

    // My own clock for the ghost: while racing it is simply Race.elapsed, so the ghost leaves
    // gate 1 exactly when I do. A spectator in a lobby race has no elapsed of their own, so the
    // room's shared GO clock stands in — otherwise a spectator's ghost would never move.
    clockMs() {
      if (Race.state === 'running') return Race.elapsed;
      if (Race.state === 'finished') return Race.finalMs;
      if (Race.goAt != null && Number.isFinite(Race.goElapsed) && Race.goElapsed >= 0) return Race.goElapsed;
      return null;
    },

    storeKey() { return 'ghostPick.' + (Race.hash || 'none'); },
    restorePick() { this.pick = Race.hash ? String(store.get(this.storeKey(), GHOST_OFF) || GHOST_OFF) : GHOST_OFF; },
    setPick(v) {
      this.pick = String(v || GHOST_OFF);
      if (Race.hash) store.set(this.storeKey(), this.pick);
      this._pending = this.reload();
      return this._pending;
    },

    ensureLayer() {
      if (!CONFIG.GHOST) return null;
      if (!this.layer) this.layer = makeGhostLayer();
      return this.layer;
    },

    // Drop whatever is loaded and load whatever `pick` now names. Never throws; a failure is a
    // status line under the picker and no ghost.
    async reload() {
      if (!CONFIG.GHOST) return;
      const key = (Race.hash || '') + '|' + this.pick;
      this._loadKey = key;
      this.trace = null; this.meta = null; this.hint = 0; this.delta = null;
      if (this.layer) this.layer.clear();
      if (!this.pick || this.pick === GHOST_OFF || !Race.hash) { this.status = ''; this.syncStatus(); return; }
      this.loading = true;
      this.status = 'Ghost: loading…';
      this.syncStatus();
      try {
        const got = this.pick === GHOST_MINE ? this.loadMine() : await this.loadRemote();
        if (this._loadKey !== key) return;            // the pick changed mid-fetch
        if (!got) { this.status = 'Ghost: no recorded run for that pick yet.'; return; }
        this.trace = got.trace; this.meta = got.meta;
        const layer = this.ensureLayer();
        if (layer) {
          const mode = await layer.load(got.meta.model, 'GHOST · ' + got.meta.callsign + ' · ' + fmt(got.meta.timeMs));
          if (this._loadKey !== key) { layer.clear(); return; }
          this.status = 'Ghost: ' + got.meta.callsign + ' ' + fmt(got.meta.timeMs) +
            (mode === 'model' ? '' : mode === 'fallback-model' ? ' (stand-in model)' : mode === 'point' ? ' (marker only)' : ' (not drawn)');
        }
      } catch (e) {
        if (this._loadKey === key) this.status = 'Ghost: ' + String(e.message || e).slice(0, 120);
      } finally {
        if (this._loadKey === key) { this.loading = false; this.syncStatus(); }
      }
    },

    loadMine() { return fetchTraceLocalBest(Race.hash); },
    async loadRemote() { return fetchTraceRemote(Race.hash, this.pick); },

    // Once per frame. Cheap and total: with no trace loaded there is nothing to do at all.
    tick() {
      if (!CONFIG.GHOST || !this.trace || !this.layer) return;
      const t = this.clockMs();
      const sample = t == null ? null : traceSampleAt(this.trace, t);
      this.layer.update(sample);
    },

    // The live "vs ghost" number, recomputed at HUD rate rather than per frame. Also advances
    // the forward-only search hint, which is what keeps traceNearest O(window).
    refreshDelta() {
      if (!CONFIG.GHOST || !this.trace || Race.state !== 'running' || !Race.pos) { this.delta = null; return; }
      const res = traceDeltaMs(this.trace, ecef(Race.pos.lat, Race.pos.lon, Race.pos.alt),
        Race.elapsed, this.hint, CONFIG.TRACE_SEARCH_N);
      if (!res) { this.delta = null; return; }
      this.hint = res.index;
      this.delta = res.deltaMs;
    },

    onCourseChange() {
      this.restorePick();
      this._pending = this.reload();
      return this._pending;
    },
    onReset() { this.hint = 0; this.delta = null; },

    syncStatus() { try { if (UI.E.ghostStatus) UI.E.ghostStatus.textContent = this.status; } catch (_) {} },

    // Which picks the panel offers: Off / My best (when one is stored) / Course record / one per
    // leaderboard pilot who has a ghost. Pure enough to test — it takes the board rows and what
    // is stored locally, not the network.
    options(boardRows, hasLocal) {
      const out = [{ value: GHOST_OFF, label: 'Off' }];
      if (hasLocal) out.push({ value: GHOST_MINE, label: 'My best' });
      const rows = (Array.isArray(boardRows) ? boardRows : []).filter((r) => r && r.has_ghost === true);
      if (rows.length) out.push({ value: GHOST_RECORD, label: 'Course record' });
      for (const r of rows) out.push({ value: String(r.callsign), label: String(r.callsign) + ' · ' + fmt(+r.time_ms) });
      return out;
    },
  };

  // ---------------------------------------------------- rival ghosts (pure helpers, 0.12.0)
  // "Race a friend's ghost": up to CONFIG.RIVAL_GHOSTS_MAX ghosts fly at once. The picker's
  // vocabulary is exactly Ghost's own (GHOST_MINE / GHOST_RECORD / a callsign) — "Next one up" is
  // just a preset that resolves to a concrete callsign the moment it is picked, so nothing new
  // has to be persisted or re-resolved later.

  // The pilot immediately faster than `myTimeMs` on this course — the row with the LARGEST
  // time_ms that is still strictly less than mine, i.e. the next one to catch. null with no
  // personal time yet, or nobody faster.
  function nextOneUpCallsign(rows, myTimeMs) {
    if (!Number.isFinite(myTimeMs)) return null;
    const faster = (Array.isArray(rows) ? rows : []).filter((r) => r && Number.isFinite(+r.time_ms) && +r.time_ms < myTimeMs);
    if (!faster.length) return null;
    faster.sort((a, b) => +b.time_ms - +a.time_ms);
    return String(faster[0].callsign);
  }

  // The rival picker's options: Off / My best / Course record / Next one up / one per recorded
  // ghost, fastest first. `rows` is a GET /ghosts response (callsign, time_ms, is_course_record, …).
  function rivalGhostOptions(rows, myTimeMs, hasLocal) {
    const list = (Array.isArray(rows) ? rows : []).filter((r) => r && r.callsign);
    const out = [{ value: GHOST_OFF, label: 'Off' }];
    if (hasLocal) out.push({ value: GHOST_MINE, label: 'My best' });
    if (list.length) out.push({ value: GHOST_RECORD, label: 'Course record' });
    const nextUp = nextOneUpCallsign(list, myTimeMs);
    if (nextUp) out.push({ value: nextUp, label: 'Next one up (' + nextUp + ')' });
    for (const r of list) {
      out.push({ value: String(r.callsign), label: String(r.callsign) + ' · ' + fmt(+r.time_ms) + (r.is_course_record ? ' · record' : '') });
    }
    return out;
  }

  // The HUD's per-rival delta line: "Dave -0.41s", or just the name with nothing loaded/running
  // yet. Same sign convention as the primary ghost's #fr-hud-ghost: negative = ahead.
  function fmtRivalDelta(callsign, deltaMs) {
    const name = String(callsign || '?');
    if (deltaMs == null || !Number.isFinite(+deltaMs)) return name;
    return name + ' ' + (+deltaMs < 0 ? '−' : '+') + (Math.abs(+deltaMs) / 1000).toFixed(2) + 's';
  }

  // Challenge links: ?course=<id>&ghost=<callsign>[,<callsign>...]. Pure parse/build so both ends
  // (boot() reading the URL, the results screen's "Copy challenge link" button) are testable with
  // no DOM location involved.
  function parseChallengeParams(search) {
    try {
      const p = new URLSearchParams(String(search || ''));
      const course = (p.get('course') || '').trim();
      const cap = Math.max(1, Math.round(+CONFIG.RIVAL_GHOSTS_MAX) || 3);
      const ghosts = (p.get('ghost') || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, cap);
      return { course: course || null, ghosts };
    } catch (_) { return { course: null, ghosts: [] }; }
  }
  function buildChallengeLink(baseUrl, courseId, ghostCallsigns) {
    const url = new URL(String(baseUrl));
    url.search = '';
    if (courseId) url.searchParams.set('course', String(courseId));
    const ghosts = (Array.isArray(ghostCallsigns) ? ghostCallsigns : []).map((s) => String(s || '').trim()).filter(Boolean);
    if (ghosts.length) url.searchParams.set('ghost', ghosts.join(','));
    return url.toString();
  }
  // Room invite links: ?room=<code> (race.js Shell module's "Copy invite" and boot()'s URL read),
  // kept separate from the ?course=&ghost= challenge-link pair above — the two can coexist in one
  // URL but are parsed/built independently.
  function parseRoomParam(search) {
    try {
      const p = new URLSearchParams(String(search || ''));
      const room = powerupsRoom(p.get('room') || '', '');
      return room || null;
    } catch (_) { return null; }
  }
  function buildInviteLink(baseUrl, room) {
    const url = new URL(String(baseUrl));
    url.search = '';
    if (room) url.searchParams.set('room', String(room));
    return url.toString();
  }

  // Manages the EXTRA ghost slots beyond the existing "Race against" picker (which stays the one
  // primary ghost — see the CONFIG.RIVAL_GHOSTS note at the top of the file). Each extra slot is
  // its own makeGhostLayer() instance with its own trace/delta, so a rival never touches the
  // racing line's colour or the primary #fr-hud-ghost readout.
  const RivalGhosts = {
    extraPicks: [], rows: [], extra: [],

    max() { return Math.max(1, Math.min(8, Math.round(+CONFIG.RIVAL_GHOSTS_MAX) || 3)); },
    slotCount() { return Math.max(0, this.max() - 1); },
    storeKey() { return 'rivalPicks.' + (Race.hash || 'none'); },
    restore() {
      const n = this.slotCount();
      const saved = Race.hash ? store.get(this.storeKey(), []) : [];
      const arr = Array.isArray(saved) ? saved : [];
      this.extraPicks = Array.from({ length: n }, (_, i) => String(arr[i] || ''));
    },
    persist() { if (Race.hash) store.set(this.storeKey(), this.extraPicks); },

    myTimeMs() {
      const entry = Race.hash ? TraceStore.entry(Race.hash) : null;
      return entry && Number.isFinite(entry.ms) ? entry.ms : NaN;
    },
    async refreshList() {
      if (!CONFIG.RIVAL_GHOSTS || !LB.enabled() || !Race.hash) { this.rows = []; return; }
      try { this.rows = await LB.ghostsList(Race.hash); } catch (_) { this.rows = []; }
    },
    options(hasLocal) { return rivalGhostOptions(this.rows, this.myTimeMs(), hasLocal); },

    ensureExtra(i) {
      let e = this.extra.find((x) => x.slot === i);
      if (!e) { e = { slot: i, pick: '', trace: null, meta: null, layer: null, hint: 0, delta: null, status: '' }; this.extra.push(e); }
      return e;
    },
    clearExtra(i) {
      const e = this.extra.find((x) => x.slot === i);
      if (e && e.layer) e.layer.clear();
      this.extra = this.extra.filter((x) => x.slot !== i);
    },

    setExtraPick(i, v) {
      if (i < 0 || i >= this.slotCount()) return;
      this.extraPicks[i] = String(v || '');
      this.persist();
      return this.loadExtra(i);
    },

    // Never throws; a failure just leaves that one slot empty with a status line, same contract
    // as Ghost.reload() — one rival's bad pick or dead network never costs the others their ghost.
    async loadExtra(i) {
      if (!CONFIG.RIVAL_GHOSTS) return;
      const pick = this.extraPicks[i] || '';
      if (!pick || !Race.hash) { this.clearExtra(i); return; }
      const e = this.ensureExtra(i);
      const key = Race.hash + '|' + i + '|' + pick;
      e.pick = pick; e._loadKey = key;
      e.trace = null; e.meta = null; e.hint = 0; e.delta = null; e.status = 'loading…';
      if (e.layer) e.layer.clear();
      try {
        const got = pick === GHOST_MINE ? fetchTraceLocalBest(Race.hash) : await fetchTraceRemote(Race.hash, pick);
        if (e._loadKey !== key) return;
        if (!got) { e.status = 'no recorded run for that pick yet'; return; }
        e.trace = got.trace; e.meta = got.meta;
        if (!e.layer) e.layer = makeGhostLayer();
        const mode = await e.layer.load(got.meta.model, 'GHOST · ' + got.meta.callsign + ' · ' + fmt(got.meta.timeMs));
        if (e._loadKey !== key) { e.layer.clear(); return; }
        e.status = got.meta.callsign + ' ' + fmt(got.meta.timeMs) +
          (mode === 'model' ? '' : mode === 'fallback-model' ? ' (stand-in model)' : mode === 'point' ? ' (marker only)' : ' (not drawn)');
      } catch (err) {
        if (e._loadKey === key) e.status = String(err.message || err).slice(0, 120);
      }
      try { if (UI.renderRivalOptions) UI.renderRivalOptions(); } catch (_) {}
    },

    // Once per frame, alongside Ghost.tick() — same clock, same sample lookup, just one layer per
    // extra slot instead of the one primary layer.
    tick() {
      if (!CONFIG.RIVAL_GHOSTS) return;
      const t = Ghost.clockMs();
      for (const e of this.extra) {
        if (!e.trace || !e.layer) continue;
        const sample = t == null ? null : traceSampleAt(e.trace, t);
        e.layer.update(sample);
      }
    },
    // HUD rate, alongside Ghost.refreshDelta().
    refreshDeltas() {
      if (!CONFIG.RIVAL_GHOSTS || Race.state !== 'running' || !Race.pos) { for (const e of this.extra) e.delta = null; return; }
      const p = ecef(Race.pos.lat, Race.pos.lon, Race.pos.alt);
      for (const e of this.extra) {
        if (!e.trace) { e.delta = null; continue; }
        const res = traceDeltaMs(e.trace, p, Race.elapsed, e.hint, CONFIG.TRACE_SEARCH_N);
        if (!res) { e.delta = null; continue; }
        e.hint = res.index; e.delta = res.deltaMs;
      }
    },

    async onCourseChange() {
      if (!CONFIG.RIVAL_GHOSTS) return;
      this.restore();
      await this.refreshList();
      for (let i = 0; i < this.extraPicks.length; i++) await this.loadExtra(i);
    },
    onReset() { for (const e of this.extra) { e.hint = 0; e.delta = null; } },

    // A challenge link's ?ghost=a,b,c: the first name drives the existing primary picker
    // unchanged, and the rest fill the extra slots in order.
    async applyChallenge(ghostCallsigns) {
      if (!CONFIG.RIVAL_GHOSTS) return;
      const list = Array.isArray(ghostCallsigns) ? ghostCallsigns : [];
      if (CONFIG.GHOST && list[0]) await Ghost.setPick(list[0]);
      const n = this.slotCount();
      this.extraPicks = Array.from({ length: n }, (_, i) => String(list[i + 1] || ''));
      this.persist();
      for (let i = 0; i < n; i++) await this.loadExtra(i);
    },
  };

  // -------------------------------------------------- racing line (pure helpers)
  // The window of the ghost's path worth drawing: from wherever I am on it (traceNearest's
  // index) forward until LINE_AHEAD_M of path length has been covered. Drawing the whole trace
  // would be a 6000-point polyline that mostly runs behind the camera; drawing a fixed number of
  // samples would be metres at 50 m/s and kilometres at 250 m/s.
  function traceWindow(trace, startIndex, aheadM) {
    const rows = trace && Array.isArray(trace.samples) ? trace.samples : null;
    if (!rows || rows.length < 2) return [];
    const i0 = Math.min(rows.length - 1, Math.max(0, Math.round(+startIndex) || 0));
    const ahead = Math.max(0, +aheadM || 0);
    const out = [{ lat: rows[i0][1], lon: rows[i0][2], alt: rows[i0][3] }];
    let run = 0;
    for (let i = i0 + 1; i < rows.length; i++) {
      const a = rows[i - 1], b = rows[i];
      run += vlen(sub(ecef(a[1], a[2], a[3]), ecef(b[1], b[2], b[3])));
      out.push({ lat: b[1], lon: b[2], alt: b[3] });
      if (run >= ahead) break;
    }
    return out;
  }

  // What colour the line is right now. Amber is a deliberate dead band: without it the line
  // strobes green/red every time the delta wobbles across zero, which is most of a close race.
  function lineColorFor(deltaMs, bandMs) {
    const band = Math.max(0, +bandMs || 0);
    // null/undefined explicitly, not just via Number.isFinite: +null is 0, which would paint a
    // "no ghost loaded" line amber as though the race were dead level.
    if (deltaMs == null || !Number.isFinite(+deltaMs)) return 'neutral';
    if (Math.abs(+deltaMs) <= band) return 'close';
    return +deltaMs < 0 ? 'ahead' : 'behind';
  }

  // The no-trace fallback: a Catmull-Rom spline through the gate centres, so a course nobody has
  // flown yet still shows a suggested line instead of nothing. Uniform (not centripetal)
  // parameterisation with duplicated endpoints, which is the standard way to make the curve pass
  // through the first and last control points.
  function catmullRomPath(points, perSegment) {
    const pts = (Array.isArray(points) ? points : []).filter((p) => p && [+p.lat, +p.lon, +p.alt].every(Number.isFinite));
    if (pts.length < 2) return pts.map((p) => ({ lat: +p.lat, lon: +p.lon, alt: +p.alt }));
    const n = Math.max(1, Math.round(+perSegment) || 1);
    const at = (i) => pts[Math.max(0, Math.min(pts.length - 1, i))];
    const out = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
      for (let s = 0; s < n; s++) {
        const t = s / n, t2 = t * t, t3 = t2 * t;
        // Longitude is interpolated as an offset from p1 so a segment crossing the date line
        // curves the short way instead of sweeping back across the whole globe.
        const lonOf = (p) => +p1.lon + angleDelta(+p1.lon, +p.lon);
        const comp = (a, b, c, d) => 0.5 * ((2 * b) + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
        out.push({
          lat: comp(+p0.lat, +p1.lat, +p2.lat, +p3.lat),
          lon: comp(lonOf(p0), +p1.lon, lonOf(p2), lonOf(p3)),
          alt: comp(+p0.alt, +p1.alt, +p2.alt, +p3.alt),
        });
      }
    }
    out.push({ lat: +pts[pts.length - 1].lat, lon: +pts[pts.length - 1].lon, alt: +pts[pts.length - 1].alt });
    return out.filter((p) => [p.lat, p.lon, p.alt].every(Number.isFinite));
  }

  // -------------------------------------------------- racing line (Cesium)
  // One polyline entity, same factory contract as makeGateLayer/makeGhostLayer. Its positions
  // come from a CallbackProperty reading a cached array that is only rebuilt at
  // CONFIG.LINE_REBUILD_HZ — so the per-frame path allocates nothing and the entity is never
  // torn down and re-added. Where CallbackProperty is missing, positions are swapped on the
  // entity directly at the same rate, which costs one array per rebuild instead of none.
  function makeLineLayer() {
    const layer = { ok: true, entity: null, mode: 'none', style: 'neutral', positions: [], _cart: [], _dirty: true };

    const COLORS = {
      ahead: '#5be38f', close: '#ffd23d', behind: '#ff5a5a', neutral: '#9fd0ff',
    };

    layer.clear = () => {
      try { if (layer.entity) G.viewer().entities.remove(layer.entity); } catch (_) {}
      layer.entity = null; layer.mode = 'none'; layer.positions = []; layer._cart = []; layer._dirty = true;
    };

    // Rebuild the cached Cartesian3 array. Called at most CONFIG.LINE_REBUILD_HZ times a second
    // by LineRenderer; everything in between reads this same array.
    layer.setPath = (path) => {
      if (!layer.ok) return;
      try {
        layer.positions = Array.isArray(path) ? path : [];
        layer._cart = layer.positions.length >= 2
          ? Cesium.Cartesian3.fromDegreesArrayHeights(layer.positions.flatMap((p) => [p.lon, p.lat, p.alt + CONFIG.ALT_OFFSET_M]))
          : [];
        layer._dirty = true;
        if (layer.entity && layer.mode === 'swap') layer.entity.polyline.positions = layer._cart;
        if (layer.entity) layer.entity.show = layer._cart.length >= 2;
      } catch (e) {
        layer.ok = false;
        console.warn('[finsRace] racing line unavailable; the race is unaffected', e);
        try { layer.clear(); } catch (_) {}
      }
    };

    // `dashed` picks the material: a solid glow for a real recorded line, a dashed one for the
    // "nobody has flown this yet" spline, so the two can never be confused in the air.
    layer.build = (dashed) => {
      layer.clear();
      try {
        const v = G.viewer();
        const color = Cesium.Color.fromCssColorString(COLORS[layer.style] || COLORS.neutral);
        const hasCallback = typeof Cesium.CallbackProperty === 'function';
        const material = !dashed && typeof Cesium.PolylineGlowMaterialProperty === 'function'
          ? new Cesium.PolylineGlowMaterialProperty({ glowPower: 0.25, color })
          : dashed && typeof Cesium.PolylineDashMaterialProperty === 'function'
            ? new Cesium.PolylineDashMaterialProperty({ color, dashLength: 24 })
            : color;
        layer.entity = v.entities.add({
          polyline: {
            // isConstant=false, but the callback hands back the SAME array until setPath()
            // replaces it — that is what keeps a per-frame property from allocating per frame.
            positions: hasCallback ? new Cesium.CallbackProperty(() => layer._cart, false) : layer._cart,
            width: dashed ? 4 : 6, material, arcType: Cesium.ArcType ? Cesium.ArcType.NONE : undefined,
          },
        });
        layer.entity.__finsLine = true;
        layer.entity.show = layer._cart.length >= 2;
        layer.mode = hasCallback ? 'callback' : 'swap';
        layer.ok = true;
      } catch (e) {
        layer.ok = false;
        layer.mode = 'none';
        console.warn('[finsRace] racing line unavailable; the race is unaffected', e);
      }
      return layer.mode;
    };

    // Recolour without rebuilding: a material swap on the existing entity.
    layer.setStyle = (style) => {
      if (!layer.ok || !layer.entity) { layer.style = style; return; }
      if (layer.style === style) return;
      layer.style = style;
      try {
        const color = Cesium.Color.fromCssColorString(COLORS[style] || COLORS.neutral);
        const mat = layer.entity.polyline.material;
        if (mat && mat.color && typeof mat.color === 'object' && 'setValue' in mat.color) mat.color.setValue(color);
        else if (mat && typeof mat === 'object' && 'color' in mat) mat.color = color;
        else layer.entity.polyline.material = color;
      } catch (_) { /* a line in the wrong colour is still a useful line */ }
    };

    return layer;
  }

  // ------------------------------------------------------------- racing line
  // Owns which path the line shows and how often it is rebuilt. Two sources, in order:
  // the selected ghost's trace (the real line somebody flew), or — when there is no trace for
  // this course at all — a Catmull-Rom spline through the gate centres, drawn dashed and in a
  // neutral colour, and labelled in the panel as a suggestion rather than a recorded run.
  const LineRenderer = {
    layer: null, source: 'none', lastBuild: 0, builtFor: '', hint: 0, note: '',

    enabled() { return CONFIG.RACING_LINE && this.on; },
    on: true,

    toggle() {
      this.on = !this.on;
      store.set('racingLine', this.on);
      if (!this.on && this.layer) this.layer.clear();
      this.builtFor = '';
      this.syncNote();
      return this.on;
    },
    restore() { this.on = store.get('racingLine', true) !== false; },

    // Which source applies right now. Kept separate from rendering so the panel label and the
    // drawing can never disagree about what is on screen.
    pick() {
      if (!CONFIG.RACING_LINE || !this.on || !Race.course) return 'none';
      return CONFIG.GHOST && Ghost.trace && Ghost.trace.samples.length >= 2 ? 'trace' : 'spline';
    },

    reset() { this.hint = 0; this.builtFor = ''; },

    // Called once per animation frame; does real work at most CONFIG.LINE_REBUILD_HZ times a
    // second. Everything Cesium touches is inside makeLineLayer().
    tick(now) {
      if (!CONFIG.RACING_LINE) return;
      const want = this.pick();
      if (want !== this.source || (want !== 'none' && this.builtFor !== this.key())) {
        this.source = want;
        this.builtFor = this.key();
        if (want === 'none') { if (this.layer) this.layer.clear(); this.syncNote(); return; }
        if (!this.layer) this.layer = makeLineLayer();
        this.layer.style = want === 'spline' ? 'neutral' : lineColorFor(Ghost.delta, CONFIG.LINE_DELTA_BAND_MS);
        this.layer.build(want === 'spline');
        this.lastBuild = 0;
        this.syncNote();
      }
      if (this.source === 'none' || !this.layer || !this.layer.ok) return;
      const period = 1000 / Math.max(0.2, +CONFIG.LINE_REBUILD_HZ || 2);
      if (now - this.lastBuild < period) return;
      this.lastBuild = now;
      if (this.source === 'spline') {
        if (!this.layer.positions.length) this.layer.setPath(catmullRomPath(Race.course.gates, CONFIG.LINE_SPLINE_STEPS));
        return;
      }
      // Trace source: slide the window forward from wherever I am on the ghost's path, and
      // recolour from the live delta the HUD is already computing.
      if (Race.pos) {
        const near = traceNearest(Ghost.trace, ecef(Race.pos.lat, Race.pos.lon, Race.pos.alt), this.hint, CONFIG.TRACE_SEARCH_N);
        if (near) this.hint = near.index;
      }
      this.layer.setPath(traceWindow(Ghost.trace, this.hint, CONFIG.LINE_AHEAD_M));
      this.layer.setStyle(lineColorFor(Ghost.delta, CONFIG.LINE_DELTA_BAND_MS));
    },

    key() { return (Race.hash || '') + '|' + this.pick() + '|' + (Ghost.meta ? Ghost.meta.callsign : ''); },

    label() {
      if (!CONFIG.RACING_LINE) return '';
      if (!this.on) return 'Racing line off (Alt+L).';
      const src = this.pick();
      if (src === 'spline') return 'Suggested line (no recorded run yet)';
      if (src === 'trace') return 'Racing line: ' + (Ghost.meta ? Ghost.meta.callsign : 'ghost') + "'s line";
      return '';
    },
    syncNote() {
      this.note = this.label();
      try { if (UI.E.lineStatus) UI.E.lineStatus.textContent = this.note; } catch (_) {}
    },
  };

  // ------------------------------------------------------------------- UI
  const h = (tag, attrs, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null) continue;
      if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v);
    }
    for (const kid of kids) if (kid != null) el.append(kid);
    return el;
  };

  // Shell (1.3.0, LOBBY_V2) CSS: a self-contained dark-navy/amber palette scoped entirely under
  // #fr-shell, so it can never collide with or depend on #fr-root's own plum/pink theme and
  // variables (which are scoped under #fr-root and don't inherit into a sibling element). No
  // external font — every mockup Barlow/IBM-Plex-Mono reference here is the system stack instead,
  // per CLAUDE.md's "no asset downloads beyond COURSE_BASE/MODEL_BASE/API_BASE".
  // How long a Shell.notify() line stays up. Long enough to read one sentence, short enough that
  // it never becomes part of the furniture.
  const SHELL_NOTICE_MS = 6000;

  // Race.state as the Solo screen says it. Race's own names are internal ('armed' means a course
  // is loaded and the clock has not started), so they are spelled out rather than shown raw.
  const SOLO_STATE_LABELS = { idle: 'No course', armed: 'Ready to fly', running: 'Running',
    finished: 'Finished', dq: 'Disqualified' };

  const SHELL_CSS = `
#fr-shell-proto{margin:0 14px 8px;padding:7px 11px;border-radius:8px;background:rgba(255,92,92,.14);
  border:1px solid rgba(255,92,92,.5);color:#ffd0d0;font-size:12px;font-weight:600}
#fr-toasts{position:fixed;right:16px;bottom:16px;z-index:100001;display:flex;flex-direction:column;gap:6px;
  max-width:min(420px,calc(100vw - 32px));pointer-events:none;font:13px/1.4 system-ui,sans-serif}
.fr-toast{pointer-events:auto;padding:8px 12px;border-radius:8px;background:#131a22;color:#e6edf3;
  border:1px solid #2c3d4f;box-shadow:0 4px 14px rgba(0,0,0,.4)}
.fr-toast-error{border-color:#ff5c5c;background:#2a1414;color:#ffd0d0}
.fr-toast-warn{border-color:#f0a429;background:#1c1608;color:#f5d9a8}
#fr-shell-notice{margin:0 14px 8px;padding:7px 11px;border-radius:8px;background:rgba(240,164,41,.14);
  border:1px solid rgba(240,164,41,.45);color:#F5D9A8;font-size:12px;line-height:1.4}
#fr-shell{--bg:#0b0f14;--panel:#131a22;--panel2:#0e141b;--panel3:#1b2733;--border:#223040;--border2:#2c3d4f;
  --amber:#f0a429;--amberbg:#1c1608;--amberborder:#6b5322;--cyan:#4cc9e8;--cyanborder:#2e6e82;
  --green:#3fcf6e;--greenbg:#0f1f17;--greenborder:#1f5f3a;--red:#ff5c5c;--redborder:#5a2a2a;
  --text:#e6edf3;--text2:#a9b9c9;--dim2:#8a9bad;--faint:#5d6e80;
  position:fixed;top:64px;left:50%;transform:translateX(-50%);z-index:99999;
  width:min(95vw,1180px);max-height:calc(100vh - 88px);overflow:auto;
  background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:12px;
  box-shadow:0 20px 60px rgba(0,0,0,.5);font:13px/1.45 "Segoe UI",system-ui,sans-serif}
#fr-shell.fr-hidden{display:none}
#fr-shell .fr-mono{font-family:"Consolas","IBM Plex Mono",ui-monospace,monospace}
#fr-shell .fr-dim{color:var(--dim2)}
#fr-shell .fr-row{display:flex;gap:8px;align-items:center}
#fr-shell button{font:inherit;cursor:pointer;background:transparent;color:var(--text);border:1px solid var(--border2);
  border-radius:6px;padding:6px 12px}
#fr-shell button:hover{border-color:var(--amber)}
#fr-shell button:focus-visible{outline:2px solid var(--amber);outline-offset:1px}
#fr-shell button.fr-go{background:var(--amber);color:#0b0f14;border:0;font-weight:700}
#fr-shell input,#fr-shell select{font:inherit;background:var(--panel2);color:var(--text);border:1px solid var(--border2);
  border-radius:6px;padding:6px 10px}
#fr-shell .fr-pill{display:inline-block;padding:2px 9px;border-radius:4px;font-size:11px;font-weight:700;
  letter-spacing:.06em;text-transform:uppercase}
#fr-shell .fr-pill-amber{background:var(--amber);color:#0b0f14}
#fr-shell .fr-pill-cyan{color:var(--cyan);border:1px solid var(--cyanborder)}
#fr-shell .fr-pill-green{color:var(--green);border:1px solid var(--greenborder);background:var(--greenbg)}
#fr-shell .fr-pill-red{color:var(--red);border:1px solid var(--redborder)}
#fr-shell .fr-pill-grey{color:var(--text2);border:1px solid var(--border2)}
#fr-shell .fr-chip{font-size:12px;padding:3px 9px;border-radius:4px;background:var(--panel3);color:var(--text2)}

#fr-shell-top{display:flex;align-items:center;gap:14px;padding:0 18px;height:52px;flex-shrink:0;
  border-bottom:1px solid var(--border);background:var(--panel2);border-radius:12px 12px 0 0;cursor:move;user-select:none}
#fr-shell-top button{cursor:pointer}
.fr-shell-brand{display:flex;gap:6px;align-items:baseline;font-weight:700;letter-spacing:.1em}
.fr-shell-brand b{color:var(--amber)}
.fr-shell-brand span{color:var(--dim2);font-weight:500}
.fr-shell-back{width:30px;height:30px;padding:0;display:flex;align-items:center;justify-content:center}
.fr-shell-tabs{display:flex;gap:2px}
.fr-shell-tab{border:0;border-bottom:2px solid transparent;border-radius:0;padding:8px 10px;color:var(--dim2);
  letter-spacing:.08em;text-transform:uppercase;font-size:12px;font-weight:600}
.fr-shell-tab:hover{border-color:transparent;color:var(--text)}
.fr-shell-tab-on{color:var(--amber);border-bottom-color:var(--amber)}
.fr-shell-room{font-family:"Consolas",monospace;color:var(--amber);background:var(--amberbg);
  border:1px solid var(--amberborder);border-radius:6px;padding:4px 10px}
.fr-shell-count{white-space:nowrap}
.fr-shell-status{font-size:12px;color:var(--faint)}
.fr-shell-me{font-family:"Consolas",monospace;font-weight:700;color:var(--amber);border-color:var(--border2)}
.fr-shell-btn-danger{color:var(--red);border-color:var(--redborder)}
#fr-shell-reconnect{padding:8px 18px;background:var(--amberbg);color:var(--amber);font-size:12px;text-align:center}
#fr-shell-reconnect.fr-hidden{display:none}

#fr-shell-body{padding:18px}
.fr-screen.fr-hidden{display:none}
/* Collapse (1.3.1): the shell shrinks to #fr-shell-reopen, which lives OUTSIDE #fr-shell so
   that collapsing cannot hide the control that brings it back. */
#fr-shell.fr-collapsed{display:none}
#fr-shell-reopen{position:fixed;right:16px;bottom:16px;z-index:1000;display:flex;align-items:center;gap:7px;
  background:var(--panel);color:var(--text);border:1px solid var(--amber);border-radius:999px;
  padding:9px 15px;font:inherit;font-size:12px;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.45)}
#fr-shell-reopen:hover{border-color:var(--cyan)}
#fr-shell-reopen:focus-visible{outline:2px solid var(--amber);outline-offset:2px}
#fr-shell-reopen b{color:var(--amber);letter-spacing:.06em}
.fr-shell-reopen-note:empty{display:none}
.fr-shell-collapse{font-size:15px;line-height:1;padding:3px 10px}

/* Courses + Solo (1.3.1): both were .fr-screen-stub placeholders through 1.3.0. */
.fr-courses-rows{display:flex;flex-direction:column;gap:6px;padding:0 4px 18px}
.fr-course-row{display:flex;align-items:center;gap:10px;background:var(--panel);border:1px solid var(--border);
  border-radius:8px;padding:10px 14px}
.fr-course-row-main{display:flex;flex-direction:column;gap:2px;min-width:0}
.fr-solo-card{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:18px;
  max-width:560px;display:flex;flex-direction:column;gap:12px}
.fr-solo-card h1{margin:0;font-size:20px}
.fr-solo-card p{margin:0;line-height:1.6}
.fr-solo-card select{flex:1;min-width:0}
.fr-solo-course,.fr-solo-state{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
#fr-courses,#fr-solo{padding:20px;overflow:auto}
.fr-screen-stub{padding:40px 20px;max-width:520px}
.fr-screen-stub h1{margin:0 0 8px;font-size:20px}
.fr-screen-stub p{color:var(--text2);line-height:1.6;margin:0}

/* Ramp */
#fr-ramp{display:flex;gap:18px;align-items:flex-start}
.fr-ramp-board{flex:1;min-width:0;display:flex;flex-direction:column;gap:10px}
.fr-ramp-title-row{display:flex;align-items:baseline;gap:10px}
.fr-ramp-title-row h1{margin:0;font-size:19px;letter-spacing:.04em}
.fr-ramp-head{font-size:13px;color:var(--dim2)}
.fr-ramp-rows{display:flex;flex-direction:column;gap:8px}
.fr-ramp-rows.fr-hidden{display:none}
.fr-ramp-row{display:grid;grid-template-columns:150px 1fr 70px auto auto;gap:14px;align-items:center;
  background:var(--panel);border:1px solid var(--border);border-left:4px solid var(--faint);
  border-radius:8px;padding:12px 14px}
.fr-ramp-row-amber{border-left-color:var(--amber)}
.fr-ramp-row-cyan{border-left-color:var(--cyan)}
.fr-ramp-row-grey{border-left-color:var(--border2);opacity:.7}
.fr-ramp-row-code{display:flex;flex-direction:column;gap:3px}
.fr-ramp-row-course{display:flex;flex-direction:column;gap:3px;min-width:0}
.fr-ramp-row-course>span:first-child{font-weight:600}
.fr-ramp-row-pilots{font-family:"Consolas",monospace}
.fr-ramp-row-status{display:flex;flex-direction:column;gap:4px;align-items:flex-start}
.fr-ramp-action{white-space:nowrap}
.fr-ramp-action-amber{background:var(--amber);color:#0b0f14;border:0;font-weight:700}
.fr-ramp-action-cyan{color:var(--cyan);border-color:var(--cyanborder)}
.fr-ramp-action-grey{color:var(--dim2)}
.fr-ramp-empty{padding:30px 10px;text-align:center;color:var(--text2)}
.fr-ramp-empty.fr-hidden{display:none}
.fr-ramp-empty .fr-row{justify-content:center;margin-top:10px}
.fr-ramp-new{border-style:dashed}
.fr-ramp-podium-wrap.fr-hidden{display:none}
.fr-podium-card{flex:1;background:var(--panel);border:1px solid var(--border);border-radius:8px;
  padding:8px 12px;display:flex;gap:10px;align-items:center}
.fr-ramp-rail{width:300px;flex-shrink:0;display:flex;flex-direction:column;gap:12px}
.fr-ramp-card{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:14px;
  display:flex;flex-direction:column;gap:8px}
.fr-ramp-card-title{font-weight:700;display:flex;justify-content:space-between}
.fr-ramp-quick{background:var(--amberbg);border-color:var(--amberborder)}
.fr-ramp-quick-btn{width:100%}
.fr-ramp-ping-btn{display:flex;justify-content:space-between;width:100%}
.fr-presence-rows{display:flex;flex-direction:column;max-height:220px;overflow:auto}
.fr-presence-row{display:flex;gap:8px;align-items:center;padding:6px 0;border-top:1px solid var(--border)}
.fr-presence-row:first-child{border-top:0}
.fr-presence-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0}
.fr-presence-busy{background:var(--green)}
.fr-presence-idle{background:var(--faint)}
.fr-ramp-me{gap:4px}

/* Gate */
#fr-gate{display:flex;gap:18px;align-items:flex-start}
.fr-gate-left{flex:1;min-width:0;display:flex;flex-direction:column;gap:16px}
.fr-gate-section{display:flex;flex-direction:column;gap:10px}
.fr-gate-head{display:flex;align-items:baseline;gap:10px}
.fr-gate-head h2{margin:0;font-size:16px;letter-spacing:.04em}
.fr-vote-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px}
.fr-vote-grid.fr-hidden{display:none}
.fr-vote-tile{display:flex;flex-direction:column;gap:6px;align-items:flex-start;text-align:left;
  background:var(--panel);border:1px solid var(--border2);border-radius:8px;padding:12px;min-height:120px}
.fr-vote-tile-mine{background:var(--amberbg);border-color:var(--amberborder)}
.fr-vote-bar{width:100%;height:5px;background:var(--panel3);border-radius:3px;overflow:hidden}
.fr-vote-bar-fill{height:5px;background:var(--amber)}
.fr-pilot-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px}
.fr-pilot-card{background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:12px;
  display:flex;flex-direction:column;gap:7px}
.fr-pilot-card-mine{border-color:var(--amber)}
.fr-crown{color:var(--amber)}
.fr-ready-bar{display:flex;align-items:center;gap:16px;background:var(--panel);border:1px solid var(--border2);
  border-radius:10px;padding:14px 18px}
.fr-ready-bar-format{display:flex;flex-direction:column;gap:6px}
.fr-gate-format-chips{display:flex;gap:6px;flex-wrap:wrap}
.fr-ready-bar-status{display:flex;flex-direction:column;gap:2px;align-items:flex-end;text-align:right}
.fr-gate-ready-btn{padding:12px 26px;font-weight:700;letter-spacing:.06em;text-transform:uppercase}
.fr-gate-ready-on{background:var(--green);color:#06170e;border:0}
.fr-gate-chat{width:340px;flex-shrink:0;background:var(--panel);border:1px solid var(--border);border-radius:10px;
  display:flex;flex-direction:column;max-height:640px}
.fr-gate-chat-head{display:flex;justify-content:space-between;padding:10px 14px;border-bottom:1px solid var(--border);
  font-size:12px;color:var(--faint);letter-spacing:.06em;text-transform:uppercase}
.fr-chat-feed{flex:1;overflow:auto;padding:10px 14px;display:flex;flex-direction:column;gap:8px;min-height:160px}
.fr-chat-line{display:flex;flex-direction:column;gap:2px}
.fr-chat-quick{display:flex;flex-wrap:wrap;gap:6px;padding:0 14px}
.fr-chat-quick button{border-radius:999px;font-size:12px;padding:5px 10px}
.fr-gate-chat .fr-row{padding:12px 14px}
.fr-gate-chat input{flex:1}
.fr-gate-chat-compose.fr-hidden{display:none}

/* Launch */
#fr-launch{display:flex;flex-direction:column;gap:16px}
.fr-launch-body{display:flex;gap:18px;align-items:stretch}
.fr-launch-grid{width:300px;flex-shrink:0;background:var(--panel);border:1px solid var(--border);border-radius:10px;
  padding:14px;display:flex;flex-direction:column;gap:10px}
.fr-launch-head{display:flex;justify-content:space-between;align-items:baseline}
.fr-launch-head h2{margin:0;font-size:15px}
.fr-grid-list{display:flex;flex-direction:column;gap:8px}
.fr-grid-row{display:flex;align-items:center;gap:10px;background:var(--panel3);border:1px solid var(--border);
  border-radius:8px;padding:8px 10px}
.fr-grid-row-mine{background:var(--amberbg);border-color:var(--amberborder)}
.fr-grid-index{width:18px;color:var(--dim2)}
.fr-launch-center{flex:1;background:var(--panel2);border:1px solid var(--border2);border-radius:10px;
  display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;padding:24px}
.fr-launch-cd-label{font-size:13px;letter-spacing:.2em;text-transform:uppercase;color:var(--dim2)}
.fr-launch-cd-big{font-family:"Consolas",monospace;font-size:96px;line-height:.9;color:var(--amber)}
.fr-launch-hold-card{background:var(--panel);border:1px solid var(--border2);border-radius:8px;padding:10px 18px;
  display:flex;flex-direction:column;align-items:center;gap:4px}
.fr-launch-reposition{display:flex;align-items:center;gap:8px;padding:8px 14px;background:var(--greenbg);
  border:1px solid var(--greenborder);border-radius:999px;color:var(--green);font-size:13px}
.fr-launch-reposition.fr-hidden{display:none}
.fr-launch-course{width:340px;flex-shrink:0;background:var(--panel);border:1px solid var(--border);border-radius:10px;
  padding:14px;display:flex;flex-direction:column;gap:10px}
.fr-launch-course-id{font-size:18px}
.fr-launch-route{background:var(--panel2);border:1px solid var(--border);border-radius:8px;padding:8px}
.fr-launch-route svg{display:block}
.fr-launch-fact{flex:1;background:var(--panel3);border-radius:6px;padding:8px;display:flex;flex-direction:column;gap:2px}
.fr-launch-ghost-row{display:flex;gap:10px;align-items:center;background:var(--panel3);border:1px solid var(--border2);
  border-radius:6px;padding:8px 10px}
.fr-launch-strip{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:12px 18px;
  display:flex;align-items:center;gap:20px;font-size:13px;color:var(--text2);flex-wrap:wrap}
.fr-launch-sep{width:1px;height:22px;background:var(--border2)}
/* Last on purpose, and !important: fr-hidden has to beat every display rule above it. Through 1.3.x
   only a few elements had their own .fr-hidden rule, so hiding the rest (the notice box, host-only
   controls, the reopen tab) did nothing at all. */
#fr-shell .fr-hidden,#fr-shell-reopen.fr-hidden,#fr-toasts .fr-hidden{display:none!important}
`;

  const CSS = `
#fr-root{--plum:#1d1029;--plum2:#2c1a3d;--sun:#ff8a3d;--pink:#ff3d8b;--cream:#fff4ea;--dim:#b9a6c8;--fast:#5be38f;--slow:#ff6b6b;
  position:fixed;top:72px;right:16px;width:300px;z-index:100000;color:var(--cream);
  font:13px/1.4 "Trebuchet MS","Segoe UI",system-ui,sans-serif;background:rgba(29,16,41,.9);
  border:1px solid rgba(255,138,61,.35);border-radius:14px;box-shadow:0 10px 30px rgba(10,0,20,.5);
  backdrop-filter:blur(6px);user-select:none}
#fr-root.fr-hidden{display:none}
#fr-countdown.fr-hidden,#fr-root .fr-proto-hidden{display:none}
#fr-root *{box-sizing:border-box}
#fr-head{display:flex;align-items:center;gap:8px;padding:9px 12px;cursor:move;border-bottom:1px solid rgba(255,255,255,.08)}
#fr-head b{font-size:13px;letter-spacing:.02em;background:linear-gradient(90deg,var(--sun),var(--pink));-webkit-background-clip:text;background-clip:text;color:transparent}
#fr-head small{color:var(--dim);flex:1}
#fr-body{padding:10px 12px 12px}
#fr-root.fr-min #fr-body{display:none}
#fr-root.fr-hud-owns-timer #fr-timer{display:none}
.fr-row{display:flex;gap:6px;align-items:center;margin:6px 0}
.fr-row>select,.fr-row>input{flex:1;min-width:0}
#fr-root select,#fr-root input,#fr-root textarea{background:var(--plum2);color:var(--cream);border:1px solid rgba(255,255,255,.14);
  border-radius:8px;padding:5px 7px;font:inherit}
#fr-root textarea{width:100%;height:64px;resize:vertical;font-size:11px}
#fr-root button{background:var(--plum2);color:var(--cream);border:1px solid rgba(255,255,255,.18);border-radius:8px;
  padding:5px 9px;font:inherit;cursor:pointer;white-space:nowrap}
#fr-root button:hover{border-color:var(--sun)}
#fr-root button.fr-go{background:linear-gradient(90deg,var(--sun),var(--pink));border:0;color:#240a1f;font-weight:bold}
#fr-root button:focus-visible,#fr-root input:focus-visible,#fr-root select:focus-visible,#fr-root summary:focus-visible{outline:2px solid var(--sun);outline-offset:1px}
#fr-root kbd{font:inherit;font-size:11px;color:var(--dim)}
#fr-timer{font-size:40px;font-weight:bold;line-height:1.05;font-variant-numeric:tabular-nums;margin-top:6px;
  background:linear-gradient(90deg,var(--sun),var(--pink));-webkit-background-clip:text;background-clip:text;color:transparent}
#fr-timer.fr-dq{background:none;color:var(--slow)}
#fr-nav{display:flex;gap:12px;align-items:center;font-variant-numeric:tabular-nums}
#fr-arrow{display:inline-block;width:22px;text-align:center;font-size:18px;color:var(--fast);transition:transform .1s linear}
#fr-status{color:var(--dim);margin:4px 0 2px;min-height:18px}
#fr-start-hint{color:var(--sun);margin:2px 0;font-size:12px}
#fr-start-hint:empty{display:none}
#fr-cd-big{font-size:28px;font-weight:bold;margin:4px 0;font-variant-numeric:tabular-nums;color:var(--sun)}
#fr-cd-big:empty{display:none}
#fr-splits{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums;margin-top:6px}
#fr-splits td{padding:1px 0}
#fr-splits td:nth-child(2),#fr-splits td:nth-child(3){text-align:right}
.fr-fast{color:var(--fast)}.fr-slow{color:var(--slow)}.fr-dim{color:var(--dim)}
#fr-root details{margin-top:10px;border-top:1px solid rgba(255,255,255,.08);padding-top:6px}
#fr-root summary{cursor:pointer;color:var(--cream)}
#fr-lb{margin:6px 0 0;padding-left:20px;font-variant-numeric:tabular-nums}
#fr-lb li span{float:right}
#fr-banner{position:fixed;left:50%;top:22%;transform:translateX(-50%);z-index:100001;pointer-events:none;
  font:bold 56px/1 "Trebuchet MS",system-ui,sans-serif;color:var(--cream,#fff4ea);text-shadow:0 3px 0 #ff3d8b,0 6px 18px rgba(0,0,0,.6);
  opacity:0;transition:opacity .25s;text-align:center;white-space:nowrap}
#fr-banner small{display:block;font-size:22px;margin-top:8px}
#fr-banner.fr-show{opacity:1}
#fr-feed{list-style:none;margin:6px 0 0;padding:0;font-size:11px;color:var(--dim)}
#fr-feed li{padding:1px 0;border-top:1px solid rgba(255,255,255,.06)}
#fr-feed li:first-child{color:var(--cream);border-top:0}
/* Offensive-hit screen effects. Pure DOM overlay: never touches the aircraft, always
   time-boxed by Powerups.tick(), and pointer-events:none so it can't eat clicks even if a
   bug left it up. Each is additive, so a banana+goop stack reads as both. */
#fr-fx{position:fixed;inset:0;z-index:99999;pointer-events:none;opacity:0;transition:opacity .2s}
#fr-fx.fr-fx-on{opacity:1}
#fr-fx .fr-fx-layer{position:absolute;inset:0;opacity:0}
#fr-fx.fr-fx-banana .fr-fx-banana-l{opacity:1;background:radial-gradient(circle at 50% 50%,transparent 45%,rgba(255,210,61,.45) 100%);
  animation:fr-wobble 1.1s ease-in-out infinite}
#fr-fx.fr-fx-missile .fr-fx-missile-l{opacity:1;background:radial-gradient(circle at 50% 55%,rgba(255,196,0,.28) 0%,rgba(190,90,0,.6) 100%)}
/* Goop. Two things here are about the ending being readable rather than about the tint: the
   blobs slide slowly downward the whole time (fr-goop-slide), and in the last second the layer
   is wiped from the centre outward by a radial mask whose hole is --fr-goop-clear, set per
   frame by UI.renderEffects(). Wiping from the centre means the view opens where you are
   looking first, so the last second of a goop is usable instead of a sudden reveal. */
#fr-fx .fr-fx-goop-l{--fr-goop-clear:0%;
  -webkit-mask-image:radial-gradient(circle at 50% 50%,transparent var(--fr-goop-clear),#000 calc(var(--fr-goop-clear) + 10%));
  mask-image:radial-gradient(circle at 50% 50%,transparent var(--fr-goop-clear),#000 calc(var(--fr-goop-clear) + 10%))}
#fr-fx.fr-fx-goop .fr-fx-goop-l{opacity:1;backdrop-filter:blur(7px) saturate(1.5);
  background:radial-gradient(circle at 28% 34%,rgba(120,200,40,.85) 0 16%,transparent 17%),
             radial-gradient(circle at 72% 28%,rgba(150,215,60,.8) 0 19%,transparent 20%),
             radial-gradient(circle at 44% 72%,rgba(100,180,30,.85) 0 22%,transparent 23%),
             radial-gradient(circle at 82% 68%,rgba(140,205,50,.75) 0 14%,transparent 15%),
             rgba(90,160,30,.5);
  animation:fr-goop-slide 9s linear infinite}
@keyframes fr-goop-slide{from{background-position:0 -40px,0 -30px,0 -50px,0 -24px,0 0}
  to{background-position:0 40px,0 30px,0 50px,0 24px,0 0}}
/* Boost, on the booster's own screen only: a radial speed-line vignette. Deliberately the
   subtlest thing in this file — it has to say "you are going fast" without covering the gate
   you are aiming at, which is the opposite job from the hit effects above. */
#fr-fx.fr-fx-boost .fr-fx-boost-l{opacity:1;
  background:repeating-conic-gradient(from 0deg at 50% 50%,
    rgba(255,138,61,.16) 0deg 1.2deg,transparent 1.2deg 7deg);
  -webkit-mask-image:radial-gradient(circle at 50% 50%,transparent 38%,#000 78%);
  mask-image:radial-gradient(circle at 50% 50%,transparent 38%,#000 78%);
  animation:fr-boost-pulse 1.1s ease-in-out infinite}
@keyframes fr-boost-pulse{0%,100%{opacity:.75;transform:scale(1)}50%{opacity:1;transform:scale(1.03)}}
@keyframes fr-wobble{0%,100%{transform:rotate(-1.4deg)}50%{transform:rotate(1.4deg)}}
/* ---- items (0.10.0). The inbound-projectile warning and its directional arrow. Both live in
   #fr-hud (pointer-events:none) and are pure mirrors of Items state — nothing here can affect
   the race, and everything is removed by the same frame that clears the projectile. */
#fr-hud-inbound{position:absolute;left:50%;top:14%;transform:translateX(-50%);display:none;
  min-width:260px;padding:8px 14px;border-radius:10px;text-align:center;
  background:rgba(30,6,6,.72);border:1px solid rgba(255,90,90,.75);box-shadow:0 6px 24px rgba(0,0,0,.5)}
#fr-hud-inbound.fr-hud-wp-show{display:block}
#fr-hud-inbound b{display:block;font:bold 17px/1.2 "Trebuchet MS",sans-serif;letter-spacing:.06em;color:#ffd23d}
#fr-hud-inbound .fr-in-bar{margin-top:6px;height:6px;border-radius:3px;background:rgba(255,255,255,.15);overflow:hidden}
#fr-hud-inbound .fr-in-fill{height:100%;width:100%;background:linear-gradient(90deg,#ffd23d,#ff5a5a);transition:none}
#fr-hud-inbound.fr-in-goop b{color:#7ad42a}
#fr-hud-inbound.fr-in-goop .fr-in-fill{background:linear-gradient(90deg,#7ad42a,#3d8a12)}
#fr-hud-in-arrow{position:absolute;left:0;top:0;will-change:transform;display:none;
  font:bold 30px/1 "Trebuchet MS",sans-serif;color:#ffd23d;text-shadow:0 2px 6px rgba(0,0,0,.8);
  margin:-15px 0 0 -12px}
#fr-hud-in-arrow.fr-hud-wp-show{display:block}
@media (prefers-reduced-motion:reduce){
  #fr-banner,#fr-arrow{transition:none}
  /* Keep every tint/blur (the actual penalty) but drop the motion. */
  #fr-fx.fr-fx-banana .fr-fx-banana-l{animation:none}
  #fr-fx.fr-fx-goop .fr-fx-goop-l{animation:none}
  #fr-fx.fr-fx-boost .fr-fx-boost-l{animation:none}
  #fr-fx{transition:none}
  /* The hit shake is motion and nothing else, so it is dropped entirely here — see Shake. */
  #fr-hud-inbound{transition:none}
}
@media (max-width:520px){#fr-root{width:calc(100vw - 24px);right:12px}}

/* ---- race HUD (#fr-hud): a second, full-viewport DOM surface, purely a mirror of state that
   already exists elsewhere (Race/Powerups/Relay/G). pointer-events:none throughout so it can
   never eat a click; z-index sits below #fr-root/#fr-banner per the task spec. */
#fr-hud{position:fixed;inset:0;z-index:99998;pointer-events:none;color:var(--cream,#fff4ea);
  font:13px/1.3 "Trebuchet MS","Segoe UI",system-ui,sans-serif;font-variant-numeric:tabular-nums;
  opacity:0;transition:opacity .15s}
#fr-hud.fr-hud-show{opacity:1}
#fr-hud.fr-hud-off{display:none}
#fr-hud *{box-sizing:border-box}
#fr-hud-pos-block{position:absolute;left:16px;top:16px;max-width:240px;text-shadow:0 1px 4px rgba(0,0,0,.8)}
#fr-hud .fr-hud-hidden{display:none}
#fr-hud-rank{font-size:34px;font-weight:bold;line-height:1}
#fr-hud-of{color:var(--dim);font-size:13px;margin:2px 0 4px}
#fr-hud-gap{color:var(--sun);font-size:12px;margin-bottom:6px}
#fr-hud-tower{list-style:none;margin:0;padding:0;font-size:11px}
#fr-hud-tower li{display:flex;gap:6px;padding:1px 0;color:var(--dim)}
#fr-hud-tower li.fr-hud-me{color:var(--cream);font-weight:bold}
#fr-hud-tower .fr-hud-tower-rank{width:16px}
#fr-hud-tower .fr-hud-tower-cs{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#fr-hud-tower .fr-hud-tower-gap{color:var(--sun)}
#fr-hud-center{position:absolute;left:50%;top:14px;transform:translateX(-50%);text-align:center;
  text-shadow:0 1px 4px rgba(0,0,0,.8)}
#fr-hud-timer{font-size:36px;font-weight:bold;background:linear-gradient(90deg,var(--sun),var(--pink));
  -webkit-background-clip:text;background-clip:text;color:transparent}
#fr-hud-timer:empty{display:none}
#fr-hud-chiprow{display:flex;gap:10px;align-items:baseline;justify-content:center;height:18px}
#fr-hud-chip{font-size:15px;font-weight:bold;opacity:0;transition:opacity .2s}
#fr-hud-chip.fr-hud-chip-show{opacity:1}
#fr-hud-chip.fr-fast{color:var(--fast)}#fr-hud-chip.fr-slow{color:var(--slow)}
#fr-hud-ghost{font-size:13px;font-weight:bold;opacity:0;transition:opacity .2s;color:var(--dim)}
#fr-hud-ghost.fr-hud-ghost-show{opacity:1}
#fr-hud-ghost.fr-fast{color:var(--fast)}#fr-hud-ghost.fr-slow{color:var(--slow)}
#fr-hud-ghost.fr-close{color:var(--sun)}
#fr-hud-rivals{display:flex;flex-direction:column;align-items:center;gap:1px;margin-top:2px}
#fr-hud-rivals:empty{display:none}
.fr-hud-rival{font-size:11px;font-weight:bold;color:var(--dim)}
.fr-hud-rival.fr-fast{color:var(--fast)}.fr-hud-rival.fr-slow{color:var(--slow)}.fr-hud-rival.fr-close{color:var(--sun)}
#fr-hud-gatelabel{color:var(--dim);font-size:12px;margin-top:2px}
#fr-hud-pips{display:flex;gap:4px;justify-content:center;margin-top:6px}
#fr-hud-pips .fr-hud-pip{width:8px;height:8px;border-radius:50%;background:rgba(255,255,255,.18)}
#fr-hud-pips .fr-hud-pip.fr-hud-pip-done{background:var(--fast)}
#fr-hud-pips .fr-hud-pip.fr-hud-pip-next{background:var(--sun)}
#fr-hud-feed{position:absolute;right:16px;top:16px;max-width:260px;list-style:none;margin:0;padding:0;
  text-align:right;font-size:12px;text-shadow:0 1px 4px rgba(0,0,0,.8)}
#fr-hud-feed li{padding:1px 0;opacity:1;transition:opacity .6s}
#fr-hud-feed li.fr-hud-feed-out{opacity:0}
#fr-hud-speedalt{position:absolute;left:16px;bottom:16px;font-size:20px;font-weight:bold;
  text-shadow:0 1px 4px rgba(0,0,0,.8)}
#fr-hud-speedalt span{display:block}
#fr-hud-alt{color:var(--dim);font-size:14px;font-weight:normal}
#fr-hud-items{position:absolute;left:50%;bottom:16px;transform:translateX(-50%);display:flex;gap:10px}
.fr-hud-slot{width:64px;text-align:center;text-shadow:0 1px 4px rgba(0,0,0,.8)}
.fr-hud-icon{display:block;width:28px;height:28px;margin:0 auto;color:var(--cream);opacity:.35}
.fr-hud-icon svg{width:100%;height:100%;fill:none;stroke:currentColor;stroke-width:1.6}
.fr-hud-slot.fr-hud-slot-filled .fr-hud-icon{opacity:1;color:var(--sun)}
.fr-hud-slot-label{display:block;font-size:10px;color:var(--dim)}
.fr-hud-slot-key{display:block;font-size:10px;color:var(--dim)}
.fr-hud-slot-bar{height:3px;background:rgba(255,255,255,.15);border-radius:2px;margin-top:3px;overflow:hidden}
.fr-hud-slot-bar-fill{height:100%;width:0%;background:var(--sun)}
#fr-hud-map{position:absolute;right:16px;bottom:16px;width:160px;height:160px}
.fr-mm{display:block}
.fr-mm.fr-mm-empty{visibility:hidden}
.fr-mm-bg{fill:rgba(12,14,20,.55);stroke:rgba(255,255,255,.12);stroke-width:1}
.fr-mm-route{stroke:var(--sun);stroke-width:1.5;opacity:.7;stroke-linejoin:round}
.fr-mm-gates circle{fill:rgba(255,255,255,.25)}
.fr-mm-gates circle.fr-mm-done{fill:var(--fast);opacity:.5}
.fr-mm-gates circle.fr-mm-next{fill:var(--sun)}
.fr-mm-gates circle.fr-mm-rest{fill:rgba(255,255,255,.3)}
.fr-mm-box rect{fill:var(--sun);opacity:.85}
.fr-mm-bananas circle{fill:#ffe14d;stroke:#3a2c00;stroke-width:.6}
.fr-mm-others circle{fill:var(--pink);opacity:.85}
.fr-mm-ghost{fill:#9fd0ff;opacity:.7}
.fr-mm-me{fill:var(--cream);stroke:rgba(0,0,0,.7);stroke-width:1}
.fr-mm-north{position:absolute;right:6px;top:4px;font-size:10px;color:var(--dim)}
/* Waypoint bracket. The container sits at the origin and is moved ONLY with translate3d every
   animation frame; everything that centres the artwork on the gate is static CSS offsets, so no
   layout property is ever written from the frame loop. */
#fr-hud-wp,#fr-hud-wp2{position:absolute;left:0;top:0;opacity:0;will-change:transform;
  text-shadow:0 1px 4px rgba(0,0,0,.9)}
#fr-hud-wp.fr-hud-wp-show,#fr-hud-wp2.fr-hud-wp-show{opacity:1}
.fr-hud-wp-box{position:absolute;left:-26px;top:-26px;width:52px;height:52px;
  border:2px solid var(--sun);border-radius:4px;
  clip-path:polygon(0 0,34% 0,34% 8%,8% 8%,8% 34%,0 34%,0 66%,8% 66%,8% 92%,34% 92%,34% 100%,0 100%,
    100% 100%,66% 100%,66% 92%,92% 92%,92% 66%,100% 66%,100% 34%,92% 34%,92% 8%,66% 8%,66% 0,100% 0)}
.fr-hud-wp-chev{position:absolute;left:-10px;top:-14px;font-size:22px;color:var(--sun);line-height:1}
.fr-hud-wp-label{position:absolute;left:-90px;top:32px;width:180px;text-align:center;
  font-size:12px;font-weight:bold;color:var(--cream);white-space:nowrap}
#fr-hud-wp.fr-hud-wp-edge .fr-hud-wp-box{display:none}
#fr-hud-wp:not(.fr-hud-wp-edge) .fr-hud-wp-chev{display:none}
#fr-hud-wp.fr-hud-wp-left .fr-hud-wp-label{left:0;text-align:left}
#fr-hud-wp.fr-hud-wp-right .fr-hud-wp-label{left:-180px;text-align:right}
.fr-hud-wp2-num{position:absolute;left:-11px;top:-11px;width:22px;height:22px;border-radius:50%;
  border:2px solid rgba(255,255,255,.55);color:var(--cream);font-size:11px;font-weight:bold;
  line-height:20px;text-align:center}
@media (max-width:900px){#fr-hud-tower,#fr-hud-feed,#fr-hud-map{display:none}}
@media (prefers-reduced-motion:reduce){#fr-hud,#fr-hud-chip,#fr-hud-ghost,#fr-hud-feed li{transition:none}}

/* ---- lobby overlay (proto 2): a centered card, same append-to-body pattern as #fr-banner so
   it stays visible whether #fr-root is minimized or not. Hidden by default; .fr-show is the
   only thing that reveals it (see UI.renderLobby's gating). */
#fr-lobby{position:fixed;left:50%;top:14%;transform:translateX(-50%);width:340px;max-width:calc(100vw - 24px);
  z-index:100002;display:none;color:var(--cream,#fff4ea);
  font:13px/1.4 "Trebuchet MS","Segoe UI",system-ui,sans-serif;background:rgba(29,16,41,.94);
  border:1px solid rgba(255,138,61,.4);border-radius:14px;box-shadow:0 10px 30px rgba(10,0,20,.6);
  backdrop-filter:blur(6px);padding:12px 14px}
#fr-lobby.fr-show{display:block}
#fr-lobby-head{display:flex;align-items:center;gap:6px;margin-bottom:6px}
#fr-lobby-head b{background:linear-gradient(90deg,var(--sun),var(--pink));-webkit-background-clip:text;background-clip:text;color:transparent}
#fr-lobby-room{font-variant-numeric:tabular-nums}
#fr-lobby-course{margin:4px 0}
#fr-lobby-rules{display:flex;gap:6px;margin:6px 0}
.fr-chip{font-size:11px;padding:2px 8px;border-radius:999px;background:rgba(255,255,255,.1);color:var(--dim)}
.fr-chip-on{background:rgba(91,227,143,.2);color:var(--fast)}
#fr-lobby-pilots{list-style:none;margin:6px 0;padding:0;max-height:160px;overflow-y:auto}
#fr-lobby-pilots li{display:flex;align-items:center;gap:6px;padding:2px 0}
#fr-lobby-pilots li.fr-lobby-me{font-weight:bold}
.fr-lobby-dot{width:8px;height:8px;border-radius:50%;background:rgba(255,255,255,.2);flex:none}
.fr-lobby-dot-ready{background:var(--fast)}
.fr-lobby-cs{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fr-lobby-host-mark{color:var(--sun);font-size:11px}
#fr-lobby-chat{display:flex;flex-wrap:wrap;gap:4px;margin:6px 0}
#fr-lobby-chat button{font-size:11px;padding:3px 7px}
#fr-lobby-ready{display:block;width:100%;margin:8px 0;padding:10px;font-size:16px;font-weight:bold}
#fr-lobby-ready.fr-lobby-ready-on{background:linear-gradient(90deg,var(--fast),var(--sun));border:0;color:#0a2413}
#fr-lobby-host{margin-top:6px;padding-top:6px;border-top:1px solid rgba(255,255,255,.08)}
#fr-lobby-cup{margin:4px 0;color:#ff8a3d}
#fr-lobby-cup:empty{display:none}

/* ---- news banner (0.12.0): "Dave beat your hood-circuit by 0.41s". Appended to <body> like the
   lobby/results cards; dismissible rather than auto-hiding like #fr-banner, since missing it once
   should not mean waiting for the next check. Self-contained CSS vars, same reason #fr-results
   redeclares them: it lives outside #fr-root, which is the only place they are otherwise defined. */
#fr-news{--plum:#1d1029;--plum2:#2c1a3d;--sun:#ff8a3d;--pink:#ff3d8b;--cream:#fff4ea;
  position:fixed;left:50%;top:8px;transform:translateX(-50%);z-index:100002;display:none;
  align-items:center;gap:10px;max-width:calc(100vw - 24px);color:var(--cream);
  font:13px/1.4 "Trebuchet MS","Segoe UI",system-ui,sans-serif;background:rgba(29,16,41,.95);
  border:1px solid rgba(255,138,61,.45);border-radius:10px;box-shadow:0 6px 20px rgba(10,0,20,.5);
  padding:8px 10px}
#fr-news.fr-show{display:flex}
#fr-news button{background:var(--plum2);color:var(--cream);border:1px solid rgba(255,255,255,.18);
  border-radius:6px;padding:4px 9px;font:inherit;cursor:pointer}
#fr-news button:hover{border-color:var(--sun)}

/* ---- results overlay (proto 4): a centered card like the lobby's, appended to <body> so it shows
   whether #fr-root is minimized or not. Hidden until UI.renderResults() finds something to show. It
   takes clicks (the buttons), so unlike #fr-hud it does not set pointer-events:none — and it never
   covers a pilot who is still racing (Results.visible()). */
#fr-results{--plum:#1d1029;--plum2:#2c1a3d;--sun:#ff8a3d;--pink:#ff3d8b;--cream:#fff4ea;--dim:#b9a6c8;--fast:#5be38f;--slow:#ff6b6b;
  position:fixed;left:50%;top:8%;transform:translateX(-50%);width:720px;max-width:calc(100vw - 24px);
  max-height:84vh;overflow:auto;z-index:100002;display:none;color:var(--cream,#fff4ea);
  font:13px/1.4 "Trebuchet MS","Segoe UI",system-ui,sans-serif;background:rgba(29,16,41,.95);
  border:1px solid rgba(255,138,61,.45);border-radius:14px;box-shadow:0 10px 30px rgba(10,0,20,.6);
  backdrop-filter:blur(6px);padding:14px 16px}
#fr-results.fr-show{display:block}
#fr-results *{box-sizing:border-box}
#fr-res-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 12px}
#fr-res-title{font:bold 28px/1.1 "Trebuchet MS",system-ui,sans-serif;background:linear-gradient(90deg,var(--sun),var(--pink));
  -webkit-background-clip:text;background-clip:text;color:transparent}
#fr-res-sub{color:var(--dim);font-variant-numeric:tabular-nums}
.fr-res-badge{align-self:center;padding:2px 10px;border-radius:999px;font-size:12px;font-weight:bold;color:#240a1f;
  background:linear-gradient(90deg,var(--sun),var(--pink))}
#fr-res-course{color:var(--dim);margin:2px 0 8px}
#fr-res-wait{margin:6px 0;color:var(--sun);font-variant-numeric:tabular-nums}
#fr-res-wait:empty{display:none}
#fr-res-body{display:grid;grid-template-columns:minmax(0,1fr) 220px;gap:6px 18px;align-items:start}
#fr-res-body.fr-res-solo{grid-template-columns:minmax(0,1fr)}
@media (max-width:640px){#fr-res-body{grid-template-columns:minmax(0,1fr)}}
#fr-res-table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
#fr-res-table th{text-align:left;font-weight:normal;font-size:11px;color:var(--dim);padding:2px 6px 4px 0}
#fr-res-table td{padding:3px 6px 3px 0;border-top:1px solid rgba(255,255,255,.08);white-space:nowrap}
#fr-res-table .n{text-align:right}
#fr-res-table td.fr-res-cs{white-space:normal;overflow-wrap:anywhere}
#fr-res-table tr.fr-res-me td{font-weight:bold;color:var(--sun)}
#fr-res-table tr.fr-res-wait td{color:var(--dim)}
#fr-res-table .fr-res-js{color:var(--slow);font-size:11px}
#fr-res-side h4{margin:0 0 4px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--sun)}
#fr-res-side ol,#fr-res-side ul{margin:0 0 10px;padding-left:18px;font-variant-numeric:tabular-nums}
#fr-res-side ul{list-style:none;padding-left:0}
#fr-res-side li span{float:right;margin-left:8px}
#fr-res-side li.fr-res-award{margin-bottom:4px}
#fr-res-side li.fr-res-award b{display:block;font-weight:normal;font-size:11px;color:var(--dim)}
#fr-res-buttons{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px;padding-top:10px;border-top:1px solid rgba(255,255,255,.08)}
#fr-res-buttons .fr-res-close{margin-left:auto}
#fr-results button{background:var(--plum2);color:var(--cream);border:1px solid rgba(255,255,255,.18);border-radius:8px;
  padding:6px 11px;font:inherit;cursor:pointer;white-space:nowrap}
#fr-results button:hover{border-color:var(--sun)}
#fr-results button.fr-go{background:linear-gradient(90deg,var(--sun),var(--pink));border:0;color:#240a1f;font-weight:bold}
#fr-results button:focus-visible{outline:2px solid var(--sun);outline-offset:1px}
${SHELL_CSS}
`;

  // ------------------------------------------------------- Ramp / Gate / Launch — pure helpers
  // race/PROTOCOL.md "Proto 5" room registry rows: { code, host, course, cup, format, status,
  // line, pilots, callsigns }. `status` is one of boarding/launching/racing/results/empty
  // (app.py's ROOM_STATUS_FROM_PHASE, plus the registry's own "empty"); the task's departure-board
  // spec names exactly three pill tones, so launching+racing collapse to "In air" (still airborne
  // or about to be) and results+empty collapse to "Closing" (a results-phase room is about to go
  // back to the lobby, an empty one is in its reopen window — both are "wrapping up").
  const ROOM_PILL = {
    boarding: { label: 'Boarding', tone: 'amber' },
    launching: { label: 'In air', tone: 'cyan' },
    racing: { label: 'In air', tone: 'cyan' },
    results: { label: 'Closing', tone: 'grey' },
    empty: { label: 'Closing', tone: 'grey' },
  };
  function roomStatusPill(status) { return ROOM_PILL[status] || { label: String(status || '?'), tone: 'grey' }; }
  // Join / Spectate / Reopen: boarding is the only status you can race INTO; everything mid-flight
  // is watch-only; empty is a reopen (functionally a Join — the first joiner becomes host again,
  // race/PROTOCOL.md "Room registry").
  function roomAction(status) {
    if (status === 'boarding') return 'join';
    if (status === 'empty') return 'reopen';
    return 'spectate';
  }
  // A presence row's one-line activity (the Ramp right rail's "On the ramp" list).
  function presenceLine(row) {
    if (!row) return '';
    if (row.activity === 'racing' && row.room) return 'racing ' + row.room;
    if (row.activity === 'gate' && row.room) return 'in ' + row.room;
    if (row.activity === 'solo') return 'flying solo';
    const idleM = Math.floor((+row.idle_seconds || 0) / 60);
    return idleM > 0 ? 'idle ' + idleM + 'm' : 'idle';
  }
  // Quick Match: the fullest room still boarding (ties -> lower code, for determinism), else null
  // (caller mints a fresh room code and joins it). Never targets a full room; the relay's own cap
  // would refuse that on join anyway, but there's no reason to walk a pilot into that refusal
  // when an open room exists.
  function quickMatchTarget(rooms) {
    const boarding = (Array.isArray(rooms) ? rooms : []).filter((r) => r.status === 'boarding');
    if (!boarding.length) return null;
    boarding.sort((a, b) => (b.pilots - a.pilots) || String(a.code).localeCompare(String(b.code)));
    return boarding[0].code;
  }
  // A vote tile's own math from a real `vote` frame (race/PROTOCOL.md "Course vote"): count, share
  // of the room's cast votes (for the bar width) and whether this pilot cast it. PB/record-holder
  // enrichment is a separate, best-effort lookup the Shell module does opportunistically — this
  // function only ever uses data the vote frame itself carries.
  function voteTileState(candidate, votes, myCallsign) {
    const entries = Object.entries(votes || {});
    const count = entries.filter(([, c]) => c === candidate.courseId).length;
    const total = entries.length;
    return { courseId: candidate.courseId, name: candidate.name, count,
      pct: total > 0 ? Math.round((count / total) * 100) : 0,
      mine: !!votes && votes[myCallsign] === candidate.courseId,
      voters: entries.filter(([, c]) => c === candidate.courseId).map(([cs]) => cs) };
  }
  // A manually-maintained mirror of race/README.md's "Shared course status" table — there is no
  // server field for terrain-check pass/fail (Course.normalize()'s whitelist has no such key), so
  // this is the only place the fact exists in a form the panel can read. Keep it in sync with the
  // README table by hand; a course id absent here just shows no terrain badge, rather than a guess.
  const KNOWN_TERRAIN_STATUS = { 'gorge-run': 'fail', 'crater-rim': 'fail', 'hood-circuit': 'pass' };
  // Presence `where.activity` for this pilot right now (race/PROTOCOL.md "Proto 5" hub `where`).
  // `inputIdleMs`/`awayAfterMs` (lobby reliability pass): a pilot sitting at the Gate with no
  // keyboard/mouse input for awayAfterMs reports 'idle' while still naming the room. Through 1.3.x
  // a Gate pilot always reported 'gate', the server only counts idle time for 'idle', so the Gate's
  // Away state could never happen. A racer or a solo run is never reported idle.
  function hubActivity(raceState, lobbyActive, inLobbyRace, inputIdleMs, awayAfterMs) {
    if (inLobbyRace) return 'racing';
    if (raceState === 'running') return 'solo';
    if (lobbyActive) return (Number.isFinite(inputIdleMs) && Number.isFinite(awayAfterMs) && inputIdleMs >= awayAfterMs) ? 'idle' : 'gate';
    return 'idle';
  }
  // Top 3 of a GET /cups row's `standings` (already points-then-callsign ordered server-side).
  function cupPodium(standings) { return (Array.isArray(standings) ? standings : []).slice(0, 3); }

  // ------------------------------------------------------------------- Shell (1.3.0, LOBBY_V2)
  // The lobby-first panel: Ramp (room browser) -> Gate (room lobby) -> Launch (countdown/grid),
  // plus Season/Courses stubs and Solo. Solo is not rewritten — Shell just shows/hides the
  // existing #fr-root panel (UI.init(), unchanged below) in place; every other screen is new.
  //
  // Two backend-shaped gaps the mockup asks for that no proto-5 endpoint carries: a pilot's
  // season rank/points (no such endpoint exists anywhere in race/PROTOCOL.md) and a room's real
  // pilot cap (never sent in a registry or lobby frame). Both are left out rather than guessed —
  // pilot cards show callsign/model/ready state/host star, not rank or "N open slots". See
  // race/ACCEPTANCE.md's 1.3.0 section for the full list.
  //
  // Only constructed when CONFIG.LOBBY_V2 (see boot() near the end of the file). Every render*()
  // rebuilds its screen's dynamic parts from live state on every relevant event — the same
  // approach UI.renderLobby()/renderResults() already use, not a diffed tree.
  // Every Shell control's handler runs through this: a sync throw or an async rejection becomes a
  // console error with the stack AND a visible toast (reportLobbyError), never a click that just
  // does nothing. `hs` is h() with every on* handler wrapped — the Shell builds its DOM with it.
  function guardHandler(fn, what) {
    return function (ev) {
      try {
        const r = fn.call(this, ev);
        if (r && typeof r.then === 'function') r.catch((e) => reportLobbyError(what, e));
        return r;
      } catch (e) { reportLobbyError(what, e); return undefined; }
    };
  }
  const hs = (tag, attrs, ...kids) => {
    if (!attrs) return h(tag, attrs, ...kids);
    const label = 'on "' + (attrs.text || attrs['aria-label'] || attrs.title || tag) + '"';
    const wrapped = {};
    for (const [k, v] of Object.entries(attrs)) wrapped[k] = (k.startsWith('on') && typeof v === 'function') ? guardHandler(v, label) : v;
    return h(tag, wrapped, ...kids);
  };
  const AWAY_THRESHOLD_MS = 60000;      // no key/mouse input this long at the Gate -> report 'idle' (Away)
  // How long the hub must already show a room member 'idle' before the Gate calls them Away. The
  // client reports 'idle' only after AWAY_THRESHOLD_MS of no input, so the server's own idle count
  // starts at 0 then; waiting a second threshold on it would make Away take two minutes.
  const AWAY_SERVER_GRACE_MS = 0;
  const AUTO_START_DEBOUNCE_MS = 3000;  // "everyone (non-away) ready" must hold this long to fire
  const Shell = {
    E: {}, screen: 'ramp',
    _rampTimer: 0, _rampPodium: null, _noticeTimer: 0, _courseIndexLoading: false,
    _launchTimer: 0, _launchSeenPos: new Set(), _launchForRaceId: -1,
    _gateTimer: 0, _gateReadySinceMs: 0, _gateAutoFiredFor: -1, _voteInfo: {},
    _lastInputAt: Date.now(),   // any key/mouse/wheel input anywhere on the page (Away)

    // ---- boot / navigation
    init() {
      const E = this.E;
      const tabBtn = (id, label) => {
        const b = hs('button', { type: 'button', class: 'fr-shell-tab', onclick: () => this.setScreen(id), text: label });
        E['tab_' + id] = b;
        return b;
      };
      E.backBtn = hs('button', { type: 'button', class: 'fr-shell-back', 'aria-label': 'Back to the ramp',
        onclick: () => this.setScreen('ramp'), text: '←' });
      E.wordmark = hs('div', { class: 'fr-shell-brand' }, hs('b', { text: 'FINSONLY' }), hs('span', { text: 'RACING' }));
      E.tabRow = hs('nav', { class: 'fr-shell-tabs' }, tabBtn('ramp', 'Ramp'), tabBtn('season', 'Season'),
        tabBtn('courses', 'Courses'), tabBtn('solo', 'Solo'));
      E.roomChip = hs('span', { class: 'fr-shell-room' });
      E.gateCount = hs('span', { class: 'fr-shell-count fr-dim' });
      E.gateInvite = hs('button', { type: 'button', class: 'fr-shell-btn', onclick: () => this.copyInvite(), text: 'Copy invite' });
      E.gateLeave = hs('button', { type: 'button', class: 'fr-shell-btn fr-shell-btn-danger', onclick: () => this.leaveRoom(), text: 'Leave' });
      E.launchAbort = hs('button', { type: 'button', class: 'fr-shell-btn fr-shell-btn-danger', onclick: () => this.abortToGate(), text: 'Abort to gate' });
      E.statusPill = hs('span', { class: 'fr-shell-status' });
      E.meChip = hs('button', { type: 'button', class: 'fr-shell-me', title: 'Change your callsign from Solo',
        onclick: () => this.setScreen('solo') });
      // Manual collapse. The shell covers the flight view at full size, and through 1.3.0 there was
      // no way to get it out of the way at all — not even once a race had started.
      E.collapseBtn = hs('button', { type: 'button', class: 'fr-shell-btn fr-shell-collapse',
        'aria-label': 'Collapse the panel', title: 'Collapse the panel', onclick: () => this.setCollapsed(true), text: '–' });
      // The reopen tab: the only thing left on screen while collapsed. Lives outside #fr-shell so
      // that hiding the shell cannot hide the one control that brings it back.
      E.reopenTab = hs('button', { type: 'button', id: 'fr-shell-reopen', class: 'fr-hidden',
        'aria-label': 'Reopen FINSONLY Racing', title: 'Reopen FINSONLY Racing',
        onclick: () => this.setCollapsed(false) },
        hs('b', { text: 'FR' }), (E.reopenNote = hs('span', { class: 'fr-shell-reopen-note' })));
      E.top = hs('div', { id: 'fr-shell-top' },
        E.backBtn, E.wordmark, E.tabRow, E.roomChip, E.gateInvite,
        hs('div', { style: 'flex:1' }),
        E.gateCount, E.statusPill, E.meChip, E.launchAbort, E.gateLeave, E.collapseBtn);

      this.buildRamp();
      this.buildGate();
      this.buildLaunch();
      E.seasonScreen = hs('div', { id: 'fr-season', class: 'fr-screen fr-screen-stub' },
        hs('h1', { text: 'Season' }), hs('p', { text: 'Season standings — points, cup wins, and course records across every race night — are coming. Your points from finished cups already count; there is just nowhere to see the running total yet.' }));
      this.buildCourses();
      this.buildSolo();
      E.reconnectBanner = hs('div', { id: 'fr-shell-reconnect', role: 'status', 'aria-live': 'polite' });
      E.protoBanner = hs('div', { id: 'fr-shell-proto', role: 'alert', class: 'fr-hidden' });
      // UI.status() writes to the classic panel's status line, which is hidden on every shell
      // screen except Solo — so before 1.3.1 a refused join had nowhere visible to land. This is
      // the shell's own status line, and it is the thing a pilot actually sees when a control
      // cannot do what it was clicked for.
      E.notice = hs('div', { id: 'fr-shell-notice', role: 'status', 'aria-live': 'polite', class: 'fr-hidden' });

      E.body = hs('div', { id: 'fr-shell-body' }, E.rampScreen, E.seasonScreen, E.coursesScreen, E.soloScreen, E.gateScreen, E.launchScreen);
      E.shell = hs('div', { id: 'fr-shell', role: 'region', 'aria-label': 'FINSONLY Racing' }, E.top, E.reconnectBanner, E.protoBanner, E.notice, E.body);
      document.body.append(E.shell, E.reopenTab);
      this._makeDraggable(E.top);
      const pos = store.get('shellPos', null);
      if (pos) Object.assign(E.shell.style, { left: pos.left, top: pos.top, transform: 'none' });
      // Session-scoped, best-effort: store wraps localStorage in try/catch, so a browser with
      // storage disabled simply boots expanded rather than throwing.
      this.setCollapsed(!!store.get('shellCollapsed', false), { silent: true });
      for (const t of ['keydown', 'keyup', 'keypress']) E.shell.addEventListener(t, (ev) => ev.stopPropagation());
      // Away detection: flying the plane counts as being here, so this listens on the whole page
      // (capture, passive), not just the panel. A pilot back from Away reports 'gate' on the next
      // 1 Hz status tick.
      const markInput = () => {
        const wasAway = Date.now() - this._lastInputAt >= AWAY_THRESHOLD_MS;
        this._lastInputAt = Date.now();
        if (wasAway) this._reportWhere();
      };
      for (const t of ['keydown', 'pointerdown', 'mousemove', 'wheel', 'touchstart']) {
        window.addEventListener(t, markInput, { capture: true, passive: true });
      }
      this._markInput = markInput;
      E.shell.addEventListener('click', () => Sfx.resume(), { capture: true, once: true });

      // ?room=<code>: UI.init() (which runs before this) already called Lobby.syncConnection()
      // off whatever room code was in localStorage at that point, which is too early to see a
      // room param read here — so a ?room= link connects explicitly via joinRoom() instead of
      // relying on that earlier sync to have picked it up.
      const roomParam = parseRoomParam(location.search);
      this.setScreen(CONFIG.API_BASE ? 'ramp' : 'solo', { silent: true });
      if (roomParam) this.enterRoom(roomParam, false);
      Hub.connect();   // self-guarding since 1.3.1: reports why when it can't, rather than being skipped silently
      this.renderStatusBar();
      this._statusTimer = setInterval(() => this.renderStatusBar(), 1000);
    },
    _makeDraggable(handle) {
      let sx, sy, ox, oy, dragging = false;
      const el = this.E.shell;
      handle.addEventListener('mousedown', (e) => {
        if (e.target.tagName === 'BUTTON') return;
        const r = el.getBoundingClientRect();
        dragging = true; sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
        e.preventDefault(); e.stopPropagation();
      });
      window.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        const left = Math.max(0, Math.min(window.innerWidth - 80, ox + e.clientX - sx));
        const top = Math.max(0, Math.min(window.innerHeight - 40, oy + e.clientY - sy));
        Object.assign(el.style, { left: left + 'px', top: top + 'px', transform: 'none' });
      });
      window.addEventListener('mouseup', () => {
        if (!dragging) return;
        dragging = false;
        store.set('shellPos', { left: el.style.left, top: el.style.top });
      });
    },
    toggle(force) {
      const E = this.E; if (!E.shell) return;
      const hide = force === undefined ? !E.shell.classList.contains('fr-hidden') : !force;
      E.shell.classList.toggle('fr-hidden', hide);
      // A hidden shell must not leave its reopen tab floating over an otherwise clear view: Alt+H
      // means "all of it away", collapse means "shrink it to the tab".
      if (E.reopenTab) E.reopenTab.classList.toggle('fr-hidden', hide || !this.collapsed);
      this._applyRootVisibility();
    },
    // ---- collapse / expand. Collapsed hides the whole panel down to a corner tab and leaves the
    // race HUD (a separate element, #fr-hud) untouched — collapsing never interrupts a run, and
    // reopening mid-race never interrupts one either: this only moves DOM in and out of view.
    collapsed: false, autoCollapsed: false, expandedThisRun: false,
    setCollapsed(on, opts) {
      const E = this.E;
      if (!E.shell) return false;
      this.collapsed = !!on;
      E.shell.classList.toggle('fr-collapsed', this.collapsed);
      const shellHidden = E.shell.classList.contains('fr-hidden');
      if (E.reopenTab) E.reopenTab.classList.toggle('fr-hidden', !this.collapsed || shellHidden);
      if (!this.collapsed) {
        this.autoCollapsed = false;
        // A manual expand during a live run means "leave it alone for the rest of this run" —
        // the same handshake UI.minimize()/Hud.autoMinimize() use for the classic panel. Without
        // it, a lobby pilot who reopened at GO would be collapsed again at gate 1.
        if ((!opts || !opts.silent) && this._runLive()) this.expandedThisRun = true;
      }
      // The user's own preference. autoCollapse() deliberately does NOT write it, the same
      // handshake UI.minimize()/Hud.autoMinimize() already use for the classic panel: a run
      // collapsing the panel must not overwrite how the pilot likes to fly.
      if (!opts || !opts.silent) store.set('shellCollapsed', this.collapsed);
      this._applyRootVisibility();
      return this.collapsed;
    },
    toggleCollapsed() { return this.setCollapsed(!this.collapsed); },
    // "A run is actually under way", which is narrower than Race's own 'armed' — that only means a
    // course is loaded and the clock has not started. Collapsing and reopening the panel while
    // setting up a course must not disable the auto-collapse that has not happened yet; only an
    // expand after the light has gone green counts as "leave it alone for this run".
    _runLive() { return Race.state === 'running' || Countdown.state === 'go'; },
    // Fired the instant a run actually begins — the lobby countdown reaching GO, or a solo run
    // crossing gate 1 — so the race HUD gets the screen. Never before: an armed countdown that is
    // still ticking leaves the Launch screen up, which is the whole point of the Launch screen.
    // Reopening by hand while racing is permanent for that run (autoCollapsed is cleared by
    // setCollapsed), so this cannot fight the pilot for the panel mid-race.
    autoCollapse(why) {
      if (!CONFIG.SHELL_AUTO_COLLAPSE || this.collapsed || this.expandedThisRun) return false;
      this.setCollapsed(true, { silent: true });
      this.autoCollapsed = true;
      if (this.E.reopenNote) this.E.reopenNote.textContent = why || '';
      return true;
    },
    _applyRootVisibility() {
      const hidden = this.E.shell && this.E.shell.classList.contains('fr-hidden');
      UI.E.root.classList.toggle('fr-hidden', !!hidden || this.screen !== 'solo');
      // The OLD floating lobby card (#fr-lobby) is not built at all under LOBBY_V2 (UI.init()).
    },
    setScreen(name, opts) {
      const E = this.E;
      this.screen = ['ramp', 'season', 'courses', 'solo', 'gate', 'launch'].includes(name) ? name : 'ramp';
      for (const id of ['ramp', 'season', 'courses', 'solo', 'gate', 'launch']) {
        const el = E[id + 'Screen'];
        if (el) el.classList.toggle('fr-hidden', id !== this.screen);
        if (E['tab_' + id]) E['tab_' + id].classList.toggle('fr-shell-tab-on', id === this.screen);
      }
      const isTabScreen = ['ramp', 'season', 'courses', 'solo'].includes(this.screen);
      E.backBtn.classList.toggle('fr-hidden', isTabScreen);
      E.wordmark.classList.toggle('fr-hidden', !isTabScreen);
      E.tabRow.classList.toggle('fr-hidden', !isTabScreen);
      E.roomChip.classList.toggle('fr-hidden', isTabScreen);
      E.gateInvite.classList.toggle('fr-hidden', this.screen !== 'gate');
      E.gateCount.classList.toggle('fr-hidden', isTabScreen);
      E.statusPill.classList.toggle('fr-hidden', !isTabScreen);
      E.launchAbort.classList.toggle('fr-hidden', this.screen !== 'launch' || !Lobby.isHost());
      E.gateLeave.classList.toggle('fr-hidden', isTabScreen);
      this._applyRootVisibility();

      clearInterval(this._rampTimer); this._rampTimer = 0;
      clearInterval(this._launchTimer); this._launchTimer = 0;
      clearInterval(this._gateTimer); this._gateTimer = 0;
      // Courses and Solo both read the static course index (COURSE_BASE), never the hub — opening
      // either tab is what triggers the one fetch, and it is a no-op once the list is in hand.
      if (this.screen === 'courses') { this.renderCourses(); this.loadCourseIndex(false); }
      else if (this.screen === 'solo') { this.renderSolo(); this.loadCourseIndex(false); }
      if (this.screen === 'ramp') { this.renderRamp(); this.loadLastCupPodium(); this._rampTimer = setInterval(() => this.renderRamp(), 1000); }
      else if (this.screen === 'gate') { this.renderGate(); this._gateTimer = setInterval(() => this._gateTick(), 1000); }
      else if (this.screen === 'launch') { this.renderLaunch(); this._launchTimer = setInterval(() => this.renderLaunch(), 500); }
      if (!opts || !opts.silent) this._reportWhere();
    },
    _reportWhere() {
      if (!Hub.connected) return;
      const inLobbyRace = CONFIG.RESULTS && Results.enabled() && Results.inLobbyRace();
      Hub.reportWhere(Relay.wantOpen ? Relay.room : null,
        hubActivity(Race.state, Lobby.active(), inLobbyRace, Date.now() - this._lastInputAt, AWAY_THRESHOLD_MS));
    },
    // Runs on a 1 Hz ticker regardless of which screen is active — this is the "degrades to solo
    // plus a reconnect banner" requirement: the banner and status pill must be visible whether the
    // pilot is browsing the Ramp or already deep in a Gate/Launch screen that rides the separate,
    // unaffected Relay socket (race/PROTOCOL.md: "a pilot who never opens the hub races exactly as
    // they did in 1.1.0").
    renderStatusBar() {
      const E = this.E;
      if (!E.shell) return;
      // Piggybacks on this always-on 1 Hz ticker (regardless of screen) to keep `where` fresh as
      // Race/Lobby state changes without needing a hook on every event source — Hub.reportWhere()
      // itself is a no-op when nothing actually changed, so this is cheap every tick.
      this._reportWhere();
      E.statusPill.textContent = !Hub.enabled() ? 'no relay configured'
        : Hub.connected ? 'ramp connected' : 'ramp reconnecting…';
      const showBanner = Hub.enabled() && Hub.wantOpen && !Hub.connected;
      E.reconnectBanner.classList.toggle('fr-hidden', !showBanner);
      if (showBanner) E.reconnectBanner.textContent = 'Ramp disconnected — reconnecting. Racing continues without it.';
      E.meChip.textContent = Powerups.callsign();
      this.renderProtoBanner();
    },
    copyInvite() {
      const url = buildInviteLink(location.href, Relay.room);
      (navigator.clipboard && navigator.clipboard.writeText ? navigator.clipboard.writeText(url) : Promise.reject())
        .catch(() => {
          try {
            const ta = hs('textarea', { style: 'position:fixed;opacity:0', text: url });
            document.body.append(ta); ta.select(); document.execCommand('copy'); ta.remove();
          } catch (_) {}
        })
        .then(() => UI.banner('INVITE COPIED', url));
    },
    toggleReady() { Lobby.setReady(!Lobby.ready); this.renderGate(); },
    // Persistent, not a toast: a relay below REQUIRED_PROTO is a standing condition of this room.
    renderProtoBanner() {
      const E = this.E;
      if (!E.protoBanner) return;
      const low = Lobby.joinedSeen && Lobby.proto < REQUIRED_PROTO;
      E.protoBanner.classList.toggle('fr-hidden', !low);
      E.protoBanner.textContent = low ? 'Server proto ' + Lobby.proto + ', client needs ' + REQUIRED_PROTO +
        ' — chat, spectating and the course vote are off in this room. The server needs a redeploy.' : '';
    },
    leaveRoom() { store.set('powerupRoom', ''); Relay.disconnect(); this.setScreen('ramp'); },
    abortToGate() { if (Lobby.isHost()) Lobby.abortCountdown(); this.setScreen('gate'); },

    // ---- Ramp
    // ---- Courses: the shared catalogue, read straight from race/courses/index.json over
    // COURSE_BASE. Deliberately independent of the relay and the hub: the index is a static file
    // in the repo, the hub never sends it, and a pilot with no CONFIG.API_BASE at all still gets
    // the full list. Through 1.3.0 this screen was a "coming soon" placeholder that read nothing.
    buildCourses() {
      const E = this.E;
      E.coursesNote = hs('span', { class: 'fr-dim' });
      E.coursesRefresh = hs('button', { type: 'button', class: 'fr-shell-btn',
        onclick: () => this.loadCourseIndex(true), text: 'Refresh' });
      E.coursesRows = hs('div', { class: 'fr-courses-rows' });
      E.coursesScreen = hs('div', { id: 'fr-courses', class: 'fr-screen' },
        hs('div', { class: 'fr-ramp-title-row' }, hs('h1', { text: 'Courses' }), E.coursesNote, E.coursesRefresh),
        E.coursesRows);
    },
    // `force` re-fetches even when a list is already in hand (the Refresh button). Otherwise this
    // is a no-op once the index has loaded, so opening the tab repeatedly costs nothing.
    async loadCourseIndex(force) {
      if (this._courseIndexLoading) return;
      if (!force && Courses.remote.length) { this.renderCourses(); return; }
      this._courseIndexLoading = true;
      this.renderCourses();
      try { await Courses.refreshRemote(); }
      finally { this._courseIndexLoading = false; }
      this.renderCourses();
      this.renderSolo();
    },
    // Every course this client can reach, shared and locally-saved, in one list. Local courses are
    // whatever the course editor saved in this browser; they need no network at all.
    courseCatalogue() {
      const local = Object.values(Courses.local() || {})
        .map((c) => ({ id: c.id, name: c.name, local: true, raw: c }));
      const remote = (Courses.remote || []).map((c) => ({ id: c.id, name: c.name, file: c.file, local: false }));
      return remote.concat(local.sort((a, b) => String(a.name).localeCompare(String(b.name))));
    },
    renderCourses() {
      const E = this.E;
      if (!E.coursesRows) return;
      const rows = this.courseCatalogue();
      E.coursesNote.textContent = this._courseIndexLoading ? 'Loading…'
        : rows.length ? rows.length + ' courses' : 'No courses found.';
      E.coursesRefresh.disabled = !!this._courseIndexLoading;
      E.coursesRows.replaceChildren(...rows.map((c) => {
        const terrain = KNOWN_TERRAIN_STATUS[c.id];
        return hs('div', { class: 'fr-course-row' },
          hs('div', { class: 'fr-course-row-main' },
            hs('span', { text: c.name || c.id }),
            hs('span', { class: 'fr-dim fr-mono', text: c.id })),
          c.local ? hs('span', { class: 'fr-pill fr-pill-grey', text: 'On this computer' }) : null,
          terrain === 'fail' ? hs('span', { class: 'fr-pill fr-pill-red', text: 'Terrain fail' }) : null,
          hs('div', { style: 'flex:1' }),
          hs('button', { type: 'button', class: 'fr-shell-btn',
            onclick: () => this.soloPick(c.id), text: 'Fly solo' }));
      }));
      if (!rows.length && !this._courseIndexLoading) {
        E.coursesRows.append(hs('p', { class: 'fr-dim', text: 'The shared course list could not be downloaded. Courses saved on this computer still work.' }));
      }
    },

    // ---- Solo: pick a course, fly to its start, run the clock. No room, no hub, no relay — the
    // only server this flow ever touches is the leaderboard POST at the end, which predates the
    // hub entirely. Through 1.3.0 the Solo tab was a one-line pointer at the classic panel.
    buildSolo() {
      const E = this.E;
      E.soloSelect = hs('select', { 'aria-label': 'Course to fly solo' });
      E.soloLoad = hs('button', { type: 'button', class: 'fr-go', onclick: () => this.soloLoad(), text: 'Load course' });
      E.soloFly = hs('button', { type: 'button', class: 'fr-shell-btn', onclick: () => this.soloFlyToStart(), text: 'Fly to start' });
      E.soloFly.disabled = true;
      E.soloReset = hs('button', { type: 'button', class: 'fr-shell-btn', onclick: () => this.soloReset(), text: 'Reset run' });
      E.soloCourse = hs('div', { class: 'fr-solo-course' });
      E.soloState = hs('div', { class: 'fr-solo-state' });
      E.soloHint = hs('div', { class: 'fr-dim' });
      E.soloScreen = hs('div', { id: 'fr-solo', class: 'fr-screen' },
        hs('div', { class: 'fr-solo-card' },
          hs('h1', { text: 'Solo time trial' }),
          hs('p', { class: 'fr-dim', text: 'Pick a course, fly to its start, and the clock runs the moment you cross gate 1 — the same clock the leaderboard uses. Nothing here needs a room or the ramp.' }),
          hs('div', { class: 'fr-row' }, E.soloSelect, E.soloLoad),
          hs('div', { class: 'fr-row' }, E.soloFly, E.soloReset),
          E.soloCourse, E.soloState, E.soloHint),
        hs('p', { class: 'fr-dim', text: 'The classic panel below has the full settings, the course editor, ghosts and the leaderboard.' }));
    },
    // Pick a course from the Courses tab and land on Solo with it selected and loaded.
    async soloPick(courseId) {
      this.setScreen('solo');
      this.renderSolo();
      this.E.soloSelect.value = courseId;
      return this.soloLoad();
    },
    async soloLoad() {
      const id = this.E.soloSelect.value;
      if (!id) { this.notify('Choose a course first.'); return false; }
      if (!G.ready()) { this.notify('GeoFS is still loading. Try again in a moment.'); return false; }
      const entry = this.courseCatalogue().find((c) => c.id === id);
      if (!entry) { this.notify('That course is no longer in the list.'); return false; }
      try {
        const raw = entry.local ? entry.raw : await Courses.fetchRemote(entry.file);
        if (!raw) throw new Error('that saved course no longer exists');
        const c = Race.load(raw);
        store.set('lastSoloCourse', id);
        this.notify('Loaded ' + c.name + ' — ' + c.gates.length + ' gates, ' + fmtDist(Race.lengthM) + '.');
      } catch (e) { this.notify('Could not load course: ' + e.message); return false; }
      this.renderSolo();
      return true;
    },
    // The 1.0.0 fly-to-start/teleport path, unchanged and not duplicated — FlyToStart.run() is the
    // one place that math and those writes live (README "Writing to the aircraft").
    soloFlyToStart() {
      const res = FlyToStart.run(clockNow());
      this.notify(res.ok ? 'On the start line — leave the sphere to begin.' : (res.detail || 'Could not fly to the start.'));
      this.renderSolo();
      return !!res.ok;
    },
    soloReset() { Race.reset(); this.notify('Run reset.'); this.renderSolo(); },
    renderSolo() {
      const E = this.E;
      if (!E.soloSelect) return;
      const rows = this.courseCatalogue();
      const keep = E.soloSelect.value || store.get('lastSoloCourse', '');
      E.soloSelect.replaceChildren(...rows.map((c) => hs('option', { value: c.id, text: c.name || c.id })));
      if (rows.some((c) => c.id === keep)) E.soloSelect.value = keep;
      const c = Race.course;
      E.soloCourse.replaceChildren(c
        ? hs('div', { class: 'fr-row' },
            hs('span', { class: 'fr-mono', text: c.name }),
            hs('span', { class: 'fr-dim', text: c.gates.length + ' gates · ' + fmtDist(Race.lengthM) + ' · ' + c.startType + ' start' }))
        : hs('span', { class: 'fr-dim', text: 'No course loaded yet.' }));
      E.soloFly.disabled = !FlyToStart.available();
      E.soloState.replaceChildren(
        hs('span', { class: 'fr-pill fr-pill-' + (Race.state === 'running' ? 'green' : Race.state === 'dq' ? 'red' : 'grey'),
          text: SOLO_STATE_LABELS[Race.state] || Race.state }));
      E.soloHint.textContent = !c ? 'Load a course to begin.'
        : FlyToStart.available() ? 'Air start: use Fly to start to be put on gate 1, already flying.'
        : 'Ground start: take off and cross gate 1 to start the clock.';
    },

    buildRamp() {
      const E = this.E;
      E.rampHead = hs('div', { class: 'fr-ramp-head' });
      E.rampRows = hs('div', { class: 'fr-ramp-rows' });
      E.rampEmpty = hs('div', { class: 'fr-ramp-empty fr-hidden' },
        hs('p', { text: "Nobody's on the ramp yet." }),
        hs('div', { class: 'fr-row' },
          hs('button', { type: 'button', class: 'fr-go', onclick: () => this.pingRamp(), text: 'Ping the ramp' }),
          hs('button', { type: 'button', onclick: () => this.setScreen('solo'), text: 'Fly Solo instead' })));
      E.rampNewRoom = hs('button', { type: 'button', class: 'fr-ramp-new', onclick: () => this.newRoom(), text: '+ New room' });
      E.rampPodiumWrap = hs('div', { class: 'fr-ramp-podium-wrap fr-hidden' });
      const board = hs('div', { class: 'fr-ramp-board' },
        hs('div', { class: 'fr-ramp-title-row' }, hs('h1', { text: 'Departure board' }), E.rampHead),
        E.rampRows, E.rampEmpty, E.rampNewRoom, E.rampPodiumWrap);

      E.quickMatchNote = hs('div', { class: 'fr-dim' });
      E.quickMatchBtn = hs('button', { type: 'button', class: 'fr-go fr-ramp-quick-btn', onclick: () => this.quickMatch(), text: 'Fly now' });
      const quick = hs('div', { class: 'fr-ramp-card fr-ramp-quick' },
        hs('div', { class: 'fr-ramp-card-title', text: 'Quick match' }), E.quickMatchNote, E.quickMatchBtn);

      E.pingBtn = hs('button', { type: 'button', class: 'fr-ramp-ping-btn', onclick: () => this.pingRamp() },
        hs('span', { text: 'Ping' }), (E.pingRemaining = hs('span', { class: 'fr-dim' })));
      const ping = hs('div', { class: 'fr-ramp-card' },
        hs('div', { class: 'fr-ramp-card-title', text: 'Nobody around?' }),
        hs('div', { class: 'fr-dim', text: 'Everyone on the ramp gets a toast in-sim — no Teams, no texting.' }),
        E.pingBtn);

      E.presenceCount = hs('span', { class: 'fr-dim' });
      E.presenceRows = hs('div', { class: 'fr-presence-rows' });
      const presence = hs('div', { class: 'fr-ramp-card fr-ramp-presence' },
        hs('div', { class: 'fr-ramp-card-title' }, hs('span', { text: 'On the ramp' }), E.presenceCount), E.presenceRows);

      E.meCard = hs('div', { class: 'fr-ramp-card fr-ramp-me' });

      E.rampJoinCode = hs('input', { placeholder: 'Room code', maxlength: '32', 'aria-label': 'Room code to join' });
      E.rampJoinBtn = hs('button', { type: 'button', onclick: () => this.joinByCode(), text: 'Join' });
      const joinByCode = hs('div', { class: 'fr-ramp-card' },
        hs('div', { class: 'fr-ramp-card-title', text: 'Have a room code?' }),
        hs('div', { class: 'fr-row' }, E.rampJoinCode, E.rampJoinBtn));

      const rail = hs('div', { class: 'fr-ramp-rail' }, quick, ping, presence, E.meCard, joinByCode);
      E.rampScreen = hs('div', { id: 'fr-ramp', class: 'fr-screen' }, board, rail);
    },
    roomRow(row) {
      const pill = roomStatusPill(row.status), action = roomAction(row.status);
      const actionBtn = hs('button', { type: 'button', class: 'fr-ramp-action fr-ramp-action-' + pill.tone,
        onclick: () => this.enterRoom(row.code, action === 'spectate') },
        { join: 'Join', spectate: 'Spectate', reopen: 'Reopen' }[action]);
      const courseLine = row.course
        ? (row.cup ? row.cup.name + ' · ' + row.cup.race_no + ' of ' + row.cup.race_count : row.course.name)
        : 'No course picked yet';
      return hs('div', { class: 'fr-ramp-row fr-ramp-row-' + pill.tone },
        hs('div', { class: 'fr-ramp-row-code' }, hs('span', { class: 'fr-mono', text: row.code }),
          hs('span', { class: 'fr-dim', text: 'Host ' + (row.host || '—') })),
        hs('div', { class: 'fr-ramp-row-course' }, hs('span', { text: courseLine }),
          hs('span', { class: 'fr-dim', text: row.callsigns.join(' ') || 'empty' })),
        hs('div', { class: 'fr-ramp-row-pilots' }, hs('span', { class: 'fr-mono', text: String(row.pilots) })),
        hs('div', { class: 'fr-ramp-row-status' },
          hs('span', { class: 'fr-pill fr-pill-' + pill.tone, text: pill.label }),
          row.line ? hs('span', { class: 'fr-dim fr-mono', text: row.line }) : null),
        actionBtn);
    },
    // Only navigates when a socket was really opened. Landing on a Gate screen for a room that
    // has no connection behind it is exactly what made the 1.3.0 bug look like "the click does
    // nothing": the screen changed, every field on it was blank, and nothing said why.
    enterRoom(code, spectate) {
      if (!Lobby.joinRoom(code, { spectate: !!spectate })) {
        this.notify(Relay.enabled()
          ? 'Could not join ' + code + ' — ' + (Relay.status || 'the relay refused the room code.')
          : 'No relay configured, so there are no rooms. Solo still works — open the Solo tab.');
        return false;
      }
      this.setScreen('gate');
      return true;
    },
    // Transient shell-level status line; SHELL_NOTICE_MS of visibility is enough to read one line
    // without it becoming furniture. Never throws: a notice is feedback, not a feature.
    notify(text) {
      const E = this.E;
      if (!E.notice || !text) return;
      E.notice.textContent = String(text);
      E.notice.classList.remove('fr-hidden');
      clearTimeout(this._noticeTimer);
      this._noticeTimer = setTimeout(() => E.notice.classList.add('fr-hidden'), SHELL_NOTICE_MS);
      UI.status(String(text));   // …and on the classic panel too, for the Solo screen
    },
    // The visible, non-blocking error/warning surface every lobby path reports through (a relay
    // `error` frame, a send that could not go out, a thrown handler). Lives on <body>, outside
    // #fr-shell, so a collapsed panel still shows it. The same text twice within 2 s is one toast.
    toast(text, tone) {
      if (!text) return null;
      const msg = String(text);
      Debug.log('toast' + (tone ? ' ' + tone : ''), msg);
      if (!this.E.toasts) {
        this.E.toasts = hs('div', { id: 'fr-toasts', role: 'status', 'aria-live': 'polite' });
        document.body.append(this.E.toasts);
      }
      const now = Date.now();
      if (this._lastToast && this._lastToast.msg === msg && now - this._lastToast.at < 2000) return this._lastToast.el;
      const el = hs('div', { class: 'fr-toast' + (tone ? ' fr-toast-' + tone : ''), text: msg });
      this.E.toasts.append(el);
      while (this.E.toasts.children.length > 4) this.E.toasts.firstChild.remove();
      setTimeout(() => el.remove(), tone === 'error' ? 10000 : 6000);
      this._lastToast = { msg, at: now, el };
      return el;
    },
    joinByCode() {
      const code = this.E.rampJoinCode.value.trim();
      if (code) this.enterRoom(code, false);
      else this.notify('Type a room code first.');
    },
    newRoom() { this.enterRoom(this._mintRoomCode(), false); },
    quickMatch() { this.enterRoom(quickMatchTarget(Hub.rooms) || this._mintRoomCode(), false); },
    _mintRoomCode() { return powerupsRoom('quick-' + Math.random().toString(36).slice(2, 8), ''); },
    pingRamp() {
      if (!Hub.pingRamp()) this.toast(Hub.connected ? 'Could not ping the ramp.' : 'Not connected to the ramp yet.', 'warn');
      this.renderRamp();
    },
    async loadLastCupPodium() {
      if (!CONFIG.API_BASE) return;
      try {
        const r = await fetch(CONFIG.API_BASE.replace(/\/$/, '') + '/cups?limit=5');
        if (!r.ok) return;
        const cups = await r.json();
        const closed = (Array.isArray(cups) ? cups : []).find((c) => c.closed_at);
        this._rampPodium = closed ? { name: closed.name, top: cupPodium(closed.standings) } : null;
      } catch (_) { this._rampPodium = null; }
      if (this.screen === 'ramp') this.renderRamp();
    },
    renderRamp() {
      const E = this.E;
      const rooms = Hub.rooms || [];
      E.rampHead.textContent = rooms.length + (rooms.length === 1 ? ' room live' : ' rooms live');
      E.rampRows.replaceChildren(...rooms.map((r) => this.roomRow(r)));
      const empty = !rooms.length && !(Hub.presence || []).length;
      E.rampEmpty.classList.toggle('fr-hidden', !empty);
      E.rampRows.classList.toggle('fr-hidden', empty);

      const target = quickMatchTarget(rooms);
      E.quickMatchNote.textContent = target
        ? 'Puts you in ' + target + ' — ' + (rooms.find((r) => r.code === target) || {}).pilots + ' pilots boarding.'
        : 'Nobody is boarding right now — this starts a fresh room.';
      E.quickMatchBtn.textContent = target ? 'Fly now' : 'Start a room';

      const remaining = Hub.pingsRemaining(Date.now());
      E.pingRemaining.textContent = remaining + ' left today';
      E.pingBtn.disabled = !Hub.connected;
      if (Hub.lastError) { this.toast('Ramp: ' + Hub.lastError, 'warn'); Hub.lastError = ''; }

      const presence = Hub.presence || [];
      E.presenceCount.textContent = presence.length ? presence.filter((p) => p.activity !== 'idle').length + ' of ' + presence.length : '';
      E.presenceRows.replaceChildren(...presence.map((p) => hs('div', { class: 'fr-presence-row' },
        hs('span', { class: 'fr-presence-dot fr-presence-' + (p.activity === 'idle' ? 'idle' : 'busy') }),
        hs('span', { class: 'fr-mono', text: p.callsign }),
        hs('span', { class: 'fr-dim', text: presenceLine(p) }),
        hs('span', { class: 'fr-dim', text: p.model || '' }))));

      E.meCard.replaceChildren(
        hs('div', { class: 'fr-row' }, hs('span', { class: 'fr-mono', text: Powerups.callsign() })),
        hs('div', { class: 'fr-dim', text: (G.model && G.model()) || 'F-16' }),
        hs('div', { class: 'fr-dim', text: 'Season stats are coming — see the Season tab.' }));

      E.rampPodiumWrap.classList.toggle('fr-hidden', !this._rampPodium);
      if (this._rampPodium) {
        E.rampPodiumWrap.replaceChildren(
          hs('div', { class: 'fr-dim', text: 'Last cup — ' + this._rampPodium.name }),
          hs('div', { class: 'fr-row' }, ...this._rampPodium.top.map((s, i) => hs('div', { class: 'fr-podium-card' },
            hs('span', { class: 'fr-mono', text: String(i + 1) }),
            hs('span', { class: 'fr-mono', text: s.callsign }),
            hs('span', { class: 'fr-dim', text: s.points + ' pts' })))));
      }
    },

    // ---- Gate
    buildGate() {
      const E = this.E;
      E.gateVoteGrid = hs('div', { class: 'fr-vote-grid' });
      E.gateVoteNote = hs('span', { class: 'fr-dim' });
      E.gateHostCourseSelect = hs('select', { 'aria-label': 'Pick a course' });
      E.gateHostCourseBtn = hs('button', { type: 'button', class: 'fr-go', onclick: () => this.hostSetCourse(), text: 'Set course' });
      E.gateHostCourseRow = hs('div', { class: 'fr-row fr-hidden' }, E.gateHostCourseSelect, E.gateHostCourseBtn);
      const voteSection = hs('div', { class: 'fr-gate-section' },
        hs('div', { class: 'fr-gate-head' }, hs('h2', { text: 'Course vote' }), E.gateVoteNote),
        E.gateVoteGrid, E.gateHostCourseRow);

      E.gatePilotsCount = hs('span', { class: 'fr-dim' });
      E.gateGrid = hs('div', { class: 'fr-pilot-grid' });
      const pilotsSection = hs('div', { class: 'fr-gate-section fr-gate-pilots' },
        hs('div', { class: 'fr-gate-head' }, hs('h2', { text: 'Pilots' }), E.gatePilotsCount), E.gateGrid);

      E.gateFormat = hs('div', { class: 'fr-row fr-gate-format-chips' });
      E.gateReadyText = hs('span', { class: 'fr-mono' });
      E.gateReadySub = hs('div', { class: 'fr-dim' });
      E.gateStartAnyway = hs('button', { type: 'button', class: 'fr-hidden',
        onclick: () => Lobby.startCountdown(CONFIG.COUNTDOWN_LEAD_S, true), text: 'Start anyway' });
      E.gateReadyBtn = hs('button', { type: 'button', class: 'fr-go fr-gate-ready-btn', onclick: () => Lobby.setReady(!Lobby.ready) });
      const readyBar = hs('div', { class: 'fr-ready-bar' },
        hs('div', { class: 'fr-ready-bar-format' }, hs('div', { class: 'fr-dim', text: 'Format' }), E.gateFormat),
        hs('div', { style: 'flex:1' }),
        hs('div', { class: 'fr-ready-bar-status' }, E.gateReadyText, E.gateReadySub),
        E.gateStartAnyway, E.gateReadyBtn);

      const left = hs('div', { class: 'fr-gate-left' }, voteSection, pilotsSection, readyBar);

      E.gateChatFeed = hs('div', { class: 'fr-chat-feed' });
      E.gateChatQuick = hs('div', { class: 'fr-chat-quick' },
        ...CHAT_CODES.map((code) => hs('button', { type: 'button', onclick: () => Lobby.chat(code), text: CHAT_LABELS[code] })));
      E.gateChatInput = hs('input', { placeholder: 'Say something', maxlength: '240', 'aria-label': 'Message the gate' });
      E.gateChatSend = hs('button', { type: 'button', 'aria-label': 'Send message', onclick: () => this.sendChat(), text: '➤' });
      E.gateChatInput.addEventListener('keydown', guardHandler((ev) => { if (ev.key === 'Enter') { ev.preventDefault(); this.sendChat(); } }, 'sending chat'));
      E.gateChatCompose = hs('div', { class: 'fr-row' }, E.gateChatInput, E.gateChatSend);
      const chat = hs('div', { class: 'fr-gate-chat' },
        hs('div', { class: 'fr-gate-chat-head' }, hs('span', { text: 'Gate chat' }), hs('span', { class: 'fr-dim', text: 'relayed, never stored' })),
        E.gateChatFeed, E.gateChatQuick, E.gateChatCompose);

      E.gateScreen = hs('div', { id: 'fr-gate', class: 'fr-screen' }, left, chat);
    },
    sendChat() {
      const v = this.E.gateChatInput.value;
      this.E.gateChatInput.value = '';
      Lobby.chatText(v);
    },
    async hostSetCourse() {
      if (!Lobby.isHost()) return;
      const v = this.E.gateHostCourseSelect.value;
      if (!v) return;
      try {
        const entry = Courses.remote.find((c) => c.id === v);
        if (!entry) { this.toast('That course is not in the shared list any more.', 'warn'); return; }
        const raw = await Courses.fetchRemote(entry.file);
        Lobby.setCourse(Course.normalize(raw));
      } catch (e) { this.toast('Could not set course: ' + e.message, 'error'); }
    },
    // Best-effort vote-tile enrichment: PB and course-record-holder for a candidate, looked up
    // only from data this client can already reach (the shared course index + the existing
    // leaderboard/localStorage PB reads) — never a new server capability. Cached per courseId;
    // `false` on the candidate means "tried, nothing to show", never re-fetched.
    async enrichVoteCandidate(courseId) {
      this._voteInfo[courseId] = null;
      try {
        const entry = Courses.remote.find((c) => c.id === courseId);
        if (!entry) { this._voteInfo[courseId] = false; return; }
        const raw = await Courses.fetchRemote(entry.file);
        const c = Course.normalize(raw);
        const hash = Course.hash(c);
        const pbEntry = TraceStore.entry(hash);
        let record = null;
        if (CONFIG.API_BASE) { try { const rows = await LB.top(hash, 1); record = rows[0] || null; } catch (_) {} }
        this._voteInfo[courseId] = { hash, gates: c.gates.length, pbMs: pbEntry ? pbEntry.ms : null, record };
      } catch (_) { this._voteInfo[courseId] = false; }
      if (this.screen === 'gate') this.renderGate();
    },
    voteTile(candidate, votes) {
      const vt = voteTileState(candidate, votes, Powerups.callsign());
      const info = this._voteInfo[candidate.courseId];
      if (info === undefined) this.enrichVoteCandidate(candidate.courseId);
      const terrain = KNOWN_TERRAIN_STATUS[candidate.courseId];
      const badges = [];
      if (terrain === 'fail') badges.push(hs('span', { class: 'fr-pill fr-pill-red', text: 'Terrain fail' }));
      if (info && info.record && info.record.callsign === Powerups.callsign()) badges.push(hs('span', { class: 'fr-pill fr-pill-cyan', text: 'You hold' }));
      if (vt.mine) badges.push(hs('span', { class: 'fr-pill fr-pill-amber', text: 'Your vote' }));
      return hs('button', { type: 'button', class: 'fr-vote-tile' + (vt.mine ? ' fr-vote-tile-mine' : ''),
        onclick: () => Lobby.vote(candidate.courseId) },
        hs('div', { class: 'fr-row' }, hs('span', { class: 'fr-mono', text: candidate.courseId }), ...badges),
        info ? hs('span', { class: 'fr-dim', text: info.gates + ' gates' }) : null,
        (info && info.pbMs != null) ? hs('span', { class: 'fr-dim' }, 'Your best ', hs('span', { class: 'fr-mono', text: fmt(info.pbMs) })) : null,
        hs('div', { style: 'flex:1' }),
        hs('div', { class: 'fr-vote-bar' }, hs('div', { class: 'fr-vote-bar-fill', style: 'width:' + vt.pct + '%' })),
        hs('span', { class: 'fr-dim', text: vt.count + (vt.count === 1 ? ' vote' : ' votes') + (vt.voters.length ? ' · ' + vt.voters.join(' ') : '') }));
    },
    pilotCard(p, presenceRow) {
      const mine = p.callsign === Powerups.callsign();
      const state = awayState(p, presenceRow, AWAY_SERVER_GRACE_MS);
      const stateLabel = state === 'ready' ? 'Ready'
        : state === 'away' ? 'Away' + (presenceRow ? ' · ' + Math.max(1, Math.round(presenceRow.idle_seconds / 60)) + ' min' : '')
        : 'Not ready';
      return hs('div', { class: 'fr-pilot-card' + (mine ? ' fr-pilot-card-mine' : '') },
        hs('div', { class: 'fr-row' },
          p.callsign === Lobby.state.host ? hs('span', { class: 'fr-crown', 'aria-label': 'Host', text: '★' }) : null,
          hs('span', { class: 'fr-mono', text: p.callsign }),
          mine ? hs('span', { class: 'fr-pill fr-pill-amber', text: 'YOU' }) : null,
          p.role === 'spectator' ? hs('span', { class: 'fr-pill fr-pill-grey', text: 'SPECTATING' }) : null),
        hs('span', { class: 'fr-dim', text: p.model || 'F-16' }),
        hs('span', { class: 'fr-pill fr-pill-' + (state === 'ready' ? 'green' : state === 'away' ? 'amber' : 'grey'), text: stateLabel }));
    },
    renderGateChat() {
      const E = this.E;
      const chat = Lobby.state.chat.slice().reverse();
      E.gateChatFeed.replaceChildren(...chat.map((m) => hs('div', { class: 'fr-chat-line' },
        hs('span', { class: 'fr-mono', text: m.callsign }),
        hs('span', { text: m.kind === 'text' ? m.text : (CHAT_LABELS[m.code] || m.code) }))));
      E.gateChatFeed.scrollTop = E.gateChatFeed.scrollHeight;
      E.gateChatCompose.classList.toggle('fr-hidden', !CONFIG.CHAT_ENABLED);
    },
    renderGate() {
      const E = this.E;
      const st = Lobby.state;
      E.roomChip.textContent = Relay.room || '';
      E.gateCount.textContent = st.players.length + (st.players.length === 1 ? ' pilot' : ' pilots');

      const vote = st.vote, hasVote = !!(vote && vote.candidates.length);
      E.gateVoteGrid.classList.toggle('fr-hidden', !hasVote);
      // The host's own pick is always offered, vote or no vote: a host `course` always beats the
      // vote server-side, and through 1.3.x hiding it whenever a vote existed was half of the
      // deadlock that kept every voting room from starting (see lobbyCanStart()).
      E.gateHostCourseRow.classList.toggle('fr-hidden', !Lobby.isHost());
      if (Lobby.isHost()) {
        if (!Courses.remote.length && Date.now() - (this._courseFetchAt || 0) > 30000) {
          this._courseFetchAt = Date.now();
          Courses.refreshRemote().then(() => { if (this.screen === 'gate') this.renderGate(); }).catch(() => {});
        }
        if (Courses.remote.length && !E.gateHostCourseSelect.children.length) {
          E.gateHostCourseSelect.replaceChildren(...Courses.remote.map((c) => hs('option', { value: c.id, text: c.name })));
        }
      }
      if (hasVote) {
        E.gateVoteNote.textContent = st.course ? 'The host picked ' + (st.course.name || st.course.course_id) + '; the vote is advisory.'
          : 'Three drawn at random. Ties break toward whoever has raced it least.';
        E.gateVoteGrid.replaceChildren(...vote.candidates.map((c) => this.voteTile(c, vote.votes)));
      } else if (Lobby.isHost()) {
        E.gateVoteNote.textContent = Lobby.proto < 5 ? "This relay doesn't support the course vote. Pick one directly." : 'No candidates yet. Pick one directly.';
      } else {
        E.gateVoteNote.textContent = 'Waiting for the host to pick a course.';
      }

      const presenceByCallsign = {};
      for (const p of Hub.presence || []) presenceByCallsign[p.callsign] = p;
      E.gatePilotsCount.textContent = st.players.filter((p) => p.ready).length + ' of ' + st.players.length + ' ready';
      E.gateGrid.replaceChildren(...st.players.map((p) => this.pilotCard(p, presenceByCallsign[p.callsign])));

      const chips = [];
      if (st.cup) chips.push(st.cup.name + ' · ' + st.cup.raceCount + ' races');
      chips.push('Items ' + (st.rules.powerups ? 'on' : 'off'));
      chips.push('Teleport ' + (st.rules.teleport ? 'on' : 'off'));
      E.gateFormat.replaceChildren(...chips.map((t) => hs('span', { class: 'fr-chip', text: t })));

      const mine = Lobby.me();
      E.gateReadyBtn.textContent = (mine && mine.ready) ? 'READY ✓' : 'READY UP';
      E.gateReadyBtn.classList.toggle('fr-gate-ready-on', !!(mine && mine.ready));
      E.gateReadyText.textContent = st.players.filter((p) => p.ready).length + ' of ' + st.players.length + ' ready';
      const awayCount = st.players.filter((p) => awayState(p, presenceByCallsign[p.callsign], AWAY_SERVER_GRACE_MS) === 'away').length;
      const canStart = lobbyCanStart(st);
      E.gateReadySub.textContent = !canStart.ok ? canStart.why
        : awayCount
          ? (awayCount === 1 ? '1 pilot is away, ' : awayCount + ' pilots are away, ') + 'so it launches without them once everyone else is ready.'
          : (Lobby.allReady() ? 'Launching...' : '');
      E.gateStartAnyway.classList.toggle('fr-hidden', !Lobby.isHost());
      E.gateStartAnyway.disabled = !canStart.ok;
      E.gateStartAnyway.title = canStart.ok ? (canStart.via === 'vote' ? 'Starts on the vote winner' : 'Starts now; anyone not ready spectates') : canStart.why;

      this.renderGateChat();
    },
    // Client-only auto-start (see the plan/CLAUDE.md note near AUTO_START_DEBOUNCE_MS above):
    // once every non-away racer has been ready for AUTO_START_DEBOUNCE_MS straight, the host's
    // own client fires the existing force-start frame — an away pilot falls out exactly the way a
    // not-ready one already does under a manual "Start anyway" force-start.
    _gateTick() {
      if (!Lobby.isHost()) { this.renderGate(); return; }
      const st = Lobby.state;
      if (!st.players.length || !lobbyCanStart(st).ok || Countdown.state === 'armed') { this._gateReadySinceMs = 0; this.renderGate(); return; }
      const presenceByCallsign = {};
      for (const p of Hub.presence || []) presenceByCallsign[p.callsign] = p;
      const awayMap = {};
      for (const p of st.players) awayMap[p.callsign] = awayState(p, presenceByCallsign[p.callsign], AWAY_SERVER_GRACE_MS);
      const engaged = st.players.filter((p) => awayMap[p.callsign] !== 'away');
      const allReady = engaged.length > 0 && engaged.every((p) => p.ready);
      if (allReady) { if (!this._gateReadySinceMs) this._gateReadySinceMs = Date.now(); }
      else { this._gateReadySinceMs = 0; }
      const heldMs = this._gateReadySinceMs ? Date.now() - this._gateReadySinceMs : 0;
      if (this._gateAutoFiredFor !== st.raceId && autoStartDecision(st.players, awayMap, heldMs, AUTO_START_DEBOUNCE_MS)) {
        this._gateAutoFiredFor = st.raceId;
        Lobby.startCountdown(CONFIG.COUNTDOWN_LEAD_S, true);
      }
      this.renderGate();
    },

    // ---- Launch
    buildLaunch() {
      const E = this.E;
      E.launchGridList = hs('div', { class: 'fr-grid-list' });
      const grid = hs('div', { class: 'fr-launch-grid' },
        hs('div', { class: 'fr-launch-head' }, hs('h2', { text: 'Grid' }), hs('span', { class: 'fr-dim', text: 'staggered behind gate 1' })),
        E.launchGridList,
        hs('p', { class: 'fr-dim', text: 'Everyone was placed on the reverse gate 1 → gate 2 bearing. Hold what you were given and you reach the line together.' }));

      E.launchCdBig = hs('div', { class: 'fr-launch-cd-big', 'aria-live': 'assertive' });
      E.launchHoldHdg = hs('div', { class: 'fr-launch-hold-card' });
      E.launchHoldSpd = hs('div', { class: 'fr-launch-hold-card' });
      E.launchHoldAlt = hs('div', { class: 'fr-launch-hold-card' });
      E.launchReposition = hs('div', { class: 'fr-launch-reposition fr-hidden' });
      const center = hs('div', { class: 'fr-launch-center' },
        hs('span', { class: 'fr-launch-cd-label', text: 'Green light in' }),
        E.launchCdBig,
        hs('div', { class: 'fr-row' }, E.launchHoldHdg, E.launchHoldSpd, E.launchHoldAlt),
        E.launchReposition);

      E.launchVoteNote = hs('div', { class: 'fr-dim' });
      E.launchCourseId = hs('div', { class: 'fr-mono fr-launch-course-id' });
      E.launchRoute = hs('div', { class: 'fr-launch-route' });
      E.launchFacts = hs('div', { class: 'fr-row' });
      E.launchGhosts = hs('div', { class: 'fr-launch-ghosts' });
      const course = hs('div', { class: 'fr-launch-course' },
        E.launchVoteNote, E.launchCourseId, E.launchRoute, E.launchFacts,
        hs('div', { class: 'fr-dim', text: 'Ghosts on the line' }), E.launchGhosts);

      E.launchBody = hs('div', { class: 'fr-launch-body' }, grid, center, course);
      const strip = hs('div', { class: 'fr-launch-strip' },
        hs('span', { class: 'fr-dim', text: 'At the green light' }),
        hs('span', { text: 'Your board time starts when you cross gate 1, so it stays comparable with solo runs.' }),
        hs('span', { class: 'fr-launch-sep' }),
        hs('span', null, 'Cross gate 1 before the light and you take ', hs('b', { class: 'fr-mono', text: '+5.00s' }), ' — not a DQ.'));
      E.launchScreen = hs('div', { id: 'fr-launch', class: 'fr-screen' }, E.launchBody, strip);
    },
    launchRouteSvg(course) {
      // minimapFit() takes {lat, lon} points. Through 1.3.x this passed [lat, lon] pairs, got a
      // null fit back, and threw on the first point: every Launch render died before its refresh
      // timer started (hidden by Relay's old catch-all), so the screen never showed a countdown.
      const fit = minimapFit(course.gates, 220, 110, 14);
      const path = course.gates.map((g, i) => { const p = minimapPoint(fit, g.lat, g.lon); return (i ? 'L' : 'M') + p.x.toFixed(1) + ' ' + p.y.toFixed(1); }).join(' ');
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 220 110');
      svg.setAttribute('width', '100%');
      const route = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      route.setAttribute('d', path); route.setAttribute('fill', 'none');
      route.setAttribute('stroke', '#2E6E82'); route.setAttribute('stroke-width', '2'); route.setAttribute('stroke-dasharray', '4 3');
      svg.append(route);
      course.gates.forEach((g, i) => {
        const p = minimapPoint(fit, g.lat, g.lon);
        const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        c.setAttribute('cx', p.x); c.setAttribute('cy', p.y);
        c.setAttribute('r', i === 0 || i === course.gates.length - 1 ? '5' : '3');
        c.setAttribute('fill', i === 0 ? '#F0A429' : i === course.gates.length - 1 ? 'none' : '#4CC9E8');
        if (i === course.gates.length - 1) { c.setAttribute('stroke', '#3FCF6E'); c.setAttribute('stroke-width', '2'); }
        svg.append(c);
      });
      return svg;
    },
    renderLaunch() {
      const E = this.E;
      const st = Lobby.state, start = st.start;
      E.roomChip.textContent = Relay.room || '';
      if (!start) { this.setScreen('gate'); return; }
      E.gateCount.textContent = start.racers.length + ' pilots positioned';
      E.launchAbort.classList.toggle('fr-hidden', !Lobby.isHost());

      if (this._launchForRaceId !== start.raceId) { this._launchForRaceId = start.raceId; this._launchSeenPos = new Set(); }
      for (const cs of Object.keys(Relay.positions || {})) this._launchSeenPos.add(cs);
      for (const cs of Object.keys(Relay.world || {})) this._launchSeenPos.add(cs);

      E.launchCdBig.textContent = Countdown.state === 'go' ? 'GO' : String(Math.max(0, Math.ceil((Countdown.target - Date.now()) / 1000)));
      const hdg = G.ready() ? G.heading() : null, kias = G.ready() ? G.kias() : null, alt = G.ready() ? G.lla().alt : null;
      E.launchHoldHdg.replaceChildren(hs('span', { class: 'fr-mono', text: hdg != null ? Math.round(hdg) + '°' : '—' }), hs('span', { class: 'fr-dim', text: 'Hold heading' }));
      E.launchHoldSpd.replaceChildren(hs('span', { class: 'fr-mono', text: kias != null ? Math.round(kias) + ' kt' : '—' }), hs('span', { class: 'fr-dim', text: 'Hold speed' }));
      E.launchHoldAlt.replaceChildren(hs('span', { class: 'fr-mono', text: alt != null ? Math.round(alt * 3.28084).toLocaleString() + ' ft' : '—' }), hs('span', { class: 'fr-dim', text: 'Hold altitude' }));

      const c = Race.course;
      const gridEligible = c && c.gates.length >= 2 && st.rules.teleport && c.startType === 'air';
      E.launchGridList.replaceChildren();
      E.launchReposition.classList.add('fr-hidden');
      if (gridEligible) {
        const rows = launchGridRows(start.racers, c.gates[0], c.gates[1], Lobby.gridLeadS, Lobby.gridSpeedMs, this._launchSeenPos);
        E.launchGridList.replaceChildren(...rows.map((r) => hs('div', { class: 'fr-grid-row' + (r.callsign === Powerups.callsign() ? ' fr-grid-row-mine' : '') },
          hs('span', { class: 'fr-mono fr-grid-index', text: String(r.index + 1) }),
          hs('div', { class: 'fr-row', style: 'flex-direction:column;align-items:flex-start;gap:2px;flex:1' },
            hs('span', { class: 'fr-mono', text: r.callsign }),
            hs('span', { class: 'fr-dim', text: fmtDist(r.distanceM) + ' back' })),
          hs('span', { class: 'fr-pill fr-pill-' + (r.status === 'set' ? 'green' : 'amber'), text: r.status === 'set' ? 'Set' : 'Moving' }))));
        const mine = rows.find((r) => r.callsign === Powerups.callsign());
        if (mine) {
          E.launchReposition.classList.remove('fr-hidden');
          E.launchReposition.textContent = 'You were repositioned ' + fmtDist(mine.distanceM) + ' behind gate 1 — controls are yours';
        }
      } else {
        E.launchGridList.replaceChildren(...start.racers.map((cs) => hs('div', { class: 'fr-grid-row' },
          hs('span', { class: 'fr-mono', text: cs }), hs('span', { class: 'fr-dim', text: 'converging on gate 1' }))));
      }

      if (start.vote) {
        const entries = Object.entries(start.vote.votes || {});
        const winCount = entries.filter(([, cid]) => cid === start.vote.courseId).length;
        E.launchVoteNote.textContent = 'Course · won the vote ' + winCount + '–' + (entries.length - winCount);
      } else {
        E.launchVoteNote.textContent = 'Course';
      }
      E.launchCourseId.textContent = (st.course && st.course.name) || (c && c.name) || '';
      E.launchFacts.replaceChildren();
      E.launchRoute.replaceChildren();
      if (c && c.gates && c.gates.length) {
        E.launchRoute.append(this.launchRouteSvg(c));
        const terrain = st.course && KNOWN_TERRAIN_STATUS[st.course.course_id];
        E.launchFacts.replaceChildren(
          hs('div', { class: 'fr-launch-fact' }, hs('span', { class: 'fr-mono', text: String(c.gates.length) }), hs('span', { class: 'fr-dim', text: 'gates' })),
          terrain ? hs('div', { class: 'fr-launch-fact' }, hs('span', { class: 'fr-mono', text: terrain === 'pass' ? 'Pass' : 'Fail' }), hs('span', { class: 'fr-dim', text: 'terrain check' })) : null);
      }
      const ghosts = [];
      if (CONFIG.GHOST && Ghost.pick && Ghost.pick !== GHOST_OFF && Ghost.meta) {
        ghosts.push({ callsign: Ghost.meta.callsign, timeMs: Ghost.meta.timeMs, primary: true });
      }
      if (CONFIG.RIVAL_GHOSTS) for (const e of RivalGhosts.extra) if (e && e.meta) ghosts.push({ callsign: e.meta.callsign, timeMs: e.meta.timeMs, primary: false });
      E.launchGhosts.replaceChildren(...ghosts.map((g) => hs('div', { class: 'fr-launch-ghost-row' },
        hs('span', { class: 'fr-mono', text: g.callsign }),
        hs('span', { class: 'fr-dim', text: g.primary ? 'primary' : '' }),
        hs('span', { class: 'fr-mono fr-dim', text: fmt(g.timeMs) }))));
    },
  };

  const UI = {
    E: {}, lastHud: 0, bannerTimer: 0,

    init() {
      document.head.append(h('style', { id: 'fr-style', text: CSS }));
      const E = this.E;
      const btn = (text, onclick, cls, title) => h('button', { type: 'button', class: cls, title, onclick, text });

      E.select = h('select', { 'aria-label': 'Course' });
      E.timer = h('div', { id: 'fr-timer', text: fmt(NaN), 'aria-live': 'off' });
      E.gate = h('span');
      E.arrow = h('span', { id: 'fr-arrow', text: '▲', 'aria-hidden': 'true' });
      E.dist = h('span');
      E.vert = h('span');
      E.speed = h('span', { class: 'fr-dim' });
      E.status = h('div', { id: 'fr-status', 'aria-live': 'polite', text: 'Waiting for GeoFS to finish loading…' });
      E.mapStatus = h('div', { class: 'fr-dim' });
      E.startHint = h('div', { id: 'fr-start-hint' });
      E.splits = h('table', { id: 'fr-splits' });
      E.best = h('div', { class: 'fr-dim' });

      // leaderboard
      E.callsign = h('input', { placeholder: 'Your name on the board', maxlength: '32', value: store.get('callsign', '') });
      E.callsign.addEventListener('change', () => store.set('callsign', E.callsign.value.trim()));
      E.autosub = h('input', { type: 'checkbox', id: 'fr-autosub' });
      E.autosub.checked = store.get('autosubmit', true);
      E.autosub.addEventListener('change', () => store.set('autosubmit', E.autosub.checked));
      E.lb = h('ol', { id: 'fr-lb' });
      E.lbMsg = h('div', { class: 'fr-dim' });

      // your plane (model swap)
      E.modelSelect = h('select', { 'aria-label': 'Joke plane model' });
      E.modelEnabled = h('input', { type: 'checkbox', id: 'fr-model-enabled' });
      E.modelHide = h('input', { type: 'checkbox', id: 'fr-model-hide' });
      E.modelStatus = h('div', { class: 'fr-dim' });
      const onModelChange = () => this.applyModelSelection();
      E.modelSelect.addEventListener('change', onModelChange);
      E.modelEnabled.addEventListener('change', onModelChange);
      E.modelHide.addEventListener('change', () => {
        store.set('modelHideCockpit', E.modelHide.checked);
        ModelSwap.setHideInCockpit(E.modelHide.checked);
      });

      // powerups (Phase 1: loadout, no relay)
      if (CONFIG.POWERUPS) {
        const itemOption = (v, text) => h('option', { value: v, text });
        E.puSlot1 = h('select', { 'aria-label': 'Loadout slot 1' }, itemOption('boost', 'Speed Boost'), itemOption('shield', 'Shield'));
        E.puSlot2 = h('select', { 'aria-label': 'Loadout slot 2' }, itemOption('boost', 'Speed Boost'), itemOption('shield', 'Shield'));
        E.puSlot1.value = Powerups.state.loadout[0];
        E.puSlot2.value = Powerups.state.loadout[1];
        const onLoadoutChange = () => { Powerups.setLoadout([E.puSlot1.value, E.puSlot2.value]); this.renderPowerups(clockNow()); };
        E.puSlot1.addEventListener('change', onLoadoutChange);
        E.puSlot2.addEventListener('change', onLoadoutChange);
        E.puStatus = h('div', { class: 'fr-dim' });
        E.puWriteStatus = h('div', { class: 'fr-dim' });
        // Only useful until CONFIG.VELOCITY_FRAME is filled in, so it hides itself afterwards.
        E.puFrameBtn = h('button', { type: 'button', text: 'Log velocity frame',
          title: 'Hold stable level cruise, then click: dumps the live velocity vector to the DevTools console so CONFIG.VELOCITY_FRAME can be recorded',
          onclick: () => this.logVelocityFrame() });
        E.puRelayStatus = h('div', { class: 'fr-dim' });
        E.puFeed = h('ul', { id: 'fr-feed' });
        E.puRoom = h('input', { placeholder: 'auto (course)', maxlength: '32', style: 'max-width:110px',
          'aria-label': 'Relay room code', value: store.get('powerupRoom', '') });
        E.puRoom.addEventListener('change', () => {
          store.set('powerupRoom', E.puRoom.value.trim());
          this.renderPowerups(clockNow());
          if (CONFIG.LOBBY) Lobby.syncConnection();
        });
      }

      // ghost (0.9.0). Spectators get the picker too — watching someone's line is the point.
      if (CONFIG.GHOST) {
        E.ghostSelect = h('select', { 'aria-label': 'Ghost to race against' });
        E.ghostSelect.addEventListener('change', () => Ghost.setPick(E.ghostSelect.value));
        E.ghostStatus = h('div', { class: 'fr-dim' });
      }

      // race a friend's ghost (0.12.0): up to RIVAL_GHOSTS_MAX - 1 EXTRA ghosts alongside the
      // "Race against" pick above, which stays the one primary ghost untouched.
      if (CONFIG.RIVAL_GHOSTS && RivalGhosts.slotCount() > 0) {
        E.rivalSelects = [];
        for (let i = 0; i < RivalGhosts.slotCount(); i++) {
          const sel = h('select', { 'aria-label': 'Rival ghost ' + (i + 2) });
          sel.addEventListener('change', () => RivalGhosts.setExtraPick(i, sel.value));
          E.rivalSelects.push(sel);
        }
      }

      // fly-to-start (air-start courses only; the button enables/disables in renderStartHint)
      E.flyBtn = h('button', { type: 'button', text: 'Fly to start', disabled: true,
        title: 'Put me on gate 1, pointed at gate 2, already flying',
        onclick: () => this.flyToStart() });

      // synced countdown (local wall-clock target; see Countdown above)
      E.cdBig = h('div', { id: 'fr-cd-big', 'aria-live': 'assertive' });
      E.cdLead = h('input', { type: 'number', min: '3', max: '60', step: '1', value: String(CONFIG.COUNTDOWN_LEAD_S), style: 'max-width:64px', 'aria-label': 'Countdown lead time in seconds' });
      E.cdTargetDisplay = h('div', { class: 'fr-dim' });
      E.cdJoinInput = h('input', { placeholder: 'HH:MM:SS', style: 'max-width:96px', 'aria-label': 'Target time announced by the host' });
      E.cdStatus = h('div', { class: 'fr-dim' });

      // editor
      E.edName = h('input', { placeholder: 'Course name', maxlength: '48' });
      E.edRadius = h('input', { type: 'number', min: '20', max: '5000', step: '10', value: String(CONFIG.DEFAULT_RADIUS_M), style: 'max-width:80px', 'aria-label': 'Gate radius in meters' });
      E.edAircraft = h('input', { type: 'checkbox', id: 'fr-lockac' });
      E.edInfo = h('div', { class: 'fr-dim', text: 'No draft gates yet.' });
      E.edJson = h('textarea', { placeholder: 'Paste course JSON here to import', spellcheck: 'false' });

      // sound
      E.sfxMute = h('input', { type: 'checkbox', id: 'fr-sfx-mute' });
      E.sfxMute.checked = Sfx.muted;
      E.sfxMute.addEventListener('change', () => Sfx.setMuted(E.sfxMute.checked));

      const head = h('div', { id: 'fr-head' },
        h('b', { text: 'FINSONLY Racing' }), h('small', { text: 'v' + CONFIG.VERSION }),
        btn('–', () => this.minimize(), null, 'Minimize (Alt+H hides)'));

      const body = h('div', { id: 'fr-body' },
        h('div', { class: 'fr-row' }, E.select, btn('Load', () => this.loadSelected(), 'fr-go'),
          btn('↻', () => this.refreshCourses(), null, 'Refresh shared courses')),
        E.mapStatus,
        E.startHint,
        CONFIG.LOBBY ? (E.lobbyProtoNote = h('div', { class: 'fr-dim' })) : null,
        h('div', { class: 'fr-row' }, E.flyBtn),
        E.timer,
        h('div', { id: 'fr-nav' }, E.gate, h('span', null, E.arrow, ' ', E.dist), E.vert, E.speed),
        E.status,
        h('div', { class: 'fr-row' }, btn('Reset run', () => Race.reset(), null, 'Alt+R'), h('kbd', { text: 'Alt+R' }),
          h('span', { style: 'flex:1' }), E.best),
        E.splits,
        (E.cdSection = h('details', { id: 'fr-countdown' }, h('summary', { text: CONFIG.LOBBY ? 'Manual sync (no relay)' : 'Synced countdown' }),
          E.cdBig,
          h('div', { class: 'fr-row' }, h('label', { text: 'Lead time (s)' }), E.cdLead,
            btn('Arm', () => this.armCountdown(), 'fr-go'), btn('Abort', () => Countdown.abort())),
          E.cdTargetDisplay,
          h('div', { class: 'fr-row' }, h('label', { text: 'Or join a target time' }), E.cdJoinInput,
            btn('Join', () => this.joinCountdown())),
          E.cdStatus)),
        h('details', null, h('summary', { text: 'Leaderboard' }),
          h('div', { class: 'fr-row' }, E.callsign),
          h('div', { class: 'fr-row' }, E.autosub, h('label', { for: 'fr-autosub', text: 'Submit finished runs automatically' })),
          h('div', { class: 'fr-row' }, btn('Refresh board', () => this.refreshBoard())),
          E.lbMsg, E.lb),
        (CONFIG.GHOST || CONFIG.RACING_LINE) ? h('details', { id: 'fr-ghost' },
          h('summary', { text: CONFIG.GHOST ? 'Ghost' : 'Racing line' }),
          CONFIG.GHOST ? h('div', { class: 'fr-row' }, h('label', { text: 'Race against' }), E.ghostSelect) : null,
          CONFIG.GHOST ? E.ghostStatus : null,
          CONFIG.RACING_LINE ? h('div', { class: 'fr-row' }, h('kbd', { text: 'Alt+L racing line' })) : null,
          CONFIG.RACING_LINE ? (E.lineStatus = h('div', { class: 'fr-dim' })) : null) : null,
        (CONFIG.RIVAL_GHOSTS && E.rivalSelects) ? h('details', { id: 'fr-rivals' },
          h('summary', { text: 'Race a friend' }),
          ...E.rivalSelects.map((sel, i) => h('div', { class: 'fr-row' }, h('label', { text: 'Ghost ' + (i + 2) }), sel))) : null,
        h('details', { id: 'fr-model' }, h('summary', { text: 'Your plane' }),
          h('div', { class: 'fr-row' }, E.modelSelect),
          h('div', { class: 'fr-row' }, E.modelEnabled, h('label', { for: 'fr-model-enabled', text: 'Show joke model (physics stay F-16)' })),
          h('div', { class: 'fr-row' }, E.modelHide, h('label', { for: 'fr-model-hide', text: 'Hide in cockpit view' })),
          E.modelStatus),
        h('details', { id: 'fr-sound' }, h('summary', { text: 'Sound' }),
          h('div', { class: 'fr-row' }, E.sfxMute, h('label', { for: 'fr-sfx-mute', text: 'Mute sound effects' }))),
        CONFIG.POWERUPS ? h('details', { id: 'fr-powerups' }, h('summary', { text: 'Powerups' }),
          h('div', { class: 'fr-row' }, h('label', { text: 'Slot 1' }), E.puSlot1),
          h('div', { class: 'fr-row' }, h('label', { text: 'Slot 2' }), E.puSlot2),
          h('div', { class: 'fr-row' }, h('kbd', { text: 'Alt+1 / Alt+2 loadout · Alt+3 box item' })),
          E.puStatus,
          E.puWriteStatus,
          h('div', { class: 'fr-row' }, E.puFrameBtn),
          // The typed room box is the rollback path's way into a room; under LOBBY_V2 the shell owns
          // joins (and syncConnection() is off), so the box would be a control that does nothing.
          CONFIG.LOBBY_V2 ? null : h('div', { class: 'fr-row' }, h('label', { text: 'Room' }), E.puRoom),
          E.puRelayStatus,
          E.puFeed) : null,
        (E.editor = h('details', { id: 'fr-editor' }, h('summary', { text: 'Course editor' }),
          h('div', { class: 'fr-row' }, E.edName),
          h('div', { class: 'fr-row' }, h('label', { text: 'Gate radius (m)' }), E.edRadius),
          h('div', { class: 'fr-row' }, E.edAircraft, h('label', { for: 'fr-lockac', text: 'Require my current aircraft' })),
          h('div', { class: 'fr-row' }, btn('Drop gate here', () => Editor.drop(), 'fr-go', 'Alt+G'),
            btn('Undo', () => Editor.undo(), null, 'Alt+U'), btn('Clear', () => Editor.clear())),
          h('div', { class: 'fr-row' }, btn('Drop item box', () => Editor.dropBox(false), null, 'Alt+B'),
            btn('Drop box row', () => Editor.dropBox(true), null, 'Alt+Shift+B — three, 120 m apart across your heading'),
            btn('Undo box', () => Editor.undoBox())),
          h('div', { class: 'fr-row' }, h('kbd', { text: 'Alt+G drop · Alt+U undo' })),
          h('div', { class: 'fr-row' }, btn('Build test course ahead of me', () => Editor.testAhead())),
          E.edInfo,
          h('div', { class: 'fr-row' }, btn('Save and load', () => Editor.saveAndLoad(), 'fr-go'),
            btn('Copy JSON', () => Editor.copy()), btn('Delete saved', () => Editor.deleteSelected())),
          E.edJson,
          h('div', { class: 'fr-row' }, btn('Import JSON', () => Editor.importJson())))));

      E.root = h('div', { id: 'fr-root', role: 'region', 'aria-label': 'FINSONLY Racing' }, head, body);
      E.banner = h('div', { id: 'fr-banner', 'aria-live': 'assertive' });
      document.body.append(E.root, E.banner);
      if (CONFIG.RIVAL_GHOSTS) {
        E.newsText = h('span');
        E.newsRaceBtn = h('button', { type: 'button', text: 'Race his ghost' });
        E.newsDismiss = h('button', { type: 'button', text: '✕', 'aria-label': 'Dismiss' });
        E.newsBanner = h('div', { id: 'fr-news', role: 'status', 'aria-live': 'polite' },
          E.newsText, E.newsRaceBtn, E.newsDismiss);
        E.newsDismiss.addEventListener('click', () => this.dismissNews());
        document.body.append(E.newsBanner);
      }
      if (CONFIG.POWERUPS) {
        E.fx = h('div', { id: 'fr-fx', 'aria-hidden': 'true' },
          h('div', { class: 'fr-fx-layer fr-fx-goop-l' }),
          h('div', { class: 'fr-fx-layer fr-fx-missile-l' }),
          h('div', { class: 'fr-fx-layer fr-fx-banana-l' }),
          h('div', { class: 'fr-fx-layer fr-fx-boost-l' }));
        document.body.append(E.fx);
      }
      // The old floating lobby card (and its confirm() force-start) is the LOBBY_V2 = false
      // rollback's UI only. Under the shipped shell it is never built — through 1.3.x it was built
      // anyway and hidden by a body-scoped CSS rule that Shell.init() had to reach, so a throw
      // anywhere before that line left the superseded card on screen.
      if (CONFIG.LOBBY && !CONFIG.LOBBY_V2) this.buildLobbyOverlay();
      if (CONFIG.LOBBY && CONFIG.RESULTS) this.buildResultsOverlay();

      // Keep typing in our inputs from flying the plane.
      for (const t of ['keydown', 'keyup', 'keypress']) E.root.addEventListener(t, (ev) => ev.stopPropagation());
      this.makeDraggable(head);
      const pos = store.get('panelPos', null);
      if (pos) Object.assign(E.root.style, { left: pos.left, top: pos.top, right: 'auto' });
      if (store.get('minimized', false)) E.root.classList.add('fr-min');
      // The bookmarklet click itself is one user gesture; any click in the panel is another.
      E.root.addEventListener('click', () => Sfx.resume(), { capture: true, once: true });

      Hud.init();

      this.renderBoardState();
      this.renderCourses();
      if (CONFIG.GHOST) this.renderGhostOptions([]);
      if (CONFIG.POWERUPS) this.renderPowerups(clockNow());
      // A manual room code (persisted from a previous session) means there's already somewhere
      // to gather even with no course loaded yet — GeoFS doesn't need to be ready for a socket.
      if (CONFIG.LOBBY) Lobby.syncConnection();
    },

    makeDraggable(handle) {
      let sx, sy, ox, oy, dragging = false;
      handle.addEventListener('mousedown', (e) => {
        if (e.target.tagName === 'BUTTON') return;
        const r = this.E.root.getBoundingClientRect();
        dragging = true; sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
        e.preventDefault(); e.stopPropagation();
      });
      window.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        const left = Math.max(0, Math.min(window.innerWidth - 60, ox + e.clientX - sx));
        const top = Math.max(0, Math.min(window.innerHeight - 30, oy + e.clientY - sy));
        Object.assign(this.E.root.style, { left: left + 'px', top: top + 'px', right: 'auto' });
      });
      window.addEventListener('mouseup', () => {
        if (!dragging) return;
        dragging = false;
        store.set('panelPos', { left: this.E.root.style.left, top: this.E.root.style.top });
      });
    },

    toggle(force) {
      if (CONFIG.LOBBY_V2 && Shell.E.shell) { Shell.toggle(force); return; }
      const hide = force === undefined ? !this.E.root.classList.contains('fr-hidden') : !force;
      this.E.root.classList.toggle('fr-hidden', hide);
    },
    minimize() {
      const m = this.E.root.classList.toggle('fr-min');
      store.set('minimized', m);
      // A manual expand during an armed/running auto-minimized run means "leave it alone for
      // this run" — see Hud.onRaceEvent(), which otherwise re-minimizes on every (re)arm.
      if (CONFIG.HUD && !m && Hud.autoMin && (Race.state === 'armed' || Race.state === 'running')) {
        Hud.autoMin = false; Hud.expandedThisRun = true;
      }
    },

    banner(text, sub, ms = 2500) {
      const b = this.E.banner;
      b.textContent = text;
      if (sub) b.append(h('small', { text: sub }));
      b.classList.add('fr-show');
      clearTimeout(this.bannerTimer);
      this.bannerTimer = setTimeout(() => b.classList.remove('fr-show'), ms);
    },
    status(text) { this.E.status.textContent = text; },

    // Fly to start (README "Racing an air-start course"). Reports which reposition path actually
    // took and whether you arrived flying, because those are the two things worth knowing in
    // the air — and because the velocity half is off until the frame is recorded.
    flyToStart() {
      const res = FlyToStart.run(clockNow());
      if (!res.ok) return this.status(res.detail);
      const t = res.target;
      const bits = ['On gate 1 via ' + res.how + ', heading ' + Math.round(t.heading) + '°'];
      bits.push(res.scalar ? 'airspeed set to ' + Math.round(t.speed) + ' m/s' : 'airspeed write refused');
      if (res.vector) bits.push('velocity set');
      else bits.push(CONFIG.VELOCITY_FRAME ? 'velocity write refused' : 'velocity not set (no frame recorded — you may need to power up)');
      if (!res.heading) bits.push('heading write refused (htr missing)');
      this.status(bits.join(', ') + '.');
    },

    // Capture aid for CONFIG.VELOCITY_FRAME (README "Capturing the velocity frame"). The log
    // itself refuses outside stable level cruise, so the status line has to explain that.
    logVelocityFrame() {
      if (!G.ready()) return this.status('GeoFS is still loading.');
      if (CONFIG.VELOCITY_FRAME) return this.status('CONFIG.VELOCITY_FRAME is already recorded.');
      if (G.logVelocityFrame('manual', clockNow())) {
        this.status('Logged velocity sample ' + G._frameLogs + '/4 to the DevTools console. Take one on ~090 and one on ~180.');
      } else if (G._frameLogs >= 4) {
        this.status('Already logged 4 samples this session — they are in the console. Reload to log more.');
      } else {
        this.status('Not stable level cruise yet: needs ~1 s wings-level above ' + CruiseWatch.limits.minSpeedMs + ' m/s, unpaused.');
      }
    },

    // ---- courses
    renderCourses(selectValue) {
      const s = this.E.select, keep = selectValue ?? s.value;
      s.textContent = '';
      s.append(h('option', { value: '', text: 'Choose a course' }));
      const local = Object.values(Courses.local());
      if (local.length) {
        const g = h('optgroup', { label: 'Saved on this computer' });
        local.sort((a, b) => a.name.localeCompare(b.name)).forEach((c) => g.append(h('option', { value: 'l:' + c.id, text: c.name })));
        s.append(g);
      }
      if (Courses.remote.length) {
        const g = h('optgroup', { label: 'Shared courses' });
        Courses.remote.forEach((c) => g.append(h('option', { value: 'r:' + c.file, text: c.name })));
        s.append(g);
      }
      if ([...s.options].some((o) => o.value === keep)) s.value = keep;
    },
    async refreshCourses() {
      await Courses.refreshRemote();
      this.renderCourses();
      this.status(Courses.remote.length ? Courses.remote.length + ' shared courses available.' : 'No shared courses found. Saved courses still work.');
    },
    async loadSelected() {
      const v = this.E.select.value;
      if (!v) return this.status('Choose a course first.');
      if (!G.ready()) return this.status('GeoFS is still loading. Try again in a moment.');
      try {
        const raw = v.startsWith('l:') ? Courses.local()[v.slice(2)] : await Courses.fetchRemote(v.slice(2));
        if (!raw) throw new Error('That saved course no longer exists.');
        const c = Race.load(raw);
        store.set('lastCourse', v);
        this.status('Loaded ' + c.name + ' (' + fmtDist(Race.lengthM) + ', ' + c.gates.length + ' gates). Leave the start sphere to begin.');
      } catch (e) { this.status('Could not load course: ' + e.message); }
    },

    // ---- synced countdown (Phase 4). Host flow: Arm picks a target N seconds out and shows
    // it as a clock-on-the-wall time for the host to read out. Friend flow: type that same
    // time into "join a target time" and click Join — each client then counts down to the
    // same epoch-ms target independently; see the Countdown module for why this never touches
    // race timing.
    armCountdown() {
      const lead = Math.max(3, Math.min(60, +this.E.cdLead.value || CONFIG.COUNTDOWN_LEAD_S));
      if (!Countdown.armIn(lead)) { this.status('Load a course before arming a countdown.'); return; }
      const t = new Date(Countdown.target);
      this.E.cdTargetDisplay.textContent = 'Target: ' + t.toLocaleTimeString() + ' — tell your friends to enter this under "join a target time."';
      this.E.cdStatus.textContent = '';
    },
    joinCountdown() {
      const raw = this.E.cdJoinInput.value.trim();
      const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(raw);
      if (!m) { this.E.cdStatus.textContent = 'Enter the target time as HH:MM or HH:MM:SS (24h, local).'; return; }
      const now = new Date();
      const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), +m[1], +m[2], +(m[3] || 0), 0);
      if (target.getTime() - Date.now() < -2000) { this.E.cdStatus.textContent = 'That time has already passed.'; return; }
      if (!Countdown.arm(target.getTime())) { this.status('Load a course before arming a countdown.'); return; }
      this.E.cdTargetDisplay.textContent = 'Target: ' + target.toLocaleTimeString();
      this.E.cdStatus.textContent = '';
    },
    renderCountdown() {
      const st = Countdown.state;
      if (st === 'idle') { this.E.cdBig.textContent = ''; this.E.cdTargetDisplay.textContent = ''; return; }
      if (st === 'go') { this.E.cdBig.textContent = 'SEND IT'; return; }
      this.E.cdBig.textContent = String(Math.max(0, Math.ceil((Countdown.target - Date.now()) / 1000)));
    },

    // ---- live readout
    hud(now, force) {
      if (!force && now - this.lastHud < 1000 / CONFIG.HUD_HZ) return;
      if (!force) this.lastHud = now;
      const E = this.E, r = Race, c = r.course;
      const kias = G.ready() ? G.kias() : null;
      E.speed.textContent = kias != null ? Math.round(kias) + ' kt' : '';
      if (CONFIG.GHOST) Ghost.refreshDelta();
      if (CONFIG.RIVAL_GHOSTS) RivalGhosts.refreshDeltas();
      if (CONFIG.POWERUPS) this.renderPowerups(now);
      if (CONFIG.HUD) Hud.render(now);
      if (CONFIG.LOBBY) this.renderLobby();
      if (!c) { E.gate.textContent = ''; E.dist.textContent = ''; E.vert.textContent = ''; E.arrow.style.visibility = 'hidden'; return; }

      const n = c.gates.length;
      if (r.state === 'running') E.timer.textContent = fmt(r.elapsed);
      else if (r.state === 'finished') E.timer.textContent = fmt(r.finalMs);
      else if (r.state === 'armed') E.timer.textContent = fmt(0);
      E.timer.classList.toggle('fr-dq', r.state === 'dq');
      if (r.state === 'dq') E.timer.textContent = 'DQ';

      const idx = r.state === 'armed' ? 0 : r.next;
      E.gate.textContent = r.state === 'finished' || r.state === 'dq' ? 'Done' : idx === 0 ? 'Start' : idx === n - 1 ? 'Finish' : 'Gate ' + idx + '/' + (n - 2);

      if (r.pos && idx < n && (r.state === 'armed' || r.state === 'running')) {
        const g = c.gates[idx];
        const d = vlen(sub(ecef(r.pos.lat, r.pos.lon, r.pos.alt), r.centers[idx])) - g.radius;
        E.dist.textContent = d <= 0 ? 'inside' : fmtDist(d);
        const dz = g.alt - r.pos.alt;
        E.vert.textContent = Math.abs(dz) < g.radius * 0.5 ? 'level' : (dz > 0 ? '↑ ' : '↓ ') + fmtDist(Math.abs(dz));
        const hd = G.heading();
        if (hd == null) E.arrow.style.visibility = 'hidden';
        else {
          E.arrow.style.visibility = 'visible';
          E.arrow.style.transform = 'rotate(' + Math.round(bearingDeg(r.pos, g) - hd) + 'deg)';
        }
      } else { E.dist.textContent = ''; E.vert.textContent = ''; E.arrow.style.visibility = 'hidden'; }
    },

    renderSplits() {
      const t = this.E.splits, c = Race.course;
      t.textContent = '';
      if (!c) { this.E.best.textContent = ''; return; }
      const best = Best.get(Race.hash);
      this.E.best.textContent = best ? 'Best ' + fmt(best.ms) : 'No best yet';
      const n = c.gates.length;
      Race.splits.forEach((ms, i) => {
        const label = i + 1 === n - 1 ? 'Finish' : 'Gate ' + (i + 1);
        const ref = best && best.splits[i];
        const d = Number.isFinite(ref) ? ms - ref : NaN;
        t.append(h('tr', null, h('td', { text: label }), h('td', { text: fmt(ms) }),
          h('td', { class: Number.isFinite(d) ? (d <= 0 ? 'fr-fast' : 'fr-slow') : 'fr-dim', text: fmtDelta(d) })));
      });
    },

    // ---- air-start UX (Phase 2/4, race/README.md "Racing an air-start course"). No new timing
    // logic: Race already starts the clock on the first start-gate crossing regardless of
    // startType — this only changes what the panel says while everyone converges on gate 1,
    // and (once a countdown is running) makes clear the countdown itself doesn't start the
    // clock — crossing gate 1 still does.
    renderStartHint() {
      const c = Race.course;
      // The fly-to-start button lives with this hint because they answer the same question:
      // how does anyone get to gate 1 on an air-start course?
      if (this.E.flyBtn) this.E.flyBtn.disabled = !FlyToStart.available();
      if (!c || c.startType !== 'air') { this.E.startHint.textContent = ''; return; }
      const waiting = Countdown.state === 'armed' || Countdown.state === 'go';
      this.E.startHint.textContent = waiting
        ? 'Air start — waiting to cross start. The clock starts when you cross gate 1, not on the countdown.'
        : 'Air start — converge on gate 1, clock starts when you cross it.';
    },

    // ---- leaderboard
    renderBoardState() {
      const off = !LB.enabled();
      this.E.lbMsg.textContent = off ? 'The leaderboard is off. Set API_BASE at the top of race.js to turn it on.' : '';
    },
    async refreshBoard() {
      if (!LB.enabled()) return this.renderBoardState();
      if (!Race.course) { this.E.lbMsg.textContent = 'Load a course to see its board.'; return; }
      this.E.lbMsg.textContent = 'Loading…';
      try {
        const rows = await LB.top(Race.hash);
        if (CONFIG.GHOST) this.renderGhostOptions(rows);
        if (CONFIG.RIVAL_GHOSTS) { await RivalGhosts.refreshList(); this.renderRivalOptions(); }
        this.E.lb.textContent = '';
        rows.forEach((row) => this.E.lb.append(h('li', null,
          document.createTextNode(row.callsign + (row.model ? ' (' + row.model + ')' : '')), h('span', { text: fmt(row.time_ms) }))));
        this.E.lbMsg.textContent = rows.length ? Race.course.name : 'No times on this course yet.';
      } catch (e) { this.E.lbMsg.textContent = 'Could not reach the leaderboard: ' + e.message; }
    },
    // Rebuilt whenever the course changes, the board is refreshed, or a run finishes (a finish
    // can create "My best" where there was none). Keeps the current pick selected if it is still
    // on offer, and falls back to Off — never silently races a different ghost than the one named.
    renderGhostOptions(boardRows) {
      if (!CONFIG.GHOST || !this.E.ghostSelect) return;
      const rows = boardRows || this._lastBoardRows || [];
      this._lastBoardRows = rows;
      const hasLocal = !!(Race.hash && TraceStore.read(Race.hash));
      const opts = Ghost.options(rows, hasLocal);
      const sel = this.E.ghostSelect;
      sel.textContent = '';
      for (const o of opts) sel.append(h('option', { value: o.value, text: o.label }));
      // A stored pick that is not currently on offer (board not fetched yet, that pilot fell out
      // of the top N, the leaderboard is down) is SHOWN rather than silently reset: clearing it
      // would quietly change which ghost you are racing, and it comes back on its own as soon as
      // the board loads. Ghost.status already says why it is not flying.
      const want = Ghost.pick;
      if (want && !opts.some((o) => o.value === want)) {
        const known = { mine: 'My best', record: 'Course record' };
        sel.append(h('option', { value: want, text: (known[want] || want) + ' · unavailable' }));
      }
      sel.value = want || '';
    },
    // Same contract as renderGhostOptions, one <select> per extra slot: each keeps its own pick
    // selected (shown as "unavailable" rather than cleared if the board doesn't currently offer it).
    renderRivalOptions() {
      if (!CONFIG.RIVAL_GHOSTS || !this.E.rivalSelects) return;
      const hasLocal = !!(Race.hash && TraceStore.read(Race.hash));
      const opts = RivalGhosts.options(hasLocal);
      const known = { mine: 'My best', record: 'Course record' };
      this.E.rivalSelects.forEach((sel, i) => {
        const want = RivalGhosts.extraPicks[i] || '';
        sel.textContent = '';
        for (const o of opts) sel.append(h('option', { value: o.value, text: o.label }));
        if (want && !opts.some((o) => o.value === want)) {
          sel.append(h('option', { value: want, text: (known[want] || want) + ' · unavailable' }));
        }
        sel.value = want;
      });
    },

    // ---- news banner (0.12.0): "Dave beat your hood-circuit by 0.41s". Dismissible, not
    // auto-hiding like the finish banner — see the News module for when this is shown.
    showNews(item) {
      if (!this.E.newsBanner) return;
      this.E.newsText.textContent = item.beaten_by + ' beat your ' + item.course_name + ' by ' +
        (item.margin_ms / 1000).toFixed(2) + 's →';
      this.E.newsRaceBtn.onclick = () => this.raceNewsGhost(item);
      this.E.newsBanner.classList.add('fr-show');
    },
    dismissNews() { if (this.E.newsBanner) this.E.newsBanner.classList.remove('fr-show'); },
    // Loads the course the beat happened on (fetching the shared course list first if needed) and
    // points the Ghost picker at whoever beat it.
    async raceNewsGhost(item) {
      this.dismissNews();
      try {
        if (!Courses.remote.length) await this.refreshCourses();
        const entry = Courses.remote.find((c) => c.id === item.course_id);
        if (!entry) { this.status('Could not find ' + item.course_name + ' in the shared course list.'); return; }
        const raw = await Courses.fetchRemote(entry.file);
        const c = Race.load(raw);
        store.set('lastCourse', 'r:' + entry.file);
        this.renderCourses('r:' + entry.file);
        if (CONFIG.GHOST) await Ghost.setPick(item.beaten_by);
        this.status('Loaded ' + c.name + '. Racing ' + item.beaten_by + '’s ghost.');
      } catch (e) { this.status('Could not load ' + item.course_name + ': ' + e.message); }
    },

    async submitRun() {
      if (!LB.enabled() || !this.E.autosub.checked) return;
      const name = (this.E.callsign.value || G.callsign() || '').trim().slice(0, 32);
      if (!name) { this.status('Finished. Add your name under Leaderboard to post times.'); return; }
      store.set('callsign', name);
      const c = Race.course;
      try {
        // The trace rides along as an optional field. An old server ignores unknown fields and
        // simply answers without trace_saved, which reads here as "no ghost uploaded" — no error
        // spam, one status note at most, exactly the old-server fallback CLAUDE.md asks for.
        const trace = Recorder.encodedForSubmit();
        const res = await LB.submit({
          course_id: c.id, course_hash: Race.hash, course_name: c.name, callsign: name,
          aircraft_id: G.aircraftId().slice(0, 32), model: G.model(), time_ms: Race.finalMs,
          splits: Race.splits, gates: c.gates.length, length_m: Math.round(Race.lengthM), client_version: CONFIG.VERSION,
          ...(trace ? { trace } : {}),
        });
        const ghostNote = trace && res.trace_saved === true ? ' Ghost uploaded.'
          : trace && res.trace_saved === false && res.trace_reason ? ' Ghost not saved: ' + String(res.trace_reason).slice(0, 120)
          : '';
        this.status('Posted. You are #' + res.rank + ' on ' + c.name + '.' + ghostNote);
        this.refreshBoard();
      } catch (e) { this.status('Finished, but posting failed: ' + e.message); }
    },

    // ---- model swap
    renderModelOptions() {
      const s = this.E.modelSelect;
      s.textContent = '';
      s.append(h('option', { value: '', text: 'Stock F-16' }));
      ModelSwap.index.forEach((m) => s.append(h('option', { value: m.id, text: m.name })));
      const stored = store.get('modelOverride', null);
      const initial = stored != null ? stored : ModelSwap.defaultModelId();
      if ([...s.options].some((o) => o.value === initial)) s.value = initial;
      this.E.modelEnabled.checked = store.get('modelEnabled', !!initial);
      this.E.modelHide.checked = store.get('modelHideCockpit', false);
      ModelSwap.setHideInCockpit(this.E.modelHide.checked);
    },
    async applyModelSelection() {
      const id = this.E.modelSelect.value;
      const enabled = this.E.modelEnabled.checked && !!id;
      store.set('modelOverride', id);
      store.set('modelEnabled', enabled);
      this.E.modelStatus.textContent = 'Loading…';
      if (enabled) await ModelSwap.enable(id); else await ModelSwap.disable();
      const name = ModelSwap.byId[id] && ModelSwap.byId[id].name;
      this.E.modelStatus.textContent = ModelSwap.status || (enabled ? 'Flying as ' + name + '.' : 'Flying stock F-16.');
    },

    // ---- powerups
    renderPowerups(now) {
      const E = this.E;
      if (!CONFIG.POWERUPS || !E.puStatus) return;
      const s = Powerups.state;
      const parts = s.slots.map((it, i) => (i + 1) + ': ' + (it ? POWERUP_LABELS[it] || it : i === POWERUP_BOX_SLOT ? 'box' : 'empty'));
      let txt = 'Carrying ' + parts.join(', ') + '.';
      for (const item of [...POWERUP_ITEMS, ...POWERUP_HIT_ITEMS]) {
        const left = s.effects[item] ? Math.max(0, s.effects[item] - now) : 0;
        if (left > 0) txt += ' ' + (POWERUP_LABELS[item] || item) + ' ' + (left / 1000).toFixed(1) + 's.';
      }
      E.puStatus.textContent = txt;

      // Which Boost write path is live. Worth a line in the panel because stage 1 and stage 2
      // feel different in the air, and because "nothing happened" needs somewhere to say why.
      if (E.puWriteStatus) {
        const frame = CONFIG.VELOCITY_FRAME;
        const w = Powerups.wrote;
        E.puWriteStatus.textContent = frame
          ? 'Boost: airspeed + velocity vector (frame recorded).' + (w.vector ? '' : w.scalar ? ' Vector write refused — the recorded frame no longer matches the live object.' : '')
          : 'Boost: airspeed only — velocity frame not captured yet. Hold level cruise and click below, then paste the sample into CONFIG.VELOCITY_FRAME.';
        if (E.puFrameBtn) E.puFrameBtn.style.display = frame ? 'none' : '';
      }
      if (E.puRelayStatus) {
        const room = Powerups.room();
        E.puRelayStatus.textContent = Relay.status ||
          (Relay.enabled() ? 'Relay: idle (connects when a race starts, room ' + (room || '—') + ').'
            : 'Loadout-only: no relay configured (CONFIG.API_BASE is empty).');
      }
      if (E.puFeed) {
        E.puFeed.textContent = '';
        for (const line of Powerups.feed) E.puFeed.append(h('li', { text: line }));
      }
    },

    // Drives the screen-effect overlay off the same time-boxed state the HUD reads, so an
    // expired effect can't leave the screen stuck: every frame recomputes from scratch.
    renderEffects(now) {
      const fx = this.E.fx;
      if (!CONFIG.POWERUPS || !fx) return;
      const active = powerupsActiveEffects(Powerups.state, now);
      for (const item of POWERUP_HIT_ITEMS) fx.classList.toggle('fr-fx-' + item, active.includes(item));
      // Boost is the one non-hit effect with a screen layer (the speed-line vignette), so it
      // joins the "is anything showing" test rather than riding the hit-items loop above.
      const boosting = CONFIG.ITEMS && active.includes('boost');
      fx.classList.toggle('fr-fx-boost', !!boosting);
      fx.classList.toggle('fr-fx-on', boosting || POWERUP_HIT_ITEMS.some((i) => active.includes(i)));
      // Goop clears from the centre outward over its last second, so the view comes back where
      // you are looking first instead of all at once. Pure presentation: the effect itself still
      // ends exactly when powerupsPrune() says it does.
      const until = Powerups.state.effects.goop;
      const left = Number.isFinite(until) ? Math.max(0, until - now) : 0;
      const clear = left > 0 && left < 1000 ? Math.round((1 - left / 1000) * 110) : 0;
      fx.style.setProperty('--fr-goop-clear', clear + '%');
    },

    // ---- lobby overlay (proto 2, race/PROTOCOL.md "Proto 2: lobby"). A second, independent
    // floating card, same pattern as #fr-banner: appended straight to document.body, not nested
    // in #fr-root, since it needs to be visible whether the settings panel is minimized or not.
    buildLobbyOverlay() {
      const E = this.E;
      const btn = (text, onclick, cls, title) => h('button', { type: 'button', class: cls, title, onclick, text });
      E.lobbyRoom = h('b', { id: 'fr-lobby-room' });
      E.lobbyCourse = h('div', { id: 'fr-lobby-course' });
      E.lobbyCup = h('div', { id: 'fr-lobby-cup' });
      // The host's "start a cup" inputs are made ONCE and re-appended by renderLobby(): that
      // method rebuilds the host controls on every lobby frame, and a name half-typed into a
      // freshly rebuilt input would vanish the moment somebody else pressed READY.
      E.lobbyCupName = h('input', { placeholder: 'Cup name', maxlength: '32', 'aria-label': 'Cup name', style: 'flex:1;min-width:0' });
      E.lobbyCupRaces = h('select', { 'aria-label': 'Races in the cup' });
      for (let n = 1; n <= 12; n++) E.lobbyCupRaces.append(h('option', { value: String(n), text: n + (n === 1 ? ' race' : ' races') }));
      E.lobbyCupRaces.value = '4';
      E.lobbyRules = h('div', { id: 'fr-lobby-rules' });
      E.lobbyPilots = h('ul', { id: 'fr-lobby-pilots' });
      E.lobbyReadyBtn = btn('READY UP', () => this.toggleReady(), 'fr-go', 'Alt+Y');
      E.lobbyReadyBtn.id = 'fr-lobby-ready';
      E.lobbyChat = h('div', { id: 'fr-lobby-chat' },
        ...CHAT_CODES.map((code) => btn(CHAT_LABELS[code], () => Lobby.chat(code))));
      E.lobbyHost = h('div', { id: 'fr-lobby-host' });
      E.lobbyStatus = h('div', { class: 'fr-dim' });
      E.lobbyOverlay = h('div', { id: 'fr-lobby', role: 'region', 'aria-label': 'Race lobby' },
        h('div', { id: 'fr-lobby-head' }, h('b', { text: 'Lobby' }), h('span', { style: 'flex:1' }),
          h('span', { class: 'fr-dim', text: 'Room ' }), E.lobbyRoom,
          btn('Copy', () => this.copyRoomCode(), null, 'Copy room code')),
        E.lobbyCourse, E.lobbyCup, E.lobbyRules, E.lobbyPilots, E.lobbyChat,
        E.lobbyReadyBtn, E.lobbyHost, E.lobbyStatus);
      document.body.append(E.lobbyOverlay);
      for (const t of ['keydown', 'keyup', 'keypress']) E.lobbyOverlay.addEventListener(t, (ev) => ev.stopPropagation());
    },

    // The pre-shell manual-sync countdown and its "server has no lobby" note: the fallback for no
    // relay or a relay below the lobby. Under LOBBY_V2 they are hidden once the room proves it
    // speaks REQUIRED_PROTO, so the Solo tab never shows a superseded ready/countdown control next
    // to a working Gate.
    applyLegacyGates() {
      const hide = CONFIG.LOBBY_V2 && Lobby.joinedSeen && Lobby.proto >= REQUIRED_PROTO;
      if (this.E.cdSection) this.E.cdSection.classList.toggle('fr-hidden', hide);
      if (this.E.lobbyProtoNote) this.E.lobbyProtoNote.classList.toggle('fr-proto-hidden', hide);
    },

    copyRoomCode() {
      const room = Relay.room || Powerups.room();
      try { navigator.clipboard.writeText(room); this.status('Room code copied: ' + room); }
      catch (_) { this.status('Room code: ' + room + ' (clipboard blocked)'); }
    },

    toggleReady() {
      Lobby.setReady(!Lobby.ready);
      this.renderLobby();
    },

    renderLobby() {
      const E = this.E;
      if (!CONFIG.LOBBY || !E.lobbyOverlay) return;
      if (E.lobbyProtoNote) {
        E.lobbyProtoNote.textContent = Lobby.isOldServer() ? 'Server has no lobby; using local countdown.' : '';
      }
      const btn2 = (text, onclick, cls, title) => h('button', { type: 'button', class: cls, title, onclick, text });
      const st = Lobby.state;
      const show = Lobby.active() && ['idle', 'armed'].includes(Race.state) &&
        (st.phase === 'lobby' || st.phase === 'countdown');
      E.lobbyOverlay.classList.toggle('fr-show', !!show);
      if (!show) return;

      E.lobbyRoom.textContent = Relay.room || '—';

      if (st.course) {
        const stats = Race.course && Race.hash === st.course.course_hash
          ? Race.course.gates.length + ' gates, ' + fmtDist(Race.lengthM) : 'loading…';
        E.lobbyCourse.textContent = st.course.name + ' · ' + st.course.start_type + '-start · ' + stats;
      } else {
        E.lobbyCourse.textContent = Lobby.isHost() ? 'Pick a course below.' : "Waiting for the host to pick a course.";
      }

      E.lobbyCup.textContent = st.cup
        ? 'Cup: ' + st.cup.name + ' · race ' + Math.min(st.cup.raceNo + 1, st.cup.raceCount) + ' of ' + st.cup.raceCount : '';

      E.lobbyRules.textContent = '';
      E.lobbyRules.append(
        h('span', { class: 'fr-chip' + (st.rules.powerups ? ' fr-chip-on' : ''), text: 'Powerups ' + (st.rules.powerups ? 'on' : 'off') }),
        h('span', { class: 'fr-chip' + (st.rules.teleport ? ' fr-chip-on' : ''), text: 'Teleport ' + (st.rules.teleport ? 'on' : 'off') }));

      const myCallsign = Powerups.callsign();
      E.lobbyPilots.textContent = '';
      for (const p of st.players) {
        E.lobbyPilots.append(h('li', { class: p.callsign === myCallsign ? 'fr-lobby-me' : null },
          h('span', { class: 'fr-lobby-dot' + (p.ready ? ' fr-lobby-dot-ready' : '') }),
          h('span', { class: 'fr-lobby-cs', text: p.callsign + (p.model ? ' (' + p.model + ')' : '') }),
          p.callsign === st.host ? h('span', { class: 'fr-lobby-host-mark', text: '★ host' }) : null,
          p.role === 'spectator' ? h('span', { class: 'fr-dim', text: 'spectating' }) : null));
      }

      E.lobbyReadyBtn.classList.toggle('fr-lobby-ready-on', Lobby.ready);
      E.lobbyReadyBtn.textContent = (Lobby.ready ? 'READY ✓' : 'READY UP') + ' (Alt+Y)';

      E.lobbyHost.textContent = '';
      E.lobbyCourseSel = null;
      if (Lobby.isHost()) {
        const courseSel = h('select', { 'aria-label': 'Lobby course' },
          h('option', { value: '', text: 'Choose a course' }));
        Object.values(Courses.local()).sort((a, b) => a.name.localeCompare(b.name))
          .forEach((c) => courseSel.append(h('option', { value: 'l:' + c.id, text: c.name })));
        Courses.remote.forEach((c) => courseSel.append(h('option', { value: 'r:' + c.file, text: c.name })));
        const pickBtn = btn2('Set course', async () => {
          const v = courseSel.value;
          if (!v) return;
          try {
            const raw = v.startsWith('l:') ? Courses.local()[v.slice(2)] : await Courses.fetchRemote(v.slice(2));
            const c = Race.load(raw);
            Lobby.setCourse(c);
          } catch (e) { this.status('Could not set course: ' + e.message); }
        }, 'fr-go');
        const puToggle = h('input', { type: 'checkbox', id: 'fr-lobby-rule-pu' }); puToggle.checked = st.rules.powerups;
        const tpToggle = h('input', { type: 'checkbox', id: 'fr-lobby-rule-tp' }); tpToggle.checked = st.rules.teleport;
        const onRules = () => Lobby.setRules({ powerups: puToggle.checked, teleport: tpToggle.checked });
        puToggle.addEventListener('change', onRules); tpToggle.addEventListener('change', onRules);
        const reason = !st.course ? 'Pick a course first.' : !Lobby.allReady() ? 'Waiting for everyone to ready up.' : '';
        const startBtn = btn2('Start countdown', () => Lobby.startCountdown(+E.cdLead.value || CONFIG.COUNTDOWN_LEAD_S, false), 'fr-go');
        startBtn.disabled = !!reason;
        const forceBtn = btn2('Force start', () => {
          const notReady = st.players.filter((p) => !p.ready).map((p) => p.callsign);
          let proceed = true;
          if (notReady.length) { try { proceed = confirm(notReady.join(', ') + ' will become spectators. Start anyway?'); } catch (_) { proceed = true; } }
          if (proceed) Lobby.startCountdown(+E.cdLead.value || CONFIG.COUNTDOWN_LEAD_S, true);
        });
        // Cups need a relay that speaks proto 4; below that there is nothing to send them to.
        const cupRow = CONFIG.RESULTS && Lobby.proto >= 4
          ? h('div', { class: 'fr-row' }, E.lobbyCupName, E.lobbyCupRaces,
            btn2(st.cup ? 'New cup' : 'Start cup', () => Lobby.startCup(E.lobbyCupName.value, E.lobbyCupRaces.value),
              null, 'A cup adds up points over its races; starting one replaces any cup already running'))
          : null;
        E.lobbyHost.append(
          h('div', { class: 'fr-row' }, courseSel, pickBtn),
          h('div', { class: 'fr-row' }, puToggle, h('label', { for: 'fr-lobby-rule-pu', text: 'Powerups' }),
            tpToggle, h('label', { for: 'fr-lobby-rule-tp', text: 'Teleport' })),
          cupRow,
          h('div', { class: 'fr-row' }, startBtn, forceBtn),
          reason ? h('div', { class: 'fr-dim', text: reason }) : null);
        E.lobbyCourseSel = courseSel;     // Results.focusPicker() reaches for it after the last render
      } else if (st.phase === 'countdown') {
        E.lobbyHost.textContent = 'Countdown running…';
      }

      E.lobbyStatus.textContent = Relay.status || '';
    },

    // ---- results overlay (proto 4). Same pattern as the lobby's card: appended to <body>, hidden
    // until renderResults() finds Results.view() has something to show. All content goes in through
    // textContent (the h() helper) — callsigns and models come off a socket.
    buildResultsOverlay() {
      const E = this.E;
      const btn = (text, onclick, cls, title) => h('button', { type: 'button', class: cls, title, onclick, text });
      E.resTitle = h('div', { id: 'fr-res-title' });
      E.resBadge = h('span', { class: 'fr-res-badge', text: 'New course record' });
      E.resSub = h('div', { id: 'fr-res-sub' });
      E.resCourse = h('div', { id: 'fr-res-course' });
      E.resWait = h('div', { id: 'fr-res-wait', 'aria-live': 'polite' });
      E.resTable = h('table', { id: 'fr-res-table' });
      E.resSide = h('div', { id: 'fr-res-side' });
      E.resBody = h('div', { id: 'fr-res-body' }, h('div', { style: 'overflow-x:auto' }, E.resTable), E.resSide);
      E.resButtons = h('div', { id: 'fr-res-buttons' });
      E.resOverlay = h('div', { id: 'fr-results', role: 'dialog', 'aria-label': 'Race results' },
        h('div', { id: 'fr-res-head' }, E.resTitle, E.resBadge, E.resSub), E.resCourse, E.resWait, E.resBody, E.resButtons);
      document.body.append(E.resOverlay);
      // Typing or Escape here must not reach the sim; Escape closes the card, like Close.
      for (const t of ['keydown', 'keyup', 'keypress']) {
        E.resOverlay.addEventListener(t, (ev) => { if (t === 'keydown' && ev.key === 'Escape') Results.close(); ev.stopPropagation(); });
      }
      E.resBtn = btn;
    },

    renderResults() {
      const E = this.E;
      if (!CONFIG.RESULTS || !E.resOverlay) return;
      let v = null;
      try { v = Results.view(); } catch (e) { console.warn('[finsRace] results view', e); }
      E.resOverlay.classList.toggle('fr-show', !!v);
      if (!v) return;

      E.resTitle.textContent = v.headline;
      E.resSub.textContent = v.sub;
      E.resBadge.style.display = v.record ? '' : 'none';
      E.resCourse.textContent = v.course;
      E.resWait.textContent = v.waitText;

      const local = v.kind === 'local';
      const cols = local ? [['#', 'n'], ['Pilot', ''], ['Time', 'n']]
        : [['#', 'n'], ['Pilot', ''], ['Time', 'n'], ['Gap', 'n'], ['Items', 'n'], ...(v.hasPoints ? [['Pts', 'n']] : [])];
      E.resTable.textContent = '';
      const head = h('tr');
      for (const [t, c] of cols) head.append(h('th', { class: c || null, scope: 'col', text: t }));
      E.resTable.append(head);
      for (const r of v.rows) {
        const tr = h('tr', { class: r.isMe ? 'fr-res-me' : r.waiting ? 'fr-res-wait' : null },
          h('td', { class: 'n', text: r.pos == null ? '' : String(r.pos) }),
          h('td', { class: 'fr-res-cs', title: r.dnfGate != null ? 'Out at gate ' + r.dnfGate : null },
            r.callsign + (r.isMe ? ' (you)' : ''),
            r.model ? h('span', { class: 'fr-dim', text: ' · ' + r.model }) : null,
            r.jumpStart ? h('span', { class: 'fr-res-js', text: ' jump start' }) : null),
          h('td', { class: 'n', text: r.time }));
        if (!local) {
          tr.append(h('td', { class: 'n', text: r.gap }), h('td', { class: 'n', text: r.items }));
          if (v.hasPoints) tr.append(h('td', { class: 'n', text: r.points }));
        }
        E.resTable.append(tr);
      }

      E.resSide.textContent = '';
      if (v.cup) {
        E.resSide.append(h('h4', { text: (v.cup.over ? 'Cup final · ' : 'Cup · ') + v.cup.name }),
          h('div', { class: 'fr-dim', text: 'race ' + v.cup.raceNo + ' of ' + v.cup.raceCount }),
          h('ol', null, ...v.cup.standings.map((s) => h('li', null, s.callsign, h('span', { text: String(s.points) })))));
      }
      if (v.awards.length) {
        E.resSide.append(h('h4', { text: 'Awards' }),
          h('ul', null, ...v.awards.map((a) => h('li', { class: 'fr-res-award' }, h('b', { text: a.label }),
            a.callsign + (a.detail ? ' · ' + a.detail : '')))));
      }
      E.resBody.classList.toggle('fr-res-solo', !E.resSide.childNodes.length);

      const btn = E.resBtn;
      E.resButtons.textContent = '';
      if (v.host) {
        E.resButtons.append(btn('Next race', () => Results.nextRace(), 'fr-go', 'Back to the lobby, with the course picker open'),
          btn('Rematch', () => Results.rematch(), null, 'The same course again'));
      }
      if (v.ghost) E.resButtons.append(btn('Race the winner’s ghost', () => Results.raceWinnersGhost(), null, 'Set the Ghost picker to the winner and go back to the lobby'));
      if (v.challenge) E.resButtons.append(btn('Copy challenge link', () => Results.copyChallengeLink(), null, 'Copy a link that preselects this course and these ghosts'));
      E.resButtons.append(btn('Close', () => Results.close(), 'fr-res-close', 'Esc'));
    },
  };

  // ------------------------------------------------------------------------- HUD (DOM only)
  // A second, independent DOM surface: #fr-hud, pointer-events:none, drawn under #fr-root and
  // #fr-banner (see the CSS z-index values). Never touches Cesium/GeoFS — it only reads state
  // that already exists (Race, Powerups, Relay, G) — so it can't affect timing or physics.
  // CONFIG.HUD = false means Hud.init() is never called and Hud.render()/onRaceEvent() are
  // no-ops, which is what keeps a disabled HUD byte-for-byte equivalent to 0.6.0's panel-only UI.
  const HUD_ICON_SVG = {
    boost: '<svg viewBox="0 0 24 24"><path d="M13 2 4 14h6l-1 8 9-13h-6z"/></svg>',
    shield: '<svg viewBox="0 0 24 24"><path d="M12 2l8 4v6c0 5-3.5 9-8 10-4.5-1-8-5-8-10V6z"/></svg>',
    banana: '<svg viewBox="0 0 24 24"><path d="M4 19c8 2 14-4 15-13"/></svg>',
    missile: '<svg viewBox="0 0 24 24"><path d="M3 12h11l7 3-7 3H3z"/></svg>',
    goop: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/></svg>',
  };
  const ordinal = (n) => n + ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 100 - (n % 100 > 10 && n % 100 < 20 ? n % 100 : 0)] || 'th');

  const Hud = {
    E: {}, built: false,
    autoMin: false, expandedThisRun: false,
    splitChipUntil: 0, splitChipText: '', splitChipClass: '',
    feedLines: [], lastBox: {},

    init() {
      if (!CONFIG.HUD) return;
      const E = this.E;
      E.posRank = h('div', { id: 'fr-hud-rank' });
      E.posOf = h('div', { id: 'fr-hud-of' });
      E.posGap = h('div', { id: 'fr-hud-gap' });
      E.tower = h('ol', { id: 'fr-hud-tower' });
      E.posBlock = h('div', { id: 'fr-hud-pos-block' }, E.posRank, E.posOf, E.posGap, E.tower);

      E.timer = h('div', { id: 'fr-hud-timer' });
      E.chip = h('div', { id: 'fr-hud-chip' });
      E.ghostDelta = h('div', { id: 'fr-hud-ghost' });
      E.chipRow = h('div', { id: 'fr-hud-chiprow' }, E.chip, E.ghostDelta);
      E.rivalDeltas = h('div', { id: 'fr-hud-rivals' });
      E.gateLabel = h('div', { id: 'fr-hud-gatelabel' });
      E.pips = h('div', { id: 'fr-hud-pips' });
      E.center = h('div', { id: 'fr-hud-center' }, E.timer, E.chipRow, E.rivalDeltas, E.gateLabel, E.pips);

      E.feed = h('ul', { id: 'fr-hud-feed' });

      E.speed = h('span', { id: 'fr-hud-speed' });
      E.alt = h('span', { id: 'fr-hud-alt' });
      E.speedalt = h('div', { id: 'fr-hud-speedalt' }, E.speed, E.alt);

      E.slots = [0, 1, 2].map((i) => {
        const icon = h('span', { class: 'fr-hud-icon' });
        const label = h('span', { class: 'fr-hud-slot-label' });
        const key = h('span', { class: 'fr-hud-slot-key', text: 'Alt+' + (i + 1) });
        const fill = h('div', { class: 'fr-hud-slot-bar-fill' });
        const bar = h('div', { class: 'fr-hud-slot-bar' }, fill);
        return { root: h('div', { class: 'fr-hud-slot' }, icon, label, key, bar), icon, label, fill };
      });
      E.items = h('div', { id: 'fr-hud-items' }, ...E.slots.map((s) => s.root));
      E.map = h('div', { id: 'fr-hud-map' });

      // Waypoint bracket. Both markers are built once and then only ever moved with
      // translate3d — see renderBracket(), which runs every animation frame.
      E.wpBox = h('div', { class: 'fr-hud-wp-box' });
      E.wpChev = h('div', { class: 'fr-hud-wp-chev' });
      E.wpLabel = h('div', { class: 'fr-hud-wp-label' });
      E.wp = h('div', { id: 'fr-hud-wp' }, E.wpBox, E.wpChev, E.wpLabel);
      E.wpNextNum = h('div', { class: 'fr-hud-wp2-num' });
      E.wpNext = h('div', { id: 'fr-hud-wp2' }, E.wpNextNum);

      // Inbound-projectile warning (0.10.0): a banner with a bar that drains over the
      // telegraphed flight time, plus an edge arrow pointing at the thing that is coming.
      E.inTitle = h('b');
      E.inFill = h('div', { class: 'fr-in-fill' });
      E.inbound = h('div', { id: 'fr-hud-inbound' }, E.inTitle,
        h('div', { class: 'fr-in-bar' }, E.inFill));
      E.inArrow = h('div', { id: 'fr-hud-in-arrow' });

      E.root = h('div', { id: 'fr-hud', 'aria-hidden': 'true' }, E.posBlock, E.center, E.feed, E.speedalt, E.items, E.map,
        ...(CONFIG.WAYPOINT_BRACKET ? [E.wp, E.wpNext] : []),
        ...(CONFIG.ITEMS ? [E.inbound, E.inArrow] : []));
      document.body.append(E.root);
      Minimap.init(E.map);
      this.built = true;
    },

    // Manual override, independent of render()'s own visibility class (fr-hud-show, driven by
    // Race.state) — same two-class split #fr-root uses for fr-hidden vs. fr-min.
    toggle(force) {
      if (!CONFIG.HUD || !this.built) return;
      const hide = force === undefined ? !this.E.root.classList.contains('fr-hud-off') : !force;
      this.E.root.classList.toggle('fr-hud-off', hide);
    },

    // Auto-minimize the settings panel on arm, unless the user expanded it manually this run.
    // "Restore on reset" (race/CLAUDE.md feature-series prompt) means a fresh arm re-applies the
    // default instead of remembering last run's manual override — see UI.minimize() for the
    // other half of this handshake. Never touches store.set('minimized', …): that key is the
    // user's own persisted preference, and auto-minimize must not overwrite it.
    autoMinimize() {
      if (!CONFIG.HUD || this.expandedThisRun) return;
      const root = UI.E.root;
      if (root && !root.classList.contains('fr-min')) { root.classList.add('fr-min'); this.autoMin = true; }
    },

    showSplitChip(deltaMs, now) {
      if (!CONFIG.HUD || !Number.isFinite(deltaMs)) return;
      this.splitChipUntil = now + 3000;
      this.splitChipText = fmtDelta(deltaMs);
      this.splitChipClass = deltaMs <= 0 ? 'fr-fast' : 'fr-slow';
    },
    pushFeed(text, now) {
      if (!CONFIG.HUD || !text) return;
      this.feedLines.unshift({ text: String(text), until: (Number.isFinite(now) ? now : clockNow()) + 6000 });
      if (this.feedLines.length > 4) this.feedLines.length = 4;
    },

    onRaceEvent(ev, data) {
      if (!CONFIG.HUD) return;
      if (ev === 'load' || ev === 'reset') {
        this.expandedThisRun = false;
        this.feedLines.length = 0;
        this.lastBox = {};
        if (Race.state === 'armed') this.autoMinimize();
      } else if (ev === 'gate') {
        const best = Best.get(Race.hash);
        const ref = best && Number.isFinite(best.splits[data.index]) ? best.splits[data.index] : NaN;
        if (Number.isFinite(ref)) this.showSplitChip(data.at - ref, clockNow());
      }
    },

    // ---- inbound warning (0.10.0). On the same per-frame clock as the waypoint bracket and
  // for the same reason: a bar that drains at 10 Hz reads as broken, and an arrow pointing at
  // where a missile was 100 ms ago is worse than no arrow. Like renderBracket() it writes
  // nothing but text and transforms on elements that already exist.
  _inText: '',
  renderInbound(now) {
    if (!CONFIG.HUD || !CONFIG.ITEMS || !this.built) return;
    const E = this.E;
    const p = Items.inbound;
    const live = !!p && E.root.classList.contains('fr-hud-show') && !E.root.classList.contains('fr-hud-off');
    E.inbound.classList.toggle('fr-hud-wp-show', !!live);
    if (!live) { E.inArrow.classList.remove('fr-hud-wp-show'); return; }

    const left = Math.max(0, p.flightMs - (now - p.launchedAt));
    const text = (p.item === 'goop' ? 'GOOP' : 'MISSILE') + ' INBOUND from ' + p.from;
    if (text !== this._inText) { this._inText = text; E.inTitle.textContent = text; }
    E.inbound.classList.toggle('fr-in-goop', p.item === 'goop');
    E.inFill.style.width = Math.round((left / Math.max(1, p.flightMs)) * 100) + '%';

    // The arrow. Same projection and the same edge-clamping the waypoint bracket uses, so an
    // off-screen projectile reads as a chevron on the shoulder it is coming over.
    const at = p.last;
    if (!at || !G.ready() || !Race.pos) { E.inArrow.classList.remove('fr-hud-wp-show'); return; }
    const vp = { width: window.innerWidth, height: window.innerHeight };
    const inset = Math.max(0, +CONFIG.HUD_EDGE_INSET_PX || 0);
    const turn = turnInstruction(bearingDeg(Race.pos, at), G.heading());
    const rel = turn ? (turn.dir === 'right' ? turn.deg : -turn.deg) : 0;
    const place = bracketPlacement(G.worldToScreen(at.lat, at.lon, at.alt), vp, inset, rel);
    E.inArrow.classList.add('fr-hud-wp-show');
    E.inArrow.style.transform = 'translate3d(' + Math.round(place.x) + 'px,' + Math.round(place.y) + 'px,0)';
    E.inArrow.textContent = place.mode === 'edge'
      ? ({ left: '\u25C0', right: '\u25B6', up: '\u25B2', down: '\u25BC' }[place.side] || '\u25B6')
      : '\u25C6';
  },

  // ---- waypoint bracket (0.9.0). The ONE element in this file that updates every animation
    // frame rather than at HUD_HZ: a marker that lags the world by 100 ms reads as broken in a
    // way a timer at 10 Hz does not. It stays cheap by writing nothing but `transform:
    // translate3d(...)` on two already-built elements — no layout properties, no re-created
    // nodes, and the text is only touched when it actually changes.
    //
    // The settings panel's own ▲ arrow (UI.hud) is untouched and still serves HUD-off mode.
    _wpText: '', _wp2Text: '',
    renderBracket() {
      if (!CONFIG.HUD || !CONFIG.WAYPOINT_BRACKET || !this.built) return;
      const E = this.E, r = Race, c = r.course;
      const hide = () => {
        E.wp.classList.remove('fr-hud-wp-show');
        E.wpNext.classList.remove('fr-hud-wp-show');
      };
      const spectating = CONFIG.LOBBY && Lobby.isSpectator();
      const live = !!c && (r.state === 'armed' || r.state === 'running') && !spectating &&
        E.root.classList.contains('fr-hud-show') && !E.root.classList.contains('fr-hud-off');
      const idx = r.state === 'armed' ? 0 : r.next;
      if (!live || !r.pos || idx >= c.gates.length || !G.ready()) return hide();

      const n = c.gates.length;
      const vp = { width: window.innerWidth, height: window.innerHeight };
      const inset = Math.max(0, +CONFIG.HUD_EDGE_INSET_PX || 0);
      const nameFor = (i) => (i === 0 ? 'START' : i === n - 1 ? 'FINISH' : 'GATE ' + i);

      const g = c.gates[idx];
      const dist = Math.max(0, vlen(sub(ecef(r.pos.lat, r.pos.lon, r.pos.alt), r.centers[idx])) - g.radius);
      const dz = g.alt - r.pos.alt;
      const turn = turnInstruction(bearingDeg(r.pos, g), G.heading());
      const rel = turn ? (turn.dir === 'right' ? turn.deg : -turn.deg) : 0;
      const place = bracketPlacement(G.worldToScreen(g.lat, g.lon, g.alt + CONFIG.ALT_OFFSET_M), vp, inset, rel);

      E.wp.classList.add('fr-hud-wp-show');
      const edge = place.mode === 'edge';
      E.wp.classList.toggle('fr-hud-wp-edge', edge);
      for (const s of ['left', 'right', 'up', 'down']) E.wp.classList.toggle('fr-hud-wp-' + s, edge && place.side === s);
      E.wp.style.transform = 'translate3d(' + Math.round(place.x) + 'px,' + Math.round(place.y) + 'px,0)';
      E.wpChev.textContent = edge ? ({ left: '◀', right: '▶', up: '▲', down: '▼' }[place.side] || '▶') : '';
      const text = edge ? chevronLabel(turn, dist, dz) : bracketLabel(nameFor(idx), dist, dz);
      if (text !== this._wpText) { this._wpText = text; E.wpLabel.textContent = text; }

      // The gate after: a smaller numbered marker, and only when it is genuinely on screen —
      // a second chevron fighting the first one for the same edge helps nobody.
      const after = idx + 1;
      const g2 = after < n ? c.gates[after] : null;
      const place2 = g2 ? bracketPlacement(G.worldToScreen(g2.lat, g2.lon, g2.alt + CONFIG.ALT_OFFSET_M), vp, inset, 0) : null;
      if (place2 && place2.mode === 'bracket') {
        E.wpNext.classList.add('fr-hud-wp-show');
        E.wpNext.style.transform = 'translate3d(' + Math.round(place2.x) + 'px,' + Math.round(place2.y) + 'px,0)';
        const t2 = after === n - 1 ? 'F' : String(after);
        if (t2 !== this._wp2Text) { this._wp2Text = t2; E.wpNextNum.textContent = t2; }
      } else {
        E.wpNext.classList.remove('fr-hud-wp-show');
      }
    },

    render(now) {
      const E = this.E;
      if (!CONFIG.HUD || !this.built) return;
      if (E.root.classList.contains('fr-hud-off')) { E.root.classList.remove('fr-hud-show'); return; }
      const r = Race, c = r.course;
      const visible = c && ['armed', 'running', 'finished', 'dq'].includes(r.state);
      E.root.classList.toggle('fr-hud-show', !!visible);
      if (!visible) return;

      // ---- position block + standings tower
      const info = CONFIG.POWERUPS ? hudPositionInfo(Relay.standings, Powerups.callsign()) : null;
      E.posBlock.classList.toggle('fr-hud-hidden', !info);
      if (info) {
        E.posRank.textContent = ordinal(info.rank);
        E.posOf.textContent = 'of ' + info.total;
        E.posGap.textContent = info.ahead ? 'behind ' + info.ahead : 'Leading';
        const rows = hudTowerRows(Relay.standings, Powerups.callsign(), {}, G.model());
        E.tower.textContent = '';
        for (const row of rows) {
          E.tower.append(h('li', { class: row.isMe ? 'fr-hud-me' : null },
            h('span', { class: 'fr-hud-tower-rank', text: String(row.rank) }),
            h('span', { class: 'fr-hud-tower-cs', text: row.callsign + (row.model ? ' (' + row.model + ')' : '') }),
            h('span', { class: 'fr-hud-tower-gap', text: row.gap })));
        }
      }

      // Spectators (proto 2 lobby, force-started but not readied up): no timing, no items —
      // just standings and the feed. Gates still render (RaceGates is a separate subscriber).
      const spectating = CONFIG.LOBBY && Lobby.isSpectator();
      E.center.classList.toggle('fr-hud-hidden', spectating);
      E.speedalt.classList.toggle('fr-hud-hidden', spectating);
      E.items.classList.toggle('fr-hud-hidden', spectating);
      if (!spectating) {
        // ---- center: timer / split chip / gate label / pips
        const n = c.gates.length;
        E.timer.textContent = r.state === 'running' ? fmt(r.elapsed)
          : r.state === 'finished' ? fmt(r.finalMs) : r.state === 'dq' ? 'DQ' : fmt(0);
        UI.E.root.classList.toggle('fr-hud-owns-timer', r.state === 'armed' || r.state === 'running');
        const chipLive = now < this.splitChipUntil;
        E.chip.classList.toggle('fr-hud-chip-show', chipLive);
        E.chip.classList.toggle('fr-fast', chipLive && this.splitChipClass === 'fr-fast');
        E.chip.classList.toggle('fr-slow', chipLive && this.splitChipClass === 'fr-slow');
        E.chip.textContent = chipLive ? this.splitChipText : '';
        // Live "vs ghost", next to the split chip. Same sign convention as everything else:
        // negative = ahead. Blank whenever there is no ghost to be measured against.
        const gd = CONFIG.GHOST && r.state === 'running' && Number.isFinite(Ghost.delta) ? Ghost.delta : null;
        const gstyle = gd == null ? 'neutral' : lineColorFor(gd, CONFIG.LINE_DELTA_BAND_MS);
        E.ghostDelta.classList.toggle('fr-hud-ghost-show', gd != null);
        E.ghostDelta.classList.toggle('fr-fast', gstyle === 'ahead');
        E.ghostDelta.classList.toggle('fr-slow', gstyle === 'behind');
        E.ghostDelta.classList.toggle('fr-close', gstyle === 'close');
        E.ghostDelta.textContent = gd == null ? '' : 'vs ghost ' + (gd < 0 ? '−' : '+') + (Math.abs(gd) / 1000).toFixed(2) + 's';

        // Compact rival stack (0.12.0): one line per extra ghost that actually has a trace
        // loaded, colored the same ahead/amber/behind as the racing line. The primary ghost above
        // is deliberately not repeated here — #fr-hud-ghost already shows it.
        if (CONFIG.RIVAL_GHOSTS) {
          E.rivalDeltas.textContent = '';
          const live = r.state === 'running';
          for (const e of RivalGhosts.extra) {
            if (!e.trace) continue;
            const dm = live ? e.delta : null;
            const style = dm == null ? 'neutral' : lineColorFor(dm, CONFIG.LINE_DELTA_BAND_MS);
            E.rivalDeltas.append(h('div', {
              class: 'fr-hud-rival' + (style === 'ahead' ? ' fr-fast' : style === 'behind' ? ' fr-slow' : style === 'close' ? ' fr-close' : ''),
              text: fmtRivalDelta(e.meta && e.meta.callsign, dm),
            }));
          }
        }

        E.gateLabel.textContent = r.state === 'finished' ? 'FINISHED' : r.state === 'dq' ? 'DISQUALIFIED'
          : 'GATE ' + Math.max(0, r.next) + ' / ' + (n - 1);
        const pips = hudPipStates(r.next, n);
        E.pips.textContent = '';
        for (const st of pips) E.pips.append(h('span', { class: 'fr-hud-pip' + (st !== 'remaining' ? ' fr-hud-pip-' + st : '') }));

        // ---- speed / altitude
        const kias = G.ready() ? G.kias() : null;
        const alt = G.ready() ? G.lla().alt : null;
        E.speed.textContent = kias != null ? Math.round(kias) + ' kt' : '';
        E.alt.textContent = Number.isFinite(alt) ? Math.round(alt * 3.280839895) + ' ft' : '';
      }

      // ---- minimap (its own 4 Hz clock inside draw())
      if (CONFIG.MINIMAP) Minimap.draw(now);

      // ---- event feed (Powerups.note() and relay `boxed` frames arrive via Hud.pushFeed())
      this.feedLines = this.feedLines.filter((l) => now < l.until);
      E.feed.textContent = '';
      for (const l of this.feedLines) {
        E.feed.append(h('li', { class: now > l.until - 800 ? 'fr-hud-feed-out' : null, text: l.text }));
      }

      // ---- item slots
      if (CONFIG.POWERUPS && !spectating) {
        const ps = Powerups.state, durations = powerupDurations();
        if (ps.slots[POWERUP_BOX_SLOT]) this.lastBox.item = ps.slots[POWERUP_BOX_SLOT];
        const rolling = Powerups.rollingItem(now);
        for (let i = 0; i < 3; i++) {
          const slot = E.slots[i], held = ps.slots[i];
          // While the box slot is spinning it shows the roulette's current face, and reads as
          // unfilled — because it is: the item cannot be fired until the reveal lands.
          const spinning = i === POWERUP_BOX_SLOT && rolling;
          const shown = spinning || held || (i < POWERUP_BOX_SLOT ? ps.loadout[i] : null);
          slot.root.classList.toggle('fr-hud-slot-filled', !!held && !spinning);
          if (i === POWERUP_BOX_SLOT && !shown) {
            slot.icon.innerHTML = '?'; slot.label.textContent = 'Box';
          } else if (shown) {
            slot.icon.innerHTML = HUD_ICON_SVG[shown] || '';
            slot.label.textContent = POWERUP_LABELS[shown] || shown;
          } else {
            slot.icon.innerHTML = ''; slot.label.textContent = '';
          }
          const total = shown ? durations[shown] : 0;
          const until = shown ? ps.effects[shown] : 0;
          const remain = until ? Math.max(0, until - now) : 0;
          slot.fill.style.width = (total && remain) ? Math.round((remain / total) * 100) + '%' : '0%';
        }
      } else {
        E.items.style.display = 'none';
      }
    },
  };

  // --------------------------------------------------------------- minimap
  // Inline SVG in #fr-hud-map. DOM only — no Cesium, no GeoFS beyond what the HUD already
  // reads — so like the rest of Hud it cannot affect timing or physics. Two layers with
  // different lifetimes: the course (route, gates, item box) is rebuilt only when the course or
  // the gate you are on changes, and the moving markers (me, ghost, other racers) are updated at
  // CONFIG.MINIMAP_HZ. Nothing here runs per frame.
  //
  // MINIMAP_HZ is a cap applied on top of Hud.render()'s own CONFIG.HUD_HZ (10) clock, since
  // that is what calls draw() — so the effective rate is 3-4 Hz, not exactly 4. A map of a
  // course is not worth its own timer to make that number exact.
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const svgEl = (tag, attrs, ...kids) => {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) if (v != null) el.setAttribute(k, v);
    for (const kid of kids) if (kid != null) el.append(kid);
    return el;
  };

  const Minimap = {
    E: {}, built: false, fit: null, courseKey: '', gateDots: [], lastDraw: 0, lastNext: -1,
    W: 160, H: 160, PAD: 14,

    init(host) {
      if (!CONFIG.MINIMAP || !host) return;
      const E = this.E;
      E.route = svgEl('polyline', { class: 'fr-mm-route', points: '', fill: 'none' });
      E.gates = svgEl('g', { class: 'fr-mm-gates' });
      E.box = svgEl('g', { class: 'fr-mm-box' });
      E.others = svgEl('g', { class: 'fr-mm-others' });
      E.bananas = svgEl('g', { class: 'fr-mm-bananas' });
      E.ghost = svgEl('circle', { class: 'fr-mm-ghost', r: 3, cx: -99, cy: -99 });
      // A north-up triangle, rotated by heading. Points are fixed; only the transform changes.
      E.me = svgEl('polygon', { class: 'fr-mm-me', points: '0,-6 4,5 0,2.5 -4,5' });
      E.svg = svgEl('svg', { class: 'fr-mm', viewBox: '0 0 ' + this.W + ' ' + this.H,
        width: this.W, height: this.H, 'aria-hidden': 'true' },
        svgEl('rect', { class: 'fr-mm-bg', x: 0, y: 0, width: this.W, height: this.H, rx: 8 }),
        E.route, E.gates, E.box, E.bananas, E.others, E.ghost, E.me);
      E.north = h('div', { class: 'fr-mm-north', text: 'N' });
      host.append(E.svg, E.north);
      this.built = true;
    },

    // Course layer. `key` folds in the course hash so a different course always redraws, and the
    // gate you are on so done/next/remaining restyle without rebuilding the geometry.
    drawCourse() {
      const c = Race.course;
      if (!this.built) return;
      const key = Race.hash || '';
      if (key === this.courseKey) return;
      this.courseKey = key;
      this.E.gates.textContent = '';
      this.E.box.textContent = '';
      this.gateDots = [];
      this.fit = null;
      this.E.route.setAttribute('points', '');
      if (!c) return;
      const pts = c.gates.map((g) => ({ lat: g.lat, lon: g.lon }));
      for (const b of c.itemBoxes) pts.push({ lat: b.lat, lon: b.lon });
      this.fit = minimapFit(pts, this.W, this.H, this.PAD);
      if (!this.fit) return;
      const xy = c.gates.map((g) => minimapPoint(this.fit, g.lat, g.lon));
      this.E.route.setAttribute('points', xy.map((p) => p.x.toFixed(1) + ',' + p.y.toFixed(1)).join(' '));
      xy.forEach((p, i) => {
        const dot = svgEl('circle', { cx: p.x.toFixed(1), cy: p.y.toFixed(1), r: i === 0 || i === xy.length - 1 ? 4 : 3 });
        this.E.gates.append(dot);
        this.gateDots.push(dot);
      });
      for (const box of c.itemBoxes) {
        const b = minimapPoint(this.fit, box.lat, box.lon);
        if (b) this.E.box.append(svgEl('rect', { x: (b.x - 3).toFixed(1), y: (b.y - 3).toFixed(1), width: 6, height: 6 }));
      }
      this.lastNext = -1;
    },

    // done / next / remaining, mirroring RaceGates.highlight() and the HUD's gate pips.
    styleGates() {
      const next = Race.state === 'armed' ? 0 : Race.next;
      if (next === this.lastNext) return;
      this.lastNext = next;
      this.gateDots.forEach((dot, i) => {
        dot.setAttribute('class', i < next ? 'fr-mm-done' : i === next ? 'fr-mm-next' : 'fr-mm-rest');
      });
    },

    draw(now) {
      if (!CONFIG.MINIMAP || !this.built) return;
      if (now - this.lastDraw < 1000 / Math.max(0.5, +CONFIG.MINIMAP_HZ || 4)) return;
      this.lastDraw = now;
      this.drawCourse();
      if (!this.fit || !Race.course) { this.E.svg.classList.add('fr-mm-empty'); return; }
      this.E.svg.classList.remove('fr-mm-empty');
      this.styleGates();

      const place = (el, lat, lon) => {
        const p = minimapPoint(this.fit, lat, lon);
        if (!p) { el.setAttribute('cx', -99); el.setAttribute('cy', -99); return null; }
        el.setAttribute('cx', p.x.toFixed(1));
        el.setAttribute('cy', p.y.toFixed(1));
        return p;
      };

      // Me: position plus heading. Rotation is a 4 Hz attribute write, not a per-frame one.
      const me = Race.pos ? minimapPoint(this.fit, Race.pos.lat, Race.pos.lon) : null;
      const hd = G.ready() ? G.heading() : null;
      this.E.me.setAttribute('transform', me
        ? 'translate(' + me.x.toFixed(1) + ',' + me.y.toFixed(1) + ') rotate(' + Math.round(hd || 0) + ')'
        : 'translate(-99,-99)');

      // Ghost: wherever its trace says it is right now.
      const gs = CONFIG.GHOST && Ghost.trace ? traceSampleAt(Ghost.trace, Ghost.clockMs()) : null;
      if (gs) place(this.E.ghost, gs.lat, gs.lon); else { this.E.ghost.setAttribute('cx', -99); this.E.ghost.setAttribute('cy', -99); }

      // Other racers, from the relay's standings frame. PROTOCOL.md's `positions` is optional:
      // an older relay sends `order` alone, and then there is simply nothing to draw here —
      // no error, no placeholder dots in the middle of the map.
      const mine = CONFIG.POWERUPS ? Powerups.callsign() : '';
      const others = CONFIG.POWERUPS && Relay.positions ? Object.entries(Relay.positions).filter(([cs]) => cs !== mine) : [];
      if (others.length !== this.E.others.childNodes.length) {
        this.E.others.textContent = '';
        for (let i = 0; i < others.length; i++) this.E.others.append(svgEl('circle', { r: 3, cx: -99, cy: -99 }));
      }
      others.forEach(([, p], i) => {
        const node = this.E.others.childNodes[i];
        if (node && p) place(node, +p.lat, +p.lon);
      });

      // Live bananas (0.10.0). Same "rebuild only when the count changes" shape as the other
      // racers above, so a course littered with them still costs one attribute write each.
      const bananas = CONFIG.ITEMS && CONFIG.POWERUPS ? [...Items.bananas.values()] : [];
      if (bananas.length !== this.E.bananas.childNodes.length) {
        this.E.bananas.textContent = '';
        for (let i = 0; i < bananas.length; i++) this.E.bananas.append(svgEl('circle', { r: 2.5, cx: -99, cy: -99 }));
      }
      bananas.forEach((b, i) => {
        const node = this.E.bananas.childNodes[i];
        if (node) place(node, b.lat, b.lon);
      });
    },
  };

  // ------------------------------------------------------------- editor
  const Editor = {
    draft: [], boxes: [],
    update() {
      DraftGates.draw(this.draft);
      ItemBoxGate.draw(this.boxes.length ? this.boxes : (Race.course ? Race.course.itemBoxes : []));
      const len = this.draft.length > 1 ? Course.length({ gates: this.draft }) : 0;
      const boxes = this.boxes.length ? ' ' + this.boxes.length + ' item box' + (this.boxes.length === 1 ? '' : 'es') + ' (Alt+B, Alt+Shift+B).' : '';
      UI.E.edInfo.textContent = (this.draft.length
        ? this.draft.length + ' draft gates, ' + fmtDist(len) + ' long. First is the start, last is the finish.'
        : 'No draft gates yet.') + boxes;
    },
    // Item boxes, dropped where the aircraft is. Alt+B puts one under you; Alt+Shift+B puts a
    // row of three across your current heading, 120 m apart, which is the shape the shipped
    // courses use — a row you have to pick a lane through rather than a box on the racing line.
    dropBox(row) {
      if (!G.ready()) return UI.status('GeoFS is still loading.');
      if (this.boxes.length >= MAX_ITEM_BOXES) return UI.status('A course can have at most ' + MAX_ITEM_BOXES + ' item boxes.');
      const p = G.lla(), hd = G.heading() ?? 0;
      const at = (offsetM) => {
        const q = offsetM ? destination(p, (hd + 90) % 360, offsetM) : p;
        return { lat: +q.lat.toFixed(6), lon: +q.lon.toFixed(6), alt: Math.round(p.alt), radius: this.radius() };
      };
      const add = row ? [-120, 0, 120] : [0];
      for (const off of add) {
        if (this.boxes.length >= MAX_ITEM_BOXES) break;
        this.boxes.push(at(off));
      }
      UI.E.editor.open = true;
      this.update();
      UI.status(this.boxes.length + ' item box' + (this.boxes.length === 1 ? '' : 'es') + ' in the draft.');
    },
    radius() { const r = +UI.E.edRadius.value; return Number.isFinite(r) && r >= 20 && r <= 5000 ? r : CONFIG.DEFAULT_RADIUS_M; },
    drop() {
      if (!G.ready()) return UI.status('GeoFS is still loading.');
      const p = G.lla();
      this.draft.push({ lat: +p.lat.toFixed(6), lon: +p.lon.toFixed(6), alt: Math.round(p.alt), radius: this.radius() });
      UI.E.editor.open = true;
      this.update();
    },
    undo() { this.draft.pop(); this.update(); },
    undoBox() { this.boxes.pop(); this.update(); },
    clear() { this.draft = []; this.boxes = []; this.update(); },
    testAhead() {
      if (!G.ready()) return UI.status('GeoFS is still loading.');
      const p = G.lla(), hd = G.heading() ?? 0;
      this.draft = [];
      for (let i = 0; i < CONFIG.TEST_COUNT; i++) {
        const q = destination(p, hd, 300 + i * CONFIG.TEST_SPACING_M);
        this.draft.push({ lat: +q.lat.toFixed(6), lon: +q.lon.toFixed(6), alt: Math.round(p.alt), radius: this.radius() });
      }
      if (!UI.E.edName.value) UI.E.edName.value = 'Test course';
      this.update();
    },
    build() {
      const name = UI.E.edName.value.trim() || 'Untitled course';
      return Course.normalize({ id: slug(name), name, version: 1,
        aircraftId: UI.E.edAircraft.checked ? G.aircraftId() : null,
        itemBoxes: this.boxes.slice(), gates: this.draft });
    },
    saveAndLoad() {
      try {
        const c = this.build();
        Courses.saveLocal(c);
        UI.renderCourses('l:' + c.id);
        Race.load(c);
        this.clear();
        UI.status('Saved and loaded ' + c.name + '. Copy JSON to share it.');
        UI.E.edJson.value = JSON.stringify(c, null, 1);
      } catch (e) { UI.status('Could not save: ' + e.message); }
    },
    async copy() {
      let c;
      try { c = this.draft.length ? this.build() : Race.course; } catch (e) { return UI.status(e.message); }
      if (!c) return UI.status('Nothing to copy. Load a course or drop some gates.');
      const text = JSON.stringify(c, null, 1);
      UI.E.edJson.value = text;
      try { await navigator.clipboard.writeText(text); UI.status('Copied ' + c.name + ' as JSON.'); }
      catch (_) { UI.E.edJson.select(); UI.status('Clipboard blocked. The JSON is selected in the box below; press Ctrl+C.'); }
    },
    importJson() {
      try {
        const c = Course.normalize(JSON.parse(UI.E.edJson.value));
        Courses.saveLocal(c);
        UI.renderCourses('l:' + c.id);
        Race.load(c);
        UI.status('Imported and loaded ' + c.name + '.');
      } catch (e) { UI.status('Import failed: ' + e.message); }
    },
    deleteSelected() {
      const v = UI.E.select.value;
      if (!v.startsWith('l:')) return UI.status('Pick a saved course in the list to delete it.');
      Courses.deleteLocal(v.slice(2));
      if (Race.course && Race.course.id === v.slice(2)) Race.unload();
      UI.renderCourses('');
      UI.status('Deleted.');
    },
  };

  // ------------------------------------------------------------- events
  Race.on((ev, data) => {
    if (ev === 'start') { UI.banner('Go!'); UI.status('Racing. Fly through the green sphere.'); UI.renderSplits(); }
    else if (ev === 'jumpstart') { UI.banner('JUMP START +' + (data / 1000).toFixed(0) + ' s', undefined, 2500); }
    else if (ev === 'gate') {
      UI.renderSplits();
      const best = Best.get(Race.hash);
      const ref = best && Number.isFinite(best.splits[data.index]) ? best.splits[data.index] : NaN;
      Sfx.play(Number.isFinite(ref) && data.at <= ref ? 'gate_pb' : 'gate');
    }
    else if (ev === 'reset' || ev === 'load') {
      // A countdown armed for a different (or no) course is stale once the course changes —
      // abort it, but NOT on every plain re-arm (Alt+R) of the *same* course, which must not
      // kill a countdown the group is sharing.
      if (ev === 'load' || (ev === 'reset' && !Race.course)) Countdown.abort();
      UI.renderSplits(); UI.hud(0, true); UI.renderStartHint();
      if (Race.course && ev === 'reset') UI.status('Armed. Leave the start sphere to begin.');
    }
    else if (ev === 'dq') {
      Sfx.play('dq'); UI.banner('DQ', data); UI.status('Disqualified: ' + data + '. Press Alt+R to try again.');
      if (CONFIG.RESULTS) Results.owe(Race.next);      // a lobby racer who is DQ'd is out of the race
    }
    else if (ev === 'abandon') { if (CONFIG.RESULTS) Results.owe(data && data.gate); }
    else if (ev === 'finish') {
      Sfx.play('finish');
      const prevBest = Best.get(Race.hash);
      const pb = Best.offer(Race.hash, data, Race.splits);
      const sub = prevBest ? fmtDelta(data - prevBest.ms) + (pb ? ' · new best' : '') : 'First finish';
      UI.renderSplits();
      UI.banner(fmt(data), sub, 5000);
      UI.status('Finished in ' + fmt(data) + '. Press Alt+R to race again.');
      UI.submitRun();                                  // the gate-1 clock, exactly as before
      if (CONFIG.RESULTS) Results.onFinish(data);      // …and, in a lobby race, the shared result
    }
  });

  // Trace recorder: another independent subscriber, deliberately registered AFTER the handler
  // above so that by the time it sees 'finish', Best.offer() has already run and Best.get(hash)
  // is this run's own time exactly when this run is the personal best (see Recorder.saveIfBest).
  // Gated at subscribe-time like every other optional module.
  if (CONFIG.TRACE) {
    Race.on((ev, data) => {
      if (ev === 'reset' || ev === 'load' || ev === 'dq') Recorder.reset();
      else if (ev === 'start') Recorder.reset();
      else if (ev === 'finish') Recorder.saveIfBest(Race.hash, data);
    });
  }

  // Ghost: its own subscriber, registered after the recorder so a finish has already had the
  // chance to save a new personal best before "My best" is offered again.
  if (CONFIG.GHOST) {
    Race.on((ev) => {
      if (ev === 'load') { Ghost.onCourseChange(); UI.renderGhostOptions(); }
      else if (ev === 'reset') Ghost.onReset();
      else if (ev === 'finish') UI.renderGhostOptions();
    });
  }

  // Rival ghosts (0.12.0): its own subscriber again, after Ghost's — a course change resolves the
  // primary pick first, then the extras; "My best"/"Next one up" both depend on this run's result
  // being recorded (Recorder's own subscriber above), same ordering reason as Ghost's.
  if (CONFIG.RIVAL_GHOSTS) {
    Race.on((ev) => {
      if (ev === 'load') { RivalGhosts.onCourseChange(); UI.renderRivalOptions(); }
      else if (ev === 'reset') RivalGhosts.onReset();
      else if (ev === 'finish') UI.renderRivalOptions();
    });
  }

  // Racing line: its own subscriber again. The forward-only window hint has to rewind with the
  // run, and the drawn path has to be rebuilt when the course (or the ghost behind it) changes.
  if (CONFIG.RACING_LINE) {
    Race.on((ev) => {
      if (ev === 'load' || ev === 'reset') LineRenderer.reset();
      LineRenderer.syncNote();
    });
  }

  // HUD: fourth, independent subscriber to the race bus (see CourseMap above for the pattern —
  // gated at subscribe-time so CONFIG.HUD = false means Hud never subscribes at all).
  if (CONFIG.HUD) Race.on((ev, data) => Hud.onRaceEvent(ev, data));

  // Second, independent subscriber to the same bus (see CourseMap above). Gated at
  // subscribe-time, not inside the handler, so CONFIG.COURSE_MAP = false means the module
  // truly never subscribes, not just "subscribes and no-ops".
  if (CONFIG.COURSE_MAP) {
    Race.on((ev, data) => {
      try {
        if (ev === 'load') CourseMap.draw(Race.course);
        else if (ev === 'gate') CourseMap.highlight(data.index + 1);
        else if (ev === 'reset') { if (Race.course) CourseMap.highlight(0); else { CourseMap.clear(); CourseMap.status = ''; CourseMap._syncStatus(); } }
        else if (ev === 'dq' || ev === 'finish') CourseMap.highlight(Race.course.gates.length);
      } catch (e) {
        CourseMap.status = 'Course map overlay off: ' + e.message;
        CourseMap._syncStatus();
      }
    });
  }

  // Powerups: third, independent subscriber to the race bus (see CourseMap above for why this
  // pattern is gated at subscribe-time). Owns the relay's lifecycle, plus slot refills and the
  // item box's visual. Every branch is inside Race.emit()'s own try/catch, and Relay itself
  // never throws, so a dead relay can never break the race; it just degrades to loadout-only.
  //
  // With CONFIG.LOBBY on, the relay's lifecycle is no longer race-scoped: a lobby needs to stay
  // connected while people gather, ready up, and chat *before* a race starts, so
  // Lobby.syncConnection() (driven by course load/unload, not by Race.state) is what owns
  // connect/disconnect instead. Without it (or against an old proto-1 server, which just never
  // sends a lobby frame), the original connect-on-start/disconnect-on-finish behavior is exactly
  // what ships — this is the "runs correctly against an old server" fallback CLAUDE.md asks for.
  if (CONFIG.POWERUPS) {
    Race.on((ev, data) => {
      const now = clockNow();
      if (ev === 'reset' || ev === 'load') {
        Powerups.refill();
        Powerups.roll = null;
        Powerups.pendingBox = null;
        Powerups.clearPenalty();
        Shake.stop();
        Items.reset();
        if (!CONFIG.LOBBY) Relay.disconnect();
        ItemBoxGate.draw(Race.course ? Race.course.itemBoxes : []);
        if (ev === 'load') Powerups.feed.length = 0;
      } else if (ev === 'start') {
        if (!CONFIG.LOBBY) Relay.connect(Powerups.room());
      } else if (ev === 'itembox') {
        Powerups.onItemBox(now, data && data.id);
      } else if (ev === 'finish' || ev === 'dq') {
        if (!CONFIG.LOBBY) Relay.disconnect();
      }
      if (CONFIG.LOBBY) Lobby.syncConnection();
      UI.renderPowerups(now);
    });
  }

  // Countdown UI: purely presentational (never throws into the countdown's own timer or the
  // Race bus). renderStartHint() is re-run on every countdown event too, since "waiting to
  // cross start" vs. "converge on gate 1" depends on Countdown.state.
  let lastCountdownSec = null;
  Countdown.on((ev, data) => {
    try {
      UI.renderCountdown(); UI.renderStartHint();
      if (ev === 'go') {
        Sfx.play('count_go'); UI.banner('SEND IT', undefined, 2000); lastCountdownSec = null;
        // Exactly at GO, never on 'armed'/'tick' — the Launch screen's whole job is the countdown.
        if (CONFIG.LOBBY_V2) Shell.autoCollapse('racing');
      }
      else if (ev === 'tick') {
        const sec = Math.ceil(data / 1000);
        if (sec !== lastCountdownSec) { lastCountdownSec = sec; Sfx.play('count_tick'); }
      } else if (ev === 'abort') { lastCountdownSec = null; }
    }
    catch (e) { console.error('[finsRace]', e); }
  });

  // Auto-collapse for a run with no countdown behind it: a solo time trial's GO is the moment the
  // clock actually starts, which is Race's own 'start' (crossing gate 1). A lobby race has already
  // collapsed at the countdown's GO above, and autoCollapse() is a no-op when already collapsed.
  if (CONFIG.LOBBY_V2) {
    Race.on((ev) => {
      if (ev === 'start') Shell.autoCollapse('running');
      else if (ev === 'load' || ev === 'reset') Shell.expandedThisRun = false;
    });
  }

  const onKeydown = (e) => {
    // Alt+Shift+B is the one shifted binding (a row of three item boxes); everything else
    // refuses Shift so a stray modifier can't fire a race control.
    if (!e.altKey || e.ctrlKey || e.metaKey || (e.shiftKey && e.code !== 'KeyB')) return;
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    const act = { KeyR: () => Race.reset(), KeyG: () => Editor.drop(), KeyU: () => Editor.undo(),
      KeyH: CONFIG.HUD ? () => Hud.toggle() : () => UI.toggle(),
      KeyB: () => Editor.dropBox(e.shiftKey) };
    if (CONFIG.RACING_LINE) act.KeyL = () => { UI.status(LineRenderer.toggle() ? 'Racing line on.' : 'Racing line off.'); };
    if (CONFIG.POWERUPS) {
      act.Digit1 = () => Powerups.useSlot(0, clockNow());
      act.Digit2 = () => Powerups.useSlot(1, clockNow());
      act.Digit3 = () => Powerups.useSlot(POWERUP_BOX_SLOT, clockNow());
    }
    // Ready toggle. The task spec asks for Alt+R, but that's Race.reset() (README "Controls",
    // shipped since 0.1 and covered by tests) — binding it to ready instead would silently
    // change what a very muscle-memoried key does mid-race. Alt+Y ("yes, I'm ready") is free.
    if (CONFIG.LOBBY) act.KeyY = () => Lobby.active() && (CONFIG.LOBBY_V2 ? Shell.toggleReady() : UI.toggleReady());
    const fn = act[e.code];
    if (!fn) return;
    e.preventDefault(); e.stopImmediatePropagation();
    fn();
  };
  window.addEventListener('keydown', onKeydown, true);

  // ---- news (0.12.0): "someone beat your time" without a Teams webhook. Polled once on load
  // with the last-seen timestamp this browser recorded, so a fresh install (nothing in
  // localStorage yet) sees no history rather than every beat ever recorded.
  const News = {
    key: 'newsSeenAt',
    enabled() { return CONFIG.RIVAL_GHOSTS && LB.enabled(); },
    async check() {
      if (!this.enabled()) return;
      try {
        const cs = Powerups.callsign();
        if (!cs) return;
        const since = store.get(this.key, 0);
        const items = await LB.news(cs, since);
        store.set(this.key, Math.floor(Date.now() / 1000));
        if (Array.isArray(items) && items.length) UI.showNews(items[0]);
      } catch (_) { /* a missed check is never worth surfacing at boot */ }
    },
  };

  // --------------------------------------------------------------- boot
  let errors = 0, lastLoopT = 0, tornDown = false, bootWait = 0;
  function loop(now) {
    if (tornDown) return;
    const dt = lastLoopT ? Math.max(0, now - lastLoopT) : 0;
    lastLoopT = now;
    frameNow = now;   // the one clock every time-boxed powerup effect is measured against
    try {
      // One sample per frame for the velocity-frame capture's "is this stable level cruise?"
      // test. Numbers only, read through G like everything else.
      CruiseWatch.sample(now, { heading: G.heading(), pitch: G.pitch(), roll: G.roll(), speed: G.currentSpeedMs(), paused: G.paused() });
      Race.tick(now); Recorder.tick(); Ghost.tick(); RivalGhosts.tick(); LineRenderer.tick(now); UI.hud(now); ModelSwap.tick(now); Powerups.tick(now, dt);
      Results.tick(now);
      if (CONFIG.POWERUPS) ItemBoxGate.tick(now, Race.boxReadyAt);
      // Every frame, not at HUD_HZ: a bracket that lags the world by 100 ms reads as broken,
      // and so does a warning bar draining against a projectile you can see.
      if (CONFIG.HUD) { Hud.renderBracket(); Hud.renderInbound(now); }
    }
    catch (e) { if (errors++ < 5) console.error('[finsRace] frame error', e); }
    requestAnimationFrame(loop);
  }

  function boot() {
    Sfx.init();
    if (CONFIG.RACING_LINE) LineRenderer.restore();
    UI.init();
    UI.mounted = CONFIG.LOBBY_V2 ? { ui: 'shell', why: 'CONFIG.LOBBY_V2 is on' } : { ui: 'classic', why: 'CONFIG.LOBBY_V2 is off (rollback)' };
    if (CONFIG.LOBBY_V2) {
      // A shell that fails to build must not take the rest of boot (the race loop) with it, and
      // must say so: the classic panel is left on screen as the fallback, with the reason.
      try { Shell.init(); }
      catch (e) {
        console.error('[finsRace] the lobby shell failed to boot; falling back to the classic panel', e);
        UI.mounted = { ui: 'classic', why: 'shell failed to boot: ' + ((e && e.message) || e) };
        try { UI.E.root.classList.remove('fr-hidden'); UI.banner('LOBBY FAILED', 'The lobby could not start (' + ((e && e.message) || e) + '). Solo racing still works.', 10000); } catch (_) {}
      }
    }
    const modelInit = ModelSwap.init();
    const started = performance.now();
    // Challenge link (0.12.0): ?course=<id>&ghost=<callsign>[,<callsign>...], read once at boot.
    // See parseChallengeParams()/buildChallengeLink() and Results.copyChallengeLink().
    const challenge = CONFIG.RIVAL_GHOSTS ? parseChallengeParams(location.search) : { course: null, ghosts: [] };
    const wait = bootWait = setInterval(async () => {
      if (G.ready()) {
        clearInterval(wait);
        UI.status('Ready. Choose a course, or build one in the course editor.');
        await UI.refreshCourses();
        let loadedFromChallenge = false;
        if (challenge.course) {
          const entry = Courses.remote.find((c) => c.id === challenge.course);
          if (entry) {
            try {
              const raw = await Courses.fetchRemote(entry.file);
              const c = Race.load(raw);
              store.set('lastCourse', 'r:' + entry.file);
              UI.renderCourses('r:' + entry.file);
              UI.status('Loaded ' + c.name + ' from a challenge link.');
              loadedFromChallenge = true;
              if (challenge.ghosts.length) await RivalGhosts.applyChallenge(challenge.ghosts);
            } catch (e) { UI.status('Could not load the challenged course: ' + e.message); }
          } else {
            UI.status('Challenge link named a course that is not in the shared list.');
          }
        }
        if (!loadedFromChallenge) {
          const last = store.get('lastCourse', '');
          if (last) { UI.renderCourses(last); if (UI.E.select.value === last) UI.loadSelected(); }
        }
        await modelInit;
        UI.renderModelOptions();
        if (UI.E.modelEnabled.checked && UI.E.modelSelect.value) await UI.applyModelSelection();
        requestAnimationFrame(loop);
        if (CONFIG.RIVAL_GHOSTS) News.check();
      } else if (performance.now() - started > CONFIG.READY_TIMEOUT_MS) {
        clearInterval(wait);
        UI.status('GeoFS never finished loading, or its internals changed. Reload the page and try again.');
      }
    }, 500);
  }

  // The other half of the instance guard at the top: a newer copy of race.js calls this on the
  // one already running, so the two never share a tab. Best-effort and idempotent — every step is
  // its own try, so one module that cannot clean up does not leave the sockets open. Cesium
  // primitives a joke-model swap added may linger until the next page load; nothing else does.
  function teardown(reason) {
    if (tornDown) return;
    tornDown = true;
    const steps = [
      () => clearInterval(bootWait),
      () => { CONFIG.POWERUPS && Relay.disconnect(); },
      () => Hub.disconnect(),
      () => Countdown.abort(),
      () => { if (Race.course) Race.unload(); },
      () => Items.reset(),
      () => Shake.stop(),
      () => ModelSwap._setStockHidden(false),
      () => { for (const t of ['_statusTimer', '_rampTimer', '_gateTimer', '_launchTimer']) clearInterval(Shell[t]); },
      () => window.removeEventListener('keydown', onKeydown, true),
      () => { if (Shell._markInput) for (const t of ['keydown', 'pointerdown', 'mousemove', 'wheel', 'touchstart']) window.removeEventListener(t, Shell._markInput, { capture: true }); },
      () => { Debug.teardown(); },
      () => { for (const el of [...document.querySelectorAll('body > [id^="fr-"], head > style[id^="fr-"]')]) el.remove(); },
    ];
    for (const step of steps) { try { step(); } catch (e) { console.warn('[finsRace] teardown step failed:', e); } }
    console.info('[finsRace] v' + CONFIG.VERSION + ' torn down' + (reason ? ' (' + reason + ')' : ''));
  }

  window.__finsRace = {
    version: CONFIG.VERSION, config: CONFIG, teardown, debug: Debug, race: Race, ui: UI, editor: Editor, modelSwap: ModelSwap, courseMap: CourseMap, countdown: Countdown, powerups: Powerups, relay: Relay, lobby: Lobby, hub: Hub, shell: Shell, results: Results, flyToStartModule: FlyToStart, hud: Hud, sfx: Sfx, recorder: Recorder, traceStore: TraceStore, ghost: Ghost, rivals: RivalGhosts, news: News, line: LineRenderer, minimap: Minimap, items: Items, shake: Shake,
    loadCourse: (c) => Race.load(c),
    logVelocityFrame: () => G.logVelocityFrame('manual', clockNow()),
    flyToStart: () => FlyToStart.run(clockNow()),
    _internals: {
      ecef, segHit, bearingDeg, destination, Course, fmt, G, sub, vlen,
      traceEmpty, traceQuantize, traceAppend, traceEncode, traceDecode, traceSampleAt,
      traceNearest, traceDeltaMs, traceIndexPut, angleDelta, angleLerp, headingLerp, wrap360,
      makeGhostLayer, makeLineLayer, traceWindow, lineColorFor, catmullRomPath,
      turnInstruction, bracketPlacement, bracketLabel, chevronLabel, minimapFit, minimapPoint,
      velocityShape, velocityFrameMatches, velocityBoosted, velocityFromReference, vecMag, vecRead, CruiseWatch,
      powerupsInitialState, powerupsRefill, powerupsPrune, powerupsUse, powerupsActive, powerupsBoostedSpeed,
      powerupsGrant, powerupsHit, powerupsActiveEffects, powerupsRelayUrl, powerupsRoom, powerupDurations,
      makeBoxLayer, makeItemLayer, MAX_ITEM_BOXES,
      projectilePos, rouletteFrames, rouletteFrameAt, penaltyTarget, ROULETTE_POOL, wrap180,
      sfxPatch, SFX_NAMES, hudTowerRows, hudPositionInfo, hudPipStates,
      clockOffset, lobbyReduce, lobbyInitialState, lobbyCup, lobbyVote, lobbyStartVote, gridSlot, CHAT_CODES, CHAT_LABELS,
      lobbyCanStart, REQUIRED_PROTO, serverToLocalMs,
      resultsReduce, resultsInitialState, resultsRows, resultsHeadline, resultsWaitingText, newRecordBadge,
      localResultsState, finishFrame, dnfFrame, finishGoTimeMs, bestSectorMs, ordinalOf, AWARD_LABELS,
      nextOneUpCallsign, rivalGhostOptions, fmtRivalDelta, parseChallengeParams, buildChallengeLink,
      // 1.3.0 lobby-first panel (LOBBY_V2) pure helpers — see race/PROTOCOL.md "Proto 5".
      hubUrl, parseRoomParam, buildInviteLink, sanitizeChatDraft, haversineM, launchGridRows,
      awayState, autoStartDecision, roomStatusPill, roomAction, presenceLine, rampDayKey,
      rampPingsRemaining, quickMatchTarget, voteTileState, hubActivity, cupPodium, KNOWN_TERRAIN_STATUS,
    },
  };
  if (document.body) boot(); else document.addEventListener('DOMContentLoaded', boot);
})();
