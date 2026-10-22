"""``GET /werkstatt/dashboard?preview_limit=`` — longer previews for the start page.

The personal start page asks once for 10 rows so one shared request serves
every widget size (docs/DASHBOARD.md D15). The Werkstatt page keeps calling
without the parameter and must get exactly today's payload; the bound keeps
the aggregate cheap.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from tests.conftest import auth_headers


def _articles_below_minimum(client: TestClient, admin_token: str, count: int) -> None:
    for index in range(count):
        created = client.post(
            "/api/werkstatt/articles",
            headers=auth_headers(admin_token),
            json={"item_name": f"Beispielartikel {index}", "stock_total": 1, "stock_min": 5 + index},
        )
        assert created.status_code == 200, created.text


def test_the_default_preview_stays_at_five_rows(client: TestClient, admin_token: str) -> None:
    _articles_below_minimum(client, admin_token, 8)
    response = client.get("/api/werkstatt/dashboard", headers=auth_headers(admin_token))
    assert response.status_code == 200, response.text
    assert len(response.json()["reorder_preview"]) == 5
    assert response.json()["kpis"]["below_min_count"] == 8


def test_preview_limit_ten_returns_every_row_up_to_ten(client: TestClient, admin_token: str) -> None:
    _articles_below_minimum(client, admin_token, 8)
    response = client.get("/api/werkstatt/dashboard", params={"preview_limit": 10}, headers=auth_headers(admin_token))
    assert response.status_code == 200, response.text
    rows = response.json()["reorder_preview"]
    assert len(rows) == 8
    # Same order as the short preview: the largest shortfall first.
    shortfalls = [row["stock_min"] - row["stock_available"] for row in rows]
    assert shortfalls == sorted(shortfalls, reverse=True)


def test_preview_limit_is_bounded(client: TestClient, admin_token: str) -> None:
    headers = auth_headers(admin_token)
    for bad in (0, 11, -1):
        response = client.get("/api/werkstatt/dashboard", params={"preview_limit": bad}, headers=headers)
        assert response.status_code == 422, (bad, response.text)
    assert client.get("/api/werkstatt/dashboard", params={"preview_limit": 1}, headers=headers).status_code == 200
