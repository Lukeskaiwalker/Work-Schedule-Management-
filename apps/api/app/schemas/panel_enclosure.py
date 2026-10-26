"""Schemas of the cabinet layer of a Verteilerplan (docs/PANEL_ENCLOSURE.md).

Three groups live here, because they share the code and key types:

* the document parts (§2.2) — ``document.enclosure`` and
  ``device.supplied_by`` as the editor stores them;
* the catalogue specs (§3.1) — what a cabinet or a field module looks like,
  for the built-ins in ``services/panel_enclosure_catalog_data.py`` and for
  the entries an admin adds;
* the catalogue API in/out shapes (§7) and the German error text for a spec
  an admin got wrong.

Validation posture differs on purpose. The document parts refuse only
structural garbage (two modules with one id, one row on two rails, a code
that is no code): a board captured half-built must save, so bounds against
the real cabinet, overlaps and dangling references are findings, not 422s
(D6, D10). They also keep keys they do not know, for the same reason Slice P
passed the whole block through: an image that dropped them would strip a
later release's data from every board on its next autosave. The 64 KB
ceiling on the block (``schemas/schaltplan.py``) bounds what that lets in.

The specs are strict: an admin's typo ("metter_places") must not be silently
ignored, and the geometry, the rules and the Materialliste all read these
shapes without re-checking them.
"""

from __future__ import annotations

import math
import re
from datetime import datetime
from typing import TYPE_CHECKING, Annotated, Any, Literal
from urllib.parse import urlparse

from pydantic import (
    AfterValidator,
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    ValidationError,
    field_validator,
    model_validator,
)

from app.services.schaltplan_layout import DEVICE_KINDS

if TYPE_CHECKING:
    # Only for annotations: schemas.schaltplan imports this module for the
    # document parts, so it completes the API models (model_rebuild) once
    # PanelMaterialArticleOut exists — the schemas.project/customer idiom.
    from app.schemas.schaltplan import PanelMaterialArticleOut

CODE_PATTERN = re.compile(r"^[A-Z0-9][A-Z0-9._-]{1,39}$")
KEY_PATTERN = re.compile(r"^[a-z0-9_-]{1,40}$")

# DoS ceilings of one stored board (§15), not modelling opinions: a ZB55S
# holds at most 45 one-unit (150 mm) modules.
MAX_MODULES = 50
MAX_RAILS_PER_MODULE = 16
MAX_FITTINGS_PER_MODULE = 16
MAX_METERS_PER_MODULE = 8

EntryType = Literal["enclosure", "module"]
ZoneType = Literal["NAR", "ZF", "RFZ", "AAR", "VF", "APZ", "VT", "SAS", "MM", "COVER"]
MountType = Literal["rail", "busbar"]
Family = Literal[
    "meter_ehz", "meter_3p", "distribution", "distribution_apz", "busbar", "communication", "multimedia", "cover"
]
METER_FAMILIES: frozenset[str] = frozenset({"meter_ehz", "meter_3p"})


class SpecRule(ValueError):
    """A rule broken somewhere below the model that checks it.

    ``path`` is relative to that model (``zones[1]``), so the German error
    can name the exact place; pydantic only knows the model's own location.
    """

    def __init__(self, path: str, message: str) -> None:
        super().__init__(f"{path}: {message}" if path else message)
        self.path = path
        self.message = message


# ── Shared types ─────────────────────────────────────────────────────────────


def normalize_code(value: object) -> object:
    """Strip and upper-case (" zh3eh16 " is ZH3EH16): codes are typed by hand on site."""
    return value.strip().upper() if isinstance(value, str) else value


def _check_code(value: str) -> str:
    if not CODE_PATTERN.fullmatch(value):
        raise ValueError("ist kein gültiger Code (A–Z, 0–9, Punkt, _ oder -, 2 bis 40 Zeichen)")
    return value


def _check_key(value: str) -> str:
    if not KEY_PATTERN.fullmatch(value):
        raise ValueError("ist kein gültiger Schlüssel (a–z, 0–9, _ oder -, höchstens 40 Zeichen)")
    return value


