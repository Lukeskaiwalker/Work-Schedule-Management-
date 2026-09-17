"""Admin operations on a paired scan station — everything the Scan-Station
page can *do* to a Pi, as opposed to pairing it (``workflow_station_pairing.py``)
or authenticating and listing it (``workflow_station.py``).

Every route here is ``system:manage`` and every one that touches the Pi goes
through ``services/station_agent_client.py`` — the single, address-checked,
path-allowlisted way the api reaches the agent. The routes answer in three
registers a person at the page can tell apart:

* the agent said no (printer unplugged) → ``200 {ok: false, detail}``, because
  a Brother that is not plugged in is a fact about the bench, not an outage;
* the Pi could not be reached → ``502`` with one German sentence;
* the station has no address yet (agent too old, override not typed) → ``409``
  with the sentence that says what to do.

Nothing on the page can produce "Schnittstelle noch nicht verfügbar" any more.
"""

from __future__ import annotations

import re
import time
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException
from pydantic import ValidationError
from sqlalchemy.orm import Session

from app.core.config import Settings, get_settings
from app.core.db import get_db
from app.core.deps import require_permission
from app.core.time import utcnow
from app.models.entities import Station, User
from app.schemas.station import (
    StationActionOut,
    StationHeartbeatRequest,
    StationImportOut,
    StationImportRequest,
    StationOut,
    StationPatchRequest,
    StationRestartRequest,
    StationSessionListOut,
    StationSetupOut,
    StationTestPrintRequest,
)
from app.services.audit import log_admin_action
from app.services.station_agent_client import (
    NOT_JSON_DETAIL,
    StationAgentError,
    StationAgentRemoteError,
    agent_get,
    agent_post,
    restart_proof,
    validate_agent_url,
)
from app.services.station_heartbeat import apply_heartbeat
from app.services.station_sessions import (
    STATION_INACTIVE_DETAIL,
    import_station_session,
    list_station_sessions,
)
from app.services.station_view import is_station_active, station_out

router = APIRouter(prefix="/station", tags=["station-admin"])

_MANAGE = require_permission("system:manage")

TEST_LABEL_CODE = "SMPL-TEST"
TEST_LABEL_TITLE = "SMPL Testetikett"
# The agent's /print contract (tools/label_agent/server.py ``print_label``):
# it queues and answers in milliseconds, so ``queued`` is the normal reply of
# a connected printer, ``simulated`` (also queued) the reply of ``--no-printer``,
# and an unplugged printer is a 503 with the printer's own sentence, refused
# *before* anything is queued. Only an agent that prints synchronously
# answers neither flag — that is the one case a duration is worth showing.
TEST_PRINT_SIMULATED_DETAIL = "Testetikett simuliert — der Agent läuft ohne Drucker."
TEST_PRINT_QUEUED_DETAIL = "Testetikett eingereiht — der Drucker gibt es in wenigen Sekunden aus."
RESTART_DETAIL = "Neustart ausgelöst — der Agent meldet sich in wenigen Sekunden zurück."
CONFIRM_DETAIL = "Neustart nur mit confirm=true."
NAME_EMPTY_DETAIL = "Name darf nicht leer sein."
NO_CHANGE_DETAIL = "Keine Änderung angegeben."
# Same wording as the pairing router, so a 404 reads the same everywhere.
NOT_FOUND_DETAIL = "Station not found"

_RELEASE_TAG_RE = re.compile(r"^v?\d+(\.\d+)+$")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _station_or_404(db: Session, station_id: int) -> Station:
    station = db.get(Station, station_id)
    if station is None:
        raise HTTPException(status_code=404, detail=NOT_FOUND_DETAIL)
    return station


def _active_or_409(station: Station) -> Station:
    if not is_station_active(station):
        raise HTTPException(status_code=409, detail=STATION_INACTIVE_DETAIL)
    return station


def _http(exc: StationAgentError) -> HTTPException:
    return HTTPException(status_code=exc.http_status, detail=str(exc))


def _elapsed_ms(started: float) -> int:
    return int((time.perf_counter() - started) * 1000)


def _seconds_de(ms: int) -> str:
    """``2,1`` — a German decimal for the feedback sentence."""
    return f"{ms / 1000:.1f}".replace(".", ",")


def _local_stamp(now: datetime, settings: Settings) -> str:
    """``17.09. 14:05`` in the office's timezone, for the label's subtitle."""
    try:
        zone = ZoneInfo(settings.app_timezone or "UTC")
    except Exception:  # noqa: BLE001 — a mistyped zone must not block a test print
        zone = ZoneInfo("UTC")
    from datetime import timezone as _tz

    local = now.replace(tzinfo=_tz.utc).astimezone(zone)
    return local.strftime("%d.%m. %H:%M")


def _record_agent_error(db: Session, station: Station, message: str) -> None:
    """Keep the api's own reason for failing on the row, so the list poll
    shows it until the next heartbeat or successful refresh clears it."""
    blob = dict(station.hardware_status or {})
    blob["agent_error"] = message[:500]
    station.hardware_status = blob
    db.add(station)
    db.commit()


