"""The rack's consumable Ausgabe, over the real HTTP server and the real page.

``test_scan_router_dispense`` pins the rules; this pins the wiring: what a
scanned person or project code does to ``/screen/state``, what reaches SMPL
for a consumable and for a tool, what the wall says, and -- the static half --
that every QR code ``kiosk_rack.html`` can draw is a code the router actually
implements, in characters the scanner actually types.
"""

from __future__ import annotations

import json
import pathlib
import re
import sys
import tempfile
import time
import unittest
import urllib.parse
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

import dispense_codes  # noqa: E402
import qrcode_svg  # noqa: E402
import scan_router  # noqa: E402
import server  # noqa: E402
import smpl_werkstatt  # noqa: E402
from test_kiosk_http import KioskCase, Recorder, get, post  # noqa: E402
from test_qrcode_svg import decode as decode_qr, read_svg as read_qr_svg  # noqa: E402

PAGE = pathlib.Path(__file__).resolve().parents[1] / "static" / "kiosk_rack.html"

MAX = {"id": 4, "name": "Max Mustermann"}
ANNA = {"id": 9, "name": "Anna Beck"}
SCHULZE = {"id": 12, "project_number": "381", "name": "Neubau Schulze", "hint": "heute"}
MEIER = {"id": 15, "project_number": "377", "name": "Umbau Meier", "hint": "zuletzt"}
CONSUMABLE = {"kind": "werkstatt_article",
              "article": {"id": 5, "item_name": "Kabelbinder 200 mm", "unit": "Stk",
                          "stock_available": 97, "stock_out": 0, "stock_total": 97,
                          "is_serialized": False}}
TOOL = {"kind": "werkstatt_article",
        "article": {"id": 6, "item_name": "Bohrhammer", "stock_available": 2,
                    "stock_out": 1, "stock_total": 3, "is_serialized": True}}


def booked(movement_type="consumption", qty=3, project=SCHULZE, warning=None, *,
           movement_id=91, assignee=None, replayed=False, reversed_top_up=None):
    article = dict(CONSUMABLE["article"], stock_available=94, stock_total=94)
    data = {
        "movement_id": movement_id, "booked_as": movement_type, "quantity": qty,
        "article": article,
        "assignee": assignee or {"id": 4, "display_name": "Max M."},
        "project": ({k: project[k] for k in ("id", "project_number", "name")}
                    if project else None),
        "stock_warning": warning, "topped_up": 0, "replayed": replayed}
    if reversed_top_up is not None:
        data["reversed_top_up"] = reversed_top_up
    return smpl_werkstatt.Result(True, status=200, data=data)


#: No answer at all: the try and its one retry both timed out. Whether SMPL
#: booked is unknown, so the token has to outlive this scan.
NO_ANSWER = smpl_werkstatt.Result(False, error="SMPL ist nicht erreichbar (TimeoutError).")


