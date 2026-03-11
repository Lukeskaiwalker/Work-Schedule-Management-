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
from app.routers import admin, auth, events, time_tracking, workflow, workflow_notifications
from app.services.material_catalog import sync_pending_material_catalog_images
from app.services.runtime_settings import (
    is_initial_admin_bootstrap_completed,
    load_role_permissions_from_db,
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


@asynccontextmanager
async def lifespan(_: FastAPI):
    _initialize_runtime_data()
    _load_role_permissions()
    image_task = asyncio.create_task(_image_loop())
    try:
        yield
    finally:
        image_task.cancel()
        try:
            await image_task
        except asyncio.CancelledError:
            pass


app = FastAPI(title=settings.app_name, lifespan=lifespan)

origins = [origin.strip() for origin in settings.cors_origins.split(",") if origin.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

_rate_bucket: dict[str, deque[datetime]] = defaultdict(deque)


def _rate_scope(path: str) -> tuple[str, int]:
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
    scope, limit = _rate_scope(request.url.path)
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
app.include_router(admin.router, prefix="/api")
app.include_router(events.router, prefix="/api")
app.include_router(workflow.router, prefix="/api")
app.include_router(workflow_notifications.router, prefix="/api")
app.include_router(time_tracking.router, prefix="/api")


@app.get("/api")
def root():
    return {"service": settings.app_name, "status": "ok"}
