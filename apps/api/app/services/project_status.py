"""The four project statuses, and the funnel that maps everything else onto them.

Long-standing field request: the status list had grown to 13 values ("Aktiv"
neben "In Durchführung", five flavours of quote phase, …) and nobody curated
them — so the list answered neither "wie viele Kunden sind in der
Angebotsphase" nor "welche sind aktiv". Reduced to the four stages a job
actually moves through:

    angebotsphase → in_durchfuehrung → rechnung_verschickt → abgeschlossen

Stored as ASCII slugs (the werkstatt idiom — `verfuegbar`, `ausgegeben`), so
CSS classes and filters key on stable machine values while `statusLabel` in
the SPA renders the German/English display names.

Normalization is deliberately a *mapping of known synonyms*, not a whitelist:

  * every historical preset lands on its funnel stage, so the Excel importer
    and old API clients heal the data instead of failing on it;
  * `archived`/`archiviert` are left untouched — the archive is a separate
    mechanism (`_is_project_archived`, the archive view) and not part of the
    funnel;
  * genuinely unknown free text passes through unchanged. An importer row
    saying something we have never seen is information; destroying it to
    enforce a vocabulary would be worse than tolerating it.
"""

from __future__ import annotations

PROJECT_STATUS_ANGEBOT = "angebotsphase"
PROJECT_STATUS_DURCHFUEHRUNG = "in_durchfuehrung"
PROJECT_STATUS_RECHNUNG = "rechnung_verschickt"
PROJECT_STATUS_ABGESCHLOSSEN = "abgeschlossen"

CANONICAL_PROJECT_STATUSES: tuple[str, ...] = (
    PROJECT_STATUS_ANGEBOT,
    PROJECT_STATUS_DURCHFUEHRUNG,
    PROJECT_STATUS_RECHNUNG,
    PROJECT_STATUS_ABGESCHLOSSEN,
)

# Lower-cased, trimmed synonym → canonical. Keys cover every value the old
# preset list offered plus the machine values that predate it.
PROJECT_STATUS_SYNONYMS: dict[str, str] = {
    # ── Angebotsphase: everything before the order is won ───────────────
    "angebotsphase": PROJECT_STATUS_ANGEBOT,
    "anfrage erhalten": PROJECT_STATUS_ANGEBOT,
    "angebot erstellen": PROJECT_STATUS_ANGEBOT,
    "angebot abgeschickt": PROJECT_STATUS_ANGEBOT,
    "kundentermin angefragt": PROJECT_STATUS_ANGEBOT,
    "kundentermin vereinbart": PROJECT_STATUS_ANGEBOT,
    "planning": PROJECT_STATUS_ANGEBOT,
    # ── In Durchführung: won and being built. "Aktiv" folds in here — the
    #    coexistence of the two was the original complaint. on_hold folds in
    #    too: a paused job is still a running engagement, and "paused" was
    #    one of the statuses nobody maintained.
    "in_durchfuehrung": PROJECT_STATUS_DURCHFUEHRUNG,
    "in durchführung": PROJECT_STATUS_DURCHFUEHRUNG,
    "in durchfuehrung": PROJECT_STATUS_DURCHFUEHRUNG,
    "active": PROJECT_STATUS_DURCHFUEHRUNG,
    "aktiv": PROJECT_STATUS_DURCHFUEHRUNG,
    "auftrag angenommen": PROJECT_STATUS_DURCHFUEHRUNG,
    "on_hold": PROJECT_STATUS_DURCHFUEHRUNG,
    "pausiert": PROJECT_STATUS_DURCHFUEHRUNG,
    "rückfragen klären": PROJECT_STATUS_DURCHFUEHRUNG,
    "rueckfragen klaeren": PROJECT_STATUS_DURCHFUEHRUNG,
    # ── Rechnung verschickt ─────────────────────────────────────────────
    "rechnung_verschickt": PROJECT_STATUS_RECHNUNG,
    "rechnung verschickt": PROJECT_STATUS_RECHNUNG,
    "rechnung erstellen": PROJECT_STATUS_RECHNUNG,
    "rechnung gestellt": PROJECT_STATUS_RECHNUNG,
    # ── Abgeschlossen ───────────────────────────────────────────────────
    "abgeschlossen": PROJECT_STATUS_ABGESCHLOSSEN,
    "completed": PROJECT_STATUS_ABGESCHLOSSEN,
    "done": PROJECT_STATUS_ABGESCHLOSSEN,
    "fertig": PROJECT_STATUS_ABGESCHLOSSEN,
}


def normalize_project_status(raw: str | None) -> str:
    """Known synonym → canonical slug; archive and unknown text unchanged.

    Applied on every write path (create, update, Excel import), which is what
    keeps the vocabulary from re-polluting: an old client sending "active"
    heals to `in_durchfuehrung` instead of resurrecting the 13-status zoo.
    """

    value = (raw or "").strip()
    if not value:
        return value
    return PROJECT_STATUS_SYNONYMS.get(value.lower(), value)


# Stages at or past the point where the order is won. The class-template
# "angenommen gate" keys on this: template tasks stay deferred during the
# Angebotsphase and materialise once the job is genuinely on. The legacy
# literal "Auftrag angenommen" is included so the gate keeps working on data
# that migration 0073 has not touched yet.
_WON_STATUSES = frozenset(
    {
        PROJECT_STATUS_DURCHFUEHRUNG,
        PROJECT_STATUS_RECHNUNG,
        PROJECT_STATUS_ABGESCHLOSSEN,
    }
)


def is_won_project_status(raw: str | None) -> bool:
    """True once the job has moved past the quote phase.

    Runs through `normalize_project_status` first, so both the canonical slugs
    and every legacy synonym ("Auftrag angenommen", "active", …) answer
    correctly. Unknown free text and the archive answer False — deferral is
    the conservative side of this gate.
    """

    return normalize_project_status(raw) in _WON_STATUSES
