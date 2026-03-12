from __future__ import annotations

import html
import ipaddress
import json
import mimetypes
import re
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import quote_plus, urljoin, urlparse

import httpx

EAN_RE = re.compile(r"^\d{8,14}$")
UNIELEKTRO_ARTICLE_NO_RE = re.compile(r"^\d{8}$")
EXTERNAL_KEY_RE = re.compile(r"^[a-f0-9]{40}$")
RSS_LINK_RE = re.compile(r"<link>([^<]+)</link>", re.IGNORECASE)
META_IMAGE_RE = re.compile(
    r"<meta[^>]+(?:property|name)\s*=\s*[\"'](?:og:image|twitter:image|twitter:image:src)[\"'][^>]+content\s*=\s*[\"']([^\"']+)[\"']",
    re.IGNORECASE,
)
LINK_IMAGE_RE = re.compile(
    r"<link[^>]+rel\s*=\s*[\"']image_src[\"'][^>]+href\s*=\s*[\"']([^\"']+)[\"']",
    re.IGNORECASE,
)
IMG_SRC_RE = re.compile(r"<img[^>]+src\s*=\s*[\"']([^\"']+)[\"']", re.IGNORECASE)
INVALID_IMAGE_KEYWORDS = (
    "logo",
    "sprite",
    "placeholder",
    "favicon",
    "tracking",
    "pixel",
    "blank",
)
PRODUCT_IMAGE_HINTS = ("product", "artikel", "article", "item", "shop")
MANUFACTURER_DOMAIN_OVERRIDES: dict[str, tuple[str, ...]] = {
    "abb": ("abb.com", "new.abb.com"),
    "siemens": ("siemens.com",),
    "hager": ("hager.com",),
    "schneider electric": ("se.com", "schneider-electric.com"),
    "wago": ("wago.com",),
    "legrand": ("legrand.com",),
    "mennekes": ("mennekes.de", "mennekes.com"),
    "phoenix contact": ("phoenixcontact.com",),
    "riegel": ("riegel.de",),
}
USER_AGENT = "SMPLMaterialCatalogBot/1.0 (+https://localhost)"
CATALOG_IMAGE_CACHE_SUBDIR = "material_catalog_images"
CATALOG_IMAGE_MAX_BYTES = 8 * 1024 * 1024
CATALOG_IMAGE_PUBLIC_URL_PREFIX = "/api/materials/catalog/images/"
IMAGE_CONTENT_TYPE_TO_EXT: dict[str, str] = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
}
IMAGE_EXT_TO_CONTENT_TYPE: dict[str, str] = {ext: content_type for content_type, ext in IMAGE_CONTENT_TYPE_TO_EXT.items()}


@dataclass(slots=True)
class MaterialImageLookupResult:
    image_url: str
    source: str


@dataclass(slots=True)
class MaterialImageCacheResult:
    public_url: str
    stored_path: str
    content_type: str
    byte_size: int


@dataclass(slots=True)
class CachedMaterialImageFile:
    path: Path
    content_type: str


def resolve_material_catalog_image(
    *,
    ean: str | None,
    manufacturer: str | None,
    item_name: str | None = None,
    article_no: str | None = None,
) -> MaterialImageLookupResult | None:
    return resolve_material_catalog_image_fallback(
        ean=ean,
        manufacturer=manufacturer,
        item_name=item_name,
        article_no=article_no,
    )


def resolve_material_catalog_image_unielektro(
    *,
    ean: str | None,
    manufacturer: str | None = None,
    item_name: str | None = None,
    article_no: str | None = None,
) -> MaterialImageLookupResult | None:
    normalized_ean = _normalize_ean(ean)
    if not normalized_ean:
        return None
    timeout = httpx.Timeout(connect=2.0, read=4.0, write=4.0, pool=2.0)
    headers = {"User-Agent": USER_AGENT, "Accept": "text/html,application/json;q=0.9,*/*;q=0.8"}
    try:
        with httpx.Client(timeout=timeout, follow_redirects=True, headers=headers) as client:
            return _lookup_on_unielektro(
                client,
                ean=normalized_ean,
                article_no=article_no,
                item_name=item_name,
            )
    except httpx.HTTPError:
        return None


def is_unielektro_article_no(article_no: str | None) -> bool:
    """Return True if *article_no* is exactly 8 ASCII digits (Unielektro format)."""
    return bool(UNIELEKTRO_ARTICLE_NO_RE.fullmatch((article_no or "").strip()))


