// The replay theater, fed by one of two sources:
//   /replay/:course?pilots=a,b&t=secs — solo ghosts (GET /ghost per pilot), record ghost as reference
//   /replay/race/:race_id?t=secs      — one finished lobby race (GET /races/{id}/replay), winner as reference
// Up to 8 ghosts on one clock, five cameras (keys 1–5), a scrubbable timeline with gate ticks, live
// gaps, a sector table and a delta chart. Runs in 3D when the tiles are reachable, and as a top-down
// 2D replay (same timeline, same panel) when they aren't.

import { api } from "../api.js";
import { catalog } from "../data.js";
import { FLAGS, GHOST_COLORS, LOW_LEVEL_AGL_M } from "../config.js";
import { h, s, clear, link, medal, toast, copyText, sortableTable, reducedMotion, retryRoute } from "../ui.js";

const S = () => window.FinsSite;
const SPEEDS = [0.5, 1, 2, 4, 8];
const CAMS = [["chase", "Chase"], ["orbit", "Orbit"], ["cockpit", "Cockpit"], ["gate", "Gate cam"], ["director", "Director"]];
const RANK_COLORS = ["#ffd23d", "#d9dde8", "#e39a5e"];
const UI_HZ = 8;

function secs(ms) { return (ms / 1000).toFixed(2); }

// ------------------------------------------------------------------ sources
// Each resolves {title, eyebrow, course, pilots, ref, refLabel, dropped, back, routeFor, results}
// or {fail: [message nodes]} for a page that has nothing to play.

async function fromCourse(route, cat, signal) {
  const course = cat && cat.byId.get(route.id);
  if (!course) {
    return { fail: [cat ? "No course called “" + route.id + "”. " : "Couldn't reach the server. ", cat ? h("a", { href: "#/courses" }, "Pick a course") : retryRoute()], error: !cat };
  }
  const title = S().parseCourseName(course.course_name).title;
  const back = h("a", { href: S().buildRoute("course", course.course_id) }, "Back to the course");
  let list = [];
  try { list = await api.ghosts(course.course_hash, { signal }); } catch (e) {
    if (e.status !== 404) return { title, fail: ["Couldn't load the ghost list. ", retryRoute()], error: true };
  }
  if (!list.length) return { title, fail: ["No ghosts recorded on this course yet. ", back] };
  const wanted = (route.query.pilots && route.query.pilots.length ? route.query.pilots : list.slice(0, 3).map((g) => g.callsign)).slice(0, 8);
  const recordEntry = list.find((g) => g.is_course_record) || list[0];
  const toLoad = [...new Set(wanted.concat([recordEntry.callsign]))];
  const docs = await Promise.all(toLoad.map((cs) => api.ghost(course.course_hash, cs, { signal }).catch(() => ({ callsign: cs, trace: null }))));
  const byCs = new Map(docs.map((d) => [d.callsign, d]));
  const shown = S().replayFromGhosts(wanted.filter((cs) => byCs.has(cs)).map((cs) => byCs.get(cs)));
  if (!shown.pilots.length) return { title, fail: ["None of those pilots has a readable ghost on this course. ", back], error: true };
  const refSrc = S().replayFromGhosts([byCs.get(recordEntry.callsign)]).pilots[0];
  const ref = shown.pilots.find((p) => refSrc && p.callsign === refSrc.callsign) || refSrc || shown.pilots[0];
  const names = shown.pilots.map((p) => p.callsign);
  return {
    title, eyebrow: "Replay theater", course, pilots: shown.pilots, ref, dropped: shown.dropped, medals: true,
    og: { kind: "record", ident: course.course_hash },
    refLabel: h("span", {}, "Against ", link.pilot(ref.callsign), "'s record ghost (" + S().fmtRaceTime(ref.time_ms) + ")."),
    back: h("a", { class: "btn btn-ghost", href: S().buildRoute("course", course.course_id) }, "← Course page"),
    routeFor: (tSec) => S().buildRoute("replay", course.course_id, { pilots: names, t: tSec }),
    samePilots: (q) => !q.pilots || q.pilots.join(",") === names.join(","),
  };
}

