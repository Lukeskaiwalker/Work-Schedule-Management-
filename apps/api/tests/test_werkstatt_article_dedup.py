"""Folding multi-Datanorm duplicates, merging articles, and similar-item lookup.

Covers the three things a second supplier's Datanorm breaks: the same product
appearing twice in the catalog, two article rows for one physical item, and
"what else like this do we actually have on the shelf".
"""

from __future__ import annotations

import sqlalchemy as sa
from fastapi.testclient import TestClient


def auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _supplier(client: TestClient, admin_token: str, name: str) -> int:
    created = client.post(
        "/api/werkstatt/suppliers", headers=auth_headers(admin_token), json={"name": name}
    )
    assert created.status_code == 200, created.text
    return created.json()["id"]


def _catalog_row(supplier_id: int, *, article_no: str, ean: str | None, name: str) -> int:
    """Insert a Datanorm row directly — the importer is not what is under test."""
    from app.core.db import SessionLocal
    from app.models.entities import MaterialCatalogItem

    with SessionLocal() as db:
        row = MaterialCatalogItem(
            external_key=f"{supplier_id}-{article_no}",
            source_file="test.csv",
            source_line=1,
            article_no=article_no,
            item_name=name,
            ean=ean,
            supplier_id=supplier_id,
            search_text=f"{article_no} {name} {ean or ''}".lower(),
        )
        db.add(row)
        db.commit()
        return row.id


def _article(client: TestClient, admin_token: str, name: str, *, ean: str | None = None) -> dict:
    payload: dict = {"item_name": name, "unit": "Stk"}
    if ean:
        payload["ean"] = ean
    created = client.post(
        "/api/werkstatt/articles", headers=auth_headers(admin_token), json=payload
    )
    assert created.status_code == 200, created.text
    return created.json()


def _seed_stock(article_id: int, quantity: int) -> None:
    from app.core.db import SessionLocal
    from app.models.entities import User, WerkstattArticle
    from app.services.werkstatt_movements import apply_movement

    with SessionLocal() as db:
        row = db.get(WerkstattArticle, article_id)
        admin = db.scalars(sa.select(User).where(User.email == "admin@example.com")).first()
        apply_movement(
            db,
            article=row,
            movement_type="intake",
            quantity=quantity,
            user_id=admin.id,
            notes="test-intake",
        )
        db.commit()


# ── Folding catalog duplicates ────────────────────────────────────────────


def test_fold_attaches_every_suppliers_article_number_for_one_ean(
    client: TestClient, admin_token: str
):
    """The reported problem: two Datanorms, one product, two disconnected rows.

    After folding, a single article carries supplier A's article number AND
    supplier B's — which is what the reorder and barcode-scan paths need.
    """
    supplier_a = _supplier(client, admin_token, "Unielektro")
    supplier_b = _supplier(client, admin_token, "Sonepar")
    _catalog_row(supplier_a, article_no="A-111", ean="4012345678901", name="Schuko Steckdose")
    _catalog_row(supplier_b, article_no="B-999", ean="4012345678901", name="Schuko Steckdose")

    article = _article(client, admin_token, "Schuko Steckdose", ean="4012345678901")

    folded = client.post(
        f"/api/werkstatt/articles/{article['id']}/fold-catalog-duplicates",
        headers=auth_headers(admin_token),
    )
    assert folded.status_code == 200, folded.text
    body = folded.json()

    linked = {row["supplier_name"]: row["supplier_article_no"] for row in body["linked"]}
    assert linked == {"Unielektro": "A-111", "Sonepar": "B-999"}


def test_fold_is_idempotent_and_preserves_existing_links(
    client: TestClient, admin_token: str
):
    """Re-running must not duplicate links or clobber curated supplier data."""
    supplier_a = _supplier(client, admin_token, "Unielektro")
    _catalog_row(supplier_a, article_no="A-111", ean="4012345678901", name="Schuko Steckdose")
    article = _article(client, admin_token, "Schuko Steckdose", ean="4012345678901")

    first = client.post(
        f"/api/werkstatt/articles/{article['id']}/fold-catalog-duplicates",
        headers=auth_headers(admin_token),
    ).json()
    assert len(first["linked"]) == 1

    second = client.post(
        f"/api/werkstatt/articles/{article['id']}/fold-catalog-duplicates",
        headers=auth_headers(admin_token),
    ).json()
    assert second["linked"] == []
    assert second["already_linked"] == 1


