from __future__ import annotations
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base
from app.core.time import utcnow


class Attachment(Base):
    __tablename__ = "attachments"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[int | None] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    site_id: Mapped[int | None] = mapped_column(ForeignKey("sites.id", ondelete="SET NULL"), index=True)
    job_ticket_id: Mapped[int | None] = mapped_column(ForeignKey("job_tickets.id", ondelete="SET NULL"), index=True)
    message_id: Mapped[int | None] = mapped_column(ForeignKey("messages.id", ondelete="SET NULL"), index=True)
    construction_report_id: Mapped[int | None] = mapped_column(
        ForeignKey("construction_reports.id", ondelete="SET NULL"), index=True
    )
    # A file that belongs to the customer rather than to one of their jobs:
    # the framework contract, the building's plans, the meter-cabinet photo
    # every project needs again. Lives beside ``project_id``; a row carries
    # one scope or the other, never both.
    customer_id: Mapped[int | None] = mapped_column(ForeignKey("customers.id", ondelete="SET NULL"), index=True)
    # The task this file was attached to, so the assignee finds the plan or
    # picture on the task itself. Such a row ALSO carries the task's project
    # (or customer) and sits in that scope's ``Aufgaben`` folder, which is
    # what makes it visible in the file browser and over WebDAV. SET NULL:
    # deleting the task must not lose the file, it falls back to the scope.
    task_id: Mapped[int | None] = mapped_column(ForeignKey("tasks.id", ondelete="SET NULL"), index=True)
    uploaded_by: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), index=True)
    folder_path: Mapped[str] = mapped_column(String(500), default="", nullable=False)
    file_name: Mapped[str] = mapped_column(String(255), nullable=False)
    content_type: Mapped[str] = mapped_column(String(128), nullable=False)
    stored_path: Mapped[str] = mapped_column(String(500), nullable=False, unique=True)
    is_encrypted: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)


class ProjectFolder(Base):
    __tablename__ = "project_folders"
    __table_args__ = (UniqueConstraint("project_id", "path", name="uq_project_folder_path"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    path: Mapped[str] = mapped_column(String(500), nullable=False)
    is_protected: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)


class CustomerFolder(Base):
    """A virtual folder in a customer's own file space.

    Mirrors ``ProjectFolder`` one level up: the customer folder is where the
    project folders "land in", and it needs the same protected-folder rule
    (``Verwaltung`` is only for people with ``files:view_protected``) and the
    same normalised ``a/b/c`` path convention so one set of helpers serves
    both scopes.
    """

    __tablename__ = "customer_folders"
    __table_args__ = (UniqueConstraint("customer_id", "path", name="uq_customer_folder_path"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    customer_id: Mapped[int] = mapped_column(ForeignKey("customers.id", ondelete="CASCADE"), index=True)
    path: Mapped[str] = mapped_column(String(500), nullable=False)
    is_protected: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
