"""Zugangsdaten — ``/customers/{id}/credentials``.

Who may open the customer's files (the rule notes and visits use) may list,
add, edit and reveal; deleting is the creator's or a project manager's.
The secret is never in a list response: ``POST …/{id}/reveal`` is the one
call that returns it, and that call is logged twice (customer change log,
admin audit log) — see ``services/customer_credentials.reveal_credential``.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.deps import get_current_user
from app.core.permissions import has_permission_for_user
from app.models.entities import CustomerCredential, User
from app.routers.workflow_helpers import _assert_customer_files_access
from app.schemas.customer import (
    CustomerCredentialCreate,
    CustomerCredentialOut,
    CustomerCredentialRevealOut,
    CustomerCredentialUpdate,
)
from app.services import customer_credentials as vault

router = APIRouter(prefix="", tags=["customer-credentials"])


def _credential_on_customer(db: Session, customer_id: int, credential_id: int) -> CustomerCredential:
    row = db.get(CustomerCredential, credential_id)
    if row is None or row.customer_id != customer_id:
        raise HTTPException(status_code=404, detail="Zugangsdaten nicht gefunden")
    return row


@router.get("/customers/{customer_id}/credentials", response_model=list[CustomerCredentialOut])
def list_customer_credentials(
    customer_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _assert_customer_files_access(db, current_user, customer_id)
    return vault.credentials_out(db, vault.customer_credentials(db, customer_id))


@router.post("/customers/{customer_id}/credentials", response_model=CustomerCredentialOut)
def post_customer_credential(
    customer_id: int,
    payload: CustomerCredentialCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _assert_customer_files_access(db, current_user, customer_id)
    row = vault.create_credential(db, customer_id=customer_id, payload=payload, actor=current_user)
    db.commit()
    db.refresh(row)
    return vault.credentials_out(db, [row])[0]


@router.patch("/customers/{customer_id}/credentials/{credential_id}", response_model=CustomerCredentialOut)
def update_customer_credential(
    customer_id: int,
    credential_id: int,
    payload: CustomerCredentialUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _assert_customer_files_access(db, current_user, customer_id)
    row = _credential_on_customer(db, customer_id, credential_id)
    vault.update_credential(db, row=row, payload=payload, actor=current_user)
    db.commit()
    db.refresh(row)
    return vault.credentials_out(db, [row])[0]


@router.delete("/customers/{customer_id}/credentials/{credential_id}", status_code=204)
def delete_customer_credential(
    customer_id: int,
    credential_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _assert_customer_files_access(db, current_user, customer_id)
    row = _credential_on_customer(db, customer_id, credential_id)
    is_creator = row.created_by is not None and row.created_by == current_user.id
    if not is_creator and not has_permission_for_user(current_user.id, current_user.role, "projects:manage"):
        raise HTTPException(status_code=403, detail="Nur wer den Zugang angelegt hat oder ein Projektleiter darf ihn löschen")
    vault.delete_credential(db, row=row, actor=current_user)
    db.commit()


@router.post("/customers/{customer_id}/credentials/{credential_id}/reveal", response_model=CustomerCredentialRevealOut)
def reveal_customer_credential(
    customer_id: int,
    credential_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _assert_customer_files_access(db, current_user, customer_id)
    row = _credential_on_customer(db, customer_id, credential_id)
    if not row.secret_encrypted:
        raise HTTPException(status_code=404, detail="Für diesen Zugang ist kein Passwort hinterlegt")
    try:
        secret, revealed_at = vault.reveal_credential(db, row=row, actor=current_user)
    except ValueError as exc:
        raise HTTPException(status_code=500, detail="Passwort kann mit dem aktuellen Schlüssel nicht entschlüsselt werden") from exc
    return CustomerCredentialRevealOut(secret=secret, revealed_at=revealed_at)
