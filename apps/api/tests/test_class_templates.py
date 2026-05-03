from __future__ import annotations
import json
import os
from fastapi.testclient import TestClient
def auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}



def test_project_class_templates_import_and_autocreate_tasks(client: TestClient, admin_token: str):
    template_download = client.get("/api/admin/project-classes/template.csv", headers=auth_headers(admin_token))
    assert template_download.status_code == 200
    assert "class_name" in template_download.text
    assert "materials_required" in template_download.text

    csv_payload = (
        "class_name,materials_required,tools_required,task_title,task_description,task_type,task_subtasks\n"
        "\"PV Standard\",\"PV modules | 24 | pcs | PV-001\\nDC cable set | 2 | roll | CAB-002\",\"Crimp tool\\nCable cutter\","
        "\"Mount modules\",\"Install modules on roof\",construction,\"Mount rails\\nInstall modules\"\n"
        "\"PV Standard\",\"PV modules | 24 | pcs | PV-001\\nDC cable set | 2 | roll | CAB-002\\nPrepare handover checklist\",\"Crimp tool\\nCable cutter\","
        "Commissioning,Prepare handover checklist,office,\"Check inverter\\nPrepare handover\"\n"
        "\"Heat Pump Retrofit\",\"Heat pump unit | 1 | pcs | HP-100\",Vacuum pump,"
        "\"Install heat pump\",\"Install and pressure test the new unit\",construction,\"Connect hydraulics\\nPressure test\"\n"
    )
    template_import = client.post(
        "/api/admin/project-classes/import-csv",
        headers=auth_headers(admin_token),
        files={"file": ("project-classes.csv", csv_payload.encode("utf-8"), "text/csv")},
    )
    assert template_import.status_code == 200
    assert template_import.json()["classes"] == 2
    assert template_import.json()["task_templates"] == 3

    templates = client.get("/api/project-class-templates", headers=auth_headers(admin_token))
    assert templates.status_code == 200
    template_by_name = {entry["name"]: entry for entry in templates.json()}
    assert "PV Standard" in template_by_name
    assert "Heat Pump Retrofit" in template_by_name
    pv_template_id = template_by_name["PV Standard"]["id"]
    heat_template_id = template_by_name["Heat Pump Retrofit"]["id"]

    # Status is "Auftrag angenommen" so the v2.4.2 angenommen-gate lets
    # the template tasks materialise immediately. The deferred-creation
    # path (status NOT angenommen at create time, then transition into it)
    # is covered by test_template_tasks_deferred_until_angenommen below.
    project = client.post(
        "/api/projects",
        headers=auth_headers(admin_token),
        json={
            "project_number": "2026-CLS-1",
            "name": "Class based project",
            "status": "Auftrag angenommen",
            "class_template_ids": [pv_template_id],
        },
    )
    assert project.status_code == 200
    project_id = project.json()["id"]

    assigned = client.get(f"/api/projects/{project_id}/class-templates", headers=auth_headers(admin_token))
    assert assigned.status_code == 200
    assert [row["id"] for row in assigned.json()] == [pv_template_id]

    project_tasks = client.get(
        f"/api/tasks?view=all_open&project_id={project_id}",
        headers=auth_headers(admin_token),
    )
    assert project_tasks.status_code == 200
    titles = {task["title"] for task in project_tasks.json()}
    assert "Mount modules" in titles
    assert "Commissioning" in titles
    for row in project_tasks.json():
        if row["title"] not in {"Mount modules", "Commissioning"}:
            continue
        assert row["due_date"] is None
        assert row["assignee_id"] is None
        assert row["assignee_ids"] == []
        assert row["class_template_id"] == pv_template_id
        assert "Tool:" in (row["materials_required"] or "")
        if row["title"] == "Mount modules":
            assert row["subtasks"] == ["Mount rails", "Install modules"]
            assert "PV modules | 24 | pcs | PV-001" in (row["materials_required"] or "")
        if row["title"] == "Commissioning":
            assert row["subtasks"] == ["Check inverter", "Prepare handover"]
            assert "DC cable set | 2 | roll | CAB-002" in (row["materials_required"] or "")

    class_based_task = client.post(
        "/api/tasks",
        headers=auth_headers(admin_token),
        json={
            "project_id": project_id,
            "title": "Manual class task",
            "description": "Created manually from class",
            "class_template_id": pv_template_id,
            "status": "open",
        },
    )
    assert class_based_task.status_code == 200
    assert class_based_task.json()["class_template_id"] == pv_template_id
    assert "PV modules | 24 | pcs | PV-001" in (class_based_task.json()["materials_required"] or "")
    assert "Tool: Crimp tool" in (class_based_task.json()["materials_required"] or "")

    class_not_assigned = client.post(
        "/api/tasks",
        headers=auth_headers(admin_token),
        json={
            "project_id": project_id,
            "title": "Wrong class task",
            "class_template_id": heat_template_id,
            "status": "open",
        },
    )
    assert class_not_assigned.status_code == 400


