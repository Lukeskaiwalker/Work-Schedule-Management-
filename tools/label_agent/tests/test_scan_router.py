"""The rules that decide which screen a scan belongs to.

Every test here drives a fake clock. The router is required to take its time
function as an argument precisely so that "the session times out after ten
minutes" is a test that runs in microseconds rather than a test nobody runs.

A good half of these assert a *negative*: that a command code can never be
mistaken for an article, that a de-duplicated scan changes nothing at all,
that switching boxes is not an error. Those are the ones that stop a later
change from quietly turning a routing decision into a wrong shelf.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

import scan_router  # noqa: E402


class Clock:
    """A time source the test moves by hand."""

    def __init__(self, start: float = 1000.0) -> None:
        self.now = float(start)

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> float:
        self.now += float(seconds)
        return self.now


def build(**kwargs):
    clock = Clock()
    router = scan_router.ScanRouter(clock=clock, **kwargs)
    return router, clock


MAX = {"id": 4, "name": "Max Mustermann"}


def with_name(**kwargs):
    """A router with a name already tapped, for the many tests about *other*
    rules. An "aus" scan with nobody tapped is refused on purpose (see
    TestAssignee); every test that is not about that rule taps first."""
    router, clock = build(**kwargs)
    router.set_assignee(MAX)
    return router, clock


# --------------------------------------------------------------------------
# Command codes can never be an article
# --------------------------------------------------------------------------


class TestCommandsCannotCollideWithArticles(unittest.TestCase):
    def test_every_command_is_rejected_as_an_internal_article_code(self):
        for code in scan_router.COMMAND_CODES:
            self.assertFalse(
                scan_router.is_internal_article_code(code),
                f"{code} would be readable as an article code",
            )

    def test_internal_article_codes_are_prefix_plus_six_alphabet_chars(self):
        self.assertTrue(scan_router.is_internal_article_code("SMPL-A1B2C3"))
        self.assertTrue(scan_router.is_internal_article_code("SMPL-000000"))
        self.assertFalse(scan_router.is_internal_article_code("SMPL-A1B2C"))     # five
        self.assertFalse(scan_router.is_internal_article_code("SMPL-A1B2C34"))   # seven
        self.assertFalse(scan_router.is_internal_article_code("SMPL-A1B2-3"))    # hyphen
        self.assertFalse(scan_router.is_internal_article_code("SMPL-A1B2I3"))    # I not in alphabet
        self.assertFalse(scan_router.is_internal_article_code("SMPL-A1B2O3"))    # O not in alphabet
        self.assertFalse(scan_router.is_internal_article_code("4011923456789"))

    def test_the_alphabet_matches_the_server(self):
        # apps/api/app/services/werkstatt_internal_codes.py mints these; if the
        # two alphabets drift, a freshly printed label stops routing.
        self.assertEqual(scan_router.CODE_ALPHABET, "0123456789ABCDEFGHJKLMNPQRSTUVWXYZ")
        self.assertEqual(scan_router.CODE_PREFIX, "SMPL-")
        self.assertEqual(scan_router.CODE_LENGTH, 6)
        self.assertNotIn("-", scan_router.CODE_ALPHABET)

    def test_commands_are_read_before_anything_else(self):
        router, _ = build()
        router.route("KISTE-K3")
        decision = router.route("SMPL-CMD-FERTIG")
        self.assertEqual(decision.action, "close_session")
        self.assertIsNone(router.session)

    def test_a_command_needs_no_resolution(self):
        router, _ = build()
        self.assertFalse(router.needs_resolution("SMPL-CMD-FERTIG"))
        self.assertFalse(router.needs_resolution("KISTE-K3"))
        self.assertTrue(router.needs_resolution("4011923456789"))
        self.assertTrue(router.needs_resolution("SMPL-A1B2C3"))


# --------------------------------------------------------------------------
# Box sessions
# --------------------------------------------------------------------------


class TestBoxSessions(unittest.TestCase):
    def test_a_kiste_code_opens_a_session_on_the_box_screen(self):
        router, _ = build()
        decision = router.route("KISTE-K3")
        self.assertEqual(decision.screen, "kisten")
        self.assertEqual(decision.action, "open_session")
        self.assertTrue(decision.ok)
        self.assertEqual(router.session.code, "KISTE-K3")

    def test_switching_boxes_is_normal_not_an_error(self):
        router, clock = build()
        router.route("KISTE-K3")
        clock.advance(5)
        decision = router.route("KISTE-K7")
        self.assertTrue(decision.ok)
        self.assertIsNone(decision.error)
        self.assertEqual(decision.action, "switch_session")
        self.assertEqual(decision.previous_code, "KISTE-K3")
        self.assertEqual(router.session.code, "KISTE-K7")

    def test_rescanning_the_same_box_is_not_a_switch(self):
        router, clock = build()
        router.route("KISTE-K3")
        clock.advance(5)
        decision = router.route("KISTE-K3")
        self.assertEqual(decision.action, "keep_session")
        self.assertTrue(decision.ok)

    def test_an_article_goes_to_the_box_while_a_session_is_open(self):
        router, clock = build()
        router.route("KISTE-K3")
        clock.advance(1)
        decision = router.route("4011923456789", kind="werkstatt_article")
        self.assertEqual(decision.screen, "kisten")
        self.assertEqual(decision.action, "add_item")

    def test_an_article_goes_to_the_rack_with_no_session(self):
        router, _ = with_name()
        decision = router.route("4011923456789", kind="werkstatt_article")
        self.assertEqual(decision.screen, "regal")
        self.assertEqual(decision.action, "movement")

    def test_fertig_closes_and_is_harmless_with_no_session(self):
        router, _ = build()
        decision = router.route("SMPL-CMD-FERTIG")
        self.assertEqual(decision.screen, "kisten")
        self.assertEqual(decision.action, "close_session")
        self.assertTrue(decision.ok)
        self.assertIsNone(router.session)

    def test_entnahme_toggles_the_box_mode(self):
        router, clock = build()
        router.route("KISTE-K3")
        self.assertEqual(router.mode, "add")
        clock.advance(1)
        decision = router.route("SMPL-CMD-ENTNAHME")
        self.assertEqual(decision.action, "mode")
        self.assertEqual(router.mode, "remove")
        clock.advance(1)
        router.route("SMPL-CMD-ENTNAHME")
        self.assertEqual(router.mode, "add")

    def test_mitnehmen_names_the_open_crate(self):
        router, clock = build()
        router.route("KISTE-K3")
        clock.advance(1)
        decision = router.route("SMPL-CMD-MITNEHMEN")
        self.assertEqual(decision.screen, "kisten")
        self.assertEqual(decision.action, "handover")
        self.assertTrue(decision.ok)
        self.assertEqual(decision.box_code, "KISTE-K3")
        # It says what to book; it does not close the crate behind itself.
        self.assertIsNotNone(router.session)

    def test_mitnehmen_with_no_crate_open_refuses_instead_of_guessing(self):
        router, _ = build()
        decision = router.route("SMPL-CMD-MITNEHMEN")
        self.assertEqual(decision.screen, "kisten")
        self.assertEqual(decision.action, "nothing_to_handover")
        self.assertFalse(decision.ok)
        self.assertIn("Kiste", decision.error)

    def test_mitnehmen_never_lands_on_the_rack(self):
        """The rack screen books articles; a crate is not an article."""
        router, clock = build()
        router.set_direction("ein")
        clock.advance(1)
        self.assertEqual(router.route("SMPL-CMD-MITNEHMEN").screen, "kisten")

    def test_remove_mode_routes_an_article_to_remove_item(self):
        router, clock = build()
        router.route("KISTE-K3")
        clock.advance(1)
        router.route("SMPL-CMD-ENTNAHME")
        clock.advance(1)
        decision = router.route("4011923456789", kind="werkstatt_article")
        self.assertEqual(decision.action, "remove_item")


# --------------------------------------------------------------------------
# The idle timeout
# --------------------------------------------------------------------------


class TestIdleTimeout(unittest.TestCase):
    def test_the_session_closes_itself_after_the_idle_timeout(self):
        router, clock = build(idle_timeout_s=600.0)
        router.route("KISTE-K3")
        clock.advance(599)
        self.assertIsNotNone(router.session)
        clock.advance(2)
        self.assertTrue(router.tick())
        self.assertIsNone(router.session)

    def test_any_scan_resets_the_countdown(self):
        router, clock = build(idle_timeout_s=600.0)
        router.route("KISTE-K3")
        clock.advance(500)
        router.route("4011923456789", kind="werkstatt_article")
        clock.advance(500)
        self.assertFalse(router.tick())
        self.assertIsNotNone(router.session)

    def test_remaining_seconds_are_exposed_for_the_countdown(self):
        router, clock = build(idle_timeout_s=600.0)
        router.route("KISTE-K3")
        self.assertEqual(router.seconds_remaining(), 600)
        clock.advance(90)
        self.assertEqual(router.seconds_remaining(), 510)
        self.assertIsNone(build()[0].seconds_remaining())

    def test_the_timeout_is_configurable(self):
        router, clock = build(idle_timeout_s=30.0)
        router.route("KISTE-K3")
        clock.advance(31)
        self.assertTrue(router.tick())

    def test_a_scan_after_expiry_starts_fresh_rather_than_landing_in_the_old_box(self):
        router, clock = build(idle_timeout_s=600.0)
        router.route("KISTE-K3")
        clock.advance(601)
        decision = router.route("4011923456789", kind="werkstatt_article")
        self.assertEqual(decision.screen, "regal")
        self.assertTrue(decision.session_expired)


# --------------------------------------------------------------------------
# De-duplication
# --------------------------------------------------------------------------


class TestDeduplication(unittest.TestCase):
    def test_the_same_code_twice_inside_the_window_is_dropped(self):
        router, clock = build()
        first = router.route("4011923456789", kind="werkstatt_article", source="evdev")
        clock.advance(0.05)
        second = router.route("4011923456789", kind="werkstatt_article", source="wedge")
        self.assertFalse(first.duplicate)
        self.assertTrue(second.duplicate)
        self.assertEqual(second.action, "ignored")

    def test_a_dropped_duplicate_changes_no_state_at_all(self):
        router, clock = build()
        router.route("KISTE-K3")
        clock.advance(0.05)
        decision = router.route("KISTE-K3", source="evdev")
        self.assertTrue(decision.duplicate)
        self.assertEqual(router.session.code, "KISTE-K3")
        self.assertEqual(router.session.opened_at, 1000.0)

    def test_the_same_code_after_the_window_counts_twice(self):
        router, clock = build()
        router.route("4011923456789", kind="werkstatt_article")
        clock.advance(0.2)
        second = router.route("4011923456789", kind="werkstatt_article")
        self.assertFalse(second.duplicate)

    def test_a_different_code_inside_the_window_is_never_dropped(self):
        router, clock = build()
        router.route("4011923456789", kind="werkstatt_article")
        clock.advance(0.01)
        second = router.route("4011923456790", kind="werkstatt_article")
        self.assertFalse(second.duplicate)

    def test_the_window_is_configurable(self):
        router, clock = build(dedupe_window_s=0.0)
        router.route("4011923456789", kind="werkstatt_article")
        self.assertFalse(router.route("4011923456789", kind="werkstatt_article").duplicate)


# --------------------------------------------------------------------------
# Quantity and direction
# --------------------------------------------------------------------------


class TestQuantityAndDirection(unittest.TestCase):
    def test_menge_commands_set_the_pending_quantity(self):
        router, clock = build()
        self.assertEqual(router.pending_qty, 1)
        for code, expected in (("SMPL-CMD-MENGE-5", 5), ("SMPL-CMD-MENGE-10", 10),
                               ("SMPL-CMD-MENGE-50", 50)):
            decision = router.route(code)
            self.assertEqual(decision.action, "qty")
            self.assertEqual(decision.qty, expected)
            self.assertEqual(router.pending_qty, expected)
            clock.advance(1)

    def test_the_quantity_applies_to_the_next_article_and_then_resets(self):
        router, clock = with_name()
        router.route("SMPL-CMD-MENGE-10")
        clock.advance(1)
        decision = router.route("4011923456789", kind="werkstatt_article")
        self.assertEqual(decision.qty, 10)
        self.assertEqual(router.pending_qty, 1)

    def test_ein_and_aus_set_the_rack_direction(self):
        router, clock = build()
        self.assertEqual(router.direction, "aus")
        decision = router.route("SMPL-CMD-EIN")
        self.assertEqual(decision.screen, "regal")
        self.assertEqual(decision.action, "direction")
        self.assertEqual(router.direction, "ein")
        clock.advance(1)
        router.route("SMPL-CMD-AUS")
        self.assertEqual(router.direction, "aus")

    def test_the_direction_chooses_the_movement_type(self):
        router, clock = with_name()
        self.assertEqual(router.route("4011923456789", kind="werkstatt_article").movement_type,
                         "checkout")
        clock.advance(1)
        router.route("SMPL-CMD-EIN")
        clock.advance(1)
        self.assertEqual(router.route("4011923456789", kind="werkstatt_article").movement_type,
                         "return")


# --------------------------------------------------------------------------
# Machines
# --------------------------------------------------------------------------


class TestMachineScans(unittest.TestCase):
    def test_a_machine_is_refused_during_a_box_session_in_german(self):
        router, clock = build()
        router.route("KISTE-K3")
        clock.advance(1)
        decision = router.route("MA-0042", kind="machine")
        self.assertFalse(decision.ok)
        self.assertEqual(decision.action, "refused")
        self.assertEqual(decision.screen, "regal")  # mirrored to the rack
        self.assertIsNotNone(decision.error)
        self.assertIn("Kiste", decision.error)
        self.assertRegex(decision.error, r"[a-zäöüß]")  # a sentence, not a code

    def test_a_refused_machine_leaves_the_session_open(self):
        router, clock = build()
        router.route("KISTE-K3")
        clock.advance(1)
        router.route("MA-0042", kind="machine")
        self.assertIsNotNone(router.session)
        self.assertEqual(router.session.code, "KISTE-K3")

    def test_a_machine_with_no_session_goes_to_the_rack_normally(self):
        router, _ = build()
        decision = router.route("MA-0042", kind="machine")
        self.assertEqual(decision.screen, "regal")
        self.assertTrue(decision.ok)
        self.assertEqual(decision.action, "machine")


# --------------------------------------------------------------------------
# Undo
# --------------------------------------------------------------------------


class TestUndo(unittest.TestCase):
    def test_abbruch_clears_a_pending_article_before_touching_the_server(self):
        router, clock = build()
        router.route("4011923456789", kind="werkstatt_article")
        router.note_pending({"id": 5, "item_name": "Schraube"})
        clock.advance(1)
        decision = router.route("SMPL-CMD-ABBRUCH")
        self.assertEqual(decision.action, "clear_pending")
        self.assertIsNone(router.pending_article)

    def test_abbruch_on_the_box_screen_undoes_the_last_added_line(self):
        router, clock = build()
        router.route("KISTE-K3")
        clock.advance(1)
        router.route("4011923456789", kind="werkstatt_article")
        router.note_commit(screen="kisten", action="add_item", box_id=3, item_id=12, qty=2)
        clock.advance(1)
        decision = router.route("SMPL-CMD-ABBRUCH")
        self.assertEqual(decision.screen, "kisten")
        self.assertEqual(decision.action, "undo_item")
        self.assertEqual(decision.undo["item_id"], 12)
        self.assertEqual(decision.undo["box_id"], 3)
        self.assertEqual(decision.undo["qty"], 2)

    def test_abbruch_on_the_rack_reverses_the_last_movement(self):
        router, clock = build()
        router.route("4011923456789", kind="werkstatt_article")
        router.note_commit(screen="regal", action="movement", article_id=5,
                           movement_type="checkout", qty=2)
        clock.advance(1)
        decision = router.route("SMPL-CMD-ABBRUCH")
        self.assertEqual(decision.screen, "regal")
        self.assertEqual(decision.action, "undo_movement")
        self.assertEqual(decision.undo["movement_type"], "return")
        self.assertEqual(decision.undo["article_id"], 5)
        self.assertEqual(decision.undo["qty"], 2)

    def test_an_inventory_correction_has_no_inverse_here_either(self):
        # SMPL does not accept inventory_* from a station at all, so
        # describing an inverse we cannot post only turned "Abbruch nicht
        # möglich" into "Abbruch fehlgeschlagen" one round trip later.
        for movement in ("inventory_plus", "inventory_minus"):
            router, clock = build()
            router.note_commit(screen="regal", action="movement", article_id=5,
                               movement_type=movement, qty=1)
            clock.advance(1)
            decision = router.route("SMPL-CMD-ABBRUCH")
            self.assertEqual(decision.action, "cannot_undo", movement)
            self.assertFalse(decision.ok, movement)

    def test_an_intake_has_no_safe_inverse_and_says_so(self):
        router, clock = build()
        router.note_commit(screen="regal", action="movement", article_id=5,
                           movement_type="intake", qty=2)
        clock.advance(1)
        decision = router.route("SMPL-CMD-ABBRUCH")
        self.assertFalse(decision.ok)
        self.assertIsNotNone(decision.error)

    def test_undoing_a_named_rueckgabe_books_the_checkout_back_onto_that_name(self):
        router, clock = build()
        router.note_commit(screen="regal", action="movement", article_id=5,
                           movement_type="return", qty=1, assignee_user_id=9)
        clock.advance(1)
        decision = router.route("SMPL-CMD-ABBRUCH")
        self.assertEqual(decision.action, "undo_movement")
        self.assertEqual(decision.undo["movement_type"], "checkout")
        self.assertEqual(decision.undo["assignee_user_id"], 9)
        self.assertEqual(decision.assignee_user_id, 9)

    def test_undoing_an_anonymous_rueckgabe_takes_the_name_tapped_now(self):
        # The recorded Rückgabe carried no name, and the inverse is a
        # checkout — which may never be anonymous. The person standing at the
        # rack undoing it is the one the tool is going back out with.
        router, clock = with_name()
        router.note_commit(screen="regal", action="movement", article_id=5,
                           movement_type="return", qty=2)
        clock.advance(1)
        decision = router.route("SMPL-CMD-ABBRUCH")
        self.assertEqual(decision.action, "undo_movement")
        self.assertEqual(decision.undo["movement_type"], "checkout")
        self.assertEqual(decision.undo["assignee_user_id"], 4)
        self.assertEqual(decision.assignee_user_id, 4)

    def test_undoing_an_anonymous_rueckgabe_with_nobody_tapped_is_refused(self):
        # The hole this closes: ABBRUCH took the inverse of a nameless
        # Rückgabe and wrote a checkout with assignee_user_id null — straight
        # through "an Ausgabe needs a name" by the back door, leaving a tool
        # out with nobody on it.
        router, clock = build()
        router.note_commit(screen="regal", action="movement", article_id=5,
                           movement_type="return", qty=2)
        clock.advance(1)
        decision = router.route("SMPL-CMD-ABBRUCH")
        self.assertFalse(decision.ok)
        self.assertEqual(decision.action, "needs_assignee")
        self.assertEqual(decision.screen, "regal")
        self.assertEqual(decision.error, scan_router.MSG_NEEDS_ASSIGNEE)
        self.assertIsNone(decision.undo)
        self.assertEqual(decision.qty, 2)

    def test_the_refused_undo_is_still_there_after_a_name_is_tapped(self):
        # A flat refusal would be a dead end: the recorded action can never
        # grow a name, so the booking would stay wrong forever. Tapping a name
        # has to make the same ABBRUCH work.
        router, clock = build()
        router.note_commit(screen="regal", action="movement", article_id=5,
                           movement_type="return", qty=1)
        clock.advance(1)
        self.assertEqual(router.route("SMPL-CMD-ABBRUCH").action, "needs_assignee")
        router.set_assignee(MAX)
        clock.advance(1)
        second = router.route("SMPL-CMD-ABBRUCH")
        self.assertEqual(second.action, "undo_movement")
        self.assertEqual(second.undo["assignee_user_id"], 4)

    def test_undoing_a_checkout_never_asks_for_a_name(self):
        # The inverse is a Rückgabe, which may be anonymous — and it carries
        # the original name so it closes that person's loan.
        router, clock = build()
        router.note_commit(screen="regal", action="movement", article_id=5,
                           movement_type="checkout", qty=1, assignee_user_id=9)
        clock.advance(1)
        decision = router.route("SMPL-CMD-ABBRUCH")
        self.assertTrue(decision.ok)
        self.assertEqual(decision.undo["movement_type"], "return")
        self.assertEqual(decision.assignee_user_id, 9)

    def test_abbruch_with_nothing_to_undo_is_not_an_error(self):
        router, _ = build()
        decision = router.route("SMPL-CMD-ABBRUCH")
        self.assertEqual(decision.action, "nothing_to_undo")
        self.assertTrue(decision.ok)

    def test_a_confirmed_undo_cannot_be_undone_twice(self):
        router, clock = build()
        router.note_commit(screen="regal", action="movement", article_id=5,
                           movement_type="checkout", qty=1)
        clock.advance(1)
        router.route("SMPL-CMD-ABBRUCH")
        router.confirm_undo("regal")          # SMPL accepted the inverse
        clock.advance(1)
        self.assertEqual(router.route("SMPL-CMD-ABBRUCH").action, "nothing_to_undo")

    def test_a_failed_undo_can_be_tried_again(self):
        # A6: the inverse is a network call like any other. Forgetting the
        # record before SMPL accepted it means one ABBRUCH during a blip costs
        # the operator the ability to undo at all — which is exactly when the
        # undo is wanted, because the blip is why the screen looks wrong.
        router, clock = build()
        router.note_commit(screen="regal", action="movement", article_id=5,
                           movement_type="checkout", qty=2)
        clock.advance(1)
        first = router.route("SMPL-CMD-ABBRUCH")
        self.assertEqual(first.action, "undo_movement")
        # No confirm_undo: the POST failed.
        clock.advance(1)
        second = router.route("SMPL-CMD-ABBRUCH")
        self.assertEqual(second.action, "undo_movement")
        self.assertEqual(second.undo["article_id"], 5)
        self.assertEqual(second.undo["qty"], 2)

    def test_a_failed_box_undo_can_be_tried_again(self):
        router, clock = build()
        router.route("KISTE-K3")
        clock.advance(1)
        router.note_commit(screen="kisten", action="add_item", box_id=3, item_id=12, qty=1)
        clock.advance(1)
        self.assertEqual(router.route("SMPL-CMD-ABBRUCH").action, "undo_item")
        clock.advance(1)
        self.assertEqual(router.route("SMPL-CMD-ABBRUCH").action, "undo_item")
        router.confirm_undo("kisten")
        clock.advance(1)
        self.assertEqual(router.route("SMPL-CMD-ABBRUCH").action, "nothing_to_undo")

    def test_abbruch_after_a_crate_switch_does_not_undo_the_other_crate(self):
        # A3: last_actions used to be keyed by screen alone. Pack crate K3,
        # walk to K9, hit ABBRUCH — and the line came out of K3, which nobody
        # is standing at and nobody will notice until the van is loaded.
        router, clock = build()
        router.route("KISTE-K3")
        clock.advance(1)
        router.note_commit(screen="kisten", action="add_item", box_id=3, item_id=12, qty=1)
        clock.advance(1)
        router.route("KISTE-K9")
        clock.advance(1)
        decision = router.route("SMPL-CMD-ABBRUCH")
        self.assertEqual(decision.action, "nothing_to_undo")
        self.assertEqual(decision.screen, "kisten")

    def test_switching_back_makes_the_undo_available_again(self):
        router, clock = build()
        router.route("KISTE-K3")
        clock.advance(1)
        router.note_commit(screen="kisten", action="add_item", box_id=3, item_id=12, qty=1)
        clock.advance(1)
        router.route("KISTE-K9")
        clock.advance(1)
        router.route("SMPL-CMD-ABBRUCH")
        clock.advance(1)
        router.route("KISTE-K3")
        clock.advance(1)
        decision = router.route("SMPL-CMD-ABBRUCH")
        self.assertEqual(decision.action, "undo_item")
        self.assertEqual(decision.undo["item_id"], 12)

    def test_abbruch_with_the_crate_closed_does_not_reach_into_it(self):
        router, clock = build()
        router.route("KISTE-K3")
        clock.advance(1)
        router.note_commit(screen="kisten", action="add_item", box_id=3, item_id=12, qty=1)
        clock.advance(1)
        router.route("SMPL-CMD-FERTIG")
        clock.advance(1)
        # The rack screen is active now, and it has nothing of its own.
        self.assertEqual(router.route("SMPL-CMD-ABBRUCH").action, "nothing_to_undo")


# --------------------------------------------------------------------------
# The de-dupe window is measured from arrival (A1)
# --------------------------------------------------------------------------


class TestArrivalTimeDedupe(unittest.TestCase):
    """One trigger pull, two readers, and a network call in between.

    ``route`` used to ask the clock at the moment it was finally called. The
    caller resolves an unknown code against SMPL first — up to four seconds —
    so by the time the echo was judged, the 150 ms window had long closed and
    the same physical scan booked stock twice.
    """

    def test_an_echo_is_dropped_even_when_the_resolve_was_slow(self):
        router, clock = with_name(dedupe_window_s=0.150)
        arrived = clock.now
        router.route("4011923456789", kind="werkstatt_article", at=arrived)
        # The second reader delivered the same scan 20 ms later, but the
        # resolve for it took four seconds.
        second_arrival = arrived + 0.020
        clock.advance(4.0)
        decision = router.route("4011923456789", kind="werkstatt_article",
                                at=second_arrival)
        self.assertTrue(decision.duplicate)
        self.assertEqual(decision.action, "ignored")

    def test_without_an_arrival_time_the_clock_is_still_used(self):
        router, clock = with_name()
        router.route("4011923456789", kind="werkstatt_article")
        clock.advance(0.010)
        self.assertTrue(router.route("4011923456789", kind="werkstatt_article").duplicate)

    def test_a_real_second_scan_is_not_a_duplicate(self):
        router, clock = with_name(dedupe_window_s=0.150)
        arrived = clock.now
        router.route("4011923456789", kind="werkstatt_article", at=arrived)
        clock.advance(4.0)
        decision = router.route("4011923456789", kind="werkstatt_article",
                                at=arrived + 2.0)
        self.assertFalse(decision.duplicate)

    def test_is_duplicate_answers_before_any_resolve(self):
        # The caller asks this *before* it pays for the network round trip.
        router, clock = with_name(dedupe_window_s=0.150)
        arrived = clock.now
        router.route("KISTE-K3", at=arrived)
        self.assertTrue(router.is_duplicate("KISTE-K3", arrived + 0.020))
        self.assertFalse(router.is_duplicate("KISTE-K9", arrived + 0.020))
        self.assertFalse(router.is_duplicate("", arrived))


# --------------------------------------------------------------------------
# A command keeps the crate open (A4)
# --------------------------------------------------------------------------


class TestEveryScanRefreshesTheIdleClock(unittest.TestCase):
    def test_a_command_scan_keeps_the_session_alive(self):
        # The operator is packing a crate and scanning MENGE codes between
        # parts. Only article scans used to reset the idle clock, so the crate
        # closed itself under somebody who was demonstrably still scanning —
        # and the next part was booked as a rack checkout.
        router, clock = build(idle_timeout_s=600.0)
        router.route("KISTE-K3")
        clock.advance(500)
        router.route("SMPL-CMD-MENGE-5")
        clock.advance(500)
        decision = router.route("4011923456789", kind="werkstatt_article")
        self.assertIsNotNone(router.session)
        self.assertEqual(decision.screen, "kisten")
        self.assertEqual(decision.action, "add_item")
        self.assertEqual(decision.qty, 5)

    def test_an_abbruch_also_keeps_it_alive(self):
        router, clock = build(idle_timeout_s=600.0)
        router.route("KISTE-K3")
        clock.advance(500)
        router.route("SMPL-CMD-ABBRUCH")
        clock.advance(500)
        self.assertIsNotNone(router.session)

    def test_a_truly_idle_session_still_closes(self):
        router, clock = build(idle_timeout_s=600.0)
        router.route("KISTE-K3")
        clock.advance(601)
        decision = router.route("4011923456789", kind="werkstatt_article")
        self.assertIsNone(router.session)
        self.assertTrue(decision.session_expired)

    def test_a_duplicate_does_not_extend_the_session(self):
        router, clock = build(idle_timeout_s=600.0, dedupe_window_s=0.150)
        router.route("KISTE-K3")
        opened_at = router.session.last_at
        clock.advance(0.020)
        router.route("KISTE-K3")
        self.assertEqual(router.session.last_at, opened_at)


# --------------------------------------------------------------------------
# Three directions and a name (the contract delta)
# --------------------------------------------------------------------------


class TestDirections(unittest.TestCase):
    def test_the_three_directions_map_to_three_movements(self):
        for direction, movement in (("aus", "checkout"), ("ein", "return"),
                                    ("wareneingang", "intake")):
            router, _ = build()
            router.set_assignee(MAX)
            router.set_direction(direction)
            self.assertEqual(router.direction, direction)
            decision = router.route("4011923456789", kind="werkstatt_article")
            self.assertEqual(decision.movement_type, movement, direction)

    def test_the_published_direction_list_is_the_contract(self):
        self.assertEqual(set(scan_router.DIRECTIONS), {"aus", "ein", "wareneingang"})

    def test_an_unknown_direction_is_ignored_not_stored(self):
        router, _ = build()
        router.set_direction("seitwärts")
        self.assertEqual(router.direction, "aus")


class TestTheRuleIsPublishedOnce(unittest.TestCase):
    """One copy of "an Ausgabe needs a name", for every door onto the ledger.

    The rack scan is not the only one: ``POST /rack/movement`` is a second,
    and an ABBRUCH that takes back a Rückgabe writes a checkout nobody
    scanned. A rule with three copies is a rule with three behaviours.
    """

    def test_the_movement_that_needs_a_name_is_derived_from_the_direction(self):
        self.assertEqual(scan_router.MOVEMENT_REQUIRING_ASSIGNEE, "checkout")

    def test_only_a_nameless_checkout_trips_it(self):
        needs = scan_router.movement_needs_assignee
        self.assertTrue(needs("checkout", None))
        self.assertTrue(needs("checkout", 0))
        self.assertTrue(needs("checkout", "nope"))
        self.assertTrue(needs("checkout", -1))
        self.assertFalse(needs("checkout", 4))
        self.assertFalse(needs("return", None))
        self.assertFalse(needs("intake", None))


class TestAssignee(unittest.TestCase):
    def test_an_ausgabe_without_a_name_is_refused_in_german(self):
        router, _ = build()
        decision = router.route("4011923456789", kind="werkstatt_article")
        self.assertFalse(decision.ok)
        self.assertEqual(decision.action, "needs_assignee")
        self.assertEqual(decision.screen, "regal")
        self.assertEqual(decision.error, "Bitte zuerst Namen antippen")

    def test_the_refusal_consumes_nothing(self):
        router, clock = build()
        router.route("SMPL-CMD-MENGE-10")
        clock.advance(1)
        refused = router.route("4011923456789", kind="werkstatt_article")
        self.assertEqual(refused.qty, 10)
        # The quantity survives, so tapping a name and scanning again books 10.
        self.assertEqual(router.pending_qty, 10)
        router.set_assignee(MAX)
        clock.advance(1)
        booked = router.route("4011923456789", kind="werkstatt_article")
        self.assertEqual(booked.action, "movement")
        self.assertEqual(booked.qty, 10)

    def test_a_checkout_carries_the_tapped_name(self):
        router, _ = with_name()
        decision = router.route("4011923456789", kind="werkstatt_article")
        self.assertEqual(decision.assignee_user_id, 4)

    def test_a_return_may_carry_a_name_but_does_not_need_one(self):
        router, clock = build()
        router.set_direction("ein")
        decision = router.route("4011923456789", kind="werkstatt_article")
        self.assertEqual(decision.action, "movement")
        self.assertEqual(decision.movement_type, "return")
        self.assertIsNone(decision.assignee_user_id)
        clock.advance(1)
        router.set_assignee(MAX)
        decision = router.route("4011923456790", kind="werkstatt_article")
        self.assertEqual(decision.assignee_user_id, 4)

    def test_a_wareneingang_never_carries_a_name(self):
        router, _ = with_name()
        router.set_direction("wareneingang")
        decision = router.route("4011923456789", kind="werkstatt_article")
        self.assertEqual(decision.movement_type, "intake")
        self.assertIsNone(decision.assignee_user_id)

    def test_a_box_session_does_not_need_a_name(self):
        router, clock = build()
        router.route("KISTE-K3")
        clock.advance(1)
        decision = router.route("4011923456789", kind="werkstatt_article")
        self.assertEqual(decision.action, "add_item")

    def test_a_name_expires_after_two_minutes_of_nothing(self):
        router, clock = build(assignee_timeout_s=120.0)
        router.set_assignee(MAX)
        clock.advance(119)
        self.assertFalse(router.expire_assignee())
        self.assertIsNotNone(router.assignee)
        clock.advance(2)
        self.assertTrue(router.expire_assignee())
        self.assertIsNone(router.assignee)
        self.assertFalse(router.expire_assignee())

    def test_scanning_under_a_name_keeps_it(self):
        router, clock = build(assignee_timeout_s=120.0)
        router.set_assignee(MAX)
        clock.advance(100)
        router.route("4011923456789", kind="werkstatt_article")
        clock.advance(100)
        self.assertFalse(router.expire_assignee())
        self.assertEqual(router.assignee["id"], 4)

    def test_clearing_the_name_makes_an_ausgabe_refuse_again(self):
        router, clock = with_name()
        router.set_assignee(None)
        self.assertIsNone(router.assignee)
        self.assertEqual(router.route("4011923456789",
                                      kind="werkstatt_article").action, "needs_assignee")

    def test_a_nonsense_id_is_not_a_name(self):
        router, _ = build()
        for person in ({"id": 0, "name": "x"}, {"id": "nope"}, {"name": "no id"},
                       {"id": True}, "not a dict"):
            router.set_assignee(person)
            self.assertIsNone(router.assignee, person)

    def test_the_name_is_in_the_snapshot(self):
        import json

        router, _ = with_name()
        payload = router.snapshot()
        json.dumps(payload)
        self.assertEqual(payload["assignee"], {"id": 4, "name": "Max Mustermann"})

    def test_an_undo_of_a_checkout_returns_it_to_the_same_person(self):
        router, clock = with_name()
        router.note_commit(screen="regal", action="movement", article_id=5,
                           movement_type="checkout", qty=1, assignee_user_id=4)
        clock.advance(1)
        decision = router.route("SMPL-CMD-ABBRUCH")
        self.assertEqual(decision.action, "undo_movement")
        self.assertEqual(decision.undo["assignee_user_id"], 4)


# --------------------------------------------------------------------------
# Three threads, one state machine (A2)
# --------------------------------------------------------------------------


class TestConcurrency(unittest.TestCase):
    """The router is driven by the kiosk tick, the scanner thread and HTTP.

    Every transition is ``state = self._state`` ... ``self._state = replace(
    state, ...)``, with real work in between, so two threads that overlap lose
    one of the two writes. The lock is injected rather than imported (see
    TestPurity), so these tests build the router the way ``server.py`` does.
    """

    @staticmethod
    def locked(**kwargs):
        import threading

        clock = Clock()
        router = scan_router.ScanRouter(clock=clock, lock=threading.RLock(), **kwargs)
        return router, clock

    def test_a_slow_transition_does_not_clobber_a_concurrent_write(self):
        # Deterministic, not a race the test hopes to lose: SessionState is
        # patched to block inside _decide_box, exactly between the state load
        # and the state store, while another thread sets the quantity.
        import threading

        inside = threading.Event()
        release = threading.Event()
        real = scan_router.SessionState

        class SlowSessionState(real):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, **kwargs)
                inside.set()
                release.wait(5.0)

        router, _clock = self.locked()
        scan_router.SessionState = SlowSessionState
        self.addCleanup(setattr, scan_router, "SessionState", real)

        opener = threading.Thread(target=lambda: router.route("KISTE-K3"), daemon=True)
        opener.start()
        self.assertTrue(inside.wait(5.0), "the opener never reached the window")

        setter = threading.Thread(target=lambda: router.set_qty(7), daemon=True)
        setter.start()
        setter.join(0.5)          # blocked on the lock, which is the point
        release.set()
        opener.join(5.0)
        setter.join(5.0)

        self.assertIsNotNone(router.session, "the session write was lost")
        self.assertEqual(router.pending_qty, 7, "the quantity write was lost")

    def test_hammering_from_several_threads_loses_nothing(self):
        import threading

        router, _clock = self.locked(dedupe_window_s=0.0)
        screens = ["s%d" % index for index in range(6)]
        errors = []

        def work(screen):
            try:
                for index in range(400):
                    router.note_commit(screen=screen, action="movement",
                                       article_id=index + 1,
                                       movement_type="checkout", qty=1)
                    router.snapshot()
                    router.route("4011923456789", kind="werkstatt_article")
            except Exception as exc:  # noqa: BLE001 - reported, not swallowed
                errors.append(exc)

        threads = [threading.Thread(target=work, args=(screen,), daemon=True)
                   for screen in screens]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(30.0)
            self.assertFalse(thread.is_alive(), "a worker deadlocked")

        self.assertEqual(errors, [])
        recorded = router.state.last_actions
        for screen in screens:
            self.assertIn(screen, recorded, "a commit was lost")
            self.assertEqual(recorded[screen].article_id, 400)

    def test_the_injected_lock_is_actually_taken(self):
        class CountingLock:
            def __init__(self):
                self.depth = 0
                self.entries = 0

            def __enter__(self):
                self.depth += 1
                self.entries += 1

            def __exit__(self, *exc):
                self.depth -= 1
                return False

        lock = CountingLock()
        clock = Clock()
        router = scan_router.ScanRouter(clock=clock, lock=lock)
        router.route("KISTE-K3")
        router.snapshot()
        self.assertGreater(lock.entries, 1)
        self.assertEqual(lock.depth, 0)

    def test_without_a_lock_it_still_works_single_threaded(self):
        router, _clock = build()
        router.route("KISTE-K3")
        self.assertIsNotNone(router.session)


# --------------------------------------------------------------------------
# Purity
# --------------------------------------------------------------------------


class TestPurity(unittest.TestCase):
    def test_the_module_imports_nothing_that_does_io(self):
        """No I/O, no threads, no wall clock — still true after the lock.

        The router is now driven from three threads and every transition is a
        read-modify-write, which normally argues for a ``threading.Lock`` in
        the module. It is *injected* instead (see TestConcurrency): the ban
        below is what keeps "the session times out after ten minutes" a test
        that runs in microseconds, and a module that owns a lock is one step
        from a module that owns a thread and a socket.
        """
        source = (HERE.parent / "scan_router.py").read_text(encoding="utf-8")
        for forbidden in ("import urllib", "import socket", "import threading",
                          "import subprocess", "import requests", "time.time()",
                          "import http"):
            self.assertNotIn(forbidden, source, f"scan_router must not use {forbidden}")

    def test_the_clock_is_never_read_implicitly(self):
        # Construct with a clock that would explode if the router reached past it.
        calls = []

        def clock():
            calls.append(1)
            return 42.0

        router = scan_router.ScanRouter(clock=clock)
        router.route("KISTE-K3")
        self.assertTrue(calls, "the router must ask the injected clock for the time")

    def test_state_transitions_do_not_mutate_the_previous_state(self):
        router, clock = build()
        router.route("KISTE-K3")
        before = router.state
        clock.advance(1)
        router.route("SMPL-CMD-MENGE-5")
        self.assertIsNot(before, router.state)
        self.assertEqual(before.pending_qty, 1)
        self.assertEqual(router.state.pending_qty, 5)

    def test_a_decision_carries_the_code_and_the_source(self):
        router, _ = build()
        decision = router.route("4011923456789", kind="werkstatt_article", source="evdev")
        self.assertEqual(decision.code, "4011923456789")
        self.assertEqual(decision.source, "evdev")

    def test_snapshot_is_json_shaped(self):
        import json

        router, clock = build()
        router.route("KISTE-K3")
        clock.advance(1)
        router.route("SMPL-CMD-MENGE-5")
        payload = router.snapshot()
        json.dumps(payload)  # must not raise
        self.assertEqual(payload["mode"], "add")
        self.assertEqual(payload["direction"], "aus")
        self.assertEqual(payload["pending_qty"], 5)
        self.assertEqual(payload["session"]["code"], "KISTE-K3")
        self.assertIsInstance(payload["seconds_remaining"], int)


# --------------------------------------------------------------------------
# Input hygiene
# --------------------------------------------------------------------------


class TestInputHygiene(unittest.TestCase):
    def test_whitespace_and_case_do_not_change_a_command(self):
        router, _ = build()
        self.assertEqual(router.route("  smpl-cmd-fertig  ").action, "close_session")

    def test_an_empty_scan_is_ignored_without_touching_state(self):
        router, _ = build()
        router.route("KISTE-K3")
        decision = router.route("   ")
        self.assertEqual(decision.action, "ignored")
        self.assertIsNotNone(router.session)

    def test_a_kiste_code_keeps_its_own_case(self):
        router, _ = build()
        decision = router.route("kiste-k3")
        self.assertEqual(decision.action, "open_session")
        self.assertEqual(router.session.code, "KISTE-K3")

    def test_box_number_is_extracted_from_the_code(self):
        router, _ = build()
        router.route("KISTE-K3")
        self.assertEqual(router.session.box_number, "K3")


if __name__ == "__main__":
    unittest.main()
