"""Reading from the printer: replies end on their own terminator, reads never write.

Port 9100 answers queries on the connection a client opens and may keep it
open afterwards. What must hold: a reply ends on its terminator (the first
``nn,nnnnn`` line for STATUS, a line of exactly ``---`` for CONFIG) or a
deadline — never on an idle gap; split replies are joined; pushed
``ERRORnn`` lines are taken out and reported; a silent printer costs at most
the deadline; only the two query lines can ever be sent by a read; and one
printer connection at a time across threads.
"""

from __future__ import annotations

import threading
import time

import pytest
from fastapi.testclient import TestClient

from app.core.db import SessionLocal
from app.services import werkstatt_label_io_lock, werkstatt_label_transport
from app.services import werkstatt_labels as wl
from app.services.werkstatt_label_errors import LabelPrinterBusy, LabelPrinterIoBusy, LabelPrinterUnreachable
from app.services.werkstatt_label_printer_status import read_status
from app.services.werkstatt_label_transport import PrinterQuery, query_socket
from tests.conftest import auth_headers
from tests.fake_ezpl_printer import configure_fake


def test_split_reply_is_joined(fake_printer) -> None:
    fake_printer.split_reply = True
    reply = query_socket(fake_printer.host, fake_printer.port, PrinterQuery.CONFIG)
    assert reply.complete
    assert "^W34 ^Q97,2 ^E0" in reply.text
    status = query_socket(fake_printer.host, fake_printer.port, PrinterQuery.STATUS)
    assert status.text == "00,00000" and status.complete


def test_config_ends_on_its_terminator_although_the_socket_stays_open(fake_printer, monkeypatch) -> None:
    monkeypatch.setattr(werkstatt_label_transport, "CONFIG_DEADLINE_S", 4.0)
    started = time.monotonic()
    reply = query_socket(fake_printer.host, fake_printer.port, PrinterQuery.CONFIG)
    assert time.monotonic() - started < 1.0
    assert reply.complete
    assert reply.text.endswith("--------\n---")


def test_long_dash_line_alone_does_not_terminate() -> None:
    from app.services.werkstatt_label_transport import _parse

    reply = _parse(b"Smart Printer\r\n--------\r\n", PrinterQuery.CONFIG, final=False)
    assert reply.complete is False
    # A half-received "--------" must not pass for the "---" terminator either.
    assert _parse(b"Smart Printer\r\n---", PrinterQuery.CONFIG, final=False).complete is False


def test_pushed_errors_are_removed_and_reported(fake_printer) -> None:
    fake_printer.push_error = "ERROR02"
    reply = query_socket(fake_printer.host, fake_printer.port, PrinterQuery.STATUS)
    assert reply.text == "00,00000"
    assert reply.errors_seen == ("ERROR02",)


def test_truncated_config_is_incomplete_after_the_deadline(fake_printer) -> None:
    fake_printer.truncate_config = True
    started = time.monotonic()
    reply = query_socket(fake_printer.host, fake_printer.port, PrinterQuery.CONFIG)
    assert reply.complete is False
    assert "^W34" in reply.text
    assert time.monotonic() - started >= werkstatt_label_transport.CONFIG_DEADLINE_S - 0.05


def test_silent_printer_answers_empty_within_the_deadline(fake_printer) -> None:
    fake_printer.silent = {"STATUS"}
    started = time.monotonic()
    reply = query_socket(fake_printer.host, fake_printer.port, PrinterQuery.STATUS)
    assert reply.text == "" and reply.complete is False and reply.errors_seen == ()
    assert time.monotonic() - started < werkstatt_label_transport.STATUS_DEADLINE_S + 0.5


def test_refused_connection_is_unreachable(fake_printer) -> None:
    fake_printer.make_unreachable()
    with pytest.raises(LabelPrinterUnreachable) as raised:
        query_socket(fake_printer.host, fake_printer.port, PrinterQuery.STATUS)
    assert str(raised.value) == f"{fake_printer.host}:{fake_printer.port}"


def test_reply_is_capped_at_64_kib(monkeypatch) -> None:
    import socket as socket_module

    server = socket_module.socket()
    server.bind(("127.0.0.1", 0))
    server.listen(1)
    port = server.getsockname()[1]

    def flood() -> None:
        conn, _ = server.accept()
        conn.recv(64)
        try:
            conn.sendall(b"X" * 100_000 + b"\r\n")
        except OSError:
            pass
        time.sleep(0.5)
        conn.close()

    thread = threading.Thread(target=flood, daemon=True)
    thread.start()
    reply = query_socket("127.0.0.1", port, PrinterQuery.CONFIG)
    server.close()
    assert len(reply.text) <= werkstatt_label_transport.QUERY_MAX_BYTES
    assert reply.complete is False


