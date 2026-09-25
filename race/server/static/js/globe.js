// The only module that touches Cesium. Loaded lazily (dynamic import) by the pages that show a
// globe; Cesium itself (vendor/cesium, ~6 MB) is injected on first use, never on first paint.
//
// Contract, same as race.js's makeGateLayer family: every factory is wrapped in try/catch, carries
// an `ok` flag and a `clear()`/`destroy()`, fails closed with one console.warn, and never throws
// into a render loop. Every caller keeps its 2D SVG underneath, so a globe that can't start
// (no WebGL, script blocked) just never covers it.
//
// No Cesium ion: no ion token, no geocoder, no base-layer picker. Terrain is Terrarium PNG over
// CustomHeightmapTerrainProvider; imagery is TILE_SOURCES (js/config.js). When the tile hosts are
// blocked (today's CSP, or a network that blocks them) createGlobe() rejects with err.blocked
// before Cesium is loaded and the page keeps its 2D map; blocked terrain alone gives a flat,
// labelled globe.

import { TILE_SOURCES, CESIUM_VERSION, GOOGLE_3D_TILES, GOOGLE_MAPS_KEY, MODEL_BASE, FALLBACK_MODEL } from "./config.js";
import { h, clear } from "./ui.js";
import { allowed } from "./api.js";

const S = () => window.FinsSite;
const BASE = new URL("../vendor/cesium/", import.meta.url).href;
const PLUM = "#1d1029";

// ================================================================== loading
let cesiumPromise = null;
export function loadCesium() {
  if (window.Cesium) return Promise.resolve(window.Cesium);
  if (cesiumPromise) return cesiumPromise;
  cesiumPromise = new Promise((resolve, reject) => {
    window.CESIUM_BASE_URL = BASE;
    // The IIFE build embeds every worker as a string (globalThis.CESIUM_WORKERS) and starts them
    // from blob: URLs, which the CSP (rightly) refuses. With that global pinned to undefined,
    // Cesium's TaskProcessor falls back to its same-origin module workers in vendor/cesium/Workers/,
    // which script-src 'self' allows. The setter swallows the bundle's own assignment.
    if (!Object.getOwnPropertyDescriptor(globalThis, "CESIUM_WORKERS")) {
      Object.defineProperty(globalThis, "CESIUM_WORKERS", { get: () => undefined, set: () => {}, configurable: false });
    }
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = BASE + "Widgets/widgets.css";
    document.head.appendChild(css);
    const sc = document.createElement("script");
    sc.src = BASE + "Cesium.js";
    sc.async = true;
    const timer = setTimeout(() => reject(new Error("Cesium load timed out")), 30000);
    sc.onload = () => { clearTimeout(timer); window.Cesium ? resolve(window.Cesium) : reject(new Error("Cesium missing after load")); };
    sc.onerror = () => { clearTimeout(timer); reject(new Error("Cesium failed to load")); };
    document.head.appendChild(sc);
  });
  cesiumPromise.catch(() => { cesiumPromise = null; });
  return cesiumPromise;
}

function webglOk() {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch (_) { return false; }
}

// ------------------------------------------------------------------ probing the tile hosts
// One tiny fetch per source. A SUCCESS is cached for the life of the tab -- fetch() is what Cesium
// uses too (connect-src), so this answers exactly "will Cesium be allowed to load these?" and that
// answer won't change mid-tab. A FAILURE is cached for only PROBE_FAILURE_TTL_MS (site.js
// probeCacheValid/PROBE_FAILURE_TTL_MS): the tile host, or this site's own tile proxy, can come
// back from a transient outage while the tab is still open, and hash routing never reloads the
// page to clear a stale memo -- without the expiry, one bad response at page load left every globe
// in the session stuck on the 2D fallback until a full reload.
//
// A 429 is NOT unreachability -- it's the server's own token bucket (app.py _tile_rate_limit)
// saying "reachable, but slow down", which the concurrent terrain+imagery+labels probe on every
// globe load can trip even with plenty of burst budget. Treating a 429 as "blocked" was what sent
// the page to its 2D fallback under completely normal conditions. Only a real network failure
// (fetch rejects), the page's own CSP ruling the URL out, or a non-429 non-ok response count as
// blocked here.
const probeCache = new Map();   // url -> { p: Promise<bool>, ok: true|false|null, ts: number }
// Why the most recent probe() call for a URL failed ("csp" | "network" | "http-NNN"), for the
// fallback note (see buildFallbackNote below) and the ?debug=1 inline detail. probeReasons is only
// ever read for a URL whose probe just resolved false, so a stale entry from a since-succeeded
// probe is never shown.
const probeReasons = new Map();
function fetchOnce(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 6000);
  return fetch(url, { mode: "cors", credentials: "omit", signal: ctl.signal }).finally(() => clearTimeout(t));
}
function probeOnce(url) {
  return allowed("connect-src", url).then((ok) => {
    if (!ok) { probeReasons.set(url, "csp"); return false; }   // the page's own CSP rules it out
    return fetchOnce(url)
      .then((r) => {
        if (r.status !== 429) {
          if (!r.ok) probeReasons.set(url, "http-" + r.status);
          return r.ok;
        }
        // Rate limited, not blocked: the response itself proves the host is reachable. Retry
        // once after a beat in case the bucket has already refilled, but either way this probe
        // reports reachable -- a second 429 is still not "unreachable".
        return new Promise((resolve) => setTimeout(resolve, 300))
          .then(() => fetchOnce(url).catch(() => null))
          .then(() => true);
      })
      .catch(() => { probeReasons.set(url, "network"); return false; });
  });
}
/** `force`: skip the cache (fresh, success or failure) entirely -- for a visitor-initiated Retry,
 * which must not sit behind PROBE_FAILURE_TTL_MS just because they clicked within 15 s of the
 * failure. Still shares one in-flight fetch per URL (a forced probe replaces the cache entry other
 * concurrent callers read, same as any other probe) rather than racing two fetches of the same URL. */