class Sequence:
    """One WerkstattClient method answering a scripted series, then the last."""

    def __init__(self, *results):
        self.results = list(results)
        self.calls = []

    def __call__(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        index = min(len(self.calls), len(self.results)) - 1
        return self.results[index]

    def tokens(self):
        return [kwargs.get("request_id") for _args, kwargs in self.calls]


class DispenseCase(KioskCase):
    """A running agent with a crew, its projects, and a scripted SMPL."""

    def setUp(self) -> None:
        super().setUp()
        self.agent.werkstatt.base_url = "http://smpl.invalid"
        self.agent.kiosk.set_crew([MAX, ANNA])
        self.agent.router.set_crew_projects({4: [SCHULZE, MEIER]})
        self.resolved = []
        self.answer = CONSUMABLE

        def resolve(code):
            self.resolved.append(code)
            return json.loads(json.dumps(self.answer))

        self.agent.werkstatt.resolve = resolve
        self.consumptions = Recorder(booked())
        self.undos = Recorder(booked("consumption_undo", qty=2))
        self.movements = Recorder(smpl_werkstatt.Result(
            True, status=200, data={"article": TOOL["article"], "movement_id": 7}))
        self.agent.werkstatt.consumption = self.consumptions
        self.agent.werkstatt.consumption_undo = self.undos
        self.agent.werkstatt.movement = self.movements

    def scan(self, code):
        time.sleep(0.17)                       # past the de-dupe window
        _status, body = post(self.base() + "/scan/route", {"code": code})
        return body

    def act(self, action, value=None, screen="regal"):
        return post(self.base() + "/screen/action",
                    {"screen": screen, "action": action, "value": value})

    def rack(self):
        return self.state("regal")[1]

    def flash(self):
        return self.rack()["flash"]


# --------------------------------------------------------------------------
# Picking a person and a project
# --------------------------------------------------------------------------


class TestAPersonCodeAtTheRack(DispenseCase):
    def test_somebody_in_the_crew_is_picked_without_asking_smpl(self):
        body = self.scan("SMPL-CMD-PERSON-4")
        self.assertTrue(body["ok"])
        self.assertEqual(body["action"], "select_person")
        self.assertEqual(self.resolved, [], "a person code went to /resolve")
        state = self.rack()
        self.assertEqual(state["assignee"], MAX)
        self.assertEqual(state["flash"]["level"], "ok")
        self.assertEqual(state["flash"]["title"], "Max Mustermann")

    def test_somebody_outside_the_crew_is_refused(self):
        body = self.scan("SMPL-CMD-PERSON-77")
        self.assertFalse(body["ok"])
        self.assertEqual(body["action"], "unknown_person")
        self.assertEqual(self.resolved, [])
        state = self.rack()
        self.assertIsNone(state["assignee"])
        self.assertEqual(state["flash"]["level"], "error")
        self.assertEqual(state["flash"]["detail"], scan_router.MSG_UNKNOWN_PERSON)

    def test_the_crew_the_screen_shows_is_the_crew_a_code_may_name(self):
        self.agent.kiosk.set_crew([ANNA])
        self.assertEqual(self.scan("SMPL-CMD-PERSON-4")["action"], "unknown_person")
        self.assertEqual(self.scan("SMPL-CMD-PERSON-9")["action"], "select_person")


class TestTheStatePayload(DispenseCase):
    def test_with_nobody_picked_there_is_nothing_to_offer(self):
        state = self.rack()
        self.assertEqual(state["projects"], [])
        self.assertIsNone(state["project"])
        self.assertFalse(state["project_chosen"])

    def test_it_carries_the_picked_persons_projects_and_the_picked_project(self):
        self.scan("SMPL-CMD-PERSON-4")
        state = self.rack()
        self.assertEqual(state["projects"], [SCHULZE, MEIER])
        self.assertFalse(state["project_chosen"])
        self.scan("SMPL-CMD-PROJEKT-12")
        state = self.rack()
        self.assertTrue(state["project_chosen"])
        self.assertEqual(state["project"], {"id": 12, "project_number": "381",
                                            "name": "Neubau Schulze"})
        self.assertEqual(state["flash"]["title"], "381 Neubau Schulze")
        self.assertIn("Max Mustermann", state["flash"]["detail"])

    def test_the_projection_is_four_fields_and_no_more(self):
        self.agent.router.set_crew_projects(
            {4: [dict(SCHULZE, customer="Schulze GmbH", street="Hauptstr. 1")]})
        self.scan("SMPL-CMD-PERSON-4")
        self.assertEqual(set(self.rack()["projects"][0]),
                         {"id", "project_number", "name", "hint"})

    def test_somebody_elses_project_is_refused_on_the_wall(self):
        self.agent.router.set_crew_projects({4: [SCHULZE], 9: [MEIER]})
        self.scan("SMPL-CMD-PERSON-4")
        body = self.scan("SMPL-CMD-PROJEKT-15")
        self.assertFalse(body["ok"])
        state = self.rack()
        self.assertFalse(state["project_chosen"])
        self.assertEqual(state["flash"]["level"], "error")
        self.assertEqual(state["flash"]["detail"], scan_router.MSG_PROJECT_NOT_OFFERED)

    def test_ohne_projekt_is_a_choice(self):
        self.scan("SMPL-CMD-PERSON-4")
        self.scan("SMPL-CMD-OHNE-PROJEKT")
        state = self.rack()
        self.assertTrue(state["project_chosen"])
        self.assertIsNone(state["project"])
        self.assertEqual(state["flash"]["title"], "Ohne Projekt")

    def test_fertig_ends_the_ausgabe(self):
        self.scan("SMPL-CMD-PERSON-4")
        self.scan("SMPL-CMD-PROJEKT-12")
        body = self.scan("SMPL-CMD-FERTIG")
        self.assertEqual(body["action"], "close_selection")
        state = self.rack()
        self.assertIsNone(state["assignee"])
        self.assertFalse(state["project_chosen"])
        self.assertEqual(state["flash"]["title"], "Ausgabe beendet")


class TestTheTapsForTheAusgabe(DispenseCase):
    def test_a_project_tap_must_be_one_of_the_tiles(self):
        self.act("assignee", 4)
        status, _body = self.act("project", 99)
        self.assertEqual(status, 400)
        status, body = self.act("project", 12)
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])
        self.assertEqual(self.rack()["project"]["id"], 12)

    def test_a_project_needs_a_person_first(self):
        status, body = self.act("project", 12)
        self.assertEqual(status, 400)
        self.assertEqual(body["error"], scan_router.MSG_PROJECT_NEEDS_PERSON)

    def test_ohne_projekt_and_back_to_the_tiles(self):
        self.act("assignee", 4)
        self.assertEqual(self.act("no_project")[0], 200)
        self.assertTrue(self.rack()["project_chosen"])
        self.assertEqual(self.act("project", None)[0], 200)
        self.assertFalse(self.rack()["project_chosen"])

    def test_a_nonsense_project_is_a_400(self):
        self.act("assignee", 4)
        self.assertEqual(self.act("project", "Neubau")[0], 400)

    def test_they_are_actions_of_the_rack_screen(self):
        self.act("assignee", 4)
        self.assertEqual(self.act("project", 12, screen="kisten")[0], 400)
        self.assertEqual(self.act("no_project", screen="kisten")[0], 400)
        self.assertEqual(server.ACTION_SCREEN["project"], server.SCREEN_RACK)
        self.assertEqual(server.ACTION_SCREEN["no_project"], server.SCREEN_RACK)

    def test_another_name_takes_the_project_with_it(self):
        self.act("assignee", 4)
        self.act("project", 12)
        self.act("assignee", 9)
        self.assertFalse(self.rack()["project_chosen"])


