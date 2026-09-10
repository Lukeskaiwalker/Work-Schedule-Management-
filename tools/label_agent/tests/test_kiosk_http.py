"""The two kiosk screens, over the real HTTP server.

Same harness as ``test_station_http``: a real socket on an ephemeral port, a
real SQLite file, printing simulated. What is added here is the local contract
the screens speak — the long poll, the loopback guard on every mutating route,
and the promise that the agent boots with no SMPL, no scanner and no D-Bus.

The screens themselves are another agent's files and may not exist yet, so the
page routes are tested both ways: served when the file is there, and answering
with something a human can act on when it is not.
"""

from __future__ import annotations

import json
import pathlib
import re
import socket
import sys
import tempfile
import threading
import time
import urllib.parse
import unittest
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

import scan_router  # noqa: E402
import server  # noqa: E402
import smpl_werkstatt  # noqa: E402
# The barcode decoder lives with the encoder's own tests, where it is built
# out of an independent transcription of the symbology. Borrowing it here is
# what lets /barcode.svg be tested for what it actually serves - a symbol that
# scans back as the command - rather than for merely being well-formed XML.
from test_barcode128 import decode_svg  # noqa: E402
from test_smpl_werkstatt import StubSmpl  # noqa: E402
from test_station_http import QuietHandler, RunningAgent, StationHttpCase  # noqa: E402

P = smpl_werkstatt.PATHS


def get(url: str, headers=None):
    request = urllib.request.Request(url, method="GET")
    for key, value in (headers or {}).items():
        request.add_header(key, value)
    try:
        with urllib.request.urlopen(request, timeout=30) as handle:
            return handle.status, handle.read(), dict(handle.headers)
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read(), dict(exc.headers)


