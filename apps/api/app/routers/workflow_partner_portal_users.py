"""Partner-portal logins, managed on their partner.

Included from ``workflow.py`` under ``/api``:

  GET  /partners/{id}/portal-users                         list
  POST /partners/{id}/portal-users                         invite a person
  POST /partners/{id}/portal-users/{user_id}/send-link     new invite / password link
  POST /partners/{id}/portal-users/{user_id}/deactivate    lock
  POST /partners/{id}/portal-users/{user_id}/activate      unlock

A portal login is an ordinary ``users`` row with role ``external`` and a
``partner_id``, so it inherits everything the office's own logins have —
bcrypt, lockout after failed attempts, single-use hashed invite and reset
tokens, the audit log. What it does NOT inherit is any access: the fence in
``app.core.deps`` keeps it inside ``/api/portal``.

Permission is ``projects:manage``, the same as the partner itself: whoever
may decide which jobs a subcontractor gets may decide who of theirs sees
them. Every change is written to the admin audit log.
"""

from __future__ import annotations

import secrets

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.deps import require_permission
from app.core.permissions import ROLE_EXTERNAL, is_external_role
from app.core.security import get_password_hash
from app.core.time import utcnow
from app.models.entities import AuditLog, Partner, User, UserActionToken
from app.routers.admin import _build_action_link, _issue_action_token, _normalize_email
from app.schemas.portal import PartnerPortalLinkOut, PartnerPortalUserCreate, PartnerPortalUserOut
from app.services.audit import log_admin_action
from app.services.emailer import send_email_detailed
from app.services.partner_portal import portal_users_of

router = APIRouter(prefix="", tags=["partner-portal-users"])

INVITE_TTL_HOURS = 72
RESET_TTL_HOURS = 24
INVITE_PATH = "/partner/einladung"
RESET_PATH = "/partner/passwort"


def _partner_or_404(db: Session, partner_id: int) -> Partner:
    partner = db.get(Partner, partner_id)
    if partner is None:
        raise HTTPException(status_code=404, detail="Partner not found")
    return partner


def _portal_user_or_404(db: Session, partner: Partner, user_id: int) -> User:
    """A login of THIS partner. Anyone else's id is simply not found here."""
    user = db.get(User, user_id)
    if user is None or not is_external_role(user.role) or user.partner_id != partner.id:
        raise HTTPException(status_code=404, detail="Portal login not found")
    return user


def _status(user: User) -> str:
    if not user.is_active:
        return "disabled"
    if user.invite_accepted_at is None:
        return "invited"
    return "active"


def _last_logins(db: Session, user_ids: list[int]) -> dict[int, object]:
    if not user_ids:
        return {}
    rows = db.execute(
        select(AuditLog.actor_user_id, func.max(AuditLog.created_at))
        .where(AuditLog.action == "auth.login", AuditLog.actor_user_id.in_(user_ids))
        .group_by(AuditLog.actor_user_id)
    ).all()
    return {int(uid): last for uid, last in rows if uid is not None}


def _user_out(user: User, *, last_login_at=None) -> PartnerPortalUserOut:
    return PartnerPortalUserOut(
        id=user.id,
        partner_id=int(user.partner_id or 0),
        full_name=user.full_name,
        email=user.email,
        is_active=bool(user.is_active),
        status=_status(user),
        invite_sent_at=user.invite_sent_at,
        invite_accepted_at=user.invite_accepted_at,
        last_login_at=last_login_at,
        created_at=user.created_at,
    )


def _send_link(
    db: Session,
    request: Request,
    *,
    partner: Partner,
    user: User,
    actor: User,
) -> PartnerPortalLinkOut:
    """Mint the right link for where the login stands, mail it, return it.

    Never accepted → an invite (the person sets a first password). Accepted
    → a password reset. Minting a token burns the previous unused one of the
    same purpose (``_issue_action_token``), so only the newest link works.
    """
    if user.invite_accepted_at is None:
        kind = "invite"
        raw_token, expires_at = _issue_action_token(
            db, user_id=user.id, purpose="invite", created_by=actor.id, ttl_hours=INVITE_TTL_HOURS
        )
        link = _build_action_link(INVITE_PATH, raw_token, request)
        subject = f"Ihr Zugang zum Partnerportal – {partner.name}"
        body = (
            f"Guten Tag {user.full_name},\n\n"
            f"Sie wurden für {partner.name} zum Partnerportal eingeladen. Dort sehen Sie die\n"
            "Aufgaben und Projekte, die wir Ihnen zugewiesen haben – mit Termin, Adresse und Fotos.\n\n"
            f"Passwort festlegen: {link}\n"
            f"Der Link ist {INVITE_TTL_HOURS} Stunden gültig.\n"
        )
        user.invite_sent_at = utcnow()
    else:
        kind = "password_reset"
        raw_token, expires_at = _issue_action_token(
            db, user_id=user.id, purpose="password_reset", created_by=actor.id, ttl_hours=RESET_TTL_HOURS
        )
        link = _build_action_link(RESET_PATH, raw_token, request)
        subject = "Neues Passwort für das Partnerportal"
        body = (
            f"Guten Tag {user.full_name},\n\n"
            "für Ihren Zugang zum Partnerportal wurde ein neues Passwort angefordert.\n\n"
            f"Neues Passwort festlegen: {link}\n"
            f"Der Link ist {RESET_TTL_HOURS} Stunden gültig.\n"
        )
        user.password_reset_sent_at = utcnow()
    db.add(user)
    db.commit()
    db.refresh(user)
    result = send_email_detailed(to_email=user.email, subject=subject, body=body, db=db)
    log_admin_action(
        db,
        actor,
        f"partner.portal_user.{'invite' if kind == 'invite' else 'password_link'}",
        "user",
        str(user.id),
        {"partner_id": partner.id, "email": user.email, "sent": result.ok, "email_error_type": result.error_type},
    )
    return PartnerPortalLinkOut(
        user=_user_out(user, last_login_at=_last_logins(db, [user.id]).get(user.id)),
        kind=kind,
        invite_link=link,
        expires_at=expires_at,
        sent=result.ok,
        email_error_type=result.error_type,
        email_error_detail=result.error_detail,
    )


