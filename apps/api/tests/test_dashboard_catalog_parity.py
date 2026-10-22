"""The widget catalog exists twice: the server owns access (``requires``), the
web owns labels and components. Both must list the same ids in the same order,
and the same shortcut tiles, or a saved layout would mean different things on
either side (docs/DASHBOARD.md D5, §12 A2).

Skips only when the web sources are not there (an API-only checkout, as in
the api image); the integration run of the whole repository must not skip.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from app.services.dashboard_catalog import CATALOG, SHORTCUT_VIEWS

WEB_TYPES = Path(__file__).resolve().parents[2] / "web" / "src" / "types" / "dashboard.ts"


def _string_array(source: str, name: str) -> list[str]:
    match = re.search(rf"export const {name}\s*=\s*\[(?P<body>.*?)\]\s*as const", source, re.DOTALL)
    assert match, f"{name} not found in {WEB_TYPES.name}"
    body = re.sub(r"//[^\n]*", "", match.group("body"))
    return re.findall(r"""["']([^"']+)["']""", body)


@pytest.fixture(scope="module")
def web_source() -> str:
    if not WEB_TYPES.is_file():
        pytest.skip(f"{WEB_TYPES} is not part of this checkout")
    return WEB_TYPES.read_text(encoding="utf-8")


def test_the_web_lists_the_same_widgets_in_the_same_order(web_source: str) -> None:
    assert _string_array(web_source, "DASHBOARD_WIDGET_IDS") == [spec.id for spec in CATALOG]


def test_the_web_lists_the_same_shortcut_tiles(web_source: str) -> None:
    assert _string_array(web_source, "DASHBOARD_SHORTCUT_VIEWS") == list(SHORTCUT_VIEWS)
