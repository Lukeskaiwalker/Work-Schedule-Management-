"""Verteilerplan — device catalogue, topology derivation and legend building.

This module is the single source of truth for what a panel document *means*.
The React editor mirrors the catalogue in ``apps/web/src/utils/schaltplanDevices.ts``
and the topology rules in ``apps/web/src/utils/schaltplanLegend.ts`` so the
on-screen diagram and the printed PDF agree; both files carry a pointer back
here. When a device kind is added, add it in both places.

The document shape
------------------
::

    {
      "version": 1,
      "supply": {
        "system": "TN-S",              # TN-S | TN-C-S | TT | IT
        "voltage": "400/230 V",
        "incoming": "NYY-J 5x16 mm²",  # the feeding cable
        "fuse": "NH 63 A",             # the upstream backup fuse
        "meter_number": "1ESY...",
        "note": ""
      },
      "rows": [
        {"id": "r1", "label": "Reihe 1", "slots": 12, "devices": [Device, ...]}
      ]
    }

    Device = {
      "id": "d3",
      "kind": "mcb",                # key into DEVICE_CATALOG
      "te": 1,                      # width in Teilungseinheiten (18 mm modules)
      "poles": 1,
      "designation": "F3",          # Betriebsmittelkennzeichen
      "circuit": "3",               # Stromkreis-Nr. printed in the legend
      "label": "Steckdosen Küche",
      "room": "Küche",
      "rating": "B16",
      "residual_current": "30 mA",  # RCD only
      "rcd_type": "A",              # RCD only
      "cable": "NYM-J 3x1,5 mm²",
      "phase": "L1",
      "parent_id": null,            # explicit feed override; see below
      "note": ""
    }

Topology without drawing a single wire
--------------------------------------
Real boards are wired by position: everything on the rail after an FI hangs
off that FI, until the next FI. The editor takes that convention literally, so
a worker never draws connections — the tree is derived from device order:

  * a device whose kind is ``group=True`` (Hauptschalter, SLS, FI) opens a new
    protection group and becomes the parent of everything after it;
  * a device whose kind is ``circuit=True`` becomes a child of the currently
    open group — or of the panel's supply when no group is open yet;
  * ``parent_id`` overrides the derivation for the exception case (a circuit
    physically sitting in row 3 but fed from the FI in row 1). An unknown or
    self-referential ``parent_id`` is ignored rather than raising: a stale id
    left behind by a deleted FI must degrade to "unprotected" on the drawing,
    which is visible and fixable, not 500 the request.

Rows are the *physical* layout (which rail, which slot). The tree is the
*electrical* layout. Both come out of the same array, which is why the two
never drift apart.
"""

from __future__ import annotations

from typing import Any, Iterator

# ── Device catalogue ────────────────────────────────────────────────────────
#
# ``te``      default width in Teilungseinheiten (1 TE = 18 mm)
# ``poles``   default pole count
# ``group``   opens a protection group — children hang beneath it
# ``circuit`` occupies a Stromkreis line in the legend
# ``symbol``  which glyph the renderers draw (shared vocabulary, not a 1:1 map
#             to kind, so several kinds can reuse one symbol)

