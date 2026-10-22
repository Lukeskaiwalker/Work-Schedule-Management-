"""The cabinet catalogue: Hager built-ins merged with the Werkstatt's entries.

docs/PANEL_ENCLOSURE.md §3.3–§3.5, §7. The built-ins are Python data
(``panel_enclosure_catalog_data.py``); a row of ``panel_catalog_entries`` is
either an entry an admin added (``source: "custom"``) or an override of a
built-in (a corrected spec, or only "archived").

Two promises shape everything here:

* **The read path never fails on a code.** A stored row whose spec no longer
  validates (a validator was tightened, a hand edit went wrong) is logged and
  treated as data, never raised: a built-in keeps its built-in spec, a custom
  code becomes an ``invalid`` entry that still counts as known. Boards that
  name it draw a placeholder and keep saving (D14).
* **Identity is frozen** (§3.5). Rail and fitting keys are append-only, and a
  code that any stored board uses keeps its size, family and meter places.
  Positions, labels and notes stay editable — they are corrections, and the
  geometry reads them live on purpose.

Writes commit here, then audit: ``log_admin_action`` commits on its own, so
it runs after the main commit, never inside it.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, replace
from datetime import datetime, timedelta
from functools import lru_cache
from types import MappingProxyType
from typing import Any, Iterable, Literal, Mapping

from fastapi import HTTPException, status
from pydantic import ValidationError
from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.deps import assert_project_access
from app.core.permissions import has_permission_for_user
from app.core.time import utcnow
from app.models.entities import PanelCatalogEntry, PanelPlan, User, WerkstattArticle, WerkstattArticleSupplier
from app.schemas.panel_enclosure import (
    SPEC_MODELS,
    CatalogEntryIn,
    CatalogEntryOut,
    EnclosureCatalogOut,
    UncataloguedArticleOut,
    normalize_code,
)
from app.services.audit import log_admin_action
from app.services.panel_enclosure_catalog_data import BUILTIN_ENCLOSURES, BUILTIN_MODULES

logger = logging.getLogger(__name__)

#: Custom codes, not overrides (§15). Rows are never deleted, so an archived
#: entry still counts.
MAX_CUSTOM_ENTRIES = 500
RECENT_DAYS = 365
RECENT_PLANS = 300
MAX_UNCATALOGUED = 20
#: The stock matcher's bounds (``match_articles_by_number``). The shortest
#: Hager number in use has four characters (T95L); the catalogue answer asks
#: for one number per entry, at most 500 custom plus the built-ins.
MIN_MATCH_LENGTH = 3
MAX_MATCH_NUMBERS = 1000
#: A name token shaped like a univers Z code: ZU37XS, ZK3EL22T, ZH53X9ST.
UNIVERS_Z_TOKEN = re.compile(r"^Z[A-Z]{1,2}\d[A-Z0-9]*$")

KEY_KEPT = "Schlüssel „{key}“ bleibt — ausmustern statt löschen oder umbenennen."
FROZEN_WHILE_USED = (
    "In {n} Verteilerplänen verwendet — Größe, Familie und Zählerplätze bleiben. Als neuen Eintrag anlegen."
)
NOT_FOUND = "Katalogeintrag nicht gefunden."

EntryType = Literal["enclosure", "module"]
Source = Literal["builtin", "custom", "override"]


class CatalogError(Exception):
    """A catalogue write refused, with its HTTP status and German sentence."""

    def __init__(self, status_code: int, message: str) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.message = message


@dataclass(frozen=True)
class CatalogEntry:
    code: str
    entry_type: EntryType
    # The validated spec, ``.model_dump()``ed; None ⇔ invalid. Read-only:
    # shared by every caller of the same catalogue.
    spec: dict[str, Any] | None
    source: Source
    archived: bool
    invalid: bool = False


@dataclass(frozen=True)
class EnclosureCatalog:
    """Every code a board may name: built-ins first, then custom entries in
    the order they were created. Archived and invalid entries included."""

    entries: Mapping[str, CatalogEntry]

    def entry(self, code: object) -> CatalogEntry | None:
        return self.entries.get(_code(code))

    def enclosure(self, code: object) -> dict[str, Any] | None:
        """The cabinet spec; None for an unknown or invalid code."""
        entry = self.entry(code)
        return entry.spec if entry is not None and entry.entry_type == "enclosure" else None

    def module(self, code: object) -> dict[str, Any] | None:
        entry = self.entry(code)
        return entry.spec if entry is not None and entry.entry_type == "module" else None

    def known(self, code: object) -> bool:
        """Archived and invalid count: the write check only refuses codes
        nobody ever catalogued (§2.2)."""
        return _code(code) in self.entries

    @classmethod
    def from_out(cls, payload: Mapping[str, Any]) -> EnclosureCatalog:
        """An ``EnclosureCatalogOut`` (or a fixture subset of it) → catalogue."""
        entries: dict[str, CatalogEntry] = {}
        for entry_type, items in (("enclosure", payload.get("enclosures")), ("module", payload.get("modules"))):
            for item in items or []:
                code = _code(item.get("code")) if isinstance(item, Mapping) else ""
                if not code:
                    continue
                spec = item.get("spec")
                entries[code] = CatalogEntry(
                    code=code,
                    entry_type=item.get("entry_type") or entry_type,
                    spec=dict(spec) if isinstance(spec, Mapping) else None,
                    source=item.get("source") or "builtin",
                    archived=bool(item.get("archived")),
                    invalid=bool(item.get("invalid")) or not isinstance(spec, Mapping),
                )
        return cls(MappingProxyType(entries))


def _code(value: object) -> str:
    normalized = normalize_code(value)
    return normalized if isinstance(normalized, str) else ""


# ── Loading and merging ──────────────────────────────────────────────────────


@lru_cache(maxsize=1)
def builtin_catalog() -> EnclosureCatalog:
    """The shipped catalogue, validated once per process. Pure, no DB."""
    entries: dict[str, CatalogEntry] = {}
    for entry_type, specs in (("enclosure", BUILTIN_ENCLOSURES), ("module", BUILTIN_MODULES)):
        for raw in specs:
            spec = SPEC_MODELS[entry_type].model_validate(raw).model_dump()
            entries[spec["code"]] = CatalogEntry(spec["code"], entry_type, spec, "builtin", False)  # type: ignore[arg-type]
    return EnclosureCatalog(MappingProxyType(entries))


def load_catalog(db: Session) -> EnclosureCatalog:
    builtins = builtin_catalog().entries
    entries = dict(builtins)
    for row in db.scalars(select(PanelCatalogEntry).order_by(PanelCatalogEntry.id.asc())).all():
        code = _code(row.code)
        if not code:
            continue
        builtin = builtins.get(code)
        entries[code] = _merge_override(builtin, row) if builtin is not None else _custom_entry(code, row)
    return EnclosureCatalog(MappingProxyType(entries))


def _merge_override(builtin: CatalogEntry, row: PanelCatalogEntry) -> CatalogEntry:
    archived = bool(row.is_archived)
    if row.spec is None:
        return replace(builtin, archived=archived)
    spec = _validated(builtin.code, builtin.entry_type, row.spec)
    if spec is None:
        # A broken override must not take a Hager cabinet away from every board.
        return replace(builtin, archived=archived)
    return CatalogEntry(builtin.code, builtin.entry_type, spec, "override", archived)


def _custom_entry(code: str, row: PanelCatalogEntry) -> CatalogEntry:
    entry_type: EntryType = "enclosure" if row.entry_type == "enclosure" else "module"
    spec = _validated(code, row.entry_type, row.spec) if row.spec is not None else None
    if spec is None and row.spec is None:
        _log_invalid(code, "custom entry without a spec")
    return CatalogEntry(code, entry_type, spec, "custom", bool(row.is_archived), invalid=spec is None)


_LOGGED_INVALID: set[tuple[str, str]] = set()


def _validated(code: str, entry_type: str, raw: Any) -> dict[str, Any] | None:
    model = SPEC_MODELS.get(entry_type)
    if model is None or not isinstance(raw, dict):
        _log_invalid(code, f"entry_type {entry_type!r} / spec of type {type(raw).__name__}")
        return None
    try:
        spec = model.model_validate(raw).model_dump()
    except ValidationError as exc:
        _log_invalid(code, str(exc.errors(include_url=False)[0]))
        return None
    if spec["code"] != code:
        _log_invalid(code, f"spec names {spec['code']}")
        return None
    return spec


def _log_invalid(code: str, reason: str) -> None:
    # Once per process and reason: the catalogue is loaded on every board read.
    key = (code, reason)
    if key not in _LOGGED_INVALID:
        _LOGGED_INVALID.add(key)
        logger.warning("panel catalogue entry %s is invalid and shown as a placeholder: %s", code, reason)


# ── Codes in documents ───────────────────────────────────────────────────────


def document_codes(document: Any) -> set[str]:
    """The cabinet code and every module code of a stored or posted board.

    Tolerant: documents come from tablets several versions behind and from
    hand edits, so anything that is not where it should be is skipped.
    """
    enclosure = document.get("enclosure") if isinstance(document, Mapping) else None
    if not isinstance(enclosure, Mapping):
        return set()
    codes = {_code(enclosure.get("code"))}
    modules = enclosure.get("modules")
    for module in modules if isinstance(modules, list) else []:
        if isinstance(module, Mapping):
            codes.add(_code(module.get("code")))
    codes.discard("")
    return codes


def unknown_codes(document: Any, catalog: EnclosureCatalog, *, stored: Any | None) -> list[str]:
    """Codes this write introduces that the catalogue never knew (§2.2).

    A code the stored board already carries never counts: a catalogue change
    or a downgrade must not make a board unsaveable (D14).
    """
    codes = document_codes(document)
    if stored is not None:
        codes -= document_codes(stored)
    return sorted(code for code in codes if not catalog.known(code))


def assert_known_codes(db: Session, document: Any, *, stored: Any | None) -> None:
    """400 for a newly introduced unknown code; loads the catalogue only when needed."""
    fresh = document_codes(document) - (document_codes(stored) if stored is not None else set())
    if not fresh:
        return
    unknown = unknown_codes(document, load_catalog(db), stored=stored)
    if unknown:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unbekannter Schrank- oder Modulcode: {', '.join(unknown)}.",
        )


def codes_in_use(db: Session) -> dict[str, int]:
    """code → number of boards whose document names it, over ALL boards:
    what freezes a code's size is any board, not the ones the caller sees."""
    counts: dict[str, int] = {}
    for document in db.scalars(select(PanelPlan.document).execution_options(yield_per=200)):
        for code in document_codes(document):
            counts[code] = counts.get(code, 0) + 1
    return counts


