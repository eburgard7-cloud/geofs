// 404: the goldfish took a wrong turn at gate 3.

import { h, s } from "../ui.js";

function goldfish() {
  return s("svg", { viewBox: "0 0 360 200", role: "img", "aria-label": "A small orange goldfish in a flight helmet, looking around, lost" },
    s("defs", {}, s("radialGradient", { id: "nfSun", cx: "50%", cy: "50%", r: "50%" },
      s("stop", { offset: "0%", "stop-color": "#ffd23d" }), s("stop", { offset: "100%", "stop-color": "#ffd23d", "stop-opacity": "0" }))),
    s("circle", { cx: 290, cy: 60, r: 60, fill: "url(#nfSun)", opacity: ".6" }),
    s("circle", { cx: 70, cy: 150, r: 26, fill: "none", stroke: "#ff3d8b", "stroke-width": 5, "stroke-dasharray": "10 8", opacity: ".7" }),
    s("text", { x: 70, y: 156, "text-anchor": "middle", fill: "#ff3d8b", "font-size": 16, "font-weight": 700, text: "3" }),
    s("path", { d: "M100 150 C 150 60, 210 170, 250 100", fill: "none", stroke: "#a893bd", "stroke-width": 2, "stroke-dasharray": "4 6" }),
    s("g", { transform: "translate(250 100) rotate(-12)" },
      s("path", { d: "M-44 0 L-64 -16 L-60 0 L-64 16 Z", fill: "#ff8a3d" }),
      s("ellipse", { cx: 0, cy: 0, rx: 46, ry: 26, fill: "#ff8a3d" }),
      s("path", { d: "M-6 -24 Q 6 -40 18 -22", fill: "#ffab73" }),
      s("path", { d: "M8 -22 A 26 22 0 0 1 40 -4 L 14 -4 Z", fill: "#3a2553", stroke: "#fff4ea", "stroke-width": 2 }),
      s("circle", { cx: 24, cy: -4, r: 6, fill: "#fff4ea" }), s("circle", { cx: 26, cy: -4, r: 3, fill: "#1d1029" }),
      s("path", { d: "M34 8 q 6 4 10 0", fill: "none", stroke: "#1d1029", "stroke-width": 2, "stroke-linecap": "round" })),
    s("text", { x: 300, y: 50, fill: "#fff4ea", "font-size": 30, "font-weight": 700, text: "?" }));
}

export function mount(root, route, ctx) {
  ctx.setTitle("Lost");
  root.appendChild(h("div", { class: "notfound page" },
    goldfish(),
    h("h1", {}, "404: off course"),
    h("p", {}, "Our goldfish missed gate 3 and has been circling ever since. It has a three-second memory, so it's already forgotten what it was looking for. Let's not make it two of you."),
    h("div", { class: "btn-row", "aria-label": "Ways back" },
      h("a", { class: "btn btn-primary", href: "#/" }, "Back to HQ"),
      h("a", { class: "btn btn-ghost", href: "#/courses" }, "Pick a course"))));
}
