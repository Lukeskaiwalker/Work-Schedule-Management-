"""The rack's Ausgabe of consumables: a person, a project, and what each scan books.

Owner, 2026-10-10: anything that is not in the Maschinen tab is a consumable;
scanned out at the rack it leaves stock for good and is installed at a site,
and the person taking it may name one of their current projects. Everything
has to work with QR codes off the screen.

What these pin, all without I/O (the router stays pure):

* the on-screen codes for a person and a project are recognised by prefix and
  never sent to /resolve, and fit the scanner's alphabet;
* a person code is accepted only for somebody in the crew the screen offered,
  a project code only for a project offered for the selected person;
* the project goes when the name changes, expires or FERTIG ends the Ausgabe;
* a consumable is booked as consumption, a tool as a checkout -- and the panel
  and crate sessions keep deciding everything exactly as before;
* ABBRUCH takes a consumption back out of exactly the bucket it went into.
"""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

import dispense_codes  # noqa: E402
import scan_router  # noqa: E402
from test_scan_router import MAX, Clock  # noqa: E402

ANNA = {"id": 9, "name": "Anna Beck"}
CREW = [MAX, ANNA]
SCHULZE = {"id": 12, "project_number": "381", "name": "Neubau Schulze", "hint": "heute"}
MEIER = {"id": 15, "project_number": "377", "name": "Umbau Meier", "hint": "zuletzt"}
PROJECTS = {4: [SCHULZE, MEIER], 9: [{"id": 20, "project_number": "390", "name": "Halle",
                                       "hint": "woche"}]}

CONSUMABLE = dispense_codes.KIND_CONSUMABLE
TOOL = dispense_codes.KIND_TOOL
EAN = "4011923456789"


def build(**kwargs):
    clock = Clock()
    router = scan_router.ScanRouter(clock=clock, **kwargs)
    router.set_crew(CREW)
    router.set_crew_projects(PROJECTS)
    return router, clock


def named(**kwargs):
    router, clock = build(**kwargs)
    router.set_assignee(MAX)
    return router, clock


# --------------------------------------------------------------------------
# The codes themselves
# --------------------------------------------------------------------------


class TestTheScreenCodes(unittest.TestCase):
    def test_a_person_and_a_project_have_one_code_each(self):
        self.assertEqual(dispense_codes.person_code(4), "SMPL-CMD-PERSON-4")
        self.assertEqual(dispense_codes.project_code(12), "SMPL-CMD-PROJEKT-12")
        self.assertEqual(dispense_codes.CMD_OHNE_PROJEKT, "SMPL-CMD-OHNE-PROJEKT")

    def test_a_nonsense_id_has_no_code(self):
        for bad in (0, -1, True, "4", None, 10 ** 9):
            with self.assertRaises(ValueError, msg=repr(bad)):
                dispense_codes.person_code(bad)

    def test_they_are_parsed_back(self):
        sel = dispense_codes.selection_of
        self.assertEqual(sel("SMPL-CMD-PERSON-4"), ("person", 4))
        self.assertEqual(sel("  smpl-cmd-projekt-12 "), ("project", 12))
        self.assertEqual(sel("SMPL-CMD-OHNE-PROJEKT"), ("no_project", None))

    def test_a_garbled_one_is_still_one_of_ours(self):
        # Recognised by the prefix, so it is refused in German at the rack
        # rather than looked up as an article nobody stocks.
        self.assertEqual(dispense_codes.selection_of("SMPL-CMD-PERSON-"), ("person", None))
        self.assertEqual(dispense_codes.selection_of("SMPL-CMD-PROJEKT-1X"), ("project", None))
        self.assertEqual(dispense_codes.selection_of("SMPL-CMD-PERSON-0"), ("person", None))
        self.assertEqual(dispense_codes.selection_of("SMPL-CMD-PERSON-1234567890"),
                         ("person", None))

    def test_other_codes_are_not(self):
        for code in ("SMPL-CMD-FERTIG", "SMPL-A1B2C3", "SMPL-P-7KQ2M9XH4R", "KISTE-K3",
                     "VT-0007", EAN, "", None):
            self.assertIsNone(dispense_codes.selection_of(code), code)

    def test_every_code_fits_the_scanner_and_a_small_qr(self):
        longest = [dispense_codes.person_code(dispense_codes.MAX_ID),
                   dispense_codes.project_code(dispense_codes.MAX_ID),
                   dispense_codes.CMD_OHNE_PROJEKT]
        for code in longest:
            self.assertLessEqual(len(code), dispense_codes.MAX_SCREEN_CODE_LEN, code)
            self.assertTrue(dispense_codes.fits_the_screen_alphabet(code), code)
            # No Y and no Z: a command is never resolved, so the Y/Z retry
            # cannot rescue a scanner in the wrong layout.
            self.assertNotIn("Y", code)
            self.assertNotIn("Z", code)

    def test_none_of_them_can_be_an_article_a_badge_a_crate_or_a_panel(self):
        for code in ("SMPL-CMD-PERSON-4", "SMPL-CMD-PROJEKT-12", "SMPL-CMD-OHNE-PROJEKT"):
            self.assertFalse(scan_router.is_internal_article_code(code), code)
            self.assertFalse(scan_router.is_badge_code(code), code)
            self.assertFalse(scan_router.is_box_code(code), code)
            self.assertFalse(scan_router.is_panel_code(code), code)

    def test_the_static_one_is_a_command_and_the_prefixes_are_not(self):
        self.assertIn(dispense_codes.CMD_OHNE_PROJEKT, scan_router.COMMAND_CODES)
        self.assertEqual(scan_router.PARAMETRIC_PREFIXES,
                         ("SMPL-CMD-PERSON-", "SMPL-CMD-PROJEKT-"))
        for prefix in scan_router.PARAMETRIC_PREFIXES:
            self.assertNotIn(prefix, scan_router.COMMAND_CODES)

    def test_none_of_them_is_ever_resolved(self):
        router, _ = build()
        for code in ("SMPL-CMD-PERSON-4", "SMPL-CMD-PROJEKT-12", "SMPL-CMD-OHNE-PROJEKT",
                     "SMPL-CMD-PERSON-ABC", "smpl-cmd-person-99"):
            self.assertFalse(router.needs_resolution(code), code)
        self.assertTrue(router.needs_resolution(EAN))

    def test_the_module_does_no_io(self):
        source = (HERE.parent / "dispense_codes.py").read_text(encoding="utf-8")
        for forbidden in ("import urllib", "import socket", "import threading",
                          "import subprocess", "import requests", "time.time()",
                          "import http", "import os"):
            self.assertNotIn(forbidden, source)


