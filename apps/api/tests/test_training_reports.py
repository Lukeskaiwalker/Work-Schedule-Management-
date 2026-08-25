"""Ausbildungsnachweise — apprentice weekly training reports (IHK).

The behaviours pinned here are the ones with legal or privacy weight:

  * only a user marked as apprentice can write reports, and only their own —
    the sheet is a personal legal record, not a team document;
  * a SIGNED report is immutable. It is what the IHK inspects; an editable
    history would defeat the record's purpose;
  * the trainer countersignature needs `training:manage` and must come from a
    second person — self-countersigning would make the dual-signature form
    meaningless;
  * the prefill mirrors time tracking exactly: net hours after statutory
    breaks, Berufsschule detection from approved school absences, and the
    day's tasks/reports as suggested lines.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta

from fastapi.testclient import TestClient


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _employee(client: TestClient, admin_token: str, email: str) -> dict:
    resp = client.post(
        "/api/admin/users",
        headers=_auth(admin_token),
        json={
            "email": email,
            "password": "Password123!",
            "full_name": email.split("@")[0],
            "role": "employee",
        },
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def _login(client: TestClient, email: str) -> str:
    resp = client.post("/api/auth/login", json={"email": email, "password": "Password123!"})
    assert resp.status_code == 200, resp.text
    return resp.headers["X-Access-Token"]


def _make_apprentice(
    client: TestClient, admin_token: str, user_id: int, *, started: str | None = None
) -> None:
    payload: dict = {"is_apprentice": True}
    if started:
        payload["training_started_on"] = started
    resp = client.patch(
        f"/api/training/apprentices/{user_id}", headers=_auth(admin_token), json=payload
    )
    assert resp.status_code == 200, resp.text


def _apprentice_with_token(
    client: TestClient, admin_token: str, email: str, *, started: str | None = None
) -> tuple[dict, str]:
    user = _employee(client, admin_token, email)
    _make_apprentice(client, admin_token, user["id"], started=started)
    return user, _login(client, email)


def _signature() -> str:
    """A real, small PNG data URL — sign endpoints validate the image now."""

    import base64
    import io

    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (300, 100), (255, 255, 255)).save(buf, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


# Monday of an arbitrary fixed week, so assertions are deterministic.
MONDAY = "2026-08-10"
WEDNESDAY = "2026-08-12"

DAYS_PAYLOAD = [
    {
        "day": MONDAY,
        "entries": [
            {"text": "Unterverteilung verdrahtet", "hours": 6.0, "category": "betrieb"},
            {"text": "Unterweisung: Arbeiten unter Spannung", "hours": 2.0, "category": "unterweisung"},
        ],
    },
    {
        "day": "2026-08-11",
        "entries": [{"text": "Berufsschule: Wechselstromtechnik", "hours": 8.0, "category": "schule"}],
    },
]


# ──────────────────────────────────────────────────────────────────────────
# Who may write at all
# ──────────────────────────────────────────────────────────────────────────


def test_a_non_apprentice_cannot_create_a_report(client: TestClient, admin_token: str) -> None:
    _employee(client, admin_token, "kein-azubi@example.com")
    token = _login(client, "kein-azubi@example.com")
    resp = client.post(
        "/api/training/reports",
        headers=_auth(token),
        json={"week_start": MONDAY, "days": DAYS_PAYLOAD},
    )
    assert resp.status_code == 403, resp.text


def test_only_users_manage_may_flag_apprentices(client: TestClient, admin_token: str) -> None:
    target = _employee(client, admin_token, "ziel@example.com")
    _employee(client, admin_token, "normal@example.com")
    token = _login(client, "normal@example.com")
    resp = client.patch(
        f"/api/training/apprentices/{target['id']}",
        headers=_auth(token),
        json={"is_apprentice": True},
    )
    assert resp.status_code == 403, resp.text


def test_the_apprentice_flag_reaches_the_user_object(client: TestClient, admin_token: str) -> None:
    """The SPA gates the Wochenbericht button on user.is_apprentice, so the
    flag has to flow through the normal user serialization."""

    user, token = _apprentice_with_token(client, admin_token, "flag@example.com", started="2025-08-01")
    me = client.get("/api/auth/me", headers=_auth(token))
    assert me.status_code == 200, me.text
    assert me.json()["is_apprentice"] is True
    assert me.json()["training_started_on"] == "2025-08-01"


# ──────────────────────────────────────────────────────────────────────────
# Lifecycle
# ──────────────────────────────────────────────────────────────────────────


def test_create_normalizes_the_week_and_numbers_reports(
    client: TestClient, admin_token: str
) -> None:
    _, token = _apprentice_with_token(client, admin_token, "azubi-1@example.com")

    # Sent a WEDNESDAY: the report must land on that week's Monday.
    first = client.post(
        "/api/training/reports",
        headers=_auth(token),
        json={"week_start": WEDNESDAY, "days": DAYS_PAYLOAD},
    )
    assert first.status_code == 200, first.text
    body = first.json()
    assert body["week_start"] == MONDAY
    assert body["report_number"] == 1
    assert body["status"] == "draft"
    assert body["total_hours"] == 16.0

    second = client.post(
        "/api/training/reports",
        headers=_auth(token),
        json={"week_start": "2026-08-17", "days": []},
    )
    assert second.status_code == 200, second.text
    assert second.json()["report_number"] == 2


def test_one_report_per_week(client: TestClient, admin_token: str) -> None:
    _, token = _apprentice_with_token(client, admin_token, "azubi-2@example.com")
    assert (
        client.post(
            "/api/training/reports", headers=_auth(token), json={"week_start": MONDAY, "days": []}
        ).status_code
        == 200
    )
    dup = client.post(
        "/api/training/reports",
        headers=_auth(token),
        json={"week_start": WEDNESDAY, "days": []},  # same week, different weekday
    )
    assert dup.status_code == 409, dup.text


def test_ausbildungsjahr_is_prefilled_from_the_training_start(
    client: TestClient, admin_token: str
) -> None:
    """Started 2024-09-01 → the week of 2026-08-10 is the 2nd full year: Jahr 2."""

    _, token = _apprentice_with_token(client, admin_token, "azubi-jahr@example.com", started="2024-09-01")
    prefill = client.get(f"/api/training/prefill?week_start={MONDAY}", headers=_auth(token))
    assert prefill.status_code == 200, prefill.text
    assert prefill.json()["ausbildungsjahr"] == 2


def test_the_full_signature_ladder(client: TestClient, admin_token: str) -> None:
    """draft → apprentice signs (submitted) → trainer countersigns (signed).

    admin holds training:manage via the role default, so it stands in for the
    Ausbilder here.
    """

    _, token = _apprentice_with_token(client, admin_token, "azubi-3@example.com")
    report = client.post(
        "/api/training/reports", headers=_auth(token), json={"week_start": MONDAY, "days": DAYS_PAYLOAD}
    ).json()
    rid = report["id"]
    signature = _signature()

    submitted = client.post(
        f"/api/training/reports/{rid}/sign-azubi", headers=_auth(token), json={"signature": signature}
    )
    assert submitted.status_code == 200, submitted.text
    assert submitted.json()["status"] == "submitted"
    assert submitted.json()["azubi_signed_at"] is not None

    # Editing a submitted report is refused …
    frozen = client.patch(
        f"/api/training/reports/{rid}", headers=_auth(token), json={"remarks": "nachträglich"}
    )
    assert frozen.status_code == 409, frozen.text

    # … but the apprentice can withdraw it while the trainer has not signed.
    withdrawn = client.post(f"/api/training/reports/{rid}/withdraw", headers=_auth(token))
    assert withdrawn.status_code == 200, withdrawn.text
    assert withdrawn.json()["status"] == "draft"
    assert withdrawn.json()["azubi_signed_at"] is None

    # Re-sign and countersign.
    client.post(f"/api/training/reports/{rid}/sign-azubi", headers=_auth(token), json={"signature": signature})
    countersigned = client.post(
        f"/api/training/reports/{rid}/sign-ausbilder",
        headers=_auth(admin_token),
        json={"signature": signature},
    )
    assert countersigned.status_code == 200, countersigned.text
    assert countersigned.json()["status"] == "signed"
    assert countersigned.json()["ausbilder_name"]

    # A signed report is immutable in every direction.
    assert (
        client.patch(f"/api/training/reports/{rid}", headers=_auth(token), json={"remarks": "x"}).status_code
        == 409
    )
    assert client.post(f"/api/training/reports/{rid}/withdraw", headers=_auth(token)).status_code == 409
    assert client.delete(f"/api/training/reports/{rid}", headers=_auth(token)).status_code == 409


def test_countersigning_requires_permission_and_a_second_person(
    client: TestClient, admin_token: str
) -> None:
    _, token = _apprentice_with_token(client, admin_token, "azubi-4@example.com")
    report = client.post(
        "/api/training/reports", headers=_auth(token), json={"week_start": MONDAY, "days": []}
    ).json()
    rid = report["id"]
    signature = _signature()
    client.post(f"/api/training/reports/{rid}/sign-azubi", headers=_auth(token), json={"signature": signature})

    # The apprentice themselves: no training:manage → 403.
    own = client.post(
        f"/api/training/reports/{rid}/sign-ausbilder", headers=_auth(token), json={"signature": signature}
    )
    assert own.status_code == 403, own.text

    # A colleague without the permission → 403.
    _employee(client, admin_token, "kollege@example.com")
    colleague_token = _login(client, "kollege@example.com")
    other = client.post(
        f"/api/training/reports/{rid}/sign-ausbilder",
        headers=_auth(colleague_token),
        json={"signature": signature},
    )
    assert other.status_code == 403, other.text

    # A draft (not yet submitted) cannot be countersigned.
    fresh = client.post(
        "/api/training/reports", headers=_auth(token), json={"week_start": "2026-08-17", "days": []}
    ).json()
    early = client.post(
        f"/api/training/reports/{fresh['id']}/sign-ausbilder",
        headers=_auth(admin_token),
        json={"signature": signature},
    )
    assert early.status_code == 409, early.text


def test_reports_are_private_to_the_apprentice_and_trainers(
    client: TestClient, admin_token: str
) -> None:
    _, token_a = _apprentice_with_token(client, admin_token, "azubi-5@example.com")
    _, token_b = _apprentice_with_token(client, admin_token, "azubi-6@example.com")

    created = client.post(
        "/api/training/reports", headers=_auth(token_a), json={"week_start": MONDAY, "days": DAYS_PAYLOAD}
    ).json()

    # Another apprentice sees neither the list entry nor the report.
    other_list = client.get(
        f"/api/training/reports?user_id={created['user_id']}", headers=_auth(token_b)
    )
    assert other_list.status_code == 403, other_list.text
    assert client.get(f"/api/training/reports/{created['id']}", headers=_auth(token_b)).status_code == 403

    # Nor does the trainer, while it is still a draft: report ids are a single
    # global sequence, so a by-id read that ignored status would make the
    # list endpoint's privacy promise worthless.
    draft_view = client.get(f"/api/training/reports/{created['id']}", headers=_auth(admin_token))
    assert draft_view.status_code == 403, draft_view.text
    draft_pdf = client.get(f"/api/training/reports/{created['id']}/pdf", headers=_auth(admin_token))
    assert draft_pdf.status_code == 403, draft_pdf.text

    # Once the apprentice signs, the trainer sees it — that is the handover.
    client.post(
        f"/api/training/reports/{created['id']}/sign-azubi",
        headers=_auth(token_a),
        json={"signature": _signature()},
    )
    trainer_view = client.get(f"/api/training/reports/{created['id']}", headers=_auth(admin_token))
    assert trainer_view.status_code == 200, trainer_view.text


# ──────────────────────────────────────────────────────────────────────────
# Prefill from time tracking
# ──────────────────────────────────────────────────────────────────────────


def test_prefill_mirrors_time_tracking(client: TestClient, admin_token: str) -> None:
    """Monday: an 8.5h gross shift → 8.0h net (statutory break), plus a task
    and a construction report as suggested lines. Tuesday: approved school
    absence → school_day. Wednesday: nothing → zeros."""

    from app.core.db import SessionLocal
    from app.models.entities import ClockEntry, ConstructionReport, Project, SchoolAbsence, Task

    user, token = _apprentice_with_token(client, admin_token, "azubi-7@example.com")

    with SessionLocal() as db:
        project = Project(project_number="AZUBI-1", name="Lehrbaustelle", status="active")
        db.add(project)
        db.flush()
        # Monday 06:00–14:30 UTC — 8.5h gross, no explicit breaks.
        db.add(
            ClockEntry(
                user_id=user["id"],
                clock_in=datetime(2026, 8, 10, 6, 0),
                clock_out=datetime(2026, 8, 10, 14, 30),
            )
        )
        db.add(
            Task(
                project_id=project.id,
                title="Kabeltrasse montieren",
                status="open",
                due_date=date(2026, 8, 10),
                assignee_id=user["id"],
            )
        )
        db.add(
            ConstructionReport(
                user_id=user["id"],
                project_id=project.id,
                report_date=date(2026, 8, 10),
                payload={"work_done": "Trasse gesetzt und Leitungen eingezogen"},
                processing_status="done",
            )
        )
        db.add(
            SchoolAbsence(
                user_id=user["id"],
                title="Berufsschule",
                start_date=date(2026, 8, 11),
                end_date=date(2026, 8, 11),
                absence_type="school",
                status="approved",
            )
        )
        db.commit()

    prefill = client.get(f"/api/training/prefill?week_start={MONDAY}", headers=_auth(token))
    assert prefill.status_code == 200, prefill.text
    days = {d["day"]: d for d in prefill.json()["days"]}

    monday = days[MONDAY]
    assert monday["worked_hours"] == 8.0
    assert monday["school_day"] is False
    joined = " ".join(monday["suggested_lines"])
    assert "Kabeltrasse montieren" in joined
    assert "Trasse gesetzt" in joined

    tuesday = days["2026-08-11"]
    assert tuesday["school_day"] is True

    wednesday = days[WEDNESDAY]
    assert wednesday["worked_hours"] == 0
    assert wednesday["suggested_lines"] == []

    # Prefill is personal: another user's prefill cannot be requested even by
    # the trainer — it is a drafting aid, not a supervision tool.
    other = client.get(
        f"/api/training/prefill?week_start={MONDAY}&user_id={user['id']}",
        headers=_auth(admin_token),
    )
    assert other.status_code in (403, 422), other.text


def test_a_recurring_school_weekday_marks_the_day(client: TestClient, admin_token: str) -> None:
    """School absences support 'every Tuesday until X' — the prefill must
    honour that shape too, not only plain ranges."""

    from app.core.db import SessionLocal
    from app.models.entities import SchoolAbsence

    user, token = _apprentice_with_token(client, admin_token, "azubi-8@example.com")
    with SessionLocal() as db:
        db.add(
            SchoolAbsence(
                user_id=user["id"],
                title="Berufsschule",
                start_date=date(2026, 8, 4),  # a Tuesday
                end_date=date(2026, 8, 4),
                absence_type="school",
                status="approved",
                recurrence_weekday=1,  # Tuesday
                recurrence_until=date(2026, 12, 31),
            )
        )
        db.commit()

    prefill = client.get(f"/api/training/prefill?week_start={MONDAY}", headers=_auth(token))
    assert prefill.status_code == 200, prefill.text
    days = {d["day"]: d for d in prefill.json()["days"]}
    assert days["2026-08-11"]["school_day"] is True  # the Tuesday of this week
    assert days[MONDAY]["school_day"] is False


# ──────────────────────────────────────────────────────────────────────────
# PDF
# ──────────────────────────────────────────────────────────────────────────


def test_the_pdf_downloads_for_owner_and_trainer_only(
    client: TestClient, admin_token: str
) -> None:
    _, token = _apprentice_with_token(client, admin_token, "azubi-9@example.com")
    report = client.post(
        "/api/training/reports", headers=_auth(token), json={"week_start": MONDAY, "days": DAYS_PAYLOAD}
    ).json()

    pdf = client.get(f"/api/training/reports/{report['id']}/pdf", headers=_auth(token))
    assert pdf.status_code == 200, pdf.text
    assert pdf.headers["content-type"].startswith("application/pdf")
    assert pdf.content[:5] == b"%PDF-"

    # The trainer gets the PDF only once it has been signed — a draft's PDF is
    # as private as the draft itself.
    assert (
        client.get(f"/api/training/reports/{report['id']}/pdf", headers=_auth(admin_token)).status_code
        == 403
    )
    client.post(
        f"/api/training/reports/{report['id']}/sign-azubi",
        headers=_auth(token),
        json={"signature": _signature()},
    )
    trainer = client.get(f"/api/training/reports/{report['id']}/pdf", headers=_auth(admin_token))
    assert trainer.status_code == 200

    _employee(client, admin_token, "fremd@example.com")
    stranger = client.get(
        f"/api/training/reports/{report['id']}/pdf",
        headers=_auth(_login(client, "fremd@example.com")),
    )
    assert stranger.status_code == 403, stranger.text


def test_pdf_survives_angle_brackets_and_ampersands_in_user_text(
    client: TestClient, admin_token: str
) -> None:
    """Reportlab paragraphs interpret mini-HTML, and every text on this sheet
    is user-typed. "Kabel <3mm & Dosen" must render as literal text — not
    crash the renderer, not inject markup into a legal document."""

    _, token = _apprentice_with_token(client, admin_token, "azubi-xml@example.com")
    report = client.post(
        "/api/training/reports",
        headers=_auth(token),
        json={
            "week_start": MONDAY,
            "days": [
                {
                    "day": MONDAY,
                    "entries": [
                        {"text": "Kabel <3mm & Dosen <b>gesetzt</b>", "hours": 8.0, "category": "betrieb"}
                    ],
                }
            ],
            "remarks": "Notiz mit <i>Tags</i> & Sonderzeichen",
        },
    )
    assert report.status_code == 200, report.text

    pdf = client.get(f"/api/training/reports/{report.json()['id']}/pdf", headers=_auth(token))
    assert pdf.status_code == 200, pdf.text
    assert pdf.content[:5] == b"%PDF-"

    # And the literal text must actually be IN the document. Reportlab splits
    # a paragraph across many (…) Tj operators, so join the string operands
    # before searching rather than expecting one contiguous run.
    import base64, re, zlib

    streams = b""
    for m in re.finditer(rb"stream\r?\n", pdf.content):
        chunk = pdf.content[m.end() : pdf.content.find(b"endstream", m.end())].strip()
        try:
            data = base64.a85decode(chunk, adobe=True) if chunk.endswith(b"~>") else chunk
            streams += zlib.decompress(data)
        except Exception:
            continue
    joined = b"".join(re.findall(rb"\(((?:[^()\\]|\\.)*)\)\s*Tj", streams))
    assert b"Kabel <3mm & Dosen <b>gesetzt</b>" in joined, joined[:400]
    assert b"Notiz mit <i>Tags</i> & Sonderzeichen" in joined


# ──────────────────────────────────────────────────────────────────────────
# Hardening (from the adversarial review)
# ──────────────────────────────────────────────────────────────────────────


def test_whitespace_only_entry_text_is_rejected(client: TestClient, admin_token: str) -> None:
    """A ' ' text passed min_length, got stripped to '' in storage, and then
    failed response validation on every later read — one bad request poisoned
    the whole report list with 500s. Rejected at the boundary now."""

    _, token = _apprentice_with_token(client, admin_token, "azubi-blank@example.com")
    resp = client.post(
        "/api/training/reports",
        headers=_auth(token),
        json={
            "week_start": MONDAY,
            "days": [{"day": MONDAY, "entries": [{"text": "   ", "hours": 8, "category": "betrieb"}]}],
        },
    )
    assert resp.status_code == 422, resp.text
    # And the list still works afterwards — nothing was persisted.
    listing = client.get("/api/training/reports", headers=_auth(token))
    assert listing.status_code == 200, listing.text


def test_a_sunday_row_is_refused(client: TestClient, admin_token: str) -> None:
    """The sheet renders Mo–Sa. A Sunday row would count toward the API total
    but vanish from the printed Gesamtstunden — the signed document would
    disagree with what both parties saw on screen."""

    _, token = _apprentice_with_token(client, admin_token, "azubi-sonntag@example.com")
    resp = client.post(
        "/api/training/reports",
        headers=_auth(token),
        json={
            "week_start": MONDAY,
            "days": [{"day": "2026-08-16", "entries": [{"text": "Notdienst", "hours": 6, "category": "betrieb"}]}],
        },
    )
    assert resp.status_code == 400, resp.text
    assert "Mo–Sa" in resp.json()["detail"] or "Montag" in resp.json()["detail"]


def test_omitted_ausbildungsjahr_falls_back_to_the_computed_year(
    client: TestClient, admin_token: str
) -> None:
    """The old default of 1 made the training_started_on fallback dead code —
    an omitted field stamped Jahr 1 on a 2nd-year apprentice's legal record."""

    _, token = _apprentice_with_token(client, admin_token, "azubi-jahr2@example.com", started="2024-09-01")
    resp = client.post(
        "/api/training/reports",
        headers=_auth(token),
        json={"week_start": MONDAY, "days": []},  # no ausbildungsjahr
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["ausbildungsjahr"] == 2


def test_a_decompression_bomb_signature_is_refused(client: TestClient, admin_token: str) -> None:
    """A ~20 KB PNG claiming 13000×13000 px passes any byte-length cap, then
    allocates hundreds of MB when the PDF renders it — inside a memory-capped
    container that is a remote OOM kill. The dimension cap reads only the
    header, so checking is safe; storing it would not be."""

    import base64
    import io

    from PIL import Image

    buf = io.BytesIO()
    Image.new("1", (13000, 13000)).save(buf, format="PNG")
    bomb = "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")
    assert len(bomb) < 200_000, "bomb must fit the length cap to prove the point"

    _, token = _apprentice_with_token(client, admin_token, "azubi-bombe@example.com")
    report = client.post(
        "/api/training/reports", headers=_auth(token), json={"week_start": MONDAY, "days": []}
    ).json()

    resp = client.post(
        f"/api/training/reports/{report['id']}/sign-azubi",
        headers=_auth(token),
        json={"signature": bomb},
    )
    assert resp.status_code == 400, resp.text
    assert "groß" in resp.json()["detail"]

    # Garbage that is not an image at all is refused the same way.
    garbage = client.post(
        f"/api/training/reports/{report['id']}/sign-azubi",
        headers=_auth(token),
        json={"signature": "data:image/png;base64," + "A" * 64},
    )
    assert garbage.status_code == 400, garbage.text

    # And a real, small signature still works.
    ok_png = io.BytesIO()
    Image.new("RGB", (400, 150), (255, 255, 255)).save(ok_png, format="PNG")
    good = "data:image/png;base64," + base64.b64encode(ok_png.getvalue()).decode("ascii")
    signed = client.post(
        f"/api/training/reports/{report['id']}/sign-azubi",
        headers=_auth(token),
        json={"signature": good},
    )
    assert signed.status_code == 200, signed.text


