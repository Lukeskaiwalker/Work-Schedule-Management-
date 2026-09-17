"""``GET /werkstatt/articles/lookup?code=`` — what is this barcode?

Mounted before the article CRUD router so the literal path is reachable at all
(FastAPI matches in registration order; declared after ``/articles/{id}`` this
would parse as an article id and 422).

Authenticated rather than manage-gated on purpose. Looking a code up changes
nothing on the shelf, and the person holding an unfamiliar box is usually not
the person with ``werkstatt:manage`` — making them fetch somebody to answer
"do we stock this?" is the friction that produced the duplicates the merge
screen now cleans up. Creating the article from the answer is still gated.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.deps import get_current_user
from app.models.entities import User
from app.schemas.werkstatt import WerkstattArticleLookupOut
from app.services.werkstatt_article_lookup import lookup_code

router = APIRouter(prefix="", tags=["werkstatt-desktop"])


@router.get("/articles/lookup", response_model=WerkstattArticleLookupOut)
def lookup_article_code(
    code: str = Query(..., min_length=1, max_length=64, description="Scanned or typed code"),
    allow_external: bool = Query(
        default=True,
        description="Ask the webshop / GTIN database when nothing here matches",
    ),
    _: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> WerkstattArticleLookupOut:
    """Our rows, then the wholesaler's catalogue, then the outside world.

    ``allow_external=false`` exists for the caller who only wants the cheap
    half — a page checking "is this already stocked?" while somebody types
    should not fire a scrape per keystroke.

    Commits because a lookup may have cached what an external source said,
    including that it said nothing. Dropping that write would make the next
    scan of the same unknown code scrape again, which is precisely the cost
    the cache exists to remove.
    """
    result = lookup_code(db, code, allow_external=allow_external)
    db.commit()
    return result
