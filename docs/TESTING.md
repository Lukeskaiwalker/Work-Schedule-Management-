# Testing

## Commands
- One-command full checks (API tests + web build):
  - `./scripts/test.sh`
- API unit/integration tests:
  - `docker compose run --rm api pytest -q`
  - Fallback without Docker daemon:
  - `python3.12 -m venv .venv && source .venv/bin/activate && pip install -r apps/api/requirements.txt && cd apps/api && PYTHONPATH=. pytest -q`
- Web build verification:
  - `cd apps/web && npm install && npm run build`
- Local smoke tests for backup/restore:
  - `BACKUP_PASSPHRASE='strong-pass' ./scripts/restore_smoke_test.sh`
  - This now validates restored DB rows + uploads file marker + HTTPS API status, not only script execution.
- Local browser smoke (manual automation):
  - Start local API + web dev servers, then run Playwright CLI flow for login/project/report submit.

## Latest Result (2026-03-09, migration + error-boundary + bell-icon follow-on)
- One-command checks:
  - `./scripts/test.sh`: pass (`76 passed`, web build pass).
- Type checks:
  - `cd apps/web && npx tsc --noEmit`: pass (`0` errors).
- Migration validation:
  - `docker compose exec -T api alembic upgrade head`: pass.
  - Postgres schema check confirms `notifications` table and expected indexes.

## Latest Result (2026-03-04, material images + duplicate reporting)
- Targeted API coverage:
  - `docker compose run --build --rm api sh -lc 'cd /app && PYTHONPATH=. pytest -q tests/test_material_catalog.py'`: pass (`3 passed`).
  - Added assertions for:
    - duplicate row skip counting via `GET /api/materials/catalog/state`,
    - automatic catalog-item image enrichment propagation to material needs responses.
- One-command checks:
  - `./scripts/test.sh`: pass (`64 passed`, web build pass).
- Frontend build:
  - `cd apps/web && npm run build`: pass.

## Latest Result (2026-03-04, DATANORM material catalog correction)
- One-command checks:
  - `./scripts/test.sh`: pass (`63 passed`, web build pass).
- Targeted API coverage:
  - `docker compose run --build --rm api sh -lc 'cd /app && PYTHONPATH=. pytest -q tests/test_material_catalog.py'`: pass (`2 passed`).
  - New assertions verify DATANORM `A/B` parsing maps article, combined item text, unit, manufacturer derivation, EAN, and formatted price.
- Runtime deploy validation:
  - `docker compose up --build -d api web caddy`: pass.
  - Material catalog reimport executed with new parser signature; DB sample rows confirm corrected DATANORM field mapping.

## Latest Result (2026-02-26, admin nickname + anonymized report submitter)
- Frontend:
  - `cd apps/web && npm run build`: pass.
- Backend:
  - Python syntax compile checks for changed API files: pass.
  - Targeted pytest execution could not run in this environment:
    - local `pytest` module missing,
    - Docker fallback unavailable (`Cannot connect to Docker daemon`).
- Added automated coverage (new tests in `apps/api/tests/test_workflows.py`):
  - admin nickname availability + one-time lock behavior,
  - admin-only nickname restriction,
  - construction report submitter uses nickname/display name.

## Latest Result (2026-02-26, restricted chat participants)
- API + web one-command check:
  - `./scripts/test.sh`: pass (`53 passed`, web build pass).
- Added coverage in `apps/api/tests/test_workflows.py` for:
  - restricted thread creation with `participant_user_ids` + `participant_group_ids`,
  - visibility filtering on `/api/threads` for selected users/group members vs outsiders,
  - access denial on restricted message read/send for non-participants,
  - archived users excluded from participant selector endpoint,
  - archived user IDs rejected in restricted-thread create payload.
- Runtime deploy verification:
  - `docker compose up --build -d api web caddy`: pass.
  - `curl -k https://localhost/` -> `200`.
  - `curl -k https://localhost/api` -> `200`.

## Latest Result (2026-02-24, async report queue + worker/runtime tuning)
- One-command run (`./scripts/test.sh`): pass.
- API tests: pass (`47 passed`) in Docker mode.
- Web build: pass (`vite build`).
- Targeted regression run:
  - `docker compose run --build --rm api sh -lc 'cd /app && PYTHONPATH=. pytest -q tests/test_workflows.py -k "project_task_planning_ticket_file_and_report_flow or webdav_projects_root_includes_archive_and_general_collections"'`
  - Result: pass (`2 passed`, `21 deselected`).
- New assertion coverage:
  - report create response includes `processing_status`,
  - processing-status endpoint (`GET /api/construction-reports/{id}/processing`) returns terminal state in inline mode.

## Latest Result (2026-02-20)
- One-command run (`./scripts/test.sh`): pass.
- API tests: pass (`7 passed`) in Docker mode.
- Web build: pass.
- Chat thread enhancements checks:
  - creator-owned thread edit permissions are enforced (`creator` allowed, non-creator denied, chat managers allowed).
  - thread icon upload/retrieval endpoint path passes for authenticated users with thread access.
  - unread counter increments for unseen messages and resets after message list read.
- Avatar/chat/planning UX iteration checks:
  - Profile settings now expose avatar change via hover overlay on the avatar image.
  - Avatar crop modal supports drag-to-position with pointer/mouse/touch and zoom slider.
  - Weekly planning calendar highlights the current day.
  - Chat thread list starts directly under header and thread creation uses compact plus icon + modal.
  - Sidebar date/time is shown in one compact line and logout text remains centered in compact control.
  - Runtime checks: `docker compose up -d` pass; `docker compose ps` healthy.
  - Live deploy sync check: `docker compose up -d --build --force-recreate web caddy` completed; running stack serves updated UI bundle and remains healthy.
- Profile-avatar iteration checks:
  - `POST /api/users/me/avatar` accepts image upload and persists `avatar_updated_at`.
  - `GET /api/users/{id}/avatar` returns stored avatar bytes with image content type.
  - Non-image avatar upload is rejected (`400`).
  - Avatar image request is now skipped when no avatar exists (prevents repeated 404 console noise for initials-only users).
  - Sidebar date/time renders on one line and logout button text is centered in compact control.
  - Playwright smoke confirms profile modal includes avatar-crop entrypoint (`output/playwright/profile-avatar-modal-20260219.png`).
  - Playwright open/snapshot on LAN URL confirms no avatar 404 console error when user has no profile picture.
- Sidebar/planning/file-preview iteration checks:
  - Project files upload-arrow control matches WebDAV icon button footprint.
  - Project files `Preview` opens in separate browser tab/window (no in-app modal overlay).
  - Sidebar footer shows compact language + logout controls in one row; logout right-aligned.
  - Sidebar footer shows live date/time below the user card.
  - Weekly planning shows ISO week number (`KW/CW`) and supports previous/next week arrow navigation.
  - Weekly planning week picker input normalizes selected date to Monday.
  - Runtime checks: `docker compose up -d --build` pass, `docker compose ps` healthy, `curl -k -I https://localhost/` -> `200`, `curl -k https://localhost/api` -> service `ok`.
- Sidebar alignment + role-restore checks:
  - Project-header plus button is centered and remains in-line with header title at mobile and desktop widths.
  - Footer compact controls (`DE`, `EN`, `Sign out`) share the same control height and font sizing.
  - DB role recovery validation:
    - `SELECT id,email,role FROM users WHERE id=1;` returns `admin@example.com | admin`.
- Profile/sidebar iteration checks:
  - Profile avatar in sidebar footer opens `Profile & settings` view.
  - Admin users see embedded admin center controls in the profile view.
  - Project list active highlight is shown only in `Project` view; top-level nav selection no longer leaves project highlighted.
  - Project files upload control uses compact upload-arrow icon and opens upload modal.
  - Desktop layout provides independent sidebar/content scrolling.
  - Runtime checks: `docker compose up -d --build` pass, `docker compose ps` healthy, `curl -k -I https://localhost/` -> `200`, `curl -k https://localhost/api` -> service `ok`.
- UI polish verification (sidebar/files/planning):
  - Files upload in project files now opens via compact upload-icon modal (no dedicated upload card).
  - Sidebar shows language toggle + signed-in user block in footer area.
  - Weekly planning calendar uses expanded day-card layout and fills desktop content area more effectively.
  - Runtime checks: `docker compose up -d --build` pass, `docker compose ps` healthy, `curl -k -I https://localhost/` -> `200`, `curl -k https://localhost/api` -> service `ok`.
- Construction report optional-project checks:
  - Added API coverage for project-default autofill in report payload when using project-scoped endpoint.
  - Added API coverage for global report creation without `project_id` using `/api/construction-reports`.
  - Added API coverage for construction report file listing endpoint (`/api/construction-reports/files`) and download of generated general-folder report PDFs.
- File-share reliability + preview checks:
  - Added API coverage for Unicode filename upload/download and inline preview endpoint.
  - Verified `/api/files/{id}/download` and `/api/files/{id}/preview` return `200` with safe `Content-Disposition` headers.
- Wiki checks:
  - Added API coverage for wiki CRUD + permission boundaries (`wiki:view` and `wiki:manage`).
  - Verified live create/list calls against running Docker stack.
- Multi-assignee + My Tasks iteration checks:
  - Added API coverage for multi-assignee planning assignment and assigned-employee completion authorization.
  - Verified weekly planning calendar endpoint still returns 7-day buckets with task placement.
  - Verified frontend build with new planning modal and left-nav My Tasks flow.
  - `docker compose up -d --build`: pass; `docker compose ps` healthy.
  - `curl -k -I https://localhost/`: `200`.
  - `curl -k https://localhost/api`: `200`.
- Project master-data rollout verification:
  - Added/ran API coverage for project create/update with `project_number` + customer fields.
  - `docker compose exec -T db psql -U smpl -d smpl -c "\d+ projects"` confirms new columns and unique index `ix_projects_project_number`.
  - `docker compose up -d --build api web caddy`: pass after migration `20260218_0003`.
  - `docker compose ps`: `db/api/web` healthy.
  - `curl -k -I https://localhost/`: `200`.
  - `curl -k https://localhost/api`: `200`.
- Latest UI refinement verification (tasks/files/construction/create-new):
  - `cd apps/web && npm run build`: pass.
  - `./scripts/test.sh`: pass (`5 passed` API + web build).
  - `docker compose up -d --build`: pass.
  - `docker compose ps`: `db/api/web` healthy.
  - `curl -k -I https://localhost/`: `200`.
  - `curl -k https://localhost/api`: `200` with `{"service":"SMPL Workflow API","status":"ok"}`.
