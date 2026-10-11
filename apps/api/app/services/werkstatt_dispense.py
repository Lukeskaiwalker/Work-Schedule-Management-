"""Ausgabe at the desk ("Entnehmen") and on the phone — one decision for both.

Owner, 2026-10-10: "any item that is not inside the machine tab is a
consumable, when we scan it we book it out of the inventory and it is
installed at a work site". The Regal station books through the same rule
(``werkstatt_consumption``), so an article leaves the stock the same way
wherever it was handed out.

* A consumable (``is_serialized`` False) is used up: ``book_stock_consumption``
  with the person who took it and, when chosen, the project
  (``require_bookable_project`` — unknown and archived answer one sentence).
  A return date means nothing for it and is dropped. A short shelf is topped
  up first and the result says so.
* A machine type is lent exactly as before: a ``checkout`` that waits for its
  ``return``, bounded by what is available.

Callers commit; everything here only flushes. Errors are
``werkstatt_consumption.ConsumptionError`` (German) and
``werkstatt_movements.MovementError``; both are a 400 at the boundary.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Literal

from sqlalchemy.orm import Session

from app.models.entities import WerkstattArticle, WerkstattMovement
from app.services.werkstatt_consumption import (
    book_stock_consumption,
    is_consumable,
    require_bookable_project,
)
from app.services.werkstatt_movements import apply_movement


@dataclass(frozen=True)
class DispenseResult:
    booked_as: Literal["consumption", "checkout"]
    movement: WerkstattMovement
    stock_warning: str | None


def dispense_article(
    db: Session,
    *,
    article: WerkstattArticle,
    quantity: int,
    user_id: int,
    assignee_user_id: int,
    project_id: int | None,
    expected_return_at: datetime | None,
    notes: str | None,
) -> DispenseResult:
    """Hand ``quantity`` of ``article`` to ``assignee_user_id``. The caller
    loaded the article with ``load_article_for_update``, checked the person
    and that it may book onto ``project_id``; ``user_id`` is who booked it."""
    if is_consumable(article):
        require_bookable_project(db, project_id)
        booked = book_stock_consumption(
            db,
            article=article,
            quantity=quantity,
            user_id=user_id,
            assignee_user_id=assignee_user_id,
            project_id=project_id,
            notes=notes,
        )
        return DispenseResult(booked_as="consumption", movement=booked.movement, stock_warning=booked.stock_warning)

    loan = apply_movement(
        db,
        article=article,
        movement_type="checkout",
        quantity=quantity,
        user_id=user_id,
        assignee_user_id=assignee_user_id,
        project_id=project_id,
        expected_return_at=expected_return_at,
        notes=notes,
    )
    return DispenseResult(booked_as="checkout", movement=loan, stock_warning=None)
