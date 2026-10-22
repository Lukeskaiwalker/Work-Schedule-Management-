"""The stack's PostgreSQL connections must fit under the server's max_connections.

On 2026-10-16 a page that opened a burst of file previews got thirteen 500s
with "FATAL: sorry, too many clients already". Each api worker's pool could
open 60 connections (20 + 40 overflow), two workers made 120 against a server
that allows 100, and every open browser tab held one more for the event
stream. These tests read the configuration that actually ships — the
committed .env.example layer, docker-compose.yml and the Dockerfile — so a
change to the worker count or a pool size that breaks the budget fails here
instead of under load in production.
"""

from __future__ import annotations

import re
from pathlib import Path

import yaml
from dotenv import dotenv_values

from app.core.config import Settings
from app.core.db_pool import (
    LISTEN_CONNECTIONS_PER_API_WORKER,
    api_connection_ceiling,
    connection_budget_problem,
    pool_ceiling,
    postgres_engine_kwargs,
)

API_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = API_ROOT.parents[1]

# What must stay free for everything besides the app: psql, pg_dump in
# scripts/backup.sh, a `docker compose run` alembic, Postgres's own
# superuser_reserved_connections (3 by default).
OPS_HEADROOM = 10
POSTGRES_DEFAULT_MAX_CONNECTIONS = 100

_BUDGET_KEYS = (
    "api_workers",
    "db_pool_size",
    "db_max_overflow",
    "db_max_connections",
    "db_reserved_connections",
)


def _compose() -> dict:
    return yaml.safe_load((REPO_ROOT / "docker-compose.yml").read_text())


def _effective_settings(service: str) -> Settings:
    """Settings as compose builds them for one service, minus the gitignored .env.

    Layering mirrors docker-compose.yml: .env.example is the first env_file,
    and a service's ``environment:`` wins over every env_file.
    """
    layered = {
        key.lower(): value
        for key, value in dotenv_values(API_ROOT / ".env.example").items()
        if value not in (None, "")
    }
    environment = _compose()["services"][service].get("environment") or {}
    layered.update({str(key).lower(): str(value) for key, value in environment.items()})
    return Settings(_env_file=None, **{key: layered[key] for key in _BUDGET_KEYS if key in layered})


def _postgres_max_connections() -> int:
    command = _compose()["services"]["db"].get("command") or []
    text = " ".join(command) if isinstance(command, list) else str(command)
    match = re.search(r"max_connections=(\d+)", text)
    return int(match.group(1)) if match else POSTGRES_DEFAULT_MAX_CONNECTIONS


def test_the_shipped_configuration_fits_postgres_with_headroom() -> None:
    api = _effective_settings("api")
    worker = _effective_settings("api_worker")
    server_max = _postgres_max_connections()

    assert api.db_max_connections == server_max, (
        "DB_MAX_CONNECTIONS must describe the server the stack runs against"
    )
    api_ceiling = api_connection_ceiling(
        workers=api.api_workers, pool_size=api.db_pool_size, max_overflow=api.db_max_overflow
    )
    worker_ceiling = pool_ceiling(worker.db_pool_size, worker.db_max_overflow)

    assert api_ceiling + worker_ceiling + OPS_HEADROOM <= server_max, (
        f"api {api_ceiling} + api_worker {worker_ceiling} + ops {OPS_HEADROOM} "
        f"exceeds max_connections={server_max}"
    )
    # The reserve the api checks itself against has to cover the worker
    # container and still leave room to open psql during an incident.
    assert worker_ceiling + OPS_HEADROOM <= api.db_reserved_connections
    assert connection_budget_problem(api) is None


def test_the_worker_container_keeps_a_small_pool_of_its_own() -> None:
    """The worker runs one job at a time; an api-sized pool there is waste."""

    worker = _effective_settings("api_worker")
    api = _effective_settings("api")
    assert pool_ceiling(worker.db_pool_size, worker.db_max_overflow) < pool_ceiling(
        api.db_pool_size, api.db_max_overflow
    )


def test_the_worker_count_the_budget_assumes_is_the_one_uvicorn_starts() -> None:
    """uvicorn reads ${API_WORKERS:-N} in the Dockerfile; the budget reads
    Settings.api_workers. A default that differs between them would budget
    for a stack that is not the one running."""

    dockerfile = (API_ROOT / "Dockerfile").read_text()
    match = re.search(r"--workers \$\{API_WORKERS:-(\d+)\}", dockerfile)
    assert match, "Dockerfile CMD no longer reads API_WORKERS"
    dockerfile_default = int(match.group(1))

    assert Settings.model_fields["api_workers"].default == dockerfile_default
    assert _effective_settings("api").api_workers == dockerfile_default


def test_the_sizing_of_the_incident_is_reported_as_over_budget() -> None:
    """20 + 40 per worker, two workers: the configuration that ran out."""

    problem = connection_budget_problem(
        Settings(_env_file=None, api_workers=2, db_pool_size=20, db_max_overflow=40)
    )
    assert problem is not None
    assert "122" in problem  # 2 × (20 + 40 + 1 LISTEN)


def test_adding_a_worker_without_shrinking_the_pool_is_reported() -> None:
    shipped = _effective_settings("api")
    problem = connection_budget_problem(
        Settings(
            _env_file=None,
            api_workers=shipped.api_workers + 2,
            db_pool_size=shipped.db_pool_size,
            db_max_overflow=shipped.db_max_overflow,
        )
    )
    assert problem is not None
    assert "API_WORKERS" in problem


def test_each_api_worker_counts_its_event_stream_listener() -> None:
    assert LISTEN_CONNECTIONS_PER_API_WORKER == 1
    assert api_connection_ceiling(workers=2, pool_size=5, max_overflow=5) == 2 * (5 + 5 + 1)


def test_the_engine_is_built_from_the_configured_pool() -> None:
    kwargs = postgres_engine_kwargs(
        Settings(
            _env_file=None,
            db_pool_size=7,
            db_max_overflow=3,
            db_pool_timeout_seconds=12,
            db_pool_recycle_seconds=600,
        )
    )
    assert kwargs == {"pool_size": 7, "max_overflow": 3, "pool_timeout": 12, "pool_recycle": 600}
