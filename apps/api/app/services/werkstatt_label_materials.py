"""Material profiles for the Werkstatt label printer — storage and rules.

The printer prints on very different stock — 99 × 44 mm type labels down to
Ø 3.2 mm heat-shrink tube — and each material changes the sheet geometry
(`^W`/`^Q`), what a label can carry (a 6 mm label cannot hold a scannable
DataMatrix), the sensor the printer must use and where its carriage sits. A
*profile* captures that (``werkstatt_label_profile``); the admin UI stores
them in the same runtime-settings key as the printer address, and the ACTIVE
profile mirrors what is physically loaded — the printer can sense gaps but
not identity, so this selection is the software's only source of truth.

Seven workshop materials ship as builtins (``werkstatt_label_builtins``): print
geometry from the WAGO catalogue, sensor mode and the carriage's reading on
the housing scale from WAGO's handling sheets transferred to the owner's
printer, roller 258-5006 for all seven. The 210-805 is printed one lane 6 × 15
while its physical roll (``web``) is two lanes — guide and verify use the
roll, the renderers the print geometry. Builtins can be edited (measured
reality beats the catalogue) but not removed: a deleted profile whose stock
is still on the shelf would strand the next person at an "unknown material"
error. Custom profiles are one form entry.

Storage format 2 keeps builtins as OVERRIDES only — the keys an admin
changed, nothing else — so a corrected default in code reaches every install
that did not touch that field. Format-1 blobs (all keys of every builtin
stored) are migrated at read time against a frozen copy of the old defaults.
Every write carries a revision; ``update_config`` is the compare-and-set.

Width is ACROSS the print head (the label's short side on this printer),
length is the feed direction; ``length_mm = None`` means continuous stock
whose per-label length the renderer computes from content.
"""

from __future__ import annotations

import json
import math
from dataclasses import fields as dataclass_fields
from dataclasses import replace
from typing import Any, Callable

from sqlalchemy.orm import Session

from app.services.runtime_settings import (
    WERKSTATT_LABEL_PRINTER_KEY,
    get_runtime_setting,
    get_runtime_setting_for_update,
    set_runtime_setting,
)
from app.services.werkstatt_label_builtins import (
    BUILTIN_IDS,
    DEFAULT_ACTIVE_ID,
    DEFAULT_MATERIALS,
    LEGACY_V1_BUILTIN_VALUES,
)
from app.services.werkstatt_label_errors import (
    LabelRequestRefused,
    MaterialValidationError,
    PrinterSettingsValidationError,
    StaleRevision,
)
from app.services.werkstatt_label_profile import (
    CODE_BASELINE,
    FEED_PATHS,
    GUIDE_SETTINGS,
    HEAD_WIDTH_MM,
    MAX_LENGTH_MM,
    MIN_LENGTH_MM,
    NULLABLE_FIELDS,
    ROLLERS,
    SENSOR_MODES,
    SENSOR_SCALE_MAX,
    SENSOR_SCALE_MIN,
    STORED_FIELDS,
    TIER_KOMPAKT,
    TIER_MINI,
    TIER_VOLL,
    WEB_SOURCES,
    MaterialProfile,
    MediaWeb,
    resolve_job_settings,
    web_to_dict,
)

# Re-exported: these names were importable from here before the split.
__all__ = [
    "DEFAULT_ACTIVE_ID", "DEFAULT_MATERIALS", "HEAD_WIDTH_MM", "MAX_LENGTH_MM",
    "MIN_LENGTH_MM", "MaterialProfile", "MaterialValidationError", "StaleRevision",
    "TIER_KOMPAKT", "TIER_MINI", "TIER_VOLL", "active_material",
    "get_label_printer_config", "material_by_id", "normalize_incoming_material",
    "set_label_printer_config", "update_config", "validate_materials",
    "write_label_printer_config",
]

CONFIG_FORMAT = 2

_BUILTINS = {profile.id: profile for profile in DEFAULT_MATERIALS}

_INVALID = object()
_FLOAT_TOLERANCE = 1e-9


# ── Value parsing (read side: malformed → default, never raise) ────────────


