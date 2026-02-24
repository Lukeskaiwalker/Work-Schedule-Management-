# Setup

## One-command bring-up
1. (Optional) create local override file:
   - `cp apps/api/.env.example apps/api/.env`
2. Start stack:
   - `docker compose up --build -d`
   - Stack now includes `api_worker` (background report-processing worker) in addition to `db/api/web/caddy`.
3. Trust local TLS root on macOS (Safari/Chrome):
   - `./scripts/trust_caddy_root_macos.sh`
4. Open app:
   - `https://localhost`
   - Use `localhost` (not `127.0.0.1`) for browser access.

## Local Wiki Source Folder
- Put wiki files under repo folder:
  - `local wiki/<brand>/<folder>/...`
- Docker mounts this folder read-only into API:
  - host `./local wiki` -> container `/data/wiki`
- Wiki tab now reads from this folder (brand/folder explorer with searchable files and in-browser preview for HTML/PDF/text/image files).

## Share on Local Network (Demo Mode)
- Print LAN URL:
  - `./scripts/show_lan_url.sh`
- Share the displayed URL (example: `http://192.168.2.180`) with users on the same local network.
- Keep using `https://localhost` on your own machine.
- Note: LAN demo URL uses HTTP (no TLS) for easier device compatibility; use only on trusted local networks.

## Project Files as OS Drive (WebDAV)
- WebDAV URL pattern:
  - `https://localhost/api/dav/projects/` (all accessible projects)
  - `https://localhost/api/dav/projects/general-projects/` (reports without project)
  - `https://localhost/api/dav/projects/archive/` (archived projects)
  - `https://localhost/api/dav/projects/<project_id>/`
  - LAN demo option (all projects): `http://<LAN-IP>/api/dav/projects/` (trusted network only)
  - LAN demo option: `http://<LAN-IP>/api/dav/projects/<project_id>/` (trusted network only)
- Credentials:
  - App email + app password (same as login)
- Quick mount:
  - macOS Finder: `Go` -> `Connect to Server` (`Cmd+K`) -> paste URL with trailing `/`
  - If HTTPS trust fails on another device, use the LAN HTTP URL only on trusted local networks
  - Windows Explorer: `Map network drive` with WebDAV client -> paste URL
- Folder labels in all-projects mount include customer/project identity and internal project ID (`... | ID <id>`) for easier lookup.
- WebDAV root now separates lifecycle buckets:
  - active projects appear directly under `/api/dav/projects/`,
  - archived projects are grouped under `/api/dav/projects/archive/`,
  - no-project report files are grouped under `/api/dav/projects/general-projects/`.
- Default per-project folder structure is auto-created:
  - `Bilder`, `Anträge`, `Berichte`, `Tickets`, `Verwaltung`.
- `Verwaltung` is protected and visible/usable only for elevated roles (`admin`, `ceo`, `accountant`, `planning`).
- Users can create additional folders in the Files UI or through WebDAV folder creation (`MKCOL`).

Compose uses `apps/api/.env.example` by default. If you need custom values (new secret key, Telegram credentials), update that file or inject env vars through your deployment method.
Wiki source root can be changed with `WIKI_ROOT_DIR` in API env (default `/data/wiki`).
The provided legacy logo is bundled into both web and API assets (`apps/web/public/logo.jpeg`, `apps/api/app/assets/logo.jpeg`).
Time tracking day/week boundaries follow `APP_TIMEZONE` (default: `Europe/Berlin`).
Construction report processing/runtime knobs:
- `REPORT_PROCESSING_MODE=worker|inline` (`worker` recommended in compose; `inline` useful for deterministic fallback/testing)
- `REPORT_JOB_MAX_ATTEMPTS` (default `3`)
- `REPORT_WORKER_POLL_SECONDS` (default `1.0`)
- `API_WORKERS` (default `2`) for concurrent API request handling

## One-command validation
- `./scripts/test.sh`
- In Docker mode this rebuilds API image before running API tests to keep container code in sync.

## Default login
- Email: `admin@example.com`
- Password: `ChangeMe123!`
- Override with `INITIAL_ADMIN_EMAIL` and `INITIAL_ADMIN_PASSWORD` in API env.

