"""DeckSpec: structural validation against the shared JSON Schema (generated from the Zod source in
packages/deckspec), then the doctrine rules ("form follows the message") and the pack checks."""

from __future__ import annotations

import json
from collections import Counter
from dataclasses import dataclass
from functools import cache
from importlib import resources
from typing import Any, Literal

from jsonschema import Draft202012Validator
from pydantic import BaseModel, ConfigDict

from .core import forms
from .pack import Pack


class Slide(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str
    message: str
    message_type: str
    form: str
    source: dict[str, Any]
    title: str | None = None
    eyebrow: str | None = None
    notes: str | None = None
    facts: list[dict[str, Any]] | None = None
    justification: str | None = None


class DeckSpec(BaseModel):
    model_config = ConfigDict(extra="forbid")
    pack_id: str
    language: str
    title: str
    base: str | None = None
    slides: list[Slide]


@dataclass(frozen=True)
class Issue:
    severity: Literal["ERROR", "WARN"]
    slide: str | None  # slide id, None for deck-level
    message: str

    def __str__(self) -> str:
        where = f"[{self.slide}] " if self.slide else ""
        return f"{self.severity} {where}{self.message}"


class DeckSpecError(ValueError):
    def __init__(self, issues: list[Issue]):
        self.issues = issues
        super().__init__("invalid DeckSpec:\n" + "\n".join(f"  {i}" for i in issues))


@cache
def _validator() -> Draft202012Validator:
    schema = json.loads(
        resources.files("calque_engine.schemas").joinpath("deckspec.schema.json").read_text()
    )
    return Draft202012Validator(schema)


def _pick(e):
    """Descend a union error: drop branches whose discriminator (a const) failed, keep the
    deepest error, so the message names the field that is actually wrong."""
    if e.validator not in ("anyOf", "oneOf") or not e.context:
        return e
    branches: dict[Any, list] = {}
    for c in e.context:
        branches.setdefault(c.relative_schema_path[0], []).append(c)
    live = [cs for cs in branches.values() if not any(c.validator == "const" for c in cs)]
    pool = [c for cs in (live or list(branches.values())) for c in cs]
    return _pick(max(pool, key=lambda c: len(c.absolute_path)))


def schema_issues(data: Any) -> list[Issue]:
    out = []
    for e in sorted(_validator().iter_errors(data), key=lambda e: list(e.path)):
        path = list(e.path)
        slide = None
        if len(path) >= 2 and path[0] == "slides" and isinstance(path[1], int):
            try:
                slide = data["slides"][path[1]].get("id") or f"#{path[1] + 1}"
            except (KeyError, IndexError, TypeError, AttributeError):
                slide = f"#{path[1] + 1}"
        best = _pick(e)
        where = "/".join(map(str, best.absolute_path)) or "(root)"
        msg = best.message
        out.append(Issue("ERROR", slide, f"{where}: {msg}"))
    return out


def _source_kind(form: str) -> str | None:
    return forms()["forms"].get(form)


def rule_issues(deck: DeckSpec, pack: Pack | None = None) -> list[Issue]:
    f = forms()
    out: list[Issue] = []
    ids = Counter(s.id for s in deck.slides)
    out += [Issue("ERROR", i, "duplicate slide id") for i, n in ids.items() if n > 1]
    if pack is not None and deck.pack_id != pack.id:
        out.append(Issue("ERROR", None, f"pack_id {deck.pack_id!r} but active pack is {pack.id!r}"))

    for s in deck.slides:
        allowed = f["message_types"].get(s.message_type, [])
        kind = _source_kind(s.form)
        src = s.source
        if kind is None:
            out.append(Issue("ERROR", s.id, f"unknown form {s.form!r} (see core/forms.yaml)"))
        elif s.form not in allowed:
            out.append(
                Issue(
                    "ERROR",
                    s.id,
                    f"form {s.form!r} does not carry a {s.message_type!r} message; "
                    f"allowed: {', '.join(allowed)}",
                )
            )
        if kind and src.get("kind") != kind:
            out.append(
                Issue(
                    "ERROR",
                    s.id,
                    f"form {s.form!r} is drawn by a {kind!r} source, got {src.get('kind')!r}",
                )
            )
        elif kind in ("chart", "diagram", "composition"):
            sid = src.get("type") if kind == "chart" else src.get("id")
            if sid != s.form:
                out.append(Issue("ERROR", s.id, f"form {s.form!r} but source {kind} is {sid!r}"))
        if kind == "clone":
            out += _clone_issues(s, pack)
        elif not s.title and kind in ("chart", "diagram", "composition"):
            out.append(Issue("ERROR", s.id, "a drawn slide needs a title stating the verdict"))

        units = Counter((fact.get("unit") or "") for fact in s.facts or [])
        dim, n = units.most_common(1)[0] if units else ("", 0)
        if (
            n >= 3
            and kind != "chart"
            and s.form not in ("chart_takeaway", "kpi_sparkband")
            and not s.justification
        ):
            label = f"unit {dim!r}" if dim else "the same dimension"
            out.append(
                Issue(
                    "ERROR",
                    s.id,
                    f"{n} numbers share {label}: make it a chart, or add a one-line justification",
                )
            )
        if pack is not None and s.title:
            mx = pack.manifest["grid"]["title"].get("max_chars")
            if mx and len(s.title) > mx:
                out.append(
                    Issue(
                        "WARN",
                        s.id,
                        f"title is {len(s.title)} chars, the pack's title box holds {mx}",
                    )
                )

    run_form, run = None, 0
    for s in deck.slides:
        if s.form in f["signature_forms"]:
            run_form, run = None, 0
            continue
        run = run + 1 if s.form == run_form else 1
        run_form = s.form
        if run == 3:
            out.append(
                Issue(
                    "ERROR",
                    s.id,
                    f"third consecutive {s.form!r} slide: "
                    "distinct messages were flattened into one form",
                )
            )

    if pack is not None and deck.language not in pack.manifest["missing_value"]:
        out.append(
            Issue(
                "WARN",
                None,
                f"pack has no missing-value placeholder for language {deck.language!r}",
            )
        )
    return out


def _clone_issues(s: Slide, pack: Pack | None) -> list[Issue]:
    src = s.source
    if src.get("role") is None and src.get("slide") is None:
        return [Issue("ERROR", s.id, "clone needs a role or a slide")]
    if pack is None or src.get("from") == "base":
        return []
    out = []
    role = src.get("role")
    if role is not None and not pack.slides_for(role):
        out.append(Issue("ERROR", s.id, f"pack {pack.id!r} has no slide for role {role!r}"))
        return out
    if role is None and s.form not in ("content",):
        role = s.form
    number = src.get("slide") or (
        pack.slides_for(role)[0] if role and pack.slides_for(role) else None
    )
    if number is None:
        return out
    if number in pack.manifest["never_clone"]:
        out.append(Issue("ERROR", s.id, f"slide {number} is documentation: never clone it"))
    slides = {sl["number"]: sl for sl in pack.template_map["slides"]}
    if number not in slides:
        out.append(Issue("ERROR", s.id, f"template has no slide {number}"))
        return out
    known = set(_ids(slides[number]["shapes"]))
    unknown = [k for k in src.get("values", {}) if int(k) not in known]
    if unknown:
        out.append(Issue("ERROR", s.id, f"slide {number} has no shape_id {', '.join(unknown)}"))
    return out


def _ids(shapes):
    for sh in shapes:
        yield sh["id"]
        yield from _ids(sh.get("children", []))


def resolve_clone_slide(s: Slide, pack: Pack) -> int:
    """Template slide number a clone source uses."""
    src = s.source
    if src.get("slide"):
        return src["slide"]
    role = src.get("role") or s.form
    slides = pack.slides_for(role)
    if not slides:
        raise KeyError(f"pack {pack.id!r} has no slide for role {role!r}")
    return slides[0]


def validate(data: Any, pack: Pack | None = None) -> tuple[DeckSpec, list[Issue]]:
    """Validate a DeckSpec dict. Raises DeckSpecError on any ERROR; returns warnings otherwise."""
    issues = schema_issues(data)
    if issues:
        raise DeckSpecError(issues)
    deck = DeckSpec.model_validate(data)
    issues = rule_issues(deck, pack)
    errors = [i for i in issues if i.severity == "ERROR"]
    if errors:
        raise DeckSpecError(issues)
    return deck, issues
