"""The one calibration session: a DB lock with a TTL.

Calibrating feeds paper and rewrites printer settings; a machine label printed
in the middle would come out on half-sensed stock, and two people calibrating
at once would judge each other's measurements. So one session holds the
printer: every print path (``_ship``) refuses while someone else's session is
live, and only its holder may run the steps.

The lock is a runtime setting (``werkstatt_label_printer_lock``), ``{}`` when
free, read and written under ``SELECT … FOR UPDATE`` (skipped on SQLite like
``werkstatt_movements``). A session expires ``SESSION_TTL_S`` after its last
call, so a closed browser tab frees the printer by itself. No row lock is
ever held across printer I/O: each step is (1) require + mark + commit,
(2) I/O, (3) require again + write + commit — see the calibration service.
"""

from __future__ import annotations

import json
import uuid
from dataclasses import asdict, dataclass, field, replace
from datetime import datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.permissions import has_permission_for_user
from app.models.entities import AppSetting, User
from app.services.runtime_settings import (
    WERKSTATT_LABEL_PRINTER_LOCK_KEY,
    get_runtime_setting,
    get_runtime_setting_for_update,
    set_runtime_setting,
)
from app.services.werkstatt_label_errors import LabelPrinterNotConfigured, LabelRequestRefused

SESSION_TTL_S = 600
POLL_CODES_CAP = 60  # the first 60 are kept — data for T2
WRITES_CAP = 20  # the last 20 are kept
PROFILE_AT_START_FIELDS = ("x_offset_mm", "across_offset_mm", "darkness", "speed_ips", "stop_mm")

SESSION_LOST_MESSAGE = "Die Einrichtung ist abgelaufen oder wurde übernommen – bitte neu starten"


def now_utc() -> datetime:
    """Aware UTC now — the one clock of the calibration (tests replace it)."""
    return datetime.now(timezone.utc)


def iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def parse_iso(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=timezone.utc)


def local_hhmm(value: datetime) -> str:
    """HH:MM in ``settings.app_timezone`` — every server-built time text."""
    return value.astimezone(ZoneInfo(get_settings().app_timezone)).strftime("%H:%M")


@dataclass(frozen=True)
class CalibrationSession:
    session_id: str
    mode: str  # "quick" | "full"
    material_id: str
    user_id: int
    user_name: str
    acquired_at: datetime  # aware UTC, whole seconds
    expires_at: datetime
    phase: str = "open"
    profile_at_start: dict[str, Any] = field(default_factory=dict)
    apply: dict[str, Any] | None = None
    sense_pending: bool = False
    pattern_pending: bool = False
    sense: dict[str, Any] | None = None
    verify: dict[str, Any] | None = None

    @property
    def applied(self) -> bool:
        return self.apply is not None and self.apply.get("material_id") == self.material_id

    @property
    def sensed(self) -> bool:
        return self.sense is not None

    def expired(self, now: datetime) -> bool:
        return self.expires_at <= now

    def to_blob(self) -> dict[str, Any]:
        blob = asdict(self)
        blob["acquired_at"] = iso(self.acquired_at)
        blob["expires_at"] = iso(self.expires_at)
        return blob

    @classmethod
    def from_blob(cls, raw: Any) -> CalibrationSession | None:
        """Defensive: anything malformed reads as "no session"."""
        if not isinstance(raw, dict) or not raw.get("session_id"):
            return None
        acquired, expires = parse_iso(raw.get("acquired_at")), parse_iso(raw.get("expires_at"))
        if acquired is None or expires is None:
            return None
        try:
            return cls(
                session_id=str(raw["session_id"]),
                mode=str(raw.get("mode") or "quick"),
                material_id=str(raw.get("material_id") or ""),
                user_id=int(raw.get("user_id")),
                user_name=str(raw.get("user_name") or ""),
                acquired_at=acquired,
                expires_at=expires,
                phase=str(raw.get("phase") or "open"),
                profile_at_start=dict(raw.get("profile_at_start") or {}),
                apply=raw.get("apply") if isinstance(raw.get("apply"), dict) else None,
                sense_pending=bool(raw.get("sense_pending")),
                pattern_pending=bool(raw.get("pattern_pending")),
                sense=raw.get("sense") if isinstance(raw.get("sense"), dict) else None,
                verify=raw.get("verify") if isinstance(raw.get("verify"), dict) else None,
            )
        except (TypeError, ValueError):
            return None


def busy_message(session: CalibrationSession) -> str:
    return (
        f"Etikettendrucker wird gerade eingerichtet ({session.user_name}, seit {local_hhmm(session.acquired_at)}) – "
        "bitte warten, bis die Einrichtung abgeschlossen ist"
    )


