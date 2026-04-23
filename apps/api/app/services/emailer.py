from __future__ import annotations

import smtplib
from dataclasses import dataclass
from email.message import EmailMessage
from email.utils import formataddr

from app.core.config import get_settings
from app.services.runtime_settings import get_smtp_settings

try:
    from sqlalchemy.orm import Session
except Exception:  # pragma: no cover - import guard for runtime only
    Session = object  # type: ignore[assignment]

MAIL_FROM_ENFORCED = "technik@smpl-energy.de"


@dataclass(frozen=True)
class EmailSendResult:
    """Outcome of a send attempt. `ok=True` means SMTP accepted the message
    end-to-end. On failure, `error_type` is a short kind tag ("not_configured",
    "auth", "connect", "tls", "recipient", "timeout", "unknown") and
    `error_detail` is a human-readable string safe to surface in an admin UI.
    We never include passwords or full stack traces in the detail."""

    ok: bool
    error_type: str | None = None
    error_detail: str | None = None

    def __bool__(self) -> bool:  # pragma: no cover - trivial
        return self.ok


def _resolve_smtp_config(db: Session | None) -> dict:
    settings = get_settings()
    if db is not None:
        runtime = get_smtp_settings(db)
        return {
            "host": str(runtime.get("host") or "").strip(),
            "port": int(runtime.get("port") or 0) or 587,
            "username": str(runtime.get("username") or "").strip(),
            "password": str(runtime.get("password") or ""),
            "starttls": bool(runtime.get("starttls")),
            "ssl": bool(runtime.get("ssl")),
            "from_email": str(runtime.get("from_email") or "").strip(),
            "from_name": str(runtime.get("from_name") or "").strip(),
        }
    return {
        "host": (settings.smtp_host or "").strip(),
        "port": int(settings.smtp_port or 0) or 587,
        "username": (settings.smtp_username or "").strip(),
        "password": settings.smtp_password or "",
        "starttls": bool(settings.smtp_starttls),
        "ssl": bool(settings.smtp_ssl),
        "from_email": MAIL_FROM_ENFORCED,
        "from_name": "",
    }


def send_email_detailed(
    *,
    to_email: str,
    subject: str,
    body: str,
    db: Session | None = None,
) -> EmailSendResult:
    """Send an email and return a structured outcome. Prefer this over the
    legacy `send_email_message(...)` helper — it returns WHY a send failed so
    admin UIs can show a useful message instead of a silent clipboard-copy
    fallback."""
    settings = get_settings()
    cfg = _resolve_smtp_config(db)

    if not cfg["host"]:
        return EmailSendResult(
            ok=False,
            error_type="not_configured",
            error_detail="SMTP host is not set.",
        )

    from_email = cfg["from_email"] or cfg["username"] or (settings.mail_from or "").strip()
    if not from_email:
        return EmailSendResult(
            ok=False,
            error_type="not_configured",
            error_detail="No sender email configured.",
        )

    message = EmailMessage()
    message["From"] = formataddr((cfg["from_name"], from_email)) if cfg["from_name"] else from_email
    message["To"] = to_email
    message["Subject"] = subject
    message.set_content(body)

    try:
        if cfg["ssl"]:
            with smtplib.SMTP_SSL(cfg["host"], cfg["port"], timeout=15) as client:
                if cfg["username"]:
                    client.login(cfg["username"], cfg["password"])
                client.send_message(message)
                return EmailSendResult(ok=True)

        with smtplib.SMTP(cfg["host"], cfg["port"], timeout=15) as client:
            client.ehlo()
            if cfg["starttls"]:
                client.starttls()
                client.ehlo()
            if cfg["username"]:
                client.login(cfg["username"], cfg["password"])
            client.send_message(message)
            return EmailSendResult(ok=True)

    except smtplib.SMTPAuthenticationError as exc:
        code = getattr(exc, "smtp_code", None)
        return EmailSendResult(
            ok=False,
            error_type="auth",
            error_detail=f"SMTP authentication failed (code {code}). Check username and password.",
        )
    except smtplib.SMTPRecipientsRefused as exc:
        rejected = ", ".join((exc.recipients or {}).keys())
        return EmailSendResult(
            ok=False,
            error_type="recipient",
            error_detail=f"Recipient(s) refused: {rejected or 'unknown'}",
        )
    except smtplib.SMTPSenderRefused as exc:
        return EmailSendResult(
            ok=False,
            error_type="sender",
            error_detail=f"Sender refused: {getattr(exc, 'smtp_error', b'').decode(errors='replace') or 'unknown'}",
        )
    except smtplib.SMTPConnectError as exc:
        code = getattr(exc, "smtp_code", None)
        return EmailSendResult(
            ok=False,
            error_type="connect",
            error_detail=f"Could not connect to {cfg['host']}:{cfg['port']} (code {code}).",
        )
    except smtplib.SMTPHeloError as exc:
        return EmailSendResult(
            ok=False,
            error_type="helo",
            error_detail=f"HELO/EHLO was refused by {cfg['host']}.",
        )
    except smtplib.SMTPNotSupportedError as exc:
        return EmailSendResult(
            ok=False,
            error_type="tls",
            error_detail=f"STARTTLS not supported by {cfg['host']}:{cfg['port']}.",
        )
    except smtplib.SMTPException as exc:
        return EmailSendResult(
            ok=False,
            error_type="smtp",
            error_detail=f"SMTP error: {type(exc).__name__}: {exc}",
        )
    except TimeoutError:
        return EmailSendResult(
            ok=False,
            error_type="timeout",
            error_detail=f"Timed out connecting to {cfg['host']}:{cfg['port']}.",
        )
    except OSError as exc:
        return EmailSendResult(
            ok=False,
            error_type="connect",
            error_detail=f"Network error talking to {cfg['host']}:{cfg['port']}: {exc}",
        )
    except Exception as exc:  # pragma: no cover - defensive
        return EmailSendResult(
            ok=False,
            error_type="unknown",
            error_detail=f"Unexpected error: {type(exc).__name__}",
        )


def send_email_message(*, to_email: str, subject: str, body: str, db: Session | None = None) -> bool:
    """Legacy boolean wrapper around `send_email_detailed`. Kept so existing
    call sites (invite / password-reset dispatchers) don't have to change in
    the same PR — they still get True/False, plus the richer endpoints call
    `send_email_detailed` directly to surface the real error."""
    return send_email_detailed(
        to_email=to_email, subject=subject, body=body, db=db
    ).ok
