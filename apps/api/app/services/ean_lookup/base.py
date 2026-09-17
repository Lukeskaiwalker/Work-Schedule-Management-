"""What an external GTIN source may tell us, and what it may never do.

A provider answers one question — "what product is this barcode?" — and the
answer is a *suggestion*, shown to a person with a box in their hands who can
correct it before saving. Everything in this module exists to keep it that
weak, because the failure that matters is not a missing suggestion but a
confident wrong one: an article created under the wrong name is a shelf label
that sends the next person to the wrong bin, and nobody re-checks it.

Three rules every provider obeys:

**Never guess the identity.** A hit whose ``ean`` is not the code we asked
about is discarded by the cascade, not ranked lower. Search engines return
"close" products all the time and a near-miss is a different article.

**Never raise.** A provider that is down, slow, rate-limited or returning HTML
where JSON was promised must answer ``None``. Saving an article cannot be
blocked by a webshop.

**Never carry a credential to a scraper.** ``api_key`` reaches the configured
database provider only. The webshop is public and stays that way.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol

from app.services.material_catalog_images import is_public_http_url

# Caps on anything a remote source is allowed to put in front of a person.
# Product titles from a shop page can be a paragraph long, and the column is
# 500 chars; truncating here keeps a scrape from failing an INSERT.
MAX_NAME_LENGTH = 300
MAX_MANUFACTURER_LENGTH = 160
MAX_UNIT_LENGTH = 32
MAX_URL_LENGTH = 1000


@dataclass(frozen=True)
class EanLookupHit:
    """One product a provider recognised, already trimmed to our columns.

    ``source`` names the provider ("unielektro_shop", "ean_search", …) and
    ends up in the article's notes, so months later the answer to "where did
    this name come from?" is on the row rather than in a log nobody kept.
    """

    item_name: str
    ean: str
    source: str
    manufacturer: str | None = None
    unit: str | None = None
    image_url: str | None = None
    source_url: str | None = None


class EanLookupProvider(Protocol):
    """Anything that can turn a GTIN into a suggestion, or into ``None``."""

    name: str

    def lookup(self, ean: str) -> EanLookupHit | None:  # pragma: no cover - protocol
        ...


def clean_text(value: Any, *, limit: int) -> str | None:
    """Collapse remote text to a single trimmed line, or ``None``.

    Newlines and runs of whitespace come back from both JSON-LD blobs and
    ``og:title`` tags; a name with a newline in it breaks every list this
    article will ever appear in.
    """
    if not isinstance(value, str):
        return None
    collapsed = " ".join(value.split())
    if not collapsed:
        return None
    return collapsed[:limit]


def clean_url(value: Any) -> str | None:
    """A remote URL we are willing to render, or ``None``.

    Every provider's URLs go through here, not just the scraper's. A community
    GTIN database is third-party-writable — anyone can submit a record — and
    its ``origin`` field ends up as the ``href`` of "Quelle ansehen" in an
    authenticated office session and as the ``src`` of an image tag. React
    renders a ``javascript:`` href with a console warning rather than blocking
    it, and an ``http://192.168.x`` URL would be fetched by the office browser
    from inside the network. The SSRF guard already answers exactly this
    question ("is this a public http(s) address"), so it answers it here too,
    once, for every provider.
    """
    url = clean_text(value, limit=MAX_URL_LENGTH)
    if not url or not is_public_http_url(url):
        return None
    return url


def build_hit(
    *,
    ean: str,
    item_name: Any,
    source: str,
    manufacturer: Any = None,
    unit: Any = None,
    image_url: Any = None,
    source_url: Any = None,
) -> EanLookupHit | None:
    """Assemble a hit, or ``None`` when there is no usable name.

    A suggestion with no name is not a suggestion — it would prefill an empty
    form and claim a source for it, which is worse than saying nothing.
    """
    name = clean_text(item_name, limit=MAX_NAME_LENGTH)
    if not name:
        return None
    return EanLookupHit(
        item_name=name,
        ean=ean,
        source=source,
        manufacturer=clean_text(manufacturer, limit=MAX_MANUFACTURER_LENGTH),
        unit=clean_text(unit, limit=MAX_UNIT_LENGTH),
        image_url=clean_url(image_url),
        source_url=clean_url(source_url),
    )