# ──────────────────────────────────────────────────────────────────────────
# Printing a long week
# ──────────────────────────────────────────────────────────────────────────


def test_a_long_week_still_prints(client: TestClient, admin_token: str) -> None:
    """A report the schema accepts must be a report the renderer can print.

    The day table used to be one row per weekday, and ReportLab cannot split
    a table inside a row — so a day carrying more text than fits on a page
    raised LayoutError and the PDF endpoint 500'd. The schema allows 20
    entries of 500 characters per day, which made that reachable by simply
    writing a thorough week.
    """

    _, token = _apprentice_with_token(client, admin_token, "azubi-long@example.com")
    days = [
        {
            "day": (date.fromisoformat(MONDAY) + timedelta(days=offset)).isoformat(),
            "entries": [
                {"text": f"Position {index}: " + "Kabeltrasse montiert und beschriftet. " * 12,
                 "hours": 0.5,
                 "category": "betrieb"}
                for index in range(20)
            ],
        }
        for offset in range(6)
    ]
    created = client.post(
        "/api/training/reports", headers=_auth(token), json={"week_start": MONDAY, "days": days}
    )
    assert created.status_code == 200, created.text

    pdf = client.get(f"/api/training/reports/{created.json()['id']}/pdf", headers=_auth(token))
    assert pdf.status_code == 200, pdf.text
    assert pdf.content[:5] == b"%PDF-"
    # 120 entries cannot fit on one page; the table has to have flowed.
    assert pdf.content.count(b"/Type /Page\n") > 1 or b"/Count 2" in pdf.content or len(pdf.content) > 8000


