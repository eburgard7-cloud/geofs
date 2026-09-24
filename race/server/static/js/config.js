// Site configuration: the one place that names an external host, and every feature flag.
//
// TILE_SOURCES is deliberately the only list of tile URLs. Phase B points each `url` at a
// race.finsonly.net/tiles/* proxy (SITE_GAPS.md) and the CSP shrinks back to 'self'; nothing
// else in the site changes.

export const SITE_VERSION = "hq-1.0.0";
export const CESIUM_VERSION = "1.145.0";

export const TILE_SOURCES = Object.freeze({
  // AWS Terrain Tiles (Terrarium PNG, Web Mercator z0-15). Public dataset, no key.
  terrain: {
    url: "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png",
    maxZoom: 14,
    credit: "Terrain: Mapzen Terrain Tiles on AWS (SRTM, GMTED, NED, ETOPO1 and others)",
  },
  // Tried in order; the first one whose probe tile loads wins.
  imagery: [
    {
      id: "esri",
      url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      maxZoom: 18,
      credit: "Imagery: Esri, Maxar, Earthstar Geographics, and the GIS User Community",
    },
    {
      id: "eox-s2cloudless",
      url: "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/{z}/{y}/{x}.jpg",
      maxZoom: 15,
      credit: "Sentinel-2 cloudless by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2020), CC BY-NC-SA 4.0",
    },
  ],
  // Place names + borders drawn over the imagery. Same host and terms as the Esri imagery above,
  // so it adds no new host to the CSP. Set to null to drop labels.
  labels: {
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
    maxZoom: 18,
    credit: "Labels: Esri",
  },
});

// Ghost models: the same raw-GitHub base race.js's CONFIG.MODEL_BASE uses.
export const MODEL_BASE = "https://raw.githubusercontent.com/eburgard7-cloud/geofs/main/race/models/";
export const FALLBACK_MODEL = "goldfish";

// Google Photorealistic 3D Tiles. Off unless a key is set; see the runbook in SITE_GAPS.md for
// the HTTP-referrer restriction the key must carry, and the CSP host it needs.
export const GOOGLE_3D_TILES = false;
export const GOOGLE_MAPS_KEY = "";

export const FLAGS = Object.freeze({
  HOME_3D: true,          // live 3D flyover in the home hero (poster fallback either way)
  COURSE_3D: true,        // 3D viewer on course and replay pages (2D fallback either way)
  TERRAIN_PROFILE: true,  // sample Terrarium tiles for the course elevation profile
  // Gap-backed: each needs data no endpoint serves yet (SITE_GAPS.md). Off until Phase B.
  COURSE_META: false,     // env chips, aircraft lock, terrain status, history blurb
  SEASONS: false,         // season standings on /cups
  PRESENCE: false,        // hub presence (who is online but not in a room)
  RECORD_HISTORY: false,  // "X took Y from Z" and true reigns
});

// Runway ids for /landing. No endpoint lists runways (SITE_GAPS.md: GET /runways), so this is a
// snapshot of race/runways/index.json; an id the server no longer knows 404s and is dropped.
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

// Replay ghost colours (rank order) — distinct on plum, colour-blind-safe-ish ordering.
export const GHOST_COLORS = Object.freeze(["#ffd23d", "#ff3d8b", "#5be38f", "#6ec3ff", "#ff8a3d", "#b48cff", "#fff4ea", "#ff6b6b"]);

// Courses whose lowest gate is this close to the ground get the terrain-mismatch warning.
export const LOW_LEVEL_AGL_M = 150;
