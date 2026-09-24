// /pilot/:callsign — license card, personal bests with medals, head-to-heads, recent activity,
// and a "Download card" PNG drawn on a canvas.

import { api } from "../api.js";
import { allBoards, recentRaces, modelsIndex } from "../data.js";
import { MODEL_BASE } from "../config.js";
import { h, s, clear, link, medal, sortableTable, toast, getMe, setMe, retryRoute } from "../ui.js";

const S = () => window.FinsSite;
const pretty = (id) => String(id || "").replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

function planeIcon() {
  return s("svg", { viewBox: "0 0 100 100", "aria-hidden": "true" },
    s("circle", { cx: 50, cy: 50, r: 46, fill: "#2c1a3d", stroke: "#ffd23d", "stroke-width": 3 }),
    s("path", { d: "M50 16 L55 42 L84 56 L84 62 L55 55 L53 76 L62 82 L62 86 L50 83 L38 86 L38 82 L47 76 L45 55 L16 62 L16 56 L45 42 Z", fill: "#fff4ea" }));
}

function kv(label, value) { return h("div", {}, h("dt", { text: label }), h("dd", {}, value)); }

function medalCounts(m) {
  return h("span", {}, ["gold", "silver", "bronze"].map((k) => h("span", { class: "medal-count" }, medal(k), String(m[k]))));
}

/** The card as a 1200x630 PNG. Canvas text only, from the same numbers the page shows. */
async function drawCard(sum, planeName) {
  const W = 1200, H = 630;
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const g = c.getContext("2d");
  try { await document.fonts.ready; } catch (_) { /* fallback fonts are fine */ }
  const head = "'Saira Condensed', 'Saira Condensed Fallback', 'Arial Narrow', sans-serif";
  const body = "'Saira', 'Saira Fallback', Arial, sans-serif";
  const bg = g.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, "#3a1f4d"); bg.addColorStop(0.5, "#2c1a3d"); bg.addColorStop(1, "#1d1029");
  g.fillStyle = bg; g.fillRect(0, 0, W, H);
  const sun = g.createRadialGradient(1010, 170, 10, 1010, 170, 260);
  sun.addColorStop(0, "rgba(255,210,61,.95)"); sun.addColorStop(0.35, "rgba(255,210,61,.6)"); sun.addColorStop(1, "rgba(255,138,61,0)");
  g.fillStyle = sun; g.fillRect(700, 0, 500, 450);
  g.fillStyle = "#2c1a3d";
  g.beginPath(); g.moveTo(0, H); g.lineTo(160, 470); g.lineTo(330, 540); g.lineTo(520, 440); g.lineTo(700, 560); g.lineTo(900, 460); g.lineTo(1080, 540); g.lineTo(W, 480); g.lineTo(W, H); g.fill();
  const stripe = g.createLinearGradient(0, 0, W, 0);
  stripe.addColorStop(0, "#ff8a3d"); stripe.addColorStop(1, "#ff3d8b");
  g.fillStyle = stripe; g.fillRect(0, 0, W, 10);
  g.strokeStyle = "rgba(255,210,61,.6)"; g.lineWidth = 4; g.strokeRect(22, 30, W - 44, H - 52);
  g.fillStyle = "#ff8a3d"; g.font = "600 24px " + body; g.fillText("FINSONLY RACING · PILOT LICENSE", 60, 90);
  g.fillStyle = "#fff4ea"; g.font = "700 96px " + head;
  let name = sum.callsign;
  while (g.measureText(name).width > 760 && name.length > 3) name = name.slice(0, -2) + "…";
  g.fillText(name, 60, 190);
  g.font = "500 28px " + body; g.fillStyle = "#d6c6e3";
  g.fillText("Flies: " + planeName + (sum.favourite ? "   ·   Favourite: " + S().parseCourseName(sum.favourite.course_name).title : ""), 60, 240);
  const stats = [["RECORDS", sum.records], ["COURSES", sum.courses], ["RUNS", sum.runs], ["WINS", sum.wins]];
  stats.forEach(([k, v], i) => {
    const x = 60 + i * 200;
    g.fillStyle = "rgba(29,16,41,.8)"; g.fillRect(x, 290, 180, 110);
    g.fillStyle = "#a893bd"; g.font = "600 18px " + body; g.fillText(k, x + 16, 322);
    g.fillStyle = "#fff4ea"; g.font = "700 52px " + head; g.fillText(String(v), x + 16, 382);
  });
  const medals = [["#ffd23d", sum.medals.gold, "G"], ["#d9dde8", sum.medals.silver, "S"], ["#e39a5e", sum.medals.bronze, "B"]];
  medals.forEach(([col, n, l], i) => {
    const x = 90 + i * 150, y = 470;
    g.fillStyle = col; g.beginPath(); g.arc(x, y, 30, 0, Math.PI * 2); g.fill();
    g.fillStyle = "#1d1029"; g.font = "700 30px " + head; g.textAlign = "center"; g.fillText(l, x, y + 11);
    g.fillStyle = "#fff4ea"; g.textAlign = "left"; g.font = "700 44px " + head; g.fillText(String(n), x + 42, y + 16);
  });
  g.fillStyle = "#fff4ea"; g.font = "600 22px " + body; g.textAlign = "right";
  g.fillText("race.finsonly.net", W - 60, H - 50);
  g.textAlign = "left";
  return new Promise((resolve) => c.toBlob(resolve, "image/png"));
}