def post(url: str, payload=None):
    body = json.dumps(payload or {}).encode("utf-8")
    request = urllib.request.Request(url, data=body, method="POST")
    request.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(request, timeout=10) as handle:
            return handle.status, json.loads(handle.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        try:
            return exc.code, json.loads(exc.read().decode("utf-8"))
        except ValueError:
            return exc.code, {}


class KioskCase(StationHttpCase):
    """A running agent, plus shorthands for the screen routes."""

    def base(self) -> str:
        return self.running.base

    def state(self, screen="regal", since=None, wait=0.0):
        url = "%s/screen/state?screen=%s&wait=%s" % (self.base(), screen, wait)
        if since is not None:
            url += "&since=%d" % since
        status, body, _headers = get(url)
        return status, json.loads(body.decode("utf-8"))

    @property
    def agent(self):
        return self.running.agent


# --------------------------------------------------------------------------
# The two pages
# --------------------------------------------------------------------------


class TestScreenPages(KioskCase):
    def test_a_missing_page_says_which_file_is_missing(self):
        for path, filename in (("/regal", "kiosk_rack.html"), ("/kisten", "kiosk_boxes.html")):
            status, body, _headers = get(self.base() + path)
            if status == 200:
                continue  # the screens agent has landed the file; fine too
            self.assertEqual(status, 404)
            self.assertIn(filename, body.decode("utf-8"))

    def test_a_page_that_exists_is_served_as_html(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        fake = Path(tmp.name)
        (fake / "kiosk_rack.html").write_text("<h1>Regal</h1>", encoding="utf-8")
        (fake / "kiosk_boxes.html").write_text("<h1>Kisten</h1>", encoding="utf-8")
        original = server.STATIC_DIR
        server.STATIC_DIR = fake
        self.addCleanup(setattr, server, "STATIC_DIR", original)

        status, body, headers = get(self.base() + "/regal")
        self.assertEqual(status, 200)
        self.assertIn("text/html", headers["Content-Type"])
        self.assertIn("Regal", body.decode("utf-8"))
        status, body, _headers = get(self.base() + "/kisten")
        self.assertEqual(status, 200)
        self.assertIn("Kisten", body.decode("utf-8"))

    def test_the_station_page_still_works(self):
        status, _body, _headers = get(self.base() + "/")
        self.assertIn(status, (200, 503))


# --------------------------------------------------------------------------
# /screen/state
# --------------------------------------------------------------------------


class TestScreenState(KioskCase):
    def test_a_first_poll_answers_at_once_with_a_full_snapshot(self):
        status, body = self.state("regal")
        self.assertEqual(status, 200)
        self.assertEqual(body["screen"], "regal")
        self.assertIsInstance(body["seq"], int)
        for key in ("scanner", "upstream", "flash", "session", "pending"):
            self.assertIn(key, body)
        self.assertIn("direction", body)
        self.assertIn("last", body)

    def test_the_box_screen_gets_boxes_and_the_rack_screen_does_not(self):
        _status, boxes = self.state("kisten")
        self.assertIn("boxes", boxes)
        self.assertIsInstance(boxes["boxes"], list)
        _status, rack = self.state("regal")
        self.assertNotIn("boxes", rack)

    def test_an_unknown_screen_is_a_400_not_a_crash(self):
        status, _body, _headers = get(self.base() + "/screen/state?screen=kantine")
        self.assertEqual(status, 400)

    def test_the_screen_parameter_is_required(self):
        status, _body, _headers = get(self.base() + "/screen/state")
        self.assertEqual(status, 400)

    def test_a_poll_at_the_current_seq_waits_and_then_returns_unchanged(self):
        _status, first = self.state("regal")
        started = time.monotonic()
        status, second = self.state("regal", since=first["seq"], wait=0.6)
        elapsed = time.monotonic() - started
        self.assertEqual(status, 200)
        self.assertGreaterEqual(elapsed, 0.5)
        self.assertLess(elapsed, 10.0)
        self.assertEqual(second["seq"], first["seq"])

    def test_a_change_wakes_the_poll_before_the_timeout(self):
        _status, first = self.state("regal")
        result = {}

        def poll():
            result["status"], result["body"] = self.state(
                "regal", since=first["seq"], wait=20.0
            )

        thread = threading.Thread(target=poll, daemon=True)
        thread.start()
        time.sleep(0.3)
        post(self.base() + "/screen/action",
             {"screen": "regal", "action": "direction", "value": "ein"})
        thread.join(timeout=10.0)
        self.assertFalse(thread.is_alive(), "the long poll never woke up")
        self.assertEqual(result["status"], 200)
        self.assertGreater(result["body"]["seq"], first["seq"])
        self.assertEqual(result["body"]["direction"], "ein")

    def test_the_poll_is_capped_at_the_contract_maximum(self):
        self.assertLessEqual(server.SCREEN_POLL_MAX_S, 25.0)
        # A screen asking for a longer wait than the contract allows gets the
        # contract's wait. Proven by shrinking the cap and timing the answer.
        original = server.SCREEN_POLL_MAX_S
        server.SCREEN_POLL_MAX_S = 0.4
        self.addCleanup(setattr, server, "SCREEN_POLL_MAX_S", original)
        _status, first = self.state("regal")
        started = time.monotonic()
        status, body = self.state("regal", since=first["seq"], wait=999)
        elapsed = time.monotonic() - started
        self.assertEqual(status, 200)
        self.assertLess(elapsed, 5.0)
        self.assertEqual(body["seq"], first["seq"])

    def test_the_snapshot_is_always_complete_never_a_delta(self):
        post(self.base() + "/screen/action",
             {"screen": "regal", "action": "direction", "value": "ein"})
        _status, body = self.state("regal")
        self.assertEqual(body["direction"], "ein")
        self.assertIn("scanner", body)
        self.assertIn("upstream", body)

    def test_the_two_screens_have_independent_sequences(self):
        _s, rack_before = self.state("regal")
        _s, box_before = self.state("kisten")
        post(self.base() + "/screen/action",
             {"screen": "regal", "action": "direction", "value": "ein"})
        _s, rack_after = self.state("regal")
        _s, box_after = self.state("kisten")
        self.assertGreater(rack_after["seq"], rack_before["seq"])
        self.assertEqual(box_after["seq"], box_before["seq"])


# --------------------------------------------------------------------------
# The loopback guard
# --------------------------------------------------------------------------


class TestLoopbackOnly(KioskCase):
    MUTATING = (
        ("/scan/route", {"code": "SMPL-CMD-AUS"}),
        ("/box/session", {}),
        ("/box/item", {"box_id": 1, "code": "x"}),
        ("/box/item/remove", {"box_id": 1, "item_id": 2}),
        ("/rack/movement", {"article_id": 1, "movement_type": "checkout"}),
        ("/screen/action", {"screen": "regal", "action": "dismiss"}),
    )
    # /pair/forget deletes the station credential from disk; /pair/start and
    # /pair/cancel drive the device-grant. None of the three has any business
    # being reachable from the far side of the workshop LAN.
    PAIRING = (
        ("/pair/start", {"device_name": "Eindringling"}),
        ("/pair/cancel", {}),
        ("/pair/forget", {}),
    )
    # The kiosk's reads. /kisten and /screen/state hand out the whole crate
    # list — customer, project, every packed item — and /screen/state is an
    # unauthenticated 25-second long poll on a threaded server.
    # /barcode.svg is in the list because it is drawn for the crate screen and
    # embedded by it: it belongs on the same footing as the page it appears
    # on, and a command barcode the whole workshop LAN can render is one
    # somebody can print and carry to the wrong screen.
    KIOSK_READS = (
        "/regal", "/kisten", "/screen/state?screen=regal&wait=0",
        "/boxes/state", "/now-playing", "/now-playing/cover.jpg",
        "/barcode.svg?text=SMPL-CMD-FERTIG&h=140",
    )

    def test_loopback_reaches_every_mutating_route(self):
        for path, payload in self.MUTATING:
            status, _body = post(self.base() + path, payload)
            self.assertNotEqual(status, 403, path)

    def test_a_non_loopback_client_is_refused(self):
        # Ask the handler directly what it makes of a LAN address: the agent
        # binds 0.0.0.0 on the Pi, so this is not hypothetical.
        for address in ("192.168.2.99", "10.0.0.4", "::ffff:192.168.2.99", "0.0.0.0"):
            self.assertFalse(server.is_loopback(address), address)

    def test_loopback_spellings_are_all_accepted(self):
        for address in ("127.0.0.1", "127.0.0.5", "::1", "::ffff:127.0.0.1"):
            self.assertTrue(server.is_loopback(address), address)

    def test_a_lan_client_gets_403_on_a_mutating_route(self):
        # Drive the real handler with a real HTTP request that arrives from a
        # LAN address. No second listener: binding one would test the operating
        # system, and the client address is the only thing under test here.
        for path, payload in self.MUTATING:
            status, _raw = self._request_from("192.168.2.99", "POST", path, payload)
            self.assertEqual(status, 403, path)

    def test_the_same_request_from_loopback_is_allowed(self):
        for path, payload in self.MUTATING:
            status, _raw = self._request_from("127.0.0.1", "POST", path, payload)
            self.assertNotEqual(status, 403, path)

    def test_a_lan_client_cannot_read_the_kiosk_either(self):
        # Reading is not harmless. The crate screen is the customer, the
        # project and every packed item of every open job; the long poll is
        # also a way to pin 25-second threads against the two screens. Both
        # browsers run ON the Pi, so nothing here needs to leave it.
        for path in self.KIOSK_READS:
            status, _raw = self._request_from("192.168.2.99", "GET", path, None)
            self.assertEqual(status, 403, path)

    def test_the_pi_itself_still_reads_the_kiosk(self):
        for path in self.KIOSK_READS:
            status, _raw = self._request_from("127.0.0.1", "GET", path, None)
            self.assertNotEqual(status, 403, path)

    def test_the_guard_does_not_care_which_verb_asked(self):
        # It used to live in do_POST alone, which left every GET open.
        for method in ("GET", "HEAD"):
            status, _raw = self._request_from(
                "192.168.2.99", method, "/screen/state?screen=regal&wait=0", None)
            self.assertEqual(status, 403, method)

    def test_the_pairing_routes_are_loopback_only(self):
        for path, payload in self.PAIRING:
            status, _raw = self._request_from("192.168.2.99", "POST", path, payload)
            self.assertEqual(status, 403, path)

    def test_pairing_still_works_from_the_pi(self):
        for path, payload in self.PAIRING:
            status, _raw = self._request_from("127.0.0.1", "POST", path, payload)
            self.assertNotEqual(status, 403, path)

    def test_the_documented_lan_routes_are_untouched(self):
        # These four are the exemption, and they are exempt on purpose:
        # monitoring, the setup page a phone opens, and the phone-driven
        # print/count the README documents --host 0.0.0.0 for.
        status, _raw = self._request_from("192.168.2.99", "GET", "/health", None)
        self.assertEqual(status, 200)
        status, _raw = self._request_from("192.168.2.99", "GET", "/setup", None)
        self.assertIn(status, (200, 503))
        status, _raw = self._request_from("192.168.2.99", "GET", "/static/kiosk.css", None)
        self.assertIn(status, (200, 404))
        status, _raw = self._request_from("192.168.2.99", "GET", "/pair/status", None)
        self.assertEqual(status, 200)
        status, _raw = self._request_from(
            "192.168.2.99", "POST", "/print", {"code": "X1", "title": "T"})
        self.assertNotEqual(status, 403)

    def test_the_older_api_is_deliberately_not_locked_down(self):
        # /count stays reachable from the LAN: the README documents
        # --host 0.0.0.0 for exactly that, and silently breaking it would be a
        # worse surprise than the lock is a win.
        status, _raw = self._request_from(
            "192.168.2.99", "POST", "/count", {"session": "lan", "code": "X1", "qty": 1})
        self.assertEqual(status, 200)

    def _request_from(self, client_address: str, method: str, path: str, payload):
        body = b"" if payload is None else json.dumps(payload).encode("utf-8")
        head = "%s %s HTTP/1.1\r\nHost: station\r\nConnection: close\r\n" % (method, path)
        if payload is not None:
            head += "Content-Type: application/json\r\n"
            head += "Content-Length: %d\r\n" % len(body)
        raw = head.encode("utf-8") + b"\r\n" + body

        left, right = socket.socketpair()
        chunks = []

        # Read while the handler writes. A socketpair holds a few kilobytes;
        # an HTML page is bigger than that, so draining afterwards deadlocks
        # the handler mid-response.
        def drain() -> None:
            while True:
                try:
                    chunk = left.recv(65536)
                except OSError:
                    return
                if not chunk:
                    return
                chunks.append(chunk)

        reader = threading.Thread(target=drain, daemon=True)
        reader.start()
        try:
            left.sendall(raw)
            left.shutdown(socket.SHUT_WR)
            QuietHandler(right, (client_address, 51234), self.running.server)
        finally:
            right.close()
        reader.join(15.0)
        left.close()
        answer = b"".join(chunks)
        return int(answer.split(b" ")[1]), answer


# --------------------------------------------------------------------------
# Now playing
# --------------------------------------------------------------------------


class TestNowPlaying(KioskCase):
    def test_it_degrades_to_not_playing(self):
        # No busctl on a Mac, and no shairport on a bench Pi either.
        status, body, _headers = get(self.base() + "/now-playing")
        self.assertEqual(status, 200)
        payload = json.loads(body.decode("utf-8"))
        self.assertFalse(payload["playing"])
        for field in ("title", "artist", "album", "art_hash", "since"):
            self.assertIsNone(payload[field], field)

    def test_no_cover_is_a_404_not_a_500(self):
        status, _body, _headers = get(self.base() + "/now-playing/cover.jpg")
        self.assertEqual(status, 404)

    def test_a_cover_is_served_with_its_hash_as_the_etag(self):
        blob = b"\xff\xd8\xff\xe0 pretend jpeg"
        self.agent.now_playing._cover = blob
        self.agent.now_playing._state = dict(
            self.agent.now_playing._state, art_hash="abc123def456", playing=True
        )
        status, body, headers = get(self.base() + "/now-playing/cover.jpg")
        self.assertEqual(status, 200)
        self.assertEqual(body, blob)
        self.assertIn("abc123def456", headers["ETag"])
        self.assertEqual(headers["Content-Type"], "image/jpeg")

    def test_a_matching_etag_is_answered_with_304(self):
        self.agent.now_playing._cover = b"jpegbytes"
        self.agent.now_playing._state = dict(
            self.agent.now_playing._state, art_hash="deadbeef1234", playing=True
        )
        _status, _body, headers = get(self.base() + "/now-playing/cover.jpg")
        status, body, _headers = get(self.base() + "/now-playing/cover.jpg",
                                     headers={"If-None-Match": headers["ETag"]})
        self.assertEqual(status, 304)
        self.assertEqual(body, b"")


# --------------------------------------------------------------------------
# The command barcodes the crate screen is operated with
# --------------------------------------------------------------------------


class TestBarcodeSvg(KioskCase):
    """The one route the screen with no keyboard depends on.

    The barcode itself is proven in test_barcode128, by decoding. What is
    under test here is the HTTP contract the page relies on: the content type
    an ``<img>`` needs, the caching the Pi wants, and the difference between a
    size it should clamp and a code it must refuse.
    """

    COMMANDS = (
        "SMPL-CMD-FERTIG", "SMPL-CMD-ABBRUCH", "SMPL-CMD-ENTNAHME",
        "SMPL-CMD-MENGE-5", "SMPL-CMD-MENGE-10", "SMPL-CMD-MENGE-50",
    )

    def fetch(self, query: str):
        return get(self.base() + "/barcode.svg?" + query)

    def test_it_serves_an_svg_with_the_content_type_an_img_tag_needs(self):
        status, body, headers = self.fetch("text=SMPL-CMD-FERTIG&h=140")
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "image/svg+xml")
        markup = body.decode("utf-8")
        self.assertTrue(markup.startswith("<svg "))
        self.assertTrue(markup.endswith("</svg>"))

    def test_what_it_serves_scans_back_as_the_command(self):
        # End to end: through the socket, out of the query string, and back
        # through the decoder that reads the drawn bars. A route that served a
        # well-formed SVG of the wrong code would pass every other test here.
        for code in self.COMMANDS:
            _status, body, _headers = self.fetch("text=" + code)
            self.assertEqual(decode_svg(body.decode("utf-8")), code, code)

    def test_the_codes_are_cacheable_for_a_day(self):
        # They never change, and the wall screens reload.
        _status, _body, headers = self.fetch("text=SMPL-CMD-FERTIG")
        self.assertEqual(headers["Cache-Control"], "public, max-age=86400")

    def test_a_character_the_symbology_cannot_carry_is_a_400(self):
        for text in ("Gr%C3%B6%C3%9Fe", "SMPL%09CMD", "K%C3%84STEN"):
            status, body, headers = self.fetch("text=" + text)
            self.assertEqual(status, 400, text)
            self.assertTrue(headers["Content-Type"].startswith("text/plain"), text)
            self.assertTrue(body.decode("utf-8").strip(), "a 400 must say why")

    def test_an_over_long_text_is_a_400(self):
        status, body, _headers = self.fetch("text=" + "K" * 49)
        self.assertEqual(status, 400)
        self.assertIn("48", body.decode("utf-8"))
        # And the character right on the limit is not.
        status, _body, _headers = self.fetch("text=" + "K" * 48)
        self.assertEqual(status, 200)

    def test_an_empty_text_is_a_400(self):
        for query in ("text=", "", "h=140", "text=%20%20"):
            status, _body, _headers = self.fetch(query)
            self.assertEqual(status, 400, query)

    def test_the_400_is_plain_text_not_json(self):
        # This route is only ever an <img> source. A JSON body is invisible
        # there; a sentence is at least readable to whoever opens the URL.
        status, body, headers = self.fetch("text=")
        self.assertEqual(status, 400)
        self.assertTrue(headers["Content-Type"].startswith("text/plain"))
        with self.assertRaises(ValueError):
            json.loads(body.decode("utf-8"))

    def test_the_height_is_clamped_rather_than_refused(self):
        # A size out of range is a page asking for a size, not a code the
        # agent cannot draw.
        for asked, expected in ((10, 40), (39, 40), (40, 40), (140, 140),
                                (400, 400), (401, 400), (99999, 400), (-20, 40)):
            status, body, _headers = self.fetch("text=SMPL-CMD-FERTIG&h=%d" % asked)
            self.assertEqual(status, 200, asked)
            self.assertIn('height="%d"' % expected, body.decode("utf-8"), asked)

    def test_the_default_height_is_120(self):
        for query in ("text=SMPL-CMD-FERTIG", "text=SMPL-CMD-FERTIG&h=",
                      "text=SMPL-CMD-FERTIG&h=hoch"):
            status, body, _headers = self.fetch(query)
            self.assertEqual(status, 200, query)
            self.assertIn('height="120"', body.decode("utf-8"), query)

    def test_the_svg_carries_no_reference_off_the_pi(self):
        # The kiosk browser has no route to the internet and should not need
        # one to draw a barcode.
        _status, body, _headers = self.fetch("text=SMPL-CMD-ABBRUCH")
        rest = body.decode("utf-8").replace('xmlns="http://www.w3.org/2000/svg"', "")
        for forbidden in ("http://", "https://", "<script", "<image", "xlink:href"):
            self.assertNotIn(forbidden, rest, forbidden)

    def test_a_head_request_answers_without_a_body(self):
        # The page uses <img>, but a browser or a probe may still HEAD it, and
        # the shared verb table means one handler answers both.
        request = urllib.request.Request(
            self.base() + "/barcode.svg?text=SMPL-CMD-FERTIG", method="HEAD")
        with urllib.request.urlopen(request, timeout=10) as handle:
            self.assertEqual(handle.status, 200)
            self.assertEqual(handle.headers["Content-Type"], "image/svg+xml")
            self.assertEqual(handle.read(), b"")


# --------------------------------------------------------------------------
# Boxes
# --------------------------------------------------------------------------


class TestBoxesState(KioskCase):
    def test_it_answers_the_contract_shape_with_no_smpl(self):
        status, body, _headers = get(self.base() + "/boxes/state")
        self.assertEqual(status, 200)
        payload = json.loads(body.decode("utf-8"))
        self.assertEqual(payload["boxes"], [])
        self.assertTrue(payload["stale"])
        self.assertIsNotNone(payload["error"])
        self.assertIn("fetched_at", payload)


# --------------------------------------------------------------------------
# Routing scans through the real server
# --------------------------------------------------------------------------


class TestScanRouting(KioskCase):
    def test_a_command_routes_without_asking_smpl(self):
        status, body = post(self.base() + "/scan/route", {"code": "SMPL-CMD-EIN"})
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])
        self.assertEqual(body["routed_to"], "regal")
        _s, state = self.state("regal")
        self.assertEqual(state["direction"], "ein")

    def test_a_kiste_code_opens_a_session_on_the_box_screen(self):
        status, body = post(self.base() + "/scan/route", {"code": "KISTE-K3"})
        self.assertEqual(body["routed_to"], "kisten")
        _s, state = self.state("kisten")
        self.assertIsNotNone(state["session"])
        self.assertEqual(state["session"]["code"], "KISTE-K3")
        self.assertEqual(state["session"]["mode"], "add")

    def test_an_article_with_no_smpl_flashes_an_error_it_does_not_500(self):
        status, body = post(self.base() + "/scan/route", {"code": "4011923456789"})
        self.assertEqual(status, 200)
        self.assertEqual(body["routed_to"], "regal")
        _s, state = self.state("regal")
        self.assertIsNotNone(state["flash"])
        self.assertEqual(state["flash"]["level"], "error")

    def test_a_duplicate_inside_the_window_is_reported_as_such(self):
        post(self.base() + "/scan/route", {"code": "KISTE-K9", "source": "evdev"})
        _status, body = post(self.base() + "/scan/route",
                             {"code": "KISTE-K9", "source": "wedge"})
        self.assertTrue(body["duplicate"])

    def test_an_empty_code_is_a_400(self):
        status, _body = post(self.base() + "/scan/route", {"code": ""})
        self.assertEqual(status, 400)

    def test_menge_then_an_article_shows_the_pending_quantity(self):
        post(self.base() + "/scan/route", {"code": "SMPL-CMD-MENGE-10"})
        _s, state = self.state("regal")
        self.assertIsNotNone(state["pending"])
        self.assertEqual(state["pending"]["qty"], 10)

    def test_fertig_closes_the_session(self):
        post(self.base() + "/scan/route", {"code": "KISTE-K3"})
        post(self.base() + "/scan/route", {"code": "SMPL-CMD-FERTIG"})
        _s, state = self.state("kisten")
        self.assertIsNone(state["session"])


