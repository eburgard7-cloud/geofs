// /course/:id — 3D viewer (2D route fallback), facts, elevation profile, full leaderboard with
// medals, ghost picker, and how to fly it.

import { api } from "../api.js";
import { catalog, boardForCourse } from "../data.js";
import { FLAGS, LOW_LEVEL_AGL_M } from "../config.js";
import { h, s, clear, dataBlock, link, medal, chip, courseChips, routeSvg, sortableTable, getMe } from "../ui.js";

const S = () => window.FinsSite;

function facts(c) {
  const p = S().parseCourseName(c.course_name);
  const cls = S().courseClass(c.cup, c.course_id);
  const rows = [
    ["Length", S().fmtKm(c.length_km)], ["Gates", String(c.gates)], ["Laps", String(p.laps)],
    ["Class", cls[0].toUpperCase() + cls.slice(1)], ["Start", c.start_type === "ground" ? "Ground" : "Air"],
    ["Difficulty", c.difficulty ? c.difficulty[0].toUpperCase() + c.difficulty.slice(1) : "—"],
  ];
  // Aircraft lock, environment, terrain check and a history blurb are not in the catalog yet
  // (SITE_GAPS.md: catalog fields); FLAGS.COURSE_META turns them on once the server sends them.
  if (FLAGS.COURSE_META) {
    if (c.aircraft_id) rows.push(["Aircraft", c.aircraft_id]);
    if (c.terrain_status) rows.push(["Terrain", c.terrain_status]);
  }
  return h("dl", { class: "facts" }, rows.map(([k, v]) => h("div", { class: "fact" }, h("dt", { text: k }), h("dd", { text: v }))));
}

function recordCard(rows, c) {
  if (!rows.length) {
    return h("div", { class: "record-card" }, h("span", { class: "eyebrow", text: "Course record" }),
      h("p", { class: "dim" }, "Nobody has a time here yet. The first finish is the record — and gold."));
  }
  const top = rows[0];
  return h("div", { class: "record-card" },
    h("span", { class: "eyebrow", text: "Course record" }),
    h("span", { class: "t", text: S().fmtRaceTime(top.time_ms) }),
    h("p", { class: "dim" }, link.pilot(top.callsign), " · set " + S().fmtDate(top.created_at) + " · held " + S().fmtDuration(S().reignSeconds(top.created_at))),
    rows[1] ? h("p", { class: "faint" }, "Next best: ", link.pilot(rows[1].callsign), " ", S().fmtGap(rows[1].time_ms - top.time_ms)) : null,
    h("div", { class: "btn-row" },
      top.has_ghost ? h("a", { class: "btn btn-primary btn-sm", href: S().buildRoute("replay", c.course_id, { pilots: [top.callsign] }) }, "Watch the record") : null));
}

function board(rows, c) {
  const rec = rows.length ? rows[0].time_ms : null;
  const me = getMe();
  return sortableTable([
    { key: "rank", label: "#", num: true, cell: (r) => h("span", { class: "rank", text: String(r.rank) }) },
    { key: "callsign", label: "Pilot", defaultAsc: true, sort: (a, b) => a.callsign.localeCompare(b.callsign), cell: (r) => link.pilot(r.callsign) },
    { key: "time_ms", label: "Time", num: true, defaultAsc: true, cell: (r) => h("span", { class: "t", text: S().fmtRaceTime(r.time_ms) }) },
    { key: "gap", label: "Gap", num: true, sort: false, cell: (r) => (r.rank === 1 ? "—" : h("span", { class: "t faint", text: S().fmtGap(r.time_ms - rec) })) },
    { key: "medal", label: "Medal", sort: false, cell: (r) => medal(S().medalFor(r.time_ms, rec)) },
    { key: "attempts", label: "Runs", num: true },
    { key: "created_at", label: "Set", cell: (r) => h("span", { class: "faint", title: S().fmtDate(r.created_at), text: S().timeAgo(r.created_at) }) },
    { key: "has_ghost", label: "Ghost", sort: false, cell: (r) => (r.has_ghost ? h("a", { href: S().buildRoute("replay", c.course_id, { pilots: [r.callsign] }), text: "Watch" }) : h("span", { class: "faint", text: "—" })) },
  ], rows.map((r, i) => Object.assign({ rank: i + 1 }, r)), { sortKey: "rank", asc: true, caption: "Leaderboard", rowClass: (r) => (me && r.callsign === me ? "me" : null) });
}

