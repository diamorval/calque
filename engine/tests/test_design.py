"""DesignSpec: validation, components, patches, adaptation, themes, code and SVG exports; and,
when a Chromium is installed, the render and its lint."""

import copy
import json
import struct
from pathlib import Path

import pytest

from calque_engine import design as ds
from calque_engine import design_render as dr
from calque_engine.api import call
from calque_engine.pack import load_pack

REPO = Path(__file__).resolve().parents[2]
FIXTURE = REPO / "packages" / "deckspec" / "fixtures" / "design" / "valid" / "campaign.json"
DARK = {
    "role.color.background": "{theme.dk1}",
    "role.color.surface": "{theme.dk2}",
    "role.color.ink": "{theme.lt1}",
}


@pytest.fixture
def PACK(neutral_pack: Path) -> Path:
    """The neutral pack with a dark mode."""
    f = neutral_pack / "tokens.json"
    tree = json.loads(f.read_text())
    tree["$extensions"] = {"calque.modes": {"dark": DARK}}
    f.write_text(json.dumps(tree))
    return neutral_pack


@pytest.fixture
def spec():
    return {**json.loads(FIXTURE.read_text()), "pack_id": "neutral"}


@pytest.fixture
def pack(PACK):
    return load_pack(PACK)


def board(spec, bid="post"):
    return next(b for b in spec["artboards"] if b["id"] == bid)


def test_fixture_validates(spec, pack):
    _, warnings = ds.validate(spec, pack)
    assert warnings == []


@pytest.mark.parametrize(
    ("mutate", "message"),
    [
        (lambda s: board(s)["children"][0].update(color="brand_pink"), "unknown colour role"),
        (lambda s: board(s)["children"].append(board(s)["children"][0]), "duplicate node id"),
        (lambda s: board(s).update(format="billboard"), "unknown format"),
        (lambda s: board(s).update(format="custom"), "needs width and height"),
        (lambda s: s.update(mode="sepia"), "unknown mode"),
        (lambda s: s.update(pack_id="other"), "pack_id"),
        (lambda s: board(s)["children"][2].update(component="nope"), "unknown component"),
        (lambda s: board(s)["children"][2].update(variant="ghost"), "no variant"),
        (lambda s: board(s)["children"][0].update(text=""), "should be non-empty"),
    ],
)
def test_invalid_specs(spec, pack, mutate, message):
    mutate(spec)
    with pytest.raises(ds.DesignSpecError, match=message):
        ds.validate(spec, pack)


def test_component_that_contains_itself(spec, pack):
    inner = {"type": "instance", "id": "again", "component": "cta"}
    spec["components"]["cta"]["node"]["children"].append(inner)
    with pytest.raises(ds.DesignSpecError, match="contains itself"):
        ds.validate(spec, pack)


def test_expand_fills_props_and_prefixes_ids(spec):
    nodes = ds.expand(spec, board(spec)["children"])
    cta = nodes[2]
    assert cta["id"] == "cta1" and cta["component"] == "cta" and cta["type"] == "frame"
    assert cta["children"][0] == {**cta["children"][0], "id": "cta1__cta-label", "text": "Try it"}
    banner = ds.expand(spec, board(spec, "banner")["children"])
    outline = banner[1]
    assert "stroke" in outline and outline["children"][0]["text"] == "Learn more"  # default prop


def test_patch_ops(spec, pack):
    ops = [
        {"op": "set_node", "artboard": "post", "node_id": "headline", "props": {"text": "Hello"}},
        {"op": "set_node", "artboard": "post", "node_id": "sub", "props": {"color": None}},
        {
            "op": "insert_node",
            "artboard": "post",
            "parent_id": "body",
            "at": 0,
            "node": {"type": "text", "id": "kicker", "text": "Kick", "style": "caption"},
        },
        {"op": "delete_node", "artboard": "post", "node_id": "eyebrow"},
        {"op": "set_artboard", "artboard": "banner", "props": {"mode": None}},
        {"op": "adapt_artboard", "artboard": "post", "id": "post_story", "format": "story"},
        {"op": "set_field", "field": "mode", "value": "dark"},
    ]
    out, _ = ds.patch(spec, ops, pack)
    post = board(out)
    assert [n["id"] for n in post["children"]] == ["body", "cta1"]
    body = post["children"][0]["children"]
    assert [n["id"] for n in body] == ["kicker", "headline", "sub"]
    assert body[1]["text"] == "Hello" and "color" not in body[2]
    assert "mode" not in board(out, "banner") and out["mode"] == "dark"
    assert [b["id"] for b in out["artboards"]] == ["post", "post_story", "banner"]
    assert spec["artboards"][0]["children"][0]["id"] == "eyebrow"  # the input is not changed