def _float(raw: Any, lo: float | None = None, hi: float | None = None) -> Any:
    if isinstance(raw, bool) or not isinstance(raw, (int, float, str)):
        return _INVALID
    try:
        value = float(raw)
    except ValueError:
        return _INVALID
    if not math.isfinite(value):
        return _INVALID
    if (lo is not None and value < lo) or (hi is not None and value > hi):
        return _INVALID
    return value


def _int(raw: Any, lo: int, hi: int) -> Any:
    value = _float(raw, lo, hi)
    if value is _INVALID or value != int(value):
        return _INVALID
    return int(value)


def _nullable(parser: Callable[[Any], Any]) -> Callable[[Any], Any]:
    return lambda raw: None if raw is None or raw == "" else parser(raw)


def _enum(options: tuple[str, ...]) -> Callable[[Any], Any]:
    return lambda raw: raw if isinstance(raw, str) and raw in options else _INVALID


def _text(raw: Any) -> Any:
    return raw.strip() if isinstance(raw, str) else _INVALID


def _bool(raw: Any) -> Any:
    return raw if isinstance(raw, bool) else _INVALID


def _length(raw: Any) -> Any:
    if raw is None or raw == "" or raw == 0:
        return None
    return _float(raw, MIN_LENGTH_MM, MAX_LENGTH_MM)


def _scale(raw: Any) -> Any:
    value = _float(raw)
    if value is _INVALID:
        return _INVALID
    value = round(value, 1)
    return value if SENSOR_SCALE_MIN <= value <= SENSOR_SCALE_MAX else _INVALID


def _web(raw: Any) -> Any:
    """A stored ``web`` must parse completely, else the default is used."""
    if not isinstance(raw, dict):
        return _INVALID
    parsers = {
        "lanes": lambda v: _int(v, 1, 4),
        "label_across_mm": _nullable(lambda v: _float(v, 0.1, 60)),
        "label_along_mm": _nullable(lambda v: _float(v, 0.1, MAX_LENGTH_MM)),
        "lane_gap_mm": lambda v: _float(v, 0, 10),
        "liner_width_mm": _nullable(lambda v: _float(v, 3, 60)),
        "source": _enum(WEB_SOURCES),
    }
    values: dict[str, Any] = {}
    for key, parser in parsers.items():
        if key not in raw:
            continue
        parsed = parser(raw[key])
        if parsed is _INVALID:
            return _INVALID
        values[key] = parsed
    return MediaWeb(**values)


_FIELD_PARSERS: dict[str, Callable[[Any], Any]] = {
    "name": _text,
    "part_no": _text,
    "width_mm": lambda v: _float(v, 4, HEAD_WIDTH_MM),
    "length_mm": _length,
    "gap_mm": lambda v: _float(v, 0, 10),
    "x_offset_mm": lambda v: _float(v, -5, 10),
    "darkness": _nullable(lambda v: _int(v, 0, 19)),
    "across_offset_mm": lambda v: _float(v, -5, 5),
    "speed_ips": _nullable(lambda v: _int(v, 2, 4)),
    "stop_mm": _nullable(lambda v: _int(v, 0, 40)),
    "mark_width_mm": _nullable(lambda v: _float(v, 1, 10)),
    "mark_offset_mm": lambda v: _float(v, 0, 50),
    "mark_inside": _bool,
    "sensor_mode": _enum(SENSOR_MODES),
    "sensor_scale": _scale,
    "guide": _enum(GUIDE_SETTINGS),
    "feed_path": _enum(FEED_PATHS),
    "roller": _enum(ROLLERS),
    "web": _web,
}


def _same(a: Any, b: Any) -> bool:
    if isinstance(a, bool) or isinstance(b, bool):
        return a is b
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return abs(float(a) - float(b)) < _FLOAT_TOLERANCE
    return a == b


def _builtin_from_overrides(entry: dict[str, Any], *, legacy: bool) -> tuple[MaterialProfile, frozenset[str]]:
    base = _BUILTINS[entry["id"]]
    raw = {key: value for key, value in entry.items() if key in _FIELD_PARSERS}
    if legacy:
        old = LEGACY_V1_BUILTIN_VALUES.get(base.id, {})
        raw = {key: value for key, value in raw.items() if not (key in old and _same(value, old[key]))}
    overrides: dict[str, Any] = {}
    for key, value in raw.items():
        parsed = _FIELD_PARSERS[key](value)
        if parsed is not _INVALID:
            overrides[key] = parsed
    profile = replace(base, **overrides)
    changed = frozenset(key for key, value in overrides.items() if not _same(value, getattr(base, key)))
    return profile, changed