export async function mount(root, route, ctx) {
  const cs = route.id;
  ctx.setTitle(cs);
  const page = h("div", { class: "page" });
  root.appendChild(page);
  const body = h("div", { class: "block" }, h("div", { class: "skel skel-tall" }));
  page.appendChild(body);

  let data;
  try {
    // /pilots/{ident} only knows claimed callsigns; a 404 (or an old server) is just "boards only".
    const [b, recent, profile] = await Promise.all([allBoards(ctx.signal), recentRaces(ctx.signal).catch(() => []),
      api.pilot(cs, { signal: ctx.signal }).catch(() => null)]);
    data = { b, recent, profile };
  } catch (e) {
    if (ctx.signal.aborted) return () => {};
    clear(body).append(h("p", { class: "state-msg error", role: "alert" }, e && e.timeout ? "The server took too long. " : "Couldn't reach the server. ",
      retryRoute()));
    return () => {};
  }
  if (ctx.signal.aborted) return () => {};
  const sum = S().mergePilotProfile(S().pilotSummary(data.b.boards, data.b.courses, data.recent, cs), data.profile);
  if (!sum.pbs.length && !sum.lobbyRaces && !sum.claimed) {
    clear(body).append(h("h1", {}, cs), h("p", { class: "state-msg empty" }, "No times or races for “" + cs + "” yet. Callsigns are case-sensitive. ", h("a", { href: "#/records" }, "See everyone on the board")));
    return () => {};
  }

  const models = await modelsIndex(MODEL_BASE);
  const planeId = (models && models.assignments[cs]) || sum.lastModel;
  const planeName = (models && models.byId[planeId] && models.byId[planeId].name) || (planeId ? pretty(planeId) : "Stock F-16");

  const meBtn = h("button", { type: "button", class: "btn btn-ghost btn-sm" }, getMe() === cs ? "✓ This is me" : "This is me");
  meBtn.addEventListener("click", () => { setMe(cs); meBtn.textContent = "✓ This is me"; toast("Your medals will show on course cards"); });
  const dl = h("button", { type: "button", class: "btn btn-primary btn-sm" }, "Download card");
  dl.addEventListener("click", async () => {
    dl.disabled = true;
    try {
      const blob = await drawCard(sum, planeName);
      const a = h("a", { href: URL.createObjectURL(blob), download: "finsonly-" + S().slug(cs) + ".png" });
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } catch (e) { toast("Couldn't draw the card"); console.warn(e); }
    dl.disabled = false;
  });

  const card = h("section", { class: "license", "aria-label": "Pilot license" },
    h("div", { class: "license-photo" }, planeIcon()),
    h("div", {},
      h("span", { class: "eyebrow", text: "Pilot license" }),
      h("h1", {}, sum.callsign),
      h("p", { class: "dim" }, "Flies the ", h("strong", { text: planeName }), sum.lastSeen ? " · last seen " + S().timeAgo(sum.lastSeen) : "",
        sum.memberSince ? " · flying since " + S().fmtDate(sum.memberSince) : ""),
      h("dl", { class: "kv" },
        kv("Records held", String(sum.records)), kv("Medals", medalCounts(sum.medals)),
        kv("Courses", String(sum.courses)), kv("Runs", String(sum.runs)),
        kv("Lobby races", String(sum.lobbyRaces)), kv("Wins", String(sum.wins)),
        sum.recordsTaken != null ? kv("Records taken", String(sum.recordsTaken)) : null,
        kv("Favourite", sum.favourite ? link.course(sum.favourite.course_id, S().parseCourseName(sum.favourite.course_name).title) : "—")),
      h("div", { class: "btn-row" }, dl, meBtn)));

  const pbTable = sum.pbs.length ? sortableTable([
    { key: "course_name", label: "Course", defaultAsc: true, sort: (a, b) => a.course_name.localeCompare(b.course_name), cell: (r) => link.course(r.course_id, S().parseCourseName(r.course_name).title) },
    { key: "time_ms", label: "PB", num: true, defaultAsc: true, cell: (r) => h("span", { class: "t", text: S().fmtRaceTime(r.time_ms) }) },
    { key: "medal", label: "Medal", sort: (a, b) => (a.gap_ms / a.record_ms) - (b.gap_ms / b.record_ms), defaultAsc: true, cell: (r) => medal(r.medal) },
    { key: "rank", label: "Rank", num: true, defaultAsc: true, cell: (r) => r.rank + " / " + r.of },
    { key: "gap_ms", label: "To record", num: true, defaultAsc: true, cell: (r) => (r.rank === 1 ? h("span", { class: "good", text: "record" }) : h("span", { class: "t faint", text: S().fmtGap(r.gap_ms) })) },
    { key: "attempts", label: "Runs", num: true },
    { key: "set_at", label: "Set", cell: (r) => h("span", { class: "faint", text: S().fmtDate(r.set_at) }) },
    { key: "ghost", label: "Ghost", sort: false, cell: (r) => (r.has_ghost && r.course_id ? h("a", { href: S().buildRoute("replay", r.course_id, { pilots: [cs] }) }, "Watch") : "—") },
  ], sum.pbs, { sortKey: "course_name", asc: true, caption: "Personal bests" }) : h("p", { class: "state-msg empty" }, "No solo times yet.");

  const riv = S().rivals(data.b.boards, cs, data.b.courses);
  const h2h = riv.length ? h("ul", { class: "h2h" }, riv.map((r) => h("li", { class: "h2h-card" },
    h("div", { class: "cell-flex" }, h("span", { class: "faint", text: "vs" }), link.pilot(r.b)),
    h("div", { class: "h2h-score" }, h("span", { class: r.wins > r.losses ? "good" : r.wins < r.losses ? "bad" : "", text: r.wins + "–" + r.losses }), r.ties ? h("span", { class: "faint", text: " (" + r.ties + " tied)" }) : null),
    h("ul", {}, r.courses.slice(0, 4).map((c) => h("li", {}, (c.winner === cs ? "✓ " : c.winner ? "✗ " : "= ") + S().parseCourseName(c.course_name).title + " " + S().fmtGap(c.a_ms - c.b_ms))))))) :
    h("p", { class: "state-msg empty" }, "Nobody else has a time on the same courses yet.");

  const act = sum.activity.length ? h("ul", { class: "activity" }, sum.activity.map((a) => h("li", {},
    a.kind === "race"
      ? h("span", {}, (a.status === "finished" ? "P" + a.pos + " of " + a.of : "DNF") + " in a lobby race on ", h("strong", { text: S().parseCourseName(a.course_name).title }), a.cup_name ? " · " + a.cup_name : "")
      : h("span", {}, "Personal best on ", link.course(a.course_id, S().parseCourseName(a.course_name).title), " — ", h("span", { class: "t", text: S().fmtRaceTime(a.time_ms) }), " (rank " + a.rank + ")"),
    h("span", { class: "faint", text: a.at ? S().timeAgo(a.at) : "" })))) : h("p", { class: "state-msg empty" }, "Nothing yet.");

  clear(body).append(card,
    h("section", { class: "section", "aria-labelledby": "pb-h" }, h("div", { class: "section-head" }, h("h2", { id: "pb-h" }, "Personal bests")), h("div", { class: "panel panel-tight" }, pbTable)),
    h("section", { class: "section", "aria-labelledby": "h2h-h" }, h("div", { class: "section-head" }, h("h2", { id: "h2h-h" }, "Head to head"), h("p", { class: "section-sub" }, "Courses where both have a time; W–L by who is faster.")), h2h),
    h("section", { class: "section", "aria-labelledby": "act-h" }, h("div", { class: "section-head" }, h("h2", { id: "act-h" }, "Recent activity"), h("p", { class: "section-sub" }, "PBs and the last 100 lobby races.")), act));
  return () => {};
}
