"""Customer-level folders and files.

The customer folder is the level above the project folder: what belongs to
the customer rather than to one job lives here. Endpoints mirror the project
ones in ``workflow_files`` (``/customers/{id}/folders``, ``/customers/{id}/files``);
the shared ``/files/{id}/...`` routes serve preview, download and delete for
every scope. Access rules: see docs/FILE_SCOPES.md.
"""

from __future__ import annotations

from fastapi import APIRouter

router = APIRouter(prefix="", tags=["customer-files"])
