"""The cabinet catalogue API (docs/PANEL_ENCLOSURE.md §3.3–§3.5, §7).

Reading is open to every login: a fitter planning a board needs the cabinets.
Writing is the Werkstatt's (``werkstatt:manage``), audited, and bounded by
the change rules that keep stored boards resolvable — a key is never removed,
and a code that boards use never changes its size, family or meter places.
All articles, boards and custom codes are invented; the built-in codes are
Hager's.
"""

from __future__ import annotations

import copy
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.core.db import SessionLocal
from app.core.time import utcnow
from app.models.entities import AuditLog, PanelCatalogEntry, PanelPlan, WerkstattArticle
from app.models.werkstatt import WerkstattArticleSupplier, WerkstattSupplier
from app.services import panel_enclosure_catalog as catalog_service
from app.services.panel_enclosure_catalog import (
    EnclosureCatalog,
    builtin_catalog,
    load_catalog,
    match_articles_by_number,
)
from app.services.schaltplan_material import set_mapping
from tests.partner_portal_helpers import portal_login
from tests.panel_enclosure_helpers import (
    admin_id,
    article,
    auth,
    cabinet_document,
    create_panel,
    custom_enclosure_spec,
    custom_module_spec,
    employee,
    hidden_project,
    store_directly,
)

CATALOG = "/api/schaltplan/enclosure-catalog"
KEY_KEPT = "Schlüssel „{key}“ bleibt — ausmustern statt löschen oder umbenennen."


def _get(client: TestClient, token: str) -> dict:
    resp = client.get(CATALOG, headers=auth(token))
    assert resp.status_code == 200, resp.text
    return resp.json()


def _entry(body: dict, code: str) -> dict:
    return next(entry for entry in [*body["enclosures"], *body["modules"]] if entry["code"] == code)


def _post(client: TestClient, token: str, spec: dict, entry_type: str = "module"):
    return client.post(CATALOG, headers=auth(token), json={"entry_type": entry_type, "spec": spec})


def _put(client: TestClient, token: str, code: str, spec: dict, entry_type: str = "module"):
    return client.put(f"{CATALOG}/{code}", headers=auth(token), json={"entry_type": entry_type, "spec": spec})


def _builtin(code: str) -> dict:
    return copy.deepcopy(builtin_catalog().entries[code].spec)


def _map(key: str, article_id: int) -> None:
    with SessionLocal() as db:
        set_mapping(db, key=key, article=db.get(WerkstattArticle, article_id), user_id=None)
        db.commit()


def _board_using(client: TestClient, token: str, module_code: str, designation: str) -> dict:
    document = cabinet_document()
    document["enclosure"]["modules"][1]["code"] = module_code
    panel = create_panel(client, token, designation=designation)
    store_directly(panel["id"], document)
    return panel


# ── reading ──────────────────────────────────────────────────────────────────


def test_any_login_reads_the_catalogue_without_the_manager_extras(client: TestClient, admin_token: str) -> None:
    article("Hager ZU37XS Verteilerfeld PE/N senkrecht", stock=2, manufacturer="Hager")
    fitter = employee(client, admin_token, "monteur@example.com")

    body = _get(client, fitter)
    assert body["can_manage"] is False
    assert body["uncatalogued"] == []
    assert [entry["code"] for entry in body["enclosures"]] == [
        "ZB32S", "ZB33S", "ZB34S", "ZB35S", "ZB52S", "ZB53S", "ZB54S", "ZB55S",
    ]
    zb33s = _entry(body, "ZB33S")
    assert {key: zb33s[key] for key in zb33s if key != "spec"} == {
        "code": "ZB33S", "entry_type": "enclosure", "source": "builtin", "archived": False, "invalid": False,
        "article": None, "article_source": None, "stock_available": 0, "recent_count": 0,
        "last_used_at": None, "used_by_plans": 0,
    }
    assert zb33s["spec"] == builtin_catalog().enclosure("ZB33S")
    assert [entry["code"] for entry in body["modules"]][:3] == ["ZH3EL27", "ZH3EL22", "ZH3EL16"]