def test_fold_does_nothing_without_an_ean(client: TestClient, admin_token: str):
    """No EAN means no identifier strong enough to fold on — guess nothing."""
    supplier_a = _supplier(client, admin_token, "Unielektro")
    _catalog_row(supplier_a, article_no="A-111", ean="4012345678901", name="Schuko Steckdose")
    article = _article(client, admin_token, "Schuko Steckdose")

    folded = client.post(
        f"/api/werkstatt/articles/{article['id']}/fold-catalog-duplicates",
        headers=auth_headers(admin_token),
    )
    assert folded.status_code == 200
    assert folded.json()["linked"] == []


# ── Duplicate review queue ────────────────────────────────────────────────


def test_duplicates_endpoint_is_not_shadowed_by_the_article_id_route(
    client: TestClient, admin_token: str
):
    """Regression guard: /articles/duplicates must not parse as article_id.

    FastAPI matches routes in registration order, so this literal path has to
    stay declared above `GET /articles/{article_id}` or it 422s.
    """
    response = client.get("/api/werkstatt/articles/duplicates", headers=auth_headers(admin_token))
    assert response.status_code == 200
    assert isinstance(response.json(), list)


def test_near_identical_names_without_ean_are_offered_for_review(
    client: TestClient, admin_token: str
):
    _article(client, admin_token, "Schuko Steckdose weiss")
    _article(client, admin_token, "Schuko Steckdose weiss aufputz")

    listed = client.get(
        "/api/werkstatt/articles/duplicates", headers=auth_headers(admin_token)
    ).json()
    assert any("Schuko" in row["article_name"] for row in listed)


def test_two_known_eans_are_never_offered_as_duplicates(client: TestClient, admin_token: str):
    """Different EANs are different products no matter how alike the names read."""
    _article(client, admin_token, "Schuko Steckdose weiss", ean="4012345678901")
    _article(client, admin_token, "Schuko Steckdose weiss", ean="4012345678902")

    listed = client.get(
        "/api/werkstatt/articles/duplicates", headers=auth_headers(admin_token)
    ).json()
    assert listed == []


# ── Merging ───────────────────────────────────────────────────────────────


def test_merge_moves_stock_ledger_and_archives_the_duplicate(
    client: TestClient, admin_token: str
):
    """Stock is recomputed from the moved ledger, not added as two snapshots."""
    survivor = _article(client, admin_token, "Kabelbinder schwarz 200mm")
    duplicate = _article(client, admin_token, "Kabelbinder schwarz 200 mm")
    _seed_stock(survivor["id"], 10)
    _seed_stock(duplicate["id"], 15)

    merged = client.post(
        "/api/werkstatt/articles/merge",
        headers=auth_headers(admin_token),
        json={"survivor_id": survivor["id"], "duplicate_id": duplicate["id"]},
    )
    assert merged.status_code == 200, merged.text
    assert merged.json()["movements_moved"] == 1

    after = client.get(
        f"/api/werkstatt/articles/{survivor['id']}", headers=auth_headers(admin_token)
    ).json()
    assert after["stock_available"] == 25

    retired = client.get(
        f"/api/werkstatt/articles/{duplicate['id']}", headers=auth_headers(admin_token)
    ).json()
    assert retired["is_archived"] is True
    assert retired["stock_available"] == 0


def test_merge_unions_supplier_links_and_fills_blank_fields(
    client: TestClient, admin_token: str
):
    """A merge must not lose what the duplicate knew that the survivor didn't."""
    supplier_a = _supplier(client, admin_token, "Unielektro")
    supplier_b = _supplier(client, admin_token, "Sonepar")
    survivor = _article(client, admin_token, "Schuko Steckdose")
    duplicate = _article(client, admin_token, "Schuko Steckdose weiss", ean="4012345678901")

    for article_id, supplier_id, number in (
        (survivor["id"], supplier_a, "A-111"),
        (duplicate["id"], supplier_b, "B-999"),
    ):
        created = client.post(
            f"/api/werkstatt/articles/{article_id}/suppliers",
            headers=auth_headers(admin_token),
            json={"supplier_id": supplier_id, "supplier_article_no": number},
        )
        assert created.status_code == 200, created.text

    merged = client.post(
        "/api/werkstatt/articles/merge",
        headers=auth_headers(admin_token),
        json={"survivor_id": survivor["id"], "duplicate_id": duplicate["id"]},
    )
    assert merged.status_code == 200, merged.text
    assert merged.json()["supplier_links_moved"] == 1
    # The duplicate carried the EAN; the survivor had none, so it inherits it.
    assert "ean" in merged.json()["fields_filled"]

    after = client.get(
        f"/api/werkstatt/articles/{survivor['id']}", headers=auth_headers(admin_token)
    ).json()
    assert after["ean"] == "4012345678901"
    numbers = {link["supplier_article_no"] for link in after["suppliers"]}
    assert numbers == {"A-111", "B-999"}


