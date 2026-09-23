/*
 * FINSONLY Racing — touchdown recorder (bookmarklet-loadable, read-only).
 *
 * Paste a RECORDER bookmarklet line (see race/bookmarklet.txt) and click it on geo-fs.com
 * after the plane is loaded. It samples a fixed set of GeoFS fields at 20 Hz into the exact
 * sample shape race/touchdown.js's detector takes — see that file's top-of-file comment
 * ("Sample shape (one per tick): { t_ms, lat, lon, alt_m, agl_m, vs_mps, ias_mps, heading_deg,
 * bank_deg, pitch_deg, on_ground_bool }") — and never redefines that shape here.
 *
 * FIELD_MAP below is where each field's GeoFS read lives. Every entry ships as a TODO-PROBE
 * placeholder that returns null (lat/lon/alt_m etc.) or false (on_ground_bool) and touches no
 * GeoFS global — so this file is safe to load, and safe to `require()` under plain Node for
 * tests, before anyone fills it in. Fill each one in from a fresh race/tools/probe.js report (or
 * its LANDING_SAMPLER / touchdownInputs candidates) run against a real landing on geo-fs.com —
 * never guess a path here and ship it unverified (see CLAUDE.md). The comment on each entry notes
 * the candidate probe.js has already turned up, as a starting point only.
 *
 * Alt+T starts a capture; Alt+T again stops it early. It stops itself at MAX_DURATION_MS (5
 * minutes) regardless. The Copy JSON button copies the most recent capture (finished, or still
 * running) as JSON to the clipboard, in the shape race/tools/replay_landing.mjs reads: { samples,
 * plus recording metadata }.
 *
 * Read-only: every FIELD_MAP getter is a plain property read, wrapped so a throw or a bad type
 * never reaches the sample or the capture loop. No GeoFS/Cesium setter is ever called.
 */
