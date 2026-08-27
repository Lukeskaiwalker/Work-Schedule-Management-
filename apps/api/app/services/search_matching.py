"""Shared text-matching helpers for catalog, Werkstatt and customer search.

Both search paths have to cope with how tradespeople actually type. Three
failure modes drove this module:

1. **No tokenisation.** ``/werkstatt/item-search`` used the whole query as one
   contiguous ``ILIKE '%…%'``, so ``NYM 3x1,5`` could not find a stored
   ``NYM-J 3x1,5`` — a single hyphen was enough to return nothing.
2. **Separator drift.** Datanorm rows spell the same article as ``3x1,5``,
   ``3x1.5`` or ``3 x 1,5`` depending on the wholesaler. Whichever one the user
   types, the other spellings must still match.
3. **Rank after truncation.** Both paths applied ``LIMIT`` *before* ordering by
   match quality, so the best row could be dropped before ranking ever saw it.
   The helpers here produce a score expression so callers can order first and
   limit last.

Deliberately dialect-agnostic: production runs PostgreSQL (with ``pg_trgm``),
while the test suite builds its schema via ``Base.metadata.create_all`` against
SQLite (``tests/conftest.py``) — no migrations, therefore no extension. Every
helper degrades to plain ``LIKE`` when trigram support is absent.
"""

from __future__ import annotations

import re
from typing import Sequence

from sqlalchemy import ColumnElement, Float, func, literal, or_, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session

# A decimal written with a comma, e.g. the "1,5" in "NYM-J 3x1,5".
_DECIMAL_COMMA_RE = re.compile(r"(\d),(\d)")
_DECIMAL_POINT_RE = re.compile(r"(\d)\.(\d)")
_WHITESPACE_RE = re.compile(r"\s+")
_NON_ALNUM_RE = re.compile(r"[^a-z0-9]+")
_NON_DIGIT_RE = re.compile(r"\D+")

# This app serves one German electrical contractor, so every stored number is a
# German one and "the" country code is a constant rather than a per-record
# property. Naming it keeps the intent visible: a future multi-country tenant
# has to replace this with configuration, not hunt for a bare "49" in a slice.
GERMANY_COUNTRY_CODE = "49"

# Fewer digits than this is a fragment, not a number: "0" or "17" occurs inside
# nearly every stored number, so matching on it would turn the phone clause
# into a filter that selects everyone.
PHONE_MIN_DIGITS = 3

# What people put *between* the digits of a phone number. Python and SQL strip
# exactly this set, from one shared constant, so the two normalisations cannot
# drift apart and start disagreeing about what is stored.
PHONE_SEPARATORS = (" ", "-", "/", "(", ")", "+", ".")

# A query made only of digits and phone punctuation: no letters, therefore no
# text intent to preserve.
_PHONE_QUERY_RE = re.compile(r"^[\d\s+()/.\-]+$")

# Trigram similarity below this is noise rather than a near-miss. Chosen to be
# forgiving enough for a one-character typo in a short word ("schuko" vs
# "schucko" scores ~0.55) without dragging in unrelated articles.
TRIGRAM_SIMILARITY_THRESHOLD = 0.30

# Cache the per-engine probe: the answer cannot change while the process runs,
# and probing pg_extension on every keystroke would defeat the point.
_trigram_support: dict[str, bool] = {}


def normalize_query(value: str) -> str:
    """Casefold and collapse whitespace. Does not touch separators."""
    return _WHITESPACE_RE.sub(" ", value.casefold()).strip()


def tokenize(query: str) -> list[str]:
    """Split a free-text query into whitespace-separated search tokens.

    Tokenising is what lets ``NYM 3x1,5`` match ``NYM-J 3x1,5``: each token is
    matched independently, so text between them is irrelevant.
    """
    return [token for token in normalize_query(query).split(" ") if token]


def identifier_key(value: str) -> str:
    """Reduce an identifier to comparable form: ``1234-567`` -> ``1234567``.

    Used for exact identifier equality so that an article number typed with
    different punctuation than the catalog stores still counts as exact.
    """
    return _NON_ALNUM_RE.sub("", value.casefold())


def phone_digits(value: str) -> str:
    """Keep only the digits of a phone number.

    Nothing normalises a phone number on the way in: it is stored exactly as
    somebody typed it, so the same connection lives in the database as
    ``+49 171 1234567``, ``0171/1234567`` or ``0171 12 34 567`` depending on
    who created the record. Digits are the only part all spellings agree on,
    which makes digits-to-digits the only comparison that can work.
    """
    return _NON_DIGIT_RE.sub("", value)