# ── Change rules (§3.5) ──────────────────────────────────────────────────────


def rail_keys(spec: Mapping[str, Any]) -> list[str]:
    """Every rail key of a module spec, retired ones included, in spec order."""
    keys: list[str] = []
    for zone in _dicts(spec.get("zones")):
        keys.extend(str(rail.get("key")) for rail in _dicts(zone.get("rails")))
    return keys


def fitting_kinds(spec: Mapping[str, Any]) -> dict[str, str | None]:
    """fitting key → the kind of its device (None for a fitting without one)."""
    kinds: dict[str, str | None] = {}
    for fitting in _dicts(spec.get("fittings")):
        device = fitting.get("device")
        kinds[str(fitting.get("key"))] = str(device.get("kind")) if isinstance(device, Mapping) else None
    return kinds


def frozen_fields(entry_type: str, spec: Mapping[str, Any]) -> dict[str, Any]:
    """What stored boards were laid out with, and so may not change while used.

    For a cabinet that is its grid; for a module its size, family and the
    type and meter places of each zone (zone keys and positions may move).
    """
    if entry_type == "enclosure":
        return {"fields": spec.get("fields"), "units_per_field": spec.get("units_per_field")}
    return {
        "family": spec.get("family"),
        "width_fields": spec.get("width_fields"),
        "height_units": spec.get("height_units"),
        "field_height_mm": spec.get("field_height_mm"),
        "zones": sorted([str(zone.get("type")), _int(zone.get("meter_places"))] for zone in _dicts(spec.get("zones"))),
    }