class TestScreenActions(KioskCase):
    def test_dismiss_clears_the_flash(self):
        post(self.base() + "/scan/route", {"code": "4011923456789"})
        _s, before = self.state("regal")
        self.assertIsNotNone(before["flash"])
        post(self.base() + "/screen/action", {"screen": "regal", "action": "dismiss"})
        _s, after = self.state("regal")
        self.assertIsNone(after["flash"])

    def test_mode_switches_the_box_screen(self):
        post(self.base() + "/scan/route", {"code": "KISTE-K3"})
        post(self.base() + "/screen/action",
             {"screen": "kisten", "action": "mode", "value": "remove"})
        _s, state = self.state("kisten")
        self.assertEqual(state["session"]["mode"], "remove")

    def test_close_session_closes_it(self):
        post(self.base() + "/scan/route", {"code": "KISTE-K3"})
        post(self.base() + "/screen/action", {"screen": "kisten", "action": "close_session"})
        _s, state = self.state("kisten")
        self.assertIsNone(state["session"])

    def test_qty_sets_the_pending_quantity(self):
        post(self.base() + "/screen/action",
             {"screen": "regal", "action": "qty", "value": 7})
        _s, state = self.state("regal")
        self.assertEqual(state["pending"]["qty"], 7)

    def test_an_unknown_action_is_a_400(self):
        status, _body = post(self.base() + "/screen/action",
                             {"screen": "regal", "action": "explode"})
        self.assertEqual(status, 400)

    def test_a_bad_direction_is_a_400(self):
        status, _body = post(self.base() + "/screen/action",
                             {"screen": "regal", "action": "direction", "value": "seitwärts"})
        self.assertEqual(status, 400)

    def test_box_session_opens_and_closes_from_the_screen(self):
        status, body = post(self.base() + "/box/session", {"box_id": 3})
        # No SMPL, so the box is unknown - that is an error the screen renders,
        # never an exception.
        self.assertEqual(status, 200)
        self.assertIn("ok", body)
        status, body = post(self.base() + "/box/session", {})
        self.assertTrue(body["ok"])


class TestWritesWithoutSmpl(KioskCase):
    def test_every_write_degrades_to_a_rendered_error(self):
        for path, payload in (
            ("/box/item", {"box_id": 3, "code": "4011923456789", "qty": 1}),
            ("/box/item/remove", {"box_id": 3, "item_id": 12, "qty": 1}),
            ("/rack/movement", {"article_id": 5, "movement_type": "intake", "qty": 1}),
            ("/rack/movement", {"article_id": 5, "movement_type": "checkout", "qty": 1,
                                "assignee_user_id": 4}),
        ):
            status, body = post(self.base() + path, payload)
            self.assertEqual(status, 200, path)
            self.assertFalse(body["ok"], path)
            self.assertIsNotNone(body["error"], path)

    def test_a_bad_movement_type_is_a_400(self):
        status, _body = post(self.base() + "/rack/movement",
                             {"article_id": 5, "movement_type": "teleport"})
        self.assertEqual(status, 400)

    def test_a_movement_smpl_does_not_accept_is_refused_here(self):
        # The agent's vocabulary is SMPL's: inventory_* used to be in it and
        # bought a round trip and a 400 from the server instead.
        status, _body = post(self.base() + "/rack/movement",
                             {"article_id": 5, "movement_type": "inventory_plus"})
        self.assertEqual(status, 400)

    def test_a_missing_article_id_is_a_400(self):
        status, _body = post(self.base() + "/rack/movement", {"movement_type": "checkout"})
        self.assertEqual(status, 400)