def test_queries_are_an_enum_only() -> None:
    assert [query.value for query in PrinterQuery] == ["~S,STATUS", "^XGET,CONFIG"]
    with pytest.raises(ValueError):
        PrinterQuery("~V")
    with pytest.raises(ValueError):
        query_socket("127.0.0.1", 9, "~S,STATUS")  # type: ignore[arg-type]


def test_query_and_ship_from_two_threads_never_overlap(client: TestClient, admin_token: str, fake_printer) -> None:
    configure_fake(client, admin_token, fake_printer)
    fake_printer.reply_delay_s = 0.15
    errors: list[BaseException] = []

    def queries() -> None:
        try:
            with SessionLocal() as db:
                for _ in range(3):
                    werkstatt_label_transport.query_printer(db, PrinterQuery.STATUS)
        except BaseException as exc:  # noqa: BLE001 — surfaced below
            errors.append(exc)

    def ships() -> None:
        try:
            with SessionLocal() as db:
                for _ in range(3):
                    wl._ship(db, b"^W44\r\n")
        except BaseException as exc:  # noqa: BLE001
            errors.append(exc)

    threads = [threading.Thread(target=queries), threading.Thread(target=ships)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    fake_printer.wait_for_connections(6)
    assert errors == []
    assert len(fake_printer.received) == 6
    assert fake_printer.max_concurrent == 1


def test_io_lock_timeout_is_a_busy_printer(fake_printer, client: TestClient, admin_token: str, monkeypatch) -> None:
    configure_fake(client, admin_token, fake_printer)
    monkeypatch.setattr(werkstatt_label_io_lock, "IO_LOCK_TIMEOUT_S", 0.2)
    with werkstatt_label_io_lock.printer_io_lock():
        with SessionLocal() as db:
            with pytest.raises(LabelPrinterIoBusy) as raised:
                werkstatt_label_transport.query_printer(db, PrinterQuery.STATUS)
    assert isinstance(raised.value, LabelPrinterBusy)
    assert str(raised.value) == "Drucker ist gerade mit einem anderen Auftrag beschäftigt – bitte gleich erneut versuchen"


def _start_foreign_session(client: TestClient, admin_token: str) -> None:
    """Another user (the admin) holds the calibration session."""
    response = client.post(
        "/api/werkstatt/label-printer/session",
        headers=auth_headers(admin_token),
        json={"mode": "quick", "material_id": "wago-210-804"},
    )
    assert response.status_code == 200, response.text


def test_read_status_with_silent_status_sends_nothing_but_the_query(client: TestClient, admin_token: str, fake_printer) -> None:
    configure_fake(client, admin_token, fake_printer)
    _start_foreign_session(client, admin_token)
    fake_printer.silent = {"STATUS"}
    with SessionLocal() as db:
        status = read_status(db, full=True)
    fake_printer.wait_for_connections(2)
    assert status.answered is False
    assert status.code is None
    assert status.code_text == "Drucker antwortet nicht auf Abfragen"
    assert status.config is not None  # CONFIG still answered
    assert fake_printer.received == [b"~S,STATUS\r\n", b"^XGET,CONFIG\r\n"]
    assert "^XSET" not in fake_printer.received_text()


def test_get_status_passes_during_another_users_session(client: TestClient, admin_token: str, fake_printer, monkeypatch) -> None:
    from tests.label_calibration_helpers import employee_with

    configure_fake(client, admin_token, fake_printer)
    _start_foreign_session(client, admin_token)
    _, staff = employee_with(["werkstatt:manage"], "status-staff@example.com")
    response = client.get("/api/werkstatt/label-printer/status", headers=auth_headers(staff))
    assert response.status_code == 200, response.text
    assert response.json()["code"] == "00"

    monkeypatch.setattr(werkstatt_label_io_lock, "IO_LOCK_TIMEOUT_S", 0.2)
    with werkstatt_label_io_lock.printer_io_lock():
        busy = client.get("/api/werkstatt/label-printer/status", headers=auth_headers(staff))
    assert busy.status_code == 409, busy.text
    assert busy.json()["detail"]["code"] == "printer_busy"
