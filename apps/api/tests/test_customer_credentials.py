"""Zugangsdaten — ``/customers/{id}/credentials``.

What must hold: the secret is encrypted at rest and never in a list; a
reveal returns it and writes both the customer's change log and the admin
audit log; ``secret`` absent keeps, ``""`` clears, text replaces; who may
open the customer's files may read, add, edit and reveal; deleting is the
creator's or a project manager's; an entry of another customer is a 404.
"""

from __future__ import annotations

from fastapi.testclient import TestClient
from sqlalchemy import select

from app.core.db import SessionLocal
from app.models.entities import AuditLog, CustomerCredential
from tests.conftest import auth_headers


def _customer(client: TestClient, token: str, name: str = "Familie Schmitt") -> int:
    resp = client.post("/api/customers", headers=auth_headers(token), json={"name": name})
    assert resp.status_code == 200, resp.text
    return resp.json()["id"]


def _employee(client: TestClient, admin_token: str, email: str) -> tuple[int, str]:
    created = client.post(
        "/api/admin/users",
        headers=auth_headers(admin_token),
        json={"email": email, "password": "Password123!", "full_name": "Kai Monteur", "role": "employee"},
    )
    assert created.status_code == 200, created.text
    login = client.post("/api/auth/login", json={"email": email, "password": "Password123!"})
    assert login.status_code == 200, login.text
    return created.json()["id"], login.headers["X-Access-Token"]


def _credential(client: TestClient, token: str, customer_id: int, **overrides) -> dict:
    payload = {"label": "Wechselrichter SMA Sunny Boy", "category": "inverter", "username": "installer", "secret": "Sma!2026", "url": "http://192.168.178.40"}
    payload.update(overrides)
    resp = client.post(f"/api/customers/{customer_id}/credentials", headers=auth_headers(token), json=payload)
    assert resp.status_code == 200, resp.text
    return resp.json()


def test_the_secret_is_encrypted_at_rest_and_never_listed(client: TestClient, admin_token: str) -> None:
    customer = _customer(client, admin_token)
    row = _credential(client, admin_token, customer, notes="Passwort steht auch auf dem Aufkleber")
    assert row["has_secret"] is True and "secret" not in row
    assert (row["label"], row["category"], row["username"], row["url"]) == ("Wechselrichter SMA Sunny Boy", "inverter", "installer", "http://192.168.178.40")
    assert row["created_by_name"] and row["last_revealed_at"] is None

    with SessionLocal() as db:
        stored = db.get(CustomerCredential, row["id"])
        assert stored.secret_encrypted and "Sma!2026" not in stored.secret_encrypted

    listed = client.get(f"/api/customers/{customer}/credentials", headers=auth_headers(admin_token))
    assert listed.status_code == 200, listed.text
    assert [r["id"] for r in listed.json()] == [row["id"]]
    assert "Sma!2026" not in listed.text


def test_reveal_returns_the_secret_and_writes_both_logs(client: TestClient, admin_token: str) -> None:
    customer = _customer(client, admin_token)
    row = _credential(client, admin_token, customer)

    revealed = client.post(f"/api/customers/{customer}/credentials/{row['id']}/reveal", headers=auth_headers(admin_token))
    assert revealed.status_code == 200, revealed.text
    assert revealed.json()["secret"] == "Sma!2026" and revealed.json()["revealed_at"]

    after = client.get(f"/api/customers/{customer}/credentials", headers=auth_headers(admin_token)).json()[0]
    assert after["last_revealed_at"] is not None and after["last_revealed_by_name"]

    activity = client.get(f"/api/customers/{customer}/activity", headers=auth_headers(admin_token))
    assert activity.status_code == 200, activity.text
    body = activity.json()
    entries = body["items"] if isinstance(body, dict) and "items" in body else body
    events = [e["event_type"] for e in entries]
    assert "customer.credential_created" in events and "customer.credential_revealed" in events
    assert any("Passwort von Wechselrichter" in (e.get("message") or "") for e in entries)

    with SessionLocal() as db:
        audit = db.scalars(select(AuditLog).where(AuditLog.action == "customer_credential.reveal")).all()
        assert len(audit) == 1 and audit[0].category == "customer" and audit[0].target_id == str(row["id"])
        assert audit[0].details["customer_id"] == customer and "Sma" not in str(audit[0].details)

    # An entry without a secret has nothing to reveal.
    empty = _credential(client, admin_token, customer, label="Router Fritzbox", category="router", secret=None)
    assert client.post(f"/api/customers/{customer}/credentials/{empty['id']}/reveal", headers=auth_headers(admin_token)).status_code == 404


