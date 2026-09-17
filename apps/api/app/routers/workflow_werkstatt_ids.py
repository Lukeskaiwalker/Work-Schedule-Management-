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
        mid-hand-over and live in `workflow_werkstatt_ids_handoff.py`; the
        single-use token in the path IS the credential — see
        `services/ids_connect.py` for why that is sound.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status
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
    WerkstattOrder,
    WerkstattOrderImport,
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
from app.services.ids_cart_builder import build_cart_xml
from app.services.ids_cart_parser import CartParseError, parse_cart
from app.services.ids_connect import (
    assert_directions_not_swapped,
    describe_field_map_problems,
    create_session,
    default_connection_values,
    hook_url_for,
    placeholder_values,
    render_field_map,
)
from app.services.secret_box import encrypt_secret
from app.services.werkstatt_order_composition import append_cart_lines, resolve_article
from app.services.werkstatt_order_send import prepare_order_for_send, require_resolved
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

    # A supplier with a live shop connection IS a shop supplier: the order
    # dialog preselects on `order_channel`, and before this line nothing ever
    # set it — Unielektro stayed "manual" until somebody edited the supplier
    # by hand. Disabling does NOT flip it back: a connection switched off for
    # a credential rotation does not turn the wholesaler into a CSV shop, and
    # the supplier form still lets an admin change the channel explicitly.
    if payload.is_enabled and supplier.order_channel != "ids":
        supplier.order_channel = "ids"
        supplier.updated_at = now
        db.add(supplier)

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
    allow_unresolved: bool = Query(default=False),
    current_user: User = Depends(require_permission("werkstatt:manage")),
    db: Session = Depends(get_db),
) -> IdsSubmitOut:
    """Hand an assembled order back to the wholesaler's basket.

    This does not place the order. It fills the shop's basket and hands the
    browser over so the human confirms there, under the wholesaler's own
    prices and stock. See `services/ids_cart_builder.py`.

    A line the supplier cannot identify is a 409 (`unresolved_lines`, with the
    positions and the resolver's warnings in the detail) rather than a quietly
    short basket. ``allow_unresolved`` is the buyer's "Trotzdem übergeben":
    the cart goes out without those lines and `warnings` says which — the
    pre-v2.15 behaviour, now opt-in. Nothing is stamped on a 409.
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
    # The same at-the-moment-of-use check /start runs on the fetch map. A WKS
    # map without {cart_xml} hands the shop an empty basket and errors
    # nowhere; this is the last point where that is still legible.
    field_errors, _ = describe_field_map_problems(
        connection.submit_field_map or {},
        direction="submit",
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

    preparation = prepare_order_for_send(db, order, backfill=True)
    try:
        require_resolved(preparation, allow_unresolved=allow_unresolved)
    except HTTPException:
        # A refused hand-over writes nothing, not even the resolver's
        # backfill: the buyer only looked, and will be back after fixing.
        db.rollback()
        raise
    built = build_cart_xml(
        preparation.items,
        reference=order.order_number,
        customer_number=connection.customer_number,
        ids_version=connection.ids_version,
        charset=connection.charset,
        # The resolver has already reported every dropped line, with the
        # detail needed to fix it. The builder's generic notice would only
        # repeat it, less usefully.
        warn_on_missing_article_no=False,
        identifier=preparation.identifier,
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
    # The preparation already reconciled every line's sentence (dropped lines
    # first, then the policy's own notes about lines that travel). The
    # builder repeats the policy's notes for the positions it rendered — the
    # same text, from the same `wire_identity` — so only what it adds on top
    # (an empty cart) goes through; a sentence must not appear twice.
    builder_only = [text for text in built.warnings if text not in preparation.warnings]
    return IdsSubmitOut(
        token=session.token,
        handoff_url=f"/api/werkstatt/ids/handoff/{session.token}",
        expires_at=session.expires_at,
        warnings=[*preparation.warnings, *builder_only],
    )


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
