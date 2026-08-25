"""Pairing against a SMPL server that does not exist yet.

The backend half of this is being written in parallel, so the thing actually
worth testing is not "does the happy path work" but "does every shape of
absence and disagreement degrade the way it promised". Hence a stub server
that can be told to answer like a canonical RFC 8628 implementation, like a
plausible FastAPI route with different field names, or like a server that has
never heard of pairing at all.

The stub binds port 0 - the operating system picks a free port - so these
tests never collide with a running agent.
"""

from __future__ import annotations

import json
import os
import stat
import sys
import tempfile
import threading
import unittest
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

import pairing  # noqa: E402


class StubSmpl:
    """A SMPL server with a scripted opinion about pairing."""

    def __init__(self, routes, *, form_only=()) -> None:
        self.routes = routes            # path -> callable(payload, hit_count) -> (status, body)
        self.form_only = set(form_only)  # paths that reject JSON with a 422
        self.hits = {}
        self.bodies = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args):  # silence the test output
                pass

            def do_POST(self):  # noqa: N802
                path = urllib.parse.urlparse(self.path).path
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length) if length else b""
                content_type = self.headers.get("Content-Type", "")

                if path in outer.form_only and content_type.startswith("application/json"):
                    return self._reply(422, {"detail": "expected form fields"})

                if content_type.startswith("application/json"):
                    try:
                        payload = json.loads(raw.decode("utf-8"))
                    except ValueError:
                        payload = {}
                else:
                    payload = {k: v[0] for k, v in
                               urllib.parse.parse_qs(raw.decode("utf-8")).items()}
                outer.bodies.append((path, payload, content_type))

                handler = outer.routes.get(path)
                if handler is None:
                    return self._reply(404, {"detail": "Not Found"})
                outer.hits[path] = outer.hits.get(path, 0) + 1
                status, body = handler(payload, outer.hits[path])
                return self._reply(status, body)

            def _reply(self, status, body):
                raw = json.dumps(body).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._server.daemon_threads = True
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()

    @property
    def base_url(self) -> str:
        host, port = self._server.server_address[:2]
        return "http://%s:%d" % (host, port)

    def close(self) -> None:
        self._server.shutdown()
        self._server.server_close()


def canonical_start(_payload, _hit):
    return 200, {
        "device_code": "dev-secret-abc",
        "user_code": "WERK-4711",
        "verification_uri": "https://smpl.example.de/station/pair",
        "expires_in": 900,
        "interval": 1,
    }


