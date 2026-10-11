"""The change log reads German.

"Letzte Änderungen" on the project and the customer page, and the Verlauf of
the Projektbericht, print each row's ``message`` verbatim. Half the writers
wrote English ("Task created: …", "File uploaded: …", "State changed to
in_durchfuehrung") into a German UI. What must hold:

* every writer now stores German;
* rows stored before stay as they are in the database — history is not
  rewritten — and read German wherever they are shown, as long as they are
  one of the structured lines the code itself wrote;
* a status change reads as the two labels, never as the slugs;
* anything else (a note preview, a partner's name) is the user's text and
  passes through untouched, even when it happens to look like an old line.
"""

from __future__ import annotations

from fastapi.testclient import TestClient
from sqlalchemy import select

from app.core.db import SessionLocal
from app.models.project import ProjectActivity
from app.services.activity_messages import display_activity_message
from app.services.project_report_data import collect_project_report_data
from tests.conftest import auth_headers

# What an English line of the old writers looks like, so a test can say
# "none of these are left" without listing every sentence again.
ENGLISH_LINE_STARTS = (
    "Task ",
    "Project ",
    "File ",
    "Material ",
    "Construction report",
    "Job ticket",
    "State changed",
    "Internal note",
    "Critical flag",
    "Auto-created",
)


def _create_customer(client: TestClient, admin_token: str, name: str) -> dict:
    response = client.post("/api/customers", headers=auth_headers(admin_token), json={"name": name})
    assert response.status_code == 200, response.text
    return response.json()


def _create_project(client: TestClient, admin_token: str, number: str, customer_id: int) -> dict:
    response = client.post(
        "/api/projects",
        headers=auth_headers(admin_token),
        json={"project_number": number, "name": f"Projekt {number}", "status": "in_durchfuehrung", "customer_id": customer_id},
    )
    assert response.status_code == 200, response.text
    return response.json()


def _overview_messages(client: TestClient, admin_token: str, project_id: int) -> list[tuple[str, str]]:
    response = client.get(f"/api/projects/{project_id}/overview", headers=auth_headers(admin_token))
    assert response.status_code == 200, response.text
    return [(row["event_type"], row["message"]) for row in response.json()["recent_changes"]]


def _plant_legacy_row(project_id: int, event_type: str, message: str, details: dict | None = None) -> int:
    with SessionLocal() as db:
        row = ProjectActivity(project_id=project_id, event_type=event_type, message=message, details=details or {})
        db.add(row)
        db.commit()
        return row.id


# ── display_activity_message ──────────────────────────────────────────────


def test_old_english_lines_read_german_with_their_data_kept() -> None:
    cases = [
        ("task.created", "Task created: Zählerschrank setzen", "Aufgabe erstellt: Zählerschrank setzen"),
        ("task.updated", "Task updated: Zählerschrank setzen", "Aufgabe aktualisiert: Zählerschrank setzen"),
        ("task.deleted", "Task deleted: Zählerschrank setzen", "Aufgabe gelöscht: Zählerschrank setzen"),
        ("project.created", "Project created: 2026-0412", "Projekt erstellt: 2026-0412"),
        ("file.uploaded", "File uploaded: plan.pdf", "Datei hochgeladen: plan.pdf"),
        ("file.deleted", "File deleted: plan.pdf", "Datei gelöscht: plan.pdf"),
        ("material.created", "Material need added (NYM-J 5x2,5)", "Materialbedarf angelegt (NYM-J 5x2,5)"),
        ("material.status_updated", "Material status updated (NYM-J 5x2,5)", "Materialstatus aktualisiert (NYM-J 5x2,5)"),
        ("material.updated", "Material need updated (NYM-J 5x2,5)", "Materialbedarf bearbeitet (NYM-J 5x2,5)"),
        ("material.deleted", "Material need deleted (NYM-J 5x2,5)", "Materialbedarf gelöscht (NYM-J 5x2,5)"),
        ("report.created", "Construction report created (2026-10-01)", "Baustellenbericht erstellt (2026-10-01)"),
        ("ticket.created", "Job ticket created: Dachrinne", "Ticket erstellt: Dachrinne"),
        ("ticket.updated", "Job ticket updated: #12", "Ticket aktualisiert: #12"),
        ("project.classes_updated", "Project classes assigned", "Projektklassen zugewiesen"),
        ("project.classes_updated", "Project classes updated", "Projektklassen aktualisiert"),
        ("project.classes_updated", "Auto-created deferred template tasks", "Zurückgestellte Vorlagen-Aufgaben angelegt"),
        ("project.note_updated", "Internal note updated", "Interne Notiz aktualisiert"),
        ("project.critical_set", "Project marked critical", "Projekt als kritisch markiert"),
        ("project.critical_cleared", "Critical flag cleared", "Kritisch-Markierung entfernt"),
        ("finance.updated", "Project finances updated", "Projektfinanzen aktualisiert"),
    ]
    for event_type, stored, shown in cases:
        assert display_activity_message(event_type, stored, {}) == shown, event_type


