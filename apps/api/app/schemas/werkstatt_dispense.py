"""Body and answer of the desk "Entnehmen" and the phone checkout
(``POST /api/werkstatt/mobile/checkout``).

The answer is the article snapshot the endpoint always answered with, plus
what the booking turned out to be — a consumable leaves the stock for good, a
machine type is lent (``services/werkstatt_dispense.py``). Kept in lock-step
with the web's local extension of ``WerkstattArticleStockSnapshot``.
"""

from __future__ import annotations

from typing import Literal

from pydantic import Field

from app.schemas.station import STATION_MAX_QUANTITY
from app.schemas.werkstatt import CheckoutPayload, WerkstattArticleOut

DispenseBookedAs = Literal["consumption", "checkout"]


class WerkstattDispensePayload(CheckoutPayload):
    """``CheckoutPayload`` with an upper bound on ``quantity``.

    Only a machine type is still refused beyond ``stock_available`` (it is
    lent). A consumable is never refused for a short shelf — the shortfall is
    topped up as ``inventory_plus``, which has no counter to fast-fail against
    — so the stock no longer bounds the number, and an integer wider than the
    column reached ``db.flush()`` as an OverflowError/DataError: an unhandled
    500. Bounded on the wire with the station's number and reasoning
    (``schemas/station.STATION_MAX_QUANTITY``): the same column, and far past
    anything somebody at the counter or on the phone can mean. The web's
    ``CONSUMPTION_MAX_QUANTITY`` is the same 10 000.
    """

    quantity: int = Field(..., gt=0, le=STATION_MAX_QUANTITY)


class WerkstattDispenseOut(WerkstattArticleOut):
    # "consumption": used up — total and available went down, nothing waits
    # for a return. "checkout": a loan of a machine type, as before.
    booked_as: DispenseBookedAs
    # German, set when the shelf count was short and the shortfall was booked
    # as ``inventory_plus`` before the consumption.
    stock_warning: str | None = None
