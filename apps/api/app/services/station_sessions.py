"""The Pi's count sessions, seen from the api.

The office scan station counts into its own SQLite, one *session* per named
stock-take ("default" for anything counted without one). Those sessions live
on the Pi until somebody pulls them into a Werkstatt inventory here. Two
operations:

* **list** — ask the agent for its sessions and stamp each with what only
  SMPL knows: whether it was imported already, when, and into which inventory
  (``werkstatt_inventory_sessions.source_*``). The Pi being off is answered
  as a statement (``ok=False`` + the sentence), not as a 5xx — the card has
  a reload button for exactly that;
* **import** — fetch one session's counts and fold them into an inventory
  through ``import_counts``, the same code path the desktop's JSON upload
  uses. Quantities are SET, so a re-import is idempotent and lands in the
  same open inventory it landed in before; a finalized inventory is never
  written, a fresh one is opened instead.
"""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.time import utcnow
from app.models.entities import Station, User, WerkstattInventorySession
from app.schemas.station import StationImportOut, StationSessionListOut, StationSessionOut
from app.services.station_agent_client import (
    TOO_LARGE_DETAIL,
    StationAgentError,
    StationAgentRemoteError,
    agent_get,
    session_path,
)
from app.services.station_view import is_station_active
from app.services.werkstatt_inventory import ImportRow, import_counts

STATION_INACTIVE_DETAIL = "Station ist entkoppelt."
SESSION_FINALIZED_DETAIL = "Diese Inventur ist abgeschlossen."
INVENTORY_NOT_FOUND_DETAIL = "Inventur nicht gefunden"
NOT_A_SESSION_LIST_DETAIL = "Die Station hat keine Sitzungsliste geliefert."
EMPTY_SESSION_DETAIL = "Diese Sitzung enthält keine Zählungen."

# A Pi session is a shelf's worth of codes. Anything beyond this is not a
# stock-take, it is a blob — refused before it becomes an insert storm, and
# refused out loud: dropping rows in silence would leave an inventory the
# admin believes complete.
MAX_IMPORT_ROWS = 5000
TOO_MANY_ROWS_DETAIL = (
    f"Diese Sitzung hat mehr als {MAX_IMPORT_ROWS} Positionen — "
    "bitte auf dem Pi in mehrere Sitzungen aufteilen."
)
# The agent client stops reading at MAX_RESPONSE_BYTES. For a session that is
# the same fact in different units — too big for one import — so it gets the
# same remedy, without claiming a row count nobody could read.
SESSION_TOO_LARGE_DETAIL = (
    "Diese Sitzung ist zu groß für eine Übernahme — "
    "bitte auf dem Pi in mehrere Sitzungen aufteilen."
)


def _int(value: Any, default: int = 0) -> int:
    if isinstance(value, bool):
        return default
    if isinstance(value, (int, float)):
        return int(value)
    return default


def _text(value: Any) -> str | None:
    if isinstance(value, str):
        text = value.strip()
        return text or None
    return None


# ---------------------------------------------------------------------------
# Listing
# ---------------------------------------------------------------------------


def _fed_by_station(station_id: int):
    """Inventories this station's sessions were imported into, most recent
    import first.

    One statement for both readers — the card's "Übernommen → Inventur #B"
    tag and the re-import's target — so they can never name two different
    inventories for the same Pi session. The key is *when it was imported*,
    not when the inventory was started: an older inventory the admin chose
    explicitly yesterday is where yesterday's counts went, and where today's
    re-import belongs. A NULL ``source_imported_at`` (a row linked by a
    failed import that never stamped) sorts last on every backend rather
    than wherever the database puts NULL by default.
    """
    return (
        select(WerkstattInventorySession)
        .where(
            WerkstattInventorySession.source_station_id == station_id,
            WerkstattInventorySession.source_session_name.is_not(None),
        )
        .order_by(
            WerkstattInventorySession.source_imported_at.desc().nulls_last(),
            WerkstattInventorySession.id.desc(),
        )
    )


def latest_imports(db: Session, station_id: int) -> dict[str, WerkstattInventorySession]:
    """Per Pi session name, the inventory it was most recently imported into."""
    rows = db.scalars(
        _fed_by_station(station_id).where(WerkstattInventorySession.source_imported_at.is_not(None))
    ).all()
    latest: dict[str, WerkstattInventorySession] = {}
    for row in rows:
        latest.setdefault(str(row.source_session_name), row)
    return latest


def _session_row(
    raw: dict[str, Any], imports: dict[str, WerkstattInventorySession]
) -> StationSessionOut:
    name = str(raw.get("name"))
    imported = imports.get(name)
    return StationSessionOut(
        name=name,
        started_at=_text(raw.get("started_at")),
        status=_text(raw.get("status")) or "open",
        articles=_int(raw.get("articles")),
        total_qty=_int(raw.get("total_qty")),
        total_scans=_int(raw.get("total_scans")),
        last_counted_at=_text(raw.get("last_counted_at")),
        imported_at=imported.source_imported_at if imported is not None else None,
        imported_session_id=imported.id if imported is not None else None,
    )


def list_station_sessions(db: Session, station: Station) -> StationSessionListOut:
    if not is_station_active(station):
        return StationSessionListOut(sessions=[], ok=False, error=STATION_INACTIVE_DETAIL)
    try:
        payload = agent_get(station, "/sessions")
    except StationAgentError as exc:
        return StationSessionListOut(sessions=[], ok=False, error=str(exc))
    raw_rows = payload.get("sessions")
    if not isinstance(raw_rows, list):
        return StationSessionListOut(sessions=[], ok=False, error=NOT_A_SESSION_LIST_DETAIL)
    imports = latest_imports(db, station.id)
    sessions = [
        _session_row(row, imports)
        for row in raw_rows
        if isinstance(row, dict) and isinstance(row.get("name"), str) and row.get("name")
    ]
    return StationSessionListOut(sessions=sessions, ok=True, error=None)


