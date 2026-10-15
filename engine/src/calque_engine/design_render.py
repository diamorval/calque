"""DesignSpec -> HTML/CSS laid out by headless Chromium -> PNG, PDF, SVG; and code exports (HTML,
React, Tailwind). The node tree becomes one element tree (`Elem`): auto layout is flexbox, colours
and fonts are CSS variables named after the pack roles, one set per token mode. Chromium measures
every node (box, overflow, text lines with baselines) for the lint and the vector SVG."""

from __future__ import annotations

import base64
import html
import json
import os
import re
import shutil
import subprocess
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import tokens as tk
from .design import Format as DesignFormat
from .design import expand, format_of, walk
from .pack import Pack
from .slides import read_image
from .style import Style

PT_TO_PX = 4 / 3
DISPLAY_STYLES = {"cover_title", "divider_title", "title", "numeral", "numeral_xl"}
FONT_OF_STYLE = {"label": "label", "caption": "label", "body": "body"}
TAG_OF_STYLE = {"cover_title": "h1", "divider_title": "h1", "title": "h2"}
SHADOWS = {"sm": (1, 3, 0.12), "md": (4, 12, 0.16), "lg": (12, 32, 0.2)}  # dy, blur, opacity
JUSTIFY = {
    "start": "flex-start",
    "center": "center",
    "end": "flex-end",
    "space_between": "space-between",
}
ALIGN = {"start": "flex-start", "center": "center", "end": "flex-end", "stretch": "stretch"}


class RenderError(RuntimeError):
    pass


# --- theme -----------------------------------------------------------------------------------


@dataclass
class Theme:
    colors: dict[str, str]  # colour role -> '#RRGGBB'
    fonts: dict[str, str]  # display / body / label -> family
    weights: dict[str, int]
    sizes: dict[str, float]  # text style -> pt
    hairline: float  # pt
    fallback: dict[str, str] = field(default_factory=dict)

    def color(self, role: str) -> str:
        return self.colors[role]


def theme(pack: Pack, mode: str | None = None) -> Theme:
    """The pack's roles, in `mode` (its overrides resolved against the base values)."""
    values = dict(pack.tokens)
    if mode:
        overrides = tk.modes(pack.raw_tokens).get(mode)
        if overrides is None:
            raise tk.TokenError(f"unknown mode: {mode}")
        for path, v in overrides.items():
            m = tk.ALIAS.match(v) if isinstance(v, str) else None
            if m and m.group(1) not in values:
                raise tk.TokenError(f"mode {mode}: unknown token {m.group(1)}")
            values[path] = values[m.group(1)] if m else v
    colors = {
        p.removeprefix("role.color."): "#" + tk.hex6(v)
        for p, v in values.items()
        if p.startswith("role.color.")
    }
    roles = ("display", "body", "label")
    return Theme(
        colors=colors,
        fonts={r: tk.family(values[f"role.font.{r}"]) for r in roles},
        weights={r: int(values.get(f"role.fontWeight.{r}", 400)) for r in roles},
        sizes={
            p.removeprefix("role.size."): tk.pt(v)
            for p, v in values.items()
            if p.startswith("role.size.")
        },
        hairline=tk.pt(values.get("role.stroke.hairline", "0.75pt")),
        fallback=dict(pack.manifest.get("fonts", {}).get("fallback", {})),
    )


def font_stack(th: Theme, role: str) -> str:
    """The role's family, the pack's fallback for it, then the generic family."""
    names = dict.fromkeys(f for f in (th.fonts[role], th.fallback.get(role)) if f)
    return ", ".join(f'"{f}"' for f in names) + ", sans-serif"


def css_var(role: str) -> str:
    return "--c-" + role.replace(".", "-")


def _paint(p: Any) -> str:
    if isinstance(p, dict):
        pct = round(p["opacity"] * 100)
        return f"color-mix(in srgb, var({css_var(p['color'])}) {pct}%, transparent)"
    return f"var({css_var(p)})"


def _hex_paint(p: Any, th: Theme) -> tuple[str, float]:
    if isinstance(p, dict):
        return th.color(p["color"]), p["opacity"]
    return th.color(p), 1.0


def font_role(n: dict[str, Any]) -> str:
    return n.get("font") or FONT_OF_STYLE.get(n["style"], "display")


def text_px(n: dict[str, Any], th: Theme, fmt: DesignFormat) -> float:
    if n.get("size"):
        return float(n["size"])
    return round(th.sizes[n["style"]] * PT_TO_PX * fmt.scale, 2)


def stroke_px(stroke: dict[str, Any], th: Theme, fmt: DesignFormat) -> float:
    return stroke.get("width") or max(1.0, round(th.hairline * PT_TO_PX * fmt.scale, 1))


# --- element tree ----------------------------------------------------------------------------


