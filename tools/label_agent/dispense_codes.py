"""The rack's Ausgabe vocabulary: who takes something, and for which project.

Owner, 2026-10-10: *anything that is not in the Maschinen tab is a consumable;
scanned out it leaves stock for good and is installed at a work site, and the
person taking it may book it to one of their current projects.* And: every
step has to work with a QR code, because the rack is worked with the scanner.

This module is the vocabulary for that, and nothing else -- no I/O, no clock,
no state. ``scan_router`` (the state machine), ``smpl_werkstatt`` (the client)
and the rack page all read it, so the codes and the shape of a project are
spelled once.

**The on-screen codes.** A person and a project each get a code drawn next to
their tile on the rack screen:

* ``SMPL-CMD-PERSON-<user_id>`` -- picks that person for the Ausgabe. A stable
  id, not a position on the screen: the crew list is re-fetched every minute
  and re-sorted by name, so "the third tile" can be somebody else by the time
  the imager has focused. The id is no secret -- tapping the tile is the same
  act -- which is also why the badge (``SMPL-P-…``) is never drawn: a badge is
  a bearer token, this is a name tag.
* ``SMPL-CMD-PROJEKT-<project_id>`` -- picks one of the projects offered for
  the selected person. The numeric id, never the project number, which is
  free text and may hold characters the scanner cannot type.
* ``SMPL-CMD-OHNE-PROJEKT`` -- the explicit "no project" choice. Static, so it
  is an ordinary command code as well.

Every one of them uses ``0-9``, ``A-X`` and ``-`` only: no ``Y``/``Z`` (a
command is never sent to ``/resolve``, so the Y/Z retry that rescues a scanner
in the wrong keyboard layout cannot rescue it), and at most 26 characters, so
the symbol stays a version-2 QR code -- 66 px at two pixels a module, the size
the direction codes already are on that screen.
"""

from __future__ import annotations

from typing import Any, Dict, Iterable, Optional, Tuple

__all__ = [
    "KIND_CONSUMABLE",
    "KIND_TOOL",
    "PERSON_PREFIX",
    "PROJECT_PREFIX",
    "CMD_OHNE_PROJEKT",
    "PARAMETRIC_PREFIXES",
    "SCREEN_CODE_ALPHABET",
    "MAX_SCREEN_CODE_LEN",
    "MAX_ID",
    "MAX_PROJECTS_PER_PERSON",
    "PROJECT_HINTS",
    "SELECT_PERSON",
    "SELECT_PROJECT",
    "SELECT_NO_PROJECT",
    "person_code",
    "project_code",
    "selection_of",
    "is_selection_code",
    "fits_the_screen_alphabet",
    "clean_crew",
    "clean_projects",
    "clean_crew_projects",
    "clean_project_mapping",
    "offered",
    "project_ref",
    "project_label",
]

#: What a resolved article is at the rack. The station classifies it from the
#: resolve payload's ``article.is_serialized`` -- the Maschinen tab lists the
#: serialized ones -- and hands the router this word, never the payload.
#: ``"machine"`` (a unit label, look-up only) stays as SMPL names it.
KIND_CONSUMABLE = "consumable"
KIND_TOOL = "tool"

PERSON_PREFIX = "SMPL-CMD-PERSON-"
PROJECT_PREFIX = "SMPL-CMD-PROJEKT-"
CMD_OHNE_PROJEKT = "SMPL-CMD-OHNE-PROJEKT"

#: The codes that carry a number. Published on ``/health`` next to the static
#: command list, never inside it: a prefix is not a code anybody can scan.
PARAMETRIC_PREFIXES: Tuple[str, ...] = (PERSON_PREFIX, PROJECT_PREFIX)

#: What an on-screen code may contain. ``A``-``X``: the scanner's German table
#: types every letter, but Y and Z are the two it may swap.
SCREEN_CODE_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWX-"
MAX_SCREEN_CODE_LEN = 26
#: Nine digits keeps the longest code (``SMPL-CMD-PROJEKT-`` + 9) at 26.
MAX_ID = 999_999_999
_MAX_ID_DIGITS = len(str(MAX_ID))

#: As many project tiles as one person gets; SMPL sends at most this many.
MAX_PROJECTS_PER_PERSON = 8
#: Why a project is on somebody's list: planned today, this week, or lately.
PROJECT_HINTS: Tuple[str, ...] = ("heute", "woche", "zuletzt")

SELECT_PERSON = "person"
SELECT_PROJECT = "project"
SELECT_NO_PROJECT = "no_project"

_MAX_TEXT = 120


def _positive_id(value: Any) -> Optional[int]:
    """A positive integer id that fits a code, or None. ``True`` is not 1."""
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value if 0 < value <= MAX_ID else None


def person_code(user_id: Any) -> str:
    """The code drawn next to a person's tile."""
    ident = _positive_id(user_id)
    if ident is None:
        raise ValueError("no person code for %r" % (user_id,))
    return PERSON_PREFIX + str(ident)


def project_code(project_id: Any) -> str:
    """The code drawn next to a project's tile."""
    ident = _positive_id(project_id)
    if ident is None:
        raise ValueError("no project code for %r" % (project_id,))
    return PROJECT_PREFIX + str(ident)


def _id_from(tail: str) -> Optional[int]:
    if not tail.isdigit() or len(tail) > _MAX_ID_DIGITS:
        return None
    return _positive_id(int(tail))


