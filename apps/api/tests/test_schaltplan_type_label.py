"""The Schrank-Etikett — ``/schaltplan/panels/{id}/type-label``.

What must hold: the info endpoint resolves the customer from the panel's
customer row and the number from its project, defaults the build month to
this month and says whether the loaded stock can take the label; printing
ships one EZPL job on the 99 × 44 stock carrying the logo and the QR as
downloaded assets, the three text lines and the two contact lines, with
``copies`` as the print count; a bad Baujahr, wrong stock, no printer and
an unreachable printer each answer with their own status; a panel without
a project prints a dash; the preview images answer with their media types
and need a session.
"""

from __future__ import annotations

import re

import pytest
from fastapi.testclient import TestClient

from app.services import schaltplan_type_label as type_label
from app.services import werkstatt_labels
from app.services.werkstatt_label_materials import DEFAULT_MATERIALS
from tests.conftest import auth_headers


@pytest.fixture(autouse=True)
def _label_logo(monkeypatch: pytest.MonkeyPatch) -> None:
    from pathlib import Path

    from app.core.config import get_settings

    logo = Path(__file__).resolve().parents[1] / "app" / "assets" / "logo.jpeg"
    monkeypatch.setattr(get_settings(), "report_logo_path", str(logo))
    # The machine label's own cache is keyed on nothing; the box cache is
    # keyed on the path and needs no clearing.
    werkstatt_labels._logo_asset.cache_clear()


def _configure_printer(monkeypatch: pytest.MonkeyPatch, host: str = "192.0.2.50", port: int = 9100) -> None:
    from app.core.config import get_settings

    settings = get_settings()
    monkeypatch.setattr(settings, "werkstatt_label_printer_host", host)
    monkeypatch.setattr(settings, "werkstatt_label_printer_port", port)


def _capture_sent(monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, int, bytes]]:
    sent: list[tuple[str, int, bytes]] = []

    def fake_send(host: str, port: int, payload: bytes) -> None:
        sent.append((host, port, payload))

    monkeypatch.setattr(werkstatt_labels, "_send_tcp", fake_send)
    return sent


def _create_customer(client: TestClient, token: str, name: str) -> int:
    response = client.post("/api/customers", headers=auth_headers(token), json={"name": name})
    assert response.status_code == 200, response.text
    return response.json()["id"]


def _create_project(client: TestClient, token: str, number: str, customer_id: int) -> int:
    response = client.post(
        "/api/projects",
        headers=auth_headers(token),
        json={"project_number": number, "name": f"Verteiler {number}", "status": "active", "customer_id": customer_id},
    )
    assert response.status_code == 200, response.text
    return response.json()["id"]


def _create_panel(client: TestClient, token: str, customer_id: int, project_id: int | None) -> int:
    payload: dict = {"customer_id": customer_id, "name": "Zählerschrank", "designation": "ZV1", "panel_type": "main"}
    if project_id is not None:
        payload["project_id"] = project_id
    response = client.post("/api/schaltplan/panels", headers=auth_headers(token), json=payload)
    assert response.status_code == 200, response.text
    return response.json()["id"]


def _job_text(payload: bytes) -> str:
    """The EZPL commands of a payload, without the binary asset bodies. The
    commands are UTF-8 (the printer's "E" text style); the BMP bodies are
    dropped as undecodable noise."""
    lines = payload.decode("utf-8", errors="ignore").split("\r\n")
    return "\n".join(line for line in lines if line[:1].isprintable() and not line.startswith("BM"))


# ── Info ──────────────────────────────────────────────────────────────────────


def test_info_resolves_customer_project_month_and_stock(client: TestClient, admin_token: str) -> None:
    customer_id = _create_customer(client, admin_token, "Familie Schulze")
    project_id = _create_project(client, admin_token, "381", customer_id)
    panel_id = _create_panel(client, admin_token, customer_id, project_id)

    response = client.get(f"/api/schaltplan/panels/{panel_id}/type-label", headers=auth_headers(admin_token))
    assert response.status_code == 200, response.text
    info = response.json()
    assert info["customer"] == "Familie Schulze"
    assert info["project_number"] == "381"
    assert info["project_name"] == "Verteiler 381"
    assert info["build_month"] == type_label.current_build_month()
    assert re.fullmatch(r"(0[1-9]|1[0-2])\.\d{4}", info["build_month"])
    assert info["url"] == "https://smpl-energy.de"
    assert info["contact_lines"] == ["info@smpl-energy.de", "02302/ 2894980"]
    # The default stock is the 99 × 44 type label — the one the blueprint is for.
    assert info["material"] == DEFAULT_MATERIALS[0].name
    assert info["material_ok"] is True


