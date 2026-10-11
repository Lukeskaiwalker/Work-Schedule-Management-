"""Upper bounds for numbers the API accepts from a request.

A value wider than its column must never reach ``db.flush()``: SQLite raises
``OverflowError`` and PostgreSQL ``DataError`` ("integer out of range" /
"numeric field overflow") — both escape the routers' domain-error handlers as
an unhandled 500. Worse, a value that still fits can be multiplied or summed
into one that does not (an order total, a line-item total), and then the 500
comes from a later, unrelated request. The bounds here are generous for the
workshop and the office and tight enough that every product and sum built
from them is checked before it is stored.

Request schemas use these in ``Field(le=...)``; services that store a
product or a sum check it against the column maximum and refuse with a domain
error the router turns into a 400.
"""

from __future__ import annotations

from decimal import Decimal

#: Pieces in one booking, count, order line or report line. Matches the desk
#: stock adjustment (``MAX_ADJUST_QUANTITY``) and the stock-take import.
MAX_STOCK_QUANTITY = 1_000_000

#: Price of ONE unit in cents: 1,000,000.00 €.
MAX_UNIT_PRICE_CENTS = 100_000_000

#: Largest value of an ``Integer`` column on PostgreSQL (int4).
INT32_MAX = 2_147_483_647

#: Largest value of a ``Numeric(12, 2)`` column.
NUMERIC_12_2_MAX = Decimal("9999999999.99")