# --------------------------------------------------------------------------
# What reaches SMPL
# --------------------------------------------------------------------------


class TestAConsumableAusgabe(DispenseCase):
    def test_it_is_consumption_for_the_person_and_the_project(self):
        self.scan("SMPL-CMD-PERSON-4")
        self.scan("SMPL-CMD-PROJEKT-12")
        self.scan("SMPL-CMD-MENGE-5")
        body = self.scan("4011923456789")
        self.assertEqual(body["action"], "consumption")
        self.assertEqual(self.movements.calls, [], "a consumable was lent out")
        self.assertEqual(len(self.consumptions.calls), 1)
        args, kwargs = self.consumptions.calls[0]
        self.assertEqual(args, (5, 5))
        self.assertEqual(kwargs["assignee_user_id"], 4)
        self.assertEqual(kwargs["project_id"], 12)

    def test_the_wall_says_what_was_used_up_and_where_it_went(self):
        self.scan("SMPL-CMD-PERSON-4")
        self.scan("SMPL-CMD-PROJEKT-12")
        self.scan("4011923456789")
        state = self.rack()
        self.assertEqual(state["flash"]["level"], "ok")
        self.assertEqual(state["flash"]["title"], "Verbraucht: 3 × Kabelbinder 200 mm")
        self.assertEqual(state["flash"]["detail"], "→ 381 Neubau Schulze")
        movement = state["last"]["movement"]
        self.assertEqual(movement["movement_type"], "consumption")
        self.assertEqual(movement["project_label"], "381 Neubau Schulze")
        self.assertEqual(state["last"]["article"]["stock_total"], 94)

    def test_without_a_project_it_says_so(self):
        self.agent.werkstatt.consumption = Recorder(booked(project=None))
        self.scan("SMPL-CMD-PERSON-4")
        self.scan("4011923456789")
        self.assertEqual(self.flash()["detail"], "→ ohne Projekt")

    def test_a_short_shelf_is_booked_and_flashed_as_a_warning(self):
        warning = "Laut Bestand waren nur 0 da – 3 nachgebucht, bitte zählen."
        self.agent.werkstatt.consumption = Recorder(booked(warning=warning))
        self.scan("SMPL-CMD-PERSON-4")
        self.scan("4011923456789")
        flash = self.flash()
        self.assertEqual(flash["level"], "warn")
        self.assertIn(warning, flash["detail"])
        self.assertTrue(flash["title"].startswith("Verbraucht:"))

    def test_without_a_name_nothing_is_booked(self):
        body = self.scan("4011923456789")
        self.assertEqual(body["action"], "needs_assignee")
        self.assertEqual(self.consumptions.calls, [])

    def test_a_tool_is_still_a_checkout(self):
        self.answer = TOOL
        self.scan("SMPL-CMD-PERSON-4")
        self.scan("SMPL-CMD-PROJEKT-12")
        body = self.scan("4011923456789")
        self.assertEqual(body["action"], "movement")
        self.assertEqual(self.consumptions.calls, [])
        args, kwargs = self.movements.calls[0]
        self.assertEqual(args[:2], (6, "checkout"))
        self.assertEqual(kwargs["assignee_user_id"], 4)

    def test_a_refusal_books_nothing_and_shows_smpls_sentence(self):
        self.agent.werkstatt.consumption = Recorder(smpl_werkstatt.Result(
            False, status=400, error="Projekt nicht verfügbar."))
        self.scan("SMPL-CMD-PERSON-4")
        self.scan("4011923456789")
        flash = self.flash()
        self.assertEqual(flash["level"], "error")
        self.assertEqual(flash["title"], "Nicht gebucht")
        self.assertEqual(flash["detail"], "Projekt nicht verfügbar.")
        self.assertNotIn("regal", self.agent.router.state.last_actions)

    def test_an_old_smpl_books_nothing_and_says_update(self):
        self.agent.werkstatt.consumption = Recorder(smpl_werkstatt.Result(
            False, status=404, error=smpl_werkstatt.SMPL_OUTDATED))
        self.scan("SMPL-CMD-PERSON-4")
        self.scan("4011923456789")
        flash = self.flash()
        self.assertEqual(flash["level"], "error")
        self.assertEqual(flash["title"], "SMPL muss aktualisiert werden")
        self.assertIn("Nichts gebucht", flash["detail"])
        self.assertNotIn("regal", self.agent.router.state.last_actions)


