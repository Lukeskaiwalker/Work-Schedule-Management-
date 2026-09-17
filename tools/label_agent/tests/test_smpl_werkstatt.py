"""The station's client for boxes, resolves, items and movements.

The server half of this contract is being written in parallel, so the thing
worth testing is not the happy path but every shape of absence: SMPL not
configured, SMPL unreachable, SMPL answering 401 because somebody revoked the
station, SMPL answering something that is not JSON at all.

The rule this module exists to keep is one line long: **nothing here may raise
into a request handler.** A crate screen that renders a stale box list is
useful. A crate screen showing a 500 because a switch rebooted is not.

The stub binds port 0, so these tests never collide with a running agent.
"""

from __future__ import annotations

import ast
import json
import sys
import threading
import unittest
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

import smpl_werkstatt  # noqa: E402


class StubSmpl:
    """A SMPL station API with a scripted opinion about every route."""

    def __init__(self, routes) -> None:
        self.routes = routes           # (method, path) -> callable(payload, query, hits)
        self.hits = {}
        self.requests = []             # (method, path, headers, payload)
        outer = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args):
                pass

            def _serve(self, method):
                parsed = urllib.parse.urlparse(self.path)
                query = {k: v[0] for k, v in urllib.parse.parse_qs(parsed.query).items()}
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length) if length else b""
                try:
                    payload = json.loads(raw.decode("utf-8")) if raw else {}
                except ValueError:
                    payload = {}
                key = (method, parsed.path)
                outer.hits[key] = outer.hits.get(key, 0) + 1
                outer.requests.append((method, parsed.path, dict(self.headers), payload))
                route = outer.routes.get(key)
                if route is None:
                    return self._reply(404, {"detail": "no route"})
                status, body = route(payload, query, outer.hits[key])
                return self._reply(status, body)

            def do_GET(self):  # noqa: N802
                self._serve("GET")

            def do_POST(self):  # noqa: N802
                self._serve("POST")

            def _reply(self, status, body):
                blob = body if isinstance(body, bytes) else json.dumps(body).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(blob)))
                self.end_headers()
                self.wfile.write(blob)

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._server.daemon_threads = True
        self.port = self._server.server_address[1]
        self._thread = threading.Thread(target=self._server.serve_forever,
                                        kwargs={"poll_interval": 0.05}, daemon=True)
        self._thread.start()

    @property
    def base_url(self) -> str:
        return "http://127.0.0.1:%d" % self.port

    def close(self) -> None:
        self._server.shutdown()
        self._server.server_close()


BOX = {
    "id": 3, "box_number": "K3", "code": "KISTE-K3", "label": "Verteiler UG",
    "status": "gepackt", "customer": "Müller GmbH", "project": "Neubau Nord",
    "items": [{"id": 12, "item_name": "Schraube M6x40", "article_no": "SP-1042",
               "quantity": 4, "unit": "Stk", "article_id": 5}],
}

P = smpl_werkstatt.PATHS

# One machine, exactly as ``MachineOut`` serialises it. Copied field-for-field
# from apps/api/app/schemas/werkstatt_machines.py: ``article_id`` is FLAT.
# There is no ``machine["article"]["id"]`` and there never was, which is why
# the nested lookup that used to be here was dead code — and why scanning a
# drill booked nothing and showed a dash.
MACHINE_OUT = {
    "id": 7,
    "unit_number": "M-0001",
    "article_id": 42,
    "article_name": "Bohrhammer TE 30",
    "manufacturer": "Hilti",
    "parent_unit_id": None,
    "serial_number": "SN-99231",
    "status": "ausgegeben",
    "current_location_id": None,
    "current_location_name": None,
    "holder_user_id": 4,
    "holder_name": "Max Mustermann",
    "booked_from": "2026-09-10T07:00:00",
    "booked_until": None,
    "is_overdue": False,
    "inspection_required": True,
    "inspection_interval_days": 365,
    "last_inspected_at": "2026-03-01T00:00:00",
    "next_inspection_due_at": "2027-03-01T00:00:00",
    "inspection_overdue": False,
    "purchased_at": None,
    "notes": None,
    "is_archived": False,
    "created_at": "2026-01-04T09:12:00",
    "components": [],
}
MACHINE_RESOLVE = {"kind": "machine", "machine": MACHINE_OUT}


class Clock:
    def __init__(self, start=1000.0):
        self.now = float(start)

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds
        return self.now


class ClientCase(unittest.TestCase):
    routes: dict = {}

    def setUp(self) -> None:
        self.stub = StubSmpl(dict(self.routes))
        self.addCleanup(self.stub.close)
        self.clock = Clock()
        self.auth_events = []
        self.client = smpl_werkstatt.WerkstattClient(
            self.stub.base_url, token_provider=lambda: "station-token-abc",
            clock=self.clock, timeout=2.0, box_ttl_s=10.0,
            on_auth=self.auth_events.append,
        )


