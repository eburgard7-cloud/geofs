#!/usr/bin/env python3
"""
Check and normalize a pilot-uploaded livery texture (the Garage's "Upload own texture").

The upload is decoded with Pillow, checked against the aircraft's native slot (size, square),
and re-encoded from pixels in the factory's native format under the 1.5 MB cap. Re-encoding is
the point: whatever the pilot sent (metadata, odd chunks, a renamed file), what gets stored and
served is a clean image the factory itself could have written.

  python tools/livery_upload.py f16 my_paint.png out.webp

Python: normalize(ac, data) -> (bytes, info) or raises UploadError with a message for the pilot.
"""
from __future__ import annotations

import hashlib
import io
import sys
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
import livery_common as lc  # noqa: E402

UPLOADABLE = ("f16", "b757")          # the Rafale is tint-only (no paint kit); use its template
MAX_UPLOAD_BYTES = 12_000_000          # raw upload ceiling before decoding
ACCEPT = {"PNG", "WEBP", "JPEG"}


class UploadError(ValueError):
    pass


def normalize(ac: str, data: bytes):
    if ac not in UPLOADABLE:
        raise UploadError(f"uploads aren't supported for {ac}; use a template instead")
    if len(data) > MAX_UPLOAD_BYTES:
        raise UploadError(f"file is {len(data) / 1e6:.1f} MB; the limit is "
                          f"{MAX_UPLOAD_BYTES / 1e6:.0f} MB")
    S = lc.AIRCRAFT[ac]["size"]
    Image.MAX_IMAGE_PIXELS = 4096 * 4096       # refuse decompression bombs before decoding
    try:
        im = Image.open(io.BytesIO(data))
        fmt = im.format
        if fmt not in ACCEPT:
            raise UploadError(f"{fmt or 'unknown'} files aren't accepted; use PNG, WebP or JPEG")
        if getattr(im, "n_frames", 1) > 1:
            raise UploadError("animated images aren't accepted")
        if im.size != (S, S):
            if im.width != im.height or im.width not in (S // 2, S * 2):
                raise UploadError(f"the {ac} texture is {S}x{S} px; this one is "
                                  f"{im.width}x{im.height}. Start from the paint kit.")
        im.load()
    except UploadError:
        raise
    except Exception as e:  # noqa: BLE001  (Pillow raises many types for bad input)
        raise UploadError(f"couldn't read that image ({type(e).__name__})") from None
    rgb = im.convert("RGB")
    if rgb.size != (S, S):
        rgb = rgb.resize((S, S), Image.LANCZOS)
    out, note = lc.encode(rgb, lc.AIRCRAFT[ac]["fmt"], lc.AIRCRAFT[ac].get("quality", 88))
    if len(out) > lc.MAX_BYTES:
        raise UploadError("even re-encoded this is over 1.5 MB; simplify fine noise/gradients")
    return out, {"aircraft": ac, "format": lc.AIRCRAFT[ac]["fmt"], "size": S, "bytes": len(out),
                 "note": note, "source_format": fmt, "sha256": hashlib.sha256(out).hexdigest()}


if __name__ == "__main__":
    ac, src, dst = sys.argv[1:4]
    try:
        data, info = normalize(ac, Path(src).read_bytes())
    except UploadError as e:
        print("REJECTED:", e)
        sys.exit(2)
    Path(dst).write_bytes(data)
    print(info)
