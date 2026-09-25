/*
 * FINSONLY Racing — ROBOT TEST PILOT (dev-only bookmarklet; flies the aircraft on the autopilot).
 *
 * Flies every course gate to gate, or every landing runway down its virtual ILS, on the GeoFS
 * autopilot and reports what doesn't work: a gate buried in a ridge, a turn too tight to make, an
 * approach that meets terrain or a runway GeoFS draws somewhere else. The report JSON feeds
 * race/tools/robot_report.py, which writes docs/reports/<date>/ROBOT.md with suggested fixes.
 * Nothing is ever fixed automatically.
 *
 * Needs race.js loaded first. Everything it does to the sim goes through race.js's own
 * window.__finsRace.dev (CONFIG.DEV_API): GeoPhysics for every write (airStart, autopilotTo,
 * setThrottle for the go-around), the G reads for every sensor, CourseEnv for weather/time, and
 * the trace encoder for the House ghost. This file never names GeoFS's globals itself, and
 * race/test/run.js fails if it does.
 *
 * It never switches aircraft (there is no verified GeoFS call for that): a batch is grouped by the
 * aircraft each course needs and pauses for you to switch, and a course flown in the wrong aircraft
 * is SKIPPED, not flown. It never loads a course into the race either, so no run is ever posted to
 * a leaderboard. A PASS can be uploaded as the course's House ghost (POST /ghosts/house, admin token).
 *
 * The flight logic is two pure controllers, makeCourseFlight() and makeApproachFlight(): a sensor
 * reading goes in and an autopilot command comes out. race/test/run.js flies both against a
 * kinematic model. The browser half below them only reads sensors, calls tick() and executes
 * what comes back.
 */
