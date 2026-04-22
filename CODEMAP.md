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
| `workflow_files.py` | File upload, download, preview, folders |
| `workflow_materials.py` | Material catalog, project material needs |
| `workflow_notifications.py` | `GET /notifications`, `PATCH /notifications/read-all`, `PATCH /notifications/{id}/read` |
| `workflow_reports.py` | Construction reports |
| `workflow_sites.py` | Sites, job tickets |
| `workflow_wiki.py` | Wiki pages, library files |
| `workflow_webdav.py` | WebDAV file mounting |
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
| `test_notifications.py` | Notification creation, mark-read, self-assignment guard |
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
| `modals/FileUploadModal.tsx` | File drag-and-drop upload |
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

Latest migration: `20260320_0044_user_vacation_balance_year.py`
