"""Customer-confirmation email assembly + send (v2.5.0).

Wraps ``app.services.emailer.send_email_detailed`` with a templated body
that includes the task's due date, start time, estimated duration, and
worker names, plus the unauthenticated confirmation URL the customer
clicks. Language is picked from ``customer.language`` (null → German
fallback, since the business is German).

The token in the URL is generated and stored on the Task by the caller —
this module never touches the DB, only renders the email body and calls
the SMTP layer.
"""
from __future__ import annotations

import logging
from datetime import date, time
from typing import Literal

from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.services.emailer import EmailSendResult, send_email_detailed

logger = logging.getLogger(__name__)


Language = Literal["de", "en"]


def _normalize_language(raw: str | None) -> Language:
    """Map any input to one of the supported language codes. Anything
    other than ``"en"`` falls through to ``"de"`` so legacy customers
    without a language preference still get a sensible email."""
    if raw and raw.strip().lower().startswith("en"):
        return "en"
    return "de"


def _format_date(value: date | None, language: Language) -> str:
    if value is None:
        return "—"
    if language == "de":
        return value.strftime("%d.%m.%Y")
    return value.strftime("%Y-%m-%d")


def _format_time(value: time | None) -> str:
    if value is None:
        return ""
    return value.strftime("%H:%M")


def _format_hours(value: float | None, language: Language) -> str:
    if value is None or value <= 0:
        return ""
    label = "Stunden" if language == "de" else "hours"
    if value == int(value):
        return f"{int(value)} {label}"
    # Render half-hour increments cleanly (e.g. "1.5 Stunden") since the
    # schema validator already snaps estimates to 0.5 steps.
    return f"{value:.1f} {label}"


def _public_confirmation_url(token: str) -> str:
    """Resolve the absolute URL of the public confirmation page. Uses
    ``APP_PUBLIC_URL`` from settings — operators set this to the
    customer-reachable hostname (e.g. https://smpl-office.duckdns.org).

    Falls back to a relative-style URL for dev environments where the
    setting isn't populated; SMTP delivery in dev usually goes to a
    stub anyway so the broken host doesn't matter."""
    base = (get_settings().app_public_url or "").strip().rstrip("/")
    if not base:
        return f"/confirm/{token}"
    return f"{base}/confirm/{token}"


def render_customer_confirmation_email(
    *,
    language: Language,
    customer_name: str | None,
    task_title: str,
    task_description: str | None,
    due_date: date | None,
    start_time: time | None,
    estimated_hours: float | None,
    worker_display_names: list[str],
    confirmation_token: str,
    company_name: str,
    company_phone: str | None = None,
) -> tuple[str, str]:
    """Build (subject, body) for the confirmation email. Pure function —
    no DB access, no side effects — so it's straightforward to unit-test
    against snapshot strings."""
    url = _public_confirmation_url(confirmation_token)
    date_str = _format_date(due_date, language)
    time_str = _format_time(start_time)
    when = f"{date_str} {time_str}".strip() if time_str else date_str
    duration = _format_hours(estimated_hours, language)
    workers = ", ".join(name for name in worker_display_names if name.strip())

    if language == "de":
        salutation = (
            f"Sehr geehrte/r {customer_name},"
            if customer_name
            else "Sehr geehrte Damen und Herren,"
        )
        subject = f"Terminbestätigung am {date_str}"
        body_lines = [
            salutation,
            "",
            f"wir möchten Ihren Termin am {when} bestätigen.",
            "",
            f"Geplante Arbeit: {task_title}",
        ]
        if task_description:
            body_lines.append(task_description)
        if duration:
            body_lines.append("")
            body_lines.append(f"Geschätzte Dauer: {duration}")
        if workers:
            body_lines.append(f"Unsere Monteure: {workers}")
        body_lines += [
            "",
            "Bitte bestätigen Sie diesen Termin per Klick:",
            url,
            "",
            "Falls Sie verhindert sind, klicken Sie ablehnen auf der gleichen Seite oder rufen Sie uns an"
            + (f": {company_phone}" if company_phone else "."),
            "",
            "Mit freundlichen Grüßen,",
            company_name,
        ]
    else:
        salutation = f"Dear {customer_name}," if customer_name else "Dear customer,"
        subject = f"Appointment confirmation for {date_str}"
        body_lines = [
            salutation,
            "",
            f"We would like to confirm your appointment on {when}.",
            "",
            f"Planned work: {task_title}",
        ]
        if task_description:
            body_lines.append(task_description)
        if duration:
            body_lines.append("")
            body_lines.append(f"Estimated duration: {duration}")
        if workers:
            body_lines.append(f"Our team: {workers}")
        body_lines += [
            "",
            "Please confirm the appointment by clicking this link:",
            url,
            "",
            "If you are unable to attend, click decline on the same page or call us"
            + (f" at {company_phone}." if company_phone else "."),
            "",
            "Kind regards,",
            company_name,
        ]
    return subject, "\n".join(body_lines)


def send_customer_confirmation_email(
    *,
    db: Session,
    to_email: str,
    customer_language: str | None,
    customer_name: str | None,
    task_title: str,
    task_description: str | None,
    due_date: date | None,
    start_time: time | None,
    estimated_hours: float | None,
    worker_display_names: list[str],
    confirmation_token: str,
    company_name: str = "SMPL",
    company_phone: str | None = None,
) -> EmailSendResult:
    """Compose + send the customer-confirmation email.

    Returns the underlying ``EmailSendResult`` so callers can surface the
    failure detail on the operator's screen (e.g. ``"not_configured"``
    if SMTP isn't set up — operators see "Email not sent: SMTP needs to
    be configured first" instead of a silent failure)."""
    language = _normalize_language(customer_language)
    subject, body = render_customer_confirmation_email(
        language=language,
        customer_name=customer_name,
        task_title=task_title,
        task_description=task_description,
        due_date=due_date,
        start_time=start_time,
        estimated_hours=estimated_hours,
        worker_display_names=worker_display_names,
        confirmation_token=confirmation_token,
        company_name=company_name,
        company_phone=company_phone,
    )
    return send_email_detailed(to_email=to_email, subject=subject, body=body, db=db)
