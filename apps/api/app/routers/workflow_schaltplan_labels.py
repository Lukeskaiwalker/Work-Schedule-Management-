"""Printing a Verteiler's labels: BMK strips, Reihenklemmen, the §14a block, wire labels.

Moved out of ``workflow_schaltplan`` (docs/PANEL_ENCLOSURE_R4.md §9, the
800-line cap) with the round-4 plans added: the §14a block strip rides the
Reihenklemmen print as its last item, the Aderbeschriftung is its own
target. The route registers on the plan router (same prefix, same path);
``workflow_schaltplan`` imports this module at its end, so ``app.main`` is
unchanged. The rule is the plan router's: anyone who may read the plan may
print its labels — the person at the printer is the one building the board.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from fastapi import Depends, HTTPException
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.deps import get_current_user
from app.models.entities import User
from app.routers.workflow_schaltplan import _assert_readable, _get_plan_or_404, router
from app.schemas.schaltplan import PanelLabelsPrintOut, PanelLabelsPrintRequest, PanelStripOut
from app.services import panel_enclosure_service as enclosure
from app.services import werkstatt_label_control_strip as control_print
from app.services import werkstatt_labels
from app.services.panel_enclosure_control_block import stored_block
from app.services.schaltplan_layout import board_font_size, empty_document, strip_segments, unlabelled_device_count
from app.services.schaltplan_terminals import STRIP_KIND_BLOCK, derive_terminals, terminal_font_size, terminal_strips
from app.services.werkstatt_label_materials import MaterialProfile, MaterialValidationError

STALE_TERMINALS_DETAIL = (
    "Die Klemmenleisten dieses Plans sind neu nummeriert — nichts gedruckt. "
    "Bitte die Seite neu laden (in der iOS-App: App aktualisieren) und erneut drucken."
)
NO_TERMINALS_DETAIL = "Keine Reihenklemmen abgeleitet — erst Abgänge mit „Reihenklemme am Abgang“ markieren."


@dataclass
class _PrintPlan:
    """What one label request sends to the printer, before it is shipped.

    ``strips`` is the ``(text, width_mm)`` form ``print_marking_strips``
    takes; ``meta`` is what the response reports per strip. Built by one of
    the ``_..._print_plan`` functions so the endpoint itself only picks a
    target, ships and answers.
    """

    strips: list[list[tuple[str, float]]] = field(default_factory=list)
    # Terminal Block labels (name, X, cells) — printed after the strips.
    blocks: list[dict[str, Any]] = field(default_factory=list)
    # The §14a block strip — printed last.
    control: control_print.ControlStrip | None = None
    meta: list[PanelStripOut] = field(default_factory=list)
    skipped: int = 0
    font_size: int | None = None
    overflowing: list[str] = field(default_factory=list)
    empty_detail: str = ""


def _bmk_print_plan(document: dict[str, Any], payload: PanelLabelsPrintRequest, profile: MaterialProfile) -> _PrintPlan:
    """The BMK strips of the selected rails (see ``print_panel_labels``)."""
    plan = _PrintPlan(empty_detail="Keine BMK vergeben — erst Betriebsmittelkennzeichen eintragen.")
    # The board size is a strip concept: die-cut labels (210-805) are fitted
    # one by one on their own 15 mm, so there is nothing board-wide to report.
    if profile.continuous:
        plan.font_size, plan.overflowing = board_font_size(document, profile.width_mm)

    wanted = set(payload.row_ids or [])
    if payload.row_id:
        wanted.add(payload.row_id)

    for row in document.get("rows") or []:
        if not isinstance(row, dict):
            continue
        row_id = str(row.get("id") or "")
        if wanted and row_id not in wanted:
            continue
        plan.skipped += unlabelled_device_count(row)
        segments = strip_segments(row)
        if not segments:
            continue
        plan.strips.append([(seg.text, seg.width_mm) for seg in segments])
        plan.meta.append(
            PanelStripOut(
                row_id=row_id,
                row_label=str(row.get("label") or ""),
                length_mm=round(sum(seg.width_mm for seg in segments), 2),
            )
        )
    return plan


def _check_selection(
    document: dict[str, Any], strip_ids: list[str] | None, groups: list[dict[str, Any]]
) -> control_print.ControlStrip | None:
    """The 409s and the empty-board 400 of a Reihenklemmen request; returns the board's §14a strip.

    A strip the board no longer derives means the sender numbered another
    board (a tab or app from before round 2's skip set): the strips left
    would print under X numbers its screen does not show (review UPG-5). The
    §14a strip sent but not derived (removed, switched off, every terminal
    deleted) has its own text.
    """
    block_strip = control_print.control_strip(document)
    if strip_ids is not None and block_strip is None and control_print.CONTROL_STRIP_ID in strip_ids:
        raise HTTPException(status_code=409, detail=control_print.CONTROL_STALE_DETAIL)
    derived = {strip["strip_id"] for group in groups for strip in group["strips"]} | {control_print.CONTROL_STRIP_ID}
    if strip_ids is not None and not set(strip_ids) <= derived:
        raise HTTPException(status_code=409, detail=STALE_TERMINALS_DETAIL)
    if not groups and block_strip is None:
        raise HTTPException(status_code=400, detail=NO_TERMINALS_DETAIL)
    return block_strip


def _wanted_control_strip(
    block_strip: control_print.ControlStrip | None, strip_ids: list[str] | None
) -> control_print.ControlStrip | None:
    """The §14a strip when the request includes it (``strip_ids`` null = everything).

    A label too long for the 5,2 mm terminal is never printed: 400 with the
    dialog's own text.
    """
    if block_strip is None or (strip_ids is not None and control_print.CONTROL_STRIP_ID not in strip_ids):
        return None
    too_long = control_print.first_too_long(block_strip.labels)
    if too_long is not None:
        raise HTTPException(status_code=400, detail=control_print.label_too_long_detail(too_long))
    return block_strip


def _add_control_strip(plan: _PrintPlan, block_strip: control_print.ControlStrip | None) -> None:
    """The §14a strip as the plan's last piece; its blank labels count as skipped."""
    if block_strip is None:
        return
    plan.control = block_strip
    plan.skipped += block_strip.blank_count
    plan.meta.append(
        PanelStripOut(
            row_id=block_strip.strip_id,
            row_label=control_print.CONTROL_STRIP_LABEL,
            length_mm=block_strip.length_mm,
            part_count=block_strip.part_count,
        )
    )


def _terminal_print_plan(
    document: dict[str, Any], payload: PanelLabelsPrintRequest, profile: MaterialProfile, skip: frozenset[str]
) -> _PrintPlan:
    """The Reihenklemmen markers of the selected FI groups, one strip per group, the §14a strip last.

    Continuous stock only: the markers are 5.2 mm and 12 mm wide and slide
    into the WAGO marker slot as one strip per group, so a die-cut label
    cannot carry them. The font size is fitted over every group of the board
    in the chosen text mode, exactly like the BMK size is fitted over every
    rail — a group reprinted next week must match the ones printed today.
    The §14a strip sizes itself (vertical text, R4 §9.1).
    """
    if not profile.continuous:
        raise HTTPException(status_code=400, detail="Reihenklemmen werden nur auf Endlosstreifen gedruckt.")
    # An explicit empty selection is "nothing", never "everything": the sheet
    # sends exactly the ticked groups, and unticking them all must not print
    # the whole board.
    if payload.strip_ids is not None and not payload.strip_ids:
        raise HTTPException(status_code=400, detail="Keine Klemmenleiste ausgewählt — mindestens eine wählen.")
    groups = derive_terminals(document, skip=skip)  # the cabinet's numbers (R2 §3.1)
    block_strip = _wanted_control_strip(_check_selection(document, payload.strip_ids, groups), payload.strip_ids)
    plan = _PrintPlan(
        empty_detail="Keine Beschriftung für die gewählten Klemmen — die Texte in der Vorschau prüfen.",
    )
    plan.font_size, plan.overflowing = terminal_font_size(groups, profile.width_mm)
    selection = terminal_strips(groups, payload.strip_ids)
    # Over the whole selection, not the strips: a Leiste with no text at all
    # produces no strip, but its terminals are still the ones left unmarked.
    plan.skipped = int(selection["skipped"])
    for strip in selection["strips"]:
        if strip["kind"] == STRIP_KIND_BLOCK:
            plan.blocks.append({"name": strip["name"], "x_label": strip["x_label"], "cells": list(strip["cells"])})
        else:
            plan.strips.append(list(strip["segments"]))
        plan.meta.append(
            PanelStripOut(
                row_id=str(strip["strip_id"]),
                row_label=str(strip["label"]),
                length_mm=round(float(strip["length_mm"]), 2),
                part_count=int(strip["part_count"]),
            )
        )
    _add_control_strip(plan, block_strip)
    return plan


def _wire_print_plan(document: dict[str, Any]) -> tuple[_PrintPlan, str]:
    """The Aderbeschriftung: every named terminal twice, on the block's own tube.

    ``strip_ids`` and ``material_id`` of the request are ignored — the board
    says which tube is loaded for its wires. One job, never ``copies``.
    """
    segments = control_print.wire_label_segments(document)
    if segments is None:
        raise HTTPException(status_code=400, detail=control_print.NO_WIRE_LABELS_DETAIL)
    block = stored_block(document)  # not None: there are segments
    plan = _PrintPlan(empty_detail=control_print.NO_WIRE_LABELS_DETAIL)
    plan.strips.append(segments)
    plan.skipped = sum(1 for terminal in block["terminals"] if not terminal["label"])
    total_mm = 0.0
    for _, width_mm in segments:
        total_mm += width_mm
    plan.meta.append(
        PanelStripOut(
            row_id=control_print.WIRE_STRIP_ID,
            row_label=control_print.WIRE_STRIP_LABEL,
            length_mm=round(total_mm, 2),
            part_count=len(segments),
        )
    )
    return plan, block["label_material"]


def _profile_or_400(db: Session, material_id: str) -> MaterialProfile:
    try:
        return werkstatt_labels.material_by_id(db, material_id)
    except MaterialValidationError as exc:
        raise HTTPException(status_code=400, detail=f"Unbekanntes Etikettenmaterial: {exc}")


def _plan_for(db: Session, document: dict[str, Any], payload: PanelLabelsPrintRequest) -> tuple[_PrintPlan, str, MaterialProfile]:
    """(plan, material id, profile) for the request's target."""
    if payload.target == "adern":
        plan, material_id = _wire_print_plan(document)
        profile = _profile_or_400(db, material_id)
        plan.font_size, plan.overflowing = control_print.wire_label_size(plan.strips[0], profile)
        return plan, material_id, profile
    material_id = (payload.material_id or werkstatt_labels.MARKING_STRIP_MATERIAL_ID).strip()
    profile = _profile_or_400(db, material_id)
    if payload.target == "reihenklemmen":
        return _terminal_print_plan(document, payload, profile, enclosure.board_terminal_skip(db, document)), material_id, profile
    return _bmk_print_plan(document, payload, profile), material_id, profile


@router.post("/panels/{plan_id}/labels", response_model=PanelLabelsPrintOut)
def print_panel_labels(
    plan_id: int,
    payload: PanelLabelsPrintRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> PanelLabelsPrintOut:
    """Print the Betriebsmittelkennzeichen of selected rails — or the Reihenklemmen markers, or the wire labels.

    Anyone who may read the plan may print its labels: the person at the
    printer is the one building the board, not the one who drew it. On the
    2009-110 every rail becomes one continuous strip laid out at the devices'
    real widths with a cut mark on every boundary and a heavier one at both
    ends; on the 210-805 every BMK becomes one 6 × 15 mm label. Rails go out
    in board order.

    Only labelled devices get a segment. A Blindabdeckung never does, and a
    Betriebsmittel without a BMK gets none either — the strip continues with
    the next labelled device. The unnamed ones ARE counted, because the
    missing designation is the thing to fix, not to hide.

    The font size is one number for the WHOLE board, not per rail and not per
    selection: it is fitted over every labelled device of every row, so a rail
    printed next week matches the ones printed today. BMK that cannot fit
    their segment even at the minimum size are listed in ``overflowing``.

    With ``target="reihenklemmen"`` the same path prints the WAGO terminal
    markers: one piece per strip at the terminals' real pitch (see
    ``services/schaltplan_terminals.py``) — a Leiste reading X1, 1.1, 1.2 …
    or a Block label (name, X, N L1 L2 L3 PE) — ``strips[].row_id`` then
    being the strip id and ``skipped_without_bmk`` the Leiste terminals of
    the selected strips whose text was blanked — a Leiste with no text at
    all gets no strip, but its terminals are counted. ``strip_ids`` null =
    every strip; an explicit empty list is refused, not read as "all"; one
    naming a strip the board does not derive is a stale screen: 409. The
    §14a block strip (``control:block``, vertical text) is always the last
    strip; its blank labels print empty segments and count as skipped.

    With ``target="adern"`` it prints the wire labels of the §14a block on
    the block's own heat-shrink tube, every named terminal twice
    (``strips[0].row_id`` = ``control:wires``).
    """
    plan = _get_plan_or_404(db, plan_id)
    _assert_readable(db, current_user, plan)
    document = plan.document or empty_document()
    print_plan, material_id, profile = _plan_for(db, document, payload)

    if not print_plan.strips and not print_plan.blocks and print_plan.control is None:
        raise HTTPException(status_code=400, detail=print_plan.empty_detail)
    try:
        printed, printer = werkstatt_labels.print_marking_strips(
            db, strips=print_plan.strips, material_id=material_id, size=print_plan.font_size,
            blocks=print_plan.blocks, control=print_plan.control,
        )
    except werkstatt_labels.LabelFormatUnsupported as exc:
        # The coordinate guard (a strip offset off the material) or a block
        # label on die-cut stock: the German reason, not a 500.
        raise HTTPException(status_code=400, detail=str(exc))
    except werkstatt_labels.LabelPrinterNotConfigured:
        raise HTTPException(status_code=503, detail="Kein Etikettendrucker konfiguriert")
    except werkstatt_labels.LabelPrinterBusy as exc:
        # A calibration session holds the printer, or another job is on the wire.
        raise HTTPException(status_code=409, detail=str(exc))
    except werkstatt_labels.LabelPrinterUnreachable as exc:
        raise HTTPException(status_code=502, detail=f"Etikettendrucker nicht erreichbar ({exc})")

    return PanelLabelsPrintOut(
        printed=printed,
        skipped_without_bmk=print_plan.skipped,
        printer=printer,
        material=material_id,
        strips=print_plan.meta if profile.continuous else [],
        font_size_dots=print_plan.font_size,
        overflowing=print_plan.overflowing,
    )
