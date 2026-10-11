"""Consumables at the rack, and the projects they go into.

Owner, 2026-10-10: "'Waren Ausgabe' only works for tools never for
consumables, any item that is not inside the machine tab is a consumable, when
we scan it we book it out of the inventory and it is installed at a work
site. When we do the item dispense and have to select a user we can then also
select one of the current and recent projects for that week of that user to
book it to that project."

Three endpoints beside the station router (``workflow_station_werkstatt.py``,
already past its size budget), behind the same station token:

* ``GET /crew-projects`` — every crew member's current and recent projects
  (``services/station_projects.py``), one bulk answer the Pi caches next to
  the crew list, because a tap on a name must never wait for the network;
* ``POST /consumptions`` — a consumable leaves the stock for good: a
  ``consumption`` row with the person and, when picked, the project. Never a
  ``checkout`` loan — ``/movements`` keeps booking those for tools, and old
  agents keep using it;
* ``POST /consumptions/undo`` — pieces taken back (ABBRUCH, or leftovers
  carried back), bounded by what is still consumed in that bucket. A
  Rückgabe of a consumable that was LENT before 2026-10-10 closes that loan
  instead (``return``), so the old loan does not stay open while somebody
  else's consumption shrinks; an ABBRUCH also takes back the short-shelf
  top-up of the booking it cancels.

Like the station router this owns no stock rules: ``services/
werkstatt_consumption.py`` is the one implementation the desk and the phone
run too. What it owns is the boundary — a station token and nothing else,
the person has to be somebody the crew list offers (one sentence for unknown,
inactive and partner logins, so the wall is no user-id oracle), the station's
acting user and marker on every row, and ``request_id`` replay, because the Pi
gives up after a few seconds while the server may already have committed.
"""

from __future__ import annotations

from dataclasses import dataclass

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.models.entities import Project, Station, User, WerkstattArticle, WerkstattMovement
from app.routers.workflow_helpers import _list_active_assignable_users
from app.routers.workflow_station import get_current_station
from app.routers.workflow_station_werkstatt import _station_notes, resolve_station_user_id
from app.schemas.station_consumption import (
    StationConsumptionOut,
    StationConsumptionPersonOut,
    StationConsumptionProjectOut,
    StationConsumptionRequest,
    StationConsumptionUndoRequest,
    StationCrewProjectsOut,
    StationCrewProjectsPersonOut,
    StationOfferedProjectOut,
)
from app.services import station_projects
from app.services.werkstatt_consumption import (
    ARTICLE_ARCHIVED,
    CONSUMPTION,
    CONSUMPTION_UNDO,
    ConsumptionError,
    book_stock_consumption,
    open_buckets,
    own_open_buckets,
    require_bookable_project,
    reverse_top_up,
    top_up_reversed_by,
    undo_stock_consumption,
)
from app.services.werkstatt_loans import OpenLoan, loan_refusal, open_loan_for_article, open_loan_of_person
from app.services.werkstatt_movements import MovementError, apply_movement, load_article_for_update
from app.services.werkstatt_scan import _article_out

router = APIRouter(prefix="/station/werkstatt", tags=["station-werkstatt"])

PERSON_UNKNOWN = "Unbekannte Person."
NOTHING_TO_TAKE_BACK = "Kein Verbrauch dieses Artikels zum Zurücknehmen."
REQUEST_ID_TAKEN = "Diese Anfrage-ID gehört zu einer anderen Buchung."
ARTICLE_NOT_FOUND = "Artikel nicht gefunden"
TOP_UP_REVERSED_NOTE = "Nachbuchung bei Abbruch zurückgenommen"

RETURN = "return"
# What a token on /consumptions/undo may have booked: a take-back, or the
# return of an old loan.
_UNDO_KINDS = (CONSUMPTION_UNDO, RETURN)


# ---------------------------------------------------------------------------
# The project picker
# ---------------------------------------------------------------------------


@router.get("/crew-projects", response_model=StationCrewProjectsOut)
def station_crew_projects(
    station: Station = Depends(get_current_station),
    db: Session = Depends(get_db),
) -> StationCrewProjectsOut:
    """Each crew member's projects for the rack's picker, best first.

    ``people`` is ``_list_active_assignable_users`` — the very list ``GET
    /crew`` serves, in its order — so the wall never offers projects for a
    name it cannot show. Four fields per project and nothing else: anybody in
    the workshop can read the wall.
    """
    _ = station  # auth enforcement only — every station sees the same crew
    crew = _list_active_assignable_users(db)
    offered = station_projects.crew_projects(db, [row.id for row in crew])
    return StationCrewProjectsOut(
        week_start=offered.week_start,
        people=[
            StationCrewProjectsPersonOut(
                user_id=row.id,
                projects=[
                    StationOfferedProjectOut(
                        id=project.id,
                        project_number=project.project_number,
                        name=project.name,
                        hint=project.hint,  # type: ignore[arg-type]
                    )
                    for project in offered.by_user.get(row.id, [])
                ],
            )
            for row in crew
        ],
    )


