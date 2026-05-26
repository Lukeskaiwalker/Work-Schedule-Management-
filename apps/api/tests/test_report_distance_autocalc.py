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
    return fake_coords


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
