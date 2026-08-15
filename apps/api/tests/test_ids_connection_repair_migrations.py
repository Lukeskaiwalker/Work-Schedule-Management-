"""The IDS connection repair migrations, executed against realistic rows.

The suite builds its schema with `Base.metadata.create_all` on SQLite and only
runs alembic on other dialects, so migrations are normally never executed here
at all. That is fine for pure DDL, which the ORM models restate anyway — but
0068/0069/0070 exist *only* to rewrite real rows, so untested they are just
assertions in a docstring.

Each test drives the real `upgrade()` against a hand-built table, because the
value of these migrations is entirely in which rows they decide to touch.

The history they encode is worth keeping straight, since it is the reason
there are three of them:

  0068  keyed on action == WWWSHOP        → missed rows already hand-edited
  0069  keyed on action == WKS            → fixed the action, left the field
                                            names wrong, and the result then
                                            PASSED the swap validator
  0070  keyed on the invented field NAMES → the first predicate keyed on
                                            something no datasheet contains
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest
import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations

VERSIONS = Path(__file__).resolve().parents[1] / "alembic" / "versions"

BROKEN_DEFAULT = {
    "ACTION": "WWWSHOP",
    "USERNAME": "{username}",
    "PASSWORD": "{password}",
    "KUNDENNUMMER": "{customer_number}",
    "HOOK_URL": "{hook_url}",
    "TARGET": "_top",
    "VERSION": "{ids_version}",
}


def _load(filename: str):
    spec = importlib.util.spec_from_file_location(filename, VERSIONS / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture()
def engine(tmp_path: Path):
    """A table with just the columns these migrations touch."""

    engine = sa.create_engine(f"sqlite:///{tmp_path}/ids.db")
    with engine.begin() as conn:
        conn.execute(
            sa.text(
                """CREATE TABLE werkstatt_ids_connections (
                    id INTEGER PRIMARY KEY,
                    charset VARCHAR(32),
                    fetch_field_map JSON,
                    submit_field_map JSON,
                    cart_field_names JSON)"""
            )
        )
    return engine


def _insert(engine, row_id: int, fetch: dict, submit: dict, charset: str = "ISO-8859-1"):
    with engine.begin() as conn:
        conn.execute(
            sa.text(
                "INSERT INTO werkstatt_ids_connections "
                "(id, charset, fetch_field_map, submit_field_map, cart_field_names) "
                "VALUES (:i, :c, :f, :s, '[]')"
            ),
            {"i": row_id, "c": charset, "f": json.dumps(fetch), "s": json.dumps(submit)},
        )


def _run(engine, module) -> None:
    with engine.connect() as conn:
        context = MigrationContext.configure(conn)
        with context.begin_transaction():
            with Operations.context(context):
                module.upgrade()
        conn.commit()


def _read(engine, row_id: int) -> tuple[dict, dict]:
    with engine.connect() as conn:
        row = conn.execute(
            sa.text(
                "SELECT fetch_field_map, submit_field_map "
                "FROM werkstatt_ids_connections WHERE id = :i"
            ),
            {"i": row_id},
        ).one()
    load = lambda v: json.loads(v) if isinstance(v, str) else (v or {})  # noqa: E731
    return load(row[0]), load(row[1])


def _action(field_map: dict) -> str:
    for key, value in field_map.items():
        if str(key).strip().lower() == "action":
            return str(value or "").strip().upper()
    return ""


def test_0068_repairs_an_untouched_broken_default(engine) -> None:
    _insert(engine, 1, BROKEN_DEFAULT, {})
    _run(engine, _load("20260812_0068_ids_connect_real_field_names.py"))

    fetch, submit = _read(engine, 1)
    assert _action(fetch) == "WKE"
    assert fetch["benutzername"] == "{username}"
    assert "USERNAME" not in fetch
    assert _action(submit) == "WKS"
    assert submit["warenkorb"] == "{cart_xml}"


def test_0068_leaves_a_customised_map_alone(engine) -> None:
    """Another shop's spelling of the same three fields must survive."""

    custom = {"action": "WKE", "name_kunde": "{username}", "pw_kunde": "{password}"}
    _insert(engine, 1, custom, {})
    _run(engine, _load("20260812_0068_ids_connect_real_field_names.py"))

    fetch, _ = _read(engine, 1)
    assert fetch == custom


