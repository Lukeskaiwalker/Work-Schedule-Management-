"""Printing a shelf label for an article that has no barcode of its own.

Half the stock reached the shelf unscannable because the code the stock-take
station printed was minted in a browser and never stored. These cover the
server-side path that closes that gap: the code is written in the same
transaction that prints it, so the sticker and the row cannot disagree.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from tests.conftest import auth_headers


def _configure_printer(monkeypatch, host: str = "192.0.2.50", port: int = 9100) -> None:
    from app.core.config import get_settings

    settings = get_settings()
    monkeypatch.setattr(settings, "werkstatt_label_printer_host", host)
    monkeypatch.setattr(settings, "werkstatt_label_printer_port", port)


def _capture_sent(monkeypatch) -> list[tuple[str, int, bytes]]:
    from app.services import werkstatt_labels

    sent: list[tuple[str, int, bytes]] = []

    def fake_send(host: str, port: int, payload: bytes) -> None:
        sent.append((host, port, payload))

    monkeypatch.setattr(werkstatt_labels, "_send_tcp", fake_send)
    return sent


def _article(client: TestClient, admin_token: str, name: str) -> dict:
    created = client.post(
        "/api/werkstatt/articles",
        headers=auth_headers(admin_token),
        json={"item_name": name, "unit": "Stk"},
    )
    assert created.status_code == 200, created.text
    return created.json()


def test_printing_a_label_mints_a_code_and_stores_it(
    client: TestClient, admin_token: str, monkeypatch
) -> None:
    """The whole point: after printing, the printed string resolves."""

    _configure_printer(monkeypatch)
    sent = _capture_sent(monkeypatch)
    article = _article(client, admin_token, "Wago 285-1185")

    printed = client.post(
        f"/api/werkstatt/articles/{article['id']}/print-label",
        headers=auth_headers(admin_token),
    )
    assert printed.status_code == 200, printed.text
    body = printed.json()
    assert body["minted"] is True
    assert body["internal_code"].startswith("SMPL-")
    assert len(sent) == 1, "exactly one job reaches the printer"

    # The code on the label must be the code in the payload sent to the printer.
    assert body["internal_code"].encode() in sent[0][2]

    # ...and scanning it must find the article. This is the assertion that
    # would have caught the original bug.
    resolved = client.get(
        f"/api/werkstatt/scan/resolve?code={body['internal_code']}",
        headers=auth_headers(admin_token),
    ).json()
    assert resolved["matched_by"] == "internal_code"
    assert resolved["article"]["item_name"] == "Wago 285-1185"


def test_reprinting_reproduces_the_same_code(
    client: TestClient, admin_token: str, monkeypatch
) -> None:
    """A smudged label is reprinted, not re-coded.

    Minting a second code would orphan the sticker already on the shelf: it
    would keep scanning to the article, but nothing would say so, and the two
    labels would look equally authoritative.
    """

    _configure_printer(monkeypatch)
    _capture_sent(monkeypatch)
    article = _article(client, admin_token, "Hager K96DB")

    first = client.post(
        f"/api/werkstatt/articles/{article['id']}/print-label", headers=auth_headers(admin_token)
    ).json()
    second = client.post(
        f"/api/werkstatt/articles/{article['id']}/print-label", headers=auth_headers(admin_token)
    ).json()

    assert second["internal_code"] == first["internal_code"]
    assert first["minted"] is True
    assert second["minted"] is False, "the second print is a reprint, not a new code"


def test_no_code_is_committed_when_the_printer_is_unreachable(
    client: TestClient, admin_token: str, monkeypatch
) -> None:
    """A code with no label is worse than no code.

    It exists in the database, is attached to the article, and nobody can
    scan it because it was never printed — and the next print would reuse it
    rather than mint a fresh one, so the article stays silently unlabelled.
    """

    from app.services import werkstatt_labels

    _configure_printer(monkeypatch)

    def explode(host: str, port: int, payload: bytes) -> None:
        raise werkstatt_labels.LabelPrinterUnreachable("connection refused")

    monkeypatch.setattr(werkstatt_labels, "_send_tcp", explode)
    article = _article(client, admin_token, "Shelly Pro Dimmer 2PM")

    failed = client.post(
        f"/api/werkstatt/articles/{article['id']}/print-label", headers=auth_headers(admin_token)
    )
    assert failed.status_code == 502

    detail = client.get(
        f"/api/werkstatt/articles/{article['id']}", headers=auth_headers(admin_token)
    ).json()
    assert not detail.get("internal_code"), "a failed print must leave no code behind"


def test_minted_codes_avoid_look_alike_characters(client: TestClient, admin_token: str) -> None:
    """I and O are absent: on a small label they read back as 1 and 0."""

    from app.services.werkstatt_internal_codes import generate_code

    for _ in range(200):
        body = generate_code().removeprefix("SMPL-")
        assert "I" not in body and "O" not in body
        assert len(body) == 6