class TestTheProjectListIsCleaned(unittest.TestCase):
    def test_garbage_is_dropped_and_the_projection_is_four_fields(self):
        cleaned = dispense_codes.clean_crew_projects({
            "week_start": "2026-10-05",
            "people": [
                {"user_id": 4, "projects": [
                    dict(SCHULZE, customer="Schulze GmbH", address="Hauptstr. 1"),
                    {"id": 0, "project_number": "x"}, "nope", {"name": "no id"},
                    {"id": 12, "project_number": "381", "name": "duplicate"},
                    {"id": 15, "project_number": 377, "name": "  Umbau  ", "hint": "bald"},
                ]},
                {"user_id": "9", "projects": []},
                {"user_id": True, "projects": [SCHULZE]},
                "not a row",
            ],
        })
        self.assertEqual(cleaned, {
            4: ({"id": 12, "project_number": "381", "name": "Neubau Schulze", "hint": "heute"},
                {"id": 15, "project_number": "377", "name": "Umbau", "hint": None}),
        })

    def test_at_most_eight_per_person(self):
        rows = [{"id": n, "project_number": str(n), "name": "P"} for n in range(1, 20)]
        cleaned = dispense_codes.clean_crew_projects({"people": [{"user_id": 4,
                                                                  "projects": rows}]})
        self.assertEqual(len(cleaned[4]), dispense_codes.MAX_PROJECTS_PER_PERSON)
        self.assertEqual(dispense_codes.MAX_PROJECTS_PER_PERSON, 8)

    def test_something_that_is_not_a_list_is_none(self):
        self.assertIsNone(dispense_codes.clean_crew_projects("nope"))
        self.assertIsNone(dispense_codes.clean_crew_projects({"people": "x"}))
        self.assertEqual(dispense_codes.clean_crew_projects({"people": []}), {})

    def test_a_label_reads_like_the_wall_says_it(self):
        self.assertEqual(dispense_codes.project_label(SCHULZE), "381 Neubau Schulze")
        self.assertEqual(dispense_codes.project_label({"id": 3, "name": "Halle"}), "Halle")
        self.assertEqual(dispense_codes.project_label(None), "ohne Projekt")


# --------------------------------------------------------------------------
# Picking a person by QR
# --------------------------------------------------------------------------


