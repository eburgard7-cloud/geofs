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
        url = cat.blueprint_url_for(e["id"])
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


# =============================================================================== identity
_n = [0]


def _pilot(c, name=None):
    """A fresh pilot via POST /pilots/claim -> (pilot_id, pilot_token, callsign)."""
    _n[0] += 1
    name = name or f"Gar{os.getpid() % 1000}x{_n[0]}"
    r = c.post("/pilots/claim", json={"callsign": name})
    assert r.status_code == 200, r.text
    return r.json()["pilot_id"], r.json()["pilot_token"], name


def _garage_token(c, pilot_token):
    code = c.post("/garage/link", json={"pilot_token": pilot_token}).json()["code"]
    r = c.post("/garage/link/redeem", json={"code": code})
    assert r.status_code == 200, r.text
    return r.json()["garage_token"]


def test_link_codes_are_short_unambiguous_and_forgiving_to_type():
    import random
    code = garage.new_link_code(random.Random(1))
    assert len(code) == 6 and not set(code) & set("0O1IL")
    assert garage.normalize_code(" abc-12 3") == "ABC123"


def test_link_code_single_use_expiry_and_purpose():
    with TestClient(appmod.app):
        with appmod.connect() as conn:
            code = garage.issue_link_code(conn, "garage", "pilot-a", 1000)
            assert garage.redeem_link_code(conn, "pair", code, 1001) == (None, "unknown")      # wrong purpose
            assert garage.redeem_link_code(conn, "garage", code.lower(), 1001) == ("pilot-a", None)
            assert garage.redeem_link_code(conn, "garage", code, 1002) == (None, "used")       # reuse
            late = garage.issue_link_code(conn, "garage", "pilot-a", 1000)
            assert garage.redeem_link_code(conn, "garage", late, 1000 + garage.LINK_CODE_TTL_S) == (None, "expired")
            assert garage.redeem_link_code(conn, "garage", "ZZZZZZ", 1001) == (None, "unknown")
            # a phone-pairing code is the same primitive under its own purpose
            pair = garage.issue_link_code(conn, "pair", "pilot-b", 1000, ttl=60)
            assert garage.redeem_link_code(conn, "pair", pair, 1059) == ("pilot-b", None)


def test_link_redeem_gives_a_garage_token_scoped_to_that_pilot():
    with TestClient(appmod.app) as c:
        pid_a, tok_a, name_a = _pilot(c)
        pid_b, tok_b, _ = _pilot(c)
        r = c.post("/garage/link", json={"pilot_token": tok_a})
        assert r.status_code == 200 and r.json()["expires_in"] == 300
        red = c.post("/garage/link/redeem", json={"code": r.json()["code"]}).json()
        assert red["pilot_id"] == pid_a and red["callsign"] == name_a and red["garage_token"].startswith("g_")
        assert c.post("/garage/link/redeem", json={"code": r.json()["code"]}).status_code == 400   # spent
        with appmod.connect() as conn:
            assert appmod.garage_pilot(conn, red["garage_token"])["pilot_id"] == pid_a
            assert appmod.garage_pilot(conn, tok_b)["pilot_id"] == pid_b
            assert appmod.garage_pilot(conn, "g_nonsense") is None
            # ...and it expires
            later = int(_now()) + garage.GARAGE_TOKEN_TTL_S + 1
            assert appmod.garage_pilot(conn, red["garage_token"], now=later) is None
        # a garage token can't mint codes, and isn't a pilot_token anywhere else
        assert c.post("/garage/link", json={"pilot_token": red["garage_token"]}).status_code == 401
        assert c.post("/garage/link", json={"pilot_token": "nope"}).status_code == 401


def _now():
    import time
    return time.time()


