"""Finding a stocked article by whatever is printed on the box.

The owner's complaint: "sometimes I am not able to search for an already added
item by its supplier part number". The supplier's number lives only on the
article↔supplier link, and three paths each treated it differently:

* ``GET /werkstatt/articles?q=`` (the Bestand page, the phone, the order
  picker) never looked at the links at all, nor at our own printed code,
  category or Lagerort;
* the scan cascade compared the number exactly, so a rack reader that
  uppercases every letter, or a label printed with other punctuation than the
  Datanorm stores, resolved to nothing;
* "Mit Katalog verknüpfen" and the link endpoints could leave the number
  unwritten or padded with blanks.

Everything here runs on SQLite (the test database) — the SQL helpers
deliberately use only ``lower``/``replace``/``LIKE``, which PostgreSQL speaks
identically.
"""

from __future__ import annotations

from fastapi.testclient import TestClient


def auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _supplier(client: TestClient, token: str, name: str) -> dict:
    resp = client.post(
        "/api/werkstatt/suppliers", headers=auth_headers(token), json={"name": name}
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def _article(client: TestClient, token: str, name: str, **extra) -> dict:
    resp = client.post(
        "/api/werkstatt/articles",
        headers=auth_headers(token),
        json={"item_name": name, "unit": "Stk", **extra},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def _post_link(client: TestClient, token: str, article_id: int, supplier_id: int, **extra):
    return client.post(
        f"/api/werkstatt/articles/{article_id}/suppliers",
        headers=auth_headers(token),
        json={"supplier_id": supplier_id, **extra},
    )


def _link(client: TestClient, token: str, article_id: int, supplier_id: int, number: str) -> dict:
    resp = _post_link(client, token, article_id, supplier_id, supplier_article_no=number)
    assert resp.status_code == 200, resp.text
    return resp.json()


def _search(client: TestClient, token: str, q: str, **params) -> list[dict]:
    resp = client.get(
        "/api/werkstatt/articles", headers=auth_headers(token), params={"q": q, **params}
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def _ids(rows: list[dict]) -> list[int]:
    return [row["id"] for row in rows]


def _resolve(client: TestClient, token: str, code: str) -> dict:
    resp = client.get(
        "/api/werkstatt/scan/resolve", headers=auth_headers(token), params={"code": code}
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def _set_internal_code(article_id: int, code: str) -> None:
    """Our own printed code — minted by the label printer, which is not under test."""
    from app.core.db import SessionLocal
    from app.models.entities import WerkstattArticle

    with SessionLocal() as db:
        row = db.get(WerkstattArticle, article_id)
        row.internal_code = code
        db.commit()


def _catalog_row(
    supplier_id: int | None, *, article_no: str, name: str, ean: str | None = None, unit: str = "Stk"
) -> int:
    """A Datanorm row, inserted directly — the importer is not under test."""
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
            unit=unit,
            supplier_id=supplier_id,
            search_text=f"{article_no} {name} {ean or ''}".lower(),
        )
        db.add(row)
        db.commit()
        return row.id


def _machine(client: TestClient, token: str, article_id: int, serial_number: str) -> dict:
    resp = client.post(
        "/api/werkstatt/machines",
        headers=auth_headers(token),
        json={"article_id": article_id, "serial_number": serial_number},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _links_by_supplier(client: TestClient, token: str, article_id: int) -> dict[int, dict]:
    resp = client.get(f"/api/werkstatt/articles/{article_id}", headers=auth_headers(token))
    assert resp.status_code == 200, resp.text
    return {row["supplier_id"]: row for row in resp.json()["suppliers"]}


# ──────────────────────────────────────────────────────────────────────────
# GET /articles?q= — every field a person might type
# ──────────────────────────────────────────────────────────────────────────


def test_q_finds_an_article_by_its_supplier_number_in_any_case_and_punctuation(
    client: TestClient, admin_token: str
) -> None:
    """The owner's bug. The number exists only on the supplier link."""

    unielektro = _supplier(client, admin_token, "Unielektro")
    schuetz = _article(client, admin_token, "Schütz 3-polig 25A")
    _article(client, admin_token, "Kabelbinder 200 mm")
    _link(client, admin_token, schuetz["id"], unielektro["id"], "UE-998877/a")

    for typed in ("UE-998877/a", "ue-998877/A", "UE998877A", "ue 998877 a", "998877", "8877/A"):
        rows = _search(client, admin_token, typed, kind="consumable")
        assert _ids(rows) == [schuetz["id"]], typed
        assert rows[0]["matched_supplier_article_no"] == "UE-998877/a", typed


def test_q_finds_the_number_of_a_second_supplier_link(
    client: TestClient, admin_token: str
) -> None:
    """Every link counts, not only the preferred one."""

    unielektro = _supplier(client, admin_token, "Unielektro")
    sonepar = _supplier(client, admin_token, "Sonepar")
    cable = _article(client, admin_token, "NYY-J 5x6")
    _link(client, admin_token, cable["id"], unielektro["id"], "11102138")
    _link(client, admin_token, cable["id"], sonepar["id"], "S-77.40")

    rows = _search(client, admin_token, "s7740")
    assert _ids(rows) == [cable["id"]]
    assert rows[0]["matched_supplier_article_no"] == "S-77.40"

    rows = _search(client, admin_token, "11102138")
    assert _ids(rows) == [cable["id"]]
    assert rows[0]["matched_supplier_article_no"] == "11102138"


def test_q_finds_our_printed_code_ean_and_sp_number_without_punctuation(
    client: TestClient, admin_token: str
) -> None:
    article = _article(client, admin_token, "Abzweigdose AP", ean="4006381333931")
    other = _article(client, admin_token, "Wandschalter")
    _set_internal_code(article["id"], "SMPL-K7Q2M")

    assert _ids(_search(client, admin_token, "smpl-k7q2m")) == [article["id"]]
    assert _ids(_search(client, admin_token, "SMPLK7Q2M")) == [article["id"]]
    assert _ids(_search(client, admin_token, "4006 3813 3393 1")) == [article["id"]]

    sp_without_hyphen = other["article_number"].replace("-", "").lower()
    assert _ids(_search(client, admin_token, sp_without_hyphen)) == [other["id"]]

    # None of these came from a supplier's number, so none is reported.
    assert _search(client, admin_token, "SMPLK7Q2M")[0]["matched_supplier_article_no"] is None


def test_q_finds_category_and_location_names(client: TestClient, admin_token: str) -> None:
    """The search box promises Lagerort and Kategorie; the server must keep it."""

    headers = auth_headers(admin_token)
    category = client.post(
        "/api/werkstatt/categories", headers=headers, json={"name": "Installationsmaterial"}
    )
    assert category.status_code == 200, category.text
    location = client.post(
        "/api/werkstatt/locations", headers=headers, json={"name": "Regal B3", "location_type": "shelf"}
    )
    assert location.status_code == 200, location.text

    in_both = _article(
        client,
        admin_token,
        "Hohlwanddose 68 mm",
        category_id=category.json()["id"],
        location_id=location.json()["id"],
    )
    _article(client, admin_token, "Hohlwanddose 68 mm tief")

    assert _ids(_search(client, admin_token, "installationsMATERIAL")) == [in_both["id"]]
    assert _ids(_search(client, admin_token, "regal b3")) == [in_both["id"]]
    # Tokens may come from different fields: name + Lagerort.
    assert _ids(_search(client, admin_token, "hohlwanddose b3")) == [in_both["id"]]


def test_q_tokens_may_split_across_name_and_supplier_number(
    client: TestClient, admin_token: str
) -> None:
    """'Wago 26190' — the brand is in the name, the number on the link. Every
    token must match SOMETHING, and only then the article is a hit. A token
    that is a code matches without its punctuation too."""

    unielektro = _supplier(client, admin_token, "Unielektro")
    wago = _article(client, admin_token, "Verbindungsklemme 5-fach", manufacturer="WAGO")
    other = _article(client, admin_token, "Verbindungsklemme 3-fach", manufacturer="WAGO")
    _link(client, admin_token, wago["id"], unielektro["id"], "26-190")
    _link(client, admin_token, other["id"], unielektro["id"], "26-188")

    for typed in ("wago 26-190", "WAGO 26190", "26190 klemme"):
        rows = _search(client, admin_token, typed)
        assert _ids(rows) == [wago["id"]], typed
        assert rows[0]["matched_supplier_article_no"] == "26-190", typed

    assert _search(client, admin_token, "wago 99999") == []

    # A plain name search reports no supplier number: nothing came from one.
    rows = _search(client, admin_token, "Verbindungsklemme")
    assert set(_ids(rows)) == {wago["id"], other["id"]}
    assert all(row["matched_supplier_article_no"] is None for row in rows)


def test_q_ranks_an_exact_code_above_a_longer_number_containing_it(
    client: TestClient, admin_token: str
) -> None:
    """The phone asks for ten rows; the exact number must not fall off the end
    because a longer number sorts first by name."""

    unielektro = _supplier(client, admin_token, "Unielektro")
    longer = _article(client, admin_token, "Aderendhülse 1,5 grau")
    exact = _article(client, admin_token, "Zugentlastung M20")
    _link(client, admin_token, longer["id"], unielektro["id"], "1261-90")
    _link(client, admin_token, exact["id"], _supplier(client, admin_token, "Sonepar")["id"], "26-190")

    rows = _search(client, admin_token, "26190")
    assert _ids(rows) == [exact["id"], longer["id"]]
    assert _ids(_search(client, admin_token, "26190", limit=1)) == [exact["id"]]


def test_q_wildcards_are_literal(client: TestClient, admin_token: str) -> None:
    _article(client, admin_token, "Kabelbinder 200 mm")
    assert _search(client, admin_token, "%") == []
    assert _search(client, admin_token, "_") == []


def test_q_keeps_the_kind_and_archived_filters(client: TestClient, admin_token: str) -> None:
    unielektro = _supplier(client, admin_token, "Unielektro")
    machine = _article(client, admin_token, "Bohrhammer", is_serialized=True)
    _link(client, admin_token, machine["id"], unielektro["id"], "BH-1")
    archived = _article(client, admin_token, "Altes Netzteil")
    _link(client, admin_token, archived["id"], unielektro["id"], "BH-2")
    client.delete(f"/api/werkstatt/articles/{archived['id']}", headers=auth_headers(admin_token))

    assert _search(client, admin_token, "bh1", kind="consumable") == []
    assert _ids(_search(client, admin_token, "bh1", kind="machine")) == [machine["id"]]
    assert _search(client, admin_token, "bh2") == []
    assert _ids(_search(client, admin_token, "bh2", include_archived="true")) == [archived["id"]]


# ──────────────────────────────────────────────────────────────────────────
# Scan cascade — the supplier step
# ──────────────────────────────────────────────────────────────────────────


def test_scan_resolves_a_supplier_number_in_another_case_or_punctuation(
    client: TestClient, admin_token: str
) -> None:
    """The rack reader sends 'AB-1234' for a label that says 'ab-12/34'."""

    supplier = _supplier(client, admin_token, "Unielektro")
    article = _article(client, admin_token, "Leitungsschutzschalter B16")
    _link(client, admin_token, article["id"], supplier["id"], "ab-12/34")

    for scanned in ("ab-12/34", "AB-12/34", "AB-1234", "AB1234", "ab 12 34"):
        data = _resolve(client, admin_token, scanned)
        assert data["kind"] == "werkstatt_article", scanned
        assert data["matched_by"] == "supplier_no", scanned
        assert data["article"]["id"] == article["id"], scanned


def test_scan_exact_supplier_number_still_wins_and_ambiguity_is_never_guessed(
    client: TestClient, admin_token: str
) -> None:
    """Two suppliers may legitimately use 'ab-1' and 'AB-1' for different
    products. The exact spelling picks its own; anything looser that names
    two articles resolves to nothing rather than to a coin toss."""

    first_supplier = _supplier(client, admin_token, "Unielektro")
    second_supplier = _supplier(client, admin_token, "Sonepar")
    lower = _article(client, admin_token, "Artikel klein")
    upper = _article(client, admin_token, "Artikel gross")
    _link(client, admin_token, lower["id"], first_supplier["id"], "ab-1")
    _link(client, admin_token, upper["id"], second_supplier["id"], "AB-1")

    assert _resolve(client, admin_token, "ab-1")["article"]["id"] == lower["id"]
    assert _resolve(client, admin_token, "AB-1")["article"]["id"] == upper["id"]
    assert _resolve(client, admin_token, "Ab-1")["kind"] == "not_found"
    assert _resolve(client, admin_token, "AB1")["kind"] == "not_found"


def test_scan_punctuation_fallback_refuses_two_articles(
    client: TestClient, admin_token: str
) -> None:
    first_supplier = _supplier(client, admin_token, "Unielektro")
    second_supplier = _supplier(client, admin_token, "Sonepar")
    one = _article(client, admin_token, "Eins")
    two = _article(client, admin_token, "Zwei")
    _link(client, admin_token, one["id"], first_supplier["id"], "77-12")
    _link(client, admin_token, two["id"], second_supplier["id"], "77.12")

    assert _resolve(client, admin_token, "7712")["kind"] == "not_found"
    # Both numbers on ONE article are not ambiguous.
    _link(client, admin_token, one["id"], _supplier(client, admin_token, "Rexel")["id"], "88-12")
    _link(client, admin_token, one["id"], _supplier(client, admin_token, "Hagemeyer")["id"], "88/12")
    assert _resolve(client, admin_token, "8812")["article"]["id"] == one["id"]


def test_scan_a_loose_supplier_number_never_beats_a_machine_serial(
    client: TestClient, admin_token: str
) -> None:
    """A nameplate serial is lookup-only at the rack; a supplier number books
    stock out. The machine's exact serial must win over another article's
    number that only matches once case or punctuation is ignored — otherwise
    scanning the drill books an unrelated consumable out."""

    supplier = _supplier(client, admin_token, "Unielektro")
    consumable = _article(client, admin_token, "Kabelbinder 200 mm")
    _link(client, admin_token, consumable["id"], supplier["id"], "12345678")
    other = _article(client, admin_token, "Aderendhülsen")
    _link(client, admin_token, other["id"], _supplier(client, admin_token, "Sonepar")["id"], "SN-AB12")
    drill = _machine(client, admin_token, _article(client, admin_token, "Bohrhammer")["id"], "1234-5678")
    saw = _machine(client, admin_token, _article(client, admin_token, "Handkreissäge")["id"], "sn-ab12")

    for scanned, machine in (("1234-5678", drill), ("sn-ab12", saw)):
        data = _resolve(client, admin_token, scanned)
        assert data["kind"] == "machine", scanned
        assert data["matched_by"] == "serial_number", scanned
        assert data["machine"]["id"] == machine["id"], scanned

    # With no exact answer anywhere the loose spellings still reach the articles.
    assert _resolve(client, admin_token, "1234.5678")["article"]["id"] == consumable["id"]
    assert _resolve(client, admin_token, "SN-ab12")["article"]["id"] == other["id"]


def test_scan_an_exact_catalog_number_beats_a_loose_supplier_number(
    client: TestClient, admin_token: str
) -> None:
    """A Datanorm row carrying exactly the scanned code is a better answer
    than a stocked article whose number only matches without punctuation."""

    unielektro = _supplier(client, admin_token, "Unielektro")
    sonepar = _supplier(client, admin_token, "Sonepar")
    stocked = _article(client, admin_token, "Abzweigdose")
    _link(client, admin_token, stocked["id"], unielektro["id"], "4711.00")
    by_ean = _article(client, admin_token, "Schalter")
    _link(client, admin_token, by_ean["id"], unielektro["id"], "4011377-000017")
    _catalog_row(sonepar["id"], article_no="4711-00", name="Andere Ware", ean="4011377000017")

    data = _resolve(client, admin_token, "4711-00")
    assert data["kind"] == "catalog_match"
    assert data["matched_by"] == "catalog_article_no"
    data = _resolve(client, admin_token, "4011377000017")
    assert data["kind"] == "catalog_match"
    assert data["matched_by"] == "catalog_ean"

    assert _resolve(client, admin_token, "471100")["article"]["id"] == stocked["id"]


def test_lookup_reaches_the_same_supplier_fallback(client: TestClient, admin_token: str) -> None:
    """The Bestand page's scan handler goes through /articles/lookup."""

    supplier = _supplier(client, admin_token, "Unielektro")
    article = _article(client, admin_token, "Steckdose UP")
    _link(client, admin_token, article["id"], supplier["id"], "ue-5501.2")

    resp = client.get(
        "/api/werkstatt/articles/lookup",
        headers=auth_headers(admin_token),
        params={"code": "UE55012", "allow_external": "false"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["kind"] == "existing"
    assert body["article"]["id"] == article["id"]


# ──────────────────────────────────────────────────────────────────────────
# Writing the number — link-catalog and the link endpoints
# ──────────────────────────────────────────────────────────────────────────


def test_link_catalog_writes_the_supplier_link_and_folds_same_ean_rows(
    client: TestClient, admin_token: str
) -> None:
    unielektro = _supplier(client, admin_token, "Unielektro")
    sonepar = _supplier(client, admin_token, "Sonepar")
    hero = _catalog_row(
        unielektro["id"], article_no=" UE 4711 ", name="Schuko-Steckdose UP", ean="4011377098765"
    )
    # Padded like the hero: the folded link is stored trimmed as well.
    _catalog_row(sonepar["id"], article_no=" S-4711 ", name="Steckdose Schuko", ean="4011377098765")
    article = _article(client, admin_token, "Steckdose (von Hand angelegt)")

    linked = client.post(
        f"/api/werkstatt/articles/{article['id']}/link-catalog",
        headers=auth_headers(admin_token),
        json={"catalog_item_id": hero},
    )
    assert linked.status_code == 200, linked.text
    body = linked.json()
    assert body["ean"] == "4011377098765"
    links = {row["supplier_id"]: row for row in body["suppliers"]}
    assert links[unielektro["id"]]["supplier_article_no"] == "UE 4711"
    assert links[unielektro["id"]]["source_catalog_item_id"] == hero
    assert links[unielektro["id"]]["is_preferred"] is True
    assert links[sonepar["id"]]["supplier_article_no"] == "S-4711"
    assert links[sonepar["id"]]["is_preferred"] is False

    assert _ids(_search(client, admin_token, "ue4711")) == [article["id"]]
    scanned = _resolve(client, admin_token, "UE4711")
    assert scanned["kind"] == "werkstatt_article"
    assert scanned["article"]["id"] == article["id"]

    # Idempotent: linking again changes nothing and creates nothing.
    again = client.post(
        f"/api/werkstatt/articles/{article['id']}/link-catalog",
        headers=auth_headers(admin_token),
        json={"catalog_item_id": hero},
    )
    assert again.status_code == 200, again.text
    assert len(again.json()["suppliers"]) == 2


def test_link_catalog_upserts_an_existing_link_and_keeps_the_old_number(
    client: TestClient, admin_token: str
) -> None:
    unielektro = _supplier(client, admin_token, "Unielektro")
    rexel = _supplier(client, admin_token, "Rexel")
    article = _article(client, admin_token, "Abzweigkasten")
    _post_link(client, admin_token, article["id"], rexel["id"], supplier_article_no="R-1", is_preferred=True)
    _post_link(client, admin_token, article["id"], unielektro["id"], supplier_article_no="26190")
    catalog = _catalog_row(unielektro["id"], article_no="26191", name="Abzweigkasten AP")

    linked = client.post(
        f"/api/werkstatt/articles/{article['id']}/link-catalog",
        headers=auth_headers(admin_token),
        json={"catalog_item_id": catalog},
    )
    assert linked.status_code == 200, linked.text
    links = {row["supplier_id"]: row for row in linked.json()["suppliers"]}
    assert links[unielektro["id"]]["supplier_article_no"] == "26191"
    assert links[unielektro["id"]]["source_catalog_item_id"] == catalog
    assert "26190" in (links[unielektro["id"]]["notes"] or "")
    # The preference the person chose is not touched.
    assert links[rexel["id"]]["is_preferred"] is True
    assert links[unielektro["id"]]["is_preferred"] is False


def test_link_catalog_refuses_a_number_another_article_already_carries(
    client: TestClient, admin_token: str
) -> None:
    unielektro = _supplier(client, admin_token, "Unielektro")
    holder = _article(client, admin_token, "Schon angelegt")
    _link(client, admin_token, holder["id"], unielektro["id"], "UE-1")
    catalog = _catalog_row(unielektro["id"], article_no="UE-1", name="Katalogzeile", unit="m")
    article = _article(client, admin_token, "Doppelt angelegt", unit=None)

    refused = client.post(
        f"/api/werkstatt/articles/{article['id']}/link-catalog",
        headers=auth_headers(admin_token),
        json={"catalog_item_id": catalog},
    )
    assert refused.status_code == 400, refused.text
    detail = refused.json()["detail"]
    assert holder["article_number"] in detail and "UE-1" in detail

    unchanged = client.get(f"/api/werkstatt/articles/{article['id']}", headers=auth_headers(admin_token))
    assert unchanged.json()["source_catalog_item_id"] is None
    assert unchanged.json()["suppliers"] == []


def test_link_catalog_refuses_an_ean_another_article_carries(
    client: TestClient, admin_token: str
) -> None:
    """The row describes a product already stocked under its EAN. Committing
    would trip the unique index; the person is told where the product is."""

    unielektro = _supplier(client, admin_token, "Unielektro")
    holder = _article(client, admin_token, "Mit EAN angelegt", ean="4011377012345")
    catalog = _catalog_row(unielektro["id"], article_no="UE-77", name="Katalogzeile", ean="4011377012345")
    article = _article(client, admin_token, "Ohne EAN angelegt")

    refused = client.post(
        f"/api/werkstatt/articles/{article['id']}/link-catalog",
        headers=auth_headers(admin_token),
        json={"catalog_item_id": catalog},
    )
    assert refused.status_code == 400, refused.text
    assert holder["article_number"] in refused.json()["detail"]
    assert _links_by_supplier(client, admin_token, article["id"]) == {}


def test_link_catalog_still_links_when_the_same_ean_fold_cannot(
    client: TestClient, admin_token: str
) -> None:
    """A second supplier's same-EAN row carries a number a third article (made
    by hand, without the EAN) already holds. The fold is dropped; the link
    the person asked for is not."""

    unielektro = _supplier(client, admin_token, "Unielektro")
    sonepar = _supplier(client, admin_token, "Sonepar")
    hero = _catalog_row(unielektro["id"], article_no="UE-5", name="Dimmer UP", ean="4011377055555")
    _catalog_row(sonepar["id"], article_no="S-5", name="Dimmer", ean="4011377055555")
    third = _article(client, admin_token, "Dimmer (von Hand)")
    _link(client, admin_token, third["id"], sonepar["id"], "S-5")
    article = _article(client, admin_token, "Dimmer")

    linked = client.post(
        f"/api/werkstatt/articles/{article['id']}/link-catalog",
        headers=auth_headers(admin_token),
        json={"catalog_item_id": hero},
    )
    assert linked.status_code == 200, linked.text
    links = {row["supplier_id"]: row for row in linked.json()["suppliers"]}
    assert set(links) == {unielektro["id"]}
    assert links[unielektro["id"]]["supplier_article_no"] == "UE-5"
    assert linked.json()["ean"] == "4011377055555"
    assert _links_by_supplier(client, admin_token, third["id"])[sonepar["id"]]["supplier_article_no"] == "S-5"


def test_from_catalog_still_creates_when_the_same_ean_fold_cannot(
    client: TestClient, admin_token: str
) -> None:
    """Creating from the catalogue folds the same-EAN rows too. One of their
    numbers already sitting on a hand-made third article used to be a 500 —
    the article the person asked for is created, the fold is dropped."""

    unielektro = _supplier(client, admin_token, "Unielektro")
    sonepar = _supplier(client, admin_token, "Sonepar")
    hero = _catalog_row(unielektro["id"], article_no="UE-6", name="Taster UP", ean="4011377066666")
    _catalog_row(sonepar["id"], article_no="S-6", name="Taster", ean="4011377066666")
    third = _article(client, admin_token, "Taster (von Hand)")
    _link(client, admin_token, third["id"], sonepar["id"], "S-6")

    created = client.post(
        "/api/werkstatt/articles/from-catalog",
        headers=auth_headers(admin_token),
        json={"catalog_item_id": hero, "stock_total": 4},
    )
    assert created.status_code == 200, created.text
    body = created.json()
    assert body["ean"] == "4011377066666"
    assert body["stock_total"] == 4
    links = {row["supplier_id"]: row for row in body["suppliers"]}
    assert set(links) == {unielektro["id"]}
    assert links[unielektro["id"]]["supplier_article_no"] == "UE-6"
    assert _links_by_supplier(client, admin_token, third["id"])[sonepar["id"]]["supplier_article_no"] == "S-6"


def test_link_catalog_without_a_supplier_still_links(client: TestClient, admin_token: str) -> None:
    """A filesystem-imported row has no supplier: nothing to link, no error."""

    catalog = _catalog_row(None, article_no="FS-1", name="Dateikatalog", unit="m")
    article = _article(client, admin_token, "Irgendwas", unit=None)
    linked = client.post(
        f"/api/werkstatt/articles/{article['id']}/link-catalog",
        headers=auth_headers(admin_token),
        json={"catalog_item_id": catalog},
    )
    assert linked.status_code == 200, linked.text
    assert linked.json()["source_catalog_item_id"] == catalog
    assert linked.json()["suppliers"] == []


def test_supplier_link_create_and_update_strip_the_number(
    client: TestClient, admin_token: str
) -> None:
    supplier = _supplier(client, admin_token, "Unielektro")
    article = _article(client, admin_token, "Lüsterklemme")

    created = _post_link(client, admin_token, article["id"], supplier["id"], supplier_article_no=" 4711 ")
    assert created.status_code == 200, created.text
    assert created.json()["supplier_article_no"] == "4711"
    assert _resolve(client, admin_token, "4711")["article"]["id"] == article["id"]

    link_id = created.json()["id"]
    url = f"/api/werkstatt/articles/{article['id']}/suppliers/{link_id}"
    patched = client.patch(url, headers=auth_headers(admin_token), json={"supplier_article_no": "  4712\t"})
    assert patched.status_code == 200, patched.text
    assert patched.json()["supplier_article_no"] == "4712"

    cleared = client.patch(url, headers=auth_headers(admin_token), json={"supplier_article_no": "   "})
    assert cleared.status_code == 200, cleared.text
    assert cleared.json()["supplier_article_no"] is None


def test_supplier_link_number_clash_is_a_readable_refusal(
    client: TestClient, admin_token: str
) -> None:
    """One number per supplier is a database rule; breaking it used to be a 500."""

    supplier = _supplier(client, admin_token, "Unielektro")
    holder = _article(client, admin_token, "Erster")
    second = _article(client, admin_token, "Zweiter")
    _link(client, admin_token, holder["id"], supplier["id"], "UE-9")

    clash = _post_link(client, admin_token, second["id"], supplier["id"], supplier_article_no="UE-9 ")
    assert clash.status_code == 400, clash.text
    assert holder["article_number"] in clash.json()["detail"]

    own = _link(client, admin_token, second["id"], supplier["id"], "UE-10")
    patched = client.patch(
        f"/api/werkstatt/articles/{second['id']}/suppliers/{own['id']}",
        headers=auth_headers(admin_token),
        json={"supplier_article_no": "UE-9"},
    )
    assert patched.status_code == 400, patched.text
    assert holder["article_number"] in patched.json()["detail"]
    assert _links_by_supplier(client, admin_token, second["id"])[supplier["id"]]["supplier_article_no"] == "UE-10"
