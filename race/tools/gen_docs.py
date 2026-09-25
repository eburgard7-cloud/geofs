#!/usr/bin/env python3
"""Generate the reference tables in docs/REFERENCE.md from the code, so the docs can't drift.

Reads (never writes) race/race.js, race/tools/recorder.js, race/tools/probe.js,
race/server/app.py, race/server/migrate_modes.py and race/server/{redeploy,autodeploy}.sh, and
rewrites only the text between the GENERATED:BEGIN / GENERATED:END markers in docs/REFERENCE.md.
Hand-written prose outside the markers is kept as is.

Tables:
  1. Keyboard shortcuts: the onKeydown `act` map in race.js, the results-card Escape handler, and
     the two debug bookmarklets' own hotkeys.
  2. CONFIG: every key of `const CONFIG = {...}` in race.js, with its default and its comment.
  3. HTTP + WebSocket endpoints in app.py: method, path, and the handler docstring's first sentence.
  4. Environment variables: what the server reads (app.py, migrate_modes.py) and what the deploy
     scripts read, with defaults.

Usage:
    python race/tools/gen_docs.py            # rewrite docs/REFERENCE.md
    python race/tools/gen_docs.py --check    # exit 1 if docs/REFERENCE.md is stale, touch nothing

A new hotkey or an undocumented route fails loudly (KEY_ACTIONS / ROUTE_PURPOSES below need a line)
rather than shipping a blank cell.
"""
from __future__ import annotations

import argparse
import ast
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
RACE_JS = REPO_ROOT / "race" / "race.js"
RECORDER_JS = REPO_ROOT / "race" / "tools" / "recorder.js"
PROBE_JS = REPO_ROOT / "race" / "tools" / "probe.js"
APP_PY = REPO_ROOT / "race" / "server" / "app.py"
MIGRATE_PY = REPO_ROOT / "race" / "server" / "migrate_modes.py"
DEPLOY_SCRIPTS = [REPO_ROOT / "race" / "server" / "redeploy.sh", REPO_ROOT / "race" / "server" / "autodeploy.sh"]
REFERENCE_MD = REPO_ROOT / "docs" / "REFERENCE.md"

BEGIN = "<!-- GENERATED:BEGIN -->"
END = "<!-- GENERATED:END -->"

# What each race.js hotkey does, keyed by its KeyboardEvent.code (plus a "Shift+" prefix for the one
# shifted binding). The generator refuses to run if race.js binds a code that has no line here.
KEY_ACTIONS = {
    "KeyR": "Reset the run and re-arm it. Mid-race in a lobby race this reports a DNF",
    "KeyG": "Course editor: drop a gate at your position",
    "KeyU": "Course editor: undo the last draft gate",
    "KeyH": "Hide/show the race HUD (with `CONFIG.HUD` off, the panel instead)",
    "KeyK": "Collapse/reopen the panel. The reopen pill is hidden mid-race, so this is the way back in",
    "KeyB": "Course editor: drop an item box at your position",
    "Shift+KeyB": "Course editor: drop a row of three item boxes, 120 m apart across your heading",
    "KeyL": "Show/hide the racing line (remembered in this browser)",
    "Digit1": "Use loadout slot 1 (Speed Boost or Shield)",
    "Digit2": "Use loadout slot 2 (Speed Boost or Shield)",
    "Digit3": "Fire the item you got from an item box (does nothing while the slot is still spinning)",
    "KeyY": "Ready / not ready at the Gate",
    "KeyD": "Toggle the debug overlay (remembered in this browser). If the browser takes Alt+D first, run `__finsRace.debug.toggle()` in the console",
}