class TestAPersonCode(unittest.TestCase):
    def test_somebody_in_the_crew_is_selected(self):
        router, _ = build()
        decision = router.route("SMPL-CMD-PERSON-4")
        self.assertTrue(decision.ok)
        self.assertEqual(decision.screen, "regal")
        self.assertEqual(decision.action, "select_person")
        self.assertEqual(decision.assignee_user_id, 4)
        self.assertEqual(router.assignee, {"id": 4, "name": "Max Mustermann"})

    def test_somebody_outside_the_crew_is_refused_and_nobody_is_selected(self):
        router, _ = build()
        decision = router.route("SMPL-CMD-PERSON-77")
        self.assertFalse(decision.ok)
        self.assertEqual(decision.action, "unknown_person")
        self.assertEqual(decision.screen, "regal")
        self.assertEqual(decision.error, scan_router.MSG_UNKNOWN_PERSON)
        self.assertIsNone(router.assignee)

    def test_an_unknown_code_does_not_replace_the_person_standing_there(self):
        router, clock = named()
        clock.advance(1)
        router.route("SMPL-CMD-PERSON-77")
        self.assertEqual(router.assignee["id"], 4)

    def test_with_no_crew_at_all_nobody_can_be_scanned_in(self):
        router = scan_router.ScanRouter(clock=Clock())
        self.assertEqual(router.route("SMPL-CMD-PERSON-4").action, "unknown_person")
        self.assertIsNone(router.assignee)

    def test_a_garbled_person_code_is_refused_not_looked_up(self):
        router, _ = build()
        decision = router.route("SMPL-CMD-PERSON-XX")
        self.assertEqual(decision.action, "unknown_person")
        self.assertFalse(decision.ok)

    def test_it_answers_a_refused_ausgabe(self):
        router, clock = build()
        self.assertEqual(router.route(EAN, kind=CONSUMABLE).action, "needs_assignee")
        clock.advance(1)
        router.route("SMPL-CMD-PERSON-9")
        clock.advance(1)
        booked = router.route(EAN, kind=CONSUMABLE)
        self.assertEqual(booked.action, "consumption")
        self.assertEqual(booked.assignee_user_id, 9)

    def test_the_crew_is_cleaned_on_the_way_in(self):
        router = scan_router.ScanRouter(clock=Clock())
        router.set_crew([{"id": 4, "name": "Max"}, {"id": 0, "name": "x"}, "nope",
                         {"id": 9, "name": "  "}])
        self.assertEqual(router.crew, [{"id": 4, "name": "Max"}])


# --------------------------------------------------------------------------
# Picking a project
# --------------------------------------------------------------------------


class TestAProjectCode(unittest.TestCase):
    def test_a_project_needs_a_person_first(self):
        router, _ = build()
        decision = router.route("SMPL-CMD-PROJEKT-12")
        self.assertFalse(decision.ok)
        self.assertEqual(decision.action, "selection_refused")
        self.assertEqual(decision.error, scan_router.MSG_PROJECT_NEEDS_PERSON)
        self.assertFalse(router.project_chosen)

    def test_a_project_offered_for_that_person_is_selected(self):
        router, clock = named()
        clock.advance(1)
        decision = router.route("SMPL-CMD-PROJEKT-12")
        self.assertTrue(decision.ok)
        self.assertEqual(decision.action, "select_project")
        self.assertEqual(decision.project_id, 12)
        self.assertTrue(router.project_chosen)
        self.assertEqual(router.project, {"id": 12, "project_number": "381",
                                          "name": "Neubau Schulze"})

    def test_somebody_elses_project_is_refused(self):
        router, clock = named()
        clock.advance(1)
        decision = router.route("SMPL-CMD-PROJEKT-20")      # Anna's, not Max's
        self.assertFalse(decision.ok)
        self.assertEqual(decision.action, "selection_refused")
        self.assertEqual(decision.error, scan_router.MSG_PROJECT_NOT_OFFERED)
        self.assertFalse(router.project_chosen)

    def test_a_project_nobody_was_offered_is_refused(self):
        router, clock = named()
        clock.advance(1)
        self.assertEqual(router.route("SMPL-CMD-PROJEKT-999").action, "selection_refused")

    def test_ohne_projekt_is_a_choice_too(self):
        router, clock = named()
        clock.advance(1)
        decision = router.route("SMPL-CMD-OHNE-PROJEKT")
        self.assertTrue(decision.ok)
        self.assertEqual(decision.action, "select_project")
        self.assertIsNone(decision.project_id)
        self.assertTrue(router.project_chosen)
        self.assertIsNone(router.project)

    def test_ohne_projekt_also_needs_a_person(self):
        router, _ = build()
        decision = router.route("SMPL-CMD-OHNE-PROJEKT")
        self.assertEqual(decision.action, "selection_refused")
        self.assertFalse(router.project_chosen)

    def test_the_tap_follows_the_same_rule(self):
        router, _ = build()
        self.assertEqual(router.select_project(12), scan_router.MSG_PROJECT_NEEDS_PERSON)
        router.set_assignee(MAX)
        self.assertEqual(router.select_project(20), scan_router.MSG_PROJECT_NOT_OFFERED)
        self.assertIsNone(router.select_project(15))
        self.assertEqual(router.project["id"], 15)
        self.assertIsNone(router.select_project(None))
        self.assertTrue(router.project_chosen)
        self.assertIsNone(router.project)

    def test_clearing_the_project_brings_the_choice_back(self):
        router, _ = named()
        router.select_project(12)
        router.clear_project()
        self.assertFalse(router.project_chosen)
        self.assertIsNone(router.project)
        self.assertEqual(router.assignee["id"], 4)

    def test_the_offered_list_is_the_selected_persons(self):
        router, _ = build()
        self.assertEqual(router.offered_projects(), [])
        router.set_assignee(MAX)
        self.assertEqual([p["id"] for p in router.offered_projects()], [12, 15])
        router.set_assignee(ANNA)
        self.assertEqual([p["id"] for p in router.offered_projects()], [20])

    def test_a_new_list_says_whether_anything_changed(self):
        router, _ = build()
        self.assertFalse(router.set_crew_projects(PROJECTS))
        self.assertTrue(router.set_crew_projects({4: [SCHULZE]}))
        self.assertEqual([p["id"] for p in router.offered_projects(4)], [12])

    def test_the_selection_is_json_shaped_for_the_screen(self):
        router, _ = named()
        router.select_project(12)
        payload = router.selection()
        json.dumps(payload)
        self.assertEqual(payload["project"], {"id": 12, "project_number": "381",
                                              "name": "Neubau Schulze"})
        self.assertTrue(payload["project_chosen"])
        self.assertEqual([p["id"] for p in payload["projects"]], [12, 15])
        self.assertEqual(payload["projects"][0]["hint"], "heute")
        snapshot = router.snapshot()
        json.dumps(snapshot)
        self.assertTrue(snapshot["project_chosen"])