def selection_of(code: Any) -> Optional[Tuple[str, Optional[int]]]:
    """``("person", id)``, ``("project", id)``, ``("no_project", None)`` or None.

    Recognised by its prefix alone, so a garbled one (``SMPL-CMD-PERSON-X``)
    is still ours -- ``(kind, None)`` -- and is refused at the rack in German
    instead of being looked up as an article nobody stocks.
    """
    if not isinstance(code, str):
        return None
    upper = code.strip().upper()
    if upper == CMD_OHNE_PROJEKT:
        return SELECT_NO_PROJECT, None
    if upper.startswith(PERSON_PREFIX):
        return SELECT_PERSON, _id_from(upper[len(PERSON_PREFIX):])
    if upper.startswith(PROJECT_PREFIX):
        return SELECT_PROJECT, _id_from(upper[len(PROJECT_PREFIX):])
    return None


def is_selection_code(code: Any) -> bool:
    return selection_of(code) is not None


def fits_the_screen_alphabet(code: str) -> bool:
    """True when every character is one the scanner types without a doubt."""
    return bool(code) and all(char in SCREEN_CODE_ALPHABET for char in code)


def _text(value: Any) -> Optional[str]:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        value = str(value)
    if not isinstance(value, str):
        return None
    text = value.strip()[:_MAX_TEXT]
    return text or None


def clean_crew(people: Any) -> Tuple[Dict[str, Any], ...]:
    """``({"id", "name"}, ...)``: rows without a usable id or name are dropped."""
    rows: Tuple[Dict[str, Any], ...] = ()
    seen = set()
    for row in (people if isinstance(people, (list, tuple)) else ()):
        if not isinstance(row, dict):
            continue
        ident = _positive_id(row.get("id"))
        name = _text(row.get("name"))
        if ident is None or name is None or ident in seen:
            continue
        seen.add(ident)
        rows += ({"id": ident, "name": name},)
    return rows


def clean_projects(rows: Any) -> Tuple[Dict[str, Any], ...]:
    """At most eight ``{"id", "project_number", "name", "hint"}``, no duplicates.

    Exactly those four fields and no more: the wall is unauthenticated, so a
    customer or an address that SMPL might one day add to the row is dropped
    here rather than drawn.
    """
    cleaned: Tuple[Dict[str, Any], ...] = ()
    seen = set()
    for row in (rows if isinstance(rows, (list, tuple)) else ()):
        if len(cleaned) >= MAX_PROJECTS_PER_PERSON:
            break
        if not isinstance(row, dict):
            continue
        ident = _positive_id(row.get("id"))
        if ident is None or ident in seen:
            continue
        number = _text(row.get("project_number"))
        name = _text(row.get("name"))
        if number is None and name is None:
            continue
        hint = row.get("hint")
        seen.add(ident)
        cleaned += ({"id": ident, "project_number": number, "name": name,
                     "hint": hint if hint in PROJECT_HINTS else None},)
    return cleaned


def clean_crew_projects(payload: Any) -> Optional[Dict[int, Tuple[Dict[str, Any], ...]]]:
    """``{user_id: (project, ...)}`` out of ``GET /crew-projects``, or None.

    Accepts the contract's ``{"week_start", "people": [{"user_id",
    "projects"}]}`` or a bare list of people. None means "this is not a
    project list at all", which a caller keeps apart from "nobody has a
    project this week" (``{}``).
    """
    rows = payload.get("people") if isinstance(payload, dict) else payload
    if not isinstance(rows, (list, tuple)):
        return None
    people: Dict[int, Tuple[Dict[str, Any], ...]] = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        ident = _positive_id(row.get("user_id"))
        if ident is None or ident in people:
            continue
        projects = clean_projects(row.get("projects"))
        if projects:
            people[ident] = projects
    return people


def clean_project_mapping(mapping: Any) -> Dict[int, Tuple[Dict[str, Any], ...]]:
    """``{user_id: [projects]}`` -- what the router is handed -- cleaned the same way."""
    people: Dict[int, Tuple[Dict[str, Any], ...]] = {}
    if not isinstance(mapping, dict):
        return people
    for key, rows in mapping.items():
        ident = _positive_id(key)
        if ident is None:
            continue
        projects = clean_projects(rows)
        if projects:
            people[ident] = projects
    return people


def project_ref(project: Any) -> Optional[Dict[str, Any]]:
    """``{"id", "project_number", "name"}`` -- a project as a booking names it."""
    if not isinstance(project, dict):
        return None
    ident = _positive_id(project.get("id"))
    if ident is None:
        return None
    return {"id": ident, "project_number": _text(project.get("project_number")),
            "name": _text(project.get("name"))}


def project_label(project: Any) -> str:
    """``381 Neubau Schulze`` -- or ``ohne Projekt`` for none."""
    if not isinstance(project, dict):
        return "ohne Projekt"
    parts = [part for part in (_text(project.get("project_number")),
                               _text(project.get("name"))) if part]
    return " ".join(parts) if parts else "Projekt %s" % project.get("id")


def offered(projects: Iterable[Dict[str, Any]], project_id: Any) -> Optional[Dict[str, Any]]:
    """The offered project with this id, or None."""
    for project in projects:
        if project.get("id") == project_id:
            return project
    return None
