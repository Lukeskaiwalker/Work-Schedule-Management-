from __future__ import annotations

import os
from io import BytesIO

from PIL import Image

from app.services.construction_report_pdf import compact_photo_for_pdf, format_work_done_for_report


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
