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
  raceReplay: () => import("./views/replay.js"),
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

// ------------------------------------------------------------------ per-page OG/twitter meta
// index.html ships the home page's tags as the default; a view whose page has its own og/{kind}
// image (course, course replay, race replay, pilot) points the tags at it with ctx.setMeta(), and
// route() resets to the default before every mount so a page that doesn't call it never keeps a
// stale one from the last page.
const DEFAULT_OG = { title: BASE_TITLE, image: "/img/og.png" };
function setMetaTag(selector, content) {
  const el = document.querySelector(selector);
  if (el) el.setAttribute("content", content);
}
function applyMeta(title, image) {
  const url = location.origin + "/#" + location.hash.replace(/^#/, "");
  setMetaTag('meta[property="og:title"]', title);
  setMetaTag('meta[property="og:url"]', url);
  setMetaTag('meta[property="og:image"]', location.origin + image);
  setMetaTag('meta[name="twitter:title"]', title);
  setMetaTag('meta[name="twitter:image"]', location.origin + image);
}
function resetMeta() { applyMeta(DEFAULT_OG.title, DEFAULT_OG.image); }
/** ctx.setMeta({title, kind, ident}) — points this page's social preview at /og/{kind}/{ident}.png
 * (see race/server/app.py's og_image()). `kind` is one of course/record/pilot/replay; an id the
 * server doesn't recognize just 404s on the image request, same as any other og image. */
function setMeta(opts) {
  const o = opts || {};
  const title = o.title ? o.title + " · " + BASE_TITLE : BASE_TITLE;
  const image = o.kind && o.ident != null ? "/og/" + o.kind + "/" + encodeURIComponent(o.ident) + ".png" : DEFAULT_OG.image;
  applyMeta(title, image);
}

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
  resetMeta();
  const ctx = { signal: ctl.signal, setTitle, setMeta, route: r };
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

/** Rebuild #nav-links from window.FinsSite.NAV, filtered to entries whose `view` is a real VIEWS
 * key — so a nav entry can never point at a view that fails to import (the bug this guards
 * against: app.js routing to a module that doesn't exist). markNav's data-nav reading is
 * unchanged; this only changes how the links are built. */
function buildNav() {
  const S = window.FinsSite;
  const nav = $("nav-links");
  clear(nav);
  for (const entry of S.NAV) {
    if (!(entry.view in VIEWS)) { console.warn("nav entry has no matching view", entry.view); continue; }
    nav.appendChild(h("a", { href: S.buildRoute(entry.view), dataset: { nav: entry.match.join(" ") } }, entry.label));
  }
}

function shell() {
  buildNav();
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
