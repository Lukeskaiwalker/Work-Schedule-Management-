"""The public Unielektro webshop, read as a product database.

Unielektro is where this workshop actually buys, so their shop knows the
electrical parts a general GTIN database does not: a WAGO terminal block or a
Hager breaker is in there under the name the wholesaler prints on the invoice,
which is the name the person at the rack expects to read back.

It is a *scrape*, with everything that implies, and the design answers that in
one place — the GTIN check. A search engine's idea of "relevant" and a shop's
idea of "similar products you may like" both produce pages for the wrong
article, so a page is only ever accepted when it states a GTIN of its own and
that GTIN is the one we asked about. No fuzzy name matching, no "close enough",
no first-result-wins. When the markup changes, this returns nothing and the
person types the name — the failure the operator can see and work around.

The GTIN check is necessary and was not sufficient. A *listing* page states
twenty GTINs, one of them ours, and its ``og:title`` is the listing's title —
so "the page mentions our barcode" used to be enough to name an article
"Suchergebnis für 4012345678901". The name must come from the same evidence as
the GTIN: the JSON-LD ``Product`` whose own gtin matched, or the microdata
``Product`` scope the matching ``itemprop`` sits inside. A listing is still
worth fetching — it is the cheapest way to find the product page — but only as
a source of LINKS, never of a name.

No credential is ever sent here. It is a public shop; the anonymous page is
exactly what a customer sees.
"""

from __future__ import annotations

import html
import json
import re
from urllib.parse import quote_plus, urljoin

import httpx

from app.services import gtin
from app.services.ean_lookup.base import EanLookupHit, build_hit
from app.services.ean_lookup.http import Budget, fetch_text
from app.services.material_catalog_images import RSS_LINK_RE, is_public_http_url

NAME = "unielektro_shop"

SHOP_DOMAINS = ("unielektro.de", "shop.unielektro.de")

JSON_LD_RE = re.compile(
    r"<script[^>]+type\s*=\s*[\"']application/ld\+json[\"'][^>]*>(.*?)</script>",
    re.IGNORECASE | re.DOTALL,
)
META_CONTENT_RE = re.compile(
    r"<meta[^>]+(?:property|name|itemprop)\s*=\s*[\"']([^\"']+)[\"'][^>]+content\s*=\s*[\"']([^\"']*)[\"']",
    re.IGNORECASE,
)
# Microdata spelling of the same fact, which the shop emits on some templates:
# <span itemprop="gtin13">4012345678901</span>
MICRODATA_GTIN_RE = re.compile(
    r"itemprop\s*=\s*[\"']gtin(?:8|12|13|14)?[\"'][^>]*>\s*([0-9]{8,14})\s*<",
    re.IGNORECASE,
)
ITEMTYPE_RE = re.compile(r"itemtype\s*=\s*[\"']([^\"']+)[\"']", re.IGNORECASE)
ITEMPROP_TEXT_RE = re.compile(
    r"itemprop\s*=\s*[\"']%s[\"'][^>]*>\s*([^<]{1,300}?)\s*<", re.IGNORECASE
)
ITEMPROP_CONTENT_RE = re.compile(
    r"<meta[^>]+itemprop\s*=\s*[\"']%s[\"'][^>]+content\s*=\s*[\"']([^\"']*)[\"']", re.IGNORECASE
)
HREF_RE = re.compile(r"href\s*=\s*[\"']([^\"'#\s]+)[\"']", re.IGNORECASE)
ITEMPROP_SRC_RE = re.compile(
    r"itemprop\s*=\s*[\"']image[\"'][^>]*src\s*=\s*[\"']([^\"']+)[\"']", re.IGNORECASE
)

GTIN_KEYS = ("gtin13", "gtin", "gtin14", "gtin12", "gtin8", "ean")

# Paths that list products rather than describing one. A page under one of
# these may be read for the links it carries; it is never allowed to name an
# article, because its title is the query, not the product.
LISTING_PATH_MARKERS = ("/search", "/navigator", "/suche", "/katalog", "/kategorie")
LISTING_QUERY_MARKERS = ("ssearch=", "query=", "sfilter")