def check_change(old: Mapping[str, Any] | None, new: Mapping[str, Any], *, used_by: int) -> None:
    """Refuse a new spec for an existing code that would orphan stored boards (409)."""
    if old is None:
        return
    kept_rails = set(rail_keys(new))
    for key in rail_keys(old):
        if key not in kept_rails:
            raise CatalogError(status.HTTP_409_CONFLICT, KEY_KEPT.format(key=key))
    new_fittings = fitting_kinds(new)
    for key, kind in fitting_kinds(old).items():
        if key not in new_fittings or new_fittings[key] != kind:
            raise CatalogError(status.HTTP_409_CONFLICT, KEY_KEPT.format(key=key))
    if used_by > 0 and frozen_fields(_entry_type_of(old), old) != frozen_fields(_entry_type_of(new), new):
        raise CatalogError(status.HTTP_409_CONFLICT, FROZEN_WHILE_USED.format(n=used_by))


def _entry_type_of(spec: Mapping[str, Any]) -> str:
    return "module" if "zones" in spec or "family" in spec else "enclosure"


def _dicts(value: Any) -> list[Mapping[str, Any]]:
    return [item for item in value if isinstance(item, Mapping)] if isinstance(value, list) else []


def _int(value: Any) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


# ── Writes ───────────────────────────────────────────────────────────────────


