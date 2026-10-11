"""Consumables leaving the shelf for good — the one rule the Regal station,
the desk and the phone share (owner, 2026-10-10: "any item that is not inside
the machine tab is a consumable, when we scan it we book it out of the
inventory and it is installed at a work site").

* A consumable is an article with ``is_serialized`` False — everything the
  Maschinen tab does not list. A machine type is lent (``checkout`` /
  ``return``), never consumed; its stock is its units.
* ``book_stock_consumption`` writes a ``consumption`` row with the person who
  took it and, when known, the project it went into. A short shelf is not
  refused: the person is holding the part, so the COUNT was wrong. The
  shortfall is booked first as ``inventory_plus`` with a note, so the ledger
  never goes negative — a negative ledger swallows the next delivery (see
  ``werkstatt_movements.apply_movement``) — and the answer says what happened.
* ``undo_stock_consumption`` takes pieces back (an undo at the wall, or
  leftovers carried back from the site) as ``consumption_undo``, bounded by
  what is still net consumed in that (article, project) bucket. Rows of a
  Verteiler (``panel_id``) or a machine unit (``unit_id``) are other buckets
  and never touched here; the board's own undo owns those.
* A top-up booked with a request id carries that id plus ``+t``, so the
  undo of exactly that consumption (ABBRUCH after a wrong quantity) can find
  it and take it back once — ``reverse_top_up``, whose row carries ``+u``.
  Leftovers carried back are not a correction and never reverse anything.

Callers commit; everything here only flushes.
"""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import case, false, func, select
from sqlalchemy.orm import Session

from app.models.entities import Project, WerkstattArticle, WerkstattMovement
from app.services.werkstatt_movements import apply_movement

CONSUMPTION = "consumption"
CONSUMPTION_UNDO = "consumption_undo"
TOP_UP = "inventory_plus"
TOP_UP_REVERSAL = "inventory_minus"

# ``werkstatt_movements.client_request_id`` is String(64) and unique: a
# consumption's top-up carries the booking's token plus ``+t`` and the one
# reversal of that top-up the token plus ``+u`` — the unique column is what
# makes "once" hold. A token too long for the suffix simply gets no link.
_REQUEST_ID_MAX = 64
TOP_UP_SUFFIX = "+t"
TOP_UP_REVERSAL_SUFFIX = "+u"

MACHINE_NOT_CONSUMABLE = "Maschinen werden ausgeliehen, nicht verbraucht – bitte als Ausgabe (Leihe) buchen."
ARTICLE_ARCHIVED = "Artikel ist archiviert."
# One sentence for an unknown and a closed project: a station must not learn
# from the answer which project ids exist.
PROJECT_NOT_BOOKABLE = "Projekt nicht verfügbar."


class ConsumptionError(ValueError):
    """A booking the rule refuses. The message is German and safe to show."""


@dataclass(frozen=True)
class ConsumptionResult:
    movement: WerkstattMovement
    # Pieces booked as ``inventory_plus`` first because the shelf count was
    # short; 0 when it was not.
    topped_up: int
    stock_warning: str | None


def is_consumable(article: WerkstattArticle) -> bool:
    return not bool(article.is_serialized)


def _is_closed(project: Project) -> bool:
    # Mirrors routers.workflow_helpers._is_project_archived — kept here so a
    # service does not import a router module.
    status = (project.status or "").strip().lower()
    return bool(status) and (status in {"archived", "archiviert"} or "archiv" in status)


def require_bookable_project(db: Session, project_id: int | None) -> Project | None:
    """The project a consumption may name: ``None`` (no project) or one that
    exists and is not archived."""
    if project_id is None:
        return None
    project = db.get(Project, project_id)
    if project is None or _is_closed(project):
        raise ConsumptionError(PROJECT_NOT_BOOKABLE)
    return project


def _bucket(article_id: int, project_id: int | None) -> list:
    conditions = [
        WerkstattMovement.article_id == article_id,
        WerkstattMovement.panel_id.is_(None),
        WerkstattMovement.unit_id.is_(None),
        WerkstattMovement.movement_type.in_((CONSUMPTION, CONSUMPTION_UNDO)),
    ]
    if project_id is None:
        conditions.append(WerkstattMovement.project_id.is_(None))
    else:
        conditions.append(WerkstattMovement.project_id == project_id)
    return conditions


_SIGNED = case((WerkstattMovement.movement_type == CONSUMPTION, WerkstattMovement.quantity), else_=-WerkstattMovement.quantity)


def net_consumed(db: Session, *, article_id: int, project_id: int | None) -> int:
    """Pieces of this article still consumed for this project (``None`` = without one)."""
    total = db.scalar(select(func.coalesce(func.sum(_SIGNED), 0)).where(*_bucket(article_id, project_id)))
    return max(int(total or 0), 0)


