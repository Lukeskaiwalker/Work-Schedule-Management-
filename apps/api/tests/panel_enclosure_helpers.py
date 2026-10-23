"""Shared setup for the cabinet-layer tests (docs/PANEL_ENCLOSURE.md).

Boards are made through the real endpoints where the test is about the API,
and written straight into the table where the test is about a document some
other release (or a hand edit) left behind. Every name, number and board
below is invented; only the Hager catalogue codes are real, because they are
what the built-in catalogue ships.
"""

from __future__ import annotations

import copy
import itertools
from typing import Any

from fastapi.testclient import TestClient

from app.core.db import SessionLocal
from app.models.entities import PanelPlan, Project, User, WerkstattArticle
from app.services.schaltplan_layout import DEVICE_CATALOG
from app.services.werkstatt_movements import apply_movement

_ARTICLE_NUMBERS = itertools.count(1)


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def customer(client: TestClient, token: str, name: str = "Familie Beispiel") -> int:
    resp = client.post("/api/customers", headers=auth(token), json={"name": name})
    assert resp.status_code == 200, resp.text
    return resp.json()["id"]


def employee(client: TestClient, admin_token: str, email: str) -> str:
    """An ordinary fitter: ``reports:create``, no ``werkstatt:manage``."""
    resp = client.post(
        "/api/admin/users",
        headers=auth(admin_token),
        json={"email": email, "password": "Password123!", "full_name": email.split("@")[0], "role": "employee"},
    )
    assert resp.status_code == 200, resp.text
    login = client.post("/api/auth/login", json={"email": email, "password": "Password123!"})
    assert login.status_code == 200, login.text
    return login.headers["X-Access-Token"]


def create_panel(
    client: TestClient, token: str, document: dict | None = None, *, customer_id: int | None = None, **overrides
) -> dict:
    payload: dict[str, Any] = {
        "customer_id": customer_id if customer_id is not None else customer(client, token),
        "name": "Zählerschrank Haus A",
        "designation": "ZS1",
        "panel_type": "meter",
    }
    if document is not None:
        payload["document"] = document
    payload.update(overrides)
    resp = client.post("/api/schaltplan/panels", headers=auth(token), json=payload)
    assert resp.status_code == 200, resp.text
    return resp.json()


def store_directly(panel_id: int, document: dict) -> None:
    """Write a document past the schema, the way another release would have."""
    with SessionLocal() as db:
        plan = db.get(PanelPlan, panel_id)
        plan.document = copy.deepcopy(document)
        db.commit()


def stored(panel_id: int) -> dict:
    with SessionLocal() as db:
        return copy.deepcopy(db.get(PanelPlan, panel_id).document)


def device(device_id: str, kind: str, **overrides) -> dict:
    """A device as the editor sends it (``makeDevice`` in schaltplanDevices.ts)."""
    entry = DEVICE_CATALOG[kind]
    out = {
        "id": device_id, "kind": kind, "te": entry["te"], "poles": entry["poles"],
        "designation": "", "circuit": "", "label": "", "room": "", "rating": "",
        "residual_current": "", "rcd_type": "", "cable": "", "phase": "-", "parent_id": None,
        "feeds_following": False, "terminal_block": False, "note": "", "width_mm": None,
        "supplied_by": None,
    }
    out.update(overrides)
    return out


