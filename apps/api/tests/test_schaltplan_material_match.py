"""Matching Materialliste lines to shelf articles (docs/PANEL_ENCLOSURE_R2.md §5.2).

The matching moved out of ``schaltplan_material`` into its own module (the
800-line cap) and stays importable from where it was. Round 2 adds the EAN
step: mapping, then EAN, then article number (supplier number, then whole
token in the name). An EAN names at most one article (partial unique index);
archived and merged-away articles never match. Every name here is invented.
"""

from __future__ import annotations

from app.core.db import SessionLocal
from app.models.entities import WerkstattArticle
from app.services import schaltplan_material, schaltplan_material_match
from app.services.schaltplan_material import PlannedLine
from app.services.schaltplan_material_match import match_articles_by_ean, resolve_line_articles
from tests.panel_enclosure_helpers import article

EAN = "4010330552465"
U84T = "accessory:U84T"


def _u84t_line() -> PlannedLine:
    return PlannedLine(U84T, "enclosure", "Isolierstück", "Hager U84T", 2)


def test_the_matching_is_still_importable_from_the_materialliste() -> None:
    for name in ("explicit_mappings", "auto_match_part", "resolve_line_articles"):
        assert getattr(schaltplan_material, name) is getattr(schaltplan_material_match, name), name


def test_an_ean_names_its_live_article_and_archived_or_merged_ones_never() -> None:
    live = article("Isolierstück (Testartikel)", ean=EAN)
    archived = article("Altes Isolierstück (Testartikel)", ean="4010330000017")
    target = article("Zusammengeführt (Testartikel)")
    merged = article("Doppelt angelegt (Testartikel)", ean="4010330000024")
    with SessionLocal() as db:
        db.get(WerkstattArticle, archived).is_archived = True
        db.get(WerkstattArticle, merged).merged_into_id = target
        db.commit()
        found = match_articles_by_ean(db, [EAN, " 4010330000017 ", "4010330000024", "", "0000000000000"])
        assert {ean: row.id for ean, row in found.items()} == {EAN: live}
        assert match_articles_by_ean(db, []) == {}


def test_the_order_is_mapping_then_ean_then_number() -> None:
    by_number = article("Hager U84T Isolierstück (Testartikel)")
    by_ean = article("Isolierstück Satz (Testartikel)", ean=EAN)
    with SessionLocal() as db:
        line = _u84t_line()
        numbers = {U84T: "U84T"}
        assert resolve_line_articles(db, [line], numbers)[U84T][0].id == by_number
        hit = resolve_line_articles(db, [line], numbers, {U84T: EAN})[U84T]
        assert (hit[0].id, hit[1]) == (by_ean, "auto")
        schaltplan_material.set_mapping(db, key=U84T, article=db.get(WerkstattArticle, by_number), user_id=None)
        hit = resolve_line_articles(db, [line], numbers, {U84T: EAN})[U84T]
        assert (hit[0].id, hit[1]) == (by_number, "mapping")
        # An EAN for a key that is no line of the list is never looked up.
        assert resolve_line_articles(db, [], numbers, {U84T: EAN}) == {}
