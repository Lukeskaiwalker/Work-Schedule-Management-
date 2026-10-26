"""The seven workshop materials SMPL ships, with their provenance.

Print geometry is unchanged since 2026-08 (WAGO catalogue). The sensor and
loading fields come from WAGO's handling sheets (08.2020), the roller table
(12.2016) and the owner's photo of his 258-5101 (13.10.2026), which has a
printed scale 1–5 instead of the ▽/⬇ marks of WAGO's sheets. WAGO's positions
are transferred to that scale — 3,4 for the label rolls (the "triangle",
3–4 mm right of the centre), 3 for strip and tube (the "arrow" = centre) —
and stay approximate ("ca.") until the physical test T0. Every hint carries
its own qualifier; the UI shows them verbatim.

The 211-502 tube (Ø 4,8 mm, for 1–2,5 mm² — the §14a wires, R4 §9.3) came
in round 4. Its flat width is computed, not measured (ungeprüft): one test
print on the office printer is owed. It is not in the frozen v1 shape below
— no v1 blob ever stored it — so an install heals it from code.

All seven use roller 258-5006 (black, smooth). 258-5007 is for WMB-Inline
2009-113/-114/-115 only — the old advice to swap it in for strips was wrong.
"""

from __future__ import annotations

from app.services.werkstatt_label_profile import MaterialProfile, MediaWeb, format_mm_de, mm_int

DEFAULT_ACTIVE_ID = "wago-210-804"

_LABEL_SCALE = 3.4
_CENTRE_SCALE = 3.0

DEFAULT_MATERIALS: tuple[MaterialProfile, ...] = (
    MaterialProfile(
        id="wago-210-804",
        name="Typenschilder 99 × 44 (silber)",
        part_no="WAGO 210-804",
        width_mm=44,
        length_mm=99,
        builtin=True,
        sensor_mode="see_through",
        sensor_scale=_LABEL_SCALE,
        guide="max",
        feed_path="internal",
    ),
    MaterialProfile(
        id="wago-210-824",
        name="Sicherheitsetiketten 99 × 44 (silber)",
        part_no="WAGO 210-824",
        width_mm=44,
        length_mm=99,
        builtin=True,
        sensor_mode="see_through",
        sensor_scale=_LABEL_SCALE,
        guide="max",
        feed_path="internal",
    ),
    MaterialProfile(
        id="wago-210-812",
        name="Typenschilder 50 × 25 (silber)",
        part_no="WAGO 210-812",
        width_mm=25,
        length_mm=50,
        builtin=True,
        sensor_mode="see_through",
        sensor_scale=_LABEL_SCALE,
        guide="max",
        feed_path="internal",
    ),
    MaterialProfile(
        id="wago-210-805",
        name="Etiketten 15 × 6 (weiß)",
        part_no="WAGO 210-805",
        # Printing stays one lane 6 × 15 in this build; the roll is two lanes
        # of ≈ 15 × 6 on a ≈ 34 mm liner (estimated from a WAGO photo).
        width_mm=6,
        length_mm=15,
        builtin=True,
        sensor_mode="see_through",
        sensor_scale=_LABEL_SCALE,
        guide="fit",
        feed_path="internal",
        web=MediaWeb(lanes=2, label_across_mm=15.0, label_along_mm=6.0, lane_gap_mm=1.0, liner_width_mm=34.0, source="estimate"),
    ),
    MaterialProfile(
        id="wago-211-501",
        # Ø 3.2 mm tube lies ~5 mm flat under the head.
        name="Schrumpfschlauch Ø 3,2 (weiß, Endlos)",
        part_no="WAGO 211-501",
        width_mm=5,
        length_mm=None,
        builtin=True,
        sensor_mode="see_through",
        sensor_scale=_CENTRE_SCALE,
        guide="fit",
        feed_path="external",
        web=MediaWeb(liner_width_mm=5.0, source="estimate"),
    ),
    MaterialProfile(
        id="wago-211-502",
        # Ø 4.8 mm tube lies ~7.5 mm flat under the head (π · 4.8 / 2; ungeprüft).
        name="Schrumpfschlauch Ø 4,8 (weiß, Endlos)",
        part_no="WAGO 211-502",
        width_mm=7.5,
        length_mm=None,
        builtin=True,
        sensor_mode="see_through",
        sensor_scale=_CENTRE_SCALE,
        guide="fit",
        feed_path="external",
        web=MediaWeb(liner_width_mm=7.5, source="estimate"),
    ),
    MaterialProfile(
        id="wago-2009-110",
        name="Beschriftungsstreifen 11 mm (TopJob, Endlos)",
        part_no="WAGO 2009-110",
        width_mm=11,
        length_mm=None,
        builtin=True,
        sensor_mode="see_through",
        sensor_scale=_CENTRE_SCALE,
        guide="fit",
        feed_path="external",
        web=MediaWeb(liner_width_mm=11.0, source="catalogue"),
    ),
)

