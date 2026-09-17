"""The optional paid/free GTIN database, driven entirely by configuration.

Nothing in SMPL depends on one of these existing — the slot is here so buying
a subscription later is a ``.env`` edit rather than a code change, which is
exactly the shape the owner asked for. With ``ean_lookup_provider`` empty this
module is never constructed.

Three shapes are supported because they are the three an electrical workshop
would plausibly buy:

* ``opengtindb`` — free, community-run, German, no paid key (it authenticates
  with a public user id, so the key stays optional);
* ``ean_search`` — commercial, token in the query string;
* ``upcitemdb`` — commercial, key in a header.

The key never leaves this module, and it is never put in a log line. Where a
provider wants it in a query string that is their API's design, not ours; the
URL is built here and goes nowhere else.
"""

from __future__ import annotations

import json
from urllib.parse import quote_plus

import httpx

from app.services.ean_lookup.base import EanLookupHit, build_hit
from app.services.ean_lookup.http import Budget, fetch_text

# The free public user id opengtindb documents for anonymous queries. Overridden
# by `ean_lookup_api_key` when an operator registers their own.
OPENGTINDB_PUBLIC_USER = "400"

SUPPORTED_PROVIDERS = ("opengtindb", "ean_search", "upcitemdb")


class OpenEanDbProvider:
    """One configured GTIN database. Never raises, never blocks a save."""

    def __init__(self, *, provider: str, api_key: str, client: httpx.Client, budget: Budget) -> None:
        self.name = provider
        self._api_key = (api_key or "").strip()
        self._client = client
        self._budget = budget

    def lookup(self, ean: str) -> EanLookupHit | None:
        if self.name not in SUPPORTED_PROVIDERS or self._budget.exhausted:
            return None
        url = self._url(ean)
        if not url:
            return None
        fetched = fetch_text(self._client, url, self._budget)
        if fetched is None:
            return None
        _final_url, body = fetched
        if self.name == "opengtindb":
            return self._parse_opengtindb(body, ean)
        try:
            payload = json.loads(body)
        except (json.JSONDecodeError, ValueError):
            return None
        if self.name == "ean_search":
            return self._parse_ean_search(payload, ean)
        return self._parse_upcitemdb(payload, ean)

    def _url(self, ean: str) -> str | None:
        code = quote_plus(ean)
        if self.name == "opengtindb":
            user = self._api_key or OPENGTINDB_PUBLIC_USER
            return f"https://opengtindb.org/?ean={code}&cmd=query&queryid={quote_plus(user)}"
        if self.name == "ean_search":
            if not self._api_key:
                return None
            return (
                "https://api.ean-search.org/api?op=barcode-lookup&format=json"
                f"&token={quote_plus(self._api_key)}&ean={code}"
            )
        if self.name == "upcitemdb":
            if not self._api_key:
                return None
            return f"https://api.upcitemdb.com/prod/v1/lookup?upc={code}&key={quote_plus(self._api_key)}"
        return None

    # ── Per-provider parsing ──────────────────────────────────────────────
    #
    # Each one verifies the returned code against the query itself. A database
    # answering with a *different* article is not a near miss to be shown with
    # a warning; it is the one outcome that would put a wrong name on a shelf.

    def _parse_opengtindb(self, body: str, ean: str) -> EanLookupHit | None:
        """``key=value`` lines, one per field, latin-1 in practice."""
        fields: dict[str, str] = {}
        for line in body.splitlines():
            if "=" not in line:
                continue
            key, _, value = line.partition("=")
            fields.setdefault(key.strip().lower(), value.strip())
        if fields.get("error") not in (None, "", "0"):
            return None
        if not _same_code(fields.get("ean"), ean):
            return None
        name = " ".join(part for part in (fields.get("name"), fields.get("detailname")) if part)
        return build_hit(
            ean=ean,
            item_name=name,
            source=self.name,
            manufacturer=fields.get("vendor"),
            unit=fields.get("contentsize"),
            source_url=fields.get("origin") or None,
        )

    def _parse_ean_search(self, payload: object, ean: str) -> EanLookupHit | None:
        rows = payload if isinstance(payload, list) else [payload]
        for row in rows:
            if not isinstance(row, dict) or not _same_code(row.get("ean"), ean):
                continue
            return build_hit(
                ean=ean,
                item_name=row.get("name"),
                source=self.name,
                manufacturer=row.get("issuingCountry"),
                image_url=row.get("image"),
            )
        return None

    def _parse_upcitemdb(self, payload: object, ean: str) -> EanLookupHit | None:
        if not isinstance(payload, dict):
            return None
        items = payload.get("items")
        if not isinstance(items, list):
            return None
        for row in items:
            if not isinstance(row, dict):
                continue
            if not any(_same_code(row.get(key), ean) for key in ("ean", "upc", "gtin")):
                continue
            images = row.get("images")
            image = images[0] if isinstance(images, list) and images else None
            return build_hit(
                ean=ean,
                item_name=row.get("title"),
                source=self.name,
                manufacturer=row.get("brand") or row.get("manufacturer"),
                image_url=image,
            )
        return None


def _same_code(value: object, ean: str) -> bool:
    """Do these two spellings denote the same barcode?

    Imported lazily at module scope would be fine, but the comparison belongs
    next to the parsers that use it: a provider returning the UPC-A form of the
    EAN-13 we asked for is answering our question, and a provider returning a
    neighbouring code is not.
    """
    from app.services import gtin

    if isinstance(value, (int, float)) and not isinstance(value, bool):
        value = str(int(value))
    if not isinstance(value, str):
        return False
    left = gtin.digits_only(value)
    right = gtin.digits_only(ean)
    if not left or not right:
        return False
    return (gtin.to_ean13(left) or left) == (gtin.to_ean13(right) or right)