def create_entry(db: Session, *, payload: CatalogEntryIn, user: User) -> CatalogEntry:
    spec = payload.spec.model_dump()
    code = spec["code"]
    duplicate = CatalogError(status.HTTP_409_CONFLICT, f"Den Code {code} gibt es schon.")
    if load_catalog(db).known(code):
        raise duplicate
    builtin_codes = list(builtin_catalog().entries)
    custom = db.scalar(select(func.count(PanelCatalogEntry.id)).where(PanelCatalogEntry.code.not_in(builtin_codes)))
    if int(custom or 0) >= MAX_CUSTOM_ENTRIES:
        raise CatalogError(status.HTTP_409_CONFLICT, f"Höchstens {MAX_CUSTOM_ENTRIES} eigene Einträge im Schrankkatalog.")
    db.add(PanelCatalogEntry(code=code, entry_type=payload.entry_type, spec=spec, created_by=user.id, updated_by=user.id))
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise duplicate from None
    log_admin_action(db, user, "schaltplan.catalog.create", "panel_catalog_entry", code, {"entry_type": payload.entry_type})
    return _reloaded(db, code)


def update_entry(db: Session, *, code: str, payload: CatalogEntryIn, user: User) -> CatalogEntry:
    code = _code(code)
    current = load_catalog(db).entry(code)
    if current is None:
        raise CatalogError(status.HTTP_404_NOT_FOUND, NOT_FOUND)
    spec = payload.spec.model_dump()
    if spec["code"] != code:
        raise CatalogError(status.HTTP_400_BAD_REQUEST, f"Der Code im Aufbau ({spec['code']}) passt nicht zu {code}.")
    if payload.entry_type != current.entry_type:
        raise CatalogError(status.HTTP_400_BAD_REQUEST, "Der Typ eines Eintrags lässt sich nicht ändern.")
    row = _row(db, code)
    # An invalid entry's keys still bind: compare against what is stored.
    old = current.spec if current.spec is not None else (row.spec if row is not None else None)
    check_change(old if isinstance(old, Mapping) else None, spec, used_by=codes_in_use(db).get(code, 0))
    if row is None:
        db.add(PanelCatalogEntry(code=code, entry_type=current.entry_type, spec=spec, created_by=user.id, updated_by=user.id))
    else:
        row.spec = spec
        row.updated_by = user.id
    db.commit()
    log_admin_action(db, user, "schaltplan.catalog.update", "panel_catalog_entry", code, {"source": current.source})
    return _reloaded(db, code)


def set_archived(db: Session, *, code: str, archived: bool, user: User) -> CatalogEntry:
    """Archive or restore: hidden from the pickers, still resolving for boards."""
    code = _code(code)
    current = load_catalog(db).entry(code)
    if current is None:
        raise CatalogError(status.HTTP_404_NOT_FOUND, NOT_FOUND)
    row = _row(db, code)
    if row is None and not archived:
        return current  # a built-in nobody archived: nothing to restore
    if row is None:
        db.add(PanelCatalogEntry(code=code, entry_type=current.entry_type, spec=None, is_archived=True,
                                 created_by=user.id, updated_by=user.id))
    else:
        row.is_archived = archived
        row.updated_by = user.id
    db.commit()
    action = "archive" if archived else "unarchive"
    log_admin_action(db, user, f"schaltplan.catalog.{action}", "panel_catalog_entry", code, {})
    return _reloaded(db, code)


def reset_override(db: Session, *, code: str, user: User) -> CatalogEntry:
    """Back to the Hager standard — only for built-ins, and only within §3.5."""
    code = _code(code)
    builtin = builtin_catalog().entry(code)
    if builtin is None:
        if load_catalog(db).known(code):
            raise CatalogError(
                status.HTTP_409_CONFLICT,
                "Eigene Einträge werden archiviert, nicht gelöscht — Verteilerpläne verweisen darauf.",
            )
        raise CatalogError(status.HTTP_404_NOT_FOUND, NOT_FOUND)
    row = _row(db, code)
    if row is None:
        raise CatalogError(status.HTTP_404_NOT_FOUND, NOT_FOUND)
    current = load_catalog(db).entry(code)
    if current is not None and current.spec is not None and builtin.spec is not None:
        check_change(current.spec, builtin.spec, used_by=codes_in_use(db).get(code, 0))
    db.delete(row)
    db.commit()
    log_admin_action(db, user, "schaltplan.catalog.reset", "panel_catalog_entry", code, {})
    return _reloaded(db, code)