def test_a_mapped_article_with_stock_sorts_its_module_first(client: TestClient, admin_token: str) -> None:
    on_shelf = article("Verteilerfeld 7-reihig mit PE/N", stock=3)
    empty_shelf = article("Verteilerfeld 9-reihig mit PE/N")
    _map("module:ZU37KS", on_shelf)
    _map("module:ZU59KS", empty_shelf)

    body = _get(client, admin_token)
    first = body["modules"][0]
    assert first["code"] == "ZU37KS"
    assert (first["article"]["id"], first["article_source"], first["stock_available"]) == (on_shelf, "mapping", 3)
    zu59 = _entry(body, "ZU59KS")
    assert (zu59["article"]["id"], zu59["stock_available"]) == (empty_shelf, 0)
    # No stock, no recent use: it keeps its catalogue place.
    codes = [entry["code"] for entry in body["modules"]]
    assert codes.index("ZU59KS") > codes.index("ZU37RK")


def test_auto_match_is_by_whole_article_number_token(client: TestClient, admin_token: str) -> None:
    article("Hager ZH3EH16N Komplettfeld eHZ", stock=2, manufacturer="Hager")
    named = article("Hager ZU59KS – Verteilerfeld 1350", stock=1, manufacturer="Hager")
    archived = article("Hager ZU37RK Verteilerfeld", stock=5, manufacturer="Hager")
    by_supplier = article("Zählerfeld eHZ 10 mm²", stock=4)
    with SessionLocal() as db:
        db.get(WerkstattArticle, archived).is_archived = True
        supplier = WerkstattSupplier(name="Großhandel Beispiel")
        db.add(supplier)
        db.flush()
        db.add(WerkstattArticleSupplier(article_id=by_supplier, supplier_id=supplier.id, supplier_article_no="ZH3EL27"))
        db.commit()
        matched = match_articles_by_number(db, ["ZH3EH16", "ZU59KS", "ZU37RK", "ZH3EL27"])
        assert {number: row.id for number, row in matched.items()} == {"ZU59KS": named, "ZH3EL27": by_supplier}

    body = _get(client, admin_token)
    assert _entry(body, "ZH3EH16")["article"] is None
    assert (_entry(body, "ZU59KS")["article"]["id"], _entry(body, "ZU59KS")["article_source"]) == (named, "auto")
    assert (_entry(body, "ZH3EL27")["article"]["id"], _entry(body, "ZH3EL27")["stock_available"]) == (by_supplier, 4)
    assert _entry(body, "ZU37RK")["article"] is None
    assert [entry["code"] for entry in body["modules"]][:2] == ["ZH3EL27", "ZU59KS"]


def test_the_matcher_stays_cheap_whatever_numbers_it_is_handed(
    client: TestClient, admin_token: str, monkeypatch
) -> None:
    """One or two characters name no article but match nearly every name
    (one LIKE term each, then a regex over every hit, on every list read)."""
    article("Hager e Klemme AB 12", stock=1, manufacturer="Hager")
    with SessionLocal() as db:
        assert match_articles_by_number(db, ["e", "AB", "12", " "]) == {}

    first = article("Hager ZA100 Testfeld", stock=1, manufacturer="Hager")
    second = article("Hager ZB200 Testfeld", stock=1, manufacturer="Hager")
    article("Hager ZC300 Testfeld", stock=1, manufacturer="Hager")
    monkeypatch.setattr(catalog_service, "MAX_MATCH_NUMBERS", 2)
    with SessionLocal() as db:
        matched = match_articles_by_number(db, ["ZC300", "ZB200", "ZA100", "ZA100"])
    # Bounded, and deterministically so: the first numbers in sorted order.
    assert {number: row.id for number, row in matched.items()} == {"ZA100": first, "ZB200": second}