def ok_boxes(payload, query, hits):
    return 200, [BOX]


# --------------------------------------------------------------------------
# Boxes and the cache
# --------------------------------------------------------------------------


class TestBoxes(ClientCase):
    routes = {("GET", P["boxes"]): ok_boxes}

    def test_a_fresh_snapshot_is_not_stale(self):
        snapshot = self.client.boxes()
        self.assertFalse(snapshot["stale"])
        self.assertIsNone(snapshot["error"])
        self.assertEqual(snapshot["boxes"][0]["box_number"], "K3")
        self.assertEqual(snapshot["fetched_at"], 1000.0)

    def test_the_snapshot_is_cached_inside_the_ttl(self):
        self.client.boxes()
        self.clock.advance(5)
        self.client.boxes()
        self.assertEqual(self.stub.hits[("GET", P["boxes"])], 1)

    def test_the_snapshot_is_refetched_after_the_ttl(self):
        self.client.boxes()
        self.clock.advance(11)
        self.client.boxes()
        self.assertEqual(self.stub.hits[("GET", P["boxes"])], 2)

    def test_force_bypasses_the_cache(self):
        self.client.boxes()
        self.client.boxes(force=True)
        self.assertEqual(self.stub.hits[("GET", P["boxes"])], 2)

    def test_item_count_is_filled_in_for_the_screen(self):
        snapshot = self.client.boxes()
        self.assertEqual(snapshot["boxes"][0]["item_count"], 1)

    def test_the_station_token_is_sent_as_a_bearer(self):
        self.client.boxes()
        _method, _path, headers, _payload = self.stub.requests[-1]
        self.assertEqual(headers.get("Authorization"), "Bearer station-token-abc")

    def test_the_snapshot_is_json_shaped(self):
        json.dumps(self.client.boxes())

    def test_a_returned_snapshot_cannot_be_edited_into_the_cache(self):
        first = self.client.boxes()
        first["boxes"].clear()
        self.clock.advance(1)
        self.assertEqual(len(self.client.boxes()["boxes"]), 1)


class TestBoxesDegrade(ClientCase):
    def _fail_after_first(payload, query, hits):  # noqa: N805
        if hits == 1:
            return 200, [BOX]
        return 503, {"detail": "database is having a moment"}

    routes = {("GET", P["boxes"]): _fail_after_first}

    def test_a_failed_refresh_serves_the_last_good_snapshot_as_stale(self):
        self.client.boxes()
        self.clock.advance(11)
        snapshot = self.client.boxes()
        self.assertTrue(snapshot["stale"])
        self.assertEqual(snapshot["boxes"][0]["box_number"], "K3")
        self.assertIsNotNone(snapshot["error"])
        self.assertEqual(snapshot["fetched_at"], 1000.0)  # when it was actually true

    def test_a_failure_with_nothing_cached_is_an_empty_stale_snapshot(self):
        client = smpl_werkstatt.WerkstattClient(
            self.stub.base_url + "/nope", token_provider=lambda: "t",
            clock=self.clock, timeout=1.0,
        )
        snapshot = client.boxes()
        self.assertEqual(snapshot["boxes"], [])
        self.assertTrue(snapshot["stale"])
        self.assertIsNotNone(snapshot["error"])


class TestAnEmptyWorkshopIsStillAnAnswer(ClientCase):
    """Zero crates is a successful fetch, not a missing one (task 8)."""

    def _empty_then_broken(payload, query, hits):  # noqa: N805
        if hits == 1:
            return 200, []
        return 503, {"detail": "database is having a moment"}

    routes = {("GET", P["boxes"]): _empty_then_broken}

    def test_a_fetch_that_found_no_crates_is_still_a_fetch(self):
        snapshot = self.client.boxes()
        self.assertEqual(snapshot["boxes"], [])
        self.assertFalse(snapshot["stale"])
        self.assertIsNone(snapshot["error"])
        self.assertEqual(snapshot["fetched_at"], 1000.0)

    def test_a_later_outage_does_not_claim_smpl_was_never_reached(self):
        # The screen renders "zuletzt aktualisiert" from this. Keying it on
        # the row count meant a quiet day followed by a switch reboot told the
        # workshop the station had never talked to SMPL at all.
        self.client.boxes()
        self.clock.advance(11)
        snapshot = self.client.boxes()
        self.assertTrue(snapshot["stale"])
        self.assertIsNotNone(snapshot["error"])
        self.assertEqual(snapshot["fetched_at"], 1000.0)

    def test_status_agrees_with_the_snapshot(self):
        self.client.boxes()
        self.assertEqual(self.client.status()["boxes_fetched_at"], 1000.0)

    def test_never_fetched_really_is_null(self):
        client = smpl_werkstatt.WerkstattClient("", clock=self.clock)
        self.assertIsNone(client.boxes()["fetched_at"])


