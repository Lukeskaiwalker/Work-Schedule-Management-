"""Synthetic SD cards, built to match what the manuals actually describe.

There is no Benning ST 760 and no Metrel MI 3152 on this desk, so the next
best thing is a card whose *shape* is taken from the manufacturers' own
documentation rather than from imagination. Each builder below cites what it
is imitating, and where the documentation ran out the fixture says so instead
of inventing detail.

These are also what ``--sd-simulate`` points at in the office: build a card
into a directory, point the agent at its parent, and the whole import path
runs with no hardware involved.

Deliberate non-goals
--------------------
* The Benning ``.db`` fixture carries a SQLite header because that is the
  *hypothesis* worth testing against - the agent must stage it without
  opening it either way, and the test asserts exactly that.
* The Metrel ``DataSource.padf`` uses real element names from Metrel's own SDK
  sample, with the opaque numeric codes left opaque. If a test ever starts
  asserting that ``MID`` 20 means something, that test is wrong.
"""

from __future__ import annotations

import os
import zipfile
from pathlib import Path
from typing import Dict

# --------------------------------------------------------------------------
# Benning ST 755/760: a database at the card root plus a Backups ring buffer
# --------------------------------------------------------------------------

SQLITE_HEADER = b"SQLite format 3\x00"


def _sqlite_like(payload: bytes) -> bytes:
    """Something that starts like a SQLite file and is otherwise opaque.

    A real ST 760 database is a real database; what matters for the agent is
    only that it is copied and never opened, so the fixture is the header plus
    filler rather than a genuine schema.
    """
    return SQLITE_HEADER + b"\x00" * 16 + payload


def build_benning_st_card(root: Path) -> Path:
    """The layout the PC-Win ST 750-760 manual describes.

    "Die Datenbank darf sich nicht in einem Unterordner befinden" - the
    database sits at the root - and "Die Datenbanksicherungen befinden sich
    auf der eingesteckten SD-Karte im Dateiordner 'Backups'" with names of the
    form ``Test_Backup.001``.
    """
    card = Path(root)
    card.mkdir(parents=True, exist_ok=True)
    (card / "Test.db").write_bytes(_sqlite_like(b"BENNING ST 760 device database"))
    backups = card / "Backups"
    backups.mkdir(exist_ok=True)
    for index in (1, 2, 3):
        (backups / ("Test_Backup.%03d" % index)).write_bytes(
            _sqlite_like(b"backup generation %d" % index)
        )
    return card


def build_benning_st750_card(root: Path) -> Path:
    """ST 750 writes ``.sdf`` where the ST 755/760 write ``.db``."""
    card = Path(root)
    card.mkdir(parents=True, exist_ok=True)
    (card / "Pruefungen.sdf").write_bytes(b"\x00\x01ST750 SQL CE database\x00")
    return card


# --------------------------------------------------------------------------
# Benning PC-Win ST export: XML, and the Excel round-trip of it
# --------------------------------------------------------------------------

BENNING_XML = """<?xml version="1.0" encoding="UTF-8"?>
<Pruefprotokoll erzeugtVon="BENNING PC-Win ST 750-760" version="1.9">
  <Pruefling>
    <ID>BT-00412</ID>
    <Name>Bohrhammer</Name>
    <Seriennummer>SN-99231</Seriennummer>
    <Pruefdatum>12.08.2026</Pruefdatum>
    <Gesamtpruefung_bestanden>ja</Gesamtpruefung_bestanden>
    <RPE_Ohm>0,08</RPE_Ohm>
    <RISO_1_MOhm>&gt;299</RISO_1_MOhm>
    <IPE_mA>0,21</IPE_mA>
  </Pruefling>
  <Pruefling>
    <ID>BT-00413</ID>
    <Name>Verlaengerungsleitung 10m</Name>
    <Seriennummer>SN-99232</Seriennummer>
    <Pruefdatum>12.08.2026</Pruefdatum>
    <Gesamtpruefung_bestanden>nein</Gesamtpruefung_bestanden>
    <RPE_Ohm>0,52</RPE_Ohm>
    <RISO_1_MOhm>1,2</RISO_1_MOhm>
    <IPE_mA>0,04</IPE_mA>
  </Pruefling>
</Pruefprotokoll>
"""

# The column names come from third-party documentation of Benning's export
# (Wartungsplaner integration guide, ST 750 layout). They are reproduced here
# only so the header-sniffing test has something realistic to sniff - the agent
# itself never matches on them. The ST 760 layout starts "Kunde;Abteilung;
# Pruefling;ID" instead, which is exactly why nothing is read by position.
BENNING_CSV = (
    "Prüfling;Abteilung;ID;Seriennummer;Prüfdatum;"
    "Gesamtprüfung bestanden;RPE (Ohm) Schutzleiterwiderstand;"
    "RISO-1 (MOhm) Isolationswiderstand;IPE (mA) Schutzleiterstrom\r\n"
    "Bohrhammer;Werkstatt;BT-00412;SN-99231;12.08.2026;ja;0,08;>299;0,21\r\n"
    "Verlängerungsleitung 10m;Werkstatt;BT-00413;SN-99232;12.08.2026;"
    "nein;0,52;1,2;0,04\r\n"
)