BUILTIN_IDS = frozenset(profile.id for profile in DEFAULT_MATERIALS)

# The stored shape of every builtin at a9c335f (format 1). A v1 blob stored
# ALL of these keys for every builtin; at read time a key still holding this
# value was never edited and must not freeze into an override. Frozen on
# purpose: it describes history, not the current defaults.
LEGACY_V1_BUILTIN_VALUES: dict[str, dict[str, object]] = {
    "wago-210-804": {"name": "Typenschilder 99 × 44 (silber)", "part_no": "WAGO 210-804", "width_mm": 44, "length_mm": 99, "gap_mm": 3.0, "x_offset_mm": 2.0, "darkness": None},
    "wago-210-824": {"name": "Sicherheitsetiketten 99 × 44 (silber)", "part_no": "WAGO 210-824", "width_mm": 44, "length_mm": 99, "gap_mm": 3.0, "x_offset_mm": 2.0, "darkness": None},
    "wago-210-812": {"name": "Typenschilder 50 × 25 (silber)", "part_no": "WAGO 210-812", "width_mm": 25, "length_mm": 50, "gap_mm": 3.0, "x_offset_mm": 2.0, "darkness": None},
    "wago-210-805": {"name": "Etiketten 15 × 6 (weiß)", "part_no": "WAGO 210-805", "width_mm": 6, "length_mm": 15, "gap_mm": 3.0, "x_offset_mm": 2.0, "darkness": None},
    "wago-211-501": {"name": "Schrumpfschlauch Ø 3,2 (weiß, Endlos)", "part_no": "WAGO 211-501", "width_mm": 5, "length_mm": None, "gap_mm": 3.0, "x_offset_mm": 2.0, "darkness": None},
    "wago-2009-110": {"name": "Beschriftungsstreifen 11 mm (TopJob, Endlos)", "part_no": "WAGO 2009-110", "width_mm": 11, "length_mm": None, "gap_mm": 3.0, "x_offset_mm": 2.0, "darkness": None},
}

_ROLLER_HINT = ("roller", "Andruckwalze 258-5006 laut WAGO-Zuordnungstabelle (12.2016)")
_PHOTO_HINT = ("sensor_position", "Foto 13.10.2026: Etiketten werden so korrekt erkannt (Rolle 210-804)")
_SEE_THROUGH_DERIVED = ("sensor_mode", "Sensor Durchlicht: abgeleitet, nicht am Drucker geprüft")

BUILTIN_HINTS: dict[str, list[tuple[str, str]]] = {
    "wago-210-804": [
        ("sensor_position", "Sensorposition ca. 3,4 der Skala: WAGO-Handhabungshinweis 210-804 (08.2020), auf die Skala Ihres Druckers übertragen"),
        _PHOTO_HINT,
        _SEE_THROUGH_DERIVED,
        ("geometry", "99 × 44 mm, Spalt 3 mm: von SMPL am Drucker eingestellt (WAGO veröffentlicht Spalt und Trägerbreite nicht)"),
        _ROLLER_HINT,
    ],
    "wago-210-824": [
        ("sensor_position", "Sensorposition ca. 3,4 der Skala wie 210-804: WAGO-Handhabungshinweis (WAGO ordnet denselben zu), auf die Skala Ihres Druckers übertragen"),
        _PHOTO_HINT,
        _SEE_THROUGH_DERIVED,
        ("geometry", "Gleich groß wie 210-804 – eine Messung unterscheidet die beiden nicht"),
        _ROLLER_HINT,
    ],
    "wago-210-812": [
        ("sensor_position", "Sensorposition ca. 3,4 der Skala: WAGO-Handhabungshinweis 210-804 (dort mitgenannt), auf die Skala Ihres Druckers übertragen"),
        _PHOTO_HINT,
        _SEE_THROUGH_DERIVED,
        ("geometry", "Spalt 3 mm: Annahme von SMPL"),
        _ROLLER_HINT,
    ],
    "wago-210-805": [
        ("sensor_position", "Sensorposition ca. 3,4 der Skala: WAGO-Handhabungshinweis 210-805 (08.2020), auf die Skala Ihres Druckers übertragen"),
        _PHOTO_HINT,
        ("web", "WAGO: 3.000 Etiketten pro Rolle, 2 Bahnen"),
        ("web", "Maße der Rolle (≈ 15 × 6 mm je Etikett, Träger ≈ 34 mm) aus einem WAGO-Foto geschätzt, nicht am Material gemessen"),
        ("printing", "SMPL druckt 210-805 in diesem Stand weiter einbahnig 6 × 15 mm"),
        _ROLLER_HINT,
    ],
    "wago-211-501": [
        ("sensor_position", "Sensorposition ca. 3 der Skala (Mitte): WAGO-Handhabungshinweis 211-502 (gilt für 211-500 … -506), auf die Skala Ihres Druckers übertragen"),
        ("web", "Breite flach ≈ 5 mm: berechnet (π · 3,2 / 2), nicht gemessen"),
        _SEE_THROUGH_DERIVED,
        _ROLLER_HINT,
    ],
    "wago-211-502": [
        ("sensor_position", "Sensorposition ca. 3 der Skala (Mitte): WAGO-Handhabungshinweis 211-502 (gilt für 211-500 … -506), auf die Skala Ihres Druckers übertragen"),
        ("web", "Breite flach ≈ 7,5 mm: berechnet (π · 4,8 / 2), nicht gemessen"),
        _SEE_THROUGH_DERIVED,
        _ROLLER_HINT,
    ],
    "wago-2009-110": [
        ("sensor_position", "Sensorposition ca. 3 der Skala (Mitte): WAGO-Handhabungshinweis 2009-110 (08.2020), auf die Skala Ihres Druckers übertragen"),
        ("sensor_mode", "Sensor Durchlicht für Endlosmaterial: Ergebnis der WAGO-Software GoDoctor (2017)"),
        _ROLLER_HINT,
    ],
}

