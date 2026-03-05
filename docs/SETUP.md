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

## Material Catalog Source (DATANORM)
- Place vendor DATANORM files under:
  - `./Datanorm_Neuanlage/Datanorm.001` ... `Datanorm.00x`
- Compose mounts this folder read-only into API:
  - host `./Datanorm_Neuanlage` -> container `/data/Datanorm_Neuanlage`
- Catalog import behavior:
  - DATANORM `A/B` records are parsed with DATANORM-specific mapping (article/text/unit/EAN/price).
  - parser-version changes trigger an automatic one-time reimport on next catalog access.
  - duplicates are ignored and counted; current count can be read at `GET /api/materials/catalog/state`.
- Optional catalog image lookup controls (API env):
  - `MATERIAL_CATALOG_IMAGE_LOOKUP_ENABLED=true|false` (default `true`)
  - `MATERIAL_CATALOG_IMAGE_LOOKUP_RETRY_HOURS=<int>` (default `168`)
  - `MATERIAL_CATALOG_IMAGE_LOOKUP_MAX_PER_REQUEST=<int>` (default `4`)
- Material image behavior:
  - image lookup is EAN-driven and automatic for newly touched items (catalog search/add-to-needs).
  - lookup order is manufacturer-site first, then open EAN sources.
  - resolved image URLs are cached in DB and reused across catalog reimports.
- If catalog changes are not visible in UI, rebuild/restart API and web:
  - `docker compose up --build -d api web caddy`

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
- Or use a passphrase file:
  - `export BACKUP_PASSPHRASE_FILE='config/backup-test-db.key'`
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
   - or `export BACKUP_PASSPHRASE_FILE='config/backup-test-db.key'`
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
  - admin-only nickname (optional).
- Security behavior:
  - email/password change requires current password.
  - admin nickname has availability checks and can be set, changed, or removed.
  - when nickname is set, report exports use nickname display instead of legal full name for submitter identity.
  - newly created users default to role `employee` unless admin explicitly changes role.
  - Admin Center user actions are in each user row’s 3-dot menu (`invite`, `reset password`, `delete user`).
  - `Delete user` deactivates account access but preserves historical data for exports/reporting.

## Employee Groups For Restricted Chats
- Admin-managed API endpoints:
  - `GET /api/admin/employee-groups`
  - `POST /api/admin/employee-groups`
  - `PATCH /api/admin/employee-groups/{group_id}`
  - `DELETE /api/admin/employee-groups/{group_id}`
- Chat creation selector endpoints:
  - `GET /api/threads/participant-users` (active users only)
  - `GET /api/threads/participant-groups`
- Chat visibility behavior:
  - no selected users/groups => public chat,
  - selected users/groups => restricted chat (creator always included).

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
  - `BACKUP_PASSPHRASE='<passphrase>' ./scripts/backup.sh`
  - `git fetch --tags --prune`
  - `git pull --ff-only origin main`
  - `docker compose build api`
  - `./scripts/preflight_migrations.sh`
  - `docker compose run --rm api sh -lc 'cd /app && alembic upgrade head'`
  - `docker compose up -d --build api api_worker web caddy`

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

## Iteration Setup Notes (2026-02-25, materials single-indicator flow + complete action)
- No new migration required for this iteration.
- Standard refresh is sufficient:
  - `docker compose up -d --build api web caddy`
- Materials menu behavior:
  - status is changed only by clicking the status indicator (no extra dropdown),
  - when status is `Verfügbar/Available`, an `Erledigt/Complete` button is shown,
  - completed items are no longer listed in active materials queue.

## Iteration Setup Notes (2026-02-25, report numbering + normalized report image filenames)
- New DB migration added:
  - `20260225_0026_construction_report_numbers`
- Apply with standard update flow:
  - `docker compose up -d --build api web caddy`
  - `docker compose exec api alembic upgrade head` (if needed separately)
- Operational behavior update:
  - project construction reports now receive a sequential report number,
  - uploaded report photos are stored with deterministic numbered filenames instead of original device/library names.

## Iteration Setup Notes (2026-02-25, update menu release-version display)
- No new migration required for this iteration.
- Standard refresh is sufficient:
  - `docker compose up -d --build api web caddy`
