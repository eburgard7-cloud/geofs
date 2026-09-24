// /records — Hall of Fame: every course record (holder, time, margin to #2, date set, reign), and
// the medal table (pilots x gold/silver/bronze), both sortable. Computed from /leaderboard per
// raced course (js/data.js).

import { allBoards } from "../data.js";
import { FLAGS } from "../config.js";
import { h, dataBlock, link, medal, sortableTable, getMe } from "../ui.js";

const S = () => window.FinsSite;

function hallOfFame(recs) {
  const me = getMe();
  return sortableTable([
    { key: "course_name", label: "Course", defaultAsc: true, sort: (a, b) => a.course_name.localeCompare(b.course_name),
      cell: (r) => h("span", {}, link.course(r.course_id, S().parseCourseName(r.course_name).title), r.cup ? h("span", { class: "faint", text: " · " + r.cup }) : null) },
    { key: "holder", label: "Holder", defaultAsc: true, sort: (a, b) => a.holder.localeCompare(b.holder), cell: (r) => h("span", { class: "cell-flex" }, medal("gold"), link.pilot(r.holder)) },
    { key: "time_ms", label: "Time", num: true, defaultAsc: true, cell: (r) => h("span", { class: "t", text: S().fmtRaceTime(r.time_ms) }) },
    { key: "margin_ms", label: "Margin", num: true, sort: (a, b) => (a.margin_ms ?? -1) - (b.margin_ms ?? -1),
      cell: (r) => (r.second ? h("span", {}, h("span", { class: "t", text: S().fmtGap(r.margin_ms) }), h("span", { class: "faint", text: " over " }), link.pilot(r.second.callsign)) : h("span", { class: "faint", text: "unchallenged" })) },
    { key: "set_at", label: "Set", cell: (r) => h("span", { class: "faint", text: S().fmtDate(r.set_at) }) },
    { key: "reign_s", label: "Reign", num: true, cell: (r) => h("span", { title: FLAGS.RECORD_HISTORY ? "" : "Time since the record run; the server does not keep record history yet", text: S().fmtDuration(r.reign_s) }) },
    { key: "pilots", label: "Pilots", num: true },
  ], recs, { sortKey: "reign_s", caption: "Course records", rowClass: (r) => (me && r.holder === me ? "me" : null) });
}

function medalTableView(rows) {
  const me = getMe();
  // Ascending comparators with medal-table tie-breaks; the table negates them for descending, so a
  // tie on the clicked column still falls back to gold, then silver, then bronze.
  const sortFor = (key) => (a, b) => (a[key] - b[key]) || (a.gold - b.gold) || (a.silver - b.silver) || (a.bronze - b.bronze) || b.callsign.localeCompare(a.callsign);
  return sortableTable([
    { key: "rank", label: "#", num: true, sort: false, cell: (r, i) => h("span", { class: "rank", text: String(i + 1) }) },
    { key: "callsign", label: "Pilot", defaultAsc: true, sort: (a, b) => a.callsign.localeCompare(b.callsign), cell: (r) => link.pilot(r.callsign) },
    { key: "gold", label: "Gold", num: true, sort: sortFor("gold"), cell: (r) => h("span", { class: "cell-flex" }, medal("gold"), String(r.gold)) },
    { key: "silver", label: "Silver", num: true, sort: sortFor("silver"), cell: (r) => h("span", { class: "cell-flex" }, medal("silver"), String(r.silver)) },
    { key: "bronze", label: "Bronze", num: true, sort: sortFor("bronze"), cell: (r) => h("span", { class: "cell-flex" }, medal("bronze"), String(r.bronze)) },
    { key: "total", label: "Total", num: true, sort: sortFor("total") },
    { key: "records", label: "Records", num: true, sort: sortFor("records") },
  ], rows, { sortKey: "gold", caption: "Medal table", rowClass: (r) => (me && r.callsign === me ? "me" : null) });
}

export function mount(root, route, ctx) {
  ctx.setTitle("Hall of Fame");
  const recBlock = h("div", { class: "block" });
  const medBlock = h("div", { class: "block" });
  root.appendChild(h("div", { class: "page" },
    h("div", { class: "page-head" }, h("div", {}, h("span", { class: "eyebrow", text: "Hall of Fame" }), h("h1", {}, "Records"),
      h("p", {}, "Every course record and who holds it. Medals: gold within 2 % of a course record, silver 5 %, bronze 10 %."))),
    h("section", { class: "section", "aria-labelledby": "cr-h" }, h("div", { class: "section-head" }, h("h2", { id: "cr-h" }, "Course records"),
      h("p", { class: "section-sub" }, "Reign counts from the record run's date.")), h("div", { class: "panel panel-tight" }, recBlock)),
    h("section", { class: "section", "aria-labelledby": "mt-h" }, h("div", { class: "section-head" }, h("h2", { id: "mt-h" }, "Medal table")), h("div", { class: "panel panel-tight" }, medBlock))));
  const load = (sg) => allBoards(sg);
  const a = dataBlock(recBlock, { load, render: (b) => hallOfFame(S().buildRecords(b.boards, b.courses, Date.now())), isEmpty: (b) => !Object.keys(b.boards).length,
    skeleton: "rows", skeletonCount: 6, empty: "No records yet. Every course is up for grabs." });
  const m = dataBlock(medBlock, { load, render: (b) => medalTableView(S().medalTable(b.boards)), isEmpty: (b) => !Object.keys(b.boards).length,
    skeleton: "rows", skeletonCount: 4, empty: "No medals handed out yet." });
  return () => { a.destroy(); m.destroy(); };
}
