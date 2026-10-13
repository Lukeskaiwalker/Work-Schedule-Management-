"""Material profiles: overrides-only storage, migration, validation, the API.

Builtins are stored as the keys an admin changed — nothing else — so a
corrected default in code reaches every install that did not touch that
field. Format-1 blobs (all keys of every builtin) are migrated at read time.
Every range is checked in the service with a German text (the input schemas
carry types only), PUT/PATCH answer the shapes the client branches on, and
the sensor scale reading behaves as §3.2/§3.8 say.
"""

from __future__ import annotations

import json
from dataclasses import replace

import pytest
from fastapi.testclient import TestClient

from app.core.db import SessionLocal
from app.services import werkstatt_label_materials as materials_module
from app.services.runtime_settings import (
    WERKSTATT_LABEL_PRINTER_KEY,
    WERKSTATT_LABEL_PRINTER_STATE_KEY,
    get_runtime_setting,
    set_runtime_setting,
)
from app.services.werkstatt_label_builtins import DEFAULT_MATERIALS
from app.services.werkstatt_label_materials import get_label_printer_config
from app.services.werkstatt_label_profile import MediaWeb, format_scale_de
from tests.conftest import auth_headers
from tests.label_calibration_helpers import A, settings


def _write_raw(blob: dict) -> None:
    with SessionLocal() as db:
        set_runtime_setting(db, WERKSTATT_LABEL_PRINTER_KEY, json.dumps(blob))
        db.commit()


def _stored() -> dict:
    with SessionLocal() as db:
        return json.loads(get_runtime_setting(db, WERKSTATT_LABEL_PRINTER_KEY) or "{}")


def _config() -> dict:
    with SessionLocal() as db:
        return get_label_printer_config(db)


def _by_id(body: dict) -> dict:
    return {material["id"]: material for material in body["materials"]}


def _put(client: TestClient, token: str, material_id: str, **body) -> object:
    revision = body.pop("revision", None)
    if revision is None:
        revision = settings(client, token)["revision"]
    return client.put(f"{A}/materials/{material_id}", headers=auth_headers(token), json={"revision": revision, **body})


def _v1_blob() -> dict:
    """The format-1 shape of a9c335f: every key of every builtin stored."""
    entries = []
    for profile in DEFAULT_MATERIALS:
        entries.append({
            "id": profile.id, "name": profile.name, "part_no": profile.part_no, "width_mm": profile.width_mm,
            "length_mm": profile.length_mm, "gap_mm": 3.0,
            "x_offset_mm": 1.5 if profile.id == "wago-210-804" else 2.0, "darkness": None,
        })
    return {"host": "192.0.2.50", "port": 9100, "active_material_id": "wago-210-804", "materials": entries}


# ── Reading ────────────────────────────────────────────────────────────────


def test_legacy_v1_blob_keeps_only_the_real_override(client: TestClient) -> None:
    _write_raw(_v1_blob())
    config = _config()
    assert config["revision"] == 0
    assert config["overrides"]["wago-210-804"] == frozenset({"x_offset_mm"})
    assert all(not config["overrides"][m.id] for m in DEFAULT_MATERIALS if m.id != "wago-210-804")
    p804 = next(p for p in config["materials"] if p.id == "wago-210-804")
    assert p804.x_offset_mm == 1.5
    assert (p804.sensor_mode, p804.sensor_scale, p804.guide, p804.roller) == ("see_through", 3.4, "max", "258-5006")


def test_write_stores_format_2_with_only_overrides(client: TestClient, admin_token: str) -> None:
    _write_raw(_v1_blob())
    response = client.patch(A, headers=auth_headers(admin_token), json={"active_material_id": "wago-210-812"})
    assert response.status_code == 200, response.text
    stored = _stored()
    assert stored["format"] == 2
    assert stored["revision"] == 1
    entries = {entry["id"]: entry for entry in stored["materials"]}
    assert entries["wago-210-804"] == {"id": "wago-210-804", "x_offset_mm": 1.5}
    assert entries["wago-2009-110"] == {"id": "wago-2009-110"}
    assert stored["host"] == "192.0.2.50"  # PATCH without host keeps it


