/*
 * FINSONLY Racing — PHYSICS LAB (debug-only, bookmarklet-loadable, WRITES to sim state).
 *
 * This is the write-capable companion to the read-only race/tools/probe.js. It never ships in
 * race.js and is never loaded by any bookmarklet.txt line a player uses — it exists purely to find
 * out, empirically, which GeoFS writes actually stick, ahead of building real features (Boost,
 * the speed penalty, autopilot-driven ghosts, air-start grid placement) on guessed ones instead of
 * confirmed ones. Load it on a throwaway flight you don't mind glitching (see bookmarklet.txt's LAB
 * line) — every button here can move, freeze, or overspeed the aircraft.
 *
 * Every test: (1) snapshots the fields it might touch, (2) applies exactly ONE write, (3) samples
 * the readback at +100ms/+1s/+3s (CONFIG.SAMPLE_DELAYS_MS, some tests add a longer window on top),
 * (4) classifies the readback against the pre-write baseline and the written value as
 * held / decayed / snapped_back / unknown (classifyHold()). Nothing here is called automatically —
 * every write happens only when its button is clicked. Restore reapplies the very first snapshot
 * taken when the panel loaded (not each test's own pre-snapshot, so chained tests can still be
 * undone back to the flight's original state in one click).
 *
 * Field discovery reuses probe.js's regex-scan pattern (numericCandidates()/findAutopilotObjects()/
 * findRepositionMethods() below) rather than hardcoding a single guessed path, because most of
 * these paths are exactly the TODO-PROBE guesses race.js and recorder.js already flag as unverified.
 */