# Purpose lines for routes whose handler has no docstring. Anything with a docstring uses its first
# sentence instead; a route with neither makes the generator fail.
ROUTE_PURPOSES = {
    "/health": "Health check: `{ok, courses, tiles: {proxy, cache_writable, imagery}}`, where `courses` is how many courses the server loaded",
    "/runs": "Post a finished run (optionally with a ghost `trace`); returns rank and personal best",
    "/leaderboard": "Best time per callsign on one course (`course_hash`), each with `has_ghost`",
    "/modes": "The mode registry: every mode's metric, direction and payload schema",
    "/modes/{mode_id}/runs": "Post a run for a registered mode (`race` and `landing` answer 400 — they have their own write paths)",
    "/modes/{mode_id}/leaderboard": "One mode's board on one course, best first by the mode's direction",
    "/landings": "Score one landing attempt server-side against a known runway and store it",
    "/ws/race/{room}": "The race relay: lobby, items, results, chat, vote, rename, formation (see race/PROTOCOL.md)",
    "/ws/hub": "The hub: identity, presence, room registry, ping the ramp (see race/PROTOCOL.md, proto 5)",
}


class GenError(Exception):
    pass


def md_escape(text: str) -> str:
    return text.replace("|", "\\|").replace("\n", " ").strip()


# ----------------------------------------------------------------------------- race.js: CONFIG

def config_block(src: str) -> list[str]:
    lines = src.splitlines()
    try:
        start = next(i for i, ln in enumerate(lines) if re.match(r"\s*const CONFIG = \{\s*$", ln))
    except StopIteration:
        raise GenError("race.js: `const CONFIG = {` not found")
    indent = len(lines[start]) - len(lines[start].lstrip())
    for j in range(start + 1, len(lines)):
        ln = lines[j]
        if ln.strip() == "};" and len(ln) - len(ln.lstrip()) == indent:
            return lines[start + 1:j]
    raise GenError("race.js: end of the CONFIG block not found")


_ENTRY = re.compile(r"^(\s*)([A-Z][A-Z0-9_]*):\s*(.*)$")


def _split_value_comment(rest: str) -> tuple[str, str]:
    """Split `value,   // comment` outside string literals."""
    quote = None
    i = 0
    while i < len(rest):
        ch = rest[i]
        if quote:
            if ch == "\\":
                i += 2
                continue
            if ch == quote:
                quote = None
        elif ch in "'\"`":
            quote = ch
        elif rest.startswith("//", i):
            return rest[:i].strip(), rest[i + 2:].strip()
        i += 1
    return rest.strip(), ""


def _first_sentence(text: str, limit: int = 180) -> str:
    text = re.sub(r"\s+", " ", text).strip()
    m = re.search(r"(?<=[.!?])\s(?=[A-Z(\"'`])", text)
    if m:
        text = text[:m.start()]
    if len(text) > limit:
        cut = text.rfind(" ", 0, limit - 1)
        text = text[:cut if cut > 0 else limit - 1].rstrip(" ,;:—-") + "…"
    return text


def parse_config(src: str) -> list[dict]:
    rows: list[dict] = []
    pending: list[str] = []          # a comment block directly above the next key
    last = None                      # the previous row, for aligned comment continuations
    last_comment_col = None
    for ln in config_block(src):
        stripped = ln.strip()
        if not stripped:
            pending, last, last_comment_col = [], None, None
            continue
        if stripped.startswith("//"):
            col = ln.index("//")
            body = stripped[2:].strip()
            if last is not None and last_comment_col is not None and col == last_comment_col:
                last["comment"] = (last["comment"] + " " + body).strip()
                continue
            last, last_comment_col = None, None
            pending.append(re.sub(r"^-+\s*", "", body))
            continue
        m = _ENTRY.match(ln)
        if not m:
            raise GenError(f"race.js CONFIG: can't parse line {ln!r}")
        key, rest = m.group(2), m.group(3)
        value, comment = _split_value_comment(rest)
        value = value.rstrip(",").strip()
        row = {"key": key, "default": value, "comment": comment, "above": " ".join(pending).strip()}
        rows.append(row)
        pending = []
        last = row
        last_comment_col = ln.index("//", len(m.group(1)) + len(key)) if comment else None
    return rows