DEVICE_CATALOG: dict[str, dict[str, Any]] = {
    "hauptschalter": {
        "label": "Hauptschalter",
        "short": "HS",
        "te": 3, "poles": 3, "group": True, "circuit": False, "symbol": "switch",
        "rating_hint": "63 A",
    },
    "sls": {
        "label": "SLS-Schalter (selektiv)",
        "short": "SLS",
        "te": 3, "poles": 3, "group": True, "circuit": False, "symbol": "sls",
        "rating_hint": "E35",
    },
    "rcd": {
        "label": "FI-Schutzschalter (RCD)",
        "short": "FI",
        "te": 4, "poles": 4, "group": True, "circuit": False, "symbol": "rcd",
        "rating_hint": "40 A",
    },
    "rcbo": {
        # Combined RCD+MCB: it protects itself only, so it is a circuit, not a
        # group. Marking it group=True would silently adopt every following
        # LS as its children and print a wrong FI column in the legend.
        "label": "FI/LS kombiniert (RCBO)",
        "short": "FI/LS",
        "te": 2, "poles": 2, "group": False, "circuit": True, "symbol": "rcbo",
        "rating_hint": "B16",
    },
    "mcb": {
        "label": "Leitungsschutzschalter (LS)",
        "short": "LS",
        "te": 1, "poles": 1, "group": False, "circuit": True, "symbol": "mcb",
        "rating_hint": "B16",
    },
    "fuse": {
        "label": "Sicherung (NH / Neozed)",
        "short": "Si",
        "te": 3, "poles": 3, "group": False, "circuit": True, "symbol": "fuse",
        "rating_hint": "35 A",
    },
    "spd": {
        "label": "Überspannungsschutz (SPD)",
        "short": "SPD",
        "te": 4, "poles": 4, "group": False, "circuit": False, "symbol": "spd",
        "rating_hint": "Typ 2",
    },
    "meter": {
        "label": "Zähler / eHZ",
        "short": "kWh",
        "te": 6, "poles": 3, "group": False, "circuit": False, "symbol": "meter",
        "rating_hint": "",
    },
    "contactor": {
        "label": "Installationsschütz",
        "short": "Schütz",
        "te": 2, "poles": 4, "group": False, "circuit": True, "symbol": "contactor",
        "rating_hint": "20 A",
    },
    "impulse": {
        "label": "Stromstoßschalter",
        "short": "Stromstoß",
        "te": 1, "poles": 1, "group": False, "circuit": True, "symbol": "relay",
        "rating_hint": "16 A",
    },
    "timer": {
        "label": "Treppenlicht-/Zeitrelais",
        "short": "Zeit",
        "te": 1, "poles": 1, "group": False, "circuit": True, "symbol": "relay",
        "rating_hint": "16 A",
    },
    "bell_transformer": {
        "label": "Klingeltrafo",
        "short": "Trafo",
        "te": 2, "poles": 1, "group": False, "circuit": True, "symbol": "transformer",
        "rating_hint": "8 V",
    },
    "power_supply": {
        "label": "Netzteil / Spannungsversorgung",
        "short": "NT",
        "te": 4, "poles": 1, "group": False, "circuit": True, "symbol": "transformer",
        "rating_hint": "24 V DC",
    },
    "knx_actuator": {
        "label": "KNX-Aktor",
        "short": "KNX",
        "te": 4, "poles": 1, "group": False, "circuit": True, "symbol": "bus",
        "rating_hint": "8-fach",
    },
    "wallbox": {
        "label": "Wallbox-Abgang",
        "short": "Wallbox",
        "te": 3, "poles": 3, "group": False, "circuit": True, "symbol": "wallbox",
        "rating_hint": "B32",
    },
    "pv": {
        "label": "PV-Einspeisung / Wechselrichter",
        "short": "PV",
        "te": 3, "poles": 3, "group": False, "circuit": True, "symbol": "pv",
        "rating_hint": "B25",
    },
    "sub_feed": {
        "label": "Abgang Unterverteiler",
        "short": "→ UV",
        "te": 3, "poles": 3, "group": False, "circuit": True, "symbol": "subfeed",
        "rating_hint": "B40",
    },
    "terminal": {
        "label": "Reihenklemme N/PE",
        "short": "Klemme",
        "te": 1, "poles": 1, "group": False, "circuit": False, "symbol": "terminal",
        "rating_hint": "",
    },
    "blank": {
        "label": "Blindabdeckung",
        "short": "—",
        "te": 1, "poles": 1, "group": False, "circuit": False, "symbol": "blank",
        "rating_hint": "",
    },
}

# Kinds a client may send. Anything else is rejected at the schema boundary
# rather than silently stored and later rendered as an empty box.
DEVICE_KINDS: frozenset[str] = frozenset(DEVICE_CATALOG)

SUPPLY_SYSTEMS: tuple[str, ...] = ("TN-S", "TN-C-S", "TT", "IT")
PANEL_TYPES: tuple[str, ...] = ("main", "sub", "meter")
PANEL_STATUSES: tuple[str, ...] = ("draft", "final")

PANEL_TYPE_LABELS: dict[str, str] = {
    "main": "Hauptverteiler",
    "sub": "Unterverteiler",
    "meter": "Zählerplatz",
}

# A standard Hager/ABB rail takes 12 modules. Kept as a constant because both
# the slot-usage warning and the empty-document factory need it.
DEFAULT_SLOTS_PER_ROW = 12


def empty_document() -> dict[str, Any]:
    """A new board: one empty rail and an unfilled supply block.

    Deliberately not "one board pre-filled with a Hauptschalter and two FIs".
    A guessed starting point reads as fact once it is on the drawing, and a
    wrong FI type on as-built documentation is worse than an empty rail.
    """

    return {
        "version": 1,
        "supply": {
            "system": "TN-S",
            "voltage": "400/230 V",
            "incoming": "",
            "fuse": "",
            "meter_number": "",
            "note": "",
        },
        "rows": [{"id": "row-1", "label": "Reihe 1", "slots": DEFAULT_SLOTS_PER_ROW, "devices": []}],
    }


