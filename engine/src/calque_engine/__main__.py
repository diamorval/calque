"""Engine CLI. `python -m calque_engine <command> ...`"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import yaml

from .extract import draft_tokens, extract
from .pack import PackError, load_pack


def dump_yaml(data, path: Path) -> None:
    path.write_text(
        yaml.safe_dump(
            data, sort_keys=False, allow_unicode=True, default_flow_style=None, width=100
        ),
        encoding="utf-8",
    )


def cmd_extract(a) -> int:
    out_map = Path(a.map)
    previous = yaml.safe_load(out_map.read_text()) if out_map.is_file() else None
    tmap = extract(a.template, previous)
    dump_yaml(tmap, out_map)
    if a.tokens:
        Path(a.tokens).write_text(json.dumps(draft_tokens(tmap), indent=2) + "\n")
    print(f"{len(tmap['slides'])} slides -> {out_map}")
    return 0


def cmd_validate(a) -> int:
    try:
        pack = load_pack(a.pack)
    except PackError as e:
        print(e, file=sys.stderr)
        return 1
    print(f"ok: {pack.id} {pack.manifest['version']}")
    return 0


def cmd_call(a) -> int:
    from .api import call

    result = call(json.load(sys.stdin))
    json.dump(result, sys.stdout, ensure_ascii=False, default=str)  # Path -> str
    sys.stdout.write("\n")
    return 0 if result["ok"] else 1


def cmd_build(a) -> int:
    from .api import call

    deck = json.loads(Path(a.deck).read_text(encoding="utf-8"))
    r = call({"op": "build", "pack": a.pack, "deck": deck, "out": a.out, "base": a.base})
    if not r["ok"]:
        print(r["message"], file=sys.stderr)
        return 1
    for h in r["holes"]:
        print(f"hole [{h['slide']}] shape {h['shape_id']}: {h['was']!r}")
    for w in r["warnings"]:
        print(f"WARN [{w['slide']}] {w['message']}")
    print(f"{len(r['slides'])} slides -> {r['path']}")
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="calque_engine")
    sub = p.add_subparsers(required=True)
    e = sub.add_parser("extract-template", help="template.pptx -> template-map.yaml (+ tokens)")
    e.add_argument("template")
    e.add_argument("--map", required=True, help="template-map.yaml to write (reviewed keys kept)")
    e.add_argument("--tokens", help="also write a draft tokens.json here")
    e.set_defaults(fn=cmd_extract)
    v = sub.add_parser("validate-pack", help="load a pack and list every problem")
    v.add_argument("pack")
    v.set_defaults(fn=cmd_validate)
    li = sub.add_parser("lint", help="lint a PPTX against a pack")
    li.add_argument("pptx")
    li.add_argument("--pack", required=True)
    li.add_argument("--language")
    li.set_defaults(
        fn=lambda a: __import__("calque_engine.lint", fromlist=["main_lint"]).main_lint(
            a.pptx, a.pack, a.language
        )
    )
    c = sub.add_parser("call", help="JSON request on stdin -> JSON response on stdout")
    c.set_defaults(fn=cmd_call)
    b = sub.add_parser("build", help="DeckSpec JSON -> PPTX")
    b.add_argument("deck")
    b.add_argument("--pack", required=True)
    b.add_argument("--out", required=True)
    b.add_argument("--base", help="imported deck the DeckSpec edits")
    b.set_defaults(fn=cmd_build)
    a = p.parse_args(argv)
    return a.fn(a)


if __name__ == "__main__":
    sys.exit(main())