@dataclass
class Elem:
    tag: str
    node: dict[str, Any]
    style: dict[str, str]
    children: list[Elem] = field(default_factory=list)
    text: str | None = None
    attrs: dict[str, str] = field(default_factory=dict)


def _px(v: float) -> str:
    return f"{round(v, 2):g}px"


def _box(v: Any) -> str:
    return " ".join(_px(x) for x in v) if isinstance(v, list) else _px(v)


def _sizing(n: dict[str, Any], parent_layout: dict[str, Any] | None, st: dict[str, str]) -> None:
    direction = parent_layout["direction"] if parent_layout else None
    for axis, prop in (("width", "row"), ("height", "column")):
        v = n.get(axis)
        main = direction == prop
        if isinstance(v, (int, float)):
            st[axis] = _px(v)
            if main:
                st["flex-shrink"] = "0"
        elif v == "fill":
            if main:
                st["flex"] = "1 1 0"
                st["min-" + axis] = "0"
            elif direction:
                st["align-self"] = "stretch"
            else:
                st[axis] = "100%"
        elif v == "hug":
            st[axis] = "fit-content"
    if direction == "row" and n["type"] == "text" and "width" not in n:
        st["min-width"] = "0"


def _layout(lay: dict[str, Any], st: dict[str, str]) -> None:
    st["display"] = "flex"
    st["flex-direction"] = lay["direction"]
    if lay.get("gap"):
        st["gap"] = _px(lay["gap"])
    if lay.get("padding"):
        st["padding"] = _box(lay["padding"])
    if lay.get("align"):
        st["justify-content"] = JUSTIFY[lay["align"]]
    # like design tools, children sit at the start across the direction unless told to stretch
    st["align-items"] = ALIGN[lay.get("cross", "start")]
    if lay.get("wrap"):
        st["flex-wrap"] = "wrap"


def build_tree(
    spec: dict[str, Any], board: dict[str, Any], th: Theme, images: dict[str, str]
) -> tuple[Elem, list[dict[str, Any]]]:
    """The artboard as an Elem tree, and its expanded node tree (instances resolved)."""
    fmt = format_of(board)
    nodes = expand(spec, board.get("children", []))
    st = {
        "position": "relative",
        "overflow": "hidden",
        "box-sizing": "border-box",
        "width": _px(fmt.width),
        "height": _px(fmt.height),
        "background": _paint(board.get("fill", "background")),
        "color": "var(--c-ink)",
    }
    if board.get("layout"):
        _layout(board["layout"], st)
    attrs = {"class": "cq-artboard", "data-id": board["id"]}
    mode = board.get("mode") or spec.get("mode")
    if mode:
        attrs["data-mode"] = mode
    root = Elem("div", board, st, attrs=attrs)
    root.children = [_elem(n, board.get("layout"), th, fmt, images) for n in nodes]
    return root, nodes


def _elem(n, parent_layout, th: Theme, fmt: DesignFormat, images) -> Elem:
    st: dict[str, str] = {"box-sizing": "border-box"}
    if "position" in n or not parent_layout:
        st["position"] = "absolute"
        pos = n.get("position", {"x": 0, "y": 0})
        st["left"], st["top"] = _px(pos["x"]), _px(pos["y"])
    _sizing(n, parent_layout, st)
    if "opacity" in n:
        st["opacity"] = f"{n['opacity']:g}"
    attrs = {"data-id": n["id"], "data-kind": n["type"]}
    t = n["type"]
    if n.get("radius") is not None:
        st["border-radius"] = _box(n["radius"])
    if n.get("stroke"):
        st["border"] = (
            f"{_px(stroke_px(n['stroke'], th, fmt))} solid {_paint(n['stroke']['color'])}"
        )
    if t == "frame":
        if n.get("layout"):
            _layout(n["layout"], st)
        elif "position" not in st:
            st["position"] = "relative"
        if n.get("fill"):
            st["background"] = _paint(n["fill"])
        if n.get("shadow"):
            dy, blur, a = SHADOWS[n["shadow"]]
            ink = f"color-mix(in srgb, var(--c-ink) {round(a * 100)}%, transparent)"
            st["box-shadow"] = f"0 {dy}px {blur}px {ink}"
        if n.get("clip"):
            st["overflow"] = "hidden"
        el = Elem("div", n, st, attrs=attrs)
        el.children = [_elem(c, n.get("layout"), th, fmt, images) for c in n.get("children", [])]
        return el
    if t == "text":
        role = font_role(n)
        size = text_px(n, th, fmt)
        st.update(
            {
                "margin": "0",
                "font-family": f"var(--f-{role})",
                "font-size": _px(size),
                "font-weight": "700" if n.get("bold") else str(th.weights[role]),
                "line-height": "1.1" if n["style"] in DISPLAY_STYLES else "1.35",
                "color": _paint(n.get("color", "ink")),
                "white-space": "pre-line",
            }
        )
        if n.get("align"):
            st["text-align"] = n["align"]
        if n.get("uppercase"):
            st["text-transform"] = "uppercase"
        return Elem(TAG_OF_STYLE.get(n["style"], "p"), n, st, text=n["text"], attrs=attrs)
    if t == "image":
        st["object-fit"] = n.get("fit", "cover")
        st["display"] = "block"
        attrs |= {"src": images.get(n["src"], ""), "alt": n.get("alt", "")}
        return Elem("img", n, st, attrs=attrs)
    # shape
    if n["shape"] == "ellipse":
        st["border-radius"] = "50%"
    if n["shape"] == "line":
        stroke = n.get("stroke") or {"color": n.get("fill", "rule")}
        st.pop("border", None)
        st["height"] = _px(stroke_px(stroke, th, fmt))
        st["background"] = _paint(stroke["color"])
    elif n.get("fill"):
        st["background"] = _paint(n["fill"])
    return Elem("div", n, st, attrs=attrs)