def _check_kind(value: str) -> str:
    if value not in DEVICE_KINDS:
        raise ValueError(f"„{value}“ ist kein bekannter Gerätetyp")
    return value


def _between(low: int, high: int) -> AfterValidator:
    """A range check whose message names both ends ("zwischen 1 und 24").

    ``Field(ge=…, le=…)`` reports only the bound that was broken, and the
    admin form shows the message as is.
    """

    def check(value: int) -> int:
        if not low <= value <= high:
            raise ValueError(f"muss zwischen {low} und {high} liegen")
        return value

    return AfterValidator(check)


def _not_negative(value: int) -> int:
    if value < 0:
        raise ValueError("darf nicht negativ sein")
    return value


def _https_url(value: str) -> str:
    # Rendered as a link in the admin and the module picker: anything but a
    # plain https URL (javascript:, data:, http:) is refused at the door.
    parsed = urlparse(value)
    if parsed.scheme != "https" or not parsed.netloc or any(ch.isspace() for ch in value):
        raise ValueError("muss ein https-Link sein")
    return value


CatalogCode = Annotated[str, BeforeValidator(normalize_code), AfterValidator(_check_code)]
RailKey = Annotated[str, AfterValidator(_check_key)]
DeviceKind = Annotated[str, AfterValidator(_check_kind)]
RowRef = Annotated[str, Field(min_length=1, max_length=64)]
FittingRef = Annotated[str, Field(min_length=1, max_length=40)]
Units = Annotated[int, AfterValidator(_not_negative)]
Millimetres = Annotated[int, _between(1, 10_000)]
SourceUrl = Annotated[str, Field(max_length=500), AfterValidator(_https_url)]
UnverifiedNote = Annotated[str, Field(min_length=1, max_length=200)]

# Kept, not dropped: see the module docstring.
_KEEP_UNKNOWN = ConfigDict(extra="allow")


# ── Document parts (§2.1, §2.2) ──────────────────────────────────────────────


class DeviceSuppliedBy(BaseModel):
    """This device came pre-fitted in a cabinet module: which one, which part.

    Exactly two keys. Unlike the enclosure block it sits on every device and
    outside the 64 KB ceiling, so nothing else may ride along.
    """

    model_config = ConfigDict(extra="forbid")

    module: str = Field(min_length=1, max_length=64)
    part: str = Field(min_length=1, max_length=40)


class EnclosureMeter(BaseModel):
    """An occupied meter place. A place without an entry is "frei" (reserve)."""

    model_config = _KEEP_UNKNOWN

    place: int = Field(ge=0, le=7)
    number: str = Field(default="", max_length=40)
    label: str = Field(default="", max_length=64)


class EnclosureFitting(BaseModel):
    """A catalogue fitting as snapshotted into the module at placement (D5)."""

    model_config = _KEEP_UNKNOWN

    key: RailKey
    label: str = Field(min_length=1, max_length=96)
    article_no: str | None = Field(default=None, max_length=40)
    device_kind: DeviceKind | None = None
    removable: bool = False


# ``module.terminal_order`` caps (docs/PANEL_ENCLOSURE_R2.md §2.1). A 210 mm
# rail holds ≤ 8 Leisten; 40 is a DoS cap, not a model limit.
MAX_ORDER_STRIPS = 40
STRIP_ID_MAX = 80
# Field offsets inside a module ("0" for every built-in; width_fields ≤ 3).
FIELD_OFFSET_KEYS: tuple[str, ...] = ("0", "1", "2")


def parse_terminal_order(value: Any) -> dict[str, dict[str, Any]] | None:
    """``module.terminal_order`` as far as it makes sense; never raises.

    Lenient on purpose: a raised error would make ``readable_document`` drop
    the whole cabinet block, and an image without this key (a rollback to
    v2.15.0) stores it unvalidated. So the schema and every derivation that
    reads a stored board (``panel_enclosure_terminals``) parse it with this.
    Twin: ``parseTerminalOrder`` in ``apps/web/src/utils/enclosureTerminals.ts``.
    """
    if not isinstance(value, dict):
        return None
    out: dict[str, dict[str, Any]] = {}
    for key in FIELD_OFFSET_KEYS:
        entry = value.get(key)
        if not isinstance(entry, dict) or not isinstance(entry.get("strips"), list):
            continue
        strips = list(dict.fromkeys(
            s for s in entry["strips"] if isinstance(s, str) and 0 < len(s) <= STRIP_ID_MAX))[:MAX_ORDER_STRIPS]
        if strips:
            mark = entry.get("rail2_from")
            out[key] = {"strips": strips, "rail2_from": mark if isinstance(mark, str) and mark in strips else None}
    return out or None


