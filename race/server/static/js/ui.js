// DOM helpers. The whole site builds its DOM through h()/s() below, which only ever set
// textContent and attributes — callsigns and course names are client-supplied, so nothing is
// ever parsed as HTML. No HTML-parsing DOM sink is used anywhere in the site, by design.

const S = () => window.FinsSite;
const SVG_NS = "http://www.w3.org/2000/svg";

function apply(el, attrs) {
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.setAttribute("class", v);
    else if (k === "text") el.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k === "style") throw new Error("inline style attributes are blocked by the CSP; use a class or el.style");
    else el.setAttribute(k, v === true ? "" : String(v));
  }
}
function append(el, kids) {
  for (const c of kids.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

/** h("a", {href, class, text, onClick}, ...children) */
export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  apply(el, attrs);
  append(el, kids);
  return el;
}
/** s("path", {d, class}, ...children) — SVG namespace. */
export function s(tag, attrs, ...kids) {
  const el = document.createElementNS(SVG_NS, tag);
  apply(el, attrs);
  append(el, kids);
  return el;
}
export function clear(el) { while (el && el.firstChild) el.removeChild(el.firstChild); return el; }
export function $(id) { return document.getElementById(id); }

// ------------------------------------------------------------------ links + small pieces
export const link = {
  pilot: (cs) => h("a", { class: "pilot-link", href: S().buildRoute("pilot", cs), text: cs }),
  course: (id, name) => (id ? h("a", { class: "course-link", href: S().buildRoute("course", id), text: name }) : h("span", { text: name })),
};

const MEDAL_LABEL = { gold: "Gold", silver: "Silver", bronze: "Bronze" };
export function medal(m, big) {
  const cls = "medal medal-" + (m || "none") + (big ? " medal-lg" : "");
  return h("span", { class: cls, role: "img", "aria-label": m ? MEDAL_LABEL[m] + " medal" : "No medal", title: m ? MEDAL_LABEL[m] : "No medal" },
    m ? m[0].toUpperCase() : "");
}

export function chip(text, kind) { return h("span", { class: "chip" + (kind ? " chip-" + kind : ""), text }); }

export function courseChips(c) {
  const out = [];
  const p = S().parseCourseName(c.course_name);
  if (c.difficulty) out.push(chip(c.difficulty, c.difficulty));
  const cls = S().courseClass(c.cup, c.course_id);
  if (cls !== "race") out.push(chip(cls, cls));
  if (p.laps > 1) out.push(chip(p.laps + " laps"));
  if (c.start_type) out.push(chip(c.start_type === "air" ? "air start" : "ground start"));
  return out;
}

export function toast(text) {
  const t = h("div", { class: "toast", role: "status", text });
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2200);
}

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch (_) { /* fall through */ }
  const ta = h("textarea", { class: "visually-hidden", "aria-hidden": "true" });
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch (_) { ok = false; }
  ta.remove();
  return ok;
}

// ------------------------------------------------------------------ skeletons
export function skeleton(kind, n) {
  const count = n || 3;
  if (kind === "cards") return h("div", { class: "skel-grid", "aria-hidden": "true" }, Array.from({ length: count }, () => h("div", { class: "skel skel-card" })));
  if (kind === "rows") return h("div", { "aria-hidden": "true" }, Array.from({ length: count }, () => h("div", { class: "skel skel-row" })));
  if (kind === "tall") return h("div", { class: "skel skel-tall", "aria-hidden": "true" });
  return h("div", { "aria-hidden": "true" }, h("div", { class: "skel skel-line" }), h("div", { class: "skel skel-line" }));
}

// ------------------------------------------------------------------ data blocks
/** A block that loads data and renders exactly one of: skeleton -> content | empty | error (with
 * Retry) | unavailable (the endpoint does not exist on this server: one note, no retry spam).
 * `load(signal)` returns the data; `render(data)` returns a Node; `isEmpty(data)` decides empty.
 * `notFoundIsEmpty` makes a 404 mean "no data" (e.g. /ghost), otherwise 404 = "unavailable". */
export function dataBlock(container, o) {
  let ctl = null;
  let alive = true;
  const setState = (node) => { clear(container); if (node) container.appendChild(node); };
  const run = async (quiet) => {
    if (!alive) return;
    if (ctl) ctl.abort();
    ctl = new AbortController();
    const my = ctl;
    if (!quiet) { container.setAttribute("aria-busy", "true"); setState(skeleton(o.skeleton, o.skeletonCount)); }
    try {
      const data = await o.load(my.signal);
      if (!alive || my.signal.aborted) return;
      if (o.isEmpty ? o.isEmpty(data) : (Array.isArray(data) ? !data.length : data == null)) {
        setState(h("p", { class: "state-msg empty" }, o.empty || "Nothing here yet."));
      } else {
        setState(o.render(data));
      }
      if (o.after) o.after(data);
    } catch (e) {
      if (!alive || my.signal.aborted) return;
      if (e && e.status === 404 && o.notFoundIsEmpty) {
        setState(h("p", { class: "state-msg empty" }, o.empty || "Nothing here yet."));
      } else if (e && e.status === 404) {
        setState(h("p", { class: "state-msg unavailable" }, o.unavailable || "This server doesn't have that feature yet."));
      } else if (quiet) {
        // A background refresh failing keeps the last good content on screen.
      } else {
        const why = e && e.timeout ? "The server took too long to answer." : "Couldn't reach the server.";
        setState(h("p", { class: "state-msg error", role: "alert" }, (o.error || why) + " ",
          h("button", { type: "button", class: "btn-link", onClick: () => run(false) }, "Try again")));
      }
      if (o.onError) o.onError(e);
    } finally {
      if (alive) container.removeAttribute("aria-busy");
    }
  };
  run(false);
  return {
    reload: (quiet) => run(!!quiet),
    destroy: () => { alive = false; if (ctl) ctl.abort(); },
  };
}

