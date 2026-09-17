"""Schemas for ``GET /api/werkstatt/on-site`` — the full "Auf Baustelle" list.

Deliberately NOT the dashboard's ``WerkstattCheckoutGroupPreviewOut``. That one
is a preview in both senses: it stops after three projects and five rows each,
and it counts raw ``checkout`` ledger rows, so an item that came back last week
is still on it. A screen whose whole job is "what is still out there" cannot be
built on either property, so it gets its own shape.

Two fields exist here that the preview does not carry:

``assignee_user_id`` — the page books returns through
``POST /werkstatt/mobile/return``, and booking one for somebody else means
``?on_behalf_of=<id>``, which needs ``werkstatt:manage``. Without the id the FE
cannot tell which rows it is allowed to act on, and would have to offer a button
that can only 403.

``quantity_out`` — the *remaining* quantity of that checkout after the returns
that followed it, not the quantity originally taken.
"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel


class WerkstattOnSiteItemOut(BaseModel):
    """One article still outstanding at one project, for one person."""

    article_id: int
    article_number: str
    article_name: str
    unit: str | None
    image_url: str | None
    #: Remaining after returns/repairs/write-offs were applied oldest-first.
    quantity_out: int
    assignee_user_id: int | None
    assignee_display_name: str | None
    #: Oldest still-open checkout behind this row.
    checked_out_at: datetime
    #: The deadline the merged checkouts share — lots that are due back at
    #: different moments stay separate rows, so this is never an approximation
    #: of several dates.
    expected_return_at: datetime | None
    is_overdue: bool


class WerkstattOnSiteGroupOut(BaseModel):
    """All outstanding articles for one project.

    ``project_id`` is null for the one group that collects checkouts booked
    without a project. Those are still out of the workshop, so hiding them
    would make the page disagree with the ``on_site_count`` KPI beside it.

    No customer name and no site address. The endpoint is gated on
    authentication alone, while every other project read path filters through
    ``_projects_visible_to_user`` — so anything identifying a customer would
    reach an employee who was deliberately removed from that job. The question
    this screen answers ("what is still out?") is answered by the project
    number and title, which the dashboard already shows to every signed-in
    user.
    """

    project_id: int | None
    project_number: str | None
    project_title: str | None
    item_count: int
    total_quantity: int
    overdue_count: int
    items: list[WerkstattOnSiteItemOut]
