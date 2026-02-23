from __future__ import annotations
import csv
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import tempfile
from datetime import datetime, timedelta
from io import StringIO
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

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
from app.models.entities import AuditLog, ProjectClassTemplate, User, UserActionToken
from app.schemas.api import (
    InviteCreate,
    InviteDispatchOut,
    PasswordResetDispatchOut,
    UserCreate,
    UserOut,
    UserUpdate,
    UpdateInstallOut,
    UpdateInstallRequest,
    UpdateStatusOut,
    WeatherSettingsOut,
    WeatherSettingsUpdate,
)
from app.services.audit import log_admin_action
from app.services.emailer import send_email_message
from app.services.project_import import import_projects_from_csv
from app.services.runtime_settings import get_openweather_api_key, set_openweather_api_key

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
PROJECT_CLASS_TEMPLATE_HEADERS = [
    "class_name",
    "materials_required",
    "tools_required",
    "task_title",
    "task_description",
    "task_type",
]
TASK_TYPE_ALIASES = {
    "construction": "construction",
    "site": "construction",
    "baustelle": "construction",
    "office": "office",
    "backoffice": "office",
    "buero": "office",
    "büro": "office",
    "customer_appointment": "customer_appointment",
    "customer-appointment": "customer_appointment",
    "customer appointment": "customer_appointment",
    "appointment": "customer_appointment",
    "kundentermin": "customer_appointment",
    "kundentermine": "customer_appointment",
    "termin": "customer_appointment",
}
SEMVER_REGEX = re.compile(r"^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$")


def _require_admin_or_ceo(current_user: User = Depends(get_current_user)) -> User:
    if current_user.role not in {"admin", "ceo"}:
        raise HTTPException(status_code=403, detail="Admin or CEO role required")
    return current_user


def _mask_secret(value: str) -> str:
    secret = (value or "").strip()
    if not secret:
        return ""
    if len(secret) <= 4:
        return "*" * len(secret)
    return f"{'*' * (len(secret) - 4)}{secret[-4:]}"


def _trim_or_none(value: str | None) -> str | None:
    raw = (value or "").strip()
    return raw or None


def _to_semver_tuple(value: str | None) -> tuple[int, int, int] | None:
    normalized = _trim_or_none(value)
    if not normalized:
        return None
    match = SEMVER_REGEX.match(normalized)
    if not match:
        return None
    return int(match.group(1)), int(match.group(2)), int(match.group(3))


def _short_commit(value: str | None) -> str | None:
    normalized = _trim_or_none(value)
    if not normalized:
        return None
    return normalized[:12]


def _github_repo_slug() -> str:
    return f"{settings.update_repo_owner}/{settings.update_repo_name}"


def _github_api_json(path: str) -> dict | list:
    url = f"https://api.github.com{path}"
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "smpl-update-checker",
    }
    api_token = (settings.github_api_token or "").strip()
    if api_token:
        headers["Authorization"] = f"Bearer {api_token}"
    request = Request(url, headers=headers)
    with urlopen(request, timeout=8) as response:
        payload = response.read().decode("utf-8")
    return json.loads(payload)


def _manual_update_steps(branch: str) -> list[str]:
    return [
        "git fetch --tags --prune",
        f"git pull --ff-only origin {branch}",
        "docker compose up -d --build",
        "docker compose exec api alembic upgrade head",
    ]


def _resolve_repo_root() -> Path | None:
    configured = _trim_or_none(settings.update_repo_path)
    if configured:
        root = Path(configured).expanduser().resolve()
        if (root / ".git").exists():
            return root
        return None

    for base in [Path.cwd(), Path(__file__).resolve()]:
        for candidate in [base, *base.parents]:
            if (candidate / ".git").exists():
                return candidate
    return None


def _can_auto_install_updates() -> bool:
    return _resolve_repo_root() is not None


def _run_update_command(command: list[str], *, cwd: Path) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            command,
            cwd=str(cwd),
            check=True,
            capture_output=True,
            text=True,
        )
    except FileNotFoundError as exc:
        raise HTTPException(status_code=500, detail=f"Command not found: {command[0]}") from exc
    except subprocess.CalledProcessError as exc:
        stderr = (exc.stderr or "").strip()
        stdout = (exc.stdout or "").strip()
        detail = stderr or stdout or f"Command failed: {' '.join(command)}"
        raise HTTPException(status_code=500, detail=detail) from exc


