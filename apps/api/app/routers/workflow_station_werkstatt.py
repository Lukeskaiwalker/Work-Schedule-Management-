"""The Werkstatt API a paired scan station may reach.

Two screens are going on the workshop wall, both driven by the Raspberry Pi
that is already paired with SMPL (see ``workflow_station_pairing.py`` for the RFC 8628
device grant that put a token on it):

  * the **box screen** lists the Baustellenkisten with their contents and who
    they belong to, lets somebody scan a crate and then scan articles into it,
    and books the handover of a crate that is packed and waiting — the person
    carrying it out is standing at this screen, not at a desk;
  * the **rack screen** books stock in three directions — Ausgabe (checkout),
    Rückgabe (return) and Wareneingang (intake) — and hands a tool to the
    person whose name the worker tapped, from the crew list this router also
    serves. A Wareneingang may also meet a product the workshop has never
    stocked, which is the eighth endpoint: the wholesaler's catalogue already
    describes it, so the article is built from that row rather than left as a
    dead end in front of somebody holding the delivery.

The obvious way to build that would be a user PAT in the Pi's config file. We
are not doing that: a wall-mounted box in an unlocked workshop would then hold
a credential that opens the whole API — projects, customers, files, everything
that user can see — and revoking it means editing a file on the Pi. The
station token it already has is the opposite of that: minted by an
administrator, revocable centrally with one click, and — because of this
router — able to do exactly eight things.

So this router is deliberately thin. It owns no rules of its own; every
endpoint delegates to the same function the user-facing endpoint calls, so
"a handed-over box is frozen", "a repeat scan tops up the line" and the
ledger's stock arithmetic cannot hold on the phone and quietly not hold on the
wall. What it *does* own is the boundary: who may call (a station, never a
user), what a station may write (three movement types, not all eight), and
whose name goes on what it writes.

That last one is the interesting problem. ``werkstatt_movements.user_id`` is
NOT NULL, and a device is not a person — see ``resolve_station_user_id``. The
borrowed name is not the whole answer either: a row booked at the wall must
stay tellable from a row that administrator booked themselves, so every
station booking also carries ``station_id`` and a note prefix the caller cannot
remove.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import case, func, select
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.permissions import ROLE_ADMIN
from app.models.entities import (
    MaterialCatalogItem,
    Station,
    User,
    WerkstattArticle,
    WerkstattConstructionBox,
    WerkstattMovement,
)
from app.routers.workflow_helpers import _list_active_assignable_users
from app.routers.workflow_station import get_current_station
from app.routers.workflow_werkstatt_articles import build_article_from_catalog_item
from app.routers.workflow_werkstatt_boxes import (
    box_code,
    box_out,
    get_box_or_404,
    item_out,
)
from app.services.werkstatt_box_items import (
    add_item_to_box,
    ensure_box_unlocked,
    remove_item_from_box,
)
from app.schemas.station import (
    STATION_MOVEMENT_TYPES,
    StationArticleFromCatalogOut,
    StationArticleFromCatalogRequest,
    StationArticleFromLookupOut,
    StationArticleFromLookupRequest,
    StationBoxHandoverRequest,
    StationCrewMemberOut,
    StationMovementOut,
    StationMovementRequest,
)
from app.schemas.werkstatt import ScanResolveResult, WerkstattArticleLookupOut
from app.schemas.werkstatt_boxes import (
    WerkstattBoxItemCreate,
    WerkstattBoxItemOut,
    WerkstattStationBoxItemCreate,
    WerkstattStationBoxItemRemove,
    WerkstattStationBoxItemRemoveOut,
    WerkstattStationBoxOut,
)
from app.services.werkstatt_boxes import (
    NOT_PACKED_DETAIL,
    ensure_standard_boxes,
    transition_box,
)
from app.services.werkstatt_movements import (
    MovementError,
    apply_movement,
    book_opening_stock,
)
from app.services import gtin
from app.services.werkstatt_article_lookup import (
    build_article_from_external_hit,
    lookup_code,
)
from app.services.werkstatt_article_numbers import next_article_number
from app.services.werkstatt_scan import _article_out, resolve_scan

router = APIRouter(prefix="/station/werkstatt", tags=["station-werkstatt"])


# ---------------------------------------------------------------------------
# Attribution — whose name goes on what a device books
# ---------------------------------------------------------------------------


def _station_actor(db: Session, station: Station) -> User | None:
    """The user a station's writes are attributed to, or ``None``.

    ``werkstatt_movements.user_id`` is NOT NULL, and rightly so: the ledger's
    whole worth is that every row names somebody who can be asked "why is this
    drill checked out?". A station is a device, so it has to borrow a person:

      1. ``station.created_by`` — the administrator who approved the pairing.
         Approving is the act of putting this device in the workshop, so they
         own what it books. It is also the only person the system can honestly
         name: nobody logs in at a wall screen.
      2. Failing that (the account was deleted — the column is ON DELETE SET
         NULL — or points at a row that is gone), the lowest-id active admin.
         Lowest id because it is *stable*: a rule like "the most recent admin"
         would silently move the authorship of the ledger between two deploys.
      3. Failing that, ``None``. The caller decides what to do about it;
         ``resolve_station_user_id`` refuses the write, because a ledger row
         with a wrong name is worse than a booking that did not happen — the
         first is a lie somebody acts on, the second is an error somebody fixes.
    """
    if station.created_by is not None:
        owner = db.get(User, station.created_by)
        if owner is not None:
            return owner
    return db.scalars(
        select(User)
        .where(User.role == ROLE_ADMIN, User.is_active.is_(True))
        .order_by(User.id.asc())
    ).first()


def _station_marker(station: Station) -> str:
    """The one string that says "a machine wrote this row", in one place."""
    return f"Regal-Station {station.name}"


def _station_notes(station: Station, caller_note: str | None) -> str:
    """The ledger note for a station booking: marker first, caller's text after.

    A PREFIX, not a default. The note used to be ``caller_note or marker``, so
    any device that sent a note replaced the only human-readable sign that a
    machine wrote the row — and the caller is an unattended screen on a wall,
    which makes "it would not do that" the wrong kind of assurance. Now the
    marker is always the first thing in the field and the caller's own text, if
    any, follows it.
    """
    marker = _station_marker(station)
    note = (caller_note or "").strip()
    return f"{marker} — {note}" if note else marker


def resolve_station_user_id(db: Session, station: Station) -> int:
    """``_station_actor`` where a user is mandatory. 409 when there is none."""
    actor = _station_actor(db, station)
    if actor is None:
        raise HTTPException(
            status_code=409,
            detail=(
                f"Die Station „{station.name}“ hat keinen Besitzer, auf den gebucht werden "
                "kann. Bitte die Station erneut koppeln oder einen Administrator anlegen."
            ),
        )
    return actor.id


# ---------------------------------------------------------------------------
# The box screen
# ---------------------------------------------------------------------------


def _box_listing_statement():
    """The rack's own order: permanent boxes first by slot, ad-hoc after.

    Spelled out here rather than borrowed from the user-facing list, which
    composes the same order inline with filters this screen has no use for.
    """
    return select(WerkstattConstructionBox).order_by(
        WerkstattConstructionBox.slot.is_(None),
        WerkstattConstructionBox.slot.asc(),
        WerkstattConstructionBox.created_at.desc(),
    )


@router.get("/boxes", response_model=list[WerkstattStationBoxOut])
def station_list_boxes(
    station: Station = Depends(get_current_station),
    db: Session = Depends(get_db),
) -> list[WerkstattStationBoxOut]:
    """Every box, with its contents, its customer and its scannable code.

    Always the whole list with items: the screen is a wall display that
    re-renders a full snapshot rather than accumulating changes, so there is
    nothing for a filter or a page size to save it.

    ``ensure_standard_boxes`` runs here for the same reason it runs on the
    user-facing list — the eight permanent rack boxes are seeded on first read,
    and the wall screen is quite likely to be the first reader after a reset.
    """
    _ = station  # auth enforcement only — a station sees every box
    ensure_standard_boxes(db)
    rows = db.scalars(_box_listing_statement()).all()
    listing: list[WerkstattStationBoxOut] = []
    for row in rows:
        base = box_out(db, row, with_items=True)
        listing.append(
            WerkstattStationBoxOut(
                **base.model_dump(),
                code=box_code(row),
                customer=base.customer_name,
                project=base.project_name,
            )
        )
    return listing


@router.get("/resolve", response_model=ScanResolveResult)
def station_resolve(
    code: str = Query(..., description="Raw scanned code (EAN, SP-Nr, supplier article no, …)"),
    station: Station = Depends(get_current_station),
    db: Session = Depends(get_db),
) -> ScanResolveResult:
    """The same scan cascade the phone runs, with the same answers.

    Delegated rather than reimplemented so a barcode can never mean one thing
    at the wall and another in somebody's hand. A crate's own ``KISTE-…`` code
    is not part of this cascade and resolves to ``not_found``: the station
    matches those against the box list it already holds, which is what lets it
    open a crate with no round trip.
    """
    _ = station  # auth enforcement only — no per-station filtering
    return resolve_scan(db, code)


def _scanned_article_id(db: Session, code: str) -> int:
    """Turn a scanned code into a stocked article id, or refuse.

    A wall screen has nobody to type a name, so an unresolvable scan could only
    become a line called "4006381333931" — a row that looks like data and is
    not. Refusing is the kinder failure: the screen says so, and somebody adds
    the article properly. Catalog-only hits are refused for the same reason:
    they are orderable, not packable.
    """
    resolved = resolve_scan(db, code)
    if resolved.kind == "werkstatt_article":
        return resolved.article.id
    raise HTTPException(
        status_code=400,
        detail=f"Kein Lagerartikel zum Code „{code}“ gefunden.",
    )


@router.post("/boxes/{box_id}/items", response_model=WerkstattBoxItemOut)
def station_add_box_item(
    box_id: int,
    payload: WerkstattStationBoxItemCreate,
    station: Station = Depends(get_current_station),
    db: Session = Depends(get_db),
) -> WerkstattBoxItemOut:
    """Scan an article into a box.

    Runs ``add_item_to_box`` — the user endpoint's own body — so the lock on a
    handed-over box and the top-up-on-repeat-scan rule are literally the same
    code, not a second implementation that agrees today.

    ``added_by`` is the station's owner where there is one, and NULL where
    there is not: unlike a ledger row, a packed line does not depend on knowing
    who put it there, so a station without an owner may still pack.
    """
    box = get_box_or_404(db, box_id)
    # Checked before the code is resolved so a scan into a frozen crate fails
    # with the reason that matters, not with "unknown article".
    ensure_box_unlocked(box)

    article_id = payload.article_id
    if article_id is None:
        code = (payload.code or "").strip()
        if not code:
            raise HTTPException(
                status_code=400, detail="Entweder „code“ oder „article_id“ ist erforderlich."
            )
        article_id = _scanned_article_id(db, code)

    actor = _station_actor(db, station)
    row = add_item_to_box(
        db,
        box,
        WerkstattBoxItemCreate(article_id=article_id, quantity=payload.quantity),
        added_by=actor.id if actor is not None else None,
    )
    return item_out(row)


@router.post("/boxes/{box_id}/items/remove", response_model=WerkstattStationBoxItemRemoveOut)
def station_remove_box_item(
    box_id: int,
    payload: WerkstattStationBoxItemRemove,
    station: Station = Depends(get_current_station),
    db: Session = Depends(get_db),
) -> WerkstattStationBoxItemRemoveOut:
    """Take a counted amount back out of a box.

    A count rather than a line id alone: at the crate things come out one or
    two at a time, and the user-facing DELETE (which removes the whole line) is
    the ``quantity=None`` case of the same shared function.
    """
    _ = station  # auth enforcement only
    box = get_box_or_404(db, box_id)
    removed = remove_item_from_box(db, box, payload.item_id, quantity=payload.quantity)
    return WerkstattStationBoxItemRemoveOut(removed=removed)


@router.post("/boxes/{box_id}/handover", response_model=WerkstattStationBoxOut)
def station_handover_box(
    box_id: int,
    payload: StationBoxHandoverRequest,
    station: Station = Depends(get_current_station),
    db: Session = Depends(get_db),
) -> WerkstattStationBoxOut:
    """"Mitnehmen": the crate leaves the workshop, its contents leave the shelf.

    A packed crate standing on the rack is taken by whoever is walking past it,
    and that person is standing in front of this screen — not at a desk. So the
    wall may book the handover, for the same reason it may already book a
    checkout: it writes the same ``checkout`` movements the web path writes,
    under the same borrowed name, and marks them as a station's rows so the two
    stay tellable apart.

    Nothing else about the crate is decided here. The customer and the project
    were chosen when it was packed; this only says that it has gone.
    """
    box = get_box_or_404(db, box_id)
    if (box.status or "offen") != "gepackt":
        raise HTTPException(status_code=400, detail=NOT_PACKED_DETAIL)

    user_id = resolve_station_user_id(db, station)
    transition_box(
        db,
        box,
        target_status="zugewiesen",
        user_id=user_id,
        station_id=station.id,
        note_prefix=_station_notes(station, payload.notes),
    )
    db.commit()
    db.refresh(box)
    base = box_out(db, box, with_items=True)
    return WerkstattStationBoxOut(
        **base.model_dump(),
        code=box_code(box),
        customer=base.customer_name,
        project=base.project_name,
    )


# ---------------------------------------------------------------------------
# The rack screen
# ---------------------------------------------------------------------------


@router.get("/crew", response_model=list[StationCrewMemberOut])
def station_crew(
    station: Station = Depends(get_current_station),
    db: Session = Depends(get_db),
) -> list[StationCrewMemberOut]:
    """The names a tool can be handed to, for the rack screen's name grid.

    A worker taps their name before taking something out, so that "who has the
    drill" has an answer that is not "the administrator whose account the wall
    screen books under". This is the one thing the rack screen cannot derive
    from a barcode, so it is the one list it has to be given.

    The selection is ``_list_active_assignable_users`` — literally the function
    behind ``GET /api/users/assignable``, which is what the task form and the
    chat participant picker already offer. Not copied: a second query would
    drift, and the failure would be silent and one-sided (the wall offers
    somebody the app does not, or hides somebody it does). Only the projection
    is narrower: a wall grid renders a button per person, so it takes the id
    and the display name and has no use for roles, avatars or hour quotas.
    """
    _ = station  # auth enforcement only — every station sees the same crew
    return [
        StationCrewMemberOut(id=row.id, name=row.display_name)
        for row in _list_active_assignable_users(db)
    ]


# Movement types that give something back, i.e. that reduce what a borrower is
# still holding. Spelled exactly as ``services.werkstatt_movements
# .list_my_checkouts`` spells them, because the two have to agree on what
# "open" means or this router closes a loan that list still shows.
_LOAN_CLOSING_TYPES: tuple[str, ...] = ("return", "repair_out", "correction")


def _open_loan_for_article(db: Session, article_id: int) -> tuple[int, int | None] | None:
    """Who is still holding this article, and on which project — or ``None``.

    Returns the ``(assignee_user_id, project_id)`` of the most recent checkout
    that nothing has balanced yet, using the *same* definition of "open" as
    ``list_my_checkouts``: a row belongs to whoever it names, or — when it
    names nobody — to whoever booked it (hence the ``coalesce``); a checkout
    adds to that borrower's balance and a return / repair_out / correction
    subtracts from it; and the balance is kept per ``(borrower, project)``
    because that is the tuple the "My checkouts" list groups by. A borrower
    whose balance is still positive is still holding something.

    **Why this lives in the station router and not in the shared service.**
    ``apply_movement`` is the one write path the phone, the tablet's delivery
    flow and the box handover all go through, and every one of those callers
    has a logged-in person in the request: a missing assignee there means "the
    caller means themselves", and guessing a different borrower would silently
    rewrite bookings somebody made deliberately. A station is the one caller
    that structurally cannot name anybody — a wall screen has no session, so
    its ``user_id`` is the *borrowed* name of the administrator who approved
    the pairing, and a missing assignee means "nobody tapped a name", not "the
    admin took it". Only here are those two facts both true, so only here is
    the guess sound. Reading the ledger is also the only fix available: a
    Rückgabe at the rack is a bare button press, so without it the borrower's
    loan has no later event that would ever clear it.
    """
    # Whoever the row is charged to — the tapped name, else the booker.
    borrower = func.coalesce(
        WerkstattMovement.assignee_user_id, WerkstattMovement.user_id
    )
    signed_qty = case(
        (WerkstattMovement.movement_type == "checkout", WerkstattMovement.quantity),
        (WerkstattMovement.movement_type.in_(_LOAN_CLOSING_TYPES), -WerkstattMovement.quantity),
        else_=0,
    )
    # Ordering is by the group's newest checkout — "the loan that was opened
    # last" is the best available answer to "which of these did this crate
    # just come back from", and the ledger does not link a return to a
    # checkout. The row id breaks a tie so two checkouts in the same clock
    # tick still resolve the same way on every run.
    last_checkout_at = func.max(
        case(
            (WerkstattMovement.movement_type == "checkout", WerkstattMovement.created_at),
            else_=None,
        )
    )
    last_checkout_id = func.max(
        case(
            (WerkstattMovement.movement_type == "checkout", WerkstattMovement.id),
            else_=None,
        )
    )

    row = db.execute(
        select(borrower.label("borrower_id"), WerkstattMovement.project_id.label("project_id"))
        .where(WerkstattMovement.article_id == article_id)
        .group_by(borrower, WerkstattMovement.project_id)
        .having(func.coalesce(func.sum(signed_qty), 0) > 0)
        .order_by(last_checkout_at.desc(), last_checkout_id.desc())
        .limit(1)
    ).first()
    if row is None or row.borrower_id is None:
        return None
    # The name has to still exist to go on a row: ``assignee_user_id`` is a FK.
    if db.get(User, int(row.borrower_id)) is None:
        return None
    return int(row.borrower_id), (int(row.project_id) if row.project_id is not None else None)


@router.post("/movements", response_model=StationMovementOut)
def station_movement(
    payload: StationMovementRequest,
    station: Station = Depends(get_current_station),
    db: Session = Depends(get_db),
) -> StationMovementOut:
    """Book stock out or in from the rack screen.

    Four gates, in the order that gives the most useful error *and* leaks the
    least: the movement type must be one a wall screen is allowed to write, the
    article must exist and not be archived, the assignee — if one was tapped —
    must be somebody a tool can be handed to, and the station must have
    somebody to book as. Only then does ``apply_movement`` — the one
    authoritative implementation of the ledger — run, and the recomputed
    article snapshot goes back so the screen renders the server's arithmetic
    rather than its own.

    The assignee is checked *last of the payload* and answers 400, never 404.
    A field that distinguishes "this user id exists and is active" from "it
    does not" by status code is a user-id enumeration oracle, and the caller
    here is a box on a wall that anybody in the workshop can reach: walk the
    integers, learn the shape of the staff list. Unknown and inactive are the
    same sentence, and both come after the checks that have nothing to do with
    people.

    One thing this endpoint does decide for itself: a ``return`` that names
    nobody is charged to the open loan it must have closed — see
    ``_open_loan_for_article``.
    """
    if payload.movement_type not in STATION_MOVEMENT_TYPES:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Buchungsart „{payload.movement_type}“ ist an einer Station nicht erlaubt. "
                f"Möglich sind: {', '.join(STATION_MOVEMENT_TYPES)}."
            ),
        )

    article = db.get(WerkstattArticle, payload.article_id)
    if article is None:
        raise HTTPException(status_code=404, detail="Artikel nicht gefunden")
    if bool(article.is_archived):
        raise HTTPException(
            status_code=400, detail="Artikel ist archiviert — keine Buchungen möglich"
        )

    if payload.assignee_user_id is not None:
        assignee = db.get(User, payload.assignee_user_id)
        if assignee is None or not assignee.is_active:
            raise HTTPException(
                status_code=400,
                detail="Empfänger nicht verfügbar — bitte Namen erneut antippen.",
            )

    user_id = resolve_station_user_id(db, station)

    # A Rückgabe is one button press with nobody's name on it — and a station
    # row is booked as the station's owner, so an unnamed return used to be
    # charged to that administrator while the borrower's loan stayed open with
    # nothing left to close it. Resolve whose loan the article is coming back
    # from and put that name (and its project) on the return instead. Only
    # when nobody tapped one: a name that *was* tapped is a fact, and a
    # colleague may well bring back a tool that is not on their own list.
    assignee_user_id = payload.assignee_user_id
    project_id: int | None = None
    if payload.movement_type == "return" and assignee_user_id is None:
        loan = _open_loan_for_article(db, article.id)
        if loan is not None:
            assignee_user_id, project_id = loan

    try:
        movement = apply_movement(
            db,
            article=article,
            movement_type=payload.movement_type,
            quantity=payload.quantity,
            user_id=user_id,
            assignee_user_id=assignee_user_id,
            project_id=project_id,
            notes=_station_notes(station, payload.notes),
        )
    except MovementError as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    # Stamped here rather than inside ``apply_movement``: that service is the
    # shared ledger implementation every user-facing path also runs, and it
    # knows nothing about stations — this router is the only caller that has
    # one in hand. ``apply_movement`` flushes but deliberately does not commit,
    # so the INSERT and this UPDATE are one transaction and no reader can ever
    # observe a station's row without its ``station_id``.
    movement.station_id = station.id
    db.add(movement)

    movement_id = movement.id
    db.commit()
    db.refresh(article)
    # ``_article_out`` is the projection the scan cascade already returns, so a
    # movement result and a scan result describe an article identically — the
    # rack screen renders both with one piece of code.
    return StationMovementOut(article=_article_out(db, article), movement_id=movement_id)


# ---------------------------------------------------------------------------
# Wareneingang for something the workshop has never stocked
# ---------------------------------------------------------------------------


@router.post("/articles/from-catalog", response_model=StationArticleFromCatalogOut)
def station_article_from_catalog(
    payload: StationArticleFromCatalogRequest,
    station: Station = Depends(get_current_station),
    db: Session = Depends(get_db),
) -> StationArticleFromCatalogOut:
    """Stock a wholesaler catalogue hit and book the delivery that brought it.

    The gap this closes, from a field report: an operator scans a supplier EAN
    at Wareneingang, ``/resolve`` answers ``catalog_match`` in under 200 ms —
    the Datanorm row is right there, with the name, the manufacturer and the
    unit — and the rack could do nothing with it, because booking stock needs
    an *article* and nobody had ever made one. The screen said "Code nicht
    zugeordnet. SMPL ist nicht erreichbar", which was true in its first half
    and false in its second, and sent people to check the network.

    So this is the widest power a station has: the others move quantities
    between columns, this one adds a row to the stock list. Four things keep it
    narrow.

    **The device cannot describe the product.** It sends a catalogue id, not a
    name — every field on the new article is copied from the Datanorm row by
    the shared builder. A station cannot invent an article for something no
    wholesaler sells, which is the failure mode that would matter: a stock
    list quietly filling with typos from a wall screen nobody is watching.

    **A repeat is a top-up, not a refusal.** The user-facing endpoint answers
    400 "an article with this EAN already exists" — right for a person filling
    in a form, wrong for somebody holding the second box of the same thing.
    Refusing here would put the operator back at the dead end this endpoint
    exists to remove, so an existing EAN is booked onto instead. The choice
    lives in each caller rather than in the shared builder for exactly that
    reason.

    **The row names a person and keeps the marker.** Same rule as
    ``station_movement``: ``resolve_station_user_id`` or a 409, plus
    ``station_id`` and a note prefix the caller cannot erase. It matters more
    here than for a movement, because this row is the birth of an article and
    "who decided this exists" has to stay answerable.

    **One transaction.** The builder deliberately does not commit, so the
    article INSERT, the intake movement and the ``station_id`` stamp land
    together — no reader can observe a station's booking without its station.
    """
    catalog_item = db.get(MaterialCatalogItem, payload.catalog_item_id)
    if catalog_item is None:
        raise HTTPException(status_code=404, detail="Katalog-Eintrag nicht gefunden")

    user_id = resolve_station_user_id(db, station)
    notes = _station_notes(station, payload.notes)

    # An eanless Datanorm row is common (~10% carry none) and must not dedupe:
    # `WHERE ean IS NULL` would make every one of them the same product.
    ean = (catalog_item.ean or "").strip() or None
    existing = (
        db.scalar(select(WerkstattArticle).where(WerkstattArticle.ean == ean)) if ean else None
    )

    try:
        if existing is not None:
            if bool(existing.is_archived):
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"„{existing.item_name}“ ist archiviert — bitte im SMPL reaktivieren, "
                        "bevor eine Lieferung darauf gebucht wird."
                    ),
                )
            article = existing
            movement = book_opening_stock(
                db, article, payload.quantity, user_id=user_id, notes=notes
            )
            created = False
        else:
            article, movement = build_article_from_catalog_item(
                db,
                catalog_item=catalog_item,
                user_id=user_id,
                stock_total=payload.quantity,
                opening_notes=notes,
            )
            created = True
    except MovementError as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    # Stamped here for the same reason ``station_movement`` stamps it here:
    # ``apply_movement`` is the shared ledger implementation and knows nothing
    # about stations, and it flushes without committing, so this UPDATE joins
    # the same transaction.
    # ``quantity`` is ge=1, so the opening booking always wrote a row. Assert
    # rather than tolerate: a None here would mean the quantity bound had been
    # loosened, and silently returning a movement-less "booked" to the rack is
    # the one outcome an operator cannot detect.
    assert movement is not None, "station intake booked no movement"
    movement.station_id = station.id
    db.add(movement)

    movement_id = movement.id
    db.commit()
    db.refresh(article)
    return StationArticleFromCatalogOut(
        article=_article_out(db, article),
        movement_id=movement_id,
        created=created,
    )


# ---------------------------------------------------------------------------
# Wareneingang for something nobody has ever stocked — the wider cascade
# ---------------------------------------------------------------------------


@router.get("/lookup", response_model=WerkstattArticleLookupOut)
def station_lookup(
    code: str = Query(..., min_length=1, max_length=64),
    station: Station = Depends(get_current_station),
    db: Session = Depends(get_db),
) -> WerkstattArticleLookupOut:
    """The same question the office asks, with the same answers.

    Separate from ``/resolve`` because it is a different question: ``/resolve``
    asks "which of our rows is this" and is what the screen runs on every scan,
    hundreds of times a day, with no outbound traffic. This one may reach the
    public webshop, so the screen asks it only at the moment a Wareneingang has
    already failed to find anything.
    """
    _ = station  # auth enforcement only — a station sees the same cascade
    result = lookup_code(db, code, allow_external=True)
    # A lookup may have cached what the outside world said, including that it
    # said nothing. Dropping that write would make the next box of the same
    # unknown product scrape again.
    db.commit()
    return result


@router.post("/articles/from-lookup", response_model=StationArticleFromLookupOut)
def station_article_from_lookup(
    payload: StationArticleFromLookupRequest,
    station: Station = Depends(get_current_station),
    db: Session = Depends(get_db),
) -> StationArticleFromLookupOut:
    """Book a delivery for a code the workshop has never stocked.

    ``/articles/from-catalog`` closed this dead end for products a wholesaler's
    Datanorm describes. This closes the rest of it: the box in the operator's
    hands is real whether or not anybody has imported a file that mentions it.

    Four outcomes, in the order the cascade finds them:

    **existing** — somebody stocked it since the screen last looked, or the
    scan was a variant spelling of an EAN we hold. Top up, do not duplicate.

    **catalog** — a Datanorm row. The shared builder copies its identity and
    links its supplier, exactly as the from-catalog endpoint does; where the
    same product sits in several suppliers' files, the one whose supplier has
    the most rows wins, because that is the file most likely to be current.

    **external** — the public webshop recognised the barcode. The article is
    created from the suggestion with ``image_source='external'`` and a note
    naming the source, so the row itself records that its name was scraped.

    **nothing** — refused with a German sentence, UNLESS the operator typed a
    name. The rack panel has a keyboard and the person is holding the product;
    a typed name is a better record than a placeholder called "Unbekannt", and
    it is accepted only here, only when every source came up empty.

    Same four guards as ``station_article_from_catalog``: a person's name on
    the row (409 without one), the station marker on the note, ``station_id``
    on the movement, and one transaction for all of it.
    """
    replay = _replay_of(db, payload.request_id)
    if replay is not None:
        return replay

    user_id = resolve_station_user_id(db, station)
    notes = _station_notes(station, payload.notes)
    found = lookup_code(db, payload.code, allow_external=True)

    typed_name = (payload.item_name or "").strip()
    if found.kind == "none" and not typed_name:
        # The cache row the lookup may have written is worth keeping even
        # though the request fails: the next scan of this code, two boxes
        # later, must not pay for another scrape.
        db.commit()
        raise HTTPException(
            status_code=404,
            detail=(
                f"Kein Artikel zu „{payload.code}“ gefunden — bitte Bezeichnung eintippen "
                "oder im SMPL unter Bestand → Neuer Artikel anlegen."
            ),
        )

    try:
        article, movement, origin, source = _stock_from_lookup(
            db,
            found=found,
            payload=payload,
            typed_name=typed_name,
            user_id=user_id,
            notes=notes,
        )
    except MovementError as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    # Stamped here for the same reason ``station_movement`` stamps it here:
    # ``apply_movement`` is the shared ledger implementation and knows nothing
    # about stations, and it flushes without committing, so this UPDATE joins
    # the same transaction. ``quantity`` is ge=1, so a booking always wrote a
    # row; a None here would mean that bound had been loosened, and silently
    # returning a movement-less "gebucht" to the rack is the one outcome an
    # operator cannot detect.
    assert movement is not None, "station intake booked no movement"
    movement.station_id = station.id
    # The retry token rides on the ledger row, in the same transaction as the
    # booking it identifies — so "was this already booked?" is answered by the
    # same commit that booked it, with no second table to fall out of step.
    movement.client_request_id = payload.request_id or None
    db.add(movement)

    movement_id = movement.id
    db.commit()
    db.refresh(article)
    return StationArticleFromLookupOut(
        article=_article_out(db, article),
        movement_id=movement_id,
        created=origin != "existing",
        origin=origin,
        source=source,
        internal_code=article.internal_code,
    )


def _replay_of(db: Session, request_id: str | None) -> StationArticleFromLookupOut | None:
    """The answer this exact attempt already got, if it got one.

    Not a cache: it reads the ledger row the first attempt wrote. ``created``
    is False and ``origin`` is "existing" on a replay because that is what the
    second attempt actually achieved — nothing. The wall then says
    "Wareneingang 3" rather than "Artikel angelegt", which is the truth for a
    scan that repeated a booking the operator could not see.
    """
    token = (request_id or "").strip()
    if not token:
        return None
    movement = db.scalar(
        select(WerkstattMovement).where(WerkstattMovement.client_request_id == token)
    )
    if movement is None:
        return None
    article = db.get(WerkstattArticle, movement.article_id)
    if article is None:
        return None
    return StationArticleFromLookupOut(
        article=_article_out(db, article),
        movement_id=movement.id,
        created=False,
        origin="existing",
        source=None,
        internal_code=article.internal_code,
    )


def _stock_from_lookup(
    db: Session,
    *,
    found: WerkstattArticleLookupOut,
    payload: StationArticleFromLookupRequest,
    typed_name: str,
    user_id: int,
    notes: str,
):
    """Turn a lookup result into (article, movement, origin, source).

    Split out so the endpoint above reads as the policy it is — who may call,
    whose name goes on the row, what happens on each outcome — rather than as
    four branches of article construction.
    """
    if found.kind == "existing":
        article = db.get(WerkstattArticle, found.article.id)
        if article is None:
            raise HTTPException(status_code=404, detail="Artikel nicht gefunden")
        if bool(article.is_archived):
            raise HTTPException(
                status_code=400,
                detail=(
                    f"„{article.item_name}“ ist archiviert — bitte im SMPL reaktivieren, "
                    "bevor eine Lieferung darauf gebucht wird."
                ),
            )
        movement = book_opening_stock(
            db, article, payload.quantity, user_id=user_id, notes=notes
        )
        return article, movement, "existing", None

    if found.kind == "catalog":
        catalog_item = _preferred_catalog_row(db, found)
        if catalog_item is None:
            raise HTTPException(status_code=404, detail="Katalog-Eintrag nicht gefunden")
        # The same guard ``station_article_from_catalog`` applies, and for the
        # same reason: ``build_article_from_catalog_item`` deliberately leaves
        # the EAN-uniqueness question to its caller. Without it, a shipping
        # label scanned by its supplier article number resolves to a Datanorm
        # row whose EAN another article already holds, the partial-unique index
        # rejects the INSERT, and the rack shows "HTTP 500" for a delivery
        # standing in front of somebody. A repeat is a top-up, not a refusal.
        existing = _article_holding_ean(db, catalog_item.ean)
        if existing is not None:
            if bool(existing.is_archived):
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"„{existing.item_name}“ ist archiviert — bitte im SMPL reaktivieren, "
                        "bevor eine Lieferung darauf gebucht wird."
                    ),
                )
            movement = book_opening_stock(
                db, existing, payload.quantity, user_id=user_id, notes=notes
            )
            return existing, movement, "existing", None
        article, movement = build_article_from_catalog_item(
            db,
            catalog_item=catalog_item,
            user_id=user_id,
            stock_total=payload.quantity,
            opening_notes=notes,
        )
        return article, movement, "catalog", "catalog"

    if found.kind == "external":
        article = build_article_from_external_hit(
            db, hit=found.hit, user_id=user_id, notes=notes
        )
        movement = book_opening_stock(
            db, article, payload.quantity, user_id=user_id, notes=notes
        )
        return article, movement, "external", found.hit.source

    # Nothing found anywhere, and somebody typed a name. A consumable, never
    # serialized: a machine is a thing with its own label and its own
    # inspection dates, and a wall screen is not where one gets created.
    article = WerkstattArticle(
        article_number=next_article_number(db),
        ean=payload.code.strip() if gtin.is_gtin(payload.code) else None,
        item_name=typed_name,
        unit=(payload.unit or "").strip() or None,
        stock_total=0,
        stock_available=0,
        stock_out=0,
        stock_repair=0,
        stock_min=0,
        is_serialized=False,
        currency="EUR",
        notes=f"{notes} — an der Station angelegt",
        created_by=user_id,
    )
    db.add(article)
    db.flush()
    movement = book_opening_stock(db, article, payload.quantity, user_id=user_id, notes=notes)
    return article, movement, "manual", None


def _article_holding_ean(db: Session, ean: str | None) -> WerkstattArticle | None:
    """The article that already carries this barcode, in any spelling.

    Variant-aware like the desktop endpoint's check: an article stored under
    the zero-padded EAN-13 and a Datanorm row carrying the 12-digit UPC-A are
    the same product, and creating the second row is the duplicate the merge
    screen then has to clean up. An eanless Datanorm row (about a tenth of
    them) must never dedupe — ``WHERE ean IS NULL`` would make every one of
    them the same product.
    """
    code = (ean or "").strip()
    if not code:
        return None
    return db.scalar(
        select(WerkstattArticle).where(WerkstattArticle.ean.in_(gtin.variants(code)))
    )


def _preferred_catalog_row(db: Session, found) -> MaterialCatalogItem | None:
    """Which supplier's row to copy when several describe the same product.

    The supplier with the most catalogue rows: that is the wholesaler whose
    Datanorm was imported most recently and most completely, so its naming and
    its unit are the ones the rest of the workshop already reads. A tie, or no
    supplier at all, falls back to the hero row the grouping picked — which is
    simply the first, and is still a real product.
    """
    ids = [
        row.id
        for group in found.groups
        for row in ([group.hero] + list(group.suppliers))
        if row.id is not None
    ]
    if not ids:
        return None
    rows = list(
        db.scalars(select(MaterialCatalogItem).where(MaterialCatalogItem.id.in_(ids))).all()
    )
    if not rows:
        return None
    supplier_ids = {row.supplier_id for row in rows if row.supplier_id is not None}
    counts: dict[int, int] = {}
    if supplier_ids:
        counts = {
            supplier_id: int(total or 0)
            for supplier_id, total in db.execute(
                select(MaterialCatalogItem.supplier_id, func.count(MaterialCatalogItem.id))
                .where(MaterialCatalogItem.supplier_id.in_(supplier_ids))
                .group_by(MaterialCatalogItem.supplier_id)
            ).all()
        }
    rows.sort(key=lambda row: (-counts.get(row.supplier_id or -1, 0), row.id))
    return rows[0]