class TestTheSecondDoorOntoTheLedger(KioskCase):
    """POST /rack/movement is not the scan path, and used to prove it.

    A scanned Ausgabe with nobody tapped is refused by the router. The same
    booking posted through this route walked straight past that rule and wrote
    a checkout with assignee_user_id null — a tool out of the rack with nobody
    on it, which is the one question the ledger exists to answer.
    """

    def setUp(self) -> None:
        super().setUp()
        self.movements = Recorder(type("R", (), {"ok": True, "data": {}, "error": None})())
        self.agent.werkstatt.movement = self.movements

    def post_movement(self, **payload):
        body = {"article_id": 5, "movement_type": "checkout", "qty": 1}
        body.update(payload)
        return post(self.base() + "/rack/movement", body)

    def test_an_anonymous_checkout_is_refused_and_writes_nothing(self):
        status, body = self.post_movement()
        self.assertEqual(status, 400)
        self.assertIn("Namen", body["error"])
        self.assertEqual(self.movements.calls, [], "stock moved without a name on it")

    def test_the_wall_says_why_as_well_as_the_caller(self):
        self.post_movement()
        _s, state = self.state("regal")
        self.assertEqual(state["flash"]["level"], "error")
        self.assertEqual(state["flash"]["title"], scan_router.MSG_NEEDS_ASSIGNEE)

    def test_a_named_checkout_goes_through(self):
        status, body = self.post_movement(assignee_user_id=4)
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])
        self.assertEqual(self.movements.calls[0][1]["assignee_user_id"], 4)

    def test_a_rueckgabe_and_a_wareneingang_still_need_nobody(self):
        for movement in ("return", "intake"):
            status, body = self.post_movement(movement_type=movement)
            self.assertEqual(status, 200, movement)
            self.assertTrue(body["ok"], movement)
        self.assertEqual(len(self.movements.calls), 2)

    def test_the_rule_is_the_one_the_router_publishes(self):
        # One copy, so the two doors cannot disagree about what a name is.
        self.assertTrue(scan_router.movement_needs_assignee("checkout", None))
        self.assertEqual(scan_router.MOVEMENT_REQUIRING_ASSIGNEE, "checkout")


class TestAnActionBelongsToItsScreen(KioskCase):
    """``screen`` used to be validated and then ignored."""

    def test_the_box_screen_cannot_set_the_racks_direction(self):
        status, body = post(self.base() + "/screen/action",
                            {"screen": "kisten", "action": "direction", "value": "ein"})
        self.assertEqual(status, 400)
        self.assertIn("regal", body["error"])
        _s, state = self.state("regal")
        self.assertEqual(state["direction"], "aus")

    def test_the_box_screen_cannot_tap_a_name_onto_an_ausgabe(self):
        self.agent.kiosk.set_crew([{"id": 4, "name": "Max Mustermann"}])
        status, _body = post(self.base() + "/screen/action",
                             {"screen": "kisten", "action": "assignee", "value": 4})
        self.assertEqual(status, 400)
        self.assertIsNone(self.agent.router.assignee)

    def test_the_rack_screen_cannot_close_a_crate_or_switch_its_mode(self):
        post(self.base() + "/scan/route", {"code": "KISTE-K3"})
        for action, value in (("close_session", None), ("mode", "remove")):
            status, _body = post(self.base() + "/screen/action",
                                 {"screen": "regal", "action": action, "value": value})
            self.assertEqual(status, 400, action)
        _s, state = self.state("kisten")
        self.assertIsNotNone(state["session"])
        self.assertEqual(state["session"]["mode"], "add")

    def test_dismiss_and_qty_belong_to_both_screens(self):
        for screen in ("regal", "kisten"):
            status, _body = post(self.base() + "/screen/action",
                                 {"screen": screen, "action": "dismiss"})
            self.assertEqual(status, 200, screen)
            status, _body = post(self.base() + "/screen/action",
                                 {"screen": screen, "action": "qty", "value": 5})
            self.assertEqual(status, 200, screen)

    def test_each_screen_still_drives_its_own_buttons(self):
        post(self.base() + "/scan/route", {"code": "KISTE-K3"})
        for screen, action, value in (("regal", "direction", "ein"),
                                      ("kisten", "mode", "remove"),
                                      ("kisten", "close_session", None)):
            status, _body = post(self.base() + "/screen/action",
                                 {"screen": screen, "action": action, "value": value})
            self.assertEqual(status, 200, action)


# --------------------------------------------------------------------------
# Booting with nothing attached
# --------------------------------------------------------------------------


