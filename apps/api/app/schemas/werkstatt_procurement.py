"""Pydantic contracts for wholesaler punchout and order composition.

Separate from `schemas/werkstatt.py` because that file is already long and
these types belong to a different owner (procurement, not inventory). The
order in/out shapes themselves stay there — an imported cart becomes an
ordinary order, and giving it a second output schema would fork the UI.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class _OrmBase(BaseModel):
    model_config = ConfigDict(from_attributes=True)


# ──────────────────────────────────────────────────────────────────────────
# Connection configuration
# ──────────────────────────────────────────────────────────────────────────


class IdsConnectionOut(_OrmBase):
    id: int
    supplier_id: int
    supplier_name: str
    is_enabled: bool
    entry_url: str
    http_method: str
    ids_version: str
    charset: str
    username: str | None
    customer_number: str | None
    # The password itself is never returned. `has_password` is what a settings
    # form needs — "is one set?" — and the value is only ever written.
    has_password: bool
    fetch_field_map: dict[str, Any]
    submit_field_map: dict[str, Any]
    cart_field_names: list[str]
    hook_base_url: str | None
    # Rendered with a placeholder token so the admin can copy it into the
    # wholesaler's configuration and see immediately whether the host part is
    # one their shop can reach. Wrong hook URLs are the classic setup failure.
    hook_url_preview: str
    notes: str | None
    created_at: datetime
    updated_at: datetime


class IdsConnectionUpsertPayload(BaseModel):
    """Create or replace one supplier's punchout configuration."""

    supplier_id: int
    is_enabled: bool = False
    entry_url: str = Field(default="", max_length=1000)
    http_method: Literal["POST", "GET"] = "POST"
    ids_version: str = Field(default="2.5", max_length=16)
    charset: str = Field(default="ISO-8859-1", max_length=32)
    username: str | None = Field(default=None, max_length=255)
    # Tri-state, and the distinction matters on every settings screen:
    #   None → leave the stored password alone (the form was submitted with
    #          the masked placeholder still in the field)
    #   ""   → clear it
    #   text → replace it
    password: str | None = None
    customer_number: str | None = Field(default=None, max_length=64)
    fetch_field_map: dict[str, Any] | None = None
    submit_field_map: dict[str, Any] | None = None
    cart_field_names: list[str] | None = None
    hook_base_url: str | None = Field(default=None, max_length=500)
    notes: str | None = None


class IdsConnectionTestOut(BaseModel):
    """Result of the pre-flight check on a configuration."""

    ok: bool
    problems: list[str] = Field(default_factory=list)
    hook_url: str
    # Field names and values that WOULD be sent, with the password masked, so
    # the admin can diff them against the wholesaler's datasheet without
    # having to capture live traffic.
    preview_fields: dict[str, str] = Field(default_factory=dict)


# ──────────────────────────────────────────────────────────────────────────
# Punchout hand-over
# ──────────────────────────────────────────────────────────────────────────


class IdsStartPayload(BaseModel):
    supplier_id: int
    # When set, the returned cart is appended to this existing draft instead
    # of creating a new order — "go get the rest of the material".
    order_id: int | None = None
    task_id: int | None = None
    project_id: int | None = None


class IdsStartOut(BaseModel):
    token: str
    # The URL to open in a new tab. It serves a self-submitting form rather
    # than being the shop URL itself, because the hand-over is a POST with
    # credentials and a browser cannot be navigated into one.
    handoff_url: str
    expires_at: datetime


class IdsSubmitOut(BaseModel):
    token: str
    handoff_url: str
    expires_at: datetime
    warnings: list[str] = Field(default_factory=list)


class ManualCartImportPayload(BaseModel):
    """Import a cart XML the user obtained some other way.

    The escape hatch for a deployment whose punchout is not configured yet, or
    whose wholesaler mails an XML instead. It runs the same parser and writes
    the same audit row, so nothing about the result is second-class.
    """

    supplier_id: int
    xml: str = Field(min_length=1)
    order_id: int | None = None
    task_id: int | None = None
    project_id: int | None = None


class CartPreviewLineOut(BaseModel):
    position: int
    supplier_article_no: str | None
    description: str | None
    manufacturer: str | None
    ean: str | None
    quantity: int
    quantity_raw: str | None
    unit: str | None
    unit_price_cents: int | None
    currency: str
    warnings: list[str] = Field(default_factory=list)
    # Filled when the line matched something we already stock.
    matched_article_id: int | None = None
    matched_article_name: str | None = None


class OrderImportOut(_OrmBase):
    id: int
    supplier_id: int
    supplier_name: str
    source: str
    status: str
    external_reference: str | None
    parsed_line_count: int
    error_message: str | None
    order_id: int | None
    order_number: str | None
    created_by: int | None
    created_by_name: str | None
    created_at: datetime


class CartImportResultOut(BaseModel):
    import_id: int
    order_id: int
    order_number: str
    line_count: int
    warnings: list[str] = Field(default_factory=list)
    lines: list[CartPreviewLineOut] = Field(default_factory=list)


# ──────────────────────────────────────────────────────────────────────────
# Order composition
# ──────────────────────────────────────────────────────────────────────────


class OrderLineCreatePayload(BaseModel):
    """Add one line. Either a stocked article or a free-text position.

    `article_id` is optional precisely so the same endpoint covers "add 3 of
    SP-0042" and "add 40 m of whatever the wholesaler calls this cable" — the
    second is most of what lands on a real order.
    """

    article_id: int | None = None
    supplier_article_no: str | None = Field(default=None, max_length=160)
    description: str | None = Field(default=None, max_length=500)
    manufacturer: str | None = Field(default=None, max_length=255)
    ean: str | None = Field(default=None, max_length=64)
    unit: str | None = Field(default=None, max_length=64)
    quantity_ordered: int = Field(default=1, ge=1)
    unit_price_cents: int | None = Field(default=None, ge=0)
    currency: str | None = Field(default=None, min_length=1, max_length=8)
    notes: str | None = None


class OrderLineUpdatePayload(BaseModel):
    """Patch one line. Unset fields are left alone."""

    article_id: int | None = None
    supplier_article_no: str | None = Field(default=None, max_length=160)
    description: str | None = Field(default=None, max_length=500)
    manufacturer: str | None = Field(default=None, max_length=255)
    ean: str | None = Field(default=None, max_length=64)
    unit: str | None = Field(default=None, max_length=64)
    quantity_ordered: int | None = Field(default=None, ge=1)
    unit_price_cents: int | None = Field(default=None, ge=0)
    currency: str | None = Field(default=None, min_length=1, max_length=8)
    notes: str | None = None


class OrderMergePayload(BaseModel):
    source_order_id: int
    # When true (the default) identical lines at identical prices are summed.
    # Turning it off keeps every line separate, which is what you want when
    # each order was for a different job and the split has to survive.
    combine_duplicates: bool = True


class OrderSaveTemplatePayload(BaseModel):
    name: str = Field(min_length=1, max_length=255)


class OrderApplyTemplatePayload(BaseModel):
    template_id: int


class OrderCreateFromTemplatePayload(BaseModel):
    template_id: int
    title: str | None = Field(default=None, max_length=255)
    task_id: int | None = None
    project_id: int | None = None


class OrderAttachPayload(BaseModel):
    """Point an order at a job or a project. Explicit nulls detach.

    Uses `model_fields_set` at the call site so "not mentioned" and "set to
    null" stay distinguishable — otherwise detaching an order from a task
    would be impossible to express.
    """

    task_id: int | None = None
    project_id: int | None = None
    title: str | None = Field(default=None, max_length=255)
