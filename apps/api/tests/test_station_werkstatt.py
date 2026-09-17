"""The station-scoped Werkstatt API — what a wall-mounted Pi may do.

Two screens are being bolted to the workshop wall: one lists the
Baustellenkisten and scans articles into them, one books stock in and out.
Neither has a keyboard, a session, or a person sitting at it, so neither can
hold a user credential — the whole point of ``/api/station/werkstatt`` is that
the Pi carries a *station* token (revocable centrally, useless anywhere else)
instead of a full user PAT screwed to a wall.

What is pinned here is therefore mostly about the boundary:

  * the station token opens exactly these endpoints and nothing more, and a
    user token does not open them at all (a station is not a user, and the
    reverse must stay true or the split buys nothing);
  * revoking or expiring a station bites on its very next request;
  * the rules that protect the data do not weaken on the way through: a box
    that is handed over refuses new contents on the station path exactly as it
    does on the user path, because it is the *same* code;
  * every ledger row a station writes names a real person. ``user_id`` is NOT
    NULL and a device is not a person, so the station borrows one — and if it
    cannot, the booking is refused rather than attributed to nobody.

The heartbeat block at the bottom is a regression pin for a field report
("this SMPL server has no station heartbeat endpoint") — see the module note
there.
"""

from __future__ import annotations

from datetime import timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.core.db import SessionLocal
from app.core.time import utcnow
from app.models.entities import (
    Station,
    User,
    WerkstattArticle,
    WerkstattMovement,
)

BASE = "/api/station/werkstatt"


def auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


# --------------------------------------------------------------------------
# fixtures / helpers  (pairing flow copied from tests/test_station_pairing.py)
# --------------------------------------------------------------------------


def _pair(client: TestClient, approver_token: str, name: str = "Werkstatt Pi") -> tuple[str, dict]:
    """Run the whole device grant and return (raw station token, station)."""
    started = client.post(
        "/api/station/pair/start", json={"device_hint": "scanpi-01", "agent_version": "1.0.0"}
    )
    assert started.status_code == 201, started.text
    body = started.json()

    approved = client.post(
        "/api/station/pair/approve",
        headers=auth_headers(approver_token),
        json={"user_code": body["user_code"], "name": name},
    )
    assert approved.status_code == 200, approved.text

    polled = client.post("/api/station/pair/poll", json={"device_token": body["device_token"]})
    assert polled.status_code == 200, polled.text
    claimed = polled.json()
    assert claimed["status"] == "approved", claimed
    return claimed["token"], claimed["station"]


@pytest.fixture
def station_token(client: TestClient, admin_token: str) -> str:
    token, _ = _pair(client, admin_token)
    return token


def _make_user(client: TestClient, admin_token: str, email: str, role: str) -> dict:
    created = client.post(
        "/api/admin/users",
        headers=auth_headers(admin_token),
        json={
            "email": email,
            "password": "Password123!",
            "full_name": email.split("@", 1)[0],
            "role": role,
        },
    )
    assert created.status_code == 200, created.text
    return created.json()


def _login(client: TestClient, email: str) -> str:
    resp = client.post("/api/auth/login", json={"email": email, "password": "Password123!"})
    assert resp.status_code == 200, resp.text
    return resp.headers["X-Access-Token"]


def _article(client: TestClient, admin_token: str, name: str, stock: int = 0) -> dict:
    """Create an article and seed its stock through the ledger.

    Stock is seeded with a real ``intake`` movement (as tests/test_werkstatt_boxes.py
    does) because the counters on the article are recomputed from the ledger —
    setting them directly would leave the two disagreeing.
    """
    created = client.post(
        "/api/werkstatt/articles",
        headers=auth_headers(admin_token),
        json={"item_name": name, "unit": "Stk"},
    )
    assert created.status_code == 200, created.text
    article = created.json()
    if stock:
        from app.services.werkstatt_movements import apply_movement

        with SessionLocal() as db:
            row = db.get(WerkstattArticle, article["id"])
            admin = db.scalars(select(User).where(User.email == "admin@example.com")).first()
            apply_movement(
                db,
                article=row,
                movement_type="intake",
                quantity=stock,
                user_id=admin.id,
                notes="test-intake",
            )
            db.commit()
        article = client.get(
            f"/api/werkstatt/articles/{article['id']}", headers=auth_headers(admin_token)
        ).json()
    return article


