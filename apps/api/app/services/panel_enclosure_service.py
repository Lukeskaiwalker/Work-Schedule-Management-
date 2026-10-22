"""What the plan routes need from the cabinet layer, in one place.

docs/PANEL_ENCLOSURE.md §2.2, §5, §7, §13. Kept out of
``routers/workflow_schaltplan.py`` so that file stays a plan router (and
under 800 lines): the detail findings, the write-path code check, the copy
that forgets meter numbers, and the Aufbau PDF are each one call from there.

The catalogue is loaded only for a board that has a cabinet: a legacy board
must cost exactly what it cost before (one query fewer per detail read).
"""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException, status
from pydantic import ValidationError
from sqlalchemy.orm import Session

from app.models.customer import Customer
from app.models.entities import Project
from app.models.schaltplan import PanelPlan
from app.schemas.panel_enclosure import DeviceSuppliedBy
from app.schemas.schaltplan import PanelDocument
from app.services import schaltplan_material
from app.services.panel_enclosure_catalog import assert_known_codes, load_catalog
from app.services.panel_enclosure_layout import dicts, enclosure_of
from app.services.panel_enclosure_pdf import build_aufbau_pdf
from app.services.panel_enclosure_rules import enclosure_findings
from app.services.runtime_settings import get_company_settings

NO_CABINET = "Für diesen Verteiler ist kein Schrank geplant."
INVALID_BLOCK = (
    "Schrankdaten fehlerhaft gespeichert — ausgeblendet und beim nächsten Speichern entfernt; "
    "Reihen und Geräte bleiben."
)

__all__ = [
    "INVALID_BLOCK", "NO_CABINET", "assert_known_codes", "aufbau_pdf", "detail_findings", "readable_document",
    "without_meter_numbers",
]


def readable_document(document: Any) -> tuple[Any, PanelDocument, list[dict[str, str]]]:
    """(the document to derive from, its typed form, findings) for the read path.

    Slice P stored ``enclosure`` and ``supplied_by`` as opaque JSON, so a
    board may hold a block the feature's types refuse — written while P was
    live, or after a rollback to it. Such a board must still open (D14): the
    block is left out, with one finding, and the next save drops it for
    good. Rows and devices stay. Anything else that fails validation fails
    as it always did; this is no general repair.
    """
    try:
        return document, PanelDocument.model_validate(document), []
    except ValidationError:
        cleaned = _without_unreadable_blocks(document)
        if cleaned is document:
            raise
    finding = {"level": "warn", "scope": "", "message": INVALID_BLOCK, "rule": "encl.invalid_block"}
    return cleaned, PanelDocument.model_validate(cleaned), [finding]


def _without_unreadable_blocks(document: Any) -> Any:
    """A copy without the cabinet blocks that do not validate; the input itself when every one does."""
    if not isinstance(document, dict):
        return document
    out = document
    if document.get("enclosure") is not None and not _readable_enclosure(document["enclosure"]):
        out = {**out, "enclosure": None}
    rows = document.get("rows")
    if isinstance(rows, list):
        cleaned = [_row_without_bad_claims(row) for row in rows]
        if any(new is not old for new, old in zip(cleaned, rows)):
            out = {**out, "rows": cleaned}
    return out


def _row_without_bad_claims(row: Any) -> Any:
    if not isinstance(row, dict) or not isinstance(row.get("devices"), list):
        return row
    devices = [_device_without_bad_claim(device) for device in row["devices"]]
    return {**row, "devices": devices} if any(new is not old for new, old in zip(devices, row["devices"])) else row


def _device_without_bad_claim(device: Any) -> Any:
    if not isinstance(device, dict) or device.get("supplied_by") is None:
        return device
    try:
        DeviceSuppliedBy.model_validate(device["supplied_by"])
    except ValidationError:
        return {**device, "supplied_by": None}
    return device


def _readable_enclosure(enclosure: Any) -> bool:
    # Through the document, so the 64 KB ceiling (measured with defaults
    # filled in, unlike Slice P's raw measure) is part of the check.
    try:
        PanelDocument.model_validate({"enclosure": enclosure})
    except ValidationError:
        return False
    return True


def detail_findings(db: Session, document: Any) -> list[dict[str, str]]:
    """The cabinet findings appended to ``validate_document``'s; [] without a cabinet."""
    if enclosure_of(document) is None:
        return []
    return enclosure_findings(document, load_catalog(db))


def without_meter_numbers(document: Any) -> Any:
    """A copy of the board whose meters keep place and label but no number.

    A meter number identifies one physical meter (§2.1); a duplicated board
    is a second cabinet with meters of its own. Everything else is shared,
    unchanged, with the source document — nothing is mutated.
    """
    enclosure = enclosure_of(document)
    if enclosure is None:
        return document
    modules = enclosure.get("modules")
    if not isinstance(modules, list):
        return document
    cleared = [
        {**module, "meters": [{**meter, "number": ""} for meter in dicts(module.get("meters"))]}
        if isinstance(module, dict) and isinstance(module.get("meters"), list) else module
        for module in modules
    ]
    return {**document, "enclosure": {**enclosure, "modules": cleared}}


def aufbau_pdf(db: Session, plan: PanelPlan) -> bytes:
    """The Aufbau sheet plus the Materialliste pages (§13); 409 without a cabinet."""
    document = plan.document or {}
    if enclosure_of(document) is None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=NO_CABINET)
    catalog = load_catalog(db)
    customer = db.get(Customer, plan.customer_id)
    project = db.get(Project, plan.project_id) if plan.project_id else None
    return build_aufbau_pdf(
        plan=plan,
        catalog=catalog,
        material=schaltplan_material.panel_material(db, plan),
        findings=enclosure_findings(document, catalog),
        customer_name=getattr(customer, "name", None),
        project_label=f"{project.project_number} · {project.name}" if project is not None else None,
        company_name=get_company_settings(db).get("company_name"),
    )
