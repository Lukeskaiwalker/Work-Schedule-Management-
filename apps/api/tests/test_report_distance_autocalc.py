"""v2.5.26 — regression tests for construction-report km auto-calc.

The v2.5.18 km autofill silently failed on every project that didn't
have a dedicated ``construction_site_address`` (most of them — the
customer_address column is older and more commonly populated). The
PDF rendered ``"Kilometer (gesamt): —"`` even though the project had
a perfectly usable address in another column.

These tests pin down the fixed behaviour:

  • GET /projects/<id>/construction-reports/distance falls back from
    construction_site_address to customer_address.
  • POST /construction-reports recomputes km at save-time if the
    payload arrives without one (covers the "form submitted before
    the async GET resolves" race), unless the operator explicitly
    marked the value as ``source="manual"``.
  • Manual override is always respected — never overwritten.

The OpenWeather geocoder is mocked so tests don't need a real API
key or network access.
"""
from __future__ import annotations
import json

import pytest
from fastapi.testclient import TestClient

from app.core.db import SessionLocal
from app.services.runtime_settings import (
    COMPANY_SETTINGS_KEY,
    set_runtime_setting,
)


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _set_company_address(address: str) -> None:
    with SessionLocal() as db:
        set_runtime_setting(
            db,
            COMPANY_SETTINGS_KEY,
            json.dumps({"company_address": address}),
        )
        db.commit()


@pytest.fixture
def mock_geocoder(monkeypatch: pytest.MonkeyPatch):
    """Return a deterministic lat/lon for known addresses; None otherwise.

    Two real-feeling Berlin addresses ~10 km apart so the haversine
    + road-factor math produces a plausible non-zero round-trip number
    we can assert on without being brittle about the exact value.

    Also disables the OSRM HTTP call by default — tests get the
    deterministic haversine path. Tests that need to exercise the
    OSRM happy path enable it explicitly via the ``mock_osrm`` fixture.
    """
    fake_coords: dict[str, tuple[float, float]] = {
        # Berlin Mitte
        "Alexanderplatz 1, 10178 Berlin": (52.5219, 13.4132),
        # Berlin Charlottenburg, ~10 km west
        "Kurfuerstendamm 50, 10707 Berlin": (52.5026, 13.3076),
        # A third one, ~5 km south of Alexanderplatz
        "Tempelhofer Damm 200, 12099 Berlin": (52.4715, 13.3851),
    }

    def fake_fetch(api_key: str, address: str):
        # The function normalises whitespace; do a loose match.
        for known, coords in fake_coords.items():
            if known.lower() == (address or "").strip().lower():
                return coords
        return None

    monkeypatch.setattr(
        "app.routers.workflow_helpers._fetch_openweather_coordinates_cached",
        fake_fetch,
    )
    # Make the API-key check pass — the helper rejects empty keys.
    monkeypatch.setattr(
        "app.routers.workflow_helpers._effective_openweather_api_key",
        lambda db: "test-api-key",
    )
    # v2.5.29 — default: OSRM is unreachable so tests exercise the
    # haversine fallback (deterministic, no network). Override per-test
    # via mock_osrm fixture below.
    monkeypatch.setattr(
        "app.services.distance._fetch_osrm_driving_km",
        lambda *args, **kwargs: None,
    )
    return fake_coords


@pytest.fixture
def mock_osrm(monkeypatch: pytest.MonkeyPatch):
    """Make the OSRM helper return a deterministic one-way driving km.

    Use after ``mock_geocoder`` to override the default "OSRM
    unreachable" stub. The value (7.5 km one-way) is deliberately
    different from the haversine result for the same coords so tests
    can prove they're hitting the OSRM path, not the fallback.
    """
    def fake_osrm(a, b, *, base_url):
        return 7.5

    monkeypatch.setattr(
        "app.services.distance._fetch_osrm_driving_km",
        fake_osrm,
    )


def _create_project(
    client: TestClient,
    admin_token: str,
    *,
    customer_address: str = "",
    construction_site_address: str = "",
) -> int:
    response = client.post(
        "/api/projects",
        headers=_auth(admin_token),
        json={
            "project_number": "P-DIST-1",
            "name": "Distance test project",
            "customer_address": customer_address,
            "construction_site_address": construction_site_address,
        },
    )
    assert response.status_code == 200, response.text
    return response.json()["id"]


