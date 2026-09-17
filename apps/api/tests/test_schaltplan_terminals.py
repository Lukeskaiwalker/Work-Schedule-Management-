"""Reihenklemmen — the WAGO terminal sequence derived per FI group.

Twin of ``apps/web/src/test/schaltplanTerminals.test.ts``: the same fixtures,
the same expected part sequences, the same font sizes. The derivation lives
in TypeScript (live tab, print preview) and in Python (print job, PDF), and
the two test files are what keep them from drifting — a rule changed on one
side only turns the other side's test red.

The endpoint tests print through the existing marking-strip path: one job
per FI group on the 2009-110, cut marks at the terminals' real pitch, one
font size across the board.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.services.schaltplan_layout import font_size_for_fits, validate_document
from app.services.schaltplan_pdf_terminals import _COLUMNS, column_titles, row_values
from app.services.schaltplan_terminal_rules import (
    TERMINAL_PARTS,
    is_terminal_eligible,
    outgoing_part_for_poles,
)
from app.services.schaltplan_terminals import (
    TERMINAL_SEG_PAD_DOTS,
    derive_terminals,
    terminal_bom,
    terminal_counts,
    terminal_font_size,
    terminal_group_title,
    terminal_strips,
    unverified_terminal_parts,
)
from test_schaltplan import (
    _at_sizes,
    _auth,
    _capture_label_jobs,
    _configure_label_printer,
    _create_panel,
    _customer,
    _device,
    _document,
    _jobs,
    _pdf_text,
    _q_length,
)


def _tb(device_id: str, kind: str, **overrides) -> dict:
    """A device that ends on a Reihenklemme."""
    return _device(device_id, kind, terminal_block=True, **overrides)


def _rows(*rows: tuple[str, str, list[dict]]) -> dict:
    document = _document([])
    document["rows"] = [
        {"id": row_id, "label": label, "slots": 12, "devices": devices} for row_id, label, devices in rows
    ]
    return document


def _standard_board() -> dict:
    return _rows(
        (
            "r1",
            "Reihe 1",
            [
                _device("f1", "rcd", designation="F1", poles=4),
                _tb("f11", "mcb", designation="F1.1", circuit="1"),
                _tb("f12", "mcb", designation="F1.2", circuit="2"),
                _tb("f13", "mcb", designation="F1.3", circuit="3"),
                _tb("w1", "wallbox", designation="F1.4", circuit="4", poles=3),
                _device("f15", "mcb", designation="F1.5", circuit="5"),
            ],
        )
    )


def _single3p_board() -> dict:
    return _rows(
        (
            "r1",
            "Reihe 1",
            [
                _device("f2", "rcd", designation="F2", poles=4),
                _tb("w2", "wallbox", designation="F2.1", circuit="9", poles=3),
            ],
        )
    )


def _two_rcd_board() -> dict:
    return _rows(
        (
            "r1",
            "Reihe 1",
            [
                _device("f1", "rcd", designation="F1", poles=4),
                _tb("a", "mcb", designation="F1.1", circuit="1"),
                _device("f2", "rcd", designation="F2", poles=4),
                _tb("b", "mcb", designation="F2.1", circuit="2"),
            ],
        )
    )


def _part_ids(groups: list[dict], index: int = 0) -> list[str]:
    return [entry["part_id"] for entry in groups[index]["terminals"]]


# ── Rules and part table ─────────────────────────────────────────────────────


def test_only_mcb_protected_outgoing_kinds_are_eligible():
    for kind in ("mcb", "wallbox", "sub_feed", "pv"):
        assert is_terminal_eligible({"kind": kind})
    for kind in ("rcbo", "fuse", "contactor", "rcd", "spd", "blank", "terminal"):
        assert not is_terminal_eligible({"kind": kind})


def test_poles_map_to_the_two_etagenklemmen():
    assert outgoing_part_for_poles(1) == "2003-7641"
    assert outgoing_part_for_poles(2) == "2003-7641"
    assert outgoing_part_for_poles(3) == "2003-7642"
    assert outgoing_part_for_poles(4) == "2003-7642"


def test_part_table_carries_the_looked_up_widths_and_flags():
    assert TERMINAL_PARTS["2003-7641"].width_mm == 5.2
    assert TERMINAL_PARTS["2003-7642"].width_mm == 5.2
    assert TERMINAL_PARTS["2016-7714"].width_mm == 12
    assert TERMINAL_PARTS["2016-7604"].width_mm == 12
    assert TERMINAL_PARTS["2016-7601"].width_mm == 12
    assert TERMINAL_PARTS["2009-305"].width_mm == 7.5
    assert not TERMINAL_PARTS["2009-305"].marker
    assert not TERMINAL_PARTS["2016-7606"].marker
    assert not TERMINAL_PARTS["2016-7606"].verified
    verified = sorted(part.id for part in TERMINAL_PARTS.values() if part.verified)
    assert verified == sorted(["2003-7641", "2003-7642", "2009-305", "2016-7601", "2016-7604", "2016-7714"])
    assert all(part.source.startswith("https://") for part in TERMINAL_PARTS.values())


# ── Derivation ───────────────────────────────────────────────────────────────


def test_standard_group_feed_per_outgoing_by_poles_end_clamp():
    groups = derive_terminals(_standard_board())
    assert len(groups) == 1
    group = groups[0]
    assert group["group_id"] == "f1"
    assert group["variant"] == "standard"
    assert group["rail_label"] == "Reihe 1"
    assert group["head_device"]["designation"] == "F1"
    assert _part_ids(groups) == [
        "2016-7714",
        "2003-7641",
        "2003-7641",
        "2003-7641",
        "2003-7642",
        "2009-305",
    ]
    assert [entry["position"] for entry in group["terminals"]] == [1, 2, 3, 4, 5, 6]


def test_standard_group_labels():
    group = derive_terminals(_standard_board())[0]
    feed, first, _, _, wallbox, end = group["terminals"]
    assert feed["device_id"] == "f1"
    assert (feed["label_bmk"], feed["label_circuit"], feed["pole"], feed["width_mm"]) == ("F1", "F1", None, 12)
    assert (first["device_id"], first["label_bmk"], first["label_circuit"], first["width_mm"]) == ("f11", "F1.1", "1", 5.2)
    assert (wallbox["device_id"], wallbox["part_id"], wallbox["label_bmk"], wallbox["label_circuit"]) == (
        "w1", "2003-7642", "F1.4", "4",
    )
    assert (end["device_id"], end["label_bmk"], end["label_circuit"], end["marker"]) == (None, "", "", False)


def test_group_without_terminal_devices_emits_nothing():
    document = _rows(("r1", "Reihe 1", [_device("f1", "rcd", designation="F1"), _device("a", "mcb", designation="F1.1")]))
    assert derive_terminals(document) == []


def test_single_3pole_outgoing_gets_feed_pole_terminals_and_2016_end():
    groups = derive_terminals(_single3p_board())
    assert len(groups) == 1
    assert groups[0]["variant"] == "single3p"
    assert _part_ids(groups) == ["2016-7604", "2016-7601", "2016-7601", "2016-7601", "2016-7606"]
    assert [entry["pole"] for entry in groups[0]["terminals"]] == [None, "L1", "L2", "L3", None]
    pole = groups[0]["terminals"][1]
    assert (pole["device_id"], pole["label_bmk"], pole["label_circuit"], pole["width_mm"]) == ("w2", "L1", "L1", 12)


def test_single_4pole_outgoing_gets_four_pole_terminals_with_n():
    document = _rows(
        (
            "r1",
            "Reihe 1",
            [
                _device("f3", "rcd", designation="F3", poles=4),
                _tb("u1", "sub_feed", designation="F3.1", circuit="12", poles=4),
            ],
        )
    )
    groups = derive_terminals(document)
    assert _part_ids(groups) == ["2016-7604", "2016-7601", "2016-7601", "2016-7601", "2016-7601", "2016-7606"]
    assert [entry["pole"] for entry in groups[0]["terminals"]] == [None, "L1", "L2", "L3", "N", None]
    assert [f for f in validate_document(document) if "polig" in f["message"]] == []


def test_single_1pole_outgoing_stays_standard():
    document = _rows(
        ("r1", "Reihe 1", [_device("f1", "rcd", designation="F1", poles=4), _tb("a", "mcb", designation="F1.1", circuit="1")])
    )
    groups = derive_terminals(document)
    assert groups[0]["variant"] == "standard"
    assert _part_ids(groups) == ["2016-7714", "2003-7641", "2009-305"]


def test_group_spanning_two_rails_gets_one_end_element_in_physical_order():
    document = _rows(
        (
            "r1",
            "Reihe 1",
            [
                _device("f1", "rcd", designation="F1", poles=4),
                _tb("a", "mcb", designation="F1.1", circuit="1"),
                _tb("b", "mcb", designation="F1.2", circuit="2"),
            ],
        ),
        ("r2", "Reihe 2", [_tb("c", "mcb", designation="F1.3", circuit="3"), _tb("d", "mcb", designation="F1.4", circuit="4")]),
    )
    groups = derive_terminals(document)
    assert len(groups) == 1
    assert groups[0]["rail_label"] == "Reihe 1"
    assert [entry["device_id"] for entry in groups[0]["terminals"]] == ["f1", "a", "b", "c", "d", None]
    assert _part_ids(groups).count("2009-305") == 1


def test_two_rcds_on_one_rail_close_separately():
    groups = derive_terminals(_two_rcd_board())
    assert [group["group_id"] for group in groups] == ["f1", "f2"]
    assert _part_ids(groups, 0) == ["2016-7714", "2003-7641", "2009-305"]
    assert _part_ids(groups, 1) == ["2016-7714", "2003-7641", "2009-305"]


def test_group_without_rcd_prints_only_per_mcb_terminals_and_reports_it():
    document = _rows(
        (
            "r1",
            "Reihe 1",
            [
                _device("q1", "hauptschalter", designation="Q1", poles=3),
                _tb("a", "mcb", designation="F0.1", circuit="1"),
                _tb("b", "mcb", designation="F0.2", circuit="2"),
            ],
        )
    )
    groups = derive_terminals(document)
    assert groups[0]["variant"] == "no_rcd"
    assert _part_ids(groups) == ["2003-7641", "2003-7641"]
    assert {
        "level": "info",
        "scope": "q1",
        "message": "Gruppe Q1: Abgänge mit Reihenklemme ohne FI — Einspeiseklemme nicht abgeleitet",
    } in validate_document(document)


def test_terminal_before_any_head_lands_in_the_supply_group():
    document = _rows(("r1", "Reihe 1", [_tb("a", "mcb", designation="F0.1", circuit="1")]))
    groups = derive_terminals(document)
    group = groups[0]
    assert (group["group_id"], group["head_device"], group["rail_label"], group["variant"]) == ("supply", None, "—", "no_rcd")
    assert terminal_group_title(group) == "Einspeisung"
    assert {
        "level": "info",
        "scope": "",
        "message": "Gruppe Einspeisung: Abgänge mit Reihenklemme ohne FI — Einspeiseklemme nicht abgeleitet",
    } in validate_document(document)


def test_rcbo_and_fuse_are_ignored_even_with_the_flag():
    document = _rows(
        (
            "r1",
            "Reihe 1",
            [
                _device("f1", "rcd", designation="F1", poles=4),
                _tb("x", "rcbo", designation="F1.1", circuit="1", poles=2),
                _tb("s", "fuse", designation="F9", poles=3),
            ],
        )
    )
    assert derive_terminals(document) == []
    assert [f for f in validate_document(document) if "Reihenklemme" in f["message"] or "polig" in f["message"]] == []


def test_two_pole_breaker_is_derived_as_one_pole_and_reported():
    document = _rows(
        (
            "r1",
            "Reihe 1",
            [
                _device("f1", "rcd", designation="F1", poles=4),
                _tb("a", "mcb", designation="F1.1", circuit="1", poles=2),
                _tb("b", "mcb", designation="F1.2", circuit="2"),
            ],
        )
    )
    assert _part_ids(derive_terminals(document)) == ["2016-7714", "2003-7641", "2003-7641", "2009-305"]
    assert {"level": "info", "scope": "a", "message": "F1.1: 2-polig — Klemme wie 1-polig abgeleitet"} in validate_document(
        document
    )


def test_four_pole_outgoing_in_a_standard_group_is_derived_as_three_pole_and_reported():
    document = _rows(
        (
            "r1",
            "Reihe 1",
            [
                _device("f1", "rcd", designation="F1", poles=4),
                _tb("a", "mcb", designation="F1.1", circuit="1"),
                _tb("u", "sub_feed", designation="F1.2", circuit="2", poles=4),
            ],
        )
    )
    assert _part_ids(derive_terminals(document)) == ["2016-7714", "2003-7641", "2003-7642", "2009-305"]
    assert {"level": "info", "scope": "u", "message": "F1.2: 4-polig — Klemme wie 3-polig abgeleitet"} in validate_document(
        document
    )


# ── BOM, counts, strips, font size ───────────────────────────────────────────


def test_bom_sums_parts_sorted_by_part_number():
    bom = terminal_bom(derive_terminals(_standard_board()))
    assert [(row["part_id"], row["count"]) for row in bom] == [
        ("2003-7641", 3),
        ("2003-7642", 1),
        ("2009-305", 1),
        ("2016-7714", 1),
    ]
    assert bom[0]["part_no"] == "WAGO 2003-7641"
    assert bom[0]["width_mm"] == 5.2
    assert bom[0]["verified"] is True
    assert all(row["name"] for row in bom)


def test_bom_sums_across_groups():
    bom = terminal_bom(derive_terminals(_two_rcd_board()))
    assert [(row["part_id"], row["count"]) for row in bom] == [("2003-7641", 2), ("2009-305", 2), ("2016-7714", 2)]


def test_counts_for_the_tab_badge():
    assert terminal_counts(derive_terminals(_standard_board())) == {"terminals": 6, "groups": 1, "devices": 4}
    assert terminal_counts(derive_terminals(_two_rcd_board())) == {"terminals": 6, "groups": 2, "devices": 2}
    assert terminal_counts([]) == {"terminals": 0, "groups": 0, "devices": 0}


def test_unverified_parts_in_use():
    assert unverified_terminal_parts(derive_terminals(_standard_board())) == []
    assert [part.id for part in unverified_terminal_parts(derive_terminals(_single3p_board()))] == ["2016-7606"]


def _ids(selection: dict) -> list[str]:
    return [strip["group_id"] for strip in selection["strips"]]


def test_strips_default_to_circuit_numbers_at_part_widths_without_end_element():
    selection = terminal_strips(derive_terminals(_standard_board()), "circuit")
    assert selection["skipped"] == 0
    strips = selection["strips"]
    assert len(strips) == 1
    strip = strips[0]
    assert strip["group_id"] == "f1"
    assert strip["label"] == "FI F1 · Reihe 1"
    assert [text for text, _ in strip["segments"]] == ["F1", "1", "2", "3", "4"]
    assert [width for _, width in strip["segments"]] == [12, 5.2, 5.2, 5.2, 5.2]
    assert abs(strip["length_mm"] - 32.8) < 1e-6
    assert strip["part_count"] == 6
    assert strip["skipped"] == 0


def test_strips_in_bmk_mode_keep_the_fi_bmk_on_the_feed():
    strip = terminal_strips(derive_terminals(_standard_board()), "bmk")["strips"][0]
    assert [text for text, _ in strip["segments"]] == ["F1", "F1.1", "F1.2", "F1.3", "F1.4"]


def test_strips_print_pole_names_for_the_single_3pole_variant():
    for mode in ("circuit", "bmk"):
        strip = terminal_strips(derive_terminals(_single3p_board()), mode)["strips"][0]
        assert [text for text, _ in strip["segments"]] == ["F2", "L1", "L2", "L3"]
        assert strip["length_mm"] == 48


def test_strips_skip_and_count_a_terminal_without_text_in_the_chosen_mode():
    document = _rows(
        (
            "r1",
            "Reihe 1",
            [
                _device("f1", "rcd", designation="F1", poles=4),
                _tb("a", "mcb", designation="F1.1", circuit=""),
                _tb("b", "mcb", designation="F1.2", circuit="2"),
            ],
        )
    )
    circuit = terminal_strips(derive_terminals(document), "circuit")
    assert [text for text, _ in circuit["strips"][0]["segments"]] == ["F1", "2"]
    assert circuit["strips"][0]["skipped"] == 1
    assert circuit["skipped"] == 1
    bmk = terminal_strips(derive_terminals(document), "bmk")
    assert [text for text, _ in bmk["strips"][0]["segments"]] == ["F1", "F1.1", "F1.2"]
    assert bmk["skipped"] == 0


def test_strips_honour_the_group_filter_none_is_all_and_empty_is_none():
    groups = derive_terminals(_two_rcd_board())
    assert _ids(terminal_strips(groups, "circuit", ["f2"])) == ["f2"]
    assert _ids(terminal_strips(groups, "circuit", None)) == ["f1", "f2"]
    assert _ids(terminal_strips(groups, "circuit")) == ["f1", "f2"]
    # An explicit empty selection is nothing, not everything: unticking every
    # group in the sheet must not print the board.
    assert terminal_strips(groups, "circuit", []) == {"strips": [], "skipped": 0}


def test_strips_drop_a_group_with_no_text_but_keep_counting_its_terminals():
    unnamed = _rows(("r1", "Reihe 1", [_device("f1", "rcd", designation=""), _tb("a", "mcb", designation="", circuit="")]))
    # Feed terminal and Etagenklemme both carry a marker; neither has a text.
    assert terminal_strips(derive_terminals(unnamed), "circuit") == {"strips": [], "skipped": 2}


def _no_rcd_without_numbers_board() -> dict:
    """FI F1 with numbered outgoings, then a Hauptschalter group whose outgoings have no Stromkreis-Nr. yet."""
    return _rows(
        (
            "r1",
            "Reihe 1",
            [
                _device("f1", "rcd", designation="F1", poles=4),
                _tb("a", "mcb", designation="F1.1", circuit="1"),
                _tb("b", "mcb", designation="F1.2", circuit="2"),
            ],
        ),
        (
            "r2",
            "Reihe 2",
            [
                _device("q1", "hauptschalter", designation="Q1", poles=3),
                _tb("c", "mcb", designation="F0.1", circuit=""),
                _tb("d", "mcb", designation="F0.2", circuit=""),
            ],
        ),
    )


def test_skipped_counts_the_terminals_of_a_whole_group_dropped_for_having_no_text():
    groups = derive_terminals(_no_rcd_without_numbers_board())
    assert [group["group_id"] for group in groups] == ["f1", "q1"]
    circuit = terminal_strips(groups, "circuit")
    assert _ids(circuit) == ["f1"]
    # Q1's two Etagenklemmen print nothing in circuit mode — skipped, not forgotten.
    assert circuit["skipped"] == 2
    assert circuit["strips"][0]["skipped"] == 0
    assert terminal_strips(groups, "circuit", ["q1"]) == {"strips": [], "skipped": 2}
    bmk = terminal_strips(groups, "bmk")
    assert _ids(bmk) == ["f1", "q1"]
    assert bmk["skipped"] == 0


def test_terminal_font_size_uses_the_half_millimetre_pad():
    assert TERMINAL_SEG_PAD_DOTS == 6
    assert font_size_for_fits([("7", 5.2)], 11, pad_dots=TERMINAL_SEG_PAD_DOTS) == (90, [])
    # The BMK pad would leave the same digit 69 dots — the two are not interchangeable.
    assert font_size_for_fits([("7", 5.2)], 11, pad_dots=12) == (69, [])
    assert terminal_font_size(derive_terminals(_standard_board()), "circuit", 11) == (90, [])


def test_terminal_font_size_is_one_size_over_all_groups_in_the_chosen_mode():
    assert terminal_font_size(derive_terminals(_standard_board()), "bmk", 11) == (25, [])
    assert terminal_font_size(derive_terminals(_single3p_board()), "bmk", 11) == (95, [])


def test_terminal_font_size_reports_a_bmk_that_cannot_fit_at_the_floor():
    document = _rows(
        (
            "r1",
            "Reihe 1",
            [
                _device("f1", "rcd", designation="F1", poles=4),
                _tb("a", "mcb", designation="F1.12", circuit="12"),
                _tb("b", "mcb", designation="F1.3", circuit="3"),
            ],
        )
    )
    assert terminal_font_size(derive_terminals(document), "bmk", 11) == (24, ["F1.12"])
    # Two digits still fit 5.2 mm at 45 dots (3.75 mm) — the default mode is the way out.
    assert terminal_font_size(derive_terminals(document), "circuit", 11) == (45, [])


def test_terminal_font_size_is_the_maximum_without_text():
    assert terminal_font_size([], "circuit", 11) == (95, [])


# ── Endpoints ────────────────────────────────────────────────────────────────


def _terminal_panel(client: TestClient, admin_token: str, document: dict | None = None) -> dict:
    customer_id = _customer(client, admin_token, "Klemmen Kunde")
    return _create_panel(client, admin_token, customer_id, document=document or _two_rcd_board())


def test_terminal_block_survives_a_round_trip_and_defaults_to_false(client: TestClient, admin_token: str):
    panel = _terminal_panel(client, admin_token)
    devices = panel["document"]["rows"][0]["devices"]
    assert [d["terminal_block"] for d in devices] == [False, True, False, True]
    # A document written by an older client has no such key: it loads as off.
    legacy = _document([_device("f1", "rcd", designation="F1"), _device("a", "mcb", designation="F1.1")])
    resp = client.patch(
        f"/api/schaltplan/panels/{panel['id']}",
        headers=_auth(admin_token),
        json={"document": legacy},
    )
    assert resp.status_code == 200, resp.text
    assert [d["terminal_block"] for d in resp.json()["document"]["rows"][0]["devices"]] == [False, False]


def test_panel_detail_carries_the_terminal_bom(client: TestClient, admin_token: str):
    panel = _terminal_panel(client, admin_token)
    assert [(row["part_no"], row["count"]) for row in panel["terminal_bom"]] == [
        ("WAGO 2003-7641", 2),
        ("WAGO 2009-305", 2),
        ("WAGO 2016-7714", 2),
    ]
    detail = client.get(f"/api/schaltplan/panels/{panel['id']}", headers=_auth(admin_token)).json()
    assert detail["terminal_bom"] == panel["terminal_bom"]
    assert all({"part_id", "name", "width_mm", "verified"} <= set(row) for row in detail["terminal_bom"])


def test_terminal_strips_print_one_job_per_group_at_one_size(client: TestClient, admin_token: str, monkeypatch):
    _configure_label_printer(client, admin_token)
    sent = _capture_label_jobs(monkeypatch)
    panel = _terminal_panel(client, admin_token)

    resp = client.post(
        f"/api/schaltplan/panels/{panel['id']}/labels",
        headers=_auth(admin_token),
        json={"target": "reihenklemmen", "material_id": "wago-2009-110"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["material"] == "wago-2009-110"
    assert body["printed"] == 4
    assert body["skipped_without_bmk"] == 0
    assert [(s["row_id"], s["row_label"], s["length_mm"], s["part_count"]) for s in body["strips"]] == [
        ("f1", "FI F1 · Reihe 1", 17.2, 3),
        ("f2", "FI F2 · Reihe 1", 17.2, 3),
    ]

    assert len(sent) == 1
    payload = sent[0]
    assert payload.count(b"^L") == 2, "one continuous job per FI group"
    first, second = _jobs(payload)
    # 3 mm lead + 12 + 5.2 + 3 mm lead + the material's 2 mm print-origin offset.
    assert abs(_q_length(first) - 25.2) <= 1
    assert abs(_q_length(second) - 25.2) <= 1
    assert b"^W11" in first and b"^W11" in second
    # Feed terminal | outgoing: one divider plus the start and end lines.
    assert first.count(b"Lo,") == 1 + 2
    # Stromkreis-Nr. by default, never the BMK of the breaker.
    assert b"F1" in first and b"F1.1" not in first
    sizes = _at_sizes(first) + _at_sizes(second)
    assert len(sizes) == 4
    assert set(sizes) == {body["font_size_dots"]}
    assert body["font_size_dots"] == 90
    assert body["overflowing"] == []


def test_terminal_strips_can_be_limited_to_one_group_and_switched_to_bmk(
    client: TestClient, admin_token: str, monkeypatch
):
    _configure_label_printer(client, admin_token)
    sent = _capture_label_jobs(monkeypatch)
    panel = _terminal_panel(client, admin_token)

    resp = client.post(
        f"/api/schaltplan/panels/{panel['id']}/labels",
        headers=_auth(admin_token),
        json={"target": "reihenklemmen", "group_ids": ["f2"], "terminal_text": "bmk"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert [s["row_id"] for s in body["strips"]] == ["f2"]
    assert body["printed"] == 2
    job = _jobs(sent[0])
    assert len(job) == 1
    assert b"F2.1" in job[0]
    # The size is fitted over the WHOLE board in BMK mode, not just the printed group.
    assert body["font_size_dots"] == 25


def test_terminal_strips_count_terminals_without_text_as_skipped(client: TestClient, admin_token: str, monkeypatch):
    _configure_label_printer(client, admin_token)
    _capture_label_jobs(monkeypatch)
    document = _rows(
        (
            "r1",
            "Reihe 1",
            [
                _device("f1", "rcd", designation="F1", poles=4),
                _tb("a", "mcb", designation="F1.1", circuit=""),
                _tb("b", "mcb", designation="F1.2", circuit="2"),
            ],
        )
    )
    panel = _terminal_panel(client, admin_token, document)
    resp = client.post(
        f"/api/schaltplan/panels/{panel['id']}/labels",
        headers=_auth(admin_token),
        json={"target": "reihenklemmen"},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["printed"] == 2
    assert resp.json()["skipped_without_bmk"] == 1


def test_terminal_strips_count_a_whole_group_without_text_as_skipped(client: TestClient, admin_token: str, monkeypatch):
    _configure_label_printer(client, admin_token)
    sent = _capture_label_jobs(monkeypatch)
    panel = _terminal_panel(client, admin_token, _no_rcd_without_numbers_board())
    resp = client.post(
        f"/api/schaltplan/panels/{panel['id']}/labels",
        headers=_auth(admin_token),
        json={"target": "reihenklemmen"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert [s["row_id"] for s in body["strips"]] == ["f1"]
    assert body["printed"] == 3
    # Q1's two terminals get no strip at all — and must still be reported,
    # or the notice says "1 Streifen gedruckt" with nothing about them.
    assert body["skipped_without_bmk"] == 2
    assert len(_jobs(sent[0])) == 1


def test_terminal_strips_refuse_an_explicit_empty_selection_and_read_null_as_all(
    client: TestClient, admin_token: str, monkeypatch
):
    _configure_label_printer(client, admin_token)
    sent = _capture_label_jobs(monkeypatch)
    panel = _terminal_panel(client, admin_token)
    resp = client.post(
        f"/api/schaltplan/panels/{panel['id']}/labels",
        headers=_auth(admin_token),
        json={"target": "reihenklemmen", "group_ids": []},
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["detail"] == "Keine FI-Gruppe ausgewählt — mindestens eine Gruppe wählen."
    assert sent == []

    resp = client.post(
        f"/api/schaltplan/panels/{panel['id']}/labels",
        headers=_auth(admin_token),
        json={"target": "reihenklemmen", "group_ids": None},
    )
    assert resp.status_code == 200, resp.text
    assert [s["row_id"] for s in resp.json()["strips"]] == ["f1", "f2"]
    assert len(sent) == 1


def test_terminal_strips_refuse_die_cut_material(client: TestClient, admin_token: str, monkeypatch):
    _configure_label_printer(client, admin_token)
    sent = _capture_label_jobs(monkeypatch)
    panel = _terminal_panel(client, admin_token)
    resp = client.post(
        f"/api/schaltplan/panels/{panel['id']}/labels",
        headers=_auth(admin_token),
        json={"target": "reihenklemmen", "material_id": "wago-210-805"},
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["detail"] == "Reihenklemmen werden nur auf Endlosstreifen gedruckt."
    assert sent == []


def test_terminal_strips_refuse_a_board_without_terminals(client: TestClient, admin_token: str, monkeypatch):
    _configure_label_printer(client, admin_token)
    sent = _capture_label_jobs(monkeypatch)
    document = _document([_device("f1", "rcd", designation="F1"), _device("a", "mcb", designation="F1.1")])
    panel = _terminal_panel(client, admin_token, document)
    resp = client.post(
        f"/api/schaltplan/panels/{panel['id']}/labels",
        headers=_auth(admin_token),
        json={"target": "reihenklemmen"},
    )
    assert resp.status_code == 400, resp.text
    assert "Reihenklemme" in resp.json()["detail"]
    assert sent == []


def test_bmk_target_is_unchanged_by_the_new_fields(client: TestClient, admin_token: str, monkeypatch):
    _configure_label_printer(client, admin_token)
    sent = _capture_label_jobs(monkeypatch)
    panel = _terminal_panel(client, admin_token)
    resp = client.post(
        f"/api/schaltplan/panels/{panel['id']}/labels",
        headers=_auth(admin_token),
        json={"row_ids": ["r1"]},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["printed"] == 4
    assert [(s["row_id"], s["part_count"]) for s in body["strips"]] == [("r1", None)]
    assert len(_jobs(sent[0])) == 1


def test_pdf_terminals_only_renders_the_terminal_sheet(client: TestClient, admin_token: str):
    panel = _terminal_panel(client, admin_token)
    resp = client.get(f"/api/schaltplan/panels/{panel['id']}/pdf?terminals_only=true", headers=_auth(admin_token))
    assert resp.status_code == 200, resp.text
    assert resp.headers["content-type"] == "application/pdf"
    assert "Reihenklemmen_" in resp.headers["content-disposition"]
    text = _pdf_text(resp.content)
    assert b"Reihenklemmen" in text
    assert b"WAGO 2016-7714" in text
    assert b"WAGO 2009-305" in text
    assert b"FI F1" in text and b"FI F2" in text
    # One column per print mode, no single "Beschriftung" that could mean either.
    assert b"Stromkreis-Nr." in text and b"BMK" in text
    assert b"Beschriftung" not in text
    # Only the terminal sheet: no diagram title block, no legend header.
    assert b"Stromkreisliste" not in text


def test_full_pdf_appends_the_terminal_sheet_only_when_terminals_exist(client: TestClient, admin_token: str):
    with_terminals = _terminal_panel(client, admin_token)
    resp = client.get(f"/api/schaltplan/panels/{with_terminals['id']}/pdf", headers=_auth(admin_token))
    assert resp.status_code == 200, resp.text
    text = _pdf_text(resp.content)
    assert b"Stromkreisliste" in text
    assert b"Reihenklemmen" in text

    customer_id = _customer(client, admin_token, "Ohne Klemmen")
    plain = _create_panel(
        client, admin_token, customer_id,
        document=_document([_device("f1", "rcd", designation="F1"), _device("a", "mcb", designation="F1.1")]),
    )
    resp = client.get(f"/api/schaltplan/panels/{plain['id']}/pdf", headers=_auth(admin_token))
    assert resp.status_code == 200, resp.text
    assert b"Reihenklemmen" not in _pdf_text(resp.content)


def test_legend_only_pdf_leaves_out_the_terminal_sheet(client: TestClient, admin_token: str):
    panel = _terminal_panel(client, admin_token)
    resp = client.get(f"/api/schaltplan/panels/{panel['id']}/pdf?legend_only=true", headers=_auth(admin_token))
    assert resp.status_code == 200, resp.text
    assert "Legende_" in resp.headers["content-disposition"]
    text = _pdf_text(resp.content)
    assert b"Stromkreisliste" in text
    # The door sheet is one-sided on purpose; the terminal list is its own print.
    assert b"Reihenklemmen" not in text


def test_terminal_sheet_lists_both_print_modes_without_fallback():
    assert column_titles() == ["Pos.", "Klemme", "Stromkreis-Nr.", "BMK", "für"]
    assert sum(width for _key, _title, width in _COLUMNS) == 508
    document = _rows(
        (
            "r1",
            "Reihe 1",
            [_device("f1", "rcd", designation="F1", poles=4), _tb("a", "mcb", designation="F1.3", circuit="")],
        )
    )
    [group] = derive_terminals(document)
    device_by_id = {device["id"]: device for row in document["rows"] for device in row["devices"]}
    feed, outgoing, end = (row_values(terminal, device_by_id, group["head_device"]) for terminal in group["terminals"])
    assert (feed["part"], feed["circuit"], feed["bmk"]) == ("WAGO 2016-7714", "F1", "F1")
    # No Stromkreis-Nr. yet: the default print leaves this marker blank, and
    # the sheet says so instead of quietly showing the BMK there.
    assert (outgoing["part"], outgoing["circuit"], outgoing["bmk"]) == ("WAGO 2003-7641", "—", "F1.3")
    assert outgoing["for"] == "F1.3"
    assert (end["part"], end["circuit"], end["bmk"], end["for"]) == ("WAGO 2009-305", "—", "—", "—")
