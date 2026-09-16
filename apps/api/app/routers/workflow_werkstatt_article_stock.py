"""Werkstatt — manual stock adjustment for a single article.

One endpoint:

- POST /werkstatt/articles/{article_id}/movements   (mounted under /api)

This is the backend for the desktop "Bestand anpassen" dialog on the
Werkstatt › Bestand page. It is deliberately NOT in
``workflow_werkstatt_articles.py``: that file is already ~730 lines, and the
aggregator (``workflow_werkstatt_desktop.py``) sets the convention of one
sub-file per concern precisely so no single router grows unreadable. Stock
mutation is a different concern from article CRUD anyway — CRUD edits the row,
this edits the ledger, and only one of the two may ever touch a stock counter.

Which is the rule that matters here: ``werkstatt_movements`` is the source of
truth and ``stock_total``/``available``/``out``/``repair`` are snapshots
rebuilt from it after every movement. Nothing in this module assigns a counter
a value of its own; everything goes through ``apply_movement``, and the one
other place a counter changes — the reconcile in ``_load_adjustable_article``
— derives all four from the ledger by the same canonical recompute.

The corollary is easy to miss and is the reason that reconcile exists: reading
a snapshot to *decide* a write is the same mistake as assigning one. Every
guard below judges against the ledger-derived figure, never against whatever
the row happened to be storing.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.deps import get_current_user, require_permission
from app.models.entities import (
    User,
    WerkstattArticle,
    WerkstattCategory,
    WerkstattLocation,
)
from app.routers.workflow_werkstatt_article_mappers import article_lite_out
from app.schemas.werkstatt import (
    WerkstattArticleLiteOut,
    WerkstattStockAdjustPayload,
)
from app.services.werkstatt_movements import (
    MovementError,
    apply_movement,
    load_article_for_update,
    recompute_article_stock,
)

router = APIRouter(prefix="", tags=["werkstatt-desktop"])


# Upper bound on anything that reaches ``db.flush()``. The point is not
# plausibility — it is that an integer wider than the INTEGER column must never
# be handed to SQLite/Postgres. Matches ``InventoryImportRow.counted_qty``.
MAX_ADJUST_QUANTITY = 1_000_000

MAX_REASON_LENGTH = 500

# kind → the German label written into the ledger note. `defect` and
# `inventory` both book `inventory_minus`, so without this prefix the ledger
# could not tell shrinkage apart from a stock-take afterwards.
_KIND_LABELS: dict[str, str] = {
    "intake": "Wareneingang",
    "defect": "Schwund / Defekt",
    "inventory": "Inventur-Korrektur",
}

# kind → movement_type, for the two *relative* kinds.
_RELATIVE_MOVEMENTS: dict[str, str] = {
    "intake": "intake",
    "defect": "inventory_minus",
}


# ──────────────────────────────────────────────────────────────────────────
# Permission
# ──────────────────────────────────────────────────────────────────────────


# The shared check, reused rather than reimplemented: exactly the permission
# the neighbouring article writes require.
_HAS_WERKSTATT_MANAGE = require_permission("werkstatt:manage")


def require_werkstatt_manage(current_user: User = Depends(get_current_user)) -> User:
    """``werkstatt:manage``, refused in the language the rest of this endpoint
    speaks.

    ``require_permission`` answers with the English literal "Permission
    denied", which is right for the ~150 endpoints that use it and wrong here:
    every other refusal this dialog can provoke — archived article, missing
    reason, shelf too small, stale total — is German prose the workshop reads
    in the error toast. The shared dependency is NOT changed: its message is
    part of the API surface of every other endpoint that uses it, most of
    which are English throughout, so translating it centrally would put German
    prose in front of the wrong callers. The translation stays local. Only the
    403 is rewritten — an expired token still surfaces as itself.
    """

    try:
        return _HAS_WERKSTATT_MANAGE(current_user)
    except HTTPException as exc:
        if exc.status_code != status.HTTP_403_FORBIDDEN:
            raise
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Keine Berechtigung, den Bestand zu ändern",
        ) from exc


# ──────────────────────────────────────────────────────────────────────────
# Validation helpers
# ──────────────────────────────────────────────────────────────────────────


def _load_adjustable_article(db: Session, article_id: int) -> WerkstattArticle:
    """Load the article with its row locked, and its snapshot reconciled with
    the ledger, for the rest of this request.

    Everything below this line — the ``expected_total`` check, the shelf-cover
    guard, the delta the absolute case derives from ``stock_total`` — reads
    counters that a second tablet may be changing right now, and then writes
    based on what it read. The lock is what makes those reads worth anything;
    see ``load_article_for_update``. It is a no-op on SQLite, so the test suite
    exercises the guards but never the serialisation.

    The lock alone is not enough, though, because the counters it protects are
    *snapshots*: ``apply_movement`` ends by rewriting all four from the ledger,
    so every guard that judged against the stored number was judging against
    something the write is about to overrule. While the two agree that is
    invisible; when they ever diverge it is precisely backwards — a stock-take
    computed as ``target − stale_total`` lands on ``target ± drift`` and
    compounds the discrepancy, when a stock-take is exactly the operation that
    should end it. So the snapshot is brought into agreement with the ledger
    first, by the same canonical recompute the write path uses, and every
    decision downstream reads ledger truth. Inside the lock that is race-free:
    the recompute and the movement it informs are one serialised unit.

    The recompute clamps each counter at zero, so an article whose ledger is
    already *negative* (a hole from before ``apply_movement`` refused
    over-booking) still cannot be counted straight in one step — healing that
    means repairing the ledger, which is not this endpoint's job. What this
    does fix is the drift that is merely stale.
    """
    article = load_article_for_update(db, int(article_id))
    if article is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Artikel nicht gefunden")
    if bool(article.is_archived):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Artikel ist archiviert — keine Bestandsbuchung möglich",
        )
    recompute_article_stock(db, article)
    return article


def _clean_reason(raw: str | None) -> str:
    reason = (raw or "").strip()
    if not reason:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Begründung / Beleg ist erforderlich",
        )
    if len(reason) > MAX_REASON_LENGTH:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Begründung / Beleg darf höchstens {MAX_REASON_LENGTH} Zeichen lang sein",
        )
    return reason


def _checked_quantity(raw: int | None) -> int:
    if raw is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Menge ist erforderlich",
        )
    quantity = int(raw)
    if quantity <= 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Menge muss größer als 0 sein",
        )
    if quantity > MAX_ADJUST_QUANTITY:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Menge darf höchstens {MAX_ADJUST_QUANTITY} betragen",
        )
    return quantity


def _checked_target_total(raw: int | None) -> int:
    if raw is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Zielbestand ist erforderlich",
        )
    target = int(raw)
    if target < 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Zielbestand darf nicht negativ sein",
        )
    if target > MAX_ADJUST_QUANTITY:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Zielbestand darf höchstens {MAX_ADJUST_QUANTITY} betragen",
        )
    return target


def _assert_optimistic_total(article: WerkstattArticle, expected_total: int | None) -> None:
    """Refuse the booking when the article moved since the dialog opened.

    Opt-in, matching the pattern used for tasks and projects
    (``workflow_helpers._assert_optimistic_timestamp``): a client that does not
    send ``expected_total`` gets the old last-write-wins behaviour.

    ``article.stock_total`` here is the reconciled figure
    (``_load_adjustable_article`` recomputed it from the ledger), so what the
    409 names as "aktuell" is the number the booking would actually be measured
    against — not a snapshot that the write is about to replace with a third
    number.
    """
    if expected_total is None:
        return
    current = int(article.stock_total or 0)
    if int(expected_total) == current:
        return
    raise HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail=(
            f"Der Bestand hat sich inzwischen geändert: angezeigt waren "
            f"{int(expected_total)} Stk, aktuell sind es {current} Stk. "
            # Deliberately says nothing about reopening the dialog: whether the
            # client can refresh in place is the client's business, and the web
            # one does exactly that. Asserting otherwise here produced a toast
            # that told the user two opposite things at once.
            "Bitte die Buchung gegen die aktuellen Zahlen prüfen."
        ),
    )


def _assert_shelf_covers(article: WerkstattArticle, quantity: int) -> None:
    """Refuse an outgoing stock-take booking that the shelf cannot cover.

    ``inventory_minus`` decrements ``total`` and ``available`` together, so
    ``stock_available`` is the binding limit — items that are checked out or
    away for repair are not on the shelf and cannot be written off from here.
    ``apply_movement`` enforces the same rule; this pre-check exists only so
    the workshop reads German prose instead of the service's English detail.
    Both read the reconciled counters, so the two cannot disagree about whether
    a booking fits — and the quantities this message quotes are the ledger's.
    """
    available = int(article.stock_available or 0)
    if quantity <= available:
        return
    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail=(
            f"Abgang von {quantity} Stk nicht möglich: nur {available} Stk sind auf Lager. "
            f"Ausgegeben ({int(article.stock_out or 0)} Stk) und in Reparatur "
            f"({int(article.stock_repair or 0)} Stk) zählen nicht zum Lagerbestand "
            "und können hier nicht abgebucht werden."
        ),
    )


def _plan_movement(
    payload: WerkstattStockAdjustPayload,
    article: WerkstattArticle,
) -> tuple[str, int, str] | None:
    """Resolve the payload into ``(movement_type, quantity, note_suffix)``.

    Returns ``None`` for the legitimate no-op: an ``inventory`` count that
    agrees with the ledger. Writing a zero-quantity ledger row for it would
    be rejected by ``apply_movement`` anyway, and a row that moves nothing is
    noise in an audit trail.

    The delta is ``target − <ledger-derived total>``: ``article.stock_total``
    was reconciled with the ledger under the lock in
    ``_load_adjustable_article``, and ``apply_movement`` rebuilds it from that
    same ledger afterwards. Subtracting the one the write will honour is what
    makes the result land on the counted figure exactly.
    """
    if payload.kind in _RELATIVE_MOVEMENTS:
        return _RELATIVE_MOVEMENTS[payload.kind], _checked_quantity(payload.quantity), ""

    target = _checked_target_total(payload.target_total)
    delta = target - int(article.stock_total or 0)
    if delta == 0:
        return None
    movement_type = "inventory_plus" if delta > 0 else "inventory_minus"
    return movement_type, abs(delta), f" (Ziel {target} Stk)"


def _lite_row(db: Session, article: WerkstattArticle) -> WerkstattArticleLiteOut:
    """Project the article into exactly the row shape ``GET /articles`` returns,
    so the FE can swap one row in place instead of refetching the list."""
    category = db.get(WerkstattCategory, article.category_id) if article.category_id else None
    location = db.get(WerkstattLocation, article.location_id) if article.location_id else None
    return article_lite_out(
        article,
        category_name=category.name if category else None,
        location_name=location.name if location else None,
    )


# ──────────────────────────────────────────────────────────────────────────
# POST /articles/{article_id}/movements
# ──────────────────────────────────────────────────────────────────────────


@router.post("/articles/{article_id}/movements", response_model=WerkstattArticleLiteOut)
def adjust_article_stock(
    article_id: int,
    payload: WerkstattStockAdjustPayload,
    current_user: User = Depends(require_werkstatt_manage),
    db: Session = Depends(get_db),
) -> WerkstattArticleLiteOut:
    """Book a manual stock adjustment and return the refreshed article row.

    Kind → ledger movement:

      ``intake``    Wareneingang       → ``intake``           (+total, +available)
      ``defect``    Schwund / Defekt   → ``inventory_minus``  (−total, −available)
      ``inventory`` Inventur-Korrektur → ``inventory_plus`` / ``inventory_minus``

    ``correction`` is never booked here. It decrements ``stock_out`` as well,
    which is correct only for "a checked-out item is confirmed lost" — a
    delivery and a shelf count can both see nothing but the shelf.

    **The absolute case sends the TARGET, not a signed delta.** The client
    posts ``target_total``: the number the person actually counted. The server
    subtracts the article's current total itself — the one derived from the
    ledger under the row lock, which is also the one ``apply_movement`` will
    rebuild the snapshot from. A pre-computed delta would be derived from
    whatever the dialog happened to display, so a checkout booked while the
    dialog was open would compound with it and land the article on a total
    nobody counted; a target is a statement about the physical world, and
    re-deriving the delta against ledger truth means the result is the counted
    number whatever any snapshot did in the meantime.

    That leaves the case where the article really did move since the dialog
    opened — where "the count is now stale" and "the count is now authoritative"
    are indistinguishable from here, and only the person holding the shelf can
    tell them apart. So it is surfaced rather than guessed: send the displayed
    ``expected_total`` and a mismatch answers **409** with both numbers, for
    the client to re-open and confirm. Omitting ``expected_total`` opts out and
    applies the count against current state.

    A count that matches the ledger writes nothing and returns the row
    unchanged (200).
    """

    article = _load_adjustable_article(db, article_id)
    reason = _clean_reason(payload.reason)
    _assert_optimistic_total(article, payload.expected_total)

    planned = _plan_movement(payload, article)
    if planned is None:
        # No ledger row — but the load may have reconciled the snapshot, and
        # ``get_db`` closes the session without committing, so returning here
        # would answer with counters the database does not hold. Commit, so
        # the row the client swaps in is the row anyone else would read.
        db.commit()
        db.refresh(article)
        return _lite_row(db, article)

    movement_type, quantity, note_suffix = planned
    if movement_type == "inventory_minus":
        _assert_shelf_covers(article, quantity)

    try:
        apply_movement(
            db,
            article=article,
            movement_type=movement_type,
            quantity=quantity,
            # The actor, the way every other call site records it: whoever is
            # logged in and pressed the button.
            user_id=current_user.id,
            notes=f"{_KIND_LABELS[payload.kind]}{note_suffix}: {reason}",
        )
    except MovementError as exc:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Buchung nicht möglich: {exc}",
        ) from exc

    db.commit()
    db.refresh(article)
    return _lite_row(db, article)