async function fromRace(route, cat, signal) {
  let json;
  try { json = await api.raceReplay(route.id, { signal }); } catch (e) {
    if (e.status === 404) return { fail: ["There's no race #" + route.id + " on this server. ", h("a", { href: "#/cups" }, "See recent races")] };
    return { fail: [e.timeout ? "The server took too long to answer. " : "Couldn't load that race. ", retryRoute()], error: true };
  }
  const race = json.race || {};
  const title = S().parseCourseName(race.course_name).title || "Race #" + route.id;
  const data = S().replayFromRace(json);
  const course = (cat && cat.byHash.get(race.course_hash)) || null;
  const back = race.cup_id != null ? h("a", { class: "btn btn-ghost", href: S().buildRoute("cup", race.cup_id) }, "← Cup") : h("a", { class: "btn btn-ghost", href: "#/cups" }, "← Races");
  const base = { title, eyebrow: "Race replay · " + S().fmtDate(race.started_at), results: data.results, back, og: { kind: "replay", ident: route.id } };
  if (!data.pilots.length) {
    return Object.assign(base, { fail: [data.results.length ? "No traces were recorded for this race, so there's nothing to fly. " : "This race has no results. ", h("a", { href: "#/cups" }, "Other races")] });
  }
  const ref = data.pilots[0];
  return Object.assign(base, {
    course, pilots: data.pilots, ref, dropped: data.dropped,
    refLabel: h("span", {}, "Against ", ref.status === "finished" && ref.pos === 1 ? "the winner, " : "", link.pilot(ref.callsign), ref.time_ms != null ? " (" + S().fmtRaceTime(ref.time_ms) + ")." : "."),
    routeFor: (tSec) => S().buildRoute("raceReplay", route.id, { t: tSec }),
    samePilots: () => true,
  });
}

function resultsTable(results) {
  return sortableTable([
    { key: "pos", label: "Pos", num: true, sort: false, cell: (x) => (x.status === "finished" ? String(x.pos) : "DNF") },
    { key: "callsign", label: "Pilot", sort: false, cell: (x) => link.pilot(x.callsign) },
    { key: "go_time_ms", label: "Time", num: true, sort: false, cell: (x) => (x.status === "finished" ? S().fmtRaceTime(x.go_time_ms) : "—") },
    { key: "points", label: "Pts", num: true, sort: false },
    { key: "model", label: "Model", sort: false, cell: (x) => x.model || "—" },
  ], results || [], { caption: "Race results" });
}

// ------------------------------------------------------------------ mount
export async function mount(root, route, ctx) {
  const signal = ctx.signal;
  const page = h("div", { class: "page" });
  root.appendChild(page);
  const status = h("p", { class: "state-msg", role: "status" }, "Loading the replay…");
  page.appendChild(status);
  const cat = await catalog(signal).catch(() => null);
  if (signal.aborted) return () => {};
  const src = route.name === "raceReplay" ? await fromRace(route, cat, signal) : await fromCourse(route, cat, signal);
  if (signal.aborted) return () => {};
  ctx.setTitle("Replay" + (src.title ? " · " + src.title : ""));
  if (!src.fail && src.og) ctx.setMeta({ title: "Replay · " + src.title, kind: src.og.kind, ident: src.og.ident });
  if (src.fail) {
    status.remove();
    page.append(h("div", { class: "page-head" }, h("div", {}, h("span", { class: "eyebrow", text: src.eyebrow || "Replay" }), h("h1", {}, src.title || "Replay")), src.back || null),
      h("p", { class: "state-msg " + (src.error ? "error" : "empty"), role: src.error ? "alert" : null }, src.fail));
    if (src.results && src.results.length) page.append(h("section", { class: "section" }, h("div", { class: "section-head" }, h("h2", {}, "Results")), h("div", { class: "panel panel-tight" }, resultsTable(src.results))));
    return () => {};
  }
  status.remove();
  return theater(page, src, route);
}

