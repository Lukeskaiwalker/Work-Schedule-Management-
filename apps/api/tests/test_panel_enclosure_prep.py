"""Slice P of docs/PANEL_ENCLOSURE.md — the release that ships before the cabinet.

The cabinet feature (Schrank, modules, removed fittings) is released after
this one, so that rolling it back is an image swap (§16). That only holds if
THIS release already reads and keeps everything the feature writes:

* ``document.enclosure`` and ``device.supplied_by`` pass through a read and a
  save untouched — an older image used to drop them on the next autosave;
* an ``hlak`` device (Hauptleitungsabzweigklemme) validates — an older image
  answered 500 on the first GET of such a board;
* a board may hold 120 rows (lazy rail rows of a ZB55S), not 60;
* the two ledger types ``salvage`` / ``salvage_undo`` move stock and list;
* migration 0104 (``panel_catalog_entries``) is already on the Alembic chain,
  so the feature image finds a head it knows, and so does this one after a
  rollback.

A board without a cabinet must not notice any of it. All data is invented.
"""

from __future__ import annotations

import copy
import json
import re
import typing
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.core.db import SessionLocal
from app.models.entities import PanelPlan, User, WerkstattArticle
from app.schemas.schaltplan import MAX_ROWS
from app.schemas.werkstatt import WerkstattMovementType
from app.services.schaltplan_layout import (
    DEVICE_CATALOG,
    build_legend,
    build_topology,
    validate_document,
)
from app.services.schaltplan_material import planned_lines
from app.services.schaltplan_terminals import derive_terminals, terminal_bom
from app.services.werkstatt_movements import ALLOWED_MOVEMENT_TYPES, MovementError, apply_movement

ENCLOSURE_KIB = 64 * 1024
WEB_DEVICES = Path(__file__).resolve().parents[2] / "web" / "src" / "utils" / "schaltplanDevices.ts"


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _customer(client: TestClient, token: str, name: str = "Familie Beispiel") -> int:
    resp = client.post("/api/customers", headers=_auth(token), json={"name": name})
    assert resp.status_code == 200, resp.text
    return resp.json()["id"]


def _device(device_id: str, kind: str, **overrides) -> dict:
    """A device exactly as the editor sends it (``makeDevice`` in schaltplanDevices.ts)."""
    entry = DEVICE_CATALOG[kind]
    device = {
        "id": device_id,
        "kind": kind,
        "te": entry["te"],
        "poles": entry["poles"],
        "designation": "",
        "circuit": "",
        "label": "",
        "room": "",
        "rating": "",
        "residual_current": "",
        "rcd_type": "",
        "cable": "",
        "phase": "-",
        "parent_id": None,
        "feeds_following": False,
        "terminal_block": False,
        "note": "",
        "width_mm": None,
    }
    device.update(overrides)
    return device


def _legacy_document() -> dict:
    """A board as every release before this one saved it: no cabinet keys at all."""
    return {
        "version": 1,
        "supply": {
            "system": "TN-S",
            "voltage": "400/230 V",
            "incoming": "NYY-J 5x16 mm²",
            "fuse": "NH 63 A",
            "meter_number": "1ABC0000000001",
            "note": "",
        },
        "rows": [
            {
                "id": "row-1",
                "label": "Reihe 1",
                "slots": 12,
                "devices": [
                    _device("dev-q1", "hauptschalter", designation="Q1", rating="63 A"),
                    _device("dev-f1", "rcd", designation="F1", rating="40 A", residual_current="30 mA", rcd_type="A"),
                    _device(
                        "dev-c1", "mcb", designation="F1.1", circuit="1", label="Licht Flur", room="Flur",
                        rating="B16", cable="NYM-J 3x1,5 mm²", phase="L1", terminal_block=True,
                    ),
                    _device("dev-c2", "mcb", designation="F1.2", circuit="2", label="Steckdosen", rating="B16", width_mm=17.5),
                ],
            },
            {"id": "row-2", "label": "Reihe 2", "slots": 12, "devices": []},
        ],
        "terminal_labels": {"dev-c1:0": "1.1"},
    }


