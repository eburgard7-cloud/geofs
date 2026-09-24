// /landing — landing-mode boards per runway (GET /runways, GET /landing-leaderboard, GET /modes).
// The runway list comes from GET /runways; a server without it (it arrived after 1.5.0) falls back
// to the config.RUNWAYS snapshot, and any id that server doesn't know 404s and is dropped.

import { api } from "../api.js";
import { RUNWAYS } from "../config.js";
import { h, clear, dataBlock, link, sortableTable, getMe } from "../ui.js";

const S = () => window.FinsSite;
const KEY = "fins.hq.runway";

async function runwayList(signal) {
  try {
    const list = await api.runways({ signal });
    if (Array.isArray(list) && list.length) return list.filter((r) => r && r.id).map((r) => ({ id: r.id, name: r.name || r.id }));
  } catch (_) { /* older server: no GET /runways */ }
  return RUNWAYS;
}

async function overview(signal) {
  const runways = await runwayList(signal);
  const out = [];
  let i = 0;
  const worker = async () => {
    while (i < runways.length) {
      const rw = runways[i++];
      try {
        const b = await api.landingBoard(rw.id, 25, { signal });
        out.push({ ...rw, rows: b.rows || [] });
      } catch (e) {
        if (e.status !== 404) out.push({ ...rw, rows: null });   // 404 = runway not on this server
      }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return out.sort((a, b) => ((b.rows || []).length - (a.rows || []).length) || a.name.localeCompare(b.name));
}

function board(rw, direction) {
  const me = getMe();
  return sortableTable([
    { key: "rank", label: "#", num: true, cell: (r) => h("span", { class: "rank", text: String(r.rank) }) },
    { key: "callsign", label: "Pilot", sort: (a, b) => a.callsign.localeCompare(b.callsign), defaultAsc: true, cell: (r) => link.pilot(r.callsign) },
    { key: "metric_value", label: "Score", num: true, defaultAsc: direction === "asc", cell: (r) => h("strong", { class: "t", text: Number(r.metric_value).toFixed(0) }) },
    { key: "attempts", label: "Tries", num: true },
    { key: "created_at", label: "Set", cell: (r) => h("span", { class: "faint", text: S().timeAgo(r.created_at) }) },
  ], rw.rows, { sortKey: "rank", asc: true, caption: rw.name + " landings", rowClass: (r) => (me && r.callsign === me ? "me" : null) });
}

export function mount(root, route, ctx) {
  ctx.setTitle("Landing");
  const picker = h("div", { class: "runway-picker" });
  const boardBox = h("div", { class: "panel panel-tight" });
  const summary = h("div", { class: "block" });
  root.appendChild(h("div", { class: "page" },
    h("div", { class: "page-head" }, h("div", {}, h("span", { class: "eyebrow", text: "Landing mode" }), h("h1", {}, "Landing leaderboard"),
      h("p", {}, "Scored by the server from your touchdown: sink rate, centreline, where on the runway, bounces. Higher is better."))),
    summary,
    h("section", { class: "section", "aria-labelledby": "rb-h" }, h("div", { class: "section-head" }, h("h2", { id: "rb-h" }, "Runway board")), picker, boardBox)));
  let direction = "desc";
  api.modes({ signal: ctx.signal }).then((ms) => { const m = (ms || []).find((x) => x.id === "landing"); if (m) direction = m.direction; }).catch(() => {});

  const blk = dataBlock(summary, {
    load: (sg) => overview(sg),
    isEmpty: (list) => !list.length,
    unavailable: "This server has no landing mode yet.",
    empty: "This server doesn't know any of these runways.",
    skeleton: "rows", skeletonCount: 3,
    render: (list) => {
      const withRows = list.filter((r) => r.rows && r.rows.length);
      let current = null;
      try { current = sessionStorage.getItem(KEY); } catch (_) { /* ignore */ }
      if (!list.some((r) => r.id === current)) current = (withRows[0] || list[0]).id;
      const sel = h("select", { "aria-label": "Runway" }, list.map((r) => h("option", { value: r.id, selected: r.id === current },
        r.name + (r.rows ? (r.rows.length ? " — " + r.rows.length + " pilot" + (r.rows.length === 1 ? "" : "s") : "") : " — unavailable"))));
      const show = (id) => {
        try { sessionStorage.setItem(KEY, id); } catch (_) { /* ignore */ }
        const rw = list.find((r) => r.id === id);
        clear(boardBox).append(!rw.rows ? h("p", { class: "state-msg error" }, "Couldn't load this runway's board.")
          : rw.rows.length ? board(rw, direction) : h("p", { class: "state-msg empty" }, "No landings on " + rw.name + " yet. Grease one in."));
      };
      sel.addEventListener("change", () => show(sel.value));
      clear(picker).append(sel);
      show(current);
      if (!withRows.length) return h("p", { class: "state-msg empty" }, "Nobody has landed for score yet. Every runway is wide open.");
      return h("div", {}, h("h2", { class: "visually-hidden" }, "Best landing per runway"), h("ul", { class: "grid grid-cards" }, withRows.map((r) => h("li", { class: "room-card" },
        h("div", { class: "room-card-head" }, h("button", { type: "button", class: "btn-link", onClick: () => { sel.value = r.id; show(r.id); } }, r.name)),
        h("p", { class: "room-pilots" }, "Best: ", link.pilot(r.rows[0].callsign), " · ", h("strong", { class: "t", text: Number(r.rows[0].metric_value).toFixed(0) }), " pts")))));
    },
  });
  return () => blk.destroy();
}
