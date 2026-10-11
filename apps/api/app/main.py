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
from app.core.security import MFA_CHALLENGE_PURPOSE, decode_token, get_password_hash, verify_password
from app.core.time import utcnow
from app.models.entities import User
from app.routers import workflow_station
from app.routers import workflow_station_admin
from app.routers import workflow_station_pairing
from app.routers import workflow_station_werkstatt
from app.routers import workflow_station_consumption
from app.routers import workflow_werkstatt_inventory
from app.routers import workflow_werkstatt_on_site
from app.routers import admin, api_tokens, auth, calendar_feed, events, portal, portal_documents, portal_hours, station_badge, time_tracking, workflow, workflow_notifications, workflow_schaltplan, workflow_schaltplan_material, workflow_task_packing_list, workflow_training_reports
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

* **Station token** — for the unattended scan station (Raspberry Pi with
  barcode scanner and label printer). Pass
  `Authorization: Bearer smpl_station_…`. A station token is not minted
  by a user at all: the device requests a pairing code
  (`POST /api/station/pair/start`), an administrator with `system:manage`
  approves it (`POST /api/station/pair/approve`), and the device collects
  the token exactly once by polling (`POST /api/station/pair/poll`) —
  the OAuth 2.0 device authorization grant. A station authenticates as a
  device, not as a user, and reaches only the `/api/station/*` endpoints.

## Rate limiting

1-minute sliding window, counted per signed-in user for requests that
carry a valid session (cookie or Bearer JWT) and per client address
otherwise. Default 480 req/min; the `/api/dav/`, `/api/time/` and
PAT-authenticated scopes get higher ceilings (2400, 900, and 1200
respectively). PAT requests, `/api/auth/login` (60) and the station
pairing endpoints are always counted per address. 429 responses include
`Retry-After: 60`.

## Response shapes

