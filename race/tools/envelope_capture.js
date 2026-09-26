/*
 * FINSONLY Racing — ENVELOPE CAPTURE (one-shot, READ-ONLY flight card + 20 Hz recorder).
 *
 * Feeds race/tools/envelope.py --lab: the rival generator's aircraft envelope (max level speed,
 * full-throttle acceleration, sustained/instantaneous turn load factor, roll rate, zoom climb,
 * idle deceleration) measured in GeoFS itself, for the bins real race traces leave thin.
 *
 * Same rules as race/tools/probe.js and terrain_probe.js: ZERO writes to sim state. It only reads,
 * and only through window.__finsRace.dev.G (race.js's frozen read-only wrapper: lla, heading,
 * pitch, roll, kias, vsFpm, haglM, aircraftId). No controls, no autopilot, no placement. You fly
 * the card by hand; this only shows the card, records, and copies JSON.
 *
 * Use: load FINSONLY Racing (CONFIG.DEV_API on), sit in the F-16, click the ENVELOPE CAPTURE
 * bookmarklet (race/rivals/README.md). A card appears top-left. For each step: set up as the card
 * says, press START STEP (or Alt+E), fly it until the step's timer runs out (or press END STEP).
 * Setup time between steps is recorded as step 0 and ignored by envelope.py. DONE copies the
 * report to the clipboard (console.log fallback). About 6 minutes of flying.
 */
