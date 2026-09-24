// /replay/:course?pilots=a,b&t=secs — the replay theater. Up to 8 ghosts on one clock, five
// cameras (keys 1–5), a scrubbable timeline with gate ticks, live gaps, a sector table and a
// delta-vs-record chart. Runs in 3D when the tile hosts are reachable, and as a top-down 2D
// replay (same timeline, same panel) when they aren't.

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

export async function mount(root, route, ctx) {
  const signal = ctx.signal;
  const page = h("div", { class: "page" });
  root.appendChild(page);
  const cat = await catalog(signal).catch(() => null);
  if (signal.aborted) return () => {};
  const course = cat && cat.byId.get(route.id);
  if (!course) {
    ctx.setTitle("Replay");
    page.append(h("h1", {}, "Replay"), h("p", { class: "state-msg " + (cat ? "empty" : "error") },
      cat ? "No course called “" + route.id + "”. " : "Couldn't reach the server. ", cat ? h("a", { href: "#/courses" }, "Pick a course") : retryRoute()));
    return () => {};
  }
  const title = S().parseCourseName(course.course_name).title;
  ctx.setTitle("Replay · " + title);
  const status = h("p", { class: "state-msg", role: "status" }, "Loading ghosts…");
  page.append(
    h("div", { class: "page-head" },
      h("div", {}, h("span", { class: "eyebrow", text: "Replay theater" }), h("h1", {}, title)),
      h("div", { class: "btn-row" }, h("a", { class: "btn btn-ghost", href: S().buildRoute("course", course.course_id) }, "← Course page"))),
    status);

  // ---------------------------------------------------------------- load ghosts
  let list = [];
  try { list = await api.ghosts(course.course_hash, { signal }); } catch (e) { if (e.status !== 404) { status.className = "state-msg error"; clear(status).append("Couldn't load the ghost list. ", retryRoute()); return () => {}; } }
  if (signal.aborted) return () => {};
  if (!list.length) { status.className = "state-msg empty"; clear(status).append("No ghosts recorded on this course yet. ", h("a", { href: S().buildRoute("course", course.course_id) }, "Back to the course")); return () => {}; }
  const wanted = (route.query.pilots && route.query.pilots.length ? route.query.pilots : list.slice(0, 3).map((g) => g.callsign)).slice(0, 8);
  const recordEntry = list.find((g) => g.is_course_record) || list[0];
  const toLoad = [...new Set(wanted.concat([recordEntry.callsign]))];
  const fetched = await Promise.all(toLoad.map((cs) => api.ghost(course.course_hash, cs, { signal }).then((gh) => ({ cs, gh })).catch(() => ({ cs, gh: null }))));
  if (signal.aborted) return () => {};
  const missing = [];
  const byCs = new Map();
  for (const f of fetched) {
    const rows = f.gh && S().traceRows(f.gh.trace);
    if (!rows) { if (wanted.includes(f.cs)) missing.push(f.cs); continue; }
    byCs.set(f.cs, { callsign: f.cs, rows, time_ms: f.gh.time_ms, modelId: f.gh.model, recorded: f.gh.created_at });
  }
  const pilots = wanted.filter((cs) => byCs.has(cs)).map((cs) => byCs.get(cs));
  if (!pilots.length) { status.className = "state-msg error"; status.textContent = "None of those pilots has a readable ghost on this course."; return () => {}; }
  pilots.sort((a, b) => a.time_ms - b.time_ms);
  pilots.forEach((p, i) => {
    p.id = p.callsign; p.color = GHOST_COLORS[i % GHOST_COLORS.length];
    p.crossings = S().gateCrossings(p.rows, course.gate_coords);
    p.finishMs = p.rows[p.rows.length - 1].t;
    p.sectors = S().sectorTimes(p.crossings);
    p.visible = true;
  });
  const ref = byCs.get(recordEntry.callsign) || pilots[0];
  ref.crossings = ref.crossings || S().gateCrossings(ref.rows, course.gate_coords);
  const duration = Math.max(...pilots.map((p) => p.finishMs)) + 1500;
  pilots.forEach((p) => { p.delta = p === ref ? [] : S().deltaVsReference(p.rows, ref.rows); });
  status.remove();

  // ---------------------------------------------------------------- state
  const st = { t: Math.min(duration, (route.query.t || 0) * 1000), playing: false, speed: 1, cam: "director", focus: pilots[0].id,
    director: null, lastUi: 0, lastDir: 0, prevT: 0, userCam: false };

  // ---------------------------------------------------------------- stage (2D always; 3D on top when possible)
  const W = 1280, H = 720;
  const allPts = course.gate_coords.concat(...pilots.map((p) => p.rows.filter((_, i) => i % 8 === 0)));
  const P = S().makeProjector(allPts, W, H, 40);
  const markers = new Map();
  const svg2d = s("svg", { viewBox: "0 0 " + W + " " + H, role: "img", "aria-label": "Top-down replay of " + title },
    s("path", { d: S().buildTracePath(course.gate_coords.map((g) => P(g.lat, g.lon))), class: "map-glow" }),
    course.gate_coords.map((g, i) => { const q = P(g.lat, g.lon); return s("g", {}, s("circle", { cx: q.x, cy: q.y, r: 7, class: i === 0 ? "map-start" : "map-gate" }), s("text", { x: q.x + 10, y: q.y - 8, class: "map-label", text: String(i + 1) })); }),
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
  const ticks = S().timelineTicks(ref.crossings, duration).map((tk) => { const el = h("div", { class: "scrub-tick", title: "Gate " + tk.label + " (record)" }, h("span", { text: tk.label })); el.style.left = (tk.frac * 100) + "%"; return el; });
  const scrub = h("div", { class: "scrub", role: "slider", tabindex: "0", "aria-label": "Replay position", "aria-valuemin": "0", "aria-valuemax": String(Math.round(duration / 1000)) },
    h("div", { class: "scrub-track" }), fill, ticks, head);
  const copyBtn = h("button", { type: "button", class: "btn btn-ghost btn-sm" }, "Copy link at this moment");
  const camBtns = CAMS.map(([id, label], i) => h("button", { type: "button", class: "btn btn-ghost btn-sm", "aria-pressed": String(st.cam === id), dataset: { cam: id } }, h("kbd", { text: String(i + 1) }), " " + label));
  const cams = h("div", { class: "cams", role: "group", "aria-label": "Camera (keys 1 to 5)" }, camBtns);
  const timeline = h("div", { class: "timeline" }, playBtn, clock, scrub, speedSel);

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

  const best = S().bestSectors(pilots.map((p) => p.sectors));
  const nSec = Math.max(...pilots.map((p) => p.sectors.length));
  const splitCols = [{ key: "callsign", label: "Pilot", sort: false, cell: (p) => h("span", { class: "cell-flex" }, medal(S().medalFor(p.time_ms, ref.time_ms)), p.callsign) }]
    .concat(Array.from({ length: nSec }, (_, i) => ({ key: "s" + i, label: "S" + (i + 1), num: true, sort: false,
      cell: (p) => (p.sectors[i] == null ? "—" : h("span", { class: best[i] === pilots.indexOf(p) ? "best" : null, text: secs(p.sectors[i]) })) })))
    .concat([{ key: "time_ms", label: "Total", num: true, sort: false, cell: (p) => S().fmtRaceTime(p.time_ms) }]);
  const splits = sortableTable(splitCols, pilots, { className: "splits", caption: "Gate splits; fastest sector in purple" });
  splits.querySelectorAll("td span.best").forEach((sp) => sp.parentElement.classList.add("best"));

  const CW = 320, CH = 120;
  const series = pilots.filter((p) => p !== ref && p.delta.length);
  const maxAbs = Math.max(500, ...series.flatMap((p) => p.delta.map((d) => Math.abs(d.delta))));
  const playhead = s("line", { x1: 0, x2: 0, y1: 0, y2: CH, class: "playhead" });
  const chart = s("svg", { viewBox: "0 0 " + CW + " " + CH, role: "img", "aria-label": "Time gained or lost against " + ref.callsign + "'s record ghost along the course" },
    s("line", { x1: 0, x2: CW, y1: CH / 2, y2: CH / 2, class: "zero" }),
    series.map((p) => s("path", { d: S().deltaChartPath(p.delta, duration, CW, CH, maxAbs).d, class: "series", stroke: p.color })),
    s("text", { x: 4, y: 12, class: "lbl", text: "ahead" }), s("text", { x: 4, y: CH - 4, class: "lbl", text: "+" + (maxAbs / 1000).toFixed(1) + " s behind" }),
    playhead);

  const clampBox = h("input", { type: "checkbox" });
  const lowWarn = h("p", { class: "warn", hidden: true });
  const side = h("aside", { class: "side", "aria-label": "Race panel" },
    h("section", { class: "panel" }, h("h2", {}, "Pilots"), rowsBox,
      missing.length ? h("p", { class: "faint", text: "No readable ghost for: " + missing.join(", ") }) : null,
      h("p", { class: "faint" }, "Colors mark pilots; the moving label's color is their place (gold, silver, bronze).")),
    h("section", { class: "panel" }, h("h2", {}, "Delta vs record"), h("p", { class: "faint" }, "Against ", link.pilot(ref.callsign), "'s ghost (" + S().fmtRaceTime(ref.time_ms) + ")."), h("div", { class: "delta-chart" }, chart)),
    h("section", { class: "panel" }, h("h2", {}, "Options"), h("label", { class: "toggle" }, clampBox, "Clamp ghosts above terrain"),
      h("p", { class: "faint" }, "The 3D terrain isn't GeoFS's own; clamping lifts any ghost that dips into it."), lowWarn));

  page.append(
    h("div", { class: "theater" },
      h("div", {}, stage, timeline, h("div", { class: "btn-row cams-row" }, cams, copyBtn)),
      side),
    h("section", { class: "section", "aria-labelledby": "sp-h" }, h("div", { class: "section-head" }, h("h2", { id: "sp-h" }, "Gate splits"),
      h("p", { class: "section-sub" }, "Sector = gate to gate. Purple is the fastest of these pilots.")), h("div", { class: "panel panel-tight" }, splits)));

  // ---------------------------------------------------------------- 3D
  let g3d = null;
  if (FLAGS.COURSE_3D) {
    import("../globe.js").then((gl) => gl.mountReplay(stage, course, pilots.map((p) => ({ id: p.id, callsign: p.callsign, rows: p.rows, modelId: p.modelId, color: p.color })),
      { onUserCamera: () => { st.userCam = true; } }))
      .then((handle) => {
        if (signal.aborted) { handle.destroy(); return; }
        g3d = handle;
        svg2d.style.visibility = "hidden";
        pilots.forEach((p) => { if (!p.visible) g3d.setShow(p.id, false); });
        window.__hqReplay = { fps: () => g3d && g3d.fps() };
        render(true);
      })
      .catch((e) => {
        if (signal.aborted) return;
        stage.appendChild(h("p", { class: "viewer-note", text: e && e.blocked
          ? "3D needs the satellite tile hosts, which aren't reachable from here — this is the top-down replay."
          : "3D unavailable on this device — this is the top-down replay." }));
      });
  }

  // Low-level warning (terrain differs from GeoFS's).
  import("../terrain.js").then((tm) => tm.sampleHeights(course.gate_coords, { signal, zoom: 11, maxTiles: 16 }))
    .then((ground) => {
      const agl = Math.min(...course.gate_coords.map((g, i) => (g.alt || 0) - ground[i]));
      if (agl < LOW_LEVEL_AGL_M) { lowWarn.hidden = false; lowWarn.textContent = "Low-level course (lowest gate ~" + Math.round(agl) + " m above this terrain). Ghosts may clip ridges that GeoFS draws lower — try the clamp."; }
    }).catch(() => {});

  const origRows = new Map(pilots.map((p) => [p.id, p.rows]));
  clampBox.addEventListener("change", async () => {
    if (!g3d) { toast("Clamping needs the 3D view."); clampBox.checked = false; return; }
    if (!clampBox.checked) { pilots.forEach((p) => g3d.rebuild(p.id, origRows.get(p.id))); return; }
    try {
      const tm = await import("../terrain.js");
      for (const p of pilots) {
        const src = origRows.get(p.id);
        const step = Math.max(1, Math.floor(src.length / 400));
        const idx = src.map((_, i) => i).filter((i) => i % step === 0 || i === src.length - 1);
        const ground = await tm.sampleHeights(idx.map((i) => src[i]), { signal, zoom: 12, maxTiles: 40 });
        let k = 0;
        const rows = src.map((r, i) => {
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
  function writeT() { history.replaceState(null, "", S().buildRoute("replay", course.course_id, { pilots: pilots.map((p) => p.callsign), t: st.t / 1000 })); }
  function setPlaying(v) {
    st.playing = v;
    playBtn.textContent = v ? "❚❚" : "▶";
    playBtn.setAttribute("aria-label", v ? "Pause" : "Play");
    if (v) { if (st.t >= duration) st.t = 0; lastFrame = performance.now(); raf = requestAnimationFrame(loop); }
    else writeT();
  }

  function nextGateFor(p, t) {
    const i = p.crossings.findIndex((c) => c && c.t > t);
    return course.gate_coords[i >= 0 ? i : course.gate_coords.length - 1];
  }

  let order = [];
  function render(forceUi) {
    const t = st.t;
    const vis = pilots.filter((p) => p.visible);
    order = S().raceOrderAt(vis, t);
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
      if (camMode === "gate" && st.director.gate != null) gate = course.gate_coords[st.director.gate];
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
    const url = location.origin + location.pathname + S().buildRoute("replay", course.course_id, { pilots: pilots.map((p) => p.callsign), t: st.t / 1000 });
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
    if (n >= 1 && n <= 5) { setCam(CAMS[n - 1][0]); e.preventDefault(); }
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
      st.playing = false; cancelAnimationFrame(raf);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("visibilitychange", onVis);
      if (g3d) g3d.destroy();
      delete window.__hqReplay;
    },
    // A new ?t= (a pasted link on the same replay) seeks rather than reloading.
    onQuery(r) {
      const same = (r.query.pilots || []).join(",") === pilots.map((p) => p.callsign).join(",") || !r.query.pilots;
      if (!same) return false;
      if (Number.isFinite(r.query.t)) { setPlaying(false); seek(r.query.t * 1000); }
      return true;
    },
  };
}
