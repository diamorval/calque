# TEMPORARY: diagnose the Chromium hang on the runner (removed before merge)
import json, subprocess, sys, time
from pathlib import Path
from calque_engine import design_render as dr
from calque_engine.pack import load_pack

pack_id = sys.argv[1]
d = json.load(open("../packages/deckspec/fixtures/design/valid/campaign.json"))
d["pack_id"] = pack_id
orig = dr._run
def run(page, args, timeout=60):
    t = time.time()
    try:
        out = orig(page, args, timeout=25)
        print(f"[{pack_id}] {args[0]} ok in {time.time()-t:.1f}s", flush=True)
        return out
    except dr.RenderError as e:
        print(f"[{pack_id}] {args[0]} FAILED in {time.time()-t:.1f}s: {e}", flush=True)
        cmd = [dr.chromium(), "--headless", "--no-sandbox", "--enable-logging=stderr", "--v=1",
               "--host-resolver-rules=MAP * ~NOTFOUND", "--dump-dom", page.resolve().as_uri()]
        try:
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=20)
            print("no-virtual-time dump-dom rc", r.returncode, "measured:", "calque-measure" in r.stdout)
            print(r.stderr[-4000:])
        except subprocess.TimeoutExpired as x:
            print("no-virtual-time also hung; stderr tail:\n", (x.stderr or b"")[-6000:].decode(errors="replace") if isinstance(x.stderr, bytes) else str(x.stderr)[-6000:])
        print("---- page head ----"); print(page.read_text()[:3000])
        raise
dr._run = run
try:
    dr.render(d, load_pack(Path(f"../packs/{pack_id}")), f"/tmp/dbg-{pack_id}", None, ["png"])
except Exception as e:
    print("render failed:", e)
