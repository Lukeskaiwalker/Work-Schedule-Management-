"""A project-tagged loan has to be closable from the phone.

``GET /api/werkstatt/mobile/my-checkouts`` balances a borrower's open quantity
per ``(article, project)`` tuple (``services.werkstatt_movements
.list_my_checkouts``). ``POST /api/werkstatt/mobile/return`` used to write its
movement with no project at all, so:

  * the loan the row was showing never reached zero — the phone re-rendered the
    same row under a green "zurückgegeben" notice, forever, and
  * the −qty landed in the borrower's *project-less* bucket for the same
    article, clearing a loan nobody returned.

``test_werkstatt_mobile.py`` covers only the return of a checkout with no
project, which is the one case that always worked. These tests cover the case
that did not.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.core.db import SessionLocal, engine
from app.core.security import get_password_hash
from app.core.time import utcnow
from app.models.entities import (
    Project,
    User,
    WerkstattArticle,
    WerkstattMovement,
)


@pytest.fixture(autouse=True)
def _reset_sqla_pool_between_tests():
    """Same pool reset as ``test_werkstatt_mobile.py`` — the shared
    ``reset_db`` fixture hands its connection back to our ``SessionLocal()``
    and SQLite then fails the next INSERT as "readonly database"."""

    engine.dispose()
    yield


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _admin_login(client: TestClient) -> str:
    response = client.post(
        "/api/auth/login",
        json={"email": "admin@example.com", "password": "ChangeMe123!"},
    )
    assert response.status_code == 200, response.text
    return response.headers["X-Access-Token"]


class _SeedSession:
    """Commit-on-clean-exit wrapper around ``SessionLocal``; seeding finishes
    before the first TestClient request so the autouse cleanup cannot collide
    with an open session."""

    def __enter__(self) -> Session:
        self._session = SessionLocal()
        return self._session

    def __exit__(self, exc_type, exc, tb) -> None:
        try:
            if exc_type is None:
                self._session.commit()
            else:
                self._session.rollback()
        finally:
            self._session.close()


def _seed_scaffold_user(db: Session) -> User:
    """Owner of the opening-stock movement, so the admin's own movement list
    stays limited to what the tests book through the API."""

    user = User(
        email="ws-proj-scaffold@example.com",
        password_hash=get_password_hash("unused-Password123!"),
        full_name="Werkstatt Scaffold",
        role="employee",
        is_active=True,
    )
    db.add(user)
    db.flush()
    return user


def _seed_project(db: Session, number: str) -> Project:
    project = Project(
        project_number=number,
        name=f"Baustelle {number}",
        customer_name=f"Kunde {number}",
        construction_site_address=f"Baustellenweg 1, {number}",
    )
    db.add(project)
    db.flush()
    return project


def _seed_article(
    db: Session,
    *,
    scaffold_user: User,
    article_number: str,
    stock_total: int = 12,
) -> WerkstattArticle:
    article = WerkstattArticle(
        article_number=article_number,
        item_name="Bohrhammer GBH 2-28",
        unit="Stk",
        stock_total=stock_total,
        stock_available=stock_total,
        stock_out=0,
        stock_repair=0,
        stock_min=1,
        currency="EUR",
    )
    db.add(article)
    db.flush()
    db.add(
        WerkstattMovement(
            article_id=article.id,
            movement_type="intake",
            quantity=stock_total,
            user_id=scaffold_user.id,
            created_at=utcnow(),
            notes="scaffold-intake",
        )
    )
    db.flush()
    return article


def test_project_tagged_return_clears_its_row(client: TestClient):
    """The bug in one flow: check out against a project, return everything,
    and the "Meine Entnahmen" row has to be gone."""

    admin_token = _admin_login(client)
    with _SeedSession() as db:
        scaffold = _seed_scaffold_user(db)
        article = _seed_article(db, scaffold_user=scaffold, article_number="SP-PRJ-1")
        project = _seed_project(db, "P-2026-014")
        article_id = article.id
        project_id = project.id

    out = client.post(
        "/api/werkstatt/mobile/checkout",
        headers=_auth(admin_token),
        json={"article_id": article_id, "quantity": 2, "project_id": project_id},
    )
    assert out.status_code == 200, out.text

    rows = client.get("/api/werkstatt/mobile/my-checkouts", headers=_auth(admin_token)).json()
    assert [(r["article_id"], r["project_id"], r["quantity_out"]) for r in rows] == [
        (article_id, project_id, 2)
    ]

    back = client.post(
        "/api/werkstatt/mobile/return",
        headers=_auth(admin_token),
        json={
            "article_id": article_id,
            "quantity": 2,
            "condition": "ok",
            "project_id": project_id,
        },
    )
    assert back.status_code == 200, back.text
    assert back.json()["stock_out"] == 0

    # Without the project on the return this list still showed 2 out, next to a
    # success notice quoting stock_out 0.
    assert client.get(
        "/api/werkstatt/mobile/my-checkouts", headers=_auth(admin_token)
    ).json() == []


def test_project_tagged_return_does_not_clear_a_different_loan(client: TestClient):
    """The other half of the damage: the −qty must not fall into the borrower's
    project-less bucket and cancel a loan they did not bring back."""

    admin_token = _admin_login(client)
    with _SeedSession() as db:
        scaffold = _seed_scaffold_user(db)
        article = _seed_article(db, scaffold_user=scaffold, article_number="SP-PRJ-2")
        project = _seed_project(db, "P-2026-015")
        article_id = article.id
        project_id = project.id

    # Same article, two loans: one on the project, one on nothing.
    for body in (
        {"article_id": article_id, "quantity": 2, "project_id": project_id},
        {"article_id": article_id, "quantity": 3},
    ):
        assert (
            client.post(
                "/api/werkstatt/mobile/checkout", headers=_auth(admin_token), json=body
            ).status_code
            == 200
        )

    assert (
        client.post(
            "/api/werkstatt/mobile/return",
            headers=_auth(admin_token),
            json={
                "article_id": article_id,
                "quantity": 2,
                "condition": "ok",
                "project_id": project_id,
            },
        ).status_code
        == 200
    )

    rows = client.get("/api/werkstatt/mobile/my-checkouts", headers=_auth(admin_token)).json()
    assert [(r["project_id"], r["quantity_out"]) for r in rows] == [(None, 3)]


def test_return_without_project_still_closes_a_project_less_loan(client: TestClient):
    """The field is optional and the old shape keeps its old meaning — a bare
    return closes the loan that was booked against no project."""

    admin_token = _admin_login(client)
    with _SeedSession() as db:
        scaffold = _seed_scaffold_user(db)
        article = _seed_article(db, scaffold_user=scaffold, article_number="SP-PRJ-3")
        article_id = article.id

    assert (
        client.post(
            "/api/werkstatt/mobile/checkout",
            headers=_auth(admin_token),
            json={"article_id": article_id, "quantity": 1},
        ).status_code
        == 200
    )
    assert (
        client.post(
            "/api/werkstatt/mobile/return",
            headers=_auth(admin_token),
            json={"article_id": article_id, "quantity": 1, "condition": "ok"},
        ).status_code
        == 200
    )
    assert client.get(
        "/api/werkstatt/mobile/my-checkouts", headers=_auth(admin_token)
    ).json() == []


def test_repair_return_with_project_also_clears_its_row(client: TestClient):
    """``repair`` and ``lost`` subtract from the same balance as ``ok``
    (``list_my_checkouts`` counts return / repair_out / correction alike), so
    the project has to ride along on those too."""

    admin_token = _admin_login(client)
    with _SeedSession() as db:
        scaffold = _seed_scaffold_user(db)
        article = _seed_article(db, scaffold_user=scaffold, article_number="SP-PRJ-4")
        project = _seed_project(db, "P-2026-016")
        article_id = article.id
        project_id = project.id

    assert (
        client.post(
            "/api/werkstatt/mobile/checkout",
            headers=_auth(admin_token),
            json={"article_id": article_id, "quantity": 1, "project_id": project_id},
        ).status_code
        == 200
    )
    repaired = client.post(
        "/api/werkstatt/mobile/return",
        headers=_auth(admin_token),
        json={
            "article_id": article_id,
            "quantity": 1,
            "condition": "repair",
            "project_id": project_id,
        },
    )
    assert repaired.status_code == 200, repaired.text
    assert repaired.json()["stock_repair"] == 1
    assert client.get(
        "/api/werkstatt/mobile/my-checkouts", headers=_auth(admin_token)
    ).json() == []