class TerminalOrderEntry(BaseModel):
    """One field's manual strip sequence (§2.1): left → right on rail 1, then
    rail 2; ``rail2_from`` names the strip that starts rail 2 (None: split
    automatically). Only what ``parse_terminal_order`` returns reaches it."""

    strips: list[str]
    rail2_from: str | None = None


# ── The §14a block and the prep overrides (docs/PANEL_ENCLOSURE_R4.md §2) ─────
#
# Constants the parsers need live here (the schema must not import the
# derivations); ``panel_enclosure_control_block`` re-exports them.

WIRE_COLOURS: tuple[str, ...] = ("braun", "schwarz", "grau", "rot", "violett", "weiß", "orange", "rosa")
MAX_CONTROL_TERMINALS = 12
CONTROL_LABEL_MAX = 12  # code points
DEFAULT_WIRE_MM2 = 2.5
WIRE_MM2_CHOICES: tuple[float, ...] = (1.5, 2.5)
DEFAULT_LABEL_MATERIAL = "wago-211-502"
TUBE_MATERIAL_IDS: frozenset[str] = frozenset({"wago-211-501", "wago-211-502"})
LENGTH_MIN_M, LENGTH_MAX_M = 0.5, 20.0
PREP_CHOICES: dict[str, tuple[str, ...]] = {
    "supply": ("auto", "SA", "LS", "SI", "off"),
    "infeed": ("auto", "K96ESA5", "clamps", "off"),
    "joints": ("auto", "off"),
    "network": ("auto", "off"),
}
_TERMINAL_ID = re.compile(r"t[0-9]{1,3}", re.ASCII)
_CONTROL_CHARS = re.compile(r"[\x00-\x1f\x7f-\x9f]")


def _number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def parse_length_m(value: Any) -> float | None:
    """Rule 8 of §2.1: a finite number, ``round1`` half up, kept in [0,5; 20]."""
    if not _number(value) or not math.isfinite(value) or abs(value) > 1e9:
        return None
    rounded = math.floor(value * 10 + 0.5) / 10
    return rounded if LENGTH_MIN_M <= rounded <= LENGTH_MAX_M else None


def _terminal_ids(entries: list[dict[str, Any]]) -> list[str]:
    kept: list[str | None] = []
    for entry in entries:
        value = entry.get("id")
        ok = isinstance(value, str) and _TERMINAL_ID.fullmatch(value) and value not in kept
        kept.append(value if ok else None)
    taken = {value for value in kept if value is not None}
    out: list[str] = []
    for value in kept:
        if value is None:
            n = 1
            while f"t{n}" in taken:
                n += 1
            value = f"t{n}"
            taken.add(value)
        out.append(value)
    return out


def _control_label(value: Any) -> str:
    text = _CONTROL_CHARS.sub("", value) if isinstance(value, str) else ""
    return text.strip(" ")[:CONTROL_LABEL_MAX]