# --------------------------------------------------------------------------
# When the project goes
# --------------------------------------------------------------------------


class TestTheProjectGoesWithTheName(unittest.TestCase):
    def test_a_different_person_clears_it(self):
        router, _ = named()
        router.select_project(12)
        router.set_assignee(ANNA)
        self.assertFalse(router.project_chosen)
        self.assertIsNone(router.project)

    def test_a_different_person_by_qr_clears_it(self):
        router, clock = named()
        router.select_project(12)
        clock.advance(1)
        router.route("SMPL-CMD-PERSON-9")
        self.assertFalse(router.project_chosen)

    def test_the_same_person_again_keeps_it(self):
        router, clock = named()
        router.select_project(12)
        clock.advance(1)
        router.route("SMPL-CMD-PERSON-4")
        self.assertTrue(router.project_chosen)
        self.assertEqual(router.project["id"], 12)

    def test_clearing_the_name_clears_it(self):
        router, _ = named()
        router.select_project(None)
        router.set_assignee(None)
        self.assertFalse(router.project_chosen)

    def test_it_expires_with_the_name(self):
        router, clock = build(assignee_timeout_s=120.0)
        router.set_assignee(MAX)
        router.select_project(12)
        clock.advance(121)
        self.assertTrue(router.expire_assignee())
        self.assertIsNone(router.assignee)
        self.assertFalse(router.project_chosen)
        self.assertIsNone(router.project)

    def test_fertig_ends_the_ausgabe(self):
        router, clock = named()
        router.select_project(12)
        clock.advance(1)
        decision = router.route("SMPL-CMD-FERTIG")
        self.assertEqual(decision.action, "close_selection")
        self.assertEqual(decision.screen, "regal")
        self.assertTrue(decision.ok)
        self.assertIsNone(router.assignee)
        self.assertFalse(router.project_chosen)

    def test_changing_the_direction_does_not(self):
        router, clock = named()
        router.select_project(12)
        clock.advance(1)
        router.route("SMPL-CMD-EIN")
        self.assertTrue(router.project_chosen)


# --------------------------------------------------------------------------
# FERTIG: panel, then the Ausgabe, then the crate
# --------------------------------------------------------------------------


