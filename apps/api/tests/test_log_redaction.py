"""Bearer secrets must not reach the API's access log.

uvicorn prints every request line, query string included. Several URLs carry
a credential by necessity (the calendar subscription, the customer's
confirmation link, the IDS hand-over) or did until now (the event stream's
``?token=``). The filter rewrites those parts of the line and leaves method,
path and status alone, so the log still answers "what happened" — it just no
longer hands out the means to do it again.
"""
from __future__ import annotations

import logging
import re
from pathlib import Path

import pytest
from uvicorn.logging import AccessFormatter

from app.core.log_redaction import (
    REDACTED,
    SECRET_IN_URL,
    SecretRedactingFilter,
    install_access_log_redaction,
    redact_secrets,
)

JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl"


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        (f"/api/events?token={JWT}", f"/api/events?token={REDACTED}"),
        (f"/api/events?x=1&token={JWT}&y=2", f"/api/events?x=1&token={REDACTED}&y=2"),
        ("/api/events?ticket=AbC-_123", f"/api/events?ticket={REDACTED}"),
        (f"/api/events?access_token={JWT}", f"/api/events?access_token={REDACTED}"),
        ("/api/calendar/smpl_cal_AbC-_123/feed.ics", f"/api/calendar/{REDACTED}/feed.ics"),
        ("/api/public/customer-confirmations/AbC123", f"/api/public/customer-confirmations/{REDACTED}"),
        ("/api/werkstatt/ids/handoff/AbC123", f"/api/werkstatt/ids/handoff/{REDACTED}"),
        ("/api/werkstatt/ids/hook/AbC123?x=1", f"/api/werkstatt/ids/hook/{REDACTED}?x=1"),
        ("/confirm/AbC123", f"/confirm/{REDACTED}"),
        ("/portal/einladung?token=AbC123", f"/portal/einladung?token={REDACTED}"),
        ("/invite?token=AbC123", f"/invite?token={REDACTED}"),
        # A Referer is a whole URL; the same rules apply after the authority.
        ("https://smpl.example/confirm/AbC123", f"https://smpl.example/confirm/{REDACTED}"),
        ("http://192.168.2.50/reset-password?token=AbC123", f"http://192.168.2.50/reset-password?token={REDACTED}"),
    ],
)
def test_secrets_in_urls_are_redacted(raw: str, expected: str) -> None:
    assert redact_secrets(raw) == expected


@pytest.mark.parametrize(
    "raw",
    [
        "/api/projects/5?include=tasks",
        "/api/calendar/feed",  # the signed-in management route, no secret
        "/api/werkstatt/scan/resolve?code=4011200296908",  # a barcode, not a credential
        "/api/admin/users?csrf_token_hint=1",
        "/api/events",
        "/api/auth/api-tokens/12",
        "/api/foo?redirect=/confirm/abc",  # not a confirmation URL itself
    ],
)
def test_ordinary_urls_are_left_alone(raw: str) -> None:
    assert redact_secrets(raw) == raw


def _uvicorn_access_record(path: str) -> logging.LogRecord:
    # Exactly the call uvicorn 0.35 makes in h11_impl / httptools_impl.
    return logging.LogRecord(
        name="uvicorn.access",
        level=logging.INFO,
        pathname=__file__,
        lineno=1,
        msg='%s - "%s %s HTTP/%s" %d',
        args=("10.0.0.7:51234", "GET", path, "1.1", 200),
        exc_info=None,
    )


def test_the_filter_rewrites_a_uvicorn_access_line() -> None:
    record = _uvicorn_access_record(f"/api/events?token={JWT}")
    assert SecretRedactingFilter().filter(record) is True
    line = AccessFormatter(fmt='%(client_addr)s - "%(request_line)s" %(status_code)s', use_colors=False).format(record)
    assert JWT not in line
    assert line == f'10.0.0.7:51234 - "GET /api/events?token={REDACTED} HTTP/1.1" 200 OK'


def test_the_filter_keeps_non_string_args_and_plain_messages() -> None:
    record = _uvicorn_access_record("/api/projects/5")
    SecretRedactingFilter().filter(record)
    assert record.args == ("10.0.0.7:51234", "GET", "/api/projects/5", "1.1", 200)

    plain = logging.LogRecord("uvicorn.error", logging.INFO, __file__, 1, "GET /api/calendar/smpl_cal_x/feed.ics", None, None)
    SecretRedactingFilter().filter(plain)
    assert plain.getMessage() == f"GET /api/calendar/{REDACTED}/feed.ics"


CADDYFILE = Path(__file__).resolve().parents[2] / "web" / "Caddyfile"


@pytest.mark.skipif(not CADDYFILE.exists(), reason="the api image is built without apps/web")
def test_the_proxy_log_redacts_with_the_same_pattern() -> None:
    # The proxy's log filter and this one guard the same URLs; a rule added to
    # only one of them would leave the other log printing the secret.
    rules = re.findall(r"^\s*(request>\S+) regexp `([^`]*)` \"([^\"]*)\"$", CADDYFILE.read_text(), re.MULTILINE)
    assert sorted(field for field, _, _ in rules) == ["request>headers>Referer", "request>uri"]
    for _, pattern, replacement in rules:
        assert pattern == SECRET_IN_URL.pattern
        assert replacement == "${1}${2}${3}" + REDACTED + "${4}"


def test_loading_the_app_installs_the_filter_on_uvicorn_loggers() -> None:
    import app.main  # noqa: F401 - importing is what installs it

    for name in ("uvicorn.access", "uvicorn.error"):
        filters = [f for f in logging.getLogger(name).filters if isinstance(f, SecretRedactingFilter)]
        assert len(filters) == 1, name

    # Idempotent: a second install (a reload, a test importing twice) must not stack filters.
    install_access_log_redaction()
    assert len([f for f in logging.getLogger("uvicorn.access").filters if isinstance(f, SecretRedactingFilter)]) == 1
