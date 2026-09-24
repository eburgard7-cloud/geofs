// Home. Its markup is prerendered in index.html (#view-home); this fills the data blocks.

import { api, allowed } from "../api.js";
import { allBoards, catalog } from "../data.js";
import { FLAGS, TILE_SOURCES } from "../config.js";
import { $, h, clear, dataBlock, link, chip, courseChips, routeSvg, reducedMotion, saveData } from "../ui.js";

const S = () => window.FinsSite;
const PHASE_LABEL = { lobby: "Boarding", countdown: "Launching", racing: "Racing", results: "Results" };
const POLL_MS = 10000;

function stat(id, v) { $(id).textContent = S().fmtNum(v); }

async function loadStatus(signal) {
  const pill = $("status-pill"), text = $("status-pill-text");
  try {
    const v = await api.version({ signal });
    pill.dataset.state = "ok";
    text.textContent = "Tower online · " + (v.courses != null ? v.courses + " courses" : "server " + v.version);
  } catch (_) {
    pill.dataset.state = "error";
    text.textContent = "Tower not answering";
  }
  try {
    const st = await api.stats({ signal });
    stat("stat-races", st.races); stat("stat-pilots", st.pilots); stat("stat-gates", st.gates); stat("stat-missiles", st.missiles_hit);
  } catch (_) { /* tiles keep their dashes */ }
}

function roomCard(r) {
  const card = h("li", { class: "room-card" },
    h("div", { class: "room-card-head" },
      h("span", { class: "room-course", text: r.course || "Choosing a course" }),
      chip(PHASE_LABEL[r.phase] || r.phase, r.phase === "racing" ? "live" : null)));
  if (r.gate_progress && r.gate_progress.of) {
    const pct = Math.max(0, Math.min(100, (100 * (r.gate_progress.gate || 0)) / r.gate_progress.of));
    const fill = h("span");
    fill.style.width = pct + "%";
    card.appendChild(h("div", { class: "room-progress", role: "img", "aria-label": "Leader at gate " + r.gate_progress.gate + " of " + r.gate_progress.of }, fill));
  }
  const pilots = r.pilot_callsigns || [];
  card.appendChild(h("p", { class: "room-pilots" }, pilots.length ? pilots.map((cs, i) => [i ? ", " : "", link.pilot(cs)]) : "No racers yet",
    r.spectators ? " · " + r.spectators + " watching" : ""));
  return card;
}

function renderDepartures(rooms) {
  const online = [...new Set(rooms.flatMap((r) => r.pilot_callsigns || []))].sort();
  return h("div", {},
    h("ul", { class: "room-grid" }, rooms.map(roomCard)),
    h("p", { class: "online" }, h("span", { text: online.length + " pilot" + (online.length === 1 ? "" : "s") + " in rooms:" }),
      online.map((cs) => h("a", { class: "chip", href: S().buildRoute("pilot", cs), text: cs }))));
}

function renderFeed(items) {
  return h("ul", { class: "feed" }, items.map((it) => h("li", { class: "feed-item" },
    h("span", { class: "feed-time", text: S().fmtRaceTime(it.time_ms) }),
    h("p", {}, it.parts.map((p) => (p.pilot ? link.pilot(p.pilot) : p.course ? link.course(p.course_id, S().parseCourseName(p.course).title) : p.text))),
    h("span", { class: "feed-when", text: it.at ? S().timeAgo(it.at) : "" }))));
}

function renderRaces(races) {
  return h("ul", { class: "race-list" }, races.slice(0, 5).map((r) => h("li", { class: "race-item" },
    h("header", {}, h("strong", { text: S().parseCourseName(r.course_name).title }),
      h("span", { class: "faint", text: (r.cup_name ? r.cup_name + " · " : "") + S().timeAgo(r.started_at) })),
    h("ol", { class: "podium" }, (r.results || []).filter((x) => x.status === "finished").slice(0, 3).map((x) =>
      h("li", {}, h("span", { class: "medal medal-" + ["gold", "silver", "bronze"][x.pos - 1], "aria-hidden": "true", text: String(x.pos) }),
        link.pilot(x.callsign), h("span", { class: "faint t", text: S().fmtRaceTime(x.go_time_ms) })))))));
}

function renderCups(cups) {
  return h("ul", { class: "cup-list" }, cups.slice(0, 3).map((c) => h("li", { class: "cup-item" },
    h("header", {}, h("a", { class: "course-link", href: S().buildRoute("cup", c.id), text: c.name }),
      h("span", { class: "faint", text: "race " + c.races_run + " of " + c.race_count })),
    h("ol", { class: "standings" }, (c.standings || []).slice(0, 4).map((s, i) => h("li", {},
      h("span", { class: "faint", text: String(i + 1) }), link.pilot(s.callsign), h("span", { class: "t", text: s.points + " pts" })))))));
}

function renderBookmarklet(bm) {
  const a = h("a", { class: "bookmarklet", href: bm.href, draggable: "true", title: "Drag me to your bookmarks bar" }, "★ " + (bm.label || "FINSONLY Racing"));
  // It's a real javascript: link; clicking it here would run the mod on this page.
  a.addEventListener("click", (e) => { e.preventDefault(); a.blur(); });
  return h("div", {}, a, h("p", { class: "bookmarklet-hint", text: "Drag it to your bookmarks bar. Clicking it here does nothing." }));
}

