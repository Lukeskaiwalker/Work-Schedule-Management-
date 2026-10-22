"""
events.py - PostgreSQL LISTEN/NOTIFY helpers for SSE live updates.

Notify side: synchronous, runs inside existing SQLAlchemy transactions.
  pg_notify fires when the surrounding transaction commits.
  If the transaction rolls back, the notification is silently cancelled.

Listen side: async, one asyncpg LISTEN connection per api process, shared
  by every SSE client that process serves (ListenerHub). Filters events by
  the user's project memberships and thread visibility.
"""
from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import AsyncGenerator, Awaitable, Callable

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


# Put on a stream's queue when the shared connection is gone: the stream ends,
# and the browser's reconnect refetches the view it was showing.
_CONNECTION_LOST = object()
_HEARTBEAT_SECONDS = 25.0


class _Subscription:
    __slots__ = ("user_id", "queue")

    def __init__(self, user_id: int, queue_size: int) -> None:
        self.user_id = user_id
        self.queue: asyncio.Queue[object] = asyncio.Queue(maxsize=queue_size)


def _put_dropping_oldest(queue: asyncio.Queue[object], item: object) -> None:
    try:
        queue.put_nowait(item)
    except asyncio.QueueFull:
        queue.get_nowait()
        queue.put_nowait(item)


class ListenerHub:
    """One LISTEN connection per process, fanned out to every open stream.

    Each stream used to open its own asyncpg connection, outside the
    SQLAlchemy pool and outside any limit, so the api's share of Postgres's
    max_connections grew with every open tab, phone and kiosk. Sharing one
    makes the event stream cost exactly one connection per api worker (see
    app/core/db_pool.py). It is opened by the first stream and kept for the
    life of the process; when it is lost, every stream on it ends and the
    next stream opens a new one.
    """

    def __init__(
        self,
        connect: Callable[[str], Awaitable[asyncpg.Connection]] = asyncpg.connect,
        *,
        queue_size: int = 256,
    ) -> None:
        self._connect = connect
        self._queue_size = queue_size
        self._connection: asyncpg.Connection | None = None
        self._subscriptions: set[_Subscription] = set()
        self._lock = asyncio.Lock()

    @property
    def subscriber_count(self) -> int:
        return len(self._subscriptions)

    async def subscribe(self, dsn: str, user_id: int) -> _Subscription:
        async with self._lock:
            if self._connection is not None and self._connection.is_closed():
                # Closed, and asyncpg has not called back yet: end the streams
                # that were on it now, so none outlives its connection.
                self._on_terminated(self._connection)
            if self._connection is None:
                self._connection = await self._open(dsn)
            subscription = _Subscription(user_id, self._queue_size)
            self._subscriptions.add(subscription)
            return subscription

    def unsubscribe(self, subscription: _Subscription) -> None:
        # Synchronous on purpose: it runs in a stream's finally, where a
        # cancelled task cannot be relied on to complete an await.
        self._subscriptions.discard(subscription)

    async def _open(self, dsn: str) -> asyncpg.Connection:
        connection = await self._connect(dsn)
        try:
            connection.add_termination_listener(self._on_terminated)
            await connection.add_listener(_CHANNEL, self._on_notify)
        except BaseException:
            connection.terminate()
            raise
        return connection

    def _on_notify(self, connection: asyncpg.Connection, pid: int, channel: str, payload: str) -> None:
        del connection, pid, channel
        for subscription in tuple(self._subscriptions):
            try:
                subscription.queue.put_nowait(payload)
            except asyncio.QueueFull:
                logger.warning("SSE queue full for user %d; dropping event", subscription.user_id)

    def _on_terminated(self, connection: asyncpg.Connection) -> None:
        if connection is not self._connection:
            return  # an older connection, already replaced
        self._connection = None
        lost, self._subscriptions = self._subscriptions, set()
        for subscription in lost:
            _put_dropping_oldest(subscription.queue, _CONNECTION_LOST)
        logger.warning("SSE listener connection lost; ending %d stream(s) so they reconnect", len(lost))


_hub = ListenerHub()


async def listen_for_events(
    database_url: str,
    user_id: int,
    project_ids: set[int],
    thread_ids: set[int],
    is_admin: bool,
    *,
    hub: ListenerHub | None = None,
) -> AsyncGenerator[str, None]:
    """
    Listen on PostgreSQL NOTIFY and yield SSE formatted chunks.

    Rides on the process's shared LISTEN connection (ListenerHub).
    A heartbeat comment is emitted every 25 seconds.
    """
    hub = hub or _hub
    subscription = await hub.subscribe(_to_asyncpg_dsn(database_url), user_id)
    try:
        # Handshake event for the client.
        yield json.dumps({"type": "connected"})

        while True:
            try:
                raw = await asyncio.wait_for(subscription.queue.get(), timeout=_HEARTBEAT_SECONDS)
            except asyncio.TimeoutError:
                # App-level heartbeat payload (EventSourceResponse also emits ping comments).
                yield json.dumps({"type": "heartbeat"})
                continue

            if raw is _CONNECTION_LOST:
                return

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
        hub.unsubscribe(subscription)


def _should_deliver(
    event_type: str,
    data: dict,
    user_id: int,
    project_ids: set[int],
    thread_ids: set[int],
    is_admin: bool,
) -> bool:
    # Personal notifications are always filtered to one recipient — including
    # ``notification.resolved``, which tells that one user their panel lost an
    # entry (task completed or deleted). Checked before the admin short-circuit
    # on purpose: an admin must not receive other people's personal events.
    if event_type in {"notification.created", "notification.resolved"}:
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
