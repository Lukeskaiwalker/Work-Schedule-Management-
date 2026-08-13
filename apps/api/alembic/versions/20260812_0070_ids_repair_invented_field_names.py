"""ids-connect: repair maps still using the invented English field names

Third attempt at the same row, and the first one keyed on something the user
would never have typed.

0068 asked "is the action WWWSHOP?" and 0069 asked "is the action WKS?" — but
the action is the first thing anyone edits when debugging, so both predicates
missed a row whose owner had already touched it. Worse, the two together left
a row that *looked* repaired: 0069 corrected the action to WKE, which satisfied
the new swap validator, while every credential field around it stayed wrong.
That configuration passes inspection and still cannot log in.

The reliable signal is the field NAMES. `USERNAME`, `PASSWORD` and `TARGET`
are not misspellings of the spec's `benutzername`, `passwort` and
`returntarget` — they are different words that appear in no wholesaler's
datasheet. They exist in exactly one place: the default this feature shipped
with. Nobody reading real documentation types them, so their presence
identifies our own bad default no matter what else has been edited since.

Why it matters that they are ignored rather than rejected: a shop drops an
unrecognised field silently, so the call arrives with no credentials, the shop
treats it as an anonymous visitor, and nothing anywhere reports an error. The
symptom appears much later as a cart that never comes back.

Revision ID: 20260812_0070
Revises: 20260812_0069
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "20260812_0070"
down_revision: Union[str, Sequence[str], None] = "20260812_0069"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# Names that only ever came from our own invented default.
INVENTED_MARKERS = {"username", "password", "target", "ids_xml"}

SPEC_FETCH = {
    "action": "WKE",
    "benutzername": "{username}",
    "passwort": "{password}",
    "kundennummer": "{customer_number}",
    "hook_url": "{hook_url}",
    "returntarget": "_top",
    "Version": "{ids_version}",
}

SPEC_SUBMIT = {
    "action": "WKS",
    "benutzername": "{username}",
    "passwort": "{password}",
    "kundennummer": "{customer_number}",
    "hook_url": "{hook_url}",
    "returntarget": "_top",
    "Version": "{ids_version}",
    "warenkorb": "{cart_xml}",
}


def _table() -> sa.Table:
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


def _has_invented_names(field_map: dict) -> bool:
    return bool({str(k).strip().lower() for k in field_map} & INVENTED_MARKERS)


def upgrade() -> None:
    if op.get_context().as_sql:
        raise RuntimeError(
            "20260812_0070 inspects stored JSON per row and cannot run in "
            "offline (--sql) mode. Run `alembic upgrade head` against the "
            "database directly."
        )

    connection = op.get_bind()
    table = _table()
    rows = connection.execute(
        sa.select(table.c.id, table.c.fetch_field_map, table.c.submit_field_map)
    ).fetchall()

    for row_id, fetch_raw, submit_raw in rows:
        values: dict = {}
        if _has_invented_names(_as_dict(fetch_raw)):
            values["fetch_field_map"] = SPEC_FETCH
        if _has_invented_names(_as_dict(submit_raw)):
            values["submit_field_map"] = SPEC_SUBMIT
        if values:
            connection.execute(table.update().where(table.c.id == row_id).values(**values))


def downgrade() -> None:
    # Nothing to restore: the previous names were ones no shop reads.
    #
    # NOTE for rolling an image back past this point — the same applies to 0068
    # and 0069. The api container runs `alembic upgrade head` on boot, so an
    # older image whose scripts stop at, say, 0067 will refuse to start against
    # a database stamped 0070 ("Can't locate revision"). Walk the stamp back
    # first with `alembic stamp <older-revision>`; these three downgrades are
    # intentionally no-ops, so stamping is safe and loses nothing but the
    # repairs, which the newer image reapplies.
    pass