# --- HTML ------------------------------------------------------------------------------------


def _style_attr(st: dict[str, str]) -> str:
    return "; ".join(f"{k}: {v}" for k, v in st.items())


def _html(el: Elem, depth: int = 0) -> str:
    pad = "  " * depth
    attrs = "".join(f' {k}="{html.escape(v, quote=True)}"' for k, v in el.attrs.items())
    style = html.escape(_style_attr(el.style), quote=True)
    if el.tag == "img":
        return f'{pad}<img{attrs} style="{style}">'
    if el.text is not None:
        return f'{pad}<{el.tag}{attrs} style="{style}">{html.escape(el.text)}</{el.tag}>'
    inner = "\n".join(_html(c, depth + 1) for c in el.children)
    body = f"\n{inner}\n{pad}" if inner else ""
    return f'{pad}<{el.tag}{attrs} style="{style}">{body}</{el.tag}>'


def variables_css(pack: Pack, modes: list[str | None]) -> str:
    """The pack roles as CSS variables: the base values on :root, each mode's on its artboards."""
    out = []
    for mode in modes:
        th = theme(pack, mode)
        decls = [f"  {css_var(r)}: {c};" for r, c in sorted(th.colors.items())]
        decls += [f"  --f-{r}: {font_stack(th, r)};" for r in th.fonts]
        sel = f'.cq-artboard[data-mode="{mode}"]' if mode else ":root"
        out.append(f"{sel} {{\n" + "\n".join(decls) + "\n}")
    return "\n".join(out)


def font_faces(pack: Pack) -> str:
    """@font-face for each role family the pack ships a file for, as data: URLs (self-contained)."""
    style, out, done = Style(pack), [], set()
    for role in ("display", "body", "label"):
        family = pack.font(role)
        weight = int(pack.tokens.get(f"role.fontWeight.{role}", 400))
        for bold in (False, True):
            f = style.font_file(family, bold)
            key = (family, 700 if bold else weight)
            if f is None or key in done or (bold and f == style.font_file(family)):
                continue
            done.add(key)
            mime = "font/otf" if f.suffix.lower() == ".otf" else "font/ttf"
            data = base64.b64encode(f.read_bytes()).decode()
            out.append(
                f'@font-face {{ font-family: "{family}"; font-weight: {key[1]}; '
                f"src: url(data:{mime};base64,{data}); }}"
            )
    return "\n".join(out)


CSP = (
    "default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; "
    "script-src 'unsafe-inline'"
)

MEASURE_JS = r"""
// Measured in the load event, synchronously: headless Chromium dumps the DOM right after it and
// nothing async (fonts.ready, a frame) is guaranteed to run in between. The layout forced at the
// end starts the @font-face and image loads now, so the load event waits for them.
window.addEventListener('load', () => {
  const board = document.querySelector('.cq-artboard');
  const B = board.getBoundingClientRect();
  const out = {};
  for (const el of document.querySelectorAll('[data-id]')) {
    const r = el.getBoundingClientRect();
    const box = { x: r.left - B.left, y: r.top - B.top, w: r.width, h: r.height,
      overflow_x: el.scrollWidth > el.clientWidth + 1,
      overflow_y: el.scrollHeight > el.clientHeight + 1 };
    if (el.dataset.kind === 'text') {
      const lines = [];
      const range = document.createRange();
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        for (let i = 0; i < node.length; i++) {
          range.setStart(node, i); range.setEnd(node, i + 1);
          const c = range.getClientRects()[0];
          if (!c) continue;
          const top = c.top - B.top;
          let line = lines.find((l) => Math.abs(l.top - top) < Math.max(c.height / 2, 1));
          if (!line) {
            line = { top, left: c.left - B.left, right: c.right - B.left, text: '' };
            lines.push(line);
          }
          line.text += node.data[i];
          line.left = Math.min(line.left, c.left - B.left);
          line.right = Math.max(line.right, c.right - B.left);
        }
      }
      const mark = document.createElement('span');
      mark.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline';
      el.appendChild(mark);
      const base = mark.getBoundingClientRect().top - B.top;
      el.removeChild(mark);
      const last = lines[lines.length - 1];
      const ascent = last ? base - last.top : 0;
      box.lines = lines.filter((l) => l.text.trim()).map((l) => ({
        text: l.text.replace(/\s+$/, '').replace(/^\n+/, ''),
        x: l.left, y: l.top + ascent, w: l.right - l.left }));
      box.line_count = box.lines.length;
    }
    out[el.dataset.id] = box;
  }
  const m = document.createElement('div');
  m.id = 'calque-measure';
  m.setAttribute('data-m', JSON.stringify(out));
  document.body.appendChild(m);
});
document.documentElement.getBoundingClientRect();
"""