class TestInvalidationKeepsTheTimestampHonest(ClientCase):
    def _first_ok_then_broken(payload, query, hits):  # noqa: N805
        if hits == 1:
            return 200, [BOX]
        return 503, {"detail": "gone"}

    routes = {
        ("GET", P["boxes"]): _first_ok_then_broken,
        ("POST", P["movements"]): lambda p, q, h: (200, {"movement_id": 1}),
    }

    def test_a_write_forces_a_refetch_without_erasing_when_it_last_worked(self):
        self.client.boxes()
        self.client.movement(5, "checkout", 1)      # invalidates the cache
        snapshot = self.client.boxes()              # ... and the refetch fails
        self.assertEqual(self.stub.hits[("GET", P["boxes"])], 2)
        self.assertTrue(snapshot["stale"])
        self.assertEqual(snapshot["fetched_at"], 1000.0)
        self.assertEqual(snapshot["boxes"][0]["box_number"], "K3")


class TestUnconfigured(unittest.TestCase):
    def setUp(self) -> None:
        self.client = smpl_werkstatt.WerkstattClient("", token_provider=lambda: "")

    def test_it_is_not_configured(self):
        self.assertFalse(self.client.configured)

    def test_boxes_degrade_instead_of_raising(self):
        snapshot = self.client.boxes()
        self.assertEqual(snapshot["boxes"], [])
        self.assertTrue(snapshot["stale"])
        self.assertIn("SMPL", snapshot["error"])

    def test_every_mutating_call_answers_not_configured(self):
        for result in (
            self.client.add_item(3, code="X"),
            self.client.remove_item(3, 12, 1),
            self.client.movement(5, "checkout", 1),
        ):
            self.assertFalse(result.ok)
            self.assertIsNotNone(result.error)

    def test_resolve_answers_none(self):
        self.assertIsNone(self.client.resolve("4011923456789"))

    def test_status_is_json_shaped(self):
        json.dumps(self.client.status())


# --------------------------------------------------------------------------
# Resolve
# --------------------------------------------------------------------------


