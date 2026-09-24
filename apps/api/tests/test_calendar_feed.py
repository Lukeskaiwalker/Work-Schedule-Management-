"""The Kalender-Abo — ``/api/calendar``.

What must hold: a user gets one subscription whose link can be shown again;
the feed behind the token is valid iCalendar with one stable-UID event per
assigned task (timed with the Berlin zone, multi-day timed as a daily
rule, dateless-time tasks all-day, done ones ticked), plus approved
vacation and Berufsschule; another user's tasks never appear; long lines
are folded; a fetch is remembered; rotating kills the old link; deleting
kills the subscription; an unknown token is a plain 404.
"""

from __future__ import annotations

from datetime import date, timedelta

from fastapi.testclient import TestClient
from sqlalchemy import select

from app.core.db import SessionLocal
from app.models.entities import User, VacationRequest
from app.services import calendar_feed as feeds
from tests.conftest import auth_headers


def _user(client: TestClient, admin_token: str, email: str, name: str) -> tuple[int, str]:
    created = client.post(
        "/api/admin/users",
        headers=auth_headers(admin_token),
        json={"email": email, "password": "Password123!", "full_name": name, "role": "employee"},
    )
    assert created.status_code == 200, created.text
    login = client.post("/api/auth/login", json={"email": email, "password": "Password123!"})
    assert login.status_code == 200, login.text
    return created.json()["id"], login.headers["X-Access-Token"]


def _customer(client: TestClient, token: str) -> int:
    resp = client.post("/api/customers", headers=auth_headers(token), json={"name": "Familie Schulze", "address": "Hauptstr. 5, 58452 Witten"})
    assert resp.status_code == 200, resp.text
    return resp.json()["id"]


def _task(client: TestClient, admin_token: str, **fields) -> dict:
    resp = client.post("/api/tasks", headers=auth_headers(admin_token), json=fields)
    assert resp.status_code == 200, resp.text
    return resp.json()


def _events(text: str) -> list[dict[str, str]]:
    """Unfold and split the VEVENTs into property dicts (first occurrence wins)."""
    unfolded = text.replace("\r\n ", "")
    out: list[dict[str, str]] = []
    current: dict[str, str] | None = None
    for line in unfolded.split("\r\n"):
        if line == "BEGIN:VEVENT":
            current = {}
        elif line == "END:VEVENT" and current is not None:
            out.append(current)
            current = None
        elif current is not None and ":" in line:
            name, value = line.split(":", 1)
            current.setdefault(name, value)
    return out


def test_folding_and_escaping_follow_rfc_5545() -> None:
    long = "DESCRIPTION:" + "ä" * 60  # 2-byte characters: the fold must land between them
    folded = feeds.ics_fold(long)
    for piece in folded.split("\r\n"):
        assert len(piece.encode("utf-8")) <= 75
    assert folded.replace("\r\n ", "") == long
    assert feeds.ics_escape("a, b; c\\d\nnext") == "a\\, b\\; c\\\\d\\nnext"


