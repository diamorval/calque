"""Rule 4: no brand in core/ or engine/. Brand names and fonts come from every pack in packs/."""

import json
import re
from pathlib import Path

import yaml

from calque_engine import tokens as tk

REPO = Path(__file__).resolve().parents[2]
SCANNED = [REPO / "core", REPO / "engine" / "src", REPO / "engine" / "tests"]
COMMON_FONTS = ["Arial", "Calibri", "Helvetica", "Inter", "Roboto", "Times New Roman", "Georgia"]
HEX_MD = re.compile(r"(?<![0-9A-Za-z])#?[0-9A-Fa-f]{6}(?![0-9A-Za-z])")
HEX_CODE = re.compile(r"#[0-9A-Fa-f]{6}\b|[\"'][0-9A-Fa-f]{6}[\"']|0x[0-9A-Fa-f]{2},\s*0x")


def forbidden_words() -> set[str]:
    words = set(COMMON_FONTS)
    for manifest in (REPO / "packs").glob("*/pack.yaml"):
        m = yaml.safe_load(manifest.read_text())
        words |= {m["id"], m["name"], *m.get("lint", {}).get("extra_fonts", [])}
        tokens = manifest.parent / "tokens.json"
        if tokens.is_file():
            tree = json.loads(tokens.read_text())
            values = tk.resolve(tree)
            for path, t in tk.flatten(tree).items():
                if t.get("$type") == "fontFamily":
                    family = tk.family(values[path])
                    words |= {family, family.split()[0]}
    return {w for w in words if len(w) > 2}


def files():
    for root in SCANNED:
        for f in root.rglob("*"):
            if (
                f.is_file()
                and f.suffix in {".md", ".py", ".json", ".yaml", ".ts"}
                and f.name != "test_brand_free.py"
            ):
                yield f


def test_no_brand_font_or_hex_in_core_and_engine():
    words = forbidden_words()
    word_re = re.compile(r"\b(" + "|".join(map(re.escape, sorted(words))) + r")\b", re.I)
    hits = []
    for f in files():
        hex_re = HEX_MD if f.suffix == ".md" else HEX_CODE
        for n, line in enumerate(f.read_text(encoding="utf-8").splitlines(), 1):
            for m in (*word_re.finditer(line), *hex_re.finditer(line)):
                hits.append(f"{f.relative_to(REPO)}:{n}: {m.group(0)!r}")
    assert not hits, "brand values outside packs/:\n" + "\n".join(hits)