- UI/navigation refactor rollout:
  - `docker compose up -d --build api web caddy`: pass.
  - `docker compose ps`: all services healthy.
  - `curl https://localhost/` and `curl https://localhost/api`: both `200`.
- Backup/restore smoke:
  - `BACKUP_PASSPHRASE=smoketest-passphrase ./scripts/restore_smoke_test.sh`: pass.
  - Verified marker project and marker upload file were restored after deletion.
  - Verified post-restore `https://localhost/api` responded `200`.
- TLS/browser access:
  - `./scripts/trust_caddy_root_macos.sh`: pass on macOS host.
  - Verified `curl https://localhost/` and `curl https://localhost/api` return `200` without `-k`.
- LAN demo access:
  - Verified `curl http://192.168.2.180/` and `curl http://192.168.2.180/api` return `200` on host LAN IP.
- WebDAV project files:
  - Added API smoke in tests (`test_project_files_webdav_mount_flow`) for `PUT/PROPFIND/GET` on `/api/dav/projects/{project_id}` with Basic Auth.
- Docker runtime:
  - `docker compose up -d --build`: pass
  - `docker compose ps`: `db/api/web` healthy and running
  - `curl -k https://localhost/api`: `200` with status JSON
- Static asset check:
  - `curl -kI https://localhost/logo.jpeg`: `200` (logo served correctly)
- Playwright smoke: pass (login, DE/EN switch, project creation, time clock-out flow, chat thread/message flow).
- Playwright screenshot artifact: `output/playwright/local-smoke-20260217.png`.
- Chat composer refinement rollout (2026-02-20):
  - `./scripts/test.sh`: pass (`7 passed` API + web build).
  - `docker compose up -d --build web`: pass.
  - `docker compose ps`: `db/api/web/caddy` healthy.
  - `curl -k -I https://localhost/`: `200`.
  - `curl -k https://localhost/api`: `200` with service status JSON.
- Chat fixed-height/scroll behavior rollout (2026-02-20):
  - `./scripts/test.sh`: pass (`7 passed` API + web build).
  - `docker compose up -d --build web`: pass.
  - `docker compose ps`: `db/api/web/caddy` healthy.
  - `curl -k -I https://localhost/`: `200`.
  - `curl -k https://localhost/api`: `200` with service status JSON.
- Chat attachment-send + auto-follow rollout (2026-02-20):
  - `./scripts/test.sh`: pass (`7 passed` API + web build).
  - `docker compose up -d --build web`: pass.
  - `docker compose ps`: `db/api/web/caddy` healthy.
  - `curl -k -I https://localhost/`: `200`.
  - `curl -k https://localhost/api`: `200` with service status JSON.
- Chat attachment-draft + bubble sizing follow-up (2026-02-20):
  - Added API regression assertion for attachment-only message send via `files={"attachment": ...}`.
  - `./scripts/test.sh`: pass (`7 passed` API + web build).
  - `docker compose up -d --build web caddy`: pass.
  - `docker compose ps`: `db/api/web/caddy` healthy.
  - `curl -k -I https://localhost/`: `200`.
  - `curl -k https://localhost/api`: `200` with service status JSON.
- Time gauge + required-hours controls rollout (2026-02-20):
  - Added API assertions for:
    - admin and CEO allowed to update employee required daily hours,
    - employee denied (`403`) on the same endpoint,
    - `/api/time/current` now includes `required_daily_hours`, `daily_net_hours`, `progress_percent_live`.
  - `./scripts/test.sh`: pass (`7 passed` API + web build).
  - `docker compose up -d --build`: pass.
  - `docker compose ps`: `db/api/web/caddy` healthy.
  - `curl -k -I https://localhost/`: `200`.
  - `curl -k https://localhost/api`: `200` with service status JSON.
- Excel import + extra-attributes rollout (2026-02-20):
  - Added API tests in `apps/api/tests/test_project_import.py`:
    - preserves unmapped Excel columns in `projects.extra_attributes`
    - generates temporary `T...` project numbers only for missing values
    - maps `Nr.` to project number and updates existing projects on re-import.
  - `./scripts/test.sh`: pass (`10 passed` API + web build).
  - Live import run:
    - `./scripts/import_projects_excel.sh "KW 8 Projektstatus SMPL Energy Verwaltung.xlsx"`
    - result: `processed=42, created=42, updated=0, temporary_numbers=2`.
- Sidebar/header/notiz/status normalization rollout (2026-02-20):
  - Added API import test:
    - German `Aktueller Status` values map to canonical project status.
    - `Notiz` column maps into project note (`description`).
  - `./scripts/test.sh`: pass (`11 passed` API + web build).
  - Runtime validation:
    - `docker compose up -d --build api web`: pass.
    - `./scripts/import_projects_excel.sh "KW 8 Projektstatus SMPL Energy Verwaltung.xlsx"`: pass (`processed=42, created=2, updated=40, temporary_numbers=2` on this run).
    - DB check: `SELECT status, COUNT(*) FROM projects GROUP BY status;` confirms canonical set in use after normalization.
    - DB check: `SELECT COUNT(*) FROM projects WHERE COALESCE(description,'') <> '';` confirms imported notes are persisted.
- Excel parity import + idempotent dedupe rollout (2026-02-20):
  - Added API tests in `apps/api/tests/test_project_import.py` for:
    - `Notiz` -> `last_state` mapping,
    - `Letzter Status Datum` -> `last_status_at` mapping,
    - full-status-text persistence (`Aktueller Status` stored as source value),
    - multi-sheet dedupe behavior,
    - re-import idempotency for temporary-number rows,
    - skip of identity-less rows.
  - `./scripts/test.sh`: pass (`13 passed` API + web build).
  - Runtime import verification:
    - `./scripts/import_projects_excel.sh "KW 8 Projektstatus SMPL Energy Verwaltung.xlsx"` -> `processed=70, created=0, updated=68, temporary_numbers=0, duplicates_skipped=2`.
    - repeated rerun returns same counters (`created=0`).
  - DB checks:
    - distinct status values include Excel vocabulary (for example `Angebot abgeschickt`, `In Durchführung`, `Rechnung erstellen`).
    - `last_state` and `last_status_at` populated on imported rows.

## Coverage (Current)
- Authentication and RBAC guards.
- Core project/task workflows.
- Global chat threads and project-linked thread visibility.
- Chat thread metadata and read-state behavior (creator edit policy, icon endpoint, unread lifecycle).
- Weekly planning calendar API (`GET /planning/week/{week_start}`).
- Time tracking happy path plus live status/clock-out/edit endpoint behavior.
- Construction report persistence, PDF artifact generation, Telegram stub behavior, and multipart image upload path.
- Construction reports in both project-scoped and general-folder modes (including autofill defaults + file listing endpoint).
- Sites/job tickets print endpoint.
- Project files, WebDAV flow, and chat message flows (including message attachments metadata and text-only message path).
- File download/preview responses with Unicode filenames.
- Wiki API CRUD and RBAC behavior.
- Profile avatar upload/preview workflow and non-image validation.

## Missing / Next
- Expanded negative-path tests for every role/endpoint combination.
- UI tests (mobile viewport and key flows).
- End-to-end restore validation on clean host with full compose restart.

## Latest Result (2026-02-21)
- `./scripts/test.sh`: pass.
- API tests: pass (`15 passed`) in Docker mode.
- Web build: pass (`vite build`).
- New overnight time-tracking regression coverage:
  - `test_time_tracking_counts_overnight_shift_in_daily_current` verifies open shifts that started the previous day still contribute to `daily_net_hours` and `progress_percent_live`.
- New local-timezone boundary regression coverage:
  - `test_time_tracking_daily_uses_local_timezone_boundaries` verifies daily totals use local day boundaries (default `Europe/Berlin`) instead of raw UTC day cuts.
- Runtime check:
  - `docker compose up -d --build`: pass.

## Latest Result (2026-02-23)
- `./scripts/test.sh`: pass.
- API tests: pass (`37 passed`) in Docker mode.
- Web build: pass (`vite build`).
- Transfer/handoff docs created for workspace migration continuity:
  - `docs/HANDOFF_CONTEXT.md`
  - `docs/CHANGELOG_HANDOFF.md`

## Latest Result (2026-02-23, weather localization + overview header styling)
- `./scripts/test.sh`: pass.
- API tests: pass (`37 passed`) in Docker mode.
- Web build: pass (`vite build`).
- Weather API tests updated for localized fetch signature (`lang`) and DE path assertions.
  - `docker compose ps`: `db/api/web/caddy` healthy.

## Iteration Result (2026-02-21, circular gauge + projects-all navigation)
- Command run:
  - `./scripts/test.sh`
- Result:
  - API tests: pass (`15 passed`).
  - Web build: pass (`vite build`).
- Manual behavior validated in code paths:
  - `All projects` no longer renders duplicated inner subheader.
  - Opening a project from `All projects` now enables a contextual `Back to All Projects` button in project header tools.
  - Time gauge now uses circular rendering with wrapped progress beyond 100% (prevents visual overflow outside gauge boundary).

## Iteration Result (2026-02-21, gauge blue overtime ring)
- Command run:
  - `./scripts/test.sh`
- Result:
  - API tests: pass (`15 passed`).
  - Web build: pass (`vite build`).
- UI behavior covered by code validation:
  - Circular work-time gauge reaches full fill at 100%.
  - Overtime wrap cycles remain blue (no color switch to orange/red).

## Iteration Result (2026-02-21, gauge full at/over target)
- Command run:
  - `./scripts/test.sh`

## Latest Result (2026-02-23, project classes + class-template import)
- `./scripts/test.sh`: pass.
- API tests: pass (`38 passed`) in Docker mode.
- Web build: pass (`vite build`).
- New targeted API coverage:
  - `test_project_class_templates_import_and_autocreate_tasks`
    - validates admin class-template CSV import/export flow,
    - validates project class assignment endpoint behavior,
    - validates auto-created class tasks (unassigned, undated),
    - validates class-based materials/tools prefill for manual task creation,
    - validates rejection when class is not assigned to the project.
- Result:
  - API tests: pass (`15 passed`).
  - Web build: pass (`vite build`).
- UI behavior validated in code path:
  - Circular work gauge now clamps visual fill to 100% once target is reached (no partial wrap display after threshold).

## Iteration Result (2026-02-21, time-tracking gauges + admin-center required-hours relocation)
- Commands run:
  - `./scripts/test.sh`
  - `docker compose up -d --build web caddy`
  - `curl -k -I https://localhost/`
- Results:
  - API tests: pass (`15 passed`).
  - Web build: pass (`vite build`).