def test_the_feed_lists_the_users_tasks_vacation_and_school_days(client: TestClient, admin_token: str) -> None:
    me_id, me_token = _user(client, admin_token, "me@example.com", "Mia Monteurin")
    other_id, _ = _user(client, admin_token, "other@example.com", "Ole Anders")
    customer = _customer(client, admin_token)
    today = date.today()
    timed = _task(client, admin_token, title="Zählerschrank tauschen", customer_id=customer, assignee_ids=[me_id, other_id],
                  due_date=str(today + timedelta(days=3)), start_time="08:00", estimated_hours=3.5, description="Mit Kollegen; Material in Kiste 4, Schlüssel beim Nachbarn")
    span = _task(client, admin_token, title="Neubau verkabeln", customer_id=customer, assignee_ids=[me_id],
                 due_date=str(today + timedelta(days=10)), end_date=str(today + timedelta(days=12)), start_time="07:30", estimated_hours=8)
    allday = _task(client, admin_token, title="Abnahme", customer_id=customer, assignee_ids=[me_id], due_date=str(today + timedelta(days=20)))
    done = _task(client, admin_token, title="Altes", customer_id=customer, assignee_ids=[me_id], due_date=str(today - timedelta(days=5)))
    assert client.patch(f"/api/tasks/{done['id']}", headers=auth_headers(admin_token), json={"status": "done"}).status_code == 200
    theirs = _task(client, admin_token, title="Fremde Aufgabe", customer_id=customer, assignee_ids=[other_id], due_date=str(today + timedelta(days=4)))
    ancient = _task(client, admin_token, title="Uralt", customer_id=customer, assignee_ids=[me_id], due_date=str(today - timedelta(days=400)))
    with SessionLocal() as db:
        db.add(VacationRequest(user_id=me_id, start_date=today + timedelta(days=30), end_date=today + timedelta(days=34), status="approved"))
        db.add(VacationRequest(user_id=me_id, start_date=today + timedelta(days=40), end_date=today + timedelta(days=41), status="pending"))
        db.commit()
    school = client.post(
        "/api/time/school-absences",
        headers=auth_headers(admin_token),
        json={"user_id": me_id, "title": "Berufsschule", "start_date": str(today), "end_date": str(today), "recurrence_weekday": 0, "recurrence_until": str(today + timedelta(days=60))},
    )
    assert school.status_code in (200, 201), school.text

    created = client.post("/api/calendar/feed", headers=auth_headers(me_token))
    assert created.status_code == 200, created.text
    feed = created.json()
    assert feed["url"].startswith("http") and "/api/calendar/smpl_cal_" in feed["url"] and feed["url"].endswith("/feed.ics")
    assert feed["webcal_url"].startswith("webcal://") and feed["last_fetched_at"] is None and feed["fetch_count"] == 0
    token = feed["url"].split("/api/calendar/", 1)[1].split("/", 1)[0]

    fetched = client.get(f"/api/calendar/{token}/feed.ics", headers={"User-Agent": "iOS/26.0 dataaccessd/1.0"})
    assert fetched.status_code == 200, fetched.text
    assert fetched.headers["content-type"].startswith("text/calendar")
    text = fetched.text
    assert text.startswith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n") and text.endswith("END:VCALENDAR\r\n")
    assert "X-WR-CALNAME:SMPL · Mia Monteurin" in text.replace("\r\n ", "")
    assert "BEGIN:VTIMEZONE\r\nTZID:Europe/Berlin" in text
    for line in text.split("\r\n"):
        assert len(line.encode("utf-8")) <= 75, line

    events = {e["SUMMARY"]: e for e in _events(text)}
    assert "Fremde Aufgabe" not in events and "Uralt" not in events
    assert set(events) >= {"Zählerschrank tauschen", "Neubau verkabeln", "Abnahme", "✓ Altes", "Urlaub", "Berufsschule"}

    e = events["Zählerschrank tauschen"]
    assert e["UID"] == f"smpl-task-{timed['id']}@testserver"
    assert e["DTSTART;TZID=Europe/Berlin"] == (today + timedelta(days=3)).strftime("%Y%m%d") + "T080000"
    assert e["DTEND;TZID=Europe/Berlin"] == (today + timedelta(days=3)).strftime("%Y%m%d") + "T113000"
    assert "RRULE" not in e and e["STATUS"] == "CONFIRMED"
    assert e["LOCATION"] == "Hauptstr. 5\\, 58452 Witten"
    description = e["DESCRIPTION"]
    assert "Kunde: Familie Schulze" in description and "Status: offen" in description
    assert "Aufwand: 3.5 h" in description and "Mit: Ole Anders" in description
    assert "Mit Kollegen\\; Material in Kiste 4\\, Schlüssel beim Nachbarn" in description

    e = events["Neubau verkabeln"]
    assert e["RRULE"] == "FREQ=DAILY;COUNT=3" and e["DTSTART;TZID=Europe/Berlin"].endswith("T073000")
    assert e["UID"] == f"smpl-task-{span['id']}@testserver"

    e = events["Abnahme"]
    assert e["DTSTART;VALUE=DATE"] == (today + timedelta(days=20)).strftime("%Y%m%d")
    assert e["DTEND;VALUE=DATE"] == (today + timedelta(days=21)).strftime("%Y%m%d")
    assert e["UID"] == f"smpl-task-{allday['id']}@testserver"

    assert events["✓ Altes"]["UID"] == f"smpl-task-{done['id']}@testserver"
    assert events["Urlaub"]["DTEND;VALUE=DATE"] == (today + timedelta(days=35)).strftime("%Y%m%d")
    assert events["Urlaub"]["TRANSP"] == "TRANSPARENT"
    assert events["Berufsschule"]["RRULE"].startswith("FREQ=WEEKLY;UNTIL=")
    assert sum(1 for e in _events(text) if e["SUMMARY"] == "Urlaub") == 1  # the pending one stays out

    # The fetch is remembered and the link can be shown again.
    shown = client.get("/api/calendar/feed", headers=auth_headers(me_token))
    assert shown.status_code == 200 and shown.json()["url"] == feed["url"]
    assert shown.json()["fetch_count"] == 1 and shown.json()["last_fetch_agent"] == "iOS/26.0 dataaccessd/1.0"
    assert shown.json()["last_fetched_at"] is not None


