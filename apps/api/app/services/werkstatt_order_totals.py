"""An order's total, computed in one place and refused when it does not fit.

`WerkstattOrder.total_amount_cents` is an int4 ``Integer``. Every line is
bounded on the way in (quantity ≤ ``MAX_STOCK_QUANTITY``, unit price ≤
``MAX_UNIT_PRICE_CENTS``), but their product and sum are not: one line at
both bounds is already 10^14 cents. A total wider than the column reaches
``db.flush()`` as OverflowError (SQLite) / DataError (PostgreSQL) — an
unhandled 500 from whichever request happened to recompute it.

So both computations of the stored total — the tablet routers'
``compute_total_cents`` and the composition service's ``recompute_total`` —
call `checked_order_total_cents`, which raises the one domain error
`OrderTotalTooLarge`. Routes turn it into the same German 400 with their
transaction rolled back (`refuse_oversized_order_total`); a service whose
caller already rolls back on ``HTTPException`` raises `order_total_refusal`.

A READ never refuses: the order view sums with `sum_order_lines_cents`, so a
legacy order can always be opened and corrected.
"""

from __future__ import annotations

from collections.abc import Iterable, Iterator
from contextlib import contextmanager
from typing import Protocol

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.core.limits import INT32_MAX

ORDER_TOTAL_TOO_LARGE_DETAIL = "Bestellsumme zu groß – bitte Menge oder Preis prüfen."


class OrderTotalTooLarge(ValueError):
    """The lines of an order sum to more than its total column can hold."""

    def __init__(self, total_cents: int) -> None:
        super().__init__(ORDER_TOTAL_TOO_LARGE_DETAIL)
        self.total_cents = total_cents


class PricedLine(Protocol):
    unit_price_cents: int | None
    quantity_ordered: int


def sum_order_lines_cents(lines: Iterable[PricedLine]) -> int | None:
    """Sum unit_price_cents × quantity_ordered across priced lines, unchecked.

    ``None`` when no line carries a price, so the UI can say "Preis auf
    Anfrage" instead of showing a misleading 0-EUR total.
    """

    total = 0
    any_priced = False
    for line in lines:
        if line.unit_price_cents is None:
            continue
        total += line.unit_price_cents * line.quantity_ordered
        any_priced = True
    return total if any_priced else None


def checked_order_total_cents(lines: Iterable[PricedLine]) -> int | None:
    """The total to STORE on an order; raises `OrderTotalTooLarge` past int4."""

    total = sum_order_lines_cents(lines)
    if total is not None and total > INT32_MAX:
        raise OrderTotalTooLarge(total)
    return total


def order_total_refusal() -> HTTPException:
    """The 400 every order writer answers for a total that does not fit."""

    return HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST, detail=ORDER_TOTAL_TOO_LARGE_DETAIL
    )


@contextmanager
def refuse_oversized_order_total(db: Session) -> Iterator[None]:
    """Run an order mutation; on `OrderTotalTooLarge` roll back and answer 400.

    Rolled back, not just refused: by the time the total is computed the new
    or changed lines are already flushed, and a refusal that left them in the
    session would let the next commit store exactly what was refused.
    """

    try:
        yield
    except OrderTotalTooLarge as exc:
        db.rollback()
        raise order_total_refusal() from exc