## Iteration Result (2026-02-22, admin action menu + soft delete + sender policy)
- Command run:
  - `./scripts/test.sh`
  - `BACKUP_PASSPHRASE=smoketest-passphrase ./scripts/restore_smoke_test.sh`
- Result:
  - API tests: pass (`32 passed`).
  - Web build: pass (`vite build`).
  - Restore smoke: pass (marker DB row + marker upload file restored, HTTPS API verification successful).
- Added coverage:
  - Admin soft-delete keeps user data but deactivates login and blocks invite resend.
  - Admin self-delete is rejected.
  - Outbound email sender is enforced to `technik@smpl-energy.de`.

## Iteration Result (2026-02-22, profile update + invite/reset + recurrence checkboxes)
- Commands run:
  - `./scripts/test.sh`
  - `docker compose up -d --build`
  - `docker compose ps`
  - `BACKUP_PASSPHRASE='smoketest-passphrase' ./scripts/restore_smoke_test.sh`
- Results:
  - API tests: pass (`25 passed`).
  - Web build: pass (`vite build`).
  - Stack health: `db/api/web/caddy` healthy after rebuild.
  - Restore smoke: pass end-to-end (backup, marker delete, restore, marker validation, HTTPS check).
- New automated coverage:
  - `test_profile_settings_update_name_email_password`
  - `test_admin_invite_and_password_reset_links`

## Iteration Result (2026-02-22, admin DB backup export + default employee role)
- Commands run:
  - `./scripts/test.sh`
  - `docker compose up -d --build && docker compose ps`
  - live HTTPS smoke: admin login + `POST /api/admin/backups/database` with key file upload.
- Results:
  - API tests: pass (`27 passed`).
  - Web build: pass (`vite build`).
  - Runtime stack healthy (`db/api/web/caddy`).
  - Backup export endpoint returns `200` and downloadable encrypted `.smplbak` artifact.
- New automated coverage:
  - `test_new_user_defaults_to_employee_role`
  - `test_admin_can_export_encrypted_database_backup`

## Iteration Result (2026-02-22, report/image auto-sort + archive/general WebDAV folders)
- Commands run:
  - `docker compose run --build --rm api sh -lc 'cd /app && PYTHONPATH=. pytest -q tests/test_workflows.py::test_project_task_planning_ticket_file_and_report_flow tests/test_workflows.py::test_project_files_folder_visibility_and_webdav_structure tests/test_workflows.py::test_webdav_projects_root_includes_archive_and_general_collections'`
  - `./scripts/test.sh`
  - `docker compose up -d --build && docker compose ps`
- Results:
  - Targeted API regressions: pass (`3 passed`).
  - Full API tests: pass (`28 passed`).
  - Web build: pass (`vite build`).
  - Compose stack: healthy (`db/api/web/caddy`).
- New automated coverage:
  - project report/image files are stored in `Berichte`/`Bilder`,
  - auto-foldering for project uploads with empty folder,
  - WebDAV root exposes `General Projects` + `Archive`,
  - archived projects are listed under archive collection.

## Iteration Result (2026-02-22, local wiki file explorer + browser preview)
- Commands run:
  - `./scripts/test.sh`
  - `docker compose up -d --build`
  - runtime smoke via local HTTPS API (`/api/wiki/library/files`, `/api/wiki/library/raw/<path>`).
- Results:
  - API tests: pass (`19 passed`).
  - Web build: pass (`vite build`).
  - Docker stack: healthy (`db/api/web/caddy`).
  - Wiki runtime smoke:
    - file index endpoint returns local wiki entries (`count=1018` on current dataset),
    - HTML file preview endpoint returns `200`, `Content-Type: text/html`, and inline `Content-Disposition`.
  - Playwright smoke (LAN URL to avoid local cert error):
    - login succeeds,
    - `Wiki` view renders `Local wiki files` explorer and `Preview` pane,
    - selecting wiki view shows grouped folder structure and inline HTML preview.
  - Runtime health: HTTPS UI responds with `HTTP/2 200`.
- Coverage validated by this change set:
  - Daily gauge center alignment update and compact shift layout render in build.
  - Weekly/monthly gauge rendering path compiles and is fed by weekly timesheet API calls.
  - Required-hours controls removed from time page and available in Admin Center UI paths.

## Iteration Result (2026-02-21, admin-center dedupe + weekly/full-week + overtime gradient)
- Commands run:
  - `./scripts/test.sh`
  - `docker compose up -d --build web caddy`
  - `curl -k -I https://localhost/`
- Results:
  - API tests: pass (`15 passed`).
  - Web build: pass (`vite build`).
  - Runtime health: HTTPS UI responds with `HTTP/2 200`.
- UI behavior validated in code paths:
  - duplicate profile-level required-hours card removed,
  - daily gauge overtime transitions from blue toward red for >100%,
  - weekly rows render full-week date ranges with `KW` + `|` separator and full-week required hours.

## Iteration Result (2026-02-21, month navigation + desktop side-by-side time cards)
- Commands run:
  - `./scripts/test.sh`
  - `docker compose up -d --build web caddy`
  - `curl -k -I https://localhost/`
- Results:
  - API tests: pass (`15 passed`).
  - Web build: pass (`vite build`).
  - Runtime health: HTTPS UI responds with `HTTP/2 200`.
- UI behavior validated in code paths:
  - legal-break helper text no longer includes `(DE)`,
  - time cards render in two columns on desktop and stack on mobile,
  - month arrows update displayed month/year and selected-month weekly/monthly aggregates.

## Iteration Result (2026-02-21, shift-info popover + monthly gauge center simplification)
- Commands run:
  - `./scripts/test.sh`
  - `docker compose up -d --build web caddy`
  - `curl -k -I https://localhost/`
- Results:
  - API tests: pass (`15 passed`).
  - Web build: pass (`vite build`).
  - Runtime health: HTTPS UI responds with `HTTP/2 200`.
- UI behavior validated in code paths:
  - current-time anchored popover renders shift/legal details,
  - main shift card no longer duplicates those details,
  - monthly gauge center uses larger hours value + gray required-hours helper text only.

## Iteration Result (2026-02-21, contextual clock/break controls + monthly required-hours value)
- Commands run:
  - `./scripts/test.sh`
  - `docker compose up -d --build web caddy`
  - `curl -k -I https://localhost/`
- Results:
  - API tests: pass (`15 passed`).
  - Web build: pass (`vite build`).
  - Runtime health: HTTPS UI responds with `HTTP/2 200`.
- UI behavior validated in code paths:
  - action row renders single clock action and single break action based on current shift/break state,
  - current-time trigger remains adjacent to `Aktuelle Schicht` heading,
  - monthly gauge subline displays numeric required monthly hours value.

## Iteration Result (2026-02-21, month-bounded required baseline + all-role required-hours)
- Commands run:
  - `./scripts/test.sh`
  - `docker compose up -d --build`
  - `curl -k -I https://localhost/`
- Results:
  - API tests: pass (`15 passed`).
  - Web build: pass (`vite build`).
  - Runtime health: HTTPS UI responds with `HTTP/2 200`.
- Coverage added/updated:
  - `test_time_tracking_timesheet_and_csv` now also verifies that required daily hours can be updated for a non-employee target (`ceo`) via admin.
- UI behavior validated in code paths:
  - monthly required-hour baseline excludes adjacent-month week spillover,
  - shift-info popover anchor changed to avoid sidebar overlap,
  - required-hours editors are visible for all user rows in admin tables.

## Iteration Result (2026-02-21, WebDAV trailing-slash compatibility + macOS guidance)
- Commands run:
  - `./scripts/test.sh`
  - `docker compose up -d --build`
  - `curl -sk -u admin@example.com:ChangeMe123! -X PROPFIND 'https://localhost/api/dav/projects/1/' -H 'Depth: 1' -D -`
- Results:
  - API tests: pass (`15 passed`).
  - Web build: pass (`vite build`).
  - Runtime health: compose services healthy.
  - WebDAV smoke: trailing-slash root now responds `HTTP/2 207` (was `400` before fix).
- Coverage added/updated:
  - `test_project_files_webdav_mount_flow` now asserts `PROPFIND` also works on `/api/dav/projects/{project_id}/`.

## Iteration Result (2026-02-21, WebDAV all-projects mount)
- Commands run:
  - `./scripts/test.sh`
  - `docker compose up -d --build`
  - `curl -sk -u admin@example.com:ChangeMe123! -X PROPFIND 'https://localhost/api/dav/projects/' -H 'Depth: 1' -D -`
- Results:
  - API tests: pass (`16 passed`).
  - Web build: pass (`vite build`).
  - Runtime health: compose services healthy.
  - WebDAV smoke: all-projects root returns `HTTP/2 207` and includes project collection hrefs.
- Coverage added/updated:
  - `test_project_files_webdav_mount_flow` now verifies root listing at `/api/dav/projects/`.
  - New `test_webdav_projects_root_respects_project_access` verifies root listing is filtered by project membership for employee accounts.

## Iteration Result (2026-02-21, WebDAV copy buttons in tooltip)
- Commands run:
  - `./scripts/test.sh`
  - `docker compose up -d --build`
  - `curl -k -I https://localhost/`
- Results:
  - API tests: pass (`16 passed`).
  - Web build: pass (`vite build`).
  - Runtime health: HTTPS UI responds with `HTTP/2 200`; compose services healthy.
- Notes:
  - Change is UI-only in web app; no backend API contract changes in this iteration.

## Iteration Result (2026-02-21, weekly task modal parity + project search/create + task-header map)
- Commands run:
  - `./scripts/test.sh`
  - `docker compose up -d --build`
  - `docker compose ps`
  - `curl -k -I https://localhost/`
- Results:
  - API tests: pass (`16 passed`).
  - Web build: pass (`vite build`).
  - Runtime health: all services up/healthy; HTTPS UI responds with `HTTP/2 200`.
- Coverage validated by this change set:
  - Weekly planning modal compiles with full task creation fields and assignee autocomplete flow.
  - Weekly task save path supports optional inline project creation before assignment.
  - Project summary/tasks-header map panel renders and degrades safely when no address is set.

## Iteration Result (2026-02-21, cross-week due-date support + assignee calendar export)
- Commands run:
  - `./scripts/test.sh`
  - `docker compose up -d --build`
  - `docker compose ps`
  - `curl -k -I https://localhost/`
- Results:
  - API tests: pass (`16 passed`).
  - Web build: pass (`vite build`).
  - Runtime health: compose services healthy; HTTPS UI responds `HTTP/2 200`.
