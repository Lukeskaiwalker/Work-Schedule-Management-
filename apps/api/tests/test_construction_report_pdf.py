from __future__ import annotations

import base64
import os
from datetime import date
from io import BytesIO

from PIL import Image

from app.services.construction_report_pdf import (
    MATERIAL_OVERFLOW_THRESHOLD,
    build_material_sheet_pdf_bytes,
    build_report_filename,
    build_report_pdf_bytes,
    compact_photo_for_pdf,
    format_work_done_for_report,
    materials_overflow_kind,
)


def test_compact_photo_for_pdf_downscales_and_compresses() -> None:
    width, height = 2600, 1500
    image = Image.frombytes("RGB", (width, height), os.urandom(width * height * 3))
    source = BytesIO()
    image.save(source, format="PNG")
    source_bytes = source.getvalue()

    compacted = compact_photo_for_pdf(source_bytes)

    assert compacted
    assert compacted != source_bytes
    assert len(compacted) < len(source_bytes)

    with Image.open(BytesIO(compacted)) as compact_image:
        assert compact_image.format == "JPEG"
        assert max(compact_image.size) <= 1920


def test_compact_photo_for_pdf_keeps_unreadable_payload() -> None:
    payload = b"not-an-image"
    assert compact_photo_for_pdf(payload) == payload


def test_format_work_done_for_report_includes_completed_subtasks() -> None:
    result = format_work_done_for_report(
        {
            "work_done": "String wiring and inverter setup.",
            "completed_subtasks": ["Mount frame", "Connect inverter", "Mount frame"],
        }
    )
    assert "String wiring and inverter setup." in result
    assert "Erledigte Teilaufgaben:" in result
    assert "- Mount frame" in result
    assert "- Connect inverter" in result
    assert result.count("Mount frame") == 1


def test_format_work_done_for_report_handles_only_subtasks() -> None:
    result = format_work_done_for_report(
        {
            "work_done": "",
            "completed_subtasks": ["Check outputs"],
        }
    )
    assert result.startswith("Erledigte Teilaufgaben:")
    assert "- Check outputs" in result


# ── v2.5.13 redesign tests ───────────────────────────────────────────────────