Endpoints return JSON. Errors are `{"detail": "…"}` with conventional
HTTP status codes (400 validation, 401 unauthenticated, 403 forbidden,
404 not found, 409 conflict, 429 rate-limited).
""".strip()

# Only expose the interactive docs / OpenAPI schema in dev-like environments.
# In production the full schema is an unnecessary reconnaissance aid — every
# endpoint is individually authenticated regardless, so this is defense in depth.
_docs_enabled = settings.environment.strip().lower() in {
    "dev",
    "development",
    "test",
    "testing",
    "ci",
    "local",
}

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
    docs_url="/api/docs" if _docs_enabled else None,
    redoc_url="/api/redoc" if _docs_enabled else None,
    openapi_url="/api/openapi.json" if _docs_enabled else None,
)

# Origin of the native iOS shell (apps/mobile). Capacitor serves the bundled
# SPA from this fixed scheme+host on every device and every install, so it is a
# constant of the platform rather than a per-deployment choice.
NATIVE_SHELL_ORIGIN = "capacitor://localhost"

origins = [origin.strip() for origin in settings.cors_origins.split(",") if origin.strip()]

# Unioned in unconditionally, NOT merely defaulted. Three layers can supply
# CORS_ORIGINS — the field default here, apps/api/.env.example, and the
# gitignored per-deployment apps/api/.env — and the last one wins. v2.9.0
# shipped the shell origin as a field default and production still rejected
# every request from the app, because .env.example carried a real value that
# shadowed it; a deployment whose apps/api/.env pins the key would shadow that
# fix in turn. Appending here is the only layer no configuration can outrank.
if NATIVE_SHELL_ORIGIN not in origins:
    origins.append(NATIVE_SHELL_ORIGIN)
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    # Cross-origin callers (the native iOS shell, whose origin is
    # capacitor://localhost) can only read the seven CORS-safelisted response
    # headers unless the server names the rest here. Both of these are load
    # bearing on the client:
    #
    #   X-Access-Token      — login and the MFA step read the session JWT out
    #                         of this header. Without it the client sees null
    #                         and reports "No access token returned", i.e. a
    #                         login that cannot succeed even though the server
    #                         authenticated the user perfectly.
    #   Content-Disposition — the admin backup download parses the filename
    #                         from it.
    #
    # Same-origin browsers are unaffected: they can already read every header.
    #   X-Mfa-Challenge     — links the two halves of an MFA login for clients
    #                         whose origin makes the SameSite=Strict challenge
    #                         cookie unusable. See routers/auth.py.
    expose_headers=["X-Access-Token", "X-Mfa-Challenge", "Content-Disposition"],
)

_rate_bucket: dict[str, deque[datetime]] = defaultdict(deque)


def _rate_limit_client_ip(request: Request) -> str:
    """Best-effort real client IP for rate-limit bucketing.

    Behind the reverse proxy the direct peer is the proxy, so
    ``request.client.host`` would collapse every user into a single global
    bucket. Prefer the proxy-set ``X-Real-Ip`` (the client the edge actually
    connected to), then the left-most ``X-Forwarded-For`` hop, then the direct
    peer. This assumes the edge overwrites both headers. Caddy, the edge since
    2026-08, replaces ``X-Forwarded-For`` with the peer it saw (no
    ``trusted_proxies`` is configured) but passes a client's ``X-Real-Ip``
    through untouched unless told otherwise — which is why apps/web/Caddyfile
    sets it explicitly. What that address is matters less than it looks: the
    office arrives through hairpin NAT as the router, so it is one address for
    everyone, which is why signed-in requests are counted per user instead (see
    ``_rate_limit_key``). The non-spoofable per-account login lockout — not
    this limiter — is the real brute-force control, so header spoofing here
    can't unlock an account.
    """
    real_ip = (request.headers.get("x-real-ip") or "").strip()
    if real_ip:
        return real_ip
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        first = forwarded.split(",", 1)[0].strip()
        if first:
            return first
    return request.client.host if request.client else "unknown"


def _rate_scope(path: str, auth_header: str | None) -> tuple[str, int]:
    # v2.5.23 — PAT-authenticated requests get a separate, higher
    # bucket. Agents typically burst (e.g. listing projects, fetching
    # tasks, then mutating) more aggressively than a human clicking
    # through the UI. We key off the Authorization header prefix
    # because the request hasn't run the auth dep yet at this layer.
    if auth_header and auth_header.lower().startswith("bearer smpl_pat_"):
        return ("api_pat", 1200)
    # The two unauthenticated station-pairing endpoints. Neither is used by
    # a human, so the ceilings can sit far below the default without any risk
    # of a real user tripping them: a Pi starts a pairing once, then polls at
    # the 5-second interval the server hands it (12/min). Both endpoints are
    # additionally throttled per-pairing inside the router.
    if path == "/api/station/pair/start":
        return ("station_pair_start", 20)
    if path == "/api/station/pair/poll":
        return ("station_pair_poll", 120)
    if path == "/api/auth/login":
        # Tight, source-scoped ceiling on the login endpoint as a credential-
        # stuffing backstop (many accounts, few tries each — which the per-
        # account lockout alone can't see). Kept well above real human use so a
        # NAT'd office never trips it; a bot doing hundreds/min from one source
        # does.
        return ("login", 60)
    if path.startswith("/api/dav/"):
        return ("dav", 2400)
    if path.startswith("/api/time/"):
        return ("time", 900)
    return ("default", 480)


# Scopes that stay per address whoever is signed in. The login ceiling is the
# credential-stuffing backstop (many accounts, few tries each, one source) and
# the pairing endpoints are called by devices that have no session; a session
# from somewhere else must not buy either a bucket of its own. PATs keep the
# per-address bucket they always had: they are recognised by prefix alone,
# because telling a real one from a made-up one takes a database lookup.
_PER_ADDRESS_SCOPES = frozenset({"login", "station_pair_start", "station_pair_poll", "api_pat"})


def _rate_limit_session_user(request: Request) -> str | None:
    """The user id of a verified session token on the request, else None.

    Takes the credential get_current_user would — the Bearer header, else the
    ``access_token`` cookie — and verifies it with the app's own helper (HS256
    pinned), so only a token this server signed counts. Garbage, a foreign key,
    alg ``none``, an expired token or the MFA half-login token all give None, and
    the request is counted against its address: an invented token cannot mint a
    fresh bucket. Whether the user still exists or is active is the route's
    business; the limiter only needs to know whose request this is.
    """
    authorization = request.headers.get("authorization") or ""
    bearer = authorization.split(" ", 1)[1].strip() if authorization.lower().startswith("bearer ") else ""
    token = bearer or request.cookies.get("access_token") or ""
    if not token:
        return None
    payload = decode_token(token)
    if not payload or payload.get("purpose") == MFA_CHALLENGE_PURPOSE:
        return None
    subject = str(payload.get("sub") or "").strip()
    return subject or None


def _rate_limit_key(request: Request, scope: str) -> str:
    """Whose allowance a request spends: its user's, or else its address's.

    Per address alone made the office one client. It reaches Caddy through
    hairpin NAT, so every desk arrives as the router, and one shared allowance
    was spent by everybody's open tabs together — measured 2026-10-11, a visible
    Zeiterfassung tab alone asks /api/time/* about 120 times a minute. A
    signed-in person now has buckets of their own, shared by all of their tabs
    and sessions (same user id) and by nobody else. The ceilings did not need
    to move for that: 900/min on /api/time/* is seven such tabs on screen at
    once for one person, and a hidden tab no longer polls them at all.
    """
    if scope not in _PER_ADDRESS_SCOPES:
        user_id = _rate_limit_session_user(request)
        if user_id is not None:
            # "user:" cannot collide with an address, IPv6 colons and all.
            return f"user:{user_id}:{scope}"
    return f"{_rate_limit_client_ip(request)}:{scope}"


@app.middleware("http")
async def basic_rate_limit(request: Request, call_next):
    # Simple in-memory limiter for baseline OWASP hardening: per user for
    # signed-in requests, per address otherwise (see _rate_limit_key). WebDAV
    # clients can burst aggressively, so keep separate, higher buckets.
    # In-memory means per worker process: with API_WORKERS=2 a client's requests
    # are spread over two buckets, so the ceiling it meets is up to twice these.
    if request.method == "OPTIONS":
        return await call_next(request)
    if request.url.path.startswith("/api/events"):
        return await call_next(request)
    scope, limit = _rate_scope(request.url.path, request.headers.get("authorization"))
    bucket_key = _rate_limit_key(request, scope)
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
app.include_router(workflow_training_reports.router, prefix="/api")
app.include_router(workflow_werkstatt_inventory.router, prefix="/api")
# `/werkstatt/on-site` is a literal path that collides with nothing in the
# persona routers, so it mounts here beside inventory rather than inside the
# desktop composite. See routers/workflow_werkstatt_on_site.py.
app.include_router(workflow_werkstatt_on_site.router, prefix="/api")
app.include_router(workflow_station.router, prefix="/api")
app.include_router(workflow_station_pairing.router, prefix="/api")
app.include_router(workflow_station_admin.router, prefix="/api")
app.include_router(workflow_station_werkstatt.router, prefix="/api")
app.include_router(workflow_station_consumption.router, prefix="/api")
# The material router first: its static "/panels/recent" must be matched
# before the plan router's "/panels/{plan_id}" swallows the word.
app.include_router(workflow_schaltplan_material.router, prefix="/api")
app.include_router(workflow_schaltplan.router, prefix="/api")
app.include_router(calendar_feed.router, prefix="/api")
app.include_router(station_badge.router, prefix="/api")
app.include_router(workflow_task_packing_list.router, prefix="/api")
# The partner portal: the only routes a partner login (role "external") may
# call. Everything under /api/portal/ — see the fence in app.core.deps.
app.include_router(portal.router, prefix="/api")
app.include_router(portal_documents.router, prefix="/api")
app.include_router(portal_hours.router, prefix="/api")


@app.get("/api")
def root():
    return {"service": settings.app_name, "status": "ok"}
