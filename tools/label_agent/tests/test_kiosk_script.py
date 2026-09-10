"""The two-screen kiosk launcher, exercised on a machine with no screens.

``smpl-kiosk.sh`` decides two things that are expensive to get wrong and
impossible to see from a keyboard: which physical output each page lands on,
and whether the second Chromium is a second browser or merely a second tab of
the first one. ``SMPL_KIOSK_DRYRUN=1`` makes it print that decision as
key=value lines instead of launching anything, which is both what these tests
read and the fastest way to debug a screen showing the wrong page on the Pi:

    SMPL_KIOSK_DRYRUN=1 /usr/local/bin/smpl-kiosk.sh

The fake ``wlr-randr`` below reproduces the real station's output verbatim,
including the detail that made this worth testing: the Samsung sits at 0,0 and
the Philips at 3840,0, and those positions have already been observed the
other way round on the same Pi with nobody touching a cable.
"""

from __future__ import annotations

import os
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPT = HERE.parent / "packaging" / "kiosk" / "smpl-kiosk.sh"

# Exactly what `wlr-randr` prints on the office Pi, trimmed to two modes per
# output. The "(preferred, current)" / "(current)" spellings both appear on
# the real box and the parser has to cope with each.
WLR_RANDR_BOTH = """\
HDMI-A-2 "Samsung Electric Company U28E590 HTPJC16451 (HDMI-A-2)"
  Physical size: 610x350 mm
  Enabled: yes
  Modes:
    1920x1080 px, 60.000000 Hz
    3840x2160 px, 30.000000 Hz (current)
  Position: 0,0
  Transform: normal
  Scale: 1.000000
HDMI-A-1 "Philips Consumer Electronics Company PHILIPS FTV 0x01010101 (HDMI-A-1)"
  Physical size: 640x360 mm
  Enabled: yes
  Modes:
    640x480 px, 59.939999 Hz
    1360x768 px, 59.799000 Hz (preferred, current)
  Position: 3840,0
  Transform: normal
  Scale: 1.000000
"""

WLR_RANDR_ONLY_SAMSUNG = """\
HDMI-A-2 "Samsung Electric Company U28E590 HTPJC16451 (HDMI-A-2)"
  Physical size: 610x350 mm
  Enabled: yes
  Modes:
    3840x2160 px, 30.000000 Hz (current)
  Position: 0,0
  Transform: normal
  Scale: 1.000000
"""

# A genuinely-X11 station, where the connectors really are called HDMI-N.
XRANDR_BOTH = """\
Screen 0: minimum 16 x 16, current 3200 x 1080, maximum 32767 x 32767
HDMI-1 connected primary 1920x1080+0+0 (normal left inverted right x axis y axis) 600mm x 340mm
   1920x1080     60.00*+
HDMI-2 connected 1280x1024+1920+0 (normal left inverted right x axis y axis) 380mm x 300mm
   1280x1024     60.02*+
"""


class KioskRun:
    """One DRYRUN invocation: its parsed key=value output and its exit code."""

    def __init__(self, returncode: int, stdout: str, stderr: str) -> None:
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr
        self.values = dict(
            line.split("=", 1)
            for line in stdout.splitlines()
            if "=" in line and not line.startswith(" ")
        )

    def __getitem__(self, key: str) -> str:
        return self.values[key]

    def argv(self, window: str) -> list[str]:
        return self.values["window.%s.argv" % window].split()

    def flag(self, window: str, name: str) -> str:
        """The value of --name=value in that window's argv, or '' if bare."""
        for arg in self.argv(window):
            if arg == "--" + name:
                return ""
            if arg.startswith("--%s=" % name):
                return arg.split("=", 1)[1]
        raise KeyError("%s has no --%s" % (window, name))

    def has_flag(self, window: str, name: str) -> bool:
        try:
            self.flag(window, name)
        except KeyError:
            return False
        return True