def _enclosure() -> dict:
    """The §2.1 example: what the cabinet release stores, opaque to this one."""
    return {
        "code": "ZB33S",
        "modules": [
            {
                "id": "mod-a", "code": "ZH3EH16", "field": 0, "unit": 0, "label": "Allgemein",
                "rails": {"nar": "row-1", "aar1": "row-2"},
                "fittings": [
                    {"key": "hs", "label": "Hauptschalter", "article_no": None, "device_kind": "hauptschalter", "removable": True},
                    {"key": "hlak", "label": "Hauptleitungsabzweigklemme", "article_no": None, "device_kind": "hlak", "removable": True},
                    {"key": "busbar", "label": "Sammelschiene 5-polig 12×5 mm (NAR)", "article_no": None, "device_kind": None, "removable": False},
                ],
                "removed_fittings": [],
                "meters": [{"place": 0, "number": "1ABC0000000001", "label": "WE 1"}],
            },
            {
                "id": "mod-b", "code": "ZU37KS", "field": 1, "unit": 0, "label": "",
                "rails": {"r1": "row-3"}, "fittings": [], "removed_fittings": [], "meters": [],
            },
        ],
    }


def _cabinet_document() -> dict:
    document = _legacy_document()
    rows = document["rows"]
    rows[0]["devices"][0]["supplied_by"] = {"module": "mod-a", "part": "hs"}
    rows[1]["devices"].append(
        _device("dev-x0", "hlak", supplied_by={"module": "mod-a", "part": "hlak"})
    )
    for device in (*rows[0]["devices"][1:], *rows[1]["devices"][:-1]):
        device["supplied_by"] = None
    document["enclosure"] = _enclosure()
    return document


def _with_null_defaults(document: dict) -> dict:
    """What this release answers for a board saved before it: the two new keys, null."""
    expected = copy.deepcopy(document)
    expected["enclosure"] = None
    for row in expected["rows"]:
        for device in row["devices"]:
            device["supplied_by"] = None
    return expected


def _without_new_keys(value: object) -> object:
    if isinstance(value, dict):
        return {k: _without_new_keys(v) for k, v in value.items() if k not in ("enclosure", "supplied_by")}
    if isinstance(value, list):
        return [_without_new_keys(item) for item in value]
    return value


def _canonical(document: dict) -> str:
    return json.dumps(document, sort_keys=True, ensure_ascii=False)


def _create_panel(client: TestClient, token: str, document: dict | None = None, **overrides) -> dict:
    payload = {
        "customer_id": _customer(client, token),
        "name": "Unterverteiler Werkstatt",
        "designation": "UV1",
        "panel_type": "sub",
    }
    if document is not None:
        payload["document"] = document
    payload.update(overrides)
    resp = client.post("/api/schaltplan/panels", headers=_auth(token), json=payload)
    assert resp.status_code == 200, resp.text
    return resp.json()


def _store_directly(panel_id: int, document: dict) -> None:
    """Write a document the way another release would have, bypassing this schema."""
    with SessionLocal() as db:
        plan = db.get(PanelPlan, panel_id)
        plan.document = copy.deepcopy(document)
        db.commit()


def _stored(panel_id: int) -> dict:
    with SessionLocal() as db:
        return copy.deepcopy(db.get(PanelPlan, panel_id).document)


def _patch(client: TestClient, token: str, panel_id: int, body: dict):
    return client.patch(f"/api/schaltplan/panels/{panel_id}", headers=_auth(token), json=body)


# ── a board without a cabinet does not notice ────────────────────────────────


