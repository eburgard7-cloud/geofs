"""Tests for race/tools/check_addons.py (offline — no network)."""
import copy
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "tools"))
import check_addons  # noqa: E402

GOOD = {
    "id": "fpv", "name": "FPV", "repo": "someone/GeoFS-FPV", "sha": "a" * 40,
    "url": "https://cdn.jsdelivr.net/gh/someone/GeoFS-FPV@" + "a" * 40 + "/userscript.js",
    "physics": False, "default": False,
    "hotkeys": [{"combo": "L", "action": "toggle", "strict_modifiers": False}], "notes": "",
}


def test_real_manifest_is_valid():
    entries = json.loads(check_addons.ADDONS_PATH.read_text(encoding="utf-8"))
    assert check_addons.validate(entries) == []
    ids = {e["id"] for e in entries}
    assert ids == {"flight-path-vector", "sky-dolly", "camera-cycling", "information-display", "cockpit-volume", "gpws-callouts"}
    assert all(e["default"] is False for e in entries)


def test_good_entry_validates():
    assert check_addons.validate([GOOD]) == []


def test_schema_rejects_bad_fields():
    for mutate, needle in [
        (lambda e: e.pop("sha"), "missing"),
        (lambda e: e.update(extra=1), "unknown fields"),
        (lambda e: e.update(sha="abc"), "sha"),
        (lambda e: e.update(url="https://raw.githack.com/x/y/main/a.js"), "url"),
        (lambda e: e.update(default=True), "default"),
        (lambda e: e.update(physics="no"), "physics"),
        (lambda e: e.update(repo="noslash"), "repo"),
        (lambda e: e.update(id="Bad Id"), "id"),
        (lambda e: e.update(hotkeys=[{"combo": "Hyper+Q", "action": "", "strict_modifiers": True}]), "combo"),
        (lambda e: e.update(hotkeys=[{"combo": "Q"}]), "hotkey 0"),
    ]:
        e = copy.deepcopy(GOOD)
        mutate(e)
        errs = check_addons.validate([e])
        assert errs and any(needle in x for x in errs), (needle, errs)


def test_duplicate_ids_rejected():
    assert any("duplicate" in x for x in check_addons.validate([GOOD, copy.deepcopy(GOOD)]))


def test_empty_manifest_rejected():
    assert check_addons.validate([]) and check_addons.validate({})


def test_parse_combo():
    assert check_addons.parse_combo("Alt+Shift+B") == (frozenset({"Alt", "Shift"}), "B")
    assert check_addons.parse_combo("w") == (frozenset(), "W")
    assert check_addons.parse_combo("Insert") == (frozenset(), "Insert")
    assert check_addons.parse_combo("Alt+Alt+B") is None
    assert check_addons.parse_combo("") is None


def test_race_hotkeys_from_real_race_js():
    keys = check_addons.race_hotkeys(check_addons.RACE_JS.read_text(encoding="utf-8"))
    for k in ("Alt+R", "Alt+G", "Alt+U", "Alt+H", "Alt+B", "Alt+L", "Alt+1", "Alt+2", "Alt+3", "Alt+Y", "Alt+D", "Alt+Shift+B"):
        assert k in keys, k


def test_race_hotkeys_fixture():
    src = """
  const onKeydown = (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey || (e.shiftKey && e.code !== 'KeyB')) return;
    const act = { KeyR: () => 1, KeyB: () => 2 };
    act.Digit1 = () => 3;
  };
"""
    assert check_addons.race_hotkeys(src) == {"Alt+R", "Alt+B", "Alt+1", "Alt+Shift+B"}


def test_collisions_loose_exact_and_strict():
    race = {"Alt+L", "Alt+R", "Alt+Shift+B"}
    loose = copy.deepcopy(GOOD)
    assert check_addons.collisions([loose], race) == [{"addon": "fpv", "combo": "L", "race": "Alt+L", "kind": "loose"}]
    strict = copy.deepcopy(GOOD)
    strict["hotkeys"][0]["strict_modifiers"] = True
    assert check_addons.collisions([strict], race) == []
    exact = copy.deepcopy(GOOD)
    exact["hotkeys"] = [{"combo": "Alt+R", "action": "x", "strict_modifiers": True}]
    assert check_addons.collisions([exact], race)[0]["kind"] == "exact"
    shifted = copy.deepcopy(GOOD)
    shifted["hotkeys"] = [{"combo": "Shift+B", "action": "x", "strict_modifiers": False}]
    assert check_addons.collisions([shifted], race)[0]["race"] == "Alt+Shift+B"
    other = copy.deepcopy(GOOD)
    other["hotkeys"] = [{"combo": "I", "action": "x", "strict_modifiers": False}]
    assert check_addons.collisions([other], race) == []


def test_main_offline_exit_codes(tmp_path, capsys):
    good = tmp_path / "a.json"
    good.write_text(json.dumps([GOOD]))
    assert check_addons.main(["--addons", str(good), "--offline"]) == 0
    assert check_addons.main(["--addons", str(good), "--offline", "--strict"]) == 1  # L vs Alt+L
    bad = tmp_path / "b.json"
    bad.write_text(json.dumps([dict(GOOD, default=True)]))
    assert check_addons.main(["--addons", str(bad), "--offline"]) == 1
    assert check_addons.main(["--addons", str(good), "--offline", "--json"]) == 0
    out = capsys.readouterr().out
    assert '"collisions"' in out


def test_sha_exists_reports_unverified_without_network(monkeypatch):
    def boom(*a, **k):
        raise OSError("no network")
    monkeypatch.setattr(check_addons.urllib.request, "urlopen", boom)
    monkeypatch.setattr(check_addons.subprocess, "run", boom)
    assert check_addons.sha_exists("a/b", "a" * 40) == "unverified"
