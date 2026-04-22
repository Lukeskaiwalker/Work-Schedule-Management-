# Work Schedule Management

Self-hosted construction operations platform (FastAPI + React + PostgreSQL + Docker Compose) with role-based workflows for projects, planning, reports, files, chat, and operations.

## Current Release

Version: `v2.0.0`  
Release date: `2026-04-22`

Full release notes: [`docs/releases/v2.0.0.md`](docs/releases/v2.0.0.md)

## Last Changes Included In This Release

- Customer master data (Kunden):
  - new first-class `customers` table with CRUD API under `/api/customers`,
  - new Kunden sidebar entry with list and detail pages (projects, activity feed, notes),
  - project modal now uses a searchable customer combobox with "+ Neuen Kunden anlegen" inline create,
  - legacy project `customer_*` columns preserved as a mirrored cache; the additive `20260501_0048_customers` migration backfills existing projects by normalised `(customer_name, customer_address)`.
- External partners (Subunternehmer / Fremdfirmen):
  - new `partners` table and `task_partners` join via the additive `20260505_0049_partners` migration,
  - task create/edit modals gain a "Partner / Externe Firma" multi-select with trade-coloured pills,
  - task list endpoints accept `has_partners` and `partner_id` filters,
  - "Nur Partner-Aufgaben" filter chip on My Tasks, Office Tasks, and the project Tasks tab.
- Werkstatt (workshop / inventory) module:
  - new top-level entry with tabs for Dashboard, Bestand, Auf Baustelle, Nachbestellen, Projekt-Bedarfe, Katalog, Lieferanten, Partner, Kategorien & Lagerorte, Bestellungen, and Datanorm-Import,
  - full core schema shipped via the additive `20260425_0047_werkstatt_core` migration,
  - Partner tab fully wired to real endpoints; remaining tabs render empty states until their backend read-endpoints land in a follow-up release,
  - mobile surfaces (QR scanner, home, Artikel-Detail, Nachbestellen) included.
- Project Gantt view:
  - new Gantt tab on project detail with a timeline of scheduled tasks,
  - auto-scroll to today, weekend shading, per-bar inline actions for Calendar export, mark-done, and Construction Report shortcut,
  - unscheduled tasks listed separately beneath the timeline.
- Workspace switcher (Construction / Office):
  - top-of-sidebar segmented control for switching between site and office modes,
  - workspace preference persisted in `localStorage`; sidebar entries and task surfaces adapt to the active mode.
- Construction report improvements:
  - PDF / Excel output now accepts an explicit `company_name` argument,
  - submitted-by line uses the user's nickname when configured.
- Tooling and hygiene:
  - `.gitignore` broadened to exclude dev / smoke / test SQLite files, Claude Code scratch, Playwright MCP output, and root-level debug snapshot YAMLs/PNGs,
  - test fixture for `test_construction_report_uses_nickname_for_submitted_by` updated to accept the new `company_name` kwarg; the full suite is now 180/180 green.

## Download And Install This Release

You can install/upgrade without losing existing project data.

### Option A: In-App Admin Update Menu

1. Open `Admin` -> `System updates`.
2. Click `Check now` and verify the displayed release matches the deployed git tag/commit metadata.
3. Run `Dry run` first.
4. Run `Install update`.

If the runtime cannot auto-install (common in container-only deployments), use Option B.

### Option B: Manual Upgrade (Data-Safe)

1. Run safe update flow (backup + migration preflight + real migration):
   - `BACKUP_PASSPHRASE='<pass>' ./scripts/safe_update.sh --pull --branch main`
2. Verify:
   - `./scripts/test.sh`
   - open app and run quick smoke flow.

If you need to run steps manually:
1. `BACKUP_PASSPHRASE='<pass>' ./scripts/backup.sh`
2. `git fetch --tags --prune && git pull --ff-only origin main`
3. `docker compose build api`
4. `./scripts/preflight_migrations.sh`
5. `docker compose run --rm api sh -lc 'cd /app && alembic upgrade head'`
6. `docker compose up -d --build api api_worker web caddy`

## Important Data Safety Rule

Do **not** remove Docker volumes during upgrade.  
Do **not** run `docker compose down -v` unless you intentionally want to delete database and file data.

## Tech Stack

- Backend: FastAPI, SQLAlchemy, Alembic
- Frontend: React, Vite
- DB: PostgreSQL
- Runtime: Docker Compose + Caddy

## Operational Docs

- `docs/STATE.md`
- `docs/DECISIONS.md`
- `docs/TESTING.md`
- `docs/SECURITY.md`
- `docs/SETUP.md`
