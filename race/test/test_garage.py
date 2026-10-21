"""Liveries and the Garage (server 1.9.0, relay proto 12): packaging, serving, identity, equips,
unlocks, recolor, uploads, admin review and the relay's livery frames.

Run: cd race/server && RACE_DB=/tmp/race-test.db python -m pytest ../test/test_server.py ../test/test_dash.py ../test/test_garage.py -q
"""
import os, sys
import hashlib
import json
os.environ.setdefault("RACE_DB", "/tmp/race-test.db")
os.environ.setdefault("RACE_MIN_INTERVAL_S", "0")
os.environ.setdefault("RACE_GET_MIN_INTERVAL_S", "0")
os.environ.setdefault("RACE_CLAIM_MIN_INTERVAL_S", "0")
os.environ.setdefault("RACE_TILE_WARM", "0")
os.environ.setdefault("RACE_COURSES_DIR", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "courses"))
HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.normpath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, os.path.join(HERE, "..", "server"))
import pytest
from fastapi.testclient import TestClient
import app as appmod
import garage


# =============================================================================== packaging
def test_default_dirs_find_the_checkouts_liveries_and_tools_side_by_side():
    assert os.path.samefile(appmod.LIVERIES_DIR, os.path.join(REPO, "liveries"))
    assert os.path.samefile(appmod.LIVERY_TOOLS_DIR, os.path.join(REPO, "tools"))
    assert garage.tools_problem(appmod.LIVERY_TOOLS_DIR, appmod.LIVERIES_DIR) is None
    # customs follow race.db, like the tile cache
    assert appmod.LIVERY_DATA_DIR == os.path.normpath(
        os.path.join(os.path.dirname(os.path.abspath(appmod.DB_PATH)), "liveries"))


def test_tools_problem_names_a_split_deploy(tmp_path):
    (tmp_path / "tools").mkdir()
    (tmp_path / "elsewhere").mkdir()
    msg = garage.tools_problem(str(tmp_path / "tools"), str(tmp_path / "elsewhere"))
    assert msg and "RACE_LIVERIES_DIR" in msg


def test_catalog_loads_and_indexes_every_file_by_content():
    with TestClient(appmod.app):
        cat = appmod.LIVERY_CATALOG
        assert cat is not None and len(cat) >= 100
        assert "liveries" in appmod.SERVER_FEATURES and "garage" in appmod.SERVER_FEATURES
        e = next(x for x in cat.raw["liveries"] if x["id"] == "f16_season_2026_fall")
        path = os.path.join(REPO, e["files"][0])
        sha = hashlib.sha256(open(path, "rb").read()).hexdigest()
        assert cat.urls[e["id"]] == [f"/liveries/files/{sha}.webp"]
        assert cat.files[sha]["aircraft"] == "f16" and cat.files[sha]["main"]
        # Rafale entries carry [main, spec]: two urls, only the first is the main texture
        raf = next(x for x in cat.raw["liveries"] if x["aircraft"] == "rafale" and len(x["files"]) == 2)
        assert len(cat.urls[raf["id"]]) == 2
        assert not cat.files[cat.shas[raf["id"]][1]]["main"]


def test_catalog_refuses_paths_outside_its_root_and_missing_files(tmp_path):
    liv = tmp_path / "liveries"
    liv.mkdir()
    (tmp_path / "ok.png").write_bytes(b"\x89PNG fake")
    (tmp_path / "secret.txt").write_text("no")
    (liv / "catalog.json").write_text(json.dumps({"aircraft": {"f16": {}}, "liveries": [
        {"id": "good", "aircraft": "f16", "category": "starter", "files": ["ok.png"], "requires": None},
        {"id": "escape", "aircraft": "f16", "category": "starter", "files": ["../../etc/passwd.png"], "requires": None},
        {"id": "notex", "aircraft": "f16", "category": "starter", "files": ["secret.txt"], "requires": None},
        {"id": "gone", "aircraft": "f16", "category": "starter", "files": ["missing.png"], "requires": None},
    ]}))
    cat = garage.load_catalog(str(liv), {})
    assert cat.urls["good"] and cat.urls["escape"] is None and cat.urls["notex"] is None and cat.urls["gone"] is None
    assert len(cat.files) == 1


def test_a_failed_catalog_reload_keeps_the_last_good_one(monkeypatch):
    with TestClient(appmod.app):
        before = appmod.LIVERY_CATALOG
        monkeypatch.setattr(appmod, "_livery_catalog_mtime", -1.0)
        monkeypatch.setattr(garage, "load_catalog", lambda *a: (_ for _ in ()).throw(ValueError("half-pulled")))
        assert appmod.refresh_liveries() is True
        assert appmod.LIVERY_CATALOG is before and "half-pulled" in appmod.LIVERY_PROBLEM
        monkeypatch.undo()
        appmod.refresh_liveries()


def test_liveries_off_means_503_not_a_crash(monkeypatch):
    with TestClient(appmod.app):
        monkeypatch.setattr(appmod, "LIVERY_CATALOG", None)
        with pytest.raises(appmod.HTTPException) as e:
            appmod._livery_catalog()
        assert e.value.status_code == 503
