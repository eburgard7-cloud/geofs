"""Run: cd race/test && python -m pytest test_gen_docs.py -q

docs/REFERENCE.md is generated from race.js / app.py by race/tools/gen_docs.py. These tests keep it
from going stale and pin the parsers against small fixtures, so a race.js refactor that the
generator no longer understands fails here instead of silently dropping a row.
"""
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "race" / "tools"))
import gen_docs  # noqa: E402


def test_reference_md_is_up_to_date():
    r = subprocess.run([sys.executable, str(REPO / "race" / "tools" / "gen_docs.py"), "--check"],
                       capture_output=True, text=True)
    assert r.returncode == 0, r.stderr + "\nRun: python race/tools/gen_docs.py"


def test_check_fails_on_a_stale_file(tmp_path, monkeypatch):
    stale = tmp_path / "REFERENCE.md"
    stale.write_text("# Reference\n\n" + gen_docs.BEGIN + "\nSTALE-SENTINEL\n" + gen_docs.END + "\n\nOutro.\n")
    monkeypatch.setattr(gen_docs, "REFERENCE_MD", stale)
    monkeypatch.setattr(gen_docs, "REPO_ROOT", tmp_path)
    assert gen_docs.main(["--check"]) == 1
    assert "STALE-SENTINEL" in stale.read_text()            # --check writes nothing
    assert gen_docs.main([]) == 0
    text = stale.read_text()
    assert text.startswith("# Reference\n\n") and text.endswith("\n\nOutro.\n")   # prose kept
    assert "## Shortcuts" in text and "STALE-SENTINEL" not in text
    assert gen_docs.main(["--check"]) == 0


def test_config_parser_reads_defaults_and_both_comment_styles():
    src = """
  const CONFIG = {
    VERSION: '1.2.3',
    MAX_SPEED_MS: 700,         // ~1360 kt. Faster = DQ
    TRACE_MAX_SAMPLES: 6000,   // hard cap; past it recording stops
                               // and the trace is truncated
    // Relay lobby (proto 2). A second sentence that is not shown.
    LOBBY: true,
    URL: 'https://a.b/c//d', // a URL with // inside the string
  };
"""
    rows = {r["key"]: r for r in gen_docs.parse_config(src)}
    assert list(rows) == ["VERSION", "MAX_SPEED_MS", "TRACE_MAX_SAMPLES", "LOBBY", "URL"]
    assert rows["VERSION"]["default"] == "'1.2.3'"
    assert rows["TRACE_MAX_SAMPLES"]["comment"] == "hard cap; past it recording stops and the trace is truncated"
    assert rows["URL"]["default"] == "'https://a.b/c//d'"
    table = gen_docs.config_table(list(rows.values()))
    assert "| `LOBBY` | `true` | Relay lobby (proto 2). |" in table


def test_hotkey_parser_finds_flags_and_the_shifted_binding():
    src = """
  const HOTKEY_ACTIONS = {
    KeyR: 'reset', KeyG: 'editorDrop', // KeyQ: 'commented out'
    KeyB: 'editorDropBox', KeyL: 'lineToggle', Digit1: 'useSlot1', KeyD: 'debugToggle',
  };
  function hotkeyAction(code, shiftKey) {
    if (shiftKey) return code === 'KeyB' ? 'editorDropBoxRow' : null;
    return HOTKEY_ACTIONS[code] || null;
  }
  const Actions = {
    defs: {
      reset: { run: () => Race.reset() },
      lineToggle: { when: () => CONFIG.RACING_LINE,
        run: () => {} },
      useSlot1: { when: () => CONFIG.POWERUPS, run: () => Powerups.useSlot(0) },
      debugToggle: { run: () => Debug.toggle() },
    },
  };
"""
    keys = gen_docs.parse_hotkeys(src)
    assert [k["code"] for k in keys] == ["KeyR", "KeyG", "KeyB", "Shift+KeyB", "KeyL", "Digit1", "KeyD"]
    flags = {k["code"]: k["flags"] for k in keys}
    assert flags["KeyL"] == ["RACING_LINE"] and flags["Digit1"] == ["POWERUPS"] and flags["KeyD"] == []
    assert gen_docs.key_label("Shift+KeyB") == "Alt+Shift+B" and gen_docs.key_label("Digit1") == "Alt+1"


def test_hotkey_parser_reads_the_shift_table():
    src = """
  const HOTKEY_ACTIONS = {
    KeyR: 'reset', KeyB: 'editorDropBox',
  };
  const HOTKEY_SHIFT_ACTIONS = { KeyB: 'editorDropBoxRow', KeyR: 'resetLayout' };
  function hotkeyAction(code, shiftKey) {
    const table = shiftKey ? HOTKEY_SHIFT_ACTIONS : HOTKEY_ACTIONS;
    return table[code] || null;
  }
"""
    keys = gen_docs.parse_hotkeys(src)
    assert [k["code"] for k in keys] == ["KeyR", "Shift+KeyR", "KeyB", "Shift+KeyB"]
    assert "| **Alt+Shift+R** | Reset layout" in gen_docs.hotkey_table(src, "", "")


def test_an_undocumented_hotkey_fails_loudly():
    src = ("const HOTKEY_ACTIONS = {\n  KeyQ: 'quit',\n};\n"
           "function hotkeyAction(code, shiftKey) {\n  return null;\n}\n")
    with pytest.raises(gen_docs.GenError, match="KeyQ"):
        gen_docs.hotkey_table(src, "", "")


def test_routes_use_the_docstring_and_fail_without_a_purpose():
    src = '''
from fastapi import FastAPI
app = FastAPI(title="x")

@app.get("/cups")
def cups_list():
    """Cups, newest first. More detail here."""

@app.get("/health")
def health():
    return {}
'''
    routes = gen_docs.parse_routes(src)
    assert routes[0] == {"method": "GET", "path": "/cups", "handler": "cups_list", "purpose": "Cups, newest first."}
    assert routes[1]["purpose"] == gen_docs.ROUTE_PURPOSES["/health"]
    assert [r["path"] for r in routes[2:]] == ["/docs", "/openapi.json"]
    with pytest.raises(gen_docs.GenError, match="/nowhere"):
        gen_docs.parse_routes('from x import app\n@app.get("/nowhere")\ndef f():\n    pass\n')


def test_env_parser_reads_defaults_and_owners():
    src = 'import os\nDB = os.environ.get("RACE_DB", "/data/race.db")\n' \
          'def d():\n    return os.environ.get("RACE_X")\n'
    rows = {r["name"]: r for r in gen_docs.parse_python_env(src, "app.py", {})}
    assert rows["RACE_DB"]["default"] == "`/data/race.db`" and "`DB`" in rows["RACE_DB"]["where"]
    assert rows["RACE_X"]["default"] == "*(none)*" and "`d()`" in rows["RACE_X"]["where"]
