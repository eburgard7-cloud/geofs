"use strict";
/* FINSONLY Racing HQ — pure helpers. Vanilla JS, no framework, no build step, no DOM, no network.
 *
 * Everything in this file is a pure function over plain data, so it runs unchanged under Node:
 * race/test/run.js (the original landing-page helpers) and race/test/site_hq.test.js (everything
 * else) `require` it. In the browser it is a classic script that publishes the same object as
 * `window.FinsSite`; the page itself lives in js/app.js and js/views/*.js.
 *
 * Several helpers are ports of race.js's own trace math (traceDecode, traceSampleAt, traceNearest,
 * applyModelTransform's heading/pitch/roll convention). They are ported, not imported: race.js is
 * a bookmarklet with no module boundary, and the site must not depend on its internals.
 */
(function () {
  // ================================================================== original landing helpers
  // Kept byte-compatible: race/test/run.js's "site.js: pure geometry helpers" section pins them.

  function boundsOf(points) {
    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    for (const p of points) {
      if (p.lat < minLat) minLat = p.lat;
      if (p.lat > maxLat) maxLat = p.lat;
      if (p.lon < minLon) minLon = p.lon;
      if (p.lon > maxLon) maxLon = p.lon;
    }
    if (!Number.isFinite(minLat)) return { minLat: 0, maxLat: 0, minLon: 0, maxLon: 0 };
    return { minLat, maxLat, minLon, maxLon };
  }

  /** Equirectangular projection, fit to `bounds`, into a `width` x `height` box with `padding` on
   * each side. A degenerate (zero-span) bounds box centers everything rather than dividing by
   * zero. SVG y grows downward, so higher latitude maps to a smaller y. */
  function projectLatLon(lat, lon, bounds, width, height, padding) {
    padding = padding || 0;
    const latSpan = (bounds.maxLat - bounds.minLat) || 1e-9;
    const lonSpan = (bounds.maxLon - bounds.minLon) || 1e-9;
    const innerW = Math.max(width - padding * 2, 1);
    const innerH = Math.max(height - padding * 2, 1);
    return {
      x: padding + ((lon - bounds.minLon) / lonSpan) * innerW,
      y: padding + ((bounds.maxLat - lat) / latSpan) * innerH,
    };
  }

  /** [{x,y}, ...] -> an SVG path `d` string. Empty input -> empty string (never a malformed `d`). */
  function buildTracePath(points) {
    if (!points || !points.length) return "";
    return points.map((p, i) => (i === 0 ? "M" : "L") + p.x.toFixed(2) + "," + p.y.toFixed(2)).join(" ");
  }

  /** The server's columnar trace format (see app.py's decode_trace): {v,n,t,lat,lon,alt,hdg,pitch,
   * roll}, with `t` delta-encoded (t[0] absolute, t[i>0] a delta from the previous sample). Lenient:
   * a bad replay should show an error state, not crash the page. Returns null on anything malformed. */
  function decodeTrace(enc) {
    if (!enc || typeof enc !== "object") return null;
    const cols = ["t", "lat", "lon", "alt", "hdg", "pitch", "roll"];
    const arrs = cols.map((c) => enc[c]);
    if (arrs.some((a) => !Array.isArray(a))) return null;
    const n = arrs[0].length;
    if (n < 2 || arrs.some((a) => a.length !== n)) return null;
    const rows = [];
    let t = 0;
    for (let i = 0; i < n; i++) {
      const vals = arrs.map((a) => a[i]);
      if (vals.some((v) => typeof v !== "number" || !Number.isFinite(v))) return null;
      t = i === 0 ? vals[0] : t + vals[0];
      rows.push({ t, lat: vals[1], lon: vals[2], alt: vals[3], hdg: vals[4], pitch: vals[5], roll: vals[6] });
    }
    return rows;
  }

  /** Lat/lon at time `t` (ms) along a decoded trace, linearly interpolated between the two samples
   * that straddle it. Clamps to the first/last sample outside the trace's own time range. */
  function sampleTraceAt(rows, t) {
    if (!rows || !rows.length) return null;
    if (t <= rows[0].t) return rows[0];
    if (t >= rows[rows.length - 1].t) return rows[rows.length - 1];
    let lo = 0, hi = rows.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (rows[mid].t <= t) lo = mid; else hi = mid;
    }
    const a = rows[lo], b = rows[hi];
    const f = (t - a.t) / ((b.t - a.t) || 1);
    return { lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f };
  }

  function fmtClock(ms) {
    if (ms == null || !Number.isFinite(ms)) return "—";
    const m = Math.floor(ms / 60000), s = (ms % 60000) / 1000;
    return m + ":" + (s < 10 ? "0" : "") + s.toFixed(3);
  }

  function fmtNum(n) {
    return n == null ? "—" : Number(n).toLocaleString();
  }

  function timeAgo(unixSeconds, nowMs) {
    const now = nowMs == null ? Date.now() : nowMs;
    const s = Math.max(0, Math.round(now / 1000 - unixSeconds));
    if (s < 90) return "just now";
    if (s < 5400) return Math.round(s / 60) + " min ago";
    if (s < 129600) return Math.round(s / 3600) + " h ago";
    return Math.round(s / 86400) + " d ago";
  }

  function slug(s) {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  }

  // ================================================================== medals
  // The one place the medal cut-offs live. A time earns a medal by how close it is to the course
  // record: gold within 2 %, silver within 5 %, bronze within 10 %. The record itself is gold.
  const MEDAL_THRESHOLDS = Object.freeze({ gold: 1.02, silver: 1.05, bronze: 1.10 });
  const MEDAL_ORDER = Object.freeze(["gold", "silver", "bronze"]);

  function medalFor(timeMs, recordMs) {
    if (!(timeMs > 0) || !(recordMs > 0) || !Number.isFinite(timeMs) || !Number.isFinite(recordMs)) return null;
    for (const m of MEDAL_ORDER) {
      // A tiny epsilon so a time exactly on the line (102000 vs 100000) is not lost to float noise.
      if (timeMs <= recordMs * MEDAL_THRESHOLDS[m] + 1e-6) return m;
    }
    return null;
  }

  /** How far off the next medal up a time is, in ms (0 when it already holds gold, null for no data). */
  function msToNextMedal(timeMs, recordMs) {
    if (!(timeMs > 0) || !(recordMs > 0)) return null;
    const have = medalFor(timeMs, recordMs);
    const idx = have ? MEDAL_ORDER.indexOf(have) : MEDAL_ORDER.length;
    if (idx === 0) return 0;
    const target = MEDAL_ORDER[idx - 1];
    return Math.max(0, Math.ceil(timeMs - recordMs * MEDAL_THRESHOLDS[target]));
  }

  // ================================================================== formatting
  const fmtRaceTime = fmtClock;

  /** A gap between two times: "+1.300", "−0.042" (a real minus sign), "0.000". */
  function fmtGap(ms) {
    if (ms == null || !Number.isFinite(ms)) return "—";
    if (Math.round(Math.abs(ms)) === 0) return "0.000";
    return (ms > 0 ? "+" : "−") + (Math.abs(ms) / 1000).toFixed(3);
  }

  /** A duration in seconds as a short human string: "12 min", "5 h", "3 d", "1 y 20 d". */
  function fmtDuration(sec) {
    if (sec == null || !Number.isFinite(sec) || sec < 0) return "—";
    if (sec < 60) return "<1 min";
    if (sec < 3600) return Math.floor(sec / 60) + " min";
    if (sec < 172800) return Math.floor(sec / 3600) + " h";
    const days = Math.floor(sec / 86400);
    if (days < 365) return days + " d";
    const y = Math.floor(days / 365), d = days % 365;
    return y + " y" + (d ? " " + d + " d" : "");
  }

  /** How long a record has stood: seconds from `setAtUnix` to `nowMs`, never negative. */
  function reignSeconds(setAtUnix, nowMs) {
    if (!Number.isFinite(setAtUnix)) return null;
    return Math.max(0, Math.floor((nowMs == null ? Date.now() : nowMs) / 1000 - setAtUnix));
  }

  function fmtDate(unixSeconds) {
    if (!Number.isFinite(unixSeconds)) return "—";
    const d = new Date(unixSeconds * 1000);
    const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()];
    return d.getUTCDate() + " " + mon + " " + d.getUTCFullYear();
  }

  function fmtKm(km) {
    return km == null || !Number.isFinite(+km) ? "—" : (+km).toFixed(+km < 10 ? 1 : 0) + " km";
  }

  // ================================================================== geometry
  const R_EARTH = 6371008.8;
  const D2R = Math.PI / 180;

  function wrap360(a) { return ((a % 360) + 360) % 360; }
  function angleDelta(a, b) { return ((((b - a + 540) % 360) + 360) % 360) - 180; }
  function angleLerp(a, b, f) { return a + angleDelta(a, b) * f; }

  /** Great-circle ground distance in metres. */
  function haversineM(lat1, lon1, lat2, lon2) {
    const dLat = (lat2 - lat1) * D2R, dLon = (lon2 - lon1) * D2R;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * D2R) * Math.cos(lat2 * D2R) * Math.sin(dLon / 2) ** 2;
    return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  /** Local east/north/up metres of `p` relative to `origin` — flat-earth, fine over a few km. */
  function enu(origin, p) {
    return {
      x: angleDelta(origin.lon, p.lon) * D2R * R_EARTH * Math.cos(origin.lat * D2R),
      y: (p.lat - origin.lat) * D2R * R_EARTH,
      z: (p.alt || 0) - (origin.alt || 0),
    };
  }

  function dist3(a, b) {
    const d = enu(a, b);
    return Math.sqrt(d.x * d.x + d.y * d.y + d.z * d.z);
  }

  /** Total length of a gate polyline in metres (ground distance). */
  function pathLengthM(points) {
    let m = 0;
    for (let i = 1; i < (points || []).length; i++) m += haversineM(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon);
    return m;
  }

  // ================================================================== traces
  /** Strict decode for anything that drives 3D: decodeTrace() plus race.js traceDecode's
   * invariants (version 1 when stated, n matches, t strictly increasing, lat/lon in range). */
  function traceRows(enc) {
    if (!enc || typeof enc !== "object") return null;
    if (enc.v != null && +enc.v !== 1) return null;
    const rows = decodeTrace(enc);
    if (!rows) return null;
    if (enc.n != null && +enc.n !== rows.length) return null;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (Math.abs(r.lat) > 90 || Math.abs(r.lon) > 180) return null;
      if (i > 0 && r.t <= rows[i - 1].t) return null;
    }
    return rows;
  }

  /** Full attitude + position at t (ms): linear in position, shortest-arc in every angle —
   * race.js traceSampleAt, over decodeTrace's row objects. `ended` is true at/after the last row. */
  function traceStateAt(rows, t) {
    if (!rows || !rows.length || !Number.isFinite(t)) return null;
    const at = (r, ended) => ({ t: r.t, lat: r.lat, lon: r.lon, alt: r.alt, hdg: wrap360(r.hdg), pitch: r.pitch, roll: r.roll, ended });
    if (t <= rows[0].t) return at(rows[0], false);
    const last = rows[rows.length - 1];
    if (t >= last.t) return at(last, true);
    let lo = 0, hi = rows.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (rows[mid].t <= t) lo = mid; else hi = mid; }
    const a = rows[lo], b = rows[hi];
    const f = (t - a.t) / ((b.t - a.t) || 1);
    return {
      t, lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + angleDelta(a.lon, b.lon) * f, alt: a.alt + (b.alt - a.alt) * f,
      hdg: wrap360(angleLerp(a.hdg, b.hdg, f)), pitch: angleLerp(a.pitch, b.pitch, f), roll: angleLerp(a.roll, b.roll, f),
      ended: false,
    };
  }

  /** Recorded heading/pitch/roll (degrees, GeoFS convention) + a model's index.json offset ->
   * radians for Cesium.HeadingPitchRoll. Same sum race.js applyModelTransform() does. */
  function hprRadians(hdg, pitch, roll, offset) {
    const off = offset || {};
    return {
      heading: ((+hdg || 0) + (+off.headingDeg || 0)) * D2R,
      pitch: ((+pitch || 0) + (+off.pitchDeg || 0)) * D2R,
      roll: ((+roll || 0) + (+off.rollDeg || 0)) * D2R,
    };
  }

  /** Speed (m/s) at every row: central difference in 3D, one-sided at the ends. */
  function traceSpeeds(rows) {
    const n = (rows || []).length;
    const out = new Array(n).fill(0);
    if (n < 2) return out;
    for (let i = 0; i < n; i++) {
      const a = rows[Math.max(0, i - 1)], b = rows[Math.min(n - 1, i + 1)];
      const dt = (b.t - a.t) / 1000;
      out[i] = dt > 0 ? dist3(a, b) / dt : 0;
    }
    return out;
  }

  const SPEED_RAMP = [[0, [0x6b, 0x4a, 0xa8]], [0.45, [0xff, 0x8a, 0x3d]], [0.8, [0xff, 0x3d, 0x8b]], [1, [0xff, 0xd2, 0x3d]]];
  /** Speed -> "#rrggbb" along the sunset ramp (slow plum -> orange -> pink -> sun). */
  function speedColor(v, vMin, vMax) {
    const span = vMax - vMin;
    let f = span > 0 ? (v - vMin) / span : 0.5;
    f = Math.max(0, Math.min(1, Number.isFinite(f) ? f : 0.5));
    let i = 1;
    while (i < SPEED_RAMP.length - 1 && f > SPEED_RAMP[i][0]) i++;
    const [f0, c0] = SPEED_RAMP[i - 1], [f1, c1] = SPEED_RAMP[i];
    const k = (f - f0) / ((f1 - f0) || 1);
    return "#" + c0.map((c, j) => Math.round(c + (c1[j] - c) * k).toString(16).padStart(2, "0")).join("");
  }

  /** When did the trace cross each gate? Forward-only, like race.js: gate k is searched for only
   * after gate k-1 was found, so a circuit that re-uses a spot can't snap back to an earlier pass.
   * A crossing is the closest approach to the gate centre that comes within `slack` radii, refined
   * to the nearest point on the neighbouring segments. Returns [{gate, t, i, missM}] with null for
   * any gate never approached (the rest of the search continues from where it stood). */
  function gateCrossings(rows, gates, slack) {
    const out = [];
    if (!rows || rows.length < 2 || !gates || !gates.length) return (gates || []).map(() => null);
    const k = slack || 2.5;
    let hint = 0;
    for (let g = 0; g < gates.length; g++) {
      const gate = gates[g];
      const lim = (gate.radius || 100) * k;
      let best = -1, bestD = Infinity;
      for (let i = hint; i < rows.length; i++) {
        const d = dist3(gate, rows[i]);
        if (d <= lim && d < bestD) { best = i; bestD = d; }
        else if (best >= 0 && d > bestD) break;   // past the closest approach
      }
      if (best < 0) { out.push(null); continue; }
      // Refine inside the segments either side of the closest sample.
      let tBest = rows[best].t, dBest = bestD;
      for (const j of [best - 1, best]) {
        if (j < 0 || j + 1 >= rows.length) continue;
        const a = enu(gate, rows[j]), b = enu(gate, rows[j + 1]);
        const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
        const len2 = abx * abx + aby * aby + abz * abz;
        const f = len2 > 0 ? Math.max(0, Math.min(1, -(a.x * abx + a.y * aby + a.z * abz) / len2)) : 0;
        const px = a.x + abx * f, py = a.y + aby * f, pz = a.z + abz * f;
        const d = Math.sqrt(px * px + py * py + pz * pz);
        if (d < dBest) { dBest = d; tBest = rows[j].t + (rows[j + 1].t - rows[j].t) * f; }
      }
      out.push({ gate: g, t: tBest, i: best, missM: dBest });
      hint = best;
    }
    return out;
  }

  /** Gate-to-gate leg times from crossings (null wherever either end is missing). Leg i runs from
   * gate i to gate i+1. */
  function sectorTimes(crossings) {
    const out = [];
    for (let i = 1; i < (crossings || []).length; i++) {
      const a = crossings[i - 1], b = crossings[i];
      out.push(a && b ? b.t - a.t : null);
    }
    return out;
  }

  /** For a list of pilots' sector arrays, the index of the pilot with the fastest time in each
   * sector (null when nobody has one). Ties go to the earlier pilot. */
  function bestSectors(sectorLists) {
    const lists = sectorLists || [];
    const n = Math.max(0, ...lists.map((s) => (s || []).length));
    const out = [];
    for (let i = 0; i < n; i++) {
      let who = null, best = Infinity;
      lists.forEach((s, p) => { const v = s && s[i]; if (v != null && v < best) { best = v; who = p; } });
      out.push(who);
    }
    return out;
  }

  /** Delta vs a reference trace along the path: for each of my samples, my time minus the
   * reference's time at the same PLACE (nearest reference sample, searched forward only from the
   * last match, race.js traceNearest-style). Negative = I got there sooner. Returns [{t, delta}]. */
  function deltaVsReference(rows, refRows, windowN) {
    const out = [];
    if (!rows || !refRows || !rows.length || !refRows.length) return out;
    const w = windowN || 40;
    let hint = 0;
    for (const r of rows) {
      let best = hint, bestD = Infinity;
      const end = Math.min(refRows.length - 1, hint + w);
      for (let i = hint; i <= end; i++) {
        const d = dist3(r, refRows[i]);
        if (d < bestD) { bestD = d; best = i; }
      }
      hint = best;
      out.push({ t: r.t, delta: r.t - refRows[best].t });
    }
    return out;
  }

  /** Race order at time t from each pilot's gate crossings. Progress is gates passed plus the
   * fraction of the pilot's own current leg that has elapsed. The gap to the leader is how long ago
   * the leader was where this pilot is now (same progress, interpolated inside the leader's leg),
   * so it moves continuously rather than only changing at gates. `pilots` is [{id, crossings,
   * finishMs}]. Returns [{id, progress, gapMs, finished}]. */
  function raceOrderAt(pilots, t) {
    const rows = (pilots || []).map((p) => {
      const cr = p.crossings || [];
      let k = -1;
      for (let i = 0; i < cr.length; i++) if (cr[i] && cr[i].t <= t) k = i;
      let progress = k + 1;
      const cur = k >= 0 ? cr[k] : null;
      let next = null;
      for (let i = k + 1; i < cr.length && !next; i++) if (cr[i]) next = cr[i];
      if (next && cur && next.t > cur.t) progress += Math.min(0.999, (t - cur.t) / (next.t - cur.t)) * ((next.gate - cur.gate) || 1);
      const finished = p.finishMs != null && t >= p.finishMs;
      return { id: p.id, progress, k, cr, finished };
    });
    const lastT = (r) => (r.k >= 0 && r.cr[r.k] ? r.cr[r.k].t : 0);
    rows.sort((a, b) => b.progress - a.progress || lastT(a) - lastT(b));
    const lead = rows[0];
    // When was the leader at progress `pr`? (progress 1 = crossing gate index 0)
    const leaderTimeAt = (pr) => {
      const i = Math.floor(pr) - 1, f = pr - Math.floor(pr);
      const a = lead && lead.cr[i], b = lead && lead.cr[i + 1];
      if (!a) return null;
      return b ? a.t + (b.t - a.t) * f : a.t;
    };
    return rows.map((r) => {
      let gapMs = null;
      if (r === lead) gapMs = 0;
      else if (r.finished && lead.finished && r.cr[r.cr.length - 1] && lead.cr[lead.cr.length - 1]) gapMs = r.cr[r.cr.length - 1].t - lead.cr[lead.cr.length - 1].t;
      else if (r.k >= 0) { const lt = leaderTimeAt(r.progress); if (lt != null) gapMs = Math.max(0, t - lt); }
      return { id: r.id, progress: r.progress, gapMs, finished: r.finished };
    });
  }

  // ================================================================== boards -> records, medals, pilots
  // A "board" is GET /leaderboard's rows for one course_hash: [{callsign, time_ms, model,
  // aircraft_id, created_at, attempts, has_ghost}], best first. `boards` maps course_hash -> rows.
  // `courses` maps course_hash -> {course_id, course_name, cup} for naming.

  function buildRecords(boards, courses, nowMs) {
    const out = [];
    for (const hash of Object.keys(boards || {})) {
      const rows = boards[hash] || [];
      if (!rows.length) continue;
      const top = rows[0], second = rows[1] || null;
      const c = (courses && courses[hash]) || {};
      out.push({
        course_hash: hash, course_id: c.course_id || null, course_name: c.course_name || hash, cup: c.cup || null,
        holder: top.callsign, time_ms: top.time_ms, model: top.model || "", set_at: top.created_at,
        second: second ? { callsign: second.callsign, time_ms: second.time_ms } : null,
        margin_ms: second ? second.time_ms - top.time_ms : null,
        reign_s: reignSeconds(top.created_at, nowMs), pilots: rows.length,
      });
    }
    out.sort((a, b) => (b.set_at || 0) - (a.set_at || 0) || a.course_name.localeCompare(b.course_name));
    return out;
  }

  /** A comparator for medal-table rows by `key` (desc; asc when `asc`), then gold/silver/bronze,
   * then callsign. */
  function medalSort(key, asc) {
    return (a, b) => {
      const k = key === "callsign" ? b.callsign.localeCompare(a.callsign) : (b[key] - a[key]);
      const primary = asc ? -k : k;
      return primary || b.gold - a.gold || b.silver - a.silver || b.bronze - a.bronze || a.callsign.localeCompare(b.callsign);
    };
  }

  function medalTable(boards) {
    const by = new Map();
    const row = (cs) => {
      if (!by.has(cs)) by.set(cs, { callsign: cs, gold: 0, silver: 0, bronze: 0, total: 0, records: 0 });
      return by.get(cs);
    };
    for (const hash of Object.keys(boards || {})) {
      const rows = boards[hash] || [];
      if (!rows.length) continue;
      const rec = rows[0].time_ms;
      rows.forEach((r, i) => {
        const m = medalFor(r.time_ms, rec);
        const x = row(r.callsign);
        if (i === 0) x.records++;
        if (m) { x[m]++; x.total++; }
      });
    }
    return [...by.values()].sort(medalSort("gold"));
  }

  /** Every course where both pilots have a time: who is faster, and the W-L. */
  function headToHead(boards, a, b, courses) {
    const res = { a, b, wins: 0, losses: 0, ties: 0, courses: [] };
    for (const hash of Object.keys(boards || {})) {
      const rows = boards[hash] || [];
      const ra = rows.find((r) => r.callsign === a), rb = rows.find((r) => r.callsign === b);
      if (!ra || !rb) continue;
      const winner = ra.time_ms < rb.time_ms ? a : rb.time_ms < ra.time_ms ? b : null;
      if (winner === a) res.wins++; else if (winner === b) res.losses++; else res.ties++;
      const c = (courses && courses[hash]) || {};
      res.courses.push({ course_hash: hash, course_id: c.course_id || null, course_name: c.course_name || hash, a_ms: ra.time_ms, b_ms: rb.time_ms, winner });
    }
    res.courses.sort((x, y) => x.course_name.localeCompare(y.course_name));
    return res;
  }

  /** One pilot vs everyone they share a course with, most shared courses first. */
  function rivals(boards, a, courses) {
    const others = new Set();
    for (const hash of Object.keys(boards || {})) {
      const rows = boards[hash] || [];
      if (rows.some((r) => r.callsign === a)) rows.forEach((r) => { if (r.callsign !== a) others.add(r.callsign); });
    }
    return [...others].map((b) => headToHead(boards, a, b, courses))
      .sort((x, y) => y.courses.length - x.courses.length || x.b.localeCompare(y.b));
  }

  /** Everything the pilot page shows, from the boards plus /races/recent. */
  function pilotSummary(boards, courses, recentRaces, callsign) {
    const pbs = [];
    const medals = { gold: 0, silver: 0, bronze: 0 };
    let records = 0, runs = 0, lastSeen = null, lastModel = "";
    for (const hash of Object.keys(boards || {})) {
      const rows = boards[hash] || [];
      const idx = rows.findIndex((r) => r.callsign === callsign);
      if (idx < 0) continue;
      const r = rows[idx];
      const medal = medalFor(r.time_ms, rows[0].time_ms);
      if (medal) medals[medal]++;
      if (idx === 0) records++;
      runs += r.attempts || 0;
      if (lastSeen == null || r.created_at > lastSeen) { lastSeen = r.created_at; lastModel = r.model || lastModel; }
      const c = (courses && courses[hash]) || {};
      pbs.push({ course_hash: hash, course_id: c.course_id || null, course_name: c.course_name || hash, cup: c.cup || null,
        time_ms: r.time_ms, rank: idx + 1, of: rows.length, medal, attempts: r.attempts || 0, set_at: r.created_at,
        record_ms: rows[0].time_ms, gap_ms: r.time_ms - rows[0].time_ms, has_ghost: !!r.has_ghost });
    }
    pbs.sort((x, y) => x.course_name.localeCompare(y.course_name));
    const fav = pbs.slice().sort((x, y) => y.attempts - x.attempts || x.course_name.localeCompare(y.course_name))[0] || null;
    let lobbyRaces = 0, wins = 0, podiums = 0;
    const activity = [];
    for (const race of recentRaces || []) {
      const me = (race.results || []).find((x) => x.callsign === callsign);
      if (!me) continue;
      lobbyRaces++;
      if (me.status === "finished" && me.pos === 1) wins++;
      if (me.status === "finished" && me.pos <= 3) podiums++;
      activity.push({ kind: "race", at: race.started_at, course_name: race.course_name, course_hash: race.course_hash,
        pos: me.pos, status: me.status, of: (race.results || []).length, points: me.points, cup_name: race.cup_name || null });
    }
    for (const pb of pbs) activity.push({ kind: "pb", at: pb.set_at, course_name: pb.course_name, course_id: pb.course_id, time_ms: pb.time_ms, rank: pb.rank });
    activity.sort((x, y) => (y.at || 0) - (x.at || 0));
    return { callsign, pbs, medals, records, runs, courses: pbs.length, lobbyRaces, wins, podiums,
      favourite: fav ? { course_name: fav.course_name, course_id: fav.course_id, attempts: fav.attempts } : null,
      lastSeen, lastModel, activity: activity.slice(0, 20) };
  }

  /** Every callsign that appears anywhere, most courses first. */
  function pilotIndex(boards, recentRaces) {
    const m = new Map();
    for (const hash of Object.keys(boards || {})) for (const r of boards[hash] || []) m.set(r.callsign, (m.get(r.callsign) || 0) + 1);
    for (const race of recentRaces || []) for (const r of race.results || []) if (!m.has(r.callsign)) m.set(r.callsign, 0);
    return [...m.entries()].map(([callsign, courses]) => ({ callsign, courses }))
      .sort((a, b) => b.courses - a.courses || a.callsign.localeCompare(b.callsign));
  }

  /** The home page's "latest records" feed as token lists the UI turns into text + links.
   * Honest wording: without record history we know who holds it and by how much, not who they
   * took it from (that needs /records/history; see dethronedFeed). */
  function recordFeed(records, limit) {
    return (records || []).slice(0, limit || 6).map((r) => {
      const parts = [{ pilot: r.holder }, { text: r.second ? " holds " : " set the first time on " }, { course: r.course_name, course_id: r.course_id }];
      if (r.second) parts.push({ text: " — " + (r.margin_ms / 1000).toFixed(1) + " s clear of " }, { pilot: r.second.callsign });
      return { parts, at: r.set_at, time_ms: r.time_ms };
    });
  }

  // ================================================================== courses
  /** "Budapest Danube Chain Bridge (3 laps, hard)" -> {title, laps: 3, tag: "hard"}. */
  function parseCourseName(name) {
    const s = String(name || "").trim();
    const m = /\s*\(([^()]*)\)\s*$/.exec(s);
    if (!m) return { title: s, laps: 1, tag: null };
    const bits = m[1].split(",").map((x) => x.trim()).filter(Boolean);
    let laps = 1, tag = null;
    for (const b of bits) {
      const l = /^(\d+)\s*laps?$/i.exec(b);
      if (l) laps = Math.max(1, +l[1]); else tag = tag || b;
    }
    return { title: s.slice(0, m.index).trim() || s, laps, tag };
  }

  /** Course class from what the catalog has (the catalog has no explicit field): pylon or bush by cup. */
  function courseClass(cup, id) {
    const s = (cup || "") + " " + (id || "");
    if (/pylon/i.test(s)) return "pylon";
    if (/\bbush\b/i.test(s)) return "bush";
    return "race";
  }

  /** Deterministic course of the week: weeks since Monday 1970-01-05 UTC, over courses sorted by
   * id, so every visitor sees the same one and it changes at Monday 00:00 UTC. */
  function courseOfWeek(catalog, nowMs) {
    const list = (catalog || []).slice().sort((a, b) => String(a.course_id).localeCompare(String(b.course_id)));
    if (!list.length) return null;
    const week = Math.floor(((nowMs == null ? Date.now() : nowMs) - Date.UTC(1970, 0, 5)) / (7 * 86400000));
    return list[((week % list.length) + list.length) % list.length];
  }

  /** Aspect-correct route mini-map: lon is scaled by cos(mean lat) so a square course draws square,
   * then fit and centred in w x h with `pad`. Returns {points, d, start, finish, closed}. `closed`
   * is true when the last gate sits on the first (an unrolled circuit), and then finish = start. */
  function routeMiniMap(gates, w, h, pad) {
    const pts = (gates || []).filter((g) => Number.isFinite(g.lat) && Number.isFinite(g.lon));
    if (!pts.length) return { points: [], d: "", start: null, finish: null, closed: false };
    const P = makeProjector(pts, w, h, pad);
    const points = pts.map((g) => P(g.lat, g.lon));
    const last = pts[pts.length - 1];
    const closed = pts.length > 2 && haversineM(pts[0].lat, pts[0].lon, last.lat, last.lon) < (pts[0].radius || 100);
    return { points, d: buildTracePath(points), start: points[0], finish: points[points.length - 1], closed, project: P };
  }

  /** The projection routeMiniMap uses, as a function: fit `points` (lat/lon) aspect-correct into
   * w x h with `pad`, north up. Any other lat/lon (a ghost) projects into the same frame. */
  function makeProjector(points, w, h, pad) {
    const pts = (points || []).filter((g) => Number.isFinite(g.lat) && Number.isFinite(g.lon));
    const lat0 = pts.length ? pts.reduce((s, g) => s + g.lat, 0) / pts.length : 0;
    const k = Math.cos(lat0 * D2R) || 1e-9;
    const xs = pts.map((g) => g.lon * k), ys = pts.map((g) => g.lat);
    const minX = pts.length ? Math.min(...xs) : 0, maxX = pts.length ? Math.max(...xs) : 0;
    const minY = pts.length ? Math.min(...ys) : 0, maxY = pts.length ? Math.max(...ys) : 0;
    const spanX = maxX - minX, spanY = maxY - minY;
    const innerW = Math.max(1, w - 2 * pad), innerH = Math.max(1, h - 2 * pad);
    const scale = Math.min(spanX > 0 ? innerW / spanX : Infinity, spanY > 0 ? innerH / spanY : Infinity);
    const s = Number.isFinite(scale) ? scale : 1;
    const offX = pad + (innerW - spanX * s) / 2, offY = pad + (innerH - spanY * s) / 2;
    return (lat, lon) => ({ x: +(offX + (lon * k - minX) * s).toFixed(2), y: +(offY + (maxY - lat) * s).toFixed(2) });
  }

  /** Terrarium PNG pixel -> metres (AWS Terrain Tiles). */
  function terrariumHeight(r, g, b) { return r * 256 + g + b / 256 - 32768; }

  /** Web-Mercator tile + pixel for a lat/lon at zoom z (256 px tiles). */
  function lonLatToTile(lat, lon, z) {
    const n = 2 ** z;
    const latR = Math.max(-85.05112878, Math.min(85.05112878, lat)) * D2R;
    const fx = ((lon + 180) / 360) * n;
    const fy = ((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2) * n;
    const x = Math.min(n - 1, Math.max(0, Math.floor(fx))), y = Math.min(n - 1, Math.max(0, Math.floor(fy)));
    return { z, x, y, px: Math.min(255, Math.floor((fx - x) * 256)), py: Math.min(255, Math.floor((fy - y) * 256)) };
  }

  /** Stations every `stepM` metres along the gate polyline with the gate-to-gate altitude
   * interpolated: [{d, lat, lon, alt, gate}] (`gate` set on stations that are gates). */
  function profileStations(gates, stepM) {
    const out = [];
    const g = (gates || []).filter((x) => Number.isFinite(x.lat) && Number.isFinite(x.lon));
    if (!g.length) return out;
    const step = Math.max(10, stepM || 250);
    let d = 0;
    out.push({ d: 0, lat: g[0].lat, lon: g[0].lon, alt: g[0].alt || 0, gate: 0 });
    for (let i = 1; i < g.length; i++) {
      const a = g[i - 1], b = g[i];
      const len = haversineM(a.lat, a.lon, b.lat, b.lon);
      const n = Math.max(1, Math.ceil(len / step - 1e-6));
      for (let j = 1; j <= n; j++) {
        const f = j / n;
        out.push({ d: d + len * f, lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + angleDelta(a.lon, b.lon) * f,
          alt: (a.alt || 0) + ((b.alt || 0) - (a.alt || 0)) * f, gate: j === n ? i : null });
      }
      d += len;
    }
    return out;
  }

  /** Stations (+ optional ground heights, aligned) -> SVG paths for an elevation chart in w x h.
   * Returns {alt, ground, gates: [{x, y, gate}], minY, maxY, lengthM}. */
  function profilePaths(stations, ground, w, h, pad) {
    const st = stations || [];
    if (!st.length) return { alt: "", ground: "", gates: [], minY: 0, maxY: 0, lengthM: 0 };
    const p = pad || 0;
    const useGround = !!(ground && ground.length === st.length && ground.every(Number.isFinite));
    const hs = st.map((s) => s.alt).concat(useGround ? ground : []);
    let lo = Math.min(...hs), hi = Math.max(...hs);
    if (hi - lo < 50) { hi += 25; lo -= 25; }
    const L = st[st.length - 1].d || 1;
    const X = (d) => p + (d / L) * (w - 2 * p), Y = (v) => p + (1 - (v - lo) / (hi - lo)) * (h - 2 * p);
    const alt = buildTracePath(st.map((s) => ({ x: X(s.d), y: Y(s.alt) })));
    let groundD = "";
    if (useGround) {
      groundD = buildTracePath(st.map((s, i) => ({ x: X(s.d), y: Y(ground[i]) }))) +
        " L" + X(L).toFixed(2) + "," + (h - p).toFixed(2) + " L" + X(0).toFixed(2) + "," + (h - p).toFixed(2) + " Z";
    }
    const gates = st.filter((s) => s.gate != null).map((s) => ({ x: X(s.d), y: Y(s.alt), gate: s.gate }));
    return { alt, ground: groundD, gates, minY: lo, maxY: hi, lengthM: L };
  }

  // ================================================================== CSP
  /** Would this Content-Security-Policy string let the page fetch/load `url` under `directive`
   * (e.g. "connect-src")? Falls back to default-src like the browser does. Understands '*',
   * 'self', scheme sources ("https:") and host sources with an optional path prefix. Anything it
   * doesn't understand counts as "not allowed", so the caller stays quiet rather than noisy. */
  function cspAllows(csp, directive, url, selfOrigin) {
    if (!csp) return true;
    const dirs = {};
    for (const part of String(csp).split(";")) {
      const bits = part.trim().split(/\s+/).filter(Boolean);
      if (bits.length) dirs[bits[0].toLowerCase()] = bits.slice(1);
    }
    const list = dirs[directive] || dirs["default-src"];
    if (!list) return true;
    let u;
    try { u = new URL(url, selfOrigin); } catch (_) { return false; }
    for (const tok of list) {
      const t = tok.toLowerCase();
      if (t === "*") return true;
      if (t === "'self'" && selfOrigin && u.origin === new URL(selfOrigin).origin) return true;
      if (/^[a-z][a-z0-9+.-]*:$/.test(t) && u.protocol === t) return true;
      if (t.startsWith("'")) continue;
      const m = /^(?:([a-z][a-z0-9+.-]*):\/\/)?([^/]+)(\/.*)?$/.exec(t);
      if (!m) continue;
      if (m[1] && m[1] + ":" !== u.protocol) continue;
      const host = m[2];
      const hostOk = host.startsWith("*.") ? u.host.endsWith(host.slice(1)) : u.host === host;
      if (hostOk && (!m[3] || u.pathname.startsWith(m[3]))) return true;
    }
    return false;
  }

  // ================================================================== routing
  const ROUTES = [
    ["home", /^\/?$/],
    ["courses", /^\/courses\/?$/],
    ["course", /^\/course\/([^/]+)\/?$/],
    ["raceReplay", /^\/replay\/race\/(\d+)\/?$/],
    ["replay", /^\/replay\/([^/]+)\/?$/],
    ["pilot", /^\/pilot\/([^/]+)\/?$/],
    ["records", /^\/records\/?$/],
    ["cups", /^\/cups\/?$/],
    ["cup", /^\/cup\/(\d+)\/?$/],
    ["landing", /^\/landing\/?$/],
    ["install", /^\/install\/?$/],
  ];
  // The old one-page site linked by section anchor; keep those bookmarks working.
  const LEGACY_ANCHORS = { top: "home", departures: "home", races: "cups", cups: "cups", records: "records", install: "install" };

  function safeDecode(s) { try { return decodeURIComponent(s); } catch (_) { return s; } }

  /** "#/replay/crater-rim?pilots=Eric,Dave&t=42.5" -> {name, id, query:{pilots:[..], t: 42.5}}. */
  function parseRoute(hash) {
    const h = String(hash || "").replace(/^#/, "");
    if (h && h[0] !== "/" && !h.includes("/")) {
      const legacy = LEGACY_ANCHORS[h];
      return { name: legacy || "home", id: null, query: {}, anchor: legacy === "home" ? h : null, unknownAnchor: !legacy };
    }
    const qi = h.indexOf("?");
    const path = qi >= 0 ? h.slice(0, qi) : h;
    const qs = qi >= 0 ? h.slice(qi + 1) : "";
    const query = {};
    for (const part of qs.split("&")) {
      if (!part) continue;
      const eq = part.indexOf("=");
      const k = safeDecode(eq >= 0 ? part.slice(0, eq) : part), v = eq >= 0 ? part.slice(eq + 1) : "";
      if (k === "pilots") query.pilots = v.split(",").map(safeDecode).map((s) => s.trim()).filter(Boolean).slice(0, 8);
      else if (k === "t") { const t = parseFloat(v); if (Number.isFinite(t) && t >= 0) query.t = t; }
      else query[k] = safeDecode(v);
    }
    for (const [name, re] of ROUTES) {
      const m = re.exec(path);
      if (m) return { name, id: m[1] != null ? safeDecode(m[1]) : null, query };
    }
    return { name: "notfound", id: null, query, path };
  }

  /** The inverse of parseRoute: buildRoute("replay", "crater-rim", {pilots:["a","b"], t: 4.2}). */
  // Route names whose path is not simply the name.
  const ROUTE_PATHS = { raceReplay: "replay/race" };

  function buildRoute(name, id, query) {
    const base = name === "home" ? "#/" : "#/" + (ROUTE_PATHS[name] || name) + (id != null ? "/" + encodeURIComponent(id) : "");
    const q = [];
    const qq = query || {};
    if (qq.pilots && qq.pilots.length) q.push("pilots=" + qq.pilots.map(encodeURIComponent).join(","));
    if (Number.isFinite(qq.t)) q.push("t=" + (Math.round(qq.t * 10) / 10));
    for (const k of Object.keys(qq)) {
      if (k !== "pilots" && k !== "t" && qq[k] != null && qq[k] !== "") q.push(encodeURIComponent(k) + "=" + encodeURIComponent(qq[k]));
    }
    return base + (q.length ? "?" + q.join("&") : "");
  }

  // ================================================================== replay director
  const DIRECTOR = Object.freeze({ MIN_HOLD_S: 2.5, MAX_HOLD_S: 12, GATE_SHOT_S: 3 });

  /** One step of the auto-director. `frame` = {t (s), order: [ids, leader first], crossings:
   * [{id, gate}] that happened since the last step}. It follows the leader in a chase shot, cuts to
   * whoever takes the lead (or makes any pass, less eagerly), cuts to a gate-cam when the followed
   * pilot crosses a gate, and rotates chase/orbit when nothing happens for MAX_HOLD_S. Never cuts
   * sooner than MIN_HOLD_S after the last cut. Returns the new state {target, shot, gate, since,
   * reason, lastOrder}. */
  function directorStep(state, frame) {
    const s = state || {};
    const t = frame.t, order = frame.order || [];
    const held = s.since == null ? Infinity : t - s.since;
    const cut = (target, shot, reason, gate) => ({ target, shot, gate: gate == null ? null : gate, since: t, reason, lastOrder: order.slice() });
    const keep = () => Object.assign({}, s, { lastOrder: order.slice() });
    if (!order.length) return keep();
    if (!s.target || !order.includes(s.target)) return cut(order[0], "chase", "start");
    if (held < DIRECTOR.MIN_HOLD_S) return keep();
    const prev = s.lastOrder || [];
    if (prev.length && prev[0] !== order[0]) return cut(order[0], "chase", "lead-change");
    if (s.shot === "gate" && held >= DIRECTOR.GATE_SHOT_S) return cut(s.target, "chase", "gate-done");
    const mine = (frame.crossings || []).find((c) => c.id === s.target);
    if (mine && s.shot !== "gate") return cut(s.target, "gate", "gate", mine.gate);
    if (prev.length && held >= DIRECTOR.MIN_HOLD_S * 2) {
      for (let i = 1; i < order.length; i++) {
        const was = prev.indexOf(order[i]);
        if (was > i) return cut(order[i], "chase", "overtake");
      }
    }
    if (held >= DIRECTOR.MAX_HOLD_S) return cut(order[0], s.shot === "chase" ? "orbit" : "chase", "rotate");
    return keep();
  }

  // ================================================================== replay sources
  const REPLAY_MAX = 8;

  /** GET /ghost documents ({callsign, time_ms, model, created_at, trace}) -> replay pilots, fastest
   * first. A ghost whose trace doesn't decode is left out and named in `dropped`. */
  function replayFromGhosts(docs) {
    const pilots = [], dropped = [];
    for (const d of docs || []) {
      const rows = d && traceRows(d.trace);
      if (!rows) { if (d && d.callsign) dropped.push(d.callsign); continue; }
      pilots.push({ id: d.callsign, callsign: d.callsign, rows, time_ms: d.time_ms, modelId: d.model || "", status: "finished", pos: null, recorded: d.created_at });
    }
    pilots.sort((a, b) => a.time_ms - b.time_ms || a.callsign.localeCompare(b.callsign));
    pilots.forEach((p, i) => { p.rank = i + 1; });
    return { pilots: pilots.slice(0, REPLAY_MAX), dropped };
  }

  /** GET /races/{id}/replay -> replay pilots in finishing order (DNFs after every finisher). Each
   * trace is matched to its result row by callsign; a racer with no usable trace is in `dropped`.
   * Traces and ghosts share one clock: t = 0 is the go. */
  function replayFromRace(json) {
    const j = json || {};
    const results = Array.isArray(j.results) ? j.results : [];
    const byCs = new Map(results.map((r) => [r.callsign, r]));
    const pilots = [], dropped = [];
    for (const tr of Array.isArray(j.traces) ? j.traces : []) {
      const rows = tr && traceRows(tr.trace);
      if (!rows) { if (tr && tr.callsign) dropped.push(tr.callsign); continue; }
      const res = byCs.get(tr.callsign) || {};
      const status = res.status || "finished";
      const time = status === "finished" ? (res.go_time_ms != null ? res.go_time_ms : tr.time_ms) : null;
      pilots.push({ id: tr.callsign, callsign: tr.callsign, rows, time_ms: time, modelId: tr.model || res.model || "", status, pos: res.pos == null ? null : res.pos });
    }
    const traced = new Set(pilots.map((p) => p.callsign));
    for (const r of results) if (!traced.has(r.callsign) && !dropped.includes(r.callsign)) dropped.push(r.callsign);
    const key = (p) => [p.status === "finished" ? 0 : 1, p.pos == null ? Infinity : p.pos, p.time_ms == null ? Infinity : p.time_ms];
    pilots.sort((a, b) => { const x = key(a), y = key(b); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2] || a.callsign.localeCompare(b.callsign); });
    pilots.forEach((p, i) => { p.rank = i + 1; });
    return { pilots: pilots.slice(0, REPLAY_MAX), dropped, results };
  }

  /** How long the timeline runs: the last sample of the longest trace, plus a short tail. */
  function replayDuration(pilots, tailMs) {
    const ends = (pilots || []).map((p) => (p.rows && p.rows.length ? p.rows[p.rows.length - 1].t : 0));
    return Math.max(0, ...ends) + (tailMs == null ? 1500 : tailMs);
  }

  /** Gate tick marks for a timeline of `durationMs`: [{t, frac, label}] from a crossings list. */
  function timelineTicks(crossings, durationMs) {
    const D = durationMs > 0 ? durationMs : 1;
    return (crossings || []).filter(Boolean).map((c) => ({ t: c.t, frac: Math.max(0, Math.min(1, c.t / D)), label: String(c.gate + 1) }));
  }

  /** A delta-vs-reference series -> SVG path in w x h, symmetric about the midline (ahead = up). */
  function deltaChartPath(series, durationMs, w, h, maxAbsIn) {
    if (!series || !series.length) return { d: "", maxAbs: 0 };
    const maxAbs = maxAbsIn || Math.max(500, ...series.map((p) => Math.abs(p.delta)));
    const D = durationMs > 0 ? durationMs : series[series.length - 1].t || 1;
    const pts = series.map((p) => ({ x: (p.t / D) * w, y: h / 2 + (Math.max(-maxAbs, Math.min(maxAbs, p.delta)) / maxAbs) * (h / 2 - 2) }));
    return { d: buildTracePath(pts), maxAbs };
  }

  const api = {
    // original (run.js pins these)
    boundsOf, projectLatLon, buildTracePath, decodeTrace, sampleTraceAt, fmtClock, fmtNum, timeAgo, slug,
    // medals + formatting
    MEDAL_THRESHOLDS, MEDAL_ORDER, medalFor, msToNextMedal, fmtRaceTime, fmtGap, fmtDuration, reignSeconds, fmtDate, fmtKm,
    // geometry + traces
    wrap360, angleDelta, haversineM, enu, dist3, pathLengthM, traceRows, traceStateAt, hprRadians, traceSpeeds, speedColor,
    gateCrossings, sectorTimes, bestSectors, deltaVsReference, raceOrderAt,
    // aggregation
    buildRecords, medalTable, medalSort, headToHead, rivals, pilotSummary, pilotIndex, recordFeed,
    // courses
    parseCourseName, courseClass, courseOfWeek, routeMiniMap, makeProjector, terrariumHeight, lonLatToTile, profileStations, profilePaths,
    // routing + replay
    cspAllows,
    parseRoute, buildRoute, DIRECTOR, directorStep, timelineTicks, deltaChartPath,
    replayFromGhosts, replayFromRace, replayDuration,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    self.FinsSite = Object.freeze(api);
  }
})();