def _box(client: TestClient, admin_token: str, label: str) -> dict:
    resp = client.post(
        "/api/werkstatt/boxes", headers=auth_headers(admin_token), json={"label": label}
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def _movements(article_id: int) -> list[WerkstattMovement]:
    with SessionLocal() as db:
        return list(
            db.scalars(
                select(WerkstattMovement)
                .where(WerkstattMovement.article_id == article_id)
                .order_by(WerkstattMovement.id.asc())
            ).all()
        )


def _user_id(email: str) -> int:
    with SessionLocal() as db:
        row = db.scalars(select(User).where(User.email == email)).first()
        assert row is not None
        return row.id


# --------------------------------------------------------------------------
# the boundary: who may knock
# --------------------------------------------------------------------------


def test_a_station_token_reaches_every_station_werkstatt_endpoint(
    client: TestClient, admin_token: str, station_token: str
) -> None:
    """One test over the whole surface: a paired Pi can do its job.

    Deliberately a single sweep rather than six happy paths — the property is
    "the token opens this router", and a route added later that forgets the
    dependency should fail here, not silently work for nobody.
    """
    article = _article(client, admin_token, "Knipex 03 01 160", stock=5)
    box = _box(client, admin_token, "Kiste Wallbox")
    head = auth_headers(station_token)

    boxes = client.get(f"{BASE}/boxes", headers=head)
    assert boxes.status_code == 200, boxes.text

    resolved = client.get(f"{BASE}/resolve", params={"code": article["article_number"]}, headers=head)
    assert resolved.status_code == 200, resolved.text

    added = client.post(
        f"{BASE}/boxes/{box['id']}/items",
        headers=head,
        json={"article_id": article["id"], "quantity": 2},
    )
    assert added.status_code == 200, added.text

    removed = client.post(
        f"{BASE}/boxes/{box['id']}/items/remove",
        headers=head,
        json={"item_id": added.json()["id"], "quantity": 1},
    )
    assert removed.status_code == 200, removed.text

    booked = client.post(
        f"{BASE}/movements",
        headers=head,
        json={"article_id": article["id"], "movement_type": "checkout", "quantity": 1},
    )
    assert booked.status_code == 200, booked.text

    crew = client.get(f"{BASE}/crew", headers=head)
    assert crew.status_code == 200, crew.text


def test_a_user_token_is_not_a_station_token(
    client: TestClient, admin_token: str
) -> None:
    """The split is only worth having if it cuts both ways.

    An admin JWT is a *more* privileged credential than the station's, and it
    still gets nothing here: these routes authenticate a device, and a user is
    not one. (The practical value is the inverse property — that the token on
    the wall cannot be used as a login — but that is the same dependency.)
    """
    box = _box(client, admin_token, "Kiste Nord")
    head = auth_headers(admin_token)

    attempts = [
        client.get(f"{BASE}/boxes", headers=head),
        client.get(f"{BASE}/resolve", params={"code": "1234"}, headers=head),
        client.post(f"{BASE}/boxes/{box['id']}/items", headers=head, json={"item_name": "X"}),
        client.post(
            f"{BASE}/boxes/{box['id']}/items/remove", headers=head, json={"item_id": 1, "quantity": 1}
        ),
        client.post(
            f"{BASE}/movements",
            headers=head,
            json={"article_id": 1, "movement_type": "checkout", "quantity": 1},
        ),
        client.get(f"{BASE}/crew", headers=head),
    ]
    assert [r.status_code for r in attempts] == [401] * 6, [r.text for r in attempts]


def test_an_unknown_station_token_is_rejected(client: TestClient) -> None:
    unknown = client.get(f"{BASE}/boxes", headers=auth_headers("smpl_station_" + "x" * 43))
    assert unknown.status_code == 401
    garbage = client.get(f"{BASE}/boxes", headers=auth_headers("not-a-token"))
    assert garbage.status_code == 401
    assert client.get(f"{BASE}/boxes").status_code == 401


def test_a_revoked_station_is_locked_out_on_its_next_request(
    client: TestClient, admin_token: str
) -> None:
    """No cache, no grace window — the Pi is a physical object in a room
    somebody may have just been asked to leave."""
    token, station = _pair(client, admin_token)
    assert client.get(f"{BASE}/boxes", headers=auth_headers(token)).status_code == 200

    revoked = client.post(
        f"/api/station/stations/{station['id']}/revoke", headers=auth_headers(admin_token)
    )
    assert revoked.status_code == 200, revoked.text
    assert client.get(f"{BASE}/boxes", headers=auth_headers(token)).status_code == 401


def test_an_expired_station_token_is_rejected(client: TestClient, admin_token: str) -> None:
    token, station = _pair(client, admin_token)
    with SessionLocal() as db:
        row = db.get(Station, station["id"])
        row.expires_at = utcnow() - timedelta(seconds=1)
        db.add(row)
        db.commit()
    assert client.get(f"{BASE}/boxes", headers=auth_headers(token)).status_code == 401


# --------------------------------------------------------------------------
# the box screen
# --------------------------------------------------------------------------


def test_the_box_list_carries_the_scannable_code_and_the_customer_name(
    client: TestClient, admin_token: str, station_token: str
) -> None:
    """The screen must be able to match a scan against what it already shows.

    ``code`` is the string in the box's DataMatrix, so the Pi never has to know
    the label format; ``customer_name`` is there because "K3" means nothing to
    somebody carrying a crate to a van.
    """
    customer = client.post(
        "/api/customers", headers=auth_headers(admin_token), json={"name": "Bäckerei Ohm"}
    )
    assert customer.status_code == 200, customer.text
    customer_id = customer.json()["id"]

    box = _box(client, admin_token, "Kiste Ohm")
    article = _article(client, admin_token, "Gira 5566", stock=3)
    packed = client.post(
        f"/api/werkstatt/boxes/{box['id']}/items",
        headers=auth_headers(admin_token),
        json={"article_id": article["id"], "quantity": 2},
    )
    assert packed.status_code == 200, packed.text

    # Assigned last: handing the crate over freezes its contents, so this is
    # also the order a human has to work in.
    assigned = client.post(
        f"/api/werkstatt/boxes/{box['id']}/assign",
        headers=auth_headers(admin_token),
        json={"customer_id": customer_id},
    )
    assert assigned.status_code == 200, assigned.text

    rows = client.get(f"{BASE}/boxes", headers=auth_headers(station_token))
    assert rows.status_code == 200, rows.text
    body = rows.json()

    # The eight permanent rack boxes are seeded on read, exactly as on the
    # user-facing list — the wall screen is often the first thing opened.
    codes = {row["code"] for row in body}
    assert "KISTE-K1" in codes and "KISTE-K8" in codes

    mine = next(row for row in body if row["id"] == box["id"])
    assert mine["code"] == f"KISTE-{mine['box_number']}"
    assert mine["customer_name"] == "Bäckerei Ohm"
    # The wall screens read ``customer``/``project``; the web UI reads the
    # ``_name`` pair. Both are served, and they must not disagree.
    assert mine["customer"] == mine["customer_name"]
    assert mine["project"] == mine["project_name"]
    assert mine["status"] == "zugewiesen"
    assert [(i["item_name"], i["quantity"]) for i in mine["items"]] == [("Gira 5566", 2)]
    assert mine["item_count"] == 1


def test_resolve_delegates_to_the_shared_scan_cascade(
    client: TestClient, admin_token: str, station_token: str
) -> None:
    """Same service, same answer — including the miss.

    The station screen and the phone must not disagree about what a barcode
    is, so this is the *same* cascade rather than a second one that drifts.
    """
    article = _article(client, admin_token, "Fluke 117", stock=1)
    code = article["article_number"]

    as_station = client.get(f"{BASE}/resolve", params={"code": code}, headers=auth_headers(station_token))
    as_user = client.get(
        "/api/werkstatt/scan/resolve", params={"code": code}, headers=auth_headers(admin_token)
    )
    assert as_station.status_code == 200, as_station.text
    assert as_station.json() == as_user.json()
    assert as_station.json()["kind"] == "werkstatt_article"
    assert as_station.json()["matched_by"] == "sp"

    missed = client.get(
        f"{BASE}/resolve", params={"code": "0000000000000"}, headers=auth_headers(station_token)
    )
    assert missed.status_code == 200
    assert missed.json() == {"kind": "not_found", "code": "0000000000000"}


def test_a_handed_over_box_refuses_station_items_exactly_like_the_user_endpoint(
    client: TestClient, admin_token: str, station_token: str
) -> None:
    """The lock is a property of the box, not of who is asking.

    A crate that has been handed to a customer is a closed record; if the wall
    screen could still add to it, the station path would be a way around the
    rule rather than another way to obey it.
    """
    customer = client.post(
        "/api/customers", headers=auth_headers(admin_token), json={"name": "Elektro Süd"}
    ).json()
    box = _box(client, admin_token, "Kiste Süd")
    client.post(
        f"/api/werkstatt/boxes/{box['id']}/assign",
        headers=auth_headers(admin_token),
        json={"customer_id": customer["id"]},
    )
    article = _article(client, admin_token, "Hager MBN", stock=4)

    as_user = client.post(
        f"/api/werkstatt/boxes/{box['id']}/items",
        headers=auth_headers(admin_token),
        json={"article_id": article["id"], "quantity": 1},
    )
    as_station = client.post(
        f"{BASE}/boxes/{box['id']}/items",
        headers=auth_headers(station_token),
        json={"article_id": article["id"], "quantity": 1},
    )
    assert as_user.status_code == 400, as_user.text
    assert as_station.status_code == 400, as_station.text
    assert as_station.json()["detail"] == as_user.json()["detail"]

    # …and removal is refused for the same reason.
    blocked = client.post(
        f"{BASE}/boxes/{box['id']}/items/remove",
        headers=auth_headers(station_token),
        json={"item_id": 1, "quantity": 1},
    )
    assert blocked.status_code == 400, blocked.text


def test_scanning_a_code_into_a_box_tops_up_the_line_it_already_has(
    client: TestClient, admin_token: str, station_token: str
) -> None:
    """A second scan of the same article means "one more", not "a second row".

    This is the user endpoint's rule, reached through the station's own
    ``code`` field — the Pi sends what the scanner read, not an article id it
    has no way of knowing.
    """
    article = _article(client, admin_token, "Wago 221-413", stock=10)
    box = _box(client, admin_token, "Kiste Klemmen")
    head = auth_headers(station_token)
    code = article["article_number"]

    first = client.post(f"{BASE}/boxes/{box['id']}/items", headers=head, json={"code": code})
    assert first.status_code == 200, first.text
    assert first.json()["quantity"] == 1
    assert first.json()["source"] == "article"
    assert first.json()["article_id"] == article["id"]

    second = client.post(
        f"{BASE}/boxes/{box['id']}/items", headers=head, json={"code": code, "quantity": 4}
    )
    assert second.status_code == 200, second.text
    assert second.json()["id"] == first.json()["id"]
    assert second.json()["quantity"] == 5

    detail = client.get(
        f"/api/werkstatt/boxes/{box['id']}", headers=auth_headers(admin_token)
    ).json()
    assert len(detail["items"]) == 1


def test_an_unknown_code_is_refused_rather_than_packed_as_a_mystery_line(
    client: TestClient, admin_token: str, station_token: str
) -> None:
    """A wall screen has nobody to type a name, so an unresolvable scan can
    only become a line called "4006381333931". That is worse than nothing."""
    box = _box(client, admin_token, "Kiste Rätsel")
    refused = client.post(
        f"{BASE}/boxes/{box['id']}/items",
        headers=auth_headers(station_token),
        json={"code": "4006381333931"},
    )
    assert refused.status_code == 400, refused.text
    assert "4006381333931" in refused.json()["detail"]


def test_removing_part_of_a_line_leaves_the_rest(
    client: TestClient, admin_token: str, station_token: str
) -> None:
    """Taking two out of five is the common case at the crate; the line only
    disappears when the last one is gone."""
    article = _article(client, admin_token, "Kabelbinder 200", stock=50)
    box = _box(client, admin_token, "Kiste Kleinteile")
    head = auth_headers(station_token)

    line = client.post(
        f"{BASE}/boxes/{box['id']}/items",
        headers=head,
        json={"article_id": article["id"], "quantity": 5},
    ).json()

    partial = client.post(
        f"{BASE}/boxes/{box['id']}/items/remove",
        headers=head,
        json={"item_id": line["id"], "quantity": 2},
    )
    assert partial.status_code == 200, partial.text
    assert partial.json()["removed"] == 2

    still_there = client.get(
        f"/api/werkstatt/boxes/{box['id']}/items", headers=auth_headers(admin_token)
    ).json()
    assert [row["quantity"] for row in still_there] == [3]

    # Asking for more than is there empties the line rather than failing: the
    # screen's count can be one scan stale, and "remove it" is the intent.
    rest = client.post(
        f"{BASE}/boxes/{box['id']}/items/remove",
        headers=head,
        json={"item_id": line["id"], "quantity": 99},
    )
    assert rest.status_code == 200, rest.text
    assert rest.json()["removed"] == 3
    assert (
        client.get(
            f"/api/werkstatt/boxes/{box['id']}/items", headers=auth_headers(admin_token)
        ).json()
        == []
    )


# --------------------------------------------------------------------------
# the rack screen: movements
# --------------------------------------------------------------------------


def test_a_station_checkout_moves_the_counters_and_names_the_resolved_user(
    client: TestClient, admin_token: str, station_token: str
) -> None:
    """The assertion that matters is the article snapshot, not the 200."""
    article = _article(client, admin_token, "Bosch GBH 2-28", stock=6)
    assert (article["stock_available"], article["stock_out"]) == (6, 0)

    booked = client.post(
        f"{BASE}/movements",
        headers=auth_headers(station_token),
        json={"article_id": article["id"], "movement_type": "checkout", "quantity": 2},
    )
    assert booked.status_code == 200, booked.text
    body = booked.json()
    assert body["article"]["stock_available"] == 4
    assert body["article"]["stock_out"] == 2
    assert body["article"]["stock_total"] == 6
    assert body["movement_id"] > 0

    rows = _movements(article["id"])
    assert [row.movement_type for row in rows] == ["intake", "checkout"]
    assert rows[-1].user_id == _user_id("admin@example.com")
    assert rows[-1].notes and "Werkstatt Pi" in rows[-1].notes


def test_an_intake_raises_total_and_available_together(
    client: TestClient, admin_token: str, station_token: str
) -> None:
    article = _article(client, admin_token, "Schrumpfschlauch", stock=0)
    booked = client.post(
        f"{BASE}/movements",
        headers=auth_headers(station_token),
        json={"article_id": article["id"], "movement_type": "intake", "quantity": 7},
    )
    assert booked.status_code == 200, booked.text
    assert booked.json()["article"]["stock_total"] == 7
    assert booked.json()["article"]["stock_available"] == 7


def test_a_stock_take_correction_cannot_be_booked_from_the_wall(
    client: TestClient, admin_token: str, station_token: str
) -> None:
    """The whitelist used to admit ``inventory_minus``, and nothing guarded it.

    ``apply_movement`` fast-fails only the movements it can check against a
    counter (checkout, return, repair_*); an inventory correction is by
    definition allowed to disagree with the snapshot, so an unbounded
    ``inventory_minus`` appended straight to the ledger. The recompute then
    clamps the *snapshot* at 0 while the ledger stays deeply negative — and
    every later delivery is swallowed by the hole, so the article reads 0
    forever until somebody edits the ledger by hand.

    A wall screen has no keyboard, so it cannot supply the reason a stock-take
    correction needs. It therefore books three directions and no fourth.
    """
    article = _article(client, admin_token, "Isolierband", stock=10)
    refused = client.post(
        f"{BASE}/movements",
        headers=auth_headers(station_token),
        json={
            "article_id": article["id"],
            "movement_type": "inventory_minus",
            "quantity": 9_999,
        },
    )
    assert refused.status_code == 400, refused.text
    assert "Buchungsart" in refused.json()["detail"]

    # Nothing was written, and the counters are exactly where they were.
    assert [row.movement_type for row in _movements(article["id"])] == ["intake"]
    snapshot = client.get(
        f"/api/werkstatt/articles/{article['id']}", headers=auth_headers(admin_token)
    ).json()
    assert (snapshot["stock_total"], snapshot["stock_available"]) == (10, 10)


def test_the_movement_type_whitelist_refuses_everything_it_does_not_name(
    client: TestClient, admin_token: str, station_token: str
) -> None:
    """The ledger knows more movement types than a wall screen should be able
    to write. The rack screen books Ausgabe, Rückgabe and Wareneingang —
    ``correction``, ``repair_*`` and the ``inventory_*`` pair are write-offs,
    repair bookkeeping and stock-take corrections: decisions with a person and
    a typed reason behind them, not a scan."""
    article = _article(client, admin_token, "Makita DTD153", stock=4)
    head = auth_headers(station_token)

    for allowed in ("checkout", "return", "intake"):
        resp = client.post(
            f"{BASE}/movements",
            headers=head,
            json={"article_id": article["id"], "movement_type": allowed, "quantity": 1},
        )
        assert resp.status_code == 200, f"{allowed}: {resp.text}"

    for refused in (
        "inventory_plus",
        "inventory_minus",
        "correction",
        "repair_out",
        "repair_back",
        "",
        "drop table",
    ):
        resp = client.post(
            f"{BASE}/movements",
            headers=head,
            json={"article_id": article["id"], "movement_type": refused, "quantity": 1},
        )
        assert resp.status_code == 400, f"{refused}: {resp.text}"
        # German, because the only reader is a German workshop.
        assert "Buchungsart" in resp.json()["detail"], resp.text


def test_a_station_movement_can_name_who_received_the_tool(
    client: TestClient, admin_token: str, station_token: str
) -> None:
    """``user_id`` is who booked it (the station's owner); ``assignee_user_id``
    is who walked off with it. Conflating the two is how a tool becomes
    unfindable."""
    monteur = _make_user(client, admin_token, "monteur@example.com", "employee")
    article = _article(client, admin_token, "Hilti TE 2", stock=2)

    booked = client.post(
        f"{BASE}/movements",
        headers=auth_headers(station_token),
        json={
            "article_id": article["id"],
            "movement_type": "checkout",
            "quantity": 1,
            "assignee_user_id": monteur["id"],
        },
    )
    assert booked.status_code == 200, booked.text
    row = _movements(article["id"])[-1]
    assert row.assignee_user_id == monteur["id"]
    assert row.user_id == _user_id("admin@example.com")


# --------------------------------------------------------------------------
# a Rückgabe that nobody put a name on
# --------------------------------------------------------------------------


def _project(client: TestClient, admin_token: str, number: str, name: str) -> int:
    created = client.post(
        "/api/projects",
        headers=auth_headers(admin_token),
        json={"project_number": number, "name": name},
    )
    assert created.status_code == 200, created.text
    return created.json()["id"]


def _my_checkouts(client: TestClient, token: str) -> list[dict]:
    resp = client.get("/api/werkstatt/mobile/my-checkouts", headers=auth_headers(token))
    assert resp.status_code == 200, resp.text
    return resp.json()


def test_a_nameless_return_closes_the_loan_it_can_only_have_been(
    client: TestClient, admin_token: str, station_token: str
) -> None:
    """A tool handed back at the rack must leave the borrower's list.

    Nobody taps a name to give something back — the crate is in your hands and
    the screen's Rückgabe button is one press. But every station row is booked
    as the station's *owner*, so a return with no assignee was charged to that
    administrator, while ``list_my_checkouts`` — which reads a row as mine when
    it names me, or when it names nobody and I booked it — went on showing the
    monteur holding a drill that is back on the shelf. Forever: there is no
    later event that would ever clear it.
    """
    monteur = _make_user(client, admin_token, "rueckgabe@example.com", "employee")
    monteur_token = _login(client, monteur["email"])
    article = _article(client, admin_token, "Bosch GBH 2-28", stock=3)
    head = auth_headers(station_token)

    booked = client.post(
        f"{BASE}/movements",
        headers=head,
        json={
            "article_id": article["id"],
            "movement_type": "checkout",
            "quantity": 1,
            "assignee_user_id": monteur["id"],
        },
    )
    assert booked.status_code == 200, booked.text
    assert [row["quantity_out"] for row in _my_checkouts(client, monteur_token)] == [1]

    returned = client.post(
        f"{BASE}/movements",
        headers=head,
        json={"article_id": article["id"], "movement_type": "return", "quantity": 1},
    )
    assert returned.status_code == 200, returned.text

    row = _movements(article["id"])[-1]
    assert row.movement_type == "return"
    assert row.assignee_user_id == monteur["id"], "the return was charged to the station's owner"
    # ``user_id`` is untouched: who *booked* it really is the station's owner.
    assert row.user_id == _user_id("admin@example.com")
    assert row.station_id is not None
    # …and the ledger's own reader agrees the loan is closed.
    assert _my_checkouts(client, monteur_token) == []


def test_a_nameless_return_carries_the_project_of_the_loan_it_closes(
    client: TestClient, admin_token: str, station_token: str
) -> None:
    """The assignee alone does not close a loan that was booked to a project.

    ``list_my_checkouts`` groups by ``(article, project)``, so a return filed
    against the same article with no project balances a *different* group and
    leaves the project's row standing. The resolved loan therefore hands over
    both halves of its identity, not just the name.
    """
    monteur = _make_user(client, admin_token, "projektler@example.com", "employee")
    monteur_token = _login(client, monteur["email"])
    project_id = _project(client, admin_token, "2026-RG-1", "Rückgabe Projekt")
    article = _article(client, admin_token, "Makita Akkuschrauber", stock=2)

    taken = client.post(
        "/api/werkstatt/mobile/checkout",
        headers=auth_headers(monteur_token),
        json={"article_id": article["id"], "quantity": 1, "project_id": project_id},
    )
    assert taken.status_code == 200, taken.text
    assert [row["quantity_out"] for row in _my_checkouts(client, monteur_token)] == [1]

    returned = client.post(
        f"{BASE}/movements",
        headers=auth_headers(station_token),
        json={"article_id": article["id"], "movement_type": "return", "quantity": 1},
    )
    assert returned.status_code == 200, returned.text

    row = _movements(article["id"])[-1]
    assert row.assignee_user_id == monteur["id"]
    assert row.project_id == project_id
    assert _my_checkouts(client, monteur_token) == []


def test_a_tapped_name_still_wins_over_the_resolved_loan(
    client: TestClient, admin_token: str, station_token: str
) -> None:
    """Resolving is what happens when nobody said. It never overrides somebody
    who did: a colleague may well bring back a tool that is not on their own
    list, and the screen's name grid is the only way to say so."""
    borrower = _make_user(client, admin_token, "leiht@example.com", "employee")
    bringer = _make_user(client, admin_token, "bringt@example.com", "employee")
    borrower_token = _login(client, borrower["email"])
    article = _article(client, admin_token, "Knipex Seitenschneider", stock=2)
    head = auth_headers(station_token)

    client.post(
        f"{BASE}/movements",
        headers=head,
        json={
            "article_id": article["id"],
            "movement_type": "checkout",
            "quantity": 1,
            "assignee_user_id": borrower["id"],
        },
    )

    returned = client.post(
        f"{BASE}/movements",
        headers=head,
        json={
            "article_id": article["id"],
            "movement_type": "return",
            "quantity": 1,
            "assignee_user_id": bringer["id"],
        },
    )
    assert returned.status_code == 200, returned.text

    row = _movements(article["id"])[-1]
    assert row.assignee_user_id == bringer["id"]
    # The borrower's own row is untouched — the ledger records what was said.
    assert [r["quantity_out"] for r in _my_checkouts(client, borrower_token)] == [1]


def test_a_nameless_return_with_no_open_loan_books_as_it_always_did(
    client: TestClient, admin_token: str, station_token: str
) -> None:
    """The fallback: no loan to find, so no name is invented.

    Reaching it takes a contrived ledger. Every borrower's balance sums to
    exactly ``stock_out``, so a positive ``stock_out`` guarantees somebody is
    open — and ``stock_out`` (the snapshot) is what ``apply_movement``
    fast-fails a return against. The only way past both is a snapshot that
    disagrees with the ledger, which is precisely the state this branch has to
    survive: book the return as before, with nobody's name on it.
    """
    article = _article(client, admin_token, "Fein Multimaster", stock=1)
    with SessionLocal() as db:
        row = db.get(WerkstattArticle, article["id"])
        row.stock_out = 1
        db.add(row)
        db.commit()

    returned = client.post(
        f"{BASE}/movements",
        headers=auth_headers(station_token),
        json={"article_id": article["id"], "movement_type": "return", "quantity": 1},
    )
    assert returned.status_code == 200, returned.text

    row = _movements(article["id"])[-1]
    assert row.movement_type == "return"
    assert row.assignee_user_id is None
    assert row.project_id is None
    assert row.user_id == _user_id("admin@example.com")


def test_an_unknown_or_archived_article_is_refused(
    client: TestClient, admin_token: str, station_token: str
) -> None:
    head = auth_headers(station_token)
    missing = client.post(
        f"{BASE}/movements",
        headers=head,
        json={"article_id": 987654, "movement_type": "intake", "quantity": 1},
    )
    assert missing.status_code == 404, missing.text

    article = _article(client, admin_token, "Alt-Werkzeug", stock=1)
    archived = client.patch(
        f"/api/werkstatt/articles/{article['id']}",
        headers=auth_headers(admin_token),
        json={"is_archived": True},
    )
    assert archived.status_code == 200, archived.text
    refused = client.post(
        f"{BASE}/movements",
        headers=head,
        json={"article_id": article["id"], "movement_type": "checkout", "quantity": 1},
    )
    assert refused.status_code == 400, refused.text


def test_a_checkout_beyond_stock_is_refused_by_the_shared_ledger_rules(
    client: TestClient, admin_token: str, station_token: str
) -> None:
    article = _article(client, admin_token, "Leiter 3m", stock=1)
    refused = client.post(
        f"{BASE}/movements",
        headers=auth_headers(station_token),
        json={"article_id": article["id"], "movement_type": "checkout", "quantity": 5},
    )
    assert refused.status_code == 400, refused.text
    assert _movements(article["id"])[-1].movement_type == "intake", "nothing was written"


def test_a_station_booking_is_marked_as_one_in_the_ledger(
    client: TestClient, admin_token: str, station_token: str
) -> None:
    """A device's rows must be tellable from a person's, in the data.

    ``user_id`` is a real administrator on both — it has to be, the column is
    NOT NULL and a wall screen has nobody standing at it — so without a column
    of its own a station booking is indistinguishable from that admin sitting
    at their desk booking it. ``station_id`` is that column; the note is the
    human-readable half of the same fact.
    """
    article = _article(client, admin_token, "Rothenberger", stock=3)
    booked = client.post(
        f"{BASE}/movements",
        headers=auth_headers(station_token),
        json={"article_id": article["id"], "movement_type": "checkout", "quantity": 1},
    )
    assert booked.status_code == 200, booked.text

    with SessionLocal() as db:
        station = db.scalars(select(Station)).first()
        station_id, station_name = station.id, station.name

    row = _movements(article["id"])[-1]
    assert row.station_id == station_id
    assert row.notes == f"Regal-Station {station_name}"
    assert row.user_id == _user_id("admin@example.com")


def test_a_caller_supplied_note_cannot_erase_the_station_marker(
    client: TestClient, admin_token: str, station_token: str
) -> None:
    """``notes`` is fully caller-supplied, and the caller is a box on a wall
    that anybody in the workshop can reach. It used to *replace* the marker, so
    a note reading "Korrektur durch Chef" was all it took to make a device's
    row read like a person's. It is a prefix now."""
    article = _article(client, admin_token, "Knipex Cobra", stock=3)
    booked = client.post(
        f"{BASE}/movements",
        headers=auth_headers(station_token),
        json={
            "article_id": article["id"],
            "movement_type": "checkout",
            "quantity": 1,
            "notes": "Korrektur durch Chef",
        },
    )
    assert booked.status_code == 200, booked.text

    row = _movements(article["id"])[-1]
    assert row.notes == "Regal-Station Werkstatt Pi — Korrektur durch Chef"
    assert row.notes.startswith("Regal-Station Werkstatt Pi")
    assert row.station_id is not None


def test_a_user_booked_movement_carries_no_station(
    client: TestClient, admin_token: str, station_token: str
) -> None:
    """The other half of the property: the new column is not just always set.

    A checkout made by a logged-in person through the mobile endpoint has no
    station behind it, so the column stays NULL — which is what makes
    ``station_id IS NOT NULL`` a usable filter for "booked at the wall".
    """
    _ = station_token  # a station exists; this booking still is not one
    article = _article(client, admin_token, "Fluke T6", stock=4)
    booked = client.post(
        "/api/werkstatt/mobile/checkout",
        headers=auth_headers(admin_token),
        json={"article_id": article["id"], "quantity": 1},
    )
    assert booked.status_code == 200, booked.text

    rows = _movements(article["id"])
    assert [row.movement_type for row in rows] == ["intake", "checkout"]
    assert all(row.station_id is None for row in rows)


def test_a_station_quantity_is_bounded_rather_than_crashing_the_request(
    client: TestClient, admin_token: str, station_token: str
) -> None:
    """An unbounded ``quantity`` escaped the ledger's own guards.

    ``intake`` has nothing to fast-fail against, so a value wider than a 64-bit
    column reached ``db.flush()`` and came back as OverflowError/DataError —
    past the ``except MovementError`` handler, with no rollback, as an
    unhandled 500. The bound is on the wire now, so it is a 422 before any
    session work happens at all.
    """
    article = _article(client, admin_token, "Fischer Dübel", stock=0)
    head = auth_headers(station_token)

    ok = client.post(
        f"{BASE}/movements",
        headers=head,
        json={"article_id": article["id"], "movement_type": "intake", "quantity": 10_000},
    )
    assert ok.status_code == 200, ok.text
    assert ok.json()["article"]["stock_total"] == 10_000

    for over in (10_001, 10**20):
        refused = client.post(
            f"{BASE}/movements",
            headers=head,
            json={"article_id": article["id"], "movement_type": "intake", "quantity": over},
        )
        assert refused.status_code == 422, f"{over}: {refused.status_code} {refused.text}"

    # …and the ledger holds only the booking that was meant to happen.
    assert [row.quantity for row in _movements(article["id"])] == [10_000]


def test_a_station_box_quantity_is_bounded_on_both_directions(
    client: TestClient, admin_token: str, station_token: str
) -> None:
    """Same unbounded-integer hole on the box screen's two bodies."""
    article = _article(client, admin_token, "Wago 221-415", stock=20)
    box = _box(client, admin_token, "Kiste Mengen")
    head = auth_headers(station_token)

    line = client.post(
        f"{BASE}/boxes/{box['id']}/items",
        headers=head,
        json={"article_id": article["id"], "quantity": 10_000},
    )
    assert line.status_code == 200, line.text
    assert line.json()["quantity"] == 10_000

    for over in (10_001, 10**20):
        packed = client.post(
            f"{BASE}/boxes/{box['id']}/items",
            headers=head,
            json={"article_id": article["id"], "quantity": over},
        )
        assert packed.status_code == 422, f"{over}: {packed.status_code} {packed.text}"
        removed = client.post(
            f"{BASE}/boxes/{box['id']}/items/remove",
            headers=head,
            json={"item_id": line.json()["id"], "quantity": over},
        )
        assert removed.status_code == 422, f"{over}: {removed.status_code} {removed.text}"

    still_there = client.get(
        f"/api/werkstatt/boxes/{box['id']}/items", headers=auth_headers(admin_token)
    ).json()
    assert [row["quantity"] for row in still_there] == [10_000]


def test_an_unknown_and_an_inactive_assignee_are_indistinguishable(
    client: TestClient, admin_token: str, station_token: str
) -> None:
    """The assignee field must not answer "does this user id exist?".

    A 404 for an unknown id and a different answer for a known-but-inactive one
    turns an unauthenticated-ish wall device into a user-id enumeration oracle:
    walk the integers, learn the shape of the staff list. Both are the same
    German 400 now, so a scan tells the prober nothing.
    """
    gone = _make_user(client, admin_token, "ausgeschieden@example.com", "employee")
    deleted = client.delete(
        f"/api/admin/users/{gone['id']}", headers=auth_headers(admin_token)
    )
    assert deleted.status_code == 200, deleted.text

    article = _article(client, admin_token, "Stanley Bandmaß", stock=5)
    head = auth_headers(station_token)

    def _book(assignee_id: int):
        return client.post(
            f"{BASE}/movements",
            headers=head,
            json={
                "article_id": article["id"],
                "movement_type": "checkout",
                "quantity": 1,
                "assignee_user_id": assignee_id,
            },
        )

    unknown = _book(987_654)
    inactive = _book(gone["id"])

    assert unknown.status_code == 400, unknown.text
    assert inactive.status_code == 400, inactive.text
    assert unknown.json() == inactive.json()
    assert "Empfänger" in unknown.json()["detail"]

    # Neither attempt wrote anything.
    assert [row.movement_type for row in _movements(article["id"])] == ["intake"]


def test_the_assignee_is_only_looked_at_after_the_type_and_the_article(
    client: TestClient, admin_token: str, station_token: str
) -> None:
    """Ordering is part of the fix: a bad assignee must never be the *first*
    thing the endpoint answers about, or the ordering alone leaks which ids
    exist."""
    head = auth_headers(station_token)
    article = _article(client, admin_token, "Gedore Ratsche", stock=2)

    bad_type = client.post(
        f"{BASE}/movements",
        headers=head,
        json={
            "article_id": article["id"],
            "movement_type": "correction",
            "quantity": 1,
            "assignee_user_id": 987_654,
        },
    )
    assert bad_type.status_code == 400
    assert "Buchungsart" in bad_type.json()["detail"]

    bad_article = client.post(
        f"{BASE}/movements",
        headers=head,
        json={
            "article_id": 987_654,
            "movement_type": "checkout",
            "quantity": 1,
            "assignee_user_id": 987_654,
        },
    )
    assert bad_article.status_code == 404
    assert "Artikel" in bad_article.json()["detail"]


def test_packing_zero_of_something_is_refused_at_the_station(
    client: TestClient, admin_token: str, station_token: str
) -> None:
    """``int(payload.quantity or 1)`` mapped 0 to 1 before the guard below it
    could see it, so a screen that sent 0 silently packed one unit."""
    article = _article(client, admin_token, "Dose tief", stock=10)
    box = _box(client, admin_token, "Kiste Null")

    refused = client.post(
        f"{BASE}/boxes/{box['id']}/items",
        headers=auth_headers(station_token),
        json={"article_id": article["id"], "quantity": 0},
    )
    assert refused.status_code == 422, refused.text
    assert (
        client.get(
            f"/api/werkstatt/boxes/{box['id']}/items", headers=auth_headers(admin_token)
        ).json()
        == []
    )


# --------------------------------------------------------------------------
# the crew list: who a tool can be handed to
# --------------------------------------------------------------------------


def test_the_crew_list_is_station_authenticated_and_names_active_people(
    client: TestClient, admin_token: str, station_token: str
) -> None:
    """A worker taps their name before taking a tool out, so the wall needs the
    staff list — the one thing the rack screen cannot derive from a barcode."""
    monteur = _make_user(client, admin_token, "monteur@example.com", "employee")
    gone = _make_user(client, admin_token, "weg@example.com", "employee")
    assert (
        client.delete(f"/api/admin/users/{gone['id']}", headers=auth_headers(admin_token)).status_code
        == 200
    )

    crew = client.get(f"{BASE}/crew", headers=auth_headers(station_token))
    assert crew.status_code == 200, crew.text
    body = crew.json()

    assert all(sorted(row.keys()) == ["id", "name"] for row in body), body
    assert monteur["id"] in {row["id"] for row in body}
    assert gone["id"] not in {row["id"] for row in body}
    assert all(row["name"] for row in body), "a nameless entry is untappable"


def test_the_crew_list_is_the_assignable_user_list(
    client: TestClient, admin_token: str, station_token: str
) -> None:
    """Same people, same order, one query. A second selection would drift: the
    wall would offer somebody the app does not, or hide somebody it does."""
    _make_user(client, admin_token, "anna@example.com", "employee")
    _make_user(client, admin_token, "bert@example.com", "planning")

    assignable = client.get("/api/users/assignable", headers=auth_headers(admin_token))
    assert assignable.status_code == 200, assignable.text
    crew = client.get(f"{BASE}/crew", headers=auth_headers(station_token))
    assert crew.status_code == 200, crew.text

    assert crew.json() == [
        {"id": row["id"], "name": row["display_name"]} for row in assignable.json()
    ]


def test_the_crew_list_refuses_a_user_token_and_no_token(
    client: TestClient, admin_token: str
) -> None:
    assert client.get(f"{BASE}/crew", headers=auth_headers(admin_token)).status_code == 401
    assert client.get(f"{BASE}/crew").status_code == 401


# --------------------------------------------------------------------------
# attribution: the three branches of "who does a device book as?"
# --------------------------------------------------------------------------


def test_a_station_books_as_the_admin_who_approved_its_pairing(
    client: TestClient, admin_token: str
) -> None:
    """Branch 1. Approving a pairing is the act of putting this device in the
    workshop, so the approver owns what it books — and they are findable, which
    is the entire point of a NOT NULL ``user_id``."""
    owner = _make_user(client, admin_token, "chef@example.com", "admin")
    token, _ = _pair(client, _login(client, "chef@example.com"))

    article = _article(client, admin_token, "Fein Multimaster", stock=2)
    booked = client.post(
        f"{BASE}/movements",
        headers=auth_headers(token),
        json={"article_id": article["id"], "movement_type": "checkout", "quantity": 1},
    )
    assert booked.status_code == 200, booked.text

    row = _movements(article["id"])[-1]
    assert row.user_id == owner["id"]
    # …and specifically NOT the fallback, which would be the seeded admin.
    assert row.user_id != _user_id("admin@example.com")


def test_a_station_whose_owner_is_gone_falls_back_to_the_lowest_id_admin(
    client: TestClient, admin_token: str
) -> None:
    """Branch 2. People leave; the Pi on the wall does not stop working when
    their account does. Lowest id is chosen because it is stable — it does not
    quietly move to somebody else between two deploys."""
    _make_user(client, admin_token, "chef@example.com", "admin")
    token, station = _pair(client, _login(client, "chef@example.com"))

    with SessionLocal() as db:
        row = db.get(Station, station["id"])
        row.created_by = None  # ON DELETE SET NULL, i.e. the account is gone
        db.add(row)
        db.commit()

    article = _article(client, admin_token, "Metabo KHE", stock=2)
    booked = client.post(
        f"{BASE}/movements",
        headers=auth_headers(token),
        json={"article_id": article["id"], "movement_type": "checkout", "quantity": 1},
    )
    assert booked.status_code == 200, booked.text
    assert _movements(article["id"])[-1].user_id == _user_id("admin@example.com")


def test_a_station_that_points_at_a_deleted_user_also_falls_back(
    client: TestClient, admin_token: str
) -> None:
    """Branch 2 again, by the other road: the column still holds an id, but
    nothing answers to it. A dangling FK must not become a 500."""
    token, station = _pair(client, admin_token)
    with SessionLocal() as db:
        row = db.get(Station, station["id"])
        row.created_by = 987654
        db.add(row)
        db.commit()

    article = _article(client, admin_token, "Dewalt DCD", stock=2)
    booked = client.post(
        f"{BASE}/movements",
        headers=auth_headers(token),
        json={"article_id": article["id"], "movement_type": "intake", "quantity": 1},
    )
    assert booked.status_code == 200, booked.text
    assert _movements(article["id"])[-1].user_id == _user_id("admin@example.com")


def test_a_station_with_no_owner_at_all_is_refused_rather_than_inventing_one(
    client: TestClient, admin_token: str, station_token: str
) -> None:
    """Branch 3. A ledger row naming the wrong person is worse than a booking
    that did not happen: the first is a lie you act on, the second is an error
    somebody fixes."""
    article = _article(client, admin_token, "Rems Cento", stock=3)

    with SessionLocal() as db:
        station = db.scalars(select(Station)).first()
        station.created_by = None
        db.add(station)
        for user in db.scalars(select(User)).all():
            user.role = "employee"
            db.add(user)
        db.commit()

    refused = client.post(
        f"{BASE}/movements",
        headers=auth_headers(station_token),
        json={"article_id": article["id"], "movement_type": "checkout", "quantity": 1},
    )
    assert refused.status_code == 409, refused.text
    assert "Station" in refused.json()["detail"]
    assert [row.movement_type for row in _movements(article["id"])] == ["intake"]


# --------------------------------------------------------------------------
# heartbeat — a regression pin for a field report
# --------------------------------------------------------------------------
#
# The Pi's agent reported "this SMPL server has no station heartbeat endpoint".
# That message is emitted by tools/label_agent/station_heartbeat.py only after
# BOTH of its candidate paths answer 404/405/501, so it is worth pinning what
# this server actually answers on each of them.


def test_the_heartbeat_route_is_exactly_what_the_agent_posts_to(
    client: TestClient, station_token: str
) -> None:
    beat = client.post(
        "/api/station/heartbeat",
        headers=auth_headers(station_token),
        json={"agent_version": "1.0.0", "printer_connected": True, "media_width_mm": 50.0},
    )
    assert beat.status_code == 200, beat.text
    assert beat.json()["station"]["agent_version"] == "1.0.0"

    # A GET — which is what urllib turns a POST into when it follows a 301/302
    # redirect — is a 405 here, and the agent treats 405 exactly like 404.
    assert client.get("/api/station/heartbeat", headers=auth_headers(station_token)).status_code == 405


def test_the_agents_fallback_ping_path_does_not_exist(
    client: TestClient, station_token: str
) -> None:
    """``/api/station/ping`` is the agent's second candidate. It is not a route
    here, so anything that makes the first candidate answer 404/405 lands the
    agent on the permanent "no heartbeat endpoint" verdict."""
    assert client.post("/api/station/ping", headers=auth_headers(station_token)).status_code == 404


# --------------------------------------------------------------------------
# Wareneingang for a code SMPL knows but the workshop does not stock yet
#
# The field report this pins: an operator scans a supplier EAN at the rack,
# the wholesaler's Datanorm row matches, and the rack screen answers "Code
# nicht zugeordnet — SMPL ist nicht erreichbar". The server was reachable the
# whole time; it had answered `catalog_match` in under 200 ms. What it could
# not answer was the only question that mattered — *which article* — because
# nobody had turned that catalogue row into one, and a station had no way to.
#
# The endpoint below closes that: the one moment you meet a product SMPL has
# never stocked is the moment it arrives, which is exactly when somebody is
# standing at the rack with it in their hand.
# --------------------------------------------------------------------------


def _catalog_item(
    *, ean: str | None, name: str = "HAGER ZU37KS - Einbausatz", article_no: str = "01408573"
) -> int:
    """One wholesaler Datanorm row, the shape `catalog_match` resolves to."""
    from app.models.materials import MaterialCatalogItem

    with SessionLocal() as db:
        item = MaterialCatalogItem(
            external_key=f"test-{ean or article_no}-{name}"[:128],
            source_file="test.datanorm",
            source_line=1,
            article_no=article_no,
            item_name=name,
            unit="ST",
            manufacturer="HAGER",
            ean=ean,
            price_text="328.20 EUR",
            search_text=f"{name} {ean or ''}",
        )
        db.add(item)
        db.commit()
        return item.id


def test_station_stocks_a_catalogue_hit_and_books_the_delivery(
    client: TestClient, admin_token: str, station_token: str
) -> None:
    """The whole point: scan an unknown EAN at Wareneingang, walk away stocked.

    The article must come out carrying the catalogue's identity (that is the
    reason to scan a wholesaler barcode at all rather than type a name), and
    the quantity must arrive as a real ledger row — not as a counter someone
    set, which the next recompute would erase.
    """
    item_id = _catalog_item(ean="3250617811163")

    created = client.post(
        f"{BASE}/articles/from-catalog",
        headers=auth_headers(station_token),
        json={"catalog_item_id": item_id, "quantity": 4},
    )
    assert created.status_code == 200, created.text
    body = created.json()

    assert body["created"] is True
    article = body["article"]
    assert article["item_name"] == "HAGER ZU37KS - Einbausatz"
    assert article["ean"] == "3250617811163"
    assert article["manufacturer"] == "HAGER"
    assert article["unit"] == "ST"
    # Stock is the ledger's answer, not the payload's.
    assert article["stock_total"] == 4
    assert article["stock_available"] == 4

    movements = _movements(article["id"])
    assert [m.movement_type for m in movements] == ["intake"]


def test_the_delivery_row_is_tellable_from_a_persons(
    client: TestClient, admin_token: str, station_token: str
) -> None:
    """A wall screen's row carries the station and a marker it cannot erase.

    Same rule the movement endpoint already keeps. It matters more here, not
    less: this row is the birth of an article, so "who decided this exists"
    has to survive in the ledger.
    """
    item_id = _catalog_item(ean="4011195656273", name="Gira 028600 Wippschalter")

    created = client.post(
        f"{BASE}/articles/from-catalog",
        headers=auth_headers(station_token),
        json={"catalog_item_id": item_id, "quantity": 2, "notes": "Palette 3"},
    )
    assert created.status_code == 200, created.text

    movement = _movements(created.json()["article"]["id"])[0]
    assert movement.station_id is not None
    assert movement.notes.startswith("Regal-Station ")
    assert "Palette 3" in movement.notes
    # A device is not a person; the row still names one.
    assert movement.user_id is not None


def test_a_second_delivery_tops_up_instead_of_refusing(
    client: TestClient, admin_token: str, station_token: str
) -> None:
    """The same EAN arriving twice is a delivery, not a mistake.

    The user-facing endpoint answers 400 "an article with this EAN already
    exists", which is right for a person filling in a form and wrong for a
    rack: the operator is holding a box of the thing. Refusing would put them
    back at the dead end this endpoint exists to remove, so the second scan
    books intake against the article the first one created.
    """
    item_id = _catalog_item(ean="4011195656274", name="Gira 028601 Wippschalter")
    head = auth_headers(station_token)
    body = {"catalog_item_id": item_id, "quantity": 3}

    first = client.post(f"{BASE}/articles/from-catalog", headers=head, json=body)
    assert first.status_code == 200, first.text
    assert first.json()["created"] is True

    second = client.post(f"{BASE}/articles/from-catalog", headers=head, json=body)
    assert second.status_code == 200, second.text
    assert second.json()["created"] is False

    assert first.json()["article"]["id"] == second.json()["article"]["id"]
    assert second.json()["article"]["stock_total"] == 6
    assert [m.movement_type for m in _movements(first.json()["article"]["id"])] == [
        "intake",
        "intake",
    ]


def test_a_catalogue_row_without_an_ean_still_stocks(
    client: TestClient, admin_token: str, station_token: str
) -> None:
    """No EAN is not an error — Datanorm rows carry one only ~90% of the time.

    Without this the dedupe lookup (``WHERE ean = NULL``) decides every
    eanless row is the same product as every other eanless row.
    """
    first_id = _catalog_item(ean=None, name="Sonderposten A", article_no="99001")
    second_id = _catalog_item(ean=None, name="Sonderposten B", article_no="99002")
    head = auth_headers(station_token)

    a = client.post(
        f"{BASE}/articles/from-catalog", headers=head, json={"catalog_item_id": first_id}
    )
    b = client.post(
        f"{BASE}/articles/from-catalog", headers=head, json={"catalog_item_id": second_id}
    )
    assert a.status_code == 200, a.text
    assert b.status_code == 200, b.text
    assert a.json()["created"] is True
    assert b.json()["created"] is True
    assert a.json()["article"]["id"] != b.json()["article"]["id"]
    assert a.json()["article"]["item_name"] == "Sonderposten A"
    assert b.json()["article"]["item_name"] == "Sonderposten B"


def test_an_unknown_catalogue_row_is_404(client: TestClient, station_token: str) -> None:
    resp = client.post(
        f"{BASE}/articles/from-catalog",
        headers=auth_headers(station_token),
        json={"catalog_item_id": 987654321, "quantity": 1},
    )
    assert resp.status_code == 404, resp.text


def test_a_user_token_cannot_use_the_station_intake(
    client: TestClient, admin_token: str
) -> None:
    """The boundary holds in both directions, as it does for every other route."""
    item_id = _catalog_item(ean="4011195656275", name="Gira 028602")
    resp = client.post(
        f"{BASE}/articles/from-catalog",
        headers=auth_headers(admin_token),
        json={"catalog_item_id": item_id, "quantity": 1},
    )
    assert resp.status_code in (401, 403), resp.text


def test_the_quantity_is_bounded(client: TestClient, station_token: str) -> None:
    """Same cap as a movement: intake has no counter to fast-fail against.

    An unbounded value used to reach db.flush() and come back as an unhandled
    500 — see STATION_MAX_QUANTITY. A birth row must not reopen that.
    """
    item_id = _catalog_item(ean="4011195656276", name="Gira 028603")
    head = auth_headers(station_token)
    for bad in (0, -1, 10_001):
        resp = client.post(
            f"{BASE}/articles/from-catalog",
            headers=head,
            json={"catalog_item_id": item_id, "quantity": bad},
        )
        assert resp.status_code == 422, f"quantity={bad} -> {resp.status_code}"


def test_a_revoked_station_cannot_stock_anything(
    client: TestClient, admin_token: str
) -> None:
    item_id = _catalog_item(ean="4011195656277", name="Gira 028604")
    token, station = _pair(client, admin_token)
    revoked = client.post(
        f"/api/station/stations/{station['id']}/revoke", headers=auth_headers(admin_token)
    )
    assert revoked.status_code == 200, revoked.text

    resp = client.post(
        f"{BASE}/articles/from-catalog",
        headers=auth_headers(token),
        json={"catalog_item_id": item_id, "quantity": 1},
    )
    assert resp.status_code == 401, resp.text


def test_a_delivery_onto_an_archived_article_is_refused_with_a_reason(
    client: TestClient, admin_token: str, station_token: str
) -> None:
    """Archived means "no longer stocked", so a top-up would silently revive it.

    Creating is not the answer either — the EAN is taken, so a new article
    would be a duplicate of the one somebody deliberately retired. The screen
    is told which article and what to do, because at a rack "refused" without
    a name is indistinguishable from the dead end this endpoint removed.
    """
    item_id = _catalog_item(ean="4011195656278", name="Altbestand Klemme")
    head = auth_headers(station_token)
    body = {"catalog_item_id": item_id, "quantity": 1}

    first = client.post(f"{BASE}/articles/from-catalog", headers=head, json=body)
    assert first.status_code == 200, first.text
    article_id = first.json()["article"]["id"]

    archived = client.patch(
        f"/api/werkstatt/articles/{article_id}",
        headers=auth_headers(admin_token),
        json={"is_archived": True},
    )
    assert archived.status_code == 200, archived.text

    refused = client.post(f"{BASE}/articles/from-catalog", headers=head, json=body)
    assert refused.status_code == 400, refused.text
    assert "Altbestand Klemme" in refused.json()["detail"]
    # And nothing was written: the ledger still holds only the first delivery.
    assert len(_movements(article_id)) == 1


# --------------------------------------------------------------------------
# Mitnehmen — the handover a person books at the wall
# --------------------------------------------------------------------------
#
# A crate standing "gepackt" in the workshop is taken by whoever walks past it,
# and that person is at the wall screen, not at a desk. The station may book it
# for the same reason it may already book a checkout: the movement it writes is
# a checkout, under the station owner's name, marked as a station row.


def _packed_box(client: TestClient, admin_token: str, label: str, article: dict, qty: int) -> dict:
    customer = client.post(
        "/api/customers", headers=auth_headers(admin_token), json={"name": f"Kunde {label}"}
    )
    assert customer.status_code == 200, customer.text
    box = _box(client, admin_token, label)
    added = client.post(
        f"/api/werkstatt/boxes/{box['id']}/items",
        headers=auth_headers(admin_token),
        json={"article_id": article["id"], "quantity": qty},
    )
    assert added.status_code == 200, added.text
    packed = client.post(
        f"/api/werkstatt/boxes/{box['id']}/pack",
        headers=auth_headers(admin_token),
        json={"customer_id": customer.json()["id"]},
    )
    assert packed.status_code == 200, packed.text
    return packed.json()


def test_the_wall_can_book_a_packed_crate_out(
    client: TestClient, admin_token: str, station_token: str
) -> None:
    article = _article(client, admin_token, "Gira 0212 00", stock=9)
    box = _packed_box(client, admin_token, "Kiste Mitnehmen", article, 4)

    taken = client.post(
        f"{BASE}/boxes/{box['id']}/handover",
        headers=auth_headers(station_token),
        json={},
    )
    assert taken.status_code == 200, taken.text
    body = taken.json()
    assert body["status"] == "zugewiesen"
    assert body["assigned_at"] is not None

    row = _movements(article["id"])[-1]
    assert (row.movement_type, row.quantity) == ("checkout", 4)
    assert row.construction_box_id == box["id"]
    assert row.station_id is not None
    assert row.notes.startswith("Regal-Station Werkstatt Pi")
    assert row.user_id == _user_id("admin@example.com")


def test_only_a_packed_crate_can_be_taken_at_the_wall(
    client: TestClient, admin_token: str, station_token: str
) -> None:
    article = _article(client, admin_token, "Busch-Jaeger 2000/6", stock=6)
    box = _box(client, admin_token, "Kiste Offen")
    client.post(
        f"/api/werkstatt/boxes/{box['id']}/items",
        headers=auth_headers(admin_token),
        json={"article_id": article["id"], "quantity": 2},
    )

    open_crate = client.post(
        f"{BASE}/boxes/{box['id']}/handover", headers=auth_headers(station_token), json={}
    )
    assert open_crate.status_code == 400
    assert "gepackt" in open_crate.json()["detail"]

    packed = _packed_box(client, admin_token, "Kiste Doppelt", article, 2)
    assert (
        client.post(
            f"{BASE}/boxes/{packed['id']}/handover",
            headers=auth_headers(station_token),
            json={},
        ).status_code
        == 200
    )
    again = client.post(
        f"{BASE}/boxes/{packed['id']}/handover", headers=auth_headers(station_token), json={}
    )
    assert again.status_code == 400
    # Booked exactly once.
    assert [row.movement_type for row in _movements(article["id"])] == ["intake", "checkout"]


def test_the_handover_endpoint_is_station_only(
    client: TestClient, admin_token: str, station_token: str
) -> None:
    article = _article(client, admin_token, "Hensel Mi", stock=3)
    box = _packed_box(client, admin_token, "Kiste Grenze", article, 1)
    _ = station_token
    refused = client.post(
        f"{BASE}/boxes/{box['id']}/handover", headers=auth_headers(admin_token), json={}
    )
    assert refused.status_code in (401, 403)


# --------------------------------------------------------------------------
# Wareneingang for a code no Datanorm describes — the rest of the dead end
# --------------------------------------------------------------------------
#
# `/articles/from-catalog` fixed the half of this that a wholesaler's file
# already describes. The other half is the box whose barcode is in nobody's
# import: the operator is holding it, the rack has a keyboard, and the old
# answer was "SMPL kennt diesen Code nicht" and a walk to the office.


def _fake_shop(monkeypatch, body: str | None, status: int = 200) -> list[str]:
    """Point the EAN cascade at a fake webshop and record what it fetched."""
    import httpx

    from app.core.config import get_settings
    from app.services.ean_lookup import http as ean_http

    settings = get_settings()
    monkeypatch.setattr(settings, "ean_lookup_unielektro_enabled", True, raising=False)
    monkeypatch.setattr(settings, "ean_lookup_provider", "", raising=False)
    monkeypatch.setattr(settings, "ean_lookup_timeout_seconds", 3.0, raising=False)

    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        seen.append(url)
        if "bing.com" in url:
            return httpx.Response(200, text="<rss></rss>")
        if body is None or status != 200:
            return httpx.Response(status or 404, text="nope")
        if "/search" in url or "/navigator" in url:
            # What the shop actually does with a barcode that matches one
            # product — and what the provider now requires, because a result
            # LISTING may no longer name an article.
            return httpx.Response(302, headers={"location": _SHOP_PRODUCT_URL})
        return httpx.Response(200, text=body, headers={"content-type": "text/html"})

    def build_client(budget):
        return httpx.Client(
            transport=httpx.MockTransport(handler),
            timeout=httpx.Timeout(2.0),
            follow_redirects=False,
        )

    monkeypatch.setattr(ean_http, "build_client", build_client)
    # The cascade imported the factory by value, so both names need replacing.
    monkeypatch.setattr("app.services.ean_lookup.cascade.build_client", build_client)
    allow = lambda url: url.startswith("https://")  # noqa: E731
    monkeypatch.setattr(ean_http, "is_public_http_url", allow)
    # The same guard runs on the URLs a hit KEEPS; it resolves hostnames for
    # real, which a test host may not be able to do.
    monkeypatch.setattr(
        "app.services.ean_lookup.unielektro_shop.is_public_http_url", allow, raising=False
    )
    monkeypatch.setattr("app.services.ean_lookup.base.is_public_http_url", allow, raising=False)
    return seen


_SHOP_PRODUCT_URL = "https://www.unielektro.de/artikel/wago-221-413"

_SHOP_PAGE = """
<html><head>
<script type="application/ld+json">
{"@type": "Product", "name": "WAGO 221-413 Verbindungsklemme", "gtin13": "4045454121006",
 "brand": {"name": "WAGO"}, "offers": {"@type": "Offer", "unitText": "Pak"}}
</script>
</head><body>ok</body></html>
"""


def test_station_stocks_a_webshop_hit_and_books_the_delivery(
    client: TestClient, admin_token: str, station_token: str, monkeypatch
) -> None:
    """The dead end closes: an unknown barcode becomes a real article.

    Not a placeholder called "Unbekannt (4045…)" — a row with the product's
    actual name, its manufacturer and its packing unit, plus a note saying
    where those words came from, because nobody ever goes back to fix a
    placeholder.
    """
    _fake_shop(monkeypatch, _SHOP_PAGE)

    created = client.post(
        f"{BASE}/articles/from-lookup",
        headers=auth_headers(station_token),
        json={"code": "4045454121006", "quantity": 6, "notes": "Palette 7"},
    )
    assert created.status_code == 200, created.text
    body = created.json()

    assert body["created"] is True
    assert body["origin"] == "external"
    assert body["source"] == "unielektro_shop"
    article = body["article"]
    assert article["item_name"] == "WAGO 221-413 Verbindungsklemme"
    assert article["manufacturer"] == "WAGO"
    assert article["unit"] == "Pak"
    assert article["ean"] == "4045454121006"
    assert article["image_source"] in (None, "external")
    # A wall screen may not create a machine type: units carry their own
    # labels and inspection dates, and nothing a webshop says justifies one.
    assert article["is_serialized"] is False
    # Stock is the ledger's answer, not the payload's.
    assert article["stock_total"] == 6

    movement = _movements(article["id"])[0]
    assert movement.movement_type == "intake"
    assert movement.station_id is not None
    assert movement.notes.startswith("Regal-Station ")
    assert "Palette 7" in movement.notes
    assert movement.user_id is not None


def test_a_second_delivery_of_a_looked_up_article_tops_up(
    client: TestClient, admin_token: str, station_token: str, monkeypatch
) -> None:
    """Same rule as from-catalog: the second box is a delivery, not a mistake."""
    _fake_shop(monkeypatch, _SHOP_PAGE)
    head = auth_headers(station_token)
    payload = {"code": "4045454121006", "quantity": 3}

    first = client.post(f"{BASE}/articles/from-lookup", headers=head, json=payload)
    assert first.status_code == 200, first.text
    second = client.post(f"{BASE}/articles/from-lookup", headers=head, json=payload)
    assert second.status_code == 200, second.text

    assert second.json()["created"] is False
    assert second.json()["origin"] == "existing"
    assert second.json()["article"]["id"] == first.json()["article"]["id"]
    assert second.json()["article"]["stock_total"] == 6


def test_the_catalogue_still_wins_over_the_webshop(
    client: TestClient, admin_token: str, station_token: str, monkeypatch
) -> None:
    """A supplier's own row carries their article number; a scrape does not."""
    seen = _fake_shop(monkeypatch, _SHOP_PAGE)
    _catalog_item(ean="4045454121006", name="WAGO 221-413 (Datanorm)", article_no="55512345")

    created = client.post(
        f"{BASE}/articles/from-lookup",
        headers=auth_headers(station_token),
        json={"code": "4045454121006", "quantity": 1},
    )
    assert created.status_code == 200, created.text
    assert created.json()["origin"] == "catalog"
    assert created.json()["article"]["item_name"] == "WAGO 221-413 (Datanorm)"
    assert seen == []


def test_an_unknown_code_asks_for_a_name_rather_than_inventing_one(
    client: TestClient, admin_token: str, station_token: str, monkeypatch
) -> None:
    """Nothing anywhere: refuse, in German, naming what to do instead."""
    _fake_shop(monkeypatch, None, status=404)

    refused = client.post(
        f"{BASE}/articles/from-lookup",
        headers=auth_headers(station_token),
        json={"code": "4045454121013", "quantity": 2},
    )
    assert refused.status_code == 404, refused.text
    detail = refused.json()["detail"]
    assert "Kein Artikel" in detail and "Bezeichnung" in detail


def test_a_typed_name_creates_a_proper_consumable(
    client: TestClient, admin_token: str, station_token: str, monkeypatch
) -> None:
    """The rack panel HAS a keyboard, so the last resort is a real article.

    A placeholder row called "Unbekannt (4045…)" would sit in the stock list
    forever; a name somebody typed while holding the box is a record.
    """
    _fake_shop(monkeypatch, None, status=404)

    created = client.post(
        f"{BASE}/articles/from-lookup",
        headers=auth_headers(station_token),
        json={
            "code": "4045454121013",
            "quantity": 5,
            "item_name": "Sonderklemme grau",
            "unit": "Stk",
        },
    )
    assert created.status_code == 200, created.text
    body = created.json()
    assert body["origin"] == "manual"
    assert body["created"] is True
    article = body["article"]
    assert article["item_name"] == "Sonderklemme grau"
    assert article["unit"] == "Stk"
    assert article["ean"] == "4045454121013"
    assert article["is_serialized"] is False
    assert article["stock_total"] == 5

    movement = _movements(article["id"])[0]
    assert movement.station_id is not None


def test_a_typed_name_never_overrides_what_smpl_already_knows(
    client: TestClient, admin_token: str, station_token: str, monkeypatch
) -> None:
    """An unattended screen must not be able to rename the shelf.

    The typed name is a last resort, not an override: if the cascade resolves,
    the resolved identity wins and the delivery is booked onto it.
    """
    _fake_shop(monkeypatch, _SHOP_PAGE)
    existing = _article(client, admin_token, "Verbindungsklemme (Bestand)")
    with SessionLocal() as db:
        row = db.get(WerkstattArticle, existing["id"])
        row.ean = "4045454121006"
        db.add(row)
        db.commit()

    created = client.post(
        f"{BASE}/articles/from-lookup",
        headers=auth_headers(station_token),
        json={"code": "4045454121006", "quantity": 1, "item_name": "Etwas ganz anderes"},
    )
    assert created.status_code == 200, created.text
    assert created.json()["article"]["item_name"] == "Verbindungsklemme (Bestand)"
    assert created.json()["origin"] == "existing"


def test_station_lookup_needs_a_station_token(
    client: TestClient, admin_token: str, station_token: str, monkeypatch
) -> None:
    """A station is not a user, and the reverse stays true."""
    _fake_shop(monkeypatch, None, status=404)
    as_user = client.get(
        f"{BASE}/lookup", params={"code": "4045454121006"}, headers=auth_headers(admin_token)
    )
    assert as_user.status_code in (401, 403), as_user.text

    as_station = client.get(
        f"{BASE}/lookup", params={"code": "SP-0001"}, headers=auth_headers(station_token)
    )
    assert as_station.status_code == 200, as_station.text
    assert as_station.json()["kind"] in {"existing", "catalog", "external", "none"}


def test_a_catalogue_row_whose_ean_is_already_stocked_tops_up_instead_of_500(
    client: TestClient, admin_token: str, station_token: str, monkeypatch
) -> None:
    """The rack scanned the wholesaler's own article number on the box.

    Nothing holds that number as an EAN or an internal code, so the cascade
    falls through to the catalogue — whose row carries an EAN another article
    already has. ``build_article_from_catalog_item`` leaves the uniqueness
    question to its caller by design, and this caller was not asking it: the
    partial-unique index rejected the INSERT, the IntegrityError escaped, and
    the wall answered "Nicht angelegt — SMPL antwortete mit HTTP 500" for a
    delivery standing in front of somebody. A repeat is a top-up.
    """
    _fake_shop(monkeypatch, None, status=404)
    existing = client.post(
        "/api/werkstatt/articles",
        headers=auth_headers(admin_token),
        json={"item_name": "Hager Einbausatz", "ean": "4045454121006", "unit": "Stk"},
    )
    assert existing.status_code == 200, existing.text
    _catalog_item(ean="4045454121006", name="HAGER ZU37KS", article_no="01408573")

    booked = client.post(
        f"{BASE}/articles/from-lookup",
        headers=auth_headers(station_token),
        json={"code": "01408573", "quantity": 4},
    )
    assert booked.status_code == 200, booked.text
    assert booked.json()["created"] is False
    assert booked.json()["origin"] == "existing"
    assert booked.json()["article"]["id"] == existing.json()["id"]
    assert booked.json()["article"]["stock_total"] == 4


def test_an_archived_article_blocks_the_catalogue_branch_in_german(
    client: TestClient, admin_token: str, station_token: str, monkeypatch
) -> None:
    """Booking onto an archived row would hide the delivery from the list."""
    _fake_shop(monkeypatch, None, status=404)
    existing = client.post(
        "/api/werkstatt/articles",
        headers=auth_headers(admin_token),
        json={"item_name": "Alter Einbausatz", "ean": "4045454121006"},
    ).json()
    client.delete(
        f"/api/werkstatt/articles/{existing['id']}", headers=auth_headers(admin_token)
    )
    _catalog_item(ean="4045454121006", name="HAGER ZU37KS", article_no="01408573")

    refused = client.post(
        f"{BASE}/articles/from-lookup",
        headers=auth_headers(station_token),
        json={"code": "01408573", "quantity": 4},
    )
    assert refused.status_code == 400
    assert "archiviert" in refused.json()["detail"]


def test_a_retry_carrying_the_same_token_replays_instead_of_booking_twice(
    client: TestClient, admin_token: str, station_token: str, monkeypatch
) -> None:
    """The failure this closes is a shelf holding 3 while SMPL says 6.

    This endpoint may spend several seconds asking the outside world, which is
    long enough for the Pi's own HTTP timeout to fire while the server goes on
    to create the article and commit the intake. The wall then says "nicht
    angelegt" for a delivery that WAS booked, and the operator — holding the
    box in front of a screen that says it failed — scans again.
    """
    _fake_shop(monkeypatch, _SHOP_PAGE)
    head = auth_headers(station_token)
    payload = {"code": "4045454121006", "quantity": 3, "request_id": "scan-0f1e2d3c4b5a"}

    first = client.post(f"{BASE}/articles/from-lookup", headers=head, json=payload)
    assert first.status_code == 200, first.text
    assert first.json()["created"] is True

    second = client.post(f"{BASE}/articles/from-lookup", headers=head, json=payload)
    assert second.status_code == 200, second.text
    assert second.json()["article"]["id"] == first.json()["article"]["id"]
    assert second.json()["movement_id"] == first.json()["movement_id"]
    # Nothing was created and nothing was booked: this attempt already ran.
    assert second.json()["created"] is False
    assert second.json()["article"]["stock_total"] == 3
    assert len(_movements(first.json()["article"]["id"])) == 1


def test_a_deliberate_second_delivery_still_books_with_a_new_token(
    client: TestClient, admin_token: str, station_token: str, monkeypatch
) -> None:
    """The guard is per ATTEMPT, not per code — two pallets are two intakes."""
    _fake_shop(monkeypatch, _SHOP_PAGE)
    head = auth_headers(station_token)

    first = client.post(
        f"{BASE}/articles/from-lookup",
        headers=head,
        json={"code": "4045454121006", "quantity": 3, "request_id": "scan-aaaaaaaaaaaa"},
    )
    assert first.status_code == 200, first.text
    second = client.post(
        f"{BASE}/articles/from-lookup",
        headers=head,
        json={"code": "4045454121006", "quantity": 3, "request_id": "scan-bbbbbbbbbbbb"},
    )
    assert second.status_code == 200, second.text
    assert second.json()["article"]["stock_total"] == 6
    assert len(_movements(first.json()["article"]["id"])) == 2


def test_from_lookup_is_closed_to_users(
    client: TestClient, admin_token: str, station_token: str
) -> None:
    refused = client.post(
        f"{BASE}/articles/from-lookup",
        headers=auth_headers(admin_token),
        json={"code": "4045454121006", "quantity": 1},
    )
    assert refused.status_code in (401, 403), refused.text
