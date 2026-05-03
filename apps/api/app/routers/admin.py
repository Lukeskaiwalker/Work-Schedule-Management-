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
from urllib.request import Request as URLRequest, urlopen

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, UploadFile
from pydantic import BaseModel
from fastapi.responses import Response, StreamingResponse
from sqlalchemy.engine import make_url
from sqlalchemy import delete, select, update
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.db import get_db
from app.core.deps import require_permission
from app.core.permissions import ALL_PERMISSIONS, ALL_ROLES, PERMISSION_DESCRIPTIONS, PERMISSION_GROUPS, PERMISSION_LABELS, ROLE_EMPLOYEE, TEMPLATES, get_effective_permissions, get_user_override, has_permission_for_user
from app.core.security import get_password_hash
from app.core.time import utcnow
from app.models.entities import AuditLog, EmployeeGroup, EmployeeGroupMember, ProjectClassTemplate, User, UserActionToken
from app.schemas.api import (
    CompanySettingsOut,
    CompanySettingsUpdate,
    EmployeeGroupCreate,
    EmployeeGroupOut,
    EmployeeGroupUpdate,
    InviteCreate,
    InviteDispatchOut,
    OpenAISettingsOut,
    OpenAISettingsUpdate,
    PasswordResetDispatchOut,
    SmtpSettingsOut,
    SmtpSettingsUpdate,
    SmtpTestRequest,
    SmtpTestResultOut,
    UserCreate,
    UserOut,
    UserUpdate,
    UpdateInstallOut,
    UpdateInstallRequest,
    UpdateProgressOut,
    UpdateStatusOut,
    WeatherSettingsOut,
    WeatherSettingsUpdate,
)
from app.services import update_runner_client
from app.services.audit import log_admin_action
from app.routers.workflow_helpers import _content_disposition
from app.services.emailer import send_email_detailed, send_email_message
from app.services.project_import import import_projects_from_csv
from app.services.runtime_settings import (
    OPENAI_DEFAULT_EXTRACTION_MODEL,
    get_company_settings,
    get_openai_settings,
    get_smtp_settings,
    get_openweather_api_key,
    reset_role_to_defaults,
    reset_user_permissions_from_db,
    save_role_permissions_to_db,
    save_user_permissions_to_db,
    set_company_settings,
    set_openai_settings,
    set_smtp_settings,
    set_openweather_api_key,
)

router = APIRouter(prefix="/admin", tags=["admin"])
settings = get_settings()
DB_BACKUP_MAGIC = b"SMPLDB1"
DB_BACKUP_KDF_ITERATIONS = 390000
PLACEHOLDER_RELEASE_VERSIONS = {"local-production"}