def config_table(rows: list[dict]) -> str:
    out = ["| Flag | Default | Comment in race.js |", "|---|---|---|"]
    for r in rows:
        if r["comment"]:
            note = r["comment"]
        elif r["above"]:
            note = _first_sentence(r["above"])
        else:
            note = ""
        out.append(f"| `{r['key']}` | `{md_escape(r['default'])}` | {md_escape(note)} |")
    return "\n".join(out)


# ----------------------------------------------------------------------------- race.js: hotkeys

def _function_body(src: str, header_re: str) -> list[tuple[int, str]]:
    lines = src.splitlines()
    start = next((i for i, ln in enumerate(lines) if re.search(header_re, ln)), None)
    if start is None:
        raise GenError(f"race.js: {header_re!r} not found")
    depth, body = 0, []
    for i in range(start, len(lines)):
        body.append((i, lines[i]))
        depth += lines[i].count("{") - lines[i].count("}")
        if i > start and depth <= 0:
            return body
    raise GenError(f"race.js: unterminated {header_re!r}")


def parse_hotkeys(src: str) -> list[dict]:
    body = _function_body(src, r"const onKeydown = \(e\) => \{")
    text = "\n".join(ln for _, ln in body)
    shifted = set(re.findall(r"e\.shiftKey && e\.code !== '(\w+)'", text))
    keys: list[dict] = []
    seen = set()
    stack: list[tuple[int, str]] = []    # (brace depth when opened, flag) for `if (CONFIG.X) {`
    depth = 0
    for _, ln in body:
        code_part = ln.split("//", 1)[0]
        cond_inline = re.search(r"if \(CONFIG\.(\w+)\)", code_part)
        flags = [f for _, f in stack]
        if cond_inline and not code_part.rstrip().endswith("{"):
            flags = flags + [cond_inline.group(1)]
        for code in re.findall(r"(?:\bact\.|[{,]\s*|^\s*)((?:Key[A-Z]|Digit\d))\s*[:=]", code_part):
            if code in seen:
                continue
            seen.add(code)
            keys.append({"code": code, "flags": flags})
        opened = code_part.count("{")
        closed = code_part.count("}")
        if cond_inline and code_part.rstrip().endswith("{"):
            stack.append((depth, cond_inline.group(1)))
        depth += opened - closed
        while stack and depth <= stack[-1][0]:
            stack.pop()
    for code in sorted(shifted):
        if code in seen:
            base = next(k for k in keys if k["code"] == code)
            keys.insert(keys.index(base) + 1, {"code": "Shift+" + code, "flags": base["flags"]})
    if not keys:
        raise GenError("race.js: no hotkeys found in onKeydown")
    return keys


def key_label(code: str) -> str:
    shift = code.startswith("Shift+")
    code = code.removeprefix("Shift+")
    name = code[3:] if code.startswith("Key") else code[5:]
    return "Alt+" + ("Shift+" if shift else "") + name


def hotkey_table(race_src: str, recorder_src: str, probe_src: str) -> str:
    keys = parse_hotkeys(race_src)
    missing = [k["code"] for k in keys if k["code"] not in KEY_ACTIONS]
    if missing:
        raise GenError("race.js binds hotkeys with no KEY_ACTIONS line in gen_docs.py: " + ", ".join(missing))
    out = ["| Key | Action | Where defined |", "|---|---|---|"]
    for k in keys:
        where = "`race.js` `onKeydown`"
        if k["flags"]:
            where += " (only with " + ", ".join(f"`CONFIG.{f}`" for f in k["flags"]) + ")"
        out.append(f"| **{key_label(k['code'])}** | {md_escape(KEY_ACTIONS[k['code']])} | {where} |")
    if re.search(r"ev\.key === 'Escape'\) Results\.close\(\)", race_src):
        out.append("| **Esc** | Close the results card | `race.js` results overlay keydown |")
    rec = re.search(r"e\.key !== '(\w)' && e\.key !== '\w'\)\) return;\s*\n\s*if \(state\.running\) stop\(\); else start\(\);", recorder_src)
    if rec and "e.altKey" in recorder_src:
        out.append(f"| **Alt+{rec.group(1).upper()}** | Recorder bookmarklet: start/stop a 20 Hz landing capture | `tools/recorder.js` (RECORDER line only) |")
    prb = re.search(r"e\.key !== '(\w)' && e\.key !== '\w'\)\) return;\s*\n\s*if \(state\.running\) stop\(\); else start\(\);", probe_src)
    if prb and "e.altKey" in probe_src:
        out.append(f"| **Alt+{prb.group(1).upper()}** | Probe bookmarklet: start/stop its landing sampler. Same key as the racing line if both are loaded | `tools/probe.js` (PROBE line only) |")
    return "\n".join(out)


