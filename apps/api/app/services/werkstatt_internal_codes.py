"""Mint the barcodes we print for stock that has none of its own.

Most articles arrive with a manufacturer barcode and need nothing from us.
The rest — offcuts, loose fittings, anything repackaged, anything a supplier
ships unmarked — reach the shelf unscannable, and the stock-take station has
always handled that by inventing a code and printing it.

Doing the same thing on the server closes the gap that made half the stock
unscannable: a code minted here is written to the article in the same
transaction that prints it, so the label on the shelf and the row in the
database cannot disagree. The station's asymmetry was the opposite — mint in
the browser, print, and hope the import kept it.
"""

from __future__ import annotations

import secrets

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.entities import WerkstattArticle

# The station's alphabet, deliberately unchanged so codes from both sources
# look alike and one rule reads them. I and O are absent: on a 4pt label
# beside a DataMatrix they are read back as 1 and 0 by anyone hand-typing a
# code the scanner would not take.
CODE_ALPHABET = "0123456789ABCDEFGHJKLMNPQRSTUVWXYZ"
CODE_PREFIX = "SMPL-"
CODE_LENGTH = 6

# 34^6 ≈ 1.5 billion, against a few thousand articles: a collision is already
# improbable, but the check is cheap and the failure mode — two shelves whose
# labels point at one row — is silent and expensive to unpick.
_MINT_ATTEMPTS = 12


class InternalCodeExhausted(RuntimeError):
    """Could not find a free code. Effectively unreachable; not silently ignored."""


def generate_code() -> str:
    """One candidate code. Random, not sequential.

    Sequential codes would encode the order stock was labelled, which invites
    reading meaning into a string that has none, and makes a mis-scan land on
    a neighbouring shelf rather than nowhere.
    """
    body = "".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LENGTH))
    return f"{CODE_PREFIX}{body}"


def mint_internal_code(db: Session) -> str:
    """A code no article currently holds."""
    for _ in range(_MINT_ATTEMPTS):
        candidate = generate_code()
        taken = db.scalars(
            select(WerkstattArticle.id).where(WerkstattArticle.internal_code == candidate)
        ).first()
        if taken is None:
            return candidate
    raise InternalCodeExhausted("Kein freier Etikettencode gefunden")


def ensure_internal_code(db: Session, article: WerkstattArticle) -> str:
    """The article's own printable code, minting one the first time.

    Idempotent on purpose: printing a second copy of a label — because the
    first was smudged, or the box was split — must reproduce the same code,
    not orphan the sticker already on the shelf.
    """
    if article.internal_code:
        return article.internal_code
    article.internal_code = mint_internal_code(db)
    return article.internal_code
