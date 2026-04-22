"""Werkstatt Datanorm import endpoints.

- POST /werkstatt/datanorm/upload  — multipart upload → preview with import_token
- POST /werkstatt/datanorm/commit  — apply preview, write audit row
- GET  /werkstatt/datanorm/history — audit log, latest first
"""

from __future__ import annotations

from pydantic import BaseModel, Field
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.deps import require_permission
from app.models.entities import User, WerkstattDatanormImport, WerkstattSupplier
from app.schemas.werkstatt import (
    DatanormEanConflictOut,
    DatanormImportPreviewOut,
    DatanormImportRecordOut,
    DatanormSampleRowOut,
)
from app.services.werkstatt_datanorm_import import (
    commit_preview,
    create_preview,
)

router = APIRouter(prefix="", tags=["werkstatt-desktop"])


DATANORM_UPLOAD_MAX_BYTES = 25 * 1024 * 1024  # 25 MiB


class DatanormCommitPayload(BaseModel):
    import_token: str = Field(min_length=8, max_length=256)
    replace_mode: bool = True


@router.post("/datanorm/upload", response_model=DatanormImportPreviewOut)
async def upload_datanorm(
    supplier_id: int = Form(...),
    file: UploadFile = File(...),
    _: User = Depends(require_permission("werkstatt:manage")),
    db: Session = Depends(get_db),
) -> DatanormImportPreviewOut:
    if not file.filename:
        raise HTTPException(status_code=400, detail="File name is required")
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="File body is required")
    if len(raw) > DATANORM_UPLOAD_MAX_BYTES:
        raise HTTPException(status_code=413, detail="File exceeds maximum upload size")
    try:
        preview = create_preview(
            db,
            supplier_id=supplier_id,
            filename=file.filename,
            file_bytes=raw,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return DatanormImportPreviewOut(
        import_token=preview.token,
        supplier_id=preview.supplier_id,
        supplier_name=preview.supplier_name,
        filename=preview.filename,
        file_size_bytes=preview.file_size_bytes,
        detected_version=preview.detected_version,
        detected_encoding=preview.detected_encoding,
        total_rows=preview.total_rows,
        rows_new=preview.rows_new,
        rows_updated=preview.rows_updated,
        rows_unchanged=preview.rows_unchanged,
        ean_conflicts=[
            DatanormEanConflictOut(
                ean=c.ean,
                item_name=c.item_name,
                existing_supplier_id=c.existing_supplier_id,
                existing_supplier_name=c.existing_supplier_name,
                existing_article_no=c.existing_article_no,
            )
            for c in preview.ean_conflicts
        ],
        sample_rows=[
            DatanormSampleRowOut(
                article_no=s.article_no or "",
                item_name=s.item_name,
                ean=s.ean,
                manufacturer=s.manufacturer,
                price_text=s.price_text,
            )
            for s in preview.sample_rows
        ],
        uploaded_at=preview.uploaded_at,
        expires_at=preview.expires_at,
    )


@router.post("/datanorm/commit", response_model=DatanormImportRecordOut)
def commit_datanorm_import(
    payload: DatanormCommitPayload,
    current_user: User = Depends(require_permission("werkstatt:manage")),
    db: Session = Depends(get_db),
) -> DatanormImportRecordOut:
    try:
        audit = commit_preview(
            db,
            token=payload.import_token,
            replace_mode=payload.replace_mode,
            actor_user_id=current_user.id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    supplier = db.get(WerkstattSupplier, audit.supplier_id)
    created_by_name = _user_display_name(db, audit.created_by)
    if audit.status == "failed":
        raise HTTPException(status_code=500, detail=audit.error_message or "Datanorm commit failed")
    return DatanormImportRecordOut(
        id=audit.id,
        supplier_id=audit.supplier_id,
        supplier_name=supplier.name if supplier else "",
        filename=audit.filename,
        status=audit.status,  # type: ignore[arg-type]
        total_rows=audit.total_rows,
        rows_new=audit.rows_new,
        rows_updated=audit.rows_updated,
        rows_failed=audit.rows_failed,
        started_at=audit.started_at,
        finished_at=audit.finished_at,
        error_message=audit.error_message,
        created_by=audit.created_by,
        created_by_name=created_by_name,
    )


@router.get("/datanorm/history", response_model=list[DatanormImportRecordOut])
def list_datanorm_history(
    _: User = Depends(require_permission("werkstatt:manage")),
    db: Session = Depends(get_db),
) -> list[DatanormImportRecordOut]:
    rows = list(
        db.scalars(
            select(WerkstattDatanormImport)
            .order_by(
                WerkstattDatanormImport.started_at.desc(),
                WerkstattDatanormImport.id.desc(),
            )
            .limit(200)
        ).all()
    )
    supplier_ids = {r.supplier_id for r in rows}
    user_ids = {r.created_by for r in rows if r.created_by}
    suppliers_by_id: dict[int, str] = {}
    if supplier_ids:
        suppliers_by_id = {
            sid: name
            for sid, name in db.execute(
                select(WerkstattSupplier.id, WerkstattSupplier.name).where(
                    WerkstattSupplier.id.in_(supplier_ids)
                )
            ).all()
        }
    users_by_id: dict[int, str] = {}
    if user_ids:
        users_by_id = {
            uid: (full_name or email or f"User #{uid}")
            for uid, full_name, email in db.execute(
                select(User.id, User.full_name, User.email).where(User.id.in_(user_ids))
            ).all()
        }
    return [
        DatanormImportRecordOut(
            id=r.id,
            supplier_id=r.supplier_id,
            supplier_name=suppliers_by_id.get(r.supplier_id, ""),
            filename=r.filename,
            status=r.status,  # type: ignore[arg-type]
            total_rows=r.total_rows,
            rows_new=r.rows_new,
            rows_updated=r.rows_updated,
            rows_failed=r.rows_failed,
            started_at=r.started_at,
            finished_at=r.finished_at,
            error_message=r.error_message,
            created_by=r.created_by,
            created_by_name=users_by_id.get(r.created_by) if r.created_by else None,
        )
        for r in rows
    ]


def _user_display_name(db: Session, user_id: int | None) -> str | None:
    if user_id is None:
        return None
    user = db.get(User, user_id)
    if user is None:
        return None
    return user.full_name or user.email or f"User #{user.id}"
