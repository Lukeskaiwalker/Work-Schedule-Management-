"""
events.py - PostgreSQL LISTEN/NOTIFY helpers for SSE live updates.

Notify side: synchronous, runs inside existing SQLAlchemy transactions.
  pg_notify fires when the surrounding transaction commits.
  If the transaction rolls back, the notification is silently cancelled.

Listen side: async, one asyncpg connection per connected SSE client.
  Filters events by the user's project memberships and thread visibility.
"""
from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import AsyncGenerator

import asyncpg
from sqlalchemy import text
from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

_CHANNEL = "smpl_updates"


def notify(db: Session, event_type: str, payload: dict) -> None:
    """
    Fire a PostgreSQL NOTIFY within the current SQLAlchemy session.

    Call this after the data mutation commit. This function executes
    pg_notify in a fresh implicit transaction and commits it.
    Failures are logged and swallowed so they never break API responses.
    """
    message = json.dumps({"type": event_type, "data": payload}, default=str)
    try:
        bind = db.get_bind()
        if bind is None or bind.dialect.name != "postgresql":
            return
        db.execute(
            text("SELECT pg_notify(:channel, :msg)"),
            {"channel": _CHANNEL, "msg": message},
        )
        db.commit()
    except Exception:
        logger.exception("Failed to fire pg_notify for event %s", event_type)
        try:
            db.rollback()
        except Exception:
            pass


def _to_asyncpg_dsn(sqlalchemy_url: str) -> str:
    """
    Convert a SQLAlchemy database URL to one asyncpg understands.

    Example:
      'postgresql+psycopg2://user:pw@host/db' -> 'postgresql://user:pw@host/db'
    """
    url = sqlalchemy_url
    for prefix in ("postgresql+psycopg2", "postgresql+asyncpg", "postgres+psycopg2"):
        if url.startswith(prefix):
            url = "postgresql" + url[len(prefix):]
            break
    return url


async def listen_for_events(
    database_url: str,
    user_id: int,
    project_ids: set[int],
    thread_ids: set[int],
    is_admin: bool,
) -> AsyncGenerator[str, None]:
    """
    Listen on PostgreSQL NOTIFY and yield SSE formatted chunks.

    One asyncpg connection is opened per connected SSE client.
    A heartbeat comment is emitted every 25 seconds.
    """
    dsn = _to_asyncpg_dsn(database_url)
    queue: asyncio.Queue[str] = asyncio.Queue(maxsize=256)

    def _on_notify(
        connection: asyncpg.Connection,
        pid: int,
        channel: str,
        payload: str,
    ) -> None:
        del connection, pid, channel
        try:
            queue.put_nowait(payload)
        except asyncio.QueueFull:
            logger.warning("SSE queue full for user %d; dropping event", user_id)

    conn = await asyncpg.connect(dsn)
    await conn.add_listener(_CHANNEL, _on_notify)

    try:
        # Handshake event for the client.
        yield json.dumps({"type": "connected"})

        while True:
            try:
                raw = await asyncio.wait_for(queue.get(), timeout=25.0)
            except asyncio.TimeoutError:
                # App-level heartbeat payload (EventSourceResponse also emits ping comments).
                yield json.dumps({"type": "heartbeat"})
                continue

            try:
                event = json.loads(raw)
            except json.JSONDecodeError:
                continue

            event_type = str(event.get("type") or "")
            data_raw = event.get("data")
            data = data_raw if isinstance(data_raw, dict) else {}

            if _should_deliver(event_type, data, user_id, project_ids, thread_ids, is_admin):
                yield raw

    finally:
        try:
            await conn.remove_listener(_CHANNEL, _on_notify)
            await conn.close()
        except Exception:
            logger.exception("Error closing SSE listener for user %d", user_id)


def _should_deliver(
    event_type: str,
    data: dict,
    user_id: int,
    project_ids: set[int],
    thread_ids: set[int],
    is_admin: bool,
) -> bool:
    # Personal notifications are always filtered to one recipient.
    if event_type == "notification.created":
        return data.get("user_id") == user_id

    if is_admin:
        return True

    # Project-scoped events.
    if event_type.startswith(("task.", "project.", "material.", "site.", "report.", "file.")):
        project_id = data.get("project_id")
        return project_id in project_ids if project_id is not None else False

    # Thread/message events.
    if event_type.startswith("message."):
        thread_id = data.get("thread_id")
        return thread_id in thread_ids if thread_id is not None else False

    if event_type.startswith("thread."):
        thread_id = data.get("id") or data.get("thread_id")
        return thread_id in thread_ids if thread_id is not None else False

    return False
