"""What is on the card, and how much of it we honestly claim to understand.

This module draws one line very deliberately, and the line is between
*structure* and *meaning*:

**Structure** is safe to read. A CSV has a delimiter, a header row and data
rows; an XML file has elements with tags and attributes; a ZIP has entries.
Reading those and passing them on under their original names cannot corrupt
anything, because nothing has been interpreted.

**Meaning** is not safe to guess. Deciding that ``MID`` 20 is a protective
conductor continuity test, that ``RISO-1 (MOhm)`` should become SMPL's
``insulation_mohm``, or that ``0,52`` is a decimal comma rather than a
thousands separator - those are claims about a document that has to survive a
DGUV V3 audit. A wrong one produces a record that *looks* right and gets
believed. So they are not made here.

What was actually established
-----------------------------
Researched 2026-08-26 against manufacturer manuals and one verified file
inspection. The findings that shaped the rules below:

* **Metrel ``.padfx`` is a ZIP** containing ``DataSource.padf`` (XML, UTF-8
  with BOM) plus an ``a_picts/`` attachment directory. Confirmed by unpacking
  Metrel's own SDK sample, not inferred. The XML is ``<Database><Data><SO>``
  structure objects holding ``<Ms><M>`` measurements.
* **The numeric dictionaries inside that XML are undocumented.** ``MID``,
  ``<P Id=>``, ``<L Id=>``, ``<R Id=>`` and ``<S>`` are opaque integers with
  no published meaning; the one open-source mapping in existence covers 7 of
  the 31 ``MID`` values present in Metrel's own sample file. **This is the
  single reason no Metrel measurement is semantically decoded here.**
* **Metrel cards use directory names, not extensions**: ``WORKSPACES``,
  ``EXPORTS``, ``Root\\__MOS__\\AT``. The extension of the files *inside*
  ``EXPORTS`` is documented nowhere in the MI 3152, MI 3155 or MI 3325
  manuals, so those files are recognised by content and location instead.
* **Benning ST is a completely different world from Benning IT.** The ST
  appliance testers (ST 750/755/760) put a database at the *root* of the card
  - ``.sdf`` for the ST 750, ``.db`` for the ST 755/760 - plus a ``Backups``
  folder of ``<name>_Backup.NNN`` ring-buffer copies. The IT installation
  testers are rebadged Metrel and write ``.padfx``.
* **The container format of Benning's ``.db``/``.sdf`` is unconfirmed.**
  SQLite is plausible for ``.db`` and SQL Server Compact for ``.sdf``, but no
  authoritative source says so, so the file is staged and its magic bytes are
  *reported* rather than a format being asserted.
* **Benning PC-Win exports XML**, and any "Benning CSV" in the wild is an
  Excel round-trip of it - semicolon-delimited, German decimal commas. The
  column set and order **differ per instrument model**, so the header row is
  always sniffed and never assumed.
* **There is no cross-vendor DGUV V3 interchange format.** Every integration
  in this space is a per-vendor adapter. Nothing here pretends otherwise.

Recognition confidence
----------------------
``high``   the bytes themselves identify it (ZIP magic plus a member we know,
           an XML root element matched literally)
``medium`` extension or location plus a corroborating signal
``low``    extension only - it is a CSV, but so is everything
``none``   staged because it sits among files that were recognised

Adding a vendor is adding a row to :data:`RULES`, not writing code.
"""

from __future__ import annotations

import re
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Optional, Sequence, Tuple

import sd_parsers
from sd_types import ParseOutcome

__all__ = [
    "FormatMatch",
    "VolumeMatch",
    "ParseOutcome",
    "classify",
    "classify_volume",
    "parse",
    "FORMAT_IGNORE",
    "CONFIDENCE_NOTE",
]

FORMAT_IGNORE = "ignore"
FORMAT_UNKNOWN = "unknown"