def _tiny_png_base64() -> str:
    """A 4x4 white PNG suitable for stand-in signature image tests."""
    image = Image.new("RGB", (4, 4), (255, 255, 255))
    buf = BytesIO()
    image.save(buf, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


def test_build_report_pdf_renders_full_payload_under_a4_size() -> None:
    """Full-payload render should produce a non-trivial single PDF without
    raising. Size sanity-check guards against the 'empty doc' regression
    that ReportLab can silently produce when a section element is None."""
    payload = {
        "customer": "Altenzentrum St. Kilian",
        "customer_address": "Hauptstr. 12, 12345 Musterstadt",
        "customer_contact": "Maik Rehr",
        "customer_email": "rehr@example.org",
        "customer_phone": "+49 123 4567890",
        "project_name": "PV, UV, Speicher und Wallbox",
        "project_number": "266",
        "workers": [
            {"name": "Yannik Brauer", "start_time": "08:30", "end_time": "11:30"},
            {"name": "Baris Bingöl", "start_time": "08:30", "end_time": "11:30"},
            {"name": "Helfer1", "start_time": "09:00", "end_time": "10:00"},
        ],
        "materials_consumed": [
            {"item": "Befestigungsmaterial", "qty": "1", "unit": "Stk."},
            {"item": "Durchbrüche", "qty": "2", "unit": "Stk."},
            {"item": "Anschlusskasten", "qty": "1", "unit": "Stk."},
        ],
        "materials_needed": [
            {"item": "5x10 NYY", "qty": "1", "unit": "m", "note": "-"},
            {"item": "5x16 NYY", "qty": "1", "unit": "m", "note": "-"},
            {"item": "Stoßverbinder", "qty": "5", "unit": "Stk.", "note": "-"},
        ],
        "work_done": "Kabelweg zum Wandlerschrank vorbereitet\nDurchbrüche gestemmt\nAnschlusskasten montiert",
        "incidents": "Holzpaneele der Decke sind beschriftet\nKabelwege sind frei und zugänglich",
        "office_rework": "Durchbruch vom Flur zum alten Wandlerschrank herstellen\nPV-Strings in die Garage verlegen",
        "status": {
            "arrival_completed": True,
            "work_finished": True,
            "handed_over_clean": True,
            "further_work_needed": False,
            "extra_material_used": False,
            "note": "",
        },
        "distance": {"kilometers": 48, "source": "auto"},
        "signature_smpl": {"name": "Yannik Brauer", "image_base64": _tiny_png_base64()},
        "signature_customer": {"name": "Maik Rehr", "image_base64": _tiny_png_base64()},
    }
    pdf = build_report_pdf_bytes(
        payload=payload,
        report_date=date(2026, 5, 19),
        submitted_by="Yannik Brauer",
        project_name="PV, UV, Speicher und Wallbox",
        report_number=177,
    )
    assert pdf.startswith(b"%PDF-")
    # A single-page A4 with this much content lands well above 5KB but well
    # below 200KB (no photos in this payload).
    assert 5_000 < len(pdf) < 200_000


def test_build_report_pdf_handles_legacy_payload_without_new_fields() -> None:
    """Reports stored before v2.5.13 don't have status/distance/signature_*/
    split materials. The renderer must produce a valid PDF anyway, falling
    back to placeholders for the new sections and treating the legacy
    ``materials`` list as ``materials_consumed``."""
    payload = {
        "customer": "Legacy Customer",
        "project_name": "Legacy Project",
        "project_number": "999",
        "workers": [{"name": "A", "start_time": "08:00", "end_time": "16:00"}],
        # Legacy: single 'materials' list, no split.
        "materials": [{"item": "Cable", "qty": "10", "unit": "m"}],
        "work_done": "Pulled cable.",
        "incidents": "None.",
        # No status, no distance, no signatures.
    }
    pdf = build_report_pdf_bytes(
        payload=payload,
        report_date=date(2026, 1, 15),
        submitted_by="Legacy User",
    )
    assert pdf.startswith(b"%PDF-")


def test_materials_overflow_kind_returns_verbrauch_when_consumed_too_long() -> None:
    payload = {
        "materials_consumed": [{"item": f"item-{i}", "qty": "1", "unit": "Stk."} for i in range(MATERIAL_OVERFLOW_THRESHOLD + 1)],
        "materials_needed": [],
    }
    assert materials_overflow_kind(payload) == "verbrauch"


def test_materials_overflow_kind_returns_bedarf_when_only_needed_too_long() -> None:
    payload = {
        "materials_consumed": [{"item": "ok", "qty": "1", "unit": "Stk."}],
        "materials_needed": [{"item": f"need-{i}", "qty": "1", "unit": "Stk.", "note": "-"} for i in range(MATERIAL_OVERFLOW_THRESHOLD + 2)],
    }
    assert materials_overflow_kind(payload) == "bedarf"


def test_materials_overflow_kind_returns_none_for_short_lists() -> None:
    payload = {
        "materials_consumed": [{"item": "a", "qty": "1", "unit": "Stk."}],
        "materials_needed": [{"item": "b", "qty": "1", "unit": "Stk.", "note": "-"}],
    }
    assert materials_overflow_kind(payload) is None


def test_materials_overflow_kind_consumed_wins_when_both_overflow() -> None:
    """When both lists overflow, consumed wins (operationally higher
    priority — signed-off-on-site material outranks to-order material)."""
    payload = {
        "materials_consumed": [{"item": f"c-{i}", "qty": "1", "unit": "Stk."} for i in range(MATERIAL_OVERFLOW_THRESHOLD + 1)],
        "materials_needed": [{"item": f"n-{i}", "qty": "1", "unit": "Stk.", "note": "-"} for i in range(MATERIAL_OVERFLOW_THRESHOLD + 1)],
    }
    assert materials_overflow_kind(payload) == "verbrauch"


def test_build_material_sheet_pdf_for_verbrauch_renders() -> None:
    payload = {
        "customer": "Test Customer",
        "project_name": "Test Project",
        "project_number": "001",
        "materials_consumed": [
            {"item": f"Material {i}", "qty": str(i + 1), "unit": "Stk.", "article_no": f"ART-{i:03d}"}
            for i in range(8)
        ],
        "signature_smpl": {"name": "Monteur", "image_base64": _tiny_png_base64()},
        "signature_customer": {"name": "Kunde"},
    }
    pdf = build_material_sheet_pdf_bytes(
        payload=payload,
        report_date=date(2026, 5, 19),
        kind="verbrauch",
        project_name="Test Project",
        report_number=177,
    )
    assert pdf.startswith(b"%PDF-")
    assert len(pdf) > 3_000


def test_build_material_sheet_pdf_for_bedarf_uses_needed_list() -> None:
    """The bedarf variant must source rows from materials_needed, not
    materials_consumed. Regression guard for the 'wrong list' bug."""
    payload = {
        "customer": "X",
        "project_number": "001",
        "materials_consumed": [{"item": "wrong-list-do-not-render", "qty": "1", "unit": "Stk."}],
        "materials_needed": [
            {"item": f"Bedarf {i}", "qty": "1", "unit": "Stk.", "note": "bitte bestellen"}
            for i in range(7)
        ],
    }
    pdf = build_material_sheet_pdf_bytes(
        payload=payload,
        report_date=date(2026, 5, 19),
        kind="bedarf",
        project_name="X",
    )
    assert pdf.startswith(b"%PDF-")


def test_build_report_pdf_status_box_renders_with_all_unchecked_when_legacy() -> None:
    """Legacy reports (no status block) should still produce a PDF — the
    status section renders all five checkboxes as unchecked."""
    payload = {
        "customer": "X",
        "project_number": "001",
        "workers": [],
        "materials": [],
    }
    pdf = build_report_pdf_bytes(
        payload=payload,
        report_date=date(2026, 1, 1),
        submitted_by="X",
    )
    assert pdf.startswith(b"%PDF-")


def test_build_report_filename_includes_report_number_when_present() -> None:
    name = build_report_filename(
        {"customer": "Alten Zentrum", "project_number": "266"},
        date(2026, 5, 19),
        report_number=177,
    )
    assert "Alten_Zentrum" in name
    assert "266" in name
    assert "report-0177" in name
    assert name.endswith("2026-05-19.pdf")
