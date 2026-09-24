// /cups — cups (open first) and recent lobby race results. /cup/:id — one cup's standings and
// races. Seasons are hidden: the server has none yet (FLAGS.SEASONS).

import { api } from "../api.js";
import { FLAGS } from "../config.js";
import { h, dataBlock, link, chip, sortableTable } from "../ui.js";

const S = () => window.FinsSite;
const MEDALS = ["gold", "silver", "bronze"];

function standingsTable(rows) {
  return sortableTable([
    { key: "pos", label: "#", num: true, sort: false, cell: (r, i) => h("span", { class: "rank", text: String(i + 1) }) },
    { key: "callsign", label: "Pilot", sort: false, cell: (r) => link.pilot(r.callsign) },
    { key: "points", label: "Points", num: true, sort: false },
    { key: "races", label: "Races", num: true, sort: false },
    { key: "wins", label: "Wins", num: true, sort: false },
  ], rows || [], { caption: "Cup standings" });
}

function cupCard(c) {
  return h("li", { class: "cup-item" },
    h("header", {}, h("a", { class: "course-link", href: S().buildRoute("cup", c.id) }, h("strong", { text: c.name })),
      h("span", {}, c.open ? chip("running", "live") : chip("finished"), " ", h("span", { class: "faint", text: "race " + c.races_run + " of " + c.race_count })),
    ),
    h("ol", { class: "standings" }, (c.standings || []).slice(0, 5).map((s, i) => h("li", {},
      h("span", { class: "faint", text: String(i + 1) }), link.pilot(s.callsign), h("span", { class: "t", text: s.points + " pts" })))),
    h("p", { class: "faint", text: "Started " + S().timeAgo(c.created_at) }));
}

function raceResults(races) {
  return h("ul", { class: "race-list" }, races.map((r) => h("li", { class: "race-item" },
    h("header", {}, h("strong", { text: S().parseCourseName(r.course_name).title }),
      h("span", { class: "faint", text: (r.cup_name ? r.cup_name + " · " : "") + S().fmtDate(r.started_at) + " · " + S().timeAgo(r.started_at) })),
    h("details", {}, h("summary", {}, h("span", { class: "podium" }, (r.results || []).filter((x) => x.status === "finished").slice(0, 3).map((x) =>
      h("span", { class: "cell-flex" }, h("span", { class: "medal medal-" + MEDALS[x.pos - 1], "aria-hidden": "true", text: String(x.pos) }), x.callsign, h("span", { class: "faint t", text: S().fmtRaceTime(x.go_time_ms) }))))),
      sortableTable([
        { key: "pos", label: "Pos", num: true, sort: false, cell: (x) => (x.status === "finished" ? String(x.pos) : "DNF") },
        { key: "callsign", label: "Pilot", sort: false, cell: (x) => link.pilot(x.callsign) },
        { key: "go_time_ms", label: "Time", num: true, sort: false, cell: (x) => S().fmtRaceTime(x.go_time_ms) },
        { key: "points", label: "Pts", num: true, sort: false },
        { key: "model", label: "Model", sort: false, cell: (x) => x.model || "—" },
      ], r.results || [], { caption: "Results" })))));
}

function mountList(root, ctx) {
  ctx.setTitle("Cups");
  const cupsBlock = h("div", { class: "block" });
  const racesBlock = h("div", { class: "block" });
  root.appendChild(h("div", { class: "page" },
    h("div", { class: "page-head" }, h("div", {}, h("span", { class: "eyebrow", text: "Cup night" }), h("h1", {}, "Cups & results"),
      h("p", {}, "Points go 15, 12, 10, 8, 6, 4, 2, 1. A host starts a cup from the lobby; every lobby race lands here when it finishes."))),
    FLAGS.SEASONS ? h("section", { class: "section" }, h("h2", {}, "Season")) : null,
    h("div", { class: "split" },
      h("section", { "aria-labelledby": "cl-h" }, h("div", { class: "section-head" }, h("h2", { id: "cl-h" }, "Cups")), cupsBlock),
      h("section", { "aria-labelledby": "rr-h" }, h("div", { class: "section-head" }, h("h2", { id: "rr-h" }, "Recent races")), racesBlock))));
  const a = dataBlock(cupsBlock, {
    load: (sg) => api.cups({ limit: 50 }, { signal: sg }).then((cs) => cs.slice().sort((x, y) => (y.open - x.open) || (y.id - x.id))),
    render: (cs) => h("ul", { class: "cup-list" }, cs.map(cupCard)), skeleton: "rows",
    empty: "No cups yet. The lobby host starts one with Start cup.",
  });
  const b = dataBlock(racesBlock, {
    load: (sg) => api.racesRecent(30, { signal: sg }), render: raceResults, skeleton: "rows", skeletonCount: 4,
    empty: "No lobby races finished yet.",
  });
  return () => { a.destroy(); b.destroy(); };
}

function mountCup(root, id, ctx) {
  ctx.setTitle("Cup");
  const head = h("div", { class: "page-head" });
  const body = h("div", { class: "block" });
  root.appendChild(h("div", { class: "page" }, head, body));
  const blk = dataBlock(body, {
    load: (sg) => api.cup(id, { signal: sg }), notFoundIsEmpty: true, empty: "There's no cup #" + id + ".",
    render: (c) => {
      ctx.setTitle(c.name);
      head.append(h("div", {}, h("span", { class: "eyebrow", text: c.open ? "Cup · running" : "Cup · finished" }), h("h1", {}, c.name),
        h("p", {}, "Race " + c.races_run + " of " + c.race_count + " · started " + S().fmtDate(c.created_at))),
        h("a", { class: "btn btn-ghost", href: "#/cups" }, "All cups"));
      return h("div", { class: "split" },
        h("section", { "aria-labelledby": "st-h" }, h("div", { class: "section-head" }, h("h2", { id: "st-h" }, "Standings")), h("div", { class: "panel panel-tight" }, standingsTable(c.standings))),
        h("section", { "aria-labelledby": "ra-h" }, h("div", { class: "section-head" }, h("h2", { id: "ra-h" }, "Races")),
          (c.races || []).length ? h("ol", { class: "race-list" }, c.races.map((r, i) => h("li", { class: "race-item" },
            h("header", {}, h("strong", { text: (i + 1) + ". " + S().parseCourseName(r.course_name).title }), h("span", { class: "faint", text: S().fmtDate(r.started_at) })),
            h("p", {}, r.winner ? h("span", {}, "Won by ", link.pilot(r.winner)) : h("span", { class: "faint", text: "No finisher" })))))
            : h("p", { class: "state-msg empty" }, "No races finished yet.")));
    },
  });
  return () => blk.destroy();
}

export function mount(root, route, ctx) {
  const id = route.name === "cup" ? route.id : route.query.id;
  return id ? mountCup(root, id, ctx) : mountList(root, ctx);
}
