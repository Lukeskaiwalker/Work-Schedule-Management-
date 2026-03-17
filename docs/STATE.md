# STATE (Single Source of Truth)

## Scope
- Build a self-hosted, privacy-first workflow app for construction operations.
- MVP includes:
  - Auth + RBAC + admin tools
  - Projects/tasks/planning
  - Sites + job tickets + printable view
  - Time tracking + timesheet CSV
  - Project files
  - Project chat
  - Internal wiki knowledge base (local guides)
  - Construction report form + optional Telegram send
  - Dockerized self-hosting + encrypted backups/restore

## Current Architecture
- `apps/api`: FastAPI, SQLAlchemy, Alembic, JWT auth, RBAC, encrypted file service, audit log.
- `apps/web`: React + Vite responsive UI with sidebar modules.
- `docker-compose.yml`: `db` (Postgres), `api`, `api_worker`, `web`, `caddy` (TLS reverse proxy).
- `scripts/`: encrypted backup and restore scripts + smoke restore test.

## Milestones
1. Monorepo scaffold: completed.
2. Auth + RBAC + Admin: completed.
3. Projects/tasks/planning/tickets/time/files/chat/report: completed (MVP scope).
4. Backup/restore + docs + test hardening: completed.

## Compacted Update (2026-03-17, v1.7.2 legacy attachment decrypt regression fix)
- Changed:
  - fixed the legacy Fernet attachment validation fallback so file-handle state is reset before decrypting non-`SMPLENC2` payloads.
  - older encrypted attachments now preview/download correctly again after the `v1.7.1` pre-stream validation change.
  - added regression coverage for validating legacy Fernet payloads.
- Verified:
  - `./scripts/test.sh`: pass (`81 passed`, web build pass).
- Blockers: none.

## Compacted Update (2026-03-09, material image pipeline hardening)
- Changed:
  - material catalog image lookup now runs in two phases:
    - phase 1: EAN lookup on `unielektro.de`,
    - phase 2: fallback lookup on manufacturer/open EAN sources only after phase 1 has run across all pending items.
  - successful lookups are now cached to local disk under uploads storage and exposed through stable API URLs (`/api/materials/catalog/images/{external_key}`), so image assets survive app updates/redeploys.
  - material catalog state endpoint now exposes lookup phase and waiting-fallback counters for live sync visibility.
- Verified:
  - `docker compose run --rm api sh -lc 'cd /app && PYTHONPATH=. pytest -q tests/test_material_catalog.py'`: pass (`7 passed`).
  - `./scripts/test.sh`: pass (`79 passed`, web build pass).
- Blockers: none.

## Compacted Update (2026-03-09, migration hardening + runtime UI resilience)
- Changed:
  - removed API runtime `create_all()` bootstrap path; API startup now expects migrated schema and raises a clear error when DB schema is missing/outdated.
  - added Alembic revision `20260309_0034` for `notifications` table/indexes.
  - made notifications migration tolerant of environments where the table already exists (legacy `create_all` drift).
  - replaced per-test DB drop/recreate with row-reset strategy to keep test schema stable across test cases.
  - added top-level React error boundary to prevent full white-screen on component render crashes.
  - replaced notification bell placeholder emoji with a shared SVG icon consistent with app iconography.
- Verified:
  - `./scripts/test.sh`: pass (`76 passed`, web build pass).
  - `cd apps/web && npx tsc --noEmit`: pass.
  - `docker compose exec -T api alembic upgrade head`: pass.
- Blockers: none.

## Compacted Update (2026-03-04, material image enrichment + duplicate import reporting)
- Changed:
  - material catalog items now store image metadata (`image_url`, `image_source`, `image_checked_at`).
  - automatic EAN-based image enrichment was added:
    - manufacturer-site lookup is attempted first,
    - fallback uses open EAN sources.
  - enrichment is automatic for newly touched catalog items (catalog search and add-to-needs flow), with retry throttling and DB caching.
  - material needs and catalog responses now expose image fields so thumbnails render in the Materials tab.
  - catalog import now counts skipped duplicates and persists this in `material_catalog_import_state.duplicates_skipped`.
  - duplicate count is visible to users via new endpoint `GET /api/materials/catalog/state` and displayed in the material catalog panel.
  - reimport preserves already resolved image metadata for unchanged items.
- Verified:
  - `docker compose run --build --rm api sh -lc 'cd /app && PYTHONPATH=. pytest -q tests/test_material_catalog.py'`: pass (`3 passed`).
  - `./scripts/test.sh`: pass (`64 passed` API tests + web build pass).
- Blockers: none.

## Compacted Update (2026-03-04, DATANORM material catalog correction)
- Changed:
  - replaced heuristic material-catalog parsing with DATANORM-aware parsing for `A`/`B` records with `V` currency handling.
  - item data now maps deterministically to DATANORM semantics:
    - `article_no` from `A` record article field,
    - `item_name` from DATANORM short+long text,
    - `unit` from DATANORM unit field,
    - `ean` from `B` record GTIN/EAN field,
    - `price_text` as normalized decimal currency text.
  - import signature now includes parser-version stamp to force one automatic reimport after parser upgrades.
  - material catalog UI now also shows EAN and price metadata in search results.
- Verified:
  - `./scripts/test.sh` pass (`63 passed` API tests + web build).
  - live stack rebuilt/restarted (`docker compose up --build -d api web caddy`).
  - DB now contains `1,067,574` parsed catalog items with corrected DATANORM field mapping samples.
- Blockers: none.

## Compacted Update (2026-02-26, admin nickname for anonymized exports)
- Changed:
  - added optional admin nickname support (`nickname`) with one-time set semantics (cannot be changed after first save).
  - added nickname availability endpoint (`GET /api/auth/nickname-availability`) with uniqueness checks.
  - construction report generation now uses user `display_name` (nickname if set) for `Submitted by` fields, preventing real-name leakage in report exports.
  - assignable-user and planning/activity name rendering now prefers display name.
  - profile settings UI now includes admin nickname input with availability validation and one-time lock messaging.
- Verified:
  - frontend build pass (`cd apps/web && npm run build`).
  - backend syntax compile checks pass for modified modules.
- Blockers:
  - API tests could not be executed in this environment (`pytest` unavailable locally and Docker daemon not reachable).

## Compacted Update (2026-02-26, restricted chat participants by users/groups)
- Changed:
  - added chat visibility modes (`public` / `restricted`) with DB-backed participant memberships.
  - added employee group model + membership tables and admin-managed group CRUD API.
  - added chat participant endpoints:
    - `GET /api/threads/participant-users` (active users only),
    - `GET /api/threads/participant-groups` (groups + memberships).
  - extended chat creation payload with `participant_user_ids` and `participant_group_ids`.
  - access control now enforces restricted-thread visibility for list/read/send paths (creator always included).
  - updated new-chat UI with two multi-select dropdowns (users + employee groups), chips/tags for selections, and restricted/public helper text.
  - chat list/header now indicate restricted threads.
- Verified:
  - `./scripts/test.sh` pass (`53 passed` API tests + web build).
  - `docker compose up --build -d api web caddy` pass; `https://localhost/` and `https://localhost/api` return `200`.
- Blockers: none.

## Compacted Update (2026-02-24, async report processing + API concurrency)
- Changed:
  - moved construction-report PDF/Telegram generation into a persisted background-job pipeline (`construction_report_jobs`) instead of doing all heavy work inline in the upload request.
  - added report processing state tracking (`queued/processing/completed/failed`) and status endpoint (`GET /api/construction-reports/{id}/processing`).
  - added dedicated `api_worker` compose service to process report jobs and retry failed jobs.
  - enabled multi-worker API runtime (`API_WORKERS`) in container startup for better concurrent request handling during uploads.
  - updated report submit UI to wait on processing status after upload and show clear background-processing messaging.
- Verified:
  - `./scripts/test.sh` pass (`47 passed` API tests + web build).
  - targeted report/WebDAV regression run pass for report artifact visibility and archive/general WebDAV routing.
- Next:
  - optional: expose per-job progress metrics (phase-level) if operators want finer-grained status than queued/processing/completed.
- Blockers: none.

## Done in This Iteration
- Created monorepo structure and service skeletons.
- Implemented core API models, routes, and dependencies for MVP domains.
- Added Alembic setup and initial migration.
- Added React mobile-first UI covering all MVP modules.
- Added Docker compose stack with local TLS via Caddy.
- Added encrypted backup/restore scripts and restore smoke script.
- Added foundational docs (`DECISIONS`, `SECURITY`, `SETUP`, `TESTING`).
- Added API unit/integration tests for auth/RBAC, projects/tasks/planning, tickets/files/chat/report, and time tracking.
- Verified API tests pass locally (`3 passed`).
- Verified frontend production build passes.
- Verified `docker compose config` is valid.
- Added explicit job-ticket attachment upload/list endpoints and UI entrypoint.
- Added one-command validation runner `./scripts/test.sh` (Docker-first, local fallback).
- Integrated legacy `Telegram Arbeitsbericht` report structure into the MVP construction report flow:
  - structured payload for customer/project/workers/materials/extras/notes
  - PDF generation service for report artifacts (encrypted at rest via attachment storage)
  - Telegram live mode sends summary + PDF document, with stub fallback if not configured
- Fixed frontend async form-reset runtime bug discovered in browser smoke tests.
- Added local dev proxy override in web config (`VITE_API_PROXY_TARGET`) to support non-Docker smoke testing.
- Fixed Docker-mode test runner to:
  - run pytest with explicit `PYTHONPATH`
  - rebuild API image before test run
  - avoid polluting Postgres with test schema (tests now force SQLite env)
- Verified Docker runtime end-to-end:
  - `docker compose up -d --build` successful
  - `https://localhost/api` returns `200` with API status JSON
- Executed real browser smoke test (Playwright): login, project creation, and construction report submission flow successful.
- Reworked time tracking end-to-end:
  - Added `/api/time/current` live status endpoint.
  - Added usable clock-out path without requiring a hidden clock entry ID.
  - Added quick break controls (`/api/time/break-start`, `/api/time/break-end`).
  - Added editable time entries (`/api/time/entries`, `/api/time/entries/{id}`) for own entries and time-manager roles.
  - Added German-law default break deduction logic in totals/export (`>6h=30m`, `>9h=45m`).
- Improved chat behavior and payloads:
  - Thread payload now includes message count and last preview.
  - Message payload now includes attachment metadata.
  - Message create validates "text or attachment required".
  - UI now supports practical project-chat workflow (thread list + message stream + attachment previews).
- Improved construction report UX + legacy parity:
  - Added multipart report submit path with image uploads.
  - Stored uploaded report images as encrypted attachments.
  - Included uploaded photos and provided logo in generated report PDFs.
- Added DE/EN UI switching and applied provided logo in login/sidebar UI.
- Fixed logo runtime permission issue in containers (`403` on `/logo.jpeg`) by normalizing static file permissions.
- Ran Docker runtime and browser smoke checks after these changes:
  - Verified clock-out works in live UI.
  - Verified German UI toggle works.
  - Verified project-chat thread/message flow works.
- Hardened self-hosting resilience and restore operations:
  - Added compose restart policy (`unless-stopped`) for all services.
  - Added healthchecks for `api` and `web`, and health-based startup ordering for `web`/`caddy`.
  - Updated backup/restore scripts to auto-start required services and wait for DB readiness.
  - Upgraded restore smoke script to verify real data integrity (DB marker + uploads marker + HTTPS endpoint) and cleanup markers afterward.
- Executed improved restore smoke (`scripts/restore_smoke_test.sh`) successfully on this host.
- Fixed local Safari TLS access path:
  - Added `scripts/trust_caddy_root_macos.sh` to trust Caddy local CA in macOS keychain.
  - Updated Caddy host binding to cover `localhost`/`127.0.0.1`/`::1` (operationally use `https://localhost`).
  - Verified host-trusted HTTPS to UI/API works without curl `-k`.
- Added LAN demo accessibility for other people on the same network:
  - Added catch-all HTTP proxy route in Caddy for non-localhost hosts.
  - Added helper script `scripts/show_lan_url.sh` to print shareable LAN URL.
  - Verified host LAN URL responds for app and API endpoints.
- Refactored workspace UX per feedback:
  - Project list moved into left sidebar for direct project switching.
  - Project-related modules moved into top tab set inside workspace (`overview/tasks/planning/tickets/files/construction`).
  - Weekly planning switched to calendar-style current-week day columns with tasks listed per day.
- Decoupled chat from projects:
  - Added global chat endpoints (`/threads`) with optional project linkage.
  - Kept project-based thread filtering compatibility endpoints.
  - UI now creates and lists chat threads independently from project selection.
- Improved project files toward SharePoint-like OS integration:
  - Added WebDAV-compatible project file endpoint (`/api/dav/projects/{project_id}`) with Basic Auth.
  - Files tab now shows mount URL/instructions for OS integration.
- Simplified construction report workflow:
  - Removed weather/safety fields from UX/PDF.
  - Project number is selected via dropdown from existing projects.
  - Workers/time input changed from pipe-textarea to multi-column row editor.
- Added Alembic migration `20260218_0002` (chat threads now allow `project_id` null).
- Added/updated backend tests for:
  - global chat behavior,
  - weekly planning calendar API,
  - WebDAV project-file flow.

## Next
- Release candidate hardening complete for backend/API scope.
- Optional post-MVP: broader browser E2E coverage (Playwright) and warning cleanup in third-party dependencies.

## Known Issues / Risks
- Telegram live-send path requires local credentials in env.
- Third-party library warnings remain in test output (`passlib`/`reportlab`/`httpx` deprecations); no functional failures.
- WebDAV nested folder handling is implemented, but full client-matrix validation (Finder/Explorer/Linux desktop variants) is still recommended before broad rollout.

## MVP Acceptance Snapshot
- A) Auth + roles + admin template + server-side enforcement: implemented.
- B) Projects/tasks views + weekly planning assignment: implemented.
- C) Sites + job tickets + printable job ticket view: implemented.
- D) Clock in/out + optional breaks + timesheet + CSV export: implemented; live status, clock-out UX, legal break deduction, and editable entries added.
- E) Project files + encrypted-at-rest storage + project access controls: implemented.
- F) Project/site chat with text + image attachment support: implemented; usability and attachment display improved.
- G) Construction report form + DB storage + attachment generation + Telegram toggle (live/stub): implemented; image uploads and logo/photo PDF output added.
- H) Mobile-first responsive UI: implemented; DE/EN switch and updated UI pass browser smoke checks.
- I) Docker compose + backup/restore scripts + restore smoke script: implemented; Docker compose runtime validated.

## Compacted Update (2026-02-18)
- Changed: diagnosed reported downtime (stack was up; issue likely transient restart window), hardened compose runtime with restart policies + health dependencies, upgraded backup/restore scripts to auto-bring up dependencies and wait for DB readiness, and converted restore smoke into an integrity-verified flow (DB + uploads + HTTPS).
- Verified: `BACKUP_PASSPHRASE=smoketest-passphrase ./scripts/restore_smoke_test.sh` pass with marker restore checks; `./scripts/test.sh` pass (`3 passed` API + web build); `docker compose ps` healthy; `curl -k https://localhost/api` and `curl -k https://localhost/` both `200`.
- Next: add broader role-negative and UI E2E coverage, then clean up deprecations in FastAPI/pydantic/datetime usage.
- Blockers: none.

## Compacted Update (2026-02-18, TLS follow-up)
- Changed: added macOS trust helper script (`scripts/trust_caddy_root_macos.sh`) and updated Caddy endpoints for local host variants; documented Safari-safe access path (`https://localhost`).
- Verified: trust script executed successfully on host; `curl https://localhost/` and `curl https://localhost/api` return `200` without `-k`.
- Next: expand UI E2E coverage and cleanup deprecations.
- Blockers: none.

## Compacted Update (2026-02-18, LAN sharing)
- Changed: enabled LAN demo routing (`http://<LAN-IP>`) through Caddy while preserving local HTTPS on `https://localhost`; added `scripts/show_lan_url.sh` for quick share URL discovery.
- Verified: `curl http://192.168.2.180/` and `curl http://192.168.2.180/api` return `200`; local secure URLs remain healthy.
- Next: optional production-grade LAN TLS with managed certs/reverse proxy hostnames.
- Blockers: none.

## Compacted Update (2026-02-18, workspace/chat/report refactor)
- Changed: moved project selection into sidebar list, moved all project modules into top workspace tabs, implemented global chat threads independent from projects, replaced weekly planning with calendar week view, simplified construction report fields (project-number dropdown, worker time grid), and added WebDAV project-file access for OS mounting.
- Verified: `./scripts/test.sh` pass (`5 passed` API + web build), Docker stack healthy, `https://localhost` and `http://192.168.2.180` endpoints return `200`, and WebDAV smoke test passes (`PUT/PROPFIND/GET`).
- Next: expand UI E2E coverage for the new workspace layout and polish chat UX details (unread indicators, typing states).
- Blockers: none.

## Compacted Update (2026-02-23, business-workspace handoff bundle)
- Changed: added transfer-ready context docs `docs/HANDOFF_CONTEXT.md` and `docs/CHANGELOG_HANDOFF.md` so work can continue in a ChatGPT Business workspace without losing technical state.
- Verified: `./scripts/test.sh` pass (`37 passed` API tests + web production build).
- Next: use the new handoff docs as the initial brief in the Business workspace and continue release hardening from latest open items.
- Blockers: none.

## Compacted Update (2026-02-23, weather DE localization + overview header consistency)
- Changed:
  - weather endpoint now accepts `lang` and requests OpenWeather localized descriptions (`de`/`en`), including language-aware cache refresh behavior,
  - frontend passes UI language to weather endpoint and reloads weather when language changes,
  - project overview card headers were normalized to the same font size and top alignment across overview blocks.
- Verified: `./scripts/test.sh` pass (`37 passed` API + web build).
- Next: quick browser smoke check on project `#103` in DE mode to confirm localized weather descriptions in live UI.
- Blockers: none.

## Compacted Update (2026-02-18, "changes not visible" deploy check)
- Changed: rebuilt stale `web`/`api` images with `--no-cache` and restarted compose stack to ensure latest refactor is served; validated bundle hash rollout (`index-DfgQ217n.js`) on both localhost and LAN URL.
- Verified: browser smoke login confirms new UI is active (left project list + top project tabs + independent chat); `./scripts/test.sh` pass (`5 passed` API + web build); stack healthy in `docker compose ps`.
- Next: keep adding UI E2E coverage and continue next requested feature iteration.
- Blockers: none.

## Compacted Update (2026-02-18, overview/planning/files UX refinement)
- Changed:
  - Removed top-right project selector and moved project switching fully to left sidebar.
  - Refactored left main navigation so `Projects` becomes `Overview` (current status + assigned projects + project overview + project creation for authorized roles).
  - Moved weekly planning to a dedicated global main module (`Weekly Planning`) and removed it from project tabs.
  - Kept project-specific modules in top tabs only (`tasks`, `tickets`, `files`, `construction`) after selecting a project in sidebar.
  - Made thread creation fully project-independent in UI (chat form no longer requires/asks project selection).
  - Reworked project files view into an online explorer-style list with search, metadata, and open/download actions; retained WebDAV mount details.
