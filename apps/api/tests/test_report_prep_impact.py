"""The read-only deploy check for round 4 (docs/PANEL_ENCLOSURE_R4.md §6, §13).

``scripts/report_prep_impact.py`` runs in the staged image before the swap:
the cabinet preparation adds lines to every cabinet board, built ones
included (R4-4), and the owner reads what that means first. It must only read
(not one INSERT, UPDATE or DELETE), and it prints counts, article numbers and
catalogue codes only: the repo is public and the output lands in deploy
notes, so no board, customer, line or article name may appear. Every board
here is invented.
"""

from __future__ import annotations

from fastapi.testclient import TestClient
from sqlalchemy import event

from app.core.db import SessionLocal, engine
from app.models.schaltplan import PanelCatalogEntry
from scripts.report_prep_impact import REPORT_CODES, impact_report, render
from scripts.write_enclosure_fixtures import busbar_gap_zb34s, control_ehz_zb33s, meter_dist_zb33s
from tests.panel_enclosure_helpers import article, auth, create_panel, customer, store_directly

MAPPING = "/api/schaltplan/material/mapping"
SECRETS = ("Familie Vertraulich", "Geheimweg", "Keller", "Kaputt", "ZS1", "ZS9", "nachbestellt", "Kabelbinder",
           "Testartikel", "SP-T", "row-", "dev-", "mod-")


def _boards(client: TestClient, token: str) -> dict[str, dict]:
    customer_id = customer(client, token, "Familie Vertraulich")
    boards = {"control": (control_ehz_zb33s(), "Haus Geheimweg 3"), "meter": (meter_dist_zb33s(), "Haus Geheimweg 5"),
              "gap": (busbar_gap_zb34s(), "Haus Geheimweg 7"), "legacy": (None, "Unterverteilung Keller")}
    panels = {key: create_panel(client, token, document, customer_id=customer_id, name=name, designation=f"ZS{index}")
              for index, (key, (document, name)) in enumerate(boards.items(), start=1)}
    broken = create_panel(client, token, None, customer_id=customer_id, name="Kaputt", designation="ZS9")
    store_directly(broken["id"], {"version": 1, "rows": "kein Array", "enclosure": {"code": 7, "modules": "x"}})
    return {**panels, "broken": broken}


def _manual(client: TestClient, token: str, panel_id: int, **line) -> None:
    resp = client.post(f"/api/schaltplan/panels/{panel_id}/material/manual", headers=auth(token), json=line)
    assert resp.status_code == 200, resp.text


def _book(client: TestClient, token: str, panel_id: int, article_id: int) -> None:
    resp = client.post(f"/api/schaltplan/panels/{panel_id}/material/book", headers=auth(token),
                       json={"article_id": article_id, "quantity": 1})
    assert resp.status_code == 200, resp.text


def _report() -> dict:
    with SessionLocal() as db:
        return impact_report(db)


def test_the_report_counts_boards_gaining_each_article_and_those_already_booked(
    client: TestClient, admin_token: str
) -> None:
    panels = _boards(client, admin_token)
    ties = article("Kabelbinder 200 mm (Testartikel)", stock=50)
    _book(client, admin_token, panels["meter"]["id"], ties)  # meter_dist was picked before round 4
    with SessionLocal() as db:
        db.add(PanelCatalogEntry(code="ZH53XS", entry_type="module", spec=None, is_archived=False))
        db.add(PanelCatalogEntry(code="ZH53X3", entry_type="module", spec=None, is_archived=False))  # not R4-9's
        db.commit()

    report = _report()
    assert (report["boards"], report["cabinet_boards"], report["unreadable_boards"]) == (5, 3, 1)
    articles = report["articles"]
    # Every cabinet board has a main busbar: the infeed adapter on all three; meter_dist is the booked one.
    assert articles["K96ESA5"] == {"boards": 3, "booked": 1}
    assert articles["ZY3N2SA"] == {"boards": 2, "booked": 1}
    assert articles["ZY3N2LS"] == {"boards": 1, "booked": 0}  # busbar_gap: supply override LS
    assert articles["ZZ45WAN100"] == {"boards": 2, "booked": 1}
    assert "ZZ45WAN150" not in articles  # busbar_gap switched its network lead off
    for key in ("ZZ55SAVE", "249-116", "2002-1671", "2002-1692", "wire:h07vk:2.5:braun", "prep:luesterklemme"):
        assert articles[key] == {"boards": 1, "booked": 0}, key
    assert list(articles) == sorted(articles)
    # meter_dist and busbar_gap have a meter field and no block; control_ehz has one.
    assert report["boards_without_control_block"] == 2
    assert report["catalog_rows"] == ["ZH53XS"]
    assert set(REPORT_CODES) == {"ZH3ES5", "ZH3ES5RK", "ZH53XS", "ZH53XSRK"}


def test_the_report_counts_hand_added_lines_for_a_part_the_board_now_derives(
    client: TestClient, admin_token: str
) -> None:
    """A board before round 4 got its K96ESA5 or its control wires by hand. The
    derived line now doubles the article and takes the hand line's bookings:
    counted (text naming the number, or the article a mapping resolves), never named."""
    panels = _boards(client, admin_token)
    wire = article("Aderleitung braun (Testartikel)", stock=100)
    ties = article("Kabelbinder 200 mm (Testartikel)", stock=50)
    assert client.put(MAPPING, headers=auth(admin_token),
                      json={"key": "wire:h07vk:2.5:braun", "article_id": wire}).status_code == 200
    control, gap = panels["control"]["id"], panels["gap"]["id"]
    _manual(client, admin_token, control, label="Einspeiseadapter K96ESA5 nachbestellt", quantity=1)
    _manual(client, admin_token, control, article_id=wire, quantity=6)
    _manual(client, admin_token, control, article_id=ties, quantity=10)
    _manual(client, admin_token, control, label="K96ESA5X Sonderteil nachbestellt", quantity=1)  # a longer code
    _manual(client, admin_token, gap, label="Patchkabel ZZ45WAN150 nachbestellt", quantity=1)  # its network is off

    report = _report()
    assert (report["boards_with_manual_lines_for_prep"], report["manual_lines_for_prep"]) == (1, 2)
    text = render(report)
    assert "Handzeilen" in text and "(2 Zeilen)" in text
    for secret in SECRETS:
        assert secret not in text, secret


def test_the_report_only_reads_and_names_nothing(client: TestClient, admin_token: str) -> None:
    panels = _boards(client, admin_token)
    statements: list[str] = []

    def remember(_conn, _cursor, statement, *_args) -> None:
        statements.append(statement.lstrip().split(None, 1)[0].upper())

    event.listen(engine, "before_cursor_execute", remember)
    try:
        text = render(_report())
    finally:
        event.remove(engine, "before_cursor_execute", remember)
    assert statements and set(statements) <= {"SELECT", "BEGIN", "ROLLBACK", "PRAGMA"}, set(statements)
    for secret in (*SECRETS, *(panel["panel_number"] for panel in panels.values())):
        assert secret not in text, secret
    assert "Schrankpläne: 3" in text
    assert "K96ESA5: 3 (davon 0 mit gebuchtem Material)" in text
    assert "Katalogzeilen zu ZH3ES5, ZH3ES5RK, ZH53XS, ZH53XSRK" in text and text.rstrip().endswith("keine")