def parse_control_block(value: Any) -> dict[str, Any] | None:
    """``enclosure.control_block`` as far as it makes sense; never raises (§2.1).

    Twin: ``parseControlBlock``; the fixture table ``control_block_parse``
    pins every branch. Every derivation reads the block through this.
    """
    if not isinstance(value, dict):
        return None
    raw = value.get("terminals")
    entries = [e for e in (raw if isinstance(raw, list) else []) if isinstance(e, dict)][:MAX_CONTROL_TERMINALS]
    terminals = [
        {"id": ident, "label": _control_label(entry.get("label")),
         "color": entry.get("color") if entry.get("color") in WIRE_COLOURS else WIRE_COLOURS[index % 8]}
        for index, (entry, ident) in enumerate(zip(entries, _terminal_ids(entries)))
    ]
    rail = value.get("rail")
    mm2 = value.get("wire_mm2")
    material = value.get("label_material")
    tube = material if isinstance(material, str) and material in TUBE_MATERIAL_IDS else DEFAULT_LABEL_MATERIAL
    return {
        "terminals": terminals,
        "rail": rail if isinstance(rail, str) and KEY_PATTERN.fullmatch(rail) else None,
        "wire_mm2": float(mm2) if _number(mm2) and mm2 in WIRE_MM2_CHOICES else DEFAULT_WIRE_MM2,
        "wire_length_m": parse_length_m(value.get("wire_length_m")),
        "label_material": tube,
        "off": value.get("off") is True,
    }


def parse_prep(value: Any) -> dict[str, Any] | None:
    """``enclosure.prep`` (§2.2): unknown values are ``auto`` / ``None``; never raises."""
    if not isinstance(value, dict):
        return None
    out: dict[str, Any] = {key: value.get(key) if value.get(key) in choices else "auto"
                           for key, choices in PREP_CHOICES.items()}
    out["network_m"] = parse_length_m(value.get("network_m"))
    return out


class ControlTerminal(BaseModel):
    id: str
    label: str
    color: str


class ControlBlock(BaseModel):
    """Only what ``parse_control_block`` returns reaches it (keys in its order)."""

    terminals: list[ControlTerminal]
    rail: str | None
    wire_mm2: float
    wire_length_m: float | None
    label_material: str
    off: bool


class EnclosurePrep(BaseModel):
    supply: str
    infeed: str
    joints: str
    network: str
    network_m: float | None


class EnclosureModule(BaseModel):
    model_config = _KEEP_UNKNOWN

    id: str = Field(min_length=1, max_length=64)
    code: CatalogCode
    field: int = Field(ge=0, le=9)
    unit: int = Field(ge=0, le=19)
    label: str = Field(default="", max_length=64)
    # Catalogue rail key → row id, lazy: a rail gets a row when it first holds something.
    rails: dict[RailKey, RowRef] = Field(default_factory=dict, max_length=MAX_RAILS_PER_MODULE)
    # The snapshot taken at placement (D5). None = no snapshot (a hand-made
    # module: the derivations read the catalogue); [] = a snapshot of "nothing
    # came pre-fitted". The two must stay apart: read as "no snapshot", an
    # empty one would let a fitting an admin adds later rewrite the
    # Materialliste of every board that already has the module.
    fittings: Annotated[list[EnclosureFitting], Field(max_length=MAX_FITTINGS_PER_MODULE)] | None = None
    removed_fittings: list[FittingRef] = Field(default_factory=list, max_length=MAX_FITTINGS_PER_MODULE)
    meters: list[EnclosureMeter] = Field(default_factory=list, max_length=MAX_METERS_PER_MODULE)
    # Written only by a manual strip move (§2.1). Garbage is dropped, never
    # refused; None (absent, null or nothing usable) is never dumped, so a
    # board without a manual order keeps exactly the keys it had.
    terminal_order: Annotated[
        dict[str, TerminalOrderEntry] | None, BeforeValidator(parse_terminal_order)
    ] = Field(default=None, exclude_if=lambda value: value is None)

    @field_validator("removed_fittings")
    @classmethod
    def _once_each(cls, keys: list[str]) -> list[str]:
        # A list the client toggles; a key listed twice means the same thing once.
        return list(dict.fromkeys(keys))

    @model_validator(mode="after")
    def _unique_parts(self) -> EnclosureModule:
        keys = [fitting.key for fitting in self.fittings or []]
        if len(keys) != len(set(keys)):
            raise ValueError(f"Modul {self.id}: doppelter Teileschlüssel")
        places = [meter.place for meter in self.meters]
        if len(places) != len(set(places)):
            raise ValueError(f"Modul {self.id}: Zählerplatz doppelt belegt")
        return self


