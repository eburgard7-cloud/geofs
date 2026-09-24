// FINSONLY Racing HQ — the SPA shell. Hash routing (#/course/crater-rim): the server has no
// History fallback, and a hash route always loads "/", which is also the only
// path that carries the site's CSP. Each view is its own module, imported on first visit.

import { api } from "./api.js";
import { $, clear, h } from "./ui.js";

const VIEWS = {
  home: () => import("./views/home.js"),
  courses: () => import("./views/courses.js"),
  course: () => import("./views/course.js"),
  replay: () => import("./views/replay.js"),
  pilot: () => import("./views/pilot.js"),
  records: () => import("./views/records.js"),
  cups: () => import("./views/cups.js"),
  cup: () => import("./views/cups.js"),
  landing: () => import("./views/landing.js"),
  install: () => import("./views/install.js"),
  notfound: () => import("./views/notfound.js"),
};

const BASE_TITLE = "FINSONLY Racing HQ";
let current = null;     // {name, key, cleanup, ctl}
let seq = 0;

function setTitle(t) { document.title = t ? t + " · " + BASE_TITLE : BASE_TITLE; }

function markNav(name) {
  for (const a of document.querySelectorAll("#nav-links a[data-nav]")) {
    if (a.dataset.nav.split(" ").includes(name)) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  const nav = $("nav");
  nav.dataset.open = "false";
  $("nav-toggle").setAttribute("aria-expanded", "false");
}

async function route() {
  const S = window.FinsSite;
  const raw = location.hash;
  const r = S.parseRoute(raw);
  // A bare in-page anchor that is not one of the old one-page site's sections (#main from the
  // skip link, say) is not navigation.
  if (raw && !raw.startsWith("#/") && r.unknownAnchor) return;
  const key = r.name + "|" + (r.id || "");
  // Same view, new query: let the view handle it in place (a pasted ?t= seeks); false = remount.
  if (current && current.key === key && current.onQuery && current.onQuery(r) !== false) return;

  const my = ++seq;
  if (current) {
    try { current.ctl.abort(); if (current.cleanup) current.cleanup(); } catch (e) { console.warn("view cleanup failed", e); }
    current = null;
  }
  const homeEl = $("view-home"), viewEl = $("view");
  const isHome = r.name === "home";
  homeEl.hidden = !isHome;
  viewEl.hidden = isHome;
  if (!isHome) clear(viewEl);
  markNav(r.name);

  let mod;
  try {
    mod = await (VIEWS[r.name] || VIEWS.notfound)();
  } catch (e) {
    console.warn("view failed to load", e);
    if (my !== seq) return;
    viewEl.hidden = false; homeEl.hidden = true;
    viewEl.appendChild(h("div", { class: "page" }, h("p", { class: "state-msg error", role: "alert" },
      "This page failed to load. ", h("button", { type: "button", class: "btn-link", onClick: () => location.reload() }, "Reload"))));
    return;
  }
  if (my !== seq) return;
  const ctl = new AbortController();
  const ctx = { signal: ctl.signal, setTitle, route: r };
  let result = null;
  try {
    result = await mod.mount(isHome ? homeEl : viewEl, r, ctx);
  } catch (e) {
    console.warn("view mount failed", e);
  }
  if (my !== seq) { try { ctl.abort(); if (typeof result === "function") result(); else if (result && result.cleanup) result.cleanup(); } catch (_) {} return; }
  current = {
    name: r.name, key, ctl,
    cleanup: typeof result === "function" ? result : result && result.cleanup,
    onQuery: result && result.onQuery,
  };
  if (r.anchor) {
    const target = document.getElementById(r.anchor);
    if (target) target.scrollIntoView();
  } else if (!r.keepScroll) {
    window.scrollTo(0, 0);
  }
  // Move focus to the new page's heading so screen readers announce the navigation (not on the
  // first load, where the browser's own focus is already right).
  if (route.loaded) {
    const h1 = (isHome ? homeEl : viewEl).querySelector("h1");
    if (h1) { h1.setAttribute("tabindex", "-1"); h1.focus({ preventScroll: true }); }
  }
  route.loaded = true;
}

function shell() {
  $("nav-toggle").addEventListener("click", () => {
    const nav = $("nav");
    const open = nav.dataset.open !== "true";
    nav.dataset.open = String(open);
    $("nav-toggle").setAttribute("aria-expanded", String(open));
  });
  // The skip link targets #main; handle it here so it never counts as a route change.
  const skip = document.querySelector(".skip-link");
  if (skip) skip.addEventListener("click", (e) => { e.preventDefault(); $("main").focus(); });

  api.version().then((v) => {
    const bits = ["server " + (v.version || "?")];
    if (v.proto != null) bits.push("proto " + v.proto);
    if (v.sha && v.sha !== "unknown") bits.push(String(v.sha).slice(0, 7));
    $("footer-version").textContent = bits.join(" · ");
  }).catch(() => { $("footer-version").textContent = "Server version unavailable"; });
}

function start() {
  if (!window.FinsSite) { setTimeout(start, 10); return; }  // site.js is deferred, in order; belt and braces
  shell();
  window.addEventListener("hashchange", route);
  route();
}
start();