def test_merge_rejects_self_merge(client: TestClient, admin_token: str):
    article = _article(client, admin_token, "Kabelkanal 60x40")
    response = client.post(
        "/api/werkstatt/articles/merge",
        headers=auth_headers(admin_token),
        json={"survivor_id": article["id"], "duplicate_id": article["id"]},
    )
    assert response.status_code == 400


# ── Similar items ─────────────────────────────────────────────────────────


def test_similar_articles_are_ordered_by_stock_on_hand(client: TestClient, admin_token: str):
    """On a site, "similar" is only useful if it surfaces what you can grab.

    Stock is therefore the primary sort and closeness the tie-break.
    """
    target = _article(client, admin_token, "Kabelbinder schwarz 200mm")
    plenty = _article(client, admin_token, "Kabelbinder schwarz 300mm")
    scarce = _article(client, admin_token, "Kabelbinder weiss 200mm")
    _seed_stock(plenty["id"], 40)
    _seed_stock(scarce["id"], 2)

    similar = client.get(
        f"/api/werkstatt/articles/{target['id']}/similar", headers=auth_headers(admin_token)
    )
    assert similar.status_code == 200, similar.text
    rows = similar.json()
    assert [row["article_id"] for row in rows][:2] == [plenty["id"], scarce["id"]]
    assert rows[0]["stock_available"] == 40
    # The article itself is never its own suggestion.
    assert all(row["article_id"] != target["id"] for row in rows)


def test_similar_articles_404_for_unknown_article(client: TestClient, admin_token: str):
    response = client.get(
        "/api/werkstatt/articles/999999/similar", headers=auth_headers(admin_token)
    )
    assert response.status_code == 404


# ── A merge has to move EVERYTHING, or it should not be offered ───────────
#
# Movements, order lines and box items were moved; machine units, stock-take
# counts and task material lines were not. That is worse than not merging at
# all: the survivor looks right on screen while a stock-take counts against a
# row nothing can reach any more, and a drill's units point at an archived
# type. These pin the whole set.


def _unit(article_id: int, unit_number: str) -> int:
    from app.core.db import SessionLocal
    from app.models.entities import WerkstattArticleUnit

    with SessionLocal() as db:
        row = WerkstattArticleUnit(unit_number=unit_number, article_id=article_id)
        db.add(row)
        db.commit()
        return row.id


def _task_material(article_id: int, item_name: str) -> int:
    """A packed material line, via a minimal project + task."""
    from app.core.db import SessionLocal
    from app.models.entities import Project, Task, TaskMaterial

    with SessionLocal() as db:
        project = Project(project_number=f"P-{article_id}-{item_name[:4]}", name="Testprojekt")
        db.add(project)
        db.flush()
        task = Task(project_id=project.id, title="Einbau")
        db.add(task)
        db.flush()
        row = TaskMaterial(task_id=task.id, item_name=item_name, article_id=article_id, quantity=2)
        db.add(row)
        db.commit()
        return row.id


def _inventory_count(session_id: int, article_id: int, counted: int, scans: int) -> int:
    from app.core.db import SessionLocal
    from app.models.entities import WerkstattInventoryCount

    with SessionLocal() as db:
        row = WerkstattInventoryCount(
            session_id=session_id,
            article_id=article_id,
            counted_qty=counted,
            scan_count=scans,
        )
        db.add(row)
        db.commit()
        return row.id


