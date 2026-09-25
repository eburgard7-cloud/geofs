"""Guardrail against a globe that silently falls back to the 2D map (see race/CLAUDE.md's Feature
series 0.7-1.0 rules: "falls back silently" must never hide a real regression). A unit test can
assert the tile rate limiter's shape or that config.js points at the right MODEL_BASE, but neither
one proves the globe actually PAINTS in a real browser under the site's real CSP header -- that
needs an actual page load. This drives the site with Playwright/headless Chromium against a real
uvicorn instance of race/server/app.py, with the tile proxy's upstream fetch faked out (no network
dependency on S3/Esri/EOX, matching this repo's "never depend on an unreachable host" rule) and one
seeded ghost trace so the replay page has something to render.

Run: cd race/server && pip install -r requirements.txt httpx pytest playwright \
     && python -m playwright install --with-deps chromium && python -m pytest ../test/site_smoke.py -q

Skips itself (rather than failing) when Playwright or its browser isn't installed, so it never
blocks the other suites in a sandbox that can't reach the Chromium download.
"""
import io
import json
import os
import socket
import sys
import threading
import time

import pytest

pytest.importorskip("playwright.sync_api", reason="playwright not installed")
from playwright.sync_api import sync_playwright  # noqa: E402

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "server"))
os.environ.setdefault("RACE_DB", "/tmp/race-smoke-test.db")
os.environ.setdefault("RACE_MIN_INTERVAL_S", "0")
os.environ.setdefault("RACE_GET_MIN_INTERVAL_S", "0")
os.environ.setdefault("RACE_COURSES_DIR", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "courses"))
if os.path.exists(os.environ["RACE_DB"]):
    os.remove(os.environ["RACE_DB"])

import uvicorn  # noqa: E402
import app as appmod  # noqa: E402

# gorge-run's real hash (test/course_hashes.json pins it too) -- POST /runs checks course_hash
# against its own recompute of the course's geometry, so this can't be a made-up value.
GORGE_RUN_HASH = "51a1ce45"
GORGE_RUN_GATES = 6
GHOST_CALLSIGN = "SMOKE1"


def _fixture_tile_png():
    """A real, tiny, valid PNG -- not just arbitrary bytes. createImageBitmap() (globe.js's
    terrariumPixels) and Cesium's own imagery decoder both need something they can actually decode;
    arbitrary bytes would fail silently per-tile and prove nothing about the CSP/canvas assertions
    below, which is what this guardrail exists to check."""
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGB", (4, 4), (90, 140, 200)).save(buf, format="PNG")
    return buf.getvalue()


def _free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _make_trace(n=20, step_ms=250, speed_ms=50.0, lat=45.551, lon=-122.22, alt=350.0):
    dlat = (speed_ms * step_ms / 1000.0) / 111320.0
    return {"v": 1, "n": n, "t": [0] + [step_ms] * (n - 1),
            "lat": [round(lat + dlat * i, 6) for i in range(n)], "lon": [lon] * n, "alt": [alt] * n,
            "hdg": [0.0] * n, "pitch": [0.0] * n, "roll": [0.0] * n}


def _seed_ghost_run(base_url):
    import httpx
    n = 20
    last = (n - 1) * 250
    step = last // GORGE_RUN_GATES
    splits = [step * (i + 1) for i in range(GORGE_RUN_GATES - 2)] + [last]
    body = {
        "course_id": "gorge-run", "course_hash": GORGE_RUN_HASH, "course_name": "Gorge Run",
        "callsign": GHOST_CALLSIGN, "time_ms": last, "splits": splits, "gates": GORGE_RUN_GATES,
        # short enough that time_ms isn't "faster than the aircraft speed limit allows" (Run's
        # validator checks time_s >= 0.8 * length_m / MAX_SPEED_MS)
        "length_m": 200.0, "client_version": "0.1.0", "trace": _make_trace(n=n),
    }
    r = httpx.post(f"{base_url}/runs", json=body, timeout=10.0)
    assert r.status_code == 200, f"seeding the ghost run failed: {r.status_code} {r.text}"