function probe(url, force) {
  const cached = probeCache.get(url);
  if (!force && cached && S().probeCacheValid(cached.ok, cached.ts, Date.now(), S().PROBE_FAILURE_TTL_MS)) return cached.p;
  const entry = { p: null, ok: null, ts: Date.now() };
  entry.p = probeOnce(url).then((ok) => { entry.ok = ok; entry.ts = Date.now(); return ok; });
  probeCache.set(url, entry);
  return entry.p;
}
const tileAt0 = (tpl) => tpl.replace("{z}", "0").replace("{x}", "0").replace("{y}", "0");
/** ?debug=1: show the fallback REASON alongside the "showing the 2D view" note (see createGlobe's
 * e.reason) instead of a silent fallback that gives no clue why. This is a hash-routed SPA
 * ("#/course/gorge-run?debug=1"), so the flag rides in location.hash's own query string, never
 * location.search (which is only ever "" here -- there is no real query string before the #). */
export const DEBUG = () => {
  try {
    const h = location.hash || "";
    const qi = h.indexOf("?");
    return qi >= 0 && new URLSearchParams(h.slice(qi + 1)).get("debug") === "1";
  } catch (_) { return false; }
};

// ================================================================== terrain (Terrarium)
const TERRAIN_N = 65;
const tileCache = new Map();           // "z/x/y" -> Promise<Uint8ClampedArray|null>
const TILE_CACHE_MAX = 300;

function terrariumPixels(z, x, y) {
  const key = z + "/" + x + "/" + y;
  if (tileCache.has(key)) {
    const p = tileCache.get(key);
    tileCache.delete(key); tileCache.set(key, p);    // LRU touch
    return p;
  }
  const url = TILE_SOURCES.terrain.url.replace("{z}", z).replace("{x}", x).replace("{y}", y);
  const p = fetch(url, { mode: "cors", credentials: "omit" })
    .then((r) => (r.ok ? r.blob() : null))
    .then((b) => (b ? createImageBitmap(b) : null))
    .then((bmp) => {
      if (!bmp) return null;
      const c = new OffscreenCanvas(256, 256);
      const g = c.getContext("2d", { willReadFrequently: true });
      g.drawImage(bmp, 0, 0);
      return g.getImageData(0, 0, 256, 256).data;
    })
    .catch(() => null);
  tileCache.set(key, p);
  if (tileCache.size > TILE_CACHE_MAX) tileCache.delete(tileCache.keys().next().value);
  return p;
}

function makeTerrain(C) {
  const maxZ = TILE_SOURCES.terrain.maxZoom;
  return new C.CustomHeightmapTerrainProvider({
    width: TERRAIN_N, height: TERRAIN_N,
    tilingScheme: new C.WebMercatorTilingScheme(),
    credit: TILE_SOURCES.terrain.credit,
    callback: (x, y, level) => {
      // Terrarium z == Cesium's Web Mercator level. Past maxZ, sample the maxZ parent's sub-window.
      const z = Math.min(level, maxZ);
      const scale = 2 ** (level - z);
      const sx = Math.floor(x / scale), sy = Math.floor(y / scale);
      const ox = (x - sx * scale) / scale, oy = (y - sy * scale) / scale;
      return terrariumPixels(z, sx, sy).then((px) => {
        const out = new Float32Array(TERRAIN_N * TERRAIN_N);
        if (!px) return out;
        for (let j = 0; j < TERRAIN_N; j++) {
          const fy = Math.min(255, (oy + j / (TERRAIN_N - 1) / scale) * 256);
          const y0 = Math.min(255, Math.floor(fy)), y1 = Math.min(255, y0 + 1), ty = fy - y0;
          for (let i = 0; i < TERRAIN_N; i++) {
            const fx = Math.min(255, (ox + i / (TERRAIN_N - 1) / scale) * 256);
            const x0 = Math.min(255, Math.floor(fx)), x1 = Math.min(255, x0 + 1), tx = fx - x0;
            const hAt = (xx, yy) => { const k = (yy * 256 + xx) * 4; return px[k] * 256 + px[k + 1] + px[k + 2] / 256 - 32768; };
            const top = hAt(x0, y0) * (1 - tx) + hAt(x1, y0) * tx;
            const bot = hAt(x0, y1) * (1 - tx) + hAt(x1, y1) * tx;
            out[j * TERRAIN_N + i] = Math.max(-500, top * (1 - ty) + bot * ty);
          }
        }
        return out;
      });
    },
  });
}