## Import projects from Excel
- Place the `.xlsx` file in repo root (or pass any path).
- Run:
  - `./scripts/import_projects_excel.sh "<path-to-file.xlsx>"`
  - optional sheet name: `./scripts/import_projects_excel.sh "<path-to-file.xlsx>" "<sheet-name>"`
- Behavior:
  - when no sheet is specified, all workbook sheets are processed
  - known columns are mapped into typed project fields (`project_number`, `name`, customer fields, `status`, `last_state`, `last_status_at`, `description`)
  - all source columns are preserved in `project.extra_attributes`
  - multi-table duplicates are collapsed during import
  - missing project numbers are auto-filled with temporary markers prefixed by `T` only when no reusable fallback identity exists.

## Import projects from CSV (Admin Center)
- Open `Profile & settings` -> `Admin tools`.
- Use:
  - `Download CSV template`
  - `Import CSV`
- API equivalents:
  - `GET /api/admin/projects/import-template.csv`
  - `POST /api/admin/projects/import-csv` (multipart file upload)
- CSV import follows the same mapping behavior as Excel import and preserves unknown columns in project extra attributes.

## Backup
- `export BACKUP_PASSPHRASE='replace-with-strong-passphrase'`
- `./scripts/backup.sh`
- Output artifact is placed under `backups/*.tar.enc`.
- Script auto-starts `db` + `api` if needed and waits for DB readiness.

## Admin In-App Encrypted DB Backup (Key File)
- Open `Profile & settings` -> `Admin tools` -> `Export database backup`.
- Upload a local key file (for example `backup.key`) and click download.
- The generated `.smplbak` artifact is encrypted and tied to that key file material.
- Keep the key file in secure storage; without the correct key file the backup cannot be decrypted.

## Restore into fresh environment
1. `export BACKUP_PASSPHRASE='your-passphrase'`
2. `./scripts/restore.sh backups/<artifact>.tar.enc`
3. By default, script restores DB/uploads and then starts full stack (`web` + `caddy`).
4. Optional: set `RESTORE_START_FULL_STACK=false` to skip web/caddy startup.

## Telegram Bot Config (optional)
- Copy `config/telegram.env.example` to `config/telegram.env` (local only).
- Populate `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`.
- Mirror values into API env (never commit real secrets).

## Local SMTP + Invite/Reset Links (optional but recommended)
- Configure in `apps/api/.env.example` (or your deployment env):
  - `APP_PUBLIC_URL` (for generated invite/reset links)
  - `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD`
  - `SMTP_STARTTLS`, `SMTP_SSL`
- Sender address is fixed for invite/reset emails:
  - `technik@smpl-energy.de`
  - `MAIL_FROM` is not used for these admin-auth mails.
- If SMTP is not configured:
  - admin invite/reset actions still work,
  - API returns generated local links for manual delivery.
- Link targets:
  - `https://localhost/invite?token=...`
  - `https://localhost/reset-password?token=...`

## Profile Settings (user self-service)
- Open `Profile & settings` (from sidebar user card).
- In the profile block, users can update:
  - name,
  - email address,
  - password.
- Security behavior:
  - email/password change requires current password.
  - newly created users default to role `employee` unless admin explicitly changes role.
  - Admin Center user actions are in each user row’s 3-dot menu (`invite`, `reset password`, `delete user`).
  - `Delete user` deactivates account access but preserves historical data for exports/reporting.

## Operational Notes (Current MVP)
- Navigation model:
  - `Overview` is now the left-side dashboard entry (status + assigned projects + project overview).
  - `My Tasks` is a dedicated left-nav module; each task links into its project context and project view offers a back action to return to `My Tasks`.
  - Weekly planning is a global main module, not a project tab.
  - Weekly planning page body is calendar-only; use the header `Add task` action to open the task-planning modal.
  - Construction report is a global main module:
    - selecting a project auto-fills customer/project master data.
    - if no project is selected, reports can still be created and are stored in the general reports folder.
  - Wiki is a global main module for local technical guides; all users can read, `admin/ceo/planning` can edit.
  - Project-specific actions open after selecting a project in the sidebar and then using top tabs (`tasks`, `tickets`, `files`).
  - Project creation is available in the left sidebar at the project list header (`Create new`) and opens a modal with full project/customer fields.
  - Sidebar footer (left-bottom) contains the compact language switch (`DE/EN`) and current-user identity card.
  - Sidebar footer now shows live date/time under the user card and places `DE/EN` + `Sign out` in one compact row.
  - Clicking the sidebar user identity card opens `Profile & settings`; admin users can access user administration there.
  - In `Profile & settings`, users can upload/change their profile picture with an in-browser crop step (zoom + framing) before save.
  - Projects use a user-defined `project_number` (business ID) and editable customer master data.
  - Existing projects can be edited from project header action (`Edit project` / `Projekt bearbeiten`) for authorized roles.
  - Task creation now supports assigning one task to multiple employees.
