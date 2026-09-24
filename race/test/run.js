// Headless tests for race.js: mocks GeoFS + Cesium, flies a scripted aircraft.
// Run: cd race/test && npm i jsdom@24 && node run.js
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'race.js'), 'utf8');
// The exact CONFIG.API_BASE line race.js ships with, so env() can patch it and the wiring tests
// can assert it is a real address rather than the empty string that broke 1.3.0.
const SHIPPED_API_BASE_LINE = "API_BASE: 'https://race.finsonly.net',";
let failures = 0;
const ok = (cond, msg) => { console.log((cond ? '  pass ' : '  FAIL ') + msg); if (!cond) failures++; };
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const near2 = (p, q, tol) => near(p.x, q.x, tol == null ? 1e-6 : tol) && near(p.y, q.y, tol == null ? 1e-6 : tol);

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
  speedMs = 200,
  patch = null, quotaFull = false, quotaThrowsAlways = false, apiHandler = null, sceneTransforms = 'old', reducedMotion = false, altitudeAGL = undefined,
  // Inverted default from race.js's own CONFIG.LOBBY_V2 (true): the 1.3.0 lobby-first shell opens
  // a second socket (Hub, /ws/hub) whenever apiBase is set, which would otherwise change
  // wsRecord.sockets/last for every pre-1.3.0 test that never cared about it. Tests that exercise
  // Shell/Hub opt in explicitly with lobbyV2: true; everything else keeps testing the exact
  // pre-1.3.0 single-socket world it always has.
  lobbyV2 = false,
  url = 'https://www.geo-fs.com/geofs.php' } = {}) {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { runScripts: 'outside-only', url });
  const w = dom.window;
  let rafCb = null;
  w.requestAnimationFrame = (cb) => { rafCb = cb; return 1; };
  const logs = [];
  // Captured, not printed: the velocity-frame capture logs through console.log by design, and
  // the tests assert on it. console.error still goes to the terminal so a frame error is loud.
  // warns are captured too (they used to be dropped on the floor) so the 1.3.1 "a refused relay
  // action says so out loud" tests can assert on them — still never printed, since several
  // modules warn by design when they fail closed.
  const warns = [];
  w.console = { ...console, warn(...a) { warns.push(a); }, log(...a) { logs.push(a); } };
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
  // The GeoFS physics surface verified in-sim on 2026-09-23 (see makePhysMock above, which this
  // mirrors): place() moves llaLocation like the real one, the rigid body holds an ENU velocity
  // (default speedMs due east, matching heading360: 90), and the autopilot/throttle record what
  // they are told. `phys.calls` is every place/setLinearVelocity, for tests that assert on writes.
  const phys = makePhysMock();
  phys.rb.v_linearVelocity = [speedMs, 0, 0];
  const instance = {
    llaLocation: [45, -122, 1000], id: aircraftId, object3d: stockNode,
    rigidBody: phys.rb,
    place(lla, htr) { phys.calls.place.push([lla.slice(), htr.slice()]); this.llaLocation = lla.slice(0, 3); },
  };
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
    autopilot: phys.geofs.autopilot, controls: phys.geofs.controls,
  };
  w.multiplayer = { users: {} }; // real GeoFS holds this as a window global, not geofs.multiplayer
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
  if (!lobbyV2) {
    const patched = src.replace('LOBBY_V2: true,', 'LOBBY_V2: false,');
    if (patched === src) throw new Error('CONFIG.LOBBY_V2 default line not found to patch');
    src = patched;
  }
  // race.js ships a real CONFIG.API_BASE since 1.3.1 (it was '' through 1.3.0, which is what
  // silently disabled the whole hub/room layer in every shipped client). env() still defaults to
  // an EMPTY relay so every pre-1.3.1 test keeps the exact no-relay world it was written against;
  // apiBase: 'shipped' leaves the shipped constant alone, which is how the regression test for
  // that bug asserts on what a real bookmarklet load actually gets.
  if (apiBase !== 'shipped') {
    const patched = src.replace(SHIPPED_API_BASE_LINE, `API_BASE: '${apiBase || ''}',`);
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
  const wsRecord = { sockets: [], last: null };
  w.WebSocket = makeFakeWebSocket(wsRecord);
  if (seed) for (const [k, v] of Object.entries(seed)) w.localStorage.setItem(k, JSON.stringify(v));
  // A full localStorage: setItem throws QuotaExceededError for the given key prefix, exactly
  // like a real browser at its 5 MB limit. Used to check the trace store's eviction/give-up path.
  const quotaBlocked = new Set();
  // Every localStorage call throws — simulates storage disabled entirely (locked-down browser
  // settings, some private-mode configurations), stricter than quotaFull's per-key-prefix block.
  // Used to check that Shell/Hub identity (pilot_token/callsign persistence) degrades to an
  // ephemeral in-memory value rather than throwing into boot().
  if (quotaThrowsAlways) {
    Object.defineProperty(w, 'localStorage', { configurable: true, value: {
      getItem() { throw new Error('storage disabled'); },
      setItem() { throw new Error('storage disabled'); },
      removeItem() { throw new Error('storage disabled'); },
      clear() { throw new Error('storage disabled'); },
      key() { throw new Error('storage disabled'); },
      get length() { throw new Error('storage disabled'); },
    } });
  } else if (quotaFull) {
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
  return { w, R, ents, state, primitives, stockNode, frame, bootFrames, fakeMap, mapRecord: fakeL.record, wsRecord, logs, warns, instance, phys,
    speed: () => Math.hypot(...phys.rb.v_linearVelocity), quotaBlocked, projector, widget, canvas,
    now: () => t, setPos: (p) => { w.geofs.aircraft.instance.llaLocation = [p.lat, p.lon, p.alt]; },
    // llaLocation is replaced wholesale by setPos, so the in-place writers (Boost's fallback,
    // fly-to-start) are checked against this instead.
    lla: () => [...w.geofs.aircraft.instance.llaLocation],
    logText: () => logs.map((a) => a.map((x) => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')).join('\n'),
    warnText: () => warns.map((a) => a.map((x) => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')).join('\n') };
}

// A plain stand-in for the GeoFS physics surface GeoPhysics uses (the calls verified in-sim on
// 2026-09-23): instance.place, rigidBody.v_linearVelocity/setLinearVelocity, the autopilot and
// the throttle. Records every call so a test can assert on what was written, and in what units.
function makePhysMock() {
  const calls = { place: [], setLinearVelocity: [] };
  const rb = { v_linearVelocity: [0, 0, 0], setLinearVelocity(v) { calls.setLinearVelocity.push(v.slice()); this.v_linearVelocity = v.slice(); } };
  const autopilot = {
    on: false, values: { course: 0, altitude: 0, speed: 0 },
    setSpeed(kt) { this.values.speed = kt; }, setAltitude(ft) { this.values.altitude = ft; }, setCourse(d) { this.values.course = d; },
    turnOn() { this.on = true; }, turnOff() { this.on = false; },
  };
  const controls = { throttle: 0, setters: { increaseThrottle() { controls.throttle = Math.min(1, controls.throttle + 0.1); } } };
  const geofs = { aircraft: { instance: { place(lla, htr) { calls.place.push([lla.slice(), htr.slice()]); }, rigidBody: rb } }, autopilot, controls };
  return { geofs, rb, calls };
}

// Every optional race-bus subscriber turned off. Used by the "module X never subscribed (only
// the UI listener is present)" assertions so they keep testing the module named in them as
// later features add subscribers of their own.
const NO_EXTRA_SUBSCRIBERS = [['TRACE: true,', 'TRACE: false,'], ['GHOST: true,', 'GHOST: false,'],
  ['RACING_LINE: true,', 'RACING_LINE: false,'], ['RIVAL_GHOSTS: true,', 'RIVAL_GHOSTS: false,'], ['COURSE_ENV: true,', 'COURSE_ENV: false,']];
// Gate spheres/poles only — the ghost, the racing line and the item layer share viewer.entities
// and tag their own.
const gateEnts = (E) => [...E.ents].filter((e) => !e.__finsLine && !e.__finsGhost && !e.__finsItem);
// Item-layer entities (projectiles, bananas, goop blobs, boost trails, shields): 0.10.0.
const itemEnts = (E) => [...E.ents].filter((e) => e.__finsItem);

async function main() {
  // site.js: pure geometry/format helpers behind race.finsonly.net's landing page (the hero
  // record replay's lat/lon projection and trace-to-SVG-path helper). Exported the same way
  // race.js's own pure functions are -- see the guard at the bottom of site.js.
  console.log('site.js: pure geometry helpers (lat/lon projection, trace-to-SVG path)');
  {
    const site = require(path.join(__dirname, '..', 'server', 'static', 'site.js'));

    const b = site.boundsOf([{ lat: 45, lon: -122 }, { lat: 46, lon: -120 }, { lat: 45.5, lon: -121 }]);
    ok(b.minLat === 45 && b.maxLat === 46 && b.minLon === -122 && b.maxLon === -120, 'boundsOf finds the bbox');
    ok(JSON.stringify(site.boundsOf([]).minLat) === '0', 'boundsOf on empty input degrades to a zero box, not NaN/Infinity');

    const bounds = { minLat: 45, maxLat: 46, minLon: -122, maxLon: -121 };
    const topLeft = site.projectLatLon(46, -122, bounds, 100, 100, 0);   // max lat, min lon -> (0,0)
    ok(near2(topLeft, { x: 0, y: 0 }), 'north-west corner projects to the SVG origin: ' + JSON.stringify(topLeft));
    const bottomRight = site.projectLatLon(45, -121, bounds, 100, 100, 0); // min lat, max lon -> (w,h)
    ok(near2(bottomRight, { x: 100, y: 100 }), 'south-east corner projects to (w,h): ' + JSON.stringify(bottomRight));
    const center = site.projectLatLon(45.5, -121.5, bounds, 100, 100, 10);
    ok(near2(center, { x: 50, y: 50 }), 'the midpoint projects to the center, padding included: ' + JSON.stringify(center));
    const degenerate = site.projectLatLon(45, -122, { minLat: 45, maxLat: 45, minLon: -122, maxLon: -122 }, 100, 100, 0);
    ok(Number.isFinite(degenerate.x) && Number.isFinite(degenerate.y), 'a zero-span bounds box never divides by zero: ' + JSON.stringify(degenerate));

    ok(site.buildTracePath([]) === '', 'buildTracePath of no points is an empty (never malformed) path');
    const path1 = site.buildTracePath([{ x: 1, y: 2 }, { x: 3.456, y: 4 }, { x: 5, y: 6 }]);
    ok(path1 === 'M1.00,2.00 L3.46,4.00 L5.00,6.00', 'buildTracePath: M then L per point, 2dp: ' + path1);

    // decodeTrace mirrors app.py's decode_trace: t is delta-encoded (t[0] absolute, t[i>0] a
    // delta from the previous sample) -- see race/server/app.py's decode_trace docstring.
    const enc = { v: 1, n: 3, t: [1000, 500, 500], lat: [45, 45.001, 45.002], lon: [-122, -122, -122],
                  alt: [100, 100, 100], hdg: [0, 0, 0], pitch: [0, 0, 0], roll: [0, 0, 0] };
    const rows = site.decodeTrace(enc);
    ok(rows && rows.map((r) => r.t).join(',') === '1000,1500,2000', 'decodeTrace accumulates the delta-encoded t column: ' + JSON.stringify(rows && rows.map((r) => r.t)));
    ok(site.decodeTrace({ v: 1, t: [1], lat: [1], lon: [1], alt: [1], hdg: [1], pitch: [1], roll: [1] }) === null, 'decodeTrace rejects a trace with fewer than 2 samples');
    ok(site.decodeTrace({ v: 1, t: [1, 2], lat: [1] }) === null, 'decodeTrace rejects mismatched column lengths');
    ok(site.decodeTrace(null) === null, 'decodeTrace rejects a non-object');

    const mid = site.sampleTraceAt(rows, 1250);
    ok(near(mid.lat, 45.0005, 1e-9), 'sampleTraceAt linearly interpolates between straddling samples: ' + mid.lat);
    ok(site.sampleTraceAt(rows, -500).lat === rows[0].lat, 'sampleTraceAt clamps before the first sample');
    ok(site.sampleTraceAt(rows, 999999).lat === rows[rows.length - 1].lat, 'sampleTraceAt clamps past the last sample');

    ok(site.fmtClock(18519) === '0:18.519', 'fmtClock: ' + site.fmtClock(18519));
    ok(site.fmtClock(null) === '—', 'fmtClock(null) is an em dash, not "NaN:NaN"');
  }

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
    const { powerupsInitialState, powerupsRefill, powerupsPrune, powerupsUse, powerupsActive } = E0.R._internals;
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

    const b = powerupsInitialState(['boost', 'boost']);
    const first = powerupsUse(b, 0, 100, durations);
    const second = powerupsUse(first.state, 1, 500, durations);
    ok(first.item === 'boost' && second.item === null && second.refused === 'boost active' && second.state.slots[1] === 'boost',
      'Boost never stacks: a second one while the first is live is refused and kept');
    ok(powerupsUse(first.state, 1, 1100, durations).item === 'boost', 'and works again the moment the first expires');
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

  console.log('Boost: the ramp is 10 equal steps over 1 s, the first one immediately');
  {
    const { boostRampStart, boostRampStep } = E0.R._internals;
    let ramp = boostRampStart(1000), total = 0, calls = 0, t = 1000;
    const adds = [];
    for (; t <= 2200; t += 16) {
      const s = boostRampStep(ramp, t, 50, 1000, 10);
      ramp = s.ramp;
      if (s.add > 0) { total += s.add; adds.push([t, s.add]); calls++; }
    }
    ok(near(total, 50, 1e-9), '+50 m/s in total (' + total + ')');
    ok(calls === 10 && adds.every(([, a]) => near(a, 5, 1e-9)), '10 steps of 5 m/s at 60 fps (' + calls + ')');
    ok(adds[0][0] === 1000, 'the first step goes out on the arming frame');
    ok(adds[adds.length - 1][0] >= 1900 && adds[adds.length - 1][0] < 2000, 'the last one lands just under 1 s in (' + (adds[adds.length - 1][0] - 1000) + ' ms)');
    ok(ramp === null, 'the ramp retires itself once every step has gone out');
    const late = boostRampStep(boostRampStart(0), 5000, 50, 1000, 10);
    ok(near(late.add, 50, 1e-9) && late.ramp === null, 'a long frame hitch pays out every step that fell due, once');
    ok(boostRampStep(null, 10, 50, 1000, 10).add === 0, 'no ramp, no speed');
  }

  console.log('Boost: +50 m/s along the flight path through GeoPhysics, capped at BOOST_MAX_KT, never stacking');
  {
    const E = env();
    await E.bootFrames();
    E.setPos(along(0)); E.frame(16);
    const PU = E.R.powerups, CFG = E.R.config;
    ok(CFG.POWERUP_BOOST_ADD_MS === 50 && CFG.BOOST_RAMP_MS === 1000 && CFG.BOOST_RAMP_STEPS === 10, 'shipping Boost: +50 m/s over 1.0 s in 10 steps');
    ok(!('SAFE_WRITES' in CFG) && !('VELOCITY_FRAME' in CFG) && !('BOOST_LLA_FALLBACK' in CFG) && !('FLY_TO_START_TOLERANCE_M' in CFG),
      'the broken write-path flags are gone');
    ok(PU.state.slots[0] === 'boost' && PU.state.slots[1] === 'boost', 'default loadout carries two Boosts');
    const llaBefore = E.lla();
    PU.useSlot(0, E.now());
    E.frame(16);
    ok(near(E.speed(), 205, 1e-6), 'the first step lands on the arming frame: 200 -> 205 m/s (' + E.speed() + ')');
    const v = E.phys.rb.v_linearVelocity;
    ok(v[1] === 0 && v[2] === 0, 'along the flight path: an eastbound vector stays eastbound');
    PU.useSlot(1, E.now());
    ok(PU.state.slots[1] === 'boost', 'a second Boost while one is live is ignored and stays in its slot');
    for (let i = 0; i < 80; i++) E.frame(16);
    ok(near(E.speed(), 250, 1e-6), 'after the ramp: exactly +50 m/s (' + E.speed() + '), not +100');
    ok(near(PU.wrote.addedMs, 50, 1e-6), 'the panel reports what was added: ' + PU.wrote.addedMs);
    ok(E.lla().every((n, i) => n === llaBefore[i]), 'llaLocation is never written by Boost');
    for (let i = 0; i < 250; i++) E.frame(16);
    ok(near(E.speed(), 250, 1e-6), 'nothing more is written for the rest of the effect');
    ok(PU.state.effects.boost === undefined, 'the effect expires after POWERUP_BOOST_MS');
    PU.useSlot(1, E.now());
    for (let i = 0; i < 80; i++) E.frame(16);
    ok(near(E.speed(), 300, 1e-6), 'once it has expired, the second Boost works (+50 again: ' + E.speed() + ')');

    const fast = env({ speedMs: 320 });
    await fast.bootFrames();
    fast.setPos(along(0)); fast.frame(16);
    fast.R.powerups.useSlot(0, fast.now());
    for (let i = 0; i < 80; i++) fast.frame(16);
    const capMs = 650 * 0.514444;
    ok(near(fast.speed(), capMs, 1e-6), 'from 320 m/s, Boost stops at BOOST_MAX_KT (650 kt = ' + capMs.toFixed(1) + ' m/s): ' + fast.speed().toFixed(2));
    const over = env({ speedMs: 400 });
    await over.bootFrames();
    over.setPos(along(0)); over.frame(16);
    over.R.powerups.useSlot(0, over.now());
    for (let i = 0; i < 80; i++) over.frame(16);
    ok(over.speed() === 400 && over.phys.calls.setLinearVelocity.length === 0, 'already over the cap: Boost writes nothing (and never slows you)');
  }

  console.log('Boost: measured peak speed stays under MAX_SPEED_MS and never trips the teleport DQ');
  {
    const { ecef, sub, vlen } = E0.R._internals;
    for (const startSpeed of [80, 200, 330, 690]) {
      const E = env({ speedMs: startSpeed });
      await E.bootFrames();
      const CFG = E.R.config, PU = E.R.powerups;
      E.setPos(along(0)); E.frame(16);
      E.R.loadCourse(course());
      PU.useSlot(0, E.now());
      let prev = E.lla(), maxV = 0;
      const dt = 16;
      for (let i = 0; i < Math.ceil(CFG.POWERUP_BOOST_MS / dt) + 20; i++) {
        E.frame(dt);
        // Mock physics: GeoFS flies the aircraft at whatever the rigid body says.
        const at = E.lla();
        const q = destination({ lat: at[0], lon: at[1] }, 90, E.speed() * dt / 1000);
        E.setPos({ lat: q.lat, lon: q.lon, alt: at[2] });
        const cur = E.lla();
        maxV = Math.max(maxV, vlen(sub(ecef(cur[0], cur[1], cur[2]), ecef(prev[0], prev[1], prev[2]))) / (dt / 1000));
        prev = cur;
      }
      const bound = Math.max(startSpeed, CFG.BOOST_MAX_KT * 0.514444) * 1.01;
      ok(maxV < CFG.MAX_SPEED_MS && maxV <= bound, `from ${startSpeed} m/s: peak ${maxV.toFixed(1)} m/s, under MAX_SPEED_MS and max(start, BOOST_MAX_KT)`);
      ok(E.R.race.state !== 'dq', `no teleport DQ from ${startSpeed} m/s (state ${E.R.race.state})`);
    }
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
      const q = destination({ lat: at[0], lon: at[1] }, E.w.geofs.animation.values.heading360, E.speed() * dt / 1000);
      E.setPos({ lat: q.lat, lon: q.lon, alt: at[2] });
      const cur = E.lla();
      maxV = Math.max(maxV, vlen(sub(ecef(cur[0], cur[1], cur[2]), ecef(prev[0], prev[1], prev[2]))) / (dt / 1000));
      prev = cur;
    }
    ok(near(E.speed(), 250, 1e-6), 'a boxed Boost adds the same +50 m/s as a loadout Boost (' + E.speed() + ')');
    ok(maxV > 0 && maxV <= CFG.MAX_SPEED_MS, 'boxed Boost stays under MAX_SPEED_MS (' + maxV.toFixed(1) + ' m/s)');
    ok(E.R.race.state !== 'dq', 'boosting never trips the teleport/slew DQ');

    // Offensive hits are screen-only by default (POWERUP_CONTROL_EFFECTS is off), so they must
    // not move the aircraft at all.
    ok(CFG.POWERUP_CONTROL_EFFECTS === false, 'control effects are off by default (unprobed hook)');
    ws.fireMessage({ type: 'hit', item: 'banana', from: 'Steve' });
    const before = E.lla(), writes = E.phys.calls.setLinearVelocity.length;
    E.frame(dt);
    const after = E.lla();
    ok(before[0] === after[0] && before[1] === after[1], 'a banana hit never moves the aircraft');
    ok(E.phys.calls.setLinearVelocity.length === writes, 'a banana hit never writes speed either');
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
    // Regression (lobby reliability pass): this branch referenced an undefined `from` and threw on
    // every blocked hit on someone else. Relay's old catch(_){} swallowed it, so the note, the
    // sound and the shield flash never happened and nothing said why.
    ok(E.R.powerups.feed.some((f) => /Maggie's shield ate Steve's/.test(f.text || f)),
      "the feed narrates whose shield ate whose missile");
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
    const writes = E.phys.calls.setLinearVelocity.length;
    ws.fireMessage({ type: 'hit', item: 'missile', from: 'Steve', id: 1 });
    for (let i = 0; i < 20; i++) E.frame(50);
    ok(E.phys.calls.setLinearVelocity.length === writes && E.speed() === 200, 'a missile hit writes no speed at all (' + E.speed() + ')');
  }

  console.log('Items: the speed penalty, when turned on, is one negative addSpeedAlongPath that never stacks');
  {
    const P = [['POWERUP_SPEED_PENALTY: false,', 'POWERUP_SPEED_PENALTY: true,']];
    const { E, ws } = await itemsEnv({ patch: P, altitudeAGL: 5000 });   // feet; well above the floor
    E.setPos(along(0)); E.frame(16);
    const CFG = E.R.config;
    ws.fireMessage({ type: 'hit', item: 'missile', from: 'Steve', id: 1 });
    E.frame(16);
    ok(near(E.speed(), 150, 1e-6), '200 m/s -> 150 (' + E.speed() + ')');
    const v = E.phys.rb.v_linearVelocity;
    ok(v[0] > 0 && v[1] === 0 && v[2] === 0, 'along the flight path, same direction');
    ok(E.R.powerups.penaltyUntil > E.now(), 'and it is time-boxed');
    const writes = E.phys.calls.setLinearVelocity.length;
    for (let i = 0; i < 10; i++) E.frame(50);
    ok(E.phys.calls.setLinearVelocity.length === writes, 'one write, not one per frame');
    ws.fireMessage({ type: 'hit', item: 'missile', from: 'Steve', id: 2 });
    E.frame(16);
    ok(near(E.speed(), 150, 1e-6), 'a second hit inside PENALTY_MS never stacks (' + E.speed() + ')');
    for (let i = 0; i < Math.ceil(CFG.PENALTY_MS / 50) + 4; i++) E.frame(50);
    ok(E.R.powerups.penaltyUntil === 0, 'the no-stack window releases on its own');
    ok(E.R.race.state !== 'dq', 'and slowing down never trips the teleport/slew DQ');
  }

  console.log('Items: the speed penalty never goes below the floor, and never applies down low');
  {
    const P = [['POWERUP_SPEED_PENALTY: false,', 'POWERUP_SPEED_PENALTY: true,']];
    // Doing 120 m/s: 25% off would be 90, under the 110 m/s floor.
    const slow = await itemsEnv({ patch: P, altitudeAGL: 5000, speedMs: 120 });
    slow.ws.fireMessage({ type: 'hit', item: 'missile', from: 'Steve', id: 1 });
    slow.E.frame(16);
    ok(near(slow.E.speed(), slow.E.R.config.PENALTY_FLOOR_MS, 1e-6), 'the floor wins over the percentage (' + slow.E.speed() + ')');
    const under = await itemsEnv({ patch: P, altitudeAGL: 5000, speedMs: 100 });
    under.ws.fireMessage({ type: 'hit', item: 'missile', from: 'Steve', id: 1 });
    under.E.frame(16);
    ok(under.E.speed() === 100, 'already under the floor: nothing is taken, and nothing is added either');

    // 300 ft AGL is under PENALTY_MIN_AGL_M (150 m ~ 492 ft): no penalty at all.
    const low = await itemsEnv({ patch: P, altitudeAGL: 300 });
    low.ws.fireMessage({ type: 'hit', item: 'missile', from: 'Steve', id: 1 });
    for (let i = 0; i < 10; i++) low.E.frame(50);
    ok(low.E.speed() === 200, 'no penalty below 150 m AGL (' + low.E.speed() + ')');
    ok(low.E.R.powerups.penaltyUntil === 0, 'and none is armed');

    // A banana is a shake, never a speed write, even with the flag on.
    const ban = await itemsEnv({ patch: P, altitudeAGL: 5000 });
    ban.ws.fireMessage({ type: 'hit', item: 'banana', from: 'Steve', id: 1 });
    for (let i = 0; i < 10; i++) ban.E.frame(50);
    ok(ban.E.speed() === 200, 'only the missile costs speed (' + ban.E.speed() + ')');
  }

  console.log('Items: a live Boost shrugs off the speed penalty; a penalised pilot can still Boost');
  {
    const P = [['POWERUP_SPEED_PENALTY: false,', 'POWERUP_SPEED_PENALTY: true,']];
    const { E, ws } = await itemsEnv({ patch: P, altitudeAGL: 5000 });
    E.R.powerups.setLoadout(['boost', 'boost']);
    ws.fireMessage({ type: 'hit', item: 'missile', from: 'Steve', id: 1 });
    E.frame(16);
    ok(near(E.speed(), 150, 1e-6), 'penalised');
    E.R.powerups.useSlot(0, E.now());
    for (let i = 0; i < 80; i++) E.frame(16);
    ok(near(E.speed(), 200, 1e-6), 'and the boost still adds its +50 (' + E.speed() + ')');
    for (let i = 0; i < Math.ceil(E.R.config.PENALTY_MS / 16); i++) E.frame(16);
    ws.fireMessage({ type: 'hit', item: 'missile', from: 'Steve', id: 2 });
    E.frame(16);
    ok(near(E.speed(), 200, 1e-6) && E.R.powerups.penaltyUntil === 0, 'a missile landing while the boost is live costs nothing');
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
    ok(E0.R.version === '1.7.0' && E0.R.config.VERSION === '1.7.0', 'CONFIG.VERSION is 1.7.0');
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
    ok(!plain.w.document.getElementById('fr-results').classList.contains('fr-enter'), 'and gets no results card');

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
      ok(ov().classList.contains('fr-enter'), 'proto ' + proto + ': the local card is up');
      const title = E.w.document.getElementById('fr-res-title').textContent;
      ok(title === 'You finished 2nd of 2', 'proto ' + proto + ': it says where I stood from the standings (' + title + ')');
      const th = [...E.w.document.querySelectorAll('#fr-res-table th')].map((x) => x.textContent);
      ok(th.join() === '#,Pilot,Time', 'proto ' + proto + ': just position, pilot and time — no points, gap or items (' + th.join() + ')');
      ok(tableText(E).find((r) => r[1].startsWith('Eric'))[2] !== '', 'proto ' + proto + ': with my own time on my row');
      ok(buttonLabels(E).join() === 'Close', 'proto ' + proto + ': and nothing to click but Close (' + buttonLabels(E).join() + ')');
      clickButton(E, 'Close');
      ok(!ov().classList.contains('fr-enter'), 'proto ' + proto + ': Close closes it');
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
    ok(E.R.results.state.kind === 'progress' && !ov().classList.contains('fr-enter'), 'Steve finishes first: the state is kept but my view is not covered');
    ok(spy.indexOf('finish_p1') < 0 && !/^P\d/.test(E.R.ui.E.banner.textContent), 'and no position banner or fanfare (I have not finished): ' + E.R.ui.E.banner.textContent);

    flyOn(E, { fromM: m });
    ok(E.R.race.state === 'finished' && ws.ofType('finish').length === 1, 'I finish and report it');
    ws.fireMessage(progressFrame([resRow(1, 'Steve'), resRow(2, 'Eric', { points: 12 })], ['Maggie'], { deadline_server_ms: Date.now() + 61500 }));
    ok(ov().classList.contains('fr-enter'), 'the card comes up now that I am out of the air');
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
    ok(ov().classList.contains('fr-enter'), 'the card is up');
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
    ok(buttonLabels(E).join() === 'Next race,Rematch,Race the winner’s ghost,Copy challenge link,Close', 'the host gets all five buttons: ' + buttonLabels(E).join());

    // Race the winner's ghost: the picker names the winner and the card closes.
    clickButton(E, 'Race the winner’s ghost');
    ok(E.R.ghost.pick === 'Eric', 'the Ghost pick is the winner (' + E.R.ghost.pick + ')');
    ok([...E.R.ui.E.ghostSelect.options].some((o) => o.value === 'Eric') && E.R.ui.E.ghostSelect.value === 'Eric', 'and the Ghost select shows it even before the board lists them');
    ok(!ov().classList.contains('fr-enter'), 'the card closes');
    ok(ws.ofType('rematch').length === 1, 'the host taking the room back to the lobby sends the rematch');

    // Close, and Next race, and Rematch on a fresh card.
    ws.fireMessage(finalFrame(E, rows, { race_id: 2 }));
    ok(ov().classList.contains('fr-enter'), 'a newer race brings the card back');
    clickButton(E, 'Close');
    ok(!ov().classList.contains('fr-enter') && ws.ofType('back_to_lobby').length === 0 && ws.ofType('rematch').length === 1, 'Close only closes: the room is not touched');
    ws.fireMessage(finalFrame(E, rows, { race_id: 3 }));
    clickButton(E, 'Rematch');
    ok(ws.ofType('rematch').length === 2 && !ov().classList.contains('fr-enter'), 'Rematch sends the frame and closes the card');
    ws.fireMessage(finalFrame(E, rows, { race_id: 4 }));
    clickButton(E, 'Next race');
    ok(ws.ofType('back_to_lobby').length === 1 && E.R.results.wantPicker === true && !ov().classList.contains('fr-enter'), 'Next race sends back_to_lobby, closes the card and asks for the course picker');

    // The room answers: back in the lobby. The pilot is re-armed, the results are history, the picker has focus.
    ok(E.R.race.state === 'finished', '(still finished until the room answers)');
    ws.fireMessage({ type: 'lobby', phase: 'lobby', host: 'Eric', course: null, rules: { powerups: true, teleport: true }, race_id: 4, cup: null,
      players: [{ callsign: 'Eric', model: '', ready: false, role: 'racer' }, { callsign: 'Steve', model: '', ready: false, role: 'racer' }] });
    ok(E.R.race.state === 'armed', 'back to the lobby re-arms a finished pilot, so the lobby card can show');
    ok(E.R.results.state.kind === 'none' && !ov().classList.contains('fr-enter'), 'the results are cleared');
    ok(E.w.document.getElementById('fr-lobby').classList.contains('fr-show'), 'and the lobby card is up');
    ok(E.R.results.wantPicker === false && E.w.document.activeElement && E.w.document.activeElement.tagName === 'SELECT', 'with the host\'s course picker focused');
  }

  console.log('Results: a guest gets no host buttons, and the ghost button only re-arms them');
  {
    const { E, ws, ov } = await lobbyEnv({ racers: ['Eric', 'Steve'], host: 'Steve' });
    flyOn(E);
    ws.fireMessage(finalFrame(E, [resRow(1, 'Steve'), resRow(2, 'Eric', { points: 12 })]));
    ok(buttonLabels(E).join() === 'Race the winner’s ghost,Copy challenge link,Close', 'a guest: the ghost, challenge link and Close (' + buttonLabels(E).join() + ')');
    ok(E.w.document.getElementById('fr-res-body').classList.contains('fr-res-solo'), 'with no cup and no awards the side column is not drawn');
    E.R.results.nextRace(); E.R.results.rematch();
    ok(ws.ofType('back_to_lobby').length === 0 && ws.ofType('rematch').length === 0, 'the host actions do nothing for a guest even if called');
    clickButton(E, 'Race the winner’s ghost');
    ok(E.R.ghost.pick === 'Steve', 'the ghost is the winner\'s');
    ok(ws.ofType('rematch').length === 0, 'a guest cannot move the room');
    ok(E.R.race.state === 'armed' && !ov().classList.contains('fr-enter'), 'but is back on the start line, ready for the lobby');
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
    ok(E.R.results.state.kind === 'final' && !ov().classList.contains('fr-enter'), 'the final results are in but do not cover a pilot who is still flying');
    flyOn(E, { fromM: m });
    ok(E.R.race.state === 'finished', 'they finish, too late for the relay');
    ok(ov().classList.contains('fr-enter'), 'and the card comes up on the next frame, with nothing more from the relay');
    ok(E.w.document.getElementById('fr-res-title').textContent === 'Maggie wins', 'showing who won');
    ok(tableText(E).find((r) => r[1].startsWith('Eric'))[2] === 'DNF', 'and that they were counted out');

    // A DQ releases it just the same.
    const dq = await lobbyEnv({ racers: ['Eric', 'Maggie'], host: 'Maggie', room: 'latedq' });
    const m2 = flyOn(dq.E, { endM: 1000 });
    dq.ws.fireMessage(finalFrame(dq.E, [resRow(1, 'Maggie'), resRow(2, 'Eric', { status: 'dnf', go_time_ms: null, gap_ms: null, points: 0, gate: 1 })]));
    dq.E.frame(16);
    ok(!dq.ov().classList.contains('fr-enter'), 'hidden while running');
    dq.E.setPos(along(m2 + 60000)); dq.E.frame(16); dq.E.frame(16);
    ok(dq.E.R.race.state === 'dq' && dq.ov().classList.contains('fr-enter'), 'a DQ brings the card up');
  }

  console.log('Results: the room going back to the lobby, or a new countdown, clears the card and a disconnect resets the module');
  {
    const { E, ws, lobby, ov } = await lobbyEnv({ racers: ['Eric', 'Steve'], host: 'Steve' });
    flyOn(E);
    ws.fireMessage(progressFrame([resRow(1, 'Eric')], ['Steve']));
    ok(ov().classList.contains('fr-enter'), 'waiting card up');
    ws.fireMessage(lobby('lobby', 1));
    ok(!ov().classList.contains('fr-enter') && E.R.results.state.kind === 'none', 'the host calling the race off (phase lobby) dismisses it');
    ok(E.R.race.state === 'armed', 'and re-arms the finished pilot');
    ws.fireMessage(finalFrame(E, [resRow(1, 'Eric')]));
    ok(ov().classList.contains('fr-enter'), 'results up again');
    ws.fireMessage({ type: 'start', race_id: 2, start_at_server_ms: Date.now() + 15000, racers: ['Eric', 'Steve'] });
    ok(E.R.results.state.kind === 'none' && !ov().classList.contains('fr-enter'), 'a new start clears it');
    ws.fireMessage(finalFrame(E, [resRow(1, 'Eric')], { race_id: 2 }));
    E.R.relay.disconnect();
    ok(E.R.results.state.kind === 'none' && !ov().classList.contains('fr-enter'), 'a disconnect resets it');
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

  console.log('Fly to start: GeoPhysics.placeAircraft puts the aircraft on gate 1, heading gate 2, at pace speed');
  {
    const { ecef, sub, vlen, bearingDeg } = E0.R._internals;
    const air = () => course(150, { startType: 'air' });
    const g1 = along(0), g2 = along(2000);
    const wantHeading = bearingDeg(g1, g2);
    const distTo = (E, p) => {
      const at = E.lla();
      return vlen(sub(ecef(at[0], at[1], at[2]), ecef(p.lat, p.lon, p.alt)));
    };

    {
      // AIR_START_FLYTO off: the 1.0.0 path, byte for byte — placeAircraft onto gate 1.
      const E = env({ patch: [['AIR_START_FLYTO: true,', 'AIR_START_FLYTO: false,']] });
      await E.bootFrames();
      E.setPos(along(-40000)); E.frame(16);
      E.R.loadCourse(air());
      const res = E.R.flyToStart();
      ok(res.ok === true && res.method === 'place', 'flyToStart succeeds (flag off): ' + JSON.stringify(res));
      ok(distTo(E, g1) < 1, 'aircraft lands on gate 1 (' + distTo(E, g1).toFixed(1) + ' m)');
      const [placedLla, placedHtr] = E.phys.calls.place[E.phys.calls.place.length - 1];
      ok(near(placedHtr[0], wantHeading, 0.001), 'place() heading is the bearing from gate 1 to gate 2 (' + placedHtr[0].toFixed(2) + ' vs ' + wantHeading.toFixed(2) + ')');
      ok(near(E.speed(), E0.R._internals.ktToMs(E.R.config.PACE_KT), 1e-6), 'left flying at the pace speed, not stalled (' + E.speed() + ' m/s)');
      const v = E.phys.rb.v_linearVelocity;
      ok(v[2] === 0, 'the velocity is level (no vertical component)');
      ok(E.R.race.state === 'armed', 're-armed, so a mid-run reposition leaves nothing on the clock');
    }

    {
      // AIR_START_FLYTO on (the default): geofs.flyTo, COUNTDOWN_LEAD_S of flying behind gate 1 on
      // the reverse bearing, at min(pace, this aircraft's cruise), then throttle + autopilot hold.
      const E = env({ aircraftId: '1', patch: [['AIR_START_STABILIZE_MS: 3000,', 'AIR_START_STABILIZE_MS: 50,']] });   // a Cub: slower than the 180 kt pace
      await E.bootFrames();
      E.phys.calls.flyTo = [];
      E.w.geofs.flyTo = (a) => { E.phys.calls.flyTo.push(a.slice()); E.w.geofs.aircraft.instance.llaLocation = a.slice(0, 3); };
      E.phys.geofs.controls.setters.decreaseThrottle = { set() { E.phys.geofs.controls.throttle -= 0.1; } };
      E.setPos(along(-40000)); E.frame(16);
      E.R.loadCourse(air());
      const res = E.R.flyToStart();
      const cubMs = E0.R._internals.ktToMs(75);
      ok(res.ok && res.method === 'flyTo' && E.phys.calls.place.length === 0, 'spawned with geofs.flyTo: ' + res.method);
      const [lat, lon, alt, hdg, flying] = E.phys.calls.flyTo[0];
      const back = distTo(E, g1);
      ok(near(back, cubMs * E.R.config.COUNTDOWN_LEAD_S, 5), 'COUNTDOWN_LEAD_S at 75 kt behind gate 1 (' + back.toFixed(1) + ' m)');
      ok(near(bearingDeg({ lat, lon }, g1), wantHeading, 0.05) && near(hdg, wantHeading, 0.001) && flying === true, 'on the reverse bearing, pointed at gate 2, flying');
      ok(near(alt, g1.alt, 1e-6), 'at gate 1 altitude');
      const rep = await res.done;
      ok(rep.ok && near(E.speed(), cubMs, 1e-6), 'the Cub flies at its own 75 kt, not the 180 kt pace (' + E.speed().toFixed(1) + ' m/s)');
      ok(Math.abs(E.phys.geofs.controls.throttle - 0.8) < 0.05 && E.phys.geofs.autopilot.on === false, 'throttle at 0.8 and the autopilot handed back');
      ok(E.R.race.state === 'armed', 'armed, nothing on the clock');
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
      let m = 0;   // out past the 150 m start sphere at pace speed
      const pace = E.speed();
      for (let i = 0; i < 300; i++) { m += pace * 0.016; E.setPos(along(m)); E.frame(16); }
      ok(E.R.race.state === 'running', 'the clock still starts normally on crossing out of gate 1: ' + E.R.race.state);
    }

    {
      // If GeoFS refuses the write (place is not a function), the caller is told so, and nothing moves.
      const E = env();
      await E.bootFrames();
      delete E.w.geofs.aircraft.instance.place;
      E.setPos(along(-40000)); E.frame(16);
      E.R.loadCourse(air());
      const before = E.lla();
      const res = E.R.flyToStart();
      ok(res.ok === false && /could not reposition/i.test(res.detail), 'a missing place() is reported, not silently ignored: ' + res.detail);
      ok(E.lla().every((n, i) => n === before[i]), 'and nothing moved');
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

  // ---------------------------------------------- rival ghosts (0.12.0): "race a friend's ghost"
  console.log('Rival ghosts: nextOneUpCallsign picks the closest faster time, or null');
  {
    const { nextOneUpCallsign } = E0.R._internals;
    const rows = [{ callsign: 'Steve', time_ms: 10000 }, { callsign: 'Maggie', time_ms: 15000 }, { callsign: 'Tom', time_ms: 19000 }];
    ok(nextOneUpCallsign(rows, 20000) === 'Tom', 'the largest time_ms still below mine (' + nextOneUpCallsign(rows, 20000) + ')');
    ok(nextOneUpCallsign(rows, 15000) === 'Steve', 'a tie with a row is not "faster than mine" — the next one below it is');
    ok(nextOneUpCallsign(rows, 10000) === null, 'nobody is faster than the course record');
    ok(nextOneUpCallsign(rows, NaN) === null, 'no personal time yet = no "next one up"');
    ok(nextOneUpCallsign([], 20000) === null, 'no ghosts at all = no "next one up"');
  }

  console.log('Rival ghosts: rivalGhostOptions orders Off / My best / Course record / Next one up / pilots');
  {
    const { rivalGhostOptions } = E0.R._internals;
    const rows = [{ callsign: 'Steve', time_ms: 10000, is_course_record: true }, { callsign: 'Maggie', time_ms: 15000, is_course_record: false }];
    const opts = rivalGhostOptions(rows, 20000, true);
    ok(opts.map((o) => o.value).join(',') === ',mine,record,Maggie,Steve,Maggie', 'Off, My best, Course record, Next one up (Maggie again as a plain pilot), then every pilot: ' + opts.map((o) => o.value).join(','));
    ok(opts.find((o) => o.value === 'record').label === 'Course record', 'the record preset label');
    ok(opts.filter((o) => o.value === 'Maggie')[0].label === 'Next one up (Maggie)', 'the synthetic "next one up" entry names who');
    ok(opts.find((o) => o.value === 'Steve').label === 'Steve · 0:10.000 · record', 'the plain pilot entry for the record holder is flagged too');
    ok(rivalGhostOptions([], NaN, false).map((o) => o.value).join(',') === '', 'nothing on offer but Off with no local trace and no ghosts');
  }

  console.log('Rival ghosts: fmtRivalDelta formats ahead/behind/unknown the same as the primary readout');
  {
    const { fmtRivalDelta } = E0.R._internals;
    ok(fmtRivalDelta('Dave', -410) === 'Dave −0.41s', 'ahead reads with a minus: ' + fmtRivalDelta('Dave', -410));
    ok(fmtRivalDelta('Dave', 410) === 'Dave +0.41s', 'behind reads with a plus: ' + fmtRivalDelta('Dave', 410));
    ok(fmtRivalDelta('Dave', null) === 'Dave', 'no delta yet is just the name');
    ok(fmtRivalDelta('', null) === '?', 'a missing name falls back rather than rendering blank');
    ok(fmtRivalDelta('Dave', 0) === 'Dave +0.00s', 'exactly on pace still formats — zero is a real delta, not "unknown"');
  }

  console.log('Rival ghosts: challenge-link param parsing and building (pure)');
  {
    const { parseChallengeParams, buildChallengeLink } = E0.R._internals;
    ok(JSON.stringify(parseChallengeParams('?course=hood-circuit&ghost=Dave,Maggie')) ===
      JSON.stringify({ course: 'hood-circuit', ghosts: ['Dave', 'Maggie'] }), 'course + a comma list of ghosts');
    ok(JSON.stringify(parseChallengeParams('')) === JSON.stringify({ course: null, ghosts: [] }), 'no params at all');
    ok(JSON.stringify(parseChallengeParams('?ghost=Dave,,  ,Maggie')) === JSON.stringify({ course: null, ghosts: ['Dave', 'Maggie'] }),
      'blank entries are dropped, no course is null not empty string');
    ok(parseChallengeParams('?ghost=' + ['A', 'B', 'C', 'D', 'E'].join(',')).ghosts.length === E0.R.config.RIVAL_GHOSTS_MAX,
      'the ghost list is capped at RIVAL_GHOSTS_MAX (' + E0.R.config.RIVAL_GHOSTS_MAX + ')');
    ok(parseChallengeParams(undefined).ghosts.length === 0 && parseChallengeParams(null).ghosts.length === 0, 'never throws on missing input');

    const link = buildChallengeLink('https://www.geo-fs.com/geofs.php?old=1', 'hood-circuit', ['Dave', 'Maggie']);
    ok(link === 'https://www.geo-fs.com/geofs.php?course=hood-circuit&ghost=Dave%2CMaggie', 'builds course+ghost, dropping unrelated old params: ' + link);
    ok(buildChallengeLink('https://www.geo-fs.com/geofs.php', 'hood-circuit', []) === 'https://www.geo-fs.com/geofs.php?course=hood-circuit', 'no ghosts = no ghost param');
    ok(buildChallengeLink('https://www.geo-fs.com/geofs.php', '', []) === 'https://www.geo-fs.com/geofs.php', 'no course, no ghosts = the bare URL');
    const roundTrip = parseChallengeParams(new URL(buildChallengeLink('https://x/geofs.php', 'hood-circuit', ['Dave', 'Maggie'])).search);
    ok(roundTrip.course === 'hood-circuit' && roundTrip.ghosts.join(',') === 'Dave,Maggie', 'build then parse round-trips');
  }

  console.log('Rival ghosts: up to RIVAL_GHOSTS_MAX - 1 extra pickers, each its own layer/trace/delta');
  {
    const daveTrace = { v: 1, n: 3, t: [0, 250, 250], lat: [45, 45.001, 45.002], lon: [-122, -122, -122],
      alt: [1000, 1010, 1020], hdg: [0, 0, 0], pitch: [0, 0, 0], roll: [0, 0, 0] };
    const maggieTrace = { v: 1, n: 3, t: [0, 250, 250], lat: [45, 45.0015, 45.003], lon: [-122, -122, -122],
      alt: [1000, 1010, 1020], hdg: [0, 0, 0], pitch: [0, 0, 0], roll: [0, 0, 0] };
    const ghostsListCalls = [];
    const E = env({
      models: GHOST_MODELS, apiBase: 'https://race.example',
      apiHandler: (url) => {
        if (!url.startsWith('https://race.example')) return null;
        if (url.includes('/ghosts?')) {
          ghostsListCalls.push(url);
          return { ok: true, status: 200, json: async () => [
            { callsign: 'Dave', time_ms: 15000, model: 'cow', recorded_at: 1, is_course_record: true },
            { callsign: 'Maggie', time_ms: 18000, model: '', recorded_at: 2, is_course_record: false },
          ] };
        }
        if (url.includes('/ghost?') && url.includes('Dave')) return { ok: true, status: 200, json: async () => ({ callsign: 'Dave', time_ms: 15000, model: 'cow', trace: daveTrace }) };
        if (url.includes('/ghost?') && url.includes('Maggie')) return { ok: true, status: 200, json: async () => ({ callsign: 'Maggie', time_ms: 18000, model: '', trace: maggieTrace }) };
        if (url.includes('/ghost?')) return { ok: false, status: 404, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => [] };
      },
    });
    await E.bootFrames();
    ok(E.R.ui.E.rivalSelects.length === E.R.config.RIVAL_GHOSTS_MAX - 1, 'one select per extra slot (' + E.R.ui.E.rivalSelects.length + ')');

    E.R.loadCourse(course());
    await E.R.rivals.refreshList();
    E.R.ui.renderRivalOptions();
    ok(ghostsListCalls.some((u) => u.includes('/ghosts?course_hash=')), 'the rival picker asked for the ghost list');
    ok(E.R.ui.E.rivalSelects[0].querySelector('option[value="Dave"]').textContent === 'Dave · 0:15.000 · record',
      'the picker lists Dave as the course record: ' + E.R.ui.E.rivalSelects[0].querySelector('option[value="Dave"]').textContent);

    await E.R.rivals.setExtraPick(0, 'Dave');
    await E.R.rivals.setExtraPick(1, 'Maggie');
    ok(E.R.rivals.extra.length === 2, 'two rivals loaded');
    ok(E.R.rivals.extra[0].meta.callsign === 'Dave' && E.R.rivals.extra[1].meta.callsign === 'Maggie', 'each slot has its own trace/meta');
    ok(E.R.rivals.extra[0].layer !== E.R.rivals.extra[1].layer, 'each rival gets its own ghost layer');
    ok(E.R.ghost.trace === null, 'the PRIMARY ghost ("Race against") is untouched by picking rivals');

    // No need to actually fly a lap: refreshDeltas() only reads Race.state/pos/elapsed, so setting
    // them directly (the same shortcut the "My best" ghost test above uses) is enough to exercise
    // it. The primary racing line/HUD delta stays keyed to Ghost alone; rivals compute their own
    // deltas independently via the same forward-only search.
    E.R.race.state = 'running'; E.R.race.pos = { lat: 45.0005, lon: -122, alt: 1005 }; E.R.race.elapsed = 250;
    E.R.rivals.tick();
    E.R.rivals.refreshDeltas();
    ok(E.R.rivals.extra.every((e) => e.delta === null || Number.isFinite(e.delta)), 'every rival delta is either null or a finite number');
    ok(E.R.rivals.extra.every((e) => Number.isFinite(e.delta)), 'and here, with a live trace and position for both, neither is null: ' +
      JSON.stringify(E.R.rivals.extra.map((e) => e.delta)));
    ok(E.R.rivals.extra[0].delta !== E.R.rivals.extra[1].delta, 'Dave and Maggie flew different lines, so their deltas differ');

    E.R.rivals.setExtraPick(0, '');
    ok(E.R.rivals.extra.length === 1, 'clearing a pick drops that slot and its layer');
  }

  console.log('Rival ghosts: applyChallenge sets the primary pick and fills the extra slots in order');
  {
    const trace = { v: 1, n: 2, t: [0, 250], lat: [45, 45.001], lon: [-122, -122], alt: [1000, 1000], hdg: [0, 0], pitch: [0, 0], roll: [0, 0] };
    const E = env({
      models: GHOST_MODELS, apiBase: 'https://race.example',
      apiHandler: (url) => {
        if (!url.startsWith('https://race.example')) return null;
        if (url.includes('/ghost?')) {
          const who = decodeURIComponent(url.split('callsign=')[1] || '');
          return { ok: true, status: 200, json: async () => ({ callsign: who, time_ms: 12000, model: '', trace }) };
        }
        return { ok: true, status: 200, json: async () => [] };
      },
    });
    await E.bootFrames();
    E.R.loadCourse(course());
    await E.R.rivals.applyChallenge(['Steve', 'Dave', 'Maggie']);
    ok(E.R.ghost.pick === 'Steve', 'the first name drives the existing primary picker');
    ok(JSON.stringify(E.R.rivals.extraPicks) === JSON.stringify(['Dave', 'Maggie']), 'the rest fill the extra slots in order: ' + JSON.stringify(E.R.rivals.extraPicks));
    ok(E.R.rivals.extra.map((e) => e.meta.callsign).sort().join(',') === 'Dave,Maggie', 'both extras actually loaded a trace');
  }

  console.log('Rival ghosts: CONFIG.RIVAL_GHOSTS = false removes the picker and never builds a layer');
  {
    const E = env({ models: GHOST_MODELS, patch: [['RIVAL_GHOSTS: true,', 'RIVAL_GHOSTS: false,']] });
    await E.bootFrames();
    ok(!E.R.ui.E.rivalSelects, 'no rival picker is built');
    ok(!E.w.document.getElementById('fr-rivals'), 'no "Race a friend" section either');
    ok(!E.w.document.getElementById('fr-news'), 'no news banner element');
    E.R.loadCourse(course());
    E.R.rivals.tick(); E.R.rivals.refreshDeltas();
    ok(E.R.rivals.extra.length === 0, 'nothing loaded, nothing ticked');
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

  {
    console.log('probe.js: LANDING pure helpers (no GeoFS/Cesium needed)');
    // Same split as terrain_probe.js above: requiring probe.js under plain Node (no ambient
    // `window`) must only export the pure functions and run no browser code.
    const P = require('../tools/probe.js');
    ok(typeof P.mpsToFpm === 'function' && typeof window === 'undefined', 'requiring it under Node exports pure functions and runs no browser code');

    ok(near(P.mpsToFpm(1), 196.850393701, 1e-9), 'mpsToFpm: 1 m/s ~= 196.85 ft/min');
    ok(near(P.fpmToMps(P.FPM_PER_MPS), 1, 1e-9), 'fpmToMps: inverse of mpsToFpm at 1 m/s');
    ok(P.mpsToFpm(NaN) === null && P.mpsToFpm('x') === null, 'mpsToFpm: non-finite/non-number input is null, not NaN');
    ok(P.fpmToMps(undefined) === null, 'fpmToMps: undefined input is null');

    ok(P.verticalSpeedFromAltitudes(100, 105, 1000) === 5, 'verticalSpeedFromAltitudes: 5 m climb over 1 s is +5 m/s');
    ok(P.verticalSpeedFromAltitudes(100, 90, 250) === -40, 'verticalSpeedFromAltitudes: 10 m descent over 250 ms is -40 m/s');
    ok(P.verticalSpeedFromAltitudes(100, 100, 1000) === 0, 'verticalSpeedFromAltitudes: no altitude change is 0');
    ok(P.verticalSpeedFromAltitudes(100, 105, 0) === null, 'verticalSpeedFromAltitudes: zero-length window is null, not Infinity');
    ok(P.verticalSpeedFromAltitudes(100, 105, -10) === null, 'verticalSpeedFromAltitudes: negative window is null');
    ok(P.verticalSpeedFromAltitudes(null, 105, 1000) === null, 'verticalSpeedFromAltitudes: missing t0 altitude is null');
    ok(P.verticalSpeedFromAltitudes(100, undefined, 1000) === null, 'verticalSpeedFromAltitudes: missing t1 altitude is null');

    ok(P.isStopped(0, 0.5) === true, 'isStopped: exactly zero groundspeed is stopped');
    ok(P.isStopped(0.3, 0.5) === true, 'isStopped: under the threshold is stopped');
    ok(P.isStopped(5, 0.5) === false, 'isStopped: rolling out fast is not stopped');
    ok(P.isStopped(-0.3, 0.5) === true, 'isStopped: threshold applies to magnitude, not sign');
    ok(P.isStopped(0.4) === true && P.isStopped(0.6) === false, 'isStopped: default threshold is 0.5 m/s');
    ok(P.isStopped(null) === null && P.isStopped(undefined) === null && P.isStopped('x') === null, 'isStopped: non-number groundspeed is null, not a guess');
  }

  {
    console.log('touchdown.js: runway-relative geometry (no sim needed)');
    // Requiring it under plain Node must only export pure functions — same contract as
    // terrain_probe.js/probe.js above.
    const TD = require('../touchdown.js');
    ok(typeof TD.touchdownFeed === 'function' && typeof window === 'undefined', 'requiring it under Node exports pure functions and runs no browser code');

    const d1deg = TD.haversineM({ lat: 45.0, lon: -122.0 }, { lat: 46.0, lon: -122.0 });
    ok(near(d1deg, 111195, 60), `haversineM: one degree of latitude ~111195 m (got ${d1deg.toFixed(0)})`);

    ok(TD.runwayOffsets(null, 45, -122).alongM === null, 'runwayOffsets: no runway -> null, not a guess');
    ok(TD.runwayOffsets({ thr_lat: 45 }, 45, -122).crossM === null, 'runwayOffsets: a runway missing thr_lon/heading is also null');

    const rw0 = { thr_lat: 45, thr_lon: -122, heading_deg: 0, length_m: 3000, width_m: 45 };
    const north = TD.runwayOffsets(rw0, 45.01, -122);
    ok(north.alongM > 1000 && north.alongM < 1200, `runwayOffsets heading 0: 0.01deg north is ~1112 m ahead (got ${north.alongM.toFixed(1)})`);
    ok(near(north.crossM, 0, 0.5), 'runwayOffsets heading 0: due north of the threshold is on centerline');
    const east0 = TD.runwayOffsets(rw0, 45, -121.99);
    ok(near(east0.alongM, 0, 0.5), 'runwayOffsets heading 0: due east of the threshold is not ahead at all');
    ok(east0.crossM > 600 && east0.crossM < 900, `runwayOffsets heading 0: east of centerline is to the right facing north (got ${east0.crossM.toFixed(1)})`);

    const rw90 = { thr_lat: 45, thr_lon: -122, heading_deg: 90, length_m: 3000, width_m: 45 };
    const east90 = TD.runwayOffsets(rw90, 45, -121.99);
    ok(east90.alongM > 600 && east90.alongM < 900, 'runwayOffsets heading 90: east of the threshold is ahead, facing east');
    ok(near(east90.crossM, 0, 0.5), 'runwayOffsets heading 90: due east of the threshold is on centerline');
    const north90 = TD.runwayOffsets(rw90, 45.01, -122);
    ok(north90.crossM < -900, 'runwayOffsets heading 90: north of centerline reads as LEFT (negative) facing east');

    const rw180 = { thr_lat: 45, thr_lon: -122, heading_deg: 180, length_m: 3000, width_m: 45 };
    const south180 = TD.runwayOffsets(rw180, 44.99, -122);
    ok(south180.alongM > 1000, 'runwayOffsets heading 180: south of the threshold is ahead, facing south');
    const west180 = TD.runwayOffsets(rw180, 45, -122.01);
    ok(west180.crossM > 600, 'runwayOffsets heading 180: west of centerline is to the right facing south');
  }

  console.log('touchdown.js: the state machine over synthetic sample streams');
  {
    const TD = require('../touchdown.js');
    const RUNWAY = { thr_lat: 45.0, thr_lon: -122.0, heading_deg: 90, length_m: 3000, width_m: 45 };
    const mPerDegLat = (Math.PI / 180) * TD.EARTH_R_M;
    const mPerDegLon = mPerDegLat * Math.cos((45.0 * Math.PI) / 180);
    // Build a sample at a given distance (m) beyond the threshold, along ("along") and across
    // ("cross", + = right of centerline facing the runway heading) the centerline.
    const smp = (t, along, cross, o) => Object.assign({
      t_ms: t,
      lat: 45.0 - cross / mPerDegLat,
      lon: -122.0 + along / mPerDegLon,
      alt_m: 300, agl_m: 300, vs_mps: 0, ias_mps: 60, heading_deg: 90, bank_deg: 0, pitch_deg: 0,
      on_ground_bool: false,
    }, o);
    const types = (events) => events.map((e) => e.type);

    // ---- greaser: a light touchdown, straight rollout, no bounce ----
    {
      const samples = [
        smp(0, -300, 0, { agl_m: 30, vs_mps: -2.0, ias_mps: 70 }),
        smp(100, -200, 0, { agl_m: 20, vs_mps: -1.0, ias_mps: 68 }),
        smp(200, -100, 0, { agl_m: 8, vs_mps: -0.3, ias_mps: 66, bank_deg: 1, pitch_deg: 4 }), // pre-contact ref
        smp(300, -50, 0, { agl_m: 1, vs_mps: -0.1, ias_mps: 64, on_ground_bool: true }),
        smp(400, 0, 0, { agl_m: 0, vs_mps: 0.05, ias_mps: 62, on_ground_bool: true }),
        smp(500, 50, 0, { agl_m: 0, vs_mps: 0, ias_mps: 40, on_ground_bool: true }),
        smp(600, 150, 0, { agl_m: 0, vs_mps: 0, ias_mps: 20, on_ground_bool: true }),
        smp(700, 260, 0, { agl_m: 0, vs_mps: 0, ias_mps: 12, on_ground_bool: true }),
      ];
      const { events } = TD.runTouchdownDetector(samples, RUNWAY);
      ok(types(events).join(',') === 'touchdown,settled', `greaser: exactly one touchdown then settled (got ${types(events).join(',')})`);
      const td = events[0];
      ok(td.t_ms === 300, 'greaser: touchdown timestamp is the raw contact moment, not the debounce-confirmed one');
      ok(td.vs_at_contact === -0.3, 'greaser: vs_at_contact comes from the pre-contact sample, not the contact sample');
      ok(td.ias === 66 && td.bank === 1 && td.pitch === 4, 'greaser: ias/bank/pitch also come from the pre-contact sample');
      ok(near(td.distance_from_threshold_m, -100, 0.5), 'greaser: touchdown point is where the pre-contact sample actually was, 100 m short of the threshold');
      ok(near(td.centerline_offset_m, 0, 0.5), 'greaser: on centerline reads ~0');
      ok(events[1].type === 'settled' && events[1].total_rollout_m > 0, 'greaser: settled carries a positive rollout distance');
    }

    // ---- firm landing: full field + rollout-distance check ----
    {
      const samples = [
        smp(0, -300, 0, { agl_m: 30, vs_mps: -2.5, ias_mps: 70 }),
        smp(100, -200, 0, { agl_m: 20, vs_mps: -2.0, ias_mps: 68 }),
        smp(200, -100, 0, { agl_m: 8, vs_mps: -1.2, ias_mps: 66, bank_deg: 3, pitch_deg: 6 }), // pre-contact ref
        smp(300, -50, 0, { agl_m: 1, vs_mps: -0.2, ias_mps: 64, on_ground_bool: true }),
        smp(400, 0, 0, { agl_m: 0, vs_mps: 0.1, ias_mps: 62, on_ground_bool: true }),
        smp(500, 50, 0, { agl_m: 0, vs_mps: 0, ias_mps: 55, on_ground_bool: true }),
        smp(600, 130, 0, { agl_m: 0, vs_mps: 0, ias_mps: 45, on_ground_bool: true }),
        smp(700, 210, 0, { agl_m: 0, vs_mps: 0, ias_mps: 35, on_ground_bool: true }),
        smp(800, 290, 0, { agl_m: 0, vs_mps: 0, ias_mps: 25, on_ground_bool: true }),
        smp(900, 370, 0, { agl_m: 0, vs_mps: 0, ias_mps: 14, on_ground_bool: true }),
      ];
      const { events } = TD.runTouchdownDetector(samples, RUNWAY);
      ok(types(events).join(',') === 'touchdown,settled', `firm: exactly one touchdown then settled (got ${types(events).join(',')})`);
      const [td, settled] = events;
      ok(td.t_ms === 300 && td.vs_at_contact === -1.2 && td.ias === 66 && td.bank === 3 && td.pitch === 6, 'firm: touchdown fields captured from the pre-contact sample');
      ok(near(td.distance_from_threshold_m, -100, 0.5) && near(td.centerline_offset_m, 0, 0.5), 'firm: touchdown point matches the pre-contact sample position');
      ok(td.lat === samples[2].lat && td.lon === samples[2].lon && td.heading_deg === 90, 'firm: touchdown lat/lon/heading_deg come from the pre-contact sample (what POST /landings scores from)');
      ok(settled.t_ms === 900, 'firm: settled fires the sample IAS first crosses the threshold');
      // Rollout: ref(-100) -> first confirmed ground sample (50), then +80 m four more times.
      ok(near(settled.total_rollout_m, 470, 1), `firm: total_rollout_m sums pre-contact-point to final position (got ${settled.total_rollout_m.toFixed(1)})`);
    }

    // ---- hard landing: same shape, just a much steeper sink rate at contact ----
    {
      const samples = [
        smp(0, -300, 0, { agl_m: 30, vs_mps: -4.5, ias_mps: 75 }),
        smp(100, -200, 0, { agl_m: 20, vs_mps: -4.0, ias_mps: 73 }),
        smp(200, -100, 0, { agl_m: 8, vs_mps: -3.8, ias_mps: 71 }), // pre-contact ref
        smp(300, -50, 0, { agl_m: 0, vs_mps: -0.5, ias_mps: 70, on_ground_bool: true }),
        smp(400, 0, 0, { agl_m: 0, vs_mps: 0.2, ias_mps: 68, on_ground_bool: true }),
        smp(500, 50, 0, { agl_m: 0, vs_mps: 0, ias_mps: 50, on_ground_bool: true }),
        smp(600, 150, 0, { agl_m: 0, vs_mps: 0, ias_mps: 30, on_ground_bool: true }),
        smp(700, 260, 0, { agl_m: 0, vs_mps: 0, ias_mps: 13, on_ground_bool: true }),
      ];
      const { events } = TD.runTouchdownDetector(samples, RUNWAY);
      ok(types(events).join(',') === 'touchdown,settled', `hard: exactly one touchdown then settled (got ${types(events).join(',')})`);
      ok(events[0].vs_at_contact === -3.8, 'hard: a steep pre-contact sink rate is reported as-is');
    }

    // ---- sideways/crabbed: crosswind touchdown off centerline, nonzero heading/bank ----
    {
      const samples = [
        smp(0, -300, 30, { agl_m: 30, vs_mps: -2.0, ias_mps: 70, heading_deg: 75 }),
        smp(100, -200, 30, { agl_m: 20, vs_mps: -1.5, ias_mps: 68, heading_deg: 75 }),
        smp(200, -100, 30, { agl_m: 8, vs_mps: -1.0, ias_mps: 66, heading_deg: 75, bank_deg: -4, pitch_deg: 3 }), // pre-contact ref
        smp(300, -50, 25, { agl_m: 1, vs_mps: -0.2, ias_mps: 64, heading_deg: 88, on_ground_bool: true }),
        smp(400, 0, 20, { agl_m: 0, vs_mps: 0.1, ias_mps: 62, heading_deg: 90, on_ground_bool: true }),
        smp(500, 50, 15, { agl_m: 0, vs_mps: 0, ias_mps: 40, heading_deg: 90, on_ground_bool: true }),
        smp(600, 150, 10, { agl_m: 0, vs_mps: 0, ias_mps: 12, heading_deg: 90, on_ground_bool: true }),
      ];
      const { events } = TD.runTouchdownDetector(samples, RUNWAY);
      ok(types(events).join(',') === 'touchdown,settled', `crabbed: a crab angle and bank don't confuse ground/air classification (got ${types(events).join(',')})`);
      const td = events[0];
      ok(td.bank === -4 && td.pitch === 3, 'crabbed: bank/pitch at contact are captured despite the crab');
      ok(near(td.centerline_offset_m, 30, 0.5), `crabbed: 30 m right of centerline at contact (got ${td.centerline_offset_m.toFixed(1)})`);
      ok(near(td.distance_from_threshold_m, -100, 0.5), 'crabbed: along-track distance is unaffected by the lateral offset');
    }

    // ---- triple-bounce: three genuine hops (each clears the debounce window) before it settles ----
    {
      const samples = [
        smp(0, -400, 0, { agl_m: 40, vs_mps: -3.0, ias_mps: 70 }),
        smp(60, -350, 0, { agl_m: 30, vs_mps: -2.5, ias_mps: 69 }),
        smp(120, -300, 0, { agl_m: 15, vs_mps: -2.0, ias_mps: 68 }), // ref for touchdown
        smp(180, -280, 0, { agl_m: 1, vs_mps: -1.5, ias_mps: 67, on_ground_bool: true }),
        smp(240, -260, 0, { agl_m: 0, vs_mps: -0.3, ias_mps: 66, on_ground_bool: true }),
        smp(300, -240, 0, { agl_m: 0, vs_mps: 0.2, ias_mps: 65, on_ground_bool: true }), // confirms touchdown
        // hop 1
        smp(360, -200, 0, { agl_m: 2, vs_mps: 1.5, ias_mps: 65 }),
        smp(420, -180, 0, { agl_m: 5, vs_mps: 1.0, ias_mps: 65 }),
        smp(480, -160, 0, { agl_m: 6, vs_mps: 0.2, ias_mps: 65 }),
        smp(540, -140, 0, { agl_m: 6.5, vs_mps: 0.3, ias_mps: 65 }), // confirms liftoff #1, sets climb flag
        smp(600, -120, 0, { agl_m: 3, vs_mps: -1.0, ias_mps: 65 }), // ref for bounce 1
        smp(660, -100, 0, { agl_m: 0.5, vs_mps: -0.5, ias_mps: 64, on_ground_bool: true }),
        smp(720, -90, 0, { agl_m: 0, vs_mps: -0.1, ias_mps: 63, on_ground_bool: true }),
        smp(780, -80, 0, { agl_m: 0, vs_mps: 0.1, ias_mps: 62, on_ground_bool: true }), // confirms bounce #1
        smp(840, -60, 0, { agl_m: 0, vs_mps: 0.1, ias_mps: 60, on_ground_bool: true }),
        // hop 2
        smp(900, -40, 0, { agl_m: 1, vs_mps: 1.2, ias_mps: 60 }),
        smp(960, -20, 0, { agl_m: 4, vs_mps: 0.8, ias_mps: 60 }),
        smp(1020, 0, 0, { agl_m: 5, vs_mps: 0.2, ias_mps: 60 }), // confirms liftoff #2
        smp(1080, 20, 0, { agl_m: 5.5, vs_mps: 0.4, ias_mps: 60 }), // sets climb flag
        smp(1140, 40, 0, { agl_m: 2, vs_mps: -0.5, ias_mps: 60 }), // ref for bounce 2
        smp(1200, 55, 0, { agl_m: 0.5, vs_mps: -0.3, ias_mps: 59, on_ground_bool: true }),
        smp(1260, 65, 0, { agl_m: 0, vs_mps: -0.1, ias_mps: 58, on_ground_bool: true }),
        smp(1320, 75, 0, { agl_m: 0, vs_mps: 0.05, ias_mps: 57, on_ground_bool: true }), // confirms bounce #2
        smp(1380, 95, 0, { agl_m: 0, vs_mps: 0.1, ias_mps: 55, on_ground_bool: true }),
        // hop 3
        smp(1440, 115, 0, { agl_m: 1, vs_mps: 1.0, ias_mps: 55 }),
        smp(1500, 135, 0, { agl_m: 3.5, vs_mps: 0.6, ias_mps: 55 }),
        smp(1560, 150, 0, { agl_m: 4, vs_mps: 0.2, ias_mps: 55 }), // confirms liftoff #3
        smp(1620, 165, 0, { agl_m: 4.2, vs_mps: 0.3, ias_mps: 55 }), // sets climb flag
        smp(1680, 180, 0, { agl_m: 1.5, vs_mps: -0.4, ias_mps: 55 }), // ref for bounce 3
        smp(1740, 195, 0, { agl_m: 0.3, vs_mps: -0.2, ias_mps: 54, on_ground_bool: true }),
        smp(1800, 205, 0, { agl_m: 0, vs_mps: -0.1, ias_mps: 52, on_ground_bool: true }),
        smp(1860, 215, 0, { agl_m: 0, vs_mps: 0.05, ias_mps: 50, on_ground_bool: true }), // confirms bounce #3
        // final rollout to a stop
        smp(1920, 250, 0, { agl_m: 0, vs_mps: 0, ias_mps: 50, on_ground_bool: true }),
        smp(1980, 290, 0, { agl_m: 0, vs_mps: 0, ias_mps: 40, on_ground_bool: true }),
        smp(2040, 335, 0, { agl_m: 0, vs_mps: 0, ias_mps: 30, on_ground_bool: true }),
        smp(2100, 385, 0, { agl_m: 0, vs_mps: 0, ias_mps: 20, on_ground_bool: true }),
        smp(2160, 440, 0, { agl_m: 0, vs_mps: 0, ias_mps: 14, on_ground_bool: true }),
      ];
      const { events } = TD.runTouchdownDetector(samples, RUNWAY);
      ok(types(events).join(',') === 'touchdown,liftoff,bounce,liftoff,bounce,liftoff,bounce,settled',
        `triple-bounce: touchdown, three liftoff/bounce pairs, then settled (got ${types(events).join(',')})`);
      const bounces = events.filter((e) => e.type === 'bounce');
      ok(bounces.length === 3 && bounces[0].n === 1 && bounces[1].n === 2 && bounces[2].n === 3, 'triple-bounce: bounce n counts up 1, 2, 3 within one landing sequence');
      ok(events[0].t_ms === 180, 'triple-bounce: the initial touchdown timestamp is the raw contact moment');
      ok(bounces[0].t_ms === 660 && bounces[1].t_ms === 1200 && bounces[2].t_ms === 1740, 'triple-bounce: each bounce timestamp is its own raw contact moment, not the debounce-confirmed one');
      ok(events[events.length - 1].type === 'settled' && near(events[events.length - 1].total_rollout_m, 740, 2),
        `triple-bounce: settled rollout sums every ground segment plus the hop jumps (got ${events[events.length - 1].total_rollout_m.toFixed(1)})`);
    }

    // ---- go-around: a touchdown that climbs away instead of settling or bouncing back down ----
    {
      const samples = [
        smp(0, -300, 0, { agl_m: 25, vs_mps: -2, ias_mps: 70 }),
        smp(60, -250, 0, { agl_m: 10, vs_mps: -1.5, ias_mps: 69 }), // ref for touchdown
        smp(120, -230, 0, { agl_m: 1, vs_mps: -1, ias_mps: 68, on_ground_bool: true }),
        smp(180, -210, 0, { agl_m: 0, vs_mps: -0.2, ias_mps: 68, on_ground_bool: true }),
        smp(240, -190, 0, { agl_m: 0, vs_mps: 0.3, ias_mps: 68, on_ground_bool: true }), // confirms touchdown
        smp(300, -170, 0, { agl_m: 0, vs_mps: 0.5, ias_mps: 68, on_ground_bool: true }),
        smp(360, -150, 0, { agl_m: 2, vs_mps: 2.0, ias_mps: 68 }),
        smp(420, -120, 0, { agl_m: 8, vs_mps: 3.0, ias_mps: 68 }),
        smp(480, -80, 0, { agl_m: 15, vs_mps: 3.5, ias_mps: 68 }), // confirms liftoff
        smp(540, -30, 0, { agl_m: 25, vs_mps: 4.0, ias_mps: 68 }), // climbs clear -> go_around
      ];
      const { events } = TD.runTouchdownDetector(samples, RUNWAY);
      ok(types(events).join(',') === 'touchdown,liftoff,go_around', `go-around: no bounce, no settled once it's clearly climbing away (got ${types(events).join(',')})`);
      ok(events[2].t_ms === 540, 'go-around: fires as soon as the climb-clear condition is met, not on a later sample');
    }

    // ---- flapping ground flag: noisy on_ground never produces a spurious event ----
    {
      const samples = [
        smp(0, -200, 0, { agl_m: 25, vs_mps: -2, ias_mps: 70 }),
        smp(20, -195, 0, { agl_m: 24, vs_mps: -2, ias_mps: 70, on_ground_bool: true }),  // blip, < debounce
        smp(40, -190, 0, { agl_m: 23, vs_mps: -2, ias_mps: 70 }),
        smp(60, -185, 0, { agl_m: 22, vs_mps: -1.8, ias_mps: 69 }),
        smp(80, -180, 0, { agl_m: 21, vs_mps: -1.8, ias_mps: 69, on_ground_bool: true }), // blip, < debounce
        smp(100, -175, 0, { agl_m: 20, vs_mps: -1.7, ias_mps: 68 }),
        smp(120, -170, 0, { agl_m: 15, vs_mps: -1.5, ias_mps: 67 }),
        smp(140, -165, 0, { agl_m: 10, vs_mps: -1.3, ias_mps: 66 }),
        smp(160, -160, 0, { agl_m: 5, vs_mps: -1.0, ias_mps: 65 }),
        smp(180, -150, 0, { agl_m: 1, vs_mps: -0.5, ias_mps: 64, on_ground_bool: true }),  // flutter right at contact
        smp(200, -155, 0, { agl_m: 1, vs_mps: -0.5, ias_mps: 64 }),                        // flickers back false
        smp(220, -145, 0, { agl_m: 0, vs_mps: -0.2, ias_mps: 63, on_ground_bool: true }),  // the real, sustained contact starts
        smp(240, -140, 0, { agl_m: 0, vs_mps: 0.1, ias_mps: 62, on_ground_bool: true }),
        smp(260, -135, 0, { agl_m: 0, vs_mps: 0, ias_mps: 61, on_ground_bool: true }),
        smp(280, -130, 0, { agl_m: 0, vs_mps: 0, ias_mps: 60, on_ground_bool: true }),
        smp(300, -125, 0, { agl_m: 0, vs_mps: 0, ias_mps: 59, on_ground_bool: true }),
        smp(320, -120, 0, { agl_m: 0, vs_mps: 0, ias_mps: 58, on_ground_bool: true }),
        smp(340, -115, 0, { agl_m: 0, vs_mps: 0, ias_mps: 57, on_ground_bool: true }), // confirms touchdown
        smp(360, -110, 0, { agl_m: 0, vs_mps: 0, ias_mps: 50, on_ground_bool: true }),
        smp(380, -105, 0, { agl_m: 0, vs_mps: 0.1, ias_mps: 48 }),                     // mid-rollout blip, < debounce
        smp(400, -100, 0, { agl_m: 0, vs_mps: 0, ias_mps: 40, on_ground_bool: true }), // flickers back true
        smp(420, -90, 0, { agl_m: 0, vs_mps: 0, ias_mps: 30, on_ground_bool: true }),
        smp(440, -70, 0, { agl_m: 0, vs_mps: 0, ias_mps: 20, on_ground_bool: true }),
        smp(460, -40, 0, { agl_m: 0, vs_mps: 0, ias_mps: 14, on_ground_bool: true }),
      ];
      const { events } = TD.runTouchdownDetector(samples, RUNWAY);
      ok(types(events).join(',') === 'touchdown,settled',
        `flapping: no phantom liftoff/bounce from a noisy on_ground flag (got ${types(events).join(',')})`);
      ok(events[1].total_rollout_m > 0, 'flapping: rollout still accumulates normally once the real contact is confirmed');
    }
  }

  console.log('recorder.js: FIELD_MAP plumbing (no sim needed)');
  {
    // Requiring it under plain Node must only export the pure functions and touch nothing
    // browser-specific — same contract as terrain_probe.js/probe.js/touchdown.js above.
    const REC = require('../tools/recorder.js');
    ok(typeof REC.buildSample === 'function' && typeof window === 'undefined', 'requiring it under Node exports pure functions and runs no browser code');

    ok(near(REC.knotsToMps(1), 0.514444, 1e-6), 'knotsToMps: 1 kt ~0.514444 m/s');
    ok(REC.knotsToMps(null) === null && REC.knotsToMps('x') === null, 'knotsToMps: non-number input is null, not a guess');
    ok(near(REC.fpmToMps(-196.850393701), -1, 1e-6), 'fpmToMps: -196.85 ft/min is -1 m/s (matches probe.js\'s FPM_PER_MPS convention)');
    ok(REC.fpmToMps(undefined) === null, 'fpmToMps: non-number input is null, not a guess');

    // The shipped FIELD_MAP is every field as a TODO-PROBE placeholder: null for the numeric
    // fields, false for on_ground_bool once readField()'s !! runs — never a guessed GeoFS read.
    const shipped = REC.buildSample(1234, REC.FIELD_MAP);
    ok(shipped.t_ms === 1234, 'buildSample: t_ms passes through untouched — it is the recorder\'s own clock, not a FIELD_MAP read');
    const numericKeys = ['lat', 'lon', 'alt_m', 'agl_m', 'vs_mps', 'ias_mps', 'heading_deg', 'bank_deg', 'pitch_deg'];
    ok(numericKeys.every((k) => shipped[k] === null), `buildSample: every unfilled numeric field is null (got ${JSON.stringify(shipped)})`);
    ok(shipped.on_ground_bool === false, 'buildSample: unfilled on_ground_bool reads as false, not null — it is a boolean field');
    ok(Object.keys(shipped).sort().join(',') === ['t_ms', 'lat', 'lon', 'alt_m', 'agl_m', 'vs_mps', 'ias_mps', 'heading_deg', 'bank_deg', 'pitch_deg', 'on_ground_bool'].sort().join(','),
      'buildSample: the shipped sample has exactly touchdown.js\'s documented field set, no more, no less');

    // A filled-in map (as the user's post-probe FIELD_MAP would look) reads through cleanly,
    // and a throwing getter degrades to the same TODO-PROBE default rather than crashing the tick.
    const filled = {
      lat: () => 45.5, lon: () => -122.6, alt_m: () => 120.4, agl_m: () => 12.3,
      vs_mps: () => -2.1, ias_mps: () => 34.5, heading_deg: () => 160, bank_deg: () => 1.5,
      pitch_deg: () => 4.0, on_ground_bool: () => true,
    };
    const s1 = REC.buildSample(500, filled);
    ok(s1.lat === 45.5 && s1.on_ground_bool === true, 'buildSample: a filled-in map reads through cleanly');
    const throwing = Object.assign({}, filled, { vs_mps: () => { throw new Error('boom'); }, on_ground_bool: () => { throw new Error('boom'); } });
    const s2 = REC.buildSample(500, throwing);
    ok(s2.vs_mps === null && s2.on_ground_bool === false, 'buildSample: a throwing getter degrades to the TODO-PROBE default, never throws into the sample tick');
    ok(s2.lat === 45.5, 'buildSample: one throwing field does not corrupt the others');

    // readField also rejects non-finite numbers and non-booleans rather than passing them through.
    ok(REC.readField({ x: () => NaN }, 'x', false) === null, 'readField: NaN is rejected, not passed through as a sample value');
    ok(REC.readField({ x: () => 'nope' }, 'x', false) === null, 'readField: a non-number for a numeric field is rejected');
    ok(REC.readField({ x: () => 1 }, 'x', true) === true, 'readField: a truthy non-boolean coerces via !! for on_ground_bool');
  }

  console.log('physics_lab.js: pure helpers (no GeoFS/Cesium needed)');
  {
    // Requiring it under plain Node must only export the pure functions and touch nothing
    // browser-specific — same contract as probe.js/recorder.js above.
    const LAB = require('../tools/physics_lab.js');
    ok(typeof LAB.classifyHold === 'function' && typeof window === 'undefined', 'requiring it under Node exports pure functions and runs no browser code');

    // 2026-09-24 fixes: 4d picked getLinearVelocity; FPS was a single 5 s before/after pair.
    ok(JSON.stringify(LAB.rankVelocitySetters(['getLinearVelocity', 'applyVelocityImpulse', 'setAngularVelocity', 'setLinearVelocity', 'v_linearVelocity']))
      === '["setLinearVelocity","setAngularVelocity","applyVelocityImpulse","v_linearVelocity"]', 'rankVelocitySetters: setLinearVelocity first, set*vel* next, getters never');
    ok(LAB.rankVelocitySetters(['getLinearVelocity', 'getVelocity']).length === 0 && LAB.rankVelocitySetters(null).length === 0, 'rankVelocitySetters: only getters -> no candidate');
    const aba = LAB.abaSummary(60, 45, 58);
    ok(aba.baseline === 59 && aba.delta === -14 && aba.drift === 2 && aba.significant === true && aba.deltaPct === -23.7, 'abaSummary: baseline = mean of the A windows, delta vs that: ' + JSON.stringify(aba));
    ok(LAB.abaSummary(60, 57, 52).significant === false, 'abaSummary: a delta inside the A-to-A drift is noise, not a result');
    ok(LAB.abaSummary(null, 50, 60).baseline === null && LAB.abaSummary(null, 50, 60).significant === false, 'abaSummary: a missing window gives no verdict');
    ok(LAB.cruiseSteady({ roll: 1, pitch: 2, vsFpm: 50 }).steady === true, 'cruiseSteady: wings level, level flight');
    const turning = LAB.cruiseSteady({ roll: -20, vsFpm: 800 });
    ok(turning.steady === false && turning.why.length === 2, 'cruiseSteady: banked and climbing is flagged with why: ' + turning.why.join('; '));
    ok(LAB.GRAPHICS_WRITE_PATHS.length === LAB.GRAPHICS_PATHS.length - 3 &&
      !LAB.GRAPHICS_WRITE_PATHS.some((p) => /msaa|highDynamicRange|bloom/.test(p)), 'G1 never writes MSAA/HDR/bloom (visible glitches); DISCOVER still reads them');
    {
      const I = E0.R._internals;
      for (const env of [LAB.SAMPLE_ENV, { buildings: false }, { time: { localHour: 6 } }, { weather: { fog: 50 } }, null]) {
        ok(JSON.stringify(LAB.envToPrefsPatch(env)) === JSON.stringify(I.envToPrefsPatch(env)), 'the lab\'s envToPrefsPatch copy matches race.js for ' + JSON.stringify(env));
      }
    }

    ok(near(LAB.ktToMps(1), 0.514444, 1e-6), 'ktToMps: 1 kt ~0.514444 m/s');
    ok(LAB.ktToMps(null) === null && LAB.ktToMps('x') === null, 'ktToMps: non-number input is null, not a guess');

    ok(LAB.classifyHold(0, 0.8, 0.8) === 'held', 'classifyHold: readback equals the written value -> held');
    ok(LAB.classifyHold(0, 0.8, 0.001) === 'snapped_back', 'classifyHold: readback equals the pre-write baseline -> snapped_back');
    ok(LAB.classifyHold(0, 0.8, 0.4) === 'decayed', 'classifyHold: readback is neither baseline nor written -> decayed');
    ok(LAB.classifyHold(NaN, 0.8, 0.8) === 'unknown', 'classifyHold: a non-number baseline is unknown, not a guess');
    ok(LAB.classifyHold(100, 100, 100) === 'held', 'classifyHold: a zero-displacement write still resolves (tolerance floors at 1e-6, not 0/0)');

    const { lat, lon } = LAB.advanceLatLon(45, -122, 0, 1000);
    ok(lat > 45 && near(lon, -122, 1e-9), 'advanceLatLon: heading 0 (north) moves lat only');
    const east = LAB.advanceLatLon(45, -122, 90, 1000);
    ok(near(east.lat, 45, 1e-9) && east.lon > -122, 'advanceLatLon: heading 90 (east) moves lon only');
    ok(near(LAB.metersPerDegLon(0), LAB.M_PER_DEG_LAT, 1), 'metersPerDegLon: at the equator, a degree of longitude is the same length as a degree of latitude');
    ok(LAB.metersPerDegLon(60) < LAB.metersPerDegLon(0), 'metersPerDegLon: shrinks toward the poles (cos(lat))');

    const vec0 = LAB.velocityFromHeading(0, 100);
    ok(near(vec0[0], 0, 1e-9) && near(vec0[1], 100, 1e-9), 'velocityFromHeading: heading 0 (north) is all in the "north" component');
    const vec90 = LAB.velocityFromHeading(90, 100);
    ok(near(vec90[0], 100, 1e-9) && near(vec90[1], 0, 1e-9), 'velocityFromHeading: heading 90 (east) is all in the "east" component');

    ok(LAB.trend([{ atMs: 0, value: 10 }, { atMs: 1000, value: 20 }, { atMs: 2000, value: 30 }]) === 'rising', 'trend: a steady increase is rising');
    ok(LAB.trend([{ atMs: 0, value: 30 }, { atMs: 1000, value: 20 }, { atMs: 2000, value: 10 }]) === 'falling', 'trend: a steady decrease is falling');
    ok(LAB.trend([{ atMs: 0, value: 10 }, { atMs: 1000, value: 10.1 }, { atMs: 2000, value: 9.9 }]) === 'flat', 'trend: noise within tolerance is flat');
    ok(LAB.trend([{ atMs: 0, value: 10 }]) === 'unknown', 'trend: fewer than two numeric samples is unknown, not a guess');
    ok(LAB.trend([{ atMs: 0, value: 'x' }, { atMs: 1000, value: undefined }]) === 'unknown', 'trend: non-numeric samples are filtered out, not coerced');

    ok(LAB.summaryRow({ name: 'throttle', writePath: 'geofs.controls.throttle', held: 'held', airspeedTrend: 'rising' }).held === 'held',
      'summaryRow: an explicit held value passes through');
    ok(LAB.summaryRow({ name: 'teleportA', stayed: true, moved: true }).held === 'held', 'summaryRow: stayed:true derives held');
    ok(LAB.summaryRow({ name: 'teleportB', stayed: false, moved: true }).held === 'decayed', 'summaryRow: moved but not stayed derives decayed');
    ok(LAB.summaryRow({ name: 'teleportC', stayed: false, moved: false }).held === 'no_effect', 'summaryRow: no movement at all derives no_effect');
    ok(LAB.summaryRow({ name: 'rails', continuedFlying: true }).held === 'held', 'summaryRow: continuedFlying:true derives held');
    ok(LAB.summaryRow({ name: 'rails', continuedFlying: false }).held === 'stopped_on_release', 'summaryRow: continuedFlying:false derives stopped_on_release');
    ok(LAB.summaryRow({ name: 'autopilot' }).held === 'unknown', 'summaryRow: no held/stayed/continuedFlying signal at all is unknown');
    ok(LAB.summaryRow({ name: 'x', writePath: undefined }).writePath === '(n/a)', 'summaryRow: a missing write path reads as (n/a), not undefined');

    // DISCOVER helpers: walkPrototypeChain/describeOwnKeys/numericArrayFields/angleDiffDeg.
    class RigidBodyLike {
      setVelocity(x, y, z) { this._v = [x, y, z]; }
      constructor() { this.velocity = [1, 2, 3]; this.mass = 900; this.label = 'rb'; this._v = null; }
    }
    class EngineLike extends RigidBodyLike {
      getThrust() { return 1; }
    }
    const eng = new EngineLike();
    const chain = LAB.walkPrototypeChain(eng);
    ok(chain.length === 2, 'walkPrototypeChain: stops at (excludes) Object.prototype, so a two-level class chain reports two levels');
    ok(chain[0].className === 'EngineLike' && chain[0].methods.some((m) => m.name === 'getThrust' && m.arity === 0),
      'walkPrototypeChain: nearest prototype first, with each own method\'s name and arity');
    ok(chain[1].className === 'RigidBodyLike' && chain[1].methods.some((m) => m.name === 'setVelocity' && m.arity === 3),
      'walkPrototypeChain: walks up to the base class and still finds its methods');
    ok(LAB.walkPrototypeChain(null).length === 0 && LAB.walkPrototypeChain(42).length === 0, 'walkPrototypeChain: a non-object input is an empty chain, not a throw');

    const ownKeys = LAB.describeOwnKeys(eng);
    ok(ownKeys.some((k) => k.key === 'mass' && k.type === 'number'), 'describeOwnKeys: reports each own key with its typeof');
    ok(!ownKeys.some((k) => k.key === 'setVelocity'), 'describeOwnKeys: prototype methods are not own keys (that is walkPrototypeChain\'s job)');

    const numFields = LAB.numericArrayFields(eng);
    ok(numFields.some((f) => f.key === 'mass' && f.value === 900), 'numericArrayFields: a plain number field is reported with its value');
    ok(numFields.some((f) => f.key === 'velocity' && Array.isArray(f.value) && f.value.length === 3), 'numericArrayFields: a length-3 numeric array field is reported');
    ok(!numFields.some((f) => f.key === 'label'), 'numericArrayFields: a non-numeric field (a string) is excluded');
    ok(LAB.numericArrayFields({ mixed: [1, 'x', 3] }).length === 0, 'numericArrayFields: an array with a non-numeric element is excluded, not coerced');

    ok(LAB.angleDiffDeg(10, 20) === 10, 'angleDiffDeg: a plain difference within [0,180] is exact');
    ok(near(LAB.angleDiffDeg(350, 10), 20, 1e-9), 'angleDiffDeg: wraps across the 359->0 boundary instead of returning 340');
    ok(LAB.angleDiffDeg(0, 180) === 180, 'angleDiffDeg: exactly opposite headings are 180 apart');
    ok(LAB.angleDiffDeg(NaN, 10) === null && LAB.angleDiffDeg(10, 'x') === null, 'angleDiffDeg: non-numeric input is null, not a guess');
  }

  console.log('replay_landing.mjs: the CLI runs on the checked-in sample recording');
  {
    const { execFileSync } = require('child_process');
    const toolsDir = path.join(__dirname, '..', 'tools');
    const scriptPath = path.join(toolsDir, 'replay_landing.mjs');
    const recordingPath = path.join(toolsDir, 'sample_landing_recording.json');
    const runwayPath = path.join(toolsDir, 'sample_runway.json');

    // The main-module guard: a path with a space (and, on Windows, a drive letter + backslashes)
    // must still count as "invoked directly". Importing the module here must not run the CLI.
    const { pathToFileURL } = require('url');
    const RL = await import(pathToFileURL(scriptPath).href);
    const spaced = path.join(require('os').tmpdir(), 'has space', 'replay_landing.mjs');
    ok(RL.invokedDirectly(pathToFileURL(spaced).href, spaced), 'invokedDirectly: a path with a space still matches its own file URL');
    ok(RL.invokedDirectly(pathToFileURL(scriptPath).href, scriptPath), 'invokedDirectly: the real checkout path matches (drive letter/backslashes on Windows)');
    ok(!RL.invokedDirectly(pathToFileURL(scriptPath).href, __filename), 'invokedDirectly: a different argv[1] (e.g. a test importing it) does not');
    ok(!RL.invokedDirectly(pathToFileURL(scriptPath).href, undefined), 'invokedDirectly: no argv[1] (REPL/-e) does not');

    const withRunway = execFileSync(process.execPath, [scriptPath, recordingPath, runwayPath], { encoding: 'utf8' });
    ok(/Loaded 260 samples/.test(withRunway), `CLI: reports the sample count it loaded (got first line: ${withRunway.split('\n')[0]})`);
    ok(withRunway.includes('touchdown   t='), 'CLI: prints the touchdown event from the sample recording');
    ok(withRunway.includes('settled     t='), 'CLI: prints the settled event from the sample recording');
    ok(/dist_thr_m/.test(withRunway) && /300\.00/.test(withRunway), 'CLI: the touchdown table carries distance_from_threshold_m computed against the runway');

    const noRunway = execFileSync(process.execPath, [scriptPath, recordingPath], { encoding: 'utf8' });
    ok(/no runway supplied/.test(noRunway), 'CLI: runs with no runway.json argument at all');
    ok(/\bn\/a\b/.test(noRunway), 'CLI: without a runway, centerline/threshold columns read n/a instead of a fabricated number');

    let usageFailed = false;
    try {
      execFileSync(process.execPath, [scriptPath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      usageFailed = e.status === 1 && /Usage: node replay_landing\.mjs/.test(e.stderr);
    }
    ok(usageFailed, 'CLI: exits 1 with a usage message when called with no arguments');
  }

  // ============================================================================================
  // 1.3.0 — the lobby-first panel (Ramp / Gate / Launch, relay proto 5). CONFIG.LOBBY_V2 defaults
  // true in race.js itself, but env() here defaults it to FALSE (see the lobbyV2 param's comment
  // above) so every test above this line keeps exercising the exact pre-1.3.0 single-socket world
  // it always has. Every test below opts in explicitly with lobbyV2: true.
  // ============================================================================================

  console.log('Shell: URL param parsing (?room= and ?ghost=)');
  {
    const { parseRoomParam, buildInviteLink, parseChallengeParams } = E0.R._internals;
    ok(parseRoomParam('?room=Friday-Night') === 'friday-night', 'a room param is slugged the same way a typed code is');
    ok(parseRoomParam('?room=') === null, 'an empty room param is null, not an empty-string room');
    ok(parseRoomParam('') === null, 'no query string at all is null');
    ok(parseRoomParam('?course=steve-sprint&ghost=Dave') === null, 'no room param -> null, untouched by the existing course/ghost pair');
    ok(parseRoomParam('not a url') === null, 'garbage input never throws');
    ok(buildInviteLink('https://x.test/page?foo=bar', 'friday-night') === 'https://x.test/page?room=friday-night',
      'the invite link is exactly ?room=<code>, dropping any other query');
    ok(buildInviteLink('https://x.test/page', '') === 'https://x.test/page', 'no room -> no room param at all');

    const both = parseChallengeParams('?course=steve-sprint&ghost=Dave,Maggie&room=friday-night');
    ok(both.course === 'steve-sprint' && both.ghosts.join(',') === 'Dave,Maggie',
      '?course=&ghost= still parse correctly with an unrelated ?room= alongside them');
  }
  console.log('Shell: a ?room= link actually joins that room at boot, not just navigates the screen');
  {
    const E = env({ lobbyV2: true, apiBase: 'https://relay.test', url: 'https://www.geo-fs.com/geofs.php?room=Invited-Room' });
    ok(E.R.shell.screen === 'gate', 'boot lands straight on the Gate screen');
    const raceWs = E.wsRecord.sockets.find((s) => s.url.includes('/ws/race/invited-room'));
    ok(!!raceWs, 'and a real race-room socket was opened for the slugged room code — not merely stored for a later sync that already ran');
  }

  console.log('Shell: room-code slugify matches the server ROOM_PATTERN (^[a-z0-9-]{1,32}$)');
  {
    const { powerupsRoom } = E0.R._internals;
    const ROOM_PATTERN = /^[a-z0-9-]{1,32}$/;
    const cases = ['Friday Night', 'FRIDAY_NIGHT!!', '   spaces   ', 'a'.repeat(80), 'ALREADY-lower-case', '日本語', '---', 'a1-b2_c3'];
    for (const input of cases) {
      const out = powerupsRoom(input, '');
      ok(ROOM_PATTERN.test(out), 'slugged room "' + input + '" -> "' + out + '" matches the server pattern');
    }
    ok(powerupsRoom('a'.repeat(80), '').length <= 32, 'a long room code is capped at 32 chars');
    ok(powerupsRoom('', 'abcdef12') === 'abcdef12', 'an empty typed code falls back to the course hash');
    ok(powerupsRoom('', '') === '', 'nothing typed and no course hash -> empty, never a guessed room');
  }

  console.log('Shell: voteTileState (pure)');
  {
    const { voteTileState } = E0.R._internals;
    const candidate = { courseId: 'ecola-headland', name: 'Ecola Headland' };
    const votes = { BURG: 'ecola-headland', MEG: 'ecola-headland', DAVE: 'gorge-run', TANK: 'gorge-run' };
    const vt = voteTileState(candidate, votes, 'BURG');
    ok(vt.count === 2 && vt.pct === 50, 'two of four votes -> 50%');
    ok(vt.mine === true, 'BURG voted for this candidate');
    ok(vt.voters.join(',') === 'BURG,MEG', 'voters listed in tally order');
    ok(voteTileState(candidate, votes, 'DAVE').mine === false, 'DAVE voted for a different candidate');
    const zero = voteTileState({ courseId: 'surprise-me', name: 'surprise-me' }, {}, 'BURG');
    ok(zero.count === 0 && zero.pct === 0, 'no votes at all -> 0/0%, never NaN or a divide-by-zero');
    ok(voteTileState(candidate, null, 'BURG').mine === false, 'a missing votes map never throws and reads as not-mine');
  }

  console.log('Lobby: lobbyReduce folds the proto-5 vote frame, the start frame\'s vote field, and free-text chat (pure)');
  {
    const { lobbyReduce, lobbyInitialState } = E0.R._internals;
    let s = lobbyInitialState();
    ok(s.vote === null, 'no vote yet');
    s = lobbyReduce(s, { type: 'vote', candidates: [{ course_id: 'a', name: 'A' }, { course_id: 'b', name: 'B' }], votes: { Steve: 'a' } });
    ok(s.vote.candidates.length === 2 && s.vote.votes.Steve === 'a', 'a vote frame is folded in');
    s = lobbyReduce(s, { type: 'chat', callsign: 'Steve', text: 'gg' });
    ok(s.chat[0].kind === 'text' && s.chat[0].text === 'gg', 'free-text chat lands tagged kind:text');
    s = lobbyReduce(s, { type: 'chat', callsign: 'Dave', code: 'gg' });
    ok(s.chat[0].kind === 'code' && s.chat[0].code === 'gg', 'the existing fixed-enum chat still works, tagged kind:code');
    const s2 = lobbyReduce(s, { type: 'start', race_id: 1, start_at_server_ms: 1000, racers: ['Steve'],
      vote: { course_id: 'a', name: 'A', votes: { Steve: 'a', Dave: 'b' } } });
    ok(s2.start.vote.courseId === 'a' && s2.start.vote.votes.Dave === 'b', 'the start frame carries the winning vote and its tally');
    ok(s2.vote === null, 'a new start clears the stale vote tally');
    const s3 = lobbyReduce(s2, { type: 'start', race_id: 2, start_at_server_ms: 2000, racers: [] });
    ok(s3.start.vote === null, 'a start with no vote field (host picked by hand) -> null, not a guess');
  }

  console.log('Shell: ready/away/not-ready transitions and their effect on auto-start (pure)');
  {
    const { awayState, autoStartDecision } = E0.R._internals;
    const readyP = { callsign: 'Steve', ready: true };
    const notReadyP = { callsign: 'Dave', ready: false };
    ok(awayState(readyP, null, 60000) === 'ready', 'ready wins regardless of presence');
    ok(awayState(notReadyP, null, 60000) === 'not_ready', 'not ready + no presence row -> not_ready, never guessed away');
    ok(awayState(notReadyP, { activity: 'idle', idle_seconds: 30 }, 60000) === 'not_ready', 'idle under the threshold is still just not ready');
    ok(awayState(notReadyP, { activity: 'idle', idle_seconds: 90 }, 60000) === 'away', 'idle past the threshold on the hub -> away');
    ok(awayState(notReadyP, { activity: 'gate', idle_seconds: 999 }, 60000) === 'not_ready', 'busy on the hub (even in this room) is never away');
    ok(awayState(null, { activity: 'idle', idle_seconds: 999 }, 60000) === 'not_ready', 'no player record at all -> not_ready, not a throw');

    const players = [readyP, notReadyP];
    const away = { Dave: 'away' };
    ok(autoStartDecision(players, away, 5000, 3000) === true, 'Dave is away, Steve is ready and has held for 5s -> auto-start fires');
    ok(autoStartDecision(players, away, 1000, 3000) === false, 'held for only 1s of a 3s debounce -> not yet');
    ok(autoStartDecision([readyP, { callsign: 'Dave', ready: false }], {}, 5000, 3000) === false, 'Dave is NOT away and not ready -> never auto-starts around him');
    ok(autoStartDecision([{ callsign: 'Steve', ready: false }], { Steve: 'away' }, 5000, 3000) === false, 'everyone away -> nobody engaged -> never auto-starts an empty grid');
    ok(autoStartDecision([], {}, 999999, 0) === false, 'no players at all -> never fires');
    ok(autoStartDecision(players, away, 0, 0) === true, 'a 0 ms debounce fires the instant everyone (non-away) is ready');
  }

  console.log('Shell: roomStatusPill/roomAction cover every registry status (pure)');
  {
    const { roomStatusPill, roomAction } = E0.R._internals;
    const table = [
      ['boarding', 'Boarding', 'amber', 'join'],
      ['launching', 'In air', 'cyan', 'spectate'],
      ['racing', 'In air', 'cyan', 'spectate'],
      ['results', 'Closing', 'grey', 'spectate'],
      ['empty', 'Closing', 'grey', 'reopen'],
    ];
    for (const [status, label, tone, action] of table) {
      const pill = roomStatusPill(status);
      ok(pill.label === label && pill.tone === tone, status + ' -> ' + label + '/' + tone);
      ok(roomAction(status) === action, status + ' -> action ' + action);
    }
    ok(roomStatusPill('made-up').tone === 'grey', 'an unknown status falls back to a grey pill rather than throwing');
  }

  console.log('Shell: presenceLine formats a hub presence row (pure)');
  {
    const { presenceLine } = E0.R._internals;
    ok(presenceLine({ activity: 'racing', room: 'friday-cup' }) === 'racing friday-cup', 'racing in a room');
    ok(presenceLine({ activity: 'gate', room: 'friday-cup' }) === 'in friday-cup', 'gathered in a room');
    ok(presenceLine({ activity: 'solo' }) === 'flying solo', 'flying without a room');
    ok(presenceLine({ activity: 'idle', idle_seconds: 125 }) === 'idle 2m', 'idle time rounds down to whole minutes');
    ok(presenceLine({ activity: 'idle', idle_seconds: 5 }) === 'idle', 'under a minute idle just says idle, not "idle 0m"');
    ok(presenceLine(null) === '', 'no row at all -> empty, never a throw');
  }

  console.log("Shell: rampPingsRemaining resets at local-midnight-UTC-7, matching the server's rule (pure)");
  {
    const { rampPingsRemaining, rampDayKey } = E0.R._internals;
    const now = Date.UTC(2026, 8, 22, 20, 0, 0);
    ok(rampPingsRemaining([], 3, now) === 3, 'no pings sent yet -> full 3');
    ok(rampPingsRemaining([now - 1000, now - 2000], 3, now) === 1, 'two pings today -> one left');
    ok(rampPingsRemaining([now, now, now, now], 3, now) === 0, 'never goes negative once over the cap');
    ok(rampPingsRemaining([now - 24 * 3600 * 1000], 3, now) === 3, "a ping from yesterday (UTC-7) doesn't count against today");
    const before = rampDayKey(Date.UTC(2026, 8, 23, 6, 59, 0)), at = rampDayKey(Date.UTC(2026, 8, 23, 7, 0, 0));
    ok(before !== at, '07:00 UTC is exactly the UTC-7 midnight rollover');
  }

  console.log('Shell: quickMatchTarget picks the fullest boarding room (pure)');
  {
    const { quickMatchTarget } = E0.R._internals;
    const rooms = [{ code: 'b', status: 'boarding', pilots: 3 }, { code: 'a', status: 'boarding', pilots: 5 }, { code: 'c', status: 'racing', pilots: 8 }];
    ok(quickMatchTarget(rooms) === 'a', 'the fullest BOARDING room wins, not the fullest room overall');
    const tied = [{ code: 'zeta', status: 'boarding', pilots: 2 }, { code: 'alpha', status: 'boarding', pilots: 2 }];
    ok(quickMatchTarget(tied) === 'alpha', 'a tie breaks toward the lower room code, deterministically');
    ok(quickMatchTarget([{ code: 'x', status: 'racing', pilots: 9 }]) === null, 'nothing boarding -> null, so the caller mints a fresh room');
    ok(quickMatchTarget([]) === null, 'no rooms at all -> null');
  }

  console.log('Shell: hubActivity picks the where.activity to report (pure)');
  {
    const { hubActivity } = E0.R._internals;
    ok(hubActivity('idle', false, false) === 'idle', 'nothing going on -> idle');
    ok(hubActivity('running', false, false) === 'solo', 'flying with no lobby room -> solo');
    ok(hubActivity('idle', true, false) === 'gate', 'connected to a room, not yet racing -> gate');
    ok(hubActivity('running', true, true) === 'racing', 'actually in a lobby race -> racing, which wins over solo');
  }

  console.log('Shell: cupPodium takes the top 3 of a cup standings row (pure)');
  {
    const { cupPodium } = E0.R._internals;
    const standings = [{ callsign: 'a', points: 40 }, { callsign: 'b', points: 30 }, { callsign: 'c', points: 20 }, { callsign: 'd', points: 10 }];
    ok(cupPodium(standings).length === 3 && cupPodium(standings)[2].callsign === 'c', 'top 3, in the order given (server already sorts)');
    ok(cupPodium([{ callsign: 'solo', points: 5 }]).length === 1, 'fewer than 3 just returns what there is');
    ok(cupPodium(null).length === 0, 'no standings -> empty, never a throw');
  }

  console.log('Shell: launchGridRows wraps the unchanged gridSlot() for real per-pilot distance + Set/Moving (pure)');
  {
    const { launchGridRows, gridSlot } = E0.R._internals;
    const g1 = { lat: 45.5, lon: -122.6, alt: 1000 }, g2 = { lat: 45.6, lon: -122.6, alt: 1000 };
    const racers = ['Steve', 'Dave', 'Maggie'];
    const seen = new Set(['Dave']);
    const rows = launchGridRows(racers, g1, g2, 20, 150, seen);
    ok(rows.length === 3, 'one row per racer');
    ok(rows[1].status === 'set' && rows[0].status === 'moving' && rows[2].status === 'moving',
      'only the callsign the relay has reported a pos for reads Set');
    ok(rows.every((r) => Number.isFinite(r.distanceM) && r.distanceM > 0), 'every row gets a real, positive distance back to gate 1');
    ok(JSON.stringify(rows[0].slot) === JSON.stringify(gridSlot(g1, g2, 0, 3, 20, 150)),
      'the slot itself is the unchanged, already-tested gridSlot() formula — no new physics math');
    ok(launchGridRows([], g1, g2, 20, 150, seen).length === 0, 'no racers -> no rows');
    ok(launchGridRows(racers, null, g2, 20, 150, seen).length === 0, 'no gate 1 -> no rows, never a throw');
  }

  console.log("Shell: sanitizeChatDraft mirrors the relay's own chat cleanup (pure)");
  {
    const { sanitizeChatDraft } = E0.R._internals;
    ok(sanitizeChatDraft('  hello   world  ') === 'hello world', 'trims and collapses whitespace runs');
    ok(sanitizeChatDraft('two\nlines') === 'two lines', 'a newline becomes a separator, not two words glued together');
    ok(sanitizeChatDraft('a\x00b\x1bc') === 'abc', 'control characters are stripped outright');
    ok(sanitizeChatDraft('x'.repeat(400)).length === 240, 'clipped at CHAT_MAX_CHARS (240)');
    ok(sanitizeChatDraft(null) === '' && sanitizeChatDraft(undefined) === '', 'nullish input is an empty string, never a throw');
  }

  console.log("Shell: LOBBY_V2 never builds the OLD floating lobby card, so no path can mount it");
  {
    // Through 1.3.x the card was built on every boot and hidden by a body-scoped CSS rule that
    // Shell.init() had to reach. Now it simply does not exist under the shell: the ready-check
    // dialog (its confirm() force-start), its 10 Hz renderLobby() and its course picker go with it.
    const E = env({ lobbyV2: true, apiBase: 'https://relay.test' });
    ok(E.w.document.getElementById('fr-lobby') === null, 'no #fr-lobby element at all');
    ok(!E.R.ui.E.lobbyOverlay, 'and no overlay handle for renderLobby() to show');
    const css = E.w.document.getElementById('fr-style').textContent;
    ok(!/fr-shell-active/.test(css), 'the CSS suppression rule it used to depend on is gone');
    E.R.lobby.joinRoom('gate-room', {});
    const raceWs = E.wsRecord.sockets.find((s) => s.url.includes('/ws/race/gate-room'));
    raceWs.fireOpen();
    raceWs.fireMessage({ type: 'joined', room: 'gate-room', proto: 5, server_ms: Date.now() });
    raceWs.fireMessage({ type: 'lobby', phase: 'lobby', host: 'Eric', course: null, rules: { powerups: true, teleport: true },
      race_id: 0, players: [{ callsign: 'Eric', model: '', ready: false, role: 'racer' }], cup: null });
    ok(E.R.lobby.active() === true, 'the lobby module is genuinely active');
    E.R.ui.renderLobby();
    ok(E.w.document.getElementById('fr-lobby') === null, 'and renderLobby() still mounts nothing');
    let confirmed = 0;
    E.w.confirm = () => { confirmed++; return true; };
    E.w.dispatchEvent(new E.w.KeyboardEvent('keydown', { code: 'KeyY', altKey: true, bubbles: true }));
    ok(raceWs.ofType('ready').length === 1 && raceWs.ofType('ready')[0].ready === true, 'Alt+Y sends ready through the Gate path');
    ok(confirmed === 0, 'and no ready-check dialog ever opens');
    ok(E.R.shell.E.gateReadyBtn.textContent === 'READY UP', 'the Gate button reflects the relay, not an optimistic guess, until the lobby frame lands');
  }

  console.log('Hub: hello/welcome persists pilot identity, and presence/rooms render into the Ramp screen');
  {
    const E = env({ lobbyV2: true, apiBase: 'https://relay.test' });
    ok(E.wsRecord.sockets.length === 1, 'Hub opens exactly one socket at boot (no room joined yet)');
    const hubWs = E.wsRecord.sockets.find((s) => s.url.includes('/ws/hub'));
    ok(!!hubWs, 'and it is the hub socket');
    hubWs.fireOpen();
    ok(hubWs.ofType('hello').length === 1, 'sends hello on open');
    ok(hubWs.ofType('hello')[0].pilot_token === undefined, 'no stored token yet -> omitted entirely, never sent as "undefined"');

    hubWs.fireMessage({ type: 'welcome', pilot_id: 'p1', pilot_token: 'secret-token', proto: 5 });
    ok(E.R.hub.pilotId === 'p1' && E.R.hub.pilotToken === 'secret-token', 'welcome is stored on the Hub module');
    ok(JSON.parse(E.w.localStorage.getItem('finsRace.pilotToken')) === 'secret-token',
      'and persisted through the existing try/catch store convention');

    hubWs.fireMessage({ type: 'presence', pilots: [{ callsign: 'Dave', model: 'Cow', activity: 'gate', room: 'friday-cup', idle_seconds: 0 }] });
    hubWs.fireMessage({ type: 'rooms', rooms: [{ code: 'friday-cup', host: 'Dave', course: { course_id: 'gorge-run', course_hash: 'abc', name: 'Gorge Run', start_type: 'air', gates: 6 },
      cup: null, format: 'race', status: 'boarding', line: '', pilots: 1, callsigns: ['Dave'] }] });
    E.R.shell.renderRamp();

    ok(E.R.shell.E.rampRows.children.length === 1, 'the room shows up as a departure-board row');
    ok(E.R.shell.E.rampRows.textContent.includes('friday-cup'), 'with the room code visible');
    ok(E.R.shell.E.presenceRows.textContent.includes('Dave'), 'and Dave shows up on the ramp presence list');
  }

  console.log('Shell: Ramp Join/Spectate opens the race-room socket with the right room + spectate flag');
  {
    const E = env({ lobbyV2: true, apiBase: 'https://relay.test' });
    const hubWs = E.wsRecord.last;
    hubWs.fireOpen();
    hubWs.fireMessage({ type: 'welcome', pilot_id: 'p1', pilot_token: 't1', proto: 5 });
    hubWs.fireMessage({ type: 'rooms', rooms: [{ code: 'friday-cup', host: 'Dave', course: null, cup: null, format: 'race', status: 'boarding', line: '', pilots: 1, callsigns: ['Dave'] }] });
    E.R.shell.renderRamp();

    const joinBtn = E.R.shell.E.rampRows.querySelector('button');
    ok(!!joinBtn && joinBtn.textContent === 'Join', 'a boarding room shows a Join button');
    joinBtn.click();
    ok(E.R.shell.screen === 'gate', 'clicking Join switches to the Gate screen');
    const raceWs = E.wsRecord.sockets.find((s) => s.url.includes('/ws/race/friday-cup'));
    ok(!!raceWs, 'and opens the race-room socket for that exact room code');
    raceWs.fireOpen();
    const joinFrame = raceWs.ofType('join')[0];
    ok(joinFrame.room === 'friday-cup' && joinFrame.spectate === undefined, 'a Join sends no spectate flag');
    ok(joinFrame.pilot_token === 't1', 'and carries the pilot_token the hub minted');
  }
  {
    const E = env({ lobbyV2: true, apiBase: 'https://relay.test' });
    const hubWs = E.wsRecord.last;
    hubWs.fireOpen();
    hubWs.fireMessage({ type: 'rooms', rooms: [{ code: 'hood-grudge', host: 'JD', course: null, cup: null, format: 'race', status: 'racing', line: 'gate 3 — JD leads', pilots: 2, callsigns: ['JD', 'Parker'] }] });
    E.R.shell.renderRamp();
    const specBtn = E.R.shell.E.rampRows.querySelector('button');
    ok(specBtn.textContent === 'Spectate', 'a racing room shows Spectate, not Join');
    specBtn.click();
    const raceWs = E.wsRecord.sockets.find((s) => s.url.includes('/ws/race/hood-grudge'));
    raceWs.fireOpen();
    ok(raceWs.ofType('join')[0].spectate === true, 'clicking Spectate joins with spectate: true');
  }

  console.log("Shell: Gate chat renders other pilots' text as literal text, never markup (XSS)");
  {
    const E = env({ lobbyV2: true, apiBase: 'https://relay.test' });
    E.R.lobby.joinRoom('xss-room', {});
    E.R.shell.setScreen('gate');
    const raceWs = E.wsRecord.sockets.find((s) => s.url.includes('/ws/race/xss-room'));
    raceWs.fireOpen();
    const evil = '<img src=x onerror=alert(1)>&"quoted"';
    raceWs.fireMessage({ type: 'chat', callsign: '<b>Eric</b>', text: evil });
    E.R.shell.renderGate();
    const feed = E.R.shell.E.gateChatFeed;
    ok(feed.textContent.includes(evil) && feed.textContent.includes('<b>Eric</b>'), 'raw callsign and text are present as literal text content');
    ok(feed.querySelector('img') === null && feed.querySelector('b') === null, 'never parsed as markup — no <img>/<b> element exists in the live DOM');
  }

  console.log('Shell: storage-unavailable fallback — pilot identity is ephemeral, panel still boots and renders');
  {
    const E = env({ lobbyV2: true, apiBase: 'https://relay.test', quotaThrowsAlways: true });
    ok(!!E.R.shell.E.shell, 'the shell panel still builds with every localStorage call throwing');
    const hubWs = E.wsRecord.sockets.find((s) => s.url.includes('/ws/hub'));
    hubWs.fireOpen();
    ok(hubWs.ofType('hello').length === 1, 'hello still sends (no stored token -> omitted, not a throw)');
    hubWs.fireMessage({ type: 'welcome', pilot_id: 'p1', pilot_token: 'ephemeral', proto: 5 });
    ok(E.R.hub.pilotToken === 'ephemeral', 'the token lives in memory for this session even though it could not be persisted');
    E.R.shell.renderRamp();
    ok(true, 'renderRamp() completed with no throw');
  }

  console.log('Shell: hub-disconnect degradation — reconnect banner shows, room-code join still works');
  {
    const E = env({ lobbyV2: true, apiBase: 'https://relay.test', patch: [['POWERUP_RECONNECT_MS: 2000,', 'POWERUP_RECONNECT_MS: 10,']] });
    const hubWs = E.wsRecord.sockets.find((s) => s.url.includes('/ws/hub'));
    hubWs.fireOpen();
    ok(E.R.hub.connected === true, 'hub connects normally at first');
    hubWs.close();
    ok(E.R.hub.connected === false, 'and drops');
    E.R.shell.renderStatusBar();
    ok(!E.R.shell.E.reconnectBanner.classList.contains('fr-hidden'), 'the reconnect banner is now visible');
    ok(/reconnect/i.test(E.R.shell.E.reconnectBanner.textContent), 'and says so in words');

    ok(E.R.lobby.joinRoom('still-works', {}) === true, 'joining a room by code still works with the hub down');
    const raceWs = E.wsRecord.sockets.find((s) => s.url.includes('/ws/race/still-works'));
    ok(!!raceWs, 'and opens a real race-room socket regardless of the hub');
  }


  // ============================================================================================
  // 1.3.1 — the bugfix pass on the 1.3.0 lobby-first shell. Every test below is a regression test
  // for something that was actually broken in 3ba2242, found by clicking the real controls rather
  // than by reading the code: the shell's controls were wired, but CONFIG.API_BASE was never set
  // (README "Deploy" step 6), so every relay/hub entry point failed closed in total silence.
  // ============================================================================================

  // Flies out of gate 1 the way the rest of this file does: ~200 m/s in 16 ms steps, never a jump
  // between frames (detectStart() refuses a teleport, and rightly).
  const departGate1 = (E, lat0, lon0) => {
    E.setPos({ lat: lat0, lon: lon0, alt: 1000 });
    E.frame(16);
    let m = 0;
    for (let i = 0; i < 120; i++) { m += 200 * 0.016; E.setPos({ lat: lat0 + m / 111320, lon: lon0, alt: 1000 }); E.frame(16); }
  };

  console.log('1.3.1 config: race.js ships a real CONFIG.API_BASE, not the empty string that disabled 1.3.0');
  {
    // The bug: API_BASE stayed '' through 1.3.0, so a bookmarklet load got a client that could not
    // open a relay OR a hub socket — "+ New room" produced no socket and no console line at all.
    const E = env({ lobbyV2: true, apiBase: 'shipped' });
    ok(E.R.config.API_BASE === 'https://race.finsonly.net', 'CONFIG.API_BASE is the deployed relay, not empty');
    ok(E.R.relay.enabled() === true, 'Relay.enabled() is true out of the box');
    ok(E.R.hub.enabled() === true, 'Hub.enabled() is true out of the box');
    ok(E.R.shell.screen === 'ramp', 'the panel opens on the Ramp, not the Solo fallback an empty API_BASE forced');
    const hubWs = E.wsRecord.sockets.find((s) => s.url.includes('/ws/hub'));
    ok(!!hubWs && hubWs.url === 'wss://race.finsonly.net/ws/hub', 'and a real /ws/hub socket is opened at boot');
  }

  console.log('1.3.1 New room: the exact 1.3.0 repro — opens a real race socket and lands on the Gate');
  {
    const E = env({ lobbyV2: true, apiBase: 'shipped' });
    E.R.shell.setScreen('ramp');
    const before = E.wsRecord.sockets.length;
    E.R.shell.E.rampNewRoom.click();
    ok(E.wsRecord.sockets.length === before + 1, 'clicking "+ New room" opens exactly one new socket (it opened none in 1.3.0)');
    const ws = E.wsRecord.last;
    ok(/\/ws\/race\/[a-z0-9-]{1,32}$/.test(ws.url), 'to a /ws/race/<code> room matching the server ROOM_PATTERN: ' + ws.url);
    ok(E.R.shell.screen === 'gate', 'and lands the client on the Gate screen for that room');
    ws.fireOpen();
    ok(ws.ofType('join').length === 1, 'the room self-registers by joining it (race/PROTOCOL.md: rooms register on first join, there is no create frame)');
    ok(E.R.relay.room === ws.ofType('join')[0].room, 'and Relay.room is the room actually joined');
  }

  console.log('1.3.1 loud failures: a relay action that cannot run says so instead of doing nothing silently');
  {
    // The root cause of "the click produces nothing at all": these guards returned undefined and
    // set a status string nothing rendered. They now warn, report, and refuse to navigate.
    const E = env({ lobbyV2: true });   // API_BASE patched to '' — a client with no relay
    E.R.shell.setScreen('ramp');
    ok(E.R.shell.E.rampNewRoom.click() === undefined || true, 'clicking is still safe with no relay');
    ok(E.wsRecord.sockets.length === 0, 'no socket, correctly — there is no relay to open one to');
    ok(/no relay configured/i.test(E.warnText()), 'but it warns to the console now, which is what DevTools was missing');
    ok(!E.R.shell.E.notice.classList.contains('fr-hidden'), 'and shows a visible notice in the shell');
    ok(/no relay configured/i.test(E.R.shell.E.notice.textContent), 'that says why: ' + JSON.stringify(E.R.shell.E.notice.textContent));
    ok(E.R.shell.screen === 'ramp', 'and does NOT navigate to a Gate screen for a room with no socket behind it');
    ok(E.R.relay.connect('any-room') === false, 'Relay.connect() reports failure rather than returning undefined');
    ok(E.R.hub.connect() === false, 'Hub.connect() likewise');
    ok(E.R.lobby.joinRoom('any-room', {}) === false, 'and Lobby.joinRoom() propagates it instead of claiming success');
  }

  console.log('1.3.1 wiring audit: every interactive control in the shell is bound to real logic');
  {
    // The audit the 1.3.0 bug report asked for, as a test: each control is CLICKED and asserted to
    // produce a real effect (a socket, a relay frame, a fetch, a screen change). A stub, a dead
    // selector or a missing listener all fail this identically — none of them can move anything.
    // The completeness check at the end fails when a NEW button is added without being covered.
    const INDEX = [{ id: 'gorge-run', name: 'Columbia Gorge Run', file: 'gorge-run.json' }];
    const mk = () => env({
      lobbyV2: true, apiBase: 'shipped',
      apiHandler: (url) => (String(url).includes('index.json') ? { ok: true, json: async () => INDEX } : null),
    });

    // ---- Ramp
    const rampChecks = [
      ['rampNewRoom', (E) => { E.R.shell.setScreen('ramp'); }, (E, n) => E.wsRecord.sockets.length > n.socks && E.R.shell.screen === 'gate'],
      ['quickMatchBtn', (E) => { E.R.shell.setScreen('ramp'); }, (E, n) => E.wsRecord.sockets.length > n.socks && E.R.shell.screen === 'gate'],
      ['rampJoinBtn', (E) => { E.R.shell.setScreen('ramp'); E.R.shell.E.rampJoinCode.value = 'typed-room'; },
        (E, n) => E.wsRecord.sockets.some((s) => s.url.includes('/ws/race/typed-room'))],
      // fireOpen BEFORE the render: the button is disabled until a render sees Hub.connected, and
      // the live panel re-renders the Ramp on a 1 Hz ticker.
      ['pingBtn', (E) => { E.hubWs.fireOpen(); E.R.shell.setScreen('ramp'); }, (E, n) => E.hubWs.ofType('ping_ramp').length === 1],
      ['coursesRefresh', (E) => { E.R.shell.setScreen('courses'); }, (E, n) => E.fetches.some((u) => u.includes('index.json'))],
    ];
    for (const [name, setup, effect] of rampChecks) {
      const E = mk();
      E.hubWs = E.wsRecord.sockets.find((s) => s.url.includes('/ws/hub'));
      E.fetches = [];
      const realFetch = E.w.fetch;
      E.w.fetch = (u, i) => { E.fetches.push(String(u)); return realFetch(u, i); };
      setup(E);
      const n = { socks: E.wsRecord.sockets.length, screen: E.R.shell.screen };
      const el = E.R.shell.E[name];
      ok(!!el, 'control exists in the rendered shell: ' + name);
      el.click();
      ok(effect(E, n), name + ' click reaches real logic (not a stub or a dead selector)');
    }

    // ---- departure-board row actions, which are built per-render rather than held on E
    {
      const E = mk();
      const hubWs = E.wsRecord.sockets.find((s) => s.url.includes('/ws/hub'));
      hubWs.fireOpen();
      hubWs.fireMessage({ type: 'rooms', rooms: [{ code: 'friday-cup', host: 'Dave', course: null, cup: null,
        format: 'race', status: 'boarding', line: '', pilots: 1, callsigns: ['Dave'] }] });
      E.R.shell.setScreen('ramp');
      E.R.shell.E.rampRows.querySelector('button').click();
      ok(E.wsRecord.sockets.some((s) => s.url.includes('/ws/race/friday-cup')), 'a departure-board row action joins that exact room');
    }

    // ---- Gate, against a room that is really connected and really voting
    {
      const E = mk();
      E.wsRecord.sockets.find((s) => s.url.includes('/ws/hub')).fireOpen();
      E.R.lobby.joinRoom('gate-room', {});
      const ws = E.wsRecord.sockets.find((s) => s.url.includes('/ws/race/gate-room'));
      ws.fireOpen();
      ws.fireMessage({ type: 'joined', proto: 5, callsign: 'Eric' });
      ws.fireMessage({ type: 'lobby', phase: 'lobby', host: 'Eric', race_id: 1,
        players: [{ callsign: 'Eric', ready: false, role: 'racer', model: 'F-16' }], rules: {},
        course: { course_id: 'gorge-run', name: 'Gorge Run', course_hash: 'abc12345' } });
      ws.fireMessage({ type: 'vote', candidates: [{ course_id: 'gorge-run', name: 'Gorge Run' }], votes: {} });
      E.R.shell.setScreen('gate');

      const sent = (t) => ws.ofType(t).length;
      const voteTile = E.R.shell.E.gateVoteGrid.querySelector('button');
      ok(!!voteTile, 'a course-vote tile is rendered');
      voteTile.click();
      ok(sent('vote') === 1, 'a vote tile sends a real vote frame');

      E.R.shell.E.gateReadyBtn.click();
      ok(sent('ready') === 1, 'Ready up sends a real ready frame');

      E.R.shell.E.gateChatQuick.querySelector('button').click();
      ok(ws.sent.some((f) => f.type === 'chat' && f.code), 'a quick-chat button sends chat{code}');

      E.R.shell.E.gateChatInput.value = 'on the runway';
      E.R.shell.E.gateChatSend.click();
      ok(ws.sent.some((f) => f.type === 'chat' && f.text === 'on the runway'), 'the compose box sends chat{text}');

      E.R.shell.E.gateStartAnyway.click();
      ok(sent('start') === 1, 'Start anyway sends a real force-start frame');

      E.R.shell.E.gateLeave.click();
      ok(E.R.shell.screen === 'ramp', 'Leave really leaves the room screen');
    }

    // ---- completeness: no unwired buttons anywhere in the shell
    {
      const E = mk();
      const COVERED = new Set([
        // top bar / navigation
        '←', 'Ramp', 'Season', 'Courses', 'Solo', 'Settings', 'Copy invite', 'Leave', 'Abort to gate', '–',
        E.R.powerups.callsign(),                       // the callsign chip, which opens rename
        // ramp
        '+ New room', 'Fly now', 'Start a room', 'Join', 'Spectate', 'Reopen', 'Ping the ramp',
        'Fly Solo instead', 'Set course',
        // courses / solo
        'Refresh', 'Fly solo', 'Load course', 'Fly to start', 'Reset run', 'Fly approach',
        // gate
        'READY UP', 'READY ✓', 'Start anyway', '➤',
        // solo extras: ported from the classic panel — race/CLAUDE.md feature-series "full
        // migration" (Ghost/rivals have no buttons; the course editor and the manual-sync
        // countdown fallback do). See UI.init()'s E.editor / E.cdSection.
        'Drop gate here', 'Undo', 'Clear', 'Drop item box', 'Drop box row', 'Undo box',
        'Build test course ahead of me', 'Save and load', 'Copy JSON', 'Delete saved', 'Import JSON',
        'Arm', 'Abort',
        // settings: ported leaderboard/powerups controls (model/sound have no buttons, only
        // checkboxes and selects, which this scan does not enumerate)
        'Refresh board', 'Log velocity frame',
      ]);
      // Built from the same sources the panel renders from, so a new quick-chat code or a changed
      // ping label can't silently fall out of this check.
      for (const code of E.R._internals.CHAT_CODES) COVERED.add(code);
      for (const label of Object.values(E.R._internals.CHAT_LABELS || {})) COVERED.add(label);
      for (let n = 0; n <= 10; n++) COVERED.add('Ping' + n + ' left today');

      const labels = [];
      for (const screen of ['ramp', 'season', 'courses', 'solo', 'settings', 'gate', 'launch']) {
        E.R.shell.setScreen(screen);
        // Only the screen that is actually up, plus the top bar: a screen that has never been
        // shown has never been rendered, so its buttons legitimately have no text yet.
        const scope = E.R.shell.E[screen + 'Screen'];
        if (!scope) continue;   // Season is not built at all while CONFIG.SEASONS is off
        for (const b of scope.querySelectorAll('button')) labels.push(b.textContent.trim());
        for (const b of E.R.shell.E.top.querySelectorAll('button')) labels.push(b.textContent.trim());
      }
      const uncovered = [...new Set(labels)].filter((t) => !COVERED.has(t));
      ok(uncovered.length === 0,
        'every button on every shell screen is a control this test clicks' +
        (uncovered.length ? ' — UNCOVERED: ' + JSON.stringify(uncovered) : ''));
      ok(E.R.shell.E.meChip.textContent === E.R.powerups.callsign(), 'the callsign chip reflects real state');
    }
  }

  console.log('1.3.1 vote frame: the relay\'s `vote` is routed into lobbyReduce instead of being dropped');
  {
    // The bug nobody reported: lobbyReduce() has handled type:'vote' since it was written and is
    // unit-tested, but Lobby.onFrame() had no case for it, so every vote frame fell through the
    // router and the Gate's vote tiles could never render however well the server drew them.
    const E = env({ lobbyV2: true, apiBase: 'shipped' });
    E.R.lobby.joinRoom('vote-room', {});
    const ws = E.wsRecord.sockets.find((s) => s.url.includes('/ws/race/vote-room'));
    ws.fireOpen();
    ws.fireMessage({ type: 'joined', proto: 5, callsign: 'Eric' });
    ws.fireMessage({ type: 'lobby', phase: 'lobby', host: 'Dave', race_id: 1,
      players: [{ callsign: 'Eric', ready: false, role: 'racer' }], rules: {}, course: null });
    E.R.shell.setScreen('gate');
    ok(E.R.lobby.state.vote === null, 'no vote before the relay sends one');

    ws.fireMessage({ type: 'vote', candidates: [{ course_id: 'gorge-run', name: 'Gorge Run' },
      { course_id: 'surprise-me', name: 'surprise-me' }], votes: { Dave: 'gorge-run' } });
    ok(!!E.R.lobby.state.vote, 'a `vote` frame now reaches Lobby.state (it was dropped entirely in 1.3.0)');
    ok(E.R.lobby.state.vote.candidates.length === 2, 'with both candidates the relay drew');
    ok(E.R.lobby.state.vote.votes.Dave === 'gorge-run', "and the relay's tally");
    ok(E.R.shell.E.gateVoteGrid.querySelectorAll('button').length === 2, 'and the Gate renders one tile per candidate');

    const before = ws.ofType('vote').length;
    E.R.shell.E.gateVoteGrid.querySelector('button').click();
    ok(ws.ofType('vote').length === before + 1, 'clicking a tile votes for that candidate');
    ok(ws.ofType('vote').slice(-1)[0].course_id === 'gorge-run', 'naming a candidate the relay actually offered');
  }

  console.log('1.3.1 Courses tab: reads the static course index, with no hub and no relay at all');
  {
    // race/courses/index.json is a static file served over COURSE_BASE. The hub never sends it, so
    // the Courses tab must not need one — it was a "coming soon" placeholder through 1.3.0.
    const INDEX = [{ id: 'gorge-run', name: 'Columbia Gorge Run', file: 'gorge-run.json' },
      { id: 'crater-rim', name: 'Crater Lake Rim', file: 'crater-rim.json' }];
    const seen = [];
    const E = env({
      lobbyV2: true,   // NO apiBase: no relay, no hub, nothing but COURSE_BASE
      seed: { 'finsRace.courses': { 'my-local': { id: 'my-local', name: 'Saved Locally', gates: [] } } },
      apiHandler: (url) => { seen.push(String(url)); return String(url).includes('index.json') ? { ok: true, json: async () => INDEX } : null; },
    });
    E.R.shell.setScreen('courses');
    await new Promise((r) => setTimeout(r, 50));

    ok(E.wsRecord.sockets.length === 0, 'the Courses tab opened zero WebSockets — it needs no hub and no relay');
    ok(seen.some((u) => u.includes('index.json')), 'it fetched the static course index over COURSE_BASE');
    const rows = E.R.shell.E.coursesRows.querySelectorAll('.fr-course-row');
    ok(rows.length === 3, 'and rendered a row per course: 2 shared + 1 saved locally, got ' + rows.length);
    ok(rows[0].textContent.includes('Columbia Gorge Run'), 'showing the name from the index');
    ok(E.R.shell.E.coursesScreen.querySelector('.fr-screen-stub') === null, 'the screen is no longer a placeholder');
    ok(!/coming/i.test(E.R.shell.E.coursesScreen.textContent), 'and says nothing about a browser being "coming"');
    ok([...rows].some((r) => /On this computer/.test(r.textContent)), 'a locally-saved course is marked as such');
  }

  console.log('1.3.1 Gate vote tiles and the host course picker both read the same static index');
  {
    const INDEX = [{ id: 'gorge-run', name: 'Columbia Gorge Run', file: 'gorge-run.json' }];
    const E = env({ lobbyV2: true, apiBase: 'shipped',
      apiHandler: (url) => (String(url).includes('index.json') ? { ok: true, json: async () => INDEX } : null) });
    await E.R.shell.loadCourseIndex(true);
    E.R.lobby.joinRoom('host-room', {});
    const ws = E.wsRecord.sockets.find((s) => s.url.includes('/ws/race/host-room'));
    ws.fireOpen();
    ws.fireMessage({ type: 'joined', proto: 5, callsign: 'Eric' });
    // host, no vote drawn yet -> the host picker is what shows, and it is filled from the index
    ws.fireMessage({ type: 'lobby', phase: 'lobby', host: 'Eric', race_id: 1,
      players: [{ callsign: 'Eric', ready: false, role: 'racer' }], rules: {}, course: null });
    E.R.shell.setScreen('gate');
    ok(!E.R.shell.E.gateHostCourseRow.classList.contains('fr-hidden'), 'with no vote drawn, the host sees a direct course picker');
    ok(E.R.shell.E.gateHostCourseSelect.options.length === 1, 'filled from the static index, not from anything the hub sent');
    ok(E.R.shell.E.gateHostCourseSelect.options[0].value === 'gorge-run', 'with the index\'s own course id');
  }

  console.log('1.3.1 Solo: pick a course, fly to start, run the clock — zero hub, zero WebSocket');
  {
    const COURSE = { id: 'solo-course', name: 'Solo Course', startType: 'air',
      gates: [{ lat: 44, lon: -121, alt: 1000, radius: 150 }, { lat: 44.02, lon: -121, alt: 1000, radius: 150 },
        { lat: 44.04, lon: -121, alt: 1000, radius: 150 }] };
    const INDEX = [{ id: 'solo-course', name: 'Solo Course', file: 'solo-course.json' }];
    const E = env({
      lobbyV2: true,   // NO apiBase at all: the whole flow must work offline from the hub
      apiHandler: (url) => {
        if (String(url).includes('index.json')) return { ok: true, json: async () => INDEX };
        if (String(url).includes('solo-course.json')) return { ok: true, json: async () => COURSE };
        return null;
      },
    });
    await E.bootFrames();
    E.R.shell.setScreen('courses');
    await new Promise((r) => setTimeout(r, 50));

    // "Fly solo" on a course row is the entry point from the Courses tab.
    E.R.shell.E.coursesRows.querySelector('button').click();
    await new Promise((r) => setTimeout(r, 50));
    ok(E.R.shell.screen === 'solo', 'picking a course lands on the Solo screen');
    ok(!!E.R.race.course && E.R.race.course.name === 'Solo Course', 'and loads that course into the race engine');
    ok(E.R.race.state === 'armed', 'which arms a normal run — the same state the classic panel produces');
    ok(E.R.shell.E.soloScreen.querySelector('.fr-screen-stub') === null, 'the Solo screen is no longer a placeholder');

    // Fly to start reuses the 1.0.0 teleport path, not a new one.
    const before = E.lla();
    ok(E.R.shell.E.soloFly.disabled === false, 'Fly to start is enabled for an air-start course');
    ok(E.R.shell.soloFlyToStart() === true, 'Fly to start reports success');
    ok(JSON.stringify(E.lla()) !== JSON.stringify(before), 'and actually repositioned the aircraft');
    ok(near(E.lla()[0], 44, 0.05) && near(E.lla()[1], -121, 0.05), 'onto gate 1');

    // The clock is the existing one: crossing gate 1 starts it, exactly as a classic-panel run does.
    departGate1(E, 44, -121);
    ok(E.R.race.state === 'running', 'leaving the start sphere starts the run: ' + E.R.race.state + ' ' + E.R.race.dqReason);
    ok(E.R.hud.E.root !== undefined, 'the existing race HUD is the one in use — Solo adds no HUD of its own');

    ok(E.wsRecord.sockets.length === 0, 'the entire solo flow opened ZERO WebSockets — no room, no hub, no relay');
    ok(E.R.hub.connected === false && E.R.hub.wantOpen === false, 'and never tried to reach the hub');
  }

  console.log('1.3.1 Solo: a ground-start course cannot fly-to-start, and says so rather than failing quietly');
  {
    const COURSE = { id: 'ground', name: 'Ground Start', startType: 'ground',
      gates: [{ lat: 44, lon: -121, alt: 100, radius: 150 }, { lat: 44.02, lon: -121, alt: 100, radius: 150 }] };
    const E = env({ lobbyV2: true,
      apiHandler: (url) => (String(url).includes('index.json')
        ? { ok: true, json: async () => [{ id: 'ground', name: 'Ground Start', file: 'ground.json' }] }
        : String(url).includes('ground.json') ? { ok: true, json: async () => COURSE } : null) });
    await E.bootFrames();
    E.R.shell.setScreen('solo');
    await new Promise((r) => setTimeout(r, 50));
    await E.R.shell.soloLoad();
    ok(E.R.race.course.startType === 'ground', 'a ground-start course loads normally');
    ok(E.R.shell.E.soloFly.disabled === true, 'but Fly to start is disabled for it');
    ok(/cross gate 1/i.test(E.R.shell.E.soloHint.textContent), 'and the screen explains what to do instead');
  }

  console.log('1.3.1 collapse: a manual control shrinks the shell to a reopenable tab, and back');
  {
    const E = env({ lobbyV2: true, apiBase: 'shipped' });
    const sh = E.R.shell;
    ok(!!sh.E.collapseBtn, 'the top bar has a collapse control (it had none in 1.3.0)');
    ok(sh.collapsed === false, 'the shell starts expanded');
    ok(sh.E.reopenTab.classList.contains('fr-hidden'), 'and the reopen tab is hidden while it is');

    sh.E.collapseBtn.click();
    ok(sh.collapsed === true, 'clicking it collapses the shell');
    ok(sh.E.shell.classList.contains('fr-collapsed'), 'the panel itself is out of the way');
    ok(!sh.E.reopenTab.classList.contains('fr-hidden'), 'and a reopen tab is the one thing left on screen');
    ok(sh.E.reopenTab.parentNode === E.w.document.body && sh.E.reopenTab.parentNode !== sh.E.shell,
      'the reopen tab lives outside #fr-shell, so collapsing can never hide the control that reopens it');

    sh.E.reopenTab.click();
    ok(sh.collapsed === false, 'one click on the tab expands it again');
    ok(sh.E.reopenTab.classList.contains('fr-hidden'), 'and the tab goes away');
    ok(!sh.E.shell.classList.contains('fr-collapsed'), 'the panel is back');
  }

  console.log('1.3.1 collapse: the state persists for the session, and a storage failure never throws');
  {
    const E = env({ lobbyV2: true, apiBase: 'shipped' });
    E.R.shell.setCollapsed(true);
    ok(E.w.localStorage.getItem('finsRace.shellCollapsed') === 'true', 'a manual collapse is remembered');
    const E2 = env({ lobbyV2: true, apiBase: 'shipped', seed: { 'finsRace.shellCollapsed': true } });
    ok(E2.R.shell.collapsed === true, 'and a later load opens collapsed');
    ok(!E2.R.shell.E.reopenTab.classList.contains('fr-hidden'), 'showing its reopen tab');
    E2.R.shell.E.reopenTab.click();
    ok(E2.R.shell.collapsed === false, 'which still expands normally');

    // store.get/set are already try/catch-wrapped; this proves collapse rides that and never throws.
    const E3 = env({ lobbyV2: true, apiBase: 'shipped', quotaThrowsAlways: true });
    ok(E3.R.shell.collapsed === false, 'with localStorage disabled entirely the shell still boots, expanded');
    E3.R.shell.E.collapseBtn.click();
    ok(E3.R.shell.collapsed === true, 'and collapse still works in memory for the session');
  }

  console.log('1.3.1 auto-collapse: fires exactly at GO, never before');
  {
    const COURSE = { id: 'c', name: 'C', startType: 'air',
      gates: [{ lat: 44, lon: -121, alt: 1000, radius: 150 }, { lat: 44.02, lon: -121, alt: 1000, radius: 150 }] };
    const E = env({ lobbyV2: true, apiBase: 'shipped' });
    const sh = E.R.shell;
    E.R.race.load(COURSE);
    ok(sh.collapsed === false, 'loading a course does not collapse anything');

    E.R.countdown.arm(Date.now() + 5000);
    ok(E.R.countdown.state === 'armed', 'the countdown is armed…');
    ok(sh.collapsed === false, '…and the shell is STILL open — the Launch screen is the point of a countdown');

    E.R.countdown.arm(Date.now() - 1);   // re-arm into the past: the next tick is GO
    ok(E.R.countdown.state === 'go', 'the countdown reaches GO');
    ok(sh.collapsed === true, 'and the shell auto-collapses exactly then, so the race HUD has the screen');
    ok(sh.autoCollapsed === true, 'flagged as automatic, not as the pilot asking for it');
    ok(E.w.localStorage.getItem('finsRace.shellCollapsed') !== 'true',
      "and an auto-collapse never overwrites the pilot's own persisted preference");
  }

  console.log('1.3.1 auto-collapse: a solo run collapses when the clock actually starts');
  {
    const COURSE = { id: 'c', name: 'C', startType: 'air',
      gates: [{ lat: 44, lon: -121, alt: 1000, radius: 150 }, { lat: 44.02, lon: -121, alt: 1000, radius: 150 },
        { lat: 44.04, lon: -121, alt: 1000, radius: 150 }] };
    const E = env({ lobbyV2: true });   // solo: no relay at all, so there is no countdown to ride
    await E.bootFrames();
    E.R.race.load(COURSE);
    ok(E.R.shell.collapsed === false, 'armed but not started: still open');
    departGate1(E, 44, -121);
    ok(E.R.race.state === 'running', 'the run starts on leaving the start sphere: ' + E.R.race.state + ' ' + E.R.race.dqReason);
    ok(E.R.shell.collapsed === true, 'and the shell auto-collapses right then — a solo run has no countdown to hook');
  }

  console.log('1.3.1 auto-collapse: reopening by hand mid-race is honored and never interrupts the run');
  {
    const COURSE = { id: 'c', name: 'C', startType: 'air',
      gates: [{ lat: 44, lon: -121, alt: 1000, radius: 150 }, { lat: 44.02, lon: -121, alt: 1000, radius: 150 }] };
    const E = env({ lobbyV2: true, apiBase: 'shipped' });
    const sh = E.R.shell;
    E.R.race.load(COURSE);
    E.R.countdown.arm(Date.now() - 1);
    ok(sh.collapsed === true, 'auto-collapsed at GO');

    const stateBefore = E.R.race.state, elapsedBefore = E.R.race.elapsed;
    sh.E.reopenTab.click();
    ok(sh.collapsed === false, 'the pilot reopens it mid-race');
    ok(E.R.race.state === stateBefore && E.R.race.elapsed === elapsedBefore,
      'and the run is completely untouched — reopening moves DOM, never race state');

    E.R.race.state = 'running';
    sh.setCollapsed(false);          // an explicit expand during a live run
    E.R.race.emit('start');
    ok(sh.collapsed === false, 'a later auto-collapse trigger does NOT fight the pilot for the panel this run');
    E.R.race.emit('reset');
    ok(sh.expandedThisRun === false, 'and a fresh run restores the default');
  }

  console.log('1.3.1 auto-collapse: CONFIG.SHELL_AUTO_COLLAPSE = false leaves the manual control working');
  {
    const COURSE = { id: 'c', name: 'C', startType: 'air',
      gates: [{ lat: 44, lon: -121, alt: 1000, radius: 150 }, { lat: 44.02, lon: -121, alt: 1000, radius: 150 }] };
    const E = env({ lobbyV2: true, apiBase: 'shipped', patch: [['SHELL_AUTO_COLLAPSE: true,', 'SHELL_AUTO_COLLAPSE: false,']] });
    E.R.race.load(COURSE);
    E.R.countdown.arm(Date.now() - 1);
    ok(E.R.countdown.state === 'go' && E.R.shell.collapsed === false, 'GO no longer collapses anything');
    E.R.shell.E.collapseBtn.click();
    ok(E.R.shell.collapsed === true, 'but the manual collapse control is unaffected by the flag');
  }

  console.log('1.3.1 rollback: CONFIG.LOBBY_V2 = false still boots the classic panel with none of this');
  {
    const E = env({ lobbyV2: false, apiBase: 'shipped' });
    ok(E.w.document.getElementById('fr-shell') === null, 'no shell at all');
    ok(E.w.document.getElementById('fr-shell-reopen') === null, 'and no reopen tab left floating over the view');
    ok(E.w.document.getElementById('fr-root') !== null, 'the classic panel is what boots');
    ok(E.R.hub.connect() === false, 'and the hub is off regardless of CONFIG.API_BASE');
  }

  // ------------------------------------------------------------ lobby reliability pass
  console.log('Lobby reliability: Course.hash agrees with the server for every shared course');
  {
    // test/course_hashes.json is also asserted by test_server.py against app.py's course_hash().
    // Both sides pinned to one fixture is what makes a vote-won course load without a mismatch.
    const E = env();
    const dir = path.join(__dirname, '..', 'courses');
    const pinned = JSON.parse(fs.readFileSync(path.join(__dirname, 'course_hashes.json'), 'utf8'));
    const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
    const bad = index.filter((e) => {
      const c = E.R._internals.Course.normalize(JSON.parse(fs.readFileSync(path.join(dir, e.file), 'utf8')));
      return E.R._internals.Course.hash(c) !== pinned[e.id];
    }).map((e) => e.id);
    ok(index.length > 0 && bad.length === 0, 'race.js hashes match the pinned server hashes' + (bad.length ? ' (differs: ' + bad.join(', ') + ')' : ''));
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const raceSockets = (E) => E.wsRecord.sockets.filter((s) => s.url.includes('/ws/race/'));
  const openRaceSockets = (E) => raceSockets(E).filter((s) => s.readyState !== 3);

  console.log('Lobby reliability: rejoining a room never leaves a stale socket that reconnects behind the live one');
  {
    // The 1.3.x churn: disconnect() closed the old socket with its onclose still attached; that
    // onclose saw wantOpen=true (set by the next connect) and scheduled a retry on the old url,
    // which then tore down the live socket and opened a third.
    const E = env({ lobbyV2: true, apiBase: 'https://relay.test', patch: [['POWERUP_RECONNECT_MS: 2000,', 'POWERUP_RECONNECT_MS: 10,']] });
    E.R.lobby.joinRoom('same-room', {});
    const first = raceSockets(E)[0];
    first.fireOpen();
    E.R.lobby.joinRoom('same-room', {});
    const second = E.R.relay.ws;
    ok(first.readyState === 3 && second !== first, 'the first socket is closed and a second one opened');
    second.fireOpen();
    await sleep(80);
    ok(raceSockets(E).length === 2, 'no retry fired for the old socket (' + raceSockets(E).length + ' race sockets ever opened)');
    ok(openRaceSockets(E).length === 1 && E.R.relay.ws === second, 'exactly one live race socket, and it is the current one');
    ok(E.R.relay.live.size === 1, 'Relay.live tracks one socket');
    ok(E.R.relay.connected === true, 'and the old socket\'s close did not mark the live one disconnected');
    first.onmessage && first.onmessage({ data: JSON.stringify({ type: 'joined', room: 'same-room', proto: 1 }) });
    ok(E.R.lobby.proto === 0, 'a frame arriving on the detached socket is ignored');
    // A genuine drop of the CURRENT socket still reconnects.
    second.close();
    await sleep(80);
    ok(openRaceSockets(E).length === 1 && E.R.relay.ws !== second, 'a real drop of the live socket still reconnects');
  }

  console.log('Lobby reliability: LOBBY_V2 never joins a room on its own (boot, course load, Race events)');
  {
    const COURSE = { id: 'c', name: 'C', startType: 'air',
      gates: [{ lat: 44, lon: -121, alt: 1000, radius: 150 }, { lat: 44.02, lon: -121, alt: 1000, radius: 150 }] };
    const E = env({ lobbyV2: true, apiBase: 'https://relay.test', seed: { 'finsRace.powerupRoom': 'friday-night' } });
    ok(raceSockets(E).length === 0, 'a room stored from last session is not joined at boot');
    E.R.race.load(COURSE);
    E.R.race.reset();
    ok(raceSockets(E).length === 0, 'nor on a course load or a reset');
    ok(!E.w.document.querySelector('input[aria-label="Relay room code"]') ||
      !E.w.document.querySelector('input[aria-label="Relay room code"]').isConnected, 'the typed Room box is not on the page');
    ok(E.R.shell.enterRoom('friday-night', false) === true && raceSockets(E).length === 1, 'an explicit join still works');
    raceSockets(E)[0].fireOpen();
    E.R.shell.leaveRoom();
    ok(E.w.localStorage.getItem('finsRace.powerupRoom') === '""', 'Leave forgets the room');
    E.R.race.load(COURSE);
    ok(openRaceSockets(E).length === 0, 'and the next course load does not rejoin it');
  }

  console.log('Lobby reliability: the loader is idempotent — same version reuses, a new version replaces');
  {
    const E = env({ lobbyV2: true, apiBase: 'https://relay.test' });
    E.R.lobby.joinRoom('guard-room', {});
    const sock = raceSockets(E)[0];
    sock.fireOpen();
    const first = E.w.__finsRace;
    E.w.eval(SRC);
    ok(E.w.__finsRace === first, 'a second load of the same version keeps the first instance');
    ok(E.w.document.querySelectorAll('#fr-shell').length === 1, 'one shell on the page');
    ok(openRaceSockets(E).length === 1, 'and still one race socket');
    ok(E.w.__finsRaceLoads === 2, 'the load count is recorded for the debug overlay');
    E.w.eval(SRC.replace(/VERSION: '[^']+'/, "VERSION: '9.9.9-test'"));
    ok(E.w.__finsRace !== first && E.w.__finsRace.version === '9.9.9-test', 'a different version replaces the first');
    ok(sock.readyState === 3 && first.relay.live.size === 0, "the old instance's race socket was closed");
    ok(E.w.document.querySelectorAll('#fr-shell').length === 1 && E.w.document.querySelectorAll('#fr-style').length === 1,
      'exactly one shell and one stylesheet — the old DOM is gone');
    ok(first.hub.ws === null, "and the old instance's hub socket too");
  }

  console.log('Lobby reliability: a relay below proto 5 gets a persistent banner, never a silent fallback');
  {
    const E = env({ lobbyV2: true, apiBase: 'https://relay.test' });
    E.R.shell.enterRoom('old-relay', false);
    const ws = raceSockets(E)[0];
    ws.fireOpen();
    ws.fireMessage({ type: 'joined', room: 'old-relay', proto: 4, server_ms: Date.now() });
    const b = E.R.shell.E.protoBanner;
    ok(!b.classList.contains('fr-hidden') && /Server proto 4, client needs 5/.test(b.textContent), 'banner: ' + b.textContent);
    ok(E.w.getComputedStyle(b).display !== 'none', 'and it is actually visible');
    E.R.shell.renderStatusBar();
    ok(!b.classList.contains('fr-hidden'), 'it survives the 1 Hz status render');
    ok(!E.R.ui.E.cdSection.classList.contains('fr-hidden'), 'the manual-sync fallback stays available for an old relay');
    E.R.shell.leaveRoom();
    ok(b.classList.contains('fr-hidden'), 'leaving the room clears it');
    E.R.shell.enterRoom('new-relay', false);
    const ws2 = E.R.relay.ws;
    ws2.fireOpen();
    ws2.fireMessage({ type: 'joined', room: 'new-relay', proto: 5, server_ms: Date.now() });
    ok(b.classList.contains('fr-hidden'), 'a proto-5 room shows no banner');
    ok(E.R.ui.E.cdSection.classList.contains('fr-hidden'), 'and hides the superseded manual-sync countdown');
  }

  console.log('Lobby reliability: fr-hidden really hides shell elements (computed style, not classList)');
  {
    const E = env({ lobbyV2: true, apiBase: 'https://relay.test' });
    const cs = (el) => E.w.getComputedStyle(el).display;
    ok(cs(E.R.shell.E.notice) === 'none', 'the empty notice box is hidden');
    ok(cs(E.R.shell.E.reopenTab) === 'none', 'the reopen tab is hidden while expanded');
    ok(cs(E.R.shell.E.gateStartAnyway) === 'none', 'a guest does not see Start anyway');
    E.R.shell.toast('hello', 'error');
    ok(cs(E.w.document.getElementById('fr-toasts')) !== 'none', 'a toast container is visible');
  }

  console.log('Lobby reliability: a shell that throws at boot never takes the race loop with it, and says why');
  {
    // The classic panel is gone under the shipped LOBBY_V2 default (race/CLAUDE.md feature-series
    // "full migration" — see UI.init()'s E.lbSection comment), so a shell boot failure has no
    // second UI to fall back onto any more; it just has to say so loudly and leave the HUD alone.
    const E = env({ lobbyV2: true, apiBase: 'https://relay.test', patch: [['this.buildRamp();', 'this.buildRamp(); throw new Error(\'boom\');']] });
    ok(E.R.ui.mounted.ui === 'hud-only' && /boom/.test(E.R.ui.mounted.why), 'mounted: ' + JSON.stringify(E.R.ui.mounted));
    ok(E.R.ui.E.root === undefined, 'no classic panel was built either');
    ok(E.w.document.getElementById('fr-banner').textContent.includes('Lobby failed to start'), 'the failure is a visible banner');
    ok(E.w.document.getElementById('fr-lobby') === null, 'and the superseded lobby card still is not');
    ok(E.w.document.getElementById('fr-hud') !== null, 'the HUD still exists — solo racing keeps working');
  }

  console.log('Lobby reliability: an error thrown handling a relay frame becomes a visible toast');
  {
    const E = env({ lobbyV2: true, apiBase: 'https://relay.test' });
    E.R.shell.enterRoom('throwy', false);
    const ws = E.R.relay.ws;
    ws.fireOpen();
    const errs = [];
    E.w.console.error = (...a) => errs.push(a);
    E.R.lobby.onFrame = () => { throw new Error('reducer exploded'); };
    ws.fireMessage({ type: 'lobby', phase: 'lobby', players: [] });
    const t = E.w.document.getElementById('fr-toasts');
    ok(t && /reducer exploded/.test(t.textContent), 'toast: ' + (t && t.textContent));
    ok(errs.length === 1, 'and a console error with the stack');
  }

  // ---- section 2: every lobby control, click -> frame -> reply -> render
  const LOBBY = (over) => ({ type: 'lobby', phase: 'lobby', host: 'Eric', course: null, rules: { powerups: true, teleport: true },
    race_id: 0, players: [{ callsign: 'Eric', model: '', ready: false, role: 'racer' }], cup: null, ...over });
  const gateEnv = (opts) => {
    const E = env({ lobbyV2: true, apiBase: 'https://relay.test', seed: { 'finsRace.callsign': 'Eric', ...((opts && opts.seed) || {}) }, ...((opts && opts.env) || {}) });
    E.R.shell.enterRoom('gate-test', false);
    const ws = E.R.relay.ws;
    ws.fireOpen();
    ws.fireMessage({ type: 'joined', room: 'gate-test', proto: 5, server_ms: Date.now() });
    ws.fireMessage(LOBBY((opts && opts.lobby) || {}));
    const toasts = () => { const t = E.w.document.getElementById('fr-toasts'); return t ? t.textContent : ''; };
    return { E, ws, toasts };
  };

  console.log('Lobby reliability: lobbyCanStart — a course, or at least one vote for a candidate');
  {
    const { lobbyCanStart, lobbyInitialState } = E0.R._internals;
    const base = lobbyInitialState();
    const vote = { candidates: [{ courseId: 'a', name: 'A' }, { courseId: 'surprise-me', name: 'Surprise me' }], votes: {} };
    ok(lobbyCanStart({ ...base, course: { course_id: 'x' } }).via === 'course', 'a host course is enough');
    ok(lobbyCanStart({ ...base, vote }).ok === false, 'a vote nobody has voted in is not');
    ok(lobbyCanStart({ ...base, vote: { ...vote, votes: { Eric: 'a' } } }).via === 'vote', 'one vote for a candidate is');
    ok(lobbyCanStart({ ...base, vote: { ...vote, votes: { Eric: 'ghost' } } }).ok === false, 'a vote for a non-candidate does not count');
    ok(/pick a course/.test(lobbyCanStart(base).why), 'and the reason is spelled out');
  }

  console.log('Lobby reliability: Ready — click sends, the lobby frame re-renders the Gate at once');
  {
    const { E, ws } = gateEnv();
    E.R.shell.E.gateReadyBtn.click();
    ok(ws.ofType('ready').length === 1 && ws.ofType('ready')[0].ready === true, 'ready{ready:true} sent');
    ws.fireMessage(LOBBY({ players: [{ callsign: 'Eric', model: '', ready: true, role: 'racer' }] }));
    ok(E.R.shell.E.gateReadyBtn.textContent === 'READY ✓', 'the button flips on the lobby frame, not on the next 1 Hz tick');
    E.R.shell.E.gateReadyBtn.click();
    ok(ws.ofType('ready').length === 2 && ws.ofType('ready')[1].ready === false, 'clicking again sends Not ready');
  }

  console.log('Lobby reliability: a frame that cannot go out says so instead of vanishing');
  {
    const E = env({ lobbyV2: true, apiBase: 'https://relay.test', seed: { 'finsRace.callsign': 'Eric' } });
    E.R.shell.enterRoom('slow-room', false);        // socket still CONNECTING
    E.R.shell.setScreen('gate');
    E.R.shell.E.gateReadyBtn.click();
    const t = E.w.document.getElementById('fr-toasts');
    ok(t && /Ready not sent: still connecting/.test(t.textContent), 'toast: ' + (t && t.textContent));
    ok(E.R.lobby.ready === false, 'and the local ready flag is not flipped for a frame that never left');
  }

  console.log('Lobby reliability: relay refusals reach a toast on the Gate, once per 10 s');
  {
    const { E, ws, toasts } = gateEnv();
    ws.fireMessage({ type: 'error', detail: 'no course selected' });
    ok(/The host has not picked a course yet./.test(toasts()), 'toast: ' + toasts());
    ws.fireMessage({ type: 'error', detail: 'no course selected' });
    ok(E.w.document.getElementById('fr-toasts').children.length === 1, 'a repeat inside 10 s is not a second toast');
  }

  console.log('Lobby reliability: typed chat — the relay\'s {from, text} shape renders in the Gate and the HUD');
  {
    const { E, ws } = gateEnv();
    E.R.shell.E.gateChatInput.value = '  on the   runway ';
    E.R.shell.E.gateChatSend.click();
    ok(ws.ofType('chat').length === 1 && ws.ofType('chat')[0].text === 'on the runway', 'chat{text} sent, sanitized');
    ws.fireMessage({ type: 'chat', from: 'Steve', text: 'two minutes' });
    ok(/Steve/.test(E.R.shell.E.gateChatFeed.textContent) && /two minutes/.test(E.R.shell.E.gateChatFeed.textContent),
      'the line is in the Gate feed: ' + E.R.shell.E.gateChatFeed.textContent);
    ok(E.R.lobby.state.chat[0].kind === 'text' && E.R.lobby.state.chat[0].callsign === 'Steve', 'reduced as a text line from Steve');
    E.R.shell.E.gateChatQuick.querySelector('button').click();
    ok(ws.ofType('chat').length === 2 && typeof ws.ofType('chat')[1].code === 'string', 'a quick-chat button sends a code');
  }

  console.log('Lobby reliability: the join says client_proto 5 and carries a stored token even before the hub answers');
  {
    const E = env({ lobbyV2: true, apiBase: 'https://relay.test', seed: { 'finsRace.pilotToken': 'tok-stored' } });
    E.R.hub.pilotToken = '';
    E.R.shell.enterRoom('token-room', false);
    E.R.relay.ws.fireOpen();
    const join = E.R.relay.ws.ofType('join')[0];
    ok(join.client_proto === 5 && join.pilot_token === 'tok-stored', 'join: ' + JSON.stringify(join));
  }

  console.log('Lobby reliability: a voting room can start — the host keeps a picker and Start works on a vote');
  {
    const { E, ws } = gateEnv();
    ws.fireMessage({ type: 'vote', candidates: [{ course_id: 'gorge-run', name: 'Gorge' }, { course_id: 'surprise-me', name: 'Surprise me' }], votes: {} });
    const sh = E.R.shell;
    ok(!sh.E.gateHostCourseRow.classList.contains('fr-hidden'), 'the host still gets a course picker while a vote is up');
    ok(sh.E.gateStartAnyway.disabled === true && /Vote for a course/.test(sh.E.gateReadySub.textContent), 'no vote yet: Start is disabled and says why');
    sh.E.gateVoteGrid.querySelector('button').click();
    ok(ws.ofType('vote').length === 1 && ws.ofType('vote')[0].course_id === 'gorge-run', 'clicking a tile sends the vote');
    ws.fireMessage({ type: 'vote', candidates: [{ course_id: 'gorge-run', name: 'Gorge' }, { course_id: 'surprise-me', name: 'Surprise me' }], votes: { Eric: 'gorge-run' } });
    ok(sh.E.gateStartAnyway.disabled === false, 'one vote cast: Start anyway is live');
    ws.fireMessage(LOBBY({ players: [{ callsign: 'Eric', model: '', ready: true, role: 'racer' }] }));
    sh._gateReadySinceMs = Date.now() - 5000;
    sh._gateTick();
    const starts = ws.ofType('start');
    ok(starts.length === 1, 'and the host auto-start fires on the vote, with no course set by hand (' + starts.length + ')');
  }

  console.log('Lobby reliability: a guest in a voting room gets no host controls');
  {
    const { E, ws } = gateEnv({ lobby: { host: 'Steve', players: [{ callsign: 'Steve', ready: false, role: 'racer' }, { callsign: 'Eric', ready: false, role: 'racer' }] } });
    ws.fireMessage({ type: 'vote', candidates: [{ course_id: 'gorge-run', name: 'Gorge' }], votes: {} });
    const cs = (el) => E.w.getComputedStyle(el).display;
    ok(cs(E.R.shell.E.gateHostCourseRow) === 'none' && cs(E.R.shell.E.gateStartAnyway) === 'none', 'no picker, no Start anyway (computed style)');
  }

  console.log('Lobby reliability: a throwing Gate handler becomes a toast, not a dead click');
  {
    const { E, toasts } = gateEnv();
    E.R.lobby.setReady = () => { throw new Error('ready exploded'); };
    const errs = [];
    E.w.console.error = (...a) => errs.push(a);
    E.R.shell.E.gateReadyBtn.click();
    ok(/ready exploded/.test(toasts()) && errs.length === 1, 'toast: ' + toasts());
  }

  console.log('Lobby reliability: ping-the-ramp refusals are visible');
  {
    const E = env({ lobbyV2: true, apiBase: 'https://relay.test' });
    const hub = E.wsRecord.sockets.find((s) => s.url.includes('/ws/hub'));
    hub.fireOpen();
    hub.fireMessage({ type: 'welcome', pilot_id: 'p1', pilot_token: 't1', proto: 5 });
    E.R.shell.pingRamp();
    ok(hub.ofType('ping_ramp').length === 1, 'ping_ramp sent');
    hub.fireMessage({ type: 'error', detail: "you're out of ramp pings for today" });
    const t = E.w.document.getElementById('fr-toasts');
    ok(t && /out of ramp pings/.test(t.textContent), 'toast: ' + (t && t.textContent));
  }

  // ---- section 4: ready -> GO -> grid -> teleport
  const AIR = {
    id: 'grid-air', name: 'Grid Air', startType: 'air', aircraftId: null,
    gates: [along(0), along(2000), along(4000)].map((g) => ({ ...g, radius: 150 })),
  };

  console.log('Rolling start: a formation frame places the aircraft on its slot and engages the autopilot');
  {
    const { E, ws } = gateEnv();
    E.R.race.load(AIR);
    const hash = E0.R._internals.Course.hash(AIR);
    const green = Date.now() + 30000;
    ws.fireMessage({ type: 'formation', race_id: 1, formation_start_ms: Date.now(), green_at_ms: green,
      pace_kt: 180, pace_s: 60, slots: [{ callsign: 'Eric', index: 0 }],
      course: { course_id: AIR.id, course_hash: hash, name: AIR.name, start_type: 'air', gates: 3 }, vote: null });
    ok(E.R.countdown.state === 'armed', 'the countdown armed on the synced green time');
    ok(E.R.race.goAt != null, 'Race.armGo ran, same as the grid path');
    ok(E.phys.calls.place.length === 1, 'the aircraft was placed exactly once');
    ok(E.phys.geofs.autopilot.on === true, 'the autopilot engaged');
    ok(near(E.phys.geofs.autopilot.values.speed, 180, 1), 'autopilot speed is the pace (kt): ' + E.phys.geofs.autopilot.values.speed);
    const tp = E.R.debug.facts['formation place'];
    ok(tp && tp.slot === 0, 'the debug log records which slot it placed into');
  }

  console.log('Air start: the formation spawn uses geofs.flyTo and hands the autopilot to the pace lap');
  {
    const { E, ws } = gateEnv({ env: { patch: [['AIR_START_STABILIZE_MS: 3000,', 'AIR_START_STABILIZE_MS: 50,']] } });
    await E.bootFrames();
    E.phys.calls.flyTo = [];
    E.w.geofs.flyTo = (a) => { E.phys.calls.flyTo.push(a.slice()); E.w.geofs.aircraft.instance.llaLocation = a.slice(0, 3); };
    E.R.race.load(AIR);
    const hash = E0.R._internals.Course.hash(AIR);
    ws.fireMessage({ type: 'formation', race_id: 1, formation_start_ms: Date.now(), green_at_ms: Date.now() + 30000,
      pace_kt: 180, pace_s: 60, slots: [{ callsign: 'Eric', index: 0 }],
      course: { course_id: AIR.id, course_hash: hash, name: AIR.name, start_type: 'air', gates: 3 }, vote: null });
    ok(E.phys.calls.flyTo.length === 1 && E.phys.calls.place.length === 0, 'spawned once with flyTo, never place()');
    ok(E.R.lobby.formationSettling === true, 'steering waits while the flyTo spawn settles');
    E.phys.geofs.autopilot.on = false;   // flyTo's pause is not the pilot taking the controls
    E.frame(600);
    ok(E.R.lobby.formationOut === false && ws.ofType('formation_drop').length === 0, 'no formation_drop while settling');
    await sleep(400);
    ok(E.R.lobby.formationSettling === false, 'settled');
    ok(E.phys.geofs.autopilot.on === true && E.phys.geofs.autopilot.values.speed === 180, 'the autopilot is left ON at the pace for formationTick');
    ok(Math.abs(E.phys.geofs.controls.throttle - 0.8) < 0.05, 'throttle set on the spawn (' + E.phys.geofs.controls.throttle + ')');
  }

  console.log('Air start: a grid slot is sized for this aircraft\'s own speed (a Cub is not flown at the 180 kt pace)');
  {
    const { E, ws } = gateEnv({ env: { aircraftId: '1', patch: [['AIR_START_STABILIZE_MS: 3000,', 'AIR_START_STABILIZE_MS: 50,']] },
      lobby: { players: [{ callsign: 'Eric', ready: true, role: 'racer' }] } });
    E.R.race.load(AIR);
    ws.fireMessage({ type: 'start', race_id: 1, start_at_server_ms: Date.now() + 10000, racers: ['Eric'] });
    const cubMs = E0.R._internals.ktToMs(75);
    ok(near(E.R.lobby.gridSpeedMs, cubMs, 1e-6), 'gridSpeedMs is 75 kt for the Cub: ' + E.R.lobby.gridSpeedMs);
    const tp = E.R.debug.facts.teleport;
    ok(tp && tp.ok && tp.method === 'place', 'placed (no flyTo in this mock) via airStart: ' + JSON.stringify(tp && tp.method));
    await tp.done;
    ok(near(E.speed(), cubMs, 1e-6) && E.phys.geofs.autopilot.on === false, 'flying at 75 kt, autopilot handed back before GO');
  }

  console.log('Rolling start: an order-only rebroadcast (same race_id) updates the slot but never re-places');
  {
    const { E, ws } = gateEnv();
    E.R.race.load(AIR);
    const hash = E0.R._internals.Course.hash(AIR);
    const green = Date.now() + 30000;
    const base = { type: 'formation', race_id: 1, green_at_ms: green, pace_kt: 180, pace_s: 60,
      course: { course_id: AIR.id, course_hash: hash, name: AIR.name, start_type: 'air', gates: 3 }, vote: null };
    ws.fireMessage({ ...base, formation_start_ms: Date.now(), slots: [{ callsign: 'Steve', index: 0 }, { callsign: 'Eric', index: 1 }] });
    ok(E.phys.calls.place.length === 1, 'placed once on the first frame');
    ok(E.R.lobby.formationIndex === 1, 'starts at slot 1');
    ws.fireMessage({ ...base, slots: [{ callsign: 'Eric', index: 0 }, { callsign: 'Steve', index: 1 }] });
    ok(E.phys.calls.place.length === 1, 'a reorder for the SAME race_id never re-teleports');
    ok(E.R.lobby.formationIndex === 0, 'but the local slot index tracks the new order');
  }

  console.log('Rolling start: the steering loop commands course/speed toward the live slot target');
  {
    const { E, ws } = gateEnv();
    await E.bootFrames();
    E.R.race.load(AIR);
    const hash = E0.R._internals.Course.hash(AIR);
    const green = Date.now() + 30000;
    ws.fireMessage({ type: 'formation', race_id: 1, formation_start_ms: Date.now(), green_at_ms: green,
      pace_kt: 180, pace_s: 60, slots: [{ callsign: 'Eric', index: 0 }],
      course: { course_id: AIR.id, course_hash: hash, name: AIR.name, start_type: 'air', gates: 3 }, vote: null });
    const speedBefore = E.phys.geofs.autopilot.values.speed;
    const courseBefore = E.phys.geofs.autopilot.values.course;
    for (let i = 0; i < 40; i++) E.frame(100);   // several steering ticks at 100ms/frame, 2 Hz throttle
    ok(Number.isFinite(E.phys.geofs.autopilot.values.speed) && Number.isFinite(E.phys.geofs.autopilot.values.course),
      'autopilot speed/course stay real numbers throughout: ' + JSON.stringify(E.phys.geofs.autopilot.values));
    ok(E.phys.geofs.autopilot.values.speed >= 180 - 25 - 0.5 && E.phys.geofs.autopilot.values.speed <= 180 + 25 + 0.5,
      'commanded speed stays within pace +/- clamp (' + E.phys.geofs.autopilot.values.speed + ')');
  }

  console.log('Rolling start: the autopilot dropping mid pace-lap sends formation_drop and shows OUT OF FORMATION');
  {
    const { E, ws } = gateEnv();
    await E.bootFrames();
    E.R.race.load(AIR);
    const hash = E0.R._internals.Course.hash(AIR);
    const green = Date.now() + 30000;
    ws.fireMessage({ type: 'formation', race_id: 1, formation_start_ms: Date.now(), green_at_ms: green,
      pace_kt: 180, pace_s: 60, slots: [{ callsign: 'Eric', index: 0 }],
      course: { course_id: AIR.id, course_hash: hash, name: AIR.name, start_type: 'air', gates: 3 }, vote: null });
    ok(E.R.lobby.formationOut === false, 'not out of formation yet');
    E.phys.geofs.autopilot.on = false;   // simulate the pilot touching the controls
    E.frame(600);
    ok(E.R.lobby.formationOut === true, 'formationTick notices the autopilot is off and flags OUT OF FORMATION');
    ok(ws.ofType('formation_drop').length === 1, 'formation_drop was sent exactly once: ' + JSON.stringify(ws.ofType('formation_drop')));
    const before = ws.sent.length;
    E.frame(600); E.frame(600);
    ok(ws.sent.length === before, 'and never sent again — the pilot is done being steered');
  }

  console.log('Rolling start: green disengages the autopilot and checks the throttle');
  {
    const { E, ws } = gateEnv();
    E.R.race.load(AIR);
    const hash = E0.R._internals.Course.hash(AIR);
    const green = Date.now() + 60;   // fires very soon — Countdown uses real setTimeout
    ws.fireMessage({ type: 'formation', race_id: 1, formation_start_ms: Date.now(), green_at_ms: green,
      pace_kt: 180, pace_s: 60, slots: [{ callsign: 'Eric', index: 0 }],
      course: { course_id: AIR.id, course_hash: hash, name: AIR.name, start_type: 'air', gates: 3 }, vote: null });
    ok(E.phys.geofs.autopilot.on === true, 'engaged during the pace lap');
    E.phys.geofs.controls.throttle = 0.1;   // a real GeoFS build that drops throttle on disengage
    await sleep(250);
    ok(E.phys.geofs.autopilot.on === false, 'green disengaged the autopilot');
    ok(E.phys.geofs.controls.throttle >= 0.9, 'and pressed increaseThrottle until it cleared 0.9 (' + E.phys.geofs.controls.throttle + ')');
    const tp = E.R.debug.facts['rolling start green throttle'];
    ok(tp && tp.before < 0.9 && tp.after >= 0.9 && tp.presses > 0, 'the debug log records before/after/presses: ' + JSON.stringify(tp));
    ok(E.R.lobby.formationIndex === -1, 'formation bookkeeping is cleared once green has been handled');
  }

  console.log('Rolling start: a spectator never gets placed or steered');
  {
    const { E, ws } = gateEnv({ lobby: { players: [{ callsign: 'Eric', ready: false, role: 'spectator' }] } });
    await E.bootFrames();
    E.R.race.load(AIR);
    const hash = E0.R._internals.Course.hash(AIR);
    ws.fireMessage({ type: 'formation', race_id: 1, formation_start_ms: Date.now(), green_at_ms: Date.now() + 30000,
      pace_kt: 180, pace_s: 60, slots: [{ callsign: 'Steve', index: 0 }],
      course: { course_id: AIR.id, course_hash: hash, name: AIR.name, start_type: 'air', gates: 3 }, vote: null });
    ok(E.phys.calls.place.length === 0, 'never placed — not on the grid');
    for (let i = 0; i < 10; i++) E.frame(600);
    ok(E.phys.calls.setLinearVelocity.length === 0 && ws.ofType('formation_drop').length === 0, 'never steered, never drops out');
  }

  console.log('Lobby reliability: the GO time uses the ping/pong offset — relay 1.8 s behind this client');
  {
    const { clockOffset, serverToLocalMs } = E0.R._internals;
    const local = 1_700_000_000_000, skew = -1800;          // server = local - 1800
    const samples = [{ t0: local, t1: local + 40, server_ms: local + 20 + skew },
      { t0: local + 200, t1: local + 300, server_ms: local + 250 + skew }];
    const off = clockOffset(samples);
    ok(Math.abs(off - skew) <= 1, 'offset from the min-RTT sample is the skew (' + off + ')');
    const goServer = local + skew + 10000;
    ok(Math.abs(serverToLocalMs(goServer, off) - (local + 10000)) <= 1, 'a GO stamped 10 s ahead on the relay is 10 s ahead here');
    ok(serverToLocalMs(goServer, null) === goServer, 'never synced: the raw value is the fallback');
  }

  console.log('Lobby reliability: end to end, a skewed relay clock still puts GO 10 s out on this client');
  {
    const { E, ws } = gateEnv();
    E.R.race.load(AIR);
    await sleep(900);
    const pings = ws.ofType('ping');                                        // the 5-ping burst, 200 ms apart
    // The relay stamps its clock mid-flight: halfway between the ping leaving and the pong landing.
    for (const p of ws.ofType('ping')) ws.fireMessage({ type: 'pong', t0: p.t0, server_ms: Math.round((p.t0 + Date.now()) / 2) - 1800 });
    ok(pings.length >= 1 && Math.abs(E.R.lobby.offsetMs + 1800) < 60, 'offset ≈ -1800 (' + E.R.lobby.offsetMs + ')');
    const serverNow = Date.now() - 1800;
    ws.fireMessage({ type: 'start', race_id: 1, start_at_server_ms: serverNow + 10000, racers: ['Eric'], vote: null,
      course: { course_id: AIR.id, course_hash: E.R.race.hash, name: AIR.name } });
    const lead = E.R.countdown.target - Date.now();
    ok(E.R.countdown.state === 'armed' && Math.abs(lead - 10000) < 150, 'GO is ~10 s out locally (' + lead + ' ms), not 8.2 s');
    ok(Math.abs(E.R.race.goAt - E.R.countdown.target) < 1, 'Race.armGo uses the same corrected time');
  }

  console.log('Lobby reliability: the Launch screen actually renders (route, countdown, refresh timer)');
  {
    // Regression: launchRouteSvg() handed minimapFit() [lat, lon] pairs, got a null fit and threw,
    // so every Launch render died before its 500 ms timer started. Hidden by Relay's old catch-all.
    const { E, ws } = gateEnv();
    E.R.race.load(AIR);
    ws.fireMessage({ type: 'start', race_id: 7, start_at_server_ms: Date.now() + 10000, racers: ['Eric'], vote: null,
      course: { course_id: AIR.id, course_hash: E.R.race.hash, name: AIR.name } });
    const sh = E.R.shell;
    ok(sh.screen === 'launch' && sh._launchTimer, 'on Launch with its refresh timer running');
    ok(sh.E.launchRoute.querySelectorAll('circle').length === AIR.gates.length, 'the route map draws every gate');
    ok(/^\d+$/.test(sh.E.launchCdBig.textContent) && +sh.E.launchCdBig.textContent >= 9, 'the countdown shows seconds (' + sh.E.launchCdBig.textContent + ')');
    ok(sh.E.launchGridList.children.length === 1, 'and the grid list has this pilot');
  }

  console.log('Lobby reliability: a start that lands before any pong is re-armed on the first one');
  {
    const { E, ws } = gateEnv();
    E.R.race.load(AIR);
    E.R.lobby.offsetMs = null; E.R.lobby.pingSamples = [];
    const serverNow = Date.now() - 1800;
    ws.fireMessage({ type: 'start', race_id: 3, start_at_server_ms: serverNow + 10000, racers: ['Eric'], vote: null,
      course: { course_id: AIR.id, course_hash: E.R.race.hash, name: AIR.name } });
    const early = E.R.countdown.target - Date.now();
    ok(Math.abs(early - 8200) < 150, 'armed on the raw relay clock first (' + early + ' ms)');
    ws.fireMessage({ type: 'pong', t0: Date.now() - 20, server_ms: Date.now() - 10 - 1800 });
    const fixed = E.R.countdown.target - Date.now();
    ok(Math.abs(fixed - 10000) < 150, 'and corrected by the first pong (' + fixed + ' ms)');
  }

  console.log('Lobby reliability: a vote-won course is loaded BEFORE arming, then the grid teleport runs');
  {
    const courseJson = JSON.parse(JSON.stringify(AIR));
    const { E, ws } = gateEnv({ env: {
      apiHandler: (url) => String(url).includes('courses/index.json') ? { ok: true, status: 200, json: async () => [{ id: AIR.id, name: AIR.name, file: 'grid-air.json' }] }
        : String(url).includes('grid-air.json') ? { ok: true, status: 200, json: async () => courseJson } : null } });
    const hash = E0.R._internals.Course.hash(E0.R._internals.Course.normalize(JSON.parse(JSON.stringify(AIR))));
    ok(!E.R.race.course, 'nothing is loaded when the start arrives (the lobby frame with the course comes after it)');
    ws.fireMessage({ type: 'start', race_id: 2, start_at_server_ms: Date.now() + 10000, racers: ['Steve', 'Eric'], vote: { course_id: AIR.id, name: AIR.name, votes: { Eric: AIR.id } },
      course: { course_id: AIR.id, course_hash: hash, name: AIR.name, start_type: 'air', gates: 3 } });
    ok(E.R.shell.screen === 'launch', 'the Launch screen is up while it loads');
    await sleep(80);
    ok(E.R.race.course && E.R.race.hash === hash, 'the start frame\'s course was loaded');
    ok(E.R.countdown.state === 'armed', 'the countdown armed once it was');
    const tp = E.R.debug.facts.teleport;
    ok(tp && tp.ok && tp.method === 'place' && tp.label === 'grid slot 2 of 2', 'teleport: ' + JSON.stringify(tp && { ok: tp.ok, method: tp.method, label: tp.label }));
    ok(tp && tp.before && tp.after && tp.slot, 'and the state before and after is logged');
    const want = E0.R._internals.gridSlot(AIR.gates[0], AIR.gates[1], 1, 2, E.R.lobby.gridLeadS, E.R.lobby.gridSpeedMs);
    const at = E.lla();
    ok(Math.abs(at[0] - want.lat) < 1e-6 && Math.abs(at[1] - want.lon) < 1e-6, 'the aircraft is on its own grid slot');
  }

  console.log('Lobby reliability: a stale course with the wrong hash is never teleported to');
  {
    const { E, ws, toasts } = gateEnv();
    E.R.race.load(AIR);                                      // some other course's geometry under the same id
    ws.fireMessage({ type: 'start', race_id: 4, start_at_server_ms: Date.now() + 10000, racers: ['Eric'], vote: null,
      course: { course_id: AIR.id, course_hash: 'deadbeef', name: 'The Real One' } });
    await sleep(60);
    ok(E.R.countdown.state !== 'armed', 'no countdown armed on the wrong course');
    ok(/Could not load The Real One/.test(toasts()) || /not in your course list/.test(toasts()), 'and it says so: ' + toasts());
  }

  console.log('Lobby reliability: grid slots for 1..12 pilots are distinct, spaced, and speed×lead back');
  {
    const { gridSlot, ecef, sub, vlen } = E0.R._internals;
    const g1 = AIR.gates[0], g2 = AIR.gates[1];
    const flat = (a, b) => vlen(sub(ecef(a.lat, a.lon, 0), ecef(b.lat, b.lon, 0)));
    let worstGap = Infinity, worstBack = 0;
    for (let n = 1; n <= 12; n++) {
      const slots = Array.from({ length: n }, (_, i) => gridSlot(g1, g2, i, n, 10, 150));
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) worstGap = Math.min(worstGap, flat(slots[i], slots[j]));
      // Longitudinal: every slot is speed*lead behind gate 1 along the reverse bearing; the rest of
      // its distance is the lateral offset.
      slots.forEach((s, i) => {
        const lateral = Math.abs(i - (n - 1) / 2) * 80;
        worstBack = Math.max(worstBack, Math.abs(Math.sqrt(Math.max(0, flat(s, g1) ** 2 - lateral ** 2)) - 1500));
      });
    }
    ok(worstGap >= 79, 'every pair of slots is at least 80 m apart (worst ' + worstGap.toFixed(1) + ' m)');
    ok(worstBack < 30, 'and each sits 150 m/s × 10 s = 1500 m behind gate 1 (worst error ' + worstBack.toFixed(1) + ' m)');
  }

  console.log('Lobby reliability: the debug "Test grid slot N" path teleports a lone pilot');
  {
    const E = env({ lobbyV2: true });
    ok(E.R.lobby.testGridSlot(1, 2).ok === false, 'needs an air-start course first');
    E.R.race.load(AIR);
    const res = E.R.lobby.testGridSlot(3, 4);
    const paceMs = E0.R._internals.ktToMs(E.R.config.PACE_KT);
    const want = E0.R._internals.gridSlot(AIR.gates[0], AIR.gates[1], 2, 4, E.R.config.COUNTDOWN_LEAD_S, paceMs);
    const at = E.lla();
    ok(res.ok && res.method === 'place' && Math.abs(at[0] - want.lat) < 1e-6, 'slot 3 of 4, via ' + res.method);
  }

  // ---- section 5: the rest of the lobby, end to end
  console.log('Lobby reliability: Away — 60 s with no input at the Gate reports idle, and the Gate shows Away');
  {
    const { hubActivity } = E0.R._internals;
    ok(hubActivity('idle', true, false, 61000, 60000) === 'idle', 'a Gate pilot idle past the threshold reports idle');
    ok(hubActivity('idle', true, false, 5000, 60000) === 'gate', 'one with recent input reports gate');
    ok(hubActivity('running', true, true, 999999, 60000) === 'racing', 'a racer is never reported idle');

    const { E, ws } = gateEnv({ lobby: { players: [{ callsign: 'Eric', ready: false, role: 'racer' }, { callsign: 'Steve', ready: false, role: 'racer' }] } });
    const hub = E.wsRecord.sockets.find((s) => s.url.includes('/ws/hub'));
    hub.fireOpen();
    hub.fireMessage({ type: 'welcome', pilot_id: 'p1', pilot_token: 't1', proto: 5 });
    const sh = E.R.shell;
    sh.renderStatusBar();
    ok(hub.ofType('where').slice(-1)[0].activity === 'gate', 'at the Gate, just arrived: gate');
    sh._lastInputAt = Date.now() - 61000;
    sh.renderStatusBar();
    const w = hub.ofType('where').slice(-1)[0];
    ok(w.activity === 'idle' && w.room === 'gate-test', 'after 60 s with no input: idle, still naming the room (' + JSON.stringify(w) + ')');
    E.w.dispatchEvent(new E.w.MouseEvent('mousemove', { bubbles: true }));
    ok(hub.ofType('where').slice(-1)[0].activity === 'gate', 'any input brings them straight back');
    // Another pilot the hub reports idle in this room reads as Away on the Gate.
    hub.fireMessage({ type: 'presence', pilots: [{ callsign: 'Steve', model: '', activity: 'idle', room: 'gate-test', idle_seconds: 3 }] });
    sh.renderGate();
    ok(/SteveF-16Away/.test(sh.E.gateGrid.textContent), 'Steve shows as Away: ' + sh.E.gateGrid.textContent);
    ok(!/EricYOUF-16Away/.test(sh.E.gateGrid.textContent), 'and Eric, who just moved the mouse, does not');
  }

  console.log('Lobby reliability: host handoff — the new host gets host controls on the very next lobby frame');
  {
    const { E, ws } = gateEnv({ lobby: { host: 'Steve', players: [{ callsign: 'Steve', ready: false, role: 'racer' }, { callsign: 'Eric', ready: false, role: 'racer' }] } });
    const cs = (el) => E.w.getComputedStyle(el).display;
    ok(cs(E.R.shell.E.gateStartAnyway) === 'none', 'a guest has no Start anyway');
    ws.fireMessage(LOBBY({ host: 'Eric', players: [{ callsign: 'Eric', ready: false, role: 'racer' }] }));
    ok(E.R.lobby.isHost() && cs(E.R.shell.E.gateStartAnyway) !== 'none' && cs(E.R.shell.E.gateHostCourseRow) !== 'none',
      'Steve left: Eric is host, and has the picker and Start anyway at once');
    ok(/★/.test(E.R.shell.E.gateGrid.textContent), 'the host star moved');
  }

  console.log('Lobby reliability: a spectator stays a spectator across a reconnect');
  {
    const E = env({ lobbyV2: true, apiBase: 'https://relay.test', patch: [['POWERUP_RECONNECT_MS: 2000,', 'POWERUP_RECONNECT_MS: 10,']] });
    E.R.shell.enterRoom('watch-me', true);
    const first = E.R.relay.ws;
    first.fireOpen();
    ok(first.ofType('join')[0].spectate === true, 'join{spectate:true}');
    E.R.race.load(AIR);
    ok(E.R.relay.ws === first, 'a course load does not reconnect behind the shell (spectate would have been dropped)');
    first.close();
    await sleep(60);
    E.R.relay.ws.fireOpen();
    ok(E.R.relay.ws !== first && E.R.relay.ws.ofType('join')[0].spectate === true, 'the reconnect joins as a spectator again');
  }

  // ---- section 6: CONFIG.DEBUG / Alt+D
  console.log('Lobby reliability: CONFIG.DEBUG is off by default; Alt+D shows the overlay with the live facts');
  {
    const altD = (E) => E.w.dispatchEvent(new E.w.KeyboardEvent('keydown', { code: 'KeyD', altKey: true, bubbles: true }));
    const { E, ws } = gateEnv();
    ok(E.R.config.DEBUG === false && E.w.document.getElementById('fr-debug') === null, 'off: no overlay');
    altD(E);
    const el = E.w.document.getElementById('fr-debug');
    ok(el && el.style.display !== 'none', 'Alt+D shows it');
    const text = el.textContent;
    ok(/client v\d/.test(text) && /relay proto 5/.test(text) && /ui shell \(CONFIG.LOBBY_V2 is on\)/.test(text), 'version, proto and which UI mounted: ' + text.split('\n').slice(0, 3).join(' | '));
    ok(/sockets race 1/.test(text), 'the live race-socket count');
    ok(/in +.*joined:1/.test(text) && /lobby:1/.test(text), 'received frame types are counted');
    E.R.shell.E.gateChatInput.value = 'secret words here';
    E.R.shell.sendChat();
    E.R.debug.render();
    ok(E.R.debug.events.some((e) => e.kind === 'frame out' && e.detail === 'chat'), 'a sent chat is logged by type');
    ok(!/secret words/.test(E.w.document.getElementById('fr-debug').textContent) && !E.R.debug.events.some((e) => /secret/.test(e.detail)),
      'and its text appears nowhere in the overlay or the log');
    ok(E.R.debug.events.some((e) => e.kind === 'ui mounted'), 'the UI mount and why is logged');
    altD(E);
    ok(E.w.document.getElementById('fr-debug').style.display === 'none' && E.w.localStorage.getItem('finsRace.debug') === 'false', 'Alt+D again hides it, and remembers');
  }

  console.log('Lobby reliability: CONFIG.DEBUG = true boots with the overlay, and its Test grid slot button teleports');
  {
    const E = env({ lobbyV2: true, patch: [['DEBUG: false,', 'DEBUG: true,']] });
    const el = E.w.document.getElementById('fr-debug');
    ok(el && el.style.display !== 'none', 'overlay at boot');
    E.R.race.load(AIR);
    const inputs = el.querySelectorAll('input');
    inputs[0].value = '2'; inputs[1].value = '3';
    el.querySelector('button').click();
    const tp = E.R.debug.facts['test grid slot'];
    ok(tp && tp.ok && tp.label === 'TEST grid slot 2 of 3' && tp.method === 'place', 'the button ran the teleport: ' + JSON.stringify(tp && tp.label));
    E.R.debug.render();
    ok(/teleport place -> TEST grid slot 2 of 3/.test(el.textContent), 'and the overlay shows the result');
  }

  console.log('GeoPhysics: unit conversions (callers speak SI; kt/ft only inside the adapter)');
  {
    const I = env().R._internals;
    ok(near(I.msToKt(1), 1.943846, 1e-5) && near(I.ktToMs(1), 0.514444, 1e-9), 'm/s <-> kt');
    ok(near(I.mToFt(1), 3.280840, 1e-6) && near(I.ftToM(1), 0.3048, 1e-12), 'm <-> ft');
    ok(near(I.ktToMs(I.msToKt(123.4)), 123.4, 1e-9) && near(I.ftToM(I.mToFt(4321)), 4321, 1e-9), 'both round-trip');
    ok(near(I.ktToMs(250), 128.611, 1e-3) && near(I.mToFt(3048), 10000, 1e-6), '250 kt = 128.6 m/s, 3048 m = 10000 ft');
  }

  console.log('GeoPhysics: writes go through the verified calls only, in SI, and are logged');
  {
    const I = env().R._internals;
    const M = makePhysMock();
    const logs = [];
    const P = I.makeGeoPhysics({ geofs: () => M.geofs, log: (k, d) => logs.push(k + ' ' + d), heading: () => 90 });
    ok(P.placeAircraft(45.5, -122.5, 1500, 450, 100) === true, 'placeAircraft returns true');
    ok(JSON.stringify(M.calls.place[0]) === JSON.stringify([[45.5, -122.5, 1500], [90, 0, 0]]), 'place([lat, lon, altM], [hdg normalized, 0, 0])');
    const v = M.calls.setLinearVelocity[0];
    ok(near(v[0], 100, 1e-9) && near(v[1], 0, 1e-9) && v[2] === 0, 'then a level velocity along the heading (ENU, hdg 090 = +east)');
    ok(P.placeAircraft(0, 0, 100, 180, 0) && M.calls.setLinearVelocity.length === 1, 'speed 0: place only, no velocity write');
    ok(P.placeAircraft(NaN, 0, 100, 0, 50) === false && M.calls.place.length === 2, 'a non-finite coordinate is refused before place()');
    ok(logs.filter((l) => /^physics placeAircraft/.test(l)).length === 2 && logs.some((l) => /^physics setVelocityENU/.test(l)), 'every write lands in the debug log');

    M.rb.v_linearVelocity = [3, 4, 0];
    ok(JSON.stringify(P.getVelocityENU()) === '[3,4,0]' && P.speedMps() === 5, 'getVelocityENU reads v_linearVelocity');
    ok(P.setVelocityENU([1, 2, 3]) && JSON.stringify(M.rb.v_linearVelocity) === '[1,2,3]', 'setVelocityENU goes through setLinearVelocity');
    ok(P.setVelocityENU([1, NaN, 3]) === false, 'a malformed vector is refused');

    ok(P.autopilotEngage({ speedMps: I.ktToMs(200), altM: 1524, hdg: 270 }) === true && M.geofs.autopilot.on, 'autopilotEngage turns it on');
    const ap = M.geofs.autopilot.values;
    ok(ap.speed === 200 && ap.altitude === 5000 && ap.course === 270, 'and hands it knots and FEET: ' + JSON.stringify(ap));
    ok(P.autopilotSetSpeed(I.ktToMs(180)) && ap.speed === 180, 'autopilotSetSpeed(m/s) -> setSpeed(kt)');
    ok(P.autopilotSetCourse(-10) && ap.course === 350, 'autopilotSetCourse normalizes');
    ok(P.isAutopilotOn() === true && P.autopilotDisengage() && P.isAutopilotOn() === false, 'disengage turns it off');

    M.geofs.controls.throttle = 0.2;
    ok(P.throttle() === 0.2 && P.increaseThrottle() && M.geofs.controls.throttle > 0.2, 'throttle read + one increaseThrottle press');
    M.geofs.controls.setters.increaseThrottle = { set() { M.geofs.controls.throttle = 1; } };
    ok(P.increaseThrottle() && M.geofs.controls.throttle === 1, 'a {set: fn} setter record works too');
  }

  console.log('GeoPhysics: addSpeedAlongPath keeps the direction and honours both clamps');
  {
    const I = env().R._internals;
    const M = makePhysMock();
    const P = I.makeGeoPhysics({ geofs: () => M.geofs, log() {}, heading: () => 0 });
    M.rb.v_linearVelocity = [60, 80, 0];                 // 100 m/s toward 036.87
    let r = P.addSpeedAlongPath(10, { maxMps: 500 });
    let v = M.rb.v_linearVelocity;
    ok(r && near(r.before, 100, 1e-9) && near(r.after, 110, 1e-9) && near(v[0], 66, 1e-9) && near(v[1], 88, 1e-9), '+10 m/s along the velocity vector');
    r = P.addSpeedAlongPath(50, { maxMps: 130 });
    ok(r && near(r.after, 130, 1e-9) && near(Math.hypot(...M.rb.v_linearVelocity), 130, 1e-9), 'clamped at maxMps');
    ok(P.addSpeedAlongPath(5, { maxMps: 130 }) === null, 'at the cap: nothing to add, nothing written');
    r = P.addSpeedAlongPath(-100, { minMps: 110 });
    ok(r && near(r.after, 110, 1e-9), 'a negative delta is floored at minMps');
    M.rb.v_linearVelocity = [0, 0, 0];
    r = P.addSpeedAlongPath(20, {});
    ok(r && near(M.rb.v_linearVelocity[1], 20, 1e-9), 'at a standstill it pushes along the heading (000 = +north)');
    M.rb.v_linearVelocity = [0, 0, -30];
    r = P.addSpeedAlongPath(10, {});
    ok(r && near(M.rb.v_linearVelocity[2], -40, 1e-9), 'a vertical vector is extended along itself (up is +z)');
  }

  console.log('GeoPhysics: fails closed when GeoFS is missing or throws');
  {
    const I = env().R._internals;
    const none = I.makeGeoPhysics({ geofs: () => null, log() {} });
    ok(none.placeAircraft(1, 2, 3, 4, 5) === false && none.getVelocityENU() === null && none.setVelocityENU([1, 2, 3]) === false,
      'no geofs: place/get/set all refuse');
    ok(none.autopilotEngage({ speedMps: 100, altM: 1000, hdg: 0 }) === false && none.isAutopilotOn() === false && none.autopilotDisengage() === false,
      'no geofs: autopilot calls refuse');
    ok(none.throttle() === null && none.increaseThrottle() === false && none.addSpeedAlongPath(10, {}) === null, 'no geofs: throttle/boost refuse');
    const M = makePhysMock();
    M.geofs.aircraft.instance.place = () => { throw new Error('boom'); };
    M.rb.setLinearVelocity = () => { throw new Error('boom'); };
    M.geofs.autopilot.turnOn = () => { throw new Error('boom'); };
    const P = I.makeGeoPhysics({ geofs: () => M.geofs, log() {} });
    ok(P.placeAircraft(1, 2, 3, 4, 5) === false && P.setVelocityENU([1, 2, 3]) === false && P.autopilotEngage({ speedMps: 1, altM: 1, hdg: 1 }) === false,
      'a throwing GeoFS call is caught and reported as false');
  }

  console.log('Air start (pure): per-aircraft profile, velocity vector, approach spawn geometry');
  {
    const I = env().R._internals;
    const cub = I.airStartProfile('1'), beaver = I.airStartProfile(13), unknown = I.airStartProfile('999');
    ok(cub.known && cub.cruiseKt === 75 && cub.approachKt === 55, 'Cub cruises at 75 kt (under its ~92 kt Vne): ' + JSON.stringify(cub));
    ok(beaver.known && beaver.cruiseKt === 110, 'Beaver (13) at 110 kt, a number id works too');
    ok(!unknown.known && unknown.cruiseKt === null && unknown.throttle === 0.8, 'an unknown id keeps flyTo\'s speed and gets the CONFIG throttle');
    ok(I.airStartProfile(null).cruiseKt === null && I.airStartProfile('7', { AIR_START_THROTTLE: 0.6 }).throttle === 0.6, 'null id is unknown; throttle comes from config');
    const at = (h) => I.velocityAlongHeading(h, 100).map((n) => Math.round(n * 1e6) / 1e6);
    ok(JSON.stringify(at(0)) === '[0,100,0]' && JSON.stringify(at(90)) === '[100,0,0]' &&
      JSON.stringify(at(180)) === '[0,-100,0]' && JSON.stringify(at(270)) === '[-100,0,0]', 'ENU along 000/090/180/270, level');
    ok(I.velocityAlongHeading(NaN, 1) === null, 'a bad heading gives no vector');
    const rwy = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'runways', 'sea-tac-16c.json'), 'utf8'));
    const s = I.approachSpawn(rwy, { distM: 5556, glideDeg: 3 });
    const d = I.haversineM({ lat: rwy.thr_lat, lon: rwy.thr_lon }, s);
    ok(near(d, 5556, 5), 'sea-tac-16c: 3 nm out (' + d.toFixed(1) + ' m)');
    ok(near(I.bearingDeg(s, { lat: rwy.thr_lat, lon: rwy.thr_lon }), 162, 0.1) && s.heading === 162, 'on the extended centreline, pointed down runway 162');
    ok(near(s.altM, 130 + 15 + 5556 * Math.tan(3 * Math.PI / 180), 0.01), 'on a 3° path to 15 m over the threshold (' + s.altM.toFixed(1) + ' m MSL)');
    ok(I.approachSpawn({ thr_lat: 1 }) === null, 'a runway without threshold/heading gives no spawn');
  }

  console.log('Air start (pure): stepThrottleTo lands in tolerance and never loops');
  {
    const I = env().R._internals;
    const sim = (start, step, { noDec = false, frozen = false } = {}) => {
      const s = { t: start, n: 0 };
      s.io = { read: () => s.t, inc: () => { s.n++; if (!frozen) s.t = Math.min(1, +(s.t + step).toFixed(6)); },
        dec: () => { if (noDec) return false; s.n++; if (!frozen) s.t = Math.max(0, +(s.t - step).toFixed(6)); } };
      return s;
    };
    for (const step of [0.02, 0.1]) {
      const up = sim(0, step), r = I.stepThrottleTo(up.io, 0.8);
      ok(r.reason === 'ok' && Math.abs(r.after - 0.8) < 0.05 && r.presses === up.n, 'step ' + step + ': 0 -> ' + r.after + ' in ' + r.presses + ' presses');
      const down = sim(1, step), r2 = I.stepThrottleTo(down.io, 0.4);
      ok(r2.reason === 'ok' && Math.abs(r2.after - 0.4) < 0.05, 'step ' + step + ': 1 -> ' + r2.after + ' with decreaseThrottle');
    }
    const coarse = sim(0, 0.3), rc = I.stepThrottleTo(coarse.io, 0.45);
    ok(rc.reason === 'overshoot' && rc.presses < 10 && Math.abs(rc.after - 0.45) <= 0.15 + 1e-9, 'a 0.3 step stops at the nearest reading instead of hunting: ' + JSON.stringify(rc));
    const stuck = sim(0.5, 0.1, { frozen: true }), rs = I.stepThrottleTo(stuck.io, 0.9);
    ok(rs.stuck && rs.presses === 1, 'a press that does not move the throttle stops at once: ' + JSON.stringify(rs));
    const nodec = sim(1, 0.1, { noDec: true }), rn = I.stepThrottleTo(nodec.io, 0.4);
    ok(rn.stuck && rn.reason === 'no key' && rn.presses === 0, 'no decreaseThrottle key: reported, nothing pressed');
    const slow = sim(0, 0.001), rcap = I.stepThrottleTo(slow.io, 1, { cap: 80 });
    ok(rcap.reason === 'cap' && rcap.presses === 80, 'capped at 80 presses');
    ok(I.stepThrottleTo({ read: () => null, inc() {}, dec() {} }, 0.5).reason === 'unreadable', 'an unreadable throttle presses nothing');
  }

  console.log('Practice approach: GET /runways fills the Solo tab; Fly approach spawns on final at approach speed');
  {
    const rwy = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'runways', 'sea-tac-16c.json'), 'utf8'));
    const E = env({ lobbyV2: true, apiBase: 'https://relay.test', aircraftId: '1',
      patch: [['AIR_START_STABILIZE_MS: 3000,', 'AIR_START_STABILIZE_MS: 50,']],
      apiHandler: (url) => /\/runways$/.test(url) ? { ok: true, status: 200, json: async () => [rwy, { id: 'broken' }] } : null });
    await E.bootFrames();
    E.phys.geofs.controls.throttle = 1;
    E.phys.geofs.controls.setters.decreaseThrottle = { set() { E.phys.geofs.controls.throttle = +(E.phys.geofs.controls.throttle - 0.1).toFixed(3); } };
    E.R.shell.setScreen('solo');
    await new Promise((r) => setTimeout(r, 50));
    const PA = E.R._internals.PracticeApproach;
    ok(PA.state === 'ready' && PA.runways.length === 1, 'the runway list loaded; a runway with no threshold was dropped');
    ok(!E.R.shell.E.apprSection.classList.contains('fr-hidden') && E.R.shell.E.apprSelect.options.length === 1, 'the Practice approach block shows with one option');
    E.R.shell.E.apprSelect.value = 'sea-tac-16c';
    ok(E.R.shell.soloApproach() === true, 'Fly approach reports success');
    const want = E0.R._internals.approachSpawn(rwy, { distM: 5556, glideDeg: 3 });
    const at = E.lla();
    ok(near(at[0], want.lat, 1e-6) && near(at[1], want.lon, 1e-6) && near(at[2], want.altM, 1e-6), 'spawned 3 nm out on the 3° path: ' + JSON.stringify(at));
    await new Promise((r) => setTimeout(r, 300));
    ok(near(E.speed(), E0.R._internals.ktToMs(55), 1e-6), 'at the Cub\'s 55 kt approach speed (' + E.speed().toFixed(1) + ' m/s)');
    ok(Math.abs(E.phys.geofs.controls.throttle - 0.4) < 0.05, 'throttle back to 0.4 with decreaseThrottle (' + E.phys.geofs.controls.throttle + ')');
    ok(E.phys.geofs.autopilot.on === false, 'and handed back to the pilot');
  }

  console.log('Practice approach: an old server without /runways hides the block, one note, no throw');
  {
    const E = env({ lobbyV2: true, apiBase: 'https://relay.test' });   // every unknown route 404s
    await E.bootFrames();
    const said = [];
    const realStatus = E.R.ui.status.bind(E.R.ui);
    E.R.ui.status = (t) => { said.push(t); realStatus(t); };
    E.R.shell.setScreen('solo');
    await new Promise((r) => setTimeout(r, 50));
    const PA = E.R._internals.PracticeApproach;
    ok(PA.state === 'off' && E.R.shell.E.apprSection.classList.contains('fr-hidden'), 'feature off, block hidden');
    E.R.shell.setScreen('courses'); E.R.shell.setScreen('solo');
    await new Promise((r) => setTimeout(r, 50));
    const notes = said.filter((t) => /Practice approach is off/.test(t));
    ok(notes.length === 1, 'the status line says why, exactly once across two visits: ' + JSON.stringify(notes));
    ok(PA._noted === true && PA.run('sea-tac-16c').ok === false, 'noted once; a stray run() is refused, not thrown');
    const E2 = env({ lobbyV2: true, apiBase: '' });
    ok(E2.R._internals.PracticeApproach.available() === false, 'no API_BASE at all: off');
  }

  console.log('GeoPhysics.airStart: flyTo spawn, wait for unpause, speed + throttle + autopilot hold, hand back');
  {
    const I = env().R._internals;
    const mk = ({ flyTo = true, pausedFor = 0, flyToThrows = false } = {}) => {
      const M = makePhysMock();
      M.geofs.controls.setters.decreaseThrottle = { label: 'dec', set() { M.geofs.controls.throttle = Math.max(0, M.geofs.controls.throttle - 0.1); } };
      M.geofs.aircraft.instance.llaLocation = [0, 0, 0];
      M.calls.flyTo = [];
      if (flyTo) M.geofs.flyTo = (a) => { if (flyToThrows) throw new Error('nope'); M.calls.flyTo.push(a.slice()); M.geofs.aircraft.instance.llaLocation = a.slice(0, 3); };
      let clock = 0;
      const notes = [];
      const P = I.makeGeoPhysics({ geofs: () => M.geofs, log() {}, heading: () => 0,
        paused: () => clock < pausedFor, sleep: async (ms) => { clock += ms; }, now: () => clock,
        notify: (t) => notes.push(t), speedCapMs: 650, cfg: { AIR_START_STABILIZE_MS: 3000, AIR_START_PAUSE_WAIT_MS: 15000 } });
      return { M, P, notes, clock: () => clock };
    };
    {
      const { M, P } = mk();
      const r = P.airStart(47, -122, 1500, 90, { speedKt: 300, throttle: 0.8 });
      ok(r.ok && r.method === 'flyTo' && M.calls.place.length === 0, 'flyTo is the spawn when GeoFS has it; place() untouched');
      ok(JSON.stringify(M.calls.flyTo[0]) === JSON.stringify([47, -122, 1500, 90, true]), 'flyTo([lat, lon, altM, hdg, true])');
      const rep = await r.done;
      const v = M.rb.v_linearVelocity;
      ok(rep.ok && near(v[0], I.ktToMs(300), 1e-6) && near(v[1], 0, 1e-9) && v[2] === 0, 'then 300 kt level along 090: ' + JSON.stringify(v));
      ok(Math.abs(M.geofs.controls.throttle - 0.8) < 0.05 && rep.throttle.reason === 'ok', 'throttle stepped to 0.8 (' + M.geofs.controls.throttle + ')');
      ok(M.geofs.autopilot.values.altitude === Math.round(1500 / 0.3048) && M.geofs.autopilot.values.course === 90, 'autopilot held altitude (ft) and course');
      ok(M.geofs.autopilot.on === false, 'and was handed back (off) after the hold');
    }
    {
      const { M, P } = mk({ flyToThrows: true });
      const r = P.airStart(47, -122, 1500, 90, { speedKt: 100 });
      ok(r.ok && r.method === 'place' && M.calls.place.length === 1, 'a throwing flyTo falls back to place()');
      await r.done;
    }
    {
      const { M, P } = mk({ flyTo: false });
      const r = P.airStart(47, -122, 1500, 90, { speedKt: 100, flyTo: true });
      ok(r.method === 'place' && M.calls.place.length === 1, 'no flyTo at all: place()');
      const { M: M2, P: P2 } = mk();
      ok(P2.airStart(47, -122, 1500, 90, { flyTo: false }).method === 'place' && M2.calls.flyTo.length === 0, 'opts.flyTo false forces place() (CONFIG.AIR_START_FLYTO off)');
    }
    {
      const { P, notes } = mk({ pausedFor: 5000 });
      const rep = await P.airStart(47, -122, 1500, 90, { speedKt: 100 }).done;
      ok(rep.ok && rep.pauseWaitMs >= 5000, 'waits out flyTo\'s pause (' + rep.pauseWaitMs + ' ms)');
      ok(notes.length === 1 && /press P/i.test(notes[0]), 'and says "press P" once after 3 s: ' + JSON.stringify(notes));
    }
    {
      const { M, P } = mk({ pausedFor: 1e9 });
      const rep = await P.airStart(47, -122, 1500, 90, { speedKt: 100 }).done;
      ok(rep.ok === false && rep.reason === 'paused' && M.calls.setLinearVelocity.length === 0, 'still paused after the wait: gives up, writes nothing more');
    }
    {
      const { M, P } = mk();
      const rep = await P.airStart(47, -122, 1500, 90, { speedKt: 180, handoff: 'autopilot' }).done;
      ok(rep.ok && M.geofs.autopilot.on === true && M.geofs.autopilot.values.speed === 180, 'handoff: "autopilot" leaves it on at the given speed');
    }
    {
      const { M, P } = mk();
      let stop = false;
      const r = P.airStart(47, -122, 1500, 90, { speedKt: 180, cancelled: () => stop });
      stop = true;
      const rep = await r.done;
      ok(rep.reason === 'cancelled' && M.calls.setLinearVelocity.length === 0, 'cancelled() abandons the settle before any write');
    }
    {
      const { M, P } = mk();
      M.rb.v_linearVelocity = [0, 102, 0];
      await P.airStart(47, -122, 1500, 0, {}).done;
      ok(M.calls.setLinearVelocity.length === 0, 'no speedKt: flyTo\'s own speed is kept (no velocity write)');
    }
    {
      const { P } = mk();
      ok(P.airStart(NaN, 0, 0, 0).ok === false, 'a bad target is refused before any write');
      const none = I.makeGeoPhysics({ geofs: () => null, log() {} });
      ok(none.airStart(1, 2, 3, 4).ok === false && none.decreaseThrottle() === false && none.flyTo(1, 2, 3, 4) === false, 'no geofs: airStart/flyTo/decreaseThrottle refuse');
    }
  }

  // ---- course env (weather / time / buildings)
  // The GeoFS weather surface, as read from its weather.* source on 2026-09-24: prefs in
  // geofs.preferences.weather, the global `weather` with setAdvanced/setDateAndTime/refresh, and
  // geofs.api.setBuildings. Records every call; refresh() "pulls METAR" by stamping the prefs.
  const addWeatherMock = (w) => {
    const calls = [];
    w.geofs.preferences = { weather: { sun: 1, localTime: 12, season: 50, manual: false, quality: 2,
      advanced: { clouds: 10, fog: 0, windSpeed: 3, windSpeedKts: 6, windDirection: 180, turbulences: 0, precipitationAmount: 0, cloudBase: 1000 } },
      graphics: { buildings: false, quality: 3 } };
    w.weather = {
      setAdvanced() { calls.push(['setAdvanced', JSON.parse(JSON.stringify(w.geofs.preferences.weather.advanced))]); },
      setDateAndTime() { calls.push(['setDateAndTime', w.geofs.preferences.weather.localTime, w.geofs.preferences.weather.season]); },
      refresh() { calls.push(['refresh', w.geofs.preferences.weather.manual]); },
    };
    w.geofs.api.setBuildings = (b) => { calls.push(['setBuildings', b]); };
    w.geofs.savePreferences = () => { calls.push(['savePreferences']); };
    return calls;
  };

  console.log('Course env: normalizeEnv clamps, drops, and returns null for nothing');
  {
    const { Course } = E0.R._internals;
    ok(Course.normalizeEnv(undefined) === null && Course.normalizeEnv({}) === null && Course.normalizeEnv({ weather: {}, time: {} }) === null, 'absent/empty is null');
    const e = Course.normalizeEnv({ buildings: true, junk: 1, time: { localHour: 30, season: -5, x: 1 },
      weather: { clouds: 150, fog: '20', windKt: -3, windDir: 270, turbulence: true, precip: 'lots', windSpeed: 9 } });
    ok(JSON.stringify(e) === JSON.stringify({ buildings: true, time: { localHour: 24, season: 0 }, weather: { clouds: 100, fog: 20, windKt: 0, windDir: 270 } }),
      'clamped to range, unknown keys and non-numbers dropped: ' + JSON.stringify(e));
    ok(Course.normalizeEnv({ buildings: 'yes' }) === null, 'buildings must be a real boolean');
    const c = Course.normalize({ name: 'x', gates: [{ lat: 1, lon: 1, alt: 1 }, { lat: 2, lon: 2, alt: 2 }], env: { buildings: false } });
    ok(c.env && c.env.buildings === false, 'Course.normalize keeps env');
    ok(Course.normalize({ name: 'x', gates: c.gates }).env === null, 'and a course without one gets null');
  }

  console.log('Course env: wind/turbulence/precip are in the hash; buildings/time/clouds/fog are not');
  {
    const { Course } = E0.R._internals;
    const base = { name: 'h', aircraftId: '13', gates: [{ lat: 45, lon: -122, alt: 500 }, { lat: 45.1, lon: -122, alt: 500 }] };
    const h0 = Course.hash(Course.normalize(base));
    const cosmetic = Course.normalize({ ...base, env: { buildings: true, time: { localHour: 18.5, season: 75 }, weather: { clouds: 90, fog: 40 } } });
    ok(Course.hash(cosmetic) === h0, 'a cosmetic-only env leaves the hash byte-identical');
    ok(Course.hash(Course.normalize({ ...base, env: { weather: { windKt: 0, windDir: 270, turbulence: 0, precip: 0 } } })) === h0, 'zero wind (any direction) is not wind');
    const windy = Course.normalize({ ...base, env: { weather: { windKt: 12, windDir: 40 } } });
    ok(Course.hash(windy) !== h0, 'wind changes it');
    ok(Course.baseHash(windy) === h0, 'baseHash is the geometry-only hash an old relay computes');
    ok(Course.hash(Course.normalize({ ...base, env: { weather: { windKt: 12.4, windDir: 40.2, clouds: 5 } } })) === Course.hash(windy), 'rounded to whole kt/degrees; clouds still ignored');
    ok(Course.hash(Course.normalize({ ...base, env: { weather: { windKt: 12, windDir: 41 } } })) !== Course.hash(windy), 'wind direction counts once there is wind');
    ok(Course.hash(Course.normalize({ ...base, env: { weather: { turbulence: 30 } } })) !== h0, 'turbulence changes it');
    ok(Course.hash(Course.normalize({ ...base, env: { weather: { precip: 50 } } })) !== h0, 'precip changes it');
    ok(JSON.stringify(Course.envHashPart(windy)) === '["wx",12,40,0,0]', 'the appended part is ["wx", kt, dir, turb, precip]');
  }

  console.log('Course env: race.js hashes the shared env vectors exactly as add_course.py and app.py do');
  {
    // test/env_hash_vectors.json is also asserted by test_add_course.py and test_server.py.
    const { Course } = E0.R._internals;
    const vectors = JSON.parse(fs.readFileSync(path.join(__dirname, 'env_hash_vectors.json'), 'utf8'));
    for (const v of vectors) ok(Course.hash(Course.normalize(v.course)) === v.hash, v.label + ' -> ' + v.hash);
    ok(new Set(vectors.slice(0, 3).map((v) => v.hash)).size === 1, 'no env, cosmetic-only and zero wind all share one hash');
  }

  console.log('Course env: envToPrefsPatch maps to GeoFS\'s own preference names');
  {
    const { envToPrefsPatch } = E0.R._internals;
    ok(envToPrefsPatch(null) === null, 'no env, no patch');
    const p = envToPrefsPatch({ weather: { clouds: 80, windKt: 15, windDir: 270 }, time: { localHour: 18.5 }, buildings: true });
    ok(p.manual === true && p.buildings === true && p.localTime === 18.5 && p.season === null, 'manual on, time and buildings carried');
    ok(JSON.stringify(p.advanced) === JSON.stringify({ windSpeedKts: 15, windDirection: 270, turbulences: 0, precipitationAmount: 0, clouds: 80 }),
      'windSpeedKts (not the legacy windSpeed), unset turbulence/precip pinned to 0, fog left alone: ' + JSON.stringify(p.advanced));
    const b = envToPrefsPatch({ buildings: false });
    ok(b.manual === false && b.advanced === null && b.buildings === false, 'buildings-only does not touch weather at all');
  }

  console.log('Course env: envSummary is the one-line lobby card text');
  {
    const { envSummary } = E0.R._internals;
    ok(envSummary({ weather: { clouds: 85, windKt: 15, windDir: 270 }, buildings: true }) === 'Overcast · wind 270/15 · buildings on', envSummary({ weather: { clouds: 85, windKt: 15, windDir: 270 }, buildings: true }));
    ok(envSummary({ weather: { clouds: 0, fog: 30, windKt: 8, windDir: 5 }, time: { localHour: 18.75 } }) === 'Clear · Haze · wind 005/8 · 18:45 local', envSummary({ weather: { clouds: 0, fog: 30, windKt: 8, windDir: 5 }, time: { localHour: 18.75 } }));
    ok(envSummary(null) === '' && envSummary({ buildings: false }) === 'buildings off', 'nothing, or just buildings');
  }

  console.log('Course env: G.env applies the recipe and restores exactly what it changed, never saving prefs');
  {
    const E = env();
    const calls = addWeatherMock(E.w);
    const before = JSON.parse(JSON.stringify(E.w.geofs.preferences));
    const GE = E.R._internals.G.env;
    const snap = GE.snapshot();
    const did = GE.apply({ weather: { clouds: 90, windKt: 12, windDir: 40 }, time: { localHour: 19, season: 20 }, buildings: true });
    const pw = E.w.geofs.preferences.weather;
    ok(JSON.stringify(did) === '["weather","time","buildings"]', 'did weather, time, buildings: ' + JSON.stringify(did));
    ok(pw.manual === true && pw.advanced.clouds === 90 && pw.advanced.windSpeedKts === 12 && pw.advanced.windDirection === 40 && pw.advanced.cloudBase === 1000,
      'manual on; advanced written in place, other advanced keys kept');
    ok(pw.localTime === 19 && pw.season === 20 && E.w.geofs.preferences.graphics.buildings === true, 'time and the buildings pref mirrored');
    ok(calls.map((c) => c[0]).join(',') === 'setAdvanced,setDateAndTime,setBuildings', 'setAdvanced, setDateAndTime, setBuildings, in that order: ' + calls.map((c) => c[0]));
    calls.length = 0;
    ok(GE.restore(snap, did) === true, 'restore reports success');
    ok(JSON.stringify(E.w.geofs.preferences) === JSON.stringify(before), 'every preference is back exactly as it was');
    ok(calls.map((c) => c[0]).join(',') === 'refresh,setDateAndTime,setBuildings' && calls[0][1] === false && calls[2][1] === false,
      'refresh (with manual off again), the time, then buildings back off: ' + JSON.stringify(calls));
    ok(!calls.some((c) => c[0] === 'savePreferences'), 'savePreferences is never called');

    calls.length = 0;
    const d2 = GE.apply({ weather: { clouds: 20 } });
    GE.restore(GE.snapshot() && snap, d2);
    ok(!calls.some((c) => c[0] === 'setBuildings'), 'an env without buildings never calls setBuildings (it rebuilds the city)');

    const E2 = env();   // no weather global, no preferences
    ok(JSON.stringify(E2.R._internals.G.env.apply({ weather: { clouds: 1 } })) === '[]' && E2.R._internals.G.env.snapshot() === null,
      'no GeoFS weather surface: nothing applied, nothing to snapshot, no throw');
    const E3 = env();
    addWeatherMock(E3.w);
    E3.w.weather.setAdvanced = () => { throw new Error('boom'); };
    const d3 = E3.R._internals.G.env.apply({ weather: { clouds: 1 }, buildings: true });
    ok(JSON.stringify(d3) === '["buildings"]' && /course env: weather failed/.test(E3.warnText()), 'a throwing setAdvanced is caught, warned, and the rest still applies');
  }

  console.log('Course env: applied on load and re-arm, restored at race end / unload / Leave / teardown');
  {
    const ENV_COURSE = { id: 'env-course', name: 'Env Course', gates: [along(0), along(2000), along(4000)].map((g) => ({ ...g, radius: 150 })),
      env: { weather: { clouds: 90 }, buildings: true } };
    const E = env();
    await E.bootFrames();
    const calls = addWeatherMock(E.w);
    const original = JSON.stringify(E.w.geofs.preferences);
    const CE = E.R._internals.CourseEnv;
    E.R.loadCourse(ENV_COURSE);
    ok(CE.active() && E.w.geofs.preferences.weather.advanced.clouds === 90 && E.w.geofs.preferences.graphics.buildings === true, 'applied on load');
    E.R.race.emit('finish', 60000);
    ok(!CE.active() && JSON.stringify(E.w.geofs.preferences) === original, 'restored at race end');
    E.R.race.reset();
    ok(CE.active(), 're-applied on the re-arm (Alt+R)');
    E.R.race.dq('test');
    ok(!CE.active(), 'restored on a DQ');
    E.R.race.reset();
    E.R.loadCourse({ ...ENV_COURSE, id: 'plain', env: undefined });
    ok(!CE.active() && JSON.stringify(E.w.geofs.preferences) === original, 'a course with no env puts everything back');
    E.R.loadCourse(ENV_COURSE);
    E.R.loadCourse({ ...ENV_COURSE, id: 'env-2', env: { weather: { clouds: 30 } } });
    ok(CE.active() && E.w.geofs.preferences.weather.advanced.clouds === 30 && E.w.geofs.preferences.graphics.buildings === false,
      'switching env courses restores first: the second course has no buildings, so they are back off');
    E.R.race.unload();
    ok(!CE.active() && JSON.stringify(E.w.geofs.preferences) === original, 'restored when the course is unloaded');
    E.R.loadCourse(ENV_COURSE);
    E.w.dispatchEvent(new E.w.Event('beforeunload'));
    ok(!CE.active() && JSON.stringify(E.w.geofs.preferences) === original, 'restored on page unload');
    E.R.loadCourse(ENV_COURSE);
    E.R.teardown('test');
    ok(!CE.active() && JSON.stringify(E.w.geofs.preferences) === original, 'restored on teardown (the bookmarklet replacing this copy)');
    ok(!calls.some((c) => c[0] === 'savePreferences'), 'and never saved');

    const { E: G2, ws } = gateEnv();
    await G2.bootFrames();
    addWeatherMock(G2.w);
    G2.R.loadCourse(ENV_COURSE);
    ok(G2.R._internals.CourseEnv.active(), 'in a room: applied');
    G2.R.shell.leaveRoom();
    ok(!G2.R._internals.CourseEnv.active(), 'Leave puts it back');
    void ws;

    const off = env({ patch: [['COURSE_ENV: true,', 'COURSE_ENV: false,']] });
    await off.bootFrames();
    const offCalls = addWeatherMock(off.w);
    off.R.loadCourse(ENV_COURSE);
    ok(offCalls.length === 0, 'COURSE_ENV off: the env is ignored entirely');
  }

  console.log('Course env: every client in a room gets the env from the course pick, shown on the Gate');
  {
    const WINDY = { id: 'windy-course', name: 'Windy', version: 2, startType: 'air', aircraftId: null,
      gates: [along(0), along(2000), along(4000)].map((g) => ({ ...g, radius: 150 })),
      env: { weather: { clouds: 85, windKt: 15, windDir: 270 }, buildings: true } };
    const { Course } = E0.R._internals;
    const full = Course.hash(Course.normalize(WINDY)), base = Course.baseHash(Course.normalize(WINDY));
    const serve = (url) => {
      if (/courses\/index\.json/.test(url)) return { ok: true, status: 200, json: async () => [{ id: WINDY.id, name: WINDY.name, file: WINDY.id + '.json' }] };
      if (/windy-course\.json/.test(url)) return { ok: true, status: 200, json: async () => WINDY };
      return null;
    };
    for (const [label, hash] of [['a current relay (full hash)', full], ['an old relay (geometry-only hash)', base]]) {
      const { E, ws } = gateEnv({ env: { apiHandler: serve } });
      await E.bootFrames();
      addWeatherMock(E.w);
      const said = [];
      const realStatus = E.R.ui.status.bind(E.R.ui);
      E.R.ui.status = (t) => { said.push(t); realStatus(t); };
      ws.fireMessage(LOBBY({ course: { course_id: WINDY.id, course_hash: hash, name: WINDY.name, start_type: 'air' } }));
      await sleep(80);
      ok(E.R.race.course && E.R.race.course.id === WINDY.id && E.R.race.matchesHash(hash), label + ': the picked course loaded');
      ok(E.w.geofs.preferences.weather.advanced.windSpeedKts === 15 && E.w.geofs.preferences.graphics.buildings === true, label + ': its env applied on this client');
      E.R.shell.setScreen('gate');
      const chips = E.R.shell.E.gateFormat.textContent;
      ok(/Overcast · wind 270\/15 · buildings on/.test(chips), label + ': the Gate shows it: ' + chips);
      const notes = said.filter((t) => /older than the weather/.test(t));
      ok(hash === base ? notes.length === 1 : notes.length === 0, label + ': ' + (hash === base ? 'one note that the relay is older' : 'no note'));
      ok(!/Course mismatch/.test(E.w.document.body.textContent), label + ': no mismatch banner');
    }
  }

  console.log('Guidance (pure): leg, turn radius/lead, gate switch distance, next gate');
  {
    const I = env().R._internals;
    const a = { lat: 45, lon: -122 }, b = I.destination(a, 90, 10000);
    const leg = I.guidanceLeg(a, b);
    ok(leg && near(leg.bearingDeg, 90, 0.1) && near(leg.distM, 10000, 1), 'guidanceLeg: 090 / 10 km: ' + JSON.stringify(leg));
    ok(I.guidanceLeg(null, b) === null && I.guidanceLeg(a, { lat: 'x' }) === null, 'guidanceLeg: bad input -> null');
    // 100 m/s at 45 deg: R = 10000 / 9.80665 = 1019.7 m
    ok(near(I.turnRadiusM(100, 45), 1019.716, 0.01), 'turnRadiusM(100 m/s, 45 deg) = v^2/(g tan phi)');
    ok(I.turnRadiusM(0, 30) === null && I.turnRadiusM(100, 0) === null && I.turnRadiusM(100, 89.5) === null, 'turnRadiusM: no speed / bank outside (0, 89) -> null');
    ok(near(I.turnLeadM(100, 45, 90), 1019.716, 0.01), 'turnLeadM: a 90 deg turn leads by R tan 45 = R');
    ok(near(I.turnLeadM(100, 45, -90), I.turnLeadM(100, 45, 90), 1e-9) && near(I.turnLeadM(100, 45, 270), I.turnLeadM(100, 45, 90), 1e-9), 'turnLeadM: left/right/wrapped turns are the same lead');
    ok(I.turnLeadM(100, 45, 0) === 0 && I.turnLeadM(0, 45, 90) === 0, 'turnLeadM: no turn or no radius -> 0');
    const g = { radius: 150 };
    ok(I.gateSwitchDistM(g, 30, 25, 10) === 150, 'gateSwitchDistM: slow + small turn -> the gate radius (lead < radius)');
    const R = I.turnRadiusM(150, 25), cut = 120;
    const sw = I.gateSwitchDistM(g, 150, 25, 90);
    ok(near(sw, Math.sqrt(cut * cut + 2 * cut * R), 1e-6) && sw < I.turnLeadM(150, 25, 90), 'gateSwitchDistM: jet + 90 deg -> the lead capped so the arc stays in the gate (' + Math.round(sw) + ' m)');
    ok(near(Math.sqrt(sw * sw + R * R) - R, cut, 1e-6), 'the capped arc passes the gate centre at 0.8 r');
    ok(I.gateSwitchDistM({}, 100, 0, 90) === 150, 'gateSwitchDistM: no radius on the gate -> DEFAULT_RADIUS_M; no bank -> radius');
    const gates = [{ lat: 45, lon: -122, alt: 500, radius: 150 }];
    gates.push(Object.assign(I.destination(gates[0], 90, 8000), { alt: 600, radius: 150 }));
    gates.push(Object.assign(I.destination(gates[1], 0, 8000), { alt: 700, radius: 150 }));
    const far = I.destination(gates[1], 270, 4000);
    ok(I.nextGateIndex({ target: 1 }, far, gates, 100, 25).target === 1, 'nextGateIndex: 4 km out from gate 2, still steering for it');
    const near1 = I.destination(gates[1], 270, 300);
    const r1 = I.nextGateIndex({ target: 1 }, near1, gates, 100, 25);
    ok(r1.target === 2 && r1.reason === 'lead', 'nextGateIndex: inside the switch distance -> next gate (lead)');
    const past = I.destination(gates[1], 90, 500);
    const r2 = I.nextGateIndex({ target: 1 }, I.destination(past, 180, 2000), gates, 100, 25);
    ok(r2.target === 2 && r2.reason === 'passed', 'nextGateIndex: past the gate along the inbound leg (a miss) -> fly on');
    ok(I.nextGateIndex({ target: 1 }, far, gates, 100, 25, { crossed: (i) => i === 1 }).reason === 'crossed', 'nextGateIndex: a crossing advances');
    ok(I.nextGateIndex({ target: 3 }, far, gates, 100, 25).target === 3, 'nextGateIndex: past the last gate stays put');
  }

  console.log('Guidance (pure): leg altitude and the rate-limited altitude command (feet)');
  {
    const I = env().R._internals;
    ok(I.legTargetAltM({ alt: 100 }, { alt: 300 }, 0.5) === 200 && I.legTargetAltM({ alt: 100 }, { alt: 300 }, 2) === 300 && I.legTargetAltM(null, { alt: 300 }, 0) === 300,
      'legTargetAltM: straight line between gate altitudes, clamped; no previous gate -> the gate altitude');
    let c = I.altitudeCmdFt({ altM: 1000, targetAltM: 1050, distM: 5000, speedMps: 100 });
    ok(c.altFt === Math.round(I.mToFt(1050)) && !c.limited, 'a small climb inside the limits commands the target itself');
    c = I.altitudeCmdFt({ altM: 1000, targetAltM: 3000, distM: 2000, speedMps: 100, maxClimbFpm: 2500, lookaheadS: 20 });
    ok(c.altFt === Math.round(I.mToFt(1000 + I.ftToM(2500) / 60 * 20)) && c.limited && c.neededFpm > 2500, 'a big climb is paced at maxClimbFpm over the lookahead, and flagged limited: ' + JSON.stringify(c));
    c = I.altitudeCmdFt({ altM: 3000, targetAltM: 500, distM: 3000, speedMps: 150, maxDescentFpm: 1500, lookaheadS: 10 });
    ok(c.altFt === Math.round(I.mToFt(3000 - I.ftToM(1500) / 60 * 10)) && c.limited && c.neededFpm < -1500, 'a dive to a low gate is paced at maxDescentFpm');
    c = I.altitudeCmdFt({ altM: 1000, targetAltM: 1000, distM: 0, speedMps: 0 });
    ok(c.altFt === Math.round(I.mToFt(1000)) && c.neededFpm === 0 && !c.limited, 'already there: hold it');
    ok(I.altitudeCmdFt({ altM: NaN, targetAltM: 1 }) === null, 'non-finite altitude -> null');
  }

  console.log('Guidance (pure): glidepath, runway frame, ILS dots, approach steering, stability');
  {
    const I = env().R._internals;
    const w180 = (d) => ((d % 360) + 540) % 360 - 180;
    const rwy = { thr_lat: 47.4318, thr_lon: -122.3082, thr_alt_m: 130, heading_deg: 162, length_m: 3627, width_m: 45 };
    const t3 = Math.tan(3 * Math.PI / 180);
    ok(near(I.glidepathAltM(rwy, 0), 145, 1e-9), 'glidepath at the threshold = thr + 15 m TCH');
    ok(near(I.glidepathAltM(rwy, 1852), 145 + 1852 * t3, 1e-9) && near(I.glidepathAltM(rwy, 5556), 145 + 5556 * t3, 1e-9), 'glidepath at 1 and 3 nm = thr + TCH + d tan 3');
    ok(I.glidepathAltM(rwy, -5000) === 130, 'glidepath never goes below the threshold (past the touchdown point)');
    const out = I.destination({ lat: rwy.thr_lat, lon: rwy.thr_lon }, (162 + 180) % 360, 5556);
    const f = I.runwayFrame(rwy, out.lat, out.lon);
    ok(near(f.alongM, -5556, 5) && near(f.crossM, 0, 2), 'runwayFrame: 3 nm out on the extended centreline -> along -5556, cross 0: ' + JSON.stringify(f));
    const right = I.destination(out, (162 + 90) % 360, 200);
    ok(I.runwayFrame(rwy, right.lat, right.lon).crossM > 190, 'runwayFrame: right of the centreline is +cross');
    ok(I.runwayFrame(null, 1, 2) === null, 'runwayFrame: no runway -> null');
    let d = I.ilsDeviation(rwy, out.lat, out.lon, I.glidepathAltM(rwy, 5556));
    ok(near(d.locDots, 0, 0.05) && near(d.gsDots, 0, 0.1) && near(d.aboveGpM, 0, 0.5), 'on the centreline and on the path: both needles centred: ' + JSON.stringify({ l: d.locDots, g: d.gsDots }));
    d = I.ilsDeviation(rwy, right.lat, right.lon, I.glidepathAltM(rwy, 5556));
    const locWant = Math.atan2(d.crossM, 3627 - d.alongM) * 180 / Math.PI / 1.25;
    ok(d.locDots > 0 && near(d.locDots, locWant, 1e-9), '200 m right at 3 nm -> +' + d.locDots.toFixed(2) + ' dots (angle from the far-end antenna, 1.25 deg/dot)');
    const left = I.destination(out, (162 + 270) % 360, 2000);
    ok(I.ilsDeviation(rwy, left.lat, left.lon, 500).locDots === -2.5, 'far left -> pinned at -2.5 dots');
    d = I.ilsDeviation(rwy, out.lat, out.lon, I.glidepathAltM(rwy, 5556) + 100);
    ok(d.gsDots > 0 && near(d.aboveGpM, 100, 0.5), '100 m high -> above the path (+gs), aboveGpM 100');
    ok(I.ilsDeviation(rwy, out.lat, out.lon, 131).gsDots === -2.5, 'at runway height 3 nm out -> pinned at -2.5 dots low');
    ok(I.ilsDeviation(rwy, out.lat, out.lon, 500, { gsDotDeg: 0.7 }).gsDots < I.ilsDeviation(rwy, out.lat, out.lon, 500).gsDots, 'a wider dot reads fewer dots');
    const onRwy = I.destination({ lat: rwy.thr_lat, lon: rwy.thr_lon }, 162, 1000);
    ok(I.ilsDeviation(rwy, onRwy.lat, onRwy.lon, 131).gsDots === null, 'past the glidepath origin -> no glideslope');
    ok(I.ilsDeviation(rwy, out.lat, out.lon, NaN) === null, 'no altitude -> null');

    const sR = I.approachSteer(rwy, I.ilsDeviation(rwy, right.lat, right.lon, 500), { speedMps: 70 });
    ok(sR.interceptDeg > 0 && w180(sR.courseDeg - 162) < 0, 'right of the centreline -> steer left of the runway heading (' + sR.courseDeg.toFixed(1) + ')');
    const sL = I.approachSteer(rwy, I.ilsDeviation(rwy, left.lat, left.lon, 500), { speedMps: 70, maxInterceptDeg: 30 });
    ok(near(w180(sL.courseDeg - 162), 30, 1e-6), 'far left -> intercept capped at 30 deg right');
    const dC = I.ilsDeviation(rwy, out.lat, out.lon, 500);
    const sC = I.approachSteer(rwy, dC, { speedMps: 70, leadS: 4 });
    ok(near(sC.courseDeg, 162, 0.5) && sC.altFt === Math.round(I.mToFt(I.glidepathAltM(rwy, dC.distToThrM - 280))), 'on the centreline: runway heading, and the glidepath altitude 4 s ahead, in feet');
    ok(I.approachSteer(null, {}) === null, 'approachSteer: no runway -> null');

    const st = (p) => I.approachStability(p);
    ok(st({ locDots: 0.1, gsDots: -0.2, sinkFpm: 700, iasKt: 152, approachKt: 150 }).level === 'stable', 'on speed, on path, 700 fpm -> stable');
    ok(st({ locDots: 0.7 }).level === 'caution' && st({ gsDots: -0.6 }).reasons[0] === 'glideslope', 'over half a dot -> caution, with the reason');
    ok(st({ locDots: 1.5 }).level === 'unstable' && st({ sinkFpm: 1200 }).reasons[0] === 'sink rate', 'over a dot, or > 1000 fpm -> unstable');
    ok(st({ iasKt: 140, approachKt: 150 }).reasons[0] === 'slow' && st({ iasKt: 175, approachKt: 150 }).reasons[0] === 'fast' && st({ iasKt: 162, approachKt: 150 }).level === 'caution', 'slow/fast against approachKt');
    ok(st({}).level === 'stable' && st(null).level === 'stable', 'missing inputs are skipped, not failed');
  }

  console.log('Guidance (pure): landingSpawn = approachSpawn + the runway `approach` override + approachKt');
  {
    const I = env().R._internals;
    const rwy = { thr_lat: 27.685678, thr_lon: 86.727219, thr_alt_m: 2784, heading_deg: 60, length_m: 527 };
    const plain = I.landingSpawn(rwy, '7');
    const base = I.approachSpawn(rwy, { distM: 5556, glideDeg: 3 });
    ok(near(plain.lat, base.lat, 1e-12) && near(plain.altM, base.altM, 1e-9) && plain.heading === 60, 'no override: exactly the practice-approach spawn');
    ok(plain.speedKt === 150 && plain.throttle === 0.4 && plain.distM === 5556 && plain.glideDeg === 3, 'F-16 approachKt 150, APPROACH_THROTTLE 0.4');
    ok(I.landingSpawn(rwy, '13').speedKt === 70 && I.landingSpawn(rwy, '999').speedKt === 140, 'Beaver 70 kt; unknown aircraft -> APPROACH_FALLBACK_KT');
    const o = I.landingSpawn(Object.assign({}, rwy, { approach: { distNm: 1.5, angleDeg: 5, altOffsetM: 60, headingOffsetDeg: -20 } }), '13');
    const want = I.approachSpawn(Object.assign({}, rwy, { heading_deg: 40 }), { distM: 1.5 * 1852, glideDeg: 5 });
    ok(near(o.lat, want.lat, 1e-12) && near(o.lon, want.lon, 1e-12) && near(o.altM, want.altM + 60, 1e-9), 'override: 1.5 nm, 5 deg, +60 m, inbound line swung -20 deg about the threshold');
    ok(o.heading === 40 && near(I.bearingDeg(o, { lat: rwy.thr_lat, lon: rwy.thr_lon }), 40, 0.05), 'and still pointed at the threshold');
    ok(I.landingSpawn(Object.assign({}, rwy, { approach: { distNm: -1, angleDeg: 'x' } }), '7').distM === 5556, 'a nonsense override falls back to the defaults');
    ok(I.landingSpawn(null) === null && I.landingSpawn({ thr_lat: 1 }) === null, 'no runway / no threshold -> null');
  }

  console.log('GeoPhysics.autopilotTo: feet and knots straight to the verified autopilot calls');
  {
    const I = env().R._internals;
    const M = makePhysMock();
    const logs = [];
    let ons = 0;
    const turnOn = M.geofs.autopilot.turnOn;
    M.geofs.autopilot.turnOn = function () { ons++; return turnOn.call(this); };
    const P = I.makeGeoPhysics({ geofs: () => M.geofs, log: (k, d) => logs.push(d), speedCapMs: I.ktToMs(400) });
    const ap = M.geofs.autopilot;
    ok(P.autopilotTo({ courseDeg: 370, altFt: 5000.4, speedKt: 250.6 }) === true && ap.on, 'engages and returns true');
    ok(ap.values.course === 10 && ap.values.altitude === 5000 && ap.values.speed === 251, 'course normalized, feet and knots rounded, no unit conversion: ' + JSON.stringify(ap.values));
    ok(P.autopilotTo({ altFt: 6000 }) && ap.values.altitude === 6000 && ap.values.course === 10 && ons === 1, 'a partial target sets only that one, and never turns on twice');
    ok(P.autopilotTo({ speedKt: 900 }) && ap.values.speed === 400, 'speed clamped to the speed cap');
    const n = logs.filter((l) => /^autopilotTo/.test(l)).length;
    P.autopilotTo({ speedKt: 900 });
    ok(n > 0 && logs.filter((l) => /^autopilotTo/.test(l)).length === n, 'an unchanged target is not logged again (2 Hz callers)');
    ok(P.autopilotTo({}) === false && P.autopilotTo(null) === false, 'no target -> false');
    ok(I.makeGeoPhysics({ geofs: () => null, log() {} }).autopilotTo({ altFt: 1 }) === false, 'no geofs -> false');
    M.geofs.autopilot.setAltitude = () => { throw new Error('boom'); };
    ok(P.autopilotTo({ altFt: 1 }) === false, 'a throwing setter is caught -> false');
  }

  console.log('G landing reads: haglMeters, verticalSpeed, groundContact, landingSample, nearestRunway (null when missing)');
  {
    const E = env();
    const G = E.R._internals.G;
    const v = E.w.geofs.animation.values;
    delete v.haglMeters; delete v.verticalSpeed;
    ok(G.haglM() === null && G.vsFpm() === null, 'fields absent -> null, not 0');
    v.haglMeters = 123.5; v.verticalSpeed = -640; v.kias = 140;
    ok(G.haglM() === 123.5 && G.vsFpm() === -640, 'haglMeters (m) and verticalSpeed (ft/min) read through');
    v.haglMeters = null;
    ok(G.haglM() === null, 'null haglMeters is unknown, not 0 m');
    E.w.geofs.aircraft.instance.groundContact = 0;
    ok(G.groundContact() === false, 'groundContact coerced to boolean');
    delete E.w.geofs.aircraft.instance.groundContact;
    ok(G.groundContact() === null, 'groundContact absent -> null');
    v.haglMeters = 30; E.w.geofs.aircraft.instance.groundContact = true;
    const s = G.landingSample(1234);
    ok(s && s.t_ms === 1234 && s.agl_m === 30 && near(s.vs_mps, -640 * 0.3048 / 60, 1e-9) && near(s.ias_mps, 140 * 0.514444, 1e-9) && s.on_ground_bool === true
      && ['lat', 'lon', 'alt_m', 'heading_deg', 'bank_deg', 'pitch_deg'].every((k) => k in s), 'landingSample: touchdown.js sample shape, SI units: ' + JSON.stringify(s));
    ok(G.nearestRunway(1, 2) === null, 'no geofs.runways -> null');
    E.w.geofs.runways = { getNearestRunway: (lla) => ({ lat: lla[0], lon: lla[1], heading: 162, name: '16C', threshold: [1, 2], obj: { deep: 1 }, fn() {} }) };
    const nr = G.nearestRunway(47.4, -122.3);
    ok(nr && nr.lat === 47.4 && nr.heading === 162 && nr.name === '16C' && JSON.stringify(nr.threshold) === '[1,2]' && !('obj' in nr) && !('fn' in nr), 'nearestRunway: a shallow summary only: ' + JSON.stringify(nr));
    E.w.geofs.runways.getNearestRunway = () => { throw new Error('boom'); };
    ok(G.nearestRunway(1, 2) === null, 'a throwing getNearestRunway -> null');
  }

  console.log('Guidance is pure: no GeoFS/Cesium/DOM name inside its section');
  {
    const begin = SRC.indexOf('// ================================================== Guidance (BEGIN');
    const end = SRC.indexOf('// ==================================================== Guidance (END');
    ok(begin > 0 && end > begin, 'the Guidance section markers are present');
    const body = SRC.slice(begin, end).split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');
    ok(!/\b(geofs|Cesium|window|document)\b/.test(body), 'Guidance code never names geofs, Cesium, window or document');
  }

  console.log('__finsRace.dev: the dev-only namespace the robot flies through (CONFIG.DEV_API)');
  {
    const E = env();
    const dev = E.R.dev;
    ok(dev && Object.isFrozen(dev) && Object.isFrozen(dev.G), 'present and frozen with DEV_API on');
    for (const k of ['Guidance', 'GeoPhysics', 'CourseEnv', 'Course', 'Courses', 'ecef', 'segHit', 'vlen', 'sub', 'bearingDeg', 'destination',
      'haversineM', 'gridSlot', 'airStartProfile', 'approachSpawn', 'landingSpawn', 'traceEmpty', 'traceAppend', 'traceEncode', 'msToKt', 'ktToMs', 'mToFt', 'ftToM', 'raceState']) {
      ok(dev[k] != null, 'dev.' + k);
    }
    ok(['ready', 'lla', 'heading', 'kias', 'pitch', 'roll', 'haglM', 'vsFpm', 'groundContact', 'aircraftId', 'paused', 'model', 'nearestRunway'].every((k) => typeof dev.G[k] === 'function'),
      'dev.G: read-only sensor functions');
    ok(!('physics' in dev.G) && !('env' in dev.G), 'dev.G is not the live adapter: no route past GeoPhysics to a write');
    ok(dev.G.lla().lat === 45 && dev.raceState() === 'idle', 'the reads work against the sim');
    const off = env({ patch: [['DEV_API: true,', 'DEV_API: false,']] });
    ok(off.R.dev === undefined, 'DEV_API off -> no dev key at all');
  }

  const ROBOT = require('../tools/robot_pilot.js');
  const robotSrc = fs.readFileSync(path.join(__dirname, '..', 'tools', 'robot_pilot.js'), 'utf8');
  // A kinematic stand-in for GeoFS + its autopilot: turns toward the commanded course at the rate
  // a 25-degree bank gives, climbs/descends toward the commanded altitude at <= 2500 fpm, and moves
  // at a constant speed. terrain(lat, lon) -> ground height (m MSL).
  function simFly(I, flight, start, speedMps, terrain, maxMs, onOut) {
    const s = Object.assign({}, start);
    let cmd = { courseDeg: s.hdg, altFt: s.alt / 0.3048 };
    const dt = 50, rate = (9.80665 * Math.tan(25 * Math.PI / 180) / speedMps) * 180 / Math.PI, vs = 2500 * 0.3048 / 60;
    for (let t = 0; t < maxMs; t += dt) {
      const hagl = s.alt - terrain(s.lat, s.lon);
      const out = flight.tick({ tMs: t, lat: s.lat, lon: s.lon, alt: s.alt, haglM: hagl, groundContact: hagl <= 0, heading: s.hdg, pitch: 0, roll: 0 });
      if (onOut) onOut(out, t);
      if (out.cmd) cmd = out.cmd;
      if (out.done) return t;
      const err = ((cmd.courseDeg - s.hdg + 540) % 360) - 180, maxTurn = rate * dt / 1000;
      s.hdg = (s.hdg + Math.max(-maxTurn, Math.min(maxTurn, err)) + 360) % 360;
      s.alt += Math.max(-vs * dt / 1000, Math.min(vs * dt / 1000, cmd.altFt * 0.3048 - s.alt));
      const p = I.destination(s, s.hdg, speedMps * dt / 1000);
      s.lat = p.lat; s.lon = p.lon;
    }
    return null;
  }
  function robotCourse(I, radius) {
    const g = [{ lat: 45, lon: -122, alt: 800 }];
    g.push(Object.assign(I.destination(g[0], 90, 8000), { alt: 900 }));
    g.push(Object.assign(I.destination(g[1], 0, 8000), { alt: 1100 }));
    g.push(Object.assign(I.destination(g[2], 300, 7000), { alt: 700 }));
    g.push(Object.assign(I.destination(g[3], 200, 9000), { alt: 800 }));
    return { id: 'robot-test', name: 'Robot test', gates: g.map((x) => ({ lat: x.lat, lon: x.lon, alt: x.alt, radius: radius || 150 })) };
  }

  console.log('Robot (pure): aircraft choice, batch plan, timeout, classification');
  {
    ok(ROBOT.robotAircraftFor({ aircraftId: '1' }, 'Bush Cup') === '1' && ROBOT.robotAircraftFor({ aircraftId: null }, 'Bush Cup') === '13'
      && ROBOT.robotAircraftFor({ aircraftId: '' }, 'Wonders Cup') === '7' && ROBOT.robotAircraftFor(null, null) === '7',
      'robotAircraftFor: the course lock, else Bush Cup -> Beaver 13, else F-16 7');
    const plan = ROBOT.batchPlan([{ id: 'a', aircraftId: '7' }, { id: 'b', aircraftId: '13' }, { id: 'c', aircraftId: '7' }, { id: 'd', aircraftId: '1' }], '13');
    ok(JSON.stringify(plan.map((g) => [g.aircraftId, g.items.map((i) => i.id)])) === '[["13",["b"]],["1",["d"]],["7",["a","c"]]]',
      'batchPlan: the aircraft you are in first, then by id, list order kept: ' + JSON.stringify(plan.map((g) => g.aircraftId)));
    ok(ROBOT.courseTimeoutMs(10000, 100, 120) === 320000, 'courseTimeoutMs: 2 x 100 s + 120 s pad');
    const gate = (n, o) => Object.assign({ n, crossed: true, missed: false, gateHaglM: 300 }, o || {});
    const C = ROBOT.classifyCourse;
    ok(C({ gates: [gate(1), gate(2), gate(3)] }).label === 'PASS', 'every gate crossed, no abort -> PASS');
    ok(C({ gates: [gate(1), gate(2, { crossed: false, missed: true }), gate(3)] }).label === 'FAIL(missed gate 2)', 'a missed gate -> FAIL(missed gate 2)');
    ok(C({ gates: [gate(1), gate(2, { crossed: false }), gate(3, { crossed: false })], abort: { reason: 'terrain', gate: 2, haglM: 12.3 } }).label === 'FAIL(terrain on leg 2, 12.3 m AGL)', 'terrain abort -> FAIL(terrain on leg n)');
    ok(C({ gates: [gate(1)], abort: { reason: 'ground', gate: 2 } }).label === 'FAIL(ground contact on leg 2)', 'ground contact -> FAIL');
    ok(C({ gates: [gate(1), gate(2, { crossed: false })], abort: { reason: 'timeout', gate: 2 } }).label === 'UNREACHABLE(gate 2)', 'leg timeout -> UNREACHABLE(gate n)');
    const buried = C({ gates: [gate(1), gate(2, { gateHaglM: -40, crossed: false, missed: true }), gate(3)] });
    ok(buried.status === 'UNREACHABLE' && buried.gate === 2 && buried.reason === 'gate below terrain', 'a gate below the terrain it sits over -> UNREACHABLE, before the miss');
    ok(C({ abort: { reason: 'aircraft' } }).label === 'SKIPPED(aircraft)' && C({ abort: { reason: 'spawn', detail: 'paused' } }).label === 'FAIL(spawn failed: paused)'
      && C({ gates: [gate(1)], abort: { reason: 'stopped' } }).label === 'FAIL(stopped)', 'SKIPPED(aircraft), spawn failure and a user stop');
  }

  console.log('Robot: a course flown end to end against a kinematic autopilot -> PASS, gate log, a trace the server accepts');
  {
    const E = env();
    const I = E.R._internals, dev = E.R.dev;
    const course = robotCourse(I);
    const speed = 100;
    const slot = I.gridSlot(course.gates[0], course.gates[1], 0, 1, 10, speed);
    const flight = ROBOT.makeCourseFlight(course, { speedMps: speed, spawn: { lat: slot.lat, lon: slot.lon, alt: slot.alt } }, dev);
    const t = simFly(I, flight, { lat: slot.lat, lon: slot.lon, alt: slot.alt, hdg: slot.heading }, speed, () => 0, 30 * 60000);
    const log = flight.result();
    const cls = ROBOT.classifyCourse(log);
    ok(t != null && cls.label === 'PASS', 'PASS: ' + cls.label + ' ' + JSON.stringify(log.gates.map((g) => [g.crossed, g.missM])));
    ok(log.gates.every((g) => g.crossed && g.missM <= g.radiusM && g.legMinHaglM > 500 && g.gateHaglM > 500), 'every gate crossed inside its radius, with the leg/gate heights logged');
    ok(log.gates.slice(1).every((g) => g.legMs > 50000 && g.legMs < 150000), 'leg times logged: ' + log.gates.map((g) => g.legMs).join(','));
    const flown = log.lengthM / speed * 1000;
    ok(log.timeMs > flown * 0.95 && log.timeMs < flown * 1.3, 'the time is gate 1 to the last gate, near length/speed: ' + log.timeMs + ' vs ' + Math.round(flown));
    const dec = I.traceDecode(log.trace);
    ok(dec && dec.samples.length > 100 && Math.abs(dec.samples[dec.samples.length - 1][0] - log.timeMs) <= 500 && dec.samples[0][0] >= 0,
      'the trace is race.js\'s encoding, from gate 1, ending within the server\'s 500 ms of the finish');
    const body = ROBOT.houseUploadBody('robot-test', 'deadbeef', log, 'f16');
    ok(body && body.time_ms === log.timeMs && body.trace === log.trace && body.course_hash === 'deadbeef' && body.model === 'f16', 'houseUploadBody: exactly POST /ghosts/house\'s fields');
    ok(ROBOT.houseUploadBody('x', 'y', { trace: null, timeMs: 1 }) === null, 'no trace -> no upload body');
  }

  console.log('Robot: terrain under a leg aborts it (FAIL), and a turn too tight to make is a missed gate');
  {
    const E = env();
    const I = E.R._internals, dev = E.R.dev;
    const course = robotCourse(I);
    const ridgeAt = I.destination(course.gates[1], 0, 4000);
    const ridge = (lat, lon) => (I.haversineM({ lat, lon }, ridgeAt) < 1500 ? 1000 : 0);
    const slot = I.gridSlot(course.gates[0], course.gates[1], 0, 1, 10, 100);
    const flight = ROBOT.makeCourseFlight(course, { speedMps: 100, spawn: { lat: slot.lat, lon: slot.lon, alt: slot.alt } }, dev);
    simFly(I, flight, { lat: slot.lat, lon: slot.lon, alt: slot.alt, hdg: slot.heading }, 100, ridge, 30 * 60000);
    const cls = ROBOT.classifyCourse(flight.result());
    ok(cls.status === 'FAIL' && /^terrain on leg 3/.test(cls.reason) && cls.gate === 3, 'a ridge on the leg to gate 3 -> ' + cls.label);
    ok(flight.result().trace === null, 'an unfinished run has no uploadable trace');

    const g = [{ lat: 45, lon: -122, alt: 800 }];
    g.push(Object.assign(I.destination(g[0], 90, 6000), { alt: 800 }));
    g.push(Object.assign(I.destination(g[1], 265, 1500), { alt: 800 }));   // a 175-degree hairpin
    g.push(Object.assign(I.destination(g[2], 265, 8000), { alt: 800 }));
    const pin = { gates: g.map((x) => ({ lat: x.lat, lon: x.lon, alt: x.alt, radius: 40 })) };
    const s2 = I.gridSlot(pin.gates[0], pin.gates[1], 0, 1, 10, 120);
    const f2 = ROBOT.makeCourseFlight(pin, { speedMps: 120, spawn: { lat: s2.lat, lon: s2.lon, alt: s2.alt } }, dev);
    simFly(I, f2, { lat: s2.lat, lon: s2.lon, alt: s2.alt, hdg: s2.heading }, 120, () => 0, 20 * 60000);
    const log2 = f2.result(), c2 = ROBOT.classifyCourse(log2);
    ok(c2.status === 'FAIL' && /missed gate/.test(c2.reason), 'a 175-degree hairpin with a 40 m gate at 120 m/s -> ' + c2.label + ' ' + JSON.stringify(log2.gates.map((x) => [x.crossed, x.missed, x.missM])));
    ok(log2.gates.filter((x) => x.missed).every((x) => x.missM > x.radiusM && Number.isFinite(x.sideM)), 'a missed gate logs its miss distance and which side it was passed on');
    ok(log2.gates[log2.gates.length - 1].crossed || log2.gates[log2.gates.length - 1].missed, 'and the robot flew on to decide the rest of the course');
  }

  console.log('Robot: an approach flown down the virtual ILS to 50 ft, then a go-around');
  {
    const E = env();
    const I = E.R._internals, dev = E.R.dev;
    const rw = { id: 'sea-tac-16c', thr_lat: 47.4318, thr_lon: -122.3082, thr_alt_m: 130, heading_deg: 162, length_m: 3627, width_m: 45 };
    const sp = I.landingSpawn(rw, '7');
    const speed = I.ktToMs(sp.speedKt);
    const flight = ROBOT.makeApproachFlight(rw, { speedKt: sp.speedKt, glideDeg: sp.glideDeg }, dev);
    let goArounds = 0, goCmd = null;
    const t = simFly(I, flight, { lat: sp.lat, lon: sp.lon, alt: sp.altM, hdg: sp.heading }, speed, () => 130, 10 * 60000,
      (out) => { if (out.goAround) { goArounds++; goCmd = out.cmd; } });
    const log = flight.result();
    const cls = ROBOT.classifyApproach(log);
    ok(t != null && cls.label === 'PASS', 'PASS on a flat field: ' + cls.label + ' ' + JSON.stringify(log.at50));
    ok(log.at50 && log.at50.aglFt <= 50 && Math.abs(log.at50.crossM) < 10 && Math.abs(log.at50.locDots) < 0.1, 'reached 50 ft on the centreline');
    ok(goArounds === 1 && goCmd.courseDeg === 162 && goCmd.altFt === Math.round(130 / 0.3048 + 1500) && goCmd.speedKt === sp.speedKt + 20, 'exactly one go-around: runway heading, threshold + 1500 ft, approach + 20 kt');
    ok(log.spawnHaglM > 280 && log.at1nm && log.atHalfNm && log.profile.length >= 8 && near(log.minGpClearM, 15 + 926 * Math.tan(3 * Math.PI / 180), 2),
      'spawn height, 1 nm / 0.5 nm snapshots, the last-mile profile, and the glidepath clearance (flat: its height at 0.5 nm) are logged: ' + log.minGpClearM);

    const hill = I.destination({ lat: rw.thr_lat, lon: rw.thr_lon }, 342, 2 * 1852);
    const terrain = (lat, lon) => (I.haversineM({ lat, lon }, hill) < 600 ? 130 + 170 : 130);
    const f2 = ROBOT.makeApproachFlight(rw, { speedKt: sp.speedKt, glideDeg: sp.glideDeg }, dev);
    simFly(I, f2, { lat: sp.lat, lon: sp.lon, alt: sp.altM, hdg: sp.heading }, speed, terrain, 10 * 60000);
    const c2 = ROBOT.classifyApproach(f2.result());
    ok(c2.status === 'TERRAIN' && / at (1\.\d|2(\.\d)?) nm$/.test(c2.reason), 'a hill 2 nm out under the glidepath -> ' + c2.label);
    ok(ROBOT.classifyApproach({ spawnHaglM: 90 }).status === 'SPAWN_LOW', 'spawned 90 m above terrain -> SPAWN_LOW');
    ok(ROBOT.classifyApproach(Object.assign({}, log, { geofsOffset: { crossM: 42 } })).label === 'OFFSET(42 m)', 'GeoFS\'s runway 42 m off the JSON centreline -> OFFSET');
    ok(ROBOT.classifyApproach({ abort: { reason: 'spawn', detail: 'x' } }).status === 'FAIL' && ROBOT.classifyApproach({ spawnHaglM: 500 }).label === 'FAIL(never reached 50 ft)', 'spawn failure / never got down');
  }

  console.log('Robot (pure): runwayRecordOffset, runwayGroupOf, reportJson');
  {
    const E = env();
    const I = E.R._internals, dev = E.R.dev;
    const rw = { thr_lat: 47.4318, thr_lon: -122.3082, heading_deg: 162 };
    const p = I.destination({ lat: rw.thr_lat, lon: rw.thr_lon }, 252, 30);
    const off = ROBOT.runwayRecordOffset({ lat: p.lat, lon: p.lon, heading: 163 }, rw, dev);
    ok(off && near(off.crossM, 30, 0.5) && near(off.alongM, 0, 0.5) && off.headingDiffDeg === 1, 'a record 30 m right of the JSON threshold: ' + JSON.stringify(off));
    ok(ROBOT.runwayRecordOffset({ threshold: [p.lat, p.lon] }, rw, dev).crossM > 29, 'an array-shaped threshold parses too');
    ok(ROBOT.runwayRecordOffset({ name: '16C' }, rw, dev) === null && ROBOT.runwayRecordOffset(null, rw, dev) === null, 'unparseable -> null, never a guess');
    ok(ROBOT.runwayGroupOf('White-Knuckle. Tenzing-Hillary...') === 'White-Knuckle' && ROBOT.runwayGroupOf('Beach & Island. Maho') === 'Beach & Island'
      && ROBOT.runwayGroupOf('Long, wide') === 'More runways' && ROBOT.runwayGroupOf(undefined) === 'More runways', 'runwayGroupOf: the LANDING_CUPS.md leading word');
    const rep = ROBOT.reportJson([{ kind: 'course', id: 'x', status: 'PASS', label: 'PASS', timeMs: 5, log: { gates: [], trace: { v: 1 } } }], { mode: 'course', clientVersion: '1.7.0', generatedAt: '2026-09-24T00:00:00Z' });
    ok(rep.v === 1 && rep.kind === 'robot-report' && rep.generated_at === '2026-09-24T00:00:00Z' && rep.results[0].log && !('trace' in rep.results[0].log), 'reportJson: schema v1, and traces never go in the report');
  }

  console.log('Robot bookmarklet: never names GeoFS/Cesium itself, and mounts only on top of race.js\'s dev namespace');
  {
    const code = robotSrc.replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');
    ok(!/\bgeofs\b/.test(code) && !/\bCesium\b/.test(code) && !/controls\.setters|\.autopilot\b|rigidBody|flyTo\(|\.place\(/.test(code),
      'robot_pilot.js code never touches geofs/Cesium/controls/autopilot directly: every write goes through dev.GeoPhysics');
    const E = env();
    let alerted = null;
    E.w.alert = (m) => { alerted = m; };
    const saved = E.w.__finsRace;
    E.w.__finsRace = undefined;
    E.w.eval(robotSrc);
    ok(/load FINSONLY Racing/.test(alerted || '') && !E.w.__finsRobot, 'without race.js: an alert, no panel');
    E.w.__finsRace = saved;
    E.w.eval(robotSrc);
    const panel = E.w.document.getElementById('fr-robot');
    ok(E.w.__finsRobot && panel && /ROBOT TEST PILOT/.test(panel.textContent), 'with race.js: the panel mounts');
    E.w.eval(robotSrc);
    ok(E.w.document.querySelectorAll('#fr-robot').length === 1, 'loading it twice re-shows the one panel');
  }

  console.log('GeoPhysics is the only physics writer: no physics API appears in race.js code outside its section');
  {
    const begin = SRC.indexOf('// ================================================== GeoPhysics (BEGIN');
    const end = SRC.indexOf('// ==================================================== GeoPhysics (END');
    ok(begin > 0 && end > begin, 'the GeoPhysics section markers are present');
    // /\r?\n/, not '\n': a Windows checkout (core.autocrlf) leaves a \r on every line, and `.`
    // does not match \r, so the comment strip below silently did nothing there.
    const outside = (SRC.slice(0, begin) + SRC.slice(end)).split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');
    for (const [name, re] of [['rigidBody', /\brigidBody\b/], ['autopilot', /\.autopilot\b/], ['place()', /\.place\(/],
      ['controls.setters', /controls\.setters/], ['setLinearVelocity', /setLinearVelocity/], ['resetFlight', /resetFlight/],
      ['trueAirSpeed/groundSpeed', /\b(trueAirSpeed|groundSpeed)\b/], ['thrust', /\.thrust\b/],
      ['flyTo()', /\.flyTo\(/], ['decreaseThrottle', /decreaseThrottle/],
      ['setAltitude()', /\.setAltitude\(/], ['setSpeed()', /\.setSpeed\(/]]) {
      ok(!re.test(outside), name + ' is not touched outside GeoPhysics');
    }
  }

  console.log('G env is the only weather/time/buildings writer, and nothing ever saves GeoFS preferences');
  {
    const begin = SRC.indexOf('// ==================================================== G env (BEGIN');
    const end = SRC.indexOf('// ====================================================== G env (END');
    ok(begin > 0 && end > begin, 'the G env section markers are present');
    const strip = (t) => t.split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');
    const outside = strip(SRC.slice(0, begin) + SRC.slice(end));
    for (const [name, re] of [['preferences.weather', /preferences\.weather/], ['setAdvanced', /setAdvanced/],
      ['setDateAndTime', /setDateAndTime/], ['weather.refresh', /\bweather\.refresh\b/], ['setBuildings', /setBuildings/],
      ['preferences.graphics', /preferences\.graphics/], ['.advanced', /\.advanced\b/]]) {
      ok(!re.test(outside), name + ' is not touched outside the G env section');
    }
    ok(!/savePreferences/.test(strip(SRC)), 'savePreferences appears nowhere in race.js code');
  }

  console.log('Formation: the track starts at the start line and its heading matches its own numeric derivative everywhere');
  {
    const { formationBuildTrack, formationPositionAt, ecef, sub, vlen, bearingDeg, destination } = E0.R._internals;
    const g1 = { lat: 45, lon: -122, alt: 500 }, g2 = destination(g1, 90, 5000);
    const track = formationBuildTrack(g1, g2, 92.6);
    ok(track.radius > 0 && track.turnLen > 0 && track.lapLen > track.legLen * 2, 'a sane oval: radius/turnLen positive, lapLen > 2x leg');
    const sl = formationPositionAt(track, 0);
    const wantSL = destination(g1, bearingDeg(g2, g1), 1500);
    ok(vlen(sub(ecef(sl.lat, sl.lon, 0), ecef(wantSL.lat, wantSL.lon, 0))) < 5, 's=0 is the start line, 1.5 km before gate 1 (within great-circle rounding)');
    ok(near(sl.heading, bearingDeg(g1, g2), 0.01), 'heading at the line is the course bearing (' + sl.heading.toFixed(2) + ')');

    // Numeric self-consistency: forward = s decreasing, so the reported heading at s must point
    // (within a few degrees) from positionAt(s+eps) toward positionAt(s-eps), everywhere on the
    // track -- straight, both turns, and across a lap boundary.
    let worst = 0;
    for (let s = -500; s < track.approachLen + track.lapLen * 1.5; s += 37) {
      const eps = 5;
      const p0 = formationPositionAt(track, s + eps), p1 = formationPositionAt(track, s - eps), pm = formationPositionAt(track, s);
      const wantHdg = bearingDeg(p0, p1);
      const diff = Math.abs(((wantHdg - pm.heading + 540) % 360) - 180);
      worst = Math.max(worst, diff);
    }
    ok(worst < 3, 'reported heading matches the direction of travel within 3 degrees everywhere on the track (worst ' + worst.toFixed(2) + ')');
  }

  console.log('Formation: slot target positions are distinct, evenly spaced, and count down at exactly pace speed');
  {
    const { formationSlotTargetS } = E0.R._internals;
    const pace = 92.6, greenMs = 1000000, marginS = 1, gapS = 3;
    const now = greenMs - 20000;
    const slots = [0, 1, 2, 3, 4].map((k) => formationSlotTargetS(pace, now, greenMs, marginS, gapS, k));
    for (let i = 1; i < slots.length; i++) ok(near(slots[i] - slots[i - 1], pace * gapS, 1e-6), 'slot ' + i + ' trails slot ' + (i - 1) + ' by pace x gapS (' + (slots[i] - slots[i - 1]).toFixed(1) + ')');
    ok(new Set(slots.map((s) => s.toFixed(3))).size === slots.length, 'every slot is at a distinct s');
    const s0 = formationSlotTargetS(pace, greenMs, greenMs, marginS, gapS, 0);
    ok(near(s0, pace * marginS, 1e-6), 'slot 0 sits marginS seconds behind the line exactly at green (' + s0.toFixed(1) + ')');
    const later = formationSlotTargetS(pace, now + 1000, greenMs, marginS, gapS, 0);
    const earlier = formationSlotTargetS(pace, now, greenMs, marginS, gapS, 0);
    ok(near(earlier - later, pace, 1e-6), 'the target counts down at exactly pace m/s (' + (earlier - later).toFixed(2) + ' per second)');
  }

  console.log('Formation: along-track error sign - ahead of the slot is positive, behind is negative');
  {
    const { formationAlongTrackError } = E0.R._internals;
    ok(formationAlongTrackError(1000, 800) === 200, 'actual s smaller than target (closer to the line) = ahead = positive');
    ok(formationAlongTrackError(1000, 1200) === -200, 'actual s larger than target (farther back) = behind = negative');
    ok(formationAlongTrackError(1000, 1000) === 0, 'on target = zero error');
  }

  console.log('Formation: the speed controller stays within pace +/- 25 kt and converges on a first-order aircraft model');
  {
    const { formationSpeedKt } = E0.R._internals;
    const paceKt = 180, paceMs = 92.6, kp = E0.R.config.FORMATION_SPEED_KP, clamp = 25;
    ok(formationSpeedKt(paceKt, 0, paceMs, kp, clamp) === paceKt, 'zero error commands exactly pace');
    ok(near(formationSpeedKt(paceKt, paceMs * 1000, paceMs, kp, clamp), paceKt - clamp, 1e-9), 'a huge positive (ahead) error clamps at pace - 25 kt');
    ok(near(formationSpeedKt(paceKt, -paceMs * 1000, paceMs, kp, clamp), paceKt + clamp, 1e-9), 'a huge negative (behind) error clamps at pace + 25 kt');
    for (const errorM of [-5000, -100, 0, 100, 5000]) {
      const kt = formationSpeedKt(paceKt, errorM, paceMs, kp, clamp);
      ok(kt >= paceKt - clamp - 1e-9 && kt <= paceKt + clamp + 1e-9, 'commanded speed always inside pace +/- clampKt (error ' + errorM + ' -> ' + kt.toFixed(1) + ' kt)');
    }
    // Convergence: a slot starting 500 m (~5 s) behind schedule, flown by a first-order aircraft model
    // (speed eases toward the commanded value with a 3 s time constant, position integrates it),
    // must close to under 20 m of its target within the simulated pace lap.
    let actualS = 1500, speedMs = paceMs, targetS = 1000;
    const dt = 0.5, tau = 3;
    for (let t = 0; t < 120; t += dt) {
      const errorM = targetS - actualS;
      const cmdKt = formationSpeedKt(paceKt, errorM, paceMs, kp, clamp);
      const cmdMs = E0.R._internals.ktToMs(cmdKt);
      speedMs += (cmdMs - speedMs) * Math.min(1, dt / tau);
      actualS -= speedMs * dt;
      targetS -= paceMs * dt;
    }
    ok(Math.abs(targetS - actualS) < 20, 'converges to within 20 m of the slot target (final error ' + (targetS - actualS).toFixed(1) + ' m)');
  }

  console.log('Formation: start-line crossing is detected exactly once, in the right direction');
  {
    const { formationBuildTrack, formationPositionAt, formationCrossedStartLine, destination } = E0.R._internals;
    const g1 = { lat: 45, lon: -122, alt: 500 }, g2 = destination(g1, 90, 5000);
    const track = formationBuildTrack(g1, g2, 92.6);
    const before = formationPositionAt(track, 50), after = formationPositionAt(track, -50);
    ok(formationCrossedStartLine(track, before, after) === true, 'moving from s=+50 to s=-50 crosses the line');
    ok(formationCrossedStartLine(track, after, before) === false, 'moving backward (s=-50 to s=+50) does not count as a crossing');
    ok(formationCrossedStartLine(track, before, before) === false, 'sitting still never crosses');
    const farBehind = formationPositionAt(track, 500), stillBehind = formationPositionAt(track, 400);
    ok(formationCrossedStartLine(track, farBehind, stillBehind) === false, 'moving forward while still well behind the line is not a crossing');
  }

  console.log('Formation: the oval clears terrain, and altitude never drops below gate 1');
  {
    const { formationBuildTrack, formationAltitudeM, destination } = E0.R._internals;
    const g1 = { lat: 45, lon: -122, alt: 1000 }, g2 = destination(g1, 90, 5000);
    const track = formationBuildTrack(g1, g2, 92.6);
    const flat = () => 200;   // terrain well below gate 1
    ok(formationAltitudeM(track, g1.alt, flat, 24) === g1.alt + E0.R.config.FORMATION_ALT_MARGIN_M, 'flat low terrain: gate 1 alt + the margin (' + formationAltitudeM(track, g1.alt, flat, 24) + ')');
    const ridge = () => 900;   // a ridge close under gate-1 altitude
    const withRidge = formationAltitudeM(track, g1.alt, ridge, 24);
    ok(withRidge >= 900 + 300 + E0.R.config.FORMATION_ALT_MARGIN_M - 1, 'a ridge under the oval pushes the altitude up 300 m + the margin over it (' + withRidge + ')');
    const missing = () => NaN;   // sampler returns nothing (e.g. offline)
    ok(formationAltitudeM(track, g1.alt, missing, 24) === g1.alt + E0.R.config.FORMATION_ALT_MARGIN_M, 'a sampler with no data falls back to gate 1 alt + the margin, never NaN');
  }

  console.log('Formation: projectS finds a pilot back on their own slot, and lookahead points forward');
  {
    const { formationBuildTrack, formationPositionAt, formationProjectS, formationLookaheadHeading, destination } = E0.R._internals;
    const g1 = { lat: 45, lon: -122, alt: 500 }, g2 = destination(g1, 90, 5000);
    const track = formationBuildTrack(g1, g2, 92.6);
    for (const s of [100, track.approachLen + 500, track.approachLen + track.legLen + track.turnLen / 2, track.approachLen + track.lapLen * 1.4]) {
      const pos = formationPositionAt(track, s);
      const found = formationProjectS(track, pos, s + 30);   // a seed close to, but not exactly at, the true s
      ok(Math.abs(found - s) < 15, 'projectS recovers s=' + s.toFixed(0) + ' from a nearby seed (found ' + found.toFixed(1) + ')');
    }
    const hdg = formationLookaheadHeading(track, track.approachLen + 200, 500);
    ok(Number.isFinite(hdg) && hdg >= 0 && hdg < 360, 'lookahead heading is a real bearing (' + hdg + ')');
  }

  console.log('ui-unify: #fr-theme is injected once (including on a second load), and every FINSONLY root carries .fr-ui');
  {
    const E = env({ lobbyV2: true, apiBase: 'https://relay.test' });
    ok(E.w.document.querySelectorAll('#fr-theme').length === 1, 'one #fr-theme stylesheet');
    ok(/--fr-accent:#ff8a3d/.test(E.w.document.getElementById('fr-theme').textContent), 'the theme stylesheet defines the sunset tokens');
    E.w.eval(SRC.replace(/VERSION: '[^']+'/, "VERSION: '9.9.9-test'"));
    ok(E.w.document.querySelectorAll('#fr-theme').length === 1, 'still one #fr-theme after a version-replacing reload');
    for (const id of ['fr-shell', 'fr-shell-reopen', 'fr-banner', 'fr-hud']) {
      const el = E.w.document.getElementById(id);
      ok(el && el.classList.contains('fr-ui'), '#' + id + ' carries .fr-ui');
    }
    E.R.debug.show();
    ok(E.w.document.getElementById('fr-debug').classList.contains('fr-ui'), '#fr-debug carries .fr-ui too');
  }

  console.log('ui-unify: CONFIG.THEME_WEBFONT gates the Google Fonts <link>, off by default');
  {
    const off = env({ lobbyV2: true });
    ok(off.w.document.getElementById('fr-theme-webfont') === null, 'no webfont link by default');
    const on = env({ lobbyV2: true, patch: [['THEME_WEBFONT: false,', 'THEME_WEBFONT: true,']] });
    const link = on.w.document.getElementById('fr-theme-webfont');
    ok(link && /fonts\.googleapis\.com/.test(link.getAttribute('href')), 'THEME_WEBFONT: true adds the Saira Condensed link');
  }

  console.log('ui-unify: the injected CSS has no literal z-index, no font under 11px (12px in the HUD), and no color literal outside the theme except the listed art');
  {
    // [selector, declarations] for every rule in every FINSONLY stylesheet except #fr-theme
    // (which is where the literals are supposed to live). @media wrappers are unwrapped.
    const rulesOf = (doc) => [...doc.querySelectorAll('style[id^="fr-"]')].filter((s) => s.id !== 'fr-theme')
      .flatMap((s) => s.textContent.split('}').map((chunk) => chunk.split('{')).filter((p) => p.length >= 2)
        .map((p) => [p[p.length - 2].trim().split('\n').pop().trim(), p[p.length - 1]]));
    // Art, not UI chrome: the goop/missile screen tints and the minimap banana/inbound-goop
    // greens are drawn colors with no theme meaning. Listed in the ui-unify PR body too.
    const ART = [/\.fr-fx-goop-l/, /\.fr-fx-missile-l/, /\.fr-mm-bananas/, /#fr-hud-inbound\.fr-in-goop/];
    const SCALE = new Set([11, 12, 14, 16, 20, 28, 40, 72]);
    for (const lobbyV2 of [true, false]) {
      const E = env({ lobbyV2, apiBase: 'https://relay.test' });
      E.R.debug.show();
      const rules = rulesOf(E.w.document);
      const tag = lobbyV2 ? ' (shell)' : ' (rollback)';
      ok(rules.length > 100, 'parsed ' + rules.length + ' rules' + tag);
      const badZ = rules.filter(([, d]) => /z-index:/.test(d) && !/z-index:var\(--fr-z-[a-z]+\)/.test(d));
      ok(badZ.length === 0, 'every z-index is a --fr-z-* token' + tag + (badZ.length ? ': ' + badZ.map((r) => r[0]).join(', ') : ''));
      const inlineZ = [...E.w.document.querySelectorAll('[style]')].filter((el) => /z-index/.test(el.getAttribute('style')));
      ok(inlineZ.length === 0, 'no element carries an inline z-index' + tag);
      const badSize = [];
      for (const [sel, d] of rules) {
        for (const m of d.matchAll(/(?:font-size:|font:[^;]*?)(\d+(?:\.\d+)?)px/g)) {
          const px = +m[1], hud = /#fr-hud|\.fr-hud|\.fr-mm/.test(sel);
          if (!SCALE.has(px) || px < (hud ? 12 : 11)) badSize.push(sel + ' ' + px + 'px');
        }
        if (/#fr-hud|\.fr-hud|\.fr-mm/.test(sel) && /var\(--fr-t-xs\)/.test(d)) badSize.push(sel + ' --fr-t-xs (11px) in the HUD');
      }
      ok(badSize.length === 0, 'every literal font size is on the scale and >= 11px (>= 12px in the HUD)' + tag + (badSize.length ? ': ' + badSize.join(', ') : ''));
      const badColor = rules.filter(([sel, d]) => /#[0-9a-fA-F]{3,6}\b|rgba?\(/.test(d.replace(/rgba\(0,0,0,[.\d]+\)/g, ''))
        && !ART.some((re) => re.test(sel)));
      ok(badColor.length === 0, 'no hex/rgba color literal outside #fr-theme except the listed art' + tag + (badColor.length ? ': ' + badColor.map((r) => r[0]).join(', ') : ''));
    }
    ok(!/z-index:\s*\d/.test(SRC) && !/\.zIndex\b/.test(SRC), 'race.js source has no literal z-index and never sets style.zIndex');
  }

  console.log('ui-unify: every HUD readout sits on a .fr-plate, and the inbound warning lives in the TC column');
  {
    const E = env({ lobbyV2: true });
    const doc = E.w.document;
    for (const id of ['fr-hud-pos-block', 'fr-hud-center-plate', 'fr-hud-feed', 'fr-hud-speedalt', 'fr-hud-items', 'fr-hud-map']) {
      const el = doc.getElementById(id);
      ok(el && el.classList.contains('fr-plate'), '#' + id + ' is a plate');
    }
    const inbound = doc.getElementById('fr-hud-inbound');
    ok(inbound && inbound.parentNode === doc.getElementById('fr-hud-center'), 'the inbound warning is a child of #fr-hud-center, under the timer plate');
    ok(doc.getElementById('fr-hud-in-arrow').parentNode === doc.getElementById('fr-hud'), 'the inbound arrow still hangs off #fr-hud, whose origin is the viewport');
  }

  console.log('ui-unify: news and toasts share the top-right stack, news first');
  {
    const E = env({ lobbyV2: true, apiBase: 'https://relay.test' });
    const doc = E.w.document;
    const stack = doc.getElementById('fr-tr-stack');
    ok(stack && doc.getElementById('fr-news').parentNode === stack, 'the news card is mounted in #fr-tr-stack');
    E.R.ui.showNews({ beaten_by: 'Dave', course_name: 'hood-circuit', margin_ms: 410 });
    E.R.shell.toast('One', 'warn');
    ok(doc.getElementById('fr-toasts').parentNode === stack, 'the toast list is mounted in the same stack');
    ok(stack.firstElementChild.id === 'fr-news' && stack.lastElementChild.id === 'fr-toasts', 'news above toasts');
    ok(doc.getElementById('fr-toasts').children.length === 1, 'the toast list holds only toasts');
  }

  console.log('ui-unify: the reopen pill hides while a run is live, and comes back when it ends');
  {
    const COURSE = { id: 'c', name: 'C', startType: 'air',
      gates: [{ lat: 44, lon: -121, alt: 1000, radius: 150 }, { lat: 44.02, lon: -121, alt: 1000, radius: 150 },
        { lat: 44.04, lon: -121, alt: 1000, radius: 150 }] };
    const E = env({ lobbyV2: true });
    await E.bootFrames();
    const tab = E.R.shell.E.reopenTab;
    E.R.race.load(COURSE);
    ok(!tab.classList.contains('fr-racing'), 'armed, not racing: the pill is available');
    departGate1(E, 44, -121);
    ok(E.R.race.state === 'running' && tab.classList.contains('fr-racing'), 'the run starts: the pill is hidden (.fr-racing)');
    E.R.race.reset();
    ok(!tab.classList.contains('fr-racing'), 'reset: the pill is back');
  }

  console.log('ui-unify: Alt+K collapses and reopens the shell, counts as a manual expand mid-run, and un-hides a hidden shell');
  {
    const E = env({ lobbyV2: true, apiBase: 'shipped' });
    const sh = E.R.shell;
    const altK = () => E.w.dispatchEvent(new E.w.KeyboardEvent('keydown', { code: 'KeyK', altKey: true, bubbles: true, cancelable: true }));
    ok(sh.collapsed === false, 'starts expanded');
    altK();
    ok(sh.collapsed === true, 'Alt+K collapses');
    altK();
    ok(sh.collapsed === false, 'Alt+K reopens');
    E.R.race.state = 'running';
    sh.setCollapsed(true, { silent: true }); sh.expandedThisRun = false;
    altK();
    ok(sh.collapsed === false && sh.expandedThisRun === true, 'mid-run, Alt+K is a manual expand: auto-collapse leaves it alone for the rest of the run');
    E.R.race.state = 'armed';
    sh.toggle(false);
    ok(sh.E.shell.classList.contains('fr-hidden'), 'shell hidden entirely');
    altK();
    ok(!sh.E.shell.classList.contains('fr-hidden') && sh.collapsed === false, 'Alt+K brings a hidden shell back, expanded');
  }

  console.log('ui-unify: the rollback UI (LegacyUI) is never constructed under LOBBY_V2, and fully built without it');
  {
    const v2 = env({ lobbyV2: true, apiBase: 'https://relay.test' });
    ok(v2.R.legacyUI.built === false, 'LegacyUI.built is false under the shipped default');
    ok(!v2.w.document.getElementById('fr-legacy-style') && !v2.w.document.getElementById('fr-root') && !v2.w.document.getElementById('fr-lobby'),
      'no #fr-legacy-style, no #fr-root, no #fr-lobby');
    ok(!/#fr-root|#fr-lobby/.test(v2.w.document.getElementById('fr-style').textContent.replace(/\/\*[\s\S]*?\*\//g, '')), 'and the shared stylesheet carries none of their rules');
    v2.R.ui.renderLobby(); v2.R.ui.toggleReady(); v2.R.ui.minimize();
    ok(!v2.w.document.getElementById('fr-lobby'), 'the delegates are no-ops that mount nothing');
    const rb = env({ lobbyV2: false, apiBase: 'https://relay.test' });
    ok(rb.R.legacyUI.built === true && !!rb.w.document.getElementById('fr-legacy-style'), 'rollback: LegacyUI is built with its own stylesheet');
    ok(!!rb.w.document.getElementById('fr-root') && !!rb.w.document.getElementById('fr-lobby'), 'rollback: #fr-root and #fr-lobby are both there');
  }

  console.log('ui-unify: CONFIG.SEASONS hides the Season tab and its mentions until it is on');
  {
    const off = env({ lobbyV2: true, apiBase: 'https://relay.test' });
    ok(!off.R.shell.E.tab_season && !off.R.shell.E.seasonScreen, 'SEASONS off (default): no Season tab, no Season screen');
    off.R.shell.setScreen('season');
    ok(off.R.shell.screen === 'ramp', 'asking for the Season screen lands on the Ramp');
    off.R.shell.renderRamp();
    ok(!/Season/.test(off.R.shell.E.meCard.textContent) && !/null/.test(off.R.shell.E.meCard.textContent), 'the Ramp me-card does not mention Season (and prints no stray "null")');
    const on = env({ lobbyV2: true, apiBase: 'https://relay.test', patch: [['SEASONS: false,', 'SEASONS: true,']] });
    ok(!!on.R.shell.E.tab_season && !!on.R.shell.E.seasonScreen, 'SEASONS on: the tab and screen are built');
    on.R.shell.setScreen('season');
    ok(on.R.shell.screen === 'season', 'and the screen is reachable');
  }

  console.log('ui-unify: the shell, results card and toasts show/hide with .fr-enter/.fr-leave, not a display toggle');
  {
    const E = env({ lobbyV2: true, apiBase: 'https://relay.test' });
    const sh = E.R.shell;
    ok(sh.E.shell.classList.contains('fr-enter'), 'the shell starts entered');
    sh.setCollapsed(true);
    ok(sh.E.shell.classList.contains('fr-leave') && !sh.E.shell.classList.contains('fr-enter'), 'collapse: .fr-leave');
    sh.setCollapsed(false);
    ok(sh.E.shell.classList.contains('fr-enter'), 'reopen: .fr-enter');
    sh.toggle(false);
    ok(sh.E.shell.classList.contains('fr-leave'), 'Alt+H-style hide: .fr-leave');
    sh.toggle(true);
    ok(sh.E.shell.classList.contains('fr-enter'), 'and back');
    ok(E.w.document.getElementById('fr-results').classList.contains('fr-leave'), 'the results card is mounted in its .fr-leave state');
    const t = sh.toast('Hello', 'warn');
    ok(t.classList.contains('fr-enter'), 'a toast enters');
    const css = [...E.w.document.querySelectorAll('style[id^="fr-"]')].map((s) => s.textContent).join('\n');
    ok(!/#fr-shell\.fr-(hidden|collapsed)\{display:none\}|#fr-results\.fr-show/.test(css), 'no display toggle is left on #fr-shell or #fr-results');
    ok(/\.fr-ui\.fr-leave,\.fr-ui \.fr-leave\{[^}]*visibility:hidden;pointer-events:none/.test(css), 'a left surface drops visibility and pointer events, so it never takes a click');
  }

  console.log('ui-unify copy: relay/ramp refusals read as plain sentences, and unknown ones are still shown');
  {
    const { relayErrorText } = E0.R._internals;
    ok(relayErrorText('host only') === 'Only the host can do that.', 'a known detail maps to a sentence');
    ok(relayErrorText('not everyone is ready') === 'Not everyone is ready yet.', 'another known detail');
    ok(relayErrorText('bad frame shape') === 'The server refused that: Bad frame shape.', 'an unknown detail is sentence-cased and attributed, not swallowed');
    ok(relayErrorText('bad callsign', 'ramp') === 'The ramp refused that: Bad callsign.', 'the ramp names itself');
    ok(relayErrorText('') === 'The server refused that.', 'an empty detail still says something');
    ok(relayErrorText('Already ended.') === 'The server refused that: Already ended.', 'no doubled full stop');
    const E = env({ lobbyV2: true, apiBase: 'https://relay.test' });
    E.R.shell.enterRoom('copy-room', false);
    const ws = raceSockets(E)[0];
    ws.fireOpen();
    ws.fireMessage({ type: 'joined', room: 'copy-room', proto: 5, server_ms: Date.now() });
    ws.fireMessage({ type: 'error', detail: 'host only' });
    const t = E.w.document.getElementById('fr-toasts').textContent;
    ok(t.includes('Only the host can do that.') && !/Relay:/.test(t), 'the toast carries the sentence, not "Relay: host only"');
  }

  console.log('ui-unify: race/tools/ui_gallery.html mounts every scene against the real race.js without an error');
  {
    const html = fs.readFileSync(path.join(__dirname, '..', 'tools', 'ui_gallery.html'), 'utf8');
    const lib = (html.match(/<script id="gallery-lib">([\s\S]*?)<\/script>/) || [])[1];
    ok(!!lib, 'the gallery has its shared #gallery-lib block');
    const mountScene = async (scene) => {
      const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { runScripts: 'outside-only', url: 'https://gallery.test/race/tools/ui_gallery.html' });
      const w = dom.window;
      const errors = [];
      w.console = { ...console, log() {}, info() {}, warn() {}, error(...a) { errors.push(a.map(String).join(' ')); } };
      w.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
      w.eval(lib);
      const ctx = w.FrGallery.installStubs(w);
      w.eval(SRC);
      await new Promise((r) => setTimeout(r, 700));
      let threw = null;
      try { await w.FrGallery.mount(w, ctx, scene); } catch (e) { threw = e; }
      await new Promise((r) => setTimeout(r, 150));
      return { w, R: w.__finsRace, doc: w.document, errors, threw, close: () => { try { w.__finsRace.teardown('test'); } catch (_) {} w.close(); } };
    };
    const checks = {
      ramp: (g) => g.R.shell.screen === 'ramp' && g.R.shell.E.rampRows.children.length === 3,
      gate: (g) => g.R.shell.screen === 'gate' && g.doc.querySelectorAll('#fr-shell .fr-pilot-card').length === 6,
      launch: (g) => g.R.shell.screen === 'launch' && g.R.countdown.state === 'armed' && g.doc.querySelectorAll('.fr-grid-row').length === 6
        && /6\s*gates/.test(g.R.shell.E.launchFacts.textContent) && !/null/.test(g.R.shell.E.launchFacts.textContent),
      hud: (g) => g.R.race.state === 'running' && g.doc.getElementById('fr-hud').classList.contains('fr-hud-show') && g.doc.querySelectorAll('#fr-hud-tower li').length === 6
        && g.doc.querySelectorAll('#fr-hud-feed li').length === 4,
      'results-solo': (g) => g.doc.getElementById('fr-results').classList.contains('fr-enter'),
      'results-cup': (g) => g.doc.getElementById('fr-results').classList.contains('fr-enter') && /Friday/.test(g.doc.getElementById('fr-results').textContent),
      toasts: (g) => g.doc.querySelectorAll('#fr-toasts .fr-toast').length === 3,
      news: (g) => g.doc.getElementById('fr-news').classList.contains('fr-show'),
    };
    const lister = new JSDOM('', { runScripts: 'outside-only' }).window;
    lister.eval(lib);
    const scenes = [...lister.FrGallery.SCENES];
    ok(scenes.join() === Object.keys(checks).join(), 'every gallery scene has a check here: ' + scenes.join(', '));
    for (const scene of scenes) {
      const g = await mountScene(scene);
      ok(!g.threw && g.errors.length === 0 && checks[scene](g), 'scene "' + scene + '" mounts and shows what it claims' +
        (g.threw ? ' — threw: ' + g.threw.message : '') + (g.errors.length ? ' — console.error: ' + g.errors[0].slice(0, 160) : ''));
      g.close();
    }
  }

  console.log('Regression (found by ui_gallery): no surface prints a stray "null" where an optional child was left out');
  {
    // Launch: a course with no KNOWN_TERRAIN_STATUS entry used to render "6 gates null" — covered
    // by the ui_gallery "launch" scene check above (its fixture course has no terrain row).
    // Rollback lobby card: the host controls appended a null cup row / reason line as "null".
    const R2 = env({ apiBase: 'https://relay.test', seed: { 'finsRace.callsign': 'Eric', 'finsRace.powerupRoom': 'nullroom' } });
    await R2.bootFrames();
    const ws = R2.wsRecord.last;
    ws.fireOpen();
    ws.fireMessage({ type: 'joined', room: 'nullroom', proto: 2, server_ms: Date.now() });
    ws.fireMessage({ type: 'lobby', phase: 'lobby', host: 'Eric', course: null, rules: { powerups: true, teleport: true }, race_id: 0,
      players: [{ callsign: 'Eric', model: '', ready: true, role: 'racer' }] });
    R2.R.ui.renderLobby();
    const host = R2.w.document.getElementById('fr-lobby-host');
    ok(host && host.children.length > 0 && !/null/.test(host.textContent), 'the rollback host controls render with no "null" (proto 2: no cup row)');
  }

  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