// ================================================================== the viewer
/** Build a themed viewer in `host`. Resolves {C, viewer, credits, degraded, destroy}. */
export async function createGlobe(host, opts) {
  const o = opts || {};
  if (!webglOk()) { const e = new Error("WebGL unavailable"); e.code = "webgl"; throw e; }
  // Terrain and the first imagery source are probed together; a fallback source is probed only
  // if the one before it failed, so a dead fallback host never delays a working first choice.
  // All of this happens before Cesium (6 MB) is even requested: with no imagery at all a globe
  // would be a featureless plane, worse than the SVG route under it, so the caller keeps the SVG.
  const terrainUrl = tileAt0(TILE_SOURCES.terrain.url);
  const terrainP = probe(terrainUrl, o.force);
  let imagery = null, imageryUrl = null;
  for (const src of TILE_SOURCES.imagery) {
    imageryUrl = tileAt0(src.url);
    if (await probe(imageryUrl, o.force)) { imagery = src; break; }
  }
  const terrainOk = await terrainP;
  if (!imagery) {
    const e = new Error("tile hosts blocked");
    e.blocked = true;
    e.reasonCode = probeReasons.get(imageryUrl) || "unknown";
    // ?debug=1 only: which probe failed and why (see probeReasons in the probing section above).
    e.reason = "imagery probe: " + e.reasonCode;
    throw e;
  }
  const C = await loadCesium();
  const labelsOk = TILE_SOURCES.labels ? await probe(tileAt0(TILE_SOURCES.labels.url), o.force) : false;

  // CesiumWidget, not Viewer: Viewer's widgets bind through knockout, which compiles bindings
  // with `new Function` and would need 'unsafe-eval' in the CSP. Since 1.121 CesiumWidget carries
  // entities, clock and camera itself, which is all this site uses.
  const creditBox = document.createElement("div");
  const viewer = new C.CesiumWidget(host, {
    baseLayer: false,
    terrainProvider: terrainOk ? makeTerrain(C) : new C.EllipsoidTerrainProvider(),
    requestRenderMode: true, maximumRenderTimeChange: Infinity,
    shadows: false, scene3DOnly: true, msaaSamples: 4, creditContainer: creditBox,
  });
  const scene = viewer.scene;
  scene.backgroundColor = C.Color.fromCssColorString(PLUM);
  scene.globe.baseColor = C.Color.fromCssColorString("#2c1a3d");
  scene.globe.maximumScreenSpaceError = o.sse || 2;
  scene.globe.depthTestAgainstTerrain = true;
  scene.globe.enableLighting = false;
  scene.globe.showGroundAtmosphere = true;
  scene.fog.enabled = true;
  scene.fog.density = 1.2e-4;
  if (scene.skyAtmosphere) { scene.skyAtmosphere.hueShift = -0.04; scene.skyAtmosphere.saturationShift = 0.1; }

  const credits = [];
  viewer.imageryLayers.addImageryProvider(new C.UrlTemplateImageryProvider({ url: imagery.url, maximumLevel: imagery.maxZoom, credit: imagery.credit }));
  credits.push(imagery.credit);
  if (labelsOk && o.labels !== false) {
    const lab = viewer.imageryLayers.addImageryProvider(new C.UrlTemplateImageryProvider({ url: TILE_SOURCES.labels.url, maximumLevel: TILE_SOURCES.labels.maxZoom, credit: TILE_SOURCES.labels.credit }));
    lab.alpha = 0.9;
    credits.push(TILE_SOURCES.labels.credit);
  }
  if (terrainOk) credits.push(TILE_SOURCES.terrain.credit);
  credits.push("CesiumJS " + CESIUM_VERSION);

  if (GOOGLE_3D_TILES && GOOGLE_MAPS_KEY && C.createGooglePhotorealistic3DTileset) {
    try {
      const ts = await C.createGooglePhotorealistic3DTileset({ key: GOOGLE_MAPS_KEY });
      scene.primitives.add(ts);
      scene.globe.show = false;
      credits.unshift("Google Photorealistic 3D Tiles");
    } catch (e) { console.warn("Google 3D tiles unavailable", e); }
  }

  const degraded = !terrainOk;
  let dead = false;
  return {
    C, viewer, credits, degraded,
    note: degraded ? "Terrain tiles are blocked here — the ground is flat." : "",
    destroy() { if (dead) return; dead = true; try { viewer.destroy(); } catch (_) { /* already gone */ } },
    get dead() { return dead; },
  };
}

// ================================================================== course layer
/** Numbered gate rings (plane perpendicular to the route), a green start ring, a black/white
 * finish ring, the route line and gate-number labels. */