- Time tracking UI includes live status, clock-out, break controls, and weekly entry edits.
- Time tracking now includes absence workflows:
  - all users can submit vacation requests,
  - elevated roles can approve/reject requests,
  - approved vacations are visible in weekly planning and in the requester’s time view.
- School dates (recurring weekdays or date-range blocks) can be managed by accountant+ in `Admin tools` and are rendered in weekly planning.
- Recurring school intervals now support multi-day selection via Monday-Friday checkboxes.
- Default German-law break deduction is applied in time totals/export (`>6h=30m`, `>9h=45m`).
- Chat module supports:
  - compact messenger-style thread/message layout
  - per-thread icon/picture upload
  - creator-managed thread edits (or chat-manager override)
  - unread badges derived from server-side read tracking
  - composer row with left `+` attachment control and right arrow send button
  - attachment draft chip before send (remove with `x`, optional text can still be edited)
  - send arrow stays gray while message input is empty and switches to active blue when text is present
  - attachment-only messages are supported (file can be sent without text)
  - fixed-height message pane with internal scroll for older messages
  - newest-message auto-follow after sending (pauses when user scrolls up in history)
- Construction report form supports image uploads in one submit; report images are stored encrypted and included in generated PDF output.
- In `REPORT_PROCESSING_MODE=worker`, report upload returns quickly and PDF generation continues in background via `api_worker`; UI polls processing status until terminal state.
- Construction report files panel reads from:
  - selected project report files when a project is chosen.
  - general report folder when no project is selected.
- Construction report and file sorting defaults:
  - generated report PDFs are automatically stored under `Berichte`,
  - report images are automatically stored under `Bilder`,
  - project file uploads with no selected folder auto-route images to `Bilder` and PDFs to `Berichte`.
- Files tab supports in-browser preview (image/PDF/text) via protected preview endpoint, plus explicit download action.
- In project files, `Preview` opens in a separate browser tab/window (no inline modal overlay).
- Project files upload uses a compact upload icon in the file explorer header that opens a small upload modal.
- Project list header create action is a compact plus-icon trigger for the project-create modal.
- Weekly planning header shows calendar week (`KW/CW`) and previous/next week arrows; selected week start is normalized to Monday.
- Weekly planning keeps a fixed Monday-Sunday row:
  - narrow screens scroll horizontally for days,
  - each day scrolls vertically when many tasks are present.
- Task start-time fields in German UI (`DE`) use explicit 24h `HH:MM` format.
- Task/report time fields now use explicit `HH:MM` entry across all task create/edit surfaces and construction-report worker rows (same format in `DE` and `EN`).
- Weekly planning cards assigned to the logged-in user can be clicked to jump directly into `My Tasks` with the selected task auto-expanded.
- Project edit modal now includes manager-only lifecycle actions: `Archive` and permanent `Delete`.
- Desktop shell uses independent sidebar/content scrolling so each side can overflow without blocking the other.
- Compose services use `restart: unless-stopped`; `api`/`web` use healthchecks and health-gated startup ordering.
- Sidebar behavior:
  - with many projects, only the project list scrolls; user/profile footer remains visible at bottom.
- Project import behavior:
  - `Aktueller Status` values from Excel are stored as-is in project status (full source vocabulary).
  - `Notiz` is imported into `last_state` and shown in project summary as `Last state`.
  - `Letzter Status Datum` is imported into `last_status_at` and shown in project summary.
  - repeated imports are idempotent (no repeated temp-project creation for the same fallback identity).

## Admin Role Recovery (Emergency)
- If the initial admin role was changed accidentally and UI access is blocked, restore it directly in DB:
  - `docker compose exec -T db psql -U smpl -d smpl -c "UPDATE users SET role='admin' WHERE email='admin@example.com';"`
  - Verify:
    - `docker compose exec -T db psql -U smpl -d smpl -c "SELECT id,email,role FROM users WHERE email='admin@example.com';"`

