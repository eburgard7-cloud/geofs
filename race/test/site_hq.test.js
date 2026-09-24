// Headless tests for race.finsonly.net's pure helpers (race/server/static/site.js).
// Run: cd race/test && node site_hq.test.js    (no deps; the DOM-free half of the site only)
const path = require('path');
const S = require(path.join(__dirname, '..', 'server', 'static', 'site.js'));

let failures = 0, count = 0;
const ok = (cond, msg) => { count++; console.log((cond ? '  pass ' : '  FAIL ') + msg); if (!cond) failures++; };
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const section = (name) => console.log(name);

// A synthetic trace flying due north from (45, -122) at 100 m/s, 4 Hz, level at 1000 m.
const M_PER_DEG_LAT = 6371008.8 * Math.PI / 180;
function northTrace(seconds, speed, opts) {
  const o = opts || {};
  const rows = [];
  for (let i = 0; i <= seconds * 4; i++) {
    const t = i * 250;
    rows.push({ t: t + (o.t0 || 0), lat: 45 + (speed * t / 1000) / M_PER_DEG_LAT, lon: -122, alt: 1000, hdg: 0, pitch: 0, roll: 0 });
  }
  return rows;
}
const gateNorth = (m, r) => ({ lat: 45 + m / M_PER_DEG_LAT, lon: -122, alt: 1000, radius: r || 100 });

section('medals: thresholds live in one place and apply at the line');
{
  ok(S.MEDAL_THRESHOLDS.gold === 1.02 && S.MEDAL_THRESHOLDS.silver === 1.05 && S.MEDAL_THRESHOLDS.bronze === 1.10, 'MEDAL_THRESHOLDS are 1.02 / 1.05 / 1.10');
  ok(Object.isFrozen(S.MEDAL_THRESHOLDS), 'the thresholds cannot be mutated at runtime');
  ok(S.medalFor(100000, 100000) === 'gold', 'the record itself is gold');
  ok(S.medalFor(102000, 100000) === 'gold', 'exactly record x 1.02 is still gold');
  ok(S.medalFor(102001, 100000) === 'silver', '1 ms past the gold line is silver');
  ok(S.medalFor(105000, 100000) === 'silver', 'exactly x 1.05 is silver');
  ok(S.medalFor(110000, 100000) === 'bronze', 'exactly x 1.10 is bronze');
  ok(S.medalFor(110001, 100000) === null, 'past x 1.10 earns nothing');
  ok(S.medalFor(null, 100000) === null && S.medalFor(1000, 0) === null && S.medalFor(NaN, 5) === null, 'missing/zero/NaN inputs give no medal, never a throw');
  ok(S.msToNextMedal(100000, 100000) === 0, 'a gold time is 0 ms from the next medal');
  ok(S.msToNextMedal(104000, 100000) === 2000, 'a silver time 2 s off gold reports 2000 ms');
  ok(S.msToNextMedal(120000, 100000) === 10000, 'no medal -> the distance to bronze');
}

section('formatting');
{
  ok(S.fmtRaceTime(83456) === '1:23.456', 'fmtRaceTime: ' + S.fmtRaceTime(83456));
  ok(S.fmtGap(1300) === '+1.300', 'fmtGap positive: ' + S.fmtGap(1300));
  ok(S.fmtGap(-42) === '−0.042', 'fmtGap negative uses a real minus sign: ' + S.fmtGap(-42));
  ok(S.fmtGap(0) === '0.000' && S.fmtGap(0.3) === '0.000', 'fmtGap of (almost) zero is unsigned');
  ok(S.fmtGap(null) === '—', 'fmtGap(null) is an em dash');
  ok(S.fmtDuration(30) === '<1 min' && S.fmtDuration(600) === '10 min', 'fmtDuration minutes');
  ok(S.fmtDuration(5 * 3600) === '5 h' && S.fmtDuration(47 * 3600) === '47 h', 'fmtDuration hours up to 2 days');
  ok(S.fmtDuration(3 * 86400) === '3 d', 'fmtDuration days');
  ok(S.fmtDuration(400 * 86400) === '1 y 35 d', 'fmtDuration years: ' + S.fmtDuration(400 * 86400));
  ok(S.fmtDuration(-1) === '—', 'fmtDuration of a negative is a dash');
  ok(S.fmtDate(0) === '1 Jan 1970', 'fmtDate is UTC: ' + S.fmtDate(0));
  ok(S.fmtKm(7.25) === '7.3 km' && S.fmtKm(42.4) === '42 km' && S.fmtKm(null) === '—', 'fmtKm');
  ok(S.timeAgo(1000, 1000 * 1000 + 3 * 86400 * 1000) === '3 d ago', 'timeAgo takes an injectable now');
}

section('reign duration');
{
  const now = Date.UTC(2026, 8, 24) ;
  ok(S.reignSeconds(now / 1000 - 3600, now) === 3600, 'a record set an hour ago has reigned 3600 s');
  ok(S.reignSeconds(now / 1000 + 50, now) === 0, 'a set-at in the future (clock skew) clamps to 0');
  ok(S.reignSeconds(undefined, now) === null, 'no set-at -> null, not NaN');
}

