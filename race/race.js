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
    VERSION: '0.6.0',
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
        itemBox: Course.normalizeItemBox(c.itemBox), gates };
    },
    // The contested powerups item box: optional, at most one, and NOT part of the race — it
    // doesn't count for progress and is deliberately left out of Course.hash() so adding or
    // moving a box never resets a course's leaderboard. A malformed box is dropped rather than
    // thrown, matching this normalizer's permissive posture (race/tools/add_course.py is the
    // strict one: it rejects and explains, since it curates the shared list).
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
  const RaceGates = makeGateLayer('race');
  const DraftGates = makeGateLayer('draft');
  const ItemBoxGate = makeGateLayer('box');

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
    course: null, hash: '', lengthM: 0, centers: [], boxCenter: null, boxTaken: false,
    state: 'idle', next: 0, elapsed: 0, splits: [], finalMs: null, dqReason: '',
    prev: null, prevT: 0, chk: null, chkT: 0, wasInStart: false,
    listeners: [],
    on(fn) { this.listeners.push(fn); },
    emit(ev, data) { for (const fn of this.listeners) { try { fn(ev, data); } catch (e) { console.error('[finsRace]', e); } } },

    load(raw) {
      const c = Course.normalize(raw);
      this.course = c;
      this.hash = Course.hash(c);
      this.lengthM = Course.length(c);
      this.centers = c.gates.map((g) => ecef(g.lat, g.lon, g.alt));
      this.boxCenter = c.itemBox ? ecef(c.itemBox.lat, c.itemBox.lon, c.itemBox.alt) : null;
      RaceGates.draw(c.gates);
      this.reset();
      this.emit('load', c);
      return c;
    },
    unload() { this.course = null; this.boxCenter = null; RaceGates.clear(); this.state = 'idle'; this.emit('reset'); },
    reset() {
      this.state = this.course ? 'armed' : 'idle';
      this.next = 0; this.elapsed = 0; this.splits = []; this.finalMs = null; this.dqReason = '';
      this.chk = null; this.wasInStart = false; this.boxTaken = false;
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
      if (this.state === 'running') this.detectItemBox(prev, e);
      this.minT = 0;
    },

    // The powerups item box. Detected with the same interpolated segment test the gates use, so
    // it can't be tunnelled through, but deliberately kept out of the progress/splits path: it
    // never advances `next`, never records a split, and never changes `state`. Once per run, and
    // only while running — you can't farm it while armed. Emits for whoever's listening (the
    // Powerups module, when CONFIG.POWERUPS is on); nothing here depends on that listener.
    detectItemBox(p0, p1) {
      if (this.boxTaken || !this.boxCenter) return;
      const t = segHit(p0, p1, this.boxCenter, this.course.itemBox.radius);
      if (t < 0) return;
      this.boxTaken = true;
      this.emit('itembox', { at: this.elapsed });
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
    connected: false, standings: [],

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
            UI.renderPowerups(clockNow());
          } catch (_) {}
        };
        ws.onmessage = (ev) => { try { Powerups.onRelayMessage(JSON.parse(ev.data), clockNow()); } catch (_) {} };
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
      this.standings = [];
      clearTimeout(this.timer);
      try { if (this.ws) this.ws.close(); } catch (_) {}
      this.ws = null;
      this.connected = false;
      this.status = this.enabled() ? 'Relay: idle (connects when a race starts).' : 'Loadout-only: no relay configured (CONFIG.API_BASE is empty).';
    },
    send(obj) {
      try {
        if (!this.ws || this.ws.readyState !== 1) return false;
        this.ws.send(JSON.stringify(obj));
        return true;
      } catch (_) { return false; }
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
    },

    useSlot(i, now) {
      if (!CONFIG.POWERUPS) return;
      const { state, item } = powerupsUse(this.state, i, now, powerupDurations());
      this.state = state;
      if (item && POWERUP_HIT_ITEMS.includes(item)) {
        // Offensive: the relay adjudicates who it hits. If it can't be sent, the item is spent
        // anyway rather than silently re-usable — simpler than a rollback, and the feed says so.
        const sent = Relay.send({ type: 'fire', item });
        this.note(sent ? 'You fired ' + POWERUP_LABELS[item] + '.' : POWERUP_LABELS[item] + ' fizzled (no relay).');
      } else if (item) {
        UI.status(item === 'boost' ? 'Boost!' : 'Shield up.');
        this.note('You used ' + POWERUP_LABELS[item] + '.');
      }
      UI.renderPowerups(now);
    },
    isShielded(now) { return powerupsActive(this.state, 'shield', now); },

    // A box crossing. The client is authoritative only for "I crossed it"; the relay rolls the
    // item. With no relay, say so instead of self-granting anything.
    onItemBox(now) {
      if (!CONFIG.POWERUPS) return;
      ItemBoxGate.clear();
      if (Relay.send({ type: 'box' })) this.note('You hit the item box…');
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
        if (res.blocked) this.note('Shield ate ' + (from ? from + "'s " : 'a ') + (POWERUP_LABELS[item] || item) + '!');
        else if (res.applied) {
          this.note(item === 'goop' ? 'You got GRILLED by goop' + (from ? ' from ' + from : '') + '!'
            : item === 'missile' ? 'Mustard missile' + (from ? ' from ' + from : '') + ' — hang on!'
            : 'Banana' + (from ? ' from ' + from : '') + ' — wobble!');
          UI.banner(item === 'goop' ? 'GRILLED' : item === 'missile' ? 'MUSTARD' : 'BANANA', undefined, 1800);
        }
      } else if (msg.type === 'boxed') {
        if (who) this.note(who + ' boxed ' + (POWERUP_LABELS[String(msg.item || '')] || 'something') + '.');
      } else if (msg.type === 'standings') {
        if (Array.isArray(msg.order)) Relay.standings = msg.order.slice(0, 16).map((x) => String(x).slice(0, 32));
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
      if (Relay.connected && Race.state === 'running' && now - this.lastPing > 1000 / Math.max(0.2, CONFIG.POWERUP_POS_HZ)) {
        this.lastPing = now;
        const p = Race.pos;
        if (p) Relay.send({ type: 'pos', lat: p.lat, lon: p.lon, gate: Race.next, elapsed_ms: Math.round(Race.elapsed) });
      }
      UI.renderEffects(now);
    },
  };

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
        });
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

      const head = h('div', { id: 'fr-head' },
        h('b', { text: 'FINSONLY Racing' }), h('small', { text: 'v' + CONFIG.VERSION }),
        btn('–', () => this.minimize(), null, 'Minimize (Alt+H hides)'));

      const body = h('div', { id: 'fr-body' },
        h('div', { class: 'fr-row' }, E.select, btn('Load', () => this.loadSelected(), 'fr-go'),
          btn('↻', () => this.refreshCourses(), null, 'Refresh shared courses')),
        E.mapStatus,
        E.startHint,
        h('div', { class: 'fr-row' }, E.flyBtn),
        E.timer,
        h('div', { id: 'fr-nav' }, E.gate, h('span', null, E.arrow, ' ', E.dist), E.vert, E.speed),
        E.status,
        h('div', { class: 'fr-row' }, btn('Reset run', () => Race.reset(), null, 'Alt+R'), h('kbd', { text: 'Alt+R' }),
          h('span', { style: 'flex:1' }), E.best),
        E.splits,
        h('details', { id: 'fr-countdown' }, h('summary', { text: 'Synced countdown' }),
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
        h('details', { id: 'fr-model' }, h('summary', { text: 'Your plane' }),
          h('div', { class: 'fr-row' }, E.modelSelect),
          h('div', { class: 'fr-row' }, E.modelEnabled, h('label', { for: 'fr-model-enabled', text: 'Show joke model (physics stay F-16)' })),
          h('div', { class: 'fr-row' }, E.modelHide, h('label', { for: 'fr-model-hide', text: 'Hide in cockpit view' })),
          E.modelStatus),
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

      // Keep typing in our inputs from flying the plane.
      for (const t of ['keydown', 'keyup', 'keypress']) E.root.addEventListener(t, (ev) => ev.stopPropagation());
      this.makeDraggable(head);
      const pos = store.get('panelPos', null);
      if (pos) Object.assign(E.root.style, { left: pos.left, top: pos.top, right: 'auto' });
      if (store.get('minimized', false)) E.root.classList.add('fr-min');

      this.renderBoardState();
      this.renderCourses();
      if (CONFIG.POWERUPS) this.renderPowerups(clockNow());
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
    minimize() { const m = this.E.root.classList.toggle('fr-min'); store.set('minimized', m); },

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
      if (CONFIG.POWERUPS) this.renderPowerups(now);
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
        this.E.lb.textContent = '';
        rows.forEach((row) => this.E.lb.append(h('li', null,
          document.createTextNode(row.callsign + (row.model ? ' (' + row.model + ')' : '')), h('span', { text: fmt(row.time_ms) }))));
        this.E.lbMsg.textContent = rows.length ? Race.course.name : 'No times on this course yet.';
      } catch (e) { this.E.lbMsg.textContent = 'Could not reach the leaderboard: ' + e.message; }
    },
    async submitRun() {
      if (!LB.enabled() || !this.E.autosub.checked) return;
      const name = (this.E.callsign.value || G.callsign() || '').trim().slice(0, 32);
      if (!name) { this.status('Finished. Add your name under Leaderboard to post times.'); return; }
      store.set('callsign', name);
      const c = Race.course;
      try {
        const res = await LB.submit({
          course_id: c.id, course_hash: Race.hash, course_name: c.name, callsign: name,
          aircraft_id: G.aircraftId().slice(0, 32), model: G.model(), time_ms: Race.finalMs,
          splits: Race.splits, gates: c.gates.length, length_m: Math.round(Race.lengthM), client_version: CONFIG.VERSION,
        });
        this.status('Posted. You are #' + res.rank + ' on ' + c.name + '.');
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
  };

  // ------------------------------------------------------------- editor
  const Editor = {
    draft: [],
    update() {
      DraftGates.draw(this.draft);
      const len = this.draft.length > 1 ? Course.length({ gates: this.draft }) : 0;
      UI.E.edInfo.textContent = this.draft.length
        ? this.draft.length + ' draft gates, ' + fmtDist(len) + ' long. First is the start, last is the finish.'
        : 'No draft gates yet.';
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
    clear() { this.draft = []; this.update(); },
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
        aircraftId: UI.E.edAircraft.checked ? G.aircraftId() : null, gates: this.draft });
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
    else if (ev === 'gate') { UI.renderSplits(); }
    else if (ev === 'reset' || ev === 'load') {
      // A countdown armed for a different (or no) course is stale once the course changes —
      // abort it, but NOT on every plain re-arm (Alt+R) of the *same* course, which must not
      // kill a countdown the group is sharing.
      if (ev === 'load' || (ev === 'reset' && !Race.course)) Countdown.abort();
      UI.renderSplits(); UI.hud(0, true); UI.renderStartHint();
      if (Race.course && ev === 'reset') UI.status('Armed. Leave the start sphere to begin.');
    }
    else if (ev === 'dq') { UI.banner('DQ', data); UI.status('Disqualified: ' + data + '. Press Alt+R to try again.'); }
    else if (ev === 'finish') {
      const prevBest = Best.get(Race.hash);
      const pb = Best.offer(Race.hash, data, Race.splits);
      const sub = prevBest ? fmtDelta(data - prevBest.ms) + (pb ? ' · new best' : '') : 'First finish';
      UI.renderSplits();
      UI.banner(fmt(data), sub, 5000);
      UI.status('Finished in ' + fmt(data) + '. Press Alt+R to race again.');
      UI.submitRun();
    }
  });

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
  // pattern is gated at subscribe-time). Owns the relay's lifecycle — connect on start,
  // disconnect on reset/finish/dq — plus slot refills and the item box's visual. Every branch
  // is inside Race.emit()'s own try/catch, and Relay itself never throws, so a dead relay can
  // never break the race; it just degrades to loadout-only.
  if (CONFIG.POWERUPS) {
    Race.on((ev) => {
      const now = clockNow();
      if (ev === 'reset' || ev === 'load') {
        Powerups.refill();
        Relay.disconnect();
        ItemBoxGate.draw(Race.course && Race.course.itemBox ? [Race.course.itemBox] : []);
        if (ev === 'load') Powerups.feed.length = 0;
      } else if (ev === 'start') {
        Relay.connect(Powerups.room());
      } else if (ev === 'itembox') {
        Powerups.onItemBox(now);
      } else if (ev === 'finish' || ev === 'dq') {
        Relay.disconnect();
      }
      UI.renderPowerups(now);
    });
  }

  // Countdown UI: purely presentational (never throws into the countdown's own timer or the
  // Race bus). renderStartHint() is re-run on every countdown event too, since "waiting to
  // cross start" vs. "converge on gate 1" depends on Countdown.state.
  Countdown.on((ev) => {
    try { UI.renderCountdown(); UI.renderStartHint(); if (ev === 'go') UI.banner('SEND IT', undefined, 2000); }
    catch (e) { console.error('[finsRace]', e); }
  });

  window.addEventListener('keydown', (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    const act = { KeyR: () => Race.reset(), KeyG: () => Editor.drop(), KeyU: () => Editor.undo(), KeyH: () => UI.toggle() };
    if (CONFIG.POWERUPS) {
      act.Digit1 = () => Powerups.useSlot(0, clockNow());
      act.Digit2 = () => Powerups.useSlot(1, clockNow());
      act.Digit3 = () => Powerups.useSlot(POWERUP_BOX_SLOT, clockNow());
    }
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
      Race.tick(now); UI.hud(now); ModelSwap.tick(now); Powerups.tick(now, dt);
    }
    catch (e) { if (errors++ < 5) console.error('[finsRace] frame error', e); }
    requestAnimationFrame(loop);
  }

  function boot() {
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
    version: CONFIG.VERSION, config: CONFIG, race: Race, ui: UI, editor: Editor, modelSwap: ModelSwap, courseMap: CourseMap, countdown: Countdown, powerups: Powerups, flyToStartModule: FlyToStart,
    loadCourse: (c) => Race.load(c),
    logVelocityFrame: () => G.logVelocityFrame('manual', clockNow()),
    flyToStart: () => FlyToStart.run(clockNow()),
    _internals: {
      ecef, segHit, bearingDeg, destination, Course, fmt, G, sub, vlen,
      velocityShape, velocityFrameMatches, velocityBoosted, velocityFromReference, vecMag, vecRead, CruiseWatch,
      powerupsInitialState, powerupsRefill, powerupsPrune, powerupsUse, powerupsActive, powerupsBoostedSpeed,
      powerupsGrant, powerupsHit, powerupsActiveEffects, powerupsRelayUrl, powerupsRoom, powerupDurations,
    },
  };
  if (document.body) boot(); else document.addEventListener('DOMContentLoaded', boot);
})();