class _ServerThread:
    """A real uvicorn instance in a background thread -- Playwright needs a real HTTP origin (a
    TestClient's in-process ASGI transport has no origin for the browser to navigate to, and can't
    carry a live WebSocket the page opens either)."""

    def __init__(self, port):
        self.port = port
        config = uvicorn.Config(appmod.app, host="127.0.0.1", port=port, log_level="warning")
        self.server = uvicorn.Server(config)
        self.thread = threading.Thread(target=self.server.run, daemon=True)

    def start(self):
        self.thread.start()
        deadline = time.time() + 10
        while not self.server.started and time.time() < deadline:
            time.sleep(0.05)
        assert self.server.started, "uvicorn did not start in time"

    def stop(self):
        self.server.should_exit = True
        self.thread.join(timeout=10)


@pytest.fixture(scope="module")
def running_server(tmp_path_factory):
    tile_dir = tmp_path_factory.mktemp("tiles")
    appmod.TILE_CACHE_DIR = str(tile_dir)
    appmod.RACE_TILE_PROXY = True
    appmod.RACE_IMAGERY = "esri"
    appmod._tile_buckets.clear()
    png = _fixture_tile_png()
    # The one place a tile route reaches the network (see app.py's _tile_http_get docstring) --
    # faked out so this test has zero dependency on S3/Esri/EOX, matching the "never depend on an
    # unreachable host" rule for this feature series.
    async def fake_tile_get(url):   # _tile_http_get is a coroutine function since tiles-warm
        return png
    appmod._tile_http_get = fake_tile_get
    appmod.RACE_TILE_WARM = False   # no startup terrain warm: nothing here needs it

    port = _free_port()
    srv = _ServerThread(port)
    srv.start()
    base_url = f"http://127.0.0.1:{port}"
    _seed_ghost_run(base_url)
    yield base_url
    srv.stop()


@pytest.fixture(scope="module")
def browser():
    try:
        with sync_playwright() as p:
            try:
                b = p.chromium.launch()
            except Exception as e:  # pragma: no cover - environment without the browser binary
                pytest.skip(f"chromium not installed for playwright: {e}")
            yield b
            b.close()
    except Exception as e:  # pragma: no cover
        pytest.skip(f"playwright unavailable: {e}")


CSP_LISTENER = """
window.__cspViolations = [];
document.addEventListener('securitypolicyviolation', (e) => {
  window.__cspViolations.push({ directive: e.violatedDirective, blockedURI: e.blockedURI });
});
"""


def _open_and_watch(browser, base_url, hash_path):
    """Navigate to `hash_path`, return {page, violations(), status_429s, canvas_count()}."""
    page = browser.new_page()
    page.add_init_script(CSP_LISTENER)
    responses = []
    page.on("response", lambda r: responses.append(r))
    page.goto(base_url + "/", wait_until="load")
    page.evaluate("(h) => { location.hash = h; }", hash_path)
    # The globe is a dynamic import behind a probe + Cesium (~6 MB) load; give it real time rather
    # than a fixed sleep racing the network.
    try:
        page.wait_for_selector(".globe-host canvas", timeout=20000)
    except Exception:
        pass   # the canvas assertion below reports this properly; don't hide it in a fixture error
    page.wait_for_timeout(500)   # let any last responses (a model glb, a second tile batch) land
    return page, responses