class TestPairingStart(unittest.TestCase):
    def tearDown(self) -> None:
        server = getattr(self, "server", None)
        if server:
            server.close()

    def start(self, client):
        return client.start(device_name="Werkstatt-Station", device_id="station-abc",
                            agent_version="test")

    def test_canonical_response_is_read(self):
        self.server = StubSmpl({"/api/station/pair/start": canonical_start})
        client = pairing.PairingClient(self.server.base_url)
        request = self.start(client)
        self.assertEqual(request.user_code, "WERK-4711")
        self.assertEqual(request.device_code, "dev-secret-abc")
        self.assertEqual(request.interval, 1.0)
        self.assertFalse(request.expired)

    def test_alternative_field_names_and_path_still_work(self):
        """The backend agent may not spell any of this the way we guessed."""
        def alias_start(_payload, _hit):
            return 200, {
                "data": {
                    "poll_token": "opaque-poll-key",
                    "display_code": "AB12-CD34",
                    "approve_url": "https://smpl.example.de/admin/stations",
                    "ttl": 600,
                    "poll_interval": 2,
                }
            }
        self.server = StubSmpl({"/api/station/pairing/start": alias_start})
        client = pairing.PairingClient(self.server.base_url)
        request = self.start(client)
        self.assertEqual(request.user_code, "AB12-CD34")
        self.assertEqual(request.device_code, "opaque-poll-key")
        self.assertIn("admin/stations", request.verification_uri)
        self.assertEqual(request.interval, 2.0)

    def test_a_single_code_is_used_for_both_halves(self):
        """Some designs poll with the same code the user types.

        Weaker than RFC 8628 - the code an admin can read off a screen is then
        also the code that collects the token - but workable, and refusing to
        pair at all would be a worse answer than supporting it.
        """
        self.server = StubSmpl({
            "/api/station/pair/start": lambda _p, _h: (
                200, {"user_code": "WERK-4711", "expires_in": 300}
            )
        })
        client = pairing.PairingClient(self.server.base_url)
        request = self.start(client)
        self.assertEqual(request.user_code, "WERK-4711")
        self.assertEqual(request.device_code, "WERK-4711")
        # And a verification URL is synthesised so the screen still says where
        # to go rather than showing a bare code with no instruction.
        self.assertTrue(request.verification_uri.startswith(self.server.base_url))

    def test_a_server_without_pairing_degrades_rather_than_erroring(self):
        self.server = StubSmpl({})
        client = pairing.PairingClient(self.server.base_url)
        with self.assertRaises(pairing.PairingUnavailable):
            self.start(client)

    def test_a_form_only_route_is_retried_as_a_form(self):
        self.server = StubSmpl({"/api/station/pair/start": canonical_start},
                               form_only=["/api/station/pair/start"])
        client = pairing.PairingClient(self.server.base_url)
        request = self.start(client)
        self.assertEqual(request.user_code, "WERK-4711")
        content_types = [c for _p, _b, c in self.server.bodies]
        self.assertTrue(any(c.startswith("application/x-www-form-urlencoded")
                            for c in content_types))

    def test_the_station_identifies_itself(self):
        self.server = StubSmpl({"/api/station/pair/start": canonical_start})
        client = pairing.PairingClient(self.server.base_url)
        self.start(client)
        _path, payload, _ct = self.server.bodies[-1]
        self.assertEqual(payload["device_id"], "station-abc")
        self.assertEqual(payload["device_name"], "Werkstatt-Station")

    def test_an_unreachable_server_is_an_error_not_a_missing_capability(self):
        # Nothing is listening on this port; the distinction matters because
        # "SMPL has no pairing" and "the network is down" need different fixes.
        client = pairing.PairingClient("http://127.0.0.1:9")
        with self.assertRaises(pairing.PairingError) as caught:
            self.start(client)
        self.assertNotIsInstance(caught.exception, pairing.PairingUnavailable)

    def test_no_url_configured_is_unavailable(self):
        client = pairing.PairingClient("")
        self.assertFalse(client.configured)
        with self.assertRaises(pairing.PairingUnavailable):
            self.start(client)


