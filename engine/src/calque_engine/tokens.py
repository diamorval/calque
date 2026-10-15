"""DTCG tokens: flatten, resolve `{group.token}` aliases, read role values."""

from __future__ import annotations

import re
from typing import Any

ALIAS = re.compile(r"^\{([^{}]+)\}$")

REQUIRED_ROLES = [
    "role.color.ink",
    "role.color.background",
    "role.color.accent",
    "role.color.highlight",
    "role.color.muted",
    "role.color.rule",
    "role.color.surface",
    "role.color.series.1",
    "role.color.series.2",
    "role.color.status.positive",
    "role.color.status.warning",
    "role.color.status.info",
    "role.font.display",
    "role.font.body",
    "role.font.label",
    "role.fontWeight.display",
    "role.fontWeight.body",
    "role.fontWeight.label",
    *(
        f"role.size.{s}"
        for s in (
            "cover_title",
            "divider_title",
            "title",
            "body",
            "label",
            "caption",
            "numeral",
            "numeral_xl",
        )
    ),
    "role.stroke.hairline",
    "role.stroke.link",
    "role.stroke.emphasis",
    *(f"theme.{s}" for s in ("dk1", "lt1", "dk2", "lt2", "hlink", "folHlink")),
    *(f"theme.accent{i}" for i in range(1, 7)),
    "theme.font.major",
    "theme.font.minor",
]


class TokenError(ValueError):
    pass


def flatten(tree: dict[str, Any], prefix: str = "") -> dict[str, dict[str, Any]]:
    """Map dotted path -> token dict (anything carrying `$value`). `$type` is inherited."""
    out: dict[str, dict[str, Any]] = {}

    def walk(node: dict[str, Any], path: str, inherited: str | None) -> None:
        group_type = node.get("$type", inherited)
        for key, child in node.items():
            if key.startswith("$") or not isinstance(child, dict):
                continue
            child_path = f"{path}.{key}" if path else key
            if "$value" in child:
                out[child_path] = {**child, "$type": child.get("$type", group_type)}
            else:
                walk(child, child_path, group_type)

    walk(tree, prefix, None)
    return out


MODES_KEY = "calque.modes"


def modes(tree: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Token modes (variables with modes): `$extensions."calque.modes"` maps a mode name to the
    tokens it overrides, dotted path -> value or alias. `$`-keys (descriptions) are not tokens."""
    raw = tree.get("$extensions", {}).get(MODES_KEY, {})
    return {name: {k: v for k, v in o.items() if not k.startswith("$")} for name, o in raw.items()}


def resolve(tree: dict[str, Any], mode: str | None = None) -> dict[str, Any]:
    """Dotted path -> fully resolved `$value`, in `mode` if given. Raises on unknown or circular
    aliases, an unknown mode, or a mode overriding a token that does not exist."""
    flat = flatten(tree)
    if mode is not None:
        all_modes = modes(tree)
        if mode not in all_modes:
            raise TokenError(
                f"unknown mode: {mode} (modes: {', '.join(sorted(all_modes)) or 'none'})"
            )
        for path, value in all_modes[mode].items():
            if path not in flat:
                raise TokenError(f"mode {mode} overrides an unknown token: {path}")
            flat[path] = {**flat[path], "$value": value}
    resolved: dict[str, Any] = {}

    def value_of(path: str, seen: tuple[str, ...]) -> Any:
        if path in resolved:
            return resolved[path]
        if path in seen:
            raise TokenError(f"circular alias: {' -> '.join((*seen, path))}")
        if path not in flat:
            raise TokenError(f"unknown token: {path}" + (f" (from {seen[-1]})" if seen else ""))
        raw = flat[path]["$value"]
        m = ALIAS.match(raw) if isinstance(raw, str) else None
        val = value_of(m.group(1), (*seen, path)) if m else raw
        resolved[path] = val
        return val

    for p in flat:
        value_of(p, ())
    return resolved


def missing_roles(values: dict[str, Any]) -> list[str]:
    return [r for r in REQUIRED_ROLES if r not in values]


def hex6(value: Any) -> str:
    """'#rrggbb' -> 'RRGGBB'. Raises for anything that is not a 6-digit hex colour."""
    s = str(value).lstrip("#")
    if not re.fullmatch(r"[0-9A-Fa-f]{6}", s):
        raise TokenError(f"not a 6-digit hex colour: {value!r}")
    return s.upper()


def family(value: Any) -> str:
    """DTCG fontFamily is a string or a list; the first entry is the family to use."""
    return value[0] if isinstance(value, list) else str(value)


def pt(value: Any) -> float:
    """'23pt' or 23 or {'value': 23, 'unit': 'pt'} -> 23.0."""
    if isinstance(value, dict):
        if value.get("unit", "pt") != "pt":
            raise TokenError(f"expected pt: {value!r}")
        return float(value["value"])
    if isinstance(value, (int, float)):
        return float(value)
    m = re.fullmatch(r"(-?[\d.]+)\s*pt", str(value))
    if not m:
        raise TokenError(f"expected pt: {value!r}")
    return float(m.group(1))
