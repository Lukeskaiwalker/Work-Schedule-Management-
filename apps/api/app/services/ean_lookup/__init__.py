"""External GTIN sources for articles SMPL has never stocked.

Public surface is deliberately two names: ``lookup_external`` (ask the world)
and ``EanLookupHit`` (what it may answer). Everything else — the providers,
the shared budget, the SSRF-guarded transport — is an implementation detail
the rest of the app must not reach into, because "one place decides whether an
outbound call is allowed" is the only version of that rule that holds.
"""

from app.services.ean_lookup.base import EanLookupHit, EanLookupProvider
from app.services.ean_lookup.cascade import external_lookup_enabled, lookup_external

__all__ = [
    "EanLookupHit",
    "EanLookupProvider",
    "external_lookup_enabled",
    "lookup_external",
]