def resolve_material_catalog_image_unielektro_by_article_no(
    article_no: str | None,
) -> MaterialImageLookupResult | None:
    """Look up the first product image on the Unielektro navigator page for *article_no*.

    This is a direct hotlink lookup: we fetch the navigator search result page and
    return the URL of the first non-logo <img src> we find.  The caller stores the
    URL as-is so that no download happens here; the existing caching daemon will
    convert it to a local file on the next sync pass.
    """
    if not is_unielektro_article_no(article_no):
        return None
    normalized = (article_no or "").strip()
    url = f"https://www.unielektro.de/navigator?query={quote_plus(normalized)}"
    timeout = httpx.Timeout(connect=2.0, read=5.0, write=5.0, pool=2.0)
    headers = {"User-Agent": USER_AGENT, "Accept": "text/html,*/*;q=0.8"}
    try:
        with httpx.Client(timeout=timeout, follow_redirects=True, headers=headers) as client:
            img_url = _first_product_img_src(client, url)
            if img_url:
                return MaterialImageLookupResult(image_url=img_url, source="unielektro_article_no")
    except httpx.HTTPError:
        pass
    return None


def resolve_material_catalog_image_fallback(
    *,
    ean: str | None,
    manufacturer: str | None,
    item_name: str | None = None,
    article_no: str | None = None,
) -> MaterialImageLookupResult | None:
    normalized_ean = _normalize_ean(ean)
    if not normalized_ean:
        return None
    timeout = httpx.Timeout(connect=2.0, read=4.0, write=4.0, pool=2.0)
    headers = {"User-Agent": USER_AGENT, "Accept": "text/html,application/json;q=0.9,*/*;q=0.8"}
    try:
        with httpx.Client(timeout=timeout, follow_redirects=True, headers=headers) as client:
            manufacturer_hit = _lookup_on_manufacturer_site(
                client,
                ean=normalized_ean,
                manufacturer=manufacturer,
                article_no=article_no,
            )
            if manufacturer_hit is not None:
                return manufacturer_hit
            return _lookup_open_ean_sources(client, ean=normalized_ean, item_name=item_name)
    except httpx.HTTPError:
        return None


def cache_material_catalog_image(
    *,
    image_url: str,
    external_key: str,
    uploads_dir: str,
) -> MaterialImageCacheResult | None:
    normalized_key = normalize_material_catalog_image_external_key(external_key)
    if not normalized_key:
        return None
    candidate_url = str(image_url or "").strip()
    if not _is_public_http_url(candidate_url):
        return None

    cache_dir = _material_catalog_image_cache_dir(uploads_dir)
    try:
        cache_dir.mkdir(parents=True, exist_ok=True)
    except OSError:
        return None

    timeout = httpx.Timeout(connect=2.0, read=6.0, write=6.0, pool=2.0)
    headers = {"User-Agent": USER_AGENT, "Accept": "image/*;q=0.9,*/*;q=0.1"}
    try:
        with httpx.Client(timeout=timeout, follow_redirects=True, headers=headers) as client:
            with client.stream("GET", candidate_url) as response:
                if response.status_code != 200:
                    return None
                content_type = _normalized_image_content_type(
                    response.headers.get("content-type"),
                    url=candidate_url,
                )
                if not content_type:
                    return None
                extension = IMAGE_CONTENT_TYPE_TO_EXT.get(content_type)
                if not extension:
                    return None
                declared_length = _parse_content_length(response.headers.get("content-length"))
                if declared_length is not None and declared_length > CATALOG_IMAGE_MAX_BYTES:
                    return None
                temp_path = cache_dir / f"{normalized_key}.{extension}.tmp"
                total_bytes = 0
                try:
                    with temp_path.open("wb") as handle:
                        for chunk in response.iter_bytes():
                            if not chunk:
                                continue
                            total_bytes += len(chunk)
                            if total_bytes > CATALOG_IMAGE_MAX_BYTES:
                                temp_path.unlink(missing_ok=True)
                                return None
                            handle.write(chunk)
                except OSError:
                    temp_path.unlink(missing_ok=True)
                    return None
                if total_bytes <= 0:
                    temp_path.unlink(missing_ok=True)
                    return None
                final_path = cache_dir / f"{normalized_key}.{extension}"
                _remove_cached_material_image_variants(cache_dir, normalized_key, keep={final_path.name, temp_path.name})
                final_path.unlink(missing_ok=True)
                temp_path.replace(final_path)
                _remove_cached_material_image_variants(cache_dir, normalized_key, keep={final_path.name})
                return MaterialImageCacheResult(
                    public_url=f"{CATALOG_IMAGE_PUBLIC_URL_PREFIX}{normalized_key}",
                    stored_path=str(final_path),
                    content_type=content_type,
                    byte_size=total_bytes,
                )
    except httpx.HTTPError:
        return None
    return None


