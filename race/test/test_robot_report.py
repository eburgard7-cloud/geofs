"""race/tools/robot_report.py: robot report JSON -> ROBOT.md, and the suggested-fix rules.
Run: cd race/server && python -m pytest ../test/test_robot_report.py -q"""
import json
import math
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tools"))
import robot_report as rr  # noqa: E402


def gate(n, **kw):
    g = {"n": n, "crossed": True, "missed": False, "radiusM": 150, "missM": 40.0, "sideM": 5.0,
         "legMinHaglM": 400.0, "gateHaglM": 450.0, "legMs": 60000}
    g.update(kw)
    return g


def course(cid, status, label, gates, abort=None, gate_n=None, reason=None, time_ms=None):
    return {"kind": "course", "id": cid, "name": cid, "group": "Cascade Cup", "aircraftId": "7", "status": status,
            "label": label, "reason": reason, "gate": gate_n, "timeMs": time_ms,
            "log": {"gates": gates, "abort": abort, "timeMs": time_ms, "lengthM": 20000}}


def report(results, mode="course"):
    return {"v": 1, "kind": "robot-report", "generated_at": "2026-09-24T18:00:00.000Z", "client_version": "1.7.0",
            "mode": mode, "results": results}


PASS = course("hood-circuit", "PASS", "PASS", [gate(1), gate(2), gate(3)], time_ms=192400)
TERRAIN = course("gorge-run", "FAIL", "FAIL(terrain on leg 3, 12.5 m AGL)", [gate(1), gate(2), gate(3, crossed=False)],
                 abort={"reason": "terrain", "gate": 3, "haglM": 12.5}, gate_n=3, reason="terrain on leg 3, 12.5 m AGL")
MISSED = course("crater-rim", "FAIL", "FAIL(missed gate 2)", [gate(1), gate(2, crossed=False, missed=True, missM=331.0, sideM=-280.0), gate(3)],
                gate_n=2, reason="missed gate 2")
BURIED = course("ecola", "UNREACHABLE", "UNREACHABLE(gate 2)", [gate(1), gate(2, crossed=False, gateHaglM=-42.0)],
                abort={"reason": "terrain", "gate": 2, "haglM": 9}, gate_n=2, reason="gate below terrain")
TIMEOUT = course("slow", "UNREACHABLE", "UNREACHABLE(gate 4)", [gate(1)], abort={"reason": "timeout", "gate": 4}, gate_n=4, reason="leg timeout")
SKIP = course("bushy", "SKIPPED", "SKIPPED(aircraft)", [], abort={"reason": "aircraft"}, reason="aircraft")


def test_ceil10_rounds_up_and_never_goes_negative():
    assert rr.ceil10(137.5) == 140 and rr.ceil10(140) == 140 and rr.ceil10(0.1) == 10 and rr.ceil10(-5) == 0


def test_terrain_fail_suggests_raising_both_ends_of_the_leg_by_the_margin_shortfall():
    fixes = rr.course_fixes(TERRAIN)
    assert [(f["gate"], f["op"], f["by_m"]) for f in fixes] == [(2, "raise_gate", 140), (3, "raise_gate", 140)]
    assert all(f["course"] == "gorge-run" and "12.5 m" in f["why"] for f in fixes)


def test_a_terrain_fail_on_the_first_leg_never_names_gate_zero():
    r = course("x", "FAIL", "FAIL(terrain on leg 1, 3 m AGL)", [gate(1, crossed=False)], abort={"reason": "terrain", "gate": 1, "haglM": 3})
    assert [f["gate"] for f in rr.course_fixes(r)] == [1]


def test_a_missed_gate_suggests_a_shift_toward_where_the_robot_flew_or_a_wider_radius():
    (fix,) = rr.course_fixes(MISSED)
    assert fix == {"course": "crater-rim", "gate": 2, "op": "shift_gate", "toward": "left", "by_m": 210,
                   "or_radius_m": 360, "why": fix["why"]}
    assert "331" in fix["why"] and "left" in fix["why"]


def test_unreachable_buried_gate_and_timeout():
    (buried,) = rr.course_fixes(BURIED)
    assert buried["op"] == "raise_gate" and buried["gate"] == 2 and buried["by_m"] == 200
    (review,) = rr.course_fixes(TIMEOUT)
    assert review["op"] == "review_gate" and review["gate"] == 4


def test_pass_and_skipped_suggest_nothing():
    assert rr.course_fixes(PASS) == [] and rr.course_fixes(SKIP) == []