class TestFertigPrecedence(unittest.TestCase):
    def test_an_open_panel_wins_and_the_selection_stays(self):
        router, clock = named()
        router.select_project(12)
        router.route("VT-0007")
        clock.advance(1)
        self.assertEqual(router.route("SMPL-CMD-FERTIG").action, "close_panel")
        self.assertEqual(router.assignee["id"], 4)
        self.assertTrue(router.project_chosen)

    def test_the_selection_comes_before_the_crate(self):
        router, clock = named()
        router.route("KISTE-K3")
        clock.advance(1)
        self.assertEqual(router.route("SMPL-CMD-FERTIG").action, "close_selection")
        self.assertIsNotNone(router.session)
        clock.advance(1)
        self.assertEqual(router.route("SMPL-CMD-FERTIG").action, "close_session")
        self.assertIsNone(router.session)

    def test_with_nothing_selected_it_still_means_the_crate(self):
        router, _ = build()
        self.assertEqual(router.route("SMPL-CMD-FERTIG").action, "close_session")


# --------------------------------------------------------------------------
# What an article scan books
# --------------------------------------------------------------------------


class TestConsumptionOrCheckout(unittest.TestCase):
    def test_a_consumable_ausgabe_is_consumption_for_the_person_and_project(self):
        router, clock = named()
        router.select_project(12)
        router.route("SMPL-CMD-MENGE-5")
        clock.advance(1)
        decision = router.route(EAN, kind=CONSUMABLE)
        self.assertTrue(decision.ok)
        self.assertEqual(decision.screen, "regal")
        self.assertEqual(decision.action, "consumption")
        self.assertEqual(decision.movement_type, "consumption")
        self.assertEqual(decision.qty, 5)
        self.assertEqual(decision.assignee_user_id, 4)
        self.assertEqual(decision.project_id, 12)
        self.assertEqual(router.pending_qty, 1)

    def test_without_a_project_it_is_still_booked_just_on_no_project(self):
        router, _ = named()
        decision = router.route(EAN, kind=CONSUMABLE)
        self.assertEqual(decision.action, "consumption")
        self.assertIsNone(decision.project_id)

    def test_a_consumable_still_needs_a_name(self):
        router, _ = build()
        decision = router.route(EAN, kind=CONSUMABLE)
        self.assertFalse(decision.ok)
        self.assertEqual(decision.action, "needs_assignee")
        self.assertEqual(decision.error, scan_router.MSG_NEEDS_ASSIGNEE)

    def test_a_tool_is_still_lent_out(self):
        router, _ = named()
        router.select_project(12)
        decision = router.route(EAN, kind=TOOL)
        self.assertEqual(decision.action, "movement")
        self.assertEqual(decision.movement_type, "checkout")
        self.assertEqual(decision.assignee_user_id, 4)

    def test_an_article_of_unknown_kind_keeps_todays_rule(self):
        router, _ = named()
        decision = router.route(EAN, kind="werkstatt_article")
        self.assertEqual(decision.action, "movement")
        self.assertEqual(decision.movement_type, "checkout")

    def test_a_wareneingang_of_a_consumable_is_an_intake(self):
        router, _ = named()
        router.set_direction("wareneingang")
        decision = router.route(EAN, kind=CONSUMABLE)
        self.assertEqual(decision.action, "movement")
        self.assertEqual(decision.movement_type, "intake")
        self.assertIsNone(decision.assignee_user_id)

    def test_a_machine_unit_is_still_only_looked_up(self):
        router, _ = named()
        self.assertEqual(router.route("M-0001", kind="machine").action, "machine")

    def test_a_tool_comes_back_as_a_return(self):
        router, _ = build()
        router.set_direction("ein")
        decision = router.route(EAN, kind=TOOL)
        self.assertEqual(decision.action, "movement")
        self.assertEqual(decision.movement_type, "return")


class TestRueckgabeOfAConsumable(unittest.TestCase):
    def test_with_no_project_chosen_the_server_picks_the_bucket(self):
        router, _ = build()
        router.set_direction("ein")
        decision = router.route(EAN, kind=CONSUMABLE)
        self.assertTrue(decision.ok)
        self.assertEqual(decision.action, "consumption_return")
        self.assertEqual(decision.movement_type, "consumption_undo")
        self.assertTrue(decision.pick_project)
        self.assertIsNone(decision.project_id)
        self.assertIsNone(decision.assignee_user_id)

    def test_it_carries_a_tapped_name(self):
        router, _ = named()
        router.set_direction("ein")
        decision = router.route(EAN, kind=CONSUMABLE)
        self.assertEqual(decision.assignee_user_id, 4)
        self.assertTrue(decision.pick_project)

    def test_a_chosen_project_names_the_bucket(self):
        router, _ = named()
        router.select_project(15)
        router.set_direction("ein")
        decision = router.route(EAN, kind=CONSUMABLE)
        self.assertFalse(decision.pick_project)
        self.assertEqual(decision.project_id, 15)

    def test_ohne_projekt_chosen_names_the_bucket_without_one(self):
        router, _ = named()
        router.select_project(None)
        router.set_direction("ein")
        decision = router.route(EAN, kind=CONSUMABLE)
        self.assertFalse(decision.pick_project)
        self.assertIsNone(decision.project_id)

    def test_the_decision_serialises_its_new_fields(self):
        router, _ = build()
        router.set_direction("ein")
        payload = router.route(EAN, kind=CONSUMABLE).as_dict()
        json.dumps(payload)
        self.assertTrue(payload["pick_project"])
        self.assertIn("project_id", payload)