def test_a_legacy_board_round_trips_with_only_the_two_null_defaults(client: TestClient, admin_token: str) -> None:
    legacy = _legacy_document()
    panel = _create_panel(client, admin_token, legacy)

    got = client.get(f"/api/schaltplan/panels/{panel['id']}", headers=_auth(admin_token))
    assert got.status_code == 200, got.text
    body = got.json()
    # Byte for byte the document that was sent, plus `"enclosure": null` and a
    # `"supplied_by": null` per device — the documented, harmless defaults (§16).
    assert _canonical(body["document"]) == _canonical(_with_null_defaults(legacy))

    # Every derivation reads the board exactly as before: the bare legacy dict
    # and the stored one (with the null keys) give identical results.
    stored = _stored(panel["id"])
    assert build_legend(stored) == build_legend(legacy)
    assert [row["designation"] for row in body["legend"]] == ["F1.1", "F1.2"]
    assert validate_document(stored) == validate_document(legacy)
    assert body["findings"] == validate_document(legacy)
    assert terminal_bom(derive_terminals(stored)) == terminal_bom(derive_terminals(legacy))
    assert planned_lines(stored) == planned_lines(legacy)
    # The topology carries the device dicts themselves, null key included.
    assert _without_new_keys(build_topology(stored)) == build_topology(legacy)


def test_reading_a_board_saved_by_an_older_release_never_rewrites_it(client: TestClient, admin_token: str) -> None:
    panel = _create_panel(client, admin_token)
    # An old row: no terminal_labels, no cabinet keys, devices missing the
    # later booleans. Reads must render it and leave the stored JSON alone.
    old = _legacy_document()
    del old["terminal_labels"]
    for device in old["rows"][0]["devices"]:
        del device["terminal_block"]
    _store_directly(panel["id"], old)

    got = client.get(f"/api/schaltplan/panels/{panel['id']}", headers=_auth(admin_token))
    assert got.status_code == 200, got.text
    assert got.json()["document"]["enclosure"] is None
    renamed = _patch(client, admin_token, panel["id"], {"name": "UV Werkstatt neu"})
    assert renamed.status_code == 200, renamed.text

    assert _canonical(_stored(panel["id"])) == _canonical(old)


# ── what the cabinet release writes survives this one ────────────────────────


def test_enclosure_and_supplied_by_pass_through_a_save_unchanged(client: TestClient, admin_token: str) -> None:
    document = _cabinet_document()
    panel = _create_panel(client, admin_token, document)
    assert panel["document"]["enclosure"] == document["enclosure"]

    got = client.get(f"/api/schaltplan/panels/{panel['id']}", headers=_auth(admin_token)).json()
    assert _canonical(got["document"]) == _canonical(document)
    assert _canonical(_stored(panel["id"])) == _canonical(document)

    # An autosave from a tab that only edits a label sends the whole document
    # back — the cabinet must come back with it.
    edited = copy.deepcopy(got["document"])
    edited["rows"][0]["devices"][2]["label"] = "Licht Flur EG"
    saved = _patch(client, admin_token, panel["id"], {"document": edited})
    assert saved.status_code == 200, saved.text
    assert saved.json()["document"]["enclosure"] == document["enclosure"]
    assert _stored(panel["id"])["rows"][0]["devices"][0]["supplied_by"] == {"module": "mod-a", "part": "hs"}


def test_a_cabinet_board_written_by_the_feature_release_reads_and_keeps(client: TestClient, admin_token: str) -> None:
    """The rollback case (§16): the feature wrote it, this image serves it."""
    panel = _create_panel(client, admin_token)
    document = _cabinet_document()
    _store_directly(panel["id"], document)

    got = client.get(f"/api/schaltplan/panels/{panel['id']}", headers=_auth(admin_token))
    assert got.status_code == 200, got.text
    assert _canonical(got.json()["document"]) == _canonical(document)

    assert _patch(client, admin_token, panel["id"], {"status": "final"}).status_code == 200
    assert _canonical(_stored(panel["id"])) == _canonical(document)

    copied = client.post(f"/api/schaltplan/panels/{panel['id']}/duplicate", headers=_auth(admin_token))
    assert copied.status_code == 200, copied.text
    assert copied.json()["document"]["enclosure"] == document["enclosure"]


