"""The typed cabinet keys of a Verteilerplan (docs/PANEL_ENCLOSURE.md §2.2, D14).

Slice P let ``document.enclosure`` and ``device.supplied_by`` through as
opaque, size-capped JSON. The feature types them. The schema refuses only
structural garbage — two modules with one id, one row on two rails, more
than 50 modules, a code that is no code — and nothing a half-built board can
legitimately be: bounds against the real cabinet, overlaps and dangling
references are findings, not 422s.

Codes are checked on the write path only, and only codes the request
introduces: a code the stored board already carries always saves, so a
catalogue change or a downgrade never makes a board unsaveable (D14). The
route-level wiring of that check belongs to Slice B; here the check itself
and the guarantees that hold without it.
"""

from __future__ import annotations

import copy
import json

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.core.db import SessionLocal
from app.models.entities import PanelCatalogEntry
from app.schemas.panel_enclosure import DeviceSuppliedBy, PanelEnclosure
from app.schemas.schaltplan import PanelDocument, PanelFinding, PanelMaterialLineOut
from app.services.panel_enclosure_catalog import (
    assert_known_codes,
    builtin_catalog,
    document_codes,
    load_catalog,
    unknown_codes,
)
from app.services.schaltplan_layout import validate_document
from tests.panel_enclosure_helpers import (
    auth,
    cabinet_document,
    create_panel,
    device,
    store_directly,
    stored,
)


def _canonical(document: dict) -> str:
    return json.dumps(document, sort_keys=True, ensure_ascii=False)


def _legacy_document() -> dict:
    document = cabinet_document()
    del document["enclosure"]
    for row in document["rows"]:
        for item in row["devices"]:
            del item["supplied_by"]
    return document


def _patch(client: TestClient, token: str, panel_id: int, body: dict):
    return client.patch(f"/api/schaltplan/panels/{panel_id}", headers=auth(token), json=body)


def _module(module_id: str, code: str, field: int, rails: dict | None = None) -> dict:
    return {"id": module_id, "code": code, "field": field, "unit": 0, "rails": rails or {}}


# ── round trips ──────────────────────────────────────────────────────────────


def test_a_legacy_board_reads_with_null_cabinet_keys_and_unchanged_findings(client: TestClient, admin_token: str) -> None:
    legacy = _legacy_document()
    panel = create_panel(client, admin_token, legacy)
    body = client.get(f"/api/schaltplan/panels/{panel['id']}", headers=auth(admin_token)).json()
    assert body["document"]["enclosure"] is None
    assert {item["supplied_by"] for row in body["document"]["rows"] for item in row["devices"]} == {None}
    # Findings gain a "rule" id, empty for every finding that existed before.
    assert body["findings"] == [{**finding, "rule": ""} for finding in validate_document(legacy)]


def test_a_cabinet_board_round_trips_byte_for_byte(client: TestClient, admin_token: str) -> None:
    document = cabinet_document()
    panel = create_panel(client, admin_token, document)
    assert _canonical(panel["document"]) == _canonical(document)
    assert _canonical(stored(panel["id"])) == _canonical(document)


def test_codes_are_stored_stripped_and_upper_case(client: TestClient, admin_token: str) -> None:
    document = cabinet_document()
    document["enclosure"]["code"] = " zb33s "
    document["enclosure"]["modules"][0]["code"] = "zh3eh16"
    panel = create_panel(client, admin_token, document)
    assert stored(panel["id"])["enclosure"]["code"] == "ZB33S"
    assert stored(panel["id"])["enclosure"]["modules"][0]["code"] == "ZH3EH16"


def test_tolerant_defaults_fill_a_hand_made_module() -> None:
    enclosure = PanelEnclosure.model_validate({"code": "ZB33S", "modules": [_module("m1", "ZU37KS", 1)]})
    assert enclosure.model_dump()["modules"][0] == {
        "id": "m1", "code": "ZU37KS", "field": 1, "unit": 0, "label": "",
        # null = no snapshot (a hand-made module reads the catalogue); [] would
        # be a snapshot of "nothing came pre-fitted".
        "rails": {}, "fittings": None, "removed_fittings": [], "meters": [],
    }


