from __future__ import annotations
import csv
import hashlib
import os
import secrets
import subprocess
import tempfile
from datetime import datetime, timedelta
from io import StringIO

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import Response
from sqlalchemy.engine import make_url
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.db import get_db
from app.core.deps import get_current_user, require_admin
from app.core.permissions import ALL_ROLES, ROLE_EMPLOYEE, TEMPLATES
from app.core.security import get_password_hash
from app.core.time import utcnow
from app.models.entities import AuditLog, User, UserActionToken
from app.schemas.api import (
    InviteCreate,
    InviteDispatchOut,
    PasswordResetDispatchOut,
    UserCreate,
    UserOut,
    UserUpdate,
)
from app.services.audit import log_admin_action
from app.services.emailer import send_email_message
from app.services.project_import import import_projects_from_csv

router = APIRouter(prefix="/admin", tags=["admin"])
settings = get_settings()
DB_BACKUP_MAGIC = b"SMPLDB1"
DB_BACKUP_KDF_ITERATIONS = 390000

PROJECT_IMPORT_TEMPLATE_HEADERS = [
    "project_number",
    "name",
    "status",
    "last_state",
    "last_status_at",
    "customer_name",
    "customer_address",
    "customer_contact",
    "customer_email",
    "customer_phone",
    "description",
]


def _require_admin_or_ceo(current_user: User = Depends(get_current_user)) -> User:
    if current_user.role not in {"admin", "ceo"}:
        raise HTTPException(status_code=403, detail="Admin or CEO role required")
    return current_user


def _normalize_email(value: str) -> str:
    return value.strip().lower()


def _token_hash(raw_token: str) -> str:
    return hashlib.sha256(raw_token.encode("utf-8")).hexdigest()


def _build_action_link(path: str, token: str) -> str:
    base = (settings.app_public_url or "").strip().rstrip("/")
    if not base:
        base = "https://localhost"
    return f"{base}{path}?token={token}"


def _issue_action_token(
    db: Session,
    *,
    user_id: int,
    purpose: str,
    created_by: int | None,
    ttl_hours: int,
) -> tuple[str, datetime]:
    now = utcnow()
    db.execute(
        update(UserActionToken)
        .where(
            UserActionToken.user_id == user_id,
            UserActionToken.purpose == purpose,
            UserActionToken.used_at.is_(None),
        )
        .values(used_at=now)
    )
    raw_token = secrets.token_urlsafe(32)
    expires_at = now + timedelta(hours=ttl_hours)
    db.add(
        UserActionToken(
            user_id=user_id,
            purpose=purpose,
            token_hash=_token_hash(raw_token),
            expires_at=expires_at,
            created_by=created_by,
        )
    )
    return raw_token, expires_at


def _derive_backup_key(key_material: bytes, salt: bytes) -> bytes:
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=salt,
        iterations=DB_BACKUP_KDF_ITERATIONS,
    )
    return kdf.derive(key_material)


def _encrypt_backup_payload(plaintext: bytes, key_material: bytes) -> bytes:
    salt = os.urandom(16)
    nonce = os.urandom(12)
    key = _derive_backup_key(key_material, salt)
    ciphertext = AESGCM(key).encrypt(nonce, plaintext, DB_BACKUP_MAGIC)
    return DB_BACKUP_MAGIC + salt + nonce + ciphertext


