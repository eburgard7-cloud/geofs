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


# ------------------------------------------------------------- itemBoxes (powerups)
def test_item_boxes_omitted_defaults_to_an_empty_list(env):
    course = add_course.add_course(two_gate_course())
    assert course["itemBoxes"] == []


def test_item_boxes_round_trip_with_default_radius(env):
    course = add_course.add_course(two_gate_course(itemBoxes=[
        {"lat": 47.44, "lon": -122.3, "alt": 132},
        {"lat": 47.43, "lon": -122.31, "alt": 132, "radius": 120},
    ]))
    assert course["itemBoxes"][0] == {"lat": 47.44, "lon": -122.3, "alt": 132.0,
                                      "radius": float(add_course.DEFAULT_RADIUS_M)}
    assert course["itemBoxes"][1]["radius"] == 120.0

    on_disk = json.loads((env / "test-sprint.json").read_text(encoding="utf-8"))
    assert len(on_disk["itemBoxes"]) == 2
    assert on_disk["itemBoxes"][0]["radius"] == add_course.DEFAULT_RADIUS_M


def test_the_legacy_single_item_box_reads_as_a_one_element_list(env):
    """Every course file written before 0.10.0 has `itemBox`, not `itemBoxes`. It still loads,
    and is rewritten in the new shape."""
    course = add_course.add_course(two_gate_course(itemBox={"lat": 47.44, "lon": -122.3, "alt": 132}))
    assert course["itemBoxes"] == [{"lat": 47.44, "lon": -122.3, "alt": 132.0,
                                    "radius": float(add_course.DEFAULT_RADIUS_M)}]
    assert "itemBox" not in course
    on_disk = json.loads((env / "test-sprint.json").read_text(encoding="utf-8"))
    assert "itemBox" not in on_disk and len(on_disk["itemBoxes"]) == 1


def test_setting_both_keys_is_rejected_rather_than_guessed(env):
    with pytest.raises(add_course.CourseError):
        add_course.add_course(two_gate_course(itemBoxes=[{"lat": 47.44, "lon": -122.3, "alt": 132}],
                                              itemBox={"lat": 47.40, "lon": -122.28, "alt": 132}))


def test_rejects_more_boxes_than_the_cap(env):
    boxes = [{"lat": 47.4 + i * 0.001, "lon": -122.3, "alt": 132} for i in range(add_course.MAX_ITEM_BOXES + 1)]
    with pytest.raises(add_course.CourseError):
        add_course.add_course(two_gate_course(itemBoxes=boxes))
    # Exactly at the cap is fine.
    course = add_course.add_course(two_gate_course(itemBoxes=boxes[:-1]))
    assert len(course["itemBoxes"]) == add_course.MAX_ITEM_BOXES


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
        add_course.add_course(two_gate_course(itemBoxes=[bad_box]))
    with pytest.raises(add_course.CourseError):
        add_course.add_course(two_gate_course(itemBox=bad_box))


def test_a_non_list_item_boxes_is_rejected(env):
    with pytest.raises(add_course.CourseError):
        add_course.add_course(two_gate_course(itemBoxes={"lat": 47.44, "lon": -122.3, "alt": 132}))


def test_the_bad_box_message_names_which_box(env):
    with pytest.raises(add_course.CourseError) as e:
        add_course.add_course(two_gate_course(itemBoxes=[
            {"lat": 47.44, "lon": -122.3, "alt": 132},
            {"lat": 47.44, "lon": -122.3, "alt": 132, "radius": 0},
        ]))
    assert "itemBoxes[1]" in str(e.value)


def test_item_boxes_are_not_part_of_the_geometry_hash(env):
    """Adding or moving boxes must never reset a course's leaderboard."""
    plain = add_course.normalize(two_gate_course())
    boxed = add_course.normalize(two_gate_course(itemBoxes=[{"lat": 47.44, "lon": -122.3, "alt": 132}]))
    moved = add_course.normalize(two_gate_course(itemBoxes=[{"lat": 47.40, "lon": -122.28, "alt": 200}]))
    many = add_course.normalize(two_gate_course(itemBoxes=[
        {"lat": 47.4 + i * 0.001, "lon": -122.3, "alt": 132} for i in range(add_course.MAX_ITEM_BOXES)]))
    legacy = add_course.normalize(two_gate_course(itemBox={"lat": 47.44, "lon": -122.3, "alt": 132}))
    hashes = {add_course.course_hash(c) for c in (plain, boxed, moved, many, legacy)}
    assert len(hashes) == 1, hashes
    assert not add_course.geometry_changed(plain, boxed)


