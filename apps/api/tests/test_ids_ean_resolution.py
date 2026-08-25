"""Translating a scanned EAN into the article number the wholesaler accepts.

The reported failure: the workshop scans barcodes, the cart goes to Unielektro
carrying GTINs in ``ArtNo``, and the shop silently does not recognise them. The
basket comes up short and nothing anywhere says so.

Weighted accordingly — towards the cases that are wrong *quietly*:

  * a barcode wearing an article number's hat, which is the bug itself;
  * an eight-digit wholesaler number that must NOT be mistaken for one, because
    over-eager rejection throws away numbers that work;
  * cross-supplier number reuse, where a confident match orders a different
    product;
  * the backfill overwriting curated data, which no later run would reveal;
  * a line that cannot be resolved at all, which must be reported rather than
    dropped.
"""

from __future__ import annotations

import html as html_module

from fastapi.testclient import TestClient


def auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


# ──────────────────────────────────────────────────────────────────────────
# Fixtures — direct inserts where the importer is not what is under test
# ──────────────────────────────────────────────────────────────────────────


def _supplier(client: TestClient, token: str, name: str = "Unielektro") -> int:
    resp = client.post(
        "/api/werkstatt/suppliers", headers=auth_headers(token), json={"name": name}
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["id"]


def _catalog_row(
    supplier_id: int,
    *,
    article_no: str,
    ean: str | None = None,
    name: str = "Katalogartikel",
    manufacturer: str | None = None,
) -> int:
    """Insert a Datanorm row directly — the importer is not under test."""
    from app.core.db import SessionLocal
    from app.models.entities import MaterialCatalogItem

    with SessionLocal() as db:
        row = MaterialCatalogItem(
            external_key=f"{supplier_id}-{article_no}-{ean or 'x'}",
            source_file="test.csv",
            source_line=1,
            article_no=article_no,
            item_name=name,
            ean=ean,
            manufacturer=manufacturer,
            supplier_id=supplier_id,
            search_text=f"{article_no} {name} {ean or ''}".lower(),
        )
        db.add(row)
        db.commit()
        return row.id


def _article(client: TestClient, token: str, name: str, **extra) -> dict:
    resp = client.post(
        "/api/werkstatt/articles",
        headers=auth_headers(token),
        json={"item_name": name, "unit": "Stk", **extra},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def _link(article_id: int, supplier_id: int, **extra) -> int:
    from app.core.db import SessionLocal
    from app.models.entities import WerkstattArticleSupplier

    with SessionLocal() as db:
        link = WerkstattArticleSupplier(
            article_id=article_id, supplier_id=supplier_id, **extra
        )
        db.add(link)
        db.commit()
        return link.id


def _set(model_name: str, row_id: int, **values) -> None:
    """Set columns the API deliberately does not expose (source_catalog_item_id)."""
    from app.core.db import SessionLocal
    from app.models import entities

    with SessionLocal() as db:
        row = db.get(getattr(entities, model_name), row_id)
        assert row is not None
        for key, value in values.items():
            setattr(row, key, value)
        db.commit()


def _ref(**kwargs):
    from app.services.ids_ean_resolver import OrderLineRef

    return OrderLineRef(position=kwargs.pop("position", 1), **kwargs)


def _resolve(supplier_id: int, *, backfill: bool = True, **ref):
    """Run the cascade for one line and commit whatever it wrote."""
    from app.core.db import SessionLocal
    from app.services.ids_ean_resolver import resolve_line

    with SessionLocal() as db:
        result = resolve_line(
            db, supplier_id=supplier_id, ref=_ref(**ref), backfill=backfill
        )
        db.commit()
        return result


def _report(supplier_id: int, refs, *, supplier_name: str = "Unielektro"):
    from app.core.db import SessionLocal
    from app.services.ids_ean_resolver import resolve_order_lines

    with SessionLocal() as db:
        report = resolve_order_lines(
            db, supplier_id=supplier_id, lines=refs, supplier_name=supplier_name
        )
        db.commit()
        return report


def _link_row(article_id: int, supplier_id: int):
    from app.core.db import SessionLocal
    from app.models.entities import WerkstattArticleSupplier
    import sqlalchemy as sa

    with SessionLocal() as db:
        return db.scalars(
            sa.select(WerkstattArticleSupplier).where(
                WerkstattArticleSupplier.article_id == article_id,
                WerkstattArticleSupplier.supplier_id == supplier_id,
            )
        ).first()


def _article_row(article_id: int):
    from app.core.db import SessionLocal
    from app.models.entities import WerkstattArticle

    with SessionLocal() as db:
        return db.get(WerkstattArticle, article_id)


# ──────────────────────────────────────────────────────────────────────────
# Step 0 — what the line already carries
# ──────────────────────────────────────────────────────────────────────────


def test_a_supplier_number_already_on_the_line_is_sent_unchanged(
    client: TestClient, admin_token: str
) -> None:
    """The snapshot is what we ordered; re-deriving it would rewrite history.

    A cart that came back from the shop carries the shop's own number, and that
    number must survive the round trip untouched.
    """

    supplier = _supplier(client, admin_token)
    _catalog_row(supplier, article_no="11102138", ean="4011234567890")

    result = _resolve(supplier, supplier_article_no="EIGENE-NR-9", description="Kabel")

    assert result.supplier_article_no == "EIGENE-NR-9"
    assert result.matched_by == "line_snapshot"


def test_a_scanned_gtin_in_the_article_number_field_is_not_trusted(
    client: TestClient, admin_token: str
) -> None:
    """The reported bug, in one test.

    The buyer scans the box, the barcode lands in the article-number field, and
    the position leaves for the shop as a GTIN. Unielektro does not recognise
    it, drops the line, and says nothing. The Datanorm we already hold knows
    exactly what that EAN is called here.
    """

    supplier = _supplier(client, admin_token)
    _catalog_row(supplier, article_no="11102138", ean="4011234567890", name="NYY-J 5x6")

    result = _resolve(supplier, supplier_article_no="4011234567890", description="NYY-J 5x6")

    assert result.supplier_article_no == "11102138"
    assert result.matched_by == "catalog_ean"


def test_an_eight_digit_supplier_number_is_not_mistaken_for_a_barcode(
    client: TestClient, admin_token: str
) -> None:
    """Unielektro's own numbers are eight digits ("11102138", "01004771").

    Doubting every all-digit article number would throw away numbers that work,
    which is a worse failure than the one being fixed — so only GTIN-13/14
    shapes are ever doubted.
    """

    supplier = _supplier(client, admin_token)
    # Deliberately absent from the catalogue: even unknown, it must go through.
    _catalog_row(supplier, article_no="99999999", ean="4011234567890")

    result = _resolve(supplier, supplier_article_no="01004771", description="FI-Schalter")

    assert result.supplier_article_no == "01004771"
    assert result.matched_by == "line_snapshot"


def test_a_snapshot_survives_when_the_supplier_has_no_datanorm(
    client: TestClient, admin_token: str
) -> None:
    """With nothing to check against we do not doubt.

    A supplier whose Datanorm has never been imported must not become a reason
    to drop lines — a number the shop rejects visibly beats a line we removed
    on suspicion.
    """

    supplier = _supplier(client, admin_token, "Kleinlieferant")

    result = _resolve(supplier, supplier_article_no="4011234567890", description="Klemme")

    assert result.supplier_article_no == "4011234567890"
    assert result.matched_by == "line_snapshot"


# ──────────────────────────────────────────────────────────────────────────
# Step 1 — the number we recorded for this article at this supplier
# ──────────────────────────────────────────────────────────────────────────


def test_the_recorded_supplier_number_wins_over_the_catalogue(
    client: TestClient, admin_token: str
) -> None:
    """Somebody already established what this wholesaler calls it.

    A hand-corrected link must outrank a Datanorm row, or every order would
    quietly undo the correction.
    """

    supplier = _supplier(client, admin_token)
    article = _article(client, admin_token, "Schuko Steckdose", ean="4012345678901")
    _catalog_row(supplier, article_no="KATALOG-1", ean="4012345678901")
    _link(article["id"], supplier, supplier_article_no="HAND-KORRIGIERT")

    result = _resolve(supplier, article_id=article["id"], ean="4012345678901")

    assert result.supplier_article_no == "HAND-KORRIGIERT"
    assert result.matched_by == "supplier_link"


# ──────────────────────────────────────────────────────────────────────────
# Step 2 — this supplier's Datanorm, found by EAN
# ──────────────────────────────────────────────────────────────────────────


def test_an_ean_resolves_to_this_suppliers_article_number(
    client: TestClient, admin_token: str
) -> None:
    supplier = _supplier(client, admin_token)
    article = _article(client, admin_token, "Schuko Steckdose", ean="4012345678901")
    _catalog_row(supplier, article_no="11102138", ean="4012345678901")

    result = _resolve(supplier, article_id=article["id"], ean="4012345678901")

    assert result.supplier_article_no == "11102138"
    assert result.matched_by == "catalog_ean"


def test_a_leading_zero_does_not_lose_the_match(
    client: TestClient, admin_token: str
) -> None:
    """Datanorm files disagree about GTIN padding — the same product appears as
    13 digits in one file and zero-padded to 14 in another. A dropped line over
    a leading zero is indistinguishable from a product the shop does not sell.
    """

    supplier = _supplier(client, admin_token)
    _catalog_row(supplier, article_no="11102138", ean="04012345678901")

    result = _resolve(supplier, ean="4012345678901", description="Steckdose")

    assert result.supplier_article_no == "11102138"


def test_another_suppliers_catalogue_is_never_used(
    client: TestClient, admin_token: str
) -> None:
    """Every lookup is scoped to one supplier.

    Sonepar's number for this product is a real number — for Sonepar. Sending
    it to Unielektro either matches nothing or, worse, matches something else.
    """

    uni = _supplier(client, admin_token, "Unielektro")
    sonepar = _supplier(client, admin_token, "Sonepar")
    _catalog_row(sonepar, article_no="SONEPAR-77", ean="4012345678901")

    result = _resolve(uni, ean="4012345678901", description="Steckdose")

    assert result.supplier_article_no is None
    assert result.matched_by == "unresolved"


def test_several_catalogue_rows_for_one_ean_are_flagged_not_hidden(
    client: TestClient, admin_token: str
) -> None:
    """Pack sizes and variants share an EAN more often than they should.

    One is picked deterministically so the order still goes out, but the buyer
    is told — the alternative is ordering a box when a single was wanted.
    """

    supplier = _supplier(client, admin_token)
    _catalog_row(supplier, article_no="AAA-1", ean="4012345678901", name="Einzeln")
    _catalog_row(supplier, article_no="BBB-2", ean="4012345678901", name="VE 100")

    report = _report(supplier, [_ref(ean="4012345678901", description="Steckdose")])

    assert report.resolutions[0].supplier_article_no == "AAA-1"
    assert report.resolutions[0].ambiguous_alternatives == 1
    assert any("weitere Katalog-Treffer" in w for w in report.warnings())


# ──────────────────────────────────────────────────────────────────────────
# Step 3 — this supplier's Datanorm, found by a number we hold
# ──────────────────────────────────────────────────────────────────────────


def test_a_number_we_hold_resolves_against_this_suppliers_catalogue(
    client: TestClient, admin_token: str
) -> None:
    """The article has no EAN at all — the common case for older stock.

    What it does have is the Datanorm row it was created from, whose number is
    the manufacturer's own and turns up unchanged in the second wholesaler's
    catalogue.
    """

    uni = _supplier(client, admin_token, "Unielektro")
    sonepar = _supplier(client, admin_token, "Sonepar")
    source = _catalog_row(sonepar, article_no="1TE3211", name="Hager Automat")
    _catalog_row(uni, article_no="1TE3211", name="Hager Automat")
    article = _article(client, admin_token, "Hager Automat")
    _set("WerkstattArticle", article["id"], source_catalog_item_id=source)

    result = _resolve(uni, article_id=article["id"], description="Hager Automat")

    assert result.supplier_article_no == "1TE3211"
    assert result.matched_by == "catalog_article_no"


def test_a_step_three_match_is_refused_when_the_eans_contradict(
    client: TestClient, admin_token: str
) -> None:
    """Cross-supplier number reuse is how the wrong product gets ordered.

    Two wholesalers both use "123456"; the EANs prove they are different
    things. Declining and reporting costs a phone call. Not declining costs a
    return, a second delivery day, and a fitter standing on a roof with the
    wrong part.
    """

    uni = _supplier(client, admin_token, "Unielektro")
    sonepar = _supplier(client, admin_token, "Sonepar")
    source = _catalog_row(sonepar, article_no="123456", ean="4012345678901", name="Steckdose")
    _catalog_row(uni, article_no="123456", ean="4099999999999", name="Etwas ganz anderes")
    article = _article(client, admin_token, "Steckdose", ean="4012345678901")
    _set("WerkstattArticle", article["id"], source_catalog_item_id=source)

    result = _resolve(uni, article_id=article["id"], ean="4012345678901")

    assert result.supplier_article_no is None
    assert result.matched_by == "unresolved"


def test_a_step_three_match_survives_a_catalogue_row_with_no_ean(
    client: TestClient, admin_token: str
) -> None:
    """Silence is not disagreement. Most Datanorm rows for older electrical
    parts carry no EAN, and refusing those would make step 3 useless for
    exactly the articles that need it."""

    uni = _supplier(client, admin_token, "Unielektro")
    sonepar = _supplier(client, admin_token, "Sonepar")
    source = _catalog_row(sonepar, article_no="1TE3211", ean="4012345678901")
    _catalog_row(uni, article_no="1TE3211", ean=None)
    article = _article(client, admin_token, "Hager Automat", ean="4012345678901")
    _set("WerkstattArticle", article["id"], source_catalog_item_id=source)

    result = _resolve(uni, article_id=article["id"], ean="4012345678901")

    assert result.supplier_article_no == "1TE3211"


# ──────────────────────────────────────────────────────────────────────────
# Step 5 — unresolved lines are reported, never dropped in silence
# ──────────────────────────────────────────────────────────────────────────


def test_an_unresolvable_line_is_reported_with_number_name_and_ean(
    client: TestClient, admin_token: str
) -> None:
    """All three identifiers, because each fails on its own.

    A silently missing line on a wholesaler order is worse than a failed order:
    nobody notices until the van is short.
    """

    supplier = _supplier(client, admin_token)
    _catalog_row(supplier, article_no="ETWAS", ean="4000000000000")
    article = _article(client, admin_token, "Unbekannte Klemme", ean="4012345678901")

    report = _report(
        supplier,
        [_ref(article_id=article["id"], article_number=article["article_number"],
              description="Unbekannte Klemme", ean="4012345678901")],
    )

    assert report.unresolved
    warning = report.warnings()[0]
    assert article["article_number"] in warning
    assert "Unbekannte Klemme" in warning
    assert "4012345678901" in warning
    assert "Unielektro" in warning


# ──────────────────────────────────────────────────────────────────────────
# Backfill
# ──────────────────────────────────────────────────────────────────────────


def test_resolving_by_ean_records_the_suppliers_number_for_next_time(
    client: TestClient, admin_token: str
) -> None:
    """The point of doing the catalogue lookup once.

    After the first order the article knows what Unielektro calls it, so the
    next one resolves at step 1 without touching a 1 M-row table.
    """

    supplier = _supplier(client, admin_token)
    article = _article(client, admin_token, "Schuko Steckdose", ean="4012345678901")
    catalog_id = _catalog_row(supplier, article_no="11102138", ean="4012345678901")

    first = _resolve(supplier, article_id=article["id"], ean="4012345678901")
    assert first.matched_by == "catalog_ean"
    assert "article_supplier.created" in first.backfilled

    link = _link_row(article["id"], supplier)
    assert link is not None
    assert link.supplier_article_no == "11102138"
    assert link.source_catalog_item_id == catalog_id
    # First supplier on an article becomes the preferred one, so the reorder
    # flow always has somewhere to send the order.
    assert link.is_preferred is True

    second = _resolve(supplier, article_id=article["id"], ean="4012345678901")
    assert second.matched_by == "supplier_link"
    assert second.backfilled == ()


def test_the_backfill_never_overwrites_a_supplier_number_we_already_have(
    client: TestClient, admin_token: str
) -> None:
    """Hand-curated data outranks a Datanorm import.

    An empty field is filled; a non-empty one is left exactly alone, or every
    order would quietly undo somebody's correction.
    """

    supplier = _supplier(client, admin_token)
    article = _article(client, admin_token, "Schuko Steckdose", ean="4012345678901")
    _catalog_row(supplier, article_no="KATALOG-NEU", ean="4012345678901")
    _link(article["id"], supplier, supplier_article_no="HAND-KORRIGIERT")

    _resolve(supplier, article_id=article["id"], ean="4012345678901")

    assert _link_row(article["id"], supplier).supplier_article_no == "HAND-KORRIGIERT"


def test_the_backfill_completes_a_link_that_has_no_number_yet(
    client: TestClient, admin_token: str
) -> None:
    """An empty column is not curated data — a link created for a price or a
    lead time has nothing to lose by learning the article number."""

    supplier = _supplier(client, admin_token)
    article = _article(client, admin_token, "Schuko Steckdose", ean="4012345678901")
    _catalog_row(supplier, article_no="11102138", ean="4012345678901")
    _link(article["id"], supplier, supplier_article_no=None, typical_price_cents=499)

    result = _resolve(supplier, article_id=article["id"], ean="4012345678901")

    link = _link_row(article["id"], supplier)
    assert link.supplier_article_no == "11102138"
    assert link.typical_price_cents == 499
    assert "article_supplier.supplier_article_no" in result.backfilled


def test_the_backfill_fills_a_missing_ean_from_the_catalogue(
    client: TestClient, admin_token: str
) -> None:
    """The reverse direction the owner asked for.

    The article was created without an EAN, so scanning its box resolved to
    nothing. Once the catalogue tells us the EAN, the next scan finds it.
    """

    supplier = _supplier(client, admin_token)
    article = _article(client, admin_token, "Hager Automat")
    source = _catalog_row(
        _supplier(client, admin_token, "Sonepar"), article_no="1TE3211", ean="4012345678901"
    )
    _catalog_row(supplier, article_no="1TE3211", ean="4012345678901")
    _set("WerkstattArticle", article["id"], source_catalog_item_id=source)

    result = _resolve(supplier, article_id=article["id"], description="Hager Automat")

    assert "article.ean" in result.backfilled
    assert _article_row(article["id"]).ean == "4012345678901"


def test_the_backfill_leaves_an_existing_ean_alone(
    client: TestClient, admin_token: str
) -> None:
    """An EAN on the article was scanned off a real box. A catalogue row
    claiming a different one is a disagreement for a human, not a value to
    overwrite."""

    supplier = _supplier(client, admin_token)
    article = _article(client, admin_token, "Schuko Steckdose", ean="4012345678901")
    _catalog_row(supplier, article_no="11102138", ean="4012345678901")

    _resolve(supplier, article_id=article["id"], ean="4012345678901")

    assert _article_row(article["id"]).ean == "4012345678901"


def test_the_backfill_refuses_an_ean_another_article_already_owns(
    client: TestClient, admin_token: str
) -> None:
    """``werkstatt_articles.ean`` is partial-unique WHERE NOT NULL.

    Writing a taken EAN would raise mid-submission, so the collision is checked
    before the write — the article number half of the backfill still lands, and
    the cart still goes out.
    """

    supplier = _supplier(client, admin_token)
    owner = _article(client, admin_token, "Schuko Steckdose", ean="4012345678901")
    other = _article(client, admin_token, "Hager Automat")
    source = _catalog_row(
        _supplier(client, admin_token, "Sonepar"), article_no="1TE3211", ean="4012345678901"
    )
    _catalog_row(supplier, article_no="1TE3211", ean="4012345678901")
    _set("WerkstattArticle", other["id"], source_catalog_item_id=source)

    result = _resolve(supplier, article_id=other["id"], description="Hager Automat")

    assert result.supplier_article_no == "1TE3211"
    assert "article.ean" not in result.backfilled
    assert _article_row(other["id"]).ean is None
    assert _article_row(owner["id"]).ean == "4012345678901"
    assert _link_row(other["id"], supplier).supplier_article_no == "1TE3211"


def test_backfill_can_be_switched_off(client: TestClient, admin_token: str) -> None:
    """A caller that only wants to know — a preview, a dry run — must be able to
    ask without writing to the inventory."""

    supplier = _supplier(client, admin_token)
    article = _article(client, admin_token, "Schuko Steckdose", ean="4012345678901")
    _catalog_row(supplier, article_no="11102138", ean="4012345678901")

    result = _resolve(supplier, article_id=article["id"], ean="4012345678901", backfill=False)

    assert result.supplier_article_no == "11102138"
    assert result.backfilled == ()
    assert _link_row(article["id"], supplier) is None


def test_a_free_line_resolves_but_has_nothing_to_backfill_onto(
    client: TestClient, admin_token: str
) -> None:
    """Most of what comes back from a shop is job material with no article row.

    It still has to reach the basket, so it still has to resolve — there is
    simply nowhere to record the answer.
    """

    supplier = _supplier(client, admin_token)
    _catalog_row(supplier, article_no="11102138", ean="4012345678901")

    result = _resolve(supplier, ean="4012345678901", description="40 m NYM-J")

    assert result.supplier_article_no == "11102138"
    assert result.backfilled == ()


# ──────────────────────────────────────────────────────────────────────────
# Extension point
# ──────────────────────────────────────────────────────────────────────────


def test_a_supplier_lookup_is_consulted_only_after_the_local_catalogue_fails(
    client: TestClient, admin_token: str
) -> None:
    """The local-first ordering, asserted rather than merely documented.

    Nothing ships a live implementation. What must hold is that one could not
    fire on a line the Datanorm already answers — that would put a network call
    on the hot path of every order.
    """

    from app.core.db import SessionLocal
    from app.services.ids_ean_resolver import OrderLineRef, resolve_line

    calls: list[str | None] = []

    class RecordingLookup:
        def find_supplier_article_no(self, *, supplier_id, ean, description):
            calls.append(ean)
            return "AUS-DEM-SHOP"

    supplier = _supplier(client, admin_token)
    _catalog_row(supplier, article_no="11102138", ean="4012345678901")

    with SessionLocal() as db:
        answered_locally = resolve_line(
            db,
            supplier_id=supplier,
            ref=OrderLineRef(position=1, ean="4012345678901"),
            lookup=RecordingLookup(),
        )
        unknown = resolve_line(
            db,
            supplier_id=supplier,
            ref=OrderLineRef(position=2, ean="4099999999999"),
            lookup=RecordingLookup(),
        )
        db.commit()

    assert answered_locally.matched_by == "catalog_ean"
    assert calls == ["4099999999999"], "the lookup fired on a line Datanorm answered"
    assert unknown.supplier_article_no == "AUS-DEM-SHOP"
    assert unknown.matched_by == "supplier_lookup"


# ──────────────────────────────────────────────────────────────────────────
# The cart, and the endpoint the buyer actually presses
# ──────────────────────────────────────────────────────────────────────────


def _order(client: TestClient, token: str, supplier_id: int) -> dict:
    resp = client.post(
        "/api/werkstatt/orders",
        headers=auth_headers(token),
        json={"supplier_id": supplier_id, "title": "Baustelle Müller"},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def _add_line(client: TestClient, token: str, order_id: int, **payload) -> dict:
    resp = client.post(
        f"/api/werkstatt/orders/{order_id}/lines",
        headers=auth_headers(token),
        json={"quantity_ordered": 1, **payload},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def _connection(client: TestClient, token: str, supplier_id: int) -> dict:
    resp = client.put(
        "/api/werkstatt/ids/connections",
        headers=auth_headers(token),
        json={
            "supplier_id": supplier_id,
            "is_enabled": True,
            "entry_url": "https://shop.example.com/ids",
            "username": "kunde",
            "password": "geheim",
            "customer_number": "4711",
        },
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def test_the_cart_carries_the_resolved_number_and_keeps_position_numbers(
    client: TestClient, admin_token: str
) -> None:
    """An unresolved line still occupies its position.

    Dropping it here would renumber everything after it, so "Position 3" in a
    warning would no longer be the third line of the order — and the shop's
    RefItems/Customer identity would shift with it.
    """

    from app.core.db import SessionLocal
    from app.services.ids_cart_builder import build_cart_xml, cart_items_for_order_lines
    from app.models.entities import WerkstattOrder
    from app.routers._werkstatt_tablet_shared import load_order_full

    supplier = _supplier(client, admin_token)
    _catalog_row(supplier, article_no="11102138", ean="4011234567890")
    order = _order(client, admin_token, supplier)
    _add_line(client, admin_token, order["id"], description="Unbekannt", ean="4099999999999")
    _add_line(
        client, admin_token, order["id"],
        description="NYY-J 5x6", supplier_article_no="4011234567890", quantity_ordered=10,
    )

    with SessionLocal() as db:
        full = load_order_full(db, db.get(WerkstattOrder, order["id"]))
        items, report = cart_items_for_order_lines(
            db, supplier_id=supplier, lines=full.lines, supplier_name="Unielektro"
        )
        db.commit()

    assert len(items) == 2, "an unresolved line must keep its slot"
    assert items[0].supplier_article_no is None
    assert items[1].supplier_article_no == "11102138"

    xml = build_cart_xml(
        items, reference=order["order_number"], warn_on_missing_article_no=False
    ).xml
    assert "<ArtNo>11102138</ArtNo>" in xml
    assert "<ArtNo>4011234567890</ArtNo>" not in xml
    # The dropped line is reported exactly once, by the resolver, with detail.
    assert len(report.unresolved) == 1
    assert "4099999999999" in report.warnings()[0]


def test_submit_reports_the_line_the_shop_will_not_receive(
    client: TestClient, admin_token: str
) -> None:
    """The buyer's only channel. A short basket must be visible before the van
    is loaded, not after.

    The order also carries a line that resolves, because that is the dangerous
    shape: a cart that goes through looking fine while one position is quietly
    absent from it. An order where *nothing* resolves at least announces itself
    by being empty.
    """

    supplier = _supplier(client, admin_token)
    _connection(client, admin_token, supplier)
    _catalog_row(supplier, article_no="11102138", ean="4011234567890")
    order = _order(client, admin_token, supplier)
    _add_line(client, admin_token, order["id"], description="NYY-J 5x6", ean="4011234567890")
    article = _article(client, admin_token, "Unbekannte Klemme", ean="4099999999999")
    _add_line(client, admin_token, order["id"], article_id=article["id"])

    resp = client.post(
        f"/api/werkstatt/ids/submit?order_id={order['id']}", headers=auth_headers(admin_token)
    )
    assert resp.status_code == 200, resp.text
    warnings = resp.json()["warnings"]

    # Exactly one: the resolver reports the dropped line with the detail needed
    # to fix it, and the builder no longer repeats it less usefully.
    assert len(warnings) == 1, f"one unresolvable line, one warning: {warnings}"
    assert warnings[0].startswith("Position 2")
    assert "Unbekannte Klemme" in warnings[0]
    assert "4099999999999" in warnings[0]
    assert article["article_number"] in warnings[0]


def test_a_scanned_ean_never_reaches_the_shop_as_an_article_number(
    client: TestClient, admin_token: str
) -> None:
    """End to end, over the same two calls the browser makes.

    This is the regression: before the resolver, the hand-over page carried the
    scanned GTIN in ArtNo and Unielektro dropped the position without a word.
    Nothing here reaches past the public API, so it fails against the old code
    rather than merely against a missing function.
    """

    supplier = _supplier(client, admin_token)
    _connection(client, admin_token, supplier)
    _catalog_row(supplier, article_no="11102138", ean="4011234567890", name="NYY-J 5x6")
    order = _order(client, admin_token, supplier)
    _add_line(
        client, admin_token, order["id"],
        description="NYY-J 5x6", supplier_article_no="4011234567890", quantity_ordered=10,
    )

    submitted = client.post(
        f"/api/werkstatt/ids/submit?order_id={order['id']}", headers=auth_headers(admin_token)
    )
    assert submitted.status_code == 200, submitted.text
    assert submitted.json()["warnings"] == []

    page = client.get(submitted.json()["handoff_url"])
    assert page.status_code == 200, page.text
    cart = html_module.unescape(page.text)

    assert "<ArtNo>11102138</ArtNo>" in cart
    assert "<ArtNo>4011234567890</ArtNo>" not in cart, (
        "the scanned barcode was handed to the shop as an article number"
    )