def _fetch_update_status() -> UpdateStatusOut:
    owner = settings.update_repo_owner.strip()
    repo = settings.update_repo_name.strip()
    branch = (settings.update_repo_branch or "main").strip() or "main"
    if not owner or not repo:
        return UpdateStatusOut(
            repository="",
            branch=branch,
            current_version=_trim_or_none(settings.app_release_version),
            current_commit=_short_commit(settings.app_release_commit),
            install_supported=False,
            install_mode="manual",
            install_steps=_manual_update_steps(branch),
            message="Update repository is not configured",
        )

    repository = f"{owner}/{repo}"
    current_version = _trim_or_none(settings.app_release_version)
    current_commit = _short_commit(settings.app_release_commit)
    install_supported = _can_auto_install_updates()
    install_mode = "auto" if install_supported else "manual"
    install_steps = _manual_update_steps(branch)

    latest_version: str | None = None
    latest_commit: str | None = None
    latest_published_at: datetime | None = None
    latest_url: str | None = None
    update_available: bool | None = None
    message: str | None = None
    try:
        releases = _github_api_json(f"/repos/{owner}/{repo}/releases")
        latest_release = releases[0] if isinstance(releases, list) and releases else None
        if latest_release:
            latest_version = _trim_or_none(str(latest_release.get("tag_name") or ""))
            latest_url = _trim_or_none(str(latest_release.get("html_url") or ""))
            published_raw = _trim_or_none(str(latest_release.get("published_at") or ""))
            if published_raw:
                try:
                    latest_published_at = datetime.fromisoformat(published_raw.replace("Z", "+00:00"))
                except ValueError:
                    latest_published_at = None
            commitish = _trim_or_none(str(latest_release.get("target_commitish") or "")) or branch
            try:
                commit_row = _github_api_json(
                    f"/repos/{owner}/{repo}/commits/{quote(commitish, safe='')}"
                )
                if isinstance(commit_row, dict):
                    latest_commit = _short_commit(str(commit_row.get("sha") or ""))
            except Exception:
                latest_commit = None
            if current_version and latest_version:
                current_semver = _to_semver_tuple(current_version)
                latest_semver = _to_semver_tuple(latest_version)
                if current_semver and latest_semver:
                    update_available = latest_semver > current_semver
                elif current_version != latest_version:
                    update_available = True
                else:
                    update_available = False
            elif current_commit and latest_commit:
                update_available = current_commit != latest_commit
            else:
                update_available = None
                message = "Current version metadata is missing; update comparison is limited."
        else:
            branch_row = _github_api_json(
                f"/repos/{owner}/{repo}/commits/{quote(branch, safe='')}"
            )
            if isinstance(branch_row, dict):
                latest_commit = _short_commit(str(branch_row.get("sha") or ""))
                latest_url = _trim_or_none(str(branch_row.get("html_url") or ""))
            latest_version = None
            if current_commit and latest_commit:
                update_available = current_commit != latest_commit
            else:
                update_available = None
                message = "No GitHub release is published yet; branch commit check only."
    except (HTTPError, URLError, TimeoutError, json.JSONDecodeError, ValueError) as exc:
        message = f"Could not fetch update status from GitHub: {exc}"

    return UpdateStatusOut(
        repository=repository,
        branch=branch,
        current_version=current_version,
        current_commit=current_commit,
        latest_version=latest_version,
        latest_commit=latest_commit,
        latest_published_at=latest_published_at,
        latest_url=latest_url,
        update_available=update_available,
        install_supported=install_supported,
        install_mode=install_mode,
        install_steps=install_steps,
        message=message,
    )


def _normalize_email(value: str) -> str:
    return value.strip().lower()


def _normalize_task_type(raw_value: str | None, *, default: str = "construction") -> str:
    normalized = (raw_value or "").strip().lower()
    if not normalized:
        return default
    mapped = TASK_TYPE_ALIASES.get(normalized)
    if not mapped:
        raise HTTPException(status_code=400, detail=f"Unknown task type: {raw_value}")
    return mapped


def _split_multiline(value: str | None) -> list[str]:
    if not value:
        return []
    rows = [
        line.strip()
        for line in str(value).replace("\r", "\n").split("\n")
        if line.strip()
    ]
    deduped: list[str] = []
    seen: set[str] = set()
    for row in rows:
        key = row.lower()
        if key in seen:
            continue
        seen.add(key)
        deduped.append(row)
    return deduped


def _task_template_key(task: dict[str, str | None]) -> tuple[str, str, str]:
    return (
        str(task.get("title") or "").strip().lower(),
        str(task.get("description") or "").strip().lower(),
        str(task.get("task_type") or "construction").strip().lower(),
    )