def test_a_status_change_reads_as_labels_not_slugs() -> None:
    assert (
        display_activity_message(
            "project.state_changed",
            "State changed to in_durchfuehrung",
            {"from": "angebotsphase", "to": "in_durchfuehrung"},
        )
        == "Angebotsphase → In Durchführung"
    )
    # A row from before the details were written still loses its slug.
    assert display_activity_message("project.state_changed", "State changed to rechnung_verschickt", {}) == (
        "Status geändert zu Rechnung verschickt"
    )


def test_the_users_own_text_and_german_lines_pass_unchanged() -> None:
    # A note preview is what somebody typed — even if it reads like an old line.
    assert display_activity_message("project.note_posted", "Task created: siehe Plan", {}) == "Task created: siehe Plan"
    assert display_activity_message("customer.created", "Kunde angelegt: Müller", {}) == "Kunde angelegt: Müller"
    assert display_activity_message("task.created", "Aufgabe erstellt: Abnahme", {}) == "Aufgabe erstellt: Abnahme"
    assert display_activity_message("unknown.event", "Something", None) == "Something"
    assert display_activity_message("task.created", None, None) == ""


# ── What the writers store now ────────────────────────────────────────────


def test_new_rows_are_written_in_german(client: TestClient, admin_token: str) -> None:
    customer = _create_customer(client, admin_token, "Deutsch Kunde")
    project = _create_project(client, admin_token, "2026-4101", customer["id"])

    task = client.post(
        "/api/tasks",
        headers=auth_headers(admin_token),
        json={"project_id": project["id"], "title": "Schlitze fräsen", "task_type": "construction"},
    )
    assert task.status_code == 200, task.text
    upload = client.post(
        f"/api/projects/{project['id']}/files",
        headers=auth_headers(admin_token),
        files={"file": ("plan.txt", b"plan", "text/plain")},
    )
    assert upload.status_code == 200, upload.text
    moved = client.patch(
        f"/api/projects/{project['id']}", headers=auth_headers(admin_token), json={"status": "rechnung_verschickt"}
    )
    assert moved.status_code == 200, moved.text
    critical = client.put(
        f"/api/projects/{project['id']}/critical", headers=auth_headers(admin_token), json={"is_critical": True}
    )
    assert critical.status_code == 200, critical.text

    with SessionLocal() as db:
        stored = {
            row.event_type: row.message
            for row in db.scalars(select(ProjectActivity).where(ProjectActivity.project_id == project["id"])).all()
        }
    assert stored["project.created"] == "Projekt erstellt: 2026-4101"
    assert stored["task.created"] == "Aufgabe erstellt: Schlitze fräsen"
    assert stored["file.uploaded"] == "Datei hochgeladen: plan.txt"
    assert stored["project.state_changed"] == "In Durchführung → Rechnung verschickt"
    assert stored["project.critical_set"] == "Projekt als kritisch markiert"
    for message in stored.values():
        assert not message.startswith(ENGLISH_LINE_STARTS), message


# ── Old rows, read where they are shown ───────────────────────────────────


def test_old_rows_read_german_on_the_project_and_customer_cards(client: TestClient, admin_token: str) -> None:
    customer = _create_customer(client, admin_token, "Altbestand Kunde")
    project = _create_project(client, admin_token, "2026-4102", customer["id"])
    row_id = _plant_legacy_row(project["id"], "task.created", "Task created: Alte Aufgabe")
    _plant_legacy_row(
        project["id"], "project.state_changed", "State changed to abgeschlossen", {"from": "in_durchfuehrung", "to": "abgeschlossen"}
    )

    overview = dict(_overview_messages(client, admin_token, project["id"]))
    assert overview["task.created"] == "Aufgabe erstellt: Alte Aufgabe"
    assert overview["project.state_changed"] == "In Durchführung → Abgeschlossen"

    feed = client.get(f"/api/customers/{customer['id']}/activity", headers=auth_headers(admin_token))
    assert feed.status_code == 200, feed.text
    by_type = {row["event_type"]: row["message"] for row in feed.json() if row["source"] == "project"}
    assert by_type["task.created"] == "Aufgabe erstellt: Alte Aufgabe"
    assert by_type["project.state_changed"] == "In Durchführung → Abgeschlossen"

    # Read German, stored as it was: the history itself is not rewritten.
    with SessionLocal() as db:
        assert db.get(ProjectActivity, row_id).message == "Task created: Alte Aufgabe"


def test_the_projektbericht_prints_an_old_creation_line_in_german(client: TestClient, admin_token: str) -> None:
    customer = _create_customer(client, admin_token, "Bericht Kunde")
    project = _create_project(client, admin_token, "2026-4103", customer["id"])
    with SessionLocal() as db:
        created = db.scalars(
            select(ProjectActivity).where(
                ProjectActivity.project_id == project["id"], ProjectActivity.event_type == "project.created"
            )
        ).one()
        # As a v2.14.40 server wrote it.
        created.message = "Project created: 2026-4103"
        db.commit()
        data = collect_project_report_data(db, project["id"])
    assert [activity.message for activity in data.activities][0] == "Projekt erstellt: 2026-4103"