def _clip(value: Any, limit: int) -> str | None:
    if isinstance(value, str) and value.strip():
        return value.strip()[:limit]
    return None


def _number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)) and value >= 0:
        return float(value)
    return None


def heartbeat_from_health(health: dict[str, Any]) -> StationHeartbeatRequest:
    """The agent's ``/health`` has the heartbeat's shape, minus the address —
    the api already knows where it just called, and must not let a reply
    move it. Goes through the same model so a synchronous check and a
    heartbeat can never populate the row differently."""
    hardware = health.get("hardware") if isinstance(health.get("hardware"), dict) else None
    uptime = _number(health.get("uptime_seconds"))
    sessions = _number(health.get("session_count"))
    width = _number(health.get("media_width_mm"))
    data: dict[str, Any] = {
        "agent_version": _clip(health.get("version"), 64),
        "printer_connected": health.get("printer_connected")
        if isinstance(health.get("printer_connected"), bool)
        else None,
        "media_width_mm": width if width is not None and width <= 1000 else None,
        "error": _clip(health.get("error"), 500),
        "uptime_seconds": int(uptime) if uptime is not None else None,
        "session_count": int(sessions) if sessions is not None and sessions <= 100_000 else None,
        "hardware": hardware,
        "status": {"simulated": bool(health.get("simulated")), "checked_by": "refresh"},
    }
    try:
        return StationHeartbeatRequest.model_validate({k: v for k, v in data.items() if v is not None})
    except ValidationError as exc:
        raise StationAgentRemoteError(200, NOT_JSON_DETAIL) from exc


def setup_script(settings: Settings) -> str:
    """The documented install path, with this deployment's URL baked in."""
    base_url = (settings.app_public_url or "").rstrip("/")
    repo = f"https://github.com/{settings.update_repo_owner}/{settings.update_repo_name}.git"
    tag = (settings.app_release_version or "").strip()
    branch = f" --branch {tag}" if _RELEASE_TAG_RE.match(tag) else ""
    return "\n".join(
        [
            "# 1) Code holen — einmalig. Später zum Aktualisieren: cd ~/smpl && git pull",
            f"git clone --depth 1{branch} {repo} ~/smpl",
            "",
            "# 2) Installer — Dienst, udev-Regeln und venv; idempotent, nach jedem Update erneut ausführen",
            "#    (mit --with-kiosk zusätzlich die beiden Werkstatt-Bildschirme)",
            f"sudo ~/smpl/tools/label_agent/packaging/install-pi.sh --smpl-url {base_url}",
            "",
            "# 3) Koppeln — zeigt einen Code; hier unter „Neue Station koppeln“ freigeben",
            "sudo -u smpl-station AGENT_STATE_DIR=/var/lib/smpl-station \\",
            "  /opt/smpl-station/tools/label_agent/.venv/bin/python \\",
            "  /opt/smpl-station/tools/label_agent/server.py --pair",
            "",
            "# Danach meldet der Agent alle 2 Minuten Adresse und Hardware an SMPL;",
            "# erst dann funktionieren Testetikett, Hardware prüfen und Neustart.",
        ]
    )


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.get("/setup", response_model=StationSetupOut)
def station_setup(_: User = Depends(_MANAGE)):
    settings = get_settings()
    return StationSetupOut(
        script=setup_script(settings), base_url=(settings.app_public_url or "").rstrip("/")
    )


@router.patch("/stations/{station_id}", response_model=StationOut)
def update_station(
    station_id: int,
    payload: StationPatchRequest,
    current_user: User = Depends(_MANAGE),
    db: Session = Depends(get_db),
):
    """Name, location and the agent-address override. Allowed on a retired
    station too — renaming the row in the audit list is harmless."""
    station = _station_or_404(db, station_id)
    fields = payload.model_fields_set
    changes: dict[str, Any] = {}

    if "name" in fields:
        name = (payload.name or "").strip()
        if not name:
            raise HTTPException(status_code=400, detail=NAME_EMPTY_DETAIL)
        station.name = name[:128]
        changes["name"] = station.name
    if "location" in fields:
        station.location = (payload.location or "").strip()[:128] or None
        changes["location"] = station.location
    if "agent_url" in fields:
        raw = (payload.agent_url or "").strip()
        if raw:
            try:
                station.agent_url_override = validate_agent_url(raw)
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
        else:
            station.agent_url_override = None
        changes["agent_url"] = station.agent_url_override
    if not changes:
        raise HTTPException(status_code=400, detail=NO_CHANGE_DETAIL)

    db.add(station)
    db.commit()
    db.refresh(station)
    log_admin_action(
        db, current_user, "station.update", "station", str(station.id),
        details=changes, category="system",
    )
    return station_out(db, station)