(function () {
  'use strict';

  // ------------------------------------------------------------------ pure
  const HZ = 20;
  const MAX_SAMPLES = 20 * 60 * 12;      // 12 minutes at 20 Hz, then recording stops
  // kind routes a step's samples into envelope.py's tables (mine_lab): accel -> accel + vmax,
  // turn -> n_inst/n_sus, roll -> roll rate, zoom -> specific excess power, decel -> decel.
  const CARD = [
    { id: 1, kind: 'accel', seconds: 60, title: 'Level accel, 500 ft', text: '500 ft AGL, ~250 kt, wings level. FULL throttle. Hold 500 ft and let it run to max speed.' },
    { id: 2, kind: 'accel', seconds: 50, title: 'Level accel, 10,000 ft', text: '10,000 ft, ~250 kt, wings level. FULL throttle. Hold altitude to max speed.' },
    { id: 3, kind: 'turn', seconds: 25, title: 'Max turn at 250 kt', text: 'Level turn from 250 kt, full throttle. Pull as hard as it will hold 250 kt, then harder for the last 5 s.' },
    { id: 4, kind: 'turn', seconds: 25, title: 'Max turn at 350 kt', text: 'Same at 350 kt: sustained pull, then max pull for the last 5 s.' },
    { id: 5, kind: 'turn', seconds: 25, title: 'Max turn at 450 kt', text: 'Same at 450 kt.' },
    { id: 6, kind: 'turn', seconds: 25, title: 'Max turn at 550 kt', text: 'Same at 550 kt (dive a little to get there first).' },
    { id: 7, kind: 'roll', seconds: 20, title: 'Full-deflection rolls', text: 'Wings level, ~350 kt. Full stick: 360 left, 360 right, twice.' },
    { id: 8, kind: 'zoom', seconds: 30, title: 'Zoom climb', text: 'From 450+ kt, full throttle: pull to 45-60 deg nose up and hold it until 250 kt.' },
    { id: 9, kind: 'decel', seconds: 40, title: 'Idle decel', text: 'Level at ~450 kt. IDLE throttle (speedbrake if you have one). Hold altitude down to 200 kt.' },
  ];
  const cardSeconds = (card) => (card || CARD).reduce((s, st) => s + st.seconds, 0);

  // One 20 Hz read -> one row [t, lat, lon, alt, hdg, pitch, roll, kias, vsFpm, haglM, step], or
  // null when the position is unreadable. Attitude/speed that reads as anything but a number is 0.
  function buildRow(reads, tMs, stepId) {
    if (!reads || !reads.lla) return null;
    const { lat, lon, alt } = reads.lla;
    if (![lat, lon, alt, tMs].every(Number.isFinite)) return null;
    const n = (x) => (Number.isFinite(+x) ? Math.round(+x * 100) / 100 : 0);
    return [Math.round(tMs), Math.round(lat * 1e7) / 1e7, Math.round(lon * 1e7) / 1e7, Math.round(alt * 100) / 100,
      n(reads.heading), n(reads.pitch), n(reads.roll), n(reads.kias), n(reads.vsFpm), n(reads.haglM), stepId | 0];
  }

  // Card state machine. state: {index, phase: 'setup'|'record'|'done', stepStartMs}.
  function cardInitial() { return { index: 0, phase: 'setup', stepStartMs: null }; }
  function cardReduce(state, ev, nowMs, card) {
    const c = card || CARD;
    const s = { ...state };
    if (s.phase === 'done') return s;
    if (ev === 'start' && s.phase === 'setup') { s.phase = 'record'; s.stepStartMs = nowMs; return s; }
    if (ev === 'end' || (ev === 'tick' && s.phase === 'record' && nowMs - s.stepStartMs >= c[s.index].seconds * 1000)) {
      if (s.phase !== 'record') return s;
      s.index += 1; s.stepStartMs = null;
      s.phase = s.index >= c.length ? 'done' : 'setup';
      return s;
    }
    if (ev === 'skip' && s.phase === 'setup') {
      s.index += 1;
      if (s.index >= c.length) s.phase = 'done';
      return s;
    }
    if (ev === 'done') { s.phase = 'done'; return s; }
    return s;
  }
  // The step id a sample recorded now belongs to: the current step while recording, else 0.
  const cardStepId = (state, card) => (state.phase === 'record' ? (card || CARD)[state.index].id : 0);
  const cardRemainingS = (state, nowMs, card) => (state.phase === 'record'
    ? Math.max(0, (card || CARD)[state.index].seconds - (nowMs - state.stepStartMs) / 1000) : null);

  function buildReport(meta, rows, card) {
    const c = card || CARD;
    return {
      kind: 'fins-envelope-capture', v: 1, hz: HZ, aircraftId: meta && meta.aircraftId != null ? String(meta.aircraftId) : null,
      raceVersion: (meta && meta.raceVersion) || null, capturedAt: (meta && meta.capturedAt) || null,
      columns: ['t', 'lat', 'lon', 'alt', 'hdg', 'pitch', 'roll', 'kias', 'vsFpm', 'haglM', 'step'],
      steps: c.map((s) => ({ id: s.id, kind: s.kind, title: s.title, seconds: s.seconds })),
      counts: c.reduce((o, s) => { o[s.id] = rows.filter((r) => r[10] === s.id).length; return o; }, {}),
      samples: rows,
    };
  }

  const pure = { HZ, CARD, MAX_SAMPLES, cardSeconds, buildRow, cardInitial, cardReduce, cardStepId, cardRemainingS, buildReport };
  if (typeof window === 'undefined') { if (typeof module !== 'undefined' && module.exports) module.exports = pure; return; }

  // ------------------------------------------------------------------ browser (reads only)
  const FR = window.__finsRace;
  const dev = FR && FR.dev;
  if (!dev || !dev.G) { alert('ENVELOPE CAPTURE: load FINSONLY Racing first (CONFIG.DEV_API must be on).'); return; }
  if (window.__finsEnvelopeCapture) { window.__finsEnvelopeCapture.show(); return; }
  const G = dev.G;
  const safe = (f) => { try { return f(); } catch (_) { return null; } };
  const read = () => ({ lla: safe(G.lla), heading: safe(G.heading), pitch: safe(G.pitch), roll: safe(G.roll),
    kias: safe(G.kias), vsFpm: safe(G.vsFpm), haglM: safe(G.haglM) });

  let state = cardInitial();
  const rows = [];
  const t0 = performance.now();
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;top:12px;left:12px;z-index:2147483647;width:340px;background:rgba(10,14,22,.92);color:#eef;' +
    'font:13px/1.4 system-ui,sans-serif;padding:12px 14px;border-radius:10px;box-shadow:0 4px 18px rgba(0,0,0,.5)';
  const title = document.createElement('div'); title.style.cssText = 'font-weight:700;font-size:15px;margin-bottom:4px';
  const text = document.createElement('div'); text.style.cssText = 'margin-bottom:8px';
  const status = document.createElement('div'); status.style.cssText = 'font:12px ui-monospace,monospace;opacity:.85;margin-bottom:8px';
  const btn = (label, fn) => { const b = document.createElement('button'); b.textContent = label; b.onclick = fn;
    b.style.cssText = 'margin-right:6px;padding:5px 10px;border-radius:6px;border:0;background:#2b6cf6;color:#fff;cursor:pointer'; return b; };
  const bStart = btn('START STEP', () => step('start')), bEnd = btn('END STEP', () => step('end')),
    bSkip = btn('SKIP', () => step('skip')), bDone = btn('DONE · COPY', () => finish());
  box.append(title, text, status, bStart, bEnd, bSkip, bDone);
  document.body.appendChild(box);

  function step(ev) { state = cardReduce(state, ev, performance.now() - t0); render(); if (state.phase === 'done') finish(); }
  function render() {
    const now = performance.now() - t0;
    if (state.phase === 'done') { title.textContent = 'Card complete'; text.textContent = 'Report copied (or in the console). Paste it into a file and run envelope.py --lab FILE.'; }
    else {
      const st = CARD[state.index];
      title.textContent = (state.index + 1) + '/' + CARD.length + ' · ' + st.title + (state.phase === 'record' ? ' · REC' : ' · set up');
      text.textContent = st.text;
    }
    const rem = cardRemainingS(state, now);
    const r = read();
    status.textContent = (rem != null ? rem.toFixed(0) + ' s left · ' : '') + (r.kias != null ? Math.round(r.kias) + ' kt · ' : '') +
      rows.length + ' samples · aircraft ' + safe(G.aircraftId);
    bStart.disabled = state.phase !== 'setup'; bEnd.disabled = state.phase !== 'record';
  }
  const timer = setInterval(() => {
    const now = performance.now() - t0;
    const before = state.phase;
    state = cardReduce(state, 'tick', now);
    if (rows.length < MAX_SAMPLES) { const row = buildRow(read(), now, cardStepId(state)); if (row) rows.push(row); }
    if (before !== state.phase || Math.round(now) % 250 < 50) render();
    if (state.phase === 'done' && before !== 'done') finish();
  }, 1000 / HZ);
  const onKey = (e) => { if (e.altKey && (e.key === 'e' || e.key === 'E')) { e.preventDefault(); step(state.phase === 'record' ? 'end' : 'start'); } };
  window.addEventListener('keydown', onKey, true);

  let finished = false;
  function finish() {
    if (finished) return;
    finished = true;
    clearInterval(timer);
    window.removeEventListener('keydown', onKey, true);
    state = cardReduce(state, 'done', performance.now() - t0);
    const report = buildReport({ aircraftId: safe(G.aircraftId), raceVersion: dev.version, capturedAt: new Date().toISOString() }, rows);
    const json = JSON.stringify(report);
    const fallback = () => { console.log('[envelope capture] report:', json); };
    try { navigator.clipboard.writeText(json).then(() => console.info('[envelope capture] copied ' + rows.length + ' samples'), fallback); } catch (_) { fallback(); }
    render();
  }
  window.__finsEnvelopeCapture = { show() { box.style.display = ''; }, rows, finish };
  render();
})();