- Verified:
  - `./scripts/test.sh` pass (`5 passed` API tests + web production build).
  - `docker compose up -d --build api web caddy` pass; `docker compose ps` healthy.
  - `curl https://localhost/` and `curl https://localhost/api` both return `200`.
  - Served frontend bundle contains updated strings/components for overview/planning/files explorer/chat-create flow.
- Next: add Playwright E2E checks for the new navigation flow and file explorer interactions.
- Blockers: none.

## Compacted Update (2026-02-18, tasks/files/construction/main-nav refinement)
- Changed:
  - Project task filter in project `Tasks` now uses two top-line buttons (`My tasks`, `All open tasks`) instead of a dropdown.
  - Project files UI layout was stabilized: removed separate WebDAV panel, kept file explorer in one card, and moved WebDAV mount details into a hover/focus settings bubble (cog) in the explorer header.
  - Construction report moved from project tabs into a global main navigation module; form now explicitly selects target project and stores artifacts in that project folder via existing API.
  - Project creation moved to left sidebar at project header level with a single `Create new` action and inline form toggle.
- Verified:
  - `npm run build` in `apps/web`: pass.
  - `./scripts/test.sh`: pass (`5 passed` API + web build).
  - `docker compose up -d --build`: pass; `docker compose ps` healthy.
  - `curl -k -I https://localhost/`: `200`; `curl -k https://localhost/api`: `200` with status JSON.
- Next: add Playwright E2E for new construction-report global flow and file-explorer WebDAV tooltip behavior on mobile.
- Blockers: none.

## Compacted Update (2026-02-18, project master data + modal create/edit)
- Changed:
  - Added project master-data model fields in API/DB: unique user-defined `project_number` plus customer fields (`customer_name`, `customer_address`, `customer_contact`, `customer_email`, `customer_phone`).
  - Added Alembic migration `20260218_0003` to extend `projects`, backfill existing project numbers from `id`, and enforce unique index on `project_number`.
  - Updated project create/update endpoints to validate duplicate project numbers server-side and persist customer data.
  - Replaced inline sidebar create form with modal popup opened from the smaller `Create new` button; modal now captures all project/customer fields.
  - Added project edit capability via header action (`Edit project` / `Projekt bearbeiten`) using the same modal.
  - Updated UI labels/listings to prefer business-facing `project_number` over internal numeric IDs.
- Verified:
  - `./scripts/test.sh` pass (`5 passed` API + web build).
  - `docker compose up -d --build api web caddy` pass; `docker compose ps` healthy.
  - `curl -k -I https://localhost/` and `curl -k https://localhost/api` return `200`.
  - DB schema check confirms `projects` contains new fields and unique index (`ix_projects_project_number`).
- Next: add Playwright checks for modal create/edit flow and duplicate project-number error UX.
- Blockers: none.

## Compacted Update (2026-02-18, planning/tasks multi-assignee + my-tasks flow)
- Changed:
  - Added multi-assignee task support in API (`assignee_ids`) with new `task_assignments` model/table and Alembic migration `20260218_0004`.
  - Added server endpoint `GET /users/assignable` for task planners to fetch assignable employees.
  - Enforced server-side task update behavior for employees: assigned users can mark a task complete; non-assigned users are denied.
  - Refactored weekly planning UI to calendar-only content; task creation moved to a header action button that opens a modal.
  - Weekly planning modal now supports assigning one task to multiple employees.
  - Added left-nav `My Tasks` section with project deep-link per task and project-view back button to return to `My Tasks`.
- Verified:
  - `./scripts/test.sh` pass (`5 passed` API + web build).
  - `cd apps/web && npm run build` pass.
  - `docker compose up -d --build` pass; `docker compose ps` shows healthy `db/api/web`.
  - `curl -k -I https://localhost/` returns `200`; `curl -k https://localhost/api` returns service `ok`.
- Next: add UI E2E coverage for the new My Tasks -> Project -> Back flow and multi-assignee planning modal behavior.
- Blockers: none.

## Compacted Update (2026-02-17)
- Changed: fixed time-tracking usability (clock-out, current time/status, break controls, legal break deduction, editable entries), rebuilt chat UX/data flow (including fix for empty-file message attachments), added construction report image upload + logo/photo PDF integration, added DE/EN language switch, integrated provided logo, and fixed logo static-file permission issue in containers.
- Verified: `./scripts/test.sh` pass (`3 passed` API + web build), `docker compose up -d --build` healthy, `curl -k https://localhost/api` OK, browser smoke pass for login/time/chat/language flows; screenshot stored at `output/playwright/local-smoke-20260217.png`.
- Next: backup/restore smoke validation and deeper negative/E2E coverage; reduce deprecations.
- Blockers: none for MVP operation; Telegram live mode still depends on local bot credentials.

## Compacted Update (2026-02-19, file preview/download reliability + wiki module)
- Changed:
  - Fixed file download `500 Internal Server Error` for Unicode filenames by generating RFC-compliant `Content-Disposition` headers (`filename` + `filename*`) server-side.
  - Added protected inline preview endpoint: `GET /api/files/{attachment_id}/preview`.
  - Added browser preview UX in files/chat/construction views (image/PDF/text preview without forced device download).
  - Added global Wiki module for local guides (e.g., inverter/electrical system notes):
    - DB model + Alembic migration `20260219_0005_wiki_pages`
    - API CRUD endpoints under `/api/wiki/pages`
    - Role-based access (`wiki:view` for all roles, `wiki:manage` for admin/ceo/planning)
    - Frontend left-nav Wiki view with search + create/edit/delete (role-based).
- Verified:
  - `./scripts/test.sh` pass (`6 passed` API + web build).
  - `docker compose up -d --build api web caddy` pass; stack healthy in `docker compose ps`.
  - `https://localhost/api` returns service `ok`.
  - Live smoke: `/api/files/2/download` and `/api/files/2/preview` return `200` with safe Unicode `Content-Disposition`.
  - Live smoke: wiki create/list endpoints return expected payloads.

## Compacted Update (2026-02-23, project class templates + class-based task bootstrap)
- Changed:
  - Added reusable project-class templates in backend data model with CSV template import/export endpoints in Admin tools.
  - Added project-to-class multi-assignment support during project create/edit.
  - Added automatic task bootstrap from selected classes (title + description only, no due date, no assignees).
  - Added task-level optional class selection to prefill materials/tools from assigned project classes.
  - Added frontend UI for:
    - selecting multiple classes in project modal,
    - class-based material/tool autofill in task create/edit and weekly task modal,
    - admin center class-template download/upload flow.
- Verified:
  - `./scripts/test.sh` pass (`38 passed` API tests + web build).
  - Added API integration test:
    - `test_project_class_templates_import_and_autocreate_tasks` (CSV import, assignment, auto-created tasks, class-prefilled task material behavior).
  - `docker compose up -d --build` pass; stack healthy.
- Next: add UI E2E for file-preview modal and wiki CRUD in mobile viewport.
- Blockers: none.

## Compacted Update (2026-02-22, admin user actions + sender policy)
- Changed:
  - Admin Center user-row actions moved into a contextual 3-dot menu.
  - Added admin soft-delete action for users (`DELETE /api/admin/users/{id}`) that deactivates accounts while preserving all historical data.
  - Inactive users are now blocked at login, and pending invite/reset tokens are invalidated on soft delete.
  - Invite/reset SMTP sender is now enforced as `technik@smpl-energy.de`.
- Verified:
  - `./scripts/test.sh` pass (`32 passed` API tests + web build).
  - New coverage added for soft delete behavior and enforced sender address.
- Next:
  - Final release pass focused on deployment docs consistency + last UI acceptance sweep.
- Blockers:
  - none.

## Compacted Update (2026-02-19, construction report autofill + general folder)
- Changed:
  - Construction report now supports optional project linkage:
    - project-scoped submit remains at `/api/projects/{project_id}/construction-reports`
    - new global submit endpoint `/api/construction-reports` accepts reports without project number.
  - Added report-file listing endpoint `GET /api/construction-reports/files` with optional `project_id` filter to back the construction file panel.
  - Selecting a project in the construction form now auto-imports project customer master data (name/address/contact/email/phone) and project identifiers.
  - Report form now keeps project number editable for general reports and stores those artifacts in the general reports folder view.
  - Improved readability/placement of the Telegram send option below image upload.
  - Added Alembic migration `20260219_0006_construction_reports_optional_project` (nullable `construction_reports.project_id`).
- Verified:
  - `./scripts/test.sh` pass (`6 passed` API + web build).

## Compacted Update (2026-02-22, admin encrypted DB backup + default employee role)
- Changed:
  - Added admin-only encrypted DB backup export endpoint: `POST /api/admin/backups/database` (multipart `key_file`).
  - Backup export now creates a PostgreSQL dump and encrypts it with AES-GCM using a key derived from the uploaded key file (`PBKDF2`).
  - Added admin UI flow in `Profile & settings -> Admin tools` to upload key file and download encrypted DB backup artifact.
  - Enforced default new-user role as `employee` in backend (`UserCreate` default + server-side fallback in user/invite creation).
  - Updated API image to include `postgresql-client` so `pg_dump` is available in-container.
- Verified:
  - `./scripts/test.sh` pass (`27 passed` API + web build).
  - `docker compose up -d --build && docker compose ps` pass; `db/api/web/caddy` healthy.
  - Live smoke: admin login + `POST /api/admin/backups/database` with key file returns `200` and downloadable encrypted artifact.
- Next:
  - Add restore-upload flow requiring the same key file if in-app restore is needed from admin UI.
- Blockers: none.

## Compacted Update (2026-02-22, report/image auto-sorting + WebDAV archive/general folders)
- Changed:
  - Auto-sorted construction report artifacts:
    - report PDFs now persist in `Berichte`,
    - uploaded report images now persist in `Bilder`,
    - applies to both project-bound and no-project reports.
  - Auto-foldering for project file uploads (when no folder is chosen):
    - image uploads default to `Bilder`,
    - PDF uploads default to `Berichte`.
  - Added WebDAV top-level collections under `/api/dav/projects/`:
    - `General Projects` (for reports without project),
    - `Archive` (contains archived projects).
  - Archived projects are now listed under `/api/dav/projects/archive/` instead of the active root list.
- Verified:
  - `./scripts/test.sh` pass (`28 passed` API + web build).
  - `docker compose up -d --build && docker compose ps` pass; all services healthy.
  - Added coverage for general/archive WebDAV listing and report/image folder placement.
- Next:
  - Add UI affordance to jump directly to `General Projects` and `Archive` WebDAV locations from Files/Construction screens.
- Blockers: none.

## Compacted Update (2026-02-22, profile credentials + admin invite/reset + recurrence UX)
- Changed:
  - Added self-service profile update in `Profile & settings`: user can change full name, email, and password (email/password changes require current password).
  - Added admin invite/password-reset flows with one-time tokens and optional SMTP delivery:
    - `POST /api/admin/invites`
    - `POST /api/admin/users/{id}/send-invite`
    - `POST /api/admin/users/{id}/send-password-reset`
    - `POST /api/auth/invites/accept`
    - `POST /api/auth/password-reset/confirm`
  - Extended user model with invite/reset tracking timestamps for admin-center visibility and resend handling.
  - Added pre-login token flows in web app for direct link usage:
    - `/invite?token=...` (invite accept)
    - `/reset-password?token=...` (password reset confirm)
  - Moved `Admin tools` under the left profile settings column and resized profile card layout.
  - Replaced school recurrence weekday dropdown with Monday-Friday checkbox selection in both time and profile admin forms.
- Verified:
  - `./scripts/test.sh` pass (`25 passed` API + web build).
  - `docker compose up -d --build` pass; `docker compose ps` healthy.
- Next:
  - Add optional UI screen for token-based invite acceptance/password reset pages.
  - Add Playwright coverage for admin invite/resend/reset and profile credential-change flows.
- Blockers: none.

## Compacted Update (2026-02-21, overview button + clock row + overnight time fix)
- Changed:
  - Fixed daily work-hour gauge logic to always use `daily_net_hours` (not full open-shift hours), so overnight shifts no longer inflate/shift the gauge.
  - Added local-timezone day/week boundary handling in time-tracking API (default timezone: `Europe/Berlin`) for `/api/time/current`, `/api/time/timesheet`, `/api/time/entries`, and CSV export.
  - Made the overview “all projects” action more explicit (`List/Liste` compact button next to `Projects overview/Projektübersicht`).
  - Aligned overview clock-out action in the same row as `Shift since/Schicht seit`.
- Verified:
  - `./scripts/test.sh` pass (`15 passed` API + web build).
  - `docker compose up -d --build` pass; `docker compose ps` healthy (`db/api/web/caddy`).
  - New API regression test confirms local-timezone daily boundaries for overnight/open shifts.
- Next:
  - Optional cleanup pass for remaining `datetime.utcnow()` deprecation warnings.
- Blockers: none.

## Compacted Update (2026-02-19, logout/date-time/avatar profile update)
- Changed:
  - Fixed sidebar logout control alignment so label is centered inside the compact button.
  - Updated sidebar live clock rendering to a single-line date+time string.
  - Added user profile picture support end-to-end:
    - API: encrypted avatar upload endpoint (`POST /api/users/me/avatar`) and protected avatar fetch (`GET /api/users/{user_id}/avatar`).
    - DB/model: user avatar metadata fields (`avatar_stored_path`, `avatar_content_type`, `avatar_updated_at`) with Alembic migration `20260219_0007`.
    - UI: profile settings now include avatar change flow with client-side crop controls (zoom + horizontal/vertical framing) before upload.
  - Added frontend guard to request avatar image only when a user avatar exists, avoiding repeated 404 avatar fetch noise for users without profile pictures.
  - Added API test coverage for avatar upload/preview and validation of non-image rejection.
- Verified:
  - `./scripts/test.sh` pass (`7 passed` API + web build).
  - `docker compose up -d --build` pass; `docker compose ps` shows healthy `db/api/web/caddy`.
  - `curl -k -I https://localhost/` -> `200`; `curl -k https://localhost/api` -> service `ok`.
  - Real-browser smoke (Playwright) confirms profile settings contains avatar-change modal and sidebar footer date/time is rendered on one line; screenshot artifact: `output/playwright/profile-avatar-modal-20260219.png`.
- Next:
  - Add drag-to-pan avatar crop interaction (currently slider-based crop controls).
  - Continue with broader UI E2E coverage for profile/settings flows.
- Blockers: none.
  - `docker compose up -d --build` pass; `docker compose ps` healthy (`db/api/web/caddy`).
  - `curl -k https://localhost/api` returns service `ok`; `curl -k -I https://localhost/` returns `200`.
- Next:
  - Add Playwright E2E coverage for report auto-fill, general-report flow, and mobile construction layout.
  - Continue deprecation cleanup (pydantic config, naive UTC, FastAPI startup events).
- Blockers: none.

## Compacted Update (2026-02-19, sidebar/files/planning layout polish)
- Changed:
  - Reworked sidebar structure so language switching is now compact and positioned at the left-bottom.
  - Added a left-bottom signed-in user block with profile-style avatar initials + name/role.
  - Increased top-left logo size for better visibility.
  - Reduced `Create new` project button visual weight to a smaller control.
  - Replaced project-files upload card with a compact upload icon that opens a modal upload popup.
  - Expanded weekly planning calendar visual footprint (larger day cards, full-width weekly layout on desktop).
- Verified:
  - `./scripts/test.sh` pass (`6 passed` API + web build).
  - `docker compose up -d --build` pass; `docker compose ps` healthy.
  - `curl -k -I https://localhost/` returns `200`.
  - `curl -k https://localhost/api` returns service `ok`.
- Next:
  - Add Playwright UI checks for sidebar footer interactions and upload-modal behavior in project files.
  - Continue deprecation cleanup (FastAPI startup hooks, pydantic config, timezone-aware UTC migration).
- Blockers: none.

## Compacted Update (2026-02-19, profile entrypoint + single-active sidebar + dual-scroll layout)
- Changed:
  - Project files upload trigger icon changed to a smaller upload-arrow control in the file explorer header.
  - Sidebar profile avatar/name block is now clickable and opens a dedicated `Profile & settings` page.
  - Added `Profile & settings` main view with user identity details and embedded admin center for admin users.
  - Sidebar active-state logic now enforces one highlighted navigation context:
    - project highlight appears only while `Project` view is active.
    - selecting top-level modules no longer leaves a project item highlighted.
  - Desktop layout updated to independent scroll containers for sidebar and main content (`two scrollbars` behavior when one side is taller).
- Verified:
  - `./scripts/test.sh` pass (`6 passed` API + web build).
  - `docker compose up -d --build` pass; `docker compose ps` healthy.
  - `curl -k -I https://localhost/` returns `200`.
  - `curl -k https://localhost/api` returns service `ok`.
- Next:
  - Add Playwright coverage for profile-avatar navigation and single-active sidebar highlighting.
  - Continue deprecation cleanup (FastAPI startup hooks, pydantic config, timezone-aware UTC migration).
- Blockers: none.

## Compacted Update (2026-02-19, sidebar controls + planning week controls + file preview window)
- Changed:
  - Project files upload arrow icon now uses the same control footprint as the WebDAV cog icon.
  - Project files preview action now opens in a separate browser window/tab via `/api/files/{id}/preview` (no inline popup modal).
  - Sidebar footer controls were compacted:
    - language buttons and logout are now on one row.
    - logout matches compact control font sizing and aligns to the right side.
  - Current date/time moved from top header into the left sidebar footer directly below the user card.
  - Project creation trigger switched to a compact plus-icon button in the project header row.
  - Weekly planning now shows ISO calendar week (`KW/CW`) and includes previous/next week arrow controls.
  - Weekly planning week-start date picker now normalizes to Monday.
- Verified:
  - `./scripts/test.sh` pass (`6 passed` API + web build).
  - `docker compose up -d --build` pass; `docker compose ps` healthy.
  - `curl -k -I https://localhost/` returns `200`.
  - `curl -k https://localhost/api` returns service `ok`.
- Next:
  - Add Playwright checks for week-arrow navigation and file preview opening in a new tab/window.
  - Continue deprecation cleanup (FastAPI startup hooks, pydantic config, timezone-aware UTC migration).
- Blockers: none.

## Compacted Update (2026-02-19, sidebar control alignment + admin role restore)
- Changed:
  - Fixed project header plus-button alignment:
    - plus glyph is centered in its box.
    - project title and plus control remain aligned on one row on mobile/desktop.
  - Normalized compact footer control sizing:
    - `DE`, `EN`, and `Sign out` now share the same height and text sizing.
  - Restored primary admin account role in DB:
    - `admin@example.com` changed from `ceo` back to `admin`.
- Verified:
  - `./scripts/test.sh` pass (`6 passed` API + web build).
  - `docker compose up -d --build` pass; `docker compose ps` healthy.
  - `curl -k -I https://localhost/` returns `200`.
  - `curl -k https://localhost/api` returns service `ok`.
  - DB check confirms role restore: `SELECT id,email,role FROM users WHERE id=1;` -> `admin`.