# ---------------------------------------------------------------------------
# Import
# ---------------------------------------------------------------------------


def _fetch_agent_session(station: Station, name: str) -> dict[str, Any]:
    try:
        path = session_path(name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    try:
        payload = agent_get(station, path)
    except StationAgentRemoteError as exc:
        if exc.message == TOO_LARGE_DETAIL:
            raise HTTPException(status_code=409, detail=SESSION_TOO_LARGE_DETAIL) from exc
        raise HTTPException(status_code=exc.http_status, detail=str(exc)) from exc
    except StationAgentError as exc:
        raise HTTPException(status_code=exc.http_status, detail=str(exc)) from exc
    counts = payload.get("counts")
    # The agent answers an unknown name with status "new" and no rows rather
    # than a 404, because on the Pi asking creates nothing. Here it is a 404.
    if payload.get("status") == "new" or not isinstance(counts, list):
        raise HTTPException(
            status_code=404,
            detail=f"Sitzung „{name}“ wurde auf der Station nicht gefunden.",
        )
    return payload


def _rows_from_agent(counts: list[Any]) -> list[ImportRow]:
    """The agent's rows as import rows — all of them, or none.

    A session past ``MAX_IMPORT_ROWS`` is refused with the sentence that
    says what to do; it is never trimmed, because a trimmed import answers
    "ok" for an inventory that is missing rows nobody was told about.
    """
    rows: list[ImportRow] = []
    for raw in counts:
        if not isinstance(raw, dict):
            continue
        code = str(raw.get("code") or "").strip()
        if not code:
            continue
        rows.append(
            ImportRow(
                code=code[:128],
                item_name=str(raw.get("item_name") or "")[:500],
                counted_qty=_int(raw.get("counted_qty")),
                scan_count=_int(raw.get("scan_count")),
            )
        )
    if len(rows) > MAX_IMPORT_ROWS:
        raise HTTPException(status_code=409, detail=TOO_MANY_ROWS_DETAIL)
    return rows


def resolve_import_target(
    db: Session,
    station: Station,
    name: str,
    *,
    target_session_id: int | None,
    create_session_name: str | None,
    user: User,
) -> WerkstattInventorySession:
    """Which inventory the counts go into.

    Explicit target → must be open. Otherwise the open inventory this same
    Pi session most recently fed (so a re-import overwrites rather than
    duplicates, and lands where the card's "Übernommen" tag says it went —
    both read ``_fed_by_station``). Otherwise a new one — which is also what
    happens after the previous target was finalized: a closed stock-take is
    a statement about the past and is never reopened by a later count.
    """
    if target_session_id is not None:
        target = db.get(WerkstattInventorySession, target_session_id)
        if target is None:
            raise HTTPException(status_code=404, detail=INVENTORY_NOT_FOUND_DETAIL)
        if target.status != "open":
            raise HTTPException(status_code=409, detail=SESSION_FINALIZED_DETAIL)
        return target

    previous = db.scalars(
        _fed_by_station(station.id).where(
            WerkstattInventorySession.status == "open",
            WerkstattInventorySession.source_session_name == name,
        )
    ).first()
    if previous is not None:
        return previous

    session_name = (create_session_name or "").strip() or f"Scan-Station {station.name} – {name}"
    created = WerkstattInventorySession(
        name=session_name[:200],
        started_by=user.id,
        status="open",
        source_station_id=station.id,
        source_session_name=name,
    )
    db.add(created)
    db.flush()
    return created


def _detail_sentence(result: dict[str, Any], target_name: str) -> str:
    imported = int(result.get("count_rows_created", 0))
    updated = int(result.get("count_rows_updated", 0))
    sentence = f"{imported} Artikel übernommen, {updated} aktualisiert → Inventur „{target_name}“"
    extras: list[str] = []
    if int(result.get("created_new", 0)):
        extras.append(f"{int(result['created_new'])} neu angelegt")
    if int(result.get("created_from_catalog", 0)):
        extras.append(f"{int(result['created_from_catalog'])} aus dem Katalog")
    skipped = len(result.get("skipped_zero_qty") or [])
    if skipped:
        extras.append(f"{skipped} mit Menge 0 übersprungen")
    if extras:
        sentence += f" ({', '.join(extras)})"
    return sentence + "."


def import_station_session(
    db: Session,
    station: Station,
    name: str,
    *,
    target_session_id: int | None,
    create_session_name: str | None,
    user: User,
) -> StationImportOut:
    payload = _fetch_agent_session(station, name)
    rows = _rows_from_agent(payload["counts"])
    if not rows:
        raise HTTPException(status_code=409, detail=EMPTY_SESSION_DETAIL)

    target = resolve_import_target(
        db,
        station,
        name,
        target_session_id=target_session_id,
        create_session_name=create_session_name,
        user=user,
    )
    result = import_counts(db, session=target, rows=rows, user=user)

    # Link the target to its source *after* the import committed, so a failed
    # import never leaves an inventory claiming counts it does not hold.
    target.source_station_id = station.id
    target.source_session_name = name
    target.source_imported_at = utcnow()
    db.add(target)
    db.commit()
    db.refresh(target)

    return StationImportOut(
        ok=True,
        session_id=target.id,
        session_name=target.name,
        imported=int(result.get("count_rows_created", 0)),
        updated=int(result.get("count_rows_updated", 0)),
        skipped=len(result.get("skipped_zero_qty") or []),
        unmatched=list(result.get("codes_without_barcode") or []),
        detail=_detail_sentence(result, target.name),
    )
