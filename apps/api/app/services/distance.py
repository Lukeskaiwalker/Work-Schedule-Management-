"""Address-to-address driving-distance estimation.

Used by the v2.5.13 Baustellenbericht redesign to auto-fill the
'Kilometer (gesamt)' field with a company → site round-trip estimate
when the operator opens the form. Reuses the OpenWeather geocoding
cache that ``workflow_helpers.py`` already wires up for the per-project
weather widget, so geocoding the same addresses repeatedly is free.

Distance algorithm (matches the heuristic already used for travel-time
estimates between back-to-back project visits in workflow_helpers.py):

  1. Geocode both addresses → lat/lon pairs via OpenWeather.
  2. Crow-flies distance via the haversine formula.
  3. Road-distance estimate: ``max(crow * 1.3, crow + 1.5)`` km. The 1.3
     multiplier is the typical urban detour factor; the +1.5 minimum
     guards against the degenerate "same building" case where both
     addresses geocode to the same coords but the operator still has to
     drive some real distance.
  4. Round trip = road_distance × 2 (operator goes there and comes back).

Why heuristic, not a real routing API: a routing service (Google Maps
Distance Matrix, Mapbox Directions) would give exact driving distance
but adds (a) cost, (b) another API key + secrets to manage, (c) a network
dependency the report-PDF flow can't easily fall back from. The heuristic
is accurate to within ~10-15% for typical SMPL job sites in southern
Germany, which is good enough for an "approximate auto-fill the operator
can override" UX. The actual driving distance from the operator's odometer
is what should land in the manual-override path.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

from sqlalchemy.orm import Session


def resolve_project_site_address(project: Any) -> str | None:
    """v2.5.26 — pick the best available "site" address for distance calc.

    Most SMPL projects in the wild have an address only in the
    ``customer_address`` field (the customer's main address — which for
    small-contractor work is often *also* where the construction
    happens). The dedicated ``construction_site_address`` column is a
    later addition and is frequently left blank.

    Prior to v2.5.26 the km auto-calc only looked at
    ``construction_site_address`` and silently produced a "—" in the
    PDF for every project that didn't fill that field explicitly. This
    helper centralises the "prefer dedicated, fall back to customer"
    rule so every call-site (GET pre-fill, POST save-time recompute,
    future report regeneration) treats addresses the same way.

    Returns ``None`` when neither field is populated — that's a
    legitimate "no usable address" state that callers should surface
    as a friendly hint to the operator instead of silently failing.
    """
    if project is None:
        return None
    site = (getattr(project, "construction_site_address", None) or "").strip()
    if site:
        return site
    customer = (getattr(project, "customer_address", None) or "").strip()
    return customer or None


@dataclass(frozen=True)
class CompanySiteDistance:
    """Result of a company → site distance calculation.

    ``round_trip_km`` is the value to pre-fill into the report's km field
    (an integer because operators round odometer readings to whole km
    anyway). ``one_way_km`` is exposed for the UI's explainer tooltip
    ("X km hin und zurück, basierend auf X km einfacher Strecke").
    ``source`` distinguishes between successful auto-calculation and the
    various failure modes so the UI can render an appropriate message.
    """

    round_trip_km: int | None
    one_way_km: float | None
    source: str  # "auto" | "no_api_key" | "no_company_address" | "no_site_address" | "geocode_failed"


def compute_company_to_site_distance(
    db: Session,
    *,
    company_address: str | None,
    site_address: str | None,
) -> CompanySiteDistance:
    """Estimate the round-trip driving distance between the company HQ
    and a construction site.

    Returns a ``CompanySiteDistance`` with an explicit ``source`` field so
    callers can surface a precise reason when auto-fill fails instead of
    silently falling back to an empty value.

    Both addresses are accepted as raw strings (typically the operator
    has filled them in admin settings / project metadata; the function
    normalises whitespace itself).
    """
    # Imported lazily to avoid a circular import between this services
    # module and the workflow_helpers router module that owns the
    # cached geocoder. The router imports plenty from services/; we
    # don't want services/ to import from routers/ at module load time.
    from app.routers.workflow_helpers import (
        _effective_openweather_api_key,
        _fetch_openweather_coordinates_cached,
        _normalize_weather_address,
    )

    company_norm = _normalize_weather_address(company_address)
    site_norm = _normalize_weather_address(site_address)

    if not company_norm:
        return CompanySiteDistance(None, None, "no_company_address")
    if not site_norm:
        return CompanySiteDistance(None, None, "no_site_address")

    api_key = _effective_openweather_api_key(db)
    if not api_key.strip():
        return CompanySiteDistance(None, None, "no_api_key")

    company_coords = _fetch_openweather_coordinates_cached(api_key, company_norm)
    site_coords = _fetch_openweather_coordinates_cached(api_key, site_norm)
    if company_coords is None or site_coords is None:
        return CompanySiteDistance(None, None, "geocode_failed")

    one_way_km = _haversine_road_km(company_coords, site_coords)
    round_trip_km = int(round(one_way_km * 2))
    return CompanySiteDistance(round_trip_km, one_way_km, "auto")


def _haversine_road_km(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Haversine crow-flies distance, scaled to a road-distance estimate.

    Matches the algorithm already used in
    ``workflow_helpers._estimate_travel_minutes_between_projects`` so the
    two distance estimates stay coherent across the app. Extracted here
    instead of imported because the workflow_helpers version is mixed in
    with travel-time logic we don't need.
    """
    lat1, lon1 = a
    lat2, lon2 = b
    earth_radius_km = 6371.0
    lat_delta = math.radians(lat2 - lat1)
    lon_delta = math.radians(lon2 - lon1)
    h = (
        math.sin(lat_delta / 2) ** 2
        + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(lon_delta / 2) ** 2
    )
    crow_km = 2 * earth_radius_km * math.asin(min(1.0, math.sqrt(h)))
    # Urban detour factor + minimum-distance floor: see module docstring.
    return max(crow_km * 1.3, crow_km + 1.5)
