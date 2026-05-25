from __future__ import annotations
import asyncio
from collections import defaultdict, deque
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from datetime import datetime, timedelta

from fastapi import Depends, FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy.exc import OperationalError, ProgrammingError
from sqlalchemy import select

from app.core.config import get_settings
from app.core.db import SessionLocal
from app.core.permissions import ROLE_ADMIN
from app.core.security import get_password_hash, verify_password
from app.core.time import utcnow
from app.models.entities import User
from app.routers import admin, api_tokens, auth, events, time_tracking, workflow, workflow_notifications
from app.services.material_catalog import sync_pending_material_catalog_images
from app.services.runtime_settings import (
    is_initial_admin_bootstrap_completed,
    load_role_permissions_from_db,
    load_user_permissions_from_db,
    mark_initial_admin_bootstrap_completed,
)

# One thread dedicated to image fetching so it never competes with request handling.
_image_thread_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="img-catalog")


async def _image_loop() -> None:
    """Continuously process pending material catalog image lookups in the background.

    Runs every 30 seconds, processing IMAGE_BATCH_SIZE items per cycle.
    Isolated to a single executor thread so blocking HTTP calls can't affect
    the asyncio event loop or request workers.
    """
    IMAGE_BATCH_SIZE = 10
    IMAGE_INTERVAL_SECONDS = 30
    STARTUP_GRACE_SECONDS = 15  # allow the server to finish startup before first run

    await asyncio.sleep(STARTUP_GRACE_SECONDS)
    loop = asyncio.get_running_loop()

    while True:
        try:
            def _run_batch() -> None:
                with SessionLocal() as db:
                    sync_pending_material_catalog_images(db, limit=IMAGE_BATCH_SIZE)

            await loop.run_in_executor(_image_thread_pool, _run_batch)
        except Exception:
            pass  # never crash the loop; errors are already handled inside the service
        await asyncio.sleep(IMAGE_INTERVAL_SECONDS)

settings = get_settings()


def _initialize_runtime_data() -> None:
    if not settings.initial_admin_bootstrap:
        return
    try:
        with SessionLocal() as db:
            if is_initial_admin_bootstrap_completed(db):
                return

            normalized_admin_email = settings.initial_admin_email.strip().lower()
            existing = db.scalars(select(User).where(User.email == normalized_admin_email)).first()
            if existing:
                if not verify_password(settings.initial_admin_password, existing.password_hash):
                    mark_initial_admin_bootstrap_completed(db)
                    db.commit()
                return

            active_admin_exists = db.scalars(
                select(User.id).where(User.role == ROLE_ADMIN, User.is_active.is_(True)).limit(1)
            ).first()
            if active_admin_exists:
                mark_initial_admin_bootstrap_completed(db)
                db.commit()
                return

            admin_user = User(
                email=normalized_admin_email,
                password_hash=get_password_hash(settings.initial_admin_password),
                full_name=settings.initial_admin_name,
                role=ROLE_ADMIN,
                is_active=True,
            )
            db.add(admin_user)
            db.commit()
    except (OperationalError, ProgrammingError) as exc:
        raise RuntimeError(
            "Database schema is not ready. Run `alembic upgrade head` before starting the API."
        ) from exc


def _load_role_permissions() -> None:
    """Load any custom role-permission overrides from the DB into the in-process
    cache so that has_permission() uses them on the very first request."""
    try:
        with SessionLocal() as db:
            load_role_permissions_from_db(db)
    except (OperationalError, ProgrammingError):
        pass  # DB not yet migrated — silently fall back to hard-coded defaults


def _load_user_permissions() -> None:
    """Load per-user permission overrides from the DB into the in-process cache."""
    try:
        with SessionLocal() as db:
            load_user_permissions_from_db(db)
    except (OperationalError, ProgrammingError):
        pass  # DB not yet migrated — silently start with empty user overrides


def _log_release_metadata_on_startup() -> None:
    """Surface release metadata + update-install gate state at api startup.

    Prod has bitten us twice now with empty release metadata silently rendering
    as "nicht gesetzt" in the admin UI, and the "Update installieren" button
    being disabled because neither the runner sidecar nor a repo_root could be
    resolved from inside the api container. By logging both the resolved
    (version, commit, source) tuple AND the install-gate components at
    startup, future diagnosis is one `docker logs api | grep '\\[release\\]'`
    away — no need to shell into the container, hit
    /api/admin/updates/status as an admin, or read the source.

    Imports are local so any failure in the admin module can't break startup.
    The runner reachability check is bounded by a short timeout and never
    raises (it's a best-effort probe).
    """
    try:
        from app.routers.admin import (
            _can_auto_install_updates,
            _current_release_metadata,
            _read_release_env_file,
            _resolve_repo_root,
        )
        from app.services.update_runner_client import is_runner_reachable

        file_version, file_commit = _read_release_env_file()
        version, commit, unresolved = _current_release_metadata()
        runner_ok = is_runner_reachable()
        repo_root = _resolve_repo_root()
        install_supported = _can_auto_install_updates()
    except Exception as exc:  # noqa: BLE001 — diagnostic only, never crash startup
        print(f"[release] failed to resolve release metadata at startup: {exc!r}", flush=True)
        return

    source = "file" if file_version else ("settings" if settings.app_release_version else "unresolved")
    print(
        f"[release] version={version or '<none>'} "
        f"commit={commit or '<none>'} "
        f"source={source} "
        f"settings.app_release_version={settings.app_release_version or '<empty>'} "
        f"file.version={file_version or '<none>'} "
        f"unresolved_placeholder={unresolved} "
        f"runner_reachable={runner_ok} "
        f"repo_root={repo_root if repo_root else '<none>'} "
        f"install_supported={install_supported}",
        flush=True,
    )


