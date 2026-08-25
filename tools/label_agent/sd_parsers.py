"""Reading *structure* out of an instrument's file, and nothing more.

Split out of :mod:`sd_formats` so that recognition ("what is this file?") and
extraction ("what shape is inside it?") can be read and changed separately.
The rule they share is stated once, in sd_formats, and enforced here:

    element names, column names and values pass through exactly as the
    instrument wrote them.

Nothing in this module renames a field, converts a number, resolves a unit or
decodes a vendor code. "0,52" stays the string "0,52" because deciding that
the comma is a decimal separator is a claim about a locale nobody told us, and
Metrel's ``MID`` stays the integer 20 because no published dictionary says
what 20 means.

Every function here returns a :class:`ParseOutcome` and raises nothing that
:func:`sd_formats.parse` does not already catch. A failed parse is a normal,
safe outcome: the file it describes has already been copied and hashed.
"""

from __future__ import annotations

import csv
import io
import re
import xml.etree.ElementTree as ElementTree
import zipfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from sd_types import ParseOutcome

__all__ = ["parse_delimited", "parse_xml_file", "parse_zip", "parse_metrel_zip"]

# Members that identify a ZIP as a Metrel/Benning-IT document. Both shapes are
# real: the SDK sample carries DataSource.padf, and the one open-source parser
# in existence also handles a measData.sqlite payload.
METREL_ZIP_MEMBERS = ("DataSource.padf", "measData.sqlite")

MAX_PARSE_BYTES = 8 * 1024 * 1024
MAX_RECORDS = 5000
MAX_MEMBER_BYTES = 32 * 1024 * 1024


def _read_text(path: Path) -> Tuple[str, str]:
    raw = Path(path).read_bytes()[:MAX_PARSE_BYTES]
    return _decode_bytes(raw)


def _decode_bytes(raw: bytes) -> Tuple[str, str]:
    for encoding in ("utf-8-sig", "utf-8", "cp1252", "latin-1"):
        try:
            return raw.decode(encoding), encoding
        except UnicodeDecodeError:
            continue
    return raw.decode("latin-1", errors="replace"), "latin-1/replace"


def parse_delimited(path: Path) -> ParseOutcome:
    """Header + rows, under the vendor's own column names, verbatim.

    German instruments export semicolon-delimited far more often than
    comma-delimited, so the delimiter is sniffed rather than assumed, and
    values stay strings: turning "0,52" into a number means deciding whether
    that comma is a decimal separator, which is exactly the guess this module
    refuses to make. Benning's column layout is documented to differ between
    the ST 750, ST 755 and ST 760, so nothing is ever read by position.
    """
    text, encoding = _read_text(path)
    if not text.strip():
        return ParseOutcome(False, note="file is empty")

    lines = [line for line in text.splitlines() if line.strip()]
    if not lines:
        return ParseOutcome(False, note="file has no non-blank lines")

    delimiter = _sniff_delimiter(lines[:20])
    if delimiter is None:
        return ParseOutcome(False, note="no consistent delimiter found - staged raw")

    rows = [row for row in csv.reader(io.StringIO(text), delimiter=delimiter)
            if any(cell.strip() for cell in row)]
    if not rows:
        return ParseOutcome(False, note="no parsable rows")

    widths: Dict[int, int] = {}
    for row in rows:
        widths[len(row)] = widths.get(len(row), 0) + 1
    body_width = max(widths, key=lambda w: (widths[w], w))
    if body_width < 2:
        return ParseOutcome(False, note="single-column file - nothing to structure")

    # An instrument often writes a preamble above the header. The header is the
    # first line that has the same field count as the bulk of the file.
    header_index = next((i for i, row in enumerate(rows) if len(row) == body_width), 0)
    header = _dedupe_header([cell.strip() for cell in rows[header_index]])

    records: List[Dict[str, Any]] = []
    for row in rows[header_index + 1:]:
        if len(row) != body_width:
            continue  # a trailing summary line, not a record
        record = {header[i]: row[i].strip() for i in range(body_width)}
        if any(record.values()):
            records.append(record)
        if len(records) >= MAX_RECORDS:
            break

    if not records:
        return ParseOutcome(False, note="header found but no data rows below it")
    return ParseOutcome(
        True,
        note="delimiter %r, encoding %s, %d columns, header on line %d; column names "
             "kept verbatim and values left as strings"
             % (delimiter, encoding, body_width, header_index + 1),
        records=records,
    )


def _sniff_delimiter(lines: List[str]) -> Optional[str]:
    """The delimiter that splits the most lines into the same field count."""
    best = None
    best_score = 0
    for candidate in (";", "\t", ",", "|"):
        counts: Dict[int, int] = {}
        for line in lines:
            fields = len(line.split(candidate))
            if fields > 1:
                counts[fields] = counts.get(fields, 0) + 1
        if not counts:
            continue
        width = max(counts, key=lambda w: counts[w])
        score = counts[width] * (width - 1)
        if score > best_score:
            best_score = score
            best = candidate
    return best