class TestBootsWithNothing(unittest.TestCase):
    def test_the_agent_boots_with_station_none(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        agent = server.Agent(
            server.Store(root / "inventory.db"),
            server.Printer(enabled=False),
            server.Upstream("", ""),
            station=None,
        )
        agent.start_background()
        self.addCleanup(agent.shutdown)
        http = server.Server(("127.0.0.1", 0), server.Handler, agent)
        port = http.server_address[1]
        thread = threading.Thread(target=http.serve_forever,
                                  kwargs={"poll_interval": 0.05}, daemon=True)
        thread.start()
        self.addCleanup(http.server_close)
        self.addCleanup(http.shutdown)

        base = "http://127.0.0.1:%d" % port
        status, body, _headers = get(base + "/health")
        self.assertEqual(status, 200)
        payload = json.loads(body.decode("utf-8"))
        self.assertTrue(payload["ok"])
        self.assertFalse(payload["identity"]["paired"])
        for key in ("scan_router", "scanner", "now_playing"):
            self.assertIn(key, payload)

        status, body, _headers = get(base + "/screen/state?screen=kisten&wait=0")
        self.assertEqual(status, 200)
        status, body, _headers = get(base + "/now-playing")
        self.assertFalse(json.loads(body.decode("utf-8"))["playing"])
        status, reply = post(base + "/scan/route", {"code": "SMPL-CMD-FERTIG"})
        self.assertEqual(status, 200)
        self.assertTrue(reply["ok"])


class TestHealth(KioskCase):
    def test_health_reports_the_scanner_the_router_and_the_widget(self):
        status, body, _headers = get(self.base() + "/health")
        self.assertEqual(status, 200)
        payload = json.loads(body.decode("utf-8"))
        self.assertIn("scanner", payload)
        self.assertEqual(set(("active", "device", "error")) - set(payload["scanner"]), set())
        self.assertIn("now_playing", payload)
        self.assertIn("scan_router", payload)
        self.assertEqual(payload["scan_router"]["direction"], "aus")

    def test_health_is_still_json_and_still_ok(self):
        status, body, _headers = get(self.base() + "/health")
        json.dumps(json.loads(body.decode("utf-8")))
        self.assertEqual(status, 200)

    def test_the_command_vocabulary_is_published_for_the_screens(self):
        status, body, _headers = get(self.base() + "/health")
        payload = json.loads(body.decode("utf-8"))
        self.assertEqual(sorted(payload["scan_router"]["commands"]),
                         sorted(scan_router.COMMAND_CODES))


# --------------------------------------------------------------------------
# The health chip on the wall (C1)
# --------------------------------------------------------------------------


MACHINE_OUT = {
    "id": 7, "unit_number": "M-0001", "article_id": 42,
    "article_name": "Bohrhammer TE 30", "manufacturer": "Hilti",
    "serial_number": "SN-99231", "status": "ausgegeben",
    "holder_user_id": 4, "holder_name": "Max Mustermann",
    "is_overdue": False, "inspection_required": True, "is_archived": False,
    "created_at": "2026-01-04T09:12:00", "components": [],
}
ARTICLE_RESOLVE = {"kind": "werkstatt_article",
                   "article": {"id": 5, "item_name": "Schraube M6x40",
                               "stock_available": 12, "stock_out": 0, "stock_total": 12}}


class Recorder:
    """Stands in for one WerkstattClient method and remembers the calls."""

    def __init__(self, result):
        self.result = result
        self.calls = []

    def __call__(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        return self.result


class TestUpstreamChip(KioskCase):
    """The chip says whether the SCREENS can reach SMPL.

    It used to be wired to the label agent's own Upstream, whose probe asked
    for a path that does not exist. Revoke the station token and both screens
    stayed green while every crate request came back 401 and the box screen
    said "Keine Baustellenkisten angelegt".

    Every test here drives a real HTTP server on a real socket and lets the
    client score its own answers. Stubbing ``werkstatt.status`` with a literal
    dict tested the wiring from the chip to a dictionary and never reached
    ``_note`` — which is where the second half of this bug lived: a 401 was
    scored "below 500, so the server is fine", and both screens stayed green.
    """

    def talk_to(self, routes):
        """Point the screens' client at a SMPL that answers like this."""
        stub = StubSmpl(routes)
        self.addCleanup(stub.close)
        self.agent.werkstatt.base_url = stub.base_url
        self.agent.upstream._note(True)          # the print path is perfectly happy
        return stub

    def chips(self):
        return {screen: self.state(screen)[1]["upstream"] for screen in ("regal", "kisten")}

    def test_a_revoked_station_is_a_red_chip_on_both_screens(self):
        self.talk_to({("GET", P["boxes"]): lambda p, q, h: (401, {"detail": "station revoked"})})
        self.agent._refresh_boxes(force=True)
        for screen, chip in self.chips().items():
            self.assertFalse(chip["ok"], screen)
            self.assertIn("401", chip["error"] or "", screen)

    def test_a_forbidden_station_is_red_too(self):
        self.talk_to({("GET", P["boxes"]): lambda p, q, h: (403, {"detail": "not your route"})})
        self.agent._refresh_boxes(force=True)
        for screen, chip in self.chips().items():
            self.assertFalse(chip["ok"], screen)

    def test_a_working_station_is_a_green_chip_on_both_screens(self):
        self.talk_to({("GET", P["boxes"]): lambda p, q, h: (200, [])})
        self.agent._refresh_boxes(force=True)
        for screen, chip in self.chips().items():
            self.assertTrue(chip["ok"], screen)
            self.assertIsNone(chip["error"], screen)

    def test_an_unknown_barcode_leaves_the_chip_green(self):
        # 404 on /resolve means "SMPL does not know this code", which is an
        # answer. A red chip on every mis-scan is a chip nobody believes.
        self.talk_to({("GET", P["resolve"]): lambda p, q, h: (404, {"detail": "nope"})})
        self.agent.werkstatt.resolve("4011923456789")
        for screen, chip in self.chips().items():
            self.assertTrue(chip["ok"], screen)

    def test_the_station_is_told_to_re_pair(self):
        self.talk_to({("GET", P["boxes"]): lambda p, q, h: (401, {"detail": "revoked"})})
        self.agent._refresh_boxes(force=True)
        status, body, _headers = get(self.base() + "/health")
        self.assertEqual(status, 200)
        self.assertTrue(json.loads(body.decode("utf-8"))["identity"]["token_rejected"])


class TestUpstreamPaths(unittest.TestCase):
    """Two paths, both of which used to be wrong in a way nothing reported."""

    def test_the_probe_asks_the_only_health_route_the_api_has(self):
        self.assertEqual(server.HEALTH_PATH, "/api/healthz")
        upstream = server.Upstream("http://smpl.invalid")
        asked = []
        upstream._get = lambda path, params=None: asked.append(path) or {}
        upstream.probe()
        self.assertEqual(asked, ["/api/healthz"])

    def test_a_404_on_the_health_path_is_an_outage_not_a_pass(self):
        # A 404 there means the base URL is wrong — which is exactly the
        # outage the probe exists to detect, so scoring it green is worse
        # than useless.
        upstream = server.Upstream("http://smpl.invalid")

        def not_found(path, params=None):
            raise urllib.error.HTTPError(path, 404, "Not Found", {}, None)

        upstream._get = not_found
        self.assertFalse(upstream.probe())
        self.assertIn("404", upstream.last_error)

    def test_resolve_asks_the_station_route(self):
        self.assertEqual(server.RESOLVE_PATH, "/api/station/werkstatt/resolve")
        upstream = server.Upstream("http://smpl.invalid")
        asked = []
        upstream._get = lambda path, params=None: asked.append((path, params)) or {"kind": "x"}
        upstream.resolve("4011923456789")
        self.assertEqual(asked, [("/api/station/werkstatt/resolve",
                                  {"code": "4011923456789"})])


class TestAForbiddenIsNotARevokedStation(KioskCase):
    def test_a_403_never_tells_the_operator_to_re_pair(self):
        # A 403 means "this route is not for a station token", which is a
        # routing bug in the agent, not a revoked credential. Sending somebody
        # to the Pi to re-pair a perfectly valid station is the wrong answer.
        def forbidden(path, params=None):
            raise urllib.error.HTTPError(path, 403, "Forbidden", {}, None)

        self.agent.upstream.base_url = "http://smpl.invalid"
        self.agent.upstream._get = forbidden
        self.assertIsNone(self.agent.upstream.resolve("4011923456789"))
        status, body, _headers = get(self.base() + "/health")
        self.assertEqual(status, 200)
        self.assertFalse(json.loads(body.decode("utf-8"))["identity"]["token_rejected"])

    def test_a_401_still_does(self):
        def unauthorised(path, params=None):
            raise urllib.error.HTTPError(path, 401, "Unauthorized", {}, None)

        self.agent.upstream.base_url = "http://smpl.invalid"
        self.agent.upstream._get = unauthorised
        self.assertIsNone(self.agent.upstream.resolve("4011923456789"))
        status, body, _headers = get(self.base() + "/health")
        self.assertTrue(json.loads(body.decode("utf-8"))["identity"]["token_rejected"])

    def test_the_werkstatt_clients_403_does_not_either(self):
        self.agent._note_station_auth(403)
        status, body, _headers = get(self.base() + "/health")
        self.assertFalse(json.loads(body.decode("utf-8"))["identity"]["token_rejected"])


# --------------------------------------------------------------------------
# "No crates" and "could not ask" are different answers (C2)
# --------------------------------------------------------------------------


class TestBoxStaleness(KioskCase):
    def test_the_box_screen_is_told_the_list_could_not_be_fetched(self):
        get(self.base() + "/boxes/state")          # the screen's own first read
        _status, state = self.state("kisten")
        for key in ("boxes_stale", "boxes_error", "boxes_fetched_at"):
            self.assertIn(key, state, key)
        self.assertTrue(state["boxes_stale"])
        self.assertIsNotNone(state["boxes_error"])
        self.assertIsNone(state["boxes_fetched_at"])

    def test_a_good_list_is_neither_stale_nor_an_error(self):
        self.agent.kiosk.set_boxes({"boxes": [{"id": 3, "box_number": "K3", "items": []}],
                                    "fetched_at": 1.7e9, "stale": False, "error": None})
        _status, state = self.state("kisten")
        self.assertFalse(state["boxes_stale"])
        self.assertIsNone(state["boxes_error"])
        self.assertEqual(state["boxes_fetched_at"], 1.7e9)
        self.assertEqual(len(state["boxes"]), 1)


# --------------------------------------------------------------------------
# A machine is not an article (C3)
# --------------------------------------------------------------------------


class TestMachineScans(KioskCase):
    def test_a_machine_scan_lands_as_a_machine_card(self):
        self.agent.werkstatt.resolve = lambda code: {"kind": "machine",
                                                     "machine": dict(MACHINE_OUT)}
        status, body = post(self.base() + "/scan/route", {"code": "M-0001"})
        self.assertEqual(status, 200)
        self.assertEqual(body["routed_to"], "regal")
        _s, state = self.state("regal")
        machine = state["last"]["machine"]
        self.assertEqual(machine["unit_number"], "M-0001")
        self.assertEqual(machine["article_name"], "Bohrhammer TE 30")
        self.assertEqual(machine["status"], "ausgegeben")
        self.assertEqual(machine["holder_name"], "Max Mustermann")

    def test_the_stock_counters_are_absent_not_zero(self):
        self.agent.werkstatt.resolve = lambda code: {"kind": "machine",
                                                     "machine": dict(MACHINE_OUT)}
        post(self.base() + "/scan/route", {"code": "M-0001"})
        _s, state = self.state("regal")
        # A tool has no stock. An empty article row is how the screen ended up
        # showing "–" and 0/0/0 for a drill somebody was holding.
        self.assertIsNone(state["last"]["article"])

    def test_an_overdue_tool_carries_the_flag_the_badge_is_drawn_from(self):
        self.agent.werkstatt.resolve = lambda code: {
            "kind": "machine", "machine": dict(MACHINE_OUT, is_overdue=True)}
        post(self.base() + "/scan/route", {"code": "M-0001"})
        _s, state = self.state("regal")
        self.assertIs(state["last"]["machine"]["is_overdue"], True)

    def test_scanning_a_machine_at_the_rack_says_nothing_was_booked(self):
        # It books nothing — machine Ausgabe and Rückgabe live in SMPL — and a
        # green tick under a drill's name is read across a workshop as "it is
        # booked out to me". A worker walked off with a tool the ledger never
        # saw.
        movements = Recorder(type("R", (), {"ok": True, "data": {}, "error": None})())
        self.agent.werkstatt.movement = movements
        self.agent.werkstatt.resolve = lambda code: {"kind": "machine",
                                                     "machine": dict(MACHINE_OUT)}
        post(self.base() + "/scan/route", {"code": "M-0001"})
        _s, state = self.state("regal")
        self.assertEqual(movements.calls, [], "a machine scan wrote to the ledger")
        self.assertEqual(state["flash"]["level"], "warn")
        self.assertEqual(state["flash"]["title"], server.MSG_MACHINE_LOOKUP_ONLY)
        self.assertIn("Nichts gebucht", state["flash"]["detail"])
        self.assertIn("SMPL", state["flash"]["detail"])

    def test_the_rack_state_says_the_same_as_the_flash(self):
        # kiosk_rack.html shows its own "Nicht gebucht — Maschine nur
        # nachgeschlagen" note exactly when the state carries no movement, so
        # this is the state half of the same sentence.
        self.agent.werkstatt.resolve = lambda code: {"kind": "machine",
                                                     "machine": dict(MACHINE_OUT)}
        post(self.base() + "/scan/route", {"code": "M-0001"})
        _s, state = self.state("regal")
        self.assertIsNone(state["last"]["movement"])
        self.assertIsNone(state["last"]["article"])
        self.assertIsNotNone(state["last"]["machine"])

    def test_the_box_screen_can_see_what_it_turned_away(self):
        self.agent.werkstatt.resolve = lambda code: {"kind": "machine",
                                                     "machine": dict(MACHINE_OUT)}
        post(self.base() + "/scan/route", {"code": "KISTE-K3"})
        post(self.base() + "/scan/route", {"code": "M-0001"})
        _s, state = self.state("kisten")
        self.assertIn("last", state)
        self.assertEqual(state["last"]["machine"]["unit_number"], "M-0001")
        self.assertEqual(state["flash"]["level"], "error")


# --------------------------------------------------------------------------
# The safety net under the scanner layout
# --------------------------------------------------------------------------


#: The German table's hyphen was measured; its Y/Z swap was read off the XKB
#: layout files. This is the net under that inference — and it matters because
#: CODE_ALPHABET contains both letters, so a wrong table turns a real article
#: into "SMPL kennt diesen Code nicht" with nothing to say why.
ZED = "SMPL-RPJNZH"        # what the scanner typed
WYE = "SMPL-RPJNYH"        # what the label says, and what SMPL knows


class TestTheLayoutIsAnAgentSetting(unittest.TestCase):
    """The table the scanner is read through is configuration, not a constant.

    The office scanner sends German scancodes (measured — see input_reader),
    but a replacement may be configured for US, and re-flashing a scanner is
    not a thing anybody wants to do from a workshop floor.
    """

    def agent_with(self, **kwargs):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        agent = server.Agent(
            server.Store(Path(tmp.name) / "inventory.db"),
            server.Printer(enabled=False),
            server.Upstream("", ""),
            station=None,
            **kwargs,
        )
        self.addCleanup(agent.shutdown)
        return agent

    def test_german_is_what_an_agent_gets_by_default(self):
        self.assertEqual(server.SCANNER_LAYOUT, "de")
        agent = self.agent_with()
        self.assertEqual(agent.scanner.layout, "de")
        self.assertEqual(agent.scanner.status()["layout"], "de")

    def test_the_setting_reaches_the_reader(self):
        agent = self.agent_with(scanner_layout="us")
        self.assertEqual(agent.scanner.layout, "us")

    def test_a_typo_is_the_default_rather_than_a_dead_scanner(self):
        agent = self.agent_with(scanner_layout="klingon")
        self.assertEqual(agent.scanner.layout, "de")

    def test_the_command_line_carries_it_like_every_other_setting(self):
        args = server.build_parser().parse_args([])
        self.assertEqual(args.scanner_layout, "de")
        args = server.build_parser().parse_args(["--scanner-layout", "us"])
        self.assertEqual(args.scanner_layout, "us")

    def test_health_reports_the_layout_in_use(self):
        agent = self.agent_with(scanner_layout="us")
        self.assertEqual(agent.health()["scanner"]["layout"], "us")


class TestTheLayoutSafetyNet(KioskCase):
    def setUp(self) -> None:
        super().setUp()
        self.asked: list = []
        self.logged: list = []
        self.agent._log = self.logged.append
        self.agent.kiosk.set_crew([{"id": 4, "name": "Max Mustermann"}])

    def smpl(self, known=(WYE,), status=200):
        def resolve(payload, query, hits):
            code = (query.get("code") or "").upper()
            self.asked.append(code)
            if status != 200:
                return status, {"detail": "SMPL is having a moment"}
            if code in known:
                return 200, {"kind": "werkstatt_article",
                             "article": {"id": 5, "item_name": "Schraube M6x40"}}
            return 200, {"kind": "not_found"}

        stub = StubSmpl({
            ("GET", P["resolve"]): resolve,
            ("POST", P["movements"]): lambda p, q, h: (200, {"movement_id": 1,
                                                             "article": {"id": 5}}),
        })
        self.addCleanup(stub.close)
        self.agent.werkstatt.base_url = stub.base_url
        return stub

    def tap_a_name(self):
        self.agent.screen_action("regal", "assignee", 4)

    def test_a_code_smpl_does_not_know_is_retried_with_y_and_z_swapped(self):
        stub = self.smpl()
        self.tap_a_name()
        answer = post(self.base() + "/scan/route", {"code": ZED})[1]
        self.assertEqual(self.asked, [ZED, WYE])
        self.assertEqual(answer["action"], "movement")
        booked = [r for r in stub.requests if r[1] == P["movements"]]
        self.assertEqual(len(booked), 1, "the swapped hit did not book")
        self.assertEqual(booked[0][3]["article_id"], 5)

    def test_the_swapped_spelling_is_what_the_screen_shows(self):
        self.smpl()
        self.tap_a_name()
        answer = post(self.base() + "/scan/route", {"code": ZED})[1]
        self.assertEqual(answer["code"], WYE)

    def test_it_works_the_other_way_round_too(self):
        # A US-configured scanner against a German table: the Y is the typo.
        self.smpl(known=(ZED,))
        self.tap_a_name()
        post(self.base() + "/scan/route", {"code": WYE})
        self.assertEqual(self.asked, [WYE, ZED])

    def test_the_retry_happens_at_most_once(self):
        self.smpl(known=())          # neither spelling exists
        self.tap_a_name()
        answer = post(self.base() + "/scan/route", {"code": ZED})[1]
        self.assertEqual(self.asked, [ZED, WYE], "the swap was retried more than once")
        self.assertEqual(answer["code"], ZED, "an unknown code kept the swapped spelling")

    def test_a_code_with_no_y_or_z_is_never_retried(self):
        self.smpl(known=())
        self.tap_a_name()
        post(self.base() + "/scan/route", {"code": "4011923456789"})
        self.assertEqual(self.asked, ["4011923456789"])

    def test_a_code_that_resolves_first_time_is_never_retried(self):
        self.smpl(known=(ZED,))
        self.tap_a_name()
        post(self.base() + "/scan/route", {"code": ZED})
        self.assertEqual(self.asked, [ZED])

    def test_an_outage_is_not_retried_either(self):
        # Every code is a miss when SMPL is down, and doubling the timeout on
        # the one path that must stay under five seconds buys nothing.
        self.smpl(status=503)
        self.tap_a_name()
        post(self.base() + "/scan/route", {"code": ZED})
        self.assertEqual(self.asked, [ZED])

    def test_the_operator_gets_one_warning_not_one_per_scan(self):
        self.smpl()
        self.tap_a_name()
        post(self.base() + "/scan/route", {"code": ZED})
        time.sleep(0.2)                                  # past the de-dupe window
        post(self.base() + "/scan/route", {"code": ZED})
        warnings = [line for line in self.logged if "layout" in line]
        self.assertEqual(len(warnings), 1, self.logged)
        self.assertIn("Y and Z", warnings[0])
        self.assertIn("scanner-layout", warnings[0])

    def test_the_echo_of_a_swapped_scan_still_books_only_once(self):
        # Two readers deliver the same trigger pull. Both take the same
        # deterministic path, so the router's de-dupe window sees two
        # identical codes rather than a raw one and a swapped one.
        stub = self.smpl()
        self.tap_a_name()
        post(self.base() + "/scan/route", {"code": ZED, "source": "evdev"})
        second = post(self.base() + "/scan/route", {"code": ZED, "source": "wedge"})[1]
        self.assertTrue(second["duplicate"])
        booked = [r for r in stub.requests if r[1] == P["movements"]]
        self.assertEqual(len(booked), 1, "one trigger pull booked stock twice")


# --------------------------------------------------------------------------
# One clock for the whole kiosk (C6)
# --------------------------------------------------------------------------


class TestOneTimeBase(unittest.TestCase):
    def test_the_injected_clock_reaches_the_kiosk_and_the_client(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        clock = lambda: 555.0                                   # noqa: E731
        agent = server.Agent(
            server.Store(root / "inventory.db"),
            server.Printer(enabled=False),
            server.Upstream("", ""),
            station=None,
            clock=clock,
        )
        self.addCleanup(agent.shutdown)
        self.assertIs(agent.werkstatt._clock, clock)
        agent.kiosk.flash("regal", "ok", "Titel")
        self.assertEqual(agent.kiosk.snapshot("regal")["flash"]["at"], 555.0)
        # And the router shares it, so the countdown and the flash agree.
        agent.router.open_session("KISTE-K3")
        self.assertEqual(agent.kiosk.snapshot("kisten")["session"]["opened_at"], 555.0)


# --------------------------------------------------------------------------
# The de-dupe window is judged on arrival, not after the network (A1)
# --------------------------------------------------------------------------


class TestArrivalTimeDedupe(unittest.TestCase):
    """One trigger pull, two readers, a four-second resolve in between.

    The evdev reader and a focused browser wedge both deliver the same scan
    about 20 ms apart. The de-dupe window is 150 ms — but the agent resolves
    an unknown code against SMPL first, and that is allowed four seconds. The
    window used to be judged after that call, so the echo booked stock twice.
    """

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.now = [1000.0]
        self.agent = server.Agent(
            server.Store(Path(self.tmp.name) / "inventory.db"),
            server.Printer(enabled=False),
            server.Upstream("http://smpl.invalid", ""),
            station=None,
            clock=lambda: self.now[0],
        )
        self.addCleanup(self.agent.shutdown)
        self.movements = Recorder(type("R", (), {"ok": True, "data": {}, "error": None})())
        self.agent.werkstatt.movement = self.movements
        self.agent.werkstatt.base_url = "http://smpl.invalid"
        self.agent.router.set_assignee({"id": 4, "name": "Max Mustermann"})

    def test_the_echo_of_a_slow_scan_is_still_an_echo(self):
        # The two readers deliver 20 ms apart and resolve at different
        # speeds, so they finish in the wrong order: the echo books first and
        # the original lands four seconds later. Judged on when they *arrived*
        # they are 20 ms apart and the second one is dropped; judged on when
        # the resolve returned they are four seconds apart, and the workshop
        # is short one drill bit it never took.
        blocked = threading.Event()
        entered = threading.Event()

        def resolve(code: str):
            if not entered.is_set():
                entered.set()
                blocked.wait(10.0)
                self.now[0] += 4.0          # this call took four seconds
            return dict(ARTICLE_RESOLVE)

        self.agent.werkstatt.resolve = resolve
        answers = {}
        evdev = threading.Thread(
            target=lambda: answers.update(
                first=self.agent.route_scan("4011923456789", source="evdev")),
            daemon=True)
        evdev.start()
        self.assertTrue(entered.wait(5.0), "the first resolve never started")

        self.now[0] += 0.020                # the wedge delivers 20 ms later
        answers["second"] = self.agent.route_scan("4011923456789", source="wedge")
        blocked.set()
        evdev.join(10.0)
        self.assertFalse(evdev.is_alive())

        booked = [answer for answer in answers.values() if not answer["duplicate"]]
        self.assertEqual(len(booked), 1, "one trigger pull booked stock twice")
        self.assertEqual(len(self.movements.calls), 1)

    def test_a_duplicate_never_pays_for_the_resolve(self):
        resolves = []

        def resolve(code: str):
            resolves.append(code)
            return dict(ARTICLE_RESOLVE)

        self.agent.werkstatt.resolve = resolve
        self.agent.route_scan("4011923456789")
        self.now[0] += 0.020
        second = self.agent.route_scan("4011923456789")
        self.assertTrue(second["duplicate"])
        self.assertEqual(len(resolves), 1, "the echo cost a round trip")

    def test_a_real_second_scan_still_books(self):
        self.agent.werkstatt.resolve = lambda code: dict(ARTICLE_RESOLVE)
        self.agent.route_scan("4011923456789")
        self.now[0] += 5.0
        second = self.agent.route_scan("4011923456789")
        self.assertFalse(second["duplicate"])
        self.assertEqual(len(self.movements.calls), 2)


# --------------------------------------------------------------------------
# A failed undo is not a lost undo (A6)
# --------------------------------------------------------------------------


class TestUndoSurvivesAFailure(KioskCase):
    def test_an_undo_that_smpl_refused_can_be_tried_again(self):
        failed = type("R", (), {"ok": False, "data": None,
                                "error": "SMPL ist nicht erreichbar."})()
        self.agent.werkstatt.movement = Recorder(failed)
        self.agent.router.note_commit(screen="regal", action="movement", article_id=5,
                                      movement_type="checkout", qty=2)
        _status, first = post(self.base() + "/scan/route", {"code": "SMPL-CMD-ABBRUCH"})
        self.assertEqual(first["action"], "undo_movement")
        _s, state = self.state("regal")
        self.assertEqual(state["flash"]["title"], "Abbruch fehlgeschlagen")

        time.sleep(0.2)                      # past the de-dupe window
        _status, second = post(self.base() + "/scan/route", {"code": "SMPL-CMD-ABBRUCH"})
        self.assertEqual(second["action"], "undo_movement",
                         "one network blip cost the operator the undo")

    def test_an_undo_that_landed_is_forgotten(self):
        ok = type("R", (), {"ok": True, "data": {}, "error": None})()
        self.agent.werkstatt.movement = Recorder(ok)
        self.agent.router.note_commit(screen="regal", action="movement", article_id=5,
                                      movement_type="checkout", qty=2)
        _status, first = post(self.base() + "/scan/route", {"code": "SMPL-CMD-ABBRUCH"})
        self.assertEqual(first["action"], "undo_movement")
        time.sleep(0.2)
        _status, second = post(self.base() + "/scan/route", {"code": "SMPL-CMD-ABBRUCH"})
        self.assertEqual(second["action"], "nothing_to_undo")


# --------------------------------------------------------------------------
# Three directions, and a name before an Ausgabe (the contract delta)
# --------------------------------------------------------------------------


class TestDirectionsAndAssignee(KioskCase):
    def setUp(self) -> None:
        super().setUp()
        self.movements = Recorder(type("R", (), {"ok": True,
                                                 "data": {"article": {"item_name": "Schraube"},
                                                          "movement_id": 1},
                                                 "error": None})())
        self.agent.werkstatt.movement = self.movements
        self.agent.werkstatt.resolve = lambda code: dict(ARTICLE_RESOLVE)
        self.agent.werkstatt.base_url = "http://smpl.invalid"

    def tap(self, value, *, in_crew=True):
        """Tap a name on the rack screen.

        The crew is seeded first by default, because the buttons the operator
        presses are built from that very list — an id from outside it is
        refused (see TestAnAssigneeIsSomebodyTheScreenOffered).
        """
        if in_crew and isinstance(value, int):
            self.agent.kiosk.set_crew([{"id": value, "name": "Max Mustermann"}])
        return post(self.base() + "/screen/action",
                    {"screen": "regal", "action": "assignee", "value": value})

    def direction(self, value):
        return post(self.base() + "/screen/action",
                    {"screen": "regal", "action": "direction", "value": value})

    def test_the_rack_screen_publishes_the_crew_and_the_assignee(self):
        _s, state = self.state("regal")
        self.assertIn("crew", state)
        self.assertIsInstance(state["crew"], list)
        self.assertIn("assignee", state)
        self.assertIsNone(state["assignee"])

    def test_the_crew_is_empty_rather_than_missing_without_smpl(self):
        _s, state = self.state("regal")
        self.assertEqual(state["crew"], [])

    def test_tapping_a_name_shows_it_on_the_screen(self):
        status, body = self.tap(4)
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])
        _s, state = self.state("regal")
        self.assertEqual(state["assignee"], {"id": 4, "name": "Max Mustermann"})
        self.assertEqual(state["crew"], [{"id": 4, "name": "Max Mustermann"}])

    def test_a_null_clears_the_name(self):
        self.tap(4)
        self.tap(None)
        _s, state = self.state("regal")
        self.assertIsNone(state["assignee"])

    def test_an_ausgabe_without_a_name_writes_nothing(self):
        status, body = post(self.base() + "/scan/route", {"code": "4011923456789"})
        self.assertEqual(status, 200)
        self.assertFalse(body["ok"])
        self.assertEqual(body["action"], "needs_assignee")
        self.assertEqual(self.movements.calls, [], "stock moved without a name on it")
        _s, state = self.state("regal")
        self.assertEqual(state["flash"]["level"], "error")
        self.assertEqual(state["flash"]["title"], "Bitte zuerst Namen antippen")

    def test_an_ausgabe_with_a_name_carries_it_to_smpl(self):
        self.tap(4)
        post(self.base() + "/scan/route", {"code": "4011923456789"})
        self.assertEqual(len(self.movements.calls), 1)
        args, kwargs = self.movements.calls[0]
        self.assertEqual(args[0], 5)                      # article_id
        self.assertEqual(args[1], "checkout")
        self.assertEqual(kwargs["assignee_user_id"], 4)

    def test_a_rueckgabe_needs_no_name_but_takes_one(self):
        self.direction("ein")
        post(self.base() + "/scan/route", {"code": "4011923456789"})
        args, kwargs = self.movements.calls[0]
        self.assertEqual(args[1], "return")
        self.assertIsNone(kwargs["assignee_user_id"])

    def test_a_wareneingang_is_an_intake_with_nobody_on_it(self):
        self.tap(4)
        self.direction("wareneingang")
        _s, state = self.state("regal")
        self.assertEqual(state["direction"], "wareneingang")
        post(self.base() + "/scan/route", {"code": "4011923456789"})
        args, kwargs = self.movements.calls[0]
        self.assertEqual(args[1], "intake")
        self.assertIsNone(kwargs["assignee_user_id"])

    def test_an_unknown_direction_is_still_a_400(self):
        status, _body = self.direction("seitwärts")
        self.assertEqual(status, 400)

    def test_a_nonsense_assignee_is_a_400(self):
        status, _body = self.tap("Max")
        self.assertEqual(status, 400)

    def test_the_name_is_cleared_after_two_minutes_of_nothing(self):
        self.agent.router.assignee_timeout_s = 0.0
        self.tap(4)
        self.assertTrue(self.agent.router.expire_assignee())
        _s, state = self.state("regal")
        self.assertIsNone(state["assignee"])
        # And the next Ausgabe asks again rather than booking onto them.
        status, body = post(self.base() + "/scan/route", {"code": "4011923456789"})
        self.assertEqual(body["action"], "needs_assignee")


class TestOneWordPerDirection(KioskCase):
    """Ausgabe, Rückgabe, Wareneingang — and Entnahme is not one of them.

    docs/PI_STATION.md is explicit: *Entnahme* names the crate's
    take-back-out mode (SMPL-CMD-ENTNAHME) and nothing else; a rack booking
    that takes stock out is an **Ausgabe**. The label map said "Entnahme", so
    the wall and the log disagreed about the same movement.
    """

    def test_the_rack_label_is_the_word_the_screens_and_the_docs_use(self):
        self.assertEqual(server.DIRECTION_LABEL["aus"], "Ausgabe")
        self.assertEqual(server.DIRECTION_LABEL["ein"], "Rückgabe")
        self.assertEqual(server.DIRECTION_LABEL["wareneingang"], "Wareneingang")
        self.assertNotIn("Entnahme", server.DIRECTION_LABEL.values())

    def test_every_direction_has_exactly_one_word(self):
        self.assertEqual(sorted(server.DIRECTION_LABEL), sorted(scan_router.DIRECTIONS))
        self.assertEqual(len(set(server.DIRECTION_LABEL.values())),
                         len(server.DIRECTION_LABEL))

    def test_changing_the_direction_says_ausgabe_on_the_wall(self):
        post(self.base() + "/scan/route", {"code": "SMPL-CMD-AUS"})
        _s, state = self.state("regal")
        self.assertEqual(state["flash"]["title"], "Ausgabe")

    def test_a_booked_movement_says_ausgabe_too(self):
        self.agent.kiosk.set_crew([{"id": 4, "name": "Max Mustermann"}])
        self.agent.screen_action("regal", "assignee", 4)
        self.agent.werkstatt.resolve = lambda code: dict(ARTICLE_RESOLVE)
        self.agent.werkstatt.movement = Recorder(
            type("R", (), {"ok": True, "data": {"article": {"item_name": "Schraube"}},
                           "error": None})())
        post(self.base() + "/scan/route", {"code": "4011923456789"})
        _s, state = self.state("regal")
        self.assertIn("Ausgabe", state["flash"]["detail"])
        self.assertNotIn("Entnahme", state["flash"]["detail"])

    def test_the_crate_keeps_the_word_entnahme(self):
        # It is the crate's mode, and the only place the word belongs.
        post(self.base() + "/scan/route", {"code": "KISTE-K3"})
        post(self.base() + "/scan/route", {"code": "SMPL-CMD-ENTNAHME"})
        _s, state = self.state("kisten")
        self.assertIn("Entnahme", state["flash"]["title"])


class TestAnAssigneeIsSomebodyTheScreenOffered(KioskCase):
    """The tapped id has to be a name the station can actually print.

    An id from outside the crew list published ``{"id": 7, "name": null}``,
    which breaks the screen contract's ``name: string``: the wall shows a
    nameless chip and the tool goes out to somebody the station cannot name.
    """

    def tap(self, value):
        return post(self.base() + "/screen/action",
                    {"screen": "regal", "action": "assignee", "value": value})

    def test_an_id_in_no_crew_list_is_refused(self):
        self.agent.kiosk.set_crew([{"id": 4, "name": "Max Mustermann"}])
        status, body = self.tap(99)
        self.assertEqual(status, 400)
        self.assertIn("99", body["error"])
        self.assertIsNone(self.agent.router.assignee)

    def test_a_tap_with_no_crew_at_all_is_refused_rather_than_nameless(self):
        status, _body = self.tap(4)
        self.assertEqual(status, 400)
        _s, state = self.state("regal")
        self.assertIsNone(state["assignee"])

    def test_the_published_assignee_always_has_a_name(self):
        self.agent.kiosk.set_crew([{"id": 4, "name": "Max Mustermann"}])
        self.tap(4)
        _s, state = self.state("regal")
        self.assertEqual(state["assignee"], {"id": 4, "name": "Max Mustermann"})
        self.assertIsInstance(state["assignee"]["name"], str)

    def test_clearing_is_still_allowed_with_no_crew(self):
        # A null is not an id: taking a name off must never depend on a cache.
        status, _body = self.tap(None)
        self.assertEqual(status, 200)
        self.assertIsNone(self.agent.router.assignee)


# --------------------------------------------------------------------------
# The two-minute name expiry, through the wiring that actually runs it
# --------------------------------------------------------------------------


class TestTheNameExpiresThroughTheRealTick(unittest.TestCase):
    """The tick is what clears a name in the workshop, so the tick is tested.

    Calling ``expire_assignee`` with the timeout set to zero proves the router
    rule and nothing about whether anything ever calls it — which is the half
    that was missing.
    """

    def test_the_default_is_two_minutes(self):
        self.assertEqual(scan_router.DEFAULT_ASSIGNEE_TIMEOUT_S, 120.0)

    def build_agent(self, now):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        agent = server.Agent(
            server.Store(Path(tmp.name) / "inventory.db"),
            server.Printer(enabled=False),
            server.Upstream("", ""),
            station=None,
            clock=lambda: now[0],
        )
        self.addCleanup(agent.shutdown)
        agent.kiosk.set_crew([{"id": 4, "name": "Max Mustermann"}])
        return agent

    def test_one_tick_after_two_minutes_clears_the_name_and_says_so(self):
        now = [1000.0]
        agent = self.build_agent(now)
        agent.screen_action("regal", "assignee", 4)
        self.assertEqual(agent.router.assignee["id"], 4)

        now[0] += scan_router.DEFAULT_ASSIGNEE_TIMEOUT_S - 1
        agent.tick_once()
        self.assertIsNotNone(agent.router.assignee, "cleared a name that is still fresh")

        now[0] += 2
        agent.tick_once()
        self.assertIsNone(agent.router.assignee)
        flash = agent.kiosk.snapshot("regal")["flash"]
        self.assertEqual(flash["level"], "warn")
        self.assertEqual(flash["title"], "Name zurückgesetzt")

    def test_the_next_ausgabe_asks_again_rather_than_booking_onto_them(self):
        now = [1000.0]
        agent = self.build_agent(now)
        agent.screen_action("regal", "assignee", 4)
        now[0] += scan_router.DEFAULT_ASSIGNEE_TIMEOUT_S + 1
        agent.tick_once()
        answer = agent.route_scan("4011923456789")
        self.assertEqual(answer["action"], "needs_assignee")
        self.assertFalse(answer["ok"])

    def test_a_tick_under_a_scanning_operator_keeps_the_name(self):
        # Scanning under a name is proof somebody is standing there.
        now = [1000.0]
        agent = self.build_agent(now)
        agent.screen_action("regal", "assignee", 4)
        now[0] += 100
        agent.route_scan("4011923456789")
        now[0] += 100
        agent.tick_once()
        self.assertEqual(agent.router.assignee["id"], 4)



class TestTheCommandCodesFitTheWall(unittest.TestCase):
    """The box screen is scanner-only, so a clipped command is a dead end.

    The five codes it first showed were drawn at the endpoint's default
    module width, wrapped onto three rows, and were cut off by the strip's
    own max-height: the mode toggle and both quantity codes never reached
    the glass. This pins the arithmetic that stopped it happening again -
    what the page asks for, and whether it fits the panel it is shown on.
    """

    PANEL_CSS_WIDTH = 1920  # 3840 device px at --force-device-scale-factor=2
    PAGE = pathlib.Path(__file__).resolve().parents[1] / "static" / "kiosk_boxes.html"

    def _requested(self):
        html = self.PAGE.read_text(encoding="utf-8")
        out = []
        for src in re.findall(r'src="(/barcode\.svg\?[^"]+)"', html):
            query = urllib.parse.parse_qs(src.split("?", 1)[1].replace("&amp;", "&"))
            out.append((query["text"][0], int(query["m"][0]), int(query["h"][0])))
        return out

    def test_every_command_image_asks_for_an_explicit_module_width(self):
        asked = self._requested()
        self.assertTrue(asked, "the box page shows no command barcodes at all")
        for text, module, _height in asked:
            self.assertGreaterEqual(module, 2, "%s would be too fine to scan" % text)

    def test_they_fit_across_the_panel_in_one_row(self):
        import barcode128

        asked = self._requested()
        total = sum(barcode128.module_width(t) * m for t, m, _ in asked)
        # Leave room for the gaps and padding around each card.
        self.assertLess(
            total, self.PANEL_CSS_WIDTH * 0.8,
            "the command codes need %d px of a %d px panel; they will wrap and be clipped"
            % (total, self.PANEL_CSS_WIDTH),
        )

    def test_each_one_is_a_command_the_router_actually_implements(self):
        source = (pathlib.Path(__file__).resolve().parents[1] / "scan_router.py").read_text(
            encoding="utf-8"
        )
        for text, _m, _h in self._requested():
            self.assertIn(
                text, source,
                "the box screen offers %s but scan_router never mentions it" % text,
            )


if __name__ == "__main__":
    unittest.main()