def test_patch_errors(spec, pack):
    with pytest.raises(ds.DesignPatchError, match="cannot change"):
        ds.patch(
            spec,
            [{"op": "set_node", "artboard": "post", "node_id": "body", "props": {"type": "text"}}],
            pack,
        )
    with pytest.raises(ds.DesignPatchError, match="no node 'zz'"):
        ds.patch(spec, [{"op": "delete_node", "artboard": "post", "node_id": "zz"}], pack)
    with pytest.raises(ds.DesignPatchError, match="not a frame"):
        node = {"type": "text", "id": "x", "text": "x", "style": "body"}
        ds.patch(
            spec,
            [{"op": "insert_node", "artboard": "post", "parent_id": "eyebrow", "node": node}],
            pack,
        )
    with pytest.raises(ds.DesignSpecError, match="unknown colour role"):
        ds.patch(
            spec,
            [{"op": "set_node", "artboard": "post", "node_id": "sub", "props": {"color": "x"}}],
            pack,
        )


def test_adapt_scales_positions_and_spacing():
    src = {
        "id": "a",
        "format": "social_square",
        "layout": {"direction": "column", "padding": [64, 32, 64, 32], "gap": 16},
        "children": [
            {
                "type": "shape",
                "id": "s",
                "shape": "rect",
                "width": 100,
                "height": 50,
                "position": {"x": 540, "y": 540},
            }
        ],
    }
    out = ds.adapt(src, {"id": "b", "format": "story"})
    f = ds.formats()
    st = f["story"].scale / f["social_square"].scale
    assert out["id"] == "b" and out["format"] == "story"
    assert out["children"][0]["position"] == {"x": 540, "y": 960}
    assert out["children"][0]["width"] == round(100 * st, 1)
    assert out["layout"]["gap"] == round(16 * st, 1) and out["layout"]["padding"][0] == round(
        64 * st, 1
    )
    assert src["children"][0]["position"] == {"x": 540, "y": 540}


def test_formats_and_safe_margins():
    f = ds.formats()
    assert {"social_square", "story", "leaderboard", "poster_a4", "web_hero"} <= set(f)
    assert f["story"].safe_xy == (64, 220) and f["social_square"].safe_xy == (64, 64)
    custom = ds.format_of({"id": "x", "format": "custom", "width": 1000, "height": 500})
    assert (custom.width, custom.height, custom.kind) == (1000, 500, "custom")


def test_theme_modes(pack):
    base, dark = dr.theme(pack), dr.theme(pack, "dark")
    assert base.colors["background"] != dark.colors["background"]
    assert dark.colors["ink"] == base.colors["background"]  # light ink on dark
    assert base.colors["accent"] == dark.colors["accent"]
    css = dr.variables_css(pack, [None, "dark"])
    assert ":root {" in css and '.cq-artboard[data-mode="dark"]' in css and "--c-series-1:" in css


def test_html_tree_uses_roles_and_flexbox(spec, pack):
    tree, _ = dr.build_tree(spec, board(spec), dr.theme(pack), {})
    page = dr.document(pack, spec, board(spec), tree, measure=False)
    assert "var(--c-accent)" in page and "flex-direction: column" in page
    assert "justify-content: space-between" in page and "<h1" in page
    assert "<script" not in page and "Content-Security-Policy" not in page
    measured = dr.document(pack, spec, board(spec), tree, measure=True)
    assert "default-src 'none'" in measured and "calque-measure" in measured


def test_text_is_escaped(spec, pack):
    board(spec)["children"][0]["text"] = "<script>alert(1)</script>"
    tree, _ = dr.build_tree(spec, board(spec), dr.theme(pack), {})
    page = dr.document(pack, spec, board(spec), tree, measure=False)
    assert "<script>alert" not in page and "&lt;script&gt;" in page


@pytest.mark.parametrize(
    ("target", "expect"),
    [
        ("html", ["<!doctype html>", "var(--c-background)"]),
        (
            "react",
            [
                "export default function LaunchCampaignPost()",
                "flexDirection",
                "<style>{tokens}</style>",
            ],
        ),
        ("tailwind", ["flex flex-col", "gap-[24px]", "bg-[var(--c-accent)]", "justify-between"]),
    ],
)
def test_code_exports(PACK, spec, target, expect):
    r = call(
        {
            "op": "design_code",
            "pack": str(PACK),
            "design": spec,
            "artboard": "post",
            "target": target,
        }
    )
    assert r["ok"], r
    for e in expect:
        assert e in r["code"], (e, r["code"][:800])


def test_rounded_rect_path():
    d = dr._rr(0, 0, 100, 50, [10, 0, 10, 0])
    assert d.startswith("M10,0 H100") and d.endswith("Z")
    assert "A10,10 0 0 1 90,50" in d


def test_formats_op_lists_pack_vocabulary(PACK):
    r = call({"op": "design_formats", "pack": str(PACK)})
    assert r["ok"] and "dark" in r["modes"] and "accent" in r["color_roles"]
    assert "cover_title" in r["text_styles"] and any(f["id"] == "story" for f in r["formats"])


def test_invalid_design_error_shape(PACK, spec):
    spec["artboards"] = []
    r = call({"op": "design_validate", "pack": str(PACK), "design": spec})
    assert not r["ok"] and r["error"] == "invalid_design" and r["issues"]


# --- Chromium ----------------------------------------------------------------------------------


