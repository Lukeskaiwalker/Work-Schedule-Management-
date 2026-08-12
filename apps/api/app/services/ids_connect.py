"""IDS-Connect punchout: field-map rendering and browser hand-over sessions.

Pure-ish helpers over a SQLAlchemy session; no FastAPI primitives, so the
token lifecycle can be tested without HTTP.

## How the hand-over actually works

There is no server-to-server API call anywhere in this flow. Both legs are the
*user's browser* carrying a form:

    our page  ──POST(credentials, HOOK_URL)──▶  wholesaler shop
                    ... user shops ...
    our hook  ◀──POST(cart XML)───────────────  wholesaler shop

The second POST is rendered by the shop and submitted by the same browser, so
the hook URL only has to be reachable *from the user's machine* — a workshop
server on a private network works fine, and nothing needs to be exposed to the
wholesaler.

## Why the hook URL carries a token

That inbound POST arrives without our Authorization header — it is a plain
cross-origin form submission the shop composed. So the URL itself has to carry
the authority, in the form of a single-use random token that resolves to a
`WerkstattIdsSession`.

Three properties make that safe enough to expose:

  - **single use** — the token leaves `pending` on first use, so a replayed
    callback cannot mint a second order from the same trip;
  - **short lived** — a link scraped out of a browser history later is inert;
  - **bound to a person** — the session remembers who started it, so the
    resulting draft order has a real creator and a real audit trail.

The token is 32 bytes from `secrets`, which is not guessable at any useful
rate, and it grants exactly one capability: attach one cart to one draft order
for one user. It is not a session cookie and cannot read anything.
"""

from __future__ import annotations

import re
import secrets
from datetime import datetime, timedelta
from typing import Any, Mapping

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.time import utcnow
from app.models.werkstatt_procurement import WerkstattIdsConnection, WerkstattIdsSession
from app.services.secret_box import decrypt_secret

# Shopping is not a 60-second errand — a fitter assembling a cart for a full
# rewire is gone a long time. An expiry shorter than the task would throw the
# whole basket away at the finish line, which is the worst possible failure.
FETCH_TTL_SECONDS = 60 * 60 * 4
# Handing an already-built cart over is a single redirect; it does not need
# hours of validity.
SUBMIT_TTL_SECONDS = 60 * 15

TOKEN_BYTES = 32

# Field-map values are templates over exactly these names. A closed vocabulary
# rather than free `str.format`: a map is admin-editable data, and a stray
# brace in a wholesaler's literal value must not blow up or, worse, address
# something it was not meant to reach.
PLACEHOLDER_PATTERN = re.compile(r"\{([a-z_]+)\}")

# IDS-Connect 2.5 action codes (ITEK). The two that matter here are a pair,
# named from the CRAFT SOFTWARE's point of view — which is the opposite of the
# intuitive reading and an easy way to wire them backwards:
#
#   WKE  Warenkorbübernahme — cart comes FROM the shop INTO us  → "go shopping"
#   WKS  Warenkorbübergabe  — cart goes FROM us INTO the shop   → "order this"
#
# The others exist and are useful for diagnosis: LI (Logininformationen) asks a
# shop which credentials it wants, SV (Schnittstellenversion) which versions it
# speaks, ADL (Artikeldeeplink) jumps to one article by GH-Nummer, AS
# (Artikelsuche) opens a search.
ACTION_FETCH_CART = "WKE"
ACTION_SUBMIT_CART = "WKS"

# Field names are the spec's, which are German and lower-case. This matters
# more than it looks: `USERNAME` is not a mis-cased `benutzername`, it is a
# different word, so a shop reading the spec names simply never sees a
# credential sent under the English one — it reports the *action* as invalid
# and never gets as far as complaining about the login. Verified against
# Unielektro's own `action=LI` response, which answers in
# Benutzername/Passwort/Kundennummer terms.
#
# These remain defaults rather than constants: `name_kunde`/`pw_kunde`/`hookurl`
# is a real shop's spelling of the same three fields, so the map stays editable.
DEFAULT_FETCH_FIELD_MAP: dict[str, str] = {
    "action": ACTION_FETCH_CART,
    "benutzername": "{username}",
    "passwort": "{password}",
    "kundennummer": "{customer_number}",
    "hook_url": "{hook_url}",
    "returntarget": "_top",
    "Version": "{ids_version}",
}

