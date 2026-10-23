"""Small invented boards for the terminal rules and suggestions (R2 §4).

Each one isolates one branch of the sequential suggestion pass (§4.2); the
fixture boards (``scripts/enclosure_fixture_boards.py``) cover the rest.
"""

from __future__ import annotations

from typing import Any

from scripts.write_enclosure_fixtures import document, fi, ls, ls_run, module, row


def full_field_zb32s() -> dict[str, Any]:
    """Every rail of field 0 holds a breaker, field 1 is empty of modules:
    the two reserved rows have nowhere to go."""
    rows = [row(f"row-{r}", f"F1 · Verteiler {r}", [ls(f"dev-{r}", f"F{r}", str(r), "Licht")]) for r in range(1, 8)]
    return document("ZB32S", [module("mod-a", "ZU37KS", 0, {f"r{r}": f"row-{r}" for r in range(1, 8)})], rows)


def still_short_zb32s() -> dict[str, Any]:
    """A breaker on r1 of a field whose five 71.5 mm Leisten overflow anyway:
    vacating r1 still leaves X5 without place."""
    groups = [
        row(f"row-o{rail}", f"F1 · Verteiler {rail}",
            [fi(f"dev-f{group}", f"F{group}", te=2), *ls_run(f"f{group}", f"F{group}", range(1, 11), 1 + (group - 1) * 10)])
        for group, rail in enumerate(range(3, 8), start=1)
    ]
    rows = [row("row-o1", "F1 · Verteiler 1", [ls("dev-r1", "F0.1", "90", "Außenlicht")]), *groups]
    return document("ZB32S", [
        module("mod-o", "ZU37KS", 0, {"r1": "row-o1", **{f"r{r}": f"row-o{r}" for r in range(3, 8)}}),
        module("mod-e", "ZU37KS", 1, {}),
    ], rows)


def supply_overflow_zb32s() -> dict[str, Any]:
    """41 breakers with terminals before any protective device: one supply
    Leiste of 213.2 mm that fits neither rail and has no head to move."""
    breakers = ls_run("s", "F0", range(1, 42), 1)
    rows = [row(f"row-s{rail}", f"F1 · Verteiler {rail}", breakers[start:start + 12])
            for rail, start in zip(range(3, 7), range(0, 48, 12))]
    return document("ZB32S", [
        module("mod-s", "ZU37KS", 0, {f"r{rail}": f"row-s{rail}" for rail in range(3, 7)}),
        module("mod-e", "ZU37KS", 1, {}),
    ], rows)


def elsewhere_first_zb53s() -> dict[str, Any]:
    """A meter field's VF group (133.9 mm, placed in field 1 by R6) and five
    76.7 mm Leisten in a ZU59KS, stored in an order that leaves the VF strip
    and F6 without place. Only F6 may be moved (R6 strips are skipped), and
    its FI + 11 LS need two rails of the empty ZU59KS in field 2."""
    order = {"0": {"strips": ["dev-f2:leiste", "dev-f3:leiste", "dev-f4:leiste", "dev-f5:leiste", "dev-f1:leiste",
                              "dev-f6:leiste"]}}
    groups = [
        row(f"row-d{rail}", f"F2 · Verteiler {rail}",
            [fi(f"dev-f{group}", f"F{group}", te=2), *ls_run(f"f{group}", f"F{group}", range(1, 12), 23 + (group - 2) * 11)])
        for group, rail in zip(range(2, 7), range(3, 8))
    ]
    rows = [
        row("row-vf1", "F1 · Verteilerfeld 1", [fi("dev-f1", "F1", te=2), *ls_run("f1", "F1", range(1, 11), 1)]),
        row("row-vf2", "F1 · Verteilerfeld 2", ls_run("f1", "F1", range(11, 23), 11)),
        *groups,
    ]
    return document("ZB53S", [
        module("mod-m", "ZH5EL27", 0, {"vf1": "row-vf1", "vf2": "row-vf2"}),
        module("mod-d", "ZU59KS", 1, {f"r{rail}": f"row-d{rail}" for rail in range(3, 8)}, terminal_order=order),
        module("mod-x", "ZU59KS", 2, {}),
    ], rows)