def test_rotation_kills_the_old_link_and_deletion_the_subscription(client: TestClient, admin_token: str) -> None:
    _, me_token = _user(client, admin_token, "rotate@example.com", "Rita Rotiert")
    assert client.get("/api/calendar/feed", headers=auth_headers(me_token)).json() is None
    first = client.post("/api/calendar/feed", headers=auth_headers(me_token)).json()
    token_a = first["url"].split("/api/calendar/", 1)[1].split("/", 1)[0]
    assert client.get(f"/api/calendar/{token_a}/feed.ics").status_code == 200

    second = client.post("/api/calendar/feed", headers=auth_headers(me_token)).json()
    token_b = second["url"].split("/api/calendar/", 1)[1].split("/", 1)[0]
    assert token_a != token_b and second["fetch_count"] == 0
    assert client.get(f"/api/calendar/{token_a}/feed.ics").status_code == 404
    assert client.get(f"/api/calendar/{token_b}/feed.ics").status_code == 200
    with SessionLocal() as db:
        assert db.scalar(select(feeds.CalendarFeed.token_hash).where(feeds.CalendarFeed.token_hash == feeds.hash_token(token_b))) is not None

    assert client.delete("/api/calendar/feed", headers=auth_headers(me_token)).status_code == 204
    assert client.get("/api/calendar/feed", headers=auth_headers(me_token)).json() is None
    assert client.get(f"/api/calendar/{token_b}/feed.ics").status_code == 404
    assert client.delete("/api/calendar/feed", headers=auth_headers(me_token)).status_code == 204  # idempotent

    assert client.get("/api/calendar/nonsense/feed.ics").status_code == 404
    assert client.get("/api/calendar/smpl_cal_notreal/feed.ics").status_code == 404
    anonymous = TestClient(client.app)  # the shared client carries the login cookie
    assert anonymous.get("/api/calendar/feed").status_code == 401
    assert anonymous.post("/api/calendar/feed").status_code == 401


def test_a_deactivated_user_s_link_stops_working(client: TestClient, admin_token: str) -> None:
    user_id, me_token = _user(client, admin_token, "gone@example.com", "Gerd Geht")
    feed = client.post("/api/calendar/feed", headers=auth_headers(me_token)).json()
    token = feed["url"].split("/api/calendar/", 1)[1].split("/", 1)[0]
    assert client.get(f"/api/calendar/{token}/feed.ics").status_code == 200
    with SessionLocal() as db:
        user = db.get(User, user_id)
        user.is_active = False
        db.add(user)
        db.commit()
    assert client.get(f"/api/calendar/{token}/feed.ics").status_code == 404