@router.get("/partners/{partner_id}/portal-users", response_model=list[PartnerPortalUserOut])
def list_portal_users(
    partner_id: int,
    _: User = Depends(require_permission("projects:manage")),
    db: Session = Depends(get_db),
) -> list[PartnerPortalUserOut]:
    partner = _partner_or_404(db, partner_id)
    users = portal_users_of(db, partner.id)
    last = _last_logins(db, [user.id for user in users])
    return [_user_out(user, last_login_at=last.get(user.id)) for user in users]


@router.post("/partners/{partner_id}/portal-users", response_model=PartnerPortalLinkOut)
def invite_portal_user(
    partner_id: int,
    payload: PartnerPortalUserCreate,
    request: Request,
    current_user: User = Depends(require_permission("projects:manage")),
    db: Session = Depends(get_db),
) -> PartnerPortalLinkOut:
    partner = _partner_or_404(db, partner_id)
    if partner.archived_at is not None:
        raise HTTPException(status_code=409, detail="Partner is archived")
    email = _normalize_email(str(payload.email))
    if db.scalars(select(User.id).where(func.lower(User.email) == email)).first() is not None:
        # Whoever holds the address — a colleague, another partner's person —
        # keeps it. Turning an existing account into a partner login (or the
        # other way round) is never a side effect of an invite.
        raise HTTPException(status_code=409, detail="Email already has a login")
    user = User(
        email=email,
        # Unusable until the invite sets a real one.
        password_hash=get_password_hash(secrets.token_urlsafe(32)),
        full_name=payload.full_name,
        role=ROLE_EXTERNAL,
        partner_id=partner.id,
        is_active=True,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    log_admin_action(
        db,
        current_user,
        "partner.portal_user.create",
        "user",
        str(user.id),
        {"partner_id": partner.id, "email": user.email},
    )
    return _send_link(db, request, partner=partner, user=user, actor=current_user)


@router.post("/partners/{partner_id}/portal-users/{user_id}/send-link", response_model=PartnerPortalLinkOut)
def send_portal_link(
    partner_id: int,
    user_id: int,
    request: Request,
    current_user: User = Depends(require_permission("projects:manage")),
    db: Session = Depends(get_db),
) -> PartnerPortalLinkOut:
    partner = _partner_or_404(db, partner_id)
    user = _portal_user_or_404(db, partner, user_id)
    if not user.is_active:
        raise HTTPException(status_code=409, detail="Portal login is locked")
    if partner.archived_at is not None:
        raise HTTPException(status_code=409, detail="Partner is archived")
    return _send_link(db, request, partner=partner, user=user, actor=current_user)


@router.post("/partners/{partner_id}/portal-users/{user_id}/deactivate", response_model=PartnerPortalUserOut)
def deactivate_portal_user(
    partner_id: int,
    user_id: int,
    current_user: User = Depends(require_permission("projects:manage")),
    db: Session = Depends(get_db),
) -> PartnerPortalUserOut:
    partner = _partner_or_404(db, partner_id)
    user = _portal_user_or_404(db, partner, user_id)
    user.is_active = False
    db.add(user)
    # An unused invite would switch the account straight back on
    # (accept_invite sets is_active), and a reset link would set a password on
    # a locked account — both are burned with the lock.
    db.execute(
        update(UserActionToken)
        .where(UserActionToken.user_id == user.id, UserActionToken.used_at.is_(None))
        .values(used_at=utcnow())
    )
    db.commit()
    db.refresh(user)
    log_admin_action(db, current_user, "partner.portal_user.deactivate", "user", str(user.id), {"partner_id": partner.id})
    return _user_out(user, last_login_at=_last_logins(db, [user.id]).get(user.id))


@router.post("/partners/{partner_id}/portal-users/{user_id}/activate", response_model=PartnerPortalUserOut)
def activate_portal_user(
    partner_id: int,
    user_id: int,
    current_user: User = Depends(require_permission("projects:manage")),
    db: Session = Depends(get_db),
) -> PartnerPortalUserOut:
    partner = _partner_or_404(db, partner_id)
    user = _portal_user_or_404(db, partner, user_id)
    user.is_active = True
    db.add(user)
    db.commit()
    db.refresh(user)
    log_admin_action(db, current_user, "partner.portal_user.activate", "user", str(user.id), {"partner_id": partner.id})
    return _user_out(user, last_login_at=_last_logins(db, [user.id]).get(user.id))
