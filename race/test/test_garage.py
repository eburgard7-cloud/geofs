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


# =============================================================================== serving
def _entry(cat, pred):
    return next(e for e in cat.raw["liveries"] if pred(e))


def test_catalog_endpoint_serves_urls_and_blueprints_with_cors_star_and_an_etag():
    with TestClient(appmod.app) as c:
        r = c.get("/liveries/catalog", headers={"Origin": "https://www.geo-fs.com"})
        assert r.status_code == 200
        assert r.headers["access-control-allow-origin"] == "*"
        body = r.json()
        assert set(body["aircraft"]) >= {"f16", "b757", "rafale"}
        f16 = next(e for e in body["liveries"] if e["id"] == "f16_season_2026_fall")
        assert f16["urls"][0].startswith("/liveries/files/") and f16["blueprint_url"].startswith("/liveries/blueprint/")
        raf = next(e for e in body["liveries"] if e["aircraft"] == "rafale")
        assert raf["blueprint_url"] is None      # no geometry map for the Rafale
        again = c.get("/liveries/catalog", headers={"If-None-Match": r.headers["etag"]})
        assert again.status_code == 304
        # any origin, not just the allow-listed ones: these are public textures
        assert c.get("/liveries/catalog", headers={"Origin": "https://evil.example"}).headers[
            "access-control-allow-origin"] == "*"
        pre = c.options("/liveries/files/" + "0" * 64 + ".png",
                        headers={"Origin": "https://www.geo-fs.com", "Access-Control-Request-Method": "GET"})
        assert pre.status_code == 204 and pre.headers["access-control-allow-origin"] == "*"


def test_files_are_content_addressed_immutable_and_never_gzipped():
    with TestClient(appmod.app) as c:
        cat = appmod.LIVERY_CATALOG
        e = _entry(cat, lambda e: e["id"] == "f16_season_2026_fall")
        url = cat.urls[e["id"]][0]
        r = c.get(url, headers={"Accept-Encoding": "gzip", "Origin": "https://www.geo-fs.com"})
        assert r.status_code == 200 and r.headers["content-type"] == "image/webp"
        assert r.headers["cache-control"] == appmod.LIVERY_FILE_CACHE
        assert r.headers["access-control-allow-origin"] == "*"
        assert r.headers.get("content-encoding") == "identity"
        sha = url.split("/")[-1].split(".")[0]
        assert hashlib.sha256(r.content).hexdigest() == sha
        assert c.get(f"/liveries/files/{sha}.png").status_code == 404      # right sha, wrong ext
        assert c.get("/liveries/files/" + "a" * 64 + ".webp").status_code == 404
        assert c.get("/liveries/files/..%2Fapp.py").status_code in (404, 422)


def test_templates_schema_lists_pilot_templates_only():
    with TestClient(appmod.app) as c:
        r = c.get("/liveries/templates")
        assert r.status_code == 200 and r.headers["access-control-allow-origin"] == "*"
        ids = {t["id"] for t in r.json()}
        assert "f16_speedline" in ids and not any(i.endswith("_gg_kit") for i in ids)
        t = next(t for t in r.json() if t["id"] == "f16_speedline")
        assert {"id", "aircraft", "name", "description", "params"} <= set(t)


def test_kit_files_are_served_and_nothing_else():
    with TestClient(appmod.app) as c:
        r = c.get("/liveries/kit/f16_kit_blank.webp")
        assert r.status_code == 200 and r.headers["content-type"] == "image/webp"
        assert c.get("/liveries/kit/README.md").status_code == 200
        assert c.get("/liveries/kit/nope.png").status_code == 404
        assert c.get("/liveries/kit/..%2Fcatalog.json").status_code in (404, 422)


def test_blueprint_renders_once_then_comes_from_the_cache(tmp_path, monkeypatch):
    monkeypatch.setattr(appmod, "LIVERY_DATA_DIR", str(tmp_path))
    with TestClient(appmod.app) as c:
        cat = appmod.LIVERY_CATALOG
        e = _entry(cat, lambda e: e["aircraft"] == "b757" and e["category"] == "starter")
        url = cat.entry_blueprint(e["id"])
        r = c.get(url)
        assert r.status_code == 200 and r.headers["content-type"] == "image/png"
        assert r.headers["access-control-allow-origin"] == "*"
        cached = tmp_path / "blueprints" / url.split("/")[-1]
        assert cached.is_file() and cached.read_bytes() == r.content
        monkeypatch.setattr(appmod.LIVERY_TOOLS.views, "sheet", lambda *a, **k: pytest.fail("re-rendered"))
        assert c.get(url).content == r.content
        raf = _entry(cat, lambda e: e["aircraft"] == "rafale")
        assert c.get(f"/liveries/blueprint/{cat.shas[raf['id']][0]}.png").status_code == 404
        assert c.get("/liveries/blueprint/" + "b" * 64 + ".png").status_code == 404