class TestResolve(ClientCase):
    def _resolve(payload, query, hits):  # noqa: N805
        if query.get("code") == "MA-0042":
            return 200, {"kind": "machine", "machine": {"machine_number": "MA-0042"}}
        if query.get("code") == "nope":
            return 404, {"detail": "not found"}
        return 200, {"kind": "werkstatt_article",
                     "article": {"id": 5, "item_name": "Schraube M6x40"}}

    routes = {("GET", P["resolve"]): _resolve}

    def test_an_article_resolves(self):
        payload = self.client.resolve("4011923456789")
        self.assertEqual(payload["kind"], "werkstatt_article")

    def test_a_machine_resolves_to_its_kind(self):
        self.assertEqual(self.client.resolve("MA-0042")["kind"], "machine")

    def test_an_unknown_code_is_none_not_an_exception(self):
        self.assertIsNone(self.client.resolve("nope"))

    def test_the_code_is_sent_as_a_query_parameter(self):
        self.client.resolve("4011923456789")
        self.assertEqual(self.stub.requests[-1][1], P["resolve"])

    def test_a_code_with_a_slash_or_a_space_is_encoded_not_injected(self):
        self.client.resolve("A/B C&code=evil")
        self.assertEqual(self.stub.requests[-1][1], P["resolve"])

    def test_article_id_is_extracted_from_any_shape_it_arrives_in(self):
        self.assertEqual(smpl_werkstatt.article_id_of(
            {"kind": "werkstatt_article", "article": {"id": 5}}), 5)
        self.assertEqual(smpl_werkstatt.article_id_of(
            {"kind": "catalog_match", "catalog_items": [{"article_id": 9}]}), 9)
        self.assertIsNone(smpl_werkstatt.article_id_of({"kind": "not_found"}))
        self.assertIsNone(smpl_werkstatt.article_id_of(None))

    def test_a_machines_flat_article_id_is_found(self):
        # Built from the real MachineOut field list, not from a guess: the
        # nested machine["article"]["id"] this used to look for does not
        # exist, so the machine branch never returned anything.
        self.assertEqual(smpl_werkstatt.article_id_of(MACHINE_RESOLVE), 42)

    def test_the_nested_shape_is_still_accepted(self):
        self.assertEqual(smpl_werkstatt.article_id_of(
            {"kind": "machine", "machine": {"article": {"id": 11}}}), 11)

    def test_a_machine_with_no_article_is_none_not_a_crash(self):
        self.assertIsNone(smpl_werkstatt.article_id_of(
            {"kind": "machine", "machine": {"unit_number": "M-0002"}}))

    def test_true_is_not_an_article_id(self):
        self.assertIsNone(smpl_werkstatt.article_id_of(
            {"kind": "machine", "machine": {"article_id": True}}))
        self.assertIsNone(smpl_werkstatt.article_id_of({"article": {"id": "5"}}))

    def test_the_machine_facts_the_screen_renders_are_extracted(self):
        machine = smpl_werkstatt.machine_of(MACHINE_RESOLVE)
        self.assertEqual(machine, {
            "unit_number": "M-0001",
            "article_name": "Bohrhammer TE 30",
            "status": "ausgegeben",
            "holder_name": "Max Mustermann",
            "is_overdue": False,
        })

    def test_an_overdue_tool_says_so(self):
        # kiosk_rack.html renders the "überfällig" badge on
        # ``is_overdue === true``. Dropping the field here made a tool that is
        # weeks late look exactly like one that is not.
        machine = smpl_werkstatt.machine_of(
            {"kind": "machine", "machine": dict(MACHINE_OUT, is_overdue=True)})
        self.assertIs(machine["is_overdue"], True)

    def test_overdue_is_a_real_bool_whatever_smpl_sent(self):
        # The screen compares with ===, so None, "ja" and 1 are all "not
        # overdue" on the wall. They must be False here, not passed through.
        for sent in (None, "", "ja", 1, 0, "true"):
            machine = smpl_werkstatt.machine_of(
                {"kind": "machine", "machine": {"unit_number": "M-1", "is_overdue": sent}})
            self.assertIs(machine["is_overdue"], False, repr(sent))
        missing = smpl_werkstatt.machine_of({"kind": "machine", "machine": {"unit_number": "M-1"}})
        self.assertIs(missing["is_overdue"], False)

    def test_machine_of_is_none_for_everything_else(self):
        self.assertIsNone(smpl_werkstatt.machine_of({"kind": "werkstatt_article",
                                                     "article": {"id": 5}}))
        self.assertIsNone(smpl_werkstatt.machine_of(None))
        self.assertIsNone(smpl_werkstatt.machine_of({"machine": "not a dict"}))

    def test_a_machine_nobody_holds_reports_no_holder(self):
        machine = smpl_werkstatt.machine_of(
            {"kind": "machine", "machine": {"unit_number": "M-0002", "status": "frei",
                                            "holder_name": None, "article_name": "  "}})
        self.assertEqual(machine["unit_number"], "M-0002")
        self.assertIsNone(machine["holder_name"])
        self.assertIsNone(machine["article_name"])

    def test_the_kind_is_read_safely_from_any_payload(self):
        self.assertEqual(smpl_werkstatt.kind_of({"kind": "machine"}), "machine")
        self.assertIsNone(smpl_werkstatt.kind_of(None))
        self.assertIsNone(smpl_werkstatt.kind_of("not a dict"))



# --------------------------------------------------------------------------
# The crew list
# --------------------------------------------------------------------------


def ok_crew(payload, query, hits):
    return 200, [{"id": 4, "name": "Max Mustermann"}, {"id": 9, "name": "Anna Beck"}]


class TestCrew(ClientCase):
    routes = {("GET", P["crew"]): ok_crew}

    def test_the_crew_is_fetched_and_shaped(self):
        self.assertEqual(self.client.crew(),
                         [{"id": 4, "name": "Max Mustermann"},
                          {"id": 9, "name": "Anna Beck"}])

    def test_it_is_cached_rather_than_fetched_per_poll(self):
        self.client.crew()
        self.client.crew()
        self.clock.advance(60)
        self.client.crew()
        self.assertEqual(self.stub.hits[("GET", P["crew"])], 1)

    def test_force_and_the_ttl_both_refetch(self):
        self.client.crew()
        self.client.crew(force=True)
        self.assertEqual(self.stub.hits[("GET", P["crew"])], 2)
        self.clock.advance(self.client.crew_ttl_s + 1)
        self.client.crew()
        self.assertEqual(self.stub.hits[("GET", P["crew"])], 3)

    def test_the_station_token_is_sent(self):
        self.client.crew()
        headers = self.stub.requests[-1][2]
        self.assertEqual(headers.get("Authorization"), "Bearer station-token-abc")

    def test_the_path_is_the_agreed_contract(self):
        self.assertEqual(P["crew"], "/api/station/werkstatt/crew")


