/*
 * FINSONLY Racing — GeoFS/Cesium internals probe (one-shot, read-only).
 *
 * Paste the PROBE line from race/bookmarklet.txt into a bookmark and click it on
 * geo-fs.com after the plane is loaded. It never modifies anything — it only reads
 * properties, depth-limited and cycle-safe — and copies a JSON report to the
 * clipboard (and console.logs it as a fallback if the clipboard is blocked).
 *
 * Paste that JSON back so the `G` adapter and the model-swap code in race.js can be
 * corrected against the real internals instead of the TODO-PROBE guesses.
 */
(() => {
  'use strict';
  const MAX_BYTES = 200 * 1000;
  const MAX_DEPTH = 3;
  const MAX_ARRAY = 8;
  const MAX_KEYS = 60;

  function safe(fn, fallback) { try { return fn(); } catch (e) { return fallback; } }

  // Depth-limited, cycle-safe summarizer. Never dumps huge arrays/objects,
  // never touches DOM nodes deeply, never calls functions (just names them).
  function summarize(v, depth, seen) {
    if (v === null) return null;
    if (v === undefined) return undefined;
    const t = typeof v;
    if (t === 'number' || t === 'boolean') return v;
    if (t === 'string') return v.length > 200 ? v.slice(0, 200) + '…' : v;
    if (t === 'function') return '[function ' + (v.name || 'anonymous') + ']';
    if (t !== 'object') return String(v);

    if (seen.has(v)) return '[circular]';
    if (v instanceof Node) return '[DOM ' + v.nodeName + ']';
    if (v instanceof Window) return '[Window]';

    const ctorName = safe(() => v.constructor && v.constructor.name, '') || 'Object';

    if (depth >= MAX_DEPTH) {
      if (Array.isArray(v)) return '[Array(' + v.length + ')]';
      return '[' + ctorName + ']';
    }

    seen.add(v);
    try {
      if (Array.isArray(v)) {
        const out = v.slice(0, MAX_ARRAY).map((x) => summarize(x, depth + 1, seen));
        if (v.length > MAX_ARRAY) out.push('…(' + (v.length - MAX_ARRAY) + ' more)');
        return out;
      }
      // Typed arrays / array-likes with a numeric length
      if (typeof v.length === 'number' && v.length >= 0 && v.length < 1e6 && ctorName !== 'Object') {
        const out = [];
        for (let i = 0; i < Math.min(v.length, MAX_ARRAY); i++) out.push(summarize(v[i], depth + 1, seen));
        return { __type: ctorName, length: v.length, sample: out };
      }
      let keys;
      try { keys = Object.keys(v); } catch (_) { keys = []; }
      const out = { __type: ctorName !== 'Object' ? ctorName : undefined };
      let n = 0;
      for (const k of keys) {
        if (n++ >= MAX_KEYS) { out['…'] = 'truncated (' + (keys.length - MAX_KEYS) + ' more keys)'; break; }
        out[k] = summarize(safe(() => v[k], '[getter threw]'), depth + 1, seen);
      }
      return out;
    } finally {
      seen.delete(v);
    }
  }

  function keysOf(obj) { return safe(() => Object.keys(obj), []); }

  function findShowables(obj, depth, seen, path, out) {
    if (!obj || typeof obj !== 'object' || depth > 3 || seen.has(obj)) return;
    seen.add(obj);
    if (typeof obj.show === 'boolean') {
      out.push({ path, ctor: safe(() => obj.constructor && obj.constructor.name, '') || '?' });
    }
    if (out.length >= 20) return;
    for (const k of keysOf(obj)) {
      if (out.length >= 20) return;
      const val = safe(() => obj[k], undefined);
      if (val && typeof val === 'object' && !(val instanceof Node)) {
        findShowables(val, depth + 1, seen, path + '.' + k, out);
      }
    }
  }

  function buildReport() {
    const report = { generatedAt: new Date().toISOString(), url: location.href };

    // ---- Cesium
    report.cesium = {
      hasCesium: typeof window.Cesium !== 'undefined',
      VERSION: safe(() => Cesium.VERSION, null),
      hasModel: safe(() => typeof Cesium.Model !== 'undefined', false),
      fromGltfAsync: safe(() => typeof Cesium.Model.fromGltfAsync, 'undefined'),
      fromGltf: safe(() => typeof Cesium.Model.fromGltf, 'undefined'),
      hasTransforms: safe(() => typeof Cesium.Transforms !== 'undefined', false),
      headingPitchRollToFixedFrame: safe(() => typeof Cesium.Transforms.headingPitchRollToFixedFrame, 'undefined'),
      hasHeadingPitchRoll: safe(() => typeof Cesium.HeadingPitchRoll, 'undefined'),
    };

    // ---- the G adapter's exact assumptions (typeof only, no calls)
    report.gAdapter = {
      'geofs.aircraft.instance.llaLocation': safe(() => typeof geofs.aircraft.instance.llaLocation, 'undefined'),
      'geofs.api.viewer': safe(() => typeof geofs.api.viewer, 'undefined'),
      'geofs.isPaused': safe(() => typeof geofs.isPaused, 'undefined'),
      'geofs.animation.values.heading360': safe(() => typeof geofs.animation.values.heading360, 'undefined'),
      'geofs.animation.values.kias': safe(() => typeof geofs.animation.values.kias, 'undefined'),
      'geofs.animation.values.pitch': safe(() => typeof geofs.animation.values.pitch, 'undefined'),
      'geofs.animation.values.roll': safe(() => typeof geofs.animation.values.roll, 'undefined'),
      'geofs.animation.values.bank': safe(() => typeof geofs.animation.values.bank, 'undefined'),
      'geofs.aircraft.instance.id': safe(() => typeof geofs.aircraft.instance.id, 'undefined'),
      'geofs.userRecord.callsign': safe(() => typeof geofs.userRecord.callsign, 'undefined'),
    };

    // ---- geofs.aircraft.instance detail
    report.aircraftInstance = safe(() => {
      const inst = geofs.aircraft.instance;
      const out = {
        currentAircraftId: safe(() => geofs.aircraft.instance.id, null),
        ownKeys: keysOf(inst).slice(0, 80),
      };
      // htr / orientation-looking fields, sampled
      const htrCandidates = ['htr', 'orientation', 'quaternion', 'heading', 'pitch', 'roll', 'bank', 'attitude'];
      out.orientationFields = {};
      for (const k of htrCandidates) {
        if (k in inst) out.orientationFields[k] = summarize(inst[k], 0, new Set());
      }
      // definition.parts summary
      out.definitionParts = safe(() => {
        const parts = inst.definition && inst.definition.parts;
        if (!parts) return null;
        if (Array.isArray(parts)) return { length: parts.length, sample: parts.slice(0, 5).map((p) => summarize(p, 1, new Set())) };
        return { keys: keysOf(parts).slice(0, 40) };
      }, null);
      // anything holding Cesium primitives/models
      const primCandidates = ['object3d', 'model', '_model', 'primitives', 'primitive', 'entity', 'mesh'];
      out.primitiveHolders = {};
      for (const k of primCandidates) {
        if (k in inst) {
          out.primitiveHolders[k] = {
            ctor: safe(() => inst[k] && inst[k].constructor && inst[k].constructor.name, null),
            summary: summarize(inst[k], 1, new Set()),
          };
        }
      }
      const found = [];
      findShowables(inst, 0, new Set(), 'geofs.aircraft.instance', found);
      out.showableNodesFound = found;
      return out;
    }, '[error reading geofs.aircraft.instance]');

    // ---- multiplayer
    report.multiplayer = safe(() => {
      const containers = ['multiplayer', 'geofs.multiplayer'].map((p) => ({ path: p, obj: safe(() => p.split('.').reduce((o, k) => o[k], window), undefined) }));
      const out = { globalsChecked: containers.map((c) => ({ path: c.path, exists: c.obj !== undefined, keys: c.obj ? keysOf(c.obj).slice(0, 40) : [] })) };
      const mp = safe(() => geofs.multiplayer, undefined) || safe(() => window.multiplayer, undefined);
      if (!mp) { out.note = 'no geofs.multiplayer or window.multiplayer found'; return out; }
      out.mpKeys = keysOf(mp).slice(0, 60);
      const listCandidates = ['otherPlayers', 'users', 'slots', 'instances', 'planes', 'players'];
      out.listCandidates = {};
      let sampleUser = null;
      for (const k of listCandidates) {
        const v = safe(() => mp[k], undefined);
        if (v === undefined) continue;
        const isArr = Array.isArray(v);
        const list = isArr ? v : (v && typeof v === 'object' ? Object.values(v) : []);
        out.listCandidates[k] = { type: isArr ? 'array' : typeof v, length: list.length };
        if (!sampleUser && list.length) sampleUser = list[0];
      }
      if (sampleUser) {
        out.sampleUser = {
          keys: keysOf(sampleUser).slice(0, 60),
          summary: summarize(sampleUser, 0, new Set()),
        };
        const found = [];
        findShowables(sampleUser, 0, new Set(), 'sampleUser', found);
        out.sampleUserShowableNodesFound = found;
      } else {
        out.note = (out.note || '') + ' no non-empty user list found among ' + listCandidates.join(',');
      }
      return out;
    }, '[error reading multiplayer]');

    // ---- camera (used to guess "hide in cockpit view")
    report.camera = safe(() => ({
      keys: keysOf(geofs.camera).slice(0, 40),
      mode: safe(() => geofs.camera.mode, undefined),
      type: safe(() => geofs.camera.type, undefined),
      view: safe(() => geofs.camera.view, undefined),
      summary: summarize(geofs.camera, 1, new Set()),
    }), '[error reading geofs.camera]');

    // ---- scene primitives
    report.scene = safe(() => {
      const prims = geofs.api.viewer.scene.primitives;
      const n = prims.length;
      const ctorCounts = {};
      for (let i = 0; i < n; i++) {
        const p = safe(() => prims.get(i), null);
        const name = safe(() => p && p.constructor && p.constructor.name, 'unknown') || 'unknown';
        ctorCounts[name] = (ctorCounts[name] || 0) + 1;
      }
      return { length: n, ctorCounts };
    }, '[error reading viewer.scene.primitives]');

    return report;
  }

  function cap(str) {
    if (str.length <= MAX_BYTES) return str;
    return str.slice(0, MAX_BYTES) + '\n…(truncated, ' + str.length + ' bytes total)';
  }

  let report, text;
  try {
    report = buildReport();
    text = cap(JSON.stringify(report, null, 1));
  } catch (e) {
    text = JSON.stringify({ error: 'probe failed: ' + e.message });
  }

  console.log('[finsProbe]', text);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text)
      .then(() => alert('FINSONLY probe: report copied to clipboard (' + text.length + ' bytes). Paste it back.'))
      .catch(() => alert('FINSONLY probe: clipboard write failed. The report is in the console (F12) — copy it from there.'));
  } else {
    alert('FINSONLY probe: clipboard API unavailable. The report is in the console (F12) — copy it from there.');
  }
})();