class TestPairingPoll(unittest.TestCase):
    def tearDown(self) -> None:
        server = getattr(self, "server", None)
        if server:
            server.close()

    def build(self, poll_handler, poll_path="/api/station/pair/poll"):
        self.server = StubSmpl({
            "/api/station/pair/start": canonical_start,
            poll_path: poll_handler,
        })
        client = pairing.PairingClient(self.server.base_url)
        request = client.start(device_name="s", device_id="d")
        return client, request

    def test_rfc_pending_then_granted(self):
        def poll(_payload, hit):
            if hit < 3:
                return 400, {"error": "authorization_pending"}
            return 200, {"access_token": "long-lived-token", "expires_in": 31536000,
                         "scope": "werkstatt station"}
        client, request = self.build(poll)
        self.assertIsNone(client.poll(request))
        self.assertIsNone(client.poll(request))
        token = client.poll(request)
        self.assertIsNotNone(token)
        self.assertEqual(token.token, "long-lived-token")
        self.assertEqual(token.scopes, ["werkstatt", "station"])
        self.assertTrue(token.expires_at)
        self.assertFalse(token.expired)

    def test_plain_status_words_are_understood_too(self):
        def poll(_payload, hit):
            if hit < 2:
                return 200, {"status": "pending"}
            return 200, {"status": "approved", "token": "tok", "label": "Werkstatt-Station"}
        client, request = self.build(poll)
        self.assertIsNone(client.poll(request))
        token = client.poll(request)
        self.assertEqual(token.token, "tok")
        self.assertEqual(token.label, "Werkstatt-Station")

    def test_denied_raises_denied(self):
        client, request = self.build(lambda _p, _h: (200, {"status": "access_denied"}))
        with self.assertRaises(pairing.PairingDenied):
            client.poll(request)

    def test_expired_raises_expired(self):
        client, request = self.build(lambda _p, _h: (410, {"detail": "gone"}))
        with self.assertRaises(pairing.PairingExpired):
            client.poll(request)

    def test_a_server_error_is_treated_as_keep_waiting(self):
        # A restarting SMPL should not throw away a code an admin is about to
        # approve.
        client, request = self.build(lambda _p, _h: (503, {"detail": "restarting"}))
        self.assertIsNone(client.poll(request))

    def test_an_unrecognised_200_is_treated_as_pending(self):
        client, request = self.build(lambda _p, _h: (200, {"something": "else"}))
        self.assertIsNone(client.poll(request))

    def test_the_device_code_is_sent_back(self):
        client, request = self.build(lambda _p, _h: (200, {"status": "pending"}))
        client.poll(request)
        _path, payload, _ct = self.server.bodies[-1]
        self.assertEqual(payload["device_code"], "dev-secret-abc")

    def test_an_absolute_poll_url_on_another_host_is_not_followed(self):
        """A redirect to somebody else's server is how a token leaves the building."""
        self.assertEqual(pairing._relative("https://evil.example/collect", "http://smpl"), "")
        self.assertEqual(pairing._relative("http://smpl/api/x", "http://smpl"), "/api/x")
        self.assertEqual(pairing._relative("/api/y", "http://smpl"), "/api/y")


class TestRealSmplContract(unittest.TestCase):
    """Against the exact shapes SMPL's own station router returns.

    The two halves of this handshake were written in parallel by two people
    who could not see each other's code, so these are the tests that prove
    they actually met. The payloads below are transcribed from
    ``apps/api/app/schemas/station.py`` - ``StationPairStartOut`` and
    ``StationPairPollOut`` - not from what this client hoped for.
    """

    def tearDown(self) -> None:
        server = getattr(self, "server", None)
        if server:
            server.close()

    START = {
        "user_code": "K7QP-2M4X",
        "device_token": "a" * 64,
        "device_code": "a" * 64,
        "expires_at": "2026-08-26T09:45:00Z",
        "expires_in": 900,
        "poll_interval": 5,
        "interval": 5,
    }

    def build(self, poll_handler):
        self.server = StubSmpl({
            "/api/station/pair/start": lambda _p, _h: (201, self.START),
            "/api/station/pair/poll": poll_handler,
        })
        client = pairing.PairingClient(self.server.base_url)
        request = client.start(device_name="smpl-station", device_id="station-abc",
                               agent_version="1.0.0")
        return client, request

    def test_start_is_read_from_the_real_response(self):
        client, request = self.build(lambda _p, _h: (200, {"status": "pending"}))
        self.assertEqual(request.user_code, "K7QP-2M4X")
        self.assertEqual(request.device_code, "a" * 64)
        self.assertEqual(request.interval, 5.0)
        # The absolute expires_at wins over the relative expires_in: the
        # server's clock is the one that decides when the code dies, and a
        # station whose clock has drifted must not shorten or extend it.
        self.assertEqual(request.expires_at.isoformat(), "2026-08-26T09:45:00+00:00")
        # 201 Created is a success, not "try the next candidate path".
        self.assertEqual(client._start_path, "/api/station/pair/start")

    def test_the_hint_smpl_reads_is_actually_sent(self):
        """SMPL shows device_hint next to the code so an admin knows what
        they are approving. It aliases device_name; we must send one of them."""
        self.build(lambda _p, _h: (200, {"status": "pending"}))
        _path, payload, _ct = self.server.bodies[0]
        self.assertIn(payload.get("device_name") or payload.get("device_hint"),
                      ("smpl-station",))
        self.assertEqual(payload["agent_version"], "1.0.0")

    def test_poll_sends_a_key_smpl_accepts(self):
        """StationPairPollRequest takes device_token, aliased to device_code."""
        client, request = self.build(lambda _p, _h: (200, {"status": "pending"}))
        client.poll(request)
        _path, payload, _ct = self.server.bodies[-1]
        self.assertTrue(payload.get("device_token") or payload.get("device_code"))

    def test_approved_yields_the_token(self):
        approved = {
            "status": "approved",
            "token": "smpl_station_" + "b" * 40,
            "station": {"id": 3, "name": "Werkstatt-Station", "prefix": "smpl_station_bbbb",
                        "created_at": "2026-08-26T09:31:00Z", "hardware_status": {},
                        "active": True},
            "poll_interval": 5,
            "message": None,
        }
        client, request = self.build(lambda _p, _h: (200, approved))
        token = client.poll(request)
        self.assertIsNotNone(token)
        self.assertTrue(token.token.startswith("smpl_station_"))

    def test_every_documented_status_is_understood(self):
        cases = {
            "pending": None,
            "denied": pairing.PairingDenied,
            "expired": pairing.PairingExpired,
            "claimed": pairing.PairingExpired,
        }
        for status, expected in cases.items():
            with self.subTest(status=status):
                client, request = self.build(
                    lambda _p, _h, _s=status: (200, {"status": _s, "poll_interval": 5})
                )
                if expected is None:
                    self.assertIsNone(client.poll(request))
                else:
                    with self.assertRaises(expected):
                        client.poll(request)
                self.server.close()
                self.server = None

    def test_claimed_is_not_mistaken_for_pending(self):
        """The regression that would hang a station forever."""
        client, request = self.build(lambda _p, _h: (200, {"status": "claimed"}))
        with self.assertRaises(pairing.PairingExpired) as caught:
            client.poll(request)
        self.assertIn("already collected", str(caught.exception))

    def test_being_rate_limited_slows_down_instead_of_erroring(self):
        """SMPL answers 429 when polled faster than poll_interval."""
        client, request = self.build(
            lambda _p, _h: (429, {"detail": "poll no faster than every 5s"})
        )
        self.assertIsNone(client.poll(request), "429 must read as 'not yet', not as failure")
        self.assertGreaterEqual(client.interval_hint or 0, request.interval)

    def test_a_changed_poll_interval_is_adopted(self):
        client, request = self.build(lambda _p, _h: (200, {"status": "pending",
                                                          "poll_interval": 11}))
        client.poll(request)
        self.assertEqual(client.interval_hint, 11.0)


