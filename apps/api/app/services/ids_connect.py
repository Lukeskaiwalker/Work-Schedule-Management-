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

from fastapi import HTTPException, status
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

# These are the spec's HTTP PARAMETER names, which are not the German words
# that describe them.
#
# The parameter table in IDS-Connect (§5.8, identical in 2.0, 2.3 and 2.5) has
# two name columns, and only the second one goes on the wire:
#
#     Anfrageparameter   Muss/Kann   Format       HTTP Parameter
#     Kundennummer       Kann        STRING 50    kndnr
#     Benutzername       Kann        STRING 50    name_kunde
#     Passwort           Kann        STRING 50    pw_kunde
#     Aktionscode        Muss        Codeliste    action
#     Warenkorb          Kann        STRING       warenkorb
#     HOOK-URL           Kann        STRING 256   hookurl
#     Version            Kann        STRING 5     version
#     Target             Kann        STRING 50    target
#
# This module previously used the left column, lower-cased. Every field except
# `action` was therefore a name no shop reads, and a shop does not reject an
# unknown field — it ignores it. Two consequences, and the second is the one
# that was reported:
#
#   * credentials arrived under `benutzername`/`passwort`, so the punchout ran
#     anonymously. Measured: fake credentials under name_kunde/pw_kunde return
#     "Ungültiger Benutzername oder Passwort"; under our old names the same
#     request returned a plain 302 to /basket, i.e. nobody was logged in.
#   * the return address arrived under `hook_url`, so no hook was registered at
#     all. Measured two ways against www.unielektro.de: the shop's own transmit
#     form renders action="https://…/hook/<token>" when the field is `hookurl`
#     and action="/ids/debug" when it is `hook_url`; and the hook is stored in
#     the shop's session cookie, whose length grew by exactly one byte per URL
#     character with `hookurl` and did not move at all with `hook_url`.
#
# That second measurement is the whole bug: /ids/debug is the page showing raw
# cart XML that the crew kept landing on. The spec is explicit about the
# consequence — "Der Parameter Hook-Url muss in jedem Fall mitgesendet werden,
# da nur dann eine Rückübertragung möglich ist."
#
# Corroborated by four independent implementations (Skeferstat/IDS in C#,
# fega-schmitt-client in Python, IDSConnect-for-Delphi, OSG Trade's published
# call), none of which spells the hook with an underscore.
#
# These remain defaults rather than constants: a wholesaler may need a spelling
# nobody here has seen, which is why the map is admin-editable at all.
DEFAULT_FETCH_FIELD_MAP: dict[str, str] = {
    "action": ACTION_FETCH_CART,
    "name_kunde": "{username}",
    "pw_kunde": "{password}",
    "kndnr": "{customer_number}",
    "hookurl": "{hook_url}",
    "target": "_top",
    "version": "{ids_version}",
}

