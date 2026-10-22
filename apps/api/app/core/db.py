from __future__ import annotations
from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.core.config import get_settings
from app.core.db_pool import postgres_engine_kwargs

settings = get_settings()

engine_kwargs = {"pool_pre_ping": True}
if settings.database_url.startswith("sqlite"):
    engine_kwargs["connect_args"] = {"check_same_thread": False}
else:
    # Sized from DB_POOL_SIZE / DB_MAX_OVERFLOW so every process together fits
    # under Postgres's max_connections — see app/core/db_pool.py.
    engine_kwargs.update(postgres_engine_kwargs(settings))

engine = create_engine(settings.database_url, **engine_kwargs)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, class_=Session)


class Base(DeclarativeBase):
    pass


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def release_connection(db: Session) -> None:
    """Give the request's connection back to the pool before slow work that
    needs no database.

    FastAPI closes a ``get_db`` session only after the response is completely
    sent, and the session holds its connection from the first query on. So a
    file that is decrypted, transcoded, rendered or streamed kept a connection
    checked out — idle in transaction — the whole time, and a gallery of
    previews took one per photo until the slowest phone finished downloading
    (2026-10-16). Call this once the database work is done; ORM objects keep
    the attributes they already loaded. The session stays usable: a later query
    simply checks a connection out again.
    """
    db.close()