## Restore Smoke Test
- Run: `BACKUP_PASSPHRASE='strong-pass' ./scripts/restore_smoke_test.sh`
- The smoke test now:
  - creates DB and uploads marker data
  - creates encrypted backup
  - deletes marker data
  - restores from backup
  - verifies marker data returned
  - verifies `https://localhost/api` returns `200`

## Release Verification Checklist
Run this sequence before tagging/releasing:
1. `./scripts/test.sh`
2. `BACKUP_PASSPHRASE='strong-pass' ./scripts/restore_smoke_test.sh`
3. `docker compose up -d --build && docker compose ps`
4. `curl -sk -I https://localhost/`
5. `curl -sk https://localhost/api`

Expected:
- API tests + web build pass.
- Restore smoke passes.
- Compose services are healthy (`db/api/web/caddy/api_worker`).
- HTTPS UI returns `HTTP/2 200` and API returns `{"status":"ok"}`.

## Local dev smoke without Docker (optional)
1. API:
   - `source .venv/bin/activate && cd apps/api && DATABASE_URL='sqlite:///./smoke.db' SECURE_COOKIES=false PYTHONPATH=. uvicorn app.main:app --host 127.0.0.1 --port 8000`
2. Web:
   - `cd apps/web && VITE_API_PROXY_TARGET='http://127.0.0.1:8000' npm run dev -- --host 127.0.0.1 --port 5173`

## Iteration UI Notes (2026-02-22)
- `My Tasks` details now expand/collapse by clicking the task header row.
- Opening `Construction Report`, `Time Tracking`, or `Wiki` from overview shortcut cards shows a header back button (icon + text) to return to overview.
- Left-nav `Chat` now displays a blue dot when any thread has unread messages.
- Chat timeline now shows:
  - centered day separators,
  - message times in `HH:MM`,
  - incoming sender avatar grouping by consecutive sender messages.
- Assignable-user API includes `avatar_updated_at` metadata for consistent identity/avatar display in non-admin views.

## Iteration UI Notes (2026-02-22, task report shortcut + ticket simplification + project search)
- In `My Tasks`, each own task now has `Report from task`:
  - open task: marks complete first, then opens `Construction Report` with task/project prefill,
  - completed task: opens prefilled report directly.
- `Project > Job Tickets` is simplified for current operations:
  - no standalone site/location creation segment,
  - ticket create form uses selected project defaults for address and date.
- Sidebar project navigation now supports quick search:
  - click magnifier next to `Projects`,
  - search field appears under header and filters by customer, project number, or project name.

## Iteration UI Notes (2026-02-22, archive + task back-navigation + task indicators)
- `Project archive` is available at the bottom of the sidebar project list (after divider).
- Archive page supports:
  - unarchive project,
  - permanent delete project (manager roles only).
- In project task list, clicking an assigned own task opens `My Tasks` with that task expanded.
- `My Tasks` now shows a contextual `Back to project` button for this drilldown flow.
- Left-nav now shows a blue change indicator on:
  - `My Tasks`,
  - `Weekly Planning`,
  when assigned-task data changes in background polling.
- Task edit modal includes manager-only `Delete task`.

## Iteration UI Notes (2026-02-22, project/my-task flow + chat pane sizing + thread project mapping)
- `My Tasks` spacing under header is aligned with weekly-planning spacing for visual consistency.
- Drilldown flow `Project -> assigned task -> My Tasks -> Back to project` no longer creates a back-button loop.
- Sidebar project search reveal now pushes project rows down cleanly (search input remains visible).
- Chat right pane now uses viewport-based height so message history has full usable screen height.
- Thread create/edit modal again supports optional project selection; thread edits can move between project-linked and general thread context.

## Ops Addendum (2026-02-22, production bootstrap hardening + data sync)
- After first successful admin provisioning, set in `apps/api/.env`:
  - `INITIAL_ADMIN_BOOTSTRAP=false`
- Rebuild/restart:
  - `docker compose up -d --build`
- If restoring a legacy backup, verify default bootstrap account is not active:
  - `docker compose exec -T db psql -U smpl -d smpl -c "SELECT id,email,is_active FROM users WHERE email='admin@example.com';"`
  - If needed, deactivate:
  - `docker compose exec -T db psql -U smpl -d smpl -c "UPDATE users SET is_active=false WHERE email='admin@example.com';"`