class TestARueckgabeOfAConsumable(DispenseCase):
    def test_leftovers_go_back_from_the_bucket_smpl_picks(self):
        self.act("direction", "ein")
        self.scan("SMPL-CMD-MENGE-5")
        body = self.scan("4011923456789")
        self.assertEqual(body["action"], "consumption_return")
        args, kwargs = self.undos.calls[0]
        self.assertEqual(args, (5, 5))
        self.assertTrue(kwargs["pick_project"])
        self.assertIsNone(kwargs["project_id"])
        flash = self.flash()
        self.assertEqual(flash["title"], "Zurück ins Lager: 2 × Kabelbinder 200 mm")
        self.assertEqual(flash["detail"], "← 381 Neubau Schulze")
        self.assertEqual(self.rack()["last"]["movement"]["movement_type"], "consumption_undo")

    def test_a_picked_project_names_the_bucket(self):
        self.act("assignee", 4)
        self.act("project", 15)
        self.act("direction", "ein")
        self.scan("4011923456789")
        _args, kwargs = self.undos.calls[0]
        self.assertFalse(kwargs["pick_project"])
        self.assertEqual(kwargs["project_id"], 15)
        self.assertEqual(kwargs["assignee_user_id"], 4)

    def test_an_old_loan_of_a_consumable_comes_back_as_smpl_booked_it(self):
        # Handed out before consumables were consumed: an open checkout. SMPL
        # decides it is that loan coming back and books a return -- the
        # station books nothing of its own on top.
        self.answer = {"kind": "werkstatt_article",
                       "article": dict(CONSUMABLE["article"], stock_out=10)}
        self.agent.werkstatt.consumption_undo = Recorder(booked("return", qty=10))
        self.act("direction", "ein")
        self.scan("SMPL-CMD-MENGE-10")
        self.scan("4011923456789")
        self.assertEqual(self.movements.calls, [], "the loan was closed twice")
        self.assertEqual(self.consumptions.calls, [])
        state = self.rack()
        self.assertEqual(state["flash"]["level"], "ok")
        self.assertEqual(state["flash"]["title"],
                         "Zurück: 10 × Kabelbinder 200 mm (Leihe beendet)")
        self.assertEqual(state["flash"]["detail"],
                         "Ausgeliehen an Max M. · ← 381 Neubau Schulze")
        movement = state["last"]["movement"]
        self.assertEqual(movement["movement_type"], "return")
        self.assertEqual(movement["movement_id"], 91)
        self.assertEqual(movement["project_label"], "381 Neubau Schulze")

    def test_a_loan_without_a_project_says_so(self):
        self.agent.werkstatt.consumption_undo = Recorder(booked("return", qty=2, project=None))
        self.act("direction", "ein")
        self.scan("4011923456789")
        self.assertEqual(self.flash()["detail"], "Ausgeliehen an Max M. · ← ohne Projekt")

    def test_abbruch_lends_exactly_that_loan_out_again(self):
        # Anna carried Max's cable ties back; ABBRUCH puts the loan back on
        # Max -- whose loan SMPL closed -- not on whoever is tapped now.
        self.agent.werkstatt.consumption_undo = Recorder(booked("return", qty=10))
        self.act("assignee", 9)
        self.act("direction", "ein")
        self.scan("SMPL-CMD-MENGE-10")
        self.scan("4011923456789")
        body = self.scan("SMPL-CMD-ABBRUCH")
        self.assertEqual(body["action"], "undo_movement")
        self.assertEqual(len(self.movements.calls), 1)
        args, kwargs = self.movements.calls[0]
        self.assertEqual(args, (5, "checkout", 10))
        self.assertEqual(kwargs["assignee_user_id"], 4)
        self.assertEqual(self.consumptions.calls, [], "a closed loan is not re-consumed")
        self.assertEqual(self.flash()["title"], "Buchung zurückgenommen")
        self.assertEqual(self.scan("SMPL-CMD-ABBRUCH")["action"], "nothing_to_undo")

    def test_nothing_to_take_back_is_smpls_last_word(self):
        # The old fallback booked a loan return of its own after this
        # refusal. SMPL now weighs the loans itself, so the wall only says it.
        self.answer = {"kind": "werkstatt_article",
                       "article": dict(CONSUMABLE["article"], stock_out=4)}
        self.agent.werkstatt.consumption_undo = Recorder(smpl_werkstatt.Result(
            False, status=400, error="Kein Verbrauch dieses Artikels zum Zurücknehmen."))
        self.act("assignee", 4)
        self.act("direction", "ein")
        self.scan("4011923456789")
        self.assertEqual(self.movements.calls, [])
        flash = self.flash()
        self.assertEqual(flash["level"], "error")
        self.assertEqual(flash["detail"], "Kein Verbrauch dieses Artikels zum Zurücknehmen.")
        self.assertNotIn("regal", self.agent.router.state.last_actions)

    def test_more_than_the_picked_projects_bucket_is_refused_not_returned(self):
        # Max consumed 3 into 381, picks 381 and brings back 5: the bucket
        # limit is SMPL's answer, never a loan return under his name.
        refusal = "Zurücknehmen geht nur für Verbrauchtes: für dieses Projekt sind noch 3 verbucht."
        self.answer = {"kind": "werkstatt_article",
                       "article": dict(CONSUMABLE["article"], stock_out=4)}
        self.agent.werkstatt.consumption_undo = Recorder(smpl_werkstatt.Result(
            False, status=400, error=refusal))
        self.act("assignee", 4)
        self.act("project", 12)
        self.act("direction", "ein")
        self.scan("SMPL-CMD-MENGE-5")
        self.scan("4011923456789")
        self.assertEqual(self.movements.calls, [])
        flash = self.flash()
        self.assertEqual(flash["level"], "error")
        self.assertEqual(flash["detail"], refusal)

    def test_more_than_the_bucket_smpl_picked_is_refused_not_returned(self):
        refusal = "Zurücknehmen geht nur für Verbrauchtes: ohne Projekt sind noch 1 verbucht."
        self.answer = {"kind": "werkstatt_article",
                       "article": dict(CONSUMABLE["article"], stock_out=4)}
        self.agent.werkstatt.consumption_undo = Recorder(smpl_werkstatt.Result(
            False, status=400, error=refusal))
        self.act("direction", "ein")
        self.scan("SMPL-CMD-MENGE-5")
        self.scan("4011923456789")
        self.assertEqual(self.movements.calls, [])
        self.assertEqual(self.flash()["detail"], refusal)

    def test_ohne_projekt_names_a_bucket_and_never_falls_back(self):
        refusal = "Zurücknehmen geht nur für Verbrauchtes: ohne Projekt sind noch 0 verbucht."
        self.answer = {"kind": "werkstatt_article",
                       "article": dict(CONSUMABLE["article"], stock_out=4)}
        self.agent.werkstatt.consumption_undo = Recorder(smpl_werkstatt.Result(
            False, status=400, error=refusal))
        self.act("assignee", 4)
        self.act("no_project")
        self.act("direction", "ein")
        self.scan("4011923456789")
        self.assertEqual(self.movements.calls, [])
        self.assertEqual(self.flash()["detail"], refusal)

    def test_any_other_refusal_with_loans_out_is_shown_unchanged(self):
        self.answer = {"kind": "werkstatt_article",
                       "article": dict(CONSUMABLE["article"], stock_out=4)}
        self.agent.werkstatt.consumption_undo = Recorder(smpl_werkstatt.Result(
            False, status=400, error="Artikel ist archiviert — keine Buchungen möglich"))
        self.act("direction", "ein")
        self.scan("4011923456789")
        self.assertEqual(self.movements.calls, [])
        self.assertEqual(self.flash()["detail"], "Artikel ist archiviert — keine Buchungen möglich")

    def test_with_nothing_to_take_back_it_says_so(self):
        self.agent.werkstatt.consumption_undo = Recorder(smpl_werkstatt.Result(
            False, status=400, error="Kein Verbrauch dieses Artikels zum Zurücknehmen."))
        self.act("direction", "ein")
        self.scan("4011923456789")
        self.assertEqual(self.movements.calls, [])
        flash = self.flash()
        self.assertEqual(flash["level"], "error")
        self.assertEqual(flash["detail"], "Kein Verbrauch dieses Artikels zum Zurücknehmen.")


