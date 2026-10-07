"""Style: every visual value drawing code may use, resolved from the active pack's roles."""

from __future__ import annotations

from dataclasses import dataclass, field
from functools import cache, cached_property
from pathlib import Path

from pptx.dml.color import RGBColor

from .pack import Pack


@cache
def _pil_font(path: str, size_pt: int):
    from PIL import ImageFont

    return ImageFont.truetype(path, max(1, size_pt))


@dataclass
class Grid:
    width: float
    height: float
    margin: float
    columns: dict[int, list[float]]
    gutter: float
    top: float
    bottom: float
    title: dict[str, float]
    page_number: dict[str, float] | None

    def cols(self, n: int) -> list[float]:
        """Left edges of an n-column grid; derived from the canvas when the pack lacks it."""
        if n in self.columns:
            return self.columns[n]
        w = self.cw(n)
        return [self.margin + i * (w + self.gutter) for i in range(n)]

    def cw(self, n: int) -> float:
        return (self.width - 2 * self.margin - (n - 1) * self.gutter) / n

    def span(self, n: int, i: int, k: int) -> float:
        return k * self.cw(n) + (k - 1) * self.gutter

    @property
    def bh(self) -> float:
        return self.bottom - self.top

    @property
    def bw(self) -> float:
        return self.width - 2 * self.margin

    def y(self, f: float) -> float:
        return self.top + f * self.bh

    def x(self, f: float) -> float:
        return self.margin + f * self.bw


@dataclass
class Style:
    pack: Pack
    _font_files: dict[str, Path] = field(default_factory=dict, init=False)

    def rgb(self, role: str) -> RGBColor:
        """`accent`, `wash.cover`, `series.2`, `status.info` ... or a raw `color.x` token path."""
        path = role if role.startswith(("color.", "role.", "theme.")) else f"role.color.{role}"
        return RGBColor.from_string(self.pack.color_at(path))

    def has_color(self, role: str) -> bool:
        return f"role.color.{role}" in self.pack.tokens

    def series(self, n: int) -> list[RGBColor]:
        """Chart series colours: accent first, then the quiet ramp, cycling."""
        ramp, i = [self.rgb("accent")], 1
        while self.has_color(f"series.{i}"):
            ramp.append(self.rgb(f"series.{i}"))
            i += 1
        return [ramp[k % len(ramp)] for k in range(n)]

    def font(self, role: str) -> str:
        return self.pack.font(role)

    def size(self, role: str) -> float:
        return self.pack.size(role)

    def stroke(self, role: str) -> float:
        return self.pack.stroke(role)

    @cached_property
    def grid(self) -> Grid:
        g = self.pack.manifest["grid"]
        canvas = self.pack.template_map["canvas"]
        cols = {int(k): v for k, v in g["columns"].items()}
        gutter = g.get("gutter_in")
        if gutter is None:
            n, xs = next(iter(sorted(cols.items())))
            w = (canvas["width_in"] - 2 * g["margin_in"]) / n
            gutter = max(0.0, (xs[1] - xs[0]) - w) if len(xs) > 1 else 0.2
        return Grid(
            width=canvas["width_in"],
            height=canvas["height_in"],
            margin=g["margin_in"],
            columns=cols,
            gutter=gutter,
            top=g["body_top_in"],
            bottom=g["footer_top_in"],
            title=g["title"],
            page_number=g.get("page_number"),
        )

    def missing(self, language: str) -> str:
        mv = self.pack.manifest["missing_value"]
        return mv.get(language) or mv.get(language.split("-")[0]) or next(iter(mv.values()))

    # --- font metrics ------------------------------------------------------------------------

    @cached_property
    def font_index(self) -> dict[str, Path]:
        """'family' and 'family style' (lowercased) -> font file, read from the files themselves."""
        from PIL import ImageFont

        out: dict[str, Path] = {}
        fonts_dir = self.pack.dir / "fonts"
        for f in sorted(fonts_dir.glob("*")) if fonts_dir.is_dir() else []:
            if f.suffix.lower() not in (".ttf", ".otf"):
                continue
            try:
                family, style = ImageFont.truetype(str(f), 12).getname()
            except OSError:
                continue
            family, style = (family or "").lower(), (style or "").lower()
            out.setdefault(f"{family} {style}", f)
            if style in ("regular", "", "300", "light") or family not in out:
                out.setdefault(family, f)
            out.setdefault(f.stem.lower().replace("-", " "), f)
        return out

    def font_file(self, name: str | None, bold: bool = False) -> Path | None:
        idx = self.font_index
        name = (name or self.font("body")).lower()
        for key in ((f"{name} bold",) if bold else ()) + (name, f"{name} regular"):
            if key in idx:
                return idx[key]
        return None

    def text_width(self, text: str, font: str | None, size_pt: float, bold: bool = False) -> float:
        """Rendered width in inches, from the pack's font file; ~0.5 em per glyph without one."""
        if not text:
            return 0.0
        f = self.font_file(font, bold)
        if f is None:
            return len(text) * size_pt * 0.5 / 72
        return _pil_font(str(f), round(size_pt)).getlength(text) / 72
