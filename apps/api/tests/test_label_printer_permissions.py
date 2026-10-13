"""Who may calibrate the label printer.

``werkstatt:manage`` runs the quick flow — but only once the owner has
switched it on (``label_calibration_staff_enabled``, default off until the
physical tests have results). ``settings:manage`` runs everything, the full
wizard and the measuring pattern included, regardless of the switch. Nobody
else sees anything.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from tests.conftest import auth_headers
from tests.fake_ezpl_printer import configure_fake
from tests.label_calibration_helpers import A, W, employee_with, enable_staff, start, step

ROUTES = [
    ("get", W, None),
    ("get", f"{W}/status", None),
    ("post", f"{W}/session", {"mode": "quick", "material_id": "wago-210-804"}),
    ("post", f"{W}/session/x/heartbeat", None),
    ("delete", f"{W}/session/x", None),
    ("post", f"{W}/session/x/activate", {"material_id": "wago-210-804"}),
    ("post", f"{W}/session/x/apply", None),
    ("post", f"{W}/session/x/autosense", {"confirm_feed": True}),
    ("post", f"{W}/session/x/poll", None),
    ("post", f"{W}/session/x/verify", None),
    ("post", f"{W}/session/x/pattern", {"confirm_feed": True}),
    ("post", f"{W}/session/x/save", {}),
    ("put", f"{A}/materials/wago-210-804", {"revision": 0}),
    ("put", f"{A}/printer", {"revision": 0}),
]


def _call(client: TestClient, token: str, method: str, path: str, body):
    kwargs = {"headers": auth_headers(token)}
    if body is not None:
        kwargs["json"] = body
    return getattr(client, method)(path, **kwargs)


def test_employee_without_grants_is_refused_everywhere(client: TestClient, admin_token: str, fake_printer) -> None:
    configure_fake(client, admin_token, fake_printer)
    enable_staff(client, admin_token)
    _, nobody = employee_with([], "nobody@example.com")
    for method, path, body in ROUTES:
        assert _call(client, nobody, method, path, body).status_code == 403, path


def test_staff_with_the_switch_off(client: TestClient, admin_token: str, fake_printer) -> None:
    configure_fake(client, admin_token, fake_printer)
    _, staff = employee_with(["werkstatt:manage"], "staff@example.com")
    overview = client.get(W, headers=auth_headers(staff))
    assert overview.status_code == 200
    assert (overview.json()["staff_enabled"], overview.json()["can_full"], overview.json()["configured"]) == (False, False, True)
    refused = client.post(f"{W}/session", headers=auth_headers(staff), json={"mode": "quick", "material_id": "wago-210-804"})
    assert refused.status_code == 403
    assert refused.json()["detail"] == {
        "code": "staff_flow_disabled",
        "message": "Der Schnellablauf ist noch nicht freigegeben – bitte an die Verwaltung wenden",
    }


def test_staff_with_the_switch_on_runs_the_quick_flow_only(client: TestClient, admin_token: str, fake_printer) -> None:
    configure_fake(client, admin_token, fake_printer)
    enable_staff(client, admin_token)
    _, staff = employee_with(["werkstatt:manage"], "staff@example.com")
    assert client.get(W, headers=auth_headers(staff)).json()["staff_enabled"] is True
    status = client.get(f"{W}/status?full=true", headers=auth_headers(staff))
    assert status.status_code == 200 and status.json()["raw_config"] is None
    assert status.json()["config"]["stored_q"] == "97,2"

    full = client.post(f"{W}/session", headers=auth_headers(staff), json={"mode": "full", "material_id": "wago-210-804"})
    assert full.status_code == 403

    sid = start(client, staff)["session_id"]
    step(client, staff, sid, "activate", {"material_id": "wago-210-804"})
    step(client, staff, sid, "apply")
    step(client, staff, sid, "autosense", {"confirm_feed": True})
    for _ in range(3):
        step(client, staff, sid, "poll")
    step(client, staff, sid, "verify")
    assert client.post(f"{W}/session/{sid}/pattern", headers=auth_headers(staff), json={"confirm_feed": True}).status_code == 403
    record = step(client, staff, sid, "save", {})
    assert record["by_name"] == "Max Monteur"

    assert client.get(A, headers=auth_headers(staff)).status_code == 403
    assert client.patch(A, headers=auth_headers(staff), json={"active_material_id": "wago-210-812"}).status_code == 403
    assert client.put(f"{A}/printer", headers=auth_headers(staff), json={"revision": 0}).status_code == 403
    assert client.put(f"{A}/materials/wago-210-804", headers=auth_headers(staff), json={"revision": 0}).status_code == 403


def test_admin_runs_everything_regardless_of_the_switch(client: TestClient, admin_token: str, fake_printer) -> None:
    configure_fake(client, admin_token, fake_printer)
    overview = client.get(W, headers=auth_headers(admin_token)).json()
    assert (overview["staff_enabled"], overview["can_full"]) == (False, True)
    status = client.get(f"{W}/status?full=true", headers=auth_headers(admin_token)).json()
    assert status["raw_config"].startswith("Smart Printer V5.UW0m")
    sid = start(client, admin_token, mode="full")["session_id"]
    step(client, admin_token, sid, "activate", {"material_id": "wago-210-804"})
    step(client, admin_token, sid, "apply")
    step(client, admin_token, sid, "autosense", {"confirm_feed": True})
    for _ in range(3):
        step(client, admin_token, sid, "poll")
    step(client, admin_token, sid, "verify")
    step(client, admin_token, sid, "pattern", {"confirm_feed": True})
    step(client, admin_token, sid, "save", {})