class TestTokenStore(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "station-token.json"
        self.store = pairing.TokenStore(self.path)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def token(self, **kwargs):
        base = dict(token="secret", base_url="https://smpl.example.de",
                    obtained_at="2026-08-26T09:00:00Z")
        base.update(kwargs)
        return pairing.StationToken(**base)

    def test_the_token_file_is_never_readable_by_anyone_else(self):
        self.store.save(self.token())
        mode = self.path.stat().st_mode
        self.assertFalse(mode & (stat.S_IRWXG | stat.S_IRWXO),
                         "a station token must be 0600")
        self.assertTrue(self.store.secure())

    def test_round_trip(self):
        self.store.save(self.token(label="Werkstatt", scopes=["werkstatt"]))
        fresh = pairing.TokenStore(self.path).load()
        self.assertEqual(fresh.token, "secret")
        self.assertEqual(fresh.label, "Werkstatt")
        self.assertEqual(fresh.scopes, ["werkstatt"])

    def test_no_token_file_is_not_an_error(self):
        self.assertIsNone(self.store.load())
        self.assertTrue(self.store.secure())

    def test_a_corrupt_token_file_reads_as_unpaired(self):
        self.path.write_text("{not json", encoding="utf-8")
        self.assertIsNone(pairing.TokenStore(self.path).load())

    def test_a_loosened_token_file_is_reported(self):
        self.store.save(self.token())
        os.chmod(str(self.path), 0o644)
        self.assertFalse(pairing.TokenStore(self.path).secure())

    def test_an_expired_token_says_so(self):
        stale = self.token(expires_at="2020-01-01T00:00:00Z")
        self.assertTrue(stale.expired)
        self.assertTrue(stale.public()["expired"])

    def test_the_public_view_never_carries_the_secret(self):
        public = self.token().public()
        self.assertNotIn("token", public)
        self.assertNotIn("secret", json.dumps(public))

    def test_saving_replaces_atomically(self):
        self.store.save(self.token())
        self.store.save(self.token(token="second"))
        self.assertEqual(pairing.TokenStore(self.path).load().token, "second")
        self.assertFalse((self.path.with_name(self.path.name + ".tmp")).exists())

    def test_clear_removes_it(self):
        self.store.save(self.token())
        self.store.clear()
        self.assertIsNone(self.store.load())


class TestPairingRequestDisclosure(unittest.TestCase):
    def test_the_device_code_is_never_shown_on_screen(self):
        """Whoever holds the device_code can collect the token."""
        from datetime import datetime, timedelta, timezone
        request = pairing.PairingRequest(
            device_code="dev-secret-abc", user_code="WERK-4711",
            verification_uri="https://smpl/x", verification_uri_complete="https://smpl/x?code=1",
            expires_at=datetime.now(timezone.utc) + timedelta(minutes=10), interval=5.0,
        )
        rendered = json.dumps(request.as_dict())
        self.assertIn("WERK-4711", rendered)
        self.assertNotIn("dev-secret-abc", rendered)


class TestPairingSession(unittest.TestCase):
    """The whole dance, as the station page drives it."""

    def tearDown(self) -> None:
        server = getattr(self, "server", None)
        if server:
            server.close()
        tmp = getattr(self, "tmp", None)
        if tmp:
            tmp.cleanup()

    def session(self, poll_handler):
        self.server = StubSmpl({
            "/api/station/pair/start": canonical_start,
            "/api/station/pair/poll": poll_handler,
        })
        self.tmp = tempfile.TemporaryDirectory()
        store = pairing.TokenStore(Path(self.tmp.name) / "token.json")
        client = pairing.PairingClient(self.server.base_url)
        return pairing.PairingSession(client, store, device_id="station-abc",
                                      device_name="Werkstatt-Station"), store

    def test_begin_returns_a_displayable_code_immediately(self):
        session, _store = self.session(lambda _p, _h: (200, {"status": "pending"}))
        snapshot = session.begin()
        self.assertEqual(snapshot["state"], "waiting")
        self.assertEqual(snapshot["user_code"], "WERK-4711")
        self.assertFalse(snapshot["paired"])
        session.cancel()

    def test_approval_stores_the_token(self):
        session, store = self.session(
            lambda _p, hit: (200, {"status": "pending"}) if hit < 2
            else (200, {"token": "granted"})
        )
        session.begin()
        deadline = threading.Event()
        for _ in range(60):
            if session.snapshot()["state"] == "paired":
                break
            deadline.wait(0.25)
        snapshot = session.snapshot()
        self.assertEqual(snapshot["state"], "paired", snapshot)
        self.assertTrue(snapshot["paired"])
        self.assertEqual(store.load().token, "granted")

    def test_a_refusal_stops_the_loop(self):
        session, store = self.session(lambda _p, _h: (200, {"status": "denied"}))
        session.begin()
        waiter = threading.Event()
        for _ in range(40):
            if session.snapshot()["state"] == "denied":
                break
            waiter.wait(0.25)
        self.assertEqual(session.snapshot()["state"], "denied")
        self.assertIsNone(store.load())

    def test_a_server_without_pairing_reports_unavailable_not_a_crash(self):
        self.server = StubSmpl({})
        self.tmp = tempfile.TemporaryDirectory()
        store = pairing.TokenStore(Path(self.tmp.name) / "token.json")
        session = pairing.PairingSession(
            pairing.PairingClient(self.server.base_url), store,
            device_id="d", device_name="n",
        )
        snapshot = session.begin()
        self.assertEqual(snapshot["state"], "unavailable")
        self.assertIn("no station pairing endpoint", snapshot["error"])
        self.assertFalse(snapshot["paired"])


if __name__ == "__main__":
    unittest.main()