# ---------------------------------------------------------------------------
# Booking and taking back
# ---------------------------------------------------------------------------


@router.post("/consumptions", response_model=StationConsumptionOut)
def station_consumption(
    payload: StationConsumptionRequest,
    station: Station = Depends(get_current_station),
    db: Session = Depends(get_db),
) -> StationConsumptionOut:
    """Book a consumable as used up, for a person and maybe a project.

    A short shelf is not refused — the person is holding the parts, so the
    count was wrong; the service books the shortfall first and the answer
    carries ``stock_warning``. A machine type and an archived article are
    refused with the service's own German sentence.
    """
    request_id = _clean_request_id(payload.request_id)
    replay = _replay(db, request_id, article_id=payload.article_id, kinds=(CONSUMPTION,))
    if replay is not None:
        return replay

    article = _article_or_404(db, payload.article_id)
    assignee = _crew_member(db, payload.assignee_user_id)
    project = _bookable_project(db, payload.project_id)
    user_id = resolve_station_user_id(db, station)
    notes = _station_notes(station, _booking_note("Verbrauch", project, payload.notes))

    try:
        result = book_stock_consumption(
            db,
            article=article,
            quantity=payload.quantity,
            user_id=user_id,
            assignee_user_id=assignee.id,
            project_id=project.id if project is not None else None,
            notes=notes,
            station_id=station.id,
            client_request_id=request_id,
        )
        movement_id = result.movement.id
        db.commit()
    except (ConsumptionError, MovementError) as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except IntegrityError as exc:
        # Two attempts with one token raced past the lookup above; the unique
        # column let exactly one of them commit. Undo ours, answer with theirs.
        return _replay_after_race(db, exc, request_id, article_id=payload.article_id, kinds=(CONSUMPTION,))

    db.refresh(article)
    return _answer(
        db,
        movement_id=movement_id,
        booked_as=CONSUMPTION,
        quantity=payload.quantity,
        article=article,
        assignee=assignee,
        project=project,
        stock_warning=result.stock_warning,
        topped_up=result.topped_up,
    )


@router.post("/consumptions/undo", response_model=StationConsumptionOut)
def station_consumption_undo(
    payload: StationConsumptionUndoRequest,
    station: Station = Depends(get_current_station),
    db: Session = Depends(get_db),
) -> StationConsumptionOut:
    """Take consumed pieces back into stock — or close the old loan they came from.

    ``pick_project`` false: ``project_id`` names the bucket exactly (``null``
    = consumed without a project) — the undo of a booking the screen still
    knows. With ``undo_of_movement_id`` naming that booking, its short-shelf
    top-up goes too (``reverse_top_up``). ``pick_project`` true: a Rückgabe
    with no project selected, decided by ``_rueckgabe_target``. Either way
    never more than is still consumed (or lent) there.
    """
    request_id = _clean_request_id(payload.request_id)
    undo_of = payload.undo_of_movement_id if not payload.pick_project else None
    replay = _replay(db, request_id, article_id=payload.article_id, kinds=_UNDO_KINDS, undo_of=undo_of)
    if replay is not None:
        return replay

    article = _article_or_404(db, payload.article_id)
    if bool(article.is_archived):
        raise HTTPException(status_code=400, detail=ARTICLE_ARCHIVED)
    assignee = _crew_member(db, payload.assignee_user_id) if payload.assignee_user_id is not None else None

    project_id = payload.project_id
    if payload.pick_project:
        target = _rueckgabe_target(db, article, assignee, payload.quantity)
        if target.loan is not None:
            return _close_old_loan(db, station, article, target.loan, payload.quantity, request_id)
        project_id = target.project_id
    project = db.get(Project, project_id) if project_id is not None else None
    user_id = resolve_station_user_id(db, station)
    notes = _station_notes(station, _booking_note("Verbrauch zurück", project, None))

    try:
        movement = undo_stock_consumption(
            db,
            article=article,
            quantity=payload.quantity,
            user_id=user_id,
            assignee_user_id=assignee.id if assignee is not None else None,
            project_id=project_id,
            notes=notes,
            station_id=station.id,
            client_request_id=request_id,
        )
        movement_id = movement.id
        reversed_top_up = 0
        if undo_of is not None:
            reversed_top_up = reverse_top_up(
                db,
                article=article,
                consumption_id=undo_of,
                project_id=project_id,
                user_id=user_id,
                notes=_station_notes(station, TOP_UP_REVERSED_NOTE),
                station_id=station.id,
            )
        db.commit()
    except (ConsumptionError, MovementError) as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except IntegrityError as exc:
        return _replay_after_race(db, exc, request_id, article_id=payload.article_id, kinds=_UNDO_KINDS, undo_of=undo_of)

    db.refresh(article)
    return _answer(
        db,
        movement_id=movement_id,
        booked_as=CONSUMPTION_UNDO,
        quantity=payload.quantity,
        article=article,
        assignee=assignee,
        project=project,
        reversed_top_up=reversed_top_up,
    )


