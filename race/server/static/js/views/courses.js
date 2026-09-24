// /courses — every catalog course, grouped by cup, filterable. Each card: SVG route mini-map,
// record holder, and your medal (for the callsign saved with "Show my medals").

import { allBoards, catalog } from "../data.js";
import { h, clear, dataBlock, courseChips, chip, routeSvg, medal, meForm, getMe, link } from "../ui.js";

const S = () => window.FinsSite;
const DIFFS = ["easy", "medium", "hard", "tight"];
const CLASSES = ["race", "pylon", "bush"];
const FILTER_KEY = "fins.hq.courseFilter";

function loadFilter() {
  try { return Object.assign({ cup: "", diff: [], cls: [], raced: false, q: "" }, JSON.parse(sessionStorage.getItem(FILTER_KEY) || "{}")); }
  catch (_) { return { cup: "", diff: [], cls: [], raced: false, q: "" }; }
}
function saveFilter(f) { try { sessionStorage.setItem(FILTER_KEY, JSON.stringify(f)); } catch (_) { /* ignore */ } }

function card(c, top, me) {
  const p = S().parseCourseName(c.course_name);
  const rec = top && top[0];
  const mine = me && top ? top.find((r) => r.callsign === me) : null;
  const myMedal = mine ? S().medalFor(mine.time_ms, rec.time_ms) : null;
  return h("li", { class: "course-card" },
    routeSvg(c.gate_coords, 320, 180, { label: "Route of " + p.title }),
    mine ? h("span", { class: "me-medal" }, medal(myMedal, true)) : null,
    h("div", { class: "course-card-body" },
      h("h3", {}, h("a", { href: S().buildRoute("course", c.course_id), text: p.title })),
      h("div", { class: "meta" }, courseChips(c), chip(S().fmtKm(c.length_km))),
      h("div", { class: "rec" }, rec
        ? [h("span", {}, "Record: ", h("span", { class: "t", text: S().fmtRaceTime(rec.time_ms) })), link.pilot(rec.callsign)]
        : h("span", { class: "faint", text: "No time yet — go claim it" }))));
}

function toggleChip(label, on, onClick) {
  return h("button", { type: "button", class: "chip", "aria-pressed": String(!!on), onClick }, label);
}

export async function mount(root, route, ctx) {
  ctx.setTitle("Courses");
  const f = loadFilter();
  const head = h("div", { class: "page-head" },
    h("div", {}, h("span", { class: "eyebrow", text: "The whole catalog" }), h("h1", {}, "Courses"),
      h("p", {}, "Every course in the shared list, grouped by cup. Pick one to see its 3D flyover, leaderboard and ghosts.")));
  const filters = h("div", { class: "filters", role: "group", "aria-label": "Filter courses" });
  const body = h("div", { class: "block" });
  root.appendChild(h("div", { class: "page" }, head, filters, body));

  let data = null;
  const me = () => getMe();

  function draw() {
    if (!data) return;
    saveFilter(f);
    clear(filters);
    const cups = [...new Set(data.cat.list.map((c) => c.cup || "Other"))].sort();
    const sel = h("select", { "aria-label": "Cup", onChange: (e) => { f.cup = e.target.value; draw(); } },
      h("option", { value: "" }, "All cups"), cups.map((c) => h("option", { value: c, selected: f.cup === c }, c)));
    const search = h("input", { type: "search", placeholder: "Search courses", "aria-label": "Search courses", value: f.q });
    search.addEventListener("input", () => { f.q = search.value; drawList(); saveFilter(f); });
    const flip = (arr, v) => { const i = arr.indexOf(v); if (i >= 0) arr.splice(i, 1); else arr.push(v); draw(); };
    filters.append(
      h("div", { class: "filter-group" }, sel, search),
      h("div", { class: "filter-group" }, h("span", { text: "Difficulty" }), DIFFS.map((d) => toggleChip(d, f.diff.includes(d), () => flip(f.diff, d)))),
      h("div", { class: "filter-group" }, h("span", { text: "Class" }), CLASSES.map((d) => toggleChip(d, f.cls.includes(d), () => flip(f.cls, d)))),
      h("div", { class: "filter-group" }, toggleChip("has a record", f.raced, () => { f.raced = !f.raced; draw(); })),
      meForm(data.pilots));
    drawList();
  }

  function drawList() {
    const q = f.q.trim().toLowerCase();
    const list = data.cat.list.filter((c) => {
      if (f.cup && (c.cup || "Other") !== f.cup) return false;
      if (f.diff.length && !f.diff.includes(c.difficulty)) return false;
      if (f.cls.length && !f.cls.includes(S().courseClass(c.cup, c.course_id))) return false;
      if (f.raced && !data.boards[c.course_hash]) return false;
      if (q && !(c.course_name.toLowerCase().includes(q) || c.course_id.includes(q))) return false;
      return true;
    });
    clear(body);
    if (!list.length) { body.appendChild(h("p", { class: "state-msg empty" }, "No course matches those filters.")); return; }
    const groups = new Map();
    for (const c of list) { const k = c.cup || "Other"; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(c); }
    const order = { easy: 0, medium: 1, hard: 2, tight: 3 };
    const who = me();
    for (const [cup, cs] of [...groups.entries()].sort((a, b) => (a[0] === "Other") - (b[0] === "Other") || a[0].localeCompare(b[0]))) {
      cs.sort((a, b) => (order[a.difficulty] ?? 9) - (order[b.difficulty] ?? 9) || a.course_name.localeCompare(b.course_name));
      body.appendChild(h("section", { class: "cup-group", "aria-label": cup },
        h("h2", {}, cup, h("small", { text: cs.length + " course" + (cs.length === 1 ? "" : "s") })),
        h("ul", { class: "grid grid-cards" }, cs.map((c) => card(c, data.boards[c.course_hash], who)))));
    }
  }

  const block = dataBlock(body, {
    load: async (sg) => {
      const [cat, b] = await Promise.all([catalog(sg), allBoards(sg)]);
      const pilots = S().pilotIndex(b.boards, []).map((p) => p.callsign);
      return { cat, boards: b.boards, pilots };
    },
    render: (d) => { data = d; return h("div"); },
    after: () => draw(),
    isEmpty: (d) => !d.cat.list.length,
    skeleton: "cards", skeletonCount: 6,
    empty: "The course catalog is empty on this server.",
  });
  const onMe = () => drawList();
  window.addEventListener("fins:me", onMe);
  return () => { block.destroy(); window.removeEventListener("fins:me", onMe); };
}
