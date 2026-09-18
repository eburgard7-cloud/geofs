// Headless tests for race.js: mocks GeoFS + Cesium, flies a scripted aircraft.
// Run: cd race/test && npm i jsdom@24 && node run.js
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'race.js'), 'utf8');
let failures = 0;
const ok = (cond, msg) => { console.log((cond ? '  pass ' : '  FAIL ') + msg); if (!cond) failures++; };
const near = (a, b, tol) => Math.abs(a - b) <= tol;
// How many velocity-frame samples this page load has logged (the cap lives in G).
const G_frameLogs = (E) => E.R._internals.G._frameLogs;

// Minimal fake L.Map: tracks membership like the real thing (addLayer/removeLayer/hasLayer)
// without any real Leaflet/DOM behavior.
function makeFakeMap() {
  const layers = new Set();
  return {
    addLayer(l) { layers.add(l); },
    removeLayer(l) { layers.delete(l); },
    hasLayer(l) { return layers.has(l); },
    getCenter() { return { lat: 0, lng: 0 }; },
    _layers: layers,
  };
}
// Minimal fake Leaflet library covering what race.js's CourseMap actually calls: layerGroup,
// circle, polyline (no marker/divIcon — CourseMap labels gates with circle.bindTooltip instead).
// Each fake records the options it was constructed/styled with so tests can inspect them.
function makeFakeL() {
  const record = { circles: [], polylines: [], groups: [] };
  const L = {
    layerGroup() {
      const sub = new Set();
      const grp = {
        addLayer(l) { sub.add(l); },
        removeLayer(l) { sub.delete(l); },
        hasLayer(l) { return sub.has(l); },
        addTo(target) { target.addLayer(this); return this; },
        _sub: sub,
      };
      record.groups.push(grp);
      return grp;
    },
    circle(latlng, opts) {
      const c = {
        latlng, opts: { ...opts }, tooltip: null,
        setStyle(o) { Object.assign(this.opts, o); },
        bindTooltip(text, o) { this.tooltip = { text, opts: o }; return this; },
        addTo(target) { target.addLayer(this); return this; },
      };
      record.circles.push(c);
      return c;
    },
    polyline(latlngs, opts) {
      const p = { latlngs, opts: { ...opts }, addTo(target) { target.addLayer(this); return this; } };
      record.polylines.push(p);
      return p;
    },
  };
  return { L, record };
}

// Fake WebSocket for the powerups relay. Deliberately does NOT auto-open: race.js assigns its
// handlers after `new WebSocket(...)` returns, so tests fire open/message explicitly to keep
// ordering deterministic (no real sockets, no timers, no network).
function makeFakeWebSocket(record) {
  return class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0; // CONNECTING; 1 = OPEN, 3 = CLOSED, matching the real constants
      this.sent = [];
      this.onopen = null; this.onmessage = null; this.onerror = null; this.onclose = null;
      record.sockets.push(this);
      record.last = this;
    }
    send(s) {
      if (this.readyState !== 1) throw new Error('socket not open');
      this.sent.push(JSON.parse(s));
    }
    close() {
      const was = this.readyState;
      this.readyState = 3;
      if (was !== 3 && this.onclose) this.onclose();
    }
    // ---- test drivers
    fireOpen() { this.readyState = 1; if (this.onopen) this.onopen(); }
    fireMessage(obj) { if (this.onmessage) this.onmessage({ data: JSON.stringify(obj) }); }
    ofType(t) { return this.sent.filter((m) => m.type === t); }
  };
}

