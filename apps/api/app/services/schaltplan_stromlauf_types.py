"""The Stromlaufplan's vocabulary: what the model hands the layout (docs/SCHALTPLAN_STROMLAUF.md §5.2).

Frozen dataclasses only, plus the two readers every part of the model needs
(a device as a ``Unit``, a group's feeder path). Split out of
``schaltplan_stromlauf_model`` so the cabinet section
(``schaltplan_stromlauf_cabinet``) can build lanes of the same units without
an import cycle; the model re-exports every name.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Mapping

from app.services.schaltplan_conductors import Outgoing, SupplyConductors, device_conductors, device_poles
from app.services.schaltplan_layout import DEVICE_CATALOG
from app.services.schaltplan_pdf_style import text_of


@dataclass(frozen=True)
class Supply:
    system: str
    voltage: str
    incoming: str
    fuse: str
    conductors: SupplyConductors

    @property
    def caption(self) -> str:
        """"Zuleitung NYY-J 5x16 mm² · Vorsicherung NH 63 A · TN-S"."""
        return " · ".join((f"Zuleitung {self.incoming or '—'}", f"Vorsicherung {self.fuse or '—'}",
                           self.system or "—"))


@dataclass(frozen=True)
class Unit:
    """One device as the drawing names it."""

    id: str
    kind: str
    designation: str
    rating: str
    poles: int
    conductors: tuple[str, ...]

    @property
    def short(self) -> str:
        return str(DEVICE_CATALOG.get(self.kind, {}).get("short", "?"))

    @property
    def name(self) -> str:
        """"Q1 HS"."""
        return " ".join(p for p in (self.designation, self.short) if p)

    @property
    def bmk(self) -> str:
        """"Q1", or the kind's short name when the plan gives none."""
        return self.designation or self.short


@dataclass(frozen=True)
class Circuit:
    unit: Unit
    circuit: str
    label: str
    room: str
    outgoing: Outgoing
    terminal: str = ""   # "X1.3" when the board's terminals are given
    location: str = ""   # "AAR Feld 1" for a circuit above the meter of a cabinet board
    rcd: str = ""        # "IΔn 30 mA · Typ B" for an RCBO (its own residual-current protection)

    @property
    def protected(self) -> bool:
        """Carries its own residual-current protection (an RCBO)."""
        return self.unit.kind == "rcbo"


@dataclass(frozen=True)
class Head:
    unit: Unit | None           # None: the supply group (circuits straight off the bus)
    rcd_text: str = ""          # "IΔn 30 mA · Typ A" (RCD only)
    pre_fuse: Unit | None = None
    feeds: str = ""             # "speist F1, F2" (a Hauptschalter with circuits that feeds FIs)


@dataclass(frozen=True)
class LoadGroup:
    key: str
    source: str
    head: Head
    circuits: tuple[Circuit, ...]
    box: str = "device"         # "device" | "warn" (a circuit without residual-current protection)


@dataclass(frozen=True)
class Source:
    key: str                    # "" = the supply, else the chain's ids joined by ">"
    caption: str                # "hinter Q1" ("" for the supply)
    series: tuple[Unit, ...]    # feeder heads without circuits drawn in series on this segment's bus
    origin: str                 # "supply" | "parallel" | "cabinet:{lane}" ("cabinet:" = the NAR) | an xref text


@dataclass(frozen=True)
class StromlaufModel:
    supply: Supply
    sources: tuple[Source, ...]
    groups: tuple[LoadGroup, ...]
    unknown_phases: int
    cabinet: Any = None         # the "Einspeisung & Zählerplatz" section (schaltplan_stromlauf_cabinet)
    notes: tuple[str, ...] = field(default=())


def ident(device: Mapping[str, Any] | None) -> str:
    return str(device.get("id") or "") if device is not None else ""


def make_unit(device: Mapping[str, Any]) -> Unit:
    return Unit(ident(device), str(device.get("kind") or ""), text_of(device.get("designation")),
                text_of(device.get("rating")), device_poles(device), device_conductors(device))


def feeder_path(group: Mapping[str, Any], by_head: Mapping[str, Mapping[str, Any]]) -> tuple[dict[str, Any], ...]:
    """The feeders above a group, root first; stops at a repeat."""
    path: list[dict[str, Any]] = []
    seen: set[str] = set()
    feeder = group.get("fed_by")
    while feeder is not None and ident(feeder) not in seen:
        path.append(feeder)
        seen.add(ident(feeder))
        upper = by_head.get(ident(feeder))
        feeder = upper.get("fed_by") if upper is not None else None
    return tuple(reversed(path))


def source_key(path: Any) -> str:
    return ">".join(ident(device) for device in path)
