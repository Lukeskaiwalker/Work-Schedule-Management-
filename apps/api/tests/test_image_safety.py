"""Uploaded images may only reach decoders for formats the app accepts.

pip-audit on 2026-10-05 found Pillow 11.3.0 in the production image with
CVE-2026-42311 -- "processing a malicious PSD file could lead to memory
corruption, potentially ... arbitrary code execution" -- reachable from any
account, because four call sites passed uploaded bytes to ``Image.open`` with
no format list, and Pillow picks the decoder from the file's first bytes, not
its name. Worse, the report PDF path fell back to the ORIGINAL bytes when its
own decode failed and handed them to ReportLab, which decodes unrestricted.

These tests do not trust "it raised an error". The decisive ones put a spy on
Pillow's PSD plugin and assert it never runs: a PSD that is refused somewhere
and then decoded somewhere else is exactly the bug.
"""

from __future__ import annotations

import base64
import io

import pytest
from PIL import Image, PsdImagePlugin

from app.services import image_safety
from app.services.image_safety import (
    SIGNATURE_IMAGE_FORMATS,
    open_untrusted_image,
    safe_image_bytes,
)

# The smallest header Pillow's PSD plugin accepts and starts parsing: "8BPS",
# version 1, reserved, 3 channels, 16x16, depth 8, RGB.
PSD_HEADER = (
    b"8BPS" + b"\x00\x01" + b"\x00" * 6 + b"\x00\x03"
    + b"\x00\x00\x00\x10" * 2 + b"\x00\x08\x00\x03" + b"\x00" * 64
)


def _encoded(fmt: str, mode: str = "RGB", size=(8, 8)) -> bytes:
    out = io.BytesIO()
    Image.new(mode, size, (200, 30, 30, 128) if mode == "RGBA" else (200, 30, 30)).save(out, fmt)
    return out.getvalue()


@pytest.fixture
def psd_spy(monkeypatch):
    """Records every time Pillow's PSD decoder starts parsing a file."""
    calls: list[int] = []
    real_open = PsdImagePlugin.PsdImageFile._open

    def spying_open(self):
        calls.append(1)
        return real_open(self)

    monkeypatch.setattr(PsdImagePlugin.PsdImageFile, "_open", spying_open)
    return calls


# --------------------------------------------------------------------------
# The threat, pinned so the rest of the file means something
# --------------------------------------------------------------------------


def test_an_unrestricted_open_hands_a_psd_to_the_psd_decoder(psd_spy):
    """The premise. If this ever stops being true the module is unnecessary,
    and if it is true every other test here is guarding something real."""
    with Image.open(io.BytesIO(PSD_HEADER)) as image:
        assert image.format == "PSD"
    assert psd_spy, "the spy did not see the PSD decoder run"


# --------------------------------------------------------------------------
# open_untrusted_image
# --------------------------------------------------------------------------


@pytest.mark.parametrize("fmt", ["JPEG", "PNG", "GIF", "WEBP", "BMP", "TIFF"])
def test_every_accepted_upload_format_opens(fmt):
    with open_untrusted_image(_encoded(fmt)) as image:
        assert image.format == fmt


def test_a_psd_is_refused_before_its_decoder_runs(psd_spy):
    with pytest.raises(Image.UnidentifiedImageError):
        open_untrusted_image(PSD_HEADER)
    assert psd_spy == []


def test_a_psd_named_and_typed_as_a_photo_is_still_refused(psd_spy):
    """The name was never the defence; this pins that the content is."""
    with pytest.raises(Image.UnidentifiedImageError):
        open_untrusted_image(PSD_HEADER, ("JPEG",))
    assert psd_spy == []


def test_signatures_get_a_narrower_list_than_photos():
    tiff = _encoded("TIFF")
    with open_untrusted_image(tiff):
        pass  # fine as an upload
    with pytest.raises(Image.UnidentifiedImageError):
        open_untrusted_image(tiff, SIGNATURE_IMAGE_FORMATS)


def test_an_unregistered_format_name_does_not_break_every_image():
    """Pillow raises KeyError for EVERY image when ``formats`` names something
    it has not registered (measured) -- so "pillow-heif failed to import" would
    otherwise mean "no photo opens". Unknown names are dropped instead."""
    with open_untrusted_image(_encoded("PNG"), ("NOT-A-FORMAT", "PNG")) as image:
        assert image.format == "PNG"


# --------------------------------------------------------------------------
# safe_image_bytes -- what may be handed to a library that decodes unrestricted
# --------------------------------------------------------------------------


@pytest.mark.parametrize("fmt", ["JPEG", "PNG"])
def test_jpeg_and_png_pass_through_byte_for_byte(fmt):
    """No re-encode where none is needed: a report photo keeps its quality."""
    data = _encoded(fmt)
    assert safe_image_bytes(data) == data


@pytest.mark.parametrize("fmt", ["WEBP", "TIFF", "GIF", "BMP"])
def test_other_formats_come_back_as_a_file_this_process_wrote(fmt):
    """Not passed through: those are tried after PSD and FITS by an
    unrestricted open, so the output is re-encoded with a known first byte."""
    out = safe_image_bytes(_encoded(fmt))
    assert out is not None
    assert out[:3] == b"\xff\xd8\xff" or out[:4] == b"\x89PNG", out[:8]


