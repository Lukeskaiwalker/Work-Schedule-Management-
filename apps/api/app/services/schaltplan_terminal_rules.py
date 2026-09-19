"""Reihenklemmen — the WAGO part table and the per-device rules.

Twin of ``apps/web/src/utils/schaltplanTerminalRules.ts``. The derivation
over a whole document lives one level up in ``schaltplan_terminals.py``;
the rules are split out so ``schaltplan_layout.validate_document`` can
report them (the derivation needs ``build_topology`` from that module).

Widths were looked up per article number on 2026-09-17 — wago.com where
the page carries the number, else a distributor's copy of the datasheet —
and the URL sits next to each row. A width nobody could confirm is
``verified=False``, and the editor's print dialog says so before the strip
feeds: a wrong pitch shifts every following marker along the strip, so a
guessed constant would be worse than a visible warning. If a measured
carrier disagrees with a row, that row's ``width_mm`` is the one number to
change (same policy as ``CAP_TOP_RATIO`` in werkstatt_labels.py).

Marking. All seven parts are TOPJOB S; their marker is the 2009-110 strip
(11 mm, continuous, snapped into the terminal's marker slot) — the same
stock the BMK strip uses, so one strip is printed per FI group and slid
along the row. Feed and Etagenklemmen carry a marker; the two end elements
do not (``marker=False``) and therefore never get a segment on the strip.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from app.services.schaltplan_layout import DEVICE_CATALOG


@dataclass(frozen=True)
class TerminalPart:
    id: str
    # "WAGO 2003-7641" — what the Stückliste and any purchasing hook print.
    part_no: str
    # German name as the datasheet has it, not as the rule table would like it.
    name: str
    # What the derivation uses the part for.
    role: str
    # Rail footprint in mm per the datasheet; for a marker-carrying part this
    # is its strip segment.
    width_mm: float
    # Carries a 2009-110 marker and so gets a segment on the strip.
    marker: bool
    # The width was confirmed on a WAGO or distributor page (see ``source``).
    verified: bool
    source: str


TERMINAL_PARTS: dict[str, TerminalPart] = {
    "2003-7641": TerminalPart(
        id="2003-7641",
        part_no="WAGO 2003-7641",
        name="Installations-Etagenklemme NT/L/PE, 2,5 mm²",
        role="je 1-poliger Abgang",
        # Klemmbreite 5,2 mm (BAUHAUS datasheet copy; wago.com/us/…/p/2003-7641
        # names it "Multilevel installation terminal block; NT/L/PE" but keeps
        # the width in the download section).
        width_mm=5.2,
        marker=True,
        verified=True,
        source="https://www.bauhaus.info/installationsklemmen/wago-topjob-installationsetagenklemme-s-2003-7641/p/27588879",
    ),
    "2003-7642": TerminalPart(
        id="2003-7642",
        part_no="WAGO 2003-7642",
        # The datasheet says L/L — two potentials on three levels — not
        # "3-polig". The owner picked the part for the 3-pole outgoing; the
        # name follows WAGO so nobody orders the wrong thing off the list.
        name="Installations-Etagenklemme L/L, 2,5 mm²",
        role="je 3-poliger Abgang",
        # Breite 5,2 mm (elektroland24 datasheet copy; wago.com/us/…/p/2003-7642: L/L).
        width_mm=5.2,
        marker=True,
        verified=True,
        source="https://www.elektroland24.de/Elektroinstallation/Verteilungseinbau/Reihenklemmen/WAGO/Wago-2003-7642-Installations-Etagenklemme-L-L.html",
    ),
    "2016-7714": TerminalPart(
        id="2016-7714",
        part_no="WAGO 2016-7714",
        name="N-Einspeiseklemme mit Trennung, 16 mm² (1-Leiter-N-Trennklemme)",
        role="Einspeisung der FI-Gruppe",
        # 12 mm breit (elanto24; wago.com/us/…/p/2016-7714: "1-conductor
        # N-disconnect terminal block; 16 mm²").
        width_mm=12,
        marker=True,
        verified=True,
        source="https://www.elanto24.de/elektromaterial/befestigung/reihenklemmen/wago/installationsetagenklemmen/31920/wago-2016-7714-n-einspeiseklemme-in-76-a-16mm2-12-mm-breit-blau",
    ),
    "2009-305": TerminalPart(
        id="2009-305",
        part_no="WAGO 2009-305",
        # Not an end plate: a busbar carrier with end-stop function and a
        # detachable separator plate. It closes the group's N bus, carries no
        # marker, and is 7.5 mm wide on the rail (the design assumed 0 — the
        # strip is unaffected because a marker-less part gets no segment, but
        # the footprint is real and the Stückliste names the real part).
        name="Sammelschienenträger mit Endklammerfunktion (Endelement)",
        role="Ende der FI-Gruppe",
        width_mm=7.5,
        marker=False,
        verified=True,
        source="https://www.wago.com/us/rail-chassis-terminal-blocks/topjobs-busbar-carrier/p/2009-305",
    ),
    "2016-7604": TerminalPart(
        id="2016-7604",
        part_no="WAGO 2016-7604",
        name="N-Verteilereinspeiseklemme, 16 mm², blau (2-Leiter)",
        role="Einspeisung bei einzelnem Drehstromabgang",
        # Breite 12 mm (elektroland24; wago.com/us/…/p/2016-7604: blue, 16 mm²,
        # "side and center marking").
        width_mm=12,
        marker=True,
        verified=True,
        source="https://www.elektroland24.de/elektroinstallation/verteilungseinbau/reihenklemmen/wago/wago-2016-7604-2-leiter-n-verteilereinspeiseklemme.html",
    ),
    "2016-7601": TerminalPart(
        id="2016-7601",
        part_no="WAGO 2016-7601",
        name="Verteilereinspeiseklemme, 16 mm², grau (2-Leiter)",
        role="je Pol des einzelnen Drehstromabgangs",
        # 12 mm (heizung-billiger datasheet copy; wago.com/global/…/p/2016-7601:
        # gray, 16 mm², "side and center marking").
        width_mm=12,
        marker=True,
        verified=True,
        source="https://heizung-billiger.de/770206-wago-verteiler-einspeiseklemme-2016-2016-7601-16mm2-800v-76a-12mm-grau-wago-2016-7601-4045454725082.html",
    ),
    "2016-7607": TerminalPart(
        id="2016-7607",
        part_no="WAGO 2016-7607",
        name="2-Leiter-Schutzleiterklemme, 16 mm², grün-gelb",
        role="PE des einzelnen Drehstromabgangs",
        # Breite 12 mm — wago.com/de/…/p/2016-7607, "Geometrische Daten": 12 mm /
        # 0.472 inch (85,7 mm hoch, 40,8 mm ab Oberkante Tragschiene), read
        # 2026-09-19. The owner confirmed the same day that 7607 is the part on
        # the shelf and that "2016-7606" never existed. It has side and centre
        # marking, so it gets a 12 mm "PE" segment on the strip.
        width_mm=12,
        marker=True,
        verified=True,
        source="https://www.wago.com/de/reihenklemmen/2-leiter-schutzleiterklemme/p/2016-7607",
    ),
}

# Parts in table order, for the Stückliste and the unverified-width warning.
TERMINAL_PART_ORDER: tuple[str, ...] = (
    "2003-7641",
    "2003-7642",
    "2009-305",
    "2016-7601",
    "2016-7604",
    "2016-7607",
    "2016-7714",
)

FEED_PART_IDS: frozenset[str] = frozenset({"2016-7714", "2016-7604"})
OUTGOING_PART_IDS: frozenset[str] = frozenset({"2003-7641", "2003-7642", "2016-7601"})
END_PART_IDS: frozenset[str] = frozenset({"2009-305"})

# Kinds that may end on a Reihenklemme: MCB-protected outgoing circuits. An
# RCBO is deliberately absent — its N is its own and must not sit on the FI
# group's N bus (owner decision). Fuses, contactors, relays and SPDs never
# get one.
TERMINAL_ELIGIBLE_KINDS: frozenset[str] = frozenset({"mcb", "wallbox", "sub_feed", "pv"})

VARIANT_STANDARD = "standard"
VARIANT_SINGLE_3P = "single3p"
VARIANT_NO_RCD = "no_rcd"


def is_terminal_eligible(device: dict[str, Any]) -> bool:
    return str(device.get("kind") or "") in TERMINAL_ELIGIBLE_KINDS


def has_terminal(device: dict[str, Any]) -> bool:
    """Eligible AND flagged: the device gets a terminal."""
    return is_terminal_eligible(device) and bool(device.get("terminal_block"))


def device_poles(device: dict[str, Any]) -> int:
    """Pole count as the rules read it: whole, 1..4, anything odd becomes 1."""
    try:
        raw = int(device.get("poles") or 1)
    except (TypeError, ValueError):
        raw = 1
    return max(1, min(4, raw or 1))


def poles_as_derived(poles: int) -> int:
    """Decision (b): 1P+N counts as 1-pole, 4-pole as 3-pole — the Etagenklemmen come in those two shapes."""
    return 1 if poles <= 2 else 3


def outgoing_part_for_poles(poles: int) -> str:
    return "2003-7641" if poles_as_derived(poles) == 1 else "2003-7642"


def terminal_children(group: dict[str, Any]) -> list[dict[str, Any]]:
    """The children of a group that end on a terminal, in physical order."""
    return [device for device in group.get("children") or [] if isinstance(device, dict) and has_terminal(device)]


def terminal_variant(group: dict[str, Any], children: list[dict[str, Any]]) -> str | None:
    """Which rule a group follows, or None when nothing in it has a terminal.

    ``single3p``: an FI with exactly one 3- or 4-pole outgoing — the 16 mm²
    feed, one terminal per pole, the 2016 end element. ``standard``: any
    other FI — N feed, one Etagenklemme per outgoing, the end clamp.
    ``no_rcd``: a Hauptschalter/SLS/fuse/supply group — the per-device
    terminals only; there is no FI whose N bus a feed terminal could open.
    """
    if not children:
        return None
    head = group.get("device")
    if head is None or str(head.get("kind") or "") != "rcd":
        return VARIANT_NO_RCD
    if len(children) == 1 and device_poles(children[0]) >= 3:
        return VARIANT_SINGLE_3P
    return VARIANT_STANDARD


def _text(value: Any) -> str:
    return str(value).strip() if value is not None else ""


def group_head_label(group: dict[str, Any]) -> str:
    """"Q1" / "FI" / "Einspeisung" — how a group head reads in a finding."""
    head = group.get("device")
    if head is None:
        return "Einspeisung"
    return _text(head.get("designation")) or str(DEVICE_CATALOG.get(str(head.get("kind") or ""), {}).get("short", "?"))


def _device_label(device: dict[str, Any]) -> str:
    return _text(device.get("designation")) or _text(device.get("label")) or "Abgang"


def terminal_findings(groups: list[dict[str, Any]]) -> list[dict[str, str]]:
    """The two advisory findings the terminal rules add to ``validate_document``.

    A group without an FI whose outgoings still want terminals (rule 4), and
    a pole count the Etagenklemmen do not come in (decision b). Both
    ``info``, never ``warn``: the derivation is still right, the electrician
    just needs to know what it assumed.
    """
    findings: list[dict[str, str]] = []
    for group in groups:
        children = terminal_children(group)
        variant = terminal_variant(group, children)
        if variant is None:
            continue
        head = group.get("device")
        if variant == VARIANT_NO_RCD:
            findings.append(
                {
                    "level": "info",
                    "scope": str(head.get("id") or "") if head is not None else "",
                    "message": (
                        f"Gruppe {group_head_label(group)}: Abgänge mit Reihenklemme ohne FI — "
                        "Einspeiseklemme nicht abgeleitet"
                    ),
                }
            )
        # The per-pole variant honours every pole; only the Etagenklemmen round.
        if variant == VARIANT_SINGLE_3P:
            continue
        for device in children:
            poles = device_poles(device)
            if poles in (1, 3):
                continue
            findings.append(
                {
                    "level": "info",
                    "scope": str(device.get("id") or ""),
                    "message": f"{_device_label(device)}: {poles}-polig — Klemme wie {poles_as_derived(poles)}-polig abgeleitet",
                }
            )
    return findings
