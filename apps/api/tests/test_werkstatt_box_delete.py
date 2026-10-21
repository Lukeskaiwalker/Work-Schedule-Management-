"""Deleting a Sonderkiste (an ad-hoc crate, ``slot`` NULL, ``BK-<year>-<seq>``).

The Kisten page has always said Sonderkisten are "löschbar", but nobody could:
no client called ``DELETE /werkstatt/boxes/{id}`` and it wanted
``werkstatt:manage``, while creating one needs only a login. The owner's rule
of 2026-10-20: anyone signed in may delete one, but only an empty crate on the
rack (``offen`` or ``zurueck``) that no unfinished task still points at.

The second half is the number. The sticker's DataMatrix encodes
``KISTE-<box_number>`` and stickers outlive crates, so a number is never
issued twice — not even after the newest crate was deleted.

Kept apart from tests/test_werkstatt_boxes.py, which is long enough already.
"""
from __future__ import annotations

from datetime import datetime

from fastapi.testclient import TestClient
from sqlalchemy import select


def auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _employee(client: TestClient, admin_token: str, email: str) -> tuple[int, str]:
    """A plain employee: signed in, no ``werkstatt:manage`` — the people who
    create Sonderkisten and so the people who have to be able to remove them."""
    created = client.post(
        "/api/admin/users",
        headers=auth_headers(admin_token),
        json={
            "email": email,
            "password": "Password123!",
            "full_name": "Monteur Muster",
            "role": "employee",
        },
    )
    assert created.status_code == 200, created.text
    login = client.post("/api/auth/login", json={"email": email, "password": "Password123!"})
    assert login.status_code == 200, login.text
    return created.json()["id"], login.headers["X-Access-Token"]


def _customer(client: TestClient, admin_token: str, name: str) -> int:
    resp = client.post("/api/customers", headers=auth_headers(admin_token), json={"name": name})
    assert resp.status_code == 200, resp.text
    return resp.json()["id"]


def _box(client: TestClient, token: str, label: str = "Sonderkiste Muster") -> dict:
    resp = client.post("/api/werkstatt/boxes", headers=auth_headers(token), json={"label": label})
    assert resp.status_code == 200, resp.text
    return resp.json()


def _put_in(client: TestClient, token: str, box_id: int, **line) -> None:
    body = line or {"item_name": "Leitung NYM 3x1,5", "quantity": 1}
    resp = client.post(
        f"/api/werkstatt/boxes/{box_id}/items", headers=auth_headers(token), json=body
    )
    assert resp.status_code == 200, resp.text