CONFIDENCE_NOTE = (
    "Files are copied byte-for-byte and hashed before any parsing is attempted. "
    "Parsing extracts structure only - delimiter, header names, element names, "
    "container entries - and never renames, converts, or interprets a vendor "
    "field. In particular no Metrel MID/Id code and no Benning column name is "
    "mapped to a meaning, because those dictionaries are not published. A "
    "record in parsed.json carries the instrument's own names; deciding what "
    "they mean is a job for SMPL and a human with the manufacturer's "
    "documentation, not for the station."
)

# Magic numbers. These are the load-bearing checks - the research found that a
# Metrel card's export files have no documented extension at all, so content
# has to be able to answer on its own.
ZIP_MAGIC = b"PK\x03\x04"
SQLITE_MAGIC = b"SQLite format 3\x00"
PDF_MAGIC = b"%PDF"

# Which members make a ZIP a Metrel document is a fact about the *format*, so
# it is defined once, next to the code that reads it.
METREL_ZIP_MEMBERS = sd_parsers.METREL_ZIP_MEMBERS

# Extensions that are definitely not test evidence. Skipped before hashing so a
# card with a firmware image or a photo folder cannot exhaust the size budget.
IGNORED_SUFFIXES = frozenset(
    {".jpg", ".jpeg", ".png", ".gif", ".bmp", ".tif", ".tiff", ".mp4", ".mov",
     ".avi", ".wav", ".mp3", ".exe", ".dll", ".sys", ".img", ".iso", ".tmp",
     ".swp", ".bak~", ".ini"}
)

# Worth staging even when we cannot say what wrote it.
CANDIDATE_SUFFIXES = frozenset(
    {".csv", ".txt", ".xml", ".json", ".dat", ".tsv", ".pdf", ".htm", ".html",
     ".padfx", ".padf", ".atmpx", ".rtmpl", ".eul", ".xls", ".xlsx", ".mdb",
     ".db", ".sdf", ".sqlite", ".secu", ".etc", ".etcbak", ".fdb", ".prt",
     ".pro", ".zip"}
)

# Benning ST ring-buffer backups: "Test_Backup.001" ... "Test_Backup.005".
BENNING_BACKUP_RE = re.compile(r"(?i)_backup\.\d{1,3}$")

# Directory names that identify the instrument behind a whole card.
METREL_CARD_DIRS = frozenset({"workspaces", "exports", "__mos__"})
BENNING_ST_CARD_DIRS = frozenset({"backups"})


@dataclass(frozen=True)
class FormatMatch:
    format_id: str
    vendor: str = ""
    confidence: str = "none"
    reason: str = ""
    model_hint: str = ""


@dataclass(frozen=True)
class VolumeMatch:
    vendor: str
    model_hint: str
    confidence: str
    reason: str = ""


@dataclass(frozen=True)
class Rule:
    """One recognition rule. Matched top to bottom, most specific first."""

    format_id: str
    vendor: str
    confidence: str
    reason: str
    suffixes: Tuple[str, ...] = ()
    magic: bytes = b""
    text_pattern: Optional[str] = None
    name_pattern: Optional[str] = None
    model_hint: str = ""
    parser: str = ""


