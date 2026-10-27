# CODEMAP — SMPL Codebase Reference
> **For agents:** Read this file first instead of exploring source files.
> **Keep it current:** Update this file whenever you add, rename, or delete a module.

---

## Project layout

```
.github/
  workflows/
    release-on-main.yml         GitHub Actions workflow: tags and publishes sanitized GitHub releases on pushes to main
apps/
  api/                        FastAPI backend (Python)
    app/
      core/                   Shared infrastructure
      models/                 SQLAlchemy ORM models
      routers/                FastAPI route handlers
      schemas/                Pydantic I/O models
      services/               Business logic helpers
    tests/                    pytest test suite
    alembic/                  Database migrations
  web/                        React + Vite frontend (TypeScript)
    src/
      pages/                  One component per mainView (lazy-loaded)
      components/             Shared UI components
      hooks/                  Custom React hooks
      context/                AppContext (global state)
      api/                    HTTP client wrapper
      utils/                  Pure utility functions
      types/                  Shared TypeScript types
      styles.css              Global stylesheet (~4 100 lines); breakpoints: ≥900px desktop, ≤899px mobile, ≤768px tablet, ≤480px phone; uses 100dvh throughout
docs/                         Living project docs (STATE, DECISIONS, TESTING, SECURITY, SETUP)
scripts/                      Ops helpers (test.sh, backup.sh, safe_update.sh, build_release_bundle.sh)
infra/maintenance/            Static maintenance-mode page served during safe updates
docker-compose.yml            Services: db, api, web, caddy
.gitattributes                Release archive exclusions for agent/internal files
```

---

## Backend — `apps/api/`

### Core (`app/core/`)

| File | Purpose |
|------|---------|
| `db.py` | SQLAlchemy engine, `SessionLocal`, `Base`, `get_db` dependency |
| `deps.py` | FastAPI dependencies: `get_current_user`, `require_permission`, `get_current_user_from_token` |
| `permissions.py` | Role constants (`ROLE_ADMIN`, `ROLE_EMPLOYEE`, …), `has_permission()` |
| `config.py` | `get_settings()` — Pydantic settings from env vars |
| `security.py` | `verify_password()`, `get_password_hash()` |
| `time.py` | `utcnow()` |
| `log_redaction.py` | `logging.Filter` that strips URL secrets from uvicorn's access log; installed by `main.py` |
| `events.py` | `notify(db, event_type, payload)` — fires pg_notify; `listen_for_events()` — async SSE generator |
| `main.py` | FastAPI app + rate-limit middleware. `lifespan` spawns `_image_loop()`: background async task that calls `sync_pending_material_catalog_images(limit=10)` every 30 s via a dedicated `ThreadPoolExecutor`. |

### Models (`app/models/`) — SQLAlchemy ORM

`entities.py` is a **re-export shim** — import from it for backward compat, edit domain files for changes.

| File | SQLAlchemy classes |
|------|--------------------|
| `user.py` | `User`, `UserActionToken` |
| `project.py` | `Project`, `ProjectFinance`, `ProjectActivity`, `ProjectWeatherCache`, `ProjectMember`, `ProjectClassTemplate`, `ProjectClassAssignment` |
| `task.py` | `Task`, `TaskAssignment` |
| `chat.py` | `ChatThread`, `ChatThreadParticipantUser`, `ChatThreadParticipantRole`, `ChatThreadParticipantGroup`, `ChatThreadRead`, `Message` |
| `team.py` | `EmployeeGroup`, `EmployeeGroupMember` |
| `files.py` | `Attachment`, `ProjectFolder` |
| `materials.py` | `MaterialCatalogItem`, `MaterialCatalogImportState`, `ProjectMaterialNeed` |
| `notification.py` | `Notification` |
| `report.py` | `ConstructionReport`, `ConstructionReportJob` |
| `site.py` | `Site`, `JobTicket` |
| `time_models.py` | `ClockEntry`, `BreakEntry`, `VacationRequest`, `SchoolAbsence` |
| `wiki.py` | `WikiPage` |
| `settings_models.py` | `AppSetting`, `AuditLog` |

### Schemas (`app/schemas/`) — Pydantic

`api.py` is a **re-export shim** — import from it for backward compat, edit domain files for changes.

| File | Pydantic classes |
|------|-----------------|
| `user.py` | `LoginRequest`, `UserCreate`, `UserUpdate`, `UserOut`, `AssignableUserOut`, `ProfileUpdate`, `NicknameAvailabilityOut` |
| `project.py` | `ProjectCreate`, `ProjectUpdate`, `ProjectOut`, `ProjectFinanceUpdate`, `ProjectFinanceOut`, `ProjectActivityOut`, `ProjectOfficeNoteOut`, `ProjectOverviewOut`, `ProjectWeatherDayOut`, `ProjectWeatherOut`, `ProjectClassTaskTemplateOut`, `ProjectClassTemplateOut`, `ProjectImportStatsOut` |
| `task.py` | `TaskCreate`, `TaskUpdate`, `TaskOut`, `PlanningAbsenceOut`, `PlanningDayOut`, `PlanningWeekOut` |
| `chat.py` | `ThreadCreate`, `ThreadUpdate`, `ThreadOut`, `MessageCreate`, `MessageAttachmentOut`, `MessageOut` |
| `team.py` | `EmployeeGroupMemberOut`, `EmployeeGroupOut`, `EmployeeGroupCreate`, `EmployeeGroupUpdate` |
| `files.py` | `ProjectFolderCreate`, `ProjectFolderOut` |
| `materials.py` | `MaterialCatalogItemOut`, `MaterialCatalogImportStateOut`, `ProjectMaterialNeedOut`, `ProjectMaterialNeedUpdate`, `ProjectMaterialNeedCreate`, `ProjectTrackedMaterialOut` |
| `notification.py` | `NotificationOut` |
| `report.py` | `ConstructionReportWorker`, `ConstructionReportMaterial`, `ConstructionReportExtra`, `ConstructionReportPayload`, `ConstructionReportCreate`, `RecentConstructionReportOut` |
| `site.py` | `SiteCreate`, `SiteOut`, `JobTicketCreate`, `JobTicketOut` |
| `time.py` | `ClockOut`, `BreakAction`, `TimesheetOut`, `TimeCurrentOut`, `TimeEntryOut`, `TimeEntryUpdate`, `RequiredDailyHoursUpdate`, `RequiredDailyHoursOut`, `VacationBalanceUpdate`, `VacationBalanceOut`, `VacationRequestCreate`, `VacationRequestReview`, `VacationRequestOut`, `SchoolAbsenceCreate`, `SchoolAbsenceUpdate`, `SchoolAbsenceReview`, `SchoolAbsenceOut` |
| `wiki.py` | `WikiPageCreate`, `WikiPageUpdate`, `WikiPageOut`, `WikiLibraryFileOut` |
| `auth.py` | `InviteCreate`, `InviteDispatchOut`, `PasswordResetDispatchOut`, `InviteAccept`, `PasswordResetConfirm` |
| `settings.py` | `WeatherSettingsOut`, `WeatherSettingsUpdate`, `CompanySettingsOut`, `CompanySettingsUpdate`, `SmtpSettingsOut`, `SmtpSettingsUpdate`, `UpdateStatusOut`, `UpdateInstallRequest`, `UpdateInstallOut` |

### Routers (`app/routers/`)

All registered in `main.py` under the `/api` prefix.

| File | Handles |
|------|---------|
| `auth.py` | Login, logout, `/auth/me`, invite accept, password reset. Every `/auth/me*` route that returns the caller answers `UserMeOut` from `_me_out`; `PATCH /auth/me/preferences` locks the user row |
| `dashboard.py` | `/dashboard*`: the personal start page's layouts per device, role defaults (`settings:manage`) and `absent-today` (docs/DASHBOARD.md §4) |
| `admin.py` | User management, runtime settings (weather, SMTP, company branding), system update center |
| `time_tracking.py` | Clock in/out, break tracking, timesheets, vacations, school absences |
| `events.py` | `GET /events` — SSE live-update stream (session cookie, or a single-use ticket from `POST /events/ticket`; see docs/LOG_HYGIENE.md) |
| `workflow_projects.py` | Project CRUD, finance, members, weather, class templates |
| `workflow_tasks.py` | Task CRUD, assignment, planning week |
| `workflow_chat.py` | Threads, messages, attachments, read state |
| `workflow_files.py` | Project file upload, download, preview, folders; `/files/{id}/…` serve every scope |
| `workflow_customer_files.py` | Customer-level folders and files (`/customers/{id}/folders`, `/files`) |
| `workflow_task_files.py` | Files on a task (`/tasks/{id}/files`), dual-anchored on the task's project or customer |
| `workflow_materials.py` | Material catalog, project material needs |
| `workflow_notifications.py` | `GET /notifications`, `PATCH /notifications/read-all`, `PATCH /notifications/{id}/read`, `PATCH /notifications/{id}/dismiss` |
| `workflow_reports.py` | Construction reports |
| `workflow_sites.py` | Sites, job tickets |
| `workflow_wiki.py` | Wiki pages, library files |
| `workflow_webdav.py` | WebDAV project tree (`/api/dav/projects/`) |
| `workflow_webdav_customers.py` | WebDAV customer tree (`/api/dav/customers/<id - name>/` with the project folders inside) |
| `workflow_system.py` | Rate limiting, system config |
| `workflow_helpers.py` | Shared utilities used by other routers |
| `workflow.py` | Legacy shim — do not add new endpoints here |