def _custom_from_dict(entry: dict[str, Any], profile_id: str) -> MaterialProfile | None:
    width = _float(entry.get("width_mm"))
    if width is _INVALID or width <= 0:
        return None  # today's rule: an entry without a usable width is dropped
    values: dict[str, Any] = {}
    for key, parser in _FIELD_PARSERS.items():
        if key == "width_mm" or key not in entry:
            continue
        parsed = parser(entry[key])
        if parsed is not _INVALID:
            values[key] = parsed
        elif key == "length_mm":
            # A custom length has no default to fall back to: a number out of
            # range is kept (the next write names it), anything else reads
            # as continuous.
            loose = _float(entry[key])
            values[key] = None if loose is _INVALID else loose
    return MaterialProfile(
        id=profile_id,
        name=values.pop("name", "") or profile_id,
        part_no=values.pop("part_no", ""),
        width_mm=width,
        length_mm=values.pop("length_mm", None),
        **values,
    )


def _materials_from_stored(raw: Any, *, legacy: bool) -> tuple[list[MaterialProfile], dict[str, frozenset[str]]]:
    """Stored list → profiles; malformed values fall back, missing builtins heal."""
    profiles: list[MaterialProfile] = []
    overrides: dict[str, frozenset[str]] = {}
    seen: set[str] = set()
    for entry in raw if isinstance(raw, list) else []:
        if not isinstance(entry, dict):
            continue
        profile_id = str(entry.get("id") or "").strip()
        if not profile_id or profile_id in seen:
            continue
        if profile_id in BUILTIN_IDS:
            profile, changed = _builtin_from_overrides({**entry, "id": profile_id}, legacy=legacy)
        else:
            custom = _custom_from_dict(entry, profile_id)
            if custom is None:
                continue
            profile, changed = custom, frozenset()
        profiles.append(profile)
        overrides[profile_id] = changed
        seen.add(profile_id)
    for builtin in DEFAULT_MATERIALS:
        if builtin.id not in seen:
            profiles.append(builtin)
            overrides[builtin.id] = frozenset()
    return profiles, overrides


def _baseline_overrides(raw: Any) -> dict[str, int]:
    if not isinstance(raw, dict):
        return {}
    ranges = {"darkness": (0, 19), "speed_ips": (2, 4), "stop_mm": (0, 40)}
    out: dict[str, int] = {}
    for key, (lo, hi) in ranges.items():
        if key in raw:
            value = _int(raw[key], lo, hi)
            if value is not _INVALID and value != getattr(CODE_BASELINE, key):
                out[key] = value
    return out


def _parse_blob(raw: str | None) -> dict[str, Any]:
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except Exception:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _config_from_stored(stored: dict[str, Any]) -> dict[str, Any]:
    legacy = stored.get("format") != CONFIG_FORMAT
    materials, overrides = _materials_from_stored(stored.get("materials"), legacy=legacy)
    baseline_overrides = _baseline_overrides(stored.get("baseline"))
    baseline = replace(CODE_BASELINE, **baseline_overrides)
    materials = [replace(profile, job=resolve_job_settings(profile, baseline)) for profile in materials]

    active_id = str(stored.get("active_material_id") or DEFAULT_ACTIVE_ID)
    if active_id not in {profile.id for profile in materials}:
        active_id = DEFAULT_ACTIVE_ID
    host = str(stored.get("host") or "").strip()
    port = _int(stored.get("port") or 9100, 1, 65535)
    revision = _int(stored.get("revision", 0), 0, 2**31 - 1)
    row_offset = _int(stored.get("row_offset_dots"), -100, 100) if stored.get("row_offset_dots") is not None else None
    staff = stored.get("label_calibration_staff_enabled")
    return {
        "host": host,
        "port": 9100 if port is _INVALID else port,
        "materials": materials,
        "active_material_id": active_id,
        "revision": 0 if revision is _INVALID else revision,
        "baseline": baseline,
        "baseline_overrides": baseline_overrides,
        "row_offset_dots": None if row_offset is _INVALID else row_offset,
        "label_calibration_staff_enabled": staff if isinstance(staff, bool) else False,
        "overrides": overrides,
    }