RULES: Tuple[Rule, ...] = (
    # -- Metrel / Benning-IT documents, identified by their bytes ----------
    # The extension is a hint; the ZIP magic is the evidence. An export file
    # from a Metrel card may have no extension we know, so magic comes first
    # and the suffix list is empty on purpose.
    Rule("metrel-padfx", "metrel", "high",
         "ZIP container in Metrel ES Manager's .padfx shape "
         "(entries listed; DataSource.padf structure extracted, not interpreted)",
         suffixes=(".padfx", ".padf", ".atmpx"), magic=ZIP_MAGIC, parser="metrel-zip"),
    Rule("metrel-container", "metrel", "medium",
         "ZIP container carrying a Metrel payload member",
         magic=ZIP_MAGIC, parser="metrel-zip"),
    Rule("metrel-document-opaque", "metrel", "medium",
         "Metrel/Benning-IT document extension, but not a ZIP - staged verbatim",
         suffixes=(".padfx", ".padf", ".atmpx", ".rtmpl")),
    Rule("metrel-eul", "metrel", "medium",
         "Metrel EuroLink PRO structure file (also written by Benning IT 130) "
         "- format not published, staged verbatim",
         suffixes=(".eul",)),

    # -- Benning ST appliance testers --------------------------------------
    # The manual is explicit: ST 750/750A write .sdf, ST 755/760(+) write .db,
    # always at the root of the card. Neither container format is confirmed,
    # so neither is opened - the magic bytes are reported instead.
    Rule("benning-st-backup", "benning", "high",
         "Benning ST ring-buffer backup (<name>_Backup.NNN) - staged verbatim, never opened",
         name_pattern=r"(?i)_backup\.\d{1,3}$"),
    Rule("benning-st-db", "benning", "high",
         "Benning ST 755/760 database (.db at the card root) - staged verbatim, never opened",
         suffixes=(".db",), model_hint="ST 755/760 family"),
    Rule("benning-st-sdf", "benning", "high",
         "Benning ST 750 database (.sdf) - staged verbatim, never opened",
         suffixes=(".sdf",), model_hint="ST 750 family"),

    # -- XML, vendor named in the opening bytes ----------------------------
    Rule("metrel-xml", "metrel", "high",
         "XML naming Metrel in its opening bytes",
         suffixes=(".xml",), text_pattern=r"(?i)metrel|eurotest|multiservicer|omegagt|deltagt",
         parser="xml"),
    Rule("benning-xml", "benning", "high",
         "XML naming BENNING in its opening bytes - the shape PC-Win ST exports",
         suffixes=(".xml", ".secu"), text_pattern=r"(?i)benning|pc-?win",
         parser="xml"),
    Rule("xml-generic", "", "low",
         "XML from an unidentified instrument - structure extracted, nothing interpreted",
         suffixes=(".xml", ".secu"), parser="xml"),

    # -- Delimited text ----------------------------------------------------
    # Any "Benning CSV" is an Excel re-save of the XML export, and its columns
    # differ per model, so the header is sniffed rather than assumed.
    Rule("benning-delimited", "benning", "medium",
         "delimited text with Benning's export vocabulary in its header "
         "(column layout varies per model, so the header row is read, not assumed)",
         suffixes=(".csv", ".txt", ".dat"),
         text_pattern=r"(?i)benning|Pr(ü|ue)fling|Sichtpr(ü|ue)fung|RISO-\d|Schutzleiterwiderstand",
         parser="delimited"),
    Rule("metrel-delimited", "metrel", "medium",
         "delimited text naming Metrel in its header",
         suffixes=(".csv", ".txt", ".dat"), text_pattern=r"(?i)metrel|eurotest|MI\s?3\d{3}",
         parser="delimited"),
    Rule("delimited-generic", "", "low",
         "delimited text from an unidentified instrument - header and rows kept verbatim",
         suffixes=(".csv", ".tsv"), parser="delimited"),
    Rule("text-generic", "", "low",
         "plain text of unknown origin - staged verbatim, not parsed",
         suffixes=(".txt", ".dat", ".prt", ".pro")),

    # -- Everything else ---------------------------------------------------
    Rule("sqlite-database", "", "medium",
         "SQLite database (magic bytes) - staged verbatim, never opened",
         magic=SQLITE_MAGIC),
    Rule("pdf-protocol", "", "medium",
         "PDF protocol printed by the instrument - staged verbatim",
         magic=PDF_MAGIC),
    Rule("spreadsheet", "", "medium",
         "spreadsheet - PC-Win ST's import shape; entries listed, contents not read",
         suffixes=(".xlsx",), magic=ZIP_MAGIC, parser="zip"),
    Rule("database-file", "", "medium",
         "database file (Access/Firebird/IZYTRONIQ) - staged verbatim, never opened",
         suffixes=(".mdb", ".fdb", ".sqlite", ".etcbak", ".etc")),
    Rule("zip-generic", "", "medium",
         "ZIP archive - entries listed, contents staged verbatim",
         suffixes=(".zip", ".xls"), magic=ZIP_MAGIC, parser="zip"),
    Rule("json-generic", "", "low", "JSON of unknown origin - staged verbatim",
         suffixes=(".json",)),
    Rule("html-protocol", "", "low", "HTML protocol - staged verbatim",
         suffixes=(".htm", ".html")),
    Rule("office-legacy", "", "low", "legacy Office document - staged verbatim",
         suffixes=(".xls",)),
)

