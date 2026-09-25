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

  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