# ---------------------------------------------------------------------------
# A Rückgabe with no project selected
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class _RueckgabeTarget:
    """An old loan to close, or else the consumption bucket to take back from."""

    loan: OpenLoan | None = None
    project_id: int | None = None


def _rueckgabe_target(
    db: Session, article: WerkstattArticle, assignee: User | None, quantity: int
) -> _RueckgabeTarget:
    """Where pieces carried back to the rack go, when no project was picked.

    Consumables were LENT before 2026-10-10 (every Ausgabe was a
    ``checkout``), and nothing converted those loans. Taking such pieces out
    of a consumption bucket would raise the stock by pieces that are not
    there, leave the loan open forever and shrink somebody's project. So, in
    this order:

    1. the named person's own consumption, most recent bucket first —
       leftovers of what they consumed themselves. Own means their net there
       (an ABBRUCH under their name cancels it), and the bucket must hold
       the whole quantity of it: pieces beyond their own are not leftovers
       of it, and taking them would shrink a colleague's project;
    2. the named person's own open loan of the article (the row "Meine
       Entnahmen" shows them);
    3. with nobody named, the loan a nameless Rückgabe at ``/movements``
       closes — the station's inference (``open_loan_for_article``);
    4. anybody's consumption, most recent bucket first;
    5. nothing → 400.

    A loan is bounded by its balance and by ``stock_out`` (what
    ``apply_movement`` lets a return close); more than that is refused, not
    split — the screen asks for the right quantity.
    """
    if assignee is not None:
        own = own_open_buckets(db, article_id=article.id, assignee_user_id=assignee.id, quantity=quantity)
        if own:
            return _RueckgabeTarget(project_id=own[0])
        loan = open_loan_of_person(db, article.id, assignee.id)
    else:
        loan = open_loan_for_article(db, article.id)

    lent = min(loan.quantity, int(article.stock_out or 0)) if loan is not None else 0
    if loan is not None and lent > 0:
        if quantity > lent:
            raise HTTPException(status_code=400, detail=f"Nur {lent} ausgeliehen – bitte die Menge anpassen.")
        return _RueckgabeTarget(loan=loan)

    buckets = open_buckets(db, article_id=article.id, assignee_user_id=assignee.id if assignee else None)
    if not buckets:
        raise HTTPException(status_code=400, detail=NOTHING_TO_TAKE_BACK)
    return _RueckgabeTarget(project_id=buckets[0])


def _close_old_loan(
    db: Session,
    station: Station,
    article: WerkstattArticle,
    loan: OpenLoan,
    quantity: int,
    request_id: str | None,
) -> StationConsumptionOut:
    """Book the Rückgabe as the ``return`` of that loan: its borrower, its
    project, the station's marker and the request's token."""
    article_id = article.id
    borrower = db.get(User, loan.borrower_id)
    project = db.get(Project, loan.project_id) if loan.project_id is not None else None
    user_id = resolve_station_user_id(db, station)
    try:
        movement = apply_movement(
            db,
            article=article,
            movement_type=RETURN,
            quantity=quantity,
            user_id=user_id,
            assignee_user_id=loan.borrower_id,
            project_id=loan.project_id,
            notes=_station_notes(station, _booking_note("Rückgabe", project, None)),
        )
        movement.station_id = station.id
        movement.client_request_id = request_id
        movement_id = movement.id
        db.commit()
    except MovementError as exc:
        detail = loan_refusal(RETURN, quantity, article)
        db.rollback()
        raise HTTPException(status_code=400, detail=detail) from exc
    except IntegrityError as exc:
        return _replay_after_race(db, exc, request_id, article_id=article_id, kinds=_UNDO_KINDS)

    db.refresh(article)
    return _answer(
        db,
        movement_id=movement_id,
        booked_as=RETURN,
        quantity=quantity,
        article=article,
        assignee=borrower,
        project=project,
    )


# ---------------------------------------------------------------------------
# Gates
# ---------------------------------------------------------------------------


