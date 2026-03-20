from __future__ import annotations

import smtplib
from email.message import EmailMessage
from email.utils import formataddr

from app.core.config import get_settings
from app.services.runtime_settings import get_smtp_settings

try:
    from sqlalchemy.orm import Session
except Exception:  # pragma: no cover - import guard for runtime only
    Session = object  # type: ignore[assignment]

MAIL_FROM_ENFORCED = "technik@smpl-energy.de"


def send_email_message(*, to_email: str, subject: str, body: str, db: Session | None = None) -> bool:
    settings = get_settings()
    if db is not None:
        runtime = get_smtp_settings(db)
        smtp_host = str(runtime.get("host") or "").strip()
        smtp_port = int(runtime.get("port") or 0) or 587
        username = str(runtime.get("username") or "").strip()
        password = str(runtime.get("password") or "")
        smtp_starttls = bool(runtime.get("starttls"))
        smtp_ssl = bool(runtime.get("ssl"))
        from_email = str(runtime.get("from_email") or "").strip()
        from_name = str(runtime.get("from_name") or "").strip()
    else:
        smtp_host = (settings.smtp_host or "").strip()
        smtp_port = int(settings.smtp_port or 0) or 587
        username = (settings.smtp_username or "").strip()
        password = settings.smtp_password or ""
        smtp_starttls = bool(settings.smtp_starttls)
        smtp_ssl = bool(settings.smtp_ssl)
        from_email = MAIL_FROM_ENFORCED
        from_name = ""

    if not smtp_host:
        return False
    if not from_email:
        from_email = username or (settings.mail_from or "").strip()
    if not from_email:
        return False

    message = EmailMessage()
    message["From"] = formataddr((from_name, from_email)) if from_name else from_email
    message["To"] = to_email
    message["Subject"] = subject
    message.set_content(body)

    try:
        if smtp_ssl:
            with smtplib.SMTP_SSL(smtp_host, smtp_port, timeout=15) as client:
                if username:
                    client.login(username, password)
                client.send_message(message)
                return True

        with smtplib.SMTP(smtp_host, smtp_port, timeout=15) as client:
            client.ehlo()
            if smtp_starttls:
                client.starttls()
                client.ehlo()
            if username:
                client.login(username, password)
            client.send_message(message)
            return True
    except Exception:
        return False