def document(
    pack: Pack, spec: dict[str, Any], board: dict[str, Any], tree: Elem, measure: bool
) -> str:
    """A self-contained HTML page holding one artboard. `measure`: with the measuring script and
    the CSP that keeps Chromium off the network (the render page); without: the HTML export."""
    fmt = format_of(board)
    mode = board.get("mode") or spec.get("mode")
    css = "\n".join(
        [
            font_faces(pack),
            variables_css(pack, [None, *([mode] if mode else [])]),
            f"@page {{ size: {fmt.width}px {fmt.height}px; margin: 0; }}",
            "html, body { margin: 0; padding: 0; }",
            "* { -webkit-print-color-adjust: exact; print-color-adjust: exact; }",
        ]
    )
    head = [
        '<meta charset="utf-8">',
        *([f'<meta http-equiv="Content-Security-Policy" content="{CSP}">'] if measure else []),
        f"<title>{html.escape(board.get('name') or spec['title'])}</title>",
        f"<style>\n{css}\n</style>",
    ]
    script = f"<script>{MEASURE_JS}</script>" if measure else ""
    lang = html.escape(spec["language"], quote=True)
    return (
        f'<!doctype html>\n<html lang="{lang}">\n<head>\n'
        + "\n".join(head)
        + f"\n</head>\n<body>\n{_html(tree)}\n{script}\n</body>\n</html>\n"
    )


# --- images ----------------------------------------------------------------------------------


def _mime(data: bytes) -> str:
    if data.startswith(b"\x89PNG"):
        return "image/png"
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    if b"<svg" in data[:512]:
        return "image/svg+xml"
    raise ValueError("unsupported image type (PNG, JPEG, WebP, GIF or SVG)")


def load_images(
    spec: dict[str, Any], roots: list[str | Path], file_root: str | Path | None = None
) -> dict[str, str]:
    """src -> data: URL for every image the spec uses (components included). `file:<id>` is an
    upload, read only under `file_root`; any other src is a relative path under one of `roots`."""
    srcs = set()
    trees = [b.get("children", []) for b in spec["artboards"]]
    for c in (spec.get("components") or {}).values():
        trees += [[c["node"]], list((c.get("variants") or {}).values())]
    for t in trees:
        srcs |= {n["src"] for n, _ in walk(t) if n["type"] == "image"}
    out = {}
    for src in sorted(srcs):
        if src.startswith("file:"):
            if file_root is None:
                raise ValueError(f"image {src!r}: uploaded files are not available here")
            data = read_image(src.removeprefix("file:"), [file_root])
        else:
            data = read_image(src, roots)
        out[src] = f"data:{_mime(data)};base64,{base64.b64encode(data).decode()}"
    return out


# --- Chromium --------------------------------------------------------------------------------

BROWSERS = (
    "chromium",
    "chromium-browser",
    "google-chrome",
    "google-chrome-stable",
    "headless_shell",
)


def chromium() -> str:
    """$CALQUE_CHROMIUM, else a Chromium on PATH, else Playwright's headless shell."""
    env = os.environ.get("CALQUE_CHROMIUM")
    if env:
        return env
    for name in BROWSERS:
        found = shutil.which(name)
        if found:
            return found
    root = Path(os.environ.get("PLAYWRIGHT_BROWSERS_PATH", Path.home() / ".cache/ms-playwright"))
    for pattern in (
        "chromium_headless_shell-*/chrome-linux/headless_shell",
        "chromium-*/chrome-linux/chrome",
    ):
        hits = sorted(root.glob(pattern))
        if hits:
            return str(hits[-1])
    raise RenderError("Chromium not found: install it or set CALQUE_CHROMIUM to render designs")


