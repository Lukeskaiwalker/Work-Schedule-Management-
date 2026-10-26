"""The cabinet preparation on the Materialliste (docs/PANEL_ENCLOSURE_R4.md §6).

``panel_enclosure_prep.cabinet_prep`` derives what a Zählerschrank needs
besides its modules: the Spannungsversorgung kit, the infeed part, the
busbar joints, the network lead, and the §14a block with its wires and the
Lüsterklemme (R4-4). This module turns those items into planned lines; the
list stays server-only, so there is no TS twin (R4-5).

* **One ``enclosure`` line per item**, in the derivation's order, after the
  accessory lines and before the device lines (``schaltplan_material``). An
  item an override switched off (``qty`` 0) gets no line.
* **Keys** (R4-6): ``accessory:<art>`` (Hager), ``part:<art>`` (the WAGO
  block parts), ``wire:h07vk:<1.5|2.5>:<colour>``, ``prep:luesterklemme``,
  ``prep:pen_split``. The detail is the reason, then " · Meter" for a length
  and " · ungeprüft" when the drawing rather than a datasheet says so.
* **An admin accessory naming a derived Hager article** is ONE line, at the
  admin line's slot: the larger count, with the derived label and detail
  (the U84T pattern, R2 §5.1). Two lines naming one article would double it
  and split its bookings.
* **Stock match**: an ``accessory:``/``part:`` line looks for its article
  number (whole token, ``line_article_numbers``); ``wire:`` and ``prep:``
  lines have none and wait for a mapping.
"""

from __future__ import annotations

from collections.abc import Collection, Iterable, Mapping
from dataclasses import replace
from typing import Any

from app.services import schaltplan_material as material
from app.services.panel_enclosure_catalog import EnclosureCatalog
from app.services.panel_enclosure_prep import cabinet_prep

__all__ = [
    "LINE_ENCLOSURE", "item_detail", "item_line", "prep_items", "derived_accessories", "merged_accessory_line",
    "prep_planned_lines", "prep_article_numbers",
]

LINE_ENCLOSURE = "enclosure"
ACCESSORY_PREFIX = "accessory:"
#: Keys whose stock match looks for the article number; ``wire:``/``prep:`` wait for a mapping.
NUMBERED_PREFIXES = (ACCESSORY_PREFIX, "part:")
METRE_UNIT = "m"
METRE_NOTE = " · Meter"
UNCHECKED_NOTE = " · ungeprüft"


def prep_items(document: Any, catalog: EnclosureCatalog) -> tuple[dict[str, Any], ...]:
    """The items that become lines: ``qty`` > 0, in ``cabinet_prep`` order; () without a known cabinet."""
    prep = cabinet_prep(document, catalog)
    if prep is None:
        return ()
    return tuple(item for item in prep["items"] if int(item["qty"]) > 0)


def item_detail(item: Mapping[str, Any]) -> str:
    """The reason, " · Meter" for a length, " · ungeprüft" when not verified."""
    detail = str(item["reason"])
    if item["unit"] == METRE_UNIT:
        detail += METRE_NOTE
    if not item["verified"]:
        detail += UNCHECKED_NOTE
    return detail


def item_line(item: Mapping[str, Any]) -> material.PlannedLine:
    return material.PlannedLine(str(item["key"]), LINE_ENCLOSURE, str(item["label"]), item_detail(item),
                                int(item["qty"]))


def _accessory_number(item: Mapping[str, Any]) -> str | None:
    key, number = str(item["key"]), item.get("articleNo")
    return str(number) if key.startswith(ACCESSORY_PREFIX) and number else None


def derived_accessories(items: Iterable[Mapping[str, Any]]) -> dict[str, Mapping[str, Any]]:
    """Hager article number → its derived item (the ``accessory:`` items only)."""
    out: dict[str, Mapping[str, Any]] = {}
    for item in items:
        number = _accessory_number(item)
        if number is not None:
            out.setdefault(number, item)
    return out


def merged_accessory_line(admin: material.PlannedLine, item: Mapping[str, Any] | None) -> material.PlannedLine:
    """An admin accessory the board also derives: the larger count, the derived words.

    Without a derived count (no item, or one switched off) the admin's line stays as it is.
    """
    if item is None or int(item["qty"]) <= 0:
        return admin
    return replace(item_line(item), planned=max(admin.planned, int(item["qty"])))


def prep_planned_lines(
    items: Iterable[Mapping[str, Any]], admin_numbers: Collection[str]
) -> list[material.PlannedLine]:
    """One line per item, except a Hager article an admin accessory carries (merged at its slot)."""
    return [item_line(item) for item in items
            if int(item["qty"]) > 0 and _accessory_number(item) not in admin_numbers]


def prep_article_numbers(items: Iterable[Mapping[str, Any]]) -> dict[str, str]:
    """``accessory:``/``part:`` line key → the article number its stock match looks for."""
    return {str(item["key"]): str(item["articleNo"]) for item in items
            if str(item["key"]).startswith(NUMBERED_PREFIXES) and item.get("articleNo")}