def _create_encrypted_database_backup(database_url: str, key_material: bytes) -> bytes:
    db_url = make_url(database_url)
    if not db_url.drivername.startswith("postgresql"):
        raise HTTPException(status_code=400, detail="Database backup export supports PostgreSQL only")

    db_name = (db_url.database or "").strip()
    if not db_name:
        raise HTTPException(status_code=500, detail="Database name missing in DATABASE_URL")

    with tempfile.TemporaryDirectory(prefix="smpl-db-backup-") as tmp_dir:
        dump_path = os.path.join(tmp_dir, "db.dump")
        dump_cmd = [
            "pg_dump",
            "--format=custom",
            "--no-owner",
            "--no-privileges",
            "-h",
            db_url.host or "db",
            "-p",
            str(db_url.port or 5432),
            "-U",
            db_url.username or "smpl",
            "-d",
            db_name,
            "-f",
            dump_path,
        ]
        dump_env = os.environ.copy()
        if db_url.password:
            dump_env["PGPASSWORD"] = db_url.password
        try:
            subprocess.run(dump_cmd, check=True, capture_output=True, text=True, env=dump_env)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=500, detail="pg_dump is not available in the API container") from exc
        except subprocess.CalledProcessError as exc:
            stderr = (exc.stderr or "").strip()
            raise HTTPException(status_code=500, detail=f"Database backup failed: {stderr or 'pg_dump error'}") from exc

        with open(dump_path, "rb") as dump_file:
            dump_bytes = dump_file.read()
    return _encrypt_backup_payload(dump_bytes, key_material)


@router.get("/users", response_model=list[UserOut])
def list_users(_: User = Depends(require_admin), db: Session = Depends(get_db)):
    return list(db.scalars(select(User).order_by(User.is_active.desc(), User.id)).all())