def test_builtin_defaults_heal_after_a_save(client: TestClient, admin_token: str, monkeypatch) -> None:
    assert _put(client, admin_token, "wago-2009-110", x_offset_mm=1.0).status_code == 200
    strip = next(m for m in DEFAULT_MATERIALS if m.id == "wago-2009-110")
    patched = replace(strip, web=MediaWeb(liner_width_mm=11.5, source="catalogue"))
    monkeypatch.setattr(materials_module, "_BUILTINS", {**materials_module._BUILTINS, "wago-2009-110": patched})
    profile = next(p for p in _config()["materials"] if p.id == "wago-2009-110")
    assert profile.web.liner_width_mm == 11.5  # the new code default arrives
    assert profile.x_offset_mm == 1.0  # the override stays


def test_malformed_values_fall_back_per_field(client: TestClient) -> None:
    blob = {"format": 2, "materials": [
        {"id": "wago-210-804", "sensor_mode": "laser", "x_offset_mm": 1.6},
        {"id": "wago-210-812", "sensor_scale": "rechts"},
        {"id": "wago-210-805", "sensor_scale": 9.0},
        {"id": "custom-a", "name": "A", "width_mm": 23, "length_mm": 38, "sensor_mode": "laser", "sensor_scale": "rechts"},
    ]}
    _write_raw(blob)
    by_id = {p.id: p for p in _config()["materials"]}
    assert by_id["wago-210-804"].sensor_mode == "see_through" and by_id["wago-210-804"].x_offset_mm == 1.6
    assert by_id["wago-210-812"].sensor_scale == 3.4
    assert by_id["wago-210-805"].sensor_scale == 3.4
    assert by_id["custom-a"].sensor_mode == "auto" and by_id["custom-a"].sensor_scale == 3.4


def test_format_2_override_without_width_survives(client: TestClient) -> None:
    _write_raw({"format": 2, "materials": [{"id": "wago-210-804", "x_offset_mm": 1.6}, {"id": "custom-x", "name": "ohne Breite", "length_mm": 30}]})
    config = _config()
    p804 = next(p for p in config["materials"] if p.id == "wago-210-804")
    code = DEFAULT_MATERIALS[0]
    assert p804.x_offset_mm == 1.6
    assert (p804.width_mm, p804.length_mm, p804.name, p804.web) == (code.width_mm, code.length_mm, code.name, code.web)
    assert "custom-x" not in {p.id for p in config["materials"]}  # a custom entry needs a width


# ── PATCH list semantics and errors ────────────────────────────────────────


def test_patch_list_semantics(client: TestClient, admin_token: str) -> None:
    body = settings(client, admin_token)
    custom = {"id": "custom-38x23", "name": "Fremdetikett 38 × 23", "width_mm": 23, "length_mm": 38}
    created = client.patch(A, headers=auth_headers(admin_token), json={"materials": body["materials"] + [custom]})
    assert created.status_code == 200, created.text
    made = _by_id(created.json())["custom-38x23"]
    assert (made["sensor_mode"], made["sensor_scale"], made["feed_path"], made["guide"]) == ("auto", 3.4, "internal", "fit")

    removed = client.patch(A, headers=auth_headers(admin_token), json={"materials": body["materials"]})
    assert removed.status_code == 200, removed.text
    assert "custom-38x23" not in _by_id(removed.json())

    without_804 = [m for m in body["materials"] if m["id"] != "wago-210-804"]
    refused = client.patch(A, headers=auth_headers(admin_token), json={"materials": without_804})
    assert refused.status_code == 400
    assert refused.json()["detail"] == "Mitgeliefertes Material wago-210-804 kann nicht entfernt werden"

    unknown = client.patch(A, headers=auth_headers(admin_token), json={"active_material_id": "gibt-es-nicht"})
    assert unknown.status_code == 400
    assert unknown.json()["detail"] == "Unbekanntes Material: gibt-es-nicht"