def open_buckets(db: Session, *, article_id: int, assignee_user_id: int | None = None) -> list[int | None]:
    """Projects (``None`` = without one) this article can still be taken back
    from, the most recently consumed first — and the given person's own
    consumption (``own_open_buckets``) before anybody else's, so leftovers go
    back where that person took them."""
    return [row.project_id for row in _open_bucket_rows(db, article_id, assignee_user_id)]


def own_open_buckets(
    db: Session, *, article_id: int, assignee_user_id: int, quantity: int = 1
) -> list[int | None]:
    """The buckets still holding at least ``quantity`` of this person's OWN
    consumption, most recent first — leftovers that can only be theirs.

    Own is what they consumed there minus what was taken back under their
    name (an ABBRUCH carries the person), never more than the bucket still
    holds: "booked into that project once" is not enough. A consumption they
    cancelled leaves nothing, and a colleague's pieces in the same project
    are not theirs to give back — taking them would shrink that project and
    leave the person's real source (an old loan) open.
    """
    return [
        row.project_id
        for row in _open_bucket_rows(db, article_id, assignee_user_id)
        if min(row.own_net, row.net) >= quantity
    ]


@dataclass(frozen=True)
class _OpenBucket:
    project_id: int | None
    # Still consumed there, by anybody.
    net: int
    # Of that, the person's own (consumed minus taken back under their name);
    # 0 with no person.
    own_net: int
    last_id: int
    own_last_id: int | None


def _open_bucket_rows(db: Session, article_id: int, assignee_user_id: int | None) -> list[_OpenBucket]:
    # ``assignee_user_id == None`` would compile to IS NULL and make every
    # nameless row "own"; with nobody named, nothing is.
    mine = WerkstattMovement.assignee_user_id == assignee_user_id if assignee_user_id is not None else false()
    rows = db.execute(
        select(
            WerkstattMovement.project_id,
            func.sum(_SIGNED).label("net"),
            func.sum(case((mine, _SIGNED), else_=0)).label("own_net"),
            func.max(
                case((WerkstattMovement.movement_type == CONSUMPTION, WerkstattMovement.id), else_=None)
            ).label("last_id"),
            func.max(
                case(
                    ((WerkstattMovement.movement_type == CONSUMPTION) & mine, WerkstattMovement.id),
                    else_=None,
                )
            ).label("own_last_id"),
        )
        .where(
            WerkstattMovement.article_id == article_id,
            WerkstattMovement.panel_id.is_(None),
            WerkstattMovement.unit_id.is_(None),
            WerkstattMovement.movement_type.in_((CONSUMPTION, CONSUMPTION_UNDO)),
        )
        .group_by(WerkstattMovement.project_id)
    ).all()
    buckets = [
        _OpenBucket(
            project_id=row.project_id,
            net=int(row.net or 0),
            own_net=max(int(row.own_net or 0), 0),
            last_id=int(row.last_id or 0),
            own_last_id=row.own_last_id,
        )
        for row in rows
    ]
    open_rows = [bucket for bucket in buckets if bucket.net > 0]
    # The person's own first (by their latest consumption there), then the
    # rest by the latest consumption of anybody.
    open_rows.sort(
        key=lambda bucket: (
            (False, -(bucket.own_last_id or 0)) if bucket.own_net > 0 else (True, -bucket.last_id)
        )
    )
    return open_rows


def book_stock_consumption(
    db: Session,
    *,
    article: WerkstattArticle,
    quantity: int,
    user_id: int,
    assignee_user_id: int | None,
    project_id: int | None,
    notes: str | None,
    station_id: int | None = None,
    client_request_id: str | None = None,
) -> ConsumptionResult:
    """Book ``quantity`` of a consumable as used up. The caller has validated
    the person and the project (``require_bookable_project``) and loaded the
    article with ``load_article_for_update``."""
    if quantity <= 0:
        raise ConsumptionError("Die Menge muss mindestens 1 sein.")
    if not is_consumable(article):
        raise ConsumptionError(MACHINE_NOT_CONSUMABLE)
    if bool(article.is_archived):
        raise ConsumptionError(ARTICLE_ARCHIVED)

    available = max(int(article.stock_available or 0), 0)
    shortfall = max(quantity - available, 0)
    warning = None
    if shortfall:
        top_up = apply_movement(
            db,
            article=article,
            movement_type=TOP_UP,
            quantity=shortfall,
            user_id=user_id,
            notes=_join("Bestand bei Entnahme ergänzt", notes),
        )
        top_up.station_id = station_id
        top_up.client_request_id = _linked_request_id(client_request_id, TOP_UP_SUFFIX)
        warning = (
            f"Laut Bestand waren nur {available} da – {shortfall} nachgebucht, "
            "bitte den Bestand bei Gelegenheit zählen."
        )
    movement = apply_movement(
        db,
        article=article,
        movement_type=CONSUMPTION,
        quantity=quantity,
        user_id=user_id,
        assignee_user_id=assignee_user_id,
        project_id=project_id,
        notes=notes,
    )
    movement.station_id = station_id
    movement.client_request_id = client_request_id or None
    db.flush()
    return ConsumptionResult(movement=movement, topped_up=shortfall, stock_warning=warning)


