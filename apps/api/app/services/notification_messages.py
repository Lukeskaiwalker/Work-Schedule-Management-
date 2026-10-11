"""The notification bell's lines, as they are shown: German.

The panel prints ``Notification.message`` verbatim. The assignment line used
to be written in English (``Luca assigned you to "Gerüst aufbauen"``); it is
written in German now, and a row stored before keeps its text in the database
and is translated when it is listed. The old line is structured — actor, a
fixed phrase, the quoted title — so both parts carry over.
"""

from __future__ import annotations

import re

from app.models.notification import Notification

# ``{actor} assigned you to "{title}"`` — greedy title, so quotes inside a
# title stay part of it.
_LEGACY_TASK_ASSIGNED = re.compile(r'^(?P<actor>.+?) assigned you to "(?P<title>.*)"$', re.DOTALL)

_TASK_ASSIGNED_LEAD = " hat dir die Aufgabe „"
_TASK_ASSIGNED_TAIL = "“ zugewiesen"

# PostgreSQL refuses a VARCHAR overflow at commit, and the notification is
# added in the task's own transaction: a line wider than the column is a 500
# that loses the task or the edit with it. The German phrase is 15 characters
# longer than the English one was, so titles the old line still fit no longer
# do. The line gives way, not the task: the title is cut to the room left.
_MESSAGE_WIDTH = Notification.__table__.c["message"].type.length


def task_assigned_message(actor: str, title: str) -> str:
    """``Luca hat dir die Aufgabe „Gerüst aufbauen“ zugewiesen``.

    A title too long for the column ends in "…" so the sentence still closes;
    the task keeps its whole title, the bell only points at it.
    """
    room = _MESSAGE_WIDTH - len(actor) - len(_TASK_ASSIGNED_LEAD) - len(_TASK_ASSIGNED_TAIL)
    shown = title if len(title) <= room else title[: max(room - 1, 0)].rstrip() + "…"
    # Only an actor name near the column's own width gets here still too
    # long; then the line is simply cut.
    return f"{actor}{_TASK_ASSIGNED_LEAD}{shown}{_TASK_ASSIGNED_TAIL}"[:_MESSAGE_WIDTH]


def display_notification_message(event_type: str, message: str | None) -> str:
    """The row's line as the panel shows it."""
    text = message or ""
    if event_type == "task.assigned":
        match = _LEGACY_TASK_ASSIGNED.match(text)
        if match:
            return task_assigned_message(match.group("actor"), match.group("title"))
    return text