@pytest.mark.parametrize(("width", "length"), [(40, 100), (36, 99), (6, 50)])
def test_ordinary_custom_sizes_can_be_saved_and_renamed(client: TestClient, admin_token: str, width: int, length: int) -> None:
    """The dry render refused every offset for these sizes (its range was
    empty), so "+ Eigenes Material" could not save them at all."""
    body = settings(client, admin_token)
    custom = {"id": "custom-x", "name": f"Fremd {width}x{length}", "width_mm": width, "length_mm": length}
    created = client.patch(A, headers=auth_headers(admin_token), json={"materials": body["materials"] + [custom]})
    assert created.status_code == 200, created.text
    limits = _by_id(created.json())["custom-x"]["offset_limits"]
    assert limits["x_min"] <= 0 <= limits["x_max"] and limits["across_min"] <= 0 <= limits["across_max"], limits
    renamed = [{**item, "name": "Umbenannt"} if item["id"] == "custom-x" else item for item in created.json()["materials"]]
    again = client.patch(A, headers=auth_headers(admin_token), json={"materials": renamed})
    assert again.status_code == 200, again.text
    assert _by_id(again.json())["custom-x"]["name"] == "Umbenannt"


def test_echo_of_the_get_shape_changes_nothing_but_the_revision(client: TestClient, admin_token: str) -> None:
    assert _put(client, admin_token, "wago-210-804", x_offset_mm=1.6, sensor_scale=3.6).status_code == 200
    body = settings(client, admin_token)
    before = _stored()
    echoed = client.patch(A, headers=auth_headers(admin_token), json={"materials": body["materials"], "revision": body["revision"]})
    assert echoed.status_code == 200, echoed.text
    after = _stored()
    assert after["revision"] == before["revision"] + 1
    assert {**after, "revision": 0} == {**before, "revision": 0}


def test_echo_after_a_baseline_change_keeps_darkness_null(client: TestClient, admin_token: str) -> None:
    revision = settings(client, admin_token)["revision"]
    assert client.put(f"{A}/printer", headers=auth_headers(admin_token), json={"revision": revision, "baseline": {"darkness": 10}}).status_code == 200
    body = settings(client, admin_token)
    p804 = _by_id(body)["wago-210-804"]
    assert p804["darkness"] is None and p804["resolved"]["darkness"] == 10
    assert client.patch(A, headers=auth_headers(admin_token), json={"materials": body["materials"]}).status_code == 200
    assert _by_id(settings(client, admin_token))["wago-210-804"]["darkness"] is None


def test_patch_host_semantics(client: TestClient, admin_token: str) -> None:
    assert client.patch(A, headers=auth_headers(admin_token), json={"host": "192.0.2.9", "port": 9101}).status_code == 200
    kept = client.patch(A, headers=auth_headers(admin_token), json={"active_material_id": "wago-210-812"})
    assert (kept.json()["host"], kept.json()["port"]) == ("192.0.2.9", 9101)
    cleared = client.patch(A, headers=auth_headers(admin_token), json={"host": ""})
    assert cleared.json()["configured"] is False


def test_patch_error_table(client: TestClient, admin_token: str) -> None:
    body = settings(client, admin_token)
    stale = client.patch(A, headers=auth_headers(admin_token), json={"active_material_id": "wago-210-812", "revision": body["revision"] + 5})
    assert stale.status_code == 409
    assert stale.json()["detail"] == {
        "code": "stale_revision", "message": "Einstellungen wurden inzwischen geändert – bitte neu laden", "revision": body["revision"],
    }
    items = [dict(m) for m in body["materials"]]
    for item in items:
        if item["id"] == "wago-210-804":
            item.update(sensor_mode=None, across_offset_mm=None, sensor_scale=None, guide=None)
    kept = client.patch(A, headers=auth_headers(admin_token), json={"materials": items})
    assert kept.status_code == 200, kept.text
    p804 = _by_id(kept.json())["wago-210-804"]
    assert (p804["sensor_mode"], p804["across_offset_mm"], p804["sensor_scale"], p804["guide"]) == ("see_through", 0.0, 3.4, "max")

    wrong_type = client.patch(A, headers=auth_headers(admin_token), json={"materials": [{**items[0], "sensor_mode": "laser"}]})
    assert wrong_type.status_code == 422 and isinstance(wrong_type.json()["detail"], list)