export function makeCourseLayer(g, course, opts) {
  const layer = { ok: false, entities: [], clear() {}, positions: [] };
  try {
    const { C, viewer } = g;
    const o = opts || {};
    const gates = course.gate_coords || [];
    const pos = gates.map((q) => C.Cartesian3.fromDegrees(q.lon, q.lat, q.alt || 0));
    layer.positions = pos;
    const closed = S().routeMiniMap(gates, 10, 10, 0).closed;
    const n = gates.length;
    const add = (e) => { const ent = viewer.entities.add(e); layer.entities.push(ent); return ent; };
    add({ polyline: { positions: pos, width: 6, material: new C.PolylineOutlineMaterialProperty({ color: C.Color.fromCssColorString("#ff8a3d"), outlineColor: C.Color.fromCssColorString("#ff3d8b").withAlpha(0.6), outlineWidth: 2 }), arcType: C.ArcType.NONE } });
    const lbl = (text, fill) => ({ text, font: "700 15px Saira, Arial, sans-serif", fillColor: fill, outlineColor: C.Color.fromCssColorString(PLUM), outlineWidth: 4,
      style: C.LabelStyle.FILL_AND_OUTLINE, verticalOrigin: C.VerticalOrigin.BOTTOM, pixelOffset: new C.Cartesian2(0, -6),
      disableDepthTestDistance: Number.POSITIVE_INFINITY, distanceDisplayCondition: new C.DistanceDisplayCondition(0, o.labelRange || 60000) });
    gates.forEach((q, i) => {
      if (closed && i === n - 1) return;            // the circuit's finish is its start ring
      const r = q.radius || 100;
      // Ring plane: perpendicular to the direction of travel through this gate.
      const prev = pos[Math.max(0, i - 1)], next = pos[Math.min(n - 1, i + 1)];
      const dir = C.Cartesian3.normalize(C.Cartesian3.subtract(next, prev, new C.Cartesian3()), new C.Cartesian3());
      const up = C.Cartesian3.normalize(pos[i], new C.Cartesian3());
      const side = C.Cartesian3.normalize(C.Cartesian3.cross(dir, up, new C.Cartesian3()), new C.Cartesian3());
      const vert = C.Cartesian3.normalize(C.Cartesian3.cross(side, dir, new C.Cartesian3()), new C.Cartesian3());
      const ring = [];
      for (let k = 0; k <= 48; k++) {
        const a = (k / 48) * Math.PI * 2;
        const off = C.Cartesian3.add(C.Cartesian3.multiplyByScalar(side, Math.cos(a) * r, new C.Cartesian3()), C.Cartesian3.multiplyByScalar(vert, Math.sin(a) * r, new C.Cartesian3()), new C.Cartesian3());
        ring.push(C.Cartesian3.add(pos[i], off, new C.Cartesian3()));
      }
      const isStart = i === 0, isFinish = i === n - 1;
      const material = isFinish
        ? new C.PolylineDashMaterialProperty({ color: C.Color.WHITE, gapColor: C.Color.BLACK, dashLength: 24 })
        : new C.ColorMaterialProperty(C.Color.fromCssColorString(isStart ? "#5be38f" : "#fff4ea").withAlpha(0.95));
      add({ polyline: { positions: ring, width: isStart || isFinish ? 7 : 5, material, arcType: C.ArcType.NONE } });
      const text = isStart ? (closed ? "START / FINISH" : "START") : isFinish ? "FINISH" : String(i + 1);
      add({ position: C.Cartesian3.add(pos[i], C.Cartesian3.multiplyByScalar(vert, r, new C.Cartesian3()), new C.Cartesian3()),
        label: lbl(text, C.Color.fromCssColorString(isStart ? "#5be38f" : isFinish ? "#fff4ea" : "#ffd23d")) });
    });
    layer.clear = () => { for (const e of layer.entities) viewer.entities.remove(e); layer.entities = []; };
    layer.ok = true;
  } catch (e) {
    console.warn("course layer failed", e);
  }
  return layer;
}

/** Put the camera on the whole route, looking along it from behind the start. */
export function frameRoute(g, positions, instant) {
  const { C, viewer } = g;
  if (!positions.length) return;
  const bs = C.BoundingSphere.fromPoints(positions);
  const a = C.Cartographic.fromCartesian(positions[0]), b = C.Cartographic.fromCartesian(positions[Math.min(positions.length - 1, 1)]);
  const heading = Math.atan2(b.longitude - a.longitude, b.latitude - a.latitude);
  viewer.camera.flyToBoundingSphere(bs, { offset: new C.HeadingPitchRange(heading, C.Math.toRadians(-32), Math.max(2500, bs.radius * 2.9)), duration: instant ? 0 : 1.2 });
  viewer.scene.requestRender();
}

// ================================================================== flyover
/** A camera that flies the route ~220 m above and behind the gates, looking ahead, looping.
 * Returns {play(), pause(), playing, destroy()}. Honors prefers-reduced-motion at the call site. */
