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
