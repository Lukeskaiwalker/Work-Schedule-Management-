"""Talking to the label printer: calibration sends and read-only queries.

Port 9100 is two-way (probe of 13.10.2026): ``~S,STATUS`` and
``^XGET,CONFIG`` answer within well under a second, without
``^XSET,IMMEDIATE,1``. Queries are an Enum, not free text — the only bytes a
read ever sends are one of these two lines. Reads never go through ``_ship``
and never pass the calibration-session check: they change nothing, so nobody's
session needs to refuse them (whether they are physically harmless is T0b).

A reply ends on its OWN terminator — the first ``nn,nnnnn`` line for STATUS,
a line of exactly ``---`` for CONFIG — or on a deadline; the printer may keep
the socket open after replying, so an idle timeout would either truncate a
slow CONFIG or wait for nothing. ``ERRORnn`` lines the printer may push
unasked (ACTIVERESPONSE, EZPL p.14) are taken out of the text and reported.
"""

from __future__ import annotations

import re
import socket
import time
from dataclasses import dataclass
from enum import Enum

from sqlalchemy.orm import Session

from app.services.werkstatt_label_errors import LabelPrinterNotConfigured, LabelPrinterUnreachable
from app.services.werkstatt_label_ezpl_policy import assert_allowed
from app.services.werkstatt_label_io_lock import printer_io_lock

QUERY_CONNECT_TIMEOUT_S = 3.0
QUERY_READ_TIMEOUT_S = 0.25
STATUS_DEADLINE_S = 2.0
CONFIG_DEADLINE_S = 4.0
QUERY_MAX_BYTES = 65536

_STATUS_LINE = re.compile(r"^\d{2},\d{5}$", re.ASCII)
_ERROR_LINE = re.compile(r"^ERROR\d{2}$", re.ASCII)
_CONTROL = re.compile(r"[\x00-\x09\x0b-\x1f\x7f]")


class PrinterQuery(Enum):
    STATUS = "~S,STATUS"
    CONFIG = "^XGET,CONFIG"


@dataclass(frozen=True)
class QueryReply:
    text: str  # latin-1 decoded, CR/LF normalised to "\n", other control chars removed
    complete: bool  # terminator seen
    errors_seen: tuple[str, ...]  # e.g. ("ERROR02",)


def _is_terminator(query: PrinterQuery, line: str) -> bool:
    if query is PrinterQuery.STATUS:
        return bool(_STATUS_LINE.match(line))
    return line == "---"


def _parse(raw: bytes, query: PrinterQuery, *, final: bool) -> QueryReply:
    """Decode what arrived. Only newline-terminated lines can end a reply,
    unless the connection is over (``final``): a half-received "--" of the
    "--------" line must not pass for the "---" terminator."""
    decoded = raw.decode("latin-1").replace("\r\n", "\n").replace("\r", "\n")
    pieces = decoded.split("\n")
    if not final:
        pieces = pieces[:-1]  # the unterminated tail is still arriving
    kept: list[str] = []
    errors: list[str] = []
    complete = False
    for piece in pieces:
        line = _CONTROL.sub("", piece)
        if _ERROR_LINE.match(line):
            errors.append(line)
            continue
        if not kept and not line:
            continue
        kept.append(line)
        if _is_terminator(query, line):
            complete = True
            break
    while kept and not kept[-1]:
        kept.pop()
    return QueryReply("\n".join(kept), complete, tuple(errors))


def query_socket(host: str, port: int, query: PrinterQuery) -> QueryReply:
    """Send one query line and read its reply until terminator or deadline."""
    if not isinstance(query, PrinterQuery):
        raise ValueError(f"not a printer query: {query!r}")
    deadline = time.monotonic() + (STATUS_DEADLINE_S if query is PrinterQuery.STATUS else CONFIG_DEADLINE_S)
    try:
        conn = socket.create_connection((host, port), timeout=QUERY_CONNECT_TIMEOUT_S)
    except OSError as exc:
        raise LabelPrinterUnreachable(f"{host}:{port}") from exc
    raw = b""
    with conn:
        try:
            conn.sendall(query.value.encode("ascii") + b"\r\n")
        except OSError as exc:
            raise LabelPrinterUnreachable(f"{host}:{port}") from exc
        conn.settimeout(QUERY_READ_TIMEOUT_S)
        while time.monotonic() < deadline and len(raw) < QUERY_MAX_BYTES:
            try:
                chunk = conn.recv(4096)
            except socket.timeout:
                continue
            except OSError:
                break
            if not chunk:
                break
            raw += chunk
            if _parse(raw[:QUERY_MAX_BYTES], query, final=False).complete:
                break  # we close; the printer may keep the socket open
    return _parse(raw[:QUERY_MAX_BYTES], query, final=True)


def query_printer(db: Session, query: PrinterQuery) -> QueryReply:
    """Query the configured printer under the I/O lock; no session check."""
    from app.services.werkstatt_labels import printer_address

    address = printer_address(db)
    if address is None:
        raise LabelPrinterNotConfigured()
    host, port = address
    with printer_io_lock():
        return query_socket(host, port, query)


def send_lines(db: Session, lines: list[str], *, session_id: str | None) -> str:
    """A calibration send: allow-list check, one payload, one connection."""
    from app.services import werkstatt_labels as wl

    assert_allowed(lines)
    payload = ("\r\n".join(lines) + "\r\n").encode("utf-8")
    return wl._ship(db, payload, session_id=session_id)
