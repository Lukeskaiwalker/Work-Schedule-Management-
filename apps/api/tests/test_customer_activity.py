"""The customer's cross-project change log — ``GET /customers/{id}/activity``.

What must hold: the events of all the customer's projects and the
customer's own events come back as one list, newest first, each row saying
which side it is from and, for a project row, which project; another
customer's projects stay out; an employee gets only the projects they can
see (membership is what draws that line, so the tests add and remove it on
purpose); ``cursor`` pages backwards across both sources without a gap or
a repeat, ``before_id`` still pages the project rows for the old card; the
limit is clamped rather than rejected; an unknown customer is a 404.
"""

from __future__ import annotations

from urllib.parse import quote

from fastapi.testclient import TestClient

EMPLOYEE_PASSWORD = "Password123!"


def auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _create_user(client: TestClient, admin_token: str, email: str, role: str = "employee") -> dict:
    response = client.post(
        "/api/admin/users",
        headers=auth_headers(admin_token),
        json={"email": email, "password": EMPLOYEE_PASSWORD, "full_name": f"{role.title()} User", "role": role},
    )
    assert response.status_code == 200, response.text
    return response.json()


def _login(client: TestClient, email: str) -> str:
    response = client.post("/api/auth/login", json={"email": email, "password": EMPLOYEE_PASSWORD})
    assert response.status_code == 200, response.text
    return response.headers["X-Access-Token"]


def _create_customer(client: TestClient, admin_token: str, name: str) -> dict:
    response = client.post("/api/customers", headers=auth_headers(admin_token), json={"name": name})
    assert response.status_code == 200, response.text
    return response.json()


def _create_project(client: TestClient, admin_token: str, number: str, customer_id: int) -> dict:
    response = client.post(
        "/api/projects",
        headers=auth_headers(admin_token),
        json={"project_number": number, "name": f"Projekt {number}", "status": "active", "customer_id": customer_id},
    )
    assert response.status_code == 200, response.text
    return response.json()


def _remove_member(client: TestClient, admin_token: str, project_id: int, user_id: int) -> None:
    # New users are put on every project by default, so "not on that project"
    # has to be made true on purpose.
    response = client.delete(f"/api/projects/{project_id}/members/{user_id}", headers=auth_headers(admin_token))
    assert response.status_code in (200, 204), response.text


# Creating a project records `project.created`; each of these records one
# more activity of the named event type.


def _create_task(client: TestClient, token: str, project_id: int, title: str) -> dict:
    response = client.post(
        "/api/tasks",
        headers=auth_headers(token),
        json={"project_id": project_id, "title": title, "task_type": "office"},
    )
    assert response.status_code == 200, response.text
    return response.json()


def _upload_file(client: TestClient, token: str, project_id: int, file_name: str) -> None:
    response = client.post(
        f"/api/projects/{project_id}/files",
        headers=auth_headers(token),
        files={"file": (file_name, b"plan", "text/plain")},
    )
    assert response.status_code == 200, response.text


def _set_status(client: TestClient, token: str, project_id: int, status: str) -> None:
    response = client.patch(f"/api/projects/{project_id}", headers=auth_headers(token), json={"status": status})
    assert response.status_code == 200, response.text


def _activity(client: TestClient, token: str, customer_id: int, query: str = "") -> list[dict]:
    response = client.get(f"/api/customers/{customer_id}/activity{query}", headers=auth_headers(token))
    assert response.status_code == 200, response.text
    return response.json()


def test_customer_activity_unions_the_customer_projects_newest_first(client: TestClient, admin_token: str):
    customer = _create_customer(client, admin_token, "Feed Kunde")
    first = _create_project(client, admin_token, "2026-3101", customer["id"])
    second = _create_project(client, admin_token, "2026-3102", customer["id"])

    # Interleaved on purpose: the feed has to merge the two logs by time,
    # not append one project's log to the other's.
    _create_task(client, admin_token, first["id"], "Angebot schreiben")
    _upload_file(client, admin_token, second["id"], "plan.txt")
    # "active" is normalised to the canonical in_durchfuehrung on creation, so
    # the change has to go somewhere else to be a change at all.
    _set_status(client, admin_token, first["id"], "rechnung_verschickt")
    _create_task(client, admin_token, second["id"], "Material bestellen")

    rows = _activity(client, admin_token, customer["id"])

    assert [(row["event_type"], row["project_number"]) for row in rows] == [
        ("task.created", "2026-3102"),
        ("project.state_changed", "2026-3101"),
        ("file.uploaded", "2026-3102"),
        ("task.created", "2026-3101"),
        ("project.created", "2026-3102"),
        ("project.created", "2026-3101"),
        # The customer's own creation, before any project existed.
        ("customer.created", None),
    ]
    assert [row["project_name"] for row in rows] == [
        "Projekt 2026-3102",
        "Projekt 2026-3101",
        "Projekt 2026-3102",
        "Projekt 2026-3101",
        "Projekt 2026-3102",
        "Projekt 2026-3101",
        None,
    ]
    assert [row["project_id"] for row in rows] == [
        second["id"],
        first["id"],
        second["id"],
        first["id"],
        second["id"],
        first["id"],
        None,
    ]
    assert [row["source"] for row in rows] == ["project"] * 6 + ["customer"]
    assert all(row["actor_name"] for row in rows)
    assert all(row["customer_id"] == customer["id"] for row in rows)
    assert rows[0]["message"] == "Task created: Material bestellen"
    # Ids only order within a source — the two tables count separately.
    project_ids = [row["id"] for row in rows if row["source"] == "project"]
    assert project_ids == sorted(project_ids, reverse=True)


