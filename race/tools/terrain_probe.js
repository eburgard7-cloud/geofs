/*
 * FINSONLY Racing — in-sim terrain probe (one-shot, READ-ONLY).
 *
 * race/tools/check_terrain.py checks a course against USGS 3DEP, which is US-only and
 * unreachable from some dev networks anyway (api.cesium.com/opentopodata are too — see that
 * script's module docstring). This is the worldwide replacement: it samples the terrain
 * GeoFS's own Cesium viewer actually renders, in the browser, so it works on every course
 * everywhere the sim itself renders terrain for.
 *
 * Same spirit as race/tools/probe.js: paste the TERRAIN PROBE line (see the "Checking terrain
 * against what GeoFS actually renders" section of race/README.md) into a bookmark and click it
 * on geo-fs.com after the plane and FINSONLY Racing are loaded. It prompts for a course id,
 * samples every gate plus every 100 m along each leg with Cesium.sampleTerrainMostDetailed,
 * prints a console.table report and a one-line verdict, and copies a JSON report to the
 * clipboard (console.log fallback) so it can be pasted back for comparison against a USGS run
 * on courses that have both.
 *
 * ZERO writes to sim state: no llaLocation/velocity/htr/camera writes, no resetFlight. It only
 * ever reads geofs.api.viewer.terrainProvider and fetches course JSON the same way race.js does.
 */
