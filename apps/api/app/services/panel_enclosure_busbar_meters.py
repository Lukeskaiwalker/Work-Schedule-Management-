"""Which meter feeds a customer busbar (R4-11, docs/PANEL_ENCLOSURE_R4.md §3.3).

Twin: ``apps/web/src/utils/enclosureBusbarMeters.ts``, pinned through the
fixture's ``prep`` and ``findings`` (board ``two_meters_busbar_zb34s``).

A customer Sammelschiene is gezählt: the distribution behind one meter. Two
of them side by side are joined only when the same meter feeds both — a
ZZ55SAVE between the busbars of two meters would put two metered
distributions in parallel, around a meter.

The meter of a module = for every device on the module's live rails, follow
the feed upward (a circuit to the group that holds it, a group to the device
feeding it, ``build_topology``) to the first Hauptschalter or SLS; the module
holding that switch, when it is a meter module, is the meter. A module
collects every meter its devices lead to: none (unknown — empty rails, an FI
without feed), one, or several (a mix the planner made). Pure.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping

from app.services.panel_enclosure_catalog import EnclosureCatalog
from app.services.panel_enclosure_layout import (
    ident,
    linked_rows,
    module_rails,
    module_spec,
    modules_of,
    row_devices,
    rows_of,
)
from app.services.schaltplan_layout import build_topology

METER_FAMILIES = ("meter_ehz", "meter_3p")
#: Where the upward walk stops: the switch behind a meter.
SWITCH_KINDS = ("hauptschalter", "sls")


@dataclass(frozen=True)
class FeedIndex:
    """What the walk needs, built once per board."""

    up: Mapping[str, dict[str, Any]]  # device id → the device feeding it
    row_of: Mapping[str, str]  # device id → row id
    linked: Mapping[str, tuple[str, str]]  # row id → (module id, rail key)
    meter_modules: frozenset[str]  # ids of the board's meter modules
    rows: Mapping[str, dict[str, Any]]


def _upstream(rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """device id → its feeder; over the readable rows, as the TS twin builds them."""
    readable = {"rows": [{**row, "devices": row_devices(row)} for row in rows]}
    up: dict[str, dict[str, Any]] = {}
    for group in build_topology(readable)["groups"]:
        head = group.get("device")
        if head is None:
            continue
        for child in group.get("children") or []:
            child_id = ident(child.get("id"))
            if child_id and child_id not in up:
                up[child_id] = head
        head_id = ident(head.get("id"))
        if group.get("fed_by") is not None and head_id:
            up[head_id] = group["fed_by"]
    return up


def feed_index(document: Any, catalog: EnclosureCatalog) -> FeedIndex:
    readable = rows_of(document)
    rows = {row["id"]: row for row in readable}
    row_of: dict[str, str] = {}
    for row_id, row in rows.items():
        for device in row_devices(row):
            device_id = ident(device.get("id"))
            if device_id and device_id not in row_of:
                row_of[device_id] = row_id
    meters = set()
    for module in modules_of(document):
        spec = module_spec(module, catalog)
        if spec is not None and spec.get("family") in METER_FAMILIES:
            meters.add(ident(module.get("id")))
    return FeedIndex(up=_upstream(readable), row_of=row_of, linked=linked_rows(document, catalog),
                     meter_modules=frozenset(meters), rows=rows)


def _switch_of(device: dict[str, Any], index: FeedIndex) -> dict[str, Any] | None:
    seen: set[str] = set()
    node: dict[str, Any] | None = device
    while node is not None:
        node_id = ident(node.get("id"))
        if node_id in seen:
            return None
        seen.add(node_id)
        if str(node.get("kind") or "") in SWITCH_KINDS:
            return node
        node = index.up.get(node_id)
    return None


def _meter_of(device: dict[str, Any], index: FeedIndex) -> str | None:
    switch = _switch_of(device, index)
    if switch is None:
        return None
    link = index.linked.get(index.row_of.get(ident(switch.get("id")), ""))
    return link[0] if link is not None and link[0] in index.meter_modules else None


def module_meters(module: Mapping[str, Any], index: FeedIndex) -> frozenset[str]:
    """The meter modules (by id) the devices on a module's live rails are fed through."""
    module_id = ident(module.get("id"))
    found: set[str] = set()
    for key, row_id in module_rails(module).items():
        if index.linked.get(row_id) != (module_id, key):
            continue
        for device in row_devices(index.rows.get(row_id)):
            meter = _meter_of(device, index)
            if meter is not None:
                found.add(meter)
    return frozenset(found)


def different_meters(a: frozenset[str], b: frozenset[str]) -> bool:
    """Both known and not the one same meter: never join."""
    return bool(a) and bool(b) and not (len(a) == 1 and a == b)


def meter_unknown(a: frozenset[str], b: frozenset[str]) -> bool:
    """One side's meter is unknown: a joint is planned, but unverified."""
    return not a or not b
