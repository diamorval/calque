"""DesignSpec: validation against the shared JSON Schema (generated from packages/deckspec/src/
design.ts), the pack checks (colour roles, modes, formats), component expansion, patch ops and
format adaptation. Layout, rendering and exports are design_render.py; lint is design_lint.py."""

from __future__ import annotations

import copy
import json
from dataclasses import dataclass
from functools import cache
from importlib import resources
from typing import Any, Literal

import yaml
from jsonschema import Draft202012Validator, ValidationError
from jsonschema.exceptions import best_match

from . import tokens as tk
from .core import core_dir
from .pack import Pack

MAX_DEPTH = 12  # component instances inside components


@dataclass(frozen=True)
class DesignIssue:
    severity: Literal["ERROR", "WARN"]
    artboard: str | None
    node: str | None
    message: str

    def __str__(self) -> str:
        where = "/".join(x for x in (self.artboard, self.node) if x)
        return f"{self.severity} {f'[{where}] ' if where else ''}{self.message}"


class DesignSpecError(ValueError):
    def __init__(self, issues: list[DesignIssue]):
        self.issues = issues
        super().__init__("invalid DesignSpec:\n" + "\n".join(f"  {i}" for i in issues))


@dataclass(frozen=True)
class Format:
    id: str
    label: str
    kind: str
    width: int
    height: int
    scale: float
    min_text: float
    safe: float | list[float]  # one margin, or [top and bottom, sides]

    @property
    def safe_xy(self) -> tuple[float, float]:
        return (self.safe[1], self.safe[0]) if isinstance(self.safe, list) else (self.safe,) * 2


@cache
def formats() -> dict[str, Format]:
    raw = yaml.safe_load((core_dir() / "formats.yaml").read_text(encoding="utf-8"))["formats"]
    return {k: Format(id=k, **v) for k, v in raw.items()}


def format_of(board: dict[str, Any]) -> Format:
    """The artboard's format, its width / height overriding the preset's (and making 'custom')."""
    fid = board["format"]
    if fid == "custom":
        w, h = board.get("width"), board.get("height")
        if not w or not h:
            raise ValueError(f"artboard {board['id']}: format 'custom' needs width and height")
        # a custom canvas scales type like the nearest preset by width
        near = min(formats().values(), key=lambda f: abs(f.width - w))
        return Format("custom", "Custom", "custom", w, h, near.scale, near.min_text, near.safe)
    if fid not in formats():
        raise ValueError(f"artboard {board['id']}: unknown format {fid!r} (see list_formats)")
    f = formats()[fid]
    w, h = board.get("width") or f.width, board.get("height") or f.height
    return Format(f.id, f.label, f.kind, w, h, f.scale, f.min_text, f.safe)


@cache
def _validator() -> Draft202012Validator:
    schema = json.loads(
        resources.files("calque_engine.schemas").joinpath("designspec.schema.json").read_text()
    )
    return Draft202012Validator(schema)


def _explain(e: ValidationError) -> tuple[ValidationError, str]:
    """A union (node types, paints, sizes) fails as a whole; report the error of the branch the
    value meant: the one whose `type` matches, else the deepest one."""
    while e.context:
        branches: dict[Any, list[ValidationError]] = {}
        for sub in e.context:
            branches.setdefault(sub.relative_schema_path[0], []).append(sub)
        typed = [
            subs
            for subs in branches.values()
            if not any(list(x.relative_path)[-1:] == ["type"] for x in subs)
        ]
        if isinstance(e.instance, dict) and "type" in e.instance and len(typed) != 1:
            return e, f"unknown type {e.instance['type']!r}"
        e = best_match(typed[0] if len(typed) == 1 else e.context)
    return e, e.message


def color_roles(pack: Pack) -> set[str]:
    return {p.removeprefix("role.color.") for p in pack.tokens if p.startswith("role.color.")}


def walk(nodes: list[dict[str, Any]], parent: dict[str, Any] | None = None):
    """Every node of a tree, depth first, with its parent (None at the artboard)."""
    for n in nodes:
        yield n, parent
        yield from walk(n.get("children", []), n)