@asynccontextmanager
async def lifespan(_: FastAPI):
    _initialize_runtime_data()
    _load_role_permissions()
    _load_user_permissions()
    _log_release_metadata_on_startup()
    image_task = asyncio.create_task(_image_loop())
    try:
        yield
    finally:
        image_task.cancel()
        try:
            await image_task
        except asyncio.CancelledError:
            pass


# v2.5.23 — populate the OpenAPI metadata so the auto-generated /docs
# page is a usable agent-facing reference, not just a list of routes.
# The description renders verbatim at the top of Swagger UI.
_OPENAPI_DESCRIPTION = """
SMPL is the internal workflow-management API for projects, tasks,
construction reports, files, materials, time tracking and chat.

## Authentication

Two channels are supported:

* **Session cookie** — used by the web UI. After `POST /api/auth/login`
  the response sets an httpOnly `access_token` cookie (HS256 JWT,
  8-hour expiry) plus a CSRF cookie that must be echoed in the
  `X-Csrf-Token` header on mutating requests.

* **Personal Access Token (PAT)** — for programmatic / agent use.
  Pass `Authorization: Bearer smpl_pat_…` on every request. PATs do
  **not** require CSRF, but require an administrator to have flipped
  `api_access_enabled = true` on the user; PATs are minted via
  `POST /api/auth/api-tokens`.

## Rate limiting

Per-IP, 1-minute sliding window. Default 480 req/min; the
`/api/dav/`, `/api/time/` and PAT-authenticated scopes get higher
ceilings (2400, 900, and 1200 respectively). 429 responses include
`Retry-After: 60`.

## Response shapes

Endpoints return JSON. Errors are `{"detail": "…"}` with conventional
HTTP status codes (400 validation, 401 unauthenticated, 403 forbidden,
404 not found, 409 conflict, 429 rate-limited).
""".strip()

app = FastAPI(
    title=settings.app_name,
    description=_OPENAPI_DESCRIPTION,
    version=settings.app_release_version or "dev",
    lifespan=lifespan,
    # v2.5.24 — host the auto-generated docs under /api/ so the Caddy
    # reverse-proxy rule that forwards /api/* to this container (without
    # stripping the prefix) actually delivers them. Default FastAPI
    # exposes /docs and /openapi.json at the root, which never reach
    # the container in our deployment and the user gets 404 instead.
    docs_url="/api/docs",
    redoc_url="/api/redoc",
    openapi_url="/api/openapi.json",
)

origins = [origin.strip() for origin in settings.cors_origins.split(",") if origin.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

_rate_bucket: dict[str, deque[datetime]] = defaultdict(deque)


def _rate_scope(path: str, auth_header: str | None) -> tuple[str, int]:
    # v2.5.23 — PAT-authenticated requests get a separate, higher
    # bucket. Agents typically burst (e.g. listing projects, fetching
    # tasks, then mutating) more aggressively than a human clicking
    # through the UI. We key off the Authorization header prefix
    # because the request hasn't run the auth dep yet at this layer.
    if auth_header and auth_header.lower().startswith("bearer smpl_pat_"):
        return ("api_pat", 1200)
    if path.startswith("/api/dav/"):
        return ("dav", 2400)
    if path.startswith("/api/time/"):
        return ("time", 900)
    return ("default", 480)


@app.middleware("http")
async def basic_rate_limit(request: Request, call_next):
    # Simple in-memory per-IP limiter for baseline OWASP hardening.
    # WebDAV clients can burst aggressively, so keep separate, higher buckets.
    if request.method == "OPTIONS":
        return await call_next(request)
    if request.url.path.startswith("/api/events"):
        return await call_next(request)
    ip = request.client.host if request.client else "unknown"
    scope, limit = _rate_scope(request.url.path, request.headers.get("authorization"))
    bucket_key = f"{ip}:{scope}"
    now = utcnow()
    window = timedelta(minutes=1)
    bucket = _rate_bucket[bucket_key]
    while bucket and now - bucket[0] > window:
        bucket.popleft()
    if len(bucket) >= limit:
        return JSONResponse(status_code=429, content={"detail": "Too many requests"}, headers={"Retry-After": "60"})
    bucket.append(now)
    return await call_next(request)


app.include_router(auth.router, prefix="/api")
app.include_router(api_tokens.router, prefix="/api")
app.include_router(admin.router, prefix="/api")
app.include_router(events.router, prefix="/api")
app.include_router(workflow.router, prefix="/api")
app.include_router(workflow_notifications.router, prefix="/api")
app.include_router(time_tracking.router, prefix="/api")


@app.get("/api")
def root():
    return {"service": settings.app_name, "status": "ok"}
