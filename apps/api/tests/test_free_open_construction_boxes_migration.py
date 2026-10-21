"""Migration 0102's data step, executed against hand-built rows.

The suite builds its schema with ``Base.metadata.create_all`` on SQLite, so a
data-only migration is never run by it. This drives the real ``upgrade()`` the
way tests/test_werkstatt_supplier_channel_migration.py does, against the one
table it touches.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest
import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations

VERSIONS = Path(__file__).resolve().parents[1] / "alembic" / "versions"
MIGRATION = "20261020_0102_free_open_construction_boxes.py"

# (id, box_number, status, customer_id, project_id)
ROWS = [
    (1, "K7", "offen", 18, None),  # production's K7: re-opened after a return
    (2, "BK-2026-0001", "offen", 90, 293),  # owner AND site left behind
    (3, "BK-2026-0002", "offen", None, 7),  # a project without a customer
    (4, "K3", "offen", None, None),  # already free — untouched
    (5, "K1", "gepackt", 169, 12),  # packed for somebody: keeps both
    (6, "K2", "zugewiesen", 60, None),  # on site: keeps its customer
    (7, "BK-2026-0003", "zurueck", 85, 40),  # history: keeps both
]


def _load(filename: str):
    spec = importlib.util.spec_from_file_location(filename, VERSIONS / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture()
def engine(tmp_path: Path):
    engine = sa.create_engine(f"sqlite:///{tmp_path}/boxes.db")
    with engine.begin() as conn:
        conn.execute(
            sa.text(
                """CREATE TABLE werkstatt_construction_boxes (
                    id INTEGER PRIMARY KEY,
                    box_number VARCHAR(32) NOT NULL,
                    status VARCHAR(32) NOT NULL,
                    customer_id INTEGER,
                    project_id INTEGER)"""
            )
        )
        for row in ROWS:
            conn.execute(
                sa.text(
                    "INSERT INTO werkstatt_construction_boxes "
                    "(id, box_number, status, customer_id, project_id) "
                    "VALUES (:id, :number, :status, :customer, :project)"
                ),
                dict(zip(("id", "number", "status", "customer", "project"), row)),
            )
    return engine


def _run(engine, step) -> None:
    with engine.connect() as conn:
        context = MigrationContext.configure(conn)
        with context.begin_transaction():
            with Operations.context(context):
                step()
        conn.commit()


def _owners(engine) -> dict[str, tuple[int | None, int | None]]:
    with engine.connect() as conn:
        rows = conn.execute(
            sa.text("SELECT box_number, customer_id, project_id FROM werkstatt_construction_boxes")
        ).all()
    return {number: (customer, project) for number, customer, project in rows}


def test_0102_frees_open_crates_and_leaves_every_other_status_alone(engine) -> None:
    module = _load(MIGRATION)
    assert module.down_revision == "20261010_0101"

    _run(engine, module.upgrade)

    owners = _owners(engine)
    assert owners["K7"] == (None, None)
    assert owners["BK-2026-0001"] == (None, None)
    assert owners["BK-2026-0002"] == (None, None)
    assert owners["K3"] == (None, None)
    assert owners["K1"] == (169, 12)
    assert owners["K2"] == (60, None)
    assert owners["BK-2026-0003"] == (85, 40)


def test_0102_is_safe_to_run_twice_and_its_downgrade_restores_nothing(engine) -> None:
    module = _load(MIGRATION)
    _run(engine, module.upgrade)
    _run(engine, module.upgrade)
    _run(engine, module.downgrade)

    owners = _owners(engine)
    assert owners["K7"] == (None, None), "the stale owner is not put back"
    assert owners["K1"] == (169, 12)