def test_transparency_survives_as_png():
    """A signature drawn on a transparent canvas must not get a black box."""
    out = safe_image_bytes(_encoded("WEBP", mode="RGBA"))
    assert out[:4] == b"\x89PNG"
    with Image.open(io.BytesIO(out)) as image:
        assert image.mode == "RGBA"


@pytest.mark.parametrize("data", [b"", b"\x00" * 10, PSD_HEADER, _encoded("PNG")[:40]])
def test_anything_unsafe_or_broken_is_none_not_the_original(data):
    """The old fallback returned the input. That is the bug, so it is pinned."""
    assert safe_image_bytes(data) is None


def test_a_decompression_bomb_is_refused(monkeypatch):
    monkeypatch.setattr(Image, "MAX_IMAGE_PIXELS", 10)
    assert safe_image_bytes(_encoded("PNG", size=(64, 64))) is None


# --------------------------------------------------------------------------
# The report PDF -- the path that used to carry a refused PSD into ReportLab
# --------------------------------------------------------------------------


def test_compacting_a_psd_photo_never_runs_the_psd_decoder(psd_spy):
    from app.services.construction_report_pdf import compact_photo_for_pdf

    compact_photo_for_pdf(PSD_HEADER)
    assert psd_spy == []


@pytest.mark.parametrize("pooled", [False, True], ids=["in-memory", "spooled-to-tempfile"])
def test_a_psd_report_photo_never_reaches_any_decoder(psd_spy, pooled, tmp_path):
    """The regression this file exists for.

    compact_photo_for_pdf hands the ORIGINAL bytes back when it cannot decode
    them; that used to go straight to ReportLab's ImageReader, which calls
    PIL.Image.open unrestricted. Both paths of the photo loop -- tempfile spool
    and in-memory -- are exercised, because each ends in a different ReportLab
    call and the old code was open on both.
    """
    from app.services.construction_report_pdf import (
        _build_styles,
        _photos_section_flowables,
        compact_photo_for_pdf,
    )

    photo = compact_photo_for_pdf(PSD_HEADER)  # what report_jobs does first
    pool: list[str] | None = [] if pooled else None
    flowables = _photos_section_flowables(
        _build_styles(), [("foto.jpg", photo), ("echt.jpg", _encoded("JPEG"))], 500,
        tempfile_pool=pool,
    )
    assert psd_spy == [], "a refused PSD was decoded on the way into the PDF"
    text = " ".join(getattr(f, "text", "") or "" for f in _walk(flowables))
    assert "foto.jpg: kein Vorschauformat" in text  # said, not silently dropped


def test_a_psd_signature_never_reaches_reportlab(psd_spy):
    from app.services.construction_report_pdf import _scaled_image_from_base64

    data_uri = "data:image/png;base64," + base64.b64encode(PSD_HEADER).decode()
    assert _scaled_image_from_base64(data_uri, max_width=100, max_height=50) is None
    assert psd_spy == []


def test_a_real_signature_still_renders():
    from app.services.construction_report_pdf import _scaled_image_from_base64

    data_uri = "data:image/png;base64," + base64.b64encode(_encoded("PNG", "RGBA")).decode()
    assert _scaled_image_from_base64(data_uri, max_width=100, max_height=50) is not None


def _walk(flowables):
    """Flowables nest inside Tables; the placeholder text can be anywhere."""
    for item in flowables:
        yield item
        for row in getattr(item, "_cellvalues", None) or []:
            for cell in row:
                yield from _walk(cell if isinstance(cell, (list, tuple)) else [cell])


# --------------------------------------------------------------------------
# Signatures on training reports -- validated before they are stored
# --------------------------------------------------------------------------


@pytest.mark.parametrize("payload", [PSD_HEADER, _encoded("TIFF"), _encoded("BMP")])
def test_a_signature_that_is_not_a_canvas_image_is_a_400(payload, psd_spy):
    from fastapi import HTTPException

    from app.routers.workflow_training_reports import _validated_signature

    with pytest.raises(HTTPException) as caught:
        _validated_signature("data:image/png;base64," + base64.b64encode(payload).decode())
    assert caught.value.status_code == 400
    assert psd_spy == []


def test_a_canvas_signature_is_accepted():
    from app.routers.workflow_training_reports import _validated_signature

    raw = "data:image/png;base64," + base64.b64encode(_encoded("PNG", "RGBA")).decode()
    assert _validated_signature(raw) == raw


def test_the_module_is_what_the_call_sites_use():
    """A guard against the fix quietly coming undone: every upload decode site
    must go through image_safety. If a new one appears, add it there."""
    import pathlib

    root = pathlib.Path(image_safety.__file__).resolve().parents[1]
    offenders = []
    for path in root.rglob("*.py"):
        if path.name == "image_safety.py":
            continue
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if "Image.open(" in line and "open_untrusted_image" not in line:
                offenders.append(f"{path.relative_to(root)}:{number}")
    # The one deliberate exception: the company logo, read from a configured
    # local path, not from anything a user sent.
    assert offenders == ["services/werkstatt_labels.py:315"], offenders
