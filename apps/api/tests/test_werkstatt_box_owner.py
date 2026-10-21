"""Who a construction box (Baustellenkiste) belongs to, and when it belongs to nobody.

One sentence is pinned from every side here: a crate that is ``offen`` stands
on the rack and is nobody's — no customer, no project. Every way back to
``offen`` frees it, a new crate is born free, and a project can only ever be
one of the crate's own customer's.

Production showed what happens otherwise. K7 and BK-2026-0001 came back from
site, were re-opened and emptied, and kept their last customer: every other
customer's task form hid them as "somebody else's crate", and the customers
they still named saw them as current boxes on their page. Migration 0102
repairs those rows; these tests keep new ones from appearing.

Kept apart from tests/test_werkstatt_boxes.py, which covers the FSM and the
stock semantics and is long enough already.
"""
from __future__ import annotations

from fastapi.testclient import TestClient


def auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _customer(client: TestClient, admin_token: str, name: str) -> int:
    resp = client.post("/api/customers", headers=auth_headers(admin_token), json={"name": name})
    assert resp.status_code == 200, resp.text
    return resp.json()["id"]


def _project(client: TestClient, admin_token: str, number: str, customer_id: int) -> int:
    resp = client.post(
        "/api/projects",
        headers=auth_headers(admin_token),
        json={
            "project_number": number,
            "name": f"Projekt {number}",
            "status": "active",
            "customer_id": customer_id,
        },
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["id"]


def _box(client: TestClient, admin_token: str, label: str) -> dict:
    resp = client.post(
        "/api/werkstatt/boxes", headers=auth_headers(admin_token), json={"label": label}
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def _put_in(client: TestClient, admin_token: str, box_id: int, name: str = "Leitung") -> None:
    resp = client.post(
        f"/api/werkstatt/boxes/{box_id}/items",
        headers=auth_headers(admin_token),
        json={"item_name": name, "quantity": 1},
    )
    assert resp.status_code == 200, resp.text


def _pack(client: TestClient, admin_token: str, box_id: int, customer_id: int, **extra):
    return client.post(
        f"/api/werkstatt/boxes/{box_id}/pack",
        headers=auth_headers(admin_token),
        json={"customer_id": customer_id, **extra},
    )


def _status(client: TestClient, admin_token: str, box_id: int, status: str):
    return client.post(
        f"/api/werkstatt/boxes/{box_id}/status",
        headers=auth_headers(admin_token),
        json={"status": status},
    )


def _patch(client: TestClient, admin_token: str, box_id: int, body: dict):
    return client.patch(
        f"/api/werkstatt/boxes/{box_id}", headers=auth_headers(admin_token), json=body
    )


def _leave_stale_owner(box_id: int, *, customer_id: int, project_id: int | None) -> None:
    """Put a crate into the shape the old re-open edge left behind: ``offen``
    with an owner. No endpoint can produce it any more, which is the point —
    but production still held two such rows until migration 0102, and the
    guards have to hold for them as well."""
    from app.core.db import SessionLocal
    from app.models.entities import WerkstattConstructionBox

    with SessionLocal() as db:
        row = db.get(WerkstattConstructionBox, box_id)
        assert row.status == "offen"
        row.customer_id = customer_id
        row.project_id = project_id
        db.commit()


def test_reopening_a_returned_crate_frees_it(client: TestClient, admin_token: str):
    """``zugewiesen → zurueck → offen`` ("Kiste zurückbuchen", then "Erneut
    öffnen") used to keep the customer and the project — only ``gepackt →
    offen`` cleared them. The crate was back on the rack and still nobody
    else's to take."""
    old = _customer(client, admin_token, "Kunde Vorher")
    other = _customer(client, admin_token, "Kunde Nachher")
    project = _project(client, admin_token, "2026-5101", old)
    box = _box(client, admin_token, "Kiste Rückkehr")
    _put_in(client, admin_token, box["id"])
    assert _pack(client, admin_token, box["id"], old, project_id=project).status_code == 200

    for status in ("zugewiesen", "zurueck", "offen"):
        resp = _status(client, admin_token, box["id"], status)
        assert resp.status_code == 200, f"{status}: {resp.text}"
    body = resp.json()
    assert body["status"] == "offen"
    assert body["customer_id"] is None and body["customer_name"] is None
    assert body["project_id"] is None and body["project_name"] is None
    # Ownership goes, the contents stay — the same as "Zuweisung aufheben".
    assert body["item_count"] == 1

    # Back on the rack means free for the next customer's task form …
    offered = client.get(
        f"/api/werkstatt/boxes/selectable?customer_id={other}",
        headers=auth_headers(admin_token),
    )
    assert offered.status_code == 200, offered.text
    by_id = {row["id"]: row for row in offered.json()}
    assert box["id"] in by_id, "a re-opened crate must be offered to the next customer"
    assert by_id[box["id"]]["group"] == "free"

    # … and no longer one of the old customer's current boxes.
    current = client.get(f"/api/customers/{old}/boxes", headers=auth_headers(admin_token))
    assert current.status_code == 200, current.text
    assert box["id"] not in {row["id"] for row in current.json()}


def test_create_box_refuses_owner_fields(client: TestClient, admin_token: str):
    """A new crate is ``offen``, and an open crate is nobody's.

    The fields were accepted — the customer checked for existence, the
    project not at all — and wrote exactly the shape the re-open edge was
    fixed not to leave behind. No client sends them: the owner is chosen when
    the crate is packed, which checks the pair.
    """
    customer_id = _customer(client, admin_token, "Kunde Neuanlage")
    project_id = _project(client, admin_token, "2026-5102", customer_id)
    listing = client.get("/api/werkstatt/boxes", headers=auth_headers(admin_token))
    before = {row["id"] for row in listing.json()}

    for owner in (
        {"customer_id": customer_id},
        {"project_id": project_id},
        {"customer_id": customer_id, "project_id": project_id},
    ):
        refused = client.post(
            "/api/werkstatt/boxes",
            headers=auth_headers(admin_token),
            json={"label": "Kiste mit Besitzer", **owner},
        )
        assert refused.status_code == 400, f"{owner}: {refused.text}"
        assert "Packen" in refused.json()["detail"]

    after = client.get("/api/werkstatt/boxes", headers=auth_headers(admin_token)).json()
    assert {row["id"] for row in after} == before, "a refused create leaves no crate behind"

    # Saying "nobody" out loud is the rule itself, not a breach of it.
    explicit_none = client.post(
        "/api/werkstatt/boxes",
        headers=auth_headers(admin_token),
        json={"label": "Kiste ohne Besitzer", "customer_id": None, "project_id": None},
    )
    assert explicit_none.status_code == 200, explicit_none.text
    assert explicit_none.json()["customer_id"] is None
    assert explicit_none.json()["project_id"] is None


def test_pack_for_another_customer_without_project_clears_old_project(
    client: TestClient, admin_token: str
):
    """Packing wrote the new customer and kept whatever project was there when
    none was sent — a site of the previous customer, under the new one's
    name. The handover tags its checkout movements with that project, so the
    goods would have been booked onto somebody else's site."""
    previous = _customer(client, admin_token, "Kunde Früher")
    current = _customer(client, admin_token, "Kunde Jetzt")
    previous_project = _project(client, admin_token, "2026-5103", previous)
    box = _box(client, admin_token, "Kiste Wechsel")
    _put_in(client, admin_token, box["id"])
    _leave_stale_owner(box["id"], customer_id=previous, project_id=previous_project)

    packed = _pack(client, admin_token, box["id"], current)
    assert packed.status_code == 200, packed.text
    body = packed.json()
    assert body["customer_id"] == current
    assert body["project_id"] is None, "the old customer's site must not follow the crate"


def test_repacking_for_the_same_customer_without_a_project_keeps_it(
    client: TestClient, admin_token: str
):
    """The other half of the rule above: only a change of customer drops the
    project. Re-packing for the same customer without naming one is "nothing
    new about the site", not "no site"."""
    customer_id = _customer(client, admin_token, "Kunde Bleibt")
    project_id = _project(client, admin_token, "2026-5104", customer_id)
    box = _box(client, admin_token, "Kiste Bleibt")
    _put_in(client, admin_token, box["id"])
    assert _pack(client, admin_token, box["id"], customer_id, project_id=project_id).status_code == 200

    again = _pack(client, admin_token, box["id"], customer_id)
    assert again.status_code == 200, again.text
    assert again.json()["project_id"] == project_id


def test_patch_box_project_must_belong_to_box_customer(client: TestClient, admin_token: str):
    """``PATCH /boxes/{id}`` wrote ``project_id`` unchecked: onto an open crate
    that has no customer, to another customer's project, or to an id that does
    not exist (an FK error, i.e. a 500, on PostgreSQL). It is held to the
    rule ``/pack`` already applies."""
    owner = _customer(client, admin_token, "Kunde Baustelle")
    stranger = _customer(client, admin_token, "Kunde Fremdbaustelle")
    own_project = _project(client, admin_token, "2026-5105", owner)
    foreign_project = _project(client, admin_token, "2026-5106", stranger)
    box = _box(client, admin_token, "Kiste Baustelle")

    # Open and nobody's: no site either.
    no_customer = _patch(client, admin_token, box["id"], {"project_id": own_project})
    assert no_customer.status_code == 400, no_customer.text
    assert "Kunde" in no_customer.json()["detail"]
    # Fields that say nothing about the owner stay editable on an open crate.
    renamed = _patch(client, admin_token, box["id"], {"label": "Kiste Baustelle neu"})
    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["project_id"] is None

    _put_in(client, admin_token, box["id"])
    assert _pack(client, admin_token, box["id"], owner).status_code == 200

    foreign = _patch(client, admin_token, box["id"], {"project_id": foreign_project})
    assert foreign.status_code == 400, foreign.text
    assert foreign.json()["detail"] == "Das Projekt gehört nicht zum gewählten Kunden."

    unknown = _patch(client, admin_token, box["id"], {"project_id": 999_999})
    assert unknown.status_code == 400, unknown.text

    state = client.get(f"/api/werkstatt/boxes/{box['id']}", headers=auth_headers(admin_token))
    assert state.json()["project_id"] is None, "a refused PATCH writes nothing"

    matching = _patch(client, admin_token, box["id"], {"project_id": own_project})
    assert matching.status_code == 200, matching.text
    assert matching.json()["project_id"] == own_project
    assert matching.json()["project_name"] == "Projekt 2026-5105"

    # Taking the site off again is always allowed.
    cleared = _patch(client, admin_token, box["id"], {"project_id": None})
    assert cleared.status_code == 200, cleared.text
    assert cleared.json()["project_id"] is None
    assert cleared.json()["customer_id"] == owner


def _project_without_customer(client: TestClient, admin_token: str, number: str) -> int:
    resp = client.post(
        "/api/projects",
        headers=auth_headers(admin_token),
        json={"project_number": number, "name": f"Projekt {number} ohne Kunde", "status": "active"},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["customer_id"] is None
    return resp.json()["id"]


def test_patch_refuses_a_project_without_a_customer(client: TestClient, admin_token: str):
    """``PATCH`` sets a site only when the project belongs to the crate's
    customer, and a project with no customer at all belongs to nobody. Such
    projects exist (a deleted customer leaves them, a project saved without
    any customer data has none), and taking one onto a packed crate would book
    the handover onto a site that is not this customer's."""
    owner = _customer(client, admin_token, "Kunde Eigen")
    orphan_id = _project_without_customer(client, admin_token, "2026-5107")
    box = _box(client, admin_token, "Kiste Eigen")
    _put_in(client, admin_token, box["id"])
    assert _pack(client, admin_token, box["id"], owner).status_code == 200

    refused = _patch(client, admin_token, box["id"], {"project_id": orphan_id})

    assert refused.status_code == 400, refused.text
    assert refused.json()["detail"] == "Das Projekt gehört nicht zum gewählten Kunden."
    state = client.get(f"/api/werkstatt/boxes/{box['id']}", headers=auth_headers(admin_token))
    assert state.json()["project_id"] is None


def test_pack_still_accepts_a_project_without_a_customer(client: TestClient, admin_token: str):
    """The other side of the rule above, kept on purpose: packing has always
    taken a customer-less project for any customer, so such a job's crates are
    not left without a site. Only ``PATCH`` — moving a site onto a crate that
    is already somebody's — demands the project name that customer."""
    owner = _customer(client, admin_token, "Kunde Packen")
    orphan_id = _project_without_customer(client, admin_token, "2026-5108")
    box = _box(client, admin_token, "Kiste Packen")
    _put_in(client, admin_token, box["id"])

    packed = _pack(client, admin_token, box["id"], owner, project_id=orphan_id)

    assert packed.status_code == 200, packed.text
    assert packed.json()["project_id"] == orphan_id
