"""Offline tests for race/tools/design_course.py (synthetic terrain, no network)."""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "tools"))
import check_terrain as ct  # noqa: E402
import design_course as dc  # noqa: E402


class Ridge:
    """Flat 100 m terrain with a 900 m ridge along lon == 7.905 and a 50 m dip at (46.6, 7.9)."""
    name = "synthetic"

    def height(self, lat, lon):
        h = 100.0
        if abs(lon - 7.905) < 0.002:
            h = 900.0
        if abs(lat - 46.6) < 0.001 and abs(lon - 7.9) < 0.001:
            h = 50.0
        return h

    def heights(self, points, workers=1):
        return {ct.sample_key(la, lo): self.height(la, lo) for la, lo in points}


SPEC = {"id": "t", "name": "T (easy)", "radius": 100,
        "waypoints": [{"lat": 46.60, "lon": 7.88}, {"lat": 46.60, "lon": 7.93}, {"lat": 46.62, "lon": 7.93, "extra": 40}],
        "boxes": [{"leg": 0, "frac": 0.5}]}


def test_design_passes_the_terrain_check_and_stays_low():
    course, stats = dc.design(SPEC, Ridge())
    assert stats["check_status"] == "PASS"
    assert stats["check_min_clearance_m"] >= ct.DEFAULT_MARGIN_M
    g = course["gates"]
    # Gate 3 is over flat 100 m terrain with nothing in the way: minimum + extra, not ridge height.
    assert g[2]["alt"] == pytest.approx(100 + 150 + dc.DEFAULT_PAD_M + 40, abs=0.2)
    # The ridge sits in the middle of leg 1: both gates were raised, the route clears it.
    assert course["itemBoxes"][0]["alt"] >= 900 + ct.DEFAULT_MARGIN_M
    assert course["startType"] == "air" and course["version"] == 1 and course["aircraftId"] is None


def test_fit_raises_the_cheaper_gate_for_an_off_centre_obstacle():
    gates = [{"lat": 46.60, "lon": 7.90, "alt": 0, "radius": 50.0}, {"lat": 46.60, "lon": 7.93, "alt": 0, "radius": 50.0}]
    dc.fit_altitudes(gates, Ridge())
    # Ridge at ~13% along the leg: the first gate carries most of the climb.
    assert gates[0]["alt"] > gates[1]["alt"]
    r = ct.check_course({"id": "x", "name": "x", "gates": gates}, Ridge())
    assert r["status"] == "PASS"


def test_snap_to_valley_finds_the_dip():
    lat, lon = dc.snap_to_valley(46.6005, 7.9008, Ridge(), 300)
    assert Ridge().height(lat, lon) == 50.0
    assert dc.snap_to_valley(46.6, 7.9, Ridge(), 0) == (46.6, 7.9)


def test_route_stats_shape():
    course, stats = dc.design(SPEC, Ridge())
    assert stats["length_km"] == pytest.approx(sum(stats["legs_km"]), abs=0.02)
    assert len(stats["turns_deg"]) == len(course["gates"]) - 2
    assert stats["min_agl_m"] <= stats["median_agl_m"] <= stats["max_agl_m"]


def test_no_data_is_an_error():
    class Hole(Ridge):
        def heights(self, points, workers=1):
            return {ct.sample_key(la, lo): ct.NO_DATA for la, lo in points}
    with pytest.raises(ct.TerrainError):
        dc.design(SPEC, Hole())


def test_laps_unroll_a_closed_lap_with_identical_coordinates():
    spec = {"id": "c", "name": "C (3 laps)", "radius": 50, "laps": 3, "speed_kt": 200,
            "waypoints": [{"lat": 46.60, "lon": 7.88}, {"lat": 46.60, "lon": 7.93}, {"lat": 46.62, "lon": 7.90}]}
    course, stats = dc.design(spec, Ridge(), margin=30)
    g = course["gates"]
    assert len(g) == 3 * 3 + 1
    assert g[0] == g[3] == g[6] == g[9], "every lap starts at the same gate and the last gate closes lap 3"
    assert g[1] == g[4] == g[7] and g[2] == g[5] == g[8]
    assert stats["laps"] == 3 and stats["lap_gates"] == 3 and stats["check_status"] == "PASS"
    assert stats["lap_time_s"] * 3 == pytest.approx(stats["est_time_s"], abs=3)


def test_ground_start():
    course, _ = dc.design(dict(SPEC, startType="ground"), Ridge())
    assert course["startType"] == "ground"
