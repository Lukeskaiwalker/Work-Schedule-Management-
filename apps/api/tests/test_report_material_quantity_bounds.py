"""A report's material quantity can never take the report down.

A report row prefilled from a task carries the task line's id, and its ``qty``
becomes the line's ``quantity_used`` (an int4 column). ``qty`` is free text
typed on a phone, so it used to be read with ``float()``: "1e20" became an
integer far wider than the column (an OverflowError/DataError at flush, a bare
500 for the whole report) and "inf" raised OverflowError before the database
was even reached.

The rule pinned here: a ``qty`` is read with the same grammar as every other
free-text quantity in the app (``parse_quantity_text``: digits, a decimal comma
or dot, thousands separators), plus the half-typed numbers ``float()`` always
took from a phone keyboard ("6,", "6.", ",5", ".5"). Scientific notation,
inf/nan and any number whose magnitude exceeds MAX_STOCK_QUANTITY are not
quantities. A row whose ``qty`` is not a quantity still names its line, so it
still refers to the task: its line is left exactly as it was (never set to 0,
which would book the whole line back to the shelf), the lines the report does
not mention at all are recorded as unused, and the report itself is filed
normally. (A negative number within the bound still counts as nothing fitted.)

A body that does not fit the report schema at all (``qty`` sent as a JSON
number, a JSON array, no JSON) is the client's mistake: 422/400, never a 500.
"""
from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from app.core.limits import INT32_MAX, MAX_STOCK_QUANTITY
from tests.conftest import auth_headers
from tests.test_task_material_settlement import (
    _article,
    _box,
    _hand_over,
    _materials,
    _movements,
    _pack_article,
    _report,
    _set_status,
    _Site,
    _task,
)


def _row(site: _Site, qty: object) -> dict:
    return {"item": "Wago 221-415", "qty": qty, "unit": "Stk", "task_material_id": site.line["id"]}


@pytest.mark.parametrize(
    "qty",
    ["1e20", "1E20", "inf", "-inf", "Infinity", "nan", "NaN", "-NaN"],
)
def test_qty_that_is_not_a_finite_plain_number_is_ignored(
    client: TestClient, admin_token: str, qty: str
):
    site = _Site(client, admin_token)
    _report(client, admin_token, site.project_id, site.task["id"], [_row(site, qty)])
    # The only row said nothing readable about the crate: nobody has reported.
    assert _materials(client, admin_token, site.task["id"])[0]["quantity_used"] is None


@pytest.mark.parametrize(
    "qty",
    [
        str(MAX_STOCK_QUANTITY + 1),
        "1.000.001,0",
        "9" * 30,
        "4011689123456",  # a scanned EAN in the quantity field
        "-99999999999999999999",
    ],
)
def test_qty_beyond_the_stock_bound_is_ignored(client: TestClient, admin_token: str, qty: str):
    site = _Site(client, admin_token)
    _report(client, admin_token, site.project_id, site.task["id"], [_row(site, qty)])
    assert _materials(client, admin_token, site.task["id"])[0]["quantity_used"] is None


def test_largest_allowed_qty_is_recorded_and_settlement_caps_it(
    client: TestClient, admin_token: str
):
    site = _Site(client, admin_token)
    _report(
        client, admin_token, site.project_id, site.task["id"],
        [_row(site, str(MAX_STOCK_QUANTITY))],
    )
    assert _materials(client, admin_token, site.task["id"])[0]["quantity_used"] == MAX_STOCK_QUANTITY

    _set_status(client, admin_token, site.task["id"], "done")
    # 10 went out; the report cannot write off more than that.
    assert _movements(site.article_id)[2:] == [("correction", 10, site.box["id"])]


@pytest.mark.parametrize(
    ("qty", "expected"),
    [
        ("6", 6),
        (" 6 ", 6),
        ("+6", 6),
        ("6,0", 6),
        ("6.0", 6),
        ("6,4", 6),
        ("2,5", 2),  # round half to even, as round() always did
        ("3,5", 4),
        # Half-typed on a phone; float() read these, so they keep working.
        ("6,", 6),
        ("6.", 6),
        ("+6,", 6),
        (" 6, ", 6),
        (",5", 0),
        (".5", 0),
        ("-,5", 0),
        ("-6.", 0),
        ("1.000.000,0", MAX_STOCK_QUANTITY),
        ("1 000 000", MAX_STOCK_QUANTITY),
        ("-3", 0),
    ],
)
def test_accepted_quantity_formats_keep_working(
    client: TestClient, admin_token: str, qty: str, expected: int
):
    site = _Site(client, admin_token)
    _report(client, admin_token, site.project_id, site.task["id"], [_row(site, qty)])
    assert _materials(client, admin_token, site.task["id"])[0]["quantity_used"] == expected