# Volume-label hints. Weaker than the directory layout below, but free.
VOLUME_LABEL_HINTS = (
    (re.compile(r"(?i)benning"), "benning", ""),
    (re.compile(r"(?i)\bst\s?7[56]\d\b"), "benning", "ST 750/760 family"),
    (re.compile(r"(?i)metrel"), "metrel", ""),
    (re.compile(r"(?i)eurotest"), "metrel", "EurotestXC/XD family"),
    (re.compile(r"(?i)\bmi\s?3\d{3}\b"), "metrel", ""),
    (re.compile(r"(?i)multiservicer"), "metrel", "MultiservicerXD family"),
    (re.compile(r"(?i)omegagt|deltagt"), "metrel", "OmegaGT/DeltaGT family"),
)


# --------------------------------------------------------------------------
# Classification
# --------------------------------------------------------------------------


def classify(path: Path, sample: bytes = b"") -> FormatMatch:
    """Decide what one file is, from its name and its first few kilobytes."""
    name = Path(path).name
    suffix = Path(path).suffix.lower()

    # A Benning backup's "extension" is a sequence number, so the name rule has
    # to win before the suffix logic ever looks at ".001".
    if BENNING_BACKUP_RE.search(name):
        return _match(_rule("benning-st-backup"))

    if suffix in IGNORED_SUFFIXES:
        return FormatMatch(FORMAT_IGNORE, reason="not test evidence (%s)" % suffix)

    text = _decode_sample(sample)

    for rule in RULES:
        if rule.name_pattern and not re.search(rule.name_pattern, name):
            continue
        # An empty suffix list means "match on content alone" - that is how a
        # Metrel export with an undocumented extension gets recognised.
        if rule.suffixes and suffix not in rule.suffixes:
            continue
        if rule.magic and not sample.startswith(rule.magic):
            continue
        if rule.text_pattern and not re.search(rule.text_pattern, text):
            continue
        if rule.format_id == "metrel-container" and not _looks_like_metrel_zip(path):
            continue
        return _match(rule)

    if suffix in CANDIDATE_SUFFIXES:
        return FormatMatch(FORMAT_UNKNOWN, confidence="none",
                           reason="recognised extension, unrecognised content")
    # Instruments invent extensions. A filename that reads like a protocol is
    # worth keeping whatever it is called.
    if re.search(r"(?i)prot|pruef|pr[uü]f|test|messung|report|dguv|vde|mess", name):
        return FormatMatch(FORMAT_UNKNOWN, confidence="none",
                           reason="filename suggests a test protocol")
    if not suffix and _looks_textual(sample):
        return FormatMatch(FORMAT_UNKNOWN, confidence="none",
                           reason="extensionless text - staged in case it is a protocol")
    return FormatMatch(FORMAT_IGNORE, reason="unrecognised file")


def _match(rule: Rule) -> FormatMatch:
    return FormatMatch(
        format_id=rule.format_id, vendor=rule.vendor, confidence=rule.confidence,
        reason=rule.reason, model_hint=rule.model_hint,
    )


def _rule(format_id: str) -> Rule:
    for rule in RULES:
        if rule.format_id == format_id:
            return rule
    raise KeyError(format_id)


def _parser_for(format_id: str) -> str:
    for rule in RULES:
        if rule.format_id == format_id:
            return rule.parser
    return ""


def _looks_like_metrel_zip(path: Path) -> bool:
    """Peek at a ZIP's member list for a Metrel payload. Central directory only."""
    try:
        if not zipfile.is_zipfile(str(path)):
            return False
        with zipfile.ZipFile(str(path)) as archive:
            names = [n.rsplit("/", 1)[-1].lower() for n in archive.namelist()[:200]]
    except Exception:  # noqa: BLE001 - a truncated card must not raise here
        return False
    return any(member.lower() in names for member in METREL_ZIP_MEMBERS)