- Coverage validated by this change set:
  - Weekly planning task modal now accepts free due-date input and computes target week from selected date.
  - Weekly task save path writes to date-derived planning week and refreshes planner for that computed week.
  - `.ics` export UI/actions compile across task views and remain gated to assigned users.

## Iteration Result (2026-02-21, login self-healing for malformed token / pattern errors)
- Commands run:
  - `./scripts/test.sh`
  - `docker compose up -d --build`
  - `docker compose ps`
  - `curl -k -I https://localhost/`
- Results:
  - API tests: pass (`16 passed`).
  - Web build: pass (`vite build`).
  - Runtime health: compose services healthy; HTTPS UI responds `HTTP/2 200`.
- Coverage validated by this change set:
  - frontend token bootstrap now rejects malformed local token values,
  - login path includes guarded retry for browser “expected pattern” transport errors,
  - login path validates token shape before persistence.

## Iteration Result (2026-02-22, WebDAV/sharepoint reliability + preview hardening)
- Commands run:
  - `./scripts/test.sh`
  - `docker compose up -d --build`
  - `curl -sk -u admin@example.com:ChangeMe123! -X PROPFIND 'https://localhost/api/dav/projects/' -H 'Depth: 1'`
  - burst smoke:
    - `for i in $(seq 1 520); do curl -sk -o /dev/null -w '%{http_code}\n' https://localhost/api; done | sort | uniq -c`
- Results:
  - API tests: pass (`18 passed`).
  - Web build: pass (`vite build`).
  - Runtime health: compose services healthy after rebuild.
  - WebDAV root smoke: `207` returned with customer + project ID labels in folder display names.
  - Rate-limit smoke: clean `429` responses under burst load; no internal-server fallback.
- Coverage added/updated:
  - `test_rate_limiter_returns_429_response_without_middleware_exception`
  - `test_preview_falls_back_to_octet_stream_for_invalid_stored_content_type`
  - `test_project_files_webdav_mount_flow` now validates customer + `ID <project_id>` in root WebDAV listing.

## Iteration Result (2026-02-22, task editability + assignee scope + planning layout)
- Commands run:
  - `./scripts/test.sh`
  - `docker compose up -d`
  - `docker compose ps`
- Results:
  - API tests: pass (`19 passed`).
  - Web build: pass (`vite build`).
  - Runtime health: compose services healthy.
- Coverage added/updated:
  - `test_project_task_planning_ticket_file_and_report_flow` now verifies:
    - non-employee role (`accountant`) appears in assignable users endpoint,
    - tasks can be assigned to that non-employee role,
    - admin can edit created task fields and assignee set after creation.

## Iteration Result (2026-02-22, HH:MM task-time reliability + project delete flow)
- Commands run:
  - `./scripts/test.sh`
  - `docker compose up -d --build api web caddy`
  - `docker compose ps`
  - `curl -k -I https://localhost/`
- Results:
  - API tests: pass (`19 passed`).
  - Web build: pass (`vite build`).
  - Runtime health: compose services healthy.
  - HTTPS smoke: `HTTP/2 200`.
- Coverage added/updated:
  - `test_project_task_planning_ticket_file_and_report_flow` now additionally verifies:
    - non-manager project delete is denied (`403`),
    - manager project delete succeeds (`200`, `ok=true`),
    - deleted project is absent from subsequent project listing.

## Iteration Result (2026-02-22, my-task header toggle + overview back button + chat messenger rendering)
- Commands run:
  - `./scripts/test.sh`
  - `docker compose up -d --build api web caddy`
  - `docker compose ps`
  - `curl -k -I https://localhost/`
- Results:
  - API tests: pass (`19 passed`).
  - Web build: pass (`vite build`).
  - Runtime health: compose services healthy.
  - HTTPS smoke: `HTTP/2 200`.
- Coverage added/updated:
  - schema coverage change: `AssignableUserOut` now includes `avatar_updated_at` and remains compatible with existing workflow tests.
  - UI behavior updated and build-validated for:
    - task expansion by header click,
    - overview-origin back button on `construction/time/wiki`,
    - chat day separators + `HH:MM` time labels + sender avatar grouping,
    - left-nav unread chat dot from server unread counts.

## Iteration Result (2026-02-22, task->report action + job-ticket simplification + project sidebar search)
- Commands run:
  - `./scripts/test.sh`
  - `docker compose up -d --build api web caddy`
  - `docker compose ps`
  - `curl -k -I https://localhost/`
- Results:
  - API tests: pass (`19 passed`).
  - Web build: pass (`vite build`).
  - Runtime health: compose services healthy.
  - HTTPS smoke: `HTTP/2 200`.
- Coverage added/updated:
  - Existing workflow/API coverage remains green after UI flow changes.
  - UI behaviors build-validated for:
    - `My Tasks` report-from-task action with complete-then-route behavior,
    - simplified Job Ticket creation using project defaults (date/address),
    - sidebar project search toggle + live filtering.

## Iteration Result (2026-02-22, archive view + task drilldown/back + manager task delete)
- Commands run:
  - `./scripts/test.sh`
  - `docker compose up -d --build`
  - `docker compose ps`
- Results:
  - API tests: pass (`19 passed`).
  - Web build: pass (`vite build`).
  - Runtime health: compose services healthy.
- Coverage added/updated:
  - `test_project_task_planning_ticket_file_and_report_flow` now verifies:
    - non-manager task delete is denied (`DELETE /api/tasks/{id}` -> `403`),
    - manager task delete succeeds (`200`, `ok=true`),
    - deleted task is absent in subsequent task listing for the project.

## Iteration Result (2026-02-22, thread project re-assignment + chat/layout/back-nav polish)
- Commands run:
  - `./scripts/test.sh`
  - `docker compose up -d --build && docker compose ps`
- Results:
  - API tests: pass (`19 passed`).
  - Web build: pass (`vite build`).
  - Runtime health: compose services healthy (`db/api/web/caddy`).
- Coverage added/updated:
  - `test_project_task_planning_ticket_file_and_report_flow` now additionally verifies:
    - thread creator can assign a thread to a project via `PATCH /api/threads/{id}`,
    - thread creator can unassign (`project_id = null`) back to global.
  - Frontend build validated updated behavior for:
    - non-looping project/my-task back navigation,
    - sidebar search spacing under project header,
    - viewport-height chat panel,
    - thread create/edit project selection.

## Iteration Result (2026-02-22, folder policy + absences + CSV import + restore smoke repair)
- Commands run:
  - `./scripts/test.sh`
  - `docker compose up -d --build`
  - `docker compose ps`
  - `BACKUP_PASSPHRASE=smoketest-passphrase ./scripts/restore_smoke_test.sh`
- Results:
  - API tests: pass (`23 passed`).
  - Web build: pass (`vite build`).
  - Runtime health: compose services healthy (`db/api/web/caddy`).
  - Restore smoke: pass after script fix for current schema (`extra_attributes` required).
- Coverage added/updated:
  - `test_project_files_folder_visibility_and_webdav_structure`:
    - validates protected-folder visibility rules and WebDAV folder handling.
  - `test_vacation_and_school_absences_flow`:
    - validates vacation request lifecycle and school absence CRUD/visibility.
  - `test_admin_project_csv_template_and_import` and CSV import service unit coverage:
    - validates admin template + CSV import path and mapped persistence behavior.

## Iteration Result (2026-02-22, release hardening pass)
- Commands run:
  - `./scripts/test.sh`
  - `BACKUP_PASSPHRASE=smoketest-passphrase ./scripts/restore_smoke_test.sh`
  - `docker compose up -d --build && docker compose ps`
  - `curl -sk -I https://localhost/`
  - `curl -sk https://localhost/api`
- Results:
  - API tests: pass (`29 passed`).
  - Web build: pass (`vite build`).
  - Restore smoke: pass (DB + uploads + HTTPS verification).
  - Runtime health: compose services healthy (`db/api/web/caddy`).
  - HTTPS smoke: `HTTP/2 200` and API status `ok`.
- Coverage added/updated:
  - `test_webdav_protected_folder_blocks_employee_write_and_direct_access`:
    - validates non-elevated users cannot write/create/access `Verwaltung/*` via WebDAV (`MKCOL`, `PUT`, direct path listing/read),
    - validates elevated-user read path remains functional.
  - Existing auth test still validates new-user default role:
    - `test_new_user_defaults_to_employee_role`.

## Iteration Result (2026-02-22, server hotfix + restore + wiki sync)
- Commands run:
  - Local: `./scripts/test.sh`
  - Server deploy: `docker compose up -d --build && docker compose ps`
  - Server restore: `BACKUP_PASSPHRASE="$(cat config/backup-test-db.key)" ./scripts/restore.sh backups/backup-20260222-211743.tar.enc`
  - Server health: `curl -sk https://smpl-office.duckdns.org/api`
  - Server auth check: `POST /api/auth/login` with bootstrap creds
- Results:
  - Local API tests: pass (`32 passed`).
  - Local web build: pass.
  - Server stack healthy (`db/api/web/caddy`).
  - API health endpoint returned `status=ok`.
  - Bootstrap credentials blocked post-fix (`401`, inactive user).
  - Wiki payload synced and visible in mount (`2364` files).

## Iteration Result (2026-02-22, bootstrap completion guard)
- Commands run:
  - `./scripts/test.sh`
- Results:
  - API tests: pass (`33 passed`).
  - Web build: pass (`vite build`).
- Coverage added/updated:
  - `test_initial_admin_credential_change_disables_bootstrap_recreation` validates that after initial admin credential change and runtime re-init:
    - old bootstrap login fails,
    - changed credentials continue to work,
    - bootstrap admin is not recreated.
- Live ops check:
  - Server login recovery validated with active admin account on `smpl-office.duckdns.org`.

## Iteration Result (2026-02-22, live deployment + auth recovery verification)
- Commands run:
  - Server: `docker compose up -d --build`, `docker compose ps`, `curl -ksS https://smpl-office.duckdns.org/api`
  - Server auth checks: `POST /api/auth/login` for emergency admin and bootstrap credentials.
- Results:
  - Server stack healthy after rebuild and migration.
  - Emergency admin login succeeds (`200`).
  - Default bootstrap login fails (`401`).
  - Uploaded fresh encrypted backup artifact to server (`backup-20260222-224157.tar.enc`).

## Iteration Result (2026-02-23, project overview/finances/activity)
- Commands run:
  - `./scripts/test.sh`
- Results:
  - API tests: pass (`33 passed`).
  - Web build: pass (`vite build`).
- Coverage added/updated:
  - `test_project_task_planning_ticket_file_and_report_flow` now validates:
    - `GET /api/projects/{id}/overview` payload shape and activity presence,
    - `PATCH /api/projects/{id}/finance` persistence,
    - finance update event visibility in overview change feed.