class TestCrewDegrades(ClientCase):
    def test_a_route_that_does_not_exist_yet_is_an_empty_list(self):
        # The API half is being built in parallel; until it lands the screen
        # simply shows no names, which the "aus" rule then refuses on.
        self.assertEqual(self.client.crew(), [])

    def test_an_unreachable_smpl_keeps_the_last_good_list(self):
        client = smpl_werkstatt.WerkstattClient(self.stub.base_url, timeout=1.0,
                                                clock=self.clock)
        self.stub.routes[("GET", P["crew"])] = ok_crew
        self.assertEqual(len(client.crew()), 2)
        self.stub.routes.pop(("GET", P["crew"]))       # SMPL now answers 404
        self.clock.advance(10_000)
        self.assertEqual(len(client.crew()), 2)

    def test_an_unconfigured_station_answers_an_empty_list(self):
        client = smpl_werkstatt.WerkstattClient("")
        self.assertEqual(client.crew(), [])

    def test_garbage_is_filtered_not_rendered(self):
        self.assertEqual(smpl_werkstatt.crew_from(
            [{"id": 4, "name": "Max"}, {"id": 0, "name": "Zero"}, {"name": "No id"},
             {"id": 7, "name": "   "}, "not a dict", {"id": True, "name": "Bool"},
             {"id": 9, "full_name": "Anna Beck"}]),
            [{"id": 4, "name": "Max"}, {"id": 9, "name": "Anna Beck"}])

    def test_an_envelope_is_accepted_as_well_as_a_bare_list(self):
        self.assertEqual(smpl_werkstatt.crew_from({"crew": [{"id": 4, "name": "Max"}]}),
                         [{"id": 4, "name": "Max"}])
        self.assertEqual(smpl_werkstatt.crew_from(None), [])
        self.assertEqual(smpl_werkstatt.crew_from("nope"), [])

    def test_the_list_cannot_grow_without_bound(self):
        rows = [{"id": index + 1, "name": "P%d" % index} for index in range(500)]
        self.assertLessEqual(len(smpl_werkstatt.crew_from(rows)), smpl_werkstatt.MAX_CREW)


# --------------------------------------------------------------------------
# Items and movements
# --------------------------------------------------------------------------


class TestMutations(ClientCase):
    routes = {
        ("GET", P["boxes"]): ok_boxes,
        ("POST", "/api/station/werkstatt/boxes/3/items"):
            lambda p, q, h: (201, {"id": 99, "item_name": "Schraube M6x40",
                                   "quantity": p.get("quantity")}),
        ("POST", "/api/station/werkstatt/boxes/3/items/remove"):
            lambda p, q, h: (200, {"removed": p.get("quantity")}),
        ("POST", P["movements"]):
            lambda p, q, h: (200, {"article": {"id": 5, "stock_qty": 17},
                                   "movement_id": 4242}),
        ("POST", "/api/station/werkstatt/boxes/3/handover"):
            lambda p, q, h: (200, {"id": 3, "status": "zugewiesen"}),
        ("POST", "/api/station/werkstatt/boxes/4/handover"):
            lambda p, q, h: (400, {"detail": "Nur eine gepackte Kiste kann mitgenommen werden."}),
    }

    def test_add_item_posts_the_box_id_in_the_path(self):
        result = self.client.add_item(3, code="4011923456789", quantity=2)
        self.assertTrue(result.ok)
        self.assertEqual(result.data["id"], 99)
        method, path, _headers, payload = self.stub.requests[-1]
        self.assertEqual((method, path), ("POST", "/api/station/werkstatt/boxes/3/items"))
        self.assertEqual(payload, {"code": "4011923456789", "quantity": 2})

    def test_add_item_by_article_id_sends_article_id_not_code(self):
        self.client.add_item(3, article_id=5, quantity=1)
        self.assertEqual(self.stub.requests[-1][3], {"article_id": 5, "quantity": 1})

    def test_add_item_needs_one_of_code_or_article_id(self):
        result = self.client.add_item(3, quantity=1)
        self.assertFalse(result.ok)
        self.assertIsNotNone(result.error)

    def test_remove_item_posts_the_item_id_in_the_body(self):
        result = self.client.remove_item(3, 12, 2)
        self.assertTrue(result.ok)
        method, path, _headers, payload = self.stub.requests[-1]
        self.assertEqual(path, "/api/station/werkstatt/boxes/3/items/remove")
        self.assertEqual(payload, {"item_id": 12, "quantity": 2})

    def test_a_movement_carries_its_type_and_quantity(self):
        result = self.client.movement(5, "checkout", 2, assignee_user_id=7, notes="Regal")
        self.assertTrue(result.ok)
        self.assertEqual(result.data["movement_id"], 4242)
        payload = self.stub.requests[-1][3]
        self.assertEqual(payload["article_id"], 5)
        self.assertEqual(payload["movement_type"], "checkout")
        self.assertEqual(payload["quantity"], 2)
        self.assertEqual(payload["assignee_user_id"], 7)
        self.assertEqual(payload["notes"], "Regal")

    def test_optional_movement_fields_are_omitted_when_absent(self):
        self.client.movement(5, "checkout", 1)
        payload = self.stub.requests[-1][3]
        self.assertNotIn("assignee_user_id", payload)
        self.assertNotIn("notes", payload)

    def test_an_unknown_movement_type_is_refused_locally(self):
        result = self.client.movement(5, "teleport", 1)
        self.assertFalse(result.ok)
        self.assertNotIn(("POST", P["movements"]), self.stub.hits)

    def test_a_bad_quantity_is_refused_locally(self):
        self.assertFalse(self.client.add_item(3, code="x", quantity=0).ok)
        self.assertFalse(self.client.movement(5, "checkout", -1).ok)

    def test_a_box_id_that_is_not_a_number_never_reaches_the_url(self):
        result = self.client.add_item("3/../../admin", code="x")
        self.assertFalse(result.ok)
        self.assertNotIn(("POST", "/api/station/werkstatt/boxes/3/items"), self.stub.hits)

    def test_a_handover_names_the_crate_in_the_path_and_nothing_else(self):
        """The customer and the project were decided when the crate was packed;
        a wall screen must not be able to send either."""
        result = self.client.handover(3)
        self.assertTrue(result.ok)
        self.assertEqual(result.data["status"], "zugewiesen")
        method, path, _headers, payload = self.stub.requests[-1]
        self.assertEqual((method, path), ("POST", "/api/station/werkstatt/boxes/3/handover"))
        self.assertEqual(payload, {})

    def test_a_handover_of_a_crate_that_is_not_packed_is_the_servers_sentence(self):
        result = self.client.handover(4)
        self.assertFalse(result.ok)
        self.assertIn("gepackt", result.error)

    def test_a_handover_of_a_nonsense_crate_never_reaches_the_url(self):
        result = self.client.handover("3/../../admin")
        self.assertFalse(result.ok)
        self.assertNotIn(("POST", "/api/station/werkstatt/boxes/3/handover"), self.stub.hits)

    def test_a_handover_invalidates_the_box_cache(self):
        """The crate's status just changed; the wall must not keep showing the
        old one until the TTL runs out."""
        self.client.boxes()
        self.client.handover(3)
        self.client.boxes()
        self.assertEqual(self.stub.hits[("GET", P["boxes"])], 2)

    def test_a_successful_mutation_invalidates_the_box_cache(self):
        self.client.boxes()
        self.client.add_item(3, code="x", quantity=1)
        self.client.boxes()
        self.assertEqual(self.stub.hits[("GET", P["boxes"])], 2)


