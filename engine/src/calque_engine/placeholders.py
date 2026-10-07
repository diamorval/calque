"""Template placeholder detection, from the pack's `lint.placeholders` list. All-caps entries
(`KEYWORD`, `XX`) match case-sensitively as whole words; others match case-insensitively."""

from __future__ import annotations

import re
from functools import cache

from .pack import Pack


@cache
def _compiled(entries: tuple[str, ...]) -> tuple[re.Pattern[str], ...]:
    out = []
    for e in entries:
        body = r"\s+".join(map(re.escape, e.split()))
        flags = 0 if e == e.upper() else re.I
        out.append(re.compile(rf"(?<!\w){body}(?!\w)", flags))
    return tuple(out)


def placeholder_hits(text: str, pack: Pack) -> list[str]:
    entries = tuple(pack.manifest["lint"].get("placeholders", []))
    return [p.pattern for p in _compiled(entries) if p.search(text)]


def missing_markers(pack: Pack) -> set[str]:
    return set(pack.manifest["missing_value"].values())
