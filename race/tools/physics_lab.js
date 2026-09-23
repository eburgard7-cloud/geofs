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

    // typeof/arity-free: unlike probe.js's methodCandidates (read-only, never calls), this one is
    // meant to be called — that's the entire point of the physics lab.
    function findRepositionMethods() {
      const RE = /flyto|setposition|reposition|teleport|goto/i;
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
          out.push({ path: label + '.' + k, arity: safe(() => obj[k].length, null), call: (...args) => obj[k](...args) });
        }
      }
      return out;
    }

    function snapshot() {
      const i = inst();
      return {
        atMs: safe(() => performance.now(), Date.now()),
        lla: safe(() => i.llaLocation.slice(0, 3), null),
        htr: safe(() => i.htr.slice(0, 3), null),
        trueAirSpeed: safe(() => i.trueAirSpeed, null),
        groundSpeed: safe(() => i.groundSpeed, null),
        velocity: safe(() => (Array.isArray(i.velocity) ? i.velocity.slice() : i.velocity), null),
        kias: safe(() => geofs.animation.values.kias, null),
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

    // ---- Test 3c: Teleport via any flyTo/setPosition/reposition method discovered by name
    async function testTeleportC() {
      const pre = snapshot();
      const i = inst();
      const methods = findRepositionMethods();
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
      { label: '1. Throttle', run: testThrottle },
      { label: '2. Autopilot', run: testAutopilot },
      { label: '3a. Teleport A (lla write)', run: testTeleportA },
      { label: '3b. Teleport B (resetFlight)', run: testTeleportB },
      { label: '3c. Teleport C (flyTo/setPosition)', run: testTeleportC },
      { label: '4a. Speed scalar', run: testSpeedScalar },
      { label: '4b. Speed velocity vector', run: testSpeedVelocityVector },
      { label: '4c. Speed thrust multiplier', run: testSpeedThrustMultiplier },
      { label: '5. Rails (10s)', run: testRails },
    ], runTest, () => {
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
    copyBtn.textContent = 'Copy JSON';
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
    module.exports = { MPS_PER_KT, M_PER_DEG_LAT, ktToMps, metersPerDegLon, classifyHold, advanceLatLon, velocityFromHeading, trend, summaryRow };
  }
})();
