"""ids-connect: send the spec's HTTP parameter names, not its German labels

The parameter table in IDS-Connect (§5.8, identical across 2.0, 2.3 and 2.5)
has two name columns, and only the second one goes on the wire:

    Anfrageparameter   HTTP Parameter
    Kundennummer       kndnr
    Benutzername       name_kunde
    Passwort           pw_kunde
    HOOK-URL           hookurl
    Target             target

Migration 0068 corrected the invented English names to the first column,
lower-cased. That looked authoritative and was wrong: a shop reads the second.
An unknown field is not rejected, it is ignored, so the calls kept succeeding
while carrying nothing the shop could use.

Measured against www.unielektro.de, no credentials sent:

  * the shop's own transmit form renders
        action="https://…/api/werkstatt/ids/hook/<token>"   with `hookurl`
        action="/ids/debug"                                  with `hook_url`
    /ids/debug is the raw-XML page the crew kept landing on.
  * the shop stores the hook inside its session cookie, and the cookie grew by
    exactly one byte per URL character when the field was `hookurl`, and did
    not move at all when it was `hook_url` — byte-identical to sending no hook.
  * fake credentials under name_kunde/pw_kunde return "Ungültiger Benutzername
    oder Passwort"; under benutzername/passwort the same request returns a
    plain 302, i.e. nobody was logged in and the crew shopped anonymously.

Why this renames KEYS rather than replacing the maps
----------------------------------------------------
0068 and 0069 both keyed their repair on the action VALUE, which is the first
thing a human edits while debugging — so both skipped the one production row
they existed to fix. This keys on the field NAMES instead, which nobody edits
by hand, and renames them in place so any value an admin deliberately tuned
survives. A key is only renamed when the correct name is not already present,
so running against an already-correct row does nothing.

Revision ID: 20260814_0071
Revises: 20260812_0070
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "20260814_0071"
down_revision: Union[str, Sequence[str], None] = "20260812_0070"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# Wrong name -> spec HTTP parameter. Both generations of mistake: invented
# English names, and the spec's descriptive labels.
RENAMES: dict[str, str] = {
    "username": "name_kunde",
    "benutzername": "name_kunde",
    "password": "pw_kunde",
    "passwort": "pw_kunde",
    "kundennummer": "kndnr",
    "hook_url": "hookurl",
    "returntarget": "target",
    "ids_xml": "warenkorb",
}


def _connections_table() -> sa.Table:
    return sa.table(
        "werkstatt_ids_connections",
        sa.column("id", sa.Integer),
        sa.column("fetch_field_map", sa.JSON),
        sa.column("submit_field_map", sa.JSON),
    )


def _as_dict(value: object) -> dict:
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


def _rename_keys(field_map: dict) -> dict | None:
    """Return a copy with wrong keys renamed, or None if nothing to do.

    Insertion order is preserved so a diff of the stored JSON stays readable.
    """

    present = {str(k).strip().lower() for k in field_map}
    updated: dict = {}
    changed = False

    for key, value in field_map.items():
        target = RENAMES.get(str(key).strip().lower())
        # Do not clobber a correct key that is already there — that would drop
        # whichever value came second.
        if target and target not in present:
            updated[target] = value
            changed = True
        else:
            updated[key] = value

    return updated if changed else None


def upgrade() -> None:
    if op.get_context().as_sql:
        raise RuntimeError(
            "20260814_0071 rewrites stored JSON per row and cannot run in "
            "offline (--sql) mode. Run `alembic upgrade head` against the "
            "database directly."
        )

    connection = op.get_bind()
    table = _connections_table()
    rows = connection.execute(
        sa.select(table.c.id, table.c.fetch_field_map, table.c.submit_field_map)
    ).fetchall()

    for row_id, fetch_raw, submit_raw in rows:
        values: dict = {}

        fixed_fetch = _rename_keys(_as_dict(fetch_raw))
        if fixed_fetch is not None:
            values["fetch_field_map"] = fixed_fetch

        fixed_submit = _rename_keys(_as_dict(submit_raw))
        if fixed_submit is not None:
            values["submit_field_map"] = fixed_submit

        if values:
            connection.execute(table.update().where(table.c.id == row_id).values(**values))


def downgrade() -> None:
    # Deliberately empty. The previous names were not a working configuration
    # to return to — they were names no shop reads, which is the whole reason
    # this migration exists. The maps are admin-editable if a wholesaler ever
    # genuinely needs a different spelling.
    pass
