// Ground heights from Terrarium PNG tiles, without Cesium: fetch the tile, draw it to a canvas,
// read the pixel, decode. Used by the course elevation profile. Needs the target CSP
// (connect-src s3.amazonaws.com); under the current one every fetch is refused and the caller
// falls back to gate altitudes only.

import { TILE_SOURCES } from "./config.js";
import { allowed } from "./api.js";

const S = () => window.FinsSite;
const tiles = new Map();   // "z/x/y" -> Promise<ImageData>

function tileUrl(z, x, y) {
  return TILE_SOURCES.terrain.url.replace("{z}", z).replace("{x}", x).replace("{y}", y);
}

function loadTile(z, x, y, signal) {
  const key = z + "/" + x + "/" + y;
  if (!tiles.has(key)) {
    const p = fetch(tileUrl(z, x, y), { signal, credentials: "omit", mode: "cors" })
      .then((r) => { if (!r.ok) throw new Error("tile HTTP " + r.status); return r.blob(); })
      .then((b) => createImageBitmap(b))
      .then((bmp) => {
        const c = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(256, 256) : Object.assign(document.createElement("canvas"), { width: 256, height: 256 });
        const g = c.getContext("2d", { willReadFrequently: true });
        g.drawImage(bmp, 0, 0);
        return g.getImageData(0, 0, 256, 256);
      });
    p.catch(() => tiles.delete(key));
    tiles.set(key, p);
  }
  return tiles.get(key);
}

/** Heights (m) for [{lat, lon}] at zoom z; rejects if any tile can't be read. At most maxTiles
 * distinct tiles: the zoom steps down until the set fits. */
export async function sampleHeights(points, opts) {
  const o = opts || {};
  if (!(await allowed("connect-src", tileUrl(0, 0, 0)))) throw new Error("terrain host not allowed by this page's CSP");
  let z = o.zoom || 12;
  const max = o.maxTiles || 24;
  let refs;
  for (;;) {
    refs = points.map((p) => S().lonLatToTile(p.lat, p.lon, z));
    const distinct = new Set(refs.map((t) => t.x + "/" + t.y));
    if (distinct.size <= max || z <= 6) break;
    z--;
  }
  const out = [];
  for (const t of refs) {
    const img = await loadTile(t.z, t.x, t.y, o.signal);
    const i = (t.py * 256 + t.px) * 4;
    out.push(S().terrariumHeight(img.data[i], img.data[i + 1], img.data[i + 2]));
  }
  return out;
}