def _row(db: Session, code: str) -> PanelCatalogEntry | None:
    return db.scalars(select(PanelCatalogEntry).where(PanelCatalogEntry.code == code)).first()


def _reloaded(db: Session, code: str) -> CatalogEntry:
    entry = load_catalog(db).entry(code)
    assert entry is not None  # just written
    return entry


# ── The catalogue answer (§3.4) ──────────────────────────────────────────────


def catalog_out(db: Session, user: User, catalog: EnclosureCatalog) -> EnclosureCatalogOut:
    """Every entry with stock and recent use, the ones in stock first."""
    can_manage = has_permission_for_user(user.id, user.role, "werkstatt:manage")
    outs = annotate_entries(db, user, list(catalog.entries.values()))
    ordered = sorted(enumerate(outs), key=lambda pair: _order_key(pair[0], pair[1]))
    return EnclosureCatalogOut(
        enclosures=[out for _, out in ordered if out.entry_type == "enclosure"],
        modules=[out for _, out in ordered if out.entry_type == "module"],
        can_manage=can_manage,
        uncatalogued=uncatalogued_articles(db, catalog) if can_manage else [],
    )


def entry_out(db: Session, user: User, entry: CatalogEntry) -> CatalogEntryOut:
    return annotate_entries(db, user, [entry])[0]


def _order_key(index: int, out: CatalogEntryOut) -> tuple[int, float, int]:
    # Stock first (catalogue order within), then recent use, newest first,
    # then the catalogue order itself.
    if out.stock_available > 0:
        return (0, 0.0, index)
    if out.recent_count > 0 and out.last_used_at is not None:
        return (1, -out.last_used_at.timestamp(), index)
    return (2, 0.0, index)


def annotate_entries(db: Session, user: User, entries: list[CatalogEntry]) -> list[CatalogEntryOut]:
    # Imported here: the material service will import this module for the
    # catalogue (docs/PANEL_ENCLOSURE.md §6), and both sides are services.
    from app.services.schaltplan_material import article_out, explicit_mappings

    mapped = explicit_mappings(db, [f"{entry.entry_type}:{entry.code}" for entry in entries])
    numbers = {
        str(entry.spec["article_no"])
        for entry in entries
        if entry.spec is not None and f"{entry.entry_type}:{entry.code}" not in mapped
    }
    matched = match_articles_by_number(db, sorted(numbers))
    recent = _recent_use(db, user)
    used = codes_in_use(db)
    outs: list[CatalogEntryOut] = []
    for entry in entries:
        article = mapped.get(f"{entry.entry_type}:{entry.code}")
        source = "mapping" if article is not None else None
        if article is None and entry.spec is not None:
            article = matched.get(str(entry.spec["article_no"]))
            source = "auto" if article is not None else None
        count, last_used = recent.get(entry.code, (0, None))
        outs.append(
            CatalogEntryOut(
                code=entry.code, entry_type=entry.entry_type, source=entry.source,
                archived=entry.archived, invalid=entry.invalid, spec=entry.spec,
                article=article_out(article) if article is not None else None,
                article_source=source,  # type: ignore[arg-type]
                stock_available=int(article.stock_available or 0) if article is not None else 0,
                recent_count=count, last_used_at=last_used, used_by_plans=used.get(entry.code, 0),
            )
        )
    return outs


def _recent_use(db: Session, user: User) -> dict[str, tuple[int, datetime | None]]:
    """code → (boards, last edit) over the caller's boards of the last year."""
    since = utcnow() - timedelta(days=RECENT_DAYS)
    plans = db.scalars(
        select(PanelPlan).where(PanelPlan.updated_at >= since).order_by(PanelPlan.updated_at.desc(), PanelPlan.id.desc())
    )
    out: dict[str, tuple[int, datetime | None]] = {}
    for plan in _visible(db, user, plans, limit=RECENT_PLANS):
        for code in document_codes(plan.document):
            count, last = out.get(code, (0, None))
            out[code] = (count + 1, plan.updated_at if last is None or plan.updated_at > last else last)
    return out