# The ST 760 layout: same data, different column order and extra columns. Used
# to prove the parser reads the header rather than assuming a position.
BENNING_CSV_ST760 = (
    "Kunde;Abteilung;Prüfling;ID;Seriennummer;Prüfdatum;"
    "Gesamtprüfung bestanden;RISO-4 (MOhm);PRCD-Test bestanden\r\n"
    "Muster GmbH;Werkstatt;Bohrhammer;BT-00412;SN-99231;12.08.2026;ja;;n.a.\r\n"
)


def build_benning_pcwin_export(root: Path) -> Path:
    """What PC-Win ST puts on a stick: XML, plus the CSV people make from it."""
    card = Path(root)
    card.mkdir(parents=True, exist_ok=True)
    (card / "Pruefprotokoll.xml").write_text(BENNING_XML, encoding="utf-8")
    # Excel writes cp1252 with a semicolon delimiter in a German locale.
    (card / "Export_ST750.csv").write_bytes(BENNING_CSV.encode("cp1252"))
    (card / "Export_ST760.csv").write_bytes(BENNING_CSV_ST760.encode("cp1252"))
    return card


# --------------------------------------------------------------------------
# Metrel: WORKSPACES / EXPORTS, and a .padfx that really is a ZIP
# --------------------------------------------------------------------------

# Element names, nesting and value shapes are taken from Metrel's own SDK
# sample (Sample.padfx -> DataSource.padf). The numeric codes are reproduced
# as opaque integers because that is exactly what they are: no public
# dictionary maps MID / P Id / L Id / R Id / S to a meaning.
DATASOURCE_PADF = (
    '<?xml version="1.0" encoding="utf-8"?>\r\n'
    '<Database Id="f7d4">\r\n'
    "  <Header>\r\n"
    "    <RegionId>1</RegionId>\r\n"
    "    <ChildRegionId>0</ChildRegionId>\r\n"
    "    <FileCreator>PC</FileCreator>\r\n"
    "    <AssemblyVersion>2.4.14.0</AssemblyVersion>\r\n"
    "    <FileOwner>METREL</FileOwner>\r\n"
    "    <DatabaseVersion>13</DatabaseVersion>\r\n"
    "    <LastUsedDatabaseVersion>13</LastUsedDatabaseVersion>\r\n"
    "    <LastSavedDate>12.08.2026 09:28:22</LastSavedDate>\r\n"
    "  </Header>\r\n"
    "  <Data>\r\n"
    '    <SO Id="P00000000000000000000000000000001">\r\n'
    "      <OID>1</OID>\r\n"
    "      <N>Muster GmbH</N>\r\n"
    "      <PID>-1</PID>\r\n"
    "      <C>Kundenobjekt</C>\r\n"
    "    </SO>\r\n"
    '    <SO Id="P00000000000000000000000000000002">\r\n'
    "      <OID>2</OID>\r\n"
    "      <N>Verteilung UV1</N>\r\n"
    "      <PID>1</PID>\r\n"
    "      <Ms>\r\n"
    '        <M Id="P00000000000000000000000000000101">\r\n'
    "          <MID>20</MID>\r\n"
    '          <MPs><MP Id="1"><V>12.08.2026 09:28:22</V></MP></MPs>\r\n'
    '          <Ls><L Id="16"><V>3.5 Percent</V></L></Ls>\r\n'
    '          <Rs><R Id="1"><V>35 kOhm</V></R></Rs>\r\n'
    "          <S>5</S>\r\n"
    "        </M>\r\n"
    "      </Ms>\r\n"
    "    </SO>\r\n"
    '    <SO Id="P00000000000000000000000000000003">\r\n'
    "      <OID>3</OID>\r\n"
    "      <N>Steckdose 3</N>\r\n"
    "      <PID>2</PID>\r\n"
    "      <Ms>\r\n"
    '        <M Id="P00000000000000000000000000000102">\r\n'
    "          <MID>113</MID>\r\n"
    '          <MPs><MP Id="1"><V>12.08.2026 09:31:04</V></MP></MPs>\r\n'
    '          <Rs><R Id="1"><V>0.035 s</V></R></Rs>\r\n'
    "          <S>1</S>\r\n"
    "        </M>\r\n"
    "      </Ms>\r\n"
    "    </SO>\r\n"
    "  </Data>\r\n"
    "</Database>\r\n"
)


