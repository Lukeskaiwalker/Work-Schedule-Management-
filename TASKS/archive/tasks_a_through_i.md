# Archive — Tasks A through I (all complete)

> These tasks are complete and committed. Kept for reference only.

---

## Task A — Context infrastructure
**Status:** ✅ Complete
`context/AppContext.tsx` created; `AppContext.Provider` wraps the full app shell; all state and setters exposed through the context value object.

---

## Task B — Types and constants extracted
**Status:** ✅ Complete
`types/index.ts` — all TypeScript `type` / `interface` declarations moved out of App.tsx.
`constants/index.ts` — all top-level `const` objects (MAIN_LABELS, EMPTY_PROJECT_FORM, etc.) moved out.

---

## Task C — Utility helpers extracted
**Status:** ✅ Complete
`utils/dates.ts`, `utils/names.ts`, `utils/tasks.ts`, `utils/materials.ts`, `utils/projects.ts`, `utils/reports.ts`, `utils/finance.ts`, `utils/weather.ts`, `utils/auth.ts`, `utils/ics.ts`, `utils/misc.ts` — all pure functions extracted from App.tsx into domain-specific utility files.

---

## Task D — Presentational components extracted
**Status:** ✅ Complete
`components/icons/` — SidebarNavIcon, PenIcon, BackIcon, SearchIcon, CopyIcon.
`components/gauges/` — WorkHoursGauge, ProjectHoursGauge, WeeklyHoursGauge, MonthlyHoursGauge.
`components/shared/` — AvatarBadge, ThreadIconBadge.

---

## Task E — Layout components extracted
**Status:** ✅ Complete
`components/layout/Sidebar.tsx` — full `<aside className="sidebar">` block.
`components/layout/Header.tsx` — full `<header className="workspace-header">` block.

---

## Task F — Modals extracted
**Status:** ✅ Complete
`components/modals/ProjectModal.tsx`, `TaskModal.tsx`, `TaskEditModal.tsx`, `FileUploadModal.tsx`, `ThreadModal.tsx`, `ArchivedThreadsModal.tsx`.

---

## Task G — Simple pages extracted
**Status:** ✅ Complete
`pages/LoginPage.tsx`, `ProjectsArchivePage.tsx`, `ProjectsAllPage.tsx`, `MyTasksPage.tsx`, `OfficeTasksPage.tsx`, `WikiPage.tsx`, `CalendarPage.tsx`, `MaterialsPage.tsx`, `OverviewPage.tsx`, `PlanningPage.tsx`.

---

## Task H — Project sub-tabs + ProjectPage extracted
**Status:** ✅ Complete
`pages/project/` — ProjectOverviewTab, ProjectTasksTab, ProjectHoursTab, ProjectMaterialsTab, ProjectTicketsTab, ProjectFilesTab, ProjectFinancesTab.
`pages/ProjectPage.tsx` — minimal tab-switching shell.

---

## Task I — Code splitting / lazy loading
**Status:** ✅ Complete
Commit: `perf: lazy-load all page components for smaller initial JS bundle`

All 16 page imports in `App.tsx` converted from static to `React.lazy()`. Each page is now a separate Vite chunk loaded on first navigation. Suspense fallback added. Loading spinner CSS added to `styles.css`. Vite config updated with readable chunk names.

Files changed: `apps/web/src/App.tsx`, `apps/web/src/styles.css`, `apps/web/vite.config.ts`.

---

## Task — Large pages extracted (ConstructionPage, TimePage, MessagesPage, ProfilePage, AdminPage)
**Status:** ✅ Complete

- `pages/ConstructionPage.tsx` — construction report entry, uses `React.forwardRef` for `constructionFormRef`
- `pages/TimePage.tsx` — time tracking, timesheets, clock in/out
- `pages/MessagesPage.tsx` — chat threads and messages
- `pages/ProfilePage.tsx` — user profile, avatar crop modal
- `pages/AdminPage.tsx` — admin panel; `renderAdminUpdateMenu` extracted as local helper
- `components/modals/AvatarModal.tsx` — avatar crop modal extracted from ProfilePage
- `components/shared/AdminUpdateMenu.tsx` — admin update menu extracted
