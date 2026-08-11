"""Machines (Maschinen) — individually tracked units of a catalogue article.

Gating follows the Werkstatt convention established by the boxes router: reads
are authenticated-only so field staff can look a machine up, and structural
mutations (creating, editing, archiving) require ``werkstatt:manage``.

Booking, returning and recording an inspection are deliberately
authenticated-only. The whole point is that the person who physically picks a
drill off the shelf records it there and then — requiring a manage permission
would mean the log is kept by whoever has admin rights rather than whoever has
the machine, which is how tool registers stop reflecting reality.
"""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.deps import get_current_user, require_permission
from app.core.time import utcnow
from app.models.entities import (
    User,
    WerkstattArticle,
    WerkstattArticleUnit,
    WerkstattLocation,
)
from app.schemas.werkstatt_machines import (
    MachineBookPayload,
    MachineComponentOut,
    MachineCreatePayload,
    MachineInspectionPayload,
    MachineMovementOut,
    MachineOut,
    MachineReturnPayload,
    MachineUpdatePayload,
)
from app.services import werkstatt_machines as machines

router = APIRouter(prefix="/werkstatt", tags=["werkstatt-machines"])


def _name_map(db: Session) -> tuple[dict[int, str], dict[int, str]]:
    """id → name for locations and users, fetched once per request.

    The alternative is a relationship load per row; a workshop with a few
    hundred machines would turn one list into a few hundred queries.
    """
    locations = {
        row.id: row.name for row in db.scalars(select(WerkstattLocation)).all()
    }
    users = {
        row.id: (row.full_name or row.email) for row in db.scalars(select(User)).all()
    }
    return locations, users


def _to_out(
    unit: WerkstattArticleUnit,
    *,
    article: WerkstattArticle | None,
    locations: dict[int, str],
    users: dict[int, str],
    components: list[WerkstattArticleUnit] | None = None,
    component_articles: dict[int, WerkstattArticle] | None = None,
    now: datetime | None = None,
) -> MachineOut:
    moment = now or utcnow()
    component_articles = component_articles or {}

    return MachineOut(
        id=unit.id,
        unit_number=unit.unit_number,
        article_id=unit.article_id,
        article_name=article.item_name if article else None,
        manufacturer=article.manufacturer if article else None,
        parent_unit_id=unit.parent_unit_id,
        serial_number=unit.serial_number,
        status=unit.status,
        current_location_id=unit.current_location_id,
        current_location_name=locations.get(unit.current_location_id or -1),
        holder_user_id=unit.holder_user_id,
        holder_name=users.get(unit.holder_user_id or -1),
        booked_from=unit.booked_from,
        booked_until=unit.booked_until,
        is_overdue=bool(
            unit.status == machines.STATUS_OUT
            and unit.booked_until is not None
            and unit.booked_until < moment
        ),
        inspection_required=unit.inspection_required,
        inspection_interval_days=unit.inspection_interval_days,
        last_inspected_at=unit.last_inspected_at,
        next_inspection_due_at=unit.next_inspection_due_at,
        inspection_overdue=bool(
            unit.inspection_required
            and unit.next_inspection_due_at is not None
            and unit.next_inspection_due_at < moment
        ),
        purchased_at=unit.purchased_at,
        notes=unit.notes,
        is_archived=unit.is_archived,
        created_at=unit.created_at,
        components=[
            MachineComponentOut(
                id=child.id,
                unit_number=child.unit_number,
                article_id=child.article_id,
                article_name=(
                    component_articles[child.article_id].item_name
                    if child.article_id in component_articles
                    else None
                ),
                status=child.status,
                serial_number=child.serial_number,
                next_inspection_due_at=child.next_inspection_due_at,
            )
            for child in (components or [])
        ],
    )


def _load(db: Session, unit_id: int) -> WerkstattArticleUnit:
    unit = db.get(WerkstattArticleUnit, unit_id)
    if unit is None:
        raise HTTPException(status_code=404, detail="Maschine nicht gefunden")
    return unit


