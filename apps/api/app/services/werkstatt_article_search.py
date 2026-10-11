"""Free-text search over stocked articles, and the identifier key it shares
with the scan cascade.

``GET /werkstatt/articles?q=`` feeds the Bestand page, the phone search and
the order picker. It used to match one contiguous ``LIKE`` against name,
SP-number, EAN and manufacturer, and nothing else — so the one number a
wholesaler prints on the box, which lives only on the article↔supplier link,
could never be found by typing it. That is the owner's "sometimes I cannot find
an item by its supplier part number".

What a hit means now:

* **Tokens.** The query is split on whitespace and EVERY token has to appear
  in SOME field: name, SP-number, EAN, our printed code, manufacturer,
  category, Lagerort, or the number of ANY supplier link. "Wago 26190" finds
  the WAGO clamp whose Unielektro number is 26190 although no single field
  holds both words.
* **Codes without punctuation.** A token, and the whole query, reduced to
  :func:`identifier_search_key` (case and the separators `` -./`` dropped), is
  also looked for inside the same reduction of the code columns — SP-number,
  EAN, our printed code and every supplier number. ``1234567`` finds
  ``1234-567``; ``s7740`` finds ``S-77.40``; ``Wago 26190`` finds the WAGO
  clamp whose number is stored as ``26-190``. The whole-query form is what
  still matches when the person typed a space where the label has none.
* **Exact codes first.** A row whose code equals the query (by that key) sorts
  ahead of the alphabet, because the phone asks for ten rows and a longer
  number containing the typed one must not push the exact one off the end.

Deliberately portable: the test suite runs on SQLite (``create_all``, no
migrations, no extensions), production on PostgreSQL. Only ``lower``,
``replace`` and ``LIKE`` are used, which both speak identically — the same
reasoning as ``search_matching.phone_column_key``.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence

from sqlalchemy import ColumnElement, Select, and_, case, func, or_, select
from sqlalchemy.orm import Session

from app.models.entities import (
    WerkstattArticle,
    WerkstattArticleSupplier,
    WerkstattCategory,
    WerkstattLocation,
)
from app.services.search_matching import escape_like, term_variants, token_matches_any, tokenize

# What gets dropped from a code before comparing it: what people (and label
# printers) put BETWEEN the characters of an article number. One constant for
# Python and SQL, so the two reductions cannot disagree about a stored value.
IDENTIFIER_SEPARATORS = (" ", "-", ".", "/")

# Shorter than this, a reduced code is a fragment found inside nearly every
# number in the shop; the token match still covers such a query.
IDENTIFIER_MIN_LENGTH = 3

# The article's own columns a token may match.
_ARTICLE_TEXT_COLUMNS = (
    WerkstattArticle.item_name,
    WerkstattArticle.article_number,
    WerkstattArticle.ean,
    WerkstattArticle.internal_code,
    WerkstattArticle.manufacturer,
)

# The article's own columns that hold CODES, compared without punctuation.
_ARTICLE_CODE_COLUMNS = (
    WerkstattArticle.article_number,
    WerkstattArticle.ean,
    WerkstattArticle.internal_code,
)


def identifier_search_key(value: str | None) -> str:
    """Reduce a code for comparison: ``"UE-12/34 "`` -> ``"ue1234"``.

    ``lower`` rather than ``casefold`` because the SQL side can only
    ``lower``: the two halves of every comparison must fold the same way.
    """
    key = (value or "").strip().lower()
    for separator in IDENTIFIER_SEPARATORS:
        key = key.replace(separator, "")
    return key


def identifier_column_key(column: ColumnElement) -> ColumnElement:
    """:func:`identifier_search_key`, in SQL — nested ``replace`` on ``lower``."""
    expression: ColumnElement = func.lower(column)
    for separator in IDENTIFIER_SEPARATORS:
        expression = func.replace(expression, separator, "")
    return expression


def _linked_article_ids(condition: ColumnElement) -> Select:
    """Articles with at least one supplier link satisfying *condition*."""
    return select(WerkstattArticleSupplier.article_id).where(condition)


def _code_contains(key: str) -> ColumnElement:
    """Some code of the article, reduced, contains the reduced *key*."""
    needle = f"%{escape_like(key)}%"
    return or_(
        *[
            identifier_column_key(column).like(needle, escape="\\")
            for column in _ARTICLE_CODE_COLUMNS
        ],
        WerkstattArticle.id.in_(
            _linked_article_ids(
                identifier_column_key(WerkstattArticleSupplier.supplier_article_no).like(
                    needle, escape="\\"
                )
            )
        ),
    )


def _code_equals(key: str) -> ColumnElement:
    return or_(
        *[identifier_column_key(column) == key for column in _ARTICLE_CODE_COLUMNS],
        WerkstattArticle.id.in_(
            _linked_article_ids(
                identifier_column_key(WerkstattArticleSupplier.supplier_article_no) == key
            )
        ),
    )


def _token_matches(token: str, text_columns: Sequence[ColumnElement]) -> ColumnElement:
    """The token is in some field — as typed, or as a code without punctuation."""
    clauses = [
        token_matches_any(text_columns, token),
        WerkstattArticle.id.in_(
            _linked_article_ids(
                token_matches_any([WerkstattArticleSupplier.supplier_article_no], token)
            )
        ),
    ]
    token_key = identifier_search_key(token)
    if len(token_key) >= IDENTIFIER_MIN_LENGTH:
        clauses.append(_code_contains(token_key))
    return or_(*clauses)


def apply_article_query(stmt: Select, query: str) -> Select:
    """Narrow a ``select(WerkstattArticle)`` to the rows *query* names.

    Adds the category and Lagerort joins it needs, the WHERE and a leading
    ORDER BY (exact code first); the caller appends its own tie-break order and
    the LIMIT. A blank query returns *stmt* unchanged.
    """
    tokens = tokenize(query)
    if not tokens:
        return stmt
    stmt = stmt.outerjoin(
        WerkstattCategory, WerkstattCategory.id == WerkstattArticle.category_id
    ).outerjoin(WerkstattLocation, WerkstattLocation.id == WerkstattArticle.location_id)
    text_columns = [*_ARTICLE_TEXT_COLUMNS, WerkstattCategory.name, WerkstattLocation.name]
    every_token = and_(*[_token_matches(token, text_columns) for token in tokens])
    key = identifier_search_key(query)
    if len(key) < IDENTIFIER_MIN_LENGTH:
        return stmt.where(every_token)
    return stmt.where(or_(every_token, _code_contains(key))).order_by(
        case((_code_equals(key), 0), else_=1)
    )


# ──────────────────────────────────────────────────────────────────────────
# Which supplier number made a row a hit
# ──────────────────────────────────────────────────────────────────────────


def _token_in(token: str, *, text: str, codes: str) -> bool:
    """Python twin of :func:`_token_matches` for one already-loaded row.

    *text* is the casefolded fields, *codes* the reduced code fields.
    """
    if any(variant in text for variant in term_variants(token)):
        return True
    token_key = identifier_search_key(token)
    return len(token_key) >= IDENTIFIER_MIN_LENGTH and token_key in codes


def _number_explains_hit(
    number: str, *, tokens: Sequence[str], key: str, own_text: str, own_codes: str
) -> bool:
    """Whether *number* is why this row matched.

    Either the whole query is a code inside it, or it holds a token that the
    article's own fields do not — "Wago 26190" reports 26190 because no own
    field has it. A token the name already explains reports nothing, or a
    query like "Schalter 2" would decorate every row with a random number.
    """
    number_key = identifier_search_key(number)
    if len(key) >= IDENTIFIER_MIN_LENGTH and key in number_key:
        return True
    folded = number.casefold()
    return any(
        _token_in(token, text=folded, codes=number_key)
        and not _token_in(token, text=own_text, codes=own_codes)
        for token in tokens
    )


# NUL between fields so a token cannot match across two of them.
_FIELD_BREAK = "\x00"


def _own_text(
    article: WerkstattArticle, *, category_name: str | None, location_name: str | None
) -> str:
    values: Iterable[str | None] = (
        article.item_name,
        article.article_number,
        article.ean,
        article.internal_code,
        article.manufacturer,
        category_name,
        location_name,
    )
    return _FIELD_BREAK.join(value.casefold() for value in values if value)


def _own_codes(article: WerkstattArticle) -> str:
    values = (article.article_number, article.ean, article.internal_code)
    return _FIELD_BREAK.join(identifier_search_key(value) for value in values if value)


def matched_supplier_numbers(
    db: Session,
    articles: Sequence[WerkstattArticle],
    query: str,
    *,
    category_names: Mapping[int, str],
    location_names: Mapping[int, str],
) -> dict[int, str]:
    """``article_id -> supplier number`` for rows found through a supplier's number.

    One query for all rows. The preferred link is asked first, so when two
    links both explain a hit the row shows the number orders go out under.
    """
    tokens = tokenize(query)
    if not tokens or not articles:
        return {}
    numbers_by_article: dict[int, list[str]] = {}
    for article_id, number in db.execute(
        select(WerkstattArticleSupplier.article_id, WerkstattArticleSupplier.supplier_article_no)
        .where(
            WerkstattArticleSupplier.article_id.in_([article.id for article in articles]),
            WerkstattArticleSupplier.supplier_article_no.is_not(None),
        )
        .order_by(
            WerkstattArticleSupplier.article_id.asc(),
            WerkstattArticleSupplier.is_preferred.desc(),
            WerkstattArticleSupplier.id.asc(),
        )
    ).all():
        numbers_by_article.setdefault(article_id, []).append(number)

    key = identifier_search_key(query)
    matched: dict[int, str] = {}
    for article in articles:
        numbers = numbers_by_article.get(article.id)
        if not numbers:
            continue
        own_text = _own_text(
            article,
            category_name=category_names.get(article.category_id) if article.category_id else None,
            location_name=location_names.get(article.location_id) if article.location_id else None,
        )
        own_codes = _own_codes(article)
        for number in numbers:
            if _number_explains_hit(
                number, tokens=tokens, key=key, own_text=own_text, own_codes=own_codes
            ):
                matched[article.id] = number
                break
    return matched