def test_recent_use_counts_only_boards_the_caller_can_see(client: TestClient, admin_token: str) -> None:
    fitter = employee(client, admin_token, "monteur@example.com")
    create_panel(client, admin_token, cabinet_document(), designation="ZS1")
    hidden = create_panel(client, admin_token, designation="ZS2")
    hidden_doc = cabinet_document(meter_module="ZH3EL27")
    store_directly(hidden["id"], hidden_doc)
    stale = create_panel(client, admin_token, designation="ZS3")
    store_directly(stale["id"], cabinet_document(cabinet="ZB52S", meter_module="ZH5EL27"))
    with SessionLocal() as db:
        db.get(PanelPlan, hidden["id"]).project_id = hidden_project()
        # A board last touched over a year ago is not "zuletzt verwendet".
        db.get(PanelPlan, stale["id"]).updated_at = utcnow() - timedelta(days=400)
        db.commit()

    seen = _get(client, fitter)
    assert (_entry(seen, "ZH3EH16")["recent_count"], _entry(seen, "ZH3EL27")["recent_count"]) == (1, 0)
    assert _entry(seen, "ZB33S")["recent_count"] == 1
    assert _entry(seen, "ZH5EL27")["recent_count"] == 0
    # used_by_plans counts every board: it is what freezes a code's size.
    assert (_entry(seen, "ZB33S")["used_by_plans"], _entry(seen, "ZH3EL27")["used_by_plans"]) == (2, 1)
    assert _entry(seen, "ZB52S")["used_by_plans"] == 1
    assert _entry(seen, "ZH3EH16")["last_used_at"] is not None
    assert [entry["code"] for entry in seen["modules"]][:2] == ["ZH3EH16", "ZU37KS"]
    assert seen["enclosures"][0]["code"] == "ZB33S"

    everything = _get(client, admin_token)
    assert (_entry(everything, "ZB33S")["recent_count"], _entry(everything, "ZH3EL27")["recent_count"]) == (2, 1)


def test_managers_see_hager_stock_that_the_catalogue_lacks(client: TestClient, admin_token: str) -> None:
    xs = article("Hager ZU37XS Verteilerfeld PE/N senkrecht", stock=2, manufacturer="Hager")
    two_field = article("Komplettfeld ZK3EL22T 2 Zählerplätze", stock=1, manufacturer="Hager")
    article("Hager ZU37KS Verteilerfeld", stock=1, manufacturer="Hager")
    article("Hager ZU59XS Verteilerfeld", manufacturer="Hager")
    article("Abzweigdose ZX12 grau", stock=5, manufacturer="Beispiel GmbH")
    gone = article("Hager ZU59APZ9 Kommunikationsfeld", stock=1, manufacturer="Hager")
    with SessionLocal() as db:
        db.get(WerkstattArticle, gone).is_archived = True
        db.commit()

    body = _get(client, admin_token)
    assert body["can_manage"] is True
    assert sorted((row["code_guess"], row["article"]["id"]) for row in body["uncatalogued"]) == [
        ("ZK3EL22T", two_field), ("ZU37XS", xs),
    ]


def test_a_partner_login_cannot_read_the_catalogue(client: TestClient, admin_token: str) -> None:
    _, _, partner = portal_login(client, admin_token)
    assert client.get(CATALOG, headers=auth(partner)).status_code == 403


# ── writing ──────────────────────────────────────────────────────────────────


def test_catalogue_writes_need_werkstatt_manage(client: TestClient, admin_token: str) -> None:
    fitter = employee(client, admin_token, "monteur@example.com")
    assert _post(client, fitter, custom_module_spec()).status_code == 403
    assert _put(client, fitter, "ZU37KS", _builtin("ZU37KS")).status_code == 403
    assert client.patch(f"{CATALOG}/ZU37KS", headers=auth(fitter), json={"archived": True}).status_code == 403
    assert client.delete(f"{CATALOG}/ZU37KS/override", headers=auth(fitter)).status_code == 403
    with SessionLocal() as db:
        assert db.scalars(select(PanelCatalogEntry)).all() == []


