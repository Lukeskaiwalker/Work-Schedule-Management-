"""Reihenklemmen — the WAGO terminal strips derived per FI group, X-numbered.

Twin of ``apps/web/src/test/schaltplanTerminals.test.ts``: the same fixtures,
the same expected part sequences and marker texts, the same font sizes. The
derivation lives in TypeScript (live tab, print preview) and in Python
(print job, PDF), and the two test files are what keep them from drifting —
a rule changed on one side only turns the other side's test red.

The owner's numbering (2026-09-23): every strip gets the next X in board
order; on a Leiste the feed terminal reads "X1" and the Etagenklemmen after
it "1.1", "1.2" …; a three-phase outgoing up to 16 A gets TWO Etagenklemmen,
above 16 A the 16 mm² Block with its own X and the PV-block label (name, X,
N L1 L2 L3 PE); every text can be overridden in ``document.terminal_labels``.

The endpoint tests print through the existing marking-strip path: one job
per strip on the 2009-110, cut marks at the terminals' real pitch, one font
size across the board's Leisten, the Block label as one 60 mm piece.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.services.schaltplan_layout import build_legend, font_size_for_fits, validate_document
from app.services.schaltplan_pdf_terminals import _COLUMNS, column_titles, row_values
from app.services.schaltplan_terminal_rules import (
    TERMINAL_PARTS,
    is_block_device,
    is_terminal_eligible,
    outgoing_parts_for_poles,
    rating_amps,
)
from app.services.schaltplan_terminals import (
    TERMINAL_SEG_PAD_DOTS,
    derive_terminals,
    device_terminal_labels,
    override_key,
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
    """A device that ends on a Reihenklemme; B16 unless said otherwise."""
    overrides.setdefault("rating", "B16")
    return _device(device_id, kind, terminal_block=True, **overrides)


def _rows(*rows: tuple[str, str, list[dict]]) -> dict:
    document = _document([])
    document["rows"] = [
        {"id": row_id, "label": label, "slots": 12, "devices": devices} for row_id, label, devices in rows
    ]
    return document


def _standard_board() -> dict:
    """An FI with three small outgoings (one of them three-phase) and a 32 A wallbox."""
    return _rows(
        (
            "r1",
            "Reihe 1",
            [
                _device("f1", "rcd", designation="F1", poles=4),
                _tb("f11", "mcb", designation="F1.1", circuit="1"),
                _tb("f12", "mcb", designation="F1.2", circuit="2"),
                _tb("f13", "mcb", designation="F1.3", circuit="3", poles=3),
                _tb("w1", "wallbox", designation="F1.4", circuit="4", poles=3, rating="B32", label="Wallbox Garage"),
                _device("f15", "mcb", designation="F1.5", circuit="5"),
            ],
        )
    )


def _block_only_board() -> dict:
    return _rows(
        (
            "r1",
            "Reihe 1",
            [
                _device("f2", "rcd", designation="F2", poles=4),
                _tb("w2", "wallbox", designation="F2.1", circuit="9", poles=3, rating="C32", label="Wechselrichter PV"),
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


def _jobs_strict(payload: bytes) -> list[bytes]:
    """Split a connection into jobs on the E command alone on its line —
    the shared helper splits on "E\\r\\n", which a cell reading "PE" also ends with."""
    return [chunk for chunk in payload.split(b"\r\nE\r\n") if chunk.strip()]


def _labels(groups: list[dict], strip: int = 0, group: int = 0) -> list[str]:
    return [entry["label"] for entry in groups[group]["strips"][strip]["terminals"]]


def _part_ids(groups: list[dict], strip: int = 0, group: int = 0) -> list[str]:
    return [entry["part_id"] for entry in groups[group]["strips"][strip]["terminals"]]


# ── Rules ─────────────────────────────────────────────────────────────────────


def test_only_mcb_protected_outgoing_kinds_are_eligible():
    assert [kind for kind in ("mcb", "wallbox", "sub_feed", "pv") if is_terminal_eligible(_device("x", kind))] == [
        "mcb", "wallbox", "sub_feed", "pv",
    ]
    assert not any(is_terminal_eligible(_device("x", kind)) for kind in ("rcbo", "rcd", "fuse", "contactor", "spd", "blank"))


def test_one_phase_gets_one_etagenklemme_three_phases_get_two():
    assert outgoing_parts_for_poles(1) == ("2003-7641",)
    assert outgoing_parts_for_poles(2) == ("2003-7641",)
    assert outgoing_parts_for_poles(3) == ("2003-7641", "2003-7642")
    assert outgoing_parts_for_poles(4) == ("2003-7641", "2003-7642")


def test_rating_amps_reads_the_office_spellings():
    assert rating_amps("B16") == 16
    assert rating_amps("C 32A") == 32
    assert rating_amps("16 A") == 16
    assert rating_amps("63") == 63
    assert rating_amps("2,5") == 2.5
    assert rating_amps("") is None and rating_amps(None) is None and rating_amps("B") is None


def test_block_is_three_phases_above_16_amps():
    assert not is_block_device(_tb("a", "mcb", poles=3, rating="B16"))
    assert is_block_device(_tb("a", "mcb", poles=3, rating="B20"))
    assert is_block_device(_tb("a", "wallbox", poles=4, rating="C32"))
    assert not is_block_device(_tb("a", "mcb", poles=1, rating="B32"))
    assert not is_block_device(_tb("a", "mcb", poles=3, rating=""))


def test_part_table_carries_the_looked_up_widths_and_flags():
    assert TERMINAL_PARTS["2003-7641"].width_mm == 5.2
    assert TERMINAL_PARTS["2016-7714"].width_mm == 12
    assert TERMINAL_PARTS["2009-305"].width_mm == 7.5
    assert TERMINAL_PARTS["2009-305"].marker is False
    assert TERMINAL_PARTS["2016-7607"].marker is True
    assert all(part.verified for part in TERMINAL_PARTS.values())


# ── Derivation ────────────────────────────────────────────────────────────────


def test_standard_group_leiste_then_block_with_x_numbers():
    [group] = derive_terminals(_standard_board())
    assert group["variant"] == "standard"
    assert [(s["strip_id"], s["strip_no"], s["kind"]) for s in group["strips"]] == [
        ("f1:leiste", 1, "leiste"),
        ("w1:block", 2, "block"),
    ]
    assert _part_ids(group and [group], 0) == [
        "2016-7714", "2003-7641", "2003-7641", "2003-7641", "2003-7642", "2009-305",
    ]
    # X1 on the feed, then 1.1 … counted through the whole Leiste — the
    # three-phase F1.3 owns 1.3 AND 1.4 — and nothing on the end clamp.
    assert _labels([group], 0) == ["X1", "1.1", "1.2", "1.3", "1.4", ""]
    assert [t["device_id"] for t in group["strips"][0]["terminals"]] == ["f1", "f11", "f12", "f13", "f13", None]
    assert [t["slot"] for t in group["strips"][0]["terminals"]] == ["feed", "1", "1", "1", "2", None]
    assert group["strips"][0]["title"] == "X1 · FI F1 · Reihe 1"
    assert group["strips"][0]["x_label"] == "X1"

    block = group["strips"][1]
    assert _part_ids([group], 1) == ["2016-7604", "2016-7601", "2016-7601", "2016-7601", "2016-7607"]
    assert _labels([group], 1) == ["N", "L1", "L2", "L3", "PE"]
    assert [t["pole"] for t in block["terminals"]] == ["N", "L1", "L2", "L3", "PE"]
    assert all(t["device_id"] == "w1" for t in block["terminals"])
    assert (block["title"], block["name"], block["x_label"]) == ("X2 · Block F1.4 Wallbox Garage", "Wallbox Garage", "X2")
    assert (block["name_key"], block["x_key"]) == ("w1:name", "w1:x")
    # The flat list is every strip's terminals in order.
    assert [t["label"] for t in group["terminals"]] == ["X1", "1.1", "1.2", "1.3", "1.4", "", "N", "L1", "L2", "L3", "PE"]


def test_every_marker_carries_its_override_key_and_default():
    [group] = derive_terminals(_standard_board())
    feed, first, *_ = group["strips"][0]["terminals"]
    assert (feed["key"], feed["default_label"]) == (override_key("f1", "feed"), "X1")
    assert (first["key"], first["default_label"]) == ("f11:1", "1.1")
    end = group["strips"][0]["terminals"][-1]
    assert (end["key"], end["slot"], end["label"]) == ("", None, "")
    n_cell = group["strips"][1]["terminals"][0]
    assert (n_cell["key"], n_cell["default_label"]) == ("w1:N", "N")


def test_overrides_replace_texts_blank_them_and_rename_the_block():
    document = _standard_board()
    document["terminal_labels"] = {"f1:feed": "XA", "f11:1": "1.9", "f12:1": "", "w1:name": "Wallbox", "w1:x": "X9", "w1:L2": "L2*"}
    [group] = derive_terminals(document)
    assert _labels([group], 0) == ["XA", "1.9", "", "1.3", "1.4", ""]
    # The default is kept beside the override, so the editor can offer "Zurücksetzen".
    assert [t["default_label"] for t in group["strips"][0]["terminals"]] == ["X1", "1.1", "1.2", "1.3", "1.4", ""]
    block = group["strips"][1]
    assert (block["name"], block["x_label"]) == ("Wallbox", "X9")
    assert _labels([group], 1) == ["N", "L1", "L2*", "L3", "PE"]
    # The X number itself is not renumbered by an override: the next strip keeps counting.
    assert block["strip_no"] == 2


def test_block_only_group_has_no_leiste():
    [group] = derive_terminals(_block_only_board())
    assert [(s["strip_id"], s["kind"]) for s in group["strips"]] == [("w2:block", "block")]
    assert group["strips"][0]["x_label"] == "X1"
    assert group["strips"][0]["name"] == "Wechselrichter PV"


def test_a_three_phase_16a_outgoing_alone_under_an_fi_is_a_leiste_not_a_block():
    document = _rows(("r1", "Reihe 1", [_device("f2", "rcd", designation="F2", poles=4), _tb("w2", "wallbox", designation="F2.1", poles=3)]))
    [group] = derive_terminals(document)
    assert _part_ids([group]) == ["2016-7714", "2003-7641", "2003-7642", "2009-305"]
    assert _labels([group]) == ["X1", "1.1", "1.2", ""]


def test_block_name_falls_back_to_the_designation():
    document = _block_only_board()
    document["rows"][0]["devices"][1]["label"] = ""
    [group] = derive_terminals(document)
    assert group["strips"][0]["name"] == "F2.1"
    assert group["strips"][0]["title"] == "X1 · Block F2.1"


def test_group_without_terminal_devices_emits_nothing():
    document = _document([_device("f1", "rcd", designation="F1"), _device("a", "mcb", designation="F1.1")])
    assert derive_terminals(document) == []


def test_x_numbers_run_across_groups_and_rails():
    document = _rows(
        ("r1", "Reihe 1", [_device("f1", "rcd", designation="F1", poles=4), _tb("a", "mcb", designation="F1.1"), _tb("big", "mcb", designation="F1.2", poles=3, rating="B25")]),
        ("r2", "Reihe 2", [_tb("c", "mcb", designation="F1.3"), _device("f2", "rcd", designation="F2", poles=4), _tb("b", "mcb", designation="F2.1")]),
    )
    groups = derive_terminals(document)
    assert [[s["x_label"] for s in g["strips"]] for g in groups] == [["X1", "X2"], ["X3"]]
    # F1's Leiste follows its group across the rail: a, then c, one end clamp.
    assert [t["device_id"] for t in groups[0]["strips"][0]["terminals"]] == ["f1", "a", "c", None]
    assert _labels(groups, 0, 0) == ["X1", "1.1", "1.2", ""]
    assert _labels(groups, 0, 1) == ["X3", "3.1", ""]


def test_two_rcds_on_one_rail_close_separately():
    groups = derive_terminals(_two_rcd_board())
    assert [g["group_id"] for g in groups] == ["f1", "f2"]
    assert _labels(groups, 0, 0) == ["X1", "1.1", ""]
    assert _labels(groups, 0, 1) == ["X2", "2.1", ""]
    assert [terminal_group_title(g) for g in groups] == ["FI F1 · Reihe 1", "FI F2 · Reihe 1"]


def test_group_without_rcd_has_no_feed_and_no_end_clamp_and_reports_it():
    document = _rows(("r1", "Reihe 1", [_device("q1", "hauptschalter", designation="Q1", poles=3), _tb("a", "mcb", designation="F1"), _tb("b", "mcb", designation="F2", poles=3)]))
    [group] = derive_terminals(document)
    assert group["variant"] == "no_rcd"
    assert _part_ids([group]) == ["2003-7641", "2003-7641", "2003-7642"]
    assert _labels([group]) == ["1.1", "1.2", "1.3"]
    assert group["strips"][0]["title"] == "X1 · HS Q1 · Reihe 1"
    infos = [f for f in validate_document(document) if f["level"] == "info"]
    assert any("ohne FI" in f["message"] for f in infos)


def test_terminal_before_any_head_lands_in_the_supply_group():
    document = _rows(("r1", "Reihe 1", [_tb("a", "mcb", designation="F0"), _device("f1", "rcd", designation="F1", poles=4), _tb("b", "mcb", designation="F1.1")]))
    groups = derive_terminals(document)
    assert [g["group_id"] for g in groups] == ["supply", "f1"]
    assert groups[0]["strips"][0]["strip_id"] == "supply:leiste"
    assert groups[0]["strips"][0]["title"] == "X1 · Einspeisung"
    assert _labels(groups, 0, 1) == ["X2", "2.1", ""]


def test_rcbo_and_fuse_are_ignored_even_with_the_flag():
    document = _rows(("r1", "Reihe 1", [_device("f1", "rcd", designation="F1", poles=4), _tb("x", "rcbo", designation="F1.1"), _tb("s", "fuse", designation="F1.2"), _tb("a", "mcb", designation="F1.3")]))
    [group] = derive_terminals(document)
    assert [t["device_id"] for t in group["terminals"]] == ["f1", "a", None]


def test_pole_rounding_is_reported_for_etagenklemmen_but_not_for_a_block():
    document = _rows(("r1", "Reihe 1", [_device("f1", "rcd", designation="F1", poles=4), _tb("two", "mcb", designation="F1.1", poles=2), _tb("four", "mcb", designation="F1.2", poles=4), _tb("bigfour", "mcb", designation="F1.3", poles=4, rating="B20")]))
    [group] = derive_terminals(document)
    assert _part_ids([group]) == ["2016-7714", "2003-7641", "2003-7641", "2003-7642", "2009-305"]
    assert _part_ids([group], 1) == ["2016-7604", "2016-7601", "2016-7601", "2016-7601", "2016-7607"]
    messages = [f["message"] for f in validate_document(document) if f["level"] == "info"]
    assert any("F1.1: 2-polig" in m for m in messages)
    assert any("F1.2: 4-polig" in m for m in messages)
    assert not any("F1.3" in m for m in messages)


# ── Documents ─────────────────────────────────────────────────────────────────


def test_bom_sums_parts_over_the_board_sorted_by_part_number():
    rows = terminal_bom(derive_terminals(_standard_board()))
    assert [(row["part_no"], row["count"]) for row in rows] == [
        ("WAGO 2003-7641", 3),
        ("WAGO 2003-7642", 1),
        ("WAGO 2009-305", 1),
        ("WAGO 2016-7601", 3),
        ("WAGO 2016-7604", 1),
        ("WAGO 2016-7607", 1),
        ("WAGO 2016-7714", 1),
    ]
    assert all(row["verified"] for row in rows)


def test_counts_for_the_tab_badge():
    assert terminal_counts(derive_terminals(_standard_board())) == {"terminals": 11, "strips": 2, "groups": 1, "devices": 4}
    assert terminal_counts(derive_terminals(_two_rcd_board())) == {"terminals": 6, "strips": 2, "groups": 2, "devices": 2}


def test_unverified_parts_in_use():
    assert unverified_terminal_parts(derive_terminals(_standard_board())) == []


def test_device_labels_for_the_legend_list_x_numbers():
    assert device_terminal_labels(derive_terminals(_standard_board())) == {
        "f11": ["X1.1"],
        "f12": ["X1.2"],
        "f13": ["X1.3", "X1.4"],
        "w1": ["X2"],
    }
    rows = {row["designation"]: row["terminals"] for row in build_legend(_standard_board())}
    assert rows["F1.3"] == "X1.3, X1.4"
    assert rows["F1.4"] == "X2"
    assert rows["F1.5"] == ""


# ── Strips ────────────────────────────────────────────────────────────────────


def _ids(selection: dict) -> list[str]:
    return [strip["strip_id"] for strip in selection["strips"]]


def test_strips_are_leiste_segments_and_block_cells_at_part_widths():
    selection = terminal_strips(derive_terminals(_standard_board()))
    leiste, block = selection["strips"]
    assert (leiste["kind"], leiste["strip_id"], leiste["label"]) == ("leiste", "f1:leiste", "X1 · FI F1 · Reihe 1")
    assert leiste["segments"] == [("X1", 12.0), ("1.1", 5.2), ("1.2", 5.2), ("1.3", 5.2), ("1.4", 5.2)]
    assert (leiste["part_count"], round(leiste["length_mm"], 1), leiste["skipped"]) == (6, 32.8, 0)
    assert (block["kind"], block["strip_id"], block["name"], block["x_label"]) == ("block", "w1:block", "Wallbox Garage", "X2")
    assert block["cells"] == [("N", 12.0), ("L1", 12.0), ("L2", 12.0), ("L3", 12.0), ("PE", 12.0)]
    assert (block["segments"], block["part_count"], block["length_mm"]) == ([], 5, 60.0)
    assert selection["skipped"] == 0


def test_strips_skip_a_blanked_marker_and_keep_counting_it():
    document = _standard_board()
    document["terminal_labels"] = {"f12:1": ""}
    selection = terminal_strips(derive_terminals(document))
    assert selection["strips"][0]["segments"] == [("X1", 12.0), ("1.1", 5.2), ("1.3", 5.2), ("1.4", 5.2)]
    assert selection["skipped"] == 1 and selection["strips"][0]["skipped"] == 1


def test_strips_drop_a_leiste_blanked_entirely_but_count_its_terminals():
    document = _two_rcd_board()
    document["terminal_labels"] = {"f1:feed": "", "a:1": ""}
    selection = terminal_strips(derive_terminals(document))
    assert _ids(selection) == ["f2:leiste"]
    assert selection["skipped"] == 2


def test_strips_honour_the_selection_none_is_all_and_empty_is_none():
    groups = derive_terminals(_standard_board())
    assert _ids(terminal_strips(groups)) == ["f1:leiste", "w1:block"]
    assert _ids(terminal_strips(groups, None)) == ["f1:leiste", "w1:block"]
    assert _ids(terminal_strips(groups, ["w1:block"])) == ["w1:block"]
    assert _ids(terminal_strips(groups, [])) == []


def test_terminal_font_size_is_one_size_over_every_leiste_of_the_board():
    groups = derive_terminals(_standard_board())
    size, overflowing = terminal_font_size(groups, 11.0)
    # "1.1" inside a 5.2 mm segment minus the half-millimetre pads.
    expected, _ = font_size_for_fits([("1.1", 5.2)], 11.0, pad_dots=TERMINAL_SEG_PAD_DOTS)
    assert (size, overflowing) == (expected, []) and size == 36
    # A board of blocks only has no Leiste text to fit: the maximum.
    assert terminal_font_size(derive_terminals(_block_only_board()), 11.0) == (95, [])
    assert terminal_font_size([], 11.0) == (95, [])


def test_terminal_font_size_reports_a_text_that_cannot_fit_at_the_floor():
    document = _two_rcd_board()
    document["terminal_labels"] = {"a:1": "F1.12 lang"}
    size, overflowing = terminal_font_size(derive_terminals(document), 11.0)
    assert overflowing == ["F1.12 lang"]
    assert size >= 1


# ── Endpoints ─────────────────────────────────────────────────────────────────


def _terminal_panel(client: TestClient, admin_token: str, document: dict | None = None) -> dict:
    customer_id = _customer(client, admin_token, "Klemmen Kunde")
    return _create_panel(client, admin_token, customer_id, document=document or _two_rcd_board())


def test_terminal_block_survives_a_round_trip_and_defaults_to_false(client: TestClient, admin_token: str):
    panel = _terminal_panel(client, admin_token)
    devices = panel["document"]["rows"][0]["devices"]
    assert [d["terminal_block"] for d in devices] == [False, True, False, True]
    legacy = _document([_device("f1", "rcd", designation="F1"), _device("a", "mcb", designation="F1.1")])
    resp = client.patch(f"/api/schaltplan/panels/{panel['id']}", headers=_auth(admin_token), json={"document": legacy})
    assert resp.status_code == 200, resp.text
    assert [d["terminal_block"] for d in resp.json()["document"]["rows"][0]["devices"]] == [False, False]


def test_terminal_labels_survive_a_round_trip(client: TestClient, admin_token: str):
    document = _two_rcd_board()
    document["terminal_labels"] = {"a:1": "1.9", "f2:feed": "XB"}
    panel = _terminal_panel(client, admin_token, document)
    assert panel["document"]["terminal_labels"] == {"a:1": "1.9", "f2:feed": "XB"}
    detail = client.get(f"/api/schaltplan/panels/{panel['id']}", headers=_auth(admin_token)).json()
    assert detail["document"]["terminal_labels"] == {"a:1": "1.9", "f2:feed": "XB"}


def test_panel_detail_carries_the_terminal_bom(client: TestClient, admin_token: str):
    panel = _terminal_panel(client, admin_token)
    assert [(row["part_no"], row["count"]) for row in panel["terminal_bom"]] == [
        ("WAGO 2003-7641", 2),
        ("WAGO 2009-305", 2),
        ("WAGO 2016-7714", 2),
    ]


def test_terminal_strips_print_one_job_per_leiste_at_one_size(client: TestClient, admin_token: str, monkeypatch):
    _configure_label_printer(client, admin_token)
    sent = _capture_label_jobs(monkeypatch)
    panel = _terminal_panel(client, admin_token)

    resp = client.post(f"/api/schaltplan/panels/{panel['id']}/labels", headers=_auth(admin_token), json={"target": "reihenklemmen", "material_id": "wago-2009-110"})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["material"] == "wago-2009-110"
    assert body["printed"] == 4
    assert body["skipped_without_bmk"] == 0
    assert [(s["row_id"], s["row_label"], s["length_mm"], s["part_count"]) for s in body["strips"]] == [
        ("f1:leiste", "X1 · FI F1 · Reihe 1", 17.2, 3),
        ("f2:leiste", "X2 · FI F2 · Reihe 1", 17.2, 3),
    ]
    assert len(sent) == 1
    first, second = _jobs(sent[0])
    # 3 mm lead + 12 + 5.2 + 3 mm lead + the material's 2 mm print-origin offset.
    assert abs(_q_length(first) - 25.2) <= 1 and abs(_q_length(second) - 25.2) <= 1
    assert b"^W11" in first
    # Feed terminal | outgoing: one divider plus the start and end lines.
    assert first.count(b"Lo,") == 1 + 2
    assert b"X1" in first and b"1.1" in first and b"F1.1" not in first
    assert b"X2" in second and b"2.1" in second
    sizes = _at_sizes(first) + _at_sizes(second)
    assert len(sizes) == 4 and set(sizes) == {body["font_size_dots"]} == {36}
    assert body["overflowing"] == []


def test_block_label_prints_as_one_piece_with_three_rows(client: TestClient, admin_token: str, monkeypatch):
    _configure_label_printer(client, admin_token)
    sent = _capture_label_jobs(monkeypatch)
    panel = _terminal_panel(client, admin_token, _standard_board())

    resp = client.post(f"/api/schaltplan/panels/{panel['id']}/labels", headers=_auth(admin_token), json={"target": "reihenklemmen"})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["printed"] == 5 + 5
    assert [(s["row_id"], s["length_mm"], s["part_count"]) for s in body["strips"]] == [("f1:leiste", 32.8, 6), ("w1:block", 60.0, 5)]
    leiste, block = _jobs_strict(sent[0])
    # 3 + 60 + 3 mm plus the 2 mm offset.
    assert abs(_q_length(block) - 68) <= 1
    assert b"^W11" in block
    # Name row, X row, five cells — in the font engine's bold (style 1BE:
    # rotated, Bold, UTF-8), where the Leiste prints regular (1E).
    at_lines = [line for line in block.split(b"\r\n") if line.startswith(b"AT,")]
    assert [line.split(b",", 9)[-1] for line in at_lines] == [b"Wallbox Garage", b"X2", b"N", b"L1", b"L2", b"L3", b"PE"]
    assert all(b",0,1BE,0,0," in line for line in at_lines)
    assert all(b",0,1E,0,0," in line for line in leiste.split(b"\r\n") if line.startswith(b"AT,"))
    # Start and end marks, two rules between the rows, four cell marks in the bottom row.
    assert block.count(b"Lo,") == 2 + 2 + 4
    assert len(_at_sizes(leiste)) == 5


def test_terminal_strips_can_be_limited_to_one_strip(client: TestClient, admin_token: str, monkeypatch):
    _configure_label_printer(client, admin_token)
    sent = _capture_label_jobs(monkeypatch)
    panel = _terminal_panel(client, admin_token, _standard_board())
    resp = client.post(f"/api/schaltplan/panels/{panel['id']}/labels", headers=_auth(admin_token), json={"target": "reihenklemmen", "strip_ids": ["w1:block"]})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert [s["row_id"] for s in body["strips"]] == ["w1:block"]
    assert body["printed"] == 5
    assert len(_jobs_strict(sent[0])) == 1
    # The Leiste size is still fitted over the whole board.
    assert body["font_size_dots"] == 36


def test_terminal_strips_count_blanked_markers_as_skipped(client: TestClient, admin_token: str, monkeypatch):
    _configure_label_printer(client, admin_token)
    _capture_label_jobs(monkeypatch)
    document = _two_rcd_board()
    document["terminal_labels"] = {"a:1": ""}
    panel = _terminal_panel(client, admin_token, document)
    resp = client.post(f"/api/schaltplan/panels/{panel['id']}/labels", headers=_auth(admin_token), json={"target": "reihenklemmen"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["printed"] == 3
    assert resp.json()["skipped_without_bmk"] == 1


def test_terminal_strips_refuse_an_explicit_empty_selection_and_read_null_as_all(client: TestClient, admin_token: str, monkeypatch):
    _configure_label_printer(client, admin_token)
    sent = _capture_label_jobs(monkeypatch)
    panel = _terminal_panel(client, admin_token)
    resp = client.post(f"/api/schaltplan/panels/{panel['id']}/labels", headers=_auth(admin_token), json={"target": "reihenklemmen", "strip_ids": []})
    assert resp.status_code == 400, resp.text
    assert resp.json()["detail"] == "Keine Klemmenleiste ausgewählt — mindestens eine wählen."
    assert sent == []
    resp = client.post(f"/api/schaltplan/panels/{panel['id']}/labels", headers=_auth(admin_token), json={"target": "reihenklemmen", "strip_ids": None})
    assert resp.status_code == 200, resp.text
    assert [s["row_id"] for s in resp.json()["strips"]] == ["f1:leiste", "f2:leiste"]
    assert len(sent) == 1


def test_terminal_strips_refuse_die_cut_material(client: TestClient, admin_token: str, monkeypatch):
    _configure_label_printer(client, admin_token)
    sent = _capture_label_jobs(monkeypatch)
    panel = _terminal_panel(client, admin_token)
    resp = client.post(f"/api/schaltplan/panels/{panel['id']}/labels", headers=_auth(admin_token), json={"target": "reihenklemmen", "material_id": "wago-210-805"})
    assert resp.status_code == 400, resp.text
    assert resp.json()["detail"] == "Reihenklemmen werden nur auf Endlosstreifen gedruckt."
    assert sent == []


def test_terminal_strips_refuse_a_board_without_terminals(client: TestClient, admin_token: str, monkeypatch):
    _configure_label_printer(client, admin_token)
    sent = _capture_label_jobs(monkeypatch)
    document = _document([_device("f1", "rcd", designation="F1"), _device("a", "mcb", designation="F1.1")])
    panel = _terminal_panel(client, admin_token, document)
    resp = client.post(f"/api/schaltplan/panels/{panel['id']}/labels", headers=_auth(admin_token), json={"target": "reihenklemmen"})
    assert resp.status_code == 400, resp.text
    assert "Reihenklemme" in resp.json()["detail"]
    assert sent == []


def test_bmk_target_is_unchanged_by_the_new_fields(client: TestClient, admin_token: str, monkeypatch):
    _configure_label_printer(client, admin_token)
    sent = _capture_label_jobs(monkeypatch)
    panel = _terminal_panel(client, admin_token)
    resp = client.post(f"/api/schaltplan/panels/{panel['id']}/labels", headers=_auth(admin_token), json={"row_ids": ["r1"]})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["printed"] == 4
    assert [(s["row_id"], s["part_count"]) for s in body["strips"]] == [("r1", None)]
    assert len(_jobs(sent[0])) == 1


# ── PDF ───────────────────────────────────────────────────────────────────────


def test_pdf_terminals_only_renders_the_terminal_sheet_per_strip(client: TestClient, admin_token: str):
    panel = _terminal_panel(client, admin_token, _standard_board())
    resp = client.get(f"/api/schaltplan/panels/{panel['id']}/pdf?terminals_only=true", headers=_auth(admin_token))
    assert resp.status_code == 200, resp.text
    assert resp.headers["content-type"] == "application/pdf"
    assert "Reihenklemmen_" in resp.headers["content-disposition"]
    text = _pdf_text(resp.content)
    assert b"Reihenklemmen" in text
    assert b"WAGO 2016-7714" in text and b"WAGO 2009-305" in text and b"WAGO 2016-7604" in text
    assert b"X1 " in text and b"X2 " in text and b"Block F1.4 Wallbox Garage" in text
    assert b"Beschriftung" in text
    assert b"Stromkreis-Nr." not in text
    assert b"Stromkreisliste" not in text


def test_full_pdf_appends_the_terminal_sheet_only_when_terminals_exist(client: TestClient, admin_token: str):
    with_terminals = _terminal_panel(client, admin_token)
    resp = client.get(f"/api/schaltplan/panels/{with_terminals['id']}/pdf", headers=_auth(admin_token))
    assert resp.status_code == 200, resp.text
    text = _pdf_text(resp.content)
    assert b"Stromkreisliste" in text and b"Reihenklemmen" in text
    customer_id = _customer(client, admin_token, "Ohne Klemmen")
    plain = _create_panel(client, admin_token, customer_id, document=_document([_device("f1", "rcd", designation="F1"), _device("a", "mcb", designation="F1.1")]))
    resp = client.get(f"/api/schaltplan/panels/{plain['id']}/pdf", headers=_auth(admin_token))
    assert resp.status_code == 200, resp.text
    assert b"Reihenklemmen" not in _pdf_text(resp.content)


def test_legend_pdf_lists_the_terminals_of_each_circuit(client: TestClient, admin_token: str):
    panel = _terminal_panel(client, admin_token, _standard_board())
    resp = client.get(f"/api/schaltplan/panels/{panel['id']}/pdf?legend_only=true", headers=_auth(admin_token))
    assert resp.status_code == 200, resp.text
    assert "Legende_" in resp.headers["content-disposition"]
    text = _pdf_text(resp.content)
    assert b"Stromkreisliste" in text
    assert b"Klemmen" in text
    assert b"X1.3, X1.4" in text
    assert b"Reihenklemmen" not in text


def test_terminal_sheet_columns_pin_the_klemmen_tab():
    assert column_titles() == ["Pos.", "Klemme", "Beschriftung", "für"]
    assert sum(width for _key, _title, width in _COLUMNS) == 508
    document = _rows(("r1", "Reihe 1", [_device("f1", "rcd", designation="F1", poles=4), _tb("a", "mcb", designation="F1.3", label="Licht Flur", circuit="3")]))
    [group] = derive_terminals(document)
    device_by_id = {device["id"]: device for row in document["rows"] for device in row["devices"]}
    feed, outgoing, end = (row_values(terminal, device_by_id, group["head_device"]) for terminal in group["terminals"])
    assert (feed["part"], feed["label"]) == ("WAGO 2016-7714", "X1")
    assert (outgoing["part"], outgoing["label"], outgoing["for"]) == ("WAGO 2003-7641", "1.1", "F1.3 · Licht Flur · Nr. 3")
    assert (end["part"], end["label"], end["for"]) == ("WAGO 2009-305", "—", "—")
