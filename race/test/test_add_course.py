"""Tests for race/tools/add_course.py.

Run: cd race/test && python -m pytest test_add_course.py -q
"""
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "tools"))
import add_course  # noqa: E402


def two_gate_course(**overrides):
    c = {
        "id": "test-sprint",
        "name": "Test Sprint",
        "version": 1,
        "aircraftId": None,
        "gates": [
            {"lat": 47.4502, "lon": -122.3088, "alt": 132, "radius": 150},
            {"lat": 47.43076, "lon": -122.29834, "alt": 132, "radius": 150},
        ],
    }
    c.update(overrides)
    return c


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setattr(add_course, "COURSES_DIR", tmp_path)
    monkeypatch.setattr(add_course, "INDEX_PATH", tmp_path / "index.json")
    return tmp_path


# --------------------------------------------------------------- valid add
def test_valid_add_writes_course_and_index(env):
    course = add_course.add_course(two_gate_course())
    assert course["id"] == "test-sprint"

    course_path = env / "test-sprint.json"
    assert course_path.exists()
    on_disk = json.loads(course_path.read_text(encoding="utf-8"))
    assert on_disk["gates"] == course["gates"]

    index = json.loads((env / "index.json").read_text(encoding="utf-8"))
    assert index == [{"id": "test-sprint", "name": "Test Sprint", "file": "test-sprint.json"}]


def test_id_derived_from_name_when_omitted(env):
    raw = two_gate_course(name="My Cool Course!!")
    del raw["id"]
    course = add_course.add_course(raw)
    assert course["id"] == "my-cool-course"


def test_default_radius_applied_when_gate_omits_it(env):
    raw = two_gate_course()
    del raw["gates"][0]["radius"]
    course = add_course.add_course(raw)
    assert course["gates"][0]["radius"] == add_course.DEFAULT_RADIUS_M


# ----------------------------------------------------------- index upsert
def test_index_upsert_is_idempotent(env):
    add_course.add_course(two_gate_course())
    add_course.add_course(two_gate_course())  # re-run with identical input
    index = json.loads((env / "index.json").read_text(encoding="utf-8"))
    assert len(index) == 1
    assert index[0]["id"] == "test-sprint"


def test_index_upsert_sorted_by_name_no_duplicates(env):
    add_course.add_course(two_gate_course(id="zzz-course", name="Zulu Course"))
    add_course.add_course(two_gate_course(id="aaa-course", name="Alpha Course"))
    add_course.add_course(two_gate_course(id="zzz-course", name="Zulu Course Renamed"))  # same id, update in place

    index = json.loads((env / "index.json").read_text(encoding="utf-8"))
    assert [e["id"] for e in index] == ["aaa-course", "zzz-course"]  # sorted by name: Alpha < Zulu
    assert index[1]["name"] == "Zulu Course Renamed"
    ids = [e["id"] for e in index]
    assert len(ids) == len(set(ids))


# --------------------------------------------------------- rejection cases
@pytest.mark.parametrize("gate_count", [0, 1])
def test_rejects_too_few_gates(env, gate_count):
    raw = two_gate_course()
    raw["gates"] = raw["gates"][:gate_count]
    with pytest.raises(add_course.CourseError, match="at least"):
        add_course.add_course(raw)


def test_rejects_too_many_gates(env):
    raw = two_gate_course()
    raw["gates"] = [dict(raw["gates"][0]) for _ in range(202)]
    with pytest.raises(add_course.CourseError, match="at most"):
        add_course.add_course(raw)


def test_accepts_max_gate_count(env):
    raw = two_gate_course()
    raw["gates"] = [dict(raw["gates"][0]) for _ in range(201)]
    course = add_course.add_course(raw)
    assert len(course["gates"]) == 201


@pytest.mark.parametrize("field,value", [
    ("lat", float("nan")),
    ("lat", "not-a-number"),
    ("lon", float("inf")),
    ("alt", None),
    ("radius", "banana"),
])
def test_rejects_non_finite_gate_fields(env, field, value):
    raw = two_gate_course()
    raw["gates"][0][field] = value
    with pytest.raises(add_course.CourseError, match="Gate 0 is invalid"):
        add_course.add_course(raw)


@pytest.mark.parametrize("field,value", [
    ("lat", 90.1), ("lat", -90.1),
    ("lon", 180.1), ("lon", -180.1),
    ("radius", 0), ("radius", -5), ("radius", 5000.1),
])
def test_rejects_out_of_range_gate_fields(env, field, value):
    raw = two_gate_course()
    raw["gates"][0][field] = value
    with pytest.raises(add_course.CourseError, match="Gate 0 is invalid"):
        add_course.add_course(raw)


def test_accepts_boundary_gate_values(env):
    raw = two_gate_course()
    raw["gates"][0].update({"lat": 90, "lon": 180, "radius": 5000})
    raw["gates"][1].update({"lat": -90, "lon": -180, "radius": 0.1})
    course = add_course.add_course(raw)
    assert course["gates"][0]["lat"] == 90 and course["gates"][1]["lon"] == -180


def test_rejects_name_over_48_chars(env):
    raw = two_gate_course(name="x" * 49)
    with pytest.raises(add_course.CourseError, match="48"):
        add_course.add_course(raw)


def test_accepts_name_at_48_chars(env):
    raw = two_gate_course(name="x" * 48)
    course = add_course.add_course(raw)
    assert len(course["name"]) == 48


