"""Migration 0084's data step, executed against hand-built rows.

The suite builds its schema with `Base.metadata.create_all` on SQLite, so a
migration's DDL is restated by the models and needs no test — but the step
that sets ``order_channel = 'ids'`` for every supplier with an enabled shop
connection exists only in the migration. Untested, it is a sentence in a
docstring; this drives the real `upgrade()` the way
test_ids_connection_repair_migrations.py does.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest
import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations

VERSIONS = Path(__file__).resolve().parents[1] / "alembic" / "versions"
MIGRATION = "20260918_0084_werkstatt_supplier_order_identifier.py"


def _load(filename: str):
    spec = importlib.util.spec_from_file_location(filename, VERSIONS / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture()
def engine(tmp_path: Path):
    """The two tables as they stood at 0083: no channel column yet."""

    engine = sa.create_engine(f"sqlite:///{tmp_path}/suppliers.db")
    with engine.begin() as conn:
        conn.execute(
            sa.text("CREATE TABLE werkstatt_suppliers (id INTEGER PRIMARY KEY, name VARCHAR(160))")
        )
        conn.execute(
            sa.text(
                """CREATE TABLE werkstatt_ids_connections (
                    id INTEGER PRIMARY KEY,
                    supplier_id INTEGER NOT NULL,
                    is_enabled BOOLEAN NOT NULL)"""
            )
        )
        conn.execute(
            sa.text("INSERT INTO werkstatt_suppliers (id, name) VALUES (1, 'Unielektro'), (2, 'Sonepar'), (3, 'Rexel')")
        )
        conn.execute(
            sa.text(
                "INSERT INTO werkstatt_ids_connections (id, supplier_id, is_enabled) "
                "VALUES (10, 1, 1), (11, 2, 0)"
            )
        )
    return engine


def _run(engine, module) -> None:
    with engine.connect() as conn:
        context = MigrationContext.configure(conn)
        with context.begin_transaction():
            with Operations.context(context):
                module.upgrade()
        conn.commit()


def _channels(engine) -> dict[str, tuple[str, str]]:
    with engine.connect() as conn:
        rows = conn.execute(
            sa.text("SELECT name, order_channel, order_identifier FROM werkstatt_suppliers")
        ).all()
    return {name: (channel, identifier) for name, channel, identifier in rows}


def test_0084_marks_suppliers_with_an_enabled_connection_as_shop_suppliers(engine) -> None:
    _run(engine, _load(MIGRATION))

    channels = _channels(engine)
    assert channels["Unielektro"] == ("ids", "supplier_no")
    assert channels["Sonepar"] == ("manual", "supplier_no"), "a disabled connection is no shop"
    assert channels["Rexel"] == ("manual", "supplier_no")
