"""
LiverySelector manifests for the livery factory, and the manifest validator.

  preview  liveries/airline.preview.json: airline.json plus the pack, pack textures served from
           the livery-pack-2 branch (raw.githubusercontent, ~5 min cache), for testing before merge
  main     appends the pack to airline.json with /main/ URLs. Existing entries stay byte-for-byte
           identical: new entries are inserted as text just before each aircraft's closing ']'.

python tools/livery_manifest.py --validate airline.json liveries/airline.preview.json
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import livery_common as lc  # noqa: E402

REPO = "eburgard7-cloud/geofs"
RAW = "https://raw.githubusercontent.com/" + REPO + "/{branch}/{path}"
PREVIEW_BRANCH = "livery-pack-2"
MAIN = lc.ROOT / "airline.json"
PREVIEW = lc.LIV / "airline.preview.json"
PREVIEW_NAME = "Finsonly Air PREVIEW (livery-pack-2)"
# upstream LiverySelector files the existing Rafale entry already points at (normal + cockpit)
UPSTREAM = "https://cdn.jsdelivr.net/gh/kolos26/GEOFS-LiverySelector@main/"
RAFALE_NORMAL = UPSTREAM + "liveries/dessault_rafale/normal/Image_0.webp"
RAFALE_COCKPIT = UPSTREAM + "liveries/dessault_rafale/cockpit/Image_4.webp"
# sha256 of airline.json as it was on main before Pack 1 (see tests/test_manifest.py)
ORIGINAL_SHA256 = "636ec50e211480af34401eed72d8c0ec222018f3da06993c96bfb79b0831afec"

REGION_ID = [
    ("7", "UV REGION ID (test)", "liveries/test/f16_region_id.webp"),
    ("GXD04N_126645_238", "UV REGION ID (test)", "liveries/test/b757_region_id.png"),
]


def url(path, branch):
    return RAW.format(branch=branch, path=Path(path).as_posix())


def pack_entries(specs, branch):
    """-> {aircraft key: [livery dicts]} for every spec, in spec order, plus the region-ID
    test sheets."""
    import livery_factory as F
    out = {}
    for key, name, path in REGION_ID:
        out.setdefault(key, []).append(
            {"name": name, "texture": [url(path, branch)], "credits": "FINSONLY Livery Factory"})
    for spec in specs:
        if spec.get("listed", True) is False:      # mode paints (Gun Game): applied by race.js only
            continue
        ac = spec["aircraft"]
        paths = [p.relative_to(lc.ROOT) for p in F.out_paths(spec)]
        if ac == "rafale":
            tex = [RAFALE_NORMAL, url(paths[0], branch), url(paths[1], branch), RAFALE_COCKPIT]
        else:
            tex = [url(paths[0], branch)]
        out.setdefault(lc.AIRCRAFT[ac]["key"], []).append(
            {"name": spec["name"], "texture": tex, "credits": spec.get("credits", "FINSONLY")})
    return out


def _fmt_entry(e, indent=8):
    pad = " " * indent
    lines = [pad + "{", f'{pad}  "name": {json.dumps(e["name"])},', f'{pad}  "texture": [']
    for i, t in enumerate(e["texture"]):
        lines.append(f"{pad}    {json.dumps(t)}" + ("," if i < len(e["texture"]) - 1 else ""))
    lines += [f"{pad}  ],", f'{pad}  "credits": {json.dumps(e["credits"])}', pad + "}"]
    return "\n".join(lines)


def _match_bracket(text, i):
    """Index of the bracket closing the one at text[i], skipping JSON strings."""
    open_c = text[i]
    close_c = {"[": "]", "{": "}"}[open_c]
    depth, j, n = 0, i, len(text)
    while j < n:
        c = text[j]
        if c == '"':
            j += 1
            while text[j] != '"':
                j += 2 if text[j] == "\\" else 1
        elif c == open_c:
            depth += 1
        elif c == close_c:
            depth -= 1
            if depth == 0:
                return j
        j += 1
    raise ValueError("unbalanced JSON")


def insert_entries(text, entries):
    """Insert livery dicts into each aircraft's liveries array as text. Entries whose name the
    aircraft already has are skipped (re-running is a no-op). -> (new text, [inserted chunks])."""
    data = json.loads(text)
    chunks = []
    for key, items in entries.items():
        have = {lv["name"] for lv in data["aircrafts"].get(key, {}).get("liveries", [])}
        items = [e for e in items if e["name"] not in have]
        if not items:
            continue
        if key not in data["aircrafts"]:
            raise KeyError(f"aircraft {key} is not in the manifest; add it by hand first")
        m = re.search(r'"%s"\s*:\s*\{' % re.escape(key), text)
        obj_end = _match_bracket(text, m.end() - 1)
        lm = re.compile(r'"liveries"\s*:\s*\[').search(text, m.end(), obj_end)
        arr_end = _match_bracket(text, lm.end() - 1)
        k = arr_end - 1
        while text[k].isspace():
            k -= 1
        chunk = "".join(",\n" + _fmt_entry(e) for e in items)
        text = text[: k + 1] + chunk + text[k + 1:]
        chunks.append(chunk)
    return text, chunks


def strip_added(text, names):
    """Remove inserted entries (by name) from manifest text: undoes insert_entries exactly."""
    for name in names:
        pat = re.compile(r',\n        \{\n          "name": %s,\n.*?\n        \}' %
                         re.escape(json.dumps(name)), re.S)
        text = pat.sub("", text)
    return text


def _read(path):
    """-> (text with LF newlines, the file's newline). Checkouts on Windows may carry CRLF;
    git stores LF, and LF is what 'byte-identical' means for the committed file."""
    raw = Path(path).read_bytes().decode("utf-8")
    nl = "\r\n" if "\r\n" in raw else "\n"
    return raw.replace("\r\n", "\n"), nl


def _write(path, text, nl):
    Path(path).write_bytes(text.replace("\n", nl).encode("utf-8"))


def write(which, specs):
    main_text, nl = _read(MAIN)
    if which == "preview":
        base = strip_added(main_text, [e["name"] for es in pack_entries(specs, "x").values()
                                       for e in es])
        text, _ = insert_entries(base, pack_entries(specs, PREVIEW_BRANCH))
        text = text.replace('"name": "Finsonly Air"', f'"name": "{PREVIEW_NAME}"', 1)
        _write(PREVIEW, text, "\n")
        out = PREVIEW
    else:
        text, _ = insert_entries(main_text, pack_entries(specs, "main"))
        _write(MAIN, text, nl)
        out = MAIN
    errs = validate(out)
    if errs:
        raise SystemExit("manifest invalid:\n  " + "\n  ".join(errs))
    return [out]


def validate(path, root=lc.ROOT):
    """JSON parses; every texture URL on this repo maps to a file that exists at that path;
    upstream URLs are only the LiverySelector ones; no duplicate livery names per aircraft.
    -> list of error strings (empty = valid)."""
    errs = []
    try:
        data = json.loads(_read(path)[0])
    except (OSError, ValueError) as e:
        return [f"{path}: does not parse: {e}"]
    own = re.compile(r"https://raw\.githubusercontent\.com/%s/([^/]+)/(.+)$" % re.escape(REPO))
    for key, ac in data.get("aircrafts", {}).items():
        seen = set()
        for lv in ac.get("liveries", []):
            n = lv.get("name")
            if not n:
                errs.append(f"{key}: livery without a name")
            elif n in seen:
                errs.append(f"{key}: duplicate livery name '{n}'")
            seen.add(n)
            tex = lv.get("texture")
            if not isinstance(tex, list) or not tex:
                errs.append(f"{key}/{n}: texture must be a non-empty list")
                continue
            for t in tex:
                m = own.match(t)
                if m:
                    if not (Path(root) / m.group(2)).is_file():
                        errs.append(f"{key}/{n}: {t} -> {m.group(2)} does not exist")
                elif not t.startswith(UPSTREAM):
                    errs.append(f"{key}/{n}: {t} is neither this repo nor upstream LiverySelector")
    return errs


def sha256(path, strip_names=()):
    """sha256 of the LF-normalized text, optionally with the named pack entries removed."""
    text = strip_added(_read(path)[0], strip_names)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--validate", nargs="+", metavar="JSON")
    a = ap.parse_args()
    bad = 0
    for p in a.validate or [MAIN, PREVIEW]:
        e = validate(p)
        print(f"{p}: {'OK' if not e else str(len(e)) + ' error(s)'}")
        for x in e:
            print("  " + x)
        bad += len(e)
    sys.exit(1 if bad else 0)