def _parse_project_class_template_csv(payload: bytes) -> dict[str, dict]:
    try:
        text = payload.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise HTTPException(status_code=400, detail="CSV must be UTF-8 encoded") from exc

    reader = csv.DictReader(StringIO(text))
    if not reader.fieldnames:
        raise HTTPException(status_code=400, detail="CSV has no header row")

    missing_headers = [header for header in PROJECT_CLASS_TEMPLATE_HEADERS if header not in reader.fieldnames]
    if missing_headers:
        raise HTTPException(
            status_code=400,
            detail=f"CSV headers missing: {', '.join(missing_headers)}",
        )

    by_name: dict[str, dict] = {}
    for row in reader:
        class_name = str(row.get("class_name") or "").strip()
        if not class_name:
            continue
        key = class_name.lower()
        bucket = by_name.setdefault(
            key,
            {
                "name": class_name,
                "materials": [],
                "tools": [],
                "task_templates": [],
            },
        )
        bucket["name"] = class_name
        bucket["materials"].extend(_split_multiline(row.get("materials_required")))
        bucket["tools"].extend(_split_multiline(row.get("tools_required")))

        task_title = str(row.get("task_title") or "").strip()
        if task_title:
            task_description = str(row.get("task_description") or "").strip() or None
            task_type = _normalize_task_type(str(row.get("task_type") or ""), default="construction")
            bucket["task_templates"].append(
                {
                    "title": task_title,
                    "description": task_description,
                    "task_type": task_type,
                }
            )

    if not by_name:
        raise HTTPException(status_code=400, detail="CSV does not contain any class rows")
    return by_name


def _upsert_project_class_templates(
    db: Session,
    *,
    admin: User,
    file_name: str,
    payload: bytes,
) -> dict[str, int]:
    parsed = _parse_project_class_template_csv(payload)
    class_names = [entry["name"] for entry in parsed.values()]
    existing_rows = db.scalars(select(ProjectClassTemplate).where(ProjectClassTemplate.name.in_(class_names))).all()
    existing_by_name = {row.name.lower(): row for row in existing_rows}

    created = 0
    updated = 0
    total_tasks = 0
    for key in sorted(parsed.keys()):
        entry = parsed[key]
        materials_list = _split_multiline("\n".join(entry["materials"]))
        tools_list = _split_multiline("\n".join(entry["tools"]))

        task_templates: list[dict[str, str | None]] = []
        seen_tasks: set[tuple[str, str, str]] = set()
        for task in entry["task_templates"]:
            row = {
                "title": str(task.get("title") or "").strip(),
                "description": str(task.get("description") or "").strip() or None,
                "task_type": _normalize_task_type(str(task.get("task_type") or ""), default="construction"),
            }
            if not row["title"]:
                continue
            task_key = _task_template_key(row)
            if task_key in seen_tasks:
                continue
            seen_tasks.add(task_key)
            task_templates.append(row)

        total_tasks += len(task_templates)
        materials_value = "\n".join(materials_list).strip() or None
        tools_value = "\n".join(tools_list).strip() or None

        existing = existing_by_name.get(key)
        if existing:
            existing.name = entry["name"]
            existing.materials_required = materials_value
            existing.tools_required = tools_value
            existing.task_templates = task_templates
            db.add(existing)
            updated += 1
        else:
            db.add(
                ProjectClassTemplate(
                    name=entry["name"],
                    materials_required=materials_value,
                    tools_required=tools_value,
                    task_templates=task_templates,
                    created_by=admin.id,
                )
            )
            created += 1

    log_admin_action(
        db,
        admin,
        "project_classes.import_csv",
        "project_class_template",
        "bulk",
        {
            "file_name": file_name,
            "created": created,
            "updated": updated,
            "classes": created + updated,
            "task_templates": total_tasks,
        },
    )
    return {"created": created, "updated": updated, "classes": created + updated, "task_templates": total_tasks}


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


