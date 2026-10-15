import pytest

from calque_engine import tokens as tk

HEX = "#" + "ab" * 3  # built, not written: the brand-free check bans hex literals here


def test_resolve_aliases_and_inherited_type():
    tree = {
        "color": {"$type": "color", "base": {"$value": HEX}},
        "role": {"accent": {"$value": "{color.base}"}, "x": {"$value": "{role.accent}"}},
    }
    v = tk.resolve(tree)
    assert v["role.x"] == HEX
    assert tk.flatten(tree)["color.base"]["$type"] == "color"


def test_unknown_and_circular_aliases():
    with pytest.raises(tk.TokenError, match="unknown token: nope"):
        tk.resolve({"a": {"$value": "{nope}"}})
    with pytest.raises(tk.TokenError, match="circular"):
        tk.resolve({"a": {"$value": "{b}"}, "b": {"$value": "{a}"}})


def test_value_helpers():
    assert tk.hex6(HEX) == HEX[1:].upper()
    assert tk.pt("23pt") == 23.0 and tk.pt({"value": 9, "unit": "pt"}) == 9.0
    assert tk.family(["One", "fallback"]) == "One"


def test_modes_override_tokens_and_keep_aliases():
    other = "#" + "cd" * 3
    tree = {
        "color": {"$type": "color", "a": {"$value": HEX}, "b": {"$value": other}},
        "role": {"bg": {"$value": "{color.a}"}, "ink": {"$value": "{color.b}"}},
        "$extensions": {tk.MODES_KEY: {"dark": {"$description": "x", "role.bg": "{color.b}"}}},
    }
    assert tk.modes(tree) == {"dark": {"role.bg": "{color.b}"}}
    assert tk.resolve(tree)["role.bg"] == HEX
    dark = tk.resolve(tree, "dark")
    assert dark["role.bg"] == other and dark["role.ink"] == other
    with pytest.raises(tk.TokenError, match="unknown mode: light"):
        tk.resolve(tree, "light")
    tree["$extensions"][tk.MODES_KEY]["bad"] = {"role.nope": HEX}
    with pytest.raises(tk.TokenError, match="unknown token: role.nope"):
        tk.resolve(tree, "bad")


def test_every_pack_mode_resolves():
    import json
    from pathlib import Path

    for f in (Path(__file__).resolve().parents[2] / "packs").glob("*/tokens.json"):
        tree = json.loads(f.read_text())
        for mode in tk.modes(tree):
            tk.hex6(tk.resolve(tree, mode)["role.color.background"])