# How many product links a listing page may contribute. A Shopware result page
# carries dozens of hrefs; the barcode we asked about matches one product, so
# fetching more than a handful is spending the budget to prove the same thing.
MAX_LINKS_FROM_LISTING = 3
MAX_SEARCH_LINKS = 3

# UN/CEFACT codes that turn up in schema.org offers, mapped to the words the
# workshop reads on a shelf. A row that says "14 C62" tells nobody whether that
# is pieces, metres or rolls, so an unmapped code is dropped: no unit is better
# than a unit nobody can read.
UNIT_CODES = {
    "C62": "Stk",
    "H87": "Stk",
    "EA": "Stk",
    "PCE": "Stk",
    "MTR": "m",
    "MTK": "m²",
    "KGM": "kg",
    "LTR": "Liter",
    "RO": "Rolle",
    "PK": "Pak",
    "CT": "Karton",
    "BX": "Karton",
    "SET": "Set",
}


class UnielektroShopProvider:
    """Reads product pages on the wholesaler's own shop. Never raises."""

    name = NAME

    def __init__(self, client: httpx.Client, budget: Budget) -> None:
        self._client = client
        self._budget = budget

    def lookup(self, ean: str) -> EanLookupHit | None:
        """The shop's own pages first; a web search only if they fail.

        In phases, because the phases cost different things. The shop's search
        URL is one request to the wholesaler and often redirects straight onto
        the product; the web search is two round trips to a third party before
        a single product page has been read. Building the candidate list
        eagerly spent both of those first and then found the budget gone — so
        a product the shop describes perfectly well answered "nichts gefunden"
        and was cached as a miss for a day.
        """
        followed: list[str] = []
        hit = self._read_phase(self._shop_urls(ean), ean, collect_links=followed)
        if hit is not None:
            return hit
        if followed:
            hit = self._read_phase(followed, ean)
            if hit is not None:
                return hit
        return self._read_phase(self._search_links(ean), ean)

    def _read_phase(
        self, urls: list[str], ean: str, *, collect_links: list[str] | None = None
    ) -> EanLookupHit | None:
        """Read one phase's pages and return its single agreed hit, if any.

        "Exactly one product page matches": two pages claiming the same GTIN
        under different names means the shop (or the search) is describing two
        things, and picking one would be a coin toss.
        """
        hits: list[EanLookupHit] = []
        for url in urls:
            if self._budget.exhausted:
                break
            hit = self._read_product_page(url, ean, collect_links=collect_links)
            if hit is None:
                continue
            if any(other.item_name.casefold() != hit.item_name.casefold() for other in hits):
                return None
            hits.append(hit)
        return hits[0] if hits else None

    def _shop_urls(self, ean: str) -> list[str]:
        """The wholesaler's own entry points. One request each, no third party."""
        return [
            f"https://www.unielektro.de/search?sSearch={quote_plus(ean)}",
            f"https://www.unielektro.de/navigator?query={quote_plus(ean)}",
        ]

    def _search_links(self, ean: str) -> list[str]:
        """Product pages a web search knows about. The fallback, and it costs.

        Reached only when the shop's own search rendered its results with
        JavaScript, so the HTML we got back carried no product at all.
        """
        links: list[str] = []
        for query in (f"site:unielektro.de {ean}", f"site:shop.unielektro.de {ean}"):
            if self._budget.exhausted:
                break
            for link in self._rss_search(query):
                if _host_is_shop(link) and link not in links:
                    links.append(link)
        return links

    def _rss_search(self, query: str) -> list[str]:
        """Bing's RSS results, read through the same capped transport as the rest.

        ``material_catalog_images.bing_search_links`` reads the whole response
        into memory with no size limit, which is the one fetch in this package
        that a hostile or compromised answer could use to page out a container
        that is capped at 1500 MB with swap off.
        """
        url = f"https://www.bing.com/search?format=rss&q={quote_plus(query)}"
        fetched = fetch_text(self._client, url, self._budget)
        if fetched is None:
            return []
        _final_url, body = fetched
        links: list[str] = []
        for match in RSS_LINK_RE.findall(body):
            candidate = html.unescape(match.strip())
            if not is_public_http_url(candidate):
                continue
            host = (_host_of(candidate) or "").lower()
            if not host or host.endswith("bing.com") or candidate in links:
                continue
            links.append(candidate)
            if len(links) >= MAX_SEARCH_LINKS:
                break
        return links

    def _read_product_page(
        self, url: str, ean: str, *, collect_links: list[str] | None = None
    ) -> EanLookupHit | None:
        fetched = fetch_text(self._client, url, self._budget)
        if fetched is None:
            return None
        final_url, body = fetched
        if not _host_is_shop(final_url):
            return None

        if _is_listing_url(final_url):
            # A listing may still be the cheapest way to the product page, so
            # it is mined for links — but it may never name anything.
            if collect_links is not None:
                _collect_product_links(body, final_url, collect_links)
            return None

        identity = _product_identity(body, ean)
        if identity is None:
            # No GTIN on the page, or one that is not ours, or one that is not
            # attached to a product this page describes. Either way this is not
            # the article we asked about — and a shop page that cannot point at
            # its own product cannot prove it is.
            if collect_links is not None:
                _collect_product_links(body, final_url, collect_links)
            return None

        name, manufacturer, image, unit = identity
        if image:
            image = urljoin(final_url, image)
        return build_hit(
            ean=ean,
            item_name=name,
            source=NAME,
            manufacturer=manufacturer,
            unit=unit,
            image_url=image,
            source_url=final_url,
        )


