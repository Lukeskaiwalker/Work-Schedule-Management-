"""The Rollen matrix speaks German.

The admin centre is German, but the permission matrix read "Manage users",
"View projects", … — the labels, descriptions and group names came from
``app.core.permissions`` in English and the SPA shows them verbatim. German is
the product's language, so the plain ``permission_labels`` /
``permission_descriptions`` / group ``label`` are German; the English set
rides along under ``*_en`` for the SPA's English mode. The permission KEYS are
machine values and do not change.
"""
from __future__ import annotations

import re

from fastapi.testclient import TestClient

from app.core.permissions import (
    ALL_PERMISSIONS,
    PERMISSION_DESCRIPTIONS,
    PERMISSION_DESCRIPTIONS_EN,
    PERMISSION_GROUPS,
    PERMISSION_LABELS,
    PERMISSION_LABELS_EN,
)
from tests.conftest import auth_headers

# What the English set starts with, and what slipped through into the German
# one: an English verb in front ("Manage users") or a bare English noun phrase.
ENGLISH_LEAD = re.compile(r"^(Manage|View|Edit|Create|Delete|Import|Mark|Clock|Approve|Access|Export|Restore|List|Register|Review|See|Browse|Submit|Read|Post|Upload|Open|Flag|Project|Users?)\b")
# English words that never belong in German UI text. Loan words the app uses
# on purpose (Ticket, Chat, Wiki, Backup, Admin, Audit) are not on the list.
ENGLISH_WORDS = re.compile(
    r"\b(the|and|of|all|own|only|users?|projects?|tasks?|files?|reports?|settings|manage|view|edit|create|delete|"
    r"time entries|vacation|absences?|permissions?|finances?|machines?|apprentice|encrypted|restore)\b",
    re.IGNORECASE,
)


def test_every_permission_has_a_german_label_and_description() -> None:
    for perm in sorted(ALL_PERMISSIONS):
        label = PERMISSION_LABELS.get(perm, "")
        description = PERMISSION_DESCRIPTIONS.get(perm, "")
        assert label.strip(), f"{perm}: no label"
        assert description.strip(), f"{perm}: no description"
        assert not ENGLISH_LEAD.match(label), f"{perm}: English label {label!r}"
        assert not ENGLISH_LEAD.match(description), f"{perm}: English description {description!r}"
        assert not ENGLISH_WORDS.search(label), f"{perm}: English word in label {label!r}"
        assert not ENGLISH_WORDS.search(description), f"{perm}: English word in description {description!r}"


def test_no_label_or_description_left_for_a_permission_that_does_not_exist() -> None:
    # A stale key would never be shown, and would hide a typo in a real one.
    assert set(PERMISSION_LABELS) == set(ALL_PERMISSIONS)
    assert set(PERMISSION_DESCRIPTIONS) == set(ALL_PERMISSIONS)


def test_the_english_set_is_complete_for_the_english_ui() -> None:
    assert set(PERMISSION_LABELS_EN) == set(ALL_PERMISSIONS)
    assert set(PERMISSION_DESCRIPTIONS_EN) == set(ALL_PERMISSIONS)
    for perm in ALL_PERMISSIONS:
        assert PERMISSION_LABELS_EN[perm].strip()
        assert PERMISSION_DESCRIPTIONS_EN[perm].strip()


def test_group_names_are_german_with_an_english_twin() -> None:
    grouped = [perm for group in PERMISSION_GROUPS for perm in group["permissions"]]
    # Every permission sits in exactly one group, or the matrix drops a row.
    assert sorted(grouped) == sorted(ALL_PERMISSIONS)
    for group in PERMISSION_GROUPS:
        assert group["label"].strip(), group["key"]
        assert group["label_en"].strip(), group["key"]
        assert not ENGLISH_WORDS.search(group["label"]), f"{group['key']}: {group['label']!r}"
    labels = {group["key"]: group["label"] for group in PERMISSION_GROUPS}
    assert labels["users"] == "Benutzer"
    assert labels["time"] == "Zeiterfassung"
    assert labels["permissions"] == "Berechtigungen"


def test_the_matrix_endpoint_hands_out_both_languages(client: TestClient, admin_token: str) -> None:
    resp = client.get("/api/admin/role-permissions", headers=auth_headers(admin_token))
    assert resp.status_code == 200, resp.text
    body = resp.json()

    assert body["permission_labels"]["users:manage"] == "Benutzer verwalten"
    assert body["permission_labels"]["projects:view"] == "Projekte ansehen"
    assert body["permission_labels_en"]["users:manage"] == "Manage users"
    assert body["permission_descriptions_en"]["users:manage"].startswith("Create, edit")
    assert not ENGLISH_LEAD.match(body["permission_descriptions"]["users:manage"])
    users_group = next(g for g in body["permission_groups"] if g["key"] == "users")
    assert users_group["label"] == "Benutzer"
    assert users_group["label_en"] == "Users"
    # The keys stay machine values: the matrix still saves what it saved before.
    assert "users:manage" in body["all_permissions"]