- Next:
  - Add Playwright UI assertion for compact footer-control equal-height rendering.
  - Continue deprecation cleanup (FastAPI startup hooks, pydantic config, timezone-aware UTC migration).
- Blockers: none.

## Compacted Update (2026-02-20, avatar drag-crop + chat thread header + planning today highlight)
- Changed:
  - Profile picture change in `Profile & settings` now uses a hover overlay directly on the avatar (instead of a separate button).
  - Avatar crop modal now supports drag-to-position with pointer/mouse/touch and keeps only zoom slider control.
  - Weekly planning calendar now highlights the current day with a dedicated visual state.
  - Chat threads panel now starts directly below its header and thread creation moved to a compact plus icon in the header (project-style).
  - Sidebar date/time rendering was normalized to a compact one-line format and logout label centering was tightened.
- Verified:
  - `./scripts/test.sh` pass (`7 passed` API + web build).
  - `docker compose up -d` pass; `docker compose ps` healthy (`db/api/web/caddy`).
- Next:
  - Add Playwright assertions for avatar hover overlay + drag crop behavior and planning-day highlight.
  - Continue deprecation cleanup (FastAPI startup hooks, pydantic config, timezone-aware UTC migration).
- Blockers: none.

## Compacted Update (2026-02-20, applied to running test stack)
- Changed:
  - Rebuilt and force-recreated `web` + `caddy` (and refreshed `api` image) so the latest avatar/chat/planning UI changes are active in the currently running Docker test environment.
- Verified:
  - `docker compose ps` healthy for `db/api/web/caddy`.
  - `curl https://localhost/` -> `200`.
  - `curl https://localhost/api` -> `{"service":"SMPL Workflow API","status":"ok"}`.
  - `./scripts/test.sh` pass (`7 passed` API + web build).
- Next:
  - Optional: quick Playwright click-through on profile/chat/planning screens against running stack.
- Blockers: none.

## Compacted Update (2026-02-20, chat UX + thread icons + unread counters)
- Changed:
  - Chat threads now support creator metadata, thread icon upload, and creator/chat-manager edit of thread name.
  - Added per-user read state for threads and server-side unread counters (`unread_count`) for thread list rendering.
  - Messages API now marks thread as read when opened, so unread badges clear after viewing.
  - Messages UI switched to a messenger-style layout (compact bubbles, dedicated thread list, larger thread spacing).
  - Thread list now shows avatar/icon, active state, and unread badge count.
  - Messages workspace header now displays the current thread name + icon.
  - Thread create/edit modal now supports optional thread picture upload.
- Verified:
  - `./scripts/test.sh` pass (`7 passed` API + web build).
  - `docker compose up -d --build api web` pass.
  - `docker compose ps` healthy for `db/api/web/caddy`.
  - `curl -k -I https://localhost/` -> `200`.
  - `curl -k https://localhost/api` -> `{"service":"SMPL Workflow API","status":"ok"}`.
- Next:
  - Add Playwright coverage for unread badge lifecycle and thread icon edit flow.
  - Consider pagination for very large thread/message histories.
- Blockers: none.

## Compacted Update (2026-02-20, chat composer controls + header cleanup)
- Changed:
  - Removed duplicate current-thread label from the workspace header in the messages view.
  - Chat message bubbles now size to message content (`fit-content`) for a tighter messenger feel.
  - Composer now uses a left-side compact `+` attachment control, center text input, and right-side send-arrow button.
  - Send button now follows requested state behavior:
    - blue background + white arrow when message text is present.
    - gray background when message input is empty.
- Verified:
  - `./scripts/test.sh` pass (`7 passed` API + web build).
  - `docker compose up -d --build web` pass and running stack updated.
  - `docker compose ps` healthy for `db/api/web/caddy`.
  - `curl -k -I https://localhost/` -> `200`.
  - `curl -k https://localhost/api` -> `{"service":"SMPL Workflow API","status":"ok"}`.
- Next:
  - Add Playwright assertion for send-button enabled/disabled visual state and composer control alignment on mobile widths.
- Blockers: none.

## Compacted Update (2026-02-20, fixed chat panel height + internal message scroll)
- Changed:
  - Locked messages pane (`chat-panel`) to a fixed viewport height so the thread window no longer grows/shrinks with message count.
  - Enabled guaranteed internal scrolling for message history (`message-list`) with constrained panel overflow.
  - Applied same fixed-height behavior on mobile breakpoint for consistent interaction.
- Verified:
  - `./scripts/test.sh` pass (`7 passed` API + web build).
  - `docker compose up -d --build web` pass and running stack updated.
  - `docker compose ps` healthy for `db/api/web/caddy`.
  - `curl -k -I https://localhost/` -> `200`.
  - `curl -k https://localhost/api` -> `{"service":"SMPL Workflow API","status":"ok"}`.
- Next:
  - Add Playwright check for long-thread scroll behavior in the message list container.
- Blockers: none.

## Compacted Update (2026-02-20, chat attachment send fix + auto-follow newest message)
- Changed:
  - Fixed chat send gating to allow attachment-only messages (no text required) so file uploads in threads are actually posted.
  - Kept requested visual rule: send arrow stays gray when text is empty, but it now remains usable when an attachment is selected.
  - Improved message bubble sizing:
    - tighter header layout to avoid occasional oversized message boxes.
  - Added message-list follow behavior:
    - after sending, chat auto-scrolls to newest message.
    - while user is at bottom, incoming updates keep following newest messages.
    - if user scrolls up to read history, auto-follow pauses until near-bottom again.
- Verified:
  - `./scripts/test.sh` pass (`7 passed` API + web build).
  - `docker compose up -d --build web` pass and running stack updated.
  - `docker compose ps` healthy for `db/api/web/caddy`.
  - `curl -k -I https://localhost/` -> `200`.
  - `curl -k https://localhost/api` -> `{"service":"SMPL Workflow API","status":"ok"}`.
- Next:
  - Add Playwright scenario for attachment-only chat send and auto-follow scroll checks.
- Blockers: none.

## Compacted Update (2026-02-20, attachment draft UX + bubble sizing reliability)
- Changed:
  - Hardened chat send path to always include selected file uploads even when text is empty, with submit-time fallback to the file input value.
  - Added WhatsApp-like attachment draft chip in composer:
    - selected file name is shown before send
    - message text can still be edited
    - attachment can be removed before sending via `x`.
  - Added explicit send-time scroll snap to bottom so the newest outgoing message is visible immediately.
  - Refined message-bubble layout from grid-based items to flex-based content sizing to prevent occasional oversized bubbles.
  - Added regression test for attachment-only chat messages using `attachment` form field.
- Verified:
  - `./scripts/test.sh` pass (`7 passed` API + web build).
  - `docker compose up -d --build web caddy` pass; services healthy in `docker compose ps`.
  - `curl -k -I https://localhost/` -> `200`.
  - `curl -k https://localhost/api` -> `{"service":"SMPL Workflow API","status":"ok"}`.
- Next:
  - Add Playwright assertion for attachment draft chip add/remove and attachment-only send in live UI.
- Blockers: none.

## Compacted Update (2026-02-20, time gauge + configurable required hours)
- Changed:
  - Added per-user `required_daily_hours` (default `8.0`) in DB/API via Alembic migration `20260220_0009_user_required_daily_hours`.
  - Added admin/CEO endpoint to set employee target hours: `PATCH /api/time/required-hours/{user_id}`.
  - Extended `/api/time/current` with gauge-ready fields:
    - `required_daily_hours`
    - `daily_net_hours`
    - `progress_percent_live`
    - manager-aware `user_id` query support.
  - Updated overview status card with compact hours gauge and contextual clock-in/clock-out action.
  - Updated time tracking page with full gauge (shows overtime as `>100%`), safer clock/break button states, and admin/CEO required-hours editor.
- Verified:
  - `./scripts/test.sh` pass (`7 passed` API + web build).
  - `docker compose up -d --build` pass; `db/api/web/caddy` healthy.
  - Runtime API check confirms new `/api/time/current` fields are returned.
- Next:
  - Add Playwright UI coverage for gauge rendering and required-hours edit flow.
- Blockers: none.

## Compacted Update (2026-02-20, Excel project import + dynamic extra attributes)
- Changed:
  - Added new project attribute `extra_attributes` (JSON) to persist source columns that do not exist as first-class project fields.
  - Added Alembic migration `20260220_0010_project_extra_attributes`.
  - Added Excel import service + CLI script:
    - `apps/api/app/services/project_import.py`
    - `apps/api/scripts/import_projects_excel.py`
    - `scripts/import_projects_excel.sh` (host wrapper for `docker compose cp + exec`)
  - Import mapping now supports German headers (`Nr.`, `Projektname`, `Kunde`, `Ansprechpartner`, `Adresse`, `Telefonnummer`, `E-Mail`, `Aktueller Status`, `Notiz`, etc.).
  - Missing project numbers are auto-assigned as temporary markers prefixed with `T` (for example `T00001`).
  - Fixed restore smoke marker insert to include `project_number` after project-number schema hardening.
- Imported data:
  - Source file: `KW 8 Projektstatus SMPL Energy Verwaltung.xlsx`
  - Imported into live Docker DB: `processed=42`, `created=42`, `updated=0`, `temporary_numbers=2`.
- Verified:
  - `./scripts/test.sh` pass (`10 passed` API + web build).
  - `docker compose up -d --build` pass; `db/api/web/caddy` healthy.
  - Post-import DB sample confirms imported project numbers and customer/project names populated.
- Next:
  - Optional: add UI view for `extra_attributes` key/value metadata in project details.
- Blockers: none.

## Compacted Update (2026-02-20, sidebar project UX + project header + Excel status/notiz normalization)
- Changed:
  - Sidebar project area now uses an internal scroll container so long project lists no longer overlap/push out the footer user panel.
  - Project list rows now render as requested:
    - first line: `customer | project_number`
    - second line (smaller): project name.
  - Project workspace header no longer shows `Active project`; it now shows:
    - main title: customer (fallback `project_number`)
    - subtitle: project name.
  - Added visible project summary card in project context with `Customer`, `Project number`, `Status`, and `Notiz` (mapped from project description / imported note data).
  - Project modal label updated from generic description to `Notiz/Note`.
  - Excel import status normalization now maps source values to canonical project states:
    - `active`, `on_hold`, `completed`.
  - Reimported live Excel data and normalized legacy non-canonical statuses in DB.
- Verified:
  - `./scripts/test.sh` pass (`11 passed` API + web build).
  - `docker compose up -d --build api web` pass; `db/api/web/caddy` healthy.
  - `./scripts/import_projects_excel.sh "KW 8 Projektstatus SMPL Energy Verwaltung.xlsx"` pass.
  - DB check: all project rows now in canonical status set (`active/on_hold/completed`), current data is `active`.
  - DB check: imported notes persisted (`description` non-empty rows present).
- Next:
  - Optional: expose selected `extra_attributes` fields in a dedicated project metadata panel.
- Blockers: none.

## Compacted Update (2026-02-20, Excel parity import fields + dedupe + project status vocabulary)
- Changed:
  - Added first-class project fields `last_state` and `last_status_at` (DB model/schema + API exposure).
  - Added Alembic migration `20260221_0011_project_last_state_fields`.
  - Excel import now:
    - reads all workbook sheets by default (not only first sheet),
    - maps `Notiz` -> `last_state`,
    - maps `Letzter Status Datum` -> `last_status_at`,
    - keeps `Aktueller Status` as real project status text (full source vocabulary),
    - deduplicates repeated entries across multi-table sheets,
    - is idempotent across repeated imports (no new temp duplicates on rerun),
    - skips identity-less rows instead of generating noisy temporary projects.
  - Import CLI output now includes `duplicates_skipped`.
  - UI project details now show:
    - full status vocabulary,
    - `Last state`,
    - `Last status update` timestamp.
  - Project status input changed from fixed 3-option select to free input with datalist suggestions.
  - One-time data cleanup merged/remapped legacy duplicate temporary projects from earlier imports.
- Imported data (live):
  - `./scripts/import_projects_excel.sh "KW 8 Projektstatus SMPL Energy Verwaltung.xlsx"`
  - result: `processed=70, created=0, updated=68, temporary_numbers=0, duplicates_skipped=2`.
- Verified:
  - `./scripts/test.sh` pass (`13 passed` API + web build).
  - `docker compose up -d --build api web` pass; running services healthy.
  - Re-import twice gives same result (`created=0` on each run).
  - DB check confirms Excel statuses are present as source values and `last_state`/`last_status_at` are populated.
- Next:
  - Optional: expose a dedicated project timeline widget that sorts by `last_status_at`.
- Blockers: none.

## Compacted Update (2026-02-20, sidebar nav icons + light-blue theme + German umlauts)
- Changed:
  - Added semantic icons to all left sidebar main navigation items above the project list (`overview`, `my tasks`, `weekly planning`, `construction report`, `wiki`, `chat`, `time tracking`).
  - Updated nav button layout so icon + label are left-aligned.
  - Restyled left main-nav buttons to blend into the sidebar by default:
    - removed always-visible boxed button appearance for these entries,
    - added subtle hover/focus card styling per item,
    - kept a clear active state highlight.
  - Switched global UI palette/background from warm beige to light blue tones (page background + sidebar gradient + surface accents).
  - Updated German UI copy to use proper umlauts across relevant labels/messages (for example `Übersicht`, `Zurück`, `Fällig`, `Löschen`, `ändern`, `verfügbar`, `über`).
- Verified:
  - `./scripts/test.sh` pass (`13 passed` API tests + web production build).
  - `docker compose ps` shows `db/api/web/caddy` up and healthy where applicable.
- Next:
  - Optional: add Playwright visual checks for sidebar hover/active styles and icon alignment on mobile breakpoints.
- Blockers: none.

## Compacted Update (2026-02-20, pre-user popup menu in sidebar footer)
- Changed:
  - Added a new compact pre-user popup menu directly above the sidebar user segment.
  - Moved language selection (`DE`/`EN`) and logout action from the footer row into this popup.
  - Added `User data` action in the popup to open the existing profile/user settings view.
  - Added readouts in the popup for:
    - current firmware build (from `VITE_APP_BUILD`, fallback `local-<mode>`),
    - employee ID (current user id).
  - Added outside-click and `Escape` handling so the popup closes reliably.
  - Removed the old visible footer controls row since its actions now live in the popup.
- Verified:
  - `./scripts/test.sh` pass (`13 passed` API tests + web production build).
  - `docker compose up -d --build web` pass and running stack healthy.
  - `curl -k -I https://localhost/` returns `HTTP/2 200`.
- Next:
  - Optional: add a dedicated build label source from CI metadata (`VITE_APP_BUILD`) for deterministic release IDs.
- Blockers: none.

## Compacted Update (2026-02-20, pre-user menu trigger on user card only)
- Changed:
  - Removed the extra standalone `Menu` button above the user card.
  - Rewired the pre-user popup to open/close directly when pressing the user card in the sidebar footer.
  - Kept `User data` inside the popup as the path to the original profile/user settings screen.
  - Cleaned up now-unused pre-user toggle/footer-control CSS blocks.
- Verified:
  - `./scripts/test.sh` pass (`13 passed` API tests + web production build).
  - `docker compose up -d --build web` pass; `db/api/web/caddy` healthy in `docker compose ps`.
  - `curl -k -I https://localhost/` returns `HTTP/2 200`.
- Next:
  - Optional: add a small chevron indicator on the user card to show popup open/closed state.
- Blockers: none.

## Compacted Update (2026-02-21, project status dropdown + extended project edit + task form upgrade)
- Changed:
  - Project edit/create modal now includes all currently displayed status fields:
    - `status` as a true dropdown (options sourced from presets + all project statuses currently in DB/imported Excel data),
    - `last_state`,
    - `last_status_at` (`datetime-local`).
  - Added new task data model fields end-to-end (DB/API/UI):
    - `materials_required`,
    - `storage_box_number`,
    - `start_time`.
  - Added Alembic migration `20260221_0012_task_planning_fields`.
  - Project task-create block now supports:
    - title,
    - information/description,
    - required materials,
    - optional warehouse storage box number toggle + numeric input,
    - due date + start time,
    - employee assignment via type-to-search autocomplete with unlimited multi-select chips.
  - Project task list UI updated to show new task timing/material fields.
  - Task list header in project view was restructured so the `Tasks/Aufgaben` heading is anchored at the top-left, with view toggles below.
- Verified:
  - `./scripts/test.sh` pass (`13 passed` API tests + web production build).
  - `docker compose up -d --build` pass (`db/api/web/caddy` healthy).
  - `curl -k -I https://localhost/` returns `HTTP/2 200`.
- Next:
  - Optional: add task edit modal so managers can change `materials_required`, `storage_box_number`, and `start_time` after creation.
- Blockers: none.

## Compacted Update (2026-02-21, overview shortcuts + compact status + filtered overview)
- Changed:
  - Overview page now starts with three equal quick-action boxes directly below the header:
    - `Construction Report`,
    - `Time Tracking`,
    - `Wiki`,
    - each keeps the same icon set used previously in sidebar navigation.
  - Removed old left-sidebar entries for `Construction Report`, `Time Tracking`, and `Wiki` (access now via overview quick actions).
  - Refactored overview content cards:
    - `My current status` made more compact (time + compact gauge + clock-in/out actions),
    - `My projects` now shows only the 10 most recent assigned-project entries, ordered by latest update signal (`last_status_at` / imported status date fallback),
    - `Projects overview` now includes a state/status dropdown and shows only projects matching the selected state filter.
  - Added targeted overview styling to keep shortcut boxes/content compact and avoid unnecessary full-width stretching.
- Verified:
  - `./scripts/test.sh` pass (`13 passed` API tests + web production build).
  - `docker compose up -d --build` pass (`db/api/web/caddy` healthy).
  - `curl -k -I https://localhost/` returns `HTTP/2 200`.
- Next:
  - Optional: add persistent per-user memory for the selected project-state filter on overview.
- Blockers: none.

## Compacted Update (2026-02-21, overview polish: state filter alignment + action sizing + clock button alignment)
- Changed:
  - Overview `Projects overview` filter row refined:
    - status label + select now render inline on the same row as requested.
  - Increased top overview shortcut button dimensions slightly:
    - higher visual height and a bit wider width calculation.
  - Aligned time actions in `My current status`:
    - clock in/out controls now use a dedicated left-aligned action block under the gauge.
  - Added/updated supporting CSS classes:
    - `.overview-status-actions`,
    - `.overview-state-filter` (+ inline label/select behavior),
    - refined `.overview-shortcut-card` sizing.
- Verified:
  - `./scripts/test.sh` pass (`13 passed` API tests + web production build).
  - `docker compose up -d --build` pass (`db/api/web/caddy` healthy).
- Next:
  - Optional: make overview shortcut card width user-adjustable via a compact/comfortable UI density toggle.
- Blockers: none.