# ----------------------------------------------------------------------------- app.py: routes

def _docstring_purpose(fn: ast.AST) -> str:
    doc = ast.get_docstring(fn)
    if not doc:
        return ""
    para = doc.strip().split("\n\n", 1)[0]
    return _first_sentence(para, limit=160)


def parse_routes(app_src: str) -> list[dict]:
    tree = ast.parse(app_src)
    routes = []
    for node in tree.body:
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        for dec in node.decorator_list:
            if not (isinstance(dec, ast.Call) and isinstance(dec.func, ast.Attribute)
                    and isinstance(dec.func.value, ast.Name) and dec.func.value.id == "app"):
                continue
            method = dec.func.attr
            if method not in ("get", "post", "put", "delete", "patch", "websocket"):
                continue
            path = dec.args[0].value if dec.args and isinstance(dec.args[0], ast.Constant) else None
            if path is None:
                raise GenError(f"app.py: route on {node.name} has a non-literal path")
            purpose = _docstring_purpose(node) or ROUTE_PURPOSES.get(path, "")
            if not purpose:
                raise GenError(f"app.py: {method.upper()} {path} has no docstring and no ROUTE_PURPOSES line")
            routes.append({"method": "WS" if method == "websocket" else method.upper(), "path": path,
                           "handler": node.name, "purpose": purpose})
    MOUNT_PURPOSES = {
        "/": "The public site, race/server/static/ (index.html, site.css, site.js)",
        "/models": "Ghost models (race/models/*.glb, index.json, assignments.json), same-origin so "
                   "the CSP's connect-src 'self' covers config.js's MODEL_BASE",
    }
    for node in ast.walk(tree):
        if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "mount"
                and isinstance(node.func.value, ast.Name) and node.func.value.id == "app"
                and node.args and isinstance(node.args[0], ast.Constant)):
            path = node.args[0].value
            purpose = MOUNT_PURPOSES.get(path)
            if not purpose:
                raise GenError(f"app.py: app.mount({path!r}, ...) has no MOUNT_PURPOSES entry in gen_docs.py")
            routes.append({"method": "GET", "path": path, "handler": "StaticFiles", "purpose": purpose})
    docs_off = re.search(r"FastAPI\([^)]*docs_url\s*=\s*None", app_src)
    if not docs_off:
        routes.append({"method": "GET", "path": "/docs", "handler": "FastAPI default",
                       "purpose": "FastAPI's interactive API docs (Swagger UI), generated from the routes above"})
        routes.append({"method": "GET", "path": "/openapi.json", "handler": "FastAPI default",
                       "purpose": "The OpenAPI schema behind /docs"})
    return routes


def routes_table(routes: list[dict]) -> str:
    out = ["| Method | Path | Purpose | Handler |", "|---|---|---|---|"]
    for r in routes:
        out.append(f"| {r['method']} | `{r['path']}` | {md_escape(r['purpose'])} | `{r['handler']}` |")
    return "\n".join(out)


# ----------------------------------------------------------------------------- env vars