def test_an_empty_fitting_snapshot_stays_apart_from_none() -> None:
    placed = {**_module("m1", "ZU37RK", 1), "fittings": []}
    dumped = PanelEnclosure.model_validate({"code": "ZB33S", "modules": [placed, _module("m2", "ZU37KS", 2)]}).model_dump()
    assert [module["fittings"] for module in dumped["modules"]] == [[], None]
    too_many = [{"key": f"k{n}", "label": "x"} for n in range(17)]
    with pytest.raises(ValidationError):
        PanelEnclosure.model_validate({"code": "ZB33S", "modules": [{**placed, "fittings": too_many}]})


def test_keys_a_later_release_adds_are_kept_not_dropped() -> None:
    """The P rule, one level down: an image that dropped unknown keys would
    strip them from every board on its next autosave after a rollback."""
    raw = {"code": "ZB33S", "terminal_rails": [{"field": 1}],
           "modules": [{**_module("m1", "ZU37KS", 1), "future": {"x": 1}}]}
    dumped = PanelEnclosure.model_validate(raw).model_dump()
    assert dumped["terminal_rails"] == [{"field": 1}]
    assert dumped["modules"][0]["future"] == {"x": 1}


def test_removed_fittings_are_de_duplicated_in_order() -> None:
    module = {**_module("m1", "ZH3EH16", 0), "removed_fittings": ["bke", "busbar", "bke"]}
    dumped = PanelEnclosure.model_validate({"code": "ZB33S", "modules": [module]}).model_dump()
    assert dumped["modules"][0]["removed_fittings"] == ["bke", "busbar"]


# ── structural garbage → 422 ─────────────────────────────────────────────────


def _broken(mutate) -> dict:
    document = cabinet_document()
    mutate(document["enclosure"])
    return document


@pytest.mark.parametrize(
    "mutate",
    [
        pytest.param(lambda e: e["modules"][1].update(id="mod-a"), id="duplicate module id"),
        pytest.param(lambda e: e["modules"][1]["rails"].update(r2="row-nar"), id="one row on two rails"),
        pytest.param(lambda e: e["modules"][0]["rails"].update(aar2="row-nar"), id="one row twice in a module"),
        pytest.param(lambda e: e.update(modules=[_module(f"m{i}", "ZU62A", 0) for i in range(51)]), id="51 modules"),
        pytest.param(lambda e: e.update(code="ZB 33S"), id="cabinet code pattern"),
        pytest.param(lambda e: e["modules"][0].update(code="Z"), id="module code too short"),
        pytest.param(lambda e: e["modules"][0].update(code="ZH3EH16<script>"), id="module code pattern"),
        pytest.param(lambda e: e["modules"][0]["rails"].update({"AAR 1": "row-x"}), id="rail key pattern"),
        pytest.param(lambda e: e["modules"][0]["rails"].update({f"r{i}": f"row-{i}" for i in range(17)}), id="17 rails"),
        pytest.param(lambda e: e["modules"][0].update(field=10), id="field 10"),
        pytest.param(lambda e: e["modules"][0].update(unit=20), id="unit 20"),
        pytest.param(lambda e: e["modules"][0]["meters"].append({"place": 0}), id="duplicate meter place"),
        pytest.param(lambda e: e["modules"][0]["meters"].append({"place": 8}), id="meter place 8"),
        pytest.param(lambda e: e["modules"][0]["fittings"].append(dict(e["modules"][0]["fittings"][0])), id="duplicate fitting key"),
        pytest.param(lambda e: e["modules"][0]["fittings"][0].update(device_kind="kaffeemaschine"), id="unknown device kind"),
        pytest.param(lambda e: e["modules"][0]["removed_fittings"].append("x" * 41), id="removed key too long"),
        pytest.param(lambda e: e.update(modules="ZH3EH16"), id="modules not a list"),
    ],
)
def test_structural_garbage_is_refused(client: TestClient, admin_token: str, mutate) -> None:
    panel = create_panel(client, admin_token)
    resp = _patch(client, admin_token, panel["id"], {"document": _broken(mutate)})
    assert resp.status_code == 422, resp.text


