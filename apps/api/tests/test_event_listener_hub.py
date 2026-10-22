"""Every open event stream in a worker shares one LISTEN connection.

The stream used to open its own asyncpg connection per browser tab, outside
the SQLAlchemy pool and outside any limit: the number of Postgres connections
the api held grew with the number of open tabs, phones and Pi kiosks, and no
pool setting could bound it. One listener per process fans each notification
out to the streams of that process, so the event stream costs exactly one
connection per api worker however many tabs are open.

asyncpg is replaced by a fake connection: the tests are about the fan-out and
the connection's lifecycle, not about Postgres.
"""

from __future__ import annotations

import asyncio
import json

from app.core.events import ListenerHub, listen_for_events

DSN = "postgresql+psycopg2://smpl:smpl@db:5432/smpl"


class FakeConnection:
    def __init__(self) -> None:
        self.listeners: dict[str, list] = {}
        self.termination_listeners: list = []
        self.closed = False

    async def add_listener(self, channel: str, callback) -> None:
        self.listeners.setdefault(channel, []).append(callback)

    def add_termination_listener(self, callback) -> None:
        self.termination_listeners.append(callback)

    def is_closed(self) -> bool:
        return self.closed

    def terminate(self) -> None:
        self.closed = True

    def notify(self, event_type: str, data: dict) -> None:
        payload = json.dumps({"type": event_type, "data": data})
        for channel, callbacks in self.listeners.items():
            for callback in callbacks:
                callback(self, 4242, channel, payload)

    def drop(self) -> None:
        """The server went away (restart, network): asyncpg calls the
        termination listeners."""
        self.closed = True
        for callback in self.termination_listeners:
            callback(self)


class FakeConnector:
    def __init__(self) -> None:
        self.connections: list[FakeConnection] = []
        self.dsns: list[str] = []

    async def __call__(self, dsn: str) -> FakeConnection:
        self.dsns.append(dsn)
        connection = FakeConnection()
        self.connections.append(connection)
        return connection


def _stream(hub: ListenerHub, *, user_id: int, project_ids: set[int] | None = None, is_admin: bool = False):
    return listen_for_events(
        database_url=DSN,
        user_id=user_id,
        project_ids=project_ids or set(),
        thread_ids=set(),
        is_admin=is_admin,
        hub=hub,
    )


async def _next(stream) -> dict:
    return json.loads(await asyncio.wait_for(stream.__anext__(), timeout=1.0))


async def _ended(stream) -> bool:
    try:
        await asyncio.wait_for(stream.__anext__(), timeout=1.0)
    except StopAsyncIteration:
        return True
    return False


def test_streams_in_one_worker_share_a_single_listen_connection() -> None:
    async def scenario() -> None:
        connector = FakeConnector()
        hub = ListenerHub(connect=connector)
        streams = [_stream(hub, user_id=n, is_admin=True) for n in range(1, 6)]
        for stream in streams:
            assert (await _next(stream))["type"] == "connected"

        assert len(connector.connections) == 1
        # asyncpg is handed a DSN it understands, not SQLAlchemy's driver URL.
        assert connector.dsns == ["postgresql://smpl:smpl@db:5432/smpl"]
        for stream in streams:
            await stream.aclose()

    asyncio.run(scenario())


def test_a_notification_reaches_each_stream_it_is_meant_for() -> None:
    async def scenario() -> None:
        connector = FakeConnector()
        hub = ListenerHub(connect=connector)
        admin = _stream(hub, user_id=1, is_admin=True)
        member = _stream(hub, user_id=2, project_ids={7})
        assert (await _next(admin))["type"] == "connected"
        assert (await _next(member))["type"] == "connected"

        connection = connector.connections[0]
        connection.notify("task.updated", {"project_id": 8, "id": 1})
        connection.notify("task.updated", {"project_id": 7, "id": 2})

        assert (await _next(admin))["data"] == {"project_id": 8, "id": 1}
        assert (await _next(admin))["data"] == {"project_id": 7, "id": 2}
        # The member is not on project 8: the first event is filtered out.
        assert (await _next(member))["data"] == {"project_id": 7, "id": 2}
        await admin.aclose()
        await member.aclose()

    asyncio.run(scenario())


def test_a_closed_stream_leaves_the_connection_to_the_next_one() -> None:
    async def scenario() -> None:
        connector = FakeConnector()
        hub = ListenerHub(connect=connector)
        first = _stream(hub, user_id=1, is_admin=True)
        assert (await _next(first))["type"] == "connected"
        await first.aclose()
        assert hub.subscriber_count == 0

        second = _stream(hub, user_id=1, is_admin=True)
        assert (await _next(second))["type"] == "connected"
        assert len(connector.connections) == 1
        assert not connector.connections[0].closed

        # A notification after the first stream left reaches only the second.
        connector.connections[0].notify("task.updated", {"project_id": 3})
        assert (await _next(second))["data"] == {"project_id": 3}
        await second.aclose()

    asyncio.run(scenario())


def test_a_lost_connection_ends_every_stream_and_the_next_one_reconnects() -> None:
    """Ending the streams makes each browser reconnect and refetch its view,
    which covers whatever was sent while nobody was listening. Staying open
    would leave every tab silently deaf after a database restart."""

    async def scenario() -> None:
        connector = FakeConnector()
        hub = ListenerHub(connect=connector)
        streams = [_stream(hub, user_id=n, is_admin=True) for n in (1, 2)]
        for stream in streams:
            assert (await _next(stream))["type"] == "connected"

        connector.connections[0].drop()

        for stream in streams:
            assert await _ended(stream)
        assert hub.subscriber_count == 0

        again = _stream(hub, user_id=1, is_admin=True)
        assert (await _next(again))["type"] == "connected"
        assert len(connector.connections) == 2
        connector.connections[1].notify("task.updated", {"project_id": 1})
        assert (await _next(again))["data"] == {"project_id": 1}
        await again.aclose()

    asyncio.run(scenario())


def test_a_stream_that_cannot_keep_up_does_not_hold_up_the_others() -> None:
    async def scenario() -> None:
        connector = FakeConnector()
        hub = ListenerHub(connect=connector, queue_size=2)
        slow = _stream(hub, user_id=1, is_admin=True)
        fast = _stream(hub, user_id=2, is_admin=True)
        assert (await _next(slow))["type"] == "connected"
        assert (await _next(fast))["type"] == "connected"

        connection = connector.connections[0]
        for n in range(4):
            connection.notify("task.updated", {"project_id": n})
            assert (await _next(fast))["data"] == {"project_id": n}

        # The slow stream kept what fit and dropped the rest.
        assert (await _next(slow))["data"] == {"project_id": 0}
        assert (await _next(slow))["data"] == {"project_id": 1}
        await slow.aclose()
        await fast.aclose()

    asyncio.run(scenario())