def _vt_field(name: str, field: int, *, reserved: tuple[int, ...], full: tuple[int, ...],
              empty_rows: tuple[int, ...] = ()) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """A ZU37KS whose rails in ``reserved`` and ``full`` hold one breaker each
    (no terminals) and whose rails in ``empty_rows`` carry a row without devices."""
    rails = {f"r{r}": f"row-{name}{r}" for r in (*reserved, *full, *empty_rows)}
    rows = [row(f"row-{name}{r}", f"F{field + 1} · Verteiler {r}", [ls(f"dev-{name}{r}", f"F{field}.{r}", "", "Licht")])
            for r in (*reserved, *full)]
    rows += [row(f"row-{name}{r}", f"F{field + 1} · Verteiler {r}", []) for r in empty_rows]
    return module(f"mod-{name}", "ZU37KS", field, rails), rows


def scattered_vacate_zb33s() -> dict[str, Any]:
    """Field 0's r1 and r2 hold a breaker each; fields 1 and 2 have one free
    rail apiece (r7; field 2's carries an empty row). No single field takes
    both rows, so each row gets the nearest free rail on its own."""
    parts = [_vt_field("a", 0, reserved=(1, 2), full=(3, 4, 5, 6, 7)),
             _vt_field("b", 1, reserved=(), full=(3, 4, 5, 6)),
             _vt_field("c", 2, reserved=(), full=(3, 4, 5, 6), empty_rows=(7,))]
    return document("ZB33S", [m for m, _ in parts], [r for _, rows in parts for r in rows])


def half_vacate_zb32s() -> dict[str, Any]:
    """Field 0's r1 and r2 hold a breaker each and field 1 has a single free
    rail: r1's row gets it, r2's row has nowhere to go."""
    parts = [_vt_field("a", 0, reserved=(1, 2), full=(3, 4, 5, 6, 7)),
             _vt_field("b", 1, reserved=(), full=(3, 4, 5, 6))]
    return document("ZB32S", [m for m, _ in parts], [r for _, rows in parts for r in rows])


def two_vacates_zb33s() -> dict[str, Any]:
    """Fields 0 and 1 each hold a breaker on r1 and a full r3–r7; field 2 is
    an empty ZU37KS. Both vacates look there and must not name the same rail."""
    modules, rows = [], []
    for field, name in ((0, "a"), (1, "b")):
        rails = {f"r{r}": f"row-{name}{r}" for r in (1, 3, 4, 5, 6, 7)}
        modules.append(module(f"mod-{name}", "ZU37KS", field, rails))
        rows += [row(f"row-{name}{r}", f"F{field + 1} · Verteiler {r}", [ls(f"dev-{name}{r}", f"F{r}", "", "Licht")])
                 for r in (1, 3, 4, 5, 6, 7)]
    modules.append(module("mod-c", "ZU37KS", 2, {}))
    return document("ZB33S", modules, rows)


def _block(device_id: str, bmk: str, circuit: str) -> dict[str, Any]:
    return ls(device_id, bmk, circuit, "Durchlauferhitzer", rating="B20", poles=3, te=3, terminal_block=True)


