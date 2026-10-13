"""Every SMPL job states its baseline; the guard keeps it on the material.

The golden jobs were captured from the renderers of a9c335f before this
change (tests/fixtures/label_jobs_a9c335f.json). Accepted byte changes, and
nothing else: the header gains ``^H ^S ^E ^C ^P1`` after ``^Q``/``^W``, a
copies job ends with a ``^C1`` reset, ``_clean`` blanks ``~``/``^``, and
``Lo`` lines that would leave the media are clamped (none in the goldens).
"""

from __future__ import annotations

import json
import re
from dataclasses import replace
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.core.db import SessionLocal
from app.services import schaltplan_type_label as tl
from app.services import werkstatt_article_labels as art
from app.services import werkstatt_box_labels as box
from app.services import werkstatt_label_jobs as jobs
from app.services import werkstatt_labels as wl
from app.services.werkstatt_label_builtins import DEFAULT_MATERIALS
from app.services.werkstatt_label_errors import LabelLayoutOutOfBounds, MaterialValidationError
from app.services.werkstatt_label_jobs import dry_render_checks, dry_render_samples, fit_to_media, offset_limits
from app.services.werkstatt_label_materials import get_label_printer_config, material_by_id
from app.services.werkstatt_label_patterns import pattern_supported
from app.services.werkstatt_label_profile import MaterialProfile
from tests.conftest import auth_headers
from tests.label_calibration_helpers import A, settings

GOLDEN = json.loads((Path(__file__).parent / "fixtures" / "label_jobs_a9c335f.json").read_text(encoding="utf-8"))
COPIES = {"211_freetext_X1_copies3": 3, "804_type_label_copies2": 2}
MACHINE = wl.LabelContent("M-0042", "Makita Akkuschrauber DDF485", "Makita", "SN123456")


def render_golden(materials: list[MaterialProfile]) -> dict[str, list[str]]:
    m = {profile.id: profile for profile in materials}
    p804 = m["wago-210-804"]
    return {
        "804_machine_label": wl._render_voll(p804, MACHINE),
        "804_quad_four": wl._render_quad(p804, [MACHINE] * 4),
        "812_kompakt": wl._render_kompakt(m["wago-210-812"], MACHINE),
        "805_mini_F1.1": wl._render_mini(m["wago-210-805"], "F1.1"),
        "2009_rail_strip": wl._render_rail_strip(m["wago-2009-110"], [("F1", 17.5), ("F2", 35)], size=36),
        "2009_block_label": wl._render_block_label(
            m["wago-2009-110"], name="PV Wechselrichter", x_label="X1",
            cells=[("N", 5), ("L1", 5), ("L2", 5), ("L3", 5), ("PE", 5)],
        ),
        "211_freetext_X1_copies3": wl._render_mini(m["wago-211-501"], "X1", copies=3),
        "804_article_label": art.render_article_label(
            p804, art.ArticleLabelContent("SMPL-81JHYT", "WAGO 2016-7607 - TOPJOB S 2L-PE", "WAGO", "SP-0187", "4045454545454")
        ),
        "804_box_label": box.render_box_label(p804, box.BoxLabelContent("KISTE-BK-2026-0001", "BK-2026-0001", "Kiste Wallbox"))[0],
        "804_type_label_copies2": tl.render_type_label(
            p804, tl.TypeLabelContent("Familie Schulze", "381", "09.2026", "VT-0001"), copies=2
        )[0],
    }


def _split(job: list[str]) -> tuple[list[str], list[str], list[str]]:
    """(header, elements, tail from the final E on)."""
    start = job.index("^L")
    end = len(job) - 1 - job[::-1].index("E")
    return job[:start], job[start + 1:end], job[end:]


def test_golden_jobs_gain_exactly_the_baseline_header() -> None:
    new = render_golden(list(DEFAULT_MATERIALS))
    assert set(new) == set(GOLDEN)
    for name, old in GOLDEN.items():
        copies = COPIES.get(name, 1)
        assert new[name][:2] == old[:2], name
        assert new[name][2:7] == ["^H12", "^S2", "^E0", f"^C{copies}", "^P1"], name
        assert new[name][7] == "^L", name
        assert _split(new[name])[1] == _split(old)[1], f"{name}: element lines changed"
        assert _split(new[name])[2] == (["E", "^C1"] if copies > 1 else ["E"]), name