def get_label_printer_config(db: Session) -> dict[str, Any]:
    """Effective printer config: address, all materials, active selection.

    Defensive like every runtime-settings reader: malformed JSON reads as
    defaults rather than raising, so a corrupt setting can never take the
    Werkstatt register down with it.
    """
    return _config_from_stored(_parse_blob(get_runtime_setting(db, WERKSTATT_LABEL_PRINTER_KEY)))


def active_material(db: Session) -> MaterialProfile:
    config = get_label_printer_config(db)
    by_id = {profile.id: profile for profile in config["materials"]}
    return by_id[config["active_material_id"]]


def material_by_id(db: Session, material_id: str) -> MaterialProfile:
    """A specific stock, regardless of which one is currently active.

    For jobs that only make sense on one medium — a BMK strip is always the
    2009-110, whatever nameplate stock is selected for machine labels — the
    caller names the profile and the layout is computed for it. The operator
    still has to load that strip; the response says which one.
    """
    config = get_label_printer_config(db)
    by_id = {profile.id: profile for profile in config["materials"]}
    try:
        return by_id[material_id]
    except KeyError as exc:
        raise MaterialValidationError(f"Unbekanntes Material: {material_id}") from exc


# ── Validation (write side: German, raises) ────────────────────────────────


def _check(condition: bool, message: str) -> None:
    if not condition:
        raise MaterialValidationError(message)


def _validate_web(profile: MaterialProfile, label: str) -> None:
    web = profile.web
    invalid = f"{label}: Rollenmaße ungültig"
    _check(isinstance(web.lanes, int) and 1 <= web.lanes <= 4, invalid)
    _check(0 <= web.lane_gap_mm <= 10, invalid)
    _check(web.liner_width_mm is None or 3 <= web.liner_width_mm <= 60, invalid)
    _check(web.label_across_mm is None or 0 < web.label_across_mm <= 60, invalid)
    _check(web.label_along_mm is None or 0 < web.label_along_mm <= MAX_LENGTH_MM, invalid)
    _check(web.source in WEB_SOURCES, invalid)
    if web.liner_width_mm is not None:
        across = web.label_across_mm if web.label_across_mm is not None else profile.width_mm
        side_by_side = web.lanes * across + (web.lanes - 1) * web.lane_gap_mm
        _check(
            web.liner_width_mm + _FLOAT_TOLERANCE >= side_by_side,
            f"{label}: Trägerbreite ist kleiner als die Etiketten nebeneinander",
        )


def _validate_profile(profile: MaterialProfile) -> None:
    label = profile.name or profile.id
    _check(bool(profile.id), "Material ohne ID")
    _check(
        1 <= len(profile.id) <= 40 and 1 <= len(profile.name) <= 60 and len(profile.part_no) <= 40,
        f"{label}: Kennung 1–40, Name 1–60 und Artikelnummer bis 40 Zeichen",
    )
    _check(4 <= profile.width_mm <= HEAD_WIDTH_MM, f"{label}: Breite muss zwischen 4 und {HEAD_WIDTH_MM:g} mm liegen")
    _check(
        profile.length_mm is None or MIN_LENGTH_MM <= profile.length_mm <= MAX_LENGTH_MM,
        f"{label}: Länge muss zwischen {MIN_LENGTH_MM:g} und {MAX_LENGTH_MM:g} mm liegen",
    )
    _check(0 <= profile.gap_mm <= 10, f"{label}: Spalt muss 0–10 mm sein")
    _check(-5 <= profile.x_offset_mm <= 10, f"{label}: Versatz Vorschub muss zwischen −5 und 10 mm liegen")
    _check(-5 <= profile.across_offset_mm <= 5, f"{label}: Versatz quer muss zwischen −5 und 5 mm liegen")
    _check(profile.darkness is None or 0 <= profile.darkness <= 19, f"{label}: Schwärzung muss 0–19 sein")
    _check(profile.speed_ips is None or 2 <= profile.speed_ips <= 4, f"{label}: Geschwindigkeit muss zwischen 2 und 4 liegen")
    _check(profile.stop_mm is None or 0 <= profile.stop_mm <= 40, f"{label}: Stopp-Position muss zwischen 0 und 40 mm liegen")
    _check(profile.sensor_mode in SENSOR_MODES, f"{label}: Sensorart ungültig")
    _check(
        profile.sensor_mode != "none" or profile.continuous,
        f"{label}: „Kein Sensor“ geht nur bei Endlosmaterial – sonst findet der Drucker keine Etikettenspalte",
    )
    _check(
        profile.sensor_mode != "auto" or not profile.continuous,
        f"{label}: Endlosmaterial braucht eine feste Sensorart (Durchlicht, Reflex oder kein Sensor)",
    )
    _check(
        profile.mark_width_mm is None or not profile.continuous,
        f"{label}: Schwarzmarken gibt es nur bei Etiketten mit fester Länge",
    )
    _check(
        (profile.mark_width_mm is None or 1 <= profile.mark_width_mm <= 10) and 0 <= profile.mark_offset_mm <= 50,
        f"{label}: Schwarzmarke: Breite 1–10 mm, Abstand 0–50 mm",
    )
    _check(
        SENSOR_SCALE_MIN <= round(profile.sensor_scale, 1) <= SENSOR_SCALE_MAX,
        f"{label}: Sensorposition muss zwischen 0,5 und 5,5 auf der Skala liegen",
    )
    _check(profile.guide in GUIDE_SETTINGS and profile.feed_path in FEED_PATHS and profile.roller in ROLLERS, f"{label}: Einlegeangaben ungültig")
    _validate_web(profile, label)


