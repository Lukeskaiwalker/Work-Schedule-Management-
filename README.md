# Work Schedule Management

Self-hosted construction operations platform (FastAPI + React + PostgreSQL + Docker Compose) with role-based workflows for projects, planning, reports, files, chat, and operations.

## Current Release

Version: `v1.4.1`  
Release date: `2026-03-05`

## Last Changes Included In This Release

- Admin update center:
  - check latest GitHub release/commit from the Admin panel,
  - run dry-run update checks,
  - run safe install flow with migration step and manual fallback guidance.
- Project and task workflow improvements:
  - completed/open task separation,
  - archive-aware project handling and search behavior,
  - improved project overview consistency and activity visibility.
- Planning updates:
  - calendar-style weekly planning with task type support (construction, office, customer appointment).
- Project data extensions:
  - project classes/templates with CSV import/export in admin,
  - class-based default task creation and material/tool prefills,
  - construction-site access details in project contact section.
- Reporting and finance:
  - construction report hours aggregated into project finance,
  - project-hours tab with planned vs actual tracking and gauge.
- Materials workflow:
  - dedicated materials module for office material demand with state tracking (`Order`, `On its way`, `Available`).
- UX and reliability updates:
  - weather localization/caching improvements,
  - mobile report entry improvements,
  - profile image removal support,
  - user archive handling for deleted users.
- Operations hardening:
  - additional Alembic migrations,
  - updated security, setup, state, decisions, and testing docs.
  - release metadata now auto-refreshes from git on every `safe_update` run (`scripts/update_release_metadata.sh`), so the UI version label no longer stays on a stale hardcoded value.

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
