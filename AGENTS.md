# Repository Guidelines

## Project Structure & Module Organization
- `apps/api`: FastAPI backend (routers, services, SQLAlchemy models, Alembic migrations, tests).
- `apps/web`: React + Vite frontend (`src/`, `public/`, production `dist/`).
- `docs`: living project memory and operational docs (`STATE.md`, `DECISIONS.md`, `TESTING.md`, `SECURITY.md`, `SETUP.md`).
- `scripts`: operational helpers (`test.sh`, `backup.sh`, `restore.sh`, `restore_smoke_test.sh`).
- `docker-compose.yml`: local stack (`db`, `api`, `web`, `caddy`).

## Build, Test, and Development Commands
- `docker compose up --build -d`: build and run the full local stack.
- `./scripts/test.sh`: primary one-command verification (API tests + web build).
- `docker compose run --rm api pytest -q`: run backend tests directly in Docker.
- `cd apps/web && npm run build`: production build check for frontend.
- `BACKUP_PASSPHRASE='...' ./scripts/restore_smoke_test.sh`: backup/restore integrity smoke test.

## Coding Style & Naming Conventions
- Python: PEP 8, 4-space indentation, `snake_case` for functions/variables, `PascalCase` for classes.
- TypeScript/React: `camelCase` for variables/functions, `PascalCase` for components and types.
- Keep API permission checks server-side (never rely on frontend-only authorization).
- Alembic migrations: timestamped descriptive filenames, e.g. `20260220_0008_chat_thread_icons_and_read_state.py`.

## Testing Guidelines
- Framework: `pytest` in `apps/api/tests` (`test_auth_rbac.py`, `test_workflows.py`).
- Add/update tests for every behavior change (happy path + key permission/validation edge cases).
- Prefer integration-style endpoint coverage for RBAC, files, chat, time tracking, and reports.
- Keep `./scripts/test.sh` green before submitting changes.

## Commit & Pull Request Guidelines
- No Git history is available in this exported workspace; use Conventional Commit style:
  - `feat(api): allow attachment-only thread messages`
  - `fix(web): keep message bubbles content-sized`
- PRs should include:
  - clear summary and reason for change,
  - affected paths (e.g. `apps/web/src/App.tsx`),
  - test evidence (`./scripts/test.sh` output),
  - UI screenshots/GIFs for frontend changes.

## Security & Configuration Tips
- Never commit secrets; use templates like `apps/api/.env.example` and `config/telegram.env.example`.
- Keep TLS and local trust setup aligned with `docs/SETUP.md`.
- Maintain the Ralph loop: update `docs/STATE.md`, `docs/DECISIONS.md`, `docs/TESTING.md`, `docs/SECURITY.md`, and `docs/SETUP.md` each iteration.
