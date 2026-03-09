from __future__ import annotations
from datetime import datetime, time, timedelta, timezone
import json
import os
from fastapi.testclient import TestClient
from app.routers import workflow as workflow_router
def auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}



def test_project_weather_cache_throttle_and_offline_fallback(client: TestClient, admin_token: str, monkeypatch):
    from app.core.db import SessionLocal
    from app.models.entities import ProjectWeatherCache

    settings_update = client.patch(
        "/api/admin/settings/weather",
        headers=auth_headers(admin_token),
        json={"api_key": "owm-weather-key-for-tests"},
    )
    assert settings_update.status_code == 200

    project = client.post(
        "/api/projects",
        headers=auth_headers(admin_token),
        json={
            "project_number": "2026-WEATHER-1",
            "name": "Weather Project",
            "status": "active",
            "customer_name": "Weather GmbH",
            "customer_address": "Alexanderplatz 1, 10178 Berlin",
            "construction_site_address": "Baustellenweg 22, 10115 Berlin",
        },
    )
    assert project.status_code == 200
    project_id = project.json()["id"]

    call_counter = {"count": 0}

    def fake_fetch_openweather_forecast(*, api_key: str, query_address: str, language: str = "en"):
        call_counter["count"] += 1
        assert api_key == "owm-weather-key-for-tests"
        assert query_address == "Baustellenweg 22, 10115 Berlin"
        assert language == "de"
        return (
            52.520008,
            13.404954,
            [
                {
                    "date": "2026-02-23",
                    "temp_min": 2.1,
                    "temp_max": 7.8,
                    "description": "leicht bewoelkt",
                    "icon": "03d",
                    "precipitation_probability": 20.0,
                    "wind_speed": 3.7,
                }
            ]
            * 5,
        )

    monkeypatch.setattr(workflow_router, "_fetch_openweather_forecast", fake_fetch_openweather_forecast)

    first = client.get(f"/api/projects/{project_id}/weather?refresh=true&lang=de", headers=auth_headers(admin_token))
    assert first.status_code == 200
    first_payload = first.json()
    assert first_payload["from_cache"] is False
    assert first_payload["stale"] is False
    assert first_payload["query_address"] == "Baustellenweg 22, 10115 Berlin"
    assert len(first_payload["days"]) == 5

    second = client.get(f"/api/projects/{project_id}/weather?refresh=true&lang=de", headers=auth_headers(admin_token))
    assert second.status_code == 200
    second_payload = second.json()
    assert second_payload["from_cache"] is True
    assert call_counter["count"] == 1

    with SessionLocal() as db:
        cache_row = db.get(ProjectWeatherCache, project_id)
        assert cache_row is not None
        cache_row.fetched_at = datetime.now(timezone.utc) - timedelta(minutes=16)
        db.add(cache_row)
        db.commit()

    def failing_fetch_openweather_forecast(*, api_key: str, query_address: str, language: str = "en"):
        raise RuntimeError("network offline")

    monkeypatch.setattr(workflow_router, "_fetch_openweather_forecast", failing_fetch_openweather_forecast)

    third = client.get(f"/api/projects/{project_id}/weather?refresh=true&lang=de", headers=auth_headers(admin_token))
    assert third.status_code == 200
    third_payload = third.json()
    assert third_payload["from_cache"] is True
    assert third_payload["stale"] is True
    assert len(third_payload["days"]) == 5
    assert "cached" in (third_payload.get("message") or "").lower()


def test_project_weather_falls_back_to_customer_address(client: TestClient, admin_token: str, monkeypatch):
    settings_update = client.patch(
        "/api/admin/settings/weather",
        headers=auth_headers(admin_token),
        json={"api_key": "owm-weather-key-for-tests"},
    )
    assert settings_update.status_code == 200

    project = client.post(
        "/api/projects",
        headers=auth_headers(admin_token),
        json={
            "project_number": "2026-WEATHER-2",
            "name": "Weather Customer Fallback",
            "status": "active",
            "customer_name": "Fallback GmbH",
            "customer_address": "Customerstrasse 9, 45127 Essen",
            "construction_site_address": "",
        },
    )
    assert project.status_code == 200
    project_id = project.json()["id"]

    def fake_fetch_openweather_forecast(*, api_key: str, query_address: str, language: str = "en"):
        assert api_key == "owm-weather-key-for-tests"
        assert query_address == "Customerstrasse 9, 45127 Essen"
        assert language == "de"
        return (
            51.455643,
            7.011555,
            [
                {
                    "date": "2026-02-24",
                    "temp_min": 1.0,
                    "temp_max": 6.0,
                    "description": "bewoelkt",
                    "icon": "03d",
                    "precipitation_probability": 10.0,
                    "wind_speed": 2.3,
                }
            ]
            * 5,
        )

    monkeypatch.setattr(workflow_router, "_fetch_openweather_forecast", fake_fetch_openweather_forecast)

    response = client.get(f"/api/projects/{project_id}/weather?refresh=true&lang=de", headers=auth_headers(admin_token))
    assert response.status_code == 200
    payload = response.json()
    assert payload["query_address"] == "Customerstrasse 9, 45127 Essen"
    assert len(payload["days"]) == 5

def test_weather_address_candidates_normalize_and_add_country_fallbacks():
    candidates = workflow_router._weather_address_candidates("Nolsenstr. 62,\n58452   Witten")
    assert candidates
    assert candidates[0] == "Nolsenstr. 62, 58452 Witten"
    assert "Nolsenstr. 62, 58452 Witten, Deutschland" in candidates
    assert "Nolsenstr. 62, 58452 Witten, Germany" in candidates

def test_weather_zip_candidates_extracts_postal_code():
    candidates = workflow_router._weather_zip_candidates("Stockumer Straße 65, Annen, 58453 Witten, Germany")
    assert candidates == ["58453,DE"]
