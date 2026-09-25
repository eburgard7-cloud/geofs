#!/usr/bin/env python3
"""Warm the tile proxy's TERRAIN disk cache for every shared course, once per course hash.

    python race/tools/warm_tiles.py --dry-run                   # tile counts per course, fetch nothing
    python race/tools/warm_tiles.py --cache-dir /mnt/user/appdata/stack/race/data/tiles
    python race/tools/warm_tiles.py --cache-dir ... --force     # ignore the manifest, re-check every tile

The server does the same thing by itself at startup (RACE_TILE_WARM, default on), so this is for
warming a cache dir by hand: a fresh volume, or a deploy running with RACE_TILE_WARM=0. It runs the
server's own code (race/server/app.py's _tile_warm_run): Terrarium tiles over each course's gate
corridor (about a 3 km buffer) at z8-z12 plus z0-z2 globally, written through the same cache
path as a viewer's request, skipping tiles already on disk, throttled to --per-s, and recorded in
<cache-dir>/.warm-manifest.json keyed by course hash. Run it as the container's user (99:100)
or chown the files afterwards, or the server's writes into the same dirs will fail.

Terrain only, on purpose: imagery and labels are Esri tiles, and Esri's basemap terms restrict
bulk download/offline caching, so they are never bulk-prefetched -- they stay on-demand only.

Talks only to the Terrarium bucket on AWS; never to api.cesium.com or opentopodata.org.
"""
from __future__ import annotations

import argparse
import asyncio
import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--cache-dir", help="tile cache dir (default: the server's RACE_TILE_CACHE_DIR logic)")
    ap.add_argument("--courses-dir", default=str(REPO_ROOT / "race" / "courses"))
    ap.add_argument("--per-s", type=float, default=None, help="max upstream fetches per second (default: server's)")
    ap.add_argument("--dry-run", action="store_true", help="print what would be warmed, fetch nothing")
    ap.add_argument("--force", action="store_true", help="ignore the manifest (cached tiles are still skipped)")
    args = ap.parse_args(argv)

    # The server module reads its config from the environment at import time.
    if args.cache_dir:
        os.environ["RACE_TILE_CACHE_DIR"] = args.cache_dir
    os.environ["RACE_COURSES_DIR"] = args.courses_dir
    sys.path.insert(0, str(REPO_ROOT / "race" / "server"))
    import app  # noqa: E402

    if app.refresh_courses() == 0:
        print(f"no courses loaded from {args.courses_dir}", file=sys.stderr)
        return 1
    manifest = app._tile_warm_manifest_load()
    if args.force:
        manifest["warmed"].clear()
        app._tile_warm_manifest_save(manifest)
    done = manifest["warmed"]
    print(f"cache dir: {app.TILE_CACHE_DIR}")
    print(f"{app.TILE_WARM_GLOBAL_KEY:<32} {len(app._tile_warm_global_tiles()):>5} tiles"
          f"{'  (warmed)' if app.TILE_WARM_GLOBAL_KEY in done else ''}")
    for c in app.COURSES:
        n = len(app._tile_warm_course_tiles(c["gate_coords"]))
        print(f"{c['course_id']:<32} {n:>5} tiles  {c['course_hash']}{'  (warmed)' if c['course_hash'] in done else ''}")
    if args.dry_run:
        return 0

    async def run() -> dict:
        try:
            return await app._tile_warm_run(list(app.COURSES), per_s=args.per_s)
        finally:
            await app._tile_upstream_close()

    stats = asyncio.run(run())
    print(f"fetched {stats['fetched']}, already cached {stats['cached']}, failed {stats['failed']}, "
          f"skipped {stats['skipped']} already warmed; newly warmed: {', '.join(stats['warmed']) or 'none'}")
    return 1 if stats["failed"] else 0


if __name__ == "__main__":
    sys.exit(main())
