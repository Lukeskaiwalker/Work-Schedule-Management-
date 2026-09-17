"""Tests for ``GET /api/werkstatt/on-site`` — the full "Auf Baustelle" list.

The point of this endpoint is the two things the dashboard preview cannot do:
show every project (not the top three), and subtract what already came back.
Both get a dedicated test, because both are the bug the page shipped with.

Seeding follows ``test_werkstatt_mobile.py``: one ``SessionLocal`` block that
commits before any TestClient request, and an inline admin login rather than
the ``admin_token`` fixture.
"""

from __future__ import annotations

from datetime import timedelta

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
from app.services.werkstatt_on_site import _open_lot_rows, _replay


@pytest.fixture(autouse=True)
def _reset_sqla_pool_between_tests():
    """Same pool-dispose dance as test_werkstatt_mobile.py — see the comment
    there for why SQLite otherwise reports a readonly database."""

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


def _seed_user(db: Session, email: str, full_name: str) -> User:
    user = User(
        email=email,
        password_hash=get_password_hash("unused-Password123!"),
        full_name=full_name,
        role="employee",
        is_active=True,
    )
    db.add(user)
    db.flush()
    return user


def _seed_project(db: Session, number: str, name: str) -> Project:
    project = Project(
        project_number=number,
        name=name,
        customer_name=f"Kunde {number}",
        construction_site_address=f"Baustellenweg 1, {number}",
    )
    db.add(project)
    db.flush()
    return project


def _seed_article(
    db: Session,
    *,
    scaffold: User,
    article_number: str,
    item_name: str,
    stock_total: int,
) -> WerkstattArticle:
    article = WerkstattArticle(
        article_number=article_number,
        item_name=item_name,
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
            user_id=scaffold.id,
            created_at=utcnow() - timedelta(days=30),
            notes="scaffold-intake",
        )
    )
    db.flush()
    return article


def _book(
    db: Session,
    *,
    article: WerkstattArticle,
    movement_type: str,
    quantity: int,
    user: User,
    project: Project | None = None,
    assignee: User | None = None,
    expected_return_at=None,
    minutes_ago: int = 0,
) -> None:
    """Append one ledger row and keep the article's snapshot counters in step.

    The counters are what the endpoint selects articles by, so a test that
    only wrote ledger rows would seed rows the query never sees.
    """

    db.add(
        WerkstattMovement(
            article_id=article.id,
            movement_type=movement_type,
            quantity=quantity,
            user_id=user.id,
            assignee_user_id=assignee.id if assignee else None,
            project_id=project.id if project else None,
            expected_return_at=expected_return_at,
            created_at=utcnow() - timedelta(minutes=minutes_ago),
        )
    )
    if movement_type == "checkout":
        article.stock_available -= quantity
        article.stock_out += quantity
    elif movement_type == "return":
        article.stock_available += quantity
        article.stock_out -= quantity
    elif movement_type == "repair_out":
        article.stock_out -= quantity
        article.stock_repair += quantity
    elif movement_type == "correction":
        article.stock_total -= quantity
        article.stock_out -= quantity
    db.add(article)
    db.flush()


# ──────────────────────────────────────────────────────────────────────────
# Tests
# ──────────────────────────────────────────────────────────────────────────


def test_groups_outstanding_checkouts_by_project(client: TestClient) -> None:
    due = utcnow() + timedelta(days=2)
    with _SeedSession() as db:
        scaffold = _seed_user(db, "scaffold@example.com", "Scaffold")
        tech = _seed_user(db, "tech@example.com", "Tim Techniker")
        project = _seed_project(db, "P-1001", "Neubau Musterstraße")
        article = _seed_article(
            db, scaffold=scaffold, article_number="SP-0001",
            item_name="Bosch Bohrhammer", stock_total=5,
        )
        _book(
            db, article=article, movement_type="checkout", quantity=2,
            user=tech, project=project, assignee=tech,
            expected_return_at=due, minutes_ago=60,
        )

    token = _admin_login(client)
    response = client.get("/api/werkstatt/on-site", headers=_auth(token))
    assert response.status_code == 200, response.text
    groups = response.json()
    assert len(groups) == 1
    group = groups[0]
    assert group["project_number"] == "P-1001"
    assert group["project_title"] == "Neubau Musterstraße"
    assert group["item_count"] == 1
    assert group["total_quantity"] == 2
    assert group["overdue_count"] == 0
    item = group["items"][0]
    assert item["article_number"] == "SP-0001"
    assert item["quantity_out"] == 2
    assert item["assignee_display_name"] == "Tim Techniker"
    assert item["assignee_user_id"] is not None
    assert item["is_overdue"] is False


