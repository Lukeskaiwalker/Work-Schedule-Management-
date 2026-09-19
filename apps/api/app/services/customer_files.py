"""Customer-scope folders — the level above the project folder.

Mirrors the project-folder helpers in ``routers/workflow_helpers`` for
``CustomerFolder`` so that the customer file browser, the customer WebDAV
tree and a customer-anchored task's ``Aufgaben`` folder all agree on what a
folder is. Path normalisation and the protected-folder rule are imported
from the project helpers on purpose: one rule, two scopes.

See docs/FILE_SCOPES.md.
"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.entities import Attachment, CustomerFolder, User

# What a fresh customer folder offers before anyone uploads. ``Verwaltung``
# is protected exactly like the project one (files:view_protected).
DEFAULT_CUSTOMER_FOLDERS: list[tuple[str, bool]] = [
    ("Dokumente", False),
    ("Verwaltung", True),
]

# The folder a task's plan or picture lands in, in either scope.
TASK_FILES_FOLDER = "Aufgaben"


def _helpers():
    # Late import: workflow_helpers imports the services package at module
    # load, so a top-level import here would be circular.
    from app.routers import workflow_helpers as h

    return h


def normalize_folder_path(raw_value: str | None, *, allow_empty: bool = False) -> str:
    return _helpers()._normalize_project_folder_path(raw_value, allow_empty=allow_empty)


def folder_path_is_protected(folder_path: str) -> bool:
    return _helpers()._folder_path_is_protected(folder_path)


def folder_visible_to_user(user: User, folder_path: str, is_protected: bool) -> bool:
    return _helpers()._folder_visible_to_user(user, folder_path, is_protected)


def ensure_customer_default_folders(db: Session, customer_id: int, created_by: int | None = None) -> None:
    existing = set(db.scalars(select(CustomerFolder.path).where(CustomerFolder.customer_id == customer_id)).all())
    changed = False
    for path, is_protected in DEFAULT_CUSTOMER_FOLDERS:
        if path in existing:
            continue
        db.add(CustomerFolder(customer_id=customer_id, path=path, is_protected=is_protected, created_by=created_by))
        changed = True
    if changed:
        db.flush()


def register_customer_folder(
    db: Session,
    *,
    customer_id: int,
    folder_path: str,
    created_by: int | None = None,
) -> None:
    """Make every segment of ``folder_path`` exist for the customer.

    Same SAVEPOINT-per-segment shape as ``_register_project_folder``: sessions
    are autoflush=False, so a plain add-then-select would queue the same
    folder once per file of a multi-upload and collide at commit. The nested
    transaction flushes on exit and swallows the race where two requests
    create the same folder at once — the loser reuses the winner's row.
    """
    normalized = normalize_folder_path(folder_path, allow_empty=True)
    if not normalized:
        return
    cumulative: list[str] = []
    for segment in normalized.split("/"):
        cumulative.append(segment)
        path_value = "/".join(cumulative)
        exists = db.scalars(
            select(CustomerFolder.id).where(
                CustomerFolder.customer_id == customer_id, CustomerFolder.path == path_value
            )
        ).first()
        if exists:
            continue
        try:
            with db.begin_nested():
                db.add(
                    CustomerFolder(
                        customer_id=customer_id,
                        path=path_value,
                        is_protected=folder_path_is_protected(path_value),
                        created_by=created_by,
                    )
                )
        except IntegrityError:
            continue


def customer_folder_paths_for_user(db: Session, customer_id: int, user: User) -> set[str]:
    """Every folder path the user may see: defaults, registered rows, and the
    folders implied by the files themselves (an upload into ``a/b`` makes
    ``a`` and ``a/b`` exist even if no row was ever registered)."""
    visible: set[str] = set()
    for path_value, protected in DEFAULT_CUSTOMER_FOLDERS:
        if folder_visible_to_user(user, path_value, protected):
            visible.add(path_value)
    for row in db.scalars(select(CustomerFolder).where(CustomerFolder.customer_id == customer_id)).all():
        if folder_visible_to_user(user, row.path, row.is_protected):
            visible.add(row.path)
    folder_values = db.scalars(
        select(Attachment.folder_path).where(Attachment.customer_id == customer_id, Attachment.folder_path != "")
    ).all()
    can_see_protected = _helpers()._can_access_project_protected_folder(user)
    for value in folder_values:
        normalized = normalize_folder_path(str(value), allow_empty=True)
        if not normalized:
            continue
        segments = normalized.split("/")
        for idx in range(1, len(segments) + 1):
            path_value = "/".join(segments[:idx])
            if folder_path_is_protected(path_value) and not can_see_protected:
                continue
            visible.add(path_value)
    return visible


def latest_customer_file_by_path(db: Session, customer_id: int, user: User) -> dict[str, Attachment]:
    """Newest attachment per virtual path (``folder/name``), protected folders
    filtered by the user's permission — the WebDAV view of the customer."""
    rows = db.scalars(
        select(Attachment)
        .where(Attachment.customer_id == customer_id)
        .order_by(Attachment.created_at.desc(), Attachment.id.desc())
    ).all()
    by_path: dict[str, Attachment] = {}
    for row in rows:
        folder = normalize_folder_path(row.folder_path, allow_empty=True)
        if not folder_visible_to_user(user, folder, folder_path_is_protected(folder)):
            continue
        path_value = f"{folder}/{row.file_name}" if folder else row.file_name
        by_path.setdefault(path_value, row)
    return by_path
