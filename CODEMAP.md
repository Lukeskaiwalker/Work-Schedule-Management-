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
| `auth.py` | Login, logout, `/auth/me`, invite accept, password reset |
| `admin.py` | User management, runtime settings (weather, SMTP, company branding), system update center |
| `time_tracking.py` | Clock in/out, break tracking, timesheets, vacations, school absences |
| `events.py` | `GET /events?token=` — SSE live-update stream |
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
| `test_events.py` | SSE endpoint auth and stream handshake |
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
| `OverviewPage.tsx` | `"overview"` | Dashboard / project overview |
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
| `useServerEvents.ts` | Manages `EventSource` SSE connection; returns `{ status: SseStatus }` |

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

## Schrank-Etikett — the panel's type label (2026-09-23)

| Module | Role |
|---|---|
| `apps/api/app/services/schaltplan_type_label.py` | The owner's WAGO Smart Script blueprint (`Schrank Label.wssl`, template 2100804 = 210-804, 99 × 44) as EZPL: logo top-left, QR (`https://smpl-energy.de`) top-right as a downloaded bitmap, "Kunde / Projekt / Baujahr" block, centred contact lines (fixed branding constants); voll-tier stock only |
| `apps/api/app/routers/workflow_schaltplan.py` → `/panels/{id}/type-label` (GET info, POST print), `/type-label/logo.png`, `/type-label/qr.svg` | Prefill resolved server-side (customer row, project number, this month in Europe/Berlin), print with `build_month` + `copies`; preview images for the dialog |
| `apps/api/app/services/werkstatt_labels.py` → `logo_asset_for_box`, `mono_image_asset`, `image_download_preamble`, `place_image` | The logo/bitmap pipeline generalised for any box size and any number of assets per job (the machine label's `_logo_asset` is unchanged bit-for-bit) |
| `apps/web/src/components/schaltplan/PanelTypeLabelDialog.tsx` (+ `useTypeLabelPrinting.ts`) | "Schrank-Etikett" button in the panel toolbar: schematic preview, editable Baujahr, copies, stock warning |

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