def test_create_and_refuse_a_code_twice(client: TestClient, admin_token: str) -> None:
    created = _post(client, admin_token, custom_module_spec())
    assert created.status_code == 201, created.text
    body = created.json()
    assert (body["code"], body["entry_type"], body["source"], body["used_by_plans"]) == ("ZX37TEST", "module", "custom", 0)
    assert body["spec"]["zones"][0]["rails"][0]["mount"] == "rail"
    listed = _get(client, admin_token)
    assert listed["modules"][-1]["code"] == "ZX37TEST"

    for code in ("ZX37TEST", " zx37test ", "ZU37KS"):
        again = _post(client, admin_token, custom_module_spec(code=code))
        assert again.status_code == 409, again.text
        assert again.json()["detail"] == f"Den Code {code.strip().upper()} gibt es schon."

    cabinet = _post(client, admin_token, custom_enclosure_spec(), entry_type="enclosure")
    assert cabinet.status_code == 201, cabinet.text
    assert _get(client, admin_token)["enclosures"][-1]["code"] == "ZX33TEST"


def test_override_a_built_in_and_reset_it(client: TestClient, admin_token: str) -> None:
    corrected = _builtin("ZU37KS")
    corrected["name"] = "Verteilerfeld 7 Reihen, PE/N waagerecht (geprüft)"
    corrected["fittings"][0]["article_no"] = "ZZ12V"
    put = _put(client, admin_token, "ZU37KS", corrected)
    assert put.status_code == 200, put.text
    assert (put.json()["source"], put.json()["spec"]["name"]) == ("override", corrected["name"])
    assert _entry(_get(client, admin_token), "ZU37KS")["spec"]["fittings"][0]["article_no"] == "ZZ12V"

    reset = client.delete(f"{CATALOG}/ZU37KS/override", headers=auth(admin_token))
    assert reset.status_code == 200, reset.text
    assert (reset.json()["source"], reset.json()["spec"]) == ("builtin", builtin_catalog().module("ZU37KS"))
    assert client.delete(f"{CATALOG}/ZU37KS/override", headers=auth(admin_token)).status_code == 404

    assert _post(client, admin_token, custom_module_spec()).status_code == 201
    refused = client.delete(f"{CATALOG}/ZX37TEST/override", headers=auth(admin_token))
    assert refused.status_code == 409
    assert refused.json()["detail"] == "Eigene Einträge werden archiviert, nicht gelöscht — Verteilerpläne verweisen darauf."


def test_put_answers_404_and_400_for_wrong_codes(client: TestClient, admin_token: str) -> None:
    missing = _put(client, admin_token, "ZX00NONE", custom_module_spec(code="ZX00NONE"))
    assert missing.status_code == 404
    assert missing.json()["detail"] == "Katalogeintrag nicht gefunden."
    mismatch = _put(client, admin_token, "ZU37KS", _builtin("ZU37RK"))
    assert mismatch.status_code == 400, mismatch.text
    assert client.patch(f"{CATALOG}/ZX00NONE", headers=auth(admin_token), json={"archived": True}).status_code == 404


def test_entry_type_never_changes(client: TestClient, admin_token: str) -> None:
    assert _post(client, admin_token, custom_module_spec()).status_code == 201
    resp = _put(client, admin_token, "ZX37TEST", custom_enclosure_spec(code="ZX37TEST"), entry_type="enclosure")
    assert resp.status_code == 400
    assert resp.json()["detail"] == "Der Typ eines Eintrags lässt sich nicht ändern."


