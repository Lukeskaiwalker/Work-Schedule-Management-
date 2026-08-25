"""The staging pipeline: copy, hash, manifest, dedupe - and never touch the card.

The promise being tested is narrow and absolute: whatever happens, the bytes
that were on the card are on the disk, unmodified, with a hash that proves it,
and the card itself is exactly as it was found.
"""

from __future__ import annotations

import hashlib
import json
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

import fixtures  # noqa: E402
import sd_import  # noqa: E402
from sd_mounts import Mount, MountWatcher, _linux_mounts, _unescape_mountinfo  # noqa: E402


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with open(str(path), "rb") as handle:
        for chunk in iter(lambda: handle.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


def snapshot(root: Path):
    """Every file under *root* with its size, mtime and content hash."""
    out = {}
    for dirpath, _dirs, names in os.walk(str(root), followlinks=False):
        for name in names:
            full = Path(dirpath) / name
            if full.is_symlink():
                out[str(full)] = ("symlink", os.readlink(str(full)))
                continue
            info = full.stat()
            out[str(full)] = (info.st_size, int(info.st_mtime), sha256_of(full))
    return out


class ImporterCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.cards = self.root / "cards"
        self.cards.mkdir()
        self.staging = self.root / "staging"
        self.store = sd_import.ImportStore(self.root / "agent.db")
        self.importer = sd_import.SdImporter(
            self.store, staging_dir=self.staging,
            simulate_root=str(self.cards), agent_version="test",
        )

    def tearDown(self) -> None:
        self.importer.stop()
        self.tmp.cleanup()

    def mount_for(self, card: Path) -> Mount:
        return Mount(mount_point=str(card), label=card.name,
                     filesystem="simulated", source="test", simulated=True)


class TestBenningCard(ImporterCase):
    def setUp(self) -> None:
        super().setUp()
        self.card = fixtures.build_benning_st_card(self.cards / "BENNING_ST760")

    def test_card_is_left_untouched(self):
        """The single most important property. Read-only, always."""
        before = snapshot(self.card)
        self.importer.ingest(self.mount_for(self.card))
        self.assertEqual(before, snapshot(self.card))

    def test_every_file_is_staged_and_hashed_correctly(self):
        result = self.importer.ingest(self.mount_for(self.card))
        self.assertEqual(result.status, "staged", result.error)
        # Test.db plus three ring-buffer backups.
        self.assertEqual(len(result.files), 4)
        for entry in result.files:
            staged = result.directory / "files" / entry.relative_path
            original = self.card / entry.relative_path
            with self.subTest(path=entry.relative_path):
                self.assertTrue(staged.is_file())
                self.assertEqual(staged.read_bytes(), original.read_bytes())
                self.assertEqual(entry.sha256, sha256_of(original))

    def test_the_vendor_is_identified_from_the_layout(self):
        result = self.importer.ingest(self.mount_for(self.card))
        self.assertEqual(result.vendor, "benning")
        self.assertEqual(result.confidence, "high")
        self.assertIn("ST 755/760", result.model_hint)

    def test_databases_are_staged_but_never_parsed(self):
        result = self.importer.ingest(self.mount_for(self.card))
        self.assertEqual(result.parse_status, "passthrough")
        self.assertFalse((result.directory / "parsed.json").exists())
        for entry in result.files:
            self.assertFalse(entry.parsed)
            self.assertIn("no parser", entry.parse_note)

    def test_manifest_describes_the_import(self):
        result = self.importer.ingest(self.mount_for(self.card))
        manifest = json.loads((result.directory / "manifest.json").read_text("utf-8"))
        self.assertEqual(manifest["manifest_version"], sd_import.MANIFEST_VERSION)
        self.assertEqual(manifest["instrument"]["vendor"], "benning")
        self.assertEqual(manifest["totals"]["files"], 4)
        self.assertEqual(manifest["source"]["label"], "BENNING_ST760")
        paths = {f["path"] for f in manifest["files"]}
        self.assertIn("Test.db", paths)
        self.assertIn("Backups/Test_Backup.001", paths)
        # The honesty note travels with the data, not just in the source.
        self.assertIn("never renames", manifest["notes"])

    def test_reinserting_the_same_card_is_a_duplicate_not_a_second_copy(self):
        first = self.importer.ingest(self.mount_for(self.card))
        second = self.importer.ingest(self.mount_for(self.card))
        self.assertEqual(second.status, "duplicate")
        self.assertEqual(second.duplicate_of, first.import_id)
        self.assertEqual(len(list((self.staging).iterdir())), 1)

    def test_a_card_that_gained_a_test_is_imported_again(self):
        """The ring buffer rewrites filenames, so dedupe must be by content."""
        self.importer.ingest(self.mount_for(self.card))
        (self.card / "Backups" / "Test_Backup.004").write_bytes(
            fixtures.SQLITE_HEADER + b"\x00" * 16 + b"a later generation"
        )
        second = self.importer.ingest(self.mount_for(self.card))
        self.assertEqual(second.status, "staged")
        self.assertEqual(len(second.files), 5)


class TestMetrelCard(ImporterCase):
    def setUp(self) -> None:
        super().setUp()
        self.card = fixtures.build_metrel_card(self.cards / "METREL")

    def test_padfx_is_staged_and_structurally_parsed(self):
        result = self.importer.ingest(self.mount_for(self.card))
        self.assertEqual(result.status, "staged", result.error)
        self.assertEqual(result.vendor, "metrel")
        self.assertEqual(result.confidence, "high")
        self.assertIn(result.parse_status, ("parsed", "partial"))

        parsed = json.loads((result.directory / "parsed.json").read_text("utf-8"))
        self.assertGreater(parsed["record_count"], 0)
        objects = [r for r in parsed["records"] if r.get("_element") == "SO"]
        self.assertTrue(objects)
        # Provenance: every record says which file on the card it came from.
        for record in parsed["records"]:
            self.assertIn("_source_file", record)
            self.assertIn("_format", record)

    def test_measurement_values_survive_into_parsed_json(self):
        result = self.importer.ingest(self.mount_for(self.card))
        text = (result.directory / "parsed.json").read_text("utf-8")
        self.assertIn("35 kOhm", text)
        self.assertIn("Verteilung UV1", text)


class TestHostileCard(ImporterCase):
    def setUp(self) -> None:
        super().setUp()
        self.made = fixtures.build_hostile_card(self.cards / "MESSY")
        self.card = self.made["card"]

    def test_import_completes_and_finds_the_real_protocol(self):
        result = self.importer.ingest(self.mount_for(self.card))
        self.assertEqual(result.status, "staged", result.error)
        paths = {f.relative_path for f in result.files}
        self.assertIn("Pruefprotokoll_2026.csv", paths)

    def test_symlinks_off_the_card_are_never_followed(self):
        if "symlink" not in self.made:
            self.skipTest("this filesystem does not support symlinks")
        result = self.importer.ingest(self.mount_for(self.card))
        paths = {f.relative_path for f in result.files}
        self.assertNotIn("escape.csv", paths)
        # And nothing that was staged contains the host's password file.
        for entry in result.files:
            staged = result.directory / "files" / entry.relative_path
            self.assertNotIn(b"root:", staged.read_bytes()[:4096])

    def test_everything_staged_stays_inside_the_staging_directory(self):
        result = self.importer.ingest(self.mount_for(self.card))
        root = (result.directory / "files").resolve()
        for entry in result.files:
            staged = (result.directory / "files" / entry.relative_path).resolve()
            self.assertTrue(str(staged).startswith(str(root)), staged)

    def test_operating_system_noise_is_filtered(self):
        result = self.importer.ingest(self.mount_for(self.card))
        paths = {f.relative_path for f in result.files}
        self.assertNotIn(".DS_Store", paths)
        self.assertNotIn("IMG_0421.jpg", paths)
        self.assertFalse(any(p.startswith("System Volume Information") for p in paths))

    def test_the_entity_bomb_is_staged_but_not_expanded(self):
        result = self.importer.ingest(self.mount_for(self.card))
        bomb = [f for f in result.files if f.relative_path == "bomb.xml"]
        self.assertTrue(bomb, "the file must still be preserved as evidence")
        self.assertFalse(bomb[0].parsed)
        self.assertIn("document type declaration", bomb[0].parse_note)

    def test_oversized_files_are_skipped_with_a_reason(self):
        big = self.card / "huge.csv"
        with open(str(big), "wb") as handle:
            handle.seek(sd_import.MAX_FILE_BYTES + 1)
            handle.write(b"\0")
        result = self.importer.ingest(self.mount_for(self.card))
        self.assertTrue(any("huge.csv" in note for note in result.skipped))
        self.assertNotIn("huge.csv", {f.relative_path for f in result.files})

    def test_an_empty_card_reports_empty_rather_than_failing(self):
        blank = self.cards / "BLANK"
        blank.mkdir()
        result = self.importer.ingest(self.mount_for(blank))
        self.assertEqual(result.status, "empty")
        self.assertIsNone(result.directory)

    def test_a_vanished_card_does_not_raise(self):
        gone = Mount(mount_point=str(self.cards / "NOPE"), label="NOPE",
                     filesystem="simulated", source="test", simulated=True)
        result = self.importer.ingest(gone)
        self.assertIn(result.status, ("empty", "error"))


class TestStagingPermissions(ImporterCase):
    def test_staging_directory_is_owner_only(self):
        card = fixtures.build_benning_st_card(self.cards / "B")
        self.importer.ingest(self.mount_for(card))
        mode = self.staging.stat().st_mode
        self.assertFalse(mode & (stat.S_IRWXG | stat.S_IRWXO),
                         "staged test protocols must not be world-readable")


class TestMountWatcher(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.watcher = MountWatcher(simulate_root=str(self.root), settle_polls=2)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_a_new_card_is_reported_once_after_it_settles(self):
        (self.root / "CARD").mkdir()
        self.assertEqual(self.watcher.poll(), [])       # first sight
        fresh = self.watcher.poll()                      # settled
        self.assertEqual([m.label for m in fresh], ["CARD"])
        self.assertEqual(self.watcher.poll(), [])        # not again

    def test_removing_and_reinserting_reports_it_again(self):
        card = self.root / "CARD"
        card.mkdir()
        self.watcher.poll()
        self.watcher.poll()
        card.rmdir()
        self.watcher.poll()
        card.mkdir()
        self.watcher.poll()
        self.assertEqual([m.label for m in self.watcher.poll()], ["CARD"])

    def test_rescan_forgets_what_it_has_seen(self):
        (self.root / "CARD").mkdir()
        self.watcher.poll()
        self.watcher.poll()
        self.watcher.forget(str(self.root / "CARD"))
        self.watcher.poll()
        self.assertEqual([m.label for m in self.watcher.poll()], ["CARD"])


class TestLinuxMountParsing(unittest.TestCase):
    """The Pi path, exercised on this Mac by feeding it a real mountinfo file."""

    SAMPLE = (
        "25 30 0:22 / /proc rw,nosuid,nodev,noexec,relatime shared:12 - proc proc rw\n"
        "30 1 179:2 / / rw,noatime shared:1 - ext4 /dev/mmcblk0p2 rw\n"
        "88 30 8:17 / /media/smpl/BENNING\\040ST760 ro,nosuid,nodev,relatime "
        "shared:44 - vfat /dev/sdb1 ro,uid=997\n"
        "91 30 8:33 / /media/smpl/METREL ro,relatime shared:45 - exfat /dev/sdc1 ro\n"
        "94 30 0:55 / /media/office-share rw,relatime shared:46 - cifs //nas/share rw\n"
        "97 30 8:49 / /mnt/backup rw,relatime shared:47 - ext4 /dev/sdd1 rw\n"
    )

    def setUp(self) -> None:
        self.tmp = tempfile.NamedTemporaryFile("w", suffix=".mountinfo", delete=False)
        self.tmp.write(self.SAMPLE)
        self.tmp.close()

    def tearDown(self) -> None:
        os.unlink(self.tmp.name)

    def test_only_removable_media_mounts_are_returned(self):
        mounts = _linux_mounts(("/media", "/run/media", "/mnt"), self.tmp.name)
        points = {m.mount_point for m in mounts}
        self.assertIn("/media/smpl/BENNING ST760", points)
        self.assertIn("/media/smpl/METREL", points)
        self.assertIn("/mnt/backup", points)
        # The root filesystem and the office CIFS share are not cards.
        self.assertNotIn("/", points)
        self.assertNotIn("/media/office-share", points)

    def test_octal_escapes_in_a_label_are_decoded(self):
        # A card labelled "BENNING ST760" arrives as "BENNING\040ST760".
        self.assertEqual(_unescape_mountinfo("BENNING\\040ST760"), "BENNING ST760")
        mounts = _linux_mounts(("/media",), self.tmp.name)
        labels = {m.label for m in mounts}
        self.assertIn("BENNING ST760", labels)

    def test_filesystem_and_source_are_recorded(self):
        mounts = {m.mount_point: m for m in _linux_mounts(("/media",), self.tmp.name)}
        card = mounts["/media/smpl/METREL"]
        self.assertEqual(card.filesystem, "exfat")
        self.assertEqual(card.source, "/dev/sdc1")

    def test_a_missing_mountinfo_is_not_an_error(self):
        self.assertEqual(_linux_mounts(("/media",), "/nonexistent/mountinfo"), [])


if __name__ == "__main__":
    unittest.main()