def test_what_a_half_built_board_may_be_still_saves(client: TestClient, admin_token: str) -> None:
    """Out of bounds, overlapping, dangling — findings later, never a 422 (D6)."""
    def half_built(enclosure: dict) -> None:
        enclosure["modules"][1].update(field=7, unit=12)
        enclosure["modules"][0]["rails"]["no_such_rail"] = "row-gone"
        enclosure["modules"].append(_module("mod-c", "ZU37RK", 0))

    panel = create_panel(client, admin_token)
    resp = _patch(client, admin_token, panel["id"], {"document": _broken(half_built)})
    assert resp.status_code == 200, resp.text


@pytest.mark.parametrize(
    "supplied_by",
    [
        {"module": "mod-a", "part": "hs", "extra": "x"},
        {"module": "m" * 65, "part": "hs"},
        {"module": "mod-a", "part": "p" * 41},
        {"module": "", "part": "hs"},
        {"module": "mod-a"},
    ],
)
def test_supplied_by_is_a_module_and_a_part(supplied_by: dict) -> None:
    with pytest.raises(ValidationError):
        DeviceSuppliedBy.model_validate(supplied_by)


def test_supplied_by_round_trips() -> None:
    document = cabinet_document()
    parsed = PanelDocument.model_validate(document).model_dump()
    assert parsed["rows"][1]["devices"][0]["supplied_by"] == {"module": "mod-a", "part": "hs"}
    assert parsed["rows"][0]["devices"][0]["supplied_by"] is None


def test_the_enclosure_keeps_its_64_kib_ceiling() -> None:
    document = cabinet_document()
    module = document["enclosure"]["modules"][1]
    # Every field within its own cap, the block as a whole over 64 KB.
    meters = [{"place": place, "number": "9" * 40, "label": "z" * 64} for place in range(8)]
    document["enclosure"]["modules"] = [
        {**module, "id": f"m{i}", "label": "x" * 64, "meters": meters,
         "rails": {f"r{j}": f"row-{i}-{j}-".ljust(64, "y") for j in range(16)}}
        for i in range(50)
    ]
    assert len(json.dumps(document["enclosure"], separators=(",", ":")).encode()) > 64 * 1024
    with pytest.raises(ValidationError, match="64 KB"):
        PanelDocument.model_validate(document)


# ── unknown codes: write path only, and only new ones ────────────────────────


def test_document_codes_reads_cabinet_and_modules_tolerantly() -> None:
    assert document_codes(cabinet_document()) == {"ZB33S", "ZH3EH16", "ZU37KS"}
    assert document_codes({"enclosure": None}) == set()
    assert document_codes({"enclosure": {"code": " zb32s ", "modules": [None, {"code": 7}, {}]}}) == {"ZB32S"}
    assert document_codes({}) == set()


def test_only_codes_the_request_introduces_are_unknown() -> None:
    catalog = builtin_catalog()
    stored_doc = cabinet_document()
    stored_doc["enclosure"]["modules"][1]["code"] = "ZX00GONE"
    edited = copy.deepcopy(stored_doc)
    assert unknown_codes(edited, catalog, stored=None) == ["ZX00GONE"]
    # The stored board already names it: a save of that board goes through.
    assert unknown_codes(edited, catalog, stored=stored_doc) == []
    edited["enclosure"]["modules"].append(_module("mod-c", "ZX00NEW", 2))
    assert unknown_codes(edited, catalog, stored=stored_doc) == ["ZX00NEW"]


def test_assert_known_codes_answers_400_in_german(client: TestClient) -> None:
    document = cabinet_document()
    document["enclosure"]["modules"].append(_module("mod-c", "ZX00NEW", 2))
    with SessionLocal() as db:
        with pytest.raises(HTTPException) as refused:
            assert_known_codes(db, document, stored=None)
        assert refused.value.status_code == 400
        assert refused.value.detail == "Unbekannter Schrank- oder Modulcode: ZX00NEW."
        assert_known_codes(db, cabinet_document(), stored=None)
        assert_known_codes(db, {"rows": []}, stored=None)


def test_archived_and_invalid_custom_codes_count_as_known(client: TestClient) -> None:
    with SessionLocal() as db:
        db.add(PanelCatalogEntry(code="ZX00OLD", entry_type="module", spec=None, is_archived=True))
        db.add(PanelCatalogEntry(code="ZX00BAD", entry_type="module", spec={"zones": 3}))
        db.commit()
        document = cabinet_document()
        document["enclosure"]["modules"] += [_module("m-old", "ZX00OLD", 2), _module("m-bad", "ZX00BAD", 2)]
        assert unknown_codes(document, load_catalog(db), stored=None) == []
        assert_known_codes(db, document, stored=None)