def _write_fake(directory: Path, name: str, output: str) -> None:
    path = directory / name
    path.write_text("#!/bin/sh\ncat <<'FAKE_EOF'\n%s\nFAKE_EOF\n" % output.rstrip("\n"))
    path.chmod(path.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)


def run(
    *,
    wlr_randr: str | None = WLR_RANDR_BOTH,
    xrandr: str | None = None,
    wayland: bool = True,
    x11: bool = False,
    **env_overrides: str,
) -> KioskRun:
    """Run the script in DRYRUN with fake output tools on PATH."""
    with tempfile.TemporaryDirectory() as tmp:
        fakebin = Path(tmp)
        if wlr_randr is not None:
            _write_fake(fakebin, "wlr-randr", wlr_randr)
        if xrandr is not None:
            _write_fake(fakebin, "xrandr", xrandr)
        _write_fake(fakebin, "chromium", "")
        _write_fake(fakebin, "xset", "")

        env = dict(os.environ)
        env["PATH"] = "%s:%s" % (fakebin, env.get("PATH", ""))
        env["SMPL_KIOSK_DRYRUN"] = "1"
        # Never read the real /etc/smpl-station/kiosk.env, on the off chance
        # these tests are ever run on the station itself.
        env["KIOSK_ENV_FILE"] = str(fakebin / "no-such-kiosk.env")
        env["HOME"] = "/home/pi"
        env.pop("WAYLAND_DISPLAY", None)
        env.pop("DISPLAY", None)
        if wayland:
            env["WAYLAND_DISPLAY"] = "wayland-0"
        if x11:
            env["DISPLAY"] = ":0"
        env.update(env_overrides)

        result = subprocess.run(
            ["/bin/sh", str(SCRIPT)],
            env=env, capture_output=True, text=True, timeout=30,
        )
    return KioskRun(result.returncode, result.stdout, result.stderr)


@unittest.skipUnless(SCRIPT.is_file(), "kiosk script missing")
class TestTwoWindows(unittest.TestCase):
    def test_two_windows_are_launched(self):
        out = run()
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertEqual(out["windows"], "2")

    def test_each_window_gets_its_own_page(self):
        out = run()
        self.assertEqual(out["window.regal.url"], "http://127.0.0.1:8765/regal")
        self.assertEqual(out["window.kisten.url"], "http://127.0.0.1:8765/kisten")
        self.assertEqual(out.flag("regal", "app"), "http://127.0.0.1:8765/regal")
        self.assertEqual(out.flag("kisten", "app"), "http://127.0.0.1:8765/kisten")

    def test_the_two_windows_do_not_share_a_profile(self):
        """The one mistake that turns two windows into one window silently."""
        out = run()
        regal = out.flag("regal", "user-data-dir")
        kisten = out.flag("kisten", "user-data-dir")
        self.assertNotEqual(regal, kisten)
        self.assertTrue(regal)
        self.assertTrue(kisten)

    def test_the_two_windows_do_not_share_a_wm_class(self):
        out = run()
        self.assertNotEqual(out.flag("regal", "class"), out.flag("kisten", "class"))

    def test_neither_window_uses_the_desktop_chromium_profile(self):
        # ~/.config/chromium is the stale browser somebody left open in August.
        out = run()
        for window in ("regal", "kisten"):
            self.assertNotIn(".config/chromium", out.flag(window, "user-data-dir"))