def _article_or_404(db: Session, article_id: int) -> WerkstattArticle:
    # Locked until the commit: two stations (or a station and a phone) must
    # not both read the same shelf count and both book against it.
    article = load_article_for_update(db, article_id)
    if article is None:
        raise HTTPException(status_code=404, detail=ARTICLE_NOT_FOUND)
    return article


def _crew_member(db: Session, user_id: int) -> User:
    """The person, if the crew list offers them — else one sentence for
    unknown, inactive and partner logins alike."""
    if user_id not in {row.id for row in _list_active_assignable_users(db)}:
        raise HTTPException(status_code=400, detail=PERSON_UNKNOWN)
    person = db.get(User, user_id)
    if person is None:  # pragma: no cover — the crew list just named them
        raise HTTPException(status_code=400, detail=PERSON_UNKNOWN)
    return person


def _bookable_project(db: Session, project_id: int | None) -> Project | None:
    try:
        return require_bookable_project(db, project_id)
    except ConsumptionError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def _booking_note(action: str, project: Project | None, caller_note: str | None) -> str:
    """What follows the station marker: "Verbrauch für 381 — <caller's text>"."""
    text = f"{action} für {project.project_number}" if project is not None else action
    extra = (caller_note or "").strip()
    return f"{text} — {extra}" if extra else text


# ---------------------------------------------------------------------------
# Retries
# ---------------------------------------------------------------------------


def _clean_request_id(request_id: str | None) -> str | None:
    return (request_id or "").strip() or None


def _movement_for_request(db: Session, request_id: str) -> WerkstattMovement | None:
    return db.scalar(select(WerkstattMovement).where(WerkstattMovement.client_request_id == request_id))


def _replay(
    db: Session,
    request_id: str | None,
    *,
    article_id: int,
    kinds: tuple[str, ...],
    undo_of: int | None = None,
) -> StationConsumptionOut | None:
    """The booking this exact attempt already made, if it made one.

    Read from the ledger row the first attempt wrote, not from a cache. The
    shortfall top-up is not repeated in the answer: this attempt booked
    nothing, and the first one's answer already said so. A top-up the first
    attempt of an undo took back IS repeated (``undo_of``): that answer may
    be the one the screen never received, and the flash says what changed.
    """
    if request_id is None:
        return None
    movement = _movement_for_request(db, request_id)
    if movement is None:
        return None
    if movement.movement_type not in kinds or movement.article_id != article_id:
        raise HTTPException(status_code=409, detail=REQUEST_ID_TAKEN)
    article = db.get(WerkstattArticle, movement.article_id)
    if article is None:  # pragma: no cover — ON DELETE RESTRICT keeps it
        raise HTTPException(status_code=404, detail=ARTICLE_NOT_FOUND)
    reversed_top_up = 0
    if undo_of is not None and movement.movement_type == CONSUMPTION_UNDO:
        reversed_top_up = top_up_reversed_by(db, undo=movement, consumption_id=undo_of)
    return _answer(
        db,
        movement_id=movement.id,
        booked_as=movement.movement_type,
        quantity=int(movement.quantity),
        article=article,
        assignee=db.get(User, movement.assignee_user_id) if movement.assignee_user_id is not None else None,
        project=db.get(Project, movement.project_id) if movement.project_id is not None else None,
        reversed_top_up=reversed_top_up,
        replayed=True,
    )


def _replay_after_race(
    db: Session,
    exc: IntegrityError,
    request_id: str | None,
    *,
    article_id: int,
    kinds: tuple[str, ...],
    undo_of: int | None = None,
) -> StationConsumptionOut:
    db.rollback()
    replay = _replay(db, request_id, article_id=article_id, kinds=kinds, undo_of=undo_of)
    if replay is None:
        # Not our token after all — some other constraint. Not ours to hide.
        raise exc
    return replay


# ---------------------------------------------------------------------------
# The answer
# ---------------------------------------------------------------------------


def _answer(
    db: Session,
    *,
    movement_id: int,
    booked_as: str,
    quantity: int,
    article: WerkstattArticle,
    assignee: User | None,
    project: Project | None,
    stock_warning: str | None = None,
    topped_up: int = 0,
    reversed_top_up: int = 0,
    replayed: bool = False,
) -> StationConsumptionOut:
    return StationConsumptionOut(
        movement_id=movement_id,
        booked_as=booked_as,  # type: ignore[arg-type]
        quantity=quantity,
        article=_article_out(db, article),
        assignee=(
            StationConsumptionPersonOut(id=assignee.id, display_name=assignee.display_name)
            if assignee is not None
            else None
        ),
        project=(
            StationConsumptionProjectOut(id=project.id, project_number=project.project_number, name=project.name)
            if project is not None
            else None
        ),
        stock_warning=stock_warning,
        topped_up=topped_up,
        reversed_top_up=reversed_top_up,
        replayed=replayed,
    )