def _dedupe_header(header: List[str]) -> List[str]:
    """Column names must be unique to be dict keys, without inventing meaning."""
    seen: Dict[str, int] = {}
    out: List[str] = []
    for index, name in enumerate(header):
        base = name or "column_%d" % (index + 1)
        if base in seen:
            seen[base] += 1
            base = "%s__%d" % (base, seen[base])
        else:
            seen[base] = 1
        out.append(base)
    return out


# A card is untrusted input. ``xml.etree.ElementTree`` does not fetch external
# entities (CPython 3.7.1+ disables that), but it *does* expand internal ones,
# which is the "billion laughs" amplification: a kilobyte of declarations
# becomes gigabytes of string and takes the station down with it.
#
# The usual fix is defusedxml, and adding a third dependency to an agent whose
# whole premise is "two dependencies, and it boots without either" is a worse
# trade than the alternative: refuse any document carrying a document type
# declaration at all. Entities can only be declared in a DTD or its internal
# subset, so no DOCTYPE means no amplification - and an instrument writing a
# protocol has no reason to emit one. A refused document is not a lost
# document: it is already staged and hashed, it simply stays a passthrough.
_DOCTYPE_RE = re.compile(r"<!DOCTYPE", re.IGNORECASE)


def parse_xml_file(path: Path) -> ParseOutcome:
    text, encoding = _read_text(path)
    return _parse_xml_text(text, encoding, source=Path(path).name)


def _parse_xml_text(text: str, encoding: str, *, source: str) -> ParseOutcome:
    """The repeated element that looks like the record, flattened one level.

    Tag and attribute names pass through exactly as the instrument wrote them,
    with namespace prefixes stripped only for readability. For a Metrel
    document that means records keyed ``MID``, ``@Id``, ``N``, ``PID`` - the
    vendor's own opaque names, deliberately left opaque.
    """
    if _DOCTYPE_RE.search(text):
        return ParseOutcome(
            False,
            note="document type declaration present - not expanded (entity-expansion "
                 "denial of service); the file is staged verbatim instead",
        )
    try:
        root = ElementTree.fromstring(text)
    except ElementTree.ParseError as exc:
        return ParseOutcome(False, note="%s is not well-formed XML: %s" % (source, exc))

    container, elements = _find_record_elements(root)
    if not elements:
        return ParseOutcome(False, note="no repeated element to treat as a record")

    records: List[Dict[str, Any]] = []
    for element in elements[:MAX_RECORDS]:
        record: Dict[str, Any] = {"_element": _localname(element.tag)}
        _flatten_into(record, element, prefix="")
        records.append(record)

    return ParseOutcome(
        True,
        note="%s: root <%s>, %d repeated <%s> under <%s>, encoding %s; element and "
             "attribute names kept verbatim and no code interpreted"
             % (source, _localname(root.tag), len(elements),
                _localname(elements[0].tag), container, encoding),
        records=records,
    )


# Bounds on flattening one record. A card is untrusted, and a pathological
# document should cost a truncated record, not the station's memory.
MAX_FLATTEN_DEPTH = 8
MAX_FLATTEN_KEYS = 300
MAX_VALUE_CHARS = 4096


def _flatten_into(record: Dict[str, Any], element, *, prefix: str, depth: int = 0) -> None:
    """Flatten a record element to dotted paths built from the vendor's names.

    A Metrel measurement lives four levels down - ``Ms > M > Rs > R > V`` - so
    a one-level flatten would drop every reading on the card while looking
    like it had worked. Descending fixes that without interpreting anything:
    the key is the instrument's own element names joined with dots, and the
    value is the text exactly as written, units and all ("35 kOhm" stays "35
    kOhm").

    Repeated siblings are disambiguated by their own ``Id`` attribute where
    they have one - which is how Metrel identifies them - and by position
    otherwise. A unique child is *not* suffixed, so the common path stays
    readable.
    """
    if depth >= MAX_FLATTEN_DEPTH or len(record) >= MAX_FLATTEN_KEYS:
        return

    for key, value in element.attrib.items():
        record[_join(prefix, "@" + _localname(key))] = _clip(value)

    tag_counts: Dict[str, int] = {}
    for child in element:
        tag_counts[_localname(child.tag)] = tag_counts.get(_localname(child.tag), 0) + 1

    seen: Dict[str, int] = {}
    for child in element:
        if len(record) >= MAX_FLATTEN_KEYS:
            return
        tag = _localname(child.tag)
        seen[tag] = seen.get(tag, 0) + 1
        label = tag
        if tag_counts[tag] > 1:
            marker = child.attrib.get("Id") or child.attrib.get("id") or str(seen[tag])
            label = "%s[%s]" % (tag, _clip(marker, 64))
        path = _join(prefix, label)

        text = (child.text or "").strip()
        if text:
            record[path] = _clip(text)
        elif len(child) == 0 and not child.attrib:
            record[path] = ""
        _flatten_into(record, child, prefix=path, depth=depth + 1)


