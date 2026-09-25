#!/usr/bin/env node
/*
 * FINSONLY Racing — rival verifier: the ONLY judge of a computed rival (race/tools/rival_gen.py).
 *
 * A rival is a ghost trace nobody flew, so nothing about it is taken on trust:
 *
 *  1. Course: course_hash must equal race.js Course.hash() of the current course file.
 *  2. Replay: the trace is replayed through race.js's REAL Race state machine (window.__finsRace.race,
 *     loaded under JSDOM by rival_node.js), sampled with race.js traceSampleAt() at 20 Hz. A short
 *     lead-in extrapolated back from sample 0 puts the aircraft through the start sphere so
 *     detectStart() fires the way it does for a pilot. Every gate, in order, every lap, must be
 *     scored; Race must finish (no DQ); finalMs must match time_ms within 50 ms, and every split too.
 *  3. Physics, re-derived from the trace alone against race/rivals/envelope-<aircraftId>.json (the
 *     full envelope, not the persona's share of it): speed <= 102% Vmax(alt), load factor <= 102%
 *     n_inst(v), roll rate <= 102% of the envelope's, no step longer than Vmax*dt (teleport).
 *  4. Terrain: every sample >= minAglM above the sidecar terrain (terrain_m, sampled by rival_gen.py
 *     from Terrarium at each trace sample). Only pending files carry it; --write requires it.
 *
 * A failing rival is never written.
 *
 * Usage:
 *   node rival_verify.js                    # verify every race/rivals/.pending/<id>.json, report only
 *   node rival_verify.js --write            # ... and write race/rivals/<id>.json with the passing rivals
 *   node rival_verify.js race/rivals/gorge-run.json ...   # re-verify shipped files (no terrain sidecar)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { loadRace } = require('./rival_node');

const RACE_DIR = path.join(__dirname, '..');
const RIVALS_DIR = path.join(RACE_DIR, 'rivals');
const PENDING_DIR = path.join(RIVALS_DIR, '.pending');
const COURSES_DIR = path.join(RACE_DIR, 'courses');
const FRAME_MS = 50;              // 20 Hz replay
const TIME_TOL_MS = 50;
const PHYS_TOL = 1.02;
const LEAD_IN_MS = 2000;
const G0 = 9.80665;
const D2R = Math.PI / 180;

// ------------------------------------------------------------------ envelope lookups (same tables rival_gen flies)
const interp = (x, xs, ys) => {
  if (x <= xs[0]) return ys[0];
  if (x >= xs[xs.length - 1]) return ys[ys.length - 1];
  let i = 1;
  while (xs[i] < x) i++;
  const f = (x - xs[i - 1]) / (xs[i] - xs[i - 1]);
  return ys[i - 1] + (ys[i] - ys[i - 1]) * f;
};
// rival_common.vmax_at(): linear between altitude-band mid-points.
function vmaxAt(env, altM) {
  const mids = env.alt_bands_m.map(([lo, hi]) => (lo + Math.min(hi, lo + 6000)) / 2);
  return interp(altM, mids, env.vmax_ms);
}
const nAllow = (env, v) => Math.max(1, interp(v, env.v_centers, env.n_inst));

// ------------------------------------------------------------------ physics from the trace alone
// samples: race.js trace rows [t, lat, lon, alt, hdg, pitch, roll]. ecef: race.js ecef().
function physicsCheck(samples, env, ecef, opts) {
  const o = opts || {};
  const reasons = [];
  const n = samples.length;
  const P = samples.map((r) => ecef(r[1], r[2], r[3]));
  const t = samples.map((r) => r[0] / 1000);
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const len = (a) => Math.hypot(a[0], a[1], a[2]);
  const vtop = Math.max(...env.vmax_ms);
  const max = { speedFrac: 0, nFrac: 0, rollRateFrac: 0, stepFrac: 0, minAglM: Infinity };
  // teleport: no single step longer than Vmax * dt
  for (let i = 1; i < n; i++) {
    const dt = t[i] - t[i - 1];
    const f = len(sub(P[i], P[i - 1])) / Math.max(vtop * dt, 1e-6);
    if (f > max.stepFrac) max.stepFrac = f;
    if (f > PHYS_TOL && reasons.length < 8) reasons.push(`teleport: step ${i} is ${(f * 100).toFixed(0)}% of Vmax*dt`);
  }
  // speed + load factor: central differences over +/-2 samples (0.5 s baseline at 4 Hz)
  const K = 2;
  const vel = [];
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - K), b = Math.min(n - 1, i + K);
    const dt = t[b] - t[a];
    vel.push(dt > 0 ? sub(P[b], P[a]).map((x) => x / dt) : [0, 0, 0]);
  }
  let speedBad = 0, nBad = 0;
  for (let i = K; i < n - K; i++) {
    const v = len(vel[i]);
    const sf = v / vmaxAt(env, samples[i][3]);
    if (sf > max.speedFrac) max.speedFrac = sf;
    if (sf > PHYS_TOL && speedBad++ < 3) reasons.push(`over Vmax: ${v.toFixed(0)} m/s at t=${samples[i][0]} ms (${(sf * 100).toFixed(0)}%)`);
    if (i < 2 * K || i >= n - 2 * K) continue;
    const dt = t[i + K] - t[i - K];
    const acc = sub(vel[i + K], vel[i - K]).map((x) => x / dt);
    const up = P[i].map((x) => x / len(P[i]));
    const f = acc.map((x, k) => x + G0 * up[k]);                  // specific force
    const vh = vel[i].map((x) => x / Math.max(v, 1e-6));
    const along = f[0] * vh[0] + f[1] * vh[1] + f[2] * vh[2];
    const load = len(f.map((x, k) => x - along * vh[k])) / G0;
    const nf = load / nAllow(env, v);
    if (nf > max.nFrac) max.nFrac = nf;
    if (nf > PHYS_TOL && nBad++ < 3) reasons.push(`over-g: ${load.toFixed(1)} g at ${v.toFixed(0)} m/s, t=${samples[i][0]} ms (limit ${nAllow(env, v).toFixed(1)} g)`);
  }
  // roll rate
  const rr = +env.roll_rate_dps;
  let rollBad = 0;
  for (let i = 1; i < n; i++) {
    const dt = t[i] - t[i - 1];
    const d = Math.abs(((samples[i][6] - samples[i - 1][6] + 540) % 360) - 180);
    const f = dt > 0 ? d / dt / rr : 0;
    if (f > max.rollRateFrac) max.rollRateFrac = f;
    if (f > PHYS_TOL && rollBad++ < 3) reasons.push(`roll rate ${(d / dt).toFixed(0)} deg/s at t=${samples[i][0]} ms (limit ${rr})`);
  }
  // terrain
  if (Array.isArray(o.terrainM)) {
    if (o.terrainM.length !== n) reasons.push(`terrain sidecar has ${o.terrainM.length} heights for ${n} samples`);
    else {
      let aglBad = 0;
      for (let i = 0; i < n; i++) {
        const agl = samples[i][3] - o.terrainM[i];
        if (agl < max.minAglM) max.minAglM = agl;
        if (agl < o.minAglM && aglBad++ < 3) reasons.push(`below the terrain floor: ${agl.toFixed(0)} m AGL at t=${samples[i][0]} ms (floor ${o.minAglM} m)`);
      }
    }
  } else if (o.requireTerrain) reasons.push('no terrain sidecar (terrain_m): AGL cannot be checked');
  if (!Number.isFinite(max.minAglM)) max.minAglM = null;
  return { ok: reasons.length === 0, reasons, max };
}

// ------------------------------------------------------------------ replay through race.js's Race
function replay(env, rawCourse, trace) {
  const I = env.I, race = env.race;
  race.load(rawCourse);
  const rows = trace.samples;
  const last = rows[rows.length - 1][0];
  // lead-in: straight back along the first leg's velocity
  const a = rows[0], b = rows[Math.min(1, rows.length - 1)];
  const dtab = Math.max(1, b[0] - a[0]);
  const at = (tr) => {
    if (tr >= 0) return I.traceSampleAt(trace, tr);
    const f = tr / dtab;
    return { lat: a[1] + (b[1] - a[1]) * f, lon: a[2] + (b[2] - a[2]) * f, alt: a[3] + (b[3] - a[3]) * f, heading: a[4], pitch: a[5], roll: a[6] };
  };
  const base = 100000;
  let started = null;
  for (let tr = -LEAD_IN_MS; tr <= last + 1000; tr += FRAME_MS) {
    const s = at(tr);
    env.setPose(s.lat, s.lon, s.alt, s.heading, s.pitch, s.roll);
    race.tick(base + tr);
    if (started == null && race.state === 'running') started = tr;
    if (race.state === 'finished' || race.state === 'dq') break;
  }
  return { state: race.state, next: race.next, gates: race.course.gates.length, finalMs: race.finalMs,
    splits: race.splits.slice(), dqReason: race.dqReason, startedAtTraceMs: started };
}

// ------------------------------------------------------------------ one rival, one file
function verifyRival(env, rawCourse, fileMeta, rival, envelope, opts) {
  const o = opts || {};
  const reasons = [];
  const I = env.I;
  const course = I.Course.normalize(rawCourse);
  const hash = I.Course.hash(course);
  if (fileMeta.course_hash !== hash) reasons.push(`course_hash ${fileMeta.course_hash} is not the current course (${hash})`);
  const trace = I.traceDecode(rival.trace);
  if (!trace || trace.samples.length < 2) return { rival_id: rival.rival_id, ok: false, reasons: reasons.concat('trace does not decode (race.js traceDecode)') };
  if (trace.samples[0][0] !== 0) reasons.push(`trace starts at t=${trace.samples[0][0]} ms, not 0 (the start-gate crossing)`);
  const rp = replay(env, rawCourse, trace);
  if (rp.state === 'dq') reasons.push('race.js DQ: ' + rp.dqReason);
  else if (rp.state !== 'finished') reasons.push(`race.js never finished: stuck at gate ${rp.next} of ${rp.gates - 1}` + (rp.startedAtTraceMs == null ? ' (never started)' : ''));
  else {
    if (Math.abs(rp.finalMs - rival.time_ms) > TIME_TOL_MS) reasons.push(`race.js times it ${rp.finalMs} ms, the file says ${rival.time_ms} ms`);
    const sp = rival.splits_ms || [];
    if (sp.length !== rp.splits.length) reasons.push(`${sp.length} splits in the file, race.js scored ${rp.splits.length}`);
    else {
      const worst = sp.reduce((m, x, i) => Math.max(m, Math.abs(x - rp.splits[i])), 0);
      if (worst > TIME_TOL_MS) reasons.push(`a split is off by ${worst} ms`);
    }
  }
  const phys = envelope ? physicsCheck(trace.samples, envelope, I.ecef, { terrainM: rival.terrain_m, minAglM: fileMeta.minAglM ?? 60, requireTerrain: o.requireTerrain })
    : { ok: false, reasons: ['no envelope for aircraft ' + fileMeta.aircraftId], max: {} };
  return { rival_id: rival.rival_id, ok: reasons.length === 0 && phys.ok, reasons: reasons.concat(phys.reasons),
    replay: { state: rp.state, finalMs: rp.finalMs, splits: rp.splits, startedAtTraceMs: rp.startedAtTraceMs }, physics: phys.max };
}

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function courseFile(courseId) {
  const direct = path.join(COURSES_DIR, courseId + '.json');
  if (fs.existsSync(direct)) return readJson(direct);
  for (const f of fs.readdirSync(COURSES_DIR)) {
    if (!f.endsWith('.json') || f === 'index.json') continue;
    try { const c = readJson(path.join(COURSES_DIR, f)); if (c && c.id === courseId) return c; } catch (_) {}
  }
  return null;
}
function envelopeFor(aircraftId) {
  const p = path.join(RIVALS_DIR, 'envelope-' + aircraftId + '.json');
  return fs.existsSync(p) ? readJson(p) : null;
}

// The shipped shape (the brief's field list), passing rivals only.
function shippedFile(file, passing) {
  return {
    course_id: file.course_id, course_hash: file.course_hash, aircraftId: file.aircraftId,
    generator_version: file.generator_version, envelope_version: file.envelope_version,
    rivals: passing.map((r) => ({ rival_id: r.rival_id, name: r.name, model: r.model, time_ms: r.time_ms, splits_ms: r.splits_ms, trace: r.trace })),
  };
}

function verifyFile(env, file, opts) {
  const o = opts || {};
  const raw = o.course || courseFile(file.course_id);
  if (!raw) return { course_id: file.course_id, results: [], error: 'no course file for ' + file.course_id };
  const envelope = o.envelope || envelopeFor(file.aircraftId);
  const results = (file.rivals || []).map((r) => verifyRival(env, raw, file, r, envelope, o));
  return { course_id: file.course_id, results };
}

module.exports = { physicsCheck, replay, verifyRival, verifyFile, shippedFile, vmaxAt, nAllow, TIME_TOL_MS, FRAME_MS };

if (require.main === module) {
  const args = process.argv.slice(2);
  const write = args.includes('--write');
  const files = args.filter((a) => !a.startsWith('--'));
  const pending = !files.length;
  const list = pending
    ? (fs.existsSync(PENDING_DIR) ? fs.readdirSync(PENDING_DIR).filter((f) => f.endsWith('.json') && !f.startsWith('_') && !f.endsWith('.verify.json')).map((f) => path.join(PENDING_DIR, f)) : [])
    : files;
  const env = loadRace();
  let pass = 0, fail = 0, written = 0;
  for (const p of list.sort()) {
    const file = readJson(p);
    const rep = verifyFile(env, file, { requireTerrain: pending });
    const passing = [];
    for (const r of rep.results) {
      if (r.ok) { pass++; passing.push(file.rivals.find((x) => x.rival_id === r.rival_id)); }
      else fail++;
      console.log((r.ok ? '  PASS ' : '  FAIL ') + file.course_id + ' ' + r.rival_id +
        (r.replay && r.replay.finalMs != null ? ' ' + r.replay.finalMs + ' ms' : '') + (r.ok ? '' : ' — ' + r.reasons.join('; ')));
    }
    if (rep.error) { console.log('  FAIL ' + file.course_id + ' — ' + rep.error); fail++; }
    if (pending) fs.writeFileSync(p.replace(/\.json$/, '.verify.json'), JSON.stringify(rep, null, 1));
    if (write && pending) {
      const out = path.join(RIVALS_DIR, file.course_id + '.json');
      if (passing.length) { fs.writeFileSync(out, JSON.stringify(shippedFile(file, passing)) + '\n'); written++; }
      else if (fs.existsSync(out)) fs.unlinkSync(out);   // never leave a stale rival that no longer passes
    }
  }
  env.close();
  console.log(`\n${pass} rival(s) pass, ${fail} fail` + (write ? `, ${written} file(s) written` : ''));
  process.exit(fail ? 1 : 0);
}
