"""Files attached to a task.

A plan or a picture the assignee needs. The attachment row is dual-anchored:
it carries ``task_id`` AND the task's project (or customer), and sits in that
scope's ``Aufgaben`` folder, so the same file shows up in the project's file
browser and its WebDAV tree. Access rules: see docs/FILE_SCOPES.md.
"""

from __future__ import annotations

from fastapi import APIRouter

router = APIRouter(prefix="", tags=["task-files"])