def validate(spec: dict[str, Any], pack: Pack) -> tuple[dict[str, Any], list[DesignIssue]]:
    """Schema, then pack checks. Returns the spec (defaults filled by the schema are not added:
    the engine reads with .get) and the warnings; raises DesignSpecError on any error."""
    errors = [
        DesignIssue("ERROR", None, None, f"{'/'.join(map(str, e.absolute_path)) or '$'}: {msg}")
        for e, msg in map(
            _explain, sorted(_validator().iter_errors(spec), key=lambda e: list(map(str, e.path)))
        )
    ]
    if errors:
        raise DesignSpecError(errors)
    issues: list[DesignIssue] = []
    err = lambda a, n, m: issues.append(DesignIssue("ERROR", a, n, m))  # noqa: E731
    warn = lambda a, n, m: issues.append(DesignIssue("WARN", a, n, m))  # noqa: E731
    if spec["pack_id"] != pack.id:
        err(None, None, f"pack_id {spec['pack_id']!r} but the pack is {pack.id!r}")
    roles, modes = color_roles(pack), tk.modes(pack.raw_tokens)
    comps = spec.get("components") or {}

    def check_mode(a, mode):
        if mode is not None and mode not in modes:
            err(
                a, None, f"unknown mode {mode!r} (pack modes: {', '.join(sorted(modes)) or 'none'})"
            )

    def check_tree(a: str | None, nodes: list[dict[str, Any]], parent_layout: bool, comp=None):
        seen: set[str] = set()
        for n, parent in walk(nodes):
            nid = n["id"]
            if nid in seen and comp is None:
                err(a, nid, f"duplicate node id {nid!r}")
            seen.add(nid)
            for key in ("fill", "color"):
                c = n.get(key)
                name = c.get("color") if isinstance(c, dict) else c
                if name is not None and name not in roles:
                    err(a, nid, f"{key}: unknown colour role {name!r} ({_some(roles)})")
            stroke = n.get("stroke")
            if stroke and stroke["color"] not in roles:
                err(a, nid, f"stroke: unknown colour role {stroke['color']!r} ({_some(roles)})")
            if n["type"] == "instance":
                c = comps.get(n["component"])
                if c is None:
                    err(a, nid, f"unknown component {n['component']!r}")
                elif n.get("variant") and n["variant"] not in (c.get("variants") or {}):
                    err(a, nid, f"component {n['component']!r} has no variant {n['variant']!r}")
                elif c is not None:
                    extra = set(n.get("props") or {}) - set(c.get("props") or {})
                    if extra:
                        warn(a, nid, f"props not declared by {n['component']!r}: {sorted(extra)}")
            in_layout = parent_layout if parent is None else bool(parent.get("layout"))
            if not in_layout and "position" not in n:
                warn(a, nid, "no auto layout around it and no position: drawn at the top-left")
            if n["type"] in ("shape", "image") and ("width" not in n or "height" not in n):
                if not (in_layout and (n.get("width") == "fill" or n.get("height") == "fill")):
                    warn(a, nid, f"{n['type']} without width and height: it may not show")

    for name, c in comps.items():
        for node in (c["node"], *(c.get("variants") or {}).values()):
            check_tree(None, [node], True, comp=name)
        if _cycles(name, comps):
            err(None, None, f"component {name!r} contains itself")
    check_mode(None, spec.get("mode"))
    ids: set[str] = set()
    for b in spec["artboards"]:
        if b["id"] in ids:
            err(b["id"], None, "duplicate artboard id")
        ids.add(b["id"])
        try:
            format_of(b)
        except ValueError as e:
            err(b["id"], None, str(e))
        check_mode(b["id"], b.get("mode"))
        fill = b.get("fill")
        name = fill.get("color") if isinstance(fill, dict) else fill
        if name is not None and name not in roles:
            err(b["id"], None, f"fill: unknown colour role {name!r}")
        check_tree(b["id"], b.get("children", []), bool(b.get("layout")))
    errors = [i for i in issues if i.severity == "ERROR"]
    if errors:
        raise DesignSpecError(issues)
    return spec, issues