def _run(page: Path, args: list[str], timeout: int = 60) -> str:
    with tempfile.TemporaryDirectory(prefix="calque-chromium-") as profile:
        cmd = [
            chromium(),
            "--headless",
            "--disable-gpu",
            "--hide-scrollbars",
            "--no-first-run",
            "--disable-extensions",
            "--host-resolver-rules=MAP * ~NOTFOUND",
            f"--user-data-dir={profile}",
            *(["--no-sandbox"] if _no_sandbox() else []),
            *args,
            page.resolve().as_uri(),
        ]
        try:
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        except subprocess.TimeoutExpired as e:
            raise RenderError(f"Chromium timed out after {timeout} s") from e
        if r.returncode != 0:
            raise RenderError(f"Chromium failed ({r.returncode}): {r.stderr.strip()[-500:]}")
        return r.stdout


def _no_sandbox() -> bool:
    # root (CI containers) cannot use Chromium's sandbox; the page is ours and offline (CSP)
    return os.environ.get("CALQUE_CHROMIUM_NO_SANDBOX") == "1" or os.geteuid() == 0


MEASURE_RE = re.compile(r'id="calque-measure" data-m="([^"]*)"')


def measure(page: Path) -> dict[str, Any]:
    dom = _run(page, ["--dump-dom"])
    m = MEASURE_RE.search(dom)
    if not m:
        raise RenderError("Chromium returned no measurement (the page did not finish loading)")
    return json.loads(html.unescape(m.group(1)))


def screenshot(page: Path, out: Path, fmt: DesignFormat, scale: float = 1.0) -> Path:
    _run(
        page,
        [
            f"--window-size={fmt.width},{fmt.height}",
            f"--force-device-scale-factor={scale:g}",
            f"--screenshot={out.resolve()}",
        ],
    )
    return out


def pdf(page: Path, out: Path) -> Path:
    _run(
        page,
        ["--no-pdf-header-footer", f"--print-to-pdf={out.resolve()}"],
    )
    return out


# --- SVG -------------------------------------------------------------------------------------


def _rr(x, y, w, h, r) -> str:
    """Rounded rectangle path, one radius per corner (top-left, top-right, bottom-right, -left)."""
    tl, tr, br, bl = (min(v, w / 2, h / 2) for v in r)
    return (
        f"M{x + tl:g},{y:g} H{x + w - tr:g} A{tr:g},{tr:g} 0 0 1 {x + w:g},{y + tr:g} "
        f"V{y + h - br:g} A{br:g},{br:g} 0 0 1 {x + w - br:g},{y + h:g} H{x + bl:g} "
        f"A{bl:g},{bl:g} 0 0 1 {x:g},{y + h - bl:g} V{y + tl:g} "
        f"A{tl:g},{tl:g} 0 0 1 {x + tl:g},{y:g} Z"
    )


def _radii(n: dict[str, Any]) -> list[float]:
    r = n.get("radius") or 0
    return [float(v) for v in r] if isinstance(r, list) else [float(r)] * 4


def _clip(cid: str, b: dict[str, float], n: dict[str, Any]) -> str:
    d = _rr(b["x"], b["y"], b["w"], b["h"], _radii(n))
    return f'<clipPath id="{cid}"><path d="{d}"/></clipPath>'