def iter_devices(document: dict[str, Any]) -> Iterator[tuple[dict[str, Any], dict[str, Any]]]:
    """Yield ``(row, device)`` in physical order: row by row, left to right.

    Tolerant of partial documents — a row without ``devices`` or a device that
    is not a dict is skipped rather than raising. These documents are written
    by a tablet that may be several app versions behind.
    """

    for row in document.get("rows") or []:
        if not isinstance(row, dict):
            continue
        for device in row.get("devices") or []:
            if isinstance(device, dict):
                yield row, device


def _catalog(kind: str) -> dict[str, Any]:
    return DEVICE_CATALOG.get(kind, DEVICE_CATALOG["blank"])


def is_group_device(device: dict[str, Any]) -> bool:
    return bool(_catalog(str(device.get("kind", ""))).get("group"))


def is_circuit_device(device: dict[str, Any]) -> bool:
    return bool(_catalog(str(device.get("kind", ""))).get("circuit"))


def device_te(device: dict[str, Any]) -> int:
    """Module width, falling back to the catalogue default.

    Clamped to 1..24: a hand-edited ``te`` of 0 would make a device invisible
    on the rail, and a huge one would push every sibling off the drawing.
    """

    raw = device.get("te")
    try:
        value = int(raw)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        value = int(_catalog(str(device.get("kind", ""))).get("te", 1))
    return max(1, min(24, value))


def row_used_slots(row: dict[str, Any]) -> int:
    return sum(device_te(device) for device in (row.get("devices") or []) if isinstance(device, dict))


# ── Topology ────────────────────────────────────────────────────────────────


def build_topology(document: dict[str, Any]) -> dict[str, Any]:
    """Derive the electrical tree from physical device order.

    Returns::

        {
          "groups": [{"device": <group device or None>,
                      "row_label": "Reihe 1",
                      "children": [<circuit device>, ...]}],
          "orphans": [<circuit device explicitly parented to a missing id>],
        }

    The first group may have ``device: None`` — that is the implicit "direkt
    von der Einspeisung" group holding circuits placed before any FI. It is
    only emitted when it actually has children, so a normally-built board
    shows no phantom group.
    """

    by_id: dict[str, dict[str, Any]] = {}
    for _row, device in iter_devices(document):
        device_id = str(device.get("id") or "")
        if device_id:
            by_id[device_id] = device

    # Explicit parents may only point at a *group* device. Pointing a circuit
    # at another circuit is not a thing a board can do, and letting it through
    # would build a tree the diagram cannot draw.
    valid_parents = {
        device_id for device_id, device in by_id.items() if is_group_device(device)
    }

    groups: list[dict[str, Any]] = []
    index_by_group_id: dict[str, int] = {}
    supply_group: dict[str, Any] = {"device": None, "row_label": "", "children": []}
    current: dict[str, Any] = supply_group
    orphans: list[dict[str, Any]] = []

    for row, device in iter_devices(document):
        if is_group_device(device):
            current = {
                "device": device,
                "row_label": str(row.get("label") or ""),
                "children": [],
            }
            groups.append(current)
            device_id = str(device.get("id") or "")
            if device_id:
                index_by_group_id[device_id] = len(groups) - 1
            continue

        if not is_circuit_device(device):
            # SPDs, terminals, blanks and the meter occupy rail space but are
            # not circuits: they belong on the rail view, never in the legend
            # or as a branch on the diagram.
            continue

        explicit = str(device.get("parent_id") or "")
        if explicit:
            if explicit in valid_parents:
                groups[index_by_group_id[explicit]]["children"].append(device)
            else:
                # Dangling reference (the FI it named was deleted). Show it as
                # unprotected so the mistake is on the drawing, not hidden.
                orphans.append(device)
                supply_group["children"].append(device)
            continue

        current["children"].append(device)

    if supply_group["children"]:
        groups.insert(0, supply_group)

    return {"groups": groups, "orphans": orphans}


def _text(value: Any) -> str:
    return str(value).strip() if value is not None else ""


def _rcd_summary(group_device: dict[str, Any] | None) -> str:
    """The legend's FI column: "30 mA / Typ A" for an RCD, "—" without one."""

    if group_device is None:
        return "—"
    kind = str(group_device.get("kind", ""))
    if kind != "rcd":
        # A Hauptschalter or SLS group offers no residual-current protection;
        # saying "—" here is the honest answer and is what an inspector needs
        # to see. The group is still drawn on the diagram.
        return "—"
    parts = [p for p in (_text(group_device.get("residual_current")), _text(group_device.get("rcd_type"))) if p]
    if not parts:
        return "FI"
    if len(parts) == 2:
        return f"{parts[0]} / Typ {parts[1]}"
    return parts[0]


