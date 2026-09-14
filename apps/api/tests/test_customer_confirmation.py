"""Tests for the v2.5.0 customer-confirmation flow.

Covers the four paths the operator + customer can take:

1. Task created with ``request_customer_confirmation=true`` → status
   lands at ``"pending"`` + a token gets generated.
2. Operator manually confirms via the manual endpoint → status flips
   to ``"confirmed"`` + by_user / method / timestamp populated.
3. Customer hits the public token endpoint → confirms (or declines) +
   token is burned + status flips with method=email.
4. Edge cases: expired link (410), unknown token (404), idempotent
   double-click on already-confirmed task, due_date change resets
   confirmation state.

SMTP isn't configured in the test env, so dispatch_customer_confirmation_email
falls into the ``not_configured`` branch. That is a PRE-WIRE failure — no
message is built and no socket is opened — so the dispatcher restores the
confirmation state it found instead of leaving a half-started round behind.
Tests that need a possibly-delivered failure (timeout, post-DATA) patch
``send_customer_confirmation_email`` to return the error_type they want.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from app.core.db import SessionLocal
from app.models.entities import Task


def auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _seed_project_with_customer(client: TestClient, admin_token: str) -> tuple[int, int, str]:
    """Create a Customer + Project linked together. Returns (project_id,
    customer_id, customer_email)."""
    cust = client.post(
        "/api/customers",
        headers=auth_headers(admin_token),
        json={
            "name": "Confirmation Test Customer",
            "address": "Hauptstr. 1, 12345 Berlin",
            "email": "confirmation-test@example.com",
            "phone": "+49 30 1234567",
            "language": "de",
        },
    )
    assert cust.status_code == 200, cust.text
    customer_id = cust.json()["id"]

    proj = client.post(
        "/api/projects",
        headers=auth_headers(admin_token),
        json={
            "project_number": "P-CONF-1",
            "name": "Confirmation test project",
            "status": "Auftrag angenommen",
            "customer_id": customer_id,
        },
    )
    assert proj.status_code == 200, proj.text
    return proj.json()["id"], customer_id, "confirmation-test@example.com"


def test_task_create_with_confirmation_sets_pending_status(
    client: TestClient, admin_token: str
):
    """Creating a task with ``request_customer_confirmation=true`` lands
    in ``pending`` and generates a unique token (the email send itself
    is best-effort — SMTP isn't configured in tests, but the status +
    token are guaranteed)."""
    project_id, _, _ = _seed_project_with_customer(client, admin_token)
    future_due = (date.today() + timedelta(days=7)).isoformat()

    response = client.post(
        "/api/tasks",
        headers=auth_headers(admin_token),
        json={
            "project_id": project_id,
            "title": "Install device",
            "task_type": "construction",
            "due_date": future_due,
            "request_customer_confirmation": True,
        },
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["customer_confirmation_status"] == "pending"
    # Token isn't returned via TaskOut (security boundary) — operators
    # see the status, the public endpoint resolves token → task. Verify
    # via the DB directly.
    with SessionLocal() as db:
        task = db.get(Task, body["id"])
        assert task is not None
        assert task.customer_confirmation_token is not None
        assert len(task.customer_confirmation_token) == 32  # secrets.token_hex(16)


def test_manual_confirm_records_timestamp_and_operator(
    client: TestClient, admin_token: str
):
    project_id, _, _ = _seed_project_with_customer(client, admin_token)
    future_due = (date.today() + timedelta(days=7)).isoformat()
    task_id = client.post(
        "/api/tasks",
        headers=auth_headers(admin_token),
        json={
            "project_id": project_id,
            "title": "Install device",
            "task_type": "construction",
            "due_date": future_due,
            "request_customer_confirmation": True,
        },
    ).json()["id"]

    response = client.post(
        f"/api/tasks/{task_id}/customer-confirmation/manual",
        headers=auth_headers(admin_token),
        json={
            "action": "confirm",
            "method": "phone",
            "notes": "Spoke with Mr. Schmidt at 14:32 — confirmed",
        },
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["customer_confirmation_status"] == "confirmed"
    assert body["customer_confirmation_method"] == "phone"
    assert body["customer_confirmation_at"] is not None
    assert body["customer_confirmation_by_user_id"] is not None
    assert "Mr. Schmidt" in (body["customer_confirmation_notes"] or "")
    # Token burned after manual confirm so a stale email link can't
    # toggle the state back.
    with SessionLocal() as db:
        assert db.get(Task, task_id).customer_confirmation_token is None


def test_public_confirm_via_token_flips_status_and_burns_token(
    client: TestClient, admin_token: str
):
    project_id, _, _ = _seed_project_with_customer(client, admin_token)
    future_due = (date.today() + timedelta(days=7)).isoformat()
    task_id = client.post(
        "/api/tasks",
        headers=auth_headers(admin_token),
        json={
            "project_id": project_id,
            "title": "Install device",
            "task_type": "construction",
            "due_date": future_due,
            "request_customer_confirmation": True,
        },
    ).json()["id"]
    with SessionLocal() as db:
        token = db.get(Task, task_id).customer_confirmation_token
    assert token

    # Customer hits the public GET — sees the summary.
    get_resp = client.get(f"/api/public/customer-confirmations/{token}")
    assert get_resp.status_code == 200
    assert get_resp.json()["task_title"] == "Install device"
    assert get_resp.json()["confirmation_status"] == "pending"
    assert get_resp.json()["expired"] is False

    # Customer confirms.
    post_resp = client.post(
        f"/api/public/customer-confirmations/{token}",
        json={"action": "confirm"},
    )
    assert post_resp.status_code == 200
    assert post_resp.json()["confirmation_status"] == "confirmed"

    # Task in DB now reflects email-method confirmation; token burned.
    with SessionLocal() as db:
        task = db.get(Task, task_id)
        assert task.customer_confirmation_status == "confirmed"
        assert task.customer_confirmation_method == "email"
        assert task.customer_confirmation_by_user_id is None  # self-served
        assert task.customer_confirmation_token is None


def test_public_confirm_unknown_token_returns_404(client: TestClient):
    response = client.get("/api/public/customer-confirmations/deadbeef00000000")
    assert response.status_code == 404


def test_public_confirm_expired_link_returns_410(client: TestClient, admin_token: str):
    """When today >= due_date, the public POST returns 410 Gone — the
    customer must call instead."""
    project_id, _, _ = _seed_project_with_customer(client, admin_token)
    # Create a task whose due_date is today (the link is invalid the
    # day of). The seeding helper sets project status to angenommen so
    # template task creation doesn't affect this.
    # utcnow(), not date.today(): _task_confirmation_expired compares against
    # the UTC date, and in CEST the local date runs a day ahead between
    # midnight and 02:00 — which made this fail nightly.
    today_iso = datetime.now(timezone.utc).date().isoformat()
    task_id = client.post(
        "/api/tasks",
        headers=auth_headers(admin_token),
        json={
            "project_id": project_id,
            "title": "Same-day visit",
            "task_type": "construction",
            "due_date": today_iso,
            "request_customer_confirmation": True,
        },
    ).json()["id"]
    with SessionLocal() as db:
        token = db.get(Task, task_id).customer_confirmation_token
    assert token

    # GET returns 200 with expired=true (so the page can render a
    # helpful "please call us" message rather than 404).
    get_resp = client.get(f"/api/public/customer-confirmations/{token}")
    assert get_resp.status_code == 200
    assert get_resp.json()["expired"] is True

    # POST rejects with 410 Gone.
    post_resp = client.post(
        f"/api/public/customer-confirmations/{token}",
        json={"action": "confirm"},
    )
    assert post_resp.status_code == 410


def test_public_confirm_double_click_is_idempotent(
    client: TestClient, admin_token: str
):
    """A second click on an already-acted-on link returns the current
    state without re-toggling — common UX where the customer clicks
    once on phone, then again on desktop."""
    project_id, _, _ = _seed_project_with_customer(client, admin_token)
    future_due = (date.today() + timedelta(days=7)).isoformat()
    task_id = client.post(
        "/api/tasks",
        headers=auth_headers(admin_token),
        json={
            "project_id": project_id,
            "title": "Install device",
            "task_type": "construction",
            "due_date": future_due,
            "request_customer_confirmation": True,
        },
    ).json()["id"]
    with SessionLocal() as db:
        token = db.get(Task, task_id).customer_confirmation_token

    # First click: confirm.
    first = client.post(
        f"/api/public/customer-confirmations/{token}",
        json={"action": "confirm"},
    )
    assert first.status_code == 200
    assert first.json()["confirmation_status"] == "confirmed"

    # Token is burned, but if the customer somehow had the OLD token
    # cached (forwarded email tab), the post would 404 since the token
    # is gone. That's fine for our use case — the test below verifies
    # the manual path is idempotent against re-confirm.
    second = client.post(
        f"/api/public/customer-confirmations/{token}",
        json={"action": "confirm"},
    )
    assert second.status_code == 404


def test_due_date_change_resets_confirmation_status(
    client: TestClient, admin_token: str
):
    """When operator pushes the due_date out (and the task was already
    confirmed), the confirmation gets reset to pending + a fresh token
    is generated. Customer's old "yes for date X" no longer commits
    them to "yes for date Y"."""
    project_id, _, _ = _seed_project_with_customer(client, admin_token)
    future_due = (date.today() + timedelta(days=7)).isoformat()
    task_id = client.post(
        "/api/tasks",
        headers=auth_headers(admin_token),
        json={
            "project_id": project_id,
            "title": "Install device",
            "task_type": "construction",
            "due_date": future_due,
            "request_customer_confirmation": True,
        },
    ).json()["id"]
    with SessionLocal() as db:
        old_token = db.get(Task, task_id).customer_confirmation_token

    # Manually confirm.
    client.post(
        f"/api/tasks/{task_id}/customer-confirmation/manual",
        headers=auth_headers(admin_token),
        json={"action": "confirm", "method": "phone"},
    )
    with SessionLocal() as db:
        task = db.get(Task, task_id)
        assert task.customer_confirmation_status == "confirmed"

    # Push the due_date — confirmation should reset.
    new_due = (date.today() + timedelta(days=14)).isoformat()
    response = client.patch(
        f"/api/tasks/{task_id}",
        headers=auth_headers(admin_token),
        json={"due_date": new_due},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["customer_confirmation_status"] == "pending"
    assert body["customer_confirmation_at"] is None
    with SessionLocal() as db:
        new_token = db.get(Task, task_id).customer_confirmation_token
    # A FRESH token was generated. The old one (cleared after manual
    # confirm) cannot be re-used, and the new one is different.
    assert new_token is not None
    assert new_token != old_token


# ── v2.14.23 regression tests: four bugs in the confirmation flow ────────
#
# All four were reachable from the office's normal clicks, and three of
# them destroy or strand data, so each gets a test that fails on the old
# code. The email/token half of this feature has never run in production
# (zero tokens, zero sends in four months), which is exactly why the
# behaviour has to be pinned here rather than discovered by the first
# operator who uses it.


def _seed_project_with_emailless_customer(
    client: TestClient, admin_token: str
) -> tuple[int, int]:
    """Create a Customer with NO email + a Project linked to it.

    This is the common shape in production: the office has the phone
    number, called the customer, and ticked the box. Returns
    (project_id, customer_id)."""
    cust = client.post(
        "/api/customers",
        headers=auth_headers(admin_token),
        json={
            "name": "Phone-only Customer",
            "address": "Nebenstr. 7, 12345 Berlin",
            "phone": "+49 30 7654321",
            "language": "de",
        },
    )
    assert cust.status_code == 200, cust.text
    customer_id = cust.json()["id"]

    proj = client.post(
        "/api/projects",
        headers=auth_headers(admin_token),
        json={
            "project_number": "P-CONF-NOMAIL",
            "name": "Phone-only project",
            "status": "Auftrag angenommen",
            "customer_id": customer_id,
        },
    )
    assert proj.status_code == 200, proj.text
    return proj.json()["id"], customer_id


def _create_confirmation_task(
    client: TestClient, admin_token: str, project_id: int, *, days_out: int = 7
) -> int:
    due = (date.today() + timedelta(days=days_out)).isoformat()
    response = client.post(
        "/api/tasks",
        headers=auth_headers(admin_token),
        json={
            "project_id": project_id,
            "title": "Install device",
            "task_type": "construction",
            "due_date": due,
            "request_customer_confirmation": True,
        },
    )
    assert response.status_code == 200, response.text
    return response.json()["id"]


def test_due_date_change_keeps_the_phone_note_and_clears_the_sent_at(
    client: TestClient, admin_token: str
):
    """Bug 1: a reset voids the VERDICT and the LINK, never the record.

    The two kinds of confirmation evidence split, and the reset treats
    them oppositely on purpose:

    ``customer_confirmation_notes`` records what a human agreed ("kommt
    um 8, Schlüssel bei Nachbarin"). A reschedule is the most routine
    action in this office and it runs through the same reset, so
    clearing it here would destroy the only record of the call, with no
    audit trail behind it. Every confirmation in production arrived by
    phone, so these are exactly the rows carrying notes. It survives.

    ``customer_confirmation_email_sent_at`` is a fact about ONE round's
    link. The reset mints a new token, which kills the old link, so the
    timestamp now describes a round that no longer exists — and reads on
    screen as "we already asked them" about a link nobody can answer. It
    is per-round and it dies with its round."""
    project_id, _, _ = _seed_project_with_customer(client, admin_token)
    task_id = _create_confirmation_task(client, admin_token, project_id)

    manual = client.post(
        f"/api/tasks/{task_id}/customer-confirmation/manual",
        headers=auth_headers(admin_token),
        json={
            "action": "confirm",
            "method": "phone",
            "notes": "Frau Weber am Telefon: kommt um 8, Schlüssel bei Nachbarin",
        },
    )
    assert manual.status_code == 200, manual.text
    # Stamp a mail timestamp the way a successful send would have.
    sent_at = datetime.now(timezone.utc).replace(microsecond=0)
    with SessionLocal() as db:
        task = db.get(Task, task_id)
        task.customer_confirmation_email_sent_at = sent_at
        db.commit()

    new_due = (date.today() + timedelta(days=21)).isoformat()
    response = client.patch(
        f"/api/tasks/{task_id}",
        headers=auth_headers(admin_token),
        json={"due_date": new_due},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    # The verdict is void — that half of the reset is unchanged.
    assert body["customer_confirmation_status"] == "pending"
    assert body["customer_confirmation_method"] is None
    assert body["customer_confirmation_at"] is None
    # The record of what the human agreed survives.
    assert "Schlüssel bei Nachbarin" in (body["customer_confirmation_notes"] or "")
    # The old round's send time does not: a new token was just minted, so
    # the link that timestamp describes is dead.
    assert body["customer_confirmation_email_sent_at"] is None
    with SessionLocal() as db:
        task = db.get(Task, task_id)
        assert "Frau Weber" in (task.customer_confirmation_notes or "")
        assert task.customer_confirmation_email_sent_at is None
        # And the new link the timestamp would have been lying about:
        assert task.customer_confirmation_token is not None


def test_rescheduling_a_declined_task_reopens_the_confirmation(
    client: TestClient, admin_token: str
):
    """Bug 2: a "no" plus a new date must be askable again.

    The decline burns the token, and "declined" used to be excluded from
    the due-date reset — so a task the customer turned down and the
    office then rescheduled stayed "declined" with no token forever, with
    no way back into the flow from any screen."""
    project_id, _, _ = _seed_project_with_customer(client, admin_token)
    task_id = _create_confirmation_task(client, admin_token, project_id)

    declined = client.post(
        f"/api/tasks/{task_id}/customer-confirmation/manual",
        headers=auth_headers(admin_token),
        json={"action": "decline", "method": "phone", "notes": "Passt nicht"},
    )
    assert declined.status_code == 200, declined.text
    assert declined.json()["customer_confirmation_status"] == "declined"
    with SessionLocal() as db:
        # The decline burned the link — this is what made it a dead end.
        assert db.get(Task, task_id).customer_confirmation_token is None

    new_due = (date.today() + timedelta(days=28)).isoformat()
    response = client.patch(
        f"/api/tasks/{task_id}",
        headers=auth_headers(admin_token),
        json={"due_date": new_due},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["customer_confirmation_status"] == "pending"
    assert body["customer_confirmation_at"] is None
    # The reason for the "no" is not collateral of reopening the round —
    # it is the most useful thing on the row when the office rings back.
    assert body["customer_confirmation_notes"] == "Passt nicht"
    with SessionLocal() as db:
        # A fresh token exists, so the customer can be asked about date Y.
        token = db.get(Task, task_id).customer_confirmation_token
        assert token is not None and len(token) == 32


def test_failed_send_without_customer_email_keeps_the_phone_confirmation(
    client: TestClient, admin_token: str
):
    """Bug 3, the one that matters: the no-address path must not mutate.

    Every confirmation recorded in production so far arrived by phone.
    The old dispatcher reset the state BEFORE checking for an address,
    so an operator who clicked "E-Mail senden" on a customer with no
    email got an error message and silently lost the confirmation they
    had just written down."""
    project_id, _ = _seed_project_with_emailless_customer(client, admin_token)
    task_id = _create_confirmation_task(client, admin_token, project_id)

    manual = client.post(
        f"/api/tasks/{task_id}/customer-confirmation/manual",
        headers=auth_headers(admin_token),
        json={
            "action": "confirm",
            "method": "phone",
            "notes": "Hr. Schmidt am Telefon, kommt um 8",
        },
    )
    assert manual.status_code == 200, manual.text
    confirmed_at = manual.json()["customer_confirmation_at"]
    assert confirmed_at is not None

    response = client.post(
        f"/api/tasks/{task_id}/customer-confirmation/email",
        headers=auth_headers(admin_token),
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["sent"] is False
    assert "no customer email" in (body["error_detail"] or "")

    # Nothing was touched: the phone confirmation is still the truth.
    with SessionLocal() as db:
        task = db.get(Task, task_id)
        assert task.customer_confirmation_status == "confirmed"
        assert task.customer_confirmation_method == "phone"
        assert task.customer_confirmation_at is not None
        assert task.customer_confirmation_by_user_id is not None
        assert "Hr. Schmidt" in (task.customer_confirmation_notes or "")
        # No token was minted either — no round was started.
        assert task.customer_confirmation_token is None

    # And it still reads back over the API, which is what feeds the badge.
    rows = client.get(
        f"/api/tasks?project_id={project_id}", headers=auth_headers(admin_token)
    )
    assert rows.status_code == 200, rows.text
    row = next(item for item in rows.json() if item["id"] == task_id)
    assert row["customer_confirmation_status"] == "confirmed"
    assert "Hr. Schmidt" in (row["customer_confirmation_notes"] or "")


def test_unconfigured_smtp_restores_the_previous_confirmation(
    client: TestClient, admin_token: str
):
    """Bug 3, second half: a failure that never reached the wire must
    not cost the operator their confirmation.

    SMTP is unconfigured in the test env, which is also the state this
    deployment has been in for its entire life — zero successful sends
    ever. ``emailer.send_email_detailed`` returns ``not_configured``
    before the EmailMessage is even built, so no message exists, no
    socket was opened, and nothing has happened that could void the
    previous round. The task must come back exactly as it was."""
    project_id, _, _ = _seed_project_with_customer(client, admin_token)
    task_id = _create_confirmation_task(client, admin_token, project_id)
    manual = client.post(
        f"/api/tasks/{task_id}/customer-confirmation/manual",
        headers=auth_headers(admin_token),
        json={
            "action": "confirm",
            "method": "phone",
            "notes": "Hr. Schmidt: Termin bleibt",
        },
    )
    assert manual.status_code == 200, manual.text

    response = client.post(
        f"/api/tasks/{task_id}/customer-confirmation/email",
        headers=auth_headers(admin_token),
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["sent"] is False
    assert body["error_detail"]  # the operator still sees the real reason
    assert body["sent_at"] is None

    with SessionLocal() as db:
        task = db.get(Task, task_id)
        assert task.customer_confirmation_status == "confirmed"
        assert task.customer_confirmation_method == "phone"
        assert task.customer_confirmation_at is not None
        assert task.customer_confirmation_by_user_id is not None
        assert "Hr. Schmidt" in (task.customer_confirmation_notes or "")
        # The manual entry had burned the token; the restore puts that
        # back too, rather than leaving a live link nobody mailed.
        assert task.customer_confirmation_token is None
        assert task.customer_confirmation_email_sent_at is None


@pytest.mark.parametrize(
    "error_type", ["not_configured", "connect", "auth", "sender"]
)
def test_pre_wire_send_failures_restore_the_previous_round(
    client: TestClient, admin_token: str, monkeypatch: pytest.MonkeyPatch, error_type: str
):
    """The full pre-wire set, pinned against ``emailer.py``'s real tags.

    ``not_configured`` never builds a message; ``connect`` is
    SMTPConnectError and never opens a session; ``auth`` is raised out of
    ``client.login()``, which precedes MAIL FROM; ``sender`` is refused
    AT MAIL FROM — before any recipient or body is offered. None of them
    reaches DATA, so none can have delivered a token, and each one rolls
    the task back to the confirmation it had.

    ``auth`` matters most in practice: SMTP has never been configured in
    this deployment, so a wrong password is the most likely first real
    failure the moment somebody fills the settings in — precisely when an
    operator must not also lose the phone confirmation they just took."""
    from app.services import customer_confirmation_email as mail_module
    from app.services.emailer import EmailSendResult

    project_id, _, _ = _seed_project_with_customer(client, admin_token)
    task_id = _create_confirmation_task(client, admin_token, project_id)
    client.post(
        f"/api/tasks/{task_id}/customer-confirmation/manual",
        headers=auth_headers(admin_token),
        json={"action": "confirm", "method": "phone", "notes": "am Telefon bestätigt"},
    )
    # Stamp a send time the way an earlier successful send would have.
    # The reset clears it; a pre-wire restore has to put it back, because
    # the round it belongs to is still the live one.
    prior_sent_at = datetime.now(timezone.utc).replace(microsecond=0)
    with SessionLocal() as db:
        before = db.get(Task, task_id)
        before.customer_confirmation_email_sent_at = prior_sent_at
        db.commit()
        prior_at = before.customer_confirmation_at

    monkeypatch.setattr(
        mail_module,
        "send_customer_confirmation_email",
        lambda **kwargs: EmailSendResult(
            ok=False, error_type=error_type, error_detail=f"simulated {error_type}"
        ),
    )
    response = client.post(
        f"/api/tasks/{task_id}/customer-confirmation/email",
        headers=auth_headers(admin_token),
    )
    assert response.status_code == 200, response.text
    assert response.json()["sent"] is False

    with SessionLocal() as db:
        task = db.get(Task, task_id)
        assert task.customer_confirmation_status == "confirmed"
        assert task.customer_confirmation_method == "phone"
        assert task.customer_confirmation_at == prior_at
        assert task.customer_confirmation_token is None
        assert "am Telefon" in (task.customer_confirmation_notes or "")
        # The reset cleared the send time; the restore brings it back,
        # because no new token was minted after all and the old round is
        # still the live one. Without the column in the snapshot this is
        # the assertion that catches it.
        restored = task.customer_confirmation_email_sent_at
        assert restored is not None
        assert restored.replace(tzinfo=timezone.utc) == prior_sent_at


@pytest.mark.parametrize(
    "error_type", ["timeout", "smtp", "unknown", "network", "recipient"]
)
def test_possibly_delivered_send_failures_keep_the_fresh_round(
    client: TestClient, admin_token: str, monkeypatch: pytest.MonkeyPatch, error_type: str
):
    """The other branch, and the deliberate asymmetry.

    These kinds may have reached the server — a timeout or a dropped
    connection after DATA leaves a message it may well have accepted,
    carrying a live token. Rolling back to "confirmed" would show the
    board a settled appointment the customer can still flip from under
    it, and no screen can repair that. Re-recording a phone
    confirmation is one click, so the reset stays.

    ``network`` is the one worth naming. It is the emailer's generic
    OSError catch-all — broken pipe, connection reset — and it can fire
    at ANY point, including after ``send_message`` wrote the body. It
    used to be tagged "connect" and so was restored as pre-wire, which
    is exactly the case the pre-wire set's own comment forbids: rolling
    back to "confirmed" while a live token sits in the inbox. Splitting
    the tag is what makes this row correct.

    The notes still survive: that is Bug 1's rule and it is orthogonal
    to which branch the send failure takes."""
    from app.services import customer_confirmation_email as mail_module
    from app.services.emailer import EmailSendResult

    project_id, _, _ = _seed_project_with_customer(client, admin_token)
    task_id = _create_confirmation_task(client, admin_token, project_id)
    client.post(
        f"/api/tasks/{task_id}/customer-confirmation/manual",
        headers=auth_headers(admin_token),
        json={"action": "confirm", "method": "phone", "notes": "am Telefon bestätigt"},
    )

    monkeypatch.setattr(
        mail_module,
        "send_customer_confirmation_email",
        lambda **kwargs: EmailSendResult(
            ok=False, error_type=error_type, error_detail=f"simulated {error_type}"
        ),
    )
    response = client.post(
        f"/api/tasks/{task_id}/customer-confirmation/email",
        headers=auth_headers(admin_token),
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["sent"] is False
    assert body["sent_at"] is None

    with SessionLocal() as db:
        task = db.get(Task, task_id)
        assert task.customer_confirmation_status == "pending"
        assert task.customer_confirmation_at is None
        assert task.customer_confirmation_method is None
        # A fresh token was minted for the round the operator asked for.
        assert task.customer_confirmation_token is not None
        assert task.customer_confirmation_email_sent_at is None
        # Bug 1: the phone note is not collateral of a failed send.
        assert "am Telefon" in (task.customer_confirmation_notes or "")


def test_manual_confirmation_emits_task_updated_event(
    client: TestClient, admin_token: str, monkeypatch: pytest.MonkeyPatch
):
    """Bug 4a: the manual endpoint committed without an SSE event, so an
    open planning board kept showing the pre-confirmation pill until
    somebody reloaded."""
    from app.routers import workflow_tasks

    project_id, _, _ = _seed_project_with_customer(client, admin_token)
    task_id = _create_confirmation_task(client, admin_token, project_id)

    events: list[tuple[str, dict]] = []
    monkeypatch.setattr(
        workflow_tasks,
        "notify",
        lambda db, event_type, payload: events.append((event_type, payload)),
    )
    response = client.post(
        f"/api/tasks/{task_id}/customer-confirmation/manual",
        headers=auth_headers(admin_token),
        json={"action": "confirm", "method": "phone"},
    )
    assert response.status_code == 200, response.text

    updated = [payload for kind, payload in events if kind == "task.updated"]
    assert len(updated) == 1
    assert updated[0]["id"] == task_id
    assert updated[0]["customer_confirmation_status"] == "confirmed"
    # Full TaskOut payload, same as the PATCH path — the board renders the
    # row from it, so the planning axis has to ride along untouched.
    assert updated[0]["project_id"] == project_id
    assert "planning_status" in updated[0]
    assert updated[0]["status"] == "open"


def test_public_confirmation_emits_task_updated_event(
    client: TestClient, admin_token: str, monkeypatch: pytest.MonkeyPatch
):
    """Bug 4b: the customer clicking the link is the one write path with
    nobody logged in to notice it — it needs the event most."""
    from app.routers import workflow_tasks

    project_id, _, _ = _seed_project_with_customer(client, admin_token)
    task_id = _create_confirmation_task(client, admin_token, project_id)
    with SessionLocal() as db:
        token = db.get(Task, task_id).customer_confirmation_token
    assert token

    events: list[tuple[str, dict]] = []
    monkeypatch.setattr(
        workflow_tasks,
        "notify",
        lambda db, event_type, payload: events.append((event_type, payload)),
    )
    response = client.post(
        f"/api/public/customer-confirmations/{token}",
        json={"action": "decline"},
    )
    assert response.status_code == 200, response.text
    assert response.json()["confirmation_status"] == "declined"

    updated = [payload for kind, payload in events if kind == "task.updated"]
    assert len(updated) == 1
    assert updated[0]["id"] == task_id
    assert updated[0]["customer_confirmation_status"] == "declined"
    assert updated[0]["project_id"] == project_id


def test_public_confirmation_event_for_a_task_without_a_project(
    client: TestClient, admin_token: str, monkeypatch: pytest.MonkeyPatch
):
    """A customer-only task has no project_id, and the public endpoint can
    absolutely be hit by one. The payload carries ``project_id: null``,
    which the SSE filter routes to admins only — the same thing
    create/update/delete already do for these tasks. Pinned so nobody
    "fixes" it into a crash or a leak."""
    from app.routers import workflow_tasks

    cust = client.post(
        "/api/customers",
        headers=auth_headers(admin_token),
        json={
            "name": "Projectless Customer",
            "email": "projectless@example.com",
            "language": "de",
        },
    )
    assert cust.status_code == 200, cust.text
    customer_id = cust.json()["id"]

    created = client.post(
        "/api/tasks",
        headers=auth_headers(admin_token),
        json={
            "customer_id": customer_id,
            "title": "Service call",
            "task_type": "construction",
            "due_date": (date.today() + timedelta(days=5)).isoformat(),
            "request_customer_confirmation": True,
        },
    )
    assert created.status_code == 200, created.text
    task_id = created.json()["id"]
    assert created.json()["project_id"] is None
    with SessionLocal() as db:
        token = db.get(Task, task_id).customer_confirmation_token
    assert token

    events: list[tuple[str, dict]] = []
    monkeypatch.setattr(
        workflow_tasks,
        "notify",
        lambda db, event_type, payload: events.append((event_type, payload)),
    )
    response = client.post(
        f"/api/public/customer-confirmations/{token}",
        json={"action": "confirm"},
    )
    assert response.status_code == 200, response.text

    updated = [payload for kind, payload in events if kind == "task.updated"]
    assert len(updated) == 1
    assert updated[0]["project_id"] is None
    assert updated[0]["customer_confirmation_status"] == "confirmed"


def test_idempotent_public_repost_emits_no_event(
    client: TestClient, admin_token: str, monkeypatch: pytest.MonkeyPatch
):
    """The early-return branch changes nothing, so it must stay silent —
    an event with no state change would make every board re-render for
    nothing."""
    from app.routers import workflow_tasks

    project_id, _, _ = _seed_project_with_customer(client, admin_token)
    task_id = _create_confirmation_task(client, admin_token, project_id)
    with SessionLocal() as db:
        task = db.get(Task, task_id)
        token = task.customer_confirmation_token
        # Pre-set "confirmed" while KEEPING the token, which is the only
        # way to reach the idempotent branch (the public POST burns it).
        task.customer_confirmation_status = "confirmed"
        db.commit()

    events: list[tuple[str, dict]] = []
    monkeypatch.setattr(
        workflow_tasks,
        "notify",
        lambda db, event_type, payload: events.append((event_type, payload)),
    )
    response = client.post(
        f"/api/public/customer-confirmations/{token}",
        json={"action": "decline"},
    )
    assert response.status_code == 200, response.text
    assert response.json()["confirmation_status"] == "confirmed"  # not flipped
    assert [kind for kind, _ in events if kind == "task.updated"] == []


# ── v2.14.24 regression tests: the note, the send round, the checkbox ────
#
# Confirmation evidence splits in two, and the round before this one
# conflated them:
#
#   * ``customer_confirmation_notes`` records WHAT A HUMAN AGREED. It must
#     survive a reschedule — destroying it on a routine date change was
#     the bug fixed above — but it must not silently attach itself to a
#     LATER, different verdict.
#   * ``customer_confirmation_email_sent_at`` is a fact about ONE round's
#     link. A reset mints a new token, killing the old link, so the old
#     timestamp describes a round that no longer exists.


def _record_manual(
    client: TestClient,
    admin_token: str,
    task_id: int,
    action: str,
    *,
    notes: str | None = None,
) -> dict:
    """POST the manual confirm/decline endpoint. ``notes=None`` sends no
    notes key at all — the operator leaving the box empty, which is the
    shape that used to inherit the previous round's note."""
    payload: dict = {"action": action, "method": "phone"}
    if notes is not None:
        payload["notes"] = notes
    response = client.post(
        f"/api/tasks/{task_id}/customer-confirmation/manual",
        headers=auth_headers(admin_token),
        json=payload,
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_a_later_verdict_without_a_note_does_not_inherit_the_old_one(
    client: TestClient, admin_token: str
):
    """The office's actual sequence, end to end.

    The customer declines Tuesday ("Passt nicht"). The office reschedules
    — which keeps the note, correctly, because it is the most useful
    thing on the row when they ring back. They ring back, the customer
    agrees, and the operator clicks "Kunde hat zugesagt" with the note box
    empty. The task then read "zugesagt" with "Passt nicht" attached as
    its evidence: a note written about one answer presented as the reason
    for the opposite one."""
    project_id, _, _ = _seed_project_with_customer(client, admin_token)
    task_id = _create_confirmation_task(client, admin_token, project_id)

    declined = _record_manual(
        client, admin_token, task_id, "decline", notes="Passt nicht"
    )
    assert declined["customer_confirmation_status"] == "declined"

    # Reschedule: the note survives, and must (that is the other rule).
    moved = client.patch(
        f"/api/tasks/{task_id}",
        headers=auth_headers(admin_token),
        json={"due_date": (date.today() + timedelta(days=30)).isoformat()},
    )
    assert moved.status_code == 200, moved.text
    assert moved.json()["customer_confirmation_notes"] == "Passt nicht"

    # The ring-back. No note typed this time.
    confirmed = _record_manual(client, admin_token, task_id, "confirm")
    assert confirmed["customer_confirmation_status"] == "confirmed"
    assert confirmed["customer_confirmation_notes"] is None
    with SessionLocal() as db:
        assert db.get(Task, task_id).customer_confirmation_notes is None


def test_an_explicit_note_still_replaces_the_previous_one(
    client: TestClient, admin_token: str
):
    """The other half of the same rule: supplying a note overwrites, as
    it always did. Clearing on an empty box must not become "notes are
    now append-only" or "notes can no longer be corrected"."""
    project_id, _, _ = _seed_project_with_customer(client, admin_token)
    task_id = _create_confirmation_task(client, admin_token, project_id)

    _record_manual(client, admin_token, task_id, "decline", notes="Passt nicht")
    confirmed = _record_manual(
        client,
        admin_token,
        task_id,
        "confirm",
        notes="Frau Weber: kommt um 8, Schlüssel bei der Nachbarin",
    )
    assert confirmed["customer_confirmation_notes"] == (
        "Frau Weber: kommt um 8, Schlüssel bei der Nachbarin"
    )
    assert "Passt nicht" not in (confirmed["customer_confirmation_notes"] or "")


def test_an_empty_note_string_clears_rather_than_storing_blank(
    client: TestClient, admin_token: str
):
    """A modal that always sends the field sends ``""`` for an empty box.
    That is "no note for this verdict", not "a note that is blank"."""
    project_id, _, _ = _seed_project_with_customer(client, admin_token)
    task_id = _create_confirmation_task(client, admin_token, project_id)

    _record_manual(client, admin_token, task_id, "decline", notes="Passt nicht")
    confirmed = _record_manual(client, admin_token, task_id, "confirm", notes="   ")
    assert confirmed["customer_confirmation_notes"] is None


def test_public_confirmation_clears_the_previous_rounds_note(
    client: TestClient, admin_token: str
):
    """The customer clicking a link never supplies a note, so it always
    clears. A click says nothing about the phone call that produced the
    old note, and leaving it attached would present it as the reason for
    an answer the customer gave in a browser."""
    project_id, _, _ = _seed_project_with_customer(client, admin_token)
    task_id = _create_confirmation_task(client, admin_token, project_id)

    _record_manual(client, admin_token, task_id, "decline", notes="Passt nicht")
    # Reschedule to reopen the round and mint a fresh link.
    moved = client.patch(
        f"/api/tasks/{task_id}",
        headers=auth_headers(admin_token),
        json={"due_date": (date.today() + timedelta(days=30)).isoformat()},
    )
    assert moved.status_code == 200, moved.text
    assert moved.json()["customer_confirmation_notes"] == "Passt nicht"
    with SessionLocal() as db:
        token = db.get(Task, task_id).customer_confirmation_token
    assert token

    response = client.post(
        f"/api/public/customer-confirmations/{token}", json={"action": "confirm"}
    )
    assert response.status_code == 200, response.text
    assert response.json()["confirmation_status"] == "confirmed"
    with SessionLocal() as db:
        task = db.get(Task, task_id)
        assert task.customer_confirmation_status == "confirmed"
        assert task.customer_confirmation_notes is None


@pytest.mark.parametrize("verdict", ["confirm", "decline"])
def test_ticking_request_confirmation_on_an_answered_task_is_a_noop(
    client: TestClient, admin_token: str, verdict: str
):
    """Tidying a checkbox must never destroy a recorded verdict.

    The modal sends ``request_customer_confirmation`` on every Save — it
    reflects "this task wants a confirmation", which stays true after the
    customer answers. So editing the title of a confirmed task re-sent
    ``true`` and silently wiped the verdict, its timestamp, its method
    and the operator who took it. A genuine re-ask goes through the
    explicit email/manual controls."""
    project_id, _, _ = _seed_project_with_customer(client, admin_token)
    task_id = _create_confirmation_task(client, admin_token, project_id)

    recorded = _record_manual(
        client, admin_token, task_id, verdict, notes="am Telefon geklärt"
    )
    expected_status = "confirmed" if verdict == "confirm" else "declined"
    assert recorded["customer_confirmation_status"] == expected_status
    recorded_at = recorded["customer_confirmation_at"]
    assert recorded_at is not None

    response = client.patch(
        f"/api/tasks/{task_id}",
        headers=auth_headers(admin_token),
        json={
            "title": "Install device (Zähler getauscht)",
            "request_customer_confirmation": True,
        },
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["title"] == "Install device (Zähler getauscht)"
    # Everything about the answer is untouched.
    assert body["customer_confirmation_status"] == expected_status
    assert body["customer_confirmation_at"] == recorded_at
    assert body["customer_confirmation_method"] == "phone"
    assert body["customer_confirmation_by_user_id"] is not None
    assert body["customer_confirmation_notes"] == "am Telefon geklärt"
    with SessionLocal() as db:
        task = db.get(Task, task_id)
        assert task.customer_confirmation_status == expected_status
        # No fresh round was started, so no new link was minted either.
        assert task.customer_confirmation_token is None


def test_ticking_request_confirmation_still_starts_a_round_when_unanswered(
    client: TestClient, admin_token: str
):
    """The no-op is scoped to an ANSWERED task. A task sitting at pending
    or at nothing still gets its round when the box is ticked — otherwise
    the checkbox stops working for its actual purpose."""
    project_id, _, _ = _seed_project_with_customer(client, admin_token)
    due = (date.today() + timedelta(days=7)).isoformat()
    task_id = client.post(
        "/api/tasks",
        headers=auth_headers(admin_token),
        json={
            "project_id": project_id,
            "title": "No confirmation yet",
            "task_type": "construction",
            "due_date": due,
        },
    ).json()["id"]
    with SessionLocal() as db:
        assert db.get(Task, task_id).customer_confirmation_status is None

    response = client.patch(
        f"/api/tasks/{task_id}",
        headers=auth_headers(admin_token),
        json={"request_customer_confirmation": True},
    )
    assert response.status_code == 200, response.text
    assert response.json()["customer_confirmation_status"] == "pending"
    with SessionLocal() as db:
        token = db.get(Task, task_id).customer_confirmation_token
    assert token is not None and len(token) == 32


@pytest.mark.parametrize("verdict", ["confirm", "decline"])
def test_unticking_request_confirmation_still_clears_a_recorded_verdict(
    client: TestClient, admin_token: str, verdict: str
):
    """``false`` keeps its clearing behaviour. It is the only escape
    hatch for a mis-recorded confirmation — the operator saying "this
    task does not need one" — and the no-op above must not close it."""
    project_id, _, _ = _seed_project_with_customer(client, admin_token)
    task_id = _create_confirmation_task(client, admin_token, project_id)
    _record_manual(client, admin_token, task_id, verdict, notes="falsch notiert")

    response = client.patch(
        f"/api/tasks/{task_id}",
        headers=auth_headers(admin_token),
        json={"request_customer_confirmation": False},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["customer_confirmation_status"] is None
    assert body["customer_confirmation_at"] is None
    assert body["customer_confirmation_method"] is None
    assert body["customer_confirmation_notes"] is None
    assert body["customer_confirmation_email_sent_at"] is None
    with SessionLocal() as db:
        assert db.get(Task, task_id).customer_confirmation_token is None


def test_rescheduling_with_the_box_still_ticked_still_resets_the_verdict(
    client: TestClient, admin_token: str
):
    """The no-op must be a no-op, not a suppressor.

    The modal sends the ticked box alongside the new date, so if "already
    answered → do nothing" also counted as "the toggle handled the
    confirmation state", the due-date reset below it would be skipped and
    the customer's yes for date X would ride along to date Y. That is the
    one invariant this feature has."""
    project_id, _, _ = _seed_project_with_customer(client, admin_token)
    task_id = _create_confirmation_task(client, admin_token, project_id)
    _record_manual(client, admin_token, task_id, "confirm", notes="Termin bestätigt")

    response = client.patch(
        f"/api/tasks/{task_id}",
        headers=auth_headers(admin_token),
        json={
            "due_date": (date.today() + timedelta(days=21)).isoformat(),
            "request_customer_confirmation": True,
        },
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["customer_confirmation_status"] == "pending"
    assert body["customer_confirmation_at"] is None
    assert body["customer_confirmation_method"] is None
    # The note is the record of the call and survives the reschedule.
    assert body["customer_confirmation_notes"] == "Termin bestätigt"
    with SessionLocal() as db:
        token = db.get(Task, task_id).customer_confirmation_token
    assert token is not None and len(token) == 32


def _task_row(client: TestClient, admin_token: str, project_id: int, task_id: int) -> dict:
    rows = client.get(
        f"/api/tasks?project_id={project_id}", headers=auth_headers(admin_token)
    )
    assert rows.status_code == 200, rows.text
    return next(item for item in rows.json() if item["id"] == task_id)


def test_email_endpoint_returns_the_tasks_new_updated_at(
    client: TestClient, admin_token: str, monkeypatch: pytest.MonkeyPatch
):
    """Bug 4a: the send commits, so ``updated_at`` moves — and the modal
    that fired the request is still open holding the old one.

    The endpoint returned only ``sent`` / ``sent_at`` / ``error_detail``,
    so the operator's next Save 409'd on a conflict our own button
    caused, with nothing on screen to explain it. A possibly-delivered
    failure is used here because it is the branch that keeps the fresh
    round — the row genuinely changes, which is what moves the token."""
    from app.services import customer_confirmation_email as mail_module
    from app.services.emailer import EmailSendResult

    project_id, _, _ = _seed_project_with_customer(client, admin_token)
    task_id = _create_confirmation_task(client, admin_token, project_id)
    stale_updated_at = _task_row(client, admin_token, project_id, task_id)["updated_at"]
    assert stale_updated_at is not None

    monkeypatch.setattr(
        mail_module,
        "send_customer_confirmation_email",
        lambda **kwargs: EmailSendResult(
            ok=False, error_type="timeout", error_detail="simulated timeout"
        ),
    )
    response = client.post(
        f"/api/tasks/{task_id}/customer-confirmation/email",
        headers=auth_headers(admin_token),
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["sent"] is False
    # The response reports the state the task is actually in now.
    assert body["updated_at"] is not None
    assert body["updated_at"] == _task_row(client, admin_token, project_id, task_id)["updated_at"]
    assert body["updated_at"] != stale_updated_at

    # What the operator hit before: a Save pinned to the pre-send token.
    conflict = client.patch(
        f"/api/tasks/{task_id}",
        headers=auth_headers(admin_token),
        json={"title": "Renamed", "expected_updated_at": stale_updated_at},
    )
    assert conflict.status_code == 409, conflict.text

    # With the value the endpoint now hands back, the same Save goes through.
    saved = client.patch(
        f"/api/tasks/{task_id}",
        headers=auth_headers(admin_token),
        json={"title": "Renamed", "expected_updated_at": body["updated_at"]},
    )
    assert saved.status_code == 200, saved.text
    assert saved.json()["title"] == "Renamed"


def test_email_endpoint_updated_at_matches_on_the_restore_branch_too(
    client: TestClient, admin_token: str
):
    """The pre-wire branch puts the row back exactly as it was, so there
    may be nothing to bump — the response must still report the task's
    real current token rather than omitting it. SMTP is unconfigured in
    tests, so this is that branch."""
    project_id, _, _ = _seed_project_with_customer(client, admin_token)
    task_id = _create_confirmation_task(client, admin_token, project_id)

    response = client.post(
        f"/api/tasks/{task_id}/customer-confirmation/email",
        headers=auth_headers(admin_token),
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["sent"] is False
    assert body["updated_at"] is not None
    assert body["updated_at"] == _task_row(client, admin_token, project_id, task_id)["updated_at"]

    saved = client.patch(
        f"/api/tasks/{task_id}",
        headers=auth_headers(admin_token),
        json={"title": "Renamed", "expected_updated_at": body["updated_at"]},
    )
    assert saved.status_code == 200, saved.text


def test_email_endpoint_emits_task_updated_event(
    client: TestClient, admin_token: str, monkeypatch: pytest.MonkeyPatch
):
    """Bug 4b: the send flips the confirmation pill on every open board
    (to pending, or back to whatever a pre-wire restore put back), and
    nothing told them. Same full-TaskOut ``task.updated`` the manual and
    public paths push."""
    from app.routers import workflow_tasks

    project_id, _, _ = _seed_project_with_customer(client, admin_token)
    task_id = _create_confirmation_task(client, admin_token, project_id)

    events: list[tuple[str, dict]] = []
    monkeypatch.setattr(
        workflow_tasks,
        "notify",
        lambda db, event_type, payload: events.append((event_type, payload)),
    )
    response = client.post(
        f"/api/tasks/{task_id}/customer-confirmation/email",
        headers=auth_headers(admin_token),
    )
    assert response.status_code == 200, response.text

    updated = [payload for kind, payload in events if kind == "task.updated"]
    assert len(updated) == 1
    assert updated[0]["id"] == task_id
    assert updated[0]["project_id"] == project_id
    # Full TaskOut, so the board can render the row straight from it.
    assert "planning_status" in updated[0]
    assert "customer_confirmation_status" in updated[0]
    assert updated[0]["updated_at"] == response.json()["updated_at"]