def test_garage_tokens_revoke_one_or_all():
    with TestClient(appmod.app) as c:
        _, tok, _ = _pilot(c)
        g1, g2, g3 = (_garage_token(c, tok) for _ in range(3))
        assert c.post("/garage/link/revoke", json={"token": g1}).json() == {"revoked": 1}
        assert c.post("/garage/link/revoke", json={"token": g1}).status_code == 401
        with appmod.connect() as conn:
            assert appmod.garage_pilot(conn, g1) is None and appmod.garage_pilot(conn, g2) is not None
        assert c.post("/garage/link/revoke", json={"token": tok}).json() == {"revoked": 2}
        with appmod.connect() as conn:
            assert appmod.garage_pilot(conn, g2) is None and appmod.garage_pilot(conn, g3) is None
            assert appmod.garage_pilot(conn, tok) is not None      # the pilot_token itself is untouched


def test_redeem_is_rate_limited_per_ip(monkeypatch):
    monkeypatch.setattr(appmod, "GARAGE_REDEEM_PER_MIN", 3)
    appmod._redeem_attempts.clear()
    with TestClient(appmod.app) as c:
        h = {"X-Forwarded-For": "203.0.113.9"}
        codes = [c.post("/garage/link/redeem", json={"code": "AAAAAA"}, headers=h).status_code for _ in range(4)]
        assert codes == [400, 400, 400, 429]
        assert c.post("/garage/link/redeem", json={"code": "AAAAAA"},
                      headers={"X-Forwarded-For": "203.0.113.10"}).status_code == 400
    appmod._redeem_attempts.clear()


# =============================================================================== unlocks
def _progress(**kw):
    """A synthetic campaign_progress() snapshot: only the fields requirement_met() reads."""
    base = {"medal_counts": {"bronze": 0, "silver": 0, "gold": 0, "dawg": 0}, "stars": 0, "trophies": [],
            "tiers": [{"id": "student", "open": True, "checkride": {"passed": False}},
                      {"id": "private", "open": False, "checkride": {"passed": False}}],
            "hidden_tier": False, "cups": [{"name": "Aloha Cup", "counted": ["a1", "a2"]}],
            "courses": {"a1": {"medal": None}, "a2": {"medal": None}}}
    base.update(kw)
    return base


CAMPAIGN_STUB = {"tiers": [{"id": "student", "name": "STUDENT"}, {"id": "private", "name": "PRIVATE"}]}


def _ctx(progress=None, **kw):
    return {"progress": progress, "campaign": CAMPAIGN_STUB, "season_place": None, "gungame_wins": 0, **kw}


@pytest.mark.parametrize("req, locked, unlocked", [
    (None, None, _progress()),
    ({"medal": "gold", "count": 2},
     _progress(medal_counts={"bronze": 3, "silver": 3, "gold": 1, "dawg": 0}),
     _progress(medal_counts={"bronze": 3, "silver": 3, "gold": 2, "dawg": 1})),
    ({"stars": 10}, _progress(stars=9), _progress(stars=10)),
    ({"tier": "private"}, _progress(),
     _progress(tiers=[{"id": "student", "open": True, "checkride": {"passed": True}},
                      {"id": "private", "open": True, "checkride": {"passed": False}}])),
    ({"checkride": "student"}, _progress(),
     _progress(tiers=[{"id": "student", "open": True, "checkride": {"passed": True}}])),
    ({"trophies": 1}, _progress(), _progress(trophies=["Aloha Cup"])),
    ({"cup": "Aloha Cup", "medal": "silver"},
     _progress(courses={"a1": {"medal": "gold"}, "a2": {"medal": "bronze"}}),
     _progress(courses={"a1": {"medal": "gold"}, "a2": {"medal": "silver"}})),
    ({"hidden_tier": True}, _progress(), _progress(hidden_tier=True)),
])
def test_unlock_evaluator_career_kinds(req, locked, unlocked):
    if locked is not None:
        assert appmod.livery_unlocked(req, _ctx(locked)) is False
    assert appmod.livery_unlocked(req, _ctx(unlocked)) is True