def validate_materials(materials: list[MaterialProfile], active_material_id: str) -> None:
    """Raise :class:`MaterialValidationError` (German, user-facing) on nonsense.

    The input schemas carry types only, so this is the one place every range
    is checked — a pydantic range error would reach the user as English.
    """
    ids = [profile.id for profile in materials]
    if len(ids) != len(set(ids)):
        raise MaterialValidationError("Material-IDs müssen eindeutig sein")
    for builtin_id in _BUILTINS:
        if builtin_id not in ids:
            raise MaterialValidationError(f"Mitgeliefertes Material {builtin_id} kann nicht entfernt werden")
    if active_material_id not in ids:
        raise MaterialValidationError(f"Unbekanntes Material: {active_material_id}")
    for profile in materials:
        _validate_profile(profile)


def validate_printer_settings(baseline_overrides: dict[str, Any], row_offset_dots: Any, staff_enabled: Any) -> None:
    ranges = {"darkness": (0, 19), "speed_ips": (2, 4), "stop_mm": (0, 40)}
    for key, value in baseline_overrides.items():
        lo, hi = ranges.get(key, (1, 0))
        if _int(value, lo, hi) is _INVALID:
            raise PrinterSettingsValidationError("Grundeinstellung ungültig: Schwärzung 0–19, Geschwindigkeit 2–4, Stopp 0–40 mm")
    if row_offset_dots is not None and _int(row_offset_dots, -100, 100) is _INVALID:
        raise PrinterSettingsValidationError("Zeilenversatz muss zwischen −100 und 100 Punkten liegen")
    if not isinstance(staff_enabled, bool):
        raise PrinterSettingsValidationError("Freigabe muss ja oder nein sein")


# ── Writing (compare-and-set) ──────────────────────────────────────────────


def _profile_json(profile: MaterialProfile, name: str) -> Any:
    value = getattr(profile, name)
    return web_to_dict(value) if name == "web" else value


def _material_entry(profile: MaterialProfile) -> dict[str, Any]:
    """Builtins as a diff against the CURRENT code default; customs in full."""
    entry: dict[str, Any] = {"id": profile.id}
    base = _BUILTINS.get(profile.id)
    for name in STORED_FIELDS:
        if base is not None and _same(getattr(profile, name), getattr(base, name)):
            continue
        entry[name] = _profile_json(profile, name)
    return entry


def _serialize(fields: dict[str, Any], revision: int) -> dict[str, Any]:
    baseline = {
        key: value
        for key, value in (fields.get("baseline_overrides") or {}).items()
        if value != getattr(CODE_BASELINE, key)
    }
    payload: dict[str, Any] = {
        "format": CONFIG_FORMAT,
        "revision": revision,
        "host": (fields.get("host") or "").strip(),
        "port": int(fields.get("port") or 9100),
        "active_material_id": fields["active_material_id"],
        "baseline": baseline,
        "row_offset_dots": fields.get("row_offset_dots"),
        "label_calibration_staff_enabled": bool(fields.get("label_calibration_staff_enabled")),
        "materials": [_material_entry(profile) for profile in fields["materials"]],
    }
    return payload