## Compacted Update (2026-02-21, overview final layout tweaks: clock action + project row formatting)
- Changed:
  - Enforced left alignment for overview clock actions under the gauge:
    - added explicit button alignment rules in `.overview-status-actions button` to avoid right-side drift.
  - Reworked `Projects overview` item formatting:
    - first line now shows `project number | customer name`,
    - second line keeps compact metrics and now also includes the plain status value only (no `Status:` prefix).
  - Added robust customer-name fallback on overview rows:
    - uses `row.customer_name` when present, otherwise resolves from loaded project data by `project_id`.
- Verified:
  - `./scripts/test.sh` pass (`13 passed` API tests + web production build).
  - `docker compose up -d --build` pass (`db/api/web/caddy` healthy).
- Next:
  - Optional: expose customer name directly in `/projects-overview` API payload to remove UI-side fallback lookup.
- Blockers: none.

## Compacted Update (2026-02-21, overview clock-out alignment correction)
- Changed:
  - Corrected the previous alignment tweak:
    - the `Clock out` button in overview now aligns to the right side of the gauge area again (only for active/open shift state).
  - Implementation details:
    - active-shift row now uses `overview-status-actions is-running`,
    - `.overview-status-actions.is-running button { justify-self: end; }`.
- Verified:
  - `./scripts/test.sh` pass (`13 passed` API tests + web production build).
  - `docker compose up -d --build` pass (`db/api/web/caddy` healthy).
- Next:
  - Optional: split alignment behavior explicitly (`clock-in` left, `clock-out` right) with dedicated CSS utility classes for future clarity.
- Blockers: none.

## Compacted Update (2026-02-21, all-projects page + overnight gauge fix + overview clock row)
- Changed:
  - Added a new dedicated full-width `All projects` page (`mainView: projects_all`) reachable from a small button directly beside `Projects overview` on the main overview card.
  - New `All projects` view includes:
    - search bar (project number/customer/project name/last state),
    - state filter,
    - last-edited filter (`7d`, `30d`, `90d`, `older than 90d`, `without date`),
    - list rows matching overview format plus extra `Last state` and `Last edited` details.
  - Overview `Clock out` action row now renders in the same horizontal line as `Shift since`.
  - Time gauge logic now uses live shift net hours while a shift is open (`net_hours_live`) so overnight sessions keep progressing correctly.
  - Backend time tracking period math now handles shifts crossing midnight:
    - `/api/time/current` daily total now includes overlapping entries,
    - `/api/time/timesheet` and CSV export now use overlap-aware period calculations,
    - `/api/time/entries` period query includes overlapping shifts.
  - Added overnight regression test in `apps/api/tests/test_workflows.py`:
    - `test_time_tracking_counts_overnight_shift_in_daily_current`.
- Verified:
  - `./scripts/test.sh` pass (`14 passed` API tests + web production build).
  - `docker compose up -d` pass.
  - `docker compose ps` healthy (`db/api/web/caddy`).
- Next:
  - Optional: expose `last_state`/`last_status_at` directly from `/projects-overview` payload to remove frontend enrichment fallback.
- Blockers: none.

## Compacted Update (2026-02-21, projects-all header cleanup + contextual back navigation + circular gauge wrap)
- Changed:
  - Removed redundant subheader text inside the `All projects` page content card (main workspace header already provides context).
  - Added contextual navigation from project detail:
    - when a project is opened from `All projects`, header tools now show `Back to All Projects` in the same control row as `Edit project`.
  - Updated `All projects` -> project click behavior to persist return context (`projectBackView = projects_all`).
  - Replaced linear work-hours gauge with a circular gauge:
    - progress wraps safely after 100% (no overflow past gauge bounds),
    - overtime continues as additional full turns,
    - compact and regular variants both supported.
- Verified:
  - `./scripts/test.sh` pass (`15 passed` API tests + web production build).
- Next:
  - Optional: animate ring sweep on live updates for smoother visual feedback.
- Blockers: none.

## Compacted Update (2026-02-21, gauge color behavior)
- Changed:
  - Updated time-tracking circular gauge color logic to stay blue for both normal progress and overtime rotations.
  - Gauge remains fully filled at 100% and wraps beyond 100% without overflow, now with the same blue ring color.
- Verified:
  - `./scripts/test.sh` pass (`15 passed` API tests + web production build).
- Next:
  - Optional: add subtle ring animation to make overtime wrap transitions more obvious.
- Blockers: none.

## Compacted Update (2026-02-21, gauge full-fill after target)
- Changed:
  - Updated circular gauge fill behavior so once worked time reaches required hours (`>=100%`), the ring stays fully filled.
  - Overtime still remains blue and metadata (`Overtime`, `Full turns`) remains visible.
- Verified:
  - `./scripts/test.sh` pass (`15 passed` API tests + web production build).
- Next:
  - Optional: add a dedicated overtime indicator ring so full-fill and overtime-progress can both be visible simultaneously.
- Blockers: none.

## Compacted Update (2026-02-21, time tracking layout + weekly/monthly gauges + admin-center required hours)
- Changed:
  - Time tracking page refactor:
    - Daily circular gauge center text was vertically re-centered.
    - Current shift card was compacted into a two-column layout (gauge + key shift metrics).
    - Added monthly half-circle gauge (worked vs required monthly hours).
    - Added weekly linear gauges for all weeks intersecting the current month, each with `KW` + `(dd.mm. - dd.mm.)`, worked hours, and required hours.
  - German localization update:
    - Changed overtime label from `Überzeit` to `Überstunden`.
  - Required-hours management moved out of the time page:
    - Removed `required hours/day` editor from Time Tracking.
    - Added required-hours controls to Admin Center areas (profile admin table + dedicated Admin Center required-hours card).
- Verified:
  - `./scripts/test.sh` pass (`15 passed` API tests + web production build).
  - `docker compose up -d --build web caddy` pass (services healthy).
  - `curl -k -I https://localhost/` returns `HTTP/2 200`.
- Next:
  - Optional: add a dedicated endpoint that returns monthly weekly totals in one call to reduce frontend request fan-out.
- Blockers: none.

## Compacted Update (2026-02-21, admin center dedupe + gauge overtime gradient + weekly label formatting)
- Changed:
  - Removed duplicate profile-level `Admin Center · Required hours` card; kept a single original Admin Center table with inline required-hours controls for employees.
  - Time tracking readability/layout:
    - current shift card now spans full width,
    - monthly/weekly card now spans full width,
    - prevents shift metrics text from being visually crowded/obscured.
  - Daily gauge behavior:
    - removed `full turns`/round counter from UI,
    - added overtime color transition after 100% from blue toward complementary red, intensifying until 200%.
  - Weekly rows:
    - removed brackets around date range,
    - `KW` label styled in lighter black,
    - added `|` separator between worked and required weekly hours,
    - first/last month-intersecting weeks now display full Monday-Sunday ranges and full-week required-hour totals.
- Verified:
  - `./scripts/test.sh` pass (`15 passed` + web build).
  - `docker compose up -d --build web caddy` pass.
  - `curl -k -I https://localhost/` -> `HTTP/2 200`.
- Next:
  - Optional: tune overtime gradient stops (100/150/200) with designer-approved color tokens.
- Blockers: none.

## Compacted Update (2026-02-21, time page month switch + side-by-side cards + legal-break label cleanup)
- Changed:
  - Removed `(DE)` token from legal-break helper text in time tracking (`Gesetzliche Pause: ...`).
  - Time page layout adjusted so `Current shift` and `Monthly/weekly hours` cards render side-by-side on desktop (still stacked on mobile).
  - Added month navigation to monthly overview:
    - current month + year label,
    - left/right arrow buttons,
    - weekly/monthly gauge data reloads for selected month.
- Verified:
  - `./scripts/test.sh` pass (`15 passed` API tests + web build).
  - `docker compose up -d --build web caddy` pass.
  - `curl -k -I https://localhost/` -> `HTTP/2 200`.
- Next:
  - Optional: disable forward-month arrow beyond current month if future-month reporting should be blocked.
- Blockers: none.

## Compacted Update (2026-02-21, current-shift info popover + monthly gauge center text cleanup)
- Changed:
  - Moved detailed shift/legal information into a sub info popover opened by hover/click on current time beside `Aktuelle Schicht` header.
  - Popover now contains:
    - `Schicht-ID`, `Eingestempelt`, `Arbeitszeit`, `Pause`, `Gesetzliche Pause`, `Nettozeit Schicht`, and legal-break rule note.
  - Removed those detailed lines from the main shift card body.
  - Monthly half-gauge center now shows:
    - larger worked-hours number,
    - only a gray helper text (`von Soll-Monatsstunden` / `from required monthly hours`),
    - removed `month` + percentage center lines.
- Verified:
  - `./scripts/test.sh` pass (`15 passed` API tests + web build).
  - `docker compose up -d --build web caddy` pass.
  - `curl -k -I https://localhost/` -> `HTTP/2 200`.
- Next:
  - Optional: add small info icon next to current time for clearer affordance that details are expandable.
- Blockers: none.

## Compacted Update (2026-02-21, contextual time buttons + time-info trigger placement + monthly required-hours number)
- Changed:
  - Time action buttons are now contextual:
    - one clock button (`Einstempeln` or `Ausstempeln` depending on shift state),
    - one break button (`Pause Start` or `Pause Ende` depending on break state when shift is open).
  - Moved current-time info trigger to sit directly after `Aktuelle Schicht` header (no longer right-aligned).
  - Monthly half-gauge subline now displays the actual required monthly hours value (for example `168.00h`) instead of the text label.
- Verified:
  - `./scripts/test.sh` pass (`15 passed` API tests + web build).
  - `docker compose up -d --build web caddy` pass.
  - `curl -k -I https://localhost/` -> `HTTP/2 200`.
- Next:
  - Optional: style the required-hours value with a muted label prefix (`Soll`) if you want clearer semantics.
- Blockers: none.

## Compacted Update (2026-02-21, monthly-required-hours boundary + time popover placement + all-role required-hours)
- Changed:
  - Monthly required hours now calculate only from weekdays inside the selected month (`Mon-Fri` in month window), so adjacent-month week spillover is excluded.
  - Time-info popover is anchored to open to the right of the `Aktuelle Schicht` time trigger to avoid sidebar overlap/collision.
  - Monthly worked-hours center value in half-gauge was moved up and increased in size for readability.
  - Required daily hours are now editable for all user roles in Admin tables (not employee-only rows).
  - Backend `/api/time/required-hours/{user_id}` no longer rejects non-employee targets.
- Verified:
  - `./scripts/test.sh` pass (`15 passed` API tests + web build).
  - `docker compose up -d --build` pass (services healthy).
  - `curl -k -I https://localhost/` returns `HTTP/2 200`.
- Next:
  - Optional: add a dedicated monthly timesheet endpoint so monthly worked-hours totals are computed directly by month range instead of derived from weekly rows.
- Blockers: none.

## Compacted Update (2026-02-21, WebDAV macOS/Finder compatibility + popup instructions)
- Changed:
  - Fixed WebDAV project-root route compatibility for trailing slash URLs by accepting both:
    - `/api/dav/projects/{project_id}`
    - `/api/dav/projects/{project_id}/`
  - This resolves Finder-style root collection requests that were returning `400` with trailing slash.
  - Updated project-files WebDAV popup instructions to be macOS-specific and clearer:
    - explicit Finder path (`Cmd+K`),
    - URL now shown with trailing slash,
    - LAN fallback URL format and certificate-trust note.
  - Updated `docs/SETUP.md` WebDAV section to match the new URL format and Finder guidance.
- Verified:
  - `./scripts/test.sh` pass (`15 passed` API tests + web build).
  - `docker compose up -d --build` pass (services healthy).
  - Live smoke: `PROPFIND https://localhost/api/dav/projects/1/` now returns `HTTP/2 207`.
- Next:
  - Optional: add a small “copy WebDAV URL” action in the tooltip for one-click Finder paste.
- Blockers: none.

## Compacted Update (2026-02-21, WebDAV all-projects root)
- Changed:
  - Added WebDAV collection root endpoints for all accessible projects:
    - `/api/dav/projects`
    - `/api/dav/projects/`
  - Root `PROPFIND` now returns project folders the authenticated user can access; each folder links to existing per-project WebDAV paths.
  - Kept access control enforced server-side: non-admin users only see projects they are members of.
  - Updated project-files WebDAV tooltip to include:
    - all-projects URL (`.../api/dav/projects/`),
    - current-project URL,
    - Finder (`Cmd+K`) guidance.
  - Updated `docs/SETUP.md` WebDAV section with all-projects mount URL.
- Verified:
  - `./scripts/test.sh` pass (`16 passed` API tests + web build).
  - `docker compose up -d --build` pass (services healthy).
  - Live smoke: `PROPFIND https://localhost/api/dav/projects/` returns `HTTP/2 207`.
- Next:
  - Optional: support nested per-project folders by project number slug in addition to numeric id paths.
- Blockers: none.

## Compacted Update (2026-02-21, WebDAV tooltip copy buttons)
- Changed:
  - Added one-click copy buttons in the project files WebDAV tooltip for:
    - all-projects URL (`.../api/dav/projects/`),
    - current-project URL (`.../api/dav/projects/<id>/`).
  - Added localized copy feedback via existing notice/error system:
    - success message after copy,
    - fallback error when clipboard access fails.
  - Implemented clipboard fallback path for environments without `navigator.clipboard` support.
- Verified:
  - `./scripts/test.sh` pass (`16 passed` API tests + web build).
  - `docker compose up -d --build` pass (services healthy).
  - `curl -k -I https://localhost/` returns `HTTP/2 200`.
- Next:
  - Optional: add a tiny “copied” state on each button for 1-2 seconds.
- Blockers: none.

## Compacted Update (2026-02-21, Weekly Planning task flow parity + project map panel)
- Changed:
  - Reworked the weekly planning “Add task” modal to match the full project task creation flow:
    - title, information, required materials,
    - optional storage box toggle + box number,
    - due date + start time,
    - employee assignment via name-search autocomplete + multi-select chips.
  - Replaced weekly planning project dropdown with searchable project assignment:
    - type-to-search by project number, customer, or project name,
    - selectable/removable project chip.
  - Added optional “create project from task” flow (for users with project-create rights):
    - when no project is selected, users can create a lightweight project from task context,
    - created project is used immediately for the weekly task assignment.
  - Added a compact right-aligned mini map panel in the selected project summary (tasks tab):
    - renders project/customer address in an embedded map view,
    - includes “open in maps” link,
    - shows a clear fallback if no address is present.
- Verified:
  - `./scripts/test.sh` pass (`16 passed` API tests + web build).
  - `docker compose up -d --build` pass (services healthy).
  - `curl -k -I https://localhost/` returns `HTTP/2 200`.
- Next:
  - Optional: make map provider configurable for fully offline/self-hosted map tiles in hardened deployments.
- Blockers: none.

## Compacted Update (2026-02-21, cross-week task date + calendar export for assignees)
- Changed:
  - Weekly planning task modal now allows selecting any due date via free date input (not limited to currently selected week days).
  - Weekly task creation now derives target planning week from selected due date:
    - API write goes to `/planning/week/<normalized-monday-of-due-date>`,
    - after save, planning view switches to that target week to immediately show the task.
  - Added calendar export (`.ics`) for assigned users on task cards in:
    - `My tasks`,
    - selected project `Tasks` list,
    - `Weekly planning` day cards.
  - Exported calendar event includes:
    - task title/id/status,
    - project number/name/customer (if present),
    - task info/material/storage-box data,
    - assignees,
    - project address as event location when available.
- Verified:
  - `./scripts/test.sh` pass (`16 passed` API tests + web build).
  - `docker compose up -d --build` pass (all services healthy).
  - `curl -k -I https://localhost/` returns `HTTP/2 200`.
- Next:
  - Optional: add calendar export to a dedicated backend endpoint for signed download URLs and server-side audit logging.
- Blockers: none.

## Compacted Update (2026-02-21, login hardening for Safari-style URL/header pattern errors)
- Changed:
  - Added defensive token handling on frontend startup:
    - validate stored token format (`JWT-like`) before use,
    - automatically clear malformed `smpl_token` values from local storage.
  - Hardened login flow:
    - sanitize stale malformed stored token before submit,
    - retry login request once with absolute URL when browser throws “expected pattern” URL errors,
    - validate returned access token format before persisting.
  - Improved user-facing login error messaging for browser “expected pattern” failures.
- Verified:
  - `./scripts/test.sh` pass (`16 passed` API tests + web build).
  - `docker compose up -d --build` pass (all services healthy).
  - `curl -k -I https://localhost/` returns `HTTP/2 200`.
- Next:
  - Optional: add frontend telemetry hook for login transport errors to capture browser/version-specific root causes faster.
- Blockers: none.

## Compacted Update (2026-02-22, SharePoint/WebDAV stability + preview reliability)
- Changed:
  - Fixed API rate-limiter behavior to return explicit `429` JSON responses instead of throwing middleware exceptions that surfaced as internal server errors under load.
  - Added traffic-scope limiter buckets with higher allowance for WebDAV and time-tracking polling traffic to avoid false-positive throttling during Finder/WebDAV sync bursts.
  - Hardened file preview/download response handling:
    - sanitize invalid stored MIME types and fallback to `application/octet-stream`,
    - map unreadable file payload paths to controlled `404` responses.
  - Updated WebDAV project-folder labels to include customer/project identity plus internal project ID (`... | ID <id>`) for easier discovery in mounted file explorers.
- Verified:
  - `./scripts/test.sh` pass (`18 passed` API tests + web build).
  - `docker compose up -d --build` pass (all services healthy).
  - Live smoke:
    - preview endpoint returns `200` for uploaded file,
    - `PROPFIND https://localhost/api/dav/projects/` returns `207` with customer + ID labels,
    - high request burst on `/api` yields clean `429` responses (no `500`).
- Next:
  - Add optional UI badge in file explorer tooltip clarifying that WebDAV folder labels include internal project IDs.
- Blockers: none.

## Compacted Update (2026-02-22, local wiki library rollout)
- Changed:
  - Added filesystem-backed wiki APIs for local documents:
    - `GET /api/wiki/library/files` for indexed/searchable file metadata.
    - `GET|HEAD /api/wiki/library/raw/{path}` for secure preview/download.
  - Added safe wiki-path normalization/validation to block traversal and keep reads inside configured wiki root.
  - Added Docker read-only mount of host folder `local wiki` into API container at `/data/wiki`.
  - Reworked the wiki tab UI into a local document explorer:
    - search by file/brand/folder,
    - grouped brand -> folder -> document,
    - variant selection (HTML/PDF/etc.),
    - in-browser preview iframe plus open-in-new-tab/download actions.
- Verified:
  - `./scripts/test.sh` pass (`19 passed` API tests + web build).
  - `docker compose up -d --build` pass; `docker compose ps` healthy.
  - Live smoke: `/api/wiki/library/files` returns local wiki index and `/api/wiki/library/raw/<path>` returns `200` with inline HTML preview headers.
- Next:
  - Optional performance pass for very large wiki sets (lazy folder expansion/cached index).
- Blockers: none.