### Tests (`tests/`)

All use `conftest.py` fixtures: `client` (TestClient), `admin_token` (str), `reset_db` (autouse).
`auth_headers(token)` is a plain helper function importable from `conftest`.

| File | Covers |
|------|--------|
| `test_integration.py` | Full end-to-end flow spanning all domains |
| `test_admin.py` | Admin user management, invite/reset links |
| `test_auth_rbac.py` | Login, RBAC permissions |
| `test_chat.py` | Thread icon upload |
| `test_class_templates.py` | Project class template import and task autocreation |
| `test_construction_report_pdf.py` | PDF report generation |
| `test_emailer.py` | Email dispatch |
| `test_events.py` | SSE endpoint auth (cookie, single-use ticket; a URL `?token=` is refused) and stream handshake |
| `test_log_redaction.py` | Secrets redacted from the uvicorn access log; same pattern as the Caddyfile |
| `test_files.py` | File upload, preview, WebDAV mount flow, folder visibility |
| `test_files_service.py` | File service unit tests |
| `test_material_catalog.py` | Material catalog operations |
| `test_notifications.py` | Notification creation, mark-read, dismiss, task-completion resolution, self-assignment guard |
| `test_optimistic_locking.py` | Conflict detection on concurrent edits |
| `test_planning.py` | Planning week view, task overdue flags |
| `test_project_import.py` | CSV project import |
| `test_projects.py` | Weather cache, address normalization |
| `test_reports.py` | Construction report CRUD |
| `test_system.py` | Rate limiter (429) |
| `test_time_tracking.py` | Clock in/out, timesheets, overnight shifts, vacations |
| `test_users.py` | Avatar upload, profile settings, nicknames |
| `test_webdav.py` | WebDAV project access, collections, protected folders |
| `test_wiki.py` | Wiki CRUD and permissions |

---

## Frontend — `apps/web/src/`

### State management

All application state lives in **`App.tsx`** and is shared via **`context/AppContext.tsx`**.
Pages and components read state through `useContext(AppContext)` — they hold no local state of their own.

Key state variables in `App.tsx`:
- `user: User | null` — authenticated user
- `token: string | null` — JWT (stored in localStorage as `smpl_token`)
- `mainView: MainView` — active page key (see table below)
- `sidebarOpen: boolean` / `setSidebarOpen` — mobile nav drawer; auto-closes on `setMainView`
- `projects: Project[]`, `tasks: Task[]`, `threads: Thread[]`, `messages: Message[]`
- `notifications: AppNotification[]`
- `planningWeek: PlanningWeek | null`, `planningWeekStart: string`
- `timeCurrent: TimeCurrent | null`

### Pages (`pages/`) — all lazy-loaded via `React.lazy()`

| File | `mainView` key | Description |
|------|---------------|-------------|
| `LoginPage.tsx` | *(no user)* | Login form |
| `OverviewPage.tsx` | `"overview"` | „Übersicht“, the personal start page: guard + `components/dashboard/DashboardHost` (docs/DASHBOARD.md) |
| `MaterialsPage.tsx` | `"materials"` | Office material demand tracking |
| `WerkstattPage.tsx` | `"werkstatt"` | Workshop / inventory dashboard (Paper 7DK-0); placeholder data until backend lands |
| `ProjectsAllPage.tsx` | `"projects_all"` | All active projects list |
| `ProjectsArchivePage.tsx` | `"projects_archive"` | Archived projects |
| `MyTasksPage.tsx` | `"my_tasks"` | Tasks assigned to current user |
| `OfficeTasksPage.tsx` | `"office_tasks"` | Office-mode task list |
| `ProjectPage.tsx` | `"project"` | Single project detail (tabs: overview, gantt, tasks, finance, …) |
| `CalendarPage.tsx` | `"calendar"` | Calendar-style task view |
| `PlanningPage.tsx` | `"planning"` | Weekly planning board |
| `ConstructionPage.tsx` | `"construction"` | Construction report entry |
| `WikiPage.tsx` | `"wiki"` | Internal wiki |
| `MessagesPage.tsx` | `"messages"` | Chat threads and messages |
| `TimePage.tsx` | `"time"` | Time tracking, timesheets |
| `ProfilePage.tsx` | `"profile"` | User profile and settings |
| `AdminPage.tsx` | `"admin"` | Admin panel (users, system updates) |

### Components (`components/`)

| Path | Purpose |
|------|---------|
| `layout/Sidebar.tsx` | Nav sidebar — off-canvas drawer on mobile (≤899 px), fixed at desktop; reads `sidebarOpen` from context; Escape key and overlay click close it; scroll-locks body when open |
| `layout/Header.tsx` | Top header bar — hamburger toggle (hidden ≥900 px), back buttons, page title |
| `modals/ProjectModal.tsx` | Create / edit project |
| `modals/TaskModal.tsx` | Create task |
| `modals/TaskEditModal.tsx` | Edit task |
| `modals/FileUploadModal.tsx` | Context-bound wrapper around `files/UploadFilesDialog.tsx` for the project tab |
| `modals/ThreadModal.tsx` | Create / edit chat thread |
| `modals/ArchivedThreadsModal.tsx` | Browse archived threads |
| `modals/AvatarModal.tsx` | Profile picture upload / crop |
| `NotificationPanel.tsx` | Notification dropdown panel |
| `AppErrorBoundary.tsx` | Top-level React error boundary |
| `pages/project/ProjectGanttTab.tsx` | Project-level Gantt timeline built from project tasks |
| `gauges/` | `WorkHoursGauge`, `ProjectHoursGauge`, `WeeklyHoursGauge`, `MonthlyHoursGauge` |
| `icons/` | `SidebarNavIcon`, `BellIcon`, `PenIcon`, `BackIcon`, `SearchIcon`, `CopyIcon` |
| `shared/ThreadIconBadge.tsx` | Thread avatar badge |

### Hooks (`hooks/`)

| File | Purpose |
|------|---------|
| `useServerEvents.ts` | Manages `EventSource` SSE connection (cookie in browsers, ticket in the iOS shell, own reconnects); returns `{ status: SseStatus }` |

### Utils (`utils/`)

| File | Purpose |
|------|---------|
| `auth.ts` | Token storage (`smpl_token` in localStorage), JWT validation |
| `dates.ts` | Date formatting, `startOfWeekISO()` |
| `finance.ts` | Currency formatting |
| `ics.ts` | iCalendar export helpers |
| `materials.ts` | Material unit helpers |
| `misc.ts` | General utilities |
| `names.ts` | User display name helpers |
| `projects.ts` | Project sorting/filtering |
| `reports.ts` | Construction report helpers |
| `tasks.ts` | Task sorting/filtering |
| `weather.ts` | Weather condition helpers |

---

## SSE event types

All events flow through `app/core/events.py` → `notify()` → pg_notify → asyncpg LISTEN → `EventSourceResponse`.

| Event type | Payload fields | Fired from |
|------------|---------------|------------|
| `task.created` | `id`, `project_id`, `title`, `status`, `assignee_ids` | `workflow_tasks.py` |
| `task.updated` | `id`, `project_id`, `title`, `status`, `assignee_ids` | `workflow_tasks.py` |
| `task.deleted` | `id`, `project_id` | `workflow_tasks.py` |
| `project.updated` | `id`, `title`, `status` | `workflow_projects.py` |
| `message.created` | `id`, `thread_id`, `sender_id`, `content` | `workflow_chat.py` |
| `thread.created` | `id`, `title` | `workflow_chat.py` |
| `thread.updated` | `id`, `title` | `workflow_chat.py` |
| `notification.created` | `user_id` | `workflow_tasks.py` |

Delivery filtering is in `core/events.py` `_should_deliver()`:
- `notification.created` → exact `user_id` match only (bypasses admin rule)
- `task.*`, `project.*`, etc. → user's project memberships
- `message.*`, `thread.*` → user's thread participation
- Admins (role: `admin` or `ceo`) → receive all non-notification events

---

## Alembic migrations

