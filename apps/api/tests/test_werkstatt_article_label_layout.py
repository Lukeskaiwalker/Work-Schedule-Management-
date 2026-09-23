"""The shelf label's layout — ``services/werkstatt_article_labels``.

What must hold: the name splits into part number and description the way
the catalog writes it, with the manufacturer standing in when there is no
part-number head; the printed job places a DataMatrix anchored for the
16 × 16 symbol an SMPL code needs, the code small under it, the head large,
the description on up to two lines and the article number with the EAN
small at the bottom — and no logo download, no footer; the endpoint ships
that job; wrong stock is refused before anything is sent; a batch goes out
in one connection; and the preview is a PNG of the sheet's size.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.services import werkstatt_article_labels as al
from app.services import werkstatt_labels
from app.services.werkstatt_label_materials import DEFAULT_MATERIALS
from tests.conftest import auth_headers

VOLL = DEFAULT_MATERIALS[0]


def _at_lines(job: list[str]) -> list[tuple[int, int, int, str]]:
    """(machine_x, machine_y, size, text) of every AT line, in job order."""
    out = []
    for line in job:
        if line.startswith("AT,"):
            parts = line.split(",", 9)
            out.append((int(parts[1]), int(parts[2]), int(parts[3]), parts[9]))
    return out


# ── Name split ────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("name", "maker", "head", "description"),
    [
        ("WAGO 2016-7607 - TOPJOB S 2L-PE-KL.42GRAD 16QMM GR-GE", "WAGO", "WAGO 2016-7607", "TOPJOB S 2L-PE-KL.42GRAD 16QMM GR-GE"),
        ("HAGER MBS116 - Sicherungsautomat 1P B-16A Steckklemme", None, "HAGER MBS116", "Sicherungsautomat 1P B-16A Steckklemme"),
        # No separator: the manufacturer is the head when the name does not start with it.
        ("Endklemme Blank", "Lorenz", "Lorenz", "Endklemme Blank"),
        ("Wago 285-1185", "WAGO", "", "Wago 285-1185"),
        # A "head" that is really prose is not a part number.
        ("Steckdosenkombination mit Zugentlastung für die Halle - fertig verdrahtet", "MENN", "MENN", "Steckdosenkombination mit Zugentlastung für die Halle - fertig verdrahtet"),
        ("  Makita   DJV184  ", None, "", "Makita DJV184"),
    ],
)
def test_name_splits_into_part_number_and_description(name: str, maker: str | None, head: str, description: str) -> None:
    assert al.split_item_name(name, maker) == (head, description)


# ── The job ───────────────────────────────────────────────────────────────────


def test_job_places_matrix_code_head_description_and_foot_without_logo_or_footer() -> None:
    content = al.ArticleLabelContent("SMPL-81JHYT", "WAGO 2016-7607 - TOPJOB S 2L-PE-KL.42GRAD 16QMM GR-GE", "WAGO", "SP-0187", "4045454725112")
    job = al.render_article_label(VOLL, content)

    assert job[:3] == ["^Q99,3", "^W44", "^L"] and job[-1] == "E"
    # A 16 × 16 symbol of 11-dot modules, anchored at its reading bottom
    # (528 - (150 + 176) = 202) and its reading left (36 + 2 mm offset = 60).
    assert "XRB202,60,11,0,11" in job
    assert job[job.index("XRB202,60,11,0,11") + 1] == "SMPL-81JHYT"
    assert not any(line.startswith(("Y", "~EB")) for line in job), "no logo on a shelf label"
    assert not any("SMPL Energy" in line for line in job), "no footer on a shelf label"

    texts = _at_lines(job)
    assert [t for _, _, _, t in texts] == [
        "SMPL-81JHYT",
        "WAGO 2016-7607",
        "TOPJOB S 2L-PE-KL.42GRAD",
        "16QMM GR-GE",
        "SP-0187 · EAN 4045454725112",
    ]
    sizes = {t: size for _, _, size, t in texts}
    assert sizes["SMPL-81JHYT"] == 28, "the code is scanned, not read"
    assert sizes["WAGO 2016-7607"] == 96, "the part number is the headline"
    assert sizes["TOPJOB S 2L-PE-KL.42GRAD"] == sizes["16QMM GR-GE"] == 50
    assert sizes["SP-0187 · EAN 4045454725112"] == 30
    # The code sits under the matrix in the left column; everything else in
    # the right column, clear of the 176-dot symbol (machine y = reading x + 24).
    code_y = next(y for _, y, _, t in texts if t == "SMPL-81JHYT")
    assert code_y == 36 + 24
    assert all(y == 252 + 24 for _, y, _, t in texts if t != "SMPL-81JHYT")
    assert 252 > al._DM_X + al._DM_SIZE


def test_long_head_and_description_shrink_and_a_missing_ean_leaves_only_the_number() -> None:
    # A 19-character part number is too wide for the headline size and shrinks.
    content = al.ArticleLabelContent("SMPL-AAAAAA", "HAGER K96W XL-200-A - Sammelschienenklemme 16-120mm² für die große Verteilung", "HAGER", "SP-0152", None)
    texts = _at_lines(al.render_article_label(VOLL, content))
    head = next(t for t in texts if t[3] == "HAGER K96W XL-200-A")
    assert al._HEAD_MIN <= head[2] < al._HEAD_MAX
    assert texts[-1][3] == "SP-0152"
    description_lines = [t for t in texts if t[3] not in ("SMPL-AAAAAA", head[3], "SP-0152")]
    assert len(description_lines) == 2
    assert description_lines[0][2] == description_lines[1][2] >= al._DESC_MIN


# ── Endpoint and batch ────────────────────────────────────────────────────────


def _configure_printer(monkeypatch: pytest.MonkeyPatch, host: str = "192.0.2.50") -> None:
    from app.core.config import get_settings

    monkeypatch.setattr(get_settings(), "werkstatt_label_printer_host", host)
    monkeypatch.setattr(get_settings(), "werkstatt_label_printer_port", 9100)


def test_endpoint_prints_the_shelf_layout(client: TestClient, admin_token: str, monkeypatch: pytest.MonkeyPatch) -> None:
    _configure_printer(monkeypatch)
    sent: list[bytes] = []
    monkeypatch.setattr(werkstatt_labels, "_send_tcp", lambda host, port, payload: sent.append(payload))
    created = client.post(
        "/api/werkstatt/articles",
        headers=auth_headers(admin_token),
        json={"item_name": "WAGO 2009-305 - SAMMELSCHIENENTRAeGER FUeR TS 35", "manufacturer": "WAGO", "unit": "ST", "ean": "4044918970020"},
    )
    assert created.status_code == 200, created.text
    article = created.json()

    printed = client.post(f"/api/werkstatt/articles/{article['id']}/print-label", headers=auth_headers(admin_token))
    assert printed.status_code == 200, printed.text
    code = printed.json()["internal_code"]
    text = sent[0].decode("utf-8")
    assert f"XRB202,60,11,0,11\r\n{code}\r\n" in text
    assert ",96,96,0,1E,0,0,WAGO 2009-305\r\n" in text
    # The description wraps to two lines at one size.
    assert ",50,50,0,1E,0,0,SAMMELSCHIENENTRAeGER\r\n" in text and ",50,50,0,1E,0,0,FUeR TS 35\r\n" in text
    assert f"{article['article_number']} · EAN 4044918970020" in text
    assert "~EB" not in text and "SMPL Energy" not in text


def test_wrong_stock_is_refused_and_a_batch_goes_out_in_one_connection(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.core.db import SessionLocal

    _configure_printer(monkeypatch)
    calls: list[bytes] = []
    monkeypatch.setattr(werkstatt_labels, "_send_tcp", lambda host, port, payload: calls.append(payload))
    contents = [
        al.ArticleLabelContent("SMPL-000001", "WAGO 2003-7641 - TOPJOB S IEK NT/L/PE 2,5/4QMM", "WAGO", "SP-0189", "4044918925587"),
        al.ArticleLabelContent("SMPL-000002", "WAGO 2003-7642 - TOPJOB S IEK L/L 2,5/4QMM GRAU", "WAGO", "SP-0188", "4044918925594"),
    ]
    strip = next(profile for profile in DEFAULT_MATERIALS if profile.continuous)
    with SessionLocal() as db:
        monkeypatch.setattr(al, "active_material", lambda db: strip)
        with pytest.raises(werkstatt_labels.LabelFormatUnsupported):
            al.print_article_labels(db, contents)
        assert calls == []

        monkeypatch.setattr(al, "active_material", lambda db: VOLL)
        sheets, printer = al.print_article_labels(db, contents)
    assert (sheets, printer) == (2, "192.0.2.50:9100")
    assert len(calls) == 1
    assert calls[0].count(b"\r\nE\r\n") == 2 and b"SMPL-000001" in calls[0] and b"SMPL-000002" in calls[0]


# ── Preview ───────────────────────────────────────────────────────────────────


def test_preview_is_a_png_of_the_sheet() -> None:
    from io import BytesIO

    from PIL import Image

    png = al.preview_article_label_png(al.ArticleLabelContent("SMPL-81JHYT", "WAGO 2016-7607 - TOPJOB S", "WAGO", "SP-0187", None))
    assert png[:8] == b"\x89PNG\r\n\x1a\n"
    image = Image.open(BytesIO(png))
    assert image.size == (99 * 12, 44 * 12)
    # Something dark was drawn where the matrix goes and where the head goes.
    assert image.getpixel((al._DM_X, al._DM_Y + al._DM_SIZE - 1)) == 0  # the finder's bottom-left corner
