// Headless tests for the rival generator's JS half: envelope_capture.js's pure helpers,
// rival_verify.js (the judge, against the real race.js under JSDOM), and terrain_probe.js's
// rival cross-check. No network, no sim.
// Run: cd race/test && node rivals.test.js     (needs jsdom from this folder's node_modules)
'use strict';
const path = require('path');

let failures = 0;
const ok = (cond, msg) => { console.log((cond ? '  pass ' : '  FAIL ') + msg); if (!cond) failures++; };
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const TOOLS = path.join(__dirname, '..', 'tools');

(async () => {
  console.log('envelope_capture.js: the read-only flight card');
  {
    const C = require(path.join(TOOLS, 'envelope_capture.js'));
    const total = C.cardSeconds();
    ok(total >= 240 && total <= 360, 'the card flies in about 6 minutes of recorded steps (' + total + ' s)');
    const kinds = new Set(C.CARD.map((s) => s.kind));
    ok(['accel', 'turn', 'roll', 'zoom', 'decel'].every((k) => kinds.has(k)), 'every envelope.py lab table has a step');
    ok(new Set(C.CARD.map((s) => s.id)).size === C.CARD.length && C.CARD.every((s) => s.id > 0), 'step ids are unique and never 0 (0 = setup)');
    const turnKts = C.CARD.filter((s) => s.kind === 'turn').map((s) => s.title);
    ok(['250', '350', '450', '550'].every((k) => turnKts.some((t) => t.includes(k))), 'sustained turns at 250/350/450/550 kt');

    let s = C.cardInitial();
    ok(s.phase === 'setup' && C.cardStepId(s) === 0, 'starts in setup; setup samples are step 0');
    s = C.cardReduce(s, 'tick', 1000);
    ok(s.phase === 'setup', 'ticking in setup never starts a step by itself');
    s = C.cardReduce(s, 'start', 2000);
    ok(s.phase === 'record' && C.cardStepId(s) === C.CARD[0].id, 'START records the current step');
    ok(near(C.cardRemainingS(s, 12000), C.CARD[0].seconds - 10, 1e-9), 'remaining time counts down');
    s = C.cardReduce(s, 'tick', 2000 + C.CARD[0].seconds * 1000);
    ok(s.phase === 'setup' && s.index === 1, 'the step ends on its own when its time is up');
    s = C.cardReduce(s, 'skip', 0);
    ok(s.index === 2 && s.phase === 'setup', 'SKIP moves past a step without recording it');
    s = C.cardReduce(s, 'start', 0); s = C.cardReduce(s, 'end', 1);
    ok(s.index === 3, 'END STEP ends a step early');
    ok(C.cardReduce(s, 'done', 0).phase === 'done', 'DONE ends the card');

    ok(C.buildRow({ lla: { lat: NaN, lon: 0, alt: 0 } }, 0, 1) === null, 'an unreadable position is no row');
    const row = C.buildRow({ lla: { lat: 45.1234567891, lon: -122.5, alt: 1000.123 }, heading: 90, pitch: 'x', roll: 12.345, kias: 300, vsFpm: null, haglM: 500 }, 1234.4, 3);
    ok(row.length === 11 && row[0] === 1234 && row[10] === 3 && row[5] === 0 && row[6] === 12.35 && row[8] === 0,
      'a row is [t, lat, lon, alt, hdg, pitch, roll, kias, vsFpm, haglM, step]; non-numbers read as 0');
    const rep = C.buildReport({ aircraftId: 7 }, [row, row, C.buildRow({ lla: { lat: 1, lon: 1, alt: 1 } }, 5, 0)]);
    ok(rep.kind === 'fins-envelope-capture' && rep.aircraftId === '7' && rep.counts[3] === 2 && rep.hz === 20,
      'the report is what envelope.py --lab reads (kind, aircraftId, per-step counts)');
    const src = require('fs').readFileSync(path.join(TOOLS, 'envelope_capture.js'), 'utf8');
    const browser = src.slice(src.indexOf('// ------------------------------------------------------------------ browser'));
    ok(!/GeoPhysics|setLinearVelocity|\.place\(|flyTo|autopilot|increaseThrottle|decreaseThrottle|resetFlight/.test(browser),
      'the browser half never touches a write path (reads only via dev.G)');
  }

  console.log('rival_verify.js: the judge replays through race.js and rejects cheats');
  {
    const V = require(path.join(TOOLS, 'rival_verify.js'));
    const { loadRace } = require(path.join(TOOLS, 'rival_node.js'));
    const env = loadRace();
    const I = env.I;
    // A straight 15 km course due north: 4 gates, 5 km apart, 100 m radius, 1000 m.
    const g0 = { lat: 45, lon: -122 };
    const gates = [0, 5000, 10000, 15000].map((d) => ({ ...I.destination(g0, 0, d), alt: 1000, radius: 100 }));
    const raw = { id: 'rival-test', name: 'Rival test', startType: 'air', gates };
    const hash = I.Course.hash(I.Course.normalize(raw));
    const envelope = { v_centers: [50, 150, 250, 350, 450], alt_bands_m: [[0, 1500], [1500, 4500], [4500, 15000]],
      vmax_ms: [300, 300, 300], n_inst: [2, 9, 9, 9, 9], roll_rate_dps: 180 };
    const V_MS = 250;
    const posAt = (tS, mutate) => {
      const p = I.destination(g0, 0, 100 + V_MS * tS);           // t = 0 on the start sphere's far edge
      const s = { lat: p.lat, lon: p.lon, alt: 1000, hdg: 0, pitch: 0, roll: 0 };
      return mutate ? mutate(s, tS) : s;
    };
    // The honest times: first contact with each later sphere, found on the true path (1 ms steps).
    const centers = gates.map((g) => I.ecef(g.lat, g.lon, g.alt));
    const splits = [];
    for (let j = 1, tMs = 0; j < gates.length; j++) {
      while (I.vlen(I.sub(I.ecef(posAt(tMs / 1000).lat, posAt(tMs / 1000).lon, 1000), centers[j])) > 100) tMs++;
      splits.push(tMs);
    }
    const timeMs = splits[splits.length - 1];
    const makeRival = (mutate, extra) => {
      const ts = [];
      for (let t = 0; t < timeMs; t += 250) ts.push(t);
      ts.push(timeMs, timeMs + 250);
      const samples = ts.map((t) => { const s = posAt(t / 1000, mutate); return [t, +s.lat.toFixed(6), +s.lon.toFixed(6), +s.alt.toFixed(1), s.hdg, s.pitch, s.roll]; });
      return { rival_id: 'test', name: 'TEST', model: 'cow', time_ms: timeMs, splits_ms: splits.slice(),
        trace: I.traceEncode({ samples }), terrain_m: samples.map(() => 0), ...(extra || {}) };
    };
    const meta = { course_id: 'rival-test', course_hash: hash, aircraftId: '7', minAglM: 60 };
    const judge = (rival, m) => V.verifyRival(env, raw, m || meta, rival, envelope, { requireTerrain: true });

    const good = judge(makeRival());
    ok(good.ok, 'an honest straight-line rival passes' + (good.ok ? '' : ': ' + good.reasons.join('; ')));
    ok(good.replay.state === 'finished' && Math.abs(good.replay.finalMs - timeMs) <= V.TIME_TOL_MS,
      `race.js's own Race scores it: ${good.replay.finalMs} ms vs ${timeMs} ms`);
    ok(good.replay.splits.length === 3, 'every gate scored, in order');

    const skipped = judge(makeRival((s, t) => {
      const d = Math.max(0, 1 - Math.abs(t - 39.2) / 6);            // swing 600 m east around gate 2
      return { ...s, lon: s.lon + 0.0076 * d * d * (3 - 2 * d) };
    }));
    ok(!skipped.ok && skipped.reasons.some((r) => /never finished: stuck at gate 2/.test(r)), 'a skipped gate is rejected (' + skipped.reasons[0] + ')');

    const overG = judge(makeRival((s, t) => ({ ...s, lon: s.lon + (90 / 78710) * Math.sin(1.6 * t) })));
    ok(!overG.ok && overG.reasons.some((r) => /over-g/.test(r)), 'an over-g weave is rejected');

    const buried = makeRival();
    buried.terrain_m = I.traceDecode(buried.trace).samples.map((r) => r[3] - 10);
    const low = judge(buried);
    ok(!low.ok && low.reasons.some((r) => /below the terrain floor/.test(r)), 'a trace 10 m above the ground is rejected');

    const tp = judge(makeRival((s, t) => (t > 30 && t < 30.3 ? { ...s, lat: s.lat + 0.03 } : s)));
    ok(!tp.ok && tp.reasons.some((r) => /teleport/.test(r)), 'a teleport is rejected (' + tp.reasons.find((r) => /teleport|DQ/.test(r)) + ')');

    const stale = judge(makeRival(), { ...meta, course_hash: 'ffffffff' });
    ok(!stale.ok && stale.reasons.some((r) => /course_hash ffffffff is not the current course/.test(r)), 'a rival for another version of the course is rejected');

    const liar = judge(makeRival(null, { time_ms: timeMs - 200 }));
    ok(!liar.ok && liar.reasons.some((r) => /race\.js times it/.test(r)), 'a time_ms race.js does not reproduce (200 ms off) is rejected');

    const noTerrain = V.verifyRival(env, raw, meta, makeRival(null, { terrain_m: undefined }), envelope, { requireTerrain: true });
    ok(!noTerrain.ok && noTerrain.reasons.some((r) => /no terrain sidecar/.test(r)), 'a pending rival without its terrain sidecar cannot pass');

    const shipped = V.shippedFile({ ...meta, generator_version: 'g', envelope_version: 'e', minAglM: 60 }, [makeRival()]);
    ok(Object.keys(shipped).join() === 'course_id,course_hash,aircraftId,generator_version,envelope_version,rivals' &&
      Object.keys(shipped.rivals[0]).join() === 'rival_id,name,model,time_ms,splits_ms,trace',
      'the shipped file carries exactly the brief\'s fields (no terrain sidecar)');
    ok(V.vmaxAt(envelope, 0) === 300 && V.nAllow(envelope, 50) === 2 && V.nAllow({ v_centers: [1, 2], n_inst: [0.5, 0.5] }, 1) === 1,
      'envelope lookups: Vmax by altitude band, n never below 1');

    // Regression: rival_verify.js's CLI reuses one env/Race across every file it checks in a
    // batch. Race.reset() deliberately leaves prev/prevT alone (a real mid-session course switch
    // keeps tick()'s continuous clock and position), which used to leak the LAST sample of one
    // file's replay into the very first frame of the next file's — on lake-hood-floatplane-circuit
    // this read as a ~2 s shift in every later gate's timing. A second replay() on a totally
    // different (but still valid) course, run right after a first one on the SAME env, must come
    // out exactly like a replay of that course on a brand-new env would.
    const other = { id: 'rival-test-2', name: 'Rival test 2', startType: 'air',
      gates: [0, 5000, 10000, 15000, 20000].map((d) => ({ ...I.destination({ lat: 10, lon: 20 }, 90, d), alt: 500, radius: 100 })) };
    const otherHash = I.Course.hash(I.Course.normalize(other));
    const otherRival = (() => {
      const V_MS2 = 200;
      const posAt2 = (tS) => I.destination({ lat: 10, lon: 20 }, 90, 100 + V_MS2 * tS);
      let tMs = 0;
      const centers2 = other.gates.map((g) => I.ecef(g.lat, g.lon, g.alt));
      const splits2 = [];
      for (let j = 1; j < other.gates.length; j++) {
        while (I.vlen(I.sub(I.ecef(posAt2(tMs / 1000).lat, posAt2(tMs / 1000).lon, 500), centers2[j])) > 100) tMs++;
        splits2.push(tMs);
      }
      const timeMs2 = splits2[splits2.length - 1];
      const ts2 = []; for (let t = 0; t < timeMs2; t += 250) ts2.push(t); ts2.push(timeMs2, timeMs2 + 250);
      const samples2 = ts2.map((t) => { const p = posAt2(t / 1000); return [t, +p.lat.toFixed(6), +p.lon.toFixed(6), 500, 90, 0, 0]; });
      return { rival_id: 'test2', name: 'TEST2', model: 'cow', time_ms: timeMs2, splits_ms: splits2,
        trace: I.traceEncode({ samples: samples2 }) };
    })();
    {
      V.replay(env, raw, I.traceDecode(makeRival().trace));               // "use" the env on file 1 first
      const fresh = loadRace();
      const isolated = V.replay(fresh, other, I.traceDecode(otherRival.trace));
      const afterBatch = V.replay(env, other, I.traceDecode(otherRival.trace));
      ok(isolated.state === 'finished' && afterBatch.state === 'finished' && isolated.finalMs === afterBatch.finalMs,
        `a second course replayed after another on the same env matches a fresh env's replay (${isolated.finalMs} vs ${afterBatch.finalMs})`);
      ok(Math.abs(afterBatch.finalMs - otherRival.time_ms) <= V.TIME_TOL_MS, 'and it still matches the model\'s own time_ms');
      fresh.close();
    }
    void otherHash;

    // Regression (the actual root cause): a CLOSED-LOOP course (gate 0 == the last gate, e.g. a
    // circuit) replayed twice in a row on one env. The first replay ends exactly AT gate 0's
    // coordinates — inside its radius. race.js's Race.reset() (called from load()) seeds
    // wasInStart from whatever race.prev already is: `if (this.prev) this.wasInStart =
    // vlen(sub(this.prev, this.centers[0])) <= gates[0].radius`. If prev/prevT are cleared AFTER
    // load() instead of before, reset() sees the stale finish position — inside the new course's
    // gate-0 sphere too — and starts the second replay believing it is already in the start
    // sphere. detectStart's very next tick then reads "was inside, now outside" and fires GO at
    // the top of the lead-in, ~LEAD_IN_MS before the real crossing, inflating every later split.
    const loop = { id: 'rival-test-loop', name: 'Rival test loop', startType: 'air',
      gates: [[0, 0], [0, 6000], [6000, 6000], [6000, 0], [0, 0]].map(([n, e]) => {
        const p = I.destination(I.destination(g0, 0, n), 90, e);
        return { ...p, alt: 1000, radius: 100 };
      }) };
    const loopCenters = loop.gates.map((g) => I.ecef(g.lat, g.lon, g.alt));
    const V_LOOP = 200;
    // Straight legs at V_LOOP through each corner in turn (a coarse square, precise enough for
    // this test: it only needs to actually reach every gate, not fly an optimal line).
    const loopPosAt = (tS) => {
      let remaining = 100 + V_LOOP * tS, leg = 0;
      while (leg < loopCenters.length - 1) {
        const segLen = I.vlen(I.sub(loopCenters[leg + 1], loopCenters[leg]));
        if (remaining <= segLen) break;
        remaining -= segLen; leg++;
      }
      const a = loop.gates[leg], b = loop.gates[Math.min(leg + 1, loop.gates.length - 1)];
      const segLen = Math.max(1, I.vlen(I.sub(loopCenters[Math.min(leg + 1, loopCenters.length - 1)], loopCenters[leg])));
      const f = Math.min(1, remaining / segLen);
      const brg = I.bearingDeg(a, b);
      return { ...I.destination(a, brg, f * segLen), hdg: brg };
    };
    let tMsLoop = 0;
    const loopSplits = [];
    for (let j = 1; j < loop.gates.length; j++) {
      while (I.vlen(I.sub(I.ecef(loopPosAt(tMsLoop / 1000).lat, loopPosAt(tMsLoop / 1000).lon, 1000), loopCenters[j])) > 100) tMsLoop++;
      loopSplits.push(tMsLoop);
    }
    const loopTimeMs = loopSplits[loopSplits.length - 1];
    const loopRows = (() => {
      const ts = []; for (let t = 0; t < loopTimeMs; t += 250) ts.push(t); ts.push(loopTimeMs, loopTimeMs + 250);
      return ts.map((t) => { const p = loopPosAt(t / 1000); return [t, +p.lat.toFixed(6), +p.lon.toFixed(6), 1000, p.hdg, 0, 0]; });
    })();
    const loopTrace = I.traceDecode(I.traceEncode({ samples: loopRows }));
    const first = V.replay(env, loop, loopTrace);
    ok(first.state === 'finished' && Math.abs(first.finalMs - loopTimeMs) <= V.TIME_TOL_MS,
      `sanity: the closed-loop course replays correctly the first time (${first.finalMs} vs ${loopTimeMs})`);
    const second = V.replay(env, loop, loopTrace);                         // same env, same closed-loop course, again
    ok(second.state === 'finished' && Math.abs(second.finalMs - loopTimeMs) <= V.TIME_TOL_MS,
      `and replaying the SAME closed-loop course again on the same env is not ~2 s early (${second.finalMs} vs ${loopTimeMs})`);
    ok(second.finalMs === first.finalMs, 'a repeat replay of a closed loop is exactly reproducible, not offset by the previous run\'s finish');

    env.close();
  }

  console.log('terrain_probe.js: the rival cross-check (parseRivalPick, rivalProbePoints, rivalAglReport)');
  {
    const TP = require(path.join(TOOLS, 'terrain_probe.js'));
    ok(TP.parseRivalPick('rival:gorge-run').kind === 'id' && TP.parseRivalPick('rival:gorge-run').id === 'gorge-run',
      'rival:<id> parses to an id lookup');
    ok(TP.parseRivalPick('RIVALS: Hood-Circuit').id === 'hood-circuit', 'rivals: is accepted too, case-insensitive');
    ok(TP.parseRivalPick('https://race.finsonly.net/rivals/gorge-run.json').kind === 'url', 'a URL parses to a url load');
    const pasted = TP.parseRivalPick('{"course_id":"x","rivals":[]}');
    ok(pasted.kind === 'json' && pasted.file.course_id === 'x', 'pasted JSON with a rivals list parses to a json load');
    ok(TP.parseRivalPick('gorge-run') === null, 'a bare course id is not a rival pick (falls through to the course check)');
    let threw = null;
    try { TP.parseRivalPick('{not json'); } catch (e) { threw = e; }
    ok(threw && /not JSON/.test(threw.message), 'unparsable pasted text throws a clear error, not a silent null');
    ok(TP.rivalUrl('https://race.finsonly.net/race/courses/', 'gorge-run') === 'https://race.finsonly.net/race/rivals/gorge-run.json',
      'rivalUrl sits rivals/ next to COURSE_BASE\'s courses/');

    const decode = (enc) => (enc ? { samples: enc.rows } : null);
    const file = { rivals: [
      { rival_id: 'dawg', name: 'DAWG', trace: { rows: [[0, 1, 1, 100], [250, 1, 1, 110], [500, 1, 1, 120], [750, 1, 1, 130]] } },
      { rival_id: 'steve', name: 'STEVE', trace: { rows: [[0, 2, 2, 200], [250, 2, 2, 200]] } },
      { rival_id: 'bad', name: 'BAD', trace: null },
    ] };
    const pts = TP.rivalProbePoints(file, decode, 2);
    ok(pts.filter((p) => p.rival_id === 'dawg').length === 3 && pts.some((p) => p.i === 3),
      'every 2nd sample is probed, plus always the last one');
    ok(pts.some((p) => p.rival_id === 'bad' && p.bad), 'a trace that will not decode is flagged, not skipped silently');

    const heights = pts.map((p) => (p.bad ? null : p.alt - 80));       // 80 m AGL everywhere: passes a 60 m floor
    let rep = TP.rivalAglReport(pts, heights, 60);
    ok(rep.rivals.find((r) => r.rival_id === 'dawg').status === 'PASS', 'comfortably clear of the floor: PASS');
    ok(rep.rivals.find((r) => r.rival_id === 'bad').status === 'UNVERIFIED', 'an undecodable trace is UNVERIFIED, never a silent PASS');
    ok(rep.status === 'UNVERIFIED', "the course verdict is the worst of its rivals' (UNVERIFIED, not PASS)");

    const lowHeights = pts.map((p, k) => (p.bad ? null : (p.rival_id === 'dawg' && p.i === 0 ? p.alt - 10 : heights[k])));
    rep = TP.rivalAglReport(pts, lowHeights, 60);
    const dawgRow = rep.rivals.find((r) => r.rival_id === 'dawg');
    ok(dawgRow.status === 'FAIL' && dawgRow.minAglM === 10 && dawgRow.worst.t === 0, 'one sample under the floor fails that rival and pins the worst point');

    const noData = pts.map(() => null);
    rep = TP.rivalAglReport(pts, noData, 60);
    ok(rep.rivals.every((r) => r.status === 'UNVERIFIED'), 'no terrain data anywhere: every rival is UNVERIFIED, never PASS');
  }

  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
