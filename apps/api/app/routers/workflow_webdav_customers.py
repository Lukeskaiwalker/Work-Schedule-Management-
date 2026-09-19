"""WebDAV tree rooted at the customer.

``/api/dav/customers/<ref>/`` holds the customer's own folders and files and
one collection per project of that customer, so a mounted drive shows the
same hierarchy the app does: the customer folder with the project folders
inside. The project tree at ``/api/dav/projects/`` stays as it is for drives
already mounted. Layout and refs: see docs/FILE_SCOPES.md.
"""

from __future__ import annotations

from fastapi import APIRouter

router = APIRouter(prefix="", tags=["webdav"])
