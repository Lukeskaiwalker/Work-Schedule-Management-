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

    csv_payload = (
        "class_name,materials_required,tools_required,task_title,task_description,task_type\n"
        "PV Standard,\"PV modules\\nDC cable set\",\"Crimp tool\\nCable cutter\","
        "Mount modules,Install modules on roof,construction\n"
        "PV Standard,\"PV modules\\nDC cable set\",\"Crimp tool\\nCable cutter\","
        "Commissioning,Prepare handover checklist,office\n"
        "Heat Pump Retrofit,\"Heat pump unit\",\"Vacuum pump\","
        "Install heat pump,Install and pressure test the new unit,construction\n"
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

    project = client.post(
        "/api/projects",
        headers=auth_headers(admin_token),
        json={
            "project_number": "2026-CLS-1",
            "name": "Class based project",
            "status": "active",
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
    assert "Materials:" in (class_based_task.json()["materials_required"] or "")
    assert "Tools:" in (class_based_task.json()["materials_required"] or "")

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
