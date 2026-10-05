"""Decoding images that came from outside, without letting them choose the decoder.

``PIL.Image.open`` does not believe the file name or the content type. It sniffs
the first bytes and hands the file to whichever of ~45 plugins accepts them. An
upload called ``foto.jpg`` whose first bytes are ``8BPS`` goes to the PSD
decoder; one starting ``SIMPLE`` goes to FITS. Measured against Pillow 12.3: an
unrestricted open of a bare PSD header returns ``format == "PSD"``.

That matters because the decoders nobody here asked for are where Pillow's bugs
live. pip-audit on 2026-10-05 found Pillow 11.3.0 in the production image, with
CVE-2026-42311 ("processing a malicious PSD file could lead to memory
corruption, potentially ... arbitrary code execution") among ~20 others in PSD,
FITS, PCF, BDF, GD and JPEG 2000 -- and four call sites that opened uploaded
bytes with no restriction, on a public server. Any account could reach them.

Upgrading Pillow closes those CVEs. This module closes the *class*: an upload is
decoded only by a plugin for a format the app actually accepts, so the next PSD
bug is not reachable either.

Two entry points:

``open_untrusted_image(data)``
    ``Image.open`` restricted to the accepted formats. For code that wants the
    decoded image -- previews, conversions, size checks.

``safe_image_bytes(data)``
    Bytes that are safe to hand to *another library that will decode them
    unrestricted* -- ReportLab's ``ImageReader`` calls ``PIL.Image.open`` with
    no format list of its own. Restricting our own open is not enough there:
    the old PDF path fell back to the ORIGINAL bytes whenever its own open
    failed, so a refused PSD was handed straight to ReportLab, which decoded
    it. This returns either bytes an allowed decoder has just read in full,
    or None -- never "whatever came in".

JPEG and PNG pass through unchanged, so report photos lose nothing: they
have just been fully decoded by the JPEG or PNG decoder under the
restriction, so what is handed on is a valid JPEG or PNG file. Every other
allowed format is re-encoded by Pillow's own encoder from decoded pixels.
If that pass-through ever needs a stronger guarantee, re-encoding JPEG and
PNG as well is the conservative alternative.
"""

from __future__ import annotations

import io
import logging
import threading
from typing import Iterable

logger = logging.getLogger(__name__)

#: What an uploaded image may be, as Pillow format names. Mirrors
#: ``IMAGE_UPLOAD_EXTENSIONS`` in routers/workflow_helpers.py (jpg, jpeg, png,
#: gif, webp, bmp, tif, tiff, heic, heif) plus AVIF, which the Projektbericht
#: already lists. MPO is how Pillow reports the multi-picture JPEGs that phone
#: cameras write; it is opened by the JPEG plugin and is JPEG on the wire.
UPLOAD_IMAGE_FORMATS: tuple[str, ...] = (
    "JPEG", "MPO", "PNG", "GIF", "WEBP", "BMP", "TIFF", "HEIF", "AVIF",
)

#: A drawn signature comes off a canvas or a signature pad. Nothing legitimate
#: produces a TIFF or a BMP of one, so the surface is narrower still.
SIGNATURE_IMAGE_FORMATS: tuple[str, ...] = ("PNG", "JPEG", "WEBP")

#: Formats whose bytes may be passed through unchanged; see the module note.
_PASSTHROUGH_FORMATS = frozenset({"JPEG", "MPO", "PNG"})

_heif_lock = threading.Lock()
_heif_registered = False


def _register_heif() -> None:
    """Teach Pillow HEIF/AVIF, once, if pillow-heif is installed."""
    global _heif_registered
    if _heif_registered:
        return
    with _heif_lock:
        if _heif_registered:
            return
        try:
            import pillow_heif

            pillow_heif.register_heif_opener()
        except Exception:  # noqa: BLE001 - missing HEIF support costs HEIF, nothing else
            logger.warning("pillow-heif unavailable; HEIC/HEIF uploads cannot be decoded")
        _heif_registered = True


def _registered(formats: Iterable[str]) -> tuple[str, ...]:
    """The subset of ``formats`` Pillow can actually open right now.

    Not optional: naming an unregistered format in ``Image.open(formats=...)``
    raises ``KeyError`` for EVERY image, a valid PNG included (measured). A
    hard-coded list would therefore turn "pillow-heif failed to import" into
    "no photo in the app opens".
    """
    from PIL import Image

    wanted = tuple(f.upper() for f in formats)
    if any(f in ("HEIF", "AVIF") for f in wanted):
        _register_heif()
    Image.init()
    return tuple(f for f in wanted if f in Image.OPEN)


def open_untrusted_image(data: bytes, formats: Iterable[str] = UPLOAD_IMAGE_FORMATS):
    """``Image.open`` over bytes from outside, restricted to ``formats``.

    Raises ``PIL.UnidentifiedImageError`` for anything else, before any code of
    a disallowed plugin runs. Use as a context manager, like ``Image.open``.
    """
    from PIL import Image

    return Image.open(io.BytesIO(data), formats=_registered(formats))


def safe_image_bytes(data: bytes, formats: Iterable[str] = UPLOAD_IMAGE_FORMATS) -> bytes | None:
    """Bytes another library may decode unrestricted, or None.

    The image is fully decoded here first (``load()``), so a truncated or
    malformed file fails in our hands, under the restriction, rather than in
    ReportLab's. Pillow's decompression-bomb guard applies to that load.
    """
    if not data:
        return None
    from PIL import Image

    try:
        with open_untrusted_image(data, formats) as image:
            image.load()
            if image.format in _PASSTHROUGH_FORMATS:
                return data
            # Re-encode from pixels with Pillow's own encoder: the output is a
            # file this process wrote, so its first bytes are known.
            keep_alpha = image.mode in ("RGBA", "LA") or (
                image.mode == "P" and "transparency" in image.info
            )
            out = io.BytesIO()
            if keep_alpha:
                image.convert("RGBA").save(out, format="PNG", optimize=True)
            else:
                image.convert("RGB").save(out, format="JPEG", quality=90)
            return out.getvalue()
    except Image.DecompressionBombError:
        logger.warning("Refusing an image over Pillow's decompression-bomb limit")
        return None
    except Exception:  # noqa: BLE001 - every failure is the same answer: not safe
        return None