def _some(roles: set[str]) -> str:
    top = sorted(r for r in roles if "." not in r)
    return "roles: " + ", ".join(top)


def _cycles(name: str, comps: dict[str, Any], stack: tuple[str, ...] = ()) -> bool:
    if name in stack:
        return True
    c = comps.get(name)
    if c is None:
        return False
    for node in (c["node"], *(c.get("variants") or {}).values()):
        for n, _ in walk([node]):
            if n["type"] == "instance" and _cycles(n["component"], comps, (*stack, name)):
                return True
    return False


# --- components ------------------------------------------------------------------------------

INSTANCE_KEEP = ("width", "height", "position", "opacity", "name")


def expand(spec: dict[str, Any], nodes: list[dict[str, Any]], depth: int = 0) -> list[dict]:
    """The tree with every instance replaced by a copy of its component (or variant): {prop}
    placeholders filled, the root taking the instance's id, size, position and opacity, the
    inner ids prefixed `<instance>__` so each stays unique. `component` records the source."""
    out = []
    comps = spec.get("components") or {}
    for n in nodes:
        if n["type"] == "instance":
            if depth > MAX_DEPTH:
                raise ValueError(f"instance {n['id']}: components nested too deep")
            c = comps[n["component"]]
            src = (c.get("variants") or {}).get(n.get("variant") or "", c["node"])
            props = {**(c.get("props") or {}), **(n.get("props") or {})}
            root = _fill_props(copy.deepcopy(src), props, n["id"])
            root.update({k: n[k] for k in INSTANCE_KEEP if k in n})
            root["id"], root["component"] = n["id"], n["component"]
            (expanded,) = expand(spec, [root], depth + 1)
            out.append(expanded)
        else:
            m = dict(n)
            if "children" in n:
                m["children"] = expand(spec, n["children"], depth)
            out.append(m)
    return out


def _fill_props(node: dict[str, Any], props: dict[str, str], prefix: str) -> dict[str, Any]:
    if node["type"] == "text":
        text = node["text"]
        for k, v in props.items():
            text = text.replace("{" + k + "}", v)
        node["text"] = text
    for child, _ in walk(node.get("children", [])):
        child["id"] = f"{prefix}__{child['id']}"
        if child["type"] == "text":
            for k, v in props.items():
                child["text"] = child["text"].replace("{" + k + "}", v)
    return node


# --- patch -----------------------------------------------------------------------------------


class DesignPatchError(ValueError):
    pass


FROZEN = {"type", "id", "children"}


def _board(spec: dict[str, Any], bid: str) -> dict[str, Any]:
    for b in spec["artboards"]:
        if b["id"] == bid:
            return b
    raise DesignPatchError(f"no artboard {bid!r}")


def _find(board: dict[str, Any], nid: str) -> tuple[list[dict[str, Any]], int]:
    """The list holding node `nid` and its index there."""

    def search(nodes):
        for i, n in enumerate(nodes):
            if n["id"] == nid:
                return nodes, i
            found = search(n.get("children", []))
            if found:
                return found
        return None

    found = search(board.get("children", []))
    if not found:
        raise DesignPatchError(f"no node {nid!r} on artboard {board['id']!r}")
    return found


def patch(spec: dict[str, Any], ops: list[dict[str, Any]], pack: Pack):
    """Apply `ops` in order to a copy of `spec`, then validate the result."""
    out = copy.deepcopy(spec)
    for i, op in enumerate(ops):
        try:
            _apply(out, op)
        except (KeyError, IndexError) as e:
            raise DesignPatchError(f"op {i} ({op.get('op')}): {e}") from e
        except DesignPatchError as e:
            raise DesignPatchError(f"op {i} ({op.get('op')}): {e}") from e
    return validate(out, pack)


