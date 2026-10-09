"""Spec validation: every committed spec builds, and broken specs are rejected with a reason."""
import copy
import json

import pytest

import livery_factory as F

GOOD = {
    "id": "t_ok", "aircraft": "b757", "name": "Test", "credits": "t", "seed": 1,
    "base": {"*": "#ffffff", "fin_l": "#ff0000"},
    "layers": [
        {"type": "stripe", "regions": ["fuselage_*"], "axis": "height", "center": 0.2,
         "width": 0.02, "color": "#000000"},
        {"type": "text", "text": "N4999F", "font": "Anton-Regular.ttf", "size": 20,
         "region": "fuselage_l", "anchor": {"length": 0.5, "height": 0.34},
         "baseline": "+length", "up": "+height"},
    ],
}


def test_all_committed_specs_validate():
    specs = F.load_specs()
    assert len(specs) == 84
    ids = [s["id"] for _, s in specs]
    assert len(ids) == len(set(ids))


def test_names_unique_per_aircraft():
    seen = {}
    for _, s in F.load_specs():
        key = s["aircraft"]
        assert s["name"] not in seen.setdefault(key, set()), s["name"]
        seen[key].add(s["name"])


def test_pack_counts():
    by_ac = {}
    for _, s in F.load_specs():
        by_ac[s["aircraft"]] = by_ac.get(s["aircraft"], 0) + 1
    assert by_ac == {"f16": 48, "b757": 20, "rafale": 16}


def test_good_spec_passes():
    F.validate_spec(copy.deepcopy(GOOD))


def _bad(mutate):
    s = copy.deepcopy(GOOD)
    mutate(s)
    with pytest.raises(F.SpecError):
        F.validate_spec(s)


@pytest.mark.parametrize("mutate", [
    lambda s: s.pop("seed"),
    lambda s: s.update(seed="7"),
    lambda s: s.update(aircraft="a380"),
    lambda s: s.update(id="Bad-Id"),
    lambda s: s["base"].update(nacelle_7="#ffffff"),
    lambda s: s["base"].update({"*": "orange"}),
    lambda s: s["layers"].append({"type": "sparkles"}),
    lambda s: s["layers"].append({"type": "fill", "regions": ["wing_top_l"], "color": "#fff"}),
    lambda s: s["layers"].append({"type": "fill", "color": "#ffffff", "where": {"altitude": [0, 1]}}),
    lambda s: s["layers"].append({"type": "fill", "color": "#ffffff", "where": {"side": "top"}}),
    lambda s: s["layers"].append({"type": "gradient", "stops": [[1.5, "#ffffff"]]}),
    lambda s: s["layers"].append({"type": "text", "text": "X", "font": "Arial.ttf", "pos": [1, 1]}),
    lambda s: s["layers"].append({"type": "text", "text": "", "pos": [1, 1]}),
    lambda s: s["layers"].append({"type": "text", "text": "X"}),
    lambda s: s["layers"].append({"type": "decal", "file": "nope.png", "pos": [1, 1]}),
    lambda s: s["layers"].append({"type": "decal", "file": "paw.png", "anchor": {"x": 1}}),
])
def test_bad_specs_rejected(mutate):
    _bad(mutate)


def test_system_fonts_are_never_used():
    # only files bundled in liveries/fonts/ resolve
    with pytest.raises(FileNotFoundError):
        F.lc.font("DejaVuSans.ttf", 20)


def test_rafale_spec_needs_its_block():
    s = {"id": "r", "aircraft": "rafale", "name": "r", "seed": 1}
    with pytest.raises(F.SpecError):
        F.validate_spec(s)
    s["rafale"] = {"finish": "matte", "tint": "#ffffff"}
    with pytest.raises(F.SpecError):
        F.validate_spec(s)


def test_file_name_must_match_id(tmp_path):
    p = tmp_path / "other_name.json"
    p.write_text(json.dumps(GOOD))
    with pytest.raises(F.SpecError):
        F.validate_spec(json.loads(p.read_text()), p)