def lost_place_zb32s() -> dict[str, Any]:
    """Field 0 stores an order that puts F1's two Blocks first, so F1's Leiste
    (FI + 14 LS) and F3's have no place. The only other field takes F1's
    group on its two empty rails, but then holds F1's Leiste and one Block
    only, and the other Block, placed before, loses its place: the move is
    refused (§4.2 step 3). Twin of the web's ``lostPlaceZb32s``."""
    g = ls_run("g", "F1", range(1, 15), 1)
    a = ls_run("a", "F2", range(1, 11), 20)
    b = ls_run("b", "F3", range(1, 11), 30)
    m = ls_run("m", "F4", range(1, 27), 40)
    rows = [
        row("row-f3", "F1 · Verteiler 3", [_block("dev-s1", "F0.1", "91"), _block("dev-s2", "F0.2", "92"),
                                          _block("dev-s3", "F0.3", "93"), fi("dev-g", "F1", te=2)]),
        row("row-f4", "F1 · Verteiler 4", [_block("dev-g-b1", "F1.15", "15"), _block("dev-g-b2", "F1.16", "16"), *g[:6]]),
        row("row-f5", "F1 · Verteiler 5", [*g[6:], fi("dev-a", "F2", te=2), *a[:2]]),
        row("row-f6", "F1 · Verteiler 6", [*a[2:], fi("dev-b", "F3", te=2), *b[:2]]),
        row("row-f7", "F1 · Verteiler 7", b[2:]),
        row("row-m3", "F2 · Verteiler 3", [fi("dev-m", "F4", te=2), *m[:10]]),
        row("row-m4", "F2 · Verteiler 4", m[10:22]),
        row("row-m5", "F2 · Verteiler 5", m[22:]),
    ]
    order = {"0": {"strips": ["dev-g-b1:block", "dev-g-b2:block", "dev-s1:block", "dev-s2:block", "dev-s3:block",
                              "dev-g:leiste", "dev-a:leiste", "dev-b:leiste"]}}
    return document("ZB32S", [
        module("mod-f", "ZU37KS", 0, {f"r{r}": f"row-f{r}" for r in range(3, 8)}, terminal_order=order),
        module("mod-m", "ZU37KS", 1, {f"r{r}": f"row-m{r}" for r in range(3, 6)}),
    ], rows)


def spill_zb53s() -> dict[str, Any]:
    """F5's run spills over the field line: field 0's r8 holds FI F5 and ten
    LS, and the first two LS on field 1's r3 still follow F5 by position.
    F4 (21 LS over r6 and r7) leaves X5 without place in field 0. Moving F5
    with its ten field-0 circuits onto field 1's free r4 leaves the two
    spilled LS behind F4 by position; the real op pins them back to F5
    (C§2.4), so the virtual move must as well — unpinned, X4 would grow and
    lose its place, and the pass would refuse a move that places every
    strip. Twin of the web's ``spillZb53s`` (which uses the ZU59RK)."""
    rows = [
        row("row-a3", "F1 · Verteiler 3", [fi("dev-f1", "F1", te=2), *ls_run("f1", "F1", range(1, 11), 1)]),
        row("row-a4", "F1 · Verteiler 4", [fi("dev-f2", "F2", te=2), *ls_run("f2", "F2", range(1, 11), 11)]),
        row("row-a5", "F1 · Verteiler 5", [fi("dev-f3", "F3", te=2), *ls_run("f3", "F3", range(1, 11), 21)]),
        row("row-a6", "F1 · Verteiler 6", [fi("dev-f4", "F4", te=2), *ls_run("f4", "F4", range(1, 11), 31)]),
        row("row-a7", "F1 · Verteiler 7", ls_run("f4", "F4", range(11, 22), 41)),
        row("row-a8", "F1 · Verteiler 8", [fi("dev-f5", "F5", te=2), *ls_run("f5", "F5", range(1, 11), 61)]),
        row("row-b3", "F2 · Verteiler 3",
            [*ls_run("f5", "F5", range(11, 13), 71), fi("dev-f6", "F6", te=2), *ls_run("f6", "F6", range(1, 9), 81)]),
    ]
    return document("ZB53S", [
        module("mod-a", "ZU59KS", 0, {f"r{r}": f"row-a{r}" for r in range(3, 9)}),
        module("mod-b", "ZU59KS", 1, {"r3": "row-b3"}),
    ], rows)


def run_over_r2_zb32s() -> dict[str, Any]:
    """FI F1's run starts on the reserved r2 and continues on r3, ahead of F2.
    Vacating r2 onto the free r4 puts F1.5 and F1.6 first in the reading
    order, before any head: the real op pins them back to F1 (C§2.4), and so
    must the virtual relink the vacate's sentence is computed on. Twin of the
    web's ``runOverR2Zb32s``."""
    rows = [
        row("row-a2", "F1 · Verteiler 2", [fi("dev-f1", "F1", te=2), *ls_run("f1", "F1", range(1, 5), 1)]),
        row("row-a3", "F1 · Verteiler 3",
            [*ls_run("f1", "F1", range(5, 7), 5), fi("dev-f2", "F2", te=2), *ls_run("f2", "F2", range(1, 4), 7)]),
    ]
    return document("ZB32S", [module("mod-a", "ZU37KS", 0, {"r2": "row-a2", "r3": "row-a3"})], rows)