DEFAULT_SUBMIT_FIELD_MAP: dict[str, str] = {
    "action": ACTION_SUBMIT_CART,
    "benutzername": "{username}",
    "passwort": "{password}",
    "kundennummer": "{customer_number}",
    "hook_url": "{hook_url}",
    "returntarget": "_top",
    "Version": "{ids_version}",
    # The cart XML for a WKS call.
    "warenkorb": "{cart_xml}",
}

# POST fields the returned cart is commonly found in. Empty configuration
# falls back to these, and failing those to "any field that parses as XML".
# `warenkorb` leads because it is the spec's own name for the payload.
DEFAULT_CART_FIELD_NAMES: list[str] = [
    "warenkorb",
    "IDS_XML",
    "XML",
    "CART",
    "IDS",
    "XMLDATA",
    "DATA",
]


def default_connection_values() -> dict[str, Any]:
    """Field values a freshly created connection starts with."""

    return {
        "http_method": "POST",
        "ids_version": "2.5",
        "charset": "UTF-8",
        "fetch_field_map": dict(DEFAULT_FETCH_FIELD_MAP),
        "submit_field_map": dict(DEFAULT_SUBMIT_FIELD_MAP),
        "cart_field_names": list(DEFAULT_CART_FIELD_NAMES),
    }


# ──────────────────────────────────────────────────────────────────────────
# Field-map rendering
# ──────────────────────────────────────────────────────────────────────────


def render_field_map(
    field_map: Mapping[str, Any], values: Mapping[str, str]
) -> dict[str, str]:
    """Substitute placeholders, dropping fields that resolve to nothing.

    A field whose template referenced an unset value is omitted entirely
    rather than sent empty. Shops routinely reject `KUNDENNUMMER=` with a
    login error that says nothing useful, where an absent field correctly
    means "we have no customer number".

    Unknown placeholders are left verbatim, so a typo in the admin form shows
    up as a literal `{usrname}` in the request — visible and diagnosable —
    instead of silently becoming an empty credential.
    """

    rendered: dict[str, str] = {}
    for raw_name, raw_template in field_map.items():
        name = str(raw_name).strip()
        if not name:
            continue
        template = "" if raw_template is None else str(raw_template)

        def substitute(match: re.Match[str]) -> str:
            return values.get(match.group(1), match.group(0))

        value = PLACEHOLDER_PATTERN.sub(substitute, template)
        # A template that was ONLY a placeholder and resolved to nothing is a
        # field we have no value for. One that had literal text around it is a
        # field the shop expects regardless, so it stays.
        if not value.strip() and PLACEHOLDER_PATTERN.fullmatch(template.strip()):
            continue
        rendered[name] = value
    return rendered


def hook_url_for(connection: WerkstattIdsConnection, token: str) -> str:
    """Where the shop sends the finished cart.

    `hook_base_url` overrides the app-wide public URL, because the address the
    browser can reach is not always the one the app knows itself by — reverse
    proxies, split-horizon DNS and VPN-only deployments all break that
    assumption, and a wrong hook URL loses the user's whole basket at the last
    step.
    """

    base = (connection.hook_base_url or get_settings().app_public_url or "").strip()
    return f"{base.rstrip('/')}/api/werkstatt/ids/hook/{token}"


def placeholder_values(
    connection: WerkstattIdsConnection,
    *,
    token: str,
    cart_xml: str = "",
    order_number: str = "",
) -> dict[str, str]:
    """The substitution vocabulary for one hand-over."""

    return {
        "username": (connection.username or "").strip(),
        "password": decrypt_secret(connection.password_encrypted),
        "customer_number": (connection.customer_number or "").strip(),
        "hook_url": hook_url_for(connection, token),
        "return_url": hook_url_for(connection, token),
        "ids_version": (connection.ids_version or "2.5").strip(),
        "cart_xml": cart_xml,
        "order_number": order_number,
        "token": token,
    }


