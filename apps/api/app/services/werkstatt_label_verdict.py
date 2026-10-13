"""Judging an auto-sense: is the measurement fresh, and which stock is it?

The printer's CONFIG always shows a "last measurement" (``^QD``), fresh or
years old. A verify that compared it blindly would call a stale reading of
the PREVIOUS roll a perfect match. So a measurement counts only with proof
that it is new — STATUS reported "busy" while sensing, or the stored ``^Q``
changed from the pre-sense snapshot to a value consistent with the new
``^QD``, or ``^QD`` itself changed. Without proof the verdict is
``unchecked``, never ``match``. Only a CONFIG reply that reached its
terminator counts, before and after the sense: a cut one is unknown.

The first fresh verify of a run LATCHES the measurement and every later
verify of the run judges the latch. Nobody has tested whether a ``^Q`` write
(apply, pattern, job) rewrites ``^QD`` (T1); if it does, the apply for a
switched-to material would make ``^QD`` echo exactly that material, and a
"replace on change" rule would turn the echo into a match on the wrong
stock. For the same reason any write between sensing and the first latch
makes the run ``unchecked``.

``judge`` is pure: the session, the reads and the profiles in, the verdict
and the new latch out. Rule order (first hit wins) is §4.7 of
docs/LABEL_PRINTER_CALIBRATION.md.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from app.services.werkstatt_label_printer_status import PrinterConfig, expected_sensor
from app.services.werkstatt_label_profile import DOTS_PER_MM, MaterialProfile, format_mm_de, format_scale_de

TOLERANCE_MIN_MM = 1.5
TOLERANCE_SHARE = 0.03  # absorbs a 1.6 % scale error (H1) until T4

SAME_SIZE_IDS = ("wago-210-804", "wago-210-824")
TWO_LANE_ID = "wago-210-805"

W1_TEXT = "Messwert entspricht nur der übertragenen Einstellung – bitte erneut einmessen."
W2_TEXT = (
    "Seit dem Einmessen wurden Einstellungen übertragen oder ein Messmuster gedruckt – "
    "das Messergebnis ist nicht mehr eindeutig. Bitte erneut einmessen."
)
STALE_TEXT = "Kein Nachweis, dass gerade neu gemessen wurde – angezeigt werden möglicherweise Werte einer früheren Messung."
BUSY_ONLY_TEXT = "Der Drucker hat gemessen, für Endlosmaterial aber kein neues Messergebnis gemeldet."


@dataclass(frozen=True)
class Verdict:
    verdict: str
    title: str
    detail: str
    notes: tuple[str, ...]
    freshness: str
    from_latch: bool
    offers: tuple[str, ...]
    measured_length_dots: int | None
    measured_gap_dots: int | None
    measured_pitch_dots: int | None
    stored_q_after: str | None
    expected_length_mm: float | None
    expected_gap_mm: float | None
    expected_pitch_mm: float | None
    delta_length_mm: float | None
    delta_pitch_mm: float | None
    tolerance_mm: float | None
    sensor_kind: str
    sensor_expected: str | None
    sensor_ok: bool | None
    suggested_material_ids: tuple[str, ...] = ()
    new_latch: dict[str, Any] | None = field(default=None, compare=False)

    @property
    def fresh(self) -> bool:
        return self.freshness != "none"


def _q_numbers(q: str | None) -> tuple[float, float] | None:
    if not q:
        return None
    parts = q.rstrip("+-").split(",")
    try:
        return float(parts[0]), float(parts[1])
    except (IndexError, ValueError):
        return None


def consistent(q_after: str | None, qd_after: tuple[int, int] | None) -> bool:
    """Does the stored ``^Q`` (mm) describe the measured ``^QD`` (dots)?"""
    numbers = _q_numbers(q_after)
    if numbers is None or qd_after is None:
        return False
    return abs(numbers[0] - qd_after[0] / DOTS_PER_MM) < 1.0 and abs(numbers[1] - qd_after[1] / DOTS_PER_MM) < 1.0


def _measured(config: PrinterConfig | None) -> PrinterConfig | None:
    """The read, when its values may count: only a reply that reached its
    terminator. One that ended early (deadline, close, reset) may lack the
    line that matters, so it can neither prove freshness nor be latched — a
    requery reads it again."""
    return config if config is not None and config.complete else None


def _qd(config: PrinterConfig | None) -> tuple[int, int] | None:
    config = _measured(config)
    if config is None or config.measured_length_dots is None or config.measured_gap_dots is None:
        return None
    return config.measured_length_dots, config.measured_gap_dots


def freshness_of(sense: dict[str, Any], config: PrinterConfig | None) -> tuple[str, bool, bool]:
    """(freshness, q_changed, qd_changed) of this read against the snapshot."""
    presense = sense.get("presense") or {}
    measured = _measured(config)
    q_after = measured.stored_q if measured else None
    qd_after = _qd(config)
    q_before = presense.get("stored_q")
    qd_before = tuple(presense["qd"]) if presense.get("qd") else None
    q_changed = q_before is not None and q_after is not None and q_after != q_before and consistent(q_after, qd_after)
    qd_changed = qd_before is not None and qd_after is not None and qd_after != qd_before
    if sense.get("saw_busy"):
        kind = "busy_seen"
    elif q_changed:
        kind = "q_changed"
    elif qd_changed:
        kind = "qd_changed"
    else:
        kind = "none"
    return kind, q_changed, qd_changed


def _echo_of_last_write(sense: dict[str, Any], config: PrinterConfig | None) -> bool:
    writes = sense.get("writes_since_sense") or []
    last = _q_numbers(writes[-1].get("q")) if writes else None
    qd = _qd(config)
    return last is not None and qd is not None and qd == (round(last[0] * DOTS_PER_MM), round(last[1] * DOTS_PER_MM))


@dataclass(frozen=True)
class _Expected:
    length_mm: float
    gap_mm: float

    @property
    def pitch_mm(self) -> float:
        return self.length_mm + self.gap_mm

    @property
    def tolerance_mm(self) -> float:
        return max(TOLERANCE_MIN_MM, TOLERANCE_SHARE * self.pitch_mm)


def _expected(profile: MaterialProfile) -> _Expected | None:
    if profile.continuous:
        return None
    gap = profile.mark_width_mm if profile.mark_width_mm is not None else profile.gap_mm
    return _Expected(float(profile.physical_length_mm), float(gap))


def _deltas(expected: _Expected, length_dots: int, pitch_dots: int) -> tuple[float, float]:
    return length_dots / DOTS_PER_MM - expected.length_mm, pitch_dots / DOTS_PER_MM - expected.pitch_mm


def _passes(expected: _Expected, length_dots: int, pitch_dots: int) -> bool:
    d_length, d_pitch = _deltas(expected, length_dots, pitch_dots)
    tolerance = expected.tolerance_mm + 1e-9
    return abs(d_length) <= tolerance and abs(d_pitch) <= tolerance


def _suggestions(profile: MaterialProfile, materials: list[MaterialProfile], length_dots: int, pitch_dots: int) -> list[MaterialProfile]:
    candidates: list[tuple[float, int, MaterialProfile]] = []
    for index, other in enumerate(materials):
        expected = _expected(other)
        if other.id == profile.id or expected is None:
            continue
        if _passes(expected, length_dots, pitch_dots):
            candidates.append((abs(_deltas(expected, length_dots, pitch_dots)[1]), index, other))
    return [other for _, _, other in sorted(candidates, key=lambda item: (item[0], item[1]))]


def _mm(dots: int | None) -> str:
    return format_mm_de((dots or 0) / DOTS_PER_MM)


def _offers(verdict: str, rule: str, suggestions: list[MaterialProfile], sensor_ok: bool | None) -> tuple[str, ...]:
    table = {
        "match": ["save"],
        "mismatch": ["resense", "accept_anyway"],
        "other_material": ["switch_material", "resense"],
        "no_gap": ["resense"],
        "gap_on_continuous": (["switch_material"] if suggestions else []) + ["resense"],
        "no_result": ["requery", "accept_anyway"],
        "unchecked": ["resense", "accept_anyway"] if rule == "R3" else ["requery", "resense", "accept_anyway"],
        "printer_error": ["requery", "resense"],
    }
    offers = list(table[verdict])
    if sensor_ok is False and "reapply" not in offers:
        offers.append("reapply")
    return tuple(offers)


def _notes(profile: MaterialProfile, verdict: str, suggestions: list[MaterialProfile], latched_at: datetime | None, hhmm) -> list[str]:
    notes: list[str] = []
    if verdict in ("match", "mismatch", "other_material", "no_gap", "gap_on_continuous"):
        involved = {profile.id, *(other.id for other in suggestions)}
        if involved & set(SAME_SIZE_IDS):
            notes.append("210-804 und 210-824 sind gleich groß – die Messung unterscheidet sie nicht.")
        if TWO_LANE_ID in involved:
            notes.append(
                "Maße der Rolle 210-805 sind geschätzt (zweibahnig ≈ 15 × 6 mm). "
                "SMPL druckt 210-805 in diesem Stand weiter einbahnig."
            )
        elif profile.web.source == "estimate":
            notes.append("Erwartete Maße sind geschätzt.")
    if latched_at is not None:
        notes.append(f"Bewertet wird die Messung vom Einmessen um {hhmm(latched_at)} – spätere Übertragungen ändern sie nicht.")
    return notes


def judge(
    *,
    profile: MaterialProfile,
    materials: list[MaterialProfile],
    status_code: str | None,
    status_text: str,
    status_action: str,
    config: PrinterConfig | None,
    sense: dict[str, Any],
    now_iso: str,
    hhmm,
    parse_time,
) -> Verdict:
    """The verdict for ``profile`` from this read and the run's latch."""
    latch = sense.get("latched")
    sensor_kind = config.sensor_kind if config else "unknown"
    sensor_expected = expected_sensor(profile)
    sensor_ok = None
    if sensor_expected is not None and sensor_kind in ("see_through", "reflective"):
        sensor_ok = sensor_kind == sensor_expected

    if latch:
        freshness, q_changed, qd_changed = latch["freshness"], bool(latch.get("q_changed")), bool(latch.get("qd_changed"))
        length, gap, pitch = latch.get("measured_length_dots"), latch.get("measured_gap_dots"), latch.get("measured_pitch_dots")
        q_after = latch.get("stored_q_after")
    else:
        freshness, q_changed, qd_changed = freshness_of(sense, config)
        measured = _measured(config)
        length = measured.measured_length_dots if measured else None
        gap = measured.measured_gap_dots if measured else None
        pitch = measured.measured_pitch_dots if measured else None
        q_after = measured.stored_q if measured else None

    expected = _expected(profile)

    def result(verdict: str, rule: str, title: str, detail: str, *, suggestions: list[MaterialProfile] = (), new_latch=None, from_latch: bool = False, fresh_as: str | None = None) -> Verdict:
        d_length = d_pitch = None
        if expected is not None and length is not None and pitch is not None and verdict not in ("printer_error", "no_result"):
            d_length, d_pitch = _deltas(expected, length, pitch)
        latched_at = parse_time(latch["at"]) if (from_latch and latch) else None
        return Verdict(
            verdict=verdict,
            title=title,
            detail=detail,
            notes=tuple(_notes(profile, verdict, list(suggestions), latched_at, hhmm)),
            freshness=fresh_as if fresh_as is not None else freshness,
            from_latch=from_latch,
            offers=_offers(verdict, rule, list(suggestions), sensor_ok),
            measured_length_dots=length,
            measured_gap_dots=gap,
            measured_pitch_dots=pitch,
            stored_q_after=q_after,
            expected_length_mm=expected.length_mm if expected else None,
            expected_gap_mm=expected.gap_mm if expected else (0.0 if profile.continuous else None),
            expected_pitch_mm=expected.pitch_mm if expected else None,
            delta_length_mm=None if d_length is None else round(d_length, 2),
            delta_pitch_mm=None if d_pitch is None else round(d_pitch, 2),
            tolerance_mm=round(expected.tolerance_mm, 2) if expected else None,
            sensor_kind=sensor_kind,
            sensor_expected=sensor_expected,
            sensor_ok=sensor_ok,
            suggested_material_ids=tuple(other.id for other in suggestions),
            new_latch=new_latch,
        )

    # R1 — the printer reports a problem.
    if status_code is not None and status_code != "00":
        detail = status_action
        if status_code in ("01", "02") and profile.continuous:
            detail += " Bei durchsichtigem Material hilft eventuell die Sensorart „Kein Sensor“ im Profil."
        return result("printer_error", "R1", f"Drucker meldet: {status_text}", detail.strip())
    if not latch:
        # R2 — nothing to judge (no reply, no ^QD, or a reply that ended early).
        if length is None:
            return result("no_result", "R2", "Kein Messergebnis", "Der Drucker meldet kein Messergebnis. Ergebnis am Probedruck prüfen.")
        # R3 — a write between sensing and the first latch: which ^QD is this?
        if sense.get("writes_since_sense"):
            text = W1_TEXT if _echo_of_last_write(sense, config) else W2_TEXT
            return result("unchecked", "R3", "Ergebnis nicht prüfbar", text, fresh_as="none")
        # R4 — no proof that anything was measured just now.
        if freshness == "none":
            return result("unchecked", "R4", "Ergebnis nicht prüfbar", STALE_TEXT)
        latch = {
            "at": now_iso,
            "freshness": freshness,
            "measured_length_dots": length,
            "measured_gap_dots": gap,
            "measured_pitch_dots": pitch,
            "stored_q_after": q_after,
            # Which proofs held, beyond the reported (highest) one: continuous
            # stock needs a changed result, a busy status alone is not enough.
            "q_changed": q_changed,
            "qd_changed": qd_changed,
        }
        new_latch, from_latch = latch, False
    else:
        new_latch, from_latch = None, True

    name = profile.name
    if profile.continuous:
        # R5 — continuous stock.
        if not (q_changed or qd_changed):
            return result("unchecked", "R5", "Ergebnis nicht prüfbar", BUSY_ONLY_TEXT, new_latch=new_latch, from_latch=from_latch)
        if not gap:
            return result("match", "R5", f"Passt zu „{name}“", "Endlosmaterial erkannt.", new_latch=new_latch, from_latch=from_latch)
        suggestions = _suggestions(profile, materials, length, pitch)
        return result(
            "gap_on_continuous", "R5", "Spalten gemessen",
            f"Der Drucker hat Etiketten gemessen ({_mm(length)} + {_mm(gap)} mm). Ist wirklich Endlosmaterial eingelegt?",
            suggestions=suggestions, new_latch=new_latch, from_latch=from_latch,
        )
    # R6 — die-cut stock without a gap.
    if not gap:
        return result(
            "no_gap", "R6", "Keine Etikettenspalte erkannt",
            f"Der Sensor sieht keine Spalte. Zeiger auf {format_scale_de(profile.sensor_scale)} der Skala stellen und erneut einmessen.",
            new_latch=new_latch, from_latch=from_latch,
        )
    if _passes(expected, length, pitch):  # R7
        _, d_pitch = _deltas(expected, length, pitch)
        return result(
            "match", "R7", f"Passt zu „{name}“",
            f"Gemessen {_mm(length)} + {_mm(gap)} mm (Teilung {_mm(pitch)} mm), Abweichung {format_mm_de(d_pitch)} mm "
            f"bei ± {format_mm_de(expected.tolerance_mm)} mm Toleranz.",
            new_latch=new_latch, from_latch=from_latch,
        )
    suggestions = _suggestions(profile, materials, length, pitch)
    if suggestions:  # R8
        other = suggestions[0]
        return result(
            "other_material", "R8", "Anderes Material gemessen",
            f"Gemessen {_mm(pitch)} mm Teilung – passt zu „{other.name}“ ({other.part_no}). Ist ein anderes Material eingelegt?",
            suggestions=suggestions, new_latch=new_latch, from_latch=from_latch,
        )
    return result(  # R9
        "mismatch", "R9", "Messung passt nicht zum Profil",
        f"Gemessen {_mm(length)} + {_mm(gap)} mm (Teilung {_mm(pitch)} mm), Profil erwartet "
        f"{format_mm_de(expected.length_mm)} + {format_mm_de(expected.gap_mm)} mm ({format_mm_de(expected.pitch_mm)} mm). "
        "Eingelegtes Material und Sensorposition prüfen.",
        new_latch=new_latch, from_latch=from_latch,
    )
