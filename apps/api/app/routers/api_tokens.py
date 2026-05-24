"""Personal Access Token (PAT) management router.

Three endpoints, all scoped to the *current* user — minting, listing,
and revoking happen only against the caller's own row. Admins do not
get a cross-user view here; if they need to suspend a user's
programmatic access they flip ``api_access_enabled = false`` in the
admin centre, which immediately rejects every PAT the user holds
without us having to enumerate or delete them.

Token format: ``smpl_pat_<43 url-safe base64 chars>`` — 256 bits of
entropy. Detectable by prefix so the auth dep can route correctly,
and recognisable by humans skimming code.
"""
from __future__ import annotations
import hashlib
import secrets
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.deps import API_TOKEN_PREFIX, get_current_user
from app.core.time import utcnow
from app.models.entities import ApiToken, User
from app.schemas.api_token import ApiTokenCreate, ApiTokenCreatedOut, ApiTokenOut
from app.services.audit import log_admin_action

router = APIRouter(prefix="/auth/api-tokens", tags=["api-tokens"])

# 43 url-safe chars after the prefix → ~256 bits of entropy. Generated
# via secrets.token_urlsafe, which is the right primitive (CSPRNG +
# URL-safe alphabet, no padding).
_TOKEN_RANDOM_BYTES = 32  # token_urlsafe returns ~ceil(bytes * 4 / 3) chars


def _mint_raw_token() -> str:
    return f"{API_TOKEN_PREFIX}{secrets.token_urlsafe(_TOKEN_RANDOM_BYTES)}"


def _hash_token(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _require_api_access(user: User) -> None:
    """All endpoints in this router require the per-user gate.

    A user with the gate OFF can't even *see* their tokens (there are
    none yet; the gate prevented minting), and can't mint new ones.
    Existing tokens of a user whose gate gets turned off later remain
    in the table — the auth dep rejects them on every request — and
    become visible+revokable again if the admin re-enables the gate.
    """
    if not user.api_access_enabled:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="API access is not enabled for your account. Ask an administrator to enable it.",
        )


@router.get("", response_model=list[ApiTokenOut])
def list_my_tokens(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """List all of the caller's tokens (active + revoked + expired).

    The UI uses the revoked_at / expires_at fields to render each row's
    state. Returning revoked rows too is useful for the audit trail —
    a user can see "yes I revoked that one already" without having to
    cross-check elsewhere.
    """
    _require_api_access(current_user)
    rows = db.scalars(
        select(ApiToken)
        .where(ApiToken.user_id == current_user.id)
        .order_by(ApiToken.created_at.desc())
    ).all()
    return rows


@router.post("", response_model=ApiTokenCreatedOut, status_code=201)
def create_token(
    payload: ApiTokenCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Mint a new PAT.

    The raw token is returned exactly once, in the response body's
    ``token`` field. We store only its sha256 hash in the DB. The
    response status is 201 to signal "resource created" and to make
    "fetch the just-created token" feel correct on the client side.

    Audit-logged: an admin reviewing the audit log later can see
    "user X minted token #Y named Z at time T" — including the
    prefix, which is enough to recognise a token without exposing it.
    """
    _require_api_access(current_user)
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Token name is required")

    raw_token = _mint_raw_token()
    expires_at = None
    if payload.expires_in_days is not None:
        expires_at = utcnow() + timedelta(days=payload.expires_in_days)

    row = ApiToken(
        user_id=current_user.id,
        name=name,
        token_hash=_hash_token(raw_token),
        prefix=raw_token[:12],  # "smpl_pat_XYZ"
        expires_at=expires_at,
    )
    db.add(row)
    db.commit()
    db.refresh(row)

    log_admin_action(
        db,
        current_user,
        "api_token.create",
        "api_token",
        str(row.id),
        details={"name": name, "prefix": row.prefix, "expires_at": str(expires_at) if expires_at else None},
        category="auth",
    )

    # Compose the response by hand — pydantic ``from_attributes`` doesn't
    # know about the (transient) ``token`` field, which lives only on
    # the wire, never on the model.
    return ApiTokenCreatedOut(
        id=row.id,
        name=row.name,
        prefix=row.prefix,
        created_at=row.created_at,
        last_used_at=row.last_used_at,
        expires_at=row.expires_at,
        revoked_at=row.revoked_at,
        token=raw_token,
    )


@router.delete("/{token_id}", status_code=204)
def revoke_token(
    token_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Revoke a PAT.

    We don't hard-delete the row; setting ``revoked_at`` keeps the
    audit trail and the UI can still render "revoked on …" rows. The
    auth dep rejects any token with a non-null ``revoked_at`` on the
    very next request.

    Idempotent: revoking an already-revoked token is a no-op (still
    returns 204). Revoking a token that belongs to a different user
    returns 404, not 403, so we don't leak the existence of someone
    else's token ID.
    """
    _require_api_access(current_user)
    row = db.scalars(
        select(ApiToken).where(
            ApiToken.id == token_id,
            ApiToken.user_id == current_user.id,
        )
    ).first()
    if row is None:
        raise HTTPException(status_code=404, detail="Token not found")
    if row.revoked_at is None:
        row.revoked_at = utcnow()
        db.add(row)
        db.commit()
        log_admin_action(
            db,
            current_user,
            "api_token.revoke",
            "api_token",
            str(row.id),
            details={"name": row.name, "prefix": row.prefix},
            category="auth",
        )
    # 204 No Content
    return None
