"""The project weather card's notes follow the UI language.

``GET /projects/{id}/weather`` already takes ``lang`` (OpenWeather answers in
it); the endpoint's own notes did not and read "OpenWeather API key is not
configured" to a German crew. What must hold: with ``lang=de`` every note is
German, without the raw English text an upstream error carries (that goes to
the log); with ``lang=en`` the notes stay as they were; an error stored with
the cache is translated when it is read back, not when it is written.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from app.core.db import SessionLocal
from app.models.entities import ProjectWeatherCache
from app.routers import workflow as workflow_router
from app.services.weather_messages import weather_error_reason, weather_message
from tests.conftest import auth_headers

DAYS = [
    {
        "date": "2026-10-12",
        "temp_min": 4.0,
        "temp_max": 11.0,
        "description": "leicht bewölkt",
        "icon": "03d",
        "precipitation_probability": 20.0,
        "wind_speed": 3.0,
    }
] * 5


def _set_key(client: TestClient, admin_token: str) -> None:
    response = client.patch(
        "/api/admin/settings/weather", headers=auth_headers(admin_token), json={"api_key": "owm-key-for-tests"}
    )
    assert response.status_code == 200, response.text


def _project(client: TestClient, admin_token: str, number: str, *, address: str = "Baustellenweg 1, 58452 Witten") -> int:
    response = client.post(
        "/api/projects",
        headers=auth_headers(admin_token),
        json={"project_number": number, "name": f"Projekt {number}", "status": "in_durchfuehrung", "construction_site_address": address},
    )
    assert response.status_code == 200, response.text
    return response.json()["id"]


def _weather(client: TestClient, admin_token: str, project_id: int, lang: str) -> dict:
    response = client.get(f"/api/projects/{project_id}/weather?refresh=true&lang={lang}", headers=auth_headers(admin_token))
    assert response.status_code == 200, response.text
    return response.json()


def test_reasons_are_classified_from_the_upstream_text() -> None:
    assert weather_error_reason("Forecast fetch failed: Invalid API key. Please see https://…") == "api_key_invalid"
    # What v2.14.40 stored as last_error, read back after the upgrade.
    assert weather_error_reason("OpenWeather API key is invalid (or not active yet)") == "api_key_invalid"
    assert weather_error_reason("OpenWeather forecast API access is not enabled for this key") == "not_subscribed"
    assert weather_error_reason("Geocoding failed: city not found") == "address_not_found"
    assert weather_error_reason("Address could not be geocoded") == "address_not_found"
    assert weather_error_reason("No daily weather forecast available") == "no_forecast"
    assert weather_error_reason("network offline") == "fetch_failed"
    assert weather_error_reason("") == "fetch_failed"


def test_every_note_exists_in_both_languages() -> None:
    for key in (
        "address_missing",
        "api_key_missing",
        "api_key_invalid",
        "not_subscribed",
        "address_not_found",
        "no_forecast",
        "fetch_failed",
        "no_cache_yet",
    ):
        german = weather_message(key, "de")
        english = weather_message(key, "en")
        assert german and english and german != english, key
        assert "API key" not in german and "not " not in german, german


def test_a_missing_key_is_said_in_german(client: TestClient, admin_token: str) -> None:
    project_id = _project(client, admin_token, "2026-WX-1")
    assert _weather(client, admin_token, project_id, "de")["message"] == "Kein OpenWeather-API-Schlüssel hinterlegt."
    assert _weather(client, admin_token, project_id, "en")["message"] == "OpenWeather API key is not configured"


def test_a_missing_address_is_said_in_german(client: TestClient, admin_token: str) -> None:
    _set_key(client, admin_token)
    project_id = _project(client, admin_token, "2026-WX-2", address="")
    message = _weather(client, admin_token, project_id, "de")["message"]
    assert message == "Für das Projekt ist keine Baustellen- oder Kundenadresse hinterlegt."


def test_an_upstream_failure_is_german_without_its_english_detail(
    client: TestClient, admin_token: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    _set_key(client, admin_token)
    project_id = _project(client, admin_token, "2026-WX-3")

    def invalid_key(*, api_key: str, query_address: str, language: str = "en"):
        raise ValueError("Forecast fetch failed: Invalid API key. Please see https://openweathermap.org/faq#error401")

    monkeypatch.setattr(workflow_router, "_fetch_openweather_forecast", invalid_key)
    german = _weather(client, admin_token, project_id, "de")["message"]
    assert german == "Wetterdaten konnten nicht abgerufen werden: Der OpenWeather-API-Schlüssel ist ungültig (oder noch nicht aktiv)."
    assert "Invalid" not in german and "openweathermap.org" not in german

    def offline(*, api_key: str, query_address: str, language: str = "en"):
        raise RuntimeError("network offline")

    monkeypatch.setattr(workflow_router, "_fetch_openweather_forecast", offline)
    assert _weather(client, admin_token, project_id, "de")["message"] == "Wetterdaten konnten nicht abgerufen werden."
    # English keeps the upstream detail it always showed.
    assert _weather(client, admin_token, project_id, "en")["message"] == "Weather fetch failed: network offline"


def test_a_stale_cache_and_its_stored_error_read_german(
    client: TestClient, admin_token: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    _set_key(client, admin_token)
    project_id = _project(client, admin_token, "2026-WX-4")
    monkeypatch.setattr(
        workflow_router, "_fetch_openweather_forecast", lambda *, api_key, query_address, language="en": (51.4, 7.3, DAYS)
    )
    assert _weather(client, admin_token, project_id, "de")["message"] is None

    with SessionLocal() as db:
        row = db.get(ProjectWeatherCache, project_id)
        row.fetched_at = datetime.now(timezone.utc) - timedelta(minutes=16)
        db.commit()

    def offline(*, api_key: str, query_address: str, language: str = "en"):
        raise RuntimeError("network offline")

    monkeypatch.setattr(workflow_router, "_fetch_openweather_forecast", offline)
    stale = _weather(client, admin_token, project_id, "de")
    assert stale["stale"] is True and len(stale["days"]) == 5
    assert stale["message"] == "Zwischengespeicherte Wetterdaten — Wetterdaten konnten nicht abgerufen werden."

    # The next read without a refresh shows the stored error — in German too.
    response = client.get(f"/api/projects/{project_id}/weather?refresh=false&lang=de", headers=auth_headers(admin_token))
    assert response.status_code == 200, response.text
    assert response.json()["message"] == "Zwischengespeicherte Wetterdaten — Wetterdaten konnten nicht abgerufen werden."