def test_adding_item_boxes_to_an_existing_course_needs_no_force(env):
    add_course.add_course(two_gate_course())
    course = add_course.add_course(two_gate_course(itemBoxes=[{"lat": 47.44, "lon": -122.3, "alt": 132}]))
    assert len(course["itemBoxes"]) == 1


def test_renaming_without_force_does_not_require_force(env):
    add_course.add_course(two_gate_course())
    renamed = two_gate_course(name="Test Sprint Renamed")  # same id, same geometry, new name
    course = add_course.add_course(renamed)  # no --force needed: geometry unchanged
    assert course["name"] == "Test Sprint Renamed"


def test_index_keeps_cup_and_difficulty_and_sorts_by_id(env):
    add_course.add_course({"id": "zzz-course", "name": "Alpha", "gates": [{"lat": 0, "lon": 0, "alt": 0},
                                                                          {"lat": 0, "lon": 0.01, "alt": 0}]},
                          cup="Test Cup", difficulty="hard")
    add_course.add_course({"id": "aaa-course", "name": "Zulu", "gates": [{"lat": 0, "lon": 0, "alt": 0},
                                                                         {"lat": 0, "lon": 0.01, "alt": 0}]})
    index = json.loads((env / "index.json").read_text(encoding="utf-8"))
    assert [e["id"] for e in index] == ["aaa-course", "zzz-course"]
    assert index[1]["cup"] == "Test Cup" and index[1]["difficulty"] == "hard"
    # Re-adding without --cup keeps the existing tags; a new value replaces them.
    add_course.add_course({"id": "zzz-course", "name": "Alpha v2", "gates": [{"lat": 0, "lon": 0, "alt": 0},
                                                                             {"lat": 0, "lon": 0.01, "alt": 0}]})
    index = json.loads((env / "index.json").read_text(encoding="utf-8"))
    assert index[1] == {"id": "zzz-course", "name": "Alpha v2", "file": "zzz-course.json", "cup": "Test Cup", "difficulty": "hard"}
    assert "cup" not in index[0]


# --------------------------------------------------------------- env (weather / time / buildings)
_VECTORS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "env_hash_vectors.json")


def test_env_round_trips_and_is_written_only_when_present(env):
    course = add_course.add_course(two_gate_course(env={"buildings": True, "time": {"localHour": 18.5, "season": 75},
                                                         "weather": {"clouds": 90.0, "windKt": 12, "windDir": 40}}))
    assert course["env"] == {"buildings": True, "time": {"localHour": 18.5, "season": 75},
                             "weather": {"clouds": 90, "windKt": 12, "windDir": 40}}
    assert list(course) == ["id", "name", "version", "aircraftId", "startType", "itemBoxes", "env", "gates"]
    plain = add_course.normalize(two_gate_course())
    assert "env" not in plain
    assert add_course.normalize(two_gate_course(env=None)) == plain
    assert add_course.normalize(two_gate_course(env={"weather": {}})) == plain


@pytest.mark.parametrize("bad_env, msg", [
    ("sunny", "env must be an object"),
    ({"rain": 1}, "unknown field"),
    ({"buildings": "yes"}, "env.buildings must be true or false"),
    ({"time": {"localHour": 25}}, "env.time.localHour must be a number from 0 to 24"),
    ({"time": {"season": 3.5, "day": 1}}, "unknown field"),
    ({"weather": {"clouds": 101}}, "env.weather.clouds must be a number from 0 to 100"),
    ({"weather": {"windKt": -1}}, "env.weather.windKt"),
    ({"weather": {"windDir": 400}}, "env.weather.windDir"),
    ({"weather": {"turbulence": True}}, "env.weather.turbulence"),
    ({"weather": {"windSpeed": 10}}, "windKt, in knots"),
    ({"weather": "overcast"}, "env.weather must be an object"),
])
def test_env_is_validated_strictly(env, bad_env, msg):
    with pytest.raises(add_course.CourseError, match=msg):
        add_course.add_course(two_gate_course(env=bad_env))


def test_env_hash_vectors_match_race_js():
    """env_hash_vectors.json was produced by race.js's Course.hash() and is asserted by run.js too."""
    with open(_VECTORS, encoding="utf-8") as f:
        vectors = json.load(f)
    for v in vectors:
        assert add_course.course_hash(add_course.normalize(v["course"])) == v["hash"], v["label"]


def test_a_cosmetic_env_needs_no_force_but_wind_does(env):
    add_course.add_course(two_gate_course())
    add_course.add_course(two_gate_course(env={"buildings": True, "weather": {"clouds": 80}}))
    with pytest.raises(add_course.CourseError, match="--force"):
        add_course.add_course(two_gate_course(env={"weather": {"windKt": 10, "windDir": 90}}))
    add_course.add_course(two_gate_course(env={"weather": {"windKt": 10, "windDir": 90}}), force=True)