class TestAbbruchAfterAConsumption(DispenseCase):
    def test_it_takes_the_parts_back_out_of_the_same_project(self):
        self.scan("SMPL-CMD-PERSON-4")
        self.scan("SMPL-CMD-PROJEKT-12")
        self.scan("4011923456789")
        self.act("project", 15)                 # switching does not move the bucket
        body = self.scan("SMPL-CMD-ABBRUCH")
        self.assertEqual(body["action"], "undo_consumption")
        args, kwargs = self.undos.calls[0]
        self.assertEqual(args, (5, 3))
        self.assertEqual(kwargs["project_id"], 12)
        self.assertFalse(kwargs["pick_project"])
        self.assertEqual(self.flash()["title"], "Buchung zurückgenommen")
        self.assertEqual(self.scan("SMPL-CMD-ABBRUCH")["action"], "nothing_to_undo")

    def test_a_failed_undo_can_be_tried_again_under_the_same_token(self):
        self.scan("SMPL-CMD-PERSON-4")
        self.scan("4011923456789")
        failing = Recorder(smpl_werkstatt.Result(False, error="SMPL ist nicht erreichbar."))
        self.agent.werkstatt.consumption_undo = failing
        self.scan("SMPL-CMD-ABBRUCH")
        self.assertEqual(self.flash()["title"], "Abbruch fehlgeschlagen")
        self.assertEqual(self.scan("SMPL-CMD-ABBRUCH")["action"], "undo_consumption")
        tokens = [kwargs["request_id"] for _args, kwargs in failing.calls]
        self.assertEqual(len(tokens), 2)
        self.assertTrue(tokens[0])
        self.assertEqual(tokens[0], tokens[1],
                         "a second ABBRUCH after a lost answer would take the parts back twice")

    def test_the_undo_names_the_consumption_it_takes_back(self):
        self.scan("SMPL-CMD-PERSON-4")
        self.scan("4011923456789")
        self.scan("SMPL-CMD-ABBRUCH")
        _args, kwargs = self.undos.calls[0]
        self.assertEqual(kwargs["undo_of_movement_id"], 91)

    def test_a_replayed_booking_is_named_by_the_row_smpl_answered_with(self):
        self.agent.werkstatt.consumption = Recorder(booked(movement_id=77, replayed=True))
        self.scan("SMPL-CMD-PERSON-4")
        self.scan("4011923456789")
        self.scan("SMPL-CMD-ABBRUCH")
        _args, kwargs = self.undos.calls[0]
        self.assertEqual(kwargs["undo_of_movement_id"], 77)

    def test_a_reversed_top_up_is_said(self):
        self.agent.werkstatt.consumption = Recorder(booked(qty=50, warning="Nur 12 da."))
        self.agent.werkstatt.consumption_undo = Recorder(
            booked("consumption_undo", qty=50, reversed_top_up=38))
        self.scan("SMPL-CMD-PERSON-4")
        self.scan("SMPL-CMD-MENGE-50")
        self.scan("4011923456789")
        self.scan("SMPL-CMD-ABBRUCH")
        flash = self.flash()
        self.assertEqual(flash["level"], "ok")
        self.assertEqual(flash["title"], "Buchung zurückgenommen")
        self.assertEqual(flash["detail"],
                         "Verbrauch zurück: 50 × Kabelbinder 200 mm · Nachbuchung 38 zurückgenommen")

    def test_no_top_up_no_word_about_one(self):
        self.agent.werkstatt.consumption_undo = Recorder(
            booked("consumption_undo", qty=3, reversed_top_up=0))
        self.scan("SMPL-CMD-PERSON-4")
        self.scan("4011923456789")
        self.scan("SMPL-CMD-ABBRUCH")
        self.assertNotIn("Nachbuchung", self.flash()["detail"])

    def test_a_leftover_rueckgabe_never_names_a_consumption(self):
        self.scan("SMPL-CMD-PERSON-4")
        self.scan("4011923456789")                     # a consumption, id 91
        self.act("direction", "ein")
        self.scan("4011923456789")                     # leftovers back
        _args, kwargs = self.undos.calls[0]
        self.assertTrue(kwargs["pick_project"])
        self.assertIsNone(kwargs.get("undo_of_movement_id"))

    def test_undoing_a_rueckgabe_consumes_again(self):
        self.act("assignee", 4)
        self.act("direction", "ein")
        self.scan("4011923456789")
        self.scan("SMPL-CMD-ABBRUCH")
        args, kwargs = self.consumptions.calls[0]
        self.assertEqual(args, (5, 2))                 # what SMPL booked, not what was asked
        self.assertEqual(kwargs["assignee_user_id"], 4)
        self.assertEqual(kwargs["project_id"], 12)     # the bucket SMPL answered with