## Compacted Update (2026-02-22, task editing + assignee scope + planning calendar responsiveness)
- Changed:
  - Task assignment scope expanded in UI/API flow to include all active users (all roles), not only employees.
  - Added task editing modal for task managers (`admin/ceo/planning`) with server-side PATCH persistence:
    - editable: title, info, materials, storage box, status, due date, start time, week start, assignees.
  - Task creation/edit start-time fields now enforce 24h `HH:MM` input when UI language is German (`DE`) in:
    - project task creation,
    - weekly planning task creation,
    - task edit modal.
  - Weekly planning calendar layout adjusted for dense schedules:
    - fixed 7-day row with horizontal scroll on narrow screens,
    - day columns keep equal width and no mobile wrap-under stacking,
    - per-day task list scrolls vertically inside the day panel.
  - Visual task highlighting added for tasks assigned to the logged-in user in project/my/planning task lists.
  - Global notice banner now auto-dismisses after 5 seconds.
- Verified:
  - `./scripts/test.sh` pass (`19 passed` API tests + web build).
  - `docker compose up -d` pass; `docker compose ps` shows healthy stack.
- Next:
  - Optional: add manager-side bulk-edit actions for weekly task status/date shifts.
- Blockers: none.

## Compacted Update (2026-02-22, task-time input fix + project archive/delete + weekly task drill-down)
- Changed:
  - Unified task/report time input handling to strict `HH:MM` (24h) in all task create/edit forms and construction-report worker time rows.
  - Added frontend validation with localized error feedback before API submit for invalid time strings.
  - Added project lifecycle actions for managers:
    - archive directly from project edit modal (`status=archived`),
    - permanent project delete from project edit modal.
  - Added backend endpoint `DELETE /api/projects/{project_id}` with server-side permission checks and storage cleanup of project-linked encrypted payload files.
  - Reworked task edit actions to icon-based pen buttons; weekly planning task actions are now left-aligned.
  - Weekly planning tasks assigned to the logged-in user are now clickable and open `My Tasks` with the clicked task auto-expanded.
  - Added expandable/collapsible detailed task view in `My Tasks`.
- Verified:
  - `./scripts/test.sh` pass (`19 passed` API tests + web build).
  - `docker compose up -d --build api web caddy` pass.
  - `docker compose ps` healthy for `db/api/web/caddy`.
  - `curl -k -I https://localhost/` returns `HTTP/2 200`.
- Next:
  - Optional: add undo-safe “archive restore” filter/action in overview/all-projects list.
- Blockers: none.

## Compacted Update (2026-02-22, task-header toggle + overview back-nav + messenger-style chat feed)
- Changed:
  - `My Tasks` expand/collapse now toggles by clicking the task header row itself (no separate expand button).
  - Added overview-origin back navigation: when opening `Construction Report`, `Time Tracking`, or `Wiki` from overview shortcut cards, those pages now show a top-left back button with icon next to the header.
  - Added unread-chat indicator dot in left navigation: `Chat` now shows a blue dot when server unread count is greater than zero.
  - Reworked chat message rendering toward messenger behavior:
    - centered day separators,
    - message timestamps in `HH:MM`,
    - inbound message avatar grouping by sender-run (avatar shown when sender changes),
    - per-bubble time alignment (`left` for own messages, `right` for incoming messages).
  - Extended assignable-user payload with `avatar_updated_at` so message avatars can resolve consistently without admin-only user listing.
  - Thread polling is now active across the app (fast in chat view, slower elsewhere) so unread state and nav indicator stay fresh.
- Verified:
  - `./scripts/test.sh` pass (`19 passed` API tests + web build).
  - `docker compose up -d --build api web caddy` pass.
  - `docker compose ps` healthy for `db/api/web/caddy`.
  - `curl -k -I https://localhost/` returns `HTTP/2 200`.
- Next:
  - Optional: add Playwright assertions for day-divider rendering and chat unread-dot lifecycle.
- Blockers: none.

## Compacted Update (2026-02-22, my-task report action + job-ticket simplification + sidebar project search)
- Changed:
  - `My Tasks` now supports direct construction-report creation from task context:
    - new action `Report from task` in each own task row,
    - if task is still open, action marks it done first, then opens Construction Report,
    - report is prefilled from task/project data (project selection, date, workers, work/material context).
  - Job Tickets (project tab) were simplified for current MVP use:
    - removed standalone site/location creation segment from the UI,
    - ticket creation now uses project-context defaults for address/date,
    - tickets remain printable/exportable and attachment-capable.
  - Sidebar project list now has magnifier-triggered search:
    - search icon next to `Projects` header,
    - toggles a search field directly under header,
    - live filters by customer, project number, and project name.
- Verified:
  - `./scripts/test.sh` pass (`19 passed` API tests + web build).
  - `docker compose up -d --build api web caddy` pass.
  - `docker compose ps` healthy for `db/api/web/caddy`.
  - `curl -k -I https://localhost/` returns `HTTP/2 200`.
- Next:
  - Optional: add API-level task->report linkage field for explicit traceability in reporting exports.
- Blockers: none.

## Compacted Update (2026-02-22, task back-nav + archive page + task-change indicators)
- Changed:
  - Added contextual back navigation for task-driven report flow:
    - `Report from task` now opens Construction Report with a header back button to return to the previous task context.
  - Fixed sidebar project search layout overlap:
    - project list now shifts correctly below the search input when search is toggled.
  - Added sidebar archive access:
    - bottom project-list entry (`Project archive`) after a divider opens a dedicated archive view.
    - archive view supports manager actions to unarchive or permanently delete archived projects.
  - Added user-impact notification dots in left nav:
    - `My Tasks` and `Weekly Planning` now show a blue indicator when assigned-task data changes in background polling.
  - Added project-task drilldown:
    - clicking a task assigned to the logged-in user in project task list opens `My Tasks` with that task expanded.
    - `My Tasks` now shows `Back to project` for this drilldown flow.
  - Added manager task deletion:
    - frontend task-edit modal includes `Delete`.
    - backend endpoint `DELETE /api/tasks/{task_id}` added with server-side `tasks:manage` + project access checks.
- Verified:
  - `./scripts/test.sh` pass (`19 passed` API tests + web build).
  - `docker compose up -d --build` pass.
  - `docker compose ps` healthy for `db/api/web/caddy`.
- Next:
  - Optional: replace polling-based task-change dots with server push/websocket events in phase 2.
- Blockers: none.

## Compacted Update (2026-02-22, my-task loop fix + full-height chat pane + thread project assignment restore)
- Changed:
  - Fixed navigation loop between project and my-tasks drilldown:
    - flow `Project -> assigned task -> My Tasks -> Back to project` now returns cleanly without injecting an extra project-level "Back to My Tasks" button.
  - Matched top spacing of `My Tasks` card to weekly planning spacing.
  - Adjusted sidebar project-list spacing when search is open so the search field no longer gets covered by the first project row.
  - Updated chat layout height behavior so the right chat pane scales to viewport height instead of a short fixed `vh` block.
  - Restored project assignment in chat thread management:
    - create/edit thread modal now includes optional project selection.
    - thread create/edit calls now submit `project_id` when selected.
  - Extended backend thread update to support changing/clearing `project_id` with server-side access checks.
- Verified:
  - `./scripts/test.sh` pass (`19 passed` API tests + web build).
  - `docker compose up -d --build && docker compose ps` pass; `db/api/web/caddy` healthy.
- Next:
  - Optional: add an automated UI smoke test for thread project assignment and project/task back-navigation paths.
- Blockers: none.

## Compacted Update (2026-02-22, project folder policy + CSV import tooling + absences in planning + restore smoke fix)
- Changed:
  - Added project folder model + APIs with default per-project folder structure:
    - `Bilder`, `Anträge`, `Berichte`, `Tickets`, and protected `Verwaltung`.
    - users with elevated roles only can list/upload/read in `Verwaltung`; others are blocked server-side.
  - Extended project file upload/listing and WebDAV handling for nested folder paths and folder creation (`MKCOL`), including role-filtered visibility.
  - Updated project folder labels in all-project WebDAV root to include `project_number - customer` for easier discovery.
  - Added admin CSV project import tooling:
    - template download endpoint (`/api/admin/projects/import-template.csv`),
    - CSV import endpoint (`/api/admin/projects/import-csv`) with audit logging and extra-column preservation.
  - Added absence management:
    - vacation request create/list/review endpoints,
    - school absence create/list/delete endpoints (accountant+),
    - weekly planning payload now includes absence overlays for approved vacations and school dates.
  - Fixed restore smoke regression after schema evolution:
    - updated marker project insert in `scripts/restore_smoke_test.sh` to include required `extra_attributes`.
- Verified:
  - `./scripts/test.sh` pass (`23 passed` API tests + web build).
  - `docker compose up -d --build` pass.
  - `docker compose ps` healthy (`db/api/web/caddy`).
  - `BACKUP_PASSPHRASE=smoketest-passphrase ./scripts/restore_smoke_test.sh` pass end-to-end.
- Next:
  - Optional: add API tests for protected nested folders (`Verwaltung/*`) across all WebDAV verbs.
  - Optional: add UI batch actions for vacation approvals.
- Blockers: none.

## Compacted Update (2026-02-22, release hardening: deprecations + coverage + readiness)
- Changed:
  - Replaced deprecated FastAPI startup hook with lifespan initialization (`app/main.py`).
  - Replaced application-level `datetime.utcnow()` usage with centralized UTC helper (`app/core/time.py`) and updated SQLAlchemy datetime defaults/onupdate callables.
  - Migrated Pydantic response schemas from legacy `class Config` to v2 `ConfigDict(from_attributes=True)`.
  - Added integration test coverage for protected WebDAV folder enforcement across verbs (`MKCOL`, `PUT`, direct `PROPFIND`/`GET` access checks on `Verwaltung` paths).
  - Updated test fixtures to align with lifespan-based initialization.
- Verified:
  - `./scripts/test.sh` pass (`29 passed` API tests + web build).
  - `BACKUP_PASSPHRASE=smoketest-passphrase ./scripts/restore_smoke_test.sh` pass.
  - `docker compose up -d --build && docker compose ps` pass (`db/api/web/caddy` healthy).
  - `curl -sk -I https://localhost/` -> `HTTP/2 200`; `curl -sk https://localhost/api` -> service `ok`.
- Next:
  - Optional: expand full browser E2E coverage (Playwright) for release-candidate UX regressions.
- Blockers: none.

## Compacted Update (2026-02-22, admin action menu viewport alignment)
- Changed:
  - Adjusted Admin Center per-user 3-dot action popup alignment so it opens inward from the trigger (`right: 0`), preventing overflow outside the page on right-edge table rows.
- Verified:
  - `./scripts/test.sh` pass (`32 passed` API tests + web build).
- Next:
  - Optional: add a small responsive UI smoke assertion for action-menu placement at narrow widths.
- Blockers: none.

## Compacted Update (2026-02-22, GitHub release handoff without local DB/data)
- Changed:
  - Initialized repository Git metadata for deployment handoff (`main` branch).
  - Hardened `.gitignore` for safe publishing:
    - excluded local runtime/storage artifacts (`data/`, `backups/`, local sqlite DBs),
    - excluded local tooling state (`.mcp/`, `.playwright-cli/`, `output/`),
    - excluded local Excel import files and mounted wiki content payload while preserving `local wiki/.gitkeep`.
  - Kept Dockerized runtime architecture unchanged (Postgres + uploads + Caddy TLS volumes remain runtime-only and non-versioned).
- Verified:
  - `./scripts/test.sh` pass (`32 passed` API tests + web build).
- Next:
  - Push repo to GitHub remote and provision server clone/bootstrap from `docs/SETUP.md`.
- Blockers:
  - GitHub remote URL/auth not yet confirmed in this workspace.

## Compacted Update (2026-02-22, GitHub publish complete)
- Changed:
  - Added GitHub remote `origin` to `https://github.com/Lukeskaiwalker/Work-Schedule-Management-.git`.
  - Published release-ready `main` branch to GitHub (initial codebase push).
  - Kept repository clean from runtime DB/data/secrets via `.gitignore` policy already applied.
- Verified:
  - `./scripts/test.sh` pass (`32 passed` API tests + web build).
  - `docker compose up -d --build && docker compose ps` pass; `db/api/web/caddy` healthy.
- Next:
  - Server install: clone repo on target host, configure env/secrets, run `docker compose up -d --build`, then run restore/import as needed.
- Blockers: none.

## Compacted Update (2026-02-22, backup encryption key file for test DB)
- Changed:
  - Generated local backup key file `config/backup-test-db.key` (strong random, chmod `600`) for encrypted backup operations.
  - Updated `.gitignore` to exclude key material via `config/*.key`.
  - Verified encrypted backup creation using key file-derived passphrase:
    - `BACKUP_PASSPHRASE="$(cat config/backup-test-db.key)" ./scripts/backup.sh`
    - produced `backups/backup-20260222-211743.tar.enc`.
- Verified:
  - `./scripts/test.sh` pass (`32 passed` API tests + web build).
  - `docker compose up -d --build && docker compose ps` pass; `db/api/web/caddy` healthy.
- Next:
  - Optional: add `BACKUP_PASSPHRASE_FILE` support to backup/restore scripts to avoid command substitution in shell history.
- Blockers: none.

## Compacted Update (2026-02-22, server hotfix: login hardening + DE default + data sync)
- Changed:
  - Removed hardcoded login field defaults (`admin@example.com` / `ChangeMe123!`) from web app.
  - Forced UI startup language default to German (`DE`) on every fresh load.
  - Added `INITIAL_ADMIN_BOOTSTRAP` config toggle in API startup; server is set to `false` to prevent automatic recreation of bootstrap admin.
  - Deployed patch to live server (`192.168.1.127`) and rebuilt stack.
  - Uploaded and restored encrypted backup (`backup-20260222-211743.tar.enc`) using key file (`config/backup-test-db.key`).
  - Uploaded and extracted `local wiki` dataset to server mount path (`~/SMPL-all/local wiki`).
  - Deactivated restored bootstrap account `admin@example.com` after restore so default credentials are blocked.
- Verified:
  - `./scripts/test.sh` pass (`32 passed` API tests + web build).
  - Server API healthy: `https://smpl-office.duckdns.org/api -> {"status":"ok"}`.
  - Default login blocked post-restore: `admin@example.com / ChangeMe123! -> 401`.
  - Wiki content present on server (`find "local wiki" -type f | wc -l -> 2364`).
- Next:
  - Optional: add one-time startup guard that auto-disables known bootstrap credentials if still active.
- Blockers: none.

## Compacted Update (2026-02-22, bootstrap auto-disable + access recovery)
- Changed:
  - Added persistent runtime setting support (`app_settings`) and wired bootstrap lifecycle guard.
  - Initial admin bootstrap now auto-completes (and stops recreating default admin) when initial credentials are changed.
  - Profile update of initial bootstrap admin now marks bootstrap as completed server-side.
  - Added Alembic migration `20260222_0015_bootstrap_runtime_settings`.
  - Recovered live access on server by resetting active admin account password and confirming API login works.
- Verified:
  - `./scripts/test.sh` pass (`33 passed` API tests + web build).
  - Live login verified on `https://smpl-office.duckdns.org` with active admin account after recovery.
- Next:
  - Optional: add one-click admin UI banner when bootstrap completion is detected.
- Blockers: none.

## Compacted Update (2026-02-22, live deploy verification + backup/wiki sync)
- Changed:
  - Deployed bootstrap-completion patch to `192.168.1.127` and ran Alembic migration `20260222_0015`.
  - Fixed deployment incident caused by macOS AppleDouble metadata files (`._*`) accidentally copied into API source; removed them and rebuilt API image.
  - Persisted bootstrap completion flag on live DB and rotated default bootstrap admin password hash while keeping that account inactive.
  - Generated fresh encrypted local backup (`backup-20260222-224157.tar.enc`) and uploaded it to server.
- Verified:
  - `docker compose ps` on server: `db/api/web/caddy` healthy.
  - API health: `https://smpl-office.duckdns.org/api` returns `status=ok`.
  - Login checks: `employee.alex@example.com` works; `admin@example.com / ChangeMe123!` blocked (`401`).
  - Wiki content still present on server (`2364` files).
- Next:
  - Optional: rotate temporary emergency admin password after user confirms access restored.
- Blockers: none.

## Compacted Update (2026-02-23, project overview/finance structure + project activity log)
- Changed:
  - Added new project data model support:
    - `projects.last_updated_at`
    - `project_finances` (single-row finance data per project)
    - `project_activities` (typed project change log)
  - Added backend endpoints:
    - `GET /api/projects/{id}/overview`
    - `GET /api/projects/{id}/finance`
    - `PATCH /api/projects/{id}/finance`
  - Implemented project last-update + change-log triggers for:
    - task create/update/delete,
    - project state changes,
    - job ticket create/attachment update,
    - project file upload/delete (including WebDAV PUT/DELETE),
    - construction report creation,
    - finance updates.
  - Restructured project UI tabs to:
    - `Overview`, `Tasks`, `Job Tickets`, `Files`, `Finances`.
  - Implemented project `Overview` tab blocks:
    - open vs personal task glance,
    - address map preview,
    - project metadata (ID/state/last update/customer),
    - contact block,
    - editable internal note (edit icon),
    - last 10 changes feed.
  - Implemented `Finances` tab with edit-icon flow and fields:
    - `Auftragswert netto`, `35% Anzahlung`, `50% Hauptkomponenten`, `15% Schlussrechnung`,
    - `Geplante Kosten`, `Tatsächliche Kosten`, `Deckungsbeitrag`.
- Verified:
  - `./scripts/test.sh` pass (`33 passed` API tests + web build).
- Next:
  - Optional: add sorting/filtering controls directly inside the new project-level change feed.
- Blockers: none.

## Compacted Update (2026-02-23, project overview map + open-task list refinement)
- Changed:
  - Project overview map query now uses only the project address field (`customer_address`) and no customer/project name suffixes.
  - Removed separate `Open in maps` text button; map card itself is now the click target to open external maps.
  - Replaced overview open-task counter-only block with a real open-task list (title, due date, assignees).
  - Open-task list is fixed-height and scrollable so the card does not keep growing when many tasks exist.
- Verified:
  - `./scripts/test.sh` pass (`33 passed`, web build successful).
- Next:
  - Optional: add direct click-to-edit/open behavior from each open-task row.
- Blockers: none.

## Compacted Update (2026-02-23, overview task card simplification + weather placeholder)
- Changed:
  - Project overview open-tasks card now shows only:
    - main header (`Projektüberblick`/`Project glance`)
    - subheading (`Offene Aufgaben`/`Open tasks`)
    - scrollable open-task list.
  - Removed task counters and removed `My open tasks` text from this card to save space.
  - Tightened header/subheading spacing in the open-tasks card.
  - Added new weather placeholder card on project overview (`Wetter`/`Weather`) with a two-card width on desktop as preparation for real weather integration.
- Verified:
  - `./scripts/test.sh` pass (`33 passed`, web build successful).
- Next:
  - Implement real weather data + forecast rendering once data source/refresh rules are finalized.
- Blockers: none.

