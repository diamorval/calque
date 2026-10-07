"""Golden decks: build a DeckSpec, render it, compare each slide to committed PNGs.

Set CALQUE_UPDATE_GOLDEN=1 to (re)write the reference images after a deliberate visual change."""

from __future__ import annotations

import json
import os
from pathlib import Path

from .build import build
from .pack import load_pack
from .render import render

DPI = 48
# share of pixels whose colour moved by more than PIXEL_DELTA: anti-aliasing drift stays far
# below it, a changed word or a moved box goes well above
PIXEL_DELTA = 48
TOLERANCE = 0.002


def check(deck_json: Path, pack_dir: Path, golden_dir: Path, work: Path) -> list[str]:
    """Return the list of slides that differ from the golden images (empty = pass)."""
    from PIL import Image, ImageChops, ImageStat

    pack = load_pack(pack_dir)
    deck = json.loads(deck_json.read_text(encoding="utf-8"))
    out = work / "deck.pptx"
    report = build(deck, pack, out)
    sources = {pos: n for pos, n in report.slides.values()}
    result = render(out, work / "render", pack, dpi=DPI, sources=sources)
    golden_dir.mkdir(parents=True, exist_ok=True)
    update = os.environ.get("CALQUE_UPDATE_GOLDEN") == "1"
    failures = []
    for png in sorted(result.pngs, key=lambda p: int(Path(p).stem.split("-")[1])):
        ref = golden_dir / Path(png).name
        if update or not ref.exists():
            Image.open(png).save(ref, optimize=True)
            continue
        a, b = Image.open(png).convert("RGB"), Image.open(ref).convert("RGB")
        if a.size != b.size:
            failures.append(f"{ref.name}: size {a.size} != {b.size}")
            continue
        delta = (
            ImageChops.difference(a, b).convert("L").point(lambda v: 255 if v > PIXEL_DELTA else 0)
        )
        share = ImageStat.Stat(delta).mean[0] / 255
        if share > TOLERANCE:
            failures.append(f"{ref.name}: {share:.2%} of pixels differ (> {TOLERANCE:.1%})")
    stale = {p.name for p in golden_dir.glob("slide-*.png")} - {Path(p).name for p in result.pngs}
    failures += [f"{name}: golden image without a slide" for name in sorted(stale)]
    return failures
