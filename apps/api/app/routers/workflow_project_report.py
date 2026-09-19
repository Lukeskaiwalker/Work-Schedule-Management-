"""The Projektbericht: one sheet with everything about the project.

Rendered live from the project's data for as long as the project runs
(``GET /projects/{id}/report/preview`` and its paged variant for engines
without a PDF viewer); stored as a PDF in the project's Berichte folder when
the project is marked abgeschlossen or archived (``POST …/report/finalize``,
also triggered by that status change in update_project).
"""

from __future__ import annotations

from fastapi import APIRouter

router = APIRouter(prefix="", tags=["project-report"])
