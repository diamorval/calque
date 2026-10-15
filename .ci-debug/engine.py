# TEMPORARY: why does /usr/bin/chromium hang on the measure page in the engine job? (reverted before merge)
import json, os, subprocess, sys, tempfile, time
from pathlib import Path
from calque_engine import design_render as dr
from calque_engine.pack import load_pack

pack = load_pack(Path("../packs/acme-test"))
spec = json.load(open("../packages/deckspec/fixtures/design/valid/campaign.json"))
spec["pack_id"] = "acme-test"
spec, _ = dr.validate(spec, pack) if hasattr(dr, "validate") else (spec, None)
from calque_engine.design import validate
spec, _ = validate(spec, pack)
board = spec["artboards"][0]
th = dr.theme(pack, None)
tree, _ = dr.build_tree(spec, board, th, dr.load_images(spec, [pack.dir], None))
out = Path(tempfile.mkdtemp())
page = out / "post.measure.html"
page.write_text(dr.document(pack, spec, board, tree, measure=True), encoding="utf-8")

def run(label, extra, env=None, log=False):
    cmd = [dr.chromium(), "--headless", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
           "--disable-extensions", "--host-resolver-rules=MAP * ~NOTFOUND",
           f"--user-data-dir={tempfile.mkdtemp()}", "--no-sandbox",
           *(["--enable-logging=stderr", "--v=1"] if log else []), *extra, page.resolve().as_uri()]
    t = time.time()
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=25, env={**os.environ, **(env or {})})
        print(f"[{label}] rc={r.returncode} in {time.time()-t:.1f}s measured={'calque-measure' in r.stdout}", flush=True)
        if log: print(r.stderr[-3000:], flush=True)
    except subprocess.TimeoutExpired as e:
        so = e.output or ""; se = e.stderr or ""
        print(f"[{label}] TIMEOUT 25s stdout={len(so)}B measured={'calque-measure' in so}", flush=True)
        print(se[-6000:], flush=True)

print(dr.chromium(), subprocess.run([dr.chromium(), "--version"], capture_output=True, text=True).stdout.strip())
print("DBUS_SESSION_BUS_ADDRESS=", os.environ.get("DBUS_SESSION_BUS_ADDRESS"), "XDG_RUNTIME_DIR=", os.environ.get("XDG_RUNTIME_DIR"))
run("dump-dom", ["--dump-dom"])
run("dump-dom+log", ["--dump-dom"], log=True)
run("dump-dom+vt", ["--dump-dom", "--virtual-time-budget=5000"])
run("dump-dom nodbus", ["--dump-dom"], env={"DBUS_SESSION_BUS_ADDRESS": "/dev/null"})
run("dump-dom timeout", ["--dump-dom", "--timeout=5000"])
run("screenshot", ["--window-size=1080,1080", f"--screenshot={out/'a.png'}"])
run("dump-dom again", ["--dump-dom"])