# ──────────────────── GET distance endpoint ────────────────────


def test_distance_endpoint_uses_construction_site_address_when_set(
    client: TestClient, admin_token: str, mock_geocoder
):
    """The original v2.5.18 happy path: dedicated site address present."""
    _set_company_address("Alexanderplatz 1, 10178 Berlin")
    pid = _create_project(
        client,
        admin_token,
        construction_site_address="Kurfuerstendamm 50, 10707 Berlin",
        customer_address="Different, irrelevant address",
    )
    r = client.get(
        f"/api/projects/{pid}/construction-reports/distance",
        headers=_auth(admin_token),
    )
    assert r.status_code == 200
    body = r.json()
    assert body["source"] == "auto"
    assert isinstance(body["kilometers"], int)
    assert body["kilometers"] > 0


def test_distance_endpoint_falls_back_to_customer_address(
    client: TestClient, admin_token: str, mock_geocoder
):
    """The fix: customer_address is used when construction_site_address
    is empty. This was the silent-failure case in v2.5.18."""
    _set_company_address("Alexanderplatz 1, 10178 Berlin")
    pid = _create_project(
        client,
        admin_token,
        customer_address="Kurfuerstendamm 50, 10707 Berlin",
        construction_site_address="",  # ← empty, was the trigger
    )
    r = client.get(
        f"/api/projects/{pid}/construction-reports/distance",
        headers=_auth(admin_token),
    )
    assert r.status_code == 200
    body = r.json()
    assert body["source"] == "auto", f"Should auto-compute; got {body}"
    assert isinstance(body["kilometers"], int)
    assert body["kilometers"] > 0


def test_distance_endpoint_reports_no_site_address_when_both_empty(
    client: TestClient, admin_token: str, mock_geocoder
):
    """Neither address present → explicit 'no_site_address' so the UI
    can show a friendly hint instead of a misleading number."""
    _set_company_address("Alexanderplatz 1, 10178 Berlin")
    pid = _create_project(client, admin_token, customer_address="", construction_site_address="")
    r = client.get(
        f"/api/projects/{pid}/construction-reports/distance",
        headers=_auth(admin_token),
    )
    assert r.status_code == 200
    body = r.json()
    assert body["source"] == "no_site_address"
    assert body["kilometers"] is None


def test_distance_endpoint_reports_no_company_address(
    client: TestClient, admin_token: str, mock_geocoder
):
    """Empty company-address setting → the auto-fill must explain why
    so the admin knows to fill in the company settings."""
    _set_company_address("")
    pid = _create_project(
        client,
        admin_token,
        customer_address="Kurfuerstendamm 50, 10707 Berlin",
    )
    r = client.get(
        f"/api/projects/{pid}/construction-reports/distance",
        headers=_auth(admin_token),
    )
    assert r.status_code == 200
    assert r.json()["source"] == "no_company_address"


# ──────────────────── POST report — server-side recompute ────────────────────


