"""The AirPlay widget's data source, and every way it is allowed to fail.

The Pi that runs the station also runs shairport-sync as the office AirPlay
receiver. Showing what is playing costs one D-Bus property read, but the Pi
has no Python D-Bus binding and is not getting one, so this shells out to
``busctl`` and parses its JSON.

Everything here is a decoration on a stock-control appliance. A missing
``busctl``, a D-Bus policy that says no, a cover file the service cannot see
because systemd gave it a private /tmp — all three must produce
``{"playing": false}`` and nothing else. These tests are mostly that
assertion, written six ways.

Verified on the Pi (2026-09-10), as the ``pi`` user, which is *not*
shairport-sync — reading the properties across users is allowed:

    $ busctl --system --json=short get-property \\
        org.mpris.MediaPlayer2.ShairportSync /org/mpris/MediaPlayer2 \\
        org.mpris.MediaPlayer2.Player PlaybackStatus
    {"type":"s","data":"Stopped"}

and ``mpris:artUrl`` pointed at
``file:///tmp/shairport-sync/.cache/coverart/cover-<md5>.jpg``.
"""

from __future__ import annotations

import json
import sys
import tempfile
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

import now_playing  # noqa: E402


# The exact bytes busctl produced on the Pi, with the title changed.
PLAYING = '{"type":"s","data":"Playing"}'
STOPPED = '{"type":"s","data":"Stopped"}'
PAUSED = '{"type":"s","data":"Paused"}'

METADATA = json.dumps({
    "type": "a{sv}",
    "data": {
        "mpris:artUrl": {"type": "s", "data": "file://%(cover)s"},
        "mpris:trackid": {"type": "o", "data": "/org/gnome/ShairportSync/57E3D6DCE68D0AF6"},
        "xesam:title": {"type": "s", "data": "Pocahontas - Remix"},
        "xesam:album": {"type": "s", "data": "You Know Who I Am"},
        "xesam:artist": {"type": "as", "data": ["D'juan NVO", "Royalty"]},
        "mpris:length": {"type": "x", "data": 221231000},
    },
})

EMPTY_METADATA = '{"type":"a{sv}","data":{}}'

JPEG = b"\xff\xd8\xff\xe0" + b"cover bytes" * 40


class Clock:
    def __init__(self, start=1_700_000_000.0):
        self.now = float(start)

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds
        return self.now


class FakeBusctl:
    """A scripted ``busctl``: one answer per property, or an explosion."""

    def __init__(self, *, status=STOPPED, metadata=EMPTY_METADATA,
                 rc=0, stderr="", raises=None):
        self.status = status
        self.metadata = metadata
        self.rc = rc
        self.stderr = stderr
        self.raises = raises
        self.calls = []

    def __call__(self, argv, timeout):
        self.calls.append((list(argv), timeout))
        if self.raises is not None:
            raise self.raises
        if self.rc != 0:
            return self.rc, "", self.stderr
        return 0, (self.metadata if argv[-1] == "Metadata" else self.status), ""


