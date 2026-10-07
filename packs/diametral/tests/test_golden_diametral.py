"""Golden decks of this pack: `uv run pytest -m golden` (CALQUE_UPDATE_GOLDEN=1 to refresh)."""

import shutil
from pathlib import Path

import pytest

from calque_engine.golden import check

PACK = Path(__file__).resolve().parents[1]
DECKS = sorted((PACK / "tests" / "golden").glob("*.json"))

pytestmark = [
    pytest.mark.golden,
    pytest.mark.skipif(
        not (shutil.which("soffice") and shutil.which("pdftoppm")), reason="no LibreOffice"
    ),
]


@pytest.mark.parametrize("deck", DECKS, ids=[d.stem for d in DECKS])
def test_golden(deck, tmp_path):
    assert check(deck, PACK, deck.with_suffix(""), tmp_path) == []