# --------------------------------------------------------------------------
# The sessions keep their precedence
# --------------------------------------------------------------------------


class TestSessionsStillDecide(unittest.TestCase):
    def test_a_consumable_in_a_panel_session_is_a_panel_item(self):
        router, clock = named()
        router.select_project(12)
        router.route("VT-0007")
        clock.advance(1)
        decision = router.route(EAN, kind=CONSUMABLE)
        self.assertEqual(decision.action, "panel_item")
        self.assertEqual(decision.panel_code, "VT-0007")

    def test_a_tool_in_a_panel_session_is_a_panel_item_too(self):
        router, clock = named()
        router.route("VT-0007")
        clock.advance(1)
        self.assertEqual(router.route(EAN, kind=TOOL).action, "panel_item")

    def test_a_consumable_in_a_crate_session_goes_into_the_crate(self):
        router, clock = named()
        router.route("KISTE-K3")
        clock.advance(1)
        decision = router.route(EAN, kind=CONSUMABLE)
        self.assertEqual(decision.action, "add_item")
        self.assertEqual(decision.screen, "kisten")

    def test_a_person_code_does_not_close_a_session(self):
        router, clock = build()
        router.route("KISTE-K3")
        clock.advance(1)
        router.route("SMPL-CMD-PERSON-4")
        self.assertIsNotNone(router.session)
        clock.advance(1)
        self.assertEqual(router.route(EAN, kind=CONSUMABLE).action, "add_item")


# --------------------------------------------------------------------------
# ABBRUCH takes a consumption back out of exactly its bucket
# --------------------------------------------------------------------------