def test_returned_quantity_is_subtracted_oldest_first(client: TestClient) -> None:
    """The bug the dashboard preview has: it counts checkout rows, so a tool
    that came back is still listed. Two checkouts, one partial return."""

    with _SeedSession() as db:
        scaffold = _seed_user(db, "scaffold@example.com", "Scaffold")
        tech = _seed_user(db, "tech@example.com", "Tim Techniker")
        project = _seed_project(db, "P-2001", "Umbau Hafenstraße")
        article = _seed_article(
            db, scaffold=scaffold, article_number="SP-0002",
            item_name="Kabeltrommel", stock_total=10,
        )
        _book(
            db, article=article, movement_type="checkout", quantity=4,
            user=tech, project=project, assignee=tech, minutes_ago=180,
        )
        _book(
            db, article=article, movement_type="checkout", quantity=3,
            user=tech, project=project, assignee=tech, minutes_ago=120,
        )
        # A return carries neither project nor assignee — the endpoint has to
        # attribute it back to the open checkouts itself.
        _book(
            db, article=article, movement_type="return", quantity=5,
            user=tech, minutes_ago=30,
        )

    token = _admin_login(client)
    response = client.get("/api/werkstatt/on-site", headers=_auth(token))
    assert response.status_code == 200, response.text
    groups = response.json()
    assert len(groups) == 1
    assert groups[0]["total_quantity"] == 2  # 4 + 3 − 5
    assert groups[0]["items"][0]["quantity_out"] == 2


def test_fully_returned_article_disappears(client: TestClient) -> None:
    with _SeedSession() as db:
        scaffold = _seed_user(db, "scaffold@example.com", "Scaffold")
        tech = _seed_user(db, "tech@example.com", "Tim Techniker")
        project = _seed_project(db, "P-3001", "Sanierung Feldweg")
        article = _seed_article(
            db, scaffold=scaffold, article_number="SP-0003",
            item_name="Leiter", stock_total=2,
        )
        _book(
            db, article=article, movement_type="checkout", quantity=2,
            user=tech, project=project, assignee=tech, minutes_ago=90,
        )
        _book(
            db, article=article, movement_type="return", quantity=2,
            user=tech, minutes_ago=10,
        )

    token = _admin_login(client)
    response = client.get("/api/werkstatt/on-site", headers=_auth(token))
    assert response.status_code == 200
    assert response.json() == []


def test_repair_out_settles_a_checkout(client: TestClient) -> None:
    """A tool sent to the repair shop is no longer on the building site."""

    with _SeedSession() as db:
        scaffold = _seed_user(db, "scaffold@example.com", "Scaffold")
        tech = _seed_user(db, "tech@example.com", "Tim Techniker")
        project = _seed_project(db, "P-4001", "Anbau Ringstraße")
        article = _seed_article(
            db, scaffold=scaffold, article_number="SP-0004",
            item_name="Winkelschleifer", stock_total=3,
        )
        _book(
            db, article=article, movement_type="checkout", quantity=3,
            user=tech, project=project, assignee=tech, minutes_ago=200,
        )
        _book(
            db, article=article, movement_type="repair_out", quantity=1,
            user=tech, minutes_ago=20,
        )

    token = _admin_login(client)
    response = client.get("/api/werkstatt/on-site", headers=_auth(token))
    assert response.status_code == 200
    assert response.json()[0]["total_quantity"] == 2