@unittest.skipUnless(SCRIPT.is_file(), "kiosk script missing")
class TestGeometryPerOutput(unittest.TestCase):
    def test_each_window_gets_the_geometry_of_its_own_output(self):
        out = run()
        # HDMI-A-1 is the 1360x768 Philips, parked at 3840,0 today.
        self.assertEqual(out["window.regal.geometry"], "1360x768+3840+0")
        self.assertEqual(out.flag("regal", "window-position"), "3840,0")
        self.assertEqual(out.flag("regal", "window-size"), "1360,768")
        # HDMI-A-2 is the 4K Samsung at the origin.
        self.assertEqual(out["window.kisten.geometry"], "3840x2160+0+0")
        self.assertEqual(out.flag("kisten", "window-position"), "0,0")
        self.assertEqual(out.flag("kisten", "window-size"), "3840,2160")

    def test_the_current_mode_is_used_not_the_first_one_listed(self):
        # The fake lists 1920x1080 before the current 3840x2160 for the
        # Samsung; taking the first mode would silently open a 1080p window.
        out = run()
        self.assertEqual(out.flag("kisten", "window-size"), "3840,2160")

    def test_scale_follows_the_screen_not_the_page(self):
        out = run()
        self.assertEqual(out.flag("regal", "force-device-scale-factor"), "1")
        self.assertEqual(out.flag("kisten", "force-device-scale-factor"), "2")

    def test_xrandr_is_used_when_there_is_no_wayland_session(self):
        out = run(
            wlr_randr=None, xrandr=XRANDR_BOTH, wayland=False, x11=True,
            KIOSK_REGAL_OUTPUT="HDMI-1", KIOSK_KISTEN_OUTPUT="HDMI-2",
        )
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertEqual(out["window.regal.geometry"], "1920x1080+0+0")
        self.assertEqual(out["window.kisten.geometry"], "1280x1024+1920+0")

    def test_wlr_randr_wins_over_xrandr_on_a_wayland_session(self):
        """Under XWayland the outputs are called XWAYLAND1/2, not HDMI-A-N.

        Consulting xrandr first would mean the name in kiosk.env never
        matches anything, so wlr-randr has to be the authority whenever a
        Wayland session is present - even though Chromium is then driven
        through X11.
        """
        out = run(xrandr=XRANDR_BOTH, wayland=True, x11=True)
        self.assertEqual(out["window.regal.geometry"], "1360x768+3840+0")


@unittest.skipUnless(SCRIPT.is_file(), "kiosk script missing")
class TestSwappingTheScreens(unittest.TestCase):
    """Which page is on which screen must be an edit to kiosk.env, nothing more."""

    def test_swapping_the_outputs_swaps_the_screens(self):
        normal = run()
        swapped = run(
            KIOSK_REGAL_OUTPUT="HDMI-A-2", KIOSK_KISTEN_OUTPUT="HDMI-A-1",
            KIOSK_REGAL_SCALE="2", KIOSK_KISTEN_SCALE="1",
        )
        self.assertEqual(swapped.returncode, 0, swapped.stderr)
        self.assertEqual(swapped["window.regal.geometry"], normal["window.kisten.geometry"])
        self.assertEqual(swapped["window.kisten.geometry"], normal["window.regal.geometry"])
        # ...and the pages travelled with the screens, not with the geometry.
        self.assertEqual(swapped["window.regal.url"], normal["window.regal.url"])
        self.assertEqual(swapped["window.kisten.url"], normal["window.kisten.url"])

    def test_the_urls_are_configuration_too(self):
        out = run(
            KIOSK_REGAL_URL="http://127.0.0.1:8765/lager",
            KIOSK_KISTEN_URL="http://127.0.0.1:8765/werkbank",
        )
        self.assertEqual(out.flag("regal", "app"), "http://127.0.0.1:8765/lager")
        self.assertEqual(out.flag("kisten", "app"), "http://127.0.0.1:8765/werkbank")


