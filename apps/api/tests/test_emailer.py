from __future__ import annotations

from app.services import emailer


class _Settings:
    smtp_host = "smtp.test.local"
    smtp_port = 587
    smtp_username = ""
    smtp_password = ""
    smtp_starttls = True
    smtp_ssl = False
    mail_from = "override@example.com"


class _FakeSMTP:
    last_message = None

    def __init__(self, *args, **kwargs):
        _ = args, kwargs

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        _ = exc_type, exc, tb
        return False

    def ehlo(self):
        return None

    def starttls(self):
        return None

    def login(self, *_args, **_kwargs):
        return None

    def send_message(self, message):
        _FakeSMTP.last_message = message


def test_email_sender_is_enforced(monkeypatch):
    monkeypatch.setattr(emailer, "get_settings", lambda: _Settings())
    monkeypatch.setattr(emailer.smtplib, "SMTP", _FakeSMTP)
    _FakeSMTP.last_message = None

    sent = emailer.send_email_message(
        to_email="receiver@example.com",
        subject="Test",
        body="Body",
    )
    assert sent is True
    assert _FakeSMTP.last_message is not None
    assert _FakeSMTP.last_message["From"] == "technik@smpl-energy.de"


# ──────────────────── v2.5.30: host-aware auth-error hints ────────────────────


def test_auth_error_godaddy_legacy_host_hints_at_microsoft365_migration():
    msg = emailer._format_smtp_auth_error(535, "smtpout.secureserver.net")
    assert "code 535" in msg
    assert "GoDaddy" in msg
    assert "Microsoft 365" in msg
    assert "smtp.office365.com" in msg
    assert "app-specific password" in msg


def test_auth_error_microsoft365_hints_at_auth_smtp_flag_and_app_password():
    msg = emailer._format_smtp_auth_error(535, "smtp.office365.com")
    assert "Microsoft 365" in msg
    assert "Authenticated SMTP" in msg
    assert "app password" in msg


def test_auth_error_outlook_subdomain_still_matches_microsoft365_branch():
    msg = emailer._format_smtp_auth_error(535, "eur.smtp.office365.com")
    assert "Microsoft 365" in msg


def test_auth_error_gmail_hints_at_app_password_only():
    msg = emailer._format_smtp_auth_error(535, "smtp.gmail.com")
    assert "Gmail" in msg
    assert "app password" in msg
    assert "2-Step" in msg


def test_auth_error_unknown_host_falls_back_to_generic_message():
    msg = emailer._format_smtp_auth_error(535, "smtp.example.com")
    assert "code 535" in msg
    assert "Check username and password" in msg
    # No provider-specific hints in the generic path.
    assert "GoDaddy" not in msg
    assert "Microsoft" not in msg
    assert "Gmail" not in msg


def test_auth_error_empty_host_is_safe():
    msg = emailer._format_smtp_auth_error(535, "")
    assert "code 535" in msg
    assert "Check username and password" in msg