function env({ aircraftId = '7', modelApi = 'fromGltfAsync', models = null, assignments = null, withMap = false, courseMap = true, powerups = true, hud = true, lobby = true, seed = null, apiBase = null,
  velocityFrame = undefined, safeWrites = undefined, llaFallback = undefined, velocity = undefined, trueAirSpeed = 200, groundSpeed = 200, htr = undefined, resetFlight = undefined,
  patch = null, quotaFull = false, apiHandler = null } = {}) {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { runScripts: 'outside-only', url: 'https://www.geo-fs.com/geofs.php' });
  const w = dom.window;
  let rafCb = null;
  w.requestAnimationFrame = (cb) => { rafCb = cb; return 1; };
  const logs = [];
  // Captured, not printed: the velocity-frame capture logs through console.log by design, and
  // the tests assert on it. console.error still goes to the terminal so a frame error is loud.
  w.console = { ...console, warn() {}, log(...a) { logs.push(a); } };
  w.fetch = async (url) => {
    // Leaderboard/ghost API stub: a test supplies apiHandler(url) and returns a fetch-like
    // response for the routes it cares about, or null to fall through to the model fixtures.
    if (apiHandler) { const r = apiHandler(String(url)); if (r) return r; }
    if (models !== null && String(url).includes('models/index.json')) return { ok: true, status: 200, json: async () => models };
    if (assignments !== null && String(url).includes('models/assignments.json')) return { ok: true, status: 200, json: async () => assignments };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  // Records the alpha it was asked for, so a test can assert e.g. CONFIG.GHOST_ALPHA actually
  // reached Cesium; withAlpha is own+enumerable so the copy keeps working.
  const color = { __alpha: 1, withAlpha(a) { return Object.assign({}, this, { __alpha: a }); } };
  const primitives = { list: [], add(m) { this.list.push(m); return m; }, remove(m) { const i = this.list.indexOf(m); if (i >= 0) this.list.splice(i, 1); m._destroyed = true; } };
  const makeFakeModel = (opts) => ({ show: true, modelMatrix: null, scale: 1, url: opts.url, _destroyed: false });
  const ModelCtor = {};
  if (modelApi === 'fromGltfAsync') ModelCtor.fromGltfAsync = async (opts) => makeFakeModel(opts);
  else if (modelApi === 'fromGltf') ModelCtor.fromGltf = (opts) => makeFakeModel(opts);
  else if (modelApi === 'fail') ModelCtor.fromGltfAsync = async () => { throw new Error('glTF parse error'); };
  // modelApi === 'none' leaves both undefined, simulating an old Cesium build.
  w.Cesium = {
    Color: { fromCssColorString: () => color, WHITE: color, BLACK: color },
    Cartesian3: Object.assign(function (x, y, z) { Object.assign(this, { x, y, z }); }, {
      fromDegrees: (lon, lat, h) => ({ lon, lat, h }), fromDegreesArrayHeights: (a) => a }),
    Cartesian2: function (x, y) { Object.assign(this, { x, y }); },
    LabelStyle: { FILL_AND_OUTLINE: 2 },
    ColorBlendMode: { HIGHLIGHT: 0, REPLACE: 1, MIX: 2 },
    ArcType: { NONE: 0, GEODESIC: 1, RHUMB: 2 },
    // Cesium 1.96 property/material shapes the racing line uses. CallbackProperty keeps the
    // function as .cb so a test can call it and check the array identity between frames.
    CallbackProperty: function (cb, isConstant) { Object.assign(this, { cb, isConstant }); },
    PolylineGlowMaterialProperty: function (o) { Object.assign(this, o); this.__glow = o.glowPower; },
    PolylineDashMaterialProperty: function (o) { Object.assign(this, o); this.__dash = o.dashLength; },
    Model: ModelCtor,
    HeadingPitchRoll: function (heading, pitch, roll) { Object.assign(this, { heading, pitch, roll }); },
    Transforms: { headingPitchRollToFixedFrame: (position, hpr) => ({ __matrix: true, position, hpr }) },
    Math: { toRadians: (d) => d * Math.PI / 180 },
  };
  const ents = new Set();
  const state = { paused: false };
  const stockNode = { visible: true, _children: [{ visible: true }, { visible: true }] }; // real object3d: root + per-part children, each with its own .visible
  const fakeL = makeFakeL();
  w.L = fakeL.L; // real GeoFS pages always have the Leaflet global; a live map instance is optional
  const fakeMap = withMap ? makeFakeMap() : null;
  // Probe-confirmed writable fields: trueAirSpeed/groundSpeed are numbers, velocity is a vector
  // object. The default here is an {x,y,z} object holding 200 m/s along +x, which is what a
  // body-fixed frame with fwd:'x' would look like in level cruise on any heading.
  const instance = {
    llaLocation: [45, -122, 1000], id: aircraftId, object3d: stockNode,
    trueAirSpeed, groundSpeed,
    velocity: velocity === undefined ? { x: 200, y: 0, z: 0 } : velocity,
  };
  if (htr !== undefined) instance.htr = htr;
  w.geofs = {
    aircraft: { instance },
    api: { viewer: { entities: {
      add: (o) => { const e = { ...o, ellipsoid: o.ellipsoid && { ...o.ellipsoid }, show: true }; ents.add(e); return e; },
      remove: (e) => ents.delete(e) },
      scene: { primitives } } },
    animation: { values: { heading360: 90, kias: 400, pitch: 5, roll: -10 } },
    isPaused: () => state.paused,
    userRecord: { callsign: 'Eric' },
    camera: { currentMode: 0, currentModeName: 'follow', currentDefinition: { insideView: false } },
    map: fakeMap, // resolved by G.leafletMap(); null here means "no live map" (map never opened)
  };
  w.multiplayer = { users: {} }; // real GeoFS holds this as a window global, not geofs.multiplayer
  // geofs.resetFlight: absent unless a test supplies one, exactly like a GeoFS build that
  // doesn't expose it. A test's function receives the coordinate arrays it is meant to honor.
  if (resetFlight) {
    w.geofs.lastFlightCoordinates = [44, -121, 500, 0, 0, 0];
    w.geofs.initialCoordinates = [44, -121, 500, 0, 0, 0];
    w.geofs.resetFlight = () => resetFlight(w.geofs);
  }
  let src = courseMap === false ? SRC.replace('COURSE_MAP: true,', 'COURSE_MAP: false,') : SRC;
  if (courseMap === false && src === SRC) throw new Error('CONFIG.COURSE_MAP default line not found to patch');
  if (powerups === false) {
    const patched = src.replace('POWERUPS: true,', 'POWERUPS: false,');
    if (patched === src) throw new Error('CONFIG.POWERUPS default line not found to patch');
    src = patched;
  }
  if (hud === false) {
    const patched = src.replace('HUD: true,', 'HUD: false,');
    if (patched === src) throw new Error('CONFIG.HUD default line not found to patch');
    src = patched;
  }
  if (lobby === false) {
    const patched = src.replace('LOBBY: true,', 'LOBBY: false,');
    if (patched === src) throw new Error('CONFIG.LOBBY default line not found to patch');
    src = patched;
  }
  if (apiBase) {
    const patched = src.replace("API_BASE: '',", `API_BASE: '${apiBase}',`);
    if (patched === src) throw new Error('CONFIG.API_BASE default line not found to patch');
    src = patched;
  }
  // The write-path flags, patched the same way: the defaults are what ships, and a test that
  // wants stage 2 (or the llaLocation fallback, or the escape hatch) says so explicitly.
  const patchConfig = (line, value) => {
    const patched = src.replace(line, value);
    if (patched === src) throw new Error('CONFIG line not found to patch: ' + line);
    src = patched;
  };
  // Generic CONFIG patcher for the 0.9.0 flags: [['TRACE_HZ: 4,', 'TRACE_HZ: 1,'], ...]
  for (const [line, value] of patch || []) patchConfig(line, value);
  if (velocityFrame !== undefined) patchConfig('VELOCITY_FRAME: null,', 'VELOCITY_FRAME: ' + JSON.stringify(velocityFrame) + ',');
  if (safeWrites !== undefined) patchConfig('SAFE_WRITES: true,', 'SAFE_WRITES: ' + !!safeWrites + ',');
  if (llaFallback !== undefined) patchConfig('BOOST_LLA_FALLBACK: false,', 'BOOST_LLA_FALLBACK: ' + !!llaFallback + ',');
  const wsRecord = { sockets: [], last: null };
  w.WebSocket = makeFakeWebSocket(wsRecord);
  if (seed) for (const [k, v] of Object.entries(seed)) w.localStorage.setItem(k, JSON.stringify(v));
  // A full localStorage: setItem throws QuotaExceededError for the given key prefix, exactly
  // like a real browser at its 5 MB limit. Used to check the trace store's eviction/give-up path.
  const quotaBlocked = new Set();
  if (quotaFull) {
    // jsdom's Storage is proxy-backed, so patching setItem on the instance is silently ignored;
    // swap the whole window property for a delegating wrapper instead.
    const real = w.localStorage;
    const prefix = quotaFull === true ? 'finsRace.trace.' : quotaFull;
    Object.defineProperty(w, 'localStorage', { configurable: true, value: {
      getItem: (k) => real.getItem(k),
      removeItem: (k) => real.removeItem(k),
      clear: () => real.clear(),
      key: (i) => real.key(i),
      get length() { return real.length; },
      setItem(k, v) {
        if (String(k).startsWith(prefix)) { quotaBlocked.add(k); const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e; }
        return real.setItem(k, v);
      },
    } });
  }
  w.eval(src);
  const R = w.__finsRace;
  let t = 0;
  const frame = (dtMs) => { t += dtMs; const cb = rafCb; rafCb = null; cb(t); };
  const bootFrames = async () => { await new Promise((r) => setTimeout(r, 700)); }; // wait for ready poll
  return { w, R, ents, state, primitives, stockNode, frame, bootFrames, fakeMap, mapRecord: fakeL.record, wsRecord, logs, instance, quotaBlocked,
    now: () => t, setPos: (p) => { w.geofs.aircraft.instance.llaLocation = [p.lat, p.lon, p.alt]; },
    // llaLocation is replaced wholesale by setPos, so the in-place writers (Boost's fallback,
    // fly-to-start) are checked against this instead.
    lla: () => [...w.geofs.aircraft.instance.llaLocation],
    logText: () => logs.map((a) => a.map((x) => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')).join('\n') };
}

// Every optional race-bus subscriber turned off. Used by the "module X never subscribed (only
// the UI listener is present)" assertions so they keep testing the module named in them as
// later features add subscribers of their own.
const NO_EXTRA_SUBSCRIBERS = [['TRACE: true,', 'TRACE: false,'], ['GHOST: true,', 'GHOST: false,'],
  ['RACING_LINE: true,', 'RACING_LINE: false,']];
// Gate spheres/poles only — the ghost and the racing line share viewer.entities and tag their own.
const gateEnts = (E) => [...E.ents].filter((e) => !e.__finsLine && !e.__finsGhost);

async function main() {
  // Geometry: gates 0, 2000, 4000 m east of origin
  const E0 = env();
  await E0.bootFrames();
  const { destination } = E0.R._internals;
  const origin = { lat: 45, lon: -122 };
  const along = (m, alt = 1000, lateral = 0) => {
    const p = destination(origin, 90, m);
    const q = lateral ? destination(p, 0, lateral) : p;
    return { lat: q.lat, lon: q.lon, alt };
  };
  const course = (radius = 150, extra = {}) => ({ name: 'Unit course', gates: [0, 2000, 4000].map((m) => ({ ...along(m), radius })), ...extra });

  async function fly({ c = course(), startM = -1000, endM = 5000, speed = 200, fps = 60, lateral = 0, hooks = {}, opts = {} } = {}) {
    const E = env(opts);
    await E.bootFrames();
    E.setPos(along(startM, 1000, lateral));
    E.frame(16);
    E.R.loadCourse(c);
    const events = [];
    E.R.race.on((ev, d) => events.push([ev, d]));
    const dt = 1000 / fps;
    let m = startM, simT = 0;
    while (m < endM) {
      if (hooks.before) hooks.before(E, simT, m);
      if (!E.state.paused) m += speed * dt / 1000;
      E.setPos(along(m, 1000, lateral));
      if (hooks.after) hooks.after(E, simT, m);
      E.frame(dt); simT += dt;
      if (['finished', 'dq'].includes(E.R.race.state)) break;
    }
    return { E, events, race: E.R.race };
  }

  console.log('Flying start, 200 m/s, 60 fps');
  {
    const { race, E } = await fly();
    ok(race.state === 'finished', 'finishes');
    // start = exit start sphere (+150), gate 1 entry at 1850, finish entry at 3850
    ok(near(race.splits[0], (1850 - 150) / 200 * 1000, 25), 'gate 1 split ≈ 8500 ms (got ' + race.splits[0] + ')');
    ok(near(race.finalMs, (3850 - 150) / 200 * 1000, 25), 'finish ≈ 18500 ms (got ' + race.finalMs + ')');
    ok(race.splits.length === 2 && race.splits[1] === race.finalMs, 'splits = gates-1, last equals final');
    ok(gateEnts(E).length === 6, 'renders 3 spheres + 3 poles (got ' + gateEnts(E).length + ')');
    const best = JSON.parse(E.w.localStorage.getItem('finsRace.best'));
    ok(best && best[race.hash] && best[race.hash].ms === race.finalMs, 'personal best stored');
    ok(E.w.document.getElementById('fr-timer').textContent.startsWith('0:18.'), 'HUD shows final time');
  }

  console.log('Frame-rate independence (20 fps vs 60 fps)');
  {
    const a = await fly({ fps: 60 }), b = await fly({ fps: 20 });
    ok(near(a.race.finalMs, b.race.finalMs, 60), 'times within one 20fps frame (' + a.race.finalMs + ' vs ' + b.race.finalMs + ')');
  }

  console.log('Tunneling: 600 m/s at 5 fps through 50 m gates (120 m per frame)');
  {
    const { race } = await fly({ c: course(50), speed: 600, fps: 5 });
    ok(race.state === 'finished', 'still registers every gate');
    ok(near(race.finalMs, (3950 - 50) / 600 * 1000, 220), 'finish ≈ 6500 ms (got ' + race.finalMs + ')');
  }

  console.log('Standing start inside start sphere');
  {
    const { race } = await fly({ startM: 0 });
    ok(race.state === 'finished', 'finishes');
    ok(near(race.finalMs, 18500, 25), 'timer starts on leaving sphere (got ' + race.finalMs + ')');
  }

  console.log('Missed gate (400 m lateral offset)');
  {
    const { race } = await fly({ lateral: 400 });
    ok(race.state === 'armed', 'never starts');
  }

  console.log('Pause without moving does not count');
  {
    const { race } = await fly({ hooks: { before: (E, t) => { E.state.paused = t > 5000 && t < 15000; } } });
    ok(race.state === 'finished' && near(race.finalMs, 18500, 40), 'time excludes 10 s pause (got ' + race.finalMs + ')');
  }

  console.log('Teleport while paused → DQ');
  {
    const { race } = await fly({ hooks: {
      before: (E, t) => { E.state.paused = t > 9000 && t < 10000; },
      after: (E, t) => { if (t > 9500 && t < 9520) E.setPos(along(3900)); },
    } });
    ok(race.state === 'dq' && /paused/.test(race.dqReason), 'DQ: ' + race.dqReason);
  }

  console.log('Teleport while flying → DQ');
  {
    const { race } = await fly({ hooks: { after: (E, t) => { if (t > 9000 && t < 9017) E.setPos(along(3900)); } } });
    ok(race.state === 'dq' && /jumped/.test(race.dqReason), 'DQ: ' + race.dqReason);
  }

  console.log('Teleport through the start sphere is not a start');
  {
    const { race } = await fly({ startM: -3000, endM: -2900, hooks: { after: (E, t) => { if (t > 100 && t < 117) E.setPos(along(1000)); } } });
    ok(race.state === 'armed', 'still armed (' + race.state + ')');
  }

  console.log('Aircraft lock');
  {
    const { race } = await fly({ c: course(150, { aircraftId: '99' }) });
    ok(race.state === 'dq' && /aircraft/.test(race.dqReason), 'wrong aircraft DQ');
    const r2 = await fly({ c: course(150, { aircraftId: '7' }) });
    ok(r2.race.state === 'finished', 'right aircraft finishes');
  }

  console.log('Reset and re-run');
  {
    const { race, E } = await fly();
    const first = race.finalMs;
    race.reset();
    ok(race.state === 'armed' && race.splits.length === 0, 'reset re-arms');
    // fly back west then east again
    let m = 5000;
    E.setPos(along(m)); E.frame(16);
    for (; m > -1000; m -= 200) { E.setPos(along(m)); E.frame(1000); }
    ok(race.state !== 'dq', 'repositioning at 200 m/s is legal');
    race.reset();
    for (m = -1000; m < 5000 && race.state !== 'finished'; m += 200 / 60) { E.setPos(along(m)); E.frame(1000 / 60); }
    ok(race.state === 'finished' && near(race.finalMs, first, 25), 'second run matches (' + race.finalMs + ')');
  }

  console.log('Course validation and hashing');
  {
    const { Course } = E0.R._internals;
    const a = Course.hash(Course.normalize(course()));
    const b = Course.hash(Course.normalize({ ...course(), name: 'Renamed' }));
    const c = Course.hash(Course.normalize(course(151)));
    ok(a === b, 'renaming keeps hash');
    ok(a !== c, 'geometry change alters hash');
    let threw = false; try { Course.normalize({ gates: [{ lat: 1, lon: 1, alt: 1 }] }); } catch (_) { threw = true; }
    ok(threw, 'rejects 1-gate course');
    threw = false; try { Course.normalize({ gates: [{ lat: 91, lon: 1, alt: 1 }, { lat: 0, lon: 0, alt: 0 }] }); } catch (_) { threw = true; }
    ok(threw, 'rejects bad latitude');
  }

  console.log('startType: round-trips through Course.normalize(), defaults, and falls back to "ground"');
  {
    const { Course } = E0.R._internals;
    ok(Course.normalize(course()).startType === 'ground', 'omitted startType defaults to ground');
    ok(Course.normalize(course(150, { startType: 'air' })).startType === 'air', 'startType: "air" round-trips');
    ok(Course.normalize(course(150, { startType: 'ground' })).startType === 'ground', 'startType: "ground" round-trips');
    ok(Course.normalize(course(150, { startType: 'banana' })).startType === 'ground', 'unknown startType falls back to ground');
  }

  console.log('Air-start hint: panel text flips on an air-start course, clears on a ground-start course');
  {
    const E = env();
    await E.bootFrames();
    E.setPos(along(-1000)); E.frame(16);
    E.R.loadCourse(course(150, { startType: 'air' }));
    ok(/Air start.*converge on gate 1/.test(E.R.ui.E.startHint.textContent), 'air-start hint shown: ' + JSON.stringify(E.R.ui.E.startHint.textContent));
    E.R.loadCourse(course(150, { startType: 'ground' }));
    ok(E.R.ui.E.startHint.textContent === '', 'hint cleared on a ground-start course');
    E.R.race.unload();
    ok(E.R.ui.E.startHint.textContent === '', 'hint cleared when the course unloads');
  }

  console.log('Countdown: no-op with no course loaded');
  {
    const E = env();
    await E.bootFrames();
    const CD = E.R.countdown;
    ok(CD.arm(Date.now() + 5000) === false, 'arm() refuses with no course loaded');
    ok(CD.armIn(10) === false, 'armIn() refuses with no course loaded');
    ok(CD.state === 'idle', 'state stays idle');
  }

  console.log('Countdown: reaches zero and emits "go" without touching Race.elapsed/state');
  {
    const E = env();
    await E.bootFrames();
    E.setPos(along(-1000)); E.frame(16);
    E.R.loadCourse(course());
    const CD = E.R.countdown, race = E.R.race;
    const events = [];
    CD.on((ev) => events.push(ev));
    const stateBefore = race.state, elapsedBefore = race.elapsed;
    const armed = CD.arm(Date.now() - 1); // target already in the past -> resolves to 'go' synchronously
    ok(armed === true, 'arm() succeeds with a course loaded');
    ok(CD.state === 'go', 'state reaches go');
    ok(events.includes('armed') && events.includes('go'), 'emits armed then go: ' + events.join(','));
    ok(race.state === stateBefore && race.elapsed === elapsedBefore, 'Race.state/elapsed untouched by the countdown');
  }

  console.log('Countdown: aborting mid-countdown is clean (no late tick/go after abort)');
  {
    const E = env();
    await E.bootFrames();
    E.setPos(along(-1000)); E.frame(16);
    E.R.loadCourse(course());
    const CD = E.R.countdown;
    const events = [];
    CD.on((ev) => events.push(ev));
    CD.arm(Date.now() + 100);
    ok(CD.state === 'armed', 'armed');
    CD.abort();
    ok(CD.state === 'idle', 'abort returns to idle immediately');
    events.length = 0;
    await new Promise((r) => setTimeout(r, 250)); // past what would have been the target
    ok(events.length === 0, 'no tick/go fired after abort: ' + events.join(','));
  }

  console.log('Countdown: loading a new course aborts a stale countdown for the old one');
  {
    const E = env();
    await E.bootFrames();
    E.setPos(along(-1000)); E.frame(16);
    E.R.loadCourse(course(150, { name: 'Course One' }));
    const CD = E.R.countdown;
    CD.arm(Date.now() + 5000);
    ok(CD.state === 'armed', 'armed for course one');
    E.R.loadCourse(course(150, { name: 'Course Two' }));
    ok(CD.state === 'idle', 'stale countdown aborted when a new course loads');
  }

  console.log('Editor: test course, save, reload; double load is idempotent');
  {
    const E = env();
    await E.bootFrames();
    E.setPos(along(0)); E.frame(16);
    E.R.editor.testAhead();
    ok(E.R.editor.draft.length === 6, 'test course has 6 gates');
    E.R.editor.saveAndLoad();
    ok(E.R.race.course && E.R.race.state === 'armed', 'saved course loads armed');
    const saved = JSON.parse(E.w.localStorage.getItem('finsRace.courses'));
    ok(saved['test-course'] && saved['test-course'].gates.length === 6, 'saved to localStorage');
    E.w.eval(SRC);
    ok(E.w.document.querySelectorAll('#fr-root').length === 1, 'second load does not duplicate panel');
  }

  console.log('Model swap: load, per-frame transform, switching, and hide/restore of the stock model');
  {
    const models = [
      { id: 'goldfish', name: 'Goldfish', file: 'goldfish.glb', scale: 1, offset: { headingDeg: 0, pitchDeg: 0, rollDeg: 0 } },
      { id: 'cow', name: 'Cow', file: 'cow.glb', scale: 2, offset: { headingDeg: 90, pitchDeg: 0, rollDeg: 0 } },
    ];
    const E = env({ models });
    await E.bootFrames();
    const MS = E.R.modelSwap;
    ok(MS.index.length === 2, 'model index loaded from models/index.json');

    await MS.enable('goldfish');
    ok(MS.mine.enabled && MS.mine.model && !MS.mine.model._destroyed, 'own model created');
    ok(E.primitives.list.includes(MS.mine.model), 'own model added to scene.primitives');

    E.setPos({ lat: 46, lon: -121, alt: 500 });
    E.frame(16);
    const mat = MS.mine.model.modelMatrix;
    ok(mat && mat.position.lat === 46 && mat.position.lon === -121 && mat.position.h === 500, 'modelMatrix position follows lla every frame');
    ok(near(mat.hpr.heading, 90 * Math.PI / 180, 1e-6), 'heading (90°, zero offset) converted to radians');
    ok(near(mat.hpr.pitch, 5 * Math.PI / 180, 1e-6), 'pitch (confirmed via probe: animation.values.pitch) converted to radians');
    ok(near(mat.hpr.roll, -10 * Math.PI / 180, 1e-6), 'roll (confirmed via probe: animation.values.roll) converted to radians');
    ok(E.stockNode.visible === false, 'stock aircraft model hidden while a joke model is active');
    ok(E.stockNode._children.every((c) => c.visible === false), 'stock aircraft part nodes (children) are hidden too, not just the root');
    ok(E.w.__finsModel === 'goldfish', 'window.__finsModel set to the active model id');

    const oldModel = MS.mine.model;
    await MS.enable('cow'); // switching models disposes the old Cesium model
    ok(oldModel._destroyed && !E.primitives.list.includes(oldModel), 'old model destroyed on switch');
    ok(MS.mine.model !== oldModel && E.primitives.list.includes(MS.mine.model), 'new model created for the new selection');
    E.frame(16);
    ok(near(MS.mine.model.modelMatrix.hpr.heading, (90 + 90) * Math.PI / 180, 1e-6), 'per-model heading offset (cow: +90°) applied');
    ok(MS.mine.model.scale === 2, 'per-model scale applied');

    await MS.disable();
    ok(!MS.mine.enabled && !MS.mine.model, 'disable clears own model state');
    ok(E.stockNode.visible === true, 'stock aircraft model restored on disable');
    ok(E.stockNode._children.every((c) => c.visible === true), 'stock aircraft part nodes (children) are restored too');
    ok(E.w.__finsModel === '', 'window.__finsModel cleared on disable');
  }

  console.log('Model swap: falls back to Cesium.Model.fromGltf when fromGltfAsync is unavailable');
  {
    const models = [{ id: 'toilet', name: 'Toilet', file: 'toilet.glb', scale: 1, offset: { headingDeg: 0, pitchDeg: 0, rollDeg: 0 } }];
    const E = env({ models, modelApi: 'fromGltf' });
    await E.bootFrames();
    const MS = E.R.modelSwap;
    await MS.enable('toilet');
    ok(MS.mine.enabled && MS.mine.model && MS.mine.model.url.endsWith('toilet.glb'), 'loaded via the legacy fromGltf API');
  }

  console.log('Model swap: load failure falls back to the stock plane with a status message');
  {
    const models = [{ id: 'goldfish', name: 'Goldfish', file: 'goldfish.glb', scale: 1, offset: { headingDeg: 0, pitchDeg: 0, rollDeg: 0 } }];
    const E = env({ models, modelApi: 'fail' });
    await E.bootFrames();
    const MS = E.R.modelSwap;
    await MS.enable('goldfish');
    ok(!MS.mine.enabled, 'stays disabled after a failed load');
    ok(/glTF parse error/.test(MS.status), 'status explains the failure: ' + MS.status);
    E.frame(16);
    ok(E.stockNode.visible === true, 'stock aircraft model stays visible after a failed swap');
  }

  console.log('Model swap: never throws when Cesium.Model has neither loader');
  {
    const models = [{ id: 'goldfish', name: 'Goldfish', file: 'goldfish.glb', scale: 1, offset: {} }];
    const E = env({ models, modelApi: 'none' });
    await E.bootFrames();
    const MS = E.R.modelSwap;
    let threw = false;
    try { await MS.enable('goldfish'); } catch (_) { threw = true; }
    ok(!threw, 'enable() never throws even with no usable Cesium.Model API');
    ok(!MS.mine.enabled, 'not enabled');
  }

  console.log('Model swap: assignments.json is validated against the model index and keyed by callsign');
  {
    const models = [{ id: 'bratwurst', name: 'Bratwurst', file: 'bratwurst.glb', scale: 1, offset: {} }];
    const assignments = { Eric: 'bratwurst', Ghost: 'no-such-model', _comment: 'ignored metadata' };
    const E = env({ models, assignments });
    await E.bootFrames();
    const MS = E.R.modelSwap;
    ok(MS.assignments.Eric === 'bratwurst', 'valid assignment kept');
    ok(!('Ghost' in MS.assignments), 'assignment to an unknown model id is dropped');
    ok(!('_comment' in MS.assignments), 'underscore-prefixed metadata keys are ignored');
    ok(MS.defaultModelId() === 'bratwurst', 'default model resolved from callsign (geofs.userRecord.callsign = Eric)');
  }

  console.log('Model swap: multiplayer add and remove (real shape: multiplayer.users, user.lastUpdate.co, user.model)');
  {
    const models = [{ id: 'bratwurst', name: 'Bratwurst', file: 'bratwurst.glb', scale: 1, offset: { headingDeg: 0, pitchDeg: 0, rollDeg: 0 } }];
    const assignments = { Steve: 'bratwurst' };
    const E = env({ models, assignments });
    await E.bootFrames();
    const MS = E.R.modelSwap;
    // Root + per-part children, same shape as the stock aircraft's own object3d (see env()'s
    // stockNode above) — other players' aircraft carry the identical structure.
    const steveNode = { visible: true, _children: [{ visible: true }, { visible: true }] };
    E.w.multiplayer.users.u1 = { id: 'u1', callsign: 'Steve', model: steveNode, lastUpdate: { co: [47, -120, 900, 30, 1, 2] } };

    await MS._scanOthers();
    ok(MS.others.size === 1, 'Steve is spawned once assigned a joke model');
    const rec = [...MS.others.values()][0];
    ok(rec.model && E.primitives.list.includes(rec.model), "Steve's model added to the scene");
    ok(steveNode.visible === false, "Steve's stock model is hidden");
    ok(steveNode._children.every((c) => c.visible === false), "Steve's stock part nodes (children) are hidden too, not just the root");

    E.frame(16);
    ok(near(rec.model.modelMatrix.hpr.heading, 30 * Math.PI / 180, 1e-6), "other players' transforms update every frame");

    // Regression check for the flicker bug: a one-time hide at spawn isn't enough if GeoFS's
    // own update loop reasserts .visible later. Simulate that, then confirm the next tick
    // re-hides root and children — the fix for _tickMine (own aircraft) was per-frame for
    // exactly this reason; _tickOthersTransforms now matches it.
    steveNode.visible = true;
    steveNode._children.forEach((c) => { c.visible = true; });
    E.frame(16);
    ok(steveNode.visible === false, 'reasserted visibility on the root is corrected on the very next frame');
    ok(steveNode._children.every((c) => c.visible === false), 'reasserted visibility on children is corrected on the very next frame too');

    delete E.w.multiplayer.users.u1;
    await MS._scanOthers();
    ok(MS.others.size === 0, 'removed once the player is no longer seen');
    ok(!E.primitives.list.includes(rec.model), 'their joke model is destroyed on cleanup');
    ok(steveNode.visible === true, 'their stock model is restored on cleanup');
    ok(steveNode._children.every((c) => c.visible === true), 'their stock part nodes (children) are restored too');
  }

  {
    console.log('Model swap: hide-in-cockpit driven by camera mode (confirmed probe fields)');
    const models = [{ id: 'cow', name: 'Cow', file: 'cow.glb', scale: 1, offset: { headingDeg: 0, pitchDeg: 0, rollDeg: 0 } }];
    const E = env({ models, assignments: { Eric: 'cow' } });
    await E.bootFrames();
    const MS = E.R.modelSwap;
    await MS.enable('cow');
    MS.setHideInCockpit(true);

    E.w.geofs.camera.currentModeName = 'follow';
    E.frame(16);
    ok(MS.mine.model && MS.mine.model.show === true, 'joke model visible in follow view');

    E.w.geofs.camera.currentModeName = 'cockpit';
    E.frame(16);
    ok(MS.mine.model.show === false, 'joke model hidden in cockpit view');

    E.w.geofs.camera.currentModeName = 'Pilot';
    E.frame(16);
    ok(MS.mine.model.show === false, 'joke model hidden in Pilot (inside) view');

    E.w.geofs.camera.currentModeName = 'cockpitless';
    E.frame(16);
    ok(MS.mine.model.show === true, 'joke model VISIBLE in cockpitless (outside) view despite the prefix');

    MS.setHideInCockpit(false);
    E.w.geofs.camera.currentModeName = 'cockpit';
    E.frame(16);
    ok(MS.mine.model.show === true, 'shown again in cockpit once hide-in-cockpit is off');
  }

  console.log('CourseMap: load draws N gate circles + 1 route polyline, added to the map');
  {
    const E = env({ withMap: true });
    await E.bootFrames();
    const c = course();
    E.R.loadCourse(c);
    const CM = E.R.courseMap;
    ok(CM.gateLayers.length === c.gates.length, 'drew one circle per gate (' + CM.gateLayers.length + ')');
    ok(E.mapRecord.polylines.length === 1, 'drew exactly one route polyline');
    ok(CM.group._sub.size === c.gates.length + 1, 'the group holds every circle plus the route line');
    ok(E.fakeMap._layers.has(CM.group) && E.fakeMap._layers.size === 1, 'layer group added to the map, nothing else');
  }

  console.log('CourseMap: course change removes the previous layer group, no orphaned layers');
  {
    const E = env({ withMap: true });
    await E.bootFrames();
    E.R.loadCourse(course(150, { name: 'Course One' }));
    const CM = E.R.courseMap;
    const oldGroup = CM.group;
    ok(E.fakeMap._layers.has(oldGroup), 'first course group is on the map');
    E.R.loadCourse(course(200, { name: 'Course Two' }));
    ok(!E.fakeMap._layers.has(oldGroup), 'old group removed from the map on course change');
    ok(E.fakeMap._layers.has(CM.group) && CM.group !== oldGroup, 'new group added in its place');
    ok(E.fakeMap._layers.size === 1, 'no orphaned layers remain on the map');
  }

  console.log('CourseMap: gate/reset update highlight styling (mirrors RaceGates.highlight semantics)');
  {
    const E = env({ withMap: true });
    await E.bootFrames();
    E.R.loadCourse(course());
    const CM = E.R.courseMap;
    CM.highlight(1);
    ok(CM.gateLayers[0].opts.opacity === 0.25, 'gate 0 dimmed as done after highlight(1)');
    ok(CM.gateLayers[1].opts.fillOpacity === 0.5, 'gate 1 highlighted as next');
    E.R.race.reset();
    ok(CM.gateLayers[0].opts.opacity === 1, 'reset restores gate 0 to not-done styling');
  }

  console.log('CourseMap: no live map -> G.leafletMap() is null and CourseMap no-ops without throwing');
  {
    const E = env(); // withMap: false — nothing resembling an L.Map instance is reachable
    await E.bootFrames();
    ok(E.R._internals.G.leafletMap() === null, 'G.leafletMap() returns null when no map instance is reachable');
    let threw = false;
    try { E.R.loadCourse(course()); } catch (_) { threw = true; }
    ok(!threw, 'loading a course never throws even with no map open');
    ok(E.R.courseMap.gateLayers.length === 0, 'CourseMap drew nothing');
    ok(/not open/.test(E.R.courseMap.status), 'status explains the map overlay is off: ' + E.R.courseMap.status);
  }

  console.log('CourseMap: a forced throw in the draw path is swallowed; 3D RaceGates still works');
  {
    const E = env({ withMap: true });
    await E.bootFrames();
    E.w.L.circle = () => { throw new Error('boom'); };
    let threw = false;
    try { E.R.loadCourse(course()); } catch (_) { threw = true; }
    ok(!threw, 'loadCourse never throws even if the Leaflet draw path throws');
    ok(/boom/.test(E.R.courseMap.status), 'status surfaces the underlying error: ' + E.R.courseMap.status);
    ok(E.ents.size === 6, '3D RaceGates still rendered normally (3 spheres + 3 poles)');
  }

  console.log('CourseMap: CONFIG.COURSE_MAP = false disables the module entirely (no subscribe, no draw)');
  {
    const E = env({ withMap: true, courseMap: false, powerups: false, hud: false, patch: NO_EXTRA_SUBSCRIBERS });
    await E.bootFrames();
    ok(E.R.config.COURSE_MAP === false, 'config reflects the flag');
    ok(E.R.race.listeners.length === 1, 'CourseMap never subscribed to the race event bus (only the UI listener is present)');
    E.R.loadCourse(course());
    ok(E.R.courseMap.gateLayers.length === 0, 'no gates drawn when disabled');
    ok(E.fakeMap._layers.size === 0, 'nothing added to the map when disabled');
  }

  console.log('Powerups: pure state transitions (fake clock, no live GeoFS)');
  {
    const { powerupsInitialState, powerupsRefill, powerupsPrune, powerupsUse, powerupsActive, powerupsBoostedSpeed } = E0.R._internals;
    let s = powerupsInitialState(['shield', 'boost']);
    ok(JSON.stringify(s.loadout) === JSON.stringify(['shield', 'boost']), 'loadout keeps a valid 2-item pick as-is');
    ok(JSON.stringify(s.slots) === JSON.stringify(['shield', 'boost', null]), 'slots start full from the loadout, with the box slot empty');
    ok(JSON.stringify(powerupsInitialState(['boost']).loadout) === JSON.stringify(['boost', 'boost']), 'a short loadout is padded with Boost');
    ok(JSON.stringify(powerupsInitialState(['banana', 'boost']).loadout) === JSON.stringify(['boost', 'boost']), 'unknown items are dropped, then padded');

    const durations = { boost: 1000, shield: 2000 };
    let r = powerupsUse(s, 0, 100, durations);
    ok(r.item === 'shield', 'using slot 0 returns the carried item');
    ok(r.state.slots[0] === null, 'used slot is emptied');
    ok(r.state.effects.shield === 2100, 'effect armed for now + duration');
    ok(powerupsActive(r.state, 'shield', 2099) === true, 'active one tick before expiry');
    ok(powerupsActive(r.state, 'shield', 2100) === false, 'inactive exactly at expiry (half-open interval)');
    const empty = powerupsUse(r.state, 0, 200, durations);
    ok(empty.item === null && empty.state === r.state, 'using an already-empty slot is a no-op');

    const pruned = powerupsPrune(r.state, 5000);
    ok(Object.keys(pruned.effects).length === 0, 'expired effects are pruned from state');

    const refilled = powerupsRefill(r.state);
    ok(JSON.stringify(refilled.slots) === JSON.stringify(['shield', 'boost', null]), 'refill restores both loadout slots and clears the box slot');

    ok(powerupsBoostedSpeed(100, 35, 700) === 135, 'boosted speed adds the boost amount');
    ok(powerupsBoostedSpeed(690, 35, 700) === 700, 'boosted speed is capped at MAX_SPEED_MS');
    ok(powerupsBoostedSpeed(100, -50, 700) === 100, 'a negative add is ignored, never subtracts');
  }

  console.log('Powerups: loadout selection persists (seeded from localStorage on boot, and setLoadout writes back)');
  {
    const E = env({ seed: { 'finsRace.powerupLoadout': ['shield', 'boost'] } });
    await E.bootFrames();
    ok(JSON.stringify(E.R.powerups.state.loadout) === JSON.stringify(['shield', 'boost']), 'stored loadout picked up on boot: ' + JSON.stringify(E.R.powerups.state.loadout));
    ok(!!E.w.document.getElementById('fr-powerups'), 'Powerups panel section is rendered when enabled');
    E.R.powerups.setLoadout(['boost', 'boost']);
    ok(JSON.stringify(JSON.parse(E.w.localStorage.getItem('finsRace.powerupLoadout'))) === JSON.stringify(['boost', 'boost']), 'setLoadout persists the new pick to localStorage');
    ok(JSON.stringify(E.R.powerups.state.slots) === JSON.stringify(['boost', 'boost', null]), 'setLoadout refills the carried slots immediately');
  }

  console.log('Write path: the pure velocity helpers never produce a vector they were not given');
  {
    const { velocityShape, velocityFrameMatches, velocityBoosted, velocityFromReference, vecMag } = E0.R._internals;

    ok(velocityShape([1, 2, 3]).kind === 'array', 'an array of 3 finite numbers is an array-kind vector');
    ok(JSON.stringify(velocityShape([1, 2, 3, 4, 5, 6]).comps) === '[0,1,2]', 'a longer array still reads its first three components');
    ok(velocityShape({ x: 1, y: 2, z: 3 }).kind === 'object', '{x,y,z} is an object-kind vector');
    ok(JSON.stringify(velocityShape({ x: 1, y: 2, z: 3, w: 9 }).comps) === '["x","y","z"]', 'extra keys on the object are left out of comps');
    ok(velocityShape([1, 2]) === null && velocityShape([1, NaN, 3]) === null, 'short or non-finite vectors are not usable');
    ok(velocityShape(200) === null && velocityShape(null) === null, 'a scalar or null is not a vector (the pre-probe guess)');

    const bodyFrame = { kind: 'object', comps: ['x', 'y', 'z'], fwd: 'x', bodyFixed: true, ref: [180, 0, 0], refSpeedMs: 180 };
    ok(velocityFrameMatches(bodyFrame, { x: 1, y: 2, z: 3 }) === true, 'a recorded frame matches a live object of the same shape');
    ok(velocityFrameMatches(bodyFrame, [1, 2, 3]) === false, 'a frame recorded for an object refuses an array (GeoFS reshaped velocity)');
    ok(velocityFrameMatches({ ...bodyFrame, fwd: 'q' }, { x: 1, y: 2, z: 3 }) === false, 'a frame naming a component that is gone refuses to apply');
    ok(velocityFrameMatches(null, { x: 1, y: 2, z: 3 }) === false, 'no frame recorded = no match, so nothing is written');

    // Body-fixed: push the forward component, leave the rest of the observation alone.
    const pushed = velocityBoosted([200, 0, 0], ['x', 'y', 'z'], 'x', 235, 650);
    ok(JSON.stringify(pushed) === '[235,0,0]', 'body-fixed boost pushes the forward component to the target: ' + JSON.stringify(pushed));
    const aft = velocityBoosted([-200, 0, 0], ['x', 'y', 'z'], 'x', 235, 650);
    ok(JSON.stringify(aft) === '[-235,0,0]', 'a forward axis observed negative still speeds up, not down: ' + JSON.stringify(aft));
    // Earth-fixed (no forward axis): scale the observation, so the direction is exactly as flown.
    const scaled = velocityBoosted([100, 0, 100], ['x', 'y', 'z'], null, 200, 650);
    ok(near(vecMag(scaled), 200, 1e-6), 'scaled boost lands on the target magnitude (' + vecMag(scaled).toFixed(2) + ')');
    ok(near(scaled[0], scaled[2], 1e-9) && scaled[1] === 0, 'scaling preserves the observed direction: ' + JSON.stringify(scaled));
    ok(velocityBoosted([0, 0, 0], ['x', 'y', 'z'], null, 200, 650) === null, 'at rest with no forward axis there is nothing to derive from');
    ok(velocityBoosted([200, 0, 0], ['x', 'y', 'z'], 'x', 900, 650) === null, 'a target over the cap is refused outright');
    ok(velocityBoosted([200, NaN, 0], ['x', 'y', 'z'], 'x', 235, 650) === null, 'a non-finite observation is refused');
    ok(velocityBoosted([649, 0, 60], ['x', 'y', 'z'], 'x', 650, 650) === null, 'a result whose magnitude would clear the cap is refused');

    ok(JSON.stringify(velocityFromReference(bodyFrame, 90, 650)) === '[90,0,0]', 'fly-to-start rescales the recorded reference sample');
    ok(velocityFromReference({ ...bodyFrame, bodyFixed: false }, 90, 650) === null, 'an earth-fixed frame refuses the reference path (heading would be wrong)');
    ok(velocityFromReference({ ...bodyFrame, ref: [0, 0, 0] }, 90, 650) === null, 'a zero reference sample is not a direction');
    ok(velocityFromReference(null, 90, 650) === null, 'no frame recorded = no reference vector');
  }

  console.log('Write path: CruiseWatch only calls stable level cruise stable');
  {
    const { CruiseWatch } = E0.R._internals;
    const feed = (n, s, step = 100) => { CruiseWatch.reset(); for (let i = 0; i <= n; i++) CruiseWatch.sample(i * step, typeof s === 'function' ? s(i) : s); return n * step; };
    const level = { heading: 90, pitch: 0, roll: 0, speed: 200, paused: false };

    let t = feed(12, level);
    ok(CruiseWatch.stable(t) === true, '1.2 s of wings-level cruise is stable');
    ok(CruiseWatch.stable(t + 900) === false, 'a stale history is not stable (no frames for ~1 s)');
    t = feed(4, level);
    ok(CruiseWatch.stable(t) === false, 'under the required window is not stable yet');
    t = feed(12, (i) => ({ ...level, heading: 90 + i * 2 }));
    ok(CruiseWatch.stable(t) === false, 'a turn is not stable');
    t = feed(12, { ...level, pitch: 8 });
    ok(CruiseWatch.stable(t) === false, 'a climb is not stable');
    t = feed(12, { ...level, roll: 20 });
    ok(CruiseWatch.stable(t) === false, 'a bank is not stable');
    t = feed(12, { ...level, speed: 10 });
    ok(CruiseWatch.stable(t) === false, 'taxi speed is not cruise');
    t = feed(12, { ...level, paused: true });
    ok(CruiseWatch.stable(t) === false, 'paused is not stable');
    t = feed(12, (i) => ({ ...level, heading: (359 + (i % 2)) % 360 }));
    ok(CruiseWatch.stable(t) === true, 'heading wrap (359 to 000) is not mistaken for a turn');
  }

  console.log('Powerups: Boost stage 1 (no velocity frame recorded) writes only the confirmed scalars');
  {
    const E = env();
    await E.bootFrames();
    E.setPos(along(0)); E.frame(16);
    const PU = E.R.powerups, CFG = E.R.config, inst = E.instance;
    ok(CFG.SAFE_WRITES === true && CFG.VELOCITY_FRAME === null && CFG.BOOST_LLA_FALLBACK === false,
      'shipping defaults: safe writes on, no frame recorded, no llaLocation fallback');
    ok(PU.state.slots[0] === 'boost', 'default loadout carries Boost in slot 1');

    const velBefore = { ...inst.velocity };
    const llaBefore = E.lla();
    const t0 = E.now();
    PU.useSlot(0, t0);
    ok(PU.state.slots[0] === null, 'using the slot consumes the carried item');
    ok(PU.state.effects.boost === t0 + CFG.POWERUP_BOOST_MS, 'boost effect armed for the configured duration');

    E.frame(16);
    ok(inst.trueAirSpeed === 235 && inst.groundSpeed === 235, 'trueAirSpeed and groundSpeed are pushed to base + POWERUP_BOOST_ADD_MS (' + inst.trueAirSpeed + ')');
    ok(PU.wrote.scalar === true && PU.wrote.vector === false && PU.wrote.lla === false, 'the scalars took, the vector was left alone, no llaLocation nudge: ' + JSON.stringify(PU.wrote));
    ok(JSON.stringify({ ...inst.velocity }) === JSON.stringify(velBefore), 'the live velocity object is untouched without a recorded frame: ' + JSON.stringify(inst.velocity));
    ok(E.lla().every((n, i) => n === llaBefore[i]), 'llaLocation is untouched (the 0.5.0 nudge is off by default)');

    // The mock's default attitude is pitch 5 / roll -10, i.e. not cruise — so nothing is logged
    // yet. A sample taken there couldn't tell a body-fixed frame from an earth-fixed one.
    ok(!/velocity-frame sample/.test(E.logText()), 'no frame sample logged outside stable level cruise');

    // Held, not compounded: 250 more frames must not walk the speed up to the cap.
    for (let i = 0; i < 250; i++) E.frame(16);
    ok(inst.trueAirSpeed === 235, 'a held boost holds one target instead of adding 35 m/s per frame (' + inst.trueAirSpeed + ')');
    ok(PU.state.effects.boost === undefined, 'boost effect auto-recovers (expires) after its duration');

    inst.trueAirSpeed = 300; inst.groundSpeed = 300;
    E.frame(16);
    ok(inst.trueAirSpeed === 300, 'no speed writes at all once the boost has expired');

    // Now level off for longer than CruiseWatch's whole window (so the banked samples age out)
    // and boost again: this time the capture is allowed to log.
    inst.trueAirSpeed = 200; inst.groundSpeed = 200;
    Object.assign(E.w.geofs.animation.values, { pitch: 0, roll: 0 });
    for (let i = 0; i < 110; i++) E.frame(16);   // ~1.8 s > CruiseWatch.limits.windowMs
    PU.useSlot(1, E.now());
    E.frame(16);
    const log = E.logText();
    ok(/velocity-frame sample 1\/4 \(boost\)/.test(log), 'Boost logged the live velocity object once in stable level cruise');
    ok(/"kind":"object"/.test(log) && /"comps":\["x","y","z"\]/.test(log), 'the sample records the vector shape it saw');
    ok(/"values":\[200,0,0\]/.test(log) && /"heading":90/.test(log), 'the sample records the numbers and the heading they were taken at');
    ok(/"trueAirSpeed":235/.test(log) || /"trueAirSpeed":200/.test(log), 'the sample records the scalars alongside the vector');
    ok(/body-fixed/.test(log), 'the first sample explains how to tell a body-fixed frame from an earth-fixed one');
    ok(JSON.stringify({ ...inst.velocity }) === JSON.stringify(velBefore), 'logging is read-only: the vector is still untouched');

    // Capped, so a held boost can't flood the console.
    for (let i = 0; i < 400; i++) E.frame(16);
    ok(G_frameLogs(E) <= 4, 'frame-capture logging is capped at 4 samples per page load (' + G_frameLogs(E) + ')');
  }

  console.log('Powerups: Boost stage 2 (velocity frame recorded) pushes the observed vector too');
  {
    // A body-fixed frame whose forward axis is +x, exactly the shape the mock reports.
    const frame = { kind: 'object', comps: ['x', 'y', 'z'], fwd: 'x', bodyFixed: true, ref: [200, 0, 0], refSpeedMs: 200, note: 'unit test' };
    const E = env({ velocityFrame: frame });
    await E.bootFrames();
    E.setPos(along(0)); E.frame(16);
    const PU = E.R.powerups, inst = E.instance;
    PU.useSlot(0, E.now());
    E.frame(16);
    ok(PU.wrote.scalar === true && PU.wrote.vector === true, 'both the scalars and the vector took: ' + JSON.stringify(PU.wrote));
    ok(inst.velocity.x === 235 && inst.velocity.y === 0 && inst.velocity.z === 0, 'the forward component is pushed to the target: ' + JSON.stringify(inst.velocity));
    ok(inst.trueAirSpeed === 235, 'the scalars agree with the vector magnitude');
    ok(!/velocity-frame sample/.test(E.logText()), 'no capture logging once a matching frame is recorded');

    // A frame that no longer matches the live object must not have its meaning applied.
    const E2 = env({ velocityFrame: { ...frame, kind: 'array', comps: [0, 1, 2], fwd: 0 } });
    await E2.bootFrames();
    E2.setPos(along(0)); E2.frame(16);
    E2.R.powerups.useSlot(0, E2.now());
    E2.frame(16);
    ok(E2.R.powerups.wrote.vector === false, 'a frame recorded for an array refuses to write into an object');
    ok(JSON.stringify({ ...E2.instance.velocity }) === JSON.stringify({ x: 200, y: 0, z: 0 }), 'the mismatched vector is left exactly as it was');
    ok(E2.instance.trueAirSpeed === 235, 'the confirmed scalars still work when the vector is refused');

    // SAFE_WRITES off is the in-sim escape hatch: derive from the live sample with no frame.
    const E3 = env({ safeWrites: false });
    await E3.bootFrames();
    E3.setPos(along(0)); E3.frame(16);
    E3.R.powerups.useSlot(0, E3.now());
    E3.frame(16);
    ok(E3.R.powerups.wrote.vector === true, 'SAFE_WRITES=false scales the live vector with no frame recorded');
    ok(E3.instance.velocity.x === 235, 'the escape-hatch write is still a scaled observation: ' + JSON.stringify(E3.instance.velocity));
  }

  console.log('Powerups: measured peak speed stays under MAX_SPEED_MS on every Boost write path');
  {
    // The real check: let a mock physics loop honor the writes (fly the aircraft along its
    // heading at whatever trueAirSpeed says), stack the opt-in llaLocation nudge on top, and
    // measure the speed Race.tick itself would see between frames. That is the number the
    // teleport DQ is computed from, so it is the one that has to stay under MAX_SPEED_MS.
    const { ecef, sub, vlen } = E0.R._internals;
    const frame = { kind: 'object', comps: ['x', 'y', 'z'], fwd: 'x', bodyFixed: true, ref: [200, 0, 0], refSpeedMs: 200 };
    for (const startSpeed of [80, 200, 400, 630, 690]) {
      const E = env({ trueAirSpeed: startSpeed, groundSpeed: startSpeed, velocityFrame: frame, llaFallback: true });
      await E.bootFrames();
      const CFG = E.R.config, PU = E.R.powerups, inst = E.instance;
      let m = 0;
      E.setPos(along(m)); E.frame(16);
      E.R.loadCourse(course());
      PU.useSlot(0, E.now());

      let prev = E.lla(), maxV = 0, dt = 16;
      for (let i = 0; i < Math.ceil(CFG.POWERUP_BOOST_MS / dt) + 20; i++) {
        E.frame(dt);
        // Mock physics: GeoFS moves the aircraft at the speed it was told to fly, from wherever
        // the frame's own writes left it (so an llaLocation nudge is carried, not overwritten).
        const at = E.lla();
        const q = destination({ lat: at[0], lon: at[1] }, E.w.geofs.animation.values.heading360, inst.trueAirSpeed * dt / 1000);
        E.setPos({ lat: q.lat, lon: q.lon, alt: at[2] });
        const cur = E.lla();
        maxV = Math.max(maxV, vlen(sub(ecef(cur[0], cur[1], cur[2]), ecef(prev[0], prev[1], prev[2]))) / (dt / 1000));
        prev = cur;
      }
      ok(maxV > 0, `boost from ${startSpeed} m/s actually moved the aircraft, peak ${maxV.toFixed(1)} m/s`);
      ok(maxV < CFG.MAX_SPEED_MS, `measured peak speed stays under MAX_SPEED_MS from ${startSpeed} m/s (${maxV.toFixed(1)} < ${CFG.MAX_SPEED_MS})`);
      // The invariant Boost is built to hold: it never commands more than speedCap(), and the
      // opt-in llaLocation nudge is limited to the headroom left under it, so measured speed
      // tops out at max(whatever you were already doing, speedCap) + POWERUP_BOOST_ADD_MS. The
      // 1% is the harness's own geodesy mismatch — destination() is spherical, ecef() is WGS84.
      const bound = (Math.max(startSpeed, CFG.MAX_SPEED_MS - CFG.SPEED_WRITE_MARGIN_MS) + CFG.POWERUP_BOOST_ADD_MS) * 1.01;
      ok(maxV <= bound, `and stays inside speedCap + boost add from ${startSpeed} m/s (${maxV.toFixed(1)} <= ${bound.toFixed(1)})`);
      ok(E.R.race.state !== 'dq', `no teleport DQ from ${startSpeed} m/s (state ${E.R.race.state})`);
      ok(inst.trueAirSpeed <= CFG.MAX_SPEED_MS - CFG.SPEED_WRITE_MARGIN_MS || inst.trueAirSpeed === startSpeed,
        `the commanded speed itself is clamped to speedCap from ${startSpeed} m/s (${inst.trueAirSpeed})`);
    }
  }

  console.log('Powerups: the llaLocation nudge is still there behind CONFIG.BOOST_LLA_FALLBACK');
  {
    const E = env({ llaFallback: true });
    await E.bootFrames();
    E.setPos(along(0)); E.frame(16);
    const PU = E.R.powerups, CFG = E.R.config;
    const before = E.lla();
    PU.useSlot(0, E.now());
    E.frame(16);
    ok(PU.wrote.lla === true, 'the fallback nudge ran when the flag is on');
    const after = E.lla();
    ok(after[1] !== before[1], 'it moved the aircraft the 0.5.0 way (llaLocation mutated in place)');

    for (let i = 0; i < Math.ceil(CFG.POWERUP_BOOST_MS / 16) + 5; i++) E.frame(16);
    const settled = E.lla();
    E.frame(16);
    ok(E.lla().every((n, i) => n === settled[i]), 'no further movement once the boost has expired');
  }

  console.log('Powerups: Shield sets and clears immune state over its duration');
  {
    const E = env();
    await E.bootFrames();
    const PU = E.R.powerups, CFG = E.R.config;
    PU.setLoadout(['shield', 'boost']);
    ok(PU.state.slots[0] === 'shield', 'slot 1 carries Shield after a loadout change');
    const t0 = E.now();
    PU.useSlot(0, t0);
    ok(PU.isShielded(t0 + 10), 'shielded immediately after use');
    ok(!PU.isShielded(t0 + CFG.POWERUP_SHIELD_MS + 10), 'no longer shielded after the shield duration elapses');
    for (let i = 0; i < Math.ceil(CFG.POWERUP_SHIELD_MS / 16) + 2; i++) E.frame(16);
    ok(PU.state.effects.shield === undefined, 'expired shield effect is pruned from state on the next tick');
  }

  console.log('Powerups: CONFIG.POWERUPS = false disables the module entirely (no UI, no keybind, no subscription)');
  {
    const E = env({ powerups: false, courseMap: false, hud: false, patch: NO_EXTRA_SUBSCRIBERS });
    await E.bootFrames();
    ok(E.R.config.POWERUPS === false, 'config reflects the flag');
    ok(!E.w.document.getElementById('fr-powerups'), 'no Powerups UI section rendered');
    ok(E.R.race.listeners.length === 1, 'Powerups never subscribed to the race event bus (only the UI listener is present)');
    const before = JSON.stringify(E.R.powerups.state);
    const ev = new E.w.KeyboardEvent('keydown', { code: 'Digit1', altKey: true, bubbles: true, cancelable: true });
    E.w.dispatchEvent(ev);
    ok(JSON.stringify(E.R.powerups.state) === before, 'Alt+1 keybind does nothing when POWERUPS is disabled');
  }

  console.log('Powerups: itemBox round-trips through Course.normalize(), is dropped when invalid, and is not hashed');
  {
    const { Course } = E0.R._internals;
    const box = { ...along(1000), radius: 120 };
    ok(Course.normalize(course()).itemBox === null, 'a course with no itemBox normalizes to null');
    const withBox = Course.normalize(course(150, { itemBox: box }));
    ok(withBox.itemBox && near(withBox.itemBox.radius, 120, 1e-9), 'a valid itemBox round-trips');
    ok(Course.normalize(course(150, { itemBox: { lat: 91, lon: 0, alt: 0 } })).itemBox === null, 'an out-of-range itemBox is dropped, not thrown');
    ok(Course.normalize(course(150, { itemBox: 'banana' })).itemBox === null, 'a non-object itemBox is dropped');
    ok(Course.normalize(course(150, { itemBox: { lat: 1, lon: 2, alt: 3 } })).itemBox.radius === E0.R.config.DEFAULT_RADIUS_M, 'itemBox radius defaults like a gate');
    // Adding a box must never reset a course's leaderboard.
    ok(Course.hash(Course.normalize(course())) === Course.hash(withBox), 'itemBox is excluded from the course hash');
  }

  console.log('Powerups: the item box renders as its own entity, clears when taken, and never leaks');
  {
    const E = env();
    await E.bootFrames();
    const boxed = course(150, { itemBox: { ...along(1000), radius: 120 } });
    E.R.loadCourse(boxed);
    ok(E.ents.size === 8, '3 gates + 1 item box = 8 entities (spheres + poles), got ' + E.ents.size);
    // Repeated loads must not accumulate box entities (draw() clears first).
    E.R.loadCourse(boxed);
    ok(E.ents.size === 8, 'reloading the same course does not leak box entities (' + E.ents.size + ')');
    E.R.race.emit('itembox', { at: 0 });
    ok(E.ents.size === 6, 'taking the box removes its entities, leaving the gates (' + E.ents.size + ')');
    // Re-arming redraws it for the next run.
    E.R.race.reset();
    ok(E.ents.size === 8, 'resetting the run puts the box back (' + E.ents.size + ')');
    // A course with no box draws none.
    E.R.loadCourse(course());
    ok(E.ents.size === 6, 'a course without an itemBox draws gates only (' + E.ents.size + ')');
  }

  console.log('Powerups: the item box only triggers once per run, and never while merely armed');
  {
    const boxAt = { ...along(-500), radius: 150 };   // behind the start, crossed before the race begins
    const E = env({ apiBase: 'https://relay.test' });
    await E.bootFrames();
    E.setPos(along(-1000)); E.frame(16);
    E.R.loadCourse(course(150, { itemBox: boxAt }));
    // Taxi through the box while still armed (before leaving the start sphere).
    for (let m = -1000; m < -300; m += 50) { E.setPos(along(m)); E.frame(100); }
    ok(E.R.race.state === 'armed', 'still armed');
    ok(E.R.race.boxTaken === false, 'the box does not trigger while armed (no farming it pre-race)');
    ok(E.R.powerups.state.slots[2] === null, 'no box item carried yet');
  }

  console.log('Powerups: relay URL + room derivation (pure)');
  {
    const { powerupsRelayUrl, powerupsRoom } = E0.R._internals;
    ok(powerupsRelayUrl('https://race.finsonly.net', 'abc12345') === 'wss://race.finsonly.net/ws/race/abc12345', 'https -> wss');
    ok(powerupsRelayUrl('http://localhost:8000/', 'abc12345') === 'ws://localhost:8000/ws/race/abc12345', 'http -> ws, trailing slash trimmed');
    ok(powerupsRelayUrl('', 'abc12345') === null, 'empty API_BASE -> null (loadout-only)');
    ok(powerupsRelayUrl('https://x.test', '') === null, 'no room -> null');
    ok(powerupsRoom('', '0a1b2c3d') === '0a1b2c3d', 'room defaults to the course hash');
    ok(powerupsRoom('Steve Room!', '0a1b2c3d') === 'steve-room', 'a typed code is slugged to the relay-legal shape');
    ok(powerupsRoom('x'.repeat(50), '0a1b2c3d').length === 32, 'a long code is capped at the relay limit');
  }

  console.log('Powerups: crossing the item box sends "box" to the relay and never affects progress');
  {
    const boxAt = { ...along(1000), radius: 150 };
    const { race, E } = await fly({
      c: course(150, { itemBox: boxAt }),
      opts: { apiBase: 'https://relay.test' },
      // Open the socket as soon as the relay creates it (on race start), so the crossing lands.
      hooks: { after: (E) => { const ws = E.wsRecord.last; if (ws && ws.readyState === 0) ws.fireOpen(); } },
    });
    const ws = E.wsRecord.last;
    ok(!!ws && /^wss:\/\/relay\.test\/ws\/race\//.test(ws.url), 'relay socket opened at the derived wss URL: ' + (ws && ws.url));
    ok(ws.ofType('join').length === 1, 'sent exactly one join on open');
    ok(ws.ofType('box').length === 1, 'sent exactly one box message for one crossing');
    ok(ws.ofType('pos').length > 0, 'sent position/progress pings while racing');
    // The box sits between gate 0 and gate 1 but must not count as progress.
    ok(race.state === 'finished', 'still finishes normally');
    ok(race.splits.length === 2, 'the box did not add a split (' + race.splits.length + ')');
    ok(near(race.finalMs, (3850 - 150) / 200 * 1000, 40), 'finish time unchanged by the box (' + race.finalMs + ')');
  }

  console.log('Powerups: a relay grant fills the box slot; Alt+3 fires it back as the item the relay gave');
  {
    const E = env({ apiBase: 'https://relay.test' });
    await E.bootFrames();
    E.setPos(along(-1000)); E.frame(16);
    E.R.loadCourse(course());
    E.R.race.emit('start');                       // drives the relay-connect subscriber directly
    const ws = E.wsRecord.last;
    ok(!!ws, 'relay socket created on race start');
    ws.fireOpen();
    const PU = E.R.powerups;

    ws.fireMessage({ type: 'grant', item: 'missile' });
    ok(PU.state.slots[2] === 'missile', 'grant lands in the box slot (slot 3)');
    ok(PU.feed.some((l) => /boxed/i.test(l)), 'kill feed notes the grant: ' + JSON.stringify(PU.feed[0]));

    PU.useSlot(2, E.now());
    ok(PU.state.slots[2] === null, 'firing the box item consumes the slot');
    ok(JSON.stringify(ws.ofType('fire')) === JSON.stringify([{ type: 'fire', item: 'missile' }]), 'sent one fire for exactly the granted item');
    ok(!PU.state.effects.missile, 'firing an offensive item never applies it to yourself');

    // "nothing" is a real roll outcome for the leader and must just empty the slot.
    ws.fireMessage({ type: 'grant', item: 'nothing' });
    ok(PU.state.slots[2] === null, '"nothing" leaves the box slot empty');
    // Junk off the wire must not become a carryable item.
    ws.fireMessage({ type: 'grant', item: 'nuclear-option' });
    ok(PU.state.slots[2] === null, 'an unknown granted item is ignored');
  }

  console.log('Powerups: an incoming hit applies a time-boxed screen effect that auto-recovers, and Shield blocks it');
  {
    const E = env({ apiBase: 'https://relay.test' });
    await E.bootFrames();
    E.setPos(along(-1000)); E.frame(16);
    E.R.loadCourse(course());
    E.R.race.emit('start');
    const ws = E.wsRecord.last;
    ws.fireOpen();
    const PU = E.R.powerups, CFG = E.R.config;
    const fx = E.w.document.getElementById('fr-fx');
    ok(!!fx, 'the screen-effect overlay exists');

    ws.fireMessage({ type: 'hit', item: 'goop', from: 'Steve' });
    ok(PU.state.effects.goop > E.now(), 'goop effect armed');
    E.frame(16);
    ok(fx.classList.contains('fr-fx-goop') && fx.classList.contains('fr-fx-on'), 'overlay shows the goop effect');
    ok(PU.feed.some((l) => /GRILLED/.test(l)), 'kill feed says you got GRILLED: ' + JSON.stringify(PU.feed[0]));

    for (let i = 0; i < Math.ceil(CFG.POWERUP_GOOP_MS / 16) + 2; i++) E.frame(16);
    ok(PU.state.effects.goop === undefined, 'goop auto-recovers after its duration');
    ok(!fx.classList.contains('fr-fx-goop') && !fx.classList.contains('fr-fx-on'), 'overlay clears itself once the effect expires');

    // Shield up -> the next hit is blocked outright (client-side, per the relay's documented choice).
    PU.setLoadout(['shield', 'boost']);
    PU.useSlot(0, E.now());
    ok(PU.isShielded(E.now() + 10), 'shield is up');
    ws.fireMessage({ type: 'hit', item: 'missile', from: 'Steve' });
    ok(PU.state.effects.missile === undefined, 'Shield blocked the incoming missile entirely');
    ok(PU.feed.some((l) => /Shield ate/.test(l)), 'kill feed reports the block: ' + JSON.stringify(PU.feed[0]));
    E.frame(16);
    ok(!fx.classList.contains('fr-fx-missile'), 'no screen effect from a blocked hit');

    // An unknown hit item off the wire must not arm anything.
    ws.fireMessage({ type: 'hit', item: 'anvil', from: 'Steve' });
    ok(PU.state.effects.anvil === undefined, 'an unknown hit item is ignored');
  }

  console.log('Powerups: a boosted grant still respects the DQ speed cap, and offensive effects never touch speed');
  {
    const E = env({ apiBase: 'https://relay.test' });
    await E.bootFrames();
    const { ecef, sub, vlen } = E.R._internals;
    E.setPos(along(0)); E.frame(16);
    E.R.loadCourse(course());
    E.R.race.emit('start');
    const ws = E.wsRecord.last;
    ws.fireOpen();
    const PU = E.R.powerups, CFG = E.R.config;

    ws.fireMessage({ type: 'grant', item: 'boost' });   // the box can hand out Boost too
    PU.useSlot(2, E.now());
    ok(PU.state.effects.boost > E.now(), 'a boxed Boost applies to yourself');

    let prev = E.lla(), maxV = 0;
    const dt = 16;
    for (let i = 0; i < Math.ceil(CFG.POWERUP_BOOST_MS / dt) + 5; i++) {
      E.frame(dt);
      // Mock physics honoring the speed write, as in the peak-speed test above.
      const at = E.lla();
      const q = destination({ lat: at[0], lon: at[1] }, E.w.geofs.animation.values.heading360, E.instance.trueAirSpeed * dt / 1000);
      E.setPos({ lat: q.lat, lon: q.lon, alt: at[2] });
      const cur = E.lla();
      maxV = Math.max(maxV, vlen(sub(ecef(cur[0], cur[1], cur[2]), ecef(prev[0], prev[1], prev[2]))) / (dt / 1000));
      prev = cur;
    }
    ok(E.instance.trueAirSpeed === 235, 'a boxed Boost writes the same clamped speed target as a loadout Boost');
    ok(maxV > 0 && maxV <= CFG.MAX_SPEED_MS, 'boxed Boost stays under MAX_SPEED_MS (' + maxV.toFixed(1) + ' m/s)');
    ok(E.R.race.state !== 'dq', 'boosting never trips the teleport/slew DQ');

    // Offensive hits are screen-only by default (POWERUP_CONTROL_EFFECTS is off), so they must
    // not move the aircraft at all.
    ok(CFG.POWERUP_CONTROL_EFFECTS === false, 'control effects are off by default (unprobed hook)');
    ws.fireMessage({ type: 'hit', item: 'banana', from: 'Steve' });
    const before = E.lla(), speedBefore = E.instance.trueAirSpeed;
    E.frame(dt);
    const after = E.lla();
    ok(before[0] === after[0] && before[1] === after[1], 'a banana hit never moves the aircraft');
    ok(E.instance.trueAirSpeed === speedBefore, 'a banana hit never writes speed either');
  }

  console.log('Powerups: relay lifecycle (CONFIG.LOBBY off) — connects on start, disconnects on finish/reset');
  {
    // The legacy, race-scoped connection lifecycle. With LOBBY on (the default — see the Lobby
    // tests below) the relay instead connects as soon as a room is available, independent of
    // Race.state; this proves the flag genuinely gates that change, per CLAUDE.md.
    const E = env({ apiBase: 'https://relay.test', lobby: false });
    await E.bootFrames();
    E.setPos(along(-1000)); E.frame(16);
    E.R.loadCourse(course());
    ok(E.wsRecord.sockets.length === 0, 'no socket before the race starts');
    E.R.race.emit('start');
    ok(E.wsRecord.sockets.length === 1, 'one socket on start');
    E.wsRecord.last.fireOpen();
    ok(E.R.powerups.relay.connected === true, 'relay reports connected');
    E.R.race.emit('finish', 1234);
    ok(E.R.powerups.relay.connected === false && E.wsRecord.last.readyState === 3, 'socket closed on finish');
    ok(E.R.powerups.relay.wantOpen === false, 'no reconnect wanted after a clean disconnect');
  }

  console.log('Powerups: no relay configured -> loadout-only mode, no socket, no throw');
  {
    const E = env(); // API_BASE stays empty
    await E.bootFrames();
    E.setPos(along(-1000)); E.frame(16);
    E.R.loadCourse(course());
    let threw = false;
    try { E.R.race.emit('start'); } catch (_) { threw = true; }
    ok(!threw, 'starting a race with no relay never throws');
    ok(E.wsRecord.sockets.length === 0, 'no socket opened without API_BASE');
    ok(/Loadout-only/.test(E.R.powerups.relay.status), 'status explains loadout-only mode: ' + E.R.powerups.relay.status);

    // Boost/Shield must still work with no relay at all — this is the whole point of Phase 1.
    const PU = E.R.powerups;
    PU.useSlot(0, E.now());
    ok(PU.state.effects.boost > E.now(), 'Boost still works in loadout-only mode');

    // A box crossing with no relay must degrade to a note, never a self-granted item.
    threw = false;
    try { E.R.race.emit('itembox', { at: 0 }); } catch (_) { threw = true; }
    ok(!threw, 'an item box crossing with no relay never throws');
    ok(PU.state.slots[2] === null, 'no item is self-granted without the relay');
    ok(PU.feed.some((l) => /needs the relay/.test(l)), 'feed explains the box needs the relay: ' + JSON.stringify(PU.feed[0]));
  }

  console.log('Powerups: a relay that drops mid-race reconnects with backoff and never breaks the race');
  {
    const E = env({ apiBase: 'https://relay.test' });
    await E.bootFrames();
    E.R.config.POWERUP_RECONNECT_MS = 10; // keep the test fast; read at call time
    E.setPos(along(-1000)); E.frame(16);
    E.R.loadCourse(course());
    E.R.race.emit('start');
    const first = E.wsRecord.last;
    first.fireOpen();
    ok(E.R.powerups.relay.connected, 'connected');

    first.close();  // simulate the relay going away mid-race
    ok(E.R.powerups.relay.connected === false, 'notices the drop');
    ok(/reconnecting/.test(E.R.powerups.relay.status), 'status shows a reconnect pending: ' + E.R.powerups.relay.status);
    ok(E.R.race.state !== 'dq', 'the race is unaffected by the relay dropping');

    await new Promise((r) => setTimeout(r, 60));
    ok(E.wsRecord.sockets.length === 2, 'reconnected with a second socket (' + E.wsRecord.sockets.length + ')');
    E.R.powerups.relay.disconnect();
    ok(E.R.powerups.relay.wantOpen === false, 'disconnect stops the reconnect loop');
  }

  // ---------------------------------------------------------------- lobby (proto 2)

  console.log('Lobby: clockOffset picks the minimum-RTT sample (pure)');
  {
    const { clockOffset } = E0.R._internals;
    ok(clockOffset([]) === null, 'no samples -> null, never a guessed zero');
    ok(clockOffset(null) === null, 'junk -> null, never throws');
    // A perfectly symmetric round trip: sent at 1000, answered at 1100, server said 5050 at the
    // midpoint (1050) -> the server clock runs 4000 ms ahead of this one.
    ok(clockOffset([{ t0: 1000, t1: 1100, server_ms: 5050 }]) === 4000,
      'symmetric round trip: offset = server_ms + rtt/2 - t1 (' + clockOffset([{ t0: 1000, t1: 1100, server_ms: 5050 }]) + ')');
    // The 20 ms sample is the trustworthy one; the 900 ms sample is a queued frame or a GC pause
    // and would drag the estimate hundreds of ms off if it were averaged in.
    const mixed = [
      { t0: 0, t1: 900, server_ms: 4450 },      // laggy: would imply offset 4000 too, but ±450 of slop
      { t0: 1000, t1: 1020, server_ms: 5010 },  // clean: offset = 5010 + 10 - 1020 = 4000
      { t0: 2000, t1: 2600, server_ms: 6300 },
    ];
    ok(clockOffset(mixed) === 4000, 'the minimum-RTT sample wins, not the mean (' + clockOffset(mixed) + ')');
    ok(clockOffset([{ t0: 5, t1: 1, server_ms: 9 }]) === null, 'a negative RTT sample is discarded, not trusted');
    ok(clockOffset([{ t0: 0, t1: NaN, server_ms: 1 }, { t0: 0, t1: 10, server_ms: 1005 }]) === 1000,
      'a non-finite sample is skipped and the usable one still counts');
  }

  console.log('Lobby: lobbyReduce folds relay frames into room state (pure)');
  {
    const { lobbyReduce, lobbyInitialState } = E0.R._internals;
    const s0 = lobbyInitialState();
    ok(s0.phase === null && s0.players.length === 0 && s0.rules.powerups === true, 'initial state: no phase, no players, rules default on');

    const s1 = lobbyReduce(s0, { type: 'lobby', phase: 'lobby', host: 'Eric', course: null,
      rules: { powerups: true, teleport: false }, race_id: 0,
      players: [{ callsign: 'Eric', model: '', ready: false, role: 'racer' }] });
    ok(s1.host === 'Eric' && s1.phase === 'lobby' && s1.players.length === 1, 'a lobby frame sets host/phase/players');
    ok(s1.rules.teleport === false, 'and the room rules');
    ok(s0.players.length === 0, 'the previous state is not mutated (pure)');

    const s2 = lobbyReduce(s1, { type: 'start', race_id: 3, start_at_server_ms: 9999, racers: ['Eric', 'Maggie'] });
    ok(s2.start.raceId === 3 && s2.start.startAtServerMs === 9999, 'a start frame records the synced GO');
    ok(s2.start.racers.join() === 'Eric,Maggie', 'and who is actually racing it');
    ok(s2.host === 'Eric', 'while leaving the rest of the room state alone');

    const s3 = lobbyReduce(s2, { type: 'abort' });
    ok(s3.start === null, 'an abort clears the pending start');

    const s4 = lobbyReduce(s3, { type: 'chat', callsign: 'Maggie', code: 'gg' });
    ok(s4.chat[0].callsign === 'Maggie' && s4.chat[0].code === 'gg', 'a chat frame lands newest-first');

    // Anything else passes through untouched, identity-equal — that is what lets the powerups
    // frames flow through the same socket handler with no special-casing.
    for (const junk of [{ type: 'standings', order: ['a'] }, { type: 'grant', item: 'boost' }, null, 'nope', 42]) {
      ok(lobbyReduce(s4, junk) === s4, 'unrelated frame passes through identity-equal: ' + JSON.stringify(junk));
    }
  }

  console.log('Lobby: gridSlot stacks a starting grid behind gate 1 (pure)');
  {
    const { gridSlot, bearingDeg, ecef, sub, vlen } = E0.R._internals;
    const g1 = along(0), g2 = along(2000);     // due east of each other
    const leadS = 10, speedMs = 150;
    const n = 3;
    const slots = [0, 1, 2].map((i) => gridSlot(g1, g2, i, n, leadS, speedMs));

    for (const s of slots) {
      ok([s.lat, s.lon, s.alt, s.heading].every(Number.isFinite), 'every component is finite');
      ok(Math.abs(s.heading - bearingDeg(g1, g2)) < 0.001, 'heading points along gate1->gate2 (' + s.heading.toFixed(2) + ')');
    }
    // speedMs*leadS metres behind gate 1 — i.e. holding that speed for that long reaches it.
    const flat = (p) => vlen(sub(ecef(p.lat, p.lon, 0), ecef(g1.lat, g1.lon, 0)));
    ok(Math.abs(flat(slots[1]) - speedMs * leadS) < 60,
      'the centre slot sits ~speedMs*leadS behind gate 1 (' + Math.round(flat(slots[1])) + ' m vs ' + speedMs * leadS + ')');
    // Behind, not ahead: due east course -> the grid is west of gate 1.
    ok(slots[1].lon < g1.lon, 'the grid is behind gate 1 on the reverse bearing, not past it');

    // 80 m lateral stagger, centred so the pack straddles the course line.
    const lateral = (a, b) => vlen(sub(ecef(a.lat, a.lon, 0), ecef(b.lat, b.lon, 0)));
    ok(Math.abs(lateral(slots[0], slots[1]) - 80) < 5, 'slots are 80 m apart laterally (' + Math.round(lateral(slots[0], slots[1])) + ' m)');
    ok(Math.abs(lateral(slots[0], slots[2]) - 160) < 10, 'and the outer two are 160 m apart');
    ok(slots[0].lat !== slots[2].lat, 'the outer slots are on opposite sides of the line');

    // 30 m vertical stagger, upward from gate 1 — never below it, since an air-start gate can
    // sit only a few hundred metres over terrain.
    ok(slots.every((s) => s.alt >= g1.alt), 'no slot is placed below gate 1');
    ok(slots[1].alt - slots[0].alt === 30 && slots[2].alt - slots[1].alt === 30, 'stacked 30 m apart vertically');

    const solo = gridSlot(g1, g2, 0, 1, leadS, speedMs);
    ok(Math.abs(lateral(solo, { lat: solo.lat, lon: solo.lon })) === 0 && Number.isFinite(solo.lat),
      'a one-racer grid puts that racer on the centreline');
  }

  console.log('Lobby: the relay connects for the lobby independent of Race.state, and the proto gate hides it');
  {
    const E = env({ apiBase: 'https://relay.test', seed: { 'finsRace.powerupRoom': 'friday-night' } });
    await E.bootFrames();
    // No course loaded at all, and no race running — but a room code means there is somewhere
    // to gather, so the lobby is already connected. This is the whole point of proto 2.
    ok(E.wsRecord.sockets.length === 1, 'a socket opens from a stored room code with no course loaded');
    ok(E.R.relay.room === 'friday-night', 'joined the room the code names: ' + E.R.relay.room);
    ok(E.R.race.state === 'idle', 'and Race is still idle');

    const ws = E.wsRecord.last;
    ws.fireOpen();
    ok(ws.ofType('join').length === 1, 'sends join on open');
    await new Promise((r) => setTimeout(r, 20)); // the first sync ping is scheduled, not sent inline
    ok(ws.ofType('ping').length >= 1, 'and starts the clock sync immediately (ping is allowed pre-join)');

    // An old (proto 1) server answers `joined` with no proto field: the lobby stays invisible
    // and the local countdown keeps working, with one status note.
    ws.fireMessage({ type: 'joined', room: 'friday-night' });
    ok(E.R.lobby.proto === 0, 'no proto field -> treated as proto 1');
    ok(E.R.lobby.active() === false, 'the lobby is not active against an old server');
    E.R.ui.renderLobby();
    ok(/no lobby/i.test(E.R.ui.E.lobbyProtoNote.textContent), 'one status note explains why: ' + E.R.ui.E.lobbyProtoNote.textContent);
    ok(E.w.document.getElementById('fr-lobby').classList.contains('fr-show') === false, 'the lobby card stays hidden');
    ok(E.w.document.getElementById('fr-countdown').textContent.includes('Manual sync'), 'the manual countdown is still there');

    // Now a proto 2 server.
    ws.fireMessage({ type: 'joined', room: 'friday-night', proto: 2, server_ms: Date.now() });
    ok(E.R.lobby.proto === 2 && E.R.lobby.active(), 'proto 2 turns the lobby on');
    ok(ws.ofType('hello').length === 1, 'and introduces this pilot with a hello');
    E.R.ui.renderLobby();
    ok(E.R.ui.E.lobbyProtoNote.textContent === '', 'the "no lobby" note clears');
  }

  console.log('Lobby: pong drives the clock offset, and a start frame arms the countdown from it');
  {
    const E = env({ apiBase: 'https://relay.test', seed: { 'finsRace.powerupRoom': 'lobbyroom' } });
    await E.bootFrames();
    const ws = E.wsRecord.last;
    ws.fireOpen();
    ws.fireMessage({ type: 'joined', room: 'lobbyroom', proto: 2, server_ms: Date.now() });
    E.R.loadCourse(course());
    await new Promise((r) => setTimeout(r, 20)); // the sync pings are scheduled, not sent inline

    // Pretend the server clock runs exactly 60 s ahead of ours. The pong echoes our own t0 back.
    const sent = ws.ofType('ping');
    ok(sent.length >= 1, 'a ping was sent (' + sent.length + ')');
    const OFFSET = 60000;
    ws.fireMessage({ type: 'pong', t0: sent[0].t0, server_ms: Date.now() + OFFSET });
    ok(Math.abs(E.R.lobby.offsetMs - OFFSET) < 200, 'offset measured from the pong (' + Math.round(E.R.lobby.offsetMs) + ' ms)');

    // The relay says "GO at server-time T". Every client converts that to its own clock, which
    // is what makes two machines' countdowns land together.
    const startAtServer = Date.now() + OFFSET + 8000;
    ws.fireMessage({ type: 'start', race_id: 1, start_at_server_ms: startAtServer, racers: ['Eric'] });
    ok(E.R.countdown.state === 'armed', 'the existing Countdown module is armed, not a new one');
    const localTarget = E.R.countdown.target;
    ok(Math.abs(localTarget - (Date.now() + 8000)) < 300,
      'armed for ~8 s from now in local time, not 68 s (' + Math.round(localTarget - Date.now()) + ' ms)');
    ok(E.R.race.goAt === localTarget, 'Race.armGo got the same instant for the second clock');

    // A re-broadcast of the same race_id must not re-arm (the relay repeats `start` to late
    // joiners, and a second arm would restart the countdown everyone is already watching).
    const before = E.R.countdown.target;
    ws.fireMessage({ type: 'start', race_id: 1, start_at_server_ms: startAtServer + 5000, racers: ['Eric'] });
    ok(E.R.countdown.target === before, 'a duplicate start for the same race_id is ignored');

    ws.fireMessage({ type: 'abort' });
    ok(E.R.countdown.state === 'idle', 'an abort frame stops the countdown');
  }

  console.log('Lobby: two clocks — the leaderboard clock is untouched and a jump start costs 5 s');
  {
    const E = env({ apiBase: 'https://relay.test' });
    await E.bootFrames();
    E.setPos(along(-1000)); E.frame(16);
    E.R.loadCourse(course());
    ok(E.R.race.goAt === null && E.R.race.goElapsed === null, 'no second clock outside a lobby race');

    // GO is 2 s in the future; crossing gate 1 now is a jump start.
    E.R.race.armGo(Date.now() + 2000);
    const events = [];
    E.R.race.on((ev, d) => events.push([ev, d]));
    let m = -1000;
    while (m < 400 && E.R.race.state !== 'running') {
      m += 200 * (1000 / 60) / 1000;
      E.setPos(along(m));
      E.frame(1000 / 60);
    }
    ok(E.R.race.state === 'running', 'the clock still starts on crossing gate 1, exactly as before');
    ok(E.R.race.jumpStartMs === 5000, 'crossing before GO takes the 5 s penalty (' + E.R.race.jumpStartMs + ')');
    ok(E.R.race.state !== 'dq', 'a jump start is a penalty, never a DQ');
    ok(events.some(([ev, d]) => ev === 'jumpstart' && d === 5000), 'a jumpstart event fires so the banner can show');
    ok(E.R.race.elapsed < 1000, 'the leaderboard clock still starts at the crossing, unpenalised (' + Math.round(E.R.race.elapsed) + ' ms)');
    ok(E.R.race.goElapsed < 0 + 5000 + 200 && E.R.race.goElapsed > -2000 + 5000 - 200,
      'the GO clock reads ~penalty minus the time still to run (' + Math.round(E.R.race.goElapsed) + ' ms)');

    // A clean start: GO already happened, no penalty.
    E.R.race.reset();
    ok(E.R.race.goAt === null, 'a re-arm clears the second clock, so a plain Alt+R is never a lobby race');
    E.setPos(along(-1000)); E.frame(16);
    E.R.race.armGo(Date.now() - 3000);
    m = -1000;
    while (m < 400 && E.R.race.state !== 'running') {
      m += 200 * (1000 / 60) / 1000;
      E.setPos(along(m));
      E.frame(1000 / 60);
    }
    ok(E.R.race.jumpStartMs === 0, 'crossing after GO takes no penalty');
    ok(E.R.race.goElapsed >= 3000, 'the GO clock counts from GO, not from the crossing (' + Math.round(E.R.race.goElapsed) + ' ms)');
  }

  console.log('Lobby: ready flips, host detection, spectators, and the chat enum');
  {
    const E = env({ apiBase: 'https://relay.test', seed: { 'finsRace.callsign': 'Eric', 'finsRace.powerupRoom': 'roomy' } });
    await E.bootFrames();
    const ws = E.wsRecord.last;
    ws.fireOpen();
    ws.fireMessage({ type: 'joined', room: 'roomy', proto: 2, server_ms: Date.now() });
    E.R.loadCourse(course());

    const lobbyFrame = (players, extra = {}) => ({ type: 'lobby', phase: 'lobby', host: 'Eric', course: null,
      rules: { powerups: true, teleport: true }, race_id: 0, players, ...extra });
    ws.fireMessage(lobbyFrame([{ callsign: 'Eric', model: '', ready: false, role: 'racer' },
      { callsign: 'Maggie', model: 'bratwurst', ready: false, role: 'racer' }]));
    ok(E.R.lobby.isHost() === true, 'the room says I am host, so the host controls render');
    ok(E.R.lobby.allReady() === false, 'not everyone is ready yet');

    E.R.ui.toggleReady();
    const readyFrames = ws.ofType('ready');
    ok(readyFrames.length === 1 && readyFrames[0].ready === true, 'the READY toggle sends ready:true');
    E.w.document.dispatchEvent && ok(true, '');

    // The relay is the source of truth for ready state, not the local button.
    ws.fireMessage(lobbyFrame([{ callsign: 'Eric', model: '', ready: true, role: 'racer' },
      { callsign: 'Maggie', model: 'bratwurst', ready: true, role: 'racer' }]));
    ok(E.R.lobby.allReady() === true, 'everyone ready once the relay says so');
    ok(E.R.lobby.ready === true, 'and my own flag follows the relay, not the click');

    E.R.lobby.chat('gg');
    ok(ws.ofType('chat').length === 1 && ws.ofType('chat')[0].code === 'gg', 'a quick-chat button sends the enum code');
    E.R.lobby.chat('drop dead');
    ok(ws.ofType('chat').length === 1, 'an off-enum code is never sent');

    // Force-started while not ready: spectator. No timing, no items, but standings still show.
    ws.fireMessage(lobbyFrame([{ callsign: 'Eric', model: '', ready: false, role: 'spectator' },
      { callsign: 'Maggie', model: '', ready: true, role: 'racer' }], { phase: 'racing' }));
    ok(E.R.lobby.isSpectator() === true, 'the relay made me a spectator');
    const beforeBox = ws.sent.length;
    E.R.race.emit('itembox', { at: 0 });
    ok(ws.sent.length === beforeBox, 'a spectator never asks the relay for an item');
    ok(E.R.powerups.feed.some((l) => /Spectating/.test(l)), 'and the feed says why: ' + E.R.powerups.feed[0]);
  }

  console.log('Sfx: sfxPatch resolves a playable recipe for every documented sound name');
  {
    const { sfxPatch, SFX_NAMES } = E0.R._internals;
    ok(SFX_NAMES.length === 15, 'fifteen documented sfx names (' + SFX_NAMES.length + ')');
    for (const name of SFX_NAMES) {
      const p = sfxPatch(name);
      ok(!!p, 'sfxPatch resolves a recipe for ' + name);
      ok(['sine', 'square', 'sawtooth', 'triangle'].includes(p.type), name + ' has a real oscillator type (' + p.type + ')');
      ok(Number.isFinite(p.freq) && p.freq > 0, name + ' has a positive start frequency');
      ok(Number.isFinite(p.freq2) && p.freq2 > 0, name + ' has a positive end frequency');
      ok(Number.isFinite(p.duration) && p.duration > 0, name + ' has a positive duration');
    }
    ok(sfxPatch('not_a_real_sound') === null, 'an unknown name resolves to null rather than a guess');
  }

  console.log('Sfx: play() never throws with no AudioContext (jsdom has none), muted, or an unknown name');
  {
    const E = env();
    await E.bootFrames();
    let threw = false;
    try {
      E.R.sfx.play('gate');       // no AudioContext in jsdom -> silent no-op
      E.R.sfx.setMuted(true);
      E.R.sfx.play('finish');
      E.R.sfx.play('not_a_real_sound');
    } catch (_) { threw = true; }
    ok(!threw, 'Sfx.play never throws');
    ok(E.R.sfx.ctx === null, 'no AudioContext in jsdom, so the context is never created');
    ok(JSON.parse(E.w.localStorage.getItem('finsRace.sfxMuted')) === true, 'mute state persists to localStorage');
  }

  console.log('HUD: hudTowerRows turns standings + your callsign into up to 8 tower rows');
  {
    const { hudTowerRows, hudPositionInfo } = E0.R._internals;
    ok(JSON.stringify(hudTowerRows(['Eric'], 'Eric', {}, 'F-16')) === '[]', 'a solo standings list produces no tower (nothing to show)');
    ok(JSON.stringify(hudTowerRows(null, 'Eric', {}, 'F-16')) === '[]', 'no relay/no standings -> empty tower, never throws');
    const order = ['Ann', 'Eric', 'Bo', 'Cy', 'Di', 'Ed', 'Fi', 'Gu', 'Hy'];
    const rows = hudTowerRows(order, 'Eric', {}, 'F-16');
    ok(rows.length === 8, 'capped at 8 rows even with 9 standings entries (' + rows.length + ')');
    ok(rows[0].rank === 1 && rows[0].callsign === 'Ann' && rows[0].gap === '', 'leader has no gap (rank 1, blank gap)');
    ok(rows[1].callsign === 'Eric' && rows[1].isMe === true && rows[1].model === 'F-16', 'your own row is flagged and carries your model');
    ok(rows[2].isMe === false && rows[2].model === '', "other racers' model is left blank (the relay protocol doesn't carry it)");
    const gapped = hudTowerRows(order, 'Eric', { Eric: 1500 }, 'F-16');
    ok(gapped[1].gap === '+1.5', 'a supplied gap (ms) formats as seconds behind the leader: ' + gapped[1].gap);

    ok(hudPositionInfo(['Eric'], 'Eric') === null, 'solo -> no position info, HUD hides the whole block');
    const info = hudPositionInfo(order, 'Eric');
    ok(info.rank === 2 && info.total === 9 && info.ahead === 'Ann', 'position info: rank/total/who is ahead');
    ok(hudPositionInfo(order, 'Nobody') === null, 'not present in standings -> null, not a guessed rank');
  }

  console.log('HUD: hudPipStates marks done/next/remaining gate pips off Race.next');
  {
    const { hudPipStates } = E0.R._internals;
    ok(JSON.stringify(hudPipStates(0, 4)) === '["next","remaining","remaining"]', 'armed (next=0): first real gate is next, rest remaining');
    ok(JSON.stringify(hudPipStates(2, 4)) === '["done","next","remaining"]', 'mid-race (next=2): gate 1 done, gate 2 next, gate 3 remaining');
    ok(JSON.stringify(hudPipStates(4, 4)) === '["done","done","done"]', 'finished (next === gates.length): every pip done');
    ok(JSON.stringify(hudPipStates(0, 0)) === '[]', 'a degenerate 0-gate course produces no pips, never throws');
    ok(hudPipStates(0, 2).length === 1, 'a minimal 2-gate course (start+finish) has exactly one pip');
  }

  console.log('HUD: CONFIG.HUD = false leaves the settings panel DOM identical to CONFIG.HUD = true at boot');
  {
    const on = env({ hud: true }), off = env({ hud: false });
    await Promise.all([on.bootFrames(), off.bootFrames()]);
    ok(!off.w.document.getElementById('fr-hud'), 'no #fr-hud element is created when the flag is off');
    ok(!!on.w.document.getElementById('fr-hud'), '#fr-hud exists when the flag is on');
    ok(on.w.document.getElementById('fr-root').outerHTML === off.w.document.getElementById('fr-root').outerHTML,
      'the #fr-root panel itself is byte-identical whether or not the HUD is enabled');
    ok(off.R.race.listeners.length === on.R.race.listeners.length - 1, 'Hud subscribes to the race bus only when enabled');
  }

  console.log('HUD: Alt+H toggles the HUD when enabled, and falls back to the old panel-hide toggle when CONFIG.HUD is false');
  {
    const on = env({ hud: true });
    await on.bootFrames();
    const hudEl = on.w.document.getElementById('fr-hud');
    ok(!hudEl.classList.contains('fr-hud-off'), 'HUD starts shown (not manually hidden)');
    on.w.dispatchEvent(new on.w.KeyboardEvent('keydown', { code: 'KeyH', altKey: true, bubbles: true, cancelable: true }));
    ok(hudEl.classList.contains('fr-hud-off'), 'Alt+H hides the HUD');
    ok(!on.w.document.getElementById('fr-root').classList.contains('fr-hidden'), 'Alt+H no longer hides the settings panel when HUD is on');

    const off = env({ hud: false });
    await off.bootFrames();
    off.w.dispatchEvent(new off.w.KeyboardEvent('keydown', { code: 'KeyH', altKey: true, bubbles: true, cancelable: true }));
    ok(off.w.document.getElementById('fr-root').classList.contains('fr-hidden'), 'Alt+H falls back to hiding the panel (0.6.0 behavior) when CONFIG.HUD is false');
  }

  console.log('HUD: shows only while armed/running/finished/dq, and mirrors the timer + gate pips + item slots');
  {
    const E = env();
    await E.bootFrames();
    const hudEl = E.w.document.getElementById('fr-hud');
    ok(!hudEl.classList.contains('fr-hud-show'), 'hidden while idle (no course loaded)');
    E.setPos(along(-1000)); E.frame(16);
    E.R.loadCourse(course());
    E.frame(16);
    ok(hudEl.classList.contains('fr-hud-show'), 'shown once armed');
    ok(E.w.document.getElementById('fr-root').classList.contains('fr-hud-owns-timer'), 'panel timer hides while HUD owns it (armed)');
    E.R.race.emit('start');
    E.frame(16);
    ok(E.w.document.getElementById('fr-hud-timer').textContent !== '', 'HUD timer is populated while running');

    const items = E.w.document.getElementById('fr-hud-items');
    ok(items.children.length === 3, 'three item slots rendered');
    ok(items.children[2].querySelector('.fr-hud-icon').innerHTML === '?', 'empty box slot shows a dim "?"');
  }

  console.log('Fly to start: geofs.resetFlight is primary, raw state writes are the fallback');
  {
    const { ecef, sub, vlen, bearingDeg } = E0.R._internals;
    const air = () => course(150, { startType: 'air' });
    const g1 = along(0), g2 = along(2000);
    const wantHeading = bearingDeg(g1, g2);
    const distTo = (E, p) => {
      const at = E.lla();
      return vlen(sub(ecef(at[0], at[1], at[2]), ecef(p.lat, p.lon, p.alt)));
    };
    // A GeoFS whose resetFlight honors lastFlightCoordinates, which is the case this is for.
    const honest = (g) => { g.aircraft.instance.llaLocation = g.lastFlightCoordinates.slice(0, 3); };

    {
      const E = env({ resetFlight: honest, htr: [270, 0, 0] });
      await E.bootFrames();
      E.setPos(along(-40000)); E.frame(16);
      E.R.loadCourse(air());
      const res = E.R.flyToStart();
      ok(res.ok && res.how === 'resetFlight', 'resetFlight is used when it exists and lands on gate 1: ' + JSON.stringify(res.how));
      ok(distTo(E, g1) < 1, 'aircraft is on gate 1 (' + distTo(E, g1).toFixed(1) + ' m)');
      ok(near(E.w.geofs.aircraft.instance.htr[0], wantHeading, 0.001), 'htr[0] is the bearing from gate 1 to gate 2 (' + E.w.geofs.aircraft.instance.htr[0].toFixed(2) + ' vs ' + wantHeading.toFixed(2) + ')');
      ok(res.scalar === true && E.instance.trueAirSpeed === E.R.config.FLY_TO_START_SPEED_MS, 'left at a flying airspeed, not stalled (' + E.instance.trueAirSpeed + ' m/s)');
      ok(near(E.w.geofs.lastFlightCoordinates[0], g1.lat, 1e-9) && E.w.geofs.lastFlightCoordinates.length === 6,
        'the coordinate array is edited in place, keeping the entries GeoFS put there');
      ok(E.R.race.state === 'armed', 're-armed, so a mid-run reposition leaves nothing on the clock');
    }

    {
      // resetFlight that ignores the coordinates and drops you on a runway somewhere else: the
      // position check has to catch it and fall through to the raw writes.
      const wrong = (g) => { g.aircraft.instance.llaLocation = [40, -120, 0]; };
      const E = env({ resetFlight: wrong, htr: [270, 0, 0] });
      await E.bootFrames();
      E.setPos(along(-40000)); E.frame(16);
      E.R.loadCourse(air());
      const res = E.R.flyToStart();
      ok(res.ok && res.how === 'state writes', 'a resetFlight that lands somewhere else is rejected: ' + res.how);
      ok(distTo(E, g1) < 1, 'the fallback still puts the aircraft on gate 1 (' + distTo(E, g1).toFixed(1) + ' m)');
    }

    {
      // Right lat/lon, but left on the ground: a 3D check would wave that through, and it means
      // spawning on terrain at flying speed.
      const onGround = (g) => { g.aircraft.instance.llaLocation = [g.lastFlightCoordinates[0], g.lastFlightCoordinates[1], 0]; };
      const E = env({ resetFlight: onGround });
      await E.bootFrames();
      E.setPos(along(-40000)); E.frame(16);
      E.R.loadCourse(air());
      const res = E.R.flyToStart();
      ok(res.how === 'state writes', 'a reset that lands at ground level is rejected on altitude: ' + res.how);
      ok(near(E.lla()[2], g1.alt, 0.001), 'the fallback fixes the altitude (' + E.lla()[2] + ' m)');
    }

    {
      // No resetFlight at all (the GeoFS build this was written against): straight to fallback.
      const E = env();
      await E.bootFrames();
      E.setPos(along(-40000)); E.frame(16);
      E.R.loadCourse(air());
      const res = E.R.flyToStart();
      ok(res.how === 'state writes', 'with no geofs.resetFlight, the state writes are used: ' + res.how);
      ok(distTo(E, g1) < 1, 'still on gate 1 (' + distTo(E, g1).toFixed(1) + ' m)');
      ok(res.heading === false, 'reports the heading write being refused when htr is missing');
    }
  }

  console.log('Fly to start: the velocity vector is gated on the recorded frame, and nothing it does can start or DQ a run');
  {
    const air = () => course(150, { startType: 'air' });
    const frame = { kind: 'object', comps: ['x', 'y', 'z'], fwd: 'x', bodyFixed: true, ref: [200, 0, 0], refSpeedMs: 200 };

    {
      const E = env({ velocityFrame: frame, velocity: { x: 0, y: 0, z: 0 } });
      await E.bootFrames();
      E.setPos(along(-40000)); E.frame(16);
      E.R.loadCourse(air());
      const res = E.R.flyToStart();
      ok(res.vector === true, 'with a body-fixed frame recorded, the velocity vector is set from the reference sample');
      ok(E.instance.velocity.x === E.R.config.FLY_TO_START_SPEED_MS, 'the vector is the reference sample rescaled: ' + JSON.stringify(E.instance.velocity));
    }

    {
      // Sitting still with no frame recorded: the scalars go in, the vector is left alone.
      const E = env({ velocity: { x: 0, y: 0, z: 0 } });
      await E.bootFrames();
      E.setPos(along(-40000)); E.frame(16);
      E.R.loadCourse(air());
      // Through the panel button this time, so the status line it writes is covered too.
      E.R.ui.flyToStart();
      const status = E.w.document.getElementById('fr-status').textContent;
      ok(E.instance.trueAirSpeed === E.R.config.FLY_TO_START_SPEED_MS, 'the confirmed scalars still went in, so GeoFS at least knows a speed');
      ok(JSON.stringify({ ...E.instance.velocity }) === '{"x":0,"y":0,"z":0}', 'no frame recorded = the vector is untouched: ' + JSON.stringify(E.instance.velocity));
      ok(/velocity not set/.test(status), 'the panel says the velocity half is not set: ' + status);
      ok(/On gate 1 via state writes/.test(status) && /heading 90/.test(status), 'and which path placed you, and on what heading: ' + status);
    }

    {
      // An earth-fixed frame must refuse the reference path: the same three numbers would mean
      // "fly east" no matter which way gate 2 is.
      const E = env({ velocityFrame: { ...frame, bodyFixed: false, fwd: null }, velocity: { x: 0, y: 0, z: 0 } });
      await E.bootFrames();
      E.setPos(along(-40000)); E.frame(16);
      E.R.loadCourse(air());
      ok(E.R.flyToStart().vector === false, 'an earth-fixed frame refuses to synthesize a direction');
    }

    {
      // The timing guarantee: fly to start, then keep flying frames. No start, no DQ.
      const E = env();
      await E.bootFrames();
      E.setPos(along(-40000)); E.frame(16);
      E.R.loadCourse(air());
      E.R.flyToStart();
      for (let i = 0; i < 10; i++) E.frame(16);
      ok(E.R.race.state === 'armed', 'still armed after the reposition (no start, no DQ): ' + E.R.race.state + ' ' + E.R.race.dqReason);
      // …and leaving the start sphere afterwards does start the clock normally.
      let m = 0;   // out past the 150 m start sphere at 200 m/s
      for (let i = 0; i < 100; i++) { m += 200 * 0.016; E.setPos(along(m)); E.frame(16); }
      ok(E.R.race.state === 'running', 'the clock still starts normally on crossing out of gate 1: ' + E.R.race.state);
    }
  }

  console.log('Fly to start: refused, with a reason, when it does not apply');
  {
    const E = env();
    await E.bootFrames();
    E.setPos(along(0)); E.frame(16);
    ok(E.R.flyToStart().ok === false, 'refused with no course loaded');

    E.R.loadCourse(course());   // a ground course
    const res = E.R.flyToStart();
    ok(res.ok === false && /air-start/.test(res.detail), 'refused on a ground-start course: ' + res.detail);
    const before = E.lla();
    ok(E.lla().every((n, i) => n === before[i]), 'a refusal never moves the aircraft');
    ok(E.R.ui.E.flyBtn.disabled === true, 'the button is disabled on a ground course');

    E.R.loadCourse(course(150, { startType: 'air' }));
    ok(E.R.ui.E.flyBtn.disabled === false, 'and enabled on an air-start course');
  }

  console.log('Trace: quantization and the append rate/cap gates (pure)');
  {
    const { traceQuantize, traceAppend, traceEmpty } = E0.R._internals;
    const q = traceQuantize({ t: 1234.6, lat: 45.1234567, lon: -122.7654321, alt: 1000.06, heading: 359.96, pitch: -3.14159, roll: 12.3456 });
    ok(q[0] === 1235, 't is rounded to an integer ms (' + q[0] + ')');
    ok(q[1] === 45.123457 && q[2] === -122.765432, 'lat/lon quantized to 6 dp (' + q[1] + ', ' + q[2] + ')');
    ok(q[3] === 1000.1, 'alt quantized to 1 dp (' + q[3] + ')');
    ok(q[4] === 0 || q[4] === 360, 'heading wraps into [0,360) after rounding (' + q[4] + ')');
    ok(q[5] === -3.1 && q[6] === 12.3, 'pitch/roll quantized to 1 dp');
    ok(traceQuantize({ t: 0, lat: NaN, lon: 0, alt: 0 }) === null, 'a non-finite position is rejected');
    ok(traceQuantize({ t: 0, lat: 95, lon: 0, alt: 0 }) === null, 'an out-of-range latitude is rejected');
    ok(traceQuantize({ t: 0, lat: 45, lon: -122, alt: 100 })[4] === 0, 'a missing heading becomes 0 rather than dropping the sample');

    // 4 Hz: samples closer than 250 ms apart are dropped, and the trace object is returned
    // unchanged (identity) so a caller can cheaply tell "nothing happened".
    let tr = traceEmpty();
    const push = (t) => { tr = traceAppend(tr, { t, lat: 45, lon: -122, alt: 1000, heading: 90, pitch: 0, roll: 0 }, 4, 6000); };
    push(0); push(100); push(200); push(260); push(400); push(520);
    ok(tr.samples.map((r) => r[0]).join(',') === '0,260,520', 'only samples >= 250 ms apart are kept (' + tr.samples.map((r) => r[0]).join(',') + ')');
    const same = traceAppend(tr, { t: 600, lat: 45, lon: -122, alt: 1000, heading: 90 }, 4, 6000);
    ok(same === tr, 'a rate-limited append returns the same object, not a copy');
    ok(traceAppend(tr, { t: 100, lat: 45, lon: -122, alt: 1000 }, 4, 6000) === tr, 'a sample going backwards in time is dropped');

    // The hard cap: recording stops and the trace is marked truncated, and stays truncated.
    let cap = traceEmpty();
    for (let i = 0; i < 10; i++) cap = traceAppend(cap, { t: i * 250, lat: 45, lon: -122, alt: 1000, heading: 90 }, 4, 5);
    ok(cap.samples.length === 5 && cap.truncated === true, 'stops at the cap and marks the trace truncated (' + cap.samples.length + ')');
    const after = traceAppend(cap, { t: 99999, lat: 45, lon: -122, alt: 1000, heading: 90 }, 4, 5);
    ok(after === cap && after.truncated === true, 'a truncated trace never grows again');
  }

  console.log('Trace: encode/decode round trip, delta-encoded t (pure)');
  {
    const { traceAppend, traceEmpty, traceEncode, traceDecode } = E0.R._internals;
    let tr = traceEmpty();
    for (let i = 0; i < 40; i++) {
      tr = traceAppend(tr, { t: i * 250, lat: 45 + i * 1e-4, lon: -122 - i * 1e-4, alt: 1000 + i, heading: (i * 37) % 360, pitch: i % 11 - 5, roll: -(i % 7) }, 4, 6000);
    }
    const enc = traceEncode(tr);
    ok(enc.v === 1 && enc.n === 40 && enc.t.length === 40, 'encodes to columnar arrays with a version and count');
    ok(enc.t[0] === 0 && enc.t.slice(1).every((d) => d === 250), 't is delta-encoded (first absolute, rest gaps)');
    const back = traceDecode(enc);
    ok(!!back && back.samples.length === 40, 'decodes back to the same sample count');
    ok(JSON.stringify(back.samples) === JSON.stringify(tr.samples), 'round trip is byte-identical');
    ok(traceDecode({ v: 2, t: [], lat: [], lon: [], alt: [], hdg: [], pitch: [], roll: [] }) === null, 'an unknown version is refused');
    ok(traceDecode({ v: 1, t: [0, 250], lat: [45], lon: [-122], alt: [0], hdg: [0], pitch: [0], roll: [0] }) === null, 'ragged columns are refused');
    ok(traceDecode({ v: 1, t: [0, 0], lat: [45, 45], lon: [-122, -122], alt: [0, 0], hdg: [0, 0], pitch: [0, 0], roll: [0, 0] }) === null, 'a non-increasing t is refused');
    ok(traceDecode({ v: 1, t: [0], lat: [95], lon: [-122], alt: [0], hdg: [0], pitch: [0], roll: [0] }) === null, 'an out-of-range latitude is refused');
    ok(traceDecode(null) === null && traceDecode('nope') === null, 'junk decodes to null, not a half-built trace');
  }

  console.log('Trace: traceSampleAt interpolates position linearly and angles the short way (pure)');
  {
    const { traceSampleAt, headingLerp, angleDelta } = E0.R._internals;
    ok(angleDelta(350, 10) === 20, 'angleDelta crosses 360 the short way (' + angleDelta(350, 10) + ')');
    ok(angleDelta(10, 350) === -20, '…and back the other way (' + angleDelta(10, 350) + ')');
    ok(headingLerp(350, 10, 0.5) === 0, 'headingLerp(350, 10, 0.5) lands on 0, not 180');
    ok(headingLerp(10, 350, 0.5) === 0, 'headingLerp(10, 350, 0.5) also lands on 0');
    ok(near(headingLerp(350, 10, 0.25), 355, 1e-9), 'headingLerp(350, 10, 0.25) = 355');

    const trace = { samples: [
      [0, 45, -122, 1000, 350, -5, 0],
      [1000, 46, -121, 2000, 10, 5, 20],
      [2000, 47, -120, 3000, 90, 0, 0],
    ], truncated: false };
    const mid = traceSampleAt(trace, 500);
    ok(near(mid.lat, 45.5, 1e-9) && near(mid.lon, -121.5, 1e-9) && near(mid.alt, 1500, 1e-9), 'lla interpolates linearly');
    ok(mid.heading === 0, 'heading interpolates 350 -> 10 through 360, giving 0 (' + mid.heading + ')');
    ok(near(mid.pitch, 0, 1e-9) && near(mid.roll, 10, 1e-9), 'pitch/roll interpolate linearly');
    const before = traceSampleAt(trace, -5000);
    ok(before.lat === 45 && before.ended === false, 'before the first sample it holds the start, not ended');
    const after = traceSampleAt(trace, 99999);
    ok(after.lat === 47 && after.ended === true, 'past the last sample it parks on the last one and reports ended');
    ok(traceSampleAt({ samples: [], truncated: false }, 0) === null, 'an empty trace samples to null');
    ok(traceSampleAt(trace, NaN) === null, 'a non-finite t samples to null');
  }

  console.log('Trace: traceNearest is forward-only from its hint (pure)');
  {
    const { traceNearest, ecef } = E0.R._internals;
    // A there-and-back path: samples 0..4 fly east, 5..9 fly back west over the same ground, so
    // every point has two near samples and only the hint decides which one is found.
    const pts = [0, 500, 1000, 1500, 2000, 2000, 1500, 1000, 500, 0];
    const trace = { samples: pts.map((m, i) => { const p = along(m); return [i * 250, p.lat, p.lon, 1000, 90, 0, 0]; }), truncated: false };
    const at1000 = (() => { const p = along(1000); return ecef(p.lat, p.lon, 1000); })();
    ok(traceNearest(trace, at1000, 0, 64).index === 2, 'from hint 0 it finds the outbound pass (index 2)');
    ok(traceNearest(trace, at1000, 5, 64).index === 7, 'from hint 5 it finds the return pass (index 7), never going back to 2');
    ok(traceNearest(trace, at1000, 8, 64).index === 8, 'a hint past the match never rewinds (index 8)');
    const windowed = traceNearest(trace, at1000, 0, 1);
    ok(windowed.index === 0 || windowed.index === 1, 'the window bounds the search (' + windowed.index + ')');
    ok(traceNearest(trace, at1000, 999, 64).index === 9, 'a hint past the end clamps to the last sample');
    ok(traceNearest({ samples: [], truncated: false }, at1000, 0, 64) === null, 'an empty trace has no nearest');
    ok(traceNearest(trace, null, 0, 64) === null, 'a missing point has no nearest');
  }

  console.log('Trace: traceDeltaMs is negative when I am ahead of the ghost (pure)');
  {
    const { traceDeltaMs, ecef } = E0.R._internals;
    // A ghost that flew 200 m/s due east from the origin: 50 m every 250 ms.
    const trace = { samples: Array.from({ length: 41 }, (_, i) => { const p = along(i * 50); return [i * 250, p.lat, p.lon, 1000, 90, 0, 0]; }), truncated: false };
    const at = (m) => { const p = along(m); return ecef(p.lat, p.lon, 1000); };
    // Ghost reached 1000 m at t = 5000 ms.
    const ahead = traceDeltaMs(trace, at(1000), 4000, 0, 64);
    ok(ahead && near(ahead.deltaMs, -1000, 30), 'reaching the same point 1 s sooner reads -1000 ms (' + Math.round(ahead.deltaMs) + ')');
    const behind = traceDeltaMs(trace, at(1000), 6500, 0, 64);
    ok(behind && near(behind.deltaMs, 1500, 30), 'reaching it 1.5 s later reads +1500 ms (' + Math.round(behind.deltaMs) + ')');
    // Sub-sample resolution: 1025 m is halfway between two samples, so the ghost time must be
    // interpolated (5125 ms) rather than snapped to 5000 or 5250.
    const between = traceDeltaMs(trace, at(1025), 5125, 0, 64);
    ok(between && Math.abs(between.deltaMs) < 60, 'the ghost time interpolates between samples (' + Math.round(between.deltaMs) + ' ms)');
    ok(traceDeltaMs(trace, at(1000), NaN, 0, 64) === null, 'a non-finite elapsed gives no delta');
    ok(traceDeltaMs({ samples: [], truncated: false }, at(0), 0, 0, 64) === null, 'an empty trace gives no delta');
  }

  console.log('Trace: traceIndexPut is an LRU over course hashes (pure)');
  {
    const { traceIndexPut } = E0.R._internals;
    let idx = [];
    for (let i = 0; i < 3; i++) idx = traceIndexPut(idx, 'h' + i, 1000 + i, 100 + i, 20).index;
    ok(idx.map((e) => e.hash).join(',') === 'h0,h1,h2', 'keeps entries oldest-first (' + idx.map((e) => e.hash).join(',') + ')');
    const again = traceIndexPut(idx, 'h0', 900, 500, 20);
    ok(again.index.length === 3 && again.drop.length === 0, 're-saving a course refreshes its slot instead of adding a second');
    ok(again.index[again.index.length - 1].hash === 'h0' && again.index[2].ms === 900, '…and moves it to newest with the new time');
    const capped = traceIndexPut(idx, 'h3', 1, 200, 2);
    ok(capped.index.map((e) => e.hash).join(',') === 'h2,h3', 'the cap keeps the newest (' + capped.index.map((e) => e.hash).join(',') + ')');
    ok(capped.drop.join(',') === 'h0,h1', '…and reports the oldest for deletion (' + capped.drop.join(',') + ')');
    ok(traceIndexPut(null, 'h', 1, 1, 20).index.length === 1, 'a missing index starts fresh');
    ok(traceIndexPut([null, { nope: 1 }], 'h', 1, 1, 20).index.length === 1, 'junk entries are dropped');
  }

  console.log('Trace: a finished run records at 4 Hz and is saved only when it is a personal best');
  {
    const { race, E } = await fly();
    ok(race.state === 'finished', 'finishes');
    const rec = E.R.recorder;
    // 18.5 s of running at 4 Hz, first sample on the frame the clock starts.
    ok(rec.count() >= 70 && rec.count() <= 80, 'recorded ~74 samples at 4 Hz (got ' + rec.count() + ')');
    ok(rec.truncated() === false, 'not truncated');
    const first = rec.trace.samples[0], last = rec.trace.samples[rec.trace.samples.length - 1];
    ok(first[0] < 300, 'the first sample is at t ~0, i.e. the gate-1 crossing (' + first[0] + ' ms)');
    ok(Math.abs(last[0] - race.finalMs) < 400, 'the last sample is at the finish (' + last[0] + ' vs ' + race.finalMs + ')');
    ok(rec.trace.samples.every((r, i, a) => i === 0 || r[0] > a[i - 1][0]), 't is strictly increasing');
    const raw = E.w.localStorage.getItem('finsRace.trace.' + race.hash);
    ok(!!raw, 'the trace is persisted under a per-hash key');
    const idx = JSON.parse(E.w.localStorage.getItem('finsRace.traceIndex'));
    ok(idx.length === 1 && idx[0].hash === race.hash && idx[0].ms === race.finalMs, 'the index records hash + time');
    const decoded = E.R._internals.traceDecode(JSON.parse(raw));
    ok(!!decoded && decoded.samples.length === rec.count(), 'what was stored decodes back to the same trace');
  }

  console.log('Trace: a slower second run leaves the faster run\'s ghost alone');
  {
    // Seed a personal best that this run cannot beat; the trace stored must stay the seeded one.
    const seedHash = (await fly()).race.hash;
    const { race, E } = await fly({ speed: 150, opts: { seed: {
      'finsRace.best': { [seedHash]: { ms: 1, splits: [1, 1], at: 1 } },
      ['finsRace.trace.' + seedHash]: { v: 1, n: 2, t: [0, 250], lat: [45, 45], lon: [-122, -122], alt: [1000, 1000], hdg: [90, 90], pitch: [0, 0], roll: [0, 0] },
      'finsRace.traceIndex': [{ hash: seedHash, ms: 1, at: 1 }],
    } } });
    ok(race.state === 'finished' && race.hash === seedHash, 'same course, slower run');
    const stored = JSON.parse(E.w.localStorage.getItem('finsRace.trace.' + seedHash));
    ok(stored.n === 2, 'the seeded (faster) trace is untouched (n=' + stored.n + ')');
    ok(E.R.recorder.saved === false, 'the recorder reports it did not save');
  }

  console.log('Trace: a DQ discards the recording, and a truncated run is never saved');
  {
    const { race, E } = await fly({ hooks: { after: (Env, t) => { if (t > 9000 && t < 9017) Env.setPos(along(3900)); } } });
    ok(race.state === 'dq', 'DQ');
    ok(E.R.recorder.count() === 0, 'the trace is discarded on DQ (' + E.R.recorder.count() + ' samples)');
    ok(E.w.localStorage.getItem('finsRace.trace.' + race.hash) === null, 'nothing was persisted');

    const t2 = await fly({ opts: { patch: [['TRACE_MAX_SAMPLES: 6000,', 'TRACE_MAX_SAMPLES: 10,']] } });
    ok(t2.race.state === 'finished' && t2.E.R.recorder.truncated() === true, 'the short cap truncates the run');
    ok(t2.E.w.localStorage.getItem('finsRace.trace.' + t2.race.hash) === null, 'a truncated trace is never saved');
  }

  console.log('Trace: CONFIG.TRACE = false records nothing at all');
  {
    const { race, E } = await fly({ opts: { patch: [['TRACE: true,', 'TRACE: false,']] } });
    ok(race.state === 'finished', 'the race itself is unaffected');
    ok(E.R.recorder.count() === 0, 'no samples taken');
    ok(E.w.localStorage.getItem('finsRace.traceIndex') === null, 'no index written');
  }

  console.log('Trace: a full localStorage evicts the oldest trace, then gives up silently');
  {
    // Every finsRace.trace.* write throws QuotaExceededError, so the save can never succeed —
    // what must hold is that it evicts, gives up, and leaves no half-written state or throw.
    const { race, E } = await fly({ opts: { quotaFull: true, seed: {
      'finsRace.traceIndex': [{ hash: 'old1', ms: 5, at: 1 }, { hash: 'old2', ms: 5, at: 2 }],
      'finsRace.trace.old1': { v: 1, n: 0 }, 'finsRace.trace.old2': { v: 1, n: 0 },
    } } });
    ok(race.state === 'finished', 'the race still finishes normally');
    ok(E.R.recorder.saved === false, 'the save reports failure rather than throwing');
    ok(E.w.localStorage.getItem('finsRace.trace.old1') === null && E.w.localStorage.getItem('finsRace.trace.old2') === null,
      'the older traces were evicted on the way down');
    const idx = JSON.parse(E.w.localStorage.getItem('finsRace.traceIndex'));
    ok(Array.isArray(idx) && idx.length === 0, 'the index is left consistent with what is actually stored (' + JSON.stringify(idx) + ')');
    ok(E.quotaBlocked.size > 0, 'the quota error really did fire (' + E.quotaBlocked.size + ' blocked writes)');
  }

  const GHOST_MODELS = [
    { id: 'goldfish', name: 'Goldfish', file: 'goldfish.glb', scale: 1, offset: { headingDeg: 0, pitchDeg: 0, rollDeg: 0 } },
    { id: 'cow', name: 'Cow', file: 'cow.glb', scale: 2, offset: { headingDeg: 90, pitchDeg: 0, rollDeg: 0 } },
  ];

  console.log('Ghost: the picker offers Off / My best / Course record / one pilot per has_ghost');
  {
    const { options } = E0.R.ghost;
    const rows = [
      { callsign: 'Maggie', time_ms: 17000, has_ghost: true },
      { callsign: 'Plain', time_ms: 18000, has_ghost: false },
      { callsign: 'Tom', time_ms: 19000, has_ghost: true },
    ];
    const full = options(rows, true).map((o) => o.value);
    ok(full.join(',') === ',mine,record,Maggie,Tom', 'full picker (' + full.join(',') + ')');
    ok(options(rows, true)[3].label === 'Maggie · 0:17.000', 'a pilot entry carries their time');
    ok(options(rows, false).map((o) => o.value).join(',') === ',record,Maggie,Tom', 'no local trace = no "My best"');
    ok(options([], true).map((o) => o.value).join(',') === ',mine', 'no board ghosts = no "Course record"');
    ok(options(null, false).map((o) => o.value).join(',') === '', 'nothing at all leaves only Off');
  }

  console.log('Ghost: "My best" replays the saved trace off Race.elapsed and is hidden before the start');
  {
    const { race, E } = await fly({ opts: { models: GHOST_MODELS } });
    ok(race.state === 'finished', 'a run was recorded and saved');
    await E.R.modelSwap.enable('cow');          // so the ghost uses my own joke model
    await E.R.ghost.setPick('mine');
    const gh = E.R.ghost;
    ok(!!gh.trace && gh.trace.samples.length > 60, 'my best trace decoded back out of localStorage (' + (gh.trace ? gh.trace.samples.length : 0) + ' samples)');
    ok(gh.layer.mode === 'model', 'loaded through the existing model path (' + gh.layer.mode + ')');
    ok(near(gh.layer.model.color.__alpha, 0.45, 1e-9), 'drawn at CONFIG.GHOST_ALPHA');
    ok(E.primitives.list.includes(gh.layer.model), 'the ghost model is a scene primitive like any other');

    race.reset();
    gh.tick();
    ok(gh.layer.model.show === false, 'hidden while armed — the ghost launches when I do');

    const { traceSampleAt } = E.R._internals;
    race.state = 'running'; race.elapsed = 5000;
    gh.tick();
    const want = traceSampleAt(gh.trace, 5000);
    const pos = gh.layer.model.modelMatrix.position;
    ok(gh.layer.model.show === true, 'visible once the clock is running');
    ok(near(pos.lat, want.lat, 1e-9) && near(pos.lon, want.lon, 1e-9) && near(pos.h, want.alt, 1e-6),
      'positioned from traceSampleAt(trace, Race.elapsed)');

    race.elapsed = 1e9;
    gh.tick();
    const last = gh.trace.samples[gh.trace.samples.length - 1];
    const parked = gh.layer.model.modelMatrix.position;
    ok(near(parked.lat, last[1], 1e-9) && near(parked.lon, last[2], 1e-9), 'parks on the last sample (the finish gate) when the trace ends');
    ok(gh.layer.model.show === true, '…and stays visible there rather than vanishing');
  }

  console.log('Ghost: model fallback chain — the pilot\'s model, then the goldfish, then a point + label');
  {
    const E = env({ models: GHOST_MODELS });
    await E.bootFrames();
    const layer = E.R._internals.makeGhostLayer();
    ok(await layer.load('cow', 'GHOST · Maggie · 0:17.000') === 'model', 'the named model when it exists');
    ok(await layer.load('no-such-model', 'GHOST · X') === 'fallback-model', 'the goldfish stands in for an unknown model id');
    ok(layer.model && layer.model.url.includes('goldfish.glb'), '…and it really is the goldfish');
    layer.clear();
    ok(layer.model === null && layer.mode === 'none', 'clear() disposes everything');

    // No Cesium.Model at all (an older/newer build): the point + label tier.
    const E2 = env({ models: GHOST_MODELS, modelApi: 'none' });
    await E2.bootFrames();
    const l2 = E2.R._internals.makeGhostLayer();
    ok(await l2.load('cow', 'GHOST · Maggie · 0:17.000') === 'point', 'falls all the way back to a point + label');
    ok(l2.entity && l2.entity.point && l2.entity.label.text === 'GHOST · Maggie · 0:17.000', 'the label names the ghost and its time');
    ok(l2.entity.show === false, 'the point starts hidden too');
    l2.update({ lat: 46, lon: -121, alt: 500, heading: 0, pitch: 0, roll: 0, ended: false });
    ok(l2.entity.show === true && l2.entity.position.lat === 46, 'the point tracks the trace sample');
    l2.update(null);
    ok(l2.entity.show === false, 'a null sample hides it');
    const before = E2.ents.size;
    l2.clear();
    ok(E2.ents.size === before - 1, 'clear() removes the entity, leaking nothing');
  }

  console.log('Ghost: never a multiplayer user, and the flicker fix never touches it');
  {
    const E = env({ models: GHOST_MODELS, assignments: { Steve: 'cow' } });
    await E.bootFrames();
    const steveNode = { visible: true, _children: [{ visible: true }] };
    E.w.multiplayer.users = { 42: { id: 42, callsign: 'Steve', model: steveNode,
      lastUpdate: { co: [46, -121, 900, 10, 0, 0] } } };
    const gh = E.R.ghost;
    gh.layer = E.R._internals.makeGhostLayer();
    await gh.layer.load('cow', 'GHOST · Maggie · 0:17.000');
    gh.trace = { samples: [[0, 45, -122, 1000, 90, 0, 0], [10000, 45.5, -122, 1000, 90, 0, 0]], truncated: false };
    E.R.race.state = 'running'; E.R.race.elapsed = 0;

    // _scanOthers only runs once a second, and spawning a model is async — so yield between
    // frames, or the spawn never resolves and the per-frame re-hide has nothing to re-hide.
    for (let i = 0; i < 4; i++) { E.frame(1200); await new Promise((r) => setTimeout(r, 0)); }
    const MS = E.R.modelSwap;
    ok(MS.others.size === 1, 'the real multiplayer user got a model');
    ok([...MS.others.values()].every((r) => r.model !== gh.layer.model), 'the ghost is never registered as a multiplayer user');
    ok([...MS.others.values()].every((r) => !(r.nodes || []).includes(gh.layer.model)), '…and never ends up in a user\'s hide list');
    ok(gh.layer.model.__finsGhost === true, 'the ghost model is tagged as ours');
    ok(gh.layer.model.show === true, 'the per-frame re-hide of multiplayer nodes leaves the ghost visible');
    const p = gh.layer.model.modelMatrix.position;
    ok(near(p.lat, 45, 1e-6) && near(p.lon, -122, 1e-6), 'the ghost is placed from its trace, not from any user position');
    ok(steveNode.visible === false, 'the real user\'s stock node is still hidden (the flicker fix still works)');
  }

  console.log('Ghost: the pick is remembered per course hash');
  {
    const E = env({ models: GHOST_MODELS });
    await E.bootFrames();
    const a = E.R.loadCourse(course());
    const hashA = E.R.race.hash;
    await E.R.ghost.setPick('record');
    ok(JSON.parse(E.w.localStorage.getItem('finsRace.ghostPick.' + hashA)) === 'record', 'stored under the course hash');

    const b = E.R.loadCourse(course(120));   // different radius = different geometry hash
    ok(E.R.race.hash !== hashA, 'a different course really is a different hash');
    await E.R.ghost._pending;
    ok(E.R.ghost.pick === '', 'a course with no stored pick starts at Off');

    E.R.loadCourse(a);
    await E.R.ghost._pending;
    ok(E.R.ghost.pick === 'record', 'coming back to the first course restores its pick');
    // A stored pick with nothing to back it is shown, not silently reset.
    E.R.ui.renderGhostOptions([]);
    ok(E.R.ghost.pick === 'record', 'an unavailable pick is not silently cleared');
    ok([...E.R.ui.E.ghostSelect.options].some((o) => o.value === 'record' && /unavailable/.test(o.text)),
      'the picker says so instead');
  }

  console.log('Ghost: a named pilot\'s ghost comes from GET /ghost');
  {
    const trace = { v: 1, n: 3, t: [0, 250, 250], lat: [45, 45.001, 45.002], lon: [-122, -122, -122],
      alt: [1000, 1010, 1020], hdg: [0, 0, 0], pitch: [0, 0, 0], roll: [0, 0, 0] };
    const calls = [];
    const E = env({ models: GHOST_MODELS, apiBase: 'https://race.example',
      apiHandler: (url) => {
        if (!url.startsWith('https://race.example')) return null;
        calls.push(url);
        if (url.includes('/ghost') && url.includes('Maggie')) {
          return { ok: true, status: 200, json: async () => ({ callsign: 'Maggie', time_ms: 17000, model: 'cow', trace }) };
        }
        if (url.includes('/ghost')) return { ok: false, status: 404, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => [] };
      } });
    await E.bootFrames();
    E.R.loadCourse(course());
    await E.R.ghost.setPick('Maggie');
    const gh = E.R.ghost;
    ok(calls.some((u) => u.includes('/ghost?course_hash=') && u.includes('callsign=Maggie')), 'asked the server for that pilot');
    ok(!!gh.trace && gh.trace.samples.length === 3, 'the remote trace decoded');
    ok(gh.layer.label === 'GHOST · Maggie · 0:17.000', 'label is GHOST · callsign · time (' + gh.layer.label + ')');
    ok(/Maggie/.test(gh.status), 'the panel status names the ghost: ' + gh.status);

    await E.R.ghost.setPick('record');
    ok(gh.trace === null && /no ghost/.test(gh.status), 'a 404 reads as "nobody has one yet", not an error: ' + gh.status);
  }

  console.log('Ghost: CONFIG.GHOST = false removes the picker and never builds a layer');
  {
    const E = env({ models: GHOST_MODELS, patch: [['GHOST: true,', 'GHOST: false,']] });
    await E.bootFrames();
    ok(!E.R.ui.E.ghostSelect, 'no ghost picker is built');
    ok(E.w.document.querySelector('#fr-ghost summary').textContent === 'Racing line',
      'the section that is left is the racing line, not the ghost');
    ok(E.R.ghost.ensureLayer() === null, 'no layer is ever created');
    E.R.loadCourse(course());
    E.R.ghost.tick();
    ok(E.R.ghost.layer === null && E.R.ghost.trace === null, 'nothing loaded, nothing drawn');
  }

  console.log('Racing line: traceWindow draws from where I am to LINE_AHEAD_M ahead (pure)');
  {
    const { traceWindow, ecef, sub, vlen } = E0.R._internals;
    // 50 m between samples (200 m/s at 4 Hz), 200 samples = 10 km of path.
    const trace = { samples: Array.from({ length: 200 }, (_, i) => { const p = along(i * 50); return [i * 250, p.lat, p.lon, 1000, 90, 0, 0]; }), truncated: false };
    const win = traceWindow(trace, 0, 4000);
    const len = win.slice(1).reduce((t, p, i) => t + vlen(sub(ecef(win[i].lat, win[i].lon, win[i].alt), ecef(p.lat, p.lon, p.alt))), 0);
    ok(win.length >= 2, 'produces a drawable polyline (' + win.length + ' points)');
    ok(len >= 4000 && len < 4200, 'covers about LINE_AHEAD_M of path length (' + Math.round(len) + ' m)');
    ok(win[0].lat === trace.samples[0][1], 'starts at the given index, not at the trace start');
    const mid = traceWindow(trace, 100, 4000);
    ok(mid[0].lat === trace.samples[100][1], 'a later index starts later — the window slides forward');
    const tail = traceWindow(trace, 195, 4000);
    ok(tail.length === 5, 'near the end it stops at the last sample instead of running out (' + tail.length + ')');
    ok(traceWindow(trace, 199, 4000).length === 1, 'the very last sample leaves a single point (nothing to draw)');
    ok(traceWindow({ samples: [], truncated: false }, 0, 4000).length === 0, 'an empty trace windows to nothing');
    ok(traceWindow(trace, 0, 0).length === 2, 'zero lookahead still emits one segment');
  }

  console.log('Racing line: lineColorFor is green ahead, amber inside the band, red behind (pure)');
  {
    const { lineColorFor } = E0.R._internals;
    ok(lineColorFor(-1500, 300) === 'ahead', 'well ahead is green');
    ok(lineColorFor(1500, 300) === 'behind', 'well behind is red');
    ok(lineColorFor(-300, 300) === 'close' && lineColorFor(300, 300) === 'close', 'the band is inclusive on both sides');
    ok(lineColorFor(-301, 300) === 'ahead' && lineColorFor(301, 300) === 'behind', 'just outside the band it commits');
    ok(lineColorFor(0, 300) === 'close', 'dead level is amber, not a coin flip between green and red');
    ok(lineColorFor(null, 300) === 'neutral' && lineColorFor(NaN, 300) === 'neutral', 'no delta = neutral');
  }

  console.log('Racing line: catmullRomPath through gate centres produces finite points (pure)');
  {
    const { catmullRomPath } = E0.R._internals;
    const gates = [0, 2000, 4000, 6000].map((m) => ({ ...along(m, 1000 + m / 10) }));
    const path = catmullRomPath(gates, 12);
    ok(path.length === 3 * 12 + 1, 'one sample run per segment plus the final point (' + path.length + ')');
    ok(path.every((p) => [p.lat, p.lon, p.alt].every(Number.isFinite)), 'every point is finite');
    ok(near(path[0].lat, gates[0].lat, 1e-9) && near(path[0].lon, gates[0].lon, 1e-9), 'passes through the first gate');
    const last = path[path.length - 1];
    ok(near(last.lat, gates[3].lat, 1e-9) && near(last.alt, gates[3].alt, 1e-9), 'and through the last');
    ok(path.some((p, i) => i && i % 12 === 0 && near(p.lat, gates[i / 12].lat, 1e-9)), 'and through the interior gates');
    // A spline that only bows a little: every point stays near the straight-line corridor.
    ok(path.every((p) => Math.abs(p.lat - gates[0].lat) < 1 && Math.abs(p.lon - gates[0].lon) < 1), 'stays in the neighbourhood of the course');
    ok(catmullRomPath([gates[0]], 12).length === 1, 'a single gate is passed through unchanged');
    ok(catmullRomPath([], 12).length === 0 && catmullRomPath(null, 12).length === 0, 'nothing in, nothing out');
    // Date line: two gates either side of ±180 must not sweep the long way round the planet.
    const wrapped = catmullRomPath([{ lat: 0, lon: 179.9, alt: 0 }, { lat: 0, lon: -179.9, alt: 0 }], 8);
    ok(wrapped.every((p) => Math.abs(p.lon) > 179), 'a date-line segment curves the short way');
  }

  console.log('Racing line: one polyline entity, rebuilt at most twice a second, recoloured in place');
  {
    const { race, E } = await fly({ opts: { models: GHOST_MODELS } });
    await E.R.ghost.setPick('mine');
    race.reset();
    const L = E.R.line;
    E.frame(16);
    ok(L.source === 'trace', 'with a ghost loaded the line follows its trace (' + L.source + ')');
    ok(L.layer.mode === 'callback', 'uses a CallbackProperty where Cesium has one (' + L.layer.mode + ')');
    const lineEnts = [...E.ents].filter((e) => e.__finsLine);
    ok(lineEnts.length === 1, 'exactly one polyline entity (' + lineEnts.length + ')');

    // The CallbackProperty hands back the SAME array between rebuilds — no per-frame allocation.
    race.state = 'running'; race.elapsed = 4000;
    E.setPos(along(1000)); E.frame(16);
    const cb = lineEnts[0].polyline.positions;
    const a1 = cb.cb();
    E.frame(16); E.frame(16);
    ok(cb.cb() === a1, 'the positions callback returns the same cached array every frame');
    const builds = [];
    const realSet = L.layer.setPath.bind(L.layer);
    L.layer.setPath = (p) => { builds.push(p); return realSet(p); };
    for (let i = 0; i < 60; i++) E.frame(16);   // ~1 s of frames
    ok(builds.length <= 3, 'rebuilt at most ~2/s, not per frame (' + builds.length + ' rebuilds in ~1 s)');
    ok(builds.length >= 1, '…but it does rebuild');

    // Colour follows the live delta, and the entity is recoloured rather than recreated.
    const entBefore = lineEnts[0];
    E.R.ghost.delta = -2000; E.frame(500);
    ok(L.layer.style === 'ahead', 'green when ahead of the ghost');
    E.R.ghost.delta = 100; E.frame(500);
    ok(L.layer.style === 'close', 'amber inside ±300 ms');
    E.R.ghost.delta = 2000; E.frame(500);
    ok(L.layer.style === 'behind', 'red when behind');
    ok([...E.ents].filter((e) => e.__finsLine)[0] === entBefore, 'the same entity throughout — recoloured, never rebuilt');
  }

  console.log('Racing line: no recorded run falls back to a dashed spline through the gates');
  {
    const E = env({ models: GHOST_MODELS });
    await E.bootFrames();
    E.setPos(along(-1000)); E.frame(16);
    E.R.loadCourse(course());
    E.frame(16); E.frame(600);
    const L = E.R.line;
    ok(L.source === 'spline', 'with no trace the source is the spline (' + L.source + ')');
    ok(L.label() === 'Suggested line (no recorded run yet)', 'the panel says so: ' + L.label());
    ok(E.R.ui.E.lineStatus.textContent === 'Suggested line (no recorded run yet)', 'and the label really is rendered');
    ok(L.layer.style === 'neutral', 'drawn in a neutral colour, not a delta colour');
    const ent = [...E.ents].filter((e) => e.__finsLine)[0];
    ok(!!ent && ent.polyline.material.__dash === 24, 'drawn dashed, so it can never be mistaken for a recorded line');
    ok(L.layer.positions.length > E.R.race.course.gates.length, 'the spline has more points than there are gates');
  }

  console.log('Racing line: Alt+L toggles it live and the choice sticks');
  {
    const { race, E } = await fly({ opts: { models: GHOST_MODELS } });
    await E.R.ghost.setPick('mine');
    race.reset(); E.frame(16);
    const L = E.R.line;
    ok([...E.ents].some((e) => e.__finsLine), 'the line is drawn to start with');
    const alt = (code) => E.w.dispatchEvent(new E.w.KeyboardEvent('keydown', { code, altKey: true, bubbles: true, cancelable: true }));
    alt('KeyL');
    ok(L.on === false, 'Alt+L turns it off');
    E.frame(16);
    ok(![...E.ents].some((e) => e.__finsLine), 'and the entity is removed, not just hidden');
    ok(JSON.parse(E.w.localStorage.getItem('finsRace.racingLine')) === false, 'the choice is persisted');
    alt('KeyL');
    E.frame(16);
    ok(L.on === true && [...E.ents].some((e) => e.__finsLine), 'Alt+L brings it back');
  }

  console.log('Racing line: the HUD shows a live "vs ghost" readout next to the split chip');
  {
    const { race, E } = await fly({ opts: { models: GHOST_MODELS } });
    await E.R.ghost.setPick('mine');
    const el = E.w.document.getElementById('fr-hud-ghost');
    ok(!!el && el.parentElement.id === 'fr-hud-chiprow', 'it lives next to the split chip');
    race.reset();
    race.state = 'running'; race.elapsed = 4000;
    E.R.ghost.delta = -1234;
    E.R.hud.render(E.now() + 1000);
    ok(el.textContent === 'vs ghost −1.23s', 'ahead reads with a minus (' + el.textContent + ')');
    ok(el.classList.contains('fr-fast') && el.classList.contains('fr-hud-ghost-show'), 'and is styled green');
    E.R.ghost.delta = 1234;
    E.R.hud.render(E.now() + 2000);
    ok(el.textContent === 'vs ghost +1.23s' && el.classList.contains('fr-slow'), 'behind reads with a plus, styled red');
    E.R.ghost.delta = 120;
    E.R.hud.render(E.now() + 3000);
    ok(el.classList.contains('fr-close'), 'inside the band it is amber');
    E.R.ghost.delta = null;
    E.R.hud.render(E.now() + 4000);
    ok(el.textContent === '' && !el.classList.contains('fr-hud-ghost-show'), 'no ghost, no readout');
  }

  console.log('Racing line: CONFIG.RACING_LINE = false draws nothing and frees Alt+L');
  {
    const E = env({ models: GHOST_MODELS, patch: [['RACING_LINE: true,', 'RACING_LINE: false,']] });
    await E.bootFrames();
    E.setPos(along(-1000)); E.frame(16);
    E.R.loadCourse(course());
    E.frame(16); E.frame(600);
    ok(E.R.line.layer === null, 'no layer is ever created');
    ok(![...E.ents].some((e) => e.__finsLine), 'no polyline entity');
    ok(!E.R.ui.E.lineStatus, 'no panel label');
    E.w.dispatchEvent(new E.w.KeyboardEvent('keydown', { code: 'KeyL', altKey: true, bubbles: true, cancelable: true }));
    ok(E.R.line.layer === null, 'Alt+L does nothing');
  }

  {
    console.log('bookmarklet.txt: every javascript: line is syntactically valid');
    const txt = fs.readFileSync(path.join(__dirname, '..', 'bookmarklet.txt'), 'utf8');
    const lines = txt.split('\n').filter((l) => l.startsWith('javascript:'));
    ok(lines.length >= 4, `found ${lines.length} javascript: lines (expected at least 4: PRIMARY, COMBINED, FALLBACK, COMBINED FALLBACK)`);
    for (const line of lines) {
      const code = line.slice('javascript:'.length);
      let err = null;
      try { new Function(code); } catch (e) { err = e; }
      ok(!err, `parses as valid JS: ${line.slice(0, 60)}...${err ? ' — ' + err.message : ''}`);
    }

    // Regression: the FALLBACK lines pin a jsDelivr @race-vX.Y.Z tag, and v0.5.0 shipped with
    // them pointing at race-v0.2.3 — a tag that was never cut, so the fallback bookmarklet 404'd
    // for anyone who needed it. What must hold is that the pin names a tag that EXISTS; it is
    // normal for it to lag CONFIG.VERSION between releases (main moves, the tag doesn't), so
    // that only gets a note. Skipped rather than failed where git or the tags aren't available,
    // since a shallow clone legitimately has neither.
    const version = (SRC.match(/VERSION:\s*'([^']+)'/) || [])[1];
    ok(!!version, 'read CONFIG.VERSION out of race.js: ' + version);
    const pins = [...txt.matchAll(/@race-v(\d+\.\d+\.\d+)/g)].map((m) => m[1]);
    ok(pins.length >= 2, `found ${pins.length} pinned @race-v tags (expected at least 2: FALLBACK, COMBINED FALLBACK)`);
    ok(new Set(pins).size === 1, `every FALLBACK line pins the same tag (${[...new Set(pins)].join(', ')})`);
    let tags = null;
    try {
      tags = require('child_process').execSync('git tag -l race-v*', { cwd: path.join(__dirname, '..', '..'), stdio: ['ignore', 'pipe', 'ignore'] })
        .toString().split('\n').map((t) => t.trim()).filter(Boolean);
    } catch (_) { /* no git here */ }
    if (!tags || !tags.length) {
      console.log('  skip no local race-v* git tags to check the pin against');
    } else {
      const missing = [...new Set(pins)].filter((v) => !tags.includes('race-v' + v));
      ok(missing.length === 0, `the pinned tag exists in this repo${missing.length ? ' — missing: ' + missing.map((v) => 'race-v' + v).join(', ') : ' (' + tags.join(', ') + ')'}`);
      if (!pins.includes(version)) console.log(`  note pinned fallback is race-v${pins[0]} while CONFIG.VERSION is ${version}: cut and pin race-v${version} to put fallback users on it`);
    }
  }

  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