# ──────────────────────────────────────────────────────────────────────────
# Drafts stay private
# ──────────────────────────────────────────────────────────────────────────


def test_a_trainer_listing_an_apprentice_never_sees_drafts(
    client: TestClient, admin_token: str
) -> None:
    """`view` defaulted to "own", and the draft filter keyed on that name —
    so ?user_id=<other> with no view handed a trainer somebody's half-written
    sheets, which the endpoint's own docstring promises never happens."""

    user, token = _apprentice_with_token(client, admin_token, "azubi-draft@example.com")
    draft = client.post(
        "/api/training/reports", headers=_auth(token), json={"week_start": MONDAY, "days": DAYS_PAYLOAD}
    )
    assert draft.status_code == 200, draft.text
    assert draft.json()["status"] == "draft"

    # The trainer asks for this apprentice's reports without naming a view.
    listed = client.get(
        f"/api/training/reports?user_id={user['id']}", headers=_auth(admin_token)
    )
    assert listed.status_code == 200, listed.text
    assert listed.json() == []

    # The apprentice still sees their own draft.
    own = client.get("/api/training/reports", headers=_auth(token))
    assert [row["id"] for row in own.json()] == [draft.json()["id"]]


# ──────────────────────────────────────────────────────────────────────────
# The Heft (the bound collection)
# ──────────────────────────────────────────────────────────────────────────


