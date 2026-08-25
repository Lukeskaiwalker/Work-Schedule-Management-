"""Render single PDF pages as PNGs, for engines that cannot draw a PDF.

Chrome on Android ships no inline PDF renderer: the in-app viewer's frame
loads, and Chromium paints its sad-page placeholder where the document should
be (`navigator.pdfViewerEnabled === false` is the standardized signal). iOS
and desktop render the framed blob fine, so this is not a replacement for the
frame — it is the fallback the viewer switches to when the engine admits it
cannot draw PDFs itself.

Server-side rendering via poppler (pdf2image → pdftoppm) rather than shipping
pdf.js to every client: poppler is already in the API image for the line-item
extraction pipeline, a page at 120 dpi is a fast subprocess call, and the
phones this exists for are exactly the devices that should not parse a PDF in
JavaScript.

Memory posture mirrors ``image_preview.py``: rendering happens in a poppler
subprocess but the decoded page still lands in this process as a PIL image
(~5–6 MB at 120 dpi), and nothing upstream bounds how many pages a gallery of
open viewers could request at once — so a semaphore caps concurrent renders,
and past a short wait the request sheds with 503 rather than queueing threads.
"""

from __future__ import annotations

import io
import logging
import os
import threading

logger = logging.getLogger(__name__)

PAGE_MEDIA_TYPE = "image/png"
PAGE_DPI = 120

# A phone preview does not need a 400-page manual; past this the viewer shows
# the byte-download hint instead. pdfinfo is cheap either way.
MAX_PAGES = 500

# Source-size cap: rendering is per page, but poppler still parses the whole
# document. 60 MB matches the HEIC preview's idea of "past generous".
MAX_SOURCE_BYTES = 60 * 1024 * 1024

_CONCURRENCY = max(1, int(os.getenv("PDF_PAGE_PREVIEW_CONCURRENCY", "2") or 2))
_render_slots = threading.BoundedSemaphore(_CONCURRENCY)
# How long a request may wait for a slot before shedding. Short on purpose:
# a pager UI would rather retry than hold threads open.
_ACQUIRE_TIMEOUT_SECONDS = 10.0


class PdfPreviewUnavailable(Exception):
    """Poppler missing, document unreadable, or page out of range."""


class PdfPreviewBusy(Exception):
    """All render slots taken; the caller should answer 503."""


def pdf_page_count(data: bytes) -> int:
    """Number of pages, or raise PdfPreviewUnavailable.

    Uses pdfinfo (no rendering), so this is safe to call on every viewer open.
    """

    if not data or len(data) > MAX_SOURCE_BYTES:
        raise PdfPreviewUnavailable("PDF zu groß oder leer")
    try:
        from pdf2image import pdfinfo_from_bytes

        info = pdfinfo_from_bytes(data)
        pages = int(info.get("Pages") or 0)
    except Exception as exc:  # poppler missing, corrupt file, …
        raise PdfPreviewUnavailable(str(exc)) from exc
    if pages < 1:
        raise PdfPreviewUnavailable("PDF ohne Seiten")
    return min(pages, MAX_PAGES)


def render_pdf_page(data: bytes, page: int) -> bytes:
    """PNG bytes of one 1-based page.

    Renders exactly one page (`first_page == last_page`), never the document —
    that is what keeps a 300-page PDF from expanding into this process.
    """

    total = pdf_page_count(data)
    if page < 1 or page > total:
        raise PdfPreviewUnavailable(f"Seite {page} existiert nicht (1–{total})")

    if not _render_slots.acquire(timeout=_ACQUIRE_TIMEOUT_SECONDS):
        raise PdfPreviewBusy()
    try:
        from pdf2image import convert_from_bytes

        images = convert_from_bytes(
            data, dpi=PAGE_DPI, fmt="png", first_page=page, last_page=page
        )
        if not images:
            raise PdfPreviewUnavailable("Seite konnte nicht gerendert werden")
        out = io.BytesIO()
        images[0].save(out, format="PNG", optimize=True)
        return out.getvalue()
    except PdfPreviewUnavailable:
        raise
    except Exception as exc:
        logger.warning("PDF page render failed", exc_info=True)
        raise PdfPreviewUnavailable(str(exc)) from exc
    finally:
        _render_slots.release()
