"""Werkstatt procurement — wholesaler punchout (IDS-Connect) tables.

Split out of `werkstatt.py` because this is a distinct concern with a distinct
lifetime: `werkstatt.py` models what we *own*, this file models how we *buy*.
The order tables themselves stay where they are — an imported cart becomes an
ordinary `WerkstattOrder`, not a second kind of order.

## What IDS-Connect is

IDS-Connect is the German wholesale trade's punchout standard (the electrical
and SHK equivalent of SAP OCI). The craftsman's software does not talk to an
API; it hands the *browser* over:

1.  We POST an HTML form to the wholesaler's entry URL carrying credentials
    and a ``HOOK_URL`` that points back at us.
2.  The user shops in the wholesaler's own webshop, with their own prices and
    their own availability data.
3.  On "Warenkorb übergeben" the shop POSTs the cart back to ``HOOK_URL`` as
    XML, and we turn it into a draft order.

The reverse direction ("Warenkorbübergabe") is the same handshake with our
cart XML in the payload: the user lands in the shop with the basket already
filled and completes the purchase there.

## Why the connection is configuration and not code

Every wholesaler publishes their own *IDS-Datenblatt* fixing the entry URL,
the form-field names and the exact XML dialect, and they differ. The spec's
own spelling is ``benutzername``/``passwort``/``hook_url``; a shop in the wild
answers to ``name_kunde``/``pw_kunde``/``hookurl`` for the same three fields.
Hard-coding one spelling would mean a deploy every time a wholesaler differs,
and would silently misfire the day one moves.

So the field names live in ``fetch_field_map`` / ``submit_field_map`` as data,
rendered against a small placeholder vocabulary (see
``services/ids_connect.py``). Configuring a second wholesaler is then a form
someone fills in, not a code change.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Integer,
    JSON,
    String,
    Text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base
from app.core.time import utcnow


class WerkstattIdsConnection(Base):
    """One wholesaler's punchout configuration.

    Unique per supplier: a supplier either has a shop connection or does not.
    """

    __tablename__ = "werkstatt_ids_connections"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    supplier_id: Mapped[int] = mapped_column(
        ForeignKey("werkstatt_suppliers.id", ondelete="CASCADE"),
        nullable=False,
        unique=True,
        index=True,
    )

    # Off by default. A half-configured connection must not offer the user a
    # button that drops them on a wholesaler login page with empty credentials.
    is_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    # Where the browser is handed over. From the wholesaler's IDS-Datenblatt.
    entry_url: Mapped[str] = mapped_column(String(1000), nullable=False, default="")
    # POST or GET. IDS classically POSTs; a few shops accept GET for the
    # article-jump variant only.
    http_method: Mapped[str] = mapped_column(String(8), nullable=False, default="POST")
    ids_version: Mapped[str] = mapped_column(String(16), nullable=False, default="2.5")

    # 2.5 says the cart XML declares its own encoding and that UTF-8 applies
    # when it is silent, so UTF-8 is the default. Still configurable: older
    # shops on 1.3/2.0 predate that and emit ISO-8859-1, and the wrong charset
    # is the classic cause of "Möller" arriving as "MÃ¶ller". Only the OUTBOUND
    # cart depends on this — inbound, the parser prefers whatever the document
    # declares about itself.
    charset: Mapped[str] = mapped_column(String(32), nullable=False, default="UTF-8")

    username: Mapped[str | None] = mapped_column(String(255))
    # Fernet ciphertext, never the plaintext. See services/secret_box.py. The
    # shop password is a live ordering credential — anyone holding it can place
    # a binding order in the company's name — so it does not sit in the
    # database in the clear the way the SMTP password currently does.
    password_encrypted: Mapped[str | None] = mapped_column(Text)
    customer_number: Mapped[str | None] = mapped_column(String(64))

    # Form fields for "let me shop" and for "here is my cart". Values are
    # templates over the placeholder vocabulary in services/ids_connect.py,
    # e.g. {"action": "WKE", "benutzername": "{username}", "hook_url": "{hook_url}"}.
    fetch_field_map: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    submit_field_map: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)

    # Which POST field the shop puts the returned cart XML in. A list because
    # shops disagree (IDS_XML, XML, WARENKORB, …) and because a shop that
    # changes it should cost the user one edit, not a support call. Empty list
    # means "scan every field for something that parses as XML".
    cart_field_names: Mapped[list] = mapped_column(JSON, nullable=False, default=list)

    # Overrides settings.app_public_url when the deployment sits behind a
    # different externally reachable name than the one the app knows about.
    # The wholesaler's server must be able to reach the hook URL.
    hook_base_url: Mapped[str | None] = mapped_column(String(500))

    notes: Mapped[str | None] = mapped_column(Text)
    created_by: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), index=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=utcnow, onupdate=utcnow, nullable=False
    )


class WerkstattIdsSession(Base):
    """One browser hand-over, alive for a few minutes.

    This row is what makes the hook URL safe to expose. The wholesaler's server
    POSTs the finished cart back to us without any of our cookies, so the
    request cannot be authenticated the normal way. Instead the hook URL
    carries a single-use random token that resolves to exactly this row, which
    remembers who started the trip and what it was for.

    Consequences that the endpoint depends on:
      - a token is spent on first use (``status`` leaves ``pending``), so a
        replayed callback cannot create a second order;
      - a token expires on a clock, so a link captured from a browser history
        months later is inert;
      - the cart is attributed to ``user_id``, so the resulting draft order has
        a real creator rather than a service account.
    """

    __tablename__ = "werkstatt_ids_sessions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    # URL-safe random, 32+ chars. Unique so the lookup is a single row hit.
    token: Mapped[str] = mapped_column(String(64), nullable=False, unique=True, index=True)

    connection_id: Mapped[int] = mapped_column(
        ForeignKey("werkstatt_ids_connections.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )

    # fetch  — user goes shopping, cart comes back to us
    # submit — we hand an existing order over to the shop
    direction: Mapped[str] = mapped_column(String(16), nullable=False, default="fetch")

    # For `submit`: the order we sent. For `fetch`: the order the returned cart
    # was appended to, when the user chose to extend an existing one rather
    # than start a new one.
    order_id: Mapped[int | None] = mapped_column(
        ForeignKey("werkstatt_orders.id", ondelete="SET NULL"), index=True
    )

    # pending | opened | returned | expired | failed
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="pending", index=True)

    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, index=True)
    opened_at: Mapped[datetime | None] = mapped_column(DateTime)
    returned_at: Mapped[datetime | None] = mapped_column(DateTime)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)


class WerkstattOrderImport(Base):
    """Audit record of one cart arriving from a wholesaler.

    Deliberately mirrors ``WerkstattDatanormImport``: one row per inbound
    payload, kept whether or not parsing succeeded.

    ``raw_payload`` is the point of the table. The IDS dialect a given shop
    actually emits is only really known once one of its carts has landed, and
    a parser that guessed wrong on the first import would otherwise have
    destroyed the only evidence. Keeping the bytes means a corrected parser can
    be pointed at the historical imports rather than asking the user to shop
    again.
    """

    __tablename__ = "werkstatt_order_imports"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)

    supplier_id: Mapped[int] = mapped_column(
        ForeignKey("werkstatt_suppliers.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    connection_id: Mapped[int | None] = mapped_column(
        ForeignKey("werkstatt_ids_connections.id", ondelete="SET NULL"), index=True
    )
    session_id: Mapped[int | None] = mapped_column(
        ForeignKey("werkstatt_ids_sessions.id", ondelete="SET NULL"), index=True
    )

    # ids_cart | manual_xml
    source: Mapped[str] = mapped_column(String(32), nullable=False, default="ids_cart")
    # received | parsed | failed | committed
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="received", index=True)

    content_type: Mapped[str | None] = mapped_column(String(255))
    raw_payload: Mapped[str | None] = mapped_column(Text)
    external_reference: Mapped[str | None] = mapped_column(String(128))

    parsed_line_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    error_message: Mapped[str | None] = mapped_column(Text)

    order_id: Mapped[int | None] = mapped_column(
        ForeignKey("werkstatt_orders.id", ondelete="SET NULL"), index=True
    )
    created_by: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), index=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False, index=True)
