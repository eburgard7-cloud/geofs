// Every call the site makes to race.finsonly.net. Same-origin GETs only; the server's JSON
// endpoints are read from race/server/app.py; each wrapper below names the one it calls.

export const TIMEOUT_MS = 8000;

export class HttpError extends Error {
  constructor(status, url) {
    super("HTTP " + status);
    this.status = status;
    this.url = url;
  }
}

/** GET a JSON document with a hard timeout. An outer AbortSignal (a view being torn down)
 * cancels it too. A timeout rejects with err.timeout = true. */
export function fetchJSON(url, opts) {
  const o = opts || {};
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, o.timeoutMs || TIMEOUT_MS);
  const onOuter = () => ctl.abort();
  if (o.signal) {
    if (o.signal.aborted) ctl.abort();
    else o.signal.addEventListener("abort", onOuter, { once: true });
  }
  return fetch(url, { headers: { Accept: "application/json" }, signal: ctl.signal, credentials: "omit" })
    .then((r) => {
      if (!r.ok) throw new HttpError(r.status, url);
      return r.json();
    })
    .catch((e) => {
      if (timedOut) { const t = new Error("timed out"); t.timeout = true; throw t; }
      throw e;
    })
    .finally(() => {
      clearTimeout(timer);
      if (o.signal) o.signal.removeEventListener("abort", onOuter);
    });
}

// ------------------------------------------------------------------ per-tab memo
// Short-lived: the site is read-mostly and a friend group's board changes a few times an evening.
const memo = new Map();
export function cached(key, ttlMs, load) {
  const hit = memo.get(key);
  const now = Date.now();
  if (hit && now - hit.at < ttlMs) return hit.promise;
  const promise = load().catch((e) => { memo.delete(key); throw e; });
  memo.set(key, { at: now, promise });
  return promise;
}
export function invalidate(prefix) {
  for (const k of [...memo.keys()]) if (!prefix || k.startsWith(prefix)) memo.delete(k);
}

// ------------------------------------------------------------------ /stats + /rooms/live spacing
// The server gates these two endpoints together at one request per second per IP (app.py
// _get_rate_limit), so back-to-back calls 429. Every call to either goes through this queue,
// which keeps them GATE_SPACING_MS apart. A 429 that still slips through (another tab) is
// retried once after the spacing.
const GATE_SPACING_MS = 1200;
let gateChain = Promise.resolve();
let gateLast = 0;
function gated(url, opts) {
  const run = async () => {
    const wait = Math.max(0, gateLast + GATE_SPACING_MS - Date.now());
    if (wait) await new Promise((r) => setTimeout(r, wait));
    gateLast = Date.now();
    try {
      return await fetchJSON(url, opts);
    } catch (e) {
      if (e.status !== 429) throw e;
      await new Promise((r) => setTimeout(r, GATE_SPACING_MS));
      gateLast = Date.now();
      return fetchJSON(url, opts);
    }
  };
  const p = gateChain.then(run, run);
  gateChain = p.catch(() => {});
  return p;
}

const q = encodeURIComponent;

export const api = {
  version: (o) => cached("version", 60000, () => fetchJSON("/version", o)),
  stats: (o) => gated("/stats", o),
  roomsLive: (o) => gated("/rooms/live", o),
  courses: (o) => cached("courses", 60000, () => fetchJSON("/courses", o)),
  catalog: (o) => cached("catalog", 300000, () => fetchJSON("/courses/catalog", o)),
  leaderboard: (hash, limit, o) => cached("lb:" + hash + ":" + (limit || 10), 60000,
    () => fetchJSON("/leaderboard?course_hash=" + q(hash) + "&limit=" + (limit || 10), o)),
  ghosts: (hash, o) => cached("ghosts:" + hash, 60000, () => fetchJSON("/ghosts?course_hash=" + q(hash), o)),
  ghost: (hash, callsign, o) => cached("ghost:" + hash + ":" + (callsign || ""), 300000,
    () => fetchJSON("/ghost?course_hash=" + q(hash) + (callsign ? "&callsign=" + q(callsign) : ""), o)),
  racesRecent: (limit, o) => cached("recent:" + limit, 60000, () => fetchJSON("/races/recent?limit=" + limit, o)),
  // A finished lobby race with every racer's decoded trace; the heaviest GET the site makes, so it
  // is only ever fetched for one race the viewer asked about.
  raceReplay: (id, o) => cached("race:" + id, 300000, () => fetchJSON("/races/" + q(id) + "/replay", o)),
  cups: (params, o) => {
    const p = params || {};
    const qs = ["limit=" + (p.limit || 20)].concat(p.open ? ["open=1"] : []).join("&");
    return cached("cups:" + qs, 60000, () => fetchJSON("/cups?" + qs, o));
  },
  cup: (id, o) => cached("cup:" + id, 60000, () => fetchJSON("/cups/" + q(id), o)),
  modes: (o) => cached("modes", 300000, () => fetchJSON("/modes", o)),
  modeBoard: (mode, hash, limit, o) => cached("mb:" + mode + ":" + hash, 60000,
    () => fetchJSON("/modes/" + q(mode) + "/leaderboard?course_hash=" + q(hash) + "&limit=" + (limit || 25), o)),
  landingBoard: (runwayId, limit, o) => cached("landing:" + runwayId, 60000,
    () => fetchJSON("/landing-leaderboard?runway_id=" + q(runwayId) + "&limit=" + (limit || 25), o)),
  runways: (o) => cached("runways", 300000, () => fetchJSON("/runways", o)),
  bookmarklet: (o) => cached("bookmarklet", 300000, () => fetchJSON("/bookmarklet", o)),
};

// ------------------------------------------------------------------ what the page's CSP allows
// The site's own policy arrives as a response header on "/", which a same-origin HEAD can read.
// Before any third-party request (tiles, models) the caller asks allowed(); a host the policy
// rules out is skipped silently instead of logging a CSP violation for every attempt.
let cspPromise = null;
export function pageCsp() {
  if (!cspPromise) {
    cspPromise = fetch("/", { method: "HEAD", credentials: "omit", cache: "no-store" })
      .then((r) => r.headers.get("content-security-policy") || "")
      .catch(() => "");
  }
  return cspPromise;
}
export async function allowed(directive, url) {
  return window.FinsSite.cspAllows(await pageCsp(), directive, url, location.origin);
}