def resolve_cached_material_catalog_image_file(*, external_key: str, uploads_dir: str) -> CachedMaterialImageFile | None:
    normalized_key = normalize_material_catalog_image_external_key(external_key)
    if not normalized_key:
        return None
    cache_dir = _material_catalog_image_cache_dir(uploads_dir)
    if not cache_dir.exists() or not cache_dir.is_dir():
        return None
    candidates = sorted(path for path in cache_dir.glob(f"{normalized_key}.*") if path.is_file())
    for candidate in candidates:
        if candidate.suffix.lower() == ".tmp":
            continue
        extension = candidate.suffix.lower().lstrip(".")
        content_type = IMAGE_EXT_TO_CONTENT_TYPE.get(extension)
        if not content_type:
            guessed, _ = mimetypes.guess_type(candidate.name)
            if guessed and guessed.lower().startswith("image/"):
                content_type = guessed.lower()
        if not content_type:
            continue
        return CachedMaterialImageFile(path=candidate, content_type=content_type)
    return None


def has_cached_material_catalog_image(*, external_key: str, uploads_dir: str) -> bool:
    return resolve_cached_material_catalog_image_file(external_key=external_key, uploads_dir=uploads_dir) is not None


def normalize_material_catalog_image_external_key(value: str | None) -> str | None:
    normalized = str(value or "").strip().lower()
    if not EXTERNAL_KEY_RE.fullmatch(normalized):
        return None
    return normalized


def _first_product_img_src(client: httpx.Client, page_url: str) -> str | None:
    """Return the URL of the first non-logo/non-invalid <img src> found in *page_url*.

    Iterates `<img src="...">` tags in document order and returns the first
    candidate that passes the INVALID_IMAGE_KEYWORDS filter and is a public
    HTTP(S) URL.  Returns None if no suitable image is found or the request
    fails.
    """
    if not _is_public_http_url(page_url):
        return None
    try:
        response = client.get(page_url)
    except httpx.HTTPError:
        return None
    if response.status_code != 200:
        return None
    content_type = (response.headers.get("content-type") or "").lower()
    if content_type and "html" not in content_type:
        return None
    resolved_url = str(response.url)
    for match in IMG_SRC_RE.finditer(response.text):
        token = html.unescape(str(match.group(1)).strip())
        if not token:
            continue
        candidate = urljoin(resolved_url, token)
        if not _is_public_http_url(candidate):
            continue
        if any(kw in candidate.lower() for kw in INVALID_IMAGE_KEYWORDS):
            continue
        return candidate
    return None


def _lookup_on_unielektro(
    client: httpx.Client,
    *,
    ean: str,
    article_no: str | None,
    item_name: str | None,
) -> MaterialImageLookupResult | None:
    for query in (f"site:unielektro.de {ean}", f"site:shop.unielektro.de {ean}"):
        for link in _bing_search_links(client, query):
            if not (_url_host_matches_domain(link, "unielektro.de") or _url_host_matches_domain(link, "shop.unielektro.de")):
                continue
            image_url = _extract_best_image_from_page(
                client,
                link,
                ean=ean,
                article_no=article_no,
                item_name=item_name,
                allow_barcode=False,
            )
            if image_url:
                return MaterialImageLookupResult(image_url=image_url, source="unielektro_ean")

    search_url = f"https://www.unielektro.de/search?sSearch={quote_plus(ean)}"
    image_url = _extract_best_image_from_page(
        client,
        search_url,
        ean=ean,
        article_no=article_no,
        item_name=item_name,
        allow_barcode=False,
    )
    if image_url:
        return MaterialImageLookupResult(image_url=image_url, source="unielektro_ean")
    return None


def _lookup_on_manufacturer_site(
    client: httpx.Client,
    *,
    ean: str,
    manufacturer: str | None,
    article_no: str | None,
) -> MaterialImageLookupResult | None:
    domains = _manufacturer_domain_candidates(manufacturer)
    if not domains:
        return None
    for domain in domains[:2]:
        query = f"site:{domain} {ean}"
        for link in _bing_search_links(client, query):
            if not _url_host_matches_domain(link, domain):
                continue
            image_url = _extract_best_image_from_page(
                client,
                link,
                ean=ean,
                article_no=article_no,
                allow_barcode=False,
            )
            if image_url:
                return MaterialImageLookupResult(image_url=image_url, source="manufacturer_site")
    return None