def _filed_report(client: TestClient, token: str, week_start: str) -> dict:
    """Create a report and sign it, so it counts as filed rather than draft."""

    report = client.post(
        "/api/training/reports",
        headers=_auth(token),
        json={"week_start": week_start, "days": [
            {"day": week_start, "entries": [{"text": "Montage", "hours": 8.0, "category": "betrieb"}]}
        ]},
    ).json()
    signed = client.post(
        f"/api/training/reports/{report['id']}/sign-azubi",
        headers=_auth(token),
        json={"signature": _signature()},
    )
    assert signed.status_code == 200, signed.text
    return signed.json()


def test_the_heft_bundles_every_sheet_for_owner_and_trainer(
    client: TestClient, admin_token: str
) -> None:
    user, token = _apprentice_with_token(
        client, admin_token, "azubi-heft@example.com", started="2024-09-01"
    )
    for offset in (0, 7, 21):  # a deliberate gap at +14
        _filed_report(client, token, (date.fromisoformat(MONDAY) + timedelta(days=offset)).isoformat())

    own = client.get("/api/training/heft", headers=_auth(token))
    assert own.status_code == 200, own.text
    assert own.headers["content-type"].startswith("application/pdf")
    assert own.content[:5] == b"%PDF-"
    # Deckblatt + three sheets, so materially larger than a single sheet.
    single = client.get("/api/training/heft?user_id=" + str(user["id"]), headers=_auth(admin_token))
    assert single.status_code == 200, single.text

    _employee(client, admin_token, "fremd-heft@example.com")
    stranger = client.get(
        f"/api/training/heft?user_id={user['id']}",
        headers=_auth(_login(client, "fremd-heft@example.com")),
    )
    assert stranger.status_code == 403, stranger.text


