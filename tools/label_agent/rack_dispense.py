"""The rack's Ausgabe of consumables: what each decision costs, and what the wall says.

``scan_router`` decides what a scan means and stays pure; this does the rest
for the decisions the consumable Ausgabe added -- picking a person or a
project, booking ``consumption`` and taking it back -- exactly the way
``server.Agent`` does it for every older decision: one SMPL call through the
station client, the undo record once SMPL accepted, the ``last`` card both
screens render, and one flash in the workshop's own words.

It lives beside ``server.py`` rather than in it because that file is several
thousand lines already; it reaches the agent's kiosk, router and client
through the agent it is handed, and never imports ``server`` (which loads it).

The sentences on the wall, in one place:

* ``Verbraucht: 3 × Kabelbinder`` / ``→ 381 Neubau Schulze`` -- a consumable
  left stock for good, booked to that project (or ``→ ohne Projekt``);
* ``Zurück ins Lager: 2 × Kabelbinder`` / ``← 381 Neubau Schulze`` --
  leftovers carried back, out of the bucket SMPL booked them from;
* ``Zurück: 10 × Kabelbinder (Leihe beendet)`` -- what came back was still
  out on an old loan (a consumable lent before consumables were consumed),
  and SMPL closed that loan instead;
* a short shelf is booked anyway -- the person is holding the part -- and the
  flash turns into a warning carrying SMPL's sentence about the count; its
  ABBRUCH says ``Nachbuchung 38 zurückgenommen`` when SMPL took the top-up
  back with it;
* an SMPL too old to know the routes books nothing and says
  ``SMPL muss aktualisiert werden``.

Every booking carries a ``request_id``. One SMPL never answered (the try and
its retry timed out -- it may still have landed) keeps its token in the
router, and a re-scan of the same article, quantity, person and project
sends it again, so SMPL replays the lost booking instead of making a second.
"""

from __future__ import annotations

import uuid
from typing import Any, Dict, Optional

import dispense_codes

SCREEN_RACK = "regal"

TITLE_OUTDATED = "SMPL muss aktualisiert werden"
DETAIL_OUTDATED = (
    "Nichts gebucht – diese SMPL-Version kann an der Station noch keinen Verbrauch buchen."
)
_CONSUMPTION = "consumption"
_CONSUMPTION_UNDO = "consumption_undo"
#: What SMPL books instead of a ``consumption_undo`` when the pieces carried
#: back were still out on a loan: it closes that loan.
_RETURN = "return"
#: Said after the detail when SMPL answered a re-scan with the booking the
#: lost try had already made.
REPLAYED = "war schon gebucht"


def _int(value: Any) -> Optional[int]:
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value


def _dict(value: Any) -> Dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _token() -> str:
    """One booking's idempotency token (see ``WerkstattClient.consumption``)."""
    return uuid.uuid4().hex


