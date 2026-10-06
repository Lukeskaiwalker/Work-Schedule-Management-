"""Do the models and the migration chain describe the same schema?

Run it against a PostgreSQL database migrated to head -- a throwaway one; it
only reads, but the point is a fresh database built from the migrations:

    docker run -d --rm --name smpl-drift -e POSTGRES_USER=smpl \\
      -e POSTGRES_PASSWORD=<random> -e POSTGRES_DB=smpl \\
      -p 127.0.0.1:55497:5432 postgres:16-alpine
    cd apps/api
    export DATABASE_URL=postgresql+psycopg2://smpl:<random>@127.0.0.1:55497/smpl
    python -m alembic upgrade head
    PYTHONPATH=. python scripts/check_schema_drift.py

Exit 0 when they agree; 1 with every difference listed when they do not.

Why it exists: tests/conftest.py builds the SQLite test schema from the models
(``Base.metadata.create_all``), while production runs the migrations. Every
difference between the two is a rule the tests do not enforce, or an index
production does not have. On 2026-10-06 there were 41 -- among them the
partial uniques on EAN and internal code that only production checked --
reconciled by migration 0097 and the model fixes that came with it.
"""

from __future__ import annotations

import os
import sys
from typing import Any, Iterable, Iterator


def _flat(items: Iterable[Any]) -> Iterator[Any]:
    # compare_metadata nests column-level modifications in lists of their own.
    for item in items:
        if isinstance(item, list):
            yield from _flat(item)
        else:
            yield item


def main() -> int:
    url = os.environ.get("DATABASE_URL", "")
    if not url.startswith("postgresql"):
        print("DATABASE_URL must name a PostgreSQL database migrated to head.", file=sys.stderr)
        return 2

    from alembic.autogenerate import compare_metadata
    from alembic.migration import MigrationContext
    from sqlalchemy import create_engine

    from app.core.db import Base
    from app.models import entities  # noqa: F401 -- registers every model

    engine = create_engine(url)
    with engine.connect() as connection:
        context = MigrationContext.configure(connection, opts={"compare_type": True})
        differences = list(_flat(compare_metadata(context, Base.metadata)))

    for difference in differences:
        print(f"  {difference!r}")
    print(f"{len(differences)} difference(s) between the models and the migrated schema.")
    return 1 if differences else 0


if __name__ == "__main__":
    sys.exit(main())
