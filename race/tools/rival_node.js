#!/usr/bin/env node
/*
 * FINSONLY Racing — rival generator's Node bridge to race.js (offline, no network, no sim).
 *
 * The rival tools (race/tools/rival_gen.py, rival_verify.js, envelope.py) never re-implement
 * race.js logic: Course.hash, gate crossing, gridSlot, the trace format all come from race.js
 * itself, loaded under JSDOM the same way race/test/run.js does (runScripts 'outside-only',
 * w.eval(src)). The stub world below is the smallest one G.ready() accepts. requestAnimationFrame
 * is a no-op, so race.js's own frame loop never runs: rival_verify.js drives Race.tick() by hand.
 *
 * Library:  const { loadRace } = require('./rival_node');  const env = loadRace();
 *           env.I (window.__finsRace._internals), env.R (window.__finsRace), env.setPose(...), env.close()
 * CLI:      node rival_node.js < request.json > reply.json
 *           request {op: 'meta', courses: [raw course, ...], cups: {id: cup}}  -> [{hash, course, spawn, ...}]
 *           request {op: 'encode', traces: [{samples: [...]}]}                -> [traceEncode(...)]
 *           request {op: 'hash', courses: [...]}                              -> ['8-hex', ...]
 */
'use strict';
const fs = require('fs');
const path = require('path');

const RACE_JS = path.join(__dirname, '..', 'race.js');
const TEST_MODULES = path.join(__dirname, '..', 'test', 'node_modules');

function requireJsdom() {
  try { return require('jsdom'); } catch (_) { return require(path.join(TEST_MODULES, 'jsdom')); }
}

function loadRace(opts) {
  const o = opts || {};
  const { JSDOM } = requireJsdom();
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>',
    { runScripts: 'outside-only', url: 'https://www.geo-fs.com/geofs.php' });
  const w = dom.window;
  w.requestAnimationFrame = () => 1;   // race.js's own loop never runs; callers tick Race by hand
  w.console = { ...console, log() {}, info() {}, warn() {}, debug() {} };
  w.fetch = async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' });
  w.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  const color = { withAlpha() { return this; } };
  const fn = function () {};
  w.Cesium = {
    Color: { fromCssColorString: () => color, WHITE: color, BLACK: color },
    Cartesian3: Object.assign(function (x, y, z) { Object.assign(this, { x, y, z }); }, {
      fromDegrees: (lon, lat, h) => ({ lon, lat, h }), fromDegreesArrayHeights: (a) => a }),
    Cartesian2: function (x, y) { Object.assign(this, { x, y }); },
    LabelStyle: { FILL_AND_OUTLINE: 2 }, ColorBlendMode: { HIGHLIGHT: 0, REPLACE: 1, MIX: 2 },
    ArcType: { NONE: 0, GEODESIC: 1, RHUMB: 2 },
    CallbackProperty: function (cb) { this.cb = cb; }, PolylineGlowMaterialProperty: fn, PolylineDashMaterialProperty: fn,
    Model: { fromGltfAsync: async () => ({ show: true }) },
    HeadingPitchRoll: function (heading, pitch, roll) { Object.assign(this, { heading, pitch, roll }); },
    Transforms: { headingPitchRollToFixedFrame: () => ({}), headingPitchRollQuaternion: () => ({}) },
    Math: { toRadians: (d) => d * Math.PI / 180 },
    SceneTransforms: { wgs84ToWindowCoordinates: () => null },
  };
  const instance = { llaLocation: [0, 0, 1000], id: String(o.aircraftId || '7'), object3d: { visible: true },
    rigidBody: { v_linearVelocity: [0, 0, 0], setLinearVelocity() {} }, place() {} };
  const values = { heading360: 0, kias: 0, pitch: 0, roll: 0, altitudeAGL: 1000 };
  w.geofs = {
    aircraft: { instance },
    api: { viewer: { entities: { add: (x) => ({ ...x, show: true }), remove() {} },
      scene: { primitives: { add: (m) => m, remove() {} }, canvas: w.document.createElement('canvas') } } },
    animation: { values },
    isPaused: () => false, userRecord: { callsign: 'RIVALGEN' },
    camera: { currentMode: 0, currentModeName: 'follow', currentDefinition: { insideView: false } },
    map: null, autopilot: { on: false, values: {}, setSpeed() {}, setAltitude() {}, setCourse() {}, turnOn() {}, turnOff() {} },
    controls: { throttle: 0, setters: {} },
  };
  w.multiplayer = { users: {} };
  const layer = () => ({ addTo() { return this; }, remove() {}, setLatLngs() {}, setLatLng() {}, bindTooltip() { return this; }, setStyle() {} });
  w.L = { circle: layer, circleMarker: layer, polyline: layer, marker: layer, divIcon: () => ({}), layerGroup: layer };
  w.WebSocket = class { constructor() { this.readyState = 0; } send() {} close() {} };
  w.eval(fs.readFileSync(RACE_JS, 'utf8'));
  const R = w.__finsRace;
  if (!R || !R._internals) throw new Error('race.js did not expose window.__finsRace._internals');
  return {
    w, R, I: R._internals, race: R.race, config: R.config,
    setPose(lat, lon, alt, hdg, pitch, roll) {
      instance.llaLocation = [lat, lon, alt];
      values.heading360 = hdg || 0; values.pitch = pitch || 0; values.roll = roll || 0;
    },
    close() { try { R.teardown('rival-node'); } catch (_) {} try { w.close(); } catch (_) {} },
  };
}