def _host_is_shop(url: str) -> bool:
    host = (_host_of(url) or "").lower()
    return any(host == domain or host.endswith(f".{domain}") for domain in SHOP_DOMAINS)


def _host_of(url: str) -> str | None:
    """The host, or ``None`` for anything ``httpx.URL`` refuses to parse.

    Hrefs and search results are remote strings, and this package's contract is
    that a provider never raises — so a malformed one answers "not our shop"
    rather than escaping as an InvalidURL from inside a lookup.
    """
    try:
        return httpx.URL(url).host
    except (httpx.InvalidURL, ValueError, UnicodeError):
        return None


def _is_listing_url(url: str) -> bool:
    """Does this URL name a search or a category rather than one product?"""
    try:
        parsed = httpx.URL(url)
    except (httpx.InvalidURL, ValueError, UnicodeError):
        # Unreadable: refuse it as a NAME source, which is the safe direction.
        return True
    path = (parsed.path or "").lower()
    if any(marker in path for marker in LISTING_PATH_MARKERS):
        return True
    raw_query = parsed.query or b""
    query = (
        raw_query.decode("utf-8", errors="replace") if isinstance(raw_query, bytes) else raw_query
    ).lower()
    return any(marker in query for marker in LISTING_QUERY_MARKERS)


def _collect_product_links(body: str, base_url: str, into: list[str]) -> None:
    """Shop links on a listing page that look like products, bounded."""
    for href in HREF_RE.findall(body):
        if len(into) >= MAX_LINKS_FROM_LISTING:
            return
        try:
            candidate = urljoin(base_url, html.unescape(href.strip()))
        except ValueError:
            continue
        if not candidate.lower().startswith("https://"):
            continue
        if not _host_is_shop(candidate) or _is_listing_url(candidate):
            continue
        if candidate in into:
            continue
        into.append(candidate)


def _meta_tags(body: str) -> dict[str, str]:
    tags: dict[str, str] = {}
    for key, value in META_CONTENT_RE.findall(body):
        name = key.strip().lower()
        if name not in tags:
            tags[name] = html.unescape(value.strip())
    return tags