def _env_call(node: ast.AST):
    """os.environ.get("X", d) / os.getenv("X", d) -> (name, default node or None)."""
    if not isinstance(node, ast.Call) or not node.args or not isinstance(node.args[0], ast.Constant):
        return None
    f = node.func
    is_get = (isinstance(f, ast.Attribute) and f.attr == "get" and isinstance(f.value, ast.Attribute)
              and f.value.attr == "environ")
    is_getenv = isinstance(f, ast.Attribute) and f.attr == "getenv"
    if not (is_get or is_getenv):
        return None
    return node.args[0].value, (node.args[1] if len(node.args) > 1 else None)


def parse_python_env(src: str, filename: str, fallbacks: dict[str, str]) -> list[dict]:
    tree = ast.parse(src)
    found: dict[str, dict] = {}

    def visit(node, owner):
        for child in ast.iter_child_nodes(node):
            name = owner
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                name = child.name + "()"
            elif isinstance(child, ast.Assign) and owner is None:
                targets = [t.id for t in child.targets if isinstance(t, ast.Name)]
                name = targets[0] if targets else None
            hit = _env_call(child)
            if hit and hit[0] not in found:
                var, default = hit
                if default is None:
                    dflt = fallbacks.get(var, "*(none)*")
                else:
                    try:
                        lit = ast.literal_eval(default)
                        # An empty-string default means "unset" (e.g. RACE_ADMIN_TOKEN), not ``.
                        dflt = "*(unset)*" if lit == "" else "`" + str(lit) + "`"
                    except ValueError:
                        dflt = "`" + ast.unparse(default) + "`"
                found[var] = {"name": var, "default": dflt, "where": f"`{filename}` {('`' + owner + '`') if owner else ''}".strip()}
            visit(child, name)

    visit(tree, None)
    return list(found.values())


_SH_ENV = re.compile(r"\$\{(RACE_[A-Z0-9_]+):-([^}]*)\}")


# A `${VAR:-}` whose real default is computed a few lines later in the script.
SHELL_COMPUTED_DEFAULTS = {"RACE_REPO": "parsed from `git remote get-url origin`"}


def parse_shell_env(path: Path) -> list[dict]:
    rows: dict[str, dict] = {}
    for m in _SH_ENV.finditer(path.read_text(encoding="utf-8")):
        name, default = m.group(1), m.group(2)
        if name not in rows:
            shown = f"`{default}`" if default else SHELL_COMPUTED_DEFAULTS.get(name, "*(empty)*")
            rows[name] = {"name": name, "default": shown,
                          "where": f"`{path.name}`"}
        elif rows[name]["where"].find(path.name) < 0:
            rows[name]["where"] += f", `{path.name}`"
    return list(rows.values())


def env_table(rows: list[dict]) -> str:
    out = ["| Variable | Default | Read by |", "|---|---|---|"]
    for r in sorted(rows, key=lambda r: r["name"]):
        out.append(f"| `{r['name']}` | {md_escape(r['default'])} | {r['where']} |")
    return "\n".join(out)


# ----------------------------------------------------------------------------- assemble

