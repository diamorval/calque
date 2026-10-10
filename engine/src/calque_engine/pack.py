"""Brand pack loader. A pack is data: the engine knows no brand."""

from __future__ import annotations

import json
import re
from collections.abc import Mapping
from contextvars import ContextVar
from dataclasses import dataclass, field
from functools import cache
from importlib import resources
from pathlib import Path
from types import MappingProxyType
from typing import Any

import yaml
from jsonschema import Draft202012Validator

from . import tokens as tk

REQUIRED_FILES = ("pack.yaml", "template.pptx", "template-map.yaml", "tokens.json")

# What a pack inherits from the pack it `extends` unless it has its own: these docs (exemplar with
# its `exemplar/` images) and `lint.slop_rules`. Template, tokens and the rest stay its own.
INHERITED_DOCS = ("voice", "exemplar", "storyline")

# Pack id -> directory, for resolving `extends`: the server passes the current release of every pack
# (`packs` in an engine request). Without an entry, the parent is a sibling directory (packs/<id>).
PACK_DIRS: ContextVar[Mapping[str, str]] = ContextVar("pack_dirs", default=MappingProxyType({}))


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
    # voice / exemplar / storyline -> file, its own or inherited; the `exemplar/` images likewise
    docs: dict[str, Path] = field(default_factory=dict)
    exemplar_dir: Path | None = None
    # the pack it extends, merged in already (its own parent included)
    parent: Pack | None = None

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


def load_pack(pack_dir: str | Path, _children: tuple[str, ...] = ()) -> Pack:
    """Load and validate a pack, merged with the pack it `extends`. Raises PackError listing every
    problem found."""
    d = Path(pack_dir)
    problems = [f"missing file: {f}" for f in REQUIRED_FILES if not (d / f).is_file()]

    manifest = _read(d / "pack.yaml", problems, yaml.safe_load)
    if manifest is not None:
        for e in sorted(_validator().iter_errors(manifest), key=lambda e: list(e.path)):
            where = "/".join(str(p) for p in e.path) or "(root)"
            problems.append(f"pack.yaml {where}: {e.message}")
        problems += _check_rules(manifest)

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

    parent = None
    if isinstance(manifest, dict) and manifest.get("extends"):
        parent = _parent(d, manifest, _children, problems)

    if problems:
        raise PackError(d, problems)
    pack = Pack(dir=d, manifest=manifest, tokens=values, template_map=tmap, raw_tokens=raw_tokens)
    _inherit(pack, parent)
    return pack


def _parent(d: Path, manifest: dict[str, Any], children: tuple[str, ...], problems: list[str]):
    pid = manifest["extends"]
    if pid == manifest.get("id") or pid in children:
        chain = " -> ".join((*children, manifest.get("id", "?"), pid))
        problems.append(f"extends: {pid!r} is a cycle ({chain})")
        return None
    pdir = PACK_DIRS.get().get(pid) or d.parent / pid
    if not (Path(pdir) / "pack.yaml").is_file():
        problems.append(f"extends: no pack {pid!r}")
        return None
    try:
        return load_pack(pdir, (*children, manifest.get("id", "?")))
    except PackError as e:
        problems += [f"extends {pid}: {p}" for p in e.problems]
        return None


def _inherit(pack: Pack, parent: Pack | None) -> None:
    """The one place a pack takes from its parent: the docs it lacks, and slop_rules unless it has
    its own."""
    own = pack.manifest.get("docs") or {}
    for key in INHERITED_DOCS:
        path = pack.dir / own.get(key, f"{key}.md")
        if path.is_file():
            pack.docs[key] = path
    if (pack.dir / "exemplar").is_dir():
        pack.exemplar_dir = pack.dir / "exemplar"
    if parent is None:
        return
    pack.parent = parent
    if "exemplar" not in pack.docs and pack.exemplar_dir is None:
        pack.exemplar_dir = parent.exemplar_dir
    for key, path in parent.docs.items():
        pack.docs.setdefault(key, path)
    lint = pack.manifest["lint"]
    if "slop_rules" not in lint and "slop_rules" in parent.manifest["lint"]:
        lint["slop_rules"] = parent.manifest["lint"]["slop_rules"]


def describe(pack: Pack) -> dict[str, Any]:
    """What a pack resolves to, inheritance included (the server's pack:// resources, portal)."""
    chain, p = [], pack.parent
    while p is not None:
        chain.append({"id": p.id, "dir": str(p.dir)})
        p = p.parent
    return {
        "id": pack.id,
        "extends": chain,
        "manifest": pack.manifest,
        "docs": {k: str(v) for k, v in pack.docs.items()},
        "exemplar_dir": str(pack.exemplar_dir) if pack.exemplar_dir else None,
    }


def _check_rules(manifest: Any) -> list[str]:
    """Every `lint.slop_rules` pattern compiles as lint compiles it (else every lint fails)."""
    if not isinstance(manifest, dict):
        return []
    rules = (manifest.get("lint") or {}).get("slop_rules") or []
    out = []
    for i, r in enumerate(rules):
        if not isinstance(r, dict) or not isinstance(r.get("pattern"), str):
            continue  # the schema reports it
        try:
            re.compile(r["pattern"], re.I | re.M)
        except re.error as e:
            out.append(f"lint.slop_rules[{i}] pattern {r['pattern']!r}: {e}")
    return out


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