def cap_lists(sense: dict[str, Any]) -> dict[str, Any]:
    """Bound the lists of a ``sense`` blob (the column must never overflow)."""
    capped = dict(sense)
    capped["poll_codes"] = list(sense.get("poll_codes") or [])[:POLL_CODES_CAP]
    capped["writes_since_sense"] = list(sense.get("writes_since_sense") or [])[-WRITES_CAP:]
    return capped


def profile_snapshot(profile: Any) -> dict[str, Any]:
    """The stored values a calibration record's ``changes`` compare against."""
    return {"material_id": profile.id, **{name: getattr(profile, name) for name in PROFILE_AT_START_FIELDS}}


def has_settings(user: User) -> bool:
    return has_permission_for_user(user.id, user.role, "settings:manage")


def _read(raw: str | None) -> CalibrationSession | None:
    if not raw:
        return None
    try:
        parsed = json.loads(raw)
    except Exception:
        return None
    return CalibrationSession.from_blob(parsed)


def _locked_row(db: Session) -> AppSetting:
    row = get_runtime_setting_for_update(db, WERKSTATT_LABEL_PRINTER_LOCK_KEY)
    if row is None:
        # First use: create the free lock. A concurrent first use inserts the
        # same key — the loser's savepoint rolls back and it reads the winner's.
        try:
            with db.begin_nested():
                db.add(AppSetting(key=WERKSTATT_LABEL_PRINTER_LOCK_KEY, value="{}"))
        except IntegrityError:
            pass
        row = get_runtime_setting_for_update(db, WERKSTATT_LABEL_PRINTER_LOCK_KEY)
    return row


def write(db: Session, session: CalibrationSession | None) -> None:
    """Store the session (``None`` frees the lock); the caller commits."""
    value = "{}" if session is None else json.dumps(session.to_blob(), ensure_ascii=False)
    set_runtime_setting(db, WERKSTATT_LABEL_PRINTER_LOCK_KEY, value)


def active_session(db: Session) -> CalibrationSession | None:
    """Plain read, no lock; an expired session counts as none."""
    session = _read(get_runtime_setting(db, WERKSTATT_LABEL_PRINTER_LOCK_KEY))
    if session is None or session.expired(now_utc()):
        return None
    return session


def locked_session(db: Session) -> CalibrationSession | None:
    """The stored session (expired or not) under the row lock."""
    return _read(_locked_row(db).value)


def acquire(db: Session, *, user: User, mode: str, material_id: str, takeover: bool) -> tuple[CalibrationSession, CalibrationSession | None]:
    """Start a session; returns (new session, the one it replaced if live)."""
    from app.services.werkstatt_label_materials import get_label_printer_config, require_material
    from app.services.werkstatt_labels import printer_address

    if printer_address(db) is None:
        raise LabelPrinterNotConfigured()
    config = get_label_printer_config(db)
    admin = has_settings(user)
    if not admin and not config["label_calibration_staff_enabled"]:
        raise LabelRequestRefused(
            403, "staff_flow_disabled", "Der Schnellablauf ist noch nicht freigegeben – bitte an die Verwaltung wenden"
        )
    if mode == "full" and not admin:
        raise LabelRequestRefused(403, "permission_denied", "Die vollständige Einrichtung ist der Verwaltung vorbehalten")
    profile = require_material(config["materials"], material_id)

    now = now_utc()
    current = locked_session(db)
    replaced: CalibrationSession | None = None
    if current is not None and not current.expired(now):
        if current.user_id != user.id and not (takeover and admin):
            raise LabelRequestRefused(
                409,
                "session_locked",
                f"Der Etikettendrucker wird gerade von {current.user_name} eingerichtet (seit {local_hhmm(current.acquired_at)})",
                holder_name=current.user_name,
                since=iso(current.acquired_at),
                mode=current.mode,
            )
        replaced = current
    acquired = now.replace(microsecond=0)
    session = CalibrationSession(
        session_id=uuid.uuid4().hex,
        mode=mode,
        material_id=profile.id,
        user_id=user.id,
        user_name=user.full_name or user.email,
        acquired_at=acquired,
        expires_at=acquired + timedelta(seconds=SESSION_TTL_S),
        profile_at_start=profile_snapshot(profile),
    )
    write(db, session)
    return session, replaced


def require(db: Session, session_id: str, user: User) -> CalibrationSession:
    """The caller's live session under the row lock, its TTL renewed."""
    current = locked_session(db)
    now = now_utc()
    if current is None or current.session_id != session_id or current.expired(now) or current.user_id != user.id:
        raise LabelRequestRefused(409, "session_lost", SESSION_LOST_MESSAGE)
    renewed = replace(current, expires_at=now.replace(microsecond=0) + timedelta(seconds=SESSION_TTL_S))
    write(db, renewed)
    return renewed


def release(db: Session, session_id: str, user: User) -> bool:
    """Idempotent: frees the lock only when it is this user's session ``session_id``."""
    current = locked_session(db)
    if current is None or current.session_id != session_id or current.user_id != user.id:
        return False
    write(db, None)
    return True
