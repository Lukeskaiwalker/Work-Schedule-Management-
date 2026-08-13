"""Transcode camera formats a browser cannot draw into one it can.

Exists for exactly one reason: iPhones shoot HEIC by default, the crew
photographs everything on iPhones, and no mainstream browser except Safari can
render HEIC. Before this, a photo had two possible fates and both were wrong —
served inline it drew nothing, and refused inline it downgraded to an
attachment, so tapping a picture downloaded it instead of showing it.

Only the *preview* is transcoded. Download always hands back the original
bytes: that file is what the customer's photo actually is, and re-encoding
would lose quality and strip the EXIF that says when and where it was taken.
"""

from __future__ import annotations

import io
import logging
import os
import threading

logger = logging.getLogger(__name__)

# Content types that need converting before a browser will draw them.
TRANSCODE_SOURCE_TYPES = frozenset({"image/heic", "image/heif", "image/heic-sequence"})

PREVIEW_MEDIA_TYPE = "image/jpeg"
PREVIEW_QUALITY = 85

# A phone photo is a few MB; a 60 MB "image" is either a burst container or
# something pathological, and decoding it would tie up a worker. Past this the
# caller falls back to serving the original as a download, which at least gets
# the user their file.
MAX_SOURCE_BYTES = 60 * 1024 * 1024

# Guards against a decompression bomb: a small file that claims enormous
# dimensions. Pillow warns above ~89 Mpx by default; this is a hard refusal
# well under any real camera.
MAX_PIXELS = 50_000_000

# How many transcodes may run at once, process-wide.
#
# Decoding is the expensive part and it is expensive in RAM, not just CPU: a
# 12 Mpx iPhone photo peaks around 200-340 MB inside the api container, and a
# 24 Mpx one roughly doubles that. The container is capped at 1500 MB with swap
# disabled and idles near 840 MB, so the honest budget is one decode at a time.
#
# Nothing upstream bounds this. `preview_file` is a sync handler, so FastAPI
# runs it in the anyio threadpool (40 slots) across ``API_WORKERS`` processes,
# and the gallery renders every tile at once with no virtualisation — one tap
# on a project holding 33 HEIC photos would otherwise start 33 simultaneous
# decodes and hand the cgroup OOM killer an easy target. Killing the api takes
# the app down for everyone, not just the person who opened the gallery.
#
# Raise it only alongside the container's mem_limit.
PREVIEW_TRANSCODE_CONCURRENCY = max(1, int(os.getenv("PREVIEW_TRANSCODE_CONCURRENCY", "1") or 1))

_transcode_slots = threading.BoundedSemaphore(PREVIEW_TRANSCODE_CONCURRENCY)


def needs_transcode(media_type: str | None) -> bool:
    return (media_type or "").strip().lower() in TRANSCODE_SOURCE_TYPES


def transcode_to_jpeg(data: bytes) -> bytes | None:
    """HEIC/HEIF bytes → JPEG bytes, or ``None`` when it cannot be done.

    Returning None rather than raising is deliberate: a photo that will not
    decode is not an error worth a 500. The caller falls back to serving the
    original, so the worst case stays exactly what the behaviour was before.

    EXIF orientation is applied rather than copied, because the flag itself is
    dropped on the way out — a JPEG carrying no EXIF but tagged "rotate 90"
    would display sideways in half the places it appears.
    """

    if not data or len(data) > MAX_SOURCE_BYTES:
        return None

    # Shed load rather than queue it. Waiting for a slot would hold the request
    # open and pile up threads, which is the same resource exhaustion one step
    # removed; refusing immediately falls through to serving the original as a
    # download — precisely the behaviour before this feature existed. A busy
    # gallery therefore degrades to "some tiles download instead of drawing",
    # never to "the api is dead".
    if not _transcode_slots.acquire(blocking=False):
        logger.info("Preview transcode slots busy; serving the original")
        return None

    try:
        import pillow_heif
        from PIL import Image, ImageOps

        pillow_heif.register_heif_opener()

        with Image.open(io.BytesIO(data)) as image:
            width, height = image.size
            if width * height > MAX_PIXELS:
                logger.warning("Refusing to transcode %dx%d image preview", width, height)
                return None

            # Bakes the orientation into the pixels and drops the tag.
            image = ImageOps.exif_transpose(image)
            # JPEG has no alpha channel; without this a transparent source
            # raises rather than flattening.
            if image.mode not in ("RGB", "L"):
                image = image.convert("RGB")

            out = io.BytesIO()
            image.save(out, format="JPEG", quality=PREVIEW_QUALITY, optimize=True)
            return out.getvalue()
    except Exception:
        # Pillow raises a wide and version-dependent set of exceptions for a
        # malformed image, and none of them should take down a file request.
        logger.warning("HEIC preview transcode failed; serving the original", exc_info=True)
        return None
    finally:
        _transcode_slots.release()