Files in `apps/api/alembic/versions/`. Naming: `YYYYMMDD_NNNN_description.py`.
Run migrations: `docker compose exec api alembic upgrade head`
Create new migration: `docker compose exec api alembic revision --autogenerate -m "description"`

Latest migration: `20260920_0088_werkstatt_article_lookup_and_merge.py`

---

## Werkstatt, Scan-Station, Schaltplan and task scheduling (2026-09 program)

> This section is current as of migration `0088`. The tables above it predate
> it and undercount the codebase — trust a `grep` over this file where the two
> disagree.

### Backend

| File | Handles |
|------|---------|
| `routers/workflow_station.py` | Station auth (`get_current_station`), `POST /station/heartbeat`, `/station/me`, the admin station list and revoke |
| `routers/workflow_station_pairing.py` | RFC 8628 device grant: `/station/pair/{start,pending,approve,deny,poll}`, code minting, flood control, one-time token issue |
| `routers/workflow_station_admin.py` | The Scan-Station page's actions: `/station/setup`, `PATCH /station/stations/{id}`, `…/refresh`, `…/test-print`, `…/restart`, `…/sessions`, `…/sessions/{name}/import` — all `system:manage` |
| `routers/workflow_station_werkstatt.py` | What a paired Pi may do: crates, resolve, crew, movements, box handover, article lookup and creation from catalogue or webshop |
| `routers/workflow_werkstatt_article_lookup.py` | `GET /werkstatt/articles/lookup` — own rows → wholesaler catalogue → public webshop |
| `routers/workflow_werkstatt_article_dedup.py` | `GET /werkstatt/articles/duplicates`, `…/duplicates/dismiss`, `POST /werkstatt/articles/merge` |
| `routers/workflow_werkstatt_order_send.py` | `GET /werkstatt/orders/{id}/resolution` and `…/export` — the pre-send gate and CSV/clipboard hand-over |
| `routers/workflow_werkstatt_ids_handoff.py` | The IDS hand-off and hook-result HTML pages (split out of `workflow_werkstatt_ids.py`) |
| `services/station_agent_client.py` | The ONLY api→Pi path: private-IP allowlist, fixed path allowlist, short timeouts, capped bodies, restart proof header |
| `services/station_heartbeat.py` | Folds a heartbeat (or a `/health` reply) onto the station row, including the self-reported LAN address |
| `services/station_sessions.py` | Lists a Pi's counting sessions and imports one into a Werkstatt inventory (SET semantics, so a re-import is idempotent) |
| `services/station_view.py` | Builds `StationOut`: online/stale/offline thresholds, hardware normalisation, batched lookups |
| `services/werkstatt_article_lookup.py` | The lookup cascade and its hit/miss cache |
| `services/ean_lookup/` | `base` (provider protocol), `http` (SSRF-guarded transport + budget), `cascade`, `unielektro_shop` (scraper), `open_ean_db` (configurable, empty by default) |
| `services/gtin.py` | GTIN checksum and UPC-A/EAN-13/EAN-8 variants — every DB lookup tries the variants, stored EANs are never rewritten |
| `services/werkstatt_order_lines.py` | `create_draft_order` + `build_order_line` — the ONE order-line builder (orders, needs and reorder all use it) |
| `services/werkstatt_order_export.py` | CSV and clipboard text for suppliers without a shop connection |
| `services/werkstatt_order_send.py` | Identifier policy (`supplier_no` / `ean` / …) decided once, shared by cart, export and preview |
| `services/material_needs.py` | `sync_needs_for_order` — the one place that maps an order event onto its linked needs |
| `services/task_material_settlement.py` | Settling a task's crate: correction + return, capped at what the crate holds, with the leftover disposition |
| `services/werkstatt_item_search.py` | The crate item search (pure move out of the boxes router) |
| `services/schaltplan_terminal_rules.py` / `schaltplan_terminals.py` | WAGO Reihenklemmen: part table with widths + sources, eligibility, derivation per FI group, BOM, strips — Python twin of the TS pair |
| `services/schaltplan_pdf_style.py` / `schaltplan_pdf_terminals.py` | Shared PDF primitives and the Reihenklemmen A4 sheet |

### Frontend

| File | Handles |
|------|---------|
| `utils/schaltplanTerminalRules.ts` / `schaltplanTerminals.ts` | TS twin of the Reihenklemmen derivation — pinned on the same fixtures as the Python side |
| `utils/werkstattArticleLookupApi.ts` / `werkstattDuplicatesApi.ts` | Article lookup, duplicates and merge clients |
| `utils/werkstattBedarfeApi.ts` | Bedarfe list, inline edit, bulk actions, order creation |
| `utils/taskCopy.ts` | Builds a create-modal state from a task or the live edit form |
| `utils/latestRequest.ts` | Request-sequence guard so a stale list response cannot overwrite a newer one |
| `utils/idempotentRetry.ts` | Report upload retry under one idempotency key |
| `components/tasks/MyTasksOverviewCard.tsx`, `TaskRowSummary.tsx` | The overview's task box and the shared row header |
| `components/tasks/MaterialRemainderDialog.tsx` | „Was ist mit dem Rest passiert?" at task completion |
| `components/werkstatt/NeueBestellungModal.tsx`, `ArtikelSuchfeld.tsx`, `BestellungPositionZeile.tsx`, `BestellungVersandLeiste.tsx` | Order creation, dual article/catalogue search, per-line readiness, send/export controls |
| `components/werkstatt/ArtikelFormFields.tsx`, `ArtikelCodeStep.tsx`, `ArtikelLookupResult.tsx`, `ArtikelBearbeitenModal.tsx` | The consumable create/edit dialogs and their code-first step |
| `components/werkstatt/DuplikateModal.tsx`, `ArtikelZusammenfuehrenModal.tsx` | Duplicate review and the irreversible-merge confirmation |
| `components/schaltplan/TerminalList.tsx`, `TerminalGroupCard.tsx`, `LabelPrintTerminals.tsx`, `StripSvg.tsx`, `useLabelPrinting.ts` | The „Klemmen" tab, its BOM, and label printing in terminal mode |
| `components/station/StationEditForm.tsx` | Name / location / manual agent address |
| `styles/*.css` | Page-local stylesheets (`tasks`, `orders`, `boxes`, `bedarfe`, `stock`, `schaltplan-terminals`, `pi-station`) — `styles.css` is no longer the only sheet |

## Files — customer and task scopes (2026-09, docs/FILE_SCOPES.md)

Every file used to hang off a project. `attachments` now carries one scope
anchor per row — `project_id`, `customer_id`, or `task_id` plus the task's
project/customer — and `customer_folders` mirrors `project_folders`. The
customer folder is the level above the project folder; the hierarchy is
virtual (nothing moved on disk). Migration `20260921_0089`.

### Backend

| Module | Role |
|---|---|
| `models/files.py` | `Attachment` (+ `customer_id`, `task_id`), `ProjectFolder`, `CustomerFolder` |
| `services/customer_files.py` | Customer-folder registration/defaults, visible paths, latest-file-by-path, `customers_visible_to_user` |
| `services/task_attachments.py` | Batched `attachment_count`, per-task rows, delete-with-task |
| `routers/workflow_helpers.py` | `_resolve_attachment_for_access`, `_assert_customer_files_access`, `_user_is_assigned_to_task` — the access rules |
| `routers/workflow_customer_files.py` / `workflow_task_files.py` / `workflow_webdav_customers.py` | The endpoints (see the router table) |

### Frontend

| Module | Role |
|---|---|
| `components/files/FileLightbox.tsx` (+ `lightboxTypes.ts`, `utils/filePreview.ts`, `styles/files.css`) | Click-through viewer: images, PDFs (framed or paged), text, download for the rest |
| `components/files/FileBrowser.tsx` (+ `FileBrowserFiles`, `FileRow`, `GalleryTile`, `FileViewToggle`, `folderGroups`, `useFileViewPrefs`, `useFileViewer`, `WebdavHelp`, `UploadFilesDialog`) | Scope-agnostic list/gallery browser shared by the project tab and the customer card |
| `pages/project/ProjectFilesTab.tsx` | The project tab, now `FileBrowser` + `FileLightbox` over the App context |
| `components/customers/CustomerFilesCard.tsx` (+ `CustomerProjectFolders.tsx`, `hooks/useCustomerFiles.ts`) | The customer folder on the customer page: project folders + customer folders |
| `components/tasks/TaskAttachments*.tsx`, `taskAttachmentsApi.ts`, `taskAttachmentsModel.ts` | The "Anhänge" section of both task modals, pending-upload mode for new tasks, paperclip badge |

## Project note feed, customer change log, QR command codes (2026-09-19)