(function () {
  'use strict';

  // ================================================================ pure half (Node-testable)
  const ROBOT = {
    VERSION: 1,
    STEER_MS: 500,               // autopilot targets at 2 Hz
    TICK_MS: 50,                 // sensor sampling (gate crossing, terrain, trace) at 20 Hz
    BANK_DEG: 25,                // the bank the turn-lead maths assumes the autopilot flies
    MIN_HAGL_M: 15,              // abort below this height above ground
    TIMEOUT_PAD_S: 120,          // per-course timeout = 2 x (length / speed) + this
    ALT_LOOKAHEAD_S: 10,         // aim the leg altitude this far ahead
    MISS_MARGIN_M: 400,          // an undecided gate is missed once we are this far past our closest approach
    TRACE_HZ: 4,
    TRACE_MAX: 6000,
    TERRAIN_MARGIN_M: 150,       // robot_report.py's gate-bump target (FORMATION_ALT_MARGIN_M / check_terrain.py)
    APPROACH_STOP_FT: 50,        // fly the approach down to this AGL, then go around
    GO_AROUND_FT: 1500,          // go-around altitude above the threshold
    GO_AROUND_MS: 8000,          // how long to watch the climb before calling the approach done
    APPROACH_TIMEOUT_PAD_S: 90,
    GS_LEAD_S: 2,                // command the glidepath altitude this far ahead (the autopilot lags)
    SHORT_FINAL_M: 926,          // 0.5 nm: terrain inside this is the runway environment, not the approach
    APPROACH_TERRAIN_M: 60,      // the IDEAL glidepath must clear terrain by min(this, half its own height) outside
                                 // short final, or TERRAIN (check_terrain.py --approach's required_clearance_m)
    SPAWN_LOW_M: 150,            // spawning closer than this to terrain = SPAWN_LOW
    GRID_PILOTS: 6,              // COURSE mode checks slot 1 and slot GRID_PILOTS of a grid this size...
    GRID_LEAD_S: 45,             // ...at this lead (the longest COUNTDOWN_LEAD_PRESETS_S), and flies slot 1
    OFFSET_WARN_M: 15,           // GeoFS's runway threshold vs the JSON's, beyond this = OFFSET
  };
  const BUSH_CUP = 'Bush Cup';
  const DEFAULT_AIRCRAFT = '7';   // F-16
  const BUSH_AIRCRAFT = '13';     // DHC-2 Beaver

  const fin = (n) => typeof n === 'number' && Number.isFinite(n);
  const r1 = (n) => (fin(n) ? Math.round(n * 10) / 10 : null);

  // Which aircraft a course is flown in: its own lock, else the Beaver for the Bush Cup, else the F-16.
  function robotAircraftFor(course, cup) {
    const lock = course && course.aircraftId != null && course.aircraftId !== '' ? String(course.aircraftId) : null;
    if (lock) return lock;
    return cup === BUSH_CUP ? BUSH_AIRCRAFT : DEFAULT_AIRCRAFT;
  }
  // Order a batch so aircraft switches are as few as possible: the aircraft you are sitting in first,
  // then the rest by aircraft id, keeping the list's own order inside each group.
  // items: [{id, aircraftId, ...}] -> [{aircraftId, items: [...]}]
  function batchPlan(items, currentAircraftId) {
    const groups = new Map();
    for (const it of Array.isArray(items) ? items : []) {
      const a = String(it.aircraftId || DEFAULT_AIRCRAFT);
      if (!groups.has(a)) groups.set(a, []);
      groups.get(a).push(it);
    }
    const cur = currentAircraftId == null ? '' : String(currentAircraftId);
    return [...groups.keys()]
      .sort((a, b) => (a === cur ? -1 : b === cur ? 1 : Number(a) - Number(b) || a.localeCompare(b)))
      .map((a) => ({ aircraftId: a, items: groups.get(a) }));
  }
  function courseLengthM(gates, lib) {
    let m = 0;
    for (let i = 1; i < gates.length; i++) m += lib.haversineM(gates[i - 1], gates[i]);
    return m;
  }
  function courseTimeoutMs(lengthM, speedMps, padS) {
    const pad = fin(padS) ? padS : ROBOT.TIMEOUT_PAD_S;
    return Math.round((2 * Math.max(0, lengthM) / Math.max(1, speedMps) + pad) * 1000);
  }
  // Signed offset of a point from the line a->b, + = right of the direction of travel (metres).
  function sideOfLineM(a, b, p, lib) {
    const d = lib.haversineM(a, p);
    if (!(d > 0)) return 0;
    const rel = (lib.bearingDeg(a, p) - lib.bearingDeg(a, b)) * Math.PI / 180;
    return d * Math.sin(rel);
  }

  // The course controller. course: a normalized course ({gates: [{lat, lon, alt, radius}]}).
  // opts: {speedMps (required), spawn: {lat, lon, alt}, and any ROBOT key}. lib: __finsRace.dev
  // (or race.js's _internals in the tests). tick(reading) takes
  // {tMs, lat, lon, alt, haglM, groundContact, heading, pitch, roll} and returns
  // {cmd: {courseDeg, altFt, speedKt} | null, done}. result() is the gate log for classifyCourse().
  function makeCourseFlight(course, opts, lib) {
    const o = Object.assign({}, ROBOT, opts || {});
    const gates = course.gates;
    const n = gates.length;
    const centers = gates.map((g) => lib.ecef(g.lat, g.lon, g.alt));
    const speedMps = o.speedMps;
    const speedKt = lib.msToKt(speedMps);
    const spawn = o.spawn || gates[0];
    const lengthM = courseLengthM(gates, lib);
    const st = {
      target: 0, next: 0, t0: null, finishMs: null, lastSteer: -Infinity, startT: null, prev: null,
      abort: null, done: false, trace: lib.traceEmpty(),
      timeoutMs: courseTimeoutMs(lengthM + lib.haversineM(spawn, gates[0]), speedMps, o.TIMEOUT_PAD_S),
      gates: gates.map((g, i) => ({ n: i + 1, crossed: false, missed: false, closestM: null, radiusM: g.radius,
        sideM: null, legMinHaglM: null, gateHaglM: null, legMs: null, legStartT: null, crossT: null })),
    };
    const legFrom = (i) => (i > 0 ? gates[i - 1] : spawn);
    const decide = (i, how, tMs) => {
      const g = st.gates[i];
      if (how === 'crossed') { g.crossed = true; g.crossT = tMs; } else g.missed = true;
      g.legMs = g.legStartT != null ? Math.round(tMs - g.legStartT) : null;
      st.next = i + 1;
      if (st.next < n) st.gates[st.next].legStartT = tMs;
    };
    const stop = (reason, r, extra) => {
      st.abort = Object.assign({ reason, gate: Math.min(st.next, n - 1) + 1, haglM: r1(r && r.haglM), tMs: r ? Math.round(r.tMs - st.startT) : null }, extra || {});
      st.done = true;
    };
    function tick(r) {
      if (st.done) return { cmd: null, done: true };
      if (st.startT == null) { st.startT = r.tMs; st.gates[0].legStartT = r.tMs; }
      const p1 = lib.ecef(r.lat, r.lon, r.alt);
      const p0 = st.prev ? st.prev.p : p1, t0 = st.prev ? st.prev.t : r.tMs;
      // Closest approach (and the height above ground there) to the gate we owe next and the one after.
      for (let i = st.next; i < Math.min(n, st.next + 2); i++) {
        const g = st.gates[i];
        const d = lib.vlen(lib.sub(p1, centers[i]));
        if (g.closestM == null || d < g.closestM) {
          g.closestM = d; g.gateHaglM = fin(r.haglM) ? r.haglM : g.gateHaglM;
          g.sideM = sideOfLineM(legFrom(i), gates[i], r, lib);
        }
      }
      if (st.next < n && fin(r.haglM)) {
        const g = st.gates[st.next];
        g.legMinHaglM = g.legMinHaglM == null ? r.haglM : Math.min(g.legMinHaglM, r.haglM);
      }
      // In-order crossing, interpolated inside the frame: the race's own detectGates rule.
      if (st.prev && st.next < n) {
        const th = lib.segHit(p0, p1, centers[st.next], gates[st.next].radius);
        if (th >= 0) {
          const at = t0 + th * (r.tMs - t0);
          if (st.next === 0) st.t0 = at;
          decide(st.next, 'crossed', at);
          if (st.next >= n) st.finishMs = Math.round(at - st.t0);
        }
      }
      // A gate guidance has already left behind, and that we are now well past: missed, fly on.
      if (st.next < n && st.target > st.next) {
        const g = st.gates[st.next];
        if (g.closestM != null && lib.vlen(lib.sub(p1, centers[st.next])) > g.closestM + o.MISS_MARGIN_M) decide(st.next, 'missed', r.tMs);
      }
      if (st.t0 != null) {
        const s = { t: r.tMs - st.t0, lat: r.lat, lon: r.lon, alt: r.alt, heading: r.heading, pitch: r.pitch, roll: r.roll };
        st.trace = st.finishMs != null ? lib.traceAppend(st.trace, { ...s, t: Math.max(s.t, st.finishMs) }, 1000, o.TRACE_MAX)
          : lib.traceAppend(st.trace, s, o.TRACE_HZ, o.TRACE_MAX);
      }
      st.prev = { p: p1, t: r.tMs };
      if (st.next >= n) { st.done = true; return { cmd: null, done: true }; }
      if (r.groundContact === true) { stop('ground', r); return { cmd: null, done: true }; }
      if (fin(r.haglM) && r.haglM < o.MIN_HAGL_M) { stop('terrain', r); return { cmd: null, done: true }; }
      if (r.tMs - st.startT > st.timeoutMs) { stop('timeout', r); return { cmd: null, done: true }; }
      if (r.tMs - st.lastSteer < o.STEER_MS) return { cmd: null, done: false };
      st.lastSteer = r.tMs;
      const pos = { lat: r.lat, lon: r.lon };
      const ng = lib.Guidance.nextGateIndex({ target: st.target }, pos, gates, speedMps, o.BANK_DEG,
        { crossed: (i) => st.gates[i].crossed || st.gates[i].missed });
      st.target = Math.min(n - 1, Math.max(st.target, st.next, ng.target));
      const gate = gates[st.target], from = legFrom(st.target);
      const legM = lib.haversineM(from, gate), distM = lib.haversineM(pos, gate);
      const frac = legM > 0 ? 1 - distM / legM + speedMps * o.ALT_LOOKAHEAD_S / legM : 1;
      const tgt = lib.Guidance.legTargetAltM(from, gate, frac);
      const alt = lib.Guidance.altitudeCmdFt({ altM: r.alt, targetAltM: tgt, distM, speedMps });
      return { cmd: { courseDeg: lib.bearingDeg(pos, gate), altFt: alt.altFt, speedKt }, done: false };
    }
    function result() {
      const traceOk = st.finishMs != null && !st.trace.truncated && st.trace.samples.length >= 2;
      return {
        gates: st.gates.map((g) => ({ n: g.n, crossed: g.crossed, missed: g.missed, radiusM: g.radiusM,
          missM: r1(g.closestM), sideM: r1(g.sideM), legMinHaglM: r1(g.legMinHaglM), gateHaglM: r1(g.gateHaglM), legMs: g.legMs })),
        abort: st.abort, timeMs: st.finishMs, lengthM: Math.round(lengthM),
        trace: traceOk ? lib.traceEncode(st.trace) : null,
      };
    }
    return { tick, result, state: st };
  }

  // The grid spawns COURSE mode checks (safe-starts): the last slot of an n-pilot grid, then slot 1,
  // at leadS — the two ends of the grid, laterally and (without a floor) in altitude — on the
  // course's own `start` line when it has one (race.js gridSlot()). Slot 1, last in the list, is flown.
  function robotGridSpawns(course, speedMps, lib, leadS, n) {
    const [g1, g2] = course.gates;
    const m = Math.max(1, Math.round(+n) || ROBOT.GRID_PILOTS);
    const idx = m > 1 ? [m - 1, 0] : [0];
    return idx.map((i) => Object.assign({ slot: i + 1, of: m }, lib.gridSlot(g1, g2, i, m, leadS, speedMps, course.start)));
  }

  // PASS | FAIL(reason) | UNREACHABLE(gate n) | SKIPPED(aircraft) | SPAWN_LOW(slot). log: makeCourseFlight().result(),
  // or {abort: {reason: 'spawn' | 'aircraft' | 'stopped', detail}} for a course that never flew.
  function classifyCourse(log) {
    const out = (status, reason, gate) => ({ status, reason, gate: gate || null,
      label: status === 'PASS' ? 'PASS' : status + '(' + (status === 'UNREACHABLE' ? 'gate ' + gate : reason) + ')' });
    const a = log && log.abort;
    const gates = (log && log.gates) || [];
    if (a && a.reason === 'aircraft') return out('SKIPPED', 'aircraft');
    if (a && a.reason === 'spawn') return out('FAIL', 'spawn failed' + (a.detail ? ': ' + a.detail : ''));
    if (a && a.reason === 'stopped') return out('FAIL', 'stopped');
    const buried = gates.find((g) => fin(g.gateHaglM) && g.gateHaglM < 0);
    if (buried) return out('UNREACHABLE', 'gate below terrain', buried.n);
    if (a && a.reason === 'timeout') return out('UNREACHABLE', 'leg timeout', a.gate);
    if (a && a.reason === 'terrain') return out('FAIL', 'terrain on leg ' + a.gate + ', ' + a.haglM + ' m AGL', a.gate);
    if (a && a.reason === 'ground') return out('FAIL', 'ground contact on leg ' + a.gate, a.gate);
    const missed = gates.filter((g) => g.missed).map((g) => g.n);
    if (missed.length) return out('FAIL', 'missed gate' + (missed.length > 1 ? 's ' : ' ') + missed.join(', '), missed[0]);
    if (!gates.length || !gates.every((g) => g.crossed)) return out('FAIL', 'incomplete');
    // log.spawns (robotGridSpawns, each after its settle): a spawn under SPAWN_LOW_M, or one the
    // race.js spawn guard had to re-place, means the course's offline `start` data is wrong.
    const low = (Array.isArray(log.spawns) ? log.spawns : []).find((s) => s && ((fin(s.haglM) && s.haglM < ROBOT.SPAWN_LOW_M) || s.guard));
    if (low) return out('SPAWN_LOW', 'grid slot ' + low.slot + ' of ' + low.of + (low.guard ? ' needed the spawn guard (' + low.guard.haglM + ' m AGL)' : ' at ' + low.haglM + ' m AGL'));
    return out('PASS');
  }

  // The approach controller: fly the runway's virtual ILS down to APPROACH_STOP_FT, then go around.
  // rw: a runway ({thr_lat, thr_lon, thr_alt_m, heading_deg, length_m}). opts: {speedKt, glideDeg,
  // and any ROBOT key}. tick() returns {cmd, goAround, done}. goAround is true exactly once, on the
  // tick the go-around starts, and the caller adds full throttle then.
  function makeApproachFlight(rw, opts, lib) {
    const o = Object.assign({}, ROBOT, opts || {});
    const G = lib.Guidance;
    const speedKt = o.speedKt, speedMps = lib.ktToMs(speedKt);
    const glideDeg = fin(o.glideDeg) && o.glideDeg > 0 ? o.glideDeg : 3;
    const st = { phase: 'approach', startT: null, lastSteer: -Infinity, goT: null, done: false, abort: null,
      spawnHaglM: null, spawnDistM: null, minHaglM: null, minAtNm: null, minGpClearM: null, minGpClearAtNm: null, minGpNeedM: null,
      at1nm: null, atHalfNm: null, at50: null, profile: [], lastProfileD: null, timeoutMs: null };
    const snap = (dev, r) => ({ distNm: r1(dev.distToThrM / 1852), crossM: r1(dev.crossM), locDots: r1(dev.locDots), gsDots: r1(dev.gsDots), haglM: r1(r.haglM) });
    const stop = (reason, r, extra) => { st.abort = Object.assign({ reason, haglM: r1(r && r.haglM) }, extra || {}); st.done = true; };
    function tick(r) {
      if (st.done) return { cmd: null, goAround: false, done: true };
      const dev = G.ilsDeviation(rw, r.lat, r.lon, r.alt, { glideDeg });
      if (!dev) { stop('no runway geometry', r); return { cmd: null, goAround: false, done: true }; }
      if (st.startT == null) {
        st.startT = r.tMs; st.spawnHaglM = r1(r.haglM); st.spawnDistM = dev.distToThrM;
        st.timeoutMs = Math.round((2 * Math.max(0, dev.distToThrM) / Math.max(1, speedMps) + o.APPROACH_TIMEOUT_PAD_S) * 1000);
      }
      if (st.phase === 'goaround') {
        if (r.tMs - st.goT >= o.GO_AROUND_MS) st.done = true;
        return { cmd: null, goAround: false, done: st.done };
      }
      const d = dev.distToThrM;
      if (fin(r.haglM) && d > o.SHORT_FINAL_M) {
        if (st.minHaglM == null || r.haglM < st.minHaglM) { st.minHaglM = r.haglM; st.minAtNm = d / 1852; }
        // How far the IDEAL glidepath clears the ground here, whatever the robot's own tracking error:
        // the terrain's height above the threshold is (alt - thr) - hAGL.
        const thr = +rw.thr_alt_m || 0;
        const gpH = G.glidepathAltM(rw, d, glideDeg) - thr;
        const clear = gpH - ((r.alt - thr) - r.haglM);
        const need = Math.min(o.APPROACH_TERRAIN_M, 0.5 * gpH);
        if (st.minGpClearM == null || need - clear > st.minGpNeedM - st.minGpClearM) {
          st.minGpClearM = clear; st.minGpClearAtNm = d / 1852; st.minGpNeedM = need;
        }
      }
      if (!st.at1nm && d <= 1852) st.at1nm = snap(dev, r);
      if (!st.atHalfNm && d <= 926) st.atHalfNm = snap(dev, r);
      if (d <= 1852 && (st.lastProfileD == null || st.lastProfileD - d >= 100)) {
        st.lastProfileD = d; st.profile.push({ distNm: r1(d / 1852), haglM: r1(r.haglM), aboveGpM: r1(dev.aboveGpM) });
      }
      if (r.groundContact === true) { stop('ground', r, { distNm: r1(d / 1852) }); return { cmd: null, goAround: false, done: true }; }
      if (fin(r.haglM) && r.haglM < o.MIN_HAGL_M && d > 300) { stop('terrain', r, { distNm: r1(d / 1852) }); return { cmd: null, goAround: false, done: true }; }
      if (r.tMs - st.startT > st.timeoutMs) { stop('timeout', r, { distNm: r1(d / 1852) }); return { cmd: null, goAround: false, done: true }; }
      const aglFt = fin(r.haglM) ? r.haglM / 0.3048 : null;
      if ((aglFt != null && aglFt <= o.APPROACH_STOP_FT) || d <= -100) {
        st.at50 = Object.assign(snap(dev, r), { aglFt: r1(aglFt) });
        st.phase = 'goaround'; st.goT = r.tMs;
        const altFt = Math.round(((+rw.thr_alt_m || 0) / 0.3048) + o.GO_AROUND_FT);
        return { cmd: { courseDeg: +rw.heading_deg, altFt, speedKt: speedKt + 20 }, goAround: true, done: false };
      }
      if (r.tMs - st.lastSteer < o.STEER_MS) return { cmd: null, goAround: false, done: false };
      st.lastSteer = r.tMs;
      const s = G.approachSteer(rw, dev, { speedMps, glideDeg, leadS: o.GS_LEAD_S });
      return { cmd: { courseDeg: s.courseDeg, altFt: s.altFt, speedKt }, goAround: false, done: false };
    }
    function result() {
      return { spawnHaglM: st.spawnHaglM, spawnDistNm: r1(st.spawnDistM / 1852), minHaglM: r1(st.minHaglM), minAtNm: r1(st.minAtNm),
        minGpClearM: r1(st.minGpClearM), minGpClearAtNm: r1(st.minGpClearAtNm), minGpNeedM: r1(st.minGpNeedM), at1nm: st.at1nm, atHalfNm: st.atHalfNm, at50: st.at50, profile: st.profile,
        abort: st.abort, glideDeg };
    }
    return { tick, result, state: st };
  }

  // Where GeoFS's own runway record puts the threshold relative to the runway JSON. The record's
  // shape is unverified (G.nearestRunway is TODO-PROBE), so this tries the likely field names and
  // returns null rather than guessing when none parse.
  function runwayRecordOffset(record, rw, lib) {
    if (!record || typeof record !== 'object' || !rw) return null;
    const pairs = [['lat', 'lon'], ['latitude', 'longitude'], ['thresholdLat', 'thresholdLon'], ['threshold_lat', 'threshold_lon']];
    let pt = null;
    for (const [a, b] of pairs) if (fin(record[a]) && fin(record[b])) { pt = { lat: record[a], lon: record[b] }; break; }
    if (!pt) for (const k of ['threshold', 'location', 'position', 'start']) {
      const v = record[k];
      if (Array.isArray(v) && fin(v[0]) && fin(v[1]) && Math.abs(v[0]) <= 90) { pt = { lat: v[0], lon: v[1] }; break; }
    }
    if (!pt) return null;
    const f = lib.Guidance.runwayFrame(rw, pt.lat, pt.lon);
    if (!f) return null;
    const hk = ['heading', 'trueHeading', 'hdg', 'heading_deg'].find((k) => fin(record[k]));
    const hdgDiff = hk ? ((record[hk] - rw.heading_deg + 540) % 360) - 180 : null;
    return { alongM: r1(f.alongM), crossM: r1(f.crossM), headingDiffDeg: r1(hdgDiff), fields: Object.keys(record).slice(0, 20) };
  }

  // PASS | TERRAIN(min m at nm) | OFFSET(m) | SPAWN_LOW | FAIL(reason). log: makeApproachFlight().result()
  // plus an optional geofsOffset (runwayRecordOffset), or {abort: {reason: 'spawn' | 'stopped', ...}}.
  function classifyApproach(log, opts) {
    const o = Object.assign({}, ROBOT, opts || {});
    const out = (status, reason) => ({ status, reason: reason || null, label: status === 'PASS' ? 'PASS' : status + (reason ? '(' + reason + ')' : '') });
    const a = log && log.abort;
    if (a && a.reason === 'aircraft') return out('SKIPPED', 'aircraft');
    if (a && a.reason === 'spawn') return out('FAIL', 'spawn failed' + (a.detail ? ': ' + a.detail : ''));
    if (a && a.reason === 'stopped') return out('FAIL', 'stopped');
    if (fin(log.spawnHaglM) && log.spawnHaglM < o.SPAWN_LOW_M) return out('SPAWN_LOW', log.spawnHaglM + ' m AGL at spawn');
    if (a && (a.reason === 'terrain' || a.reason === 'ground')) return out('TERRAIN', a.haglM + ' m at ' + a.distNm + ' nm');
    const need = fin(log.minGpNeedM) ? log.minGpNeedM : o.APPROACH_TERRAIN_M;
    if (fin(log.minGpClearM) && log.minGpClearM < need) return out('TERRAIN', log.minGpClearM + ' m at ' + log.minGpClearAtNm + ' nm');
    if (a) return out('FAIL', a.reason);
    if (!log.at50) return out('FAIL', 'never reached ' + o.APPROACH_STOP_FT + ' ft');
    const off = log.geofsOffset;
    if (off && fin(off.crossM) && Math.abs(off.crossM) > o.OFFSET_WARN_M) return out('OFFSET', off.crossM + ' m');
    return out('PASS');
  }

  // Landing-cup group from a runway's notes, the same leading-word rule LANDING_CUPS.md uses.
  const RUNWAY_GROUPS = ['White-Knuckle', 'Beach & Island', 'Mountain', 'Home', 'Bush Strips'];
  function runwayGroupOf(notes) {
    const s = typeof notes === 'string' ? notes.trim() : '';
    return RUNWAY_GROUPS.find((g) => s.startsWith(g + '.')) || 'More runways';
  }

  // The report robot_report.py reads. results: [{kind, id, name, group, aircraftId, status, label,
  // reason, gate, timeMs, log}] (the trace is stripped: it goes to /ghosts/house, not the report).
  function reportJson(results, meta) {
    const m = meta || {};
    return {
      v: ROBOT.VERSION, kind: 'robot-report', generated_at: m.generatedAt || new Date().toISOString(),
      client_version: m.clientVersion || '', mode: m.mode || 'course', bank_deg: ROBOT.BANK_DEG,
      results: (Array.isArray(results) ? results : []).map((r) => {
        const log = r.log ? Object.assign({}, r.log) : null;
        if (log) delete log.trace;
        return { kind: r.kind, id: r.id, name: r.name || r.id, group: r.group || null, aircraftId: r.aircraftId || null,
          status: r.status, label: r.label, reason: r.reason || null, gate: r.gate || null, timeMs: r.timeMs == null ? null : r.timeMs,
          courseHash: r.courseHash || null, log };
      }),
    };
  }
  function houseUploadBody(courseId, courseHash, log, model) {
    if (!log || !log.trace || !fin(log.timeMs)) return null;
    return { course_id: courseId, course_hash: courseHash, time_ms: log.timeMs, model: String(model || '').slice(0, 32), trace: log.trace };
  }

  const pure = {
    ROBOT, robotAircraftFor, batchPlan, courseLengthM, courseTimeoutMs, sideOfLineM, makeCourseFlight, classifyCourse, robotGridSpawns,
    makeApproachFlight, runwayRecordOffset, classifyApproach, runwayGroupOf, RUNWAY_GROUPS, reportJson, houseUploadBody,
  };
  if (typeof window === 'undefined') { module.exports = pure; return; }

  // ================================================================ browser half
  const FR = window.__finsRace;
  const dev = FR && FR.dev;
  if (!dev) { alert('FINSONLY robot: load FINSONLY Racing (race.js) first. CONFIG.DEV_API must be on.'); return; }
  if (window.__finsRobot) { window.__finsRobot.show(); return; }
  const C = dev.config;
  const api = (p) => (C.API_BASE || '').replace(/\/$/, '') + p;
  const TOKEN_KEY = 'finsRobot.adminToken';
  const tokenGet = () => { try { return sessionStorage.getItem(TOKEN_KEY) || ''; } catch (_) { return ''; } };
  const tokenSet = (v) => { try { sessionStorage.setItem(TOKEN_KEY, v); } catch (_) {} };
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

  const Robot = {
    mode: 'course', running: false, stopFlag: false, results: [], index: [], runways: [], _continue: null,
    reading() {
      const p = dev.G.lla();
      return { tMs: performance.now(), lat: p.lat, lon: p.lon, alt: p.alt, haglM: dev.G.haglM(), groundContact: dev.G.groundContact(),
        heading: dev.G.heading(), pitch: dev.G.pitch(), roll: dev.G.roll() };
    },
    async loadLists() {
      if (!this.index.length) {
        try { await dev.Courses.refreshRemote(); this.index = dev.Courses.remote.slice(); } catch (_) { this.index = []; }
      }
      if (!this.runways.length && C.API_BASE) {
        try { const r = await fetch(api('/runways')); this.runways = r.ok ? await r.json() : []; } catch (_) { this.runways = []; }
      }
    },
    // A picker value -> the items it names. 'all', 'cup:<name>', or 'one:<id>'.
    selection(value) {
      if (this.mode === 'course') {
        const all = this.index;
        if (value === 'all') return all;
        if (value.startsWith('cup:')) return all.filter((c) => (c.cup || 'Other') === value.slice(4));
        return all.filter((c) => c.id === value.slice(4));
      }
      const all = this.runways;
      if (value === 'all') return all;
      if (value.startsWith('cup:')) return all.filter((w) => runwayGroupOf(w.notes) === value.slice(4));
      return all.filter((w) => w.id === value.slice(4));
    },
    waitForAircraft(aid) {
      return new Promise((res) => {
        UI.pause('Switch to aircraft id ' + aid + ' in GeoFS (you are in ' + dev.G.aircraftId() + '), then press Continue.');
        this._continue = () => { this._continue = null; UI.pause(null); res(); };
      });
    },
    async runBatch(value) {
      if (this.running) return;
      if (!dev.G.ready()) { UI.status('GeoFS is still loading.'); return; }
      if (dev.raceState() === 'running') { UI.status('A race run is live: reset it (Alt+R) before running the robot.'); return; }
      await this.loadLists();
      const items = this.selection(value).map((x) => ({ entry: x, id: x.id,
        aircraftId: this.mode === 'course' ? null : (x.aircraftId ? String(x.aircraftId) : dev.G.aircraftId()) }));
      if (!items.length) { UI.status('Nothing to fly for that selection.'); return; }
      this.running = true; this.stopFlag = false;
      try {
        if (this.mode === 'course') {
          // The lock lives in the course file, so each course is fetched once up front to plan the batch.
          for (const it of items) {
            try { it.course = dev.Course.normalize(await dev.Courses.fetchRemote(it.entry.file)); } catch (e) { it.loadError = String(e && e.message); }
            it.aircraftId = robotAircraftFor(it.course, it.entry.cup);
          }
        }
        for (const group of batchPlan(items, dev.G.aircraftId())) {
          if (this.stopFlag) break;
          if (dev.G.aircraftId() !== group.aircraftId) await this.waitForAircraft(group.aircraftId);
          for (const it of group.items) {
            if (this.stopFlag) break;
            const res = this.mode === 'course' ? await this.flyCourse(it) : await this.flyApproach(it);
            this.results.push(res);
            UI.render();
          }
        }
      } finally {
        this.running = false;
        UI.status('Done: ' + this.results.length + ' result(s). Copy or download the report JSON.');
        UI.render();
      }
    },
    // Drive a controller at TICK_MS until it is done, executing its commands through GeoPhysics.
    async drive(flight, onGoAround) {
      while (true) {
        if (this.stopFlag) return 'stopped';
        let reading;
        try { reading = this.reading(); } catch (_) { await sleep(ROBOT.TICK_MS); continue; }
        const out = flight.tick(reading);
        if (out.cmd) dev.GeoPhysics.autopilotTo(out.cmd);
        if (out.goAround && onGoAround) onGoAround();
        if (out.done) return 'done';
        await sleep(ROBOT.TICK_MS);
      }
    },
    async spawn(lat, lon, altM, hdg, speedKt, throttle) {
      const r = dev.GeoPhysics.airStart(lat, lon, altM, hdg, { speedKt, throttle, handoff: 'autopilot', cancelled: () => this.stopFlag });
      if (!r.ok) return { ok: false, detail: r.detail || 'no spawn' };
      const rep = await r.done;
      return rep && rep.ok ? { ok: true, guard: rep.spawnGuard || null } : { ok: false, detail: (rep && rep.reason) || 'settle failed' };
    },
    async flyCourse(it) {
      const base = { kind: 'course', id: it.id, name: it.entry.name, group: it.entry.cup || 'Other', aircraftId: it.aircraftId };
      const done = (log, extra) => Object.assign(base, classifyCourse(log), { log, timeMs: log.timeMs == null ? null : log.timeMs }, extra || {});
      if (!it.course) return done({ abort: { reason: 'spawn', detail: it.loadError || 'course did not load' } });
      if (dev.G.aircraftId() !== it.aircraftId) return done({ abort: { reason: 'aircraft', detail: 'needs ' + it.aircraftId + ', in ' + dev.G.aircraftId() } });
      const course = it.course, hash = dev.Course.hash(course);
      UI.status('Flying ' + course.name + '...');
      dev.CourseEnv.apply(course);
      try {
        const p = dev.airStartProfile(it.aircraftId);
        // FlyToStart.speedMs()'s rule: the pace speed, or this aircraft's own cruise when slower.
        const pace = Math.min(dev.ktToMs(+C.PACE_KT || 180), (+C.MAX_SPEED_MS || 700) - (+C.SPEED_WRITE_MARGIN_MS || 0));
        const speedMps = p.cruiseKt != null ? Math.min(pace, dev.ktToMs(p.cruiseKt)) : pace;
        // The last slot of a GRID_PILOTS grid, then slot 1 (flown), at the longest lead preset; each
        // spawn's AGL after its settle goes in log.spawns.
        const leadS = Math.max(ROBOT.GRID_LEAD_S, ...(Array.isArray(C.COUNTDOWN_LEAD_PRESETS_S) ? C.COUNTDOWN_LEAD_PRESETS_S : []));
        const spawns = robotGridSpawns(course, speedMps, dev, leadS, ROBOT.GRID_PILOTS);
        const spawnLog = [];
        for (const s of spawns) {
          UI.status('Flying ' + course.name + ': spawn check, grid slot ' + s.slot + ' of ' + s.of + '...');
          const sp = await this.spawn(s.lat, s.lon, s.alt, s.heading, dev.msToKt(speedMps), p.throttle);
          if (!sp.ok) return done({ abort: { reason: 'spawn', detail: sp.detail }, spawns: spawnLog }, { courseHash: hash });
          let haglM = null;
          try { haglM = r1(dev.G.haglM()); } catch (_) {}
          spawnLog.push({ slot: s.slot, of: s.of, leadS, altM: Math.round(s.alt), heading: Math.round(s.heading), haglM, guard: sp.guard });
        }
        const slot = spawns[spawns.length - 1];
        const flight = makeCourseFlight(course, { speedMps, spawn: { lat: slot.lat, lon: slot.lon, alt: slot.alt } }, dev);
        const how = await this.drive(flight);
        const log = flight.result();
        log.spawns = spawnLog;
        if (how === 'stopped') log.abort = { reason: 'stopped' };
        return done(log, { courseHash: hash });
      } finally {
        dev.CourseEnv.restore('robot: course done');
      }
    },
    async flyApproach(it) {
      const rw = it.entry;
      const base = { kind: 'approach', id: rw.id, name: rw.name, group: runwayGroupOf(rw.notes), aircraftId: it.aircraftId };
      const done = (log) => Object.assign(base, classifyApproach(log), { log, timeMs: null });
      if (dev.G.aircraftId() !== it.aircraftId) return done({ abort: { reason: 'aircraft' } });
      const sp = dev.landingSpawn(rw, it.aircraftId, C);
      if (!sp) return done({ abort: { reason: 'spawn', detail: 'no usable threshold' } });
      UI.status('Approach ' + rw.id + '...');
      const envKey = rw.env ? { id: 'rwy:' + rw.id, env: rw.env } : null;
      if (envKey) dev.CourseEnv.apply(envKey);
      try {
        const s = await this.spawn(sp.lat, sp.lon, sp.altM, sp.heading, sp.speedKt, sp.throttle);
        if (!s.ok) return done({ abort: { reason: 'spawn', detail: s.detail } });
        const flight = makeApproachFlight(rw, { speedKt: sp.speedKt, glideDeg: sp.glideDeg }, dev);
        let geofsOffset = null;
        const how = await this.drive(flight, () => {
          // Full throttle for the go-around: the robot-only setThrottle use GeoPhysics documents.
          dev.GeoPhysics.setThrottle(1);
          const p = dev.G.lla();
          geofsOffset = runwayRecordOffset(dev.G.nearestRunway(p.lat, p.lon), rw, dev);
        });
        const log = Object.assign(flight.result(), { geofsOffset, spawn: { distM: sp.distM, glideDeg: sp.glideDeg, offsetDeg: sp.offsetDeg, altOffsetM: sp.altOffsetM } });
        if (how === 'stopped') log.abort = { reason: 'stopped' };
        return done(log);
      } finally {
        if (envKey) dev.CourseEnv.restore('robot: approach done');
      }
    },
    report() {
      return reportJson(this.results, { mode: this.mode, clientVersion: dev.version });
    },
    async uploadHouse(res) {
      const body = houseUploadBody(res.id, res.courseHash, res.log, dev.G.model());
      const tok = UI.E.token.value.trim();
      if (!body) return UI.status('That result has no complete trace to upload.');
      if (!tok) return UI.status('Paste the admin token (RACE_ADMIN_TOKEN) first.');
      tokenSet(tok);
      try {
        const r = await fetch(api('/ghosts/house'), { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: JSON.stringify(body) });
        const j = await r.json().catch(() => ({}));
        UI.status(r.ok ? (j.saved ? 'House ghost saved for ' + res.id + '.' : 'Not saved: ' + j.reason) : 'Upload refused (HTTP ' + r.status + '): ' + (j.detail || ''));
      } catch (e) { UI.status('Upload failed: ' + e.message); }
    },
  };

  // ---- panel
  const h = (tag, attrs, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v);
    }
    for (const c of kids) if (c) el.append(c);
    return el;
  };
  const UI = {
    E: {},
    init() {
      const E = this.E;
      const css = '#fr-robot{position:fixed;left:12px;top:12px;z-index:100000;width:560px;max-height:80vh;overflow:auto;background:#10151c;color:#e6edf3;'
        + 'font:12px/1.4 system-ui,sans-serif;border:1px solid #f59e0b;border-radius:8px;padding:10px;box-shadow:0 6px 24px #0008}'
        + '#fr-robot h1{font-size:14px;margin:0 0 6px;color:#f59e0b}#fr-robot button,#fr-robot select,#fr-robot input{font:inherit;margin:2px}'
        + '#fr-robot table{width:100%;border-collapse:collapse;margin-top:6px}#fr-robot td,#fr-robot th{border-bottom:1px solid #2a3340;padding:2px 4px;text-align:left}'
        + '#fr-robot .pass{color:#4ade80}#fr-robot .fail{color:#f87171}#fr-robot .warn{color:#fbbf24}#fr-robot .pause{background:#78350f;padding:6px;border-radius:4px;margin:4px 0}';
      document.head.append(h('style', { id: 'fr-robot-style' }, document.createTextNode(css)));
      E.mode = h('select', { onchange: () => { Robot.mode = E.mode.value; this.fillPicker(); } },
        h('option', { value: 'course', text: 'COURSE' }), h('option', { value: 'approach', text: 'APPROACH' }));
      E.pick = h('select', {});
      E.status = h('div', { text: 'Loading course and runway lists...' });
      E.pause = h('div', { class: 'pause', style: 'display:none' });
      E.token = h('input', { type: 'password', placeholder: 'admin token (House upload)', size: '22' });
      E.token.value = tokenGet();
      E.rows = h('tbody', {});
      E.root = h('div', { id: 'fr-robot', role: 'region', 'aria-label': 'Robot test pilot' },
        h('h1', { text: 'ROBOT TEST PILOT (dev) — writes to the sim' }),
        h('div', {}, E.mode, E.pick,
          h('button', { onclick: () => Robot.runBatch(E.pick.value), text: 'Start' }),
          h('button', { onclick: () => { Robot.stopFlag = true; UI.status('Stopping after this tick...'); }, text: 'Stop' }),
          h('button', { onclick: () => Robot._continue && Robot._continue(), text: 'Continue' }),
          h('button', { onclick: () => this.close(), text: 'Close' })),
        E.pause, E.status,
        h('div', {}, h('button', { onclick: () => this.copy(), text: 'Copy JSON' }), h('button', { onclick: () => this.download(), text: 'Download JSON' }), E.token),
        h('table', {}, h('thead', {}, h('tr', {}, ...['Item', 'Aircraft', 'Result', 'Time', ''].map((t) => h('th', { text: t })))), E.rows));
      document.body.append(E.root);
      for (const t of ['keydown', 'keyup', 'keypress']) E.root.addEventListener(t, (ev) => ev.stopPropagation());
      Robot.loadLists().then(() => { this.fillPicker(); this.status(Robot.index.length + ' courses, ' + Robot.runways.length + ' runways loaded.'); });
    },
    fillPicker() {
      const E = this.E;
      E.pick.textContent = '';
      const add = (value, text) => E.pick.append(h('option', { value, text }));
      if (Robot.mode === 'course') {
        add('all', 'All ' + Robot.index.length + ' courses');
        for (const cup of [...new Set(Robot.index.map((c) => c.cup || 'Other'))]) add('cup:' + cup, 'Cup: ' + cup);
        for (const c of Robot.index) add('one:' + c.id, c.id);
      } else {
        add('all', 'All ' + Robot.runways.length + ' runways');
        for (const g of RUNWAY_GROUPS) if (Robot.runways.some((w) => runwayGroupOf(w.notes) === g)) add('cup:' + g, 'Landing cup: ' + g);
        for (const w of Robot.runways) add('one:' + w.id, w.id);
      }
    },
    status(t) { this.E.status.textContent = t; },
    pause(t) { this.E.pause.style.display = t ? '' : 'none'; this.E.pause.textContent = t || ''; },
    render() {
      const E = this.E;
      E.rows.textContent = '';
      for (const r of Robot.results) {
        const cls = r.status === 'PASS' ? 'pass' : r.status === 'SKIPPED' || r.status === 'OFFSET' || r.status === 'SPAWN_LOW' ? 'warn' : 'fail';
        const up = r.kind === 'course' && r.status === 'PASS' && r.log && r.log.trace
          ? h('button', { onclick: () => Robot.uploadHouse(r), text: 'Upload as House ghost' }) : null;
        E.rows.append(h('tr', {}, h('td', { text: r.id }), h('td', { text: r.aircraftId || '' }), h('td', { class: cls, text: r.label }),
          h('td', { text: r.timeMs != null ? (r.timeMs / 1000).toFixed(1) + ' s' : '' }), h('td', {}, up)));
      }
    },
    copy() {
      const s = JSON.stringify(Robot.report(), null, 1);
      try { navigator.clipboard.writeText(s).then(() => this.status('Report copied.'), () => this.status('Clipboard refused; use Download.')); } catch (_) { this.status('Clipboard unavailable; use Download.'); }
    },
    download() {
      const blob = new Blob([JSON.stringify(Robot.report(), null, 1)], { type: 'application/json' });
      const a = h('a', { href: URL.createObjectURL(blob), download: 'robot-report-' + new Date().toISOString().slice(0, 10) + '.json' });
      document.body.append(a); a.click(); a.remove();
    },
    close() { Robot.stopFlag = true; this.E.root.remove(); const s = document.getElementById('fr-robot-style'); if (s) s.remove(); delete window.__finsRobot; },
  };
  UI.init();
  window.__finsRobot = { robot: Robot, ui: UI, pure, show: () => { if (!document.getElementById('fr-robot')) document.body.append(UI.E.root); } };
})();
