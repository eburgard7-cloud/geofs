"use strict";
/* FINSONLY Racing — race.finsonly.net public page. Vanilla JS, no framework, no build step.
 *
 * The pure geometry/format helpers at the bottom of this file (boundsOf, projectLatLon,
 * buildTracePath, decodeTrace, sampleTraceAt, fmtClock) are exported to race/test/run.js the same
 * way race.js's own pure functions are — see the "site.js: pure geometry helpers" section there.
 * Everything else here only runs in a browser (DOM/fetch), guarded at the bottom of the file.
 */

const TIMEOUT_MS = 8000;
const REPLAY_SPEED = 15; // 10-20x wall-clock, per spec

// ---------------------------------------------------------------- fetch with a hard timeout
// Every section times out at 8s rather than sitting on "Loading..." forever (see index.html's
// skeleton/empty/error triad per section).
function fetchJSON(url, opts) {
  opts = opts || {};
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs || TIMEOUT_MS);
  return fetch(url, { headers: { Accept: "application/json" }, signal: controller.signal })
    .then((r) => {
      if (!r.ok) {
        const err = new Error("HTTP " + r.status);
        err.status = r.status;
        throw err;
      }
      return r.json();
    })
    .finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------- pure helpers (also used by
// race/test/run.js -- keep them free of `document`/`fetch` so they work under plain Node)

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
 * roll}, with `t` delta-encoded (t[0] absolute, t[i>0] a delta from the previous sample). This is
 * the display-side twin: lenient rather than strict, since a bad replay should show an error state,
 * not crash the page. Returns null on anything malformed. */
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

function timeAgo(unixSeconds) {
  const s = Math.max(0, Math.round(Date.now() / 1000 - unixSeconds));
  if (s < 90) return "just now";
  if (s < 5400) return Math.round(s / 60) + " min ago";
  if (s < 129600) return Math.round(s / 3600) + " h ago";
  return Math.round(s / 86400) + " d ago";
}

function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

