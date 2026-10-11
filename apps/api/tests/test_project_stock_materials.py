"""The project's Material tab lists what left the Lager for it without a Verteiler.

A consumable taken at the Regal station, the desk or the phone for a project
is a ``consumption`` row with that ``project_id`` and no ``panel_id`` — it was
invisible on ``GET /api/projects/{id}/materials``, which read only the report
payloads and the boards' rows. It now has rows of its own, ``source: "lager"``:
net per article (consumption − consumption_undo), shaped like the Verteiler
rows, never merged with a report bucket or a board.
"""

from __future__ import annotations

from datetime import datetime

from fastapi.testclient import TestClient
from sqlalchemy import select, update

from app.core.db import SessionLocal
from app.models.entities import User, WerkstattArticle, WerkstattArticleUnit, WerkstattMovement
from app.services import werkstatt_consumption as consumption
from app.services.project_stock_materials import project_stock_materials
from app.services.werkstatt_movements import apply_movement
from tests.test_schaltplan import _customer, _project
from tests.test_schaltplan_material import _article, _board

CHECKOUT = "/api/werkstatt/mobile/checkout"


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _take(client: TestClient, token: str, article_id: int, quantity: int, project_id: int | None) -> None:
    booked = client.post(
        CHECKOUT,
        headers=_auth(token),
        json={"article_id": article_id, "quantity": quantity, "project_id": project_id},
    )
    assert booked.status_code == 200, booked.text
    assert booked.json()["booked_as"] == "consumption"


def _take_back(article_id: int, quantity: int, project_id: int | None) -> None:
    with SessionLocal() as db:
        admin = db.scalars(select(User.id).where(User.email == "admin@example.com")).one()
        consumption.undo_stock_consumption(
            db,
            article=db.get(WerkstattArticle, article_id),
            quantity=quantity,
            user_id=admin,
            assignee_user_id=admin,
            project_id=project_id,
            notes="Rest zurück",
        )
        db.commit()


def _materials(client: TestClient, token: str, project_id: int) -> list[dict]:
    rows = client.get(f"/api/projects/{project_id}/materials", headers=_auth(token))
    assert rows.status_code == 200, rows.text
    return rows.json()


def test_what_left_the_lager_for_the_project_is_listed(client: TestClient, admin_token: str) -> None:
    ties = _article(client, admin_token, "Kabelbinder 200 mm", stock=20)
    customer = _customer(client, admin_token)
    project = _project(client, admin_token, customer, number="381")
    other = _project(client, admin_token, customer, number="382")

    _take(client, admin_token, ties["id"], 3, project)
    _take(client, admin_token, ties["id"], 2, project)
    _take(client, admin_token, ties["id"], 5, other)
    _take(client, admin_token, ties["id"], 4, None)
    _take_back(ties["id"], 1, project)

    rows = _materials(client, admin_token, project)
    assert rows == [
        {
            "item": "Kabelbinder 200 mm",
            "unit": "Stk",
            "article_no": ties["article_number"],
            "quantity_total": 4.0,
            "quantity_notes": [],
            "occurrence_count": 2,
            "report_count": 0,
            "last_report_date": rows[0]["last_report_date"],
            "source": "lager",
            "panel_numbers": [],
        }
    ]
    assert rows[0]["last_report_date"] is not None
    assert [(row["source"], row["quantity_total"]) for row in _materials(client, admin_token, other)] == [
        ("lager", 5.0)
    ]


def test_an_article_taken_back_completely_is_gone(client: TestClient, admin_token: str) -> None:
    tape = _article(client, admin_token, "Isolierband rot", stock=5)
    project = _project(client, admin_token, _customer(client, admin_token), number="383")
    _take(client, admin_token, tape["id"], 2, project)
    _take_back(tape["id"], 2, project)
    assert _materials(client, admin_token, project) == []


