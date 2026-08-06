"""Shared text-matching helpers for catalog and Werkstatt article search.

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
