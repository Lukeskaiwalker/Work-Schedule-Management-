"""The client half of the rack's consumable Ausgabe.

Three new station routes (``GET /crew-projects``, ``POST /consumptions``,
``POST /consumptions/undo``) and one new reading of an old answer: whether a
resolved article is a consumable or a tool. Same rule as the rest of the
client -- nothing raises into a request handler -- plus two of its own:

* a booking carries a ``request_id`` minted once per attempt and REUSED on its
  retry, so a connection that dies with the answer already written replays
  the booking instead of consuming the parts twice;
* a new station against an old SMPL (404 "Not Found" on a route it has never
  heard of) books nothing and says SMPL needs updating, and the project
  picker simply shows nothing.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

import dispense_codes  # noqa: E402
import smpl_werkstatt  # noqa: E402
from test_smpl_werkstatt import MACHINE_RESOLVE, ClientCase, ok_boxes  # noqa: E402

P = smpl_werkstatt.PATHS

CREW_PROJECTS = {
    "week_start": "2026-10-05",
    "people": [
        {"user_id": 4, "projects": [
            {"id": 12, "project_number": "381", "name": "Neubau Schulze", "hint": "heute"},
            {"id": 15, "project_number": "377", "name": "Umbau Meier", "hint": "zuletzt"},
        ]},
        {"user_id": 9, "projects": []},
    ],
}

ARTICLE = {"id": 5, "item_name": "Kabelbinder 200 mm", "article_number": "SP-1042",
           "stock_available": 97, "stock_out": 0, "stock_total": 97, "unit": "Stk",
           "is_serialized": False}
BOOKED = {"movement_id": 91, "booked_as": "consumption", "quantity": 3, "article": ARTICLE,
          "assignee": {"id": 4, "display_name": "Max M."},
          "project": {"id": 12, "project_number": "381", "name": "Neubau Schulze"},
          "stock_warning": None, "topped_up": 0, "replayed": False}
NOT_FOUND = (404, {"detail": "Not Found"})


def ok_crew_projects(payload, query, hits):
    return 200, CREW_PROJECTS


def ok_consumption(payload, query, hits):
    return 200, dict(BOOKED, quantity=payload.get("quantity"))


def ok_undo(payload, query, hits):
    return 200, dict(BOOKED, booked_as="consumption_undo", quantity=payload.get("quantity"))


# --------------------------------------------------------------------------
# Consumable or tool: read off the resolve answer
# --------------------------------------------------------------------------


class TestScanKind(unittest.TestCase):
    def test_an_article_that_is_not_serialized_is_a_consumable(self):
        payload = {"kind": "werkstatt_article", "article": dict(ARTICLE, is_serialized=False)}
        self.assertEqual(smpl_werkstatt.scan_kind(payload), dispense_codes.KIND_CONSUMABLE)

    def test_a_serialized_article_is_a_tool(self):
        payload = {"kind": "werkstatt_article", "article": dict(ARTICLE, is_serialized=True)}
        self.assertEqual(smpl_werkstatt.scan_kind(payload), dispense_codes.KIND_TOOL)

    def test_an_article_that_does_not_say_keeps_its_kind(self):
        article = {k: v for k, v in ARTICLE.items() if k != "is_serialized"}
        self.assertEqual(smpl_werkstatt.scan_kind({"kind": "werkstatt_article",
                                                   "article": article}), "werkstatt_article")
        self.assertEqual(smpl_werkstatt.scan_kind({"kind": "werkstatt_article",
                                                   "article": dict(ARTICLE,
                                                                   is_serialized=1)}),
                         "werkstatt_article")

    def test_everything_else_is_what_smpl_called_it(self):
        self.assertEqual(smpl_werkstatt.scan_kind(MACHINE_RESOLVE), "machine")
        self.assertEqual(smpl_werkstatt.scan_kind({"kind": "catalog_match"}), "catalog_match")
        self.assertIsNone(smpl_werkstatt.scan_kind(None))
        self.assertIsNone(smpl_werkstatt.scan_kind("nope"))


# --------------------------------------------------------------------------
# The projects behind the person tiles
# --------------------------------------------------------------------------


class TestCrewProjects(ClientCase):
    routes = {("GET", P["crew_projects"]): ok_crew_projects}

    def test_it_is_fetched_and_shaped_per_person(self):
        people = self.client.crew_projects()
        self.assertEqual(sorted(people), [4])
        self.assertEqual([project["id"] for project in people[4]], [12, 15])
        self.assertEqual(people[4][0], {"id": 12, "project_number": "381",
                                        "name": "Neubau Schulze", "hint": "heute"})

    def test_it_is_cached_like_the_crew(self):
        self.client.crew_projects()
        self.clock.advance(self.client.crew_projects_ttl_s - 1)
        self.client.crew_projects()
        self.assertEqual(self.stub.hits[("GET", P["crew_projects"])], 1)

    def test_force_and_the_ttl_both_refetch(self):
        self.client.crew_projects()
        self.client.crew_projects(force=True)
        self.clock.advance(self.client.crew_projects_ttl_s + 1)
        self.client.crew_projects()
        self.assertEqual(self.stub.hits[("GET", P["crew_projects"])], 3)

    def test_it_goes_with_the_station_token(self):
        self.client.crew_projects()
        self.assertEqual(self.stub.requests[-1][2].get("Authorization"),
                         "Bearer station-token-abc")

    def test_a_caller_cannot_edit_the_cache(self):
        people = self.client.crew_projects()
        people[4].append({"id": 99})
        people.clear()
        self.assertEqual(len(self.client.crew_projects()[4]), 2)

    def test_an_outage_keeps_the_last_good_list(self):
        self.client.crew_projects()
        self.stub.routes[("GET", P["crew_projects"])] = lambda p, q, h: (503, {"detail": "x"})
        self.clock.advance(self.client.crew_projects_ttl_s + 1)
        self.assertEqual(sorted(self.client.crew_projects()), [4])
        self.assertEqual(self.client.status()["crew_projects_error"], "x")

    def test_an_answer_that_is_no_list_keeps_the_last_good_one(self):
        self.client.crew_projects()
        self.stub.routes[("GET", P["crew_projects"])] = lambda p, q, h: (200, {"people": "x"})
        self.clock.advance(self.client.crew_projects_ttl_s + 1)
        self.assertEqual(sorted(self.client.crew_projects()), [4])

    def test_the_status_says_how_many_people_have_tiles(self):
        self.client.crew_projects()
        status = self.client.status()
        self.assertEqual(status["crew_projects_cached"], 1)
        self.assertIsNone(status["crew_projects_error"])


class TestCrewProjectsAgainstAnOldSmpl(ClientCase):
    routes = {("GET", P["crew_projects"]): lambda p, q, h: NOT_FOUND}

    def test_the_picker_shows_nothing_and_the_status_says_why(self):
        self.assertEqual(self.client.crew_projects(), {})
        self.assertEqual(self.client.status()["crew_projects_error"], smpl_werkstatt.SMPL_OUTDATED)

    def test_it_is_not_asked_again_on_every_tick(self):
        self.client.crew_projects()
        self.client.crew_projects()
        self.assertEqual(self.stub.hits[("GET", P["crew_projects"])], 1)


class TestCrewProjectsUnconfigured(unittest.TestCase):
    def test_an_unpaired_station_has_no_projects_and_never_calls(self):
        self.assertEqual(smpl_werkstatt.WerkstattClient("").crew_projects(), {})


# --------------------------------------------------------------------------
# Booking a consumption
# --------------------------------------------------------------------------


class TestConsumption(ClientCase):
    routes = {
        ("GET", P["boxes"]): ok_boxes,
        ("POST", P["consumptions"]): ok_consumption,
        ("POST", P["consumptions_undo"]): ok_undo,
    }

    def body(self):
        return self.stub.requests[-1][3]

    def test_it_posts_the_contract_body(self):
        result = self.client.consumption(5, 3, assignee_user_id=4, project_id=12,
                                         request_id="a" * 32)
        self.assertTrue(result.ok)
        self.assertEqual(result.data["booked_as"], "consumption")
        self.assertEqual(self.stub.requests[-1][1], "/api/station/werkstatt/consumptions")
        self.assertEqual(self.body(), {"article_id": 5, "quantity": 3, "assignee_user_id": 4,
                                       "project_id": 12, "request_id": "a" * 32,
                                       "notes": None})

    def test_without_a_project_the_field_is_null_not_missing(self):
        self.client.consumption(5, 1, assignee_user_id=4)
        self.assertIn("project_id", self.body())
        self.assertIsNone(self.body()["project_id"])

    def test_a_request_id_is_minted_when_none_is_given(self):
        self.client.consumption(5, 1, assignee_user_id=4)
        first = self.body()["request_id"]
        self.client.consumption(5, 1, assignee_user_id=4)
        second = self.body()["request_id"]
        self.assertTrue(first and second)
        self.assertLessEqual(len(first), 64)
        self.assertNotEqual(first, second, "two scans are two bookings")

    def test_a_long_request_id_is_capped(self):
        self.client.consumption(5, 1, assignee_user_id=4, request_id="x" * 100)
        self.assertEqual(len(self.body()["request_id"]), 64)

    def test_a_retry_after_a_dead_connection_reuses_the_same_request_id(self):
        sent = []
        real = self.client._request

        def flaky(method, path, **kwargs):
            sent.append(dict(kwargs.get("payload") or {}))
            if len(sent) == 1:
                return smpl_werkstatt.Result(False, error="SMPL ist nicht erreichbar (timeout).")
            return real(method, path, **kwargs)

        self.client._request = flaky
        result = self.client.consumption(5, 3, assignee_user_id=4, project_id=12)
        self.assertTrue(result.ok)
        self.assertEqual(len(sent), 2)
        self.assertEqual(sent[0]["request_id"], sent[1]["request_id"])
        self.assertEqual(self.body()["request_id"], sent[0]["request_id"])

    def test_a_refusal_is_not_retried(self):
        self.stub.routes[("POST", P["consumptions"])] = lambda p, q, h: (
            400, {"detail": "Unbekannte Person."})
        result = self.client.consumption(5, 1, assignee_user_id=4)
        self.assertFalse(result.ok)
        self.assertEqual(result.status, 400)
        self.assertEqual(result.error, "Unbekannte Person.")
        self.assertEqual(self.stub.hits[("POST", P["consumptions"])], 1)

    def test_a_person_is_required_before_anything_is_sent(self):
        for assignee in (None, 0, "Max", True):
            result = self.client.consumption(5, 1, assignee_user_id=assignee)
            self.assertFalse(result.ok, assignee)
        self.assertNotIn(("POST", P["consumptions"]), self.stub.hits)

    def test_rubbish_never_reaches_the_network(self):
        self.assertFalse(self.client.consumption(None, 1, assignee_user_id=4).ok)
        self.assertFalse(self.client.consumption(5, 0, assignee_user_id=4).ok)
        self.assertFalse(self.client.consumption(5, 10 ** 6, assignee_user_id=4).ok)
        self.assertFalse(self.client.consumption(5, 1, assignee_user_id=4, project_id=-3).ok)
        self.assertNotIn(("POST", P["consumptions"]), self.stub.hits)

    def test_a_note_rides_along_capped(self):
        self.client.consumption(5, 1, assignee_user_id=4, notes="n" * 900)
        self.assertEqual(len(self.body()["notes"]), 500)

    def test_a_consumption_leaves_the_crate_cache_alone(self):
        self.client.boxes()
        self.client.consumption(5, 1, assignee_user_id=4)
        self.client.boxes()
        self.assertEqual(self.stub.hits[("GET", P["boxes"])], 1)


class TestConsumptionUndo(ClientCase):
    routes = {("POST", P["consumptions_undo"]): ok_undo}

    def body(self):
        return self.stub.requests[-1][3]

    def test_an_undo_names_its_bucket(self):
        result = self.client.consumption_undo(5, 2, assignee_user_id=4, project_id=12,
                                              request_id="b" * 32)
        self.assertTrue(result.ok)
        self.assertEqual(self.stub.requests[-1][1], "/api/station/werkstatt/consumptions/undo")
        self.assertEqual(self.body(), {"article_id": 5, "quantity": 2, "assignee_user_id": 4,
                                       "project_id": 12, "pick_project": False,
                                       "request_id": "b" * 32})

    def test_a_rueckgabe_lets_smpl_pick_the_bucket_and_needs_no_name(self):
        self.client.consumption_undo(5, 2, pick_project=True)
        body = self.body()
        self.assertTrue(body["pick_project"])
        self.assertIsNone(body["project_id"])
        self.assertIsNone(body["assignee_user_id"])
        self.assertTrue(body["request_id"])

    def test_picking_and_naming_a_bucket_at_once_never_leaves_the_station(self):
        result = self.client.consumption_undo(5, 1, project_id=12, pick_project=True)
        self.assertFalse(result.ok)
        self.assertNotIn(("POST", P["consumptions_undo"]), self.stub.hits)

    def test_the_servers_sentence_reaches_the_wall(self):
        self.stub.routes[("POST", P["consumptions_undo"])] = lambda p, q, h: (
            400, {"detail": "Kein Verbrauch dieses Artikels zum Zurücknehmen."})
        result = self.client.consumption_undo(5, 1, pick_project=True)
        self.assertEqual(result.error, "Kein Verbrauch dieses Artikels zum Zurücknehmen.")
        self.assertFalse(smpl_werkstatt.is_outdated(result))


class TestAnAbbruchNamesItsConsumption(ClientCase):
    """ABBRUCH right after a short-shelf consumption must also take back the
    top-up SMPL booked for it, so the undo names the consumption's row."""

    routes = {("POST", P["consumptions_undo"]): ok_undo}

    def body(self):
        return self.stub.requests[-1][3]

    def test_the_undo_carries_the_movement_id(self):
        result = self.client.consumption_undo(5, 50, assignee_user_id=4, project_id=12,
                                              request_id="b" * 32, undo_of_movement_id=91)
        self.assertTrue(result.ok)
        self.assertEqual(self.body()["undo_of_movement_id"], 91)
        self.assertFalse(self.body()["pick_project"])

    def test_without_one_the_field_is_not_sent(self):
        # An SMPL from before the field reads the body it always read.
        self.client.consumption_undo(5, 2, assignee_user_id=4, project_id=12)
        self.assertNotIn("undo_of_movement_id", self.body())

    def test_a_leftover_rueckgabe_never_names_one(self):
        # A Rückgabe never reverses a top-up -- refused before it is sent.
        result = self.client.consumption_undo(5, 1, pick_project=True, undo_of_movement_id=91)
        self.assertFalse(result.ok)
        self.assertNotIn(("POST", P["consumptions_undo"]), self.stub.hits)

    def test_rubbish_never_reaches_the_network(self):
        for bad in (0, -4, "x", True, 1.5j):
            result = self.client.consumption_undo(5, 1, assignee_user_id=4, project_id=12,
                                                  undo_of_movement_id=bad)
            self.assertFalse(result.ok, bad)
        self.assertNotIn(("POST", P["consumptions_undo"]), self.stub.hits)