def generate() -> str:
    race_src = RACE_JS.read_text(encoding="utf-8")
    app_src = APP_PY.read_text(encoding="utf-8")
    courses_default = ("`/app/courses` if it exists, else the checkout's `race/courses` "
                       "(the image sets it to `/app/courses`)")
    bookmarklet_default = ("`/app/bookmarklet.txt` if it exists, else the checkout's "
                           "`race/bookmarklet.txt`")
    tile_cache_default = "a `tiles/` dir next to `RACE_DB`"
    server_env = parse_python_env(app_src, "app.py", {"RACE_COURSES_DIR": courses_default,
                                                      "RACE_BOOKMARKLET_PATH": bookmarklet_default,
                                                      "RACE_TILE_CACHE_DIR": tile_cache_default})
    names = {r["name"] for r in server_env}
    for r in parse_python_env(MIGRATE_PY.read_text(encoding="utf-8"), "migrate_modes.py", {}):
        if r["name"] in names:
            next(x for x in server_env if x["name"] == r["name"])["where"] += ", " + r["where"]
        else:
            server_env.append(r)
    script_env: dict[str, dict] = {}
    for p in DEPLOY_SCRIPTS:
        for r in parse_shell_env(p):
            if r["name"] in script_env:
                script_env[r["name"]]["where"] += ", " + r["where"]
            else:
                script_env[r["name"]] = r
    config_rows = parse_config(race_src)
    parts = [
        BEGIN,
        "<!-- Generated by race/tools/gen_docs.py from race/race.js, race/tools/{recorder,probe}.js,",
        "     race/server/app.py, race/server/migrate_modes.py and race/server/*.sh. Do not edit by hand:",
        "     run `python race/tools/gen_docs.py` instead. -->",
        "",
        "## Shortcuts",
        "",
        "Every race hotkey except Esc is Alt plus one key. They're ignored while you're typing in a text",
        "box. Chrome's own Alt+E and Alt+F are left alone on purpose. Some browsers take Alt+D for the",
        "address bar first.",
        "",
        hotkey_table(race_src, RECORDER_JS.read_text(encoding="utf-8"), PROBE_JS.read_text(encoding="utf-8")),
        "",
        "## Config",
        "",
        f"All {len(config_rows)} keys of `CONFIG` at the top of `race/race.js`, in file order. The comment",
        "is the one on the key's own line. If the key has none, it's the first sentence of the block",
        "comment above it.",
        "",
        config_table(config_rows),
        "",
        "## Endpoints",
        "",
        "Every route in `race/server/app.py`, in file order. The purpose is the handler docstring's",
        "first sentence. WebSocket frames are specified in [race/PROTOCOL.md](../race/PROTOCOL.md).",
        "",
        routes_table(parse_routes(app_src)),
        "",
        "## Environment variables",
        "",
        "### Server",
        "",
        "Read by the FastAPI app (and its migration script) at startup. The Dockerfile sets `RACE_DB`,",
        "`RACE_COURSES_DIR` and `RACE_GIT_SHA` in the image.",
        "",
        env_table(server_env),
        "",
        "### Deploy scripts",
        "",
        "Read by `race/server/redeploy.sh` and `race/server/autodeploy.sh` on the Unraid box.",
        "",
        env_table(list(script_env.values())),
        END,
    ]
    return "\n".join(parts)


DEFAULT_PROSE_TOP = """# Reference

Generated tables for FINSONLY Racing: hotkeys, `CONFIG` flags, server endpoints and environment
variables. Everything between the `GENERATED` markers is rebuilt from the code by
`python race/tools/gen_docs.py`, and `--check` fails when it's stale.

"""


def render(existing: str | None, block: str) -> str:
    if existing is None:
        return DEFAULT_PROSE_TOP + block + "\n"
    if BEGIN not in existing or END not in existing:
        raise GenError(f"{REFERENCE_MD.relative_to(REPO_ROOT)} has no {BEGIN} / {END} markers")
    head, rest = existing.split(BEGIN, 1)
    _, tail = rest.split(END, 1)
    return head + block + tail


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    ap.add_argument("--check", action="store_true", help="Exit 1 if docs/REFERENCE.md is stale; write nothing.")
    args = ap.parse_args(argv)
    try:
        block = generate()
        existing = REFERENCE_MD.read_text(encoding="utf-8") if REFERENCE_MD.exists() else None
        new = render(existing, block)
    except GenError as e:
        print(f"gen_docs: {e}", file=sys.stderr)
        return 2
    rel = REFERENCE_MD.relative_to(REPO_ROOT)
    if args.check:
        if existing != new:
            print(f"gen_docs: {rel} is stale. Run: python race/tools/gen_docs.py", file=sys.stderr)
            return 1
        print(f"gen_docs: {rel} is up to date.")
        return 0
    if existing == new:
        print(f"gen_docs: {rel} already up to date.")
        return 0
    REFERENCE_MD.parent.mkdir(parents=True, exist_ok=True)
    REFERENCE_MD.write_text(new, encoding="utf-8", newline="\n")
    print(f"gen_docs: wrote {rel}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