def _lookup_open_ean_sources(
    client: httpx.Client,
    *,
    ean: str,
    item_name: str | None,
) -> MaterialImageLookupResult | None:
    open_food_facts_url = f"https://world.openfoodfacts.org/api/v2/product/{ean}.json"
    try:
        response = client.get(open_food_facts_url)
        if response.status_code == 200:
            payload = json.loads(response.text or "{}")
            product = payload.get("product") if isinstance(payload, dict) else None
            if isinstance(product, dict):
                for key in ("image_front_url", "image_url", "image_front_small_url", "image_small_url"):
                    candidate = str(product.get(key) or "").strip()
                    if _is_public_http_url(candidate):
                        return MaterialImageLookupResult(image_url=candidate, source="open_ean_database")
    except (json.JSONDecodeError, httpx.HTTPError):
        pass

    upc_item_db_url = f"https://www.upcitemdb.com/upc/{ean}"
    product_image = _extract_upcitemdb_product_image(client, upc_item_db_url)
    if product_image:
        return MaterialImageLookupResult(image_url=product_image, source="open_ean_database")

    generic_image = _extract_best_image_from_page(
        client,
        upc_item_db_url,
        ean=ean,
        article_no=None,
        item_name=item_name,
        allow_barcode=True,
    )
    if generic_image:
        return MaterialImageLookupResult(image_url=generic_image, source="open_ean_database")
    return None


def _extract_upcitemdb_product_image(client: httpx.Client, url: str) -> str | None:
    try:
        response = client.get(url)
    except httpx.HTTPError:
        return None
    if response.status_code != 200:
        return None
    match = re.search(r'<img[^>]+class="product"[^>]+src="([^"]+)"', response.text, re.IGNORECASE)
    if not match:
        return None
    candidate = urljoin(str(response.url), html.unescape(match.group(1).strip()))
    lowered = candidate.lower()
    if "resize.jpg" in lowered or "placeholder" in lowered:
        return None
    if not _is_public_http_url(candidate):
        return None
    return candidate


def _bing_search_links(client: httpx.Client, query: str) -> list[str]:
    url = f"https://www.bing.com/search?format=rss&q={quote_plus(query)}"
    try:
        response = client.get(url)
    except httpx.HTTPError:
        return []
    if response.status_code != 200:
        return []
    links: list[str] = []
    seen: set[str] = set()
    for match in RSS_LINK_RE.findall(response.text):
        candidate = html.unescape(match.strip())
        if not _is_public_http_url(candidate):
            continue
        host = (urlparse(candidate).hostname or "").lower()
        if not host or host.endswith("bing.com"):
            continue
        if candidate in seen:
            continue
        seen.add(candidate)
        links.append(candidate)
        if len(links) >= 3:
            break
    return links


def _extract_best_image_from_page(
    client: httpx.Client,
    page_url: str,
    *,
    ean: str,
    article_no: str | None,
    item_name: str | None = None,
    allow_barcode: bool,
) -> str | None:
    if not _is_public_http_url(page_url):
        return None
    try:
        response = client.get(page_url)
    except httpx.HTTPError:
        return None
    if response.status_code != 200:
        return None
    content_type = (response.headers.get("content-type") or "").lower()
    resolved_page_url = str(response.url)
    if content_type.startswith("image/") and _is_public_http_url(resolved_page_url):
        return resolved_page_url
    if "html" not in content_type and content_type:
        return None

    candidates: list[str] = []
    for matcher in (META_IMAGE_RE, LINK_IMAGE_RE, IMG_SRC_RE):
        for match in matcher.findall(response.text):
            token = html.unescape(str(match).strip())
            if not token:
                continue
            candidate = urljoin(resolved_page_url, token)
            if not _is_public_http_url(candidate):
                continue
            candidates.append(candidate)
    if not candidates:
        return None

    article_token = _normalize_article_token(article_no)
    item_tokens = _normalize_item_tokens(item_name)
    scored: list[tuple[int, str]] = []
    seen: set[str] = set()
    for candidate in candidates:
        if candidate in seen:
            continue
        seen.add(candidate)
        score = _score_image_candidate(
            candidate,
            ean=ean,
            article_token=article_token,
            item_tokens=item_tokens,
            allow_barcode=allow_barcode,
        )
        scored.append((score, candidate))
    scored.sort(key=lambda row: row[0], reverse=True)
    best_score, best_candidate = scored[0]
    if best_score <= 0:
        return None
    return best_candidate