def _submit_report(
    client: TestClient, admin_token: str, project_id: int, *, distance_payload: dict | None
) -> dict:
    """Build and POST a minimal construction report payload.

    ``distance_payload`` lets each test exercise a different state of
    the distance field on the wire: unset (default factory), null km
    with 'unset' source, or a manual override.
    """
    payload: dict = {}
    if distance_payload is not None:
        payload["distance"] = distance_payload

    response = client.post(
        "/api/construction-reports",
        headers=_auth(admin_token),
        json={
            "project_id": project_id,
            "report_date": "2026-05-25",
            "payload": payload,
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


def _read_report_distance(report_id: int) -> dict:
    """Read the persisted ``payload.distance`` directly from the DB."""
    from app.models.entities import ConstructionReport
    with SessionLocal() as db:
        report = db.get(ConstructionReport, report_id)
        assert report is not None
        return dict(report.payload.get("distance") or {})


def test_post_recomputes_distance_when_payload_arrives_without_km(
    client: TestClient, admin_token: str, mock_geocoder
):
    """The headline fix: even if the frontend forgets to include
    distance (or includes it as null/unset), the server falls back
    and computes it so the PDF doesn't render an em-dash."""
    _set_company_address("Alexanderplatz 1, 10178 Berlin")
    pid = _create_project(
        client,
        admin_token,
        customer_address="Kurfuerstendamm 50, 10707 Berlin",
    )

    # Operator submits with no distance at all in the payload.
    submitted = _submit_report(client, admin_token, pid, distance_payload=None)
    persisted = _read_report_distance(submitted["id"])
    assert persisted.get("source") == "auto"
    assert isinstance(persisted.get("kilometers"), int)
    assert persisted["kilometers"] > 0


def test_post_recomputes_distance_when_payload_has_null_km(
    client: TestClient, admin_token: str, mock_geocoder
):
    """The frontend's failure mode that produced the bug in prod:
    ``{kilometers: null, source: 'unset'}`` gets sent because the
    async GET hadn't resolved before submit."""
    _set_company_address("Alexanderplatz 1, 10178 Berlin")
    pid = _create_project(
        client,
        admin_token,
        customer_address="Tempelhofer Damm 200, 12099 Berlin",
    )
    submitted = _submit_report(
        client,
        admin_token,
        pid,
        distance_payload={"kilometers": None, "source": "unset"},
    )
    persisted = _read_report_distance(submitted["id"])
    assert persisted.get("source") == "auto"
    assert isinstance(persisted.get("kilometers"), int)
    assert persisted["kilometers"] > 0


def test_post_respects_manual_override(
    client: TestClient, admin_token: str, mock_geocoder
):
    """Operator typed a number → trust it absolutely. Never overwrite
    with a geocoded value, even if the geocoded value disagrees."""
    _set_company_address("Alexanderplatz 1, 10178 Berlin")
    pid = _create_project(
        client,
        admin_token,
        customer_address="Kurfuerstendamm 50, 10707 Berlin",
    )
    submitted = _submit_report(
        client,
        admin_token,
        pid,
        distance_payload={"kilometers": 42, "source": "manual"},
    )
    persisted = _read_report_distance(submitted["id"])
    assert persisted.get("source") == "manual"
    assert persisted.get("kilometers") == 42


def test_post_respects_existing_auto_value(
    client: TestClient, admin_token: str, mock_geocoder
):
    """The frontend already pre-filled — don't waste a geocode call.

    If the payload already has a positive km, leave it alone. (This
    isn't strictly necessary for correctness — recomputing would
    produce the same value — but it avoids hammering the geocoder
    cache on every submit.)"""
    _set_company_address("Alexanderplatz 1, 10178 Berlin")
    pid = _create_project(
        client,
        admin_token,
        customer_address="Kurfuerstendamm 50, 10707 Berlin",
    )
    submitted = _submit_report(
        client,
        admin_token,
        pid,
        distance_payload={"kilometers": 27, "source": "auto"},
    )
    persisted = _read_report_distance(submitted["id"])
    assert persisted.get("kilometers") == 27


def test_post_leaves_em_dash_when_no_addresses_at_all(
    client: TestClient, admin_token: str, mock_geocoder
):
    """If neither project address is set, accept the "—" in the PDF —
    we can't make up a distance and shouldn't silently insert zero."""
    _set_company_address("Alexanderplatz 1, 10178 Berlin")
    pid = _create_project(client, admin_token, customer_address="", construction_site_address="")
    submitted = _submit_report(client, admin_token, pid, distance_payload=None)
    persisted = _read_report_distance(submitted["id"])
    # Either no distance key, or distance with no kilometers — both
    # produce the em-dash in the PDF, both are acceptable.
    assert not isinstance(persisted.get("kilometers"), int) or not persisted.get("kilometers")


# ──────────────────── v2.5.29: OSRM real routing ────────────────────


def test_osrm_real_distance_is_used_when_available(
    client: TestClient, admin_token: str, mock_geocoder, mock_osrm
):
    """When OSRM responds, the round-trip is exactly ``osrm_one_way × 2``
    rounded — no 1.3× detour multiplier applied on top. This proves the
    user gets the real driving distance, not a heuristic estimate."""
    _set_company_address("Alexanderplatz 1, 10178 Berlin")
    pid = _create_project(
        client,
        admin_token,
        customer_address="Kurfuerstendamm 50, 10707 Berlin",
    )
    r = client.get(
        f"/api/projects/{pid}/construction-reports/distance",
        headers=_auth(admin_token),
    )
    assert r.status_code == 200
    body = r.json()
    # mock_osrm returns 7.5 km one-way → 15 km round-trip.
    assert body["source"] == "auto"
    assert body["kilometers"] == 15


def test_osrm_failure_falls_back_to_haversine(
    client: TestClient, admin_token: str, mock_geocoder
):
    """OSRM unreachable → haversine × 1.3 heuristic kicks in so the
    feature degrades gracefully instead of returning null.

    mock_geocoder defaults to OSRM=unreachable so this test needs no
    extra override — just verify a positive km comes back."""
    _set_company_address("Alexanderplatz 1, 10178 Berlin")
    pid = _create_project(
        client,
        admin_token,
        customer_address="Kurfuerstendamm 50, 10707 Berlin",
    )
    r = client.get(
        f"/api/projects/{pid}/construction-reports/distance",
        headers=_auth(admin_token),
    )
    assert r.status_code == 200
    body = r.json()
    assert body["source"] == "auto"
    assert isinstance(body["kilometers"], int)
    assert body["kilometers"] > 0


def test_osrm_disabled_by_empty_base_url_falls_back(
    client: TestClient, admin_token: str, mock_geocoder, monkeypatch
):
    """Setting OSRM_BASE_URL="" in env disables the real-routing call
    entirely without modifying code — useful escape hatch if OSRM's
    public endpoint goes down or starts rate-limiting us. The
    heuristic still produces a usable number."""
    from app.core import config as config_module

    cached = config_module.get_settings()
    monkeypatch.setattr(cached, "osrm_base_url", "")

    _set_company_address("Alexanderplatz 1, 10178 Berlin")
    pid = _create_project(
        client,
        admin_token,
        customer_address="Kurfuerstendamm 50, 10707 Berlin",
    )
    r = client.get(
        f"/api/projects/{pid}/construction-reports/distance",
        headers=_auth(admin_token),
    )
    assert r.status_code == 200
    assert r.json()["source"] == "auto"
    assert r.json()["kilometers"] > 0


def test_fetch_osrm_returns_none_on_http_error(monkeypatch):
    """Direct unit test of the OSRM helper: any HTTP error / malformed
    response / no-route condition must return None so the caller can
    fall back. No network — we replace httpx.Client with a stub that
    raises."""
    from app.services.distance import _fetch_osrm_driving_km

    class _ExplodingClient:
        def __init__(self, *args, **kwargs): pass
        def __enter__(self): return self
        def __exit__(self, *args): return False
        def get(self, *args, **kwargs):
            raise RuntimeError("simulated network failure")

    monkeypatch.setattr("app.services.distance.httpx.Client", _ExplodingClient)
    result = _fetch_osrm_driving_km(
        (52.5, 13.4),
        (52.5, 13.3),
        base_url="https://example.invalid",
    )
    assert result is None


def test_fetch_osrm_parses_real_response_shape(monkeypatch):
    """The OSRM /route/v1/driving/* endpoint returns:

        {"code": "Ok", "routes": [{"distance": 12345.6, ...}]}

    We extract routes[0].distance (metres) and convert to km. This
    test pins that shape so a future OSRM upgrade can't silently
    break the call-site."""
    from app.services.distance import _fetch_osrm_driving_km

    class _FakeResponse:
        def raise_for_status(self): pass
        def json(self):
            return {
                "code": "Ok",
                "routes": [{"distance": 9876.0, "duration": 600.0}],
            }

    class _FakeClient:
        def __init__(self, *args, **kwargs): pass
        def __enter__(self): return self
        def __exit__(self, *args): return False
        def get(self, *args, **kwargs):
            return _FakeResponse()

    monkeypatch.setattr("app.services.distance.httpx.Client", _FakeClient)
    result = _fetch_osrm_driving_km(
        (52.5, 13.4),
        (52.4, 13.3),
        base_url="https://router.project-osrm.org",
    )
    assert result == 9.876