def test_lager_rows_sit_beside_the_verteiler_rows_and_never_mix(client: TestClient, admin_token: str) -> None:
    mcb = _article(client, admin_token, "Hager MBN116 B16", stock=10)
    ties = _article(client, admin_token, "Abdeckstreifen 12 TE", stock=10)
    customer = _customer(client, admin_token)
    project = _project(client, admin_token, customer, number="384")
    board = _board(client, admin_token, customer, project)

    assert client.post(
        f"/api/schaltplan/panels/{board['id']}/material/book",
        headers=_auth(admin_token),
        json={"article_id": mcb["id"], "quantity": 3},
    ).status_code == 200
    _take(client, admin_token, mcb["id"], 1, project)
    _take(client, admin_token, ties["id"], 2, project)

    rows = _materials(client, admin_token, project)
    assert [(row["source"], row["item"], row["quantity_total"], row["panel_numbers"]) for row in rows] == [
        ("verteiler", "Hager MBN116 B16", 3.0, [board["panel_number"]]),
        ("lager", "Abdeckstreifen 12 TE", 2.0, []),
        ("lager", "Hager MBN116 B16", 1.0, []),
    ]


def test_the_reader_leaves_board_and_machine_rows_alone(client: TestClient, admin_token: str) -> None:
    """Rows of a Verteiler (``panel_id``) or a machine unit (``unit_id``) are
    other buckets — the reader counts the panel-less, unit-less ones only."""
    drill_parts = _article(client, admin_token, "Bohrkrone 68 mm", stock=10)
    customer = _customer(client, admin_token)
    project = _project(client, admin_token, customer, number="385")
    board = _board(client, admin_token, customer, project)
    with SessionLocal() as db:
        admin = db.scalars(select(User.id).where(User.email == "admin@example.com")).one()
        article = db.get(WerkstattArticle, drill_parts["id"])
        unit = WerkstattArticleUnit(unit_number="M-9001", article_id=article.id)
        db.add(unit)
        db.flush()
        on_board = apply_movement(
            db, article=article, movement_type="consumption", quantity=2, user_id=admin,
            project_id=project, panel_id=board["id"],
        )
        on_unit = apply_movement(
            db, article=article, movement_type="consumption", quantity=1, user_id=admin, project_id=project,
        )
        on_unit.unit_id = unit.id
        apply_movement(
            db, article=article, movement_type="consumption", quantity=4, user_id=admin, project_id=project,
        )
        db.commit()
        assert on_board.panel_id == board["id"]

        rows = project_stock_materials(db, project)
        assert [(row.article.id, row.net, row.bookings) for row in rows] == [(drill_parts["id"], 4, 1)]
        assert rows[0].last_at is not None
        assert project_stock_materials(db, 999_999) == []


def _booked_at(article_id: int, moment: datetime) -> None:
    """Every row of the article as if booked at ``moment`` (naive UTC, like
    every ``created_at``)."""
    with SessionLocal() as db:
        db.execute(update(WerkstattMovement).where(WerkstattMovement.article_id == article_id).values(created_at=moment))
        db.commit()


def test_the_date_is_the_workshop_s_day_not_utc_s(client: TestClient, admin_token: str) -> None:
    """A booking at 00:30 in Berlin is 22:30 the evening before in UTC — the tab
    shows the day the workshop lived, for Lager and Verteiler rows alike."""
    summer = _article(client, admin_token, "Kabelbinder 200 mm", stock=10)
    winter = _article(client, admin_token, "Isolierband blau", stock=10)
    built_in = _article(client, admin_token, "Hager MBN116 B16", stock=10)
    customer = _customer(client, admin_token)
    project = _project(client, admin_token, customer, number="386")
    board = _board(client, admin_token, customer, project)
    _take(client, admin_token, summer["id"], 2, project)
    _take(client, admin_token, winter["id"], 1, project)
    assert client.post(
        f"/api/schaltplan/panels/{board['id']}/material/book",
        headers=_auth(admin_token),
        json={"article_id": built_in["id"], "quantity": 1},
    ).status_code == 200
    _booked_at(summer["id"], datetime(2026, 10, 9, 22, 30))  # CEST: 2026-10-10 00:30
    _booked_at(winter["id"], datetime(2026, 1, 15, 23, 30))  # CET: 2026-01-16 00:30
    _booked_at(built_in["id"], datetime(2026, 10, 9, 23, 15))  # CEST: 2026-10-10 01:15

    rows = {(row["source"], row["item"]): row["last_report_date"] for row in _materials(client, admin_token, project)}

    assert rows == {
        ("lager", "Kabelbinder 200 mm"): "2026-10-10",
        ("lager", "Isolierband blau"): "2026-01-16",
        ("verteiler", "Hager MBN116 B16"): "2026-10-10",
    }
