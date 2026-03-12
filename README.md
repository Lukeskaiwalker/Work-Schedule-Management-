# Work Schedule Management

Self-hosted construction operations platform (FastAPI + React + PostgreSQL + Docker Compose) with role-based workflows for projects, planning, reports, files, chat, and operations.

## Current Release

Version: `v1.6.0`  
Release date: `2026-03-12`

## Last Changes Included In This Release

- Admin Center RBAC expansion:
  - dedicated Admin Center navigation from the sidebar user menu,
  - redesigned admin workspace with role-permission matrix and per-user permission overrides,
  - admin self-lockout prevention and locked admin-role permissions,
  - follow-up UI fixes for Safari/WebKit layout, role reset icon, and control readability.
- Notifications and PWA:
  - browser push notifications for tasks and messages,
  - PWA manifest and iOS install/notification guidance,
  - iOS-specific notification permission handling and `showNotification()` fallback.
- Workspace redesign:
  - calendar and weekly planning reworked into a unified grid style,
  - overview/dashboard visual refresh,
  - notification panel/sidebar layout fixes.
- Materials improvements:
  - faster search, image prioritization, shopping-cart UX refinements,
  - Unielektro image lookup expansion and `/brand/` fallback hardening.
- Operations:
  - release metadata continues to derive from git during safe updates via `scripts/update_release_metadata.sh`.

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