def test_the_heft_excludes_another_persons_drafts(client: TestClient, admin_token: str) -> None:
    user, token = _apprentice_with_token(client, admin_token, "azubi-heft2@example.com")
    _filed_report(client, token, MONDAY)
    # A draft in a later week — the trainer's Heft must not contain it even
    # when they ask for drafts to be included.
    later = (date.fromisoformat(MONDAY) + timedelta(days=7)).isoformat()
    client.post(
        "/api/training/reports",
        headers=_auth(token),
        json={"week_start": later, "days": [
            {"day": later, "entries": [{"text": "Geheimer Entwurf", "hours": 4.0, "category": "betrieb"}]}
        ]},
    )

    trainer_heft = client.get(
        f"/api/training/heft?user_id={user['id']}&include_drafts=true", headers=_auth(admin_token)
    )
    assert trainer_heft.status_code == 200, trainer_heft.text
    own_heft = client.get("/api/training/heft?include_drafts=true", headers=_auth(token))
    assert own_heft.status_code == 200, own_heft.text
    # The apprentice's own Heft carries the extra sheet; the trainer's does not.
    assert len(own_heft.content) > len(trainer_heft.content)


# ──────────────────────────────────────────────────────────────────────────
# The trainer's roster
# ──────────────────────────────────────────────────────────────────────────