- Upload local wiki payload to mount path:
  - copy/extract into `./local wiki` on host, then `docker compose up -d` (api volume already mounts that path read-only to `/data/wiki`).

## Bootstrap Auto-Disable (2026-02-22)
- Bootstrap creation is controlled by:
  - env: `INITIAL_ADMIN_BOOTSTRAP`
  - DB runtime flag: `app_settings.initial_admin_bootstrap_completed`
- Expected flow:
  1. First setup may create bootstrap admin from env credentials.
  2. Change bootstrap admin credentials in profile settings.
  3. System auto-marks bootstrap completed; startup no longer recreates default bootstrap admin.
- Access recovery (if locked out):
  - Reset password for an existing active admin user via API container script (`docker compose exec -T api python ...`) instead of re-enabling default bootstrap admin.

## macOS File Sync Note
- When creating tar archives on macOS for server sync, disable AppleDouble metadata to avoid `._*` files in source directories:
  - `COPYFILE_DISABLE=1 tar czf /tmp/sync.tgz <paths>`
- If `._*` files were copied accidentally, remove before rebuild:
  - `find apps -name '._*' -type f -delete`

## Iteration Setup Notes (2026-02-23)
- New DB migration added:
  - `20260223_0016_project_finance_and_activity`
- Bring-up remains unchanged:
  - `docker compose up -d --build`
- The API now exposes additional project endpoints used by the UI:
  - `GET /api/projects/{id}/overview`
  - `GET /api/projects/{id}/finance`
  - `PATCH /api/projects/{id}/finance`

## Iteration Setup Notes (2026-02-23, project overview UI refinement)
- No setup command changes required for this iteration.
- After pulling latest code, refresh local stack as usual:
  - `docker compose up -d --build`
- Project overview now reads open-task list data via existing endpoint usage:
  - `GET /api/tasks?view=all_open&project_id=<id>`

## Iteration Setup Notes (2026-02-23, weather placeholder)
- No additional setup required.
- Weather card currently ships as layout placeholder only (no external provider configuration yet).

## Iteration Setup Notes (2026-02-23, OpenWeather setup)
- Project weather now uses OpenWeather (5-day forecast) via backend endpoint:
  - `GET /api/projects/{id}/weather`
- API key setup options:
  - preferred: `Profile & settings` -> `Admin tools` -> `OpenWeather API`,
  - fallback env: set `OPENWEATHER_API_KEY` in `apps/api/.env.example` (or deployment env).
- Runtime behavior:
  - refresh is triggered on project selection,
  - backend enforces max one refresh per project every 15 minutes,
  - cached values are used when provider is unavailable.

## Iteration Setup Notes (2026-02-23, project site-access fields)
- New DB migration added:
  - `20260224_0021_project_site_access_fields`
- Standard refresh is sufficient:
  - `docker compose up -d --build`
- Migration status check (optional):
  - `docker compose exec -T api sh -lc 'cd /app && alembic current'`

## Iteration Setup Notes (2026-02-23, avatar deletion + user archive UI)
- No new migrations required.
- Standard refresh is sufficient:
  - `docker compose up -d --build`
- New API route available:
  - `DELETE /api/users/me/avatar` (authenticated user removes own profile picture).

## Iteration Setup Notes (2026-02-23, materials queue side menu + status workflow)
- New DB migration added:
  - `20260224_0023_project_material_needs`
- Standard refresh applies migration automatically:
  - `docker compose up -d --build api web`
- New API routes available:
  - `GET /api/materials`
  - `PATCH /api/materials/{id}` with body `{ "status": "order|on_the_way|available" }`

## Iteration Setup Notes (2026-02-23, WebDAV project-number reference + file upload base folder)
- No new migration required for this iteration.
- Standard refresh is sufficient:
  - `docker compose up -d --build`
- Updated WebDAV usage:
  - current-project mount links can now use project number directly:
    - `/api/dav/projects/<PROJECT_NUMBER>/`
  - numeric-ID links remain valid for backward compatibility.
- Updated upload folder semantics:
  - `folder=/` uploads to project base folder,
  - empty `folder` keeps existing auto-folder behavior by file type.