def _apply(spec: dict[str, Any], op: dict[str, Any]) -> None:
    kind = op["op"]
    if kind == "set_node":
        frozen = FROZEN & set(op["props"])
        if frozen:
            raise DesignPatchError(f"set_node cannot change {sorted(frozen)}: use replace_node")
        nodes, i = _find(_board(spec, op["artboard"]), op["node_id"])
        merged = {**nodes[i], **op["props"]}
        nodes[i] = {k: v for k, v in merged.items() if v is not None}
    elif kind == "replace_node":
        nodes, i = _find(_board(spec, op["artboard"]), op["node_id"])
        nodes[i] = op["with"]
    elif kind == "insert_node":
        board = _board(spec, op["artboard"])
        if op.get("parent_id"):
            nodes, i = _find(board, op["parent_id"])
            if nodes[i]["type"] != "frame":
                raise DesignPatchError(f"{op['parent_id']!r} is a {nodes[i]['type']}, not a frame")
            target = nodes[i].setdefault("children", [])
        else:
            target = board.setdefault("children", [])
        at = op.get("at")
        target.insert(len(target) if at is None else at, op["node"])
    elif kind == "delete_node":
        nodes, i = _find(_board(spec, op["artboard"]), op["node_id"])
        del nodes[i]
    elif kind == "set_artboard":
        frozen = {"id", "children"} & set(op["props"])
        if frozen:
            raise DesignPatchError(f"set_artboard cannot change {sorted(frozen)}")
        board = _board(spec, op["artboard"])
        board.update(op["props"])
        for k in [k for k, v in board.items() if v is None]:
            del board[k]
    elif kind == "add_artboard":
        at = op.get("at")
        spec["artboards"].insert(len(spec["artboards"]) if at is None else at, op["artboard"])
    elif kind == "delete_artboard":
        board = _board(spec, op["artboard"])
        if len(spec["artboards"]) == 1:
            raise DesignPatchError("a design keeps at least one artboard")
        spec["artboards"].remove(board)
    elif kind == "adapt_artboard":
        src = _board(spec, op["artboard"])
        target = {"id": op["id"], "format": op["format"]}
        for k in ("width", "height"):
            if op.get(k):
                target[k] = op[k]
        idx = spec["artboards"].index(src)
        spec["artboards"].insert(idx + 1, adapt(src, target))
    elif kind == "set_component":
        comps = spec.setdefault("components", {})
        if op["component"] is None:
            comps.pop(op["name"], None)
        else:
            comps[op["name"]] = op["component"]
        if not comps:
            del spec["components"]
    elif kind == "set_field":
        if op["value"] is None:
            if op["field"] == "title":
                raise DesignPatchError("a design keeps its title")
            spec.pop(op["field"], None)
        else:
            spec[op["field"]] = op["value"]
    else:
        raise DesignPatchError(f"unknown op {kind!r}")


def adapt(board: dict[str, Any], target: dict[str, Any]) -> dict[str, Any]:
    """A copy of `board` on another format (`target`: id, format, optional width / height). Auto
    layout reflows by itself and type follows the format's scale; absolute positions scale with the
    canvas, fixed px sizes, gaps and paddings with the type scale."""
    src, dst = format_of(board), format_of({**target})
    sx, sy, st = dst.width / src.width, dst.height / src.height, dst.scale / src.scale
    out = copy.deepcopy(board)
    for k in ("width", "height", "name"):
        out.pop(k, None)
    out.update(target)

    def scale_layout(lay):
        if not lay:
            return
        if "gap" in lay:
            lay["gap"] = round(lay["gap"] * st, 1)
        if "padding" in lay:
            p = lay["padding"]
            lay["padding"] = (
                [round(x * st, 1) for x in p] if isinstance(p, list) else round(p * st, 1)
            )

    scale_layout(out.get("layout"))
    for n, _ in walk(out.get("children", [])):
        if "position" in n:
            n["position"] = {
                "x": round(n["position"]["x"] * sx, 1),
                "y": round(n["position"]["y"] * sy, 1),
            }
        for k in ("width", "height"):
            if isinstance(n.get(k), (int, float)):
                n[k] = round(n[k] * st, 1)
        if isinstance(n.get("size"), (int, float)):
            n["size"] = round(n["size"] * st, 1)
        scale_layout(n.get("layout"))
    return out
