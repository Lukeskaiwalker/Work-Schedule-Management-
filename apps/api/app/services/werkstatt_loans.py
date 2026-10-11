"""Open loans in the Werkstatt ledger — who is still holding what — and the
German sentence for a loan booking the ledger refuses.

A loan is a ``checkout``; a ``return`` / ``repair_out`` / ``correction``
gives some of it back. The ledger never links a return to the checkout it
closes, so "open" is a balance: per borrower and project, exactly the signed
sum ``werkstatt_movements.list_my_checkouts`` ("Meine Entnahmen" on the
phone) draws. The two have to agree, or the rack closes a loan that list
still shows.

Only the rack uses these. Every other caller has a logged-in person, for whom
a missing assignee means "the caller means themselves"; a wall screen has no
session, so a bare Rückgabe there names nobody and the ledger is the only
place to read whose loan just came back:

* ``open_loan_for_article`` — the loan a NAMELESS Rückgabe must have closed
  (``POST /station/werkstatt/movements`` and, for a consumable lent before
  2026-10-10, ``/consumptions/undo``);
* ``open_loan_of_person`` — the tapped person's own loan of the article
  (``/consumptions/undo`` again: leftovers of an old consumable loan close
  that loan instead of being taken out of somebody's consumption);
* ``loan_refusal`` — what the wall says when the ledger refuses a checkout or
  a return (``apply_movement``'s own text is English, for logs).
"""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import case, func, select
from sqlalchemy.orm import Session

from app.models.entities import User, WerkstattArticle, WerkstattMovement

# Movement types that give something back, i.e. that reduce what a borrower is
# still holding. Spelled exactly as ``list_my_checkouts`` spells them.
LOAN_CLOSING_TYPES: tuple[str, ...] = ("return", "repair_out", "correction")


@dataclass(frozen=True)
class OpenLoan:
    borrower_id: int
    project_id: int | None
    # Pieces this borrower still holds on this project (always > 0).
    quantity: int


def open_loan_for_article(db: Session, article_id: int) -> OpenLoan | None:
    """Who is still holding this article, and on which project — or ``None``.

    The most recent checkout that nothing has balanced yet, by the *same*
    definition of "open" as ``list_my_checkouts``: a row belongs to whoever it
    names, or — when it names nobody — to whoever booked it (hence the
    ``coalesce``); a checkout adds to that borrower's balance and a return /
    repair_out / correction subtracts from it; and the balance is kept per
    ``(borrower, project)`` because that is the tuple the "My checkouts" list
    groups by.

    Only sound where nobody can be named. A station's ``user_id`` is the
    *borrowed* name of the administrator who approved the pairing, so a
    missing assignee there means "nobody tapped a name", not "the admin took
    it"; a phone or a desk has a person in the request, and guessing a
    different borrower there would rewrite bookings somebody made on purpose.
    """
    loan = _most_recent_open_loan(db, article_id, borrower_id=None)
    # The name has to still exist to go on a row: ``assignee_user_id`` is a FK.
    if loan is None or db.get(User, loan.borrower_id) is None:
        return None
    return loan


def open_loan_of_person(db: Session, article_id: int, user_id: int) -> OpenLoan | None:
    """This person's most recent open loan of the article, or ``None`` — the
    row "Meine Entnahmen" shows them."""
    return _most_recent_open_loan(db, article_id, borrower_id=user_id)


def _most_recent_open_loan(db: Session, article_id: int, *, borrower_id: int | None) -> OpenLoan | None:
    # Whoever the row is charged to — the tapped name, else the booker.
    borrower = func.coalesce(WerkstattMovement.assignee_user_id, WerkstattMovement.user_id)
    signed_qty = case(
        (WerkstattMovement.movement_type == "checkout", WerkstattMovement.quantity),
        (WerkstattMovement.movement_type.in_(LOAN_CLOSING_TYPES), -WerkstattMovement.quantity),
        else_=0,
    )
    balance = func.coalesce(func.sum(signed_qty), 0)
    # Ordering is by the group's newest checkout — "the loan that was opened
    # last" is the best available answer to "which of these just came back",
    # and the ledger does not link a return to a checkout. The row id breaks a
    # tie so two checkouts in the same clock tick resolve the same way on
    # every run.
    last_checkout_at = func.max(
        case((WerkstattMovement.movement_type == "checkout", WerkstattMovement.created_at), else_=None)
    )
    last_checkout_id = func.max(
        case((WerkstattMovement.movement_type == "checkout", WerkstattMovement.id), else_=None)
    )
    stmt = (
        select(
            borrower.label("borrower_id"),
            WerkstattMovement.project_id.label("project_id"),
            balance.label("quantity"),
        )
        .where(WerkstattMovement.article_id == article_id)
        .group_by(borrower, WerkstattMovement.project_id)
        .having(balance > 0)
        .order_by(last_checkout_at.desc(), last_checkout_id.desc())
        .limit(1)
    )
    if borrower_id is not None:
        stmt = stmt.where(borrower == borrower_id)
    row = db.execute(stmt).first()
    if row is None or row.borrower_id is None:
        return None
    return OpenLoan(
        borrower_id=int(row.borrower_id),
        project_id=int(row.project_id) if row.project_id is not None else None,
        quantity=int(row.quantity),
    )


def loan_refusal(movement_type: str, quantity: int, article: WerkstattArticle) -> str:
    """The German sentence for a booking ``apply_movement`` refused, read off
    the same counters its guards compare against. Call it before the
    rollback: the guards raised before anything changed, so the snapshot on
    ``article`` is the one they saw."""
    available = int(article.stock_available or 0)
    out = int(article.stock_out or 0)
    repair = int(article.stock_repair or 0)
    if movement_type in ("checkout", "inventory_minus"):
        return f"Nicht genug im Lager: {available} verfügbar, {quantity} verlangt."
    if movement_type == "return":
        return f"Zurückgeben geht nur für Ausgeliehenes: {out} ausgegeben."
    if movement_type == "repair_out":
        return f"In Reparatur geben geht nur für Ausgeliehenes: {out} ausgegeben."
    if movement_type == "repair_back":
        return f"Aus der Reparatur zurück geht nur für Reparaturen: {repair} in Reparatur."
    return "Buchung nicht möglich – der Bestand passt nicht dazu."