class PanelEnclosure(BaseModel):
    """``document.enclosure``: the cabinet and the modules in it (§2.1)."""

    model_config = _KEEP_UNKNOWN

    code: CatalogCode
    modules: list[EnclosureModule] = Field(default_factory=list, max_length=MAX_MODULES)
    # Round 4 (R4 §2): lenient like ``terminal_order``; None is never dumped,
    # so a board without them keeps exactly the keys it had.
    control_block: Annotated[ControlBlock | None, BeforeValidator(parse_control_block)] = Field(
        default=None, exclude_if=lambda value: value is None)
    prep: Annotated[EnclosurePrep | None, BeforeValidator(parse_prep)] = Field(
        default=None, exclude_if=lambda value: value is None)

    @model_validator(mode="after")
    def _one_owner_each(self) -> PanelEnclosure:
        # The two links every derivation keys on. The client normalises
        # before saving (normalizeEnclosure), so its own output never trips this.
        ids = [module.id for module in self.modules]
        if len(ids) != len(set(ids)):
            raise ValueError("Zwei Module mit derselben ID")
        seen: set[str] = set()
        for module in self.modules:
            for row_id in module.rails.values():
                if row_id in seen:
                    raise ValueError(f"Reihe {row_id} hängt an zwei Hutschienen")
                seen.add(row_id)
        return self


# ── Catalogue specs (§3.1) ───────────────────────────────────────────────────


class _Spec(BaseModel):
    model_config = ConfigDict(extra="forbid")


class RailSpec(_Spec):
    key: RailKey
    unit: Units
    ple: Annotated[int, _between(1, 24)]
    mount: MountType = "rail"
    retired: bool = False


class ZoneSpec(_Spec):
    key: RailKey
    type: ZoneType
    label: str = Field(default="", max_length=64)
    field: Units = 0
    unit: Units
    units: Annotated[int, _between(1, 9)]
    rails: list[RailSpec] = Field(default_factory=list, max_length=9)
    meter_places: Annotated[int, _between(0, 4)] = 0
    meter_type: Literal["ehz", "3punkt"] | None = None
    sealable: bool = False

    @model_validator(mode="after")
    def _consistent(self) -> ZoneSpec:
        for index, rail in enumerate(self.rails):
            if rail.unit >= self.units:
                raise SpecRule(f"rails[{index}].unit", f"liegt außerhalb der Zone ({self.units} Raster)")
        if (self.meter_type is None) != (self.meter_places == 0):
            raise SpecRule("meter_type", "nur und genau dann setzen, wenn die Zone Zählerplätze hat")
        if self.meter_places and self.type != "ZF":
            raise SpecRule("meter_places", "Zählerplätze gibt es nur im Zählerfeld (ZF)")
        # The electrical reading order ranks rails by zone type; ZF and COVER
        # have no rank because they never carry a rail (§2.3).
        if self.type in ("ZF", "COVER") and self.rails:
            raise SpecRule("rails", "ein Zählerfeld oder eine Abdeckung hat keine Hutschiene")
        if self.type == "SAS" and [rail.mount for rail in self.rails] != ["busbar"]:
            raise SpecRule("rails", "eine Sammelschienenzone hat genau eine Schiene mit mount „busbar“")
        if self.type == "NAR" and not any(rail.mount == "busbar" for rail in self.rails):
            raise SpecRule("rails", "ein NAR braucht mindestens eine Schiene mit mount „busbar“")
        return self


class FittingDevice(_Spec):
    kind: DeviceKind
    rail: RailKey
    te: Annotated[int, _between(1, 24)]
    poles: Annotated[int, _between(1, 4)]
    rating: str = Field(default="", max_length=32)
    width_mm: float | None = Field(default=None, gt=0, le=600)


class FittingSpec(_Spec):
    key: RailKey
    label: str = Field(min_length=1, max_length=96)
    article_no: str | None = Field(default=None, max_length=40)
    removable: bool
    device: FittingDevice | None = None
    verified: bool
    note: str = Field(default="", max_length=300)
    retired: bool = False