@pytest.mark.parametrize("qty", [",", ".", "+,", "6,,", "1,5.", ",5,", "ca. 6", "6 Stk"])
def test_prose_and_stray_separators_are_still_not_quantities(
    client: TestClient, admin_token: str, qty: str
):
    site = _Site(client, admin_token)
    _report(client, admin_token, site.project_id, site.task["id"], [_row(site, qty)])
    assert _materials(client, admin_token, site.task["id"])[0]["quantity_used"] is None


class _TwoLines:
    """A crate with two lines on one task: Wago x4 (of 20) and Hager x5 (of 8)."""

    def __init__(self, client: TestClient, admin_token: str):
        self.client, self.token = client, admin_token
        self.hager_article = _article(client, admin_token, "Hager MBN116", 8)
        self.site = _Site(client, admin_token)
        self.box = _box(client, admin_token, "Kiste Zwei Zeilen Grenzwert")
        _pack_article(client, admin_token, self.box["id"], self.site.article_id, 4)
        _pack_article(client, admin_token, self.box["id"], self.hager_article, 5)
        _hand_over(client, admin_token, self.box["id"], self.site.customer_id)
        self.task = _task(
            client, admin_token,
            customer_id=self.site.customer_id,
            project_id=self.site.project_id,
            construction_box_id=self.box["id"],
        )
        self.ids = {row["item_name"]: row["id"] for row in self.lines().values()}

    def lines(self) -> dict[str, dict]:
        return {row["item_name"]: row for row in _materials(self.client, self.token, self.task["id"])}

    def report(self, **qty_by_item: str) -> None:
        rows = [
            {"item": item, "qty": qty, "task_material_id": self.ids[item]}
            for item, qty in qty_by_item.items()
        ]
        _report(self.client, self.token, self.site.project_id, self.task["id"], rows)

    def used(self) -> dict[str, int | None]:
        return {item: row["quantity_used"] for item, row in self.lines().items()}


def test_an_unreadable_row_leaves_its_line_alone(client: TestClient, admin_token: str):
    """Wago "3", Hager "inf": the report is filed, Wago records 3 and Hager is
    left as it was (nobody has reported it) — not 0, which would book every
    Hager in the crate back to the shelf although the fitter kept the row."""
    two = _TwoLines(client, admin_token)
    two.report(**{"Wago 221-415": "3", "Hager MBN116": "inf"})
    assert two.used() == {"Wago 221-415": 3, "Hager MBN116": None}


def test_an_unreadable_row_does_not_book_its_line_back_on_completion(
    client: TestClient, admin_token: str
):
    """The reviewer's case end to end: the Hager line must not come back."""
    two = _TwoLines(client, admin_token)
    two.report(**{"Wago 221-415": "3", "Hager MBN116": "ca. 5"})
    _set_status(client, admin_token, two.task["id"], "done")

    # Nobody said how many Hager were fitted: settled as fully fitted, the
    # reading a crate nobody reported on has always had.
    assert _movements(two.hager_article) == [
        ("intake", 8, None),
        ("checkout", 5, two.box["id"]),
        ("correction", 5, two.box["id"]),
    ]


def test_an_unreadable_row_keeps_an_earlier_report_value(client: TestClient, admin_token: str):
    two = _TwoLines(client, admin_token)
    two.report(**{"Wago 221-415": "4", "Hager MBN116": "2"})
    two.report(**{"Wago 221-415": "3", "Hager MBN116": "1e20"})
    assert two.used() == {"Wago 221-415": 3, "Hager MBN116": 2}


def test_a_readable_row_wins_over_an_unreadable_one_for_the_same_line(
    client: TestClient, admin_token: str
):
    two = _TwoLines(client, admin_token)
    rows = [
        {"item": "Wago 221-415", "qty": "3", "task_material_id": two.ids["Wago 221-415"]},
        {"item": "Hager MBN116", "qty": "4", "task_material_id": two.ids["Hager MBN116"]},
        {"item": "Hager MBN116", "qty": "ca. 5", "task_material_id": two.ids["Hager MBN116"]},
    ]
    _report(client, admin_token, two.site.project_id, two.task["id"], rows)
    assert two.used() == {"Wago 221-415": 3, "Hager MBN116": 4}


def test_a_line_left_out_is_unused_even_when_the_only_row_is_unreadable(
    client: TestClient, admin_token: str
):
    """The fitter deleted Hager (it went back in the crate) and wrote "ca. 3"
    for Wago. The Wago row still names the task, so Hager is recorded as
    unused — the same answer it gets when the Wago row reads "3"."""
    two = _TwoLines(client, admin_token)
    two.report(**{"Wago 221-415": "ca. 3"})
    assert two.used() == {"Wago 221-415": None, "Hager MBN116": 0}