| Module | Role |
|---|---|
| `apps/api/app/models/project.py` → `ProjectNote`, migration `20260922_0090` | The "Interne Notizen" feed: one row per posting with author and time; the old `description` note is backfilled as the first entry |
| `apps/api/app/routers/workflow_project_notes.py` | `GET/POST /projects/{id}/notes`, `DELETE …/{note_id}`; posts record `project.note_posted` |
| `apps/api/app/services/customer_activity.py` + `GET /customers/{id}/activity` | The customer's change log = the union of its visible projects' `project_activities`, keyset-paged |
| `apps/web/src/components/project/ProjectNotesCard.tsx` | The feed card on the project overview (replaced the inline note editor) |
| `apps/web/src/components/customers/CustomerActivityCard.tsx` | "Letzte Änderungen — alle Projekte dieses Kunden" on the customer page |
| `tools/label_agent/qrcode_svg.py` + `/qr.svg` | Stdlib-only QR encoder; the crate wall screen's command cards embed it instead of `/barcode.svg` |

## Projektbericht, task view, customer tabs (2026-09-19, round 3)

| Module | Role |
|---|---|
| `apps/api/app/services/project_report_data.py` / `project_report_pdf.py` | The Projektbericht: pure data collection (all sections, German labels) and the ReportLab rendering; no photos, no finance, no Verwaltung file names |
| `apps/api/app/routers/workflow_project_report.py` | `GET /projects/{id}/report[/preview|/preview-pages…]`, `POST …/report/finalize`; `finalize_project_report_on_status_change` runs from update_project when the status becomes abgeschlossen/archived (savepoint, never blocks the status change); migration `20260923_0091` |
| `apps/web/src/components/project/ProjectReportCard.tsx` | Overview card: live preview in the viewer (LightboxFile `source` override), finalized report link, manual finalize for managers |
| `apps/web/src/components/tasks/TaskAttachmentStrip.tsx` | Read-only "Anhänge" in the Meine-Aufgaben row; `TaskMaterialList` opens by default |
| `apps/web/src/components/customers/CustomerDetailTabs.tsx` (+ `CustomerOverviewPanel`, `CustomerProjectsCard`) | The customer page's five tabs; only the open tab's cards mount; tab remembered in sessionStorage |

## Reihenklemmen with X numbers (2026-09-23)

| Module | Role |
|---|---|
| `apps/api/app/services/schaltplan_terminal_rules.py` → `outgoing_parts_for_poles`, `rating_amps`, `is_block_device` | One Etagenklemme (2003-7641) for one phase, two (7641 + 7642) for three; three phases above 16 A = the 16 mm² Block; variants are `standard` / `no_rcd` only |
| `apps/api/app/services/schaltplan_terminals.py` | Every strip gets the next X in board order: a group's Leiste first (feed "X1", Etagenklemmen "1.1", "1.2" …, end clamp), then one Block per big outgoing ("N L1 L2 L3 PE", name + X rows); `document.terminal_labels` overrides any text by `override_key(device_id, slot)`; `terminal_strips` yields Leiste segments and Block cells; `device_terminal_labels` feeds the legend's "Klemmen" column |
| `apps/api/app/services/werkstatt_labels.py` → `_render_block_label`, `print_marking_strips(blocks=…)` | The PV-block blueprint (`PV Block.wssl`, 2009-110): one 60 mm piece, three rows, short cell marks in the bottom third |
| `apps/api/app/routers/workflow_schaltplan.py` → `_terminal_print_plan` | `strip_ids` instead of `group_ids`, no text modes; strips and blocks in one job |
| `apps/api/app/services/schaltplan_pdf_terminals.py`, `schaltplan_pdf.py` legend | Terminal sheet per strip (Pos. · Klemme · Beschriftung · für); the Stromkreisliste has a "Klemmen" column (X1.1, X1.2) |
| `apps/web/src/utils/schaltplanTerminals.ts` (+ rules twin), `components/schaltplan/LabelPrintDialog.tsx`, `TerminalGroupCard.tsx`, `LegendTable.tsx` | The TypeScript twin pinned on the same fixtures; the print sheet lists strips, previews Leisten and Blocks, and edits every marker text |

## Schrank-Etikett — the panel's type label (2026-09-23)

| Module | Role |
|---|---|
| `apps/api/app/services/schaltplan_type_label.py` | The owner's WAGO Smart Script blueprint (`Schrank Label.wssl`, template 2100804 = 210-804, 99 × 44) as EZPL: logo top-left, QR (`https://smpl-energy.de`) top-right as a downloaded bitmap, "Kunde / Projekt / Baujahr" block, centred contact lines (fixed branding constants); voll-tier stock only |
| `apps/api/app/routers/workflow_schaltplan.py` → `/panels/{id}/type-label` (GET info, POST print), `/type-label/logo.png`, `/type-label/qr.svg` | Prefill resolved server-side (customer row, project number, this month in Europe/Berlin), print with `build_month` + `copies`; preview images for the dialog |
| `apps/api/app/services/werkstatt_labels.py` → `logo_asset_for_box`, `mono_image_asset`, `image_download_preamble`, `place_image` | The logo/bitmap pipeline generalised for any box size and any number of assets per job (the machine label's `_logo_asset` box is 25 × 9,2 mm = 295 × 109 dots since the 300 dpi correction — a new bitmap under a new content-hashed name) |
| `apps/web/src/components/schaltplan/PanelTypeLabelDialog.tsx` (+ `useTypeLabelPrinting.ts`, `PanelTypeLabelPreview.tsx`) | "Schrank-Etikett" button in the panel toolbar: schematic preview (with a placeholder DataMatrix of the board's `VT-` number bottom-left since 2026-09-24), editable Baujahr, copies, stock warning |
| `apps/api/app/services/werkstatt_article_labels.py` | The stock article's shelf label (what `POST /werkstatt/articles/{id}/print-label` prints since 2026-09-23): DataMatrix of the SMPL code left, laid out for the 16 × 16 symbol an SMPL code needs, code text small under it; part number (the name's "… - …" head) as headline, description on two lines, `SP-xxxx · EAN …` small; no logo, no footer. `print_article_labels` batches in one connection; `preview_article_label_png` draws the sheet with a placeholder matrix |

## Verteiler-Nummer, Materialliste and Kommissionierung am Regal (2026-09-24)

| Module | Role |
|---|---|
| `apps/api/app/services/schaltplan_panel_numbers.py`; migration `20260926_0094` | `panel_plans.panel_number` = `VT-<id, 4 digits>` — the board's own number, minted in the row's transaction (a provisional value satisfies NOT NULL + UNIQUE until the id exists), never reused; `normalize_panel_code` accepts `vt-7` / `VT0007`; the type label prints it as a 12 × 12 DataMatrix bottom-left with the number beside it |
| `apps/api/app/services/schaltplan_material.py` | The Materialliste is DERIVED on every read (except the lines added by hand — see 2026-10-09 below): planned lines from the document (one `device:<kind>:<poles>p:<rating>` line per device type in catalog order, then `part:<WAGO id>` lines from the Reihenklemmen derivation), scanned quantities as sums over the ledger (`consumption` − `consumption_undo` rows carrying `werkstatt_movements.panel_id`), scanned articles nobody planned as `extra` lines. Articles per line: explicit global mapping (`schaltplan_material_articles`, keyed by the line key) first, else the WAGO part number at the head of an article's name (`split_item_name`) or its supplier number. `book_consumption` is not bounded by `stock_available` (the person holds the part) and returns a warning instead; `undo_consumption` is bounded by the net |
| `apps/api/app/services/werkstatt_movements.py` → `consumption`, `consumption_undo` | Two new ledger kinds (total ± qty, available ± qty) — not `correction` (nothing was checked out) and not `inventory_minus` (a stock-take must not mistake a built-in part for a counting difference); `apply_movement` takes `panel_id` |
| `apps/api/app/routers/workflow_schaltplan_material.py` (mounted BEFORE the plan router so `/panels/recent` is not swallowed by `/panels/{id}`) | `GET /schaltplan/panels/recent` (newest edit first, visible only), `GET /panels/{id}/material`, `POST …/material/book` and `…/unbook` (`reports:create`), `PUT /schaltplan/material/mapping` (global; `article_id: null` forgets), `GET /schaltplan/material/overview` (boards somebody scanned for first) |
| `apps/api/app/routers/workflow_station_werkstatt.py` → `/station/werkstatt/panels/{code}`, `…/panels/{id}/scan`, `…/panels/{id}/undo` | The Regal's picking flow: open a board by its scanned number, book one shelf scan against it (note `Regal-Station <name> — Verteiler VT-0007`, `station_id`, the board's `project_id`), take one back; each answer carries the whole list so the screen renders the server's sums. `/resolve` keeps answering `not_found` for `VT-` codes — the agent recognises the prefix like `KISTE-` |
| `apps/api/app/routers/workflow_projects.py` → `GET /projects/{id}/materials` | Report rows (unchanged) plus one `source: "verteiler"` row per article built into the project's boards, with `panel_numbers` |
| `tools/label_agent/scan_router.py`, `server.py`, `smpl_werkstatt.py`, `static/kiosk_rack.html` | Panel session on the Regal screen (mutually exclusive with a box session, same 600 s idle timeout): article scans book against the open board, FERTIG / the Fertig button closes it, ABBRUCH / Rückgängig undoes the last booking; the snapshot's `panel` object carries the lines and `last_line_key` for the highlight |
| `apps/web/src/components/schaltplan/PanelMaterialList.tsx` (+ `PanelMaterialRow.tsx`) | The shared list (2026-10-09: plus "Material hinzufügen" and "Als PDF", see below): planned / scanned per line, tick / "zu viel" / "nicht geplant", "Artikel zuordnen" search (global mapping), ±1 bookings; used by the Schaltplan "Material" tab and the Werkstatt "Verteiler" tab (`pages/werkstatt/WerkstattVerteilerPage.tsx`, overview with progress) |
| `apps/web/src/components/customers/CustomerCombobox.tsx` → `leadingItems`; `pages/SchaltplanPage.tsx` | The customer search box of the Schaltplan page lists the boards edited last ("Zuletzt bearbeitet", relative time) before anything is typed; picking one sets customer + project and opens it |
| `apps/web/src/pages/project/ProjectMaterialsTab.tsx` | "Quelle" column: Bericht / Verteiler VT-0007 |