def test_a_board_with_a_code_the_catalogue_lost_still_reads_saves_and_copies(client: TestClient, admin_token: str) -> None:
    panel = create_panel(client, admin_token)
    document = cabinet_document()
    document["enclosure"]["modules"][1]["code"] = "ZX00GONE"
    store_directly(panel["id"], document)

    got = client.get(f"/api/schaltplan/panels/{panel['id']}", headers=auth(admin_token))
    assert got.status_code == 200, got.text
    edited = copy.deepcopy(got.json()["document"])
    edited["rows"][2]["devices"][1]["label"] = "Licht Flur EG"
    assert _patch(client, admin_token, panel["id"], {"document": edited}).status_code == 200
    assert stored(panel["id"])["enclosure"]["modules"][1]["code"] == "ZX00GONE"
    copied = client.post(f"/api/schaltplan/panels/{panel['id']}/duplicate", headers=auth(admin_token))
    assert copied.status_code == 200, copied.text


def test_an_invalid_custom_spec_breaks_no_board(client: TestClient, admin_token: str) -> None:
    with SessionLocal() as db:
        db.add(PanelCatalogEntry(code="ZX00BAD", entry_type="module", spec={"zones": "kaputt"}))
        db.commit()
    panel = create_panel(client, admin_token)
    document = cabinet_document()
    document["enclosure"]["modules"][1]["code"] = "ZX00BAD"
    store_directly(panel["id"], document)
    url = f"/api/schaltplan/panels/{panel['id']}"
    before = client.get(f"{url}/material", headers=auth(admin_token))
    assert before.status_code == 200, before.text

    assert client.get(url, headers=auth(admin_token)).status_code == 200
    assert _patch(client, admin_token, panel["id"], {"name": "Zählerschrank Haus B"}).status_code == 200
    saved = _patch(client, admin_token, panel["id"], {"document": document})
    assert saved.status_code == 200, saved.text
    after = client.get(f"{url}/material", headers=auth(admin_token))
    assert after.status_code == 200
    assert after.json()["lines"] == before.json()["lines"]


# ── the response shapes the other slices fill ────────────────────────────────


def test_findings_carry_a_rule_id() -> None:
    assert PanelFinding(level="warn", scope="", message="x").rule == ""
    assert PanelFinding(level="warn", scope="m", message="x", rule="encl.overlap").rule == "encl.overlap"


@pytest.mark.parametrize("kind", ["enclosure", "removed"])
def test_material_lines_know_the_cabinet_kinds(kind: str) -> None:
    line = PanelMaterialLineOut(key=f"{kind}:x", kind=kind, label="x", status="open")
    assert line.kind == kind


def test_material_answers_carry_returns_open(client: TestClient, admin_token: str) -> None:
    panel = create_panel(client, admin_token, cabinet_document())
    detail = client.get(f"/api/schaltplan/panels/{panel['id']}/material", headers=auth(admin_token))
    assert detail.status_code == 200, detail.text
    assert detail.json()["returns_open"] == 0
    overview = client.get("/api/schaltplan/material/overview", headers=auth(admin_token))
    assert [row["returns_open"] for row in overview.json()] == [0]


def test_an_hlak_device_may_be_a_supplied_fitting() -> None:
    document = cabinet_document()
    document["rows"][1]["devices"].append(
        device("dev-x0", "hlak", supplied_by={"module": "mod-a", "part": "hlak"})
    )
    assert PanelDocument.model_validate(document).rows[1].devices[1].supplied_by == DeviceSuppliedBy(
        module="mod-a", part="hlak"
    )


# ── route wiring (Slice B): the write check, the read findings, the copy ─────