def test_customer_activity_excludes_the_projects_of_other_customers(client: TestClient, admin_token: str):
    customer = _create_customer(client, admin_token, "Eigener Kunde")
    other = _create_customer(client, admin_token, "Anderer Kunde")
    own_project = _create_project(client, admin_token, "2026-3111", customer["id"])
    other_project = _create_project(client, admin_token, "2026-3112", other["id"])

    _create_task(client, admin_token, own_project["id"], "Eigene Aufgabe")
    _create_task(client, admin_token, other_project["id"], "Fremde Aufgabe")

    rows = _activity(client, admin_token, customer["id"])

    assert [row["event_type"] for row in rows] == ["task.created", "project.created", "customer.created"]
    assert {row["project_id"] for row in rows if row["source"] == "project"} == {own_project["id"]}
    assert rows[0]["message"] == "Task created: Eigene Aufgabe"
    assert rows[-1]["message"] == "Kunde angelegt: Eigener Kunde"


def test_employee_sees_only_the_projects_they_are_on(client: TestClient, admin_token: str):
    employee = _create_user(client, admin_token, "employee-activity@example.com")
    customer = _create_customer(client, admin_token, "Halb sichtbar")
    visible = _create_project(client, admin_token, "2026-3121", customer["id"])
    hidden = _create_project(client, admin_token, "2026-3122", customer["id"])
    _remove_member(client, admin_token, hidden["id"], employee["id"])

    _create_task(client, admin_token, visible["id"], "Sichtbare Aufgabe")
    _create_task(client, admin_token, hidden["id"], "Verborgene Aufgabe")

    employee_rows = _activity(client, _login(client, "employee-activity@example.com"), customer["id"])
    admin_rows = _activity(client, admin_token, customer["id"])

    # Creation plus the task of the visible project, then the customer's
    # own creation, which no project membership guards.
    assert [row["project_id"] for row in employee_rows] == [visible["id"], visible["id"], None]
    assert [row["event_type"] for row in employee_rows] == ["task.created", "project.created", "customer.created"]
    assert {row["project_id"] for row in admin_rows if row["source"] == "project"} == {visible["id"], hidden["id"]}


def test_customer_activity_pages_backwards_by_before_id(client: TestClient, admin_token: str):
    """The old card's cursor: a project-row id. It cannot place a customer
    row, so a client paging by it gets the project rows only — five here,
    the customer's own creation is not among them — and never a repeat."""
    customer = _create_customer(client, admin_token, "Seitenweise")
    project = _create_project(client, admin_token, "2026-3131", customer["id"])
    # Four tasks plus the project's creation: five project rows, so pages
    # of two end in a short one.
    for index in range(4):
        _create_task(client, admin_token, project["id"], f"Aufgabe {index}")

    first_page = _activity(client, admin_token, customer["id"], "?limit=2")
    second_page = _activity(client, admin_token, customer["id"], f"?limit=2&before_id={first_page[-1]['id']}")
    last_page = _activity(client, admin_token, customer["id"], f"?limit=2&before_id={second_page[-1]['id']}")

    assert [len(first_page), len(second_page), len(last_page)] == [2, 2, 1]
    ids = [row["id"] for row in first_page + second_page + last_page]
    assert ids == sorted(ids, reverse=True)
    assert len(set(ids)) == 5
    assert [row["message"] for row in first_page + second_page] == [
        f"Task created: Aufgabe {index}" for index in (3, 2, 1, 0)
    ]
    assert last_page[0]["event_type"] == "project.created"
    assert all(row["source"] == "project" for row in first_page + second_page + last_page)

    beyond = _activity(client, admin_token, customer["id"], f"?before_id={last_page[-1]['id']}")
    assert beyond == []


