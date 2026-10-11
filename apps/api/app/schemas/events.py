"""The live-update stream's ticket — see services/event_stream_tickets.py."""

from __future__ import annotations

from pydantic import BaseModel


class EventStreamTicketOut(BaseModel):
    ticket: str
    expires_in: int