@router.post("/users", response_model=UserOut)
def create_user(payload: UserCreate, admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    role = (payload.role or ROLE_EMPLOYEE).strip().lower() or ROLE_EMPLOYEE
    if role not in ALL_ROLES:
        raise HTTPException(status_code=400, detail="Invalid role")
    email = _normalize_email(payload.email)
    if db.scalars(select(User).where(User.email == email)).first():
        raise HTTPException(status_code=409, detail="Email exists")

    user = User(
        email=email,
        password_hash=get_password_hash(payload.password),
        full_name=payload.full_name,
        role=role,
        is_active=True,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    log_admin_action(db, admin, "user.create", "user", str(user.id), {"role": user.role, "email": user.email})
    return user


@router.post("/invites", response_model=InviteDispatchOut)
def create_and_send_invite(
    payload: InviteCreate,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    role = (payload.role or ROLE_EMPLOYEE).strip().lower() or ROLE_EMPLOYEE
    if role not in ALL_ROLES:
        raise HTTPException(status_code=400, detail="Invalid role")

    email = _normalize_email(payload.email)
    user = db.scalars(select(User).where(User.email == email)).first()
    if user:
        user.full_name = payload.full_name.strip() or user.full_name
        user.role = role
        user.is_active = True
    else:
        user = User(
            email=email,
            password_hash=get_password_hash(secrets.token_urlsafe(24)),
            full_name=payload.full_name.strip() or email,
            role=role,
            is_active=True,
        )
        db.add(user)
        db.flush()

    raw_token, expires_at = _issue_action_token(
        db,
        user_id=user.id,
        purpose="invite",
        created_by=admin.id,
        ttl_hours=72,
    )
    invite_link = _build_action_link("/invite", raw_token)
    sent = send_email_message(
        to_email=user.email,
        subject="Einladung zur SMPL Workflow Software",
        body=(
            "Sie wurden zur SMPL Workflow Software eingeladen.\n\n"
            f"Einladungslink: {invite_link}\n"
            f"Gueltig bis (UTC): {expires_at.isoformat()}Z\n\n"
            "Falls der Link nicht klickbar ist, kopieren Sie ihn in den Browser."
        ),
    )

    user.invite_sent_at = utcnow()
    db.add(user)
    db.commit()
    db.refresh(user)
    log_admin_action(
        db,
        admin,
        "user.invite.send",
        "user",
        str(user.id),
        {"email": user.email, "role": user.role, "sent": sent},
    )
    return InviteDispatchOut(
        user_id=user.id,
        email=user.email,
        sent=sent,
        invite_link=invite_link,
        expires_at=expires_at,
    )


@router.post("/backups/database")
async def create_database_backup(
    key_file: UploadFile = File(...),
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    if not key_file.filename:
        raise HTTPException(status_code=400, detail="Key file is required")
    key_material = (await key_file.read()).strip()
    if len(key_material) < 16:
        raise HTTPException(status_code=400, detail="Key file content is too short")

    encrypted_backup = _create_encrypted_database_backup(settings.database_url, key_material)
    timestamp = utcnow().strftime("%Y%m%d-%H%M%S")
    download_name = f"smpl-db-backup-{timestamp}.smplbak"

    log_admin_action(
        db,
        admin,
        "backup.database.export",
        "backup",
        download_name,
        {"size_bytes": len(encrypted_backup)},
    )
    return Response(
        content=encrypted_backup,
        media_type="application/octet-stream",
        headers={
            "Content-Disposition": f'attachment; filename="{download_name}"',
            "X-Backup-Format": "smpl-db-v1",
            "X-Backup-Encryption": "aes-256-gcm+pbkdf2",
        },
    )


@router.post("/users/{user_id}/send-invite", response_model=InviteDispatchOut)
def send_user_invite(
    user_id: int,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if not user.is_active:
        raise HTTPException(status_code=400, detail="Invite can only be sent to active users")

    raw_token, expires_at = _issue_action_token(
        db,
        user_id=user.id,
        purpose="invite",
        created_by=admin.id,
        ttl_hours=72,
    )
    invite_link = _build_action_link("/invite", raw_token)
    sent = send_email_message(
        to_email=user.email,
        subject="Einladung zur SMPL Workflow Software",
        body=(
            "Hier ist Ihr Einladungslink zur SMPL Workflow Software.\n\n"
            f"Einladungslink: {invite_link}\n"
            f"Gueltig bis (UTC): {expires_at.isoformat()}Z\n"
        ),
    )
    user.invite_sent_at = utcnow()
    db.add(user)
    db.commit()
    db.refresh(user)
    log_admin_action(
        db,
        admin,
        "user.invite.resend",
        "user",
        str(user.id),
        {"email": user.email, "sent": sent},
    )
    return InviteDispatchOut(
        user_id=user.id,
        email=user.email,
        sent=sent,
        invite_link=invite_link,
        expires_at=expires_at,
    )


@router.post("/users/{user_id}/send-password-reset", response_model=PasswordResetDispatchOut)
def send_password_reset(
    user_id: int,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if not user.is_active:
        raise HTTPException(status_code=400, detail="Password reset can only be sent to active users")

    raw_token, expires_at = _issue_action_token(
        db,
        user_id=user.id,
        purpose="password_reset",
        created_by=admin.id,
        ttl_hours=24,
    )
    reset_link = _build_action_link("/reset-password", raw_token)
    sent = send_email_message(
        to_email=user.email,
        subject="Passwort zuruecksetzen - SMPL Workflow",
        body=(
            "Sie oder ein Administrator haben einen Passwort-Reset angefordert.\n\n"
            f"Reset-Link: {reset_link}\n"
            f"Gueltig bis (UTC): {expires_at.isoformat()}Z\n"
        ),
    )

    user.password_reset_sent_at = utcnow()
    db.add(user)
    db.commit()
    db.refresh(user)
    log_admin_action(
        db,
        admin,
        "user.password_reset.send",
        "user",
        str(user.id),
        {"email": user.email, "sent": sent},
    )
    return PasswordResetDispatchOut(
        user_id=user.id,
        email=user.email,
        sent=sent,
        reset_link=reset_link,
        expires_at=expires_at,
    )


@router.delete("/users/{user_id}")
def soft_delete_user(
    user_id: int,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if user.id == admin.id:
        raise HTTPException(status_code=400, detail="You cannot delete your own user")

    if not user.is_active:
        log_admin_action(
            db,
            admin,
            "user.soft_delete.skip_inactive",
            "user",
            str(user.id),
            {"email": user.email},
        )
        return {"ok": True, "user_id": user.id, "deleted": False}

    now = utcnow()
    user.is_active = False
    db.add(user)
    db.execute(
        update(UserActionToken)
        .where(
            UserActionToken.user_id == user.id,
            UserActionToken.used_at.is_(None),
        )
        .values(used_at=now)
    )
    db.commit()
    db.refresh(user)
    log_admin_action(
        db,
        admin,
        "user.soft_delete",
        "user",
        str(user.id),
        {"email": user.email, "is_active": user.is_active},
    )
    return {"ok": True, "user_id": user.id, "deleted": True}


@router.patch("/users/{user_id}", response_model=UserOut)
def update_user(user_id: int, payload: UserUpdate, admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    if payload.role and payload.role not in ALL_ROLES:
        raise HTTPException(status_code=400, detail="Invalid role")

    for field in ["full_name", "role", "is_active", "required_daily_hours"]:
        value = getattr(payload, field)
        if value is not None:
            setattr(user, field, value)

    db.add(user)
    db.commit()
    db.refresh(user)
    log_admin_action(db, admin, "user.update", "user", str(user.id), payload.model_dump(exclude_none=True))
    return user


@router.post("/users/{user_id}/apply-template")
def apply_template(
    user_id: int,
    template: str = "default",
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    if template not in TEMPLATES:
        raise HTTPException(status_code=404, detail="Template not found")

    user = db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    # Template maps role->permissions; one-click action sets existing role template reference.
    if user.role not in TEMPLATES[template]:
        raise HTTPException(status_code=400, detail="Role not in template")

    log_admin_action(
        db,
        admin,
        "user.apply_template",
        "user",
        str(user.id),
        {"template": template, "role": user.role},
    )
    return {"ok": True, "template": template, "role": user.role}


@router.get("/audit-logs")
def audit_logs(_: User = Depends(require_admin), db: Session = Depends(get_db)):
    logs = list(db.scalars(select(AuditLog).order_by(AuditLog.created_at.desc()).limit(300)).all())
    return [
        {
            "id": log.id,
            "actor_user_id": log.actor_user_id,
            "action": log.action,
            "target_type": log.target_type,
            "target_id": log.target_id,
            "details": log.details,
            "created_at": log.created_at,
        }
        for log in logs
    ]


@router.get("/projects/import-template.csv")
def download_project_import_template(
    _: User = Depends(_require_admin_or_ceo),
):
    buffer = StringIO()
    writer = csv.writer(buffer)
    writer.writerow(PROJECT_IMPORT_TEMPLATE_HEADERS)
    writer.writerow(
        [
            "2026-4001",
            "Musterprojekt",
            "active",
            "Kundenfreigabe steht aus",
            "2026-02-22 09:30:00",
            "Musterkunde GmbH",
            "Musterweg 7, 12345 Berlin",
            "Erika Muster",
            "kontakt@example.com",
            "+49 123 456789",
            "Import per CSV",
        ]
    )
    return Response(
        content=buffer.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="projects-import-template.csv"'},
    )


@router.post("/projects/import-csv")
async def import_projects_csv(
    file: UploadFile = File(...),
    admin: User = Depends(_require_admin_or_ceo),
    db: Session = Depends(get_db),
):
    if not file.filename:
        raise HTTPException(status_code=400, detail="CSV file is required")
    file_name = file.filename.lower()
    if not file_name.endswith(".csv"):
        raise HTTPException(status_code=400, detail="Please upload a .csv file")
    payload = await file.read()
    if not payload:
        raise HTTPException(status_code=400, detail="CSV file is empty")

    tmp_path: str | None = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=".csv") as handle:
            handle.write(payload)
            tmp_path = handle.name
        stats = import_projects_from_csv(db, tmp_path, source_label=file.filename)
    finally:
        if tmp_path:
            try:
                os.remove(tmp_path)
            except OSError:
                pass

    log_admin_action(
        db,
        admin,
        "projects.import_csv",
        "project",
        "bulk",
        {
            "file_name": file.filename,
            "processed_rows": stats.processed_rows,
            "created": stats.created,
            "updated": stats.updated,
            "temporary_numbers": stats.temporary_numbers,
            "duplicates_skipped": stats.duplicates_skipped,
        },
    )
    return {
        "processed_rows": stats.processed_rows,
        "created": stats.created,
        "updated": stats.updated,
        "temporary_numbers": stats.temporary_numbers,
        "duplicates_skipped": stats.duplicates_skipped,
    }