_WRITABLE = ("host", "port", "materials", "active_material_id", "baseline_overrides", "row_offset_dots", "label_calibration_staff_enabled")


def _stored_shape(profile: MaterialProfile) -> tuple[Any, ...]:
    return tuple(_profile_json(profile, name) for name in STORED_FIELDS)


def update_config(
    db: Session,
    mutate: Callable[[dict[str, Any]], dict[str, Any] | None],
    *,
    expected_revision: int | None,
) -> dict[str, Any]:
    """Read-modify-write of the configuration under its row lock.

    ``mutate`` gets the current config and returns the keys to change, or
    None for "nothing to write" (no revision bump). Validation runs on the
    merged result; profiles that changed also pass the dry render (their
    offsets must keep the print on the material). The caller commits.
    """
    from app.services.werkstatt_label_jobs import dry_render_checks

    row = get_runtime_setting_for_update(db, WERKSTATT_LABEL_PRINTER_KEY)
    current = _config_from_stored(_parse_blob(row.value if row is not None else None))
    if expected_revision is not None and expected_revision != current["revision"]:
        raise StaleRevision(current["revision"])
    changes = mutate(current)
    if changes is None:
        return current
    merged = {key: current[key] for key in _WRITABLE}
    merged.update(changes)
    validate_materials(merged["materials"], merged["active_material_id"])
    validate_printer_settings(merged["baseline_overrides"], merged["row_offset_dots"], merged["label_calibration_staff_enabled"])
    before = {profile.id: _stored_shape(profile) for profile in current["materials"]}
    for profile in merged["materials"]:
        if before.get(profile.id) != _stored_shape(profile):
            dry_render_checks(profile)
    payload = _serialize(merged, revision=current["revision"] + 1)
    raw = json.dumps(payload, ensure_ascii=False)
    set_runtime_setting(db, WERKSTATT_LABEL_PRINTER_KEY, raw)
    return _config_from_stored(payload)


def write_label_printer_config(
    db: Session,
    *,
    host: str,
    port: int,
    materials: list[MaterialProfile],
    active_material_id: str,
    baseline_overrides: dict[str, int],
    row_offset_dots: int | None,
    label_calibration_staff_enabled: bool,
    expected_revision: int | None,
) -> dict[str, Any]:
    """Validate and persist the full config in one compare-and-set write."""
    return update_config(
        db,
        lambda _current: {
            "host": host,
            "port": port,
            "materials": materials,
            "active_material_id": active_material_id,
            "baseline_overrides": baseline_overrides,
            "row_offset_dots": row_offset_dots,
            "label_calibration_staff_enabled": label_calibration_staff_enabled,
        },
        expected_revision=expected_revision,
    )


def set_label_printer_config(
    db: Session,
    *,
    host: str,
    port: int,
    materials: list[MaterialProfile],
    active_material_id: str,
) -> None:
    """The pre-revision writer: address, materials, active — no revision check."""
    update_config(
        db,
        lambda _current: {"host": host, "port": port, "materials": materials, "active_material_id": active_material_id},
        expected_revision=None,
    )


# ── Incoming changes (PATCH list, PUT material) ────────────────────────────

_FLOAT_FIELDS = frozenset({"width_mm", "length_mm", "gap_mm", "x_offset_mm", "across_offset_mm", "mark_width_mm", "mark_offset_mm"})
_INT_FIELDS = frozenset({"darkness", "speed_ips", "stop_mm"})
_TEXT_FIELDS = frozenset({"name", "part_no"})


def _incoming_value(name: str, value: Any) -> Any:
    """One incoming field → the profile's type; ranges are validated later."""
    try:
        if value is None:
            return None
        if name == "web":
            raw = value if isinstance(value, dict) else web_to_dict(value)
            known = {field.name for field in dataclass_fields(MediaWeb)}
            return MediaWeb(**{key: raw[key] for key in known if key in raw})
        if name == "sensor_scale":
            return round(float(value), 1)
        if name in _FLOAT_FIELDS:
            return float(value)
        if name in _INT_FIELDS:
            return int(value)
        if name in _TEXT_FIELDS:
            return str(value).strip()
        if name == "mark_inside":
            return bool(value)
        return value
    except (TypeError, ValueError) as exc:
        raise MaterialValidationError(f"Ungültiges Material: {name}") from exc