def test_archived_entries_stay_listed(client: TestClient, admin_token: str) -> None:
    assert _post(client, admin_token, custom_module_spec()).status_code == 201
    for code in ("ZX37TEST", "ZB32S"):
        archived = client.patch(f"{CATALOG}/{code}", headers=auth(admin_token), json={"archived": True})
        assert archived.status_code == 200, archived.text
        assert archived.json()["archived"] is True
    body = _get(client, admin_token)
    assert _entry(body, "ZX37TEST")["archived"] is True
    assert (_entry(body, "ZB32S")["archived"], _entry(body, "ZB32S")["source"]) == (True, "builtin")
    with SessionLocal() as db:
        catalog = load_catalog(db)
        assert catalog.known("ZB32S") and catalog.enclosure("ZB32S") is not None

    restored = client.patch(f"{CATALOG}/ZX37TEST", headers=auth(admin_token), json={"archived": False})
    assert restored.json()["archived"] is False


def test_keys_are_append_only(client: TestClient, admin_token: str) -> None:
    renamed = _builtin("ZU37KS")
    renamed["zones"][0]["rails"][6]["key"] = "r8"
    resp = _put(client, admin_token, "ZU37KS", renamed)
    assert resp.status_code == 409
    assert resp.json()["detail"] == KEY_KEPT.format(key="r7")

    no_pe_n = _builtin("ZU37KS")
    no_pe_n["fittings"] = []
    assert _put(client, admin_token, "ZU37KS", no_pe_n).json()["detail"] == KEY_KEPT.format(key="pe_n")

    other_kind = _builtin("ZH3EH16")
    next(f for f in other_kind["fittings"] if f["key"] == "hs")["device"]["kind"] = "sls"
    resp = _put(client, admin_token, "ZH3EH16", other_kind)
    assert resp.status_code == 409
    assert resp.json()["detail"] == KEY_KEPT.format(key="hs")

    retired = _builtin("ZU37KS")
    retired["zones"][0]["rails"][6]["retired"] = True
    ok = _put(client, admin_token, "ZU37KS", retired)
    assert ok.status_code == 200, ok.text
    assert ok.json()["spec"]["zones"][0]["rails"][6] == {"key": "r7", "unit": 6, "ple": 12, "mount": "rail", "retired": True}


def test_size_family_and_meter_places_are_frozen_while_used(client: TestClient, admin_token: str) -> None:
    assert _post(client, admin_token, custom_module_spec()).status_code == 201
    _board_using(client, admin_token, "ZX37TEST", "ZS1")
    _board_using(client, admin_token, "ZX37TEST", "ZS2")

    taller = custom_module_spec(height_units=3)
    taller["zones"][0]["units"] = 3
    taller["zones"][0]["rails"].append({"key": "r3", "unit": 2, "ple": 12})
    resp = _put(client, admin_token, "ZX37TEST", taller)
    assert resp.status_code == 409
    assert resp.json()["detail"] == (
        "In 2 Verteilerplänen verwendet — Größe, Familie und Zählerplätze bleiben. Als neuen Eintrag anlegen."
    )
    # Positions and labels are corrections, and stay editable.
    corrected = custom_module_spec(name="Testfeld Verteiler, korrigiert")
    corrected["zones"][0]["rails"][1]["ple"] = 11
    assert _put(client, admin_token, "ZX37TEST", corrected).status_code == 200

    assert _post(client, admin_token, custom_module_spec(code="ZX38TEST")).status_code == 201
    unused = _put(client, admin_token, "ZX38TEST", {**taller, "code": "ZX38TEST", "article_no": "ZX38TEST"})
    assert unused.status_code == 200, unused.text
    assert unused.json()["spec"]["height_units"] == 3