class Case(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / "shairport-sync"
        self.cache = self.root / ".cache" / "coverart"
        self.cache.mkdir(parents=True)
        self.cover_file = self.cache / "cover-bc2cff47bf0c4da93231948f5a4aba90.jpg"
        self.cover_file.write_bytes(JPEG)
        self.clock = Clock()
        self.addCleanup(self.tmp.cleanup)

    def metadata(self, cover: Path | str = "") -> str:
        return METADATA % {"cover": cover or self.cover_file}

    def widget(self, runner, **kwargs) -> now_playing.NowPlaying:
        return now_playing.NowPlaying(runner=runner, clock=self.clock,
                                      cover_root=str(self.root), **kwargs)


# --------------------------------------------------------------------------
# The happy path
# --------------------------------------------------------------------------


class TestPlaying(Case):
    def test_a_playing_track_is_reported(self):
        widget = self.widget(FakeBusctl(status=PLAYING, metadata=self.metadata()))
        widget.poll_once()
        snapshot = widget.snapshot()
        self.assertTrue(snapshot["playing"])
        self.assertEqual(snapshot["title"], "Pocahontas - Remix")
        self.assertEqual(snapshot["album"], "You Know Who I Am")
        self.assertEqual(snapshot["since"], 1_700_000_000.0)

    def test_several_artists_are_joined_for_a_single_line(self):
        widget = self.widget(FakeBusctl(status=PLAYING, metadata=self.metadata()))
        widget.poll_once()
        self.assertEqual(widget.snapshot()["artist"], "D'juan NVO, Royalty")

    def test_the_snapshot_is_json_shaped_and_complete(self):
        widget = self.widget(FakeBusctl(status=PLAYING, metadata=self.metadata()))
        widget.poll_once()
        snapshot = widget.snapshot()
        json.dumps(snapshot)
        self.assertEqual(
            set(snapshot),
            {"playing", "title", "artist", "album", "art_hash", "since"},
        )

    def test_it_asks_the_system_bus_for_the_documented_names(self):
        fake = FakeBusctl(status=PLAYING, metadata=self.metadata())
        self.widget(fake).poll_once()
        argv = fake.calls[0][0]
        self.assertEqual(argv[0], "busctl")
        self.assertIn("--system", argv)
        self.assertIn("--json=short", argv)
        self.assertIn("org.mpris.MediaPlayer2.ShairportSync", argv)
        self.assertIn("/org/mpris/MediaPlayer2", argv)
        self.assertIn("org.mpris.MediaPlayer2.Player", argv)

    def test_metadata_is_not_fetched_when_nothing_is_playing(self):
        # One subprocess every ten seconds, not two.
        fake = FakeBusctl(status=STOPPED)
        self.widget(fake).poll_once()
        self.assertEqual(len(fake.calls), 1)

    def test_since_survives_a_second_poll_of_the_same_track(self):
        widget = self.widget(FakeBusctl(status=PLAYING, metadata=self.metadata()))
        widget.poll_once()
        self.clock.advance(30)
        widget.poll_once()
        self.assertEqual(widget.snapshot()["since"], 1_700_000_000.0)

    def test_a_new_track_restarts_since(self):
        fake = FakeBusctl(status=PLAYING, metadata=self.metadata())
        widget = self.widget(fake)
        widget.poll_once()
        self.clock.advance(30)
        fake.metadata = fake.metadata.replace("Pocahontas - Remix", "Ein anderes Lied")
        widget.poll_once()
        self.assertEqual(widget.snapshot()["since"], 1_700_000_030.0)

    def test_the_poll_interval_follows_the_playback_state(self):
        widget = self.widget(FakeBusctl(status=PLAYING, metadata=self.metadata()),
                             poll_playing_s=2.0, poll_idle_s=10.0)
        widget.poll_once()
        self.assertEqual(widget.interval(), 2.0)
        widget = self.widget(FakeBusctl(status=STOPPED), poll_playing_s=2.0, poll_idle_s=10.0)
        widget.poll_once()
        self.assertEqual(widget.interval(), 10.0)


class TestNotPlaying(Case):
    def test_stopped_is_reported_as_not_playing_with_no_leftovers(self):
        fake = FakeBusctl(status=PLAYING, metadata=self.metadata())
        widget = self.widget(fake)
        widget.poll_once()
        fake.status = STOPPED
        widget.poll_once()
        snapshot = widget.snapshot()
        self.assertFalse(snapshot["playing"])
        for field in ("title", "artist", "album", "art_hash", "since"):
            self.assertIsNone(snapshot[field], field)

    def test_paused_is_not_playing(self):
        widget = self.widget(FakeBusctl(status=PAUSED, metadata=self.metadata()))
        widget.poll_once()
        self.assertFalse(widget.snapshot()["playing"])


# --------------------------------------------------------------------------
# The cover
# --------------------------------------------------------------------------


class TestCover(Case):
    def test_the_cover_is_read_and_hashed(self):
        widget = self.widget(FakeBusctl(status=PLAYING, metadata=self.metadata()))
        widget.poll_once()
        blob, etag = widget.cover()
        self.assertEqual(blob, JPEG)
        self.assertTrue(etag)
        self.assertEqual(etag, widget.snapshot()["art_hash"])

    def test_the_hash_is_stable_for_the_same_bytes(self):
        widget = self.widget(FakeBusctl(status=PLAYING, metadata=self.metadata()))
        widget.poll_once()
        first = widget.snapshot()["art_hash"]
        widget.poll_once()
        self.assertEqual(widget.snapshot()["art_hash"], first)

    def test_a_path_outside_the_cache_directory_is_refused(self):
        outside = Path(self.tmp.name) / "passwd"
        outside.write_bytes(b"root:x:0:0:")
        widget = self.widget(FakeBusctl(status=PLAYING, metadata=self.metadata(outside)))
        widget.poll_once()
        self.assertIsNone(widget.snapshot()["art_hash"])
        self.assertEqual(widget.cover(), (None, None))
        self.assertIsNotNone(widget.status()["cover_error"])

    def test_a_traversal_through_the_cache_directory_is_refused(self):
        outside = Path(self.tmp.name) / "passwd"
        outside.write_bytes(b"root:x:0:0:")
        sneaky = "%s/.cache/coverart/../../../passwd" % self.root
        widget = self.widget(FakeBusctl(status=PLAYING, metadata=self.metadata(sneaky)))
        widget.poll_once()
        self.assertEqual(widget.cover(), (None, None))

    def test_an_absurdly_large_cover_is_refused(self):
        self.cover_file.write_bytes(b"x" * 4096)
        widget = self.widget(FakeBusctl(status=PLAYING, metadata=self.metadata()),
                             max_cover_bytes=1024)
        widget.poll_once()
        self.assertEqual(widget.cover(), (None, None))
        self.assertIn("groß", widget.status()["cover_error"])

    def test_a_missing_cover_file_still_leaves_the_track_playing(self):
        # This is exactly what PrivateTmp=yes looks like from inside the unit:
        # the metadata names a file the service cannot see.
        self.cover_file.unlink()
        widget = self.widget(FakeBusctl(status=PLAYING, metadata=self.metadata()))
        widget.poll_once()
        snapshot = widget.snapshot()
        self.assertTrue(snapshot["playing"])
        self.assertEqual(snapshot["title"], "Pocahontas - Remix")
        self.assertIsNone(snapshot["art_hash"])
        self.assertEqual(widget.cover(), (None, None))
        self.assertIsNotNone(widget.status()["cover_error"])

    def test_a_percent_encoded_path_is_decoded(self):
        spaced = self.cache / "cover art.jpg"
        spaced.write_bytes(JPEG)
        widget = self.widget(FakeBusctl(
            status=PLAYING,
            metadata=self.metadata(str(spaced).replace(" ", "%20")),
        ))
        widget.poll_once()
        self.assertEqual(widget.cover()[0], JPEG)

    def test_a_non_file_url_is_refused(self):
        widget = self.widget(FakeBusctl(
            status=PLAYING,
            metadata=METADATA.replace("file://%(cover)s", "http://evil.example/art.jpg"),
        ))
        widget.poll_once()
        self.assertEqual(widget.cover(), (None, None))

    def test_no_art_url_is_not_an_error(self):
        widget = self.widget(FakeBusctl(status=PLAYING, metadata=EMPTY_METADATA))
        widget.poll_once()
        self.assertTrue(widget.snapshot()["playing"])
        self.assertIsNone(widget.snapshot()["art_hash"])
        self.assertEqual(widget.cover(), (None, None))


# --------------------------------------------------------------------------
# Every way busctl can let us down
# --------------------------------------------------------------------------


class TestDegradation(Case):
    def assert_silent(self, widget):
        widget.poll_once()
        snapshot = widget.snapshot()
        self.assertFalse(snapshot["playing"])
        self.assertIsNone(snapshot["title"])
        json.dumps(widget.status())

    def test_no_busctl_on_the_box(self):
        widget = self.widget(FakeBusctl(raises=FileNotFoundError("busctl")))
        self.assert_silent(widget)
        self.assertIsNotNone(widget.status()["error"])

    def test_a_dbus_policy_denial(self):
        widget = self.widget(FakeBusctl(
            rc=1, stderr="Failed to get property PlaybackStatus: Access denied"))
        self.assert_silent(widget)
        self.assertIn("Access denied", widget.status()["error"])

    def test_shairport_not_running_at_all(self):
        widget = self.widget(FakeBusctl(
            rc=1, stderr="Failed to activate service 'org.mpris.MediaPlayer2.ShairportSync'"))
        self.assert_silent(widget)

    def test_output_that_is_not_json(self):
        widget = self.widget(FakeBusctl(status="not json"))
        self.assert_silent(widget)

    def test_json_of_the_wrong_shape(self):
        widget = self.widget(FakeBusctl(status='{"type":"s"}'))
        self.assert_silent(widget)

    def test_metadata_of_the_wrong_shape(self):
        widget = self.widget(FakeBusctl(status=PLAYING, metadata='{"type":"a{sv}","data":[]}'))
        widget.poll_once()
        self.assertTrue(widget.snapshot()["playing"])
        self.assertIsNone(widget.snapshot()["title"])

    def test_a_timeout_is_survivable(self):
        import subprocess

        widget = self.widget(FakeBusctl(
            raises=subprocess.TimeoutExpired(cmd="busctl", timeout=2.0)))
        self.assert_silent(widget)

    def test_an_unexpected_explosion_is_survivable(self):
        widget = self.widget(FakeBusctl(raises=RuntimeError("something new")))
        self.assert_silent(widget)

    def test_a_recovered_bus_clears_the_error(self):
        fake = FakeBusctl(raises=FileNotFoundError("busctl"))
        widget = self.widget(fake)
        widget.poll_once()
        self.assertIsNotNone(widget.status()["error"])
        fake.raises = None
        fake.status = PLAYING
        fake.metadata = self.metadata()
        widget.poll_once()
        self.assertIsNone(widget.status()["error"])
        self.assertTrue(widget.snapshot()["playing"])

    def test_it_logs_once_per_failure_state(self):
        lines = []
        widget = self.widget(FakeBusctl(raises=FileNotFoundError("busctl")), log=lines.append)
        for _ in range(6):
            widget.poll_once()
        self.assertEqual(len(lines), 1)


# --------------------------------------------------------------------------
# The thread
# --------------------------------------------------------------------------


class TestThread(Case):
    def test_start_and_stop_are_clean(self):
        widget = now_playing.NowPlaying(
            runner=FakeBusctl(status=PLAYING, metadata=self.metadata()),
            cover_root=str(self.root), poll_playing_s=0.01, poll_idle_s=0.01,
        )
        widget.start()
        deadline = time.monotonic() + 3.0
        while time.monotonic() < deadline and not widget.snapshot()["playing"]:
            time.sleep(0.01)
        self.assertTrue(widget.snapshot()["playing"])
        widget.stop()
        widget.join(timeout=3.0)
        self.assertFalse(widget.is_alive())

    def test_starting_twice_makes_one_thread(self):
        widget = now_playing.NowPlaying(runner=FakeBusctl(), cover_root=str(self.root),
                                        poll_idle_s=0.01)
        widget.start()
        widget.start()
        self.addCleanup(widget.stop)
        self.assertTrue(widget.is_alive())

    def test_a_widget_that_was_never_started_still_answers(self):
        widget = now_playing.NowPlaying(runner=FakeBusctl(), cover_root=str(self.root))
        self.assertFalse(widget.snapshot()["playing"])
        self.assertEqual(widget.cover(), (None, None))


class TestNoShellInjection(Case):
    def test_the_command_is_a_list_never_a_string(self):
        fake = FakeBusctl(status=PLAYING, metadata=self.metadata())
        self.widget(fake).poll_once()
        for argv, _timeout in fake.calls:
            self.assertIsInstance(argv, list)
            for part in argv:
                self.assertIsInstance(part, str)

    def test_the_default_runner_does_not_use_a_shell(self):
        source = (HERE.parent / "now_playing.py").read_text(encoding="utf-8")
        self.assertNotIn("shell=True", source)
        self.assertNotIn("os.system", source)


if __name__ == "__main__":
    unittest.main()