## Iteration Result (2026-02-23, map/address and overview task list UX)
- Commands run:
  - `./scripts/test.sh`
- Results:
  - API tests: pass (`33 passed`).
  - Web build: pass (`vite build`).
- Manual UI checks performed:
  - project overview map opens external maps when clicking the map itself,
  - no standalone map-open button rendered,
  - overview open-task card shows task rows and scrolls when task count exceeds card height.

## Iteration Result (2026-02-23, simplified overview card + weather placeholder)
- Commands run:
  - `./scripts/test.sh`
- Results:
  - API tests: pass (`33 passed`).
  - Web build: pass (`vite build`).
- Manual UI checks performed:
  - open-task card shows only subheading plus scrollable task list (no counters),
  - subheading spacing under main header reduced,
  - weather placeholder card renders in project overview and spans two grid columns on desktop width.

## Iteration Result (2026-02-23, weather API + cache/throttle)
- Commands run:
  - `./scripts/test.sh`
- Results:
  - API tests: pass (`35 passed`).
  - Web build: pass (`vite build`).
- Coverage added/updated:
  - `test_admin_can_manage_weather_settings`:
    - validates admin weather settings read/update and employee access denial.
  - `test_project_weather_cache_throttle_and_offline_fallback`:
    - validates first refresh fetches provider data,
    - repeated refresh inside 15 minutes uses cache,
    - refresh after cooldown with provider failure falls back to cached values.

## Iteration Result (2026-02-23, weather switched to 5-day forecast)
- Commands run:
  - `./scripts/test.sh`
  - `docker compose up -d`
- Results:
  - API tests: pass (`35 passed`).
  - Web build: pass (`vite build`).
  - Compose stack: services healthy (`db`, `api`, `web`, `caddy`).
- Coverage updated:
  - `test_project_weather_cache_throttle_and_offline_fallback` now validates 5 forecast days in cached/live responses.

## Iteration Result (2026-02-23, weather geocode resilience + address input normalization)
- Commands run:
  - `./scripts/test.sh`
  - `docker compose up -d`
- Results:
  - API tests: pass (`36 passed`).
  - Web build: pass (`vite build`).
  - Compose stack: services healthy (`db`, `api`, `web`, `caddy`).
- Coverage updated:
  - `test_weather_address_candidates_normalize_and_add_country_fallbacks` validates:
    - multiline/comma-heavy address normalization,
    - candidate fallback list with `Deutschland`/`Germany` suffixes.

## Iteration Result (2026-02-23, weather ZIP fallback)
- Commands run:
  - `./scripts/test.sh`
- Results:
  - API tests: pass (`37 passed`).
  - Web build: pass (`vite build`).
- Coverage updated:
  - `test_weather_zip_candidates_extracts_postal_code` validates extraction of DE ZIP fallback candidate from multiline project addresses.

## Iteration Result (2026-02-23, task timestamp refresh + customer appointment planning view)
- Commands run:
  - `docker compose run --rm api sh -lc 'cd /app && PYTHONPATH=/app pytest -q tests/test_workflows.py::test_planning_week_calendar_view'`
  - `cd apps/web && npm run build`
  - `./scripts/test.sh`
- Results:
  - Targeted planning-week test: pass (`1 passed`).
  - Full API tests: pass (`38 passed`).
  - Web build: pass (`vite build`).
- Coverage updated:
  - `test_planning_week_calendar_view` now validates `customer_appointment` tasks and task-type filtering via `task_type=customer_appointment`.

## Iteration Result (2026-02-23, construction report hours -> project totals)
- Commands run:
  - `docker compose run --rm api sh -lc 'cd /app && PYTHONPATH=/app pytest -q tests/test_workflows.py::test_project_task_planning_ticket_file_and_report_flow'`
  - `cd apps/web && npm run build`
  - `./scripts/test.sh`
- Results:
  - Targeted workflow test: pass (`1 passed`).
  - Full API tests: pass (`38 passed`).
  - Web build: pass (`vite build`).
- Coverage updated:
  - `test_project_task_planning_ticket_file_and_report_flow` now validates `reported_hours_total` accumulation from construction report worker times and exposure via:
    - `GET /api/projects/{id}/finance`
    - `GET /api/projects/{id}/overview`

## Iteration Result (2026-02-23, project site-access create/edit + overview display)
- Commands run:
  - `docker compose run --rm api sh -lc 'cd /app && PYTHONPATH=/app pytest -q tests/test_workflows.py::test_project_task_planning_ticket_file_and_report_flow'`
  - `./scripts/test.sh`
  - `docker compose up -d --build`
- Results:
  - Targeted workflow test: pass (`1 passed`).
  - Full API tests: pass (`38 passed`).
  - Web build: pass (`vite build`).
  - Local compose stack: healthy (`db`, `api`, `web`, `caddy`).
- Coverage updated:
  - `test_project_task_planning_ticket_file_and_report_flow` now validates:
    - project create persists `site_access_type` + `site_access_note`,
    - project update can switch to a non-note access type and clears note.

## Iteration Result (2026-02-23, avatar delete + admin user archive separation)
- Commands run:
  - `docker compose run --rm api sh -lc 'cd /app && PYTHONPATH=/app pytest -q tests/test_workflows.py::test_profile_avatar_upload_and_preview'`
  - `./scripts/test.sh`
- Results:
  - Targeted avatar test: pass (`1 passed`).
  - Full API tests: pass (`38 passed`).
  - Web build: pass (`vite build`).
- Coverage updated:
  - `test_profile_avatar_upload_and_preview` now validates:
    - avatar delete endpoint success,
    - avatar metadata reset on `/api/auth/me`,
    - avatar preview returns `404` after deletion,
    - repeated delete remains successful (`deleted=false`).

## Iteration Result (2026-02-23, materials side menu + office material need status flow)
- Commands run:
  - `docker compose run --rm api sh -lc 'cd /app && PYTHONPATH=. pytest -q tests/test_workflows.py -k "project_task_planning_ticket_file_and_report_flow"'`
  - `docker compose run --rm api sh -lc 'cd /app && PYTHONPATH=. pytest -q tests/test_workflows.py'`
  - `cd apps/web && npm run build`
  - `./scripts/test.sh`
  - `docker compose up -d --build api web`
- Results:
  - Targeted workflow test: pass (`1 passed`).
  - Full workflow suite: pass (`23 passed`).
  - Full API suite + web build wrapper: pass (`38 passed`, web build successful).
  - Direct web production build: pass (`vite build`).
  - API container startup confirmed Alembic migration applied: `20260224_0022 -> 20260224_0023`.
- Coverage updated:
  - `test_project_task_planning_ticket_file_and_report_flow` now validates:
    - report `office_material_need` auto-creates `/api/materials` queue entries,
    - default material state is `order`,
    - state update endpoint persists `on_the_way`,
    - material entry includes originating project/report context (`project_id`, `report_date`).

## Iteration Result (2026-02-23, WebDAV project-number links + root upload support)
- Commands run:
  - `docker compose run --rm api sh -lc 'cd /app && PYTHONPATH=. pytest -q tests/test_workflows.py -k "webdav_mount_flow or webdav_projects_root_respects_project_access or webdav_projects_root_includes_archive_and_general_collections or project_files_folder_visibility_and_webdav_structure"'`
  - `cd apps/web && npm run build`
  - `./scripts/test.sh`
- Results:
  - Focused WebDAV/file workflow tests: pass (`4 passed`, `19 deselected`).
  - Full API suite + web build wrapper: pass (`38 passed`, web build successful).
  - Direct web production build: pass (`vite build`).
- Coverage updated:
  - `test_project_files_webdav_mount_flow` now validates:
    - WebDAV root advertises project-number-based href,
    - project-number path access works for a second project member,
    - numeric-ID path remains backward-compatible.
  - `test_project_files_folder_visibility_and_webdav_structure` now validates explicit base-folder upload via `folder=/`.

## Iteration Result (2026-02-23, construction report mobile worker/time/photo flow)
- Commands run:
  - `docker compose run --rm --build api sh -lc 'cd /app && PYTHONPATH=. pytest -q tests/test_workflows.py -k project_task_planning_ticket_file_and_report_flow'`
  - `cd apps/web && npm run build`
  - `./scripts/test.sh`
- Results:
  - Targeted workflow test: pass (`1 passed`).
  - Direct web production build: pass (`vite build`).
  - Full API + web wrapper checks: pass (`38 passed`, web build successful).
- Coverage updated:
  - `test_project_task_planning_ticket_file_and_report_flow` now validates:
    - multipart construction report accepts both `images` and `camera_images`,
    - compact worker times (`730`/`1600`) are parsed and included in `reported_hours_total`,
    - reported-hours total reflects cumulative value after multipart report (`17.0`).

## Iteration Result (2026-02-23, admin update menu + update status/install endpoints)
- Commands run:
  - `docker compose run --rm --build api sh -lc 'cd /app && PYTHONPATH=. pytest -q tests/test_auth_rbac.py'`
  - `cd apps/web && npm run build`
  - `./scripts/test.sh`
- Results:
  - Admin auth/rbac test file: pass (`9 passed`).
  - Direct web production build: pass (`vite build`).
  - Full API + web wrapper checks: pass (`40 passed`, web build successful).
- Coverage updated:
  - `test_admin_can_read_update_status` validates release-status payload mapping and update-available detection.
  - `test_admin_install_update_returns_manual_when_auto_install_unavailable` validates safe manual fallback when auto-install cannot run.

## Iteration Result (2026-02-24, report PDF compaction + construction-upload progress indicator)
- Commands run:
  - `docker compose run --rm --build api sh -lc 'cd /app && PYTHONPATH=. pytest -q tests/test_construction_report_pdf.py tests/test_workflows.py -k "construction-report or construction_report"'`
  - `cd apps/web && npm run build`
  - `./scripts/test.sh`
- Results:
  - Targeted API tests: pass (`2 passed`, `23 deselected`).
  - Direct web production build: pass (`vite build`).
  - Full API + web wrapper checks: pass (`42 passed`, web build successful).
- Coverage updated:
  - `test_construction_report_pdf.py` validates:
    - large images are downscaled/compressed for PDF embedding,
    - invalid/non-image payloads safely fall back without mutation.

## Iteration Result (2026-02-24, file-share performance step 1 - encrypted streaming path)
- Commands run:
  - `docker compose run --build --rm api sh -lc 'cd /app && PYTHONPATH=. pytest -q tests/test_files_service.py tests/test_workflows.py -k "file or webdav"'`
  - `./scripts/test.sh`
