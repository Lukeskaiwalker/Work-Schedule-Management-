"""Printing the sticker that makes a construction box scannable.

A box screen that lets somebody scan a crate is worth nothing while the crates
carry only a number painted on the side. This is the other half: the same
``KISTE-<box_number>`` string that the station's box list reports as ``code``
goes into the label's DataMatrix, so what the scanner reads is what the list
already shows.

Unlike the article label, printing a box label mints nothing and writes
nothing — the code is derived from the box number, which already exists. That
is the property most worth pinning: a failed print must be a failed print, not
a database change.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from tests.conftest import auth_headers


def _configure_printer(monkeypatch, host: str = "192.0.2.50", port: int = 9100) -> None:
    from app.core.config import get_settings

    settings = get_settings()
    monkeypatch.setattr(settings, "werkstatt_label_printer_host", host)
    monkeypatch.setattr(settings, "werkstatt_label_printer_port", port)


def _capture_sent(monkeypatch) -> list[tuple[str, int, bytes]]:
    from app.services import werkstatt_labels

    sent: list[tuple[str, int, bytes]] = []

    def fake_send(host: str, port: int, payload: bytes) -> None:
        sent.append((host, port, payload))

    monkeypatch.setattr(werkstatt_labels, "_send_tcp", fake_send)
    return sent


def _box(client: TestClient, admin_token: str, label: str) -> dict:
    created = client.post(
        "/api/werkstatt/boxes", headers=auth_headers(admin_token), json={"label": label}
    )
    assert created.status_code == 200, created.text
    return created.json()


def test_printing_a_box_label_sends_the_scannable_code(
    client: TestClient, admin_token: str, monkeypatch
) -> None:
    _configure_printer(monkeypatch)
    sent = _capture_sent(monkeypatch)
    box = _box(client, admin_token, "Dachkiste")

    printed = client.post(
        f"/api/werkstatt/boxes/{box['id']}/print-label", headers=auth_headers(admin_token)
    )
    assert printed.status_code == 200, printed.text
    body = printed.json()

    assert body["box_id"] == box["id"]
    assert body["box_number"] == box["box_number"]
    assert body["code"] == f"KISTE-{box['box_number']}"
    assert body["printer"] == "192.0.2.50:9100"

    assert len(sent) == 1, "exactly one job reaches the printer"
    payload = sent[0][2]
    # The code that ends up in the DataMatrix, and the human-readable label
    # next to it, both come from the box itself.
    assert body["code"].encode() in payload
    assert b"Dachkiste" in payload


def test_the_printed_code_is_the_one_the_station_box_list_reports(
    client: TestClient, admin_token: str, monkeypatch
) -> None:
    """The two must agree or the scan matches nothing.

    Asserted across the two endpoints rather than against a literal, because a
    literal in both places is exactly how they would drift apart.
    """
    _configure_printer(monkeypatch)
    _capture_sent(monkeypatch)

    started = client.post(
        "/api/station/pair/start", json={"device_hint": "scanpi-01", "agent_version": "1.0.0"}
    ).json()
    client.post(
        "/api/station/pair/approve",
        headers=auth_headers(admin_token),
        json={"user_code": started["user_code"], "name": "Werkstatt Pi"},
    )
    station_token = client.post(
        "/api/station/pair/poll", json={"device_token": started["device_token"]}
    ).json()["token"]

    box = _box(client, admin_token, "Kiste Verteiler")
    printed = client.post(
        f"/api/werkstatt/boxes/{box['id']}/print-label", headers=auth_headers(admin_token)
    ).json()

    listed = client.get(
        "/api/station/werkstatt/boxes", headers=auth_headers(station_token)
    ).json()
    mine = next(row for row in listed if row["id"] == box["id"])
    assert mine["code"] == printed["code"]


def test_a_locked_box_can_still_be_labelled(
    client: TestClient, admin_token: str, monkeypatch
) -> None:
    """Handing a crate to a customer freezes its *contents*, not its identity.

    A box that is out on a site is precisely the one whose sticker gets ripped
    off, and refusing to reprint it would leave the crate unscannable until it
    came back.
    """
    _configure_printer(monkeypatch)
    _capture_sent(monkeypatch)

    customer = client.post(
        "/api/customers", headers=auth_headers(admin_token), json={"name": "Elektro Nord"}
    ).json()
    box = _box(client, admin_token, "Kiste Nord")
    assigned = client.post(
        f"/api/werkstatt/boxes/{box['id']}/assign",
        headers=auth_headers(admin_token),
        json={"customer_id": customer["id"]},
    )
    assert assigned.json()["status"] == "zugewiesen"

    printed = client.post(
        f"/api/werkstatt/boxes/{box['id']}/print-label", headers=auth_headers(admin_token)
    )
    assert printed.status_code == 200, printed.text


def test_an_unknown_box_is_a_404(client: TestClient, admin_token: str, monkeypatch) -> None:
    _configure_printer(monkeypatch)
    _capture_sent(monkeypatch)
    missing = client.post(
        "/api/werkstatt/boxes/987654/print-label", headers=auth_headers(admin_token)
    )
    assert missing.status_code == 404, missing.text


def test_no_printer_configured_is_a_503_not_a_crash(
    client: TestClient, admin_token: str, monkeypatch
) -> None:
    from app.core.config import get_settings

    settings = get_settings()
    monkeypatch.setattr(settings, "werkstatt_label_printer_host", "")
    box = _box(client, admin_token, "Kiste ohne Drucker")

    failed = client.post(
        f"/api/werkstatt/boxes/{box['id']}/print-label", headers=auth_headers(admin_token)
    )
    assert failed.status_code == 503, failed.text
    assert failed.json()["detail"] == "Kein Etikettendrucker konfiguriert"


def test_an_unreachable_printer_is_a_502_and_changes_nothing(
    client: TestClient, admin_token: str, monkeypatch
) -> None:
    from app.services import werkstatt_labels

    _configure_printer(monkeypatch)

    def explode(host: str, port: int, payload: bytes) -> None:
        raise werkstatt_labels.LabelPrinterUnreachable("connection refused")

    monkeypatch.setattr(werkstatt_labels, "_send_tcp", explode)
    box = _box(client, admin_token, "Kiste Offline")
    before = client.get(
        f"/api/werkstatt/boxes/{box['id']}", headers=auth_headers(admin_token)
    ).json()

    failed = client.post(
        f"/api/werkstatt/boxes/{box['id']}/print-label", headers=auth_headers(admin_token)
    )
    assert failed.status_code == 502, failed.text

    after = client.get(
        f"/api/werkstatt/boxes/{box['id']}", headers=auth_headers(admin_token)
    ).json()
    assert after == before, "printing must never write to the box"


def test_a_label_format_that_cannot_hold_the_box_label_is_a_400(
    client: TestClient, admin_token: str, monkeypatch
) -> None:
    """Same mapping as the article label: the stock in the printer is a
    configuration problem (400), not a server fault. Since 2026-09-24 the
    crate sticker has its own renderer (services/werkstatt_box_labels), so
    the refusal is exercised through the stock it reads, not a patched seam."""
    from app.services import werkstatt_box_labels
    from app.services.werkstatt_label_materials import DEFAULT_MATERIALS

    _configure_printer(monkeypatch)
    sent = _capture_sent(monkeypatch)
    strip = next(profile for profile in DEFAULT_MATERIALS if profile.continuous)
    monkeypatch.setattr(werkstatt_box_labels, "active_material", lambda db: strip)
    box = _box(client, admin_token, "Kiste Klein")

    failed = client.post(
        f"/api/werkstatt/boxes/{box['id']}/print-label", headers=auth_headers(admin_token)
    )
    assert failed.status_code == 400, failed.text
    assert "großes Etikett" in failed.json()["detail"]
    assert sent == []


def test_printing_a_label_needs_a_login(client: TestClient, admin_token: str) -> None:
    """403 rather than 401 is this API's convention for a missing bearer
    header (FastAPI's HTTPBearer answers before the dependency runs); what is
    pinned here is that the label endpoint is behind it at all."""
    box = _box(client, admin_token, "Kiste Anonym")
    assert client.post(f"/api/werkstatt/boxes/{box['id']}/print-label").status_code == 403