# ── PUT material ───────────────────────────────────────────────────────────


def test_put_reset_fields_and_nulls(client: TestClient, admin_token: str) -> None:
    changed = _put(client, admin_token, "wago-210-804", x_offset_mm=1.6, darkness=9)
    assert changed.status_code == 200, changed.text
    assert sorted(_by_id(changed.json())["wago-210-804"]["overridden_fields"]) == ["darkness", "x_offset_mm"]
    reset = _put(client, admin_token, "wago-210-804", reset_fields=["x_offset_mm"])
    p804 = _by_id(reset.json())["wago-210-804"]
    assert (p804["x_offset_mm"], p804["darkness"], p804["overridden_fields"]) == (2.0, 9, ["darkness"])
    baseline = _put(client, admin_token, "wago-210-804", darkness=None)  # explicit null = baseline
    assert _by_id(baseline.json())["wago-210-804"]["darkness"] is None

    null_width = _put(client, admin_token, "wago-210-804", width_mm=None)
    assert null_width.status_code == 422
    assert null_width.json()["detail"] == {"code": "invalid_material", "message": "Feld width_mm darf nicht leer sein"}

    unknown = _put(client, admin_token, "gibt-es-nicht", x_offset_mm=1)
    assert unknown.status_code == 404 and unknown.json()["detail"]["code"] == "unknown_material"

    stale = _put(client, admin_token, "wago-210-804", x_offset_mm=1, revision=0)
    assert stale.status_code == 409 and stale.json()["detail"]["code"] == "stale_revision"


@pytest.mark.parametrize(
    ("material_id", "body", "message"),
    [
        ("wago-210-804", {"x_offset_mm": 12}, "Typenschilder 99 × 44 (silber): Versatz Vorschub muss zwischen −5 und 10 mm liegen"),
        ("wago-210-804", {"across_offset_mm": 6}, "Typenschilder 99 × 44 (silber): Versatz quer muss zwischen −5 und 5 mm liegen"),
        ("wago-210-804", {"speed_ips": 5}, "Typenschilder 99 × 44 (silber): Geschwindigkeit muss zwischen 2 und 4 liegen"),
        ("wago-210-804", {"stop_mm": 41}, "Typenschilder 99 × 44 (silber): Stopp-Position muss zwischen 0 und 40 mm liegen"),
        ("wago-210-804", {"sensor_mode": "none"}, "Typenschilder 99 × 44 (silber): „Kein Sensor“ geht nur bei Endlosmaterial – sonst findet der Drucker keine Etikettenspalte"),
        ("wago-2009-110", {"sensor_mode": "auto"}, "Beschriftungsstreifen 11 mm (TopJob, Endlos): Endlosmaterial braucht eine feste Sensorart (Durchlicht, Reflex oder kein Sensor)"),
        ("wago-2009-110", {"mark_width_mm": 4}, "Beschriftungsstreifen 11 mm (TopJob, Endlos): Schwarzmarken gibt es nur bei Etiketten mit fester Länge"),
        ("wago-210-804", {"mark_width_mm": 12}, "Typenschilder 99 × 44 (silber): Schwarzmarke: Breite 1–10 mm, Abstand 0–50 mm"),
        ("wago-210-804", {"sensor_scale": 5.6}, "Typenschilder 99 × 44 (silber): Sensorposition muss zwischen 0,5 und 5,5 auf der Skala liegen"),
        ("wago-210-804", {"sensor_scale": 0.4}, "Typenschilder 99 × 44 (silber): Sensorposition muss zwischen 0,5 und 5,5 auf der Skala liegen"),
        ("wago-210-804", {"web": {"lanes": 5}}, "Typenschilder 99 × 44 (silber): Rollenmaße ungültig"),
        ("wago-210-804", {"web": {"lanes": 2, "liner_width_mm": 50}}, "Typenschilder 99 × 44 (silber): Trägerbreite ist kleiner als die Etiketten nebeneinander"),
        ("wago-210-804", {"name": "x" * 61}, f"{'x' * 61}: Kennung 1–40, Name 1–60 und Artikelnummer bis 40 Zeichen"),
        ("wago-2009-110", {"x_offset_mm": -5}, "Beschriftungsstreifen 11 mm (TopJob, Endlos): Versatz Vorschub muss für dieses Material zwischen −2 und 10 mm liegen – sonst läge das Druckbild außerhalb des Materials"),
        ("wago-2009-110", {"across_offset_mm": 0.5}, "Beschriftungsstreifen 11 mm (TopJob, Endlos): Versatz quer muss für dieses Material zwischen −0,5 und 0,2 mm liegen – sonst läge das Druckbild außerhalb des Materials"),
    ],
)
def test_put_validation_messages(client: TestClient, admin_token: str, material_id: str, body: dict, message: str) -> None:
    response = _put(client, admin_token, material_id, **body)
    assert response.status_code == 422, response.text
    assert response.json()["detail"] == {"code": "invalid_material", "message": message}


