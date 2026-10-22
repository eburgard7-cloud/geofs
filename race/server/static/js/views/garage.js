// #/garage — the pilot's Garage on the web, over the livery API (race/server/GARAGE.md).
//
// Sign-in: the in-sim Garage shows a link code and opens #/garage?link=CODE; this page redeems it
// (POST /garage/link/redeem) for a garage_token kept in localStorage (js/garage.js). Without one it
// explains where the code comes from and takes it typed in.
//
// The page is one view with three panels picked by the query: ?ac=<aircraft> picks the tab,
// ?do=make is "Make your own" (recolor a template, POST /garage/recolor + GET /garage/jobs/{id}),
// ?do=paint is "Paint your own" (the paint kit and POST /garage/upload). Moving between panels
// pushes a history entry, so the phone's back gesture works; switching tabs replaces it.

import { garageApi } from "../api.js";
import { h, clear, toast, skeleton, chip, link } from "../ui.js";
import { loadSession, saveSession, clearSession, errText, liveryMedia, picture } from "../garage.js";

const S = () => window.FinsSite;
const POLL_MS = 2000;
const POLL_RETRIES = 5;          // network blips tolerated while a render runs
const JOB_KEY = "fins.garage.job";
const STATUS_CHIP = { pending: ["Pending", "medium"], approved: ["Approved", "easy"], rejected: ["Rejected", "hard"] };
const EXPIRED = "Your sign-in has run out (or you signed out from the sim). Get a new code from the Garage in GeoFS.";

// Plain-words paint-kit notes per uploadable aircraft (liveries/kit/README.md).
const KIT_NOTES = {
  f16: {
    format: "WebP",
    mirrored: ["The fin (both sides), the wing undersides, the leading-edge flaps and some fuselage-side strips share one patch of texture for both sides, so text there reads backwards on one side.",
      "Put text on the separate left and right fuselage parts instead, or use symbols that look the same mirrored."],
  },
  b757: {
    format: "PNG",
    mirrored: ["The engines, winglets and pylons share one patch of texture for both sides, so text there reads backwards on one side.",
      "The right side is flipped: the lower fuselage band is the right side, mirrored. Write text there backwards (flip the text layer horizontally) so it reads right on the jet."],
  },
};

function readJob() { try { return JSON.parse(sessionStorage.getItem(JOB_KEY) || "null"); } catch (_) { return null; } }
function writeJob(v) { try { if (v) sessionStorage.setItem(JOB_KEY, JSON.stringify(v)); else sessionStorage.removeItem(JOB_KEY); } catch (_) { /* per-page only */ } }

