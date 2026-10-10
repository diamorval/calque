"""Re-brand: move a DeckSpec from one pack to another.

- Drawn slides (charts, diagrams, compositions) are pack-agnostic: they redraw on the new pack.
- Template clones move to the new pack's slide for the same role (or archetype); their values
  follow the template-map slot names (`title`, `subtitle`...). A value on a shape that is no slot,
  or on a slot the new slide lacks, is reported in `unmapped` (the new slide shows the pack's
  missing-value marker there).
- Imported clones (`from: base`) are the client's file, on the old brand's layouts: they cannot be
  re-branded and are reported in `not_rebrandable`; with `drop=True` they are left out.
"""

from __future__ import annotations

import copy
from typing import Any

from .deckspec import resolve_clone_slide, validate
from .pack import Pack


class RebrandError(ValueError):
    pass


def _role_of(pack: Pack, number: int) -> str | None:
    roles = pack.manifest["roles"]
    for role, slides in roles.items():
        if role == "archetypes":
            for name, nums in slides.items():
                if number in nums:
                    return name
        elif number in slides:
            return role
    return None


def _tslide(pack: Pack, number: int) -> dict[str, Any]:
    return next(s for s in pack.template_map["slides"] if s["number"] == number)


def rebrand(
    deck: dict[str, Any], old: Pack, new: Pack, drop: bool = False
) -> tuple[dict[str, Any], dict[str, Any]]:
    """(DeckSpec on `new`, report: redrawn, moved, unmapped, not_rebrandable, dropped)."""
    from .deckspec import Slide

    out = copy.deepcopy(deck)
    report: dict[str, Any] = {
        "redrawn": [],
        "moved": [],
        "unmapped": [],
        "not_rebrandable": [],
        "dropped": [],
    }
    slides = []
    for raw in out["slides"]:
        src = raw["source"]
        if src["kind"] != "clone":
            report["redrawn"].append(raw["id"])
            slides.append(raw)
            continue
        if src.get("from") == "base":
            report["not_rebrandable"].append(
                {
                    "slide": raw["id"],
                    "reason": "an imported slide: the client's file, not a pack slide",
                }
            )
            continue
        number = resolve_clone_slide(Slide.model_validate(raw), old)
        role = src.get("role") or _role_of(old, number)
        targets = new.slides_for(role) if role else []
        if not targets:
            report["not_rebrandable"].append(
                {"slide": raw["id"], "reason": f"pack {new.id!r} has no slide for role {role!r}"}
            )
            continue
        old_slots = {v: k for k, v in _tslide(old, number).get("slots", {}).items()}
        new_slots = _tslide(new, targets[0]).get("slots", {})
        values = {}
        for key, value in src.get("values", {}).items():
            name = old_slots.get(int(key))
            if name is not None and name in new_slots:
                values[str(new_slots[name])] = value
            else:
                report["unmapped"].append({"slide": raw["id"], "shape_id": int(key), "slot": name})
        raw["source"] = {"kind": "clone", "role": role, "values": values}
        report["moved"].append(raw["id"])
        slides.append(raw)
    if report["not_rebrandable"]:
        if not drop:
            ids = ", ".join(x["slide"] for x in report["not_rebrandable"])
            raise RebrandError(
                f"slides {ids} cannot move to pack {new.id!r}: pass drop to leave them out"
            )
        report["dropped"] = [x["slide"] for x in report["not_rebrandable"]]
    if not slides:
        raise RebrandError("no slide of this deck can move to the new pack")
    out["slides"] = slides
    out["pack_id"] = new.id
    out.pop("base", None)
    validate(out, new)
    return out, report
