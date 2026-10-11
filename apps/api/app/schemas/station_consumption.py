"""Bodies and answers of the rack's consumable and project-picker endpoints.

See ``routers/workflow_station_consumption.py``. Kept out of
``schemas/station.py`` (already long) because these describe one feature: a
consumable taken at the wall leaves the stock for good, for a person and —
when one was picked — a project.
"""

from __future__ import annotations

from datetime import date
from typing import Literal

from pydantic import BaseModel, Field

from app.schemas.station import STATION_MAX_QUANTITY
from app.schemas.werkstatt import WerkstattArticleOut


# ── GET /crew-projects ────────────────────────────────────────────────────────


class StationOfferedProjectOut(BaseModel):
    """One project tile on the rack. Exactly these four fields: the wall is
    unauthenticated, so no customer, no address and no task title."""

    id: int
    project_number: str
    name: str
    # heute — a task of this person covers today; woche — this week;
    # zuletzt — last week, or a report / material / Verteiler in 14 days.
    hint: Literal["heute", "woche", "zuletzt"]


class StationCrewProjectsPersonOut(BaseModel):
    user_id: int
    projects: list[StationOfferedProjectOut]


class StationCrewProjectsOut(BaseModel):
    """The whole crew at once, so the station can cache it beside the crew
    list: a tap on a name must never wait for the network."""

    # This week's Monday in the workshop's timezone.
    week_start: date
    # Exactly the people of GET /crew, in the same order.
    people: list[StationCrewProjectsPersonOut]


# ── POST /consumptions (+ /undo) ──────────────────────────────────────────────


class StationConsumptionRequest(BaseModel):
    article_id: int
    quantity: int = Field(default=1, ge=1, le=STATION_MAX_QUANTITY)
    # Required: a consumable leaving the shelf always names who took it. Must
    # be somebody GET /crew offers.
    assignee_user_id: int
    # Optional: "Ohne Projekt" is a real choice (workshop use).
    project_id: int | None = None
    # One booking ATTEMPT's token, reused verbatim on its retries, so a retry
    # after a timeout replays instead of consuming twice.
    request_id: str | None = Field(default=None, max_length=64)
    # Free text from the device; it follows the station marker, never replaces it.
    notes: str | None = Field(default=None, max_length=500)


class StationConsumptionUndoRequest(BaseModel):
    """Taking pieces back: ABBRUCH right after a booking, or leftovers carried
    back from the site (a Rückgabe of a consumable)."""

    article_id: int
    quantity: int = Field(default=1, ge=1, le=STATION_MAX_QUANTITY)
    # Who brings it back, when a name was tapped; if given, it must be crew.
    assignee_user_id: int | None = None
    # With ``pick_project`` false this names the bucket exactly — ``null`` is
    # the "without project" bucket, not "any".
    project_id: int | None = None
    # True for a Rückgabe with no project selected (``project_id`` is then
    # not read). The server decides, in this order: this person's own
    # consumption (most recent bucket); their own open loan of the article (a
    # consumable lent before 2026-10-10 — booked as a ``return``); with nobody
    # named, the loan the station infers (also a ``return``); anybody's
    # consumption; else 400.
    pick_project: bool = False
    request_id: str | None = Field(default=None, max_length=64)
    # ABBRUCH of a rack consumption: its ``movement_id``. When that booking of
    # this station topped up a short shelf, the top-up is taken back too
    # (once). Read only with ``pick_project`` false — leftovers carried back
    # are not a correction.
    undo_of_movement_id: int | None = None


class StationConsumptionPersonOut(BaseModel):
    id: int
    display_name: str


class StationConsumptionProjectOut(BaseModel):
    id: int
    project_number: str
    name: str


class StationConsumptionOut(BaseModel):
    movement_id: int
    # ``return`` only from /consumptions/undo with ``pick_project``: the
    # pieces closed an old loan; ``assignee`` is then the borrower and
    # ``project`` the loan's project.
    booked_as: Literal["consumption", "consumption_undo", "return"]
    quantity: int
    # The article as it now stands — the same projection every other station
    # answer carries, so the screen renders the server's arithmetic.
    article: WerkstattArticleOut
    assignee: StationConsumptionPersonOut | None = None
    project: StationConsumptionProjectOut | None = None
    # Set when the shelf held fewer than were taken (the shortfall was booked
    # first as a stock correction); German, shown as is.
    stock_warning: str | None = None
    topped_up: int = 0
    # Pieces of that top-up taken back by this undo (``undo_of_movement_id``);
    # 0 otherwise.
    reversed_top_up: int = 0
    # True when this answer is the earlier booking of the same request_id.
    replayed: bool = False