def test_info_for_a_panel_without_project_has_no_number(client: TestClient, admin_token: str) -> None:
    customer_id = _create_customer(client, admin_token, "Ohne Projekt GmbH")
    panel_id = _create_panel(client, admin_token, customer_id, None)
    info = client.get(f"/api/schaltplan/panels/{panel_id}/type-label", headers=auth_headers(admin_token)).json()
    assert info["customer"] == "Ohne Projekt GmbH"
    assert info["project_number"] is None and info["project_name"] is None


# ── Printing ──────────────────────────────────────────────────────────────────


def test_print_ships_the_blueprint_with_the_panel_data(client: TestClient, admin_token: str, monkeypatch: pytest.MonkeyPatch) -> None:
    _configure_printer(monkeypatch)
    sent = _capture_sent(monkeypatch)
    customer_id = _create_customer(client, admin_token, "Familie Schulze")
    project_id = _create_project(client, admin_token, "381", customer_id)
    panel_id = _create_panel(client, admin_token, customer_id, project_id)

    response = client.post(
        f"/api/schaltplan/panels/{panel_id}/type-label",
        headers=auth_headers(admin_token),
        json={"build_month": "09.2026", "copies": 2},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body == {
        "printer": "192.0.2.50:9100",
        "material": DEFAULT_MATERIALS[0].name,
        "sheets": 2,
        "customer": "Familie Schulze",
        "project_number": "381",
        "build_month": "09.2026",
    }

    assert len(sent) == 1
    host, port, payload = sent[0]
    assert (host, port) == ("192.0.2.50", 9100)
    text = _job_text(payload)
    # Two downloaded assets — the logo and the QR — each placed once.
    assert len(re.findall(r"^~EB,SMPL[0-9A-F]{8},\d+$", text, re.M)) == 1
    assert len(re.findall(r"^~EB,QR[0-9A-F]{8},\d+$", text, re.M)) == 1
    assert len(re.findall(r"^Y\d+,\d+,SMPL[0-9A-F]{8}$", text, re.M)) == 1
    assert len(re.findall(r"^Y\d+,\d+,QR[0-9A-F]{8}$", text, re.M)) == 1
    # The 99 × 44 sheet, printed twice, in the validated rotation/encoding style.
    assert "^Q99,3\n^W44\n^C2\n^L" in text
    assert text.rstrip().endswith("\nE")
    at_lines = [line for line in text.splitlines() if line.startswith("AT,")]
    assert [line.split(",", 9)[-1] for line in at_lines] == [
        "Kunde: Familie Schulze",
        "Projekt: 381",
        "Baujahr: 09.2026",
        "info@smpl-energy.de",
        "02302/ 2894980",
        "VT-0001",
    ]
    assert all(",1E,0,0," in line for line in at_lines)
    # The three lines of the block share one size; the block sits left of the
    # contact block (machine y grows with reading x).
    block = [line.split(",") for line in at_lines[:3]]
    assert len({parts[3] for parts in block}) == 1
    assert {parts[2] for parts in block} == {block[0][2]}
    contact = [line.split(",") for line in at_lines[3:5]]
    assert all(int(parts[2]) > int(block[0][2]) for parts in contact)
    # The board's number: a DataMatrix bottom-left (reading x 41, y 360 → machine
    # x = 528 - (360 + 120) = 48, y = 41 + 24 = 65) with the number beside it.
    assert "XRB48,65,10,0,7\nVT-0001\n" in text
    number = at_lines[5].split(",")
    assert int(number[2]) > int(block[0][2]) and int(number[1]) < int(block[0][1])


def test_build_month_defaults_to_this_month_and_bad_input_is_refused(client: TestClient, admin_token: str, monkeypatch: pytest.MonkeyPatch) -> None:
    _configure_printer(monkeypatch)
    sent = _capture_sent(monkeypatch)
    customer_id = _create_customer(client, admin_token, "Monat GmbH")
    panel_id = _create_panel(client, admin_token, customer_id, None)

    for bad in ("2026-09", "13.2026", "9.2026", "Sept 2026"):
        refused = client.post(f"/api/schaltplan/panels/{panel_id}/type-label", headers=auth_headers(admin_token), json={"build_month": bad})
        assert refused.status_code == 400, (bad, refused.text)
        assert refused.json()["detail"] == "Baujahr bitte als MM.JJJJ angeben, z. B. 09.2026"
    assert sent == []

    printed = client.post(f"/api/schaltplan/panels/{panel_id}/type-label", headers=auth_headers(admin_token), json={})
    assert printed.status_code == 200, printed.text
    assert printed.json()["build_month"] == type_label.current_build_month()
    assert printed.json()["project_number"] is None
    assert "Projekt: —" in _job_text(sent[0][2])


def test_wrong_stock_no_printer_and_unreachable_printer_each_answer_plainly(
    client: TestClient, admin_token: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    customer_id = _create_customer(client, admin_token, "Drucker GmbH")
    panel_id = _create_panel(client, admin_token, customer_id, None)
    path = f"/api/schaltplan/panels/{panel_id}/type-label"

    # No printer configured at all.
    _configure_printer(monkeypatch, host="")
    none = client.post(path, headers=auth_headers(admin_token), json={})
    assert none.status_code == 503, none.text

    # Configured but the strip is loaded: refused before anything is sent.
    _configure_printer(monkeypatch)
    sent = _capture_sent(monkeypatch)
    strip = next(profile for profile in DEFAULT_MATERIALS if profile.continuous)
    monkeypatch.setattr(werkstatt_labels, "active_material", lambda db: strip)
    monkeypatch.setattr(type_label, "active_material", lambda db: strip)
    wrong = client.post(path, headers=auth_headers(admin_token), json={})
    assert wrong.status_code == 400, wrong.text
    assert wrong.json()["detail"].startswith("Für das Schrank-Etikett muss ein 99 × 44 Etikett")
    assert sent == []
    info = client.get(path, headers=auth_headers(admin_token)).json()
    assert info["material_ok"] is False and info["material"] == strip.name

    # Right stock, printer down.
    monkeypatch.setattr(type_label, "active_material", lambda db: DEFAULT_MATERIALS[0])

    def explode(host: str, port: int, payload: bytes) -> None:
        raise OSError("connection refused")

    monkeypatch.setattr(werkstatt_labels, "_send_tcp", explode)
    down = client.post(path, headers=auth_headers(admin_token), json={})
    assert down.status_code == 502, down.text


def test_unknown_panel_is_404_and_previews_need_a_session(client: TestClient, admin_token: str) -> None:
    assert client.get("/api/schaltplan/panels/999999/type-label", headers=auth_headers(admin_token)).status_code == 404
    assert client.post("/api/schaltplan/panels/999999/type-label", headers=auth_headers(admin_token), json={}).status_code == 404

    # The shared client carries the login cookie; a fresh one has no session.
    with TestClient(client.app) as anonymous:
        assert anonymous.get("/api/schaltplan/type-label/logo.png").status_code == 401
        assert anonymous.get("/api/schaltplan/type-label/qr.svg").status_code == 401
    logo = client.get("/api/schaltplan/type-label/logo.png", headers=auth_headers(admin_token))
    assert logo.status_code == 200 and logo.headers["content-type"] == "image/png" and logo.content[:8] == b"\x89PNG\r\n\x1a\n"
    qr = client.get("/api/schaltplan/type-label/qr.svg", headers=auth_headers(admin_token))
    assert qr.status_code == 200 and qr.headers["content-type"].startswith("image/svg+xml") and b"<svg" in qr.content


# ── Renderer ──────────────────────────────────────────────────────────────────


def test_qr_encodes_the_site_and_the_symbol_is_a_square_asset() -> None:
    modules = type_label.qr_matrix(type_label.TYPE_LABEL_URL)
    assert len(modules) == 33 and all(len(row) == 33 for row in modules)  # version 2 + 4-module quiet zone
    name, bmp, w, h = type_label.qr_asset(type_label.TYPE_LABEL_URL)
    assert name.startswith("QR") and len(name) == 10
    assert (w, h) == (231, 231) and bmp[:2] == b"BM"


def test_long_customer_names_shrink_the_block_but_never_below_the_floor() -> None:
    profile = DEFAULT_MATERIALS[0]
    short, _ = type_label.render_type_label(profile, type_label.TypeLabelContent("Müller", "12", "01.2026"))
    long, _ = type_label.render_type_label(
        profile, type_label.TypeLabelContent("Wohnungsbaugenossenschaft Hagen-Süd eG, Verwaltung", "12", "01.2026")
    )
    size_of = lambda job: int(next(line for line in job if line.startswith("AT,")).split(",")[3])
    assert size_of(short) == 42
    assert type_label._TEXT_SIZE_MIN <= size_of(long) < 42
    assert "Kunde: Wohnungsbaugenossenschaft Hagen-Süd eG, Verwaltung" in "\n".join(long)
