"""Ask the outside world what a barcode is — once, briefly, and fail-soft.

Order is not arbitrary. The workshop is an electrical contractor and buys from
Unielektro, so the wholesaler's own shop answers with the wording, the brand
and the packing unit that will match the invoice. A general GTIN database is
the fallback for the tape measure and the box of screws.

The whole cascade shares one budget and one client. Both are per call: this
runs inside a request handler on a memory-capped container, so there is no
pool to grow and no background task to leak.
"""

from __future__ import annotations

from app.core.config import get_settings
from app.services import gtin
from app.services.ean_lookup.base import EanLookupHit
from app.services.ean_lookup.http import Budget, build_client
from app.services.ean_lookup.open_ean_db import SUPPORTED_PROVIDERS, OpenEanDbProvider
from app.services.ean_lookup.unielektro_shop import UnielektroShopProvider


def external_lookup_enabled() -> bool:
    """Is any external source configured at all?

    Read before spending a request: with everything switched off the cascade
    is a no-op and the caller should not even normalise a code for it.
    """
    settings = get_settings()
    provider = (settings.ean_lookup_provider or "").strip().lower()
    return bool(settings.ean_lookup_unielektro_enabled) or provider in SUPPORTED_PROVIDERS


def lookup_external(code: str) -> EanLookupHit | None:
    """The first provider that recognises *code*, or ``None``.

    ``None`` is a perfectly normal answer — most in-house codes and every
    mistyped one end here — and it never blocks anything: the caller offers an
    empty form instead of a prefilled one.

    Only GTIN-shaped codes with a valid check digit get this far. A wrong
    check digit is not a product, and asking three providers about it costs
    three round trips to learn what arithmetic already knew.
    """
    settings = get_settings()
    ean = gtin.normalize(code)
    if not gtin.is_gtin(ean) or not external_lookup_enabled():
        return None

    budget = Budget.start(settings.ean_lookup_timeout_seconds)
    provider_name = (settings.ean_lookup_provider or "").strip().lower()
    with build_client(budget) as client:
        if settings.ean_lookup_unielektro_enabled:
            hit = UnielektroShopProvider(client, budget).lookup(ean)
            if hit is not None:
                return hit
        if provider_name in SUPPORTED_PROVIDERS and not budget.exhausted:
            return OpenEanDbProvider(
                provider=provider_name,
                api_key=settings.ean_lookup_api_key,
                client=client,
                budget=budget,
            ).lookup(ean)
    return None