def phone_search_key(value: str) -> str:
    """Reduce a phone number to its national significant digits.

    ``+49 171 1234567``, ``0049 171 1234567`` and ``0171 1234567`` are one
    number written three ways, and everything that differs between them is a
    *prefix*: the international access code, the country code, the national
    trunk ``0``. Dropping the prefix leaves ``1711234567`` for all three.

    The result is always a suffix of the typed digits, and that is what makes
    a plain substring match sufficient on the other side: the stored column
    keeps whatever prefix it was typed with, so the key is found inside it
    regardless of which of the three spellings the record happens to use.
    A stripped prefix can only ever *widen* the match — worst case (someone
    types a local number that genuinely begins ``49``) it searches for a
    shorter string, never for the wrong one.
    """
    digits = phone_digits(value)
    if digits.startswith("00" + GERMANY_COUNTRY_CODE):
        return digits[len("00" + GERMANY_COUNTRY_CODE) :]
    if digits.startswith(GERMANY_COUNTRY_CODE):
        return digits[len(GERMANY_COUNTRY_CODE) :]
    if digits.startswith("0"):
        return digits[1:]
    return digits


def looks_like_phone_query(value: str) -> bool:
    """Whether the whole query is one phone number rather than search words.

    Callers split queries on whitespace and require every token to match, but
    a phone number written the way people write it *contains* whitespace:
    ``+49 171 1234567`` splits into a ``+49`` that carries two digits, matches
    nothing, and would make the AND-across-tokens rule reject the very number
    the user just typed. A query with no letters in it has no text intent to
    protect, so callers may match it a second way — as one unsplit number.
    """
    stripped = value.strip()
    if not stripped:
        return False
    return bool(_PHONE_QUERY_RE.match(stripped))


def phone_column_key(column: ColumnElement) -> ColumnElement:
    """Strip phone separators from a stored column, in SQL.

    Nested ``func.replace`` rather than ``regexp_replace`` on purpose:
    ``replace`` is the one string-rewriting function both PostgreSQL
    (production) and SQLite speak, and the test suite runs on SQLite — it
    builds its schema with ``Base.metadata.create_all`` and never runs
    migrations. A ``regexp_replace`` here would pass in production and fail
    every test that touches it.

    Country code and trunk zero are deliberately left in place: removing them
    in SQL would need a CASE per prefix on every row. The *query* side reduces
    to national significant digits instead (:func:`phone_search_key`), and a
    substring match then finds the row whichever prefix it carries.
    """
    expression: ColumnElement = column
    for separator in PHONE_SEPARATORS:
        expression = func.replace(expression, separator, "")
    return expression


def term_variants(token: str) -> list[str]:
    """Return the spellings of ``token`` worth matching against stored text.

    Only decimal separators vary in practice, and they vary constantly across
    Datanorm suppliers. Returns the token itself first so the common case stays
    a single-clause match.
    """
    variants = [token]
    with_point = _DECIMAL_COMMA_RE.sub(r"\1.\2", token)
    if with_point != token:
        variants.append(with_point)
    with_comma = _DECIMAL_POINT_RE.sub(r"\1,\2", token)
    if with_comma != token:
        variants.append(with_comma)
    return variants


def escape_like(term: str) -> str:
    """Escape LIKE wildcards so a user typing ``%`` searches for a literal ``%``."""
    return term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def token_matches_any(columns: Sequence[ColumnElement], token: str) -> ColumnElement:
    """Build ``OR`` of ``column LIKE %variant%`` across columns and spellings.

    A token counts as present when *any* of the given columns contains *any*
    spelling of it. Callers ``AND`` these together so every token must appear
    somewhere, which is what makes multi-word queries behave.
    """
    clauses: list[ColumnElement] = []
    for variant in term_variants(token):
        needle = f"%{escape_like(variant)}%"
        for column in columns:
            clauses.append(func.lower(column).like(needle, escape="\\"))
    return or_(*clauses)


def supports_trigram(db: Session) -> bool:
    """Whether this connection can use ``similarity()`` / trigram indexes.

    False on SQLite (tests) and on any PostgreSQL where the ``pg_trgm``
    extension could not be created — a managed database may withhold it, and
    search must keep working rather than 500.
    """
    bind = db.get_bind()
    if bind is None:
        return False
    engine: Engine = bind.engine if hasattr(bind, "engine") else bind
    if engine.dialect.name != "postgresql":
        return False

    key = str(engine.url)
    cached = _trigram_support.get(key)
    if cached is not None:
        return cached

    try:
        row = db.execute(
            text("SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm'")
        ).first()
        supported = row is not None
    except Exception:  # noqa: BLE001 - probe must never break a search request
        supported = False

    _trigram_support[key] = supported
    return supported


def reset_trigram_cache() -> None:
    """Clear the probe cache. Exposed for tests that swap engines."""
    _trigram_support.clear()


def similarity_score(column: ColumnElement, query: str, *, enabled: bool) -> ColumnElement:
    """Relevance score for ordering, highest first.

    With trigram support this is PostgreSQL's ``similarity()``. Without it the
    expression collapses to a constant so callers can keep one code path — the
    surrounding rank tiers still order results sensibly, they just lose the
    fuzzy tie-break.
    """
    if not enabled:
        return literal(0.0, Float)
    return func.similarity(func.lower(column), literal(normalize_query(query)))