def test_patch_item_range_is_a_german_400(client: TestClient, admin_token: str) -> None:
    items = settings(client, admin_token)["materials"]
    items = [{**item, "x_offset_mm": 12} if item["id"] == "wago-210-804" else item for item in items]
    response = client.patch(A, headers=auth_headers(admin_token), json={"materials": items})
    assert response.status_code == 400
    assert response.json()["detail"] == "Typenschilder 99 × 44 (silber): Versatz Vorschub muss zwischen −5 und 10 mm liegen"


# ── PUT printer ────────────────────────────────────────────────────────────


def test_printer_settings(client: TestClient, admin_token: str) -> None:
    body = settings(client, admin_token)
    assert body["label_calibration_staff_enabled"] is False
    assert body["baseline"] == {"darkness": 12, "speed_ips": 2, "stop_mm": 0}
    on = client.put(f"{A}/printer", headers=auth_headers(admin_token), json={"revision": body["revision"], "label_calibration_staff_enabled": True})
    assert on.status_code == 200, on.text
    assert on.json()["label_calibration_staff_enabled"] is True
    assert on.json()["revision"] == body["revision"] + 1

    bad = client.put(f"{A}/printer", headers=auth_headers(admin_token), json={"revision": on.json()["revision"], "baseline": {"speed_ips": 5}})
    assert bad.status_code == 422
    assert bad.json()["detail"] == {
        "code": "invalid_printer_settings",
        "message": "Grundeinstellung ungültig: Schwärzung 0–19, Geschwindigkeit 2–4, Stopp 0–40 mm",
    }
    offset = client.put(f"{A}/printer", headers=auth_headers(admin_token), json={"revision": on.json()["revision"], "row_offset_dots": 101})
    assert offset.json()["detail"]["message"] == "Zeilenversatz muss zwischen −100 und 100 Punkten liegen"
    pinned = client.put(f"{A}/printer", headers=auth_headers(admin_token), json={"revision": on.json()["revision"], "row_offset_dots": -19, "baseline": {"darkness": 11}})
    assert pinned.status_code == 200, pinned.text
    assert (pinned.json()["row_offset_dots"], pinned.json()["baseline"]["darkness"], pinned.json()["baseline_overridden"]) == (-19, 11, ["darkness"])
    back = client.put(f"{A}/printer", headers=auth_headers(admin_token), json={"revision": pinned.json()["revision"], "row_offset_dots": None, "baseline": {"darkness": None}})
    assert (back.json()["row_offset_dots"], back.json()["baseline"]["darkness"]) == (None, 12)


# ── Sensor scale ───────────────────────────────────────────────────────────


