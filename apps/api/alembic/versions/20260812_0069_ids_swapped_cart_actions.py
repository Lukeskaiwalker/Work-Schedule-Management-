"""ids-connect: unswap WKE/WKS where the two directions were reversed

WKE and WKS are named from the craft software's point of view and read as near
synonyms in German, so they get put the wrong way round. Migration 0068 could
not fix this case: it only repaired maps still carrying the invented
`WWWSHOP` default, and a hand-entered `WKS` looks deliberate rather than
broken.

The swap is worth a migration of its own because of how it fails. A `WKS` sent
as the fetch call *appears to work* — it hands our cart to the shop and lands
the user on the basket page looking exactly right. But WKS has no return leg,
so the shop never registers the hook URL, and when the user presses "per IDS
übermitteln" the shop has nowhere to send the cart and prints the payload to a
debug page instead. Nothing errors on either side. The user is simply left
looking at their own data on the wholesaler's site with no way back.

Only an exact inversion is corrected:

    fetch_field_map.action  == WKS  →  WKE
    submit_field_map.action == WKE  →  WKS

Anything else is left alone. Another wholesaler may need an action this code
has never heard of, which is why the maps are editable in the first place.

Revision ID: 20260812_0069
Revises: 20260812_0068
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "20260812_0069"
down_revision: Union[str, Sequence[str], None] = "20260812_0068"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

FETCH_ACTION = "WKE"
SUBMIT_ACTION = "WKS"


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


def _rewrite_action(field_map: dict, *, when: str, then: str) -> dict | None:
    """Return a copy with the action swapped, or None if nothing to do.

    The action key keeps whatever case it already had — only the VALUE is
    wrong, and rewriting the key too would be an unrequested change to a map
    somebody may have tuned deliberately.
    """

    for key, value in field_map.items():
        if str(key).strip().lower() != "action":
            continue
        if str(value or "").strip().upper() != when:
            return None
        updated = dict(field_map)
        updated[key] = then
        return updated
    return None


def upgrade() -> None:
    if op.get_context().as_sql:
        raise RuntimeError(
            "20260812_0069 inspects stored JSON per row and cannot run in "
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

        fixed_fetch = _rewrite_action(
            _as_dict(fetch_raw), when=SUBMIT_ACTION, then=FETCH_ACTION
        )
        if fixed_fetch is not None:
            values["fetch_field_map"] = fixed_fetch

        fixed_submit = _rewrite_action(
            _as_dict(submit_raw), when=FETCH_ACTION, then=SUBMIT_ACTION
        )
        if fixed_submit is not None:
            values["submit_field_map"] = fixed_submit

        if values:
            connection.execute(table.update().where(table.c.id == row_id).values(**values))


def downgrade() -> None:
    # Deliberately empty: the previous state was a swap that silently loses the
    # user's shopping trip, not a configuration worth restoring.
    pass
