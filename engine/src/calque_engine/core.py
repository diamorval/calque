"""Access to the generic knowledge layer (core/). Located by $CALQUE_CORE or the repo layout."""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from functools import cache
from pathlib import Path
from typing import Any

import yaml


def core_dir() -> Path:
    env = os.environ.get("CALQUE_CORE")
    return Path(env) if env else Path(__file__).resolve().parents[3] / "core"


@cache
def forms() -> dict[str, Any]:
    return yaml.safe_load((core_dir() / "forms.yaml").read_text(encoding="utf-8"))


@dataclass(frozen=True)
class SlopRule:
    severity: str  # ERROR | WARN
    lang: str  # any | en | fr ...
    pattern: re.Pattern[str]
    note: str


_RULE = re.compile(r"^(ERROR|WARN)\s+(\S+)\s+/(.+?)/\s{2,}(\S.*)$")


def _rule_block(block: str) -> tuple[SlopRule, ...]:
    """Rules from the fenced ```<block> code block of core/anti-slop.md."""
    text = (core_dir() / "anti-slop.md").read_text(encoding="utf-8")
    m = re.search(rf"```{block}\n(.*?)```", text, re.S)
    if not m:
        raise ValueError(f"core/anti-slop.md has no ```{block} block")
    out = []
    for n, line in enumerate(m.group(1).splitlines(), 1):
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        r = _RULE.match(line)
        if not r:
            raise ValueError(f"core/anti-slop.md {block} line {n} does not parse: {line!r}")
        sev, lang, pat, note = r.groups()
        out.append(SlopRule(sev, lang, re.compile(pat, re.I | re.M), note))
    return tuple(out)


@cache
def slop_rules() -> tuple[SlopRule, ...]:
    return _rule_block("anti-slop")


@cache
def typography_rules() -> tuple[SlopRule, ...]:
    """Language typography (French spacing, quotes, decimal comma): the ```typography block."""
    return _rule_block("typography")