## Compacted Update (2026-02-23, project weather integration + admin API key settings)
- Changed:
  - Added project weather backend with OpenWeather integration:
    - endpoint: `GET /api/projects/{id}/weather?refresh=true|false`
    - geocodes project address and loads forecast days.
  - Added per-project weather cache table with offline fallback:
    - table: `project_weather_cache`
    - returns last known forecast when provider is unavailable.
  - Added project-level refresh throttling:
    - max one provider refresh per project every 15 minutes.
    - repeated project clicks inside cooldown return cached data.
  - Added admin/CEO weather credential management:
    - `GET /api/admin/settings/weather`
    - `PATCH /api/admin/settings/weather` (`api_key` set/clear).
  - Updated project overview weather card:
    - renders project forecast for selected project address,
    - shows cache/offline status and last update timestamp.
  - Updated profile `Admin tools` UI with OpenWeather API key configuration form.
  - Added migration `20260223_0017_project_weather_cache`.
- Verified:
  - `./scripts/test.sh` pass (`35 passed`, web build successful).
- Next:
  - Optional: add manual refresh button and provider-health indicator in weather card.
- Blockers: none.

## Compacted Update (2026-02-23, weather 401 diagnosis + clearer API-key errors)
- Changed:
  - Improved weather provider error handling so OpenWeather API responses are surfaced as readable messages instead of raw HTTP exceptions.
  - Added explicit mapping for common key/subscription failures:
    - invalid key -> `OpenWeather API key is invalid (or not active yet)`
    - missing forecast access -> `OpenWeather forecast API access is not enabled for this key`
- Verified:
  - Reproduced issue outside app using the same key against OpenWeather geocoding endpoint (`401 Invalid API key`).
  - `./scripts/test.sh` pass (`35 passed`, web build successful).
- Next:
  - User to replace key with a valid OpenWeather key and re-test project weather.
- Blockers:
  - Current configured OpenWeather key is rejected by provider (`401 Invalid API key`).

## Compacted Update (2026-02-23, weather changed to 5-day forecast)
- Changed:
  - Switched weather provider endpoint from OpenWeather One Call 3.0 to OpenWeather 2.5 five-day forecast feed.
  - Added daily aggregation from 3-hour slots into 5 day-cards (min/max temperature, rain probability, wind, icon/description near midday).
  - Updated API weather output limit to 5 days and aligned Admin UI helper text to 5-day forecast wording.
  - Kept existing per-project 15-minute refresh throttle and offline cached fallback behavior unchanged.
- Verified:
  - `./scripts/test.sh` pass (`35 passed`, web build successful).
  - `docker compose up -d` successful; stack healthy.
- Next:
  - Re-test weather in UI with the configured API key after container refresh.
- Blockers:
  - If OpenWeather still returns `401`, the key itself is invalid/inactive and must be replaced.

## Compacted Update (2026-02-23, weather address normalization)
- Changed:
  - Normalized `customer_address` before sending geocode requests: strip whitespace, collapse newline/comma patterns, and ensure a space after commas.
  - This avoids lookups like `Nolsenstr. 62,58452 Witten` that previously returned `Address could not be geocoded`.
  - Added geocode fallback candidates per project address (`base`, `base + Deutschland`, `base + Germany`) to improve successful lookup rates.
  - Updated project create/edit address input handling to store normalized address format and display a format hint.
- Verified:
  - `./scripts/test.sh` pass (`36 passed`, web build successful).
- Next:
  - Confirm addresses with unusual separators now resolve once the API key is valid.
- Blockers: none.

## Compacted Update (2026-02-23, weather ZIP fallback for geocoding)
- Changed:
  - Added OpenWeather ZIP geocode fallback (`/geo/1.0/zip`) when direct address geocoding returns no result.
  - ZIP fallback is derived from project address (e.g. `58453` -> `58453,DE`) and used before returning `Address could not be geocoded`.
  - This fixes address patterns like project `#103` where street-level direct lookup fails but postal lookup succeeds.
- Verified:
  - `./scripts/test.sh` pass (`37 passed`, web build successful).
- Next:
  - Re-open affected projects once to refresh weather with the new fallback path.
- Blockers: none.

## Compacted Update (2026-02-23, project last-update refresh + customer appointment task type)
- Changed:
  - Project overview now updates local project state from `GET /projects/{id}/overview` so `last_updated_at` reflects task creation immediately in the project page.
  - Frontend datetime parsing now treats server UTC-naive timestamps as UTC (adds `Z` when timezone is missing) to prevent 1-hour offset in displayed times.
  - Added new task type `customer_appointment` across backend + frontend:
    - accepted in task create/update and planning filters,
    - available in project task creation, weekly task modal, and task edit modal,
    - added as third weekly planning subview toggle.
  - Extended admin project-class CSV template examples with a customer-appointment task row.
- Verified:
  - `./scripts/test.sh` pass (`38 passed`, web build successful).
- Next:
  - Optional: add distinct visual badge/chip style per planning task type for faster scanning in dense weeks.
- Blockers: none.

## Compacted Update (2026-02-23, project accumulates construction-report worker hours)
- Changed:
  - Added persistent project-level hour accumulator `project_finances.reported_hours_total`.
  - Construction report creation now parses worker `start_time`/`end_time` rows and automatically adds valid durations to the corresponding project total.
  - Project overview now displays a glance value for reported report-hours (`Gemeldete Stunden (Berichte)`).
  - Report activity details now include `reported_hours` for auditability in recent changes.
  - Added migration `20260224_0020_project_finance_reported_hours`.
- Verified:
  - `./scripts/test.sh` pass (`38 passed`, web build successful).
  - Updated workflow test validates `reported_hours_total` is available via both `/projects/{id}/finance` and `/projects/{id}/overview`.
- Next:
  - Optional: add a per-employee hour breakdown per project (not only total) if required for dispatch/review workflows.
- Blockers: none.

## Compacted Update (2026-02-23, project site-access options in create form + overview contact)
- Changed:
  - Added project fields for site access handling:
    - `site_access_type` (dropdown value),
    - `site_access_note` (optional detail text for selected access types).
  - Project creation/edit form now includes dropdown options:
    - `Kunde ist Vorort`,
    - `frei zugänglich`,
    - `Schlüssel im Büro`,
    - `Schlüssel abholen bei` (optional text input shown),
    - `Zugang über Code` (optional text input shown),
    - `Schlüsselbox` (optional text input shown),
    - `Anrufen vor Abfahrt`.
  - Contact block in project overview now shows selected site-access info (including optional detail text where relevant).
  - Added migration `20260224_0021_project_site_access_fields`.
- Verified:
  - `./scripts/test.sh` pass (`38 passed`, web build successful).
  - `docker compose up -d --build` successful; API/web/db/caddy healthy.
- Next:
  - Optional: include site-access columns in admin project import template if this data should be mass-imported.
- Blockers: none.

## Compacted Update (2026-02-23, avatar removal + user archive view in admin center)
- Changed:
  - Added profile-avatar removal endpoint `DELETE /api/users/me/avatar` (idempotent).
  - Profile page now has `Profilbild entfernen` / `Remove profile picture` action.
  - Admin user lists now separate active users from archived users:
    - deleted users are hidden from main active tables,
    - new `Benutzerarchiv` / `User archive` section shows archived users,
    - archived users can be restored from archive (`is_active=true` patch path already in place).
  - Delete-user UI language now reflects archive behavior (`archive` instead of `deactivate`).
- Verified:
  - `./scripts/test.sh` pass (`38 passed`, web build successful).
  - targeted avatar test pass (`test_profile_avatar_upload_and_preview`).
- Next:
  - Optional: add server-side filter parameters to `/api/admin/users` (`active` / `archived`) if user list volume grows.
- Blockers: none.

## Compacted Update (2026-02-23, materials side menu from construction report office material need)
- Changed:
  - Added backend persistence for report-driven office material demand via new table `project_material_needs`.
  - Construction report creation now parses `payload.office_material_need` entries and auto-creates material queue rows for the linked project.
  - Added API endpoints:
    - `GET /materials` (active-project material queue visible to current user),
    - `PATCH /materials/{id}` (set availability state).
  - Added new sidebar menu view `Materials` in web app:
    - lists auto-imported material items from construction reports,
    - per-item state selector with color-highlighted states:
      - `Order`,
      - `On its way`,
      - `Available`.
  - Added migration `20260224_0023_project_material_needs`.
- Verified:
  - `./scripts/test.sh` pass (`38 passed`, web build successful).
  - `docker compose up -d --build api web` successful and migration applied (`20260224_0023`).
- Next:
  - Optional: add explicit quantity parsing (`20m`, `3x`) into structured fields if procurement analytics is needed later.
- Blockers: none.

## Compacted Update (2026-02-23, WebDAV project-reference alignment + file upload root/new-folder flow)
- Changed:
  - WebDAV project routes now resolve both project number and numeric ID (`/api/dav/projects/{project_ref}`), so file-share links can use the same project reference users see in the UI.
  - WebDAV root listing now emits active project links by `project_number` (fallback to numeric ID only if number is missing).
  - WebDAV project display names no longer append internal DB ID.
  - File upload endpoint now supports explicit root-folder upload by sending `folder=/` (instead of forcing auto-folder routing).
  - File upload modal now supports:
    - explicit base-folder selection (`/`),
    - optional inline new-folder path that is auto-created and used during upload.
  - WebDAV helper tooltip now copies current-project links based on project number and clarifies multi-user mount behavior (same link, individual credentials).
- Verified:
  - `./scripts/test.sh` pass (`38 passed`, web build successful).
  - Focused workflow tests for WebDAV + folder behavior pass.
- Next:
  - Optional: expose a one-click “copy LAN WebDAV URL” helper that automatically swaps origin host with configured LAN host if teams frequently mount from other devices.
- Blockers: none.

## Compacted Update (2026-02-23, construction report worker search + mobile image/time input reliability)
- Changed:
  - Construction report worker rows now support user-name search suggestions via assignable-user datalist.
  - Worker time entry now supports digit-only mobile input (for example `0730`), with automatic normalization to `HH:MM`.
  - Added mobile-focused camera upload field in construction report form (`camera_images`) and merged file collection from both picker and camera inputs.
  - Backend construction report worker-time parsing now accepts both `HH:MM` and compact numeric times (`730`, `1600`) for reported-hours calculation.
  - Backend report image ingestion now tolerates missing/weak filename metadata by generating stable fallback filenames and extension inference.
- Verified:
  - `docker compose run --rm --build api sh -lc 'cd /app && PYTHONPATH=. pytest -q tests/test_workflows.py -k project_task_planning_ticket_file_and_report_flow'` pass.
  - `./scripts/test.sh` pass (`38 passed`, web build successful).
- Next:
  - Optional: add client-side image downscaling/compression for very large mobile photos to reduce upload bandwidth and timeout risk.
- Blockers: none.

## Compacted Update (2026-02-23, admin update menu + release status check/install workflow)
- Changed:
  - Added admin update endpoints:
    - `GET /api/admin/updates/status`
    - `POST /api/admin/updates/install`
  - Update status now checks configured GitHub repository release/commit metadata and reports:
    - current version/commit (from env),
    - latest release/tag or branch commit,
    - update-available flag,
    - auto-install support state for current deployment.
  - Added admin update menu in web UI (`Profile -> Admin tools` and `Admin` view):
    - check update status,
    - run dry-run update command sequence,
    - run install sequence when auto-install is supported,
    - show manual command steps when auto-install is unavailable (default Docker deployment).
  - Added config/env support for release/update metadata:
    - `APP_RELEASE_VERSION`, `APP_RELEASE_COMMIT`,
    - `UPDATE_REPO_OWNER`, `UPDATE_REPO_NAME`, `UPDATE_REPO_BRANCH`, `UPDATE_REPO_PATH`,
    - `GITHUB_API_TOKEN` (optional).
- Verified:
  - `./scripts/test.sh` pass (`40 passed`, web build successful).
  - `docker compose run --rm --build api sh -lc 'cd /app && PYTHONPATH=. pytest -q tests/test_auth_rbac.py'` pass.
- Next:
  - Optional: wire CI/CD to set `APP_RELEASE_VERSION` and `APP_RELEASE_COMMIT` automatically for exact update comparisons.
- Blockers: none.

## Compacted Update (2026-02-24, report PDF image compaction + upload progress visibility)
- Changed:
  - Construction-report PDF generation now compacts embedded photos (auto-rotated, downscaled, JPEG compressed) to reduce generated PDF size and opening latency.
  - Original uploaded report photos remain unchanged and encrypted as separate attachments (no data loss in source images).
  - Construction-report form now shows live upload progress with percent and processing state, and blocks duplicate submits while upload is running.
- Verified:
  - `./scripts/test.sh` pass (`42 passed`, web build successful).
  - Added API test coverage for report-photo compaction helper behavior.
- Next:
  - Optional: add client-side pre-upload image compression toggle for very weak mobile networks.
- Blockers: none.

## Compacted Update (2026-02-24, file-share performance step 1 with encrypted streaming)
- Changed:
  - Switched new attachment storage to chunked encrypted file format (AES-GCM chunks) while keeping encryption at rest enabled.
  - Added streaming response path for chunked-encrypted files in file download/preview and WebDAV GET, so large file opens avoid full-file memory decrypt before first bytes.
  - Kept backward compatibility: legacy Fernet-encrypted files still read correctly.
- Verified:
  - `./scripts/test.sh` pass (`44 passed`, web build successful).
  - Added file-service tests for chunked round-trip and legacy compatibility.
- Next:
  - Optional: add one-time migration utility to rewrite old legacy encrypted files to the new chunked format for speed gains on historical files too.
- Blockers: none.

## Compacted Update (2026-02-24, optimistic edit locking + changed-only PATCH payloads)
- Changed:
  - Added optimistic concurrency checks for mutable project data endpoints:
    - `PATCH /api/projects/{id}` via `expected_last_updated_at`,
    - `PATCH /api/tasks/{id}` via `expected_updated_at`,
    - `PATCH /api/projects/{id}/finance` via `expected_updated_at`.
  - Added `tasks.updated_at` persistence field (migration `20260224_0024_task_updated_at_for_optimistic_locking`) and exposed `updated_at` in task API responses.
  - Updated web edit flows to send only changed fields (instead of full-form payload) plus the corresponding optimistic token.
  - Added localized conflict feedback in UI for `409` edit-collision responses.
- Verified:
  - `docker compose run --build --rm api sh -lc 'cd /app && PYTHONPATH=. pytest -q tests/test_optimistic_locking.py tests/test_workflows.py -k "project_task_planning_ticket_file_and_report_flow or file or webdav"'` pass.
  - `./scripts/test.sh` pass (`47 passed`, web build successful).
  - `cd apps/web && npm run build` pass.
  - `docker compose up -d --build api web caddy` pass (`db/api/web/caddy` healthy).
- Next:
  - Optional: extend optimistic token checks to quick-update actions (`mark done`, project archive/unarchive) for the same conflict semantics outside edit modals.
- Blockers: none.

## Compacted Update (2026-02-24, empty-file upload guards + WebDAV file-size metadata)
- Changed:
  - Added zero-byte payload guards for project file uploads and job-ticket attachments (`400 File body is required`).
  - Chat message attachment persistence now skips empty attachment payloads and rejects attachment-only empty submits.
  - Construction-report multipart image intake is now restricted to known image fields (`images`, `camera_images`, including `[]` variants) to avoid unintended multipart ingestion.
  - WebDAV `PROPFIND` file entries now return real file-size metadata (chunked plain-size when available, encrypted-size fallback) instead of hardcoded `0`.
- Verified:
  - `docker compose run --build --rm api sh -lc 'cd /app && PYTHONPATH=. pytest -q tests/test_workflows.py -k "project_files_webdav_mount_flow or project_file_upload_rejects_empty_payload"'` pass.
  - `./scripts/test.sh` pass (`48 passed`, web build successful).
  - `docker compose up -d --build` pass (local stack healthy).
- Next:
  - Optional: add an admin maintenance action to detect and clean historical zero-byte attachments created before this guard.
- Blockers: none.

## Compacted Update (2026-02-24, optimistic tokens added to quick status actions)
- Changed:
  - Project archive/unarchive quick actions now send `expected_last_updated_at` so stale one-click status changes return `409` instead of overwriting newer project updates.
  - Task quick-complete actions (`my tasks`, project task list, weekly planning) now send `expected_updated_at` with status updates.
  - Added localized conflict messages for quick-action stale-write collisions.
- Verified:
  - `cd apps/web && npm run build` pass.
  - `docker compose up -d --build web caddy` pass.
  - `curl -k -s -o /dev/null -w "%{http_code}" https://localhost/` returns `200`.
  - `./scripts/test.sh` pass (`48 passed`, web build successful).
- Next:
  - Optional: add admin maintenance utility to rewrite legacy encrypted attachment blobs into chunked-encrypted format for historical file-share speed gains.
- Blockers: none.

## Compacted Update (2026-02-24, construction report photo queue selection UX)
- Changed:
  - Construction-report photo selection now uses a managed queue in UI (matching chat-attachment behavior).
  - Users can select multiple photos at once, add additional photos in later selections, and remove individual queued photos before upload.
  - Duplicate selections are ignored by file identity (`name:size:lastModified`), and selected photos are cleared only after successful report save.
- Verified:
  - `cd apps/web && npm run build` pass.
  - `./scripts/test.sh` pass (`48 passed`, web build successful).
- Next:
  - Optional: add lightweight thumbnail previews in the queued-photo chips for faster pre-submit visual checks.
- Blockers: none.

## Compacted Update (2026-02-24, construction report photo thumbnails in selection queue)
- Changed:
  - Replaced filename-only queued-photo chips with small thumbnail tiles in the construction-report form.
  - Each selected photo now shows a preview box with direct remove action, closer to chat attachment visuals.
  - Append behavior is preserved: selecting additional photos keeps already selected photos in queue.
- Verified:
  - `cd apps/web && npm run build` pass.
  - `./scripts/test.sh` pass (`48 passed`, web build successful).
- Next:
  - Optional: add tap-to-open lightbox preview for queued photos on mobile before submit.
- Blockers: none.

## Compacted Update (2026-02-25, structured material entry rows in report form)
- Changed:
  - Replaced free-text `Material` textarea in construction report form with structured row inputs (`item`, `qty`, `unit`, `article`).
  - Replaced free-text `Büro Materialbedarf` textarea with the same structured row input model.
  - Both sections now start with one row and support incremental add/remove rows while editing.
  - Submit path now serializes row data to existing backend payload format, preserving compatibility.
- Verified:
  - `cd apps/web && npm run build` pass.
  - `./scripts/test.sh` pass (`48 passed`, web build successful).
  - `docker compose up -d --build web caddy` pass (web/api healthy).
- Next:
  - Optional: add per-row autocomplete for common units/items to speed up repeated entry.
- Blockers: none.

## Compacted Update (2026-02-24, project finance tab layout refresh)
- Changed:
  - Updated the project finance read view so `Zuletzt aktualisiert` appears directly under the `Finanzen` header.
  - Reworked finance metrics into a left-to-right column layout with labels on top and values directly beneath:
    - `Auftragswert netto`, `35% Anzahlung`, `50% Hauptkomponenten`, `15% Schlussrechnung`, `Geplante Kosten`, `Tatsächliche Kosten`, `Deckungsbeitrag`.
  - Added responsive column behavior to keep the same visual structure on smaller viewports.
