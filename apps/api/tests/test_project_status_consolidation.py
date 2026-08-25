"""The 4-status project funnel: normalization, defaults, and the migration.

The consolidation has three legs and each is pinned separately, because each
fails differently:

  * the WRITE paths heal known legacy statuses (otherwise the 13-value zoo
    regrows the first time an old client or spreadsheet writes);
  * the DEFAULTS put a new project at the top of the funnel;
  * the MIGRATION converts what already exists — executed here against real
    rows, since the suite's SQLite schema never runs alembic on its own.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations
from fastapi.testclient import TestClient

from app.services.project_status import normalize_project_status


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


# ──────────────────────────────────────────────────────────────────────────
# Normalization unit behaviour
# ──────────────────────────────────────────────────────────────────────────


def test_every_legacy_preset_lands_on_its_funnel_stage() -> None:
    cases = {
        "Anfrage erhalten": "angebotsphase",
        "Angebot erstellen": "angebotsphase",
        "Angebot abgeschickt": "angebotsphase",
        "Kundentermin angefragt": "angebotsphase",
        "Kundentermin vereinbart": "angebotsphase",
        "active": "in_durchfuehrung",
        "Aktiv": "in_durchfuehrung",
        "In Durchführung": "in_durchfuehrung",
        "Auftrag angenommen": "in_durchfuehrung",
        "on_hold": "in_durchfuehrung",
        "Rückfragen klären": "in_durchfuehrung",
        "Rechnung erstellen": "rechnung_verschickt",
        "completed": "abgeschlossen",
    }
    for raw, expected in cases.items():
        assert normalize_project_status(raw) == expected, raw


def test_archive_and_unknown_text_pass_through() -> None:
    # The archive is not a funnel stage, and unknown import text is
    # information — both must survive normalization byte-for-byte.
    assert normalize_project_status("archived") == "archived"
    assert normalize_project_status("archiviert") == "archiviert"
    assert normalize_project_status("Sonderprojekt Messe") == "Sonderprojekt Messe"
    assert normalize_project_status("") == ""
    assert normalize_project_status(None) == ""


# ──────────────────────────────────────────────────────────────────────────
# Write paths
# ──────────────────────────────────────────────────────────────────────────


def test_create_heals_a_legacy_status_and_defaults_to_angebotsphase(
    client: TestClient, admin_token: str
) -> None:
    healed = client.post(
        "/api/projects",
        headers=_auth(admin_token),
        json={"project_number": "STAT-1", "name": "Alt-Client", "status": "active"},
    )
    assert healed.status_code == 200, healed.text
    assert healed.json()["status"] == "in_durchfuehrung"

    # No status at all → top of the funnel, not the old "active".
    fresh = client.post(
        "/api/projects",
        headers=_auth(admin_token),
        json={"project_number": "STAT-2", "name": "Neu"},
    )
    assert fresh.status_code == 200, fresh.text
    assert fresh.json()["status"] == "angebotsphase"


def test_update_heals_but_archive_still_works(client: TestClient, admin_token: str) -> None:
    created = client.post(
        "/api/projects",
        headers=_auth(admin_token),
        json={"project_number": "STAT-3", "name": "Wechsel", "status": "angebotsphase"},
    )
    pid = created.json()["id"]

    moved = client.patch(
        f"/api/projects/{pid}",
        headers=_auth(admin_token),
        json={"status": "Rechnung erstellen"},
    )
    assert moved.status_code == 200, moved.text
    assert moved.json()["status"] == "rechnung_verschickt"

    # Archiving must be untouched by normalization — the archive view and
    # _is_project_archived depend on the literal value.
    archived = client.patch(
        f"/api/projects/{pid}", headers=_auth(admin_token), json={"status": "archived"}
    )
    assert archived.status_code == 200, archived.text
    assert archived.json()["status"] == "archived"


# ──────────────────────────────────────────────────────────────────────────
# Migration 0073, executed against real rows
# ──────────────────────────────────────────────────────────────────────────


def test_migration_converts_legacy_rows_and_spares_archive_and_unknown(tmp_path: Path) -> None:
    engine = sa.create_engine(f"sqlite:///{tmp_path}/status.db")
    with engine.begin() as conn:
        conn.execute(sa.text("CREATE TABLE projects (id INTEGER PRIMARY KEY, status VARCHAR(64))"))
        rows = [
            (1, "active"),
            (2, "In Durchführung"),
            (3, "  Angebot abgeschickt  "),  # whitespace survives trimming
            (4, "Rechnung erstellen"),
            (5, "completed"),
            (6, "archived"),
            (7, "Sonderprojekt Messe"),
            (8, "on_hold"),
        ]
        for row_id, status_value in rows:
            conn.execute(
                sa.text("INSERT INTO projects (id, status) VALUES (:i, :s)"),
                {"i": row_id, "s": status_value},
            )

    versions = Path(__file__).resolve().parents[1] / "alembic" / "versions"
    spec = importlib.util.spec_from_file_location(
        "m0073", versions / "20260817_0073_project_status_consolidation.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    with engine.connect() as conn:
        context = MigrationContext.configure(conn)
        with context.begin_transaction():
            with Operations.context(context):
                module.upgrade()
        conn.commit()

    with engine.connect() as conn:
        result = dict(conn.execute(sa.text("SELECT id, status FROM projects")).fetchall())

    assert result[1] == "in_durchfuehrung"
    assert result[2] == "in_durchfuehrung"
    assert result[3] == "angebotsphase"
    assert result[4] == "rechnung_verschickt"
    assert result[5] == "abgeschlossen"
    assert result[6] == "archived", "the archive is not a funnel stage"
    assert result[7] == "Sonderprojekt Messe", "unknown text is information"
    assert result[8] == "in_durchfuehrung"