def test_sensor_scale_defaults_and_rounding(client: TestClient, admin_token: str) -> None:
    by_id = _by_id(settings(client, admin_token))
    for material_id in ("wago-210-804", "wago-210-824", "wago-210-812", "wago-210-805"):
        assert by_id[material_id]["sensor_scale"] == 3.4
    for material_id in ("wago-211-501", "wago-2009-110"):
        assert by_id[material_id]["sensor_scale"] == 3.0
    body = settings(client, admin_token)
    customs = [
        {"id": "custom-die", "name": "Etikett", "width_mm": 23, "length_mm": 38},
        {"id": "custom-roll", "name": "Band", "width_mm": 12, "length_mm": None},
    ]
    made = _by_id(client.patch(A, headers=auth_headers(admin_token), json={"materials": body["materials"] + customs}).json())
    assert (made["custom-die"]["sensor_scale"], made["custom-roll"]["sensor_scale"]) == (3.4, 3.0)
    assert made["custom-roll"]["sensor_mode"] == "see_through" and made["custom-roll"]["feed_path"] == "external"

    rounded = _put(client, admin_token, "wago-210-804", sensor_scale=3.44)
    assert _by_id(rounded.json())["wago-210-804"]["sensor_scale"] == 3.4
    null = _put(client, admin_token, "wago-210-804", sensor_scale=None)
    assert null.status_code == 422 and null.json()["detail"]["message"] == "Feld sensor_scale darf nicht leer sein"
    assert format_scale_de(3.4) == "3,4" and format_scale_de(3.0) == "3"


def test_sensor_scale_change_makes_the_record_stale(client: TestClient, admin_token: str) -> None:
    profile = next(p for p in _config()["materials"] if p.id == "wago-210-804")
    record = {"material_id": "wago-210-804", "kind": "quick", "at": "2026-10-20T09:12:00Z", "by_id": 1, "by_name": "Luca",
              "verdict": "match", "fresh": True, "freshness": "busy_seen", "accepted": False, "measured_length_dots": 1164,
              "measured_gap_dots": 30, "fingerprint": profile.fingerprint, "notes": ""}
    with SessionLocal() as db:
        set_runtime_setting(db, WERKSTATT_LABEL_PRINTER_STATE_KEY, json.dumps({"calibrations": {"wago-210-804": record}}))
        db.commit()
    assert _by_id(settings(client, admin_token))["wago-210-804"]["calibration"]["stale"] is False
    _put(client, admin_token, "wago-210-804", sensor_scale=3.6)
    calibration = _by_id(settings(client, admin_token))["wago-210-804"]["calibration"]
    assert calibration["stale"] is True
    assert calibration["measured_length_mm"] == 98.55  # 1164 dots at 300 dpi


def test_get_shape_and_hints(client: TestClient, admin_token: str) -> None:
    by_id = _by_id(settings(client, admin_token))
    for material in by_id.values():
        assert "sensor_mark" not in material and "sensor_offset_mm" not in material
        assert material["roller"] == "258-5006"
        position = [hint["text"] for hint in material["hints"] if hint["topic"] == "sensor_position"]
        assert any("ca." in text and "auf die Skala Ihres Druckers übertragen" in text for text in position), material["id"]
        has_photo = any("Foto 13.10.2026: Etiketten werden so korrekt erkannt" in text for text in position)
        assert has_photo is (material["sensor_scale"] == 3.4), material["id"]
    p805 = by_id["wago-210-805"]
    assert (p805["pattern_supported"], p805["pattern_cost_hint"], p805["web_width_mm"]) == (False, "", 34.0)
    assert by_id["wago-2009-110"]["pattern_cost_hint"] == "≈ 42 mm Streifen (Schätzung)"
    assert by_id["wago-211-501"]["pattern_cost_hint"] == "≈ 32 mm Schlauch (Schätzung)"
    assert by_id["wago-210-804"]["autosense_cost_hint"] == "voraussichtlich 2–3 Etiketten (≈ 20–30 cm, Schätzung)"
    assert by_id["wago-210-804"]["offset_limits"] == {"x_min": -2.0, "x_max": 10.0, "across_min": -2.6, "across_max": 1.0}
    assert by_id["wago-210-804"]["resolved"] == {"darkness": 12, "speed_ips": 2, "stop_mm": 0}