def test_0068_misses_a_row_whose_action_was_hand_edited(engine) -> None:
    """Pins the gap that made a third migration necessary.

    Editing the action is the first thing anyone does when debugging, and it is
    the very field 0068 keyed on — so touching it hid the row from the repair.
    """

    hand_edited = {**BROKEN_DEFAULT, "ACTION": "WKS"}
    _insert(engine, 1, hand_edited, {})
    _run(engine, _load("20260812_0068_ids_connect_real_field_names.py"))

    fetch, _ = _read(engine, 1)
    assert "USERNAME" in fetch, "0068 keyed on the action, so this row was skipped"


def test_0069_unswaps_only_an_exact_inversion(engine) -> None:
    _insert(engine, 1, {"action": "WKS"}, {"action": "WKE"})
    _insert(engine, 2, {"action": "WKE"}, {"action": "WKS"})
    _insert(engine, 3, {"ACTION": "CUSTOM"}, {"action": "OTHER"})
    _run(engine, _load("20260812_0069_ids_swapped_cart_actions.py"))

    assert _action(_read(engine, 1)[0]) == "WKE"
    assert _action(_read(engine, 1)[1]) == "WKS"
    assert _action(_read(engine, 2)[0]) == "WKE"
    assert _action(_read(engine, 3)[0]) == "CUSTOM", "an unknown action is left alone"


def test_0069_alone_leaves_a_row_that_looks_fixed_but_cannot_log_in(engine) -> None:
    """The trap, pinned so it cannot come back.

    After 0069 the action reads WKE and the row satisfies the swap validator,
    while the credentials still travel under names no shop reads. It inspects
    clean and fails silently — which is strictly worse than staying obviously
    broken, and is why the predicate had to move off the action entirely.
    """

    _insert(engine, 1, {**BROKEN_DEFAULT, "ACTION": "WKS"}, {})
    _run(engine, _load("20260812_0069_ids_swapped_cart_actions.py"))

    fetch, _ = _read(engine, 1)
    assert _action(fetch) == "WKE", "looks repaired"
    assert "benutzername" not in fetch, "but the credential name is still wrong"
    assert fetch["USERNAME"] == "{username}"


def test_0070_repairs_the_half_fixed_row(engine) -> None:
    """The state production actually ended up in, after 0068 skipped it and
    0069 corrected only its action."""

    _insert(engine, 1, {**BROKEN_DEFAULT, "ACTION": "WKE"}, {})
    _run(engine, _load("20260812_0070_ids_repair_invented_field_names.py"))

    fetch, _ = _read(engine, 1)
    assert fetch["benutzername"] == "{username}"
    assert fetch["passwort"] == "{password}"
    assert fetch["hook_url"] == "{hook_url}"
    assert fetch["returntarget"] == "_top"
    assert not ({"USERNAME", "PASSWORD", "TARGET"} & set(fetch))


def test_0070_keys_on_field_names_not_the_action(engine) -> None:
    """Whatever the action has been edited to, the invented names still give
    the row away — which is the entire point of this predicate."""

    for row_id, action in enumerate(["WKE", "WKS", "WWWSHOP", "ANYTHING"], start=1):
        _insert(engine, row_id, {**BROKEN_DEFAULT, "ACTION": action}, {})
    _run(engine, _load("20260812_0070_ids_repair_invented_field_names.py"))

    for row_id in range(1, 5):
        fetch, _ = _read(engine, row_id)
        assert fetch["benutzername"] == "{username}", f"row {row_id} not repaired"


def test_0070_leaves_a_genuinely_custom_map_alone(engine) -> None:
    """A wholesaler needing names this code has never seen is the reason the
    map is editable, so an unfamiliar map must never be overwritten."""

    custom = {
        "action": "WKE",
        "name_kunde": "{username}",
        "pw_kunde": "{password}",
        "hookurl": "{hook_url}",
    }
    _insert(engine, 1, custom, {})
    _run(engine, _load("20260812_0070_ids_repair_invented_field_names.py"))

    fetch, _ = _read(engine, 1)
    assert fetch == custom


