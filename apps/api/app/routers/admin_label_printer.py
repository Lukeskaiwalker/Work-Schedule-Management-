"""Admin edits of the label printer: one material, and the printer-level values.

Both writes are compare-and-set on the configuration's ``revision`` (required
here): two admins editing the same profile, or the wizard writing after a
session's ``activate`` bumped the revision, must never silently overwrite each
other. Ranges are validated in the service, so every refusal reads German.
GET/PATCH of the whole configuration and the test prints stay in
``routers/admin.py``.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.deps import require_permission
from app.models.entities import User
from app.schemas.label_printer import LabelMaterialUpdate, PrinterSettingsUpdate
from app.schemas.settings import LabelPrinterSettingsOut
from app.services.audit import log_admin_action
from app.services.werkstatt_label_errors import (
    LabelRequestRefused,
    MaterialValidationError,
    PrinterSettingsValidationError,
    StaleRevision,
)
from app.services.werkstatt_label_materials import (
    apply_material_changes,
    require_material,
    reset_material_fields,
    update_config,
)
from app.services.werkstatt_label_profile import NULLABLE_FIELDS, STORED_FIELDS
from app.services.werkstatt_label_settings_view import label_printer_settings_out

router = APIRouter(prefix="/admin/settings/label-printer", tags=["admin"])


def stale_revision_error(exc: StaleRevision) -> HTTPException:
    return HTTPException(
        status_code=409,
        detail={"code": "stale_revision", "message": str(exc), "revision": exc.revision},
    )


def _invalid(code: str, message: str) -> HTTPException:
    return HTTPException(status_code=422, detail={"code": code, "message": message})


@router.put("/materials/{material_id}", response_model=LabelPrinterSettingsOut)
def update_label_material(
    material_id: str,
    payload: LabelMaterialUpdate,
    admin: User = Depends(require_permission("settings:manage")),
    db: Session = Depends(get_db),
):
    """Change one profile. Explicit null only on the nullable fields;
    ``reset_fields`` (builtins only) returns fields to the code default."""
    changes: dict[str, Any] = payload.model_dump(exclude_unset=True)
    revision = changes.pop("revision")
    reset_fields = list(changes.pop("reset_fields", []) or [])
    for name, value in changes.items():
        if value is None and name not in NULLABLE_FIELDS:
            raise _invalid("invalid_material", f"Feld {name} darf nicht leer sein")
    changed_fields: list[str] = []

    def mutate(current: dict[str, Any]) -> dict[str, Any]:
        before = require_material(current["materials"], material_id)
        after = apply_material_changes(reset_material_fields(before, reset_fields), changes)
        changed_fields.extend(name for name in STORED_FIELDS if getattr(before, name) != getattr(after, name))
        return {"materials": [after if profile.id == material_id else profile for profile in current["materials"]]}

    try:
        update_config(db, mutate, expected_revision=revision)
    except StaleRevision as exc:
        raise stale_revision_error(exc) from exc
    except LabelRequestRefused as exc:
        raise HTTPException(status_code=exc.status, detail=exc.detail()) from exc
    except (MaterialValidationError, PrinterSettingsValidationError) as exc:
        raise _invalid("invalid_material", str(exc)) from exc
    db.commit()
    log_admin_action(
        db, admin, "settings.label_printer.material_update", "settings", "label-printer",
        {"id": material_id, "changed_fields": changed_fields, "reset_fields": reset_fields},
    )
    return label_printer_settings_out(db, admin)


@router.put("/printer", response_model=LabelPrinterSettingsOut)
def update_printer_settings(
    payload: PrinterSettingsUpdate,
    admin: User = Depends(require_permission("settings:manage")),
    db: Session = Depends(get_db),
):
    """Baseline for every SMPL job, the pinned row offset, the staff switch."""
    changes: dict[str, Any] = payload.model_dump(exclude_unset=True)
    revision = changes.pop("revision")
    staff_change: dict[str, bool] = {}

    def mutate(current: dict[str, Any]) -> dict[str, Any]:
        out: dict[str, Any] = {}
        if "baseline" in changes:
            baseline = dict(current["baseline_overrides"])
            # Explicit null for one key = back to the code default; a null
            # baseline as a whole resets all three.
            for key, value in (changes["baseline"] or {"darkness": None, "speed_ips": None, "stop_mm": None}).items():
                if value is None:
                    baseline.pop(key, None)
                else:
                    baseline[key] = value
            out["baseline_overrides"] = baseline
        if "row_offset_dots" in changes:
            out["row_offset_dots"] = changes["row_offset_dots"]
        wanted = changes.get("label_calibration_staff_enabled")
        if wanted is not None:
            out["label_calibration_staff_enabled"] = wanted
            if wanted != current["label_calibration_staff_enabled"]:
                staff_change.update({"from": current["label_calibration_staff_enabled"], "to": wanted})
        return out

    try:
        config = update_config(db, mutate, expected_revision=revision)
    except StaleRevision as exc:
        raise stale_revision_error(exc) from exc
    except PrinterSettingsValidationError as exc:
        raise _invalid("invalid_printer_settings", str(exc)) from exc
    except MaterialValidationError as exc:
        raise _invalid("invalid_material", str(exc)) from exc
    db.commit()
    details: dict[str, Any] = {
        "baseline": config["baseline_overrides"],
        "row_offset_dots": config["row_offset_dots"],
        "revision": config["revision"],
    }
    if staff_change:
        details["staff_enabled"] = staff_change
    log_admin_action(db, admin, "settings.label_printer.printer_update", "settings", "label-printer", details)
    return label_printer_settings_out(db, admin)
