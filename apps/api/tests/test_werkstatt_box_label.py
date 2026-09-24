"""The crate sticker — ``services/werkstatt_box_labels``.

What must hold: the DataMatrix is anchored for the symbol the code really
needs (an 18 × 18 for "KISTE-BK-2026-0001", not the machine label's 12 × 12),
the code sits small under it inside the left column, the crate number is the
headline and stops short of the logo box, a short name stays on one line and
a long one wraps to two, the endpoint ships this layout, and the preview is a
PNG of the sheet.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.services import werkstatt_box_labels as bl
from app.services import werkstatt_labels
from app.services.werkstatt_label_materials import DEFAULT_MATERIALS
from tests.conftest import auth_headers

VOLL = DEFAULT_MATERIALS[0]
FRAME_W = 99 * 12


@pytest.fixture(autouse=True)
def _label_logo(monkeypatch: pytest.MonkeyPatch) -> None:
    from pathlib import Path

    from app.core.config import get_settings

    logo = Path(__file__).resolve().parents[1] / "app" / "assets" / "logo.jpeg"
    monkeypatch.setattr(get_settings(), "report_logo_path", str(logo))
    werkstatt_labels._logo_asset.cache_clear()


def _at_lines(job: list[str]) -> list[tuple[int, int, int, str]]:
    out = []
    for line in job:
        if line.startswith("AT,"):
            parts = line.split(",", 9)
            out.append((int(parts[1]), int(parts[2]), int(parts[3]), parts[9]))
    return out


@pytest.mark.parametrize(
    ("code", "codewords", "modules"),
    [
        ("M-0062", 4, 12),
        ("KISTE-K4", 8, 14),
        ("SMPL-81JHYT", 10, 16),  # "81" packs into one codeword
        ("KISTE-BK-2026-0001", 14, 18),
        ("VT-0007", 5, 12),
    ],
)
def test_symbol_size_follows_the_codes_ascii_codewords(code: str, codewords: int, modules: int) -> None:
    assert bl.datamatrix_codewords(code) == codewords
    assert bl.datamatrix_symbol_modules(code) == modules


def test_the_matrix_is_anchored_for_its_real_symbol_and_the_code_stays_in_the_left_column() -> None:
    job, assets = bl.render_box_label(VOLL, bl.BoxLabelContent("KISTE-BK-2026-0001", "BK-2026-0001", "Kiste Wallbox Müller Garage"))
    module, modules = bl._module_for("KISTE-BK-2026-0001")
    assert (module, modules) == (11, 18)
    symbol = module * modules  # 198 dots — inside the 200-dot box
    # Reading bottom = 96 + 198 = 294 → machine x = 528 - 294; reading left 36 → machine y = 36 + 24.
    assert f"XRB{528 - (bl._DM_Y + symbol)},{bl._DM_X + 24},{module},0,18" in job
    assert job[job.index(f"XRB{528 - (bl._DM_Y + symbol)},{bl._DM_X + 24},{module},0,18") + 1] == "KISTE-BK-2026-0001"

    texts = _at_lines(job)
    assert [t for _, _, _, t in texts] == ["KISTE-BK-2026-0001", "BK-2026-0001", "Kiste Wallbox Müller Garage", "Baustellenkiste"]
    code_x, code_y, code_size, _ = texts[0]
    # The code text starts under the matrix and never reaches the text column.
    assert code_y == bl._DM_X + 24 and code_x == 528 - (bl._DM_Y + symbol + 14)
    assert werkstatt_labels._est_text_w("KISTE-BK-2026-0001", code_size) <= bl._COL_X - bl._DM_X
    # The headline is fitted so it ends before the logo box on the right.
    _, head_y, head_size, head = texts[1]
    assert head_y == bl._COL_X + 24
    assert bl._COL_X + werkstatt_labels._est_text_w(head, head_size) <= FRAME_W - bl._LOGO_X - bl._LOGO_BOX_W - 20
    assert head_size > code_size
    # One logo, placed in the top-right box.
    assert assets[0] is not None and assets[0][2] <= bl._LOGO_BOX_W and assets[0][3] <= bl._LOGO_BOX_H
    assert sum(1 for line in job if line.startswith("Y")) == 1


def test_a_short_name_stays_on_one_line_and_a_long_one_wraps() -> None:
    short = _at_lines(bl.render_box_label(VOLL, bl.BoxLabelContent("KISTE-K4", "K4", "Kiste 4"))[0])
    assert [t for _, _, _, t in short] == ["KISTE-K4", "K4", "Kiste 4", "Baustellenkiste"]
    assert bl._module_for("KISTE-K4") == (12, 14)

    long = _at_lines(
        bl.render_box_label(VOLL, bl.BoxLabelContent("KISTE-BK-2026-0002", "BK-2026-0002", "Kiste Sanierung Mehrfamilienhaus Hagen Dachgeschoss"))[0]
    )
    name_lines = [t for _, _, _, t in long][2:-1]
    assert len(name_lines) == 2 and " ".join(name_lines) == "Kiste Sanierung Mehrfamilienhaus Hagen Dachgeschoss"


def test_endpoint_prints_the_crate_layout(client: TestClient, admin_token: str, monkeypatch: pytest.MonkeyPatch) -> None:
    from app.core.config import get_settings

    monkeypatch.setattr(get_settings(), "werkstatt_label_printer_host", "192.0.2.50")
    monkeypatch.setattr(get_settings(), "werkstatt_label_printer_port", 9100)
    sent: list[bytes] = []
    monkeypatch.setattr(werkstatt_labels, "_send_tcp", lambda host, port, payload: sent.append(payload))

    created = client.post("/api/werkstatt/boxes", headers=auth_headers(admin_token), json={"label": "Kiste Wallbox"})
    assert created.status_code == 200, created.text
    box = created.json()

    printed = client.post(f"/api/werkstatt/boxes/{box['id']}/print-label", headers=auth_headers(admin_token))
    assert printed.status_code == 200, printed.text
    assert printed.json()["code"] == f"KISTE-{box['box_number']}"
    # The payload opens with the logo's binary download; only the job text matters here.
    text = sent[0].decode("utf-8", "replace")
    code = f"KISTE-{box['box_number']}"
    module, _modules = bl._module_for(code)
    assert f",{module},0,{len(code)}\r\n{code}\r\n" in text
    assert f",0,1E,0,0,{box['box_number']}\r\n" in text
    assert ",0,1E,0,0,Kiste Wallbox\r\n" in text and ",0,1E,0,0,Baustellenkiste\r\n" in text
    # Not the machine layout any more: no footer line, no "SN:" serial.
    assert "SMPL Energy" not in text and "SN:" not in text


def test_preview_is_a_png_of_the_sheet_with_the_symbol_where_the_job_puts_it() -> None:
    from io import BytesIO

    from PIL import Image

    png = bl.preview_box_label_png(bl.BoxLabelContent("KISTE-BK-2026-0001", "BK-2026-0001", "Kiste"))
    assert png[:8] == b"\x89PNG\r\n\x1a\n"
    image = Image.open(BytesIO(png))
    assert image.size == (FRAME_W, 44 * 12)
    module, modules = bl._module_for("KISTE-BK-2026-0001")
    assert image.getpixel((bl._DM_X, bl._DM_Y + module * modules - 1)) == 0  # the finder's bottom-left corner