class TestUndoingAConsumption(unittest.TestCase):
    def test_the_last_consumption_is_taken_back_from_its_project(self):
        router, clock = named()
        router.note_commit(screen="regal", action="consumption", article_id=5,
                           movement_type="consumption", qty=3, assignee_user_id=4,
                           project_id=12)
        clock.advance(1)
        decision = router.route("SMPL-CMD-ABBRUCH")
        self.assertTrue(decision.ok)
        self.assertEqual(decision.action, "undo_consumption")
        self.assertEqual(decision.movement_type, "consumption_undo")
        self.assertEqual(decision.project_id, 12)
        self.assertEqual(decision.undo, {"article_id": 5, "movement_type": "consumption_undo",
                                         "qty": 3, "assignee_user_id": 4, "project_id": 12,
                                         "request_id": None, "undo_of_movement_id": None})

    def test_the_undo_names_the_consumption_it_takes_back(self):
        # SMPL reverses a short-shelf top-up only for the consumption it is
        # told about: the movement id SMPL answered the booking with.
        router, clock = named()
        router.note_commit(screen="regal", action="consumption", article_id=5,
                           movement_type="consumption", qty=50, assignee_user_id=4,
                           project_id=12, movement_id=91)
        clock.advance(1)
        decision = router.route("SMPL-CMD-ABBRUCH")
        self.assertEqual(decision.undo["undo_of_movement_id"], 91)
        clock.advance(1)
        self.assertEqual(router.route("SMPL-CMD-ABBRUCH").undo["undo_of_movement_id"], 91,
                         "a retried ABBRUCH names the same consumption")

    def test_undoing_a_rueckgabe_names_no_consumption(self):
        # Re-consuming leftovers has no top-up to reverse.
        router, clock = named()
        router.note_commit(screen="regal", action="consumption", article_id=5,
                           movement_type="consumption_undo", qty=2, assignee_user_id=4,
                           project_id=12, movement_id=92)
        clock.advance(1)
        self.assertIsNone(router.route("SMPL-CMD-ABBRUCH").undo["undo_of_movement_id"])

    def test_the_commit_remembers_its_movement_id(self):
        router, _clock = named()
        router.note_commit(screen="regal", action="consumption", article_id=5,
                           movement_type="consumption", qty=1, assignee_user_id=4,
                           movement_id=91)
        self.assertEqual(router.state.last_actions["regal"].movement_id, 91)
        router.note_commit(screen="regal", action="consumption", article_id=5,
                           movement_type="consumption", qty=1, assignee_user_id=4,
                           movement_id=True)
        self.assertIsNone(router.state.last_actions["regal"].movement_id)

    def test_every_try_of_the_same_undo_carries_the_same_token(self):
        router, clock = named()
        router.note_commit(screen="regal", action="consumption", article_id=5,
                           movement_type="consumption", qty=1, assignee_user_id=4,
                           project_id=12, undo_request_id="u" * 32)
        clock.advance(1)
        first = router.route("SMPL-CMD-ABBRUCH")
        clock.advance(1)
        second = router.route("SMPL-CMD-ABBRUCH")
        self.assertEqual(first.undo["request_id"], "u" * 32)
        self.assertEqual(second.undo["request_id"], "u" * 32)

    def test_the_bucket_is_the_booked_one_not_the_one_selected_now(self):
        router, clock = named()
        router.select_project(12)
        router.note_commit(screen="regal", action="consumption", article_id=5,
                           movement_type="consumption", qty=1, assignee_user_id=4,
                           project_id=12)
        router.select_project(15)
        clock.advance(1)
        self.assertEqual(router.route("SMPL-CMD-ABBRUCH").undo["project_id"], 12)

    def test_a_consumption_without_a_project_is_undone_without_one(self):
        router, clock = named()
        router.note_commit(screen="regal", action="consumption", article_id=5,
                           movement_type="consumption", qty=1, assignee_user_id=4)
        clock.advance(1)
        decision = router.route("SMPL-CMD-ABBRUCH")
        self.assertEqual(decision.action, "undo_consumption")
        self.assertIsNone(decision.undo["project_id"])

    def test_undoing_a_rueckgabe_consumes_it_again_onto_the_same_person(self):
        router, clock = build()
        router.note_commit(screen="regal", action="consumption", article_id=5,
                           movement_type="consumption_undo", qty=2, assignee_user_id=9,
                           project_id=15)
        clock.advance(1)
        decision = router.route("SMPL-CMD-ABBRUCH")
        self.assertEqual(decision.action, "undo_consumption")
        self.assertEqual(decision.undo["movement_type"], "consumption")
        self.assertEqual(decision.undo["assignee_user_id"], 9)
        self.assertEqual(decision.undo["project_id"], 15)

    def test_undoing_an_anonymous_rueckgabe_takes_the_name_tapped_now(self):
        router, clock = named()
        router.note_commit(screen="regal", action="consumption", article_id=5,
                           movement_type="consumption_undo", qty=2, project_id=15)
        clock.advance(1)
        self.assertEqual(router.route("SMPL-CMD-ABBRUCH").undo["assignee_user_id"], 4)

    def test_undoing_an_anonymous_rueckgabe_with_nobody_tapped_is_refused(self):
        router, clock = build()
        router.note_commit(screen="regal", action="consumption", article_id=5,
                           movement_type="consumption_undo", qty=2, project_id=15)
        clock.advance(1)
        decision = router.route("SMPL-CMD-ABBRUCH")
        self.assertFalse(decision.ok)
        self.assertEqual(decision.action, "needs_assignee")
        self.assertIsNone(decision.undo)

    def test_nothing_is_forgotten_until_smpl_accepted_the_undo(self):
        router, clock = named()
        router.note_commit(screen="regal", action="consumption", article_id=5,
                           movement_type="consumption", qty=1, assignee_user_id=4,
                           project_id=12)
        clock.advance(1)
        router.route("SMPL-CMD-ABBRUCH")
        clock.advance(1)
        self.assertEqual(router.route("SMPL-CMD-ABBRUCH").action, "undo_consumption")
        router.confirm_undo("regal")
        clock.advance(1)
        self.assertEqual(router.route("SMPL-CMD-ABBRUCH").action, "nothing_to_undo")

    def test_a_consumption_is_not_undone_into_an_open_panel(self):
        router, clock = named()
        router.note_commit(screen="regal", action="consumption", article_id=5,
                           movement_type="consumption", qty=1, assignee_user_id=4)
        router.route("VT-0007")
        clock.advance(1)
        self.assertEqual(router.route("SMPL-CMD-ABBRUCH").action, "nothing_to_undo")

    def test_the_name_rule_covers_consumption_too(self):
        needs = scan_router.movement_needs_assignee
        self.assertTrue(needs("consumption", None))
        self.assertFalse(needs("consumption", 4))
        self.assertFalse(needs("consumption_undo", None))
        self.assertEqual(scan_router.MOVEMENT_REQUIRING_ASSIGNEE, "checkout")


