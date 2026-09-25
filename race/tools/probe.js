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
 *
 * LANDING section (report.landing): a read-only survey of the internals a landing-challenge
 * scorer would need — ground contact, vertical speed, AGL, gear state, crash/damage, groundspeed
 * and airspeed. It only scans key names and typeof/value-reads it, plus one synchronous
 * globe.getHeight() terrain query (a read, like terrain_probe.js's sampleTerrainMostDetailed) and
 * a 250 ms two-sample d(alt)/dt cross-check against whatever vertical-speed field it finds. It
 * never calls a gear-setter or any other mutating method — those are reported by typeof/arity
 * only, same as the existing "reposition"/"controls" sections below.
 *
 * LANDING_SAMPLER: press Alt+L after this loads to start a 20 Hz capture of the same fields for
 * up to 30 s (press Alt+L again to stop early). It answers what the one-shot report can't — how
 * these fields actually move through a touchdown and rollout — by logging the same read-only
 * snapshot every 50 ms and then emitting one JSON report the same way the static probe does. Fly
 * one normal landing with it running and paste the JSON back.
 *
 * TOUCHDOWN INPUTS section (report.touchdownInputs): a read-only field-discovery pass for the
 * touchdown detector specifically — where does GeoFS expose AGL/ground elevation, vertical speed,
 * an on-ground/weight-on-wheels/groundContact flag, indicated airspeed, and (already known)
 * heading/pitch/roll (`htr`) and lat/lon/alt (`llaLocation`)? Unlike report.landing's single
 * snapshot, every candidate here is read 5 times, 200 ms apart (typeof/value reads only, plus the
 * same one-off globe.getHeight() terrain query the LANDING section uses), so units and liveness
 * are readable straight out of the JSON without needing LANDING_SAMPLER or a real flight. This
 * delays the probe's final output by ~800 ms (5 samples over 4 gaps) — expected, not a hang. If no
 * boolean ground-contact candidate turns up, it logs derivation candidates instead (gear
 * compression fields, and the AGL-near-zero estimate) rather than guessing at a flag that isn't
 * there. Nothing here calls a setter or writes state — same guarantee as the rest of this file.
 *
 * UI LAYOUT section (report.uiLayout, tablet-mode): where GeoFS's own on-screen UI sits, so the
 * race HUD can be kept off it and CONFIG.HIDE_GEOFS_INSTRUMENTS can target the right node. It
 * reports the viewport (inner/visual size, DPR, coarse pointer, and whether the document is wider
 * than the window), then every visible fixed/absolute element outside FINSONLY's own #fr-* tree
 * plus anything whose id/class names an instrument, bar, button column, stick or throttle: its
 * selector, rect, display/visibility/z-index and a role guess. `geofs.instruments` is reported by
 * key and typeof only; nothing is called, hidden or restyled.
 */
(() => {
  'use strict';
  const MAX_BYTES = 200 * 1000;
  const MAX_DEPTH = 3;
  const MAX_ARRAY = 8;
  const MAX_KEYS = 60;
  const LANDING_SAMPLE_HZ = 20;
  const LANDING_SAMPLE_MS = 1000 / LANDING_SAMPLE_HZ;
  const LANDING_SAMPLE_DURATION_MS = 30 * 1000;
  const TOUCHDOWN_SAMPLE_COUNT = 5;
  const TOUCHDOWN_SAMPLE_INTERVAL_MS = 200;

  // ---------------------------------------------------------------- pure helpers (Node-testable)
  // No browser/GeoFS/Cesium reference in this block — required so `require('./probe.js')` under
  // plain Node (the unit test) can exercise these without touching window/document/geofs.
  const FPM_PER_MPS = 196.850393701; // 1 m/s = 196.850393701 ft/min — GeoFS commonly reports climbrate in ft/min.

  function mpsToFpm(mps) {
    return typeof mps === 'number' && isFinite(mps) ? mps * FPM_PER_MPS : null;
  }
  function fpmToMps(fpm) {
    return typeof fpm === 'number' && isFinite(fpm) ? fpm / FPM_PER_MPS : null;
  }
  // d(alt)/dt over a two-sample window, in m/s. Used to cross-check whatever field looks like a
  // vertical-speed/climbrate reading against GeoFS's own llaLocation[2].
  function verticalSpeedFromAltitudes(alt0M, alt1M, dtMs) {
    if (typeof alt0M !== 'number' || typeof alt1M !== 'number' || !isFinite(alt0M) || !isFinite(alt1M)) return null;
    if (typeof dtMs !== 'number' || !isFinite(dtMs) || dtMs <= 0) return null;
    return (alt1M - alt0M) / (dtMs / 1000);
  }
  // A rollout "stopped" signal from raw groundspeed, since no dedicated flag is confirmed to
  // exist yet (see report.landing.groundspeedAndStopped). thresholdMps defaults to 0.5 m/s (~1 kt).
  function isStopped(groundSpeedMps, thresholdMps) {
    const th = typeof thresholdMps === 'number' && isFinite(thresholdMps) ? thresholdMps : 0.5;
    if (typeof groundSpeedMps !== 'number' || !isFinite(groundSpeedMps)) return null;
    return Math.abs(groundSpeedMps) <= th;
  }

  function safe(fn, fallback) { try { return fn(); } catch (e) { return fallback; } }

  // ---- UI LAYOUT helpers. Plain-object inputs (no DOM), so Node can test them.
  // A short CSS selector from what an element says about itself: #id, else tag.class.class.
  function uiSelector(tag, id, className) {
    if (id) return '#' + id;
    const cls = String(className || '').trim().split(/\s+/).filter(Boolean).slice(0, 3);
    return String(tag || '').toLowerCase() + (cls.length ? '.' + cls.join('.') : '');
  }
  // Which part of GeoFS's UI a node probably is, from its id/class text. A guess for a human to
  // confirm, never used to act on anything.
  const UI_ROLES = [
    ['instruments', /instrument|gauge|panel-inst|attitude|altimeter|compass|hsi/i],
    ['touchStick', /joystick|stick|touch-?control|virtual-?pad/i],
    ['throttle', /throttle/i],
    ['topBar', /top-?bar|header|menu-?bar|autopilot/i],
    ['bottomBar', /bottom|footer|toolbar|button-?bar|nav-?bar/i],
    ['sideButtons', /radio|brake|gear|flap|option|side-?bar|mobile-?controls/i],
  ];
  function uiRoleGuess(text) {
    for (const [role, re] of UI_ROLES) if (re.test(String(text || ''))) return role;
    return null;
  }
  // rect: {left, top, width, height}; style: {display, visibility, position, zIndex, opacity}.
  function uiRectInfo(rect, style, vw, vh) {
    const r = { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) };
    const shown = style.display !== 'none' && style.visibility !== 'hidden' && +style.opacity !== 0 && r.w > 0 && r.h > 0;
    return {
      ...r, position: style.position, zIndex: style.zIndex, display: style.display, visibility: style.visibility,
      shown, pastRight: r.x + r.w > vw, pastBottom: r.y + r.h > vh,
    };
  }

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

  // Shared by the static report's "landing" section and LANDING_SAMPLER — a fixed list of
  // read-only candidate reads, so a human reading either output sees the same field names. Each
  // entry is [outputKey, reader]; a reader that throws or returns undefined is recorded as such,
  // never guessed at.
  function landingSnapshot() {
    const inst = safe(() => geofs.aircraft.instance, undefined);
    const av = safe(() => geofs.animation.values, undefined);
    function firstDefined(fns) {
      for (const fn of fns) {
        const v = safe(fn, undefined);
        if (v !== undefined) return v;
      }
      return undefined;
    }
    return {
      lat: safe(() => inst.llaLocation[0], null),
      lon: safe(() => inst.llaLocation[1], null),
      altM: safe(() => inst.llaLocation[2], null),
      // Confirmed present (2026-09-22 PDX probe): GeoFS's own previous-frame position. Logged
      // every sample so its cadence against llaLocation can be read back from real data.
      lastLlaLocation: safe(() => (Array.isArray(inst.lastLlaLocation) ? inst.lastLlaLocation.slice(0, 3) : inst.lastLlaLocation), null),
      groundSpeed: safe(() => inst.groundSpeed, null),
      trueAirSpeed: safe(() => inst.trueAirSpeed, null),
      kias: safe(() => av.kias, null),
      climbrate: safe(() => av.climbrate, undefined),
      verticalSpeed: safe(() => av.verticalSpeed, undefined),
      vsi: safe(() => av.vsi, undefined),
      gearPosition: firstDefined([() => av.gearPosition, () => av.gear, () => inst.gearPosition, () => inst.gear]),
      // Confirmed present (2026-09-22 PDX probe): geofs.aircraft.instance.groundContact and
      // .relativeAltitude are real own keys, not guesses — listed first in each so they win.
      groundContact: firstDefined([
        () => inst.groundContact, () => inst.isOnGround, () => inst.onGround, () => inst.weightOnWheels,
        () => av.groundContact, () => av.onGround, () => av.isOnGround,
      ]),
      relativeAltitude: safe(() => inst.relativeAltitude, null),
      crashed: firstDefined([() => inst.crashed, () => geofs.crashed, () => inst.destroyed, () => av.crashed, () => av.damage]),
      crashNotified: safe(() => inst.crashNotified, null),
      aglEstimate: safe(() => {
        const carto = Cesium.Cartographic.fromDegrees(inst.llaLocation[1], inst.llaLocation[0]);
        const h = geofs.api.viewer.scene.globe.getHeight(carto);
        return typeof h === 'number' ? inst.llaLocation[2] - h : null;
      }, null),
    };
  }

  function buildLandingSection() {
    return safe(() => {
      const inst = geofs.aircraft.instance;
      const av = safe(() => geofs.animation.values, undefined);
      const geofsObj = geofs;

      // A 2026-09-22 PDX probe run (paste-back, F16) confirmed geofs.aircraft.instance carries
      // groundContact, crashed/crashNotified, relativeAltitude, waterContact, arrestingCableContact,
      // wheels and suspensions (plural) as real own keys — these regexes were widened to catch them
      // by name instead of by luck (relativeAltitude in particular is a strong AGL candidate no
      // earlier guess here matched). collResult is present too and unexplained; caught via
      // "collision"/"collresult" on the chance it holds per-wheel/gear contact detail.
      const GROUND_CONTACT_RE = /contact|onground|weighton|touchdown|grounded|wheelload|squat|isground|collresult|collision/i;
      const VSPEED_RE = /climbrate|verticalspeed|vspeed|sinkrate|vsi/i;
      const AGL_RE = /agl|groundelevation|terrainheight|altitudeabove|heightabove|groundlevel|relativealt/i;
      const GEAR_RE = /gear/i;
      const CRASH_RE = /crash|damage|destroy|wreck|broken|health/i;
      const GROUNDSPEED_RE = /groundspeed/i;
      const STOPPED_RE = /stopped|parked|stationary/i;
      const AIRSPEED_RE = /kias|^ias$|^tas$|airspeed/i;
      const NESTED_CONTAINER_NAMES = ['wheels', 'gear', 'landingGear', 'undercarriage', 'suspension', 'suspensions', 'gearSystem'];

      function scanObjectKeys(obj, re, capN) {
        if (!obj || typeof obj !== 'object') return [];
        const keys = keysOf(obj).filter((k) => re.test(k));
        return keys.slice(0, capN || 20).map((k) => ({
          path: k,
          type: safe(() => typeof obj[k], 'unknown'),
          value: safe(() => summarize(obj[k], 0, new Set()), '[unreadable]'),
        }));
      }

      // Same as scanObjectKeys, but also descends one level into common gear/wheel/suspension
      // container names (and, for an array of per-wheel/per-gear objects, the first few entries)
      // so a field like "wheels[0].contact" is found even though it isn't a top-level key.
      function scanNested(root, rootLabel, re, capN) {
        const out = [];
        if (!root || typeof root !== 'object') return out;
        out.push(...scanObjectKeys(root, re, capN).map((c) => ({ ...c, path: rootLabel + '.' + c.path })));
        for (const name of NESTED_CONTAINER_NAMES) {
          const sub = safe(() => root[name], undefined);
          if (!sub || typeof sub !== 'object') continue;
          if (typeof sub.length === 'number') {
            const n = Math.min(sub.length, 4);
            for (let i = 0; i < n; i++) {
              out.push(...scanObjectKeys(sub[i], re, capN).map((c) => ({ ...c, path: rootLabel + '.' + name + '[' + i + '].' + c.path })));
            }
          } else {
            out.push(...scanObjectKeys(sub, re, capN).map((c) => ({ ...c, path: rootLabel + '.' + name + '.' + c.path })));
          }
        }
        return out;
      }

      // typeof + arity only — never calls the method. Used for the gear-setter search: race/CLAUDE.md
      // forbids writes to aircraft controls from a probe, and a gear setter is exactly that.
      function methodCandidates(obj, rootLabel, re, capN) {
        if (!obj) return [];
        const keys = keysOf(obj).filter((k) => re.test(k) && safe(() => typeof obj[k], '') === 'function');
        return keys.slice(0, capN || 20).map((k) => ({ path: rootLabel + '.' + k, type: 'function', arity: safe(() => obj[k].length, null) }));
      }

      const groundContact = {
        candidates: [
          ...scanNested(inst, 'geofs.aircraft.instance', GROUND_CONTACT_RE, 20),
          ...scanObjectKeys(av, GROUND_CONTACT_RE, 20).map((c) => ({ ...c, path: 'geofs.animation.values.' + c.path })),
        ],
        // CONFIRMED live (2026-09-22 PDX LANDING_SAMPLER log, F16, hard touchdown ~-14 m/s):
        // geofs.aircraft.instance.groundContact flips false -> true cleanly at the exact touchdown
        // frame and stays true through rollout. It's the field to use for touchdown detection —
        // aglEstimate below never reaches exactly 0 once grounded, so don't gate on that instead.
        note: 'A one-shot report only captures a snapshot value — it cannot show how a field changes on touchdown. Run LANDING_SAMPLER through a real landing for that.',
      };

      const verticalSpeed = {
        fieldCandidates: [
          ...scanObjectKeys(av, VSPEED_RE, 20).map((c) => ({ ...c, path: 'geofs.animation.values.' + c.path })),
          ...scanObjectKeys(inst, VSPEED_RE, 20).map((c) => ({ ...c, path: 'geofs.aircraft.instance.' + c.path })),
        ],
        // geofs.aircraft.instance.lastLlaLocation is confirmed to exist (2026-09-22 PDX probe) and
        // is GeoFS's own previous-frame position — a free per-frame d(alt)/dt, if the frame's dt can
        // be recovered from elsewhere, with no artificial wait. Not used for crossCheck below (that
        // needs a known dt, which a one-off snapshot of this pair alone doesn't carry); reported so
        // LANDING_SAMPLER's log (which timestamps every sample) can be cross-checked against it too.
        lastLlaLocation: safe(() => ({ type: typeof inst.lastLlaLocation, value: summarize(inst.lastLlaLocation, 0, new Set()) }), null),
        // crossCheck is filled in after this function returns — it needs a second sample 250 ms
        // later, which this synchronous scan can't wait for. See the async step at the bottom.
        crossCheck: null,
        // CONFIRMED live (same PDX log): climbrate/verticalSpeed are the SAME field (identical
        // value every sample) and read in ft/min, sign negative = descending — matches d(alt)/dt
        // computed from llaLocation within noise. But the field is a physics-collision artifact
        // for 1-2 samples right at touchdown impact (it swung from -2755 to -1169 to +60 to +15
        // across three consecutive 20 Hz samples spanning the actual touchdown). A scorer must read
        // "touchdown sink rate" from the last sample where groundContact was still false, never
        // from the first grounded sample.
        note: 'crossCheck compares each fieldCandidate against d(alt)/dt computed from llaLocation[2] over a 250 ms window. GeoFS climbrate-style fields are commonly ft/min — see mpsToFpm/fpmToMps.',
      };

      const agl = {
        directFieldCandidates: [
          ...scanObjectKeys(av, AGL_RE, 20).map((c) => ({ ...c, path: 'geofs.animation.values.' + c.path })),
          ...scanObjectKeys(inst, AGL_RE, 20).map((c) => ({ ...c, path: 'geofs.aircraft.instance.' + c.path })),
        ],
        globeGetHeight: safe(() => {
          const viewer = geofs.api.viewer;
          const globe = viewer && viewer.scene && viewer.scene.globe;
          const lla = inst.llaLocation;
          if (!globe || typeof globe.getHeight !== 'function' || !Array.isArray(lla)) return { available: false };
          const carto = Cesium.Cartographic.fromDegrees(lla[1], lla[0]);
          const terrainMsl = globe.getHeight(carto);
          return {
            available: true,
            terrainMslSample: typeof terrainMsl === 'number' ? terrainMsl : null,
            aircraftAltSample: lla[2],
            aglEstimate: typeof terrainMsl === 'number' ? lla[2] - terrainMsl : null,
            note: 'globe.getHeight() is synchronous and read-only, but returns undefined for a tile not yet loaded — that is "not yet known", not zero AGL.',
          };
        }, { available: false, error: 'threw' }),
        sampleTerrainAsync: {
          type: safe(() => typeof Cesium.sampleTerrainMostDetailed, 'undefined'),
          note: 'Confirmed working (see tools/terrain_probe.js) but returns a Promise — not usable synchronously inside a per-frame scorer, unlike globe.getHeight() above.',
        },
        // CONFIRMED live (2026-09-22 PDX LANDING_SAMPLER log, F16): once groundContact is true,
        // this aglEstimate settles to a small NONZERO offset (~1.95 m for this airframe) rather
        // than 0, and drifts slowly (1.96 -> 1.93 m over ~1.3 s of rollout) — llaLocation tracks a
        // fuselage/CG reference point, not the wheel-contact point. Never gate "on the ground" on
        // aglEstimate being near zero; use groundContact for that and treat this purely as an
        // airborne-phase AGL estimate. Also confirmed dead: geofs.aircraft.instance.relativeAltitude
        // stayed exactly 0 for the entire flight (airborne and grounded) — not a usable AGL field.
      };

      const gear = {
        stateFieldCandidates: [
          ...scanObjectKeys(av, GEAR_RE, 20).filter((c) => c.type !== 'function').map((c) => ({ ...c, path: 'geofs.animation.values.' + c.path })),
          ...scanNested(inst, 'geofs.aircraft.instance', GEAR_RE, 20).filter((c) => c.type !== 'function'),
        ],
        setterMethodCandidates: [
          ...methodCandidates(inst, 'geofs.aircraft.instance', GEAR_RE, 20),
          ...methodCandidates(geofsObj, 'geofs', GEAR_RE, 20),
        ],
        note: 'setterMethodCandidates are typeof/arity reads only — this probe never calls one.',
      };

      const crashDamage = {
        candidates: [
          ...scanObjectKeys(av, CRASH_RE, 20).map((c) => ({ ...c, path: 'geofs.animation.values.' + c.path })),
          ...scanObjectKeys(inst, CRASH_RE, 20).map((c) => ({ ...c, path: 'geofs.aircraft.instance.' + c.path })),
          ...scanObjectKeys(geofsObj, CRASH_RE, 20).map((c) => ({ ...c, path: 'geofs.' + c.path })),
        ],
      };

      const groundspeedAndStopped = {
        groundspeedCandidates: [
          { path: 'geofs.aircraft.instance.groundSpeed', type: safe(() => typeof inst.groundSpeed, 'undefined'), value: safe(() => inst.groundSpeed, null) },
          ...scanObjectKeys(av, GROUNDSPEED_RE, 10).map((c) => ({ ...c, path: 'geofs.animation.values.' + c.path })),
        ],
        stoppedFieldCandidates: [
          ...scanObjectKeys(av, STOPPED_RE, 10).map((c) => ({ ...c, path: 'geofs.animation.values.' + c.path })),
          ...scanObjectKeys(inst, STOPPED_RE, 10).map((c) => ({ ...c, path: 'geofs.aircraft.instance.' + c.path })),
        ],
        note: 'No dedicated "stopped" flag is confirmed. isStopped(groundSpeedMps) in this file thresholds raw groundspeed instead — LANDING_SAMPLER logs it so a real threshold can be picked from rollout data.',
      };

      const airspeed = {
        candidates: [
          ...scanObjectKeys(av, AIRSPEED_RE, 20).map((c) => ({ ...c, path: 'geofs.animation.values.' + c.path })),
          ...scanObjectKeys(inst, AIRSPEED_RE, 20).map((c) => ({ ...c, path: 'geofs.aircraft.instance.' + c.path })),
        ],
        note: 'geofs.animation.values.kias (already in report.gAdapter above) is indicated airspeed. This widens the search for a true-airspeed field; geofs.aircraft.instance.trueAirSpeed (used by race.js\'s Boost) is included as a known candidate.',
      };

      return { groundContact, verticalSpeed, agl, gear, crashDamage, groundspeedAndStopped, airspeed };
    }, '[error building landing section]');
  }

  // Discovers the touchdown-detector candidates (see the file's top comment, "TOUCHDOWN INPUTS")
  // as live readers rather than one-off values, so sampleTouchdownInputs() below can re-read each
  // one 5 times, 200 ms apart. Read-only: every reader is a plain property access, plus one
  // globe.getHeight() terrain query for the derived-AGL candidate — same call report.landing.agl
  // already makes. Returns { candidates, groundFlagDerivation } synchronously; the samples
  // themselves are filled in later by sampleTouchdownInputs().
  function buildTouchdownInputCandidates() {
    return safe(() => {
      const inst = geofs.aircraft.instance;
      const av = safe(() => geofs.animation.values, undefined);

      const AGL_RE = /agl|groundelevation|terrainheight|altitudeabove|heightabove|groundlevel|relativealt/i;
      const VSPEED_RE = /climbrate|verticalspeed|vspeed|sinkrate|vsi/i;
      const GROUND_CONTACT_RE = /contact|onground|weighton|touchdown|grounded|wheelload|squat|isground|collresult|collision/i;
      const AIRSPEED_RE = /kias|^ias$|^tas$|airspeed/i;
      const GEAR_RE = /gear/i;
      const NESTED_CONTAINER_NAMES = ['wheels', 'gear', 'landingGear', 'undercarriage', 'suspension', 'suspensions', 'gearSystem'];

      function guessUnits(path) {
        if (AGL_RE.test(path)) return 'meters (assumed — matches llaLocation altitude units)';
        if (VSPEED_RE.test(path)) return 'ft/min (GeoFS climbrate convention) or m/s — compare against report.landing.verticalSpeed.crossCheck';
        if (GROUND_CONTACT_RE.test(path)) return 'boolean, or an array/object for per-gear state';
        if (/kias/i.test(path)) return 'knots (indicated)';
        if (AIRSPEED_RE.test(path)) return 'm/s or knots — unconfirmed';
        if (GEAR_RE.test(path)) return 'boolean/number (gear position or per-gear compression) — unconfirmed';
        return 'unconfirmed';
      }

      // Like scanObjectKeys/scanNested elsewhere in this file, but keeps a live `read` closure
      // per key instead of a single snapshot value, since these candidates get sampled later.
      function scanReadable(obj, pathPrefix, re, capN, category) {
        if (!obj || typeof obj !== 'object') return [];
        const keys = keysOf(obj).filter((k) => re.test(k));
        return keys.slice(0, capN || 20).map((k) => {
          const path = pathPrefix + '.' + k;
          return { path, category, type: safe(() => typeof obj[k], 'unknown'), unitsGuess: guessUnits(path), read: () => safe(() => obj[k], undefined) };
        });
      }

      function scanReadableNested(root, rootLabel, re, capN, category) {
        const out = scanReadable(root, rootLabel, re, capN, category);
        for (const name of NESTED_CONTAINER_NAMES) {
          const sub = safe(() => root[name], undefined);
          if (!sub || typeof sub !== 'object') continue;
          if (typeof sub.length === 'number') {
            const n = Math.min(sub.length, 4);
            for (let i = 0; i < n; i++) out.push(...scanReadable(sub[i], rootLabel + '.' + name + '[' + i + ']', re, capN, category));
          } else {
            out.push(...scanReadable(sub, rootLabel + '.' + name, re, capN, category));
          }
        }
        return out;
      }

      const candidates = [];

      // altitude above ground, and ground elevation under the aircraft
      candidates.push(...scanReadable(av, 'geofs.animation.values', AGL_RE, 20, 'agl'));
      candidates.push(...scanReadable(inst, 'geofs.aircraft.instance', AGL_RE, 20, 'agl'));
      candidates.push({
        path: 'geofs.api.viewer.scene.globe.getHeight(...) vs geofs.aircraft.instance.llaLocation[2]',
        category: 'agl',
        type: 'derived (function call)',
        unitsGuess: 'meters MSL for terrain height; AGL = llaLocation[2] - terrainHeight',
        read: () => safe(() => {
          const lla = inst.llaLocation;
          const viewer = geofs.api.viewer;
          const globe = viewer && viewer.scene && viewer.scene.globe;
          if (!globe || typeof globe.getHeight !== 'function' || !Array.isArray(lla)) return undefined;
          const carto = Cesium.Cartographic.fromDegrees(lla[1], lla[0]);
          const terrainMsl = globe.getHeight(carto);
          return {
            terrainMslM: typeof terrainMsl === 'number' ? terrainMsl : null,
            aircraftAltM: lla[2],
            aglEstimateM: typeof terrainMsl === 'number' ? lla[2] - terrainMsl : null,
          };
        }, undefined),
      });

      // vertical speed
      candidates.push(...scanReadable(av, 'geofs.animation.values', VSPEED_RE, 20, 'verticalSpeed'));
      candidates.push(...scanReadable(inst, 'geofs.aircraft.instance', VSPEED_RE, 20, 'verticalSpeed'));

      // on-ground / weight-on-wheels / groundContact flag (bool or per-gear)
      const groundContactCandidates = [
        ...scanReadableNested(inst, 'geofs.aircraft.instance', GROUND_CONTACT_RE, 20, 'groundContact'),
        ...scanReadable(av, 'geofs.animation.values', GROUND_CONTACT_RE, 20, 'groundContact'),
      ];
      candidates.push(...groundContactCandidates);

      // indicated airspeed
      candidates.push(...scanReadable(av, 'geofs.animation.values', AIRSPEED_RE, 20, 'airspeed'));
      candidates.push(...scanReadable(inst, 'geofs.aircraft.instance', AIRSPEED_RE, 20, 'airspeed'));

      // heading/pitch/roll (already known: htr) and lat/lon/alt (already known: llaLocation) —
      // sampled here too so their liveness/cadence can be read off the same 5-sample table as the
      // unconfirmed candidates above, plus whatever else av exposes under the obvious names.
      candidates.push({
        path: 'geofs.aircraft.instance.htr', category: 'attitude',
        type: safe(() => typeof inst.htr, 'undefined'),
        unitsGuess: 'degrees [heading, pitch, roll] — confirmed, used by the G adapter',
        read: () => safe(() => (Array.isArray(inst.htr) ? inst.htr.slice(0, 3) : inst.htr), undefined),
      });
      for (const k of ['heading360', 'pitch', 'roll', 'bank']) {
        if (av && k in av) {
          candidates.push({
            path: 'geofs.animation.values.' + k, category: 'attitude',
            type: safe(() => typeof av[k], 'unknown'),
            unitsGuess: 'degrees (assumed, matches htr convention)',
            read: () => safe(() => av[k], undefined),
          });
        }
      }
      candidates.push({
        path: 'geofs.aircraft.instance.llaLocation', category: 'position',
        type: safe(() => typeof inst.llaLocation, 'undefined'),
        unitsGuess: 'degrees, degrees, meters — [lat, lon, altMSL], confirmed, used by the G adapter',
        read: () => safe(() => (Array.isArray(inst.llaLocation) ? inst.llaLocation.slice(0, 3) : inst.llaLocation), undefined),
      });

      // If nothing boolean turned up for ground contact, log candidates for deriving it instead
      // of guessing at a flag that isn't there — gear compression, and AGL settling near 0.
      let groundFlagDerivation = null;
      if (!groundContactCandidates.some((c) => c.type === 'boolean')) {
        groundFlagDerivation = {
          note: 'No boolean field matched the ground-contact search above — logging derivation candidates instead.',
          gearCompressionCandidates: scanReadableNested(inst, 'geofs.aircraft.instance', GEAR_RE, 20, 'gear').filter((c) => c.type !== 'function').map(({ read, ...rest }) => rest),
          aglNearZero: 'See the "agl" category\'s globe.getHeight-derived candidate above (aglEstimateM). Treat a small |aglEstimateM| as "likely on ground" only in combination with vertical speed settling near 0 — llaLocation tracks a fuselage/CG reference point, not the wheel-contact point, so it may not reach exactly 0.',
        };
      }

      return { candidates, groundFlagDerivation };
    }, { candidates: [], groundFlagDerivation: null, error: 'threw building touchdown-input candidates' });
  }

  // Re-reads every candidate's `read()` `count` times, `intervalMs` apart, appending each read as
  // { atMs, value } onto that candidate's own `.samples` array (atMs is time since the first
  // sample, not wall-clock). Returns a Promise of the same candidates array, samples attached, so
  // the caller can wait for it. `read` is stripped by the caller before the report is serialized;
  // JSON.stringify would otherwise silently drop it as a function value anyway.
  function sampleTouchdownInputs(candidates, count, intervalMs) {
    return new Promise((resolve) => {
      const t0 = safe(() => performance.now(), Date.now());
      let n = 0;
      function tick() {
        const atMs = Math.round(safe(() => performance.now(), Date.now()) - t0);
        for (const c of candidates) {
          if (!c.samples) c.samples = [];
          c.samples.push({ atMs, value: summarize(safe(c.read, undefined), 0, new Set()) });
        }
        n++;
        if (n >= count) { resolve(candidates); return; }
        setTimeout(tick, intervalMs);
      }
      tick();
    });
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

    // ---- reposition candidates (air-start work, race/README.md "Fly to start"). Read-only:
    // only typeof/property reads and Object.keys — never calls any of these.
    report.reposition = safe(() => {
      const REPOSITION_RE = /set|teleport|move|reposition|coordinate|position|relocate/i;
      const SPAWN_RE = /spawn|start|reset.?position|goto/i;

      function matchingMethodNames(obj, re, capN) {
        if (!obj) return [];
        const keys = keysOf(obj).filter((k) => re.test(k) && safe(() => typeof obj[k], '') === 'function');
        const out = keys.slice(0, capN);
        if (keys.length > capN) out.push('…(' + (keys.length - capN) + ' more)');
        return out;
      }
      function matchingKeyTypes(obj, re, capN) {
        if (!obj) return {};
        const keys = keysOf(obj).filter((k) => re.test(k));
        const out = {};
        keys.slice(0, capN).forEach((k) => { out[k] = safe(() => typeof obj[k], 'unknown'); });
        if (keys.length > capN) out['…'] = 'truncated (' + (keys.length - capN) + ' more keys)';
        return out;
      }

      const inst = safe(() => geofs.aircraft.instance, undefined);
      const geofsObj = safe(() => geofs, undefined);
      const uiObj = safe(() => ui, undefined);

      // The path race.js's FlyToStart now tries FIRST (see G.repositionViaReset): GeoFS's own
      // reset, pointed at gate 1 by editing the coordinate array it reads. Read-only here — the
      // function is never called, only described, because calling it would move the aircraft.
      function describeArray(a) {
        if (!Array.isArray(a)) return { isArray: false, type: typeof a };
        return { isArray: true, length: a.length, values: a.slice(0, 8).map((n) => typeof n === 'number' ? n : typeof n) };
      }

      return {
        aircraftInstanceMethods: matchingMethodNames(inst, REPOSITION_RE, 30),
        geofsTopLevelKeys: matchingKeyTypes(geofsObj, REPOSITION_RE, 30),
        resetFlight: {
          type: safe(() => typeof geofs.resetFlight, 'undefined'),
          arity: safe(() => geofs.resetFlight.length, null),
        },
        // Layout matters: race.js assumes [lat, lon, alt, heading, ...] (multiplayer `co`'s
        // layout) and preserves every other entry. If these are objects rather than arrays, or
        // the first four aren't lat/lon/alt/heading, that assumption needs correcting.
        coordinateArrays: {
          lastFlightCoordinates: safe(() => describeArray(geofs.lastFlightCoordinates), 'unreadable'),
          initialCoordinates: safe(() => describeArray(geofs.initialCoordinates), 'unreadable'),
        },
        htr: safe(() => describeArray(inst.htr), 'unreadable'),
        velocityFieldTypes: {
          velocity: safe(() => typeof inst.velocity, 'undefined'),
          trueAirSpeed: safe(() => typeof inst.trueAirSpeed, 'undefined'),
          groundSpeed: safe(() => typeof inst.groundSpeed, 'undefined'),
          htr: safe(() => typeof inst.htr, 'undefined'),
        },
        getFlytToCoordinates: {
          type: safe(() => typeof geofs.camera.getFlytToCoordinates, 'undefined'),
          arity: safe(() => geofs.camera.getFlytToCoordinates.length, null),
        },
        spawnLikeKeys: {
          geofs: matchingKeyTypes(geofsObj, SPAWN_RE, 30),
          ui: uiObj === undefined ? undefined : matchingKeyTypes(uiObj, SPAWN_RE, 30),
          window: matchingKeyTypes(window, SPAWN_RE, 30),
        },
      };
    }, '[error reading reposition internals]');

    // ---- control inputs (powerups: the offensive-hit "wobble", race/README.md "Powerups").
    // Nothing here has ever been probed, which is exactly why CONFIG.POWERUP_CONTROL_EFFECTS
    // ships OFF and offensive hits are screen-effect-only. Strictly read-only: typeof/value
    // reads and Object.keys, never a write and never a call — a probe run must not be able to
    // move the aircraft. Paste this section back to decide whether a real control hook exists
    // and is safe to bias, or whether screen-only is the permanent answer.
    report.controls = safe(() => {
      const CONTROL_RE = /control|aileron|elevator|rudder|throttle|yoke|stick|trim|brake|flap/i;

      function numericFields(obj, capN) {
        if (!obj || typeof obj !== 'object') return null;
        const out = {};
        let n = 0;
        for (const k of keysOf(obj)) {
          if (n >= capN) { out['…'] = 'truncated'; break; }
          const t = safe(() => typeof obj[k], 'unknown');
          if (t === 'number' || t === 'boolean') { out[k] = { type: t, value: safe(() => obj[k], null) }; n++; }
          else if (t === 'object' || t === 'function') { out[k] = { type: t }; n++; }
        }
        return out;
      }
      function matchingKeyTypes(obj, re, capN) {
        if (!obj) return {};
        const keys = keysOf(obj).filter((k) => re.test(k));
        const out = {};
        keys.slice(0, capN).forEach((k) => { out[k] = safe(() => typeof obj[k], 'unknown'); });
        if (keys.length > capN) out['…'] = 'truncated (' + (keys.length - capN) + ' more keys)';
        return out;
      }

      const geofsObj = safe(() => geofs, undefined);
      const inst = safe(() => geofs.aircraft.instance, undefined);

      return {
        // The exact path race.js's G.controlWobble() guesses at today.
        'geofs.controls': {
          exists: safe(() => typeof geofs.controls, 'undefined'),
          fields: numericFields(safe(() => geofs.controls, undefined), 40),
        },
        // Other plausible homes for a writable control input.
        'geofs.animation.values control-ish keys': matchingKeyTypes(safe(() => geofs.animation.values, undefined), CONTROL_RE, 30),
        'geofs.aircraft.instance control-ish keys': matchingKeyTypes(inst, CONTROL_RE, 30),
        'geofs top-level control-ish keys': matchingKeyTypes(geofsObj, CONTROL_RE, 30),
        'window control-ish keys': matchingKeyTypes(window, CONTROL_RE, 30),
        // Does GeoFS drive controls from an input/autopilot layer that would fight a write?
        autopilot: {
          exists: safe(() => typeof geofs.autopilot, 'undefined'),
          on: safe(() => geofs.autopilot && geofs.autopilot.on, undefined),
        },
        // If the sim reads control state from a definition/animation pipeline each frame, a
        // one-off write gets overwritten — same failure mode as the llaLocation boost nudge.
        notes: 'Looking for a numeric, writable, normalized (-1..1) control input that GeoFS reads each frame.',
      };
    }, '[error reading control internals]');

    // ---- map (read-only: no addLayer/setView/etc. calls, typeof/property reads only)
    report.map = safe(() => {
      const MAP_KEY_RE = /map|nav|plan|route|waypoint/i;
      const NAVLOG_RE = /flightplan|flight_plan|navlog|nav_log|waypoint|route/i;

      function matchingKeys(obj, capN) {
        if (!obj) return null;
        const keys = keysOf(obj).filter((k) => MAP_KEY_RE.test(k));
        const out = keys.slice(0, capN);
        if (keys.length > capN) out.push('…(' + (keys.length - capN) + ' more)');
        return out;
      }
      function navMatches(obj, srcName, capN) {
        if (!obj) return [];
        return keysOf(obj).filter((k) => NAVLOG_RE.test(k)).slice(0, capN).map((k) => srcName + '.' + k);
      }
      function looksLikeLeafletMap(v) {
        return safe(() => !!v && typeof v === 'object' && typeof v.addLayer === 'function' && typeof v.getCenter === 'function', false);
      }

      const out = {};

      out.leafletGlobal = {
        hasL: typeof window.L !== 'undefined',
        version: safe(() => window.L.version, null),
      };

      const containers = safe(() => Array.from(document.querySelectorAll('.leaflet-container')), []);
      out.leafletContainers = {
        count: containers.length,
        firstClassList: containers.length ? safe(() => Array.from(containers[0].classList), []) : null,
        firstLeafletId: containers.length ? safe(() => containers[0]._leaflet_id, undefined) : undefined,
      };

      const geofsObj = safe(() => geofs, undefined);
      const uiObj = safe(() => ui, undefined);
      out.matchingKeys = {
        geofs: matchingKeys(geofsObj, 30),
        ui: typeof uiObj === 'undefined' ? undefined : matchingKeys(uiObj, 30),
        window: matchingKeys(window, 40),
      };

      // Look for a reachable Leaflet map instance among map/nav-ish keys on window/geofs/ui.
      // Only typeof/property reads on candidates — never call any of their methods.
      const candidates = [];
      for (const src of [{ name: 'window', obj: window }, { name: 'geofs', obj: geofsObj }, { name: 'ui', obj: uiObj }]) {
        if (!src.obj) continue;
        for (const k of keysOf(src.obj)) {
          if (!MAP_KEY_RE.test(k)) continue;
          const v = safe(() => src.obj[k], undefined);
          if (looksLikeLeafletMap(v)) {
            candidates.push({
              path: src.name + '.' + k,
              ctor: safe(() => v.constructor && v.constructor.name, null),
              addLayer: typeof safe(() => v.addLayer, undefined),
              getCenter: typeof safe(() => v.getCenter, undefined),
            });
          }
        }
      }
      out.leafletMapCandidates = candidates.slice(0, 10);

      out.leafletApi = {
        polyline: safe(() => typeof window.L.polyline, 'undefined'),
        circle: safe(() => typeof window.L.circle, 'undefined'),
        layerGroup: safe(() => typeof window.L.layerGroup, 'undefined'),
      };

      // Whatever GeoFS calls its flight-plan / nav log, if discoverable by name.
      out.navLogCandidates = [
        ...navMatches(geofsObj, 'geofs', 20),
        ...navMatches(uiObj, 'ui', 20),
        ...navMatches(window, 'window', 20),
      ].slice(0, 30);

      return out;
    }, '[error reading map internals]');

    // ---- landing: read-only survey for a landing-challenge scorer. Every value here is a typeof
    // or property read (plus one globe.getHeight() terrain query, itself just a read); nothing in
    // this section calls a setter or writes state. See the file's top comment for what each piece
    // is for and race/tools/probe.js's own regex-scan pattern (used by "reposition"/"controls"
    // above) that this section reuses.
    report.landing = buildLandingSection();

    report.uiLayout = safe(buildUiLayoutSection, '[error reading UI layout]');

    return report;
  }

  // Read-only: getBoundingClientRect/getComputedStyle and property reads. See "UI LAYOUT" at the top.
  function buildUiLayoutSection() {
    const vw = window.innerWidth, vh = window.innerHeight;
    const vv = window.visualViewport;
    const out = {
      viewport: {
        innerWidth: vw, innerHeight: vh, dpr: window.devicePixelRatio,
        visual: vv ? { width: Math.round(vv.width), height: Math.round(vv.height), scale: vv.scale, offsetTop: Math.round(vv.offsetTop) } : null,
        coarsePointer: safe(() => window.matchMedia('(pointer: coarse)').matches, null),
        docScrollWidth: document.documentElement.scrollWidth, docScrollHeight: document.documentElement.scrollHeight,
        docWiderThanWindow: document.documentElement.scrollWidth > vw,
      },
      elements: [],
      offscreen: [],
    };
    const all = Array.from(document.body.querySelectorAll('*')).slice(0, 20000);
    const rows = [];
    for (const el of all) {
      if (el.closest && el.closest('[id^="fr-"]')) continue;
      const cs = window.getComputedStyle(el);
      const idClass = (el.id || '') + ' ' + (typeof el.className === 'string' ? el.className : '');
      const role = uiRoleGuess(idClass);
      const positioned = cs.position === 'fixed' || cs.position === 'absolute';
      if (!positioned && !role) continue;
      const info = uiRectInfo(el.getBoundingClientRect(), cs, vw, vh);
      const row = { selector: uiSelector(el.tagName, el.id, el.className), role, ...info, children: el.childElementCount };
      if (info.shown && (info.pastRight || info.pastBottom)) out.offscreen.push(row);
      if (info.shown && (role || info.w * info.h >= 400)) rows.push(row);
    }
    rows.sort((a, b) => (b.role ? 1 : 0) - (a.role ? 1 : 0) || b.w * b.h - a.w * a.h);
    out.elements = rows.slice(0, 80);
    out.offscreen = out.offscreen.slice(0, 20);
    out.instrumentsObject = safe(() => {
      const ins = window.geofs && window.geofs.instruments;
      if (!ins) return null;
      const keys = {};
      for (const k of keysOf(ins).slice(0, MAX_KEYS)) keys[k] = typeof safe(() => ins[k], undefined);
      return keys;
    }, '[error reading geofs.instruments]');
    return out;
  }

  function cap(str) {
    if (str.length <= MAX_BYTES) return str;
    return str.slice(0, MAX_BYTES) + '\n…(truncated, ' + str.length + ' bytes total)';
  }

  // Shared by the static report and LANDING_SAMPLER's own output: stringify, cap, console.log,
  // clipboard-copy-with-alert-fallback. `label` distinguishes the two in the console/alert text.
  function outputReport(label, obj) {
    let text;
    try {
      text = cap(JSON.stringify(obj, null, 1));
    } catch (e) {
      text = JSON.stringify({ error: label + ' failed to serialize: ' + e.message });
    }
    console.log('[fins' + label + ']', text);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text)
        .then(() => alert('FINSONLY ' + label + ': report copied to clipboard (' + text.length + ' bytes). Paste it back.'))
        .catch(() => alert('FINSONLY ' + label + ': clipboard write failed. The report is in the console (F12) — copy it from there.'));
    } else {
      alert('FINSONLY ' + label + ': clipboard API unavailable. The report is in the console (F12) — copy it from there.');
    }
  }

  // Runs the actual probe. Only called in a real browser (see the bottom of this file) — under
  // plain Node (the unit test) this whole function is defined but never invoked, and none of its
  // window/document/geofs/Cesium references are ever touched.
  function runInBrowser() {
  let report;
  try {
    report = buildReport();
  } catch (e) {
    report = { error: 'probe failed: ' + e.message };
  }

  // The vertical-speed cross-check needs a second sample 250 ms later, and touchdownInputs needs
  // TOUCHDOWN_SAMPLE_COUNT samples TOUCHDOWN_SAMPLE_INTERVAL_MS apart (~800 ms) — so the main
  // report's output is deferred until both finish (the longer of the two). LANDING_SAMPLER (below)
  // is independent of this and starts listening for Alt+L immediately either way.
  const vs0 = safe(landingSnapshot, null);
  const vs0AtMs = safe(() => performance.now(), Date.now());
  const landingCrossCheckPromise = new Promise((resolve) => {
    setTimeout(() => {
      const vs1 = safe(landingSnapshot, null);
      const vs1AtMs = safe(() => performance.now(), Date.now());
      const dtMs = vs1AtMs - vs0AtMs;
      const computedMps = vs0 && vs1 ? verticalSpeedFromAltitudes(vs0.altM, vs1.altM, dtMs) : null;
      resolve({
        sampleWindowMs: dtMs,
        t0: vs0, t1: vs1,
        computedMps: computedMps,
        computedFpm: mpsToFpm(computedMps),
        note: 'Compare computedMps/computedFpm above against each entry in fieldCandidates to find the real units and confirm the sign convention (positive = climbing).',
      });
    }, 250);
  });

  const touchdownInputsPromise = safe(() => {
    const built = buildTouchdownInputCandidates();
    return sampleTouchdownInputs(built.candidates, TOUCHDOWN_SAMPLE_COUNT, TOUCHDOWN_SAMPLE_INTERVAL_MS).then((sampled) => ({
      sampleCount: TOUCHDOWN_SAMPLE_COUNT,
      sampleIntervalMs: TOUCHDOWN_SAMPLE_INTERVAL_MS,
      candidates: sampled.map(({ read, ...rest }) => rest),
      groundFlagDerivation: built.groundFlagDerivation,
      note: 'Read-only field discovery for the touchdown detector — see the file\'s top comment ("TOUCHDOWN INPUTS"). Each candidate\'s samples[] shows 5 reads 200 ms apart so units/liveness/sign are readable without a real flight.',
    }));
  }, Promise.resolve({ error: 'threw building/sampling touchdown-input candidates' }));

  Promise.all([landingCrossCheckPromise, touchdownInputsPromise]).then(([crossCheck, touchdownInputs]) => {
    if (report && report.landing && report.landing.verticalSpeed) {
      report.landing.verticalSpeed.crossCheck = crossCheck;
    }
    if (report) report.touchdownInputs = touchdownInputs;
    outputReport('probe', report);
  });

  // ---- LANDING_SAMPLER: Alt+L toggles a 20 Hz, up-to-30-s capture of landingSnapshot(). Fully
  // read-only — same guarantee as the rest of this file. Press Alt+L again to stop early and get
  // whatever was collected so far; otherwise it stops itself at LANDING_SAMPLE_DURATION_MS.
  (function setupLandingSampler() {
    if (window.__finsLandingSampler) return; // a second probe injection reuses the existing listener
    const state = { running: false, samples: [], startedAt: 0, timer: null, hardStop: null };
    window.__finsLandingSampler = state;

    function tick() {
      const snap = safe(landingSnapshot, null);
      state.samples.push(Object.assign({ tMs: Math.round(safe(() => performance.now(), Date.now()) - state.startedAt) }, snap || { error: true }));
    }

    function stop() {
      if (!state.running) return;
      state.running = false;
      clearInterval(state.timer);
      clearTimeout(state.hardStop);
      state.timer = null;
      state.hardStop = null;
      outputReport('landingSampler', {
        generatedAt: new Date().toISOString(),
        url: location.href,
        sampleHz: LANDING_SAMPLE_HZ,
        durationMsRequested: LANDING_SAMPLE_DURATION_MS,
        durationMsActual: state.samples.length ? state.samples[state.samples.length - 1].tMs : 0,
        sampleCount: state.samples.length,
        samples: state.samples,
      });
    }

    function start() {
      state.samples = [];
      state.startedAt = safe(() => performance.now(), Date.now());
      state.running = true;
      tick();
      state.timer = setInterval(tick, LANDING_SAMPLE_MS);
      state.hardStop = setTimeout(stop, LANDING_SAMPLE_DURATION_MS);
      console.log('[finslandingSampler] started — logging at ' + LANDING_SAMPLE_HZ + ' Hz for up to ' + (LANDING_SAMPLE_DURATION_MS / 1000) + ' s. Press Alt+L again to stop early.');
    }

    window.addEventListener('keydown', (e) => {
      if (!e.altKey || (e.key !== 'l' && e.key !== 'L')) return;
      if (state.running) stop(); else start();
    });
  })();
  } // end runInBrowser

  // Run the real thing only in a browser with GeoFS's globals; under Node (the unit test) this
  // file just exports its pure functions and touches nothing browser-specific — same split as
  // race/tools/terrain_probe.js.
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    runInBrowser();
  } else if (typeof module !== 'undefined' && module.exports) {
    module.exports = { mpsToFpm, fpmToMps, verticalSpeedFromAltitudes, isStopped, FPM_PER_MPS, uiSelector, uiRoleGuess, uiRectInfo };
  }
})();
