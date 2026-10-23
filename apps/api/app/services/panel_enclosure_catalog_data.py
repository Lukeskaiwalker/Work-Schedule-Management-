"""The built-in Hager univers Z catalogue (docs/PANEL_ENCLOSURE.md §3.2). Data only.

Every fact here came from Hager's catalogue pages, datasheets and the
"Hager Tipp 44" note on VDE-AR-N 4100:2026-04, read on 2026-10-21. What could
not be read off a page is an assumption, and every assumption is written
into the entry's ``unverified`` list (or a fitting's ``note``) and the entry
ships ``verified: False``, so the planner shows it as "ungeprüft" until the
Werkstatt has measured a real cabinet (owner, 2026-10-21). The biggest one:
the order of the zones inside a meter field (AAR on top, RfZ, meter, NAR at
the bottom) is arithmetic on Tipp 44, not a drawing.

Rules for changing this file (§3.5): codes, rail keys and fitting keys are
never removed or renamed — set ``retired`` instead — and size, family and
meter places of a shipped code stay as they are while boards use it.
``tests/fixtures/enclosure_catalog_shipped.json`` records every code ever
shipped and fails the build otherwise. Positions, labels, article numbers
and the ``unverified`` notes are corrections and may change freely.

No prices and no EANs: they go stale, and the Werkstatt's articles carry them.
"""

from __future__ import annotations

from typing import Any

_GRID_1050 = 7  # 1050 mm usable field height / 150 mm raster
_GRID_1350 = 9

# ── Cabinets ─────────────────────────────────────────────────────────────────


def _cabinet(
    code: str, height: int, width: int, fields: int, leaves: int, source_url: str, *, unverified: tuple[str, ...] = ()
) -> dict[str, Any]:
    units = _GRID_1050 if height == 1100 else _GRID_1350
    return {
        "code": code,
        "article_no": code,
        "name": f"Zählerschrank univers Z, {height} × {width} × 205 mm, IP44, {fields} Felder",
        "height_mm": height,
        "width_mm": width,
        "depth_mm": 205,
        "fields": fields,
        "door_leaves": leaves,
        "units_per_field": units,
        "mounting": "surface",
        "ip": "IP44",
        "door": "Klappgriff mit Vorreiber",
        # "verified" covers dimensions and PLE; the door leaves stay assumed.
        "verified": not unverified,
        "unverified": [
            *unverified,
            "Raster 150 mm / 12 PLE laut ZU59XS-Datenblatt (125 mm nicht ausgeschlossen)",
            "Innenrand 25 mm aus dem Außenmaß abgeleitet",
            f"Türflügel ({leaves}) angenommen",
            "Leerschrank angenommen: Feldeinbausätze werden einzeln bestellt",
        ],
        "source_url": source_url,
    }


_HAGER_ASSET = "https://assets.hager.com/step-content/P/{pds}/Document/std.lang.all/{code}_0101_de-DE.pdf"


def _catalog_page(code: str) -> str:
    return f"https://hager.com/de/katalog/?artnr={code}"


BUILTIN_ENCLOSURES: list[dict[str, Any]] = [
    _cabinet("ZB32S", 1100, 550, 2, 1, _catalog_page("ZB32S")),
    _cabinet("ZB33S", 1100, 800, 3, 2, _HAGER_ASSET.format(pds="PDS_722931070101DE", code="ZB33S")),
    _cabinet("ZB34S", 1100, 1050, 4, 2, _catalog_page("ZB34S")),
    _cabinet("ZB35S", 1100, 1300, 5, 2, _HAGER_ASSET.format(pds="PDS_722934530101DE", code="ZB35S")),
    _cabinet("ZB52S", 1400, 550, 2, 1, _catalog_page("ZB52S")),
    _cabinet(
        "ZB53S", 1400, 800, 3, 2, _HAGER_ASSET.format(pds="PDS_161099640101DE", code="ZB53S"),
        unverified=("Seite nicht geöffnet; Werte aus Suchzusammenfassung, 27 Reihen abgeleitet",),
    ),
    _cabinet("ZB54S", 1400, 1050, 4, 2, _catalog_page("ZB54S")),
    _cabinet("ZB55S", 1400, 1300, 5, 2, _catalog_page("ZB55S")),
]


