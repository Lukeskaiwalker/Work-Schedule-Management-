# Agent Task File — SMPL
> **Agent:** GPT-5.3 Codex (or any capable coding model)
> **Working directory:** `/Users/luca/Documents/SMPL all/`

## Before you start any task

1. Read `AGENTS.md` — commands, style rules, reference file index
2. Read `CODEMAP.md` — every file, class, and endpoint (replaces exploring source)
3. Read `PATTERNS.md` — named implementation patterns (cite by name in your work)
4. Read `TASKS/archive/tasks_a_through_i.md` only if you need context on past work

---

```
CURRENT_TASK: J — Mobile & Tablet Responsive Layout
```

---

## Task J — Mobile & Tablet Responsive Layout

> **Goal:** Make SMPL fully usable on phones (375 px+) and tablets (768 px+) by adding a
> collapsible sidebar, proper mobile breakpoints, and fixing the handful of layouts that
> currently overflow or require a desktop-width viewport.

### Key findings (from codebase audit)

| Problem | Location | Severity |
|---------|----------|----------|
| No breakpoints below 860 px | `styles.css` | 🔴 blocker |
| Sidebar has no toggle/collapse | `Sidebar.tsx`, `Header.tsx` | 🔴 blocker |
| `100vh` clips on mobile browsers | `styles.css` (`.app-shell`) | 🔴 blocker |
| Planning grid requires ~1 540 px (7 × 210 px cols) | `styles.css` | 🔴 blocker |
| Report/material tables have `min-width: 820 px` | `styles.css` | 🟠 major |
| `.chat-layout` shows 2 columns with no mobile toggle | `styles.css` | 🟠 major |
| `.time-grid`, `.profile-layout`, `.admin-layout` untested narrow | `styles.css` | 🟡 moderate |

Target breakpoints to add: **480 px** (phone landscape / small phone), **768 px** (tablet portrait).

Files to change: `styles.css`, `Sidebar.tsx`, `Header.tsx`, `App.tsx`, `context/AppContext.tsx`

---

### Phase J-1 — Global foundations

#### J-1.1 — Read before starting
- [x] `apps/web/src/styles.css` lines 1–120 — note `:root` variables and `.app-shell` rule
- [x] `apps/web/src/App.tsx` lines 1–80 — note existing state declarations and context shape
- [x] `apps/web/src/context/AppContext.tsx` — note `AppContextValue` interface (add `sidebarOpen` + `setSidebarOpen`)

#### J-1.2 — Fix viewport height units
- [x] In `styles.css`, find every `height: 100vh` and `min-height: 100vh` on `.app-shell`,
  `.content`, `.sidebar` and replace with `100dvh`.
  _Rationale: mobile browsers reserve space for their address bar; `100vh` over-extends and
  causes the bottom of the page to be hidden behind the browser chrome._

#### J-1.3 — Add missing breakpoints to the CSS
Insert these two new breakpoints in `styles.css` after the existing `@media (min-width: 900px)` block:
```css
/* ── 768 px — tablet portrait ─────────────────────────────── */
@media (max-width: 768px) { ... }

/* ── 480 px — phone ───────────────────────────────────────── */
@media (max-width: 480px) { ... }
```

#### J-1.4 — Add sidebar-toggle CSS custom property
In `:root`:
```css
--sidebar-width: 320px;
--sidebar-mobile-width: 280px;
```

### Verification J-1
- [x] `cd apps/web && npx tsc --noEmit` — must pass with zero errors
- [x] `npm run build` — must complete without error

---

### Phase J-2 — Collapsible sidebar

#### J-2.1 — Add `sidebarOpen` state to App.tsx
```tsx
const [sidebarOpen, setSidebarOpen] = useState(false);
```
Expose via `AppContext`: add `sidebarOpen: boolean` and `setSidebarOpen: (v: boolean) => void`
to `AppContextValue` in `context/AppContext.tsx`.

#### J-2.2 — Add hamburger button to Header.tsx
- Add a `<button className="sidebar-toggle" onClick={() => setSidebarOpen(o => !o)}>` button
  that is **only visible at ≤ 900 px** (use `display: none` at wider breakpoints via CSS).
- Render a ☰ / ✕ icon (can use a simple inline SVG or Unicode `≡`).