function theater(page, src, route) {
  const { title, pilots, ref } = src;
  const gates = (src.course && src.course.gate_coords) || [];
  pilots.forEach((p) => {
    p.color = GHOST_COLORS[(p.rank - 1) % GHOST_COLORS.length];
    p.crossings = S().gateCrossings(p.rows, gates);
    p.finishMs = p.status === "finished" ? p.rows[p.rows.length - 1].t : null;
    p.sectors = S().sectorTimes(p.crossings);
    p.visible = true;
  });
  if (!ref.crossings) ref.crossings = S().gateCrossings(ref.rows, gates);
  const duration = S().replayDuration(pilots);
  pilots.forEach((p) => { p.delta = p === ref ? [] : S().deltaVsReference(p.rows, ref.rows); });

  // The server's /share/record/... redirect lands on this course, same as /share/course/...
  // does — that's the only kind besides "course" the share page resolves correctly, so Share only
  // appears on a course-mode replay, not a race replay (kind "replay" has no page of its own yet).
  const shareBtn = src.og && src.og.kind === "record" ? h("button", { type: "button", class: "btn btn-ghost btn-sm" }, "Share") : null;
  if (shareBtn) shareBtn.addEventListener("click", async () => {
    const url = location.origin + "/share/record/" + encodeURIComponent(src.og.ident);
    toast((await copyText(url)) ? "Link copied" : "Couldn't copy; here it is: " + url);
  });
  page.append(h("div", { class: "page-head" },
    h("div", {}, h("span", { class: "eyebrow", text: src.eyebrow }), h("h1", {}, title)),
    h("div", { class: "btn-row" }, src.back, shareBtn)));
  if (!gates.length) page.append(h("p", { class: "warn" }, "This course has been edited since the race, so gates, splits and live gaps are off. The lines are exactly as flown."));

  // ---------------------------------------------------------------- state
  const st = { t: Math.min(duration, (route.query.t || 0) * 1000), playing: false, speed: 1, cam: "director", focus: pilots[0].id,
    director: null, lastUi: 0, lastDir: 0, prevT: 0, userCam: false };

  // ---------------------------------------------------------------- stage (2D always; 3D on top when possible)
  const W = 1280, H = 720;
  const allPts = gates.concat(...pilots.map((p) => p.rows.filter((_, i) => i % 8 === 0)));
  const P = S().makeProjector(allPts, W, H, 40);
  const markers = new Map();
  const svg2d = s("svg", { viewBox: "0 0 " + W + " " + H, role: "img", "aria-label": "Top-down replay of " + title },
    gates.length ? s("path", { d: S().buildTracePath(gates.map((g) => P(g.lat, g.lon))), class: "map-glow" }) : null,
    gates.map((g, i) => { const q = P(g.lat, g.lon); return s("g", {}, s("circle", { cx: q.x, cy: q.y, r: 7, class: i === 0 ? "map-start" : "map-gate" }), s("text", { x: q.x + 10, y: q.y - 8, class: "map-label", text: String(i + 1) })); }),
    pilots.map((p) => s("path", { d: S().buildTracePath(p.rows.filter((_, i) => i % 2 === 0).map((r) => P(r.lat, r.lon))), fill: "none", stroke: p.color, "stroke-opacity": "0.35", "stroke-width": 2 })),
    pilots.map((p) => { const m = s("g", {}, s("circle", { r: 9, fill: p.color, stroke: "#1d1029", "stroke-width": 3 }), s("text", { x: 13, y: -10, class: "map-label", text: p.callsign })); markers.set(p.id, m); return m; }));
  const stage = h("div", { class: "stage" }, svg2d);
  const hud = h("div", { class: "stage-hud", "aria-live": "off" });
  stage.appendChild(hud);

  // ---------------------------------------------------------------- controls
  const playBtn = h("button", { type: "button", class: "btn btn-primary btn-sm", "aria-label": "Play" }, "▶");
  const speedSel = h("select", { class: "speed", "aria-label": "Playback speed" }, SPEEDS.map((x) => h("option", { value: String(x), selected: x === 1 }, x + "×")));
  const clock = h("span", { class: "clock", "aria-live": "off" });
  const fill = h("div", { class: "scrub-fill" });
  const head = h("div", { class: "scrub-head" });
  const ticks = S().timelineTicks(ref.crossings, duration).map((tk) => { const el = h("div", { class: "scrub-tick", title: "Gate " + tk.label + " (" + ref.callsign + ")" }, h("span", { text: tk.label })); el.style.left = (tk.frac * 100) + "%"; return el; });
  const scrub = h("div", { class: "scrub", role: "slider", tabindex: "0", "aria-label": "Replay position", "aria-valuemin": "0", "aria-valuemax": String(Math.round(duration / 1000)) },
    h("div", { class: "scrub-track" }), fill, ticks, head);
  const copyBtn = h("button", { type: "button", class: "btn btn-ghost btn-sm" }, "Copy link at this moment");
  const camBtns = CAMS.map(([id, label], i) => h("button", { type: "button", class: "btn btn-ghost btn-sm", "aria-pressed": String(st.cam === id), dataset: { cam: id } }, h("kbd", { text: String(i + 1) }), " " + label));
  const cams = h("div", { class: "cams", role: "group", "aria-label": "Camera (keys 1 to 5)" }, camBtns);
  const timeline = h("div", { class: "timeline" }, playBtn, clock, scrub, speedSel);
  const fallbackSlot = h("div", { class: "viewer-fallback-slot" });

  // ---------------------------------------------------------------- side panel
  const pilotRows = new Map();
  const rowsBox = h("ul", { class: "pilot-rows" }, pilots.map((p) => {
    const pos = h("span", { class: "rank", text: "–" });
    const gap = h("span", { class: "t faint" });
    const eye = h("button", { type: "button", class: "icon-btn", "aria-pressed": "true", "aria-label": "Show " + p.callsign, title: "Show / hide" }, "👁");
    const focus = h("button", { type: "button", class: "icon-btn", "aria-pressed": String(p.id === st.focus), "aria-label": "Follow " + p.callsign, title: "Follow" }, "◎");
    const li = h("li", { class: "pilot-row", dataset: { focus: String(p.id === st.focus), hidden: "false" } },
      pos, h("span", {}, h("span", { class: "swatch", "aria-hidden": "true" }), " ", link.pilot(p.callsign)), gap, eye, focus);
    li.querySelector(".swatch").style.background = p.color;
    eye.addEventListener("click", () => { p.visible = !p.visible; eye.setAttribute("aria-pressed", String(p.visible)); li.dataset.hidden = String(!p.visible); markers.get(p.id).style.display = p.visible ? "" : "none"; if (g3d) g3d.setShow(p.id, p.visible); if (!p.visible && st.focus === p.id) { const v = pilots.find((x) => x.visible); if (v) setFocus(v.id); } render(true); });
    focus.addEventListener("click", () => { setFocus(p.id); if (st.cam === "director") setCam("chase"); });
    pilotRows.set(p.id, { li, pos, gap, focus });
    return li;
  }));

  let splits = null;
  if (gates.length) {
    const best = S().bestSectors(pilots.map((p) => p.sectors));
    const nSec = Math.max(...pilots.map((p) => p.sectors.length));
    const splitCols = [{ key: "callsign", label: "Pilot", sort: false, cell: (p) => h("span", { class: "cell-flex" }, src.medals ? medal(S().medalFor(p.time_ms, ref.time_ms)) : null, link.pilot(p.callsign)) }]
      .concat(Array.from({ length: nSec }, (_, i) => ({ key: "s" + i, label: "S" + (i + 1), num: true, sort: false,
        cell: (p) => (p.sectors[i] == null ? "—" : h("span", { class: best[i] === pilots.indexOf(p) ? "best" : null, text: secs(p.sectors[i]) })) })))
      .concat([{ key: "time_ms", label: "Total", num: true, sort: false, cell: (p) => (p.time_ms == null ? "DNF" : S().fmtRaceTime(p.time_ms)) }]);
    splits = sortableTable(splitCols, pilots, { className: "splits", caption: "Gate splits; fastest sector in purple" });
    splits.querySelectorAll("td span.best").forEach((sp) => sp.parentElement.classList.add("best"));
  }

  const CW = 320, CH = 120;
  const series = pilots.filter((p) => p !== ref && p.delta.length);
  const maxAbs = Math.max(500, ...series.flatMap((p) => p.delta.map((d) => Math.abs(d.delta))));
  const playhead = s("line", { x1: 0, x2: 0, y1: 0, y2: CH, class: "playhead" });
  const chart = s("svg", { viewBox: "0 0 " + CW + " " + CH, role: "img", "aria-label": "Time gained or lost against " + ref.callsign + " along the course" },
    s("line", { x1: 0, x2: CW, y1: CH / 2, y2: CH / 2, class: "zero" }),
    series.map((p) => s("path", { d: S().deltaChartPath(p.delta, duration, CW, CH, maxAbs).d, class: "series", stroke: p.color })),
    s("text", { x: 4, y: 12, class: "lbl", text: "ahead" }), s("text", { x: 4, y: CH - 4, class: "lbl", text: "+" + (maxAbs / 1000).toFixed(1) + " s behind" }),
    playhead);

  const clampBox = h("input", { type: "checkbox" });
  const clampLabel = h("label", { class: "toggle" }, clampBox, "Clamp ghosts above terrain");
  const lowWarn = h("p", { class: "warn", hidden: true });
  const side = h("aside", { class: "side", "aria-label": "Race panel" },
    h("section", { class: "panel" }, h("h2", {}, "Pilots"), rowsBox,
      src.dropped.length ? h("p", { class: "faint", text: "No readable trace for: " + src.dropped.join(", ") }) : null,
      h("p", { class: "faint" }, "Colors mark pilots; the moving label's color is their place (gold, silver, bronze).")),
    h("section", { class: "panel" }, h("h2", {}, "Delta"), h("p", { class: "faint" }, src.refLabel),
      series.length ? h("div", { class: "delta-chart" }, chart) : h("p", { class: "faint", text: "Add another pilot to compare lines." })),
    h("section", { class: "panel" }, h("h2", {}, "Options"), clampLabel,
      h("p", { class: "faint" }, "The 3D terrain isn't GeoFS's own; clamping lifts any ghost that dips into it."), lowWarn));

  page.append(
    h("div", { class: "theater" },
      h("div", {}, stage, fallbackSlot, timeline, h("div", { class: "btn-row cams-row" }, cams, copyBtn)),
      side),
    splits ? h("section", { class: "section", "aria-labelledby": "sp-h" }, h("div", { class: "section-head" }, h("h2", { id: "sp-h" }, "Gate splits"),
      h("p", { class: "section-sub" }, "Sector = gate to gate. Purple is the fastest of these pilots.")), h("div", { class: "panel panel-tight" }, splits)) : null,
    src.results && src.results.length ? h("section", { class: "section", "aria-labelledby": "rr-h" }, h("div", { class: "section-head" }, h("h2", { id: "rr-h" }, "Results")),
      h("div", { class: "panel panel-tight" }, resultsTable(src.results))) : null);

  // ---------------------------------------------------------------- 3D
  // Camera and clamp are 3D-only; disabled (title "3D only") until a mount succeeds, and again on
  // any later failure -- a "Retry 3D" in the fallback note (below) can bring them back.
  function set3dControlsEnabled(on) {
    camBtns.forEach((b) => { b.disabled = !on; b.title = on ? "" : "3D only"; });
    clampBox.disabled = !on;
    clampLabel.title = on ? "" : "3D only";
  }
  set3dControlsEnabled(false);

  let g3d = null;
  let dead = false;
  function attempt3D(force) {
    import("../globe.js").then((gl) => gl.mountReplay(stage, src.course || { gate_coords: [] }, pilots.map((p) => ({ id: p.id, callsign: p.callsign, rows: p.rows, modelId: p.modelId, color: p.color })),
      { onUserCamera: () => { st.userCam = true; }, force }))
      .then((handle) => {
        if (dead) { handle.destroy(); return; }
        clear(fallbackSlot);
        g3d = handle;
        svg2d.style.visibility = "hidden";
        pilots.forEach((p) => { if (!p.visible) g3d.setShow(p.id, false); });
        window.__hqReplay = { fps: () => g3d && g3d.fps() };
        set3dControlsEnabled(true);
        render(true);
      })
      .catch((e) => {
        if (dead) return;
        set3dControlsEnabled(false);
        import("../globe.js").then((gl) => {
          if (dead) return;
          const { note } = gl.buildFallbackNote(e, {
            suffix: " — this is the top-down replay.",
            onRetry: () => { clear(fallbackSlot); attempt3D(true); },
          });
          clear(fallbackSlot).appendChild(note);
        });
      });
  }
  if (FLAGS.COURSE_3D) attempt3D();

  // Low-level warning (terrain differs from GeoFS's).
  const terrainCtl = new AbortController();
  if (gates.length) {
    import("../terrain.js").then((tm) => tm.sampleHeights(gates, { signal: terrainCtl.signal, zoom: 11, maxTiles: 16 }))
      .then((ground) => {
        const agl = Math.min(...gates.map((g, i) => (g.alt || 0) - ground[i]));
        if (agl < LOW_LEVEL_AGL_M) { lowWarn.hidden = false; lowWarn.textContent = "Low-level course (lowest gate ~" + Math.round(agl) + " m above this terrain). Ghosts may clip ridges that GeoFS draws lower — try the clamp."; }
      }).catch(() => {});
  }

  const origRows = new Map(pilots.map((p) => [p.id, p.rows]));
  clampBox.addEventListener("change", async () => {
    if (!g3d) { toast("Clamping needs the 3D view."); clampBox.checked = false; return; }
    if (!clampBox.checked) { pilots.forEach((p) => g3d.rebuild(p.id, origRows.get(p.id))); return; }
    try {
      const tm = await import("../terrain.js");
      for (const p of pilots) {
        const srcRows = origRows.get(p.id);
        const step = Math.max(1, Math.floor(srcRows.length / 400));
        const idx = srcRows.map((_, i) => i).filter((i) => i % step === 0 || i === srcRows.length - 1);
        const ground = await tm.sampleHeights(idx.map((i) => srcRows[i]), { signal: terrainCtl.signal, zoom: 12, maxTiles: 40 });
        let k = 0;
        const rows = srcRows.map((r, i) => {
          while (k < idx.length - 1 && idx[k + 1] <= i) k++;
          const a = idx[k], b = idx[Math.min(idx.length - 1, k + 1)];
          const f = b > a ? (i - a) / (b - a) : 0;
          const gnd = ground[k] + ((ground[Math.min(idx.length - 1, k + 1)] - ground[k]) * f);
          return r.alt < gnd + 8 ? Object.assign({}, r, { alt: gnd + 8 }) : r;
        });
        g3d.rebuild(p.id, rows);
      }
      toast("Ghosts clamped above terrain");
    } catch (_) { toast("Couldn't read the terrain tiles"); clampBox.checked = false; }
  });

  // ---------------------------------------------------------------- behaviour
  function setFocus(id) {
    st.focus = id;
    for (const [pid, r] of pilotRows) { r.li.dataset.focus = String(pid === id); r.focus.setAttribute("aria-pressed", String(pid === id)); }
    render(true);
  }
  function setCam(id) {
    st.cam = id; st.userCam = false; st.director = null;
    camBtns.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.cam === id)));
    render(true);
  }
  function seek(ms) { st.t = Math.max(0, Math.min(duration, ms)); st.prevT = st.t; render(true); if (!st.playing) writeT(); }
  function writeT() { history.replaceState(null, "", src.routeFor(st.t / 1000)); }
  function setPlaying(v) {
    st.playing = v;
    playBtn.textContent = v ? "❚❚" : "▶";
    playBtn.setAttribute("aria-label", v ? "Pause" : "Play");
    if (v) { if (st.t >= duration) st.t = 0; lastFrame = performance.now(); raf = requestAnimationFrame(loop); }
    else writeT();
  }

  function nextGateFor(p, t) {
    if (!gates.length) return null;
    const i = p.crossings.findIndex((c) => c && c.t > t);
    return gates[i >= 0 ? i : gates.length - 1];
  }

  // Without gates there is no progress to rank by, so the order is the finishing order.
  function orderAt(vis, t) {
    if (gates.length) return S().raceOrderAt(vis, t);
    return vis.map((p) => ({ id: p.id, progress: 0, gapMs: null, finished: p.finishMs != null && t >= p.finishMs }));
  }

  let order = [];
  function render(forceUi) {
    const t = st.t;
    const vis = pilots.filter((p) => p.visible);
    order = orderAt(vis, t);
    // 2D markers
    for (const p of pilots) {
      const q = S().traceStateAt(p.rows, t);
      const pt = P(q.lat, q.lon);
      markers.get(p.id).setAttribute("transform", "translate(" + pt.x + " " + pt.y + ")");
    }
    // camera
    let camMode = st.cam, target = st.focus, gate = null;
    const wallS = performance.now() / 1000;
    if (st.cam === "director" && order.length) {
      if (!st.director || wallS - st.lastDir > 0.25 || forceUi) {
        const crossings = [];
        for (const p of vis) for (const c of p.crossings) if (c && c.t > st.prevT && c.t <= t) crossings.push({ id: p.id, gate: c.gate });
        st.director = S().directorStep(st.director, { t: wallS, order: order.map((o) => o.id), crossings });
        st.lastDir = wallS;
        st.prevT = t;
      }
      camMode = st.director.shot; target = st.director.target;
      if (camMode === "gate" && st.director.gate != null) gate = gates[st.director.gate];
    } else if (camMode === "gate") {
      gate = nextGateFor(pilots.find((p) => p.id === target) || pilots[0], t);
    }
    if (g3d) {
      g3d.setTime(t);
      const tp = pilots.find((p) => p.id === target) || pilots[0];
      if (!st.userCam) g3d.camera(camMode === "gate" && !gate ? "chase" : camMode, tp.id, S().traceStateAt(tp.rows, t), { gate, wallS });
      else g3d.camera("free", tp.id, null, {});
    }
    // scrubber
    const frac = t / duration;
    fill.style.width = (frac * 100) + "%";
    head.style.left = (frac * 100) + "%";
    scrub.setAttribute("aria-valuenow", String(Math.round(t / 1000)));
    scrub.setAttribute("aria-valuetext", S().fmtRaceTime(t));
    clock.textContent = S().fmtRaceTime(t);
    // throttled UI
    if (forceUi || wallS - st.lastUi > 1 / UI_HZ) {
      st.lastUi = wallS;
      order.forEach((o, i) => {
        const r = pilotRows.get(o.id);
        r.pos.textContent = String(i + 1);
        r.gap.textContent = o.finished ? "FIN" : i === 0 ? "Leader" : o.gapMs == null ? "—" : S().fmtGap(o.gapMs);
        if (g3d) g3d.setLabelColor(o.id, RANK_COLORS[i] || "#fff4ea");
      });
      for (const p of pilots) if (!p.visible) pilotRows.get(p.id).pos.textContent = "–";
      rowsBox.append(...order.map((o) => pilotRows.get(o.id).li), ...pilots.filter((p) => !p.visible).map((p) => pilotRows.get(p.id).li));
      const x = frac * CW;
      playhead.setAttribute("x1", x.toFixed(1)); playhead.setAttribute("x2", x.toFixed(1));
      clear(hud).append(h("span", { class: "hud-chip", text: (st.cam === "director" ? "Director · " + camMode : CAMS.find((c) => c[0] === st.cam)[1]) + (st.userCam ? " (free look — press 1–5)" : "") }),
        h("span", { class: "hud-chip", text: "Following " + target }));
    }
  }

  let raf = 0, lastFrame = 0;
  function loop(now) {
    if (!st.playing) return;
    const dt = Math.min(100, now - lastFrame);
    lastFrame = now;
    st.t += dt * st.speed;
    if (st.t >= duration) { st.t = duration; render(true); setPlaying(false); return; }
    render(false);
    raf = requestAnimationFrame(loop);
  }

  playBtn.addEventListener("click", () => setPlaying(!st.playing));
  speedSel.addEventListener("change", () => { st.speed = +speedSel.value; });
  camBtns.forEach((b) => b.addEventListener("click", () => setCam(b.dataset.cam)));
  copyBtn.addEventListener("click", async () => {
    const url = location.origin + location.pathname + src.routeFor(st.t / 1000);
    toast((await copyText(url)) ? "Link copied — opens at " + S().fmtRaceTime(st.t) : "Couldn't copy; the address bar has it");
    writeT();
  });
  const fromPointer = (e) => { const r = scrub.getBoundingClientRect(); seek(((e.clientX - r.left) / r.width) * duration); };
  scrub.addEventListener("pointerdown", (e) => { scrub.setPointerCapture(e.pointerId); fromPointer(e); scrub.addEventListener("pointermove", fromPointer); });
  scrub.addEventListener("pointerup", (e) => { scrub.releasePointerCapture(e.pointerId); scrub.removeEventListener("pointermove", fromPointer); });
  scrub.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 10000 : 2000;
    if (e.key === "ArrowRight") { seek(st.t + step); e.preventDefault(); }
    else if (e.key === "ArrowLeft") { seek(st.t - step); e.preventDefault(); }
    else if (e.key === "Home") { seek(0); e.preventDefault(); }
    else if (e.key === "End") { seek(duration); e.preventDefault(); }
  });
  const onKey = (e) => {
    if (e.target && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const n = +e.key;
    if (n >= 1 && n <= 5) { if (!g3d) return; setCam(CAMS[n - 1][0]); e.preventDefault(); }
    else if (e.key === " " && e.target === document.body) { setPlaying(!st.playing); e.preventDefault(); }
    else if (e.key === "+" || e.key === "=") { const i = Math.min(SPEEDS.length - 1, SPEEDS.indexOf(st.speed) + 1); st.speed = SPEEDS[i]; speedSel.value = String(st.speed); }
    else if (e.key === "-") { const i = Math.max(0, SPEEDS.indexOf(st.speed) - 1); st.speed = SPEEDS[i]; speedSel.value = String(st.speed); }
  };
  document.addEventListener("keydown", onKey);
  const onVis = () => { if (document.hidden && st.playing) setPlaying(false); };
  document.addEventListener("visibilitychange", onVis);

  render(true);
  // Autoplay unless the link pins a moment, or the viewer asked for less motion.
  if (!route.query.t && !reducedMotion()) setPlaying(true);

  return {
    cleanup() {
      dead = true;
      st.playing = false; cancelAnimationFrame(raf);
      terrainCtl.abort();
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("visibilitychange", onVis);
      if (g3d) g3d.destroy();
      delete window.__hqReplay;
    },
    // A new ?t= (a pasted link on the same replay) seeks rather than reloading.
    onQuery(r) {
      if (!src.samePilots(r.query)) return false;
      if (Number.isFinite(r.query.t)) { setPlaying(false); seek(r.query.t * 1000); }
      return true;
    },
  };
}
