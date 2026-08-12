"""ids-connect: use the real IDS-Connect 2.5 field names

The punchout shipped with invented field names. Nothing about it could have
worked, and the way it failed hid the cause: the wholesaler answered "Die von
Ihnen ausgeführte Aktion 'WWWSHOP' ist nicht gültig", which reads like one
wrong value in an otherwise correct call. In fact every field was wrong.

What the spec actually says (ITEK IDS-Connect 2.5), confirmed against
Unielektro's own `action=LI` and `action=SV` discovery responses:

    was sent          should be        note
    ACTION=WWWSHOP    action=WKE       Warenkorbübernahme (shop → us)
    ACTION=…WARENKORB action=WKS       Warenkorbübergabe (us → shop)
    USERNAME          benutzername     a different word, not a case variant
    PASSWORD          passwort
    KUNDENNUMMER      kundennummer
    HOOK_URL          hook_url
    TARGET            returntarget
    VERSION           Version
    IDS_XML           warenkorb        the cart payload on a WKS call

`USERNAME` versus `benutzername` is why the error was misleading: a shop
reading the spec names never receives a credential at all, so it rejects the
action long before it has anything to say about the login.

Charset moves from ISO-8859-1 to UTF-8: 2.5 says the XML declaration decides
and UTF-8 is the default when it is silent, and Unielektro's responses declare
UTF-8. Inbound was never affected — the parser already prefers whatever the
document declares about itself — but our outbound cart was being encoded in
the wrong charset.

## Why a migration rather than only new defaults

The defaults live in code, but a configured connection has its own copy in
`werkstatt_ids_connections`, written when an admin saved the form. Shipping
corrected defaults alone would leave every existing connection broken, with no
symptom other than the same misleading error.

Only rows still carrying the broken values are touched, identified by their
bogus action. A connection whose maps were edited by hand is left exactly as
it is — the whole point of the maps being configuration is that a wholesaler
may need something we did not predict.

Revision ID: 20260812_0068
Revises: 20260812_0067
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "20260812_0068"
down_revision: Union[str, Sequence[str], None] = "20260812_0067"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# Kept as literals rather than imported from app.services.ids_connect: a
# migration describes one moment in the schema's history, and must keep saying
# the same thing after the application's defaults move on again.
BROKEN_ACTIONS = {"WWWSHOP", "WWWSHOPWARENKORB"}

FIXED_FETCH = {
    "action": "WKE",
    "benutzername": "{username}",
    "passwort": "{password}",
    "kundennummer": "{customer_number}",
    "hook_url": "{hook_url}",
    "returntarget": "_top",
    "Version": "{ids_version}",
}

FIXED_SUBMIT = {
    "action": "WKS",
    "benutzername": "{username}",
    "passwort": "{password}",
    "kundennummer": "{customer_number}",
    "hook_url": "{hook_url}",
    "returntarget": "_top",
    "Version": "{ids_version}",
    "warenkorb": "{cart_xml}",
}

FIXED_CART_FIELDS = ["warenkorb", "IDS_XML", "XML", "CART", "IDS", "XMLDATA", "DATA"]


def _connections_table() -> sa.Table:
    """Minimal table construct so SQLAlchemy serialises the JSON columns.

    Raw SQL would need a dialect-specific cast to write a JSON column on
    Postgres while staying plain text on SQLite; letting the type system do it
    keeps one code path.
    """

    return sa.table(
        "werkstatt_ids_connections",
        sa.column("id", sa.Integer),
        sa.column("charset", sa.String),
        sa.column("fetch_field_map", sa.JSON),
        sa.column("submit_field_map", sa.JSON),
        sa.column("cart_field_names", sa.JSON),
    )


def _as_dict(value: object) -> dict:
    """JSON column → dict, whichever way the driver hands it over.

    psycopg2 decodes a json column to a dict; SQLite gives back the raw text.
    """

    import json

    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value.strip():
        try:
            parsed = json.loads(value)
        except ValueError:
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


def upgrade() -> None:
    # `as_sql` is the MigrationContext's offline flag; `is_offline_mode()`
    # lives on the environment context and is not reachable from here.
    if op.get_context().as_sql:
        # This repair reads each row, inspects its JSON and decides. There is
        # no fixed SQL to emit, so `alembic upgrade --sql` would print a lone
        # SELECT and silently skip the fix — leaving someone convinced the
        # migration ran when the connections are still broken. Fail instead.
        raise RuntimeError(
            "20260812_0068 rewrites stored JSON per row and cannot run in "
            "offline (--sql) mode. Run `alembic upgrade head` against the "
            "database directly."
        )

    connection = op.get_bind()
    table = _connections_table()

    rows = connection.execute(
        sa.select(table.c.id, table.c.fetch_field_map, table.c.charset)
    ).fetchall()

    for row in rows:
        fetch_map = _as_dict(row[1])
        # Match the action key case-insensitively: what identifies a broken row
        # is the invented VALUE, and the old default spelled the key `ACTION`.
        action = ""
        for key, value in fetch_map.items():
            if str(key).strip().lower() == "action":
                action = str(value or "").strip().upper()
                break

        if action not in BROKEN_ACTIONS:
            # Either already correct, or deliberately customised. Leave it.
            continue

        values: dict = {
            "fetch_field_map": FIXED_FETCH,
            "submit_field_map": FIXED_SUBMIT,
            "cart_field_names": FIXED_CART_FIELDS,
        }
        # Only correct the charset where it still holds the old wrong default;
        # a shop that genuinely needs ISO-8859-1 may have had it set on purpose.
        if str(row[2] or "").strip().upper() in {"ISO-8859-1", "ISO8859-1", "LATIN-1"}:
            values["charset"] = "UTF-8"

        connection.execute(table.update().where(table.c.id == row[0]).values(**values))


def downgrade() -> None:
    # Deliberately empty. The previous values were not a working configuration
    # to return to — they were names no wholesaler answers to. Restoring them
    # would only reinstate the bug, and the maps are admin-editable anyway.
    pass