@pytest.mark.parametrize("material_id", [INT32_MAX + 1, 10**20, 0, -1])
def test_task_material_id_outside_the_id_range_is_ignored(
    client: TestClient, admin_token: str, material_id: int
):
    """An id no int4 row can have refers to no line; it must not reach the query."""
    site = _Site(client, admin_token)
    _report(
        client, admin_token, site.project_id, site.task["id"],
        [{"item": "Wago 221-415", "qty": "6", "task_material_id": material_id}],
    )
    assert _materials(client, admin_token, site.task["id"])[0]["quantity_used"] is None


def test_qty_sent_as_a_json_number_is_a_422_not_a_500(client: TestClient, admin_token: str):
    """``qty`` is text; a client that sends a number gets told so."""
    site = _Site(client, admin_token)
    resp = client.post(
        f"/api/projects/{site.project_id}/construction-reports",
        headers=auth_headers(admin_token),
        json={
            "report_date": "2026-09-08",
            "payload": {
                "workers": [{"name": "Monteur"}],
                "materials_consumed": [_row(site, 1e20)],
                "source_task_id": site.task["id"],
            },
        },
    )
    assert resp.status_code == 422, resp.text
    assert _materials(client, admin_token, site.task["id"])[0]["quantity_used"] is None


def test_project_material_summary_survives_a_huge_report_qty(client: TestClient, admin_token: str):
    """The project's material summary sums the same ``qty`` text; a value
    beyond the stock bound is listed as a note, not summed into the total."""
    site = _Site(client, admin_token)
    huge = "9" * 400
    resp = client.post(
        f"/api/projects/{site.project_id}/construction-reports",
        headers=auth_headers(admin_token),
        json={
            "report_date": "2026-09-08",
            "payload": {
                "workers": [{"name": "Monteur"}],
                "materials": [
                    {"item": "Kabelbinder", "qty": huge, "unit": "Stk"},
                    {"item": "Kabelbinder", "qty": "5", "unit": "Stk"},
                ],
            },
        },
    )
    assert resp.status_code == 200, resp.text

    summary = client.get(
        f"/api/projects/{site.project_id}/materials", headers=auth_headers(admin_token)
    )
    assert summary.status_code == 200, summary.text
    rows = [row for row in summary.json() if row.get("item") == "Kabelbinder"]
    assert len(rows) == 1
    assert rows[0]["quantity_total"] == 5
    assert rows[0]["quantity_notes"] == [huge]


def test_project_material_summary_reads_half_typed_numbers_like_the_write_back(
    client: TestClient, admin_token: str
):
    site = _Site(client, admin_token)
    resp = client.post(
        f"/api/projects/{site.project_id}/construction-reports",
        headers=auth_headers(admin_token),
        json={
            "report_date": "2026-09-08",
            "payload": {
                "workers": [{"name": "Monteur"}],
                "materials": [
                    {"item": "Kabelbinder", "qty": "6,", "unit": "Stk"},
                    {"item": "Kabelbinder", "qty": ",5", "unit": "Stk"},
                ],
            },
        },
    )
    assert resp.status_code == 200, resp.text

    summary = client.get(
        f"/api/projects/{site.project_id}/materials", headers=auth_headers(admin_token)
    )
    assert summary.status_code == 200, summary.text
    rows = [row for row in summary.json() if row.get("item") == "Kabelbinder"]
    assert len(rows) == 1
    assert rows[0]["quantity_total"] == 6.5
    assert rows[0]["quantity_notes"] == []


def test_multipart_report_with_a_numeric_qty_is_a_422_not_a_500(
    client: TestClient, admin_token: str
):
    site = _Site(client, admin_token)
    resp = client.post(
        f"/api/projects/{site.project_id}/construction-reports",
        headers=auth_headers(admin_token),
        data={
            "report_date": "2026-09-08",
            "payload": json.dumps(
                {
                    "workers": [{"name": "Monteur"}],
                    "materials_consumed": [_row(site, 6)],
                    "source_task_id": site.task["id"],
                }
            ),
        },
        # Any file part makes the body multipart; this one is not an image.
        files=[("attachment", ("note.txt", b"x", "text/plain"))],
    )
    assert resp.status_code == 422, resp.text
    assert _materials(client, admin_token, site.task["id"])[0]["quantity_used"] is None