// ==================================================================================
// Everything below touches the DOM or the network and only runs in a browser.
// ==================================================================================
/* istanbul ignore next -- exercised by hand in a browser; the pure helpers above are unit tested */
function browserMain() {
  const SVG_NS = "http://www.w3.org/2000/svg";
  const PHASE_LABEL = { lobby: "Lobby", countdown: "Starting", racing: "Racing", results: "Results" };

  const $ = (id) => document.getElementById(id);
  function reducedMotion() {
    return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function svgEl(tag, attrs) {
    const e = document.createElementNS(SVG_NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }

  /** Shows exactly one of a section's {skeleton, empty, error, content} elements, and mirrors the
   * state onto the wrapping .panel's [data-state] (loading/empty/error/ready) for anything that
   * wants to style off it (currently just the status pill/replay panel do, via their own state). */
  function sectionElems(name, contentId) {
    return {
      skeleton: $(name + "-skeleton"),
      empty: $(name + "-empty"),
      error: $(name + "-error"),
      content: $(contentId || name + "-list"),
    };
  }
  function showSection(name, state, contentId) {
    const elems = sectionElems(name, contentId);
    for (const key in elems) {
      if (elems[key]) elems[key].hidden = key !== state;
    }
    const panel = $(name + "-panel");
    if (panel) panel.dataset.state = state === "content" ? "ready" : state;
  }

  // -------------------------------------------------------------- status pill + stat tiles
  async function loadStatusAndStats() {
    const pill = $("status-pill"), pillText = $("status-pill-text");
    try {
      const version = await fetchJSON("/version").catch(() => fetchJSON("/health"));
      const courses = version.courses != null ? version.courses : null;
      let flyingText = "";
      try {
        const rooms = await fetchJSON("/rooms/live");
        const flying = rooms.reduce((n, r) => n + r.pilot_callsigns.length, 0);
        flyingText = " · " + flying + (flying === 1 ? " pilot" : " pilots") + " flying";
      } catch (_e) { /* best-effort: the pill still says the server is up */ }
      pill.dataset.state = "online";
      pillText.textContent = "SERVER ONLINE" +
        (courses != null ? " · " + courses + (courses === 1 ? " course" : " courses") : "") + flyingText;
    } catch (_e) {
      pill.dataset.state = "offline";
      pillText.textContent = "SERVER OFFLINE";
    }
    try {
      const stats = await fetchJSON("/stats");
      $("stat-races").textContent = fmtNum(stats.races);
      $("stat-pilots").textContent = fmtNum(stats.pilots);
      $("stat-gates").textContent = fmtNum(stats.gates);
      $("stat-missiles").textContent = fmtNum(stats.missiles_hit);
    } catch (_e) {
      ["stat-races", "stat-pilots", "stat-gates", "stat-missiles"].forEach((id) => { $(id).textContent = "—"; });
    }
  }

  // -------------------------------------------------------------- hero record replay
  const replay = { rows: null, bounds: null, total: 0, simT: 0, last: null, raf: null, playing: false };

  function stopReplay() {
    if (replay.raf != null) cancelAnimationFrame(replay.raf);
    replay.raf = null;
    replay.playing = false;
  }
  function replayTick(now) {
    if (replay.last == null) replay.last = now;
    replay.simT += (now - replay.last) * REPLAY_SPEED;
    replay.last = now;
    if (replay.total > 0) replay.simT %= replay.total;
    renderReplayFrame();
    replay.raf = requestAnimationFrame(replayTick);
  }
  function renderReplayFrame() {
    const sample = sampleTraceAt(replay.rows, replay.simT);
    if (!sample) return;
    const p = projectLatLon(sample.lat, sample.lon, replay.bounds, 400, 300, 20);
    $("replay-marker").setAttribute("cx", p.x.toFixed(2));
    $("replay-marker").setAttribute("cy", p.y.toFixed(2));
    $("replay-time").textContent = fmtClock(replay.simT);
  }
  function startReplay() {
    replay.playing = true;
    replay.last = null;
    replay.raf = requestAnimationFrame(replayTick);
    $("replay-toggle-label").textContent = "Pause";
    $("replay-toggle").setAttribute("aria-pressed", "true");
  }
  function pauseReplay() {
    stopReplay();
    $("replay-toggle-label").textContent = "Play";
    $("replay-toggle").setAttribute("aria-pressed", "false");
  }

  function drawReplayTrack(gatePts, rows, bounds) {
    const w = 400, h = 300, pad = 20;
    $("replay-gates").replaceChildren(...gatePts.map((g) => {
      const p = projectLatLon(g.lat, g.lon, bounds, w, h, pad);
      return svgEl("circle", { cx: p.x.toFixed(2), cy: p.y.toFixed(2), r: 5, class: "replay-gate-dot" });
    }));
    const pts = rows.map((r) => projectLatLon(r.lat, r.lon, bounds, w, h, pad));
    $("replay-track").setAttribute("d", buildTracePath(pts));
  }

  async function loadHeroReplay(course) {
    stopReplay();
    showSection("replay", "skeleton", "replay-map");
    $("replay-course-name").textContent = course.course_name || "";
    try {
      const ghost = await fetchJSON("/ghost?course_hash=" + encodeURIComponent(course.course_hash));
      const rows = decodeTrace(ghost.trace);
      if (!rows) throw new Error("malformed trace");
      const gatePts = (course.gate_coords || []).map((g) => ({ lat: g.lat, lon: g.lon }));
      const bounds = boundsOf(gatePts.concat(rows));
      replay.rows = rows;
      replay.bounds = bounds;
      replay.total = rows[rows.length - 1].t;
      replay.simT = 0;
      drawReplayTrack(gatePts, rows, bounds);
      $("replay-pilot").textContent = ghost.callsign + " · " + fmtClock(ghost.time_ms);
      showSection("replay", "content", "replay-map");
      if (reducedMotion()) {
        renderReplayFrame();
        pauseReplay();
      } else {
        startReplay();
      }
    } catch (e) {
      showSection("replay", e && e.status === 404 ? "empty" : "error", "replay-map");
    }
  }

  async function initHeroReplay() {
    try {
      const courses = await fetchJSON("/courses");
      if (!courses.length) {
        showSection("replay", "empty", "replay-map");
        return;
      }
      const top = courses[0];
      await loadHeroReplay({ course_hash: top.course_hash, course_name: top.course_name, gate_coords: top.gate_coords });
    } catch (_e) {
      showSection("replay", "error", "replay-map");
    }
  }

  // -------------------------------------------------------------- departures (live rooms)
  function roomCard(r) {
    const li = el("li", "room-card");
    const head = el("div", "room-card-head");
    head.append(el("span", "room-code", "Room " + r.room));
    const chip = el("span", "phase-chip", PHASE_LABEL[r.phase] || r.phase);
    chip.dataset.phase = r.phase;
    head.append(chip);
    li.append(head, el("p", "room-course", r.course || "No course picked yet"));
    if (r.gate_progress && r.gate_progress.of) {
      const bar = el("div", "room-progress");
      const fill = document.createElement("span");
      fill.style.width = Math.min(100, (r.gate_progress.gate / r.gate_progress.of) * 100) + "%";
      bar.append(fill);
      li.append(bar, el("p", "room-pilots", "Gate " + r.gate_progress.gate + " of " + r.gate_progress.of));
    } else {
      const names = r.pilot_callsigns.length ? r.pilot_callsigns.join(", ") : "nobody yet";
      const spec = r.spectators ? " · " + r.spectators + (r.spectators === 1 ? " spectator" : " spectators") : "";
      li.append(el("p", "room-pilots", names + spec));
    }
    const a = el("a", "btn btn-primary", "Spectate in GeoFS");
    a.href = "#install";
    li.append(a);
    return li;
  }

  let departuresTimer = null;
  async function loadDepartures() {
    try {
      const rooms = await fetchJSON("/rooms/live");
      if (!rooms.length) return showSection("departures", "empty");
      $("departures-list").replaceChildren(...rooms.map(roomCard));
      showSection("departures", "content");
    } catch (_e) {
      showSection("departures", "error");
    }
  }
  function startDeparturesPolling() {
    loadDepartures();
    if (departuresTimer) clearInterval(departuresTimer);
    departuresTimer = setInterval(() => {
      if (document.visibilityState === "visible") loadDepartures();
    }, 5000);
  }

  // -------------------------------------------------------------- course records (per-cup tabs)
  function routeMapSvg(gates) {
    const svg = svgEl("svg", { class: "route-map", viewBox: "0 0 200 110", role: "img", "aria-label": "Route map" });
    if (!gates.length) return svg;
    const bounds = boundsOf(gates);
    const pts = gates.map((g) => projectLatLon(g.lat, g.lon, bounds, 200, 110, 12));
    svg.append(svgEl("path", { d: buildTracePath(pts) }));
    pts.forEach((p, i) => {
      svg.append(svgEl("circle", { cx: p.x.toFixed(2), cy: p.y.toFixed(2), r: i === 0 || i === pts.length - 1 ? 3.5 : 2.5 }));
    });
    return svg;
  }

  function courseCard(c) {
    const card = el("div", "course-card");
    const head = el("div", "course-card-head");
    head.append(el("span", "course-name", c.course_name));
    if (c.difficulty) {
      const chip = el("span", "difficulty-chip", c.difficulty);
      chip.dataset.diff = c.difficulty;
      head.append(chip);
    }
    card.append(head, routeMapSvg(c.gate_coords || []));
    if (c.length_km) card.append(el("p", "course-length", c.length_km + " km"));
    const recordP = el("p", "course-record", "Loading record…");
    card.append(recordP);
    const watchBtn = el("button", "btn btn-icon", "Watch replay");
    watchBtn.type = "button";
    watchBtn.addEventListener("click", () => {
      loadHeroReplay({ course_hash: c.course_hash, course_name: c.course_name, gate_coords: c.gate_coords });
      $("top").scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth" });
    });
    card.append(watchBtn);
    fetchJSON("/leaderboard?course_hash=" + encodeURIComponent(c.course_hash) + "&limit=1")
      .then((rows) => {
        const top = rows[0];
        recordP.replaceChildren();
        if (top) {
          recordP.append(document.createTextNode(fmtClock(top.time_ms) + " — " + top.callsign +
            (top.model ? " (" + top.model + ")" : "")));
        } else {
          recordP.append(el("span", "no-record", "No record yet — be the first."));
        }
      })
      .catch(() => {
        recordP.replaceChildren(el("span", "no-record", "Record unavailable."));
      });
    return card;
  }

  function groupByCup(catalog) {
    const map = new Map();
    for (const c of catalog) {
      const key = c.cup || "Other";
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(c);
    }
    const keys = [...map.keys()].sort((a, b) => (a === "Other") - (b === "Other") || a.localeCompare(b));
    return keys.map((k) => ({ name: k, courses: map.get(k) }));
  }

  function selectRecordsTab(groups, idx) {
    groups.forEach((g, i) => {
      $("tab-" + slug(g.name)).setAttribute("aria-selected", String(i === idx));
      $("panel-" + slug(g.name)).hidden = i !== idx;
    });
  }

  function renderRecordsTabs(groups) {
    const tabsEl = $("records-tabs"), panelsEl = $("records-panels");
    tabsEl.replaceChildren();
    panelsEl.replaceChildren();
    groups.forEach((g, i) => {
      const btn = el("button", "tab-btn", g.name + " (" + g.courses.length + ")");
      btn.type = "button";
      btn.id = "tab-" + slug(g.name);
      btn.setAttribute("role", "tab");
      btn.setAttribute("aria-selected", String(i === 0));
      btn.setAttribute("aria-controls", "panel-" + slug(g.name));
      btn.addEventListener("click", () => selectRecordsTab(groups, i));
      tabsEl.append(btn);

      const panel = el("div", "tab-panel");
      panel.id = "panel-" + slug(g.name);
      panel.setAttribute("role", "tabpanel");
      panel.setAttribute("aria-labelledby", "tab-" + slug(g.name));
      panel.hidden = i !== 0;
      const grid = el("div", "course-grid");
      grid.append(...g.courses.map(courseCard));
      panel.append(grid);
      panelsEl.append(panel);
    });
  }

  async function loadRecords() {
    try {
      const catalog = await fetchJSON("/courses/catalog");
      if (!catalog.length) return showSection("records", "empty");
      renderRecordsTabs(groupByCup(catalog));
      showSection("records", "content", "records-body");
    } catch (_e) {
      showSection("records", "error");
    }
  }

  // -------------------------------------------------------------- recent races
  function raceCard(r) {
    const li = el("li", "race-card");
    const head = el("div", "race-card-head");
    head.append(el("span", "race-course", r.course_name), el("span", "race-time", timeAgo(r.started_at)));
    li.append(head);
    if (r.cup_name) li.append(el("span", "cup-badge", r.cup_name));
    const podium = el("div", "podium");
    r.results.slice(0, 3).forEach((x) => {
      const chip = el("span", "podium-chip");
      const rank = el("span", "podium-rank", String(x.pos));
      rank.dataset.pos = x.pos;
      chip.append(rank, document.createTextNode(
        " " + x.callsign + " · " + (x.status === "finished" ? fmtClock(x.go_time_ms) : "DNF")));
      podium.append(chip);
    });
    li.append(podium);
    return li;
  }
  async function loadRaces() {
    try {
      const races = await fetchJSON("/races/recent?limit=8");
      if (!races.length) return showSection("races", "empty");
      $("races-list").replaceChildren(...races.map(raceCard));
      showSection("races", "content");
    } catch (_e) {
      showSection("races", "error");
    }
  }

  // -------------------------------------------------------------- open cups
  function cupCard(c) {
    const li = el("li", "cup-card");
    const head = el("div", "cup-card-head");
    head.append(el("span", "race-course", c.name),
      el("span", "race-time", "race " + Math.min(c.races_run + 1, c.race_count) + " of " + c.race_count));
    li.append(head);
    const bar = el("div", "cup-progress");
    const fill = document.createElement("span");
    fill.style.width = Math.min(100, (c.races_run / c.race_count) * 100) + "%";
    bar.append(fill);
    li.append(bar);
    if (!c.standings.length) {
      li.append(el("p", "empty-state", "No race finished yet."));
    } else {
      c.standings.slice(0, 3).forEach((s) => {
        const row = el("div", "cup-standing");
        row.append(el("span", "name", s.callsign), el("span", "pts", s.points + " pts"));
        li.append(row);
      });
    }
    return li;
  }
  async function loadCups() {
    try {
      const cups = await fetchJSON("/cups?open=1&limit=6");
      if (!cups.length) return showSection("cups", "empty");
      $("cups-list").replaceChildren(...cups.map(cupCard));
      showSection("cups", "content");
    } catch (_e) {
      showSection("cups", "error");
    }
  }

  // -------------------------------------------------------------- get in the race
  async function loadBookmarklet() {
    const wrap = $("bookmarklet-wrap");
    try {
      const bm = await fetchJSON("/bookmarklet");
      const link = $("bookmarklet-link");
      link.href = bm.href;
      link.textContent = "★ " + (bm.label || "FINSONLY Racing");
      $("bookmarklet-skeleton").hidden = true;
      $("bookmarklet-error").hidden = true;
      link.hidden = false;
      $("bookmarklet-hint").hidden = false;
      wrap.dataset.state = "ready";
    } catch (_e) {
      $("bookmarklet-skeleton").hidden = true;
      $("bookmarklet-error").hidden = false;
      wrap.dataset.state = "error";
    }
  }

  // -------------------------------------------------------------- footer
  async function loadFooter() {
    try {
      const v = await fetchJSON("/version").catch(() => fetchJSON("/health"));
      const bits = ["FINSONLY Racing server " + (v.version || "unknown version")];
      if (v.proto != null) bits.push("proto " + v.proto);
      if (v.sha && v.sha !== "unknown") bits.push(String(v.sha).slice(0, 7));
      $("footer-version").textContent = bits.join(" · ");
    } catch (_e) {
      $("footer-version").textContent = "Version unavailable.";
    }
  }

  // -------------------------------------------------------------- retry buttons + wiring
  const RETRY = {
    replay: initHeroReplay, departures: loadDepartures, records: loadRecords,
    races: loadRaces, cups: loadCups, bookmarklet: loadBookmarklet,
  };
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-retry]");
    if (!btn) return;
    const fn = RETRY[btn.dataset.retry];
    if (fn) fn();
  });
  $("replay-toggle").addEventListener("click", () => {
    if (replay.playing) pauseReplay();
    else if (replay.rows) startReplay();
  });

  loadStatusAndStats();
  initHeroReplay();
  startDeparturesPolling();
  loadRecords();
  loadRaces();
  loadCups();
  loadBookmarklet();
  loadFooter();
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { boundsOf, projectLatLon, buildTracePath, decodeTrace, sampleTraceAt, fmtClock, fmtNum, timeAgo, slug };
} else {
  browserMain();
}