@unittest.skipUnless(SCRIPT.is_file(), "kiosk script missing")
class TestAMissingScreen(unittest.TestCase):
    """One screen dark is a bad morning. Both pages on one screen is a bad week."""

    def test_a_missing_output_launches_nothing(self):
        out = run(wlr_randr=WLR_RANDR_ONLY_SAMSUNG, KIOSK_OUTPUT_TIMEOUT="0")
        self.assertNotEqual(out.returncode, 0)
        self.assertNotIn("windows", out.values)
        self.assertNotIn("window.kisten.argv", out.values)
        self.assertNotIn("window.regal.argv", out.values)

    def test_a_missing_output_says_which_one_and_what_is_there(self):
        out = run(wlr_randr=WLR_RANDR_ONLY_SAMSUNG, KIOSK_OUTPUT_TIMEOUT="0")
        self.assertIn("HDMI-A-1", out.stderr)
        self.assertIn("KIOSK_REGAL_OUTPUT", out.stderr)
        self.assertIn("HDMI-A-2", out.stderr)  # the one that IS connected

    def test_no_outputs_at_all_is_an_error_not_an_empty_success(self):
        out = run(wlr_randr="", KIOSK_OUTPUT_TIMEOUT="0")
        self.assertNotEqual(out.returncode, 0)
        self.assertNotIn("windows", out.values)

    def test_both_pages_on_one_output_is_refused_up_front(self):
        out = run(KIOSK_KISTEN_OUTPUT="HDMI-A-1")
        self.assertNotEqual(out.returncode, 0)
        self.assertNotIn("windows", out.values)


@unittest.skipUnless(SCRIPT.is_file(), "kiosk script missing")
class TestChromiumFlags(unittest.TestCase):
    """Flags checked against this station's own Chromium 136.0.7103.92."""

    def test_windows_are_fullscreen_by_default(self):
        out = run()
        for window in ("regal", "kisten"):
            self.assertTrue(out.has_flag(window, "kiosk"))

    def test_fullscreen_can_be_dropped_for_plain_placed_windows(self):
        out = run(KIOSK_FULLSCREEN="window")
        for window in ("regal", "kisten"):
            self.assertFalse(out.has_flag(window, "kiosk"))
            # ...but the placement must survive, or the escape hatch is useless.
            self.assertTrue(out.has_flag(window, "window-position"))
            self.assertTrue(out.has_flag(window, "window-size"))

    def test_no_flag_that_chromium_136_removed(self):
        """--disable-session-crashed-bubble is not in this build's binary.

        Chromium ignores an unknown switch in silence, so a removed flag looks
        exactly like a working one until somebody trips over the bubble it was
        supposed to suppress.
        """
        out = run()
        for window in ("regal", "kisten"):
            self.assertFalse(out.has_flag(window, "disable-session-crashed-bubble"))
            self.assertFalse(out.has_flag(window, "disable-translate"))
            self.assertTrue(out.has_flag(window, "hide-crash-restore-bubble"))

    def test_nothing_can_pop_up_over_the_page(self):
        out = run()
        for window in ("regal", "kisten"):
            for flag in ("noerrdialogs", "disable-infobars", "no-first-run"):
                self.assertTrue(out.has_flag(window, flag), flag)

    def test_a_backgrounded_window_is_not_throttled(self):
        # Each screen is unfocused whenever the other one is used, and one is
        # occluded by nothing at all - Chromium throttles both to near-zero.
        out = run()
        for window in ("regal", "kisten"):
            self.assertTrue(out.has_flag(window, "disable-background-timer-throttling"))
            self.assertTrue(out.has_flag(window, "disable-backgrounding-occluded-windows"))
            self.assertTrue(out.has_flag(window, "disable-renderer-backgrounding"))

    def test_the_station_never_updates_itself(self):
        out = run()
        for window in ("regal", "kisten"):
            self.assertTrue(out.has_flag(window, "disable-component-update"))

    def test_the_default_backend_is_x11(self):
        out = run()
        self.assertEqual(out["backend"], "x11")
        for window in ("regal", "kisten"):
            self.assertEqual(out.flag(window, "ozone-platform"), "x11")

    def test_the_wayland_backend_is_reachable(self):
        out = run(KIOSK_BACKEND="wayland")
        self.assertEqual(out.returncode, 0, out.stderr)
        for window in ("regal", "kisten"):
            self.assertEqual(out.flag(window, "ozone-platform"), "wayland")

    def test_an_unknown_backend_is_refused(self):
        out = run(KIOSK_BACKEND="mir")
        self.assertNotEqual(out.returncode, 0)
        self.assertNotIn("windows", out.values)


