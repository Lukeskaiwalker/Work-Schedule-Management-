"""The notification bell's lines, as they are shown: German.

The panel prints ``Notification.message`` verbatim. The assignment line used
to be written in English (``Luca assigned you to "Gerüst aufbauen"``); it is
written in German now, and a row stored before keeps its text in the database
and is translated when it is listed. The old line is structured — actor, a
fixed phrase, the quoted title — so both parts carry over.
"""

from __future__ import annotations

import re

# ``{actor} assigned you to "{title}"`` — greedy title, so quotes inside a
# title stay part of it.
_LEGACY_TASK_ASSIGNED = re.compile(r'^(?P<actor>.+?) assigned you to "(?P<title>.*)"$', re.DOTALL)


def task_assigned_message(actor: str, title: str) -> str:
    """``Luca hat dir die Aufgabe „Gerüst aufbauen“ zugewiesen``."""
    return f"{actor} hat dir die Aufgabe „{title}“ zugewiesen"


def display_notification_message(event_type: str, message: str | None) -> str:
    """The row's line as the panel shows it."""
    text = message or ""
    if event_type == "task.assigned":
        match = _LEGACY_TASK_ASSIGNED.match(text)
        if match:
            return task_assigned_message(match.group("actor"), match.group("title"))
    return text