def _seed_pv_class_template(client: TestClient, admin_token: str) -> int:
    """Helper for the angenommen-gate tests: load a single-class CSV
    so each test gets a fresh template id without rerunning the bigger
    import scenario above."""
    csv_payload = (
        "class_name,materials_required,tools_required,task_title,task_description,task_type,task_subtasks\n"
        "\"PV Standard\",\"PV modules | 24 | pcs | PV-001\",\"Crimp tool\","
        "\"Mount modules\",\"Install modules on roof\",construction,\"Mount rails\\nInstall modules\"\n"
        "\"PV Standard\",\"PV modules | 24 | pcs | PV-001\",\"Crimp tool\","
        "Commissioning,Prepare handover checklist,office,\"Check inverter\\nPrepare handover\"\n"
    )
    upload = client.post(
        "/api/admin/project-classes/import-csv",
        headers=auth_headers(admin_token),
        files={"file": ("project-classes.csv", csv_payload.encode("utf-8"), "text/csv")},
    )
    assert upload.status_code == 200
    templates = client.get("/api/project-class-templates", headers=auth_headers(admin_token))
    return next(row["id"] for row in templates.json() if row["name"] == "PV Standard")


def test_template_tasks_deferred_until_angenommen(client: TestClient, admin_token: str):
    """The new v2.4.2 angenommen-gate: a project created in any status
    OTHER than "Auftrag angenommen" must NOT auto-create the template's
    tasks. Tasks materialise only when the status transitions into
    "Auftrag angenommen". The class assignment row exists immediately
    (so future status changes know what to create) — only the Tasks are
    deferred."""
    template_id = _seed_pv_class_template(client, admin_token)

    project = client.post(
        "/api/projects",
        headers=auth_headers(admin_token),
        json={
            "project_number": "2026-GATE-1",
            "name": "Gate test project",
            "status": "Anfrage erhalten",
            "class_template_ids": [template_id],
        },
    )
    assert project.status_code == 200
    project_id = project.json()["id"]

    # Class assignment exists immediately…
    assigned = client.get(
        f"/api/projects/{project_id}/class-templates",
        headers=auth_headers(admin_token),
    )
    assert assigned.status_code == 200
    assert [row["id"] for row in assigned.json()] == [template_id]

    # …but no tasks were auto-created (status is not angenommen).
    pending_tasks = client.get(
        f"/api/tasks?view=all_open&project_id={project_id}",
        headers=auth_headers(admin_token),
    )
    assert pending_tasks.status_code == 200
    assert pending_tasks.json() == []

    # Transition to a different non-angenommen status — still no tasks.
    bumped = client.patch(
        f"/api/projects/{project_id}",
        headers=auth_headers(admin_token),
        json={"status": "Angebot abgeschickt"},
    )
    assert bumped.status_code == 200
    still_empty = client.get(
        f"/api/tasks?view=all_open&project_id={project_id}",
        headers=auth_headers(admin_token),
    )
    assert still_empty.json() == []

    # Transition INTO "Auftrag angenommen" — tasks materialise NOW.
    accepted = client.patch(
        f"/api/projects/{project_id}",
        headers=auth_headers(admin_token),
        json={"status": "Auftrag angenommen"},
    )
    assert accepted.status_code == 200
    materialised = client.get(
        f"/api/tasks?view=all_open&project_id={project_id}",
        headers=auth_headers(admin_token),
    )
    titles = {row["title"] for row in materialised.json()}
    assert {"Mount modules", "Commissioning"}.issubset(titles)

    # Re-entry must NOT duplicate tasks. Bounce: angenommen → other →
    # angenommen, then verify the task count is unchanged.
    bounce_out = client.patch(
        f"/api/projects/{project_id}",
        headers=auth_headers(admin_token),
        json={"status": "In Durchführung"},
    )
    assert bounce_out.status_code == 200
    bounce_back = client.patch(
        f"/api/projects/{project_id}",
        headers=auth_headers(admin_token),
        json={"status": "Auftrag angenommen"},
    )
    assert bounce_back.status_code == 200
    after_bounce = client.get(
        f"/api/tasks?view=all_open&project_id={project_id}",
        headers=auth_headers(admin_token),
    )
    after_titles = [row["title"] for row in after_bounce.json()]
    assert sorted(after_titles) == sorted(["Mount modules", "Commissioning"])


def test_template_added_after_angenommen_is_not_deferred(client: TestClient, admin_token: str):
    """Adding a class template via the update endpoint AFTER a project is
    already in "Auftrag angenommen" must materialise the new template's
    tasks immediately — there's no reason to defer when the gate is
    already open."""
    template_id = _seed_pv_class_template(client, admin_token)

    project = client.post(
        "/api/projects",
        headers=auth_headers(admin_token),
        json={
            "project_number": "2026-GATE-2",
            "name": "Already angenommen project",
            "status": "Auftrag angenommen",
            "class_template_ids": [],
        },
    )
    assert project.status_code == 200
    project_id = project.json()["id"]

    # Pre-update: no tasks.
    initial = client.get(
        f"/api/tasks?view=all_open&project_id={project_id}",
        headers=auth_headers(admin_token),
    )
    assert initial.json() == []

    # Add the template — gate is already open, tasks should appear now.
    update = client.patch(
        f"/api/projects/{project_id}",
        headers=auth_headers(admin_token),
        json={"class_template_ids": [template_id]},
    )
    assert update.status_code == 200

    after = client.get(
        f"/api/tasks?view=all_open&project_id={project_id}",
        headers=auth_headers(admin_token),
    )
    titles = {row["title"] for row in after.json()}
    assert {"Mount modules", "Commissioning"}.issubset(titles)
