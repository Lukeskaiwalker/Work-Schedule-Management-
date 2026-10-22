"""How many PostgreSQL connections the stack may hold, and the pool that keeps it there.

The server allows ``max_connections`` (100, the postgres:16 default), and
everything that talks to it shares that number: each uvicorn worker of the api
container with its own SQLAlchemy pool, the LISTEN connection behind each
worker's event streams, the api_worker container's pool, and whoever opens
psql, pg_dump or alembic. When the sum reaches the limit Postgres refuses the
next connection outright ("sorry, too many clients already") and the request
that asked for it fails with a 500 — on 2026-10-16, thirteen file previews of
one gallery page at once.

Waiting is better than failing: a pool that is full makes the next request
wait ``pool_timeout`` for a connection to come back, so the pools are sized to
fit the server, and a busy moment queues inside the process instead.

Kept free of side effects (no engine is built here) so the budget can be
checked from tests against the configuration that actually ships.
"""

from __future__ import annotations

from app.core.config import Settings

# app/core/events.py keeps one LISTEN connection per api process, shared by
# every event stream that process serves. It lives outside the pool.
LISTEN_CONNECTIONS_PER_API_WORKER = 1


def pool_ceiling(pool_size: int, max_overflow: int) -> int:
    """Most connections one process's pool can hold at the same time."""
    return pool_size + max_overflow


def api_connection_ceiling(*, workers: int, pool_size: int, max_overflow: int) -> int:
    """Most connections the api container can hold: every worker's pool, plus
    its event-stream listener.

    uvicorn 0.35 respawns a recycled worker (--limit-max-requests) only once
    the old process has exited (supervisors/multiprocess.py
    keep_subprocess_alive), so a recycle never runs two pools for one slot.
    """
    return workers * (pool_ceiling(pool_size, max_overflow) + LISTEN_CONNECTIONS_PER_API_WORKER)


def connection_budget_problem(settings: Settings) -> str | None:
    """Why the api's share does not fit under the server's limit, or None."""
    used = api_connection_ceiling(
        workers=settings.api_workers,
        pool_size=settings.db_pool_size,
        max_overflow=settings.db_max_overflow,
    )
    allowed = settings.db_max_connections - settings.db_reserved_connections
    if used <= allowed:
        return None
    return (
        f"PostgreSQL connection budget exceeded: API_WORKERS={settings.api_workers} × "
        f"(DB_POOL_SIZE={settings.db_pool_size} + DB_MAX_OVERFLOW={settings.db_max_overflow} "
        f"+ {LISTEN_CONNECTIONS_PER_API_WORKER} LISTEN) = {used} connections, but only {allowed} "
        f"of DB_MAX_CONNECTIONS={settings.db_max_connections} are left after "
        f"DB_RESERVED_CONNECTIONS={settings.db_reserved_connections}. A burst will be refused "
        f"by Postgres instead of queueing in the pool; shrink the pool or raise max_connections."
    )


def postgres_engine_kwargs(settings: Settings) -> dict[str, int | float]:
    """create_engine() pool arguments for this process."""
    return {
        "pool_size": settings.db_pool_size,
        "max_overflow": settings.db_max_overflow,
        "pool_timeout": settings.db_pool_timeout_seconds,
        "pool_recycle": settings.db_pool_recycle_seconds,
    }
