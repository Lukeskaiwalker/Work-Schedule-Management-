"""v2.5.25 — regression tests for role-permission save tolerance.

Previously, a stale permission string in the saved role-permission
override (e.g. a permission renamed/removed in a later code version)
made the admin role-permissions UI unfixable: every checkbox click
sent the current list back to the server, which 400'd because the
stale entry was not in ALL_PERMISSIONS, and the frontend's error
handler reloaded the stale state — producing a checkmark that
"flashes off."

The fix:
  • PUT /admin/role-permissions/<role> silently drops unknown
    entries instead of 400-ing.
  • load_role_permissions_from_db filters at boot, and persists the
    cleaned version back to the DB so the heal is permanent.
  • save_role_permissions_to_db also filters as defence in depth.
"""
from __future__ import annotations
import json

from fastapi.testclient import TestClient

from app.core.db import SessionLocal
from app.services.runtime_settings import (
    ROLE_PERMISSIONS_KEY,
    load_role_permissions_from_db,
    set_runtime_setting,
    get_runtime_setting,
)


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _plant_override(stored: dict[str, list[str]]) -> None:
    with SessionLocal() as db:
        set_runtime_setting(db, ROLE_PERMISSIONS_KEY, json.dumps(stored))
        db.commit()
        load_role_permissions_from_db(db)


def test_admin_can_grant_permission_when_override_contains_stale_entry(
    client: TestClient, admin_token: str
):
    """The headline bug fix: a stale permission lurking in the override
    no longer breaks the admin's ability to grant new permissions.

    The frontend sends the FULL current list plus the toggled entry —
    if the current list contains "deprecated:permission", the old PUT
    handler returned 400 and the FE reloaded state, producing the
    "flash on then off" UX. The new tolerant handler accepts the
    request, drops the unknown silently, and persists the cleaned
    version including the newly-granted permission."""
    H = _auth(admin_token)

    _plant_override({
        "ceo": [
            "projects:view",
            "projects:manage",
            "tasks:manage",
            "deprecated:permission",  # stale — no longer in ALL_PERMISSIONS
        ],
    })

    # FE reads current list (includes the stale entry; GET is lax)
    r = client.get("/api/admin/role-permissions", headers=H)
    # ★ Insight: the load-time self-heal already filters at startup,
    # so by the time we GET here, the stored override has been
    # cleaned even though we planted "deprecated:permission" above.
    # The user-facing UX therefore self-heals on the next restart
    # OR the next admin click, whichever comes first.
    ceo_after_load = r.json()["permissions"]["ceo"]
    assert "deprecated:permission" not in ceo_after_load, (
        "Load-time filter should have removed the stale entry"
    )

    # The persisted DB row should also be clean now (self-heal write-back).
    with SessionLocal() as db:
        raw = get_runtime_setting(db, ROLE_PERMISSIONS_KEY)
    persisted = json.loads(raw)
    assert "deprecated:permission" not in persisted["ceo"], (
        "Stale entry should have been written back as cleaned"
    )

    # Now simulate the click that USED to flash off — send a payload
    # that still contains the stale entry (as the FE would if the
    # client hadn't yet refreshed after the heal).
    payload_with_stale = sorted(set(ceo_after_load + ["finance:view", "deprecated:permission"]))
    r = client.put(
        "/api/admin/role-permissions/ceo",
        headers=H,
        json={"permissions": payload_with_stale},
    )
    assert r.status_code == 200, f"PUT should now tolerate stale entries: {r.text}"
    ceo_after_put = r.json()["permissions"]["ceo"]
    assert "finance:view" in ceo_after_put
    assert "deprecated:permission" not in ceo_after_put


def test_load_self_heals_overrides_with_stale_entries(
    client: TestClient, admin_token: str
):
    """Boot-time filter writes the cleaned override back to the DB so
    the heal survives restarts and the DB never contains poison
    entries again."""
    _plant_override({
        "ceo": ["projects:view", "junk:thing"],
        "accountant": ["finance:view", "ghost:permission"],
    })

    # Re-load triggers the self-heal write-back.
    with SessionLocal() as db:
        load_role_permissions_from_db(db)
        raw = get_runtime_setting(db, ROLE_PERMISSIONS_KEY)

    persisted = json.loads(raw)
    assert persisted["ceo"] == ["projects:view"]
    assert persisted["accountant"] == ["finance:view"]


def test_normal_round_trip_still_works(client: TestClient, admin_token: str):
    """Sanity: the tolerant filter doesn't break the happy path —
    granting a real permission to a clean override still works."""
    H = _auth(admin_token)
    _plant_override({"ceo": ["projects:view"]})

    r = client.put(
        "/api/admin/role-permissions/ceo",
        headers=H,
        json={"permissions": ["projects:view", "finance:view"]},
    )
    assert r.status_code == 200
    assert sorted(r.json()["permissions"]["ceo"]) == ["finance:view", "projects:view"]


def test_admin_can_reset_ceo_to_defaults(client: TestClient, admin_token: str):
    """The 'reset to defaults' button on the role header restores the
    full hard-coded CEO permission set, including finance and time
    permissions that were missing from the override."""
    H = _auth(admin_token)
    _plant_override({"ceo": ["projects:view"]})

    r = client.delete("/api/admin/role-permissions/ceo", headers=H)
    assert r.status_code == 200
    ceo_after_reset = r.json()["permissions"]["ceo"]
    assert "finance:view" in ceo_after_reset
    assert "finance:manage" in ceo_after_reset
    assert "time:view_all" in ceo_after_reset
    assert "time:manage" in ceo_after_reset