def _visible(db: Session, user: User, plans: Iterable[PanelPlan], *, limit: int) -> list[PanelPlan]:
    """The plan list's rule (a project board is as visible as its project),
    asked once per project rather than once per board."""
    allowed: dict[int, bool] = {}
    visible: list[PanelPlan] = []
    for plan in plans:
        if plan.project_id is not None:
            if plan.project_id not in allowed:
                try:
                    assert_project_access(db, user, plan.project_id)
                    allowed[plan.project_id] = True
                except HTTPException:
                    allowed[plan.project_id] = False
            if not allowed[plan.project_id]:
                continue
        visible.append(plan)
        if len(visible) >= limit:
            break
    return visible


def match_articles_by_number(db: Session, numbers: list[str]) -> dict[str, WerkstattArticle]:
    """number → the stock article it names (§3.4), batched in two queries.

    A supplier article number equal to it wins; otherwise an article whose
    name holds it as a whole token, so ZH3EH16 never matches "Hager ZH3EH16N
    Komplettfeld". Archived and merged-away articles never match; among
    several, the oldest article does.

    Bounded whoever calls it: a number shorter than ``MIN_MATCH_LENGTH``
    names no article but turns into a LIKE that matches nearly every name
    (and then a regex over each hit), and at most ``MAX_MATCH_NUMBERS``
    numbers are looked up — the first ones in sorted order, so the answer is
    the same on every read. Every list and the catalogue run this per request.
    """
    stripped = {number.strip() for number in numbers if isinstance(number, str)}
    wanted = sorted(number for number in stripped if len(number) >= MIN_MATCH_LENGTH)[:MAX_MATCH_NUMBERS]
    if not wanted:
        return {}
    live = (WerkstattArticle.is_archived.is_(False), WerkstattArticle.merged_into_id.is_(None))
    out: dict[str, WerkstattArticle] = {}
    for number, article in db.execute(
        select(WerkstattArticleSupplier.supplier_article_no, WerkstattArticle)
        .join(WerkstattArticle, WerkstattArticle.id == WerkstattArticleSupplier.article_id)
        .where(WerkstattArticleSupplier.supplier_article_no.in_(wanted), *live)
        .order_by(WerkstattArticle.id.asc())
    ).all():
        out.setdefault(str(number), article)
    remaining = [number for number in wanted if number not in out]
    if not remaining:
        return out
    candidates = db.scalars(
        select(WerkstattArticle)
        .where(or_(*(func.lower(WerkstattArticle.item_name).like(_contains(n), escape="\\") for n in remaining)), *live)
        .order_by(WerkstattArticle.id.asc())
    ).all()
    names = [(article, (article.item_name or "").lower()) for article in candidates]
    for number in remaining:
        needle = number.lower()
        token = re.compile(rf"(?<![A-Za-z0-9]){re.escape(number)}(?![A-Za-z0-9])", re.IGNORECASE)
        # The substring test first: cheap, and it skips the regex for every
        # candidate that only another number brought in.
        hit = next((article for article, name in names if needle in name and token.search(article.item_name or "")), None)
        if hit is not None:
            out[number] = hit
    return out


def _contains(number: str) -> str:
    escaped = number.lower().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


def uncatalogued_articles(db: Session, catalog: EnclosureCatalog) -> list[UncataloguedArticleOut]:
    """Hager field kits on the shelf that the catalogue does not know yet —
    the module picker offers them to a manager as "Eintrag anlegen"."""
    from app.services.schaltplan_material import article_out

    rows = db.scalars(
        select(WerkstattArticle)
        .where(
            WerkstattArticle.is_archived.is_(False),
            WerkstattArticle.merged_into_id.is_(None),
            WerkstattArticle.stock_available > 0,
            or_(
                func.lower(func.coalesce(WerkstattArticle.manufacturer, "")).like("%hager%"),
                func.lower(WerkstattArticle.item_name).like("%hager%"),
            ),
        )
        .order_by(WerkstattArticle.item_name.asc(), WerkstattArticle.id.asc())
        .limit(500)
    ).all()
    out: list[UncataloguedArticleOut] = []
    for article in rows:
        tokens = (token.upper() for token in re.split(r"[^A-Za-z0-9]+", article.item_name or ""))
        guess = next((t for t in tokens if UNIVERS_Z_TOKEN.fullmatch(t) and not catalog.known(t)), None)
        if guess is not None:
            out.append(UncataloguedArticleOut(article=article_out(article), code_guess=guess))
            if len(out) >= MAX_UNCATALOGUED:
                break
    return out
