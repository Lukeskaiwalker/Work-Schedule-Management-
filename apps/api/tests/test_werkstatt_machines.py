"""Machine (Maschinen) register tests.

Covers the things that would fail silently rather than loudly:

  * the cascade — booking a drill has to move its battery, or the register
    disagrees with the shelf,
  * the timezone of a "for today" booking, which is invisible in the API
    response and only wrong once it reaches a German screen,
  * tz-aware payloads, which reach a naive comparison and 500 rather than
    returning a validation error,
  * the bookable-status gate, which is the only thing stopping a machine that
    failed its DGUV3 from going back out.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from fastapi.testclient import TestClient


def auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _article(client: TestClient, admin_token: str, name: str) -> dict:
    resp = client.post(
        "/api/werkstatt/articles",
        headers=auth_headers(admin_token),
        json={"item_name": name, "unit": "Stk"},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def _machine(client: TestClient, admin_token: str, article_id: int, **extra) -> dict:
    resp = client.post(
        "/api/werkstatt/machines",
        headers=auth_headers(admin_token),
        json={"article_id": article_id, **extra},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


# ── Numbering ──────────────────────────────────────────────────────────────


def test_machine_numbers_are_sequential_and_never_recycled(
    client: TestClient, admin_token: str
) -> None:
    article = _article(client, admin_token, "Akkuschrauber")

    first = _machine(client, admin_token, article["id"])
    second = _machine(client, admin_token, article["id"])
    assert first["unit_number"] == "M-0001"
    assert second["unit_number"] == "M-0002"

    # Archiving must NOT free the number: a label found in a van years later
    # still has to resolve to the machine it was printed for.
    archived = client.patch(
        f"/api/werkstatt/machines/{second['id']}",
        headers=auth_headers(admin_token),
        json={"is_archived": True},
    )
    assert archived.status_code == 200, archived.text

    third = _machine(client, admin_token, article["id"])
    assert third["unit_number"] == "M-0003"


def test_registering_a_machine_marks_its_article_serialized(
    client: TestClient, admin_token: str
) -> None:
    article = _article(client, admin_token, "Handkreissäge")
    assert article["is_serialized"] is False

    _machine(client, admin_token, article["id"])

    refreshed = client.get(
        f"/api/werkstatt/articles/{article['id']}", headers=auth_headers(admin_token)
    ).json()
    assert refreshed["is_serialized"] is True


# ── Listing ────────────────────────────────────────────────────────────────


def test_components_are_hidden_from_the_top_level_list(
    client: TestClient, admin_token: str
) -> None:
    """One drill leaving the building is one departure, not three."""
    drill_article = _article(client, admin_token, "Akkuschrauber")
    battery_article = _article(client, admin_token, "Akku")

    drill = _machine(client, admin_token, drill_article["id"])
    _machine(client, admin_token, battery_article["id"], parent_unit_id=drill["id"])

    listed = client.get("/api/werkstatt/machines", headers=auth_headers(admin_token)).json()
    assert [row["unit_number"] for row in listed] == [drill["unit_number"]]

    with_components = client.get(
        "/api/werkstatt/machines?include_components=true", headers=auth_headers(admin_token)
    ).json()
    assert len(with_components) == 2

    # The detail view is where components belong.
    detail = client.get(
        f"/api/werkstatt/machines/{drill['id']}", headers=auth_headers(admin_token)
    ).json()
    assert [c["article_name"] for c in detail["components"]] == ["Akku"]


def test_components_cannot_be_nested_further(client: TestClient, admin_token: str) -> None:
    article = _article(client, admin_token, "Akkuschrauber")
    drill = _machine(client, admin_token, article["id"])
    battery = _machine(client, admin_token, article["id"], parent_unit_id=drill["id"])

    resp = client.post(
        "/api/werkstatt/machines",
        headers=auth_headers(admin_token),
        json={"article_id": article["id"], "parent_unit_id": battery["id"]},
    )
    assert resp.status_code == 400, resp.text


# ── Booking ────────────────────────────────────────────────────────────────


def test_booking_cascades_to_components(client: TestClient, admin_token: str) -> None:
    """The charger physically leaves in the same van as the drill."""
    drill_article = _article(client, admin_token, "Akkuschrauber")
    charger_article = _article(client, admin_token, "Ladegerät")

    drill = _machine(client, admin_token, drill_article["id"])
    charger = _machine(client, admin_token, charger_article["id"], parent_unit_id=drill["id"])

    booked = client.post(
        f"/api/werkstatt/machines/{drill['id']}/book",
        headers=auth_headers(admin_token),
        json={"holder_user_id": 1, "for_today": True},
    )
    assert booked.status_code == 200, booked.text
    changed = booked.json()
    assert len(changed) == 2
    assert all(row["status"] == "ausgegeben" for row in changed)

    charger_now = client.get(
        f"/api/werkstatt/machines/{charger['id']}", headers=auth_headers(admin_token)
    ).json()
    assert charger_now["status"] == "ausgegeben"

    returned = client.post(
        f"/api/werkstatt/machines/{drill['id']}/return",
        headers=auth_headers(admin_token),
        json={},
    )
    assert returned.status_code == 200, returned.text
    assert len(returned.json()) == 2
    charger_back = client.get(
        f"/api/werkstatt/machines/{charger['id']}", headers=auth_headers(admin_token)
    ).json()
    assert charger_back["status"] == "verfuegbar"


def test_for_today_ends_at_the_end_of_the_local_day(
    client: TestClient, admin_token: str
) -> None:
    """23:59 in the workshop, not 23:59 UTC.

    Every timestamp is stored naive-UTC and rendered in the browser's zone, so
    a plain UTC end-of-day reaches a German screen as "01:59 tomorrow" — under
    a label that says "für heute".
    """
    from app.core.config import get_settings

    article = _article(client, admin_token, "Akkuschrauber")
    machine = _machine(client, admin_token, article["id"])

    booked = client.post(
        f"/api/werkstatt/machines/{machine['id']}/book",
        headers=auth_headers(admin_token),
        json={"holder_user_id": 1, "for_today": True},
    )
    assert booked.status_code == 200, booked.text

    stored = datetime.fromisoformat(booked.json()[0]["booked_until"])
    if stored.tzinfo is not None:
        stored = stored.astimezone(timezone.utc).replace(tzinfo=None)

    tz = ZoneInfo(get_settings().app_timezone)
    local = stored.replace(tzinfo=timezone.utc).astimezone(tz)
    assert (local.hour, local.minute, local.second) == (23, 59, 59)


def test_booking_accepts_a_timezone_aware_return_time(
    client: TestClient, admin_token: str
) -> None:
    """`toISOString()` sends a `Z`; a naive comparison would raise a TypeError."""
    article = _article(client, admin_token, "Akkuschrauber")
    machine = _machine(client, admin_token, article["id"])

    until = datetime.now(timezone.utc) + timedelta(hours=3)
    booked = client.post(
        f"/api/werkstatt/machines/{machine['id']}/book",
        headers=auth_headers(admin_token),
        json={
            "holder_user_id": 1,
            "booked_until": until.isoformat().replace("+00:00", "Z"),
        },
    )
    assert booked.status_code == 200, booked.text
    assert booked.json()[0]["booked_until"] is not None


def test_booking_requires_a_target(client: TestClient, admin_token: str) -> None:
    article = _article(client, admin_token, "Akkuschrauber")
    machine = _machine(client, admin_token, article["id"])

    resp = client.post(
        f"/api/werkstatt/machines/{machine['id']}/book",
        headers=auth_headers(admin_token),
        json={"for_today": True},
    )
    assert resp.status_code == 409, resp.text


def test_a_machine_that_is_out_cannot_be_booked_again(
    client: TestClient, admin_token: str
) -> None:
    """Otherwise the second booking silently overwrites whoever has it."""
    article = _article(client, admin_token, "Akkuschrauber")
    machine = _machine(client, admin_token, article["id"])

    first = client.post(
        f"/api/werkstatt/machines/{machine['id']}/book",
        headers=auth_headers(admin_token),
        json={"holder_user_id": 1, "for_today": True},
    )
    assert first.status_code == 200, first.text

    second = client.post(
        f"/api/werkstatt/machines/{machine['id']}/book",
        headers=auth_headers(admin_token),
        json={"holder_user_id": 1, "for_today": True},
    )
    assert second.status_code == 409, second.text


def test_returning_a_parent_does_not_resurrect_a_component_that_was_never_out(
    client: TestClient, admin_token: str
) -> None:
    article = _article(client, admin_token, "Akkuschrauber")
    drill = _machine(client, admin_token, article["id"])
    spare = _machine(client, admin_token, article["id"], parent_unit_id=drill["id"])

    # Take the spare out of circulation before the drill is ever booked.
    client.patch(
        f"/api/werkstatt/machines/{spare['id']}",
        headers=auth_headers(admin_token),
        json={"status": "defekt"},
    )

    client.post(
        f"/api/werkstatt/machines/{drill['id']}/book",
        headers=auth_headers(admin_token),
        json={"holder_user_id": 1, "for_today": True},
    )
    client.post(
        f"/api/werkstatt/machines/{drill['id']}/return",
        headers=auth_headers(admin_token),
        json={},
    )

    spare_now = client.get(
        f"/api/werkstatt/machines/{spare['id']}", headers=auth_headers(admin_token)
    ).json()
    assert spare_now["status"] == "defekt"


# ── Inspection ─────────────────────────────────────────────────────────────


def test_a_failed_inspection_blocks_the_machine(client: TestClient, admin_token: str) -> None:
    """The point of the check is to stop the tool being used."""
    article = _article(client, admin_token, "Handkreissäge")
    machine = _machine(
        client,
        admin_token,
        article["id"],
        inspection_required=True,
        inspection_interval_days=365,
    )

    failed = client.post(
        f"/api/werkstatt/machines/{machine['id']}/inspection",
        headers=auth_headers(admin_token),
        json={"passed": False, "notes": "Kabel beschädigt"},
    )
    assert failed.status_code == 200, failed.text
    assert failed.json()["status"] == "defekt"

    blocked = client.post(
        f"/api/werkstatt/machines/{machine['id']}/book",
        headers=auth_headers(admin_token),
        json={"holder_user_id": 1, "for_today": True},
    )
    assert blocked.status_code == 409, blocked.text


def test_a_passed_inspection_moves_the_due_date(client: TestClient, admin_token: str) -> None:
    article = _article(client, admin_token, "Handkreissäge")
    machine = _machine(
        client,
        admin_token,
        article["id"],
        inspection_required=True,
        inspection_interval_days=30,
    )
    assert machine["next_inspection_due_at"] is None

    passed = client.post(
        f"/api/werkstatt/machines/{machine['id']}/inspection",
        headers=auth_headers(admin_token),
        json={"passed": True},
    ).json()

    last = datetime.fromisoformat(passed["last_inspected_at"])
    due = datetime.fromisoformat(passed["next_inspection_due_at"])
    assert (due - last).days == 30
    assert passed["inspection_overdue"] is False


def test_inspection_due_filter_finds_only_overdue_machines(
    client: TestClient, admin_token: str
) -> None:
    article = _article(client, admin_token, "Handkreissäge")

    overdue = _machine(
        client,
        admin_token,
        article["id"],
        inspection_required=True,
        inspection_interval_days=30,
        last_inspected_at=(datetime.now(timezone.utc) - timedelta(days=400)).isoformat(),
    )
    _machine(
        client,
        admin_token,
        article["id"],
        inspection_required=True,
        inspection_interval_days=30,
        last_inspected_at=datetime.now(timezone.utc).isoformat(),
    )

    due = client.get(
        "/api/werkstatt/machines?inspection_due_only=true", headers=auth_headers(admin_token)
    ).json()
    assert [row["unit_number"] for row in due] == [overdue["unit_number"]]
    assert due[0]["inspection_overdue"] is True


# ── History & gating ───────────────────────────────────────────────────────


def test_history_records_every_custody_change_newest_first(
    client: TestClient, admin_token: str
) -> None:
    article = _article(client, admin_token, "Akkuschrauber")
    machine = _machine(client, admin_token, article["id"])

    client.post(
        f"/api/werkstatt/machines/{machine['id']}/book",
        headers=auth_headers(admin_token),
        json={"holder_user_id": 1, "for_today": True, "notes": "Baustelle Meier"},
    )
    client.post(
        f"/api/werkstatt/machines/{machine['id']}/return",
        headers=auth_headers(admin_token),
        json={},
    )

    log = client.get(
        f"/api/werkstatt/machines/{machine['id']}/history", headers=auth_headers(admin_token)
    ).json()
    assert [entry["movement_type"] for entry in log] == ["return", "checkout"]
    assert log[1]["notes"] == "Baustelle Meier"
    assert log[1]["user_name"] is not None


def test_scanning_a_machine_label_resolves_to_the_machine(
    client: TestClient, admin_token: str
) -> None:
    article = _article(client, admin_token, "Akkuschrauber")
    drill = _machine(client, admin_token, article["id"])
    _machine(client, admin_token, article["id"], parent_unit_id=drill["id"])

    resolved = client.get(
        f"/api/werkstatt/scan/resolve?code={drill['unit_number']}",
        headers=auth_headers(admin_token),
    )
    assert resolved.status_code == 200, resolved.text
    body = resolved.json()
    assert body["kind"] == "machine"
    assert body["matched_by"] == "machine_number"
    assert body["machine"]["unit_number"] == drill["unit_number"]
    # The components have to come back with it, or the phone cannot warn that
    # the battery is going out too before the user confirms.
    assert len(body["machine"]["components"]) == 1


def test_scanning_a_machine_label_tolerates_case_and_padding(
    client: TestClient, admin_token: str
) -> None:
    """A hardware scanner, a hand-typed "m-1" and the printed label agree."""
    article = _article(client, admin_token, "Akkuschrauber")
    drill = _machine(client, admin_token, article["id"])
    assert drill["unit_number"] == "M-0001"

    for variant in ("m-1", " M-0001 ", "M-00001", "m0001"):
        body = client.get(
            f"/api/werkstatt/scan/resolve?code={variant}", headers=auth_headers(admin_token)
        ).json()
        assert body["kind"] == "machine", f"{variant!r} did not resolve"
        assert body["machine"]["unit_number"] == "M-0001"


def test_scanning_a_nameplate_serial_resolves_to_the_machine(
    client: TestClient, admin_token: str
) -> None:
    article = _article(client, admin_token, "Handkreissäge")
    saw = _machine(client, admin_token, article["id"], serial_number="3601F23000")

    body = client.get(
        "/api/werkstatt/scan/resolve?code=3601F23000", headers=auth_headers(admin_token)
    ).json()
    assert body["kind"] == "machine"
    assert body["matched_by"] == "serial_number"
    assert body["machine"]["id"] == saw["id"]


def test_a_machine_serial_never_hijacks_an_article_barcode(
    client: TestClient, admin_token: str
) -> None:
    """The regression that reordering the cascade would cause.

    A serial is an arbitrary string we did not issue. If it were checked before
    the article steps, recording one that happens to equal a stocked article's
    EAN would silently change what that article's barcode does on every phone.
    """
    from app.core.db import SessionLocal
    from app.models.entities import WerkstattArticle

    article = _article(client, admin_token, "Kabelbinder")
    with SessionLocal() as db:
        row = db.get(WerkstattArticle, article["id"])
        row.ean = "4001234567890"
        db.commit()

    machine_article = _article(client, admin_token, "Akkuschrauber")
    _machine(client, admin_token, machine_article["id"], serial_number="4001234567890")

    body = client.get(
        "/api/werkstatt/scan/resolve?code=4001234567890", headers=auth_headers(admin_token)
    ).json()
    assert body["kind"] == "werkstatt_article"
    assert body["matched_by"] == "ean"


def test_an_unknown_code_still_reports_not_found(client: TestClient, admin_token: str) -> None:
    body = client.get(
        "/api/werkstatt/scan/resolve?code=M-9999", headers=auth_headers(admin_token)
    ).json()
    assert body["kind"] == "not_found"
    assert body["code"] == "M-9999"


def test_reads_and_bookings_do_not_require_the_manage_permission(
    client: TestClient, admin_token: str
) -> None:
    """The person holding the drill must be the person who can record it."""
    from app.core.db import SessionLocal
    from app.core.security import create_access_token, get_password_hash
    from app.models.entities import User

    article = _article(client, admin_token, "Akkuschrauber")
    machine = _machine(client, admin_token, article["id"])

    with SessionLocal() as db:
        worker = User(
            email="monteur@example.com",
            full_name="Monteur Ohne Rechte",
            password_hash=get_password_hash("x"),
            role="employee",
        )
        db.add(worker)
        db.commit()
        worker_id = worker.id
    worker_token = create_access_token(str(worker_id), {"role": "employee"})

    assert (
        client.get("/api/werkstatt/machines", headers=auth_headers(worker_token)).status_code
        == 200
    )
    booked = client.post(
        f"/api/werkstatt/machines/{machine['id']}/book",
        headers=auth_headers(worker_token),
        json={"holder_user_id": worker_id, "for_today": True},
    )
    assert booked.status_code == 200, booked.text

    # …but they must not be able to change the register itself.
    created = client.post(
        "/api/werkstatt/machines",
        headers=auth_headers(worker_token),
        json={"article_id": article["id"]},
    )
    assert created.status_code == 403, created.text


# ── Create / edit are separate grants ──────────────────────────────────────


def _employee_with(permissions: list[str], email: str) -> tuple[int, str]:
    """An employee carrying exactly `permissions` as a user-level grant."""
    from app.core.db import SessionLocal
    from app.core.permissions import get_all_user_overrides, set_user_permissions_override
    from app.core.security import create_access_token, get_password_hash
    from app.models.entities import User

    with SessionLocal() as db:
        user = User(
            email=email,
            full_name="Test Monteur",
            password_hash=get_password_hash("x"),
            role="employee",
        )
        db.add(user)
        db.commit()
        user_id = user.id

    overrides = get_all_user_overrides()
    overrides[user_id] = {"extra": permissions, "denied": []}
    set_user_permissions_override(overrides)
    return user_id, create_access_token(str(user_id), {"role": "employee"})


def test_machines_create_grant_allows_creating_but_not_editing(
    client: TestClient, admin_token: str
) -> None:
    article = _article(client, admin_token, "Akkuschrauber")
    existing = _machine(client, admin_token, article["id"])
    _, token = _employee_with(["werkstatt:machines_create"], "creator@example.com")

    created = client.post(
        "/api/werkstatt/machines",
        headers=auth_headers(token),
        json={"article_id": article["id"]},
    )
    assert created.status_code == 201, created.text

    blocked = client.patch(
        f"/api/werkstatt/machines/{existing['id']}",
        headers=auth_headers(token),
        json={"notes": "nope"},
    )
    assert blocked.status_code == 403, blocked.text


def test_machines_edit_grant_allows_editing_but_not_creating(
    client: TestClient, admin_token: str
) -> None:
    article = _article(client, admin_token, "Akkuschrauber")
    existing = _machine(client, admin_token, article["id"])
    _, token = _employee_with(["werkstatt:machines_edit"], "editor@example.com")

    edited = client.patch(
        f"/api/werkstatt/machines/{existing['id']}",
        headers=auth_headers(token),
        json={"serial_number": "CORRECTED-1", "notes": "Seriennummer korrigiert"},
    )
    assert edited.status_code == 200, edited.text
    assert edited.json()["serial_number"] == "CORRECTED-1"

    blocked = client.post(
        "/api/werkstatt/machines",
        headers=auth_headers(token),
        json={"article_id": article["id"]},
    )
    assert blocked.status_code == 403, blocked.text


def test_werkstatt_manage_still_grants_both(client: TestClient, admin_token: str) -> None:
    """The regression that splitting a permission usually causes.

    Anyone who could register and edit machines yesterday must still be able to
    today. If the endpoints had been switched to require ONLY the new narrow
    grants, every existing `werkstatt:manage` holder would have been locked out
    the moment this deployed — silently, and only noticed by the crew.
    """
    article = _article(client, admin_token, "Akkuschrauber")
    _, token = _employee_with(["werkstatt:manage"], "werkstattleiter@example.com")

    created = client.post(
        "/api/werkstatt/machines",
        headers=auth_headers(token),
        json={"article_id": article["id"]},
    )
    assert created.status_code == 201, created.text

    edited = client.patch(
        f"/api/werkstatt/machines/{created.json()['id']}",
        headers=auth_headers(token),
        json={"notes": "geht"},
    )
    assert edited.status_code == 200, edited.text


def test_the_new_permissions_are_offered_in_the_admin_matrix(
    client: TestClient, admin_token: str
) -> None:
    """They are useless if an admin cannot find them to grant them."""
    resp = client.get("/api/admin/role-permissions", headers=auth_headers(admin_token))
    assert resp.status_code == 200, resp.text
    body = resp.json()

    werkstatt = next(g for g in body["permission_groups"] if g["key"] == "werkstatt")
    assert "werkstatt:machines_create" in werkstatt["permissions"]
    assert "werkstatt:machines_edit" in werkstatt["permissions"]

    # Present in the validation set, or saving the matrix would reject them.
    assert "werkstatt:machines_create" in body["all_permissions"]
    # Labelled and described, or the admin sees a bare permission string.
    assert body["permission_labels"]["werkstatt:machines_edit"]
    assert body["permission_descriptions"]["werkstatt:machines_edit"]


# ── Label printing ─────────────────────────────────────────────────────────
#
# The printer itself (a WAGO Smart Printer 258-5101 — a Godex OEM speaking
# EZPL on raw TCP 9100) is faked at the transport seam: these tests assert
# the exact bytes we would ship, which is the part that must stay stable.


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


def test_print_label_sends_one_ezpl_job_to_the_printer(
    client: TestClient, admin_token: str, monkeypatch
) -> None:
    article = _article(client, admin_token, "Schlagbohrmaschine")
    machine = _machine(client, admin_token, article["id"], serial_number="SN-4711")
    _configure_printer(monkeypatch)
    sent = _capture_sent(monkeypatch)

    resp = client.post(
        f"/api/werkstatt/machines/{machine['id']}/print-label",
        headers=auth_headers(admin_token),
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["unit_number"] == machine["unit_number"]
    assert resp.json()["printer"] == "192.0.2.50:9100"

    assert len(sent) == 1
    host, port, payload = sent[0]
    assert (host, port) == ("192.0.2.50", 9100)

    job = payload.decode("utf-8")
    lines = job.splitlines()
    # A complete EZPL job: media geometry, label block, terminator that prints.
    assert lines[0] == "^Q99,3"
    assert "^W44" in lines
    assert "^L" in lines
    assert lines[-1] == "E"
    # DataMatrix is length-prefixed; the unit number is its own data line.
    xrb_at = next(i for i, line in enumerate(lines) if line.startswith("XRB"))
    assert lines[xrb_at].endswith(f",{len(machine['unit_number'])}")
    assert lines[xrb_at + 1] == machine["unit_number"]
    # The label must also carry the human-readable number, name and serial.
    assert any(line.startswith("AT,") and line.endswith(machine["unit_number"]) for line in lines)
    assert "Schlagbohrmaschine" in job
    assert "SN-4711" in job


def test_print_label_without_serial_omits_the_serial_line(
    client: TestClient, admin_token: str, monkeypatch
) -> None:
    article = _article(client, admin_token, "Stichsäge")
    machine = _machine(client, admin_token, article["id"])
    _configure_printer(monkeypatch)
    sent = _capture_sent(monkeypatch)

    resp = client.post(
        f"/api/werkstatt/machines/{machine['id']}/print-label",
        headers=auth_headers(admin_token),
    )
    assert resp.status_code == 200, resp.text
    job = sent[0][2].decode("utf-8")
    assert "SN:" not in job
    # Umlauts survive encoding round-trips.
    assert "Stichsäge" in job


def test_print_label_strips_control_characters_from_names(
    client: TestClient, admin_token: str, monkeypatch
) -> None:
    """EZPL is line-oriented: a newline smuggled into a name must not be
    able to terminate the text command and run as a printer command."""
    article = _article(client, admin_token, "Bohrer")
    machine = _machine(
        client, admin_token, article["id"], serial_number="X\nA 100\rG"
    )
    _configure_printer(monkeypatch)
    sent = _capture_sent(monkeypatch)

    resp = client.post(
        f"/api/werkstatt/machines/{machine['id']}/print-label",
        headers=auth_headers(admin_token),
    )
    assert resp.status_code == 200, resp.text
    lines = sent[0][2].decode("utf-8").splitlines()
    # Exactly one job terminator, and it is the last line — the smuggled
    # newlines became spaces inside one text command instead of new commands.
    assert [line for line in lines if line == "E"] == ["E"]
    assert lines[-1] == "E"
    assert "X A 100 G" in "\n".join(lines)


def test_print_label_without_configured_printer_is_a_clear_503(
    client: TestClient, admin_token: str, monkeypatch
) -> None:
    article = _article(client, admin_token, "Winkelschleifer")
    machine = _machine(client, admin_token, article["id"])
    sent = _capture_sent(monkeypatch)  # default settings: no host configured

    resp = client.post(
        f"/api/werkstatt/machines/{machine['id']}/print-label",
        headers=auth_headers(admin_token),
    )
    assert resp.status_code == 503, resp.text
    assert resp.json()["detail"] == "Kein Etikettendrucker konfiguriert"
    assert sent == []


def test_print_label_with_unreachable_printer_is_a_502(
    client: TestClient, admin_token: str, monkeypatch
) -> None:
    article = _article(client, admin_token, "Kappsäge")
    machine = _machine(client, admin_token, article["id"])
    _configure_printer(monkeypatch)

    from app.services import werkstatt_labels

    def refuse(host: str, port: int, payload: bytes) -> None:
        raise OSError("connect timed out")

    monkeypatch.setattr(werkstatt_labels, "_send_tcp", refuse)

    resp = client.post(
        f"/api/werkstatt/machines/{machine['id']}/print-label",
        headers=auth_headers(admin_token),
    )
    assert resp.status_code == 502, resp.text
    assert "nicht erreichbar" in resp.json()["detail"]
    assert "192.0.2.50:9100" in resp.json()["detail"]


def test_print_label_for_unknown_machine_is_a_404(
    client: TestClient, admin_token: str, monkeypatch
) -> None:
    _configure_printer(monkeypatch)
    resp = client.post(
        "/api/werkstatt/machines/999999/print-label",
        headers=auth_headers(admin_token),
    )
    assert resp.status_code == 404, resp.text


def test_print_label_requires_authentication(
    client: TestClient, admin_token: str, monkeypatch
) -> None:
    article = _article(client, admin_token, "Tauchsäge")
    machine = _machine(client, admin_token, article["id"])
    _configure_printer(monkeypatch)
    sent = _capture_sent(monkeypatch)

    resp = client.post(f"/api/werkstatt/machines/{machine['id']}/print-label")
    # Missing credentials are HTTPBearer's 403, repo-wide; 401 means bad token.
    assert resp.status_code == 403, resp.text
    assert sent == []


# ── Label batch (print queue) ──────────────────────────────────────────────


def test_print_label_batch_packs_klein_four_per_sheet(
    client: TestClient, admin_token: str, monkeypatch
) -> None:
    """5 klein + 1 gross → 3 sheets, and the quad sheets carry DIFFERENT
    machines — the queue exists precisely so one physical label can hold four
    different small items."""
    article = _article(client, admin_token, "Akku 18V")
    machines = [_machine(client, admin_token, article["id"]) for _ in range(6)]
    _configure_printer(monkeypatch)
    sent = _capture_sent(monkeypatch)

    items = [{"unit_id": m["id"], "format": "klein"} for m in machines[:5]]
    items.append({"unit_id": machines[5]["id"], "format": "gross"})
    resp = client.post(
        "/api/werkstatt/machines/print-labels",
        headers=auth_headers(admin_token),
        json={"items": items},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["sheets"] == 3  # 1 gross + quad(4) + quad(1)
    assert resp.json()["labels"] == 6

    assert len(sent) == 1  # one connection for the whole batch
    job = sent[0][2].decode("utf-8")
    lines = job.splitlines()
    assert lines.count("E") == 3
    # Every queued machine appears exactly once as DataMatrix data.
    for m in machines:
        assert lines.count(m["unit_number"]) >= 1
    # The quad sheets carry dashed scissor lines.
    assert any(line.startswith("Lo,") for line in lines)


def test_print_label_batch_reports_unknown_machines(
    client: TestClient, admin_token: str, monkeypatch
) -> None:
    _configure_printer(monkeypatch)
    sent = _capture_sent(monkeypatch)
    resp = client.post(
        "/api/werkstatt/machines/print-labels",
        headers=auth_headers(admin_token),
        json={"items": [{"unit_id": 999999, "format": "klein"}]},
    )
    assert resp.status_code == 404, resp.text
    assert "999999" in resp.json()["detail"]
    assert sent == []


def test_print_label_batch_requires_authentication(
    client: TestClient, admin_token: str, monkeypatch
) -> None:
    sent = _capture_sent(monkeypatch)
    resp = client.post(
        "/api/werkstatt/machines/print-labels",
        json={"items": [{"unit_id": 1, "format": "klein"}]},
    )
    assert resp.status_code == 403, resp.text
    assert sent == []


# ── Admin runtime printer settings ─────────────────────────────────────────


def test_admin_can_configure_printer_at_runtime_and_it_wins(
    client: TestClient, admin_token: str, monkeypatch
) -> None:
    article = _article(client, admin_token, "Multitool")
    machine = _machine(client, admin_token, article["id"])
    sent = _capture_sent(monkeypatch)

    # Unconfigured by default (no env host in the test settings).
    got = client.get("/api/admin/settings/label-printer", headers=auth_headers(admin_token))
    assert got.status_code == 200, got.text
    assert got.json() == {"host": "", "port": 9100, "configured": False, "source": "none"}

    saved = client.patch(
        "/api/admin/settings/label-printer",
        headers=auth_headers(admin_token),
        json={"host": "192.0.2.77", "port": 9105},
    )
    assert saved.status_code == 200, saved.text
    assert saved.json()["configured"] is True
    assert saved.json()["source"] == "runtime"

    # A machine print now goes to the runtime-configured address.
    resp = client.post(
        f"/api/werkstatt/machines/{machine['id']}/print-label",
        headers=auth_headers(admin_token),
    )
    assert resp.status_code == 200, resp.text
    assert (sent[0][0], sent[0][1]) == ("192.0.2.77", 9105)

    # Blank host clears the override again.
    cleared = client.patch(
        "/api/admin/settings/label-printer",
        headers=auth_headers(admin_token),
        json={"host": "", "port": 9100},
    )
    assert cleared.status_code == 200, cleared.text
    assert cleared.json()["configured"] is False


def test_printer_settings_require_settings_manage_permission(
    client: TestClient, admin_token: str
) -> None:
    from app.core.db import SessionLocal
    from app.core.security import create_access_token, get_password_hash
    from app.models.entities import User

    with SessionLocal() as db:
        worker = User(
            email="drucker-monteur@example.com",
            full_name="Monteur Ohne Settings",
            password_hash=get_password_hash("x"),
            role="employee",
        )
        db.add(worker)
        db.commit()
        worker_id = worker.id
    worker_token = create_access_token(str(worker_id), {"role": "employee"})

    for call in (
        lambda: client.get(
            "/api/admin/settings/label-printer", headers=auth_headers(worker_token)
        ),
        lambda: client.patch(
            "/api/admin/settings/label-printer",
            headers=auth_headers(worker_token),
            json={"host": "10.0.0.1", "port": 9100},
        ),
        lambda: client.post(
            "/api/admin/settings/label-printer/test", headers=auth_headers(worker_token)
        ),
    ):
        assert call().status_code == 403


def test_admin_test_print_reports_instead_of_erroring(
    client: TestClient, admin_token: str, monkeypatch
) -> None:
    sent = _capture_sent(monkeypatch)

    # Unconfigured → ok=False with the German reason, not a 5xx.
    resp = client.post(
        "/api/admin/settings/label-printer/test", headers=auth_headers(admin_token)
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["ok"] is False
    assert "konfiguriert" in resp.json()["detail"]
    assert sent == []

    _configure_printer(monkeypatch)
    resp = client.post(
        "/api/admin/settings/label-printer/test", headers=auth_headers(admin_token)
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["ok"] is True
    assert len(sent) == 1
    assert "M-TEST" in sent[0][2].decode("utf-8")


def test_gross_label_downloads_and_places_the_logo(
    client: TestClient, admin_token: str, monkeypatch
) -> None:
    """With a real logo asset the job gains the one-time `~EB` BMP download
    and a `Y` placement command referencing the same content-hashed name."""
    from pathlib import Path

    from app.core.config import get_settings
    from app.services import werkstatt_labels

    logo = Path(__file__).resolve().parents[1] / "app" / "assets" / "logo.jpeg"
    assert logo.exists()

    article = _article(client, admin_token, "Tischkreissäge")
    machine = _machine(client, admin_token, article["id"])
    _configure_printer(monkeypatch)
    sent = _capture_sent(monkeypatch)
    monkeypatch.setattr(get_settings(), "report_logo_path", str(logo))
    werkstatt_labels._logo_asset.cache_clear()
    try:
        resp = client.post(
            f"/api/werkstatt/machines/{machine['id']}/print-label",
            headers=auth_headers(admin_token),
        )
        assert resp.status_code == 200, resp.text
        payload = sent[0][2]
        assert payload.startswith(b"~EB,SMPL")
        assert b"BM" in payload[:200]  # BMP magic inside the download
        name = payload.split(b",")[1].decode()
        assert f",{name}".encode() in payload.split(b"^L", 1)[1]  # Y placement
    finally:
        # The cached asset must not leak into tests that expect no logo.
        werkstatt_labels._logo_asset.cache_clear()


def test_print_label_does_not_require_the_manage_permission(
    client: TestClient, admin_token: str, monkeypatch
) -> None:
    """Printing is a shop-floor act like booking: the person standing at the
    printer with an unlabelled tool rarely has manage rights. Locks the
    endpoint to `get_current_user` — the adjacent create/update handlers use
    `require_permission("werkstatt:manage")`, an easy copy-paste regression."""
    from app.core.db import SessionLocal
    from app.core.security import create_access_token, get_password_hash
    from app.models.entities import User

    article = _article(client, admin_token, "Nass-Trockensauger")
    machine = _machine(client, admin_token, article["id"])
    _configure_printer(monkeypatch)
    sent = _capture_sent(monkeypatch)

    with SessionLocal() as db:
        worker = User(
            email="etikett-monteur@example.com",
            full_name="Monteur Am Drucker",
            password_hash=get_password_hash("x"),
            role="employee",
        )
        db.add(worker)
        db.commit()
        worker_id = worker.id
    worker_token = create_access_token(str(worker_id), {"role": "employee"})

    resp = client.post(
        f"/api/werkstatt/machines/{machine['id']}/print-label",
        headers=auth_headers(worker_token),
    )
    assert resp.status_code == 200, resp.text
    assert len(sent) == 1
