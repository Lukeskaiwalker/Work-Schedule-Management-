"""Uniqueness rules production enforces are enforced in the tests too.

Until 2026-10-06 four of them lived only in the migrations, so the SQLite test
schema -- built from the models, never from the migrations -- did not check
them: one article per EAN, one per internal SMPL code, one supplier article
number per supplier, one task per customer-confirmation token. A test could
create two articles with the same barcode and pass; production would refuse
the second. They are declared on the models now (migration 0097 reconciled
the rest of the drift).

These insert straight through the ORM, so a model that loses one of the rules
fails here, in every run -- not only when somebody runs
scripts/check_schema_drift.py against PostgreSQL.
"""

from __future__ import annotations

from typing import Callable

import pytest
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.db import SessionLocal
from app.models.entities import Customer, Task, WerkstattArticle, WerkstattArticleSupplier, WerkstattSupplier


def _article(db: Session, number: str, **fields) -> WerkstattArticle:
    article = WerkstattArticle(article_number=number, item_name=f"Artikel {number}", **fields)
    db.add(article)
    db.flush()
    return article


def _refused(db: Session, write: Callable[[], object]) -> None:
    """The write must fail on the database's rule -- and only its savepoint is lost."""
    with pytest.raises(IntegrityError):
        with db.begin_nested():
            write()


def test_an_ean_names_at_most_one_article() -> None:
    with SessionLocal() as db:
        _article(db, "SP-T001", ean="4011923456789")
        _refused(db, lambda: _article(db, "SP-T002", ean="4011923456789"))


def test_an_internal_code_names_at_most_one_article() -> None:
    with SessionLocal() as db:
        _article(db, "SP-T001", internal_code="SMPL-7KQ2M9")
        _refused(db, lambda: _article(db, "SP-T002", internal_code="SMPL-7KQ2M9"))


def test_articles_without_a_barcode_are_not_duplicates_of_each_other() -> None:
    """Both rules are partial: most articles have neither code."""
    with SessionLocal() as db:
        for number in ("SP-T001", "SP-T002", "SP-T003"):
            _article(db, number)
        db.commit()


def test_a_supplier_article_number_is_unique_per_supplier_when_present() -> None:
    with SessionLocal() as db:
        first, second = WerkstattSupplier(name="Unielektro"), WerkstattSupplier(name="Brisch")
        db.add_all([first, second])
        db.flush()
        a, b, c = (_article(db, number) for number in ("SP-T001", "SP-T002", "SP-T003"))

        def link(article: WerkstattArticle, supplier: WerkstattSupplier, number: str | None) -> None:
            db.add(WerkstattArticleSupplier(article_id=article.id, supplier_id=supplier.id, supplier_article_no=number))
            db.flush()

        link(a, first, "2003-7641")
        _refused(db, lambda: link(b, first, "2003-7641"))
        link(b, second, "2003-7641")  # another supplier may use the same number
        link(b, first, None)  # and a link without a number is no duplicate
        link(c, first, None)
        db.commit()


def test_a_confirmation_token_names_one_task() -> None:
    """The public confirmation page finds the task by its token alone."""
    with SessionLocal() as db:
        customer = Customer(name="Familie Schmitt")  # a task belongs to a project or a customer
        db.add(customer)
        db.flush()

        def task(title: str, token: str | None) -> None:
            db.add(Task(title=title, customer_id=customer.id, customer_confirmation_token=token))
            db.flush()

        task("Zähler tauschen", "tok-1")
        _refused(db, lambda: task("Wallbox", "tok-1"))
        task("ohne Token A", None)
        task("ohne Token B", None)
        db.commit()
