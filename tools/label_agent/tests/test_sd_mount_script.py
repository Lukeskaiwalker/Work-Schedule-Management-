"""The udev automount helper, exercised on a machine with no udev.

``smpl-sd-mount.sh`` is the one piece of the Pi install that turns a card
label - text an outsider chooses - into a filesystem path, so its sanitising
is worth testing even though the mounting itself cannot be. ``DRYRUN`` makes
the script print its decision instead of calling ``systemd-mount``, which is
also the fastest way to debug a surprising mount point on the Pi.
"""

from __future__ import annotations

import os
import subprocess
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPT = HERE.parent / "packaging" / "smpl-sd-mount.sh"


def run(device: str, *, label: str = "", fstype: str = "vfat", user: str = "") -> dict:
    env = dict(os.environ)
    env["SMPL_SD_MOUNT_DRYRUN"] = "1"
    env["ID_FS_LABEL"] = label
    env["ID_FS_TYPE"] = fstype
    if user:
        env["SMPL_STATION_USER"] = user
    result = subprocess.run(
        ["/bin/sh", str(SCRIPT), device],
        env=env, capture_output=True, text=True, timeout=20,
    )
    if result.returncode != 0:
        raise AssertionError("script failed: %s%s" % (result.stdout, result.stderr))
    return dict(
        line.split("=", 1) for line in result.stdout.strip().splitlines() if "=" in line
    )


@unittest.skipUnless(SCRIPT.is_file(), "helper script missing")
class TestMountTarget(unittest.TestCase):
    def test_a_plain_label_becomes_a_plain_path(self):
        out = run("/dev/sdb1", label="BENNING")
        self.assertEqual(out["target"], "/media/smpl/BENNING-sdb1")

    def test_an_unlabelled_card_still_gets_a_mount_point(self):
        out = run("/dev/sdc1", label="")
        self.assertEqual(out["target"], "/media/smpl/card-sdc1")

    def test_a_traversing_label_cannot_escape_the_mount_root(self):
        # A card labelled "../../etc" must not mount over anything.
        out = run("/dev/sdb1", label="../../etc")
        self.assertTrue(out["target"].startswith("/media/smpl/"), out["target"])
        self.assertNotIn("..", out["target"])

    def test_shell_metacharacters_are_stripped(self):
        out = run("/dev/sdb1", label="a;rm -rf /`whoami`$(id)")
        self.assertTrue(out["target"].startswith("/media/smpl/"))
        for char in ";`$()& |":
            self.assertNotIn(char, out["target"])

    def test_spaces_and_slashes_are_stripped(self):
        out = run("/dev/sdb1", label="BENNING ST/760")
        self.assertEqual(out["target"], "/media/smpl/BENNINGST760-sdb1")

    def test_a_very_long_label_is_truncated(self):
        out = run("/dev/sdb1", label="X" * 400)
        name = out["target"].rsplit("/", 1)[-1]
        self.assertLessEqual(len(name), 32 + len("-sdb1"))

    def test_two_cards_with_the_same_label_get_different_mount_points(self):
        first = run("/dev/sdb1", label="CARD")
        second = run("/dev/sdc1", label="CARD")
        self.assertNotEqual(first["target"], second["target"])


@unittest.skipUnless(SCRIPT.is_file(), "helper script missing")
class TestMountOptions(unittest.TestCase):
    def test_a_card_is_always_mounted_read_only(self):
        """The card is evidence. Nothing may write to it, including us."""
        for fstype in ("vfat", "exfat", "ntfs", "ext4"):
            with self.subTest(fstype=fstype):
                out = run("/dev/sdb1", label="C", fstype=fstype)
                options = out["options"].split(",")
                self.assertIn("ro", options)
                self.assertIn("noexec", options)
                self.assertIn("nosuid", options)
                self.assertIn("nodev", options)

    def test_ownership_options_are_only_used_where_they_are_legal(self):
        # uid=/gid= are required on vfat (which has no ownership) and are a
        # mount *error* on ext4, so the two must not be conflated.
        vfat = run("/dev/sdb1", label="C", fstype="vfat", user=current_user())
        self.assertIn("uid=", vfat["options"])
        self.assertIn("umask=0077", vfat["options"])

        ext = run("/dev/sdb1", label="C", fstype="ext4", user=current_user())
        self.assertNotIn("uid=", ext["options"])

    def test_an_unknown_service_user_does_not_break_the_mount(self):
        out = run("/dev/sdb1", label="C", fstype="vfat", user="nobody-such-user")
        self.assertIn("ro", out["options"].split(","))
        self.assertNotIn("uid=", out["options"])


def current_user() -> str:
    import getpass
    return getpass.getuser()


if __name__ == "__main__":
    unittest.main()