def test_a_used_built_in_keeps_its_meter_places_and_family(client: TestClient, admin_token: str) -> None:
    create_panel(client, admin_token, cabinet_document(meter_module="ZH3EL27"))
    more_places = _builtin("ZH3EL27")
    next(zone for zone in more_places["zones"] if zone["type"] == "ZF")["meter_places"] = 2
    assert _put(client, admin_token, "ZH3EL27", more_places).status_code == 409
    other_family = _builtin("ZU37KS")
    other_family["family"] = "busbar"
    assert _put(client, admin_token, "ZU37KS", other_family).status_code == 409
    cabinet = _builtin("ZB33S")
    cabinet["fields"], cabinet["width_mm"] = 4, 1050
    assert _put(client, admin_token, "ZB33S", cabinet, entry_type="enclosure").status_code == 409


def test_a_reset_that_would_drop_an_added_key_is_refused(client: TestClient, admin_token: str) -> None:
    widened = _builtin("ZU37KS")
    widened["fittings"].append({"key": "label_holder", "label": "Beschriftungsträger", "article_no": None,
                                "removable": False, "device": None, "verified": True})
    assert _put(client, admin_token, "ZU37KS", widened).status_code == 200
    resp = client.delete(f"{CATALOG}/ZU37KS/override", headers=auth(admin_token))
    assert resp.status_code == 409
    assert resp.json()["detail"] == KEY_KEPT.format(key="label_holder")


# ── input limits and German errors ───────────────────────────────────────────


def test_an_oversized_body_is_refused_before_it_is_parsed(client: TestClient, admin_token: str) -> None:
    junk = b"{" + b"x" * (33 * 1024)
    for method, url in (("post", CATALOG), ("put", f"{CATALOG}/ZU37KS")):
        resp = client.request(method, url, headers={**auth(admin_token), "Content-Type": "application/json"}, content=junk)
        assert resp.status_code == 413, resp.text
        assert resp.json()["detail"] == "Eintrag zu groß (max. 32 KB)."
    broken = client.post(CATALOG, headers={**auth(admin_token), "Content-Type": "application/json"}, content=b"{nope")
    assert broken.status_code == 422
    assert broken.json()["detail"] == "Aufbau ungültig: kein gültiges JSON."


def test_a_deeply_nested_body_is_invalid_json_not_a_crash(client: TestClient, admin_token: str) -> None:
    # Under the 32 KB ceiling, but the JSON decoder runs out of stack on it
    # (RecursionError, which is no ValueError).
    for nested in (b"[" * 30_000, b"[" * 16_000 + b"]" * 16_000):
        resp = client.post(CATALOG, headers={**auth(admin_token), "Content-Type": "application/json"}, content=nested)
        assert resp.status_code == 422, resp.text
        assert resp.json()["detail"] == "Aufbau ungültig: kein gültiges JSON."


def _module_with_zones(zones: list[dict], **overrides) -> dict:
    return custom_module_spec(width_fields=3, height_units=9, zones=zones, fittings=[], **overrides)


def _vt_zone(field: int, rails: int) -> dict:
    return {"key": f"vt{field}", "type": "VT", "field": field, "unit": 0, "units": 9,
            "rails": [{"key": f"f{field}r{n}", "unit": n, "ple": 12} for n in range(rails)]}


def test_a_spec_must_fit_what_one_board_can_store(client: TestClient, admin_token: str) -> None:
    """A board stores at most 16 rails and 8 meters per module (§15): a
    catalogue entry with more would place fine and then fail every autosave
    once its 17th rail got a row."""
    too_many_rails = _module_with_zones([_vt_zone(0, 9), _vt_zone(1, 9)])
    resp = _post(client, admin_token, too_many_rails)
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"] == "Aufbau ungültig: zones — höchstens 16 Hutschienen je Modul (hier 18)"

    def meter_zone(field: int, unit: int) -> dict:
        return {"key": f"zf{field}{unit}", "type": "ZF", "field": field, "unit": unit, "units": 2,
                "meter_places": 4, "meter_type": "ehz"}

    def rail_zone(key: str, kind: str, field: int, unit: int, mount: str = "rail") -> dict:
        return {"key": key, "type": kind, "field": field, "unit": unit, "units": 1,
                "rails": [{"key": key, "unit": 0, "ple": 12, "mount": mount}]}

    too_many_places = _module_with_zones(
        [meter_zone(0, 0), meter_zone(1, 0), meter_zone(2, 0), rail_zone("nar", "NAR", 0, 2, "busbar"),
         rail_zone("aar", "AAR", 0, 3)],
        family="meter_ehz",
    )
    resp = _post(client, admin_token, too_many_places)
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"] == "Aufbau ungültig: zones — höchstens 8 Zählerplätze je Modul (hier 12)"

    # Exactly at the ceiling is fine: a 2-field module with 8 + 8 rails.
    assert _post(client, admin_token, _module_with_zones([_vt_zone(0, 8), _vt_zone(1, 8)])).status_code == 201


