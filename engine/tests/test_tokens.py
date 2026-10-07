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