@router.get("/project-classes/template.csv")
def download_project_class_template(
    _: User = Depends(_require_admin_or_ceo),
):
    buffer = StringIO()
    writer = csv.writer(buffer)
    writer.writerow(PROJECT_CLASS_TEMPLATE_HEADERS)
    writer.writerow(
        [
            "PV Standard",
            "PV modules\nDC cable set\nMounting rails",
            "Cable cutter\nCrimping tool",
            "Mount PV modules",
            "Mount rails and modules on the target roof section.",
            "construction",
        ]
    )
    writer.writerow(
        [
            "PV Standard",
            "PV modules\nDC cable set\nMounting rails",
            "Cable cutter\nCrimping tool",
            "Commissioning and handover",
            "Check inverter parameters and document customer handover.",
            "office",
        ]
    )
    writer.writerow(
        [
            "PV Standard",
            "Offer documents\nChecklist",
            "Tablet\nMeasuring tape",
            "Customer on-site appointment",
            "Visit customer, confirm measurements, and collect required signatures.",
            "customer_appointment",
        ]
    )
    writer.writerow(
        [
            "Heat Pump Retrofit",
            "Heat pump unit\nPipe insulation",
            "Vacuum pump\nPressure gauge",
            "Install heat pump",
            "Prepare hydraulics and connect the heat pump unit.",
            "construction",
        ]
    )
    return Response(
        content=buffer.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="project-class-template.csv"'},
    )


@router.post("/project-classes/import-csv")
async def import_project_class_template_csv(
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

    result = _upsert_project_class_templates(
        db,
        admin=admin,
        file_name=file.filename,
        payload=payload,
    )
    db.commit()
    return result


@router.get("/settings/weather", response_model=WeatherSettingsOut)
def get_weather_settings(
    _: User = Depends(_require_admin_or_ceo),
    db: Session = Depends(get_db),
):
    runtime_key = get_openweather_api_key(db)
    effective_key = runtime_key or (settings.openweather_api_key or "").strip()
    return WeatherSettingsOut(
        provider="openweather",
        configured=bool(effective_key),
        masked_api_key=_mask_secret(effective_key),
    )


@router.patch("/settings/weather", response_model=WeatherSettingsOut)
def update_weather_settings(
    payload: WeatherSettingsUpdate,
    admin: User = Depends(_require_admin_or_ceo),
    db: Session = Depends(get_db),
):
    api_key = (payload.api_key or "").strip()
    set_openweather_api_key(db, api_key)
    db.commit()
    log_admin_action(
        db,
        admin,
        "settings.weather.update",
        "settings",
        "weather",
        {"configured": bool(api_key), "provider": "openweather"},
    )
    return WeatherSettingsOut(
        provider="openweather",
        configured=bool(api_key),
        masked_api_key=_mask_secret(api_key),
    )


@router.get("/updates/status", response_model=UpdateStatusOut)
def get_updates_status(
    _: User = Depends(_require_admin_or_ceo),
):
    return _fetch_update_status()


@router.post("/updates/install", response_model=UpdateInstallOut)
def install_updates(
    payload: UpdateInstallRequest,
    admin: User = Depends(_require_admin_or_ceo),
    db: Session = Depends(get_db),
):
    status = _fetch_update_status()
    if not status.install_supported:
        return UpdateInstallOut(
            ok=False,
            mode="manual",
            detail="Automatic install is unavailable in this deployment. Run the manual update commands.",
            ran_steps=[],
            dry_run=payload.dry_run,
        )

    repo_root = _resolve_repo_root()
    if repo_root is None:
        return UpdateInstallOut(
            ok=False,
            mode="manual",
            detail="Could not locate a git repository for automatic install.",
            ran_steps=[],
            dry_run=payload.dry_run,
        )

    branch = status.branch or "main"
    command_steps: list[tuple[str, list[str], Path]] = [
        ("git.fetch", ["git", "fetch", "--tags", "--prune", "origin"], repo_root),
        ("git.pull", ["git", "pull", "--ff-only", "origin", branch], repo_root),
    ]

    api_dir_candidate = repo_root / "apps" / "api"
    alembic_workdir = api_dir_candidate if (api_dir_candidate / "alembic.ini").exists() else repo_root
    command_steps.append(("alembic.upgrade", ["alembic", "upgrade", "head"], alembic_workdir))

    ran_steps: list[str] = []
    if payload.dry_run:
        ran_steps = [" ".join(cmd) for _, cmd, _ in command_steps]
        return UpdateInstallOut(
            ok=True,
            mode="auto",
            detail="Dry run complete. No commands were executed.",
            ran_steps=ran_steps,
            dry_run=True,
        )

    for _, command, cwd in command_steps:
        _run_update_command(command, cwd=cwd)
        ran_steps.append(" ".join(command))

    log_admin_action(
        db,
        admin,
        "system.update.install",
        "system",
        "updates",
        {
            "repository": status.repository,
            "branch": branch,
            "ran_steps": ran_steps,
            "latest_version": status.latest_version,
            "latest_commit": status.latest_commit,
        },
    )

    return UpdateInstallOut(
        ok=True,
        mode="auto",
        detail="Update commands completed successfully.",
        ran_steps=ran_steps,
        dry_run=False,
    )