- Results:
  - Targeted API file/webdav set: pass (`11 passed`, `14 deselected`).
  - Full API + web wrapper checks: pass (`44 passed`, web build successful).
- Coverage updated:
  - `test_files_service.py` validates:
    - chunked encrypted storage round-trip via stream + full read APIs,
    - legacy Fernet payload compatibility path remains functional.

## Iteration Result (2026-02-24, optimistic edit locking + changed-only patch payloads)
- Commands run:
  - `docker compose run --build --rm api sh -lc 'cd /app && PYTHONPATH=. pytest -q tests/test_optimistic_locking.py tests/test_workflows.py -k "project_task_planning_ticket_file_and_report_flow or file or webdav"'`
  - `docker compose run --build --rm api sh -lc 'cd /app && PYTHONPATH=. pytest -q tests/test_optimistic_locking.py'`
  - `cd apps/web && npm run build`
  - `./scripts/test.sh`
  - `docker compose up -d --build api web caddy`
  - `docker compose ps`
- Results:
  - Targeted optimistic+workflow set: pass (`9 passed`, `17 deselected`).
  - Dedicated optimistic-lock tests: pass (`3 passed`).
  - Full API + web wrapper checks: pass (`47 passed`, web build successful).
  - Direct web production build: pass (`vite build`).
  - Runtime stack healthy after rebuild (`db/api/web/caddy`).
- Coverage updated:
  - Added `tests/test_optimistic_locking.py` validating `409` conflict responses for stale writes on:
    - project patch,
    - task patch,
    - project finance patch.

## Iteration Result (2026-02-24, empty upload guard + WebDAV content-length metadata)
- Commands run:
  - `docker compose run --build --rm api sh -lc 'cd /app && PYTHONPATH=. pytest -q tests/test_workflows.py -k "project_files_webdav_mount_flow or project_file_upload_rejects_empty_payload"'`
  - `./scripts/test.sh`
  - `docker compose up -d --build`
  - `docker compose ps`
- Results:
  - Targeted workflow tests: pass (`2 passed`, `22 deselected`).
  - Full API + web wrapper checks: pass (`48 passed`, web build successful).
  - Runtime stack healthy after rebuild (`db`, `api`, `api_worker`, `web`, `caddy`).
- Coverage updated:
  - `test_project_files_webdav_mount_flow` now asserts WebDAV `PROPFIND` includes non-zero file length for uploaded file.
  - Added `test_project_file_upload_rejects_empty_payload` to prevent regression on zero-byte project uploads.

## Iteration Result (2026-02-24, optimistic quick-action token enforcement in web UI)
- Commands run:
  - `cd apps/web && npm run build`
  - `./scripts/test.sh`
- Results:
  - Direct web production build: pass (`vite build`).
  - Full API + web wrapper checks: pass (`48 passed`, web build successful).
- Coverage notes:
  - No backend contract changes in this iteration.
  - Existing optimistic-lock API tests continue covering `409` behavior for project/task/finance stale writes.

## Iteration Result (2026-02-24, construction report photo queue UX)
- Commands run:
  - `cd apps/web && npm run build`
  - `./scripts/test.sh`
- Results:
  - Direct web production build: pass (`vite build`).
  - Full API + web wrapper checks: pass (`48 passed`, web build successful).
- Coverage notes:
  - No backend contract changes in this iteration.
  - Change is frontend UX/state handling for construction-report photo selection/removal prior to submit.

## Iteration Result (2026-02-24, construction report queued-photo thumbnail tiles)
- Commands run:
  - `cd apps/web && npm run build`
  - `./scripts/test.sh`
- Results:
  - Direct web production build: pass (`vite build`).
  - Full API + web wrapper checks: pass (`48 passed`, web build successful).
- Coverage notes:
  - No backend contract changes in this iteration.
  - Change is frontend rendering/state handling for thumbnail previews of queued report photos.

## Iteration Result (2026-02-25, report materials row-entry mask)
- Commands run:
  - `cd apps/web && npm run build`
  - `./scripts/test.sh`
  - `docker compose up -d --build web caddy`
- Results:
  - Direct web production build: pass (`vite build`).
  - Full API + web wrapper checks: pass (`48 passed`, web build successful).
  - Runtime services healthy after deploy (`web`, `api`, `caddy`).
- Coverage notes:
  - No backend contract changes in this iteration.
  - Change is frontend form/state handling for structured material-entry rows in report creation.

## Iteration Result (2026-02-24, finance tab layout refresh)
- Commands run:
  - `cd apps/web && npm run build`
  - `docker compose up -d --build web caddy`
- Results:
  - Direct web production build: pass (`vite build`).
  - Runtime services healthy after deploy (`web`, `api`, `caddy`).
- Coverage notes:
  - No backend contract changes in this iteration.
  - Change is frontend presentation/layout only for finance tab read view.

## Iteration Result (2026-02-25, finance text-size and spacing adjustment)
- Commands run:
  - `cd apps/web && npm run build`
  - `docker compose up -d --build web caddy`
- Results:
  - Direct web production build: pass (`vite build`).
  - Runtime services healthy after deploy (`web`, `api`, `caddy`).
- Coverage notes:
  - No backend contract changes in this iteration.
  - Change is CSS-only tuning for finance metric readability/density.

## Iteration Result (2026-02-25, materials status indicator + complete action)
- Commands run:
  - `./scripts/test.sh`
  - `docker compose up -d --build api web caddy`
- Results:
  - Full API + web wrapper checks: pass (`48 passed`, web build successful).
  - Runtime services healthy after deploy (`web`, `api`, `caddy`).
- Coverage notes:
  - Added API behavior for `completed` material status and active-list exclusion.
  - Updated workflow integration test to validate `order` -> `on_the_way` -> `available` -> `completed` flow and queue removal.

## Iteration Result (2026-02-25, report numbers + numbered report photo filenames)
- Commands run:
  - `docker compose run --rm api sh -lc 'cd /app && PYTHONPATH=. pytest -q tests/test_workflows.py::test_project_task_planning_ticket_file_and_report_flow'`
  - `./scripts/test.sh`
  - `docker compose run --rm api sh -lc 'cd /app && alembic upgrade head'`
  - `docker compose up -d --build api web caddy`
- Results:
  - Targeted workflow integration: pass (`1 passed`).
  - Full API + web wrapper checks: pass (`49 passed`, web build successful).
  - Migration upgrade: pass (upgraded to `20260225_0026`).
  - Runtime services healthy after deploy (`api`, `web`, `caddy`).
- Coverage notes:
  - Updated workflow test coverage for project report numbering, processing payload report number, and numbered report image filenames.

## Iteration Result (2026-02-25, update menu current release version placeholder removal)
- Commands run:
  - `docker compose run --rm api sh -lc 'cd /app && PYTHONPATH=. pytest -q tests/test_auth_rbac.py -k "update_status or install_update"'`
  - `cd apps/web && npm run build`
  - `./scripts/test.sh`
  - `docker compose up -d --build api web caddy`
- Results:
  - Targeted admin update tests: pass (`2 passed`).
  - Web production build: pass.
  - Full API + web wrapper checks: pass (`50 passed`, web build successful).
  - Runtime services healthy after deploy (`api`, `web`, `caddy`).
- Coverage notes:
  - Added API test for resolving placeholder `local-production` to git-derived release metadata.

## Iteration Result (2026-02-26, chat users+roles multi-select restrictions)
- Commands run:
  - `cd apps/api && PYTHONPATH=. python3 -m compileall app`
  - `cd apps/web && npm run build`
  - `./scripts/test.sh`
  - `docker compose up --build -d api web caddy`
  - `docker compose exec -T api alembic current`
- Results:
  - Python compile check: pass.
  - Web production build: pass.
  - Full API + web wrapper checks: pass (`53 passed`, web build successful).
  - Runtime services healthy after deploy (`api`, `web`, `caddy`).
  - Migration state at runtime: `20260226_0029 (head)`.
- Coverage notes:
  - Workflow test now validates restricted thread creation via `participant_roles` and access for role-matched users.
  - Added invalid-role rejection test and kept archived-user participant rejection checks.

## Iteration Result (2026-02-26, chat access editing + archive/restore/delete)
- Commands run:
  - `cd apps/api && PYTHONPATH=. python3 -m compileall app`
  - `cd apps/web && npm run build`
  - `./scripts/test.sh`
  - `docker compose up --build -d api web caddy`
  - `docker compose exec -T api alembic upgrade head`
  - `docker compose exec -T api alembic current`
- Results:
  - Python compile check: pass.
  - Web production build: pass.
  - Full API + web wrapper checks: pass (`53 passed`, web build successful).
  - Runtime services healthy after deploy (`api`, `web`, `caddy`).
  - Migration state at runtime: `20260226_0030 (head)`.
- Coverage notes:
  - Workflow test now validates:
    - restricted membership changes via `PATCH /threads/{id}`,
    - archive visibility filtering and `include_archived=true`,
    - archived-thread send rejection (`409`),
    - restore flow,
    - thread delete permission + hard delete behavior,
    - archived existing member preservation on thread updates.

## Iteration Result (2026-02-26, chat header 3-dot actions menu)
- Commands run:
  - `cd apps/web && npm run build`
  - `docker compose up --build -d web caddy`
- Results:
  - Web production build: pass.
  - Runtime services healthy after deploy (`web`, `caddy`).
- Coverage notes:
  - UI interaction change only; no API behavior changes introduced in this iteration.

## Iteration Result (2026-02-26, project overview map copy-address button)
- Commands run:
  - `cd apps/web && npm run build`
  - `docker compose up --build -d web caddy`
  - `curl -k -I https://localhost/`
- Results:
  - Web production build: pass.
  - Runtime services healthy after deploy (`api`, `web`, `caddy`).
  - Local HTTPS endpoint reachable (`HTTP/2 200`).
- Coverage notes:
  - Frontend-only interaction change in project overview map card; no API or migration changes.

## Iteration Result (2026-02-26, task assignee absence info in picker)
- Commands run:
  - `cd apps/web && npm run build`
  - `docker compose up --build -d web caddy`
  - `curl -k -I https://localhost/`
- Results:
  - Web production build: pass.
  - Runtime services healthy after deploy (`api`, `web`, `caddy`).
  - Local HTTPS endpoint reachable (`HTTP/2 200`).
- Coverage notes:
  - Frontend-only behavior change in task assignee pickers; no API/migration changes.
  - Manual UI check needed for exact per-user hint text in all three task assignment forms.