function ghostPicker(ghosts, c) {
  const picked = new Set(ghosts.slice(0, 3).map((g) => g.callsign));
  const go = h("a", { class: "btn btn-primary" });
  const sync = () => {
    const list = ghosts.filter((g) => picked.has(g.callsign)).map((g) => g.callsign);
    go.href = S().buildRoute("replay", c.course_id, { pilots: list });
    go.textContent = list.length ? "Race these " + list.length + " ghost" + (list.length === 1 ? "" : "s") : "Pick at least one ghost";
    go.setAttribute("aria-disabled", String(!list.length));
  };
  go.addEventListener("click", (e) => { if (!picked.size) e.preventDefault(); });
  // The House ghost (the robot test pilot's reference line) is on no board: it gets no medal, no
  // pilot link, and never sets the medal reference -- the fastest player ghost does.
  const ref = ghosts.find((g) => !g.is_house);
  const rows = ghosts.map((g) => {
    const cb = h("input", { type: "checkbox", "aria-label": "Include " + g.callsign, checked: picked.has(g.callsign) });
    cb.addEventListener("change", () => {
      if (cb.checked) { if (picked.size >= 8) { cb.checked = false; return; } picked.add(g.callsign); } else picked.delete(g.callsign);
      sync();
    });
    return h("li", { class: "ghost-row" }, cb, medal(g.is_house || !ref ? null : S().medalFor(g.time_ms, ref.time_ms)),
      h("span", {}, g.is_house ? chip("House") : link.pilot(g.callsign), h("span", { class: "faint", text: g.model ? " · " + g.model : "" })),
      h("span", { class: "t", text: S().fmtRaceTime(g.time_ms) }),
      h("a", { class: "btn btn-ghost btn-sm", href: S().buildRoute("replay", c.course_id, { pilots: [g.callsign] }) }, "Watch"));
  });
  sync();
  return h("div", { class: "stack" }, h("ul", { class: "ghost-list" }, rows), h("div", { class: "btn-row" }, go, h("span", { class: "faint", text: "Up to 8 ghosts at once." })));
}

function flyThis(c) {
  const p = S().parseCourseName(c.course_name);
  return h("ol", { class: "steps" },
    h("li", {}, h("span", { class: "step-n", text: "1" }), h("p", {}, "Open GeoFS and click your FINSONLY Racing bookmark. No bookmark yet? ", h("a", { href: "#/install" }, "Install it"), ".")),
    h("li", {}, h("span", { class: "step-n", text: "2" }), h("p", {}, "In the panel's Courses tab pick ", h("strong", { text: p.title }), " (id ", h("code", { text: c.course_id }), ").")),
    h("li", {}, h("span", { class: "step-n", text: "3" }), h("p", {}, c.start_type === "ground"
      ? "It's a ground start: line up behind gate 1 and go."
      : "It's an air start: the mod places you in the air before gate 1. Throttle up and go.")),
    h("li", {}, h("span", { class: "step-n", text: "4" }), h("p", {}, "Want company? Host a room with this course and share the code, or race the ghosts above solo.")));
}

async function drawProfile(container, c, signal) {
  const W = 800, H = 220, PAD = 26;
  const len = S().pathLengthM(c.gate_coords);
  const st = S().profileStations(c.gate_coords, Math.max(100, len / 140));
  let ground = null, note = "";
  if (FLAGS.TERRAIN_PROFILE) {
    try {
      const { sampleHeights } = await import("../terrain.js");
      ground = await sampleHeights(st, { signal, zoom: 12, maxTiles: 24 });
    } catch (_) {
      note = "Terrain tiles unavailable here — showing gate altitudes only.";
    }
  }
  if (signal.aborted) return;
  const pp = S().profilePaths(st, ground, W, H, PAD);
  const svg = s("svg", { viewBox: "0 0 " + W + " " + H, role: "img", "aria-label": "Elevation profile: gate altitudes " + (ground ? "over the ground" : "") + " along the route" },
    pp.ground ? s("path", { d: pp.ground, class: "p-ground" }) : null,
    s("path", { d: pp.alt, class: "p-alt" }),
    pp.gates.map((g) => s("circle", { cx: g.x.toFixed(1), cy: g.y.toFixed(1), r: 4, class: "p-gate" }, s("title", { text: "Gate " + (g.gate + 1) }))),
    s("text", { x: 4, y: PAD - 8, class: "p-axis", text: Math.round(pp.maxY) + " m" }),
    s("text", { x: 4, y: H - 6, class: "p-axis", text: Math.round(pp.minY) + " m" }),
    s("text", { x: W - 4, y: H - 6, class: "p-axis", "text-anchor": "end", text: (pp.lengthM / 1000).toFixed(1) + " km" }));
  clear(container).append(svg);
  if (ground) {
    const agl = st.map((x, i) => x.alt - ground[i]);
    const minAgl = Math.min(...agl.filter((v, i) => st[i].gate != null));
    container.append(h("p", { class: "faint" }, "Lowest gate is " + Math.round(minAgl) + " m above this terrain model."));
    if (minAgl < LOW_LEVEL_AGL_M) container.append(h("p", { class: "warn" }, "Low-level course: the terrain here is not GeoFS's own, so ridges in the 3D view can sit a little above or below where you'll meet them in the sim."));
  } else if (note) container.append(h("p", { class: "faint", text: note }));
}