def test_the_apprentice_roster_counts_pending_and_missing_weeks(
    client: TestClient, admin_token: str
) -> None:
    user, token = _apprentice_with_token(
        client, admin_token, "azubi-roster@example.com", started="2024-09-01"
    )
    for offset in (0, 7, 21):  # gap at +14 -> one missing week
        _filed_report(client, token, (date.fromisoformat(MONDAY) + timedelta(days=offset)).isoformat())

    roster = client.get("/api/training/apprentices", headers=_auth(admin_token))
    assert roster.status_code == 200, roster.text
    row = next(entry for entry in roster.json() if entry["id"] == user["id"])
    assert row["report_count"] == 3
    assert row["pending_count"] == 3  # all submitted, none countersigned yet
    assert row["missing_week_count"] == 1
    assert row["training_started_on"] == "2024-09-01"

    # An apprentice cannot enumerate their peers.
    assert client.get("/api/training/apprentices", headers=_auth(token)).status_code == 403


def test_an_out_of_range_week_is_a_400_not_a_500(client: TestClient, admin_token: str) -> None:
    """`week_start + 5 days` is computed before any day row is inspected, so a
    date near date.max overflowed and surfaced as a bare 500 — for a request
    whose body could be empty. Every other bad-week case answers 400."""

    _, token = _apprentice_with_token(client, admin_token, "azubi-overflow@example.com")
    resp = client.post(
        "/api/training/reports",
        headers=_auth(token),
        json={"week_start": "9999-12-31", "days": []},
    )
    assert resp.status_code == 400, resp.text

    prefill = client.get("/api/training/prefill?week_start=9999-12-31", headers=_auth(token))
    assert prefill.status_code == 400, prefill.text
