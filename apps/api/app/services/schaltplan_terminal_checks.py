"""Reihenklemmen checks over a whole document that ``validate_document`` runs.

Moved out of ``schaltplan_layout.py`` (docs/PANEL_ENCLOSURE_R2.md §11): that
file is over the size cap, and the check now needs the cabinet's skip set
(§3.1) so it names the same X labels the Klemmen tab, the legend and the
print show. Twin: ``stripNameClashes`` in
``apps/web/src/utils/schaltplanTopology.ts``.
"""

from __future__ import annotations

from typing import Any

from app.services.schaltplan_layout import iter_devices
from app.services.schaltplan_terminals import derive_terminals

# Rail devices that may carry a Klemmleiste's name: a "terminal" device IS
# the strip's rail space, a blank has nothing printed on it.
STRIP_NAMED_KINDS: frozenset[str] = frozenset({"terminal", "blank"})


def _text(value: Any) -> str:
    return str(value).strip() if value is not None else ""


def strip_name_clashes(document: dict[str, Any], terminal_skip: frozenset[str] = frozenset()) -> list[dict[str, str]]:
    """A device whose BMK a derived Klemmleiste also carries ("X1").

    X is the Verteilerblock's natural letter (Hensel KKL 54, owner
    2026-10-09) and the letter the strips count in, so one label would end up
    on two different parts. Same case-blind compare a printed label gets.
    """
    strip_names = {
        str(strip.get("x_label") or "").strip().upper()
        for group in derive_terminals(document, skip=terminal_skip)
        for strip in group["strips"]
    }
    strip_names.discard("")
    clashes: list[dict[str, str]] = []
    for _row, device in iter_devices(document):
        designation = _text(device.get("designation"))
        if not designation or str(device.get("kind") or "") in STRIP_NAMED_KINDS:
            continue
        if designation.upper() in strip_names:
            clashes.append(
                {
                    "level": "warn",
                    "scope": str(device.get("id") or ""),
                    "message": f"{designation}: so heißt auch eine Klemmleiste — Gerät umbenennen (zwei Teile mit einem BMK).",
                }
            )
    return clashes
