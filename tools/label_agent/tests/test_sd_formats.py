"""What the format layer claims, and - just as important - what it refuses to.

Half of these tests assert a *negative*: that no unit was converted, no column
renamed, no opaque vendor code given a meaning. Those are the tests that stop
a future change from quietly turning a passthrough into a wrong answer.
"""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

import fixtures  # noqa: E402
import sd_formats  # noqa: E402


def sniff(path: Path, size: int = 8192) -> bytes:
    with open(str(path), "rb") as handle:
        return handle.read(size)


def classify(path: Path) -> sd_formats.FormatMatch:
    return sd_formats.classify(path, sniff(path))


class TestBenningRecognition(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.card = fixtures.build_benning_st_card(Path(self.tmp.name) / "BENNING")

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_root_database_is_recognised_as_benning(self):
        match = classify(self.card / "Test.db")
        self.assertEqual(match.format_id, "benning-st-db")
        self.assertEqual(match.vendor, "benning")
        self.assertEqual(match.confidence, "high")

    def test_ring_buffer_backup_is_recognised_despite_numeric_extension(self):
        # "Test_Backup.001" has a suffix of ".001", which matches no extension
        # rule. If the name rule ever stops running first, these files - a
        # third of the evidence on a Benning card - vanish silently.
        match = classify(self.card / "Backups" / "Test_Backup.002")
        self.assertEqual(match.format_id, "benning-st-backup")
        self.assertEqual(match.vendor, "benning")

    def test_database_files_are_never_parsed(self):
        # The container format of Benning's .db is not publicly confirmed.
        # Staging it is right; opening it would be a guess.
        for name in ("Test.db", "Backups/Test_Backup.001"):
            with self.subTest(name=name):
                match = classify(self.card / name)
                self.assertIsNone(sd_formats.parse(match.format_id, self.card / name))

    def test_st750_writes_sdf_instead(self):
        card = fixtures.build_benning_st750_card(Path(self.tmp.name) / "ST750")
        match = classify(card / "Pruefungen.sdf")
        self.assertEqual(match.format_id, "benning-st-sdf")
        self.assertIn("ST 750", match.model_hint)

    def test_volume_layout_beats_everything_else(self):
        volume = sd_formats.classify_volume(
            "UNTITLED", ["benning-st-db", "benning-st-backup"], ["Backups"]
        )
        self.assertEqual(volume.vendor, "benning")
        self.assertEqual(volume.confidence, "high")


class TestMetrelRecognition(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.card = fixtures.build_metrel_card(Path(self.tmp.name) / "METREL")

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_padfx_is_recognised(self):
        match = classify(self.card / "EXPORTS" / "Auftrag_4711.padfx")
        self.assertEqual(match.format_id, "metrel-padfx")
        self.assertEqual(match.vendor, "metrel")

    def test_export_without_an_extension_is_recognised_by_content(self):
        # The manuals never state what extension the files in EXPORTS carry,
        # so recognition cannot depend on one. This is the test that keeps the
        # magic-byte path alive.
        target = self.card / "EXPORTS" / "AUFTRAG4712"
        self.assertEqual(target.suffix, "")
        match = classify(target)
        self.assertEqual(match.vendor, "metrel")
        self.assertEqual(match.format_id, "metrel-container")

    def test_card_directories_identify_the_vendor(self):
        volume = sd_formats.classify_volume("NO NAME", [], ["WORKSPACES", "EXPORTS"])
        self.assertEqual(volume.vendor, "metrel")
        self.assertEqual(volume.confidence, "high")

    def test_padfx_parse_lists_entries_and_reads_the_payload(self):
        path = self.card / "EXPORTS" / "Auftrag_4711.padfx"
        outcome = sd_formats.parse("metrel-padfx", path)
        self.assertIsNotNone(outcome)
        self.assertTrue(outcome.ok, outcome.note)

        names = {r.get("name") for r in outcome.records if r["_element"] == "zip_entry"}
        self.assertIn("DataSource.padf", names)

        structure = [r for r in outcome.records if r["_element"] == "SO"]
        self.assertEqual(len(structure), 3, "the three <SO> objects should be found")

    def test_padfx_parse_invents_no_meaning(self):
        """The whole point: vendor names survive, and nothing is decoded.

        Metrel publishes no dictionary for MID / P Id / L Id / R Id / S. If a
        future change starts translating them, this test fails - which is the
        intended outcome, because such a mapping would have to be guessed.
        """
        path = self.card / "EXPORTS" / "Auftrag_4711.padfx"
        outcome = sd_formats.parse("metrel-padfx", path)
        objects = [r for r in outcome.records if r["_element"] == "SO"]

        by_name = {r.get("N"): r for r in objects}
        self.assertIn("Verteilung UV1", by_name)
        record = by_name["Verteilung UV1"]

        # Metrel's own element names, untranslated.
        self.assertEqual(record["PID"], "1")
        self.assertEqual(record["OID"], "2")
        self.assertTrue(record["@Id"].startswith("P0000"))

        # And none of ours.
        forbidden = {
            "name", "parent_id", "insulation_resistance", "insulation_mohm",
            "measurement_type", "continuity", "passed", "result_ohm",
        }
        self.assertEqual(forbidden & set(record), set())

    def test_units_stay_inside_the_value_string(self):
        path = self.card / "EXPORTS" / "Auftrag_4711.padfx"
        outcome = sd_formats.parse("metrel-padfx", path)
        values = [str(v) for record in outcome.records for v in record.values()]
        joined = " ".join(values)
        # "35 kOhm" must not have become 35.0, 35000, or 0.035.
        self.assertIn("35 kOhm", joined)


class TestDelimitedParsing(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.card = fixtures.build_benning_pcwin_export(Path(self.tmp.name) / "PCWIN")

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_semicolon_and_cp1252_are_handled(self):
        outcome = sd_formats.parse("benning-delimited", self.card / "Export_ST750.csv")
        self.assertTrue(outcome.ok, outcome.note)
        self.assertEqual(len(outcome.records), 2)
        self.assertIn("delimiter ';'", outcome.note)
        # Umlauts survived the cp1252 round trip.
        self.assertEqual(outcome.records[1]["Prüfling"], "Verlängerungsleitung 10m")

    def test_decimal_commas_are_left_alone(self):
        # "0,52" is 0.52 ohms to a German instrument and 52 to naive float
        # parsing. The safe answer is to keep the string.
        outcome = sd_formats.parse("benning-delimited", self.card / "Export_ST750.csv")
        record = outcome.records[1]
        self.assertEqual(record["RPE (Ohm) Schutzleiterwiderstand"], "0,52")
        self.assertIsInstance(record["RISO-1 (MOhm) Isolationswiderstand"], str)
        # ">299" is an over-range marker, not a number at all.
        self.assertEqual(outcome.records[0]["RISO-1 (MOhm) Isolationswiderstand"], ">299")

    def test_column_names_are_kept_verbatim(self):
        outcome = sd_formats.parse("benning-delimited", self.card / "Export_ST750.csv")
        self.assertIn("IPE (mA) Schutzleiterstrom", outcome.records[0])

    def test_a_different_model_layout_still_parses(self):
        """Benning's column order differs per model; nothing may be positional."""
        outcome = sd_formats.parse("benning-delimited", self.card / "Export_ST760.csv")
        self.assertTrue(outcome.ok, outcome.note)
        record = outcome.records[0]
        # First column here is Kunde, not Prüfling.
        self.assertEqual(record["Kunde"], "Muster GmbH")
        self.assertEqual(record["Prüfling"], "Bohrhammer")

    def test_empty_cells_survive_as_empty_strings(self):
        outcome = sd_formats.parse("benning-delimited", self.card / "Export_ST760.csv")
        self.assertEqual(outcome.records[0]["RISO-4 (MOhm)"], "")

    def test_benning_xml_export_is_recognised_and_structured(self):
        match = classify(self.card / "Pruefprotokoll.xml")
        self.assertEqual(match.vendor, "benning")
        outcome = sd_formats.parse(match.format_id, self.card / "Pruefprotokoll.xml")
        self.assertTrue(outcome.ok, outcome.note)
        self.assertEqual(len(outcome.records), 2)
        self.assertEqual(outcome.records[0]["ID"], "BT-00412")
        # The entity-escaped ">299" came back as a plain character.
        self.assertEqual(outcome.records[0]["RISO_1_MOhm"], ">299")


class TestHostileInput(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.made = fixtures.build_hostile_card(Path(self.tmp.name) / "MESSY")

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_entity_expansion_is_refused_not_expanded(self):
        outcome = sd_formats.parse("xml-generic", self.made["bomb"])
        self.assertIsNotNone(outcome)
        self.assertFalse(outcome.ok)
        self.assertIn("document type declaration", outcome.note)

    def test_photos_are_ignored_before_they_cost_anything(self):
        match = classify(self.made["card"] / "IMG_0421.jpg")
        self.assertEqual(match.format_id, sd_formats.FORMAT_IGNORE)

    def test_truncated_container_does_not_raise(self):
        broken = self.made["card"] / "half.padfx"
        broken.write_bytes(b"PK\x03\x04" + b"\x00" * 64)
        match = classify(broken)
        outcome = sd_formats.parse(match.format_id, broken)
        if outcome is not None:
            self.assertFalse(outcome.ok)

    def test_empty_file_does_not_raise(self):
        empty = self.made["card"] / "empty.csv"
        empty.write_bytes(b"")
        outcome = sd_formats.parse("delimited-generic", empty)
        self.assertFalse(outcome.ok)


class TestUnknownInstrument(unittest.TestCase):
    """An instrument nobody has ever seen must still produce a usable import."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.card = Path(self.tmp.name) / "MYSTERY"
        self.card.mkdir(parents=True)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_unknown_vendor_csv_is_still_structured(self):
        target = self.card / "MESSUNG_0001.csv"
        target.write_text("Geraet;Wert;Einheit\r\nA1;12,3;Ohm\r\n", encoding="cp1252")
        match = classify(target)
        self.assertEqual(match.vendor, "")
        outcome = sd_formats.parse(match.format_id, target)
        self.assertTrue(outcome.ok, outcome.note)
        self.assertEqual(outcome.records[0]["Wert"], "12,3")

    def test_unknown_extension_with_a_protocol_name_is_still_staged(self):
        target = self.card / "PRUEFUNG.q7z"
        target.write_bytes(b"some proprietary payload")
        match = classify(target)
        self.assertNotEqual(match.format_id, sd_formats.FORMAT_IGNORE)
        self.assertEqual(match.confidence, "none")

    def test_volume_with_two_vendors_is_labelled_mixed(self):
        volume = sd_formats.classify_volume("CARD", ["benning-st-db", "metrel-padfx"], [])
        self.assertEqual(volume.vendor, "mixed")


if __name__ == "__main__":
    unittest.main()