def _join(prefix: str, name: str) -> str:
    if not prefix:
        return name
    if name.startswith("@"):
        return prefix + name
    return "%s.%s" % (prefix, name)


def _clip(value: str, limit: int = MAX_VALUE_CHARS) -> str:
    text = str(value)
    return text if len(text) <= limit else text[:limit] + "..."


def _find_record_elements(root) -> Tuple[str, List]:
    """The most-repeated sibling group in the tree; that is the record."""
    best_parent = ""
    best: List = []
    stack = [(root, _localname(root.tag))]
    while stack:
        node, name = stack.pop()
        groups: Dict[str, List] = {}
        for child in node:
            groups.setdefault(_localname(child.tag), []).append(child)
        for tag, group in groups.items():
            if len(group) > len(best):
                best = group
                best_parent = name
            if len(group) == 1:
                stack.append((group[0], tag))
    if len(best) < 2:
        children = list(root)
        if children:
            return _localname(root.tag), children
    return best_parent, best


def _localname(tag: str) -> str:
    if isinstance(tag, str) and tag.startswith("{"):
        return tag.split("}", 1)[1]
    return str(tag)


def _zip_entries(path: Path) -> List[Dict[str, Any]]:
    """Read a container's central directory. Nothing is decompressed."""
    entries: List[Dict[str, Any]] = []
    with zipfile.ZipFile(str(path)) as archive:
        for info in archive.infolist()[:MAX_RECORDS]:
            entries.append({
                "_element": "zip_entry",
                "name": info.filename,
                "bytes": info.file_size,
                "compressed_bytes": info.compress_size,
                "crc32": "%08x" % (info.CRC & 0xFFFFFFFF),
                "modified": "%04d-%02d-%02dT%02d:%02d:%02d" % info.date_time,
                "is_dir": info.is_dir(),
            })
    return entries


def parse_zip(path: Path) -> ParseOutcome:
    """List what a container holds. Nothing is extracted or interpreted."""
    if not zipfile.is_zipfile(str(path)):
        return ParseOutcome(False, note="extension says container, bytes say otherwise")
    entries = _zip_entries(path)
    if not entries:
        return ParseOutcome(False, note="container is empty")
    return ParseOutcome(
        True,
        note="%d container entries listed; contents not extracted or interpreted" % len(entries),
        records=entries,
    )


def parse_metrel_zip(path: Path) -> ParseOutcome:
    """A ``.padfx``: list the container, then read the XML payload's structure.

    The payload is ``DataSource.padf`` - XML with a flat ``<SO>`` list keyed by
    ``PID`` parent pointers and ``<M>`` measurements underneath. Its element
    names are extracted; its ``MID`` / ``Id`` / ``S`` codes are **not**
    decoded, because no published dictionary for them exists and the only
    open-source mapping covers a small minority of the codes Metrel's own
    sample file contains. Numbers stay numbers, and values keep their inline
    units ("35 kOhm") exactly as written.
    """
    if not zipfile.is_zipfile(str(path)):
        return ParseOutcome(False, note="extension says .padfx, bytes say otherwise")

    entries = _zip_entries(path)
    records: List[Dict[str, Any]] = list(entries)
    notes = ["%d container entries listed" % len(entries)]

    with zipfile.ZipFile(str(path)) as archive:
        payload = _find_member(archive, "DataSource.padf")
        if payload is not None:
            info = archive.getinfo(payload)
            if info.file_size > MAX_MEMBER_BYTES:
                notes.append("%s is %d bytes - too large to parse, staged verbatim"
                             % (payload, info.file_size))
            else:
                text, encoding = _decode_bytes(archive.read(payload)[:MAX_PARSE_BYTES])
                inner = _parse_xml_text(text, encoding, source=payload)
                if inner.ok:
                    for record in inner.records:
                        enriched = dict(record)
                        enriched["_container_member"] = payload
                        records.append(enriched)
                    notes.append(inner.note)
                else:
                    notes.append("%s not parsed: %s" % (payload, inner.note))
        elif _find_member(archive, "measData.sqlite") is not None:
            notes.append(
                "payload is measData.sqlite, a database - present and staged, "
                "but not opened: its schema is not published"
            )
        else:
            notes.append("no known Metrel payload member inside")

    if not records:
        return ParseOutcome(False, note="; ".join(notes))
    return ParseOutcome(True, note="; ".join(notes), records=records)


def _find_member(archive: zipfile.ZipFile, wanted: str) -> Optional[str]:
    wanted_lower = wanted.lower()
    for name in archive.namelist():
        if name.rsplit("/", 1)[-1].lower() == wanted_lower:
            return name
    return None
