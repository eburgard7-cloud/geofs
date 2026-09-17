// Headless tests for race.js: mocks GeoFS + Cesium, flies a scripted aircraft.
// Run: cd race/test && npm i jsdom@24 && node run.js
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'race.js'), 'utf8');
let failures = 0;
const ok = (cond, msg) => { console.log((cond ? '  pass ' : '  FAIL ') + msg); if (!cond) failures++; };
const near = (a, b, tol) => Math.abs(a - b) <= tol;

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

function env({ aircraftId = '7', modelApi = 'fromGltfAsync', models = null, assignments = null, withMap = false, courseMap = true, powerups = true, seed = null } = {}) {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { runScripts: 'outside-only', url: 'https://www.geo-fs.com/geofs.php' });
  const w = dom.window;
  let rafCb = null;
  w.requestAnimationFrame = (cb) => { rafCb = cb; return 1; };
  w.console = { ...console, warn() {} };
  w.fetch = async (url) => {
    if (models !== null && String(url).includes('models/index.json')) return { ok: true, status: 200, json: async () => models };
    if (assignments !== null && String(url).includes('models/assignments.json')) return { ok: true, status: 200, json: async () => assignments };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const color = { withAlpha() { return this; } };
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
  w.geofs = {
    aircraft: { instance: { llaLocation: [45, -122, 1000], id: aircraftId, object3d: stockNode } },
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
  let src = courseMap === false ? SRC.replace('COURSE_MAP: true,', 'COURSE_MAP: false,') : SRC;
  if (courseMap === false && src === SRC) throw new Error('CONFIG.COURSE_MAP default line not found to patch');
  if (powerups === false) {
    const patched = src.replace('POWERUPS: true,', 'POWERUPS: false,');
    if (patched === src) throw new Error('CONFIG.POWERUPS default line not found to patch');
    src = patched;
  }
  if (seed) for (const [k, v] of Object.entries(seed)) w.localStorage.setItem(k, JSON.stringify(v));
  w.eval(src);
  const R = w.__finsRace;
  let t = 0;
  const frame = (dtMs) => { t += dtMs; const cb = rafCb; rafCb = null; cb(t); };
  const bootFrames = async () => { await new Promise((r) => setTimeout(r, 700)); }; // wait for ready poll
  return { w, R, ents, state, primitives, stockNode, frame, bootFrames, fakeMap, mapRecord: fakeL.record, now: () => t, setPos: (p) => { w.geofs.aircraft.instance.llaLocation = [p.lat, p.lon, p.alt]; } };
}

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
    ok(E.ents.size === 6, 'renders 3 spheres + 3 poles');
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
    const E = env({ withMap: true, courseMap: false, powerups: false });
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
    ok(JSON.stringify(s.slots) === JSON.stringify(s.loadout), 'slots start full from the loadout');
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
    ok(JSON.stringify(refilled.slots) === JSON.stringify(refilled.loadout), 'refill restores both carried slots from the loadout');

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
    ok(JSON.stringify(E.R.powerups.state.slots) === JSON.stringify(['boost', 'boost']), 'setLoadout refills the carried slots immediately');
  }

  console.log('Powerups: Boost applies a bounded, self-recovering speed nudge; never exceeds MAX_SPEED_MS');
  {
    const E = env();
    await E.bootFrames();
    const { ecef, sub, vlen } = E.R._internals;
    E.setPos(along(0)); E.frame(16);
    const PU = E.R.powerups, CFG = E.R.config;
    ok(PU.state.slots[0] === 'boost', 'default loadout carries Boost in slot 1');

    const t0 = E.now();
    PU.useSlot(0, t0);
    ok(PU.state.slots[0] === null, 'using the slot consumes the carried item');
    ok(PU.state.effects.boost === t0 + CFG.POWERUP_BOOST_MS, 'boost effect armed for the configured duration');

    let prev = [...E.w.geofs.aircraft.instance.llaLocation], maxV = 0;
    const dt = 16;
    const frames = Math.ceil(CFG.POWERUP_BOOST_MS / dt) + 5;
    for (let i = 0; i < frames; i++) {
      E.frame(dt);
      const cur = E.w.geofs.aircraft.instance.llaLocation;
      const v = vlen(sub(ecef(cur[0], cur[1], cur[2]), ecef(prev[0], prev[1], prev[2]))) / (dt / 1000);
      maxV = Math.max(maxV, v);
      prev = [...cur];
    }
    ok(maxV > 0, 'boost actually moved the aircraft (nudge applied), peak ' + maxV.toFixed(1) + ' m/s');
    ok(maxV <= CFG.MAX_SPEED_MS, 'boosted speed never exceeds MAX_SPEED_MS (' + maxV.toFixed(1) + ' m/s)');
    ok(PU.state.effects.boost === undefined, 'boost effect auto-recovers (expires) after its duration');

    const settled = [...E.w.geofs.aircraft.instance.llaLocation];
    E.frame(dt);
    const after = E.w.geofs.aircraft.instance.llaLocation;
    ok(settled[0] === after[0] && settled[1] === after[1], 'no further movement once the boost has expired');
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
    const E = env({ powerups: false, courseMap: false });
    await E.bootFrames();
    ok(E.R.config.POWERUPS === false, 'config reflects the flag');
    ok(!E.w.document.getElementById('fr-powerups'), 'no Powerups UI section rendered');
    ok(E.R.race.listeners.length === 1, 'Powerups never subscribed to the race event bus (only the UI listener is present)');
    const before = JSON.stringify(E.R.powerups.state);
    const ev = new E.w.KeyboardEvent('keydown', { code: 'Digit1', altKey: true, bubbles: true, cancelable: true });
    E.w.dispatchEvent(ev);
    ok(JSON.stringify(E.R.powerups.state) === before, 'Alt+1 keybind does nothing when POWERUPS is disabled');
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
  }

  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