const CLEARANCE = 60;
export function makeFlyover(g, course, opts) {
  const o = opts || {};
  const { C, viewer } = g;
  const gates = course.gate_coords || [];
  const ctl = { ok: false, playing: false, play() {}, pause() {}, destroy() {} };
  try {
    if (gates.length < 2) return ctl;
    const lift = o.lift || 220;
    const pts = gates.map((q) => C.Cartesian3.fromDegrees(q.lon, q.lat, (q.alt || 0) + lift));
    const dists = [0];
    for (let i = 1; i < pts.length; i++) dists.push(dists[i - 1] + C.Cartesian3.distance(pts[i - 1], pts[i]));
    const total = dists[dists.length - 1] || 1;
    const spline = new C.CatmullRomSpline({ times: dists.map((d) => d / total), points: pts });
    const speed = o.speed || Math.max(350, total / 40);          // m/s along the path: a course in ≲ 40 s
    const period = total / speed;
    let t0 = null, acc = 0, remove = null;
    const tick = (scene, time) => {
      const now = performance.now() / 1000;
      if (t0 == null) t0 = now - acc;
      const u = ((now - t0) / period) % 1;
      const p = spline.evaluate(u);
      const ahead = spline.evaluate(Math.min(1, u + 0.035));
      const back = C.Cartesian3.subtract(p, ahead, new C.Cartesian3());
      C.Cartesian3.normalize(back, back);
      const upv = C.Cartesian3.normalize(p, new C.Cartesian3());
      const eye = C.Cartesian3.add(p, C.Cartesian3.multiplyByScalar(back, 320, new C.Cartesian3()), new C.Cartesian3());
      C.Cartesian3.add(eye, C.Cartesian3.multiplyByScalar(upv, 90, new C.Cartesian3()), eye);
      // Never fly the camera through a ridge: keep it CLEARANCE m above whatever terrain is loaded.
      const carto = C.Cartographic.fromCartesian(eye);
      const ground = viewer.scene.globe.getHeight(carto);
      if (carto && Number.isFinite(ground) && carto.height < ground + CLEARANCE) {
        C.Cartesian3.add(eye, C.Cartesian3.multiplyByScalar(upv, ground + CLEARANCE - carto.height, new C.Cartesian3()), eye);
      }
      const dir = C.Cartesian3.normalize(C.Cartesian3.subtract(ahead, eye, new C.Cartesian3()), new C.Cartesian3());
      const right = C.Cartesian3.normalize(C.Cartesian3.cross(dir, upv, new C.Cartesian3()), new C.Cartesian3());
      const up = C.Cartesian3.cross(right, dir, new C.Cartesian3());
      viewer.camera.setView({ destination: eye, orientation: { direction: dir, up } });
      viewer.scene.requestRender();
    };
    ctl.play = () => {
      if (ctl.playing || g.dead) return;
      ctl.playing = true; t0 = null;
      remove = viewer.scene.preRender.addEventListener(tick);
      viewer.scene.requestRenderMode = false;                    // render every frame while flying
      if (o.onChange) o.onChange(true);
    };
    ctl.pause = () => {
      if (!ctl.playing) return;
      ctl.playing = false;
      acc = performance.now() / 1000 - (t0 || 0);
      if (remove) remove();
      remove = null;
      if (!g.dead) viewer.scene.requestRenderMode = true;        // idle: render on demand only
      if (o.onChange) o.onChange(false);
    };
    ctl.destroy = () => ctl.pause();
    ctl.ok = true;
  } catch (e) {
    console.warn("flyover failed", e);
  }
  return ctl;
}

// ================================================================== page-level mounts
function overlay(parent, globe) {
  const host = h("div", { class: "globe-host" });
  parent.appendChild(host);
  return host;
}

function attribution(parent, credits) {
  const p = h("p", { class: "viewer-attrib", text: credits.join(" · ") });
  parent.appendChild(p);
  return p;
}

// ================================================================== fallback note (3D unavailable)
/** A short, stable code for the note's `title` attribute -- "why", for whoever's chasing a "why is
 * this page showing the 2D fallback" report, without reading the console. */
export function reasonCodeOf(err) {
  if (!err) return "unknown";
  return err.blocked ? (err.reasonCode || "unknown") : (err.code || "device");
}
/** The visitor-facing clause naming why 3D didn't start, no trailing punctuation. */
export function fallbackText(err) {
  if (err && err.blocked) return "3D view is " + S().classifyBlockReason(reasonCodeOf(err)).message;
  return "3D view unavailable on this device";
}
/** Build (but do not place) the fallback note for a mount failure: a <p class="viewer-fallback">
 * whose title is the short reason code, whose text is fallbackText(err) + opts.suffix, with the
 * ?debug=1 reason appended inline, and -- when opts.onRetry is given -- a "Retry 3D" button wired
 * to it. Deliberately NOT .viewer-note (the position:absolute class used for the "terrain is flat"
 * degraded-3D note, which sits *over* a globe that did mount): every call site places this note in
 * normal document flow next to, never on top of, the 2D content underneath -- overlapping it is
 * the bug (gates hidden under the note) this class exists to fix. */
export function buildFallbackNote(err, opts) {
  const o = opts || {};
  let text = fallbackText(err) + (o.suffix || "");
  if (DEBUG() && err && err.reason) text += " (" + err.reason + ")";
  let retryBtn = null;
  if (o.onRetry) {
    retryBtn = h("button", { type: "button", class: "btn btn-ghost btn-sm viewer-retry" }, "Retry 3D");
    retryBtn.addEventListener("click", o.onRetry);
  }
  const note = h("p", { class: "viewer-fallback", title: reasonCodeOf(err), text }, retryBtn);
  return { note, retryBtn };
}

/** Course page viewer: the course layer, framed, with Flyover / Reset buttons. Resolves the handle
 * on success, null only when `opts.signal` aborted mid-mount (a real navigation-away, not a
 * failure -- the caller shows nothing), and rejects (err.blocked when the tile hosts are
 * unreachable) so the caller can show its own fallback note with a Retry button. */