class TestServerErrors(ClientCase):
    routes = {
        ("POST", P["movements"]): lambda p, q, h: (
            (401, {"detail": "station revoked"}) if h == 1 else
            (409, {"detail": "Nicht genug Bestand"})
        ),
        ("GET", P["boxes"]): lambda p, q, h: (401, {"detail": "station revoked"}),
    }

    def test_a_401_is_reported_to_the_station_so_health_can_say_re_pair(self):
        result = self.client.movement(5, "checkout", 1)
        self.assertFalse(result.ok)
        self.assertEqual(result.status, 401)
        self.assertIn(401, self.auth_events)

    def test_the_servers_own_message_reaches_the_operator(self):
        self.client.movement(5, "checkout", 1)
        result = self.client.movement(5, "checkout", 1)
        self.assertFalse(result.ok)
        self.assertIn("Bestand", result.error)

    def test_a_401_on_boxes_is_a_stale_snapshot_not_an_exception(self):
        snapshot = self.client.boxes()
        self.assertTrue(snapshot["stale"])
        self.assertIn(401, self.auth_events)


class TestTheChipIsScoredFromTheAnswer(ClientCase):
    """What ``last_ok`` means, because a chip on a wall is scored from it."""

    def _by_code(payload, query, hits):  # noqa: N805
        return int(query.get("code") or 500), {"detail": "as asked"}

    routes = {("GET", P["resolve"]): _by_code}

    def status_after(self, code):
        self.client.resolve(str(code))
        return self.client.status()

    def test_a_revoked_station_is_down_not_healthy(self):
        # 401 is a perfectly healthy server saying this station may not ask.
        # Scoring it "below 500, so fine" left both screens green while every
        # crate request failed — the one failure a person can actually fix,
        # reported as no failure at all.
        self.assertIs(self.status_after(401)["last_ok"], False)
        self.assertIn("401", self.status_after(401)["last_error"])

    def test_a_403_is_down_too(self):
        self.assertIs(self.status_after(403)["last_ok"], False)

    def test_an_unknown_code_is_not_an_outage(self):
        # 404 on /resolve means "SMPL does not know this barcode", which is an
        # answer. A red chip there would cry wolf on every mis-scan.
        self.assertIs(self.status_after(404)["last_ok"], True)

    def test_a_server_error_is_still_down(self):
        self.assertIs(self.status_after(503)["last_ok"], False)

    def test_a_good_answer_is_up(self):
        self.assertIs(self.status_after(200)["last_ok"], True)