- Recommended deployment metadata:
  - set `APP_RELEASE_VERSION` and `APP_RELEASE_COMMIT` explicitly in API env to avoid fallback-only version detection.

## Iteration Setup Notes (2026-02-26, chat participant roles)
- New DB migration added:
  - `20260226_0029_chat_thread_participant_roles`
- Apply with standard update flow:
  - `docker compose up --build -d api web caddy`
  - `docker compose exec -T api alembic upgrade head` (if needed separately)
- Operational behavior update:
  - New Chat now supports multi-select users and multi-select roles; selecting none keeps chat public.
  - Any selected user/role creates a restricted chat visible only to matching participants and the creator.

## Iteration Setup Notes (2026-02-26, chat archive state + editable restricted participants)
- New DB migration added:
  - `20260226_0030_chat_thread_archive_state`
- Apply with standard update flow:
  - `docker compose up --build -d api web caddy`
  - `docker compose exec -T api alembic upgrade head`
- Operational behavior update:
  - Restricted chat participants can be changed after creation via thread edit.
  - Chats can now be archived, restored from archive, or deleted.
  - Default chat list excludes archived chats; archive UI uses `include_archived=true` path.

## Iteration Setup Notes (2026-02-26, chat header 3-dot actions menu)
- No new migration required for this iteration.
- Standard refresh is sufficient:
  - `docker compose up --build -d web caddy`
- Operational behavior update:
  - Chat header now shows a single 3-dot menu containing `Edit`, `Archive`, and `Delete` actions instead of separate buttons.

## Iteration Setup Notes (2026-02-26, project map copy-address button)
- No new migration required for this iteration.
- Standard refresh is sufficient:
  - `docker compose up --build -d web caddy`
- Operational behavior update:
  - Project overview map card now includes a compact copy icon button to copy the current project address.

## Iteration Setup Notes (2026-02-26, task assignee absence hints)
- No new migration required for this iteration.
- Standard refresh is sufficient:
  - `docker compose up --build -d web caddy`
- Operational behavior update:
  - Task assignee selection now shows compact absence date-range hints in picker rows and selected chips when a user is unavailable (vacation/school) for the task due date.

## Iteration Setup Notes (2026-02-26, nickname edit/remove support)
- No new migration required for this iteration.
- Standard refresh is sufficient:
  - `docker compose up --build -d api web caddy`
- Operational behavior update:
  - Admin nickname can be set, changed, or removed from profile settings.
  - Empty nickname input now clears the current nickname and restores full-name display behavior.

## Iteration Setup Notes (2026-02-26, task sub-tasks + report follow-up carry-over)
- New DB migration added:
  - `20260226_0031_task_subtasks`
- Migration behavior:
  - idempotent guard for `tasks.subtasks` column to avoid startup failure in environments where the column already exists.
- Apply with standard update flow:
  - `docker compose up --build -d api web caddy`
  - `docker compose exec -T api alembic upgrade head`
- Operational behavior update:
  - Tasks can include sub-tasks.
  - When creating a report from a task, unchecked sub-tasks create a new unassigned follow-up task automatically.

## Iteration Setup Notes (2026-02-26, DB-safe update preflight and snapshot guard)
- No new migration required for this iteration.
- New safe operation scripts:
  - `./scripts/preflight_migrations.sh` (clones DB to temp database and runs Alembic upgrade there)
  - `./scripts/safe_update.sh --pull --branch main` (optional pull, build, preflight, backup, migrate, deploy)
- Admin update menu behavior:
  - `Dry run` now executes migration preflight on a temporary cloned DB and reports failures directly.
  - `Install update` now creates a DB snapshot and runs preflight before applying real migrations.

## Iteration Setup Notes (2026-02-26, report completed sub-tasks in work section + task-edit last-edited display)
- No new migration required for this iteration.
- Standard refresh is sufficient:
  - `docker compose up --build -d api web caddy`
- Operational behavior update:
  - Finished construction report PDF now includes completed sub-task lines inside `Ausgefuehrte Arbeiten`.
  - Task edit modal no longer exposes `Wochenstart (Montag)` input and now shows `Zuletzt bearbeitet` timestamp instead.

## Iteration Setup Notes (2026-02-26, HEIC/HEIF upload support)
- No new migration required for this iteration.
- Standard refresh is sufficient:
  - `docker compose up --build -d api web caddy`
