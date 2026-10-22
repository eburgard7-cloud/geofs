// #/garage/admin — the livery review queue (GET /admin/liveries/pending, POST
// /admin/liveries/{id}/approve | reject). The admin token is RACE_ADMIN_TOKEN, asked for once per
// tab and kept in sessionStorage (js/garage.js). Approve makes an upload visible to everyone (live
// rooms are told); reject records the reason the owner sees, unequips it for everyone and deletes
// the file.

import { garageApi } from "../api.js";
import { h, clear, toast, skeleton, chip, link } from "../ui.js";
import { loadAdminToken, saveAdminToken, clearAdminToken, errText, liveryMedia } from "../garage.js";

const S = () => window.FinsSite;

export function mount(root, route, ctx) {
  ctx.setTitle("Livery review");
  const signal = ctx.signal;
  const body = h("div", {});
  const forget = h("button", { type: "button", class: "btn btn-ghost", onClick: () => { clearAdminToken(); ask("Token forgotten for this tab."); } }, "Forget token");
  root.appendChild(h("div", { class: "page garage" },
    h("div", { class: "page-head" },
      h("div", {}, h("span", { class: "eyebrow", text: "Garage admin" }), h("h1", {}, "Livery review"),
        h("p", {}, "Uploads wait here until you approve them. The owner can fly a pending one; nobody else sees it until it's approved.")),
      forget),
    body));
  let cat = null;
  garageApi.catalog({ signal }).then((c) => { cat = c; }).catch(() => {});
  const acLabel = (ac) => S().garageAircraftLabel(ac, cat && cat.aircraft);

  function ask(msg) {
    forget.hidden = true;
    const input = h("input", { type: "password", id: "gx-admin-tok", autocomplete: "off", spellcheck: "false", class: "gx-wide-input" });
    const err = h("p", { class: "gx-err", role: "alert", text: msg || "" });
    clear(body).appendChild(h("section", { class: "panel gx-signin", "aria-labelledby": "gx-admin-h" },
      h("h2", { id: "gx-admin-h" }, "Admin token"),
      h("p", { class: "dim" }, "The server's RACE_ADMIN_TOKEN. It's kept for this tab only and sent only to this server."),
      h("form", { class: "gx-signin-form", onSubmit: (e) => {
        e.preventDefault();
        const tok = input.value.trim();
        if (!tok) { err.textContent = "Paste the token first."; return; }
        saveAdminToken(tok);
        load();
      } },
      h("label", { for: "gx-admin-tok", class: "gx-label" }, "Token"),
      h("div", { class: "gx-code-row" }, input, h("button", { type: "submit", class: "btn btn-primary" }, "Open the queue")),
      err)));
    input.focus();
  }

  function failed(e) {
    if (e && e.status === 401) { clearAdminToken(); ask("That token didn't work."); return true; }
    return false;
  }

  async function load() {
    const tok = loadAdminToken();
    if (!tok) { ask(); return; }
    forget.hidden = false;
    clear(body).appendChild(skeleton("cards", 2));
    let res;
    try {
      res = await garageApi.adminPending(tok, { signal });
    } catch (e) {
      if (signal.aborted || failed(e)) return;
      clear(body).appendChild(h("p", { class: "state-msg " + (e && e.status === 404 ? "unavailable" : "error"), role: "alert" },
        e && e.status === 404 ? "This server doesn't have livery review yet." : errText(e), " ",
        h("button", { type: "button", class: "btn-link", onClick: load }, "Try again")));
      return;
    }
    const list = (res && res.pending) || [];
    const count = h("p", { class: "gx-limits", role: "status" });
    const ul = h("ul", { class: "gx-review" });
    const setCount = () => {
      const n = ul.children.length;
      count.textContent = n ? n + " waiting" : "";
      if (!n) ul.replaceWith(h("p", { class: "state-msg empty" }, "Nothing waiting. Every upload has been looked at."));
    };
    for (const item of list) ul.appendChild(row(item, tok, setCount));
    clear(body).append(count, h("div", { class: "btn-row" }, h("button", { type: "button", class: "btn btn-ghost", onClick: load }, "Refresh")), ul);
    setCount();
  }

  function row(item, tok, after) {
    const reason = h("input", { type: "text", maxlength: "200", placeholder: "What's wrong, in a few words (the pilot sees this)",
      id: "gx-r-" + item.id.replace(/\W/g, ""), autocomplete: "off" });
    const status = h("p", { class: "gx-err", role: "alert" });
    const approve = h("button", { type: "button", class: "btn btn-primary" }, "Approve");
    const reject = h("button", { type: "button", class: "btn btn-ghost gx-danger", disabled: true }, "Reject");
    reason.addEventListener("input", () => { reject.disabled = !reason.value.trim(); });
    const li = h("li", { class: "panel gx-review-item" },
      h("div", { class: "gx-review-head" },
        h("h2", {}, item.name || "Untitled"),
        h("div", { class: "sheet-chips" }, chip(acLabel(item.aircraft)), chip(item.kind === "upload" ? "Upload" : "Recolor"), chip("Pending", "medium"))),
      h("p", { class: "dim" }, "From ", item.callsign ? link.pilot(item.callsign) : h("span", { text: "an unknown pilot" }),
        item.created_at ? " · " + S().timeAgo(item.created_at) : "",
        item.template ? " · template " + item.template : ""),
      liveryMedia(item.blueprint_url, item.urls && item.urls[0], { name: item.name }),
      h("div", { class: "gx-field" }, h("label", { for: reason.id, class: "gx-label" }, "Reason, if you reject it"), reason),
      status,
      h("div", { class: "btn-row" }, approve, reject));
    const act = async (btn, fn, done) => {
      approve.disabled = reject.disabled = true;
      status.textContent = "";
      const label = btn.textContent;
      btn.textContent = "Working…";
      try {
        const r = await fn();
        toast(done(r));
        li.remove();
        after();
      } catch (e) {
        if (signal.aborted || failed(e)) return;
        btn.textContent = label;
        approve.disabled = false;
        reject.disabled = !reason.value.trim();
        status.textContent = errText(e);
      }
    };
    approve.addEventListener("click", () => act(approve, () => garageApi.adminApprove(tok, item.id, { signal }),
      () => "Approved: everyone sees " + (item.name || "it") + " now"));
    reject.addEventListener("click", () => act(reject, () => garageApi.adminReject(tok, item.id, reason.value.trim(), { signal }),
      (r) => "Rejected" + (r && r.unequipped ? "; taken off " + r.unequipped + " jet" + (r.unequipped === 1 ? "" : "s") : "")));
    return li;
  }

  load();
  return () => {};
}