# ── Zones and rails ──────────────────────────────────────────────────────────


def _rail(key: str, unit: int = 0, *, ple: int = 12, mount: str = "rail") -> dict[str, Any]:
    return {"key": key, "unit": unit, "ple": ple, "mount": mount}


def _numbered(prefix: str, count: int) -> list[dict[str, Any]]:
    """r1 … rN, one per 150 mm unit from the top of the zone."""
    return [_rail(f"{prefix}{index + 1}", index) for index in range(count)]


def _zone(key: str, kind: str, unit: int, units: int, rails: list[dict[str, Any]] | None = None, **extra: Any) -> dict[str, Any]:
    return {"key": key, "type": kind, "unit": unit, "units": units, "rails": rails or [], **extra}


def _aar(unit: int) -> dict[str, Any]:
    return _zone("aar", "AAR", unit, 2, _numbered("aar", 2))


def _rfz(unit: int) -> dict[str, Any]:
    return _zone("rfz", "RFZ", unit, 1, [_rail("rfz")], sealable=True)


def _nar(unit: int) -> dict[str, Any]:
    return _zone("nar", "NAR", unit, 2, [_rail("nar", mount="busbar")], sealable=True)


def _meter_zone(unit: int, units: int, places: int, meter_type: str) -> dict[str, Any]:
    return _zone("zf", "ZF", unit, units, meter_places=places, meter_type=meter_type, sealable=True)


def _sas(unit: int) -> dict[str, Any]:
    return _zone("sas", "SAS", unit, 2, [_rail("sas", mount="busbar")], sealable=True)


def _apz(unit: int) -> dict[str, Any]:
    return _zone("apz", "APZ", unit, 2, [_rail("apz", ple=6)], sealable=True)


def _ehz_1050(places: int) -> list[dict[str, Any]]:
    return [_aar(0), _rfz(2), _meter_zone(3, 2, places, "ehz"), _nar(5)]


def _ehz_1350(places: int) -> list[dict[str, Any]]:
    return [_zone("vf", "VF", 0, 2, _numbered("vf", 2)), _aar(2), _rfz(4), _meter_zone(5, 2, places, "ehz"), _nar(7)]


# ── Fittings ─────────────────────────────────────────────────────────────────


def _part(
    key: str, label: str, article_no: str | None = None, *, verified: bool = True, note: str = ""
) -> dict[str, Any]:
    """A fitting with no device of its own: fixed in the field kit."""
    return {
        "key": key, "label": label, "article_no": article_no, "removable": False, "device": None,
        "verified": verified, "note": note,
    }


def _device_part(key: str, label: str, kind: str, rail: str, te: int, poles: int, note: str) -> dict[str, Any]:
    """A pre-fitted device (D5): drawn on its rail, removable by deleting it."""
    return {
        "key": key, "label": label, "article_no": None, "removable": True,
        "device": {"kind": kind, "rail": rail, "te": te, "poles": poles, "rating": ""},
        "verified": False, "note": note,
    }


_NAR_BUSBAR = _part("busbar", "Sammelschiene 5-polig 12×5 mm (NAR)")
_SAS_BUSBAR = _part("busbar", "Sammelschiene 5-polig 12×5 mm (Sammelschienenzone)")
_BKE = _part("bke", "BKE-I Zählerplatz")
_PE_N = _part("pe_n", "PE/N-Klemmen waagerecht")
_RJ45 = _part("rj45", "RJ45-Buchse ZZ45WAN2PP", "ZZ45WAN2PP")
# The RK fields ship their rails insulated (docs/PANEL_ENCLOSURE_R2.md §2.2,
# §10). Only the set count is unverified, so the caveat stays on the fitting
# and the module itself keeps its own ``verified``.
_U84T = _part(
    "u84t", "Hutschienen-Isolierung U84T (ab Werk)", "U84T", verified=False,
    note="Lieferform RK: U84T statt PE/N-Klemmblöcken (Hager-Flyer 21DE0246); "
         "Anzahl der Sätze ab Werk nicht angegeben (Foto: 1 Satz ZU37RK, 2 Sätze ZU59RK)",
)