def _hand_over(client: TestClient, admin_token: str, box_id: int, customer_id: int) -> None:
    """``/assign`` is the one road that hands over an EMPTY crate (it passes
    ``allow_empty``), which is what isolates the status rule from the
    emptiness rule below."""
    resp = client.post(
        f"/api/werkstatt/boxes/{box_id}/assign",
        headers=auth_headers(admin_token),
        json={"customer_id": customer_id},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "zugewiesen"


def _status(client: TestClient, admin_token: str, box_id: int, status: str) -> None:
    resp = client.post(
        f"/api/werkstatt/boxes/{box_id}/status",
        headers=auth_headers(admin_token),
        json={"status": status},
    )
    assert resp.status_code == 200, resp.text


def _delete(client: TestClient, token: str, box_id: int):
    return client.delete(f"/api/werkstatt/boxes/{box_id}", headers=auth_headers(token))


def _exists(client: TestClient, admin_token: str, box_id: int) -> bool:
    resp = client.get(f"/api/werkstatt/boxes/{box_id}", headers=auth_headers(admin_token))
    assert resp.status_code in (200, 404), resp.text
    return resp.status_code == 200


def _year() -> int:
    from app.core.time import utcnow

    return utcnow().year


# ── Who may delete, and what ─────────────────────────────────────────────────


def test_an_employee_deletes_an_empty_open_sonderkiste_and_it_is_audited(
    client: TestClient, admin_token: str
):
    employee_id, employee_token = _employee(client, admin_token, "monteur.loeschen@example.com")
    box = _box(client, employee_token, "Sonderkiste Muster")

    resp = _delete(client, employee_token, box["id"])
    assert resp.status_code == 204, resp.text
    assert not _exists(client, admin_token, box["id"])

    from app.core.db import SessionLocal
    from app.models.entities import AuditLog

    with SessionLocal() as db:
        rows = db.scalars(
            select(AuditLog).where(AuditLog.action == "werkstatt.box.delete")
        ).all()
    assert len(rows) == 1
    entry = rows[0]
    assert entry.actor_user_id == employee_id
    assert entry.target_id == str(box["id"])
    assert entry.details["box_number"] == box["box_number"]
    assert entry.details["label"] == "Sonderkiste Muster"


def test_an_empty_returned_sonderkiste_is_deletable_by_an_employee(
    client: TestClient, admin_token: str
):
    """``zurueck`` is a crate back on the rack too — nothing of it is out."""
    _, employee_token = _employee(client, admin_token, "monteur.zurueck@example.com")
    customer_id = _customer(client, admin_token, "Kundin Muster")
    box = _box(client, admin_token)
    _hand_over(client, admin_token, box["id"], customer_id)
    _status(client, admin_token, box["id"], "zurueck")

    resp = _delete(client, employee_token, box["id"])
    assert resp.status_code == 204, resp.text
    assert not _exists(client, admin_token, box["id"])


def test_a_sonderkiste_with_something_in_it_is_not_deleted(
    client: TestClient, admin_token: str
):
    """Deleting cascades the lines away, and a line in a crate on the rack is
    stock somebody is about to look for. Driven with the admin token: before
    this rule even the administrator's delete removed a full crate."""
    box = _box(client, admin_token)
    _put_in(client, admin_token, box["id"])

    resp = _delete(client, admin_token, box["id"])
    assert resp.status_code == 400, resp.text
    assert resp.json()["detail"] == "Die Kiste ist nicht leer — erst leeren, dann löschen."
    assert _exists(client, admin_token, box["id"])
    items = client.get(
        f"/api/werkstatt/boxes/{box['id']}/items", headers=auth_headers(admin_token)
    ).json()
    assert len(items) == 1


def test_a_standard_crate_is_refused_in_german_to_an_employee(
    client: TestClient, admin_token: str
):
    _, employee_token = _employee(client, admin_token, "monteur.regal@example.com")
    rack = client.get("/api/werkstatt/boxes", headers=auth_headers(admin_token)).json()
    k1 = next(row for row in rack if row["slot"] == 1)

    resp = _delete(client, employee_token, k1["id"])
    assert resp.status_code == 400, resp.text
    assert resp.json()["detail"] == "Standard-Kisten sind fest — statt zu löschen bitte leeren."
    assert _exists(client, admin_token, k1["id"])


def test_a_packed_or_handed_over_sonderkiste_is_refused_to_an_employee(
    client: TestClient, admin_token: str
):
    """Both states in which a crate is somebody's. The handed-over one is
    empty on purpose, so it is the status that refuses, not the contents."""
    _, employee_token = _employee(client, admin_token, "monteur.zugewiesen@example.com")
    customer_id = _customer(client, admin_token, "Kunde Muster")

    packed = _box(client, admin_token, "Sonderkiste Gepackt")
    _put_in(client, admin_token, packed["id"])
    resp = client.post(
        f"/api/werkstatt/boxes/{packed['id']}/pack",
        headers=auth_headers(admin_token),
        json={"customer_id": customer_id},
    )
    assert resp.status_code == 200, resp.text

    out = _box(client, admin_token, "Sonderkiste Unterwegs")
    _hand_over(client, admin_token, out["id"], customer_id)

    for box in (packed, out):
        resp = _delete(client, employee_token, box["id"])
        assert resp.status_code == 400, f"{box['label']}: {resp.text}"
        assert resp.json()["detail"] == (
            "Die Kiste ist einem Kunden zugewiesen — erst die Zuweisung aufheben "
            "oder die Kiste zurückbuchen."
        )
        assert _exists(client, admin_token, box["id"])


# ── Tasks that point at the crate ────────────────────────────────────────────


def test_a_sonderkiste_linked_to_an_unfinished_task_is_not_deleted(
    client: TestClient, admin_token: str
):
    """The task form would keep showing a crate that no longer exists, and the
    settlement would find nothing to settle. Admin token for the same reason
    as the emptiness test: the old delete let even this through."""
    customer_id = _customer(client, admin_token, "Kunde Aufgabe")
    box = _box(client, admin_token)
    task = client.post(
        "/api/tasks",
        headers=auth_headers(admin_token),
        json={
            "title": "Zählerschrank Muster",
            "customer_id": customer_id,
            "construction_box_id": box["id"],
        },
    )
    assert task.status_code == 200, task.text

    resp = _delete(client, admin_token, box["id"])
    assert resp.status_code == 400, resp.text
    detail = resp.json()["detail"]
    assert "offenen Aufgabe" in detail
    assert "Zählerschrank Muster" in detail
    assert _exists(client, admin_token, box["id"])

    from app.core.db import SessionLocal
    from app.models.entities import Task

    with SessionLocal() as db:
        assert db.get(Task, task.json()["id"]).construction_box_id == box["id"]


def test_a_finished_task_lets_go_of_the_crate_it_pointed_at(
    client: TestClient, admin_token: str
):
    """A done task linked to a crate that stayed ``offen`` keeps its link (the
    settlement leaves an open crate alone). That link is history, not a claim,
    so it may not hold the crate hostage — the delete drops it."""
    _, employee_token = _employee(client, admin_token, "monteur.erledigt@example.com")
    customer_id = _customer(client, admin_token, "Kunde Erledigt")
    box = _box(client, admin_token)
    created = client.post(
        "/api/tasks",
        headers=auth_headers(admin_token),
        json={
            "title": "Erledigte Montage",
            "customer_id": customer_id,
            "construction_box_id": box["id"],
        },
    )
    assert created.status_code == 200, created.text
    done = client.patch(
        f"/api/tasks/{created.json()['id']}",
        headers=auth_headers(admin_token),
        json={"status": "done"},
    )
    assert done.status_code == 200, done.text
    assert done.json()["construction_box_id"] == box["id"]

    from app.core.db import SessionLocal
    from app.models.entities import Task

    with SessionLocal() as db:
        finished_at = db.get(Task, created.json()["id"]).updated_at

    resp = _delete(client, employee_token, box["id"])
    assert resp.status_code == 204, resp.text
    assert not _exists(client, admin_token, box["id"])

    with SessionLocal() as db:
        row = db.get(Task, created.json()["id"])
        assert row is not None and row.status == "done"
        assert row.construction_box_id is None
        # The "my_all" view reads updated_at as when the status flipped; a
        # crate tidied away months later must not bring the task back.
        assert row.updated_at == finished_at


# ── The ledger keeps its history ─────────────────────────────────────────────


def test_a_crate_with_ledger_history_is_deletable_and_the_ledger_keeps_its_rows(
    client: TestClient, admin_token: str
):
    """Handed over, returned, re-opened and emptied: the crate is gone, the
    stock movements it caused are not. Their notes carry the crate number in
    words, so the ledger still says which crate it was once the link is
    nulled (ON DELETE SET NULL on PostgreSQL)."""
    _, employee_token = _employee(client, admin_token, "monteur.ledger@example.com")
    customer_id = _customer(client, admin_token, "Kunde Ledger")

    article = client.post(
        "/api/werkstatt/articles",
        headers=auth_headers(admin_token),
        json={"item_name": "Wago 221-413", "unit": "Stk"},
    ).json()
    from app.core.db import SessionLocal
    from app.models.entities import User, WerkstattArticle, WerkstattMovement
    from app.services.werkstatt_movements import apply_movement

    with SessionLocal() as db:
        admin = db.scalars(select(User).where(User.email == "admin@example.com")).first()
        apply_movement(
            db,
            article=db.get(WerkstattArticle, article["id"]),
            movement_type="intake",
            quantity=10,
            user_id=admin.id,
            notes="test-intake",
        )
        db.commit()

    box = _box(client, admin_token)
    _put_in(client, admin_token, box["id"], article_id=article["id"], quantity=4)
    _hand_over(client, admin_token, box["id"], customer_id)
    _status(client, admin_token, box["id"], "zurueck")
    _status(client, admin_token, box["id"], "offen")
    cleared = client.delete(
        f"/api/werkstatt/boxes/{box['id']}/items", headers=auth_headers(admin_token)
    )
    assert cleared.status_code == 200, cleared.text

    resp = _delete(client, employee_token, box["id"])
    assert resp.status_code == 204, resp.text
    assert not _exists(client, admin_token, box["id"])

    with SessionLocal() as db:
        rows = db.scalars(
            select(WerkstattMovement)
            .where(WerkstattMovement.article_id == article["id"])
            .order_by(WerkstattMovement.id)
        ).all()
        assert [(row.movement_type, row.quantity) for row in rows] == [
            ("intake", 10),
            ("checkout", 4),
            ("return", 4),
        ]
        for row in rows[1:]:
            assert f"Baustellenkiste {box['box_number']}" in (row.notes or "")
        # The return booked everything back: deleting the crate moved nothing.
        assert db.get(WerkstattArticle, article["id"]).stock_available == 10


# ── Numbers are never issued twice ───────────────────────────────────────────


def test_deleting_the_newest_sonderkiste_does_not_free_its_number(
    client: TestClient, admin_token: str
):
    year = _year()
    first = _box(client, admin_token, "Sonderkiste Eins")
    second = _box(client, admin_token, "Sonderkiste Zwei")
    assert first["box_number"] == f"BK-{year}-0001"
    assert second["box_number"] == f"BK-{year}-0002"

    assert _delete(client, admin_token, second["id"]).status_code == 204

    third = _box(client, admin_token, "Sonderkiste Drei")
    assert third["box_number"] == f"BK-{year}-0003"


def test_a_crate_older_than_the_high_water_mark_is_remembered_when_deleted(
    client: TestClient, admin_token: str
):
    """Crates created before the mark existed (production's BK-2026-0001) have
    no ``app_settings`` row behind them. Deleting one must record it first."""
    from app.core.db import SessionLocal
    from app.models.entities import AppSetting, WerkstattConstructionBox

    year = _year()
    with SessionLocal() as db:
        old = WerkstattConstructionBox(
            box_number=f"BK-{year}-0001",
            label="Sonderkiste Muster",
            status="offen",
            created_by=None,
        )
        db.add(old)
        db.commit()
        old_id = old.id
        assert db.scalars(select(AppSetting).where(AppSetting.key.like("werkstatt.%"))).all() == []

    assert _delete(client, admin_token, old_id).status_code == 204

    after = _box(client, admin_token, "Sonderkiste Neu")
    assert after["box_number"] == f"BK-{year}-0002"


def test_deleting_an_older_crate_never_lowers_the_mark(
    client: TestClient, admin_token: str
):
    """A delete records ``max(mark, its number)``, not its number. Writing
    the deleted number as it is would drop the mark from 3 to 1 here, and the
    next crate would be 0003 again — the number on the old 0003 sticker."""
    from app.core.db import SessionLocal
    from app.models.entities import AppSetting

    year = _year()
    boxes = [_box(client, admin_token, f"Sonderkiste {name}") for name in ("Eins", "Zwei", "Drei")]
    assert [box["box_number"] for box in boxes] == [f"BK-{year}-000{n}" for n in (1, 2, 3)]

    assert _delete(client, admin_token, boxes[2]["id"]).status_code == 204
    assert _delete(client, admin_token, boxes[0]["id"]).status_code == 204

    with SessionLocal() as db:
        mark = db.get(AppSetting, f"werkstatt.box_number_high_water.{year}")
        assert mark is not None and mark.value == "3"
    assert _box(client, admin_token, "Sonderkiste Vier")["box_number"] == f"BK-{year}-0004"


def test_a_mark_read_before_another_delete_committed_is_not_written_back():
    """Two people delete 0004 and 0003 at the same moment. The one retiring
    0003 looked at the mark (1) before the other committed 4; if it decides on
    that, it writes 3 over 4 and BK-…-0004 is issued a second time.

    In production the mark's row is locked from the read to the commit, so the
    second delete waits and then reads 4 — PostgreSQL only, like every row lock
    here (SQLite has none). What SQLite can pin is the other half: the
    comparison is made on the row as the database holds it now, never on a
    copy the session read earlier."""
    from app.core.db import SessionLocal
    from app.models.entities import AppSetting
    from app.services.werkstatt_boxes import retire_box_number

    year = _year()
    key = f"werkstatt.box_number_high_water.{year}"
    with SessionLocal() as db:
        db.add(AppSetting(key=key, value="1"))
        db.commit()

    with SessionLocal() as late:
        # Held: the session's identity map keeps only referenced rows, and an
        # unreferenced one would be read afresh anyway, proving nothing.
        seen_before = late.get(AppSetting, key)
        assert seen_before.value == "1"
        with SessionLocal() as first:
            retire_box_number(first, f"BK-{year}-0004")
            first.commit()
        retire_box_number(late, f"BK-{year}-0003")
        late.commit()

    with SessionLocal() as db:
        assert db.get(AppSetting, key).value == "4"


def test_two_creates_in_a_row_still_count_up(client: TestClient, admin_token: str):
    """The guard on the ordinary path: the mark must not stall the counter."""
    year = _year()
    numbers = [_box(client, admin_token, f"Sonderkiste {n}")["box_number"] for n in (1, 2)]
    assert numbers == [f"BK-{year}-0001", f"BK-{year}-0002"]

    from app.core.db import SessionLocal
    from app.models.entities import AppSetting

    with SessionLocal() as db:
        mark = db.get(AppSetting, f"werkstatt.box_number_high_water.{year}")
        assert mark is not None and mark.value == "2"


def test_issuing_a_number_records_the_mark_per_year_in_the_same_transaction():
    """``next_box_number`` is the one place every creator goes through (the
    Kisten page and the settlement's "Rest in neue Kiste"), so it is where the
    mark is written — in the caller's transaction, visible to the next call
    before anything is committed, and kept per year so January still starts
    at 0001."""
    from app.core.db import SessionLocal
    from app.services.werkstatt_boxes import next_box_number

    december = datetime(2025, 12, 31, 23, 0)
    january = datetime(2026, 1, 1, 8, 0)
    with SessionLocal() as db:
        assert next_box_number(db, now=december) == "BK-2025-0001"
        assert next_box_number(db, now=december) == "BK-2025-0002"
        assert next_box_number(db, now=january) == "BK-2026-0001"
        db.rollback()
    with SessionLocal() as db:
        # Rolled back with the transaction that would have used them.
        assert next_box_number(db, now=december) == "BK-2025-0001"
        db.rollback()
