"""The read-only deploy check for round 2 (docs/PANEL_ENCLOSURE_R2.md §16).

``scripts/report_terminal_impact.py`` runs on production before the deploy.
It must only read (not one INSERT, UPDATE or DELETE), and it prints counts
and catalogue codes only: the repo is public and the output lands in deploy
notes, so no board, customer or device name may appear. Every board here is
invented.
"""

from __future__ import annotations

from fastapi.testclient import TestClient
from sqlalchemy import event

from app.core.db import SessionLocal, engine
from app.models.schaltplan import PanelCatalogEntry
from scripts.report_terminal_impact import impact_report, render
from scripts.write_enclosure_fixtures import (
    dev,
    document,
    fi,
    ls,
    meter_dist_zb33s,
    module,
    row,
    terminals_rk_zb53s,
    terminals_zb34s,
)
from tests.panel_enclosure_helpers import article, auth, create_panel, customer, store_directly


def _boards(client: TestClient, token: str) -> list[dict]:
    customer_id = customer(client, token, "Familie Vertraulich")
    boards = ((terminals_zb34s(), "Haus Geheimweg 7"), (meter_dist_zb33s(), "Haus Geheimweg 9"),
              (terminals_rk_zb53s(), "Haus Geheimweg 11"), (None, "Unterverteilung Keller"))
    panels = [create_panel(client, token, document, customer_id=customer_id, name=name, designation=f"ZS{index}")
              for index, (document, name) in enumerate(boards, start=1)]
    broken = create_panel(client, token, None, customer_id=customer_id, name="Kaputt", designation="ZS9")
    store_directly(broken["id"], {"version": 1, "rows": "kein Array", "enclosure": {"code": 7, "modules": "x"}})
    return [*panels, broken]


def test_the_report_counts_reserved_rows_renumbered_boards_and_rk_placements(
    client: TestClient, admin_token: str
) -> None:
    _boards(client, admin_token)
    with SessionLocal() as db:
        db.add(PanelCatalogEntry(code="ZU37RK", entry_type="module", spec=None, is_archived=False))
        db.commit()
    with SessionLocal() as db:
        report = impact_report(db)
    assert report == {
        "boards": 5,
        "cabinet_boards": 3,
        "boards_with_devices_on_terminal_rails": 1,
        "rows_with_devices_on_terminal_rails": 2,
        "boards_renumbered": 1,
        "rk_placements": 3,  # the ZU37RK, and the ZU59RK and ZH53XSRK of the second board
        "unreadable_boards": 1,
        "boards_with_manual_lines_for_new_parts": 0,
        "manual_lines_for_new_parts": 0,
        "boards_renumbered_with_bookings": 0,
        "catalog_rows": ["ZU37RK"],
    }


def test_the_report_only_reads_and_names_nothing(client: TestClient, admin_token: str) -> None:
    panels = _boards(client, admin_token)
    statements: list[str] = []

    def remember(_conn, _cursor, statement, *_args) -> None:
        statements.append(statement.lstrip().split(None, 1)[0].upper())

    event.listen(engine, "before_cursor_execute", remember)
    try:
        with SessionLocal() as db:
            text = render(impact_report(db))
    finally:
        event.remove(engine, "before_cursor_execute", remember)
    assert statements and set(statements) <= {"SELECT", "BEGIN", "ROLLBACK", "PRAGMA"}, set(statements)
    for secret in ("Familie Vertraulich", "Geheimweg", "Keller", "Kaputt", "ZS1", "ZS9", "F1", "row-old1", "dev-",
                   *(panel["panel_number"] for panel in panels)):
        assert secret not in text, secret
    assert "Schrankpläne: 3" in text


