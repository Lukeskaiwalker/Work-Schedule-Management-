"""Werkstatt — wholesaler punchout (IDS-Connect) endpoints.

Three groups, with deliberately different gating:

  ``/werkstatt/ids/connections*``  — credentials and shop URLs.
        `settings:manage`, the same grant that guards SMTP and the label
        printer. Configuring a shop connection means holding an ordering
        credential; that is an administrator's job, not a buyer's.

  ``/werkstatt/ids/start|submit|import|imports``
        `werkstatt:manage`, the grant that already guards creating an order.
        Anyone who may write an order may go and fetch one.

  ``/werkstatt/ids/handoff/{token}`` and ``/werkstatt/ids/hook/{token}``
        **No permission dependency at all.** These are reached by a browser
        mid-hand-over: the hook is a cross-origin form POST that the
        wholesaler's page composes, so it arrives with none of our headers and
        cannot carry an Authorization token. The single-use token in the path
        IS the credential — see `services/ids_connect.py` for why that is
        sound and what exactly it authorises.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import HTMLResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.deps import require_permission
from app.core.time import utcnow
from app.models.entities import (
    Project,
    Task,
    User,
    WerkstattIdsConnection,
    WerkstattIdsSession,
    WerkstattOrder,
    WerkstattOrderImport,
    WerkstattOrderLine,
    WerkstattSupplier,
)
from app.routers._werkstatt_tablet_shared import load_order_full
from app.schemas.werkstatt import WerkstattOrderOut
from app.schemas.werkstatt_procurement import (
    CartImportResultOut,
    CartPreviewLineOut,
    IdsConnectionOut,
    IdsConnectionTestOut,
    IdsConnectionUpsertPayload,
    IdsStartOut,
    IdsStartPayload,
    IdsSubmitOut,
    ManualCartImportPayload,
    OrderImportOut,
)
from app.services.audit import log_admin_action
from app.services.ids_cart_builder import build_cart_xml, cart_items_for_order_lines
from app.services.ids_cart_parser import (
    CartParseError,
    ParsedCart,
    decode_payload,
    parse_cart,
)
from app.services.ids_connect import (
    assert_directions_not_swapped,
    consume_session,
    describe_field_map_problems,
    create_session,
    default_connection_values,
    extract_cart_payload,
    hook_url_for,
    placeholder_values,
    render_field_map,
)
from app.services.ids_handoff_page import (
    handoff_headers,
    render_handoff_page,
    render_result_page,
    result_headers,
)
from app.services.secret_box import encrypt_secret
from app.services.werkstatt_order_composition import append_cart_lines, resolve_article
from app.services.werkstatt_orders import generate_order_number

router = APIRouter(prefix="/werkstatt/ids", tags=["werkstatt-procurement"])

# Placeholder used when previewing a hook URL in the admin screen, so the
# preview never contains a token that would actually work.
PREVIEW_TOKEN = "<TOKEN>"


# ──────────────────────────────────────────────────────────────────────────
# Connection configuration
# ──────────────────────────────────────────────────────────────────────────


def _connection_out(db: Session, connection: WerkstattIdsConnection) -> IdsConnectionOut:
    supplier = db.get(WerkstattSupplier, connection.supplier_id)
    return IdsConnectionOut(
        id=connection.id,
        supplier_id=connection.supplier_id,
        supplier_name=supplier.name if supplier else "",
        is_enabled=connection.is_enabled,
        entry_url=connection.entry_url or "",
        http_method=connection.http_method,
        ids_version=connection.ids_version,
        charset=connection.charset,
        username=connection.username,
        customer_number=connection.customer_number,
        has_password=bool(connection.password_encrypted),
        fetch_field_map=dict(connection.fetch_field_map or {}),
        submit_field_map=dict(connection.submit_field_map or {}),
        cart_field_names=list(connection.cart_field_names or []),
        hook_base_url=connection.hook_base_url,
        hook_url_preview=hook_url_for(connection, PREVIEW_TOKEN),
        notes=connection.notes,
        created_at=connection.created_at,
        updated_at=connection.updated_at,
    )


@router.get("/connections", response_model=list[IdsConnectionOut])
def list_ids_connections(
    _: User = Depends(require_permission("settings:manage")),
    db: Session = Depends(get_db),
) -> list[IdsConnectionOut]:
    connections = list(
        db.scalars(select(WerkstattIdsConnection).order_by(WerkstattIdsConnection.id)).all()
    )
    return [_connection_out(db, connection) for connection in connections]


@router.put("/connections", response_model=IdsConnectionOut)
def upsert_ids_connection(
    payload: IdsConnectionUpsertPayload,
    admin: User = Depends(require_permission("settings:manage")),
    db: Session = Depends(get_db),
) -> IdsConnectionOut:
    supplier = db.get(WerkstattSupplier, payload.supplier_id)
    if supplier is None or supplier.is_archived:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Lieferant nicht gefunden")

    connection = db.scalar(
        select(WerkstattIdsConnection).where(
            WerkstattIdsConnection.supplier_id == payload.supplier_id
        )
    )
    now = utcnow()
    if connection is None:
        connection = WerkstattIdsConnection(
            supplier_id=payload.supplier_id,
            created_by=admin.id,
            created_at=now,
            updated_at=now,
            **default_connection_values(),
        )
        db.add(connection)

    connection.is_enabled = payload.is_enabled
    connection.entry_url = (payload.entry_url or "").strip()
    connection.http_method = payload.http_method
    connection.ids_version = (payload.ids_version or "2.5").strip()
    connection.charset = (payload.charset or "UTF-8").strip()
    connection.username = (payload.username or "").strip() or None
    connection.customer_number = (payload.customer_number or "").strip() or None
    connection.hook_base_url = (payload.hook_base_url or "").strip() or None
    connection.notes = payload.notes

    # Tri-state: None leaves the stored password alone (the form still held the
    # mask), "" clears it, anything else replaces it. Without the first case,
    # saving any other setting would silently wipe the credential.
    if payload.password is not None:
        connection.password_encrypted = (
            encrypt_secret(payload.password) if payload.password else None
        )

    if payload.fetch_field_map is not None:
        assert_directions_not_swapped(payload.fetch_field_map, direction="fetch")
        connection.fetch_field_map = payload.fetch_field_map
    if payload.submit_field_map is not None:
        assert_directions_not_swapped(payload.submit_field_map, direction="submit")
        connection.submit_field_map = payload.submit_field_map
    if payload.cart_field_names is not None:
        connection.cart_field_names = [str(name) for name in payload.cart_field_names]

    connection.updated_at = now
    db.add(connection)
    db.commit()
    db.refresh(connection)

    log_admin_action(
        db,
        admin,
        "werkstatt.ids_connection.update",
        "werkstatt_ids_connection",
        str(connection.id),
        {
            "supplier_id": connection.supplier_id,
            "is_enabled": connection.is_enabled,
            "entry_url": connection.entry_url,
            # Never the password, and never the rendered field map — the map
            # values are templates, but a misconfigured one could hold a
            # literal credential.
            "password_set": bool(connection.password_encrypted),
        },
    )
    return _connection_out(db, connection)


@router.delete("/connections/{supplier_id}")
def delete_ids_connection(
    supplier_id: int,
    admin: User = Depends(require_permission("settings:manage")),
    db: Session = Depends(get_db),
) -> dict[str, bool]:
    connection = db.scalar(
        select(WerkstattIdsConnection).where(WerkstattIdsConnection.supplier_id == supplier_id)
    )
    if connection is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Keine Shop-Anbindung")
    connection_id = connection.id
    db.delete(connection)
    db.commit()
    log_admin_action(
        db,
        admin,
        "werkstatt.ids_connection.delete",
        "werkstatt_ids_connection",
        str(connection_id),
        {"supplier_id": supplier_id},
    )
    return {"deleted": True}


@router.post("/connections/{supplier_id}/test", response_model=IdsConnectionTestOut)
def test_ids_connection(
    supplier_id: int,
    _: User = Depends(require_permission("settings:manage")),
    db: Session = Depends(get_db),
) -> IdsConnectionTestOut:
    """Pre-flight the configuration without contacting the wholesaler.

    There is nothing to ping — a punchout has no server-to-server endpoint, and
    "does this credential work" is only answerable by a human logging in. What
    IS checkable is everything that goes wrong before that: a missing entry
    URL, a hook URL pointing at `localhost` (which the user's browser will
    resolve to their own machine, not the server), a field map with no
    placeholder for the hook at all.

    Showing the rendered fields with the password masked lets an admin diff
    their setup against the wholesaler's datasheet directly.
    """

    connection = db.scalar(
        select(WerkstattIdsConnection).where(WerkstattIdsConnection.supplier_id == supplier_id)
    )
    if connection is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Keine Shop-Anbindung")

    problems: list[str] = []
    if not (connection.entry_url or "").strip():
        problems.append("Es ist keine Shop-Adresse (Entry-URL) hinterlegt.")
    elif not connection.entry_url.lower().startswith(("http://", "https://")):
        problems.append("Die Shop-Adresse muss mit http:// oder https:// beginnen.")
    elif connection.entry_url.lower().startswith("http://"):
        problems.append(
            "Die Shop-Adresse ist unverschlüsselt (http://) — die Zugangsdaten "
            "würden im Klartext übertragen."
        )
    if not (connection.username or "").strip():
        problems.append("Es ist kein Benutzername hinterlegt.")
    if not connection.password_encrypted:
        problems.append("Es ist kein Passwort hinterlegt.")

    hook_url = hook_url_for(connection, PREVIEW_TOKEN)
    if "localhost" in hook_url or "127.0.0.1" in hook_url:
        problems.append(
            "Die Rückgabe-Adresse zeigt auf localhost. Sie muss aus dem Browser "
            "des Mitarbeiters erreichbar sein — bitte eine erreichbare Adresse eintragen."
        )
    if not hook_url.startswith(("http://", "https://")):
        problems.append("Die Rückgabe-Adresse ist unvollständig (APP_PUBLIC_URL prüfen).")

    values = placeholder_values(connection, token=PREVIEW_TOKEN)
    rendered = render_field_map(connection.fetch_field_map or {}, values)

    # The checks that matter most are about the NAMES, not the values: a field
    # the shop does not recognise is ignored rather than rejected, so a
    # credential under the wrong name produces an unauthenticated call and no
    # error anywhere. Warnings are appended after errors so the actionable
    # item reads first.
    field_errors, field_warnings = describe_field_map_problems(
        connection.fetch_field_map or {},
        direction="fetch",
        has_username=bool((connection.username or "").strip()),
    )
    problems.extend(field_errors)
    problems.extend(field_warnings)

    password = values.get("password") or ""
    masked = {
        name: ("••••••••" if password and value == password else value)
        for name, value in rendered.items()
    }
    return IdsConnectionTestOut(
        ok=not problems, problems=problems, hook_url=hook_url, preview_fields=masked
    )


# ──────────────────────────────────────────────────────────────────────────
# Hand-over
# ──────────────────────────────────────────────────────────────────────────


def _enabled_connection(db: Session, supplier_id: int) -> WerkstattIdsConnection:
    connection = db.scalar(
        select(WerkstattIdsConnection).where(
            WerkstattIdsConnection.supplier_id == supplier_id,
            WerkstattIdsConnection.is_enabled.is_(True),
        )
    )
    if connection is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Für diesen Lieferanten ist keine Shop-Anbindung eingerichtet",
        )
    if not (connection.entry_url or "").strip():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Die Shop-Anbindung ist unvollständig — bitte im Admin-Bereich prüfen",
        )
    return connection


def _validate_anchor(db: Session, task_id: int | None, project_id: int | None) -> None:
    if task_id is not None and db.get(Task, task_id) is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Auftrag nicht gefunden")
    if project_id is not None and db.get(Project, project_id) is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Projekt nicht gefunden")


@router.post("/start", response_model=IdsStartOut)
def start_punchout(
    payload: IdsStartPayload,
    current_user: User = Depends(require_permission("werkstatt:manage")),
    db: Session = Depends(get_db),
) -> IdsStartOut:
    """Open a shopping trip. Returns a URL for the frontend to open in a tab."""

    connection = _enabled_connection(db, payload.supplier_id)
    _validate_anchor(db, payload.task_id, payload.project_id)

    # Check the mapping at the moment it is used, not only when it is saved.
    # A save-time check cannot see a row that was already wrong — written by an
    # older version, repaired by a migration, or edited straight in the
    # database — and this is the last point where the failure is still legible.
    # Past here the call goes out unauthenticated, the shop treats it as an
    # anonymous visitor, and the user discovers the problem as a missing cart
    # twenty minutes later with nothing to read anywhere.
    field_errors, _ = describe_field_map_problems(
        connection.fetch_field_map or {},
        direction="fetch",
        has_username=bool((connection.username or "").strip()),
    )
    if field_errors:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                "Die Shop-Anbindung ist nicht korrekt konfiguriert: "
                + " ".join(field_errors)
                + " (Admin → Einstellungen → IDS-Anbindung, dort 'Prüfen')"
            ),
        )

    target_order: WerkstattOrder | None = None
    if payload.order_id is not None:
        target_order = db.get(WerkstattOrder, payload.order_id)
        if target_order is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="Bestellung nicht gefunden"
            )
        if target_order.status != "draft" or target_order.is_template:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Es kann nur zu einem Entwurf hinzugefügt werden",
            )
        if target_order.supplier_id != connection.supplier_id:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Die Bestellung gehört zu einem anderen Lieferanten",
            )

    session = create_session(
        db,
        connection=connection,
        user_id=current_user.id,
        direction="fetch",
        order_id=target_order.id if target_order else None,
    )
    db.commit()
    db.refresh(session)

    # Relative on purpose. This page is opened by our own frontend, in a tab
    # that is already on our origin, so the browser resolves it correctly in
    # every deployment. Building it from `app_public_url` sent users to
    # https://localhost — that setting defaults to localhost and describes
    # how the app refers to ITSELF, which behind a reverse proxy, a duckdns
    # name or a VPN is not the address the user's browser is using.
    #
    # HOOK_URL is the one URL here that must stay absolute (see
    # ids_connect.hook_url_for): it is embedded in a form submitted to the
    # wholesaler, so a relative path would have no origin to resolve against.
    return IdsStartOut(
        token=session.token,
        handoff_url=f"/api/werkstatt/ids/handoff/{session.token}",
        expires_at=session.expires_at,
    )


@router.post("/submit", response_model=IdsSubmitOut)
def submit_order_to_shop(
    order_id: int = Query(...),
    current_user: User = Depends(require_permission("werkstatt:manage")),
    db: Session = Depends(get_db),
) -> IdsSubmitOut:
    """Hand an assembled order back to the wholesaler's basket.

    This does not place the order. It fills the shop's basket and hands the
    browser over so the human confirms there, under the wholesaler's own
    prices and stock. See `services/ids_cart_builder.py`.

    The returned `warnings` are the only channel the buyer has for a line the
    shop will not receive. `ids_ean_resolver` translates each line into this
    supplier's own article number and names — with SP-number, description and
    EAN — every line it could not, so a short basket is visible here rather
    than discovered when the van is loaded.
    """

    order = db.get(WerkstattOrder, order_id)
    if order is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Bestellung nicht gefunden")
    if order.is_template:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Eine Vorlage kann nicht bestellt werden — bitte zuerst übernehmen",
        )

    connection = _enabled_connection(db, order.supplier_id)
    supplier = db.get(WerkstattSupplier, order.supplier_id)
    full = load_order_full(db, order)
    items, resolution = cart_items_for_order_lines(
        db,
        supplier_id=order.supplier_id,
        lines=full.lines,
        supplier_name=supplier.name if supplier else None,
    )
    built = build_cart_xml(
        items,
        reference=order.order_number,
        customer_number=connection.customer_number,
        ids_version=connection.ids_version,
        charset=connection.charset,
        # The resolver has already reported every dropped line, with the
        # detail needed to fix it. The builder's generic notice would only
        # repeat it, less usefully.
        warn_on_missing_article_no=False,
    )

    session = create_session(
        db,
        connection=connection,
        user_id=current_user.id,
        direction="submit",
        order_id=order.id,
    )
    order.submitted_at = utcnow()
    db.add(order)
    db.commit()
    db.refresh(session)

    # Relative on purpose. This page is opened by our own frontend, in a tab
    # that is already on our origin, so the browser resolves it correctly in
    # every deployment. Building it from `app_public_url` sent users to
    # https://localhost — that setting defaults to localhost and describes
    # how the app refers to ITSELF, which behind a reverse proxy, a duckdns
    # name or a VPN is not the address the user's browser is using.
    #
    # HOOK_URL is the one URL here that must stay absolute (see
    # ids_connect.hook_url_for): it is embedded in a form submitted to the
    # wholesaler, so a relative path would have no origin to resolve against.
    return IdsSubmitOut(
        token=session.token,
        handoff_url=f"/api/werkstatt/ids/handoff/{session.token}",
        expires_at=session.expires_at,
        # Resolution warnings first: an unresolved line is the one that will be
        # missing from the basket, and the buyer skims this list.
        warnings=[*resolution.warnings(), *built.warnings],
    )


@router.get("/handoff/{token}", response_class=HTMLResponse, include_in_schema=False)
def render_handoff(token: str, db: Session = Depends(get_db)) -> HTMLResponse:
    """Serve the self-submitting form. Unauthenticated by necessity.

    Fetchable exactly once: the page carries the wholesaler password in a
    hidden field, so a URL that could be replayed out of browser history would
    be a credential-disclosure route. The token stays otherwise valid because
    the *hook* still has to use it when the cart comes back.
    """

    session = db.scalar(select(WerkstattIdsSession).where(WerkstattIdsSession.token == token))
    now = utcnow()
    if session is None or session.status not in {"pending"} or session.expires_at <= now:
        return HTMLResponse(
            render_result_page(
                heading="Sitzung nicht mehr gültig",
                message=(
                    "Diese Weiterleitung wurde bereits verwendet oder ist abgelaufen. "
                    "Bitte den Vorgang in SMPL erneut starten."
                ),
                return_url="/",
                is_error=True,
            ),
            status_code=status.HTTP_410_GONE,
            headers=result_headers(),
        )
    if session.opened_at is not None:
        return HTMLResponse(
            render_result_page(
                heading="Weiterleitung bereits geöffnet",
                message=(
                    "Diese Weiterleitung wurde schon einmal aufgerufen. Aus "
                    "Sicherheitsgründen wird sie kein zweites Mal ausgeliefert."
                ),
                return_url="/",
                is_error=True,
            ),
            status_code=status.HTTP_410_GONE,
            headers=result_headers(),
        )

    connection = db.get(WerkstattIdsConnection, session.connection_id)
    if connection is None or not connection.is_enabled:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Shop-Anbindung nicht verfügbar"
        )

    cart_xml = ""
    order_number = ""
    if session.direction == "submit" and session.order_id is not None:
        order = db.get(WerkstattOrder, session.order_id)
        if order is not None:
            order_number = order.order_number
            full = load_order_full(db, order)
            # The same resolver as /submit, so the XML the shop receives cannot
            # disagree with the warnings the buyer was shown a moment ago. It
            # is idempotent: everything /submit backfilled resolves at step 1
            # here, and this pass writes nothing new.
            items, _ = cart_items_for_order_lines(
                db, supplier_id=order.supplier_id, lines=full.lines
            )
            cart_xml = build_cart_xml(
                items,
                reference=order.order_number,
                customer_number=connection.customer_number,
                ids_version=connection.ids_version,
                charset=connection.charset,
                warn_on_missing_article_no=False,
            ).xml

    field_map = (
        connection.submit_field_map if session.direction == "submit" else connection.fetch_field_map
    )
    fields = render_field_map(
        field_map or {},
        placeholder_values(
            connection, token=token, cart_xml=cart_xml, order_number=order_number
        ),
    )

    session.opened_at = now
    db.add(session)
    supplier = db.get(WerkstattSupplier, connection.supplier_id)
    db.commit()

    return HTMLResponse(
        render_handoff_page(
            action_url=connection.entry_url,
            method=connection.http_method,
            fields=fields,
            supplier_name=supplier.name if supplier else "Lieferant",
        ),
        headers=handoff_headers(connection.entry_url),
    )


def _result(
    heading: str,
    message: str,
    *,
    error: bool = False,
    code: int = 200,
    return_url: str = "/",
) -> HTMLResponse:
    return HTMLResponse(
        render_result_page(
            heading=heading, message=message, return_url=return_url, is_error=error
        ),
        status_code=code,
        headers=result_headers(),
    )


@router.post("/hook/{token}", response_class=HTMLResponse, include_in_schema=False)
async def receive_cart(token: str, request: Request, db: Session = Depends(get_db)) -> HTMLResponse:
    """Receive the cart the wholesaler's page POSTs back. Unauthenticated by design.

    Every exit from this function writes an audit row first. A cart that
    arrives and is then dropped because the XML was in a dialect we did not
    expect is the single most expensive failure in this feature — the user has
    already done the work — so the payload is persisted before it is
    interpreted, and stays persisted when interpretation fails.
    """

    session, error = consume_session(db, token)
    if session is None:
        db.commit()  # persist the expiry flip, if that is what happened
        return _result("Warenkorb nicht übernommen", error or "Ungültige Sitzung", error=True, code=410)

    connection = db.get(WerkstattIdsConnection, session.connection_id)
    if connection is None:
        db.commit()
        return _result(
            "Warenkorb nicht übernommen",
            "Die Shop-Anbindung existiert nicht mehr.",
            error=True,
            code=410,
        )

    # Read the payload however it arrived: a form POST is the norm, but some
    # shops POST the XML as the raw request body with an XML content type.
    content_type = request.headers.get("content-type", "")
    raw_body = await request.body()
    payload_text: str | None = None
    if "xml" in content_type.lower():
        payload_text = decode_payload(raw_body, declared_charset=connection.charset)
    else:
        try:
            form = await request.form()
            fields = {str(k): str(v) for k, v in form.multi_items() if isinstance(v, str)}
        except Exception:
            fields = {}
        payload_text, _field = extract_cart_payload(
            fields, configured_names=list(connection.cart_field_names or [])
        )
        if payload_text is None and raw_body:
            payload_text = decode_payload(raw_body, declared_charset=connection.charset)

    import_row = WerkstattOrderImport(
        supplier_id=connection.supplier_id,
        connection_id=connection.id,
        session_id=session.id,
        source="ids_cart",
        status="received",
        content_type=content_type[:255] or None,
        raw_payload=payload_text,
        created_by=session.user_id,
        created_at=utcnow(),
    )
    db.add(import_row)
    db.flush()

    if not payload_text:
        import_row.status = "failed"
        import_row.error_message = "Der Shop hat keinen Warenkorb mitgeschickt."
        db.add(import_row)
        db.commit()
        return _result(
            "Kein Warenkorb empfangen",
            "Der Shop hat keine Warenkorbdaten übermittelt. Bitte im Shop erneut "
            "auf „Warenkorb übergeben“ klicken.",
            error=True,
        )

    try:
        cart = parse_cart(payload_text)
    except CartParseError as exc:
        import_row.status = "failed"
        import_row.error_message = str(exc)
        db.add(import_row)
        db.commit()
        return _result(
            "Warenkorb konnte nicht gelesen werden",
            f"{exc} Die Rohdaten wurden gespeichert und können im Import-Protokoll "
            "eingesehen werden.",
            error=True,
        )

    order = _order_for_session(db, session, connection, cart)
    import_row.order_id = order.id
    import_row.external_reference = cart.external_reference
    import_row.parsed_line_count = len(cart.lines)
    import_row.status = "committed"
    db.add(import_row)
    db.flush()

    # Which way the cart is travelling decides whether it extends the order or
    # supersedes it.
    #
    #   fetch (WKE)   a shopping trip. Appending is the point: a second trip
    #                 extends the first rather than discarding it, which is what
    #                 `append_cart_lines` documents and is correct here.
    #   submit (WKS)  the cart we just handed over, coming back. Appending it
    #                 would file every position twice — a purchase order that
    #                 says 20 m of cable where the buyer asked for 10.
    #
    # On the way back the shop's version is the authoritative one: it has
    # applied the customer's own conditions and may carry edits made in the
    # basket. So it replaces rather than merges.
    #
    # Only when it actually contains something. An empty or unreadable return
    # must not wipe an order the buyer spent time assembling, and the raw
    # payload is stored either way, so nothing is lost by declining to act.
    if session.direction == "submit" and cart.lines:
        db.query(WerkstattOrderLine).filter(
            WerkstattOrderLine.order_id == order.id
        ).delete(synchronize_session=False)
        db.flush()

    if cart.lines or session.direction != "submit":
        append_cart_lines(db, order, cart, import_id=import_row.id)
    session.order_id = order.id
    db.add(session)
    db.commit()

    count = len(cart.lines)
    # WarenkorbInfo/RueckgabeKZ is the wholesaler saying whether the buyer
    # actually committed. It is the only field that separates "looked at the
    # basket" from "placed the order", so it is worth telling them which one the
    # shop reported rather than leaving them to guess from the order list.
    placed = " Der Shop meldet: Bestellung wurde ausgelöst." if cart.order_placed else ""
    # The shop returns the cart as a browser form POST with target=_top, so this
    # page replaces the tab the user started in — it is not a popup. Telling
    # them to close it is telling them to close the app, and it contradicts the
    # "Zurück zu SMPL" button directly underneath.
    #
    # The button carries the order in a query parameter. The SPA has no router —
    # navigation is a `mainView` state string — so a path like
    # /werkstatt/orders/12 would simply load the app at its default view, which
    # is what left the buyer on the dashboard hunting for the order they had
    # just created. `?werkstatt_order=` is read once at boot, opens the order,
    # and is then stripped from the URL, matching how the app already handles
    # its invite and password-reset links.
    return _result(
        "Warenkorb übernommen",
        f"{count} Position{'en' if count != 1 else ''} wurden als Bestellung "
        f"{order.order_number} gespeichert.{placed}",
        return_url=f"/?werkstatt_order={order.id}",
    )


def _order_for_session(
    db: Session,
    session: WerkstattIdsSession,
    connection: WerkstattIdsConnection,
    cart: ParsedCart,
) -> WerkstattOrder:
    """The order a returned cart lands in — the one asked for, or a new draft."""

    if session.order_id is not None:
        existing = db.get(WerkstattOrder, session.order_id)
        if existing is not None and existing.status == "draft":
            return existing

    now = utcnow()
    supplier = db.get(WerkstattSupplier, connection.supplier_id)
    order = WerkstattOrder(
        order_number=generate_order_number(db, now=now),
        supplier_id=connection.supplier_id,
        status="draft",
        currency=cart.currency or "EUR",
        title=f"{supplier.name if supplier else 'Shop'}-Warenkorb "
        f"{now.strftime('%d.%m.%Y')}",
        source="ids",
        external_reference=cart.external_reference,
        created_by=session.user_id,
        created_at=now,
        updated_at=now,
    )
    db.add(order)
    db.flush()
    return order


# ──────────────────────────────────────────────────────────────────────────
# Manual import + audit log
# ──────────────────────────────────────────────────────────────────────────


@router.post("/import", response_model=CartImportResultOut)
def import_cart_xml(
    payload: ManualCartImportPayload,
    current_user: User = Depends(require_permission("werkstatt:manage")),
    db: Session = Depends(get_db),
) -> CartImportResultOut:
    """Import a cart XML by hand — the path that does not need a punchout.

    Same parser, same audit row, same result as the hook. Exists so the
    feature is usable before Unielektro's datasheet is configured, and so the
    whole pipeline is exercisable in a test without a browser.
    """

    supplier = db.get(WerkstattSupplier, payload.supplier_id)
    if supplier is None or supplier.is_archived:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Lieferant nicht gefunden")
    _validate_anchor(db, payload.task_id, payload.project_id)

    connection = db.scalar(
        select(WerkstattIdsConnection).where(
            WerkstattIdsConnection.supplier_id == payload.supplier_id
        )
    )
    import_row = WerkstattOrderImport(
        supplier_id=supplier.id,
        connection_id=connection.id if connection else None,
        source="manual_xml",
        status="received",
        content_type="application/xml",
        raw_payload=payload.xml,
        created_by=current_user.id,
        created_at=utcnow(),
    )
    db.add(import_row)
    db.flush()

    try:
        cart = parse_cart(payload.xml)
    except CartParseError as exc:
        import_row.status = "failed"
        import_row.error_message = str(exc)
        db.add(import_row)
        db.commit()
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    order: WerkstattOrder | None = None
    if payload.order_id is not None:
        order = db.get(WerkstattOrder, payload.order_id)
        if order is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="Bestellung nicht gefunden"
            )
        if order.status != "draft" or order.is_template:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Es kann nur zu einem Entwurf hinzugefügt werden",
            )
        if order.supplier_id != supplier.id:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Die Bestellung gehört zu einem anderen Lieferanten",
            )

    now = utcnow()
    if order is None:
        order = WerkstattOrder(
            order_number=generate_order_number(db, now=now),
            supplier_id=supplier.id,
            status="draft",
            currency=cart.currency or "EUR",
            title=f"{supplier.name}-Warenkorb {now.strftime('%d.%m.%Y')}",
            source="ids",
            external_reference=cart.external_reference,
            task_id=payload.task_id,
            project_id=payload.project_id,
            created_by=current_user.id,
            created_at=now,
            updated_at=now,
        )
        db.add(order)
        db.flush()

    import_row.order_id = order.id
    import_row.external_reference = cart.external_reference
    import_row.parsed_line_count = len(cart.lines)
    import_row.status = "committed"
    db.add(import_row)
    db.flush()

    append_cart_lines(db, order, cart, import_id=import_row.id, now=now)
    db.commit()

    return CartImportResultOut(
        import_id=import_row.id,
        order_id=order.id,
        order_number=order.order_number,
        line_count=len(cart.lines),
        warnings=list(cart.warnings),
        lines=[_preview_line(db, supplier.id, parsed) for parsed in cart.lines],
    )


def _preview_line(db: Session, supplier_id: int, parsed) -> CartPreviewLineOut:
    article_id, _link_id = resolve_article(
        db,
        supplier_id=supplier_id,
        supplier_article_no=parsed.supplier_article_no,
        ean=parsed.ean,
    )
    name: str | None = None
    if article_id is not None:
        from app.models.entities import WerkstattArticle

        article = db.get(WerkstattArticle, article_id)
        name = article.item_name if article else None
    return CartPreviewLineOut(
        position=parsed.position,
        supplier_article_no=parsed.supplier_article_no,
        description=parsed.description,
        manufacturer=parsed.manufacturer,
        ean=parsed.ean,
        quantity=parsed.quantity,
        quantity_raw=parsed.quantity_raw,
        unit=parsed.unit,
        unit_price_cents=parsed.unit_price_cents,
        currency=parsed.currency,
        warnings=list(parsed.warnings),
        matched_article_id=article_id,
        matched_article_name=name,
    )


@router.get("/imports", response_model=list[OrderImportOut])
def list_cart_imports(
    limit: int = Query(default=50, ge=1, le=200),
    _: User = Depends(require_permission("werkstatt:manage")),
    db: Session = Depends(get_db),
) -> list[OrderImportOut]:
    """The import log. The place a lost cart is recovered from."""

    rows = list(
        db.scalars(
            select(WerkstattOrderImport)
            .order_by(WerkstattOrderImport.created_at.desc(), WerkstattOrderImport.id.desc())
            .limit(limit)
        ).all()
    )
    out: list[OrderImportOut] = []
    for row in rows:
        supplier = db.get(WerkstattSupplier, row.supplier_id)
        order = db.get(WerkstattOrder, row.order_id) if row.order_id else None
        creator = db.get(User, row.created_by) if row.created_by else None
        out.append(
            OrderImportOut(
                id=row.id,
                supplier_id=row.supplier_id,
                supplier_name=supplier.name if supplier else "",
                source=row.source,
                status=row.status,
                external_reference=row.external_reference,
                parsed_line_count=row.parsed_line_count,
                error_message=row.error_message,
                order_id=row.order_id,
                order_number=order.order_number if order else None,
                created_by=row.created_by,
                created_by_name=getattr(creator, "full_name", None) if creator else None,
                created_at=row.created_at,
            )
        )
    return out


@router.get("/orders/{order_id}", response_model=WerkstattOrderOut, include_in_schema=False)
def get_imported_order(
    order_id: int,
    _: User = Depends(require_permission("werkstatt:manage")),
    db: Session = Depends(get_db),
) -> WerkstattOrderOut:
    """Convenience re-read used by the import screen after a cart lands."""

    order = db.get(WerkstattOrder, order_id)
    if order is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Bestellung nicht gefunden")
    return load_order_full(db, order)