## Iteration Result (2026-02-26, nickname edit/remove after set)
- Commands run:
  - `docker compose run --rm api sh -lc 'cd /app && PYTHONPATH=. pytest -q tests/test_workflows.py -k nickname'`
  - `cd apps/web && npm run build`
  - `docker compose up --build -d api web caddy`
  - `curl -k -I https://localhost/`
- Results:
  - Targeted API nickname tests: pass (`3 passed`).
  - Web production build: pass.
  - Runtime services healthy after deploy (`api`, `web`, `caddy`).
  - Local HTTPS endpoint reachable (`HTTP/2 200`).
- Coverage notes:
  - Updated workflow test now covers nickname change and removal flow after initial set.

## Iteration Result (2026-02-26, task sub-tasks + report follow-up carry-over)
- Commands run:
  - `docker compose run --rm --build api sh -lc 'cd /app && PYTHONPATH=. pytest -q tests/test_workflows.py -k "project_task_planning_ticket_file_and_report_flow"'`
  - `./scripts/test.sh`
  - `cd apps/web && npm run build`
- Results:
  - Targeted workflow test: pass (`1 passed`, filtered).
  - Full backend suite + web build wrapper: pass (`53 passed`, web build successful).
- Coverage notes:
  - Workflow test now asserts sub-task persistence on task create/update.
  - Workflow test now asserts report-driven follow-up task creation with remaining sub-tasks and unassigned assignees.

## Iteration Result (2026-02-26, DB-safe update preflight + snapshot guard)
- Commands run:
  - `docker compose run --rm --build api sh -lc 'cd /app && PYTHONPATH=. pytest -q tests/test_auth_rbac.py -k "admin_install_update or admin_can_read_update_status or placeholder_release"'`
  - `cd apps/web && npm run build`
  - `bash -n scripts/preflight_migrations.sh scripts/safe_update.sh scripts/backup.sh scripts/restore.sh`
- Results:
  - Targeted admin update tests: pass (`5 passed`, `7 deselected`).
  - Web production build: pass.
  - Shell syntax checks for new/updated operational scripts: pass.
- Coverage notes:
  - Added update safety coverage for:
    - dry-run migration preflight execution,
    - auto-install order (`git fetch/pull` -> snapshot -> preflight -> real migration),
    - existing manual fallback behavior when auto-install is unavailable.

## Iteration Result (2026-02-26, report completed sub-task rendering + task-edit last-edited display)
- Commands run:
  - `docker compose run --rm --build api sh -lc 'cd /app && PYTHONPATH=. pytest -q tests/test_construction_report_pdf.py'`
  - `cd apps/web && npm run build`
- Results:
  - PDF service tests: pass (`4 passed`).
  - Web production build: pass.
- Coverage notes:
  - Added PDF formatter tests validating completed sub-task rows are included in `Ausgefuehrte Arbeiten` text block.
  - Task edit modal change is frontend-only and build-validated.

## Iteration Result (2026-02-26, HEIC upload support for avatar/thread icons + web file pickers)
- Commands run:
  - `docker compose run --rm --build api sh -lc 'cd /app && PYTHONPATH=. pytest -q tests/test_workflows.py -k "heic"'`
  - `cd apps/web && npm run build`
- Results:
  - Targeted HEIC workflow tests: pass (`2 passed`, filtered).
  - Web production build: pass.
- Coverage notes:
  - Added integration coverage for avatar upload with `.heic` filename and non-image MIME (`application/octet-stream`).
  - Added integration coverage for thread icon upload with `.heic` filename and non-image MIME.

## Iteration Result (2026-02-26, project materials tab + merged report materials)
- Commands run:
  - `docker compose run --rm api sh -lc 'cd /app && PYTHONPATH=. pytest -q tests/test_workflows.py -k project_task_planning_ticket_file_and_report_flow'`
  - `cd apps/web && npm run build`
  - `docker compose up -d --build --force-recreate api web caddy`
  - `curl -k -s -o /dev/null -w "%{http_code}" https://localhost/api`
  - `curl -k -s -o /dev/null -w "%{http_code}" https://localhost/`
- Results:
  - Targeted workflow test: pass (`1 passed`, filtered).
  - Web production build: pass.
  - Runtime services healthy after recreate.
  - Health checks: API `200`, web `200`.
- Coverage notes:
  - Workflow test now validates merged project material summary endpoint output and project access control (`403` for outsider).

## Iteration Result (2026-02-26, backup/restore script transport hardening)
- Commands run:
  - `bash -n scripts/backup.sh scripts/preflight_migrations.sh scripts/restore.sh scripts/safe_update.sh`
  - `rg -n "docker compose cp" scripts/backup.sh scripts/preflight_migrations.sh scripts/restore.sh`
- Results:
  - Shell syntax checks: pass.
  - Targeted scripts no longer contain `docker compose cp` usage.
- Coverage notes:
  - This iteration validates script integrity/safety paths only; no API or frontend runtime behavior changed.

## Iteration Result (2026-02-28, release version display consistency)
- Commands run:
  - `docker compose run --rm --build api sh -lc 'cd /app && PYTHONPATH=. pytest -q tests/test_auth_rbac.py -k "update_status"'`
  - `cd apps/web && npm run build`
- Results:
  - Targeted update-status tests: pass (`3 passed`, filtered).
  - Web production build: pass.
- Coverage notes:
  - Added update-status inference coverage for placeholder local version + matching latest release commit path.
  - Frontend release-label changes are build-verified.

## Iteration Result (2026-02-28, project modal drag-select close fix)
- Commands run:
  - `cd apps/web && npm run build`
  - `docker compose up -d --build web caddy`
  - `curl -k -s -o /dev/null -w "%{http_code}" https://localhost/`
- Results:
  - Web production build: pass.
  - Local web stack rebuild/restart: pass.
  - Web health check: `200`.
- Coverage notes:
  - Change is frontend modal interaction logic; no backend behavior changed in this iteration.

## Iteration Result (2026-02-28, workspace split toggle in sidebar)
- Commands run:
  - `cd apps/web && npm run build`
  - `docker compose up -d --build web caddy`
  - `curl -k -s -o /dev/null -w "%{http_code}" https://localhost/`
- Results:
  - Web production build: pass.
  - Local web stack rebuild/restart: pass.
  - Web health check: `200`.
- Coverage notes:
  - Change is frontend layout/state only; no backend endpoints, migrations, or permission logic changed in this iteration.

## Iteration Result (2026-03-03, task/calendar labels + sorting)
- Commands run:
  - `cd apps/web && npm run build`
  - `docker compose up -d --build web caddy`
  - `curl -k -s -o /dev/null -w "%{http_code}" https://localhost/`
- Results:
  - Web production build: pass.
  - Local web stack rebuild/restart: pass.
  - Web health check: `200`.
- Coverage notes:
  - Frontend rendering/navigation changes verified via TypeScript production build.
  - No backend API behavior changed in this iteration.

## Iteration Result (2026-03-03, persistent report-feed chat + recent reports overview API)
- Commands run:
  - `docker compose run --rm api sh -lc 'cd /app && PYTHONPATH=. pytest -q tests/test_workflows.py -k project_task_planning_ticket_file_and_report_flow'`
  - `cd apps/web && npm run build`
  - `docker compose up -d --build api web caddy`
- Results:
  - Targeted workflow integration test: pass (`1 passed`, filtered).
  - Web production build: pass.
  - Local stack rebuild/restart: pass.
- Coverage notes:
  - Workflow test now verifies creation of the persistent report-feed chat thread, feed message attachment linkage to report PDF, cross-user preview access through chat attachment route, and `/construction-reports/recent` response behavior.

## Iteration Result (2026-03-03, report-feed backfill + project number/name in feed messages)
- Commands run:
  - `docker compose run --rm api sh -lc 'cd /app && PYTHONPATH=. pytest -q tests/test_workflows.py -k project_task_planning_ticket_file_and_report_flow'`
  - `cd apps/web && npm run build`
- Results:
  - Targeted workflow integration test: pass (`1 passed`, filtered).
  - Web production build: pass.
- Coverage notes:
  - Workflow test now verifies report-feed message body includes explicit project number + name, feed thread can be deleted and automatically recreated/backfilled from existing report attachments, and latest report activity ordering keeps the feed thread first.

## Iteration Result (2026-03-03, report-feed non-deletable + first-report gating)
- Commands run:
  - `docker compose run --rm --build api sh -lc 'cd /app && PYTHONPATH=. pytest -q tests/test_workflows.py -k project_task_planning_ticket_file_and_report_flow'`
- Results:
  - Targeted workflow integration test: pass (`1 passed`, filtered).
- Coverage notes:
  - Test now verifies feed thread is absent before any report exists and deletion of the system feed thread returns `403`.

## Iteration Result (2026-03-03, compact project-task add button)
- Commands run:
  - `cd apps/web && npm run build`
  - `docker compose up -d --build web caddy`
- Results:
  - Web production build: pass.
  - Local web stack rebuild/restart: pass.
- Coverage notes:
  - Frontend rendering/navigation only; no backend API behavior changed.

## Iteration Result (2026-03-03, office tasks sidebar view + filters)
- Commands run:
  - `./scripts/test.sh`
  - `docker compose up -d --build web caddy`
  - `curl -k -s -o /dev/null -w "%{http_code}" https://localhost/`
- Results:
  - API tests + web build script: pass (`60 passed`).
  - Local web stack refresh: pass.
  - Web health check: `200`.
- Coverage notes:
  - Verified new office-only task navigation and filtering code path compiles and deploys in local Docker runtime.
  - No backend behavior changes in this iteration.

## Iteration Result (2026-03-03, searchable project filter + undated task creation)
- Commands run:
  - `./scripts/test.sh`
  - `cd apps/web && npm run build`
  - `docker compose up -d --build web caddy`
  - `curl -k -s -o /dev/null -w "%{http_code}" https://localhost/`
- Results:
  - API tests + web build script: pass (`60 passed`).
  - Web production build: pass.
  - Local web stack refresh: pass.
  - Health check: `200`.
- Coverage notes:
  - Verified frontend compiles with new multi-project search filter state.
  - Verified no backend regressions through full default test script.

## Iteration Result (2026-03-03, office project suggestions + no-due-date filter)
- Commands run:
  - `cd apps/web && npm run build`
  - `docker compose up -d --build web caddy`
  - `curl -k -s -o /dev/null -w "%{http_code}" https://localhost/`
- Results:
  - Web production build: pass.
  - Local web stack refresh: pass.
  - Health check: `200`.
- Coverage notes:
  - Verified frontend compiles and local runtime serves updated Office task filter behavior.