## Iteration Setup Notes (2026-02-23, construction report mobile worker/time/photo improvements)
- No new migration required for this iteration.
- Standard refresh is sufficient:
  - `docker compose up -d --build api web`
- Construction report form updates:
  - worker names support assignable-user search suggestions,
  - worker times accept digit-only entry (`0730` -> `07:30`),
  - mobile camera capture can be submitted through additional `camera_images` input.

## Iteration Setup Notes (2026-02-23, admin update menu)
- No migration required for this iteration.
- Standard refresh is sufficient:
  - `docker compose up -d --build api web`
- Optional update metadata/env for accurate comparison in admin update menu:
  - `APP_RELEASE_VERSION`
  - `APP_RELEASE_COMMIT`
  - `UPDATE_REPO_OWNER`
  - `UPDATE_REPO_NAME`
  - `UPDATE_REPO_BRANCH`
  - `UPDATE_REPO_PATH` (set only if auto-install should run against a local git checkout)
  - `GITHUB_API_TOKEN` (optional, helps avoid GitHub API rate limits)
- Manual safe update commands shown in admin menu are:
  - `git fetch --tags --prune`
  - `git pull --ff-only origin main`
  - `docker compose up -d --build`
  - `docker compose exec api alembic upgrade head`

## Iteration Setup Notes (2026-02-24, optimistic edit locking)
- New DB migration added:
  - `20260224_0024_task_updated_at_for_optimistic_locking`
- Standard refresh applies migration automatically:
  - `docker compose up -d --build api web caddy`
- Operational behavior change:
  - project/task/finance edit saves can return `409` when another user changed the same record first.
  - Recommended operator flow on conflict: reload the view, verify latest values, then save again.

## Iteration Setup Notes (2026-02-24, empty upload guard + WebDAV file-size metadata)
- No new migration required for this iteration.
- Standard refresh is sufficient:
  - `docker compose up -d --build`
- Behavioral change:
  - zero-byte uploads to project files and job-ticket attachments are now rejected with `400`.
- WebDAV behavior:
  - `PROPFIND` file entries now include non-zero file-size metadata when available, improving Finder/Explorer file handling.

## Iteration Setup Notes (2026-02-24, optimistic quick-action tokens)
- No new migration required for this iteration.
- Standard refresh is sufficient:
  - `docker compose up -d --build web`
- Operational behavior update:
  - quick actions (`task complete`, `project archive/unarchive`) now enforce the same optimistic conflict semantics as edit dialogs.
  - if a stale action is attempted, UI now shows a conflict message and the user should reload before retrying.

## Iteration Setup Notes (2026-02-24, construction report photo queue selection UX)
- No new migration required for this iteration.
- Standard refresh is sufficient:
  - `docker compose up -d --build web`
- Construction report form behavior:
  - first picker action supports native multi-select,
  - subsequent picker actions append more photos to the same queue,
  - selected photos can be removed individually before submitting the report.

## Iteration Setup Notes (2026-02-24, construction report photo queue thumbnails)
- No new migration required for this iteration.
- Standard refresh is sufficient:
  - `docker compose up -d --build web`
- Construction report form behavior:
  - selected photos are rendered as thumbnail tiles with per-tile remove buttons,
  - selecting additional photos appends to the existing queued set.

## Iteration Setup Notes (2026-02-25, construction report materials row-entry mask)
- No new migration required for this iteration.
- Standard refresh is sufficient:
  - `docker compose up -d --build web caddy`
- Construction report form behavior:
  - `Material` and `Büro Materialbedarf` now use structured rows (`item`, `qty`, `unit`, `article`) instead of free textareas,
  - each section starts with one row and can add/remove rows while filling the report.

## Iteration Setup Notes (2026-02-24, finance tab layout refresh)
- No new migration required for this iteration.
- Standard refresh is sufficient:
  - `docker compose up -d --build web caddy`
- Project finance tab behavior:
  - `Zuletzt aktualisiert` appears directly below the finance card header.
  - Finance KPI values are rendered in a fixed left-to-right label/value column layout.

## Iteration Setup Notes (2026-02-25, finance text-size and spacing adjustment)
- No new migration required for this iteration.
- Standard refresh is sufficient:
  - `docker compose up -d --build web caddy`
- Project finance tab behavior:
  - metric labels and values are rendered larger,
  - vertical spacing inside metric rows is tighter for denser scanability.
