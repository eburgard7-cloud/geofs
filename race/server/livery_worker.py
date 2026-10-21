"""Render one Garage "Recolor + text" in its own process (app.py run_render_job() starts one per
job, one job at a time, and kills it at GARAGE_RENDER_TIMEOUT_S).

A separate process because a render is 30-60 s of numpy for an F-16: in the server's own process
it would hold the GIL against the event loop. It is nice'd so the relay always wins the CPU.

stdin:  {"tools": "<tools dir>", "template": "<id>", "params": {...}, "out_dir": "<dir>"}
stdout: {"files": [{"sha": "<sha256>", "ext": "webp", "bytes": n}, ...]}   exit 0
        {"error": "<message for the pilot>"}                                  exit 2 (bad params)
Anything else (a crash, a kill) is a failed job; app.py never shows a traceback to a pilot.

Files are written content-addressed (<sha>.<ext>) and atomically (temp file + os.replace), so a
killed render never leaves a half-written texture where the file route would serve it.
"""
import hashlib
import json
import os
import sys
import tempfile


def main() -> int:
    job = json.load(sys.stdin)
    try:
        os.nice(10)
    except (AttributeError, OSError):     # Windows (local runs): no nice, render anyway
        pass
    sys.path.insert(0, job["tools"])
    import livery_common as lc
    import livery_templates as T
    try:
        tpl = T.load_template(job["template"])
        out = T.render_bytes(job["template"], job["params"])
    except T.ParamError as e:
        print(json.dumps({"error": str(e)}))
        return 2
    ac = tpl["aircraft"]
    fmt = lc.AIRCRAFT[ac]["fmt"]
    os.makedirs(job["out_dir"], exist_ok=True)
    files = []
    for suffix, data, _note in out:
        ext = "webp" if suffix == "_spec" else fmt
        sha = hashlib.sha256(data).hexdigest()
        dst = os.path.join(job["out_dir"], f"{sha}.{ext}")
        if not os.path.exists(dst):
            fd, tmp = tempfile.mkstemp(dir=job["out_dir"], suffix=".part")
            with os.fdopen(fd, "wb") as f:
                f.write(data)
            os.replace(tmp, dst)
        files.append({"sha": sha, "ext": ext, "bytes": len(data)})
    print(json.dumps({"files": files}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