(() => {
  'use strict';

  const CONFIG = {
    SAMPLE_DELAYS_MS: [100, 1000, 3000],
    THROTTLE_VALUE: 0.8,
    THROTTLE_AIRSPEED_WINDOW_MS: 5000,
    AUTOPILOT_WINDOW_MS: 10000,
    TELEPORT_OFFSET_M: 300,
    SPEED_TEST_TARGET_MPS: 120,
    SPEED_TEST_WINDOW_MS: 3000,
    RAILS_SPEED_KT: 250,
    RAILS_DURATION_MS: 10000,
    RAILS_WRITE_HZ: 20,
    RAILS_RELEASE_OBSERVE_MS: 5000,
    RIGIDBODY_VELOCITY_BOOST_MPS: 50,
    ENGINE_THRUST_BOOST_WINDOW_MS: 5000,
    FPS_WINDOW_MS: 10000,        // each A/B/A measurement window; never shorter than 10 s
    FPS_SETTLE_MS: 2000,         // wait after a write/restore before measuring
  };

  // ---------------------------------------------------------------- pure helpers (Node-testable)
  // No browser/GeoFS reference in this block — required so `require('./physics_lab.js')` under
  // plain Node (the unit test) can exercise these without touching window/document/geofs, same
  // split as probe.js and recorder.js.
  const MPS_PER_KT = 0.514444;
  const M_PER_DEG_LAT = 111320;

  function ktToMps(kt) { return typeof kt === 'number' && isFinite(kt) ? kt * MPS_PER_KT : null; }

  function metersPerDegLon(latDeg) {
    return M_PER_DEG_LAT * Math.cos(latDeg * Math.PI / 180);
  }

  // Classifies a readback against the value written and the value before the write. tolerance
  // defaults to 5% of the write's displacement (floored at 1e-6 so a zero-displacement write never
  // divides down to a useless tolerance).
  function classifyHold(baseline, written, read, tolerance) {
    if (![baseline, written, read].every((v) => typeof v === 'number' && isFinite(v))) return 'unknown';
    const tol = typeof tolerance === 'number' && isFinite(tolerance) ? tolerance : Math.max(Math.abs(written - baseline) * 0.05, 1e-6);
    if (Math.abs(read - written) <= tol) return 'held';
    if (Math.abs(read - baseline) <= tol) return 'snapped_back';
    return 'decayed';
  }

  // Moves [lat, lon] by `distM` along `headingDeg`. Flat-earth approximation — fine for the
  // few-hundred-metre nudges the teleport tests use and the ~1.3 km rails run, not a general
  // great-circle solver.
  function advanceLatLon(lat, lon, headingDeg, distM) {
    const headingRad = headingDeg * Math.PI / 180;
    const dNorthM = distM * Math.cos(headingRad);
    const dEastM = distM * Math.sin(headingRad);
    const mPerLon = metersPerDegLon(lat) || 1e-9;
    return { lat: lat + dNorthM / M_PER_DEG_LAT, lon: lon + dEastM / mPerLon };
  }

  // A local-level [east, north, up] m/s guess. UNVERIFIED against GeoFS's real velocity axis
  // convention (it may be ECEF, body-frame, or something else) — that is exactly what the
  // "Speed (b) velocity vector" test exists to check, not an assumption this file relies on.
  function velocityFromHeading(headingDeg, speedMps) {
    const headingRad = headingDeg * Math.PI / 180;
    return [speedMps * Math.sin(headingRad), speedMps * Math.cos(headingRad), 0];
  }

  // Least-squares slope sign over [{atMs, value}] — used to say whether airspeed rose, fell, or
  // stayed flat after a throttle/thrust write without hardcoding a noisy two-point comparison.
  function trend(samples, flatToleranceMpsPerSec) {
    const pts = (samples || []).filter((s) => typeof s.value === 'number' && isFinite(s.value));
    if (pts.length < 2) return 'unknown';
    const n = pts.length;
    const meanX = pts.reduce((a, s) => a + s.atMs, 0) / n;
    const meanY = pts.reduce((a, s) => a + s.value, 0) / n;
    let num = 0, den = 0;
    for (const s of pts) { num += (s.atMs - meanX) * (s.value - meanY); den += (s.atMs - meanX) ** 2; }
    const slopePerMs = den > 0 ? num / den : 0;
    const slopePerSec = slopePerMs * 1000;
    const tol = typeof flatToleranceMpsPerSec === 'number' ? flatToleranceMpsPerSec : 0.5;
    if (slopePerSec > tol) return 'rising';
    if (slopePerSec < -tol) return 'falling';
    return 'flat';
  }

  // One line per test, in the shape the panel's summary table renders — pure, so it's testable
  // against fake result objects without running any test for real.
  function summaryRow(r) {
    let held = r.held;
    if (held === undefined) {
      if (r.stayed !== undefined) held = r.stayed ? 'held' : (r.moved ? 'decayed' : 'no_effect');
      else if (r.continuedFlying !== undefined) held = r.continuedFlying ? 'held' : 'stopped_on_release';
      else held = 'unknown';
    }
    return {
      name: r.name,
      writePath: r.writePath || r.path || r.method || '(n/a)',
      held,
      sideEffects: r.airspeedTrend || r.note || r.error || '',
    };
  }

  function safe(fn, fallback) { try { return fn(); } catch (e) { return fallback; } }

  function classNameOf(proto) {
    return safe(() => proto && proto.constructor && proto.constructor.name, null) || '(anonymous)';
  }

  // Walks the prototype chain of `obj` from its own prototype up to (excluding) Object.prototype,
  // collecting every function declared at each level with its arity. This is what DISCOVER uses to
  // report methods that live on a class (rigidBody, engine, the autopilot object, …) rather than as
  // own properties of the instance — own-key scans like numericCandidates() never see those.
  function walkPrototypeChain(obj) {
    const chain = [];
    if (!obj || typeof obj !== 'object') return chain;
    let proto = Object.getPrototypeOf(obj);
    const seen = new Set();
    while (proto && proto !== Object.prototype && !seen.has(proto)) {
      seen.add(proto);
      const methods = [];
      for (const name of safe(() => Object.getOwnPropertyNames(proto), [])) {
        if (name === 'constructor') continue;
        const desc = safe(() => Object.getOwnPropertyDescriptor(proto, name), null);
        if (!desc || typeof desc.value !== 'function') continue;
        methods.push({ name, arity: desc.value.length });
      }
      chain.push({ className: classNameOf(proto), methods });
      proto = safe(() => Object.getPrototypeOf(proto), null);
    }
    return chain;
  }

  // Own keys of `obj` with their typeof — the DISCOVER report's "own keys" column.
  function describeOwnKeys(obj) {
    if (!obj || typeof obj !== 'object') return [];
    return safe(() => Object.keys(obj), []).map((k) => ({ key: k, type: safe(() => typeof obj[k], 'unknown') }));
  }

  // Every own field of `obj` that is a plain number, or a short (<=16) array-like of only finite
  // numbers, with its current value — the rigidBody position/velocity-vector scan DISCOVER needs,
  // since which field holds velocity vs. position is exactly what's unverified.
  function numericArrayFields(obj) {
    if (!obj || typeof obj !== 'object') return [];
    const out = [];
    for (const k of safe(() => Object.keys(obj), [])) {
      const v = safe(() => obj[k], undefined);
      if (typeof v === 'number' && isFinite(v)) { out.push({ key: k, value: v }); continue; }
      if (v && typeof v.length === 'number' && v.length > 0 && v.length <= 16) {
        const arr = safe(() => Array.prototype.slice.call(v), null);
        if (arr && arr.every((x) => typeof x === 'number' && isFinite(x))) out.push({ key: k, value: arr });
      }
    }
    return out;
  }

  // Absolute angular difference in degrees, wrapped to [0, 180] — used to score autopilot heading
  // follow error without a naive subtraction breaking across the 359->0 wrap.
  function angleDiffDeg(a, b) {
    if (typeof a !== 'number' || typeof b !== 'number' || !isFinite(a) || !isFinite(b)) return null;
    return Math.abs(((a - b) % 360 + 540) % 360 - 180);
  }

  // ------------------------------------------------ GRAPHICS + RUNWAYS pure helpers (Node-testable)
  // Cesium settings the GRAPHICS section reads (and, opt-in, writes), as dot-paths relative to the
  // Cesium Viewer GeoFS exposes. Which of these GeoFS itself drives every frame is exactly what the
  // write tests find out — nothing here assumes any of them sticks.
  const GRAPHICS_PATHS = [
    'resolutionScale',
    'scene.globe.maximumScreenSpaceError',
    'scene.fog.enabled',
    'scene.fog.density',
    'scene.fog.screenSpaceErrorFactor',
    'scene.msaaSamples',
    'scene.postProcessStages.fxaa.enabled',
    'scene.highDynamicRange',
    'scene.postProcessStages.bloom.enabled',
    'scene.globe.enableLighting',
    'scene.shadowMap.enabled',
    'scene.globe.tileCacheSize',
    'scene.globe.preloadSiblings',
  ];

  // Reads a dot-path off `obj`; any missing link or throwing getter reads as undefined.
  function getPath(obj, path) {
    let cur = obj;
    for (const k of String(path).split('.')) {
      if (cur === null || cur === undefined) return undefined;
      try { cur = cur[k]; } catch (e) { return undefined; }
    }
    return cur;
  }

  // Writes a dot-path; returns false (never throws) when the parent is missing or the set throws.
  function setPath(obj, path, value) {
    const keys = String(path).split('.');
    const last = keys.pop();
    const parent = keys.length ? getPath(obj, keys.join('.')) : obj;
    if (parent === null || parent === undefined || typeof parent !== 'object') return false;
    try { parent[last] = value; return true; } catch (e) { return false; }
  }

  // A visibly different, still-sane value to write for the STICKS/REVERTED test. Booleans flip;
  // msaaSamples toggles 1<->4 (Cesium only accepts powers of two); resolutionScale halves/doubles
  // inside [0.25, 2]; other numbers double (or become 1 from 0). Null = not testable.
  function testValueFor(path, current) {
    if (typeof current === 'boolean') return !current;
    if (typeof current !== 'number' || !isFinite(current)) return null;
    if (/msaaSamples$/.test(path)) return current > 1 ? 1 : 4;
    if (/resolutionScale$/.test(path)) return current >= 1 ? 0.5 : 1;
    if (current === 0) return 1;
    return current * 2;
  }

  // STICKS: the readback equals what was written. REVERTED: it's back to the original. CHANGED:
  // neither (GeoFS rewrote it to something else). Numbers compare with a small relative tolerance.
  function classifyStick(original, written, readback) {
    const same = (a, b) => {
      if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= Math.max(1e-9, Math.abs(b) * 1e-6);
      return a === b;
    };
    if (readback === undefined) return 'UNREADABLE';
    if (same(readback, written)) return 'STICKS';
    if (same(readback, original)) return 'REVERTED';
    return 'CHANGED';
  }

  // Average FPS from a list of rAF timestamps (ms). Null when there are fewer than two frames.
  function fpsFromTimestamps(ts) {
    const t = (ts || []).filter((x) => typeof x === 'number' && isFinite(x));
    if (t.length < 2) return null;
    const spanMs = t[t.length - 1] - t[0];
    return spanMs > 0 ? Math.round(((t.length - 1) * 1000 / spanMs) * 10) / 10 : null;
  }

  // Cesium settings that caused visible glitches when written raw (2026-09-24): read by DISCOVER,
  // never written by G1. Anti-aliasing/HDR/bloom belong to GeoFS's own options panel (G2).
  const GLITCHY_GRAPHICS_PATHS = ['scene.msaaSamples', 'scene.highDynamicRange', 'scene.postProcessStages.bloom.enabled'];
  const GRAPHICS_WRITE_PATHS = GRAPHICS_PATHS.filter((p) => GLITCHY_GRAPHICS_PATHS.indexOf(p) < 0);

  // Which rigidBody method the velocity write should call, best first. 4d used to take the first
  // /vel/-named method it found — which was getLinearVelocity. The verified setter
  // (setLinearVelocity([E, N, U]), 2026-09-23) always wins; other set*vel* methods follow; getters
  // are never candidates.
  function rankVelocitySetters(names) {
    const list = (names || []).filter((n) => typeof n === 'string' && /vel/i.test(n) && !/^get/i.test(n));
    const score = (n) => (n === 'setLinearVelocity' ? 0 : /^set.*vel/i.test(n) ? 1 : 2);
    return list.filter((n, i) => list.indexOf(n) === i).sort((a, b) => score(a) - score(b));
  }

  // A/B/A frame-rate comparison: A before the write, B with it, A again after restoring. The
  // baseline is the mean of the two A windows and their disagreement (drift) is the noise floor: a
  // B-vs-baseline delta no bigger than the drift is not a measurement. Null-safe.
  function abaSummary(a1, b, a2) {
    const ok = (x) => typeof x === 'number' && isFinite(x);
    const r1 = (x) => Math.round(x * 10) / 10;
    if (!ok(a1) || !ok(b) || !ok(a2)) return { baseline: null, delta: null, drift: null, significant: false };
    const baseline = (a1 + a2) / 2, delta = b - baseline, drift = Math.abs(a1 - a2);
    return {
      baseline: r1(baseline), delta: r1(delta), drift: r1(drift),
      deltaPct: baseline > 0 ? r1(delta / baseline * 100) : null,
      significant: Math.abs(delta) > Math.max(drift, 1),
    };
  }

  // Straight-and-level cruise check for an FPS run: turning or climbing changes what's on screen
  // (and so the frame rate) more than most settings do.
  function cruiseSteady(sample) {
    const s = sample || {};
    const why = [];
    if (typeof s.roll === 'number' && Math.abs(s.roll) >= 5) why.push('bank ' + Math.round(s.roll) + '°');
    if (typeof s.vsFpm === 'number' && Math.abs(s.vsFpm) >= 300) why.push('vertical speed ' + Math.round(s.vsFpm) + ' fpm');
    if (typeof s.pitch === 'number' && Math.abs(s.pitch) >= 10) why.push('pitch ' + Math.round(s.pitch) + '°');
    return { steady: why.length === 0, why };
  }

  // The course env recipe, duplicated from race.js's G env section (this tool is standalone):
  // env -> what to write into geofs.preferences.weather / graphics.buildings. Keep in sync.
  function envToPrefsPatch(env) {
    if (!env || typeof env !== 'object') return null;
    const out = { manual: false, advanced: null, localTime: null, season: null, buildings: null };
    const w = env.weather;
    if (w) {
      out.advanced = { windSpeedKts: +w.windKt || 0, windDirection: +w.windDir || 0,
        turbulences: +w.turbulence || 0, precipitationAmount: +w.precip || 0 };
      if (typeof w.clouds === 'number' && isFinite(w.clouds)) out.advanced.clouds = w.clouds;
      if (typeof w.fog === 'number' && isFinite(w.fog)) out.advanced.fog = w.fog;
    }
    const t = env.time;
    if (t && typeof t.localHour === 'number' && isFinite(t.localHour)) out.localTime = t.localHour;
    if (t && typeof t.season === 'number' && isFinite(t.season)) out.season = t.season;
    out.manual = !!(out.advanced || out.localTime !== null || out.season !== null);
    if (typeof env.buildings === 'boolean') out.buildings = env.buildings;
    return out.manual || out.buildings !== null ? out : null;
  }
  // What E1 applies: obviously different from a default flight in every channel.
  const SAMPLE_ENV = { buildings: true, time: { localHour: 18.5, season: 75 },
    weather: { clouds: 85, fog: 20, windKt: 15, windDir: 270, turbulence: 10, precip: 30 } };

  function haversineM(lat1, lon1, lat2, lon2) {
    const R = 6371008.8, r = Math.PI / 180;
    const dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  // race/runways/*.json landing zone: 10-30% of the runway length, clamped to 60-450 m, and
  // always at least 60 m deep (a very short or very long runway would otherwise collapse the band
  // to a point). Same rule as race/tools/add_runway.py's default_zone().
  function defaultZone(lengthM) {
    const L = typeof lengthM === 'number' && isFinite(lengthM) && lengthM > 0 ? lengthM : 0;
    const minM = Math.min(Math.max(L * 0.10, 60), 390);
    const maxM = Math.min(Math.max(L * 0.30, minM + 60), 450);
    return { min_m: Math.round(minM * 10) / 10, max_m: Math.round(maxM * 10) / 10 };
  }

  function slugId(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'runway';
  }

  // Our race/runways/*.json shape from a normalized guess (see guessRunway()). Returns null if any
  // field the server needs is missing — export never invents a value.
  function runwayExportShape(g) {
    if (!g) return null;
    const need = ['lat', 'lon', 'headingDeg', 'lengthM'];
    if (!need.every((k) => typeof g[k] === 'number' && isFinite(g[k]))) return null;
    const name = g.name || ((g.icao || 'RWY') + ' ' + (g.ident || Math.round(g.headingDeg / 10)));
    return {
      id: slugId(g.id || name),
      name,
      version: 1,
      thr_lat: Math.round(g.lat * 1e6) / 1e6,
      thr_lon: Math.round(g.lon * 1e6) / 1e6,
      thr_alt_m: typeof g.altM === 'number' && isFinite(g.altM) ? Math.round(g.altM * 10) / 10 : null,
      heading_deg: Math.round((((g.headingDeg % 360) + 360) % 360) * 10) / 10,
      length_m: Math.round(g.lengthM * 10) / 10,
      width_m: typeof g.widthM === 'number' && isFinite(g.widthM) ? Math.round(g.widthM * 10) / 10 : 45,
      zone: defaultZone(g.lengthM),
      notes: g.notes || 'Exported from GeoFS runway data by physics_lab.js — verify threshold/elevation before committing.',
    };
  }

  // Best-effort normalizer for an unknown GeoFS runway record: looks for lat/lon either as named
  // fields or as the first two entries of a location/threshold-ish array, plus heading/length/width
  // by name. Returns null when no plausible lat/lon pair is found. Units are NOT verified — a
  // length in feet would come through as-is; the RUNWAYS report shows the raw record next to the
  // guess so that can be checked by eye.
  function guessRunway(rec) {
    if (!rec || typeof rec !== 'object') return null;
    const keys = safe(() => Object.keys(rec), []);
    const num = (re) => {
      for (const k of keys) {
        if (!re.test(k)) continue;
        const v = safe(() => rec[k], undefined);
        if (typeof v === 'number' && isFinite(v)) return v;
        if (typeof v === 'string' && v.trim() !== '' && isFinite(Number(v))) return Number(v);
      }
      return undefined;
    };
    let lat = num(/^(lat|latitude|thr_?lat)$/i), lon = num(/^(lon|lng|long|longitude|thr_?lon)$/i);
    let arrAlt;
    if (lat === undefined || lon === undefined) {
      for (const k of keys) {
        if (!/loc|thresh|pos|coord|start|lla|point/i.test(k)) continue;
        const v = safe(() => rec[k], undefined);
        if (v && typeof v.length === 'number' && v.length >= 2 && typeof v[0] === 'number' && typeof v[1] === 'number') {
          lat = v[0]; lon = v[1];
          if (typeof v[2] === 'number' && isFinite(v[2])) arrAlt = v[2];
          break;
        }
      }
    }
    if (typeof lat !== 'number' || typeof lon !== 'number' || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    const str = (re) => { for (const k of keys) { const v = safe(() => rec[k], undefined); if (re.test(k) && typeof v === 'string') return v; } return undefined; };
    return {
      lat, lon,
      altM: num(/^(alt|altitude|elev|elevation|alt_?m)$/i) !== undefined ? num(/^(alt|altitude|elev|elevation|alt_?m)$/i) : arrAlt,
      headingDeg: num(/^(heading|hdg|bearing|course|dir|direction|true_?heading)$/i),
      lengthM: num(/^(length|len|length_?m)$/i),
      widthM: num(/^(width|wid|width_?m)$/i),
      icao: str(/^(icao|airport|apt|code)$/i),
      ident: str(/^(ident|name|id|designator|rwy)$/i),
    };
  }

  // Nearest `n` of `items` ([{lat, lon, ...}]) to (lat, lon), each tagged with distM.
  function nearestN(items, lat, lon, n) {
    return (items || [])
      .filter((it) => it && typeof it.lat === 'number' && typeof it.lon === 'number')
      .map((it) => Object.assign({}, it, { distM: Math.round(haversineM(lat, lon, it.lat, it.lon)) }))
      .sort((a, b) => a.distM - b.distM)
      .slice(0, n);
  }

  // ------------------------------------------------------ AIRCRAFT catalogue pure helpers
  // Normalizes whatever shape GeoFS's aircraft catalogue turns out to have (an object keyed by id,
  // or an array of records) into [{id, name, type}]. Unverified against the live site: the report
  // always carries a raw sample next to this so a wrong guess is visible.
  function normalizeAircraftList(src) {
    if (!src || typeof src !== 'object') return [];
    const entries = Array.isArray(src)
      ? src.map((v, i) => [v && (v.id !== undefined ? v.id : v.aircraftId) !== undefined ? (v.id !== undefined ? v.id : v.aircraftId) : i, v])
      : safe(() => Object.keys(src), []).map((k) => [k, safe(() => src[k], undefined)]);
    const out = [];
    for (const [id, v] of entries) {
      if (v === null || v === undefined) continue;
      if (typeof v === 'string') { out.push({ id: String(id), name: v, type: null }); continue; }
      if (typeof v !== 'object') continue;
      const name = ['name', 'fullName', 'label', 'title'].map((k) => safe(() => v[k], undefined)).find((x) => typeof x === 'string');
      const type = ['type', 'category', 'class', 'kind'].map((k) => safe(() => v[k], undefined)).find((x) => typeof x === 'string' || typeof x === 'number');
      out.push({ id: String(id), name: name || null, type: type === undefined ? null : type });
    }
    return out;
  }

  // ---------------------------------------------------------------------------- browser-only part
  function runInBrowser() {
    if (window.__finsPhysicsLab) { window.__finsPhysicsLab.ui.show(); return; }

    function inst() { return safe(() => geofs.aircraft.instance, undefined); }
    function keysOf(obj) { return safe(() => Object.keys(obj), []); }

    // Same regex-scan shape as probe.js's report.controls/report.reposition sections, but returns
    // live get/set closures instead of a one-off value, since these get written to and read back.
    function numericCandidates(sources, re) {
      const out = [];
      for (const { label, obj } of sources) {
        if (!obj || typeof obj !== 'object') continue;
        for (const k of keysOf(obj)) {
          if (!re.test(k)) continue;
          if (safe(() => typeof obj[k], 'unknown') !== 'number') continue;
          out.push({ path: label + '.' + k, get: () => safe(() => obj[k], undefined), set: (v) => { obj[k] = v; } });
        }
      }
      return out;
    }

    function findAutopilotObjects() {
      const sources = [{ label: 'geofs', obj: safe(() => geofs, undefined) }, { label: 'geofs.aircraft.instance', obj: inst() }];
      const found = [];
      for (const { label, obj } of sources) {
        if (!obj) continue;
        for (const k of keysOf(obj)) {
          if (!/autopilot/i.test(k)) continue;
          found.push({ path: label + '.' + k, type: safe(() => typeof obj[k], 'unknown'), obj: safe(() => obj[k], undefined) });
        }
      }
      return found;
    }

    function describeObjectFields(obj) {
      if (!obj || typeof obj !== 'object') return [];
      return keysOf(obj).slice(0, 60).map((k) => ({
        key: k,
        type: safe(() => typeof obj[k], 'unknown'),
        arity: safe(() => (typeof obj[k] === 'function' ? obj[k].length : null), null),
        value: safe(() => (obj[k] && typeof obj[k] === 'object' ? '[object]' : obj[k]), undefined),
      }));
    }

    // Own methods matching a reposition-style name (function fields) plus the /vel/i-matching
    // prototype-chain methods DISCOVER's walkPrototypeChain() turns up — an own-key scan alone
    // misses anything declared on the aircraft's class rather than the instance.
    function findVelocitySetters(rb) {
      if (!rb) return [];
      const out = [];
      for (const k of keysOf(rb)) {
        if (!/vel/i.test(k) || safe(() => typeof rb[k], '') !== 'function') continue;
        out.push({ name: k, arity: safe(() => rb[k].length, null), source: 'own' });
      }
      for (const lvl of walkPrototypeChain(rb)) {
        for (const m of lvl.methods) {
          if (!/vel/i.test(m.name)) continue;
          out.push({ name: m.name, arity: m.arity, source: 'prototype', className: lvl.className });
        }
      }
      return out;
    }

    // Own methods matching /engage|enable|activate|hold/i on the autopilot object, own and
    // prototype-chain — the callable side of autopilot control, as opposed to the on/engaged/
    // headingHold-style boolean flags testAutopilot() already pokes directly.
    function findAutopilotEngageMethods(apObj) {
      if (!apObj) return [];
      const RE = /engage|enable|activate|hold/i;
      const out = [];
      for (const k of keysOf(apObj)) {
        if (!RE.test(k) || safe(() => typeof apObj[k], '') !== 'function') continue;
        out.push({ name: k, arity: safe(() => apObj[k].length, null), source: 'own' });
      }
      for (const lvl of walkPrototypeChain(apObj)) {
        for (const m of lvl.methods) {
          if (!RE.test(m.name)) continue;
          out.push({ name: m.name, arity: m.arity, source: 'prototype', className: lvl.className });
        }
      }
      return out;
    }

    // typeof/arity-free: unlike probe.js's methodCandidates (read-only, never calls), this one is
    // meant to be called — that's the entire point of the physics lab. Own-key matches are tagged
    // source:'own' (testTeleportC's pool); prototype-chain matches (found via walkPrototypeChain,
    // same as DISCOVER) are tagged source:'prototype' (testTeleportE's pool) so the two tests never
    // just re-run the same method.
    function findRepositionMethods() {
      const RE = /flyto|setposition|reposition|teleport|goto|place|reset/i;
      const sources = [
        { label: 'geofs', obj: safe(() => geofs, undefined) },
        { label: 'geofs.aircraft.instance', obj: inst() },
        { label: 'geofs.camera', obj: safe(() => geofs.camera, undefined) },
      ];
      const out = [];
      for (const { label, obj } of sources) {
        if (!obj) continue;
        for (const k of keysOf(obj)) {
          if (!RE.test(k) || safe(() => typeof obj[k], '') !== 'function') continue;
          out.push({ path: label + '.' + k, arity: safe(() => obj[k].length, null), call: (...args) => obj[k](...args), source: 'own' });
        }
        for (const lvl of walkPrototypeChain(obj)) {
          for (const m of lvl.methods) {
            if (!RE.test(m.name)) continue;
            out.push({ path: label + '.prototype(' + lvl.className + ').' + m.name, arity: m.arity, call: (...args) => obj[m.name](...args), source: 'prototype' });
          }
        }
      }
      return out;
    }

    function controlsObj() { return safe(() => window.controls, undefined) || safe(() => geofs.controls, undefined); }

    // Picks the rigidBody's velocity-shaped field to snapshot/restore: a length-3 numeric array
    // named like "velocity", falling back to the first length-3 numeric array found at all, since
    // which field is velocity vs. position is exactly what's unverified here.
    function rigidBodyVelocityField(rb) {
      if (!rb) return null;
      const triples = numericArrayFields(rb).filter((f) => Array.isArray(f.value) && f.value.length === 3);
      return triples.find((f) => /vel/i.test(f.key)) || triples[0] || null;
    }

    function snapshot() {
      const i = inst();
      const rb = safe(() => i.rigidBody, undefined);
      const rbVelField = rigidBodyVelocityField(rb);
      const controls = controlsObj();
      return {
        atMs: safe(() => performance.now(), Date.now()),
        lla: safe(() => i.llaLocation.slice(0, 3), null),
        htr: safe(() => i.htr.slice(0, 3), null),
        trueAirSpeed: safe(() => i.trueAirSpeed, null),
        groundSpeed: safe(() => i.groundSpeed, null),
        velocity: safe(() => (Array.isArray(i.velocity) ? i.velocity.slice() : i.velocity), null),
        kias: safe(() => geofs.animation.values.kias, null),
        rigidBodyVelocity: rbVelField ? { key: rbVelField.key, value: rbVelField.value.slice() } : null,
        controlsThrottle: safe(() => controls.throttle, null),
      };
    }

    function restoreSnapshot(snap) {
      const i = inst();
      if (!snap || !i) return false;
      try {
        if (Array.isArray(snap.lla) && Array.isArray(i.llaLocation)) for (let k = 0; k < 3; k++) i.llaLocation[k] = snap.lla[k];
        if (Array.isArray(snap.htr) && Array.isArray(i.htr)) for (let k = 0; k < 3; k++) i.htr[k] = snap.htr[k];
        if (typeof snap.trueAirSpeed === 'number') i.trueAirSpeed = snap.trueAirSpeed;
        if (typeof snap.groundSpeed === 'number') i.groundSpeed = snap.groundSpeed;
        if (Array.isArray(snap.velocity) && Array.isArray(i.velocity)) for (let k = 0; k < snap.velocity.length; k++) i.velocity[k] = snap.velocity[k];
        if (snap.rigidBodyVelocity) {
          const rb = safe(() => i.rigidBody, undefined);
          const field = rb ? safe(() => rb[snap.rigidBodyVelocity.key], null) : null;
          if (field && typeof field.length === 'number') for (let k = 0; k < snap.rigidBodyVelocity.value.length; k++) field[k] = snap.rigidBodyVelocity.value[k];
        }
        if (typeof snap.controlsThrottle === 'number') {
          const controls = controlsObj();
          if (controls) controls.throttle = snap.controlsThrottle;
        }
        return true;
      } catch (e) { return false; }
    }

    // Re-reads every entry in `readers` at t=0 and again at each delay in `delaysMs` (each entry
    // is a zero-arg function; a throw reads as `undefined`, never crashes the chain). Resolves
    // with { key: [{atMs, value}, ...] }.
    function sampleAfterWrite(readers, delaysMs) {
      return new Promise((resolve) => {
        const t0 = safe(() => performance.now(), Date.now());
        const out = {};
        for (const k in readers) out[k] = [];
        function takeSample() {
          for (const k in readers) out[k].push({ atMs: Math.round(safe(() => performance.now(), Date.now()) - t0), value: safe(readers[k], undefined) });
        }
        takeSample();
        let idx = 0;
        (function schedule() {
          if (idx >= delaysMs.length) { resolve(out); return; }
          const targetMs = delaysMs[idx++];
          const waitMs = Math.max(0, targetMs - (safe(() => performance.now(), Date.now()) - t0));
          setTimeout(() => { takeSample(); schedule(); }, waitMs);
        })();
      });
    }

    // ---- Test 1: Throttle
    async function testThrottle() {
      const pre = snapshot();
      const candidates = numericCandidates([
        { label: 'geofs.controls', obj: safe(() => geofs.controls, undefined) },
        { label: 'geofs.aircraft.instance', obj: inst() },
      ], /throttle|engine|thrust/i);
      if (!candidates.length) return { name: 'throttle', held: 'no_candidate', preSnapshot: pre };
      const target = candidates[0];
      const before = safe(target.get, undefined);
      safe(() => target.set(CONFIG.THROTTLE_VALUE));
      const readback = await sampleAfterWrite({
        throttle: target.get,
        trueAirSpeed: () => safe(() => inst().trueAirSpeed, undefined),
      }, CONFIG.SAMPLE_DELAYS_MS.concat([CONFIG.THROTTLE_AIRSPEED_WINDOW_MS]));
      const lastThrottle = readback.throttle[readback.throttle.length - 1].value;
      return {
        name: 'throttle', writePath: target.path, allCandidates: candidates.map((c) => c.path),
        before, written: CONFIG.THROTTLE_VALUE,
        held: classifyHold(before, CONFIG.THROTTLE_VALUE, lastThrottle),
        airspeedTrend: trend(readback.trueAirSpeed),
        samples: readback, preSnapshot: pre,
      };
    }

    // ---- Test 1b: window.controls.throttle specifically, checking whether geofs.animation.values
    // follows it (the pipeline the model's throttle-lever animation and any HUD reads actually use).
    async function testControlsThrottle() {
      const pre = snapshot();
      const controls = controlsObj();
      if (!controls) return { name: 'controlsThrottle', held: 'no_candidate', preSnapshot: pre };
      const before = safe(() => controls.throttle, undefined);
      try { controls.throttle = 1.0; } catch (e) { return { name: 'controlsThrottle', error: e.message, preSnapshot: pre }; }
      const readback = await sampleAfterWrite({
        controlsThrottle: () => safe(() => controls.throttle, undefined),
        animationThrottle: () => safe(() => geofs.animation.values.throttle, undefined),
        trueAirSpeed: () => safe(() => inst().trueAirSpeed, undefined),
      }, CONFIG.SAMPLE_DELAYS_MS.concat([CONFIG.THROTTLE_AIRSPEED_WINDOW_MS]));
      const lastAnim = readback.animationThrottle[readback.animationThrottle.length - 1].value;
      return {
        name: 'controlsThrottle', before, written: 1.0,
        animationFollowed: typeof lastAnim === 'number' ? Math.abs(lastAnim - 1.0) < 0.05 : 'unknown',
        airspeedTrend: trend(readback.trueAirSpeed),
        samples: readback, preSnapshot: pre,
      };
    }

    // ---- Test 2: Autopilot
    async function testAutopilot() {
      const pre = snapshot();
      const found = findAutopilotObjects();
      if (!found.length) return { name: 'autopilot', held: 'no_candidate', preSnapshot: pre };
      const ap = found[0];
      const fields = describeObjectFields(ap.obj);
      const targetHeading = safe(() => geofs.animation.values.heading360, 0);
      const targetAltitude = safe(() => inst().llaLocation[2] + 200, 1000);
      const targetSpeed = safe(() => inst().trueAirSpeed, 100);
      const attempts = [];
      const tryIt = (label, fn) => { try { fn(); attempts.push({ label, ok: true }); } catch (e) { attempts.push({ label, ok: false, error: e.message }); } };
      tryIt('on=true', () => { ap.obj.on = true; });
      tryIt('engaged=true', () => { ap.obj.engaged = true; });
      tryIt('headingHold+heading', () => { ap.obj.headingHold = true; ap.obj.heading = targetHeading; });
      tryIt('altitudeHold+altitude', () => { ap.obj.altitudeHold = true; ap.obj.altitude = targetAltitude; });
      tryIt('speedHold+speed', () => { ap.obj.speedHold = true; ap.obj.speed = targetSpeed; });
      if (safe(() => typeof ap.obj.engage, '') === 'function') tryIt('engage()', () => ap.obj.engage());
      const readback = await sampleAfterWrite({
        heading: () => safe(() => geofs.animation.values.heading360, undefined),
        altitude: () => safe(() => inst().llaLocation[2], undefined),
        trueAirSpeed: () => safe(() => inst().trueAirSpeed, undefined),
      }, [1000, 3000, 5000, CONFIG.AUTOPILOT_WINDOW_MS]);
      return {
        name: 'autopilot', path: ap.path, fields, attempts,
        targets: { targetHeading, targetAltitude, targetSpeed },
        note: 'held/decayed classification does not apply here — read attempts[] and samples[] to see whether heading/altitude/trueAirSpeed converged toward the targets.',
        samples: readback, preSnapshot: pre,
      };
    }

    // ---- Test 2b: Autopilot via a discovered engage()-style method rather than boolean flags,
    // logging heading/altitude/speed follow error at every sample over the observation window.
    async function testAutopilotEngageMethod() {
      const pre = snapshot();
      const i = inst();
      const found = findAutopilotObjects();
      if (!found.length) return { name: 'autopilotEngageMethod', held: 'no_candidate', preSnapshot: pre };
      const ap = found[0];
      const methods = findAutopilotEngageMethods(ap.obj);
      if (!methods.length) return { name: 'autopilotEngageMethod', path: ap.path, held: 'no_candidate', preSnapshot: pre };
      const targetHeading = safe(() => geofs.animation.values.heading360, 0);
      const targetAltitude = safe(() => i.llaLocation[2] + 200, 1000);
      const targetSpeed = safe(() => i.trueAirSpeed, 100);
      safe(() => { ap.obj.heading = targetHeading; });
      safe(() => { ap.obj.altitude = targetAltitude; });
      safe(() => { ap.obj.speed = targetSpeed; });
      const attempts = methods.map((m) => {
        try {
          if (m.arity >= 1) ap.obj[m.name](true); else ap.obj[m.name]();
          return { name: m.name, source: m.source, ok: true };
        } catch (e) { return { name: m.name, source: m.source, ok: false, error: e.message }; }
      });
      const readback = await sampleAfterWrite({
        heading: () => safe(() => geofs.animation.values.heading360, undefined),
        altitude: () => safe(() => i.llaLocation[2], undefined),
        trueAirSpeed: () => safe(() => i.trueAirSpeed, undefined),
      }, [1000, 3000, 5000, CONFIG.AUTOPILOT_WINDOW_MS]);
      const followError = readback.heading.map((s, idx) => ({
        atMs: s.atMs,
        headingErrDeg: angleDiffDeg(s.value, targetHeading),
        altitudeErrM: typeof readback.altitude[idx].value === 'number' ? Math.abs(readback.altitude[idx].value - targetAltitude) : null,
        speedErrMps: typeof readback.trueAirSpeed[idx].value === 'number' ? Math.abs(readback.trueAirSpeed[idx].value - targetSpeed) : null,
      }));
      return {
        name: 'autopilotEngageMethod', path: ap.path, methodCandidates: methods.map((m) => m.name),
        attempts, targets: { targetHeading, targetAltitude, targetSpeed }, followError,
        samples: readback, preSnapshot: pre,
      };
    }

    // Shared by the three teleport variants: did the position move, and did it stay at the target.
    function classifyTeleport(before, target, lastLla) {
      const moved = !!lastLla && (Math.abs(lastLla[0] - before[0]) > 1e-6 || Math.abs(lastLla[1] - before[1]) > 1e-6);
      const stayed = !!lastLla && Math.abs(lastLla[0] - target[0]) < 1e-4 && Math.abs(lastLla[1] - target[1]) < 1e-4;
      return { moved, stayed };
    }

    // ---- Test 3a: Teleport via direct llaLocation write (the path FlyToStart already uses)
    async function testTeleportA() {
      const pre = snapshot();
      const i = inst();
      if (!i || !Array.isArray(i.llaLocation)) return { name: 'teleportA', held: 'no_candidate', preSnapshot: pre };
      const before = i.llaLocation.slice(0, 3);
      const { lat, lon } = advanceLatLon(before[0], before[1], safe(() => i.htr[0], 0), CONFIG.TELEPORT_OFFSET_M);
      const target = [lat, lon, before[2]];
      try { i.llaLocation[0] = target[0]; i.llaLocation[1] = target[1]; i.llaLocation[2] = target[2]; }
      catch (e) { return { name: 'teleportA', error: e.message, preSnapshot: pre }; }
      const readback = await sampleAfterWrite({
        lla: () => safe(() => inst().llaLocation.slice(0, 3), undefined),
        trueAirSpeed: () => safe(() => inst().trueAirSpeed, undefined),
      }, CONFIG.SAMPLE_DELAYS_MS);
      const cls = classifyTeleport(before, target, readback.lla[readback.lla.length - 1].value);
      return { name: 'teleportA', before, target, ...cls, samples: readback, preSnapshot: pre };
    }

    // ---- Test 3b: Teleport via geofs.resetFlight() pointed at a moved lastFlightCoordinates
    async function testTeleportB() {
      const pre = snapshot();
      const i = inst();
      if (!i || !Array.isArray(i.llaLocation) || safe(() => typeof geofs.resetFlight, '') !== 'function' || !Array.isArray(safe(() => geofs.lastFlightCoordinates, null))) {
        return { name: 'teleportB', held: 'no_candidate', preSnapshot: pre };
      }
      const before = i.llaLocation.slice(0, 3);
      const { lat, lon } = advanceLatLon(before[0], before[1], safe(() => i.htr[0], 0), CONFIG.TELEPORT_OFFSET_M);
      const target = [lat, lon, before[2]];
      const coordsBefore = geofs.lastFlightCoordinates.slice();
      try {
        geofs.lastFlightCoordinates[0] = target[0];
        geofs.lastFlightCoordinates[1] = target[1];
        geofs.lastFlightCoordinates[2] = target[2];
        geofs.resetFlight();
      } catch (e) { return { name: 'teleportB', error: e.message, preSnapshot: pre }; }
      const readback = await sampleAfterWrite({
        lla: () => safe(() => inst().llaLocation.slice(0, 3), undefined),
        trueAirSpeed: () => safe(() => inst().trueAirSpeed, undefined),
      }, CONFIG.SAMPLE_DELAYS_MS);
      const cls = classifyTeleport(before, target, readback.lla[readback.lla.length - 1].value);
      return { name: 'teleportB', before, target, coordsBefore, ...cls, samples: readback, preSnapshot: pre };
    }

    // ---- Test 3c: Teleport via any flyTo/setPosition/reposition method discovered by name, own keys only
    async function testTeleportC() {
      const pre = snapshot();
      const i = inst();
      const methods = findRepositionMethods().filter((m) => m.source === 'own');
      if (!methods.length || !i || !Array.isArray(i.llaLocation)) {
        return { name: 'teleportC', held: 'no_candidate', candidates: methods.map((m) => m.path), preSnapshot: pre };
      }
      const method = methods[0];
      const before = i.llaLocation.slice(0, 3);
      const { lat, lon } = advanceLatLon(before[0], before[1], safe(() => i.htr[0], 0), CONFIG.TELEPORT_OFFSET_M);
      const target = [lat, lon, before[2]];
      let callError = null;
      try { method.call(target[0], target[1], target[2]); } catch (e) { callError = e.message; }
      const readback = await sampleAfterWrite({
        lla: () => safe(() => inst().llaLocation.slice(0, 3), undefined),
        trueAirSpeed: () => safe(() => inst().trueAirSpeed, undefined),
      }, CONFIG.SAMPLE_DELAYS_MS);
      const cls = classifyTeleport(before, target, readback.lla[readback.lla.length - 1].value);
      return { name: 'teleportC', method: method.path, allCandidates: methods.map((m) => m.path), before, target, callError, ...cls, samples: readback, preSnapshot: pre };
    }

    // ---- Test 3d: Teleport via lastFlightCoordinates = [lat, lon, alt, hdg, keepSpeed] + resetFlight()
    // (testTeleportB only ever wrote the first 3 elements; this is the full 5-element shape the game
    // itself appears to write, including heading and the keep-speed-on-reset boolean).
    async function testTeleportD() {
      const pre = snapshot();
      const i = inst();
      if (!i || !Array.isArray(i.llaLocation) || safe(() => typeof geofs.resetFlight, '') !== 'function') {
        return { name: 'teleportD', held: 'no_candidate', preSnapshot: pre };
      }
      const before = i.llaLocation.slice(0, 3);
      const headingBefore = safe(() => i.htr[0], 0);
      const { lat, lon } = advanceLatLon(before[0], before[1], headingBefore, CONFIG.TELEPORT_OFFSET_M);
      const target = [lat, lon, before[2], headingBefore, false];
      const coordsBefore = safe(() => geofs.lastFlightCoordinates.slice(), null);
      try {
        geofs.lastFlightCoordinates = target;
        geofs.resetFlight();
      } catch (e) { return { name: 'teleportD', error: e.message, preSnapshot: pre }; }
      const readback = await sampleAfterWrite({
        lla: () => safe(() => inst().llaLocation.slice(0, 3), undefined),
        trueAirSpeed: () => safe(() => inst().trueAirSpeed, undefined),
        throttle: () => safe(() => controlsObj().throttle, undefined),
      }, CONFIG.SAMPLE_DELAYS_MS);
      const lastLla = readback.lla[readback.lla.length - 1].value;
      const lastSpeed = readback.trueAirSpeed[readback.trueAirSpeed.length - 1].value;
      const lastThrottle = readback.throttle[readback.throttle.length - 1].value;
      const cls = classifyTeleport(before, target.slice(0, 3), lastLla);
      return {
        name: 'teleportD', before, target, coordsBefore, ...cls,
        hasSpeedAfter: typeof lastSpeed === 'number' ? lastSpeed > 0.5 : 'unknown',
        throttleAfter: lastThrottle,
        samples: readback, preSnapshot: pre,
      };
    }

    // ---- Test 3e: Teleport via a prototype-chain reposition method (own-key candidates were already
    // spent by testTeleportC) — the "place/setPosition/reset-style prototype method" DISCOVER surfaces.
    async function testTeleportE() {
      const pre = snapshot();
      const i = inst();
      const methods = findRepositionMethods().filter((m) => m.source === 'prototype');
      if (!methods.length || !i || !Array.isArray(i.llaLocation)) {
        return { name: 'teleportE', held: 'no_candidate', candidates: methods.map((m) => m.path), preSnapshot: pre };
      }
      const method = methods[0];
      const before = i.llaLocation.slice(0, 3);
      const { lat, lon } = advanceLatLon(before[0], before[1], safe(() => i.htr[0], 0), CONFIG.TELEPORT_OFFSET_M);
      const target = [lat, lon, before[2]];
      let callError = null;
      try { method.call(target[0], target[1], target[2]); } catch (e) { callError = e.message; }
      const readback = await sampleAfterWrite({
        lla: () => safe(() => inst().llaLocation.slice(0, 3), undefined),
        trueAirSpeed: () => safe(() => inst().trueAirSpeed, undefined),
      }, CONFIG.SAMPLE_DELAYS_MS);
      const cls = classifyTeleport(before, target, readback.lla[readback.lla.length - 1].value);
      return { name: 'teleportE', method: method.path, allCandidates: methods.map((m) => m.path), before, target, callError, ...cls, samples: readback, preSnapshot: pre };
    }

    // ---- Test 4a: Speed via trueAirSpeed scalar (the write Boost already ships with)
    async function testSpeedScalar() {
      const pre = snapshot();
      const i = inst();
      if (!i) return { name: 'speedScalar', held: 'no_candidate', preSnapshot: pre };
      const before = safe(() => i.trueAirSpeed, null);
      const written = CONFIG.SPEED_TEST_TARGET_MPS;
      try { i.trueAirSpeed = written; } catch (e) { return { name: 'speedScalar', error: e.message, preSnapshot: pre }; }
      const readback = await sampleAfterWrite({ trueAirSpeed: () => safe(() => i.trueAirSpeed, undefined) }, CONFIG.SAMPLE_DELAYS_MS.concat([CONFIG.SPEED_TEST_WINDOW_MS]));
      const last = readback.trueAirSpeed[readback.trueAirSpeed.length - 1].value;
      return { name: 'speedScalar', before, written, held: classifyHold(before, written, last), samples: readback, preSnapshot: pre };
    }

    // ---- Test 4b: Speed via a velocity vector aligned to current heading
    async function testSpeedVelocityVector() {
      const pre = snapshot();
      const i = inst();
      if (!i || !Array.isArray(i.velocity)) return { name: 'speedVelocityVector', held: 'no_candidate', velocityType: safe(() => typeof i.velocity, 'undefined'), preSnapshot: pre };
      const before = i.velocity.slice();
      const written = velocityFromHeading(safe(() => i.htr[0], 0), CONFIG.SPEED_TEST_TARGET_MPS);
      try { for (let k = 0; k < Math.min(3, i.velocity.length); k++) i.velocity[k] = written[k]; }
      catch (e) { return { name: 'speedVelocityVector', error: e.message, preSnapshot: pre }; }
      const readback = await sampleAfterWrite({
        velocity: () => safe(() => i.velocity.slice(), undefined),
        trueAirSpeed: () => safe(() => i.trueAirSpeed, undefined),
      }, CONFIG.SAMPLE_DELAYS_MS.concat([CONFIG.SPEED_TEST_WINDOW_MS]));
      return {
        name: 'speedVelocityVector', before, written, samples: readback, preSnapshot: pre,
        note: 'velocity axis convention (ECEF vs local-level [e,n,u]) is UNVERIFIED — see velocityFromHeading(). Check whether trueAirSpeed/heading actually followed the intended direction.',
      };
    }

    // ---- Test 4c: Speed via a thrust/engine multiplier, if one exists
    async function testSpeedThrustMultiplier() {
      const pre = snapshot();
      const i = inst();
      const candidates = numericCandidates([
        { label: 'geofs.aircraft.instance', obj: i },
        { label: 'geofs', obj: safe(() => geofs, undefined) },
      ], /thrust|engine/i);
      if (!candidates.length) return { name: 'speedThrustMultiplier', held: 'no_candidate', preSnapshot: pre };
      const target = candidates[0];
      const before = safe(target.get, undefined);
      const written = typeof before === 'number' && before !== 0 ? before * 2 : 2;
      safe(() => target.set(written));
      const readback = await sampleAfterWrite({
        field: target.get,
        trueAirSpeed: () => safe(() => i.trueAirSpeed, undefined),
      }, CONFIG.SAMPLE_DELAYS_MS.concat([CONFIG.SPEED_TEST_WINDOW_MS]));
      const last = readback.field[readback.field.length - 1].value;
      return {
        name: 'speedThrustMultiplier', writePath: target.path, allCandidates: candidates.map((c) => c.path),
        before, written, held: classifyHold(before, written, last), airspeedTrend: trend(readback.trueAirSpeed),
        samples: readback, preSnapshot: pre,
      };
    }

    // ---- Test 4d: Speed via rigidBody's velocity field directly (its own setter method if
    // DISCOVER found one, else the numeric array field itself), boosted +50 m/s along heading.
    function applyVelocityWrite(rb, velField, written) {
      // setLinearVelocity([E, N, U]) explicitly — the call verified in-sim on 2026-09-23. Only if
      // this build has no such method does it fall back to the best-ranked other setter.
      if (typeof safe(() => rb.setLinearVelocity, undefined) === 'function') {
        try { rb.setLinearVelocity([written[0], written[1], written[2]]); return { path: 'rigidBody.setLinearVelocity([E,N,U])', ok: true }; }
        catch (e) { /* fall through */ }
      }
      const ranked = rankVelocitySetters(findVelocitySetters(rb).map((x) => x.name));
      if (ranked.length) {
        const name = ranked[0];
        try { rb[name]([written[0], written[1], written[2]]); return { path: 'rigidBody.' + name + '(vec)', ok: true }; }
        catch (e1) {
          try { rb[name](written[0], written[1], written[2]); return { path: 'rigidBody.' + name + '(x,y,z)', ok: true }; }
          catch (e2) { /* fall through to a direct field write */ }
        }
      }
      if (velField) {
        try {
          for (let k = 0; k < 3; k++) rb[velField.key][k] = written[k];
          return { path: 'rigidBody.' + velField.key, ok: true };
        } catch (e) { return { path: 'rigidBody.' + velField.key, ok: false, error: e.message }; }
      }
      return { path: null, ok: false, error: 'no setter or numeric field found' };
    }

    async function testRigidBodyVelocity() {
      const pre = snapshot();
      const i = inst();
      const rb = safe(() => i.rigidBody, undefined);
      if (!rb) return { name: 'rigidBodyVelocity', held: 'no_candidate', preSnapshot: pre };
      const velField = rigidBodyVelocityField(rb);
      // Speed from the rigid body's own v_linearVelocity (verified), not the trueAirSpeed scalar.
      const v0 = safe(() => rb.v_linearVelocity, null);
      const beforeSpeed = (v0 && v0.length >= 3 ? Math.hypot(+v0[0], +v0[1], +v0[2]) : safe(() => i.trueAirSpeed, 0)) || 0;
      const targetSpeed = beforeSpeed + CONFIG.RIGIDBODY_VELOCITY_BOOST_MPS;
      const written = velocityFromHeading(safe(() => i.htr[0], 0), targetSpeed);
      const applied = applyVelocityWrite(rb, velField, written);
      const readback = await sampleAfterWrite({
        kias: () => safe(() => geofs.animation.values.kias, undefined),
        trueAirSpeed: () => safe(() => i.trueAirSpeed, undefined),
      }, [1000, 3000]);
      return {
        name: 'rigidBodyVelocity', applied, before: velField ? velField.value : null, written,
        fieldCandidates: numericArrayFields(rb).filter((f) => Array.isArray(f.value) && f.value.length === 3).map((f) => f.key),
        setterCandidates: rankVelocitySetters(findVelocitySetters(rb).map((s) => s.name)),
        airspeedTrend: trend(readback.kias),
        samples: readback, preSnapshot: pre,
      };
    }

    // ---- Test 4e: Engine thrust x2 for ENGINE_THRUST_BOOST_WINDOW_MS, measuring the kias gain,
    // then explicitly restoring the pre-write value (Restore also covers this via the baseline
    // snapshot, but this test doesn't wait for a manual click to put the multiplier back).
    async function testEngineThrustBoost() {
      const pre = snapshot();
      const i = inst();
      const engineObj = safe(() => i.engine, undefined) || safe(() => i.engines && i.engines[0], undefined);
      if (!engineObj) return { name: 'engineThrustBoost', held: 'no_candidate', preSnapshot: pre };
      const candidates = numericCandidates([{ label: 'engine', obj: engineObj }], /thrust/i);
      if (!candidates.length) return { name: 'engineThrustBoost', held: 'no_candidate', preSnapshot: pre };
      const target = candidates[0];
      const before = safe(target.get, undefined);
      const written = typeof before === 'number' && before !== 0 ? before * 2 : 2;
      safe(() => target.set(written));
      const readback = await sampleAfterWrite({
        kias: () => safe(() => geofs.animation.values.kias, undefined),
        trueAirSpeed: () => safe(() => i.trueAirSpeed, undefined),
      }, [1000, 3000, CONFIG.ENGINE_THRUST_BOOST_WINDOW_MS]);
      safe(() => target.set(before));
      const firstKias = readback.kias[0].value;
      const lastKias = readback.kias[readback.kias.length - 1].value;
      const kiasGain = typeof firstKias === 'number' && typeof lastKias === 'number' ? lastKias - firstKias : null;
      return {
        name: 'engineThrustBoost', writePath: target.path, allCandidates: candidates.map((c) => c.path),
        before, written, restoredTo: before, kiasGain,
        airspeedTrend: trend(readback.kias), samples: readback, preSnapshot: pre,
      };
    }

    // ---- Test 5: Rails — write position/attitude every frame for RAILS_DURATION_MS, then release
    function testRails() {
      const pre = snapshot();
      const i = inst();
      if (!i || !Array.isArray(i.llaLocation) || !Array.isArray(i.htr)) return Promise.resolve({ name: 'rails', held: 'no_candidate', preSnapshot: pre });
      const speedMps = ktToMps(CONFIG.RAILS_SPEED_KT);
      const heading = safe(() => i.htr[0], 0);
      const alt = i.llaLocation[2];
      let lat = i.llaLocation[0], lon = i.llaLocation[1];
      const tickMs = 1000 / CONFIG.RAILS_WRITE_HZ;
      const before = i.llaLocation.slice(0, 3);
      return new Promise((resolve) => {
        let writesSent = 0;
        const timer = setInterval(() => {
          const next = advanceLatLon(lat, lon, heading, speedMps * (tickMs / 1000));
          lat = next.lat; lon = next.lon;
          try {
            i.llaLocation[0] = lat; i.llaLocation[1] = lon; i.llaLocation[2] = alt;
            i.htr[0] = heading;
            writesSent++;
          } catch (e) { /* stop counting, but keep the interval running for the full window */ }
        }, tickMs);
        setTimeout(() => {
          clearInterval(timer);
          const duringSample = { lla: safe(() => i.llaLocation.slice(0, 3), null), trueAirSpeed: safe(() => i.trueAirSpeed, null) };
          sampleAfterWrite({
            lla: () => safe(() => i.llaLocation.slice(0, 3), undefined),
            trueAirSpeed: () => safe(() => i.trueAirSpeed, undefined),
          }, [1000, 2500, CONFIG.RAILS_RELEASE_OBSERVE_MS]).then((afterRelease) => {
            const lastLla = afterRelease.lla[afterRelease.lla.length - 1].value;
            const continuedFlying = !!lastLla && !!duringSample.lla &&
              (Math.abs(lastLla[0] - duringSample.lla[0]) > 1e-6 || Math.abs(lastLla[1] - duringSample.lla[1]) > 1e-6);
            resolve({ name: 'rails', before, writesSent, duringSample, afterRelease, continuedFlying, preSnapshot: pre });
          });
        }, CONFIG.RAILS_DURATION_MS);
      });
    }

    // ---- DISCOVER: read-only field/method report for the objects the write tests above target,
    // so their guessed paths (rigidBody velocity field, engine thrust field, autopilot engage
    // method, reposition methods) can be checked against what's actually there before — or after —
    // running the writes. Never calls anything; same read-only guarantee as probe.js.
    function testDiscover() {
      const i = inst();
      const apFound = findAutopilotObjects();
      const targets = [
        { label: 'geofs.aircraft.instance', obj: i },
        { label: 'geofs.aircraft.instance.rigidBody', obj: safe(() => i.rigidBody, undefined) },
        { label: 'geofs.aircraft.instance.engine', obj: safe(() => i.engine, undefined) },
        { label: 'geofs.aircraft.instance.engines[0]', obj: safe(() => i.engines && i.engines[0], undefined) },
        { label: 'window.controls', obj: controlsObj() },
        { label: 'geofs.aircraft', obj: safe(() => geofs.aircraft, undefined) },
      ];
      if (apFound.length) targets.push({ label: apFound[0].path, obj: apFound[0].obj });

      const report = {};
      for (const { label, obj } of targets) {
        report[label] = {
          present: !!obj,
          ownKeys: describeOwnKeys(obj),
          prototypeChain: walkPrototypeChain(obj),
        };
      }
      const rb = safe(() => i.rigidBody, undefined);
      if (rb) report['geofs.aircraft.instance.rigidBody'].numericArrayFields = numericArrayFields(rb);
      return { name: 'discover', report };
    }

    // ================================================================ GRAPHICS section
    // DISCOVER is read-only. The per-setting write tests and the GeoFS-setting toggle are opt-in
    // (one button each), and every one restores the original value(s) before resolving.
    function cesiumViewer() {
      return safe(() => geofs.api.viewer, undefined) || safe(() => window.viewer, undefined) || null;
    }
    function waitMs(ms) { return new Promise((r) => setTimeout(r, ms)); }

    // One measurement window (>= FPS_WINDOW_MS): rAF-counted FPS plus GeoFS's own geofs.debug.fps
    // sampled once a second. Rendering is forced continuous for the window — scene.requestRenderMode
    // off, and requestRender() every frame — so a static scene can't read as a low frame rate.
    // requestRenderMode is put back when the window ends.
    function measureFps(ms) {
      const windowMs = Math.max(CONFIG.FPS_WINDOW_MS, ms || 0);
      const scene = safe(() => cesiumViewer().scene, null);
      const hadRRM = scene ? safe(() => scene.requestRenderMode, undefined) : undefined;
      if (scene && hadRRM) safe(() => { scene.requestRenderMode = false; });
      return new Promise((resolve) => {
        const ts = [], geo = [];
        const start = safe(() => performance.now(), Date.now());
        const until = start + windowMs;
        let nextGeo = start + 1000;
        (function frame(t) {
          ts.push(t);
          if (scene) safe(() => scene.requestRender());
          if (t >= nextGeo) { nextGeo += 1000; const f = safe(() => +geofs.debug.fps, NaN); if (isFinite(f)) geo.push(f); }
          if (t < until) { requestAnimationFrame(frame); return; }
          if (scene && hadRRM) safe(() => { scene.requestRenderMode = hadRRM; });
          resolve({ fps: fpsFromTimestamps(ts), geofsFps: geo.length ? Math.round(geo.reduce((a, b) => a + b, 0) / geo.length * 10) / 10 : null,
            windowMs, forcedContinuous: !!hadRRM });
        })(start);
      });
    }

    function cruiseSample() {
      const v = safe(() => geofs.animation.values, {}) || {};
      return { roll: v.roll, pitch: v.pitch, vsFpm: typeof v.verticalSpeed === 'number' ? v.verticalSpeed : v.climbrate };
    }

    // A (before) -> apply -> B -> restore -> A (after). Records whether the aircraft was in straight
    // and level cruise at the start (steady:false is reported, not refused — the numbers are just
    // less trustworthy). Always restores, even if apply throws.
    async function measureAba(apply, restore) {
      const cruise = cruiseSteady(cruiseSample());
      const a1 = await measureFps();
      let applied, restored;
      try { applied = apply(); } catch (e) { applied = { error: e.message }; }
      await waitMs(CONFIG.FPS_SETTLE_MS);
      const b = await measureFps();
      try { restored = restore(); } catch (e) { restored = { error: e.message }; }
      await waitMs(CONFIG.FPS_SETTLE_MS);
      const a2 = await measureFps();
      return { a1, b, a2, applied, restored, steady: cruise.steady, steadyWhy: cruise.why,
        rafAba: abaSummary(a1.fps, b.fps, a2.fps), geofsAba: abaSummary(a1.geofsFps, b.geofsFps, a2.geofsFps) };
    }
    const abaNote = (m) => 'fps A/B/A ' + m.a1.fps + ' / ' + m.b.fps + ' / ' + m.a2.fps +
      ' (geofs ' + m.a1.geofsFps + ' / ' + m.b.geofsFps + ' / ' + m.a2.geofsFps + ')' +
      (m.rafAba.significant ? ' delta ' + m.rafAba.delta : ' within noise') + (m.steady ? '' : ' NOT STEADY: ' + m.steadyWhy.join(', '));

    function readGraphics(v) {
      const out = {};
      for (const p of GRAPHICS_PATHS) {
        const val = v ? getPath(v, p) : undefined;
        out[p] = (val === null || typeof val === 'boolean' || typeof val === 'number' || typeof val === 'string') ? val : (val === undefined ? undefined : '[' + typeof val + ']');
      }
      return out;
    }

    // Recursively lists graphics-looking leaves (bool/number/string) under GeoFS preference-ish
    // objects, depth-limited. Read-only.
    const GFX_KEY_RE = /graphic|quality|shadow|fog|resolution|detail|lod|antialias|aa$|hdr|bloom|cloud|light|terrain|tile|sse|fxaa|msaa|water|tree|building|draw|render|fps/i;
    function findGraphicsPrefs() {
      const roots = [
        { label: 'geofs.preferences', obj: safe(() => geofs.preferences, undefined) },
        { label: 'geofs.userRecord', obj: safe(() => geofs.userRecord, undefined) },
        { label: 'geofs.api', obj: safe(() => geofs.api, undefined), shallow: true },
      ];
      const out = [];
      const seen = new Set();
      function walk(label, obj, depth, underGfx) {
        if (!obj || typeof obj !== 'object' || seen.has(obj) || depth > 3 || out.length > 300) return;
        seen.add(obj);
        for (const k of keysOf(obj)) {
          const v = safe(() => obj[k], undefined);
          const hit = underGfx || GFX_KEY_RE.test(k);
          if (typeof v === 'boolean' || typeof v === 'number' || typeof v === 'string') {
            if (hit) out.push({ path: label + '.' + k, type: typeof v, value: v });
          } else if (v && typeof v === 'object' && !Array.isArray(v) && depth < 3) {
            walk(label + '.' + k, v, depth + 1, hit);
          }
        }
      }
      for (const r of roots) walk(r.label, r.obj, r.shallow ? 3 : 0, false);
      return out;
    }

    // GeoFS preference form inputs. GeoFS's options panel binds inputs to preference paths via a
    // data attribute (believed to be data-gespref — unverified, so any data-*pref* attribute counts).
    function findPrefInputs() {
      const els = safe(() => Array.prototype.slice.call(document.querySelectorAll('input,select')), []);
      const out = [];
      for (const el of els) {
        const attrs = safe(() => Array.prototype.slice.call(el.attributes), []);
        const prefAttr = attrs.find((a) => /pref/i.test(a.name));
        if (!prefAttr) continue;
        out.push({ el, attr: prefAttr.name, pref: prefAttr.value, type: el.type || el.tagName.toLowerCase(),
          value: el.type === 'checkbox' ? el.checked : el.value, graphics: GFX_KEY_RE.test(prefAttr.value) });
      }
      return out;
    }

    function findGraphicsFunctions() {
      const RE = /graphic|quality|hd|shadow|fog|resolution|detail|preference|pref|setting|apply/i;
      const sources = [
        { label: 'geofs', obj: safe(() => geofs, undefined) },
        { label: 'geofs.api', obj: safe(() => geofs.api, undefined) },
        { label: 'geofs.preferences', obj: safe(() => geofs.preferences, undefined) },
        { label: 'ui', obj: safe(() => window.ui, undefined) },
      ];
      const out = [];
      for (const { label, obj } of sources) {
        if (!obj) continue;
        for (const k of keysOf(obj)) {
          if (!RE.test(k) || safe(() => typeof obj[k], '') !== 'function') continue;
          out.push({ path: label + '.' + k, arity: safe(() => obj[k].length, null), src: safe(() => String(obj[k]).slice(0, 240), '') });
        }
      }
      return out;
    }

    function testGraphicsDiscover() {
      const v = cesiumViewer();
      return {
        name: 'graphicsDiscover',
        viewerPath: safe(() => geofs.api.viewer, undefined) ? 'geofs.api.viewer' : (v ? 'window.viewer' : null),
        cesiumVersion: safe(() => Cesium.VERSION, null),
        settings: readGraphics(v),
        canvas: safe(() => ({ w: v.scene.canvas.width, h: v.scene.canvas.height, clientW: v.scene.canvas.clientWidth, dpr: window.devicePixelRatio }), null),
        requestRenderMode: safe(() => v.scene.requestRenderMode, undefined),
        targetFrameRate: safe(() => v.targetFrameRate, undefined),
        geofsGraphicsPrefs: findGraphicsPrefs(),
        prefInputs: findPrefInputs().map((p) => ({ attr: p.attr, pref: p.pref, type: p.type, value: p.value, graphics: p.graphics })),
        graphicsFunctions: findGraphicsFunctions(),
        note: 'read-only',
      };
    }

    // One Cesium setting, A/B/A: FPS -> write -> (settle) FPS + readback -> restore -> (settle) FPS.
    async function testGraphicsWrite(path) {
      const v = cesiumViewer();
      if (!v) return { name: 'gfx:' + path, held: 'no_candidate', note: 'no Cesium viewer' };
      if (GLITCHY_GRAPHICS_PATHS.indexOf(path) >= 0) return { name: 'gfx:' + path, writePath: path, held: 'skipped', note: 'raw writes to this caused visible glitches (2026-09-24); use G2' };
      const original = getPath(v, path);
      const written = testValueFor(path, original);
      if (written === null) return { name: 'gfx:' + path, writePath: path, held: 'untestable', original };
      let wrote, readback;
      const m = await measureAba(
        () => { wrote = setPath(v, path, written); return wrote; },
        () => { readback = readback === undefined ? getPath(v, path) : readback; return setPath(v, path, original); });
      const restoredReadback = getPath(v, path);
      return {
        name: 'gfx:' + path, writePath: path, original, written, wrote, readback,
        held: classifyStick(original, written, readback),
        fps: m, restoredOk: classifyStick(written, original, restoredReadback) === 'STICKS',
        note: abaNote(m),
      };
    }

    async function testGraphicsWriteAll() {
      const rows = [];
      for (const p of GRAPHICS_WRITE_PATHS) rows.push(await testGraphicsWrite(p));
      return { name: 'gfx:ALL', held: rows.map((r) => r.held).join(','), rows, note: rows.length + ' settings' };
    }

    // Toggles ONE GeoFS graphics preference through its own options-panel input (checkbox flip or
    // select to the next option, then a 'change' event so GeoFS's handler applies it), re-reads the
    // Cesium settings, then puts the input back and fires 'change' again. Falls back to reporting
    // the candidates when no graphics input exists in the DOM (the options panel may need opening).
    async function testGeofsGraphicsToggle() {
      const v = cesiumViewer();
      const inputs = findPrefInputs().filter((p) => p.graphics);
      const pick = inputs.find((p) => p.type === 'checkbox') || inputs.find((p) => p.el.tagName === 'SELECT');
      if (!pick) return { name: 'gfx:geofsToggle', held: 'no_candidate', prefs: findGraphicsPrefs(),
        note: 'no graphics pref input found in the DOM — open GeoFS Options > Graphics once, then retry' };
      const fire = (el) => { safe(() => el.dispatchEvent(new Event('input', { bubbles: true }))); safe(() => el.dispatchEvent(new Event('change', { bubbles: true }))); };
      const before = readGraphics(v);
      const origVal = pick.type === 'checkbox' ? pick.el.checked : pick.el.value;
      let newVal, after;
      const m = await measureAba(() => {
        if (pick.type === 'checkbox') pick.el.checked = !origVal;
        else { const opts = Array.prototype.slice.call(pick.el.options).map((o) => o.value); pick.el.value = opts[(opts.indexOf(origVal) + 1) % opts.length]; }
        newVal = pick.type === 'checkbox' ? pick.el.checked : pick.el.value;
        fire(pick.el);
      }, () => {
        after = readGraphics(v);
        if (pick.type === 'checkbox') pick.el.checked = origVal; else pick.el.value = origVal;
        fire(pick.el);
      });
      const restoredTo = readGraphics(v);
      const changed = GRAPHICS_PATHS.filter((p) => before[p] !== after[p]).map((p) => ({ path: p, before: before[p], after: after[p] }));
      return {
        name: 'gfx:geofsToggle', writePath: pick.attr + '=' + pick.pref, from: origVal, to: newVal,
        held: changed.length ? 'drives ' + changed.length + ' cesium setting(s)' : 'no cesium change',
        changed, fps: m,
        restoredCleanly: GRAPHICS_PATHS.every((p) => restoredTo[p] === before[p]),
        note: abaNote(m),
      };
    }

    // ================================================================ ENV section
    // Course env (race.js COURSE_ENV): GeoFS's weather, time-of-day and buildings. E0 reads only.
    // E1 applies SAMPLE_ENV with the same recipe as race.js's G env section (after a confirm) and
    // keeps the snapshot; E2 puts it back. geofs.savePreferences() is never called.
    const envState = { snap: null, did: [] };
    function readEnv() {
      const W = safe(() => window.weather, undefined);
      return {
        weatherPrefs: safe(() => JSON.parse(JSON.stringify(geofs.preferences.weather)), null),
        buildingsPref: safe(() => geofs.preferences.graphics.buildings, undefined),
        weatherFunctions: W ? keysOf(W).filter((k) => safe(() => typeof W[k], '') === 'function') : [],
        setBuildings: safe(() => typeof geofs.api.setBuildings, 'undefined'),
        buildingsInitDestroy: safe(() => [typeof geofs.buildings.init, typeof geofs.buildings.destroy], null),
        setTimeAndDate: safe(() => typeof geofs.api.setTimeAndDate, 'undefined'),
        debugFps: safe(() => geofs.debug.fps, undefined),
      };
    }
    function testEnvDiscover() { return { name: 'envDiscover', ...readEnv(), note: 'read-only' }; }
    async function testEnvApply() {
      if (envState.snap) return { name: 'envApply', held: 'already applied', note: 'run E2 (restore) first' };
      if (!window.confirm('Physics Lab: apply the sample env (overcast, fog, wind 270/15, 18:30, buildings on)? E2 puts it back.')) return { name: 'envApply', held: 'cancelled' };
      const W = safe(() => window.weather, undefined);
      const pw = safe(() => geofs.preferences.weather, undefined);
      if (!W || !pw) return { name: 'envApply', held: 'no_candidate', note: 'no weather global or geofs.preferences.weather' };
      const patch = envToPrefsPatch(SAMPLE_ENV);
      envState.snap = { weather: JSON.parse(JSON.stringify(pw)), buildings: safe(() => geofs.preferences.graphics.buildings, undefined) };
      const did = [], errors = [];
      const call = (what, fn) => { try { fn(); return true; } catch (e) { errors.push(what + ': ' + e.message); return false; } };
      pw.manual = true;
      if (call('weather', () => { pw.advanced = pw.advanced || {}; Object.assign(pw.advanced, patch.advanced); W.setAdvanced(); })) did.push('weather');
      if (call('time', () => { pw.localTime = patch.localTime; pw.season = patch.season; W.setDateAndTime(); })) did.push('time');
      if (call('buildings', () => { geofs.api.setBuildings(patch.buildings); if (geofs.preferences.graphics) geofs.preferences.graphics.buildings = patch.buildings; })) did.push('buildings');
      envState.did = did;
      await waitMs(2000);
      return { name: 'envApply', writePath: 'preferences.weather + setAdvanced/setDateAndTime/setBuildings', held: did.join('+') || 'nothing',
        errors, applied: SAMPLE_ENV, readback: readEnv(), note: 'E2 restores' };
    }
    async function testEnvRestore() {
      if (!envState.snap) return { name: 'envRestore', held: 'nothing to restore' };
      const W = safe(() => window.weather, undefined);
      const errors = [];
      const call = (what, fn) => { try { fn(); } catch (e) { errors.push(what + ': ' + e.message); } };
      call('prefs', () => { const pw = geofs.preferences.weather; for (const k of Object.keys(pw)) delete pw[k]; Object.assign(pw, envState.snap.weather); });
      if (W) { call('refresh', () => W.refresh()); if (envState.did.indexOf('time') >= 0) call('time', () => W.setDateAndTime()); }
      if (envState.did.indexOf('buildings') >= 0 && typeof envState.snap.buildings === 'boolean') {
        call('buildings', () => { geofs.api.setBuildings(envState.snap.buildings); if (geofs.preferences.graphics) geofs.preferences.graphics.buildings = envState.snap.buildings; });
      }
      const want = JSON.stringify(envState.snap.weather);
      envState.snap = null; envState.did = [];
      await waitMs(2000);
      const now = readEnv();
      return { name: 'envRestore', held: JSON.stringify(now.weatherPrefs) === want ? 'prefs identical' : 'prefs differ (refresh may have pulled METAR)', errors, readback: now };
    }

    // ================================================================ RUNWAYS section
    // Read-only discovery of GeoFS's airport/runway data, the takeoff/approach start entry points,
    // and an "export nearest runway" in race/runways/*.json shape. Only "Try approach start" writes
    // (it calls a GeoFS function that moves the aircraft) and it asks for confirmation first.
    const RWY_KEY_RE = /runway|airport|nav|icao|apt|aerodrome/i;

    function findRunwayContainers() {
      const roots = [
        { label: 'geofs', obj: safe(() => geofs, undefined) },
        { label: 'geofs.nav', obj: safe(() => geofs.nav, undefined) },
        { label: 'geofs.api', obj: safe(() => geofs.api, undefined) },
        { label: 'geofs.runways', obj: safe(() => geofs.runways, undefined) },
        { label: 'window', obj: window, shallow: true },
      ];
      const WINDOW_RE = /runway|airport|aerodrome/i;
      const out = [];
      const seen = new Set();
      for (const { label, obj, shallow } of roots) {
        if (!obj || typeof obj !== 'object') continue;
        for (const k of keysOf(obj)) {
          if (shallow && !WINDOW_RE.test(k)) continue;
          if (!shallow && label === 'geofs' && !RWY_KEY_RE.test(k)) continue;
          const v = safe(() => obj[k], undefined);
          if (!v || (typeof v !== 'object' && typeof v !== 'function') || seen.has(v)) continue;
          seen.add(v);
          const size = typeof v === 'object' ? safe(() => (Array.isArray(v) ? v.length : Object.keys(v).length), 0) : null;
          const firstKey = typeof v === 'object' ? safe(() => Object.keys(v)[0], undefined) : undefined;
          const first = firstKey !== undefined ? safe(() => v[firstKey], undefined) : undefined;
          out.push({
            path: label + '.' + k, type: typeof v, size, firstKey,
            firstEntry: first && typeof first === 'object' ? describeOwnKeys(first).slice(0, 30) : safe(() => (typeof first === 'function' ? '[function/' + first.length + ']' : first), undefined),
            firstEntrySample: first && typeof first === 'object' ? safe(() => JSON.stringify(first).slice(0, 400), '(unserializable)') : undefined,
            obj: v,
          });
        }
      }
      return out;
    }

    // Walks every container found above (plus one level of nesting, e.g. airport -> runways[])
    // and collects anything guessRunway() can place, capped so a worldwide DB can't hang the tab.
    function collectRunwayRecords(containers) {
      const recs = [];
      const seenRecs = new Set();
      const CAP = 200000;
      let visited = 0;
      function consider(path, rec, depth) {
        if (visited++ > CAP || !rec || typeof rec !== 'object' || seenRecs.has(rec)) return;
        seenRecs.add(rec);
        const g = safe(() => guessRunway(rec), null);
        if (g) { recs.push(Object.assign({ path, raw: rec }, g)); return; }
        if (depth > 0) return;
        for (const k of safe(() => Object.keys(rec), []).slice(0, 50)) {
          const v = safe(() => rec[k], undefined);
          if (v && typeof v === 'object') consider(path + '.' + k, v, depth + 1);
        }
      }
      for (const c of containers) {
        if (typeof c.obj !== 'object') continue;
        const keys = safe(() => Object.keys(c.obj), []);
        for (const k of keys) { if (visited > CAP) break; consider(c.path + '[' + JSON.stringify(k) + ']', safe(() => c.obj[k], undefined), 0); }
      }
      return recs;
    }

    function findStartFunctions() {
      const RE = /approach|takeoff|take_off|final|flyto|goto|runway|airport|setlocation|location/i;
      const sources = [
        { label: 'geofs', obj: safe(() => geofs, undefined) },
        { label: 'geofs.runways', obj: safe(() => geofs.runways, undefined) },
        { label: 'geofs.nav', obj: safe(() => geofs.nav, undefined) },
        { label: 'geofs.api', obj: safe(() => geofs.api, undefined) },
        { label: 'ui', obj: safe(() => window.ui, undefined) },
        { label: 'ui.panel', obj: safe(() => window.ui.panel, undefined) },
      ];
      const out = [];
      for (const { label, obj } of sources) {
        if (!obj) continue;
        for (const k of keysOf(obj)) {
          if (!RE.test(k) || safe(() => typeof obj[k], '') !== 'function') continue;
          const fn = obj[k];
          out.push({ path: label + '.' + k, arity: safe(() => fn.length, null),
            signature: safe(() => (String(fn).match(/^[^{]*/) || [''])[0].trim().slice(0, 160), ''),
            src: safe(() => String(fn).slice(0, 400), ''), call: (...a) => fn.apply(obj, a) });
        }
        for (const lvl of walkPrototypeChain(obj)) {
          for (const m of lvl.methods) {
            if (!RE.test(m.name)) continue;
            out.push({ path: label + '.prototype(' + lvl.className + ').' + m.name, arity: m.arity,
              src: safe(() => String(obj[m.name]).slice(0, 400), ''), call: (...a) => obj[m.name].apply(obj, a) });
          }
        }
      }
      return out;
    }

    // DOM elements that look like GeoFS's takeoff / approach start buttons, with whatever handler
    // info is visible: inline onclick, data-* attributes, and jQuery-bound handlers ($._data).
    function findStartButtons() {
      const els = safe(() => Array.prototype.slice.call(document.querySelectorAll('button,a,li,div,span,input[type=button]')), []);
      const out = [];
      for (const el of els) {
        const text = safe(() => (el.value || el.textContent || '').trim(), '');
        if (!text || text.length > 40 || !/take ?off|approach|final|runway/i.test(text)) continue;
        if (el.children && el.children.length > 2) continue;
        if (safe(() => el.closest('#fins-physics-lab'), null)) continue;
        const data = {};
        for (const a of safe(() => Array.prototype.slice.call(el.attributes), [])) if (/^data-|onclick/i.test(a.name)) data[a.name] = a.value.slice(0, 200);
        const jq = safe(() => {
          const ev = window.jQuery && window.jQuery._data(el, 'events');
          if (!ev) return undefined;
          const o = {};
          for (const t in ev) o[t] = ev[t].map((h) => String(h.handler).slice(0, 300));
          return o;
        }, undefined);
        out.push({ tag: el.tagName.toLowerCase(), id: el.id || undefined, cls: String(el.className || '').slice(0, 80), text, attrs: data, jqueryHandlers: jq });
        if (out.length >= 30) break;
      }
      return out;
    }

    function aircraftLatLon() {
      const lla = safe(() => inst().llaLocation, null);
      return lla ? { lat: lla[0], lon: lla[1] } : null;
    }

    const runwayState = { nearest: [], startFns: [] };

    function testRunwaysDiscover() {
      const pos = aircraftLatLon();
      const containers = findRunwayContainers();
      const recs = collectRunwayRecords(containers);
      const near = pos ? nearestN(recs, pos.lat, pos.lon, 5) : [];
      runwayState.nearest = near;
      runwayState.startFns = findStartFunctions();
      return {
        name: 'runwaysDiscover',
        aircraft: pos,
        containers: containers.map((c) => ({ path: c.path, type: c.type, size: c.size, firstKey: c.firstKey, firstEntry: c.firstEntry, firstEntrySample: c.firstEntrySample })),
        recordsFound: recs.length,
        nearest5: near.map((r) => ({ path: r.path, distM: r.distM,
          guess: { lat: r.lat, lon: r.lon, altM: r.altM, headingDeg: r.headingDeg, lengthM: r.lengthM, widthM: r.widthM, icao: r.icao, ident: r.ident },
          rawKeys: describeOwnKeys(r.raw).slice(0, 40), raw: safe(() => JSON.stringify(r.raw).slice(0, 600), '(unserializable)') })),
        startFunctions: runwayState.startFns.map((f) => ({ path: f.path, arity: f.arity, signature: f.signature, src: f.src })),
        startButtons: findStartButtons(),
        note: 'read-only; units of guessed length/width/alt are unverified (check raw)',
      };
    }

    function testExportNearestRunway() {
      if (!runwayState.nearest.length) testRunwaysDiscover();
      const r = runwayState.nearest[0];
      if (!r) return { name: 'runwayExport', held: 'no_candidate', note: 'no runway record with a lat/lon was found' };
      const shape = runwayExportShape(r);
      const text = shape ? JSON.stringify(shape, null, 2) : null;
      if (text && navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).catch(() => {});
      return { name: 'runwayExport', writePath: r.path, held: shape ? 'copied' : 'incomplete', distM: r.distM, export: shape,
        missing: shape ? [] : ['lat', 'lon', 'headingDeg', 'lengthM'].filter((k) => typeof r[k] !== 'number'),
        note: shape ? 'race/runways JSON copied to clipboard (thr_alt_m null = GeoFS record had no elevation)' : 'record lacks heading/length — see RUNWAYS DISCOVER raw' };
    }

    // Opt-in: calls the best approach-start candidate once, for the nearest runway, after a
    // confirm() — moves the aircraft. Records what it called and where the aircraft ended up.
    async function testTryApproachStart() {
      if (!runwayState.nearest.length) testRunwaysDiscover();
      const r = runwayState.nearest[0];
      const fns = runwayState.startFns.filter((f) => /approach|final/i.test(f.path));
      const fn = fns[0];
      if (!fn) return { name: 'approachStart', held: 'no_candidate', note: 'no approach/final-named function found — see startButtons in RUNWAYS DISCOVER' };
      if (!window.confirm('Physics Lab: call ' + fn.path + '(' + (r ? r.path : 'no runway') + ')? This moves the aircraft.')) {
        return { name: 'approachStart', held: 'cancelled', writePath: fn.path };
      }
      const pre = snapshot();
      let ret, error;
      try { ret = fn.arity === 0 ? fn.call() : fn.call(r ? r.raw : undefined); } catch (e) { error = e.message; }
      const readback = await sampleAfterWrite({
        lla: () => safe(() => inst().llaLocation.slice(0, 3), undefined),
        heading: () => safe(() => geofs.animation.values.heading360, undefined),
        kias: () => safe(() => geofs.animation.values.kias, undefined),
      }, [1000, 3000]);
      const last = readback.lla[readback.lla.length - 1].value;
      return { name: 'approachStart', writePath: fn.path, arity: fn.arity, runway: r ? r.path : null,
        returned: safe(() => JSON.stringify(ret).slice(0, 200), String(ret)), error,
        held: error ? 'threw' : (last && r ? 'distToRunway ' + Math.round(haversineM(last[0], last[1], r.lat, r.lon)) + ' m' : 'unknown'),
        samples: readback, preSnapshot: pre };
    }

    // ================================================================ AIRCRAFT section
    // Read-only: GeoFS's aircraft catalogue (id, name, type) and the current aircraft's id — the
    // ids bush courses need in their `aircraftId`. "Copy aircraft list" copies it as JSON.
    function findAircraftCatalogues() {
      const out = [];
      const direct = [
        ['geofs.aircraftList', () => geofs.aircraftList],
        ['geofs.aircraft.list', () => geofs.aircraft.list],
        ['geofs.aircraft.aircraftList', () => geofs.aircraft.aircraftList],
        ['window.aircraftList', () => window.aircraftList],
      ];
      const seen = new Set();
      for (const [path, get] of direct) {
        const v = safe(get, undefined);
        if (v && typeof v === 'object' && !seen.has(v)) { seen.add(v); out.push({ path, obj: v }); }
      }
      for (const [label, root] of [['geofs', safe(() => geofs, undefined)], ['geofs.aircraft', safe(() => geofs.aircraft, undefined)]]) {
        if (!root) continue;
        for (const k of keysOf(root)) {
          if (!/aircraft.*(list|catalog|db|data)|(list|catalog)/i.test(k)) continue;
          const v = safe(() => root[k], undefined);
          if (v && typeof v === 'object' && !seen.has(v)) { seen.add(v); out.push({ path: label + '.' + k, obj: v }); }
        }
      }
      return out;
    }

    // The aircraft picker in the DOM: any element carrying a data-*aircraft* attribute.
    function findAircraftPickerItems() {
      const els = safe(() => Array.prototype.slice.call(document.querySelectorAll('[data-aircraft],[data-aircraftid],[data-aircraft-id]')), []);
      return els.slice(0, 500).map((el) => ({
        id: el.getAttribute('data-aircraft') || el.getAttribute('data-aircraftid') || el.getAttribute('data-aircraft-id'),
        name: safe(() => (el.textContent || '').trim().slice(0, 60), ''),
      }));
    }

    const aircraftState = { list: [] };

    function testAircraftDiscover() {
      const cats = findAircraftCatalogues();
      const best = cats.map((c) => ({ path: c.path, list: normalizeAircraftList(c.obj) }))
        .sort((a, b) => b.list.filter((x) => x.name).length - a.list.filter((x) => x.name).length)[0];
      const picker = findAircraftPickerItems();
      aircraftState.list = best && best.list.length ? best.list : picker.map((p) => ({ id: p.id, name: p.name, type: null }));
      const i = inst();
      return {
        name: 'aircraftDiscover',
        held: aircraftState.list.length + ' aircraft',
        current: { id: safe(() => i.id, null), aircraftRecordId: safe(() => i.aircraftRecord.id, null),
          name: safe(() => i.aircraftRecord.name, null) || safe(() => i.name, null) },
        source: best ? best.path : (picker.length ? 'DOM picker [data-aircraft]' : null),
        catalogues: cats.map((c) => ({ path: c.path, size: safe(() => Object.keys(c.obj).length, 0),
          sample: safe(() => JSON.stringify(c.obj[Object.keys(c.obj)[0]]).slice(0, 300), '(unserializable)') })),
        pickerItems: picker.length,
        aircraft: aircraftState.list,
        note: 'read-only; fill bush courses\' aircraftId from these ids',
      };
    }

    function copyAircraftList() {
      if (!aircraftState.list.length) testAircraftDiscover();
      const text = JSON.stringify({ current: safe(() => inst().id, null), aircraft: aircraftState.list }, null, 1);
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).catch(() => {});
      return { name: 'aircraftCopy', held: 'copied ' + aircraftState.list.length, note: 'aircraft list JSON copied to clipboard' };
    }

    // ---------------------------------------------------------------------------------- UI + glue
    const state = { baseline: snapshot(), results: [] };

    function outputResults(ui) {
      const blob = { generatedAt: new Date().toISOString(), url: safe(() => location.href, ''), baseline: state.baseline, results: state.results };
      let text;
      try { text = JSON.stringify(blob, null, 1); } catch (e) { text = JSON.stringify({ error: 'failed to serialize: ' + e.message }); }
      ui.setOutput(text);
      ui.setTable(state.results.map(summaryRow));
      console.log('[finsPhysicsLab]', text);
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).catch(() => {});
    }

    function runTest(ui, label, fn) {
      ui.setStatus('Running ' + label + '…');
      Promise.resolve(fn()).then((result) => {
        state.results.push(result);
        outputResults(ui);
        ui.setStatus('Done: ' + label + '. ' + state.results.length + ' result(s) so far.');
      }).catch((e) => {
        state.results.push({ name: label, error: e.message });
        outputResults(ui);
        ui.setStatus(label + ' threw: ' + e.message);
      });
    }

    const ui = buildUi([
      { label: '0. DISCOVER', run: testDiscover },
      { label: '1. Throttle', run: testThrottle },
      { label: '1b. controls.throttle', run: testControlsThrottle },
      { label: '2. Autopilot', run: testAutopilot },
      { label: '2b. Autopilot engage()', run: testAutopilotEngageMethod },
      { label: '3a. Teleport A (lla write)', run: testTeleportA },
      { label: '3b. Teleport B (resetFlight)', run: testTeleportB },
      { label: '3c. Teleport C (flyTo/setPosition)', run: testTeleportC },
      { label: '3d. Teleport D (lastFlightCoordinates+reset)', run: testTeleportD },
      { label: '3e. Teleport E (prototype method)', run: testTeleportE },
      { label: '4a. Speed scalar', run: testSpeedScalar },
      { label: '4b. Speed velocity vector', run: testSpeedVelocityVector },
      { label: '4c. Speed thrust multiplier', run: testSpeedThrustMultiplier },
      { label: '4d. Speed rigidBody velocity', run: testRigidBodyVelocity },
      { label: '4e. Engine thrust boost (5s)', run: testEngineThrustBoost },
      { label: '5. Rails (10s)', run: testRails },
      { label: 'G0. GRAPHICS DISCOVER (read-only)', run: testGraphicsDiscover },
      { label: 'G1. Graphics write ALL (A/B/A, ~6 min, restores)', run: testGraphicsWriteAll },
    ].concat(GRAPHICS_WRITE_PATHS.map((p) => ({ label: 'G1. write ' + p, run: () => testGraphicsWrite(p) }))).concat([
      { label: 'G2. Toggle one GeoFS graphics setting (A/B/A)', run: testGeofsGraphicsToggle },
      { label: 'E0. ENV DISCOVER (read-only)', run: testEnvDiscover },
      { label: 'E1. Apply sample env (weather/time/buildings)', run: testEnvApply },
      { label: 'E2. Restore env', run: testEnvRestore },
      { label: 'R0. RUNWAYS DISCOVER (read-only)', run: testRunwaysDiscover },
      { label: 'R1. Export nearest runway (copies JSON)', run: testExportNearestRunway },
      { label: 'R2. Try approach start here (moves aircraft)', run: testTryApproachStart },
      { label: 'A0. AIRCRAFT DISCOVER (read-only)', run: testAircraftDiscover },
      { label: 'A1. Copy aircraft list (JSON)', run: copyAircraftList },
    ]), runTest, () => {
      const ok = restoreSnapshot(state.baseline);
      ui.setStatus(ok ? 'Restored to the baseline snapshot taken when the panel loaded.' : 'Restore failed — see console.');
    }, () => outputResults(ui));

    window.__finsPhysicsLab = { state, ui };
    ui.setStatus('Baseline snapshot taken. Fly a throwaway flight — every button below writes to sim state.');
  }

  // Minimal floating panel: a warning line, a status line, one button per test, Restore, and a
  // scrollable JSON output box plus a summary table. Same DOM/style conventions as recorder.js's
  // buildUi (fixed position, monospace, dark background) so it reads as part of the same tool family.
  function buildUi(tests, runTest, onRestore, onCopy) {
    const box = document.createElement('div');
    box.id = 'fins-physics-lab';
    box.style.cssText = 'position:fixed;top:8px;right:8px;z-index:999999;background:rgba(20,20,20,.92);' +
      'color:#eee;font:12px/1.4 monospace;padding:8px 10px;border-radius:6px;width:340px;max-height:90vh;' +
      'overflow:auto;box-shadow:0 2px 8px rgba(0,0,0,.4);';

    const title = document.createElement('div');
    title.textContent = 'FINSONLY PHYSICS LAB — debug only';
    title.style.cssText = 'font-weight:bold;margin-bottom:2px;';
    box.appendChild(title);

    const warning = document.createElement('div');
    warning.textContent = 'WRITES to sim state. Use on a throwaway flight.';
    warning.style.cssText = 'color:#f88;margin-bottom:6px;';
    box.appendChild(warning);

    const status = document.createElement('div');
    status.style.cssText = 'margin-bottom:6px;white-space:normal;';
    box.appendChild(status);

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;flex-direction:column;gap:4px;margin-bottom:6px;';
    for (const t of tests) {
      const b = document.createElement('button');
      b.textContent = t.label;
      b.style.cssText = 'font:inherit;padding:3px 6px;cursor:pointer;text-align:left;';
      b.addEventListener('click', () => runTest(uiHandle, t.label, t.run));
      btnRow.appendChild(b);
    }
    box.appendChild(btnRow);

    const controlRow = document.createElement('div');
    controlRow.style.cssText = 'display:flex;gap:4px;margin-bottom:6px;';
    const restoreBtn = document.createElement('button');
    restoreBtn.textContent = 'Restore';
    restoreBtn.style.cssText = 'font:inherit;padding:3px 8px;cursor:pointer;background:#642;color:#fff;';
    restoreBtn.addEventListener('click', onRestore);
    controlRow.appendChild(restoreBtn);
    const copyBtn = document.createElement('button');
    copyBtn.textContent = 'Copy report (JSON)';
    copyBtn.style.cssText = 'font:inherit;padding:3px 8px;cursor:pointer;';
    copyBtn.addEventListener('click', onCopy);
    controlRow.appendChild(copyBtn);
    box.appendChild(controlRow);

    const table = document.createElement('table');
    table.style.cssText = 'width:100%;border-collapse:collapse;margin-bottom:6px;font-size:11px;';
    box.appendChild(table);

    const output = document.createElement('textarea');
    output.readOnly = true;
    output.style.cssText = 'width:100%;height:160px;font:11px/1.3 monospace;background:#111;color:#9f9;border:1px solid #444;';
    box.appendChild(output);

    document.body.appendChild(box);

    const uiHandle = {
      setStatus(text) { status.textContent = text; },
      setOutput(text) { output.value = text; },
      setTable(rows) {
        table.innerHTML = '';
        const header = document.createElement('tr');
        ['test', 'write', 'held?', 'notes'].forEach((h) => {
          const th = document.createElement('th');
          th.textContent = h;
          th.style.cssText = 'text-align:left;border-bottom:1px solid #555;padding:2px 4px;';
          header.appendChild(th);
        });
        table.appendChild(header);
        for (const row of rows) {
          const tr = document.createElement('tr');
          [row.name, row.writePath, row.held, row.sideEffects].forEach((cell) => {
            const td = document.createElement('td');
            td.textContent = cell === undefined || cell === null ? '' : String(cell);
            td.style.cssText = 'padding:2px 4px;border-bottom:1px solid #333;vertical-align:top;';
            tr.appendChild(td);
          });
          table.appendChild(tr);
        }
      },
      show() { box.style.display = ''; },
    };
    return uiHandle;
  }

  // Run the real thing only in a browser with a DOM and geofs to attach to; under Node (the unit
  // test) this file just exports its pure functions and touches nothing browser-specific — same
  // split as probe.js/recorder.js/terrain_probe.js.
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    runInBrowser();
  } else if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      MPS_PER_KT, M_PER_DEG_LAT, ktToMps, metersPerDegLon, classifyHold, advanceLatLon, velocityFromHeading, trend, summaryRow,
      classNameOf, walkPrototypeChain, describeOwnKeys, numericArrayFields, angleDiffDeg,
      GRAPHICS_PATHS, getPath, setPath, testValueFor, classifyStick, fpsFromTimestamps, haversineM, defaultZone,
      slugId, runwayExportShape, guessRunway, nearestN,
      rankVelocitySetters, abaSummary, cruiseSteady, envToPrefsPatch, SAMPLE_ENV, GRAPHICS_WRITE_PATHS, GLITCHY_GRAPHICS_PATHS,
      normalizeAircraftList,
    };
  }
})();