## Feeding chains, Verteilerblock, Neozed block, manual material (2026-10-09)

Owner's list for the panel planner: SLS → FI, SLS → Hauptschalter → FI, a Hensel KKL 54 after the Hauptschalter, a Neozed straight onto the WAGO 2016 combo block, material added by hand plus the list as a PDF, and the legend's "Verbraucher / Bezeichnung" colliding with "Raum". Both twins (Python + TypeScript) change together; the shared terminal fixture pins them.

| Module | Role |
|---|---|
| `apps/api/app/services/schaltplan_layout.py` → `FEEDER_KINDS`, `_link_feeders`, `_closes_circle`, `_upstream_protection`; TS `utils/schaltplanTopologyCore.ts` (`isFeeder`, `closesCircle`) + `utils/schaltplanTopology.ts` | A group device's `parent_id` naming an SLS, Hauptschalter or Verteilerblock is its FEED: groups carry `fed_by` / `feeds` / `feed_cycle` (TS `fedBy` / `feeds` / `feedCycle`). A fuse named there stays the Vorsicherung (`pre_fuse`) as before. Circuits keep following physical order — no LS moves. A link that would close a circle is ignored and reported; one to something that cannot feed is reported ("Einspeisung nicht gefunden"). The legend's Vorsicherung walks `fed_by` to the first fuse or SLS ("Q0 SLS E35") |
| `DEVICE_CATALOG["distribution_block"]` (TS `utils/schaltplanDevices.ts`), symbol `distribution` (`DeviceSymbol.tsx`, PDF `_symbol`) | "Verteilerblock (Hensel KKL 54)", short `VB`, 4 TE, group device (opens a group like a Hauptschalter), not a circuit; one Materialliste line `device:distribution_block:4p:` |
| `components/schaltplan/PanelDiagram.tsx`, `services/schaltplan_pdf.py` | The link is drawn: plate "über Q1 HS" on a fed group's drop line, "speist F1, F2" in the feeder's box |
| `services/schaltplan_terminal_rules.py` (`TERMINAL_ELIGIBLE_KINDS` + fuse, `is_block_device`), TS `schaltplanTerminalRules.ts`; `DeviceInspector.tsx` toggle "Abgang direkt auf WAGO-2016-Block (ohne LS)"; `terminalOffered` (TS topology) + `setTerminalsEverywhere` (doc ops) — the inspector and the Klemmen tab's bulk switch share the rule | A flagged Neozed/NH outgoing ends on the 2016 combo block (7604 + 3× 7601 + 7607), always — no LS between. A fuse that feeds others (pre-fuse or `feeds_following`) never gets one. Fixture board `neozed_block` |
| `services/schaltplan_pdf.py` → `_LEGEND_COLUMNS`, `_legend_header_size`; `schaltplan_pdf_style.wrap` | Legend columns rebalanced (label 98 pt), headers shrink to fit (7 → 6.5 pt floor). `wrap` cuts EVERY word wider than its column (not only a first word: "UG Hauswirtschaftsraum" printed into "Gerät") and ends truncated text in "…" inside the column — the label/room collision |
| `validate_document` → `_strip_name_clashes`; TS `stripNameClashes` | Warn when a device's BMK equals a derived Klemmleiste's X label (case-blind; `terminal`/`blank` devices exempt) — X is the Verteilerblock's natural letter AND the strips' |
| `models/schaltplan.py` → `PanelMaterialManualLine`; migration `20261009_0099` (`panel_material_manual_lines`: panel CASCADE, article SET NULL) | The one STORED part of the Materialliste: a shelf article or a free text with quantity and note, per board, at most 200 (`MAX_MANUAL_LINES`). Deleted explicitly with the board (SQLite tests do not enforce FKs), copied by `duplicate`; an article merge (`werkstatt_article_dedup.merge_articles`) re-points these rows AND the global mappings (`panel_material_moved`) |
| `services/schaltplan_material.py` → `material_lines`, `allocate_scans`, `counts_toward_picking`, `line_for_article(undone=)` | Manual lines join after the derived ones (`manual:<id>`, `manual_id`, `note`, `detail` = note or "manuell"). Scans of one article FILL the lines that name it in list order, each up to its planned count; only the surplus lands on the last line ("zu viel") — before, the first line took every scan. A free text (no article) is listed but stays OUT of `planned_total` / `scanned_total` / `open_lines`, or a picked board reads "1 offen" forever (list, Werkstatt overview, Regal). The Regal's `line` = where the booking landed: last line holding any after a scan, first line no longer full after an undo |
| `routers/workflow_schaltplan_material.py` → `POST/PATCH/DELETE /schaltplan/panels/{id}/material/manual[/{line}]` (`reports:create`, like booking), `GET …/material/pdf` (read access) | Each write answers with the whole list. No article and no text → 422, quantity outside 1…9999 → 422, unknown article 404, archived 400; a line of another board 404 |
| `services/schaltplan_material_pdf.py` → `build_material_pdf` | A4 portrait: Pos., Bezeichnung (+ kind · detail, two lines), Lagerartikel, Soll, Entn., Status (coloured), header repeated per page, totals footer. Inline, `Materialliste_<VT>_<date>.pdf` |
| `components/schaltplan/PanelMaterialAddForm.tsx`, `PanelMaterialManualEditor.tsx`, `PanelArticleSearch.tsx` (`useArticleSearch`, shared with the mapping search), `manualQuantity.ts` | One field searches the shelf or takes free text; the form stays open after each line. Manual rows: "manuell" mark, note, Ändern (quantity + note) / Entfernen; never the global mapping (the server refuses manual keys). "Als PDF" is a cookie-authenticated link like "Plan als PDF" |

## Consumables at the Ausgabe, the rack's person → project picker, stock editing, supplier search (2026-10-10)

Owner: "'Waren Ausgabe' only works for tools never for consumables … when we scan it we book it out of the inventory and it is installed at a work site", then a project picker for the chosen person on the rack screen with QR navigation, an article dialog where stock can be changed, and search by supplier part number. Contract and analysis of that round: `WERKSTATT_CONTRACT.md` §3.1/§3.2 and `docs/PI_STATION.md`.