class TestGarbageResponses(ClientCase):
    routes = {
        ("GET", P["boxes"]): lambda p, q, h: (200, b"<html>proxy error</html>"),
        ("GET", P["resolve"]): lambda p, q, h: (200, b"not json at all"),
        ("POST", P["movements"]): lambda p, q, h: (200, b"{"),
    }

    def test_non_json_boxes_degrade_to_stale(self):
        snapshot = self.client.boxes()
        self.assertEqual(snapshot["boxes"], [])
        self.assertTrue(snapshot["stale"])

    def test_non_json_resolve_is_none(self):
        self.assertIsNone(self.client.resolve("x"))

    def test_non_json_mutation_is_a_failed_result(self):
        self.assertFalse(self.client.movement(5, "checkout", 1).ok)


class TestBoxesWrongShape(ClientCase):
    routes = {("GET", P["boxes"]): lambda p, q, h: (200, {"boxes": [BOX, "junk", None]})}

    def test_an_enveloped_list_is_accepted(self):
        # The server half may wrap the list; both spellings are read.
        self.assertEqual(len(self.client.boxes()["boxes"]), 1)

    def test_entries_that_are_not_objects_are_dropped_not_rendered(self):
        for box in self.client.boxes()["boxes"]:
            self.assertIsInstance(box, dict)


# --------------------------------------------------------------------------
# The movement vocabulary is SMPL's, not ours
# --------------------------------------------------------------------------


API_STATION_SCHEMA = Path(__file__).resolve().parents[3] / "apps/api/app/schemas/station.py"


def station_movement_types():
    """``STATION_MOVEMENT_TYPES`` read straight out of the API's schema file.

    Read rather than imported: the agent is a stdlib-only process on a Pi that
    has no FastAPI, no pydantic and no ``app`` package, so importing the module
    is not available to it. Parsing the assignment is — and it is the whole
    point, because a copy of a vocabulary that nobody checks is a copy that
    drifts, and drift here costs a round trip and a 400 in front of an
    operator holding a drill.
    """
    tree = ast.parse(API_STATION_SCHEMA.read_text(encoding="utf-8"))
    for node in ast.walk(tree):
        targets = getattr(node, "targets", [])
        if isinstance(node, ast.AnnAssign):
            targets = [node.target]
        for target in targets:
            if isinstance(target, ast.Name) and target.id == "STATION_MOVEMENT_TYPES":
                return frozenset(ast.literal_eval(node.value))
    raise AssertionError("STATION_MOVEMENT_TYPES is gone from %s" % API_STATION_SCHEMA)


class TestMovementVocabulary(unittest.TestCase):
    def test_it_is_exactly_the_three_a_station_may_book(self):
        self.assertEqual(smpl_werkstatt.MOVEMENT_TYPES,
                         frozenset(("checkout", "return", "intake")))

    @unittest.skipUnless(API_STATION_SCHEMA.is_file(),
                         "the API half of the monorepo is not in this checkout")
    def test_it_is_pinned_against_the_api_schema_so_the_two_cannot_drift(self):
        self.assertEqual(smpl_werkstatt.MOVEMENT_TYPES, station_movement_types())

    def test_an_inventory_correction_is_not_a_station_movement(self):
        # It is refused by the API on purpose: a stock-take correction is the
        # one movement that cannot be sanity-checked against a counter, so it
        # needs a typed reason from a named person — which a wall screen with
        # no keyboard cannot supply. Offering it here bought a 400.
        for movement in ("inventory_plus", "inventory_minus"):
            self.assertNotIn(movement, smpl_werkstatt.MOVEMENT_TYPES)


