"""The customer's note feed — ``GET/POST /customers/{id}/notes`` and
``DELETE /customers/{id}/notes/{note_id}`` — the customer-level twin of the
project note feed. Every posting is a ``customer.note_posted`` activity, so
it shows on the customer's change log.
"""

from __future__ import annotations

from fastapi import APIRouter

router = APIRouter(prefix="", tags=["customer-notes"])