- Operational behavior update:
  - Avatar and chat-thread icon uploads accept `.heic/.heif` even when MIME metadata is not `image/*`.
  - Avatar file picker, thread icon picker, and construction report photo picker now explicitly allow `.heic/.heif`.
  - API image dependencies include `pillow-heif` to decode/convert HEIC uploads during avatar/icon handling.

## Iteration Setup Notes (2026-02-26, project materials tab + merged report materials)
- No new migration required for this iteration.
- Standard refresh is sufficient:
  - `docker compose up -d --build --force-recreate api web caddy`
- Operational behavior update:
  - Project detail now includes `Materials` tab between project hours and job tickets.
  - Tab data is sourced from `GET /api/projects/{project_id}/materials` and merges repeated material rows from reports.
  - Material unit fields now support dropdown suggestions with manual free-text fallback.

## Iteration Setup Notes (2026-02-26, backup/restore script transport hardening)
- No new migration required for this iteration.
- Script interfaces are unchanged:
  - `./scripts/backup.sh`
  - `./scripts/preflight_migrations.sh`
  - `./scripts/restore.sh backups/<artifact>.tar.enc`
  - `./scripts/safe_update.sh --pull --branch main`
- Operational behavior update:
  - backup/preflight/restore now transfer dump/tar artifacts via stream copy (`docker compose exec -T ... cat`) instead of `docker compose cp`.
  - temp directories in those scripts are forced to `0700` after creation, making runs resilient to restrictive `umask` values.

## Iteration Setup Notes (2026-02-28, release version display consistency)
- No new migration required for this iteration.
- Standard refresh is sufficient:
  - `docker compose up --build -d api web caddy`
- Operational behavior update:
  - admin update-status now infers current release tag when placeholder version metadata is present and commit data matches release/tag metadata.
  - bottom-left user menu popup now shows `Release version` label instead of `Firmware build`.

## Iteration Setup Notes (2026-02-28, project modal drag-select close fix)
- No new migration required for this iteration.
- Standard refresh is sufficient:
  - `docker compose up -d --build web caddy`
- Operational behavior update:
  - Project create/edit modal no longer closes accidentally when text is selected and pointer is released outside modal bounds.

## Iteration Setup Notes (2026-02-28, workspace split toggle in sidebar)
- No new migration required for this iteration.
- Standard refresh is sufficient:
  - `docker compose up -d --build web caddy`
- Operational behavior update:
  - Sidebar header now includes a `Construction` / `Office` workspace toggle beside `SMPL`.
  - Current workspace selection is persisted in local browser storage and restored on reload.
  - Both workspace modes currently show the same pages until dedicated mode-specific customization is added.

## Iteration Setup Notes (2026-03-03, task/calendar labels + sorting)
- No migration required for this iteration.
- Standard frontend refresh is sufficient:
  - `docker compose up -d --build web caddy`
- Operational behavior update:
  - task/calendar entries now use project-title links for quick navigation.
  - calendar/planning day columns are rendered in due-time order.

## Iteration Setup Notes (2026-03-03, persistent report-feed chat + overview recent reports list)
- No migration required for this iteration.
- Standard refresh is sufficient:
  - `docker compose up -d --build api web caddy`
- Operational behavior update:
  - New global chat thread `Latest Construction Reports` is auto-maintained by backend report processing.
  - Processed construction report PDFs are attached to feed-thread messages for direct in-browser viewing.
  - Overview page now includes a latest-10 construction reports card sourced from `GET /api/construction-reports/recent`.

## Iteration Setup Notes (2026-03-03, report-feed sync/backfill fix)
- No migration required for this iteration.
- Standard backend refresh is sufficient:
  - `docker compose up -d --build api web caddy`
- Operational behavior update:
  - Missing `Latest Construction Reports` thread is recreated automatically when loading global chat threads.
  - Existing report PDFs missing chat linkage are backfilled into the feed thread.
  - Feed messages now include project number and project name in the text payload.

## Iteration Setup Notes (2026-03-03, report-feed thread lifecycle guardrails)
- No migration required for this iteration.
- Standard backend refresh is sufficient:
  - `docker compose up -d --build api`
- Operational behavior update:
  - `Latest Construction Reports` thread cannot be deleted.
  - Thread is not created in brand-new systems until at least one construction report has been created.