export async function mountCourse(container, course, opts) {
  const o = opts || {};
  const host = overlay(container);
  let g;
  try {
    g = await createGlobe(host, { force: o.force });
  } catch (e) {
    host.remove();
    if (!e.blocked) console.warn("globe unavailable", e);
    throw e;
  }
  if (o.signal && o.signal.aborted) { g.destroy(); host.remove(); return null; }
  const layer = makeCourseLayer(g, course);
  frameRoute(g, layer.positions, true);
  const extras = [attribution(container, g.credits)];
  if (g.note) { const n = h("p", { class: "viewer-note", text: g.note }); container.appendChild(n); extras.push(n); }
  const reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const btn = h("button", { type: "button", class: "btn btn-primary btn-sm", "aria-pressed": "false" }, "▶ Auto flyover");
  const reset = h("button", { type: "button", class: "btn btn-ghost btn-sm" }, "Reset view");
  const fly = makeFlyover(g, course, { onChange: (on) => { btn.setAttribute("aria-pressed", String(on)); btn.textContent = on ? "❚❚ Stop flyover" : "▶ Auto flyover"; } });
  btn.addEventListener("click", () => (fly.playing ? fly.pause() : fly.play()));
  reset.addEventListener("click", () => { fly.pause(); frameRoute(g, layer.positions, false); });
  const bar = h("div", { class: "viewer-bar" }, h("div", { class: "btn-row" }, btn, reset));
  container.appendChild(bar);
  // Grabbing the globe stops the flyover so the user is in control.
  host.addEventListener("pointerdown", () => fly.pause());
  if (reduced) btn.title = "Your system asks for reduced motion; the flyover only runs when you press this.";
  return {
    g, layer,
    destroy() { fly.destroy(); layer.clear(); g.destroy(); host.remove(); bar.remove(); extras.forEach((x) => x.remove()); },
  };
}

/** Home hero: autoplaying flyover of the course of the week over its poster; pauses off-screen,
 * in a background tab, and when the user hits pause. */
export async function mountFlyover(media, course, opts) {
  const o = opts || {};
  const host = overlay(media);
  host.classList.add("fade-in");
  let g;
  try {
    g = await createGlobe(host, { labels: false, sse: 4, force: o.force });
  } catch (e) {
    host.remove();
    if (!e.blocked) console.warn("globe unavailable", e);
    throw e;
  }
  if (o.signal && o.signal.aborted) { g.destroy(); host.remove(); return null; }
  if (g.degraded) {           // a blurry low-detail globe is worse than the crisp poster
    g.destroy(); host.remove();
    return null;
  }
  const layer = makeCourseLayer(g, course, { labelRange: 20000 });
  frameRoute(g, layer.positions, true);
  const attrib = attribution(media, g.credits);
  let userPaused = false;
  const btn = h("button", { type: "button", class: "btn btn-ghost btn-sm", "aria-pressed": "true" }, "❚❚ Pause");
  const fly = makeFlyover(g, course, { onChange: (on) => { btn.setAttribute("aria-pressed", String(on)); btn.textContent = on ? "❚❚ Pause" : "▶ Fly"; } });
  btn.addEventListener("click", () => { if (fly.playing) { userPaused = true; fly.pause(); } else { userPaused = false; fly.play(); } });
  if (o.ctrl) clear(o.ctrl).appendChild(btn);
  let visible = true;
  const sync = () => { if (visible && !document.hidden && !userPaused) fly.play(); else fly.pause(); };
  const io = new IntersectionObserver((es) => { visible = es.some((e) => e.isIntersecting); sync(); }, { threshold: 0.2 });
  io.observe(media);
  document.addEventListener("visibilitychange", sync);
  if (o.autoplay) sync();
  return {
    destroy() {
      io.disconnect(); document.removeEventListener("visibilitychange", sync);
      fly.destroy(); layer.clear(); g.destroy(); host.remove(); attrib.remove(); btn.remove();
    },
  };
}

// ================================================================== ghosts (replay)
const modelIndexCache = { p: null };
function modelIndex() {
  if (!modelIndexCache.p) {
    modelIndexCache.p = fetch(MODEL_BASE + "index.json", { credentials: "omit" })
      .then((r) => (r.ok ? r.json() : [])).then((a) => { const m = {}; for (const x of a || []) if (x && x.id) m[x.id] = x; return m; })
      .catch(() => ({}));
  }
  return modelIndexCache.p;
}

/** Resolve a ghost's model: its own id, else the goldfish, else null (a point). The GLB is fetched
 * from MODEL_BASE ("/models/", this server's own origin), so connect-src 'self' covers it. */
export async function resolveModel(modelId) {
  const idx = await modelIndex();
  for (const id of [modelId, FALLBACK_MODEL]) {
    const m = id && idx[id];
    if (!m) continue;
    const url = MODEL_BASE + m.file;
    const ok = await probe(url);
    if (ok) return { id, url, scale: m.scale || 1, offset: m.offset || {} };
  }
  return null;
}

/** One ghost: Hermite-interpolated position over the replay clock, orientation from the recorded
 * hdg/pitch/roll (+ the model's offset), GLB with minimumPixelSize 48 (or a point), a speed-colored
 * full line, a rank-coloured label and a short trail. `epoch` is the JulianDate of t = 0. */