def _inventory_session(client: TestClient, admin_token: str, name: str) -> int:
    created = client.post(
        "/api/werkstatt/inventory/sessions",
        headers=auth_headers(admin_token),
        json={"name": name},
    )
    assert created.status_code == 200, created.text
    return created.json()["id"]


def test_merge_moves_units_counts_and_task_materials(client: TestClient, admin_token: str):
    survivor = _article(client, admin_token, "Bohrhammer TE 30", ean="4012345678901")
    duplicate = _article(client, admin_token, "Bohrhammer TE30")
    _seed_stock(duplicate["id"], 5)

    unit_id = _unit(duplicate["id"], "M-9001")
    material_id = _task_material(duplicate["id"], "Bohrhammer TE30")
    session_id = _inventory_session(client, admin_token, "Inventur Halle 1")
    count_id = _inventory_count(session_id, duplicate["id"], counted=7, scans=7)

    merged = client.post(
        "/api/werkstatt/articles/merge",
        headers=auth_headers(admin_token),
        json={"survivor_id": survivor["id"], "duplicate_id": duplicate["id"]},
    )
    assert merged.status_code == 200, merged.text
    body = merged.json()
    assert body["units_moved"] == 1
    assert body["task_materials_moved"] == 1
    assert body["inventory_counts_moved"] == 1
    assert body["movements_moved"] == 1

    from app.core.db import SessionLocal
    from app.models.entities import (
        TaskMaterial,
        WerkstattArticleUnit,
        WerkstattInventoryCount,
    )

    with SessionLocal() as db:
        assert db.get(WerkstattArticleUnit, unit_id).article_id == survivor["id"]
        assert db.get(TaskMaterial, material_id).article_id == survivor["id"]
        assert db.get(WerkstattInventoryCount, count_id).article_id == survivor["id"]

    # The stock came with them, recomputed from the moved ledger.
    after = client.get(
        f"/api/werkstatt/articles/{survivor['id']}", headers=auth_headers(admin_token)
    ).json()
    assert after["stock_total"] == 5


def test_merge_adds_up_two_count_lines_in_one_stock_take(client: TestClient, admin_token: str):
    """(session_id, article_id) is unique — a blind UPDATE would explode here.

    And it explodes in exactly the situation that makes somebody merge: a
    stock-take that found both bins.
    """
    survivor = _article(client, admin_token, "Kabelbinder 200mm", ean="4012345678918")
    duplicate = _article(client, admin_token, "Kabelbinder 200 mm")
    session_id = _inventory_session(client, admin_token, "Inventur Regal")
    _inventory_count(session_id, survivor["id"], counted=4, scans=4)
    _inventory_count(session_id, duplicate["id"], counted=3, scans=2)

    merged = client.post(
        "/api/werkstatt/articles/merge",
        headers=auth_headers(admin_token),
        json={"survivor_id": survivor["id"], "duplicate_id": duplicate["id"]},
    )
    assert merged.status_code == 200, merged.text

    from app.core.db import SessionLocal
    from app.models.entities import WerkstattInventoryCount

    with SessionLocal() as db:
        rows = list(
            db.scalars(
                sa.select(WerkstattInventoryCount).where(
                    WerkstattInventoryCount.session_id == session_id
                )
            ).all()
        )
        assert len(rows) == 1
        assert rows[0].article_id == survivor["id"]
        assert rows[0].counted_qty == 7
        assert rows[0].scan_count == 6


def test_the_old_label_still_scans_to_the_survivor(client: TestClient, admin_token: str):
    """A merge archives a row whose SP-number is already stuck on a shelf.

    Without the survivor pointer that sticker resolves to an archived article
    holding no stock — the scanner says "0 verfügbar" about a full bin.
    """
    survivor = _article(client, admin_token, "Schuko-Steckdose", ean="4012345678925")
    duplicate = _article(client, admin_token, "Schuko Steckdose weiss")
    _seed_stock(survivor["id"], 9)

    client.post(
        "/api/werkstatt/articles/merge",
        headers=auth_headers(admin_token),
        json={"survivor_id": survivor["id"], "duplicate_id": duplicate["id"]},
    )

    resolved = client.get(
        "/api/werkstatt/scan/resolve",
        params={"code": duplicate["article_number"]},
        headers=auth_headers(admin_token),
    )
    assert resolved.status_code == 200, resolved.text
    body = resolved.json()
    assert body["kind"] == "werkstatt_article"
    assert body["article"]["id"] == survivor["id"]
    # How it matched is a fact about the CODE and does not change.
    assert body["matched_by"] == "sp"

    # And the lookup says which sticker the person is holding.
    found = client.get(
        "/api/werkstatt/articles/lookup",
        params={"code": duplicate["article_number"]},
        headers=auth_headers(admin_token),
    ).json()
    assert found["kind"] == "existing"
    assert found["via_merged_article_number"] == duplicate["article_number"]


