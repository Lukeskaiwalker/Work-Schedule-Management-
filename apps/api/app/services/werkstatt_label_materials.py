"""Material profiles for the Werkstatt label printer.

The printer prints on very different stock — 99 × 44 mm type labels down to
Ø 3.2 mm heat-shrink tube — and each material changes the sheet geometry
(`^W`/`^Q`), what a label can carry (a 6 mm label cannot hold a scannable
DataMatrix), and sometimes the heat. A *profile* captures that; the admin UI
stores them in the same runtime-settings key as the printer address, and the
ACTIVE profile mirrors what is physically loaded — the printer can sense gaps
but not identity, so this selection is the software's only source of truth.

Six workshop materials ship as builtins with dimensions verified against the
WAGO catalogue (2026-08). Builtins can be edited (measured reality beats the
catalogue) but not removed: a deleted profile whose stock is still on the
shelf would strand the next person at a "unknown material" error. Custom
profiles are one form entry — the printer does not care whose brand the roll
is.

Width is ACROSS the print head (the label's short side on this printer),
length is the feed direction; ``length_mm = None`` means continuous stock
whose per-label length the renderer computes from content.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, replace
from typing import Any

from sqlalchemy.orm import Session

from app.services.runtime_settings import (
    WERKSTATT_LABEL_PRINTER_KEY,
    get_runtime_setting,
    set_runtime_setting,
)

# Printer envelope (WAGO 258-51xx datasheet): 47 mm printable width,
# 5–762 mm feed length.
HEAD_WIDTH_MM = 47.0
MIN_LENGTH_MM = 5.0
MAX_LENGTH_MM = 762.0

TIER_VOLL = "voll"
TIER_KOMPAKT = "kompakt"
TIER_MINI = "mini"


@dataclass(frozen=True)
class MaterialProfile:
    id: str
    name: str
    part_no: str
    width_mm: float  # across the print head
    length_mm: float | None  # feed direction; None = continuous
    gap_mm: float = 3.0
    x_offset_mm: float = 2.0  # print origin sits before the label's left edge
    darkness: int | None = None  # ^H override; heat-shrink wants less heat
    builtin: bool = False

    @property
    def continuous(self) -> bool:
        return self.length_mm is None

    @property
    def tier(self) -> str:
        """What this stock has room to carry.

        voll    — the full machine label (logo, footer, serial, DataMatrix)
        kompakt — DataMatrix + number + name
        mini    — number/text only; a DataMatrix under ~6 mm does not scan
        """
        if not self.continuous and self.length_mm >= 80 and self.width_mm >= 36:
            return TIER_VOLL
        if self.width_mm >= 12 and (self.continuous or (self.length_mm or 0) >= 30):
            return TIER_KOMPAKT
        return TIER_MINI


DEFAULT_ACTIVE_ID = "wago-210-804"

DEFAULT_MATERIALS: tuple[MaterialProfile, ...] = (
    MaterialProfile(
        id="wago-210-804",
        name="Typenschilder 99 × 44 (silber)",
        part_no="WAGO 210-804",
        width_mm=44,
        length_mm=99,
        builtin=True,
    ),
    MaterialProfile(
        id="wago-210-824",
        name="Sicherheitsetiketten 99 × 44 (silber)",
        part_no="WAGO 210-824",
        width_mm=44,
        length_mm=99,
        builtin=True,
    ),
    MaterialProfile(
        id="wago-210-812",
        name="Typenschilder 50 × 25 (silber)",
        part_no="WAGO 210-812",
        width_mm=25,
        length_mm=50,
        builtin=True,
    ),
    MaterialProfile(
        id="wago-210-805",
        name="Etiketten 15 × 6 (weiß)",
        part_no="WAGO 210-805",
        width_mm=6,
        length_mm=15,
        builtin=True,
    ),
    MaterialProfile(
        id="wago-211-501",
        # Ø 3.2 mm tube lies ~5 mm flat under the head.
        name="Schrumpfschlauch Ø 3,2 (weiß, Endlos)",
        part_no="WAGO 211-501",
        width_mm=5,
        length_mm=None,
        builtin=True,
    ),
    MaterialProfile(
        id="wago-2009-110",
        name="Beschriftungsstreifen 11 mm (TopJob, Endlos)",
        part_no="WAGO 2009-110",
        width_mm=11,
        length_mm=None,
        builtin=True,
    ),
)

_BUILTIN_IDS = {profile.id: profile for profile in DEFAULT_MATERIALS}


class MaterialValidationError(ValueError):
    """Admin payload describes materials the printer cannot have."""


def _profile_from_dict(raw: dict[str, Any]) -> MaterialProfile:
    length = raw.get("length_mm")
    profile_id = str(raw.get("id") or "").strip()
    return MaterialProfile(
        id=profile_id,
        name=str(raw.get("name") or "").strip(),
        part_no=str(raw.get("part_no") or "").strip(),
        width_mm=float(raw.get("width_mm")),
        length_mm=None if length in (None, "", 0) else float(length),
        gap_mm=float(raw.get("gap_mm", 3.0)),
        x_offset_mm=float(raw.get("x_offset_mm", 2.0)),
        darkness=None if raw.get("darkness") in (None, "") else int(raw["darkness"]),
        # The stored/user value cannot mint builtins — identity does.
        builtin=profile_id in _BUILTIN_IDS,
    )


def _materials_from_stored(raw: Any) -> list[MaterialProfile]:
    """Stored list → profiles; malformed entries drop, missing builtins heal."""
    profiles: list[MaterialProfile] = []
    seen: set[str] = set()
    if isinstance(raw, list):
        for entry in raw:
            if not isinstance(entry, dict):
                continue
            try:
                profile = _profile_from_dict(entry)
            except (TypeError, ValueError):
                continue
            if not profile.id or profile.id in seen:
                continue
            profiles.append(profile)
            seen.add(profile.id)
    for builtin in DEFAULT_MATERIALS:
        if builtin.id not in seen:
            profiles.append(builtin)
    return profiles


def get_label_printer_config(db: Session) -> dict[str, Any]:
    """Effective printer config: address, all materials, active selection.

    Defensive like every runtime-settings reader: malformed JSON reads as
    defaults rather than raising, so a corrupt setting can never take the
    Werkstatt register down with it.
    """
    raw = get_runtime_setting(db, WERKSTATT_LABEL_PRINTER_KEY)
    stored: dict[str, Any] = {}
    if raw:
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, dict):
                stored = parsed
        except Exception:
            stored = {}

    materials = _materials_from_stored(stored.get("materials"))
    active_id = str(stored.get("active_material_id") or DEFAULT_ACTIVE_ID)
    if active_id not in {profile.id for profile in materials}:
        active_id = DEFAULT_ACTIVE_ID

    host = str(stored.get("host") or "").strip()
    try:
        port = int(stored.get("port") or 9100)
    except (TypeError, ValueError):
        port = 9100

    return {
        "host": host,
        "port": port,
        "materials": materials,
        "active_material_id": active_id,
    }


def active_material(db: Session) -> MaterialProfile:
    config = get_label_printer_config(db)
    by_id = {profile.id: profile for profile in config["materials"]}
    return by_id[config["active_material_id"]]


def validate_materials(
    materials: list[MaterialProfile], active_material_id: str
) -> None:
    """Raise :class:`MaterialValidationError` (German, user-facing) on nonsense."""
    ids = [profile.id for profile in materials]
    if len(ids) != len(set(ids)):
        raise MaterialValidationError("Material-IDs müssen eindeutig sein")
    for builtin_id in _BUILTIN_IDS:
        if builtin_id not in ids:
            raise MaterialValidationError(
                f"Mitgeliefertes Material {builtin_id} kann nicht entfernt werden"
            )
    if active_material_id not in ids:
        raise MaterialValidationError(f"Unbekanntes Material: {active_material_id}")
    for profile in materials:
        label = profile.name or profile.id
        if not profile.id:
            raise MaterialValidationError("Material ohne ID")
        if not (4 <= profile.width_mm <= HEAD_WIDTH_MM):
            raise MaterialValidationError(
                f"{label}: Breite muss zwischen 4 und {HEAD_WIDTH_MM:g} mm liegen"
            )
        if profile.length_mm is not None and not (
            MIN_LENGTH_MM <= profile.length_mm <= MAX_LENGTH_MM
        ):
            raise MaterialValidationError(
                f"{label}: Länge muss zwischen {MIN_LENGTH_MM:g} und {MAX_LENGTH_MM:g} mm liegen"
            )
        if not (0 <= profile.gap_mm <= 10):
            raise MaterialValidationError(f"{label}: Spalt muss 0–10 mm sein")
        if profile.darkness is not None and not (0 <= profile.darkness <= 19):
            raise MaterialValidationError(f"{label}: Schwärzung muss 0–19 sein")


def set_label_printer_config(
    db: Session,
    *,
    host: str,
    port: int,
    materials: list[MaterialProfile],
    active_material_id: str,
) -> None:
    """Validate and persist the full config in one write."""
    validate_materials(materials, active_material_id)
    payload = {
        "host": (host or "").strip(),
        "port": int(port),
        "active_material_id": active_material_id,
        "materials": [
            {
                "id": profile.id,
                "name": profile.name,
                "part_no": profile.part_no,
                "width_mm": profile.width_mm,
                "length_mm": profile.length_mm,
                "gap_mm": profile.gap_mm,
                "x_offset_mm": profile.x_offset_mm,
                "darkness": profile.darkness,
            }
            for profile in materials
        ],
    }
    set_runtime_setting(db, WERKSTATT_LABEL_PRINTER_KEY, json.dumps(payload))


def normalize_incoming_material(raw: dict[str, Any]) -> MaterialProfile:
    """Admin-payload dict → profile; builtins keep their flag by identity."""
    try:
        profile = _profile_from_dict(raw)
    except (TypeError, ValueError) as exc:
        raise MaterialValidationError(f"Ungültiges Material: {exc}") from exc
    builtin = _BUILTIN_IDS.get(profile.id)
    if builtin is not None:
        return replace(profile, builtin=True)
    return profile
