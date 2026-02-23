# Handoff Context (Business Workspace Transfer)

## Purpose
This file is the technical handoff to continue the same project in a different ChatGPT workspace/account without losing implementation context.

## Current Product State
- Stack: FastAPI (`apps/api`) + React/Vite (`apps/web`) + PostgreSQL + Caddy (`docker-compose.yml`).
- Scope: MVP modules implemented (RBAC/auth, projects/tasks/planning, time tracking, files/WebDAV, chat, construction reports, wiki, backups/restore).
- Deployment model: self-hosted Docker Compose with local HTTPS and encrypted backups.

## Source of Truth Files
- `docs/STATE.md`: scope, architecture, current milestones, latest compact updates.
- `docs/DECISIONS.md`: ADR log with tradeoffs.
- `docs/TESTING.md`: test commands + latest run results.
- `docs/SECURITY.md`: threat model, encryption, RBAC, backup controls.
- `docs/SETUP.md`: bring-up, restore, WebDAV, operational runbook.

## Known Active Topic
- Weather integration fallback now supports ZIP geocoding when direct address geocoding fails.
- If weather fails for a project, validate project `customer_address` and ensure an address line contains a valid DE postal code.

## Fast Start In New Workspace
1. Open repo root: `/Users/luca/Documents/SMPL all`
2. Start stack: `docker compose up -d --build`
3. Run full checks: `./scripts/test.sh`
4. Optional restore drill: `BACKUP_PASSPHRASE='<pass>' ./scripts/restore_smoke_test.sh`

## Credentials and Secrets
- Do not commit secrets.
- Use `apps/api/.env.example` and `config/telegram.env.example` as templates.
- Production/bootstrap behavior and mail/weather keys are controlled via API env/admin settings.

## Release Readiness Baseline
- Required before release: tests pass, restore smoke passes, compose healthy, docs in Ralph loop updated.
- Use checklist in `docs/SETUP.md` under “Release Verification Checklist”.