def to_svg(
    spec: dict[str, Any],
    board: dict[str, Any],
    nodes: list[dict[str, Any]],
    boxes: dict[str, Any],
    th: Theme,
    images: dict[str, str],
) -> str:
    """Real vector SVG from the measured layout: rects, ellipses, paths, one <text> per line."""
    fmt = format_of(board)
    defs: list[str] = []
    q = lambda v: html.escape(str(v), quote=True)  # noqa: E731
    r2 = lambda v: f"{round(v, 2):g}"  # noqa: E731

    def shape(n, b, fill, stroke) -> str:
        x, y, w, h = b["x"], b["y"], b["w"], b["h"]
        paint = ""
        if fill:
            c, a = _hex_paint(fill, th)
            paint += f' fill="{c}"' + (f' fill-opacity="{a:g}"' if a < 1 else "")
        else:
            paint += ' fill="none"'
        if stroke:
            sw = stroke_px(stroke, th, fmt)
            paint += f' stroke="{th.color(stroke["color"])}" stroke-width="{sw:g}"'
            x, y, w, h = x + sw / 2, y + sw / 2, w - sw, h - sw
        if n.get("shape") == "ellipse":
            return (
                f'<ellipse cx="{r2(x + w / 2)}" cy="{r2(y + h / 2)}" '
                f'rx="{r2(w / 2)}" ry="{r2(h / 2)}"{paint}/>'
            )
        radii = _radii(n)
        if any(radii):
            d = _rr(round(x, 2), round(y, 2), round(w, 2), round(h, 2), radii)
            return f'<path d="{d}"{paint}/>'
        return f'<rect x="{r2(x)}" y="{r2(y)}" width="{r2(w)}" height="{r2(h)}"{paint}/>'

    def draw(n) -> str:
        b = boxes.get(n["id"])
        if b is None:
            return ""
        parts: list[str] = []
        t = n["type"]
        filt = ""
        if t == "frame" and n.get("shadow"):
            fid = f"shadow-{n['shadow']}"
            dy, blur, a = SHADOWS[n["shadow"]]
            if not any(fid in d for d in defs):
                defs.append(
                    f'<filter id="{fid}" x="-20%" y="-20%" width="140%" height="160%">'
                    f'<feDropShadow dx="0" dy="{dy}" stdDeviation="{blur / 2:g}" '
                    f'flood-color="{th.color("ink")}" flood-opacity="{a:g}"/></filter>'
                )
            filt = f' filter="url(#{fid})"'
        if t in ("frame", "shape") and (n.get("fill") or n.get("stroke")):
            if n.get("shape") == "line":
                stroke = n.get("stroke") or {"color": n.get("fill", "rule")}
                parts.append(shape(n, {**b}, {"color": stroke["color"], "opacity": 1}, None))
            else:
                parts.append(
                    shape(n, b, n.get("fill"), n.get("stroke")).replace("/>", f"{filt}/>", 1)
                )
        elif t == "shape" and n.get("shape") == "line":
            parts.append(shape(n, b, "rule", None))
        if t == "text":
            role = font_role(n)
            family = q(font_stack(th, role).replace('"', "'"))
            weight = 700 if n.get("bold") else th.weights[role]
            c, a = _hex_paint(n.get("color", "ink"), th)
            size = text_px(n, th, fmt)
            for line in b.get("lines", []):
                txt = line["text"].upper() if n.get("uppercase") else line["text"]
                parts.append(
                    f'<text x="{r2(line["x"])}" y="{r2(line["y"])}" font-family="{family}" '
                    f'font-size="{size:g}" font-weight="{weight}" fill="{c}"'
                    + (f' fill-opacity="{a:g}"' if a < 1 else "")
                    + f' xml:space="preserve">{html.escape(txt)}</text>'
                )
        if t == "image" and images.get(n["src"]):
            aspect = "xMidYMid slice" if n.get("fit", "cover") == "cover" else "xMidYMid meet"
            clip = ""
            if any(_radii(n)):
                cid = f"clip-{n['id']}"
                defs.append(_clip(cid, b, n))
                clip = f' clip-path="url(#{cid})"'
            parts.append(
                f'<image href="{images[n["src"]]}" x="{r2(b["x"])}" y="{r2(b["y"])}" '
                f'width="{r2(b["w"])}" height="{r2(b["h"])}" preserveAspectRatio="{aspect}"{clip}/>'
            )
        kids = "".join(draw(c) for c in n.get("children", []))
        if kids and n.get("clip"):
            cid = f"clip-{n['id']}"
            defs.append(_clip(cid, b, n))
            kids = f'<g clip-path="url(#{cid})">{kids}</g>'
        body = "".join(parts) + kids
        if "opacity" in n and body:
            body = f'<g opacity="{n["opacity"]:g}">{body}</g>'
        return f'<g id="{q(n["id"])}">{body}</g>' if body else ""

    bg, a = _hex_paint(board.get("fill", "background"), th)
    content = "".join(draw(n) for n in nodes)
    title = html.escape(board.get("name") or spec["title"])
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{fmt.width}" height="{fmt.height}" '
        f'viewBox="0 0 {fmt.width} {fmt.height}">\n<title>{title}</title>\n'
        f'<defs><clipPath id="artboard"><rect width="{fmt.width}" '
        f'height="{fmt.height}"/></clipPath>'
        + "".join(defs)
        + "</defs>\n"
        + '<g clip-path="url(#artboard)">'
        + f'<rect width="{fmt.width}" height="{fmt.height}" fill="{bg}"'
        + (f' fill-opacity="{a:g}"' if a < 1 else "")
        + f"/>{content}</g>\n</svg>\n"
    )


# --- code exports ----------------------------------------------------------------------------


def _camel(prop: str) -> str:
    head, *rest = prop.split("-")
    return head + "".join(p.capitalize() for p in rest)


def _jsx(el: Elem, depth: int) -> str:
    pad = "  " * depth
    style = ", ".join(
        f"{_camel(k) if not k.startswith('--') else json.dumps(k)}: {json.dumps(v)}"
        for k, v in el.style.items()
    )
    attrs = "".join(
        f" {'className' if k == 'class' else k}={json.dumps(v)}"
        for k, v in el.attrs.items()
        if k not in ("data-kind",)
    )
    open_ = f"{pad}<{el.tag}{attrs} style={{{{ {style} }}}}"
    if el.tag == "img":
        return open_ + " />"
    if el.text is not None:
        lines = el.text.split("\n")
        text = "<br />".join("{" + json.dumps(line) + "}" for line in lines)
        return f"{open_}>{text}</{el.tag}>"
    inner = "\n".join(_jsx(c, depth + 1) for c in el.children)
    return f"{open_}>\n{inner}\n{pad}</{el.tag}>" if inner else f"{open_} />"