// ------------------------------------------------------------------ course of the week
async function loadCotw(signal, state) {
  const cat = await catalog(signal);
  const c = S().courseOfWeek(cat.list, Date.now());
  const media = $("cotw-media");
  if (!c) { $("cotw-name").textContent = "No courses yet"; $("cotw-skel").hidden = true; return; }
  const p = S().parseCourseName(c.course_name);
  $("cotw-name").textContent = p.title;
  clear($("cotw-meta")).append(...courseChips(c), chip(S().fmtKm(c.length_km)), chip(c.gates + " gates"));
  $("cotw-link").href = S().buildRoute("course", c.course_id);
  $("cotw-skel").hidden = true;
  // The poster: the route over the sunset. Always drawn; the 3D flyover mounts on top of it.
  const old = media.querySelector("svg.cotw-poster");
  if (old) old.remove();
  const poster = routeSvg(c.gate_coords, 480, 300, { className: "cotw-poster", label: "Route of " + p.title, gateR: 4, pad: 34 });
  media.insertBefore(poster, $("cotw-ctrl"));
  api.courses({ signal }).then((raced) => {
    const hit = raced.find((r) => r.course_hash === c.course_hash);
    if (!hit) { $("cotw-record").textContent = "No time on the board yet — first one wins it."; return null; }
    return api.leaderboard(c.course_hash, 1, { signal }).then((rows) => {
      const top = rows[0];
      clear($("cotw-record")).append("Record ", h("strong", { class: "t", text: S().fmtRaceTime(top.time_ms) }), " by ", link.pilot(top.callsign));
    });
  }).catch(() => {});
  state.cotw = c;
  if (FLAGS.HOME_3D && !reducedMotion() && !saveData()) startHero3d(c, state, signal);
}

async function startHero3d(course, state, signal) {
  // Under a CSP that blocks the tile URLs the poster is the hero.
  if (!(await allowed("img-src", TILE_SOURCES.imagery[0].url)) || !(await allowed("connect-src", TILE_SOURCES.imagery[0].url))) return;
  if (signal.aborted) return;
  // The flyover starts on the visitor's first sign of life (a mouse move, scroll, key or touch) or
  // the "3D flyover" button — never during page load, so the 6 MB engine and its tiles never
  // compete with first paint (Lighthouse included). Until then the poster route is the hero.
  const ctrl = $("cotw-ctrl");
  const btn = h("button", { type: "button", class: "btn btn-ghost btn-sm" }, "▶ 3D flyover");
  clear(ctrl).appendChild(btn);
  const EVENTS = ["pointermove", "pointerdown", "keydown", "wheel", "touchstart", "scroll"];
  let started = false;
  const go = () => {
    if (started || signal.aborted) return;
    started = true;
    EVENTS.forEach((ev) => window.removeEventListener(ev, go, true));
    btn.disabled = true;
    btn.textContent = "Loading 3D…";
    import("../globe.js").then((g) => g.mountFlyover($("cotw-media"), course, { signal, ctrl, autoplay: true }))
      .then((handle) => { if (handle) state.globe = handle; else clear(ctrl); })
      .catch((e) => { clear(ctrl); console.warn("home 3D unavailable", e); });
  };
  btn.addEventListener("click", go);
  const arm = () => { if (!signal.aborted) EVENTS.forEach((ev) => window.addEventListener(ev, go, { capture: true, passive: true, once: true })); };
  if (document.readyState === "complete") arm();
  else window.addEventListener("load", arm, { once: true });
  signal.addEventListener("abort", () => EVENTS.forEach((ev) => window.removeEventListener(ev, go, true)));
}

// ------------------------------------------------------------------ mount
export async function mount(root, route, ctx) {
  ctx.setTitle("");
  const signal = ctx.signal;
  const state = {};
  const blocks = [];

  loadStatus(signal);
  loadCotw(signal, state).catch(() => {
    $("cotw-name").textContent = "Couldn't load the course of the week";
    $("cotw-skel").hidden = true;
  });

  const dep = dataBlock($("departures-block"), {
    load: (sg) => api.roomsLive({ signal: sg }), render: renderDepartures, skeleton: "bar",
    empty: "No rooms in the air. Open GeoFS, click the bookmark, hit Quick Match — you'll be the first on the board.",
    unavailable: "This server doesn't publish live rooms yet.",
  });
  blocks.push(dep);
  blocks.push(dataBlock($("feed-block"), {
    load: async (sg) => { const b = await allBoards(sg); return S().recordFeed(S().buildRecords(b.boards, b.courses, Date.now()), 6); },
    render: renderFeed, skeleton: "rows", skeletonCount: 4,
    empty: "No records yet. Every course is up for grabs.",
  }));
  blocks.push(dataBlock($("races-block"), {
    load: (sg) => api.racesRecent(8, { signal: sg }), render: renderRaces, skeleton: "rows", skeletonCount: 3,
    empty: "No lobby races finished yet. Host one and it'll land here.",
  }));
  blocks.push(dataBlock($("cups-block"), {
    load: (sg) => api.cups({ open: true, limit: 6 }, { signal: sg }), render: renderCups, skeleton: "rows", skeletonCount: 2,
    empty: "No cup running. Start one from the lobby's host controls.",
  }));
  blocks.push(dataBlock($("bookmarklet-block"), {
    load: (sg) => api.bookmarklet({ signal: sg }), render: renderBookmarklet, skeleton: "lines",
    error: "Couldn't build the bookmark.",
  }));

  // Live rooms: poll while the tab is visible. The server caches for 8 s, so faster is waste.
  const timer = setInterval(() => { if (!document.hidden) dep.reload(true); }, POLL_MS);

  return () => {
    clearInterval(timer);
    blocks.forEach((b) => b.destroy());
    if (state.globe) state.globe.destroy();
  };
}