# ──────────────────────────────────────────────────────────────────────────
# Session lifecycle
# ──────────────────────────────────────────────────────────────────────────


def create_session(
    db: Session,
    *,
    connection: WerkstattIdsConnection,
    user_id: int,
    direction: str,
    order_id: int | None = None,
    now: datetime | None = None,
) -> WerkstattIdsSession:
    """Open a hand-over. Returns the unsaved-but-added session row."""

    moment = now or utcnow()
    ttl = FETCH_TTL_SECONDS if direction == "fetch" else SUBMIT_TTL_SECONDS
    session = WerkstattIdsSession(
        token=secrets.token_urlsafe(TOKEN_BYTES),
        connection_id=connection.id,
        user_id=user_id,
        direction=direction,
        order_id=order_id,
        status="pending",
        expires_at=moment + timedelta(seconds=ttl),
        created_at=moment,
    )
    db.add(session)
    db.flush()
    return session


def consume_session(
    db: Session, token: str, *, now: datetime | None = None
) -> tuple[WerkstattIdsSession | None, str | None]:
    """Resolve and spend a token.

    Returns ``(session, error)``. The error is German and safe to show: the
    person reading it is the fitter whose cart just failed to arrive, and
    "Sitzung abgelaufen" tells them to shop again while a 403 tells them
    nothing.

    Spending is what makes replay useless, so it happens here, before the
    caller does any work with the payload.
    """

    moment = now or utcnow()
    cleaned = (token or "").strip()
    if not cleaned:
        return None, "Kein Sitzungs-Token übergeben"

    session = db.scalar(
        select(WerkstattIdsSession).where(WerkstattIdsSession.token == cleaned)
    )
    if session is None:
        return None, "Unbekannte oder bereits verwendete Sitzung"
    if session.status != "pending":
        # Already spent. Deliberately not an error the shop can distinguish
        # from an unknown token.
        return None, "Unbekannte oder bereits verwendete Sitzung"
    if session.expires_at <= moment:
        session.status = "expired"
        db.add(session)
        return None, "Die Sitzung ist abgelaufen — bitte den Warenkorb erneut übergeben"

    session.status = "returned"
    session.returned_at = moment
    db.add(session)
    return session, None


def expire_stale_sessions(db: Session, *, now: datetime | None = None) -> int:
    """Mark timed-out pending sessions as expired. Returns how many.

    Housekeeping only — `consume_session` already refuses an expired token on
    its own, so this exists to keep the table honest for anyone reading it,
    not to enforce anything.
    """

    moment = now or utcnow()
    stale = list(
        db.scalars(
            select(WerkstattIdsSession).where(
                WerkstattIdsSession.status == "pending",
                WerkstattIdsSession.expires_at <= moment,
            )
        ).all()
    )
    for session in stale:
        session.status = "expired"
        db.add(session)
    return len(stale)


def extract_cart_payload(
    fields: Mapping[str, str], *, configured_names: list[str] | None
) -> tuple[str | None, str | None]:
    """Find the cart XML among the POSTed form fields.

    Returns ``(payload, field_name)``.

    Order: the names configured for this connection, then the common defaults,
    then — as a last resort — any field whose value looks like XML. That last
    step is what stops a shop renaming its field from costing the user their
    basket, and it is safe because the payload is validated by the parser
    afterwards either way.
    """

    names = [str(name) for name in (configured_names or []) if str(name).strip()]
    for name in [*names, *DEFAULT_CART_FIELD_NAMES]:
        for key, value in fields.items():
            if key.lower() == name.lower() and (value or "").strip():
                return value, key

    for key, value in fields.items():
        text = (value or "").strip()
        if text.startswith("<?xml") or text.startswith("<"):
            return value, key
    return None, None