DEFAULT_SUBMIT_FIELD_MAP: dict[str, str] = {
    "action": ACTION_SUBMIT_CART,
    "name_kunde": "{username}",
    "pw_kunde": "{password}",
    "kndnr": "{customer_number}",
    "hookurl": "{hook_url}",
    "target": "_top",
    "version": "{ids_version}",
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


def action_of(field_map: Mapping[str, Any]) -> str:
    """The action code a field map will send, or "" if it sets none.

    Case-insensitive on the key because the spec writes `action` but shops and
    admins both reach for `ACTION`, and either works on the wire.
    """

    for key, value in (field_map or {}).items():
        if str(key).strip().lower() == "action":
            return str(value or "").strip().upper()
    return ""


def assert_directions_not_swapped(field_map: Mapping[str, Any], *, direction: str) -> None:
    """Refuse a field map that sends the opposite direction's action.

    WKE and WKS are named from the craft software's point of view and read as
    near-synonyms in German, so putting them the wrong way round is the natural
    mistake — and it fails in a way that looks like anything but a swap:

    A `WKS` sent as the fetch call *appears to work*. It hands our cart to the
    shop and lands the user on the basket page looking exactly as expected. But
    WKS has no return leg, so the shop never registers a hook, and when the user
    presses "per IDS übermitteln" it has nowhere to send the cart and shows the
    payload on a debug page instead. The user is left staring at their own data
    on the wholesaler's site with no way back, and nothing anywhere reports an
    error, because as far as both systems are concerned nothing went wrong.

    Only the exact inversion is rejected. Every other action stays allowed:
    another wholesaler may well need something this code has never heard of,
    which is the entire reason the map is editable.
    """

    action = action_of(field_map)
    if direction == "fetch" and action == ACTION_SUBMIT_CART:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "Die Aktion zum Warenkorb-Holen darf nicht 'WKS' sein — das ist die "
                "Übergabe eines Warenkorbs AN den Shop und registriert keine "
                "Rückgabe-Adresse. Zum Holen wird 'WKE' (Warenkorbübernahme) "
                "benötigt, sonst zeigt der Shop den Warenkorb nur an, statt ihn "
                "zurückzuschicken."
            ),
        )
    if direction == "submit" and action == ACTION_FETCH_CART:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "Die Aktion zum Warenkorb-Senden darf nicht 'WKE' sein — das ist die "
                "Übernahme eines Warenkorbs AUS dem Shop. Zum Senden wird 'WKS' "
                "(Warenkorbübergabe) benötigt."
            ),
        )


# Field names any IDS shop has been observed to accept: the 2.5 spec's own
# spelling, plus the variants real shops use. Deliberately a *warning* list and
# not a whitelist — a wholesaler may need something nobody here has seen, which
# is why the map is editable at all.
IDS_KNOWN_FIELDS: frozenset[str] = frozenset(
    {
        "action",
        # Spec names first, then the variants real shops use.
        "name_kunde", "benutzername", "benutzer",
        "pw_kunde", "passwort", "kennwort",
        "kndnr", "kundennummer", "kdnr", "kundennr",
        "hookurl", "hook_url", "hook",
        "target", "returntarget",
        "version",
        "warenkorb", "searchterm", "ghnummer", "heatinglabel", "mode",
    }
)

# The one field name that actually registers a return address. Measured against
# Unielektro: of ten spellings tried (hookurl, hook_url, HOOK_URL, ReturnURL,
# returnurl, return_url, hook, url, hook-url, hookadresse) only `hookurl` was
# recorded — the rest left the shop's stored hook byte-identical to sending
# nothing. Case is not significant; punctuation is.
IDS_HOOK_FIELDS: frozenset[str] = frozenset({"hookurl"})

# Fields a shop reads a username from.
IDS_CREDENTIAL_FIELDS: frozenset[str] = frozenset({"name_kunde", "benutzername", "benutzer"})

# Wrong field names this feature has shipped, mapped to the spec's HTTP
# parameter. Two generations are represented, because there were two mistakes:
# first invented English names, then the spec's German *labels* rather than its
# HTTP parameters. Kept for diagnosis so a message can name the right field
# outright instead of leaving an admin to diff two lists by eye.
INVENTED_TO_SPEC: dict[str, str] = {
    # First generation: invented outright.
    "username": "name_kunde",
    "password": "pw_kunde",
    "ids_xml": "warenkorb",
    # Second generation: the spec's descriptive label instead of its HTTP
    # parameter. These look authoritative, which is exactly why they survived
    # two rounds of correction.
    "benutzername": "name_kunde",
    "passwort": "pw_kunde",
    "kundennummer": "kndnr",
    "hook_url": "hookurl",
    "returntarget": "target",
}