def test_the_in_house_barcode_follows_the_merge(client: TestClient, admin_token: str):
    """The duplicate's printed SMPL-code is physically on a shelf."""
    survivor = _article(client, admin_token, "Dübel 8mm", ean="4012345678932")
    duplicate = _article(client, admin_token, "Duebel 8 mm")
    printed = client.post(
        f"/api/werkstatt/articles/{duplicate['id']}/print-label",
        headers=auth_headers(admin_token),
    )
    if printed.status_code != 200:
        # No label printer configured in this environment — mint the code the
        # way the printer path would, so the merge behaviour is still pinned.
        from app.core.db import SessionLocal
        from app.models.entities import WerkstattArticle
        from app.services.werkstatt_internal_codes import ensure_internal_code

        with SessionLocal() as db:
            row = db.get(WerkstattArticle, duplicate["id"])
            code = ensure_internal_code(db, row)
            db.commit()
    else:
        code = printed.json()["internal_code"]

    merged = client.post(
        "/api/werkstatt/articles/merge",
        headers=auth_headers(admin_token),
        json={"survivor_id": survivor["id"], "duplicate_id": duplicate["id"]},
    )
    assert merged.status_code == 200, merged.text
    assert merged.json()["internal_code_moved"] is True

    resolved = client.get(
        "/api/werkstatt/scan/resolve", params={"code": code}, headers=auth_headers(admin_token)
    ).json()
    assert resolved["article"]["id"] == survivor["id"]
    assert resolved["matched_by"] == "internal_code"


def test_a_merge_chain_is_refused(client: TestClient, admin_token: str):
    """One hop, so the scan cascade never has to walk a graph.

    Re-merging in the OTHER direction stays possible — that is how a wrong
    survivor choice is corrected — which is why the refusal is about the
    survivor, not the duplicate.
    """
    first = _article(client, admin_token, "Klemme 3-Leiter", ean="4012345678949")
    second = _article(client, admin_token, "Klemme 3 Leiter")
    third = _article(client, admin_token, "Klemme dreileiter")

    merged = client.post(
        "/api/werkstatt/articles/merge",
        headers=auth_headers(admin_token),
        json={"survivor_id": first["id"], "duplicate_id": second["id"]},
    )
    assert merged.status_code == 200, merged.text

    # `second` now points at `first`. Offering it as a destination would build
    # a chain the scan cascade would have to walk.
    chained = client.post(
        "/api/werkstatt/articles/merge",
        headers=auth_headers(admin_token),
        json={"survivor_id": second["id"], "duplicate_id": third["id"]},
    )
    assert chained.status_code == 400
    assert "zusammengeführt" in chained.json()["detail"]


def test_a_second_merge_forwards_the_first_ones_label(client: TestClient, admin_token: str):
    """A→B, then B→C: the sticker printed for A must reach C, not archived B.

    The one-hop rule is enforced on the SURVIVOR, which is right — re-merging
    in the other direction is how a wrong survivor choice is corrected. But it
    said nothing about rows already pointing AT the duplicate, so a second,
    perfectly legitimate cleanup left A pointing at an archived, zero-stock row
    and the rack answered "0 verfügbar" for a bin that is full.
    """
    a = _article(client, admin_token, "Schuko Steckdose weiss")
    b = _article(client, admin_token, "Schuko-Steckdose weiß")
    c = _article(client, admin_token, "Schuko Steckdose reinweiss", ean="4012345678994")

    first = client.post(
        "/api/werkstatt/articles/merge",
        headers=auth_headers(admin_token),
        json={"survivor_id": b["id"], "duplicate_id": a["id"]},
    )
    assert first.status_code == 200, first.text

    second = client.post(
        "/api/werkstatt/articles/merge",
        headers=auth_headers(admin_token),
        json={"survivor_id": c["id"], "duplicate_id": b["id"]},
    )
    assert second.status_code == 200, second.text

    # A's own number is on a printed label somewhere in the workshop.
    resolved = client.get(
        "/api/werkstatt/scan/resolve",
        params={"code": a["article_number"]},
        headers=auth_headers(admin_token),
    ).json()
    assert resolved["kind"] == "werkstatt_article"
    assert resolved["article"]["id"] == c["id"]

    lookup = client.get(
        "/api/werkstatt/articles/lookup",
        params={"code": a["article_number"], "allow_external": "false"},
        headers=auth_headers(admin_token),
    ).json()
    assert lookup["kind"] == "existing"
    assert lookup["article"]["id"] == c["id"]


