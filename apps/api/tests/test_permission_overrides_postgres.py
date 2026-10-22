"""Permission saves under real concurrency, on PostgreSQL.

SQLite serialises every writer by itself, so the row lock that keeps two
admins' saves from overwriting each other is only exercised here. Opt in with
a THROWAWAY database (it is migrated to head and its permission rows are
deleted between tests):

    docker run -d --rm --name smpl-perm-check -e POSTGRES_USER=smpl \\
      -e POSTGRES_PASSWORD=<random> -e POSTGRES_DB=smpl \\
      -p 127.0.0.1:55498:5432 postgres:16-alpine
    TEST_POSTGRES_URL=postgresql+psycopg2://smpl:<random>@127.0.0.1:55498/smpl \\
      python -m pytest tests/test_permission_overrides_postgres.py

Skipped without TEST_POSTGRES_URL.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
from collections.abc import Generator
from pathlib import Path

import pytest
from sqlalchemy import create_engine, delete, select
from sqlalchemy.orm import Session, sessionmaker

from app.core import permissions
from app.models.entities import AppSetting
from app.services.permission_store import (
    PERMISSIONS_REVISION_KEY,
    ROLE_PERMISSIONS_KEY,
    USER_PERMISSIONS_KEY,
    refresh_permissions_if_changed,
    save_role_permissions,
    save_user_permissions_to_db,
)

PG_URL = os.environ.get("TEST_POSTGRES_URL", "")
API_ROOT = Path(__file__).resolve().parents[1]

pytestmark = pytest.mark.skipif(
    not PG_URL.startswith("postgresql"),
    reason="set TEST_POSTGRES_URL to a throwaway PostgreSQL database",
)


@pytest.fixture(scope="module")
def pg_factory() -> Generator[sessionmaker[Session], None, None]:
    # alembic/env.py takes its URL from the settings, which conftest pins to
    # SQLite in this process -- migrate from a child with its own environment.
    subprocess.run(
        [sys.executable, "-m", "alembic", "upgrade", "head"],
        cwd=API_ROOT,
        env={**os.environ, "DATABASE_URL": PG_URL},
        check=True,
        capture_output=True,
    )
    engine = create_engine(PG_URL, pool_size=10)
    yield sessionmaker(bind=engine, autoflush=False, autocommit=False, class_=Session)
    engine.dispose()


@pytest.fixture
def pg(pg_factory: sessionmaker[Session]) -> Generator[sessionmaker[Session], None, None]:
    keys = (PERMISSIONS_REVISION_KEY, ROLE_PERMISSIONS_KEY, USER_PERMISSIONS_KEY)
    with pg_factory() as db:
        db.execute(delete(AppSetting).where(AppSetting.key.in_(keys)))
        db.commit()
    yield pg_factory
    permissions.clear_permission_cache()


def _stored(factory: sessionmaker[Session], key: str) -> dict:
    with factory() as db:
        raw = db.execute(select(AppSetting.value).where(AppSetting.key == key)).scalar_one_or_none()
    return json.loads(raw) if raw else {}


def _hold_permission_lock(factory: sessionmaker[Session]) -> Session:
    """Take the permission write lock the way a writer does, and keep it."""
    holder = factory()
    locked = holder.execute(
        select(AppSetting).where(AppSetting.key == PERMISSIONS_REVISION_KEY).with_for_update()
    ).scalar_one()
    assert locked is not None
    return holder


def _in_thread(target) -> tuple[threading.Thread, threading.Event, list[BaseException]]:
    done, errors = threading.Event(), []

    def run() -> None:
        try:
            target()
        except BaseException as exc:  # noqa: BLE001 -- surfaced by the test
            errors.append(exc)
        finally:
            done.set()

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    return thread, done, errors


def test_a_user_save_waits_for_the_lock_and_builds_on_the_committed_row(pg) -> None:
    with pg() as db:
        save_user_permissions_to_db(db, 1, [], ["wiki:view"])

    holder = _hold_permission_lock(pg)
    row = holder.get(AppSetting, USER_PERMISSIONS_KEY)
    row.value = json.dumps({**json.loads(row.value), "2": {"extra": [], "denied": ["finance:view"]}})
    holder.flush()

    def other_admin() -> None:
        with pg() as db:
            save_user_permissions_to_db(db, 3, ["finance:manage"], [])

    thread, done, errors = _in_thread(other_admin)
    assert not done.wait(0.5), "the save went ahead while another writer held the lock"
    holder.commit()
    holder.close()
    thread.join(10)
    assert done.is_set() and not errors, errors

    assert _stored(pg, USER_PERMISSIONS_KEY) == {
        "1": {"extra": [], "denied": ["wiki:view"]},
        "2": {"extra": [], "denied": ["finance:view"]},
        "3": {"extra": ["finance:manage"], "denied": []},
    }


def test_a_role_save_waits_for_the_lock_and_builds_on_the_committed_row(pg) -> None:
    with pg() as db:
        save_role_permissions(db, "accountant", sorted(permissions.PERMISSIONS_BY_ROLE["accountant"]))

    ceo = sorted(permissions.PERMISSIONS_BY_ROLE["ceo"] - {"finance:manage"})
    holder = _hold_permission_lock(pg)
    row = holder.get(AppSetting, ROLE_PERMISSIONS_KEY)
    row.value = json.dumps({**json.loads(row.value), "ceo": ceo})
    holder.flush()

    planning = sorted(permissions.PERMISSIONS_BY_ROLE["planning"] | {"finance:view"})

    def other_admin() -> None:
        with pg() as db:
            save_role_permissions(db, "planning", planning)

    thread, done, errors = _in_thread(other_admin)
    assert not done.wait(0.5), "the save went ahead while another writer held the lock"
    holder.commit()
    holder.close()
    thread.join(10)
    assert done.is_set() and not errors, errors

    stored = _stored(pg, ROLE_PERMISSIONS_KEY)
    assert stored["ceo"] == ceo
    assert stored["planning"] == planning


def test_concurrent_saves_for_different_users_all_survive(pg) -> None:
    rounds = 15
    start = threading.Barrier(2)

    def admin(offset: int) -> None:
        for round_ in range(rounds):
            start.wait(timeout=10)
            # Each "admin" is another process: it never saw the other's saves.
            permissions.clear_permission_cache()
            with pg() as db:
                save_user_permissions_to_db(db, 100 + 2 * round_ + offset, [], ["wiki:view"])

    runs = [_in_thread(lambda offset=offset: admin(offset)) for offset in (0, 1)]
    for thread, done, errors in runs:
        thread.join(60)
        assert done.is_set() and not errors, errors

    stored = _stored(pg, USER_PERMISSIONS_KEY)
    assert sorted(int(user_id) for user_id in stored) == list(range(100, 100 + 2 * rounds))


def test_a_large_override_map_fits_and_reads_back(pg) -> None:
    """VARCHAR(2048) refused this at roughly 30-40 users with overrides."""
    with pg() as db:
        for user_id in range(1000, 1120):
            save_user_permissions_to_db(db, user_id, ["werkstatt:machines_create"], ["finance:view"])

    raw_length = len(json.dumps(_stored(pg, USER_PERMISSIONS_KEY)))
    assert raw_length > 2048 * 4

    permissions.clear_permission_cache()
    with pg() as db:
        refresh_permissions_if_changed(db)
    assert permissions.get_user_override(1119) == {"extra": ["werkstatt:machines_create"], "denied": ["finance:view"]}
    assert permissions.has_permission_for_user(1119, "employee", "finance:view") is False