def test_baseline_and_override_resolve_into_every_job(client: TestClient, admin_token: str) -> None:
    revision = settings(client, admin_token)["revision"]
    response = client.put(f"{A}/printer", headers=auth_headers(admin_token), json={"revision": revision, "baseline": {"darkness": 10}})
    assert response.status_code == 200, response.text
    with SessionLocal() as db:
        materials = get_label_printer_config(db)["materials"]
    for name, job in render_golden(materials).items():
        assert job[2] == "^H10", name

    revision = response.json()["revision"]
    response = client.put(f"{A}/materials/wago-2009-110", headers=auth_headers(admin_token), json={"revision": revision, "darkness": 8, "speed_ips": 3})
    assert response.status_code == 200, response.text
    with SessionLocal() as db:
        strip_profile = material_by_id(db, "wago-2009-110")  # what BMK strips print with, whatever is active
        materials = get_label_printer_config(db)["materials"]
    strip = wl._render_rail_strip(strip_profile, [("F1", 17.5)], size=36)
    assert strip[2:5] == ["^H8", "^S3", "^E0"]
    assert render_golden(materials)["804_machine_label"][2] == "^H10"  # the override is per material


def test_mark_profile_header() -> None:
    mark = MaterialProfile(id="custom-mark", name="Marke", part_no="", width_mm=40, length_mm=25, mark_width_mm=4, mark_offset_mm=3)
    job = wl._render_mini(mark, "X1")
    assert job[:2] == ["^Q25,4,3+", "^W40"]


def test_header_switches(monkeypatch) -> None:
    p804 = DEFAULT_MATERIALS[0]
    with_all = wl._render_voll(p804, MACHINE)
    monkeypatch.setattr(jobs, "JOB_HEADER_SENDS_STOP", False)
    without_stop = wl._render_voll(p804, MACHINE)
    assert "^E0" not in without_stop and len(without_stop) == len(with_all) - 1
    monkeypatch.setattr(jobs, "JOB_HEADER_SENDS_STOP", True)
    monkeypatch.setattr(jobs, "JOB_HEADER_SENDS_P1", False)
    without_p1 = wl._render_voll(p804, MACHINE)
    assert without_p1 == [line for line in with_all if line != "^P1"]


def test_clean_blanks_command_prefixes() -> None:
    assert wl._clean("A~B^C\r\nD", 40) == "A B C D"


def test_across_offset_shifts_machine_x() -> None:
    # +1 mm is inside the limits of 210-804 (+1,0) and 210-812 (+1,2) only.
    shifted_materials = [
        replace(profile, across_offset_mm=1.0) if profile.id in ("wago-210-804", "wago-210-812") else profile
        for profile in DEFAULT_MATERIALS
    ]
    m = {profile.id: profile for profile in shifted_materials}
    shifted = {
        "804_machine_label": wl._render_voll(m["wago-210-804"], MACHINE),
        "804_article_label": art.render_article_label(
            m["wago-210-804"], art.ArticleLabelContent("SMPL-81JHYT", "WAGO 2016-7607 - TOPJOB S 2L-PE", "WAGO", "SP-0187", "4045454545454")
        ),
        "804_box_label": box.render_box_label(m["wago-210-804"], box.BoxLabelContent("KISTE-BK-2026-0001", "BK-2026-0001", "Kiste Wallbox"))[0],
        "812_kompakt": wl._render_kompakt(m["wago-210-812"], MACHINE),
    }
    for name in shifted:
        old_elements = _split(GOLDEN[name])[1]
        new_elements = _split(shifted[name])[1]
        assert len(old_elements) == len(new_elements), name
        for old, new in zip(old_elements, new_elements):
            if old.startswith("AT,"):
                assert int(new.split(",")[1]) == int(old.split(",")[1]) + 12, name
            elif old.startswith("XRB") or (old.startswith("Y") and re.match(r"^Y\d+,", old)):
                assert int(re.match(r"^\D+(\d+)", new).group(1)) == int(re.match(r"^\D+(\d+)", old).group(1)) + 12, name


# ── The guard ──────────────────────────────────────────────────────────────

P804 = DEFAULT_MATERIALS[0]  # h_px 528, form length 1188


def test_lo_is_clamped_or_dropped() -> None:
    out = fit_to_media(P804, ["Lo,500,10,540,20", "Lo,600,10,700,20", "Lo,10,1180,20,1200", "Lo,0,0,528,1188"], form_length_dots=1188)
    assert out == ["Lo,500,10,528,20", "Lo,10,1180,20,1188", "Lo,0,0,528,1188"]


def test_text_leaving_the_material_raises() -> None:
    with pytest.raises(LabelLayoutOutOfBounds) as raised:
        fit_to_media(P804, ["AT,20,100,36,36,0,1E,0,0,X"], form_length_dots=1188)  # em box [-16, 20]
    assert str(raised.value) == "Druckbild läge außerhalb des Materials – Versatz im Material-Profil prüfen"
    with pytest.raises(LabelLayoutOutOfBounds):
        fit_to_media(P804, ["AT,540,100,36,36,0,1E,0,0,X"], form_length_dots=1188)
    assert fit_to_media(P804, ["AT,36,100,36,36,0,1E,0,0,X"], form_length_dots=1188) == ["AT,36,100,36,36,0,1E,0,0,X"]