def test_a_placeholder_alone_on_a_terminal_rail_is_no_reserved_row(client: TestClient, admin_token: str) -> None:
    # A pre-R2 board kept its strip space on r1 with a hand-placed "Reihenklemme N/PE":
    # a placeholder, not counted (§3.6), so the board gets no warning and no line here.
    board = document("ZB32S", [module("mod-v", "ZU37KS", 0, {"r1": "row-p", "r3": "row-r3"})], [
        row("row-p", "F1 · Verteiler 1", [dev("dev-pl", "terminal", label="Reihenklemme N/PE")]),
        row("row-r3", "F1 · Verteiler 3", [fi("dev-f1", "F1"), ls("dev-f1-1", "F1.1", "1", "Licht", terminal_block=True)]),
    ])
    create_panel(client, admin_token, board)
    with SessionLocal() as db:
        report = impact_report(db)
    assert (report["cabinet_boards"], report["boards_with_devices_on_terminal_rails"],
            report["rows_with_devices_on_terminal_rails"]) == (1, 0, 0)


def _manual(client: TestClient, token: str, panel_id: int, **line) -> None:
    resp = client.post(f"/api/schaltplan/panels/{panel_id}/material/manual", headers=auth(token), json=line)
    assert resp.status_code == 200, resp.text


def _book(client: TestClient, token: str, panel_id: int, article_id: int) -> None:
    resp = client.post(f"/api/schaltplan/panels/{panel_id}/material/book", headers=auth(token),
                       json={"article_id": article_id, "quantity": 1})
    assert resp.status_code == 200, resp.text


def test_the_report_counts_hand_added_lines_the_list_now_derives_and_booked_renumbered_boards(
    client: TestClient, admin_token: str
) -> None:
    """Review UPG-1 and UPG-2. A cabinet board on v2.15.0 listed no end plate
    and no U84T, so the Werkstatt added them by hand; round 2 derives them, the
    hand line doubles the article and its booked pieces move to the derived
    line. And a board whose AAR circuit had ``terminal_block`` plans fewer WAGO
    parts now, so what was booked shows "zu viel". Both are counted, nothing
    named, so the deploy session can clean up and warn before the next pick."""
    plate = article("WAGO 2016-7691 - Abschlussplatte grau", stock=5, manufacturer="WAGO")
    rail_set = article("Isolierstück Hutschiene", stock=5, number="SP-ISO1", ean="4010330552465")
    ties = article("Kabelbinder 200 mm", stock=50)
    customer_id = customer(client, admin_token, "Familie Vertraulich")
    booked = create_panel(client, admin_token, terminals_zb34s(), customer_id=customer_id, designation="ZS1")
    create_panel(client, admin_token, terminals_zb34s(), customer_id=customer_id, designation="ZS2")  # nothing booked
    _manual(client, admin_token, booked["id"], article_id=plate, quantity=1)
    _manual(client, admin_token, booked["id"], article_id=rail_set, quantity=2)
    _manual(client, admin_token, booked["id"], label="Platte 2003-7692 für Schiene oben", quantity=3)
    _manual(client, admin_token, booked["id"], article_id=ties, quantity=10)
    _book(client, admin_token, booked["id"], plate)
    # This board plans no 2016-7691, so its hand-added plate doubles nothing; it
    # has a booking, but it is not renumbered.
    other = create_panel(client, admin_token, meter_dist_zb33s(), customer_id=customer_id, designation="ZS3")
    _manual(client, admin_token, other["id"], article_id=plate, quantity=1)
    _book(client, admin_token, other["id"], ties)

    with SessionLocal() as db:
        report = impact_report(db)
    assert (report["boards_renumbered"], report["boards_renumbered_with_bookings"]) == (2, 1)
    assert (report["boards_with_manual_lines_for_new_parts"], report["manual_lines_for_new_parts"]) == (1, 3)
    text = render(report)
    assert "Handzeilen" in text and "(3 Zeilen)" in text and "nicht zurückbuchen: 1" in text
    for secret in ("Abschlussplatte", "Isolierstück", "Kabelbinder", "Schiene oben", "SP-ISO1", "4010330552465"):
        assert secret not in text, secret