def test_a_new_unknown_code_is_refused_on_create(client: TestClient, admin_token: str) -> None:
    document = cabinet_document()
    document["enclosure"]["modules"].append(_module("mod-c", "ZX00NEW", 2))
    resp = client.post(
        "/api/schaltplan/panels", headers=auth(admin_token),
        json={"customer_id": create_panel(client, admin_token)["customer_id"], "name": "Haus B",
              "designation": "ZS2", "panel_type": "meter", "document": document},
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["detail"] == "Unbekannter Schrank- oder Modulcode: ZX00NEW."


def test_a_new_unknown_code_is_refused_on_save_and_nothing_is_stored(client: TestClient, admin_token: str) -> None:
    panel = create_panel(client, admin_token, cabinet_document())
    document = cabinet_document()
    document["enclosure"]["code"] = "ZX00CAB"
    resp = _patch(client, admin_token, panel["id"], {"document": document, "name": "Umbenannt"})
    assert resp.status_code == 400, resp.text
    assert resp.json()["detail"] == "Unbekannter Schrank- oder Modulcode: ZX00CAB."
    assert stored(panel["id"])["enclosure"]["code"] == "ZB33S"
    assert client.get(f"/api/schaltplan/panels/{panel['id']}", headers=auth(admin_token)).json()["name"] != "Umbenannt"


def test_a_stored_unknown_code_reads_with_a_placeholder_finding(client: TestClient, admin_token: str) -> None:
    panel = create_panel(client, admin_token)
    document = cabinet_document()
    document["enclosure"]["modules"][1]["code"] = "ZX00GONE"
    store_directly(panel["id"], document)
    body = client.get(f"/api/schaltplan/panels/{panel['id']}", headers=auth(admin_token)).json()
    unknown = [f for f in body["findings"] if f["rule"] == "encl.unknown_code"]
    assert unknown == [{"level": "warn", "scope": "mod-b", "rule": "encl.unknown_code",
                        "message": "Unbekannter oder fehlerhafter Katalogcode ZX00GONE — nur als Platzhalter gezeigt."}]


def _no_code(document: dict) -> None:
    document["enclosure"] = {"code": "x"}


def _beyond_schema(document: dict) -> None:
    document["enclosure"]["modules"][0]["field"] = 12


def _half_claim(document: dict) -> None:
    document["rows"][1]["devices"][0]["supplied_by"] = {"module": "mod-a"}


@pytest.mark.parametrize("damage", [_no_code, _beyond_schema, _half_claim], ids=["no code", "beyond schema", "half claim"])
def test_a_block_slice_p_let_through_never_breaks_the_read(client: TestClient, admin_token: str, damage) -> None:
    """Slice P stored ``enclosure`` and ``supplied_by`` as opaque JSON, so a
    board may hold a block the feature's types refuse (written while P was
    live, or after a rollback to it). The board must still open and copy
    (D14): the block is left out with a finding, rows and devices stay."""
    panel = create_panel(client, admin_token)
    document = cabinet_document()
    damage(document)
    store_directly(panel["id"], document)

    got = client.get(f"/api/schaltplan/panels/{panel['id']}", headers=auth(admin_token))
    assert got.status_code == 200, got.text
    body = got.json()
    assert [row["id"] for row in body["document"]["rows"]] == [row["id"] for row in document["rows"]]
    assert [f for f in body["findings"] if f["rule"] == "encl.invalid_block"] == [{
        "level": "warn", "scope": "", "rule": "encl.invalid_block",
        "message": "Schrankdaten fehlerhaft gespeichert — ausgeblendet und beim nächsten Speichern entfernt; "
                   "Reihen und Geräte bleiben.",
    }]
    if damage is _half_claim:
        assert body["document"]["enclosure"]["code"] == "ZB33S"
        assert body["document"]["rows"][1]["devices"][0]["supplied_by"] is None
    else:
        assert body["document"]["enclosure"] is None
    copied = client.post(f"/api/schaltplan/panels/{panel['id']}/duplicate", headers=auth(admin_token))
    assert copied.status_code == 200, copied.text


def test_the_copy_of_a_board_forgets_its_meter_numbers(client: TestClient, admin_token: str) -> None:
    """A meter number identifies one physical meter; places and labels stay."""
    panel = create_panel(client, admin_token, cabinet_document())
    copied = client.post(f"/api/schaltplan/panels/{panel['id']}/duplicate", headers=auth(admin_token))
    assert copied.status_code == 200, copied.text
    meters = copied.json()["document"]["enclosure"]["modules"][0]["meters"]
    assert meters == [{"place": 0, "number": "", "label": "WE 1"}]
    assert stored(copied.json()["id"])["enclosure"]["modules"][0]["meters"] == meters
    # The original keeps its number.
    assert stored(panel["id"])["enclosure"]["modules"][0]["meters"][0]["number"] == "1XYZ0000000042"


# ── module.terminal_order (docs/PANEL_ENCLOSURE_R2.md §2.1) ──────────────────


def _with_order(order: object) -> dict:
    return {**_module("m1", "ZU37KS", 1), "terminal_order": order}


def _dumped_module(order: object) -> dict:
    return PanelEnclosure.model_validate({"code": "ZB33S", "modules": [_with_order(order)]}).model_dump()["modules"][0]


def test_terminal_order_round_trips_and_null_means_absent() -> None:
    order = {"0": {"strips": ["dev-f2:leiste", "dev-q7:block"], "rail2_from": "dev-q7:block"}}
    assert _dumped_module(order)["terminal_order"] == order
    assert _dumped_module({"0": {"strips": ["a"]}})["terminal_order"] == {"0": {"strips": ["a"], "rail2_from": None}}
    # Absent and null are the same, and neither adds a key to a stored board.
    assert "terminal_order" not in _dumped_module(None)
    plain = PanelEnclosure.model_validate({"code": "ZB33S", "modules": [_module("m1", "ZU37KS", 1)]}).model_dump()
    assert "terminal_order" not in plain["modules"][0]


@pytest.mark.parametrize(
    "order",
    [
        "0", 7, ["dev-f1:leiste"],
        {"3": {"strips": ["a"]}, "x": {"strips": ["a"]}},
        {"0": {"strips": "dev-f1:leiste"}},
        {"0": {"strips": [1, None, ""]}},
        {"0": {"strips": [f"s{n}" for n in range(1000)], "rail2_from": "s999"}},
        {"0": {"strips": ["a"], "rail2_from": "b"}},
    ],
    ids=["text", "number", "list", "bad keys", "strips text", "non-text ids", "1000 ids", "split not listed"],
)
def test_a_garbage_terminal_order_is_dropped_never_refused(client: TestClient, admin_token: str, order: object) -> None:
    dumped = _dumped_module(order).get("terminal_order")
    assert dumped is None or (len(dumped["0"]["strips"]) <= 40 and dumped["0"]["rail2_from"] is None)
    document = cabinet_document()
    document["enclosure"]["modules"][1]["terminal_order"] = order
    panel = create_panel(client, admin_token)
    saved = _patch(client, admin_token, panel["id"], {"document": document})
    assert saved.status_code == 200, saved.text
    # Stored by an older image without the parser: the read path parses it too.
    store_directly(panel["id"], document)
    got = client.get(f"/api/schaltplan/panels/{panel['id']}", headers=auth(admin_token))
    assert got.status_code == 200, got.text
    assert not [f for f in got.json()["findings"] if f["rule"] == "encl.invalid_block"]
    assert got.json()["document"]["enclosure"]["modules"][1].get("terminal_order") == dumped


def test_a_board_from_before_round_2_opens_and_saves_unchanged(client: TestClient, admin_token: str) -> None:
    """Rows on r1–r2 and r3–r7 of a Verteilerfeld, as v2.15.0 placed them:
    nothing moves on load, and saving another device leaves rows and links alone."""
    from scripts.write_enclosure_fixtures import terminals_zb34s

    panel = create_panel(client, admin_token)
    store_directly(panel["id"], terminals_zb34s())
    before = stored(panel["id"])
    got = client.get(f"/api/schaltplan/panels/{panel['id']}", headers=auth(admin_token))
    assert got.status_code == 200, got.text
    assert _canonical(got.json()["document"]) == _canonical(before)

    edited = copy.deepcopy(before)
    target = next(d for r in edited["rows"] if r["id"] == "row-k3" for d in r["devices"] if d["id"] == "dev-f2-1")
    target["label"] = "Licht Keller"
    saved = _patch(client, admin_token, panel["id"], {"document": edited})
    assert saved.status_code == 200, saved.text
    after = stored(panel["id"])
    assert _canonical(after["enclosure"]) == _canonical(before["enclosure"])
    assert _canonical(after["rows"]) == _canonical(edited["rows"])
    assert [r["id"] for r in after["rows"]] == [r["id"] for r in before["rows"]]