@pytest.mark.parametrize(("body", "status"), [(b"not json", 400), (b"[1, 2]", 422)])
def test_report_body_that_is_not_a_json_object_is_refused_not_a_500(
    client: TestClient, admin_token: str, body: bytes, status: int
):
    site = _Site(client, admin_token)
    resp = client.post(
        f"/api/projects/{site.project_id}/construction-reports",
        headers={**auth_headers(admin_token), "Content-Type": "application/json"},
        content=body,
    )
    assert resp.status_code == status, resp.text


# ── Materialbedarf: the report's other quantity write ───────────────────────
#
# ``materials_needed[].qty`` / ``unit`` and the article number read from the
# ``office_material_need`` text become a ProjectMaterialNeed (String(64),
# String(64), String(160)). SQLite ignores VARCHAR lengths, so these tests
# check the stored lengths against the columns themselves: on PostgreSQL a
# longer value raised StringDataRightTruncation at the report's commit — a
# bare 500, and the fitter's whole report lost.


def _stored_needs(project_id: int) -> list:
    from sqlalchemy import select

    from app.core.db import SessionLocal
    from app.models.entities import ProjectMaterialNeed

    with SessionLocal() as db:
        rows = db.scalars(
            select(ProjectMaterialNeed)
            .where(ProjectMaterialNeed.project_id == project_id)
            .order_by(ProjectMaterialNeed.id)
        ).all()
        db.expunge_all()
        return list(rows)


def _column_width(name: str) -> int:
    from app.models.entities import ProjectMaterialNeed

    return ProjectMaterialNeed.__table__.c[name].type.length


def _report_needs(client: TestClient, admin_token: str, project_id: int, **payload) -> None:
    resp = client.post(
        f"/api/projects/{project_id}/construction-reports",
        headers=auth_headers(admin_token),
        json={
            "report_date": "2026-09-08",
            "payload": {"workers": [{"name": "Monteur"}], **payload},
        },
    )
    assert resp.status_code == 200, resp.text


def test_material_need_rows_fit_their_columns(client: TestClient, admin_token: str):
    """Structured rows: a 200-character qty and unit, and an article number
    of 300 characters carried over from the serialised text."""
    site = _Site(client, admin_token)
    qty, unit, article_no = "9" * 200, "m" * 200, "A1" * 150
    _report_needs(
        client, admin_token, site.project_id,
        materials_needed=[{"item": "NYM-J 5x6", "qty": qty, "unit": unit}],
        office_material_need=f"NYM-J 5x6 - 25 m - ArtNr {article_no}",
    )

    (need,) = _stored_needs(site.project_id)
    assert need.quantity == qty[: _column_width("quantity")]
    assert need.unit == unit[: _column_width("unit")]
    assert need.article_no == article_no[: _column_width("article_no")]


def test_material_need_from_the_text_alone_fits_its_columns(
    client: TestClient, admin_token: str
):
    """The office_material_need text path: ``_QTY_UNIT`` takes any run of
    digits, and the article tail any text."""
    site = _Site(client, admin_token)
    qty, article_no = "1" * 100, "X" * 300
    _report_needs(
        client, admin_token, site.project_id,
        office_material_need=f"Kabel - {qty} m - ArtNr {article_no}",
    )

    (need,) = _stored_needs(site.project_id)
    assert need.item == "Kabel"
    assert need.quantity == qty[: _column_width("quantity")]
    assert need.unit == "m"
    assert need.article_no == article_no[: _column_width("article_no")]


def test_material_need_within_its_columns_is_stored_unchanged(
    client: TestClient, admin_token: str
):
    site = _Site(client, admin_token)
    _report_needs(
        client, admin_token, site.project_id,
        materials_needed=[{"item": "NYM-J 5x6", "qty": "25", "unit": "m", "note": "für Halle 2"}],
        office_material_need="NYM-J 5x6 - 25 m - ArtNr 11102138",
    )

    (need,) = _stored_needs(site.project_id)
    assert (need.item, need.quantity, need.unit, need.article_no, need.notes) == (
        "NYM-J 5x6", "25", "m", "11102138", "für Halle 2",
    )


@pytest.mark.parametrize("source_task_id", [INT32_MAX + 1, 10**20])
def test_source_task_id_outside_the_id_range_is_a_400_not_a_500(
    client: TestClient, admin_token: str, source_task_id: int
):
    """An id wider than the int4 column used to reach ``db.get(Task, ...)``
    — an OverflowError on SQLite, a DataError on PostgreSQL, a 500. It names
    no task, so it gets the same answer as any task outside the project."""
    site = _Site(client, admin_token)
    resp = client.post(
        f"/api/projects/{site.project_id}/construction-reports",
        headers=auth_headers(admin_token),
        json={
            "report_date": "2026-09-08",
            "payload": {"workers": [{"name": "Monteur"}], "source_task_id": source_task_id},
        },
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["detail"] == "source_task_id is not valid for this project"