def test_a_supplier_number_the_survivor_cannot_hold_is_kept_anyway(
    client: TestClient, admin_token: str
):
    """The confirmation promises supplier numbers move across. They must.

    26190 and 26191 are both Unielektro's numbers for one socket; the link row
    is unique per (article, supplier), so the duplicate's row cannot travel.
    Deleting it made the next order to that supplier go out under the old
    number, with nothing on screen saying anything had been dropped.
    """
    supplier = _supplier(client, admin_token, "Unielektro")
    survivor = _article(client, admin_token, "Schuko-Steckdose weiß", ean="4012345678963")
    duplicate = _article(client, admin_token, "Schuko Steckdose weiss")
    for article_id, number in ((survivor["id"], "26190"), (duplicate["id"], "26191")):
        linked = client.post(
            f"/api/werkstatt/articles/{article_id}/suppliers",
            headers=auth_headers(admin_token),
            json={"supplier_id": supplier, "supplier_article_no": number, "is_preferred": True},
        )
        assert linked.status_code == 200, linked.text

    merged = client.post(
        "/api/werkstatt/articles/merge",
        headers=auth_headers(admin_token),
        json={"survivor_id": survivor["id"], "duplicate_id": duplicate["id"]},
    )
    assert merged.status_code == 200, merged.text
    # Reported, so the toast can say it rather than the number vanishing.
    assert merged.json()["supplier_numbers_kept"] == ["26191"]

    full = client.get(
        f"/api/werkstatt/articles/{survivor['id']}", headers=auth_headers(admin_token)
    ).json()
    link = next(row for row in full["suppliers"] if row["supplier_id"] == supplier)
    assert link["supplier_article_no"] == "26190"
    assert "26191" in (link["notes"] or "")


def test_an_empty_supplier_link_adopts_the_duplicates_number(
    client: TestClient, admin_token: str
):
    """Nothing to weigh against: the survivor simply gains the number."""
    supplier = _supplier(client, admin_token, "Sonepar")
    survivor = _article(client, admin_token, "Aderendhülse 1,5", ean="4012345678970")
    duplicate = _article(client, admin_token, "Aderendhuelse 1.5")
    client.post(
        f"/api/werkstatt/articles/{survivor['id']}/suppliers",
        headers=auth_headers(admin_token),
        json={"supplier_id": supplier, "is_preferred": True},
    )
    client.post(
        f"/api/werkstatt/articles/{duplicate['id']}/suppliers",
        headers=auth_headers(admin_token),
        json={"supplier_id": supplier, "supplier_article_no": "AH-15", "is_preferred": True},
    )

    merged = client.post(
        "/api/werkstatt/articles/merge",
        headers=auth_headers(admin_token),
        json={"survivor_id": survivor["id"], "duplicate_id": duplicate["id"]},
    )
    assert merged.status_code == 200, merged.text
    assert merged.json()["supplier_numbers_kept"] == ["AH-15"]

    full = client.get(
        f"/api/werkstatt/articles/{survivor['id']}", headers=auth_headers(admin_token)
    ).json()
    link = next(row for row in full["suppliers"] if row["supplier_id"] == supplier)
    assert link["supplier_article_no"] == "AH-15"


def test_merging_into_an_archived_article_is_refused(client: TestClient, admin_token: str):
    survivor = _article(client, admin_token, "Isolierband", ean="4012345678956")
    duplicate = _article(client, admin_token, "Isolier-Band")
    client.delete(f"/api/werkstatt/articles/{survivor['id']}", headers=auth_headers(admin_token))

    refused = client.post(
        "/api/werkstatt/articles/merge",
        headers=auth_headers(admin_token),
        json={"survivor_id": survivor["id"], "duplicate_id": duplicate["id"]},
    )
    assert refused.status_code == 400
    assert "archiviert" in refused.json()["detail"]


