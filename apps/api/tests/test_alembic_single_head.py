"""Alembic must have exactly one head.

The api image runs ``alembic upgrade head`` before uvicorn starts. With two
heads Alembic refuses ("Multiple head revisions are present"), so the container
never comes up. Two branches can each add a migration on the same parent and
both pass their own suite — the suite builds its schema with ``create_all`` and
never runs Alembic — and the collision appears only when both are merged. This
is the cheap check that catches it on the merge commit.
"""

from __future__ import annotations

from pathlib import Path

from alembic.config import Config
from alembic.script import ScriptDirectory

API_ROOT = Path(__file__).resolve().parents[1]


def test_alembic_has_exactly_one_head() -> None:
    config = Config(str(API_ROOT / "alembic.ini"))
    config.set_main_option("script_location", str(API_ROOT / "alembic"))

    heads = ScriptDirectory.from_config(config).get_heads()

    assert len(heads) == 1, (
        f"Alembic has {len(heads)} heads {sorted(heads)}: re-point the newer "
        "migration's down_revision onto the other head."
    )
