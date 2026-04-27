from __future__ import annotations
import json
import os
from fastapi.testclient import TestClient
def auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}



def _create_user(client: TestClient, admin_token: str, email: str, role: str):
    response = client.post(
        "/api/admin/users",
        headers=auth_headers(admin_token),
        json={
            "email": email,
            "password": "Password123!",
            "full_name": f"{role.title()} User",
            "role": role,
        },
    )
    assert response.status_code == 200
    return response.json()

def _login(client: TestClient, email: str):
    response = client.post("/api/auth/login", json={"email": email, "password": "Password123!"})
    assert response.status_code == 200
    return response.headers["X-Access-Token"]


def test_message_create_supports_multiple_attachments(client: TestClient, admin_token: str):
    """A single message-create request with several `attachments` files
    should produce one Message row carrying N Attachment rows in the
    selection order. Backwards-compatibility is verified separately by
    other tests that exercise the legacy single-`image`/`attachment`
    path; this one locks in the multi-file contract."""
    _create_user(client, admin_token, "msg-multi-owner@example.com", "employee")
    employee_token = _login(client, "msg-multi-owner@example.com")

    created = client.post(
        "/api/threads",
        headers=auth_headers(employee_token),
        json={"name": "Multi-attachment thread"},
    )
    assert created.status_code == 200
    thread_id = created.json()["id"]

    response = client.post(
        f"/api/threads/{thread_id}/messages",
        headers=auth_headers(employee_token),
        data={"body": "Hier sind die Bilder:"},
        files=[
            ("attachments", ("first.png", b"\x89PNG\r\n\x1a\nfirst", "image/png")),
            ("attachments", ("second.png", b"\x89PNG\r\n\x1a\nsecond", "image/png")),
            ("attachments", ("third.jpg", b"\xff\xd8\xff\xe0third", "image/jpeg")),
        ],
    )
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["body"] == "Hier sind die Bilder:"
    assert len(payload["attachments"]) == 3
    file_names = [att["file_name"] for att in payload["attachments"]]
    assert file_names == ["first.png", "second.png", "third.jpg"]


def test_message_create_falls_back_to_legacy_single_attachment_field(
    client: TestClient, admin_token: str
):
    """Older clients (and any external integrations) still post a single
    file under `attachment` or `image`. The endpoint must keep accepting
    that — it gets folded into the same code path as multi-attach."""
    _create_user(client, admin_token, "msg-legacy-owner@example.com", "employee")
    employee_token = _login(client, "msg-legacy-owner@example.com")

    thread = client.post(
        "/api/threads",
        headers=auth_headers(employee_token),
        json={"name": "Legacy attachment thread"},
    )
    thread_id = thread.json()["id"]

    response = client.post(
        f"/api/threads/{thread_id}/messages",
        headers=auth_headers(employee_token),
        data={"body": "legacy"},
        files={"attachment": ("legacy.png", b"\x89PNG\r\nlegacy", "image/png")},
    )
    assert response.status_code == 200, response.text
    payload = response.json()
    assert len(payload["attachments"]) == 1
    assert payload["attachments"][0]["file_name"] == "legacy.png"


def test_message_reactions_add_remove_aggregates_per_emoji(
    client: TestClient, admin_token: str
):
    """Two users react with overlapping emojis; the message endpoint
    must surface buckets aggregated per emoji with correct counts and
    me_reacted flags from each viewer's perspective."""
    _create_user(client, admin_token, "react-alice@example.com", "employee")
    _create_user(client, admin_token, "react-bob@example.com", "employee")
    alice_token = _login(client, "react-alice@example.com")
    bob_token = _login(client, "react-bob@example.com")

    thread = client.post(
        "/api/threads",
        headers=auth_headers(alice_token),
        json={
            "name": "Reaction thread",
            "participant_user_ids": [],
        },
    ).json()
    # Both employees need access — switch the thread to public visibility
    # via the "everyone" role participant approach. Since visibility
    # defaults to public, both already have access.
    thread_id = thread["id"]

    msg = client.post(
        f"/api/threads/{thread_id}/messages",
        headers=auth_headers(alice_token),
        data={"body": "react please"},
    ).json()
    message_id = msg["id"]

    # Alice 👍, Bob 👍, Bob ❤️
    r1 = client.post(
        f"/api/messages/{message_id}/reactions",
        headers=auth_headers(alice_token),
        json={"emoji": "👍"},
    )
    assert r1.status_code == 200, r1.text
    r2 = client.post(
        f"/api/messages/{message_id}/reactions",
        headers=auth_headers(bob_token),
        json={"emoji": "👍"},
    )
    assert r2.status_code == 200, r2.text
    r3 = client.post(
        f"/api/messages/{message_id}/reactions",
        headers=auth_headers(bob_token),
        json={"emoji": "❤️"},
    )
    assert r3.status_code == 200, r3.text

    # From Alice's view: 👍 has count 2, me_reacted true; ❤️ count 1, me_reacted false.
    payload_alice = r3.json()  # Bob's last call returned the message; re-fetch via list
    listing = client.get(
        f"/api/threads/{thread_id}/messages", headers=auth_headers(alice_token)
    ).json()
    by_id = {m["id"]: m for m in listing}
    assert message_id in by_id
    reactions = {r["emoji"]: r for r in by_id[message_id]["reactions"]}
    assert reactions["👍"]["count"] == 2
    assert reactions["👍"]["me_reacted"] is True
    assert reactions["❤️"]["count"] == 1
    assert reactions["❤️"]["me_reacted"] is False

    # Idempotent: Alice 👍 again should not double-count.
    r_dupe = client.post(
        f"/api/messages/{message_id}/reactions",
        headers=auth_headers(alice_token),
        json={"emoji": "👍"},
    )
    assert r_dupe.status_code == 200
    counts_again = {r["emoji"]: r["count"] for r in r_dupe.json()["reactions"]}
    assert counts_again["👍"] == 2

    # Remove Bob's 👍 → count drops to 1, ❤️ unchanged.
    r_remove = client.delete(
        f"/api/messages/{message_id}/reactions?emoji=%F0%9F%91%8D",
        headers=auth_headers(bob_token),
    )
    assert r_remove.status_code == 200, r_remove.text
    after = {r["emoji"]: r for r in r_remove.json()["reactions"]}
    assert after["👍"]["count"] == 1
    assert "❤️" in after and after["❤️"]["count"] == 1


def test_thread_icon_upload_accepts_heic_extension_without_image_mime(client: TestClient, admin_token: str):
    _create_user(client, admin_token, "thread-heic-owner@example.com", "employee")
    employee_token = _login(client, "thread-heic-owner@example.com")

    created = client.post(
        "/api/threads",
        headers=auth_headers(employee_token),
        json={"name": "HEIC icon thread"},
    )
    assert created.status_code == 200
    thread_id = created.json()["id"]

    icon_upload = client.post(
        f"/api/threads/{thread_id}/icon",
        headers=auth_headers(employee_token),
        files={"file": ("thread-icon.heic", b"fake-heic-icon", "application/octet-stream")},
    )
    assert icon_upload.status_code == 200
    assert icon_upload.json()["ok"] is True

    icon_file = client.get(f"/api/threads/{thread_id}/icon", headers=auth_headers(employee_token))
    assert icon_file.status_code == 200
    assert icon_file.content
    assert icon_file.headers.get("content-type", "").startswith("image/")