def test_lists_more_projects_than_the_dashboard_preview(client: TestClient) -> None:
    """The dashboard caps at three projects. This endpoint must not."""

    with _SeedSession() as db:
        scaffold = _seed_user(db, "scaffold@example.com", "Scaffold")
        tech = _seed_user(db, "tech@example.com", "Tim Techniker")
        for index in range(5):
            project = _seed_project(db, f"P-50{index}", f"Projekt {index}")
            article = _seed_article(
                db, scaffold=scaffold, article_number=f"SP-01{index}",
                item_name=f"Werkzeug {index}", stock_total=4,
            )
            _book(
                db, article=article, movement_type="checkout", quantity=1,
                user=tech, project=project, assignee=tech, minutes_ago=100 - index,
            )

    token = _admin_login(client)
    dashboard = client.get("/api/werkstatt/dashboard", headers=_auth(token))
    assert dashboard.status_code == 200
    assert len(dashboard.json()["on_site_groups"]) == 3  # the documented cap

    response = client.get("/api/werkstatt/on-site", headers=_auth(token))
    assert response.status_code == 200
    assert len(response.json()) == 5


def test_overdue_rows_sort_first_and_are_flagged(client: TestClient) -> None:
    overdue_at = utcnow() - timedelta(days=3)
    with _SeedSession() as db:
        scaffold = _seed_user(db, "scaffold@example.com", "Scaffold")
        tech = _seed_user(db, "tech@example.com", "Tim Techniker")
        fine = _seed_project(db, "P-6001", "Pünktlich")
        late = _seed_project(db, "P-6002", "Überfällig")
        first = _seed_article(
            db, scaffold=scaffold, article_number="SP-0060",
            item_name="Akkuschrauber", stock_total=2,
        )
        second = _seed_article(
            db, scaffold=scaffold, article_number="SP-0061",
            item_name="Messgerät", stock_total=2,
        )
        _book(
            db, article=first, movement_type="checkout", quantity=1,
            user=tech, project=fine, assignee=tech, minutes_ago=50,
        )
        _book(
            db, article=second, movement_type="checkout", quantity=1,
            user=tech, project=late, assignee=tech,
            expected_return_at=overdue_at, minutes_ago=50,
        )

    token = _admin_login(client)
    response = client.get("/api/werkstatt/on-site", headers=_auth(token))
    assert response.status_code == 200
    groups = response.json()
    assert [g["project_number"] for g in groups] == ["P-6002", "P-6001"]
    assert groups[0]["overdue_count"] == 1
    assert groups[0]["items"][0]["is_overdue"] is True


def test_checkout_without_project_lands_in_its_own_group(client: TestClient) -> None:
    with _SeedSession() as db:
        scaffold = _seed_user(db, "scaffold@example.com", "Scaffold")
        tech = _seed_user(db, "tech@example.com", "Tim Techniker")
        article = _seed_article(
            db, scaffold=scaffold, article_number="SP-0070",
            item_name="Staubsauger", stock_total=1,
        )
        _book(
            db, article=article, movement_type="checkout", quantity=1,
            user=tech, assignee=tech, minutes_ago=15,
        )

    token = _admin_login(client)
    response = client.get("/api/werkstatt/on-site", headers=_auth(token))
    assert response.status_code == 200
    groups = response.json()
    assert len(groups) == 1
    assert groups[0]["project_id"] is None
    assert groups[0]["project_number"] is None
    assert groups[0]["total_quantity"] == 1


def test_a_return_settles_the_oldest_checkout_across_projects(client: TestClient) -> None:
    """Pins a LIMITATION, not a feature.

    ``POST /werkstatt/mobile/return`` writes a ledger row with no project on
    it, so nothing records which checkout a return settled. The replay
    therefore picks the oldest open one — even when it belongs to a different
    building site than the one the return was meant for. The FE says as much on
    every row where this can happen; this test is here so the behaviour stays
    deliberate instead of drifting into an accident.
    """

    with _SeedSession() as db:
        scaffold = _seed_user(db, "scaffold@example.com", "Scaffold")
        tech = _seed_user(db, "tech@example.com", "Tim Techniker")
        older = _seed_project(db, "P-7001", "Seit letzter Woche")
        newer = _seed_project(db, "P-7002", "Seit gestern")
        article = _seed_article(
            db, scaffold=scaffold, article_number="SP-0080",
            item_name="Kabeltrommel", stock_total=10,
        )
        _book(
            db, article=article, movement_type="checkout", quantity=2,
            user=tech, project=older, assignee=tech, minutes_ago=10_000,
        )
        _book(
            db, article=article, movement_type="checkout", quantity=3,
            user=tech, project=newer, assignee=tech, minutes_ago=1_000,
        )
        # Meant as "the three from P-7002 came back" — the ledger cannot say so.
        _book(
            db, article=article, movement_type="return", quantity=3,
            user=tech, minutes_ago=5,
        )

    token = _admin_login(client)
    response = client.get("/api/werkstatt/on-site", headers=_auth(token))
    assert response.status_code == 200
    by_project = {g["project_number"]: g["total_quantity"] for g in response.json()}
    # Oldest-first: P-7001's two are consumed, and one of P-7002's three.
    assert by_project == {"P-7002": 2}
    # Whatever the attribution, the TOTAL still matches the article counter.
    assert sum(by_project.values()) == 2