export async function mount(root, route, ctx) {
  const signal = ctx.signal;
  const page = h("div", { class: "page" });
  root.appendChild(page);
  const blocks = [];
  let globe = null;

  let cat;
  try { cat = await catalog(signal); } catch (_) { cat = null; }
  if (signal.aborted) return () => {};
  const c = cat && cat.byId.get(route.id);
  if (!c) {
    ctx.setTitle("Unknown course");
    page.append(h("h1", {}, "Unknown course"),
      h("p", { class: "state-msg " + (cat ? "empty" : "error") }, cat ? "There's no course called “" + route.id + "” in the catalog. " : "Couldn't reach the server. ",
        h("a", { href: "#/courses" }, "See all courses")));
    return () => {};
  }
  const p = S().parseCourseName(c.course_name);
  ctx.setTitle(p.title);

  const viewer = h("div", { class: "viewer" }, routeSvg(c.gate_coords, 640, 400, { labels: true, gateR: 4, pad: 36, label: "Route of " + p.title + " with numbered gates" }));
  const side = h("div", { class: "stack" });
  const boardBlock = h("div", { class: "block" });
  const ghostBlock = h("div", { class: "block" });
  const profile = h("div", { class: "profile block" });
  page.append(
    h("div", { class: "page-head" },
      h("div", {}, h("span", { class: "eyebrow", text: c.cup || "Course" }), h("h1", {}, p.title),
        h("div", { class: "meta btn-row" }, courseChips(c))),
      h("div", { class: "btn-row" }, h("a", { class: "btn btn-ghost", href: "#fly" }, "Fly this"))),
    h("div", { class: "course-hero" }, viewer, side),
    h("section", { class: "section", "aria-labelledby": "prof-h" }, h("div", { class: "section-head" }, h("h2", { id: "prof-h" }, "Elevation profile")), h("div", { class: "panel" }, profile)),
    h("section", { class: "section", "aria-labelledby": "lb-h" }, h("div", { class: "section-head" }, h("h2", { id: "lb-h" }, "Leaderboard"),
      h("p", { class: "section-sub" }, "Medals: gold within 2 % of the record, silver 5 %, bronze 10 %.")), h("div", { class: "panel panel-tight" }, boardBlock)),
    h("section", { class: "section", "aria-labelledby": "gh-h" }, h("div", { class: "section-head" }, h("h2", { id: "gh-h" }, "Ghosts")), ghostBlock),
    h("section", { class: "section", id: "fly", "aria-labelledby": "fly-h" }, h("div", { class: "section-head" }, h("h2", { id: "fly-h" }, "Fly this")), h("div", { class: "panel" }, flyThis(c))));
  // "Fly this" is an in-page jump, not a route.
  page.querySelector('a[href="#fly"]').addEventListener("click", (e) => { e.preventDefault(); document.getElementById("fly").scrollIntoView({ behavior: "smooth" }); });

  side.append(facts(c));
  const recSlot = h("div", {}, h("div", { class: "skel skel-card" }));
  side.prepend(recSlot);

  blocks.push(dataBlock(boardBlock, {
    load: (sg) => boardForCourse(c.course_id, sg).then((b) => b.rows),
    render: (rows) => board(rows, c),
    after: (rows) => clear(recSlot).append(recordCard(rows, c)),
    onError: () => clear(recSlot).append(recordCard([], c)),
    skeleton: "rows", skeletonCount: 5,
    empty: "No times yet. Be the first — it's automatically the record.",
  }));
  blocks.push(dataBlock(ghostBlock, {
    load: (sg) => api.ghosts(c.course_hash, { signal: sg }),
    render: (g) => ghostPicker(g, c), skeleton: "rows", skeletonCount: 3, notFoundIsEmpty: true,
    empty: "No ghosts recorded on this version of the course yet. Finish a run with traces on and yours will be here.",
  }));
  drawProfile(profile, c, signal).catch(() => {});

  if (FLAGS.COURSE_3D) {
    import("../globe.js").then((g) => g.mountCourse(viewer, c, { signal }))
      .then((handle) => { if (signal.aborted && handle) handle.destroy(); else globe = handle; })
      .catch((e) => console.warn("3D viewer unavailable", e));
  }

  return () => { blocks.forEach((b) => b.destroy()); if (globe) globe.destroy(); };
}