def _has_chromium() -> bool:
    try:
        dr.chromium()
        return True
    except dr.RenderError:
        return False


needs_chromium = pytest.mark.skipif(not _has_chromium(), reason="no Chromium to lay out designs")


def png_size(path: str) -> tuple[int, int]:
    data = Path(path).read_bytes()
    return struct.unpack(">II", data[16:24])


@needs_chromium
def test_render_exports_and_lint(PACK, spec, tmp_path):
    # a dark-blue label (muted is dk2 in the neutral pack): it does not read on the black banner
    spec["components"]["cta"]["variants"]["outline"]["children"][0]["color"] = "muted"
    r = call(
        {
            "op": "design_render",
            "pack": str(PACK),
            "design": spec,
            "out_dir": str(tmp_path),
            "outputs": ["png", "pdf", "svg", "html"],
            "scale": 0.5,
        }
    )
    assert r["ok"], r
    post, banner = r["artboards"]
    assert png_size(post["files"]["png"]) == (540, 540)
    assert Path(post["files"]["pdf"]).read_bytes().startswith(b"%PDF")
    svg = Path(post["files"]["svg"]).read_text()
    assert "<text" in svg and "Ship decks" in svg and 'id="cta1"' in svg
    assert post["boxes"]["post"] == {"x": 0, "y": 0, "w": 1080, "h": 1080}
    assert post["boxes"]["eyebrow"]["x"] == 64 and post["boxes"]["eyebrow"]["y"] == 64
    layout = {"overflow", "max_lines", "off_canvas", "safe_area"}
    assert not [f for f in r["findings"] if f["artboard"] == "post" and f["check"] in layout]
    checks = {(f["node"], f["check"]) for f in r["findings"] if f["artboard"] == "banner"}
    assert ("cta1__cta-label", "contrast") in checks
    assert not list(tmp_path.glob("*.measure.html"))


@needs_chromium
def test_lint_catches_overflow_small_text_and_off_canvas(PACK, spec, tmp_path):
    post = board(spec)
    post["children"][1]["children"][0]["text"] = "A headline far too long for three lines " * 3
    post["children"].append(
        {
            "type": "text",
            "id": "tiny",
            "text": "fine print",
            "style": "body",
            "size": 9,
            "width": 200,
            "position": {"x": 1000, "y": 500},
        }
    )
    post["children"].append(
        {
            "type": "frame",
            "id": "box",
            "width": 200,
            "height": 40,
            "position": {"x": 0, "y": 0},
            "layout": {"direction": "column"},
            "children": [
                {"type": "text", "id": "in", "text": "one\ntwo\nthree\nfour", "style": "body"}
            ],
        }
    )
    r = call(
        {
            "op": "design_render",
            "pack": str(PACK),
            "design": spec,
            "out_dir": str(tmp_path),
            "artboards": ["post"],
        }
    )
    assert r["ok"], r
    found = {(f["node"], f["check"]) for f in r["findings"]}
    assert ("headline", "max_lines") in found
    assert ("tiny", "min_text") in found and ("tiny", "type_scale") in found
    assert ("tiny", "off_canvas") in found
    assert ("box", "overflow") in found


@needs_chromium
def test_images_are_embedded_and_confined(PACK, spec, tmp_path):
    png = Path(tmp_path / "img")
    png.mkdir()
    # a 1x1 PNG
    (png / "dot.png").write_bytes(
        bytes.fromhex(
            "89504e470d0a1a0a0000000d4948445200000001000000010806000000"
            "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082"
        )
    )
    node = {
        "type": "image",
        "id": "pic",
        "src": "dot.png",
        "alt": "",
        "width": 100,
        "height": 100,
        "radius": 12,
    }
    s = copy.deepcopy(spec)
    board(s)["children"].insert(0, node)
    r = call(
        {
            "op": "design_render",
            "pack": str(PACK),
            "design": s,
            "out_dir": str(tmp_path / "o"),
            "artboards": ["post"],
            "outputs": ["svg"],
            "image_roots": [str(png)],
        }
    )
    assert r["ok"], r
    svg = Path(r["artboards"][0]["files"]["svg"]).read_text()
    assert 'href="data:image/png;base64,' in svg and 'clip-path="url(#clip-pic)"' in svg
    board(s)["children"][0]["src"] = "../secret.png"
    r = call(
        {
            "op": "design_render",
            "pack": str(PACK),
            "design": s,
            "out_dir": str(tmp_path / "o"),
            "image_roots": [str(png)],
        }
    )
    assert not r["ok"] and "relative path" in r["message"]
    board(s)["children"][0]["src"] = "file:dot.png"
    r = call(
        {"op": "design_render", "pack": str(PACK), "design": s, "out_dir": str(tmp_path / "o")}
    )
    assert not r["ok"] and "uploaded files are not available" in r["message"]
    r = call(
        {
            "op": "design_render",
            "pack": str(PACK),
            "design": s,
            "out_dir": str(tmp_path / "o"),
            "artboards": ["post"],
            "outputs": ["svg"],
            "file_root": str(png),
        }
    )
    assert r["ok"], r