def _json_ld_objects(body: str) -> list[dict]:
    """Every JSON-LD object on the page, graphs and arrays flattened."""
    found: list[dict] = []
    for raw in JSON_LD_RE.findall(body):
        try:
            parsed = json.loads(html.unescape(raw.strip()))
        except (json.JSONDecodeError, ValueError):
            continue
        found.extend(_flatten_json_ld(parsed))
    return found


def _flatten_json_ld(node: object, depth: int = 0) -> list[dict]:
    if depth > 4:
        return []
    if isinstance(node, list):
        flat: list[dict] = []
        for item in node:
            flat.extend(_flatten_json_ld(item, depth + 1))
        return flat
    if isinstance(node, dict):
        flat = [node]
        graph = node.get("@graph")
        if graph is not None:
            flat.extend(_flatten_json_ld(graph, depth + 1))
        return flat
    return []


def _is_product(node: dict) -> bool:
    node_type = node.get("@type")
    if isinstance(node_type, str):
        return node_type.lower() == "product"
    if isinstance(node_type, list):
        return any(isinstance(item, str) and item.lower() == "product" for item in node_type)
    return False


def _matching_json_ld_product(body: str, ean: str) -> dict | None:
    """The Product block whose GTIN is the code we asked about."""
    wanted = _gtin_key(ean)
    for node in _json_ld_objects(body):
        if not _is_product(node):
            continue
        for key in GTIN_KEYS:
            if _gtin_key(node.get(key)) == wanted:
                return node
    return None


def _product_identity(
    body: str, ean: str
) -> tuple[str, str | None, str | None, str | None] | None:
    """``(name, manufacturer, image, unit)`` proven to belong to *ean*.

    Three sources, in descending order of how tightly the name is bound to the
    barcode, and nothing below them. ``og:title`` is a page-level tag: it is
    only trustworthy when the page-level *metadata* is what carried the GTIN,
    which is what a single-product template looks like. Taking it after a
    match found somewhere in the body is how a search-results page became an
    article called after the search.
    """
    product = _matching_json_ld_product(body, ean)
    if product is not None:
        name = _product_name(product)
        if name:
            return name, _product_brand(product), _product_image(product), _product_unit(product)

    metas = _meta_tags(body)
    wanted = _gtin_key(ean)
    head_match = any(_gtin_key(metas.get(key)) == wanted for key in GTIN_KEYS)

    block = _microdata_product_block(body, ean)
    if block is not None:
        name = _itemprop_text(block, "name")
        if name:
            return (
                name,
                _itemprop_text(block, "brand") or _itemprop_text(block, "manufacturer"),
                _itemprop_image(block) or (metas.get("og:image") if head_match else None),
                None,
            )

    if head_match and metas.get("og:title"):
        return (
            metas["og:title"],
            metas.get("product:brand"),
            metas.get("og:image"),
            None,
        )
    return None


def _microdata_gtin_positions(body: str, ean: str) -> tuple[list[re.Match[str]], int]:
    """Matching microdata GTIN occurrences, and how many DISTINCT codes exist.

    The count is the listing test: one product page states one barcode, and a
    page stating twenty is a result list whichever template rendered it.
    """
    wanted = _gtin_key(ean)
    matches: list[re.Match[str]] = []
    distinct: set[str] = set()
    for match in MICRODATA_GTIN_RE.finditer(body):
        key = _gtin_key(match.group(1))
        if key is None:
            continue
        distinct.add(key)
        if key == wanted:
            matches.append(match)
    return matches, len(distinct)


def _microdata_product_block(body: str, ean: str) -> str | None:
    """The ``itemtype="…/Product"`` scope the matching GTIN sits inside.

    Regex, not a parser, so the block is delimited by the nearest preceding
    Product declaration and the next one after it. That is coarse, and it is
    coarse in the safe direction: a GTIN whose nearest enclosing scope is not a
    Product (an accessory teaser, a "customers also bought" tile) answers None
    and the page is refused rather than named from somewhere else on it.
    """
    matches, distinct = _microdata_gtin_positions(body, ean)
    if not matches or distinct > 1:
        return None
    match = matches[0]

    opens = [m for m in ITEMTYPE_RE.finditer(body) if m.start() < match.start()]
    if not opens:
        return None
    nearest = opens[-1]
    if not nearest.group(1).rstrip("/").lower().endswith("/product"):
        return None

    end = len(body)
    for candidate in ITEMTYPE_RE.finditer(body, match.end()):
        if candidate.group(1).rstrip("/").lower().endswith("/product"):
            end = candidate.start()
            break
    return body[nearest.start() : end]


