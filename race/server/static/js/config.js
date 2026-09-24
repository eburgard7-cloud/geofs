// Site configuration: the one place that names an external host, and every feature flag.
//
// TILE_SOURCES is deliberately the only list of tile URLs. Phase B is done: every `url` below is
// now a race.finsonly.net/tiles/* proxy (see race/server/app.py's "Tile proxy + disk cache"
// section) instead of a third-party host directly, so the CSP is back to img-src 'self'. The
// server picks the real upstream (RACE_IMAGERY env var switches Esri/EOX for everyone at once);
// GET /tiles/attribution is the source of truth for credit text if it ever needs to move off the
// static strings kept here too.

export const SITE_VERSION = "hq-1.0.0";
export const CESIUM_VERSION = "1.145.0";

export const TILE_SOURCES = Object.freeze({
  // Proxied AWS Terrain Tiles (Terrarium PNG, Web Mercator z0-15).
  terrain: {
    url: "/tiles/terrain/{z}/{x}/{y}.png",
    maxZoom: 14,
    credit: "Terrain: Mapzen Terrain Tiles on AWS (SRTM, GMTED, NED, ETOPO1 and others)",
  },
  // One entry now that the server (not the client) picks the upstream -- kept as a list because
  // globe.js iterates it. RACE_IMAGERY=eox on the server swaps the tiles this same URL returns.
  imagery: [
    {
      id: "proxy",
      url: "/tiles/imagery/{z}/{y}/{x}",
      maxZoom: 18,
      credit: "Imagery: Esri, Maxar, Earthstar Geographics, and the GIS User Community "
        + "(or EOX Sentinel-2 cloudless, CC BY-NC-SA 4.0, when the server is set to RACE_IMAGERY=eox "
        + "-- see /tiles/attribution)",
    },
  ],
  // Place names + borders drawn over the imagery, now also proxied. Set to null to drop labels.
  labels: {
    url: "/tiles/labels/{z}/{y}/{x}",
    maxZoom: 18,
    credit: "Labels: Esri",
  },
});

// Ghost models: the same raw-GitHub base race.js's CONFIG.MODEL_BASE uses.
export const MODEL_BASE = "https://raw.githubusercontent.com/eburgard7-cloud/geofs/main/race/models/";
export const FALLBACK_MODEL = "goldfish";

// Google Photorealistic 3D Tiles. Off unless a key is set; the key needs an HTTP-referrer restriction
// and the CSP has to allow its host.
export const GOOGLE_3D_TILES = false;
export const GOOGLE_MAPS_KEY = "";

export const FLAGS = Object.freeze({
  HOME_3D: true,          // live 3D flyover in the home hero (poster fallback either way)
  COURSE_3D: true,        // 3D viewer on course and replay pages (2D fallback either way)
  TERRAIN_PROFILE: true,  // sample Terrarium tiles for the course elevation profile
  RECORD_HISTORY: true,   // GET /records/history: "X took Y from Z" and true reigns (board-only on an old server)
  // Gap-backed: each needs data no endpoint serves yet. Off until the server sends it.
  COURSE_META: false,     // env chips, aircraft lock, terrain status, history blurb (not in /courses/catalog)
  SEASONS: false,         // season standings on /cups (no season endpoint)
  PRESENCE: false,        // hub presence (who is online but not in a room; no endpoint)
});

// Runway ids for /landing when the server has no GET /runways (it arrived after server 1.5.0): a
// snapshot of race/runways/index.json. An id the server no longer knows 404s and is dropped.
export const RUNWAYS = Object.freeze([
  ["3u2-17", "Johnson Creek 17 (Idaho backcountry)"], ["3u2-35", "Johnson Creek 35 (Idaho backcountry)"],
  ["friday-harbor-16", "Friday Harbor 16 (short)"], ["kase-15", "Aspen 15 (Roaring Fork valley)"],
  ["keug-16r", "Eugene 16R"], ["kmsn-36", "Madison 36 (Truax Field)"], ["kpdx-10r", "Portland 10R (along the Columbia)"],
  ["ktex-09", "Telluride 09 (mesa-top, 1000 ft drop)"], ["lflj-22", "Courchevel 22 (uphill altiport)"],
  ["lowi-26", "Innsbruck 26 (Inn valley from the east)"], ["lpma-05", "Madeira 05 (Rota 05 visual)"],
  ["lxgb-09", "Gibraltar 09 (bay approach under the Rock)"], ["mmsd-34", "Los Cabos 34 (from the coast)"],
  ["nzqn-05", "Queenstown 05 (Kawarau gorge)"], ["pamr-26", "Merrill Field 26 (Anchorage)"], ["patk-01", "Talkeetna 01"],
  ["s10-02", "Lake Chelan 02 (Chelan)"], ["s81-04", "Indian Creek 04 (Middle Fork Salmon)"],
  ["s81-22", "Indian Creek 22 (Middle Fork Salmon)"], ["sea-tac-16c", "Sea-Tac 16C (wide, forgiving)"],
  ["sisters-eagle-air-34", "Sisters Eagle Air 34 (terrain on approach)"], ["tffj-10", "St Barths 10 (over the Col de la Tourmente)"],
  ["tncm-10", "Sint Maarten 10 (Maho Beach approach)"], ["tncs-12", "Saba 12 (shortest commercial runway)"],
  ["vnlk-06", "Lukla 06 (uphill, cliff at the threshold)"], ["vqpr-15", "Paro 15 (valley S-turns)"],
].map(([id, name]) => Object.freeze({ id, name })));

// Landing cups, copied from race/runways/LANDING_CUPS.md (docs only: no endpoint serves the grouping).
// A runway in no group lands under "Other runways"; an id the server doesn't know is simply absent.
export const LANDING_GROUPS = Object.freeze([
  ["White-Knuckle Cup", ["vnlk-06", "vqpr-15", "lflj-22", "tncs-12"]],
  ["Beach & Island Cup", ["tffj-10", "tncm-10", "lpma-05", "lxgb-09"]],
  ["Mountain Cup", ["nzqn-05", "lowi-26", "kase-15", "ktex-09"]],
  ["Home Cup", ["keug-16r", "kpdx-10r", "kmsn-36", "mmsd-34"]],
  ["Bush Strips", ["3u2-35", "3u2-17", "patk-01", "s10-02", "pamr-26", "s81-04", "s81-22"]],
].map(([name, ids]) => Object.freeze({ name, ids: Object.freeze(ids) })));

// Replay ghost colours (rank order) — distinct on plum, colour-blind-safe-ish ordering.
export const GHOST_COLORS = Object.freeze(["#ffd23d", "#ff3d8b", "#5be38f", "#6ec3ff", "#ff8a3d", "#b48cff", "#fff4ea", "#ff6b6b"]);

// Courses whose lowest gate is this close to the ground get the terrain-mismatch warning.
export const LOW_LEVEL_AGL_M = 150;
