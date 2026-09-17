"""Werkstatt — the two IDS-Connect pages a browser reaches mid-hand-over.

Split out of `workflow_werkstatt_ids.py` (connection CRUD, /start, /submit,
the manual import) so neither file outgrows a screen. Nothing here changed in
the move; the routes keep their paths under ``/werkstatt/ids``.

  ``GET  /werkstatt/ids/handoff/{token}``
        The self-submitting form that carries our fields — and, for a
        submit, the cart XML — to the wholesaler's entry URL.
  ``POST /werkstatt/ids/hook/{token}``
        Where the wholesaler's page POSTs the cart back to.

**No permission dependency at all**, on purpose. The hook is a cross-origin
form POST that the wholesaler's page composes, so it arrives with none of our
headers and cannot carry an Authorization token; the hand-off page is opened
in a fresh tab by our own frontend and fetched once. The single-use token in
the path IS the credential — see `services/ids_connect.py` for why that is
sound and what exactly it authorises.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import HTMLResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.time import utcnow
from app.models.entities import (
    WerkstattIdsConnection,
    WerkstattIdsSession,
    WerkstattOrder,
    WerkstattOrderImport,
    WerkstattOrderLine,
    WerkstattSupplier,
)
from app.services.ids_cart_builder import build_cart_xml
from app.services.ids_cart_parser import (
    CartParseError,
    ParsedCart,
    decode_payload,
    parse_cart,
)
from app.services.ids_connect import (
    consume_session,
    extract_cart_payload,
    placeholder_values,
    render_field_map,
)
from app.services.ids_handoff_page import (
    handoff_headers,
    render_handoff_page,
    render_result_page,
    result_headers,
)
from app.services.werkstatt_order_composition import append_cart_lines
from app.services.werkstatt_order_send import prepare_order_for_send
from app.services.werkstatt_orders import generate_order_number

router = APIRouter(prefix="/werkstatt/ids", tags=["werkstatt-procurement"])


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
            # The same resolver and identifier policy as /submit, so the XML
            # the shop receives cannot disagree with the warnings the buyer was
            # shown a moment ago. It is idempotent: everything /submit
            # backfilled resolves at step 1 here, and this pass writes nothing
            # new.
            preparation = prepare_order_for_send(db, order, backfill=True)
            cart_xml = build_cart_xml(
                preparation.items,
                reference=order.order_number,
                customer_number=connection.customer_number,
                ids_version=connection.ids_version,
                charset=connection.charset,
                warn_on_missing_article_no=False,
                identifier=preparation.identifier,
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