def test_unlock_evaluator_career_off_mode_gungame_and_seasons():
    assert appmod.livery_unlocked(None, _ctx(None)) is True                       # starters/classics
    assert appmod.livery_unlocked({"stars": 1}, _ctx(None)) is False              # no Career data
    assert appmod.livery_unlock_text({"stars": 1}, {**_ctx(None), "campaign": None}) == "Unlocks with the Career"
    assert appmod.livery_unlocked({"mode": "gungame"}, _ctx(_progress(stars=999))) is False
    assert appmod.livery_unlocked({"gungame_wins": 5}, _ctx(gungame_wins=4)) is False
    assert appmod.livery_unlocked({"gungame_wins": 5}, _ctx(gungame_wins=5)) is True
    assert appmod.livery_unlock_text({"gungame_wins": 5}, _ctx()) == "Win 5 Gun Games"
    season = {"season": "2026-fall", "place": 3}
    assert appmod.livery_unlocked(season, _ctx()) is False
    assert appmod.livery_unlock_text(season, _ctx()) == "Unlocks with seasons"
    places = {"2026-fall": 2}
    ctx = _ctx(season_place=places.get)
    assert appmod.livery_unlocked(season, ctx) is True
    assert appmod.livery_unlocked({"season": "2026-winter", "place": 3}, ctx) is False
    assert "top 3" in appmod.livery_unlock_text(season, ctx)
    assert appmod.livery_unlock_text({"tier": "private"}, _ctx()) == "Reach PRIVATE"


def test_every_catalog_requirement_has_an_answer_and_words():
    """Each requirement in the real catalog evaluates without error against an empty Career."""
    with TestClient(appmod.app):
        ctx = _ctx(_progress())
        ctx["campaign"] = appmod.CAMPAIGN
        for e in appmod.LIVERY_CATALOG.raw["liveries"]:
            assert appmod.livery_unlocked(e["requires"], ctx) is (e["requires"] is None), e["id"]
            assert appmod.livery_unlock_text(e["requires"], ctx)


def test_hooks_feed_the_evaluator(monkeypatch):
    with TestClient(appmod.app):
        with appmod.connect() as conn:
            monkeypatch.setattr(appmod, "GUNGAME_WINS", lambda conn, pid: 7)
            monkeypatch.setattr(appmod, "SEASON_STANDINGS", lambda conn, s: {"p1": 1} if s == "2026-fall" else None)
            ctx = appmod._unlock_ctx(conn, "p1")
            assert ctx["gungame_wins"] == 7 and ctx["season_place"]("2026-fall") == 1
            assert ctx["season_place"]("2027-spring") is None


# =============================================================================== equips
def _custom(conn, pilot_id, aircraft="f16", status="approved", kind="upload", sha=None):
    sha = sha or hashlib.sha256(os.urandom(8)).hexdigest()
    return garage.CUSTOM_PREFIX + garage.insert_custom(
        conn, pilot_id=pilot_id, aircraft=aircraft, kind=kind, name="Mine", status=status, now=1,
        files=[{"sha": sha, "ext": "webp"}])


def _ids(cat):
    starter = _entry(cat, lambda e: e["aircraft"] == "f16" and e["category"] == "starter")["id"]
    locked = _entry(cat, lambda e: e["aircraft"] == "f16" and (e["requires"] or {}).get("cup"))["id"]
    gg = _entry(cat, lambda e: e["aircraft"] == "f16" and e["category"] == "gungame")["id"]
    b757 = _entry(cat, lambda e: e["aircraft"] == "b757" and e["requires"] is None)["id"]
    return starter, locked, gg, b757


def _equip(c, token, aircraft, livery_id):
    return c.put("/garage/equip", json={"token": token, "aircraft": aircraft, "livery_id": livery_id})


