"""The agent, running, with a simulated card reader attached.

This is the closest thing to the Pi that exists without a Pi: a real server on
a real socket, a real SQLite file, real fixture cards appearing in a watched
directory, and the endpoints driven the way the station page drives them.

The server binds port 0 so the operating system picks a free port - these
tests never touch 8765 or any other port something else might be using - and
printing is simulated throughout, so no tape is consumed and no USB device is
opened.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

import fixtures  # noqa: E402
import server  # noqa: E402
import station as station_module  # noqa: E402


class QuietHandler(server.Handler):
    """The real handler, minus the access log, so test output stays readable."""

    def log_message(self, fmt, *args):
        pass


class RunningAgent:
    """The real agent on an ephemeral port, torn down cleanly."""

    def __init__(self, root: Path, *, sd_simulate=None, base_url=""):
        self.root = root
        os.environ["AGENT_STATE_DIR"] = str(root / "state")
        self.db = root / "state" / "inventory.db"
        self.station = station_module.Station(
            self.db, base_url=base_url, device_name="Test-Station",
            agent_version="test", sd_simulate=sd_simulate, sd_poll_s=0.2,
        )
        self.agent = server.Agent(
            server.Store(self.db),
            server.Printer(enabled=False),
            server.Upstream(base_url, "", token_provider=self.station.token),
            station=self.station,
        )
        self.agent.start_background()
        self.server = server.Server(("127.0.0.1", 0), QuietHandler, self.agent)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(
            target=self.server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True
        )
        self.thread.start()

    @property
    def base(self) -> str:
        return "http://127.0.0.1:%d" % self.port

    def get(self, path: str):
        with urllib.request.urlopen(self.base + path, timeout=5) as handle:
            return handle.status, json.loads(handle.read().decode("utf-8"))

    def post(self, path: str, payload=None):
        body = json.dumps(payload or {}).encode("utf-8")
        request = urllib.request.Request(self.base + path, data=body, method="POST")
        request.add_header("Content-Type", "application/json")
        with urllib.request.urlopen(request, timeout=5) as handle:
            return handle.status, json.loads(handle.read().decode("utf-8"))

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.agent.shutdown()


class StationHttpCase(unittest.TestCase):
    sd_simulate = None

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.cards = self.root / "cards"
        self.cards.mkdir()
        self._saved_state_dir = os.environ.get("AGENT_STATE_DIR")
        self.running = RunningAgent(
            self.root,
            sd_simulate=str(self.cards) if self.sd_simulate else None,
        )

    def tearDown(self) -> None:
        self.running.close()
        if self._saved_state_dir is None:
            os.environ.pop("AGENT_STATE_DIR", None)
        else:
            os.environ["AGENT_STATE_DIR"] = self._saved_state_dir
        self.tmp.cleanup()


class TestHealthAndCoreUnaffected(StationHttpCase):
    def test_health_reports_the_station(self):
        status, body = self.running.get("/health")
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])
        self.assertIn("identity", body)
        self.assertFalse(body["identity"]["paired"])
        self.assertEqual(body["identity"]["token_source"], "none")
        self.assertIn("sd_import", body)

    def test_counting_still_works_with_no_smpl_and_no_pairing(self):
        """The regression that matters: the Pi work must not cost the bench work."""
        _s, body = self.running.post("/count", {
            "session": "inventur", "code": "4011923456789",
            "article_name": "Schraube M6x40", "qty": 3,
        })
        self.assertEqual(body["counted_qty"], 3)
        self.assertEqual(body["scan_count"], 1)
        _s, again = self.running.post("/count", {"session": "inventur",
                                                 "code": "4011923456789", "qty": 2})
        self.assertEqual(again["counted_qty"], 5)
        self.assertEqual(again["scan_count"], 2)

    def test_resolve_still_answers_offline(self):
        _s, body = self.running.post("/resolve", {"code": "SP-1042"})
        self.assertEqual(body["source"], "local")
        self.assertFalse(body["found"])

    def test_export_still_works(self):
        self.running.post("/count", {"session": "inv", "code": "A1",
                                     "article_name": "Ding", "qty": 1})
        with urllib.request.urlopen(self.running.base + "/export/inv.csv", timeout=5) as h:
            text = h.read().decode("utf-8-sig")
        self.assertIn("counted_qty", text)
        self.assertIn("A1", text)

    def test_a_print_is_still_queued_and_simulated(self):
        _s, body = self.running.post("/print", {"code": "SP-1042", "title": "Kabelbinder"})
        self.assertTrue(body["ok"])
        self.assertTrue(body["simulated"], "no tape may be consumed by a test")
        self.assertTrue(body["within_budget"])


class TestPairingEndpoints(StationHttpCase):
    def test_pair_status_before_anything(self):
        status, body = self.running.get("/pair/status")
        self.assertEqual(status, 200)
        self.assertEqual(body["state"], "idle")
        self.assertFalse(body["paired"])
        self.assertTrue(body["token_file_secure"])

    def test_pair_start_without_a_smpl_url_says_unavailable(self):
        _s, body = self.running.post("/pair/start", {})
        self.assertEqual(body["state"], "unavailable")
        self.assertIn("SMPL_API_URL", body["error"])

    def test_the_device_identity_is_stable_and_shown(self):
        _s, first = self.running.get("/pair/status")
        _s, second = self.running.get("/pair/status")
        self.assertEqual(first["device_id"], second["device_id"])
        self.assertTrue(first["device_id"].startswith("station-"))

    def test_forget_is_safe_when_never_paired(self):
        _s, body = self.running.post("/pair/forget", {})
        self.assertTrue(body["ok"])
        self.assertFalse(body["paired"])


class TestImportEndpoints(StationHttpCase):
    sd_simulate = True

    def wait_for_import(self, timeout: float = 15.0):
        deadline = time.time() + timeout
        while time.time() < deadline:
            _s, body = self.running.get("/imports")
            if body["imports"]:
                return body["imports"]
            time.sleep(0.2)
        return []

    def test_a_card_appearing_is_imported_without_anyone_asking(self):
        fixtures.build_benning_st_card(self.cards / "BENNING_ST760")
        rows = self.wait_for_import()
        self.assertTrue(rows, "the watcher should have noticed the card")
        row = rows[0]
        self.assertEqual(row["vendor"], "benning")
        self.assertEqual(row["file_count"], 4)
        self.assertEqual(row["upload_status"], "unavailable")  # no SMPL configured

    def test_import_detail_carries_the_manifest(self):
        fixtures.build_metrel_card(self.cards / "METREL")
        rows = self.wait_for_import()
        self.assertTrue(rows)
        _s, detail = self.running.get("/imports/" + rows[0]["import_id"])
        self.assertEqual(detail["vendor"], "metrel")
        manifest = detail["manifest"]
        self.assertEqual(manifest["instrument"]["vendor"], "metrel")
        self.assertTrue(manifest["files"])
        self.assertIn("sha256", manifest["files"][0])

    def test_import_detail_does_not_serve_the_files_themselves(self):
        """Test protocols are not something to hand to whatever can reach the port."""
        fixtures.build_benning_st_card(self.cards / "BENNING")
        rows = self.wait_for_import()
        _s, detail = self.running.get("/imports/" + rows[0]["import_id"])
        rendered = json.dumps(detail)
        self.assertNotIn("SQLite format 3", rendered)
        self.assertIn("directory", detail)

    def test_a_malformed_import_id_is_rejected_before_it_reaches_disk(self):
        for bad in ("../../etc/passwd", "..", "%2e%2e%2fetc", "not-an-id"):
            with self.subTest(bad=bad):
                with self.assertRaises(urllib.error.HTTPError) as caught:
                    self.running.get("/imports/" + bad)
                self.assertIn(caught.exception.code, (400, 404))

    def test_health_shows_the_watcher_running(self):
        _s, body = self.running.get("/health")
        sd = body["sd_import"]
        self.assertTrue(sd["running"])
        self.assertTrue(sd["simulated"])
        self.assertEqual(sd["watch_root"], str(self.cards))

    def test_rescan_reimports_nothing_new_when_the_card_is_unchanged(self):
        fixtures.build_benning_st_card(self.cards / "BENNING")
        rows = self.wait_for_import()
        self.assertEqual(len(rows), 1)
        _s, body = self.running.post("/imports/rescan", {})
        self.assertTrue(body["ok"])
        time.sleep(1.0)
        _s, after = self.running.get("/imports")
        self.assertEqual(len(after["imports"]), 1,
                         "identical content must not create a second import")

    def test_several_cards_in_a_row(self):
        fixtures.build_benning_st_card(self.cards / "CARD_A")
        self.wait_for_import()
        fixtures.build_metrel_card(self.cards / "CARD_B")
        deadline = time.time() + 15
        while time.time() < deadline:
            _s, body = self.running.get("/imports")
            if len(body["imports"]) >= 2:
                break
            time.sleep(0.2)
        _s, body = self.running.get("/imports")
        vendors = {row["vendor"] for row in body["imports"]}
        self.assertEqual(vendors, {"benning", "metrel"})

    def test_retry_uploads_is_honest_about_having_nowhere_to_send(self):
        _s, body = self.running.post("/imports/retry", {})
        self.assertFalse(body["ok"])
        self.assertIn("no SMPL server", body["error"])


class TestStationDisabled(unittest.TestCase):
    """An agent built without station services must still be a working agent."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        db = Path(self.tmp.name) / "inventory.db"
        self.agent = server.Agent(server.Store(db), server.Printer(enabled=False),
                                  server.Upstream("", ""), station=None)
        self.server = server.Server(("127.0.0.1", 0), QuietHandler, self.agent)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever,
                         kwargs={"poll_interval": 0.05}, daemon=True).start()

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.agent.shutdown()
        self.tmp.cleanup()

    def test_health_is_fine(self):
        with urllib.request.urlopen("http://127.0.0.1:%d/health" % self.port, timeout=5) as h:
            body = json.loads(h.read().decode("utf-8"))
        self.assertTrue(body["ok"])
        self.assertTrue(body["identity"]["disabled"])

    def test_station_routes_explain_themselves_rather_than_500ing(self):
        with self.assertRaises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen("http://127.0.0.1:%d/pair/status" % self.port, timeout=5)
        self.assertEqual(caught.exception.code, 503)
        detail = json.loads(caught.exception.read().decode("utf-8"))
        self.assertIn("Scanning, counting and printing are unaffected", detail["error"])


if __name__ == "__main__":
    unittest.main()