#### J-2.3 — Wire the sidebar open/close state
In `Sidebar.tsx`:
- Read `sidebarOpen` from context.
- Add `aria-hidden={!sidebarOpen}` and a conditional CSS class `sidebar--open`.
- Add a click-outside overlay `<div className="sidebar-overlay" onClick={() => setSidebarOpen(false)} />`
  rendered when `sidebarOpen` is true.

#### J-2.4 — Mobile sidebar CSS (`styles.css`, inside `@media (max-width: 900px)`)
```css
/* Off-canvas drawer */
.sidebar {
  position: fixed;
  inset: 0 auto 0 0;
  width: var(--sidebar-mobile-width);
  transform: translateX(-100%);
  transition: transform 0.22s ease;
  z-index: 200;
}
.sidebar.sidebar--open {
  transform: translateX(0);
}
.sidebar-overlay {
  display: none;
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.4);
  z-index: 199;
}
.sidebar--open ~ .sidebar-overlay,
.sidebar-overlay.active { display: block; }

/* Push content back to full-width */
.content { margin-left: 0 !important; }
```

#### J-2.5 — Auto-close sidebar on navigation
In `App.tsx`, where `setMainView` is called, also call `setSidebarOpen(false)`.

### Verification J-2
- [x] At 375 px: sidebar hidden by default, hamburger visible, tap opens drawer, tap outside closes it
- [x] At 1024 px: hamburger hidden, sidebar always visible, normal layout unchanged

---

### Phase J-3 — Planning page horizontal overflow

The planning grid uses `repeat(7, minmax(210px, 1fr))` — that's ~1 540 px minimum width.
On mobile, allow horizontal scrolling rather than forcing a compressed layout.

#### J-3.1 — Wrap the planning grid in a scroll container
In `styles.css` inside `@media (max-width: 900px)`:
```css
.planning-calendar-scroll {
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
}
.planning-grid {
  min-width: 1200px; /* preserve desktop layout, just scroll */
}
```

#### J-3.2 — On phones (≤ 480 px) — single-day column view
Inside `@media (max-width: 480px)`:
```css
.planning-grid {
  display: block; /* single column */
  min-width: unset;
}
.planning-day-col {
  margin-bottom: 1rem;
}
/* Hide off-range day columns via JS class if needed */
```
_Note: This may require a small addition in `PlanningPage.tsx` to show only the currently
selected day on phones, toggling with prev/next arrows. Assess during implementation._

### Verification J-3
- [x] At 375 px: planning page shows single-day column with horizontal arrow navigation
- [x] At 768 px: horizontal scroll with all 7 days accessible

---

### Phase J-4 — Tables & report layouts

#### J-4.1 — Horizontal-scroll wrapper for wide tables
In `styles.css` inside `@media (max-width: 768px)`:
```css
.table-responsive {
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
}
```
In `ConstructionPage.tsx` and `MaterialsPage.tsx`, wrap `<table>` elements in
`<div className="table-responsive">`.

#### J-4.2 — Fix `min-width` on `.construction-report-table` and `.materials-table`
Inside `@media (max-width: 768px)`:
```css
.construction-report-table,
.materials-table {
  min-width: 600px; /* allow horizontal scroll, not page overflow */
}
```

#### J-4.3 — `.time-grid` stacking
In `.time-grid` (timesheet layout) inside `@media (max-width: 768px)`:
```css
.time-grid { grid-template-columns: 1fr; }
.time-grid-sidebar { display: none; } /* or collapsible */
```

### Verification J-4
- [x] At 375 px: construction report, materials list, timesheet do not overflow viewport
- [x] Horizontal scroll bar appears for tables that require it

---

### Phase J-5 — Page-level layout fixes

Work through each page at 375 px and 768 px. Apply CSS-only fixes in `styles.css`.

#### J-5.1 — Chat / Messages page
```css
@media (max-width: 768px) {
  .chat-layout {
    grid-template-columns: 1fr; /* single column */
  }
  .chat-thread-list { display: block; }     /* show by default */
  .chat-message-pane { display: none; }     /* hidden until thread selected */
  .chat-layout.thread-selected .chat-thread-list { display: none; }
  .chat-layout.thread-selected .chat-message-pane { display: block; }
}
```
In `MessagesPage.tsx`, add/remove `thread-selected` class on the wrapper when a thread is
clicked / back button is pressed.