## Iteration Setup Notes (2026-03-03, compact add button in project tasks)
- No migration required for this iteration.
- Standard frontend refresh is sufficient:
  - `docker compose up -d --build web caddy`
- Operational behavior update:
  - `Project -> Tasks` now shows a compact `+` action to create tasks via modal instead of the full inline form.

## Iteration Setup Notes (2026-03-03, office tasks side menu + filters)
- No migration required for this iteration.
- Standard frontend refresh is sufficient:
  - `docker compose up -d --build web caddy`
- Operational behavior update:
  - In `Office` workspace mode, sidebar now includes `Tasks` (global tasks list view).
  - `Tasks` view supports filtering by status, assignee (including unassigned), due date, and project.
  - Switching workspace mode automatically maps task navigation between `My Tasks` (construction) and `Tasks` (office).

## Iteration Setup Notes (2026-03-03, office project search filter + undated task support)
- No migration required for this iteration.
- Standard refresh is sufficient:
  - `docker compose up -d --build web caddy`
- Operational behavior update:
  - Office tasks project filter is now searchable and supports multiple selected projects.
  - Task modal supports creating undated tasks (`due_date = null`), which do not appear in calendar/planning views until dated.

## Iteration Setup Notes (2026-03-03, office task filter UX cleanup)
- No migration required for this iteration.
- Standard frontend refresh is sufficient:
  - `docker compose up -d --build web caddy`
- Operational behavior update:
  - Office project filter suggestions now appear only while typing.
  - Office due-date filter now supports `No due date` for undated tasks.

## Iteration Setup Notes (2026-03-03, centered add-task plus icon)
- No migration required.
- Standard frontend refresh:
  - `docker compose up -d --build web caddy`

## Iteration Setup Notes (2026-03-03, overview status/report card positioning)
- No migration required.
- Standard frontend refresh:
  - `docker compose up -d --build web caddy`
- Operational behavior update:
  - Overview clock action button remains on the left in both clock-in and clock-out states.
  - Overview `Latest construction reports` is now directly below `My current status`.

## Iteration Setup Notes (2026-03-03, optional due date + overdue + image format handling)
- No migration required for this iteration.
- Standard refresh is sufficient:
  - `docker compose up -d --build api web caddy`
- Operational behavior update:
  - Task modal can create tasks without due date.
  - Overdue tasks are auto-derived and filterable in Office task view.
  - Avatar upload flow preserves common non-HEIC output formats; HEIC remains JPEG-converted path.

## Iteration Setup Notes (2026-03-03, local page startup crash fix)
- No migration required.
- Standard frontend refresh/rebuild:
  - `docker compose up -d --build web caddy`
- If browser still reports unreachable over HTTPS due local CA trust, continue using `https://localhost` and re-run local trust setup:
  - `./scripts/trust_caddy_root_macos.sh`

## Iteration Setup Notes (2026-03-04, DATANORM material catalog + picker menu)
- Migration required:
  - `20260304_0032_material_catalog_and_manual_needs.py`
- New environment variable:
  - `MATERIAL_CATALOG_DIR` (default `/data/Datanorm_Neuanlage`)
- Runtime requirement:
  - ensure the DATANORM source folder is accessible inside the API container at the configured path (for Docker setups, mount the host folder into the API service path).
- Standard refresh:
  - `docker compose up -d --build api web caddy`
- Operational behavior update:
  - Materials view now includes a catalog panel for search and add.
  - Catalog import runs automatically on first search (and whenever source file signature changes).

## Iteration Setup Notes (2026-03-05, task modal accidental-close guard)
- No migration required.
- Standard frontend refresh is sufficient:
  - `docker compose up -d --build web caddy`
- Operational behavior update:
  - Task create/edit modals no longer close from drag-selection release outside the modal card.

## Iteration Setup Notes (2026-03-05, project overview office rework/next-steps box)
- No migration required.
- Standard refresh is sufficient:
  - `docker compose up -d --build api web caddy`
- Operational behavior update:
  - Project Overview now contains an office follow-up card fed by construction report `office_rework` and `office_next_steps` entries.

## Iteration Setup Notes (2026-03-05, office-only visibility for project overview office notes card)
- No migration required.
- Standard frontend refresh is sufficient:
  - `docker compose up -d --build web caddy`