class AccessorySpec(_Spec):
    article_no: str = Field(min_length=1, max_length=40)
    label: str = Field(min_length=1, max_length=160)
    qty: Annotated[int, _between(1, 99)]
    verified: bool = True


class _CatalogSpec(_Spec):
    code: CatalogCode
    article_no: str = Field(min_length=1, max_length=40)
    manufacturer: str = Field(default="Hager", min_length=1, max_length=64)
    series: str = Field(default="univers Z", max_length=64)
    name: str = Field(min_length=1, max_length=160)
    accessories: list[AccessorySpec] = Field(default_factory=list, max_length=20)
    verified: bool
    # What is unchecked, one fact per line; may also list single assumptions
    # on a verified entry. The first line is what the finding quotes.
    unverified: list[UnverifiedNote] = Field(default_factory=list, max_length=12)
    source_url: SourceUrl | None = None
    note: str = Field(default="", max_length=500)

    @model_validator(mode="after")
    def _says_what_is_unchecked(self) -> _CatalogSpec:
        if not self.verified and not self.unverified:
            raise SpecRule("unverified", "sagt bei „ungeprüft“, was nicht geprüft ist")
        return self


class EnclosureSpec(_CatalogSpec):
    height_mm: Millimetres
    width_mm: Millimetres
    depth_mm: Millimetres
    fields: Annotated[int, _between(1, 9)]
    door_leaves: Annotated[int, _between(1, 4)]
    field_width_mm: Millimetres = 250
    unit_mm: Millimetres = 150
    margin_mm: Annotated[int, _between(0, 1000)] = 25
    units_per_field: Annotated[int, _between(1, 19)]
    mounting: Literal["surface"] = "surface"
    ip: str = Field(max_length=8)
    door: str = Field(max_length=64)


class ModuleSpec(_CatalogSpec):
    family: Family
    # 1050 → 1100 mm cabinets, 1350 → 1400 mm; null = fits any.
    field_height_mm: Millimetres | None
    width_fields: Annotated[int, _between(1, 3)]
    height_units: Annotated[int, _between(1, 9)]
    wiring_mm2: Literal[10, 16] | None = None
    zones: list[ZoneSpec] = Field(max_length=12)
    fittings: list[FittingSpec] = Field(default_factory=list, max_length=MAX_FITTINGS_PER_MODULE)
    free_place_cover: AccessorySpec | None = None
    # R4-12: a reserve meter field is never the §14a carrier while a meter
    # field in use exists. Not frozen; the admin form leaves it alone.
    reserve_field: bool = False

    @model_validator(mode="after")
    def _fits_together(self) -> ModuleSpec:
        _check_zones_inside(self)
        _check_unique_keys(self)
        _check_fitting_devices(self)
        _check_storable(self)
        if self.family in METER_FAMILIES:
            types = [zone.type for zone in self.zones]
            metered = [zone for zone in self.zones if zone.type == "ZF" and zone.meter_places > 0]
            if types.count("NAR") != 1 or not metered or "AAR" not in types:
                raise SpecRule("zones", "ein Zählerfeld braucht genau einen NAR, ein ZF mit Zählerplätzen und einen AAR")
        return self


def _check_zones_inside(spec: ModuleSpec) -> None:
    for index, zone in enumerate(spec.zones):
        if zone.field >= spec.width_fields:
            raise SpecRule(f"zones[{index}].field", f"liegt außerhalb des Moduls ({spec.width_fields} Feld/Felder)")
        if zone.unit + zone.units > spec.height_units:
            raise SpecRule(f"zones[{index}]", f"ragt über die Modulhöhe ({spec.height_units} Raster)")
        for earlier in range(index):
            other = spec.zones[earlier]
            if other.field == zone.field and zone.unit < other.unit + other.units and other.unit < zone.unit + zone.units:
                raise SpecRule(f"zones[{index}]", f"überlappt zones[{earlier}]")