// robot_pilot.js's pure half (robotAircraftFor: which aircraft a course is flown in).
function robotPure() {
  return require(path.join(__dirname, 'robot_pilot.js'));
}

// Everything the Python generator needs about one course, straight from race.js.
function courseMeta(env, raw, cup) {
  const I = env.I, cfg = env.config;
  const c = I.Course.normalize(raw);
  const aircraftId = robotPure().robotAircraftFor(c, cup || null);
  const prof = I.airStartProfile(aircraftId);
  // FlyToStart.speedMs(): min(PACE_KT, this aircraft's cruise), capped by G.speedCap().
  const capMs = Math.max(0, cfg.MAX_SPEED_MS - (+cfg.SPEED_WRITE_MARGIN_MS || 0));
  const paceMs = Math.max(0, Math.min(capMs, I.ktToMs(+cfg.PACE_KT || 0)));
  const speedMs = prof.cruiseKt != null ? Math.min(paceMs, I.ktToMs(prof.cruiseKt)) : paceMs;
  const leadS = +cfg.COUNTDOWN_LEAD_S || 10;
  const spawn = c.gates.length >= 2 ? I.gridSlot(c.gates[0], c.gates[1], 0, 1, leadS, speedMs, c.start) : null;
  return {
    id: c.id, hash: I.Course.hash(c), course: c, aircraftId, startType: c.startType, laps: Number.isFinite(+raw.laps) ? +raw.laps : 1,
    spawn: spawn ? { ...spawn, speedMs } : null, leadS, airStart: prof,
  };
}

function handle(env, req) {
  if (req.op === 'hash') return req.courses.map((c) => env.I.Course.hash(env.I.Course.normalize(c)));
  if (req.op === 'meta') return req.courses.map((c) => {
    try { return courseMeta(env, c, (req.cups || {})[c.id]); } catch (e) { return { id: c && c.id, error: String(e.message || e) }; }
  });
  if (req.op === 'encode') return req.traces.map((t) => env.I.traceEncode(t));
  if (req.op === 'decode') return req.traces.map((t) => env.I.traceDecode(t));
  throw new Error('unknown op ' + req.op);
}

module.exports = { loadRace, courseMeta, robotPure, handle };

if (require.main === module) {
  const chunks = [];
  process.stdin.on('data', (d) => chunks.push(d));
  process.stdin.on('end', () => {
    const env = loadRace();
    let out;
    try { out = { ok: true, result: handle(env, JSON.parse(Buffer.concat(chunks).toString('utf8'))) }; } catch (e) { out = { ok: false, error: String(e.stack || e) }; }
    env.close();
    process.stdout.write(JSON.stringify(out));
    process.exit(0);
  });
}