@pytest.mark.parametrize("line", ["AT,100,1190,24,24,0,1E,0,0,X", "XRB100,1190,9,0,6", "Y100,1190,SMPL0000", "AT,100,-1,24,24,0,1E,0,0,X"])
def test_die_cut_y_beyond_the_form_raises(line: str) -> None:
    lines = [line, "M-0042"] if line.startswith("XRB") else [line]
    with pytest.raises(LabelLayoutOutOfBounds):
        fit_to_media(P804, lines, form_length_dots=1188)


def test_matrix_data_line_passes_untouched() -> None:
    lines = ["XRB180,72,14,0,6", "Lo,9999,0,1,1"]  # the data line after XRB is data, not a rule
    assert fit_to_media(P804, lines, form_length_dots=1188) == lines


def test_no_golden_job_is_clamped_or_raises() -> None:
    new = render_golden(list(DEFAULT_MATERIALS))
    for name, old in GOLDEN.items():
        assert _split(new[name])[1] == _split(old)[1], name


@pytest.mark.parametrize("material_id", ["wago-2009-110", "wago-211-501", "wago-210-812"])
def test_dry_render_checks_follow_the_limits(material_id: str) -> None:
    profile = next(m for m in DEFAULT_MATERIALS if m.id == material_id)
    limits = offset_limits(profile)
    for x_offset in (-5.0, 10.0):
        candidate = replace(profile, x_offset_mm=x_offset)
        inside = limits.x_min <= x_offset <= limits.x_max
        _assert_checks(candidate, inside)
    for across in (-5.0, 5.0):
        candidate = replace(profile, across_offset_mm=across)
        inside = limits.across_min <= across <= limits.across_max
        _assert_checks(candidate, inside)


def _assert_checks(profile: MaterialProfile, inside: bool) -> None:
    if inside:
        dry_render_checks(profile)
        _render_all(profile)
    else:
        with pytest.raises(MaterialValidationError) as raised:
            dry_render_checks(profile)
        assert "muss für dieses Material zwischen" in str(raised.value)
        with pytest.raises(LabelLayoutOutOfBounds):
            _render_all(profile)


def _render_all(profile: MaterialProfile) -> None:
    for render in dry_render_samples(profile, pattern=pattern_supported(profile)):
        render(profile)


def test_the_samples_render_at_every_corner_of_the_limits() -> None:
    for profile in DEFAULT_MATERIALS:
        limits = offset_limits(profile)
        for x_offset in (limits.x_min, limits.x_max):
            for across in (limits.across_min, limits.across_max):
                _render_all(replace(profile, x_offset_mm=x_offset, across_offset_mm=across))


def test_builtin_limits_are_inside_the_static_ranges_and_contain_the_defaults() -> None:
    for profile in DEFAULT_MATERIALS:
        limits = offset_limits(profile)
        assert -5 <= limits.x_min <= 2.0 <= limits.x_max <= 10, profile.id
        assert -5 <= limits.across_min <= 0 <= limits.across_max <= 5, profile.id


def test_send_from_fake_printer_counts_pieces(client: TestClient, admin_token: str, fake_printer) -> None:
    """^C and ^P are permanent and multiply; SMPL's header and reset keep both at one."""
    from tests.fake_ezpl_printer import configure_fake

    configure_fake(client, admin_token, fake_printer)
    fake_printer.raw_job(["^P2", "^Q20,0", "^W11", "^L", "AT,100,30,36,36,0,1E,0,0,T5c", "E"])
    assert fake_printer.pieces_printed[-1] == 2  # another client's ^P2 …
    response = client.post(f"{A}/test", headers=auth_headers(admin_token))
    assert response.status_code == 200 and response.json()["ok"] is True, response.text
    fake_printer.wait_for_jobs(2)
    assert fake_printer.pieces_printed[-1] == 1  # … cannot double an SMPL print

    patch = client.patch(A, headers=auth_headers(admin_token), json={"active_material_id": "wago-2009-110"})
    assert patch.status_code == 200, patch.text
    response = client.post(f"{A}/freetext", headers=auth_headers(admin_token), json={"text": "X1", "copies": 3})
    assert response.status_code == 200 and response.json()["ok"] is True, response.text
    fake_printer.wait_for_jobs(3)
    assert fake_printer.pieces_printed[-1] == 3
    fake_printer.raw_job(["^Q20,0", "^W11", "^L", "AT,100,30,36,36,0,1E,0,0,T5b", "E"])
    assert fake_printer.pieces_printed[-1] == 1  # SMPL's trailing ^C1 reset its own ^C3
