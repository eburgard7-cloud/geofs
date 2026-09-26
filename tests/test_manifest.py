"""Manifests: both validate, existing airline.json entries untouched, validator catches errors."""
import json

import livery_factory as F
import livery_manifest as M

SPECS = [s for _, s in F.load_specs()]
PACK_NAMES = sorted({e["name"] for es in M.pack_entries(SPECS, "main").values() for e in es})


def test_main_and_preview_validate():
    assert M.validate(M.MAIN) == []
    assert M.validate(M.PREVIEW) == []


def test_existing_airline_entries_byte_identical():
    # strip exactly what the factory inserted: what's left is the pre-pack file, byte for byte
    assert M.sha256(M.MAIN, PACK_NAMES) == M.ORIGINAL_SHA256


def test_main_has_pack_on_main_urls_and_preview_on_branch_urls():
    main = json.loads(M._read(M.MAIN)[0])
    prev = json.loads(M._read(M.PREVIEW)[0])
    assert prev["name"] == M.PREVIEW_NAME and main["name"] == "Finsonly Air"
    for key, entries in M.pack_entries(SPECS, "main").items():
        mnames = {lv["name"]: lv for lv in main["aircrafts"][key]["liveries"]}
        pnames = {lv["name"]: lv for lv in prev["aircrafts"][key]["liveries"]}
        for e in entries:
            assert mnames[e["name"]]["texture"] == e["texture"]
            for t in pnames[e["name"]]["texture"]:
                assert "/geofs/main/" not in t
            assert any("/geofs/livery-pack-1/" in t for t in pnames[e["name"]]["texture"])


def test_preview_keeps_every_existing_entry():
    main = json.loads(M._read(M.MAIN)[0])
    prev = json.loads(M._read(M.PREVIEW)[0])
    for key, ac in main["aircrafts"].items():
        assert [lv for lv in ac["liveries"] if lv["name"] not in PACK_NAMES] == \
            [lv for lv in prev["aircrafts"][key]["liveries"] if lv["name"] not in PACK_NAMES]


def test_no_jsdelivr_for_our_files():
    for p in (M.MAIN, M.PREVIEW):
        data = json.loads(M._read(p)[0])
        for ac in data["aircrafts"].values():
            for lv in ac["liveries"]:
                for t in lv["texture"]:
                    assert "jsdelivr" not in t or t.startswith(M.UPSTREAM)


def test_insert_is_idempotent():
    text = M._read(M.MAIN)[0]
    again, chunks = M.insert_entries(text, M.pack_entries(SPECS, "main"))
    assert again == text and chunks == []


def _manifest(tmp_path, liveries, key="7"):
    p = tmp_path / "m.json"
    p.write_text(json.dumps({"name": "x", "aircrafts": {key: {"name": "x", "liveries": liveries}}}))
    return p


def test_validator_catches_missing_file(tmp_path):
    p = _manifest(tmp_path, [{"name": "a", "texture": [M.url("liveries/out/nope.webp", "main")]}])
    assert any("does not exist" in e for e in M.validate(p))


def test_validator_catches_duplicate_names(tmp_path):
    t = [M.url("khabo_f16.webp", "main")]
    p = _manifest(tmp_path, [{"name": "a", "texture": t}, {"name": "a", "texture": t}])
    assert any("duplicate" in e for e in M.validate(p))


def test_validator_catches_foreign_urls_and_bad_json(tmp_path):
    p = _manifest(tmp_path, [{"name": "a", "texture": ["https://example.com/x.webp"]}])
    assert any("neither" in e for e in M.validate(p))
    bad = tmp_path / "bad.json"
    bad.write_text("{nope")
    assert any("does not parse" in e for e in M.validate(bad))


def test_validator_accepts_existing_files(tmp_path):
    p = _manifest(tmp_path, [{"name": "a", "texture": [M.url("khabo_f16.webp", "livery-pack-1")]}])
    assert M.validate(p) == []
