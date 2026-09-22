"""The Datanorm import at catalog size — ``/werkstatt/datanorm/upload`` and
``/commit`` with the preview on disk.

What must hold: the preview lives in files under the preview directory (so
a commit on another worker finds it) and the rows are streamed in batches
into the table; a token commits once; a re-import classifies rows as new,
updated or unchanged against the supplier's current rows and keeps the
images already looked up; merge mode keeps what is there and skips what the
file repeats; an upload over the cap is refused mid-stream and leaves no
file behind; an expired preview is swept; a token that is not a token never
reaches the filesystem; EAN conflicts are found across query slices.
"""

from __future__ import annotations

import os
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select

from app.core.db import SessionLocal
from app.models.entities import MaterialCatalogItem
from app.routers import workflow_werkstatt_datanorm as datanorm_router
from app.services import werkstatt_datanorm_import as import_service
from app.services.werkstatt_datanorm_preview_store import PREVIEW_TTL_SECONDS
from tests.conftest import auth_headers

HEADER = (
    "V 180326Artikelstammdaten                       Elektro Test GmbH                       "
    "44894 Bochum                       04EUR\n"
)


@pytest.fixture(autouse=True)
def preview_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Every test gets its own preview directory, through the env var the
    store reads first."""
    directory = tmp_path / "previews"
    monkeypatch.setenv("DATANORM_PREVIEW_DIR", str(directory))
    return directory


def _datanorm(articles: list[tuple[str, str, str, str | None]]) -> bytes:
    """A Datanorm v4 body: (article_no, short text, price in cents, ean)."""
    lines = [HEADER]
    for article_no, text, price, ean in articles:
        lines.append(f"A;N;{article_no};00;{text};Langtext {article_no};1;0;St;{price}; ;05;;\n")
        lines.append(f"B;N;{article_no};{text[:10]};;;;;;{ean or ''};1;0;500;;39751;\n")
    return "".join(lines).encode("cp1252")


def _make_supplier(client: TestClient, admin_token: str, name: str) -> int:
    response = client.post(
        "/api/werkstatt/suppliers", headers=auth_headers(admin_token), json={"name": name, "default_lead_time_days": 5}
    )
    assert response.status_code == 200, response.text
    return response.json()["id"]


def _upload(client: TestClient, admin_token: str, supplier_id: int, body: bytes, *, filename: str = "datanorm.001"):
    return client.post(
        "/api/werkstatt/datanorm/upload",
        headers=auth_headers(admin_token),
        data={"supplier_id": str(supplier_id)},
        files={"file": (filename, body, "application/octet-stream")},
    )


def _commit(client: TestClient, admin_token: str, token: str, *, replace_mode: bool = True):
    return client.post(
        "/api/werkstatt/datanorm/commit",
        headers=auth_headers(admin_token),
        json={"import_token": token, "replace_mode": replace_mode},
    )


def _rows_of(supplier_id: int) -> list[MaterialCatalogItem]:
    with SessionLocal() as db:
        return list(
            db.scalars(
                select(MaterialCatalogItem)
                .where(MaterialCatalogItem.supplier_id == supplier_id)
                .order_by(MaterialCatalogItem.article_no)
            ).all()
        )


def _count_of(supplier_id: int) -> int:
    with SessionLocal() as db:
        return int(db.scalar(select(func.count()).select_from(MaterialCatalogItem).where(MaterialCatalogItem.supplier_id == supplier_id)) or 0)


# ── On disk, in batches ───────────────────────────────────────────────────────


def test_preview_lives_on_disk_and_commit_streams_the_rows_in_batches(
    client: TestClient, admin_token: str, preview_dir: Path
) -> None:
    supplier_id = _make_supplier(client, admin_token, "Großhandel Batch")
    # More rows than two insert batches, so the batching path is the one taken.
    articles = [(f"{n:07d}", f"Schütz {n}", str(1000 + n), f"40{n:011d}") for n in range(1, 2501)]

    upload = _upload(client, admin_token, supplier_id, _datanorm(articles))
    assert upload.status_code == 200, upload.text
    preview = upload.json()
    assert preview["total_rows"] == 2500
    assert preview["rows_new"] == 2500 and preview["rows_updated"] == 0 and preview["rows_unchanged"] == 0
    assert preview["detected_version"] == "04"
    assert preview["detected_encoding"] == "cp1252"
    assert [row["article_no"] for row in preview["sample_rows"]] == [f"{n:07d}" for n in range(1, 9)]
    token = preview["import_token"]

    # The preview is two files under the directory — and nothing else: the
    # streamed upload itself is gone once analysed.
    names = sorted(path.name for path in preview_dir.iterdir())
    assert names == [f"{token}.json", f"{token}.rows.jsonl"]
    assert sum(1 for _ in (preview_dir / f"{token}.rows.jsonl").open(encoding="utf-8")) == 2500

    commit = _commit(client, admin_token, token)
    assert commit.status_code == 200, commit.text
    assert commit.json()["status"] == "committed"
    assert commit.json()["total_rows"] == 2500
    assert _count_of(supplier_id) == 2500
    first = _rows_of(supplier_id)[0]
    assert first.article_no == "0000001" and first.price_text == "10.01 EUR" and first.ean == "4000000000001"
    assert first.search_text.startswith("0000001 schütz 1")
    # Committed previews leave the directory clean.
    assert list(preview_dir.iterdir()) == []


def test_a_token_commits_once(client: TestClient, admin_token: str) -> None:
    supplier_id = _make_supplier(client, admin_token, "Großhandel Einmal")
    upload = _upload(client, admin_token, supplier_id, _datanorm([("100", "Kabel", "1234", None)]))
    token = upload.json()["import_token"]
    assert _commit(client, admin_token, token).status_code == 200
    again = _commit(client, admin_token, token)
    assert again.status_code == 400, again.text
    assert again.json()["detail"] == "Import token expired or unknown"
    assert _count_of(supplier_id) == 1


# ── Re-imports ────────────────────────────────────────────────────────────────


def test_reimport_classifies_rows_and_keeps_looked_up_images(client: TestClient, admin_token: str) -> None:
    supplier_id = _make_supplier(client, admin_token, "Großhandel Update")
    first = _upload(
        client,
        admin_token,
        supplier_id,
        _datanorm([("A1", "Schalter", "500", "4001"), ("A2", "Dose", "300", "4002"), ("A3", "Leuchte", "9900", "4003")]),
    )
    assert _commit(client, admin_token, first.json()["import_token"]).status_code == 200

    # An image the slow lookup found for A2 — it must survive the replace.
    with SessionLocal() as db:
        row = db.scalar(select(MaterialCatalogItem).where(MaterialCatalogItem.supplier_id == supplier_id, MaterialCatalogItem.article_no == "A2"))
        assert row is not None
        row.image_url = "https://img.example/dose.jpg"
        row.image_source = "unielektro"
        db.add(row)
        db.commit()

    # A1's price changed, A2 and A3 are as they were, A4 is new.
    second = _upload(
        client,
        admin_token,
        supplier_id,
        _datanorm([("A1", "Schalter", "550", "4001"), ("A2", "Dose", "300", "4002"), ("A3", "Leuchte", "9900", "4003"), ("A4", "Kabel", "100", "4004")]),
    )
    assert second.status_code == 200, second.text
    preview = second.json()
    assert (preview["rows_new"], preview["rows_updated"], preview["rows_unchanged"]) == (1, 1, 2)
    assert _commit(client, admin_token, preview["import_token"]).status_code == 200

    rows = {row.article_no: row for row in _rows_of(supplier_id)}
    assert set(rows) == {"A1", "A2", "A3", "A4"}
    assert rows["A1"].price_text == "5.50 EUR"
    assert rows["A2"].image_url == "https://img.example/dose.jpg" and rows["A2"].image_source == "unielektro"
    assert rows["A4"].image_url is None


def test_merge_mode_keeps_existing_rows_and_skips_what_the_file_repeats(client: TestClient, admin_token: str) -> None:
    supplier_id = _make_supplier(client, admin_token, "Großhandel Merge")
    first = _upload(client, admin_token, supplier_id, _datanorm([("M1", "Alt", "100", "5001"), ("M2", "Bleibt", "200", "5002")]))
    assert _commit(client, admin_token, first.json()["import_token"]).status_code == 200

    second = _upload(client, admin_token, supplier_id, _datanorm([("M2", "Bleibt", "200", "5002"), ("M3", "Neu", "300", "5003")]))
    assert _commit(client, admin_token, second.json()["import_token"], replace_mode=False).status_code == 200

    assert [row.article_no for row in _rows_of(supplier_id)] == ["M1", "M2", "M3"]


# ── Refusals and sweeping ─────────────────────────────────────────────────────


def test_upload_over_the_cap_is_refused_mid_stream_and_leaves_nothing_behind(
    client: TestClient, admin_token: str, preview_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    supplier_id = _make_supplier(client, admin_token, "Großhandel Riesig")
    monkeypatch.setattr(datanorm_router, "DATANORM_UPLOAD_MAX_BYTES", 200)
    monkeypatch.setattr(datanorm_router, "UPLOAD_CHUNK_BYTES", 64)
    body = _datanorm([(f"R{n}", "Riesig", "1", None) for n in range(50)])
    assert len(body) > 200

    refused = _upload(client, admin_token, supplier_id, body)
    assert refused.status_code == 413, refused.text
    assert refused.json()["detail"] == "File exceeds maximum upload size"
    assert list(preview_dir.iterdir()) == []

    # Under the cap, the same route works — the cap is the only thing that changed.
    monkeypatch.setattr(datanorm_router, "DATANORM_UPLOAD_MAX_BYTES", len(body))
    assert _upload(client, admin_token, supplier_id, body).status_code == 200


def test_an_empty_or_foreign_file_is_refused_and_cleaned_up(client: TestClient, admin_token: str, preview_dir: Path) -> None:
    supplier_id = _make_supplier(client, admin_token, "Großhandel Leer")
    assert _upload(client, admin_token, supplier_id, b"").status_code == 400
    foreign = _upload(client, admin_token, supplier_id, b"hello;world\nnot;datanorm\n" * 20, filename="notes.txt")
    assert foreign.status_code == 400, foreign.text
    assert list(preview_dir.iterdir()) == []


def test_expired_preview_is_swept_and_cannot_be_committed(client: TestClient, admin_token: str, preview_dir: Path) -> None:
    supplier_id = _make_supplier(client, admin_token, "Großhandel Spät")
    token = _upload(client, admin_token, supplier_id, _datanorm([("S1", "Spät", "100", None)])).json()["import_token"]
    old = time.time() - PREVIEW_TTL_SECONDS - 60
    for path in preview_dir.iterdir():
        os.utime(path, (old, old))

    refused = _commit(client, admin_token, token)
    assert refused.status_code == 400, refused.text
    assert list(preview_dir.iterdir()) == []
    assert _count_of(supplier_id) == 0


def test_a_token_that_is_not_a_token_never_reaches_the_filesystem(client: TestClient, admin_token: str, preview_dir: Path) -> None:
    for bad in ("../../etc/passwd", "abc/../def", "with space", "dots.json"):
        refused = _commit(client, admin_token, bad)
        assert refused.status_code == 400, (bad, refused.text)
        assert refused.json()["detail"] == "Import token expired or unknown"
    assert not preview_dir.exists() or list(preview_dir.iterdir()) == []


def test_ean_conflicts_are_found_across_query_slices(client: TestClient, admin_token: str, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(import_service, "EAN_QUERY_CHUNK", 2)
    owner = _make_supplier(client, admin_token, "Großhandel Erster")
    eans = [f"70{n:011d}" for n in range(1, 6)]
    first = _upload(client, admin_token, owner, _datanorm([(f"E{n}", f"Erst {n}", "100", ean) for n, ean in enumerate(eans, start=1)]))
    assert _commit(client, admin_token, first.json()["import_token"]).status_code == 200

    rival = _make_supplier(client, admin_token, "Großhandel Zweiter")
    upload = _upload(client, admin_token, rival, _datanorm([(f"Z{n}", f"Zweit {n}", "100", ean) for n, ean in enumerate(eans, start=1)]))
    assert upload.status_code == 200, upload.text
    conflicts = upload.json()["ean_conflicts"]
    assert sorted(conflict["ean"] for conflict in conflicts) == eans
    assert {conflict["existing_supplier_name"] for conflict in conflicts} == {"Großhandel Erster"}