def test_requires_authentication(client: TestClient) -> None:
    response = client.get("/api/werkstatt/on-site")
    assert response.status_code in (401, 403)


def test_lots_with_different_deadlines_stay_separate_rows(client: TestClient) -> None:
    """Merging on (project, person) alone stamped one deadline on everything.

    Two checkouts of the same drum to the same person on the same site: two
    due back last week, three with no return date at all. Collapsed into one
    row under the nearest deadline, the page reports five drums as overdue and
    the office chases a colleague for three that were never due.
    """

    overdue_at = utcnow() - timedelta(days=2)
    with _SeedSession() as db:
        scaffold = _seed_user(db, "scaffold@example.com", "Scaffold")
        anna = _seed_user(db, "anna@example.com", "Anna Anders")
        project = _seed_project(db, "P-8001", "Halle Nord")
        article = _seed_article(
            db, scaffold=scaffold, article_number="SP-0090",
            item_name="Kabeltrommel", stock_total=10,
        )
        _book(
            db, article=article, movement_type="checkout", quantity=2,
            user=anna, project=project, assignee=anna,
            expected_return_at=overdue_at, minutes_ago=4_000,
        )
        _book(
            db, article=article, movement_type="checkout", quantity=3,
            user=anna, project=project, assignee=anna, minutes_ago=2_000,
        )

    token = _admin_login(client)
    response = client.get("/api/werkstatt/on-site", headers=_auth(token))
    assert response.status_code == 200, response.text
    group = response.json()[0]
    assert group["item_count"] == 2
    assert group["total_quantity"] == 5
    # Only the lot that actually had a deadline is late.
    assert group["overdue_count"] == 1
    late, open_ended = group["items"][0], group["items"][1]
    assert (late["quantity_out"], late["is_overdue"]) == (2, True)
    assert (open_ended["quantity_out"], open_ended["is_overdue"]) == (3, False)
    assert open_ended["expected_return_at"] is None


def test_same_deadline_still_collapses_into_one_row(client: TestClient) -> None:
    """The merge has to keep doing its job — two lots due back at the same
    moment are one line, not two."""

    due = utcnow() + timedelta(days=3)
    with _SeedSession() as db:
        scaffold = _seed_user(db, "scaffold@example.com", "Scaffold")
        anna = _seed_user(db, "anna@example.com", "Anna Anders")
        project = _seed_project(db, "P-8101", "Halle Süd")
        article = _seed_article(
            db, scaffold=scaffold, article_number="SP-0091",
            item_name="Kabeltrommel", stock_total=10,
        )
        for minutes in (900, 600):
            _book(
                db, article=article, movement_type="checkout", quantity=2,
                user=anna, project=project, assignee=anna,
                expected_return_at=due, minutes_ago=minutes,
            )

    token = _admin_login(client)
    response = client.get("/api/werkstatt/on-site", headers=_auth(token))
    assert response.status_code == 200, response.text
    group = response.json()[0]
    assert group["item_count"] == 1
    assert group["items"][0]["quantity_out"] == 4


def test_group_carries_no_customer_name_or_site_address(client: TestClient) -> None:
    """The endpoint is gated on authentication alone, so it must not hand out
    the identity fields every other project read path scopes on membership."""

    with _SeedSession() as db:
        scaffold = _seed_user(db, "scaffold@example.com", "Scaffold")
        tech = _seed_user(db, "tech@example.com", "Tim Techniker")
        project = _seed_project(db, "P-8201", "Sanierung Villa")
        article = _seed_article(
            db, scaffold=scaffold, article_number="SP-0092",
            item_name="Leiter", stock_total=2,
        )
        _book(
            db, article=article, movement_type="checkout", quantity=1,
            user=tech, project=project, assignee=tech, minutes_ago=30,
        )

    token = _admin_login(client)
    response = client.get("/api/werkstatt/on-site", headers=_auth(token))
    assert response.status_code == 200, response.text
    group = response.json()[0]
    assert group["project_number"] == "P-8201"
    assert "customer_name" not in group
    assert "site_address" not in group
    assert "Baustellenweg" not in response.text