def _score_image_candidate(
    url: str,
    *,
    ean: str,
    article_token: str | None,
    item_tokens: set[str],
    allow_barcode: bool,
) -> int:
    lowered = url.lower()
    score = 1
    if lowered.endswith((".jpg", ".jpeg", ".png", ".webp")):
        score += 2
    if lowered.endswith(".gif"):
        score -= 1
    if ean and ean in lowered:
        score += 5
    if article_token and article_token in lowered:
        score += 3
    if item_tokens and any(token in lowered for token in item_tokens):
        score += 2
    if any(keyword in lowered for keyword in PRODUCT_IMAGE_HINTS):
        score += 1
    if "barcode" in lowered:
        score += 1 if allow_barcode else -4
    if any(keyword in lowered for keyword in INVALID_IMAGE_KEYWORDS):
        score -= 2
    return score


def _manufacturer_domain_candidates(manufacturer: str | None) -> list[str]:
    normalized = re.sub(r"[^a-z0-9]+", " ", (manufacturer or "").strip().lower()).strip()
    if not normalized:
        return []
    candidates: list[str] = []
    if normalized in MANUFACTURER_DOMAIN_OVERRIDES:
        candidates.extend(MANUFACTURER_DOMAIN_OVERRIDES[normalized])
    parts = [part for part in normalized.split() if part]
    if parts:
        primary = parts[0]
        if primary in MANUFACTURER_DOMAIN_OVERRIDES:
            candidates.extend(MANUFACTURER_DOMAIN_OVERRIDES[primary])
        if len(primary) >= 2:
            candidates.append(f"{primary}.com")
            candidates.append(f"{primary}.de")
        if len(parts) >= 2:
            combined = "".join(parts[:2])
            candidates.append(f"{combined}.com")
    deduped: list[str] = []
    seen: set[str] = set()
    for candidate in candidates:
        domain = candidate.strip().lower()
        if not domain or "." not in domain or domain in seen:
            continue
        seen.add(domain)
        deduped.append(domain)
    return deduped


def _url_host_matches_domain(url: str, domain: str) -> bool:
    host = (urlparse(url).hostname or "").lower()
    candidate = domain.strip().lower()
    if not host or not candidate:
        return False
    return host == candidate or host.endswith(f".{candidate}")


def _is_public_http_url(url: str) -> bool:
    parsed = urlparse(url)
    if parsed.scheme.lower() not in {"http", "https"}:
        return False
    host = (parsed.hostname or "").strip().lower()
    if not host:
        return False
    if host in {"localhost"} or host.endswith(".local"):
        return False
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return True
    return not (ip.is_loopback or ip.is_private or ip.is_link_local or ip.is_reserved or ip.is_multicast)


def _normalize_ean(value: str | None) -> str | None:
    token = re.sub(r"\D+", "", value or "")
    if not token:
        return None
    if not EAN_RE.fullmatch(token):
        return None
    return token


def _normalize_article_token(value: str | None) -> str | None:
    raw = re.sub(r"[^a-z0-9]+", "", (value or "").strip().lower())
    if len(raw) < 3:
        return None
    return raw


def _normalize_item_tokens(value: str | None) -> set[str]:
    normalized = re.sub(r"[^a-z0-9]+", " ", (value or "").strip().lower())
    tokens: set[str] = set()
    for token in normalized.split():
        if len(token) < 4:
            continue
        if token.isdigit():
            continue
        tokens.add(token)
        if len(tokens) >= 5:
            break
    return tokens


def _material_catalog_image_cache_dir(uploads_dir: str) -> Path:
    return Path(uploads_dir).expanduser().resolve() / CATALOG_IMAGE_CACHE_SUBDIR


def _parse_content_length(raw: str | None) -> int | None:
    if raw is None:
        return None
    try:
        parsed = int(str(raw).strip())
    except (TypeError, ValueError):
        return None
    if parsed < 0:
        return None
    return parsed


def _normalized_image_content_type(raw: str | None, *, url: str) -> str | None:
    header_type = str(raw or "").split(";", 1)[0].strip().lower()
    if header_type in IMAGE_CONTENT_TYPE_TO_EXT:
        return header_type
    guessed, _ = mimetypes.guess_type(url)
    guessed_type = (guessed or "").strip().lower()
    if guessed_type in IMAGE_CONTENT_TYPE_TO_EXT:
        return guessed_type
    return None


def _remove_cached_material_image_variants(cache_dir: Path, external_key: str, *, keep: set[str]) -> None:
    for candidate in cache_dir.glob(f"{external_key}.*"):
        if not candidate.is_file():
            continue
        if candidate.name in keep:
            continue
        candidate.unlink(missing_ok=True)
