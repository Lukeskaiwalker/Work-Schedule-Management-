"""The host sampler: what it reports, and what it does when it cannot.

The station is a passively cooled Pi 4 driving a 4K kiosk. It was measured at
80-81 °C with `get_throttled=0xe0000` — already frequency-capped and past the
soft temperature limit — while SMPL showed nothing at all. These tests pin the
two properties that make this useful rather than decorative:

  * a missing sensor removes one key and leaves the rest, because the whole
    point is a number on a wall that keeps working on an odd kernel; and
  * the reason a reading is missing survives to the caller, because
    "cannot open /dev/vcio" is a fixable sentence and a silently absent field
    is not.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import host_metrics  # noqa: E402


class SampleCase(unittest.TestCase):
    def setUp(self) -> None:
        host_metrics.reset()
        self.addCleanup(host_metrics.reset)


# --------------------------------------------------------------------------
# Reading the box
# --------------------------------------------------------------------------


class TestTemperature(SampleCase):
    def test_millidegrees_become_degrees(self):
        with mock.patch.object(host_metrics, "_read", return_value="80300\n"):
            self.assertEqual(host_metrics._temperature_c(), 80.3)

    def test_an_implausible_reading_is_dropped_not_displayed(self):
        """Some boards report this zone in degrees, not millidegrees.

        47000 °C on the workshop wall is worse than no temperature: one is a
        gap somebody investigates, the other is a number somebody stops
        trusting the whole screen over.
        """
        for raw in ("47000000\n", "-99000\n"):
            with mock.patch.object(host_metrics, "_read", return_value=raw):
                self.assertIsNone(host_metrics._temperature_c())

    def test_a_missing_sensor_is_none_not_an_exception(self):
        with mock.patch.object(host_metrics, "_read", return_value=None):
            self.assertIsNone(host_metrics._temperature_c())

    def test_garbage_is_none(self):
        with mock.patch.object(host_metrics, "_read", return_value="warm\n"):
            self.assertIsNone(host_metrics._temperature_c())


class TestCpuPercent(SampleCase):
    #      user nice system idle iowait irq softirq
    FIRST = "cpu  1000 0 500 8000 100 0 0\n"
    # +400 busy, +600 idle  ->  40% of the 1000 ticks that passed
    SECOND = "cpu  1300 0 600 8500 200 0 0\n"

    def test_the_first_call_measures_nothing(self):
        """A counter read once describes the machine since boot, which is

        never the question. None is the honest answer, and 0.0 would not be.
        """
        with mock.patch.object(host_metrics, "_read", return_value=self.FIRST):
            self.assertIsNone(host_metrics._cpu_percent())

    def test_the_second_call_measures_the_gap(self):
        with mock.patch.object(host_metrics, "_read", return_value=self.FIRST):
            host_metrics._cpu_percent()
        with mock.patch.object(host_metrics, "_read", return_value=self.SECOND):
            self.assertEqual(host_metrics._cpu_percent(), 40.0)

    def test_iowait_counts_as_idle(self):
        """A station waiting on an SD card is not a station that needs a fan."""
        with mock.patch.object(host_metrics, "_read", return_value=self.FIRST):
            host_metrics._cpu_percent()
        # Everything that passed went to iowait.
        with mock.patch.object(
            host_metrics, "_read", return_value="cpu  1000 0 500 8000 1100 0 0\n"
        ):
            self.assertEqual(host_metrics._cpu_percent(), 0.0)

    def test_two_calls_inside_one_tick_measure_nothing(self):
        with mock.patch.object(host_metrics, "_read", return_value=self.FIRST):
            host_metrics._cpu_percent()
            self.assertIsNone(host_metrics._cpu_percent())

    def test_a_counter_reset_does_not_produce_a_negative(self):
        with mock.patch.object(host_metrics, "_read", return_value=self.SECOND):
            host_metrics._cpu_percent()
        with mock.patch.object(host_metrics, "_read", return_value=self.FIRST):
            self.assertIsNone(host_metrics._cpu_percent())


class TestMemory(SampleCase):
    MEMINFO = "MemTotal:        7996844 kB\nMemFree:  100 kB\nMemAvailable:    4700000 kB\n"

    def test_available_not_free_is_what_gets_reported(self):
        """On a box with 3 GB of page cache, MemFree answers the wrong question."""
        with mock.patch.object(host_metrics, "_read", return_value=self.MEMINFO):
            mem = host_metrics._memory()
        self.assertEqual(mem["total_mb"], 7996844 // 1024)
        self.assertEqual(mem["available_mb"], 4700000 // 1024)
        self.assertEqual(mem["used_pct"], 41.2)

    def test_a_truncated_meminfo_is_none(self):
        with mock.patch.object(host_metrics, "_read", return_value="MemTotal: 100 kB\n"):
            self.assertIsNone(host_metrics._memory())


class TestLoad(SampleCase):
    def test_the_three_windows_are_parsed(self):
        with mock.patch.object(host_metrics, "_read", return_value="2.98 3.31 3.36 1/532 9\n"):
            self.assertEqual(host_metrics._load(), {"1m": 2.98, "5m": 3.31, "15m": 3.36})


# --------------------------------------------------------------------------
# Throttling — the half that explains a slow afternoon
# --------------------------------------------------------------------------


class TestDecodeThrottled(unittest.TestCase):
    def test_the_office_stations_real_word(self):
        """0xe0000 measured on the office Pi: capped, throttled and past the

        soft temperature limit at some point since boot, but nothing live.
        """
        flags = host_metrics.decode_throttled(0xE0000)
        self.assertTrue(flags["freq_capped_since_boot"])
        self.assertTrue(flags["throttled_since_boot"])
        self.assertTrue(flags["soft_temp_limit_since_boot"])
        self.assertFalse(flags["under_voltage_since_boot"])
        self.assertFalse(flags["throttled_now"])
        self.assertTrue(flags["since_boot"])
        self.assertFalse(flags["now"])
        self.assertEqual(flags["raw"], "0xe0000")

    def test_a_healthy_pi_is_all_false(self):
        flags = host_metrics.decode_throttled(0)
        self.assertFalse(flags["now"])
        self.assertFalse(flags["since_boot"])
        self.assertEqual(flags["raw"], "0x0")

    def test_live_under_voltage_shows_in_the_now_rollup(self):
        flags = host_metrics.decode_throttled(0x1)
        self.assertTrue(flags["under_voltage_now"])
        self.assertTrue(flags["now"])

    def test_none_decodes_to_none(self):
        self.assertIsNone(host_metrics.decode_throttled(None))


class TestVcgencmdIsNotRunEveryCall(SampleCase):
    """The cost rule: measuring must not be why the Pi gets hotter.

    vcgencmd is an 8 ms subprocess (measured on the station) and the flags it
    returns are sticky. A screen polling once a second must not fork 60 times
    a minute for a value that moves in hours.
    """

    def test_repeated_samples_spawn_one_subprocess(self):
        fake = mock.Mock(returncode=0, stdout="throttled=0x0\n", stderr="")
        with mock.patch.object(host_metrics.subprocess, "run", return_value=fake) as run:
            for tick in range(20):
                host_metrics._throttled_word(1000.0 + tick)
        self.assertEqual(run.call_count, 1)

    def test_it_runs_again_once_the_ttl_has_passed(self):
        fake = mock.Mock(returncode=0, stdout="throttled=0x0\n", stderr="")
        with mock.patch.object(host_metrics.subprocess, "run", return_value=fake) as run:
            host_metrics._throttled_word(1000.0)
            host_metrics._throttled_word(1000.0 + host_metrics.VCGENCMD_TTL_S + 1)
        self.assertEqual(run.call_count, 2)


class TestVcgencmdFailureIsExplained(SampleCase):
    def test_the_vcio_permission_error_becomes_a_fixable_sentence(self):
        """The overwhelmingly likely failure, and the one worth naming.

        The agent runs as `smpl-station`, /dev/vcio is root:video, and the
        unit has to grant the group. A screen that merely omits the throttle
        flags gives nobody a way to discover that.
        """
        fake = mock.Mock(
            returncode=1, stdout="", stderr="Can't open device file: /dev/vcio\n"
        )
        with mock.patch.object(host_metrics.subprocess, "run", return_value=fake):
            value, error = host_metrics._throttled_word(1000.0)
        self.assertIsNone(value)
        self.assertIn("video", error)

    def test_a_missing_binary_says_so(self):
        with mock.patch.object(
            host_metrics.subprocess, "run", side_effect=FileNotFoundError()
        ):
            value, error = host_metrics._throttled_word(1000.0)
        self.assertIsNone(value)
        self.assertIn("not installed", error)

    def test_a_failure_is_not_cached_so_a_fix_takes_effect(self):
        """A granted group must not need an agent restart to show up."""
        with mock.patch.object(
            host_metrics.subprocess, "run", side_effect=FileNotFoundError()
        ) as run:
            host_metrics._throttled_word(1000.0)
            host_metrics._throttled_word(1000.1)
        self.assertEqual(run.call_count, 2)


# --------------------------------------------------------------------------
# The whole sample
# --------------------------------------------------------------------------


class TestSample(SampleCase):
    def test_it_never_raises_even_when_nothing_is_readable(self):
        with mock.patch.object(host_metrics, "_read", return_value=None), \
             mock.patch.object(host_metrics, "os") as fake_os, \
             mock.patch.object(host_metrics.subprocess, "run", side_effect=OSError("nope")):
            fake_os.listdir.side_effect = OSError("nope")
            out = host_metrics.sample()
        self.assertIsInstance(out, dict)
        # The reason survives even when every reading is gone.
        self.assertIn("throttle_error", out)

    def test_a_real_sample_on_this_machine_is_a_flat_small_dict(self):
        """Runs against the actual host, whatever it is.

        The size matters: this dict is forwarded in the station heartbeat,
        where the assembled hardware blob is capped at 4096 bytes server-side.
        """
        import json

        host_metrics.sample()  # prime the CPU delta
        out = host_metrics.sample()
        serialized = json.dumps(out, default=str)
        self.assertLess(len(serialized.encode("utf-8")), 1024, serialized)
        for key, value in out.items():
            self.assertIsInstance(key, str)
            self.assertIsInstance(value, (int, float, bool, str, dict), key)

    def test_the_freq_ratio_is_reported_even_without_vcgencmd(self):
        """The only throttle signal available without /dev/vcio."""

        def fake_read_int(path):
            return {
                host_metrics.CPUFREQ_CUR: 600_000,
                host_metrics.CPUFREQ_MAX: 1_800_000,
            }.get(path)

        with mock.patch.object(host_metrics, "_read_int", side_effect=fake_read_int), \
             mock.patch.object(host_metrics, "_read", return_value=None), \
             mock.patch.object(host_metrics.subprocess, "run", side_effect=FileNotFoundError()):
            out = host_metrics.sample()
        self.assertEqual(out["cpu_mhz"], 600)
        self.assertEqual(out["cpu_max_mhz"], 1800)
        self.assertEqual(out["cpu_freq_pct"], 33)

    def test_no_active_cooling_is_reported_as_a_fact(self):
        """The office station is passively cooled, which is the fact that

        turns "81 °C" into something somebody can act on.
        """
        with mock.patch.object(host_metrics.os, "listdir", return_value=["thermal_zone0"]):
            self.assertIs(host_metrics._has_active_cooling(), False)
        with mock.patch.object(
            host_metrics.os, "listdir", return_value=["thermal_zone0", "cooling_device0"]
        ):
            self.assertIs(host_metrics._has_active_cooling(), True)


if __name__ == "__main__":
    unittest.main()