class TestARescanAfterNoAnswer(DispenseCase):
    """Two timeouts on the Pi, but the first try landed: the re-scan of the
    same thing must replay it, never consume the parts a second time."""

    def test_the_same_booking_is_rescanned_under_the_same_token(self):
        calls = Sequence(NO_ANSWER, NO_ANSWER, booked(qty=5))
        self.agent.werkstatt.consumption = calls
        self.scan("SMPL-CMD-PERSON-4")
        self.scan("SMPL-CMD-PROJEKT-12")
        for _ in range(3):
            self.scan("SMPL-CMD-MENGE-5")
            self.scan("4011923456789")
        tokens = calls.tokens()
        self.assertEqual(len(tokens), 3)
        self.assertTrue(tokens[0])
        self.assertEqual(len(set(tokens)), 1, tokens)
        self.assertEqual(self.flash()["title"], "Verbraucht: 5 × Kabelbinder 200 mm")

    def test_once_smpl_booked_it_the_next_scan_is_a_new_booking(self):
        calls = Sequence(NO_ANSWER, booked(), booked())
        self.agent.werkstatt.consumption = calls
        self.scan("SMPL-CMD-PERSON-4")
        for _ in range(3):
            self.scan("SMPL-CMD-MENGE-5")
            self.scan("4011923456789")
        first, replay, fresh = calls.tokens()
        self.assertTrue(first)
        self.assertEqual(first, replay)
        self.assertNotEqual(replay, fresh)

    def test_a_refusal_is_an_answer_too(self):
        refused = smpl_werkstatt.Result(False, status=400, error="Projekt nicht verfügbar.")
        calls = Sequence(NO_ANSWER, refused, booked())
        self.agent.werkstatt.consumption = calls
        self.scan("SMPL-CMD-PERSON-4")
        for _ in range(3):
            self.scan("SMPL-CMD-MENGE-5")
            self.scan("4011923456789")
        first, refused_token, fresh = calls.tokens()
        self.assertTrue(first)
        self.assertEqual(first, refused_token)
        self.assertNotEqual(refused_token, fresh)

    def test_a_gateway_timeout_keeps_it_as_well(self):
        calls = Sequence(smpl_werkstatt.Result(False, status=504, error="HTTP 504"), booked())
        self.agent.werkstatt.consumption = calls
        self.scan("SMPL-CMD-PERSON-4")
        self.scan("4011923456789")
        self.scan("4011923456789")
        first, second = calls.tokens()
        self.assertTrue(first)
        self.assertEqual(first, second)

    def test_another_quantity_or_project_is_another_booking(self):
        calls = Sequence(NO_ANSWER)
        self.agent.werkstatt.consumption = calls
        self.scan("SMPL-CMD-PERSON-4")
        self.scan("4011923456789")                     # 1 piece, no project
        self.scan("SMPL-CMD-MENGE-5")
        self.scan("4011923456789")                     # 5 pieces
        self.scan("SMPL-CMD-PROJEKT-12")
        self.scan("4011923456789")                     # 1 piece for 381
        tokens = calls.tokens()
        self.assertTrue(all(tokens), tokens)
        self.assertEqual(len(set(tokens)), 3, tokens)

    def test_a_rueckgabe_keeps_its_token_too(self):
        calls = Sequence(NO_ANSWER, NO_ANSWER, booked("consumption_undo", qty=2))
        self.agent.werkstatt.consumption_undo = calls
        self.act("direction", "ein")
        for _ in range(3):
            self.scan("4011923456789")
        tokens = calls.tokens()
        self.assertEqual(len(tokens), 3)
        self.assertTrue(tokens[0])
        self.assertEqual(len(set(tokens)), 1, tokens)


