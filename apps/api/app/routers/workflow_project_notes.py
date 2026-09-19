"""The project's internal note feed.

``GET/POST /projects/{id}/notes`` and ``DELETE /projects/{id}/notes/{note_id}``.
Replaces the single overwritten "Interne Notiz": every posting keeps its
author and time, and the activity log records it so the customer's
cross-project log shows it too.
"""

from __future__ import annotations

from fastapi import APIRouter

router = APIRouter(prefix="", tags=["project-notes"])