def classify_volume(label: str, format_ids: Sequence[str],
                    top_level_dirs: Sequence[str] = ()) -> VolumeMatch:
    """Name the instrument behind a whole card.

    Directory layout is checked before anything else because it is the
    strongest signal available: Metrel's manuals specify ``WORKSPACES`` /
    ``EXPORTS`` / ``__MOS__`` by name, and a Benning ST card is a database at
    the root next to a ``Backups`` folder. Both beat a volume label, which is
    whatever the last person to format the card typed.
    """
    dirs = {str(d).strip().lower() for d in top_level_dirs}
    formats = list(format_ids)

    if dirs & METREL_CARD_DIRS:
        return VolumeMatch(
            "metrel", "", "high",
            "card carries Metrel's documented directory layout (%s)"
            % ", ".join(sorted(dirs & METREL_CARD_DIRS)),
        )
    if dirs & BENNING_ST_CARD_DIRS and any(
        f in ("benning-st-db", "benning-st-sdf", "benning-st-backup") for f in formats
    ):
        hint = "ST 750 family" if "benning-st-sdf" in formats else "ST 755/760 family"
        return VolumeMatch(
            "benning", hint, "high",
            "database at the card root beside a Backups folder - the Benning ST layout",
        )

    for pattern, vendor, hint in VOLUME_LABEL_HINTS:
        if pattern.search(label or ""):
            return VolumeMatch(vendor, hint, "medium", "volume label names the vendor")

    vendors: Dict[str, int] = {}
    best = "none"
    hint = ""
    for format_id in formats:
        for rule in RULES:
            if rule.format_id != format_id or not rule.vendor:
                continue
            vendors[rule.vendor] = vendors.get(rule.vendor, 0) + 1
            best = _stronger(best, rule.confidence)
            hint = hint or rule.model_hint
    if len(vendors) == 1:
        return VolumeMatch(next(iter(vendors)), hint, best, "inferred from the file formats found")
    if len(vendors) > 1:
        # Two vendors on one card is possible - somebody reuses the card - and
        # it means the import must not be labelled as either of them.
        return VolumeMatch("mixed", "", "low",
                           "files from more than one vendor: %s" % ", ".join(sorted(vendors)))
    return VolumeMatch("", "", "none", "no vendor signal on this card")


_CONFIDENCE_ORDER = {"none": 0, "low": 1, "medium": 2, "high": 3}


def _stronger(left: str, right: str) -> str:
    return left if _CONFIDENCE_ORDER.get(left, 0) >= _CONFIDENCE_ORDER.get(right, 0) else right


def _looks_textual(sample: bytes) -> bool:
    if not sample:
        return False
    head = sample[:1024]
    if b"\x00" in head:
        return False
    printable = sum(1 for byte in head if 9 <= byte <= 13 or 32 <= byte < 127 or byte >= 160)
    return printable / max(1, len(head)) > 0.85


def _decode_sample(sample: bytes) -> str:
    for encoding in ("utf-8-sig", "cp1252", "latin-1"):
        try:
            return sample.decode(encoding)
        except UnicodeDecodeError:
            continue
    return ""


# --------------------------------------------------------------------------
# Parsing: dispatch only. The parsers themselves live in sd_parsers.
# --------------------------------------------------------------------------


def parse(format_id: str, path: Path) -> Optional[ParseOutcome]:
    """Extract structure from a staged file, or ``None`` if we do not parse it.

    ``None`` and a failed parse are both fine outcomes - the raw file is
    already staged and hashed by the time this runs, so the worst case is an
    import marked "passthrough" with the evidence intact.
    """
    kind = _parser_for(format_id)
    if not kind:
        return None
    handler = {
        "delimited": sd_parsers.parse_delimited,
        "xml": sd_parsers.parse_xml_file,
        "zip": sd_parsers.parse_zip,
        "metrel-zip": sd_parsers.parse_metrel_zip,
    }.get(kind)
    if handler is None:
        return None
    try:
        return handler(path)
    except Exception as exc:  # noqa: BLE001 - a malformed card must not stop an import
        return ParseOutcome(False, note="%s: %s" % (type(exc).__name__, exc))