class TestUnanswered(unittest.TestCase):
    """Which failures leave open whether SMPL booked: those keep the token."""

    def test_no_connection_and_a_gateway_failure_are_unanswered(self):
        R = smpl_werkstatt.Result
        self.assertTrue(smpl_werkstatt.unanswered(R(False, error="SMPL ist nicht erreichbar.")))
        for status in (500, 502, 503, 504):
            self.assertTrue(smpl_werkstatt.unanswered(R(False, status=status, error="x")), status)

    def test_an_answer_is_an_answer(self):
        R = smpl_werkstatt.Result
        self.assertFalse(smpl_werkstatt.unanswered(R(True, data={}, status=200)))
        for status in (400, 401, 403, 404, 409, 422):
            self.assertFalse(smpl_werkstatt.unanswered(R(False, status=status, error="x")), status)
        self.assertFalse(smpl_werkstatt.unanswered(
            R(False, status=404, error=smpl_werkstatt.SMPL_OUTDATED)))


class TestAgainstAnOldSmpl(ClientCase):
    """FastAPI's own 404 for a route it does not have is ``{"detail": "Not
    Found"}``; the new routes' own 404s (an unknown article) carry a German
    sentence. Only the first means "this SMPL is too old"."""

    routes = {
        ("POST", P["consumptions"]): lambda p, q, h: NOT_FOUND,
        ("POST", P["consumptions_undo"]): lambda p, q, h: (405, {"detail": "Method Not Allowed"}),
    }

    def test_a_missing_route_books_nothing_and_says_update(self):
        result = self.client.consumption(5, 1, assignee_user_id=4)
        self.assertFalse(result.ok)
        self.assertTrue(smpl_werkstatt.is_outdated(result))
        self.assertEqual(result.error, smpl_werkstatt.SMPL_OUTDATED)
        self.assertIn("aktualisiert", result.error)
        self.assertEqual(self.stub.hits[("POST", P["consumptions"])], 1, "no retry on a 404")

    def test_the_undo_route_too(self):
        self.assertTrue(smpl_werkstatt.is_outdated(
            self.client.consumption_undo(5, 1, pick_project=True)))

    def test_an_unknown_article_is_not_an_old_smpl(self):
        self.stub.routes[("POST", P["consumptions"])] = lambda p, q, h: (
            404, {"detail": "Artikel nicht gefunden."})
        result = self.client.consumption(5, 1, assignee_user_id=4)
        self.assertFalse(smpl_werkstatt.is_outdated(result))
        self.assertEqual(result.error, "Artikel nicht gefunden.")


