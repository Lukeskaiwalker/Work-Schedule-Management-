"""Personal station badges, and the time a person spends on a Verteiler.

Two features that only make sense together. A badge is a person's own
DataMatrix: scanned at the rack it says "this is me" -- standing in for
tapping a name -- and in front of a board it clocks the person onto that
board. Scanned again, with no board, it clocks them off. The hours land under
the board's Materialliste as one position per person.

What must hold:

  * a badge is minted once per person, never stored in plain text, and stops
    working the moment it is rotated or its owner is deactivated;
  * only its owner -- and somebody with users:manage, who prints badges for
    colleagues -- can read it;
  * the station decides nothing on its own: the server turns (badge, board?)
    into exactly one of identify / clock_in / clock_out / switch /
    already_in, so two stations scanning the same badge agree;
  * a person is on at most one board at a time, and the DATABASE holds that
    rule, not the hope that two scans never race;
  * the hours are labour, not pieces: they must not leak into the
    Materialliste's piece totals;
  * a forgotten clock-out is correctable, by its owner for their own session
    and by a Werkstatt manager for anybody's, but never into the future or
    before the session began.
"""

from __future__ import annotations

import re
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.core.db import SessionLocal
from app.core.time import utcnow
from app.models.entities import PanelWorkSession, StationBadge, User
from tests.test_schaltplan import _auth, _create_panel, _customer
from tests.test_station_werkstatt import _login, _make_user, _pair

STATION = "/api/station/werkstatt"
BADGE_RE = re.compile(r"^SMPL-P-[0-9ABCDEFGHJKLMNPQRSTUVWX]{10}$")


def _badge(client: TestClient, token: str) -> dict:
    resp = client.get("/api/users/me/station-badge", headers=_auth(token))
    assert resp.status_code == 200, resp.text
    return resp.json()


def _scan(client: TestClient, station_token: str, code: str, panel_id: int | None = None):
    body: dict = {"code": code}
    if panel_id is not None:
        body["panel_id"] = panel_id
    return client.post(f"{STATION}/badge", headers=_auth(station_token), json=body)


def _material(client: TestClient, token: str, panel_id: int) -> dict:
    resp = client.get(f"/api/schaltplan/panels/{panel_id}/material", headers=_auth(token))
    assert resp.status_code == 200, resp.text
    return resp.json()


def _age_open_session(user_id: int, minutes: int) -> None:
    """Move the person's open session back in time, as if they had worked."""
    with SessionLocal() as db:
        row = db.scalars(
            select(PanelWorkSession).where(
                PanelWorkSession.user_id == user_id, PanelWorkSession.ended_at.is_(None)
            )
        ).one()
        row.started_at = utcnow() - timedelta(minutes=minutes)
        db.commit()


@pytest.fixture
def worker(client: TestClient, admin_token: str) -> dict:
    """An ordinary employee: reports:create, no werkstatt:manage, no users:manage."""
    user = _make_user(client, admin_token, "max.monteur@example.com", "employee")
    return {"user": user, "token": _login(client, "max.monteur@example.com")}


@pytest.fixture
def board(client: TestClient, admin_token: str) -> dict:
    customer = _customer(client, admin_token, name="Schulze")
    return _create_panel(client, admin_token, customer)


@pytest.fixture
def station(client: TestClient, admin_token: str) -> str:
    token, _ = _pair(client, admin_token, name="Werkstatt")
    return token


# --------------------------------------------------------------------------
# The badge itself
# --------------------------------------------------------------------------


def test_a_badge_is_minted_once_and_reads_back_the_same(client: TestClient, worker: dict) -> None:
    first = _badge(client, worker["token"])
    again = _badge(client, worker["token"])
    assert BADGE_RE.match(first["code"]), first["code"]
    assert again["code"] == first["code"]