PROJECT_IMPORT_TEMPLATE_HEADERS = [
    "project_number",
    "name",
    "status",
    "last_state",
    "last_status_at",
    "customer_name",
    "customer_address",
    "construction_site_address",
    "customer_contact",
    "customer_email",
    "customer_phone",
    "description",
    "order_value_net",
    "down_payment_35",
    "main_components_50",
    "final_invoice_15",
    "planned_costs",
    "actual_costs",
    "contribution_margin",
    "planned_hours_total",
]
PROJECT_CLASS_TEMPLATE_HEADERS = [
    "class_name",
    "materials_required",
    "tools_required",
    "task_title",
    "task_description",
    "task_type",
    "task_subtasks",
]
PROJECT_CLASS_TEMPLATE_REQUIRED_HEADERS = [
    "class_name",
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


def _can_manage_permissions(user: User) -> bool:
    return has_permission_for_user(user.id, user.role, "permissions:manage")


def _assert_can_assign_role(actor: User, role: str) -> None:
    if role != ROLE_EMPLOYEE and not _can_manage_permissions(actor):
        raise HTTPException(status_code=403, detail="Role assignment denied")


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


def _employee_group_out(db: Session, group: EmployeeGroup) -> EmployeeGroupOut:
    memberships = db.scalars(
        select(EmployeeGroupMember).where(EmployeeGroupMember.group_id == group.id).order_by(EmployeeGroupMember.id.asc())
    ).all()
    members: list[dict] = []
    member_user_ids: list[int] = []
    for membership in memberships:
        user = db.get(User, membership.user_id)
        if not user:
            continue
        members.append(
            {
                "user_id": user.id,
                "full_name": user.full_name,
                "display_name": user.display_name,
                "is_active": bool(user.is_active),
            }
        )
        if user.is_active:
            member_user_ids.append(user.id)
    return EmployeeGroupOut(
        id=group.id,
        name=group.name,
        can_update_recent_own_time_entries=bool(group.can_update_recent_own_time_entries),
        member_user_ids=sorted(set(member_user_ids)),
        members=members,
    )


def _sync_employee_group_members(db: Session, group_id: int, member_user_ids: list[int]) -> None:
    normalized_ids = sorted({int(user_id) for user_id in member_user_ids if int(user_id) > 0})
    if normalized_ids:
        users = db.scalars(
            select(User).where(User.id.in_(normalized_ids), User.is_active.is_(True)).order_by(User.id.asc())
        ).all()
        valid_ids = {user.id for user in users}
        missing = [user_id for user_id in normalized_ids if user_id not in valid_ids]
        if missing:
            raise HTTPException(status_code=400, detail=f"Invalid or archived user ids: {missing}")
    else:
        valid_ids = set()

    db.execute(delete(EmployeeGroupMember).where(EmployeeGroupMember.group_id == group_id))
    for user_id in sorted(valid_ids):
        db.add(EmployeeGroupMember(group_id=group_id, user_id=user_id))


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


def _is_placeholder_release_version(value: str | None) -> bool:
    normalized = _trim_or_none(value)
    if not normalized:
        return False
    return normalized.lower() in PLACEHOLDER_RELEASE_VERSIONS


def _commit_refs_match(left: str | None, right: str | None) -> bool:
    left_value = _trim_or_none(left)
    right_value = _trim_or_none(right)
    if not left_value or not right_value:
        return False
    left_norm = left_value.lower()
    right_norm = right_value.lower()
    return left_norm == right_norm or left_norm.startswith(right_norm) or right_norm.startswith(left_norm)


def _run_git_readonly(command: list[str], *, cwd: Path) -> str | None:
    try:
        result = subprocess.run(
            command,
            cwd=str(cwd),
            check=False,
            capture_output=True,
            text=True,
        )
    except (FileNotFoundError, OSError):
        return None
    if result.returncode != 0:
        return None
    return _trim_or_none(result.stdout)


def _resolve_current_release_from_git() -> tuple[str | None, str | None]:
    repo_root = _resolve_repo_root()
    if repo_root is None:
        return None, None

    head_commit = _run_git_readonly(["git", "rev-parse", "HEAD"], cwd=repo_root)
    head_short_commit = _short_commit(head_commit)

    exact_tag = _run_git_readonly(["git", "describe", "--tags", "--exact-match", "HEAD"], cwd=repo_root)
    if exact_tag:
        return exact_tag, head_short_commit

    points_at_rows = _run_git_readonly(["git", "tag", "--points-at", "HEAD"], cwd=repo_root)
    if points_at_rows:
        first_tag = _trim_or_none(points_at_rows.splitlines()[0])
        if first_tag:
            return first_tag, head_short_commit

    return None, head_short_commit


def _read_release_env_file() -> tuple[str | None, str | None]:
    """Re-read ``apps/api/.release.env`` from disk on demand.

    The Settings instance is ``@lru_cache``'d (see ``app.core.config``) and reads
    env files exactly once at process startup. After an update flow regenerates
    ``.release.env`` (via ``scripts/update_release_metadata.sh``), the freshly
    written values are invisible to the running api process until it restarts.

    This helper closes that gap: every call to ``_current_release_metadata``
    consults the file fresh, so the in-app "Aktuell" version reflects the
    real on-disk release as soon as the script writes it — no container
    restart, no docker socket access required.

    Probes, in order:
      1. ``<repo_root>/apps/api/.release.env`` — covers production servers
         that bind-mount the repo into the api container, which is also
         where ``update_release_metadata.sh`` writes the file.
      2. ``/app/.release.env`` — covers the build-time copy baked into the
         api image from the Dockerfile's ``COPY . .`` step (build context
         is ``apps/api``).
      3. The path relative to this source file — defensive fallback for
         non-container runs (tests, local uvicorn).
    """
    candidates: list[Path] = []
    repo_root = _resolve_repo_root()
    if repo_root is not None:
        candidates.append(repo_root / "apps" / "api" / ".release.env")
    candidates.append(Path("/app/.release.env"))
    try:
        candidates.append(Path(__file__).resolve().parents[2] / ".release.env")
    except (IndexError, OSError):
        pass

    seen: set[Path] = set()
    for path in candidates:
        try:
            resolved = path.resolve()
        except OSError:
            continue
        if resolved in seen:
            continue
        seen.add(resolved)
        if not resolved.is_file():
            continue
        try:
            contents = resolved.read_text(encoding="utf-8")
        except OSError:
            continue
        version: str | None = None
        commit: str | None = None
        for raw_line in contents.splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key == "APP_RELEASE_VERSION":
                version = value or None
            elif key == "APP_RELEASE_COMMIT":
                commit = value or None
        return version, commit

    return None, None


def _current_release_metadata() -> tuple[str | None, str | None, bool]:
    # Prefer a fresh on-disk read of .release.env so a freshly regenerated file
    # surfaces immediately, without relying on the lru_cached Settings being
    # re-read (which only happens on full process restart). Fall back to the
    # cached env value, then to git describe, in that order.
    file_version, file_commit = _read_release_env_file()
    current_version = _trim_or_none(file_version) or _trim_or_none(settings.app_release_version)
    current_commit = _short_commit(file_commit) or _short_commit(settings.app_release_commit)
    placeholder_requested = _is_placeholder_release_version(current_version)
    unresolved_placeholder = False

    if placeholder_requested or not current_commit:
        git_version, git_commit = _resolve_current_release_from_git()
        if placeholder_requested and git_version:
            current_version = git_version
        if not current_commit and git_commit:
            current_commit = git_commit

    if _is_placeholder_release_version(current_version):
        unresolved_placeholder = True
        current_version = None

    return current_version, current_commit, unresolved_placeholder


def _resolve_release_tag_for_commit(owner: str, repo: str, commit_ref: str | None) -> str | None:
    if not commit_ref:
        return None
    tags = _github_api_json(f"/repos/{owner}/{repo}/tags")
    if not isinstance(tags, list):
        return None
    for row in tags:
        if not isinstance(row, dict):
            continue
        tag_name = _trim_or_none(str(row.get("name") or ""))
        commit_row = row.get("commit")
        tag_commit = None
        if isinstance(commit_row, dict):
            tag_commit = _trim_or_none(str(commit_row.get("sha") or ""))
        if tag_name and _commit_refs_match(commit_ref, tag_commit):
            return tag_name
    return None


def _resolve_commit_for_ref(owner: str, repo: str, ref: str | None) -> str | None:
    normalized_ref = _trim_or_none(ref)
    if not normalized_ref:
        return None
    try:
        commit_row = _github_api_json(
            f"/repos/{owner}/{repo}/commits/{quote(normalized_ref, safe='')}"
        )
    except Exception:
        return None
    if not isinstance(commit_row, dict):
        return None
    return _short_commit(str(commit_row.get("sha") or ""))


def _latest_published_release(releases: object) -> dict | None:
    if not isinstance(releases, list):
        return None
    for row in releases:
        if not isinstance(row, dict):
            continue
        if row.get("draft") or row.get("prerelease"):
            continue
        return row
    for row in releases:
        if isinstance(row, dict):
            return row
    return None


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
    # Use the aliased URLRequest so it's not shadowed by fastapi.Request,
    # which is also imported in this module for endpoint type annotations.
    # urllib.request.Request accepts headers=, fastapi.Request does not —
    # mixing them up was the root cause of /api/admin/updates/status 500-ing.
    request = URLRequest(url, headers=headers)
    with urlopen(request, timeout=8) as response:
        payload = response.read().decode("utf-8")
    return json.loads(payload)


def _manual_update_steps(branch: str) -> list[str]:
    return [
        "BACKUP_PASSPHRASE='<passphrase>' ./scripts/backup.sh",
        "git fetch --tags --prune",
        f"git pull --ff-only origin {branch}",
        "./scripts/update_release_metadata.sh",
        "docker compose build api",
        "./scripts/preflight_migrations.sh",
        "docker compose run --rm api sh -lc 'cd /app && alembic upgrade head'",
        "docker compose up -d --build api api_worker web caddy",
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
    """Return True when at least one auto-install path is available.

    Two valid paths:
      1. The ``update_runner`` sidecar is reachable. This is the preferred
         path because the runner can do the full safe_update.sh flow
         (encrypted backup, maintenance mode, rebuild) without the api
         restarting itself mid-request.
      2. The legacy in-process path: a git repo is resolvable from the api
         container itself, so we can run git pull + alembic in-process.
         No rebuild step in this path — operators must trigger that
         out-of-band.
    """
    if update_runner_client.is_runner_reachable():
        return True
    return _resolve_repo_root() is not None


def _run_update_command(
    command: list[str],
    *,
    cwd: Path,
    env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            command,
            cwd=str(cwd),
            check=True,
            capture_output=True,
            text=True,
            env=env,
        )
    except FileNotFoundError as exc:
        raise HTTPException(status_code=500, detail=f"Command not found: {command[0]}") from exc
    except subprocess.CalledProcessError as exc:
        stderr = (exc.stderr or "").strip()
        stdout = (exc.stdout or "").strip()
        detail = stderr or stdout or f"Command failed: {' '.join(command)}"
        raise HTTPException(status_code=500, detail=detail) from exc


def _pg_conn_args_from_url(db_url) -> list[str]:
    return [
        "-h",
        db_url.host or "db",
        "-p",
        str(db_url.port or 5432),
        "-U",
        db_url.username or "smpl",
    ]


def _pg_env_from_url(db_url) -> dict[str, str]:
    env = os.environ.copy()
    if db_url.password:
        env["PGPASSWORD"] = db_url.password
    return env


def _sanitize_db_identifier(value: str) -> str:
    raw = re.sub(r"[^a-zA-Z0-9_]", "_", value.strip())
    if not raw:
        raw = "smpl"
    if raw[0].isdigit():
        raw = f"db_{raw}"
    return raw[:63]


def _create_pre_update_db_snapshot(repo_root: Path) -> Path:
    db_url = make_url(settings.database_url)
    if not db_url.drivername.startswith("postgresql"):
        raise HTTPException(status_code=400, detail="Automatic update requires PostgreSQL for DB safety snapshot")
    source_db_name = _trim_or_none(db_url.database)
    if not source_db_name:
        raise HTTPException(status_code=500, detail="Database name missing in DATABASE_URL")

    snapshot_dir = repo_root / "backups" / "pre-update"
    snapshot_dir.mkdir(parents=True, exist_ok=True)
    timestamp = utcnow().strftime("%Y%m%d-%H%M%S")
    snapshot_name = f"db-{_sanitize_db_identifier(source_db_name)}-{timestamp}.dump"
    snapshot_path = snapshot_dir / snapshot_name

    dump_cmd = [
        "pg_dump",
        "--format=custom",
        "--no-owner",
        "--no-privileges",
        *_pg_conn_args_from_url(db_url),
        "-d",
        source_db_name,
        "-f",
        str(snapshot_path),
    ]
    _run_update_command(dump_cmd, cwd=repo_root, env=_pg_env_from_url(db_url))
    return snapshot_path


def _run_migration_preflight(*, repo_root: Path, alembic_workdir: Path) -> list[str]:
    db_url = make_url(settings.database_url)
    if not db_url.drivername.startswith("postgresql"):
        raise HTTPException(status_code=400, detail="Migration preflight requires PostgreSQL")
    source_db_name = _trim_or_none(db_url.database)
    if not source_db_name:
        raise HTTPException(status_code=500, detail="Database name missing in DATABASE_URL")

    base_name = _sanitize_db_identifier(source_db_name)
    tmp_db_name = _sanitize_db_identifier(f"{base_name}_preflight_{utcnow().strftime('%Y%m%d%H%M%S')}_{secrets.token_hex(2)}")
    preflight_steps: list[str] = []
    pg_env = _pg_env_from_url(db_url)
    pg_conn_args = _pg_conn_args_from_url(db_url)

    with tempfile.TemporaryDirectory(prefix="smpl-update-preflight-") as tmp_dir:
        dump_path = Path(tmp_dir) / "db.dump"
        dump_cmd = [
            "pg_dump",
            "--format=custom",
            "--no-owner",
            "--no-privileges",
            *pg_conn_args,
            "-d",
            source_db_name,
            "-f",
            str(dump_path),
        ]
        _run_update_command(dump_cmd, cwd=repo_root, env=pg_env)
        preflight_steps.append(f"pg_dump {source_db_name} -> {dump_path.name}")

        create_cmd = [
            "psql",
            *pg_conn_args,
            "-d",
            "postgres",
            "-v",
            "ON_ERROR_STOP=1",
            "-c",
            f"CREATE DATABASE {tmp_db_name}",
        ]
        drop_cmd = [
            "psql",
            *pg_conn_args,
            "-d",
            "postgres",
            "-v",
            "ON_ERROR_STOP=1",
            "-c",
            f"DROP DATABASE IF EXISTS {tmp_db_name} WITH (FORCE)",
        ]

        try:
            _run_update_command(create_cmd, cwd=repo_root, env=pg_env)
            preflight_steps.append(f"created temp database {tmp_db_name}")

            restore_cmd = [
                "pg_restore",
                "--clean",
                "--if-exists",
                "--no-owner",
                "--no-privileges",
                *pg_conn_args,
                "-d",
                tmp_db_name,
                str(dump_path),
            ]
            _run_update_command(restore_cmd, cwd=repo_root, env=pg_env)
            preflight_steps.append(f"pg_restore -> {tmp_db_name}")

            preflight_env = os.environ.copy()
            preflight_env.update(pg_env)
            preflight_env["DATABASE_URL"] = str(db_url.set(database=tmp_db_name))
            _run_update_command(["alembic", "upgrade", "head"], cwd=alembic_workdir, env=preflight_env)
            preflight_steps.append("alembic upgrade head (preflight temp db)")
        finally:
            try:
                _run_update_command(drop_cmd, cwd=repo_root, env=pg_env)
            except HTTPException:
                pass

    return preflight_steps


def _fetch_update_status() -> UpdateStatusOut:
    owner = settings.update_repo_owner.strip()
    repo = settings.update_repo_name.strip()
    branch = (settings.update_repo_branch or "main").strip() or "main"
    if not owner or not repo:
        current_version, current_commit, unresolved_placeholder = _current_release_metadata()
        message = "Update repository is not configured"
        if unresolved_placeholder:
            message = (
                "Update repository is not configured. Current release version is unresolved; "
                "set APP_RELEASE_VERSION or run from a tagged git checkout."
            )
        return UpdateStatusOut(
            repository="",
            branch=branch,
            current_version=current_version,
            current_commit=current_commit,
            install_supported=False,
            install_mode="manual",
            install_steps=_manual_update_steps(branch),
            message=message,
        )

    repository = f"{owner}/{repo}"
    current_version, current_commit, unresolved_placeholder = _current_release_metadata()
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
        if current_version and not current_commit:
            current_commit = _resolve_commit_for_ref(owner, repo, current_version)

        releases = _github_api_json(f"/repos/{owner}/{repo}/releases")
        latest_release = _latest_published_release(releases)
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
            latest_commit = (
                _resolve_commit_for_ref(owner, repo, latest_version)
                or _resolve_commit_for_ref(owner, repo, commitish)
                or _resolve_commit_for_ref(owner, repo, branch)
            )
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

            if not current_version and current_commit:
                inferred_version = None
                if latest_version and _commit_refs_match(current_commit, latest_commit):
                    inferred_version = latest_version
                if not inferred_version:
                    inferred_version = _resolve_release_tag_for_commit(owner, repo, current_commit)
                if inferred_version:
                    current_version = inferred_version
                    unresolved_placeholder = False
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

            if not current_version and current_commit:
                inferred_version = _resolve_release_tag_for_commit(owner, repo, current_commit)
                if inferred_version:
                    current_version = inferred_version
                    unresolved_placeholder = False
    except (HTTPError, URLError, TimeoutError, json.JSONDecodeError, ValueError) as exc:
        message = f"Could not fetch update status from GitHub: {exc}"

    if unresolved_placeholder and not current_version and not message:
        message = (
            "Current release version is unresolved; run ./scripts/update_release_metadata.sh "
            "and restart api/api_worker, or set APP_RELEASE_VERSION and APP_RELEASE_COMMIT explicitly."
        )

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
    normalized = str(value).replace("\\r\\n", "\n").replace("\\n", "\n").replace("\r", "\n")
    rows = [
        line.strip()
        for line in normalized.split("\n")
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


def _material_row_key(row: dict[str, str]) -> tuple[str, str, str, str]:
    return (
        str(row.get("item") or "").strip().lower(),
        str(row.get("qty") or "").strip().lower(),
        str(row.get("unit") or "").strip().lower(),
        str(row.get("article_no") or "").strip().lower(),
    )


def _serialize_material_rows(rows: list[dict[str, str]]) -> str | None:
    lines: list[str] = []
    seen: set[tuple[str, str, str, str]] = set()
    for raw_row in rows:
        item = str(raw_row.get("item") or "").strip()
        if not item:
            continue
        row = {
            "item": item,
            "qty": str(raw_row.get("qty") or "").strip(),
            "unit": str(raw_row.get("unit") or "").strip(),
            "article_no": str(raw_row.get("article_no") or "").strip(),
        }
        key = _material_row_key(row)
        if key in seen:
            continue
        seen.add(key)
        if not row["qty"] and not row["unit"] and not row["article_no"]:
            lines.append(row["item"])
        else:
            lines.append(" | ".join([row["item"], row["qty"], row["unit"], row["article_no"]]))
    return "\n".join(lines).strip() or None


def _parse_material_lines(value: str | None) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    for raw_line in _split_multiline(value):
        parts = [part.strip() for part in raw_line.split("|", 3)]
        item = parts[0] if parts else ""
        if not item:
            continue
        while len(parts) < 4:
            parts.append("")
        rows.append(
            {
                "item": item,
                "qty": parts[1],
                "unit": parts[2],
                "article_no": parts[3],
            }
        )
    return rows


def _parse_project_class_template_csv(payload: bytes) -> dict[str, dict]:
    try:
        text = payload.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise HTTPException(status_code=400, detail="CSV must be UTF-8 encoded") from exc

    reader = csv.DictReader(StringIO(text))
    if not reader.fieldnames:
        raise HTTPException(status_code=400, detail="CSV has no header row")

    missing_headers = [header for header in PROJECT_CLASS_TEMPLATE_REQUIRED_HEADERS if header not in reader.fieldnames]
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
        material_item = str(row.get("material_item") or "").strip()
        if material_item:
            bucket["materials"].append(
                {
                    "item": material_item,
                    "qty": str(row.get("material_qty") or "").strip(),
                    "unit": str(row.get("material_unit") or "").strip(),
                    "article_no": str(row.get("material_article_no") or "").strip(),
                }
            )
        bucket["materials"].extend(_parse_material_lines(row.get("materials_required")))
        bucket["tools"].extend(_split_multiline(row.get("tools_required")))

        task_title = str(row.get("task_title") or "").strip()
        if task_title:
            task_description = str(row.get("task_description") or "").strip() or None
            task_type = _normalize_task_type(str(row.get("task_type") or ""), default="construction")
            task_subtasks = _split_multiline(row.get("task_subtasks"))
            bucket["task_templates"].append(
                {
                    "title": task_title,
                    "description": task_description,
                    "task_type": task_type,
                    "subtasks": task_subtasks,
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
        materials_value = _serialize_material_rows(entry["materials"])
        tools_list = _split_multiline("\n".join(entry["tools"]))

        task_templates: list[dict[str, object]] = []
        seen_tasks: set[tuple[str, str, str, str]] = set()
        for task in entry["task_templates"]:
            row = {
                "title": str(task.get("title") or "").strip(),
                "description": str(task.get("description") or "").strip() or None,
                "task_type": _normalize_task_type(str(task.get("task_type") or ""), default="construction"),
                "subtasks": _split_multiline("\n".join(task.get("subtasks") or [])),
            }
            if not row["title"]:
                continue
            task_key = (*_task_template_key(row), "\n".join(row["subtasks"]).strip().lower())
            if task_key in seen_tasks:
                continue
            seen_tasks.add(task_key)
            task_templates.append(row)

        total_tasks += len(task_templates)
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


def _request_public_base_url(request: Request | None) -> str | None:
    if request is None:
        return None
    forwarded_host = (request.headers.get("x-forwarded-host") or "").split(",", 1)[0].strip()
    forwarded_proto = (request.headers.get("x-forwarded-proto") or "").split(",", 1)[0].strip()
    host = forwarded_host or request.headers.get("host") or request.url.hostname or ""
    if not host:
        return None
    scheme = forwarded_proto or request.url.scheme or "https"
    root_path = str(request.scope.get("root_path") or "").rstrip("/")
    return f"{scheme}://{host}{root_path}"


def _build_action_link(path: str, token: str, request: Request | None = None) -> str:
    configured_base = (settings.app_public_url or "").strip().rstrip("/")
    request_base = _request_public_base_url(request)
    configured_is_local = (
        not configured_base
        or "localhost" in configured_base.lower()
        or "127.0.0.1" in configured_base.lower()
    )
    if configured_base and not configured_is_local:
        base = configured_base
    elif request_base:
        base = request_base.rstrip("/")
    elif configured_base:
        base = configured_base
    else:
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
def list_users(_: User = Depends(require_permission("users:manage")), db: Session = Depends(get_db)):
    from app.routers.time_tracking import _vacation_balance_out

    users = list(db.scalars(select(User).order_by(User.is_active.desc(), User.id)).all())
    rows: list[UserOut] = []
    for user in users:
        out = UserOut.model_validate(user)
        balance = _vacation_balance_out(db, user)
        out.vacation_days_available = balance.vacation_days_available
        out.vacation_days_carryover = balance.vacation_days_carryover
        out.vacation_days_total_remaining = balance.vacation_days_total_remaining
        rows.append(out)
    return rows


@router.get("/employee-groups", response_model=list[EmployeeGroupOut])
def list_employee_groups(_: User = Depends(require_permission("users:manage")), db: Session = Depends(get_db)):
    groups = db.scalars(select(EmployeeGroup).order_by(EmployeeGroup.name.asc(), EmployeeGroup.id.asc())).all()
    return [_employee_group_out(db, group) for group in groups]


@router.post("/employee-groups", response_model=EmployeeGroupOut)
def create_employee_group(
    payload: EmployeeGroupCreate,
    admin: User = Depends(require_permission("users:manage")),
    db: Session = Depends(get_db),
):
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Group name cannot be empty")
    exists = db.scalars(select(EmployeeGroup).where(EmployeeGroup.name == name)).first()
    if exists:
        raise HTTPException(status_code=409, detail="Employee group already exists")

    group = EmployeeGroup(
        name=name,
        can_update_recent_own_time_entries=bool(payload.can_update_recent_own_time_entries),
        created_by=admin.id,
    )
    db.add(group)
    db.flush()
    _sync_employee_group_members(db, group.id, payload.member_user_ids)
    db.commit()
    db.refresh(group)
    log_admin_action(
        db,
        admin,
        "employee_group.create",
        "employee_group",
        str(group.id),
        {
            "name": group.name,
            "member_user_ids": payload.member_user_ids,
            "can_update_recent_own_time_entries": bool(payload.can_update_recent_own_time_entries),
        },
    )
    return _employee_group_out(db, group)


@router.patch("/employee-groups/{group_id}", response_model=EmployeeGroupOut)
def update_employee_group(
    group_id: int,
    payload: EmployeeGroupUpdate,
    admin: User = Depends(require_permission("users:manage")),
    db: Session = Depends(get_db),
):
    group = db.get(EmployeeGroup, group_id)
    if not group:
        raise HTTPException(status_code=404, detail="Employee group not found")

    fields_set = getattr(payload, "model_fields_set", None)
    if fields_set is None:
        fields_set = getattr(payload, "__fields_set__", set())

    if "name" in fields_set and payload.name is not None:
        name = payload.name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="Group name cannot be empty")
        duplicate = db.scalars(select(EmployeeGroup).where(EmployeeGroup.name == name, EmployeeGroup.id != group.id)).first()
        if duplicate:
            raise HTTPException(status_code=409, detail="Employee group already exists")
        group.name = name

    if "member_user_ids" in fields_set and payload.member_user_ids is not None:
        _sync_employee_group_members(db, group.id, payload.member_user_ids)

    if "can_update_recent_own_time_entries" in fields_set and payload.can_update_recent_own_time_entries is not None:
        group.can_update_recent_own_time_entries = bool(payload.can_update_recent_own_time_entries)

    db.commit()
    db.refresh(group)
    log_admin_action(
        db,
        admin,
        "employee_group.update",
        "employee_group",
        str(group.id),
        payload.model_dump(exclude_none=True),
    )
    return _employee_group_out(db, group)


@router.delete("/employee-groups/{group_id}")
def delete_employee_group(
    group_id: int,
    admin: User = Depends(require_permission("users:manage")),
    db: Session = Depends(get_db),
):
    group = db.get(EmployeeGroup, group_id)
    if not group:
        raise HTTPException(status_code=404, detail="Employee group not found")
    group_name = group.name
    db.delete(group)
    db.commit()
    log_admin_action(
        db,
        admin,
        "employee_group.delete",
        "employee_group",
        str(group_id),
        {"name": group_name},
    )
    return {"ok": True, "group_id": group_id}


@router.post("/users", response_model=UserOut)
def create_user(
    payload: UserCreate,
    admin: User = Depends(require_permission("users:manage")),
    db: Session = Depends(get_db),
):
    role = (payload.role or ROLE_EMPLOYEE).strip().lower() or ROLE_EMPLOYEE
    if role not in ALL_ROLES:
        raise HTTPException(status_code=400, detail="Invalid role")
    _assert_can_assign_role(admin, role)
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
    request: Request,
    admin: User = Depends(require_permission("users:manage")),
    db: Session = Depends(get_db),
):
    role = (payload.role or ROLE_EMPLOYEE).strip().lower() or ROLE_EMPLOYEE
    if role not in ALL_ROLES:
        raise HTTPException(status_code=400, detail="Invalid role")
    _assert_can_assign_role(admin, role)

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
    invite_link = _build_action_link("/invite", raw_token, request)
    email_result = send_email_detailed(
        to_email=user.email,
        subject="Einladung zur SMPL Workflow Software",
        body=(
            "Sie wurden zur SMPL Workflow Software eingeladen.\n\n"
            f"Einladungslink: {invite_link}\n"
            f"Gueltig bis (UTC): {expires_at.isoformat()}Z\n\n"
            "Falls der Link nicht klickbar ist, kopieren Sie ihn in den Browser."
        ),
        db=db,
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
        {
            "email": user.email,
            "role": user.role,
            "sent": email_result.ok,
            "email_error_type": email_result.error_type,
        },
    )
    return InviteDispatchOut(
        user_id=user.id,
        email=user.email,
        sent=email_result.ok,
        invite_link=invite_link,
        expires_at=expires_at,
        email_error_type=email_result.error_type,
        email_error_detail=email_result.error_detail,
    )


@router.post("/backups/database")
async def create_database_backup(
    key_file: UploadFile = File(...),
    admin: User = Depends(require_permission("backups:export")),
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


# ── Full encrypted-archive backups (delegated to update_runner sidecar) ──────
#
# The /backups/database endpoint above produces a DB-only ad-hoc archive that
# the operator downloads with a per-export key file. The endpoints below cover
# the operational workflow: list / create / restore / upload / delete encrypted
# `backup-<ts>.tar.enc` archives produced by scripts/backup.sh — which include
# uploads + db dump + manifest, encrypted via the system-wide BACKUP_PASSPHRASE.
#
# All file I/O happens inside the update_runner container (which has the host
# repo bind-mounted at /repo). The api proxies via update_runner_client so the
# trust boundary stays clean: api validates permissions and audits, runner does
# the privileged work.


def _runner_unavailable_response() -> HTTPException:
    return HTTPException(
        status_code=503,
        detail=(
            "The update_runner sidecar is not reachable. "
            "Backup management requires the runner to be running."
        ),
    )


def _job_conflict_response(exc: update_runner_client.UpdateRunnerJobConflict) -> HTTPException:
    return HTTPException(
        status_code=409,
        detail={
            "message": str(exc),
            "active_job_id": exc.active_job_id,
        },
    )


@router.get("/backups")
def list_backup_archives(
    admin: User = Depends(require_permission("backups:manage")),
):
    """Enumerate encrypted `backup-*.tar.enc` files known to the runner.

    Returns metadata (filename, size, mtime) plus disk-usage stats so the UI
    can warn before the operator triggers a backup that would exhaust the
    partition. No file content is read.
    """
    try:
        payload = update_runner_client.list_backups()
    except update_runner_client.UpdateRunnerUnreachable:
        raise _runner_unavailable_response()
    except update_runner_client.UpdateRunnerRemoteError as exc:
        raise HTTPException(status_code=502, detail=f"Runner error: {exc}")

    files = payload.get("files") or []
    passphrase_set = bool(
        (settings.backup_passphrase or "").strip()
        or (settings.backup_passphrase_file or "").strip()
    )
    return {
        "files": files,
        "free_bytes": int(payload.get("free_bytes") or 0),
        "total_bytes": int(payload.get("total_bytes") or 0),
        "passphrase_configured": passphrase_set,
    }


@router.post("/backups/full")
def create_full_backup(
    admin: User = Depends(require_permission("backups:manage")),
    db: Session = Depends(get_db),
):
    """Kick off ``scripts/backup.sh`` via the runner. Returns a job id to poll.

    The runner reads the passphrase from its own ``BACKUP_PASSPHRASE`` env;
    the api never sees it. This means the api can verify "passphrase is set
    on this stack" only via the runtime check exposed in the list endpoint.
    """
    try:
        payload = update_runner_client.queue_backup_job()
    except update_runner_client.UpdateRunnerUnreachable:
        raise _runner_unavailable_response()
    except update_runner_client.UpdateRunnerJobConflict as exc:
        raise _job_conflict_response(exc)
    except update_runner_client.UpdateRunnerRemoteError as exc:
        raise HTTPException(status_code=502, detail=f"Runner error: {exc}")

    log_admin_action(
        db,
        admin,
        "backup.full.start",
        "backup",
        payload.get("job_id") or "",
        {"job_id": payload.get("job_id")},
    )
    return payload


@router.get("/backups/jobs/{job_id}")
def get_backup_job_progress(
    job_id: str,
    _: User = Depends(require_permission("backups:manage")),
):
    """Poll a backup-or-restore job. Mirrors the update-job progress endpoint."""
    try:
        payload = update_runner_client.get_job_status(job_id)
    except update_runner_client.UpdateRunnerUnreachable:
        raise _runner_unavailable_response()
    except KeyError:
        raise HTTPException(status_code=404, detail="Unknown job id")
    except update_runner_client.UpdateRunnerRemoteError as exc:
        raise HTTPException(status_code=502, detail=f"Runner error: {exc}")
    return payload


@router.get("/backups/{filename}")
def download_backup_archive(
    filename: str,
    admin: User = Depends(require_permission("backups:export")),
    db: Session = Depends(get_db),
):
    """Stream an encrypted backup file from the runner straight to the caller.

    The api never buffers the file — both ends use chunked streaming, so
    multi-GB downloads work even on a 512 MB api container.
    """
    try:
        chunks, headers = update_runner_client.stream_backup_download(filename)
    except update_runner_client.UpdateRunnerUnreachable:
        raise _runner_unavailable_response()
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Backup not found: {filename}")
    except update_runner_client.UpdateRunnerRemoteError as exc:
        raise HTTPException(status_code=502, detail=f"Runner error: {exc}")

    log_admin_action(
        db,
        admin,
        "backup.full.download",
        "backup",
        filename,
        {"size_bytes": int(headers.get("content-length") or 0)},
    )

    forward_headers = {
        "Content-Disposition": headers.get(
            "content-disposition", f'attachment; filename="{filename}"'
        ),
    }
    if "content-length" in headers:
        forward_headers["Content-Length"] = headers["content-length"]
    return StreamingResponse(
        chunks,
        media_type=headers.get("content-type", "application/octet-stream"),
        headers=forward_headers,
    )


@router.post("/backups/upload")
def upload_backup_archive(
    file: UploadFile = File(...),
    admin: User = Depends(require_permission("backups:restore")),
    db: Session = Depends(get_db),
):
    """Forward an externally-stored backup file to the runner's backups dir.

    Requires ``backups:restore`` rather than ``backups:manage`` because an
    uploaded file is a foothold for a subsequent restore — making the two
    actions cost the same trust opens fewer surprising authorization gaps.
    """
    raw_name = (file.filename or "").strip()
    if not raw_name:
        raise HTTPException(status_code=400, detail="Uploaded file has no filename")

    try:
        payload = update_runner_client.upload_backup(
            filename=raw_name,
            fileobj=file.file,
            content_type=file.content_type or "application/octet-stream",
        )
    except update_runner_client.UpdateRunnerUnreachable:
        raise _runner_unavailable_response()
    except update_runner_client.UpdateRunnerRemoteError as exc:
        # Runner returns 400 for invalid filename — surface that verbatim.
        if exc.status_code == 400:
            raise HTTPException(status_code=400, detail=exc.body)
        raise HTTPException(status_code=502, detail=f"Runner error: {exc}")

    log_admin_action(
        db,
        admin,
        "backup.full.upload",
        "backup",
        payload.get("filename") or raw_name,
        {"size_bytes": payload.get("size_bytes")},
    )
    return payload


@router.post("/backups/{filename}/restore")
def restore_from_backup(
    filename: str,
    admin: User = Depends(require_permission("backups:restore")),
    db: Session = Depends(get_db),
):
    """Kick off ``scripts/restore.sh <file>``. Returns a job id for polling.

    DESTRUCTIVE: the script runs ``pg_restore --clean --if-exists`` and wipes
    the uploads volume before restoring its contents. We rely on the UI's
    "type the filename to confirm" modal to avoid mis-clicks; the audit log
    captures who initiated each restore.
    """
    try:
        payload = update_runner_client.queue_restore_job(filename=filename)
    except update_runner_client.UpdateRunnerUnreachable:
        raise _runner_unavailable_response()
    except update_runner_client.UpdateRunnerJobConflict as exc:
        raise _job_conflict_response(exc)
    except update_runner_client.UpdateRunnerRemoteError as exc:
        # Runner returns 404 when the filename doesn't exist on disk.
        if exc.status_code == 404:
            raise HTTPException(status_code=404, detail=f"Backup not found: {filename}")
        if exc.status_code == 400:
            raise HTTPException(status_code=400, detail=exc.body)
        raise HTTPException(status_code=502, detail=f"Runner error: {exc}")

    log_admin_action(
        db,
        admin,
        "backup.full.restore.start",
        "backup",
        filename,
        {"job_id": payload.get("job_id")},
    )
    return payload


@router.delete("/backups/{filename}")
def delete_backup_archive(
    filename: str,
    admin: User = Depends(require_permission("backups:manage")),
    db: Session = Depends(get_db),
):
    """Remove an encrypted archive from the runner's backups directory."""
    try:
        payload = update_runner_client.delete_backup(filename)
    except update_runner_client.UpdateRunnerUnreachable:
        raise _runner_unavailable_response()
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Backup not found: {filename}")
    except update_runner_client.UpdateRunnerRemoteError as exc:
        if exc.status_code == 400:
            raise HTTPException(status_code=400, detail=exc.body)
        raise HTTPException(status_code=502, detail=f"Runner error: {exc}")

    log_admin_action(db, admin, "backup.full.delete", "backup", filename, {})
    return payload


@router.post("/users/{user_id}/send-invite", response_model=InviteDispatchOut)
def send_user_invite(
    user_id: int,
    request: Request,
    admin: User = Depends(require_permission("users:manage")),
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
    invite_link = _build_action_link("/invite", raw_token, request)
    email_result = send_email_detailed(
        to_email=user.email,
        subject="Einladung zur SMPL Workflow Software",
        body=(
            "Hier ist Ihr Einladungslink zur SMPL Workflow Software.\n\n"
            f"Einladungslink: {invite_link}\n"
            f"Gueltig bis (UTC): {expires_at.isoformat()}Z\n"
        ),
        db=db,
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
        {
            "email": user.email,
            "sent": email_result.ok,
            "email_error_type": email_result.error_type,
        },
    )
    return InviteDispatchOut(
        user_id=user.id,
        email=user.email,
        sent=email_result.ok,
        invite_link=invite_link,
        expires_at=expires_at,
        email_error_type=email_result.error_type,
        email_error_detail=email_result.error_detail,
    )


@router.post("/users/{user_id}/send-password-reset", response_model=PasswordResetDispatchOut)
def send_password_reset(
    user_id: int,
    request: Request,
    admin: User = Depends(require_permission("users:manage")),
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
    reset_link = _build_action_link("/reset-password", raw_token, request)
    email_result = send_email_detailed(
        to_email=user.email,
        subject="Passwort zuruecksetzen - SMPL Workflow",
        body=(
            "Sie oder ein Administrator haben einen Passwort-Reset angefordert.\n\n"
            f"Reset-Link: {reset_link}\n"
            f"Gueltig bis (UTC): {expires_at.isoformat()}Z\n"
        ),
        db=db,
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
        {
            "email": user.email,
            "sent": email_result.ok,
            "email_error_type": email_result.error_type,
        },
    )
    return PasswordResetDispatchOut(
        user_id=user.id,
        email=user.email,
        sent=email_result.ok,
        email_error_type=email_result.error_type,
        email_error_detail=email_result.error_detail,
        reset_link=reset_link,
        expires_at=expires_at,
    )


@router.delete("/users/{user_id}")
def soft_delete_user(
    user_id: int,
    admin: User = Depends(require_permission("users:manage")),
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
def update_user(
    user_id: int,
    payload: UserUpdate,
    admin: User = Depends(require_permission("users:manage")),
    db: Session = Depends(get_db),
):
    from app.schemas.user import VALID_WORKSPACE_LOCKS

    user = db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    if payload.role and payload.role not in ALL_ROLES:
        raise HTTPException(status_code=400, detail="Invalid role")

    # Prevent a user from changing their own role (self-lockout protection)
    if payload.role and user_id == admin.id:
        raise HTTPException(status_code=403, detail="You cannot change your own role")

    if payload.role and payload.role != user.role:
        _assert_can_assign_role(admin, payload.role)

    if payload.workspace_lock is not None and payload.workspace_lock not in VALID_WORKSPACE_LOCKS:
        raise HTTPException(status_code=400, detail="workspace_lock must be 'construction', 'office', or null")

    for field in [
        "full_name",
        "role",
        "is_active",
        "required_daily_hours",
        "vacation_days_per_year",
        "vacation_days_available",
        "vacation_days_carryover",
    ]:
        value = getattr(payload, field)
        if value is not None:
            setattr(user, field, value)

    # workspace_lock uses explicit set membership so null (clear) also takes effect
    if "workspace_lock" in payload.model_fields_set:
        user.workspace_lock = payload.workspace_lock

    db.add(user)
    db.commit()
    db.refresh(user)
    log_admin_action(db, admin, "user.update", "user", str(user.id), payload.model_dump(exclude_none=True))
    return user


@router.post("/users/{user_id}/apply-template")
def apply_template(
    user_id: int,
    template: str = "default",
    admin: User = Depends(require_permission("permissions:manage")),
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
def audit_logs(_: User = Depends(require_permission("audit:view")), db: Session = Depends(get_db)):
    logs = list(db.scalars(select(AuditLog).order_by(AuditLog.created_at.desc()).limit(300)).all())
    return [
        {
            "id": log.id,
            "actor_user_id": log.actor_user_id,
            "category": log.category,
            "action": log.action,
            "target_type": log.target_type,
            "target_id": log.target_id,
            "details": log.details,
            "created_at": log.created_at,
        }
        for log in logs
    ]


def _audit_log_query_with_filters(
    db: Session,
    *,
    from_iso: str | None,
    to_iso: str | None,
    categories: list[str] | None,
    limit: int | None,
):
    """Shared query helper for audit-log list + CSV export. Filters mirror
    the Audit tab's UI controls: ISO date range + multi-category."""
    stmt = select(AuditLog).order_by(AuditLog.created_at.desc())
    if from_iso:
        try:
            from_dt = datetime.fromisoformat(from_iso)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=f"Invalid 'from' date: {exc}") from exc
        stmt = stmt.where(AuditLog.created_at >= from_dt)
    if to_iso:
        try:
            to_dt = datetime.fromisoformat(to_iso)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=f"Invalid 'to' date: {exc}") from exc
        stmt = stmt.where(AuditLog.created_at <= to_dt)
    if categories:
        stmt = stmt.where(AuditLog.category.in_(categories))
    if limit is not None:
        stmt = stmt.limit(limit)
    return list(db.scalars(stmt).all())


@router.get("/audit-logs/export.csv")
def export_audit_logs_csv(
    from_: str | None = Query(default=None, alias="from"),
    to: str | None = Query(default=None),
    category: list[str] | None = Query(default=None),
    _: User = Depends(require_permission("audit:view")),
    db: Session = Depends(get_db),
):
    """Stream the audit log as CSV with the same filters as the UI panel.

    Query params:
        from        ISO datetime (inclusive lower bound) — e.g. 2026-04-01
        to          ISO datetime (inclusive upper bound) — e.g. 2026-04-30T23:59:59
        category    repeatable; multiple categories OR'd together

    No row cap on the export — operators downloading for compliance need
    the full slice. Streaming output keeps memory bounded for multi-million
    row exports if the table is ever that large.
    """
    rows = _audit_log_query_with_filters(
        db,
        from_iso=from_,
        to_iso=to,
        categories=category,
        limit=None,
    )

    buffer = StringIO()
    writer = csv.writer(buffer)
    writer.writerow(
        [
            "id",
            "created_at_utc",
            "category",
            "action",
            "actor_user_id",
            "target_type",
            "target_id",
            "details_json",
        ]
    )
    for row in rows:
        writer.writerow(
            [
                row.id,
                row.created_at.isoformat() if row.created_at else "",
                row.category,
                row.action,
                row.actor_user_id if row.actor_user_id is not None else "",
                row.target_type,
                row.target_id,
                json.dumps(row.details, ensure_ascii=False, sort_keys=True),
            ]
        )

    timestamp = utcnow().strftime("%Y%m%d-%H%M%S")
    filename = f"audit-logs-{timestamp}.csv"
    return Response(
        buffer.getvalue(),
        media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": _content_disposition(filename, inline=False),
            # Cache buster: the CSV reflects the live DB state, never re-use.
            "Cache-Control": "no-store",
        },
    )


@router.get("/projects/import-template.csv")
def download_project_import_template(
    _: User = Depends(require_permission("projects:import")),
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
            "100000",
            "35000",
            "50000",
            "15000",
            "70000",
            "65000",
            "35000",
            "120",
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
    admin: User = Depends(require_permission("projects:import")),
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
            "skipped_project_fields": stats.skipped_project_fields,
            "skipped_finance_fields": stats.skipped_finance_fields,
            "skipped_filled_fields": stats.skipped_project_fields + stats.skipped_finance_fields,
        },
    )
    return {
        "processed_rows": stats.processed_rows,
        "created": stats.created,
        "updated": stats.updated,
        "temporary_numbers": stats.temporary_numbers,
        "duplicates_skipped": stats.duplicates_skipped,
        "skipped_project_fields": stats.skipped_project_fields,
        "skipped_finance_fields": stats.skipped_finance_fields,
        "skipped_filled_fields": stats.skipped_project_fields + stats.skipped_finance_fields,
    }


@router.get("/project-classes/template.csv")
def download_project_class_template(
    _: User = Depends(require_permission("projects:import")),
):
    buffer = StringIO()
    writer = csv.writer(buffer)
    writer.writerow(PROJECT_CLASS_TEMPLATE_HEADERS)
    writer.writerow(
        [
            "PV Standard",
            "PV modules | 24 | pcs | PV-001\nDC cable set | 2 | roll | CAB-002\nChecklist | 1 | set | CHK-010",
            "Cable cutter\nCrimping tool",
            "Mount PV modules",
            "Mount rails and modules on the target roof section.",
            "construction",
            "Mount rails\nInstall modules",
        ]
    )
    writer.writerow(
        [
            "PV Standard",
            "PV modules | 24 | pcs | PV-001\nDC cable set | 2 | roll | CAB-002\nChecklist | 1 | set | CHK-010",
            "Cable cutter\nCrimping tool",
            "Commissioning and handover",
            "Check inverter parameters and document customer handover.",
            "office",
            "Check inverter\nDocument handover",
        ]
    )
    writer.writerow(
        [
            "PV Standard",
            "PV modules | 24 | pcs | PV-001\nDC cable set | 2 | roll | CAB-002\nChecklist | 1 | set | CHK-010",
            "Tablet\nMeasuring tape",
            "Customer on-site appointment",
            "Visit customer, confirm measurements, and collect required signatures.",
            "customer_appointment",
            "Measure roof\nCollect signatures",
        ]
    )
    writer.writerow(
        [
            "Heat Pump Retrofit",
            "Heat pump unit | 1 | pcs | HP-100",
            "Vacuum pump\nPressure gauge",
            "Install heat pump",
            "Prepare hydraulics and connect the heat pump unit.",
            "construction",
            "Connect hydraulics\nPressure test",
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
    admin: User = Depends(require_permission("projects:import")),
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
    _: User = Depends(require_permission("settings:manage")),
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
    admin: User = Depends(require_permission("settings:manage")),
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


@router.get("/settings/openai", response_model=OpenAISettingsOut)
def get_openai_runtime_settings(
    _: User = Depends(require_permission("settings:manage")),
    db: Session = Depends(get_db),
):
    """Return the masked OpenAI key + currently selected extraction model."""
    effective = get_openai_settings(db)
    api_key = (effective.get("api_key") or "").strip()
    return OpenAISettingsOut(
        provider="openai",
        configured=bool(api_key),
        masked_api_key=_mask_secret(api_key),
        extraction_model=str(effective.get("extraction_model") or "").strip()
        or OPENAI_DEFAULT_EXTRACTION_MODEL,
    )


@router.patch("/settings/openai", response_model=OpenAISettingsOut)
def update_openai_runtime_settings(
    payload: OpenAISettingsUpdate,
    admin: User = Depends(require_permission("settings:manage")),
    db: Session = Depends(get_db),
):
    """Update the OpenAI key and/or extraction model.

    Behaviour mirrors the SMTP password handling: a blank ``api_key`` keeps
    the existing key (so the masked-placeholder UX doesn't accidentally wipe
    it), while ``clear_api_key=True`` explicitly blanks it. The model name is
    always overwritten — a blank model snaps back to the default
    ``gpt-4o-mini`` rather than being left empty.
    """
    current = get_openai_settings(db)
    incoming_key = (payload.api_key or "").strip()

    if payload.clear_api_key:
        next_key = ""
    elif incoming_key:
        next_key = incoming_key
    else:
        next_key = (current.get("api_key") or "").strip()

    next_model = (payload.extraction_model or "").strip() or OPENAI_DEFAULT_EXTRACTION_MODEL

    set_openai_settings(db, api_key=next_key, extraction_model=next_model)
    db.commit()
    log_admin_action(
        db,
        admin,
        "settings.openai.update",
        "settings",
        "openai",
        {
            "configured": bool(next_key),
            "extraction_model": next_model,
            "key_changed": (next_key != (current.get("api_key") or "").strip()),
        },
    )
    return OpenAISettingsOut(
        provider="openai",
        configured=bool(next_key),
        masked_api_key=_mask_secret(next_key),
        extraction_model=next_model,
    )


@router.get("/settings/company/public", response_model=CompanySettingsOut)
def get_public_company_settings(
    db: Session = Depends(get_db),
):
    effective = get_company_settings(db)
    return CompanySettingsOut(
        logo_url=str(effective.get("logo_url") or "").strip(),
        navigation_title=str(effective.get("navigation_title") or "").strip() or "SMPL",
        company_name=str(effective.get("company_name") or "").strip() or "SMPL",
        company_address=str(effective.get("company_address") or "").strip(),
    )


@router.get("/settings/company", response_model=CompanySettingsOut)
def get_company_runtime_settings(
    _: User = Depends(require_permission("settings:manage")),
    db: Session = Depends(get_db),
):
    effective = get_company_settings(db)
    return CompanySettingsOut(
        logo_url=str(effective.get("logo_url") or "").strip(),
        navigation_title=str(effective.get("navigation_title") or "").strip() or "SMPL",
        company_name=str(effective.get("company_name") or "").strip() or "SMPL",
        company_address=str(effective.get("company_address") or "").strip(),
    )


@router.patch("/settings/company", response_model=CompanySettingsOut)
def update_company_runtime_settings(
    payload: CompanySettingsUpdate,
    admin: User = Depends(require_permission("settings:manage")),
    db: Session = Depends(get_db),
):
    logo_url = (payload.logo_url or "").strip()
    navigation_title = (payload.navigation_title or "").strip() or "SMPL"
    company_name = (payload.company_name or "").strip() or "SMPL"
    company_address = (payload.company_address or "").strip()

    set_company_settings(
        db,
        logo_url=logo_url,
        navigation_title=navigation_title,
        company_name=company_name,
        company_address=company_address,
    )
    db.commit()
    log_admin_action(
        db,
        admin,
        "settings.company.update",
        "settings",
        "company",
        {
            "has_logo": bool(logo_url),
            "navigation_title": navigation_title,
            "company_name": company_name,
            "company_address": company_address,
        },
    )
    return CompanySettingsOut(
        logo_url=logo_url,
        navigation_title=navigation_title,
        company_name=company_name,
        company_address=company_address,
    )


@router.get("/settings/smtp", response_model=SmtpSettingsOut)
def get_smtp_runtime_settings(
    _: User = Depends(require_permission("settings:manage")),
    db: Session = Depends(get_db),
):
    effective = get_smtp_settings(db)
    password = str(effective.get("password") or "")
    host = str(effective.get("host") or "").strip()
    from_email = str(effective.get("from_email") or "").strip()
    return SmtpSettingsOut(
        host=host,
        port=int(effective.get("port") or 587),
        username=str(effective.get("username") or "").strip(),
        has_password=bool(password),
        masked_password=_mask_secret(password),
        starttls=bool(effective.get("starttls")),
        ssl=bool(effective.get("ssl")),
        from_email=from_email,
        from_name=str(effective.get("from_name") or "").strip(),
        configured=bool(host and from_email),
    )


@router.patch("/settings/smtp", response_model=SmtpSettingsOut)
def update_smtp_runtime_settings(
    payload: SmtpSettingsUpdate,
    admin: User = Depends(require_permission("settings:manage")),
    db: Session = Depends(get_db),
):
    current = get_smtp_settings(db)
    host = (payload.host or "").strip()
    port = int(payload.port or 0) or 587
    username = (payload.username or "").strip()
    from_email = (payload.from_email or "").strip()
    from_name = (payload.from_name or "").strip()

    if host and not from_email:
        raise HTTPException(status_code=400, detail="Sender email is required when SMTP is configured")
    if payload.ssl and payload.starttls:
        raise HTTPException(status_code=400, detail="Choose either SSL or STARTTLS, not both")

    if payload.clear_password:
        password = ""
    elif payload.password:
        password = payload.password
    else:
        password = str(current.get("password") or "")

    set_smtp_settings(
        db,
        host=host,
        port=port,
        username=username,
        password=password,
        starttls=bool(payload.starttls),
        ssl=bool(payload.ssl),
        from_email=from_email,
        from_name=from_name,
    )
    db.commit()
    log_admin_action(
        db,
        admin,
        "settings.smtp.update",
        "settings",
        "smtp",
        {
            "configured": bool(host and from_email),
            "host": host,
            "port": port,
            "username": username,
            "has_password": bool(password),
            "starttls": bool(payload.starttls),
            "ssl": bool(payload.ssl),
            "from_email": from_email,
            "from_name": from_name,
        },
    )
    return SmtpSettingsOut(
        host=host,
        port=port,
        username=username,
        has_password=bool(password),
        masked_password=_mask_secret(password),
        starttls=bool(payload.starttls),
        ssl=bool(payload.ssl),
        from_email=from_email,
        from_name=from_name,
        configured=bool(host and from_email),
    )


@router.post("/settings/smtp/test", response_model=SmtpTestResultOut)
def send_smtp_test_email(
    payload: SmtpTestRequest,
    admin: User = Depends(require_permission("settings:manage")),
    db: Session = Depends(get_db),
) -> SmtpTestResultOut:
    """Send a short test email using the currently saved SMTP settings.

    Response always has HTTP 200 — the outcome sits in `ok`/`error_type`/
    `error_detail` so admins see WHY the send failed instead of a silent
    'clipboard fallback'. Defaults the recipient to the admin's own email
    when none is provided (safest no-typo path)."""
    to_email = (payload.to_email or admin.email).strip()
    if not to_email:
        return SmtpTestResultOut(
            ok=False,
            error_type="recipient",
            error_detail="No recipient email available.",
            to_email="",
        )

    body = (
        "Dies ist eine SMTP-Test-E-Mail von SMPL Workflow.\n"
        "Wenn Sie diese Nachricht erhalten haben, sind die SMTP-Einstellungen korrekt.\n\n"
        f"Ausgelöst durch: {admin.full_name or admin.email}\n"
        f"Zeitpunkt (UTC): {utcnow().isoformat()}Z\n"
    )
    result = send_email_detailed(
        to_email=to_email,
        subject="SMPL Workflow — SMTP-Testnachricht",
        body=body,
        db=db,
    )
    log_admin_action(
        db,
        admin,
        "settings.smtp.test",
        "settings",
        "smtp",
        {
            "to_email": to_email,
            "ok": result.ok,
            "error_type": result.error_type,
        },
    )
    return SmtpTestResultOut(
        ok=result.ok,
        error_type=result.error_type,
        error_detail=result.error_detail,
        to_email=to_email,
    )


@router.get("/updates/status", response_model=UpdateStatusOut)
def get_updates_status(
    _: User = Depends(require_permission("system:manage")),
):
    return _fetch_update_status()


def _delegate_real_install_to_runner(
    *,
    branch: str,
    status: UpdateStatusOut,
    admin: User,
    db: Session,
) -> UpdateInstallOut | None:
    """Try the runner-mediated install path.

    Returns the response to send to the client when the runner accepted (or
    explicitly rejected with a known status) the job. Returns ``None`` when
    the runner is unavailable, signalling the caller should fall back to the
    legacy in-process path.

    A 409 conflict (job already in flight) is surfaced as an ``ok=False``
    response that still carries ``job_id`` so the UI can offer to resume
    polling rather than silently swallow the prior run.
    """
    try:
        runner_response = update_runner_client.queue_update_job(branch=branch, pull=True)
    except update_runner_client.UpdateRunnerUnreachable:
        return None
    except update_runner_client.UpdateRunnerJobConflict as exc:
        return UpdateInstallOut(
            ok=False,
            mode="auto",
            async_mode=True,
            job_id=exc.active_job_id,
            detail=str(exc),
            ran_steps=[],
            dry_run=False,
        )
    except update_runner_client.UpdateRunnerError as exc:
        return UpdateInstallOut(
            ok=False,
            mode="auto",
            detail=f"Update runner returned an error: {exc}",
            ran_steps=[],
            dry_run=False,
        )

    job_id = str(runner_response.get("job_id") or "").strip()
    if not job_id:
        return UpdateInstallOut(
            ok=False,
            mode="auto",
            detail="Update runner accepted the request but returned no job id.",
            ran_steps=[],
            dry_run=False,
        )

    log_admin_action(
        db,
        admin,
        "system.update.install.dispatched",
        "system",
        "updates",
        {
            "repository": status.repository,
            "branch": branch,
            "job_id": job_id,
            "delegated_to": "update_runner",
            "latest_version": status.latest_version,
            "latest_commit": status.latest_commit,
        },
    )
    return UpdateInstallOut(
        ok=True,
        mode="auto",
        async_mode=True,
        job_id=job_id,
        detail=(
            f"Update job {job_id} dispatched to the update runner. "
            "The full safety flow (encrypted backup, maintenance mode, "
            "alembic preflight + migrate, rebuild + healthchecks) is now "
            "running in the background."
        ),
        ran_steps=[
            "delegated to update_runner sidecar",
            f"job_id={job_id}",
        ],
        dry_run=False,
    )


@router.post("/updates/install", response_model=UpdateInstallOut)
def install_updates(
    payload: UpdateInstallRequest,
    admin: User = Depends(require_permission("system:manage")),
    db: Session = Depends(get_db),
):
    status = _fetch_update_status()
    branch = status.branch or "main"

    # Honour the status's install_supported gate first: if no auto path is
    # available, we must not silently try to delegate or run in-process.
    # ``_can_auto_install_updates`` (which feeds install_supported) accounts
    # for both the runner and the legacy repo-mount path.
    if not status.install_supported:
        return UpdateInstallOut(
            ok=False,
            mode="manual",
            detail="Automatic install is unavailable in this deployment. Run the manual update commands.",
            ran_steps=[],
            dry_run=payload.dry_run,
        )

    # Real installs are preferentially delegated to the update_runner sidecar
    # so safe_update.sh can rebuild + restart the api stack without the api
    # process taking itself out mid-request. Returns immediately with a
    # job_id; the UI polls /admin/updates/progress/{job_id}. Falls through
    # to the in-process path when the runner is unreachable.
    if not payload.dry_run:
        delegated = _delegate_real_install_to_runner(
            branch=branch, status=status, admin=admin, db=db
        )
        if delegated is not None:
            return delegated

    repo_root = _resolve_repo_root()
    if repo_root is None:
        return UpdateInstallOut(
            ok=False,
            mode="manual",
            detail="Could not locate a git repository for automatic install.",
            ran_steps=[],
            dry_run=payload.dry_run,
        )
    command_steps: list[tuple[str, list[str], Path]] = [
        ("git.fetch", ["git", "fetch", "--tags", "--prune", "origin"], repo_root),
        ("git.pull", ["git", "pull", "--ff-only", "origin", branch], repo_root),
        ("release.metadata", ["./scripts/update_release_metadata.sh"], repo_root),
    ]

    api_dir_candidate = repo_root / "apps" / "api"
    alembic_workdir = api_dir_candidate if (api_dir_candidate / "alembic.ini").exists() else repo_root
    ran_steps: list[str] = []
    if payload.dry_run:
        try:
            preflight_steps = _run_migration_preflight(repo_root=repo_root, alembic_workdir=alembic_workdir)
        except HTTPException as exc:
            return UpdateInstallOut(
                ok=False,
                mode="auto",
                detail=f"Dry run failed during migration preflight: {exc.detail}",
                ran_steps=[" ".join(cmd) for _, cmd, _ in command_steps],
                dry_run=True,
            )
        ran_steps = [" ".join(cmd) for _, cmd, _ in command_steps]
        ran_steps.extend(preflight_steps)
        return UpdateInstallOut(
            ok=True,
            mode="auto",
            detail=(
                "Dry run complete. Migration preflight passed on a temporary cloned database. "
                "Git pull and real migrations were not executed."
            ),
            ran_steps=ran_steps,
            dry_run=True,
        )

    snapshot_path: Path | None = None
    try:
        for _, command, cwd in command_steps:
            _run_update_command(command, cwd=cwd)
            ran_steps.append(" ".join(command))

        snapshot_path = _create_pre_update_db_snapshot(repo_root)
        try:
            snapshot_label = str(snapshot_path.relative_to(repo_root))
        except ValueError:
            snapshot_label = str(snapshot_path)
        ran_steps.append(f"pre-update snapshot: {snapshot_label}")

        preflight_steps = _run_migration_preflight(repo_root=repo_root, alembic_workdir=alembic_workdir)
        ran_steps.extend(preflight_steps)

        _run_update_command(["alembic", "upgrade", "head"], cwd=alembic_workdir)
        ran_steps.append("alembic upgrade head")
    except HTTPException as exc:
        backup_note = ""
        if snapshot_path is not None:
            backup_note = f" Snapshot kept at: {snapshot_path}."
        return UpdateInstallOut(
            ok=False,
            mode="auto",
            detail=f"Automatic install aborted before DB migration completion: {exc.detail}.{backup_note}",
            ran_steps=ran_steps,
            dry_run=False,
        )

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
            "snapshot_path": str(snapshot_path) if snapshot_path else None,
        },
    )

    return UpdateInstallOut(
        ok=True,
        mode="auto",
        detail=(
            "Update commands completed successfully. "
            f"Pre-update DB snapshot created at {snapshot_path}."
        ),
        ran_steps=ran_steps,
        dry_run=False,
    )


@router.get("/updates/progress/{job_id}", response_model=UpdateProgressOut)
def get_update_progress(
    job_id: str,
    _: User = Depends(require_permission("system:manage")),
):
    """Proxy the runner's job-status snapshot to the admin UI.

    This is the polling endpoint the System tab hits while a runner-mediated
    install is in flight. Translates runner errors into HTTP statuses the
    client can act on:
      - 404 if the job id is unknown to the runner (e.g. runner restarted)
      - 503 if the runner is unreachable from this api process
      - 502 for any other runner-side failure
    """
    try:
        payload = update_runner_client.get_job_status(job_id)
    except update_runner_client.UpdateRunnerUnreachable as exc:
        raise HTTPException(status_code=503, detail=f"Update runner is unreachable: {exc}")
    except KeyError:
        raise HTTPException(status_code=404, detail="Unknown update job id")
    except update_runner_client.UpdateRunnerError as exc:
        raise HTTPException(status_code=502, detail=str(exc))

    return UpdateProgressOut(
        job_id=str(payload.get("job_id") or job_id),
        kind=str(payload.get("kind") or "update"),
        status=str(payload.get("status") or "unknown"),
        started_at=payload.get("started_at"),
        finished_at=payload.get("finished_at"),
        exit_code=payload.get("exit_code"),
        detail=payload.get("detail"),
        log_tail=str(payload.get("log_tail") or ""),
    )


# ── Role permissions ──────────────────────────────────────────────────────────


@router.get("/role-permissions")
def get_role_permissions(
    _: User = Depends(require_permission("permissions:manage")),
) -> dict:
    """Return the currently effective permission map plus metadata for the UI."""
    return {
        "permissions": get_effective_permissions(),
        "all_permissions": sorted(ALL_PERMISSIONS),
        "permission_labels": PERMISSION_LABELS,
        "permission_descriptions": PERMISSION_DESCRIPTIONS,
        "permission_groups": PERMISSION_GROUPS,
        "all_roles": ALL_ROLES,
    }


class RolePermissionsUpdate(dict):
    """Plain dict body: { role: string, permissions: list[str] }"""


@router.put("/role-permissions/{role}")
def update_role_permissions(
    role: str,
    payload: dict,
    admin: User = Depends(require_permission("permissions:manage")),
    db: Session = Depends(get_db),
) -> dict:
    """Set the permission list for a single role.  Returns the full effective map."""
    if role not in ALL_ROLES:
        raise HTTPException(status_code=400, detail=f"Unknown role: {role}")

    # The admin role always retains full permissions — prevent accidental lockout
    if role == "admin":
        raise HTTPException(status_code=403, detail="The admin role permissions cannot be modified")

    permissions: list[str] = payload.get("permissions", [])
    if not isinstance(permissions, list):
        raise HTTPException(status_code=400, detail="'permissions' must be a list")

    invalid = [p for p in permissions if p not in ALL_PERMISSIONS]
    if invalid:
        raise HTTPException(status_code=400, detail=f"Unknown permissions: {invalid}")

    # Load current map, apply update for this role, save.
    current = get_effective_permissions()  # returns dict[str, list[str]]
    current[role] = sorted(set(permissions))
    updated = save_role_permissions_to_db(db, current)

    log_admin_action(
        db,
        admin,
        "role_permissions.update",
        "role",
        role,
        {"permissions": sorted(permissions)},
    )
    return {"permissions": updated}


@router.delete("/role-permissions/{role}")
def reset_role_permissions(
    role: str,
    admin: User = Depends(require_permission("permissions:manage")),
    db: Session = Depends(get_db),
) -> dict:
    """Reset a single role's permissions back to hard-coded defaults."""
    if role not in ALL_ROLES:
        raise HTTPException(status_code=400, detail=f"Unknown role: {role}")

    if role == "admin":
        raise HTTPException(status_code=403, detail="The admin role permissions cannot be modified")

    updated = reset_role_to_defaults(db, role)
    log_admin_action(db, admin, "role_permissions.reset", "role", role, {})
    return {"permissions": updated}


# ── Per-user permission overrides ────────────────────────────────────────────

@router.get("/user-permissions/{user_id}")
def get_user_permissions(
    user_id: int,
    _: User = Depends(require_permission("permissions:manage")),
    db: Session = Depends(get_db),
) -> dict:
    """Return the current extra/denied permission overrides for one user."""
    # Verify user exists.
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    overrides = get_user_override(user_id)
    return {"user_id": user_id, "extra": overrides["extra"], "denied": overrides["denied"]}


class UserPermissionsUpdate(BaseModel):
    extra: list[str] = []
    denied: list[str] = []


@router.put("/user-permissions/{user_id}")
def set_user_permissions(
    user_id: int,
    payload: UserPermissionsUpdate,
    admin: User = Depends(require_permission("permissions:manage")),
    db: Session = Depends(get_db),
) -> dict:
    """Set per-user permission overrides (extra grants and explicit denies)."""
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    # Validate all permission strings.
    unknown_extra = [p for p in payload.extra if p not in ALL_PERMISSIONS]
    unknown_denied = [p for p in payload.denied if p not in ALL_PERMISSIONS]
    if unknown_extra or unknown_denied:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown permissions: {unknown_extra + unknown_denied}",
        )

    result = save_user_permissions_to_db(db, user_id, payload.extra, payload.denied)
    log_admin_action(
        db,
        admin,
        "user_permissions.update",
        "user",
        str(user_id),
        {"extra": result["extra"], "denied": result["denied"]},
    )
    return {"user_id": user_id, "extra": result["extra"], "denied": result["denied"]}


@router.delete("/user-permissions/{user_id}")
def reset_user_permissions(
    user_id: int,
    admin: User = Depends(require_permission("permissions:manage")),
    db: Session = Depends(get_db),
) -> dict:
    """Remove all per-user permission overrides (revert to role defaults)."""
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    reset_user_permissions_from_db(db, user_id)
    log_admin_action(db, admin, "user_permissions.reset", "user", str(user_id), {})
    return {"user_id": user_id, "extra": [], "denied": []}