def _component_name(title: str, board_id: str) -> str:
    words = re.findall(r"[A-Za-z0-9]+", f"{title} {board_id}")
    name = "".join(w[:1].upper() + w[1:] for w in words) or "Design"
    return name if name[0].isalpha() else f"Design{name}"


# Tailwind utilities for the declarations that have one; the rest become arbitrary properties.
TW_FIXED = {
    ("display", "flex"): "flex",
    ("flex-direction", "row"): "flex-row",
    ("flex-direction", "column"): "flex-col",
    ("flex-wrap", "wrap"): "flex-wrap",
    ("position", "absolute"): "absolute",
    ("position", "relative"): "relative",
    ("overflow", "hidden"): "overflow-hidden",
    ("box-sizing", "border-box"): "box-border",
    ("margin", "0"): "m-0",
    ("flex-shrink", "0"): "shrink-0",
    ("flex", "1 1 0"): "flex-1",
    ("min-width", "0"): "min-w-0",
    ("min-height", "0"): "min-h-0",
    ("align-self", "stretch"): "self-stretch",
    ("text-transform", "uppercase"): "uppercase",
    ("white-space", "pre-line"): "whitespace-pre-line",
    ("display", "block"): "block",
}
TW_PREFIX = {
    "gap": "gap",
    "padding": "p",
    "width": "w",
    "height": "h",
    "left": "left",
    "top": "top",
    "font-size": "text",
    "border-radius": "rounded",
    "opacity": "opacity",
    "line-height": "leading",
    "font-weight": "font",
    "justify-content": "justify",
    "align-items": "items",
    "text-align": "text",
    "object-fit": "object",
    "background": "bg",
    "color": "text",
}
TW_KEYWORD = {"justify-content", "align-items", "text-align", "object-fit"}
TW_NAMES = {"flex-start": "start", "flex-end": "end", "space-between": "between"}


def _tw(st: dict[str, str]) -> str:
    out = []
    for k, v in st.items():
        if (k, v) in TW_FIXED:
            out.append(TW_FIXED[(k, v)])
        elif k in TW_KEYWORD:
            out.append(f"{TW_PREFIX[k]}-{TW_NAMES.get(v, v)}")
        elif k in TW_PREFIX and " " not in v and ("(" not in v or v.startswith("var(")):
            hint = "length:" if k == "font-size" else ("color:" if k == "color" else "")
            out.append(f"{TW_PREFIX[k]}-[{hint}{v}]")
        else:
            out.append(f"[{k}:{v.replace(' ', '_')}]")
    return " ".join(out)


def _tailwind(el: Elem, depth: int) -> str:
    pad = "  " * depth
    attrs = "".join(
        f' {k}="{html.escape(v, quote=True)}"'
        for k, v in el.attrs.items()
        if k not in ("class", "data-kind")
    )
    cls = " ".join(x for x in (el.attrs.get("class", ""), _tw(el.style)) if x)
    open_ = f'{pad}<{el.tag} class="{html.escape(cls, quote=True)}"{attrs}'
    if el.tag == "img":
        return open_ + ">"
    if el.text is not None:
        return f"{open_}>{html.escape(el.text)}</{el.tag}>"
    inner = "\n".join(_tailwind(c, depth + 1) for c in el.children)
    return f"{open_}>\n{inner}\n{pad}</{el.tag}>" if inner else f"{open_}></{el.tag}>"


def code(
    pack: Pack, spec: dict[str, Any], board: dict[str, Any], tree: Elem, target: str
) -> tuple[str, str]:
    """(file name, source) of the artboard as `target`: html, react or tailwind."""
    mode = board.get("mode") or spec.get("mode")
    tokens_css = variables_css(pack, [None, *([mode] if mode else [])])
    if target == "html":
        return f"{board['id']}.html", document(pack, spec, board, tree, measure=False)
    if target == "react":
        name = _component_name(spec["title"], board["id"])
        faces = font_faces(pack)
        css = json.dumps(f"{faces}\n{tokens_css}" if faces else tokens_css)
        src = (
            f"// Generated by Calque from the DesignSpec {json.dumps(spec['title'])}, "
            f"artboard {board['id']}.\n"
            "// Colours and fonts are CSS variables named after the brand pack's roles.\n"
            f"const tokens = {css};\n\n"
            f"export default function {name}() {{\n  return (\n    <>\n"
            "      <style>{tokens}</style>\n"
            f"{_jsx(tree, 3)}\n    </>\n  );\n}}\n"
        )
        return f"{name}.tsx", src
    if target == "tailwind":
        body = _tailwind(tree, 1)
        src = (
            f'<!doctype html>\n<html lang="{html.escape(spec["language"], quote=True)}">\n<head>\n'
            '<meta charset="utf-8">\n'
            "<!-- Tailwind classes; the brand pack's roles are CSS variables below. -->\n"
            f"<style>\n{tokens_css}\n</style>\n</head>\n<body>\n{body}\n</body>\n</html>\n"
        )
        return f"{board['id']}.tailwind.html", src
    raise ValueError(f"unknown code target {target!r} (html, react, tailwind)")


