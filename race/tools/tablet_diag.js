/*
 * FINSONLY Racing — tablet speed/altitude diagnostic (bookmarklet-loadable, read-only).
 *
 * Why: on the Android tablet the race HUD's speed/alt box read "20 kt / 1 ft" while airborne
 * mid-course. race.js reads speed from geofs.animation.values.kias and altitude from
 * geofs.aircraft.instance.llaLocation[2] (metres, shown as feet). This prints those two, what the
 * HUD itself is showing, and the nearby candidates once per second for 20 s, so the right source
 * can be chosen from real numbers instead of a guess. Fly straight and level at a known speed and
 * altitude (GeoFS's own gauges) while it runs.
 *
 * Output: an on-screen panel (the tablet has no easy console) that updates every second, and a
 * Copy JSON button when it finishes (also console.logged). Tap the panel's × to remove it.
 *
 * Read-only: every value is a plain property read wrapped in try/catch. No setter is called and
 * nothing GeoFS owns is changed; the only DOM it adds is its own #fins-tablet-diag panel.
 */
(() => {
  'use strict';

  const SAMPLE_MS = 1000;
  const SAMPLE_COUNT = 20;

  // ---------------------------------------------------------------- pure helpers (Node-testable)
  function num(v) { return typeof v === 'number' && isFinite(v) ? Math.round(v * 100) / 100 : null; }
  // Every finite number in `obj` whose key matches `re`, capped, keyed by name. Never throws.
  function pickNumeric(obj, re, cap) {
    const out = {};
    if (!obj || typeof obj !== 'object') return out;
    let keys = [];
    try { keys = Object.keys(obj); } catch (_) { return out; }
    for (const k of keys) {
      if (Object.keys(out).length >= (cap || 40)) break;
      if (!re.test(k)) continue;
      let v;
      try { v = obj[k]; } catch (_) { continue; }
      const n = num(v);
      if (n != null) out[k] = n;
    }
    return out;
  }
  function vecLen(v) {
    if (!v || typeof v.length !== 'number' || v.length < 3) return null;
    const x = +v[0], y = +v[1], z = +v[2];
    return [x, y, z].every(isFinite) ? num(Math.sqrt(x * x + y * y + z * z)) : null;
  }
  // One line for the on-screen panel, from one sample.
  function summaryLine(s) {
    const f = (v, unit) => (v == null ? '—' : v + unit);
    return '#' + s.i + '  kias ' + f(s.kias, '') + '  lla[2] ' + f(s.llaAltM, ' m') + '  hagl ' + f(s.haglMeters, ' m')
      + '  gs ' + f(s.groundSpeed, '') + '  |v| ' + f(s.rigidBodySpeedMs, ' m/s') + '  HUD "' + (s.hudSpeed || '') + ' / ' + (s.hudAlt || '') + '"';
  }

  function runInBrowser() {
    if (window.__finsTabletDiag) return;
    window.__finsTabletDiag = true;
    const read = (fn) => { try { const v = fn(); return v === undefined ? null : v; } catch (_) { return null; } };
    const text = (id) => read(() => document.getElementById(id).textContent);

    function sample(i) {
      const g = window.geofs || {};
      const inst = read(() => g.aircraft.instance) || {};
      const vals = read(() => g.animation.values) || {};
      return {
        i, atMs: Math.round(performance.now()),
        kias: num(vals.kias),
        llaAltM: num(read(() => +inst.llaLocation[2])),
        haglMeters: num(read(() => inst.haglMeters)),
        groundSpeed: num(read(() => inst.groundSpeed)),
        trueAirSpeed: num(read(() => inst.trueAirSpeed)),
        rigidBodySpeedMs: vecLen(read(() => inst.rigidBody.v_linearVelocity)),
        hudSpeed: text('fr-hud-speed'), hudAlt: text('fr-hud-alt'),
        animationValues: pickNumeric(vals, /speed|kias|kts|kt$|knot|tas|alt|agl|hagl|ground|climb|vs$/i, 40),
        instance: pickNumeric(inst, /speed|kias|tas|alt|agl|hagl|ground/i, 20),
        paused: read(() => (typeof g.isPaused === 'function' ? !!g.isPaused() : null)),
        aircraftId: read(() => String(inst.id)),
      };
    }

    const panel = document.createElement('div');
    panel.id = 'fins-tablet-diag';
    panel.style.cssText = 'position:fixed;left:50%;top:60px;transform:translateX(-50%);z-index:2147483000;'
      + 'width:min(720px,calc(100vw - 32px));max-height:60vh;overflow:auto;background:rgba(10,14,24,.92);color:#e8eef8;'
      + 'font:12px/1.45 ui-monospace,Consolas,monospace;padding:10px 12px;border-radius:8px;border:1px solid #3a4a66';
    const head = document.createElement('div');
    head.style.cssText = 'display:flex;gap:8px;align-items:center;margin-bottom:6px;font-weight:bold';
    const title = document.createElement('span');
    title.textContent = 'FINSONLY tablet diag: sampling 0/' + SAMPLE_COUNT;
    title.style.flex = '1';
    const copy = document.createElement('button');
    copy.textContent = 'Copy JSON'; copy.disabled = true;
    const close = document.createElement('button');
    close.textContent = '×';
    for (const b of [copy, close]) b.style.cssText = 'min-width:44px;min-height:44px;font:inherit';
    head.append(title, copy, close);
    const pre = document.createElement('pre');
    pre.style.cssText = 'margin:0;white-space:pre-wrap';
    panel.append(head, pre);
    for (const t of ['pointerdown', 'touchstart', 'mousedown', 'wheel']) panel.addEventListener(t, (e) => e.stopPropagation());
    document.body.append(panel);

    const samples = [];
    const report = () => ({
      tool: 'tablet_diag', userAgent: navigator.userAgent,
      viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio },
      raceVersion: read(() => window.__finsRace.version), samples,
    });
    const json = () => JSON.stringify(report(), null, 1);
    let timer = null;
    close.onclick = () => { clearInterval(timer); panel.remove(); window.__finsTabletDiag = false; };
    copy.onclick = () => {
      const t = json();
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(t).then(() => { copy.textContent = 'Copied'; }, () => { pre.textContent = t; });
      } else pre.textContent = t;
    };
    timer = setInterval(() => {
      const s = sample(samples.length + 1);
      samples.push(s);
      title.textContent = 'FINSONLY tablet diag: sampling ' + samples.length + '/' + SAMPLE_COUNT;
      pre.textContent = samples.map(summaryLine).join('\n');
      if (samples.length >= SAMPLE_COUNT) {
        clearInterval(timer);
        title.textContent = 'FINSONLY tablet diag: done (' + SAMPLE_COUNT + ' samples) — Copy JSON and paste it back';
        copy.disabled = false;
        console.log('[finsTabletDiag]', json());
      }
    }, SAMPLE_MS);
  }

  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    runInBrowser();
  } else if (typeof module !== 'undefined' && module.exports) {
    module.exports = { num, pickNumeric, vecLen, summaryLine };
  }
})();
