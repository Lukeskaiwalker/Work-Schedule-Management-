"""Shared setup for the partner-portal tests.

A portal login is made exactly the way the office makes one: a Partner,
then ``POST /api/partners/{id}/portal-users`` (which mints an invite link),
then the invite is accepted on the public endpoint and the person signs in.
Going through the real endpoints keeps the tests honest about the whole
path, not just the portal routes at the end of it.
"""

from __future__ import annotations

from datetime import date, timedelta
from urllib.parse import parse_qs, urlparse

from fastapi.testclient import TestClient

from tests.conftest import auth_headers

PORTAL_PASSWORD = "Dachrinne2026!"


def create_partner(client: TestClient, admin_token: str, name: str = "Bedachungen Hoffmann KG", trade: str = "Dachdecker") -> dict:
    response = client.post("/api/partners", headers=auth_headers(admin_token), json={"name": name, "trade": trade})
    assert response.status_code == 200, response.text
    return response.json()


def token_from_link(link: str) -> str:
    query = parse_qs(urlparse(link).query)
    assert "token" in query, link
    return query["token"][0]


def invite_portal_user(
    client: TestClient,
    admin_token: str,
    partner_id: int,
    *,
    email: str = "a.hoffmann@hoffmann-dach.de",
    full_name: str = "Andreas Hoffmann",
) -> dict:
    response = client.post(
        f"/api/partners/{partner_id}/portal-users",
        headers=auth_headers(admin_token),
        json={"full_name": full_name, "email": email},
    )
    assert response.status_code == 200, response.text
    return response.json()


def accept_and_login(client: TestClient, invite: dict, password: str = PORTAL_PASSWORD) -> str:
    accepted = client.post(
        "/api/auth/invites/accept",
        json={"token": token_from_link(invite["invite_link"]), "new_password": password},
    )
    assert accepted.status_code == 200, accepted.text
    login = client.post("/api/auth/login", json={"email": invite["user"]["email"], "password": password})
    assert login.status_code == 200, login.text
    token = login.headers.get("X-Access-Token")
    assert token
    return token


def portal_login(
    client: TestClient,
    admin_token: str,
    *,
    partner_name: str = "Bedachungen Hoffmann KG",
    email: str = "a.hoffmann@hoffmann-dach.de",
) -> tuple[dict, dict, str]:
    """Partner, its invited-and-accepted login, and that login's bearer token."""
    partner = create_partner(client, admin_token, name=partner_name)
    invite = invite_portal_user(client, admin_token, partner["id"], email=email)
    token = accept_and_login(client, invite)
    return partner, invite["user"], token


def create_project(client: TestClient, admin_token: str, number: str, name: str, **extra) -> dict:
    payload = {"project_number": number, "name": name, "status": "in_durchfuehrung", **extra}
    response = client.post("/api/projects", headers=auth_headers(admin_token), json=payload)
    assert response.status_code == 200, response.text
    return response.json()


def create_task(client: TestClient, admin_token: str, **fields) -> dict:
    response = client.post("/api/tasks", headers=auth_headers(admin_token), json=fields)
    assert response.status_code == 200, response.text
    return response.json()


def create_employee(client: TestClient, admin_token: str, email: str, name: str) -> int:
    created = client.post(
        "/api/admin/users",
        headers=auth_headers(admin_token),
        json={"email": email, "password": "Password123!", "full_name": name, "role": "employee"},
    )
    assert created.status_code == 200, created.text
    return created.json()["id"]


def portal_world(client: TestClient, admin_token: str) -> dict:
    """One partner with a login, a second partner, and tasks around both."""
    partner, user, token = portal_login(client, admin_token)
    other = create_partner(client, admin_token, name="Wagner Sanitär e.K.", trade="Sanitär")
    head = auth_headers(admin_token)
    customer = client.post("/api/customers", headers=head, json={"name": "Familie Schulze", "address": "Hauptstr. 5, 58452 Witten", "phone": "0171 1234567"})
    assert customer.status_code == 200, customer.text
    kai = create_employee(client, admin_token, "kai@example.com", "Kai Monteur")
    project = create_project(
        client,
        admin_token,
        "2024-008",
        "Neubau EFH König",
        construction_site_address="Lindenstr. 5, 58452 Witten",
        site_access_type="key_pickup",
        site_access_note="Nachbar Haus Nr. 7",
        customer_phone="0201 999999",
        description="Interne Kalkulation: knapp",
    )
    braun = create_project(client, admin_token, "2024-015", "Sanierung MFH Braun", construction_site_address="Bergstr. 21, 44787 Bochum")
    hidden = create_project(client, admin_token, "2024-030", "Fremdes Projekt")
    today = date.today()
    mine = create_task(
        client,
        admin_token,
        project_id=project["id"],
        title="Dachrinne und Fallrohre erneuern",
        description="Alte Zinkrinne entfernen, Kupferrinne setzen.",
        subtasks=["Altrinne demontieren", "Rinnenhalter setzen"],
        materials_required="Kupferrinne 333 mm, 12 m",
        partner_ids=[partner["id"]],
        assignee_ids=[kai],
        due_date=str(today),
        start_time="07:30",
        estimated_hours=6,
    )
    overdue = create_task(client, admin_token, project_id=braun["id"], title="Ortgang verkleiden", partner_ids=[partner["id"]], due_date=str(today - timedelta(days=2)))
    customer_only = create_task(client, admin_token, customer_id=customer.json()["id"], title="Schneefanggitter montieren", partner_ids=[partner["id"]], due_date=str(today + timedelta(days=2)))
    undated = create_task(client, admin_token, project_id=project["id"], title="Aufmaß Gaube", partner_ids=[partner["id"]])
    theirs = create_task(client, admin_token, project_id=project["id"], title="Elektro Zuleitung", partner_ids=[other["id"]])
    internal = create_task(client, admin_token, project_id=project["id"], title="Interne Abnahme", assignee_ids=[kai])
    foreign = create_task(client, admin_token, project_id=hidden["id"], title="Ganz woanders", partner_ids=[other["id"]])
    return {
        "partner": partner, "user": user, "token": token, "other": other, "kai": kai,
        "project": project, "braun": braun, "hidden": hidden, "customer": customer.json(),
        "mine": mine, "overdue": overdue, "customer_only": customer_only, "undated": undated,
        "theirs": theirs, "internal": internal, "foreign": foreign,
    }