@unittest.skipUnless(SCRIPT.is_file(), "kiosk script missing")
class TestConfigValidation(unittest.TestCase):
    """kiosk.env is hand-edited at the Pi; a typo must not become an argv."""

    def test_a_url_with_a_space_is_refused(self):
        out = run(KIOSK_REGAL_URL="http://127.0.0.1:8765/re gal")
        self.assertNotEqual(out.returncode, 0)
        self.assertIn("KIOSK_REGAL_URL", out.stderr)

    def test_a_url_that_is_not_a_url_is_refused(self):
        out = run(KIOSK_KISTEN_URL="127.0.0.1:8765/kisten")
        self.assertNotEqual(out.returncode, 0)
        self.assertIn("KIOSK_KISTEN_URL", out.stderr)

    def test_an_output_name_with_a_shell_metacharacter_is_refused(self):
        out = run(KIOSK_REGAL_OUTPUT="HDMI-A-1;reboot")
        self.assertNotEqual(out.returncode, 0)
        self.assertNotIn("windows", out.values)

    def test_a_nonsense_scale_is_refused(self):
        out = run(KIOSK_KISTEN_SCALE="zwei")
        self.assertNotEqual(out.returncode, 0)
        self.assertIn("KIOSK_KISTEN_SCALE", out.stderr)


@unittest.skipUnless(SCRIPT.is_file(), "kiosk script missing")
class TestPackagedFiles(unittest.TestCase):
    """The pieces the installer copies, checked for the promises they make."""

    KIOSK_DIR = SCRIPT.parent

    def test_the_autostart_entry_does_not_replace_the_labwc_autostart(self):
        entry = (self.KIOSK_DIR / "smpl-kiosk.desktop").read_text()
        self.assertIn("Exec=/usr/local/bin/smpl-kiosk.sh", entry)
        self.assertIn("Type=Application", entry)

    def test_the_kanshi_config_pins_both_monitors_by_model(self):
        config = (self.KIOSK_DIR / "kanshi.config").read_text()
        clauses = [
            line.strip() for line in config.splitlines()
            if line.strip().startswith("output ")
        ]
        self.assertTrue(clauses)
        # Every clause names a monitor by model and pins it somewhere: a
        # clause without a position is a screen free to move on the next boot,
        # which is the whole thing this file exists to prevent.
        for clause in clauses:
            self.assertIn("position ", clause, clause)
            self.assertIn("mode ", clause, clause)
        self.assertTrue(any("U28E590" in c for c in clauses))
        self.assertTrue(any("PHILIPS" in c for c in clauses))

    def test_the_kanshi_config_survives_one_screen_being_unplugged(self):
        """A kanshi profile applies only on an exact output-set match."""
        config = (self.KIOSK_DIR / "kanshi.config").read_text()
        profiles = [
            line.split()[1] for line in config.splitlines()
            if line.startswith("profile ")
        ]
        self.assertGreaterEqual(len(profiles), 3, profiles)

    def test_the_env_example_documents_every_variable_the_script_reads(self):
        example = (self.KIOSK_DIR / "kiosk.env.example").read_text()
        script = SCRIPT.read_text()
        names = sorted({
            line.split(":=")[0].split('"${')[1]
            for line in script.splitlines()
            if line.startswith(': "${KIOSK_')
        })
        self.assertTrue(names)
        for name in names:
            self.assertIn(name, example, "%s is undocumented in kiosk.env.example" % name)

    def test_the_drop_ins_are_valid_systemd_fragments(self):
        for name, key in (
            ("10-nowplaying.conf", "PrivateTmp=no"),
            ("20-scanner.conf", "SupplementaryGroups=input"),
        ):
            text = (self.KIOSK_DIR / name).read_text()
            self.assertIn("[Service]", text)
            self.assertIn(key, text)

    def test_the_installer_offers_the_kiosk_as_an_opt_in(self):
        installer = (self.KIOSK_DIR.parent / "install-pi.sh").read_text()
        self.assertIn("--with-kiosk", installer)
        self.assertIn("WITH_KIOSK=0", installer)  # off by default


if __name__ == "__main__":
    unittest.main()