@router.post("/stations/{station_id}/refresh", response_model=StationOut)
def refresh_station(
    station_id: int,
    _: User = Depends(_MANAGE),
    db: Session = Depends(get_db),
):
    """Synchronous ``/health`` from the Pi, folded in exactly like a heartbeat.

    The heartbeat is two minutes apart, so a Pi that just died reads Online
    for up to three; this is the truthful check, and it stamps ``last_seen_at``
    because the Pi did, in fact, just answer.
    """
    station = _active_or_409(_station_or_404(db, station_id))
    now = utcnow()
    try:
        health = agent_get(station, "/health")
        beat = heartbeat_from_health(health)
    except StationAgentError as exc:
        _record_agent_error(db, station, str(exc))
        raise _http(exc) from exc
    apply_heartbeat(station, beat, now)
    db.add(station)
    db.commit()
    db.refresh(station)
    return station_out(db, station, now=now)


@router.post("/stations/{station_id}/test-print", response_model=StationActionOut)
def test_print(
    station_id: int,
    payload: StationTestPrintRequest,
    current_user: User = Depends(_MANAGE),
    db: Session = Depends(get_db),
):
    """One label on the Pi's own Brother PT-P710BT — the printer this page is
    about. The WAGO strip printer is exercised from Schaltplan/Werkstatt."""
    station = _active_or_409(_station_or_404(db, station_id))
    settings = get_settings()
    title = (payload.text or "").strip()[:120] or TEST_LABEL_TITLE
    body = {
        "code": TEST_LABEL_CODE,
        "title": title,
        "subtitle": f"{station.name} · {_local_stamp(utcnow(), settings)}"[:256],
    }
    started = time.perf_counter()
    try:
        result = agent_post(station, "/print", body)
    except StationAgentRemoteError as exc:
        # The agent answered and could not: "printer not found on USB …".
        # A statement about the bench, not an outage — 200, ok=false.
        outcome = StationActionOut(ok=False, detail=str(exc), ms=_elapsed_ms(started))
        _audit_test_print(db, current_user, station, outcome)
        return outcome
    except StationAgentError as exc:
        raise _http(exc) from exc

    agent_ms = _number(result.get("ms_total"))
    ms = int(agent_ms) if agent_ms is not None else _elapsed_ms(started)
    # ``simulated`` before ``queued``: a --no-printer agent sets both, and
    # reading ``queued`` first would report a printer that does not exist.
    if result.get("simulated"):
        detail = TEST_PRINT_SIMULATED_DETAIL
    elif result.get("queued"):
        detail = TEST_PRINT_QUEUED_DETAIL
    else:
        detail = f"Testetikett gedruckt ({_seconds_de(ms)} s)."
    outcome = StationActionOut(ok=True, detail=detail, ms=ms)
    _audit_test_print(db, current_user, station, outcome)
    return outcome


def _audit_test_print(
    db: Session, actor: User, station: Station, outcome: StationActionOut
) -> None:
    log_admin_action(
        db, actor, "station.test_print", "station", str(station.id),
        details={"name": station.name, "ok": outcome.ok, "detail": outcome.detail},
        category="system",
    )


@router.post("/stations/{station_id}/restart", response_model=StationActionOut)
def restart_station(
    station_id: int,
    payload: StationRestartRequest,
    current_user: User = Depends(_MANAGE),
    db: Session = Depends(get_db),
):
    """Ask the agent to exit; systemd's ``Restart=always`` brings it back.

    The proof header is what lets the Pi tell this call apart from anybody
    else on the LAN — the route is reachable there, and a restart mid-print
    is not something a stray curl should be able to trigger.
    """
    if not payload.confirm:
        raise HTTPException(status_code=400, detail=CONFIRM_DETAIL)
    station = _active_or_409(_station_or_404(db, station_id))
    started = time.perf_counter()
    try:
        agent_post(station, "/restart", {"confirm": True}, headers=restart_proof(station))
    except StationAgentError as exc:
        raise _http(exc) from exc
    log_admin_action(
        db, current_user, "station.restart", "station", str(station.id),
        details={"name": station.name}, category="system",
    )
    return StationActionOut(ok=True, detail=RESTART_DETAIL, ms=_elapsed_ms(started))


@router.get("/stations/{station_id}/sessions", response_model=StationSessionListOut)
def station_sessions(
    station_id: int,
    _: User = Depends(_MANAGE),
    db: Session = Depends(get_db),
):
    """Never a 5xx: a Pi that is off is a statement the card renders."""
    station = _station_or_404(db, station_id)
    return list_station_sessions(db, station)


@router.post(
    "/stations/{station_id}/sessions/{session_name}/import",
    response_model=StationImportOut,
)
def import_session(
    station_id: int,
    session_name: str,
    payload: StationImportRequest,
    current_user: User = Depends(_MANAGE),
    db: Session = Depends(get_db),
):
    station = _active_or_409(_station_or_404(db, station_id))
    result = import_station_session(
        db,
        station,
        session_name,
        target_session_id=payload.target_session_id,
        create_session_name=payload.create_session_name,
        user=current_user,
    )
    log_admin_action(
        db, current_user, "station.import_session", "station", str(station.id),
        details={
            "session_name": session_name,
            "inventory_session_id": result.session_id,
            "imported": result.imported,
            "updated": result.updated,
            "skipped": result.skipped,
            "unmatched": len(result.unmatched),
        },
        category="system",
    )
    return result