class TestNothingEscapes(unittest.TestCase):
    def test_a_transport_that_explodes_is_swallowed(self):
        client = smpl_werkstatt.WerkstattClient("http://127.0.0.1:9", token_provider=lambda: "t",
                                                timeout=0.2)
        self.assertEqual(client.boxes()["boxes"], [])
        self.assertIsNone(client.resolve("x"))
        self.assertFalse(client.add_item(1, code="x").ok)
        self.assertFalse(client.remove_item(1, 2, 1).ok)
        self.assertFalse(client.movement(1, "checkout", 1).ok)

    def test_a_broken_token_provider_is_not_fatal(self):
        def boom():
            raise RuntimeError("token store on fire")

        client = smpl_werkstatt.WerkstattClient("http://127.0.0.1:9", token_provider=boom,
                                                timeout=0.2)
        self.assertEqual(client.bearer(), "")
        self.assertEqual(client.boxes()["boxes"], [])

    def test_the_paths_are_the_agreed_contract(self):
        self.assertEqual(P["boxes"], "/api/station/werkstatt/boxes")
        self.assertEqual(P["resolve"], "/api/station/werkstatt/resolve")
        self.assertEqual(P["movements"], "/api/station/werkstatt/movements")
        self.assertEqual(smpl_werkstatt.items_path(3), "/api/station/werkstatt/boxes/3/items")
        self.assertEqual(smpl_werkstatt.remove_path(3),
                         "/api/station/werkstatt/boxes/3/items/remove")
        self.assertEqual(smpl_werkstatt.handover_path(3),
                         "/api/station/werkstatt/boxes/3/handover")


if __name__ == "__main__":
    unittest.main()


# --------------------------------------------------------------------------
# Stocking a catalogue hit — the Wareneingang path
#
# A supplier EAN resolves to `catalog_match`: SMPL knows the product, the
# workshop has never stocked it, and `article_id_of` therefore finds nothing.
# That used to be a dead end reported as an outage. The station now names the
# catalogue row and the server builds the article from it.
# --------------------------------------------------------------------------


class TestStockFromCatalog(ClientCase):
    routes = {
        ("GET", P["boxes"]): ok_boxes,
        ("POST", "/api/station/werkstatt/articles/from-catalog"):
            lambda p, q, h: (200, {"article": {"id": 77, "item_name": "HAGER ZU37KS"},
                                   "movement_id": 5150, "created": True}),
    }

    def test_it_sends_the_catalogue_id_and_the_quantity(self):
        result = self.client.stock_from_catalog(6617633, 4)
        self.assertTrue(result.ok)
        method, path, _headers, payload = self.stub.requests[-1]
        self.assertEqual((method, path),
                         ("POST", "/api/station/werkstatt/articles/from-catalog"))
        self.assertEqual(payload, {"catalog_item_id": 6617633, "quantity": 4})

    def test_the_answer_carries_created_so_the_screen_can_say_which(self):
        result = self.client.stock_from_catalog(6617633, 1)
        self.assertTrue(result.data["created"])
        self.assertEqual(result.data["movement_id"], 5150)

    def test_a_note_rides_along_and_is_capped(self):
        self.client.stock_from_catalog(6617633, 1, notes="x" * 900)
        self.assertEqual(len(self.stub.requests[-1][3]["notes"]), 500)

    def test_rubbish_ids_and_quantities_never_reach_the_network(self):
        before = len(self.stub.requests)
        for bad in (None, "", "abc", -1):
            self.assertFalse(self.client.stock_from_catalog(bad, 1).ok)
        for bad_qty in (0, -3, "many"):
            self.assertFalse(self.client.stock_from_catalog(6617633, bad_qty).ok)
        self.assertEqual(len(self.stub.requests), before)

    def test_stocking_invalidates_the_box_cache_like_any_other_write(self):
        self.client.boxes()
        fresh = len(self.stub.requests)
        self.client.stock_from_catalog(6617633, 1)
        self.client.boxes()
        # The cache was dropped, so the second boxes() went to the network.
        self.assertGreater(len(self.stub.requests), fresh + 1)


class TestStockFromCatalogUnconfigured(unittest.TestCase):
    def test_an_unpaired_station_says_so_rather_than_calling(self):
        client = smpl_werkstatt.WerkstattClient("", token_provider=lambda: None)
        result = client.stock_from_catalog(6617633, 1)
        self.assertFalse(result.ok)
        self.assertIsNotNone(result.error)


class TestACatalogueRowCarriesNoArticleId(unittest.TestCase):
    """The precise condition the Wareneingang path exists to handle.

    Pinned because it reads like a bug otherwise: `article_id_of` returning
    None for a perfectly good resolve is the *signal*, not a failure. The
    catalogue row's own `id` is a catalogue id and must never be mistaken for
    an article id — booking a movement against it would hit somebody else's
    article.
    """

    payload = {
        "kind": "catalog_match",
        "matched_by": "catalog_ean",
        "catalog_items": [{"id": 6617633, "supplier_name": "Unielektro",
                           "article_no": "01408573", "ean": "3250617811163",
                           "item_name": "HAGER ZU37KS - Einbausatz"}],
    }

    def test_no_article_id_is_found(self):
        self.assertIsNone(smpl_werkstatt.article_id_of(self.payload))

    def test_the_catalogue_id_is_not_mistaken_for_one(self):
        self.assertNotEqual(smpl_werkstatt.article_id_of(self.payload), 6617633)