# ── "Kein Duplikat" has to stick ──────────────────────────────────────────


def test_a_dismissed_pair_stops_being_offered(client: TestClient, admin_token: str):
    # Same name, different bins — exactly the pair the finder offers and a
    # human has to judge, because nothing in the data can settle it.
    left = _article(client, admin_token, "Kabelkanal 40x40 Halle")
    right = _article(client, admin_token, "Kabelkanal 40x40 Halle")

    offered = client.get(
        "/api/werkstatt/articles/duplicates", headers=auth_headers(admin_token)
    ).json()
    pair = next(
        (
            row
            for row in offered
            if {row["article_id"], row["duplicate_id"]} == {left["id"], right["id"]}
        ),
        None,
    )
    assert pair is not None, offered
    assert pair["reason_de"]
    assert pair["left"]["article_number"]
    assert pair["pair_key"] == f"{min(left['id'], right['id'])}:{max(left['id'], right['id'])}"

    # Dismissed the other way round on purpose: the finder does not promise
    # which side it shows first, so the judgement must not depend on it.
    dismissed = client.post(
        "/api/werkstatt/articles/duplicates/dismiss",
        headers=auth_headers(admin_token),
        json={"article_id": right["id"], "duplicate_id": left["id"]},
    )
    assert dismissed.status_code == 204, dismissed.text

    after = client.get(
        "/api/werkstatt/articles/duplicates", headers=auth_headers(admin_token)
    ).json()
    assert not [
        row
        for row in after
        if {row["article_id"], row["duplicate_id"]} == {left["id"], right["id"]}
    ]

    restored = client.delete(
        "/api/werkstatt/articles/duplicates/dismiss",
        params={"article_id": left["id"], "duplicate_id": right["id"]},
        headers=auth_headers(admin_token),
    )
    assert restored.status_code == 204, restored.text
    again = client.get(
        "/api/werkstatt/articles/duplicates", headers=auth_headers(admin_token)
    ).json()
    assert [
        row
        for row in again
        if {row["article_id"], row["duplicate_id"]} == {left["id"], right["id"]}
    ]


def test_a_machine_type_is_never_paired_with_a_consumable(
    client: TestClient, admin_token: str
):
    head = auth_headers(admin_token)
    consumable = client.post(
        "/api/werkstatt/articles", headers=head, json={"item_name": "Akkuschrauber Bit-Set"}
    ).json()
    machine = client.post(
        "/api/werkstatt/articles",
        headers=head,
        json={"item_name": "Akkuschrauber Bit Set", "is_serialized": True},
    ).json()

    offered = client.get("/api/werkstatt/articles/duplicates", headers=head).json()
    assert not [
        row
        for row in offered
        if {row["article_id"], row["duplicate_id"]} == {consumable["id"], machine["id"]}
    ]


def test_the_duplicates_listing_does_not_query_per_pair(client: TestClient, admin_token: str):
    """It is O(n²) in Python by design; it must not be O(n²) in round trips.

    The supplier-number check used to run one SELECT per pair, so 40 articles
    cost ~780 queries for one screen — and the workshop has hundreds.
    """
    from sqlalchemy import event

    from app.core.db import engine

    for index in range(14):
        client.post(
            "/api/werkstatt/articles",
            headers=auth_headers(admin_token),
            json={"item_name": f"Schraube {index} 4x40 verzinkt"},
        )

    statements: list[str] = []

    def record(conn, cursor, statement, parameters, context, executemany):
        statements.append(statement)

    event.listen(engine, "before_cursor_execute", record)
    try:
        response = client.get(
            "/api/werkstatt/articles/duplicates", headers=auth_headers(admin_token)
        )
    finally:
        event.remove(engine, "before_cursor_execute", record)

    assert response.status_code == 200, response.text
    selects = [s for s in statements if s.lstrip().upper().startswith("SELECT")]
    # 14 articles is 91 pairs. A per-pair query would put this well past 90;
    # the prefetch keeps the whole endpoint in single digits plus auth.
    assert len(selects) < 20, len(selects)
