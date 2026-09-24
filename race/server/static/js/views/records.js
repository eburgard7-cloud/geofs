// /records — Hall of Fame: every course record (holder, time, margin to #2, date set, reign), the
// "dethroned" feed (who took which record from whom), and the medal table (pilots x
// gold/silver/bronze), all sortable. Records and medals come from /leaderboard per raced course
// (js/data.js); reigns and the feed from /records/history when FLAGS.RECORD_HISTORY is on.

import { allBoards, recordHistories } from "../data.js";
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
    { key: "reign_s", label: "Reign", num: true, cell: (r) => h("span", {
      title: r.reign_from === "history" ? "Holding it since " + S().fmtDate(r.reign_since) : "Counted from the record run; no record history for this course",
      text: S().fmtDuration(r.reign_s) + (r.reign_from === "history" ? "" : "*") }) },
    { key: "pilots", label: "Pilots", num: true },
  ], recs, { sortKey: "reign_s", caption: "Course records", rowClass: (r) => (me && r.holder === me ? "me" : null) });
}

function dethroned(items) {
  return h("ul", { class: "feed" }, items.map((it) => h("li", { class: "feed-item" },
    h("span", { class: "feed-time", text: S().fmtRaceTime(it.time_ms) }),
    h("p", {}, link.pilot(it.taker), " took ", link.course(it.course_id, S().parseCourseName(it.course_name).title), " from ", link.pilot(it.from),
      it.margin_ms != null ? h("span", { class: "faint", text: " by " + (it.margin_ms / 1000).toFixed(3) + " s" }) : null),
    h("span", { class: "feed-when", title: S().fmtDate(it.at), text: S().timeAgo(it.at) }))));
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

/** Boards + (when on and served) history; a history failure never takes the records down. */
async function loadAll(signal) {
  const b = await allBoards(signal);
  let hist = { available: false, byHash: {} };
  if (FLAGS.RECORD_HISTORY) { try { hist = await recordHistories(signal); } catch (_) { hist = { available: false, byHash: {}, failed: true }; } }
  return { b, hist };
}

export function mount(root, route, ctx) {
  ctx.setTitle("Hall of Fame");
  const T = S().MEDAL_THRESHOLDS;
  const pct = (k) => Math.round((T[k] - 1) * 100) + " %";
  const recBlock = h("div", { class: "block" });
  const feedBlock = h("div", { class: "block" });
  const medBlock = h("div", { class: "block" });
  const recNote = h("p", { class: "section-sub" }, "Reign is how long the holder has kept it, their own improvements included.");
  root.appendChild(h("div", { class: "page" },
    h("div", { class: "page-head" }, h("div", {}, h("span", { class: "eyebrow", text: "Hall of Fame" }), h("h1", {}, "Records"),
      h("p", {}, "Every course record and who holds it. Medals: gold within " + pct("gold") + " of a course record, silver " + pct("silver") + ", bronze " + pct("bronze") + "."))),
    h("section", { class: "section", "aria-labelledby": "cr-h" }, h("div", { class: "section-head" }, h("h2", { id: "cr-h" }, "Course records"), recNote),
      h("div", { class: "panel panel-tight" }, recBlock)),
    FLAGS.RECORD_HISTORY ? h("section", { class: "section", "aria-labelledby": "dt-h" }, h("div", { class: "section-head" }, h("h2", { id: "dt-h" }, "Dethroned"),
      h("p", { class: "section-sub" }, "Every time a record changed hands, newest first.")), h("div", { class: "panel" }, feedBlock)) : null,
    h("section", { class: "section", "aria-labelledby": "mt-h" }, h("div", { class: "section-head" }, h("h2", { id: "mt-h" }, "Medal table")), h("div", { class: "panel panel-tight" }, medBlock))));
  const load = (sg) => loadAll(sg);
  const noBoards = (d) => !Object.keys(d.b.boards).length;
  const blocks = [
    dataBlock(recBlock, {
      load, isEmpty: noBoards, skeleton: "rows", skeletonCount: 6, empty: "No records yet. Every course is up for grabs.",
      render: (d) => hallOfFame(S().withHistory(S().buildRecords(d.b.boards, d.b.courses, Date.now()), d.hist.available ? d.hist.byHash : null, Date.now())),
      after: (d) => { if (FLAGS.RECORD_HISTORY && !d.hist.available) recNote.textContent = d.hist.failed ? "Record history didn't load; reigns (*) count from the record run." : "This server doesn't keep record history; reigns (*) count from the record run."; },
    }),
    dataBlock(medBlock, { load, isEmpty: noBoards, render: (d) => medalTableView(S().medalTable(d.b.boards)),
      skeleton: "rows", skeletonCount: 4, empty: "No medals handed out yet." }),
  ];
  if (FLAGS.RECORD_HISTORY) {
    blocks.push(dataBlock(feedBlock, {
      load, skeleton: "rows", skeletonCount: 3,
      isEmpty: (d) => !d.hist.available || !S().dethronedFeed(d.hist.byHash, d.b.courses, 1).length,
      empty: "No record has changed hands yet — or this server doesn't keep record history.",
      render: (d) => dethroned(S().dethronedFeed(d.hist.byHash, d.b.courses, 30)),
    }));
  }
  return () => blocks.forEach((x) => x.destroy());
}