- Verified:
  - `cd apps/web && npm run build` pass.
  - `docker compose up -d --build web caddy` pass (web/api healthy).
- Next:
  - Optional: tune mobile spacing/font size if field values become long in narrow layouts.
- Blockers: none.

## Compacted Update (2026-02-25, finance metric typography and row spacing tune)
- Changed:
  - Reduced vertical spacing between finance metric rows for denser scanability.
  - Increased text size for both finance labels and numeric values.
- Verified:
  - `cd apps/web && npm run build` pass.
  - `docker compose up -d --build web caddy` pass (web/api healthy).
- Next:
  - Optional: if needed, clamp long monetary values on very narrow screens.
- Blockers: none.

## Compacted Update (2026-02-25, materials menu single-indicator flow + completion action)
- Changed:
  - Materials menu now uses only one status control: clicking the status indicator cycles `Bestellen` -> `Unterwegs` -> `Verfügbar`.
  - Removed the extra status dropdown to avoid duplicate state indicators.
  - Added `Erledigt` button for items in `Verfügbar`; clicking it marks item as completed.
  - Completed material items are excluded from active `/materials` queue results.
- Verified:
  - `./scripts/test.sh` pass (`48 passed`, web build successful).
  - `docker compose up -d --build api web caddy` pass (web/api healthy).
- Next:
  - Optional: add a dedicated completed-material archive view if historical traceability is needed in UI.
- Blockers: none.

## Compacted Update (2026-02-25, per-project report numbering + numbered uploaded photo names)
- Changed:
  - Added per-project sequential `report_number` assignment on construction report creation.
  - Exposed `report_number` in report create/list/processing API payloads.
  - Construction report image attachments are now renamed server-side to numbered names (`report-<token>-photo-<index>.<ext>`), independent from phone/library filenames.
  - PDF base filename generation now includes report number for project reports.
- Verified:
  - `docker compose run --rm api sh -lc 'cd /app && PYTHONPATH=. pytest -q tests/test_workflows.py::test_project_task_planning_ticket_file_and_report_flow'` pass.
  - `./scripts/test.sh` pass (`49 passed`, web build successful).
  - `docker compose run --rm api sh -lc 'cd /app && alembic upgrade head'` pass.
  - `docker compose up -d --build api web caddy` pass (api/web healthy).
- Next:
  - Optional: show report number directly in report-history cards where available.
- Blockers: none.

## Compacted Update (2026-02-25, update menu resolves current release version instead of placeholder)
- Changed:
  - Admin update status now treats `APP_RELEASE_VERSION=local-production` as a placeholder and attempts to resolve the real current release tag from local git (`HEAD` tag).
  - If release commit env is missing, update status also derives `current_commit` from local git `HEAD`.
  - Update menu no longer displays `local-production`; it falls back to resolved version/commit, and when already up-to-date can use latest release label as a display fallback.
- Verified:
  - `docker compose run --rm api sh -lc 'cd /app && PYTHONPATH=. pytest -q tests/test_auth_rbac.py -k "update_status or install_update"'` pass.
  - `cd apps/web && npm run build` pass.
  - `./scripts/test.sh` pass (`50 passed`, web build successful).
  - `docker compose up -d --build api web caddy` pass (api/web healthy).
- Next:
  - Optional: set `APP_RELEASE_VERSION`/`APP_RELEASE_COMMIT` in deployment env for explicit, deterministic version display.
- Blockers: none.

## Compacted Update (2026-02-26, chat creation uses users + roles multi-select)
- Changed:
  - Chat restriction creation now supports role-based participants in addition to explicit users.
  - Added `/threads/participant-roles` and updated thread create payload to accept `participant_roles`.
  - Restricted-thread access now grants visibility/send/read when user is explicitly selected, matches a selected role, or is creator (legacy group membership still honored for existing data).
  - New Chat modal now uses task-style chip multi-select for users and roles; replaced group selector in chat create flow.
- Verified:
  - `cd apps/api && PYTHONPATH=. python3 -m compileall app` pass.
  - `cd apps/web && npm run build` pass.
  - `./scripts/test.sh` pass (`53 passed`, web build successful).
  - `docker compose up --build -d api web caddy` pass.
  - `docker compose exec -T api alembic current` => `20260226_0029 (head)`.
- Next:
  - Optional: remove legacy chat-group participant endpoint/model if no clients rely on it.
- Blockers: none.

## Compacted Update (2026-02-26, restricted chat access editing + archive/restore/delete)
- Changed:
  - Added post-creation restricted chat audience editing in `PATCH /threads/{id}` using `participant_user_ids` and `participant_roles`.
  - Restricted chat updates now allow already-member archived users to remain in membership (graceful history handling), while still blocking new archived-user additions.
  - Added chat lifecycle actions:
    - `POST /threads/{id}/archive`
    - `POST /threads/{id}/restore`
    - `DELETE /threads/{id}`
  - Added thread archive state in DB/model/output (`status`, `is_archived`) and defaulted thread lists to active chats only (`include_archived=true` to include archived).
  - Frontend chat UI now supports:
    - editing users/roles in the existing thread edit modal,
    - archive/delete actions in chat header,
    - archived chats modal with restore/delete.
- Verified:
  - `cd apps/api && PYTHONPATH=. python3 -m compileall app` pass.
  - `cd apps/web && npm run build` pass.
  - `./scripts/test.sh` pass (`53 passed`, web build successful).
  - `docker compose up --build -d api web caddy` pass.
  - `docker compose exec -T api alembic upgrade head` pass.
  - `docker compose exec -T api alembic current` => `20260226_0030 (head)`.
- Next:
  - Optional: add dedicated audit-log events for chat archive/restore/delete/member changes.
- Blockers: none.

## Compacted Update (2026-02-26, chat header actions merged into 3-dot menu)
- Changed:
  - Replaced separate chat-header buttons (`Edit`, `Archive`, `Delete`) with one 3-dot action menu in the thread header.
  - Added menu open/close behavior for outside click, Escape key, and context changes (thread/view change).
  - Kept existing action handlers and confirmations; only interaction surface changed.
- Verified:
  - `cd apps/web && npm run build` pass.
  - `docker compose up --build -d web caddy` pass (web healthy).
- Next:
  - Optional: replicate same compact action-menu pattern in archived-thread rows for UI consistency.
- Blockers: none.

## Compacted Update (2026-02-26, project overview map includes copy-address icon)
- Changed:
  - Added a compact copy-address icon button to the Project Overview map card header.
  - Button copies the current project address to clipboard and is disabled when no address exists.
  - Reused clipboard fallback logic and added localized notice/error messages for address copy.
- Verified:
  - `cd apps/web && npm run build` pass.
  - `docker compose up --build -d web caddy` pass (web/api/caddy healthy).
  - `curl -k -I https://localhost/` returns `HTTP/2 200`.
- Next:
  - Optional: add brief inline “copied” tooltip state on the map button for instant visual feedback.
- Blockers: none.

## Compacted Update (2026-02-26, task assignee picker shows absence date-range hints)
- Changed:
  - Added a compact availability note in task assignee suggestion rows and selected assignee chips.
  - Notes are shown in all task assignment flows (overview create modal, task edit modal, and project task create).
  - Hint text format: `Absent from <start> until <end>` with reason marker (`Vacation`/`School`), localized for German/English.
  - Visibility logic checks the task due date (or today when no due date is set) against approved vacation ranges and school absence ranges (including recurring weekday school entries).
- Verified:
  - `cd apps/web && npm run build` pass.
  - `docker compose up --build -d web caddy` pass (web/api/caddy healthy).
  - `curl -k -I https://localhost/` returns `HTTP/2 200`.
- Next:
  - Optional: add a color accent/icon for unavailable assignees to improve scanability in long suggestion lists.
- Blockers: none.

## Compacted Update (2026-02-26, nicknames are now editable and removable)
- Changed:
  - Removed one-time nickname lock behavior for admins; nicknames can now be changed after initial set.
  - Added nickname removal support by saving an empty nickname value.
  - Kept nickname uniqueness enforcement across users and admin-only nickname management.
  - Updated profile UI copy/validation flow to allow set/change/remove in one input without lock state.
- Verified:
  - `docker compose run --rm api sh -lc 'cd /app && PYTHONPATH=. pytest -q tests/test_workflows.py -k nickname'` pass (`3 passed`).
  - `cd apps/web && npm run build` pass.
  - `docker compose up --build -d api web caddy` pass (api/web/caddy healthy).
  - `curl -k -I https://localhost/` returns `HTTP/2 200`.
- Next:
  - Optional: remove/repurpose `nickname_set_at` if historical timestamp is no longer needed in UI/API.
- Blockers: none.

## Compacted Update (2026-02-26, task sub-tasks + report carry-over follow-up tasks)
- Changed:
  - Added task-level `subtasks` storage and API fields for create/update/list.
  - Added sub-task entry fields in task create/edit flows (project tasks and weekly planning modal).
  - Added sub-task checklist in “Construction report from task” flow.
  - Report submit now sends `source_task_id` + completed sub-tasks; backend auto-creates a new **unassigned** follow-up task when some sub-tasks remain open.
  - Follow-up task keeps the remaining sub-tasks and is linked in activity log.
  - Added idempotent Alembic migration `20260226_0031_task_subtasks`.
- Verified:
  - `./scripts/test.sh` pass (`53 passed`, web build pass).
  - `docker compose up --build -d api web caddy` pass (api/web/caddy healthy).
  - `curl -k -I https://localhost/` returns `HTTP/2 200`.
- Next:
  - Optional: add explicit “report from task” action in project task list (not only my-tasks view) for faster access to sub-task checklist.
- Blockers: none.

## Compacted Update (2026-02-26, DB-safe update gate with preflight + snapshot)
- Changed:
  - Added `scripts/preflight_migrations.sh` to validate migrations on a temporary cloned DB before touching the real DB.
  - Added `scripts/safe_update.sh` for a guarded update path (`optional pull -> build -> preflight -> backup -> migrate -> deploy`).
  - Added `BACKUP_PASSPHRASE_FILE` support to `scripts/backup.sh` and `scripts/restore.sh`.
  - Hardened admin update install flow:
    - dry-run now performs real migration preflight on a temporary clone,
    - install now creates a pre-update DB snapshot and aborts if preflight fails.
  - Updated web admin update UI to show failed preflight/install responses as errors (not success notices).
- Verified:
  - Targeted admin update tests added for dry-run preflight and install snapshot/preflight ordering.
  - Web production build runs with updated update-menu behavior.
- Next:
  - Optional: add upload-volume snapshot support to auto-install flow in addition to DB snapshot.
- Blockers: none.

## Compacted Update (2026-02-26, report shows completed sub-tasks + task edit shows last edited timestamp)
- Changed:
  - Updated construction report PDF composition so `completed_subtasks` are rendered in `Ausgefuehrte Arbeiten` together with `work_done`.
  - Replaced task edit modal field `Wochenstart (Montag)` with read-only `Zuletzt bearbeitet` value.
  - Kept `week_start` persistence logic internal: when due date exists, week start is derived from due date; otherwise existing week start is retained.
- Verified:
  - `docker compose run --rm --build api sh -lc 'cd /app && PYTHONPATH=. pytest -q tests/test_construction_report_pdf.py'` pass (`4 passed`).
  - `cd apps/web && npm run build` pass.
- Next:
  - Optional: add one integration test that inspects generated report PDF text for completed sub-task rows.
- Blockers: none.

## Compacted Update (2026-02-26, HEIC/HEIF upload support for avatars, thread icons, and report image selection)
- Changed:
  - API image validation for avatar/thread icon uploads now accepts image uploads by MIME **or** file extension, including `.heic/.heif`.
  - API image stack now includes `pillow-heif` so HEIC avatar/thread icon uploads can be converted to JPEG for broader browser compatibility.
  - Added optional HEIC->JPEG conversion path for avatar/thread icon uploads when HEIC decoder support is available at runtime.
  - Web file inputs for avatar, thread icon, and report photos now explicitly accept `.heic/.heif`.
  - Avatar modal can save HEIC source files even when in-browser preview/crop is unavailable.
- Verified:
  - `docker compose run --rm --build api sh -lc 'cd /app && PYTHONPATH=. pytest -q tests/test_workflows.py -k "heic"'` pass (`2 passed`).
  - `cd apps/web && npm run build` pass.
  - `docker compose up -d --build --force-recreate api web caddy` pass (healthy services, `https://localhost/` and `https://localhost/api` return `200`).
- Next:
  - Optional: add browser E2E coverage for HEIC avatar flow on Safari/iOS.
- Blockers: none.

## Compacted Update (2026-02-26, project-level materials tab + merged report materials + unit suggestions)
- Changed:
  - Added a new `Materials` tab in project navigation (between `Project Hours` and `Job Tickets`).
  - Added backend endpoint `GET /api/projects/{project_id}/materials` to aggregate materials from project construction reports.
  - Aggregation merges rows by normalized `item + unit + article_no`, sums numeric quantities, and tracks non-numeric qty notes.
  - Added unit suggestion dropdown support (`datalist`) for material unit inputs with free-text fallback.
- Verified:
  - `docker compose run --rm api sh -lc 'cd /app && PYTHONPATH=. pytest -q tests/test_workflows.py -k project_task_planning_ticket_file_and_report_flow'` pass.
  - `cd apps/web && npm run build` pass.
  - `docker compose up -d --build --force-recreate api web caddy` pass (services healthy, `/` and `/api` return `200`).
- Next:
  - Optional: add a quick CSV export for aggregated project materials.
- Blockers: none.

## Compacted Update (2026-02-26, backup/restore script transport hardening)
- Changed:
  - Replaced `docker compose cp` usage in `scripts/backup.sh`, `scripts/preflight_migrations.sh`, and `scripts/restore.sh` with stream copy via `docker compose exec -T ... cat`.
  - Added secure temp-directory creation helper (`mktemp -d` + `chmod 700`) in those scripts so restrictive shell `umask` values do not break temp folder access.
- Verified:
  - `bash -n scripts/backup.sh scripts/preflight_migrations.sh scripts/restore.sh scripts/safe_update.sh` pass.
  - `rg -n "docker compose cp" scripts/backup.sh scripts/preflight_migrations.sh scripts/restore.sh` returns no matches.
- Next:
  - Optional: apply the same stream-copy hardening to other helper scripts still using `docker compose cp` if needed in production environments.
- Blockers: none.

## Compacted Update (2026-02-28, release version display consistency in admin updates + user menu popup)
- Changed:
  - Backend update-status resolver now infers `current_version` from GitHub metadata when local release metadata is placeholder-only (`local-production`) and commit hash matches latest/tagged release commit.
  - Frontend now uses one shared release-resolution path for:
    - Admin tools `System updates` current version label,
    - bottom-left user menu popup release label.
  - Bottom-left popup label changed from `Firmware build` to `Release version` and no longer defaults to showing `local-production`.
- Verified:
  - `docker compose run --rm --build api sh -lc 'cd /app && PYTHONPATH=. pytest -q tests/test_auth_rbac.py -k "update_status"'` pass (`3 passed`).
  - `cd apps/web && npm run build` pass.
- Next:
  - Optional: expose resolved release metadata in a non-admin API endpoint if non-admin users should always see exact release tags too.
- Blockers: none.

## Compacted Update (2026-02-28, prevent accidental project-edit modal close on drag selection)
- Changed:
  - Fixed project edit/create modal backdrop behavior so it only closes when pointer down + pointer up both happen on the backdrop.
  - Prevents accidental modal close (and unsaved form loss) when selecting text inside an input/textarea and releasing pointer outside the modal.
- Verified:
  - `cd apps/web && npm run build` pass.
  - `docker compose up -d --build web caddy` pass.
  - `curl -k -s -o /dev/null -w "%{http_code}" https://localhost/` returns `200`.
- Next:
  - Optional: apply the same pointer-safe backdrop close pattern to other edit modals with unsaved form state.
- Blockers: none.

## Compacted Update (2026-02-28, sidebar workspace split toggle: construction vs office)
- Changed:
  - Added a new workspace-mode toggle next to the `SMPL` header in the left sidebar.
  - Workspace now has two top-level modes: `Construction` and `Office`.
  - Added persistent workspace-mode state in frontend (`localStorage` key: `smpl_workspace_mode`).
  - Both workspace modes currently render the same app content by design (placeholder split for later tailored views).
- Verified:
  - `cd apps/web && npm run build` pass.
  - `docker compose up -d --build web caddy` pass.
  - `curl -k -s -o /dev/null -w "%{http_code}" https://localhost/` returns `200`.
- Next:
  - Tailor navigation/content visibility per workspace mode once UX rules are finalized.
- Blockers: none.

## Compacted Update (2026-03-03, task/calendar project labels + time ordering)
- Changed:
  - Task cards and calendar rows no longer show task IDs.
  - Replaced task-ID display with clickable project title (`project_number - project_name`) in task overview and calendar views.
  - Added project navigation links from task rows (including calendar/planning rows) to open project detail directly.
  - Added frontend day-task sorting by due date + start time for calendar/planning day columns.
  - Standardized core project title presentation across sidebar/project lists to show number first, then name.
- Verified:
  - `cd apps/web && npm run build` pass.
- Next:
  - Optional: add backend ordering by `start_time` for planning/task endpoints so all clients receive identical sort order server-side.
- Blockers: none.

## Compacted Update (2026-03-03, persistent report-feed chat + overview latest reports list)
- Changed:
  - Added backend report-feed service that maintains a global chat thread `Latest Construction Reports`.
  - On successful construction report processing, system now posts a chat message into that thread and links the generated PDF attachment to the message.
  - Added new API endpoint `GET /api/construction-reports/recent?limit=10` for newest construction reports ordered by `created_at` descending.
  - Updated overview page with a new card listing the last 10 created construction reports including quick open and project navigation actions.
- Verified:
  - `docker compose run --rm api sh -lc 'cd /app && PYTHONPATH=. pytest -q tests/test_workflows.py -k project_task_planning_ticket_file_and_report_flow'` pass.
  - `cd apps/web && npm run build` pass.
  - `docker compose up -d --build api web caddy` pass.
- Next:
  - Optional: pin or visually badge the feed thread in chat sidebar for faster discovery.
- Blockers: none.

## Compacted Update (2026-03-03, report-feed thread backfill + project label details)
- Changed:
  - Added backend report-feed sync/backfill so the global chat thread `Latest Construction Reports` is auto-created during thread listing and existing report PDFs without feed messages are backfilled.
  - Feed message text now explicitly includes project number and project name (`Project <number> - <name>` when available).
  - Global/project chat thread listing now sorts by latest activity (`updated_at`) so the report-feed thread stays near the top when new reports arrive.
- Verified:
  - `docker compose run --rm api sh -lc 'cd /app && PYTHONPATH=. pytest -q tests/test_workflows.py -k project_task_planning_ticket_file_and_report_flow'` pass.
  - `cd apps/web && npm run build` pass.
- Next:
  - Optional: add a dedicated pin/badge treatment for the report-feed thread in the chat sidebar.
- Blockers: none.