def test_customer_activity_clamps_the_limit(client: TestClient, admin_token: str):
    customer = _create_customer(client, admin_token, "Begrenzt")
    project = _create_project(client, admin_token, "2026-3141", customer["id"])
    for index in range(3):
        _create_task(client, admin_token, project["id"], f"Aufgabe {index}")
    # Three tasks, the project's creation and the customer's.
    total_rows = 5

    assert len(_activity(client, admin_token, customer["id"], "?limit=0")) == 1
    assert len(_activity(client, admin_token, customer["id"], "?limit=-5")) == 1
    assert len(_activity(client, admin_token, customer["id"], "?limit=9999")) == total_rows
    assert len(_activity(client, admin_token, customer["id"])) == total_rows


def test_customer_activity_of_a_customer_without_projects_is_its_creation(client: TestClient, admin_token: str):
    customer = _create_customer(client, admin_token, "Ohne Projekte")
    rows = _activity(client, admin_token, customer["id"])
    assert [(row["event_type"], row["source"], row["project_id"]) for row in rows] == [("customer.created", "customer", None)]
    assert rows[0]["customer_id"] == customer["id"]
    assert rows[0]["cursor"]


def test_customer_activity_of_an_unknown_customer_is_404(client: TestClient, admin_token: str):
    response = client.get("/api/customers/999999/activity", headers=auth_headers(admin_token))
    assert response.status_code == 404


# ── the two sources in one feed ──────────────────────────────────────────


def _patch_customer(client: TestClient, token: str, customer_id: int, payload: dict) -> None:
    response = client.patch(f"/api/customers/{customer_id}", headers=auth_headers(token), json=payload)
    assert response.status_code == 200, response.text


def _post_customer_note(client: TestClient, token: str, customer_id: int, body: str) -> None:
    response = client.post(f"/api/customers/{customer_id}/notes", headers=auth_headers(token), json={"body": body})
    assert response.status_code == 200, response.text


def _interleaved_customer(client: TestClient, admin_token: str, name: str, number: str) -> tuple[dict, dict]:
    """Customer and project events written turn and turn about, so the
    feed has to merge the two logs by time, not append one to the other."""
    customer = _create_customer(client, admin_token, name)  # customer.created
    project = _create_project(client, admin_token, number, customer["id"])  # project.created
    _patch_customer(client, admin_token, customer["id"], {"phone": "030 1"})  # customer.updated
    _create_task(client, admin_token, project["id"], "Angebot schreiben")  # task.created
    _post_customer_note(client, admin_token, customer["id"], "Kunde ruft zurück")  # customer.note_posted
    return customer, project


def test_customer_and_project_events_interleave_newest_first(client: TestClient, admin_token: str):
    customer, project = _interleaved_customer(client, admin_token, "Verzahnt", "2026-3151")

    rows = _activity(client, admin_token, customer["id"])

    assert [(row["event_type"], row["source"]) for row in rows] == [
        ("customer.note_posted", "customer"),
        ("task.created", "project"),
        ("customer.updated", "customer"),
        ("project.created", "project"),
        ("customer.created", "customer"),
    ]
    for row in rows:
        assert row["customer_id"] == customer["id"]
        assert row["actor_name"]
        assert row["cursor"]
        if row["source"] == "project":
            assert row["project_id"] == project["id"] and row["project_number"] == "2026-3151"
        else:
            assert row["project_id"] is None and row["project_number"] is None and row["project_name"] is None
    assert len({row["cursor"] for row in rows}) == 5


def test_cursor_pages_across_the_sources_without_duplicates_or_gaps(client: TestClient, admin_token: str):
    customer, project = _interleaved_customer(client, admin_token, "Blättern", "2026-3161")
    _create_task(client, admin_token, project["id"], "Material bestellen")  # task.created
    _patch_customer(client, admin_token, customer["id"], {"mobile": "0171 1"})  # customer.updated
    # Seven rows, alternating sources — pages of three cut across a boundary twice.
    full = _activity(client, admin_token, customer["id"], "?limit=50")
    assert len(full) == 7

    pages: list[list[dict]] = []
    cursor: str | None = None
    while True:
        query = "?limit=3" + (f"&cursor={quote(cursor)}" if cursor else "")
        page = _activity(client, admin_token, customer["id"], query)
        if not page:
            break
        pages.append(page)
        cursor = page[-1]["cursor"]

    assert [len(page) for page in pages] == [3, 3, 1]
    keys = [(row["source"], row["id"]) for page in pages for row in page]
    assert keys == [(row["source"], row["id"]) for row in full]
    assert len(set(keys)) == 7
    # The second page starts across a source boundary from the first's end.
    assert pages[0][-1]["source"] != pages[1][0]["source"]

    # A cursor nobody issued shows the first page, like an out-of-range limit.
    assert _activity(client, admin_token, customer["id"], "?limit=3&cursor=nonsense") == pages[0]
