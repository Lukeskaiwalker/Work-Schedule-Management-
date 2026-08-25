"""projects: consolidate the 13 grown statuses into the 4-stage funnel

Long-standing field request: "Aktiv" and "In Durchführung" coexisted, five
flavours of quote phase, and nobody curated any of it. Every known historical
status maps onto its funnel stage:

    angebotsphase        ← Anfrage erhalten, Angebot erstellen/abgeschickt,
                           Kundentermin angefragt/vereinbart, planning
    in_durchfuehrung     ← active, Aktiv, In Durchführung, Auftrag angenommen,
                           on_hold, Rückfragen klären
    rechnung_verschickt  ← Rechnung erstellen
    abgeschlossen        ← completed, done, fertig

Deliberately untouched:
  * ``archived`` / ``archiviert`` — the archive is its own mechanism
    (``_is_project_archived``), not a funnel stage;
  * anything not in the synonym table — unknown free text (mostly from old
    Excel imports) is information, and destroying it to enforce a vocabulary
    would be worse than tolerating it. The write paths normalize the known
    synonyms from now on, so the zoo cannot regrow.

No downgrade mapping: the migration is many-to-one, so the original 13-value
spread cannot be reconstructed. Downgrade is a no-op.

Revision ID: 20260817_0073
Revises: 20260816_0072
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "20260817_0073"
down_revision: Union[str, Sequence[str], None] = "20260816_0072"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# Copied literally rather than imported from app.services.project_status: a
# migration must keep describing this moment in history even after the
# application's mapping moves on.
_MAPPING: dict[str, list[str]] = {
    "angebotsphase": [
        "angebotsphase",
        "anfrage erhalten",
        "angebot erstellen",
        "angebot abgeschickt",
        "kundentermin angefragt",
        "kundentermin vereinbart",
        "planning",
    ],
    "in_durchfuehrung": [
        "in_durchfuehrung",
        "in durchführung",
        "in durchfuehrung",
        "active",
        "aktiv",
        "auftrag angenommen",
        "on_hold",
        "pausiert",
        "rückfragen klären",
        "rueckfragen klaeren",
    ],
    "rechnung_verschickt": [
        "rechnung_verschickt",
        "rechnung verschickt",
        "rechnung erstellen",
        "rechnung gestellt",
    ],
    "abgeschlossen": ["abgeschlossen", "completed", "done", "fertig"],
}


def upgrade() -> None:
    connection = op.get_bind()
    projects = sa.table("projects", sa.column("id", sa.Integer), sa.column("status", sa.String))
    for canonical, synonyms in _MAPPING.items():
        connection.execute(
            projects.update()
            .where(sa.func.lower(sa.func.trim(projects.c.status)).in_(synonyms))
            .values(status=canonical)
        )


def downgrade() -> None:
    # Many-to-one; the original spread is gone by design.
    pass