def _hlak(note: str) -> dict[str, Any]:
    return _device_part("hlak", "Hauptleitungsabzweigklemme", "hlak", "aar2", 4, 3, note)


_EHZ_COVER = {"article_no": "KU40XXE", "label": "Blindabdeckung freier eHZ-Zählerplatz", "qty": 1, "verified": False}
_3P_COVER = {"article_no": "T95L", "label": "Blindabdeckung freier 3-Punkt-Zählerplatz", "qty": 1, "verified": False}

# ── Assumptions, one sentence each (the finding quotes the first) ────────────

_STACK_EHZ_1050 = "Feldaufbau (AAR oben, RfZ, eHZ, NAR unten) aus Hager Tipp 44 abgeleitet"
_STACK_EHZ_1350 = "Feldaufbau (VF oben, AAR, RfZ, eHZ, NAR unten) aus Hager Tipp 44 abgeleitet"
_STACK_3P_1050 = "Feldaufbau (AAR oben, 3-Punkt-Zählerfeld, NAR unten) aus Hager Tipp 44 abgeleitet"
_STACK_3P_1350 = "Feldaufbau (AAR oben, 3-Punkt-Doppelstock, NAR unten) aus Hager Tipp 44 abgeleitet"
_NO_WIRING = "Feldverdrahtung (mm²) nicht angegeben"
_SAS_POSITION = "Lage der Sammelschienenzone aus Rechnung abgeleitet"
_SAS_SEALED = "Sammelschienenzone als plombierbar angenommen"
_COVER_ONLY = "als Füllung ohne Einbausatz angenommen"
_APZ_LIKE_VT5 = "APZ-Höhe wie ZU37VT5APZ2 angenommen"
_APZ_LIKE_VT7 = "APZ-Höhe wie ZU59VT7APZ2 angenommen"


def _module(
    code: str,
    family: str,
    name: str,
    field_height: int | None,
    zones: list[dict[str, Any]],
    *,
    fittings: tuple[dict[str, Any], ...] = (),
    wiring: int | None = None,
    unverified: tuple[str, ...] = (),
) -> dict[str, Any]:
    height_units = {1050: _GRID_1050, 1350: _GRID_1350}.get(field_height or 0) or sum(z["units"] for z in zones)
    cover = {"meter_ehz": _EHZ_COVER, "meter_3p": _3P_COVER}.get(family)
    return {
        "code": code,
        "article_no": code,
        "name": name,
        "family": family,
        "field_height_mm": field_height,
        "width_fields": 1,
        "height_units": height_units,
        "wiring_mm2": wiring,
        "zones": zones,
        "fittings": list(fittings),
        "accessories": [],
        "free_place_cover": dict(cover) if cover else None,
        "verified": not unverified,
        "unverified": list(unverified),
        "source_url": _catalog_page(code),
    }


def _ehz(code: str, name: str, field_height: int, places: int, *, wiring: int | None = None,
         extra: tuple[dict[str, Any], ...] = (), unverified: tuple[str, ...] = ()) -> dict[str, Any]:
    stack = _STACK_EHZ_1050 if field_height == 1050 else _STACK_EHZ_1350
    zones = _ehz_1050(places) if field_height == 1050 else _ehz_1350(places)
    notes = (stack, *unverified, *(() if wiring else (_NO_WIRING,)))
    return _module(code, "meter_ehz", name, field_height, zones,
                   fittings=(_NAR_BUSBAR, _BKE, *extra), wiring=wiring, unverified=notes)


def _three_point(code: str, name: str, field_height: int, *, wiring: int | None = None,
                 extra: tuple[dict[str, Any], ...] = (), unverified: tuple[str, ...] = ()) -> dict[str, Any]:
    if field_height == 1050:
        stack, zones = _STACK_3P_1050, [_aar(0), _meter_zone(2, 3, 1, "3punkt"), _nar(5)]
    else:
        stack, zones = _STACK_3P_1350, [_aar(0), _meter_zone(2, 5, 2, "3punkt"), _nar(7)]
    notes = (stack, *unverified, *(() if wiring else (_NO_WIRING,)))
    return _module(code, "meter_3p", name, field_height, zones,
                   fittings=(_NAR_BUSBAR, *extra), wiring=wiring, unverified=notes)