#### J-5.2 — Profile page
```css
@media (max-width: 768px) {
  .profile-layout { grid-template-columns: 1fr; }
  .profile-avatar-col { text-align: center; }
}
```

#### J-5.3 — Admin page
```css
@media (max-width: 768px) {
  .admin-layout { grid-template-columns: 1fr; }
  .admin-tabs { flex-wrap: wrap; }
}
```

#### J-5.4 — Overview / dashboard cards
```css
@media (max-width: 768px) {
  .overview-grid { grid-template-columns: 1fr; }
}
@media (max-width: 480px) {
  .overview-action-cards { grid-template-columns: 1fr; }
}
```

#### J-5.5 — Workspace header stacking
```css
@media (max-width: 768px) {
  .workspace-header {
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .workspace-header-actions { width: 100%; justify-content: flex-end; }
}
```

### Verification J-5
- [x] Navigate all 16 sections at 375 px — no horizontal overflow on any page
- [x] At 768 px — all pages look reasonable on tablet portrait

---

### Phase J-6 — Final regression

#### J-6.1 — Cross-device smoke test (use browser DevTools device emulation)
| Device | Width | Test |
|--------|-------|------|
| iPhone SE | 375 px | Login → Dashboard → Project → Chat → Time |
| iPhone 15 Pro Max | 430 px | Same flow |
| iPad Mini | 768 px | Same + Planning page |
| iPad Air landscape | 1024 px | All 16 sections |
| Desktop | 1280 px | Regression — nothing broken |

#### J-6.2 — Accessibility check
- [x] Sidebar toggle button has `aria-label="Open navigation"` / `"Close navigation"`
- [x] Sidebar has `aria-hidden` when closed
- [x] Overlay has `aria-hidden="true"`

#### J-6.3 — TypeScript check
- [x] `cd apps/web && npx tsc --noEmit` — zero errors

#### J-6.4 — Build check
- [x] `npm run build` — zero errors

### Commit
```
git add apps/web/src/styles.css \
        apps/web/src/components/layout/Sidebar.tsx \
        apps/web/src/components/layout/Header.tsx \
        apps/web/src/App.tsx \
        apps/web/src/context/AppContext.tsx \
        apps/web/src/pages/PlanningPage.tsx \
        apps/web/src/pages/MessagesPage.tsx
git commit -m "feat(web): mobile & tablet responsive layout"
```

**TASK J STATUS:** ☐ IN PROGRESS → ☑ COMPLETE

---

## Completed tasks

All completed tasks are archived in `TASKS/archive/tasks_a_through_i.md`.

Summary of what has been done:

| Task | What was built | Status |
|------|---------------|--------|
| A | AppContext — context/AppContext.tsx, Provider in App.tsx | ✅ |
| B | types/index.ts, constants/index.ts extracted from App.tsx | ✅ |
| C | utils/*.ts — 11 domain utility files extracted | ✅ |
| D | components/icons/, gauges/, shared/ — presentational components | ✅ |
| E | components/layout/Sidebar.tsx, Header.tsx | ✅ |
| F | components/modals/ — 6 modal components | ✅ |
| G | pages/ — 10 simple page components | ✅ |
| H | pages/project/ — 7 sub-tabs + ProjectPage.tsx shell | ✅ |
| I | React.lazy() code splitting — all 16 pages lazy-loaded | ✅ |
| — | Large pages: ConstructionPage, TimePage, MessagesPage, ProfilePage, AdminPage | ✅ |

---

## Task template (copy this block when adding a new task)

```
## Task [LETTER/NUMBER] — [Short title]

> **Goal:** [One sentence describing what this task achieves and why it matters]

### Steps

#### [LETTER]1 — Read before starting
- [ ] [LETTER]1a. Read [file] lines X–Y — note [what to look for]

#### [LETTER]2 — [Step name]
- [ ] [LETTER]2. [Exact instruction]

...

### Verification
- [ ] Run: `[command]`
- [ ] Expected: [what success looks like]

### Commit
- [ ] `git add [files]`
- [ ] `git commit -m "[type]: [description]"`

**TASK [LETTER] STATUS:** ☐ IN PROGRESS → ☑ COMPLETE
```
