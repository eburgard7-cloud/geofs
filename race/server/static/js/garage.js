// Shared by the Garage pages (views/garage.js, views/garageAdmin.js): where the sign-in lives, and
// how a livery's pictures are drawn.
//
// The Garage sign-in is the garage_token from a redeemed link code (POST /garage/link/redeem), kept
// in localStorage. Storage can throw (private mode, blocked site data): then it is kept in memory
// for this page only and the page says the pilot will need a new code next visit. The admin token
// is per tab (sessionStorage), with the same memory fallback.

import { h } from "./ui.js";

const S = () => window.FinsSite;
const SESSION_KEY = "fins.garage.session";
const ADMIN_KEY = "fins.garage.admin";

let memSession = null;
let memAdmin = null;
let sessionPersists = true;

/** {garage_token, pilot_id, callsign, expires_at} or null (none, unreadable, or expired). */
export function loadSession() {
  let sess = memSession;
  if (!sess) {
    try { sess = JSON.parse(localStorage.getItem(SESSION_KEY) || "null"); } catch (_) { sess = null; }
  }
  if (!S().garageSessionFresh(sess, Date.now())) return null;
  return sess;
}

/** Keep a redeemed sign-in. Returns false when it could only be kept in memory. */
export function saveSession(sess) {
  memSession = null;
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(sess));
    sessionPersists = true;
  } catch (_) {
    memSession = sess;
    sessionPersists = false;
  }
  return sessionPersists;
}

export function clearSession() {
  memSession = null;
  try { localStorage.removeItem(SESSION_KEY); } catch (_) { /* nothing stored */ }
}

/** false once a save had to fall back to memory. */
export function sessionIsPersistent() { return sessionPersists; }

export function loadAdminToken() {
  if (memAdmin) return memAdmin;
  try { return sessionStorage.getItem(ADMIN_KEY) || ""; } catch (_) { return ""; }
}
export function saveAdminToken(tok) {
  memAdmin = null;
  try { sessionStorage.setItem(ADMIN_KEY, tok); } catch (_) { memAdmin = tok; }
}
export function clearAdminToken() {
  memAdmin = null;
  try { sessionStorage.removeItem(ADMIN_KEY); } catch (_) { /* nothing stored */ }
}

/** An API failure -> one sentence. */
export function errText(e) {
  return S().garageErrorText(e && e.status, e && e.detail, e && e.timeout);
}

/** One picture with a caption; a picture that fails to load says so instead of a broken icon.
 * `lazy` defers it until it scrolls near the screen. */
export function picture(src, caption, opts) {
  const o = opts || {};
  const fig = h("figure", { class: "lv-fig" + (o.className ? " " + o.className : "") });
  if (src) {
    // The server draws a blueprint on its first request, which can take a few seconds: until the
    // picture arrives the figure holds its place and says so.
    const wait = o.waitText ? h("div", { class: "lv-missing lv-wait", text: o.waitText }) : null;
    const img = h("img", { src, alt: o.alt || caption, loading: o.lazy ? "lazy" : null, decoding: "async" });
    img.addEventListener("load", () => { if (wait) wait.remove(); }, { once: true });
    img.addEventListener("error", () => {
      if (wait) wait.remove();
      img.replaceWith(h("div", { class: "lv-missing", text: o.failText || "Couldn't load this picture." }));
    }, { once: true });
    if (wait) fig.appendChild(wait);
    fig.appendChild(img);
  } else {
    fig.appendChild(h("div", { class: "lv-missing", text: o.noneText || "No picture for this one." }));
  }
  if (caption) fig.appendChild(h("figcaption", { text: caption }));
  return fig;
}

/** A livery's blueprint (left, right and top views, one sheet) and its flat texture. The Rafale has
 * no blueprint (no geometry map on the server), so it shows the texture alone. */
export function liveryMedia(blueprintUrl, textureUrl, opts) {
  const o = opts || {};
  const pre = o.name ? o.name + ": " : "";
  return h("div", { class: "lv-media" + (o.big ? " lv-media-big" : "") + (blueprintUrl ? "" : " lv-media-flat") },
    blueprintUrl ? picture(blueprintUrl, "Blueprint: left, right and top views", {
      className: "lv-fig-bp", alt: pre + "left, right and top views",
      waitText: "Drawing the blueprint…",
      failText: "The blueprint isn't ready yet. Try again in a moment.",
    }) : null,
    picture(textureUrl, blueprintUrl ? "Flat texture" : "Flat texture (this aircraft has no blueprint)", {
      className: "lv-fig-tex", alt: pre + "flat texture", lazy: !!blueprintUrl,
      noneText: "No texture on this server.",
    }));
}