def undo_stock_consumption(
    db: Session,
    *,
    article: WerkstattArticle,
    quantity: int,
    user_id: int,
    assignee_user_id: int | None,
    project_id: int | None,
    notes: str | None,
    station_id: int | None = None,
    client_request_id: str | None = None,
) -> WerkstattMovement:
    """Take ``quantity`` back into stock from the (article, project) bucket —
    never more than is still net consumed there."""
    if quantity <= 0:
        raise ConsumptionError("Die Menge muss mindestens 1 sein.")
    net = net_consumed(db, article_id=article.id, project_id=project_id)
    if quantity > net:
        where = "ohne Projekt" if project_id is None else "für dieses Projekt"
        raise ConsumptionError(
            f"Zurücknehmen geht nur für Verbrauchtes: {where} sind noch {net} verbucht."
        )
    movement = apply_movement(
        db,
        article=article,
        movement_type=CONSUMPTION_UNDO,
        quantity=quantity,
        user_id=user_id,
        assignee_user_id=assignee_user_id,
        project_id=project_id,
        notes=notes,
    )
    movement.station_id = station_id
    movement.client_request_id = client_request_id or None
    db.flush()
    return movement


def reverse_top_up(
    db: Session,
    *,
    article: WerkstattArticle,
    consumption_id: int,
    project_id: int | None,
    user_id: int,
    notes: str | None,
    station_id: int,
) -> int:
    """Take back the top-up a consumption booked for a short shelf, as part of
    the undo of exactly that consumption. Returns the pieces reversed (0 when
    there is nothing to reverse).

    Only a consumption of this station, of this article and in the bucket
    being undone counts, and only its linked top-up (``+t``): anything else
    is not the booking the wall is cancelling. Never more than the shelf
    holds after the undo (``inventory_minus`` may not go below zero), and
    once — the ``+u`` row is unique, so a second undo of the same consumption
    reverses nothing more. Call it after ``undo_stock_consumption``, in the
    same transaction.
    """
    consumption = db.get(WerkstattMovement, consumption_id)
    if (
        consumption is None
        or consumption.movement_type != CONSUMPTION
        or consumption.article_id != article.id
        or consumption.station_id is None
        or consumption.station_id != station_id
        or consumption.project_id != project_id
        or consumption.panel_id is not None
        or consumption.unit_id is not None
    ):
        return 0
    top_up = _movement_for_token(db, _linked_request_id(consumption.client_request_id, TOP_UP_SUFFIX))
    reversal_token = _linked_request_id(consumption.client_request_id, TOP_UP_REVERSAL_SUFFIX)
    if top_up is None or top_up.movement_type != TOP_UP or top_up.article_id != article.id:
        return 0
    if reversal_token is None or _movement_for_token(db, reversal_token) is not None:
        return 0
    quantity = min(int(top_up.quantity), max(int(article.stock_available or 0), 0))
    if quantity <= 0:
        return 0
    reversal = apply_movement(
        db,
        article=article,
        movement_type=TOP_UP_REVERSAL,
        quantity=quantity,
        user_id=user_id,
        notes=notes,
    )
    reversal.station_id = station_id
    reversal.client_request_id = reversal_token
    db.flush()
    return quantity


def top_up_reversed_by(db: Session, *, undo: WerkstattMovement, consumption_id: int) -> int:
    """What ``reverse_top_up`` reversed in the transaction that booked
    ``undo`` — for a replayed answer. The reversal is the very next row of the
    article after that undo (the article is locked for the whole booking);
    an undo booked after it reversed nothing."""
    consumption = db.get(WerkstattMovement, consumption_id)
    if consumption is None or consumption.article_id != undo.article_id:
        return 0
    reversal = _movement_for_token(db, _linked_request_id(consumption.client_request_id, TOP_UP_REVERSAL_SUFFIX))
    if reversal is None or reversal.article_id != undo.article_id or reversal.id <= undo.id:
        return 0
    between = db.scalar(
        select(func.count())
        .select_from(WerkstattMovement)
        .where(
            WerkstattMovement.article_id == undo.article_id,
            WerkstattMovement.id > undo.id,
            WerkstattMovement.id < reversal.id,
        )
    )
    return int(reversal.quantity) if not between else 0


def _linked_request_id(client_request_id: str | None, suffix: str) -> str | None:
    if not client_request_id:
        return None
    linked = f"{client_request_id}{suffix}"
    return linked if len(linked) <= _REQUEST_ID_MAX else None


def _movement_for_token(db: Session, token: str | None) -> WerkstattMovement | None:
    if token is None:
        return None
    return db.scalar(select(WerkstattMovement).where(WerkstattMovement.client_request_id == token))


def _join(head: str, tail: str | None) -> str:
    tail = (tail or "").strip()
    return f"{head} — {tail}" if tail else head