section('trace decode + orientation conversion');
{
  const enc = { v: 1, n: 3, t: [0, 250, 250], lat: [45, 45.001, 45.002], lon: [179.9995, -179.9995, -179.999],
    alt: [100, 110, 120], hdg: [350, 10, 20], pitch: [0, 5, 10], roll: [0, -20, -40] };
  const rows = S.traceRows(enc);
  ok(rows && rows.length === 3 && rows[2].t === 500, 'traceRows accumulates delta t: ' + JSON.stringify(rows && rows.map((r) => r.t)));
  ok(S.traceRows({ ...enc, v: 2 }) === null, 'traceRows rejects an unknown version');
  ok(S.traceRows({ ...enc, n: 4 }) === null, 'traceRows rejects an n that disagrees with the columns');
  ok(S.traceRows({ ...enc, t: [0, 250, 0] }) === null, 'traceRows rejects non-increasing t');
  ok(S.traceRows({ ...enc, lat: [45, 95, 45] }) === null, 'traceRows rejects an out-of-range latitude');
  const mid = S.traceStateAt(rows, 125);
  ok(near(mid.hdg, 0, 1e-9), 'heading interpolates across north the short way (350 -> 10 gives 0): ' + mid.hdg);
  ok(near(mid.lon, 180, 1e-6) || near(mid.lon, -180, 1e-6), 'longitude interpolates across the antimeridian without unwinding: ' + mid.lon);
  ok(near(mid.alt, 105, 1e-9) && near(mid.roll, -10, 1e-9), 'alt and roll interpolate linearly');
  ok(S.traceStateAt(rows, -1).t === 0 && !S.traceStateAt(rows, -1).ended, 'before the first sample it holds the start, not ended');
  ok(S.traceStateAt(rows, 9999).ended === true, 'after the last sample it parks and reports ended');
  const hpr = S.hprRadians(90, 10, -30);
  ok(near(hpr.heading, Math.PI / 2, 1e-12) && near(hpr.pitch, Math.PI / 18, 1e-12) && near(hpr.roll, -Math.PI / 6, 1e-12), 'hprRadians converts degrees to radians, sign preserved');
  const off = S.hprRadians(90, 0, 0, { headingDeg: 180, pitchDeg: 0, rollDeg: 5 });
  ok(near(off.heading, 1.5 * Math.PI, 1e-12) && near(off.roll, 5 * Math.PI / 180, 1e-12), "a model's index.json offset is added before conversion (race.js applyModelTransform)");
  ok(S.hprRadians('x', null, undefined).heading === 0, 'garbage attitude becomes wings-level, never NaN');
}

