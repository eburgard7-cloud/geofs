// ==UserScript==
// @name         FINSONLY Racing + LiverySelector
// @namespace    https://race.finsonly.net/
// @version      1.0.0
// @description  Loads FINSONLY Racing and LiverySelector into GeoFS once the plane is up: the COMBINED bookmarklet, for browsers without a bookmark bar (Firefox for Android + Tampermonkey).
// @match        https://www.geo-fs.com/geofs.php*
// @match        https://geo-fs.com/geofs.php*
// @grant        none
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/eburgard7-cloud/geofs/main/race/tools/finsonly-race.user.js
// @downloadURL  https://raw.githubusercontent.com/eburgard7-cloud/geofs/main/race/tools/finsonly-race.user.js
// ==/UserScript==

/*
 * FINSONLY Racing userscript (Tampermonkey / Violentmonkey). Does exactly what the COMBINED line in
 * race/bookmarklet.txt does, without a click: race.js from raw.githubusercontent (BRANCH, cache-
 * busted) with the pinned jsDelivr race-v1.0.0 tag as the fallback, then LiverySelector from
 * kolos26's raw main with jsDelivr @main as its fallback. Same guards as the bookmarklet: nothing is
 * loaded twice (window.__finsRace, #listDiv). A small toast says how it went.
 *
 * While testing a branch, edit BRANCH below in Tampermonkey's editor (e.g. 'tablet-mode'). It only
 * changes where race.js comes from; LiverySelector always comes from kolos26's main.
 *
 * @grant none: this runs in the page itself, like a bookmarklet, so window.__finsRace and GeoFS's
 * globals are the page's own. Nothing here touches the sim; it only adds two <script> tags.
 */
(() => {
  'use strict';

  const BRANCH = 'main';
  const REPO = 'eburgard7-cloud/geofs';
  const RACE_RAW = () => 'https://raw.githubusercontent.com/' + REPO + '/' + BRANCH + '/race/race.js?t=' + Date.now();
  const RACE_CDN = 'https://cdn.jsdelivr.net/gh/' + REPO + '@race-v1.0.0/race/race.js';
  const LIVERY_RAW = () => 'https://raw.githubusercontent.com/kolos26/GEOFS-LiverySelector/main/main.js?t=' + Date.now();
  const LIVERY_CDN = 'https://cdn.jsdelivr.net/gh/kolos26/GEOFS-LiverySelector@main/main.js';
  const READY_TIMEOUT_MS = 180000;

  // ---------------------------------------------------------------- pure helpers (Node-testable)
  // A load result is { state: 'ok' | 'fallback' | 'already' | 'failed', reason? }.
  function part(name, r) {
    const res = r || { state: 'failed', reason: 'not tried' };
    if (res.state === 'ok' || res.state === 'already') return name + ' OK';
    if (res.state === 'fallback') return name + ' OK (fallback)';
    return name + ' FAILED' + (res.reason ? ' (' + res.reason + ')' : '');
  }
  // "Racing OK · Liveries OK", "Racing OK (fallback) · Liveries OK", "Racing FAILED (HTTP 404) · …"
  function loaderToast(race, livery) {
    return part('Racing', race) + ' · ' + part('Liveries', livery);
  }
  function loaderTone(race, livery) {
    return [race, livery].some((r) => !r || r.state === 'failed') ? 'bad'
      : [race, livery].some((r) => r.state === 'fallback') ? 'warn' : 'good';
  }
  // GeoFS is ready for the mods once the player's aircraft has its 3D object.
  function geofsReady(w) {
    try { return !!(w.geofs && w.geofs.aircraft && w.geofs.aircraft.instance && w.geofs.aircraft.instance.object3d); } catch (_) { return false; }
  }

  function runInBrowser() {
    if (window.__finsUserscript) return;
    window.__finsUserscript = true;

    const inject = (code) => { const s = document.createElement('script'); s.textContent = code; document.head.appendChild(s); };
    const injectSrc = (src) => new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('could not load ' + src.replace(/^https:\/\//, '').split('/')[0]));
      document.head.appendChild(s);
    });
    const fetchText = (url) => fetch(url, { cache: 'no-store' }).then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); });

    // raw first; if the fetch fails or the code didn't take (loaded() still false), the CDN copy.
    async function load(rawUrl, cdnUrl, loaded) {
      let why = '';
      try {
        inject(await fetchText(rawUrl));
        if (loaded()) return { state: 'ok' };
        why = 'did not start';
      } catch (e) { why = e.message; }
      try {
        await injectSrc(cdnUrl);
        return loaded() ? { state: 'fallback' } : { state: 'failed', reason: why + '; fallback did not start' };
      } catch (e) { return { state: 'failed', reason: why + '; ' + e.message }; }
    }

    function toast(text, tone) {
      const el = document.createElement('div');
      el.textContent = text;
      const color = tone === 'bad' ? '#e5484d' : tone === 'warn' ? '#f5a524' : '#30a46c';
      el.style.cssText = 'position:fixed;left:50%;top:64px;transform:translateX(-50%);z-index:2147483000;max-width:calc(100vw - 32px);'
        + 'padding:10px 14px;border-radius:10px;background:rgba(12,16,26,.94);color:#fff;font:600 14px/1.3 system-ui,sans-serif;'
        + 'border-left:4px solid ' + color + ';box-shadow:0 4px 18px rgba(0,0,0,.4);cursor:pointer;touch-action:none';
      const drop = () => el.remove();
      for (const t of ['pointerdown', 'touchstart', 'mousedown', 'click']) el.addEventListener(t, (e) => { e.stopPropagation(); if (t === 'pointerdown' || t === 'click') drop(); });
      document.body.appendChild(el);
      setTimeout(drop, tone === 'good' ? 5000 : 12000);
    }

    async function start() {
      const race = window.__finsRace ? { state: 'already' }
        : await load(RACE_RAW(), RACE_CDN, () => !!window.__finsRace);
      // race.js sets window.__finsRace synchronously, so "did it start" is checkable. LiverySelector
      // may build #listDiv later, so a clean fetch + inject counts; checking #listDiv here would
      // fall back and load it twice.
      const livery = document.getElementById('listDiv') ? { state: 'already' }
        : await load(LIVERY_RAW(), LIVERY_CDN, () => true);
      const text = loaderToast(race, livery) + (BRANCH !== 'main' ? ' [' + BRANCH + ']' : '');
      console.info('[finsUserscript] ' + text, { race, livery });
      toast(text, loaderTone(race, livery));
    }

    const began = Date.now();
    const wait = setInterval(() => {
      if (geofsReady(window)) { clearInterval(wait); start(); return; }
      if (Date.now() - began > READY_TIMEOUT_MS) {
        clearInterval(wait);
        toast('FINSONLY: GeoFS never finished loading, so nothing was loaded. Reload the page.', 'bad');
      }
    }, 500);
  }

  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    runInBrowser();
  } else if (typeof module !== 'undefined' && module.exports) {
    module.exports = { loaderToast, loaderTone, geofsReady, BRANCH, RACE_CDN, LIVERY_CDN };
  }
})();
