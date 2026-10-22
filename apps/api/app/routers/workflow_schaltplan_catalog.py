"""The cabinet catalogue: Hager univers Z cabinets and field modules (docs/PANEL_ENCLOSURE.md §7).

Reading needs a login — whoever plans a board picks its cabinet. Writing
needs ``werkstatt:manage``: the catalogue is shop knowledge every board
relies on, and a module's fittings decide what comes back to the shelf
(D11). Every write is audited (``services/panel_enclosure_catalog.py``).

The write bodies are read by hand, not declared as a body parameter: the
32 KB ceiling of one entry is checked on the raw bytes, before anything
parses them, and only after the permission check has run (dependencies
resolve in the order they are declared). Spec errors come back in German
with the JSON path, for the admin's JSON editor.
"""

from __future__ import annotations

import json

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.deps import get_current_user, require_permission
from app.models.entities import User
from app.schemas.panel_enclosure import (
    CatalogArchiveIn,
    CatalogEntryIn,
    CatalogEntryOut,
    CatalogInputError,
    EnclosureCatalogOut,
    parse_catalog_entry,
)
from app.services import panel_enclosure_catalog as catalog_service

router = APIRouter(prefix="/schaltplan", tags=["schaltplan"])

MAX_ENTRY_BYTES = 32 * 1024
TOO_LARGE = "Eintrag zu groß (max. 32 KB)."
_MANAGE = require_permission("werkstatt:manage")


async def _entry_body(request: Request) -> CatalogEntryIn:
    """The request body as a catalogue entry: size first, then JSON, then the spec."""
    declared = request.headers.get("content-length", "")
    if declared.isdigit() and int(declared) > MAX_ENTRY_BYTES:
        raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail=TOO_LARGE)
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        # A lying or missing Content-Length must not let a larger body through.
        if len(body) > MAX_ENTRY_BYTES:
            raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail=TOO_LARGE)
    try:
        raw = json.loads(bytes(body))
    except (ValueError, RecursionError):
        # RecursionError: 32 KB of "[" nest deeper than the decoder's stack —
        # no ValueError, and without this it would answer 500.
        raise HTTPException(status_code=422, detail="Aufbau ungültig: kein gültiges JSON.") from None
    try:
        return parse_catalog_entry(raw)
    except CatalogInputError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from None


def _refused(exc: catalog_service.CatalogError) -> HTTPException:
    return HTTPException(status_code=exc.status_code, detail=exc.message)


@router.get("/enclosure-catalog", response_model=EnclosureCatalogOut)
def get_enclosure_catalog(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> EnclosureCatalogOut:
    """Every cabinet and module, archived and invalid ones flagged so stored
    boards still resolve; what is in stock or was used lately comes first."""
    return catalog_service.catalog_out(db, current_user, catalog_service.load_catalog(db))


@router.post("/enclosure-catalog", response_model=CatalogEntryOut, status_code=status.HTTP_201_CREATED)
def create_catalog_entry(
    current_user: User = Depends(_MANAGE),
    payload: CatalogEntryIn = Depends(_entry_body),
    db: Session = Depends(get_db),
) -> CatalogEntryOut:
    try:
        entry = catalog_service.create_entry(db, payload=payload, user=current_user)
    except catalog_service.CatalogError as exc:
        raise _refused(exc) from None
    return catalog_service.entry_out(db, current_user, entry)


@router.put("/enclosure-catalog/{code}", response_model=CatalogEntryOut)
def update_catalog_entry(
    code: str,
    current_user: User = Depends(_MANAGE),
    payload: CatalogEntryIn = Depends(_entry_body),
    db: Session = Depends(get_db),
) -> CatalogEntryOut:
    """A corrected spec: a built-in gets an override, a custom entry is replaced."""
    try:
        entry = catalog_service.update_entry(db, code=code, payload=payload, user=current_user)
    except catalog_service.CatalogError as exc:
        raise _refused(exc) from None
    return catalog_service.entry_out(db, current_user, entry)


@router.patch("/enclosure-catalog/{code}", response_model=CatalogEntryOut)
def archive_catalog_entry(
    code: str,
    payload: CatalogArchiveIn,
    current_user: User = Depends(_MANAGE),
    db: Session = Depends(get_db),
) -> CatalogEntryOut:
    try:
        entry = catalog_service.set_archived(db, code=code, archived=payload.archived, user=current_user)
    except catalog_service.CatalogError as exc:
        raise _refused(exc) from None
    return catalog_service.entry_out(db, current_user, entry)


@router.delete("/enclosure-catalog/{code}/override", response_model=CatalogEntryOut)
def reset_catalog_entry(
    code: str,
    current_user: User = Depends(_MANAGE),
    db: Session = Depends(get_db),
) -> CatalogEntryOut:
    """Back to the Hager standard. Custom entries are archived, never deleted."""
    try:
        entry = catalog_service.reset_override(db, code=code, user=current_user)
    except catalog_service.CatalogError as exc:
        raise _refused(exc) from None
    return catalog_service.entry_out(db, current_user, entry)