export function mount(root, route, ctx) {
  ctx.setTitle("Garage");
  const signal = ctx.signal;
  const page = h("div", { class: "page garage" });
  root.appendChild(page);
  const st = {
    route, sess: loadSession(), cat: null, templates: [], snap: null, notice: null, dialog: null,
    makes: {}, upload: null, lastDo: null, seq: 0,     // makes: aircraft -> recolor state
  };
  const timers = new Set();
  const later = (fn, ms) => { const t = setTimeout(() => { timers.delete(t); if (!signal.aborted) fn(); }, ms); timers.add(t); return t; };
  let ticker = null;

  const token = () => (st.sess ? st.sess.garage_token : "");
  const q = () => st.route.query || {};

  function go(query, push) {
    const href = S().buildRoute("garage", null, query);
    if (push) { location.hash = href; return; }            // hashchange -> onQuery -> draw()
    history.replaceState(null, "", href);
    st.route = S().parseRoute(href);
    draw();
  }

  // ---------------------------------------------------------------- sign-in
  function signedOut(msg) {
    clearSession();
    st.sess = null;
    st.snap = null;
    closeSheet();
    drawSignIn(msg);
  }
  /** A 401 from a garage write means the token is gone: back to the sign-in. */
  function authFail(e) {
    if (e && e.status === 401) { signedOut(EXPIRED); return true; }
    return false;
  }

  function intro() {
    return h("div", { class: "page-head" }, h("div", {},
      h("span", { class: "eyebrow", text: "FINSONLY liveries" }), h("h1", {}, "Garage"),
      h("p", {}, "Pick the paint everyone in the race sees on your jet, make your own from a template, or paint one from scratch.")));
  }

  function drawSignIn(msg) {
    const input = h("input", { type: "text", id: "gx-code", name: "code", autocomplete: "one-time-code", autocapitalize: "characters",
      spellcheck: "false", maxlength: "9", placeholder: "ABC123", class: "gx-code-input", "aria-describedby": "gx-code-help" });
    const err = h("p", { class: "gx-err", role: "alert", text: msg || "" });
    const btn = h("button", { type: "submit", class: "btn btn-primary" }, "Sign in");
    const form = h("form", { class: "gx-signin-form", onSubmit: (e) => {
      e.preventDefault();
      const code = S().garageNormCode(input.value);
      if (code.length < 6) { err.textContent = "The code is 6 letters and digits."; input.focus(); return; }
      btn.disabled = true;
      btn.textContent = "Signing in…";
      redeem(code);
    } },
    h("label", { for: "gx-code", class: "gx-label" }, "Link code"),
    h("div", { class: "gx-code-row" }, input, btn), err);
    input.addEventListener("input", () => { input.value = input.value.toUpperCase(); });
    clear(page).append(intro(), h("section", { class: "panel gx-signin", "aria-labelledby": "gx-signin-h" },
      h("h2", { id: "gx-signin-h" }, "Sign in with a code from the sim"),
      h("ol", { class: "steps steps-spaced" },
        h("li", {}, h("span", { class: "step-n", text: "1" }), h("p", {}, "In GeoFS: ", h("strong", {}, "FINSONLY dock → Garage → Open on web"), ".")),
        h("li", {}, h("span", { class: "step-n", text: "2" }), h("p", {}, "That opens this page signed in. On another device (your phone, say), type the 6-character code the sim shows.")),
        h("li", {}, h("span", { class: "step-n", text: "3" }), h("p", { id: "gx-code-help" }, "A code works once and lasts 5 minutes. The sign-in lasts 30 days."))),
      form));
  }

  async function redeem(code) {
    const my = ++st.seq;
    clear(page).append(intro(), h("p", { class: "state-msg", role: "status" }, "Signing you in…"));
    // A link code works once: take it out of the address bar whatever happens.
    const rest = Object.assign({}, q());
    delete rest.link;
    history.replaceState(null, "", S().buildRoute("garage", null, rest));
    st.route = S().parseRoute(location.hash);
    try {
      const r = await garageApi.redeem(S().garageNormCode(code), { signal });
      if (my !== st.seq) return;
      st.sess = { garage_token: r.garage_token, pilot_id: r.pilot_id, callsign: r.callsign, expires_at: r.expires_at };
      st.notice = saveSession(st.sess) ? null
        : "This browser won't let the site store anything, so this sign-in lasts until you close the page. You'll need a new code next visit.";
      toast("Signed in as " + r.callsign);
      await load();
    } catch (e) {
      if (signal.aborted || my !== st.seq) return;
      drawSignIn(e && e.status === 429 ? "Too many tries. Wait a minute, then try again." : errText(e));
    }
  }

  // ---------------------------------------------------------------- data
  async function load() {
    const my = ++st.seq;
    clear(page).append(head(), skeleton("cards", 4));
    let cat, templates, snap;
    try {
      [cat, templates, snap] = await Promise.all([
        garageApi.catalog({ signal }),
        garageApi.templates({ signal }).catch(() => []),
        garageApi.garage(st.sess.pilot_id, st.sess.garage_token, { signal }),
      ]);
    } catch (e) {
      if (signal.aborted || my !== st.seq) return;
      if (e && e.status === 404 && String(e.url).includes("/liveries/")) {
        clear(page).append(head(), h("p", { class: "state-msg unavailable" }, "This server doesn't have the Garage yet."));
      } else if (e && e.status === 404) {
        signedOut("That pilot isn't on this server. Get a new code from the Garage in GeoFS.");
      } else {
        clear(page).append(head(), h("p", { class: "state-msg error", role: "alert" }, errText(e) + " ",
          h("button", { type: "button", class: "btn-link", onClick: () => load() }, "Try again")));
      }
      return;
    }
    if (my !== st.seq) return;
    if (!snap.owner) { signedOut(EXPIRED); return; }
    st.cat = cat;
    st.templates = Array.isArray(templates) ? templates : [];
    st.snap = snap;
    draw();
  }

  /** Re-read the pilot's garage after a change (limits, My liveries). false if it didn't work. */
  async function refreshSnap() {
    if (!st.sess) return false;
    try {
      const snap = await garageApi.garage(st.sess.pilot_id, st.sess.garage_token, { signal });
      if (!snap.owner) { signedOut(EXPIRED); return false; }
      st.snap = snap;
      return true;
    } catch (_) {
      return false;
    }
  }

  const acData = (ac) => (st.snap && st.snap.aircraft[ac]) || { equipped: null, equipped_urls: null, liveries: [] };
  const acLabel = (ac) => S().garageAircraftLabel(ac, st.cat && st.cat.aircraft);
  const templatesFor = (ac) => st.templates.filter((t) => t.aircraft === ac);
  const customIds = (ac) => acData(ac).liveries.filter((x) => x.category === "custom").map((x) => x.id);

  // ---------------------------------------------------------------- frame
  function head() {
    const out = h("button", { type: "button", class: "btn btn-ghost", onClick: async (e) => {
      e.currentTarget.disabled = true;
      try { await garageApi.revoke(token(), { signal }); } catch (_) { /* signed out here either way */ }
      signedOut("Signed out. This browser no longer has your Garage.");
    } }, "Sign out");
    return h("div", { class: "page-head" },
      h("div", {}, h("span", { class: "eyebrow", text: "FINSONLY liveries" }), h("h1", {}, "Garage"),
        st.sess ? h("p", {}, "Signed in as ", link.pilot(st.sess.callsign || "you"), ". What you equip here is on your jet in the sim, for everyone in the race.") : null),
      st.sess ? out : null);
  }

  function tabsEl(tabs, ac) {
    const select = (key, focus) => {
      const rest = Object.assign({}, q(), { ac: key });
      if (rest.do === "make" && !templatesFor(key).length) delete rest.do;
      if (rest.do === "paint" && !S().GARAGE_KITS[key]) delete rest.do;
      go(rest, false);
      if (focus) { const b = document.getElementById("gx-tab-" + key); if (b) b.focus(); }
    };
    const bar = h("div", { class: "gx-tabs", role: "tablist", "aria-label": "Aircraft" }, tabs.map((t) =>
      h("button", { type: "button", role: "tab", id: "gx-tab-" + t.key, "aria-selected": String(t.key === ac), "aria-controls": "gx-panel",
        tabindex: t.key === ac ? "0" : "-1", onClick: () => select(t.key, false) }, t.label)));
    bar.addEventListener("keydown", (e) => {
      const i = tabs.findIndex((t) => t.key === ac);
      const next = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : null;
      if (next == null) return;
      e.preventDefault();
      select(tabs[(next + tabs.length) % tabs.length].key, true);
    });
    return bar;
  }

  function draw() {
    if (!st.snap) return;
    closeSheet();
    const tabs = S().garageTabs(st.snap.aircraft, st.cat.aircraft, st.templates);
    const qq = q();
    if (!tabs.length) {
      clear(page).append(head(), h("p", { class: "state-msg empty" }, "No liveries on this server yet."));
      return;
    }
    const ac = tabs.some((t) => t.key === qq.ac) ? qq.ac : tabs[0].key;
    const doing = qq.do === "make" ? "make" : qq.do === "paint" ? "paint" : "browse";
    const panel = h("div", { class: "gx-panel", id: "gx-panel", role: "tabpanel", "aria-labelledby": "gx-tab-" + ac });
    clear(page).append(head(), st.notice ? h("p", { class: "warn gx-notice", text: st.notice }) : "", tabsEl(tabs, ac), panel);
    if (doing === "make") panel.appendChild(drawMake(ac));
    else if (doing === "paint") panel.appendChild(drawPaint(ac));
    else panel.appendChild(drawBrowse(ac));
    const tab = document.getElementById("gx-tab-" + ac);
    if (tab && tab.scrollIntoView) tab.scrollIntoView({ block: "nearest", inline: "nearest" });
    if (st.lastDo != null && st.lastDo !== doing) page.scrollIntoView({ block: "start" });
    st.lastDo = doing;
  }

  // ---------------------------------------------------------------- browse
  async function equip(ac, liveryId, btn) {
    const label = btn ? btn.textContent : "";
    if (btn) { btn.disabled = true; btn.textContent = liveryId ? "Equipping…" : "Switching…"; }
    try {
      const r = await garageApi.equip(token(), ac, liveryId, { signal });
      const a = acData(ac);
      a.equipped = r.equipped;
      a.equipped_urls = r.urls;
      toast(liveryId ? "Equipped. It's on your " + acLabel(ac) + " in the sim now." : "Back to stock paint.");
      return true;
    } catch (e) {
      if (signal.aborted || authFail(e)) return false;
      if (btn) { btn.disabled = false; btn.textContent = label; }
      toast(errText(e));
      return false;
    }
  }

  function statusChip(status) {
    const c = STATUS_CHIP[status];
    return c ? chip(c[0], c[1]) : null;
  }

  function actionEl(item, ac, cs, inSheet) {
    if (cs.action === "equip") {
      return h("button", { type: "button", class: "btn btn-primary lv-act", "aria-label": inSheet ? null : "Equip " + item.name,
        onClick: async (e) => { if (await equip(ac, item.id, e.currentTarget)) draw(); } }, "Equip");
    }
    if (cs.action === "equipped") return h("span", { class: "lv-equipped lv-act" }, "✓ Equipped");
    if (cs.action === "locked") return h("p", { class: "lv-unlock" }, h("span", { class: "lv-lock-ico", "aria-hidden": "true", text: "🔒" }), h("span", { text: cs.text }));
    return h("p", { class: "lv-unlock" + (cs.action === "rejected" ? " bad" : " faint"), text: cs.text });
  }

  function card(item, ac) {
    const a = acData(ac);
    const cs = S().garageCardState(item, a.equipped);
    const thumbUrl = S().garageCardImage(item);       // the 256 px thumb; the full texture is the detail sheet's
    const fullUrl = item.urls && item.urls[0];
    const thumb = h("span", { class: "lv-thumb" },
      thumbUrl ? h("img", { src: thumbUrl, alt: "", loading: "lazy", decoding: "async" }) : h("span", { class: "lv-thumb-none", text: "No picture" }),
      cs.action === "locked" ? h("span", { class: "lv-lock-badge", text: "Locked" }) : null);
    const img = thumb.querySelector("img");
    if (img) img.addEventListener("error", () => {
      // a thumb that 404s (not rendered yet / an older server) falls back to the full texture once
      if (thumbUrl !== fullUrl && fullUrl && img.getAttribute("src") !== fullUrl) { img.setAttribute("src", fullUrl); return; }
      img.replaceWith(h("span", { class: "lv-thumb-none", text: "No picture" }));
    });
    return h("li", { class: "lv-card", dataset: { action: cs.action } },
      h("button", { type: "button", class: "lv-open", "aria-haspopup": "dialog", onClick: () => openSheet(item, ac) },
        thumb,
        h("span", { class: "lv-name", text: item.name }),
        statusChip(cs.status),
        cs.status === "pending" ? h("span", { class: "lv-note", text: cs.text }) : null),
      h("div", { class: "lv-foot" }, actionEl(item, ac, cs)));
  }

  function drawBrowse(ac) {
    const a = acData(ac);
    const label = acLabel(ac);
    const eqItem = a.equipped ? a.liveries.find((x) => x.id === a.equipped) : null;
    const eqName = eqItem ? eqItem.name : a.equipped ? "Your livery" : null;
    const hero = h("section", { class: "panel gx-equipped", "aria-labelledby": "gx-eq-h" },
      h("div", { class: "gx-equipped-head" },
        h("div", {}, h("span", { class: "eyebrow", text: "On your " + label }),
          h("h2", { id: "gx-eq-h" }, eqName || "Stock paint"),
          eqItem && eqItem.state === "pending" ? h("p", { class: "lv-note" }, "Pending review: only you see it until it's approved; everyone else sees stock paint.") : null),
        a.equipped ? h("button", { type: "button", class: "btn btn-ghost", onClick: async (e) => { if (await equip(ac, null, e.currentTarget)) draw(); } }, "Back to stock paint") : null),
      a.equipped
        ? liveryMedia(eqItem ? eqItem.blueprint_url : null, a.equipped_urls && a.equipped_urls[0], { big: true, name: eqName })
        : h("p", { class: "dim" }, "You're flying GeoFS's own paint on the " + label + ". Pick a livery below and it's on your jet in the sim within a few seconds."));

    const tpls = templatesFor(ac);
    const kit = S().GARAGE_KITS[ac];
    const makers = (tpls.length || kit) ? h("div", { class: "gx-makers" },
      tpls.length ? h("a", { class: "gx-maker", href: S().buildRoute("garage", null, { ac, do: "make" }) },
        h("strong", {}, "Make your own"), h("span", {}, "Pick a template, your colours and text. The server paints it in about a minute.")) : null,
      kit ? h("a", { class: "gx-maker", href: S().buildRoute("garage", null, { ac, do: "paint" }) },
        h("strong", {}, "Paint your own"), h("span", {}, "Download the paint kit, paint it in any editor, upload it.")) : null) : null;

    const groups = S().garageGroups(a.liveries);
    if ((tpls.length || kit) && !groups.some((g) => g.id === "custom")) groups.push({ id: "custom", label: "My liveries", items: [] });
    const sections = groups.map((g) => h("section", { class: "gx-group", "aria-labelledby": "gx-g-" + g.id },
      h("h2", { id: "gx-g-" + g.id }, g.label, h("small", { text: g.items.length ? String(g.items.length) : "" })),
      g.items.length ? h("ul", { class: "lv-grid" }, g.items.map((it) => card(it, ac)))
        : h("p", { class: "state-msg empty" }, "Nothing here yet. Make your own or paint your own and it lands here.")));

    const heats = S().garageHeatStrip(st.cat.liveries, ac);
    const heatEl = heats.length ? h("section", { class: "gx-group", "aria-labelledby": "gx-g-heat" },
      h("h2", { id: "gx-g-heat" }, "Gun Game heat"),
      h("p", { class: "section-sub" }, "Gun Game paints your jet for each heat as you climb. They come with the mode, so they can't be equipped."),
      h("ul", { class: "lv-strip" }, heats.map((x) => h("li", {}, picture(x.url, x.label, { lazy: true, alt: x.name, className: "lv-heat" }))))) : null;

    return h("div", { class: "stack" }, hero, makers, sections, heatEl);
  }

  // ---------------------------------------------------------------- detail sheet
  function closeSheet() {
    const d = st.dialog;
    st.dialog = null;
    if (d) { try { if (d.open && d.close) d.close(); } catch (_) { /* already closed */ } d.remove(); }
  }

  function openSheet(item, ac) {
    closeSheet();
    const a = acData(ac);
    const cs = S().garageCardState(item, a.equipped);
    const custom = item.category === "custom";
    const cat = S().GARAGE_CATEGORIES.find((c) => c.id === item.category);
    const tpl = custom && item.template ? st.templates.find((t) => t.id === item.template) : null;
    const extra = [];
    if (custom && tpl && item.params && cs.action !== "rejected") {
      extra.push(h("button", { type: "button", class: "btn btn-ghost", onClick: () => {
        const busy = st.makes[ac] && st.makes[ac].phase !== "edit";
        if (busy) { toast("Finish the render you have going first."); return; }
        st.makes[ac] = { ac, tplId: tpl.id, values: Object.assign({}, item.params), name: "", phase: "edit" };
        closeSheet();
        go({ ac, do: "make" }, true);
      } }, "Make a copy"));
    }
    if (custom) {
      extra.push(h("button", { type: "button", class: "btn btn-ghost gx-danger", onClick: async (e) => {
        if (!window.confirm("Delete \"" + item.name + "\"? If you're wearing it, you go back to stock paint.")) return;
        const b = e.currentTarget;
        b.disabled = true;
        try {
          await garageApi.deleteCustom(token(), item.id, { signal });
          await refreshSnap();
          toast("Deleted " + item.name);
          draw();
        } catch (err) {
          if (signal.aborted || authFail(err)) return;
          b.disabled = false;
          toast(errText(err));
        }
      } }, "Delete"));
    }
    const lines = [];
    if (cs.action === "locked") lines.push(h("p", { class: "lv-unlock-big" }, h("strong", {}, "Locked. "), "To unlock: " + cs.text + "."));
    else if (cs.text) lines.push(h("p", { class: cs.action === "rejected" ? "bad" : "dim", text: cs.text }));
    if (custom && cs.status === "approved") lines.push(h("p", { class: "dim" }, "Approved: everyone sees it when you wear it."));
    if (tpl) lines.push(h("p", { class: "faint" }, "Made with the " + tpl.name + " template."));
    else if (custom && item.kind === "upload") lines.push(h("p", { class: "faint" }, "Your own upload."));

    const dlg = h("dialog", { class: "sheet", "aria-labelledby": "gx-sheet-h" },
      h("div", { class: "sheet-head" },
        h("h2", { id: "gx-sheet-h", text: item.name }),
        h("button", { type: "button", class: "btn btn-ghost sheet-close", onClick: closeSheet }, "Close")),
      h("div", { class: "sheet-chips" }, chip(acLabel(ac)), chip(cat ? cat.label : item.category), statusChip(cs.status)),
      liveryMedia(item.blueprint_url, item.urls && item.urls[0], { name: item.name }),
      lines,
      h("div", { class: "btn-row sheet-actions" }, cs.action === "locked" ? null : actionEl(item, ac, cs, true), extra));
    dlg.addEventListener("click", (e) => { if (e.target === dlg) closeSheet(); });
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); closeSheet(); });
    document.body.appendChild(dlg);
    st.dialog = dlg;
    if (typeof dlg.showModal === "function") dlg.showModal(); else dlg.setAttribute("open", "");
  }

  // ---------------------------------------------------------------- make your own (recolor)
  function limitsLine(kind) {
    const L = st.snap && st.snap.limits;
    if (!L) return null;
    const bits = kind === "upload"
      ? ["Uploads today: " + L.uploads_today + " of " + L.uploads_per_day]
      : ["Renders today: " + L.renders_today + " of " + L.renders_per_day];
    bits.push("Saved liveries: " + L.customs + " of " + L.max_customs);
    return h("p", { class: "gx-limits" }, bits.map((b, i) => [i ? " · " : "", h("span", { text: b })]));
  }

  function ensureMake(ac) {
    const tpls = templatesFor(ac);
    if (st.makes[ac]) return st.makes[ac];
    const m = st.makes[ac] = { ac, tplId: tpls[0].id, values: {}, name: "", phase: "edit" };
    // A render started before a reload (same tab) picks up where it was.
    const saved = readJob();
    if (saved && saved.ac === ac && saved.job_id) {
      Object.assign(m, { tplId: saved.tplId || m.tplId, values: saved.values || {}, name: saved.name || "",
        phase: "running", job: { job_id: saved.job_id, status: "queued", position: 0 }, started: saved.started || Date.now(),
        prior: new Set(saved.prior || []) });
      later(() => poll(m, 0), 0);
    }
    return m;
  }

  function backToGarage(ac) { return h("a", { class: "gx-back", href: S().buildRoute("garage", null, { ac }) }, "← Back to the garage"); }

  function drawMake(ac) {
    const tpls = templatesFor(ac);
    const box = h("section", { class: "panel gx-make", "aria-labelledby": "gx-make-h" });
    if (!tpls.length) {
      box.append(backToGarage(ac), h("p", { class: "state-msg empty" }, "No templates for the " + acLabel(ac) + " yet."));
      return box;
    }
    const m = ensureMake(ac);
    const body = h("div", {});
    box.append(backToGarage(ac), h("h2", { id: "gx-make-h" }, "Make your own " + acLabel(ac)), body);
    m.redraw = () => { clear(body); body.append(limitsLine("recolor") || "", m.phase === "edit" ? makeForm(m, tpls) : makeProgress(m)); };
    m.redraw();
    return box;
  }

  function previewEl(tpl, values) {
    const res = S().garageCleanParams(tpl, values);
    const entries = Object.entries(tpl.params);
    const colors = entries.filter(([, s]) => s.type === "color");
    const texts = entries.filter(([, s]) => s.type === "text" || s.type === "tail");
    const ints = entries.filter(([, s]) => s.type === "int");
    const box = h("div", { class: "gx-preview", role: "img", "aria-label": "Preview of your colours" });
    const strip = h("div", { class: "gx-swatches" });
    for (const [k, sch] of colors) {
      const v = res.errors[k] ? null : res.params[k];
      const sw = h("span", { class: "gx-swatch" + (v ? "" : " gx-swatch-bad") }, h("span", { text: sch.label }));
      if (v) { sw.style.background = v; sw.style.color = S().garageInk(v); }
      strip.appendChild(sw);
    }
    box.appendChild(strip);
    if (texts.length && colors.length) {
      const base = res.errors[colors[0][0]] ? "#2c1a3d" : res.params[colors[0][0]];
      const accent = colors[1] && !res.errors[colors[1][0]] ? res.params[colors[1][0]] : S().garageInk(base);
      const plate = h("div", { class: "gx-plate" }, texts.map(([k]) => h("span", { class: "gx-plate-" + tpl.params[k].type, text: res.params[k] || "" })));
      plate.style.background = base;
      plate.style.color = S().garageInk(base);
      plate.style.borderColor = accent;
      box.appendChild(plate);
    }
    // The Rafale's chrome: a sheen whose highlight spreads with roughness.
    if (ints.length && colors.length) {
      const tint = res.errors[colors[0][0]] ? "#888888" : res.params[colors[0][0]];
      const rough = Number(res.params[ints[0][0]]) || 0;
      const spread = Math.round(4 + Math.min(1, rough / 160) * 40);
      const sheen = h("div", { class: "gx-sheen" });
      sheen.style.background = "linear-gradient(115deg, " + tint + " 0%, #ffffff " + (50 - spread / 2) + "%, " + tint + " " + (50 + spread / 2) + "%, #1d1029 100%)";
      box.appendChild(sheen);
    }
    return box;
  }

  function makeForm(m, tpls) {
    const tpl = tpls.find((t) => t.id === m.tplId) || tpls[0];
    m.tplId = tpl.id;
    let preview = previewEl(tpl, m.values);
    const renderBtn = h("button", { type: "submit", class: "btn btn-primary gx-wide" }, "Render");
    const formErr = h("p", { class: "gx-err", role: "alert", text: m.error || "" });
    const refresh = () => {
      const fresh = previewEl(tpl, m.values);
      preview.replaceWith(fresh);
      preview = fresh;
      renderBtn.disabled = !S().garageCleanParams(tpl, m.values).ok;
    };

    const picker = h("fieldset", { class: "gx-tpls" }, h("legend", { class: "gx-label" }, "Template"),
      tpls.map((t) => {
        const radio = h("input", { type: "radio", name: "gx-tpl", value: t.id, checked: t.id === tpl.id });
        radio.addEventListener("change", () => { m.tplId = t.id; m.values = {}; m.error = null; m.redraw(); });
        return h("label", { class: "gx-tpl" }, radio, h("span", { class: "gx-tpl-body" }, h("strong", { text: t.name }), h("span", { text: t.description || "" })));
      }));

    const nameId = "gx-name";
    const nameIn = h("input", { type: "text", id: nameId, maxlength: "32", placeholder: tpl.name, autocomplete: "off" });
    nameIn.value = m.name || "";
    nameIn.addEventListener("input", () => { m.name = nameIn.value; });

    const fields = Object.entries(tpl.params).map(([k, sch]) => paramField(m, tpl, k, sch, refresh));
    const form = h("form", { class: "gx-form", novalidate: true, onSubmit: (e) => { e.preventDefault(); submitRender(m, tpl, formErr); } },
      picker,
      h("div", { class: "gx-preview-wrap" }, preview),
      h("div", { class: "gx-field" }, h("label", { for: nameId, class: "gx-label" }, "Name ", h("span", { class: "faint", text: "(optional)" })), nameIn),
      fields,
      formErr,
      renderBtn,
      h("p", { class: "faint gx-small" }, "A render takes about 30 to 60 seconds. The same template and colours as any earlier render come back at once and don't count."));
    refresh();
    return form;
  }

  function paramField(m, tpl, k, sch, refresh) {
    const id = "gx-p-" + k;
    const errEl = h("p", { class: "gx-field-err", id: id + "-err" });
    const cur = m.values[k] === undefined ? sch.default : m.values[k];
    const check = () => {
      const r = S().garageCleanParam(sch, m.values[k] === undefined ? sch.default : m.values[k]);
      errEl.textContent = r.error || "";
      return r;
    };
    const wrap = h("div", { class: "gx-field" }, h("label", { for: id, class: "gx-label", text: sch.label || k }));
    if (sch.type === "color") {
      const hex = h("input", { type: "text", id, class: "gx-hex", maxlength: "7", spellcheck: "false", autocomplete: "off", autocapitalize: "off", "aria-describedby": id + "-err" });
      const pick = h("input", { type: "color", class: "gx-color", "aria-label": (sch.label || k) + " colour picker" });
      hex.value = cur;
      pick.value = S().garageCleanParam(sch, cur).error ? "#000000" : S().garageCleanParam(sch, cur).value;
      pick.addEventListener("input", () => { m.values[k] = pick.value; hex.value = pick.value; hex.removeAttribute("aria-invalid"); check(); refresh(); });
      hex.addEventListener("input", () => {
        m.values[k] = hex.value;
        const r = check();
        if (r.error) hex.setAttribute("aria-invalid", "true"); else { hex.removeAttribute("aria-invalid"); pick.value = r.value; }
        refresh();
      });
      wrap.append(h("div", { class: "gx-color-row" }, pick, hex), errEl);
    } else if (sch.type === "int") {
      const out = h("output", { for: id, class: "gx-range-val", text: String(cur) });
      const range = h("input", { type: "range", id, min: String(sch.min), max: String(sch.max), step: "1", class: "gx-range" });
      range.value = String(cur);
      range.addEventListener("input", () => { m.values[k] = Number(range.value); out.textContent = range.value; check(); refresh(); });
      wrap.append(h("div", { class: "gx-range-row" }, range, out), errEl);
    } else {
      const max = sch.type === "tail" ? 7 : Number(sch.max) || 12;
      const count = h("span", { class: "gx-count faint", "aria-hidden": "true" });
      const input = h("input", { type: "text", id, autocomplete: "off", spellcheck: "false", autocapitalize: "characters", "aria-describedby": id + "-hint " + id + "-err" });
      input.value = cur;
      const hint = h("p", { class: "gx-hint faint", id: id + "-hint",
        text: sch.type === "tail" ? "Up to 7 letters, digits or dashes." : "Up to " + max + " characters: letters, digits, spaces and . ! & ' -" });
      const upd = () => {
        // Uppercase as they type, keeping the caret where it was.
        const pos = input.selectionStart;
        const up = input.value.toUpperCase();
        if (up !== input.value) { input.value = up; try { input.setSelectionRange(pos, pos); } catch (_) { /* not focused */ } }
        m.values[k] = input.value;
        const r = check();
        count.textContent = r.value.length + " / " + max;
        if (r.error) input.setAttribute("aria-invalid", "true"); else input.removeAttribute("aria-invalid");
      };
      input.addEventListener("input", () => { upd(); refresh(); });
      wrap.append(h("div", { class: "gx-text-row" }, input, count), hint, errEl);
      upd();
    }
    check();
    return wrap;
  }

  async function submitRender(m, tpl, formErr) {
    const res = S().garageCleanParams(tpl, m.values);
    if (!res.ok) { formErr.textContent = "Fix the fields marked above first."; return; }
    m.prior = new Set(customIds(m.ac));
    m.phase = "running";
    m.error = null;
    m.job = null;
    m.started = Date.now();
    m.redraw();
    try {
      const job = await garageApi.recolor(token(), tpl.id, res.params, (m.name || "").trim() || null, { signal });
      writeJob({ ac: m.ac, job_id: job.job_id, tplId: tpl.id, values: m.values, name: m.name, started: m.started, prior: [...m.prior] });
      onJob(m, job);
    } catch (e) {
      if (signal.aborted || authFail(e)) return;
      m.phase = "edit";
      m.error = errText(e);
      m.redraw();
    }
  }

  const showingMake = (m) => q().do === "make" && (q().ac || "") === m.ac;

  function onJob(m, job) {
    if (signal.aborted) return;
    m.job = job;
    if (job.status === "done") {
      writeJob(null);
      m.phase = "result";
      m.result = job;
      stopTicker();
      refreshSnap().then(() => { if (st.makes[m.ac] === m && m.phase === "result" && m.redraw) m.redraw(); });
      if (!showingMake(m)) toast("Your " + acLabel(m.ac) + " render is ready: open Make your own.");
    } else if (job.status === "failed") {
      writeJob(null);
      m.phase = "edit";
      m.error = job.error || "The render failed.";
      stopTicker();
    } else {
      // Still going: the progress line reads m.job every second, nothing to rebuild.
      later(() => poll(m, 0), POLL_MS);
      return;
    }
    if (m.redraw) m.redraw();
  }

  function poll(m, failures) {
    if (!m.job || st.makes[m.ac] !== m || m.phase !== "running") return;
    garageApi.job(m.job.job_id, { signal }).then((j) => onJob(m, j)).catch((e) => {
      if (signal.aborted) return;
      if ((e && e.status === 404) || failures >= POLL_RETRIES) {
        writeJob(null);
        m.phase = "edit";
        m.error = e && e.status === 404 ? "The server lost track of that render (it may have restarted). Render again." : errText(e);
        stopTicker();
        if (m.redraw) m.redraw();
        return;
      }
      later(() => poll(m, failures + 1), POLL_MS * 2);
    });
  }

  function stopTicker() { if (ticker) { clearInterval(ticker); ticker = null; } }

  function makeProgress(m) {
    if (m.phase === "result") return makeResult(m);
    const text = h("p", { class: "gx-job-text" });
    const upd = () => { text.textContent = S().garageJobText(m.job || {}, (Date.now() - (m.started || Date.now())) / 1000); };
    upd();
    stopTicker();
    ticker = setInterval(() => { if (!text.isConnected) { stopTicker(); return; } upd(); }, 1000);
    return h("div", { class: "gx-progress", role: "status", "aria-live": "polite" },
      h("div", { class: "gx-bar", "aria-hidden": "true" }, h("span")),
      text,
      h("p", { class: "faint gx-small" }, "You can leave this page open on another tab; it keeps checking."));
  }

  function makeResult(m) {
    const job = m.result || {};
    const custom = acData(m.ac).liveries.find((x) => x.id === job.livery_id);
    const name = custom ? custom.name : "Your livery";
    const existed = m.prior && m.prior.has(job.livery_id);
    const reset = () => { m.phase = "edit"; m.result = null; };
    return h("div", { class: "gx-result" },
      h("h3", {}, "Ready: " + name),
      custom && custom.state === "pending" ? h("p", { class: "lv-note" }, "Recolors need approval on this server: you can fly it now, everyone else sees it once it's approved.") : null,
      liveryMedia(job.blueprint_url, job.urls && job.urls[0], { big: true, name }),
      h("div", { class: "btn-row gx-result-btns" },
        h("button", { type: "button", class: "btn btn-primary", onClick: async (e) => {
          if (!(await equip(m.ac, job.livery_id, e.currentTarget))) return;
          reset();
          go({ ac: m.ac }, false);
        } }, "Equip"),
        h("button", { type: "button", class: "btn btn-ghost", onClick: () => {
          reset();
          toast("Saved to My liveries");
          go({ ac: m.ac }, false);
        } }, "Keep"),
        h("button", { type: "button", class: "btn btn-ghost", onClick: async (e) => {
          e.currentTarget.disabled = true;
          if (!existed && job.livery_id) {
            try { await garageApi.deleteCustom(token(), job.livery_id, { signal }); await refreshSnap(); } catch (err) { if (authFail(err)) return; }
          }
          reset();
          m.redraw();
        } }, "Back")),
      h("p", { class: "faint gx-small", text: existed
        ? "You already had this one in My liveries. Back takes you to the form."
        : "Keep puts it in My liveries. Back throws this one away and takes you to the form with your colours." }));
  }

  // ---------------------------------------------------------------- paint your own (upload)
  function drawPaint(ac) {
    const label = acLabel(ac);
    const kit = S().GARAGE_KITS[ac];
    const box = h("section", { class: "panel gx-paint", "aria-labelledby": "gx-paint-h" }, backToGarage(ac),
      h("h2", { id: "gx-paint-h" }, "Paint your own " + label));
    if (!kit) {
      box.appendChild(h("p", { class: "state-msg empty" }, ac === "rafale"
        ? "The Rafale has no paint kit: its livery is a whole-airframe chrome tint. Use Make your own (the Chrome template) instead."
        : "The " + label + " has no paint kit yet. Use Make your own instead."));
      return box;
    }
    const notes = KIT_NOTES[ac] || { format: "its own format", mirrored: [] };
    const size = kit.size + " × " + kit.size + " px";
    const up = st.upload && st.upload.ac === ac ? st.upload : (st.upload = { ac, file: null, check: null, name: "", result: null });

    box.append(
      h("h3", {}, "1. Get the paint kit"),
      h("div", { class: "btn-row" },
        h("a", { class: "btn btn-ghost", href: "/liveries/kit/" + kit.blank, download: kit.blank }, "Blank (" + size + ")"),
        h("a", { class: "btn btn-ghost", href: "/liveries/kit/" + kit.guides, download: kit.guides }, "Guides layer")),
      h("h3", {}, "2. Paint it"),
      h("ol", { class: "gx-howto" },
        h("li", { text: "Open the blank in any editor with layers (Photopea in a browser works)." }),
        h("li", { text: "Put the guides on top as their own layer. Pink lines outline each part of the jet, with its name. Red hatching marks bits nobody sees from outside (cockpit tub, intake, wheel wells): paint there is wasted." }),
        h("li", { text: "Paint on layers between the blank and the guides. Keep the canvas exactly " + size + "." }),
        h("li", {}, h("strong", {}, "Hide the guides layer"), ", then export as PNG, WebP or JPEG.")),
      h("h3", {}, "Things that trip people up"),
      h("ul", { class: "gx-rules" },
        h("li", {}, h("strong", {}, "Exact size: " + size + ". "), "Half or double size (" + (kit.size / 2) + " or " + (kit.size * 2) + ") is accepted and rescaled; anything else is rejected."),
        h("li", {}, h("strong", {}, "Mirrored parts. "), notes.mirrored.join(" ")),
        h("li", {}, h("strong", {}, "Size cap. "), "The server re-encodes your file as " + notes.format + " and it has to come out under 1.5 MB. Flat colours and clean gradients are fine; fine noise and photo textures blow the cap. The file you send can be up to 12 MB."),
        h("li", {}, h("strong", {}, "Original art only. "), "No real airline liveries, military markings, national insignia, brands or characters. Uploads are checked before anyone else sees them.")),
      h("h3", {}, "3. Upload it"),
      limitsLine("upload") || "",
      up.result ? uploadResult(ac, up) : uploadForm(ac, up, label));
    return box;
  }

  function uploadForm(ac, up, label) {
    const fileId = "gx-file";
    const file = h("input", { type: "file", id: fileId, accept: "image/png,image/webp,image/jpeg", class: "visually-hidden" });
    const pickLabel = h("label", { for: fileId, class: "btn btn-ghost gx-wide gx-file-btn" }, up.file ? "Choose a different file" : "Choose your PNG, WebP or JPEG");
    const previewSlot = h("div", { class: "gx-upload-preview" });
    const msg = h("p", { class: "gx-err", role: "alert" });
    const note = h("p", { class: "dim gx-small" });
    const nameIn = h("input", { type: "text", id: "gx-up-name", maxlength: "32", placeholder: "My upload", autocomplete: "off" });
    nameIn.value = up.name || "";
    nameIn.addEventListener("input", () => { up.name = nameIn.value; });
    const send = h("button", { type: "submit", class: "btn btn-primary gx-wide", disabled: true }, "Upload");

    const showCheck = () => {
      msg.textContent = up.check && up.check.error ? up.check.error : "";
      note.textContent = up.check && up.check.note ? up.check.note : "";
      send.disabled = !up.file || !up.check || !!up.check.error || !up.dims;
    };
    const showFile = () => {
      clear(previewSlot);
      if (up.dataUrl) previewSlot.appendChild(picture(up.dataUrl, up.file.name + (up.dims ? " · " + up.dims.w + " × " + up.dims.h + " px" : ""), { alt: "The file you picked" }));
    };
    file.addEventListener("change", () => {
      const f = file.files && file.files[0];
      if (!f) return;
      up.file = f;
      up.dims = null;
      up.dataUrl = null;
      pickLabel.textContent = "Choose a different file";
      up.check = S().garageUploadCheck(ac, { bytes: f.size, type: f.type }, label);
      showCheck();
      showFile();
      if (up.check.error) return;
      // The site's CSP allows data: images but not blob:, so the preview is read as a data URL.
      const reader = new FileReader();
      reader.onload = () => {
        if (up.file !== f) return;
        const img = new Image();
        img.onload = () => {
          if (up.file !== f) return;
          up.dims = { w: img.naturalWidth, h: img.naturalHeight };
          up.dataUrl = reader.result;
          up.check = S().garageUploadCheck(ac, { bytes: f.size, type: f.type, width: up.dims.w, height: up.dims.h }, label);
          showFile();
          showCheck();
        };
        img.onerror = () => { if (up.file === f) { up.check = { error: "This browser couldn't read that image. Is it a PNG, WebP or JPEG?", note: null }; showCheck(); } };
        img.src = reader.result;
      };
      reader.onerror = () => { up.check = { error: "Couldn't read that file.", note: null }; showCheck(); };
      reader.readAsDataURL(f);
    });

    const form = h("form", { class: "gx-form", novalidate: true, onSubmit: async (e) => {
      e.preventDefault();
      if (send.disabled) return;
      send.disabled = true;
      send.textContent = "Uploading…";
      note.textContent = "Uploading and checking your file. A big file can take a little while.";
      msg.textContent = "";
      try {
        up.result = await garageApi.upload(token(), ac, up.file, (up.name || "").trim() || null, { signal });
        await refreshSnap();
        draw();
      } catch (err) {
        if (signal.aborted || authFail(err)) return;
        send.textContent = "Upload";
        note.textContent = "";
        msg.textContent = errText(err);
        send.disabled = false;
      }
    } },
    file, pickLabel, previewSlot, msg, note,
    h("div", { class: "gx-field" }, h("label", { for: "gx-up-name", class: "gx-label" }, "Name ", h("span", { class: "faint", text: "(optional)" })), nameIn),
    send);
    showFile();
    showCheck();
    return form;
  }

  function uploadResult(ac, up) {
    const r = up.result;
    const again = () => { st.upload = { ac, file: null, check: null, name: "", result: null }; draw(); };
    return h("div", { class: "gx-result" },
      h("p", { class: "gx-pending", role: "status" }, h("strong", {}, "Pending: "), "you can fly it now, everyone else sees it once it's approved."),
      liveryMedia(r.blueprint_url, r.urls && r.urls[0], { big: true, name: up.name || "Your upload" }),
      h("div", { class: "btn-row gx-result-btns" },
        h("button", { type: "button", class: "btn btn-primary", onClick: async (e) => {
          if (!(await equip(ac, r.livery_id, e.currentTarget))) return;
          st.upload = null;
          go({ ac }, false);
        } }, "Equip it now"),
        h("button", { type: "button", class: "btn btn-ghost", onClick: again }, "Upload another"),
        h("a", { class: "btn btn-ghost", href: S().buildRoute("garage", null, { ac }) }, "Back to the garage")));
  }

  // ---------------------------------------------------------------- go
  if (q().link) redeem(q().link);
  else if (st.sess) load();
  else drawSignIn();

  return {
    cleanup: () => {
      st.seq++;
      closeSheet();
      stopTicker();
      for (const t of timers) clearTimeout(t);
      timers.clear();
    },
    onQuery: (r) => {
      st.route = r;
      if (r.query.link) { redeem(r.query.link); return true; }
      if (!st.sess) { drawSignIn(); return true; }
      if (!st.snap) { load(); return true; }
      draw();
      return true;
    },
  };
}
