/*
 * FINSONLY Racing — GeoFS/Cesium internals probe (one-shot, read-only except the opt-in ground placement button).
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
 *
 * DASH DISCOVERY (navMaps, runways, recorder, groundPlacement; discovery for the airport-to-airport
 * Dash race): everything is read-only EXCEPT groundPlacement, which only runs from the red "Run
 * ground placement test" button the probe adds (bottom-left, behind a confirm()). navMaps lists
 * every Leaflet map (walk of geofs/ui/window + DOM containers) with visibility, size, zoom,
 * layer count and JS path, says which one the course overlay is on and which one race.js's
 * G.leafletMap() would pick, and keeps a 500 ms watcher so a second run can say whether the N panel
 * map is created lazily, destroyed or reused. runways looks for GeoFS's own airport/runway store.
 * recorder finds the flight recorder object behind GeoFS's JSON export. The report starts with a
 * dashReadiness summary. See race/README.md ("Probe").
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
    const shown = style.display !== 'none' && style.visibility !== 'hidden' && (style.opacity === '' || style.opacity == null || +style.opacity !== 0) && r.w > 0 && r.h > 0;
    return {
      ...r, position: style.position, zIndex: style.zIndex, display: style.display, visibility: style.visibility,
      shown, pastRight: r.x + r.w > vw, pastBottom: r.y + r.h > vh,
    };
  }

  // ---- DASH DISCOVERY helpers (pure; plain-object inputs, no DOM/GeoFS). The browser sections
  // below feed these what they read; Node tests them. See "DASH DISCOVERY" in the top comment.
  const KPDX = { lat: 45.5887, lon: -122.5975 };
  const KSEA = { lat: 47.4502, lon: -122.3088 };
  const GROUND_TEST_FALLBACK = { lat: 45.5960, lon: -122.6000, hdg: 100, ground: 9 };
  const GROUND_SAMPLE_MS = 100;
  const GROUND_SAMPLE_DURATION_MS = 5000;
  const GROUND_STATIONARY_MAX_MPS = 3;   // the 'stationary' bar in judgeGroundPlacement
  const GROUND_MAX_DRIFT_M = 10;         // ...and how far it may wander over the 5 s window

  function finiteOrNull(v) {
    if (typeof v === 'number') return isFinite(v) ? v : null;
    if (typeof v === 'string' && v.trim() !== '' && isFinite(+v)) return +v;
    return null;
  }
  function haversineM(lat1, lon1, lat2, lon2) {
    const R = 6371008.8, rad = Math.PI / 180;
    const a = Math.sin((lat2 - lat1) * rad / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin((lon2 - lon1) * rad / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }
  function ownKeyMatching(o, re) {
    for (const k of safe(() => Object.keys(o), [])) if (re.test(k)) { const v = safe(() => o[k], undefined); if (v != null) return { key: k, value: v }; }
    return null;
  }
  // lat/lon out of whatever a runway record calls them: lat/lon pairs of keys, or a nested
  // [lat, lon] (GeoJSON-ish 'coordinates' is [lon, lat]) / {lat, lon} under a position-ish key.
  function latLonOf(o, depth) {
    if (!o || typeof o !== 'object') return null;
    const la = ownKeyMatching(o, /^(lat|latitude|thr_?lat|start_?lat|lat_?1|le_?lat)$/i);
    const lo = ownKeyMatching(o, /^(lon|lng|long|longitude|thr_?lon|start_?lon|lon_?1|le_?lon)$/i);
    if (la && lo) {
      const a = finiteOrNull(la.value), b = finiteOrNull(lo.value);
      if (a != null && b != null && Math.abs(a) <= 90 && Math.abs(b) <= 180) return { lat: a, lon: b, latKey: la.key, lonKey: lo.key };
    }
    if ((depth || 0) >= 1) return null;
    const nested = ownKeyMatching(o, /^(lla|threshold|thr|start|position|pos|coordinates|coords|location|loc|end1|end_?a)$/i);
    if (!nested) return null;
    const v = nested.value;
    if (Array.isArray(v) && v.length >= 2) {
      const geo = /^coord/i.test(nested.key);
      const a = finiteOrNull(geo ? v[1] : v[0]), b = finiteOrNull(geo ? v[0] : v[1]);
      if (a != null && b != null && Math.abs(a) <= 90 && Math.abs(b) <= 180) {
        const alt = v.length >= 3 ? finiteOrNull(v[2]) : null;
        return { lat: a, lon: b, alt, altKey: alt != null ? nested.key + '[2]' : null, latKey: nested.key + (geo ? '[1]' : '[0]'), lonKey: nested.key + (geo ? '[0]' : '[1]') };
      }
      return null;
    }
    const r = latLonOf(v, 1);
    return r ? { ...r, latKey: nested.key + '.' + r.latKey, lonKey: nested.key + '.' + r.lonKey } : null;
  }
  // One runway-ish record -> {icao, ident, lat, lon, heading, length, lengthKey, elev, elevKey},
  // or null when there's no usable lat/lon. length/elev keep their raw value and key name because
  // the unit (m or ft) is exactly what the report has to let a human decide.
  function normalizeRunway(rec, ctx) {
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return null;
    const ll = latLonOf(rec, 0);
    if (!ll) return null;
    const pick = (re) => ownKeyMatching(rec, re);
    const icao = pick(/^(icao|airport_?icao|airport_?id|airport|apt|ap)$/i);
    const ident = pick(/^(ident|rwy|runway|designator|name|le_?ident)$/i);
    const hdg = pick(/^(heading|hdg|bearing|course|true_?heading|rwy_?hdg|le_?heading_?deg\w*)$/i);
    const len = pick(/^(length|len|length_?m|length_?ft|length_?meters)$/i);
    const elv = pick(/^(elev|elevation|ele|alt|altitude|elev_?m|elev_?ft|le_?elevation_?ft)$/i);
    const str = (x) => (typeof x === 'string' ? x : null);
    const hdgRaw = hdg ? finiteOrNull(hdg.value) : null;
    return {
      icao: str(icao && icao.value) || (ctx && ctx.icao) || null,
      ident: str(ident && ident.value) || (ident && finiteOrNull(ident.value) != null ? String(ident.value) : null),
      lat: ll.lat, lon: ll.lon,
      heading: hdgRaw, headingDeg: hdgRaw == null ? null : Math.round((((hdgRaw % 360) + 360) % 360) * 100) / 100,
      length: len ? finiteOrNull(len.value) : null, lengthKey: len ? len.key : null,
      elev: elv ? finiteOrNull(elv.value) : ll.alt != null ? ll.alt : null, elevKey: elv ? elv.key : ll.altKey || null,
      latKey: ll.latKey, lonKey: ll.lonKey,
    };
  }
  // Every normalizable record under an array / Map / object, descending through tile-keyed maps and
  // airport -> runways[] nesting (depth <= 3). A key that looks like an ICAO supplies the icao.
  function flattenRunwayRecords(container, cap, ctx, depth, out) {
    out = out || [];
    depth = depth || 0;
    if (!container || typeof container !== 'object' || depth > 3 || out.length >= cap) return out;
    let entries;
    if (Array.isArray(container)) entries = container.map((x, i) => [i, x]);
    else if (typeof Map !== 'undefined' && container instanceof Map) entries = Array.from(container.entries());
    else entries = safe(() => Object.keys(container).map((k) => [k, container[k]]), []);
    for (const [k, x] of entries) {
      if (out.length >= cap) break;
      if (!x || typeof x !== 'object') continue;
      const keyIcao = typeof k === 'string' && /^[A-Z][A-Z0-9]{2,3}$/.test(k) ? k : null;
      const here = { icao: keyIcao || (ctx && ctx.icao) || null };
      const rec = normalizeRunway(x, here);
      const kids = ownKeyMatching(x, /^(runways|rwys|runway|rwy)$/i);
      if (rec) out.push(rec);
      if (kids && typeof kids.value === 'object') flattenRunwayRecords(kids.value, cap, { icao: (rec && rec.icao) || here.icao }, depth + 1, out);
      else if (!rec) flattenRunwayRecords(x, cap, here, depth + 1, out);
    }
    return out;
  }
  function nearestRunways(list, lat, lon, n) {
    return (list || []).map((r) => ({ ...r, distanceM: Math.round(haversineM(lat, lon, r.lat, r.lon)) }))
      .sort((a, b) => a.distanceM - b.distanceM).slice(0, n);
  }
  // KPDX 10R (or any airport/ident): records of that icao (when they have one) within maxM of the
  // hint point whose ident starts with `ident`, or, when GeoFS gives no designator at all (its
  // geofs.runways records carry only heading), whose heading is within 6 degrees of the number.
  // With an L/R suffix and several parallel candidates, R is the one furthest right facing along
  // the runway and L the furthest left. null when nothing qualifies.
  function findRunway(list, icao, ident, near, maxM) {
    const want = String(ident || '').toUpperCase();
    const m = /^(\d{1,2})([LRC]?)$/.exec(want);
    const angDiff = (a, b) => Math.abs((((a - b) % 360) + 540) % 360 - 180);
    let c = [];
    for (const r of list || []) {
      if (r.icao && icao && String(r.icao).toUpperCase() !== String(icao).toUpperCase()) continue;
      const d = haversineM(near.lat, near.lon, r.lat, r.lon);
      if (d > maxM) continue;
      const byIdent = r.ident && String(r.ident).toUpperCase().startsWith(want);
      const byHeading = !r.ident && m && r.headingDeg != null && angDiff(r.headingDeg, (+m[1] % 36 || 36) * 10) <= 6;
      if (byIdent || byHeading) c.push({ r, d });
    }
    if (!c.length) return null;
    if (m && m[2] && c.length > 1 && !c.every((x) => x.r.ident)) {
      const h = (+m[1] % 36 || 36) * 10 * Math.PI / 180;
      const cLat = c.reduce((a, x) => a + x.r.lat, 0) / c.length, cLon = c.reduce((a, x) => a + x.r.lon, 0) / c.length;
      const cross = (x) => (x.r.lon - cLon) * 111320 * Math.cos(cLat * Math.PI / 180) * Math.cos(h) - (x.r.lat - cLat) * 110574 * Math.sin(h);
      c.sort((a, b) => cross(a) - cross(b));
      if (m[2] === 'L') return c[0].r;
      if (m[2] === 'R') return c[c.length - 1].r;
      return c[Math.floor(c.length / 2)].r;
    }
    c.sort((a, b) => a.d - b.d);
    return c[0].r;
  }
  // Median spacing of a tape's `ti` stamps -> a sample rate, for either unit (GeoFS doesn't say
  // whether ti is ms or s, so both readings are reported).
  function tapeSampleRate(tape) {
    const ti = (Array.isArray(tape) ? tape : []).map((e) => (e && finiteOrNull(e.ti))).filter((x) => x != null);
    if (ti.length < 2) return null;
    const d = [];
    for (let i = 1; i < ti.length; i++) d.push(ti[i] - ti[i - 1]);
    d.sort((a, b) => a - b);
    const med = d[Math.floor(d.length / 2)];
    return { samples: ti.length, medianDelta: med, hzIfMs: med > 0 ? 1000 / med : null, hzIfSeconds: med > 0 ? 1 / med : null,
      spanRaw: ti[ti.length - 1] - ti[0] };
  }
  // For each index of a recorder array (st/ct/ve/acc), which named live values equal it right now.
  // The caller reads the tape's newest entry and the live values in the same breath.
  function matchFieldsByValue(arr, named, maxNames) {
    const cap = maxNames || 6;
    return (Array.isArray(arr) ? arr : []).map((v, i) => {
      const x = finiteOrNull(typeof v === 'boolean' ? +v : v);
      if (x == null) return { i, value: v, matches: [] };
      const m = Object.keys(named || {}).filter((k) => Math.abs(named[k] - x) <= Math.max(1e-3, Math.abs(x) * 1e-4));
      return { i, value: x, matches: m.slice(0, cap), ambiguous: m.length > cap };
    });
  }
  // N-map bookkeeping across runs of the probe on the same page. A map is identified by its
  // container's _leaflet_id; runs are [{leafletId, connected, visible}].
  function compareMapRuns(prev, cur) {
    cur = cur || [];
    if (!prev) return { verdict: 'first run on this page: nothing to compare yet (run again with the N panel open)' };
    const pid = new Map(prev.map((m) => [m.leafletId, m]));
    const cid = new Map(cur.map((m) => [m.leafletId, m]));
    const reused = [], created = [], gone = [], shown = [], hidden = [];
    for (const [id, m] of cid) {
      const p = pid.get(id);
      if (!p) { created.push(id); continue; }
      reused.push(id);
      if (!p.visible && m.visible) shown.push(id);
      if (p.visible && !m.visible) hidden.push(id);
    }
    for (const [id, p] of pid) if (!cid.has(id) || (p.connected && !cid.get(id).connected)) gone.push(id);
    let verdict;
    if (created.length && !prev.length) verdict = 'created lazily: no map existed last run, ' + created.length + ' now';
    else if (created.length && gone.length) verdict = 'destroyed and recreated: new map instance(s) replaced the previous one(s)';
    else if (created.length) verdict = 'new map instance(s) appeared since last run (lazy creation)';
    else if (gone.length) verdict = 'destroyed: instance(s) from last run are gone or detached from the DOM';
    else if (shown.length || hidden.length) verdict = 'reused: same instance(s), visibility toggled (' + (shown.length ? 'now shown' : 'now hidden') + ')';
    else verdict = 'unchanged since last run (same instances, same visibility)';
    return { verdict, reusedLeafletIds: reused, createdLeafletIds: created, goneLeafletIds: gone, becameVisible: shown, becameHidden: hidden };
  }
  // Is a ground placement attempt a good one? samples: [{tMs, lat, lon, altM, groundContact, kias,
  // groundSpeed, haglMeters, crashed}], 100 ms apart for 5 s. target: {lat, lon, groundElevM}.
  function judgeGroundPlacement(samples, target) {
    const s = Array.isArray(samples) ? samples : [];
    const reasons = [];
    if (!s.length) return { ok: false, samples: 0, reasons: ['no samples'] };
    const settled = s.filter((x) => x.tMs >= 500);
    const gc = settled.filter((x) => x.groundContact === true).length;
    const gcKnown = settled.filter((x) => typeof x.groundContact === 'boolean').length;
    const groundContactFraction = gcKnown ? gc / gcKnown : null;
    const hagl = s.map((x) => x.haglMeters).filter((x) => typeof x === 'number' && isFinite(x));
    const settledHagl = settled.map((x) => x.haglMeters).filter((x) => typeof x === 'number' && isFinite(x));
    const dist = (x) => (x.lat != null && x.lon != null ? haversineM(target.lat, target.lon, x.lat, x.lon) : null);
    const drifts = s.map(dist).filter((x) => x != null);
    const last = s[s.length - 1], first = s[0];
    const driftOverWindowM = first.lat != null && last.lat != null ? haversineM(first.lat, first.lon, last.lat, last.lon) : null;
    let flips = 0;
    for (let i = 1; i < s.length; i++) if (s[i - 1].groundContact === true && s[i].groundContact === false) flips++;
    const bounced = flips > 0 || (settledHagl.length > 1 && Math.max(...settledHagl) - Math.min(...settledHagl) > 3);
    const sank = (hagl.length > 0 && Math.min(...hagl) < -2) ||
      (typeof target.groundElevM === 'number' && s.some((x) => typeof x.altM === 'number' && x.altM < target.groundElevM - 2));
    const exploded = s.some((x) => !!x.crashed);
    let maxVs = 0;
    for (let i = 1; i < s.length; i++) {
      const v = verticalSpeedFromAltitudes(s[i - 1].altM, s[i].altM, s[i].tMs - s[i - 1].tMs);
      if (v != null && Math.abs(v) > Math.abs(maxVs)) maxVs = v;
    }
    const gs = s.map((x) => x.groundSpeed).filter((x) => typeof x === 'number' && isFinite(x));
    const maxGroundSpeed = gs.length ? Math.max(...gs) : null;
    const kias = s.map((x) => x.kias).filter((x) => typeof x === 'number' && isFinite(x));
    if (groundContactFraction == null) reasons.push('no groundContact reading');
    else if (groundContactFraction < 0.9) reasons.push('groundContact true only ' + Math.round(groundContactFraction * 100) + '% of the settled window');
    if (bounced) reasons.push('bounced');
    if (sank) reasons.push('sank into terrain');
    if (exploded) reasons.push('crashed/exploded');
    if (driftOverWindowM != null && driftOverWindowM > GROUND_MAX_DRIFT_M) reasons.push('drifted ' + driftOverWindowM.toFixed(1) + ' m');
    if (maxGroundSpeed != null && maxGroundSpeed > GROUND_STATIONARY_MAX_MPS) reasons.push('moving: groundSpeed up to ' + maxGroundSpeed.toFixed(1));
    return {
      ok: reasons.length === 0, reasons, samples: s.length,
      groundContactFraction, bounced, sank, exploded,
      haglMin: hagl.length ? Math.min(...hagl) : null, haglMax: hagl.length ? Math.max(...hagl) : null,
      maxVerticalSpeedMps: maxVs, maxKias: kias.length ? Math.max(...kias) : null, maxGroundSpeed,
      driftFromTargetM: { first: drifts.length ? drifts[0] : null, last: drifts.length ? drifts[drifts.length - 1] : null, max: drifts.length ? Math.max(...drifts) : null },
      driftOverWindowM,
    };
  }
  // ---- EFFECTS ENGINE / aircraft swap / N-map attach helpers (pure). The browser tests below
  // collect raw samples; these turn them into verdicts so the thresholds are testable in Node.
  const MPS_PER_KT_PROBE = 0.514444;
  const EFFECT_CLAMP_DROP_MPS = 20;      // clamp |v| to (speed at start - this)
  const EFFECT_CLAMP_MS = 10000;
  const EFFECT_IMPULSE_MPS = 30;
  const EFFECT_IMPULSE_WATCH_MS = 20000;
  const EFFECT_DRAG_FACTOR = 0.995;      // per frame
  const EFFECT_DRAG_MS = 5000;
  const FIELD_WRITE_FACTOR = 1.2;
  const FIELD_BASE_MS = 1000;
  const FIELD_WRITE_MS = 5000;
  const FIELD_MAX_CANDIDATES = 10;
  const EFFECTS_MIN_HAGL_M = 1500;       // ~5,000 ft AGL
  const SWAP_WAIT_MS = 15000;
  const NMAP_TEST_MS = 10000;
  const CLAMP_SKIP_FRAMES = 3;           // the first frames still hold the pre-clamp speed
  const CLAMP_FOUGHT_SNAP_MPS = 1.5;     // mean speed above the cap at the start of a frame
  const CLAMP_JITTER_STD_MPS = 2;
  const ATTITUDE_PITCH_STD_DEG = 2;
  const ATTITUDE_ROLL_STD_DEG = 4;
  const FIELD_EFFECT_SPEED_MPS = 2;
  const FIELD_EFFECT_CLIMB_MPS = 0.7;

  const isNum = (x) => typeof x === 'number' && isFinite(x);
  function numStats(xs) {
    const a = (xs || []).filter(isNum);
    if (!a.length) return null;
    const mean = a.reduce((x, y) => x + y, 0) / a.length;
    const std = Math.sqrt(a.reduce((x, y) => x + (y - mean) * (y - mean), 0) / a.length);
    return { n: a.length, mean, std, min: Math.min(...a), max: Math.max(...a) };
  }
  function percentile(xs, p) {
    const a = (xs || []).filter(isNum).sort((x, y) => x - y);
    if (!a.length) return null;
    return a[Math.min(a.length - 1, Math.floor(p * a.length))];
  }
  function vecLen(v) {
    return Array.isArray(v) && v.length >= 3 && isNum(v[0]) && isNum(v[1]) && isNum(v[2]) ? Math.hypot(v[0], v[1], v[2]) : null;
  }
  function scaleToSpeed(v, speed) {
    const l = vecLen(v);
    if (l == null || l === 0 || !isNum(speed) || speed < 0) return null;
    const k = speed / l;
    return [v[0] * k, v[1] * k, v[2] * k];
  }
  // Clamp |v| to cap, direction preserved. {v: null} when v isn't a usable vector.
  function clampVelocity(v, cap) {
    const l = vecLen(v);
    if (l == null) return { v: null, clamped: false };
    if (l <= cap) return { v: [v[0], v[1], v[2]], clamped: false };
    return { v: scaleToSpeed(v, Math.max(0, cap)), clamped: true };
  }
  // frames: [{speed (|v| read at the START of the frame, i.e. after GeoFS's step), pitch, roll, costMs}].
  // 'fought' = GeoFS pushes speed back above the cap between frames; 'jittery' = it holds on average
  // but the speed wobbles; otherwise 'stable'.
  function judgeClamp(frames, capMps) {
    const f = (frames || []).slice(CLAMP_SKIP_FRAMES).filter((x) => x && isNum(x.speed));
    if (f.length < 10) return { verdict: 'no data', frames: f.length };
    const snaps = f.map((x) => x.speed - capMps);
    const meanSnap = numStats(snaps).mean;
    const sp = numStats(f.map((x) => x.speed));
    const pit = numStats(f.map((x) => x.pitch)), rol = numStats(f.map((x) => x.roll));
    let maxPitchStepDeg = 0;
    for (let i = 1; i < f.length; i++) if (isNum(f[i].pitch) && isNum(f[i - 1].pitch)) maxPitchStepDeg = Math.max(maxPitchStepDeg, Math.abs(f[i].pitch - f[i - 1].pitch));
    const cost = numStats(f.map((x) => x.costMs));
    return {
      verdict: meanSnap > CLAMP_FOUGHT_SNAP_MPS ? 'fought' : sp.std > CLAMP_JITTER_STD_MPS ? 'jittery' : 'stable',
      frames: f.length, capMps, meanSnapMps: meanSnap, p95SnapMps: percentile(snaps, 0.95),
      speed: sp, pitch: pit, roll: rol, maxPitchStepDeg,
      attitudeOscillation: !!((pit && pit.std > ATTITUDE_PITCH_STD_DEG) || (rol && rol.std > ATTITUDE_ROLL_STD_DEG)),
      costMs: cost ? { mean: cost.mean, max: cost.max } : null,
    };
  }
  // samples: [{tMs, speed}] from the impulse (t = 0). decayMs: first time after the peak that the
  // excess over the trimmed speed is within tol of the impulse; halfLifeMs: excess halved.
  function impulseDecay(samples, baselineMps, impulseMps, tol) {
    const s = (samples || []).filter((x) => x && isNum(x.tMs) && isNum(x.speed));
    if (!s.length || !isNum(baselineMps)) return null;
    let pk = s[0];
    for (const x of s) if (x.speed > pk.speed) pk = x;
    const excessPeak = pk.speed - baselineMps;
    const after = s.filter((x) => x.tMs >= pk.tMs);
    const within = after.find((x) => x.speed - baselineMps <= (isNum(tol) ? tol : 0.1) * impulseMps);
    const half = after.find((x) => x.speed - baselineMps <= excessPeak / 2);
    return { peakMps: pk.speed, peakAtMs: pk.tMs, excessAtPeakMps: excessPeak, decayMs: within ? within.tMs : null, halfLifeMs: half ? half.tMs : null,
      endSpeedMps: s[s.length - 1].speed };
  }
  // Least-squares slope of y over t (units of y per second), samples [{tMs, <key>}].
  function slopePerSec(samples, key) {
    const s = (samples || []).filter((x) => x && isNum(x.tMs) && isNum(x[key]));
    if (s.length < 3) return null;
    const n = s.length, mt = s.reduce((a, x) => a + x.tMs / 1000, 0) / n, my = s.reduce((a, x) => a + x[key], 0) / n;
    let num = 0, den = 0;
    for (const x of s) { num += (x.tMs / 1000 - mt) * (x[key] - my); den += (x.tMs / 1000 - mt) ** 2; }
    return den > 0 ? num / den : null;
  }
  function dragSummary(startMps, endMps, frames, factor, aborted) {
    const unopposed = startMps * Math.pow(factor, frames);
    const restored = startMps > unopposed ? (endMps - unopposed) / (startMps - unopposed) : null;
    return {
      startMps, endMps, frames, factor, unopposedEndMps: unopposed, measuredRatio: startMps ? endMps / startMps : null, fractionRestoredByGeoFS: restored,
      verdict: aborted ? 'aborted by the stall guard' : restored == null ? 'no data'
        : restored > 0.25 ? 'GeoFS opposes it: thrust/aero restores speed between frames' : 'accumulates: close to the unopposed decay',
    };
  }
  function approxEq(a, b) {
    if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => approxEq(x, b[i]));
    return isNum(a) && isNum(b) && Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));
  }
  function scaleValue(v, f) { return Array.isArray(v) ? v.map((x) => x * f) : v * f; }
  // One mass/drag/thrust write: did it take, did it stay, did it change anything?
  function classifyFieldWrite(r) {
    if (r.threw || !r.readBackOk) return { class: 'not-writable', text: 'not writable (threw, or the read-back differs at once)' };
    if (!r.stuckAtEnd) return { class: 'snaps-back', text: 'snaps back (took at first, reverted before the window ended)' };
    if (isNum(r.effectSpeedMps) && Math.abs(r.effectSpeedMps) > FIELD_EFFECT_SPEED_MPS || isNum(r.effectClimbMps) && Math.abs(r.effectClimbMps) > FIELD_EFFECT_CLIMB_MPS) {
      return { class: 'effective', text: 'sticks, measurable effect' };
    }
    return { class: 'no-effect', text: 'sticks, no measurable effect' };
  }
  // geofs aircraft catalogue -> [{id, name}], from an object keyed by id or an array of {id, name}.
  function normalizeAircraftList(container) {
    const out = [];
    if (!container || typeof container !== 'object') return out;
    if (Array.isArray(container)) {
      for (const el of container) {
        if (!el || typeof el !== 'object' || typeof el.name !== 'string') continue;
        const id = el.id !== undefined ? el.id : el.acid !== undefined ? el.acid : el.aircraftId;
        if (id !== undefined) out.push({ id: String(id), name: el.name });
      }
      return out;
    }
    for (const k of safe(() => Object.keys(container), [])) {
      const v = safe(() => container[k], undefined);
      if (v && typeof v === 'object' && typeof v.name === 'string') out.push({ id: String(k), name: v.name });
    }
    return out;
  }
  function pickCessna172(list) {
    return (list || []).find((a) => /cessna\s*172/i.test(a.name)) || (list || []).find((a) => /\b172\b/.test(a.name)) || null;
  }
  // before/after: {id, lla:[lat,lon,alt], vel:[e,n,u], groundContact}; changed by id equality.
  function judgeSwap(r) {
    const changed = String(r.idAfter) === String(r.wantedId);
    if (!changed) return { ok: false, changed, verdict: 'swap failed: aircraft id did not change' };
    const movedM = r.llaBefore && r.llaAfter ? haversineM(r.llaBefore[0], r.llaBefore[1], r.llaAfter[0], r.llaAfter[1]) : null;
    const dAlt = r.llaBefore && r.llaAfter ? r.llaAfter[2] - r.llaBefore[2] : null;
    const keptPosition = movedM != null && movedM < 500 && Math.abs(dAlt) < 100;
    const vb = vecLen(r.velBefore), va = vecLen(r.velAfter);
    const keptVelocity = vb != null && va != null ? Math.hypot(r.velAfter[0] - r.velBefore[0], r.velAfter[1] - r.velBefore[1], r.velAfter[2] - r.velBefore[2]) < 0.25 * Math.max(vb, 1) : null;
    const resetToGround = r.groundContactAfter === true && dAlt != null && dAlt < -100;
    const verdict = keptPosition && keptVelocity ? 'swapped in flight: kept position and velocity'
      : resetToGround ? 'swapped but reset to the ground'
        : 'swapped but ' + [keptPosition ? null : 'lost position (moved ' + (movedM == null ? '?' : Math.round(movedM) + ' m') + ')', keptVelocity === false ? 'lost velocity' : keptVelocity == null ? 'velocity unreadable' : null].filter(Boolean).join(' and ');
    return { ok: true, changed, movedM, dAltM: dAlt, keptPosition, keptVelocity, resetToGround, verdict };
  }
  // fires: [{via, kind:'open'|'close', panelVisibleAfter, layerPresent, domNodePresent, domNodeVisible}]
  function judgeNMapAttach(r) {
    if (r.error) return 'error: ' + r.error;
    if (r.instanceIsPanelMap === false) return 'NOT attached: geofs.api.map._map is not the N panel map';
    const opens = (r.fires || []).filter((f) => f.kind === 'open');
    if (!opens.length) return 'no open observed: press N during the test window';
    const seen = opens.some((f) => f.domNodeVisible && f.panelVisibleAfter);
    // Any open that found the layer gone counts, the first included (startMap() clears the map first).
    const survives = opens.every((f) => f.layerPresent);
    const via = Array.from(new Set(opens.map((f) => f.via))).join(' + ');
    if (!seen) return 'opens observed via ' + via + ' but the test overlay was not visible on the open panel';
    return 'attached: overlay visible on the N map; open fires via ' + via + (survives ? '; the layer survived every open' : '; the layer was DROPPED by an open (re-add it on every open)');
  }
  // The lines at the top of the report, read off the finished report object.
  function buildDashReadiness(r) {
    r = r || {};
    const maps = r.navMaps && Array.isArray(r.navMaps.instances) ? r.navMaps.instances : [];
    const mapLine = maps.length
      ? maps.map((m) => m.jsPath + ' (' + (m.visible ? 'visible' : 'hidden') + (m.hasCourseOverlay ? ', has course overlay' : '') + ')').join('; ')
      : 'no Leaflet map instance reachable' + (r.navMaps && r.navMaps.containers && r.navMaps.containers.length ? ' (but ' + r.navMaps.containers.length + ' .leaflet-container in the DOM)' : '');
    const rw = r.runways && Array.isArray(r.runways.candidates) ? r.runways.candidates.filter((c) => c.normalizedCount > 0) : [];
    const stores = r.runways && r.runways.geofsStores && r.runways.geofsStores.summary ? r.runways.geofsStores.summary : null;
    const rwLine = (rw.length ? rw.map((c) => c.path + ' (' + c.normalizedCount + ' records)').join('; ') : 'none found in memory') + (stores ? '; static: ' + stores : '');
    const g = r.groundPlacement;
    const groundLine = !g || g.status === 'not run' ? 'not run: click "Run ground placement test"' : (g.workingCall || 'none worked');
    const rec = r.recorder && r.recorder.path ? r.recorder.path + (r.recorder.recordingNow === true ? ' (recording now)' : r.recorder.recordingNow === false ? ' (not recording)' : '') : 'not found';
    const ef = r.effects, runs = ef && Array.isArray(ef.runs) ? ef.runs : [];
    const kt = (x) => (isNum(x.startSpeedKt) ? Math.round(x.startSpeedKt) + ' kt' : '? kt');
    const fw = ef && Array.isArray(ef.fieldWrites) ? ef.fieldWrites : null;
    const sw = r.aircraftSwap, cat = r.aircraftCatalog;
    return {
      nMapInstance: mapLine,
      nMapAttach: r.nMapAttach && r.nMapAttach.verdict ? r.nMapAttach.verdict : 'not run: click "Run N-map attach test"',
      runwayDataSource: rwLine,
      groundPlacementCall: groundLine,
      recorderPath: rec,
      velocityClamp: runs.length ? runs.map((x) => kt(x) + ': ' + (x.clamp && x.clamp.verdict ? x.clamp.verdict : 'no data')).join('; ') : (ef && ef.status === 'refused' ? 'refused: ' + ef.reason : 'not run: click "Run effects tests"'),
      impulseDecay: runs.length ? runs.map((x) => kt(x) + ': ' + (x.impulse && isNum(x.impulse.decayMs) ? (x.impulse.decayMs / 1000).toFixed(1) + ' s to within 10%' : 'no full decay in the window')).join('; ') : 'not run',
      dragWrite: runs.length ? runs.map((x) => kt(x) + ': ' + (x.drag && x.drag.verdict ? x.drag.verdict : 'no data')).join('; ') : 'not run',
      massDragThrustWrites: fw ? (fw.filter((x) => x.class === 'effective').map((x) => x.path + '.' + x.key).join(', ') ? fw.filter((x) => x.class === 'effective').map((x) => x.path + '.' + x.key).join(', ') + ' [effective]' : 'none had a measurable effect') + '; ' + fw.filter((x) => x.class === 'snaps-back').length + ' snap back, ' + fw.filter((x) => x.class === 'not-writable').length + ' not writable, ' + fw.filter((x) => x.class === 'no-effect').length + ' stick with no effect' : 'not run',
      aircraftSwap: sw && sw.status === 'ran' ? (sw.working ? sw.working + ': ' + (sw.verdict && sw.verdict.verdict) : 'none worked') : 'not run: click "Run aircraft swap test"',
      aircraftIds: cat && cat.count ? cat.count + ' aircraft at ' + cat.listPath : 'catalogue not found',
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

    // ---- Dash discovery (see "DASH DISCOVERY" in the top comment)
    report.navMaps = sectionOrError(buildNavMapsSection, 'nav maps');
    report.runways = sectionOrError(buildRunwaysSection, 'runway data');
    report.recorder = sectionOrError(buildRecorderSection, 'flight recorder');
    report.aircraftCatalog = sectionOrError(buildAircraftCatalog, 'aircraft catalogue');
    report.effects = window.__finsProbeEffects || { status: 'not run', how: 'Click the blue "Run effects tests" button while flying straight and level above 5,000 ft AGL.' };
    report.aircraftSwap = { status: 'not run', how: 'Click the purple "Run aircraft swap test" button while airborne.' };
    report.nMapAttach = { status: 'not run', how: 'Click the green "Run N-map attach test" button, then press N within 10 s.' };
    report.groundPlacement = { status: 'not run', how: 'Click the red "Run ground placement test" button (bottom-left). It is opt-in and moves the aircraft; it re-emits this whole report with the result.' };

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

  // ================================================================ DASH DISCOVERY (browser)
  // Read-only except runGroundPlacementTest(), which only ever runs from its button.

  // Breadth-first walk over own enumerable keys. visit(val, path, key, depth, parent) -> true stops
  // descent into val; onSeen(val, path) is told about further paths to an object already visited.
  const WALK_SKIP = /^(viewer|scene|Cesium|document|parent|top|frames|self|opener|window|globalThis|localStorage|sessionStorage|performance|navigator|location|history|caches|indexedDB|customElements|jQuery|\$)$/;
  function walkObjects(roots, visit, onSeen, budget) {
    let left = budget || 30000;
    const seen = new WeakSet();
    for (const root of roots) {
      if (!root.obj) continue;
      const queue = [{ v: root.obj, path: root.name, depth: 0 }];
      safe(() => seen.add(root.obj));
      for (let qi = 0; qi < queue.length && left > 0; qi++) {
        const { v, path, depth } = queue[qi];
        if (depth >= root.maxDepth) continue;
        for (const k of keysOf(v).slice(0, 300)) {
          if (WALK_SKIP.test(k)) continue;
          left--;
          const val = safe(() => v[k], undefined);
          if (!val || typeof val !== 'object') continue;
          if (val instanceof Node || val === window || safe(() => ArrayBuffer.isView(val), false)) continue;
          const p = path + (/^\d+$/.test(k) ? '[' + k + ']' : '.' + k);
          if (seen.has(val)) { if (onSeen) safe(() => onSeen(val, p)); continue; }
          seen.add(val);
          if (safe(() => visit(val, p, k, depth + 1, v), false)) continue;
          queue.push({ v: val, path: p, depth: depth + 1 });
        }
      }
    }
  }
  // Like safe(), but the report says what threw (these sections are new and unverified in-sim).
  function sectionOrError(fn, label) {
    try { return fn(); } catch (e) { return { error: 'error reading ' + label + ': ' + (e && e.message), stack: String(e && e.stack).split('\n').slice(0, 4).join(' | ') }; }
  }
  function walkRoots(geofsDepth, uiDepth, windowDepth) {
    return [
      { name: 'geofs', obj: safe(() => window.geofs, undefined), maxDepth: geofsDepth },
      { name: 'ui', obj: safe(() => window.ui, undefined), maxDepth: uiDepth },
      { name: 'window', obj: window, maxDepth: windowDepth },
    ];
  }
  function getByPath(path) {
    const toks = String(path).replace(/\[(\d+)\]/g, '.$1').split('.');
    let v = toks[0] === 'window' ? window : safe(() => window[toks[0]], undefined);
    for (let i = 1; i < toks.length && v != null; i++) v = safe(() => v[toks[i]], undefined);
    return v;
  }

  // ---- 1. N-panel nav map
  function isLeafletMap(v) {
    return safe(() => !!v && typeof v === 'object' && ((window.L && window.L.Map && v instanceof window.L.Map) ||
      (typeof v.addLayer === 'function' && typeof v.getCenter === 'function' && typeof v.getContainer === 'function')), false);
  }
  // Rect, computed style and ancestor visibility of a Leaflet container (or any element).
  function containerInfo(el) {
    const vw = window.innerWidth, vh = window.innerHeight;
    const info = uiRectInfo(el.getBoundingClientRect(), window.getComputedStyle(el), vw, vh);
    let hiddenBy = null;
    const chain = [];
    for (let p = el; p && p !== document.documentElement; p = p.parentElement) {
      const s = window.getComputedStyle(p);
      if (chain.length < 5) chain.push(uiSelector(p.tagName, p.id, p.className));
      if (!hiddenBy && (s.display === 'none' || s.visibility === 'hidden' || +s.opacity === 0)) hiddenBy = uiSelector(p.tagName, p.id, p.className);
    }
    const onScreen = info.x < vw && info.y < vh && info.x + info.w > 0 && info.y + info.h > 0;
    return {
      selector: uiSelector(el.tagName, el.id, el.className), id: el.id || null,
      className: typeof el.className === 'string' ? el.className.slice(0, 200) : null,
      leafletId: el._leaflet_id === undefined ? null : el._leaflet_id,
      connected: !!el.isConnected, rect: { x: info.x, y: info.y, w: info.w, h: info.h },
      position: info.position, zIndex: info.zIndex, hiddenBy, onScreen,
      visible: !!(el.isConnected && info.shown && !hiddenBy && onScreen),
      ancestors: chain,
    };
  }
  function describeMap(map, paths) {
    const c = safe(() => (typeof map.getContainer === 'function' ? map.getContainer() : map._container), null);
    let layers = 0, overlay = 0;
    safe(() => map.eachLayer((ly) => {
      layers++;
      const tip = safe(() => (typeof ly.getTooltip === 'function' ? ly.getTooltip() : null), null);
      if ((ly.options && ly.options.color === '#ff8a3d') || (tip && tip.options && tip.options.className === 'fr-map-gate')) overlay++;
    }));
    const domGates = c ? safe(() => c.querySelectorAll('.fr-map-gate').length, 0) : 0;
    const ci = c ? safe(() => containerInfo(c), null) : null;
    return {
      jsPath: paths[0] || '(not reachable from geofs/ui/window within the walk budget)', otherPaths: paths.slice(1, 6),
      mapLeafletId: safe(() => map._leaflet_id, null), container: ci, visible: ci ? ci.visible : false,
      size: safe(() => { const s = map.getSize(); return { x: s.x, y: s.y }; }, null),
      zoom: safe(() => map.getZoom(), null),
      center: safe(() => { const c2 = map.getCenter(); return [+c2.lat.toFixed(5), +c2.lng.toFixed(5)]; }, null),
      layerCount: layers, courseOverlayLayers: overlay, courseOverlayGateLabelsInDom: domGates,
      hasCourseOverlay: overlay > 0 || domGates > 0,
    };
  }
  // The same resolution order as race.js G.leafletMap(), re-run here so the report says which
  // instance the race overlay would pick (and so whether it's the N panel's).
  function raceResolverPick() {
    const gm = safe(() => window.geofs.map, undefined);
    if (isLeafletMap(gm)) return { via: 'geofs.map', map: gm };
    for (const k of keysOf(gm)) { const v = safe(() => gm[k], undefined); if (isLeafletMap(v)) return { via: 'geofs.map.' + k, map: v }; }
    const container = safe(() => document.querySelector('.geofs-map-viewport') || document.querySelector('.leaflet-container'), null);
    if (container && container._leaflet_id) {
      for (const [name, src] of [['geofs', safe(() => window.geofs, undefined)], ['ui', safe(() => window.ui, undefined)], ['window', window]]) {
        for (const k of keysOf(src)) { const v = safe(() => src[k], undefined); if (isLeafletMap(v) && v._container === container) return { via: name + '.' + k + ' (DOM container match)', map: v }; }
      }
    }
    return { via: null, map: null, firstContainer: container ? uiSelector(container.tagName, container.id, container.className) : null };
  }
  const MAP_FN_RE = /(map|nav).*(toggle|open|close|show|hide|init|create|start|destroy|remove)|(toggle|open|close|show|hide|init|create|start|destroy).*(map|nav)/i;
  function mapFunctionCandidates() {
    const out = [];
    const add = (path, fn) => {
      if (out.length >= 30 || typeof fn !== 'function') return;
      out.push({ path, arity: fn.length, src: safe(() => Function.prototype.toString.call(fn).replace(/\s+/g, ' ').slice(0, 240), '[unreadable]') });
    };
    const scan = (name, obj) => {
      if (!obj || (typeof obj !== 'object' && typeof obj !== 'function')) return;
      for (const k of keysOf(obj)) { const v = safe(() => obj[k], undefined); if (typeof v === 'function' && MAP_FN_RE.test(k)) add(name + '.' + k, v); }
      const proto = safe(() => Object.getPrototypeOf(obj), null);
      if (proto && proto !== Object.prototype && proto !== Function.prototype) {
        for (const k of safe(() => Object.getOwnPropertyNames(proto), [])) if (MAP_FN_RE.test(k)) add(name + '(proto).' + k, safe(() => obj[k], undefined));
      }
    };
    scan('geofs', safe(() => window.geofs, undefined));
    scan('ui', safe(() => window.ui, undefined));
    for (const [name, root] of [['geofs', safe(() => window.geofs, undefined)], ['ui', safe(() => window.ui, undefined)]]) {
      for (const k of keysOf(root)) {
        const v = safe(() => root[k], undefined);
        if (v && typeof v === 'object' && /map|nav/i.test(k)) scan(name + '.' + k, v);
      }
    }
    return out;
  }
  // Key bindings: anything under the keyboard-preference objects mentioning N / keycode 78 / map / nav.
  function mapKeyBindings() {
    const out = [];
    const scan = (obj, path, depth) => {
      if (!obj || typeof obj !== 'object' || depth > 4 || out.length >= 30) return;
      for (const k of keysOf(obj).slice(0, 80)) {
        const v = safe(() => obj[k], undefined);
        const p = path + '.' + k;
        if (v && typeof v === 'object') { if (/map|nav/i.test(k)) out.push({ path: p, value: summarize(v, 2, new Set()) }); else scan(v, p, depth + 1); continue; }
        if (typeof v === 'function') continue;
        if (/map|nav/i.test(k) || /map|nav/i.test(String(v)) || v === 78 || (typeof v === 'string' && /^n$/i.test(v))) out.push({ path: p, value: v });
      }
    };
    scan(safe(() => window.geofs.preferences.keyboard, undefined), 'geofs.preferences.keyboard', 0);
    scan(safe(() => window.geofs.keyboard, undefined), 'geofs.keyboard', 0);
    scan(safe(() => window.ui.keyboard, undefined), 'ui.keyboard', 0);
    return out;
  }
  function domMapControls() {
    const rows = [];
    for (const el of safe(() => Array.from(document.querySelectorAll('[id*="map" i], [class*="map" i], [id*="nav" i]')), [])) {
      if (rows.length >= 25) break;
      if (el.closest('[id^="fr-"], .leaflet-container') && !el.classList.contains('leaflet-container')) continue;
      if (el.closest && el.closest('.leaflet-container') && el !== el.closest('.leaflet-container')) continue;
      const ci = safe(() => containerInfo(el), null);
      rows.push({ selector: uiSelector(el.tagName, el.id, el.className), visible: ci ? ci.visible : null, rect: ci ? ci.rect : null,
        onclick: (el.getAttribute('onclick') || '').slice(0, 120) || null, title: el.getAttribute('title') || null });
    }
    return rows;
  }
  function ensureMapWatch() {
    if (window.__finsProbeMapWatch) return window.__finsProbeMapWatch;
    const w = { t0: Date.now(), events: [], last: new Map(), history: [], timer: null };
    window.__finsProbeMapWatch = w;
    const push = (e) => { w.events.push({ tMs: Date.now() - w.t0, ...e }); if (w.events.length > 200) w.events.shift(); };
    const snap = (first) => {
      safe(() => {
        for (const el of Array.from(document.querySelectorAll('.leaflet-container'))) {
          const ci = containerInfo(el), prev = w.last.get(el);
          if (!prev) push({ type: first ? 'present-at-probe-start' : 'container-appeared', leafletId: ci.leafletId, selector: ci.selector, visible: ci.visible });
          else if (prev.visible !== ci.visible) push({ type: ci.visible ? 'shown' : 'hidden', leafletId: ci.leafletId, selector: ci.selector });
          w.last.set(el, { visible: ci.visible, leafletId: ci.leafletId, selector: ci.selector });
        }
        for (const [el, p] of Array.from(w.last.entries())) if (!el.isConnected) { push({ type: 'container-removed', leafletId: p.leafletId, selector: p.selector }); w.last.delete(el); }
      });
    };
    snap(true);
    w.timer = setInterval(() => snap(false), 500);
    // Passive: only timestamps the N key so a 'shown'/'container-appeared' event can be lined up with it.
    window.addEventListener('keydown', (e) => { if (!e.altKey && !e.ctrlKey && (e.key === 'n' || e.key === 'N')) push({ type: 'keydown N' }); }, true);
    return w;
  }
  function buildNavMapsSection() {
    const watch = ensureMapWatch();
    const found = new Map();   // map object -> [paths]
    walkObjects(walkRoots(4, 4, 2), (val, p) => {
      if (isLeafletMap(val)) { found.set(val, [p]); return true; }
      return false;
    }, (val, p) => { if (found.has(val)) found.get(val).push(p); }, 40000);
    const instances = Array.from(found.entries()).map(([m, paths]) => describeMap(m, paths));
    const instContainers = new Set(Array.from(found.keys()).map((m) => safe(() => m.getContainer(), null)));
    const containers = Array.from(document.querySelectorAll('.leaflet-container')).map((el) => ({
      ...containerInfo(el), mapReachable: instContainers.has(el),
    }));
    const pick = raceResolverPick();
    const prev = watch.history.length ? watch.history[watch.history.length - 1] : null;
    const cur = containers.map((c) => ({ leafletId: c.leafletId, connected: c.connected, visible: c.visible }));
    const cmp = compareMapRuns(prev ? prev.containers : null, cur);
    watch.history.push({ at: Date.now(), containers: cur });
    return {
      howToRead: 'Run this probe twice: once BEFORE pressing N, once WITH the N panel open. The second run\'s lifecycle.comparedToPreviousRun says whether the N map is created lazily, destroyed on close, or reused.',
      runNumberOnThisPage: watch.history.length,
      leaflet: { hasL: typeof window.L !== 'undefined', version: safe(() => window.L.version, null) },
      instances,
      containers,
      raceOverlay: {
        resolverWouldPick: pick.via ? { via: pick.via, mapLeafletId: safe(() => pick.map._leaflet_id, null), container: safe(() => uiSelector(pick.map._container.tagName, pick.map._container.id, pick.map._container.className), null),
          visible: safe(() => containerInfo(pick.map._container).visible, null) } : { via: null, firstContainer: pick.firstContainer },
        attachedTo: instances.filter((i) => i.hasCourseOverlay).map((i) => ({ jsPath: i.jsPath, mapLeafletId: i.mapLeafletId, visible: i.visible, layers: i.courseOverlayLayers, gateLabelsInDom: i.courseOverlayGateLabelsInDom })),
        note: 'attachedTo is empty if no course is loaded, or the overlay is on a map this walk cannot reach. Load a course (Race panel) before running for this to mean anything.',
      },
      lifecycle: {
        watchStartedMsAgo: Date.now() - watch.t0,
        events: watch.events.slice(-40),
        comparedToPreviousRun: cmp,
      },
      panelHooks: { functions: mapFunctionCandidates(), keyBindings: mapKeyBindings(), domControls: domMapControls() },
    };
  }

  // ---- 2. airport / runway data
  const RUNWAY_KEY_RE = /runway|rwy|airport|apt|icao|aerodrome/i;
  function describeRunwayCandidate(path, val) {
    const isMap = typeof Map !== 'undefined' && val instanceof Map;
    const count = Array.isArray(val) ? val.length : isMap ? val.size : keysOf(val).length;
    const first = Array.isArray(val) ? val[0] : isMap ? Array.from(val.values())[0] : safe(() => val[keysOf(val)[0]], undefined);
    const flat = flattenRunwayRecords(val, 300000);
    return {
      path, type: Array.isArray(val) ? 'array' : isMap ? 'Map' : safe(() => (val.constructor && val.constructor.name) || 'object', 'object'),
      count, sampleKeys: Array.isArray(val) || isMap ? undefined : keysOf(val).slice(0, 8),
      firstRecord: summarize(first, 2, new Set()), normalizedCount: flat.length, flat,
    };
  }
  // GeoFS keeps airports/runways in three places (2026-10-02 probe): geofs.runways (nearRunways: full
  // records, only for runways near the aircraft), geofs.mainAirportList (icao -> [lat, lon]) and
  // geofs.majorRunwayGrid (a bucketed grid of 6-number runway arrays from data/runwaygrid.js).
  // Reports shapes, plus raw grid records near KPDX/KSEA so the 6 fields can be decoded by eye.
  function buildGeofsRunwayStores() {
    const gf = window.geofs, out = {};
    const rn = gf && gf.runways;
    if (rn) {
      out.runways = { scalars: {}, functions: [] };
      for (const k of keysOf(rn).slice(0, 80)) {
        const v = safe(() => rn[k], undefined);
        if (v == null) continue;
        if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') out.runways.scalars[k] = v;
        else if (typeof v === 'function' && /load|refresh|update|get|near|create|find|clear|remove/i.test(k) && out.runways.functions.length < 12) {
          out.runways.functions.push({ name: k, arity: v.length, src: safe(() => Function.prototype.toString.call(v).replace(/\s+/g, ' ').slice(0, 300), '[unreadable]') });
        } else if (typeof v === 'object') out.runways.scalars[k] = (Array.isArray(v) ? 'array(' : 'object(') + keysOf(v).length + ')';
      }
    }
    const al = gf && gf.mainAirportList;
    if (al && typeof al === 'object') {
      const ks = keysOf(al);
      out.mainAirportList = { count: ks.length, KPDX: safe(() => al.KPDX, null), KSEA: safe(() => al.KSEA, null), sample: ks.slice(0, 3).map((k) => [k, al[k]]) };
    }
    const grid = gf && gf.majorRunwayGrid;
    if (grid && typeof grid === 'object') {
      const g = { outerKeys: keysOf(grid).length, cells: 0, records: 0, firstCells: [], nearKPDX: [], nearKSEA: [] };
      const near = (a, b, pt) => (Math.abs(a - pt.lat) < 0.1 && Math.abs(b - pt.lon) < 0.1) || (Math.abs(b - pt.lat) < 0.1 && Math.abs(a - pt.lon) < 0.1);
      for (const a of keysOf(grid)) {
        const inner = safe(() => grid[a], null);
        for (const b of keysOf(inner)) {
          const arr = safe(() => inner[b], null);
          if (!Array.isArray(arr)) continue;
          g.cells++; g.records += arr.length;
          if (g.firstCells.length < 2) g.firstCells.push({ outer: a, inner: b, records: arr.slice(0, 2) });
          for (const rec of arr) {
            if (!Array.isArray(rec)) continue;
            const hit = {};
            for (let i = 0; i + 1 < rec.length; i++) {
              for (const [name, pt] of [['nearKPDX', KPDX], ['nearKSEA', KSEA]]) {
                if (!hit[name] && g[name].length < 6 && typeof rec[i] === 'number' && typeof rec[i + 1] === 'number' && near(rec[i], rec[i + 1], pt)) { hit[name] = true; g[name].push({ outer: a, inner: b, pairAtIndex: i, record: rec }); }
              }
            }
          }
        }
      }
      out.majorRunwayGrid = g;
    }
    const nv = gf && gf.nav && gf.nav.navaids;
    if (Array.isArray(nv)) {
      const hist = {};
      for (let i = 0; i < Math.min(nv.length, 150000); i++) { const t = nv[i] && nv[i].type; if (t !== undefined) hist[t] = (hist[t] || 0) + 1; }
      out.navaids = { count: nv.length, first: summarize(nv[0], 2, new Set()), typeHistogram: Object.entries(hist).sort((x, y) => y[1] - x[1]).slice(0, 12) };
    }
    out.summary = [
      out.mainAirportList ? 'geofs.mainAirportList (' + out.mainAirportList.count + ' airports: icao -> [lat, lon])' : null,
      out.majorRunwayGrid ? 'geofs.majorRunwayGrid (' + out.majorRunwayGrid.records + ' runway arrays in ' + out.majorRunwayGrid.cells + ' cells)' : null,
      out.runways ? 'geofs.runways.nearRunways (full records, loaded per area around the aircraft)' : null,
    ].filter(Boolean).join('; ');
    return out;
  }
  function buildRunwaysSection() {
    const cands = [];
    walkObjects(walkRoots(3, 2, 1), (val, p, k) => {
      if (cands.length < 25 && RUNWAY_KEY_RE.test(k)) { cands.push(describeRunwayCandidate(p, val)); return true; }
      return false;
    }, null, 40000);
    const hist = window.__finsProbeRunwayHistory || (window.__finsProbeRunwayHistory = {});
    const lla = safe(() => window.geofs.aircraft.instance.llaLocation, null);
    const out = {
      note: 'Runways may load per area: if counts below change between runs after you move far (teleport to another airport), they are tile/area loaded. recentRequests shows what the page itself fetched.',
      aircraftAt: lla ? [+lla[0].toFixed(5), +lla[1].toFixed(5)] : null,
      candidates: cands.map((c) => {
        const { flat, ...rest } = c;
        const prev = hist[c.path];
        hist[c.path] = c.normalizedCount;
        return {
          ...rest, previousRunCount: prev === undefined ? null : prev,
          nearKPDX: nearestRunways(flat, KPDX.lat, KPDX.lon, 3), nearKSEA: nearestRunways(flat, KSEA.lat, KSEA.lon, 3),
          nearAircraft: lla ? nearestRunways(flat, lla[0], lla[1], 3) : null,
        };
      }),
    };
    out.geofsStores = sectionOrError(buildGeofsRunwayStores, 'geofs runway stores');
    out.geofsNav = safe(() => {
      const nav = window.geofs.nav;
      if (!nav) return null;
      const keys = {};
      for (const k of keysOf(nav).slice(0, 40)) {
        const v = safe(() => nav[k], undefined);
        keys[k] = Array.isArray(v) ? 'array(' + v.length + ')' : v && typeof v === 'object' ? 'object(' + keysOf(v).length + ' keys)' : typeof v;
      }
      return keys;
    }, '[error reading geofs.nav]');
    out.recentRequests = safe(() => {
      const res = performance.getEntriesByType('resource');
      const hit = res.filter((e) => /runway|airport|apt|nav|aero|icao/i.test(e.name));
      const hosts = {};
      for (const e of res) if (/xmlhttprequest|fetch/.test(e.initiatorType)) { const h = e.name.replace(/^(https?:\/\/[^/]+\/[^/?]*).*/, '$1'); hosts[h] = (hosts[h] || 0) + 1; }
      return {
        totalResources: res.length, matching: hit.length,
        matchingSample: hit.slice(0, 15).map((e) => ({ url: e.name.slice(0, 160), startMs: Math.round(e.startTime), type: e.initiatorType })),
        xhrFetchPrefixes: Object.entries(hosts).sort((a, b) => b[1] - a[1]).slice(0, 12),
      };
    }, '[error reading resource timing]');
    // The flat list is kept (unserialized) for the ground test's runway lookup.
    window.__finsProbeRunways = cands.reduce((a, c) => (c.flat.length > a.length ? c.flat : a), []);
    return out;
  }

  // ---- 4. flight recorder
  function collectNumbers(obj, prefix, named, depth) {
    if (!obj || typeof obj !== 'object' || named.__n > 600) return;
    for (const k of keysOf(obj).slice(0, 150)) {
      const v = safe(() => obj[k], undefined);
      if (typeof v === 'number' && isFinite(v)) { named[prefix + k] = v; named.__n++; }
      else if (typeof v === 'boolean') { named[prefix + k] = +v; named.__n++; }
      else if (Array.isArray(v) && v.length <= 6 && v.every((x) => typeof x === 'number')) v.forEach((x, i) => { if (isFinite(x)) { named[prefix + k + '[' + i + ']'] = x; named.__n++; } });
      else if (v && typeof v === 'object' && depth > 0 && !(v instanceof Node)) collectNumbers(v, prefix + k + '.', named, depth - 1);
    }
  }
  function liveNamedValues() {
    const named = { __n: 0 };
    const inst = safe(() => window.geofs.aircraft.instance, undefined);
    collectNumbers(safe(() => window.geofs.animation.values, undefined), 'animation.values.', named, 0);
    collectNumbers(inst, 'instance.', named, 0);
    collectNumbers(safe(() => inst.rigidBody, undefined), 'instance.rigidBody.', named, 0);
    collectNumbers(safe(() => window.geofs.controls, undefined), 'geofs.controls.', named, 0);
    delete named.__n;
    return named;
  }
  function findRecorder() {
    const cands = [];
    walkObjects(walkRoots(4, 3, 2), (val, p, k, d, parent) => {
      // A tape is recognised by name OR by shape: an array of {ti, co, ...} (GeoFS's export format).
      const tapeLike = Array.isArray(val) && val.length > 0 && !!val[0] && typeof val[0] === 'object' && !Array.isArray(val[0]) && 'ti' in val[0] && 'co' in val[0];
      if (cands.length < 30 && (/record|tape|replay/i.test(k) || tapeLike)) {
        cands.push({ path: p, key: k, isTapeArray: Array.isArray(val) && (/tape/i.test(k) || tapeLike), parent: p.slice(0, Math.max(0, p.lastIndexOf('.'))), val });
      }
      return false;
    }, null, 40000);
    const tape = cands.find((c) => c.isTapeArray);
    return { cands, tape };
  }
  // When no tape object is reachable (the recorder may only exist while recording, or live in a
  // closure), the functions and buttons that start/stop recording name the object that owns it.
  function recordHunt() {
    const RE = /record|tape|replay/i;
    const fns = [];
    const add = (path, fn) => { if (fns.length < 25 && typeof fn === 'function') fns.push({ path, arity: fn.length, src: safe(() => Function.prototype.toString.call(fn).replace(/\s+/g, ' ').slice(0, 300), '[unreadable]') }); };
    for (const [name, root] of [['geofs', safe(() => window.geofs, undefined)], ['ui', safe(() => window.ui, undefined)], ['window', window]]) {
      for (const k of keysOf(root)) {
        const v = safe(() => root[k], undefined);
        if (typeof v === 'function' && RE.test(k)) add(name + '.' + k, v);
        else if (v && typeof v === 'object' && RE.test(k) && !(v instanceof Node) && v !== window) for (const k2 of keysOf(v)) { const f = safe(() => v[k2], undefined); if (typeof f === 'function') add(name + '.' + k + '.' + k2, f); }
      }
    }
    const dom = [];
    for (const el of safe(() => Array.from(document.querySelectorAll('[id*="record" i], [class*="record" i], [onclick*="record" i], [data-action*="record" i]')), [])) {
      if (dom.length >= 15 || (el.closest && el.closest('[id^="fr-"]'))) continue;
      dom.push({ selector: uiSelector(el.tagName, el.id, el.className), onclick: (el.getAttribute('onclick') || '').slice(0, 160) || null, text: (el.textContent || '').trim().slice(0, 40) || null });
    }
    const rec = { aircraftRecord: safe(() => summarize(window.geofs.aircraft.instance.aircraftRecord, 2, new Set()), null), userRecord: safe(() => summarize(window.geofs.userRecord, 2, new Set()), null) };
    return { functions: fns, domControls: dom, records: rec };
  }
  function buildRecorderSection() {
    const { cands, tape } = findRecorder();
    const out = {
      candidates: cands.map((c) => ({ path: c.path, type: Array.isArray(c.val) ? 'array(' + c.val.length + ')' : safe(() => (c.val.constructor && c.val.constructor.name) || 'object', 'object') })),
      path: null,
      hunt: sectionOrError(recordHunt, 'recorder hunt'),
    };
    if (!tape) { out.note = 'No array named like "tape" found under geofs/ui/window. Start a recording in GeoFS (record button) and run the probe again.'; return out; }
    const recPath = tape.parent, rec = getByPath(recPath);
    out.path = recPath; out.tapePath = tape.path;
    out.ownKeys = {};
    for (const k of keysOf(rec).slice(0, 40)) { const v = safe(() => rec[k], undefined); out.ownKeys[k] = Array.isArray(v) ? 'array(' + v.length + ')' : typeof v; }
    out.booleans = {};
    for (const k of keysOf(rec)) { const v = safe(() => rec[k], undefined); if (typeof v === 'boolean') out.booleans[k] = v; }
    out.functions = keysOf(rec).filter((k) => typeof safe(() => rec[k], undefined) === 'function').slice(0, 30)
      .concat(safe(() => Object.getOwnPropertyNames(Object.getPrototypeOf(rec)).filter((k) => k !== 'constructor' && typeof rec[k] === 'function'), []).slice(0, 30));
    const t = tape.val;
    out.tapeLength = t.length;
    out.entryKeys = t.length ? keysOf(t[0]) : [];
    out.arrayLengths = t.length ? Object.fromEntries(['co', 'ct', 'st', 've', 'acc'].map((k) => [k, Array.isArray(t[0][k]) ? t[0][k].length : null])) : null;
    out.firstEntries = summarize(t.slice(0, 2), 1, new Set());
    out.lastEntries = summarize(t.slice(-2), 1, new Set());
    out.sampleRate = tapeSampleRate(t.slice(-200));
    if (t.length) {
      const named = liveNamedValues();
      const last = t[t.length - 1];
      out.liveFieldMatches = {
        note: 'Which live GeoFS values equal each array slot of the NEWEST tape entry right now. Values of 0/1 match many names: confirm by running again in a different state (gear down/up, flaps, on ground / airborne).',
        co: matchFieldsByValue(last.co, named), ct: matchFieldsByValue(last.ct, named), st: matchFieldsByValue(last.st, named),
        ve: matchFieldsByValue(last.ve, named), acc: matchFieldsByValue(last.acc, named),
      };
      const gc = safe(() => window.geofs.aircraft.instance.groundContact, undefined);
      out.st0VsGroundContact = { st0: safe(() => last.st[0], null), groundContact: gc === undefined ? null : gc, agrees: Array.isArray(last.st) && typeof gc === 'boolean' ? !!last.st[0] === gc : null };
    } else out.note = 'The tape is empty: the recorder exists but holds no samples. Start a recording and run again for field meanings.';
    return out;
  }
  // Is it recording right now? The only reliable answer: does the tape grow over ~700 ms.
  function sampleRecorderGrowth(recorder) {
    if (!recorder || !recorder.tapePath) return Promise.resolve(null);
    const read = () => { const t = getByPath(recorder.tapePath); return Array.isArray(t) ? { n: t.length, ti: safe(() => t[t.length - 1].ti, null) } : null; };
    const a = read(), t0 = Date.now();
    return new Promise((resolve) => setTimeout(() => {
      const b = read(), dt = Date.now() - t0;
      if (!a || !b) return resolve(null);
      resolve({ lengthBefore: a.n, lengthAfter: b.n, windowMs: dt, recordingNow: b.n > a.n || (b.ti !== a.ti && b.ti != null), measuredHz: b.n > a.n ? +((b.n - a.n) / (dt / 1000)).toFixed(2) : null });
    }, 700));
  }

  // ---- 3. ground placement (the one opt-in write)
  const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
  function groundSample(t0) {
    const s = landingSnapshot();
    return {
      tMs: Math.round(performance.now() - t0), lat: s.lat, lon: s.lon, altM: s.altM, groundContact: typeof s.groundContact === 'boolean' ? s.groundContact : null,
      kias: s.kias, groundSpeed: s.groundSpeed, haglMeters: safe(() => { const v = window.geofs.animation.values.haglMeters; return typeof v === 'number' && isFinite(v) ? v : null; }, null),
      climbrate: s.climbrate, crashed: s.crashed === true || (typeof s.crashed === 'number' && s.crashed > 0),
    };
  }
  function oneEvery(samples, ms) {
    const out = [];
    let nextAt = 0;
    for (const s of samples) if (s.tMs >= nextAt) { out.push(s); nextAt += ms; }
    return out;
  }
  async function groundElevation(lat, lon) {
    const fallback = GROUND_TEST_FALLBACK.ground;
    try {
      const viewer = window.geofs.api.viewer;
      const carto = window.Cesium.Cartographic.fromDegrees(lon, lat);
      const res = await Promise.race([window.Cesium.sampleTerrainMostDetailed(viewer.terrainProvider, [carto]), sleepMs(8000).then(() => null)]);
      const h = res && res[0] && res[0].height;
      if (typeof h === 'number' && isFinite(h)) return { m: h, source: 'Cesium.sampleTerrainMostDetailed' };
    } catch (_) { /* fall through */ }
    const g = safe(() => window.geofs.api.viewer.scene.globe.getHeight(window.Cesium.Cartographic.fromDegrees(lon, lat)), undefined);
    if (typeof g === 'number' && isFinite(g)) return { m: g, source: 'globe.getHeight' };
    return { m: fallback, source: 'hardcoded KPDX field elevation (terrain unreadable)' };
  }
  async function waitUnpaused(maxMs) {
    const t0 = Date.now();
    await sleepMs(80);
    while (safe(() => window.geofs.isPaused(), false) && Date.now() - t0 < maxMs) await sleepMs(100);
    return { paused: safe(() => window.geofs.isPaused(), false), waitedMs: Date.now() - t0 };
  }
  async function runGroundPlacementTest(setStatus) {
    const result = { status: 'ran', startedAt: new Date().toISOString() };
    const inst = safe(() => window.geofs.aircraft.instance, undefined);
    const lla0 = safe(() => inst.llaLocation.slice(0, 3), null);
    result.aircraftBefore = lla0 ? { lat: lla0[0], lon: lla0[1], altM: lla0[2], aircraftId: safe(() => inst.id, null) } : null;
    // Target: KPDX 10R from whatever runway data the walk found, else the supplied fallback. geofs.runways
    // only holds runways near the aircraft, so 10R is found only when the test starts near KPDX.
    // GeoFS runway headings can be negative; headingDeg is normalized.
    const found = findRunway(window.__finsProbeRunways, 'KPDX', '10R', KPDX, 6000);
    const target = found && found.headingDeg != null
      ? { lat: found.lat, lon: found.lon, hdg: found.headingDeg, source: 'geofs.runways record (' + (found.icao || '?') + ' ' + (found.ident || 'heading ' + found.headingDeg) + ', threshold = its location)' }
      : { lat: GROUND_TEST_FALLBACK.lat, lon: GROUND_TEST_FALLBACK.lon, hdg: GROUND_TEST_FALLBACK.hdg, source: found ? 'runway data had no heading: fallback used' : 'fallback constants (10R not in the area-loaded runway data)' };
    const elev = await groundElevation(target.lat, target.lon);
    target.groundElevM = elev.m; target.groundElevSource = elev.source;
    result.target = target;
    result.flyToSource = safe(() => Function.prototype.toString.call(window.geofs.flyTo).replace(/\s+/g, ' ').slice(0, 1500), null);
    const ll = [target.lat, target.lon, target.groundElevM];
    const zeroV = () => { const b = safe(() => window.geofs.aircraft.instance.rigidBody, null); if (!b || typeof b.setLinearVelocity !== 'function') throw new Error('no rigidBody.setLinearVelocity'); b.setLinearVelocity([0, 0, 0]); };
    const attempts = [
      { id: 'place', call: 'geofs.aircraft.instance.place([lat,lon,groundElevM],[hdg,0,0]) + rigidBody.setLinearVelocity([0,0,0])',
        run: () => { window.geofs.aircraft.instance.place(ll, [target.hdg, 0, 0]); zeroV(); }, flies: false },
      { id: 'flyTo-true', call: 'geofs.flyTo([lat,lon,groundElevM,hdg,true]) + setLinearVelocity([0,0,0])',
        run: () => { window.geofs.flyTo([...ll, target.hdg, true]); }, flies: true },
      { id: 'flyTo-noflag', call: 'geofs.flyTo([lat,lon,groundElevM,hdg]) + setLinearVelocity([0,0,0])',
        run: () => { window.geofs.flyTo([...ll, target.hdg]); }, flies: true },
      { id: 'flyTo-false', call: 'geofs.flyTo([lat,lon,groundElevM,hdg,false]) + setLinearVelocity([0,0,0])',
        run: () => { window.geofs.flyTo([...ll, target.hdg, false]); }, flies: true },
    ];
    result.attempts = [];
    result.workingCall = null;
    for (const a of attempts) {
      const rec = { id: a.id, call: a.call };
      result.attempts.push(rec);
      try {
        setStatus('ground test: ' + a.id + '…');
        a.run();
        if (a.flies) {
          rec.pause = await waitUnpaused(15000);
          if (rec.pause.paused) { rec.error = 'sim stayed paused 15 s after flyTo (press P to unpause, then rerun)'; continue; }
          await sleepMs(50);
          zeroV();
        }
      } catch (e) { rec.error = String(e && e.message); continue; }
      const t0 = performance.now(), samples = [];
      while (performance.now() - t0 < GROUND_SAMPLE_DURATION_MS) { samples.push(groundSample(t0)); await sleepMs(GROUND_SAMPLE_MS); }
      rec.verdict = judgeGroundPlacement(samples, target);
      rec.samplesEverySecond = oneEvery(samples, 1000);
      if (rec.verdict.ok) { result.workingCall = a.call; break; }
    }
    if (!result.workingCall) result.note = 'none worked: see each attempt\'s verdict.reasons. The aircraft was left wherever the last attempt put it (aircraftBefore has where you were).';
    result.finishedAt = new Date().toISOString();
    return result;
  }
  // ================================================================ EFFECTS ENGINE tests (opt-in writes)
  // These write to the aircraft (velocity, and in test 4 mass/drag/thrust fields) from probe.js only,
  // each behind its own button, to find out what a game-effects layer could rely on. race.js is not
  // involved. window.__finsProbeTimeScale (default 1) shortens every wait; the JSDOM smoke test uses it.
  const T = (ms) => ms * (+window.__finsProbeTimeScale || 1);
  const sleepT = (ms) => sleepMs(T(ms));
  const rbody = () => safe(() => window.geofs.aircraft.instance.rigidBody, undefined);
  function readVel() {
    const v = safe(() => rbody().v_linearVelocity, null);
    return v && v.length >= 3 && isNum(+v[0]) && isNum(+v[1]) && isNum(+v[2]) ? [+v[0], +v[1], +v[2]] : null;
  }
  function writeVel(v) {
    const b = rbody();
    if (!b || typeof b.setLinearVelocity !== 'function') throw new Error('no rigidBody.setLinearVelocity');
    b.setLinearVelocity([v[0], v[1], v[2]]);
  }
  const curSpeed = () => vecLen(readVel());
  const curAlt = () => safe(() => window.geofs.aircraft.instance.llaLocation[2], null);
  const attitude = () => safe(() => { const av = window.geofs.animation.values; return { pitch: av.pitch, roll: av.roll, heading: av.heading360 }; }, {});
  // rAF loop for durationMs (scaled); step(tMs, dtMs) returns false to stop early.
  function frameLoop(durationMs, step) {
    return new Promise((resolve) => {
      const t0 = performance.now();
      let last = t0;
      const tick = () => {
        const now = performance.now(), t = now - t0, dt = now - last;
        last = now;
        let go = true;
        try { go = step(t, dt) !== false; } catch (e) { return resolve({ error: String(e && e.message), endedAtMs: t }); }
        if (!go || t >= T(durationMs)) return resolve({ endedAtMs: t, aborted: !go });
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }
  // Timer-based sampler (alt + speed) for durationMs; used where a per-frame hook isn't needed.
  async function sampleSpeed(durationMs, intervalMs) {
    const out = [], t0 = performance.now();
    while (performance.now() - t0 < T(durationMs)) { out.push({ tMs: Math.round(performance.now() - t0), speed: curSpeed(), alt: curAlt() }); await sleepMs(intervalMs); }
    return out;
  }
  async function waitForSpeed(target, tolMps, maxMs) {
    const t0 = performance.now();
    while (performance.now() - t0 < T(maxMs)) { const s = curSpeed(); if (s != null && Math.abs(s - target) <= tolMps) return { recovered: true, waitedMs: Math.round(performance.now() - t0) }; await sleepMs(100); }
    return { recovered: false, waitedMs: Math.round(performance.now() - t0), speedNow: curSpeed() };
  }
  const everySecond = (samples, key) => oneEvery(samples, 1000).map((x) => ({ tMs: x.tMs, [key || 'speed']: x[key || 'speed'] == null ? null : +x[key || 'speed'].toFixed(2) }));

  async function effectClamp() {
    const v0 = readVel();
    if (!v0) throw new Error('rigidBody.v_linearVelocity unreadable');
    const s0 = vecLen(v0), cap = s0 - EFFECT_CLAMP_DROP_MPS;
    const frames = [];
    const r = await frameLoop(EFFECT_CLAMP_MS, (t, dt) => {
      const c0 = performance.now();
      const v = readVel();
      if (!v) return;
      const speed = vecLen(v), a = attitude();
      const c = clampVelocity(v, cap);
      if (c.clamped && c.v) writeVel(c.v);
      frames.push({ tMs: Math.round(t), dt, speed, pitch: a.pitch, roll: a.roll, costMs: performance.now() - c0 });
    });
    const dts = numStats(frames.slice(1).map((x) => x.dt));
    return { startSpeedMps: s0, capMps: cap, frames: frames.length, fps: dts && dts.mean ? 1000 / dts.mean : null, loopError: r.error || null,
      ...judgeClamp(frames, cap), speedEverySecond: everySecond(frames.map((x) => ({ tMs: x.tMs, speed: x.speed }))) };
  }
  async function effectImpulse() {
    const base = numStats((await sampleSpeed(1000, 100)).map((x) => x.speed));
    const v = readVel(), h = (safe(() => window.geofs.animation.values.heading360, 0) || 0) * Math.PI / 180;
    if (!v || !base) throw new Error('velocity unreadable');
    writeVel([v[0] + EFFECT_IMPULSE_MPS * Math.sin(h), v[1] + EFFECT_IMPULSE_MPS * Math.cos(h), v[2]]);
    const samples = await sampleSpeed(EFFECT_IMPULSE_WATCH_MS, 50);
    return { baselineMps: base.mean, impulseMps: EFFECT_IMPULSE_MPS, ...impulseDecay(samples, base.mean, EFFECT_IMPULSE_MPS, 0.1), speedEverySecond: everySecond(samples) };
  }
  async function effectDrag() {
    const v0 = readVel();
    if (!v0) throw new Error('velocity unreadable');
    const s0 = vecLen(v0);
    let frames = 0, end = s0;
    const r = await frameLoop(EFFECT_DRAG_MS, () => {
      const v = readVel();
      if (!v) return;
      end = vecLen(v);
      if (end < Math.max(55, s0 * 0.55)) return false;   // stall guard
      writeVel([v[0] * EFFECT_DRAG_FACTOR, v[1] * EFFECT_DRAG_FACTOR, v[2] * EFFECT_DRAG_FACTOR]);
      frames++;
    });
    return { ...dragSummary(s0, end, frames, EFFECT_DRAG_FACTOR, !!r.aborted), loopError: r.error || null };
  }
  // ---- test 4: which mass/inertia/drag/thrust fields can be written, and do they matter
  const FIELD_RE = /mass|inertia|drag|^cd\d*$|thrust|^power$|maxpower/i;
  function fieldCandidates() {
    const i = safe(() => window.geofs.aircraft.instance, undefined);
    if (!i) return { picked: [], skipped: [] };
    const roots = [['', i], ['.rigidBody', safe(() => i.rigidBody, undefined)], ['.definition', safe(() => i.definition, undefined)]];
    for (const key of ['engines', 'airfoils']) for (let n = 0; n < 2; n++) {
      const el = safe(() => i[key][n], undefined);
      if (el) roots.push(['.' + key + '[' + n + ']', el]);
      const d = safe(() => i.definition[key][n], undefined);
      if (d) roots.push(['.definition.' + key + '[' + n + ']', d]);
    }
    const all = [];
    for (const [name, obj] of roots) {
      if (!obj || typeof obj !== 'object') continue;
      for (const k of keysOf(obj)) {
        if (!FIELD_RE.test(k)) continue;
        const v = safe(() => obj[k], undefined);
        const ok = (isNum(v) && v !== 0) || (Array.isArray(v) && v.length >= 1 && v.length <= 9 && v.every(isNum) && v.some((x) => x !== 0));
        if (ok) all.push({ path: 'geofs.aircraft.instance' + name, key: k, obj });
      }
    }
    const score = (c) => (/mass/i.test(c.key) ? 0 : /inertia/i.test(c.key) ? 1 : /drag|^cd/i.test(c.key) ? 2 : 3) * 10 + (c.path.endsWith('rigidBody') ? 0 : 1);
    all.sort((a, b) => score(a) - score(b));
    return { picked: all.slice(0, FIELD_MAX_CANDIDATES), skipped: all.slice(FIELD_MAX_CANDIDATES).map((c) => c.path + '.' + c.key) };
  }
  async function effectFieldWrites(setStatus) {
    const { picked, skipped } = fieldCandidates();
    const results = [];
    for (const c of picked) {
      const rec = { path: c.path, key: c.key };
      results.push(rec);
      setStatus('field write: ' + c.key + '…');
      const orig = Array.isArray(c.obj[c.key]) ? c.obj[c.key].slice() : c.obj[c.key];
      rec.original = orig;
      const base = await sampleSpeed(FIELD_BASE_MS, 100);
      const spd0 = base.length ? base[0].speed : null;
      try {
        const nv = scaleValue(orig, FIELD_WRITE_FACTOR);
        c.obj[c.key] = nv;
        await sleepMs(150);
        rec.readBackOk = approxEq(c.obj[c.key], nv);
        const w = await sampleSpeed(FIELD_WRITE_MS, 100);
        rec.stuckAtEnd = approxEq(c.obj[c.key], nv);
        const bSlope = slopePerSec(base, 'speed'), bClimb = slopePerSec(base, 'alt');
        const wSlope = slopePerSec(w, 'speed'), wClimb = slopePerSec(w, 'alt');
        const wDur = w.length ? w[w.length - 1].tMs / 1000 : 0;
        rec.baselineSlopeMps2 = bSlope; rec.writeSlopeMps2 = wSlope; rec.baselineClimbMps = bClimb; rec.writeClimbMps = wClimb;
        rec.effectSpeedMps = w.length && isNum(w[w.length - 1].speed) && isNum(w[0].speed) && isNum(bSlope) ? (w[w.length - 1].speed - w[0].speed) - bSlope * wDur : null;
        rec.effectClimbMps = isNum(wClimb) && isNum(bClimb) ? wClimb - bClimb : null;
        rec.startSpeedMps = spd0;
      } catch (e) { rec.threw = String(e && e.message); }
      finally { try { c.obj[c.key] = orig; rec.restored = approxEq(c.obj[c.key], orig); } catch (e) { rec.restored = false; } }
      Object.assign(rec, classifyFieldWrite(rec));
      await sleepT(2000);
    }
    return { results, skipped };
  }
  async function runEffectsTests(setStatus) {
    const store = window.__finsProbeEffects || (window.__finsProbeEffects = { status: 'ran', runs: [], fieldWrites: null, skippedFieldCandidates: [] });
    const hagl = safe(() => window.geofs.animation.values.haglMeters, null);
    if (isNum(hagl) && hagl < EFFECTS_MIN_HAGL_M) {
      const refused = { ...store, status: 'refused', reason: 'only ' + Math.round(hagl) + ' m AGL: fly straight and level above ~5,000 ft (1,500 m) AGL first' };
      return refused;
    }
    delete store.reason;
    store.status = 'ran';
    const run = { at: new Date().toISOString(), haglM: hagl };
    store.runs.push(run);
    const s0 = curSpeed();
    run.startSpeedMps = s0; run.startSpeedKt = s0 == null ? null : s0 / MPS_PER_KT_PROBE;
    setStatus('effects 1/3: velocity clamp (10 s)…');
    try { run.clamp = await effectClamp(); } catch (e) { run.clamp = { verdict: 'error', error: String(e && e.message) }; }
    run.recoveredAfterClamp = await waitForSpeed(s0, 4, 12000);
    setStatus('effects 2/3: +30 m/s impulse (20 s)…');
    try { run.impulse = await effectImpulse(); } catch (e) { run.impulse = { error: String(e && e.message) }; }
    run.recoveredAfterImpulse = await waitForSpeed(s0, 4, 10000);
    setStatus('effects 3/3: drag x0.995 per frame (5 s)…');
    try { run.drag = await effectDrag(); } catch (e) { run.drag = { verdict: 'error', error: String(e && e.message) }; }
    run.recoveredAfterDrag = await waitForSpeed(s0, 4, 12000);
    if (!store.fieldWrites) {
      try {
        const fw = await effectFieldWrites(setStatus);
        store.fieldWrites = fw.results;
        store.skippedFieldCandidates = fw.skipped;
      } catch (e) { store.fieldWritesError = String(e && e.message); }
    } else run.note = 'field writes (test 4) ran on the first click only';
    store.finishedAt = new Date().toISOString();
    return store;
  }

  // ---- 5/6. aircraft catalogue (read-only) and the swap test (opt-in)
  function findAircraftList() {
    const cands = [];
    walkObjects(walkRoots(2, 1, 1), (val, p) => {
      if (cands.length >= 6) return true;
      const list = normalizeAircraftList(val);
      if (list.length >= 10) { cands.push({ path: p, list }); return true; }
      return false;
    }, null, 20000);
    cands.sort((a, b) => b.list.length - a.list.length);
    return cands[0] || null;
  }
  const SWAP_FN_RE = /change|load|swap|select|switch|set.?aircraft|aircraft.?(set|load|change)/i;
  function swapFunctionCandidates() {
    const out = [];
    const add = (path, fn) => {
      if (out.length >= 24 || typeof fn !== 'function') return;
      const src = safe(() => Function.prototype.toString.call(fn).replace(/\s+/g, ' '), '[unreadable]');
      out.push({ path, arity: fn.length, signature: (/^[^(]*\(([^)]*)\)/.exec(src) || [])[1] || null, src: src.slice(0, 500) });
    };
    const scan = (name, obj) => {
      if (!obj || (typeof obj !== 'object' && typeof obj !== 'function')) return;
      for (const k of keysOf(obj)) { const v = safe(() => obj[k], undefined); if (typeof v === 'function' && SWAP_FN_RE.test(k)) add(name + '.' + k, v); }
      const proto = safe(() => Object.getPrototypeOf(obj), null);
      if (proto && proto !== Object.prototype && proto !== Function.prototype) for (const k of safe(() => Object.getOwnPropertyNames(proto), [])) if (k !== 'constructor' && SWAP_FN_RE.test(k)) add(name + '(proto).' + k, safe(() => obj[k], undefined));
    };
    scan('geofs.aircraft.instance', safe(() => window.geofs.aircraft.instance, undefined));
    scan('geofs.aircraft', safe(() => window.geofs.aircraft, undefined));
    for (const k of keysOf(safe(() => window.geofs.aircraft, undefined))) { const v = safe(() => window.geofs.aircraft[k], undefined); if (typeof v === 'function' && /^[A-Z]/.test(k)) scan('geofs.aircraft.' + k + '.prototype', safe(() => v.prototype, undefined)); }
    scan('geofs', safe(() => window.geofs, undefined));
    scan('ui', safe(() => window.ui, undefined));
    return out;
  }
  function aircraftDomControls() {
    const rows = [];
    for (const el of safe(() => Array.from(document.querySelectorAll('[data-aircraft], [data-aircraftid], [data-aircraft-id], .geofs-aircraft-list li, [onclick*="aircraft" i]')), [])) {
      if (rows.length >= 12) break;
      rows.push({ selector: uiSelector(el.tagName, el.id, el.className), dataset: safe(() => Object.assign({}, el.dataset), null), onclick: (el.getAttribute('onclick') || '').slice(0, 160) || null, text: (el.textContent || '').trim().slice(0, 40) || null });
    }
    return rows;
  }
  function buildAircraftCatalog() {
    const found = findAircraftList();
    const list = found ? found.list : [];
    const cur = safe(() => window.geofs.aircraft.instance, undefined);
    return {
      listPath: found ? found.path : null, count: list.length,
      ids: list.slice(0, 900).map((a) => a.id + ':' + a.name),
      currentAircraft: { id: cur ? safe(() => String(cur.id), null) : null, name: found && cur ? (list.find((a) => a.id === String(cur.id)) || {}).name || null : null },
      cessna172: pickCessna172(list),
      swapFunctions: swapFunctionCandidates(),
      domControls: aircraftDomControls(),
      note: 'swapFunctions[].signature/src show the parameter order. The swap test tries change(id), change(id, [lat, lon, alt, hdg]) and clicking the aircraft list item, and stops at the first that changes geofs.aircraft.instance.id.',
    };
  }
  const mpAircraft = () => safe(() => {
    let lr = window.multiplayer && window.multiplayer.lastRequest;
    if (typeof lr === 'string') lr = JSON.parse(lr);
    if (!lr || typeof lr !== 'object') return null;
    for (const k of ['ac', 'acid', 'aircraft', 'aircraftId']) if (lr[k] !== undefined) return lr[k];
    return null;
  }, null);
  function swapSnapshot() {
    const i = safe(() => window.geofs.aircraft.instance, undefined);
    return { id: i ? safe(() => String(i.id), null) : null, lla: safe(() => i.llaLocation.slice(0, 3), null), hdg: safe(() => i.htr[0], null), vel: readVel(), groundContact: safe(() => i.groundContact, null),
      haglM: safe(() => window.geofs.animation.values.haglMeters, null), mpAc: mpAircraft() };
  }
  async function waitForAircraftId(id, maxMs) {
    const t0 = performance.now();
    while (performance.now() - t0 < T(maxMs)) { if (safe(() => String(window.geofs.aircraft.instance.id), null) === String(id)) return Math.round(performance.now() - t0); await sleepMs(100); }
    return null;
  }
  async function runAircraftSwapTest(setStatus) {
    const res = { status: 'ran', startedAt: new Date().toISOString(), attempts: [], working: null, errors: [] };
    const onErr = (e) => res.errors.push(String((e && (e.message || (e.reason && e.reason.message))) || 'error').slice(0, 200));
    window.addEventListener('error', onErr);
    window.addEventListener('unhandledrejection', onErr);
    try {
      const catalog = findAircraftList();
      const target = pickCessna172(catalog ? catalog.list : []);
      if (!target) { res.error = 'no Cessna 172 in the aircraft catalogue (' + (catalog ? catalog.list.length + ' entries at ' + catalog.path : 'catalogue not found') + ')'; return res; }
      const before = swapSnapshot();
      res.target = target; res.before = before;
      if (before.id === target.id) { res.error = 'already flying the Cessna 172: start from another aircraft'; return res; }
      const lla = before.lla;
      const variants = [
        { id: 'change(id)', run: () => window.geofs.aircraft.instance.change(target.id) },
        { id: 'change(id, [lat,lon,alt,hdg])', run: () => window.geofs.aircraft.instance.change(target.id, [lla[0], lla[1], lla[2], before.hdg || 0]) },
        { id: 'click aircraft list item', run: () => {
          const el = document.querySelector('[data-aircraft="' + target.id + '"], [data-aircraftid="' + target.id + '"], [data-aircraft-id="' + target.id + '"]');
          if (!el) throw new Error('no aircraft list element for id ' + target.id);
          el.click();
        } },
      ];
      for (const v of variants) {
        const a = { call: v.id };
        res.attempts.push(a);
        setStatus('swap: ' + v.id + '…');
        const t0 = performance.now();
        try { v.run(); } catch (e) { a.threw = String(e && e.message); continue; }
        a.tookMs = await waitForAircraftId(target.id, SWAP_WAIT_MS);
        if (a.tookMs == null) { a.error = 'aircraft id did not change within ' + SWAP_WAIT_MS + ' ms'; continue; }
        res.working = v.id;
        res.tookMs = Math.round(performance.now() - t0);
        break;
      }
      if (res.working) {
        await sleepT(500);
        res.after500ms = swapSnapshot();
        await sleepT(1500);
        res.after2s = swapSnapshot();
        await sleepT(3000);
        const after = swapSnapshot();
        res.after5s = after;
        res.verdict = judgeSwap({ wantedId: target.id, idAfter: after.id, llaBefore: before.lla, llaAfter: after.lla, velBefore: before.vel, velAfter: after.vel, groundContactAfter: after.groundContact });
        res.multiplayer = { lastRequestAircraftBefore: before.mpAc, lastRequestAircraftAfter: after.mpAc,
          sendsNewModel: after.mpAc == null ? null : String(after.mpAc) === String(target.id),
          note: after.mpAc == null ? 'multiplayer.lastRequest not readable here: ask a second pilot whether they see the 172' : 'compares the aircraft id in the last update sent to the multiplayer server' };
        // swap back, then put position and velocity back if the swap lost them
        setStatus('swap back…');
        const back = { call: res.working };
        res.swapBack = back;
        const b0 = performance.now();
        try {
          const v = variants.find((x) => x.id === res.working);
          if (v.id === 'change(id)') window.geofs.aircraft.instance.change(before.id);
          else if (v.id === 'change(id, [lat,lon,alt,hdg])') window.geofs.aircraft.instance.change(before.id, [lla[0], lla[1], lla[2], before.hdg || 0]);
          else { const el = document.querySelector('[data-aircraft="' + before.id + '"], [data-aircraftid="' + before.id + '"], [data-aircraft-id="' + before.id + '"]'); if (!el) throw new Error('no list element for the original aircraft'); el.click(); }
          back.tookMs = await waitForAircraftId(before.id, SWAP_WAIT_MS);
          back.ok = back.tookMs != null;
          if (back.ok) {
            await sleepT(1500);
            const now = swapSnapshot();
            const moved = now.lla && lla ? haversineM(lla[0], lla[1], now.lla[0], now.lla[1]) : null;
            if (moved != null && moved > 300) {
              window.geofs.aircraft.instance.place([lla[0], lla[1], lla[2]], [(((before.hdg || 0) % 360) + 360) % 360, 0, 0]);
              if (before.vel) writeVel(before.vel);
              back.restoredPosition = true;
            } else back.restoredPosition = false;
          }
        } catch (e) { back.ok = false; back.error = String(e && e.message); }
        back.totalMs = Math.round(performance.now() - b0);
      }
      return res;
    } finally {
      window.removeEventListener('error', onErr);
      window.removeEventListener('unhandledrejection', onErr);
    }
  }

  // ---- B. N-map attach check (opt-in: wraps GeoFS functions for NMAP_TEST_MS, adds one overlay)
  async function runNMapAttachTest(setStatus) {
    const res = { status: 'ran', durationMs: NMAP_TEST_MS, fires: [], wrapped: [] };
    const map = safe(() => window.geofs.api.map._map, null);
    if (!isLeafletMap(map) || !window.L) { res.error = 'geofs.api.map._map is not a Leaflet map (or window.L is missing)'; res.verdict = judgeNMapAttach(res); return res; }
    const container = map.getContainer();
    res.instanceIsPanelMap = !!container.closest('.geofs-map-list');
    res.containerBefore = containerInfo(container);
    const lla = safe(() => window.geofs.aircraft.instance.llaLocation, [0, 0, 0]);
    let layer = null;
    try {
      layer = window.L.circle([lla[0], lla[1]], { radius: 3000, color: '#ff00ff', weight: 4, className: 'fr-probe-test' }).bindTooltip('FINSONLY test', { permanent: true });
      layer.addTo(map);
      res.overlayAdded = map.hasLayer(layer);
    } catch (e) { res.error = 'could not add the test layer: ' + e.message; }
    const t0 = performance.now();
    const restore = [];
    const wrap = (obj, key, label, kind) => {
      const orig = safe(() => obj[key], undefined);
      if (typeof orig !== 'function') return;
      const w = function (...args) {
        const ret = orig.apply(this, args);
        const tMs = Math.round(performance.now() - t0);
        setTimeout(() => {
          const e = { via: label, kind, tMs, panelVisibleAfter: safe(() => containerInfo(container).visible, null) };
          if (kind === 'open' && layer) {
            e.layerPresent = safe(() => map.hasLayer(layer), false);
            if (!e.layerPresent) { safe(() => layer.addTo(map)); e.reAdded = safe(() => map.hasLayer(layer), false); }
            const node = safe(() => container.querySelector('.fr-probe-test'), null);
            e.domNodePresent = !!node;
            e.domNodeVisible = !!node && safe(() => { const r = node.getBoundingClientRect(); return r.width > 0 && r.height > 0; }, false);
          }
          res.fires.push(e);
        }, 400);
        return ret;
      };
      obj[key] = w;
      res.wrapped.push(label);
      restore.push(() => { if (obj[key] === w) { obj[key] = orig; return true; } return false; });
    };
    const OPEN = /^(openMap|toggleMap|startMap)$/, CLOSE = /^(closeMap|stopMap)$/;
    for (const [name, obj] of [['ui', safe(() => window.ui, null)], ['geofs.map', safe(() => window.geofs.map, null)]]) {
      for (const k of keysOf(obj)) { if (OPEN.test(k)) wrap(obj, k, name + '.' + k, 'open'); else if (CLOSE.test(k)) wrap(obj, k, name + '.' + k, 'close'); }
    }
    setStatus('N-map test: press N now to open, N to close, N again (10 s)…');
    await sleepT(NMAP_TEST_MS);
    await sleepMs(600);   // an open in the last moments still gets its 400 ms overlay check
    const restoredAll = restore.map((r) => safe(r, false));
    if (layer) { safe(() => map.removeLayer(layer)); res.overlayRemoved = !safe(() => map.hasLayer(layer), true); }
    res.wrappersRestored = restoredAll.length > 0 && restoredAll.every(Boolean);
    res.verdict = judgeNMapAttach(res);
    return res;
  }

  // ---- the probe's buttons. Each is opt-in, behind a confirm(), and re-copies the whole report.
  function emitSection(name, res) {
    const last = window.__finsProbeLast;
    if (last && last.final) {
      last.final[name] = res;
      last.final.dashReadiness = buildDashReadiness(last.final);
      outputReport('probe+' + name, last.final);
    } else outputReport(name, res);
  }
  function addProbeButton(id, label, bottomPx, bg, confirmText, section, runner) {
    if (document.getElementById(id)) return;
    const b = document.createElement('button');
    b.id = id;
    b.textContent = label;
    b.style.cssText = 'position:fixed;left:8px;bottom:' + bottomPx + 'px;z-index:2147483647;padding:8px 12px;font:12px sans-serif;background:' + bg + ';color:#fff;border:1px solid #fff;border-radius:4px;cursor:pointer';
    b.addEventListener('click', async () => {
      if (window.__finsProbeBusy) { alert('FINSONLY probe: another probe test is still running.'); return; }
      if (!confirm(confirmText)) return;
      window.__finsProbeBusy = true;
      b.disabled = true;
      try {
        emitSection(section, await runner((s) => { b.textContent = s; }));
      } catch (e) {
        emitSection(section, { status: 'ran', error: String(e && e.message) });
      } finally { window.__finsProbeBusy = false; b.disabled = false; b.textContent = label; }
    });
    document.body.appendChild(b);
  }
  function ensureProbeButtons() {
    addProbeButton('fr-probe-ground-btn', 'Run ground placement test', 8, '#7a1f1f',
      'FINSONLY probe: this MOVES your aircraft to KPDX runway 10R (on the ground, stationary) and samples for 5 s per attempt, trying up to 4 methods. Continue?',
      'groundPlacement', runGroundPlacementTest);
    addProbeButton('fr-probe-effects-btn', 'Run effects tests', 46, '#1f4f7a',
      'FINSONLY probe: fly STRAIGHT AND LEVEL above 5,000 ft AGL first. This writes the aircraft\'s velocity (clamp -20 m/s for 10 s, +30 m/s impulse, x0.995/frame drag for 5 s) and, on the first click only, writes mass/inertia/drag/thrust fields x1.2 one at a time and restores them. About 2-3 minutes. Click once near 250 kt and once near 600 kt. Continue?',
      'effects', runEffectsTests);
    addProbeButton('fr-probe-swap-btn', 'Run aircraft swap test', 84, '#5a3a7a',
      'FINSONLY probe: this swaps you to the Cessna 172 in flight at the current position, measures what survives, then swaps back (and restores position/velocity if the swap lost them). Fly straight and level first. Continue?',
      'aircraftSwap', runAircraftSwapTest);
    addProbeButton('fr-probe-nmap-btn', 'Run N-map attach test', 122, '#1f6f4f',
      'FINSONLY probe: wraps GeoFS\'s map open/close functions and adds one magenta circle to the N map for 10 s. After clicking OK, press N (open), N (close) and N (open) within the 10 s. Continue?',
      'nMapAttach', runNMapAttachTest);
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

  const recorderGrowthPromise = safe(() => sampleRecorderGrowth(report && report.recorder), Promise.resolve(null));

  Promise.all([landingCrossCheckPromise, touchdownInputsPromise, recorderGrowthPromise]).then(([crossCheck, touchdownInputs, growth]) => {
    if (report && report.landing && report.landing.verticalSpeed) {
      report.landing.verticalSpeed.crossCheck = crossCheck;
    }
    if (report) report.touchdownInputs = touchdownInputs;
    if (report && report.recorder && typeof report.recorder === 'object') {
      report.recorder.growth = growth;
      report.recorder.recordingNow = growth ? growth.recordingNow : null;
    }
    // The Dash sections go first so the 200 KB cap in outputReport can only ever clip the old ones.
    const { navMaps, runways, aircraftCatalog, recorder, groundPlacement, effects, aircraftSwap, nMapAttach, ...rest } = report || {};
    const final = {
      readMeFirst: [
        'DASH DISCOVERY probe. Order in-sim: (1) start a GeoFS flight recording; (2) spawn near KPDX, run this probe, click "Run ground placement test" once; (3) take off, fly straight and level above 5,000 ft AGL near 250 kt, click "Run effects tests" (2-3 min); repeat near 600 kt; (4) airborne, click "Run aircraft swap test"; (5) click "Run N-map attach test" and press N, N, N within 10 s.',
        'Every button re-copies this whole report; paste the LAST copy back. The N-map lifecycle comparison (navMaps.lifecycle) needs one earlier run before pressing N and one with the panel open.',
        'Load a course first so navMaps.raceOverlay shows where the course overlay attaches.',
      ],
      dashReadiness: null,
      navMaps, runways, aircraftCatalog, recorder, groundPlacement, effects, aircraftSwap, nMapAttach,
      ...rest,
    };
    final.dashReadiness = buildDashReadiness(final);
    window.__finsProbeLast = { final };
    ensureProbeButtons();
    outputReport('probe', final);
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
    module.exports = {
      mpsToFpm, fpmToMps, verticalSpeedFromAltitudes, isStopped, FPM_PER_MPS, uiSelector, uiRoleGuess, uiRectInfo,
      haversineM, normalizeRunway, flattenRunwayRecords, nearestRunways, findRunway, tapeSampleRate, matchFieldsByValue,
      compareMapRuns, judgeGroundPlacement, buildDashReadiness, GROUND_TEST_FALLBACK,
      numStats, vecLen, scaleToSpeed, clampVelocity, judgeClamp, impulseDecay, slopePerSec, dragSummary, approxEq, scaleValue,
      classifyFieldWrite, normalizeAircraftList, pickCessna172, judgeSwap, judgeNMapAttach,
    };
  }
})();