def test_0070_is_idempotent(engine) -> None:
    _insert(engine, 1, {**BROKEN_DEFAULT}, {})
    module = _load("20260812_0070_ids_repair_invented_field_names.py")
    _run(engine, module)
    first, _ = _read(engine, 1)
    _run(engine, module)
    second, _ = _read(engine, 1)
    assert first == second


# ──────────────────────────────────────────────────────────────────────────
# 0071 — the spec's HTTP parameter names
#
# The fourth repair, and the first whose predicate keys on something that is
# both stable and wrong-by-construction: the field NAMES. 0068 and 0069 both
# keyed on the action VALUE, which is the first thing a human edits while
# debugging, so both skipped the one production row they existed to fix.
#
# What 0070 left behind was a row using the spec's German LABELS. Those look
# authoritative — they are printed in the spec's own parameter table — but the
# table has a second column headed "HTTP Parameter", and only that one goes on
# the wire. Measured against www.unielektro.de: with `hookurl` the shop's
# transmit form points at our hook; with `hook_url` it points at /ids/debug,
# the raw-XML page the crew kept landing on.
# ──────────────────────────────────────────────────────────────────────────

# Exactly what production held after 0070, read from the live database.
LABELS_NOT_PARAMETERS = {
    "action": "WKE",
    "benutzername": "{username}",
    "passwort": "{password}",
    "kundennummer": "{customer_number}",
    "hook_url": "{hook_url}",
    "returntarget": "_top",
    "Version": "{ids_version}",
}


def test_0071_renames_the_labels_to_the_http_parameters(engine) -> None:
    _insert(engine, 1, LABELS_NOT_PARAMETERS, {**LABELS_NOT_PARAMETERS, "action": "WKS"})
    _run(engine, _load("20260814_0071_ids_http_parameter_names.py"))
    fetch, submit = _read(engine, 1)

    assert fetch["hookurl"] == "{hook_url}", "the field the whole loop depends on"
    assert fetch["name_kunde"] == "{username}"
    assert fetch["pw_kunde"] == "{password}"
    assert fetch["kndnr"] == "{customer_number}"
    assert fetch["target"] == "_top"
    assert fetch["action"] == "WKE"
    assert submit["action"] == "WKS", "the direction must survive the rename"

    for gone in ("hook_url", "benutzername", "passwort", "kundennummer", "returntarget"):
        assert gone not in fetch


def test_0071_is_idempotent(engine) -> None:
    """A second run must be a no-op, or a re-deploy would churn the row."""

    _insert(engine, 1, LABELS_NOT_PARAMETERS, LABELS_NOT_PARAMETERS)
    module = _load("20260814_0071_ids_http_parameter_names.py")
    _run(engine, module)
    once, _ = _read(engine, 1)
    _run(engine, module)
    twice, _ = _read(engine, 1)
    assert once == twice


def test_0071_leaves_a_deliberately_customised_row_alone(engine) -> None:
    """The maps are admin-editable because a wholesaler may need something we
    have never seen. A row already using the spec names must not be touched."""

    custom = {
        "action": "WKE",
        "name_kunde": "{username}",
        "hookurl": "{hook_url}",
        "eigenes_feld_vom_grosshaendler": "wert",
    }
    _insert(engine, 1, custom, custom)
    _run(engine, _load("20260814_0071_ids_http_parameter_names.py"))
    fetch, _ = _read(engine, 1)
    assert fetch == custom


def test_0071_does_not_clobber_a_correct_key_that_is_already_present(engine) -> None:
    """Renaming onto an occupied key would silently drop one of the values."""

    both = {"action": "WKE", "hookurl": "{hook_url}", "hook_url": "STALE"}
    _insert(engine, 1, both, both)
    _run(engine, _load("20260814_0071_ids_http_parameter_names.py"))
    fetch, _ = _read(engine, 1)
    assert fetch["hookurl"] == "{hook_url}"


def test_0071_also_repairs_the_first_generation_of_invented_names(engine) -> None:
    """A site that never ran 0068 would still hold the original English names."""

    _insert(engine, 1, BROKEN_DEFAULT, BROKEN_DEFAULT)
    _run(engine, _load("20260814_0071_ids_http_parameter_names.py"))
    fetch, _ = _read(engine, 1)
    assert fetch["name_kunde"] == "{username}"
    assert fetch["pw_kunde"] == "{password}"
    assert fetch["hookurl"] == "{hook_url}"