def build_legend(document: dict[str, Any]) -> list[dict[str, str]]:
    """The Stromkreisliste: one row per circuit, in physical device order.

    This is the artefact that gets glued inside the panel door, so the column
    set matches what an electrician reads off it in the dark: which breaker,
    what it feeds, which room, how it is protected, what cable runs to it.
    """

    topology = build_topology(document)
    rows: list[dict[str, str]] = []

    for group in topology["groups"]:
        group_device = group["device"]
        rcd = _rcd_summary(group_device)
        group_label = (
            f"{_text(group_device.get('designation'))} {_text(group_device.get('label'))}".strip()
            if group_device
            else "Direkt von Einspeisung"
        )
        for device in group["children"]:
            catalog = _catalog(str(device.get("kind", "")))
            # An RCBO carries its own residual-current data; it is its own FI.
            own_rcd = rcd
            if str(device.get("kind")) == "rcbo":
                parts = [
                    p
                    for p in (
                        _text(device.get("residual_current")),
                        _text(device.get("rcd_type")),
                    )
                    if p
                ]
                own_rcd = (
                    f"{parts[0]} / Typ {parts[1]}" if len(parts) == 2 else (parts[0] if parts else "FI/LS")
                )
            rows.append(
                {
                    "circuit": _text(device.get("circuit")),
                    "designation": _text(device.get("designation")),
                    "label": _text(device.get("label")),
                    "room": _text(device.get("room")),
                    "device": str(catalog.get("short", "")),
                    "rating": _text(device.get("rating")),
                    "rcd": own_rcd,
                    "cable": _text(device.get("cable")),
                    "phase": _text(device.get("phase")),
                    "group": group_label,
                    "note": _text(device.get("note")),
                }
            )

    return rows


def document_stats(document: dict[str, Any]) -> dict[str, int]:
    """Counts for the panel cards in the list view — cheap, no layout needed."""

    circuits = 0
    devices = 0
    rcds = 0
    used = 0
    slots = 0
    for row, device in iter_devices(document):
        devices += 1
        used += device_te(device)
        if is_circuit_device(device):
            circuits += 1
        if str(device.get("kind")) in {"rcd", "rcbo"}:
            rcds += 1
    for row in document.get("rows") or []:
        if isinstance(row, dict):
            try:
                slots += int(row.get("slots") or DEFAULT_SLOTS_PER_ROW)
            except (TypeError, ValueError):
                slots += DEFAULT_SLOTS_PER_ROW
    return {
        "device_count": devices,
        "circuit_count": circuits,
        "rcd_count": rcds,
        "used_slots": used,
        "total_slots": slots,
        "row_count": len(document.get("rows") or []),
    }


def validate_document(document: dict[str, Any]) -> list[dict[str, str]]:
    """Non-blocking plausibility findings shown as warnings in the editor.

    Deliberately advisory, never an error: a board captured mid-refurbishment
    is legitimately inconsistent, and refusing to save it would push the crew
    back to taking photos of the rail with their phone. Each finding names the
    row or device so the UI can point at it.
    """

    findings: list[dict[str, str]] = []

    for row in document.get("rows") or []:
        if not isinstance(row, dict):
            continue
        try:
            slots = int(row.get("slots") or DEFAULT_SLOTS_PER_ROW)
        except (TypeError, ValueError):
            slots = DEFAULT_SLOTS_PER_ROW
        used = row_used_slots(row)
        if used > slots:
            findings.append(
                {
                    "level": "warn",
                    "scope": str(row.get("id") or ""),
                    "message": f"{row.get('label') or 'Reihe'}: {used} TE belegt, aber nur {slots} TE vorhanden.",
                }
            )

    seen_circuits: dict[str, int] = {}
    for _row, device in iter_devices(document):
        circuit = _text(device.get("circuit"))
        if is_circuit_device(device):
            if not circuit:
                findings.append(
                    {
                        "level": "info",
                        "scope": str(device.get("id") or ""),
                        "message": f"{_text(device.get('label')) or 'Stromkreis'}: keine Stromkreis-Nr. vergeben.",
                    }
                )
            else:
                seen_circuits[circuit] = seen_circuits.get(circuit, 0) + 1
            if not _text(device.get("cable")):
                findings.append(
                    {
                        "level": "info",
                        "scope": str(device.get("id") or ""),
                        "message": f"Stromkreis {circuit or '?'}: keine Leitung angegeben.",
                    }
                )

    for circuit, count in seen_circuits.items():
        if count > 1:
            findings.append(
                {
                    "level": "warn",
                    "scope": "",
                    "message": f"Stromkreis-Nr. {circuit} ist {count}× vergeben.",
                }
            )

    topology = build_topology(document)
    for group in topology["groups"]:
        if group["device"] is None and group["children"]:
            findings.append(
                {
                    "level": "warn",
                    "scope": "",
                    "message": (
                        f"{len(group['children'])} Stromkreis(e) ohne vorgeschalteten "
                        "FI-Schutzschalter."
                    ),
                }
            )

    return findings
