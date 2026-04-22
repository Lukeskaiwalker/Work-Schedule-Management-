from __future__ import annotations
from datetime import datetime

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Integer, JSON, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base
from app.core.time import utcnow


class Project(Base):
    __tablename__ = "projects"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_number: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(64), default="active", nullable=False)
    last_state: Mapped[str | None] = mapped_column(Text)
    last_status_at: Mapped[datetime | None] = mapped_column(DateTime)
    last_updated_at: Mapped[datetime | None] = mapped_column(DateTime, default=utcnow, nullable=True)
    customer_id: Mapped[int | None] = mapped_column(
        ForeignKey("customers.id", ondelete="SET NULL"), index=True
    )
    customer_name: Mapped[str | None] = mapped_column(String(255))
    customer_address: Mapped[str | None] = mapped_column(String(500))
    construction_site_address: Mapped[str | None] = mapped_column(String(500))
    customer_contact: Mapped[str | None] = mapped_column(String(255))
    customer_email: Mapped[str | None] = mapped_column(String(255))
    customer_phone: Mapped[str | None] = mapped_column(String(128))
    site_access_type: Mapped[str | None] = mapped_column(String(64))
    site_access_note: Mapped[str | None] = mapped_column(String(500))
    extra_attributes: Mapped[dict] = mapped_column(JSON, default=dict, nullable=False)
    is_critical: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    critical_since: Mapped[datetime | None] = mapped_column(DateTime)
    critical_set_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), index=True
    )
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)


class ProjectFinance(Base):
    __tablename__ = "project_finances"

    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True)
    order_value_net: Mapped[float | None] = mapped_column(Float)
    down_payment_35: Mapped[float | None] = mapped_column(Float)
    main_components_50: Mapped[float | None] = mapped_column(Float)
    final_invoice_15: Mapped[float | None] = mapped_column(Float)
    planned_costs: Mapped[float | None] = mapped_column(Float)
    actual_costs: Mapped[float | None] = mapped_column(Float)
    contribution_margin: Mapped[float | None] = mapped_column(Float)
    reported_hours_total: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    planned_hours_total: Mapped[float | None] = mapped_column(Float)
    updated_by: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), index=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow, nullable=False)


class ProjectActivity(Base):
    __tablename__ = "project_activities"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True, nullable=False)
    actor_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), index=True)
    event_type: Mapped[str] = mapped_column(String(64), nullable=False)
    message: Mapped[str] = mapped_column(String(255), nullable=False)
    details: Mapped[dict] = mapped_column(JSON, default=dict, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)


class ProjectWeatherCache(Base):
    __tablename__ = "project_weather_cache"

    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True)
    provider: Mapped[str] = mapped_column(String(64), default="openweather", nullable=False)
    query_address: Mapped[str] = mapped_column(String(500), nullable=False)
    latitude: Mapped[float | None] = mapped_column(Float)
    longitude: Mapped[float | None] = mapped_column(Float)
    payload: Mapped[dict] = mapped_column(JSON, default=dict, nullable=False)
    fetched_at: Mapped[datetime | None] = mapped_column(DateTime)
    last_error: Mapped[str | None] = mapped_column(String(500))
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow, nullable=False)


class ProjectMember(Base):
    __tablename__ = "project_members"
    __table_args__ = (UniqueConstraint("project_id", "user_id", name="uq_project_member"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    can_manage: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)


class ProjectClassTemplate(Base):
    __tablename__ = "project_class_templates"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False, unique=True, index=True)
    materials_required: Mapped[str | None] = mapped_column(Text)
    tools_required: Mapped[str | None] = mapped_column(Text)
    task_templates: Mapped[list[dict]] = mapped_column(JSON, default=list, nullable=False)
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)


class ProjectClassAssignment(Base):
    __tablename__ = "project_class_assignments"
    __table_args__ = (UniqueConstraint("project_id", "class_template_id", name="uq_project_class_assignment"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    class_template_id: Mapped[int] = mapped_column(ForeignKey("project_class_templates.id", ondelete="CASCADE"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