## Compacted Update (2026-03-03, report-feed thread protection + first-report creation timing)
- Changed:
  - Report-feed thread (`Latest Construction Reports`) is now protected from deletion via API.
  - Feed sync no longer creates the thread in an empty system; it appears only once at least one construction report exists.
  - Existing behavior retained: once reports exist, feed sync/backfill keeps the thread/messages aligned with report PDFs.
- Verified:
  - `docker compose run --rm --build api sh -lc 'cd /app && PYTHONPATH=. pytest -q tests/test_workflows.py -k project_task_planning_ticket_file_and_report_flow'` pass.
  - `docker compose up -d --build api` pass.
- Blockers: none.

## Compacted Update (2026-03-03, project tasks tab compact add action)
- Changed:
  - Removed the large inline `Create task` form from `Project -> Tasks`.
  - Kept the tasks list card and added a compact `+` icon action in the tasks header.
  - `+` now opens the existing task modal prefilled with the current project.
- Verified:
  - `cd apps/web && npm run build` pass.
  - `docker compose up -d --build web caddy` pass.
- Next:
  - Optional: remove now-unused project-task-inline form state/helpers from `App.tsx` in a cleanup pass.
- Blockers: none.

## Compacted Update (2026-03-03, office workspace tasks menu + filters)
- Changed:
  - Added a dedicated `Tasks` nav entry for `Office` workspace mode (while `Construction` mode keeps `My Tasks`).
  - Added new `office_tasks` view with a full tasks list from `GET /tasks?view=projects_overview`.
  - Implemented office task filters for:
    - task status,
    - assignee (including explicit `Unassigned`),
    - due date,
    - project.
  - Added reset action for office task filters and kept project jump links directly from each task row.
  - Added workspace-mode view handoff (`my_tasks` <-> `office_tasks`) so switching mode keeps navigation consistent.
- Verified:
  - `./scripts/test.sh` pass.
  - `docker compose up -d --build web caddy` pass (stack currently rebuilt with `web`, `api`, `caddy`).
  - `curl -k -s -o /dev/null -w "%{http_code}" https://localhost/` => `200`.
- Blockers: none.

## Compacted Update (2026-03-03, searchable project selection + undated task creation)
- Changed:
  - Office `Tasks` project filter now supports search + multi-select chips instead of a long single dropdown.
  - Office project filter can select multiple projects at once and remove selections individually.
  - Task modal no longer auto-fills due date by default outside explicit planning context.
  - Task creation from the modal now allows empty `due_date`; undated tasks are saved with `week_start = null` so they do not appear in calendar/planning views.
  - Task modal now saves through `POST /tasks` with optional date/time.
- Verified:
  - `./scripts/test.sh` pass (`60 passed`).
  - `cd apps/web && npm run build` pass.
  - `docker compose up -d --build web caddy` pass.
  - `curl -k -s -o /dev/null -w "%{http_code}" https://localhost/` => `200`.
- Blockers: none.

## Compacted Update (2026-03-03, office task filter cleanup + undated due-date filter)
- Changed:
  - Office task project search no longer renders all project suggestions by default; suggestions appear only while typing.
  - Office due-date filtering now supports `No due date` to list tasks with empty due date.
  - Due-date date picker is disabled while `No due date` is active to avoid conflicting filter states.
- Verified:
  - `cd apps/web && npm run build` pass.
  - `docker compose up -d --build web caddy` pass.
  - `curl -k -s -o /dev/null -w "%{http_code}" https://localhost/` => `200`.
- Blockers: none.

## Compacted Update (2026-03-03, centered add-task plus icon)
- Changed:
  - Centered the `+` glyph in `.task-add-icon-btn` by applying explicit flex centering.
- Verified:
  - `cd apps/web && npm run build` pass.
  - `docker compose up -d --build web caddy` pass.
  - `curl -k -s -o /dev/null -w "%{http_code}" https://localhost/` => `200`.
- Blockers: none.

## Compacted Update (2026-03-03, overview shift controls + report card order)
- Changed:
  - In Overview `My current status`, the clock action button is now always left-aligned (both clock-in and clock-out states).
  - Current shift info/no-open-shift text now appears on the right side of the action row and is vertically centered with the button.
  - `Latest construction reports` card moved directly beneath `My current status` in a dedicated left overview column so it is no longer at the bottom.
- Verified:
  - `cd apps/web && npm run build` pass.
  - `docker compose up -d --build web caddy` pass.
  - `curl -k -s -o /dev/null -w "%{http_code}" https://localhost/` => `200`.
- Blockers: none.

## Compacted Update (2026-03-03, optional task due date + overdue state/filter + image format handling)
- Changed:
  - Task creation modal now allows empty `due_date` (and optional `start_time`) so tasks can be created without a due date.
  - Added automatic overdue behavior for tasks one day past due date (`due_date < today` and not done).
  - Added overdue display/filter support in task views:
    - new status label `Overdue/Überfällig`,
    - Office task status filter includes `overdue`,
    - overdue task cards are highlighted in a light red tone.
  - Added backend task output flag `is_overdue` to expose server-side overdue state.
  - Avatar crop/upload now preserves common non-HEIC output formats (jpg/png/webp) instead of always forcing JPEG; HEIC/HEIF continues to resolve to JPEG path.
- Verified:
  - `./scripts/test.sh` pass (`61 passed`, web build pass).
  - `docker compose up -d --build api web caddy` pass.
  - `curl -k -s -o /dev/null -w "%{http_code}" https://localhost/` => `200`.
- Blockers: none.

## Compacted Update (2026-03-03, local page unreachable startup crash fix)
- Changed:
  - Fixed frontend startup crash caused by a temporal dead zone reference in `apps/web/src/App.tsx` (`officeFilteredTasks` used `todayIso` before initialization).
  - Updated overdue filter logic to derive `referenceTodayIso` directly from `now` inside the memoized filter.
- Verified:
  - `docker compose up -d --build web caddy` pass.
  - `curl -k -s -o /dev/null -w "%{http_code}" https://localhost/` => `200`.
  - `curl -k -s -o /dev/null -w "%{http_code}" https://localhost/api` => `200`.
  - Playwright browser check on `http://192.168.5.59/` loads `SMPL Workflow` page without console startup errors.
- Blockers: none.

## Compacted Update (2026-03-04, DATANORM material catalog + material picker menu)
- Changed:
  - Added persistent material catalog backend tables (`material_catalog_items`, `material_catalog_import_state`) plus new material-need metadata fields (`material_catalog_item_id`, `article_no`, `unit`, `quantity`).
  - Added automatic catalog ingestion from `MATERIAL_CATALOG_DIR` (default `/data/Datanorm_Neuanlage`) with search endpoint `GET /api/materials/catalog`.
  - Added manual material-need creation endpoint `POST /api/materials` so catalog items can be added directly to project material needs.
  - Extended Materials main view with a second panel (`Material catalog`) supporting project selection, search, and one-click add into the needs list.
  - Added API coverage for catalog search/import and add-to-needs flow (`apps/api/tests/test_material_catalog.py`).
- Verified:
  - `./scripts/test.sh` pass (`62 passed`, web build pass).
  - `cd apps/web && npm run build` pass.
- Blockers:
  - The source directory `Datanorm_Neuanlage` is not present in the current workspace snapshot, so real catalog content import depends on providing that folder at runtime.

## Compacted Update (2026-03-05, task modal accidental-close guard)
- Changed:
  - Switched task create/edit modal backdrop closing from plain `onClick` to pointer-down/up guarded behavior (matching the existing project modal).
  - Prevents accidental modal close when selecting text in a task field and releasing the mouse outside the edit card.
- Verified:
  - `cd apps/web && npm run build` pass.
- Blockers: none.

## Compacted Update (2026-03-05, project overview office rework/next-steps box)
- Changed:
  - Extended `GET /api/projects/{id}/overview` with `office_notes`, derived from the latest project construction reports that contain `office_rework` or `office_next_steps`.
  - Added a new Project Overview card showing those office follow-up entries with report/date context.
  - Notes are populated automatically from saved report payload data, so new report submissions appear in the overview without any manual sync step.
- Verified:
  - `docker compose run --rm api sh -lc 'cd /app && PYTHONPATH=. pytest -q tests/test_workflows.py::test_project_task_planning_ticket_file_and_report_flow'` pass.
  - `cd apps/web && npm run build` pass.
  - `docker compose up -d --build api web caddy` pass.
  - `curl -k -s -o /dev/null -w "%{http_code}" https://localhost/` => `200`.
  - `curl -k -s -o /dev/null -w "%{http_code}" https://localhost/api` => `200`.
- Blockers: none.

## Compacted Update (2026-03-05, office-only visibility for project overview office notes card)
- Changed:
  - Project Overview office-notes card is now rendered only when workspace mode is `office`.
  - Construction workspace no longer shows the office follow-up card.
- Verified:
  - `cd apps/web && npm run build` pass.
  - `docker compose up -d --build web caddy` pass.
  - `curl -k -s -o /dev/null -w "%{http_code}" https://localhost/` => `200`.
  - `curl -k -s -o /dev/null -w "%{http_code}" https://localhost/api` => `200`.
- Blockers: none.

## Compacted Update (2026-03-05, materials catalog search cap + stale-search guard + searchable project picker)
- Changed:
  - Materials catalog search is now limited to 10 results in UI and API (`/materials/catalog` clamps requested `limit` to 10).
  - Added stale-request protection for catalog searches in the web app so older responses no longer overwrite newer query results.
  - Replaced the materials catalog project dropdown with a searchable project picker (type-to-search suggestions + selected project chip).
- Verified:
  - `docker compose run --rm --build api python -m pytest -q tests/test_material_catalog.py` pass (`4 passed`).
  - `./scripts/test.sh` pass (`65 passed`, web build pass).
  - `docker compose up -d --build api web caddy` pass.
  - `curl -k -s -o /dev/null -w "%{http_code}" https://localhost/` => `200`.
  - `curl -k -s -o /dev/null -w "%{http_code}" https://localhost/api` => `200`.
- Blockers: none.

## Compacted Update (2026-03-05, materials catalog project search bar persistence + alignment)
- Changed:
  - Materials catalog project picker now shows the selected project directly inside the project search bar as an inline chip.
  - Selected project chip remains visible while typing a new project search query.
  - Project and material search fields in the materials catalog now use the same layout and input height for consistent sizing/alignment.
- Verified:
  - `cd apps/web && npm run build` pass.
- Blockers: none.

## Compacted Update (2026-03-05, materials project combobox overflow fix)
- Changed:
  - Fixed materials catalog project search combobox overflow so long selected project names/numbers no longer collide with the adjacent material search bar.
  - Improved flex shrink behavior and clipping in the inline selected-project chip/input container.
- Verified:
  - `cd apps/web && npm run build` pass.
  - `docker compose up -d --build web caddy` pass.
  - `curl -k -s -o /dev/null -w "%{http_code}" https://localhost/` => `200`.
  - `curl -k -s -o /dev/null -w "%{http_code}" https://localhost/api` => `200`.
- Blockers: none.

## Compacted Update (2026-03-05, materials selected project shown as plain search-bar text)
- Changed:
  - Removed the inline chip/box around the selected project in the materials project picker.
  - Project search field now shows selected project number/name directly as plain text in the input.
  - Removed extra no-selection/search hint text from the project field as requested.
- Verified:
  - `cd apps/web && npm run build` pass.
  - `docker compose up -d --build web caddy` pass.
  - `curl -k -s -o /dev/null -w "%{http_code}" https://localhost/` => `200`.
  - `curl -k -s -o /dev/null -w "%{http_code}" https://localhost/api` => `200`.
- Blockers: none.

## Compacted Update (2026-03-05, materials project search overwrite loop fix)
- Changed:
  - Fixed materials project picker input loop where selected project text reappeared immediately after deleting input content.
  - Added focused edit-state handling so users can type over the current project text directly and search a replacement project without forced text restoration during editing.
  - Suggestions are now shown only while the project field is focused.
- Verified:
  - `cd apps/web && npm run build` pass.
  - `docker compose up -d --build web caddy` pass.
  - `curl -k -s -o /dev/null -w "%{http_code}" https://localhost/` => `200`.
  - `curl -k -s -o /dev/null -w "%{http_code}" https://localhost/api` => `200`.
- Blockers: none.

## Compacted Update (2026-03-05, construction report office material commas no longer split into multiple needs)
- Changed:
  - Updated backend office-material parser to keep each entered line as one material-need item.
  - Removed comma/semicolon based splitting in `_parse_office_material_need_items`, so text like `NYM-J 5x6, 25m ring` remains one entry.
- Verified:
  - `docker compose run --rm api sh -lc 'cd /app && PYTHONPATH=. pytest -q tests/test_workflows.py -k "construction_report_office_material_need_keeps_commas_in_single_item"'` pass.
  - `docker compose run --rm api sh -lc 'cd /app && PYTHONPATH=. pytest -q tests/test_workflows.py -k "project_task_planning_ticket_file_and_report_flow"'` pass.
- Blockers: none.

## Compacted Update (2026-03-05, task/report material ID autofill + project materials readability)
- Changed:
  - Added automatic material-row enrichment in task create/edit and construction report forms: when item/article ID fields match a known catalog entry, row fields are replaced with catalog data (`item`, `article_no`, `unit`) while keeping entered quantity.
  - Added stale-edit guards so async lookup only applies to the row value that triggered the lookup.
  - Fixed Project > Materials list compression by using a dedicated full-width row layout instead of the compact global materials card grid.
- Verified:
  - `cd apps/web && npm run build` pass.
  - `docker compose up -d --build web caddy` pass.
  - `curl -k -s -o /dev/null -w "%{http_code}" https://localhost/` => `200`.
  - `curl -k -s -o /dev/null -w "%{http_code}" https://localhost/api` => `200`.
- Blockers: none.

## Compacted Update (2026-03-05, automatic zero-padding for time inputs across forms)
- Changed:
  - Updated shared time typing parser so colon-based single-digit input is preserved while typing (e.g. `8:3` no longer collapses to `83`).
  - Added blur-time normalization for task start time fields and construction report worker start/end fields so single digits are auto-padded to `HH:MM` after entry.
- Verified:
  - `cd apps/web && npm run build` pass.
  - `docker compose up -d --build web caddy` pass.
  - `curl -k -s -o /dev/null -w "%{http_code}" https://localhost/` => `200`.
  - `curl -k -s -o /dev/null -w "%{http_code}" https://localhost/api` => `200`.
- Blockers: none.

## Compacted Update (2026-03-05, release metadata auto-sync + local material catalog server sync rollout)
- Changed:
  - Added `scripts/update_release_metadata.sh` to generate runtime release metadata file `apps/api/.release.env` from local git tag/commit.
  - Updated compose runtime wiring so `api` and `api_worker` optionally load generated `apps/api/.release.env` (when present) in addition to `apps/api/.env.example`.
  - Updated `scripts/safe_update.sh` to refresh release metadata automatically before API rebuild/deploy.
  - Changed default API env template release fields to placeholder values (`APP_RELEASE_VERSION=local-production`, empty commit) so stale hardcoded `v1.0.0` cannot persist.
  - Added release notes document for `v1.4.0`.
- Verified:
  - `./scripts/test.sh` pass (`66 passed` API tests + web production build pass).
  - `bash -n scripts/update_release_metadata.sh scripts/safe_update.sh` pass.
  - `docker compose config` pass with optional `.release.env` mapping.
- Blockers: none.

## Compacted Update (2026-03-05, admin update flows now refresh release metadata too)
- Changed:
  - Updated admin manual update step list to include `./scripts/update_release_metadata.sh` right after `git pull`.
  - Updated automatic admin install command sequence to run `./scripts/update_release_metadata.sh` before migration execution.
  - Updated admin update install test expectation accordingly.
- Verified:
  - `docker compose run --rm --build api sh -lc 'cd /app && PYTHONPATH=. pytest -q tests/test_auth_rbac.py -k "update_status or install_update"'` pass (`6 passed`).
  - `./scripts/test.sh` pass (`66 passed` + web build pass).
- Blockers: none.

## Compacted Update (2026-03-09, Task I lazy-loaded page chunks)
- Changed:
  - Converted all 16 page imports in `apps/web/src/App.tsx` from static imports to `React.lazy()` with named-export adapters.
  - Wrapped login view and main page area in `Suspense` fallbacks and switched to `mainView`-conditional page rendering.
  - Kept modals (`FileUploadModal`, `AvatarModal`, `ThreadModal`, `ArchivedThreadsModal`) eagerly mounted outside `Suspense`.
  - Added `.page-loading-spinner` CSS fallback in `apps/web/src/styles.css`.
  - Added readable lazy chunk naming in `apps/web/vite.config.ts` via `build.rollupOptions.output.chunkFileNames`.
- Verified:
  - `cd apps/web && npx tsc --noEmit` pass.
  - `cd apps/web && npm run build` pass.
  - `ls -lh apps/web/dist/chunks/ | sort -k5 -rh | head -20` shows per-page chunks (`AdminPage-*`, `TimePage-*`, `ProjectPage-*`, etc.).
  - `./scripts/test.sh` pass (`76 passed`, web build pass).
- Blockers: none.

## Compacted Update (2026-03-09, dual project addresses + construction-site map/weather fallback)
- Changed:
  - Added `construction_site_address` to project model/schema/API payloads and responses.
  - Added Alembic migration `20260309_0035_project_construction_site_address.py` to persist the new DB column.
  - Updated project weather endpoint to prefer construction-site address and fall back to customer address when missing.
  - Updated project create/edit UI to capture both addresses.
  - Updated project overview contact card to display both addresses.
  - Updated project map/ticket/calendar location resolution to use construction-site address first, then customer address.
  - Updated project import/header mapping to recognize/import dedicated construction-site address fields.
- Verified:
  - `docker compose run --rm api sh -lc 'cd /app && PYTHONPATH=. pytest -q tests/test_projects.py tests/test_project_import.py'` pass (`11 passed`).
  - `cd apps/web && npx tsc --noEmit` pass.
  - `cd apps/web && npm run build` pass.
  - `./scripts/test.sh` pass (`78 passed`, web build pass).
  - `docker compose run --rm api sh -lc 'cd /app && alembic upgrade head'` pass (applies `20260309_0035`).
- Blockers: none.

## Compacted Update (2026-03-17, v1.7.1 hotfix release prep + attachment corruption handling)
- Changed:
  - Bundled the unreleased post-`v1.7.0` fixes into hotfix release `v1.7.1`.
  - Kept the time-export corrections and construction-report UX fixes from the latest five commits after `v1.7.0`.
  - Added encrypted attachment payload validation before chunked preview/download streaming so truncated/corrupted stored files fail with a clean API `409` instead of a broken upstream stream.
  - Added release notes document `docs/releases/v1.7.1.md`.
- Verified:
  - `./scripts/test.sh` pass (`80 passed`, web build pass).
- Next:
  - Deploy `v1.7.1` locally and to the SMPL server.
  - Verify Jellyfin/Traefik routing on the separate host `192.168.1.150` once access is available.
- Blockers:
  - Jellyfin host credentials/config were not yet available in-repo or on the SMPL server (`192.168.1.127`).