## Iteration Result (2026-03-03, centered add-task plus icon)
- Commands run:
  - `cd apps/web && npm run build`
  - `docker compose up -d --build web caddy`
  - `curl -k -s -o /dev/null -w "%{http_code}" https://localhost/`
- Results:
  - Web build: pass.
  - Local web refresh: pass.
  - Health check: `200`.

## Iteration Result (2026-03-03, overview shift alignment + recent report positioning)
- Commands run:
  - `cd apps/web && npm run build`
  - `docker compose up -d --build web caddy`
  - `curl -k -s -o /dev/null -w "%{http_code}" https://localhost/`
- Results:
  - Web build: pass.
  - Local web refresh: pass.
  - Health check: `200`.
- Coverage notes:
  - Verified frontend compiles and updated overview layout is served in local Docker runtime.

## Iteration Result (2026-03-03, optional due date + overdue state/filter + image format handling)
- Commands run:
  - `./scripts/test.sh`
  - `docker compose up -d --build api web caddy`
  - `curl -k -s -o /dev/null -w "%{http_code}" https://localhost/`
- Results:
  - API tests + web build script: pass (`61 passed`, warnings only).
  - Local stack rebuild/restart (`api`, `web`, `caddy`): pass.
  - Health check: `200`.
- Coverage notes:
  - Added API test `test_task_overdue_flag_and_optional_due_date` covering:
    - overdue flag for past-due open tasks,
    - no-due-date task creation,
    - non-overdue for future and done tasks.

## Iteration Result (2026-03-03, page unreachable/startup crash hotfix)
- Commands run:
  - `docker compose up -d --build web caddy`
  - `curl -k -s -o /dev/null -w "%{http_code}" https://localhost/`
  - `curl -k -s -o /dev/null -w "%{http_code}" https://localhost/api`
  - Playwright CLI open check on `http://192.168.5.59/`
- Results:
  - Web rebuild/restart: pass.
  - Local web health: `200`.
  - Local API health via Caddy: `200`.
  - Browser render: pass (`SMPL Workflow` login page visible, no startup ReferenceError after fix).

## Iteration Result (2026-03-04, DATANORM material catalog + materials picker menu)
- Commands run:
  - `docker compose run --rm --build api env PYTHONPATH=/app pytest -q tests/test_material_catalog.py`
  - `docker compose run --rm --build api env PYTHONPATH=/app pytest -q tests/test_material_catalog.py tests/test_workflows.py -k "material_catalog or project_task_planning_ticket_file_and_report_flow"`
  - `./scripts/test.sh`
  - `cd apps/web && npm run build`
- Results:
  - New catalog API test: pass.
  - Targeted workflow + catalog tests: pass (`2 passed`, filtered).
  - Full default test/build script: pass (`62 passed`, web build pass).
  - Standalone web production build: pass.
- Coverage notes:
  - Added `tests/test_material_catalog.py` to verify DATANORM-source ingestion (CSV-style input), catalog search, adding catalog items to material needs, and project-access enforcement.

## Iteration Result (2026-03-05, task modal accidental-close guard)
- Commands run:
  - `cd apps/web && npm run build`
- Results:
  - Web production build: pass.
- Coverage notes:
  - Verified frontend compiles with pointer-guarded backdrop handling for task create/edit modals.

## Iteration Result (2026-03-05, project overview office rework/next-steps box)
- Commands run:
  - `docker compose run --rm api sh -lc 'cd /app && PYTHONPATH=. pytest -q tests/test_workflows.py::test_project_task_planning_ticket_file_and_report_flow'`
  - `cd apps/web && npm run build`
  - `docker compose up -d --build api web caddy`
  - `curl -k -s -o /dev/null -w "%{http_code}" https://localhost/`
  - `curl -k -s -o /dev/null -w "%{http_code}" https://localhost/api`
- Results:
  - Targeted API workflow test: pass (`1 passed`).
  - Web production build: pass.
  - Local stack rebuild/restart: pass.
  - Health checks: `200` for web and API through Caddy.
- Coverage notes:
  - Added assertions in `test_project_task_planning_ticket_file_and_report_flow` verifying `office_notes` content in project overview after report submission.

## Iteration Result (2026-03-05, office-only visibility for project overview office notes card)
- Commands run:
  - `cd apps/web && npm run build`
  - `docker compose up -d --build web caddy`
  - `curl -k -s -o /dev/null -w "%{http_code}" https://localhost/`
  - `curl -k -s -o /dev/null -w "%{http_code}" https://localhost/api`
- Results:
  - Web production build: pass.
  - Local stack refresh: pass.
  - Health checks: `200` for web and API through Caddy.
- Coverage notes:
  - Verified frontend compiles with workspace-mode gate for the office-notes card.

## Iteration Result (2026-03-05, materials catalog search cap + stale-search guard + searchable project picker)
- Commands run:
  - `docker compose run --rm --build api python -m pytest -q tests/test_material_catalog.py`
  - `./scripts/test.sh`
  - `docker compose up -d --build api web caddy`
  - `curl -sk -o /dev/null -w "web:%{http_code}\n" https://localhost/`
  - `curl -sk -o /dev/null -w "api:%{http_code}\n" https://localhost/api`
- Results:
  - Material catalog API tests: pass (`4 passed`).
  - Full default test/build script: pass (`65 passed`, web build pass).
  - Stack rebuild/restart: pass.
  - Health checks: `web:200`, `api:200`.
- Coverage notes:
  - Added API test `test_material_catalog_search_caps_results_to_ten_items` to validate backend cap behavior even when client requests a larger limit.

## Iteration Result (2026-03-05, materials catalog selected-project persistence + search bar alignment)
- Commands run:
  - `cd apps/web && npm run build`
- Results:
  - Web production build: pass.
- Coverage notes:
  - Verified frontend compiles with the new materials project combobox (selected chip inside search bar) and unified search-field sizing/alignment styles.

## Iteration Result (2026-03-05, materials project combobox overflow fix)
- Commands run:
  - `cd apps/web && npm run build`
  - `docker compose up -d --build web caddy`
  - `curl -k -s -o /dev/null -w "%{http_code}" https://localhost/`
  - `curl -k -s -o /dev/null -w "%{http_code}" https://localhost/api`
- Results:
  - Web production build: pass.
  - Stack refresh: pass.
  - Health checks: `200` for web and API.
- Coverage notes:
  - Verified combobox CSS compiles and deploys with overflow-safe long selected project labels.

## Iteration Result (2026-03-05, materials selected project plain-text input display)
- Commands run:
  - `cd apps/web && npm run build`
  - `docker compose up -d --build web caddy`
  - `curl -k -s -o /dev/null -w "%{http_code}" https://localhost/`
  - `curl -k -s -o /dev/null -w "%{http_code}" https://localhost/api`
- Results:
  - Web production build: pass.
  - Stack refresh: pass.
  - Health checks: `200` for web and API.
- Coverage notes:
  - Verified materials project picker renders selected project as plain input text with no inline chip/hint helper text.

## Iteration Result (2026-03-05, materials project search overwrite loop fix)
- Commands run:
  - `cd apps/web && npm run build`
  - `docker compose up -d --build web caddy`
  - `curl -k -s -o /dev/null -w "%{http_code}" https://localhost/`
  - `curl -k -s -o /dev/null -w "%{http_code}" https://localhost/api`
- Results:
  - Web production build: pass.
  - Stack refresh: pass.
  - Health checks: `200` for web and API.
- Coverage notes:
  - Verified materials project input supports overwrite search flow without immediate selected-text reinsertion while editing.

## Iteration Result (2026-03-05, office material comma-splitting fix in construction report flow)
- Commands run:
  - `docker compose run --rm api sh -lc 'cd /app && PYTHONPATH=. pytest -q tests/test_workflows.py -k "construction_report_office_material_need_keeps_commas_in_single_item"'`
  - `docker compose run --rm api sh -lc 'cd /app && PYTHONPATH=. pytest -q tests/test_workflows.py -k "project_task_planning_ticket_file_and_report_flow"'`
- Results:
  - API regression test for comma-containing office material item: pass.
  - Existing construction report end-to-end workflow test: pass.
- Coverage notes:
  - Added `test_construction_report_office_material_need_keeps_commas_in_single_item` to ensure one office-material line with comma creates exactly one material need entry.

## Iteration Result (2026-03-05, material ID autofill in task/report forms + project materials layout fix)
- Commands run:
  - `cd apps/web && npm run build`
  - `docker compose up -d --build web caddy`
  - `curl -k -s -o /dev/null -w "%{http_code}" https://localhost/`
  - `curl -k -s -o /dev/null -w "%{http_code}" https://localhost/api`
- Results:
  - Web production build: pass.
  - Stack refresh: pass.
  - Health checks: `200` for web and API.
- Coverage notes:
  - Manual UI behavior coverage: blur-based catalog autofill now wired into task create/edit and construction report material rows.
  - Project materials tab now renders rows in a full-width readable layout.

## Iteration Result (2026-03-05, automatic zero-padding for time inputs)
- Commands run:
  - `cd apps/web && npm run build`
  - `docker compose up -d --build web caddy`
  - `curl -k -s -o /dev/null -w "%{http_code}" https://localhost/`
  - `curl -k -s -o /dev/null -w "%{http_code}" https://localhost/api`
- Results:
  - Web production build: pass.
  - Stack refresh: pass.
  - Health checks: `200` for web and API.
- Coverage notes:
  - Verified task start-time and report worker time inputs now normalize to `HH:MM` on blur with automatic leading-zero padding.

## Iteration Result (2026-03-05, release metadata automation + release prep)
- Commands run:
  - `./scripts/test.sh`
  - `bash -n scripts/update_release_metadata.sh scripts/safe_update.sh`
  - `docker compose config`
- Results:
  - Full validation script: pass (`66 passed`, web build pass).
  - Shell syntax checks for updated/new scripts: pass.
  - Compose config validation for optional generated release env file: pass.
- Coverage notes:
  - Validated release metadata generation path (`scripts/update_release_metadata.sh`) and compose/runtime wiring (`apps/api/.release.env` optional load).

## Iteration Result (2026-03-05, admin update install flow refreshes release metadata)
- Commands run:
  - `docker compose run --rm --build api sh -lc 'cd /app && PYTHONPATH=. pytest -q tests/test_auth_rbac.py -k "update_status or install_update"'`
  - `./scripts/test.sh`
- Results:
  - Targeted admin update tests: pass (`6 passed`, `7 deselected`).
  - Full validation script: pass (`66 passed`, web build pass).
- Coverage notes:
  - Verified admin manual/auto update paths include `./scripts/update_release_metadata.sh` step without regressing update status/install behaviors.
