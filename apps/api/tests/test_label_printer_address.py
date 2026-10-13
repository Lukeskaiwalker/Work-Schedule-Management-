"""Which printer addresses an admin may enter, and what of a reply is shown.

The calibration reads the printer's answers back (STATUS, CONFIG) and shows
them. With any host:port an admin could aim that read at a service inside the
deployment — the database, the update runner, a metadata endpoint — and see
its answer (commit security review, 2026-10-13: SSRF in
werkstatt_label_transport). So:

* the port must be a raw-print port, 9100–9109 — nothing internal listens
  there, whatever the host;
* the host must not be this machine, link-local, unspecified, multicast or
  one of the compose service names;
* a reply that does not look like this printer's configuration is neither
  returned raw nor parsed into fields (the "firmware" field used to be just
  the reply's first line — a server banner would have shown there).
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.core.db import SessionLocal
from app.services import werkstatt_label_address as address
from app.services import werkstatt_label_printer_status as printer_status
from app.services.werkstatt_label_transport import QueryReply
from tests.conftest import auth_headers

SETTINGS = "/api/admin/settings/label-printer"


@pytest.fixture(autouse=True)
def _production_policy(monkeypatch: pytest.MonkeyPatch):
    # The fake-printer fixture relaxes the policy for 127.0.0.1; these tests
    # check the policy itself.
    monkeypatch.setattr(address, "ALLOW_LOCAL_TEST_PRINTER", False)


@pytest.mark.parametrize(
    "host",
    [
        "127.0.0.1",
        "127.10.0.5",
        "::1",
        "[::1]",
        "localhost",
        "LOCALHOST.",
        "db",
        "api",
        "update_runner",
        "web",
        "169.254.169.254",
        "fe80::1",
        "0.0.0.0",
        "224.0.0.1",
        "metadata.google.internal",
        "printer.localhost",
        "bad host!",
    ],
)
def test_an_internal_or_odd_host_is_refused(client: TestClient, admin_token: str, host: str) -> None:
    response = client.patch(SETTINGS, headers=auth_headers(admin_token), json={"host": host, "port": 9100})
    assert response.status_code == 400, response.text
    assert "Drucker" in response.json()["detail"]


@pytest.mark.parametrize("port", [22, 80, 5432, 6379, 8000, 9099, 9110, 65535])
def test_a_port_outside_the_raw_print_range_is_refused(client: TestClient, admin_token: str, port: int) -> None:
    response = client.patch(SETTINGS, headers=auth_headers(admin_token), json={"host": "192.168.2.158", "port": port})
    assert response.status_code == 400, response.text
    assert "9100 und 9109" in response.json()["detail"]


@pytest.mark.parametrize(("host", "port"), [("192.168.2.158", 9100), ("10.0.0.20", 9109), ("etiketten.buero.lan", 9101)])
def test_a_printer_on_the_lan_is_accepted(client: TestClient, admin_token: str, host: str, port: int) -> None:
    response = client.patch(SETTINGS, headers=auth_headers(admin_token), json={"host": host, "port": port})
    assert response.status_code == 200, response.text


def test_changing_only_the_port_is_checked_against_the_stored_host(client: TestClient, admin_token: str) -> None:
    head = auth_headers(admin_token)
    assert client.patch(SETTINGS, headers=head, json={"host": "192.168.2.158", "port": 9100}).status_code == 200
    assert client.patch(SETTINGS, headers=head, json={"port": 5432}).status_code == 400
    assert client.patch(SETTINGS, headers=head, json={"port": 9101}).status_code == 200


def test_clearing_the_address_stays_possible(client: TestClient, admin_token: str) -> None:
    head = auth_headers(admin_token)
    assert client.patch(SETTINGS, headers=head, json={"host": "192.168.2.158", "port": 9100}).status_code == 200
    assert client.patch(SETTINGS, headers=head, json={"host": ""}).status_code == 200


def test_an_address_stored_before_the_rule_is_not_used(client: TestClient, admin_token: str) -> None:
    from app.services import werkstatt_labels
    from app.services.werkstatt_label_materials import get_label_printer_config, update_config

    with SessionLocal() as db:
        # Bypass the endpoint: a value written before this rule existed.
        update_config(db, lambda _current: {"host": "db", "port": 5432}, expected_revision=None)
        db.commit()
        assert get_label_printer_config(db)["host"] == "db"
        assert werkstatt_labels.printer_address(db) is None


def test_a_reply_that_is_not_this_printers_config_is_neither_shown_nor_parsed(monkeypatch: pytest.MonkeyPatch) -> None:
    banner = "HTTP/1.1 400 Bad Request\nServer: internal-service/1.0\nContent-Length: 0"
    replies = {
        "~S,STATUS": QueryReply(text="", complete=False, errors_seen=()),
        "^XGET,CONFIG": QueryReply(text=banner, complete=False, errors_seen=()),
    }
    monkeypatch.setattr(printer_status, "query_printer", lambda _db, query: replies[query.value])
    monkeypatch.setattr("app.services.werkstatt_labels.printer_address", lambda _db: ("192.168.2.158", 9100))
    with SessionLocal() as db:
        status = printer_status.read_status(db, full=True)
    assert status.raw_config is None
    assert status.config is None or status.config.firmware is None


def test_the_real_config_reply_is_still_recognised() -> None:
    from tests.fake_ezpl_printer import FIXTURE

    text = FIXTURE.read_text(encoding="latin-1").replace("\r\n", "\n")
    assert printer_status.looks_like_printer_config(text)
    assert printer_status.parse_config(text, True).firmware == "Smart Printer V5.UW0m"
    assert not printer_status.looks_like_printer_config("HTTP/1.1 400 Bad Request\nServer: x")
    assert printer_status.parse_config("HTTP/1.1 400 Bad Request\nServer: x", True).firmware is None