def _check_unique_keys(spec: ModuleSpec) -> None:
    # Separate namespaces: geometry ids are zone:/rail:/… prefixed, and a
    # fitting key is what supplied_by and removed_fittings name.
    zone_keys: set[str] = set()
    rail_keys: set[str] = set()
    for index, zone in enumerate(spec.zones):
        if zone.key in zone_keys:
            raise SpecRule(f"zones[{index}].key", f"„{zone.key}“ gibt es schon")
        zone_keys.add(zone.key)
        for rail_index, rail in enumerate(zone.rails):
            if rail.key in rail_keys:
                raise SpecRule(f"zones[{index}].rails[{rail_index}].key", f"„{rail.key}“ gibt es schon")
            rail_keys.add(rail.key)
    fitting_keys: set[str] = set()
    for index, fitting in enumerate(spec.fittings):
        if fitting.key in fitting_keys:
            raise SpecRule(f"fittings[{index}].key", f"„{fitting.key}“ gibt es schon")
        fitting_keys.add(fitting.key)


def _check_fitting_devices(spec: ModuleSpec) -> None:
    rails = {rail.key: rail for zone in spec.zones for rail in zone.rails}
    for index, fitting in enumerate(spec.fittings):
        if fitting.device is None:
            continue
        rail = rails.get(fitting.device.rail)
        if rail is None:
            raise SpecRule(f"fittings[{index}].device.rail", f"Hutschiene „{fitting.device.rail}“ gibt es nicht")
        if rail.retired:
            raise SpecRule(f"fittings[{index}].device.rail", f"Hutschiene „{rail.key}“ ist ausgemustert")
        if not fitting.removable:
            # Deleting the device is how a device fitting gets removed (D5).
            raise SpecRule(f"fittings[{index}].removable", "ein vorbestücktes Gerät ist entfernbar (true)")


def _check_storable(spec: ModuleSpec) -> None:
    # The per-zone caps allow 12 × 9 rails; a placed module stores at most
    # MAX_RAILS_PER_MODULE rail links and one meter entry per place
    # (EnclosureModule). A spec past those would place fine and then fail
    # every autosave once its 17th rail got a row.
    rails = sum(len(zone.rails) for zone in spec.zones)
    if rails > MAX_RAILS_PER_MODULE:
        raise SpecRule("zones", f"höchstens {MAX_RAILS_PER_MODULE} Hutschienen je Modul (hier {rails})")
    places = sum(zone.meter_places for zone in spec.zones)
    if places > MAX_METERS_PER_MODULE:
        raise SpecRule("zones", f"höchstens {MAX_METERS_PER_MODULE} Zählerplätze je Modul (hier {places})")


SPEC_MODELS: dict[str, type[EnclosureSpec] | type[ModuleSpec]] = {"enclosure": EnclosureSpec, "module": ModuleSpec}


# ── API in/out (§7) ──────────────────────────────────────────────────────────


class CatalogEntryIn(BaseModel):
    """Built by ``parse_catalog_entry`` from the raw body, never by FastAPI:
    the router checks the body's size before anything parses it."""

    entry_type: EntryType
    spec: EnclosureSpec | ModuleSpec


class CatalogArchiveIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    archived: bool


class CatalogEntryOut(BaseModel):
    code: str
    entry_type: EntryType
    source: Literal["builtin", "custom", "override"]
    archived: bool
    invalid: bool
    # The validated spec as JSON; null for an entry whose stored spec no
    # longer validates (still a known code, drawn as a placeholder).
    spec: dict[str, Any] | None
    article: PanelMaterialArticleOut | None = None
    article_source: Literal["mapping", "auto"] | None = None
    stock_available: int = 0
    recent_count: int = 0
    last_used_at: datetime | None = None
    used_by_plans: int = 0


class UncataloguedArticleOut(BaseModel):
    article: PanelMaterialArticleOut
    code_guess: str


class EnclosureCatalogOut(BaseModel):
    enclosures: list[CatalogEntryOut] = Field(default_factory=list)
    modules: list[CatalogEntryOut] = Field(default_factory=list)
    can_manage: bool = False
    uncatalogued: list[UncataloguedArticleOut] = Field(default_factory=list)


# ── Parsing an admin's entry, with German errors ─────────────────────────────