// ------------------------------------------------------------------ sortable table
/** columns: [{key, label, num, sort: (a,b)=>n | false, cell: (row)=>Node|string, className}]
 * Clicking a header re-sorts; aria-sort is kept in step. rowClass(row) optional. */
export function sortableTable(columns, rows, opts) {
  const o = opts || {};
  let sortKey = o.sortKey || null, asc = !!o.asc;
  const table = h("table", { class: "data" + (o.className ? " " + o.className : "") });
  if (o.caption) table.appendChild(h("caption", { class: "visually-hidden", text: o.caption }));
  const thead = h("thead");
  const tbody = h("tbody");
  const trh = h("tr");
  const ths = columns.map((c) => {
    const th = h("th", { scope: "col", class: c.num ? "num" : null });
    if (c.sort === false) th.textContent = c.label;
    else th.appendChild(h("button", { type: "button", onClick: () => { if (sortKey === c.key) asc = !asc; else { sortKey = c.key; asc = !!c.defaultAsc; } draw(); } }, c.label));
    trh.appendChild(th);
    return th;
  });
  thead.appendChild(trh);
  table.append(thead, tbody);
  function draw() {
    const col = columns.find((c) => c.key === sortKey);
    const list = rows.slice();
    if (col && col.sort !== false) {
      const cmp = col.sort || ((a, b) => (a[col.key] > b[col.key] ? 1 : a[col.key] < b[col.key] ? -1 : 0));
      list.sort((a, b) => (asc ? cmp(a, b) : -cmp(a, b)));
    }
    columns.forEach((c, i) => {
      if (c.sort === false) return;
      if (c.key === sortKey) ths[i].setAttribute("aria-sort", asc ? "ascending" : "descending");
      else ths[i].removeAttribute("aria-sort");
    });
    clear(tbody);
    list.forEach((r, idx) => {
      const tr = h("tr", { class: o.rowClass ? o.rowClass(r) : null });
      for (const c of columns) {
        const v = c.cell ? c.cell(r, idx) : r[c.key];
        tr.appendChild(h("td", { class: [c.num ? "num" : "", c.className || ""].join(" ").trim() || null }, v == null ? "—" : v));
      }
      tbody.appendChild(tr);
    });
  }
  draw();
  return h("div", { class: "table-wrap" }, table);
}

// ------------------------------------------------------------------ route mini-map (SVG)
/** A course's gates as a small SVG route: gradient-glow line, numbered gate dots when there's
 * room, green start, checkered finish. `opts.labels` numbers every gate. */
export function routeSvg(gates, w, h_, opts) {
  const o = opts || {};
  const mm = S().routeMiniMap(gates, w, h_, o.pad == null ? 16 : o.pad);
  const svg = s("svg", { viewBox: "0 0 " + w + " " + h_, class: o.className || "map", role: "img", "aria-label": o.label || "Route map" });
  if (!mm.points.length) return svg;
  svg.appendChild(s("path", { d: mm.d, class: "map-glow" }));
  svg.appendChild(s("path", { d: mm.d, class: "map-route" }));
  const r = o.gateR || 3.2;
  mm.points.forEach((p, i) => {
    if (i === 0 || (i === mm.points.length - 1)) return;
    svg.appendChild(s("circle", { cx: p.x, cy: p.y, r, class: "map-gate" }));
    if (o.labels) svg.appendChild(s("text", { x: p.x + r + 2, y: p.y - r - 1, class: "map-label", text: String(i + 1) }));
  });
  svg.appendChild(s("circle", { cx: mm.start.x, cy: mm.start.y, r: r + 2, class: "map-start" }));
  if (!mm.closed) svg.appendChild(s("rect", { x: mm.finish.x - r - 2, y: mm.finish.y - r - 2, width: 2 * r + 4, height: 2 * r + 4, class: "map-finish" }));
  return svg;
}

// ------------------------------------------------------------------ "that's me" (per-browser)
const ME_KEY = "fins.hq.me";
export function getMe() { try { return localStorage.getItem(ME_KEY) || ""; } catch (_) { return ""; } }
export function setMe(cs) {
  try { if (cs) localStorage.setItem(ME_KEY, cs); else localStorage.removeItem(ME_KEY); } catch (_) { /* private mode */ }
  window.dispatchEvent(new CustomEvent("fins:me", { detail: cs || "" }));
}

export function reducedMotion() {
  return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
}
export function saveData() {
  return !!(navigator.connection && navigator.connection.saveData);
}