def _distribution(code: str, name: str, field_height: int, rows: int, fittings: tuple[dict[str, Any], ...]) -> dict[str, Any]:
    return _module(code, "distribution", name, field_height, [_zone("vt", "VT", 0, rows, _numbered("r", rows))],
                   fittings=fittings)


def _with_apz(code: str, name: str, field_height: int, rows: int, *,
              fittings: tuple[dict[str, Any], ...] = (_RJ45,), unverified: tuple[str, ...] = ()) -> dict[str, Any]:
    zones = [_zone("vt", "VT", 0, rows, _numbered("r", rows)), _apz(rows)]
    return _module(code, "distribution_apz", name, field_height, zones, fittings=fittings, unverified=unverified)


def _with_busbars(code: str, name: str, field_height: int, rows: int, *,
                  fittings: tuple[dict[str, Any], ...] = (_SAS_BUSBAR, _PE_N)) -> dict[str, Any]:
    zones = [_sas(0), _zone("vt", "VT", 2, rows, _numbered("r", rows))]
    return _module(code, "busbar", name, field_height, zones, fittings=fittings,
                   unverified=(_SAS_POSITION, _SAS_SEALED))


def _communication(code: str, name: str, field_height: int, rfz: int) -> dict[str, Any]:
    zones = [_apz(0), _zone("rfz", "RFZ", 2, rfz, _numbered("rfz", rfz), sealable=True), _sas(2 + rfz)]
    return _module(code, "communication", name, field_height, zones, fittings=(_SAS_BUSBAR,),
                   unverified=(_SAS_POSITION, _SAS_SEALED))


def _cover(code: str, units: int) -> dict[str, Any]:
    return _module(code, "cover", f"Abdeckung {units * 150} × 250 mm, geschlossen", None,
                   [_zone("cover", "COVER", 0, units)], unverified=(_COVER_ONLY,))