section('speeds + speed colours');
{
  const tr = northTrace(10, 100);
  const v = S.traceSpeeds(tr);
  ok(v.length === tr.length && v.every((x) => near(x, 100, 0.5)), 'traceSpeeds recovers a steady 100 m/s: ' + v[5].toFixed(2));
  ok(S.speedColor(0, 0, 100) === '#6b4aa8', 'slowest is plum: ' + S.speedColor(0, 0, 100));
  ok(S.speedColor(100, 0, 100) === '#ffd23d', 'fastest is the sun: ' + S.speedColor(100, 0, 100));
  ok(/^#[0-9a-f]{6}$/.test(S.speedColor(50, 50, 50)), 'a zero-span range still returns a colour');
}

section('gate crossings, sectors, delta vs record');
{
  const tr = northTrace(40, 100);                        // 4 km in 40 s
  const gates = [gateNorth(0), gateNorth(1000), gateNorth(2550), gateNorth(4000)];
  const cr = S.gateCrossings(tr, gates);
  ok(cr.every(Boolean), 'every gate on the line is found');
  ok(near(cr[1].t, 10000, 5) && near(cr[2].t, 25500, 5), 'crossing times are refined between samples: ' + cr.map((c) => c && Math.round(c.t)).join(','));
  const missing = S.gateCrossings(tr, [gateNorth(0), { lat: 46, lon: -121, alt: 1000, radius: 100 }, gateNorth(3000)]);
  ok(missing[1] === null && missing[2] && near(missing[2].t, 30000, 5), 'a gate never approached is null and the search carries on');
  // Out-and-back: gate 2 sits on gate 0's spot; forward-only search must not match the start.
  const back = tr.concat(tr.slice().reverse().map((r, i) => ({ ...r, t: 40000 + (i + 1) * 250 })));
  const loop = S.gateCrossings(back, [gateNorth(0), gateNorth(4000), gateNorth(0)]);
  ok(loop[2] && loop[2].t > 70000, 'forward-only: a circuit revisiting the start is matched on the return pass: ' + (loop[2] && loop[2].t));
  const sec = S.sectorTimes(cr);
  ok(sec.length === 3 && near(sec[0], 10000, 5) && near(sec[2], 14500, 5), 'sectorTimes are gate-to-gate legs');
  ok(S.sectorTimes([cr[0], null, cr[2]]).every((x) => x === null), 'a missing gate nulls both legs that touch it');
  ok(JSON.stringify(S.bestSectors([[5, 9, null], [6, 8, null], [5, 10, 3]])) === '[0,1,2]', 'bestSectors: fastest per leg, ties to the earlier pilot');
  const slow = northTrace(40, 80);
  const d = S.deltaVsReference(slow, tr);
  ok(d.length === slow.length && d[0].delta === 0, 'delta starts at zero on the start line');
  const at = d[d.length - 1];
  ok(at.delta > 7000 && at.delta < 9000, 'a pilot at 80 m/s is ~8 s behind a 100 m/s record after 3.2 km: ' + at.delta);
  ok(S.deltaVsReference(tr, tr).every((p) => p.delta === 0), 'the record vs itself is zero everywhere');
}

section('race order + interval');
{
  const gates = [gateNorth(0), gateNorth(1000), gateNorth(2000), gateNorth(3000)];
  const fast = { id: 'Dave', crossings: S.gateCrossings(northTrace(30, 100), gates), finishMs: 30000 };
  const slow = { id: 'Eric', crossings: S.gateCrossings(northTrace(40, 80), gates), finishMs: 37500 };
  const o = S.raceOrderAt([slow, fast], 15000);
  ok(o[0].id === 'Dave' && o[0].gapMs === 0, 'the faster pilot leads with a zero gap');
  ok(o[1].id === 'Eric' && near(o[1].gapMs, 3000, 30), 'the gap is how long ago the leader was where Eric is now (1200 m: Dave was there at 12 s): ' + o[1].gapMs);
  const early = S.raceOrderAt([slow, fast], 5000);
  ok(early[1].gapMs > 900 && early[1].gapMs < 1100, 'the gap moves before the second gate too (400 m vs 500 m at 5 s -> 1 s): ' + early[1].gapMs);
  const fin = S.raceOrderAt([slow, fast], 40000);
  ok(near(fin[1].gapMs, 7500, 30), 'once both are home the gap is the finish-time difference: ' + fin[1].gapMs);
  const done = S.raceOrderAt([slow, fast], 31000);
  ok(done[0].finished && !done[1].finished, 'finished flags follow each pilot\'s own finish time');
}

section('records, medal table, head-to-head, pilot summary');
{
  const courses = { aaaaaaaa: { course_id: 'crater-rim', course_name: 'Crater Lake Rim (medium)', cup: 'Cascade Cup' },
                    bbbbbbbb: { course_id: 'gorge-run', course_name: 'Columbia Gorge Run (easy)', cup: 'Cascade Cup' } };
  const boards = {
    aaaaaaaa: [ { callsign: 'Dave', time_ms: 100000, created_at: 2000, attempts: 3, model: 'goldfish', has_ghost: true },
                { callsign: 'Eric', time_ms: 101300, created_at: 1000, attempts: 9, model: 'cow' },
                { callsign: 'Steve', time_ms: 108000, created_at: 1500, attempts: 1 } ],
    bbbbbbbb: [ { callsign: 'Eric', time_ms: 50000, created_at: 3000, attempts: 2, model: 'toilet' },
                { callsign: 'Dave', time_ms: 56000, created_at: 2500, attempts: 1 } ],
    cccccccc: [],
  };
  const now = 5000 * 1000;
  const recs = S.buildRecords(boards, courses, now);
  ok(recs.length === 2, 'buildRecords skips empty boards');
  ok(recs[0].course_id === 'gorge-run' && recs[1].course_id === 'crater-rim', 'records are newest-set first');
  const cr = recs[1];
  ok(cr.holder === 'Dave' && cr.second.callsign === 'Eric' && cr.margin_ms === 1300, 'holder, #2 and margin come from the board: ' + cr.margin_ms);
  ok(cr.reign_s === 3000, 'reign = now - the record run\'s created_at');
  const solo = S.buildRecords({ x: [{ callsign: 'A', time_ms: 5, created_at: 1 }] }, {}, now)[0];
  ok(solo.second === null && solo.margin_ms === null && solo.course_name === 'x', 'a one-pilot board has no #2 and falls back to the hash for a name');

  const mt = S.medalTable(boards);
  const dave = mt.find((r) => r.callsign === 'Dave'), eric = mt.find((r) => r.callsign === 'Eric'), steve = mt.find((r) => r.callsign === 'Steve');
  ok(dave.gold === 1 && dave.silver === 0 && dave.bronze === 0 && dave.records === 1, 'Dave: record on crater (gold), 12% off on gorge (nothing)');
  ok(eric.gold === 2 && eric.records === 1, 'Eric: record on gorge, 1.3% off on crater = two golds');
  ok(steve.bronze === 1 && steve.total === 1, 'Steve: 8% off = bronze');
  ok(mt[0].callsign === 'Eric', 'medal table sorts by golds first');
  const byBronze = mt.slice().sort(S.medalSort('bronze'));
  ok(byBronze[0].callsign === 'Steve', 'medalSort re-sorts by any column');
  ok(mt.slice().sort(S.medalSort('callsign', true))[0].callsign === 'Dave', 'medalSort by callsign ascending');

  const h = S.headToHead(boards, 'Dave', 'Eric', courses);
  ok(h.wins === 1 && h.losses === 1 && h.ties === 0 && h.courses.length === 2, 'head-to-head W-L counts only shared courses: ' + h.wins + '-' + h.losses);
  ok(S.headToHead(boards, 'Steve', 'Nobody', courses).courses.length === 0, 'no shared courses -> empty, not an error');
  const rv = S.rivals(boards, 'Dave', courses);
  ok(rv[0].b === 'Eric' && rv[0].courses.length === 2 && rv[1].b === 'Steve', 'rivals: most shared courses first');

  const recent = [{ started_at: 4000, course_name: 'Crater Lake Rim', course_hash: 'aaaaaaaa', results: [
    { callsign: 'Dave', pos: 1, status: 'finished', points: 15 }, { callsign: 'Eric', pos: 2, status: 'finished', points: 12 }] },
    { started_at: 4100, course_name: 'Gorge', results: [{ callsign: 'Dave', pos: 1, status: 'dnf', points: 0 }] }];
  const p = S.pilotSummary(boards, courses, recent, 'Dave');
  ok(p.pbs.length === 2 && p.records === 1 && p.medals.gold === 1, 'pilotSummary: PBs, records held, medals');
  ok(p.runs === 4 && p.lobbyRaces === 2 && p.wins === 1 && p.podiums === 1, 'a DNF is neither a win nor a podium: ' + JSON.stringify([p.runs, p.lobbyRaces, p.wins, p.podiums]));
  ok(p.favourite.course_id === 'crater-rim', 'favourite course = most attempts');
  ok(p.lastModel === 'goldfish', 'lastModel is the model on the most recent PB');
  ok(p.activity[0].kind === 'race' && p.activity[0].at === 4100, 'activity is newest first across races and PBs');
  const pb = p.pbs.find((x) => x.course_id === 'gorge-run');
  ok(pb.rank === 2 && pb.gap_ms === 6000 && pb.medal === null, 'a PB row knows its rank, gap to the record and medal');
  const idx = S.pilotIndex(boards, recent);
  ok(idx[0].callsign === 'Dave' && idx.some((r) => r.callsign === 'Steve'), 'pilotIndex lists everyone, most courses first');

  const feed = S.recordFeed(recs);
  ok(feed[1].parts[0].pilot === 'Dave' && feed[1].parts[2].course_id === 'crater-rim' && feed[1].parts[4].pilot === 'Eric', 'recordFeed links holder, course and #2');
  ok(feed[1].parts[3].text.includes('1.3 s clear of'), 'recordFeed states the margin');
  ok(S.recordFeed([solo])[0].parts[1].text.includes('first time'), 'a lone time reads as the first time set, not a steal');
}

section('record history: true reigns and the dethroned feed');
{
  const now = Date.UTC(2026, 8, 24) ;
  const day = 86400;
  const t0 = now / 1000;
  // Newest first, as GET /records/history returns it.
  const hist = [
    { callsign: 'Dave', time_ms: 58000, prev_holder: 'Dave', prev_time_ms: 59000, created_at: t0 - 1 * day },
    { callsign: 'Dave', time_ms: 59000, prev_holder: 'Eric', prev_time_ms: 60000, created_at: t0 - 5 * day },
    { callsign: 'Eric', time_ms: 60000, prev_holder: null, prev_time_ms: null, created_at: t0 - 9 * day },
  ];
  const rg = S.reignFromHistory(hist, 'Dave', now);
  ok(rg.since === t0 - 5 * day && rg.reign_s === 5 * day, 'beating your own record does not reset the reign: ' + JSON.stringify(rg));
  ok(S.reignFromHistory(hist, 'Eric', now) === null, 'history that does not start with the holder gives null (caller falls back)');
  ok(S.reignFromHistory([], 'Dave', now) === null && S.reignFromHistory(undefined, 'Dave', now) === null, 'no history -> null, never a throw');

  const recs = [
    { course_hash: 'aaaaaaaa', holder: 'Dave', set_at: t0 - 1 * day, reign_s: 1 * day },
    { course_hash: 'bbbbbbbb', holder: 'Zed', set_at: t0 - 2 * day, reign_s: 2 * day },
  ];
  const wh = S.withHistory(recs, { aaaaaaaa: hist }, now);
  ok(wh[0].reign_s === 5 * day && wh[0].reign_from === 'history' && wh[0].reign_since === t0 - 5 * day, 'withHistory: a course with history gets the true reign');
  ok(wh[1].reign_s === 2 * day && wh[1].reign_from === 'run', 'withHistory: a course without history keeps the record-run reign');
  ok(recs[0].reign_s === 1 * day, 'withHistory does not mutate its input');
  ok(S.withHistory(recs, null, now)[0].reign_from === 'run', 'no histories at all -> every reign from the run');

  const courses = { aaaaaaaa: { course_id: 'crater-rim', course_name: 'Crater Rim (hard)' } };
  const feed = S.dethronedFeed({ aaaaaaaa: hist, cccccccc: [{ callsign: 'Amy', time_ms: 1000, prev_holder: 'Bo', prev_time_ms: 1500, created_at: t0 - 2 * day }] }, courses, 10);
  ok(feed.length === 2, 'only real changes of hands: self-improvements and first records are left out');
  ok(feed[0].taker === 'Amy' && feed[1].taker === 'Dave' && feed[1].from === 'Eric', 'newest first across courses');
  ok(feed[1].margin_ms === 1000 && feed[1].course_id === 'crater-rim' && feed[0].course_name === 'cccccccc', 'margin, course naming, and a hash fallback for an unknown course');
  ok(S.dethronedFeed({ aaaaaaaa: hist }, courses, 1).length === 1 && S.dethronedFeed(null).length === 0, 'limit applies; no histories -> empty');

  const rec = [{ course_hash: 'aaaaaaaa', course_id: 'crater-rim', course_name: 'Crater Rim', holder: 'Dave', time_ms: 58000, set_at: t0 - day, second: { callsign: 'Eric', time_ms: 60000 }, margin_ms: 2000 }];
  const withH = S.recordFeed(rec, 6, { aaaaaaaa: [{ callsign: 'Dave', time_ms: 58000, prev_holder: 'Eric', prev_time_ms: 60000, created_at: t0 - day }] });
  ok(withH[0].parts.map((p) => p.text || p.pilot || p.course).join('') === 'Dave took Crater Rim from Eric by 2.0 s', 'home feed with history: ' + withH[0].parts.map((p) => p.text || p.pilot || p.course).join(''));
  const selfImp = S.recordFeed(rec, 6, { aaaaaaaa: hist.slice(0, 1) });
  ok(selfImp[0].parts[1].text === ' holds ', 'a self-improvement keeps the "holds" wording');
  ok(S.recordFeed(rec, 6)[0].parts[1].text === ' holds ', 'no history -> the board-only wording');
}

section('pilot page: the /pilots profile overlays the board summary');
{
  const sum = { callsign: 'eric', pbs: [{}], lobbyRaces: 3, wins: 1, lastSeen: 2000, medals: { gold: 1, silver: 0, bronze: 0 } };
  const m = S.mergePilotProfile(sum, { pilot_id: 'x', callsign: 'Eric', created_at: 100, last_seen: 5000, race_count: 140, wins: 12,
    medal_inputs: { wins: 12, cup_points: 300, records_taken: 4 } });
  ok(m.claimed && m.callsign === 'Eric' && m.lobbyRaces === 140 && m.wins === 12, 'race count and wins come from the full profile, callsign in its canonical spelling');
  ok(m.recordsTaken === 4 && m.lastSeen === 5000 && m.memberSince === 100, 'records taken, last seen and member-since carried over');
  ok(sum.lobbyRaces === 3 && sum.callsign === 'eric', 'the summary itself is not mutated');
  const older = S.mergePilotProfile(sum, { callsign: 'Eric', last_seen: 1000, race_count: 1, wins: 0 });
  ok(older.lastSeen === 2000 && older.lobbyRaces === 3 && older.wins === 1, 'a stale profile never lowers what the boards already show');
  const none = S.mergePilotProfile(sum, null);
  ok(!none.claimed && none.recordsTaken === null && none.lobbyRaces === 3, 'no profile (unclaimed callsign, 404) leaves the board summary as is');
}

section('course helpers');
{
  ok(JSON.stringify(S.parseCourseName('Budapest Danube Chain Bridge (3 laps, hard)')) === JSON.stringify({ title: 'Budapest Danube Chain Bridge', laps: 3, tag: 'hard' }), 'parseCourseName with laps');
  ok(S.parseCourseName('Crater Lake Rim (medium)').laps === 1 && S.parseCourseName('Crater Lake Rim (medium)').tag === 'medium', 'parseCourseName without laps');
  ok(S.parseCourseName('Plain').title === 'Plain' && S.parseCourseName(null).title === '', 'parseCourseName with no suffix / null');
  ok(S.courseClass('Pylon Cup', 'reno') === 'pylon' && S.courseClass('Bush Cup', 'x') === 'bush' && S.courseClass('Cascade Cup', 'gorge-run') === 'race', 'courseClass by cup');
  const cat = [{ course_id: 'c' }, { course_id: 'a' }, { course_id: 'b' }];
  const mon = Date.UTC(2026, 8, 21), sun = Date.UTC(2026, 8, 27, 23, 59), nextMon = Date.UTC(2026, 8, 28);
  ok(S.courseOfWeek(cat, mon).course_id === S.courseOfWeek(cat, sun).course_id, 'course of the week is stable Monday..Sunday');
  ok(S.courseOfWeek(cat, mon).course_id !== S.courseOfWeek(cat, nextMon).course_id, 'and changes on Monday 00:00 UTC');
  ok(S.courseOfWeek(cat.slice().reverse(), mon).course_id === S.courseOfWeek(cat, mon).course_id, 'catalog order does not matter');
  ok(S.courseOfWeek([], mon) === null, 'empty catalog -> null');
}

section('route mini-map projection');
{
  // A square 1 km on a side at 60N: lon span is twice the lat span in degrees.
  const dLat = 1000 / M_PER_DEG_LAT, dLon = dLat / Math.cos(60 * Math.PI / 180);
  const sq = [{ lat: 60, lon: 10 }, { lat: 60, lon: 10 + dLon }, { lat: 60 + dLat, lon: 10 + dLon }, { lat: 60 + dLat, lon: 10 }];
  const mm = S.routeMiniMap(sq, 200, 100, 10);
  const w = mm.points[1].x - mm.points[0].x, h = mm.points[0].y - mm.points[3].y;
  ok(near(w, h, 1) && near(h, 80, 1), 'a square course draws square (aspect-correct) and fits the short side: ' + w.toFixed(1) + 'x' + h.toFixed(1));
  ok(near(mm.points[0].x, 60, 1), 'and is centred on the long side: x0=' + mm.points[0].x);
  ok(mm.points[3].y < mm.points[0].y, 'north is up');
  ok(mm.d.startsWith('M') && !mm.closed, 'returns a path; an open course is not closed');
  const circ = S.routeMiniMap(sq.concat([{ lat: 60, lon: 10 }]), 100, 100, 5);
  ok(circ.closed, 'an unrolled circuit (last gate on the first) is detected as closed');
  const P = S.makeProjector(sq, 200, 100, 10);
  ok(JSON.stringify(P(60, 10)) === JSON.stringify(mm.points[0]), 'makeProjector is the same frame routeMiniMap draws gates in');
  const mid = P(60 + dLat / 2, 10 + dLon / 2);
  ok(near(mid.x, 100, 1) && near(mid.y, 50, 1), 'a ghost between the gates lands between them: ' + JSON.stringify(mid));
  ok(Number.isFinite(S.makeProjector([], 10, 10, 1)(1, 1).x), 'an empty projector never returns NaN');
  ok(S.routeMiniMap([], 10, 10, 1).d === '' && S.routeMiniMap([{ lat: 1, lon: 1 }], 10, 10, 1).points.length === 1, 'empty and single-gate inputs never divide by zero');
}

section('terrain + elevation profile');
{
  ok(S.terrariumHeight(128, 0, 0) === 0, 'terrarium: (128,0,0) is sea level');
  ok(S.terrariumHeight(129, 44, 128) === 300.5, 'terrarium: R*256+G+B/256-32768');
  const t = S.lonLatToTile(0, 0, 1);
  ok(t.x === 1 && t.y === 1 && t.px === 0 && t.py === 0, 'lonLatToTile at (0,0) z1 is the top-left of tile 1/1');
  const t2 = S.lonLatToTile(85.1, -180, 3);
  ok(t2.x === 0 && t2.y === 0, 'lonLatToTile clamps to the Mercator limit');
  const st = S.profileStations([gateNorth(0), { ...gateNorth(1000), alt: 1200 }], 250);
  ok(st.length === 5 && near(st[4].d, 1000, 1) && st[4].gate === 1 && near(st[2].alt, 1100, 1e-9), 'profileStations samples every 250 m and interpolates altitude');
  const pp = S.profilePaths(st, st.map(() => 500), 100, 50, 0);
  ok(pp.alt.startsWith('M') && pp.ground.endsWith('Z') && pp.gates.length === 2, 'profilePaths draws altitude, a closed ground fill and gate markers');
  ok(S.profilePaths(st, [1, 2], 100, 50, 0).ground === '', 'misaligned ground samples are ignored, not drawn wrong');
}

section('CSP reading (skip requests the page is not allowed to make)');
{
  const cur = "default-src 'none'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self'; connect-src 'self'";
  const tgt = "default-src 'none'; connect-src 'self' https://s3.amazonaws.com https://server.arcgisonline.com; font-src 'self'";
  const self = 'https://race.finsonly.net';
  const tile = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/0/0/0.png';
  ok(S.cspAllows(cur, 'connect-src', tile, self) === false, "today's prod CSP blocks the terrain host");
  ok(S.cspAllows(tgt, 'connect-src', tile, self) === true, 'the target CSP allows it');
  ok(S.cspAllows(cur, 'connect-src', '/courses', self) === true, "'self' allows same-origin paths");
  ok(S.cspAllows(cur, 'font-src', self + '/fonts/x.woff2', self) === false && S.cspAllows(tgt, 'font-src', self + '/fonts/x.woff2', self) === true, 'font-src self-hosting: blocked today, allowed by the target');
  ok(S.cspAllows("default-src 'none'", 'connect-src', tile, self) === false, 'falls back to default-src');
  ok(S.cspAllows('connect-src https:', 'connect-src', tile, self) === true && S.cspAllows('connect-src *.amazonaws.com', 'connect-src', tile, self) === true, 'scheme and wildcard-host sources');
  ok(S.cspAllows('connect-src https://s3.amazonaws.com/other/', 'connect-src', tile, self) === false, 'a path-restricted source only matches its prefix');
  ok(S.cspAllows('', 'connect-src', tile, self) === true && S.cspAllows(null, 'img-src', tile, self) === true, 'no CSP at all allows everything');
}

section('landing: runways grouped by cup, breakdown columns only when served');
{
  const groups = [{ name: 'Mountain Cup', ids: ['kase-15', 'nzqn-05'] }, { name: 'Empty Cup', ids: ['gone-01'] }, { name: 'Dupe', ids: ['kase-15'] }];
  const rw = [{ id: 'nzqn-05', name: 'Queenstown' }, { id: 'sea-tac-16c', name: 'Sea-Tac' }, { id: 'kase-15', name: 'Aspen' }];
  const g = S.groupRunways(rw, groups);
  ok(g.map((x) => x.name).join('|') === 'Mountain Cup|Other runways', 'groups in config order; empty groups dropped; leftovers last: ' + g.map((x) => x.name).join('|'));
  ok(g[0].runways.map((r) => r.id).join() === 'kase-15,nzqn-05', "a group's runways follow the group's own order");
  ok(g[1].runways.length === 1 && g[1].runways[0].id === 'sea-tac-16c', 'a runway in no group is not lost');
  ok(S.groupRunways([], groups).length === 0 && S.groupRunways(rw, null)[0].name === 'Other runways', 'no runways -> no groups; no groups -> one "Other" group');
  ok(S.landingBreakdownCols([{ metric_value: 900 }, { metric_value: 800 }]).length === 0, "today's board rows (no breakdown) add no columns");
  const cols = S.landingBreakdownCols([{ breakdown: { zone_penalty: 12, vs_penalty: 40, along_m: 300 } }, { breakdown: { bounce_penalty: 0 } }]);
  ok(cols.map((c) => c.key).join() === 'vs_penalty,zone_penalty,bounce_penalty', 'only served penalties, in scoring order, and never the raw geometry: ' + cols.map((c) => c.key).join());
}

section('routing');
{
  const r = S.parseRoute('#/replay/crater-rim?pilots=Eric,Dave%2C%20Jr&t=42.5');
  ok(r.name === 'replay' && r.id === 'crater-rim', 'replay route + id');
  ok(JSON.stringify(r.query.pilots) === JSON.stringify(['Eric', 'Dave, Jr']) && r.query.t === 42.5, 'pilots split on commas, each decoded; t parsed: ' + JSON.stringify(r.query));
  ok(S.parseRoute('#/pilot/Big%20Al').id === 'Big Al', 'pilot callsign is URI-decoded');
  ok(S.parseRoute('').name === 'home' && S.parseRoute('#/').name === 'home', 'empty hash is home');
  ok(S.parseRoute('#/nope/x').name === 'notfound', 'unknown path is notfound');
  ok(S.parseRoute('#install').name === 'install' && S.parseRoute('#departures').anchor === 'departures', 'legacy one-page anchors still land somewhere sensible');
  ok(S.parseRoute('#/replay/x?t=-3').query.t === undefined && S.parseRoute('#/replay/x?t=abc').query.t === undefined, 'a negative or junk t is dropped');
  ok(S.parseRoute('#/replay/x?pilots=' + 'a,'.repeat(20)).query.pilots.length === 8, 'at most 8 pilots');
  ok(S.parseRoute('#/pilot/%E0%A4%A').id === '%E0%A4%A', 'a malformed escape does not throw');
  const built = S.buildRoute('replay', 'crater-rim', { pilots: ['Eric', 'Dave, Jr'], t: 42.47 });
  ok(built === '#/replay/crater-rim?pilots=Eric,Dave%2C%20Jr&t=42.5', 'buildRoute: ' + built);
  const rt = S.parseRoute(built);
  ok(rt.query.pilots[1] === 'Dave, Jr' && rt.query.t === 42.5, 'buildRoute -> parseRoute round-trips');
  ok(S.buildRoute('home') === '#/' && S.buildRoute('courses') === '#/courses', 'buildRoute simple pages');
  ok(S.buildRoute('cups', null, { id: 7 }) === '#/cups?id=7', 'other query keys pass through');
}

section('auto-director');
{
  let st = S.directorStep(null, { t: 0, order: ['A', 'B', 'C'] });
  ok(st.target === 'A' && st.shot === 'chase' && st.reason === 'start', 'starts on the leader in a chase shot');
  let s2 = S.directorStep(st, { t: 1, order: ['B', 'A', 'C'] });
  ok(s2.target === 'A' && s2.since === 0, 'no cut inside MIN_HOLD_S even on a lead change');
  s2 = S.directorStep(s2, { t: 3, order: ['B', 'A', 'C'] });
  ok(s2.target === 'A', 'the lead change seen during the hold is not replayed later (lastOrder tracks every frame)');
  s2 = S.directorStep(s2, { t: 4, order: ['A', 'B', 'C'] });
  ok(s2.target === 'A' && s2.reason === 'lead-change' && s2.since === 4, 'a lead change after the hold cuts to the new leader');
  let g = S.directorStep(s2, { t: 7, order: ['A', 'B', 'C'], crossings: [{ id: 'A', gate: 3 }] });
  ok(g.shot === 'gate' && g.gate === 3 && g.target === 'A', 'the followed pilot crossing a gate cuts to gate-cam');
  g = S.directorStep(g, { t: 8, order: ['A', 'B', 'C'], crossings: [{ id: 'A', gate: 4 }] });
  ok(g.shot === 'gate' && g.gate === 3, 'no re-cut while the gate shot holds');
  g = S.directorStep(g, { t: 10.1, order: ['A', 'B', 'C'] });
  ok(g.shot === 'chase' && g.reason === 'gate-done', 'the gate shot returns to chase after GATE_SHOT_S');
  const ov = S.directorStep(g, { t: 16, order: ['A', 'C', 'B'] });
  ok(ov.target === 'C' && ov.reason === 'overtake', 'a pass further back cuts to the overtaker once held 2x MIN_HOLD');
  const rot = S.directorStep({ target: 'A', shot: 'chase', since: 0, lastOrder: ['A', 'B'] }, { t: 12, order: ['A', 'B'] });
  ok(rot.shot === 'orbit' && rot.reason === 'rotate', 'nothing happening for MAX_HOLD_S rotates chase -> orbit');
  const gone = S.directorStep({ target: 'Z', shot: 'chase', since: 0, lastOrder: ['Z'] }, { t: 1, order: ['A'] });
  ok(gone.target === 'A', 'a hidden/removed target is replaced immediately');
  ok(S.directorStep({ target: 'A' }, { t: 1, order: [] }).target === 'A', 'an empty frame keeps the current shot');
}

section('timeline + delta chart');
{
  const ticks = S.timelineTicks([{ gate: 0, t: 0 }, null, { gate: 2, t: 5000 }], 10000);
  ok(ticks.length === 2 && ticks[1].frac === 0.5 && ticks[1].label === '3', 'timelineTicks skips missing gates and labels 1-based');
  const ch = S.deltaChartPath([{ t: 0, delta: 0 }, { t: 1000, delta: 1000 }], 1000, 100, 40);
  ok(ch.d === 'M0.00,20.00 L100.00,38.00' && ch.maxAbs === 1000, 'deltaChartPath: behind plots downward: ' + ch.d);
  ok(S.deltaChartPath([], 1, 1, 1).d === '', 'empty series -> empty path');
  const shared = S.deltaChartPath([{ t: 0, delta: 0 }, { t: 1000, delta: 4000 }], 1000, 100, 40, 2000);
  ok(shared.maxAbs === 2000 && shared.d.endsWith('38.00'), 'a shared scale clamps a series that runs past it: ' + shared.d);
}

section('replay sources: ghosts and lobby races normalise to one pilot list');
{
  // race.js's columnar wire format: t delta-encoded after the first sample.
  const enc = (rows) => ({ v: 1, n: rows.length, t: rows.map((r, i) => (i ? r.t - rows[i - 1].t : r.t)),
    lat: rows.map((r) => r.lat), lon: rows.map((r) => r.lon), alt: rows.map((r) => r.alt),
    hdg: rows.map((r) => r.hdg), pitch: rows.map((r) => r.pitch), roll: rows.map((r) => r.roll) });
  const a = northTrace(30, 100), b = northTrace(34, 90), c = northTrace(20, 80);
  const g = S.replayFromGhosts([
    { callsign: 'Slow', time_ms: 34000, model: 'goldfish', trace: enc(b) },
    { callsign: 'Fast', time_ms: 30000, model: '', trace: enc(a) },
    { callsign: 'Broken', time_ms: 1, trace: { v: 1, n: 2, t: [0], lat: [], lon: [], alt: [], hdg: [], pitch: [], roll: [] } },
  ]);
  ok(g.pilots.map((p) => p.callsign).join() === 'Fast,Slow' && g.pilots[0].rank === 1 && g.pilots[1].rank === 2, 'ghosts rank fastest first');
  ok(g.dropped.join() === 'Broken', 'an undecodable ghost is dropped and named, not thrown');
  ok(g.pilots[1].modelId === 'goldfish' && g.pilots[0].rows.length === a.length && g.pilots[0].rows[5].t === a[5].t, 'model id and decoded rows (t un-delta-ed) carried through');
  ok(S.replayFromGhosts(Array.from({ length: 12 }, (_, i) => ({ callsign: 'P' + i, time_ms: 1000 + i, trace: enc(a) }))).pilots.length === 8, 'at most 8 ghosts');

  const race = {
    race: { id: 7, course_hash: '0a1b2c3d', course_name: 'X' },
    results: [
      { callsign: 'Winner', pos: 1, status: 'finished', go_time_ms: 30000, points: 10, model: 'm1' },
      { callsign: 'Second', pos: 2, status: 'finished', go_time_ms: 34000, points: 8, model: '' },
      { callsign: 'Crashed', pos: 3, status: 'dnf', go_time_ms: null, points: 0, model: '' },
      { callsign: 'NoTrace', pos: 4, status: 'finished', go_time_ms: 40000, points: 5, model: '' },
    ],
    traces: [
      { callsign: 'Crashed', model: '', time_ms: 20000, trace: enc(c) },
      { callsign: 'Second', model: '', time_ms: 34000, trace: enc(b) },
      { callsign: 'Winner', model: 'm1', time_ms: 30000, trace: enc(a) },
    ],
  };
  const r = S.replayFromRace(race);
  ok(r.pilots.map((p) => p.callsign).join() === 'Winner,Second,Crashed', 'race pilots in finishing order, DNF after every finisher: ' + r.pilots.map((p) => p.callsign).join());
  ok(r.pilots[2].status === 'dnf' && r.pilots[2].time_ms === null && r.pilots[0].time_ms === 30000, 'a DNF has no time; a finisher keeps go_time_ms');
  ok(r.dropped.join() === 'NoTrace', 'a racer with no trace is reported, not invented');
  ok(r.results.length === 4, 'the full results list rides along for the results table');
  ok(S.replayFromRace({ race: {}, results: [], traces: [] }).pilots.length === 0 && S.replayFromRace(null).pilots.length === 0, 'an empty or missing replay is an empty list, never a throw');
  ok(S.replayDuration(r.pilots) === 34000 + 1500 && S.replayDuration([], 0) === 0, 'duration = longest trace + a 1.5 s tail');

  const rr = S.parseRoute('#/replay/race/42?t=12.5');
  ok(rr.name === 'raceReplay' && rr.id === '42' && rr.query.t === 12.5, 'race replay route parses: ' + JSON.stringify(rr));
  ok(S.buildRoute('raceReplay', 42, { t: 12.5 }) === '#/replay/race/42?t=12.5', 'buildRoute raceReplay: ' + S.buildRoute('raceReplay', 42, { t: 12.5 }));
  ok(S.parseRoute('#/replay/crater-rim').name === 'replay' && S.parseRoute('#/replay/race/abc').name === 'notfound', 'course replays still route; a non-numeric race id is not a race');
}

section('original landing helpers are still exported (run.js pins them)');
{
  for (const k of ['boundsOf', 'projectLatLon', 'buildTracePath', 'decodeTrace', 'sampleTraceAt', 'fmtClock', 'fmtNum', 'timeAgo', 'slug']) {
    ok(typeof S[k] === 'function', k + ' is exported');
  }
}

console.log('\n' + count + ' checks, ' + (failures ? failures + ' FAILED' : 'all passed'));
process.exit(failures ? 1 : 0);