@pytest.mark.parametrize(
    ("mutate", "detail"),
    [
        (lambda s: s["zones"][0]["rails"][1].update(ple=30), "Aufbau ungültig: zones[0].rails[1].ple — muss zwischen 1 und 24 liegen"),
        (lambda s: s.pop("name"), "Aufbau ungültig: name — fehlt"),
        (lambda s: s["zones"][0].update(metter_places=1), "Aufbau ungültig: zones[0].metter_places — ist kein bekanntes Feld"),
        (lambda s: s["zones"][0]["rails"][1].update(unit=2), "Aufbau ungültig: zones[0].rails[1].unit — liegt außerhalb der Zone (2 Raster)"),
        (lambda s: s["zones"].append({"key": "vt2", "type": "VT", "unit": 1, "units": 1}), "Aufbau ungültig: zones[1] — überlappt zones[0]"),
        (lambda s: s.update(family="garage"), "Aufbau ungültig: family — muss einer der Werte sein: meter_ehz, meter_3p, distribution, distribution_apz, busbar, communication, multimedia, cover"),
        (lambda s: s.update(verified=False), "Aufbau ungültig: unverified — sagt bei „ungeprüft“, was nicht geprüft ist"),
    ],
)
def test_spec_errors_are_german_with_the_json_path(client: TestClient, admin_token: str, mutate, detail: str) -> None:
    spec = custom_module_spec()
    mutate(spec)
    resp = _post(client, admin_token, spec)
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"] == detail


def test_the_envelope_is_checked_too(client: TestClient, admin_token: str) -> None:
    resp = client.post(CATALOG, headers=auth(admin_token), json={"entry_type": "schrank", "spec": custom_module_spec()})
    assert resp.status_code == 422
    assert resp.json()["detail"] == "Aufbau ungültig: entry_type — muss „enclosure“ oder „module“ sein"
    resp = client.post(CATALOG, headers=auth(admin_token), json={"entry_type": "module", "spec": []})
    assert resp.json()["detail"] == "Aufbau ungültig: spec — muss ein Objekt sein"


@pytest.mark.parametrize("url", ["javascript:alert(1)", "http://hager.example/zx37", "data:text/html,x"])
def test_source_links_are_https_only(client: TestClient, admin_token: str, url: str) -> None:
    resp = _post(client, admin_token, custom_module_spec(source_url=url))
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"].startswith("Aufbau ungültig: source_url — ")
    assert _post(client, admin_token, custom_module_spec(source_url="https://hager.example/zx37")).status_code == 201


def test_custom_entries_are_capped(client: TestClient, admin_token: str, monkeypatch) -> None:
    monkeypatch.setattr(catalog_service, "MAX_CUSTOM_ENTRIES", 1)
    assert _post(client, admin_token, custom_module_spec()).status_code == 201
    capped = _post(client, admin_token, custom_module_spec(code="ZX38TEST"))
    assert capped.status_code == 409
    assert capped.json()["detail"] == "Höchstens 1 eigene Einträge im Schrankkatalog."
    # Overriding a built-in is no new entry.
    assert _put(client, admin_token, "ZU37KS", _builtin("ZU37KS")).status_code == 200


