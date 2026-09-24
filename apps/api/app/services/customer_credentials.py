"""Zugangsdaten — the installation's logins kept with the customer.

The secret is the only thing this module treats differently from ordinary
customer data: it is Fernet-encrypted through ``secret_box`` (the same box
the wholesaler password lives in), it is never part of a list projection,
and ``reveal`` — the one way to read it — stamps the row, writes the
customer's change log and the admin audit log. Everything else (label,
username, URL, notes) is plain text a fitter needs to read at a glance.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.time import utcnow
from app.models.entities import CustomerCredential, User
from app.schemas.customer import CustomerCredentialCreate, CustomerCredentialOut, CustomerCredentialUpdate
from app.services.audit import log_admin_action
from app.services.customer_activity import record_customer_activity
from app.services.secret_box import decrypt_secret, encrypt_secret

AUDIT_CATEGORY = "customer"
AUDIT_REVEAL_ACTION = "customer_credential.reveal"

EVENT_CREATED = "customer.credential_created"
EVENT_UPDATED = "customer.credential_updated"
EVENT_DELETED = "customer.credential_deleted"
EVENT_REVEALED = "customer.credential_revealed"

CATEGORY_LABELS: dict[str, str] = {
    "inverter": "Wechselrichter",
    "wallbox": "Wallbox",
    "storage": "Speicher",
    "heatpump": "Wärmepumpe",
    "router": "Router",
    "portal": "Portal",
    "other": "Zugang",
}


def customer_credentials(db: Session, customer_id: int) -> list[CustomerCredential]:
    return list(
        db.scalars(
            select(CustomerCredential)
            .where(CustomerCredential.customer_id == customer_id)
            .order_by(CustomerCredential.label.asc(), CustomerCredential.id.asc())
        )
    )


def _names(db: Session, rows: list[CustomerCredential]) -> dict[int, str]:
    ids = {uid for row in rows for uid in (row.created_by, row.updated_by, row.last_revealed_by) if uid}
    if not ids:
        return {}
    return {user.id: user.display_name for user in db.scalars(select(User).where(User.id.in_(ids)))}


def credentials_out(db: Session, rows: list[CustomerCredential]) -> list[CustomerCredentialOut]:
    names = _names(db, rows)
    return [
        CustomerCredentialOut(
            id=row.id,
            customer_id=row.customer_id,
            label=row.label,
            category=row.category,
            username=row.username,
            url=row.url,
            notes=row.notes,
            has_secret=bool(row.secret_encrypted),
            created_at=row.created_at,
            updated_at=row.updated_at,
            created_by_name=names.get(row.created_by) if row.created_by else None,
            updated_by_name=names.get(row.updated_by) if row.updated_by else None,
            last_revealed_at=row.last_revealed_at,
            last_revealed_by_name=names.get(row.last_revealed_by) if row.last_revealed_by else None,
        )
        for row in rows
    ]


def _describe(row: CustomerCredential) -> str:
    return f"{CATEGORY_LABELS.get(row.category, 'Zugang')} „{row.label}“"


def create_credential(db: Session, *, customer_id: int, payload: CustomerCredentialCreate, actor: User) -> CustomerCredential:
    """Added to the session with its change-log row; the caller commits."""
    row = CustomerCredential(
        customer_id=customer_id,
        label=payload.label,
        category=payload.category,
        username=payload.username,
        secret_encrypted=encrypt_secret(payload.secret) if payload.secret else None,
        url=payload.url,
        notes=payload.notes,
        created_by=actor.id,
        updated_by=actor.id,
    )
    db.add(row)
    db.flush()
    record_customer_activity(
        db,
        customer_id=customer_id,
        actor_user_id=actor.id,
        event_type=EVENT_CREATED,
        message=f"{_describe(row)} angelegt",
        details={"credential_id": row.id, "label": row.label, "category": row.category},
    )
    return row


def update_credential(db: Session, *, row: CustomerCredential, payload: CustomerCredentialUpdate, actor: User) -> CustomerCredential:
    """``secret`` absent keeps it, ``""`` clears it, text replaces it."""
    data = payload.model_dump(exclude_unset=True)
    secret_changed = False
    if "secret" in data:
        secret = data.pop("secret")
        row.secret_encrypted = encrypt_secret(secret) if secret else None
        secret_changed = True
    for field, value in data.items():
        setattr(row, field, value)
    row.updated_by = actor.id
    row.updated_at = utcnow()
    db.add(row)
    changed = sorted(data.keys()) + (["secret"] if secret_changed else [])
    record_customer_activity(
        db,
        customer_id=row.customer_id,
        actor_user_id=actor.id,
        event_type=EVENT_UPDATED,
        message=f"{_describe(row)} geändert",
        details={"credential_id": row.id, "label": row.label, "fields": changed},
    )
    return row


def delete_credential(db: Session, *, row: CustomerCredential, actor: User) -> None:
    record_customer_activity(
        db,
        customer_id=row.customer_id,
        actor_user_id=actor.id,
        event_type=EVENT_DELETED,
        message=f"{_describe(row)} gelöscht",
        details={"credential_id": row.id, "label": row.label, "category": row.category},
    )
    db.delete(row)


def reveal_credential(db: Session, *, row: CustomerCredential, actor: User) -> tuple[str, datetime]:
    """The secret in clear, with the row stamped and both logs written.

    Commits: the change-log row and the reveal stamp must be on disk
    before the secret leaves the server, and ``log_admin_action`` commits
    on its own anyway.
    """
    secret = decrypt_secret(row.secret_encrypted)
    now = utcnow()
    row.last_revealed_at = now
    row.last_revealed_by = actor.id
    db.add(row)
    record_customer_activity(
        db,
        customer_id=row.customer_id,
        actor_user_id=actor.id,
        event_type=EVENT_REVEALED,
        message=f"Passwort von {_describe(row)} angezeigt",
        details={"credential_id": row.id, "label": row.label},
    )
    db.commit()
    log_admin_action(
        db,
        actor,
        AUDIT_REVEAL_ACTION,
        "customer_credential",
        str(row.id),
        {"customer_id": row.customer_id, "label": row.label, "category": row.category},
        category=AUDIT_CATEGORY,
    )
    return secret, now