def test_course_page_shows_the_3d_globe_with_no_csp_violations_and_no_429s(running_server, browser):
    page, responses = _open_and_watch(browser, running_server, "/course/gorge-run")
    try:
        canvases = page.locator(".globe-host canvas").count()
        assert canvases > 0, (
            "no Cesium canvas in .globe-host -- the course page fell back to the 2D map. "
            "Check the console/network tabs: this is exactly the silent-fallback failure mode "
            "this test exists to catch."
        )
        violations = page.evaluate("window.__cspViolations")
        assert violations == [], f"CSP violations on the course page: {violations}"
        code_429 = [r.url for r in responses if r.status == 429]
        assert code_429 == [], f"429s on the course page (tile rate limiter tripped): {code_429}"
    finally:
        page.close()


def test_replay_page_shows_the_3d_globe_and_loads_a_ghost_model(running_server, browser):
    page, responses = _open_and_watch(browser, running_server, f"/replay/gorge-run?pilots={GHOST_CALLSIGN}")
    try:
        canvases = page.locator(".globe-host canvas").count()
        assert canvases > 0, (
            "no Cesium canvas in .globe-host on the replay page -- fell back to the 2D stage."
        )
        violations = page.evaluate("window.__cspViolations")
        assert violations == [], f"CSP violations on the replay page: {violations}"
        code_429 = [r.url for r in responses if r.status == 429]
        assert code_429 == [], f"429s on the replay page (tile rate limiter tripped): {code_429}"
        # "a model entity loaded": the ghost's .glb, fetched from this server's own /models/ mount
        # (config.js MODEL_BASE) -- proof the CSP's connect-src 'self' isn't refusing it anymore.
        glb_hits = [r for r in responses if r.url.endswith(".glb")]
        assert glb_hits, "no .glb request was made on the replay page -- no ghost model loaded"
        assert all(r.status == 200 for r in glb_hits), \
            f"a ghost model request failed: {[(r.url, r.status) for r in glb_hits if r.status != 200]}"
        assert any("/models/" in r.url for r in glb_hits), \
            f"ghost model was NOT fetched from this server's own /models/ mount: {[r.url for r in glb_hits]}"
    finally:
        page.close()


def test_5xx_upstream_shows_server_error_note_with_retry_and_recovers(running_server, browser, tmp_path_factory):
    """Client-side resilience added for site-3d-resilience (globe.js probe() failure-expiry +
    buildFallbackNote, race/CLAUDE.md's "falls back silently" rule): a real tile-route 500 must
    show the server-error wording (never "blocked on this network" -- that's for CSP/network only,
    see site.js classifyBlockReason), with zero CSP violations, and a Retry 3D button that recovers
    once the upstream does, with no page reload.

    Forces an honest 500 rather than the httpx.HTTPError-caught 502 the other tests' upstream
    failures produce: _tile_http_get is stubbed to raise a plain RuntimeError, which escapes every
    /tiles/* route's `except httpx.HTTPError` clause uncaught, landing Starlette's default
    unhandled-exception 500 -- the actual shape of "the tile routes return 500" without touching
    app.py (a parallel branch owns the tile routes). Runs against its own empty tile cache dir so
    it can't reuse a tile another test already cached at the same probed z0/x0/y0 path, and clears
    the rate limiter's buckets so an earlier test's requests can't tip this one into a 429 instead."""
    png = _fixture_tile_png()
    orig_dir, orig_get = appmod.TILE_CACHE_DIR, appmod._tile_http_get
    appmod.TILE_CACHE_DIR = str(tmp_path_factory.mktemp("tiles-5xx"))
    appmod._tile_buckets.clear()

    async def fail(_url):
        raise RuntimeError("simulated upstream failure")

    async def healthy(_url):
        return png
    appmod._tile_http_get = fail

    page = browser.new_page()
    page.add_init_script(CSP_LISTENER)
    try:
        page.goto(running_server + "/#/course/gorge-run", wait_until="load")
        note = page.locator(".viewer-fallback").first
        text = note.text_content(timeout=15000) or ""
        assert "map server hit an error" in text, f"expected the server-error fallback note, got: {text!r}"
        assert "blocked on this network" not in text, f"a 500 must not read as a network/CSP block: {text!r}"
        assert note.get_attribute("title") == "http-500", f"the reason code belongs in the title: {note.get_attribute('title')!r}"
        assert note.locator("button", has_text="Retry 3D").count() == 1, "the server-error note needs a Retry 3D button"
        violations = page.evaluate("window.__cspViolations")
        assert violations == [], f"CSP violations while showing the server-error note: {violations}"

        page.evaluate("window.__noReloadMarker = true")
        appmod._tile_http_get = healthy   # the upstream (or this site's own proxy) recovers
        note.locator("button", has_text="Retry 3D").click()
        page.wait_for_selector(".globe-host canvas", timeout=20000)
        assert page.locator(".globe-host canvas").count() == 1, "Retry 3D must mount exactly one Cesium canvas"
        assert page.locator(".viewer-fallback").count() == 0, "the fallback note must go once 3D is up"
        assert page.evaluate("window.__noReloadMarker") is True, "Retry 3D must not reload the page"
    finally:
        page.close()
        appmod.TILE_CACHE_DIR = orig_dir
        appmod._tile_http_get = orig_get