(function () {
  'use strict';

  // ------------------------------------------------------------- pure geometry / classification
  // Mirrors race/tools/check_terrain.py's haversine_m()/interpolate()/chord_sag_m()/
  // route_samples() exactly (same EARTH_R_M race.js's own destination() uses too), so a course
  // checked by both tools is sampled at the same points and the two reports line up.
  var EARTH_R_M = 6371008.8;
  var STEP_M = 100;                 // "every 100 m along each leg" per the probe's brief
  var MARGIN_M = 150;                // mirrors DEFAULT_MARGIN_M in race/tools/check_terrain.py

  function haversineM(a, b) {
    var lat1 = a.lat * Math.PI / 180, lon1 = a.lon * Math.PI / 180;
    var lat2 = b.lat * Math.PI / 180, lon2 = b.lon * Math.PI / 180;
    var dlat = lat2 - lat1, dlon = lon2 - lon1;
    var h = Math.sin(dlat / 2) * Math.sin(dlat / 2) + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dlon / 2) * Math.sin(dlon / 2);
    return 2 * EARTH_R_M * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  // Point `frac` of the way from a to b along the great circle (spherical lerp). Falls back to
  // the endpoint for coincident points, where the interpolation is undefined.
  function interpolateLatLon(a, b, frac) {
    var lat1 = a.lat * Math.PI / 180, lon1 = a.lon * Math.PI / 180;
    var lat2 = b.lat * Math.PI / 180, lon2 = b.lon * Math.PI / 180;
    var d = haversineM(a, b) / EARTH_R_M;
    if (d < 1e-12) return { lat: a.lat, lon: a.lon };
    var sd = Math.sin(d);
    var f1 = Math.sin((1 - frac) * d) / sd, f2 = Math.sin(frac * d) / sd;
    var x = f1 * Math.cos(lat1) * Math.cos(lon1) + f2 * Math.cos(lat2) * Math.cos(lon2);
    var y = f1 * Math.cos(lat1) * Math.sin(lon1) + f2 * Math.cos(lat2) * Math.sin(lon2);
    var z = f1 * Math.sin(lat1) + f2 * Math.sin(lat2);
    return { lat: Math.atan2(z, Math.hypot(x, y)) * 180 / Math.PI, lon: Math.atan2(y, x) * 180 / Math.PI };
  }

  // How far below the two gates' straight-line altitude a real flight path sags at `frac` along
  // a leg of length `distanceM`. Zero at both gates, peaks at the midpoint (~31 m over 40 km).
  function chordSagM(distanceM, frac) {
    return (distanceM * distanceM / (8 * EARTH_R_M)) * 4 * frac * (1 - frac);
  }

  // Every point to sample: each gate, plus interior points along each leg every stepM (never
  // coincident with a gate, so a leg can't mask a buried gate — same rule as check_terrain.py).
  function routeSamples(gates, stepM) {
    stepM = stepM || STEP_M;
    var out = [];
    for (var i = 0; i < gates.length; i++) {
      var g = gates[i];
      out.push({ kind: 'gate', gate: i, leg: null, alongM: 0, lat: g.lat, lon: g.lon, alt: g.alt, radius: g.radius });
    }
    for (var j = 0; j < gates.length - 1; j++) {
      var a = gates[j], b = gates[j + 1];
      var d = haversineM(a, b);
      var n = Math.floor(d / stepM);
      for (var k = 1; k <= n; k++) {
        var frac = (k * stepM) / d;
        if (frac >= 1) break;
        var p = interpolateLatLon(a, b, frac);
        var alt = a.alt + (b.alt - a.alt) * frac - chordSagM(d, frac);
        out.push({ kind: 'leg', gate: null, leg: [j, j + 1], alongM: k * stepM, lat: p.lat, lon: p.lon, alt: alt, radius: null });
      }
    }
    return out;
  }

  // A course's `alt` is defined (race/README.md's "Course schema") as the same value GeoFS
  // reports in llaLocation[2] — i.e. whatever vertical datum GeoFS/Cesium itself works in. That
  // is exactly what Cesium.sampleTerrainMostDetailed returns too (both come from the same
  // Cesium scene), so no numeric conversion is needed here — this function exists so the
  // "convert to the schema's MSL convention" step is a named, visible no-op rather than an
  // implicit assumption, and so a future GeoFS build that reports altitude differently only
  // needs this one function changed.
  function toMsl(alt) { return alt; }

  // clearanceM === null means "no terrain data for this point" (tile-load failure) — always
  // UNVERIFIED, never a silent PASS. Otherwise a single margin decides PASS/FAIL, same threshold
  // check_terrain.py's DEFAULT_MARGIN_M applies (that script additionally distinguishes
  // BURIED/CLIPPING/LOW; this probe reports one bar, matching the console.table the probe's
  // brief asks for).
  function classifySample(clearanceM, marginM) {
    if (clearanceM === null || clearanceM === undefined || !isFinite(clearanceM)) return 'UNVERIFIED';
    return clearanceM < marginM ? 'FAIL' : 'PASS';
  }

  function courseStatus(rows) {
    var anyFail = rows.some(function (r) { return r.status === 'FAIL'; });
    if (anyFail) return 'FAIL';
    var anyUnverified = rows.some(function (r) { return r.status === 'UNVERIFIED'; });
    return anyUnverified ? 'UNVERIFIED' : 'PASS';
  }

  function pointLabel(s) {
    return s.kind === 'gate' ? 'gate ' + (s.gate + 1) : 'leg ' + (s.leg[0] + 1) + '->' + (s.leg[1] + 1) + '@' + (s.alongM / 1000).toFixed(1) + 'km';
  }

  // ------------------------------------------------------------------------- browser-only body
  function safe(fn, fallback) { try { return fn(); } catch (e) { return fallback; } }

  function runInBrowser() {
    // ---- fail-closed: find the Cesium viewer/terrainProvider the same defensive way probe.js
    // finds things — try the confirmed path, report exactly what was tried, never throw.
    var tried = [];
    function tryPath(label, fn) {
      var v = safe(fn, undefined);
      tried.push({ path: label, found: v !== undefined && v !== null });
      return v;
    }
    var hasCesium = typeof window.Cesium !== 'undefined';
    tried.push({ path: 'window.Cesium', found: hasCesium });
    var sampleFn = hasCesium ? safe(function () { return Cesium.sampleTerrainMostDetailed; }, undefined) : undefined;
    tried.push({ path: 'Cesium.sampleTerrainMostDetailed', found: typeof sampleFn === 'function' });
    var viewer = tryPath('geofs.api.viewer', function () { return geofs.api.viewer; });
    var terrainProvider = viewer ? tryPath('geofs.api.viewer.terrainProvider', function () { return viewer.terrainProvider; }) : undefined;

    if (!hasCesium || typeof sampleFn !== 'function' || !viewer || !terrainProvider) {
      var msg = 'terrainProbe: could not find a usable Cesium terrain provider. Tried:\n' +
        tried.map(function (t) { return '  ' + t.path + ': ' + (t.found ? 'found' : 'MISSING'); }).join('\n');
      console.warn('[terrainProbe] ' + msg);
      alert('FINSONLY terrain probe: no terrain provider found (see console for what was tried). Load GeoFS fully first.');
      return;
    }

    // ---- fail-closed: reuse race.js's own course loader path (its live CONFIG.COURSE_BASE),
    // never a hardcoded URL of our own — if race.js isn't loaded there is no "its loader" to
    // reuse, so this probe refuses to guess one.
    var fins = safe(function () { return window.__finsRace; }, undefined);
    var courseBase = safe(function () { return fins.config.COURSE_BASE; }, undefined);
    if (!fins || typeof courseBase !== 'string' || !courseBase) {
      console.warn('[terrainProbe] window.__finsRace.config.COURSE_BASE not found — load FINSONLY Racing first so this probe can reuse its course loader.');
      alert('FINSONLY terrain probe: FINSONLY Racing is not loaded, so there is no course loader/COURSE_BASE to reuse. Load it first.');
      return;
    }

    fetchJson(courseBase + 'index.json?t=' + Date.now())
      .then(function (list) {
        if (!Array.isArray(list) || !list.length) throw new Error('empty or malformed course index');
        var ids = list.map(function (c) { return c.id; }).filter(Boolean);
        var picked = prompt('Terrain probe — course id to check (Cancel to abort):\n' + ids.join(', '), ids[0] || '');
        if (picked === null) { console.log('[terrainProbe] cancelled.'); return null; }
        var entry = list.filter(function (c) { return c.id === picked; })[0];
        if (!entry) throw new Error('no course with id "' + picked + '" in the course index');
        return fetchJson(courseBase + encodeURIComponent(entry.file) + '?t=' + Date.now()).then(function (course) {
          return checkCourse(course, terrainProvider);
        });
      })
      .catch(function (e) {
        console.warn('[terrainProbe] failed: ' + e.message);
        alert('FINSONLY terrain probe failed: ' + e.message + ' (see console).');
      });
  }

  function fetchJson(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status + ' fetching ' + url);
      return r.json();
    });
  }

  function normalizeGates(course) {
    var gates = course && course.gates;
    if (!Array.isArray(gates) || gates.length < 2) throw new Error('course has fewer than 2 gates');
    return gates.map(function (g, i) {
      var lat = +g.lat, lon = +g.lon, alt = +g.alt;
      if (!isFinite(lat) || !isFinite(lon) || !isFinite(alt)) throw new Error('gate ' + (i + 1) + ' has a non-numeric lat/lon/alt');
      var radius = g.radius === undefined || g.radius === null ? 150 : +g.radius;
      return { lat: lat, lon: lon, alt: alt, radius: isFinite(radius) ? radius : 150 };
    });
  }

  function checkCourse(course, terrainProvider) {
    var gates = normalizeGates(course);
    var samples = routeSamples(gates, STEP_M);
    var cartos = samples.map(function (s) { return Cesium.Cartographic.fromDegrees(s.lon, s.lat); });

    // A full-promise rejection (bad terrain provider, network failure mid-tile-load) fails
    // every sample closed as UNVERIFIED rather than throwing the whole check away silently.
    return Promise.resolve()
      .then(function () { return Cesium.sampleTerrainMostDetailed(terrainProvider, cartos); })
      .catch(function (e) {
        console.warn('[terrainProbe] sampleTerrainMostDetailed rejected: ' + e.message + ' — every sample is UNVERIFIED.');
        return cartos.map(function () { return { height: undefined }; });
      })
      .then(function (sampled) {
        var rows = samples.map(function (s, i) {
          var h = sampled[i] && sampled[i].height;
          var terrainMsl = isFinite(h) ? h : null; // a per-point tile-load failure also lands here
          var routeAltMsl = toMsl(s.alt);
          var clearanceM = terrainMsl === null ? null : routeAltMsl - terrainMsl;
          var status = classifySample(clearanceM, MARGIN_M);
          return {
            point: pointLabel(s), lat: +s.lat.toFixed(5), lon: +s.lon.toFixed(5),
            routeAltMsl: round1(routeAltMsl), terrainMsl: terrainMsl === null ? null : round1(terrainMsl),
            clearanceM: clearanceM === null ? null : round1(clearanceM), status: status,
          };
        });
        report(course, rows);
        return rows;
      });
  }

  function round1(n) { return Math.round(n * 10) / 10; }

  function report(course, rows) {
    console.log('[terrainProbe] ' + (course.id || course.name || 'course') + ' — ' + rows.length + ' samples');
    if (console.table) console.table(rows); else console.log(rows);

    var status = courseStatus(rows);
    var worst = rows.filter(function (r) { return r.clearanceM !== null; })
      .reduce(function (acc, r) { return acc === null || r.clearanceM < acc.clearanceM ? r : acc; }, null);
    var verdictLine = worst
      ? '[terrainProbe] ' + (course.id || course.name) + ': ' + status + ' — worst clearance ' + worst.clearanceM + ' m at ' + worst.point + ' (' + worst.lat + ',' + worst.lon + ')'
      : '[terrainProbe] ' + (course.id || course.name) + ': ' + status + ' — no verified samples';
    console.log(verdictLine);

    var payload = { id: course.id || null, name: course.name || null, marginM: MARGIN_M, stepM: STEP_M, status: status, samples: rows };
    var text = JSON.stringify(payload, null, 1);
    console.log('[terrainProbe] JSON report (paste back for comparison against a USGS check_terrain.py run):\n' + text);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text)
        .then(function () { alert(verdictLine + '\n\nFull JSON report copied to clipboard (' + text.length + ' bytes). Paste it back.'); })
        .catch(function () { alert(verdictLine + '\n\nClipboard write failed — the JSON report is in the console (F12).'); });
    } else {
      alert(verdictLine + '\n\nClipboard API unavailable — the JSON report is in the console (F12).');
    }
  }

  // Run the real thing only in a browser with GeoFS's globals; under Node (the unit test) this
  // file just exports its pure functions and touches nothing browser-specific.
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    runInBrowser();
  } else if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      EARTH_R_M: EARTH_R_M, STEP_M: STEP_M, MARGIN_M: MARGIN_M,
      haversineM: haversineM, interpolateLatLon: interpolateLatLon, chordSagM: chordSagM,
      routeSamples: routeSamples, toMsl: toMsl, classifySample: classifySample,
      courseStatus: courseStatus, pointLabel: pointLabel, normalizeGates: normalizeGates,
    };
  }
})();
