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
