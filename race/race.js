/*
 * FINSONLY Racing — checkpoint racing layer for GeoFS
 * Single file, no dependencies. Load with the bookmarklet in README.md.
 * Safe to load twice (second load just re-shows the panel).
 */
(() => {
  'use strict';
  if (window.__finsRace) { try { window.__finsRace.ui.toggle(true); } catch (_) {} return; }

  // ---------------------------------------------------------------- config
  const CONFIG = {
    VERSION: '0.9.0',
    COURSE_BASE: 'https://raw.githubusercontent.com/eburgard7-cloud/geofs/main/race/courses/',
    MODEL_BASE: 'https://raw.githubusercontent.com/eburgard7-cloud/geofs/main/race/models/',
    API_BASE: '',              // e.g. 'https://race.finsonly.net' — empty = leaderboard off
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
    // Relay lobby (proto 2, see race/PROTOCOL.md "Proto 2: lobby"). A room agrees ready/course/
    // start instead of everyone typing the same HH:MM:SS into a local-clock countdown. Gated on
    // the server actually reporting proto >= 2 in `joined` — an old server (or no relay at all)
    // means this whole module stays invisible and the manual countdown keeps working exactly as
    // it does today, moved under a "Manual sync (no relay)" details element. Shares the powerups
    // relay socket (CONFIG.POWERUPS/CONFIG.API_BASE) rather than opening a second connection —
    // with POWERUPS off there is no socket at all, so LOBBY has nothing to ride on either.
    LOBBY: true,
    JUMP_START_PENALTY_MS: 5000,  // added to Race.goElapsed for crossing gate 1 before GO — no DQ
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
  };

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
      box: Cesium.Color.fromCssColorString('#ffd23d').withAlpha(0.4),
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
          const text = kind === 'box' ? 'ITEM BOX'
            : kind === 'draft' ? 'Draft ' + (i + 1)
            : i === 0 ? 'Start' : i === n - 1 ? 'Finish' : 'Gate ' + i;
          const ball = v.entities.add({
            position: Cesium.Cartesian3.fromDegrees(g.lon, g.lat, alt),
            ellipsoid: { radii: new Cesium.Cartesian3(g.radius, g.radius, g.radius),
              material: kind === 'draft' ? C.draft : kind === 'box' ? C.box : C.later },
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
      if (!layer.ok || kind === 'draft' || kind === 'box') return;
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
    unload() { this.course = null; this.boxCenters = []; this.boxReadyAt = []; RaceGates.clear(); this.state = 'idle'; this.clearGo(); this.emit('reset'); },
    // Arms the second clock for a lobby race: atMs is a Date.now()-comparable epoch, exactly
    // what Countdown.arm() itself is driven from (see Lobby.onRelayMessage's 'start' handler).
    armGo(atMs) { this.goAt = Number.isFinite(atMs) ? atMs : null; this.goElapsed = null; this.jumpStartMs = 0; },
    clearGo() { this.goAt = null; this.goElapsed = null; this.jumpStartMs = 0; },
    reset() {
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

  // Reduces the client's view of the room from relay frames. `state` starts as
  // lobbyInitialState() below; every frame this doesn't recognize passes state through
  // unchanged, which is what lets an old/irrelevant frame type (a powerups `standings`, say)
  // flow through the same pipe with no special-casing.
  function lobbyInitialState() {
    return { phase: null, host: null, course: null, rules: { powerups: true, teleport: true },
      raceId: 0, players: [], start: null, chat: [] };
  }
  function lobbyReduce(state, frame) {
    const s = state || lobbyInitialState();
    if (!frame || typeof frame !== 'object') return s;
    if (frame.type === 'lobby') {
      return { ...s, phase: frame.phase, host: frame.host, course: frame.course || null,
        rules: frame.rules || s.rules, raceId: +frame.race_id || 0,
        players: Array.isArray(frame.players) ? frame.players : [] };
    }
    if (frame.type === 'start') {
      return { ...s, start: { raceId: +frame.race_id || 0, startAtServerMs: +frame.start_at_server_ms || 0,
        racers: Array.isArray(frame.racers) ? frame.racers.map(String) : [] } };
    }
    if (frame.type === 'abort') return { ...s, start: null };
    if (frame.type === 'chat' && typeof frame.callsign === 'string' && typeof frame.code === 'string') {
      const chat = [{ callsign: frame.callsign, code: frame.code }, ...s.chat].slice(0, 8);
      return { ...s, chat };
    }
    return s;
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
  //  2. Contested box + offensive items (needs the relay, see race/server/app.py): flying
  //     through the course's one item box asks the relay for an item; the relay is authoritative
  //     for the roll (weighted so the back of the pack gets better odds) and for who a fired
  //     offensive item hits. Incoming hits are applied by THIS client to ITSELF, time-boxed and
  //     auto-recovering, and Shield is honored here on receipt — the relay deliberately doesn't
  //     track shields (documented in app.py's relay header).
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
  // Rooms must match the relay's own ^[a-z0-9-]{1,32}$. A course hash already does; a
  // hand-typed code gets slugged into shape.
  function powerupsRoom(code, courseHash) {
    const c = code ? slug(code).slice(0, 32) : '';
    return c || (courseHash ? String(courseHash).slice(0, 32) : '');
  }

  // The relay socket. Nothing here touches GeoFS, and every path fails closed: any throw, any
  // failed connect, any malformed frame leaves the race running in loadout-only mode. It never
  // calls into Race, only into Powerups (which is itself guarded).
  const Relay = {
    ws: null, room: '', status: '', attempts: 0, timer: 0, wantOpen: false,
    // `positions` is the optional half of the standings frame (race/PROTOCOL.md): a relay old
    // enough to send `order` alone leaves this empty, and the minimap then simply draws no
    // other racers. It is never trusted for anything but a dot on a map.
    connected: false, standings: [], positions: null,

    enabled() { return !!CONFIG.API_BASE; },

    connect(room) {
      if (!CONFIG.POWERUPS) return;
      if (!this.enabled()) { this.status = 'Loadout-only: no relay configured (CONFIG.API_BASE is empty).'; return; }
      const url = powerupsRelayUrl(CONFIG.API_BASE, room);
      if (!url) { this.status = 'Loadout-only: no room to join yet.'; return; }
      this.wantOpen = true;
      this.room = room;
      this._open(url);
    },
    _open(url) {
      clearTimeout(this.timer);
      try { if (this.ws) { this.ws.onclose = null; this.ws.close(); } } catch (_) {}
      this.ws = null;
      try {
        const ws = new WebSocket(url);
        this.ws = ws;
        this.status = 'Relay: connecting…';
        ws.onopen = () => {
          try {
            this.connected = true; this.attempts = 0;
            this.status = 'Relay: connected (' + this.room + ').';
            this.send({ type: 'join', callsign: Powerups.callsign(), room: this.room });
            // Clock sync (proto 2) starts on the socket, not on `joined` — race/PROTOCOL.md's
            // `ping` is explicitly allowed before join, since it measures the round trip, not
            // the player. A proto-1 server never answers it; Lobby just never sees a `pong` and
            // stays gated off, same as if CONFIG.LOBBY were false.
            if (CONFIG.LOBBY) Lobby.startClockSync();
            UI.renderPowerups(clockNow());
          } catch (_) {}
        };
        ws.onmessage = (ev) => {
          try {
            const msg = JSON.parse(ev.data);
            Powerups.onRelayMessage(msg, clockNow());
            if (CONFIG.LOBBY) Lobby.onFrame(msg, clockNow());
          } catch (_) {}
        };
        ws.onerror = () => { this.status = 'Relay: connection error — loadout-only for now.'; };
        ws.onclose = () => {
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
      this.standings = []; this.positions = null;
      clearTimeout(this.timer);
      try { if (this.ws) this.ws.close(); } catch (_) {}
      this.ws = null;
      this.connected = false;
      this.status = this.enabled() ? 'Relay: idle (connects when a race starts).' : 'Loadout-only: no relay configured (CONFIG.API_BASE is empty).';
      if (CONFIG.LOBBY) Lobby.reset();
    },
    send(obj) {
      try {
        if (!this.ws || this.ws.readyState !== 1) return false;
        this.ws.send(JSON.stringify(obj));
        return true;
      } catch (_) { return false; }
    },
  };

  // A fixed, closed set (race/PROTOCOL.md `chat`) — never free text, so the relay can't be used
  // to pass arbitrary strings between clients.
  const CHAT_CODES = ['ready_soon', 'need_2_min', 'gg', 'rematch', 'brb', 'boss_incoming'];
  const CHAT_LABELS = { ready_soon: 'Ready soon', need_2_min: 'Need 2 min', gg: 'GG',
    rematch: 'Rematch?', brb: 'BRB', boss_incoming: 'Boss incoming!' };

  // The relay lobby (proto 2, race/PROTOCOL.md "Proto 2: lobby"). Wraps Relay the same way
  // Powerups does: every method fails closed, nothing here can throw into the race loop, and a
  // proto-1 (or absent) relay just means this module never has anything to show — CONFIG.LOBBY
  // gates whether it's even wired up at all (see the Race-bus subscriber near boot()).
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
      if (off != null) this.offsetMs = off;
    },
    // A relay server_ms turned into this client's own Date.now()-comparable epoch — what
    // Countdown.arm() and Race.armGo() both expect. Falls back to the raw server value (a few
    // hundred ms off at worst, before the first pong lands) rather than refusing to arm at all.
    toLocalMs(serverMs) { return this.offsetMs != null ? serverMs - this.offsetMs : serverMs; },

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
      if (msg.type === 'abort') { this.state = lobbyReduce(this.state, msg); Countdown.abort(); UI.renderLobby(); return; }
      if (msg.type === 'chat') {
        this.state = lobbyReduce(this.state, msg);
        const code = String(msg.code || '');
        Hud.pushFeed(String(msg.callsign || '?') + ': ' + (CHAT_LABELS[code] || code), now);
        UI.renderLobby();
      }
    },
    _onJoined(msg) {
      this.proto = Number.isFinite(msg.proto) ? msg.proto : 0;
      this.joinedSeen = true;
      if (this.proto >= 2 && this.sentHelloFor !== Relay.room) {
        this.sentHelloFor = Relay.room;
        Relay.send({ type: 'hello', model: G.model() });
      }
      UI.renderLobby();
    },
    _onLobby(msg) {
      this.state = lobbyReduce(this.state, msg);
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
      UI.renderLobby();
    },
    _onStart(msg) {
      this.state = lobbyReduce(this.state, msg);
      const start = this.state.start;
      if (!start || this.countdownArmedFor === start.raceId) return;
      this.countdownArmedFor = start.raceId;
      const localAt = this.toLocalMs(start.startAtServerMs);
      if (Race.course) Race.reset();          // fresh run for this countdown
      Countdown.arm(localAt);
      Race.armGo(localAt);                    // after reset(), which would otherwise clear it
      this.maybeGridTeleport(start, localAt);
      UI.renderLobby();
    },

    // Auto-loads the host's course through the existing course loader (README "Sharing a course
    // with everyone"): shared courses by id first, then a locally-saved copy, and verifies the
    // geometry hash afterward — a stale local copy would otherwise silently race a different
    // course than everyone else.
    _courseLoadKey: '',
    async maybeLoadCourse(course) {
      if (!course) return;
      const key = course.course_id + ':' + course.course_hash;
      if (Race.course && Race.hash === course.course_hash) { this._courseLoadKey = key; return; }
      if (this._courseLoadKey === key) return;
      this._courseLoadKey = key;
      try {
        await Courses.refreshRemote();
        const entry = Courses.remote.find((c) => c.id === course.course_id);
        const raw = entry ? await Courses.fetchRemote(entry.file) : Courses.local()[course.course_id];
        if (!raw) { UI.status('Host picked "' + course.name + '" — you don\'t have it. Click ↻ or import it.'); return; }
        const c = Race.load(raw);
        if (Course.hash(c) !== course.course_hash) {
          UI.banner('COURSE MISMATCH', 'Your copy of ' + c.name + ' differs from the host\'s — refresh (↻) and reload.', 6000);
        }
      } catch (e) { UI.status('Could not auto-load ' + course.name + ': ' + e.message); }
    },

    // Air-start grid (race/PROTOCOL.md "Grid"): only for racers (not spectators), only when the
    // host's rules say teleport, only on an air-start course. leadS is measured from the moment
    // this frame lands, which is close enough to the host's chosen lead — grid placement only
    // needs to be roughly right, not exact, since the pilot is still expected to fly the last
    // stretch under their own control.
    maybeGridTeleport(start, localAt) {
      try {
        const c = Race.course;
        if (!c || c.startType !== 'air' || !this.state.rules.teleport || !G.ready()) return;
        const idx = start.racers.indexOf(Powerups.callsign());
        if (idx < 0) return;
        const [g1, g2] = c.gates;
        if (!g1 || !g2) return;
        const leadS = Math.max(1, (localAt - Date.now()) / 1000);
        const speedMs = Math.max(0, Math.min(G.speedCap(), +CONFIG.FLY_TO_START_SPEED_MS || 0));
        const slot = gridSlot(g1, g2, idx, start.racers.length, leadS, speedMs);
        const how = G.repositionViaReset(slot) ? true : G.repositionByState(slot);
        if (!how) return;
        G.setHeading(slot.heading);
        const res = G.accelerateTo(speedMs);
        if (!res.vector) G.setVelocityFromFrame(speedMs);
      } catch (_) {}
    },

    // ---- client -> relay (host-only frames are refused server-side for anyone else, so the UI
    // just doesn't render the controls rather than duplicating the check here)
    setReady(v) { this.ready = !!v; Relay.send({ type: 'ready', ready: this.ready }); },
    setCourse(c) { Relay.send({ type: 'course', course_id: c.id, course_hash: Course.hash(c), name: c.name, start_type: c.startType }); },
    setRules(rules) { Relay.send({ type: 'rules', powerups: !!rules.powerups, teleport: !!rules.teleport }); },
    startCountdown(leadS, force) {
      Relay.send({ type: 'start', lead_s: Math.max(5, Math.min(60, Math.round(+leadS || CONFIG.COUNTDOWN_LEAD_S))), force: !!force });
    },
    abortCountdown() { Relay.send({ type: 'abort' }); },
    backToLobby() { Relay.send({ type: 'back_to_lobby' }); },
    chat(code) { if (CHAT_CODES.includes(code)) Relay.send({ type: 'chat', code }); },

    // Connects/disconnects the relay for the lobby's own lifecycle, independent of Race.state:
    // people gather, ready up, and chat before any course is even chosen. Called whenever the
    // available room might have changed (course loaded/unloaded, manual room code edited).
    syncConnection() {
      if (!CONFIG.LOBBY || !CONFIG.POWERUPS) return;
      const room = Powerups.room();
      if (!room) { if (Relay.wantOpen) Relay.disconnect(); return; }
      if (Relay.wantOpen && Relay.room === room) return;
      Relay.disconnect();
      Relay.connect(room);
    },
  };

  const Powerups = {
    state: powerupsInitialState(store.get('powerupLoadout', ['boost', 'boost'])),
    feed: [], lastPing: 0, relay: Relay,

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

    useSlot(i, now) {
      if (!CONFIG.POWERUPS) return;
      const { state, item } = powerupsUse(this.state, i, now, powerupDurations());
      this.state = state;
      if (item && POWERUP_HIT_ITEMS.includes(item)) {
        // Offensive: the relay adjudicates who it hits. If it can't be sent, the item is spent
        // anyway rather than silently re-usable — simpler than a rollback, and the feed says so.
        const sent = Relay.send({ type: 'fire', item });
        Sfx.play('item_use');
        this.note(sent ? 'You fired ' + POWERUP_LABELS[item] + '.' : POWERUP_LABELS[item] + ' fizzled (no relay).');
      } else if (item) {
        Sfx.play(item === 'shield' ? 'shield_up' : 'item_use');
        UI.status(item === 'boost' ? 'Boost!' : 'Shield up.');
        this.note('You used ' + POWERUP_LABELS[item] + '.');
      }
      UI.renderPowerups(now);
    },
    isShielded(now) { return powerupsActive(this.state, 'shield', now); },

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
      if (Relay.send({ type: 'box', id: boxId })) { Sfx.play('item_use'); this.note('You hit the item box…'); }
      else this.note('Item box needs the relay — nothing rolled.');
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
        this.state = powerupsGrant(this.state, item);
        this.note(item === 'nothing' ? 'Box gave you nothing. Rude.' : 'You boxed ' + (POWERUP_LABELS[item] || item) + ' (Alt+3).');
      } else if (msg.type === 'hit') {
        const item = String(msg.item || '');
        const res = powerupsHit(this.state, item, now, powerupDurations());
        this.state = res.state;
        if (res.blocked) { Sfx.play('shield_block'); this.note('Shield ate ' + (from ? from + "'s " : 'a ') + (POWERUP_LABELS[item] || item) + '!'); }
        else if (res.applied) {
          Sfx.play('hit');
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
      } else if (msg.type === 'joined') {
        Relay.status = 'Relay: in room ' + Relay.room + '.';
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
      this.state = powerupsPrune(this.state, now);
      if (powerupsActive(this.state, 'boost', now)) this.applyBoost(now, dt);
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
        if (p) Relay.send({ type: 'pos', lat: p.lat, lon: p.lon, gate: Race.next, elapsed_ms: Math.round(Math.max(0, ms)) });
      }
      UI.renderEffects(now);
    },
  };

  // ------------------------------------------------------------------------- sfx
  // Pure recipe table first (race/test/run.js asserts every name resolves with no AudioContext
  // at all): oscillator type + a two-point frequency envelope (freq -> freq2) + duration in
  // seconds. Sfx.play() below is the only thing that ever touches WebAudio, and it never throws
  // — a missing/blocked AudioContext, or an unknown name, just means silence.
  const SFX_NAMES = ['count_tick', 'count_go', 'gate', 'gate_pb', 'finish', 'dq', 'box_roll_tick',
    'box_grant', 'item_use', 'shield_up', 'shield_block', 'hit', 'incoming', 'lobby_ready', 'lobby_all_ready'];
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
  // is a real limitation, not a bug — see race/ACCEPTANCE.md "HUD".
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

    loadMine() {
      const enc = TraceStore.read(Race.hash);
      const trace = enc ? traceDecode(enc) : null;
      if (!trace) return null;
      const entry = TraceStore.entry(Race.hash);
      return { trace, meta: { callsign: 'my best', timeMs: entry ? entry.ms : NaN, model: G.model() } };
    },
    async loadRemote() {
      if (!LB.enabled()) throw new Error('the leaderboard is off, so only "My best" is available');
      const who = this.pick === GHOST_RECORD ? '' : this.pick;
      const body = await LB.ghost(Race.hash, who);
      const trace = traceDecode(body.trace);
      if (!trace) throw new Error('that ghost did not decode');
      return { trace, meta: { callsign: String(body.callsign || '?'), timeMs: +body.time_ms, model: String(body.model || '') } };
    },

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

  const CSS = `
#fr-root{--plum:#1d1029;--plum2:#2c1a3d;--sun:#ff8a3d;--pink:#ff3d8b;--cream:#fff4ea;--dim:#b9a6c8;--fast:#5be38f;--slow:#ff6b6b;
  position:fixed;top:72px;right:16px;width:300px;z-index:100000;color:var(--cream);
  font:13px/1.4 "Trebuchet MS","Segoe UI",system-ui,sans-serif;background:rgba(29,16,41,.9);
  border:1px solid rgba(255,138,61,.35);border-radius:14px;box-shadow:0 10px 30px rgba(10,0,20,.5);
  backdrop-filter:blur(6px);user-select:none}
#fr-root.fr-hidden{display:none}
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
#fr-fx.fr-fx-goop .fr-fx-goop-l{opacity:1;backdrop-filter:blur(7px) saturate(1.5);
  background:radial-gradient(circle at 28% 34%,rgba(120,200,40,.85) 0 16%,transparent 17%),
             radial-gradient(circle at 72% 28%,rgba(150,215,60,.8) 0 19%,transparent 20%),
             radial-gradient(circle at 44% 72%,rgba(100,180,30,.85) 0 22%,transparent 23%),
             radial-gradient(circle at 82% 68%,rgba(140,205,50,.75) 0 14%,transparent 15%),
             rgba(90,160,30,.5)}
@keyframes fr-wobble{0%,100%{transform:rotate(-1.4deg)}50%{transform:rotate(1.4deg)}}
@media (prefers-reduced-motion:reduce){
  #fr-banner,#fr-arrow{transition:none}
  /* Keep every tint/blur (the actual penalty) but drop the motion. */
  #fr-fx.fr-fx-banana .fr-fx-banana-l{animation:none}
  #fr-fx{transition:none}
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
`;

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
        h('details', { id: 'fr-countdown' }, h('summary', { text: CONFIG.LOBBY ? 'Manual sync (no relay)' : 'Synced countdown' }),
          E.cdBig,
          h('div', { class: 'fr-row' }, h('label', { text: 'Lead time (s)' }), E.cdLead,
            btn('Arm', () => this.armCountdown(), 'fr-go'), btn('Abort', () => Countdown.abort())),
          E.cdTargetDisplay,
          h('div', { class: 'fr-row' }, h('label', { text: 'Or join a target time' }), E.cdJoinInput,
            btn('Join', () => this.joinCountdown())),
          E.cdStatus),
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
          h('div', { class: 'fr-row' }, h('label', { text: 'Room' }), E.puRoom),
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
      if (CONFIG.POWERUPS) {
        E.fx = h('div', { id: 'fr-fx', 'aria-hidden': 'true' },
          h('div', { class: 'fr-fx-layer fr-fx-goop-l' }),
          h('div', { class: 'fr-fx-layer fr-fx-missile-l' }),
          h('div', { class: 'fr-fx-layer fr-fx-banana-l' }));
        document.body.append(E.fx);
      }
      if (CONFIG.LOBBY) this.buildLobbyOverlay();

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

    toggle(force) { const hide = force === undefined ? !this.E.root.classList.contains('fr-hidden') : !force; this.E.root.classList.toggle('fr-hidden', hide); },
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
      fx.classList.toggle('fr-fx-on', POWERUP_HIT_ITEMS.some((i) => active.includes(i)));
    },

    // ---- lobby overlay (proto 2, race/PROTOCOL.md "Proto 2: lobby"). A second, independent
    // floating card, same pattern as #fr-banner: appended straight to document.body, not nested
    // in #fr-root, since it needs to be visible whether the settings panel is minimized or not.
    buildLobbyOverlay() {
      const E = this.E;
      const btn = (text, onclick, cls, title) => h('button', { type: 'button', class: cls, title, onclick, text });
      E.lobbyRoom = h('b', { id: 'fr-lobby-room' });
      E.lobbyCourse = h('div', { id: 'fr-lobby-course' });
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
        E.lobbyCourse, E.lobbyRules, E.lobbyPilots, E.lobbyChat,
        E.lobbyReadyBtn, E.lobbyHost, E.lobbyStatus);
      document.body.append(E.lobbyOverlay);
      for (const t of ['keydown', 'keyup', 'keypress']) E.lobbyOverlay.addEventListener(t, (ev) => ev.stopPropagation());
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
        E.lobbyHost.append(
          h('div', { class: 'fr-row' }, courseSel, pickBtn),
          h('div', { class: 'fr-row' }, puToggle, h('label', { for: 'fr-lobby-rule-pu', text: 'Powerups' }),
            tpToggle, h('label', { for: 'fr-lobby-rule-tp', text: 'Teleport' })),
          h('div', { class: 'fr-row' }, startBtn, forceBtn),
          reason ? h('div', { class: 'fr-dim', text: reason }) : null);
      } else if (st.phase === 'countdown') {
        E.lobbyHost.textContent = 'Countdown running…';
      }

      E.lobbyStatus.textContent = Relay.status || '';
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
      E.gateLabel = h('div', { id: 'fr-hud-gatelabel' });
      E.pips = h('div', { id: 'fr-hud-pips' });
      E.center = h('div', { id: 'fr-hud-center' }, E.timer, E.chipRow, E.gateLabel, E.pips);

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

      E.root = h('div', { id: 'fr-hud', 'aria-hidden': 'true' }, E.posBlock, E.center, E.feed, E.speedalt, E.items, E.map,
        ...(CONFIG.WAYPOINT_BRACKET ? [E.wp, E.wpNext] : []));
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
        for (let i = 0; i < 3; i++) {
          const slot = E.slots[i], held = ps.slots[i];
          const shown = held || (i < POWERUP_BOX_SLOT ? ps.loadout[i] : null);
          slot.root.classList.toggle('fr-hud-slot-filled', !!held);
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
      E.ghost = svgEl('circle', { class: 'fr-mm-ghost', r: 3, cx: -99, cy: -99 });
      // A north-up triangle, rotated by heading. Points are fixed; only the transform changes.
      E.me = svgEl('polygon', { class: 'fr-mm-me', points: '0,-6 4,5 0,2.5 -4,5' });
      E.svg = svgEl('svg', { class: 'fr-mm', viewBox: '0 0 ' + this.W + ' ' + this.H,
        width: this.W, height: this.H, 'aria-hidden': 'true' },
        svgEl('rect', { class: 'fr-mm-bg', x: 0, y: 0, width: this.W, height: this.H, rx: 8 }),
        E.route, E.gates, E.box, E.others, E.ghost, E.me);
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
    else if (ev === 'dq') { Sfx.play('dq'); UI.banner('DQ', data); UI.status('Disqualified: ' + data + '. Press Alt+R to try again.'); }
    else if (ev === 'finish') {
      Sfx.play('finish');
      const prevBest = Best.get(Race.hash);
      const pb = Best.offer(Race.hash, data, Race.splits);
      const sub = prevBest ? fmtDelta(data - prevBest.ms) + (pb ? ' · new best' : '') : 'First finish';
      UI.renderSplits();
      UI.banner(fmt(data), sub, 5000);
      UI.status('Finished in ' + fmt(data) + '. Press Alt+R to race again.');
      UI.submitRun();
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
      if (ev === 'go') { Sfx.play('count_go'); UI.banner('SEND IT', undefined, 2000); lastCountdownSec = null; }
      else if (ev === 'tick') {
        const sec = Math.ceil(data / 1000);
        if (sec !== lastCountdownSec) { lastCountdownSec = sec; Sfx.play('count_tick'); }
      } else if (ev === 'abort') { lastCountdownSec = null; }
    }
    catch (e) { console.error('[finsRace]', e); }
  });

  window.addEventListener('keydown', (e) => {
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
    if (CONFIG.LOBBY) act.KeyY = () => Lobby.active() && UI.toggleReady();
    const fn = act[e.code];
    if (!fn) return;
    e.preventDefault(); e.stopImmediatePropagation();
    fn();
  }, true);

  // --------------------------------------------------------------- boot
  let errors = 0, lastLoopT = 0;
  function loop(now) {
    const dt = lastLoopT ? Math.max(0, now - lastLoopT) : 0;
    lastLoopT = now;
    frameNow = now;   // the one clock every time-boxed powerup effect is measured against
    try {
      // One sample per frame for the velocity-frame capture's "is this stable level cruise?"
      // test. Numbers only, read through G like everything else.
      CruiseWatch.sample(now, { heading: G.heading(), pitch: G.pitch(), roll: G.roll(), speed: G.currentSpeedMs(), paused: G.paused() });
      Race.tick(now); Recorder.tick(); Ghost.tick(); LineRenderer.tick(now); UI.hud(now); ModelSwap.tick(now); Powerups.tick(now, dt);
      if (CONFIG.POWERUPS) ItemBoxGate.tick(now, Race.boxReadyAt);
      // Every frame, not at HUD_HZ: a bracket that lags the world by 100 ms reads as broken.
      if (CONFIG.HUD) Hud.renderBracket();
    }
    catch (e) { if (errors++ < 5) console.error('[finsRace] frame error', e); }
    requestAnimationFrame(loop);
  }

  function boot() {
    Sfx.init();
    if (CONFIG.RACING_LINE) LineRenderer.restore();
    UI.init();
    const modelInit = ModelSwap.init();
    const started = performance.now();
    const wait = setInterval(async () => {
      if (G.ready()) {
        clearInterval(wait);
        UI.status('Ready. Choose a course, or build one in the course editor.');
        await UI.refreshCourses();
        const last = store.get('lastCourse', '');
        if (last) { UI.renderCourses(last); if (UI.E.select.value === last) UI.loadSelected(); }
        await modelInit;
        UI.renderModelOptions();
        if (UI.E.modelEnabled.checked && UI.E.modelSelect.value) await UI.applyModelSelection();
        requestAnimationFrame(loop);
      } else if (performance.now() - started > CONFIG.READY_TIMEOUT_MS) {
        clearInterval(wait);
        UI.status('GeoFS never finished loading, or its internals changed. Reload the page and try again.');
      }
    }, 500);
  }

  window.__finsRace = {
    version: CONFIG.VERSION, config: CONFIG, race: Race, ui: UI, editor: Editor, modelSwap: ModelSwap, courseMap: CourseMap, countdown: Countdown, powerups: Powerups, relay: Relay, lobby: Lobby, flyToStartModule: FlyToStart, hud: Hud, sfx: Sfx, recorder: Recorder, traceStore: TraceStore, ghost: Ghost, line: LineRenderer, minimap: Minimap,
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
      makeBoxLayer, MAX_ITEM_BOXES,
      sfxPatch, SFX_NAMES, hudTowerRows, hudPositionInfo, hudPipStates,
      clockOffset, lobbyReduce, lobbyInitialState, gridSlot, CHAT_CODES,
    },
  };
  if (document.body) boot(); else document.addEventListener('DOMContentLoaded', boot);
})();