BUILTIN_MODULES: list[dict[str, Any]] = [
    _ehz("ZH3EL27", "Komplettfeld eHZ, 1 Zählerplatz, 10 mm², 1050 mm", 1050, 1, wiring=10),
    _ehz("ZH3EL22", "Komplettfeld eHZ, 2 Zählerplätze, 1050 mm", 1050, 2),
    _ehz(
        "ZH3EL16", "Komplettfeld eHZ, 1 Zählerplatz, 16 mm², HLAK, 1050 mm", 1050, 1, wiring=16,
        extra=(_hlak("3-polig laut Hager; 4 PLE Breite angenommen"),),
        unverified=("HLAK 4 PLE breit angenommen",),
    ),
    _ehz(
        "ZH3EH16", "Komplettfeld eHZ, 1 Zählerplatz, Hauptschalter, HLAK, 1050 mm", 1050, 1,
        extra=(
            _device_part("hs", "Hauptschalter", "hauptschalter", "aar1", 3, 3, "Typ und Bemessungsstrom nennt Hager nicht"),
            _hlak("3-polig wie ZH3EL16 angenommen"),
        ),
        unverified=("Hauptschalter: Typ/Bemessungsstrom unbekannt", "HLAK 3-polig und 4 PLE breit angenommen"),
    ),
    _three_point("ZH33X7", "Komplettfeld 3-Punkt, 1 Zählerplatz, 1050 mm", 1050),
    _three_point(
        "ZH31X7NT", "Komplettfeld 3-Punkt, 1 Zählerplatz, mit Trennfunktion, 10 mm², 1050 mm", 1050, wiring=10,
        extra=(_device_part("trenn", "Trennvorrichtung", "hauptschalter", "aar1", 3, 3,
                            "Trennvorrichtung von Hager nicht benannt"),),
        unverified=("Trennvorrichtung von Hager nicht benannt — als Hauptschalter im AAR angenommen",),
    ),
    _distribution("ZU37KS", "Verteilerfeld, 7 Reihen, PE/N-Klemmen waagerecht, 1050 mm", 1050, 7, (_PE_N,)),
    _distribution("ZU37RK", "Verteilerfeld, 7 Reihen, für Reihenklemmen, 1050 mm", 1050, 7, (_U84T,)),
    _with_apz("ZU37VT5APZ2", "Verteilerfeld, 5 Reihen, APZ 300 mm unten, 1050 mm", 1050, 5),
    _module(
        "ZU37VT4APZ2", "distribution_apz", "Verteilerfeld, 4 Reihen, RfZ, APZ 300 mm, 1050 mm", 1050,
        [_zone("vt", "VT", 0, 4, _numbered("r", 4)), _rfz(4), _apz(5)],
        fittings=(_RJ45,), unverified=("Reihenfolge VT / RfZ / APZ nicht geprüft",),
    ),
    _with_busbars("ZH3ES5", "Verteilerfeld mit Sammelschienen, 5 Reihen, 1050 mm", 1050, 5),
    _communication("ZH33SAR2", "Kommunikationsfeld: APZ oben, 3 × RfZ, Sammelschienen, 1050 mm", 1050, 3),
    _ehz("ZH5EL27", "Komplettfeld eHZ, 1 Zählerplatz, Verteilerfeld 2 Reihen, 1350 mm", 1350, 1),
    _ehz("ZH5EL22", "Komplettfeld eHZ, 2 Zählerplätze, Verteilerfeld 2 Reihen, 1350 mm", 1350, 2),
    _ehz(
        "ZH5EL16", "Komplettfeld eHZ, 1 Zählerplatz, 16 mm², HLAK, 1350 mm", 1350, 1, wiring=16,
        extra=(_hlak("aus ZH3EL16 übertragen (3-polig, 4 PLE)"),),
        unverified=("HLAK aus ZH3EL16 übertragen",),
    ),
    _three_point("ZH53X3", "Komplettfeld 3-Punkt, 2 Zählerplätze (Doppelstock), 1350 mm", 1350),
    _distribution("ZU59KS", "Verteilerfeld, 9 Reihen, PE/N-Klemmen waagerecht, 1350 mm", 1350, 9, (_PE_N,)),
    _distribution("ZU59RK", "Verteilerfeld, 9 Reihen, für Reihenklemmen, 1350 mm", 1350, 9, (_U84T,)),
    _with_apz("ZU59VT7APZ2", "Verteilerfeld, 7 Reihen, APZ 300 mm unten, 1350 mm", 1350, 7),
    _with_busbars("ZH53XS", "Verteilerfeld mit Sammelschienen, 7 Reihen, 1350 mm", 1350, 7),
    _communication("ZH55SAR2", "Kommunikationsfeld: APZ oben, 5 × RfZ, Sammelschienen, 1350 mm", 1350, 5),
    _module("ZY150RFZ", "communication", "RfZ-Montagefeld 150 × 250 mm mit Hutschiene", None, [_rfz(0)]),
    _cover("ZU62A", 1),
    _cover("ZU79A", 2),
    _cover("ZU93A", 3),
    # Round 2 (docs/PANEL_ENCLOSURE_R2.md §10, R15): the RK siblings of the
    # APZ and busbar fields. Rows, height, "APZ unten", "mit SaS 12x5mm" and
    # "ohne QC-Klemmen" are on the hager.com catalogue pages (2026-10-22),
    # which mark all four "Auslaufprodukt". No RJ45 socket is named there, so
    # none is listed (fitting keys are append-only; leaving it out is the
    # reversible choice). Appended: codes and keys never move (§3.5).
    _with_apz("ZU37V5RKAPZ2", "Verteilerfeld, 5 Reihen, für Reihenklemmen, APZ unten, 1050 mm", 1050, 5,
              fittings=(_U84T,), unverified=(_APZ_LIKE_VT5,)),
    _with_apz("ZU59V7RKAPZ2", "Verteilerfeld, 7 Reihen, für Reihenklemmen, APZ unten, 1350 mm", 1350, 7,
              fittings=(_U84T,), unverified=(_APZ_LIKE_VT7,)),
    _with_busbars("ZH3ES5RK", "Verteilerfeld mit Sammelschienen, 5 Reihen, für Reihenklemmen, 1050 mm", 1050, 5,
                  fittings=(_SAS_BUSBAR, _U84T)),
    _with_busbars("ZH53XSRK", "Verteilerfeld mit Sammelschienen, 7 Reihen, für Reihenklemmen, 1350 mm", 1350, 7,
                  fittings=(_SAS_BUSBAR, _U84T)),
]
