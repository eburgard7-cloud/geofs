# Vendored third-party files

Served as-is from race.finsonly.net; nothing here is built or edited.

| Path | What | Version | License |
|---|---|---|---|
| `cesium/` | CesiumJS `Build/Cesium` (minified IIFE) from the `cesium` npm package | 1.145.0 | Apache-2.0 (`cesium/LICENSE.md`; third-party notices in `cesium/ThirdParty.json`) |

Pruned from the upstream build because the site never uses them: `index.js`/`index.cjs` (ESM/CJS
duplicates of `Cesium.js`), `Assets/Textures/maki` (pin icons), `Assets/Textures/LensFlare`,
`ThirdParty/google-earth-dbroot-parser.js` (Google Earth Enterprise). `Assets/Textures/NaturalEarthII`
is kept on purpose: it is the same-origin imagery the globe falls back to when the tile hosts are
blocked.

**One patch** (re-apply on upgrade): in `cesium/Cesium.js`, knockout's global lookup
`var t=this||(0,eval)("this")` is replaced by `var t=this||globalThis`. That indirect eval runs when
the bundle initialises and would need `'unsafe-eval'` in the site's CSP; `globalThis` is the same
object. The site uses `CesiumWidget`, never `Viewer`, so knockout's binding compiler (the other
`new Function` in the bundle) never runs. `grep -c '(0,eval)' cesium/Cesium.js` must print 0.

To upgrade: `npm pack cesium@<version>`, copy `Build/Cesium/{Cesium.js,Workers,ThirdParty,Widgets,Assets}`
here, re-apply the prune list above, and bump the version in this table and in `js/config.js`.