@router.get("/machines", response_model=list[MachineOut])
def list_machines(
    q: str | None = Query(default=None, max_length=200),
    machine_status: str | None = Query(default=None, alias="status"),
    location_id: int | None = None,
    holder_user_id: int | None = None,
    # Two saved views the Maschinen tab opens with. Server-side so "late" and
    # "due" mean the same thing everywhere, including the mobile scanner.
    overdue_only: bool = False,
    inspection_due_only: bool = False,
    include_archived: bool = False,
    # Sub-components clutter the top-level list — they are shown under their
    # parent instead. Opt in when you genuinely want every unit.
    include_components: bool = False,
    _: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[MachineOut]:
    stmt = select(WerkstattArticleUnit)
    if not include_archived:
        stmt = stmt.where(WerkstattArticleUnit.is_archived.is_(False))
    if not include_components:
        stmt = stmt.where(WerkstattArticleUnit.parent_unit_id.is_(None))
    if machine_status:
        stmt = stmt.where(WerkstattArticleUnit.status == machine_status)
    if location_id is not None:
        stmt = stmt.where(WerkstattArticleUnit.current_location_id == location_id)
    if holder_user_id is not None:
        stmt = stmt.where(WerkstattArticleUnit.holder_user_id == holder_user_id)

    now = utcnow()
    if overdue_only:
        stmt = stmt.where(
            WerkstattArticleUnit.status == machines.STATUS_OUT,
            WerkstattArticleUnit.booked_until.is_not(None),
            WerkstattArticleUnit.booked_until < now,
        )
    if inspection_due_only:
        stmt = stmt.where(
            WerkstattArticleUnit.inspection_required.is_(True),
            WerkstattArticleUnit.next_inspection_due_at.is_not(None),
            WerkstattArticleUnit.next_inspection_due_at < now,
        )

    units = list(db.scalars(stmt.order_by(WerkstattArticleUnit.unit_number)).all())

    # Free-text search spans the machine's own identifiers and its article name,
    # because people look for "the Bosch" far more often than for "M-0007".
    if q:
        needle = q.strip().lower()
        article_ids = {u.article_id for u in units}
        names = {
            a.id: f"{a.item_name} {a.manufacturer or ''}".lower()
            for a in db.scalars(
                select(WerkstattArticle).where(WerkstattArticle.id.in_(article_ids or {-1}))
            ).all()
        }
        units = [
            u
            for u in units
            if needle in u.unit_number.lower()
            or needle in (u.serial_number or "").lower()
            or needle in names.get(u.article_id, "")
        ]

    locations, users = _name_map(db)
    articles = {
        a.id: a
        for a in db.scalars(
            select(WerkstattArticle).where(
                WerkstattArticle.id.in_({u.article_id for u in units} or {-1})
            )
        ).all()
    }
    return [
        _to_out(u, article=articles.get(u.article_id), locations=locations, users=users, now=now)
        for u in units
    ]


@router.get("/machines/{unit_id}", response_model=MachineOut)
def get_machine(
    unit_id: int,
    _: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> MachineOut:
    unit = _load(db, unit_id)
    components = machines.child_units(db, unit.id)
    locations, users = _name_map(db)
    wanted = {unit.article_id} | {c.article_id for c in components}
    articles = {
        a.id: a
        for a in db.scalars(
            select(WerkstattArticle).where(WerkstattArticle.id.in_(wanted or {-1}))
        ).all()
    }
    return _to_out(
        unit,
        article=articles.get(unit.article_id),
        locations=locations,
        users=users,
        components=components,
        component_articles=articles,
    )


@router.get("/machines/{unit_id}/history", response_model=list[MachineMovementOut])
def get_machine_history(
    unit_id: int,
    limit: int = Query(default=100, ge=1, le=500),
    _: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[MachineMovementOut]:
    _load(db, unit_id)
    locations, users = _name_map(db)
    return [
        MachineMovementOut(
            id=m.id,
            movement_type=m.movement_type,
            from_location_id=m.from_location_id,
            from_location_name=locations.get(m.from_location_id or -1),
            to_location_id=m.to_location_id,
            to_location_name=locations.get(m.to_location_id or -1),
            user_id=m.user_id,
            user_name=users.get(m.user_id),
            assignee_user_id=m.assignee_user_id,
            assignee_name=users.get(m.assignee_user_id or -1),
            expected_return_at=m.expected_return_at,
            notes=m.notes,
            created_at=m.created_at,
        )
        for m in machines.unit_history(db, unit_id, limit=limit)
    ]


@router.post("/machines", response_model=MachineOut, status_code=status.HTTP_201_CREATED)
def create_machine(
    payload: MachineCreatePayload,
    current_user: User = Depends(require_permission("werkstatt:manage")),
    db: Session = Depends(get_db),
) -> MachineOut:
    article = db.get(WerkstattArticle, payload.article_id)
    if article is None:
        raise HTTPException(status_code=404, detail="Artikel nicht gefunden")
    if payload.parent_unit_id is not None:
        parent = db.get(WerkstattArticleUnit, payload.parent_unit_id)
        if parent is None:
            raise HTTPException(status_code=404, detail="Übergeordnete Maschine nicht gefunden")
        # One level only. A charger that belongs to a battery that belongs to a
        # drill is a hierarchy nobody wants to reason about at 6am in a van.
        if parent.parent_unit_id is not None:
            raise HTTPException(
                status_code=400, detail="Komponenten können nicht weiter verschachtelt werden"
            )

    unit = machines.create_unit(
        db,
        article=article,
        actor=current_user,
        serial_number=payload.serial_number,
        parent_unit_id=payload.parent_unit_id,
        current_location_id=payload.current_location_id,
        inspection_required=payload.inspection_required,
        inspection_interval_days=payload.inspection_interval_days,
        last_inspected_at=payload.last_inspected_at,
        purchased_at=payload.purchased_at,
        notes=payload.notes,
    )
    db.commit()
    db.refresh(unit)
    locations, users = _name_map(db)
    return _to_out(unit, article=article, locations=locations, users=users)


@router.patch("/machines/{unit_id}", response_model=MachineOut)
def update_machine(
    unit_id: int,
    payload: MachineUpdatePayload,
    _: User = Depends(require_permission("werkstatt:manage")),
    db: Session = Depends(get_db),
) -> MachineOut:
    unit = _load(db, unit_id)
    data = payload.model_dump(exclude_unset=True)

    if "status" in data and data["status"] not in machines.VALID_STATUSES:
        raise HTTPException(status_code=400, detail="Ungültiger Status")
    if "parent_unit_id" in data and data["parent_unit_id"] == unit.id:
        raise HTTPException(status_code=400, detail="Maschine kann nicht sich selbst zugeordnet werden")

    for field, value in data.items():
        setattr(unit, field, value)

    # Changing the interval must move the due date, or the machine keeps its old
    # schedule and the change looks accepted while doing nothing.
    if "inspection_interval_days" in data and unit.last_inspected_at:
        from datetime import timedelta

        unit.next_inspection_due_at = (
            unit.last_inspected_at + timedelta(days=unit.inspection_interval_days)
            if unit.inspection_interval_days
            else None
        )

    db.commit()
    db.refresh(unit)
    article = db.get(WerkstattArticle, unit.article_id)
    locations, users = _name_map(db)
    return _to_out(unit, article=article, locations=locations, users=users)


@router.post("/machines/{unit_id}/book", response_model=list[MachineOut])
def book_machine(
    unit_id: int,
    payload: MachineBookPayload,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[MachineOut]:
    unit = _load(db, unit_id)
    try:
        changed = machines.book_unit(
            db,
            unit=unit,
            actor=current_user,
            holder_user_id=payload.holder_user_id,
            to_location_id=payload.to_location_id,
            booked_from=payload.booked_from,
            booked_until=payload.booked_until,
            for_today=payload.for_today,
            notes=payload.notes,
        )
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=_booking_error(str(exc))) from exc

    db.commit()
    locations, users = _name_map(db)
    articles = {
        a.id: a
        for a in db.scalars(
            select(WerkstattArticle).where(
                WerkstattArticle.id.in_({c.article_id for c in changed} or {-1})
            )
        ).all()
    }
    return [
        _to_out(c, article=articles.get(c.article_id), locations=locations, users=users)
        for c in changed
    ]


def _booking_error(code: str) -> str:
    if code.startswith("unit_not_bookable"):
        state = code.split(":", 1)[-1]
        return f"Maschine ist derzeit nicht verfügbar ({state})"
    if code == "booking_target_required":
        return "Bitte eine Person oder einen Lagerort auswählen"
    if code == "booking_window_invalid":
        return "Rückgabezeitpunkt muss nach dem Ausgabezeitpunkt liegen"
    return "Buchung nicht möglich"


@router.post("/machines/{unit_id}/return", response_model=list[MachineOut])
def return_machine(
    unit_id: int,
    payload: MachineReturnPayload,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[MachineOut]:
    unit = _load(db, unit_id)
    try:
        changed = machines.return_unit(
            db,
            unit=unit,
            actor=current_user,
            to_location_id=payload.to_location_id,
            status=payload.status,
            notes=payload.notes,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Ungültiger Status") from exc

    db.commit()
    locations, users = _name_map(db)
    articles = {
        a.id: a
        for a in db.scalars(
            select(WerkstattArticle).where(
                WerkstattArticle.id.in_({c.article_id for c in changed} or {-1})
            )
        ).all()
    }
    return [
        _to_out(c, article=articles.get(c.article_id), locations=locations, users=users)
        for c in changed
    ]


@router.post("/machines/{unit_id}/inspection", response_model=MachineOut)
def record_machine_inspection(
    unit_id: int,
    payload: MachineInspectionPayload,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> MachineOut:
    unit = _load(db, unit_id)
    machines.record_inspection(
        db,
        unit=unit,
        actor=current_user,
        inspected_at=payload.inspected_at,
        interval_days=payload.interval_days,
        passed=payload.passed,
        notes=payload.notes,
    )
    db.commit()
    db.refresh(unit)
    article = db.get(WerkstattArticle, unit.article_id)
    locations, users = _name_map(db)
    return _to_out(unit, article=article, locations=locations, users=users)
