/*
 * FINSONLY Racing — checkpoint racing layer for GeoFS
 * Single file, no dependencies. Load with the bookmarklet in README.md.
 * Safe to load twice (second load just re-shows the panel).
 */
(() => {
  'use strict';
  if (window.__finsRace) { try { window.__finsRace.ui.toggle(true); } catch (_) {} return; }

  // ---------------------------------------------------------------- config
  const CONFIG = {
    VERSION: '0.2.1',
    COURSE_BASE: 'https://raw.githubusercontent.com/eburgard7-cloud/geofs/main/race/courses/',
    MODEL_BASE: 'https://raw.githubusercontent.com/eburgard7-cloud/geofs/main/race/models/',
    API_BASE: '',              // e.g. 'https://race.finsonly.net' — empty = leaderboard off
    DEFAULT_RADIUS_M: 150,
    MAX_SPEED_MS: 700,         // ~1360 kt. Faster than this between samples = teleport/slew → DQ
    PAUSE_MOVE_TOLERANCE_M: 50,
    ALT_OFFSET_M: 0,           // visual-only nudge if gates render above/below where they trigger
    TEST_SPACING_M: 2000,
    TEST_COUNT: 6,
    HUD_HZ: 10,
    READY_TIMEOUT_MS: 180000,
  };

  // --------------------------------------------------------------- storage
  const store = {
    get(k, d) { try { const v = localStorage.getItem('finsRace.' + k); return v == null ? d : JSON.parse(v); } catch (_) { return d; } },
    set(k, v) { try { localStorage.setItem('finsRace.' + k, JSON.stringify(v)); } catch (_) {} },
  };

  // --------------------------------------------- GeoFS adapter (all internals here)
  const G = {
    ready() {
      try {
        return !!(window.geofs && geofs.aircraft && geofs.aircraft.instance &&
          geofs.aircraft.instance.llaLocation && geofs.api && geofs.api.viewer && window.Cesium);
      } catch (_) { return false; }
    },
    lla() { const l = geofs.aircraft.instance.llaLocation; return { lat: +l[0], lon: +l[1], alt: +l[2] }; },
    heading() {
      const v = (geofs.animation && geofs.animation.values) || {};
      const hd = v.heading360 ?? v.heading;
      return Number.isFinite(hd) ? ((hd % 360) + 360) % 360 : null;
    },
    kias() { const v = geofs.animation && geofs.animation.values; return v && Number.isFinite(v.kias) ? v.kias : null; },
    paused() { try { return typeof geofs.isPaused === 'function' && !!geofs.isPaused(); } catch (_) { return false; } },
    aircraftId() { try { return String(geofs.aircraft.instance.id ?? ''); } catch (_) { return ''; } },
    callsign() { try { return (geofs.userRecord && geofs.userRecord.callsign) || ''; } catch (_) { return ''; } },
    viewer() { return geofs.api.viewer; },
    model() { return typeof window.__finsModel === 'string' ? window.__finsModel.slice(0, 32) : ''; },

    // ---- model-swap additions. These fields are NOT verified against the live site (see
    // README "Model swaps" and race/tools/probe.js); every method below is marked TODO-PROBE
    // and degrades to a harmless default instead of throwing if the guess is wrong.
    pitch() { // confirmed via probe: animation.values.pitch is a number
      const v = geofs.animation && geofs.animation.values;
      return v && Number.isFinite(v.pitch) ? v.pitch : 0;
    },
    roll() { // confirmed via probe: animation.values.roll is a number
      const v = geofs.animation && geofs.animation.values;
      return v && Number.isFinite(v.roll) ? v.roll : 0;
    },
    scene() { try { return geofs.api.viewer.scene; } catch (_) { return null; } },
    isCockpitView() { // TODO-PROBE: guessed candidates for the active camera mode
      try {
        const cam = geofs.camera;
        if (cam && typeof cam.mode === 'number') return cam.mode === 0;
        if (cam && typeof cam.type === 'string') return /cockpit|internal/i.test(cam.type);
        return false;
      } catch (_) { return false; }
    },
    // Confirmed via probe: GeoFS's own scene-graph wrapper nodes (e.g. aircraft.instance.object3d)
    // use .visible, not .show. Cesium.Model instances we create ourselves use .show. Recognize
    // and toggle either.
    isShowable(x) { return !!x && typeof x === 'object' && (typeof x.show === 'boolean' || typeof x.visible === 'boolean'); },
    setShow(x, show) {
      if (!x) return;
      if (typeof x.show === 'boolean') x.show = show;
      if (typeof x.visible === 'boolean') x.visible = show;
    },
    // Bounded, cycle-safe scan for anything duck-typed as showable. Used as a fallback in case
    // a future GeoFS update moves the stock aircraft's visual model off the confirmed .object3d.
    findShowables(root, maxDepth) {
      const out = [], seen = new Set();
      const walk = (obj, depth) => {
        if (!obj || typeof obj !== 'object' || depth > maxDepth || seen.has(obj) || out.length >= 6) return;
        seen.add(obj);
        if (G.isShowable(obj)) { out.push(obj); return; }
        let keys; try { keys = Object.keys(obj); } catch (_) { return; }
        for (const k of keys) {
          if (out.length >= 6) return;
          let v; try { v = obj[k]; } catch (_) { continue; }
          if (v && typeof v === 'object') walk(v, depth + 1);
        }
      };
      walk(root, 0);
      return out;
    },
    stockAircraftNodes() { // confirmed via probe: aircraft.instance.object3d (a .visible node)
      try {
        const inst = geofs.aircraft && geofs.aircraft.instance;
        if (!inst) return [];
        const direct = [inst.object3d, inst.model, inst._model, inst.primitive].filter(G.isShowable);
        if (direct.length) return direct;
        return G.findShowables(inst, 2); // fallback if a future update moves it
      } catch (_) { return []; }
    },
    multiplayerUsers() { // confirmed via probe: the global `multiplayer.users` (an object, not array)
      try {
        const mp = geofs.multiplayer || window.multiplayer;
        if (!mp) return [];
        const raw = mp.users || mp.otherPlayers || mp.slots || mp.instances || mp.players || {};
        const list = Array.isArray(raw) ? raw : Object.values(raw || {});
        return list.map(G.normalizeUser).filter(Boolean);
      } catch (_) { return []; }
    },
    // Confirmed via probe: user.callsign, user.id, user.model (a showable node, null until
    // nearby/rendered). Position/orientation come from user.lastUpdate.co, an array whose first
    // four entries are [lat, lon, alt, headingDeg] (confirmed: co[3]=76.83 matched a plausible
    // heading). co[4]/co[5] are ASSUMED pitch/roll degrees (TODO-PROBE: unconfirmed — both were
    // 0 in the sample, which is consistent but not conclusive). Older/alternate shapes are kept
    // as a fallback chain in case a future update changes this.
    normalizeUser(u) {
      try {
        if (!u) return null;
        const callsign = u.callsign || (u.userRecord && u.userRecord.callsign) || u.name || '';
        if (!callsign) return null;
        const id = String(u.id ?? u.acid ?? callsign);
        const co = (u.lastUpdate && u.lastUpdate.co) || (u.referencePoint && u.referencePoint.lla) || null;
        let lat, lon, alt, heading, pitch, roll;
        if (Array.isArray(co)) { [lat, lon, alt, heading, pitch, roll] = co; }
        else if (Array.isArray(u.llaLocation)) { [lat, lon, alt] = u.llaLocation; heading = u.heading; pitch = u.pitch; roll = u.roll; }
        else if (u.position) { ({ lat, lon, alt } = u.position); heading = u.heading; pitch = u.pitch; roll = u.roll; }
        else { lat = u.lat; lon = u.lon; alt = u.alt; heading = u.heading; pitch = u.pitch; roll = u.roll; }
        lat = +lat; lon = +lon; alt = +alt;
        if (![lat, lon, alt].every(Number.isFinite)) return null;
        heading = Number.isFinite(+heading) ? +heading : 0;
        pitch = Number.isFinite(+pitch) ? +pitch : 0;
        roll = Number.isFinite(+roll) ? +roll : 0;
        const node = [u.model, u.object3d, u._model, u.primitive].find(G.isShowable) || null;
        return { id, callsign, lat, lon, alt, heading, pitch, roll, node };
      } catch (_) { return null; }
    },
  };

  // -------------------------------------------------------------- geometry
  const D2R = Math.PI / 180, WGS_A = 6378137, WGS_E2 = 6.69437999014e-3;
  function ecef(lat, lon, alt) {
    const p = lat * D2R, l = lon * D2R, s = Math.sin(p), c = Math.cos(p);
    const N = WGS_A / Math.sqrt(1 - WGS_E2 * s * s);
    return [(N + alt) * c * Math.cos(l), (N + alt) * c * Math.sin(l), (N * (1 - WGS_E2) + alt) * s];
  }
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const vlen = (a) => Math.sqrt(dot(a, a));
  // Closest approach of segment p0→p1 to c. Returns t∈[0,1] if within r, else -1.
  function segHit(p0, p1, c, r) {
    const d = sub(p1, p0), f = sub(p0, c), dd = dot(d, d);
    const t = dd > 0 ? Math.max(0, Math.min(1, -dot(f, d) / dd)) : 0;
    const q = [f[0] + d[0] * t, f[1] + d[1] * t, f[2] + d[2] * t];
    return vlen(q) <= r ? t : -1;
  }
  function bearingDeg(a, b) {
    const f1 = a.lat * D2R, f2 = b.lat * D2R, dl = (b.lon - a.lon) * D2R;
    const y = Math.sin(dl) * Math.cos(f2);
    const x = Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl);
    return (Math.atan2(y, x) / D2R + 360) % 360;
  }
  function destination(p, brg, dist) {
    const dr = dist / 6371008.8, th = brg * D2R, f1 = p.lat * D2R, l1 = p.lon * D2R;
    const f2 = Math.asin(Math.sin(f1) * Math.cos(dr) + Math.cos(f1) * Math.sin(dr) * Math.cos(th));
    const l2 = l1 + Math.atan2(Math.sin(th) * Math.sin(dr) * Math.cos(f1), Math.cos(dr) - Math.sin(f1) * Math.sin(f2));
    return { lat: f2 / D2R, lon: ((l2 / D2R + 540) % 360) - 180 };
  }

  // ------------------------------------------------------------ formatting
  function fmt(ms) {
    if (!Number.isFinite(ms)) return '-:--.---';
    const neg = ms < 0; ms = Math.abs(Math.round(ms));
    const m = Math.floor(ms / 60000), s = Math.floor(ms / 1000) % 60, r = ms % 1000;
    return (neg ? '-' : '') + m + ':' + String(s).padStart(2, '0') + '.' + String(r).padStart(3, '0');
  }
  const fmtDelta = (ms) => Number.isFinite(ms) ? (ms < 0 ? '−' : '+') + (Math.abs(ms) / 1000).toFixed(3) : '';
  const fmtDist = (m) => m >= 1000 ? (m / 1000).toFixed(1) + ' km' : Math.max(0, Math.round(m)) + ' m';
  const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64) || 'course';

  // ---------------------------------------------------------------- course
  const Course = {
    normalize(c) {
      if (!c || !Array.isArray(c.gates) || c.gates.length < 2) throw new Error('A course needs at least 2 gates.');
      if (c.gates.length > 201) throw new Error('A course can have at most 201 gates.');
      const gates = c.gates.map((g, i) => {
        const o = { lat: +g.lat, lon: +g.lon, alt: +g.alt, radius: +(g.radius ?? CONFIG.DEFAULT_RADIUS_M) };
        if (![o.lat, o.lon, o.alt, o.radius].every(Number.isFinite) || Math.abs(o.lat) > 90 ||
            Math.abs(o.lon) > 180 || o.radius <= 0 || o.radius > 5000) throw new Error('Gate ' + i + ' is invalid.');
        return o;
      });
      const name = String(c.name || 'Untitled course').slice(0, 48);
      return { id: slug(c.id || name), name, version: +c.version || 1,
        aircraftId: c.aircraftId != null && c.aircraftId !== '' ? String(c.aircraftId) : null, gates };
    },
    hash(c) { // FNV-1a over geometry + aircraft rule: same hash = same race
      const s = JSON.stringify([c.aircraftId, c.gates.map((g) => [g.lat.toFixed(6), g.lon.toFixed(6), g.alt.toFixed(1), g.radius.toFixed(1)])]);
      let h = 0x811c9dc5;
      for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
      return (h >>> 0).toString(16).padStart(8, '0');
    },
    length(c) {
      let t = 0;
      for (let i = 1; i < c.gates.length; i++) {
        const a = c.gates[i - 1], b = c.gates[i];
        t += vlen(sub(ecef(a.lat, a.lon, a.alt), ecef(b.lat, b.lon, b.alt)));
      }
      return t;
    },
  };

  // ------------------------------------------------------ gate rendering
  function makeGateLayer(kind) {
    const layer = { ents: [], ok: true };
    const colors = () => ({
      next: Cesium.Color.fromCssColorString('#5be38f').withAlpha(0.35),
      after: Cesium.Color.fromCssColorString('#ff8a3d').withAlpha(0.25),
      later: Cesium.Color.WHITE.withAlpha(0.12),
      draft: Cesium.Color.fromCssColorString('#ff3d8b').withAlpha(0.3),
    });
    layer.clear = () => {
      if (!layer.ents.length) return;
      try { const v = G.viewer(); for (const e of layer.ents) { v.entities.remove(e.ball); v.entities.remove(e.pole); } } catch (_) {}
      layer.ents = [];
    };
    layer.draw = (gates) => {
      layer.clear();
      if (!G.ready()) return;
      try {
        const v = G.viewer(), C = colors(), n = gates.length;
        gates.forEach((g, i) => {
          const alt = g.alt + CONFIG.ALT_OFFSET_M;
          const text = kind === 'draft' ? 'Draft ' + (i + 1) : i === 0 ? 'Start' : i === n - 1 ? 'Finish' : 'Gate ' + i;
          const ball = v.entities.add({
            position: Cesium.Cartesian3.fromDegrees(g.lon, g.lat, alt),
            ellipsoid: { radii: new Cesium.Cartesian3(g.radius, g.radius, g.radius), material: kind === 'draft' ? C.draft : C.later },
            label: { text, font: 'bold 18px "Trebuchet MS", sans-serif', fillColor: Cesium.Color.WHITE,
              outlineColor: Cesium.Color.BLACK, outlineWidth: 3, style: Cesium.LabelStyle.FILL_AND_OUTLINE,
              pixelOffset: new Cesium.Cartesian2(0, -24), disableDepthTestDistance: Number.POSITIVE_INFINITY },
          });
          const pole = v.entities.add({
            polyline: { positions: Cesium.Cartesian3.fromDegreesArrayHeights([g.lon, g.lat, alt - g.radius, g.lon, g.lat, 0]),
              width: 2, material: Cesium.Color.WHITE.withAlpha(0.35) },
          });
          layer.ents.push({ ball, pole });
        });
        layer.ok = true;
      } catch (e) {
        layer.ok = false;
        console.warn('[finsRace] gate rendering unavailable; HUD still works', e);
      }
    };
    layer.highlight = (next) => {
      if (!layer.ok || kind === 'draft') return;
      const C = colors();
      layer.ents.forEach((e, i) => {
        const show = i >= next;
        e.ball.show = show; e.pole.show = show;
        if (show) e.ball.ellipsoid.material = i === next ? C.next : i === next + 1 ? C.after : C.later;
      });
    };
    return layer;
  }
  const RaceGates = makeGateLayer('race');
  const DraftGates = makeGateLayer('draft');

  // ----------------------------------------------------------- race engine
  // States: idle (no course) → armed → running → finished | dq. Reset returns to armed.
  // Start = leaving the start sphere (standing or flying start). Other gates = first frame the
  // flight path passes within the radius (time interpolated to closest approach within that frame,
  // which is effectively first contact at normal frame rates). Finish = contact with the last gate.
  const Race = {
    course: null, hash: '', lengthM: 0, centers: [],
    state: 'idle', next: 0, elapsed: 0, splits: [], finalMs: null, dqReason: '',
    prev: null, prevT: 0, chk: null, chkT: 0, wasInStart: false,
    listeners: [],
    on(fn) { this.listeners.push(fn); },
    emit(ev, data) { for (const fn of this.listeners) { try { fn(ev, data); } catch (e) { console.error('[finsRace]', e); } } },

    load(raw) {
      const c = Course.normalize(raw);
      this.course = c;
      this.hash = Course.hash(c);
      this.lengthM = Course.length(c);
      this.centers = c.gates.map((g) => ecef(g.lat, g.lon, g.alt));
      RaceGates.draw(c.gates);
      this.reset();
      this.emit('load', c);
      return c;
    },
    unload() { this.course = null; RaceGates.clear(); this.state = 'idle'; this.emit('reset'); },
    reset() {
      this.state = this.course ? 'armed' : 'idle';
      this.next = 0; this.elapsed = 0; this.splits = []; this.finalMs = null; this.dqReason = '';
      this.chk = null; this.wasInStart = false;
      if (this.course) {
        RaceGates.highlight(0);
        if (this.prev) this.wasInStart = vlen(sub(this.prev, this.centers[0])) <= this.course.gates[0].radius;
      }
      this.emit('reset');
    },
    dq(reason) {
      this.state = 'dq'; this.dqReason = reason;
      RaceGates.highlight(this.course.gates.length);
      this.emit('dq', reason);
    },

    tick(now) {
      if (!G.ready()) return;
      const p = G.lla();
      if (![p.lat, p.lon, p.alt].every(Number.isFinite)) return;
      const e = ecef(p.lat, p.lon, p.alt);
      const paused = G.paused();
      const prev = this.prev, prevT = this.prevT, dt = prev ? Math.max(0, now - prevT) : 0;
      this.prev = e; this.prevT = now;
      this.pos = p;
      if (!prev || !this.course) return;

      // Speed sanity: distance over max(elapsed, 250 ms) so frame jitter can't false-trigger,
      // checked every frame and before gate detection so a teleport can't score gates.
      if (this.state === 'running') {
        if (paused) {
          this.chk = null;
          if (vlen(sub(e, prev)) > CONFIG.PAUSE_MOVE_TOLERANCE_M) return this.dq('Aircraft moved while paused');
        } else {
          if (!this.chk) { this.chk = prev; this.chkT = prevT; }
          const span = now - this.chkT;
          const v = vlen(sub(e, this.chk)) / (Math.max(span, 250) / 1000);
          if (v > CONFIG.MAX_SPEED_MS) return this.dq('Position jumped (' + Math.round(v) + ' m/s)');
          if (span >= 250) { this.chk = e; this.chkT = now; }
        }
      }
      if (paused) return;
      if (this.state === 'running') this.elapsed += dt;
      if (this.state === 'armed') {
        const jumped = vlen(sub(e, prev)) / (Math.max(dt, 250) / 1000) > CONFIG.MAX_SPEED_MS;
        this.detectStart(prev, e, dt, jumped);
      }
      if (this.state === 'running') this.detectGates(prev, e, dt, this.minT || 0);
      this.minT = 0;
    },

    detectStart(p0, p1, dt, jumped) {
      const c = this.centers[0], r = this.course.gates[0].radius;
      const d0 = vlen(sub(p0, c)), d1 = vlen(sub(p1, c));
      const inside = d1 <= r;
      if (jumped) { this.wasInStart = inside; return; }   // repositioning never counts as a start
      let after = -1, t = 0;
      if (this.wasInStart && !inside) {                 // left the sphere
        t = d1 > d0 ? Math.min(1, Math.max(0, (r - d0) / (d1 - d0))) : 1;
        after = (1 - t) * dt;
      } else if (!this.wasInStart && !inside) {         // flew clean through it inside one frame
        const th = segHit(p0, p1, c, r);
        if (th >= 0) { t = th; after = (1 - th) * dt; }
      }
      this.wasInStart = inside;
      if (after < 0) return;
      const req = this.course.aircraftId;
      if (req && G.aircraftId() !== req) return this.dq('This course requires aircraft id ' + req);
      this.state = 'running'; this.elapsed = after; this.next = 1; this.chk = null; this.minT = t;
      RaceGates.highlight(1);
      this.emit('start');
    },

    detectGates(p0, p1, dt, minT) {
      const gates = this.course.gates;
      for (let guard = 0; guard < 8 && this.state === 'running'; guard++) {
        const i = this.next;
        const t = segHit(p0, p1, this.centers[i], gates[i].radius);
        if (t < 0 || t < minT) return;
        minT = t;
        const at = Math.max(0, Math.round(this.elapsed - (1 - t) * dt));
        this.splits.push(at);
        this.next++;
        if (this.next >= gates.length) {
          this.state = 'finished'; this.finalMs = at;
          RaceGates.highlight(gates.length);
          this.emit('finish', at);
          return;
        }
        RaceGates.highlight(this.next);
        this.emit('gate', { index: i, at });
      }
    },
  };

  // ----------------------------------------------------- personal bests
  const Best = {
    get(hash) { return store.get('best', {})[hash] || null; },
    offer(hash, ms, splits) {
      const all = store.get('best', {}), cur = all[hash];
      if (cur && cur.ms <= ms) return false;
      all[hash] = { ms, splits: splits.slice(), at: Date.now() };
      store.set('best', all);
      return true;
    },
  };

  // --------------------------------------------------------- leaderboard
  const LB = {
    enabled: () => !!CONFIG.API_BASE,
    async submit(payload) {
      const r = await fetch(CONFIG.API_BASE.replace(/\/$/, '') + '/runs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.detail ? JSON.stringify(body.detail).slice(0, 160) : 'HTTP ' + r.status);
      return body;
    },
    async top(hash, limit = 10) {
      const r = await fetch(CONFIG.API_BASE.replace(/\/$/, '') + '/leaderboard?course_hash=' + hash + '&limit=' + limit);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    },
  };

  // --------------------------------------------------------------- courses
  const Courses = {
    remote: [],
    local() { return store.get('courses', {}); },
    saveLocal(c) { const all = this.local(); all[c.id] = c; store.set('courses', all); },
    deleteLocal(id) { const all = this.local(); delete all[id]; store.set('courses', all); },
    async refreshRemote() {
      try {
        const r = await fetch(CONFIG.COURSE_BASE + 'index.json?t=' + Date.now());
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const list = await r.json();
        this.remote = Array.isArray(list) ? list.filter((x) => x && x.file && x.name) : [];
      } catch (e) {
        this.remote = [];
        console.warn('[finsRace] shared course list unavailable', e);
      }
    },
    async fetchRemote(file) {
      const r = await fetch(CONFIG.COURSE_BASE + encodeURIComponent(file) + '?t=' + Date.now());
      if (!r.ok) throw new Error('Could not download ' + file + ' (HTTP ' + r.status + ')');
      return r.json();
    },
  };

  // ------------------------------------------------ model swap (Cesium adapter section)
  // Everything that touches Cesium/GeoFS primitives for model swapping lives here, same
  // rule as makeGateLayer. Real aircraft/multiplayer property names are unverified — see
  // the TODO-PROBE methods on G above and race/tools/probe.js.
  async function loadModelUrl(url) {
    if (!G.ready()) throw new Error('GeoFS not ready');
    if (!(window.Cesium && Cesium.Model)) throw new Error('Cesium.Model unavailable');
    let model;
    if (typeof Cesium.Model.fromGltfAsync === 'function') model = await Cesium.Model.fromGltfAsync({ url });
    else if (typeof Cesium.Model.fromGltf === 'function') model = Cesium.Model.fromGltf({ url });
    else throw new Error('Cesium.Model.fromGltf(Async) unavailable');
    const scene = G.scene();
    if (!scene) throw new Error('viewer.scene unavailable');
    scene.primitives.add(model);
    return model;
  }
  function destroyModel(model) {
    try { const scene = G.scene(); if (scene) scene.primitives.remove(model); } catch (_) {}
  }
  function applyModelTransform(model, lat, lon, alt, heading, pitch, roll, offset, scale) {
    const off = offset || {};
    const pos = Cesium.Cartesian3.fromDegrees(lon, lat, alt);
    const hpr = new Cesium.HeadingPitchRoll(
      Cesium.Math.toRadians((heading || 0) + (off.headingDeg || 0)),
      Cesium.Math.toRadians((pitch || 0) + (off.pitchDeg || 0)),
      Cesium.Math.toRadians((roll || 0) + (off.rollDeg || 0)));
    model.modelMatrix = Cesium.Transforms.headingPitchRollToFixedFrame(pos, hpr);
    if (Number.isFinite(scale)) model.scale = scale;
  }

  const ModelSwap = {
    index: [], byId: {}, assignments: {}, ready: false, status: '',
    mine: { entry: null, model: null, enabled: false, hideInCockpit: false, loading: false },
    others: new Map(), // callsign-derived id -> { model, entry, node, loading }
    lastScan: 0,

    async init() {
      try {
        const [idx, asn] = await Promise.all([
          fetch(CONFIG.MODEL_BASE + 'index.json?t=' + Date.now()).then((r) => (r.ok ? r.json() : [])).catch(() => []),
          fetch(CONFIG.MODEL_BASE + 'assignments.json?t=' + Date.now()).then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
        ]);
        this.index = Array.isArray(idx) ? idx.filter((m) => m && m.id && m.file) : [];
        this.byId = Object.fromEntries(this.index.map((m) => [m.id, m]));
        this.assignments = {};
        if (asn && typeof asn === 'object') {
          for (const [k, v] of Object.entries(asn)) if (!k.startsWith('_') && this.byId[v]) this.assignments[k] = v;
        }
        this.ready = true;
      } catch (e) { this.status = 'Model list unavailable: ' + e.message; }
    },

    urlFor(entry) { return CONFIG.MODEL_BASE + entry.file; },
    defaultModelId() { const cs = G.callsign(); return (cs && this.assignments[cs]) || ''; },

    async enable(modelId) {
      const entry = this.byId[modelId];
      if (!entry) { await this.disable(); return; }
      this.mine.loading = true;
      try {
        const model = await loadModelUrl(this.urlFor(entry));
        await this._disposeMine();
        this.mine.entry = entry; this.mine.model = model; this.mine.enabled = true;
        window.__finsModel = modelId;
        this.status = '';
      } catch (e) {
        this.mine.enabled = false;
        this.status = 'Could not load ' + modelId + ' (' + e.message + '); flying stock.';
      } finally { this.mine.loading = false; }
    },
    async disable() {
      await this._disposeMine();
      this.mine.enabled = false; this.mine.entry = null;
      window.__finsModel = '';
      this._setStockHidden(false);
    },
    async _disposeMine() {
      if (this.mine.model) destroyModel(this.mine.model);
      this.mine.model = null;
    },
    setHideInCockpit(v) { this.mine.hideInCockpit = !!v; },
    _setStockHidden(hidden) {
      for (const n of G.stockAircraftNodes()) { try { G.setShow(n, !hidden); } catch (_) {} }
    },

    // Called once per animation frame; never throws (falls back to stock + status message).
    tick(now) {
      this._tickMine();
      if (now - this.lastScan > 1000) { this.lastScan = now; this._scanOthers(); }
      this._tickOthersTransforms();
    },
    _tickMine() {
      if (!this.mine.enabled || !this.mine.model) return;
      try {
        if (!G.ready()) return;
        const p = G.lla();
        if (![p.lat, p.lon, p.alt].every(Number.isFinite)) return;
        applyModelTransform(this.mine.model, p.lat, p.lon, p.alt, G.heading(), G.pitch(), G.roll(), this.mine.entry.offset, this.mine.entry.scale);
        this.mine.model.show = !(this.mine.hideInCockpit && G.isCockpitView());
        this._setStockHidden(true);
      } catch (e) {
        this.status = 'Model update failed (' + e.message + '); flying stock.';
        this._disposeMine(); this.mine.enabled = false; this._setStockHidden(false);
      }
    },
    // Returns a promise (resolves once any newly-seen users have finished loading) so tests
    // can await it; tick() itself fires this and forgets, since the next frame will retry.
    _scanOthers() {
      try {
        if (!this.ready) return Promise.resolve();
        const users = G.multiplayerUsers();
        const seen = new Set();
        const spawns = [];
        for (const u of users) {
          const modelId = this.assignments[u.callsign];
          if (!modelId) continue;
          seen.add(u.id);
          const rec = this.others.get(u.id);
          if (rec && rec.modelId === modelId) continue;
          if (rec) this._removeOther(u.id);
          spawns.push(this._spawnOther(u, modelId));
        }
        for (const id of Array.from(this.others.keys())) if (!seen.has(id)) this._removeOther(id);
        return Promise.all(spawns);
      } catch (_) { return Promise.resolve(); }
    },
    async _spawnOther(u, modelId) {
      const entry = this.byId[modelId];
      if (!entry) return;
      const placeholder = { model: null, modelId, entry, node: u.node, loading: true };
      this.others.set(u.id, placeholder);
      try {
        const model = await loadModelUrl(this.urlFor(entry));
        if (this.others.get(u.id) !== placeholder) { destroyModel(model); return; } // left/reassigned mid-load
        placeholder.model = model; placeholder.loading = false;
        if (u.node) { try { G.setShow(u.node, false); } catch (_) {} }
      } catch (_) { this.others.delete(u.id); }
    },
    _removeOther(id) {
      const rec = this.others.get(id);
      if (!rec) return;
      if (rec.model) destroyModel(rec.model);
      if (rec.node) { try { G.setShow(rec.node, true); } catch (_) {} }
      this.others.delete(id);
    },
    _tickOthersTransforms() {
      if (!this.others.size) return;
      try {
        const byId = new Map(G.multiplayerUsers().map((u) => [u.id, u]));
        for (const [id, rec] of this.others) {
          if (rec.loading || !rec.model) continue;
          const u = byId.get(id);
          if (!u) continue;
          applyModelTransform(rec.model, u.lat, u.lon, u.alt, u.heading, u.pitch, u.roll, rec.entry.offset, rec.entry.scale);
          if (u.node && u.node !== rec.node) { rec.node = u.node; try { G.setShow(u.node, false); } catch (_) {} }
        }
      } catch (_) {}
    },
  };

  // ------------------------------------------------------------------- UI
  const h = (tag, attrs, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null) continue;
      if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v);
    }
    for (const kid of kids) if (kid != null) el.append(kid);
    return el;
  };

  const CSS = `
#fr-root{--plum:#1d1029;--plum2:#2c1a3d;--sun:#ff8a3d;--pink:#ff3d8b;--cream:#fff4ea;--dim:#b9a6c8;--fast:#5be38f;--slow:#ff6b6b;
  position:fixed;top:72px;right:16px;width:300px;z-index:100000;color:var(--cream);
  font:13px/1.4 "Trebuchet MS","Segoe UI",system-ui,sans-serif;background:rgba(29,16,41,.9);
  border:1px solid rgba(255,138,61,.35);border-radius:14px;box-shadow:0 10px 30px rgba(10,0,20,.5);
  backdrop-filter:blur(6px);user-select:none}
#fr-root.fr-hidden{display:none}
#fr-root *{box-sizing:border-box}
#fr-head{display:flex;align-items:center;gap:8px;padding:9px 12px;cursor:move;border-bottom:1px solid rgba(255,255,255,.08)}
#fr-head b{font-size:13px;letter-spacing:.02em;background:linear-gradient(90deg,var(--sun),var(--pink));-webkit-background-clip:text;background-clip:text;color:transparent}
#fr-head small{color:var(--dim);flex:1}
#fr-body{padding:10px 12px 12px}
#fr-root.fr-min #fr-body{display:none}
.fr-row{display:flex;gap:6px;align-items:center;margin:6px 0}
.fr-row>select,.fr-row>input{flex:1;min-width:0}
#fr-root select,#fr-root input,#fr-root textarea{background:var(--plum2);color:var(--cream);border:1px solid rgba(255,255,255,.14);
  border-radius:8px;padding:5px 7px;font:inherit}
#fr-root textarea{width:100%;height:64px;resize:vertical;font-size:11px}
#fr-root button{background:var(--plum2);color:var(--cream);border:1px solid rgba(255,255,255,.18);border-radius:8px;
  padding:5px 9px;font:inherit;cursor:pointer;white-space:nowrap}
#fr-root button:hover{border-color:var(--sun)}
#fr-root button.fr-go{background:linear-gradient(90deg,var(--sun),var(--pink));border:0;color:#240a1f;font-weight:bold}
#fr-root button:focus-visible,#fr-root input:focus-visible,#fr-root select:focus-visible,#fr-root summary:focus-visible{outline:2px solid var(--sun);outline-offset:1px}
#fr-root kbd{font:inherit;font-size:11px;color:var(--dim)}
#fr-timer{font-size:40px;font-weight:bold;line-height:1.05;font-variant-numeric:tabular-nums;margin-top:6px;
  background:linear-gradient(90deg,var(--sun),var(--pink));-webkit-background-clip:text;background-clip:text;color:transparent}
#fr-timer.fr-dq{background:none;color:var(--slow)}
#fr-nav{display:flex;gap:12px;align-items:center;font-variant-numeric:tabular-nums}
#fr-arrow{display:inline-block;width:22px;text-align:center;font-size:18px;color:var(--fast);transition:transform .1s linear}
#fr-status{color:var(--dim);margin:4px 0 2px;min-height:18px}
#fr-splits{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums;margin-top:6px}
#fr-splits td{padding:1px 0}
#fr-splits td:nth-child(2),#fr-splits td:nth-child(3){text-align:right}
.fr-fast{color:var(--fast)}.fr-slow{color:var(--slow)}.fr-dim{color:var(--dim)}
#fr-root details{margin-top:10px;border-top:1px solid rgba(255,255,255,.08);padding-top:6px}
#fr-root summary{cursor:pointer;color:var(--cream)}
#fr-lb{margin:6px 0 0;padding-left:20px;font-variant-numeric:tabular-nums}
#fr-lb li span{float:right}
#fr-banner{position:fixed;left:50%;top:22%;transform:translateX(-50%);z-index:100001;pointer-events:none;
  font:bold 56px/1 "Trebuchet MS",system-ui,sans-serif;color:var(--cream,#fff4ea);text-shadow:0 3px 0 #ff3d8b,0 6px 18px rgba(0,0,0,.6);
  opacity:0;transition:opacity .25s;text-align:center;white-space:nowrap}
#fr-banner small{display:block;font-size:22px;margin-top:8px}
#fr-banner.fr-show{opacity:1}
@media (prefers-reduced-motion:reduce){#fr-banner,#fr-arrow{transition:none}}
@media (max-width:520px){#fr-root{width:calc(100vw - 24px);right:12px}}
`;

  const UI = {
    E: {}, lastHud: 0, bannerTimer: 0,

    init() {
      document.head.append(h('style', { id: 'fr-style', text: CSS }));
      const E = this.E;
      const btn = (text, onclick, cls, title) => h('button', { type: 'button', class: cls, title, onclick, text });

      E.select = h('select', { 'aria-label': 'Course' });
      E.timer = h('div', { id: 'fr-timer', text: fmt(NaN), 'aria-live': 'off' });
      E.gate = h('span');
      E.arrow = h('span', { id: 'fr-arrow', text: '▲', 'aria-hidden': 'true' });
      E.dist = h('span');
      E.vert = h('span');
      E.speed = h('span', { class: 'fr-dim' });
      E.status = h('div', { id: 'fr-status', 'aria-live': 'polite', text: 'Waiting for GeoFS to finish loading…' });
      E.splits = h('table', { id: 'fr-splits' });
      E.best = h('div', { class: 'fr-dim' });

      // leaderboard
      E.callsign = h('input', { placeholder: 'Your name on the board', maxlength: '32', value: store.get('callsign', '') });
      E.callsign.addEventListener('change', () => store.set('callsign', E.callsign.value.trim()));
      E.autosub = h('input', { type: 'checkbox', id: 'fr-autosub' });
      E.autosub.checked = store.get('autosubmit', true);
      E.autosub.addEventListener('change', () => store.set('autosubmit', E.autosub.checked));
      E.lb = h('ol', { id: 'fr-lb' });
      E.lbMsg = h('div', { class: 'fr-dim' });

      // your plane (model swap)
      E.modelSelect = h('select', { 'aria-label': 'Joke plane model' });
      E.modelEnabled = h('input', { type: 'checkbox', id: 'fr-model-enabled' });
      E.modelHide = h('input', { type: 'checkbox', id: 'fr-model-hide' });
      E.modelStatus = h('div', { class: 'fr-dim' });
      const onModelChange = () => this.applyModelSelection();
      E.modelSelect.addEventListener('change', onModelChange);
      E.modelEnabled.addEventListener('change', onModelChange);
      E.modelHide.addEventListener('change', () => {
        store.set('modelHideCockpit', E.modelHide.checked);
        ModelSwap.setHideInCockpit(E.modelHide.checked);
      });

      // editor
      E.edName = h('input', { placeholder: 'Course name', maxlength: '48' });
      E.edRadius = h('input', { type: 'number', min: '20', max: '5000', step: '10', value: String(CONFIG.DEFAULT_RADIUS_M), style: 'max-width:80px', 'aria-label': 'Gate radius in meters' });
      E.edAircraft = h('input', { type: 'checkbox', id: 'fr-lockac' });
      E.edInfo = h('div', { class: 'fr-dim', text: 'No draft gates yet.' });
      E.edJson = h('textarea', { placeholder: 'Paste course JSON here to import', spellcheck: 'false' });

      const head = h('div', { id: 'fr-head' },
        h('b', { text: 'FINSONLY Racing' }), h('small', { text: 'v' + CONFIG.VERSION }),
        btn('–', () => this.minimize(), null, 'Minimize (Alt+H hides)'));

      const body = h('div', { id: 'fr-body' },
        h('div', { class: 'fr-row' }, E.select, btn('Load', () => this.loadSelected(), 'fr-go'),
          btn('↻', () => this.refreshCourses(), null, 'Refresh shared courses')),
        E.timer,
        h('div', { id: 'fr-nav' }, E.gate, h('span', null, E.arrow, ' ', E.dist), E.vert, E.speed),
        E.status,
        h('div', { class: 'fr-row' }, btn('Reset run', () => Race.reset(), null, 'Alt+R'), h('kbd', { text: 'Alt+R' }),
          h('span', { style: 'flex:1' }), E.best),
        E.splits,
        h('details', null, h('summary', { text: 'Leaderboard' }),
          h('div', { class: 'fr-row' }, E.callsign),
          h('div', { class: 'fr-row' }, E.autosub, h('label', { for: 'fr-autosub', text: 'Submit finished runs automatically' })),
          h('div', { class: 'fr-row' }, btn('Refresh board', () => this.refreshBoard())),
          E.lbMsg, E.lb),
        h('details', { id: 'fr-model' }, h('summary', { text: 'Your plane' }),
          h('div', { class: 'fr-row' }, E.modelSelect),
          h('div', { class: 'fr-row' }, E.modelEnabled, h('label', { for: 'fr-model-enabled', text: 'Show joke model (physics stay F-16)' })),
          h('div', { class: 'fr-row' }, E.modelHide, h('label', { for: 'fr-model-hide', text: 'Hide in cockpit view' })),
          E.modelStatus),
        (E.editor = h('details', { id: 'fr-editor' }, h('summary', { text: 'Course editor' }),
          h('div', { class: 'fr-row' }, E.edName),
          h('div', { class: 'fr-row' }, h('label', { text: 'Gate radius (m)' }), E.edRadius),
          h('div', { class: 'fr-row' }, E.edAircraft, h('label', { for: 'fr-lockac', text: 'Require my current aircraft' })),
          h('div', { class: 'fr-row' }, btn('Drop gate here', () => Editor.drop(), 'fr-go', 'Alt+G'),
            btn('Undo', () => Editor.undo(), null, 'Alt+U'), btn('Clear', () => Editor.clear())),
          h('div', { class: 'fr-row' }, h('kbd', { text: 'Alt+G drop · Alt+U undo' })),
          h('div', { class: 'fr-row' }, btn('Build test course ahead of me', () => Editor.testAhead())),
          E.edInfo,
          h('div', { class: 'fr-row' }, btn('Save and load', () => Editor.saveAndLoad(), 'fr-go'),
            btn('Copy JSON', () => Editor.copy()), btn('Delete saved', () => Editor.deleteSelected())),
          E.edJson,
          h('div', { class: 'fr-row' }, btn('Import JSON', () => Editor.importJson())))));

      E.root = h('div', { id: 'fr-root', role: 'region', 'aria-label': 'FINSONLY Racing' }, head, body);
      E.banner = h('div', { id: 'fr-banner', 'aria-live': 'assertive' });
      document.body.append(E.root, E.banner);

      // Keep typing in our inputs from flying the plane.
      for (const t of ['keydown', 'keyup', 'keypress']) E.root.addEventListener(t, (ev) => ev.stopPropagation());
      this.makeDraggable(head);
      const pos = store.get('panelPos', null);
      if (pos) Object.assign(E.root.style, { left: pos.left, top: pos.top, right: 'auto' });
      if (store.get('minimized', false)) E.root.classList.add('fr-min');

      this.renderBoardState();
      this.renderCourses();
    },

    makeDraggable(handle) {
      let sx, sy, ox, oy, dragging = false;
      handle.addEventListener('mousedown', (e) => {
        if (e.target.tagName === 'BUTTON') return;
        const r = this.E.root.getBoundingClientRect();
        dragging = true; sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
        e.preventDefault(); e.stopPropagation();
      });
      window.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        const left = Math.max(0, Math.min(window.innerWidth - 60, ox + e.clientX - sx));
        const top = Math.max(0, Math.min(window.innerHeight - 30, oy + e.clientY - sy));
        Object.assign(this.E.root.style, { left: left + 'px', top: top + 'px', right: 'auto' });
      });
      window.addEventListener('mouseup', () => {
        if (!dragging) return;
        dragging = false;
        store.set('panelPos', { left: this.E.root.style.left, top: this.E.root.style.top });
      });
    },

    toggle(force) { const hide = force === undefined ? !this.E.root.classList.contains('fr-hidden') : !force; this.E.root.classList.toggle('fr-hidden', hide); },
    minimize() { const m = this.E.root.classList.toggle('fr-min'); store.set('minimized', m); },

    banner(text, sub, ms = 2500) {
      const b = this.E.banner;
      b.textContent = text;
      if (sub) b.append(h('small', { text: sub }));
      b.classList.add('fr-show');
      clearTimeout(this.bannerTimer);
      this.bannerTimer = setTimeout(() => b.classList.remove('fr-show'), ms);
    },
    status(text) { this.E.status.textContent = text; },

    // ---- courses
    renderCourses(selectValue) {
      const s = this.E.select, keep = selectValue ?? s.value;
      s.textContent = '';
      s.append(h('option', { value: '', text: 'Choose a course' }));
      const local = Object.values(Courses.local());
      if (local.length) {
        const g = h('optgroup', { label: 'Saved on this computer' });
        local.sort((a, b) => a.name.localeCompare(b.name)).forEach((c) => g.append(h('option', { value: 'l:' + c.id, text: c.name })));
        s.append(g);
      }
      if (Courses.remote.length) {
        const g = h('optgroup', { label: 'Shared courses' });
        Courses.remote.forEach((c) => g.append(h('option', { value: 'r:' + c.file, text: c.name })));
        s.append(g);
      }
      if ([...s.options].some((o) => o.value === keep)) s.value = keep;
    },
    async refreshCourses() {
      await Courses.refreshRemote();
      this.renderCourses();
      this.status(Courses.remote.length ? Courses.remote.length + ' shared courses available.' : 'No shared courses found. Saved courses still work.');
    },
    async loadSelected() {
      const v = this.E.select.value;
      if (!v) return this.status('Choose a course first.');
      if (!G.ready()) return this.status('GeoFS is still loading. Try again in a moment.');
      try {
        const raw = v.startsWith('l:') ? Courses.local()[v.slice(2)] : await Courses.fetchRemote(v.slice(2));
        if (!raw) throw new Error('That saved course no longer exists.');
        const c = Race.load(raw);
        store.set('lastCourse', v);
        this.status('Loaded ' + c.name + ' (' + fmtDist(Race.lengthM) + ', ' + c.gates.length + ' gates). Leave the start sphere to begin.');
      } catch (e) { this.status('Could not load course: ' + e.message); }
    },

    // ---- live readout
    hud(now, force) {
      if (!force && now - this.lastHud < 1000 / CONFIG.HUD_HZ) return;
      if (!force) this.lastHud = now;
      const E = this.E, r = Race, c = r.course;
      const kias = G.ready() ? G.kias() : null;
      E.speed.textContent = kias != null ? Math.round(kias) + ' kt' : '';
      if (!c) { E.gate.textContent = ''; E.dist.textContent = ''; E.vert.textContent = ''; E.arrow.style.visibility = 'hidden'; return; }

      const n = c.gates.length;
      if (r.state === 'running') E.timer.textContent = fmt(r.elapsed);
      else if (r.state === 'finished') E.timer.textContent = fmt(r.finalMs);
      else if (r.state === 'armed') E.timer.textContent = fmt(0);
      E.timer.classList.toggle('fr-dq', r.state === 'dq');
      if (r.state === 'dq') E.timer.textContent = 'DQ';

      const idx = r.state === 'armed' ? 0 : r.next;
      E.gate.textContent = r.state === 'finished' || r.state === 'dq' ? 'Done' : idx === 0 ? 'Start' : idx === n - 1 ? 'Finish' : 'Gate ' + idx + '/' + (n - 2);

      if (r.pos && idx < n && (r.state === 'armed' || r.state === 'running')) {
        const g = c.gates[idx];
        const d = vlen(sub(ecef(r.pos.lat, r.pos.lon, r.pos.alt), r.centers[idx])) - g.radius;
        E.dist.textContent = d <= 0 ? 'inside' : fmtDist(d);
        const dz = g.alt - r.pos.alt;
        E.vert.textContent = Math.abs(dz) < g.radius * 0.5 ? 'level' : (dz > 0 ? '↑ ' : '↓ ') + fmtDist(Math.abs(dz));
        const hd = G.heading();
        if (hd == null) E.arrow.style.visibility = 'hidden';
        else {
          E.arrow.style.visibility = 'visible';
          E.arrow.style.transform = 'rotate(' + Math.round(bearingDeg(r.pos, g) - hd) + 'deg)';
        }
      } else { E.dist.textContent = ''; E.vert.textContent = ''; E.arrow.style.visibility = 'hidden'; }
    },

    renderSplits() {
      const t = this.E.splits, c = Race.course;
      t.textContent = '';
      if (!c) { this.E.best.textContent = ''; return; }
      const best = Best.get(Race.hash);
      this.E.best.textContent = best ? 'Best ' + fmt(best.ms) : 'No best yet';
      const n = c.gates.length;
      Race.splits.forEach((ms, i) => {
        const label = i + 1 === n - 1 ? 'Finish' : 'Gate ' + (i + 1);
        const ref = best && best.splits[i];
        const d = Number.isFinite(ref) ? ms - ref : NaN;
        t.append(h('tr', null, h('td', { text: label }), h('td', { text: fmt(ms) }),
          h('td', { class: Number.isFinite(d) ? (d <= 0 ? 'fr-fast' : 'fr-slow') : 'fr-dim', text: fmtDelta(d) })));
      });
    },

    // ---- leaderboard
    renderBoardState() {
      const off = !LB.enabled();
      this.E.lbMsg.textContent = off ? 'The leaderboard is off. Set API_BASE at the top of race.js to turn it on.' : '';
    },
    async refreshBoard() {
      if (!LB.enabled()) return this.renderBoardState();
      if (!Race.course) { this.E.lbMsg.textContent = 'Load a course to see its board.'; return; }
      this.E.lbMsg.textContent = 'Loading…';
      try {
        const rows = await LB.top(Race.hash);
        this.E.lb.textContent = '';
        rows.forEach((row) => this.E.lb.append(h('li', null,
          document.createTextNode(row.callsign + (row.model ? ' (' + row.model + ')' : '')), h('span', { text: fmt(row.time_ms) }))));
        this.E.lbMsg.textContent = rows.length ? Race.course.name : 'No times on this course yet.';
      } catch (e) { this.E.lbMsg.textContent = 'Could not reach the leaderboard: ' + e.message; }
    },
    async submitRun() {
      if (!LB.enabled() || !this.E.autosub.checked) return;
      const name = (this.E.callsign.value || G.callsign() || '').trim().slice(0, 32);
      if (!name) { this.status('Finished. Add your name under Leaderboard to post times.'); return; }
      store.set('callsign', name);
      const c = Race.course;
      try {
        const res = await LB.submit({
          course_id: c.id, course_hash: Race.hash, course_name: c.name, callsign: name,
          aircraft_id: G.aircraftId().slice(0, 32), model: G.model(), time_ms: Race.finalMs,
          splits: Race.splits, gates: c.gates.length, length_m: Math.round(Race.lengthM), client_version: CONFIG.VERSION,
        });
        this.status('Posted. You are #' + res.rank + ' on ' + c.name + '.');
        this.refreshBoard();
      } catch (e) { this.status('Finished, but posting failed: ' + e.message); }
    },

    // ---- model swap
    renderModelOptions() {
      const s = this.E.modelSelect;
      s.textContent = '';
      s.append(h('option', { value: '', text: 'Stock F-16' }));
      ModelSwap.index.forEach((m) => s.append(h('option', { value: m.id, text: m.name })));
      const stored = store.get('modelOverride', null);
      const initial = stored != null ? stored : ModelSwap.defaultModelId();
      if ([...s.options].some((o) => o.value === initial)) s.value = initial;
      this.E.modelEnabled.checked = store.get('modelEnabled', !!initial);
      this.E.modelHide.checked = store.get('modelHideCockpit', false);
      ModelSwap.setHideInCockpit(this.E.modelHide.checked);
    },
    async applyModelSelection() {
      const id = this.E.modelSelect.value;
      const enabled = this.E.modelEnabled.checked && !!id;
      store.set('modelOverride', id);
      store.set('modelEnabled', enabled);
      this.E.modelStatus.textContent = 'Loading…';
      if (enabled) await ModelSwap.enable(id); else await ModelSwap.disable();
      const name = ModelSwap.byId[id] && ModelSwap.byId[id].name;
      this.E.modelStatus.textContent = ModelSwap.status || (enabled ? 'Flying as ' + name + '.' : 'Flying stock F-16.');
    },
  };

  // ------------------------------------------------------------- editor
  const Editor = {
    draft: [],
    update() {
      DraftGates.draw(this.draft);
      const len = this.draft.length > 1 ? Course.length({ gates: this.draft }) : 0;
      UI.E.edInfo.textContent = this.draft.length
        ? this.draft.length + ' draft gates, ' + fmtDist(len) + ' long. First is the start, last is the finish.'
        : 'No draft gates yet.';
    },
    radius() { const r = +UI.E.edRadius.value; return Number.isFinite(r) && r >= 20 && r <= 5000 ? r : CONFIG.DEFAULT_RADIUS_M; },
    drop() {
      if (!G.ready()) return UI.status('GeoFS is still loading.');
      const p = G.lla();
      this.draft.push({ lat: +p.lat.toFixed(6), lon: +p.lon.toFixed(6), alt: Math.round(p.alt), radius: this.radius() });
      UI.E.editor.open = true;
      this.update();
    },
    undo() { this.draft.pop(); this.update(); },
    clear() { this.draft = []; this.update(); },
    testAhead() {
      if (!G.ready()) return UI.status('GeoFS is still loading.');
      const p = G.lla(), hd = G.heading() ?? 0;
      this.draft = [];
      for (let i = 0; i < CONFIG.TEST_COUNT; i++) {
        const q = destination(p, hd, 300 + i * CONFIG.TEST_SPACING_M);
        this.draft.push({ lat: +q.lat.toFixed(6), lon: +q.lon.toFixed(6), alt: Math.round(p.alt), radius: this.radius() });
      }
      if (!UI.E.edName.value) UI.E.edName.value = 'Test course';
      this.update();
    },
    build() {
      const name = UI.E.edName.value.trim() || 'Untitled course';
      return Course.normalize({ id: slug(name), name, version: 1,
        aircraftId: UI.E.edAircraft.checked ? G.aircraftId() : null, gates: this.draft });
    },
    saveAndLoad() {
      try {
        const c = this.build();
        Courses.saveLocal(c);
        UI.renderCourses('l:' + c.id);
        Race.load(c);
        this.clear();
        UI.status('Saved and loaded ' + c.name + '. Copy JSON to share it.');
        UI.E.edJson.value = JSON.stringify(c, null, 1);
      } catch (e) { UI.status('Could not save: ' + e.message); }
    },
    async copy() {
      let c;
      try { c = this.draft.length ? this.build() : Race.course; } catch (e) { return UI.status(e.message); }
      if (!c) return UI.status('Nothing to copy. Load a course or drop some gates.');
      const text = JSON.stringify(c, null, 1);
      UI.E.edJson.value = text;
      try { await navigator.clipboard.writeText(text); UI.status('Copied ' + c.name + ' as JSON.'); }
      catch (_) { UI.E.edJson.select(); UI.status('Clipboard blocked. The JSON is selected in the box below; press Ctrl+C.'); }
    },
    importJson() {
      try {
        const c = Course.normalize(JSON.parse(UI.E.edJson.value));
        Courses.saveLocal(c);
        UI.renderCourses('l:' + c.id);
        Race.load(c);
        UI.status('Imported and loaded ' + c.name + '.');
      } catch (e) { UI.status('Import failed: ' + e.message); }
    },
    deleteSelected() {
      const v = UI.E.select.value;
      if (!v.startsWith('l:')) return UI.status('Pick a saved course in the list to delete it.');
      Courses.deleteLocal(v.slice(2));
      if (Race.course && Race.course.id === v.slice(2)) Race.unload();
      UI.renderCourses('');
      UI.status('Deleted.');
    },
  };

  // ------------------------------------------------------------- events
  Race.on((ev, data) => {
    if (ev === 'start') { UI.banner('Go!'); UI.status('Racing. Fly through the green sphere.'); UI.renderSplits(); }
    else if (ev === 'gate') { UI.renderSplits(); }
    else if (ev === 'reset' || ev === 'load') {
      UI.renderSplits(); UI.hud(0, true);
      if (Race.course && ev === 'reset') UI.status('Armed. Leave the start sphere to begin.');
    }
    else if (ev === 'dq') { UI.banner('DQ', data); UI.status('Disqualified: ' + data + '. Press Alt+R to try again.'); }
    else if (ev === 'finish') {
      const prevBest = Best.get(Race.hash);
      const pb = Best.offer(Race.hash, data, Race.splits);
      const sub = prevBest ? fmtDelta(data - prevBest.ms) + (pb ? ' · new best' : '') : 'First finish';
      UI.renderSplits();
      UI.banner(fmt(data), sub, 5000);
      UI.status('Finished in ' + fmt(data) + '. Press Alt+R to race again.');
      UI.submitRun();
    }
  });

  window.addEventListener('keydown', (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    const act = { KeyR: () => Race.reset(), KeyG: () => Editor.drop(), KeyU: () => Editor.undo(), KeyH: () => UI.toggle() }[e.code];
    if (!act) return;
    e.preventDefault(); e.stopImmediatePropagation();
    act();
  }, true);

  // --------------------------------------------------------------- boot
  let errors = 0;
  function loop(now) {
    try { Race.tick(now); UI.hud(now); ModelSwap.tick(now); }
    catch (e) { if (errors++ < 5) console.error('[finsRace] frame error', e); }
    requestAnimationFrame(loop);
  }

  function boot() {
    UI.init();
    const modelInit = ModelSwap.init();
    const started = performance.now();
    const wait = setInterval(async () => {
      if (G.ready()) {
        clearInterval(wait);
        UI.status('Ready. Choose a course, or build one in the course editor.');
        await UI.refreshCourses();
        const last = store.get('lastCourse', '');
        if (last) { UI.renderCourses(last); if (UI.E.select.value === last) UI.loadSelected(); }
        await modelInit;
        UI.renderModelOptions();
        if (UI.E.modelEnabled.checked && UI.E.modelSelect.value) await UI.applyModelSelection();
        requestAnimationFrame(loop);
      } else if (performance.now() - started > CONFIG.READY_TIMEOUT_MS) {
        clearInterval(wait);
        UI.status('GeoFS never finished loading, or its internals changed. Reload the page and try again.');
      }
    }, 500);
  }

  window.__finsRace = {
    version: CONFIG.VERSION, config: CONFIG, race: Race, ui: UI, editor: Editor, modelSwap: ModelSwap,
    loadCourse: (c) => Race.load(c),
    _internals: { ecef, segHit, bearingDeg, destination, Course, fmt, G },
  };
  if (document.body) boot(); else document.addEventListener('DOMContentLoaded', boot);
})();
