"""The change log's lines, as they are shown: German.

``project_activities`` and ``customer_activities`` rows carry a ``message``
that the "Letzte Änderungen" cards, the customer feed and the Verlauf of the
Projektbericht print verbatim. Until v2.14.40 half the writers stored English
("Task created: …", "File uploaded: …", "State changed to in_durchfuehrung")
into a German UI. The writers store German now. The rows already stored keep
their text — history is not rewritten — and are translated here whenever they
are read.

Only the structured lines the code itself wrote are recognised: an exact
sentence or a fixed prefix, and only under the event type that wrote it. The
tail after a prefix (a task title, a file name, a project number) is data and
stays as it is. Everything else — a note preview, a partner's name — is the
user's own text and passes through untouched, even when it happens to read
like one of the old lines.
"""

from __future__ import annotations

from app.services.project_status import project_status_label

# Old English prefix → German prefix, per event type. The writers use the
# German prefix since v2.14.41, so a row of either age reads the same.
_LEGACY_PREFIXES: dict[str, tuple[tuple[str, str], ...]] = {
    "task.created": (("Task created: ", "Aufgabe erstellt: "),),
    "task.updated": (("Task updated: ", "Aufgabe aktualisiert: "),),
    "task.deleted": (("Task deleted: ", "Aufgabe gelöscht: "),),
    "project.created": (("Project created: ", "Projekt erstellt: "),),
    "file.uploaded": (("File uploaded: ", "Datei hochgeladen: "),),
    "file.deleted": (("File deleted: ", "Datei gelöscht: "),),
    "material.created": (("Material need added (", "Materialbedarf angelegt ("),),
    "material.status_updated": (("Material status updated (", "Materialstatus aktualisiert ("),),
    "material.updated": (("Material need updated (", "Materialbedarf bearbeitet ("),),
    "material.deleted": (("Material need deleted (", "Materialbedarf gelöscht ("),),
    "report.created": (("Construction report created (", "Baustellenbericht erstellt ("),),
    "ticket.created": (("Job ticket created: ", "Ticket erstellt: "),),
    "ticket.updated": (("Job ticket updated: ", "Ticket aktualisiert: "),),
}

# Old English sentence → German sentence, per event type.
_LEGACY_SENTENCES: dict[str, dict[str, str]] = {
    "project.classes_updated": {
        "Project classes assigned": "Projektklassen zugewiesen",
        "Project classes updated": "Projektklassen aktualisiert",
        "Auto-created deferred template tasks": "Zurückgestellte Vorlagen-Aufgaben angelegt",
    },
    "project.note_updated": {"Internal note updated": "Interne Notiz aktualisiert"},
    "project.critical_set": {"Project marked critical": "Projekt als kritisch markiert"},
    "project.critical_cleared": {"Critical flag cleared": "Kritisch-Markierung entfernt"},
    "finance.updated": {"Project finances updated": "Projektfinanzen aktualisiert"},
}

# What a status change said before it carried its from/to in ``details``.
_LEGACY_STATE_CHANGED = "State changed to "


def status_change_message(previous: str | None, current: str | None) -> str:
    """``Angebotsphase → In Durchführung`` — the labels, never the slugs."""
    return f"{project_status_label(previous)} → {project_status_label(current)}"


def display_activity_message(event_type: str, message: str | None, details: dict | None) -> str:
    """The row's line as the change log shows it."""
    text = message or ""
    data = details if isinstance(details, dict) else {}
    if event_type == "project.state_changed":
        # The details say what moved; the stored line said it in slugs.
        if "to" in data:
            return status_change_message(data.get("from"), data.get("to"))
        if text.startswith(_LEGACY_STATE_CHANGED):
            return f"Status geändert zu {project_status_label(text[len(_LEGACY_STATE_CHANGED):])}"
        return text
    sentence = _LEGACY_SENTENCES.get(event_type, {}).get(text)
    if sentence is not None:
        return sentence
    for old, new in _LEGACY_PREFIXES.get(event_type, ()):
        if text.startswith(old):
            return new + text[len(old):]
    return text
