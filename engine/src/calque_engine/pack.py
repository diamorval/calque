"""Brand pack loader. A pack is data: the engine knows no brand."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from functools import cache
from importlib import resources
from pathlib import Path
from typing import Any

import yaml
from jsonschema import Draft202012Validator

from . import tokens as tk

REQUIRED_FILES = ("pack.yaml", "template.pptx", "template-map.yaml", "tokens.json")


class PackError(ValueError):
    def __init__(self, pack_dir: Path, problems: list[str]):
        self.problems = problems
        super().__init__(f"invalid pack {pack_dir}:\n" + "\n".join(f"  - {p}" for p in problems))


@dataclass
class Pack:
    dir: Path
    manifest: dict[str, Any]
    tokens: dict[str, Any]  # resolved dotted path -> value
    template_map: dict[str, Any]
    raw_tokens: dict[str, Any] = field(repr=False)

    @property
    def id(self) -> str:
        return self.manifest["id"]

    @property
    def template(self) -> Path:
        return self.dir / "template.pptx"

    def color(self, role: str) -> str:
        return self.color_at(f"role.color.{role}")

    def color_at(self, path: str) -> str:
        if path not in self.tokens:
            raise KeyError(f"pack {self.id!r} has no colour token {path!r}")
        return tk.hex6(self.tokens[path])

    def font(self, role: str) -> str:
        return tk.family(self.tokens[f"role.font.{role}"])

    def size(self, role: str) -> float:
        return tk.pt(self.tokens[f"role.size.{role}"])

    def stroke(self, role: str) -> float:
        return tk.pt(self.tokens[f"role.stroke.{role}"])

    def palette(self) -> set[str]:
        """Every hex colour the pack allows: all colour tokens + lint.extra_colors."""
        flat = tk.flatten(self.raw_tokens)
        colors = {tk.hex6(self.tokens[p]) for p, t in flat.items() if t.get("$type") == "color"}
        colors |= {c.upper() for c in self.manifest["lint"].get("extra_colors", [])}
        return colors

    def fonts(self) -> set[str]:
        flat = tk.flatten(self.raw_tokens)
        names = {
            tk.family(self.tokens[p]) for p, t in flat.items() if t.get("$type") == "fontFamily"
        }
        return names | set(self.manifest["lint"].get("extra_fonts", []))

    def slides_for(self, role: str) -> list[int]:
        roles = self.manifest["roles"]
        if role in roles and role != "archetypes":
            return roles[role]
        return roles.get("archetypes", {}).get(role, [])


@cache
def _validator() -> Draft202012Validator:
    schema = json.loads(
        resources.files("calque_engine.schemas").joinpath("pack.schema.json").read_text()
    )
    return Draft202012Validator(schema)


def _read(path: Path, problems: list[str], parse) -> Any:
    try:
        return parse(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except Exception as e:  # malformed file: report, keep collecting
        problems.append(f"{path.name}: cannot parse ({e})")
        return None


def load_pack(pack_dir: str | Path) -> Pack:
    """Load and validate a pack. Raises PackError listing every problem found."""
    d = Path(pack_dir)
    problems = [f"missing file: {f}" for f in REQUIRED_FILES if not (d / f).is_file()]

    manifest = _read(d / "pack.yaml", problems, yaml.safe_load)
    if manifest is not None:
        for e in sorted(_validator().iter_errors(manifest), key=lambda e: list(e.path)):
            where = "/".join(str(p) for p in e.path) or "(root)"
            problems.append(f"pack.yaml {where}: {e.message}")

    raw_tokens = _read(d / "tokens.json", problems, json.loads)
    values: dict[str, Any] = {}
    if raw_tokens is not None:
        try:
            values = tk.resolve(raw_tokens)
        except tk.TokenError as e:
            problems.append(f"tokens.json: {e}")
        else:
            problems += [f"tokens.json: missing role {r}" for r in tk.missing_roles(values)]

    tmap = _read(d / "template-map.yaml", problems, yaml.safe_load)
    if tmap is not None and isinstance(manifest, dict):
        problems += _check_roles(manifest, tmap)

    if isinstance(manifest, dict):
        for key, rel in (manifest.get("docs") or {}).items():
            if not (d / rel).is_file():
                problems.append(f"docs.{key}: missing file {rel}")

    if problems:
        raise PackError(d, problems)
    return Pack(dir=d, manifest=manifest, tokens=values, template_map=tmap, raw_tokens=raw_tokens)


def _check_roles(manifest: dict[str, Any], tmap: dict[str, Any]) -> list[str]:
    n = len(tmap.get("slides", []))
    roles = manifest.get("roles") or {}
    never = set(manifest.get("never_clone") or [])
    assigned: dict[str, list[int]] = {
        k: v for k, v in roles.items() if k != "archetypes" and isinstance(v, list)
    }
    for name, slides in (roles.get("archetypes") or {}).items():
        assigned[f"archetypes.{name}"] = slides
    out = []
    for role, slides in assigned.items():
        if not slides:
            out.append(f"roles.{role}: no slide assigned")
        for s in slides:
            if isinstance(s, int) and not 1 <= s <= n:
                out.append(f"roles.{role}: slide {s} not in template (1..{n})")
            if s in never:
                out.append(f"roles.{role}: slide {s} is in never_clone")
    return out