| Module | Role |
|---|---|
| `apps/api/app/services/werkstatt_consumption.py` | THE rule, shared by rack, desk and phone: a consumable (`is_serialized` false = everything outside the Maschinen tab) leaves stock as `consumption` with person + optional project; a short shelf is topped up first with `inventory_plus` + `stock_warning` (never a negative ledger); `consumption_undo` bounded per (article, project) bucket (`net_consumed`, `open_buckets`); `require_bookable_project` answers unknown and archived with ONE sentence |
| `routers/workflow_station_consumption.py`, `schemas/station_consumption.py`, `services/station_projects.py` → `GET /station/werkstatt/crew-projects`, `POST …/consumptions`, `POST …/consumptions/undo` | Station-auth only (in the auth sweep). crew-projects = the /crew people, ≤ 8 projects each, hints `heute`/`woche`/`zuletzt` from tasks (`_my_task_filter`, last + this week, Europe/Berlin), reports, movements and panel sessions of 14 days; projection `id, project_number, name, hint` only. Consumptions are idempotent on `client_request_id` (409 when the id belongs to another booking); the person is required (crew set), the project optional. Undo names the bucket (+ `undo_of_movement_id` reverses that consumption's short-shelf top-up once, `+t`/`+u` request ids) or `pick_project`: own bucket → own old loan (`return`, `services/werkstatt_loans.py`) → nameless inferred loan → anybody's bucket |
| `routers/workflow_werkstatt_mobile.py` + `services/werkstatt_dispense.py`, `schemas/werkstatt_dispense.py` | Desk "Entnehmen" and phone checkout: a consumable → the shared service (`booked_as: "consumption"`, `stock_warning`), a machine type → the loan as before |
| `services/project_stock_materials.py`; `GET /projects/{id}/materials` | Panel-less consumption of the project as `source: "lager"` rows (web: Quelle "Lager (Entnahme)") |
| `services/werkstatt_article_search.py`, `routers/workflow_werkstatt_articles.py` (`q`), `services/werkstatt_scan.py` step 8, `services/werkstatt_supplier_links.py` | Stock search is tokenized over name, SP, EAN, internal code, manufacturer, category, Lagerort and EVERY supplier link's number, plus a punctuation/case-blind identifier match; rows carry `matched_supplier_article_no`. The scan cascade tries the loose supplier spelling only after every exact step, and only for a unique hit. link-catalog writes the supplier link; numbers are stripped on write |
| `tools/label_agent/dispense_codes.py`, `rack_dispense.py`, `kept_requests.py` (an unanswered booking keeps its request id, so a re-scan replays instead of booking twice), `scan_router.py`, `smpl_werkstatt.py`, `server.py`, `static/kiosk_rack.html` | Rack: Ausgabe with nobody named shows a person grid (QR `SMPL-CMD-PERSON-<id>` per tile), then that person's project tiles (`SMPL-CMD-PROJEKT-<id>`, `SMPL-CMD-OHNE-PROJEKT`), then "Ausgabe für <Name> · <Projekt>". Consumable → consumption, tool → loan, Rückgabe of a consumable → `consumption_undo` (bucket), ABBRUCH undoes the exact bucket, FERTIG ("Ausgabe fertig") clears name + project. Codes only use 0-9, A-X, `-` (≤ 26 chars) and never reach /resolve; a person must be in the cached crew, a project must be one offered. Badge semantics unchanged |
| `apps/web/src/components/werkstatt/KebabMenu.tsx` (portal), `StockTableRow.tsx`, `ArtikelBestandAbschnitt.tsx`, `ArtikelLieferantenAbschnitt.tsx`, `useStockArticleList.ts`, `dispense.ts`, `EntnehmenModal.tsx` | Stock page: the row menu renders in a portal (it was clipped by the cell's overflow), visible "Bestand" / "Bearbeiten" buttons, the edit dialog books counts (inventory with `expected_total`, reason required) and deliveries and edits supplier links; the server is the only text filter (request-sequence guarded); a new article is shown and opened after create. Entnehmen of a consumable = "Material entnehmen" → consumption |

## Vacation over New Year, admin centre on phones (2026-10-10)

| Module | Role |
|---|---|
| `apps/api/app/services/vacation_years.py`; `routers/time_tracking.py` (`_check_vacation_approval`, `_ensure_vacation_balance_year`); migration `20261010_0100` (`vacation_requests.pending_future_days`) | Approval splits a request by calendar year: days in the balance year (or earlier) are checked and deducted now (carryover first); days in a later year are checked against that year's budget (next year: `per_year` + this year's AVAILABLE left after the deduction − other approved plans; carryover left at year end expires, as the rollover does) and kept as `pending_future_days`. The lazy rollover charges each year's planned days when that year begins (one year at a time, never below 0, recorded as deducted). Rejection and single-day removal (`vacation_day_removal.py`) handle planned days; refusals are German and name the year. `vacation_days_planned_next_year` on `/time/current` → TimePage "Vorgemerkt <Jahr>" |
| `apps/web/src/components/admin/AdminTabBar.tsx` + `adminTabStrip.ts`; `styles/admin-mobile.css`; `pages/AdminPage.tsx` | The page root clips horizontal overflow (`overflow-x: clip`), so every wide admin element lives in its own scroll container or reflows: the tab bar is a sideways-scrolling, snap-aware WAI-ARIA tab list that reveals the active tab; Rollen scrolls in `.admin-roles-table-wrap` with a sticky permission column and header; Protokoll and Backups rows become labelled cards; user cards label every number; forms single-column with 44 px controls and 16 px text (no iOS zoom). Scoped to `.admin-center`; desktop unchanged |

## No bearer secrets in request logs (2026-10-11)

| Module | Role |
|---|---|
| `apps/api/app/routers/events.py`; `services/event_stream_tickets.py`; `schemas/events.py` | `GET /events` authenticates from a `?ticket=` (single use, 60 s, hashed in `user_action_tokens` purpose `event_stream`, minted by `POST /events/ticket`), else the session cookie; `?token=` is not read (removed 2026-10-11) |
| `apps/web/src/hooks/useServerEvents.ts` | Browser: bare `/api/events` on the cookie, ticket when the cookie fails to open it; iOS shell: always a ticket. Reconnects itself (a ticket is spent; a non-200 closes an EventSource for good) |
| `apps/api/app/core/log_redaction.py`; `apps/web/Caddyfile` snippet `(log_redaction)` | One regexp, kept identical in both (a test checks): `?token=`/`?ticket=` values, `/confirm/…`, customer-confirmation, IDS hand-over and calendar-feed tokens, in the URI and the Referer; Caddy also replaces `X-Access-Token` / `X-Mfa-Challenge`. docs/LOG_HYGIENE.md |

## Personal start page — Startseite (2026-10-21, docs/DASHBOARD.md)

The overview became a dashboard each user arranges per device class (Handy < 768 px ≤ Tablet < 1280 px ≤ Desktop). `docs/DASHBOARD.md` is the contract (catalog, sizes, storage, API, copy). No migration: user layouts live in `users.preferences["dashboard_layouts"][device]`, role defaults in 15 `app_settings` rows `dashboard_default:{role}:{device}`.

| Module | Role |
|---|---|
| `apps/api/app/services/dashboard_catalog.py` | The 20 widgets (`CATALOG`, §1 order), `requires` as an AND of OR-groups, `SHORTCUT_VIEWS` (14, no `materials`), `available_ids_for_user` / `_for_role`, `default_sizes` |
| `services/dashboard_defaults.py` | Built-in layouts per role × device (§5) and the four shortcut presets; an unknown role falls back to employee |
| `services/dashboard_layouts.py` | Write rules 2–5 (`DashboardLayoutError` → 422 `{code, message, ids}`), tolerant `parse_stored`, `merge_hidden` (a widget the user may not see keeps its place through saves), resolution user → role → builtin with `role_changed`, storage. Every write takes `db.refresh(user, with_for_update=True)` and replaces the JSON dict, never edits it in place (verified on Postgres 16) |
| `services/dashboard_absences.py`; `GET /dashboard/absent-today` | Who is absent today, from the planning board's helper, 403 before reading, one row per user with a generic label (`absent` hides sick, accident and free-text reasons) |
| `schemas/dashboard.py`, `routers/dashboard.py` | The 7 routes; role-default writes are audited (`dashboard.role_default.update` / `.reset`, target `dashboard_default`) |
| `schemas/user.py` → `HIDDEN_PREFERENCE_KEYS` | `UserOut.preferences` never shows `dashboard_layouts`; the generic preference PATCH ignores and keeps it |
| `routers/workflow_werkstatt_desktop.py` → `GET /werkstatt/dashboard?preview_limit=1…10` | One shared request for the three Werkstatt widgets; without the parameter each preview keeps its old cap |
| `core/permissions.py` | ceo, accountant and planning also hold `time:clock` and `time:view_own` (owner, 2026-10-21). `ROLE_PERMISSION_UPGRADES`: what a revision added to role defaults, granted by `services/permission_store` to stored lists older than it — on every read, written back once by the startup load; every save stamps the map (`_revision`, not the store's `permissions_revision` token) |
| `apps/web/src/types/dashboard.ts`, `utils/dashboardApi.ts` | Types and id lists (a pytest keeps them equal to the catalog); every `/api/dashboard*` call, responses normalised (no `settings: null`) |
| `utils/dashboardResourceStore.ts`, `hooks/useDashboardResource.ts`, `components/dashboard/dashboardPolling.ts` | Module-level store per user: one request and one visible-only poller per key, cached data between visits, 403 sticky; keys like `time:current`, `werkstatt:dashboard`. `reload` settles when the new answer is in; `reloadDashboardResources` refetches cached keys after a change elsewhere (App's `refreshTimeData` → `time:*`) |
| `utils/dashboardSession.ts`, `hooks/useDashboardSessionEnd.ts` | `endDashboardSession()` clears widget data, layouts, drafts and the Schaltplan handoff; App runs it through `useDashboardSessionEnd(token)`, in an effect once the token is gone — never next to `setToken(null)`, or a render with the old token refills the caches |
| `hooks/useDashboardLayouts.ts`, `hooks/useDashboardDevice.ts`, `utils/dashboardLayout.ts`, `utils/dashboardDrafts.ts` | Layout cache seeded from `localStorage["smpl_dashboard_layouts:{userId}"]` (ids, sizes, settings only), revalidated by `GET /api/dashboard`; device from two width queries, debounced 200 ms; pure layout operations; unsaved edit drafts in memory |
| `components/dashboard/DashboardHost.tsx`, `DashboardGrid.tsx`, `DashboardWidgetFrame.tsx`, `DashboardWidgetBoundary.tsx`, `DashboardLoadBoundary.tsx`, `retryableLazy.ts`, `widgetRegistry.ts`, `widgetMeta.ts`, `widgetTypes.ts` | Live mode: grid columns from the device (1/2/3), lazy widget per id inside its own error boundary, card chrome (skeleton, error, „Nicht aktuell“, „Keine Berechtigung.“, empty, „+n weitere“), notices (role change, restored draft, saved for another device) |
| `components/dashboard/DashboardEditMode.tsx`, `DashboardEditor.tsx`, `DashboardAddDialog.tsx` | Edit mode, lazy on „Anpassen“: placeholder tiles, `@dnd-kit` (only in this chunk), move buttons, sizes, „Kacheln wählen“, sticky toolbar, frozen device; reused by the admin panel |
| `components/dashboard/widgets/{personal,planning,werkstatt,office,shortcuts}/` | One folder and CSS file per group, `index.ts` exports loaders only. Widget CSS sizes with `@container dashboard-widget`, never viewport `@media` (a test checks) |
| `utils/dashboardTimeApi.ts`, `utils/dashboardPlanning.ts` | Time calls of „Mein Status“ / „Urlaub“; „Mein Einsatz“ filters the context tasks to the user's own |
| `hooks/useDashboardNavigation.ts`, `utils/schaltplanHandoff.ts`, `hooks/usePendingPanelHandoff.ts` | Widget links follow `navViews` and the mode (`my_tasks` → `office_tasks` in Büro); a Verteiler row opens its panel on SchaltplanPage (30 s handoff, StrictMode-safe) |
| `components/admin/AdminDashboardDefaultsPanel.tsx`; AdminPage tab `dashboards` „Startseiten“ | Role defaults per role and device in a fixed-width preview frame (390/820/1280 px) |
| `utils/userUpdate.ts` → `mergeUserUpdate` | Every `setUser(updated)` from a `/auth/me*` answer keeps the permissions an older answer shape lacks |
| `styles/dashboard.css` | Page, grid, frame, editor, sticky toolbar; hides `.mobile-bottom-nav` while editing |

Tests: `apps/api/tests/test_dashboard_*.py`, `test_auth_me_responses.py`, `test_permissions_role_upgrade.py`, `test_werkstatt_dashboard_preview_limit.py`; web `src/test/dashboard*.test.ts(x)`, `adminDashboardDefaults.test.tsx`, `schaltplanHandoff.test.ts`, `userUpdate.test.ts`, `twoFactorDisableMerge.test.tsx`.

## Verteiler round 4 — §14a-Klemmleiste, Zählerschrank-Vorbereitung, Modulsuche, Stromlaufplan allpolig (2026-10-26)

Contracts: `docs/PANEL_ENCLOSURE_R4.md`, `docs/SCHALTPLAN_STROMLAUF.md`. Python ⇄ TS twins are pinned by `apps/web/src/test/fixtures/enclosureFixtures.json` (`scripts/write_enclosure_fixtures.py`).

| Module | Role |
|---|---|
| `services/cable_section_parse.py` ⇄ `utils/cableSectionParse.ts` | Cross-section, cores, aluminium and fuse amps from free text ("NYY-J 5x16 mm²", "NH 63 A") |
| `services/panel_enclosure_control_block.py` ⇄ `utils/enclosureControlBlock.ts` | The stored §14a block (`enclosure.control_block`), its carrier (first in-use meter field) and its placement on an AAR rail |
| `services/panel_enclosure_prep.py`, `panel_enclosure_prep_rules.py` ⇄ `utils/enclosurePrep.ts`, `enclosurePrepRules.ts` | Derived cabinet preparation (supply kit, infeed, ZZ55SAVE joints, network lead, block parts, wires, Lüsterklemme, PEN split), runs, per-board overrides (`enclosure.prep`), the round-4 findings |
| `services/panel_enclosure_prep_material.py` | Materialliste lines of the preparation (`accessory:`/`part:`/`wire:`/`prep:` keys) |
| `services/panel_enclosure_pdf_control.py` | The Aufbau PDF's §14a page |
| `services/werkstatt_label_frame.py`, `werkstatt_label_strips.py`, `werkstatt_label_control_strip.py`; `routers/workflow_schaltplan_labels.py` | Label frame and strip renderers split out of `werkstatt_labels.py`; the vertical §14a strip and the Aderbeschriftung (target `adern`); the print route moved out of `workflow_schaltplan.py` |
| `services/schaltplan_pdf_overview.py`, `schaltplan_conductors.py`, `schaltplan_stromlauf_*.py` | The Übersicht (moved and paginated), conductors per device/cable/supply, the Stromlaufplan allpolig: model, layout (bands, cabinet sheet, control band, routes), renderer and symbols |
| `components/schaltplan/enclosure/modulePickerSearch.ts` | The module picker's search |
| `utils/enclosureOpsControlBlock.ts`, `enclosure/ControlBlockSheet.tsx`, `ControlBlockSvg.tsx`, `controlBlockLayout.ts`, `EnclosurePrepList.tsx`, `prepListModel.ts`, `components/schaltplan/usePanelControlBlock.ts` | The §14a sheet and its ops, "Automatisch ergänzt", the page wiring (Klemmen print ids, wire print, Daten hint) |
| `utils/schaltplanControlStrip.ts`, `components/schaltplan/LabelPrintDialogWires.tsx` | Web side of the §14a strip and the Aderbeschriftung print mode |
| `services/panel_enclosure_busbar_meters.py` ⇄ `utils/enclosureBusbarMeters.ts` | Review 2: the meter(s) feeding a customer busbar — busbars of different meters are never joined |
| `utils/edgeTrim.ts` (⇄ `panel_enclosure_layout.text`) | Review 2: one explicit edge-trim set for user text in both twins |
| `components/schaltplan/enclosure/EnclosureRuns.tsx`, `enclosureRunLabels.ts` | Review 2: the leads in the 2D drawing (lines under the box labels, labels placed off them and inside the drawing) |

## Label printer calibration and IR sensor guide (2026-10-13)

Contract: `docs/LABEL_PRINTER_CALIBRATION.md` (data model, EZPL allow-list, endpoints, German strings, physical test plan T0–T17). Built against a simulated printer; nothing is "verified" until the physical tests.

| Module | Role |
|---|---|
| `services/werkstatt_label_builtins.py`, `werkstatt_label_profile.py`, `werkstatt_label_materials.py` | Material profiles: code defaults per WAGO item (sensor mode, `sensor_scale` 3.4 labels / 3.0 strip+tube, roller 258-5006, web geometry incl. 210-805 two lanes), only admin overrides stored (format 2, read-time migration), revision compare-and-set |
| `services/werkstatt_label_ezpl_policy.py` | Allow-list and never-send list (`~V` prints, `~X*`, `~Z`, `^Z`, `~R`, unlisted `^XSET`) — every calibration send passes `assert_allowed` |
| `services/werkstatt_label_transport.py`, `werkstatt_label_io_lock.py` | Queries are an Enum (`~S,STATUS`, `^XGET,CONFIG`); a reply ends on its own terminator; one printer connection at a time |
| `services/werkstatt_label_address.py` | Address policy (SSRF): admin-entered port 9100–9109, no loopback/link-local/metadata/compose names/numeric spellings; `open_checked` resolves once and dials the checked IP |
| `services/werkstatt_label_printer_status.py` | Parses `^XGET,CONFIG` (sensor line, `^QD` measurement, stored `^Q ^W ^E ^H ^S ~Q`); a reply without this printer's setup lines is neither parsed nor shown raw |
| `services/werkstatt_label_calibration.py`, `werkstatt_label_session.py`, `werkstatt_label_verdict.py`, `werkstatt_label_patterns.py`, `werkstatt_label_jobs.py` | Apply (no `^E`), auto-sense `~S,SENSOR` with a freshness proof, verdict rules, measuring pattern, DB session lock with TTL (every print path answers 409 meanwhile), per-job baseline `^H ^S ^E ^C` |
| `routers/werkstatt_label_printer.py`, `routers/admin_label_printer.py` | Quick flow `werkstatt:manage` (released per printer by an admin switch), wizard + profiles `settings:manage`; the blobs need `app_settings.value` as TEXT, which migration `20261022_0105` made it (no migration of their own) |
| `apps/web/src/components/labelPrinter/*` | `MaterialChangeSheet` (quick flow), `CalibrationWizard`, `ConfirmFeedDialog` (cost + stop hint), `VerdictCard`, `LabelSensorDiagram` (printed scale 1–5, ▲▼ pointer, Ziel/Ist), `LabelPathSideView`; ALL diagram geometry in `sensorGeometry.ts` (from the owner's photo 2026-10-13) |
| `apps/web/src/components/admin/AdminLabelPrinterCard.tsx`, `pages/werkstatt/WerkstattMaschinenPage.tsx` | Admin card: address, staff switch, material rows with chips; Maschinen page: "Etikettendrucker" quick entry |
| `werkstatt_label_profile.mm_to_dots` / `printer_mm` / `printer_width_mm` / `q_value`; web `utils/printerDots.ts` | The scale (contract §4.12, after T4): every renderer lays out in physical dots, 300 dpi = 11,81 per mm, rounded once (`mm_to_dots`); `^Q`/`^W` go out in the printer's own millimetre (dots / 12, `printer_mm`), a die-cut length and `^W` rounded up so the form never ends before the label: 210-804 is `^Q98,3 ^W44`. Font sizes, code modules and line weights stay dots. `tests/test_label_physical_scale.py` (ruler 945 dots, no strip drift, printer-mm headers, no builtin die-cut job past its form, no `12` in rendering modules); `stripParityFixtures.json` holds API and editor preview to the same strip numbers |

## Zugangsdaten and Kalender-Abo (2026-09-24)

| Module | Role |
|---|---|
| `apps/api/app/models/customer.py` → `CustomerCredential`; migration `20260927_0095` | The installation's logins (Wechselrichter, Wallbox, Speicher, Wärmepumpe, Router, Portal, Sonstiges) kept with the customer: label, username, URL, notes in clear; the secret Fernet-encrypted through `services/secret_box` (the wholesaler-password box); `last_revealed_at/by` on the row |
| `apps/api/app/routers/workflow_customer_credentials.py`, `services/customer_credentials.py` | `GET/POST /customers/{id}/credentials`, `PATCH/DELETE …/{cid}`, `POST …/{cid}/reveal`. Access = who may open the customer's files (the notes/visits rule); delete = creator or `projects:manage`. The secret is never in a list; the reveal call returns it once and writes the customer's change log (`customer.credential_revealed`) AND the admin audit log (`customer_credential.reveal`, category `customer`). `secret` absent keeps, `""` clears, text replaces |
| `apps/web/src/components/customers/CustomerCredentialsCard.tsx` (+ Row/Form), tab "Zugangsdaten" | Masked entries, copy buttons, "Anzeigen" shows the password for 30 s, inline add/edit, category chips |
| `apps/api/app/models/calendar.py` → `CalendarFeed`; `services/calendar_feed.py`; `routers/calendar_feed.py` | One subscription per user: token `smpl_cal_…` stored hashed (lookup) AND encrypted (re-display on the profile page); `POST /calendar/feed` creates or ROTATES, `DELETE` removes, `GET /calendar/{token}/feed.ics` is what the phone fetches without a login (404 for unknown/rotated/deleted tokens and deactivated users; the fetch is remembered once a minute with the User-Agent). The feed is rebuilt per fetch: the user's assigned tasks 60 days back / 400 ahead (stable UID `smpl-task-<id>@<host>`, `SEQUENCE` from `updated_at`, timed with `TZID=Europe/Berlin` + a static VTIMEZONE, multi-day timed as `RRULE:FREQ=DAILY;COUNT=n`, all-day otherwise, done ones "✓ "), approved vacation ("Urlaub") and Berufsschule (weekly RRULE). Own RFC 5545 folding/escaping — no `icalendar` dependency |
| `apps/web/src/components/profile/CalendarFeedSection.tsx`, `utils/calendarFeedApi.ts` | "Kalender-Abo" card on the profile page: webcal link, copy, last fetch (friendly agent name), rotate, remove, how-tos for iPhone/Google/Outlook |

## Follow-ups after the first day of use (2026-09-24, afternoon)

| Module | Role |
|---|---|
| `apps/api/app/services/schaltplan_material.py` → `device_line_key` | The residual current and the RCD type join the line key when they are set (`device:rcd:4p:40a:30ma:typa`), so a 30 mA and a 300 mA FI are two lines with two articles; a device without them keeps the old key and its mapping |
| `apps/api/app/services/schaltplan_pdf.py` | Pole count on every breaker: the EN 60617 stroke-and-count mark on the symbol, "B16 · 3P" beside the rating, "LS · 3P" in the legend (`build_legend` rows carry `poles`); `_BAND_DY` 190 → 212 so the lower busbar's caption clears the deepest circuit text of the upper band; `_paginate_groups` sends a group too wide for band 1 (which shares the sheet with the Schriftfeld) to a new sheet instead of under the title block |
| `apps/api/app/services/werkstatt_box_labels.py` | The crate sticker's own layout (it used to borrow the machine label, whose matrix anchor and headline are sized for "M-0062"): `datamatrix_symbol_modules` sizes the symbol from the code's ASCII codewords (KISTE-BK-2026-0001 = 14 → 18 × 18), code small under the matrix, crate number as headline fitted left of the logo box, name on one or two lines, "Baustellenkiste" at the foot; `preview_box_label_png` for a look before printing |

## Datanorm import at catalog size (2026-09-22)

| Module | Role |
|---|---|
| `apps/api/app/services/werkstatt_datanorm_preview_store.py` | The preview between "Vorschau analysieren" and "Import starten" lives on disk (`DATANORM_PREVIEW_DIR`, default a folder in the temp dir): `<token>.json` + `<token>.rows.jsonl`; shared by every uvicorn worker, swept by age after 15 min, claimed by rename so a token commits once |
| `apps/api/app/services/werkstatt_datanorm_import.py` | `create_preview` parses the upload once, streaming rows to the JSONL and keeping only counters, samples and the EAN set (classification against fingerprints of the supplier's current rows, EAN conflicts in slices); `commit_preview` streams the rows into `material_catalog_items` in batches of 1000, keeps looked-up images across a replace |
| `apps/api/app/routers/workflow_werkstatt_datanorm.py` | Upload streamed to disk a megabyte at a time (cap 150 MiB, refused mid-stream), parsed off the event loop; a wholesaler's full file (Brisch: 68 MB, 291k articles) analyses in ~13 s and commits in ~10 s |

## Customers like projects (2026-09-20)

| Module | Role |
|---|---|
| `apps/api/app/models/customer.py` → `customer_type`, `mobile`, `CustomerNote`, `CustomerVisit`, `CustomerActivity`; migrations `20260924_0092`, `20260925_0093` | Firm vs person, second phone, the note feed (old `notes` backfilled as the first entry), the Kundenbesuch feed (0093 moved the single write-up of 0092 into `customer_visits` and dropped the columns), customer-level events |
| `apps/api/app/routers/workflow_customer_visits.py`, `services/customer_visits.py` | `GET/POST /customers/{id}/visits`, `PATCH/DELETE …/visits/{visit_id}`; an entry may name one of the customer's projects; logs on the project when linked (`project.visit_*`), on the customer when not (`customer.visit_*`); `report_visits` = the entries a project's Projektbericht opens with (linked to it + unlinked, date order); `POST /customers` takes a nested `visit` for the first one |
| `apps/api/app/routers/workflow_customer_notes.py` | `GET/POST/DELETE /customers/{id}/notes` |
| `apps/api/app/services/customer_activity.py` | `record_customer_activity`; the change log unions customer events with the project logs behind an opaque `cursor` |
| `apps/api/app/routers/workflow_tasks.py` → `_task_rows_out`, `_record_task_activity` | `TaskOut.customer_name/customer_address` on every list; customer-only tasks log to the customer, project tasks to the project |
| `apps/web/src/components/customers/CustomerNotesCard.tsx`, `CustomerVisitCard.tsx`, `CustomerTypeBadge.tsx`, `modals/CustomerModal.tsx` (+ `customerModalDraft.ts`) | The customer page's note feed, the Kundenbesuche feed (date, project picker, summary; edit/delete by the visitor or a manager), type badge and the Firma/Privatperson form with Telefon + Mobil (the first visit only on create) |
| `apps/web/src/utils/tasks.ts` → `buildTaskAnchorPayload`, `taskCalendarAnchor`, `taskCustomerName` | One anchor (project or customer) per task, used by the create modal, the calendar export and every list's "Kunde: …" label |

