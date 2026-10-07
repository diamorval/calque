"""patch_deck: apply edit operations to a DeckSpec. Pure: returns a new DeckSpec, validated.

Operations (JSON objects, applied in order):
  {"op": "set", "slide": id, "shape_id": n, "value": ShapeValue}       write into a cloned shape
  {"op": "set_field", "slide": id, "field": "title"|"eyebrow"|"notes"|"message", "value": str}
  {"op": "set_params", "slide": id, "params": {...}}                    merge into a drawn source
  {"op": "replace_slide", "slide": id, "with": Slide}
  {"op": "insert_slide", "at": index, "slide": Slide}                   0-based position
  {"op": "delete_slide", "slide": id}
  {"op": "move_slide", "slide": id, "to": index}
"""

from __future__ import annotations

import copy
from typing import Any

from .deckspec import Issue, validate
from .pack import Pack


class PatchError(ValueError):
    pass


def _index(deck: dict[str, Any], slide_id: str) -> int:
    for i, s in enumerate(deck["slides"]):
        if s["id"] == slide_id:
            return i
    raise PatchError(f"no slide {slide_id!r}")


def apply_ops(deck: dict[str, Any], ops: list[dict[str, Any]]) -> dict[str, Any]:
    out = copy.deepcopy(deck)
    slides = out["slides"]
    for n, op in enumerate(ops, start=1):
        kind = op.get("op")
        try:
            if kind == "set":
                src = slides[_index(out, op["slide"])]["source"]
                if src["kind"] != "clone":
                    raise PatchError(
                        "set writes into cloned shapes; use set_params for drawn slides"
                    )
                values = src.setdefault("values", {})
                key, value = str(op["shape_id"]), op["value"]
                # a style-only value ({"color": ...}) keeps the shape's current text
                if isinstance(value, dict) and "text" not in value and key in values:
                    old = values[key]
                    value = {**old, **value} if isinstance(old, dict) else {"text": old, **value}
                values[key] = value
            elif kind == "set_field":
                if op["field"] not in ("title", "eyebrow", "notes", "message"):
                    raise PatchError(f"field {op['field']!r} is not patchable")
                slides[_index(out, op["slide"])][op["field"]] = op["value"]
            elif kind == "set_params":
                src = slides[_index(out, op["slide"])]["source"]
                if "params" not in src:
                    raise PatchError("set_params applies to chart, diagram and composition slides")
                src["params"] = {**src["params"], **op["params"]}
            elif kind == "replace_slide":
                slides[_index(out, op["slide"])] = op["with"]
            elif kind == "insert_slide":
                slides.insert(op["at"], op["slide"])
            elif kind == "delete_slide":
                del slides[_index(out, op["slide"])]
            elif kind == "move_slide":
                slides.insert(op["to"], slides.pop(_index(out, op["slide"])))
            else:
                raise PatchError(f"unknown op {kind!r}")
        except KeyError as e:
            raise PatchError(f"op {n} ({kind}): missing field {e}") from None
        except PatchError as e:
            raise PatchError(f"op {n} ({kind}): {e}") from None
    return out


def patch(
    deck: dict[str, Any], ops: list[dict[str, Any]], pack: Pack | None = None
) -> tuple[dict[str, Any], list[Issue]]:
    """Apply ops, then validate the result. Raises PatchError / DeckSpecError."""
    out = apply_ops(deck, ops)
    _, warnings = validate(out, pack)
    return out, warnings