- Operational behavior update:
  - Office follow-up card in Project Overview is visible only in Office workspace mode.

## Iteration Setup Notes (2026-03-05, materials catalog search cap + stale-search guard + searchable project picker)
- No migration required.
- Standard refresh is sufficient:
  - `docker compose up -d --build api web caddy`
- Operational behavior update:
  - Materials catalog now returns/displays at most 10 rows per search.
  - Catalog search results are protected against stale overwrite from older requests.
  - Project assignment in Materials catalog uses searchable suggestions instead of a dropdown.

## Iteration Setup Notes (2026-03-05, materials project search-bar persistence + alignment)
- No migration required.
- Standard frontend refresh is sufficient:
  - `docker compose up -d --build web caddy`
- Operational behavior update:
  - Selected project is shown directly inside the materials project search bar.
  - Project selection remains visible while typing a new project search query.
  - Project/material search bars in the materials catalog are visually aligned and sized consistently.

## Iteration Setup Notes (2026-03-05, materials combobox overflow fix)
- No migration required.
- Standard frontend refresh is sufficient:
  - `docker compose up -d --build web caddy`
- Operational behavior update:
  - Long selected project labels in the materials project search bar now truncate safely and no longer collide with the material search field.

## Iteration Setup Notes (2026-03-05, materials selected project plain-text input display)
- No migration required.
- Standard frontend refresh is sufficient:
  - `docker compose up -d --build web caddy`
- Operational behavior update:
  - Selected project now appears directly as plain text inside the materials project search field (no chip/box wrapper).
  - Extra hint text for this project field was removed.

## Iteration Setup Notes (2026-03-05, materials project search overwrite loop fix)
- No migration required.
- Standard frontend refresh is sufficient:
  - `docker compose up -d --build web caddy`
- Operational behavior update:
  - Materials project search can now overwrite the current selected-project text directly without forced reinsertion while editing.

## Iteration Setup Notes (2026-03-05, office material comma-splitting fix)
- No migration required.
- Backend refresh is sufficient:
  - `docker compose up -d --build api api_worker caddy`
- Operational behavior update:
  - Construction report office material entries are now split by line only.
  - Commas inside one item description are preserved and no longer create multiple material needs.

## Iteration Setup Notes (2026-03-05, material ID autofill + project materials readability)
- No migration required.
- Standard frontend refresh is sufficient:
  - `docker compose up -d --build web caddy`
- Operational behavior update:
  - In task create/edit and construction report material rows, known item IDs now autofill row data from catalog after leaving the field.
  - Project > Materials list uses a full-width row layout for better readability.

## Iteration Setup Notes (2026-03-05, automatic zero-padding for time inputs)
- No migration required.
- Standard frontend refresh is sufficient:
  - `docker compose up -d --build web caddy`
- Operational behavior update:
  - Task start-time and report worker time inputs now auto-normalize to `HH:MM` when leaving the field, including leading-zero padding for single-digit hour/minute parts.

## Iteration Setup Notes (2026-03-05, release metadata auto-sync + local material catalog server import)
- No migration required for release metadata automation.
- New operational helper:
  - `./scripts/update_release_metadata.sh`
  - writes `apps/api/.release.env` with git-derived `APP_RELEASE_VERSION` and `APP_RELEASE_COMMIT`.
- Compose behavior update:
  - `api` and `api_worker` now read optional `apps/api/.release.env` in addition to `apps/api/.env.example`.
- Update behavior update:
  - `./scripts/safe_update.sh` now refreshes release metadata automatically before rebuild/deploy.
- Material catalog server sync:
  - ensure `./Datanorm_Neuanlage` is present on server host (mounted to `/data/Datanorm_Neuanlage`),
  - trigger catalog import by opening materials catalog in UI or by running backend import check (state endpoint/service),
  - verify imported counts via `GET /api/materials/catalog/state`.

## Iteration Setup Notes (2026-03-05, admin update flow includes release metadata refresh)
- No migration required.
- Admin update command behavior update:
  - manual command list now includes `./scripts/update_release_metadata.sh` after `git pull`.
  - auto-install flow in admin backend executes the same script before migrations.
- Operational note:
  - this keeps displayed release version/commit aligned after in-app update execution, not only shell-based `safe_update` runs.
