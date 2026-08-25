"""The heartbeat: a report, never a dependency.

Every test here is really the same test asked a different way — *does this
stop the station working?* The answer has to be no, for a missing endpoint, a
revoked token, a dead network and a server that returns nonsense.
"""

from __future__ import annotations

import json
import threading
import unittest
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import sys

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

import station_heartbeat  # noqa: E402


class StubSmpl:
    def __init__(self, routes) -> None:
        self.routes = routes
        self.received = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args):
                pass

            def do_POST(self):  # noqa: N802
                path = urllib.parse.urlparse(self.path).path
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length) if length else b"{}"
                try:
                    payload = json.loads(raw.decode("utf-8"))
                except ValueError:
                    payload = {}
                outer.received.append((path, payload, self.headers.get("Authorization", "")))
                handler = outer.routes.get(path)
                status, body = handler(payload) if handler else (404, {"detail": "Not Found"})
                encoded = json.dumps(body).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._server.daemon_threads = True
        threading.Thread(target=self._server.serve_forever, daemon=True).start()

    @property
    def base_url(self) -> str:
        host, port = self._server.server_address[:2]
        return "http://%s:%d" % (host, port)

    def close(self) -> None:
        self._server.shutdown()
        self._server.server_close()


# The real StationHeartbeatOut shape.
OK_RESPONSE = (200, {
    "ok": True,
    "station": {"id": 3, "name": "Werkstatt-Station", "prefix": "smpl_station_bbbb",
                "created_at": "2026-08-26T09:31:00Z", "hardware_status": {}, "active": True},
    "server_time": "2026-08-26T09:40:00Z",
})


class HeartbeatCase(unittest.TestCase):
    def tearDown(self) -> None:
        beat = getattr(self, "beat", None)
        if beat:
            beat.stop()
        server = getattr(self, "server", None)
        if server:
            server.close()

    def build(self, routes, *, token="tok-abc", status=None, on_auth=None):
        self.server = StubSmpl(routes)
        self.beat = station_heartbeat.Heartbeat(
            self.server.base_url,
            token_provider=lambda: token,
            agent_version="1.0.0",
            status_provider=(lambda: status) if status is not None else None,
            on_auth=on_auth,
        )
        return self.beat


class TestReporting(HeartbeatCase):
    def test_a_heartbeat_reaches_the_documented_endpoint(self):
        beat = self.build({"/api/station/heartbeat": lambda _p: OK_RESPONSE})
        beat.beat()
        path, payload, auth = self.server.received[-1]
        self.assertEqual(path, "/api/station/heartbeat")
        self.assertEqual(payload["agent_version"], "1.0.0")
        self.assertEqual(auth, "Bearer tok-abc")

    def test_printer_state_is_reported_in_the_fields_smpl_declares(self):
        beat = self.build(
            {"/api/station/heartbeat": lambda _p: OK_RESPONSE},
            status={"printer_connected": True, "media_width_mm": 12,
                    "error": None, "status": {"queue_depth": 0}},
        )
        beat.beat()
        _path, payload, _auth = self.server.received[-1]
        self.assertIs(payload["printer_connected"], True)
        self.assertEqual(payload["media_width_mm"], 12.0)
        self.assertEqual(payload["status"], {"queue_depth": 0})
        # A None error is omitted rather than sent as null; SMPL caps it at
        # 500 chars and has no use for an explicit nothing.
        self.assertNotIn("error", payload)

    def test_a_printer_fault_is_reported_and_truncated(self):
        beat = self.build(
            {"/api/station/heartbeat": lambda _p: OK_RESPONSE},
            status={"printer_connected": False, "error": "x" * 900},
        )
        beat.beat()
        _path, payload, _auth = self.server.received[-1]
        self.assertIs(payload["printer_connected"], False)
        self.assertEqual(len(payload["error"]), 500)

    def test_the_endpoint_is_remembered_after_the_first_success(self):
        beat = self.build({"/api/station/heartbeat": lambda _p: OK_RESPONSE})
        beat.beat()
        beat.beat()
        self.assertEqual(len(self.server.received), 2)
        self.assertEqual(beat.status()["endpoint"], "/api/station/heartbeat")


class TestDegradation(HeartbeatCase):
    def test_an_unpaired_station_sends_nothing(self):
        beat = self.build({"/api/station/heartbeat": lambda _p: OK_RESPONSE}, token="")
        beat.beat()
        self.assertEqual(self.server.received, [])

    def test_a_server_without_the_endpoint_marks_itself_unsupported(self):
        """Which is what stops the loop — an office Pi must not poll a 404 all year."""
        beat = self.build({})
        beat.beat()
        self.assertGreater(len(self.server.received), 0, "it should try the candidates once")
        self.assertIs(beat.status()["supported"], False)
        self.assertIn("no station heartbeat endpoint", beat.status()["last_error"])

    def test_an_unsupported_server_leaves_no_thread_running(self):
        beat = self.build({})
        beat.start()
        for _ in range(40):
            if not beat.status()["running"]:
                break
            threading.Event().wait(0.25)
        self.assertFalse(beat.status()["running"],
                         "the loop must retire itself once it knows there is no endpoint")

    def test_a_revoked_token_is_surfaced_not_swallowed(self):
        seen = []
        beat = self.build(
            {"/api/station/heartbeat": lambda _p: (401, {"detail": "revoked"})},
            on_auth=seen.append,
        )
        wait = beat.beat()
        self.assertIn(401, seen)
        self.assertIn("rejected", beat.status()["last_error"])
        # And it backs off rather than hammering a station nobody re-paired.
        self.assertGreater(wait, station_heartbeat.INTERVAL_S)

    def test_a_dead_network_is_not_an_error_worth_shouting_about(self):
        beat = station_heartbeat.Heartbeat(
            "http://127.0.0.1:9", token_provider=lambda: "tok",
        )
        wait = beat.beat()
        self.assertEqual(wait, station_heartbeat.INTERVAL_S)
        self.assertIsNone(beat.status()["supported"])

    def test_a_broken_status_provider_does_not_stop_the_beat(self):
        def explode():
            raise RuntimeError("printer module is on fire")

        self.server = StubSmpl({"/api/station/heartbeat": lambda _p: OK_RESPONSE})
        beat = station_heartbeat.Heartbeat(
            self.server.base_url, token_provider=lambda: "tok",
            agent_version="1.0.0", status_provider=explode,
        )
        self.beat = beat
        beat.beat()
        self.assertEqual(len(self.server.received), 1)

    def test_nonsense_from_the_server_is_survived(self):
        beat = self.build({"/api/station/heartbeat": lambda _p: (500, {"oops": True})})
        wait = beat.beat()
        self.assertEqual(wait, station_heartbeat.INTERVAL_S)

    def test_no_url_means_no_thread(self):
        beat = station_heartbeat.Heartbeat("", token_provider=lambda: "tok")
        beat.start()
        self.assertFalse(beat.status()["running"])
        self.assertFalse(beat.configured)


if __name__ == "__main__":
    unittest.main()