def _itemprop_text(block: str, prop: str) -> str | None:
    """One ``itemprop`` value inside a microdata block, tag or meta."""
    text = ITEMPROP_TEXT_RE.pattern % re.escape(prop)
    found = re.search(text, block, re.IGNORECASE)
    if found and found.group(1).strip():
        return html.unescape(found.group(1).strip())
    meta = re.search(ITEMPROP_CONTENT_RE.pattern % re.escape(prop), block, re.IGNORECASE)
    if meta and meta.group(1).strip():
        return html.unescape(meta.group(1).strip())
    return None


def _itemprop_image(block: str) -> str | None:
    """The picture the same microdata block points at, if it points at one."""
    found = ITEMPROP_SRC_RE.search(block)
    if found and found.group(1).strip():
        return html.unescape(found.group(1).strip())
    return _itemprop_text(block, "image")


def _gtin_key(value: object) -> str | None:
    """Comparable form of a GTIN: EAN-13 where possible, digits otherwise.

    Both sides go through this, so a page stating the UPC-A and a scanner
    emitting the zero-padded EAN-13 still compare equal — they are the same
    barcode. Anything that is not a digit string compares as ``None``, which
    never equals a real code.
    """
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        value = str(int(value))
    if not isinstance(value, str):
        return None
    digits = gtin.digits_only(value)
    if not digits:
        return None
    return gtin.to_ean13(digits) or digits


def _product_name(product: dict | None) -> str | None:
    if product is None:
        return None
    for key in ("name", "title"):
        value = product.get(key)
        if isinstance(value, str) and value.strip():
            return value
    return None


def _product_brand(product: dict | None) -> str | None:
    if product is None:
        return None
    brand = product.get("brand") or product.get("manufacturer")
    if isinstance(brand, str):
        return brand
    if isinstance(brand, dict):
        name = brand.get("name")
        if isinstance(name, str):
            return name
    return None


def _product_image(product: dict | None) -> str | None:
    if product is None:
        return None
    image = product.get("image")
    if isinstance(image, str):
        return image
    if isinstance(image, list):
        for item in image:
            if isinstance(item, str) and item.strip():
                return item
            if isinstance(item, dict) and isinstance(item.get("url"), str):
                return item["url"]
    if isinstance(image, dict) and isinstance(image.get("url"), str):
        return image["url"]
    return None


def _product_unit(product: dict | None) -> str | None:
    """The shop's packing unit, when it states one a person can read.

    Worth carrying because "Rolle" vs "m" is the difference between ordering
    one drum of cable and one metre of it, and the person at the rack has the
    drum in their hands and no way to know what we will call it later. Worth
    dropping when the shop only states a UN/CEFACT code we cannot translate:
    on the station path nobody reviews this field before it is written onto the
    article, and "14 C62" on a Bestand row is worse than no unit at all.
    """
    if product is None:
        return None
    offers = product.get("offers")
    candidates = offers if isinstance(offers, list) else [offers]
    for offer in candidates:
        if not isinstance(offer, dict):
            continue
        for key in ("unitText", "eligibleQuantity"):
            value = offer.get(key)
            if isinstance(value, str) and value.strip():
                return value
            if isinstance(value, dict) and isinstance(value.get("unitText"), str):
                return value["unitText"]
        code = offer.get("unitCode")
        if isinstance(code, str) and code.strip().upper() in UNIT_CODES:
            return UNIT_CODES[code.strip().upper()]
    return None