class CatalogInputError(ValueError):
    """``Aufbau ungültig: {path} — {message}`` — the 422 text of the admin form."""

    def __init__(self, path: str, message: str) -> None:
        self.path = path
        self.message = message
        super().__init__(f"Aufbau ungültig: {path} — {message}" if path else f"Aufbau ungültig: {message}")


def parse_catalog_entry(raw: Any) -> CatalogEntryIn:
    if not isinstance(raw, dict):
        raise CatalogInputError("", "erwartet ein Objekt mit entry_type und spec")
    entry_type = raw.get("entry_type")
    if entry_type not in SPEC_MODELS:
        raise CatalogInputError("entry_type", "muss „enclosure“ oder „module“ sein")
    unknown = sorted(set(raw) - {"entry_type", "spec"})
    if unknown:
        raise CatalogInputError(unknown[0], "ist kein bekanntes Feld")
    spec = raw.get("spec")
    if not isinstance(spec, dict):
        raise CatalogInputError("spec", "muss ein Objekt sein")
    try:
        parsed = SPEC_MODELS[entry_type].model_validate(spec)
    except ValidationError as exc:
        raise german_error(exc) from None
    return CatalogEntryIn(entry_type=entry_type, spec=parsed)


def german_error(exc: ValidationError) -> CatalogInputError:
    """The first error of a spec validation, as path + short German message."""
    error = exc.errors(include_url=False)[0]
    path = json_path(error.get("loc", ()))
    rule = (error.get("ctx") or {}).get("error")
    if isinstance(rule, SpecRule):
        return CatalogInputError(_join_path(path, rule.path), rule.message)
    return CatalogInputError(path, _german_message(error))


def json_path(loc: tuple[Any, ...] | list[Any]) -> str:
    """('zones', 2, 'rails', 0, 'ple') → 'zones[2].rails[0].ple'."""
    out = ""
    for part in loc:
        out += f"[{part}]" if isinstance(part, int) else (f".{part}" if out else str(part))
    return out


def _join_path(outer: str, inner: str) -> str:
    if not inner:
        return outer
    if not outer:
        return inner
    return f"{outer}{inner}" if inner.startswith("[") else f"{outer}.{inner}"


_MESSAGES: dict[str, str] = {
    "missing": "fehlt",
    "extra_forbidden": "ist kein bekanntes Feld",
    "string_type": "muss Text sein",
    "string_too_long": "höchstens {max_length} Zeichen",
    "int_type": "muss eine ganze Zahl sein",
    "int_parsing": "muss eine ganze Zahl sein",
    "int_from_float": "muss eine ganze Zahl sein",
    "float_type": "muss eine Zahl sein",
    "float_parsing": "muss eine Zahl sein",
    "bool_type": "muss true oder false sein",
    "bool_parsing": "muss true oder false sein",
    "list_type": "muss eine Liste sein",
    "dict_type": "muss ein Objekt sein",
    "model_type": "muss ein Objekt sein",
    "model_attributes_type": "muss ein Objekt sein",
    "too_long": "höchstens {max_length} Einträge",
    "too_short": "mindestens {min_length} Einträge",
    "greater_than": "muss größer als {gt} sein",
    "greater_than_equal": "muss mindestens {ge} sein",
    "less_than": "muss kleiner als {lt} sein",
    "less_than_equal": "darf höchstens {le} sein",
}


def _german_message(error: dict[str, Any]) -> str:
    kind = str(error.get("type", ""))
    ctx = error.get("ctx") or {}
    if kind == "string_too_short":
        return "darf nicht leer sein" if ctx.get("min_length") == 1 else "mindestens {min_length} Zeichen".format(**ctx)
    if kind == "literal_error":
        values = re.findall(r"'([^']*)'|(\d+)", str(ctx.get("expected", "")))
        return "muss einer der Werte sein: " + ", ".join(text or number for text, number in values)
    if kind == "value_error":
        return str(ctx.get("error") or "ungültiger Wert")
    template = _MESSAGES.get(kind)
    if template is None:
        return "ungültiger Wert"
    try:
        return template.format(**ctx)
    except (KeyError, IndexError):
        return "ungültiger Wert"