def test_update_keeps_clears_or_replaces_the_secret(client: TestClient, admin_token: str) -> None:
    customer = _customer(client, admin_token)
    row = _credential(client, admin_token, customer)
    head = auth_headers(admin_token)
    path = f"/api/customers/{customer}/credentials/{row['id']}"

    kept = client.patch(path, headers=head, json={"label": "Wechselrichter SMA (Garage)", "username": "admin"})
    assert kept.status_code == 200, kept.text
    assert kept.json()["label"] == "Wechselrichter SMA (Garage)" and kept.json()["has_secret"] is True
    assert client.post(f"{path}/reveal", headers=head).json()["secret"] == "Sma!2026"

    replaced = client.patch(path, headers=head, json={"secret": "Neu#2027"})
    assert replaced.status_code == 200 and replaced.json()["has_secret"] is True
    assert client.post(f"{path}/reveal", headers=head).json()["secret"] == "Neu#2027"

    cleared = client.patch(path, headers=head, json={"secret": ""})
    assert cleared.status_code == 200 and cleared.json()["has_secret"] is False
    assert client.post(f"{path}/reveal", headers=head).status_code == 404

    assert client.patch(path, headers=head, json={"label": "   "}).status_code == 422
    assert client.patch(path, headers=head, json={"category": "spaceship"}).status_code == 422


def test_access_follows_the_customers_files_and_delete_is_the_creators_or_a_managers(client: TestClient, admin_token: str) -> None:
    customer = _customer(client, admin_token)
    other_customer = _customer(client, admin_token, name="Andere GmbH")
    employee_id, employee_token = _employee(client, admin_token, "kai@example.com")
    admins = _credential(client, admin_token, customer, label="Wallbox go-e", category="wallbox", secret="Geheim1")

    # No task on the customer, no project: the employee cannot open the customer's files.
    assert client.get(f"/api/customers/{customer}/credentials", headers=auth_headers(employee_token)).status_code == 403

    # Anchoring a task on the customer to the employee opens them.
    task = client.post(
        "/api/tasks",
        headers=auth_headers(admin_token),
        json={"title": "Wallbox anschließen", "customer_id": customer, "assignee_ids": [employee_id], "due_date": "2026-10-01"},
    )
    assert task.status_code == 200, task.text
    listed = client.get(f"/api/customers/{customer}/credentials", headers=auth_headers(employee_token))
    assert listed.status_code == 200 and len(listed.json()) == 1
    assert client.post(f"/api/customers/{customer}/credentials/{admins['id']}/reveal", headers=auth_headers(employee_token)).json()["secret"] == "Geheim1"

    own = _credential(client, employee_token, customer, label="Portal SMA Sunny Portal", category="portal", secret="Portal99")
    assert own["created_by_name"] == "Kai Monteur"
    # The employee may not delete the admin's entry, but may delete their own.
    assert client.delete(f"/api/customers/{customer}/credentials/{admins['id']}", headers=auth_headers(employee_token)).status_code == 403
    assert client.delete(f"/api/customers/{customer}/credentials/{own['id']}", headers=auth_headers(employee_token)).status_code == 204
    # A manager may delete anything.
    assert client.delete(f"/api/customers/{customer}/credentials/{admins['id']}", headers=auth_headers(admin_token)).status_code == 204
    assert client.get(f"/api/customers/{customer}/credentials", headers=auth_headers(admin_token)).json() == []

    # An entry of another customer is not found under this one; an unknown customer is 404.
    elsewhere = _credential(client, admin_token, other_customer, label="Router", category="router", secret="x")
    assert client.get(f"/api/customers/{customer}/credentials/{elsewhere['id']}/reveal", headers=auth_headers(admin_token)).status_code == 405
    assert client.post(f"/api/customers/{customer}/credentials/{elsewhere['id']}/reveal", headers=auth_headers(admin_token)).status_code == 404
    assert client.get("/api/customers/999999/credentials", headers=auth_headers(admin_token)).status_code == 404
    # The shared client carries the login cookie; a fresh one is anonymous.
    assert TestClient(client.app).get(f"/api/customers/{customer}/credentials").status_code == 401
