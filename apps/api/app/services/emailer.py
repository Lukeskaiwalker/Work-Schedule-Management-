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


def _format_smtp_auth_error(code: int | None, host: str) -> str:
    """Build a host-aware 535-style error message.

    Recognises the SMTP hosts of the providers SMPL operators
    typically hit (GoDaddy legacy + Microsoft 365, Gmail, generic
    Outlook, Zoho) and appends a targeted hint. Unknown hosts get
    the generic message — better than nothing, and the same as what
    the v2.5.18 emailer surfaced.

    Hostname comparison is case-insensitive and substring-based so
    that subdomains and country-specific endpoints all match (e.g.
    smtp.office365.com, eur.smtp.office365.com).
    """
    host_lc = (host or "").lower()
    base = f"SMTP authentication failed (code {code})."

    # GoDaddy legacy Workspace Email host — the most common "used to
    # work" complaint. GoDaddy has been migrating these mailboxes to
    # Microsoft 365 for a couple of years now; once migrated, the
    # mailbox stops accepting auth on the old host.
    if "secureserver.net" in host_lc:
        return (
            f"{base} GoDaddy may have migrated this mailbox to "
            "Microsoft 365. Try host smtp.office365.com on port 587 "
            "with STARTTLS and an app-specific password (Account → "
            "Security → App passwords). If the account still uses "
            "the legacy Workspace Email, double-check the password "
            "at email.godaddy.com."
        )

    # Microsoft 365 / Outlook / Office 365 family. SMTP AUTH was
    # disabled by default for new tenants in 2022 and Basic Auth
    # has been deprecated company-wide — both an app password AND a
    # per-mailbox SMTP-enabled flag are required.
    if (
        "office365.com" in host_lc
        or "outlook.com" in host_lc
        or "outlook.office" in host_lc
    ):
        return (
            f"{base} For Microsoft 365: (1) the mailbox needs "
            "'Authenticated SMTP' enabled (Exchange admin → mailbox "
            "→ Manage email apps); (2) if MFA is on, use an app "
            "password (Account → Security → App passwords), not the "
            "regular account password. The username must be the "
            "full email address."
        )

    # Gmail / Google Workspace. Google blocked "less secure apps"
    # entirely in 2022; only OAuth2 or app passwords work now, and
    # app passwords require 2-Step Verification to be enabled.
    if "gmail.com" in host_lc or "googlemail.com" in host_lc:
        return (
            f"{base} For Gmail: account passwords no longer work for "
            "SMTP. Enable 2-Step Verification at "
            "myaccount.google.com/security, then generate an app "
            "password at myaccount.google.com/apppasswords and use "
            "that here."
        )

    # Zoho — also requires app-specific passwords when 2FA is on.
    if "zoho.com" in host_lc or "zoho.eu" in host_lc:
        return (
            f"{base} For Zoho: if 2FA is enabled, generate an "
            "application-specific password at "
            "accounts.zoho.com/home#security/app_password and use "
            "that instead of the account password."
        )

    # Generic catch-all — same as the v2.5.18 wording.
    return f"{base} Check username and password."


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
        # v2.5.30 — host-aware hint. The generic "check username and
        # password" message is unhelpful when the actual cause is one
        # of three common scenarios:
        #
        #   (a) The provider migrated the mailbox to a new auth
        #       system (GoDaddy → Microsoft 365 has been the big one).
        #       The username/password didn't change, but the SMTP
        #       *server* did. Old config still points at the legacy
        #       host that no longer accepts the credentials.
        #   (b) MFA was enabled on the account. Most providers then
        #       refuse plain-password SMTP and require an "app
        #       password" (a 16-char string generated specifically
        #       for non-browser clients).
        #   (c) Authenticated SMTP is disabled per-mailbox. This is
        #       the Microsoft 365 default for new tenants since 2022
        #       — the admin has to enable it explicitly in
        #       Exchange admin → mailbox settings.
        #
        # The SMTP host is a strong predictor of which one bit the
        # caller, so we inspect it and append a targeted hint.
        return EmailSendResult(
            ok=False,
            error_type="auth",
            error_detail=_format_smtp_auth_error(code, cfg.get("host", "")),
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