# --- the engine op ---------------------------------------------------------------------------

OUTPUTS = ("png", "pdf", "svg", "html")


def render(
    spec: dict[str, Any],
    pack: Pack,
    out_dir: str | Path,
    artboards: list[str] | None = None,
    outputs: list[str] | tuple[str, ...] = ("png",),
    scale: float = 1.0,
    image_roots: list[str | Path] | None = None,
    file_root: str | Path | None = None,
) -> dict[str, Any]:
    """Validate, lay out, lint and export each artboard (all, or `artboards`) into `out_dir`:
    `<id>.png` (at `scale`), `.pdf`, `.svg`, `.html`. Returns per artboard its files, size and
    node boxes, plus the lint findings and the validation warnings."""
    from dataclasses import asdict

    from .design import validate
    from .design_lint import lint_artboard

    bad = set(outputs) - set(OUTPUTS)
    if bad:
        raise ValueError(f"unknown outputs {sorted(bad)} (png, pdf, svg, html)")
    spec, warnings = validate(spec, pack)
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    images = load_images(spec, image_roots or [pack.dir], file_root)
    wanted = artboards or [b["id"] for b in spec["artboards"]]
    unknown = set(wanted) - {b["id"] for b in spec["artboards"]}
    if unknown:
        raise ValueError(f"no artboard {sorted(unknown)}")
    result, findings = [], []
    for board in (b for b in spec["artboards"] if b["id"] in wanted):
        fmt = format_of(board)
        th = theme(pack, board.get("mode") or spec.get("mode"))
        tree, nodes = build_tree(spec, board, th, images)
        page = out / f"{board['id']}.measure.html"
        page.write_text(document(pack, spec, board, tree, measure=True), encoding="utf-8")
        boxes = measure(page)
        files: dict[str, str] = {}
        if "png" in outputs:
            files["png"] = str(screenshot(page, out / f"{board['id']}.png", fmt, scale))
        if "pdf" in outputs:
            files["pdf"] = str(pdf(page, out / f"{board['id']}.pdf"))
        if "svg" in outputs:
            f = out / f"{board['id']}.svg"
            f.write_text(to_svg(spec, board, nodes, boxes, th, images), encoding="utf-8")
            files["svg"] = str(f)
        if "html" in outputs:
            f = out / f"{board['id']}.html"
            f.write_text(document(pack, spec, board, tree, measure=False), encoding="utf-8")
            files["html"] = str(f)
        page.unlink()
        findings += lint_artboard(pack, spec["language"], board, nodes, boxes, th, fmt)
        result.append(
            {
                "id": board["id"],
                "format": fmt.id,
                "width": fmt.width,
                "height": fmt.height,
                "mode": board.get("mode") or spec.get("mode"),
                "files": files,
                "boxes": {
                    k: {kk: round(v[kk], 1) for kk in ("x", "y", "w", "h")}
                    for k, v in boxes.items()
                },
            }
        )
    merged = None
    if "pdf" in outputs and len(result) > 1:
        # the whole design in one file (export, Microsoft 365): one page per artboard, in order
        from pypdf import PdfWriter

        writer = PdfWriter()
        for a in result:
            writer.append(a["files"]["pdf"])
        merged = out / "design.pdf"
        with merged.open("wb") as f:
            writer.write(f)
    elif "pdf" in outputs and result:
        merged = Path(result[0]["files"]["pdf"])
    return {
        "artboards": result,
        **({"pdf": str(merged)} if merged else {}),
        "findings": [asdict(f) for f in findings],
        "warnings": [asdict(w) for w in warnings],
    }


def export_code(
    spec: dict[str, Any],
    pack: Pack,
    artboard: str,
    target: str,
    image_roots: list[str | Path] | None = None,
    file_root: str | Path | None = None,
) -> dict[str, str]:
    from .design import validate

    spec, _ = validate(spec, pack)
    board = next((b for b in spec["artboards"] if b["id"] == artboard), None)
    if board is None:
        raise ValueError(f"no artboard {artboard!r}")
    images = load_images(spec, image_roots or [pack.dir], file_root)
    th = theme(pack, board.get("mode") or spec.get("mode"))
    tree, _ = build_tree(spec, board, th, images)
    name, src = code(pack, spec, board, tree, target)
    return {"filename": name, "code": src}