def describe_field_map_problems(
    field_map: Mapping[str, Any], *, direction: str, has_username: bool
) -> tuple[list[str], list[str]]:
    """Inspect a field map for the ways it silently fails to work.

    Returns ``(errors, warnings)``. Errors mean the call cannot possibly
    succeed; warnings mean it looks wrong but might be a wholesaler we have
    simply never met.

    This exists because the punchout's failures are all quiet. A field name the
    shop does not recognise is not rejected — it is *ignored*, so a call with
    the credential under the wrong name arrives unauthenticated and the shop
    behaves as if an anonymous visitor had knocked. Nothing errors anywhere,
    and the symptom surfaces three steps later as "the cart never came back".

    Checking the ACTION alone is not enough, which the field learned the hard
    way: an action can be corrected while every credential field around it
    stays wrong, leaving a configuration that passes inspection and still
    cannot log in.
    """

    errors: list[str] = []
    warnings: list[str] = []
    names = {str(key).strip().lower() for key in (field_map or {})}
    templates = " ".join(str(value or "") for value in (field_map or {}).values())

    if not action_of(field_map):
        errors.append("Im Feld-Mapping fehlt eine 'action' — der Shop weiß nicht, was er tun soll.")

    if direction == "fetch" and "{hook_url}" not in templates:
        errors.append(
            "Im Feld-Mapping kommt kein {hook_url} vor — der Shop weiß dann nicht, "
            "wohin er den Warenkorb zurückschicken soll."
        )
    elif direction == "fetch" and not (names & IDS_HOOK_FIELDS):
        # The placeholder being present is not enough — it is the FIELD NAME the
        # shop reads. A map carrying {hook_url} under the key "hook_url" passed
        # every check here for three releases while the shop quietly registered
        # no return address and dumped the cart on its own debug page.
        offender = next(
            (n for n in sorted(names) if INVENTED_TO_SPEC.get(n) == "hookurl"),
            None,
        )
        if offender:
            errors.append(
                f"Die Rücksprungadresse steht unter '{offender}' — diesen Feldnamen "
                f"liest der Shop nicht. Er merkt sich dadurch keine Adresse und zeigt "
                f"den Warenkorb am Ende als XML-Text an, statt ihn zurückzuschicken. "
                f"Das Feld muss 'hookurl' heißen."
            )
        else:
            # Some wholesaler we have never met may genuinely use another name,
            # so this stays a warning rather than blocking the punchout.
            warnings.append(
                "Im Feld-Mapping ist kein 'hookurl' enthalten — ohne dieses Feld "
                "schickt der Shop den Warenkorb nicht zurück. Bitte gegen das "
                "IDS-Datenblatt des Großhändlers prüfen."
            )
    if direction == "submit" and "{cart_xml}" not in templates:
        errors.append(
            "Im Feld-Mapping kommt kein {cart_xml} vor — es würde ein leerer "
            "Warenkorb übergeben."
        )

    # The live failure: a credential present, but under a name no shop reads.
    if has_username and direction == "fetch":
        if not (names & IDS_CREDENTIAL_FIELDS):
            offenders = sorted(names & set(INVENTED_TO_SPEC))
            if offenders:
                renamed = ", ".join(f"'{n}' → '{INVENTED_TO_SPEC[n]}'" for n in offenders)
                errors.append(
                    f"Die Zugangsdaten werden unter einem Feldnamen gesendet, den der "
                    f"Shop nicht liest ({renamed}). Der Aufruf kommt dadurch ohne "
                    f"Anmeldung an, und der Shop schickt den Warenkorb nicht zurück."
                )
            else:
                warnings.append(
                    "Im Feld-Mapping ist kein bekanntes Benutzername-Feld "
                    "(name_kunde) enthalten — bitte gegen das IDS-Datenblatt prüfen."
                )

    unknown = sorted(name for name in names if name not in IDS_KNOWN_FIELDS)
    if unknown:
        warnings.append(
            "Diese Feldnamen stehen nicht in der IDS-Connect-2.5-Spezifikation: "
            + ", ".join(unknown)
            + ". Das kann korrekt sein, wenn das Datenblatt des Großhändlers sie so "
            "vorgibt — sonst werden sie vom Shop ignoriert."
        )

    return errors, warnings


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