def test_equip_rules():
    with TestClient(appmod.app) as c:
        pid_a, tok_a, _ = _pilot(c)
        pid_b, tok_b, _ = _pilot(c)
        starter, locked, gg, b757 = _ids(appmod.LIVERY_CATALOG)
        r = _equip(c, tok_a, "f16", starter)
        assert r.status_code == 200 and r.json()["equipped"] == starter and r.json()["urls"]
        r = _equip(c, tok_a, "f16", locked)
        assert r.status_code == 403 and "Locked:" in r.json()["detail"] and "Cup" in r.json()["detail"]
        r = _equip(c, tok_a, "f16", gg)
        assert r.status_code == 400 and "Gun Game" in r.json()["detail"]
        assert _equip(c, tok_a, "f16", b757).status_code == 400            # wrong aircraft
        assert _equip(c, tok_a, "f16", "no_such_livery").status_code == 404
        assert _equip(c, tok_a, "tank", None).status_code == 400
        assert _equip(c, "garbage", "f16", starter).status_code == 401
        with appmod.connect() as conn:
            theirs = _custom(conn, pid_b)
            mine_pending = _custom(conn, pid_a, status="pending")
            mine_rejected = _custom(conn, pid_a, status="rejected")
        r = _equip(c, tok_a, "f16", theirs)
        assert r.status_code == 403 and "another pilot" in r.json()["detail"]
        assert _equip(c, tok_a, "f16", mine_rejected).status_code == 409
        assert _equip(c, tok_a, "f16", mine_pending).status_code == 200
        # POST alias with a garage token, back to stock
        g = _garage_token(c, tok_a)
        r = c.post("/garage/equip", json={"token": g, "aircraft": "f16", "livery_id": None})
        assert r.status_code == 200 and r.json() == {"aircraft": "f16", "equipped": None, "urls": None}
        with appmod.connect() as conn:
            assert garage.pilot_equips(conn, pid_a) == {}


def test_garage_view_states_and_pending_visibility():
    with TestClient(appmod.app) as c:
        pid, tok, name = _pilot(c)
        starter, locked, gg, _ = _ids(appmod.LIVERY_CATALOG)
        with appmod.connect() as conn:
            pending = _custom(conn, pid, status="pending")
            approved = _custom(conn, pid, aircraft="b757")
            conn.execute("UPDATE livery_customs SET reason = 'no' WHERE id = ?", (_custom(conn, pid, status="rejected")[7:],))
        assert _equip(c, tok, "f16", pending).status_code == 200
        public = c.get(f"/garage/{pid}").json()
        assert public["owner"] is False and public["callsign"] == name and "limits" not in public
        f16 = public["aircraft"]["f16"]
        assert f16["equipped"] is None and f16["equipped_urls"] is None       # pending: nobody else sees it
        by_id = {x["id"]: x for x in f16["liveries"]}
        assert by_id[starter]["state"] == "owned" and by_id[locked]["state"] == "locked"
        assert by_id[locked]["unlock_text"] and gg not in by_id
        assert pending not in by_id                                            # hidden from the public
        assert approved in {x["id"] for x in public["aircraft"]["b757"]["liveries"]}
        own = c.get(f"/garage/{pid}", headers={"Authorization": f"Bearer {_garage_token(c, tok)}"}).json()
        assert own["owner"] is True and own["limits"]["customs"] == 2
        f16 = own["aircraft"]["f16"]
        assert f16["equipped"] == pending and f16["equipped_urls"][0].startswith("/liveries/files/")
        states = {x["state"] for x in f16["liveries"] if x["category"] == "custom"}
        assert states == {"pending", "rejected"}
        rej = next(x for x in f16["liveries"] if x["state"] == "rejected")
        assert rej["reason"] == "no" and rej["urls"] is None
        # another pilot's token is not the owner's
        _, tok_b, _ = _pilot(c)
        assert c.get(f"/garage/{pid}", headers={"Authorization": f"Bearer {tok_b}"}).json()["owner"] is False
        assert c.get("/garage/nobody-here").status_code == 404


def test_a_rejected_custom_is_never_served_but_a_pending_one_is(tmp_path, monkeypatch):
    monkeypatch.setattr(appmod, "LIVERY_DATA_DIR", str(tmp_path))
    with TestClient(appmod.app) as c:
        pid, tok, _ = _pilot(c)
        data = b"RIFF-not-really-webp"
        sha = hashlib.sha256(data).hexdigest()
        (tmp_path / f"{sha}.webp").write_bytes(data)
        with appmod.connect() as conn:
            lid = _custom(conn, pid, status="pending", sha=sha)
        r = c.get(f"/liveries/files/{sha}.webp")
        assert r.status_code == 200 and r.content == data and r.headers["access-control-allow-origin"] == "*"
        with appmod.connect() as conn:
            conn.execute("UPDATE livery_customs SET status = 'rejected' WHERE id = ?", (lid[7:],))
        assert c.get(f"/liveries/files/{sha}.webp").status_code == 404