class RackDispense:
    """The consumable Ausgabe's side effects, for one agent."""

    def __init__(self, agent) -> None:
        self._agent = agent

    # -- plumbing ---------------------------------------------------------

    @property
    def _router(self):
        return self._agent.router

    @property
    def _kiosk(self):
        return self._agent.kiosk

    @property
    def _client(self):
        return self._agent.werkstatt

    @property
    def _sw(self):
        return self._agent._sw

    def apply(self, decision, resolved) -> None:
        handler = _HANDLERS.get(decision.action)
        if handler is not None:
            handler(self, decision, resolved)

    def _flash(self, level: str, title: str, detail: str = "", code: str = "") -> None:
        self._kiosk.flash(SCREEN_RACK, level, title, detail, code=code)

    def _person_name(self) -> str:
        person = self._router.assignee or {}
        return str(person.get("name") or "").strip()

    def _attempt(self, decision, article_id: int, post) -> Any:
        """One booking under its token: the held one for a re-scan, else new.

        ``post`` sends the booking with the token it is handed. A failure SMPL
        never answered keeps the token for the re-scan; any answer -- booked,
        replayed or refused -- frees it.
        """
        key = (decision.action, article_id, decision.qty, decision.assignee_user_id,
               decision.project_id, bool(decision.pick_project))
        token = self._router.kept_request_id(key) or _token()
        result = post(token)
        if self._sw.unanswered(result):
            self._router.keep_request_id(key, token)
        else:
            self._router.drop_request_id(key)
        return result

    # -- the screen's own taps --------------------------------------------

    def screen_action(self, action: str, value: Any) -> Optional[str]:
        """``project`` (an id; null goes back to the tiles) or ``no_project``.

        Answers the refusal -- the same sentence a scanned code gets -- or
        None. Validated against the cached lists inside the router, never by
        asking SMPL: a tap has to land at once.
        """
        if action == "no_project":
            error = self._router.select_project(None)
        elif value in (None, ""):
            self._router.clear_project()
            error = None
        else:
            project_id = _int(value)
            if project_id is None or project_id <= 0:
                return "'value' must be a project id or null"
            error = self._router.select_project(project_id)
        self._kiosk.bump(SCREEN_RACK)
        return error

    def refresh_projects(self, *, force: bool = False) -> None:
        """Hand the router each person's project tiles. Off the request path."""
        if self._router.set_crew_projects(self._client.crew_projects(force=force)):
            self._kiosk.bump(SCREEN_RACK)

    # -- picking ----------------------------------------------------------

    def _applied_select_person(self, decision, _resolved) -> None:
        if self._router.direction != "aus":
            detail = "Name gewählt"
        elif self._router.offered_projects():
            detail = "Ausgabe – Projekt wählen oder Artikel scannen"
        else:
            detail = "Ausgabe – Artikel scannen"
        self._flash("ok", self._person_name() or "Name gewählt", detail, decision.code)

    def _applied_unknown_person(self, decision, _resolved) -> None:
        self._flash("error", "Person unbekannt", decision.error or "", decision.code)

    def _applied_select_project(self, decision, _resolved) -> None:
        project = self._router.project
        title = dispense_codes.project_label(project) if project else "Ohne Projekt"
        detail = "Ausgabe für %s" % (self._person_name() or "?")
        self._flash("ok", title, detail, decision.code)

    def _applied_selection_refused(self, decision, _resolved) -> None:
        self._flash("error", "Projekt nicht gewählt", decision.error or "", decision.code)

    def _applied_close_selection(self, decision, _resolved) -> None:
        self._flash("ok", "Ausgabe beendet", "Name und Projekt zurückgesetzt", decision.code)

    # -- booking ----------------------------------------------------------

    def _applied_consumption(self, decision, resolved) -> None:
        """An Ausgabe of a consumable: ``POST /consumptions``."""
        self._kiosk.clear_name_prompt()
        article_id = self._sw.article_id_of(resolved)
        if article_id is None:
            self._agent._unstocked(decision, resolved)
            return
        result = self._attempt(decision, article_id, lambda token: self._client.consumption(
            article_id, decision.qty, assignee_user_id=decision.assignee_user_id,
            project_id=decision.project_id, request_id=token,
        ))
        if not result.ok:
            self._refused(decision, resolved, result, "Nicht gebucht")
            return
        self._booked(decision, resolved, article_id, result, _CONSUMPTION)

    def _applied_consumption_return(self, decision, resolved) -> None:
        """A Rückgabe of a consumable: ``POST /consumptions/undo``.

        With no project picked SMPL decides what came back: the person's own
        consumption, else an open loan of the article (a consumable lent out
        before consumables were consumed -- it answers ``booked_as:
        "return"``), else the newest consumption of anybody. Its answer is the
        whole truth: the station books nothing of its own on top, not even
        after a refusal, so nothing is ever taken back twice.
        """
        self._kiosk.clear_name_prompt()
        article_id = self._sw.article_id_of(resolved)
        if article_id is None:
            self._agent._unstocked(decision, resolved)
            return
        result = self._attempt(decision, article_id, lambda token: self._client.consumption_undo(
            article_id, decision.qty, assignee_user_id=decision.assignee_user_id,
            project_id=decision.project_id, pick_project=decision.pick_project,
            request_id=token,
        ))
        if not result.ok:
            self._refused(decision, resolved, result, "Nicht zurückgenommen")
            return
        if _dict(result.data).get("booked_as") == _RETURN:
            self._closed_a_loan(decision, resolved, article_id, result)
            return
        self._booked(decision, resolved, article_id, result, _CONSUMPTION_UNDO)

    def _closed_a_loan(self, decision, resolved, article_id, result) -> None:
        """SMPL closed an old loan with the pieces carried back.

        Recorded as the rack records any Rückgabe -- a ``return`` movement on
        the name of whose loan it was, the borrower SMPL answered with -- so
        its ABBRUCH lends exactly that loan out again (``checkout`` onto the
        borrower), never a consumption and never onto whoever is tapped now.
        """
        data = _dict(result.data)
        article = _dict(data.get("article")) or self._agent._article_from(resolved, decision.code)
        qty = _int(data.get("quantity")) or decision.qty
        borrower = _dict(data.get("assignee"))
        label = dispense_codes.project_label(dispense_codes.project_ref(data.get("project")))
        self._router.note_commit(
            screen=SCREEN_RACK, action="movement", article_id=article_id,
            movement_type=_RETURN, qty=qty,
            assignee_user_id=_int(borrower.get("id")) or decision.assignee_user_id,
            movement_id=_int(data.get("movement_id")),
        )
        self._show(article, _RETURN, qty, data, label)
        name = article.get("item_name") or decision.code
        detail = "← " + label
        holder = str(borrower.get("display_name") or "").strip()
        if holder:
            detail = "Ausgeliehen an %s · %s" % (holder, detail)
        self._flash("ok", "Zurück: %d × %s (Leihe beendet)" % (qty, name),
                    _with_replay(detail, data), decision.code)

    def _refused(self, decision, resolved, result, title: str) -> None:
        self._router.note_pending(self._agent._article_from(resolved, decision.code),
                                  decision.qty)
        if self._sw.is_outdated(result):
            self._flash("error", TITLE_OUTDATED, DETAIL_OUTDATED, decision.code)
            return
        self._flash("error", title, result.error or "", decision.code)

    def _booked(self, decision, resolved, article_id, result, movement_type: str) -> None:
        """Record what SMPL booked -- its quantity and its bucket -- and say it."""
        data = _dict(result.data)
        article = _dict(data.get("article")) or self._agent._article_from(resolved, decision.code)
        qty = _int(data.get("quantity")) or decision.qty
        project = dispense_codes.project_ref(data.get("project"))
        label = dispense_codes.project_label(project)
        self._router.note_commit(
            screen=SCREEN_RACK, action=_CONSUMPTION, article_id=article_id,
            movement_type=movement_type, qty=qty,
            assignee_user_id=decision.assignee_user_id,
            project_id=project["id"] if project else None,
            undo_request_id=_token(),
            movement_id=_int(data.get("movement_id")),
        )
        self._show(article, movement_type, qty, data, label)
        name = article.get("item_name") or decision.code
        if movement_type == _CONSUMPTION:
            title, detail = "Verbraucht: %d × %s" % (qty, name), "→ " + label
        else:
            title, detail = "Zurück ins Lager: %d × %s" % (qty, name), "← " + label
        detail = _with_replay(detail, data)
        warning = data.get("stock_warning")
        if isinstance(warning, str) and warning.strip():
            # Booked -- the person is holding the parts -- but the shelf count
            # was short, and that is worth more than a green tick.
            self._flash("warn", title, "%s · %s" % (detail, warning.strip()), decision.code)
            return
        self._flash("ok", title, detail, decision.code)

    def _show(self, article, movement_type: str, qty: int, data, label: str) -> None:
        assignee = _dict(data.get("assignee"))
        self._kiosk.set_last({
            "article": article,
            "machine": None,
            "movement": {"movement_type": movement_type, "qty": qty,
                         "movement_id": data.get("movement_id"), "at": self._agent._clock(),
                         "project_label": label,
                         "assignee_name": assignee.get("display_name")},
        })

    # -- ABBRUCH ----------------------------------------------------------

    def _applied_undo_consumption(self, decision, _resolved) -> None:
        """Post the inverse into the recorded bucket; forget it only once it landed."""
        undo = decision.undo or {}
        inverse = undo.get("movement_type")
        if inverse == _CONSUMPTION_UNDO:
            result = self._client.consumption_undo(
                undo.get("article_id"), undo.get("qty", 1),
                assignee_user_id=undo.get("assignee_user_id"),
                project_id=undo.get("project_id"), pick_project=False,
                request_id=undo.get("request_id"),
                undo_of_movement_id=undo.get("undo_of_movement_id"))
        else:
            result = self._client.consumption(
                undo.get("article_id"), undo.get("qty", 1),
                assignee_user_id=undo.get("assignee_user_id"),
                project_id=undo.get("project_id"), request_id=undo.get("request_id"))
        if not result.ok:
            # The record is kept: one network blip must not cost the undo.
            detail = DETAIL_OUTDATED if self._sw.is_outdated(result) else (result.error or "")
            self._flash("error", "Abbruch fehlgeschlagen", detail, decision.code)
            return
        self._router.confirm_undo(SCREEN_RACK)
        data = _dict(result.data)
        article = _dict(data.get("article")) or {"id": undo.get("article_id"), "item_name": None}
        qty = _int(data.get("quantity")) or int(undo.get("qty") or 1)
        label = dispense_codes.project_label(dispense_codes.project_ref(data.get("project")))
        self._show(article, inverse or _CONSUMPTION_UNDO, qty, data, label)
        what = "Verbrauch zurück" if inverse == _CONSUMPTION_UNDO else "Wieder verbraucht"
        detail = "%s: %d × %s" % (what, qty, article.get("item_name") or decision.code)
        top_up = _int(data.get("reversed_top_up"))
        if top_up and top_up > 0:
            # The short shelf's top-up went with it: the count is back to
            # what it was before the wrong scan.
            detail += " · Nachbuchung %d zurückgenommen" % top_up
        self._flash("ok", "Buchung zurückgenommen", detail, decision.code)


def _with_replay(detail: str, data: Dict[str, Any]) -> str:
    """The detail, plus a word when SMPL answered with an earlier booking."""
    return "%s · %s" % (detail, REPLAYED) if data.get("replayed") is True else detail


_HANDLERS = {
    "select_person": RackDispense._applied_select_person,
    "unknown_person": RackDispense._applied_unknown_person,
    "select_project": RackDispense._applied_select_project,
    "selection_refused": RackDispense._applied_selection_refused,
    "close_selection": RackDispense._applied_close_selection,
    "consumption": RackDispense._applied_consumption,
    "consumption_return": RackDispense._applied_consumption_return,
    "undo_consumption": RackDispense._applied_undo_consumption,
}

#: The router actions this module answers for; ``server._APPLY`` routes them here.
ACTIONS = tuple(_HANDLERS)