def build_padfx(path: Path) -> Path:
    """A ``.padfx``: a ZIP of ``DataSource.padf`` plus an ``a_picts`` folder.

    Verified against Metrel's published SDK sample, which contains exactly
    those two members. The XML payload is UTF-8 with a BOM and CRLF endings.
    """
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(str(path), "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("DataSource.padf", DATASOURCE_PADF.encode("utf-8-sig"))
        archive.writestr("a_picts/verteilung.png", b"\x89PNG\r\n\x1a\n" + b"\x00" * 32)
    return path


def build_metrel_card(root: Path, *, export_name: str = "Auftrag_4711.padfx") -> Path:
    """The directory layout the MI 3152 / MI 3155 / MI 3325 manuals specify.

    ``WORKSPACES`` and ``EXPORTS`` are named in all three manuals. The
    *extension* of the files inside ``EXPORTS`` is not documented anywhere, so
    the second export here deliberately has no extension at all - the agent
    must recognise it by its ZIP magic and its ``DataSource.padf`` member.
    """
    card = Path(root)
    (card / "WORKSPACES").mkdir(parents=True, exist_ok=True)
    (card / "EXPORTS").mkdir(parents=True, exist_ok=True)
    build_padfx(card / "EXPORTS" / export_name)
    build_padfx(card / "EXPORTS" / "AUFTRAG4712")  # no extension, on purpose
    (card / "WORKSPACES" / "readme.txt").write_text(
        "Metrel workspace directory\r\n", encoding="cp1252"
    )
    return card


# --------------------------------------------------------------------------
# A card designed to break the importer
# --------------------------------------------------------------------------

BILLION_LAUGHS = """<?xml version="1.0"?>
<!DOCTYPE lolz [
 <!ENTITY lol "lol">
 <!ENTITY lol1 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">
 <!ENTITY lol2 "&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;">
 <!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">
 <!ENTITY lol4 "&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;">
 <!ENTITY lol5 "&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;">
 <!ENTITY lol6 "&lol5;&lol5;&lol5;&lol5;&lol5;&lol5;&lol5;&lol5;&lol5;&lol5;">
 <!ENTITY lol7 "&lol6;&lol6;&lol6;&lol6;&lol6;&lol6;&lol6;&lol6;&lol6;&lol6;">
 <!ENTITY lol8 "&lol7;&lol7;&lol7;&lol7;&lol7;&lol7;&lol7;&lol7;&lol7;&lol7;">
 <!ENTITY lol9 "&lol8;&lol8;&lol8;&lol8;&lol8;&lol8;&lol8;&lol8;&lol8;&lol8;">
]>
<lolz>&lol9;</lolz>
"""


def build_hostile_card(root: Path) -> Dict[str, Path]:
    """Everything a card should survive being handed.

    Returns the notable paths so a test can assert on them individually.
    """
    card = Path(root)
    card.mkdir(parents=True, exist_ok=True)
    made: Dict[str, Path] = {"card": card}

    bomb = card / "bomb.xml"
    bomb.write_text(BILLION_LAUGHS, encoding="utf-8")
    made["bomb"] = bomb

    # A symlink pointing off the card entirely. Following it would copy the
    # host's files into an "import" and, worse, upload them.
    escape = card / "escape.csv"
    try:
        os.symlink("/etc/passwd", str(escape))
        made["symlink"] = escape
    except (OSError, NotImplementedError):
        pass

    # A directory loop. os.walk(followlinks=False) must not spin on it.
    loop_dir = card / "loop"
    loop_dir.mkdir(exist_ok=True)
    try:
        os.symlink("..", str(loop_dir / "up"))
        made["loop"] = loop_dir / "up"
    except (OSError, NotImplementedError):
        pass

    # A filename that tries to climb out of the staging directory when joined.
    weird = card / "..evil.csv"
    weird.write_text("a;b\r\n1;2\r\n", encoding="cp1252")
    made["weird_name"] = weird

    # Noise that must be filtered before it costs a hash.
    (card / "IMG_0421.jpg").write_bytes(b"\xff\xd8\xff\xe0" + b"\x00" * 4096)
    (card / ".DS_Store").write_bytes(b"\x00" * 128)
    (card / "System Volume Information").mkdir(exist_ok=True)
    (card / "System Volume Information" / "IndexerVolumeGuid").write_bytes(b"\x00" * 64)

    # A real protocol among the junk: the import must still succeed.
    good = card / "Pruefprotokoll_2026.csv"
    good.write_bytes(BENNING_CSV.encode("cp1252"))
    made["good"] = good
    return made


# --------------------------------------------------------------------------
# One call that makes a whole tree of cards for --sd-simulate
# --------------------------------------------------------------------------


def build_all(root: Path) -> Dict[str, Path]:
    """Build every fixture card under *root*, one directory per card."""
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    cards = {
        "BENNING_ST760": build_benning_st_card(root / "BENNING_ST760"),
        "BENNING_ST750": build_benning_st750_card(root / "BENNING_ST750"),
        "PCWIN_EXPORT": build_benning_pcwin_export(root / "PCWIN_EXPORT"),
        "METREL_MI3152": build_metrel_card(root / "METREL_MI3152"),
    }
    build_hostile_card(root / "MESSY_CARD")
    cards["MESSY_CARD"] = root / "MESSY_CARD"
    return cards