def approach(rid, status, label, **log):
    return {"kind": "approach", "id": rid, "name": rid, "group": "White-Knuckle", "aircraftId": "13", "status": status,
            "label": label, "reason": None, "timeMs": None, "log": log}


def test_approach_terrain_suggests_the_steeper_angle_that_clears_by_the_margin():
    r = approach("vnlk-06", "TERRAIN", "TERRAIN(20 m at 2 nm)", glideDeg=3, minGpClearM=20.0, minGpClearAtNm=2.0)
    (fix,) = rr.approach_fixes(r)
    d = 2 * 1852
    want = math.ceil(math.degrees(math.atan2(15 + d * math.tan(math.radians(3)) + 130, d)) * 2) / 2
    assert fix["op"] == "approach" and fix["approach"] == {"angleDeg": want} and "note" not in fix
    assert 4.5 <= want <= 6


def test_approach_terrain_past_the_angle_cap_says_it_needs_a_custom_path():
    r = approach("vqpr-15", "TERRAIN", "TERRAIN(-300 m at 1 nm)", glideDeg=3, minGpClearM=-300.0, minGpClearAtNm=1.0)
    (fix,) = rr.approach_fixes(r)
    assert fix["approach"]["angleDeg"] == rr.MAX_APPROACH_DEG and "custom path" in fix["note"]


def test_approach_terrain_from_an_abort_uses_the_abort_point():
    r = approach("x", "TERRAIN", "TERRAIN", glideDeg=3, abort={"reason": "terrain", "haglM": 14.0, "distNm": 1.5})
    assert rr.approach_fixes(r)[0]["approach"]["angleDeg"] > 3


def test_spawn_low_and_offset():
    (low,) = rr.approach_fixes(approach("lflj-22", "SPAWN_LOW", "SPAWN_LOW", spawnHaglM=80.0, spawn={"distM": 5556}))
    assert low["approach"] == {"distNm": 1.8, "altOffsetM": 70}
    (off,) = rr.approach_fixes(approach("tncs-12", "OFFSET", "OFFSET(40 m)", geofsOffset={"crossM": 40.0, "alongM": -3.0}))
    assert off["op"] == "check_threshold" and off["crossM"] == 40.0
    assert rr.approach_fixes(approach("sea-tac-16c", "PASS", "PASS")) == []


def test_render_course_report_has_the_table_details_and_the_patch_list():
    md = rr.render(report([PASS, TERRAIN, MISSED, SKIP]), "robot.json")
    assert md.startswith("# Robot test pilot: courses, 2026-09-24")
    assert "4 flown: 2 FAIL, 1 PASS, 1 SKIPPED." in md
    assert "| `hood-circuit` | Cascade Cup | 7 | PASS | 3:12.4 |" in md
    assert "### `gorge-run`: FAIL(terrain on leg 3, 12.5 m AGL)" in md and "### `hood-circuit`" not in md
    assert "| 2 | MISSED | 331 | 150 | -280 |" in md
    block = md.split("```json\n")[1].split("```")[0].strip().splitlines()
    assert len(block) == 3 and all(json.loads(line)["course"] in ("gorge-run", "crater-rim") for line in block)
    assert "NOT applied" in md


def test_render_approach_report():
    r = approach("sea-tac-16c", "PASS", "PASS", spawnHaglM=300.0, minGpClearM=63.5, minGpClearAtNm=0.5,
                 at50={"crossM": 1.2}, geofsOffset={"crossM": 3.0})
    md = rr.render(report([r], mode="approach"))
    assert "# Robot test pilot: approaches" in md
    assert "| `sea-tac-16c` | White-Knuckle | 13 | PASS | 300 m | 63.5 m at 0.5 nm | 1.2 m | 3 m |" in md
    assert "None." in md


def test_render_refuses_something_that_is_not_a_robot_report():
    with pytest.raises(ValueError):
        rr.render({"kind": "something-else", "v": 1})
    with pytest.raises(ValueError):
        rr.render({"kind": "robot-report", "v": 99})


def test_cli_writes_the_dated_file(tmp_path):
    src = tmp_path / "robot.json"
    src.write_text(json.dumps(report([PASS, TERRAIN])), encoding="utf-8")
    out = tmp_path / "out" / "ROBOT.md"
    assert rr.main([str(src), "--out", str(out)]) == 0
    assert out.read_text(encoding="utf-8").startswith("# Robot test pilot")
    bad = tmp_path / "bad.json"
    bad.write_text("{nope", encoding="utf-8")
    assert rr.main([str(bad), "--stdout"]) == 2