# ── audit and robustness ─────────────────────────────────────────────────────


def test_every_catalogue_write_is_audited(client: TestClient, admin_token: str) -> None:
    assert _post(client, admin_token, custom_module_spec()).status_code == 201
    assert _put(client, admin_token, "ZU37KS", _builtin("ZU37KS")).status_code == 200
    client.patch(f"{CATALOG}/ZX37TEST", headers=auth(admin_token), json={"archived": True})
    client.patch(f"{CATALOG}/ZX37TEST", headers=auth(admin_token), json={"archived": False})
    client.delete(f"{CATALOG}/ZU37KS/override", headers=auth(admin_token))
    with SessionLocal() as db:
        rows = db.scalars(
            select(AuditLog).where(AuditLog.action.like("schaltplan.catalog.%")).order_by(AuditLog.id)
        ).all()
        assert [(row.action, row.target_type, row.target_id) for row in rows] == [
            ("schaltplan.catalog.create", "panel_catalog_entry", "ZX37TEST"),
            ("schaltplan.catalog.update", "panel_catalog_entry", "ZU37KS"),
            ("schaltplan.catalog.archive", "panel_catalog_entry", "ZX37TEST"),
            ("schaltplan.catalog.unarchive", "panel_catalog_entry", "ZX37TEST"),
            ("schaltplan.catalog.reset", "panel_catalog_entry", "ZU37KS"),
        ]
        assert {row.actor_user_id for row in rows} == {admin_id()}


def test_a_broken_row_never_breaks_the_catalogue(client: TestClient, admin_token: str) -> None:
    with SessionLocal() as db:
        db.add(PanelCatalogEntry(code="ZX99BROKEN", entry_type="module", spec={"code": "ZX99BROKEN", "zones": "?"}))
        db.add(PanelCatalogEntry(code="ZU37KS", entry_type="module", spec={"code": "ZU37KS", "name": ""}))
        db.commit()

    body = _get(client, admin_token)
    broken = _entry(body, "ZX99BROKEN")
    assert (broken["invalid"], broken["spec"], broken["source"]) == (True, None, "custom")
    # A built-in keeps its own spec when its override no longer validates.
    assert (_entry(body, "ZU37KS")["invalid"], _entry(body, "ZU37KS")["spec"]) == (False, builtin_catalog().module("ZU37KS"))
    with SessionLocal() as db:
        catalog = load_catalog(db)
        assert catalog.known("ZX99BROKEN") and catalog.module("ZX99BROKEN") is None
        assert not catalog.known("ZX99NOPE")


def test_the_answer_reads_back_as_a_catalogue(client: TestClient, admin_token: str) -> None:
    """What the parity fixtures and the web client hold is the API answer."""
    with SessionLocal() as db:
        db.add(PanelCatalogEntry(code="ZX99BROKEN", entry_type="module", spec=None))
        db.commit()
    assert _post(client, admin_token, custom_module_spec()).status_code == 201
    catalog = EnclosureCatalog.from_out(_get(client, admin_token))
    assert list(catalog.entries) == list(builtin_catalog().entries) + ["ZX99BROKEN", "ZX37TEST"]
    assert catalog.module("zh3eh16") == builtin_catalog().module("ZH3EH16")
    assert catalog.enclosure("ZH3EH16") is None and catalog.module("ZB33S") is None
    assert catalog.entry("ZX37TEST").source == "custom"
    assert catalog.known("ZX99BROKEN") and catalog.entry("ZX99BROKEN").invalid
    subset = EnclosureCatalog.from_out({"modules": [{"code": "ZU62A", "spec": builtin_catalog().module("ZU62A")}, {}]})
    assert list(subset.entries) == ["ZU62A"] and subset.entry("ZU62A").entry_type == "module"