@pytest.mark.parametrize("bad_id", ["Has Spaces", "UPPERCASE", "under_score", "x" * 65, "emoji-🚀"])
def test_rejects_bad_id_slug(env, bad_id):
    raw = two_gate_course(id=bad_id)
    with pytest.raises(add_course.CourseError, match="id"):
        add_course.add_course(raw)


def test_rejects_non_object_json(env):
    with pytest.raises(add_course.CourseError, match="object"):
        add_course.add_course([1, 2, 3])


# --------------------------------------------------------------- --force
def test_refuses_overwrite_with_changed_geometry_without_force(env):
    add_course.add_course(two_gate_course())
    changed = two_gate_course()
    changed["gates"][0]["lat"] += 1.0  # ~111 km away: unambiguously different geometry

    with pytest.raises(add_course.CourseError, match="different gate geometry"):
        add_course.add_course(changed)

    on_disk = json.loads((env / "test-sprint.json").read_text(encoding="utf-8"))
    assert on_disk["gates"][0]["lat"] == two_gate_course()["gates"][0]["lat"], "file must be untouched by the refused write"


def test_force_overwrites_changed_geometry_and_warns(env, capsys):
    add_course.add_course(two_gate_course())
    changed = two_gate_course()
    changed["gates"][0]["lat"] += 1.0

    course = add_course.add_course(changed, force=True)
    assert course["gates"][0]["lat"] == changed["gates"][0]["lat"]

    on_disk = json.loads((env / "test-sprint.json").read_text(encoding="utf-8"))
    assert on_disk["gates"][0]["lat"] == changed["gates"][0]["lat"]

    captured = capsys.readouterr()
    assert "resets its leaderboard" in captured.err


# --------------------------------------------------------------- startType
def test_start_type_omitted_defaults_to_ground(env):
    course = add_course.add_course(two_gate_course())
    assert course["startType"] == "ground"


def test_start_type_air_round_trips(env):
    course = add_course.add_course(two_gate_course(startType="air"))
    assert course["startType"] == "air"

    on_disk = json.loads((env / "test-sprint.json").read_text(encoding="utf-8"))
    assert on_disk["startType"] == "air"


@pytest.mark.parametrize("bad_value", ["banana", "AIR", "", None, 1, True])
def test_start_type_unknown_value_falls_back_to_ground(env, bad_value):
    course = add_course.add_course(two_gate_course(startType=bad_value))
    assert course["startType"] == "ground"


# ------------------------------------------------------------- itemBox (powerups)
def test_item_box_omitted_defaults_to_none(env):
    course = add_course.add_course(two_gate_course())
    assert course["itemBox"] is None


def test_item_box_round_trips_with_default_radius(env):
    course = add_course.add_course(two_gate_course(itemBox={"lat": 47.44, "lon": -122.3, "alt": 132}))
    assert course["itemBox"] == {"lat": 47.44, "lon": -122.3, "alt": 132.0, "radius": float(add_course.DEFAULT_RADIUS_M)}

    on_disk = json.loads((env / "test-sprint.json").read_text(encoding="utf-8"))
    assert on_disk["itemBox"]["radius"] == add_course.DEFAULT_RADIUS_M


def test_item_box_explicit_radius_kept(env):
    course = add_course.add_course(two_gate_course(itemBox={"lat": 47.44, "lon": -122.3, "alt": 132, "radius": 120}))
    assert course["itemBox"]["radius"] == 120.0


@pytest.mark.parametrize("bad_box", [
    "banana",                                              # not an object
    42,
    {"lon": -122.3, "alt": 132},                           # missing lat
    {"lat": None, "lon": -122.3, "alt": 132},
    {"lat": "x", "lon": -122.3, "alt": 132},
    {"lat": 91, "lon": -122.3, "alt": 132},                # lat out of range
    {"lat": 47.44, "lon": 181, "alt": 132},                # lon out of range
    {"lat": 47.44, "lon": -122.3, "alt": 132, "radius": 0},
    {"lat": 47.44, "lon": -122.3, "alt": 132, "radius": -5},
    {"lat": 47.44, "lon": -122.3, "alt": 132, "radius": add_course.MAX_RADIUS_M + 1},
])
def test_rejects_bad_item_box(env, bad_box):
    # race.js silently drops a malformed box to keep a course loadable; this tool is the strict
    # side and must explain instead, or a typo'd box sits invisible in the shared list.
    with pytest.raises(add_course.CourseError):
        add_course.add_course(two_gate_course(itemBox=bad_box))


def test_item_box_is_not_part_of_the_geometry_hash(env):
    """Adding or moving a box must never reset a course's leaderboard."""
    plain = add_course.normalize(two_gate_course())
    boxed = add_course.normalize(two_gate_course(itemBox={"lat": 47.44, "lon": -122.3, "alt": 132}))
    moved = add_course.normalize(two_gate_course(itemBox={"lat": 47.40, "lon": -122.28, "alt": 200}))
    assert add_course.course_hash(plain) == add_course.course_hash(boxed) == add_course.course_hash(moved)
    assert not add_course.geometry_changed(plain, boxed)


def test_adding_an_item_box_to_an_existing_course_needs_no_force(env):
    add_course.add_course(two_gate_course())
    course = add_course.add_course(two_gate_course(itemBox={"lat": 47.44, "lon": -122.3, "alt": 132}))
    assert course["itemBox"] is not None


def test_renaming_without_force_does_not_require_force(env):
    add_course.add_course(two_gate_course())
    renamed = two_gate_course(name="Test Sprint Renamed")  # same id, same geometry, new name
    course = add_course.add_course(renamed)  # no --force needed: geometry unchanged
    assert course["name"] == "Test Sprint Renamed"