export function makeGhostLayer(g, ghost, epoch, opts) {
  const layer = { ok: false, entity: null, line: null, clear() {}, setColor() {}, setShow() {}, rebuild() {} };
  try {
    const { C, viewer } = g;
    const o = opts || {};
    const color = C.Color.fromCssColorString(ghost.color);
    const build = (rows) => {
      const posProp = new C.SampledPositionProperty();
      posProp.setInterpolationOptions({ interpolationDegree: 2, interpolationAlgorithm: C.HermitePolynomialApproximation });
      posProp.forwardExtrapolationType = C.ExtrapolationType.HOLD;
      posProp.backwardExtrapolationType = C.ExtrapolationType.HOLD;
      const oriProp = new C.SampledProperty(C.Quaternion);
      oriProp.forwardExtrapolationType = C.ExtrapolationType.HOLD;
      oriProp.backwardExtrapolationType = C.ExtrapolationType.HOLD;
      const times = [], ps = [], qs = [];
      const off = (ghost.model && ghost.model.offset) || {};
      for (const r of rows) {
        const t = C.JulianDate.addSeconds(epoch, r.t / 1000, new C.JulianDate());
        const p = C.Cartesian3.fromDegrees(r.lon, r.lat, r.alt);
        const hpr = S().hprRadians(r.hdg, r.pitch, r.roll, off);
        // GeoFS heading is clockwise from north, which is Cesium's heading convention too.
        const q = C.Transforms.headingPitchRollQuaternion(p, new C.HeadingPitchRoll(hpr.heading, hpr.pitch, hpr.roll));
        times.push(t); ps.push(p); qs.push(q);
      }
      posProp.addSamples(times, ps);
      oriProp.addSamples(times, qs);
      return { posProp, oriProp, ps };
    };
    let built = build(ghost.rows);
    const ent = viewer.entities.add({
      position: built.posProp,
      orientation: built.oriProp,
      model: ghost.model ? { uri: ghost.model.url, minimumPixelSize: 48, maximumScale: 400, scale: ghost.model.scale || 1,
        silhouetteColor: color, silhouetteSize: 1.5 } : undefined,
      point: ghost.model ? undefined : { pixelSize: 14, color, outlineColor: C.Color.fromCssColorString(PLUM), outlineWidth: 3, disableDepthTestDistance: Number.POSITIVE_INFINITY },
      label: { text: ghost.callsign, font: "700 14px Saira, Arial, sans-serif", fillColor: color, outlineColor: C.Color.fromCssColorString(PLUM), outlineWidth: 4,
        style: C.LabelStyle.FILL_AND_OUTLINE, pixelOffset: new C.Cartesian2(0, -30), disableDepthTestDistance: Number.POSITIVE_INFINITY },
      path: { leadTime: 0, trailTime: 8, width: 4, resolution: 0.25, material: new C.PolylineGlowMaterialProperty({ glowPower: 0.3, color }) },
    });
    // The full racing line, coloured by speed.
    const lineOf = (ps) => {
      const speeds = S().traceSpeeds(ghost.rows);
      const lo = Math.min(...speeds), hi = Math.max(...speeds);
      const colors = speeds.map((v) => C.Color.fromCssColorString(S().speedColor(v, lo, hi)).withAlpha(o.lineAlpha || 0.55));
      return viewer.scene.primitives.add(new C.Primitive({
        geometryInstances: new C.GeometryInstance({ geometry: new C.PolylineGeometry({ positions: ps, width: 2.5, colors, colorsPerVertex: true, arcType: C.ArcType.NONE }) }),
        appearance: new C.PolylineColorAppearance({ translucent: true }), asynchronous: false,
      }));
    };
    let line = lineOf(built.ps);
    layer.entity = ent; layer.line = line;
    layer.setColor = (css) => { const c = C.Color.fromCssColorString(css); ent.label.fillColor = c; };
    layer.setShow = (v) => { ent.show = v; line.show = v; };
    layer.rebuild = (rows) => {
      ghost.rows = rows;
      built = build(rows);
      ent.position = built.posProp; ent.orientation = built.oriProp;
      viewer.scene.primitives.remove(line);
      line = lineOf(built.ps); layer.line = line;
    };
    layer.clear = () => { viewer.entities.remove(ent); viewer.scene.primitives.remove(line); };
    layer.ok = true;
  } catch (e) {
    console.warn("ghost layer failed", e);
  }
  return layer;
}

// ================================================================== replay: cameras + mount
/** Cameras for the replay theater. `update(mode, st, extra)` places the camera for one frame:
 *  chase   — behind and above the target, heading smoothed so it doesn't whip on every wobble
 *  orbit   — circling the target
 *  cockpit — at the target, looking along its recorded heading/pitch/roll
 *  gate    — parked beside the target's next gate, watching it come through
 *  free    — hands off: the user is dragging the globe. */
