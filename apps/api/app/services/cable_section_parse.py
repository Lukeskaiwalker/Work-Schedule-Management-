"""Cable cross-section and fuse rating out of free text (docs/PANEL_ENCLOSURE_R4.md §3.5).

``supply.incoming`` and ``supply.fuse`` are whatever the planner typed:
"NYY-J 5x16 mm²", "5G25", "NAYY-J 4x50", "NH00 100A". The cabinet preparation
reads the infeed cross-section from it (R4-10, no schema change) and the
all-conductor schematic reads the same numbers, so the parser lives here, in a
module both import.

Twin: ``apps/web/src/utils/cableSectionParse.ts`` (or inside ``enclosurePrep.ts``)
must agree on every input; the fixture tables ``infeed_parse`` and
``fuse_parse`` pin it. Hence the narrow rules: the text is normalised to ASCII
spacing first, Python compiles with ``re.ASCII`` and TS uses no ``u`` flag, and
the patterns spell spaces as ``" *"`` (never ``\\s``, which differs).
"""

from __future__ import annotations

import re
from typing import Any

__all__ = [
    "MAX_SECTION_MM2",
    "MIN_SECTION_MM2",
    "normalise_cable_text",
    "parse_cable_section",
    "parse_fuse_amps",
]

#: A cross-section outside this range is not a conductor of a house infeed
#: ("1x500" is a cable count, "5x0.75" a control lead).
MIN_SECTION_MM2, MAX_SECTION_MM2 = 1.5, 300.0
_MAX_CORES = 5

_REPLACEMENTS = (("²", "2"), ("×", "x"), ("*", "x"), (",", "."), ("qmm", "mm"))
#: Every Unicode space the planner's keyboard may produce, mapped to U+0020.
_SPACES = frozenset(
    [*(chr(c) for c in range(0x0009, 0x000E)), " ", " ",
     *(chr(c) for c in range(0x2000, 0x200B)), " ", " ", " ", " ", "　", "﻿"]
)

#: §3.5's PAIR with one correction: the lookahead after the cross-section is
#: ``(?![0-9]|\.[0-9])`` instead of ``(?![0-9.])``, because the comma of
#: "NYY-J 5x16, 3x63A" is normalised to "." and the literal pattern would then
#: find no pair at all (a decimal like "5x16.5" is still never cut to 16).
_PAIR = re.compile(r"(?<![0-9.])([0-9]) *[xg] *([0-9]+(?:\.[0-9]+)?)(?![0-9]|\.[0-9])(?! *a\b)", re.ASCII)
_EXTRA = re.compile(r"^ *[/+] *[0-9]", re.ASCII)
_MM = re.compile(r"(?<![0-9.])([0-9]+(?:\.[0-9]+)?) *mm", re.ASCII)
_FUSE = re.compile(r"(?<![0-9.])([0-9]+) *a(?:mpere)?\b", re.ASCII)
_ALU = re.compile(r"\bna[a-z0-9]*y|\bna2x|\balu?(?:minium)?\b", re.ASCII)


def normalise_cable_text(text: Any) -> str:
    """Lower case, ``²``→2, ``×``/``*``→x, ``,``→., ``qmm``→mm, odd spaces → U+0020.

    Not a str → ``""`` (the parsers are lenient and never raise)."""
    if not isinstance(text, str):
        return ""
    out = text.lower()
    for old, new in _REPLACEMENTS:
        out = out.replace(old, new)
    return "".join(" " if char in _SPACES else char for char in out)


def _in_range(mm2: float) -> bool:
    return MIN_SECTION_MM2 <= mm2 <= MAX_SECTION_MM2


def _best_pair(text: str) -> re.Match[str] | None:
    """The first pair with the largest cross-section in range (left → right)."""
    best: re.Match[str] | None = None
    for match in _PAIR.finditer(text):
        mm2 = float(match.group(2))
        if _in_range(mm2) and (best is None or mm2 > float(best.group(2))):
            best = match
    return best


def _pair_cores(text: str, match: re.Match[str]) -> int | None:
    """2..5 from the pair; "+16" / "/16" right after it adds the separate conductor.

    A pair whose own count is no cable's core count (1, 6..9) stays ``None``:
    the extra conductor then has nothing to add to."""
    count = int(match.group(1))
    if not 2 <= count <= _MAX_CORES:
        return None
    if _EXTRA.match(text[match.end():]):
        return min(count + 1, _MAX_CORES)
    return count


def _first_mm(text: str) -> float | None:
    for match in _MM.finditer(text):
        mm2 = float(match.group(1))
        if _in_range(mm2):
            return mm2
    return None


def parse_cable_section(text: Any) -> dict[str, Any]:
    """``{"mm2": float | None, "cores": int | None, "aluminium": bool}`` (§3.5)."""
    normalised = normalise_cable_text(text)
    aluminium = _ALU.search(normalised) is not None
    pair = _best_pair(normalised)
    if pair is not None:
        return {"mm2": float(pair.group(2)), "cores": _pair_cores(normalised, pair), "aluminium": aluminium}
    return {"mm2": _first_mm(normalised), "cores": None, "aluminium": aluminium}


def parse_fuse_amps(text: Any) -> int | None:
    """The largest ampere figure in the text ("NH00 100A" → 100), else ``None``."""
    best: int | None = None
    for match in _FUSE.finditer(normalise_cable_text(text)):
        amps = int(match.group(1))
        if best is None or amps > best:
            best = amps
    return best
