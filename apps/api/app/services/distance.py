"""Address-to-address driving-distance estimation.

Used by the v2.5.13 Baustellenbericht redesign to auto-fill the
'Kilometer (gesamt)' field with a company → site round-trip estimate
when the operator opens the form. Reuses the OpenWeather geocoding
cache that ``workflow_helpers.py`` already wires up for the per-project
weather widget, so geocoding the same addresses repeatedly is free.

Distance algorithm (v2.5.29):

  1. Geocode both addresses → lat/lon pairs via OpenWeather.
  2. **Real driving distance via OSRM** — call the public OSRM routing
     service at ``settings.osrm_base_url`` to get the actual one-way
     driving distance in metres. OSRM is open-source, requires no API
     key, and the public demo endpoint
     (https://router.project-osrm.org) is fair-use for small teams.
     Admins running heavier loads can point ``OSRM_BASE_URL`` at a
     self-hosted OSRM instance.
  3. **Haversine fallback** — if OSRM is unreachable (network blip,
     instance down, address not on the routable road network), fall
     back to the v2.5.18 heuristic: ``max(crow_km × 1.3, crow_km +
     1.5)``. The fallback only fires when the real-routing path
     fails, so under normal operation the user gets the exact driving
     distance the routing engine would compute — not an estimate.
  4. Round trip = one_way × 2 (operator goes there and comes back).

Why the change from heuristic-only to OSRM (with fallback):
heuristic × 1.3 was 30–50% off for long-distance routes (highway-
dominated) where the actual road is nearly straight. The user
reported 29 km estimated vs 20 km actual — that overshoots by 45%.
A real routing API solves that. OSRM is the right choice because
(a) free, (b) no API key, (c) no commercial restrictions for an
internal workflow tool. The haversine path stays in place so the
feature degrades gracefully — never a hard failure.
"""
from __future__ import annotations

import logging
import math
from dataclasses import dataclass
from typing import Any

import httpx
from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)


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

    # v2.5.29 — try OSRM first for a real driving distance; fall back
    # to the haversine × 1.3 heuristic only if the routing call fails.
    from app.core.config import get_settings

    settings = get_settings()
    osrm_base = (settings.osrm_base_url or "").strip()
    one_way_km: float | None = None
    if osrm_base:
        one_way_km = _fetch_osrm_driving_km(company_coords, site_coords, base_url=osrm_base)

    if one_way_km is None:
        # Fallback: better an over-estimate than no estimate. Logged
        # at INFO so prod admins can correlate "the km looks too high"
        # with "OSRM was down at the time of the report".
        logger.info(
            "OSRM routing unavailable, falling back to haversine heuristic "
            "(from=%s to=%s)",
            company_norm,
            site_norm,
        )
        one_way_km = _haversine_road_km(company_coords, site_coords)

    round_trip_km = int(round(one_way_km * 2))
    return CompanySiteDistance(round_trip_km, one_way_km, "auto")


def _fetch_osrm_driving_km(
    a: tuple[float, float],
    b: tuple[float, float],
    *,
    base_url: str,
) -> float | None:
    """Query OSRM's route-service for the real driving distance.

    Returns one-way driving distance in km, or None on any failure
    (network error, OSRM-side error, malformed response, no route
    found). The caller decides what to do with None — currently we
    fall back to the haversine heuristic so the feature degrades
    gracefully.

    OSRM API reference:
      https://project-osrm.org/docs/v5.24.0/api/#route-service

    URL shape: ``/route/v1/driving/{lon},{lat};{lon},{lat}?overview=false``
    (note: OSRM takes lon,lat — the opposite order of most other APIs;
    that's the spec, not a bug).
    """
    url_base = base_url.rstrip("/")
    # OSRM coordinates are lon,lat (not lat,lon). Pre-compute so the URL
    # construction is unambiguous to read.
    lon_a, lat_a = a[1], a[0]
    lon_b, lat_b = b[1], b[0]
    url = (
        f"{url_base}/route/v1/driving/"
        f"{lon_a},{lat_a};{lon_b},{lat_b}"
        f"?overview=false"
    )

    try:
        timeout = httpx.Timeout(8.0, connect=3.0)
        with httpx.Client(timeout=timeout) as client:
            # OSRM's public demo asks consumers to identify themselves
            # in the User-Agent so they can contact in case of abuse.
            response = client.get(url, headers={"User-Agent": "SMPL/2.5.x (+workflow)"})
            response.raise_for_status()
            payload: dict[str, Any] = response.json()
    except Exception as exc:  # noqa: BLE001 — anything failing → fallback
        logger.debug("OSRM request failed: %r", exc)
        return None

    if payload.get("code") != "Ok":
        logger.debug("OSRM non-Ok response: %s", payload.get("code"))
        return None
    routes = payload.get("routes") or []
    if not routes:
        return None
    distance_m = routes[0].get("distance")
    if not isinstance(distance_m, (int, float)) or distance_m <= 0:
        return None
    return float(distance_m) / 1000.0


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