def apply_material_changes(profile: MaterialProfile, changes: dict[str, Any]) -> MaterialProfile:
    """Merge field changes into a profile; identity and builtin flag stay."""
    values = {name: _incoming_value(name, value) for name, value in changes.items() if name in STORED_FIELDS}
    return replace(profile, **values, job=None)


def new_custom_material(item: dict[str, Any]) -> MaterialProfile:
    """A new custom profile from a PATCH item; unset fields get type defaults."""
    values = {name: _incoming_value(name, value) for name, value in item.items() if name in STORED_FIELDS}
    profile_id = str(item.get("id") or "").strip()
    try:
        return MaterialProfile(
            id=profile_id,
            name=values.pop("name", ""),
            part_no=values.pop("part_no", ""),
            width_mm=values.pop("width_mm"),
            length_mm=values.pop("length_mm", None),
            **values,
        )
    except (KeyError, TypeError) as exc:
        raise MaterialValidationError(f"Ungültiges Material: {profile_id or '?'}") from exc


def drop_explicit_nulls(item: dict[str, Any]) -> dict[str, Any]:
    """PATCH: an explicit null on a non-nullable field keeps the stored value."""
    return {key: value for key, value in item.items() if value is not None or key in NULLABLE_FIELDS}


def merge_material_list(current: list[MaterialProfile], items: list[dict[str, Any]]) -> list[MaterialProfile]:
    """PATCH list semantics: listed ids merge, unknown ids are created,
    unlisted customs are removed, unlisted builtins are an error."""
    listed = {str(item.get("id") or "").strip() for item in items}
    for builtin_id in _BUILTINS:
        if builtin_id not in listed:
            raise MaterialValidationError(f"Mitgeliefertes Material {builtin_id} kann nicht entfernt werden")
    by_id = {profile.id: profile for profile in current}
    merged: list[MaterialProfile] = []
    for item in items:
        changes = drop_explicit_nulls(item)
        profile_id = str(changes.get("id") or "").strip()
        existing = by_id.get(profile_id)
        merged.append(apply_material_changes(existing, changes) if existing is not None else new_custom_material(changes))
    return merged


def reset_material_fields(profile: MaterialProfile, names: list[str]) -> MaterialProfile:
    """PUT ``reset_fields``: builtins only, every profile field except ``id``."""
    if not names:
        return profile
    base = _BUILTINS.get(profile.id)
    if base is None:
        raise MaterialValidationError("Nur mitgelieferte Materialien haben Standardwerte zum Zurücksetzen")
    unknown = [name for name in names if name not in STORED_FIELDS and name != "builtin"]
    if unknown:
        raise MaterialValidationError(f"Unbekanntes Feld: {unknown[0]}")
    return replace(profile, **{name: getattr(base, name) for name in names if name in STORED_FIELDS}, job=None)


def require_material(materials: list[MaterialProfile], material_id: str) -> MaterialProfile:
    for profile in materials:
        if profile.id == material_id:
            return profile
    raise LabelRequestRefused(404, "unknown_material", f"Unbekanntes Material: {material_id}")


def set_active_material(db: Session, material_id: str) -> tuple[dict[str, Any], bool]:
    """Activate a material via the CAS without revision; no write if unchanged."""
    changed = False

    def mutate(current: dict[str, Any]) -> dict[str, Any] | None:
        nonlocal changed
        require_material(current["materials"], material_id)
        if current["active_material_id"] == material_id:
            return None
        changed = True
        return {"active_material_id": material_id}

    return update_config(db, mutate, expected_revision=None), changed


def normalize_incoming_material(raw: dict[str, Any]) -> MaterialProfile:
    """Admin-payload dict → profile; builtins keep their flag by identity."""
    profile_id = str(raw.get("id") or "").strip()
    base = _BUILTINS.get(profile_id)
    if base is not None:
        return apply_material_changes(base, drop_explicit_nulls(raw))
    return new_custom_material(drop_explicit_nulls(raw))