def cabinet_document(cabinet: str = "ZB33S", meter_module: str = "ZH3EH16") -> dict:
    """A small ZB33S board: a meter field with its HS, a distribution field."""
    return {
        "version": 1,
        "supply": {
            "system": "TN-C-S", "voltage": "400/230 V", "incoming": "NYY-J 5x16 mm²",
            "fuse": "NH 63 A", "meter_number": "", "note": "",
        },
        "rows": [
            {"id": "row-nar", "label": "F1 · NAR", "slots": 12, "devices": [
                device("dev-q0", "sls", designation="Q0", rating="E35")]},
            {"id": "row-aar1", "label": "F1 · AAR 1", "slots": 12, "devices": [
                device("dev-q1", "hauptschalter", designation="Q1", parent_id="dev-q0",
                       supplied_by={"module": "mod-a", "part": "hs"})]},
            {"id": "row-v1", "label": "F2 · Verteiler 1", "slots": 12, "devices": [
                device("dev-f1", "rcd", designation="F1", rating="40 A", residual_current="30 mA", rcd_type="A"),
                device("dev-c1", "mcb", designation="F1.1", circuit="1", label="Licht Flur", rating="B16")]},
        ],
        "terminal_labels": {},
        "enclosure": {
            "code": cabinet,
            "modules": [
                {
                    "id": "mod-a", "code": meter_module, "field": 0, "unit": 0, "label": "Allgemein",
                    "rails": {"nar": "row-nar", "aar1": "row-aar1"},
                    "fittings": [
                        {"key": "hs", "label": "Hauptschalter", "article_no": None,
                         "device_kind": "hauptschalter", "removable": True},
                        {"key": "busbar", "label": "Sammelschiene 5-polig 12×5 mm (NAR)", "article_no": None,
                         "device_kind": None, "removable": False},
                    ],
                    "removed_fittings": [],
                    "meters": [{"place": 0, "number": "1XYZ0000000042", "label": "WE 1"}],
                },
                {
                    "id": "mod-b", "code": "ZU37KS", "field": 1, "unit": 0, "label": "",
                    "rails": {"r1": "row-v1"}, "fittings": [], "removed_fittings": [], "meters": [],
                },
            ],
        },
    }


def custom_module_spec(code: str = "ZX37TEST", **overrides) -> dict:
    """An admin's own field module: two plain DIN rails and a PE/N block."""
    spec: dict[str, Any] = {
        "code": code,
        "article_no": code,
        "name": "Testfeld Verteiler, 2 Reihen",
        "family": "distribution",
        "field_height_mm": 1050,
        "width_fields": 1,
        "height_units": 2,
        "zones": [
            {"key": "vt", "type": "VT", "unit": 0, "units": 2,
             "rails": [{"key": "r1", "unit": 0, "ple": 12}, {"key": "r2", "unit": 1, "ple": 12}]},
        ],
        "fittings": [
            {"key": "pe_n", "label": "PE/N-Klemmen", "article_no": None, "removable": False,
             "device": None, "verified": True},
        ],
        "accessories": [],
        "verified": True,
    }
    spec.update(overrides)
    return spec


def custom_enclosure_spec(code: str = "ZX33TEST", **overrides) -> dict:
    spec: dict[str, Any] = {
        "code": code, "article_no": code, "name": "Testschrank 3 Felder",
        "height_mm": 1100, "width_mm": 800, "depth_mm": 205, "fields": 3, "door_leaves": 2,
        "units_per_field": 7, "ip": "IP44", "door": "Klappgriff", "verified": True,
    }
    spec.update(overrides)
    return spec


def hidden_project(number: str = "P-HIDDEN-1") -> int:
    """A project nobody was added to — made in the table, so the API's
    default membership never runs and an employee cannot see it."""
    with SessionLocal() as db:
        project = Project(project_number=number, name="Fremdes Projekt", status="active")
        db.add(project)
        db.commit()
        return project.id


def admin_id() -> int:
    with SessionLocal() as db:
        return int(db.query(User.id).filter(User.email == "admin@example.com").one()[0])


def article(name: str, *, stock: int = 0, manufacturer: str | None = None, number: str | None = None,
            ean: str | None = None) -> int:
    """A shelf article with ``stock`` pieces booked in through the ledger."""
    with SessionLocal() as db:
        row = WerkstattArticle(
            article_number=number or f"SP-T{next(_ARTICLE_NUMBERS):04d}",
            item_name=name, manufacturer=manufacturer, unit="Stk", ean=ean,
        )
        db.add(row)
        db.flush()
        if stock:
            apply_movement(db, article=row, movement_type="intake", quantity=stock, user_id=admin_id())
        db.commit()
        return row.id