def test_two_first_reads_at_once_end_with_one_badge(
    client: TestClient, worker: dict, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The profile page asks on mount, React's StrictMode asks twice, and two
    tabs ask at once: both see "no badge yet" and both try to mint. The unique
    index on user_id lets one insert win; the other must come back with THAT
    badge, not a 500 and not a second code."""
    from app.services import station_badges

    user_id = worker["user"]["id"]
    with SessionLocal() as winner_db:
        winner = station_badges.ensure_badge(winner_db, winner_db.get(User, user_id))
        winner_db.commit()
        winner_id, winner_code = winner.id, station_badges.badge_code(winner)

    real_get_badge = station_badges.get_badge
    reads = {"n": 0}

    def stale_first_read(db, uid):
        # The loser's first read happened just before the winner committed.
        reads["n"] += 1
        return None if reads["n"] == 1 else real_get_badge(db, uid)

    monkeypatch.setattr(station_badges, "get_badge", stale_first_read)
    with SessionLocal() as loser_db:
        badge = station_badges.ensure_badge(loser_db, loser_db.get(User, user_id))
        assert badge.id == winner_id
        assert station_badges.badge_code(badge) == winner_code
        assert reads["n"] >= 2  # the stale read really happened, then a real one
        loser_db.commit()  # the session survived the collision
    with SessionLocal() as db:
        assert len(db.scalars(select(StationBadge).where(StationBadge.user_id == user_id)).all()) == 1


def test_the_alphabet_leaves_out_what_a_scanner_or_an_eye_gets_wrong(client: TestClient, worker: dict) -> None:
    """No I or O (they read as 1 and 0 off a small label), and no Y or Z: the
    station's scanner sends German scancodes, and that pair is exactly the
    half of the keycode table that was inferred rather than measured."""
    code = _badge(client, worker["token"])["code"]
    assert not set(code.removeprefix("SMPL-P-")) & set("IOYZ")


def test_the_plain_code_is_never_stored(client: TestClient, worker: dict) -> None:
    code = _badge(client, worker["token"])["code"]
    with SessionLocal() as db:
        row = db.scalars(select(StationBadge).where(StationBadge.user_id == worker["user"]["id"])).one()
    assert code not in (row.code_hash, row.code_encrypted)
    assert code.encode() not in row.code_encrypted.encode()


def test_rotating_retires_the_old_badge(client: TestClient, worker: dict, station: str) -> None:
    old = _badge(client, worker["token"])["code"]
    rotated = client.post("/api/users/me/station-badge/rotate", headers=_auth(worker["token"]))
    assert rotated.status_code == 200, rotated.text
    new = rotated.json()["code"]
    assert new != old and BADGE_RE.match(new)
    assert _scan(client, station, old).status_code == 404
    assert _scan(client, station, new).status_code == 200


def test_a_badge_is_private_to_its_owner(client: TestClient, admin_token: str, worker: dict) -> None:
    other = _make_user(client, admin_token, "lisa.lehrling@example.com", "employee")
    resp = client.get(f"/api/admin/users/{other['id']}/station-badge", headers=_auth(worker["token"]))
    assert resp.status_code == 403, resp.text


def test_users_manage_can_print_a_colleagues_badge(client: TestClient, admin_token: str, worker: dict) -> None:
    """The person who hands out badges is not the person on them."""
    own = _badge(client, worker["token"])["code"]
    resp = client.get(f"/api/admin/users/{worker['user']['id']}/station-badge", headers=_auth(admin_token))
    assert resp.status_code == 200, resp.text
    assert resp.json()["code"] == own
    assert resp.json()["user_name"]

    rotated = client.post(
        f"/api/admin/users/{worker['user']['id']}/station-badge/rotate", headers=_auth(admin_token)
    )
    assert rotated.status_code == 200, rotated.text
    assert rotated.json()["code"] != own


def test_responses_carrying_a_badge_are_never_cached(client: TestClient, worker: dict) -> None:
    resp = client.get("/api/users/me/station-badge", headers=_auth(worker["token"]))
    assert "no-store" in resp.headers.get("cache-control", "")


# --------------------------------------------------------------------------
# Scanning a badge at the station
# --------------------------------------------------------------------------


def test_a_badge_with_no_board_identifies_its_owner(client: TestClient, worker: dict, station: str) -> None:
    """The replacement for tapping a name: nothing is written."""
    resp = _scan(client, station, _badge(client, worker["token"])["code"])
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["action"] == "identify"
    assert body["person"]["id"] == worker["user"]["id"]
    assert body["session"] is None
    with SessionLocal() as db:
        assert db.scalars(select(PanelWorkSession)).all() == []


def _identify_only(client: TestClient, station_token: str, code: str, **extra):
    body = {"code": code, "identify_only": True, **extra}
    return client.post(f"{STATION}/badge", headers=_auth(station_token), json=body)


def test_identify_only_names_without_clocking_out(
    client: TestClient, worker: dict, station: str, board: dict
) -> None:
    """Right after the rack refused an Ausgabe for want of a name, the badge is
    the name and nothing else: somebody clocked onto a board stays on it, and
    the answer says which board is still running, for the wall."""
    code = _badge(client, worker["token"])["code"]
    assert _scan(client, station, code, panel_id=board["id"]).json()["action"] == "clock_in"
    _age_open_session(worker["user"]["id"], minutes=50)

    resp = _identify_only(client, station, code)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["action"] == "identify"
    assert body["person"]["id"] == worker["user"]["id"]
    assert body["panel"]["id"] == board["id"]
    assert body["session"]["running"] is True
    with SessionLocal() as db:
        still_open = db.scalars(
            select(PanelWorkSession).where(
                PanelWorkSession.user_id == worker["user"]["id"], PanelWorkSession.ended_at.is_(None)
            )
        ).all()
        assert len(still_open) == 1


def test_identify_only_for_somebody_on_no_board(client: TestClient, worker: dict, station: str) -> None:
    resp = _identify_only(client, station, _badge(client, worker["token"])["code"])
    assert resp.status_code == 200, resp.text
    assert (resp.json()["action"], resp.json()["panel"], resp.json()["session"]) == ("identify", None, None)


def test_identify_only_cannot_also_name_a_board(
    client: TestClient, worker: dict, station: str, board: dict
) -> None:
    """The two mean opposite things; a request carrying both is a bug, not a choice."""
    resp = _identify_only(client, station, _badge(client, worker["token"])["code"], panel_id=board["id"])
    assert resp.status_code == 422, resp.text


def test_a_scan_counts_as_a_use(client: TestClient, worker: dict, station: str) -> None:
    code = _badge(client, worker["token"])["code"]
    _scan(client, station, code)
    after = _badge(client, worker["token"])
    assert after["use_count"] == 1
    assert after["last_used_at"] is not None


@pytest.mark.parametrize("code", ["SMPL-P-0000000000", "garbage", "", "SMPL-P-" + "A" * 300])
def test_an_unknown_badge_is_a_404_not_a_guess(client: TestClient, station: str, code: str) -> None:
    resp = _scan(client, station, code)
    assert resp.status_code in (404, 422), resp.text


def test_a_deactivated_persons_badge_stops_working(
    client: TestClient, admin_token: str, worker: dict, station: str
) -> None:
    code = _badge(client, worker["token"])["code"]
    gone = client.delete(f"/api/admin/users/{worker['user']['id']}", headers=_auth(admin_token))
    assert gone.status_code in (200, 204), gone.text
    assert _scan(client, station, code).status_code == 404


def test_only_a_station_may_scan(client: TestClient, worker: dict) -> None:
    """A user token is not a station token, in this direction too."""
    code = _badge(client, worker["token"])["code"]
    assert _scan(client, worker["token"], code).status_code in (401, 403)


# --------------------------------------------------------------------------
# Clocking onto a board
# --------------------------------------------------------------------------


def test_board_then_badge_clocks_in(client: TestClient, worker: dict, station: str, board: dict) -> None:
    code = _badge(client, worker["token"])["code"]
    resp = _scan(client, station, code, panel_id=board["id"])
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["action"] == "clock_in"
    assert body["panel"]["id"] == board["id"]
    assert body["session"]["running"] is True
    with SessionLocal() as db:
        row = db.scalars(select(PanelWorkSession)).one()
        assert row.station_id is not None  # tellable from a session typed in by hand


def test_badge_again_without_the_board_clocks_out(
    client: TestClient, worker: dict, station: str, board: dict
) -> None:
    """The whole point of the second scan: no need to find the board's code."""
    code = _badge(client, worker["token"])["code"]
    _scan(client, station, code, panel_id=board["id"])
    _age_open_session(worker["user"]["id"], minutes=95)

    resp = _scan(client, station, code)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["action"] == "clock_out"
    assert body["panel"]["id"] == board["id"]
    assert body["session"]["running"] is False
    assert 94 <= body["session"]["minutes"] <= 96


def test_a_double_scan_does_not_clock_straight_back_out(
    client: TestClient, worker: dict, station: str, board: dict
) -> None:
    """Pulling the trigger twice by habit must not end the session it began."""
    code = _badge(client, worker["token"])["code"]
    _scan(client, station, code, panel_id=board["id"])
    again = _scan(client, station, code)
    assert again.json()["action"] == "already_in"
    with SessionLocal() as db:
        assert db.scalars(select(PanelWorkSession)).one().ended_at is None


def test_the_same_board_scanned_again_toggles_out(
    client: TestClient, worker: dict, station: str, board: dict
) -> None:
    code = _badge(client, worker["token"])["code"]
    _scan(client, station, code, panel_id=board["id"])
    _age_open_session(worker["user"]["id"], minutes=30)
    assert _scan(client, station, code, panel_id=board["id"]).json()["action"] == "clock_out"


def test_a_second_board_switches_rather_than_stacking(
    client: TestClient, admin_token: str, worker: dict, station: str, board: dict
) -> None:
    other = _create_panel(client, admin_token, board["customer_id"], name="UV2", designation="UV2")
    code = _badge(client, worker["token"])["code"]
    _scan(client, station, code, panel_id=board["id"])
    _age_open_session(worker["user"]["id"], minutes=40)

    body = _scan(client, station, code, panel_id=other["id"]).json()
    assert body["action"] == "switch"
    assert body["closed"]["panel_id"] == board["id"]
    assert body["panel"]["id"] == other["id"]
    with SessionLocal() as db:
        open_rows = db.scalars(select(PanelWorkSession).where(PanelWorkSession.ended_at.is_(None))).all()
        assert [row.panel_id for row in open_rows] == [other["id"]]


def test_one_open_session_per_person_is_the_databases_rule(
    client: TestClient, worker: dict, station: str, board: dict
) -> None:
    """Not the endpoint's: two stations racing must not both open one."""
    code = _badge(client, worker["token"])["code"]
    _scan(client, station, code, panel_id=board["id"])
    with SessionLocal() as db:
        db.add(PanelWorkSession(panel_id=board["id"], user_id=worker["user"]["id"]))
        with pytest.raises(IntegrityError):
            db.commit()


def test_an_unknown_board_is_a_404(client: TestClient, worker: dict, station: str) -> None:
    code = _badge(client, worker["token"])["code"]
    assert _scan(client, station, code, panel_id=987654).status_code == 404


# --------------------------------------------------------------------------
# The hours under the Materialliste
# --------------------------------------------------------------------------


def test_the_hours_appear_per_person_under_the_board(
    client: TestClient, admin_token: str, worker: dict, station: str, board: dict
) -> None:
    code = _badge(client, worker["token"])["code"]
    _scan(client, station, code, panel_id=board["id"])
    _age_open_session(worker["user"]["id"], minutes=150)
    _scan(client, station, code)

    body = _material(client, admin_token, board["id"])
    assert body["labour_minutes"] in (149, 150, 151)
    assert body["labour_running"] == 0
    [line] = body["labour"]
    assert line["user_id"] == worker["user"]["id"]
    assert line["name"]
    assert line["sessions"] == 1
    assert line["running_since"] is None


def test_a_running_session_is_shown_but_not_yet_counted(
    client: TestClient, admin_token: str, worker: dict, station: str, board: dict
) -> None:
    """An open session has no length yet. Counting it would put a number on
    the board that grows by itself overnight if somebody forgets to scan out."""
    _scan(client, station, _badge(client, worker["token"])["code"], panel_id=board["id"])
    _age_open_session(worker["user"]["id"], minutes=60)

    body = _material(client, admin_token, board["id"])
    assert body["labour_minutes"] == 0
    assert body["labour_running"] == 1
    [line] = body["labour"]
    assert line["running_since"] is not None
    assert line["running_session_id"] is not None


def test_hours_are_not_pieces(client: TestClient, admin_token: str, worker: dict, station: str, board: dict) -> None:
    """The Materialliste's totals count parts. Hours must not leak into them."""
    before = _material(client, admin_token, board["id"])
    code = _badge(client, worker["token"])["code"]
    _scan(client, station, code, panel_id=board["id"])
    _age_open_session(worker["user"]["id"], minutes=120)
    _scan(client, station, code)
    after = _material(client, admin_token, board["id"])
    for key in ("planned_total", "scanned_total", "open_lines"):
        assert after[key] == before[key], key
    assert len(after["lines"]) == len(before["lines"])


# --------------------------------------------------------------------------
# Correcting a forgotten clock-out
# --------------------------------------------------------------------------


def _end(client: TestClient, token: str, panel_id: int, session_id: int, **body):
    return client.post(
        f"/api/schaltplan/panels/{panel_id}/work-sessions/{session_id}/end",
        headers=_auth(token),
        json=body,
    )


def _running_id(client: TestClient, admin_token: str, panel_id: int) -> int:
    return _material(client, admin_token, panel_id)["labour"][0]["running_session_id"]


def test_the_owner_can_end_their_own_session_at_the_real_time(
    client: TestClient, admin_token: str, worker: dict, station: str, board: dict
) -> None:
    _scan(client, station, _badge(client, worker["token"])["code"], panel_id=board["id"])
    _age_open_session(worker["user"]["id"], minutes=600)
    session_id = _running_id(client, admin_token, board["id"])

    ended_at = (utcnow() - timedelta(minutes=480)).isoformat()
    resp = _end(client, worker["token"], board["id"], session_id, ended_at=ended_at)
    assert resp.status_code == 200, resp.text
    assert resp.json()["labour_minutes"] in (119, 120, 121)
    with SessionLocal() as db:
        assert db.get(PanelWorkSession, session_id).ended_via == "web"


def test_ending_someone_elses_session_needs_werkstatt_manage(
    client: TestClient, admin_token: str, worker: dict, station: str, board: dict
) -> None:
    colleague = _make_user(client, admin_token, "kai.kollege@example.com", "employee")
    colleague_token = _login(client, "kai.kollege@example.com")
    _scan(client, station, _badge(client, worker["token"])["code"], panel_id=board["id"])
    session_id = _running_id(client, admin_token, board["id"])

    assert _end(client, colleague_token, board["id"], session_id).status_code == 403
    assert _end(client, admin_token, board["id"], session_id).status_code == 200
    assert colleague["id"]  # the fixture user exists; only the permission differs


@pytest.mark.parametrize("offset_minutes", [-30, +30])
def test_an_end_before_the_start_or_in_the_future_is_refused(
    client: TestClient, admin_token: str, worker: dict, station: str, board: dict, offset_minutes: int
) -> None:
    _scan(client, station, _badge(client, worker["token"])["code"], panel_id=board["id"])
    _age_open_session(worker["user"]["id"], minutes=10)
    session_id = _running_id(client, admin_token, board["id"])
    if offset_minutes < 0:
        when = utcnow() - timedelta(minutes=10 + 30)  # before it started
    else:
        when = utcnow() + timedelta(minutes=offset_minutes)  # not yet happened
    resp = _end(client, admin_token, board["id"], session_id, ended_at=when.isoformat())
    assert resp.status_code == 400, resp.text


def test_a_browser_clock_running_a_little_fast_still_ends_at_now(
    client: TestClient, admin_token: str, worker: dict, station: str, board: dict
) -> None:
    """The end form offers the BROWSER's now; a workshop PC two minutes fast
    must not be told that its now has not happened yet. Small skew is clamped
    to the server's now -- the +30 min case above is still refused."""
    _scan(client, station, _badge(client, worker["token"])["code"], panel_id=board["id"])
    _age_open_session(worker["user"]["id"], minutes=60)
    session_id = _running_id(client, admin_token, board["id"])

    fast_now = utcnow() + timedelta(minutes=2)
    resp = _end(client, worker["token"], board["id"], session_id, ended_at=fast_now.isoformat())
    assert resp.status_code == 200, resp.text
    assert resp.json()["labour_minutes"] in (59, 60, 61)
    with SessionLocal() as db:
        assert db.get(PanelWorkSession, session_id).ended_at <= utcnow()


def test_a_closed_session_cannot_be_ended_again(
    client: TestClient, admin_token: str, worker: dict, station: str, board: dict
) -> None:
    code = _badge(client, worker["token"])["code"]
    _scan(client, station, code, panel_id=board["id"])
    session_id = _running_id(client, admin_token, board["id"])
    _age_open_session(worker["user"]["id"], minutes=45)
    _scan(client, station, code)
    assert _end(client, admin_token, board["id"], session_id).status_code == 409
