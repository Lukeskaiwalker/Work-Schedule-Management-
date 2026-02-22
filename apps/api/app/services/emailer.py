from __future__ import annotations

import smtplib
from email.message import EmailMessage

from app.core.config import get_settings

MAIL_FROM_ENFORCED = "technik@smpl-energy.de"


def send_email_message(*, to_email: str, subject: str, body: str) -> bool:
    settings = get_settings()
    smtp_host = (settings.smtp_host or "").strip()
    if not smtp_host:
        return False

    message = EmailMessage()
    message["From"] = MAIL_FROM_ENFORCED
    message["To"] = to_email
    message["Subject"] = subject
    message.set_content(body)

    smtp_port = int(settings.smtp_port or 0) or 587
    username = (settings.smtp_username or "").strip()
    password = settings.smtp_password or ""

    try:
        if settings.smtp_ssl:
            with smtplib.SMTP_SSL(smtp_host, smtp_port, timeout=15) as client:
                if username:
                    client.login(username, password)
                client.send_message(message)
                return True

        with smtplib.SMTP(smtp_host, smtp_port, timeout=15) as client:
            client.ehlo()
            if settings.smtp_starttls:
                client.starttls()
                client.ehlo()
            if username:
                client.login(username, password)
            client.send_message(message)
            return True
    except Exception:
        return False