# --------------------------------------------------------------------------
# A booking SMPL never answered keeps its token for the re-scan
# --------------------------------------------------------------------------


KEY = ("consumption", 5, 3, 4, 12, False)


class TestKeptRequestIds(unittest.TestCase):
    """Two timeouts on the Pi do not mean SMPL booked nothing: the first try
    may have landed. A re-scan of the same thing has to replay that try, so
    its token is held until SMPL has answered."""

    def test_a_kept_token_comes_back_for_the_same_booking_only(self):
        router, _clock = named()
        self.assertIsNone(router.kept_request_id(KEY))
        router.keep_request_id(KEY, "t" * 32)
        self.assertEqual(router.kept_request_id(KEY), "t" * 32)
        for other in (("consumption", 5, 5, 4, 12, False),     # another quantity
                      ("consumption", 5, 3, 9, 12, False),     # another person
                      ("consumption", 5, 3, 4, None, False),   # another project
                      ("consumption_return", 5, 3, 4, 12, False)):
            self.assertIsNone(router.kept_request_id(other), other)

    def test_it_survives_the_rescan_itself(self):
        # Routing the next scan clears the staged article; the token is not
        # staged state, it is what the next booking has to carry.
        router, clock = named()
        router.note_pending({"id": 5, "item_name": "Kabelbinder"}, 3)
        router.keep_request_id(KEY, "t" * 32)
        clock.advance(1)
        router.route(EAN, kind=CONSUMABLE)
        router.route("SMPL-CMD-ABBRUCH")
        router.route("SMPL-CMD-FERTIG")
        self.assertEqual(router.kept_request_id(KEY), "t" * 32)

    def test_it_is_dropped_once_smpl_answered(self):
        router, _clock = named()
        router.keep_request_id(KEY, "t" * 32)
        router.keep_request_id(("consumption", 6, 1, 4, None, False), "u" * 32)
        router.drop_request_id(KEY)
        self.assertIsNone(router.kept_request_id(KEY))
        self.assertEqual(router.kept_request_id(("consumption", 6, 1, 4, None, False)),
                         "u" * 32, "another booking's token is not this answer's")

    def test_a_failed_retry_holds_it_again_from_now(self):
        router, clock = named()
        router.keep_request_id(KEY, "t" * 32)
        clock.advance(scan_router.KEEP_REQUEST_ID_S - 1)
        router.keep_request_id(KEY, "t" * 32)
        clock.advance(scan_router.KEEP_REQUEST_ID_S - 1)
        self.assertEqual(router.kept_request_id(KEY), "t" * 32)

    def test_it_is_not_kept_for_ever(self):
        # Much later the same scan is a new booking, not the lost one.
        router, clock = named()
        router.keep_request_id(KEY, "t" * 32)
        clock.advance(scan_router.KEEP_REQUEST_ID_S + 1)
        self.assertIsNone(router.kept_request_id(KEY))

    def test_only_a_few_are_kept(self):
        router, _clock = named()
        for article in range(1, scan_router.MAX_KEPT_REQUEST_IDS + 3):
            router.keep_request_id(("consumption", article, 1, 4, None, False),
                                   "t%d" % article)
        self.assertIsNone(router.kept_request_id(("consumption", 1, 1, 4, None, False)))
        last = scan_router.MAX_KEPT_REQUEST_IDS + 2
        self.assertEqual(router.kept_request_id(("consumption", last, 1, 4, None, False)),
                         "t%d" % last)

    def test_the_old_state_is_never_edited(self):
        router, _clock = named()
        before = router.state
        router.keep_request_id(KEY, "t" * 32)
        self.assertEqual(before.kept_request_ids, ())
        during = router.state
        router.drop_request_id(KEY)
        self.assertEqual(len(during.kept_request_ids), 1)

    def test_an_empty_token_is_not_kept(self):
        router, _clock = named()
        router.keep_request_id(KEY, "")
        self.assertIsNone(router.kept_request_id(KEY))

    def test_the_store_does_no_io_and_reads_no_clock(self):
        # The router hands it the time; the rules stay testable in microseconds.
        source = (HERE.parent / "kept_requests.py").read_text(encoding="utf-8")
        for forbidden in ("import urllib", "import socket", "import threading",
                          "import time", "import uuid", "import os"):
            self.assertNotIn(forbidden, source)


if __name__ == "__main__":
    unittest.main()