class TestUnconfigured(unittest.TestCase):
    def test_an_unpaired_station_says_so_rather_than_calling(self):
        client = smpl_werkstatt.WerkstattClient("")
        self.assertEqual(client.consumption(5, 1, assignee_user_id=4).error,
                         smpl_werkstatt.NOT_CONFIGURED)
        self.assertEqual(client.consumption_undo(5, 1, pick_project=True).error,
                         smpl_werkstatt.NOT_CONFIGURED)

    def test_a_dead_smpl_is_a_failed_result_not_an_exception(self):
        client = smpl_werkstatt.WerkstattClient("http://127.0.0.1:9", timeout=0.2)
        self.assertFalse(client.consumption(5, 1, assignee_user_id=4).ok)
        self.assertFalse(client.consumption_undo(5, 1, pick_project=True).ok)
        self.assertEqual(client.crew_projects(), {})


class TestThePaths(unittest.TestCase):
    def test_the_paths_are_the_agreed_contract(self):
        self.assertEqual(P["crew_projects"], "/api/station/werkstatt/crew-projects")
        self.assertEqual(P["consumptions"], "/api/station/werkstatt/consumptions")
        self.assertEqual(P["consumptions_undo"], "/api/station/werkstatt/consumptions/undo")

    def test_the_movement_vocabulary_did_not_grow(self):
        # Consumption has its own routes; /movements keeps its three types, so
        # an older agent and the pin against the API schema stay meaningful.
        self.assertEqual(smpl_werkstatt.MOVEMENT_TYPES,
                         frozenset(("checkout", "return", "intake")))


if __name__ == "__main__":
    unittest.main()