def test_debug_flag_shows_the_fallback_reason_when_the_globe_is_blocked(running_server, browser):
    """?debug=1 (race/server/static/js/globe.js DEBUG()): when the globe genuinely can't start, the
    2D-fallback note names why, instead of a bare "showing the route map" that gives no clue. Forces
    the fallback the realistic way -- aborting every imagery tile request, the same as a genuinely
    unreachable host -- rather than fighting site.js's frozen (Object.freeze) FinsSite export, which
    can't be monkeypatched after the fact. Routed on a fresh page (not one that already visited the
    home page's own flyover) so nothing has cached a successful probe for the same tile URL first."""
    page = browser.new_page()
    page.route("**/tiles/imagery/**", lambda route: route.abort())
    page.goto(running_server + "/#/course/gorge-run?debug=1", wait_until="load")
    note = page.locator(".viewer-fallback").first
    try:
        text = note.text_content(timeout=10000) or ""
    except Exception:
        text = ""
    assert "imagery probe:" in text, f"expected the ?debug=1 note to name a probe reason, got: {text!r}"
    page.close()


def test_replay_in_2d_disables_camera_controls_and_keys(running_server, browser):
    """site-3d-resilience: with 3D unavailable (imagery aborted = a network block), the replay's
    camera buttons 1-5 and the clamp toggle are disabled with a "3D only" tooltip, keys 1-5 do
    nothing, and the fallback note sits in the slim bar under the stage, not on top of it."""
    page = browser.new_page()
    page.add_init_script(CSP_LISTENER)
    page.route("**/tiles/imagery/**", lambda route: route.abort())
    try:
        page.goto(running_server + f"/#/replay/gorge-run?pilots={GHOST_CALLSIGN}", wait_until="load")
        note = page.locator(".viewer-fallback").first
        text = note.text_content(timeout=15000) or ""
        assert "blocked on this network" in text, f"an aborted host is a network block: {text!r}"
        assert note.get_attribute("title") == "network", f"reason code in the title: {note.get_attribute('title')!r}"
        assert page.locator(".stage .viewer-fallback").count() == 0, "the note must not be inside (over) the stage"
        cams = page.locator(".cams button")
        assert cams.count() == 5
        for i in range(5):
            assert cams.nth(i).is_disabled(), f"camera button {i + 1} must be disabled in 2D"
            assert cams.nth(i).get_attribute("title") == "3D only"
        assert page.locator(".toggle input[type=checkbox]").first.is_disabled(), "clamp toggle is 3D only"
        pressed = [cams.nth(i).get_attribute("aria-pressed") for i in range(5)]
        page.locator("body").press("2")
        assert [cams.nth(i).get_attribute("aria-pressed") for i in range(5)] == pressed, "key 2 must be ignored in 2D"
        assert page.evaluate("window.__cspViolations") == []
    finally:
        page.close()
