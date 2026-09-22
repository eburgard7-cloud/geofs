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
  patch = null, quotaFull = false, apiHandler = null, sceneTransforms = 'old', reducedMotion = false, altitudeAGL = undefined } = {}) {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { runScripts: 'outside-only', url: 'https://www.geo-fs.com/geofs.php' });
  const w = dom.window;
  let rafCb = null;
  w.requestAnimationFrame = (cb) => { rafCb = cb; return 1; };
  const logs = [];
  // Captured, not printed: the velocity-frame capture logs through console.log by design, and
  // the tests assert on it. console.error still goes to the terminal so a frame error is loud.
  w.console = { ...console, warn() {}, log(...a) { logs.push(a); } };
  w.fetch = async (url, init) => {
    // Leaderboard/ghost API stub: a test supplies apiHandler(url, init) and returns a fetch-like
    // response for the routes it cares about, or null to fall through to the model fixtures.
    // `init` is the request options (method, body), for a test that wants to read what was POSTed.
    if (apiHandler) { const r = apiHandler(String(url), init); if (r) return r; }
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
    Transforms: {
      headingPitchRollToFixedFrame: (position, hpr) => ({ __matrix: true, position, hpr }),
      // 0.10.0: the item-box cube spins, which needs an orientation property.
      headingPitchRollQuaternion: (position, hpr) => ({ __quat: true, position, hpr }),
    },
    Math: { toRadians: (d) => d * Math.PI / 180 },
  };
  // Screen-space projection for the HUD's waypoint bracket. `projector.fn` is swapped by tests
  // to put a gate anywhere on (or off) screen; returning undefined is what real Cesium does for
  // a point behind the camera. 'old'/'new' pick which of the two API spellings exists, and
  // 'none' simulates a build that has neither.
  const projector = { fn: () => ({ x: 400, y: 300 }) };
  if (sceneTransforms === 'old') w.Cesium.SceneTransforms = { wgs84ToWindowCoordinates: (scene, cart) => projector.fn(cart, scene) };
  else if (sceneTransforms === 'new') w.Cesium.SceneTransforms = { worldToWindowCoordinates: (scene, cart) => projector.fn(cart, scene) };
  else if (sceneTransforms === 'none') w.Cesium.SceneTransforms = {};
  // The element GeoFS renders into, which is what the hit shake transforms (a CSS transform on
  // this and nothing else — see Shake). Real Cesium hands out scene.canvas inside a widget div.
  const widget = w.document.createElement('div');
  widget.id = 'cesiumContainer';
  const canvas = w.document.createElement('canvas');
  widget.append(canvas);
  w.document.body.append(widget);
  // prefers-reduced-motion. jsdom has no matchMedia at all, so this is the whole implementation
  // the shake ever sees.
  w.matchMedia = (q) => ({ matches: reducedMotion && /reduced-motion/.test(String(q)), media: String(q),
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
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
      add: (o) => {
        const e = { ...o, ellipsoid: o.ellipsoid && { ...o.ellipsoid }, box: o.box && { ...o.box },
          polyline: o.polyline && { ...o.polyline }, point: o.point && { ...o.point }, show: true };
        ents.add(e); return e;
      },
      remove: (e) => ents.delete(e) },
      scene: { primitives, canvas } } },
    animation: { values: { heading360: 90, kias: 400, pitch: 5, roll: -10,
      ...(altitudeAGL === undefined ? {} : { altitudeAGL }) } },
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
  return { w, R, ents, state, primitives, stockNode, frame, bootFrames, fakeMap, mapRecord: fakeL.record, wsRecord, logs, instance, quotaBlocked, projector, widget, canvas,
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
// Gate spheres/poles only — the ghost, the racing line and the item layer share viewer.entities
// and tag their own.
const gateEnts = (E) => [...E.ents].filter((e) => !e.__finsLine && !e.__finsGhost && !e.__finsItem);
// Item-layer entities (projectiles, bananas, goop blobs, boost trails, shields): 0.10.0.
const itemEnts = (E) => [...E.ents].filter((e) => e.__finsItem);

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

  console.log('Items: itemBoxes normalizes a list, reads the legacy single itemBox, and is not hashed');
  {
    const { Course, MAX_ITEM_BOXES } = E0.R._internals;
    const box = { ...along(1000), radius: 120 };
    ok(JSON.stringify(Course.normalize(course()).itemBoxes) === '[]', 'a course with no boxes normalizes to []');
    const withBoxes = Course.normalize(course(150, { itemBoxes: [box, { ...along(2500), radius: 90 }] }));
    ok(withBoxes.itemBoxes.length === 2 && near(withBoxes.itemBoxes[0].radius, 120, 1e-9), 'a valid itemBoxes list round-trips');
    // 0.9.0 wrote a single `itemBox`; every shipped course file predates the list.
    const legacy = Course.normalize(course(150, { itemBox: box }));
    ok(legacy.itemBoxes.length === 1 && near(legacy.itemBoxes[0].lat, box.lat, 1e-9), 'a legacy single itemBox reads as a one-element list');
    ok(Course.normalize(course(150, { itemBoxes: [box], itemBox: { ...along(3000) } })).itemBoxes.length === 1,
      'itemBoxes wins over the legacy key when both are present');
    ok(Course.normalize(course(150, { itemBoxes: [{ lat: 91, lon: 0, alt: 0 }] })).itemBoxes.length === 0, 'an out-of-range box is dropped, not thrown');
    ok(Course.normalize(course(150, { itemBoxes: 'banana' })).itemBoxes.length === 0, 'a non-array itemBoxes is dropped');
    ok(Course.normalize(course(150, { itemBox: 'banana' })).itemBoxes.length === 0, 'a non-object legacy itemBox is dropped');
    ok(Course.normalize(course(150, { itemBoxes: [{ lat: 1, lon: 2, alt: 3 }] })).itemBoxes[0].radius === E0.R.config.DEFAULT_RADIUS_M, 'box radius defaults like a gate');
    const many = Course.normalize(course(150, { itemBoxes: Array.from({ length: 40 }, (_, i) => ({ ...along(500 + i * 50), radius: 100 })) }));
    ok(many.itemBoxes.length === MAX_ITEM_BOXES, 'the list is capped at MAX_ITEM_BOXES (' + many.itemBoxes.length + ')');

    // Adding boxes must never reset a course's leaderboard — the hash covers gate geometry and
    // the aircraft rule only, and this is the assertion that keeps it that way.
    const bare = Course.hash(Course.normalize(course()));
    ok(bare === Course.hash(withBoxes), 'adding item boxes is excluded from the course hash');
    ok(bare === Course.hash(legacy), 'a legacy box is excluded from the course hash too');
    ok(bare === Course.hash(many), 'even 24 boxes leave the hash alone');
  }

  console.log('Items: boxes render as spinning cubes, go dark on a pickup, fade back in, and never leak');
  {
    const E = env();
    await E.bootFrames();
    const boxed = course(150, { itemBoxes: [{ ...along(1000), radius: 120 }, { ...along(1000, 1000, 120), radius: 120 }] });
    E.R.loadCourse(boxed);
    ok(gateEnts(E).length === 10, '3 gates + 2 item boxes = 10 entities (bodies + poles), got ' + gateEnts(E).length);
    const cubes = [...E.ents].filter((e) => e.box);
    ok(cubes.length === 2, 'boxes draw as cubes, not spheres (' + cubes.length + ')');
    ok(cubes.every((e) => e.label && e.label.text === '?'), 'each cube is labelled "?"');
    ok(cubes.every((e) => e.orientation && e.orientation.cb), 'each cube carries an orientation callback (the slow spin)');
    const before = cubes[0].orientation.cb();
    E.frame(2000);
    ok(JSON.stringify(cubes[0].orientation.cb()) !== JSON.stringify(before), 'the cube spins over time');

    // Repeated loads must not accumulate box entities (draw() clears first).
    E.R.loadCourse(boxed);
    ok(gateEnts(E).length === 10, 'reloading the same course does not leak box entities (' + gateEnts(E).length + ')');

    // A pickup darkens that box only, for CONFIG.BOX_RESPAWN_MS, and leaves the other lit.
    E.R.race.boxReadyAt[0] = E.now() + E.R.config.BOX_RESPAWN_MS;
    E.frame(16);
    const bodies = [...E.ents].filter((e) => e.box);
    ok(bodies[0].show === false && bodies[1].show === true, 'the taken box goes dark, its neighbour stays lit');
    for (let i = 0; i < Math.ceil(E.R.config.BOX_RESPAWN_MS / 100) + 2; i++) E.frame(100);
    ok(bodies[0].show === true, 'the box fades back in once the cooldown is up');

    // A course with no box draws none.
    E.R.loadCourse(course());
    ok(gateEnts(E).length === 6, 'a course without item boxes draws gates only (' + gateEnts(E).length + ')');
  }

  console.log('Items: a box never triggers while merely armed, and re-arms on its own cooldown');
  {
    const boxAt = { ...along(-500), radius: 150 };   // behind the start, crossed before the race begins
    const E = env({ apiBase: 'https://relay.test' });
    await E.bootFrames();
    E.setPos(along(-1000)); E.frame(16);
    E.R.loadCourse(course(150, { itemBoxes: [boxAt] }));
    // Taxi through the box while still armed (before leaving the start sphere).
    for (let m = -1000; m < -300; m += 50) { E.setPos(along(m)); E.frame(100); }
    ok(E.R.race.state === 'armed', 'still armed');
    ok(E.R.race.boxReadyAt[0] === 0, 'the box does not trigger while armed (no farming it pre-race)');
    ok(E.R.powerups.state.slots[2] === null, 'no box item carried yet');
  }

  console.log('Items: a box crossing names which box, cools down, and re-triggers once relit');
  {
    const E = env({ apiBase: 'https://relay.test' });
    await E.bootFrames();
    E.setPos(along(-1000)); E.frame(16);
    E.R.loadCourse(course(150, { itemBoxes: [{ ...along(1000), radius: 150 }, { ...along(3000), radius: 150 }] }));
    E.R.race.emit('start');
    E.wsRecord.last.fireOpen();
    const events = [];
    E.R.race.on((ev, d) => { if (ev === 'itembox') events.push(d); });

    // Fly the whole course; both boxes are on the line.
    let m = -1000;
    while (m < 5000 && E.R.race.state !== 'finished') { m += 200 / 60; E.setPos(along(m)); E.frame(1000 / 60); }
    ok(events.length === 2, 'crossed both boxes (' + events.length + ')');
    ok(events[0].id === 0 && events[1].id === 1, 'each crossing names its own box (' + JSON.stringify(events.map((e) => e.id)) + ')');
    const sent = E.wsRecord.last.ofType('box');
    ok(sent.length === 2 && sent[0].id === 0 && sent[1].id === 1, 'the id goes to the relay: ' + JSON.stringify(sent));
    ok(E.R.race.state === 'finished' && E.R.race.splits.length === 2, 'boxes still never count as progress');
  }

  console.log('Items: a relay box_state darkens a box for everyone, on the relay\'s clock');
  {
    const E = env({ apiBase: 'https://relay.test' });
    await E.bootFrames();
    E.setPos(along(-1000)); E.frame(16);
    E.R.loadCourse(course(150, { itemBoxes: [{ ...along(1000), radius: 150 }] }));
    E.R.race.emit('start');
    const ws = E.wsRecord.last;
    ws.fireOpen();
    ws.fireMessage({ type: 'joined', room: 'r', proto: 3, server_ms: Date.now() });
    // Somebody else took it: dark until 3 s from now on the SERVER clock.
    ws.fireMessage({ type: 'box_state', id: 0, until_server_ms: Date.now() + 3000 });
    ok(E.R.race.boxReadyAt[0] > E.now(), 'the box is on cooldown after box_state');
    E.frame(16);
    ok([...E.ents].filter((e) => e.box)[0].show === false, 'and it is hidden');
    // Junk off the wire must never darken a box forever.
    ws.fireMessage({ type: 'box_state', id: 99, until_server_ms: Date.now() + 1e12 });
    ws.fireMessage({ type: 'box_state', id: 0, until_server_ms: 'soon' });
    ok(E.R.race.boxReadyAt[0] > E.now() && E.R.race.boxReadyAt[0] < E.now() + 2 * E.R.config.BOX_RESPAWN_MS,
      'a nonsense box_state is ignored and the cooldown stays bounded');
  }

  console.log('Items: Alt+B drops an item box, Alt+Shift+B drops a row of three');
  {
    const E = env();
    await E.bootFrames();
    E.setPos(along(0)); E.frame(16);
    const key = (shift) => E.w.dispatchEvent(new E.w.KeyboardEvent('keydown', { code: 'KeyB', altKey: true, shiftKey: shift, bubbles: true }));
    key(false);
    ok(E.R.editor.boxes.length === 1, 'Alt+B drops one box (' + E.R.editor.boxes.length + ')');
    const { ecef, sub, vlen } = E.R._internals;
    const p = E.lla();
    ok(near(E.R.editor.boxes[0].lat, p[0], 1e-5) && near(E.R.editor.boxes[0].lon, p[1], 1e-5), 'at the aircraft');
    key(true);
    ok(E.R.editor.boxes.length === 4, 'Alt+Shift+B adds three more (' + E.R.editor.boxes.length + ')');
    const row = E.R.editor.boxes.slice(1);
    const d = (a, b) => vlen(sub(ecef(a.lat, a.lon, a.alt), ecef(b.lat, b.lon, b.alt)));
    ok(near(d(row[0], row[1]), 120, 3) && near(d(row[1], row[2]), 120, 3), 'the row is 120 m apart (' + d(row[0], row[1]).toFixed(1) + ' m)');
    // Heading is 090 in the fixture, so a row "across" it runs north-south: same longitude.
    ok(near(row[0].lon, row[2].lon, 1e-4), 'the row is laid across the current heading');
    E.R.editor.undoBox();
    ok(E.R.editor.boxes.length === 3, 'undo box pops one');
    // A built course carries them.
    E.R.ui.E.edName.value = 'Boxy';
    E.R.editor.draft = [along(0), along(2000)].map((g) => ({ ...g, radius: 150 }));
    const built = E.R.editor.build();
    ok(built.itemBoxes.length === 3, 'the built course carries the boxes (' + built.itemBoxes.length + ')');
    E.R.editor.clear();
    ok(E.R.editor.boxes.length === 0, 'clear drops the boxes too');
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
    const fires = ws.ofType('fire');
    ok(fires.length === 1 && fires[0].item === 'missile', 'sent one fire for exactly the granted item: ' + JSON.stringify(fires));
    // proto 3, additive: the heading rides along so the relay can drop a banana BEHIND you.
    ok(fires[0].heading === 90, 'the fire carries the current heading (' + fires[0].heading + ')');
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

  // -------------------------------------------------------------- items (proto 3)
  // A helper that gets a client all the way to "connected to a proto-3 relay, mid-race", which
  // is the state every item effect needs before it exists at all.
  async function itemsEnv(opts = {}) {
    const E = env({ apiBase: 'https://relay.test', ...opts });
    await E.bootFrames();
    E.setPos(along(0)); E.frame(16);
    E.R.loadCourse(course());
    E.R.race.emit('start');
    const ws = E.wsRecord.last;
    ws.fireOpen();
    ws.fireMessage({ type: 'joined', room: 'r', proto: 3, server_ms: Date.now() });
    E.frame(16);
    return { E, ws };
  }

  console.log('Items: projectilePos lerps from the launch point to the target\'s CURRENT position (pure)');
  {
    const { projectilePos } = E0.R._internals;
    const from = { lat: 45, lon: -122, alt: 1000 }, to = { lat: 45.02, lon: -121.98, alt: 1400 };
    const a = projectilePos(from, to, 0, 2000);
    ok(a.lat === 45 && a.lon === -122 && a.alt === 1000 && a.f === 0, 'f=0 is exactly the launch point');
    const b = projectilePos(from, to, 2000, 2000);
    ok(near(b.lat, to.lat, 1e-9) && near(b.lon, to.lon, 1e-9) && near(b.alt, to.alt, 1e-9) && b.f === 1, 'f=1 is exactly the target');
    const mid = projectilePos(from, to, 1000, 2000);
    ok(near(mid.lat, 45.01, 1e-9) && near(mid.alt, 1200, 1e-9), 'halfway is halfway');
    ok(projectilePos(from, to, 9999, 2000).f === 1, 'past the flight time it clamps at the target');
    ok(projectilePos(from, to, -50, 2000).f === 0, 'a negative elapsed clamps at the launch point');
    ok(projectilePos(null, to, 0, 1000) === null && projectilePos(from, null, 0, 1000) === null, 'a missing endpoint is null, never a guess');
    ok(projectilePos(from, { lat: 1, lon: NaN, alt: 1 }, 0, 1000) === null, 'a non-finite endpoint is null');
    // Homing: re-reading a moving target each frame bends the path. Two calls at the same
    // elapsed with the target in different places must give different answers.
    const t1 = projectilePos(from, to, 1000, 2000);
    const t2 = projectilePos(from, { ...to, lat: to.lat + 0.05 }, 1000, 2000);
    ok(t1.lat !== t2.lat, 'a target that moved pulls the projectile with it (it homes)');
    // Antimeridian: the short way round, not three-quarters of the planet.
    const west = projectilePos({ lat: 0, lon: 179, alt: 0 }, { lat: 0, lon: -179, alt: 0 }, 500, 1000);
    ok(Math.abs(west.lon) > 179.9, 'a shot across the antimeridian goes the short way (' + west.lon + ')');
  }

  console.log('Items: rouletteFrames always ends on the item the relay actually rolled (pure)');
  {
    const { rouletteFrames, rouletteFrameAt, ROULETTE_POOL } = E0.R._internals;
    for (const item of ['banana', 'goop', 'boost', 'missile', 'shield', 'nothing']) {
      for (const seed of [1, 2, 7, 12345, 99999999, 0, -3]) {
        const f = rouletteFrames(seed, item, 12);
        ok(f.length === 12 && f[f.length - 1] === item,
          'seed ' + seed + ' rolling ' + item + ' ends on ' + f[f.length - 1]);
      }
    }
    // Same seed, same spin: a reveal is deterministic, so two clients watching one grant agree.
    ok(JSON.stringify(rouletteFrames(42, 'boost', 12)) === JSON.stringify(rouletteFrames(42, 'boost', 12)), 'the spin is seeded, not random');
    ok(JSON.stringify(rouletteFrames(42, 'boost', 12)) !== JSON.stringify(rouletteFrames(43, 'boost', 12)), 'different seeds spin differently');
    // A junk item off the wire can never be spun into something carryable.
    ok(rouletteFrames(1, 'nuclear-option', 12).pop() === 'nothing', 'an unknown roll reveals "nothing"');
    ok(rouletteFrames(1, 'missile', 12).slice(0, -1).every((x) => ROULETTE_POOL.includes(x)), 'every intermediate frame is from the pool');
    ok(rouletteFrames(1, 'missile', 1).length === 1, 'a one-frame roulette is just the reveal');

    const frames = rouletteFrames(5, 'goop', 10);
    ok(rouletteFrameAt(frames, 0, 1500) === frames[0], 'at t=0 the first face shows');
    ok(rouletteFrameAt(frames, 1500, 1500) === 'goop', 'at the end the reveal shows');
    ok(rouletteFrameAt(frames, 99999, 1500) === 'goop', 'and it keeps showing after that');
    ok(rouletteFrameAt([], 0, 1500) === null, 'no frames is null, not a throw');
  }

  console.log('Items: penaltyTarget takes 25% off but never goes under the floor (pure)');
  {
    const { penaltyTarget } = E0.R._internals;
    ok(penaltyTarget(200, 110) === 150, '200 m/s -> 150');
    ok(penaltyTarget(140, 110) === 110, '140 m/s would be 105, so the floor wins');
    ok(penaltyTarget(110, 110) === 110, 'at the floor it stays at the floor');
    ok(penaltyTarget(50, 110) === 110, 'below the floor it is never pushed lower');
    ok(penaltyTarget(0, 110) === null && penaltyTarget(-5, 110) === null, 'no current speed -> no penalty at all');
    ok(penaltyTarget(NaN, 110) === null, 'a non-finite speed -> no penalty');
    ok(penaltyTarget(200, 0) === 150, 'a zero floor still only takes 25% off');
  }

  console.log('Items: makeItemLayer enforces the entity budget and a client-side TTL');
  {
    const E = env();
    await E.bootFrames();
    const { makeItemLayer } = E0.R._internals;
    const layer = E.R._internals.makeItemLayer();
    const opts = () => ({ position: { x: 0 }, point: { pixelSize: 4 } });
    const budget = E.R.config.ITEM_ENTITY_BUDGET;
    for (let i = 0; i < budget + 15; i++) layer.add('k' + i, opts(), 10000, 0);
    ok(layer.count() === budget, 'the layer never holds more than the budget (' + layer.count() + ' of ' + budget + ')');
    ok(layer.evicted === 15, 'the excess was evicted (' + layer.evicted + ')');
    ok(layer.get('k0') === null, 'the OLDEST entity is the one that went');
    ok(layer.get('k' + (budget + 14)) !== null, 'the newest is still there');
    ok(itemEnts(E).length === budget, 'and the viewer holds exactly that many (' + itemEnts(E).length + ')');

    // TTL: enforced here, on this client's own clock, so a clearing frame that never arrives
    // still cannot leave an effect on screen.
    layer.clear();
    ok(layer.count() === 0 && itemEnts(E).length === 0, 'clear() removes every entity');
    layer.add('short', opts(), 500, 1000);
    layer.add('long', opts(), 5000, 1000);
    layer.prune(1400);
    ok(layer.count() === 2, 'nothing expires early');
    layer.prune(1600);
    ok(layer.count() === 1 && layer.get('short') === null && layer.get('long') !== null, 'only the expired one goes');
    ok(layer.touch('long', 200, 1600) && (layer.prune(1900), layer.count() === 0), 'touch() re-dates an entity and the TTL still lands');

    // Re-adding a key replaces rather than stacking.
    layer.add('dup', opts(), 1000, 0);
    layer.add('dup', opts(), 1000, 0);
    ok(layer.count() === 1 && itemEnts(E).length === 1, 're-adding a key replaces the entity (' + layer.count() + ')');

    // A throwing viewer turns the layer off instead of throwing into the race loop.
    const realAdd = E.w.geofs.api.viewer.entities.add;
    E.w.geofs.api.viewer.entities.add = () => { throw new Error('nope'); };
    let threw = false;
    try { layer.add('boom', opts(), 1000, 0); } catch (_) { threw = true; }
    ok(!threw && layer.ok === false && layer.count() === 0, 'a Cesium throw fails closed');
    E.w.geofs.api.viewer.entities.add = realAdd;
  }

  console.log('Items: everything stays dark against a relay older than proto 3');
  {
    const E = env({ apiBase: 'https://relay.test' });
    await E.bootFrames();
    E.setPos(along(0)); E.frame(16);
    E.R.loadCourse(course());
    E.R.race.emit('start');
    const ws = E.wsRecord.last;
    ws.fireOpen();
    ws.fireMessage({ type: 'joined', room: 'r', proto: 2, server_ms: Date.now() });
    ok(E.R.items.active() === false, 'the items layer knows the relay is too old');
    ok(/proto 2/.test(E.R.relay.status), 'and the status line says so: ' + E.R.relay.status);
    // Frames it would otherwise act on do nothing at all.
    ws.fireMessage({ type: 'fired', id: 1, item: 'missile', from: 'Steve', target: 'Eric', flight_ms: 2000 });
    E.frame(16);
    ok(E.R.items.projectiles.size === 0 && itemEnts(E).length === 0, 'no projectile is drawn');
    ok(E.R.items.inbound === null, 'and no inbound warning');
    // A grant still lands instantly, exactly like 0.9.0 — no roulette against an old relay.
    ws.fireMessage({ type: 'grant', item: 'missile' });
    ok(E.R.powerups.state.slots[2] === 'missile' && E.R.powerups.roll === null, 'a grant is immediate, 0.9.0-style');
  }

  console.log('Items: a box grant spins the slot for BOX_ROLL_MS and cannot be fired until it reveals');
  {
    const { E, ws } = await itemsEnv();
    const PU = E.R.powerups, CFG = E.R.config;
    ws.fireMessage({ type: 'grant', item: 'missile', box: 0 });
    ok(PU.roll !== null, 'the slot is rolling');
    ok(PU.state.slots[2] === null, 'nothing is carried yet');
    ok(PU.rollingItem(E.now()) !== null, 'and an icon is showing while it spins');

    const before = ws.ofType('fire').length;
    PU.useSlot(2, E.now());
    ok(ws.ofType('fire').length === before, 'Alt+3 mid-roll fires nothing');
    ok(PU.roll !== null, 'and does not consume the roll');

    for (let i = 0; i < Math.ceil(CFG.BOX_ROLL_MS / 50) + 2; i++) E.frame(50);
    ok(PU.roll === null, 'the roll ends');
    ok(PU.state.slots[2] === 'missile', 'and reveals exactly what the relay rolled');
    ok(PU.rollingItem(E.now()) === null, 'the slot stops spinning');
    ok(PU.feed.some((l) => /boxed Mustard missile/.test(l)), 'the feed announces the reveal, not the roll: ' + JSON.stringify(PU.feed[0]));
    PU.useSlot(2, E.now());
    ok(ws.ofType('fire').length === before + 1, 'and now it fires');
  }

  console.log('Items: a fired missile is drawn as a homing projectile and lands in a splat');
  {
    const { E, ws } = await itemsEnv();
    // Two other pilots the relay knows about, so the projectile has somewhere to fly.
    ws.fireMessage({ type: 'world', players: [
      { callsign: 'Steve', lat: 45, lon: -122, alt: 1000, gate: 1 },
      { callsign: 'Maggie', lat: 45.02, lon: -121.97, alt: 1400, gate: 2 },
    ] });
    ok(E.R.relay.world && E.R.relay.world.Maggie.alt === 1400, 'the world frame is kept, altitude and all');

    ws.fireMessage({ type: 'fired', id: 7, item: 'missile', from: 'Steve', target: 'Maggie', flight_ms: 2000 });
    E.frame(16);
    const proj = itemEnts(E).filter((e) => e.__finsItem === 'proj:7');
    ok(proj.length === 1, 'exactly one projectile entity (' + proj.length + ')');
    ok(proj[0].point && proj[0].polyline, 'it is a glowing point with a trail polyline');
    ok(E.R.items.inbound === null, 'a shot between two other pilots is not MY problem');

    // It moves toward the target over the flight, and homes when the target moves.
    const first = { ...E.R.items.projectiles.get('7').last };
    for (let i = 0; i < 30; i++) E.frame(16);
    const mid = { ...E.R.items.projectiles.get('7').last };
    ok(mid.lat > first.lat, 'the projectile has moved toward the target (' + first.lat + ' -> ' + mid.lat + ')');
    ws.fireMessage({ type: 'world', players: [
      { callsign: 'Steve', lat: 45, lon: -122, alt: 1000, gate: 1 },
      { callsign: 'Maggie', lat: 45.2, lon: -121.97, alt: 1400, gate: 2 },
    ] });
    E.frame(16);
    const homed = E.R.items.projectiles.get('7').last;
    ok(homed.lat > mid.lat + 0.001, 'the target moving pulls the projectile after it (homing)');
    ok(E.R.items.projectiles.get('7').trail.length > 2, 'the trail is accumulating');

    // Resolution: the projectile goes, a splat appears, and the splat ends on its own TTL.
    ws.fireMessage({ type: 'resolved', id: 7, item: 'missile', from: 'Steve', target: 'Maggie', blocked: false, lost: false });
    ok(E.R.items.projectiles.size === 0, 'the projectile is gone from the bookkeeping');
    E.frame(16);
    ok(itemEnts(E).filter((e) => e.__finsItem === 'proj:7').length === 0, 'and from the scene');
    const splat = itemEnts(E).filter((e) => e.__finsItem === 'splat:7');
    ok(splat.length === 1 && splat[0].ellipsoid, 'a splat sphere landed on the victim');
    const r0 = splat[0].ellipsoid.radii.x;
    for (let i = 0; i < 12; i++) E.frame(16);
    ok(splat[0].ellipsoid.radii.x > r0, 'the splat expands (' + r0 + ' -> ' + splat[0].ellipsoid.radii.x + ')');
    for (let i = 0; i < 40; i++) E.frame(16);
    ok(itemEnts(E).filter((e) => e.__finsItem === 'splat:7').length === 0, 'and it clears itself on its TTL');
  }

  console.log('Items: a blocked missile is a white ring, not a splat');
  {
    const { E, ws } = await itemsEnv();
    ws.fireMessage({ type: 'world', players: [{ callsign: 'Maggie', lat: 45.02, lon: -121.97, alt: 1400, gate: 2 }] });
    ws.fireMessage({ type: 'fired', id: 9, item: 'missile', from: 'Steve', target: 'Maggie', flight_ms: 1500 });
    E.frame(16);
    ws.fireMessage({ type: 'resolved', id: 9, item: 'missile', from: 'Steve', target: 'Maggie', blocked: true, lost: false });
    E.frame(16);
    ok(itemEnts(E).some((e) => e.__finsItem === 'ring:9'), 'a ring flash marks the block');
    ok(!itemEnts(E).some((e) => e.__finsItem === 'splat:9'), 'and no splat');
  }

  console.log('Items: a target that leaves mid-flight leaves nothing behind');
  {
    const { E, ws } = await itemsEnv();
    ws.fireMessage({ type: 'world', players: [{ callsign: 'Maggie', lat: 45.02, lon: -121.97, alt: 1400, gate: 2 }] });
    ws.fireMessage({ type: 'fired', id: 11, item: 'missile', from: 'Steve', target: 'Maggie', flight_ms: 1500 });
    E.frame(16);
    ok(itemEnts(E).some((e) => e.__finsItem === 'proj:11'), 'the projectile exists');
    ws.fireMessage({ type: 'resolved', id: 11, item: 'missile', from: 'Steve', target: 'Maggie', blocked: false, lost: true });
    E.frame(16);
    ok(itemEnts(E).length === 0, 'a lost projectile leaves no splat and no ring (' + itemEnts(E).length + ')');
  }

  console.log('Items: a projectile whose resolution never arrives still cleans itself up');
  {
    const { E, ws } = await itemsEnv();
    ws.fireMessage({ type: 'world', players: [{ callsign: 'Maggie', lat: 45.02, lon: -121.97, alt: 1400, gate: 2 }] });
    ws.fireMessage({ type: 'fired', id: 13, item: 'missile', from: 'Steve', target: 'Eric', flight_ms: 1500 });
    E.frame(16);
    ok(E.R.items.inbound !== null, 'it is aimed at me, so the HUD warning is up');
    // The relay goes away without ever sending `resolved`.
    for (let i = 0; i < 100; i++) E.frame(100);
    ok(E.R.items.projectiles.size === 0, 'the projectile drops itself');
    ok(E.R.items.inbound === null, 'the inbound warning clears with it');
    ok(itemEnts(E).length === 0, 'and nothing is left in the scene');
  }

  console.log('Items: the HUD shows MISSILE INBOUND with a draining bar and a directional arrow');
  {
    const { E, ws } = await itemsEnv();
    const doc = E.w.document;
    const banner = doc.getElementById('fr-hud-inbound'), arrow = doc.getElementById('fr-hud-in-arrow');
    ok(!!banner && !!arrow, 'the warning elements exist');
    ok(!banner.classList.contains('fr-hud-wp-show'), 'hidden with nothing inbound');

    // Race.pos has to exist for the arrow, so fly a moment first.
    E.setPos(along(500)); E.frame(16);
    ws.fireMessage({ type: 'world', players: [{ callsign: 'Steve', lat: 45.001, lon: -122, alt: 1000, gate: 1 }] });
    ws.fireMessage({ type: 'fired', id: 21, item: 'missile', from: 'Steve', target: 'Eric', flight_ms: 4000 });
    E.frame(16);
    ok(banner.classList.contains('fr-hud-wp-show'), 'the banner is up');
    ok(/MISSILE INBOUND from Steve/.test(banner.textContent), 'and names the shooter: ' + banner.textContent);
    const w0 = parseInt(doc.querySelector('#fr-hud-inbound .fr-in-fill').style.width, 10);
    for (let i = 0; i < 60; i++) E.frame(16);
    const w1 = parseInt(doc.querySelector('#fr-hud-inbound .fr-in-fill').style.width, 10);
    ok(w1 < w0, 'the bar drains over the flight time (' + w0 + '% -> ' + w1 + '%)');
    ok(arrow.classList.contains('fr-hud-wp-show') && arrow.textContent.length === 1, 'a directional arrow points at it: ' + arrow.textContent);
    // Off screen, the arrow becomes an edge chevron on the side the projectile is on.
    E.projector.fn = () => ({ x: -500, y: 300 });
    E.frame(16);
    ok(arrow.textContent === '\u25C0', 'off the left edge it is a left chevron: ' + arrow.textContent);

    ws.fireMessage({ type: 'resolved', id: 21, item: 'missile', from: 'Steve', target: 'Eric', blocked: false, lost: false });
    E.frame(16);
    ok(!banner.classList.contains('fr-hud-wp-show') && !arrow.classList.contains('fr-hud-wp-show'), 'both clear on resolution');
  }

  console.log('Items: a goop projectile is green and its inbound banner says GOOP');
  {
    const { E, ws } = await itemsEnv();
    E.setPos(along(500)); E.frame(16);
    ws.fireMessage({ type: 'world', players: [{ callsign: 'Steve', lat: 45.001, lon: -122, alt: 1000, gate: 1 }] });
    ws.fireMessage({ type: 'fired', id: 31, item: 'goop', from: 'Steve', target: 'Eric', flight_ms: 1200 });
    E.frame(16);
    const banner = E.w.document.getElementById('fr-hud-inbound');
    ok(/GOOP INBOUND from Steve/.test(banner.textContent), banner.textContent);
    ok(banner.classList.contains('fr-in-goop'), 'and reads green, not mustard');
  }

  console.log('Items: firing with nobody ahead hands the item back instead of burning it');
  {
    const { E, ws } = await itemsEnv();
    const PU = E.R.powerups;
    ws.fireMessage({ type: 'grant', item: 'missile', box: 0 });
    for (let i = 0; i < Math.ceil(E.R.config.BOX_ROLL_MS / 50) + 2; i++) E.frame(50);
    PU.useSlot(2, E.now());
    ok(PU.state.slots[2] === null, 'the slot empties on the press');
    ws.fireMessage({ type: 'refund', item: 'missile', reason: 'no_target' });
    ok(PU.state.slots[2] === 'missile', 'the refund puts it straight back — no second roulette');
    ok(PU.roll === null, 'and it is immediately fireable');
    ok(PU.feed.some((l) => /No target ahead/.test(l)), 'the feed explains why: ' + JSON.stringify(PU.feed[0]));
  }

  console.log('Items: a dropped banana is a visible object with a pole, and arms late');
  {
    const { E, ws } = await itemsEnv();
    const at = along(1500);
    ws.fireMessage({ type: 'dropped', id: 3, lat: at.lat, lon: at.lon, alt: at.alt,
      from: 'Steve', armed_at_server_ms: Date.now() + 1500 });
    E.frame(16);
    const parts = itemEnts(E).filter((e) => /^ban2?:3$/.test(e.__finsItem));
    ok(parts.length === 2, 'a banana is two crossed ellipsoids (' + parts.length + ')');
    ok(parts.every((e) => e.ellipsoid), 'both are ellipsoids, no asset download');
    ok(parts.some((e) => e.polyline), 'with a pole down to the ground, like a gate');
    ok(E.R.items.bananas.get('3').from === 'Steve', 'the drop is tracked with its owner');

    // Unarmed: dim and steady. Armed: pulsing, so the two states read differently in the air.
    const alphaOf = () => itemEnts(E).find((e) => e.__finsItem === 'ban:3').ellipsoid.material.__alpha;
    E.frame(16);
    const dim = alphaOf();
    ok(near(dim, 0.3, 1e-6), 'an unarmed banana is dim and steady (' + dim + ')');
    for (let i = 0; i < 20; i++) E.frame(100);
    const seen = new Set();
    for (let i = 0; i < 10; i++) { E.frame(60); seen.add(alphaOf().toFixed(3)); }
    ok(seen.size > 1, 'an armed banana pulses (' + seen.size + ' distinct alphas)');
    ok([...seen].every((a) => +a > 0.3), 'and is brighter than the unarmed one');
  }

  console.log('Items: a banana trips client-side at race speed and the claim is sent once');
  {
    const { E, ws } = await itemsEnv();
    // Sitting on the start line, then flying east through a banana 1500 m along.
    E.setPos(along(-1000)); E.frame(16);
    const bananaAt = along(1500);
    ws.fireMessage({ type: 'dropped', id: 5, lat: bananaAt.lat, lon: bananaAt.lon, alt: bananaAt.alt,
      from: 'Steve', armed_at_server_ms: Date.now() - 1 });
    E.frame(16);
    ok(ws.ofType('tripped').length === 0, 'nothing tripped while merely armed (not racing yet)');

    // 400 kt is ~206 m/s; at 5 fps that is 41 m per frame, well past what a 2 Hz relay ping
    // would catch but exactly what the interpolated segment test is for. Push it harder still.
    let m = -1000;
    const speed = 600, dt = 1000 / 5;   // 120 m per frame, through an 80 m sphere
    while (m < 4500 && E.R.race.state !== 'finished') {
      m += speed * dt / 1000;
      E.setPos(along(m));
      E.frame(dt);
    }
    const claims = ws.ofType('tripped');
    ok(claims.length === 1, 'tripped exactly once at 600 m/s / 5 fps (' + claims.length + ')');
    ok(claims[0].id === 5, 'and names the banana it flew into');
  }

  console.log('Items: you never trip your own banana, and never claim one twice');
  {
    const { E, ws } = await itemsEnv();
    E.setPos(along(-1000)); E.frame(16);
    const at = along(1000);
    // Mine.
    ws.fireMessage({ type: 'dropped', id: 8, lat: at.lat, lon: at.lon, alt: at.alt,
      from: 'Eric', armed_at_server_ms: Date.now() - 1 });
    // Somebody else's, further along.
    const at2 = along(3000);
    ws.fireMessage({ type: 'dropped', id: 9, lat: at2.lat, lon: at2.lon, alt: at2.alt,
      from: 'Steve', armed_at_server_ms: Date.now() - 1 });
    let m = -1000;
    while (m < 5000 && E.R.race.state !== 'finished') { m += 200 / 60; E.setPos(along(m)); E.frame(1000 / 60); }
    const claims = ws.ofType('tripped');
    ok(claims.length === 1 && claims[0].id === 9, 'only the other pilot\'s banana was claimed: ' + JSON.stringify(claims));
    ok(E.R.items.claimed.has('9'), 'and it is remembered as claimed, so a second frame inside it sends nothing');
  }

  console.log('Items: an unarmed banana cannot be tripped, so the dropper\'s wingman survives');
  {
    const { E, ws } = await itemsEnv();
    E.setPos(along(-1000)); E.frame(16);
    const at = along(500);
    ws.fireMessage({ type: 'dropped', id: 12, lat: at.lat, lon: at.lon, alt: at.alt,
      from: 'Steve', armed_at_server_ms: Date.now() + 9000 });
    let m = -1000;
    while (m < 2000) { m += 200 / 60; E.setPos(along(m)); E.frame(1000 / 60); }
    ok(ws.ofType('tripped').length === 0, 'flying straight through an unarmed banana claims nothing');
  }

  console.log('Items: a cleared banana leaves the world, and only the reasons that need narrating do');
  {
    const { E, ws } = await itemsEnv();
    const at = along(1500);
    ws.fireMessage({ type: 'dropped', id: 15, lat: at.lat, lon: at.lon, alt: at.alt, from: 'Steve', armed_at_server_ms: Date.now() });
    E.frame(16);
    ok(itemEnts(E).filter((e) => /^ban2?:15$/.test(e.__finsItem)).length === 2, 'it is there');
    ws.fireMessage({ type: 'cleared', id: 15, by: 'Maggie', reason: 'hit' });
    E.frame(16);
    ok(itemEnts(E).filter((e) => /^ban2?:15$/.test(e.__finsItem)).length === 0, 'and gone once cleared');
    ok(E.R.items.bananas.size === 0, 'and out of the bookkeeping');
    ok(E.R.powerups.feed.some((l) => /Maggie hit a banana/.test(l)), 'the feed narrates it: ' + JSON.stringify(E.R.powerups.feed[0]));

    // An expiry is not news.
    const before = E.R.powerups.feed.length;
    ws.fireMessage({ type: 'dropped', id: 16, lat: at.lat, lon: at.lon, alt: at.alt, from: 'Steve', armed_at_server_ms: Date.now() });
    ws.fireMessage({ type: 'cleared', id: 16, by: null, reason: 'expired' });
    ok(E.R.powerups.feed.length === before + 1, 'an expiry adds no line beyond the drop itself');
  }

  console.log('Items: a banana outlives a lost `cleared` frame by its TTL and no longer');
  {
    const { E, ws } = await itemsEnv({ patch: [['BANANA_TTL_MS: 120000,', 'BANANA_TTL_MS: 1500,']] });
    const at = along(1500);
    ws.fireMessage({ type: 'dropped', id: 19, lat: at.lat, lon: at.lon, alt: at.alt, from: 'Steve', armed_at_server_ms: Date.now() });
    E.frame(16);
    ok(itemEnts(E).filter((e) => /^ban2?:19$/.test(e.__finsItem)).length === 2, 'drawn');
    // The relay never says a word about it again.
    for (let i = 0; i < 30; i++) E.frame(100);
    ok(itemEnts(E).filter((e) => /^ban2?:19$/.test(e.__finsItem)).length === 0, 'the client-side TTL removes it anyway');
  }

  console.log('Items: live bananas show on the minimap');
  {
    const { E, ws } = await itemsEnv();
    const at = along(1500);
    ws.fireMessage({ type: 'dropped', id: 22, lat: at.lat, lon: at.lon, alt: at.alt, from: 'Steve', armed_at_server_ms: Date.now() });
    for (let i = 0; i < 6; i++) E.frame(100);
    const marks = E.w.document.querySelectorAll('.fr-mm-bananas circle');
    ok(marks.length === 1, 'one banana marker (' + marks.length + ')');
    ok(+marks[0].getAttribute('cx') > -99, 'placed somewhere real on the map');
    ws.fireMessage({ type: 'cleared', id: 22, by: 'Maggie', reason: 'hit' });
    for (let i = 0; i < 6; i++) E.frame(100);
    ok(E.w.document.querySelectorAll('.fr-mm-bananas circle').length === 0, 'and it goes with the banana');
  }

  console.log('Items: a landed goop trails a green blob on whoever it hit, for everyone else');
  {
    const { E, ws } = await itemsEnv();
    ws.fireMessage({ type: 'world', players: [{ callsign: 'Maggie', lat: 45.02, lon: -121.97, alt: 1400, gate: 2 }] });
    ws.fireMessage({ type: 'fired', id: 41, item: 'goop', from: 'Steve', target: 'Maggie', flight_ms: 1000 });
    E.frame(16);
    ws.fireMessage({ type: 'resolved', id: 41, item: 'goop', from: 'Steve', target: 'Maggie', blocked: false, lost: false });
    E.frame(16);
    const blob = itemEnts(E).filter((e) => e.__finsItem === 'goop:Maggie');
    ok(blob.length === 1 && blob[0].ellipsoid, 'a blob is riding Maggie');
    ok(E.R.items.gooped.get('Maggie') > E.now(), 'and it is time-boxed to the goop duration');

    // It follows her.
    const p0 = blob[0].position;
    ws.fireMessage({ type: 'world', players: [{ callsign: 'Maggie', lat: 45.05, lon: -121.9, alt: 1500, gate: 3 }] });
    E.frame(16);
    ok(JSON.stringify(blob[0].position) !== JSON.stringify(p0), 'the blob tracks her aircraft');

    for (let i = 0; i < Math.ceil(E.R.config.POWERUP_GOOP_MS / 100) + 3; i++) E.frame(100);
    ok(E.R.items.gooped.size === 0, 'it ends with the goop');
    ok(itemEnts(E).filter((e) => e.__finsItem === 'goop:Maggie').length === 0, 'and the blob goes with it');
  }

  console.log('Items: a blocked goop marks nobody');
  {
    const { E, ws } = await itemsEnv();
    ws.fireMessage({ type: 'world', players: [{ callsign: 'Maggie', lat: 45.02, lon: -121.97, alt: 1400, gate: 2 }] });
    ws.fireMessage({ type: 'fired', id: 43, item: 'goop', from: 'Steve', target: 'Maggie', flight_ms: 1000 });
    E.frame(16);
    ws.fireMessage({ type: 'resolved', id: 43, item: 'goop', from: 'Steve', target: 'Maggie', blocked: true, lost: false });
    E.frame(16);
    ok(E.R.items.gooped.size === 0, 'a shield means no blob');
    ok(itemEnts(E).some((e) => e.__finsItem === 'ring:43'), 'just the ring flash');
  }

  console.log('Items: my own goop is the screen overlay, and it clears from the centre outward');
  {
    const { E, ws } = await itemsEnv();
    const fx = E.w.document.getElementById('fr-fx');
    ws.fireMessage({ type: 'hit', item: 'goop', from: 'Steve', id: 51 });
    E.frame(16);
    ok(fx.classList.contains('fr-fx-goop'), 'the overlay is up');
    ok(fx.style.getPropertyValue('--fr-goop-clear') === '0%', 'and not clearing yet: ' + fx.style.getPropertyValue('--fr-goop-clear'));
    ok(!itemEnts(E).some((e) => /^goop:/.test(e.__finsItem)), 'no blob over my own nose — the overlay is my version of it');

    // Into the last second, the mask hole opens.
    const toLast = E.R.config.POWERUP_GOOP_MS - 700;
    for (let i = 0; i < Math.ceil(toLast / 50); i++) E.frame(50);
    const mid = parseInt(fx.style.getPropertyValue('--fr-goop-clear'), 10);
    ok(mid > 0, 'the wipe has started (' + mid + '%)');
    for (let i = 0; i < 8; i++) E.frame(50);
    const late = parseInt(fx.style.getPropertyValue('--fr-goop-clear'), 10);
    ok(late > mid, 'and keeps opening (' + mid + '% -> ' + late + '%)');
    for (let i = 0; i < 30; i++) E.frame(50);
    ok(!fx.classList.contains('fr-fx-goop'), 'the overlay ends on the effect clock, not the wipe');
    ok(fx.style.getPropertyValue('--fr-goop-clear') === '0%', 'and the wipe resets for next time');
  }

  console.log('Items: using Boost tells the room and draws my own trail without waiting for the echo');
  {
    const { E, ws } = await itemsEnv();
    const PU = E.R.powerups;
    E.setPos(along(0)); E.frame(16);
    PU.setLoadout(['boost', 'shield']);
    PU.useSlot(0, E.now());
    const sent = ws.ofType('fx');
    ok(sent.length === 1 && sent[0].item === 'boost' && sent[0].ms === E.R.config.POWERUP_BOOST_MS,
      'one cosmetic fx frame for the room: ' + JSON.stringify(sent));
    ok(E.R.items.fx.get('Eric').boostUntil > E.now(), 'my own boost is drawn from here, not from the echo');

    // A trail builds behind me as I move.
    let m = 0;
    for (let i = 0; i < 20; i++) { m += 40; E.setPos(along(m)); E.frame(50); }
    const trail = itemEnts(E).filter((e) => e.__finsItem === 'fxb:Eric');
    ok(trail.length === 1 && trail[0].polyline, 'an orange trail polyline is behind me');
    ok(E.R.items.fx.get('Eric').trail.length > 2, 'with several sampled points (' + E.R.items.fx.get('Eric').trail.length + ')');
    // …and only the last BOOST_TRAIL_MS of them.
    const spanMs = (() => { const t = E.R.items.fx.get('Eric').trail; return t[t.length - 1][0] - t[0][0]; })();
    ok(spanMs <= E.R.config.BOOST_TRAIL_MS + 60, 'the trail is the last ' + E.R.config.BOOST_TRAIL_MS + ' ms only (' + spanMs + ' ms)');

    // The booster's own screen gets the speed-line vignette.
    const fx = E.w.document.getElementById('fr-fx');
    ok(fx.classList.contains('fr-fx-boost') && fx.classList.contains('fr-fx-on'), 'and a speed-line vignette on my own screen');

    for (let i = 0; i < Math.ceil(E.R.config.POWERUP_BOOST_MS / 50) + 4; i++) { m += 40; E.setPos(along(m)); E.frame(50); }
    ok(itemEnts(E).filter((e) => e.__finsItem === 'fxb:Eric').length === 0, 'the trail ends with the boost');
    ok(!fx.classList.contains('fr-fx-boost'), 'and so does the vignette');
  }

  console.log('Items: another pilot\'s Boost and Shield are visible to me');
  {
    const { E, ws } = await itemsEnv();
    ws.fireMessage({ type: 'world', players: [{ callsign: 'Steve', lat: 45.01, lon: -122.0, alt: 1000, gate: 1 }] });
    ws.fireMessage({ type: 'fx', callsign: 'Steve', item: 'shield', ms: 6000 });
    E.frame(16);
    const bubble = itemEnts(E).filter((e) => e.__finsItem === 'fxs:Steve');
    ok(bubble.length === 1 && bubble[0].ellipsoid, 'a shield bubble around Steve');
    ok(near(bubble[0].ellipsoid.material.__alpha, 0.22, 1e-6), 'translucent while nothing is hitting it (' + bubble[0].ellipsoid.material.__alpha + ')');
    ok(E.R.powerups.feed.some((l) => /Steve put a shield up/.test(l)), 'and the feed says so: ' + JSON.stringify(E.R.powerups.feed[0]));

    // It flashes white when it eats something.
    ws.fireMessage({ type: 'fired', id: 61, item: 'missile', from: 'Maggie', target: 'Steve', flight_ms: 1200 });
    E.frame(16);
    ws.fireMessage({ type: 'resolved', id: 61, item: 'missile', from: 'Maggie', target: 'Steve', blocked: true, lost: false });
    E.frame(16);
    ok(bubble[0].ellipsoid.material.__alpha > 0.5, 'it flashes white on a block (' + bubble[0].ellipsoid.material.__alpha + ')');
    for (let i = 0; i < 10; i++) E.frame(60);
    ok(near(bubble[0].ellipsoid.material.__alpha, 0.22, 1e-6), 'then settles back');

    // Boost, from the same pilot.
    ws.fireMessage({ type: 'fx', callsign: 'Steve', item: 'boost', ms: 4000 });
    for (let i = 0; i < 6; i++) {
      ws.fireMessage({ type: 'world', players: [{ callsign: 'Steve', lat: 45.01 + i * 0.002, lon: -122.0, alt: 1000, gate: 1 }] });
      E.frame(80);
    }
    ok(itemEnts(E).some((e) => e.__finsItem === 'fxb:Steve'), 'and an orange trail behind his aircraft');
    // His boost is HIS vignette, not mine.
    ok(!E.w.document.getElementById('fr-fx').classList.contains('fr-fx-boost'), 'another pilot\'s boost never vignettes my screen');

    for (let i = 0; i < 90; i++) E.frame(100);
    ok(E.R.items.fx.size === 0, 'the fx record is dropped once both effects are long gone');
    ok(itemEnts(E).filter((e) => /^fx[bs]:Steve$/.test(e.__finsItem)).length === 0, 'and both entities with it');
  }

  console.log('Items: a junk fx frame off the wire draws nothing');
  {
    const { E, ws } = await itemsEnv();
    ws.fireMessage({ type: 'fx', callsign: 'Steve', item: 'missile', ms: 4000 });
    ws.fireMessage({ type: 'fx', callsign: '', item: 'boost', ms: 4000 });
    E.frame(16);
    ok(E.R.items.fx.size === 0, 'fx is boost/shield from a real callsign, or nothing');
  }

  console.log('Items: a hit shakes the render canvas and always puts it back');
  {
    const { E, ws } = await itemsEnv();
    ok(E.R._internals.G.renderCanvas() === E.widget, 'the shake target resolves to the render element');
    E.widget.style.transform = 'scale(1)';   // something already there, to prove it is restored

    ws.fireMessage({ type: 'hit', item: 'missile', from: 'Steve', id: 1 });
    E.frame(16);
    ok(/translate3d/.test(E.widget.style.transform), 'a missile shakes it: ' + E.widget.style.transform);
    const first = E.widget.style.transform;
    E.frame(16);
    ok(E.widget.style.transform !== first, 'and it jitters rather than holding one offset');
    ok(E.R.shake.until > E.now(), 'for a bounded time');

    for (let i = 0; i < 12; i++) E.frame(60);
    ok(E.widget.style.transform === 'scale(1)', 'then the original transform is put back exactly');

    // A banana is a shorter shake than a missile.
    const start = E.now();
    ws.fireMessage({ type: 'hit', item: 'banana', from: 'Steve', id: 2 });
    E.frame(16);
    const bananaMs = E.R.shake.until - start;
    ok(bananaMs > 200 && bananaMs < 320, 'a banana shake is ~250 ms (' + Math.round(bananaMs) + ')');
    for (let i = 0; i < 12; i++) E.frame(60);
    ok(E.widget.style.transform === 'scale(1)', 'and it cleans up too');

    // Reset always clears it, whatever state it was in.
    ws.fireMessage({ type: 'hit', item: 'missile', from: 'Steve', id: 3 });
    E.frame(16);
    E.R.race.reset();
    ok(E.widget.style.transform === 'scale(1)', 'a reset mid-shake puts it back immediately');
    ok(E.R.shake.el === null, 'and the shake lets go of the element');
  }

  console.log('Items: the hit shake respects prefers-reduced-motion and CONFIG.HIT_SHAKE');
  {
    const { E, ws } = await itemsEnv({ reducedMotion: true });
    ws.fireMessage({ type: 'hit', item: 'missile', from: 'Steve', id: 1 });
    E.frame(16);
    ok(!E.widget.style.transform, 'nothing moves under prefers-reduced-motion: ' + JSON.stringify(E.widget.style.transform));
    ok(E.R.powerups.state.effects.missile > E.now(), 'the hit itself still lands — only the motion is dropped');

    const off = await itemsEnv({ patch: [['HIT_SHAKE: true,', 'HIT_SHAKE: false,']] });
    off.ws.fireMessage({ type: 'hit', item: 'missile', from: 'Steve', id: 1 });
    off.E.frame(16);
    ok(!off.E.widget.style.transform, 'and nothing moves with CONFIG.HIT_SHAKE off');
  }

  console.log('Items: the speed penalty is OFF by default and writes nothing');
  {
    const { E, ws } = await itemsEnv();
    ok(E.R.config.POWERUP_SPEED_PENALTY === false, 'the flag ships off');
    ok(E.R.config.POWERUP_CONTROL_EFFECTS === false, 'and the control-write flag is still off and untouched');
    const before = E.instance.trueAirSpeed;
    ws.fireMessage({ type: 'hit', item: 'missile', from: 'Steve', id: 1 });
    for (let i = 0; i < 20; i++) E.frame(50);
    ok(E.instance.trueAirSpeed === before, 'a missile hit writes no speed at all (' + E.instance.trueAirSpeed + ')');
  }

  console.log('Items: the speed penalty, when turned on, holds one target and never stalls you');
  {
    const P = [['POWERUP_SPEED_PENALTY: false,', 'POWERUP_SPEED_PENALTY: true,']];
    const { E, ws } = await itemsEnv({ patch: P, altitudeAGL: 5000 });   // feet; well above the floor
    E.setPos(along(0)); E.frame(16);
    const CFG = E.R.config;
    ws.fireMessage({ type: 'hit', item: 'missile', from: 'Steve', id: 1 });
    E.frame(16);
    ok(E.instance.trueAirSpeed === 150 && E.instance.groundSpeed === 150, '200 m/s -> 150 (' + E.instance.trueAirSpeed + ')');
    ok(E.R.powerups.penaltyUntil > E.now(), 'and it is time-boxed');
    // One absolute target, held — not re-derived per frame into a standstill.
    for (let i = 0; i < 10; i++) E.frame(50);
    ok(E.instance.trueAirSpeed === 150, 'still exactly 150 after ten frames, not compounding down');
    // A second missile mid-penalty must not stack it lower.
    ws.fireMessage({ type: 'hit', item: 'missile', from: 'Steve', id: 2 });
    E.frame(16);
    ok(E.instance.trueAirSpeed === 150, 'a second hit never stacks the penalty (' + E.instance.trueAirSpeed + ')');
    for (let i = 0; i < Math.ceil(CFG.PENALTY_MS / 50) + 4; i++) E.frame(50);
    ok(E.R.powerups.penaltyUntil === 0, 'it releases on its own');
    ok(E.R.race.state !== 'dq', 'and slowing down never trips the teleport/slew DQ');
  }

  console.log('Items: the speed penalty never goes below the floor, and never applies down low');
  {
    const P = [['POWERUP_SPEED_PENALTY: false,', 'POWERUP_SPEED_PENALTY: true,']];
    // Doing 120 m/s: 25% off would be 90, under the 110 m/s floor.
    const slow = await itemsEnv({ patch: P, altitudeAGL: 5000, trueAirSpeed: 120, groundSpeed: 120 });
    slow.ws.fireMessage({ type: 'hit', item: 'missile', from: 'Steve', id: 1 });
    slow.E.frame(16);
    ok(slow.E.instance.trueAirSpeed === slow.E.R.config.PENALTY_FLOOR_MS,
      'the floor wins over the percentage (' + slow.E.instance.trueAirSpeed + ')');

    // 300 ft AGL is under PENALTY_MIN_AGL_M (150 m ~ 492 ft): no penalty at all.
    const low = await itemsEnv({ patch: P, altitudeAGL: 300 });
    const was = low.E.instance.trueAirSpeed;
    low.ws.fireMessage({ type: 'hit', item: 'missile', from: 'Steve', id: 1 });
    for (let i = 0; i < 10; i++) low.E.frame(50);
    ok(low.E.instance.trueAirSpeed === was, 'no penalty below 150 m AGL (' + low.E.instance.trueAirSpeed + ')');
    ok(low.E.R.powerups.penaltyUntil === 0, 'and none is armed');

    // A banana is a shake, never a speed write, even with the flag on.
    const ban = await itemsEnv({ patch: P, altitudeAGL: 5000 });
    const banWas = ban.E.instance.trueAirSpeed;
    ban.ws.fireMessage({ type: 'hit', item: 'banana', from: 'Steve', id: 1 });
    for (let i = 0; i < 10; i++) ban.E.frame(50);
    ok(ban.E.instance.trueAirSpeed === banWas, 'only the missile costs speed (' + ban.E.instance.trueAirSpeed + ')');
  }

  console.log('Items: a Boost cancels an active speed penalty rather than fighting it');
  {
    const P = [['POWERUP_SPEED_PENALTY: false,', 'POWERUP_SPEED_PENALTY: true,']];
    const { E, ws } = await itemsEnv({ patch: P, altitudeAGL: 5000 });
    ws.fireMessage({ type: 'hit', item: 'missile', from: 'Steve', id: 1 });
    E.frame(16);
    ok(E.instance.trueAirSpeed === 150, 'penalised');
    E.R.powerups.setLoadout(['boost', 'shield']);
    E.R.powerups.useSlot(0, E.now());
    E.frame(16);
    ok(E.R.powerups.penaltyUntil === 0, 'the boost clears the penalty outright');
    ok(E.instance.trueAirSpeed > 150, 'and the boost actually takes (' + E.instance.trueAirSpeed + ')');
  }

  console.log('Items: other pilots come from GeoFS multiplayer first, the relay world frame second');
  {
    const { E, ws } = await itemsEnv();
    ws.fireMessage({ type: 'world', players: [{ callsign: 'Steve', lat: 10, lon: 20, alt: 300, gate: 1 }] });
    let at = E.R.items.pilotPos('Steve');
    ok(at && at.source === 'relay' && at.lat === 10, 'with no multiplayer match, the relay frame is used');

    // A live GeoFS multiplayer user with the same callsign wins — it is interpolated per frame.
    E.w.multiplayer.users = { 1: { id: 1, callsign: 'steve ', lastUpdate: { co: [11, 21, 350, 90, 0, 0] } } };
    at = E.R.items.pilotPos('Steve');
    ok(at && at.source === 'multiplayer' && near(at.lat, 11, 1e-9), 'a multiplayer match wins (' + (at && at.source) + ')');
    ok(E.R.items.pilotPos('Nobody') === null, 'an unknown callsign is null, never a guess');
    // Me is always my own live position, never a stale echo off the relay.
    const mine = E.R.items.pilotPos('Eric');
    ok(mine && near(mine.lat, E.R.race.pos.lat, 1e-9), 'my own position comes from the sim');
  }

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

  // ------------------------------------------------------------------ Results (0.11.0, proto 4)
  console.log('Results: version, config flag, and the pure frame builders');
  {
    ok(E0.R.version === '1.0.0' && E0.R.config.VERSION === '1.0.0', 'CONFIG.VERSION is 1.0.0');
    ok(E0.R.config.RESULTS === true, 'CONFIG.RESULTS defaults on');
    const { bestSectorMs, finishGoTimeMs, finishFrame, dnfFrame, ordinalOf } = E0.R._internals;

    ok(bestSectorMs([8500, 18500]) === 8500 && bestSectorMs([4000, 19000, 21000]) === 2000, 'best sector: the shortest leg, the first being splits[0] itself');
    ok(bestSectorMs([]) === null && bestSectorMs(null) === null && bestSectorMs([0, 0]) === null, 'best sector: nothing to measure is null, never 0');

    // The crossing itself, not the frame edge: 400 ms of lobby clock at the frame's top, the run's
    // own clock 30 ms past the interpolated finish -> the crossing was 30 ms before the frame end.
    ok(finishGoTimeMs(31000, 18530, 18500) === 30970, 'finish go-time takes the interpolated crossing back off the frame edge');
    ok(finishGoTimeMs(31000, 18500, 18500) === 31000, 'a crossing on the frame edge is unchanged');
    ok(finishGoTimeMs(31000, 18400, 18500) === 31000, 'an elapsed behind finalMs never adds time');
    ok(Number.isNaN(finishGoTimeMs(NaN, 1, 1)) && Number.isNaN(finishGoTimeMs(1, null, 1)) && Number.isNaN(finishGoTimeMs(1, 1, undefined)), 'a non-finite clock is refused (NaN), so no bogus finish is sent');
    ok(finishGoTimeMs(-500, 0, 0) === 1, 'the frame always carries a positive time');

    const f = finishFrame(3, 61234.6, [8500, 18500], 0);
    ok(f.type === 'finish' && f.race_id === 3 && f.go_time_ms === 61235 && f.jump_start === false, 'finish frame: id, rounded lobby time, no jump start');
    ok(JSON.stringify(f.splits) === '[8500,18500]' && f.best_sector_ms === 8500, 'and the splits with the best sector derived from them');
    ok(finishFrame(3, 5000, [1000], 5000).jump_start === true, 'a jump-start penalty in the clock is reported as jump_start');
    ok(!('best_sector_ms' in finishFrame(3, 5000, [], 0)), 'no splits, no best sector: the field is omitted rather than sent as 0');
    const big = finishFrame(3, 21600000, Array.from({ length: 200 }, () => 21600000), 5000);
    ok(!('splits' in big) && big.best_sector_ms === 21600000 && JSON.stringify(big).length < 2048,
      'a frame too big for the relay\'s 2 KB cap drops its splits and keeps the best sector (' + JSON.stringify(big).length + ' bytes)');
    ok(JSON.stringify(finishFrame(1, 1, Array.from({ length: 60 }, (_, i) => (i + 1) * 9000), 0)).length < 1800 && 'splits' in finishFrame(1, 1, Array.from({ length: 60 }, (_, i) => (i + 1) * 9000), 0),
      'an ordinary long course keeps its splits');
    ok(finishFrame(-4, 0, [], 0).race_id === 0 && finishFrame(1, 0, [], 0).go_time_ms === 1, 'ids and times are clamped into what the relay accepts');
    ok(JSON.stringify(dnfFrame(2, 4)) === '{"type":"dnf","race_id":2,"gate":4}' && dnfFrame(2, 999).gate === 201 && dnfFrame(2, -3).gate === 0, 'dnf frame: id and a gate clamped to 0..201');
    ok(ordinalOf(1) === '1st' && ordinalOf(2) === '2nd' && ordinalOf(3) === '3rd' && ordinalOf(4) === '4th' && ordinalOf(11) === '11th' && ordinalOf(12) === '12th' && ordinalOf(22) === '22nd', 'ordinals');
  }

  console.log('Results: resultsReduce folds progress and final frames, and validates everything off the socket (pure)');
  {
    const { resultsReduce, resultsInitialState, lobbyCup } = E0.R._internals;
    const row = (pos, cs, o = {}) => ({ pos, callsign: cs, model: 'F-16', go_time_ms: 60000 + pos * 1000, gap_ms: (pos - 1) * 1000, status: 'finished', points: 15, items_used: { missile: 2 }, hits_taken: 1, jump_start: false, gate: null, ...o });
    const s0 = resultsInitialState();
    ok(s0.kind === 'none' && s0.rows.length === 0, 'initial state: nothing to show');
    const p1 = resultsReduce(s0, { type: 'results_progress', race_id: 4, rows: [row(1, 'Steve')], waiting: ['Eric', 'Maggie'], deadline_server_ms: 123456 });
    ok(p1.kind === 'progress' && p1.raceId === 4 && p1.rows.length === 1 && p1.waiting.join() === 'Eric,Maggie' && p1.deadlineServerMs === 123456, 'a progress frame: finishers so far, who is awaited, until when');
    ok(s0.kind === 'none', 'the previous state is not mutated (pure)');
    const fin = resultsReduce(p1, { type: 'results', race_id: 4, course: { course_id: 'c', course_hash: '0a1b2c3d', name: 'Steve Sprint' },
      rows: [row(1, 'Steve'), row(2, 'Eric', { points: 12 })], awards: [{ key: 'sharpshooter', callsign: 'Steve', detail: '2 hits landed' }],
      cup: { name: 'Friday', race_no: 2, race_count: 4, standings: [{ callsign: 'Steve', points: 27 }] } });
    ok(fin.kind === 'final' && fin.rows.length === 2 && fin.waiting.length === 0 && fin.course.name === 'Steve Sprint', 'a results frame is final and clears the waiting list');
    ok(fin.awards[0].key === 'sharpshooter' && fin.cup.name === 'Friday' && fin.cup.raceNo === 2 && fin.cup.standings[0].points === 27, 'awards and the cup come through');
    ok(resultsReduce(fin, { type: 'results_progress', race_id: 4, rows: [], waiting: [], deadline_server_ms: 1 }) === fin, 'a late progress frame never undoes the final one');
    ok(resultsReduce(fin, { type: 'results_progress', race_id: 3, rows: [], waiting: [], deadline_server_ms: 1 }) === fin, 'nor does one for an older race');
    ok(resultsReduce(fin, { type: 'results', race_id: 3, rows: [row(1, 'X')] }) === fin, 'nor does an older race\'s results');
    ok(resultsReduce(fin, { type: 'results_progress', race_id: 5, rows: [row(1, 'Z')], waiting: [], deadline_server_ms: 1 }).raceId === 5, 'but a newer race\'s progress replaces it');
    for (const junk of [{ type: 'lobby' }, { type: 'standings' }, null, 'no', 7, { type: 'results' }, { type: 'results', race_id: 'x' }, { type: 'results_progress', race_id: -1 }]) {
      ok(resultsReduce(fin, junk) === fin, 'anything else passes through identity-equal: ' + JSON.stringify(junk));
    }
    const dirty = resultsReduce(s0, { type: 'results', race_id: 1, rows: [
      row(1, 'A'.repeat(50), { model: 'M'.repeat(50), points: 'lots', items_used: { missile: 3, bogus: 9, banana: -2 } }),
      { pos: 2, callsign: 'B', status: 'weird' }, { pos: 'x', callsign: 'C', status: 'finished' }, null, 'row',
      row(3, 'D', { status: 'dnf', go_time_ms: 5, gap_ms: 5, gate: 3 })],
      awards: [{ key: 'k'.repeat(50), callsign: 'A', detail: 'd'.repeat(80) }, { key: 1 }, null],
      cup: { name: 'N'.repeat(50), race_no: 99, race_count: 4, standings: [{ callsign: 'A', points: 'x' }, { callsign: 'B', points: 3 }] } });
    ok(dirty.rows.length === 2, 'rows with a bad status, a bad position, or no shape at all are dropped (' + dirty.rows.length + ' kept)');
    ok(dirty.rows[0].callsign.length === 32 && dirty.rows[0].model.length === 32, 'names are clamped to 32 characters');
    ok(dirty.rows[0].points === null && JSON.stringify(dirty.rows[0].items_used) === '{"missile":3}', 'a non-numeric score is null, and only known positive items are counted');
    ok(dirty.rows[1].go_time_ms === null && dirty.rows[1].gap_ms === null && dirty.rows[1].gate === 3, 'a DNF carries no time, and keeps the gate it was out at');
    ok(dirty.awards.length === 1 && dirty.awards[0].key.length === 32 && dirty.awards[0].detail.length === 48, 'awards are validated and clamped');
    ok(dirty.cup.name.length === 32 && dirty.cup.raceNo === 4 && dirty.cup.standings.length === 1, 'the cup is clamped, and a standing with no number is dropped');
    ok(lobbyCup({ name: 'x', race_no: 1, race_count: 13 }) === null && lobbyCup(null) === null && lobbyCup({ name: 5, race_count: 3 }) === null && lobbyCup({ name: 'x', race_no: -4, race_count: 3 }).raceNo === 0,
      'lobbyCup: null, a bad count or name is null, a negative race number clamps to 0');
  }

  console.log('Results: resultsRows and the headline format the table (pure)');
  {
    const { resultsRows, resultsHeadline, resultsWaitingText, newRecordBadge, localResultsState } = E0.R._internals;
    const rows = [
      { pos: 1, callsign: 'Steve', model: 'F-16', status: 'finished', go_time_ms: 184213, gap_ms: 0, points: 15, items_used: { missile: 2, boost: 1 }, hits_taken: 0, jump_start: false, gate: null },
      { pos: 2, callsign: 'Eric', model: '', status: 'finished', go_time_ms: 185500, gap_ms: 1287, points: 12, items_used: {}, hits_taken: 2, jump_start: true, gate: null },
      { pos: 3, callsign: 'Maggie', model: 'bratwurst', status: 'dnf', go_time_ms: null, gap_ms: null, points: 0, items_used: { banana: 1 }, hits_taken: 3, jump_start: false, gate: 4 }];
    const out = resultsRows(rows, 'Eric', []);
    ok(out.length === 3 && out[0].pos === 1 && out[0].time === '3:04.213' && out[0].gap === '' && out[0].points === '+15', 'the winner: lobby-clock time, no gap, +points');
    ok(out[0].items === '3' && out[1].items === '–', 'items are a total, and a dash when none were used');
    ok(out[1].isMe && !out[0].isMe && out[1].gap === '+1.287' && out[1].jumpStart === true, 'my row is marked, the gap is signed, a jump start is flagged');
    ok(out[2].time === 'DNF' && out[2].points === '0' && out[2].dnfGate === 4 && out[2].gap === '', 'a DNF: no time, 0 points, the gate it was out at');
    ok(out[0].isWinner && !out[1].isWinner, 'only the winner is the winner');
    const waiting = resultsRows(rows.slice(0, 1), 'Eric', ['Eric', 'Maggie']);
    ok(waiting.length === 3 && waiting[1].waiting && waiting[1].pos === null && waiting[1].time === '…' && waiting[1].isMe && waiting[2].callsign === 'Maggie',
      'pilots still flying get placeholder rows after the finishers');
    ok(resultsRows(null, 'x', null).length === 0, 'null-safe');

    const h1 = resultsHeadline(rows, 'Eric', 'final'), h2 = resultsHeadline(rows, 'Steve', 'final');
    ok(h1.text === 'Steve wins' && h1.winner === 'Steve' && !h1.iWon && h1.sub === '3:04.213 · F-16', 'headline names the winner, their time and aircraft');
    ok(h2.text === 'You win!' && h2.iWon, 'and says so when it is you');
    ok(resultsHeadline([rows[2]], 'Eric', 'final').text === 'Nobody finished' && resultsHeadline([], 'Eric', 'final').text === 'Race over', 'a race with no finisher is not "won"');
    const local = localResultsState(['Maggie', 'Eric', 'Steve'], 'Eric', 61234, 'F-16', 2);
    ok(local.kind === 'local' && local.raceId === 2 && local.rows.length === 3 && local.rows[1].callsign === 'Eric' && local.rows[1].go_time_ms === 61234 && local.rows[1].points === null,
      'the local card: the standings order, my own time, no points');
    ok(resultsHeadline(local.rows, 'Eric', 'local').text === 'You finished 2nd of 3', 'and its headline is where I stood');
    ok(localResultsState([], 'Eric', 5000, '', 1).rows.length === 1 && resultsHeadline(localResultsState([], 'Eric', 5000, '', 1).rows, 'Eric', 'local').text === 'You finished 1st', 'solo: no standings frame yet, just me');
    ok(resultsRows(local.rows, 'Eric', []).every((r) => r.points === ''), 'no points column content on a relay with no points');

    ok(resultsWaitingText(2, 102000) === 'waiting for 2 pilots (01:42)' && resultsWaitingText(1, 5200) === 'waiting for 1 pilot (00:06)', 'the waiting line: pilots, singular/plural, mm:ss rounded up');
    ok(resultsWaitingText(0, -500) === 'waiting for 0 pilots (00:00)' && resultsWaitingText(3, 3600000) === 'waiting for 3 pilots (60:00)', 'never negative, minutes may pass 59');

    const board = [{ callsign: 'Steve', time_ms: 180000, created_at: 1000 }];
    ok(newRecordBadge('Steve', board, 999500) === true, 'the winner tops the board with a run posted after GO: a new record');
    ok(newRecordBadge('Steve', board, 1500000) === false, 'a record set BEFORE this race is not new');
    ok(newRecordBadge('Eric', board, 999500) === false && newRecordBadge('Steve', [], 1) === false && newRecordBadge(null, board, 1) === false, 'somebody else on top, an empty board, or no winner: no badge');
    ok(newRecordBadge('Steve', board, NaN) === false && newRecordBadge('Steve', [{ callsign: 'Steve' }], 1) === false, 'unknown times never earn a badge');
  }

  // A lobby race, driven the way the relay would: the socket opens and `joined` names the proto, a
  // `lobby` frame names the room and its racers, a `start` frame arms a GO, and the pilot then flies
  // the unit course. GO is placed `goAgoMs` in the past on the (offset-free) relay clock, so the lobby
  // clock the finish reports is a believable ~30 s rather than the few ms a fast-forwarded test
  // flight really takes.
  async function lobbyEnv({ proto = 4, callsign = 'Eric', room = 'resroom', racers = ['Eric', 'Maggie'], host = 'Eric', goAgoMs = 30000,
    phase = 'racing', start = true, opts = {}, seed = {} } = {}) {
    const E = env({ apiBase: 'https://relay.test', seed: { 'finsRace.callsign': callsign, 'finsRace.powerupRoom': room, ...seed }, ...opts });
    await E.bootFrames();
    const ws = E.wsRecord.last;
    ws.fireOpen();
    ws.fireMessage({ type: 'joined', room, proto, server_ms: Date.now() });
    E.setPos(along(-1000)); E.frame(16);
    E.R.loadCourse(course());
    const players = [...new Set([...racers, callsign])].map((cs) => ({ callsign: cs, model: '', ready: true, role: racers.includes(cs) ? 'racer' : 'spectator' }));
    const lobby = (ph, raceId, extra = {}) => ({ type: 'lobby', phase: ph, host, course: null, rules: { powerups: true, teleport: true }, race_id: raceId, cup: null, players, ...extra });
    ws.fireMessage(lobby(start ? 'lobby' : phase, 0));
    if (start) {
      ws.fireMessage({ type: 'start', race_id: 1, start_at_server_ms: Date.now() - goAgoMs, racers });
      ws.fireMessage(lobby(phase, 1));
    }
    return { E, ws, lobby, ov: () => E.w.document.getElementById('fr-results') };
  }
  const flyOn = (E, { fromM = -1000, endM = 5000, speed = 200 } = {}) => {
    const dt = 1000 / 60;
    let m = fromM;
    while (m < endM && !['finished', 'dq'].includes(E.R.race.state)) { m += speed * dt / 1000; E.setPos(along(m)); E.frame(dt); }
    return m;
  };
  const resRow = (pos, callsign, o = {}) => ({ pos, callsign, model: '', go_time_ms: 60000 + pos * 1000, gap_ms: (pos - 1) * 1000, status: 'finished',
    points: [15, 12, 10, 8][pos - 1] || 0, items_used: {}, hits_taken: 0, jump_start: false, gate: null, ...o });
  const progressFrame = (rows, waiting, extra = {}) => ({ type: 'results_progress', race_id: 1, rows, waiting, deadline_server_ms: Date.now() + 90000, ...extra });
  const finalFrame = (E, rows, extra = {}) => ({ type: 'results', race_id: 1, course: { course_id: 'unit-course', course_hash: E.R.race.hash, name: 'Unit course' }, rows, awards: [], cup: null, ...extra });
  const tableText = (E) => [...E.w.document.querySelectorAll('#fr-res-table tr')].slice(1).map((tr) => [...tr.children].map((td) => td.textContent));
  const buttonLabels = (E) => [...E.w.document.querySelectorAll('#fr-res-buttons button')].map((b) => b.textContent);
  const clickButton = (E, label) => [...E.w.document.querySelectorAll('#fr-res-buttons button')].find((b) => b.textContent === label).click();

  console.log('Results: a lobby racer\'s finish sends one finish frame on the lobby clock; the leaderboard post is untouched');
  {
    const posts = [];
    const { E, ws } = await lobbyEnv({ opts: { apiHandler: (url, init) => {
      if (url.endsWith('/runs')) { posts.push(JSON.parse(init.body)); return { ok: true, status: 200, json: async () => ({ id: 1, rank: 1, personal_best: 1, improved: true }) }; }
      return null; } } });
    ok(ws.ofType('finish').length === 0, 'nothing is sent before the finish');
    flyOn(E);
    const race = E.R.race;
    ok(race.state === 'finished', 'the run finishes');
    const fins = ws.ofType('finish');
    ok(fins.length === 1, 'exactly one finish frame (' + fins.length + ')');
    const f = fins[0];
    ok(f.race_id === 1 && f.jump_start === false, 'for race 1, no jump start');
    ok(f.go_time_ms >= 30000 && f.go_time_ms < 40000, 'on the lobby clock: measured from GO, which was 30 s ago (' + f.go_time_ms + ' ms)');
    ok(JSON.stringify(f.splits) === JSON.stringify(race.splits), 'carrying the run\'s splits');
    ok(f.best_sector_ms === Math.min(race.splits[0], race.splits[1] - race.splits[0]), 'and its best sector (' + f.best_sector_ms + ')');
    await new Promise((r) => setTimeout(r, 30));
    ok(posts.length === 1 && posts[0].time_ms === race.finalMs, 'the /runs post still carries the gate-1 clock (' + (posts[0] && posts[0].time_ms) + ' = finalMs ' + race.finalMs + ')');
    ok(posts[0].time_ms < 20000 && f.go_time_ms > 30000, 'which is a different number from the lobby clock, as it must be');
    E.frame(16); E.frame(16); E.frame(16);
    ok(ws.ofType('finish').length === 1, 'further frames never send a second finish');
    ok(ws.ofType('dnf').length === 0, 'and a finisher is not out');
  }

  console.log('Results: a finish is sent only by a racer in a lobby race on a proto-4 relay');
  {
    const spec = await lobbyEnv({ racers: ['Maggie'] });
    flyOn(spec.E);
    ok(spec.E.R.race.state === 'finished' && spec.ws.ofType('finish').length === 0, 'a spectator (not on the racer list) sends nothing');

    const plain = env({ apiBase: 'https://relay.test', seed: { 'finsRace.callsign': 'Eric', 'finsRace.powerupRoom': 'plainroom' } });
    await plain.bootFrames();
    const pws = plain.wsRecord.last; pws.fireOpen(); pws.fireMessage({ type: 'joined', room: 'plainroom', proto: 4, server_ms: Date.now() });
    plain.setPos(along(-1000)); plain.frame(16); plain.R.loadCourse(course());
    flyOn(plain);
    ok(plain.R.race.state === 'finished' && pws.ofType('finish').length === 0 && pws.ofType('dnf').length === 0, 'a plain Alt+R run (no synced GO) is nobody\'s lobby race');
    ok(!plain.w.document.getElementById('fr-results').classList.contains('fr-show'), 'and gets no results card');

    const off = await lobbyEnv({ opts: { patch: [['RESULTS: true,', 'RESULTS: false,']] } });
    flyOn(off.E);
    ok(off.E.R.race.state === 'finished' && off.ws.ofType('finish').length === 0, 'CONFIG.RESULTS = false sends nothing');
    ok(!off.E.w.document.getElementById('fr-results'), 'and never builds the overlay');
  }

  console.log('Results: against a relay below proto 4 nothing new is sent and a local card shows, with no points');
  {
    for (const proto of [2, 3]) {
      const { E, ws, ov } = await lobbyEnv({ proto, room: 'oldres' + proto });
      ws.fireMessage({ type: 'standings', order: ['Maggie', 'Eric'] });
      flyOn(E);
      ok(E.R.race.state === 'finished', 'proto ' + proto + ': the run finishes');
      ok(['finish', 'dnf', 'cup', 'rematch'].every((t) => ws.ofType(t).length === 0), 'proto ' + proto + ': no finish/dnf/cup/rematch frame is ever sent (an old relay would answer each with an error)');
      ok(ov().classList.contains('fr-show'), 'proto ' + proto + ': the local card is up');
      const title = E.w.document.getElementById('fr-res-title').textContent;
      ok(title === 'You finished 2nd of 2', 'proto ' + proto + ': it says where I stood from the standings (' + title + ')');
      const th = [...E.w.document.querySelectorAll('#fr-res-table th')].map((x) => x.textContent);
      ok(th.join() === '#,Pilot,Time', 'proto ' + proto + ': just position, pilot and time — no points, gap or items (' + th.join() + ')');
      ok(tableText(E).find((r) => r[1].startsWith('Eric'))[2] !== '', 'proto ' + proto + ': with my own time on my row');
      ok(buttonLabels(E).join() === 'Close', 'proto ' + proto + ': and nothing to click but Close (' + buttonLabels(E).join() + ')');
      clickButton(E, 'Close');
      ok(!ov().classList.contains('fr-show'), 'proto ' + proto + ': Close closes it');
    }
    const { E: E3 } = await lobbyEnv({ proto: 3, room: 'oldstatus' });
    ok(/Shared results and cups off: this relay speaks proto 3, they need 4\./.test(E3.R.relay.status), 'one status-line note says why: ' + E3.R.relay.status);
    ok(!/proto 3, they need 3/.test(E3.R.relay.status), 'and the items note is not shown for a relay that has the items layer');
    const { E: E4 } = await lobbyEnv({ proto: 4, room: 'newstatus' });
    ok(!/Shared results/.test(E4.R.relay.status), 'a proto-4 relay gets no note');
  }

  console.log('Results: the overlay never covers a pilot still racing, and shows the wait live once they finish');
  {
    const { E, ws, ov } = await lobbyEnv({ racers: ['Eric', 'Maggie', 'Steve'], host: 'Steve' });
    const spy = []; const realPlay = E.R.sfx.play.bind(E.R.sfx); E.R.sfx.play = (n) => { spy.push(n); realPlay(n); };
    const m = flyOn(E, { endM: 1000 });
    ok(E.R.race.state === 'running', 'still racing');
    ws.fireMessage(progressFrame([resRow(1, 'Steve')], ['Eric', 'Maggie']));
    ok(E.R.results.state.kind === 'progress' && !ov().classList.contains('fr-show'), 'Steve finishes first: the state is kept but my view is not covered');
    ok(spy.indexOf('finish_p1') < 0 && !/^P\d/.test(E.R.ui.E.banner.textContent), 'and no position banner or fanfare (I have not finished): ' + E.R.ui.E.banner.textContent);

    flyOn(E, { fromM: m });
    ok(E.R.race.state === 'finished' && ws.ofType('finish').length === 1, 'I finish and report it');
    ws.fireMessage(progressFrame([resRow(1, 'Steve'), resRow(2, 'Eric', { points: 12 })], ['Maggie'], { deadline_server_ms: Date.now() + 61500 }));
    ok(ov().classList.contains('fr-show'), 'the card comes up now that I am out of the air');
    ok(E.w.document.getElementById('fr-res-title').textContent === 'Steve wins', 'headline: ' + E.w.document.getElementById('fr-res-title').textContent);
    const wait = E.w.document.getElementById('fr-res-wait').textContent;
    ok(wait === 'waiting for 1 pilot (01:02)', 'the live wait line: ' + wait);
    let t = tableText(E);
    ok(t.length === 3 && t[0][1] === 'Steve' && t[1][1] === 'Eric (you)' && t[2][1] === 'Maggie' && t[2][2] === '…', 'two finishers and a placeholder for Maggie: ' + JSON.stringify(t));
    ok(t[1][5] === '+12', 'my points show on my row');
    ok(E.R.ui.E.banner.textContent.startsWith('P2 · +12 pts'), 'the banner names my position and points: ' + E.R.ui.E.banner.textContent);
    ok(spy.indexOf('finish_p1') < 0, 'second place gets no winner\'s fanfare');
    ok(buttonLabels(E).join() === 'Close', 'while waiting there is only Close (' + buttonLabels(E).join() + ')');

    // The clock runs by itself, once per frame, with no timer: bring the deadline in and step a frame.
    E.R.results.state.deadlineServerMs = Date.now() + 5200;
    E.frame(16);
    ok(E.w.document.getElementById('fr-res-wait').textContent === 'waiting for 1 pilot (00:06)', 'it ticks: ' + E.w.document.getElementById('fr-res-wait').textContent);

    ws.fireMessage(progressFrame([resRow(1, 'Steve'), resRow(2, 'Eric', { points: 12 }), resRow(3, 'Maggie')], []));
    t = tableText(E);
    ok(t.length === 3 && t[2][1] === 'Maggie' && t[2][2] !== '…', 'the row fills in as her finish arrives');
    ok(/^waiting for 0 pilots \(\d\d:\d\d\)$/.test(E.w.document.getElementById('fr-res-wait').textContent), 'and nobody is left to wait for: ' + E.w.document.getElementById('fr-res-wait').textContent);
  }

  console.log('Results: the final table, cup standings, awards and the buttons a host and a guest get');
  {
    const { E, ws, ov } = await lobbyEnv({ racers: ['Eric', 'Maggie', 'Steve'], host: 'Eric' });
    const spy = []; E.R.sfx.play = (n) => { spy.push(n); };
    flyOn(E);
    const rows = [resRow(1, 'Eric', { model: 'F-16', items_used: { missile: 2, boost: 1 } }), resRow(2, 'Steve', { points: 12 }), resRow(3, 'Maggie', { status: 'dnf', go_time_ms: null, gap_ms: null, points: 0, gate: 1 })];
    ws.fireMessage(finalFrame(E, rows, {
      awards: [{ key: 'sharpshooter', callsign: 'Eric', detail: '2 hits landed' }, { key: 'clean_race', callsign: 'Steve', detail: 'no hits taken' }],
      cup: { name: 'Friday Night', race_no: 2, race_count: 4, standings: [{ callsign: 'Steve', points: 27 }, { callsign: 'Eric', points: 25 }] } }));
    ok(ov().classList.contains('fr-show'), 'the card is up');
    ok(E.w.document.getElementById('fr-res-title').textContent === 'You win!', 'I won: ' + E.w.document.getElementById('fr-res-title').textContent);
    ok(E.w.document.getElementById('fr-res-course').textContent === 'Unit course', 'it names the course');
    const th = [...E.w.document.querySelectorAll('#fr-res-table th')].map((x) => x.textContent).join();
    ok(th === '#,Pilot,Time,Gap,Items,Pts', 'columns: position, pilot, time, gap, items, points (' + th + ')');
    const t = tableText(E);
    ok(t[0][1] === 'Eric (you) · F-16' && t[0][4] === '3' && t[0][5] === '+15', 'my row: pilot and model, 3 items, +15: ' + JSON.stringify(t[0]));
    ok(t[1][3] === '+1.000' && t[1][5] === '+12', 'second place: gap and points');
    ok(t[2][2] === 'DNF' && t[2][5] === '0', 'a DNF reads DNF and 0');
    const side = E.w.document.getElementById('fr-res-side').textContent;
    ok(/Cup · Friday Night/.test(side) && /race 2 of 4/.test(side) && /Steve27/.test(side) && /Eric25/.test(side), 'the cup column: name, race 2 of 4, standings: ' + side);
    ok(/Sharpshooter/.test(side) && /Eric · 2 hits landed/.test(side) && /Clean race/.test(side) && /Steve · no hits taken/.test(side), 'the awards list, with readable names');
    ok(spy.indexOf('finish_p1') >= 0 && E.R.ui.E.banner.textContent.startsWith('P1 · +15 pts'), 'winning plays the fanfare and the banner says P1 with points: ' + E.R.ui.E.banner.textContent);
    ok(buttonLabels(E).join() === 'Next race,Rematch,Race the winner’s ghost,Close', 'the host gets all four buttons: ' + buttonLabels(E).join());

    // Race the winner's ghost: the picker names the winner and the card closes.
    clickButton(E, 'Race the winner’s ghost');
    ok(E.R.ghost.pick === 'Eric', 'the Ghost pick is the winner (' + E.R.ghost.pick + ')');
    ok([...E.R.ui.E.ghostSelect.options].some((o) => o.value === 'Eric') && E.R.ui.E.ghostSelect.value === 'Eric', 'and the Ghost select shows it even before the board lists them');
    ok(!ov().classList.contains('fr-show'), 'the card closes');
    ok(ws.ofType('rematch').length === 1, 'the host taking the room back to the lobby sends the rematch');

    // Close, and Next race, and Rematch on a fresh card.
    ws.fireMessage(finalFrame(E, rows, { race_id: 2 }));
    ok(ov().classList.contains('fr-show'), 'a newer race brings the card back');
    clickButton(E, 'Close');
    ok(!ov().classList.contains('fr-show') && ws.ofType('back_to_lobby').length === 0 && ws.ofType('rematch').length === 1, 'Close only closes: the room is not touched');
    ws.fireMessage(finalFrame(E, rows, { race_id: 3 }));
    clickButton(E, 'Rematch');
    ok(ws.ofType('rematch').length === 2 && !ov().classList.contains('fr-show'), 'Rematch sends the frame and closes the card');
    ws.fireMessage(finalFrame(E, rows, { race_id: 4 }));
    clickButton(E, 'Next race');
    ok(ws.ofType('back_to_lobby').length === 1 && E.R.results.wantPicker === true && !ov().classList.contains('fr-show'), 'Next race sends back_to_lobby, closes the card and asks for the course picker');

    // The room answers: back in the lobby. The pilot is re-armed, the results are history, the picker has focus.
    ok(E.R.race.state === 'finished', '(still finished until the room answers)');
    ws.fireMessage({ type: 'lobby', phase: 'lobby', host: 'Eric', course: null, rules: { powerups: true, teleport: true }, race_id: 4, cup: null,
      players: [{ callsign: 'Eric', model: '', ready: false, role: 'racer' }, { callsign: 'Steve', model: '', ready: false, role: 'racer' }] });
    ok(E.R.race.state === 'armed', 'back to the lobby re-arms a finished pilot, so the lobby card can show');
    ok(E.R.results.state.kind === 'none' && !ov().classList.contains('fr-show'), 'the results are cleared');
    ok(E.w.document.getElementById('fr-lobby').classList.contains('fr-show'), 'and the lobby card is up');
    ok(E.R.results.wantPicker === false && E.w.document.activeElement && E.w.document.activeElement.tagName === 'SELECT', 'with the host\'s course picker focused');
  }

  console.log('Results: a guest gets no host buttons, and the ghost button only re-arms them');
  {
    const { E, ws, ov } = await lobbyEnv({ racers: ['Eric', 'Steve'], host: 'Steve' });
    flyOn(E);
    ws.fireMessage(finalFrame(E, [resRow(1, 'Steve'), resRow(2, 'Eric', { points: 12 })]));
    ok(buttonLabels(E).join() === 'Race the winner’s ghost,Close', 'a guest: the ghost and Close only (' + buttonLabels(E).join() + ')');
    ok(E.w.document.getElementById('fr-res-body').classList.contains('fr-res-solo'), 'with no cup and no awards the side column is not drawn');
    E.R.results.nextRace(); E.R.results.rematch();
    ok(ws.ofType('back_to_lobby').length === 0 && ws.ofType('rematch').length === 0, 'the host actions do nothing for a guest even if called');
    clickButton(E, 'Race the winner’s ghost');
    ok(E.R.ghost.pick === 'Steve', 'the ghost is the winner\'s');
    ok(ws.ofType('rematch').length === 0, 'a guest cannot move the room');
    ok(E.R.race.state === 'armed' && !ov().classList.contains('fr-show'), 'but is back on the start line, ready for the lobby');
  }

  console.log('Results: the cup\'s final standings, and the "new course record" badge from the board');
  {
    const boardAt = (createdAtS, callsign = 'Eric') => [{ callsign, time_ms: 18500, model: '', aircraft_id: '', created_at: createdAtS, attempts: 1, has_ghost: true }];
    let board = boardAt(Math.floor(Date.now() / 1000) + 1);
    const asked = [];
    const { E, ws } = await lobbyEnv({ racers: ['Eric', 'Steve'], opts: { apiHandler: (url) => {
      if (url.includes('/leaderboard')) { asked.push(url); return { ok: true, status: 200, json: async () => board }; }
      return null; } } });
    flyOn(E);
    const badge = () => E.w.document.querySelector('.fr-res-badge').style.display !== 'none';
    ws.fireMessage(finalFrame(E, [resRow(1, 'Eric'), resRow(2, 'Steve')], { cup: { name: 'Finals', race_no: 4, race_count: 4, standings: [{ callsign: 'Eric', points: 60 }, { callsign: 'Steve', points: 50 }] } }));
    ok(/Cup final · Finals/.test(E.w.document.getElementById('fr-res-side').textContent), 'the last race of a cup is labelled the final');
    ok(!badge(), 'no badge until the board has been asked');
    E.frame(300); await new Promise((r) => setTimeout(r, 30));
    ok(asked.length >= 1 && asked[0].includes('course_hash=' + E.R.race.hash), 'once a frame later the board is asked for this course: ' + asked[0]);
    ok(badge(), 'the winner tops the board with a run posted after GO: "New course record"');

    // Not new: the top of the board is older than this race, or is somebody else's.
    for (const [label, b] of [['a record from before this race', boardAt(Math.floor(Date.now() / 1000) - 3600)], ['somebody else\'s run', boardAt(Math.floor(Date.now() / 1000) + 1, 'Steve')], ['an empty board', []]]) {
      board = b;
      ws.fireMessage(finalFrame(E, [resRow(1, 'Eric'), resRow(2, 'Steve')], { race_id: 2 }));
      ok(!badge(), label + ': no badge yet');
      E.frame(300); await new Promise((r) => setTimeout(r, 30));
      ok(!badge(), label + ': still no badge');
    }
    // The winner's own POST can lag the results frame: a second look a few seconds later finds it.
    board = boardAt(Math.floor(Date.now() / 1000) - 3600);
    ws.fireMessage(finalFrame(E, [resRow(1, 'Eric'), resRow(2, 'Steve')], { race_id: 3 }));
    E.frame(300); await new Promise((r) => setTimeout(r, 30));
    ok(!badge(), 'the first look finds the old board');
    board = boardAt(Math.floor(Date.now() / 1000) + 1);
    E.frame(4000); await new Promise((r) => setTimeout(r, 30));
    ok(badge(), 'the second look, a few seconds on, finds the new record');
  }

  console.log('Results: a DQ, a mid-race reset, or a reset during the countdown sends a dnf — once the race is on');
  {
    // DQ: teleport mid-race.
    const dq = await lobbyEnv();
    let m = flyOn(dq.E, { endM: 1000 });
    ok(dq.E.R.race.state === 'running', 'running');
    const gateBefore = dq.E.R.race.next;
    dq.E.setPos(along(m + 60000)); dq.E.frame(16);
    ok(dq.E.R.race.state === 'dq', 'a teleport DQs the run');
    ok(dq.ws.ofType('dnf').length === 1 && dq.ws.ofType('dnf')[0].race_id === 1 && dq.ws.ofType('dnf')[0].gate === gateBefore, 'and sends one dnf at the gate it was heading for (' + JSON.stringify(dq.ws.ofType('dnf')) + ')');
    dq.E.frame(16); dq.E.frame(16);
    ok(dq.ws.ofType('dnf').length === 1, 'never a second one');

    // Reset mid-race (Alt+R while running).
    const rs = await lobbyEnv({ room: 'resetroom' });
    flyOn(rs.E, { endM: 1000 });
    rs.E.R.race.reset();
    ok(rs.ws.ofType('dnf').length === 1 && rs.ws.ofType('dnf')[0].gate >= 1, 'a reset while running is a dnf (' + JSON.stringify(rs.ws.ofType('dnf')) + ')');
    ok(rs.E.R.race.goAt === null, 'and the re-armed run is no longer a lobby race');
    rs.E.R.race.reset();
    ok(rs.ws.ofType('dnf').length === 1, 'resetting again reports nothing more');

    // Reset while armed (never crossed the start) once the race is on: also out.
    const armed = await lobbyEnv({ room: 'armedroom' });
    armed.E.R.race.reset();
    ok(armed.ws.ofType('dnf').length === 1 && armed.ws.ofType('dnf')[0].gate === 0, 'a reset before ever crossing the start line is a dnf at gate 0');

    // Reset during the countdown: owed until the room's phase flips to racing.
    const cd = await lobbyEnv({ room: 'cdroom', goAgoMs: -20000, phase: 'countdown' });
    cd.E.R.race.reset();
    ok(cd.ws.ofType('dnf').length === 0 && cd.E.R.results.owed && cd.E.R.results.owed.raceId === 1, 'in the countdown the relay would refuse a dnf, so it is held (' + JSON.stringify(cd.E.R.results.owed) + ')');
    cd.ws.fireMessage(cd.lobby('racing', 1));
    ok(cd.ws.ofType('dnf').length === 1 && cd.E.R.results.owed === null, 'and sent the moment the race is on');
    cd.ws.fireMessage(cd.lobby('racing', 1));
    ok(cd.ws.ofType('dnf').length === 1, 'exactly once');

    // A newer race replaces a dnf that was never sent.
    const stale = await lobbyEnv({ room: 'staleroom', goAgoMs: -20000, phase: 'countdown' });
    stale.E.R.race.reset();
    stale.ws.fireMessage({ type: 'start', race_id: 2, start_at_server_ms: Date.now() + 20000, racers: ['Eric', 'Maggie'] });
    stale.ws.fireMessage(stale.lobby('racing', 2));
    ok(stale.ws.ofType('dnf').length === 0, 'a dnf for race 1 is never sent into race 2');

    // Not a racer / not a lobby race / not on this relay: nothing.
    const spec = await lobbyEnv({ room: 'specdnf', racers: ['Maggie'] });
    flyOn(spec.E, { endM: 1000 }); spec.E.R.race.reset();
    ok(spec.ws.ofType('dnf').length === 0, 'a spectator resetting sends nothing');
    const old = await lobbyEnv({ room: 'olddnf', proto: 3 });
    flyOn(old.E, { endM: 1000 }); old.E.R.race.reset();
    ok(old.ws.ofType('dnf').length === 0, 'a proto-3 relay is never sent a dnf');
    const done = await lobbyEnv({ room: 'donednf' });
    flyOn(done.E); done.E.R.race.reset();
    ok(done.ws.ofType('dnf').length === 0, 'resetting after finishing is not abandoning anything');
    const solo = env({ apiBase: 'https://relay.test', seed: { 'finsRace.callsign': 'Eric', 'finsRace.powerupRoom': 'soloroom' } });
    await solo.bootFrames();
    const sws = solo.wsRecord.last; sws.fireOpen(); sws.fireMessage({ type: 'joined', room: 'soloroom', proto: 4, server_ms: Date.now() });
    solo.setPos(along(-1000)); solo.frame(16); solo.R.loadCourse(course());
    flyOn(solo, { endM: 1000 }); solo.R.race.reset();
    ok(sws.ofType('dnf').length === 0, 'an ordinary run (no synced GO) resetting sends nothing');
  }

  console.log('Results: a card held back while I was still racing appears the moment I stop, with no further frame');
  {
    // The deadline ended the race while this pilot was still in the air: they are a DNF on the card.
    const { E, ws, ov } = await lobbyEnv({ racers: ['Eric', 'Maggie'], host: 'Maggie', room: 'lateres' });
    const m = flyOn(E, { endM: 1000 });
    ok(E.R.race.state === 'running', 'still racing');
    ws.fireMessage(finalFrame(E, [resRow(1, 'Maggie'), resRow(2, 'Eric', { status: 'dnf', go_time_ms: null, gap_ms: null, points: 0, gate: 1 })]));
    E.frame(16);
    ok(E.R.results.state.kind === 'final' && !ov().classList.contains('fr-show'), 'the final results are in but do not cover a pilot who is still flying');
    flyOn(E, { fromM: m });
    ok(E.R.race.state === 'finished', 'they finish, too late for the relay');
    ok(ov().classList.contains('fr-show'), 'and the card comes up on the next frame, with nothing more from the relay');
    ok(E.w.document.getElementById('fr-res-title').textContent === 'Maggie wins', 'showing who won');
    ok(tableText(E).find((r) => r[1].startsWith('Eric'))[2] === 'DNF', 'and that they were counted out');

    // A DQ releases it just the same.
    const dq = await lobbyEnv({ racers: ['Eric', 'Maggie'], host: 'Maggie', room: 'latedq' });
    const m2 = flyOn(dq.E, { endM: 1000 });
    dq.ws.fireMessage(finalFrame(dq.E, [resRow(1, 'Maggie'), resRow(2, 'Eric', { status: 'dnf', go_time_ms: null, gap_ms: null, points: 0, gate: 1 })]));
    dq.E.frame(16);
    ok(!dq.ov().classList.contains('fr-show'), 'hidden while running');
    dq.E.setPos(along(m2 + 60000)); dq.E.frame(16); dq.E.frame(16);
    ok(dq.E.R.race.state === 'dq' && dq.ov().classList.contains('fr-show'), 'a DQ brings the card up');
  }

  console.log('Results: the room going back to the lobby, or a new countdown, clears the card and a disconnect resets the module');
  {
    const { E, ws, lobby, ov } = await lobbyEnv({ racers: ['Eric', 'Steve'], host: 'Steve' });
    flyOn(E);
    ws.fireMessage(progressFrame([resRow(1, 'Eric')], ['Steve']));
    ok(ov().classList.contains('fr-show'), 'waiting card up');
    ws.fireMessage(lobby('lobby', 1));
    ok(!ov().classList.contains('fr-show') && E.R.results.state.kind === 'none', 'the host calling the race off (phase lobby) dismisses it');
    ok(E.R.race.state === 'armed', 'and re-arms the finished pilot');
    ws.fireMessage(finalFrame(E, [resRow(1, 'Eric')]));
    ok(ov().classList.contains('fr-show'), 'results up again');
    ws.fireMessage({ type: 'start', race_id: 2, start_at_server_ms: Date.now() + 15000, racers: ['Eric', 'Steve'] });
    ok(E.R.results.state.kind === 'none' && !ov().classList.contains('fr-show'), 'a new start clears it');
    ws.fireMessage(finalFrame(E, [resRow(1, 'Eric')], { race_id: 2 }));
    E.R.relay.disconnect();
    ok(E.R.results.state.kind === 'none' && !ov().classList.contains('fr-show'), 'a disconnect resets it');
  }

  console.log('Results: the lobby shows the running cup, and only a proto-4 host is offered "Start cup"');
  {
    const { E, ws, ov, lobby } = await lobbyEnv({ start: false, phase: 'lobby', host: 'Eric', room: 'cuplobby' });
    ws.fireMessage(lobby('lobby', 0, { cup: { name: 'Friday Night', race_no: 1, race_count: 4 } }));
    ok(E.R.lobby.state.cup && E.R.lobby.state.cup.raceNo === 1 && E.R.lobby.state.cup.raceCount === 4, 'the lobby state carries the cup');
    ok(E.R.ui.E.lobbyCup.textContent === 'Cup: Friday Night · race 2 of 4', 'and the card says which race is next: ' + E.R.ui.E.lobbyCup.textContent);
    const btn = () => [...E.R.ui.E.lobbyHost.querySelectorAll('button')].find((b) => /cup/i.test(b.textContent));
    ok(E.R.ui.E.lobbyHost.contains(E.R.ui.E.lobbyCupName) && btn() && btn().textContent === 'New cup', 'a proto-4 host is offered a New cup while one is running');
    E.R.ui.E.lobbyCupName.value = '  Saturday Cup  '; E.R.ui.E.lobbyCupRaces.value = '6';
    btn().click();
    const c = ws.ofType('cup');
    ok(c.length === 1 && c[0].name === 'Saturday Cup' && c[0].race_count === 6, 'Start sends the trimmed name and race count: ' + JSON.stringify(c[0]));
    // The inputs survive the lobby frames that rebuild the host controls.
    E.R.ui.E.lobbyCupName.value = 'half typ';
    ws.fireMessage(lobby('lobby', 0));
    ok(E.R.ui.E.lobbyCup.textContent === '' && E.R.ui.E.lobbyCupName.value === 'half typ' && btn().textContent === 'Start cup',
      'a lobby frame does not wipe a half-typed name, and with no cup the button reads Start cup');
    E.R.ui.E.lobbyCupName.value = '   ';
    btn().click();
    ok(ws.ofType('cup').length === 1, 'a blank name sends nothing');

    const guest = await lobbyEnv({ start: false, phase: 'lobby', host: 'Steve', room: 'cupguest', racers: ['Eric', 'Steve'] });
    ok(!guest.E.R.ui.E.lobbyHost.querySelector('input'), 'a guest has no cup controls');

    const old = await lobbyEnv({ start: false, phase: 'lobby', host: 'Eric', room: 'cupold', proto: 3 });
    ok(old.E.R.ui.E.lobbyHost.querySelector('input') && !old.E.R.ui.E.lobbyHost.contains(old.E.R.ui.E.lobbyCupName), 'a proto-3 host has the rules toggles but no cup controls: there is nothing to send them to');
    old.E.R.lobby.startCup('Nope', 3); old.E.R.lobby.rematch();
    ok(old.ws.ofType('cup').length === 0 && old.ws.ofType('rematch').length === 0, 'and startCup/rematch send nothing on a proto-3 relay');
  }

  console.log('Sfx: sfxPatch resolves a playable recipe for every documented sound name');
  {
    const { sfxPatch, SFX_NAMES } = E0.R._internals;
    ok(SFX_NAMES.length === 22, 'twenty-two documented sfx names (' + SFX_NAMES.length + ')');
    ok(['launch', 'impact', 'banana_drop', 'banana_pop', 'fx_other', 'box_dark'].every((n) => SFX_NAMES.includes(n)),
      'every 0.10.0 item event has a cue of its own');
    ok(SFX_NAMES.includes('finish_p1') && sfxPatch('finish_p1').freq2 !== sfxPatch('finish').freq2 && sfxPatch('finish_p1').duration > sfxPatch('finish').duration,
      'the winner has a fanfare variant of its own, distinct from the ordinary finish cue');
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

  console.log('Waypoint: turnInstruction takes the short way round (pure)');
  {
    const { turnInstruction } = E0.R._internals;
    ok(turnInstruction(164, 90).dir === 'right' && turnInstruction(164, 90).deg === 74, 'turn right 74° (the task\'s example)');
    ok(turnInstruction(16, 90).dir === 'left' && turnInstruction(16, 90).deg === 74, 'and left 74° the other way');
    const wrap = turnInstruction(10, 350);
    ok(wrap.dir === 'right' && wrap.deg === 20, '350 -> 010 is a 20° right turn, not 340° left');
    const wrap2 = turnInstruction(350, 10);
    ok(wrap2.dir === 'left' && wrap2.deg === 20, '…and the mirror image');
    ok(turnInstruction(90, 90).deg === 0, 'dead ahead is a zero turn');
    ok(turnInstruction(270, 90).deg === 180, 'dead astern is 180');
    ok(turnInstruction(NaN, 90) === null && turnInstruction(90, null) === null, 'no heading, no instruction');
  }

  console.log('Waypoint: bracketPlacement picks bracket, edge side, or a side from the bearing (pure)');
  {
    const { bracketPlacement } = E0.R._internals;
    const vp = { width: 1000, height: 800 };
    const P = (s, rel) => bracketPlacement(s, vp, 60, rel);
    ok(P({ x: 500, y: 400 }).mode === 'bracket', 'dead centre is a bracket');
    ok(P({ x: 60, y: 60 }).mode === 'bracket' && P({ x: 940, y: 740 }).mode === 'bracket', 'the inset edge itself still counts as on screen');

    const l = P({ x: 10, y: 400 });
    ok(l.mode === 'edge' && l.side === 'left' && l.x === 60 && l.y === 400, 'off the left edge clamps to the inset (' + JSON.stringify(l) + ')');
    const r = P({ x: 1200, y: 400 });
    ok(r.mode === 'edge' && r.side === 'right' && r.x === 940, 'off the right edge clamps to the inset');
    const u = P({ x: 500, y: -50 });
    ok(u.mode === 'edge' && u.side === 'up' && u.y === 60, 'above the viewport reads as up');
    const d = P({ x: 500, y: 900 });
    ok(d.mode === 'edge' && d.side === 'down' && d.y === 740, 'below it reads as down');
    // A corner belongs to whichever axis it is further off, which is the way you would turn.
    ok(P({ x: -400, y: -70 }).side === 'left', 'a corner mostly off the left is a left chevron');
    ok(P({ x: -70, y: -400 }).side === 'up', '…and mostly off the top is an up chevron');

    // Behind the camera: no pixel at all, so the side comes from the relative bearing.
    const behindR = P(null, 120);
    ok(behindR.mode === 'edge' && behindR.side === 'right' && behindR.x === 940, 'a gate over the right shoulder gets a right chevron');
    const behindL = P(null, -120);
    ok(behindL.side === 'left' && behindL.x === 60, 'and over the left shoulder, a left chevron');
    ok(P(null, 200).side === 'left', 'a relative bearing past 180 wraps to the left side');
    ok(P(undefined, undefined).mode === 'edge', 'no pixel and no bearing still produces something drawable');
    ok(P({ x: NaN, y: 400 }, 90).mode === 'edge', 'a half-finite pixel is treated as no pixel');
  }

  console.log('Waypoint: the bracket and chevron captions (pure)');
  {
    const { bracketLabel, chevronLabel, turnInstruction } = E0.R._internals;
    ok(bracketLabel(4, 1800, 118.87) === 'GATE 4 · 1.8 km · climb 390 ft', 'the task\'s example label (' + bracketLabel(4, 1800, 118.87) + ')');
    ok(bracketLabel('START', 420, -200) === 'START · 420 m · descend 656 ft', 'a named gate and a descent');
    ok(bracketLabel(2, 900, 3) === 'GATE 2 · 900 m', 'a trivial altitude difference is left out');
    const turn = turnInstruction(164, 90);
    ok(chevronLabel(turn, 1800, 118.87) === 'turn right 74° · 1.8 km · climb 390 ft', 'the chevron leads with the turn');
    ok(chevronLabel(null, 1800, 0) === '1.8 km', 'no turn and no climb leaves just the distance');
  }

  console.log('Waypoint: G.worldToScreen wraps Cesium, both spellings, null behind the camera');
  {
    const E = env();
    await E.bootFrames();
    const G = E.R._internals.G;
    ok(JSON.stringify(G.worldToScreen(45, -122, 1000)) === '{"x":400,"y":300}', 'projects to CSS pixels');
    E.projector.fn = () => undefined;
    ok(G.worldToScreen(45, -122, 1000) === null, 'undefined (behind the camera) becomes null');
    E.projector.fn = () => ({ x: NaN, y: 3 });
    ok(G.worldToScreen(45, -122, 1000) === null, 'a non-finite pixel becomes null');
    E.projector.fn = () => { throw new Error('boom'); };
    ok(G.worldToScreen(45, -122, 1000) === null, 'a throw becomes null, never an exception in the frame loop');
    ok(G.worldToScreen(NaN, -122, 1000) === null, 'a bad position becomes null');

    const E2 = env({ sceneTransforms: 'new' });
    await E2.bootFrames();
    ok(JSON.stringify(E2.R._internals.G.worldToScreen(45, -122, 1000)) === '{"x":400,"y":300}',
      'the renamed worldToWindowCoordinates is used when it is the only one present');

    const E3 = env({ sceneTransforms: 'none' });
    await E3.bootFrames();
    ok(E3.R._internals.G.worldToScreen(45, -122, 1000) === null, 'neither spelling present = null, not a throw');
  }

  console.log('Waypoint: the HUD draws a bracket at the gate, a chevron off screen, and follows every frame');
  {
    const E = env();
    await E.bootFrames();
    E.setPos(along(-1000)); E.frame(16);
    E.R.loadCourse(course());
    E.setPos(along(500)); E.frame(16);
    const wp = E.w.document.getElementById('fr-hud-wp');
    const wp2 = E.w.document.getElementById('fr-hud-wp2');
    ok(!!wp && !!wp2, 'both markers exist in the HUD DOM');

    E.projector.fn = () => ({ x: 512, y: 300 });
    E.frame(16);
    ok(wp.classList.contains('fr-hud-wp-show'), 'shown while armed');
    ok(!wp.classList.contains('fr-hud-wp-edge'), 'on screen it is a bracket, not a chevron');
    ok(wp.style.transform === 'translate3d(512px,300px,0)', 'placed with translate3d at the projected pixel (' + wp.style.transform + ')');
    ok(wp.style.length === 1 && wp.style.item(0) === 'transform',
      'and nothing but transform is ever written (' + wp.style.cssText + ')');
    const wpLabel = E.w.document.querySelector('.fr-hud-wp-label');
    ok(/^START · /.test(wpLabel.textContent), 'labelled for the gate it points at: ' + wpLabel.textContent);
    ok(/km$|m$/.test(wpLabel.textContent), '…with a distance');

    // Moves on the very next frame — this element is not on the HUD_HZ clock.
    E.projector.fn = () => ({ x: 513, y: 301 });
    E.frame(16);
    ok(wp.style.transform === 'translate3d(513px,301px,0)', 'follows on the next animation frame, not at HUD_HZ');

    // Off the right of the viewport: an edge chevron on the correct side.
    E.projector.fn = () => ({ x: 5000, y: 300 });
    E.frame(16);
    ok(wp.classList.contains('fr-hud-wp-edge') && wp.classList.contains('fr-hud-wp-right'), 'becomes a right-side chevron');
    ok(wp.style.transform === 'translate3d(' + (E.w.innerWidth - 60) + 'px,300px,0)', 'clamped to the 60 px inset');
    ok(E.w.document.querySelector('.fr-hud-wp-chev').textContent === '▶', 'and the glyph points the right way');
    ok(/^turn (left|right) \d+°/.test(wpLabel.textContent), 'the caption leads with the turn: ' + wpLabel.textContent);

    // Behind the camera: still a chevron, sided from the bearing rather than a pixel.
    E.projector.fn = () => undefined;
    E.frame(16);
    ok(wp.classList.contains('fr-hud-wp-edge'), 'a gate behind the camera is still shown as a chevron');
    ok(/^turn /.test(wpLabel.textContent), '…with the turn that brings it back: ' + wpLabel.textContent);

    // Hidden when there is nothing to point at.
    E.R.race.state = 'finished';
    E.frame(16);
    ok(!wp.classList.contains('fr-hud-wp-show') && !wp2.classList.contains('fr-hud-wp-show'), 'hidden once the run is over');
  }

  console.log('Waypoint: the gate after gets a smaller numbered marker, on screen only');
  {
    const E = env();
    await E.bootFrames();
    E.setPos(along(-1000)); E.frame(16);
    E.R.loadCourse(course());
    E.setPos(along(500)); E.frame(16);
    const wp2 = E.w.document.getElementById('fr-hud-wp2');
    // Gate 0 (start) is the target; gate 1 is "the gate after". Put them at different pixels.
    let call = 0;
    E.projector.fn = () => (++call % 2 ? { x: 400, y: 300 } : { x: 600, y: 320 });
    E.frame(16);
    ok(wp2.classList.contains('fr-hud-wp-show'), 'the gate after is marked');
    ok(wp2.style.transform === 'translate3d(600px,320px,0)', 'at its own projected pixel');
    ok(E.w.document.querySelector('.fr-hud-wp2-num').textContent === '1', 'numbered for the gate it is');

    // Off screen: no second chevron competing with the first.
    call = 0;
    E.projector.fn = () => (++call % 2 ? { x: 400, y: 300 } : { x: -900, y: 320 });
    E.frame(16);
    ok(!wp2.classList.contains('fr-hud-wp-show'), 'an off-screen gate-after is simply not drawn');
  }

  console.log('Waypoint: CONFIG.WAYPOINT_BRACKET = false leaves the old panel arrow alone');
  {
    const E = env({ patch: [['WAYPOINT_BRACKET: true,', 'WAYPOINT_BRACKET: false,']] });
    await E.bootFrames();
    E.setPos(along(-1000)); E.frame(16);
    E.R.loadCourse(course());
    E.setPos(along(500)); E.frame(16);
    ok(!E.w.document.getElementById('fr-hud-wp'), 'no bracket in the DOM at all');
    const arrow = E.w.document.getElementById('fr-arrow');
    ok(arrow.style.visibility === 'visible' && /rotate\(-?\d+deg\)/.test(arrow.style.transform),
      'the settings panel arrow still points at the gate (' + arrow.style.transform + ')');
  }

  console.log('Minimap: minimapFit/minimapPoint are a north-up, auto-fitted local projection (pure)');
  {
    const { minimapFit, minimapPoint } = E0.R._internals;
    const pts = [0, 2000, 4000].map((m) => along(m)).concat([along(2000, 1000, 1500)]);
    const fit = minimapFit(pts, 160, 160, 14);
    ok(!!fit, 'fits a course');
    const xy = pts.map((p) => minimapPoint(fit, p.lat, p.lon));
    ok(xy.every((p) => p.x >= 13.9 && p.x <= 146.1 && p.y >= 13.9 && p.y <= 146.1),
      'every point lands inside the padded box (' + xy.map((p) => Math.round(p.x) + ',' + Math.round(p.y)).join(' ') + ')');
    ok(xy.some((p) => p.x < 20 || p.x > 140 || p.y < 20 || p.y > 140), 'and the course actually fills it');

    // North-up: more latitude is further UP the screen.
    const north = minimapPoint(fit, fit.lat0 + 0.01, fit.lon0);
    const south = minimapPoint(fit, fit.lat0 - 0.01, fit.lon0);
    ok(north.y < south.y, 'north is up');
    const east = minimapPoint(fit, fit.lat0, fit.lon0 + 0.01);
    ok(east.x > minimapPoint(fit, fit.lat0, fit.lon0).x, 'east is right');
    ok(near(minimapPoint(fit, fit.lat0, fit.lon0).x, 80, 1e-9), 'the fitted centre is the box centre');

    // One scale for both axes: a square-ish course must not come out stretched.
    const dLat = Math.abs(north.y - south.y), dLon = Math.abs(east.x - minimapPoint(fit, fit.lat0, fit.lon0).x) * 2;
    ok(near(dLat / 0.02, dLon / (0.02 * fit.kx), 1e-6), 'x and y share one scale (no stretching)');

    // Degenerate inputs must not divide by zero or NaN out.
    const one = minimapFit([{ lat: 45, lon: -122 }], 160, 160, 14);
    ok(!!one && Number.isFinite(one.scale) && one.scale > 0, 'a single point still yields a usable fit');
    const p1 = minimapPoint(one, 45, -122);
    ok(near(p1.x, 80, 1e-9) && near(p1.y, 80, 1e-9), '…and lands dead centre');
    const line = minimapFit([{ lat: 45, lon: -122 }, { lat: 45.1, lon: -122 }], 160, 160, 14);
    ok(Number.isFinite(minimapPoint(line, 45.05, -122).y), 'a perfectly north-south course still projects');
    ok(minimapFit([], 160, 160, 14) === null && minimapFit(null, 160, 160, 14) === null, 'nothing to fit = null');
    ok(minimapPoint(null, 45, -122) === null && minimapPoint(line, NaN, -122) === null, 'null in, null out');
    // Date line: two gates either side must not project to opposite ends of the map.
    const dl = minimapFit([{ lat: 0, lon: 179.9 }, { lat: 0, lon: -179.9 }], 160, 160, 14);
    const a = minimapPoint(dl, 0, 179.9), b = minimapPoint(dl, 0, -179.9);
    ok(Math.abs(a.x - b.x) < 160, 'a date-line course stays inside the box (' + Math.round(a.x) + ' vs ' + Math.round(b.x) + ')');
  }

  console.log('Minimap: draws the course, gate states, item box, me + heading, ghost and other racers');
  {
    const boxCourse = course(150, { itemBox: { ...along(3000), radius: 120 } });
    const E = env({ models: GHOST_MODELS });
    await E.bootFrames();
    E.setPos(along(-1000)); E.frame(16);
    E.R.loadCourse(boxCourse);
    E.setPos(along(500)); E.frame(300);
    const MM = E.R.minimap, doc = E.w.document;
    ok(!!doc.querySelector('#fr-hud-map svg.fr-mm'), 'inline SVG lives in #fr-hud-map');
    const route = doc.querySelector('.fr-mm-route').getAttribute('points').trim().split(/\s+/);
    ok(route.length === boxCourse.gates.length, 'the route polyline has one point per gate (' + route.length + ')');
    ok(route.every((p) => /^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(p)), 'every route point is a finite pair');
    ok(doc.querySelectorAll('.fr-mm-gates circle').length === boxCourse.gates.length, 'one dot per gate');
    ok(doc.querySelectorAll('.fr-mm-box rect').length === 1, 'the item box gets its own marker');

    // Gate styling mirrors the 3D gates: done / next / remaining.
    const cls = () => [...doc.querySelectorAll('.fr-mm-gates circle')].map((c) => c.getAttribute('class'));
    ok(cls().join(',') === 'fr-mm-next,fr-mm-rest,fr-mm-rest', 'while armed, gate 1 is next (' + cls().join(',') + ')');
    E.R.race.state = 'running'; E.R.race.next = 2;
    E.frame(300);
    ok(cls().join(',') === 'fr-mm-done,fr-mm-done,fr-mm-next', 'passed gates read done, the current one next');

    // Me: placed and rotated by heading.
    const me = doc.querySelector('.fr-mm-me').getAttribute('transform');
    ok(/^translate\(-?\d+(\.\d+)?,-?\d+(\.\d+)?\) rotate\(90\)$/.test(me), 'my marker is placed and rotated to my heading (' + me + ')');

    // Ghost marker.
    E.R.ghost.trace = { samples: [[0, 45, -122, 1000, 90, 0, 0], [20000, 45.01, -122, 1000, 90, 0, 0]], truncated: false };
    E.R.race.elapsed = 10000;
    E.frame(300);
    const gx = +doc.querySelector('.fr-mm-ghost').getAttribute('cx');
    ok(Number.isFinite(gx) && gx > -99, 'the ghost is drawn on the map (' + gx + ')');

    // Other racers, from the relay's optional standings positions.
    ok(doc.querySelectorAll('.fr-mm-others circle').length === 0, 'no positions from the relay = no dots');
    E.R.powerups.onRelayMessage({ type: 'standings', order: ['Eric', 'Maggie', 'Tom'],
      positions: { Eric: [45, -122], Maggie: [45.005, -122.005], Tom: [45.01, -122.01] } }, E.now());
    E.frame(300);
    ok(doc.querySelectorAll('.fr-mm-others circle').length === 2, 'one dot per OTHER racer, never myself');
    ok([...doc.querySelectorAll('.fr-mm-others circle')].every((c) => +c.getAttribute('cx') > -99), 'and they are placed');

    // Junk off the socket is dropped rather than drawn somewhere wrong.
    E.R.powerups.onRelayMessage({ type: 'standings', order: ['Eric', 'Maggie'],
      positions: { Maggie: [999, -122], Tom: 'nope' } }, E.now());
    E.frame(300);
    ok(E.R.relay.positions === null, 'out-of-range and malformed positions are dropped entirely');
    ok(doc.querySelectorAll('.fr-mm-others circle').length === 0, '…and nothing is drawn for them');
  }

  console.log('Minimap: redraws at 4 Hz, not every frame, and follows a course change');
  {
    const E = env();
    await E.bootFrames();
    E.setPos(along(-1000)); E.frame(16);
    E.R.loadCourse(course());
    E.frame(300);
    const doc = E.w.document, MM = E.R.minimap;
    const draws = [];
    const realDraw = MM.draw.bind(MM);
    let drew = 0;
    const realStyle = MM.styleGates.bind(MM);
    MM.styleGates = () => { drew++; return realStyle(); };
    for (let i = 0; i < 60; i++) { E.setPos(along(500 + i)); E.frame(16); }   // ~1 s
    // MINIMAP_HZ (4) is capped by Hud.render's own HUD_HZ (10) carrier, so the effective rate
    // is 3-4 Hz. What matters is that it is nowhere near the 60 frames that just went past.
    ok(drew >= 2 && drew <= 6, 'the minimap updated a handful of times in a second, not 60 (' + drew + ')');

    const before = doc.querySelector('.fr-mm-route').getAttribute('points');
    E.R.loadCourse({ name: 'Other', gates: [0, 3000, 6000, 9000].map((m) => ({ ...along(m), radius: 150 })) });
    E.frame(300);
    const after = doc.querySelector('.fr-mm-route').getAttribute('points');
    ok(after !== before, 'a different course redraws the route');
    ok(after.trim().split(/\s+/).length === 4, 'with the new gate count (' + after.trim().split(/\s+/).length + ')');
    ok(doc.querySelectorAll('.fr-mm-box rect').length === 0, 'a course with no item box draws no box marker');
  }

  console.log('Minimap: CONFIG.MINIMAP = false draws nothing');
  {
    const E = env({ patch: [['MINIMAP: true,', 'MINIMAP: false,']] });
    await E.bootFrames();
    E.setPos(along(-1000)); E.frame(16);
    E.R.loadCourse(course());
    E.frame(300);
    ok(!E.w.document.querySelector('#fr-hud-map svg'), 'no SVG is ever built');
    ok(E.R.minimap.built === false, 'and the module knows it');
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

  {
    console.log('terrain_probe.js: leg-interpolation + clearance math (no Cesium needed)');
    // Requiring it under plain Node (no ambient `window`) must only export the pure functions —
    // never touch geofs/Cesium/prompt/alert, which is what makes this test possible at all.
    const TP = require('../tools/terrain_probe.js');
    ok(typeof TP.haversineM === 'function' && typeof window === 'undefined', 'requiring it under Node exports pure functions and runs no browser code');

    // Same known distance check_terrain.py's test_haversine_matches_known_distance uses.
    const d1deg = TP.haversineM({ lat: 45.0, lon: -122.0 }, { lat: 46.0, lon: -122.0 });
    ok(near(d1deg, 111195, 60), `haversineM: one degree of latitude ~111195 m (got ${d1deg.toFixed(0)})`);

    const a = { lat: 45.0, lon: -122.0 }, b = { lat: 45.0, lon: -121.0 };
    const mid = TP.interpolateLatLon(a, b, 0.5);
    ok(near(TP.haversineM(a, mid), TP.haversineM(mid, b), 1.0), 'interpolateLatLon: the midpoint is equidistant from both ends');
    ok(near(mid.lat, 45.0, 0.01), 'interpolateLatLon: a great circle at this latitude bulges only slightly');
    const same = TP.interpolateLatLon(a, a, 0.5);
    ok(same.lat === a.lat && same.lon === a.lon, 'interpolateLatLon: coincident points do not blow up');

    ok(TP.chordSagM(40000, 0.0) === 0 && TP.chordSagM(40000, 1.0) === 0, 'chordSagM: zero at both gates');
    const peak = TP.chordSagM(40000, 0.5);
    ok(peak > 25 && peak < 40, `chordSagM: ~31 m over a 40 km leg at the midpoint (got ${peak.toFixed(1)})`);
    ok(TP.chordSagM(10000, 0.5) < 3, 'chordSagM: negligible over a short leg');

    const gates = [
      { lat: 45.0, lon: -122.0, alt: 1000, radius: 150 },
      { lat: 45.0, lon: -121.9, alt: 1000, radius: 150 },
    ];
    const samples = TP.routeSamples(gates, 1000);
    const gateSamples = samples.filter((s) => s.kind === 'gate');
    ok(gateSamples.length === 2 && gateSamples[0].gate === 0 && gateSamples[1].gate === 1, 'routeSamples: every gate is covered');
    const legSamples = samples.filter((s) => s.kind === 'leg');
    ok(legSamples.length > 0, 'routeSamples: a ~7.9 km leg sampled every 1000 m produces interior points');
    const spacing = legSamples.slice(1).map((s, i) => s.alongM - legSamples[i].alongM);
    ok(spacing.every((s) => Math.abs(s - 1000) < 1e-6), 'routeSamples: interior points are evenly spaced');
    const legLen = TP.haversineM(gates[0], gates[1]);
    ok(legSamples.every((s) => s.alongM > 0 && s.alongM < legLen), 'routeSamples: interior points never coincide with a gate');
    const shortGates = [{ lat: 45.0, lon: -122.0, alt: 1000 }, { lat: 45.0005, lon: -122.0, alt: 1000 }];
    ok(TP.routeSamples(shortGates, 1000).filter((s) => s.kind === 'leg').length === 0, 'routeSamples: a short leg gets no interior samples');

    ok(TP.toMsl(1234.5) === 1234.5, 'toMsl: identity — a course alt is already the schema\'s MSL convention');

    ok(TP.classifySample(null, 150) === 'UNVERIFIED', 'classifySample: no terrain data is UNVERIFIED, never a silent PASS');
    ok(TP.classifySample(undefined, 150) === 'UNVERIFIED', 'classifySample: undefined clearance is also UNVERIFIED');
    ok(TP.classifySample(NaN, 150) === 'UNVERIFIED', 'classifySample: NaN clearance is also UNVERIFIED');
    ok(TP.classifySample(-50, 150) === 'FAIL', 'classifySample: negative clearance (buried) fails');
    ok(TP.classifySample(149, 150) === 'FAIL', 'classifySample: just under the margin fails');
    ok(TP.classifySample(150, 150) === 'PASS', 'classifySample: at or above the margin passes');
    ok(TP.MARGIN_M === 150, 'MARGIN_M mirrors check_terrain.py\'s DEFAULT_MARGIN_M (150)');

    ok(TP.courseStatus([{ status: 'PASS' }, { status: 'PASS' }]) === 'PASS', 'courseStatus: all PASS is PASS');
    ok(TP.courseStatus([{ status: 'PASS' }, { status: 'UNVERIFIED' }]) === 'UNVERIFIED', 'courseStatus: any UNVERIFIED (with no FAIL) is UNVERIFIED');
    ok(TP.courseStatus([{ status: 'FAIL' }, { status: 'UNVERIFIED' }]) === 'FAIL', 'courseStatus: FAIL outranks UNVERIFIED');

    ok(TP.pointLabel({ kind: 'gate', gate: 2 }) === 'gate 3', 'pointLabel: gates are reported 1-based');
    ok(TP.pointLabel({ kind: 'leg', leg: [1, 2], alongM: 1800 }) === 'leg 2->3@1.8km', 'pointLabel: legs report which one and how far along');

    const normalized = TP.normalizeGates({ gates: [{ lat: 45, lon: -122, alt: 1000 }, { lat: 45, lon: -121, alt: 1000, radius: 80 }] });
    ok(normalized[0].radius === 150, 'normalizeGates: a missing radius defaults to 150, same as CONFIG.DEFAULT_RADIUS_M');
    ok(normalized[1].radius === 80, 'normalizeGates: an explicit radius is kept');
    let threw = null;
    try { TP.normalizeGates({ gates: [{ lat: 45, lon: -122, alt: 1000 }] }); } catch (e) { threw = e; }
    ok(threw && /fewer than 2/.test(threw.message), 'normalizeGates: rejects a course with fewer than 2 gates');
    threw = null;
    try { TP.normalizeGates({ gates: [{ lat: 'x', lon: -122, alt: 1000 }, { lat: 45, lon: -121, alt: 1000 }] }); } catch (e) { threw = e; }
    ok(threw && /non-numeric/.test(threw.message), 'normalizeGates: rejects a non-numeric lat/lon/alt');
  }

  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