(() => {
  'use strict';

  const SAMPLE_HZ = 20;
  const SAMPLE_MS = 1000 / SAMPLE_HZ;
  const MAX_DURATION_MS = 5 * 60 * 1000;

  // ---------------------------------------------------------------- pure helpers (Node-testable)
  // No browser/GeoFS reference in this block — required so `require('./recorder.js')` under plain
  // Node (the unit test) can exercise these without touching window/document/geofs.
  const MPS_PER_KT = 0.514444;
  const FPM_PER_MPS = 196.850393701;

  function knotsToMps(kt) {
    return typeof kt === 'number' && isFinite(kt) ? kt * MPS_PER_KT : null;
  }
  function fpmToMps(fpm) {
    return typeof fpm === 'number' && isFinite(fpm) ? fpm / FPM_PER_MPS : null;
  }

  // FIELD_MAP: one getter per field in touchdown.js's sample shape (t_ms is the recorder's own
  // elapsed-ms clock, not a GeoFS read — see sampleTick() below, not listed here). Every getter is
  // a TODO-PROBE placeholder. Replace only the getter body — key names and the read()/buildSample()
  // plumbing around them are the detector's contract and stay as they are.
  const FIELD_MAP = {
    lat: () => null, // TODO-PROBE: e.g. geofs.aircraft.instance.llaLocation[0]
    lon: () => null, // TODO-PROBE: e.g. geofs.aircraft.instance.llaLocation[1]
    alt_m: () => null, // TODO-PROBE: e.g. geofs.aircraft.instance.llaLocation[2]
    // TODO-PROBE: e.g. llaLocation[2] minus geofs.api.viewer.scene.globe.getHeight(cartographic) —
    // see probe.js's "agl" candidates. Airborne-only: it settles to a small nonzero offset once
    // grounded rather than 0, so touchdown.js only reads this pre-contact.
    agl_m: () => null,
    // TODO-PROBE: e.g. fpmToMps(geofs.animation.values.climbrate) — probe.js's "verticalSpeed"
    // candidates note climbrate/verticalSpeed read the same field, ft/min, negative = descending.
    // Convert with fpmToMps() above. Noisy for 1-2 samples right at touchdown; touchdown.js already
    // reads vs_at_contact from the last pre-ground sample, not the contact sample, to cover that.
    vs_mps: () => null,
    // TODO-PROBE: e.g. knotsToMps(geofs.animation.values.kias) — convert with knotsToMps() above.
    ias_mps: () => null,
    heading_deg: () => null, // TODO-PROBE: e.g. geofs.animation.values.heading360
    bank_deg: () => null, // TODO-PROBE: e.g. geofs.animation.values.roll
    pitch_deg: () => null, // TODO-PROBE: e.g. geofs.animation.values.pitch
    // TODO-PROBE: e.g. geofs.aircraft.instance.groundContact — probe.js's "groundContact"
    // candidates list it first; a prior live PDX capture found it flips false->true cleanly right
    // at the touchdown frame. Fall back candidates if that name is wrong: isOnGround, onGround,
    // weightOnWheels.
    on_ground_bool: () => null,
  };

  // Reads a single FIELD_MAP entry, never throwing and never passing through a non-finite number
  // or a non-boolean where the schema wants one. Exported so tests can pass a fake map instead of
  // the real (TODO, GeoFS-touching-once-filled-in) FIELD_MAP above.
  function readField(map, key, wantBoolean) {
    try {
      const v = map[key]();
      if (wantBoolean) return !!v;
      return typeof v === 'number' && isFinite(v) ? v : null;
    } catch (_) {
      return wantBoolean ? false : null;
    }
  }

  // Builds one sample in touchdown.js's exact shape. `map` defaults to the real FIELD_MAP but is
  // injectable so this is testable under plain Node without a `geofs` global.
  function buildSample(tMs, map) {
    const m = map || FIELD_MAP;
    return {
      t_ms: tMs,
      lat: readField(m, 'lat', false),
      lon: readField(m, 'lon', false),
      alt_m: readField(m, 'alt_m', false),
      agl_m: readField(m, 'agl_m', false),
      vs_mps: readField(m, 'vs_mps', false),
      ias_mps: readField(m, 'ias_mps', false),
      heading_deg: readField(m, 'heading_deg', false),
      bank_deg: readField(m, 'bank_deg', false),
      pitch_deg: readField(m, 'pitch_deg', false),
      on_ground_bool: readField(m, 'on_ground_bool', true),
    };
  }

  // Runs the actual recorder. Only called in a real browser (see the bottom of this file) — under
  // plain Node (the unit test) this whole function is defined but never invoked, same split as
  // race/tools/probe.js and race/tools/terrain_probe.js.
  function runInBrowser() {
    if (window.__finsTouchdownRecorder) return; // a second injection reuses the existing instance
    const state = {
      running: false,
      samples: [],
      startedAt: 0,
      timer: null,
      hardStop: null,
      lastRecording: null,
    };
    window.__finsTouchdownRecorder = state;

    const ui = buildUi();

    function tick() {
      const tMs = Math.round(safeNow() - state.startedAt);
      state.samples.push(buildSample(tMs, FIELD_MAP));
      ui.setStatus(`Recording… ${state.samples.length} samples (${(tMs / 1000).toFixed(1)}s)`);
    }

    function finalize() {
      return {
        generatedAt: new Date().toISOString(),
        url: location.href,
        sampleHz: SAMPLE_HZ,
        sampleIntervalMs: SAMPLE_MS,
        durationMsRequested: MAX_DURATION_MS,
        durationMsActual: state.samples.length ? state.samples[state.samples.length - 1].t_ms : 0,
        sampleCount: state.samples.length,
        samples: state.samples,
      };
    }

    function stop() {
      if (!state.running) return;
      state.running = false;
      clearInterval(state.timer);
      clearTimeout(state.hardStop);
      state.timer = null;
      state.hardStop = null;
      state.lastRecording = finalize();
      ui.setStatus(`Stopped — ${state.lastRecording.sampleCount} samples (${(state.lastRecording.durationMsActual / 1000).toFixed(1)}s). Alt+T to record again.`);
      console.log('[finsTouchdownRecorder] stopped, ' + state.lastRecording.sampleCount + ' samples');
    }

    function start() {
      state.samples = [];
      state.startedAt = safeNow();
      state.running = true;
      tick();
      state.timer = setInterval(tick, SAMPLE_MS);
      state.hardStop = setTimeout(stop, MAX_DURATION_MS);
      ui.setStatus('Recording… 1 sample (0.0s)');
      console.log('[finsTouchdownRecorder] started — logging at ' + SAMPLE_HZ + ' Hz for up to ' + (MAX_DURATION_MS / 1000) + ' s. Alt+T to stop early.');
    }

    window.addEventListener('keydown', (e) => {
      if (!e.altKey || (e.key !== 't' && e.key !== 'T')) return;
      if (state.running) stop(); else start();
    });

    ui.onCopy(() => {
      const recording = state.running ? finalize() : state.lastRecording;
      if (!recording) {
        alert('FINSONLY Touchdown Recorder: nothing recorded yet. Alt+T to start.');
        return;
      }
      copyJson(recording);
    });
  }

  function safeNow() {
    try { return performance.now(); } catch (_) { return Date.now(); }
  }

  function copyJson(obj) {
    let text;
    try {
      text = JSON.stringify(obj, null, 1);
    } catch (e) {
      alert('FINSONLY Touchdown Recorder: failed to serialize the recording: ' + e.message);
      return;
    }
    console.log('[finsTouchdownRecorder] ' + obj.sampleCount + ' samples, ' + text.length + ' bytes');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text)
        .then(() => alert('FINSONLY Touchdown Recorder: ' + obj.sampleCount + ' samples copied to clipboard (' + text.length + ' bytes). Paste into a .json file for replay_landing.mjs.'))
        .catch(() => alert('FINSONLY Touchdown Recorder: clipboard write failed. The recording is in the console (F12) — copy it from there.'));
    } else {
      alert('FINSONLY Touchdown Recorder: clipboard API unavailable. The recording is in the console (F12) — copy it from there.');
    }
  }

  // Minimal floating panel: a status line and a Copy JSON button. No other controls — start/stop
  // is Alt+T only (see the top-of-file comment).
  function buildUi() {
    const box = document.createElement('div');
    box.id = 'fins-touchdown-recorder';
    box.style.cssText = 'position:fixed;top:8px;right:8px;z-index:999999;background:rgba(20,20,20,.85);' +
      'color:#eee;font:12px/1.4 monospace;padding:8px 10px;border-radius:6px;min-width:220px;box-shadow:0 2px 8px rgba(0,0,0,.4);';

    const title = document.createElement('div');
    title.textContent = 'FINSONLY Touchdown Recorder';
    title.style.cssText = 'font-weight:bold;margin-bottom:4px;';
    box.appendChild(title);

    const status = document.createElement('div');
    status.textContent = 'Idle — Alt+T to start recording (5 min cap).';
    status.style.cssText = 'margin-bottom:6px;white-space:nowrap;';
    box.appendChild(status);

    const copyBtn = document.createElement('button');
    copyBtn.textContent = 'Copy JSON';
    copyBtn.style.cssText = 'font:inherit;padding:3px 8px;cursor:pointer;';
    box.appendChild(copyBtn);

    document.body.appendChild(box);

    return {
      setStatus(text) { status.textContent = text; },
      onCopy(fn) { copyBtn.addEventListener('click', fn); },
    };
  }

  // Run the real thing only in a browser with a DOM to attach the panel to; under Node (the unit
  // test) this file just exports its pure functions and touches nothing browser-specific — same
  // split as race/tools/probe.js and race/tools/terrain_probe.js.
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    runInBrowser();
  } else if (typeof module !== 'undefined' && module.exports) {
    module.exports = { MPS_PER_KT, FPM_PER_MPS, knotsToMps, fpmToMps, readField, buildSample, FIELD_MAP };
  }
})();