export function makeCameraRig(g) {
  const { C, viewer } = g;
  const cam = viewer.camera;
  let hdgS = null, lastMode = null;
  const identity = () => cam.lookAtTransform(C.Matrix4.IDENTITY);
  return {
    update(mode, st, extra) {
      try {
        if (!st) return;
        const x = extra || {};
        const p = C.Cartesian3.fromDegrees(st.lon, st.lat, st.alt);
        if (mode !== lastMode) { identity(); hdgS = null; lastMode = mode; }
        if (mode === "free") return;
        if (hdgS == null) hdgS = st.hdg;
        hdgS = S().wrap360(hdgS + S().angleDelta(hdgS, st.hdg) * (mode === "chase" ? 0.12 : 1));
        if (mode === "chase") {
          cam.lookAt(p, new C.HeadingPitchRange(C.Math.toRadians(hdgS), C.Math.toRadians(-14), 150));
        } else if (mode === "orbit") {
          cam.lookAt(p, new C.HeadingPitchRange(C.Math.toRadians((x.wallS || 0) * 12), C.Math.toRadians(-24), 520));
        } else if (mode === "cockpit") {
          identity();
          const hpr = S().hprRadians(st.hdg, st.pitch, st.roll);
          const fwd = C.Cartesian3.fromDegrees(st.lon, st.lat, st.alt + 3);
          cam.setView({ destination: fwd, orientation: { heading: hpr.heading, pitch: hpr.pitch, roll: hpr.roll } });
        } else if (mode === "gate" && x.gate) {
          identity();
          const gp = C.Cartesian3.fromDegrees(x.gate.lon, x.gate.lat, (x.gate.alt || 0));
          const upv = C.Cartesian3.normalize(gp, new C.Cartesian3());
          const toT = C.Cartesian3.normalize(C.Cartesian3.subtract(p, gp, new C.Cartesian3()), new C.Cartesian3());
          const side = C.Cartesian3.normalize(C.Cartesian3.cross(toT, upv, new C.Cartesian3()), new C.Cartesian3());
          const eye = C.Cartesian3.add(gp, C.Cartesian3.multiplyByScalar(side, (x.gate.radius || 100) * 1.6, new C.Cartesian3()), new C.Cartesian3());
          C.Cartesian3.add(eye, C.Cartesian3.multiplyByScalar(upv, 35, new C.Cartesian3()), eye);
          const dir = C.Cartesian3.normalize(C.Cartesian3.subtract(p, eye, new C.Cartesian3()), new C.Cartesian3());
          const right = C.Cartesian3.normalize(C.Cartesian3.cross(dir, upv, new C.Cartesian3()), new C.Cartesian3());
          cam.setView({ destination: eye, orientation: { direction: dir, up: C.Cartesian3.cross(right, dir, new C.Cartesian3()) } });
        }
      } catch (e) {
        if (!this._warned) { console.warn("camera update failed", e); this._warned = true; }
      }
    },
    release() { identity(); lastMode = "free"; },
  };
}

/** The replay stage. `ghosts` = [{id, callsign, rows, modelId, color}]. Resolves a handle, or
 * rejects (err.blocked when the tile hosts are unreachable) so the caller keeps its 2D stage. */
export async function mountReplay(stage, course, ghosts, opts) {
  const o = opts || {};
  const host = overlay(stage);
  let g;
  try {
    g = await createGlobe(host, { force: o.force });
  } catch (e) {
    host.remove();
    throw e;
  }
  const { C, viewer } = g;
  // A race on a course that has since been edited has no gates to draw: just the lines.
  const course3d = (course.gate_coords || []).length ? makeCourseLayer(g, course, { labelRange: 30000 }) : { positions: [], clear() {} };
  const epoch = C.JulianDate.fromDate(new Date(Date.UTC(2000, 0, 1)));
  viewer.clock.shouldAnimate = false;
  viewer.clock.currentTime = epoch.clone();
  const models = await Promise.all(ghosts.map((gh) => resolveModel(gh.modelId).catch(() => null)));
  const layers = new Map();
  ghosts.forEach((gh, i) => {
    const layer = makeGhostLayer(g, { callsign: gh.callsign, rows: gh.rows, color: gh.color, model: models[i] }, epoch);
    if (layer.ok) layers.set(gh.id, layer);
  });
  const framePts = course3d.positions.length ? course3d.positions
    : ghosts.flatMap((gh) => gh.rows.filter((_, i) => i % 20 === 0).map((r) => C.Cartesian3.fromDegrees(r.lon, r.lat, r.alt)));
  frameRoute(g, framePts, true);
  const attrib = attribution(stage, g.credits);
  const note = g.note ? h("p", { class: "viewer-note", text: g.note }) : null;
  if (note) stage.appendChild(note);
  const rig = makeCameraRig(g);
  let frames = 0, fps = 0, last = performance.now();
  const removeFps = viewer.scene.postRender.addEventListener(() => {
    frames++;
    const now = performance.now();
    if (now - last >= 1000) { fps = (frames * 1000) / (now - last); frames = 0; last = now; }
  });
  host.addEventListener("pointerdown", () => { if (o.onUserCamera) o.onUserCamera(); });
  host.addEventListener("wheel", () => { if (o.onUserCamera) o.onUserCamera(); }, { passive: true });
  let hiddenForCockpit = null;
  return {
    g, models,
    setTime(ms) { C.JulianDate.addSeconds(epoch, ms / 1000, viewer.clock.currentTime); viewer.scene.requestRender(); },
    setShow(id, v) { const l = layers.get(id); if (l) l.setShow(v); viewer.scene.requestRender(); },
    setLabelColor(id, css) { const l = layers.get(id); if (l) l.setColor(css); },
    rebuild(id, rows) { const l = layers.get(id); if (l) l.rebuild(rows); viewer.scene.requestRender(); },
    camera(mode, targetId, st, extra) {
      // Inside the cockpit the target's own model would fill the screen.
      const want = mode === "cockpit" ? targetId : null;
      if (want !== hiddenForCockpit) {
        if (hiddenForCockpit && layers.get(hiddenForCockpit)) layers.get(hiddenForCockpit).entity.model && (layers.get(hiddenForCockpit).entity.model.show = true);
        if (want && layers.get(want) && layers.get(want).entity.model) layers.get(want).entity.model.show = false;
        hiddenForCockpit = want;
      }
      rig.update(mode, st, extra);
      viewer.scene.requestRender();
    },
    release() { rig.release(); },
    fps: () => fps,
    frame() { frameRoute(g, framePts, false); },
    destroy() {
      removeFps();
      for (const l of layers.values()) l.clear();
      course3d.clear(); g.destroy(); host.remove(); attrib.remove(); if (note) note.remove();
    },
  };
}