def test_the_enclosure_block_is_capped_at_64_kib_of_json(client: TestClient, admin_token: str) -> None:
    panel = _create_panel(client, admin_token)

    def document_with(enclosure: object) -> dict:
        document = _legacy_document()
        document["enclosure"] = enclosure
        return document

    # Measured as compact UTF-8 JSON: '{"note":""}' is 11 bytes before the text.
    at_cap = {"note": "x" * (ENCLOSURE_KIB - 11)}
    assert len(json.dumps(at_cap, separators=(",", ":")).encode()) == ENCLOSURE_KIB
    assert _patch(client, admin_token, panel["id"], {"document": document_with(at_cap)}).status_code == 200

    over = {"note": "x" * (ENCLOSURE_KIB - 10)}
    refused = _patch(client, admin_token, panel["id"], {"document": document_with(over)})
    assert refused.status_code == 422, refused.text
    assert "64 KB" in refused.text
    # Multi-byte text counts in bytes, not characters.
    umlauts = {"note": "ä" * (ENCLOSURE_KIB // 2)}
    assert _patch(client, admin_token, panel["id"], {"document": document_with(umlauts)}).status_code == 422

    # An object or nothing — never a list or a scalar.
    for not_an_object in ([], "ZB33S", 3):
        bad = _patch(client, admin_token, panel["id"], {"document": document_with(not_an_object)})
        assert bad.status_code == 422, (not_an_object, bad.text)
    assert _stored(panel["id"])["enclosure"] == at_cap


@pytest.mark.parametrize(
    "supplied_by",
    [
        {"module": "mod-a", "part": "hs", "a": "1", "b": "2", "c": "3"},
        {"module": "m" * 65, "part": "hs"},
        {"m" * 65: "mod-a"},
        {"module": "mod-a", "part": 7},
        {"module": "mod-a", "part": None},
        ["mod-a", "hs"],
        "mod-a",
    ],
)
def test_supplied_by_is_a_small_string_map(client: TestClient, admin_token: str, supplied_by: object) -> None:
    panel = _create_panel(client, admin_token)
    document = _legacy_document()
    document["rows"][0]["devices"][0]["supplied_by"] = supplied_by
    resp = _patch(client, admin_token, panel["id"], {"document": document})
    assert resp.status_code == 422, resp.text


def test_supplied_by_takes_four_keys_of_up_to_64_characters(client: TestClient, admin_token: str) -> None:
    panel = _create_panel(client, admin_token)
    document = _legacy_document()
    widest = {"module": "m" * 64, "part": "p" * 64, "x" * 64: "", "note": "n"}
    document["rows"][0]["devices"][0]["supplied_by"] = widest
    resp = _patch(client, admin_token, panel["id"], {"document": document})
    assert resp.status_code == 200, resp.text
    assert resp.json()["document"]["rows"][0]["devices"][0]["supplied_by"] == widest


# ── hlak: a device kind the cabinet places, not a circuit, not a group ───────


def test_an_hlak_device_validates_and_reads_back(client: TestClient, admin_token: str) -> None:
    document = _legacy_document()
    # Between the FI and its LS: an HLAK must not open a group of its own,
    # or F1.1/F1.2 would lose their FI in the legend.
    document["rows"][0]["devices"].insert(2, _device("dev-x0", "hlak", designation="X0"))
    panel = _create_panel(client, admin_token, document)

    got = client.get(f"/api/schaltplan/panels/{panel['id']}", headers=_auth(admin_token))
    assert got.status_code == 200, got.text
    body = got.json()
    assert [d["kind"] for d in body["document"]["rows"][0]["devices"]][2] == "hlak"
    assert body["circuit_count"] == 2
    assert [row["designation"] for row in body["legend"]] == ["F1.1", "F1.2"]
    assert {row["rcd"] for row in body["legend"]} == {"30 mA / Typ A"}


def test_an_hlak_board_stored_by_the_feature_release_reads(client: TestClient, admin_token: str) -> None:
    panel = _create_panel(client, admin_token)
    document = _legacy_document()
    document["rows"][1]["devices"] = [_device("dev-x0", "hlak")]
    _store_directly(panel["id"], document)
    got = client.get(f"/api/schaltplan/panels/{panel['id']}", headers=_auth(admin_token))
    assert got.status_code == 200, got.text
    pdf = client.get(f"/api/schaltplan/panels/{panel['id']}/pdf", headers=_auth(admin_token))
    assert pdf.status_code == 200, pdf.text


def test_the_device_catalogue_serves_hlak(client: TestClient, admin_token: str) -> None:
    resp = client.get("/api/schaltplan/devices", headers=_auth(admin_token))
    assert resp.status_code == 200, resp.text
    entries = [entry["kind"] for entry in resp.json()]
    # Right after the Verteilerblock: the material list sorts device lines in
    # catalogue order, and the feeding parts belong together.
    assert entries[entries.index("distribution_block") + 1] == "hlak"
    hlak = next(entry for entry in resp.json() if entry["kind"] == "hlak")
    assert hlak == {
        "kind": "hlak",
        "label": "Hauptleitungsabzweigklemme (HLAK)",
        "short": "HLAK",
        "te": 4,
        "poles": 3,
        "group": False,
        "circuit": False,
        "symbol": "terminal",
        "rating_hint": "",
    }


# ── 120 rows ─────────────────────────────────────────────────────────────────


def _rows(count: int) -> list[dict]:
    return [{"id": f"row-{i}", "label": f"Reihe {i}", "slots": 12, "devices": []} for i in range(count)]


def test_a_board_holds_120_rows_and_refuses_the_121st(client: TestClient, admin_token: str) -> None:
    assert MAX_ROWS == 120
    panel = _create_panel(client, admin_token)
    document = _legacy_document()

    document["rows"] = _rows(120)
    saved = _patch(client, admin_token, panel["id"], {"document": document})
    assert saved.status_code == 200, saved.text
    assert saved.json()["row_count"] == 120

    document["rows"] = _rows(121)
    refused = _patch(client, admin_token, panel["id"], {"document": document})
    assert refused.status_code == 422, refused.text
    assert len(_stored(panel["id"])["rows"]) == 120


@pytest.mark.skipif(not WEB_DEVICES.exists(), reason="the api image is built without apps/web")
def test_the_editor_catalogue_and_row_cap_match_the_server() -> None:
    source = WEB_DEVICES.read_text(encoding="utf-8")
    cap = re.search(r"^export const MAX_ROWS = (\d+);$", source, re.MULTILINE)
    assert cap is not None and int(cap.group(1)) == MAX_ROWS

    entries = {
        match.group(1): dict(re.findall(r'(\w+): ("[^"]*"|\d+|true|false)', match.group(2)))
        for match in re.finditer(r"^  (\w+): \{ (kind: .*) \},?$", source, re.MULTILINE)
    }
    assert set(entries) == set(DEVICE_CATALOG)
    for kind, server in DEVICE_CATALOG.items():
        web = {key: value.strip('"') for key, value in entries[kind].items()}
        for web_key, server_key in (
            ("te", "te"), ("poles", "poles"), ("group", "group"), ("circuit", "circuit"),
            ("symbol", "symbol"), ("short", "short"), ("ratingHint", "rating_hint"),
        ):
            value = server[server_key]
            assert web[web_key] == (str(value).lower() if isinstance(value, bool) else str(value)), (kind, web_key)
    # Some palette labels are shortened on purpose; the new kind's is not.
    assert entries["hlak"]["label"] == f'"{DEVICE_CATALOG["hlak"]["label"]}"'


# ── salvage / salvage_undo: parts taken out of a module, back on the shelf ───


def _admin_id(db) -> int:
    return int(db.scalars(select(User.id).where(User.email == "admin@example.com")).one())


def _article(db, number: str) -> WerkstattArticle:
    article = WerkstattArticle(article_number=number, item_name=f"Hauptschalter 3-polig {number}", unit="Stk")
    db.add(article)
    db.flush()
    return article


def test_every_ledger_type_is_in_the_response_literal() -> None:
    # A type missing from the Literal 500s every movement list that contains it.
    assert set(typing.get_args(WerkstattMovementType)) == set(ALLOWED_MOVEMENT_TYPES)
    assert {"salvage", "salvage_undo"} <= ALLOWED_MOVEMENT_TYPES


def test_a_salvage_raises_stock_and_lists(client: TestClient, admin_token: str) -> None:
    panel = _create_panel(client, admin_token)
    with SessionLocal() as db:
        article = _article(db, "SP-HS-01")
        user_id = _admin_id(db)
        apply_movement(db, article=article, movement_type="intake", quantity=2, user_id=user_id)
        apply_movement(
            db, article=article, movement_type="salvage", quantity=3, user_id=user_id,
            panel_id=panel["id"], notes=f"Rücklauf — Verteiler {panel['panel_number']}",
        )
        assert (article.stock_total, article.stock_available) == (5, 5)
        apply_movement(db, article=article, movement_type="salvage_undo", quantity=1, user_id=user_id, panel_id=panel["id"])
        assert (article.stock_total, article.stock_available, article.stock_out, article.stock_repair) == (4, 4, 0, 0)
        db.commit()

    listed = client.get("/api/werkstatt/mobile/movements?all=true&limit=10", headers=_auth(admin_token))
    assert listed.status_code == 200, listed.text
    assert [row["movement_type"] for row in listed.json()][:2] == ["salvage_undo", "salvage"]
    dashboard = client.get("/api/werkstatt/dashboard", headers=_auth(admin_token))
    assert dashboard.status_code == 200, dashboard.text


def test_salvage_undo_is_bounded_by_stock_available(client: TestClient, admin_token: str) -> None:
    with SessionLocal() as db:
        article = _article(db, "SP-HS-02")
        user_id = _admin_id(db)
        apply_movement(db, article=article, movement_type="salvage", quantity=1, user_id=user_id)
        with pytest.raises(MovementError, match="stock_available"):
            apply_movement(db, article=article, movement_type="salvage_undo", quantity=2, user_id=user_id)
        assert (article.stock_total, article.stock_available) == (1, 1)
        apply_movement(db, article=article, movement_type="salvage_undo", quantity=1, user_id=user_id)
        assert (article.stock_total, article.stock_available) == (0, 0)
        db.commit()


# ── migration 0104: the catalogue table exists, empty, unused ────────────────


def test_the_catalogue_table_takes_one_row_per_code(client: TestClient) -> None:
    from app.models.entities import PanelCatalogEntry

    with SessionLocal() as db:
        db.add(PanelCatalogEntry(code="ZX99TEST", entry_type="module", spec=None))
        db.commit()
        row = db.scalars(select(PanelCatalogEntry)).one()
        assert (row.code, row.entry_type, row.spec, row.is_archived) == ("ZX99TEST", "module", None, False)
        assert row.created_at is not None and row.updated_at is not None

        db.add(PanelCatalogEntry(code="ZX99TEST", entry_type="enclosure", spec={"code": "ZX99TEST"}))
        with pytest.raises(IntegrityError):
            db.commit()
        db.rollback()


def test_migration_0104_is_on_the_chain_to_head() -> None:
    # Not "is the head": a later migration — or the 0103 branch being merged
    # in front of it (§8) — moves the head on; 0104 only has to stay on the
    # single chain every image upgrades along.
    from alembic.config import Config
    from alembic.script import ScriptDirectory

    api_root = Path(__file__).resolve().parents[1]
    config = Config(str(api_root / "alembic.ini"))
    config.set_main_option("script_location", str(api_root / "alembic"))
    script = ScriptDirectory.from_config(config)
    (head,) = script.get_heads()
    chain = [revision.revision for revision in script.iterate_revisions(head, "base")]
    assert "20261021_0104" in chain
    assert chain.index("20261021_0104") < chain.index("20261020_0102")
    # v2.14.43 chains it after 0105 (app_settings.value TEXT), not beside it.
    assert chain.index("20261021_0104") < chain.index("20261022_0105")