def test_replay_reads_only_the_ledger_since_the_last_zero_balance(client: TestClient) -> None:
    """The endpoint used to load every ledger row ever written for every
    article still out — on a page that reloads after each return booking.

    Six full out-and-back cycles leave the balance at zero six times; only the
    history after the last of them can contribute an open lot.
    """

    with _SeedSession() as db:
        scaffold = _seed_user(db, "scaffold@example.com", "Scaffold")
        tech = _seed_user(db, "tech@example.com", "Tim Techniker")
        project = _seed_project(db, "P-8301", "Dauerbaustelle")
        article = _seed_article(
            db, scaffold=scaffold, article_number="SP-0093",
            item_name="Akkuschrauber", stock_total=6,
        )
        minutes = 10_000
        for _ in range(6):
            _book(
                db, article=article, movement_type="checkout", quantity=2,
                user=tech, project=project, assignee=tech, minutes_ago=minutes,
            )
            _book(
                db, article=article, movement_type="return", quantity=2,
                user=tech, minutes_ago=minutes - 10,
            )
            minutes -= 100
        _book(
            db, article=article, movement_type="checkout", quantity=3,
            user=tech, project=project, assignee=tech, minutes_ago=5,
        )
        article_id = article.id
        total_rows = 1 + 6 * 2 + 1  # intake + six cycles + the open checkout

    db = SessionLocal()
    try:
        rows = _open_lot_rows(db, {article_id})[article_id]
        # The final return plus the checkout after it — not the whole ledger.
        assert len(rows) < total_rows
        assert len(rows) == 2
        # And the bound changes nothing about the answer.
        open_lots = _replay(rows)
        assert [lot.remaining for lot in open_lots] == [3]
    finally:
        db.close()

    token = _admin_login(client)
    response = client.get("/api/werkstatt/on-site", headers=_auth(token))
    assert response.status_code == 200, response.text
    assert response.json()[0]["total_quantity"] == 3


def test_full_history_is_replayed_when_a_write_off_exceeded_the_balance(
    client: TestClient,
) -> None:
    """``correction`` is the one settling type the write path does not bound
    against ``stock_out``, so a ledger can contain one larger than the balance
    it settles. After that the running balance is negative and a later zero
    crossing no longer means "nothing was out" — the shortcut has to stand
    down, or the page loses five of the six drums that are genuinely gone.
    """

    with _SeedSession() as db:
        scaffold = _seed_user(db, "scaffold@example.com", "Scaffold")
        tech = _seed_user(db, "tech@example.com", "Tim Techniker")
        project = _seed_project(db, "P-8401", "Nach der Inventur")
        article = _seed_article(
            db, scaffold=scaffold, article_number="SP-0094",
            item_name="Kabeltrommel", stock_total=20,
        )
        _book(
            db, article=article, movement_type="checkout", quantity=10,
            user=tech, project=project, assignee=tech, minutes_ago=1_000,
        )
        # Written off past the balance: the replay clamps, the raw sum does not.
        _book(
            db, article=article, movement_type="correction", quantity=15,
            user=tech, minutes_ago=900,
        )
        _book(
            db, article=article, movement_type="checkout", quantity=8,
            user=tech, project=project, assignee=tech, minutes_ago=800,
        )
        # Brings the RAW running sum back to exactly zero while eight are out.
        _book(
            db, article=article, movement_type="return", quantity=3,
            user=tech, minutes_ago=700,
        )
        _book(
            db, article=article, movement_type="checkout", quantity=1,
            user=tech, project=project, assignee=tech, minutes_ago=600,
        )

    token = _admin_login(client)
    response = client.get("/api/werkstatt/on-site", headers=_auth(token))
    assert response.status_code == 200, response.text
    # Same answer the unbounded replay gave: 10 written off to nothing,
    # then 8 out, 3 back, 1 more out.
    assert response.json()[0]["total_quantity"] == 6