# Shown in the feed confirmation. No source bounds the feed of an auto-sense
# on continuous stock (T9 budgets 70 cm per attempt), so continuous hints
# name no length.
AUTOSENSE_COST_HINT: dict[str, str] = {
    "wago-210-804": "voraussichtlich 2–3 Etiketten (≈ 20–30 cm, Schätzung)",
    "wago-210-824": "voraussichtlich 2–3 Etiketten (≈ 20–30 cm, Schätzung)",
    "wago-210-812": "voraussichtlich 2–3 Etiketten (≈ 11–16 cm, Schätzung)",
    "wago-210-805": "voraussichtlich einige Etikettenreihen (wenige cm, Schätzung)",
    "wago-211-501": "Menge unbekannt – für Endlosschlauch nennt keine Quelle eine Grenze",
    "wago-211-502": "Menge unbekannt – für Endlosschlauch nennt keine Quelle eine Grenze",
    "wago-2009-110": "Menge unbekannt – für Endlosstreifen nennt keine Quelle eine Grenze",
}
_CUSTOM_CONTINUOUS_COST = "Menge unbekannt – für Endlosmaterial nennt keine Quelle eine Grenze"

# Measuring pattern on continuous stock: 40 mm, 30 mm on a tube (§4.11).
PATTERN_LENGTH_MM = 40
PATTERN_LENGTH_TUBE_MM = 30
# The heat-shrink tubes. Equal to ``schemas.panel_enclosure.TUBE_MATERIAL_IDS``
# (the §14a block's choice; a test keeps the two the same).
TUBE_MATERIAL_IDS: frozenset[str] = frozenset({"wago-211-501", "wago-211-502"})


def autosense_cost_hint(profile: MaterialProfile) -> str:
    if profile.id in AUTOSENSE_COST_HINT:
        return AUTOSENSE_COST_HINT[profile.id]
    if profile.continuous:
        return _CUSTOM_CONTINUOUS_COST
    separator = profile.mark_width_mm if profile.mark_width_mm is not None else profile.gap_mm
    pitch = (profile.physical_length_mm or 0) + separator
    return f"voraussichtlich 2–3 Etiketten (≈ {format_mm_de(3 * pitch, 0)} mm, Schätzung)"


def pattern_length_mm(profile: MaterialProfile) -> int:
    return PATTERN_LENGTH_TUBE_MM if profile.id in TUBE_MATERIAL_IDS else PATTERN_LENGTH_MM


def pattern_cost_hint(profile: MaterialProfile, *, supported: bool) -> str:
    if not supported:
        return ""
    if not profile.continuous:
        return "1 Etikett"
    fed = mm_int(pattern_length_mm(profile) + profile.x_offset_mm)
    what = "Schlauch" if profile.id in TUBE_MATERIAL_IDS else "Streifen"
    return f"≈ {fed} mm {what} (Schätzung)"
