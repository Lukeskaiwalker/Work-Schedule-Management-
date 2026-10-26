"""One calibration session at a time, and nothing else prints meanwhile.

What must hold: a second user is refused with the holder's name and the
start time (ISO UTC in ``since``, Berlin HH:MM in the message); the same user
replaces their own stale tab; an admin may take over on purpose, staff may
not; the TTL frees the lock; every print path answers 409 (Testdruck:
``ok:false``) while someone else calibrates; DELETE is idempotent and can
never end someone else's session; config writes are compare-and-set.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from app.services import werkstatt_label_calibration as calibration
from app.services import werkstatt_label_io_lock
from app.services import werkstatt_label_session as sessions
from tests.conftest import auth_headers
from tests.fake_ezpl_printer import configure_fake
from tests.label_calibration_helpers import A, W, employee_with, enable_staff, settings, start, step, to_sensed


@pytest.fixture
def printer(client: TestClient, admin_token: str, fake_printer):
    configure_fake(client, admin_token, fake_printer)
    enable_staff(client, admin_token)
    return fake_printer


def _staff(name: str = "Max Monteur", email: str = "monteur@example.com") -> str:
    return employee_with(["werkstatt:manage"], email, name)[1]


def test_second_user_is_refused_with_holder_and_time(client, admin_token, printer, monkeypatch) -> None:
    october = datetime(2026, 10, 20, 7, 5, 0, tzinfo=timezone.utc)
    monkeypatch.setattr(sessions, "now_utc", lambda: october)
    holder = start(client, _staff())
    assert holder["acquired_at"] == "2026-10-20T07:05:00Z"
    other = _staff("Erika Elektro", "erika@example.com")
    refused = client.post(f"{W}/session", headers=auth_headers(other), json={"mode": "quick", "material_id": "wago-210-804"})
    assert refused.status_code == 409
    assert refused.json()["detail"] == {
        "code": "session_locked",
        "message": "Der Etikettendrucker wird gerade von Max Monteur eingerichtet (seit 09:05)",
        "holder_name": "Max Monteur",
        "since": "2026-10-20T07:05:00Z",
        "mode": "quick",
    }


def test_same_user_replaces_their_own_tab(client, admin_token, printer) -> None:
    staff = _staff()
    first = start(client, staff)
    second = start(client, staff)
    assert second["session_id"] != first["session_id"]
    lost = client.post(f"{W}/session/{first['session_id']}/heartbeat", headers=auth_headers(staff))
    assert lost.status_code == 409
    assert lost.json()["detail"] == {"code": "session_lost", "message": "Die Einrichtung ist abgelaufen oder wurde übernommen – bitte neu starten"}


def test_takeover_is_for_admins_only(client, admin_token, printer) -> None:
    staff = _staff()
    held = start(client, staff)
    other = _staff("Erika Elektro", "erika@example.com")
    refused = client.post(f"{W}/session", headers=auth_headers(other), json={"mode": "quick", "material_id": "wago-210-804", "takeover": True})
    assert refused.status_code == 409 and refused.json()["detail"]["code"] == "session_locked"
    taken = start(client, admin_token, takeover=True)
    assert taken["session_id"] != held["session_id"]
    assert client.post(f"{W}/session/{held['session_id']}/heartbeat", headers=auth_headers(staff)).status_code == 409


def test_expiry_frees_the_lock(client, admin_token, printer, monkeypatch) -> None:
    start(client, _staff())
    later = datetime.now(timezone.utc) + timedelta(seconds=sessions.SESSION_TTL_S + 5)
    monkeypatch.setattr(sessions, "now_utc", lambda: later)
    other = _staff("Erika Elektro", "erika@example.com")
    assert start(client, other)["user_name"] == "Erika Elektro"


def test_foreign_session_id_is_lost(client, admin_token, printer) -> None:
    staff = _staff()
    start(client, staff)
    other = _staff("Erika Elektro", "erika@example.com")
    response = client.post(f"{W}/session/not-a-session/heartbeat", headers=auth_headers(other))
    assert response.status_code == 409 and response.json()["detail"]["code"] == "session_lost"


def test_print_paths_wait_during_a_session(client, admin_token, printer, monkeypatch) -> None:
    from tests.test_schaltplan import _two_row_panel
    from tests.test_werkstatt_label_materials import _machine

    machine = _machine(client, admin_token, "Bohrhammer")
    panel = _two_row_panel(client, admin_token)
    start(client, _staff())

    label = client.post(f"/api/werkstatt/machines/{machine['id']}/print-label", headers=auth_headers(admin_token))
    assert label.status_code == 409
    assert label.json()["detail"].startswith("Etikettendrucker wird gerade eingerichtet (Max Monteur, seit ")
    assert label.json()["detail"].endswith(") – bitte warten, bis die Einrichtung abgeschlossen ist")

    bmk = client.post(f"/api/schaltplan/panels/{panel['id']}/labels", headers=auth_headers(admin_token), json={})
    assert bmk.status_code == 409

    # The Schrank-Etikett lives in its own router (workflow_schaltplan_type_label).
    type_label = client.post(f"/api/schaltplan/panels/{panel['id']}/type-label", headers=auth_headers(admin_token), json={})
    assert type_label.status_code == 409, type_label.text
    assert type_label.json()["detail"].startswith("Etikettendrucker wird gerade eingerichtet (Max Monteur, seit ")

    test_print = client.post(f"{A}/test", headers=auth_headers(admin_token))
    assert test_print.status_code == 200 and test_print.json()["ok"] is False
    assert "wird gerade eingerichtet" in test_print.json()["detail"]
    assert printer.jobs_printed == []


def test_the_sessions_own_sends_pass(client, admin_token, printer) -> None:
    sid, _ = to_sensed(client, admin_token, mode="full")
    step(client, admin_token, sid, "verify")
    step(client, admin_token, sid, "pattern", {"confirm_feed": True})
    printer.wait_for_jobs(1)


def test_send_after_a_takeover_is_session_lost(client, admin_token, printer, monkeypatch) -> None:
    staff = _staff()
    sid = start(client, staff)["session_id"]
    step(client, staff, sid, "activate", {"material_id": "wago-210-804"})
    original = calibration.read_status

    def read_then_taken_over(db, **kwargs):
        status = original(db, **kwargs)
        thief = sessions.CalibrationSession(
            session_id="thief", mode="full", material_id="wago-210-804", user_id=1, user_name="Admin",
            acquired_at=sessions.now_utc().replace(microsecond=0), expires_at=sessions.now_utc() + timedelta(minutes=5),
        )
        sessions.write(db, thief)
        db.commit()
        return status

    monkeypatch.setattr(calibration, "read_status", read_then_taken_over)
    response = client.post(f"{W}/session/{sid}/apply", headers=auth_headers(staff))
    assert response.status_code == 409 and response.json()["detail"]["code"] == "session_lost"


def test_io_lock_timeout_is_printer_busy(client, admin_token, printer, monkeypatch) -> None:
    sid = start(client, admin_token)["session_id"]
    step(client, admin_token, sid, "activate", {"material_id": "wago-210-804"})
    monkeypatch.setattr(werkstatt_label_io_lock, "IO_LOCK_TIMEOUT_S", 0.2)
    with werkstatt_label_io_lock.printer_io_lock():
        response = client.post(f"{W}/session/{sid}/apply", headers=auth_headers(admin_token))
    assert response.status_code == 409
    assert response.json()["detail"] == {
        "code": "printer_busy",
        "message": "Drucker ist gerade mit einem anderen Auftrag beschäftigt – bitte gleich erneut versuchen",
    }


def test_delete_is_idempotent_and_never_ends_someone_else(client, admin_token, printer, monkeypatch) -> None:
    sid, _ = to_sensed(client, admin_token)
    step(client, admin_token, sid, "verify")
    step(client, admin_token, sid, "save", {})
    assert client.delete(f"{W}/session/{sid}", headers=auth_headers(admin_token)).status_code == 204
    assert settings(client, admin_token)["session"] is None

    stale_tab = start(client, admin_token)["session_id"]
    staff = _staff()
    later = datetime.now(timezone.utc) + timedelta(seconds=sessions.SESSION_TTL_S + 5)
    monkeypatch.setattr(sessions, "now_utc", lambda: later)  # the admin's tab expired …
    held = start(client, staff)  # … and staff took the printer
    assert client.delete(f"{W}/session/{stale_tab}", headers=auth_headers(admin_token)).status_code == 204
    overview = client.get(W, headers=auth_headers(staff)).json()
    assert overview["session"]["mine"] is True and overview["session"]["session_id"] == held["session_id"]
    assert client.delete(f"{W}/session/unknown", headers=auth_headers(admin_token)).status_code == 204


def test_revision_compare_and_set(client, admin_token, printer) -> None:
    body = settings(client, admin_token)
    stale = client.put(f"{A}/materials/wago-210-804", headers=auth_headers(admin_token), json={"revision": body["revision"] - 1, "x_offset_mm": 1.8})
    assert stale.status_code == 409 and stale.json()["detail"]["code"] == "stale_revision"
    assert stale.json()["detail"]["revision"] == body["revision"]
    patched = client.patch(A, headers=auth_headers(admin_token), json={"active_material_id": "wago-210-804"})
    assert patched.status_code == 200 and patched.json()["revision"] == body["revision"] + 1

    sid = start(client, admin_token)["session_id"]
    same = step(client, admin_token, sid, "activate", {"material_id": "wago-210-804"})
    assert same["config_revision"] == body["revision"] + 1  # unchanged: no write, no bump
    other = step(client, admin_token, sid, "activate", {"material_id": "wago-210-812"})
    assert other["config_revision"] == body["revision"] + 2
    assert settings(client, admin_token)["active_material_id"] == "wago-210-812"


def test_no_printer_address_is_not_configured(client, admin_token) -> None:
    response = client.post(f"{W}/session", headers=auth_headers(admin_token), json={"mode": "quick", "material_id": "wago-210-804"})
    assert response.status_code == 503
    assert response.json()["detail"] == {"code": "not_configured", "message": "Kein Etikettendrucker konfiguriert"}
