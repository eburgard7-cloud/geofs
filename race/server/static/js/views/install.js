// /install — the draggable bookmarklet (GET /bookmarklet), controls, FAQ.

import { api } from "../api.js";
import { h, dataBlock } from "../ui.js";

// From docs/REFERENCE.md "Shortcuts" (generated from race.js). Alt + one key, ignored while typing.
const KEYS = [
  ["Alt+R", "Reset the run and re-arm it (a DNF mid lobby race)"],
  ["Alt+K", "Collapse / reopen the panel"],
  ["Alt+H", "Hide / show the race HUD"],
  ["Alt+L", "Show / hide the racing line"],
  ["Alt+1", "Loadout slot 1 (Speed Boost or Shield)"],
  ["Alt+2", "Loadout slot 2 (Speed Boost or Shield)"],
  ["Alt+3", "Fire the item from an item box"],
  ["Alt+Y", "Ready / not ready at the Gate"],
  ["Alt+G / Alt+U", "Course editor: drop a gate / undo it"],
  ["Alt+B", "Course editor: drop an item box (Shift: a row of three)"],
  ["Alt+D", "Debug overlay"],
  ["Esc", "Close the results card"],
];

const FAQ = [
  ["Do I need an extension or an account?", "No. It's one bookmark. Your callsign is whatever you type in the panel; the server remembers it for you in that browser."],
  ["I clicked the bookmark and nothing happened.", "It only works on a GeoFS tab (geo-fs.com) after your plane has loaded. Clicking it here does nothing on purpose."],
  ["My browser won't let me drag the button.", "Right-click the yellow button, copy the link, then add a new bookmark and paste it as the URL."],
  ["How do medals work?", "Relative to the course record: gold within 2 %, silver within 5 %, bronze within 10 %. Set “Show my medals” on the Courses page to see yours on every card."],
  ["What's a ghost?", "Your best run on a course, recorded 4 times a second. Race it in GeoFS, or watch any pilot's in the replay theater here."],
  ["Why does the 3D view look different from GeoFS?", "The site draws public satellite imagery and terrain, not GeoFS's own. Low courses can sit a little off the ground; the replay has a clamp for that."],
  ["Is my data shared anywhere?", "Times, ghosts and race results live on race.finsonly.net for this friend group. Lobby chat is never stored."],
];

export function mount(root, route, ctx) {
  ctx.setTitle("Install");
  const bm = h("div", { class: "block" });
  root.appendChild(h("div", { class: "page" },
    h("div", { class: "page-head" }, h("div", {}, h("span", { class: "eyebrow", text: "Get in the race" }), h("h1", {}, "Install"),
      h("p", {}, "One bookmark, no extension, no account. Works in Chrome, Edge and Firefox."))),
    h("div", { class: "panel cta-band" },
      h("ol", { class: "steps" },
        h("li", {}, h("span", { class: "step-n", text: "1" }), h("p", {}, "Show your bookmarks bar (Ctrl+Shift+B)."))),
      bm),
    h("section", { class: "section", "aria-labelledby": "how-h" }, h("div", { class: "section-head" }, h("h2", { id: "how-h" }, "First flight")),
      h("div", { class: "panel" }, h("ol", { class: "steps" },
        h("li", {}, h("span", { class: "step-n", text: "1" }), h("p", {}, "Open ", h("strong", {}, "GeoFS"), " and wait for your plane to load.")),
        h("li", {}, h("span", { class: "step-n", text: "2" }), h("p", {}, "Click the FINSONLY Racing bookmark. The race panel slides in.")),
        h("li", {}, h("span", { class: "step-n", text: "3" }), h("p", {}, "Solo: pick a course and fly through gate 1 to start the clock. With friends: Quick Match, or host a room and share its code.")),
        h("li", {}, h("span", { class: "step-n", text: "4" }), h("p", {}, "Finish, and your time — and ghost, if it's your best — lands on this site."))))),
    h("section", { class: "section", "aria-labelledby": "keys-h" }, h("div", { class: "section-head" }, h("h2", { id: "keys-h" }, "Controls")),
      h("div", { class: "panel panel-tight" }, h("div", { class: "table-wrap" }, h("table", { class: "data" },
        h("caption", { class: "visually-hidden", text: "Keyboard shortcuts" }),
        h("thead", {}, h("tr", {}, h("th", { scope: "col", text: "Key" }), h("th", { scope: "col", text: "Action" }))),
        h("tbody", {}, KEYS.map(([k, a]) => h("tr", {}, h("td", {}, k.split(" / ").map((x, i) => [i ? " / " : "", ...x.split("+").map((y, j) => [j ? "+" : "", h("kbd", { text: y })])])), h("td", { class: "wrap", text: a })))))))),
    h("section", { class: "section faq", "aria-labelledby": "faq-h" }, h("div", { class: "section-head" }, h("h2", { id: "faq-h" }, "FAQ")),
      FAQ.map(([q, a]) => h("details", {}, h("summary", { text: q }), h("p", { text: a }))))));
  const blk = dataBlock(bm, {
    load: (sg) => api.bookmarklet({ signal: sg }),
    error: "Couldn't build the bookmark.",
    render: (b) => {
      const a = h("a", { class: "bookmarklet", href: b.href, draggable: "true", title: "Drag me to your bookmarks bar" }, "★ " + (b.label || "FINSONLY Racing"));
      a.addEventListener("click", (e) => e.preventDefault());
      return h("div", {}, h("p", { class: "dim" }, "2. Drag this to the bar:"), a, h("p", { class: "bookmarklet-hint", text: "It's a real bookmarklet — clicking it here does nothing." }));
    },
  });
  return () => blk.destroy();
}