# --------------------------------------------------------------------------
# Health, the symbol route and the tick
# --------------------------------------------------------------------------


class TestHealthPublishesThePrefixes(KioskCase):
    def test_the_prefixes_sit_beside_the_commands_not_inside_them(self):
        _status, body, _headers = get(self.base() + "/health")
        router = json.loads(body.decode("utf-8"))["scan_router"]
        self.assertEqual(router["parametric_prefixes"], list(scan_router.PARAMETRIC_PREFIXES))
        self.assertEqual(sorted(router["commands"]), sorted(scan_router.COMMAND_CODES))
        for prefix in router["parametric_prefixes"]:
            self.assertNotIn(prefix, router["commands"])


class TestTheQrRouteDrawsTheNewCodes(KioskCase):
    def test_a_person_and_a_project_code_read_back(self):
        for code in (dispense_codes.person_code(4), dispense_codes.project_code(12),
                     dispense_codes.CMD_OHNE_PROJEKT):
            status, body, _headers = get(self.base() + "/qr.svg?text=%s&m=2"
                                         % urllib.parse.quote(code))
            self.assertEqual(status, 200, code)
            self.assertEqual(decode_qr(read_qr_svg(body.decode("utf-8"), 2, 4)), code)


class TestTheTickFetchesTheProjects(unittest.TestCase):
    def build_agent(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        agent = server.Agent(server.Store(Path(tmp.name) / "inventory.db"),
                             server.Printer(enabled=False), server.Upstream("", ""),
                             station=None, clock=lambda: 1000.0)
        self.addCleanup(agent.shutdown)
        return agent

    def test_the_crew_and_their_projects_reach_the_router_and_the_screen(self):
        agent = self.build_agent()
        asked = []
        agent.werkstatt.crew = lambda force=False: [MAX, ANNA]

        def crew_projects(force=False):
            asked.append(force)
            return {4: [SCHULZE]}

        agent.werkstatt.crew_projects = crew_projects
        agent._crew_at = 0.0
        agent.tick_once()
        self.assertEqual(asked, [False])
        self.assertEqual(agent.router.crew, [MAX, ANNA])
        agent.screen_action("regal", "assignee", 4)
        self.assertEqual(agent.kiosk.snapshot("regal")["projects"], [SCHULZE])

    def test_a_new_list_wakes_the_rack_screen(self):
        agent = self.build_agent()
        agent.werkstatt.crew = lambda force=False: []
        agent.werkstatt.crew_projects = lambda force=False: {4: [SCHULZE]}
        before = agent.kiosk.snapshot("regal")["seq"]
        agent._crew_at = 0.0
        agent.tick_once()
        self.assertGreater(agent.kiosk.snapshot("regal")["seq"], before)


# --------------------------------------------------------------------------
# The page: every code it can draw is one the router implements
# --------------------------------------------------------------------------


class TestTheRackPageCodes(unittest.TestCase):
    def setUp(self) -> None:
        self.html = PAGE.read_text(encoding="utf-8")

    def static_codes(self):
        found = []
        for src in re.findall(r'src="(/qr\.svg\?[^"]+)"', self.html):
            query = urllib.parse.parse_qs(src.split("?", 1)[1].replace("&amp;", "&"))
            found.append((query["text"][0], int(query["m"][0])))
        return found

    def script_codes(self):
        return set(re.findall(r"'(SMPL-CMD-[A-Z0-9-]*)'", self.html))

    def test_every_static_code_is_a_command_the_router_implements(self):
        codes = self.static_codes()
        self.assertTrue(codes)
        for text, module in codes:
            self.assertIn(text, scan_router.COMMAND_CODES, text)
            self.assertGreaterEqual(module, 2, text)

    def test_every_code_the_script_draws_is_a_command_or_a_published_prefix(self):
        drawn = self.script_codes()
        self.assertIn(dispense_codes.PERSON_PREFIX, drawn)
        self.assertIn(dispense_codes.PROJECT_PREFIX, drawn)
        self.assertIn(dispense_codes.CMD_OHNE_PROJEKT, drawn)
        for code in drawn:
            if code.endswith("-"):
                self.assertIn(code, scan_router.PARAMETRIC_PREFIXES, code)
            else:
                self.assertIn(code, scan_router.COMMAND_CODES, code)

    def test_every_code_fits_the_scanner_and_a_small_symbol(self):
        longest = [text for text, _m in self.static_codes()]
        for code in self.script_codes():
            longest.append(code + str(dispense_codes.MAX_ID) if code.endswith("-") else code)
        for code in longest:
            self.assertTrue(dispense_codes.fits_the_screen_alphabet(code), code)
            self.assertLessEqual(len(code), dispense_codes.MAX_SCREEN_CODE_LEN, code)
            # Version 2 at most: 66 px at m=2, the size the direction codes are.
            self.assertLessEqual(qrcode_svg.version_for(code), 2, code)

    def test_the_tiles_ask_for_a_scannable_module(self):
        modules = [int(m) for m in re.findall(r"[?&]m=(\d+)", self.html.replace("&amp;", "&"))]
        self.assertTrue(modules)
        self.assertTrue(all(m >= server.QR_MIN_M for m in modules), modules)

    def test_a_badge_is_never_drawn(self):
        self.assertNotIn("SMPL-P-", self.html)

    def test_it_posts_the_actions_the_agent_accepts(self):
        for action in ("project", "no_project", "assignee"):
            self.assertIn("action:'%s'" % action, self.html)
            self.assertEqual(server.ACTION_SCREEN[action], server.SCREEN_RACK)

    def test_it_says_who_and_what_for(self):
        self.assertIn("Ausgabe für", self.html)
        self.assertIn('id="picker"', self.html)
        self.assertIn("project_chosen", self.html)
        self.assertIn("Ohne Projekt", self.html)

    def test_server_values_never_reach_inner_html(self):
        self.assertNotRegex(self.html, r"\.innerHTML\s*=")


if __name__ == "__main__":
    unittest.main()
