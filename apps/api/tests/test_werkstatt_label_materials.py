"""Material profiles for the Werkstatt label printer.

The printer prints on very different stock — 99 × 44 type labels down to
Ø 3.2 mm heat-shrink tube — and the software must render what the LOADED
material can carry. These tests pin the three load-bearing behaviours:

  * the six workshop materials are seeded with their real dimensions and the
    active one changes the rendered geometry (`^W`/`^Q`),
  * formats degrade honestly: gross needs voll-tier stock, klein packs quads
    only where cutting makes sense, mini stock drops the DataMatrix rather
    than printing an unscannable one,
  * continuous stock computes its own length and takes free text.

The printer is faked at the transport seam exactly like the machine tests.
"""
from __future__ import annotations

from fastapi.testclient import TestClient


def auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _capture_sent(monkeypatch) -> list[tuple[str, int, bytes]]:
    from app.services import werkstatt_labels

    sent: list[tuple[str, int, bytes]] = []

    def fake_send(host: str, port: int, payload: bytes) -> None:
        sent.append((host, port, payload))

    monkeypatch.setattr(werkstatt_labels, "_send_tcp", fake_send)
    return sent


def _configure_printer(client: TestClient, admin_token: str, **extra) -> dict:
    resp = client.patch(
        "/api/admin/settings/label-printer",
        headers=auth_headers(admin_token),
        json={"host": "192.0.2.50", "port": 9100, **extra},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def _machine(client: TestClient, admin_token: str, name: str) -> dict:
    article = client.post(
        "/api/werkstatt/articles",
        headers=auth_headers(admin_token),
        json={"item_name": name, "unit": "Stk"},
    )
    assert article.status_code == 200, article.text
    machine = client.post(
        "/api/werkstatt/machines",
        headers=auth_headers(admin_token),
        json={"article_id": article.json()["id"]},
    )
    assert machine.status_code == 201, machine.text
    return machine.json()


def _jobs(payload: bytes) -> list[list[str]]:
    """Split a shipped batch into jobs (each ends with its `E` line)."""
    jobs: list[list[str]] = [[]]
    for line in payload.decode("utf-8").splitlines():
        jobs[-1].append(line)
        if line == "E":
            jobs.append([])
    assert jobs[-1] == [], "payload must end at a job boundary"
    return jobs[:-1]


# ── Seeding & selection ────────────────────────────────────────────────────


def test_default_materials_are_seeded_with_804_active(
    client: TestClient, admin_token: str
) -> None:
    resp = client.get(
        "/api/admin/settings/label-printer", headers=auth_headers(admin_token)
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()

    by_id = {m["id"]: m for m in body["materials"]}
    assert body["active_material_id"] == "wago-210-804"
    assert body["active_tier"] == "voll"

    assert by_id["wago-210-804"]["width_mm"] == 44
    assert by_id["wago-210-804"]["length_mm"] == 99
    assert by_id["wago-210-824"]["tier"] == "voll"
    assert by_id["wago-210-812"]["width_mm"] == 25
    assert by_id["wago-210-812"]["length_mm"] == 50
    assert by_id["wago-210-812"]["tier"] == "kompakt"
    assert by_id["wago-210-805"]["tier"] == "mini"
    assert by_id["wago-211-501"]["length_mm"] is None  # continuous
    assert by_id["wago-2009-110"]["length_mm"] is None
    assert all(m["builtin"] for m in body["materials"])


def test_switching_active_material_changes_sheet_geometry(
    client: TestClient, admin_token: str, monkeypatch
) -> None:
    machine = _machine(client, admin_token, "Winkelschleifer")
    _configure_printer(client, admin_token, active_material_id="wago-210-812")
    sent = _capture_sent(monkeypatch)

    resp = client.post(
        "/api/werkstatt/machines/print-labels",
        headers=auth_headers(admin_token),
        json={"items": [{"unit_id": machine["id"], "format": "klein"}]},
    )
    assert resp.status_code == 200, resp.text

    lines = _jobs(sent[0][2])[0]
    # 210-812: 50 × 25 → 25 mm across the head, 50 mm feed, 3 mm gap.
    assert lines[0] == "^Q50,3"
    assert "^W25" in lines
    # Kompakt keeps the DataMatrix.
    assert any(line.startswith("XRB") for line in lines)


# ── Format gating ──────────────────────────────────────────────────────────


def test_gross_format_requires_voll_material(
    client: TestClient, admin_token: str, monkeypatch
) -> None:
    machine = _machine(client, admin_token, "Kappsäge")
    _configure_printer(client, admin_token, active_material_id="wago-210-805")
    sent = _capture_sent(monkeypatch)

    resp = client.post(
        f"/api/werkstatt/machines/{machine['id']}/print-label",
        headers=auth_headers(admin_token),
    )
    assert resp.status_code == 400, resp.text
    assert "Vollformat" in resp.json()["detail"]
    assert sent == []


def test_klein_on_kompakt_stock_prints_one_label_per_sheet_without_cuts(
    client: TestClient, admin_token: str, monkeypatch
) -> None:
    first = _machine(client, admin_token, "Akku A")
    second = _machine(client, admin_token, "Akku B")
    _configure_printer(client, admin_token, active_material_id="wago-210-812")
    sent = _capture_sent(monkeypatch)

    resp = client.post(
        "/api/werkstatt/machines/print-labels",
        headers=auth_headers(admin_token),
        json={
            "items": [
                {"unit_id": first["id"], "format": "klein"},
                {"unit_id": second["id"], "format": "klein"},
            ]
        },
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["sheets"] == 2  # the material IS small — no packing

    jobs = _jobs(sent[0][2])
    assert len(jobs) == 2
    assert not any(line.startswith("Lo,") for job in jobs for line in job)


def test_klein_on_voll_stock_still_packs_four_with_cut_lines(
    client: TestClient, admin_token: str, monkeypatch
) -> None:
    machines = [_machine(client, admin_token, f"Gerät {i}") for i in range(4)]
    _configure_printer(client, admin_token)  # default active: 210-804
    sent = _capture_sent(monkeypatch)

    resp = client.post(
        "/api/werkstatt/machines/print-labels",
        headers=auth_headers(admin_token),
        json={"items": [{"unit_id": m["id"], "format": "klein"} for m in machines]},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["sheets"] == 1

    lines = _jobs(sent[0][2])[0]
    assert any(line.startswith("Lo,") for line in lines)  # scissor dashes


def test_mini_stock_prints_number_only_without_datamatrix(
    client: TestClient, admin_token: str, monkeypatch
) -> None:
    machine = _machine(client, admin_token, "Multimeter")
    _configure_printer(client, admin_token, active_material_id="wago-210-805")
    sent = _capture_sent(monkeypatch)

    resp = client.post(
        "/api/werkstatt/machines/print-labels",
        headers=auth_headers(admin_token),
        json={"items": [{"unit_id": machine["id"], "format": "klein"}]},
    )
    assert resp.status_code == 200, resp.text

    lines = _jobs(sent[0][2])[0]
    assert lines[0] == "^Q15,3"
    assert "^W6" in lines
    # A DataMatrix under ~6 mm cannot be scanned by a phone — honesty over decor.
    assert not any(line.startswith("XRB") for line in lines)
    assert any(machine["unit_number"] in line and line.startswith("AT,") for line in lines)


# ── Continuous stock & free text ───────────────────────────────────────────


def test_freetext_on_marking_strip_computes_length_and_copies(
    client: TestClient, admin_token: str, monkeypatch
) -> None:
    _configure_printer(client, admin_token, active_material_id="wago-2009-110")
    sent = _capture_sent(monkeypatch)

    resp = client.post(
        "/api/admin/settings/label-printer/freetext",
        headers=auth_headers(admin_token),
        json={"text": "F1 Herd 16A", "copies": 3},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["ok"] is True

    lines = _jobs(sent[0][2])[0]
    assert "^W11" in lines
    assert "^C3" in lines
    q_line = lines[0]
    assert q_line.startswith("^Q") and q_line.endswith(",0")  # continuous: gap 0
    length_mm = int(q_line[2:].split(",")[0])
    assert 15 <= length_mm <= 120
    assert any("F1 Herd 16A" in line for line in lines)


def test_freetext_rejects_blank_text(client: TestClient, admin_token: str) -> None:
    _configure_printer(client, admin_token, active_material_id="wago-2009-110")
    resp = client.post(
        "/api/admin/settings/label-printer/freetext",
        headers=auth_headers(admin_token),
        json={"text": "   ", "copies": 1},
    )
    assert resp.status_code == 422, resp.text


def test_machine_label_on_heat_shrink_is_a_narrow_continuous_job(
    client: TestClient, admin_token: str, monkeypatch
) -> None:
    machine = _machine(client, admin_token, "Verlängerung 25m")
    _configure_printer(client, admin_token, active_material_id="wago-211-501")
    sent = _capture_sent(monkeypatch)

    resp = client.post(
        "/api/werkstatt/machines/print-labels",
        headers=auth_headers(admin_token),
        json={"items": [{"unit_id": machine["id"], "format": "klein"}]},
    )
    assert resp.status_code == 200, resp.text

    lines = _jobs(sent[0][2])[0]
    assert "^W5" in lines  # Ø 3.2 mm tube lies ~5 mm flat
    assert lines[0].endswith(",0")
    assert not any(line.startswith("XRB") for line in lines)


# ── Custom materials ───────────────────────────────────────────────────────


def test_custom_material_can_be_added_and_activated(
    client: TestClient, admin_token: str, monkeypatch
) -> None:
    body = _configure_printer(client, admin_token)
    materials = body["materials"] + [
        {
            "id": "custom-38x23",
            "name": "Fremdetikett 38 × 23",
            "part_no": "",
            "width_mm": 23,
            "length_mm": 38,
            "gap_mm": 3,
        }
    ]
    updated = _configure_printer(
        client, admin_token, materials=materials, active_material_id="custom-38x23"
    )
    assert updated["active_material_id"] == "custom-38x23"
    assert updated["active_tier"] == "kompakt"

    custom = next(m for m in updated["materials"] if m["id"] == "custom-38x23")
    assert custom["builtin"] is False


def test_builtin_materials_cannot_be_removed(
    client: TestClient, admin_token: str
) -> None:
    body = _configure_printer(client, admin_token)
    without_804 = [m for m in body["materials"] if m["id"] != "wago-210-804"]
    resp = client.patch(
        "/api/admin/settings/label-printer",
        headers=auth_headers(admin_token),
        json={"host": "192.0.2.50", "port": 9100, "materials": without_804},
    )
    assert resp.status_code == 400, resp.text
    assert "wago-210-804" in resp.json()["detail"]


def test_unknown_active_material_is_rejected(
    client: TestClient, admin_token: str
) -> None:
    resp = client.patch(
        "/api/admin/settings/label-printer",
        headers=auth_headers(admin_token),
        json={"host": "192.0.2.50", "port": 9100, "active_material_id": "does-not-exist"},
    )
    assert resp.status_code == 400, resp.text


def test_label_capabilities_reflect_the_active_material(
    client: TestClient, admin_token: str
) -> None:
    """Must not be swallowed by /machines/{unit_id} — route order matters."""
    caps = client.get(
        "/api/werkstatt/machines/label-capabilities", headers=auth_headers(admin_token)
    )
    assert caps.status_code == 200, caps.text
    assert caps.json()["gross"] is True  # default stock is 99 × 44

    _configure_printer(client, admin_token, active_material_id="wago-210-805")
    caps = client.get(
        "/api/werkstatt/machines/label-capabilities", headers=auth_headers(admin_token)
    )
    assert caps.status_code == 200, caps.text
    body = caps.json()
    assert body["gross"] is False
    assert body["klein"] is True
    assert "Vollformat" in (body["hint"] or "")
