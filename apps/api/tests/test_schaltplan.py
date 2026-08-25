"""Verteilerpläne — panel schematics.

The behaviours pinned here are the ones the drawing and the printed legend
both depend on, plus the scoping rules that keep one customer's building
documentation out of another's:

  * topology is derived from device *order* — a circuit belongs to the last
    protective device before it. That single rule produces the diagram tree
    AND the legend's FI column, so it is tested directly rather than through
    either renderer;
  * a circuit placed before any FI is reported as unprotected instead of
    being quietly attached to something;
  * a dangling ``parent_id`` (the FI it named was deleted) degrades to
    "unprotected" and never raises — a 500 here would lock a crew out of the
    board they are standing in front of;
  * a plan's project must belong to the plan's customer, or a panel filed
    under customer A would surface in customer B's project;
  * designations are unique per customer: two boards called "UV1" in one
    building is a wiring hazard, not a cosmetic clash.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.services.schaltplan_layout import build_legend, build_topology, validate_document


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _customer(client: TestClient, admin_token: str, name: str = "Familie Schmitt") -> int:
    resp = client.post("/api/customers", headers=_auth(admin_token), json={"name": name})
    assert resp.status_code == 200, resp.text
    return resp.json()["id"]


def _project(client: TestClient, admin_token: str, customer_id: int, number: str = "P-900") -> int:
    resp = client.post(
        "/api/projects",
        headers=_auth(admin_token),
        json={"project_number": number, "name": "Neubau", "customer_id": customer_id},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["id"]


def _employee(client: TestClient, admin_token: str, email: str) -> str:
    resp = client.post(
        "/api/admin/users",
        headers=_auth(admin_token),
        json={
            "email": email,
            "password": "Password123!",
            "full_name": email.split("@")[0],
            "role": "employee",
        },
    )
    assert resp.status_code == 200, resp.text
    login = client.post("/api/auth/login", json={"email": email, "password": "Password123!"})
    assert login.status_code == 200, login.text
    return login.headers["X-Access-Token"]


def _device(device_id: str, kind: str, **overrides) -> dict:
    base = {
        "id": device_id,
        "kind": kind,
        "te": 1,
        "poles": 1,
        "designation": device_id.upper(),
        "circuit": "",
        "label": "",
        "room": "",
        "rating": "",
        "residual_current": "",
        "rcd_type": "",
        "cable": "",
        "phase": "-",
        "parent_id": None,
        "note": "",
    }
    base.update(overrides)
    return base


def _document(devices: list[dict]) -> dict:
    return {
        "version": 1,
        "supply": {
            "system": "TN-S",
            "voltage": "400/230 V",
            "incoming": "NYY-J 5x16 mm²",
            "fuse": "NH 63 A",
            "meter_number": "",
            "note": "",
        },
        "rows": [{"id": "row-1", "label": "Reihe 1", "slots": 12, "devices": devices}],
    }


def _create_panel(client: TestClient, token: str, customer_id: int, **overrides) -> dict:
    payload = {
        "customer_id": customer_id,
        "name": "Unterverteiler Keller",
        "designation": "UV1",
        "panel_type": "sub",
    }
    payload.update(overrides)
    resp = client.post("/api/schaltplan/panels", headers=_auth(token), json=payload)
    assert resp.status_code == 200, resp.text
    return resp.json()


# ── Topology: the rule the whole feature rests on ───────────────────────────


def test_circuits_belong_to_the_preceding_protective_device():
    document = _document(
        [
            _device("q1", "hauptschalter"),
            _device("f1", "rcd", residual_current="30 mA", rcd_type="A"),
            _device("c1", "mcb", circuit="1", label="Licht"),
            _device("c2", "mcb", circuit="2", label="Steckdosen"),
            _device("f2", "rcd", residual_current="300 mA", rcd_type="B"),
            _device("c3", "mcb", circuit="3", label="Wärmepumpe"),
        ]
    )
    groups = build_topology(document)["groups"]

    # Hauptschalter, FI 1, FI 2 — three groups, no phantom supply group.
    assert [g["device"]["id"] for g in groups] == ["q1", "f1", "f2"]
    assert [c["id"] for c in groups[0]["children"]] == []
    assert [c["id"] for c in groups[1]["children"]] == ["c1", "c2"]
    assert [c["id"] for c in groups[2]["children"]] == ["c3"]

    legend = build_legend(document)
    assert [row["circuit"] for row in legend] == ["1", "2", "3"]
    assert legend[0]["rcd"] == "30 mA / Typ A"
    assert legend[2]["rcd"] == "300 mA / Typ B"


def test_circuit_before_any_rcd_is_reported_unprotected():
    document = _document(
        [
            _device("c1", "mcb", circuit="1", label="Kellerlicht"),
            _device("f1", "rcd", residual_current="30 mA", rcd_type="A"),
            _device("c2", "mcb", circuit="2", label="Steckdosen"),
        ]
    )
    groups = build_topology(document)["groups"]
    assert groups[0]["device"] is None
    assert [c["id"] for c in groups[0]["children"]] == ["c1"]

    assert build_legend(document)[0]["rcd"] == "—"
    messages = [f["message"] for f in validate_document(document)]
    assert any("ohne vorgeschalteten" in message for message in messages)


def test_explicit_parent_overrides_position_and_dangling_parent_degrades():
    document = _document(
        [
            _device("f1", "rcd", residual_current="30 mA", rcd_type="A"),
            _device("c1", "mcb", circuit="1"),
            _device("f2", "rcd", residual_current="30 mA", rcd_type="F"),
            # Physically in FI 2's block, electrically fed from FI 1.
            _device("c2", "mcb", circuit="2", parent_id="f1"),
            # Points at an FI that no longer exists.
            _device("c3", "mcb", circuit="3", parent_id="ghost"),
        ]
    )
    topology = build_topology(document)
    by_group = {
        (g["device"]["id"] if g["device"] else None): [c["id"] for c in g["children"]]
        for g in topology["groups"]
    }
    assert by_group["f1"] == ["c1", "c2"]
    assert by_group["f2"] == []
    assert by_group[None] == ["c3"]
    assert [d["id"] for d in topology["orphans"]] == ["c3"]


def test_rcbo_is_its_own_circuit_not_a_group():
    """An RCBO protects only itself — adopting the next LS would print a
    wrong FI column on the legend an inspector reads."""

    document = _document(
        [
            _device("k1", "rcbo", circuit="1", residual_current="30 mA", rcd_type="A"),
            _device("c2", "mcb", circuit="2", label="Licht"),
        ]
    )
    legend = build_legend(document)
    assert legend[0]["rcd"] == "30 mA / Typ A"
    # The following LS is NOT protected by the RCBO.
    assert legend[1]["rcd"] == "—"


def test_non_circuit_devices_stay_off_the_legend():
    document = _document(
        [
            _device("f1", "rcd", residual_current="30 mA", rcd_type="A"),
            _device("s1", "spd", rating="Typ 2"),
            _device("t1", "terminal"),
            _device("b1", "blank"),
            _device("c1", "mcb", circuit="1", label="Licht"),
        ]
    )
    assert [row["circuit"] for row in build_legend(document)] == ["1"]


def test_validate_flags_duplicate_circuit_numbers_and_rail_overflow():
    document = _document(
        [
            _device("f1", "rcd", te=4, residual_current="30 mA", rcd_type="A"),
            _device("c1", "mcb", circuit="7", label="Licht", cable="NYM-J 3x1,5"),
            _device("c2", "mcb", circuit="7", label="Steckdosen", cable="NYM-J 3x1,5"),
        ]
    )
    document["rows"][0]["slots"] = 4  # 6 TE placed on a 4 TE rail
    messages = [f["message"] for f in validate_document(document)]
    assert any("7 ist 2× vergeben" in message for message in messages)
    assert any("TE belegt" in message for message in messages)


# ── API ─────────────────────────────────────────────────────────────────────


def test_employee_can_create_and_edit_a_panel(client: TestClient, admin_token: str):
    customer_id = _customer(client, admin_token)
    token = _employee(client, admin_token, "elektriker@example.com")

    panel = _create_panel(client, token, customer_id)
    assert panel["designation"] == "UV1"
    assert panel["revision"] == 1
    # A fresh board starts with one empty rail, not with guessed devices.
    assert len(panel["document"]["rows"]) == 1
    assert panel["document"]["rows"][0]["devices"] == []

    document = _document(
        [
            _device("f1", "rcd", te=4, poles=4, residual_current="30 mA", rcd_type="A"),
            _device(
                "c1", "mcb", circuit="1", label="Steckdosen Küche", room="Küche",
                rating="B16", cable="NYM-J 3x1,5 mm²", phase="L1",
            ),
        ]
    )
    resp = client.patch(
        f"/api/schaltplan/panels/{panel['id']}",
        headers=_auth(token),
        json={"document": document},
    )
    assert resp.status_code == 200, resp.text
    updated = resp.json()
    assert updated["circuit_count"] == 1
    assert updated["rcd_count"] == 1
    assert updated["used_slots"] == 5
    # A document change mints a new revision for the title block.
    assert updated["revision"] == 2
    assert updated["legend"][0]["label"] == "Steckdosen Küche"
    assert updated["legend"][0]["rcd"] == "30 mA / Typ A"


def test_designation_is_unique_per_customer_but_not_globally(client: TestClient, admin_token: str):
    first = _customer(client, admin_token, "Kunde A")
    second = _customer(client, admin_token, "Kunde B")

    _create_panel(client, admin_token, first, designation="UV1")
    clash = client.post(
        "/api/schaltplan/panels",
        headers=_auth(admin_token),
        json={"customer_id": first, "name": "Zweiter", "designation": "UV1"},
    )
    assert clash.status_code == 409

    # Same designation at a different customer is perfectly normal.
    _create_panel(client, admin_token, second, designation="UV1")


def test_project_must_belong_to_the_panels_customer(client: TestClient, admin_token: str):
    customer_a = _customer(client, admin_token, "Kunde A")
    customer_b = _customer(client, admin_token, "Kunde B")
    project_b = _project(client, admin_token, customer_b, number="P-B")

    resp = client.post(
        "/api/schaltplan/panels",
        headers=_auth(admin_token),
        json={
            "customer_id": customer_a,
            "project_id": project_b,
            "name": "UV",
            "designation": "UV9",
        },
    )
    assert resp.status_code == 400


def test_panel_cannot_feed_itself(client: TestClient, admin_token: str):
    customer_id = _customer(client, admin_token)
    panel = _create_panel(client, admin_token, customer_id)
    resp = client.patch(
        f"/api/schaltplan/panels/{panel['id']}",
        headers=_auth(admin_token),
        json={"fed_from_panel_id": panel["id"]},
    )
    assert resp.status_code == 400


def test_feeder_must_be_the_same_customer(client: TestClient, admin_token: str):
    customer_a = _customer(client, admin_token, "Kunde A")
    customer_b = _customer(client, admin_token, "Kunde B")
    foreign = _create_panel(client, admin_token, customer_b, designation="HV")
    mine = _create_panel(client, admin_token, customer_a, designation="UV1")

    resp = client.patch(
        f"/api/schaltplan/panels/{mine['id']}",
        headers=_auth(admin_token),
        json={"fed_from_panel_id": foreign["id"]},
    )
    assert resp.status_code == 400


def test_unknown_device_kind_and_duplicate_ids_are_rejected(client: TestClient, admin_token: str):
    customer_id = _customer(client, admin_token)
    panel = _create_panel(client, admin_token, customer_id)

    bad_kind = client.patch(
        f"/api/schaltplan/panels/{panel['id']}",
        headers=_auth(admin_token),
        json={"document": _document([_device("x1", "kernreaktor")])},
    )
    assert bad_kind.status_code == 422

    duplicate = client.patch(
        f"/api/schaltplan/panels/{panel['id']}",
        headers=_auth(admin_token),
        json={"document": _document([_device("x1", "mcb"), _device("x1", "mcb")])},
    )
    assert duplicate.status_code == 422


def test_only_creator_or_project_manager_may_delete(client: TestClient, admin_token: str):
    customer_id = _customer(client, admin_token)
    owner_token = _employee(client, admin_token, "owner@example.com")
    other_token = _employee(client, admin_token, "other@example.com")

    panel = _create_panel(client, owner_token, customer_id)

    denied = client.delete(f"/api/schaltplan/panels/{panel['id']}", headers=_auth(other_token))
    assert denied.status_code == 403

    allowed = client.delete(f"/api/schaltplan/panels/{panel['id']}", headers=_auth(owner_token))
    assert allowed.status_code == 204


def test_duplicate_copies_the_document_under_a_free_designation(client: TestClient, admin_token: str):
    customer_id = _customer(client, admin_token)
    panel = _create_panel(client, admin_token, customer_id, designation="UV1")
    client.patch(
        f"/api/schaltplan/panels/{panel['id']}",
        headers=_auth(admin_token),
        json={"document": _document([_device("c1", "mcb", circuit="1", label="Licht")])},
    )

    first = client.post(f"/api/schaltplan/panels/{panel['id']}/duplicate", headers=_auth(admin_token))
    assert first.status_code == 200, first.text
    assert first.json()["designation"] == "UV1-K"
    assert first.json()["circuit_count"] == 1

    second = client.post(f"/api/schaltplan/panels/{panel['id']}/duplicate", headers=_auth(admin_token))
    assert second.json()["designation"] == "UV1-K2"


def test_pdf_renders_diagram_and_legend(client: TestClient, admin_token: str):
    customer_id = _customer(client, admin_token)
    panel = _create_panel(client, admin_token, customer_id)
    client.patch(
        f"/api/schaltplan/panels/{panel['id']}",
        headers=_auth(admin_token),
        json={
            "document": _document(
                [
                    _device("q1", "hauptschalter", te=3, rating="63 A"),
                    _device("f1", "rcd", te=4, residual_current="30 mA", rcd_type="A"),
                    _device(
                        "c1", "mcb", circuit="1", label="Steckdosen Küche und Essbereich",
                        room="Küche", rating="B16", cable="NYM-J 3x1,5 mm²", phase="L1",
                    ),
                ]
            )
        },
    )

    resp = client.get(f"/api/schaltplan/panels/{panel['id']}/pdf", headers=_auth(admin_token))
    assert resp.status_code == 200, resp.text
    assert resp.headers["content-type"] == "application/pdf"
    assert resp.content.startswith(b"%PDF")

    legend_only = client.get(
        f"/api/schaltplan/panels/{panel['id']}/pdf?legend_only=true", headers=_auth(admin_token)
    )
    assert legend_only.status_code == 200
    # Legend-only really is shorter — the drawing sheet is skipped, not hidden.
    assert len(legend_only.content) < len(resp.content)


def test_pdf_survives_an_empty_board(client: TestClient, admin_token: str):
    """A panel created and not yet filled in is the most common state on the
    first site visit; printing it must not 500."""

    customer_id = _customer(client, admin_token)
    panel = _create_panel(client, admin_token, customer_id)
    resp = client.get(f"/api/schaltplan/panels/{panel['id']}/pdf", headers=_auth(admin_token))
    assert resp.status_code == 200
    assert resp.content.startswith(b"%PDF")


def test_panels_are_listed_per_customer_with_main_boards_first(client: TestClient, admin_token: str):
    customer_id = _customer(client, admin_token)
    other_customer = _customer(client, admin_token, "Andere GmbH")
    _create_panel(client, admin_token, customer_id, designation="UV2", panel_type="sub")
    _create_panel(client, admin_token, customer_id, designation="HV", panel_type="main")
    _create_panel(client, admin_token, other_customer, designation="UV-X")

    resp = client.get(f"/api/schaltplan/panels?customer_id={customer_id}", headers=_auth(admin_token))
    assert resp.status_code == 200, resp.text
    rows = resp.json()
    assert [row["designation"] for row in rows] == ["HV", "UV2"]


def test_device_catalog_is_served_to_the_client(client: TestClient, admin_token: str):
    resp = client.get("/api/schaltplan/devices", headers=_auth(admin_token))
    assert resp.status_code == 200
    kinds = {entry["kind"]: entry for entry in resp.json()}
    assert kinds["rcd"]["group"] is True
    assert kinds["rcd"]["circuit"] is False
    assert kinds["mcb"]["circuit"] is True
    assert kinds["rcbo"]["group"] is False
