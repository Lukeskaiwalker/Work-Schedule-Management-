# Personal start page (Startseite) — build contract

The overview page becomes a personal dashboard: every user arranges their own
widgets, once per **device class** (Handy, Tablet, Desktop). Read this before
touching `pages/OverviewPage.tsx`, anything under `components/dashboard/`,
`/api/dashboard/*`, or `users.preferences["dashboard_layouts"]`.

Owner decisions of 2026-10-21 are binding. This document turns them into a
contract that lets the parts in §10 be built in parallel without talking to
each other. Where it says "must", tests hold the builder to it.

Revision 2 (2026-10-21) folds in two reviews. §16 lists what changed and what
was rejected, with the reason.

---

## 0. Decisions at a glance

| # | Decision | Why |
|---|----------|-----|
| D1 | User layouts live in `users.preferences["dashboard_layouts"][device]` | The JSON column exists (migration 0036). No migration needed |
| D2 | Role defaults live in 15 `app_settings` rows, `dashboard_default:{role}:{device}` | One row per role × device stays under the 2048-char column limit by construction. The worst case is 994 chars, and a test holds it below 2000 |
| D3 | **No migration.** `20261021_0103` (down `20261020_0102`) stays unused | D1 and D2 cover the storage |
| D4 | Dedicated `/api/dashboard/*` endpoints instead of the generic `PATCH /auth/me/preferences` | Layouts need structured validation, permission filtering, a hidden-widget merge and a row lock |
| D5 | The **server** owns widget permissions (`requires`). It returns filtered layouts, `available_widgets` and `default_sizes` | Access has one source of truth. The web holds only UI (labels, components) |
| D6 | Hidden widgets **survive saves**. Reads drop widgets the user may not see; a save puts them back at their old position (§3.3) | If the permission is granted again, the widget comes back, even after the user saved in between |
| D7 | Writes reject only what cannot be stored: an unknown id, a duplicate, bad settings (422 with `{code, message, ids}`). An id the caller may not see is **accepted** and stored hidden. Reads are tolerant | A permission revoked mid-edit, a stale tab or a per-worker permission cache can never produce a save that fails forever |
| D8 | Resolution order per device: own layout, then admin role default, then built-in default (code) | Owner decision 2 |
| D9 | Device by width, from two queries only: `(min-width: 1280px)` → desktop, else `(min-width: 768px)` → tablet, else mobile. Changes are debounced 200 ms. Edit mode freezes the device it started on | Owner decision 3. No gap at fractional widths; a window dragged across 1280 px does not swap the layout every frame; rotating mid-edit cannot save into the other layout |
| D10 | Grid columns come from the **device**, never from the viewport: mobile 1, tablet 2, desktop 3. Span: S = 1, M = 2, L = full row, each clamped to the column count. `grid-auto-flow: row` (never `dense`). What S/M/L show per widget is in §1.1 | Owner decision 1 ("3–4" on desktop; 3 fixed in v1, see §16). The admin previews a phone layout on a desktop, and the frozen edit device can differ from the live width, so the device must drive the grid |
| D11 | Each widget appears **at most once** per layout | Stable DnD keys and bounded storage (D2) |
| D12 | Edit mode shows **placeholder tiles** (title + description at real span). Users and admins use the same editor. The editor, dialog and `@dnd-kit` load only on „Anpassen“ and in the admin tab | No fetches while rearranging, no accidental Einstempeln, one editor, a small overview chunk |
| D13 | Drag uses `@dnd-kit/core@6.3.1`, `@dnd-kit/sortable@10.0.0`, `@dnd-kit/utilities@3.2.2`, pinned exactly, configured as in §8.3. The non-drag path is the move buttons | Touch, mouse and keyboard sensors with announcements; the buttons are reliable and testable in jsdom |
| D14 | Widgets load through a **module-level resource store per signed-in user**: one request and one poller per key, polling only while visible and subscribed, data kept between visits (stale-while-revalidate), cleared when the session ends | „Start“ is the most used tab; returning to it must render at once, not fire ten requests behind skeletons |
| D15 | One new data endpoint, `GET /api/dashboard/absent-today` (minimised, §4.3), and one optional query `preview_limit` (1–10) on the existing `GET /werkstatt/dashboard` | `/planning/week` is too heavy for "who is absent today"; the Werkstatt previews are capped at 5/3/5 today, below the 10 rows of „Groß“ |
| D16 | Role defaults need `settings:manage` (admin, Geschäftsführung) | UI configuration, not a grant. Changing to admin-only is one string (`permissions:manage`) |
| D17 | Last write wins per device; a row lock stops a phone save and a desktop save from losing each other's device key | One person's data, saved only by „Fertig“ |
| D18 | Bug fix: **every `/auth/me*` route that returns the current user answers `UserMeOut` from one builder** (`GET /me`, `PATCH /me`, `PATCH /me/preferences`, `POST /me/mfa/disable`). Every client `setUser(updated)` caller merges defensively | Owner decision 6; the 2FA disable path has the same bug |
| D19 | `UserOut.preferences` hides `dashboard_layouts` | The dashboard API is the only reader; keeps `/auth/me` and user lists small and never exposes unfiltered layouts |
| D20 | The page keeps its nav name „Übersicht“. „Startseite“ is the name inside the editor | No nav churn |
| D21 | „Mein Einsatz“ (`planning_today`) is **personal**: built from context `tasks` (`my_all`, already loaded on the overview). Zero extra requests, no polling | `/planning/week` returns the whole company's week for `tasks:view_all` users; a row-capped slice of it would be arbitrary. A team view is Q2 |
| D22 | Role change: a customised layout is **kept**. It carries the role it was saved under, and after a role change the page offers the new role's default once per device („Übernehmen“ / „Behalten“) | Nobody loses their work, and a promoted user still finds the new start page in one tap |
| D23 | Realtime: `overview` joins `TASK_EVENTS_ONLY_VIEWS`; there is no `dashboardRevision`. Widgets refresh from context (tasks, projects, notifications, threads) or their own poll | An admin receives every company event; the old mapping reloaded the page on every chat message |
| D24 | Widget code is lazy per widget. Metadata (titles, groups) lives apart from components | A phone with four widgets does not download twenty |
| D25 | The build starts with **P0**, a one-builder skeleton (shared types, store, frame, empty group files, package pins), then fans out (§10) | The parts import each other's files; without P0 nothing compiles in parallel |

Out of scope for v1: the partner portal (partners never load this page), the
mobile bottom bar, weather, per-widget settings other than the shortcut tiles,
editing another device's layout (Q4), a team Einsatz board (Q2), copying one
role default to another, and pushing a changed role default onto layouts users
already customised.

---

## 1. Widget catalog (v1, 20 widgets)

`requires` is an AND of OR-groups: `[["a","b"],["c"]]` means (a or b) and c.
An empty value means any signed-in internal user. Catalog order is the order of
`available_widgets` and of the „Widget hinzufügen“ list.

| id | group | Titel (de) | requires | data (all existing unless marked NEW) | refresh |
|----|-------|-----------|----------|----------------------------------------|---------|
| `shortcuts` | shortcuts | Schnellzugriff | – | context (`navViews`, `tasks`, `threads`) | context |
| `my_status` | personal | Mein Status | `time:clock` | `GET /time/current` (key `time:current`); `POST /time/clock-in`, `clock-out`, `break-start`, `break-end` | 30 s |
| `my_tasks` | personal | Meine Aufgaben | – | context `tasks` (view `my_all`, loaded by App on overview) | context |
| `my_vacation` | personal | Urlaub | `time:view_own` | balance from `GET /time/current` (shared key `time:current`); list from `GET /time/vacation-requests?user_id={me}` | 10 min (30 s for the balance when `my_status` shares the key) |
| `notifications` | personal | Benachrichtigungen | – | context `notifications` (+ SSE) | context |
| `planning_today` | planning | Mein Einsatz | – | context `tasks` (D21) | context |
| `my_projects` | planning | Meine Projekte | `projects:view` | context `recentAssignedProjects` | context |
| `critical_projects` | planning | Kritische Projekte | `projects:view` | context `projects` where `is_critical` | context |
| `absent_today` | planning | Wer fehlt heute | `planning:manage` \| `time:view_all` \| `time:manage` | **NEW** `GET /api/dashboard/absent-today` | 10 min |
| `werkstatt_kpis` | werkstatt | Lager-Kennzahlen | – | `GET /werkstatt/dashboard?preview_limit=10` → `kpis` (shared key) | 2 min |
| `werkstatt_reorder` | werkstatt | Nachbestellen | – | same call → `reorder_preview`; „+n weitere“ from `kpis.below_min_count` | 2 min |
| `werkstatt_on_site` | werkstatt | Auf Baustelle | – | same call → `on_site_groups`; „+n weitere“ from `kpis.on_site_project_count` | 2 min |
| `werkstatt_my_checkouts` | werkstatt | Meine Ausleihen | – | `GET /werkstatt/mobile/my-checkouts` | 2 min |
| `werkstatt_boxes` | werkstatt | Baustellenkisten | – | `GET /werkstatt/boxes?status=gepackt&limit=50` and `?status=zugewiesen&limit=50` | 2 min |
| `werkstatt_inspections` | werkstatt | Fällige Prüfungen | – | `GET /werkstatt/inspections/due?days_ahead=30` | 10 min |
| `recent_panels` | werkstatt | Zuletzt bearbeitete Verteiler | – | `GET /schaltplan/panels/recent?limit=10` | 2 min |
| `recent_reports` | office | Neueste Berichte | `reports:view` \| `reports:manage` \| `reports:create` | `GET /construction-reports/recent?limit=10` | 60 s |
| `vacation_approvals` | office | Offene Urlaubsanträge | `time:approve_vacation` AND (`time:view_all` \| `time:manage`) | `GET /time/vacation-requests?status=pending` | 2 min |
| `clocked_in` | office | Wer ist eingestempelt | `time:view_all` \| `time:manage` | `GET /time/clock-summary` | 60 s |
| `unread_chats` | office | Ungelesene Chats | `chat:project` \| `chat:manage` | context `threads` (`unread_count > 0`) | context (12 s app poll) |

Notes:

- **`vacation_approvals`** has a two-part requirement. Without view rights the
  list endpoint returns only the caller's own requests, and a widget titled
  „Offene Urlaubsanträge“ would then mislead.
- **`my_vacation`** must pass `user_id={me}` (for `time:view_all` users the
  bare call returns everyone's requests). The balance comes from
  `/time/current`, which returns it fresh (`vacation_days_total_remaining`,
  `vacation_days_planned_next_year`), not from `/auth/me`, which is loaded once
  at login. It shows „davon nächstes Jahr“ the way TimePage does.
- **`planning_today`** filters `tasks` to the signed-in user (`assignee_ids`
  contains `user.id`), not done, with `due_date…end_date` (end defaults to
  due) overlapping today or this week (Monday–Sunday, app timezone date).
- **Werkstatt reads** need only a signed-in user today, which matches the nav.
  See Q3.
- **`/werkstatt/dashboard?preview_limit=10`**: the dashboard always asks for 10
  so one shared key serves every size; widgets slice to their row limit. The
  Werkstatt page keeps calling without the parameter (default 5, unchanged).
  On-site groups keep their 5-item cap; a row is one project.
- **`shortcuts`** has no `requires`. Each tile follows `navViews` (§9.5), so a
  tile never offers what the sidebar hides.

Shortcut tile views (closed set, 1–12 per widget):
`my_tasks, planning, calendar, construction, reports, schaltplan, werkstatt,
messages, time, wiki, projects_all, projects_map, customers, ausbildung`.
The retired `materials` view is not in the set.

**Shortcuts without a choice.** When `shortcuts` has no `settings`, or its
`views` end up empty after read-side cleanup, it shows the preset for the
current workspace mode and device: FIELD / OFFICE, or M_FIELD / M_OFFICE on
phones (§5). On write, `settings`, when present, must carry 1–12 views.

### 1.1 What the size means per widget

Row limits are `DASHBOARD_ROW_LIMIT` = S 3, M 5, L 10. Every list shows
„+{n} weitere“ (a link to the full page) when more rows exist.

| id | Klein | Mittel | Groß |
|----|-------|--------|------|
| `shortcuts` | compact list: icon + label + badge, one per line | tile grid (auto-fill, min tile 96 px) | tile grid |
| `my_status` | state line, hours today, clock and break buttons | + hours gauge | + shift start, break taken, required hours |
| `my_tasks` | 3 rows, no filter | 5 rows + status filter | 10 rows + status filter |
| `my_vacation` | remaining days (+ „davon nächstes Jahr“), next approved leave | + 5 own requests | + 10 own requests |
| `notifications` | 3 rows | 5 rows + „Alle gelesen“ | 10 rows + „Alle gelesen“ |
| `planning_today` | today only, 3 rows, no toggle | toggle „Heute“ / „Woche“ (default Heute), 5 rows | week grouped by day, 10 rows, toggle default „Woche“ |
| `werkstatt_kpis` | 2 KPIs: Unter Mindestbestand, Auf Baustelle | 4 KPIs: + Nicht verfügbar, In Reparatur | 4 KPIs with sub-labels |
| every other widget | 3 rows | 5 rows | 10 rows |

The toggle in `planning_today` is not persisted.

Per-device hint under the „Größe“ radios (edit mode only):

- Handy: „Auf dem Handy sind alle Widgets gleich breit. Die Größe bestimmt, wie viel ein Widget zeigt.“
- Tablet: „Auf dem Tablet sind Mittel und Groß gleich breit; Groß zeigt mehr.“
- Desktop: no hint.

---

## 2. Data model and JSON shapes

### 2.1 Widget item and layout

```json
{ "id": "shortcuts", "size": "large", "settings": { "views": ["my_tasks", "planning", "werkstatt", "time"] } }
{ "id": "my_status", "size": "medium" }
```

- `size` ∈ `small | medium | large`.
- `settings` is allowed **only** on `shortcuts`, and only as `{ "views": [...] }`
  with 1–12 entries. On every other widget it is omitted or `null`. The client
  never sends `settings: null`; `sameLayout` treats a missing value and `null`
  as equal, and `dashboardApi.ts` normalises responses (drops `null` settings).
- A layout is `{ "version": 1, "widgets": [item, ...] }`, in display order. An
  empty `widgets` list is valid: the user removed everything. That differs from
  "no layout", where the key is absent and the default applies.

### 2.2 User storage: `users.preferences` (JSON, existing)

```json
{
  "planning_mobile_view": "list",
  "dashboard_layouts": {
    "tablet": {
      "version": 1,
      "role": "employee",
      "updated_at": "2026-10-21T18:40:12Z",
      "widgets": [
        { "id": "shortcuts", "size": "large", "settings": { "views": ["my_tasks", "planning", "werkstatt", "time"] } },
        { "id": "my_status", "size": "medium" },
        { "id": "planning_today", "size": "medium" },
        { "id": "werkstatt_my_checkouts", "size": "small" }
      ]
    }
  }
}
```

- The device keys `mobile`, `tablet` and `desktop` are each optional.
- `role` is the user's role at save time (D22). A stored layout without it
  (none exist yet) counts as "role unchanged".
- `updated_at` is an ISO-8601 UTC **string**. Never put a `datetime` into the
  dict: the JSON column cannot serialise it and the flush fails.
- Only the dashboard service writes this key. The generic preference PATCH
  ignores it (not whitelisted) and preserves it (it copies the dict).

### 2.3 Role default storage: `app_settings` (existing)

| key | value (compact JSON, `separators=(",",":")`) |
|-----|------|
| `dashboard_default:planning:desktop` | `{"version":1,"widgets":[{"id":"shortcuts","size":"large","settings":{"views":["my_tasks","planning","projects_all","customers","calendar","messages","time","wiki"]}},{"id":"planning_today","size":"medium"}]}` |

`updated_at` comes from the row. A missing row means the built-in default
applies. The service refuses to store more than `MAX_STORED_CHARS = 2000`
characters (code `too_large`; defence in depth, unreachable under §3).

---

## 3. Validation and the save merge

### 3.1 Write (`PUT`)

1. **Shape** (Pydantic, `extra="forbid"` everywhere): `version == 1`;
   `widgets` has at most `len(CATALOG)` items; `id` is a 1–64 char string;
   `size` is one of the three; `settings.views` has 1–12 strings. The path
   `device` must be one of the three values (`Literal`). These keep FastAPI's
   default 422 with a **list** `detail`; the client shows the generic save
   error for any non-object `detail`.
2. Every `id` is in the catalog. Code `unknown_widget`, message „Widget „{id}“
   gibt es nicht.“
3. No `id` appears twice. Code `duplicate_widget`, „Widget „{id}“ ist doppelt.“
4. `settings` is present (non-null) only on `shortcuts`. Code
   `settings_not_allowed`, „Einstellungen gibt es nur für den Schnellzugriff.“
5. `settings.views`: each entry in the closed set, none repeated. Codes
   `unknown_view` / `duplicate_view`, „Kachel „{view}“ gibt es nicht.“ /
   „Kachel „{view}“ ist doppelt.“
6. The path `role` (role defaults) must be in `ALL_ROLES`, never `external`.
   Anything else is a 404, „Unbekannte Rolle.“

Rules 2–5 raise `DashboardLayoutError(code, message, ids)`. The router maps it
to `HTTPException(422, detail={"code": …, "message": …, "ids": [...]})`. A
**user** PUT accepts any catalog id, including ids the caller may not see
(D7); they are stored and stay hidden on read. A **role-default** PUT also
accepts any catalog id, and the response lists the ids the role cannot see in
`hidden_for_role`.

### 3.2 Read

- If `preferences` is NULL or not a dict, or the stored layout is unparsable,
  not a dict, has the wrong `version`, or `widgets` is not a list, the layout
  counts as absent and resolution falls through to the next source. A warning
  is logged with the user id and device only, never the content.
- Unknown ids, duplicates after the first occurrence, bad sizes and bad
  settings are dropped item by item. A bad size becomes the catalog
  `default_size`; unknown views are dropped; `settings` whose views end up
  empty are dropped (the preset applies).
- The result is filtered to the user's available ids (D6) unless the caller
  asks for the unfiltered layout (the save merge, §3.3).

### 3.3 Save merge (D6)

`save_user_layout` must, after taking the row lock:

```
effective = resolve_layout(db, user, device, filtered=False).widgets   # user → role → builtin, unfiltered
available = set(available_ids_for_user(user))
incoming_ids = {item["id"] for item in incoming}
hidden = [(i, item) for i, item in enumerate(effective)
          if item["id"] in CATALOG_BY_ID and item["id"] not in available and item["id"] not in incoming_ids]
merged = list(incoming)
for index, item in hidden:                      # ascending index
    merged.insert(min(index, len(merged)), item)
```

Then store `merged`. The duplicate and length checks hold by construction
(unique catalog ids). The response is the merged layout filtered for the
caller. So a hidden widget from the user's own layout, the role default or the
built-in default keeps its place through every save, and comes back when the
permission returns.

---

## 4. API

All routes live in `apps/api/app/routers/dashboard.py`, mounted with
`prefix="/api"`. Every route depends on `get_current_user`, so the partner
fence closes them automatically. `tests/test_partner_portal_security.py`
walks the route table and must stay green.

| Method | Path | Permission | Request | Response |
|--------|------|------------|---------|----------|
| GET | `/api/dashboard` | signed in | – | `DashboardOut` |
| PUT | `/api/dashboard/layouts/{device}` | signed in | `DashboardLayoutIn` | `DashboardLayoutOut` (`source: "user"`) |
| DELETE | `/api/dashboard/layouts/{device}` | signed in | – | `DashboardLayoutOut` (resolved: `role` or `builtin`) |
| GET | `/api/dashboard/absent-today` | `planning:manage` \| `time:view_all` \| `time:manage`, else 403 | – | `AbsentTodayOut` |
| GET | `/api/dashboard/role-defaults` | `settings:manage` | – | `DashboardRoleDefaultsOut` |
| PUT | `/api/dashboard/role-defaults/{role}/{device}` | `settings:manage` | `DashboardLayoutIn` | `DashboardRoleDefaultOut` |
| DELETE | `/api/dashboard/role-defaults/{role}/{device}` | `settings:manage` | – | `DashboardRoleDefaultOut` (`source: "builtin"`) |

Changed existing route (A2): `GET /werkstatt/dashboard` gains
`preview_limit: int = Query(5, ge=1, le=10)`, passed to the reorder, on-site,
maintenance and movement previews (the service functions already take
`limit`). The default keeps today's payload.

Both DELETEs answer 200 with a body, not 204 (project rule: a 204 route must
not be annotated `-> None`). Role-default PUT and DELETE write an audit entry:
`log_admin_action(db, user, "dashboard.role_default.update" |
"dashboard.role_default.reset", "dashboard_default", f"{role}:{device}",
details={"widgets": [ids]}, category="settings")`. User layout saves are not
audited (personal UI preference).

### 4.1 Write path (user) — exact pattern

```python
db.refresh(user, with_for_update=True)                       # row lock (no-op on SQLite)
prefs = user.preferences if isinstance(user.preferences, dict) else {}
layouts = prefs.get(USER_PREFERENCE_KEY)
layouts = layouts if isinstance(layouts, dict) else {}
entry = {"version": 1, "role": user.role, "updated_at": iso_utc_now(), "widgets": merged}
user.preferences = {**prefs, USER_PREFERENCE_KEY: {**layouts, device: entry}}
db.commit()
# DELETE: user.preferences = {**prefs, USER_PREFERENCE_KEY: {k: v for k, v in layouts.items() if k != device}}
```

**Never change a nested dict in place** (`prefs["dashboard_layouts"][device] =
…`). SQLAlchemy decides whether to UPDATE a plain JSON column by comparing the
old and new value with `==`; a nested dict shared between them makes both
sides equal and no UPDATE is sent, so the second device's save is silently
lost. `PATCH /auth/me/preferences` takes the same row lock (A1). The lock only
works on Postgres; the integration gate checks it there (§12).

### 4.2 Examples

`GET /api/dashboard` (employee, tablet customised, others default):

```json
{
  "layouts": {
    "mobile":  { "device": "mobile",  "version": 1, "source": "builtin", "updated_at": null, "role_changed": false,
                 "widgets": [ { "id": "my_status", "size": "medium" }, { "id": "shortcuts", "size": "medium", "settings": { "views": ["construction", "planning", "messages", "wiki"] } } ] },
    "tablet":  { "device": "tablet",  "version": 1, "source": "user", "updated_at": "2026-10-21T18:40:12Z", "role_changed": false,
                 "widgets": [ { "id": "my_status", "size": "medium" } ] },
    "desktop": { "device": "desktop", "version": 1, "source": "role", "updated_at": "2026-10-20T07:00:00Z", "role_changed": false,
                 "widgets": [ { "id": "shortcuts", "size": "large", "settings": { "views": ["my_tasks", "planning"] } } ] }
  },
  "available_widgets": ["shortcuts", "my_status", "my_tasks", "my_vacation", "notifications", "planning_today",
                        "my_projects", "critical_projects", "werkstatt_kpis", "werkstatt_reorder", "werkstatt_on_site",
                        "werkstatt_my_checkouts", "werkstatt_boxes", "werkstatt_inspections", "recent_panels",
                        "recent_reports", "unread_chats"],
  "default_sizes": { "shortcuts": "large", "my_status": "medium", "my_tasks": "medium", "...": "..." }
}
```

`default_sizes` covers the whole catalog. `role_changed` is true only when
`source == "user"` and the stored `role` differs from the user's current role.

`PUT /api/dashboard/layouts/desktop`:

```json
{ "version": 1, "widgets": [ { "id": "my_tasks", "size": "large" }, { "id": "my_status", "size": "small" } ] }
```

A 422 from rules 2–5:

```json
{ "detail": { "code": "unknown_widget", "message": "Widget „weather“ gibt es nicht.", "ids": ["weather"] } }
```

`GET /api/dashboard/role-defaults` (shortened):

```json
{
  "catalog": [ { "id": "my_status", "group": "personal", "default_size": "medium", "requires": [["time:clock"]] } ],
  "roles": ["admin", "ceo", "accountant", "planning", "employee"],
  "defaults": [
    { "role": "ceo", "device": "desktop", "source": "builtin", "updated_at": null,
      "widgets": [ { "id": "critical_projects", "size": "small" } ], "hidden_for_role": [] }
  ]
}
```

`defaults` always has 15 entries, in role order × `mobile, tablet, desktop`.
`hidden_for_role` is computed against the role's effective **role-level**
permission map (`get_effective_permissions()[role]`, which includes admin
overrides and ignores per-user overrides).

### 4.3 `GET /api/dashboard/absent-today` (minimised)

```json
{ "date": "2026-10-21", "absences": [ { "user_id": 7, "user_name": "Mara Beispiel", "type": "vacation", "label": "Urlaub" } ] }
```

- "Today" is the app timezone's date (`datetime.now(_app_timezone()).date()`,
  as in `/time/clock-summary`). The 403 check happens **before** reading,
  because `_planning_absences_by_day` (`routers/workflow_helpers.py`) would
  otherwise quietly return only the caller. Rows come from that helper with
  `week_start = week_end = today`, so the audience is exactly the planning
  board's.
- The response is **shaped for minimisation** in
  `services/dashboard_absences.py`. `type` and `label` come from a server map,
  never from the row's free-text title:

  | stored type | `type` | `label` |
  |-------------|--------|---------|
  | vacation request, school absence `vacation` | `vacation` | Urlaub |
  | `school` | `school` | Berufsschule |
  | `training` | `training` | Fortbildung |
  | `company_event` | `company_event` | Betriebsveranstaltung |
  | `holiday` | `holiday` | Feiertag |
  | everything else (`sick`, `work_accident`, `special_leave`, `unpaid_leave`, `parental_leave`, `care_leave`, `other`, unknown) | `absent` | Abwesend |

- **One row per user**: when several apply, the first in the table order wins.
  Rows are sorted by `user_name`. The web shows EN twins by `type`.

### 4.4 Bug fix: `/auth/me*` responses (owner decision 6)

- In `routers/auth.py`, `_me_out(db: Session, user: User) -> UserMeOut` holds
  today's body of `me()` (vacation balance, `effective_permissions`,
  `can_update_recent_own_time_entries`).
- **Rule:** every `/auth/me*` route that returns the current user returns
  `_me_out`. Today that is `GET /me`, `PATCH /me`, `PATCH /me/preferences` and
  `POST /me/mfa/disable` (all switch to `response_model=UserMeOut`). The login
  routes keep `UserOut`: the token effect (App.tsx ~2377) refetches `/auth/me`
  at once.
- In `schemas/user.py`, add `HIDDEN_PREFERENCE_KEYS = frozenset({"dashboard_layouts"})`
  and a `field_validator("preferences", mode="before")` on `UserOut` that
  returns a new dict without those keys (a non-dict becomes `{}`).

---

## 5. Built-in defaults (`services/dashboard_defaults.py`)

Applied when neither the user nor an admin has set a layout. Filtered per user
at read time, so for example `my_status` never appears for a role without
`time:clock`. Sizes: S = small, M = medium, L = large. The desktop and tablet
defaults are written to fill whole rows on 3 and 2 columns.

Shortcut presets:

| Preset | Views |
|--------|-------|
| FIELD | my_tasks, planning, construction, werkstatt, messages, time, wiki |
| OFFICE | my_tasks, planning, projects_all, customers, calendar, messages, time, wiki |
| M_FIELD | construction, planning, messages, wiki |
| M_OFFICE | planning, projects_all, customers, messages |

FIELD is today's tile set with the retired "materials" tile swapped for
"werkstatt". The phone presets complement the bottom bar, which already has
Start, Aufgaben, Werkstatt, Zeit and Profil.

| role | mobile | tablet | desktop |
|------|--------|--------|---------|
| admin | my_status M, shortcuts M (M_OFFICE), my_tasks M, vacation_approvals M, clocked_in M, critical_projects M | shortcuts L (OFFICE), my_status S, clocked_in S, my_tasks M, vacation_approvals S, absent_today S, critical_projects S, recent_reports S, werkstatt_kpis M | shortcuts L (OFFICE), my_status S, clocked_in S, vacation_approvals S, my_tasks M, absent_today S, critical_projects S, recent_reports S, notifications S, werkstatt_kpis M, werkstatt_reorder S |
| ceo | shortcuts M (M_OFFICE), critical_projects M, vacation_approvals M, my_tasks M, unread_chats M | shortcuts L (OFFICE), critical_projects S, vacation_approvals S, my_tasks M, clocked_in S, absent_today S, recent_reports S, unread_chats S | shortcuts L (OFFICE), critical_projects S, clocked_in S, vacation_approvals S, my_tasks M, absent_today S, recent_reports S, unread_chats S, notifications S |
| accountant | shortcuts M (M_OFFICE), my_tasks M, clocked_in M, unread_chats M | shortcuts L (OFFICE), clocked_in S, absent_today S, my_tasks M, recent_reports S, critical_projects S | shortcuts L (OFFICE), clocked_in S, absent_today S, critical_projects S, my_tasks M, recent_reports S, unread_chats S, notifications S |
| planning | shortcuts M (M_OFFICE), planning_today M, absent_today M, my_tasks M, unread_chats M | shortcuts L (OFFICE), planning_today M, absent_today S, critical_projects S, my_tasks M, recent_reports S, unread_chats S | shortcuts L (OFFICE), planning_today M, absent_today S, my_tasks M, critical_projects S, recent_reports S, unread_chats S, notifications S, recent_panels S |
| employee | my_status M, shortcuts M (M_FIELD), my_tasks M, planning_today M, werkstatt_my_checkouts M | shortcuts L (FIELD), my_status M, my_tasks M, planning_today S, my_projects S, werkstatt_my_checkouts S, recent_reports S | shortcuts L (FIELD), my_status S, recent_reports S, my_projects S, my_tasks M, planning_today S, werkstatt_my_checkouts S, notifications S |

The employee desktop default starts with today's page (shortcuts, status,
reports, projects, tasks), so the first impression after the release is
familiar. An unknown role falls back to the employee defaults.

---

## 6. Resolution (server)

```
resolve_layout(db, user, device, filtered=True):
  stored = parse_stored(user.preferences["dashboard_layouts"][device])          → source "user"
  else stored = parse_stored(app_settings["dashboard_default:{role}:{device}"]) → source "role"
  else builtin_widgets(role, device)                                             → source "builtin"
  role_changed = source == "user" and stored.role is not None and stored.role != user.role
  return widgets (filtered to available_ids_for_user(user) when filtered)
```

`GET /api/dashboard` reads at most three `app_settings` rows. The permission
checks are in memory.

**Role change (D22).** An admin changing someone's role does not touch their
layouts. Devices still on `role` or `builtin` follow the new role at once. A
customised device returns `role_changed: true`, and the page offers the new
role's default (§8.1). „Übernehmen“ is the user DELETE; „Behalten“ is a user
PUT of the current widgets, which re-stamps `role` (and the merge keeps hidden
widgets).

---

## 7. Migration

None (D1–D3). Existing users have no `dashboard_layouts` key, so they get the
built-in default of their role (§5). Nothing needs a backfill. If a later
version needs bigger role defaults, `20261021_0103` (down `20261020_0102`)
would add a `dashboard_role_defaults` table and move the 15 rows. Note that
`label-calibration` also uses 0102, so whoever ships second renumbers.

---

## 8. UI behaviour and German copy

### 8.1 Live mode

- A slim toolbar sits above the grid with „Anpassen“ (aria-label „Startseite
  anpassen“). The grid follows D10. Each widget is a card with a title, an
  optional count badge, an optional header link („Alle anzeigen“) that opens
  the full page, and the body.
- **Role-change notice** (when `layouts[device].role_changed`): „Deine Rolle
  wurde geändert. Möchtest du die Startseite deiner neuen Rolle übernehmen?“
  with „Übernehmen“ and „Behalten“ (§6).
- **Restored draft** (§8.2): „Deine nicht gespeicherten Änderungen sind
  wiederhergestellt.“
- A widget whose resource answers **403** shows „Keine Berechtigung.“, stops
  polling that key, and the host refetches `GET /api/dashboard` once per visit
  (which normally removes the widget).

### 8.2 Edit mode

Entered from „Anpassen“. The device is frozen: the draft renders with
`data-device` of the frozen device until „Fertig“ or „Abbrechen“, whatever
the width does meanwhile. If the live device differs afterwards, the page
shows „Für {Handy|Tablet|Desktop} gespeichert.“ and then the live device's
layout.

- Header „Startseite anpassen · {Handy|Tablet|Desktop}“, hint „Ziehe Widgets
  am Griff oder nutze die Pfeile. Gilt für alle deine Geräte dieser Größe.“
- The toolbar holds „Widget hinzufügen“, „Auf Standard zurücksetzen“,
  „Abbrechen“ and „Fertig“ (primary). It is **sticky**: at the top on tablet
  and desktop, at the bottom on phones with `env(safe-area-inset-bottom)`.
- **The mobile bottom bar is hidden while editing**, with the pattern the app
  already uses for modals: `.app-shell:has(.dashboard-host--editing)
  .mobile-bottom-nav { display: none !important; }` (in `dashboard.css`).
- **Draft protection.** Leaving the overview while editing keeps the draft in
  memory per user and device (`dashboardDrafts.ts`). Returning to the overview
  on the same device class reopens edit mode with that draft and the restored
  notice. „Fertig“ (on success), „Abbrechen“, reset and session end clear it.
- Source badge „Standard deiner Rolle“ (role or builtin) or „Persönlich
  angepasst“ (user).
- Each placeholder tile holds:
  - a drag handle (aria „„{Titel}“ verschieben“), the only drag activator
  - the move buttons: „Nach vorne“ / „Nach hinten“ on tablet and desktop,
    „Nach oben“ / „Nach unten“ on phones (aria „„{Titel}“ nach vorne
    verschieben“ etc.), disabled at the ends
  - the radiogroup „Größe“ with „Klein“, „Mittel“ and „Groß“, plus the
    per-device hint from §1.1
  - „Entfernen“ (aria „„{Titel}“ entfernen“). No confirm; „Abbrechen“ undoes it.
  - Every control is at least 44 × 44 px.
- `shortcuts` also gets „Kacheln wählen“: a checklist of the views with mode
  hints „nur Baustelle“ / „nur Büro“ and the limit hint „Höchstens 12
  Kacheln.“ Unticking the last view is not possible (at least one).
- The live region (`aria-live="polite"`) announces „„{Titel}“ ist jetzt an
  Position {n} von {gesamt}.“, „„{Titel}“ hinzugefügt.“ and „„{Titel}“
  entfernt.“ The dnd-kit announcements and instructions are German:
  „Drücke die Leertaste, um das Widget anzuheben. Mit den Pfeiltasten
  verschiebst du es, mit der Leertaste legst du es ab, mit Escape brichst du
  ab.“
- The add dialog („Widget hinzufügen“) groups widgets under „Schnellzugriff“,
  „Persönlich“, „Planung & Projekte“, „Werkstatt“ and „Büro“. Each row has the
  title, the description and „Hinzufügen“. A new widget goes to the end at its
  `default_sizes` size. Empty state: „Alle verfügbaren Widgets sind schon auf
  deiner Startseite.“
- **Reset** („Auf Standard zurücksetzen“) is enabled only when `source ===
  "user"`. It confirms („Startseite für {Gerät} auf den Standard deiner Rolle
  zurücksetzen? Deine Anpassungen für diese Gerätegröße gehen verloren.“ with
  „Zurücksetzen“ / „Abbrechen“), sends the DELETE at once, leaves edit mode and
  renders the resolved layout.
- „Fertig“ makes no request when the draft equals the loaded layout.
- **Save errors**, staying in edit mode:
  - 422 `unknown_widget`: refetch `GET /api/dashboard`, prune the draft to ids
    in the registry and the catalog, and show „Einige Widgets gibt es nicht
    mehr. Wir haben sie aus deinem Entwurf entfernt – bitte prüfe ihn und
    speichere erneut.“
  - other 422 with an object `detail`: show `detail.message`.
  - anything else: „Startseite konnte nicht gespeichert werden. Bitte erneut
    versuchen.“

### 8.3 Drag and drop configuration

- Drag only from the handle (`setActivatorNodeRef`); the handle has
  `touch-action: none`, the tile does not, so the page still scrolls on touch.
- Sensors: `MouseSensor { activationConstraint: { distance: 6 } }`,
  `TouchSensor { activationConstraint: { delay: 200, tolerance: 8 } }`,
  `KeyboardSensor { coordinateGetter: sortableKeyboardCoordinates }`.
- `rectSortingStrategy`, transforms via `CSS.Translate.toString` (not
  `CSS.Transform`, which scales tiles of different spans).
- `prefers-reduced-motion: reduce` turns transitions off.

### 8.4 States

| State | Copy |
|-------|------|
| Page load error | „Startseite konnte nicht geladen werden.“ + „Erneut versuchen“ |
| Empty layout | „Deine Startseite ist leer. Über „Anpassen“ fügst du Widgets hinzu.“ |
| Widget error | „Konnte nicht geladen werden.“ + „Erneut versuchen“ |
| Widget stale (a refresh failed after a good load) | badge „Nicht aktuell“ |
| Widget forbidden (403) | „Keine Berechtigung.“ |
| Widget loading | skeleton rows; never a „0“ (house rule from `useWerkstattOverview`) |

### 8.5 Titles and descriptions (each with an EN twin in `widgetMeta.ts`)

| id | Titel | Beschreibung | Empty state |
|----|-------|--------------|-------------|
| shortcuts | Schnellzugriff | Kacheln zu deinen wichtigsten Seiten. | – |
| my_status | Mein Status | Ein- und ausstempeln, Stunden heute. | – |
| my_tasks | Meine Aufgaben | Deine offenen Aufgaben, überfällige zuerst. | (existing card copy) |
| my_vacation | Urlaub | Resturlaub und deine Anträge. | Keine offenen Anträge. |
| notifications | Benachrichtigungen | Neueste Hinweise für dich. | Keine Benachrichtigungen. |
| planning_today | Mein Einsatz | Wofür du heute und diese Woche eingeplant bist. | Heute bist du nicht eingeplant. / Diese Woche bist du nicht eingeplant. |
| my_projects | Meine Projekte | Projekte mit offenen Aufgaben für dich. | Keine zugewiesenen Projekte. |
| critical_projects | Kritische Projekte | Als kritisch markierte Projekte. | Keine kritischen Projekte. |
| absent_today | Wer fehlt heute | Wer heute nicht da ist. | Heute fehlt niemand. |
| werkstatt_kpis | Lager-Kennzahlen | Unter Mindestbestand, auf Baustelle, in Reparatur. | – |
| werkstatt_reorder | Nachbestellen | Artikel unter Mindestbestand. | Nichts nachzubestellen. |
| werkstatt_on_site | Auf Baustelle | Ausgegebenes Material je Projekt. | Nichts auf Baustelle. |
| werkstatt_my_checkouts | Meine Ausleihen | Was du gerade ausgeliehen hast. | Du hast nichts ausgeliehen. |
| werkstatt_boxes | Baustellenkisten | Gepackte und zugewiesene Kisten. | Keine gepackten oder zugewiesenen Kisten. |
| werkstatt_inspections | Fällige Prüfungen | Prüfungen der nächsten 30 Tage. | Keine Prüfungen in den nächsten 30 Tagen. |
| recent_panels | Zuletzt bearbeitete Verteiler | Die zuletzt geänderten Verteilerpläne. | Noch keine Verteilerpläne. |
| recent_reports | Neueste Berichte | Die neuesten Baustellenberichte. | Keine Berichte vorhanden. |
| vacation_approvals | Offene Urlaubsanträge | Anträge, die auf Freigabe warten. | Keine offenen Anträge. |
| clocked_in | Wer ist eingestempelt | Wer gerade arbeitet, mit Stunden heute. | Niemand ist eingestempelt. |
| unread_chats | Ungelesene Chats | Chats mit neuen Nachrichten. | Keine ungelesenen Nachrichten. |

`my_status` errors stay inside the widget: „Einstempeln fehlgeschlagen.“,
„Ausstempeln fehlgeschlagen.“, „Pause konnte nicht gestartet werden.“ and
„Pause konnte nicht beendet werden.“ Its buttons are disabled while a request
is in flight, so a double tap cannot clock in twice.

### 8.6 Admin tab „Startseiten“ (en „Start pages“), shown with `canManageSettings`

- Heading „Standard-Startseiten je Rolle“. Intro „Neue und zurückgesetzte
  Startseiten beginnen mit diesem Stand. Wer seine Startseite schon angepasst
  hat, behält sie.“
- Selectors „Rolle“ (labels from `roleLabel`) and „Gerät“ (Handy / Tablet /
  Desktop). Switching either with unsaved changes asks „Ungespeicherte
  Änderungen verwerfen?“ („Verwerfen“ / „Abbrechen“).
- The editor renders inside a **fixed-width preview frame** (390 / 820 /
  1280 px for Handy / Tablet / Desktop) in its own horizontal scroll container
  (the root has `overflow-x: clip`). Columns come from the device (D10).
- Badge „Angepasst“ or „Werkseinstellung“. Buttons „Speichern“ and „Auf
  Werkseinstellung zurücksetzen“. Tiles in `hidden_for_role` carry „Für diese
  Rolle unsichtbar (fehlende Berechtigung)“. Feedback „Gespeichert.“ or
  „Konnte nicht gespeichert werden.“
- The audit target label `dashboard_default` reads „Standard-Startseite“
  (en „Default start page“).

---

## 9. Web architecture

### 9.1 Flow

`OverviewPage` keeps the guard (`if (mainView !== "overview") return null`)
and renders `<DashboardHost/>`. The host:

1. Gets `device` from `useDashboardDevice()`.
2. Gets the layouts from `useDashboardLayouts(token, user.id)`: a module-level
   last-known value per user id, seeded on a cold start from localStorage key
   `smpl_dashboard_layouts:{userId}` (widget ids, sizes and settings only;
   every access in try/catch), revalidated by `GET /api/dashboard` on mount.
3. Renders `layouts[device].widgets` in `DashboardGrid device={device}`,
   skipping ids without a loader (version skew). Each widget is
   `React.lazy` (cached per id), inside `DashboardWidgetBoundary` (a per-widget
   error boundary showing the widget error copy) and `Suspense` with the frame
   skeleton as fallback. One crash never takes down the page.
4. On „Anpassen“ lazy-loads `DashboardEditMode` (editor, add dialog,
   `@dnd-kit`, settings editor).

### 9.2 Device

`useDashboardDevice()` reads `(min-width: 1280px)` and `(min-width: 768px)`
via `matchMedia` and maps them with `deviceFromMatches` (D9). The initial value
is synchronous; later changes are debounced 200 ms. Under the global jsdom
stub (every query false) it returns `mobile`; tests that need another device
stub `matchMedia` per query (pattern of `werkstattMobileHome.test.tsx`).
`useIsMobileViewport` and the Sidebar's 900 px drawer breakpoint are not
touched. An iPad Pro 13" is tablet in portrait (1024 px) and desktop in
landscape (1366 px); that follows owner decision 3 (see Q5).

### 9.3 Resource store

- **Module-level, one store per user id** (`getDashboardResourceStore(userId)`).
  It holds the latest token (`setToken`), and every module-level cache
  registers with `onDashboardSessionEnd`; App calls `endDashboardSession()`
  wherever it ends the session (W2), which clears stores, layouts and drafts.
- Per key: one in-flight request, one poller, subscribers counted. The interval
  is the smallest `pollMs` among current subscribers. Polling runs only while
  the document is visible (`startVisiblePolling` + `createSingleFlight`, both
  existing) and while at least one subscriber exists.
- **Stale-while-revalidate:** a new subscriber renders the cached data at once
  and fetches only if the data is older than its `pollMs` (or never loaded).
  The last unsubscribe stops the poller and **keeps** the data.
- First error: `data` stays `null`, `error` set. A later failure keeps the data
  and sets `stale`. **403** sets `forbidden`, stops that key's poller and is
  sticky until the session ends.
- No revision bumps: there is no `refreshOnRevision` (D23).
- Keys follow `<area>:<what>[:<param>]`. Shared ones: `werkstatt:dashboard`,
  `werkstatt:boxes:gepackt`, `werkstatt:boxes:zugewiesen`, `time:current`,
  `time:vacation-requests:own`, `reports:recent`, `dashboard:absent-today`.
  A key's loader is a module-level function; the first registration wins, so
  two widgets sharing a key import the same loader (`time:current` from
  `dashboardTimeApi.ts`, `werkstatt:dashboard` from `werkstattResources.ts`).

### 9.4 App.tsx changes (part W2 only)

1. **Time poll.** The condition at App.tsx ~3041 (`mainView !== "time" &&
   mainView !== "overview"`) loses `overview`. `my_status` polls
   `/time/current` itself (30 s).
2. **Reports, removed outright:** the `recentConstructionReports` state, the
   function `loadRecentConstructionReports`, the overview effect (~3049–3056),
   the calls at ~3090 (realtime), ~3241 (`loadBaseData`) and ~8162 (after a
   report submit), both context members (`recentConstructionReports`,
   `loadRecentConstructionReports` at AppContext.tsx ~1217) and their entries
   in the context value; check `test/appContextStub.ts`.
3. **Realtime.** The overview branch of `refreshActiveViewRealtime` becomes
   `await loadMyTasks(); return;`. In `utils/realtimeRefresh.ts`, `"overview"`
   joins `TASK_EVENTS_ONLY_VIEWS`; `test/realtimeRefresh.test.ts` gains the
   cases. Projects (`projectLists`), threads and notifications keep their own
   refresh kinds.
4. **Defensive merge.** `saveUserPreference`, the profile save (`PATCH
   /auth/me`) and `components/profile/TwoFactorSection.tsx` (2FA disable) use
   `mergeUserUpdate(prev, updated)`. `saveUserPreference` stops swallowing
   errors silently: it calls `console.warn` with the key only and returns
   `false`. The planning and map callers stay non-blocking.
5. **Dead code.** Delete `overviewActionCards` and `overviewActionCardWidth`
   (App + AppContext).
6. **Session end.** Every place that ends the session (`setToken(null)` at
   ~2385, ~2428, ~9582) also calls `endDashboardSession()`.
7. **Unchanged.** The `my_all` tasks load on overview stays (shortcut badge,
   `my_tasks`, `my_projects`, `planning_today`).

**Request budget**, desktop with every widget placed: about 7.5 polled
requests a minute (`time:current` 2, clock summary 1, reports 1, Werkstatt
dashboard 0.5, boxes 1, checkouts 0.5, panels 0.5, pending vacation 0.5, the
10-minute keys 0.3). Event-driven: only my tasks reload, on task events, at
most 12 a minute under a burst (as today). Today's overview makes about 52
polled (4 every 5 s plus reports every 15 s) and reloads tasks **and** reports
on every company event, chat included.

### 9.5 Navigation (`useDashboardNavigation`)

`open(target)` runs today's shortcut sequence (`setProjectBackView(null)`,
`setOverviewShortcutBackVisible(true)`, `setConstructionBackView(null)`, then
the target). `resolveView(view)` maps a view for the current mode, or returns
`null` when the view is not in `navViews` (the tile or link is hidden).

| Target | Baustelle | Büro |
|--------|-----------|------|
| `my_tasks` (tile, task rows, task notifications) | `my_tasks` | `office_tasks` |
| Verteiler row (`recent_panels`) | `schaltplan`, plus `requestOpenPanel(summary)` | `werkstatt` › tab `verteiler` (Kommissionierung); row aria „In der Kommissionierung öffnen“ |
| `schaltplan`, `ausbildung` tiles | as in nav | hidden |
| `projects_map` tile | hidden | `projects_map` |
| Werkstatt widgets | `werkstatt` › `dashboard` / `nachbestellen` / `on_site` / `kisten` / `maschinen` | same |
| Project rows | `openProjectById(id, null)` | same |
| Chat rows | `setActiveThreadId(id)`, then `messages` | same |
| Everything else | same view | same view |

**Schaltplan handoff** (`utils/schaltplanHandoff.ts`): `requestOpenPanel`
stores the summary with a timestamp; `peekPendingPanel()` returns it while it
is younger than 30 s; `clearPendingPanel()` drops it. SchaltplanPage peeks in
a mount effect, calls `pickRecent(summary)`, and clears only after the panel
opened, so React.StrictMode's double effect (main.tsx) cannot lose it.

`showOverviewBackButton` is unchanged in v1.

### 9.6 Grid and CSS rules

- `DashboardGrid` sets `data-device` and the column count from it only:
  `[data-device="mobile"]` 1, `tablet` 2, `desktop` 3. No viewport `@media`
  decides columns. `grid-auto-flow: row`, `align-items: start`. Items get
  `grid-column: span {columnSpan(size, device)}`.
- `DashboardWidgetFrame` sets `container: dashboard-widget / inline-size`.
  **Widget internals use `@container` only, never width-based `@media`**
  (a small desktop widget is as narrow as a phone). A vitest reads every CSS
  file under `components/dashboard/widgets/` and fails on
  `@media[^{]*(min|max)-width`.
- CSS files by owner: `src/styles/dashboard.css` (grid, frame, editor, the
  bottom-bar rule; W1), `widgets/personal/personal.css`,
  `widgets/planning/planning.css`, `widgets/werkstatt/werkstatt.css`,
  `widgets/office/office.css`, `widgets/shortcuts/shortcuts.css` (one per
  group; each widget component imports its group file, so the CSS rides in the
  lazy chunk). Nobody edits `styles.css` except the integrator's cleanup (§10).

### 9.7 Lazy loading

- `widgetMeta.ts` holds id, group, de/en title and description, the only
  thing the editor, add dialog and admin panel need (D12 placeholders render
  no widget component).
- Each group `index.ts` exports loaders only:
  `export const PERSONAL_WIDGET_LOADERS: DashboardWidgetLoaders = { my_status: () => import("./MyStatusWidget"), … }`.
  The shortcuts group also exports `SHORTCUTS_SETTINGS_EDITOR_LOADER`.
- `DashboardEditMode` (editor + add dialog) is lazy from the host;
  `AdminDashboardDefaultsPanel` is lazy from AdminPage. `@dnd-kit` must not
  land in the OverviewPage chunk (integration check, §12).

---

## 10. File plan by part (exclusive ownership)

Rules for all parts:

- Write only your own files. Import other parts' files by the paths given here
  and code against §11.
- No file over 800 lines. New files aim at 200–400.
- No `dangerouslySetInnerHTML`.
- Every hook sits above any early return (`scripts/check-hook-order.mjs`).
- German UI with EN twins via `de ? … : …`.
- Tests are written first (§12).

| Part | Files (N = new, C = changed) | Responsibility |
|------|-------------------------------|----------------|
| **P0** skeleton (one builder, first) | C `apps/web/package.json`, `package-lock.json` | The three `@dnd-kit` pins (D13). **P0 is the only part that runs `npm install`.** |
| | N `src/types/dashboard.ts` | Complete types and constant id lists (§11.2) |
| | N `src/components/dashboard/widgetMeta.ts` | All 20 entries from §8.5 (de/en) |
| | N `src/components/dashboard/widgetTypes.ts`, `dashboardPolling.ts` | §11.2 |
| | N `src/utils/dashboardApi.ts` | Every `/api/dashboard*` call, response normalisation, `dashboardErrorDetail(err)` |
| | N `src/utils/dashboardSession.ts` | `onDashboardSessionEnd`, `endDashboardSession` |
| | N `src/utils/dashboardResourceStore.ts`, `src/hooks/useDashboardResource.ts` | §9.3, complete with tests |
| | N `src/hooks/useDashboardNavigation.ts` | §9.5 |
| | N `src/components/dashboard/DashboardWidgetFrame.tsx`, `src/styles/dashboard.css` (frame rules) | Card chrome: loading, error, stale, forbidden, empty |
| | N `widgets/{personal,planning,werkstatt,office,shortcuts}/index.ts` exporting `{}` (and `SHORTCUTS_SETTINGS_EDITOR_LOADER = null`), plus the five empty group CSS files | Hand-off points |
| | After P0 lands, P0's files belong to W1, except the group `index.ts` and CSS files, which belong to W3 (personal, planning), W4 (werkstatt) and W5 (office, shortcuts) | |
| **A1** auth fix | C `apps/api/app/routers/auth.py` | `_me_out`; the four routes of §4.4 answer `UserMeOut`; row lock in `update_preferences` |
| | C `apps/api/app/schemas/user.py` | `HIDDEN_PREFERENCE_KEYS` and the `preferences` validator |
| | N `apps/api/tests/test_auth_me_responses.py` | §12 A1 |
| | C `apps/api/app/core/permissions.py` (only if Q1 is answered yes) | `time:clock` and `time:view_own` for ceo, accountant, planning; a test asserts them |
| **A2** dashboard API | N `apps/api/app/services/dashboard_catalog.py` | Catalog, `SHORTCUT_VIEWS`, availability |
| | N `apps/api/app/services/dashboard_defaults.py` | §5 tables, `builtin_widgets()` |
| | N `apps/api/app/services/dashboard_layouts.py` | Validation, tolerant parse, merge, resolution, storage (user and role) |
| | N `apps/api/app/services/dashboard_absences.py` | §4.3 shaping |
| | N `apps/api/app/schemas/dashboard.py` | §11.1 models |
| | N `apps/api/app/routers/dashboard.py` | The 7 routes in §4 |
| | C `apps/api/app/main.py` | `app.include_router(dashboard.router, prefix="/api")` |
| | C `apps/api/app/routers/workflow_werkstatt_desktop.py` | `preview_limit` query (§4) |
| | N `apps/api/tests/test_dashboard_layouts.py`, `test_dashboard_api.py`, `test_dashboard_role_defaults.py`, `test_dashboard_absences.py`, `test_dashboard_catalog_parity.py`, `test_werkstatt_dashboard_preview_limit.py` | §12 A2 |
| **W1** web core | N `src/utils/dashboardLayout.ts` | Pure layout operations, `deviceFromMatches`, `columnSpan`, `DASHBOARD_ROW_LIMIT` |
| | N `src/utils/dashboardDrafts.ts` | In-memory drafts per user and device (§8.2) |
| | N `src/hooks/useDashboardLayouts.ts`, `useDashboardDevice.ts` | §11.2 |
| | N `src/components/dashboard/widgetRegistry.ts` | Joins the five loader maps; `getLazyWidget`, `getLazySettingsEditor` |
| | N `src/components/dashboard/DashboardHost.tsx`, `DashboardGrid.tsx`, `DashboardEditMode.tsx`, `DashboardEditor.tsx`, `DashboardAddDialog.tsx`, `DashboardWidgetBoundary.tsx` | Live and edit modes, toolbar, save/reset/error flows, notices |
| | C `src/styles/dashboard.css` | Grid, editor, sticky toolbar, bottom-bar rule, reduced motion |
| | C `src/pages/OverviewPage.tsx` | Reduced to guard + `<DashboardHost/>` |
| | C `src/test/pages.smoke.test.tsx` | Übersicht case stubs `fetch` |
| **W2** App integration | C `src/App.tsx`, `src/context/AppContext.tsx`, `src/test/appContextStub.ts` | §9.4 |
| | C `src/utils/realtimeRefresh.ts`, `src/test/realtimeRefresh.test.ts` | `overview` in `TASK_EVENTS_ONLY_VIEWS` |
| | C `src/components/profile/TwoFactorSection.tsx` | `mergeUserUpdate` on 2FA disable |
| | N `src/utils/userUpdate.ts` | `mergeUserUpdate` |
| **W3** personal + planning widgets | own `widgets/personal/*`, `widgets/planning/*` (incl. `index.ts`, CSS): `MyStatusWidget`, `MyTasksWidget`, `MyVacationWidget`, `NotificationsWidget`, `PlanningTodayWidget`, `MyProjectsWidget`, `CriticalProjectsWidget`, `AbsentTodayWidget` | `PERSONAL_WIDGET_LOADERS`, `PLANNING_WIDGET_LOADERS` |
| | N `src/utils/dashboardTimeApi.ts` | `loadTimeCurrent`, `clockIn`, `clockOut`, `startBreak`, `endBreak`, `loadOwnVacationRequests` |
| | N `src/utils/dashboardPlanning.ts` | Pure: `mondayOf`, `myTasksForDay`, `myTasksForWeek` |
| | C `src/components/tasks/MyTasksOverviewCard.tsx` | Optional `rowLimit?: number`, `showFilter?: boolean`, `embedded?: boolean` (no outer chrome). Existing behaviour stays the default |
| **W4** Werkstatt widgets | own `widgets/werkstatt/*` (incl. `index.ts`, CSS, `werkstattResources.ts`): `WerkstattKpisWidget`, `WerkstattReorderWidget`, `WerkstattOnSiteWidget`, `MyCheckoutsWidget`, `BoxesWidget`, `InspectionsWidget`, `RecentPanelsWidget` | `WERKSTATT_WIDGET_LOADERS` |
| | C (optional) `src/components/werkstatt/dashboard/DashboardReorderCard.tsx`, `DashboardOnSiteCard.tsx` | Only if reused: add `embedded?: boolean` (no `section.werkstatt-card` chrome) and `rowLimit?: number`; existing tests stay green. Otherwise rebuild the bodies |
| | N `src/utils/schaltplanHandoff.ts`; C `src/pages/SchaltplanPage.tsx` | §9.5 handoff (hook above the guard) |
| **W5** office widgets + shortcuts | own `widgets/office/*`, `widgets/shortcuts/*` (incl. `index.ts`, CSS): `RecentReportsWidget`, `VacationApprovalsWidget`, `ClockedInWidget`, `UnreadChatsWidget`, `ShortcutsWidget`, `ShortcutsSettingsEditor`, `shortcutTiles.ts` | `OFFICE_WIDGET_LOADERS`, `SHORTCUT_WIDGET_LOADERS`; tiles, badges (`my_tasks`: open own tasks; `messages`: sum of `unread_count`), presets, settings editor |
| **W6** admin defaults | N `src/components/admin/AdminDashboardDefaultsPanel.tsx` | Pickers, preview frame, `DashboardEditor`, save/reset, hidden markers, dirty-switch confirm |
| | C `src/pages/AdminPage.tsx` | Tab id `dashboards`, label „Startseiten“, visible with `canManageSettings`; lazy-mounts the panel |
| | C `src/components/admin/auditLabels.ts` | `dashboard_default` label |
| **Integrator** | C `src/styles.css` | Remove the dead `.overview-*` rules (styles.css ~1319–1445, ~2736–2780) except those `MyTasksOverviewCard` still uses (`overview-card`, `overview-projects-*`) |
| | C `CODEMAP.md`, `docs/STATE.md` | After the gates |

**Sequencing.**

1. **P0** first (about two hours). A1 and A2 may start at the same time (they
   do not import web files; A2's parity test runs once P0 has landed).
2. After P0: W1–W6 in parallel. Run `npm ci` once per worktree; no other part
   touches `package*.json`.
3. W6 codes against the `DashboardEditor` props in §11.2 and mocks
   `components/dashboard/DashboardEditor` with `vi.mock` in its tests, so it
   never waits for W1.
4. W1's host tests mock `widgetRegistry`, so they do not wait for W3–W5.
5. Only one `pytest` session at a time per worktree (shared `./test.db`), so
   A1 and A2 run their suites one after the other. Build a fresh venv from
   `requirements.txt`; main's is stale.
6. After all parts land, the integrator runs the gates in §12, does the CSS
   cleanup and updates `CODEMAP.md` and `docs/STATE.md`. Builders do not edit
   shared docs.

---

## 11. Interfaces

### 11.1 Python

```python
# services/dashboard_catalog.py
DashboardDevice = Literal["mobile", "tablet", "desktop"]
WidgetSize = Literal["small", "medium", "large"]
WidgetGroup = Literal["shortcuts", "personal", "planning", "werkstatt", "office"]
DEVICES: tuple[DashboardDevice, ...] = ("mobile", "tablet", "desktop")

@dataclass(frozen=True)
class WidgetSpec:
    id: str
    group: WidgetGroup
    default_size: WidgetSize
    requires: tuple[tuple[str, ...], ...] = ()   # AND of OR-groups; strings ⊂ ALL_PERMISSIONS

CATALOG: tuple[WidgetSpec, ...]            # §1 order
CATALOG_BY_ID: Mapping[str, WidgetSpec]
SHORTCUT_VIEWS: tuple[str, ...]            # §1, 14 entries
MAX_SHORTCUT_VIEWS = 12

def is_available(spec: WidgetSpec, has_permission: Callable[[str], bool]) -> bool: ...
def available_ids_for_user(user: User) -> list[str]: ...     # has_permission_for_user
def available_ids_for_role(role: str) -> list[str]: ...      # get_effective_permissions()[role]
def default_sizes() -> dict[str, WidgetSize]: ...

# services/dashboard_defaults.py
def builtin_widgets(role: str, device: DashboardDevice) -> list[dict[str, Any]]: ...  # fresh copy

# services/dashboard_layouts.py
USER_PREFERENCE_KEY = "dashboard_layouts"
ROLE_DEFAULT_KEY_PREFIX = "dashboard_default"
LAYOUT_VERSION = 1
MAX_STORED_CHARS = 2000

class DashboardLayoutError(ValueError):
    def __init__(self, code: str, message: str, ids: Sequence[str] = ()) -> None: ...
    code: str; message: str; ids: tuple[str, ...]
    def to_detail(self) -> dict[str, Any]: ...     # {"code", "message", "ids"}

@dataclass(frozen=True)
class StoredLayout:
    widgets: list[dict[str, Any]]
    updated_at: datetime | None
    role: str | None

@dataclass(frozen=True)
class ResolvedLayout:
    device: DashboardDevice
    widgets: list[dict[str, Any]]            # [{"id","size"} | {"id","size","settings":{"views":[...]}}]
    source: Literal["user", "role", "builtin"]
    updated_at: datetime | None
    role_changed: bool = False

def clean_widgets(items: Sequence[DashboardWidgetIn]) -> list[dict[str, Any]]: ...   # rules 2–5; no availability check
def merge_hidden(incoming: list[dict[str, Any]], effective: list[dict[str, Any]], available: Collection[str]) -> list[dict[str, Any]]: ...  # §3.3, pure
def parse_stored(raw: object) -> StoredLayout | None: ...
def iso_utc_now() -> str: ...                                          # "2026-10-21T18:40:12Z"
def role_default_key(role: str, device: DashboardDevice) -> str: ...   # "dashboard_default:{role}:{device}"
def resolve_layout(db: Session, user: User, device: DashboardDevice, *, filtered: bool = True) -> ResolvedLayout: ...
def save_user_layout(db: Session, user: User, device: DashboardDevice, widgets: list[dict[str, Any]]) -> ResolvedLayout: ...
def clear_user_layout(db: Session, user: User, device: DashboardDevice) -> ResolvedLayout: ...
def resolve_role_default(db: Session, role: str, device: DashboardDevice) -> ResolvedLayout: ...   # unfiltered
def save_role_default(db: Session, role: str, device: DashboardDevice, widgets: list[dict[str, Any]]) -> ResolvedLayout: ...
def clear_role_default(db: Session, role: str, device: DashboardDevice) -> ResolvedLayout: ...

# services/dashboard_absences.py
AbsenceKind = Literal["vacation", "school", "training", "company_event", "holiday", "absent"]
ABSENCE_KIND_ORDER: tuple[AbsenceKind, ...]           # §4.3 table order; first wins per user
def absent_today(db: Session, user: User) -> AbsentTodayOut: ...   # caller has passed the 403 check

# schemas/dashboard.py  (all models: ConfigDict(extra="forbid"))
class DashboardWidgetSettings(BaseModel): views: list[str] = Field(min_length=1, max_length=MAX_SHORTCUT_VIEWS)
class DashboardWidgetIn(BaseModel): id: str = Field(min_length=1, max_length=64); size: WidgetSize; settings: DashboardWidgetSettings | None = None
class DashboardLayoutIn(BaseModel): version: Literal[1] = 1; widgets: list[DashboardWidgetIn] = Field(max_length=len(CATALOG))
class DashboardWidgetOut(BaseModel): id: str; size: WidgetSize; settings: DashboardWidgetSettings | None = None
class DashboardLayoutOut(BaseModel): device: DashboardDevice; version: Literal[1] = 1; widgets: list[DashboardWidgetOut]; source: Literal["user", "role", "builtin"]; updated_at: datetime | None = None; role_changed: bool = False
class DashboardOut(BaseModel): layouts: dict[DashboardDevice, DashboardLayoutOut]; available_widgets: list[str]; default_sizes: dict[str, WidgetSize]
class AbsenceTodayOut(BaseModel): user_id: int; user_name: str; type: AbsenceKind; label: str
class AbsentTodayOut(BaseModel): date: date; absences: list[AbsenceTodayOut]
class DashboardCatalogEntryOut(BaseModel): id: str; group: WidgetGroup; default_size: WidgetSize; requires: list[list[str]]
class DashboardRoleDefaultOut(BaseModel): role: str; device: DashboardDevice; widgets: list[DashboardWidgetOut]; source: Literal["role", "builtin"]; hidden_for_role: list[str]; updated_at: datetime | None = None
class DashboardRoleDefaultsOut(BaseModel): catalog: list[DashboardCatalogEntryOut]; roles: list[str]; defaults: list[DashboardRoleDefaultOut]
```

### 11.2 TypeScript

```ts
// types/dashboard.ts (P0)
export const DASHBOARD_DEVICES = ["mobile", "tablet", "desktop"] as const;
export type DashboardDevice = (typeof DASHBOARD_DEVICES)[number];
export const DASHBOARD_WIDGET_SIZES = ["small", "medium", "large"] as const;
export type DashboardWidgetSize = (typeof DASHBOARD_WIDGET_SIZES)[number];
export const DASHBOARD_WIDGET_IDS = [ /* §1 order, all 20, one string literal per line */ ] as const;
export type DashboardWidgetId = (typeof DASHBOARD_WIDGET_IDS)[number];
export const DASHBOARD_SHORTCUT_VIEWS = [ /* §1, 14 entries, one per line */ ] as const;
export type DashboardShortcutView = (typeof DASHBOARD_SHORTCUT_VIEWS)[number];
export const DASHBOARD_MAX_SHORTCUT_VIEWS = 12;
export type DashboardWidgetGroup = "shortcuts" | "personal" | "planning" | "werkstatt" | "office";
export type DashboardWidgetSettings = { views: DashboardShortcutView[] };
export type DashboardWidgetItem = { id: DashboardWidgetId; size: DashboardWidgetSize; settings?: DashboardWidgetSettings };
export type DashboardLayoutSource = "user" | "role" | "builtin";
export type DashboardLayout = { device: DashboardDevice; version: 1; widgets: DashboardWidgetItem[]; source: DashboardLayoutSource; updated_at: string | null; role_changed: boolean };
export type DashboardState = { layouts: Record<DashboardDevice, DashboardLayout>; available_widgets: DashboardWidgetId[]; default_sizes: Record<DashboardWidgetId, DashboardWidgetSize> };
export type DashboardLayoutInput = { version: 1; widgets: DashboardWidgetItem[] };
export type DashboardErrorCode = "unknown_widget" | "duplicate_widget" | "settings_not_allowed" | "unknown_view" | "duplicate_view" | "too_large";
export type DashboardErrorDetail = { code: DashboardErrorCode; message: string; ids: string[] };
export type AbsenceKind = "vacation" | "school" | "training" | "company_event" | "holiday" | "absent";
export type AbsentToday = { date: string; absences: { user_id: number; user_name: string; type: AbsenceKind; label: string }[] };
export type DashboardCatalogEntry = { id: DashboardWidgetId; group: DashboardWidgetGroup; default_size: DashboardWidgetSize; requires: string[][] };
export type DashboardRoleDefault = { role: string; device: DashboardDevice; widgets: DashboardWidgetItem[]; source: "role" | "builtin"; hidden_for_role: DashboardWidgetId[]; updated_at: string | null };
export type DashboardRoleDefaults = { catalog: DashboardCatalogEntry[]; roles: string[]; defaults: DashboardRoleDefault[] };

// utils/dashboardApi.ts (P0) — every function throws ApiError on non-2xx; responses are normalised (no null settings)
export function fetchDashboard(token: string | null, signal?: AbortSignal): Promise<DashboardState>;
export function saveDashboardLayout(token: string | null, device: DashboardDevice, layout: DashboardLayoutInput): Promise<DashboardLayout>;
export function resetDashboardLayout(token: string | null, device: DashboardDevice): Promise<DashboardLayout>;
export function fetchAbsentToday(token: string | null, signal?: AbortSignal): Promise<AbsentToday>;
export function fetchDashboardRoleDefaults(token: string | null): Promise<DashboardRoleDefaults>;
export function saveDashboardRoleDefault(token: string | null, role: string, device: DashboardDevice, layout: DashboardLayoutInput): Promise<DashboardRoleDefault>;
export function resetDashboardRoleDefault(token: string | null, role: string, device: DashboardDevice): Promise<DashboardRoleDefault>;
export function dashboardErrorDetail(error: unknown): DashboardErrorDetail | null;   // 422 with object detail, else null

// utils/dashboardSession.ts (P0)
export function onDashboardSessionEnd(clear: () => void): void;
export function endDashboardSession(): void;

// utils/dashboardResourceStore.ts (P0)
export type ResourceSnapshot<T> = { data: T | null; loading: boolean; error: string | null; stale: boolean; forbidden: boolean; loadedAt: number | null };
export type DashboardResourceLoader<T> = (token: string | null, signal: AbortSignal) => Promise<T>;
export type DashboardResourceStore = {
  setToken(token: string | null): void;
  subscribe<T>(key: string, loader: DashboardResourceLoader<T>, pollMs: number | null, listener: () => void): () => void;
  getSnapshot<T>(key: string): ResourceSnapshot<T>;
  reload(key: string): void;
};
export function getDashboardResourceStore(userId: number): DashboardResourceStore;   // registers its clear with onDashboardSessionEnd

// hooks/useDashboardResource.ts (P0)
export type DashboardResourceOptions = { pollMs: number | null; enabled?: boolean };
export type DashboardResourceState<T> = ResourceSnapshot<T> & { reload: () => void };
export function useDashboardResource<T>(key: string, loader: DashboardResourceLoader<T>, options: DashboardResourceOptions): DashboardResourceState<T>;
// token and user id come from useAppContext; useSyncExternalStore over the store.

// components/dashboard/widgetMeta.ts (P0)
export type DashboardWidgetMeta = { id: DashboardWidgetId; group: DashboardWidgetGroup; title: { de: string; en: string }; description: { de: string; en: string } };
export const DASHBOARD_WIDGET_META: Readonly<Record<DashboardWidgetId, DashboardWidgetMeta>>;

// components/dashboard/widgetTypes.ts (P0)
export type DashboardWidgetProps = { size: DashboardWidgetSize; settings: DashboardWidgetSettings | null; device: DashboardDevice };
export type DashboardWidgetModule = { default: ComponentType<DashboardWidgetProps> };
export type DashboardWidgetLoader = () => Promise<DashboardWidgetModule>;
export type DashboardWidgetLoaders = Partial<Record<DashboardWidgetId, DashboardWidgetLoader>>;
export type DashboardSettingsEditorProps = { settings: DashboardWidgetSettings | null; onChange: (next: DashboardWidgetSettings) => void; device: DashboardDevice; language: Language };
export type DashboardSettingsEditorLoader = () => Promise<{ default: ComponentType<DashboardSettingsEditorProps> }>;
// group index.ts: PERSONAL_/PLANNING_/WERKSTATT_/OFFICE_/SHORTCUT_WIDGET_LOADERS: DashboardWidgetLoaders;
// shortcuts/index.ts also: SHORTCUTS_SETTINGS_EDITOR_LOADER: DashboardSettingsEditorLoader | null

// components/dashboard/dashboardPolling.ts (P0)
export const DASHBOARD_POLL_MS = { timeCurrent: 30_000, clockSummary: 60_000, recentReports: 60_000,
  werkstatt: 120_000, vacationPending: 120_000, slow: 600_000 } as const;

// components/dashboard/DashboardWidgetFrame.tsx (P0)
export function DashboardWidgetFrame(props: {
  title: string;
  badge?: number | null;
  action?: { label: string; onClick: () => void } | null;
  state?: { loading: boolean; error: string | null; stale?: boolean; forbidden?: boolean; onRetry?: () => void };
  isEmpty?: boolean;
  emptyText?: string;
  more?: { count: number; onClick: () => void } | null;    // „+{n} weitere“
  children?: ReactNode;
}): JSX.Element;

// hooks/useDashboardNavigation.ts (P0)
export type DashboardTarget =
  | { kind: "view"; view: MainView }
  | { kind: "werkstatt"; tab: WerkstattTab }
  | { kind: "project"; projectId: number }
  | { kind: "thread"; threadId: number }
  | { kind: "panel"; panel: PanelPlanSummary };
export function useDashboardNavigation(): { open: (target: DashboardTarget) => void; resolveView: (view: MainView) => MainView | null };

// utils/dashboardLayout.ts (W1) — pure; never mutates its input
export const DASHBOARD_ROW_LIMIT: Record<DashboardWidgetSize, number>;          // { small: 3, medium: 5, large: 10 }
export const DASHBOARD_COLUMNS: Record<DashboardDevice, 1 | 2 | 3>;              // { mobile: 1, tablet: 2, desktop: 3 }
export function columnSpan(size: DashboardWidgetSize, device: DashboardDevice): 1 | 2 | 3;
export function deviceFromMatches(atLeastTablet: boolean, atLeastDesktop: boolean): DashboardDevice;
export function moveWidget(widgets: readonly DashboardWidgetItem[], from: number, to: number): DashboardWidgetItem[];
export function moveWidgetBy(widgets: readonly DashboardWidgetItem[], id: DashboardWidgetId, delta: -1 | 1): DashboardWidgetItem[];
export function addWidget(widgets: readonly DashboardWidgetItem[], id: DashboardWidgetId, size: DashboardWidgetSize): DashboardWidgetItem[]; // no-op if present
export function removeWidget(widgets: readonly DashboardWidgetItem[], id: DashboardWidgetId): DashboardWidgetItem[];
export function resizeWidget(widgets: readonly DashboardWidgetItem[], id: DashboardWidgetId, size: DashboardWidgetSize): DashboardWidgetItem[];
export function setWidgetSettings(widgets: readonly DashboardWidgetItem[], id: DashboardWidgetId, settings: DashboardWidgetSettings | null): DashboardWidgetItem[];
export function pruneWidgets(widgets: readonly DashboardWidgetItem[], keep: ReadonlySet<DashboardWidgetId>): DashboardWidgetItem[];
export function sameLayout(a: readonly DashboardWidgetItem[], b: readonly DashboardWidgetItem[]): boolean;   // missing settings == null

// utils/dashboardDrafts.ts (W1)
export function rememberDraft(userId: number, device: DashboardDevice, widgets: readonly DashboardWidgetItem[]): void;
export function takeDraft(userId: number, device: DashboardDevice): DashboardWidgetItem[] | null;
export function clearDraft(userId: number, device: DashboardDevice): void;

// hooks/useDashboardLayouts.ts (W1)
export function useDashboardLayouts(token: string | null, userId: number | null): {
  state: DashboardState | null; loading: boolean; error: string | null; reload: () => Promise<void>;
  save: (device: DashboardDevice, widgets: DashboardWidgetItem[]) => Promise<void>;  // throws ApiError; updates state on success
  reset: (device: DashboardDevice) => Promise<void>;                                  // throws; updates state on success
};

// hooks/useDashboardDevice.ts (W1)
export function useDashboardDevice(): DashboardDevice;

// components/dashboard/widgetRegistry.ts (W1)
export function getLazyWidget(id: DashboardWidgetId): LazyExoticComponent<ComponentType<DashboardWidgetProps>> | null;
export function getLazySettingsEditor(id: DashboardWidgetId): LazyExoticComponent<ComponentType<DashboardSettingsEditorProps>> | null;

// components/dashboard/DashboardGrid.tsx (W1)
export function DashboardGrid(props: { device: DashboardDevice; children: ReactNode }): JSX.Element;

// components/dashboard/DashboardEditor.tsx (W1) — controlled; the toolbar lives in the caller
export function DashboardEditor(props: {
  device: DashboardDevice;
  widgets: DashboardWidgetItem[];
  onChange: (next: DashboardWidgetItem[]) => void;
  availableIds: readonly DashboardWidgetId[];
  defaultSizes: Readonly<Record<DashboardWidgetId, DashboardWidgetSize>>;
  hiddenIds?: ReadonlySet<DashboardWidgetId>;
  language: Language;
}): JSX.Element;

// utils/userUpdate.ts (W2)
export function mergeUserUpdate(prev: User | null, next: User): User;  // keeps prev.effective_permissions / can_update_recent_own_time_entries when next lacks them

// utils/schaltplanHandoff.ts (W4)
export function requestOpenPanel(summary: PanelPlanSummary): void;
export function peekPendingPanel(now?: number): PanelPlanSummary | null;   // null once older than 30 s
export function clearPendingPanel(): void;

// utils/dashboardPlanning.ts (W3) — pure
export function mondayOf(day: string): string;                                       // ISO dates
export function myTasksForDay(tasks: readonly Task[], day: string, userId: number): Task[];
export function myTasksForWeek(tasks: readonly Task[], monday: string, userId: number): Task[];

// context (W2): AppContextValue loses `recentConstructionReports`, `loadRecentConstructionReports`,
// `overviewActionCards`, `overviewActionCardWidth`. No new field.
```

The context fields the widgets read, all of which exist today: `token`,
`language`, `user`, `now`, `workspaceMode`, `navViews`, `tasks`,
`recentAssignedProjects`, `projects`, `notifications`,
`markAllNotificationsRead`, `threads`, `setActiveThreadId`, `openProjectById`,
`projectTitleParts`, `recentReportProjectTitleParts`, `filePreviewUrl`,
`canManageTasks`, `setMyTasksBackProjectId` and `setWerkstattTab`. The context
value is rebuilt every second (`now`), so widgets read slices and keep render
work cheap.

---

## 12. Test plan (tests first; each test names what it asserts)

**A1, `test_auth_me_responses.py`:**

- `PATCH /auth/me/preferences`, `PATCH /auth/me` (name change) and
  `POST /auth/me/mfa/disable` (enrolled user, valid code) each return a
  non-empty `effective_permissions`, and the preference PATCH's
  `vacation_days_total_remaining` equals `GET /auth/me`'s.
- A stored `dashboard_layouts` never appears in `preferences` of `GET /auth/me`
  or `GET /admin/users`.
- A preference PATCH leaves an existing `dashboard_layouts` in the DB
  untouched; a body containing `dashboard_layouts` is ignored.

**A2, `test_dashboard_layouts.py` (unit, no client):**

- Each rule 2–5 raises `DashboardLayoutError` with its code, German message
  and ids. An empty list is valid.
- The worst-case layout (all 20 widgets, all `medium`, plus the 12 longest
  views) serialises compact under 2000 characters (994 today); a role-default
  write above `MAX_STORED_CHARS` raises `too_large`.
- `parse_stored` drops unknown ids, keeps the first of duplicates, coerces bad
  sizes, drops empty-view settings, reads `role`, and returns `None` for
  garbage or the wrong version.
- `merge_hidden`: hidden items return at their old index, clamped to the new
  length; an incoming id is never duplicated; available ids are not
  reinserted.
- Every `builtin_widgets(role, device)` for 5 roles × 3 devices passes
  `clean_widgets`. Every `requires` string is in `ALL_PERMISSIONS`.
  `SHORTCUT_VIEWS` has no `materials`. `"dashboard_layouts" in
  HIDDEN_PREFERENCE_KEYS`.

**A2, `test_dashboard_api.py`:**

- Admin `GET` gives three `builtin` layouts and `default_sizes` for all 20.
- An employee gets neither `clocked_in` nor `vacation_approvals` nor
  `absent_today` in `available_widgets` or in any layout.
- **Multi-device:** `PUT tablet`, `PUT desktop`, then `GET` in a new session
  gives both `source == "user"` and mobile unchanged; `DELETE tablet` keeps
  desktop.
- Unknown id, duplicate id and settings on `my_tasks` each give 422 with the
  object `detail` (`code`, `message`, `ids`); a bad device gives FastAPI's 422.
- A `PUT` containing an id the caller may not see succeeds (200), stores it,
  and the response and the next `GET` omit it.
- **Hidden survives save:** deny `time:clock`, `PUT` a desktop layout without
  `my_status`, remove the deny, `GET` shows `my_status` at its old position.
- `preferences` NULL or a non-dict: `GET` falls back to role/builtin, no 500.
- `role_changed`: save as employee, change the role to planning, `GET` gives
  `role_changed: true` on that device only; a `PUT` re-stamps it to false.
- `DELETE` gives back the role or builtin layout.

**A2, `test_dashboard_absences.py`:**

- An employee gets 403. A `planning` user gets 200 and sees another user's
  approved vacation covering today, not one that ended yesterday.
- A school absence with type `sick` and the title „Arzttermin Beispiel“ comes
  back as `type: "absent"`, `label: "Abwesend"`, and the title appears nowhere
  in the response body.
- A user with a vacation and a school absence today appears once, as vacation.

**A2, `test_dashboard_role_defaults.py`:**

- An employee gets 403 on all three routes. A ceo (`settings:manage`) gets 200.
- `PUT planning/desktop`, then a planning user without their own layout gets
  `source == "role"` with those widgets; a planning user with their own
  desktop layout keeps it.
- A PUT containing `clocked_in` for `employee` is accepted and lists it in
  `hidden_for_role`.
- `role=external` and an unknown role give 404. `DELETE` returns `builtin` and
  removes the row. An audit row `dashboard.role_default.update` exists.

**A2, `test_dashboard_catalog_parity.py`:** reads
`apps/web/src/types/dashboard.ts` with a regex and asserts
`DASHBOARD_WIDGET_IDS` equals the `CATALOG` ids in order and
`DASHBOARD_SHORTCUT_VIEWS` equals `SHORTCUT_VIEWS`. Skips only when the file is
absent (API-only checkout); the integrator's run must not skip it.

**A2, `test_werkstatt_dashboard_preview_limit.py`:** with 8 articles below
minimum, the default call returns 5 reorder rows, `preview_limit=10` returns 8,
`preview_limit=11` gives 422.

**P0:**

- `dashboardResourceStore.test.ts` (fake timers, fake document):
  - two subscribers on one key cause one fetch; the poll uses the minimum
    interval; a hidden document makes no requests
  - an initial error gives `data == null`; an error after success keeps the
    data and sets `stale`
  - a 403 sets `forbidden` and stops that key's poller
  - the last unsubscribe stops the poller and keeps the data; a re-subscribe
    within `pollMs` makes **no** request and returns the cached data
  - `endDashboardSession()` empties every store
- `dashboardApi.test.ts`: method, path and body of every call, including
  `encodeURIComponent` on role and device; `null` settings are dropped;
  `dashboardErrorDetail` reads an object detail and returns `null` for a list.
- `dashboardWidgetFrame.test.tsx`: skeleton (never „0“) while loading, error +
  retry, stale badge, forbidden copy, empty copy, „+n weitere“.

**W1:**

- `dashboardLayout.test.ts`: each operation returns a new array and leaves the
  input deep-equal to before. `moveWidgetBy` stays put at the ends. `addWidget`
  never duplicates. `deviceFromMatches` covers all four combinations.
  `columnSpan` clamps (L on tablet is 2, everything on mobile is 1).
  `sameLayout` treats missing and `null` settings as equal.
- `dashboardHost.test.tsx` (`fetch` stubbed, registry mocked with two fake
  widgets):
  - a mobile matchMedia renders the mobile layout; a desktop one renders the
    desktop layout
  - `DashboardGrid device="mobile"` under a desktop matchMedia renders one
    column (`data-device="mobile"`)
  - „Anpassen“, remove, „Fertig“ sends a `PUT` with the expected body; an
    unchanged „Fertig“ sends nothing
  - **freeze:** enter edit under tablet, switch matchMedia to desktop, press
    „Fertig“: the PUT goes to `/layouts/tablet` and the notice „Für Tablet
    gespeichert.“ shows
  - a generic save failure shows the copy and stays in edit mode; a 422
    `unknown_widget` refetches, prunes the draft and shows its copy
  - reset is disabled for `role`/`builtin`; for `user` it confirms, sends a
    `DELETE` and leaves edit mode
  - unmount while editing a dirty draft, remount: edit mode with the draft and
    the restored notice
  - `role_changed` shows the notice; „Übernehmen“ sends `DELETE`, „Behalten“
    sends `PUT`
  - an unknown id is skipped; a load error shows „Erneut versuchen“; a widget
    that throws shows the widget error and the others still render
  - a cold start renders the localStorage layout before `GET` answers; a
    throwing `localStorage` changes nothing
  - the editing host carries `dashboard-host--editing` (bottom-bar rule)
- `dashboardEditor.test.tsx`:
  - the move buttons reorder and announce, are disabled at the ends, and read
    „Nach oben“ / „Nach unten“ on mobile
  - the size radios change the span; the per-device hint shows on mobile and
    tablet only
  - the add dialog lists only available ids not yet placed, grouped, and adds
    at `defaultSizes`
  - `hiddenIds` shows the marker; the drag handle has its German aria-label
- `dashboardRegistry.test.ts`: every `DASHBOARD_WIDGET_IDS` entry has meta with
  de/en title and description, and (after W3–W5 land) exactly one loader.
- `dashboardWidgetCss.test.ts`: no width-based `@media` under
  `components/dashboard/widgets/`.
- `pages.smoke.test.tsx`: Übersicht still mounts and unmounts.

**W2:**

- `userUpdate.test.ts`: `mergeUserUpdate` keeps `effective_permissions` when
  the update lacks it and takes the update's when present.
- `realtimeRefresh.test.ts`: on `overview`, a `message.created` asks for
  `threads` but not `activeView`; a `task.updated` asks for `activeView`.
- `npm run check` stays green (hook order, existing tests).

**W3 / W4 / W5** (one test file per group; widgets render with stubbed context
and mocked loaders that return what the **server** returns, e.g. at most 10
Werkstatt preview rows):

- Each widget renders at small and large per §1.1 (row caps, `my_status`
  gauge only from M, `werkstatt_kpis` 2 vs 4), shows its empty copy, and shows
  skeleton or error, never `0`, while data is `null`.
- `my_status`: clock-in posts once even if tapped twice, then reloads
  `time:current`.
- `my_vacation` calls `?user_id={me}` and reads the balance from
  `time:current`; with `my_status` on the page there is one `/time/current`
  request.
- `planning_today`: an admin's widget shows only tasks assigned to them;
  multi-day tasks appear on every covered day; done tasks are left out.
- Navigation runs through `useDashboardNavigation`: task rows go to
  `office_tasks` in Büro mode; a Verteiler row goes to `werkstatt/verteiler` in
  Büro mode and to `schaltplan` plus `requestOpenPanel` in Baustelle mode.
- `schaltplanHandoff.test.ts`: peek survives a StrictMode double mount;
  `clearPendingPanel` empties it; a 31-second-old request is ignored.
- Shortcuts: tiles not in `navViews` are hidden; no settings shows the mode and
  device preset; the `my_tasks` badge counts open own tasks; the `messages`
  badge sums `unread_count`; the settings editor caps at 12 and keeps at
  least 1.
- The three Werkstatt widgets on one page make **one** `/werkstatt/dashboard`
  request, with `preview_limit=10`.

**W6, `adminDashboardDefaults.test.tsx`** (`DashboardEditor` mocked):

- The panel loads; switching role or device shows that layout; switching with
  a dirty draft asks first.
- The preview frame has the device width and `data-device`.
- „Speichern“ sends a `PUT` to `/api/dashboard/role-defaults/{role}/{device}`;
  reset sends a `DELETE`; the hidden marker shows for `hidden_for_role` ids.
- The tab is absent without `canManageSettings`.

**Integration** (the integrator, after all parts):

- `cd apps/web && npx tsc --noEmit` gives 0 errors; `npm run check` is green;
  `npm audit` has no high or critical.
- `npm run build`: `@dnd-kit` is in its own chunk, not in `OverviewPage-*.js`.
- `pytest` over the whole suite exits 0 (one session), including
  `test_partner_portal_security.py` and the parity test (not skipped).
  `pip-audit` is clean (no new Python dependencies).
- **Postgres 16** (throwaway container): two concurrent `PUT`s for different
  devices of one user both survive (the row lock).
- Browser check at 390, 820, 1024 ↔ 1366 (iPad Pro rotation), 1440 and
  1920 px: the right layout per width, 3 columns on both desktop widths, drag
  with mouse, touch (iOS Safari: the page scrolls when not on the handle) and
  keyboard, no horizontal page scroll, the bottom bar hidden while editing.

---

## 13. Security notes

- **Server-side enforcement is unchanged or stricter.** Every widget's data
  comes from an endpoint that already checks access. The new endpoint 403s
  before reading. Hiding a widget is UX, not the control; storing a hidden id
  (D7) grants nothing.
- **Dashboard routes** use `get_current_user`, so the partner fence applies.
  Role defaults need `settings:manage` and are audited.
- **Input** is closed sets only (widget ids, sizes, views), with Pydantic
  `extra="forbid"` and bounded list lengths. No free text is stored. Role
  default storage is bounded below the column limit.
- **Data minimisation.** `absent-today` returns only names the caller already
  sees on the planning board, with a generic label: health, accident, family
  and free-text reasons never reach a start page (GDPR Art. 9; office screens
  are often shared). The Werkstatt widgets expose exactly what the Werkstatt
  nav exposes to the same user (Q3). `preview_limit` is bounded at 10.
- **Lost updates.** A row lock covers both preference writers (A1 and A2),
  verified on Postgres; writes never mutate nested JSON in place (§4.1).
- **Session end.** In-memory widget data, layouts and drafts are cleared when
  the session ends (shared workshop tablets). The localStorage layout cache
  holds widget ids and sizes only, keyed by user id.
- **Dependencies.** The only new ones are the three `@dnd-kit` packages, MIT
  licensed, pinned exactly, versions published well before 2026. P0 runs
  `npm audit` after installing; the integrator runs it again. No Python
  dependencies.
- **No `dangerouslySetInnerHTML`.** Report links keep `rel="noreferrer"`.
- **Logs.** Dashboard warnings log the user id and device, never layout
  content or tokens (LOG_HYGIENE).
- **Public repo.** Test fixtures use invented names only.
- **Pre-existing, out of scope (separate security task) — fixed in
  v2.14.42.** Permission overrides were cached per uvicorn worker
  (`API_WORKERS=2`): a per-user deny was enforced on roughly half the
  requests until a worker recycled, an admin save on the stale worker could
  overwrite overrides saved on the other, and `user_permissions` was one
  `String(2048)` row. Since v2.14.42 `services/permission_store.py` reloads
  on a stored revision on every request and builds every save from the DB
  row under a lock, and migration `20261022_0105` makes `app_settings.value`
  TEXT. Release v2.14.44 moved the role-list upgrade below
  (`ROLE_PERMISSION_UPGRADES`, `_revision`) into that store: every read
  applies it, the startup load writes it back once, every save stamps it.
  D7 still keeps saves working whichever worker answers.

---

## 14. Rollout and backward compatibility

- **No migration and no backfill.** Every user starts on their role's
  built-in default. The employee desktop default reproduces today's page.
- **Response compatibility.** `/auth/me*` responses become a superset of the
  old shape; `preferences` loses only the new internal key.
- **Same release.** API and web ship together (`staged_deploy.sh stage/swap`,
  per the deploy runbook). A stale open tab keeps the old overview until
  reload and never calls the new routes.
- **Rollback.** Old code ignores `preferences["dashboard_layouts"]` (the old
  preference PATCH copies the dict, so it survives), the `dashboard_default:*`
  rows and the `preview_limit` query. Nothing to undo.
- **Role changes** keep customised layouts and offer the new default (D22).
- **Pi scan station** is not affected (the kiosk never shows the overview).
- **Request load** on the overview falls from about 52 polled requests a
  minute to about 7.5, and the per-event reports reload is gone (§9.4), which
  eases the per-user rate limit.

---

## 15. Open questions for the owner

Each has a recommended answer; the build proceeds on the recommendation unless
the owner says otherwise.

1. **Time widgets for the office roles.** Geschäftsführung, Buchhaltung and
   Planung hold neither `time:clock` nor `time:view_own` by default, so „Mein
   Status“ and „Urlaub“ are hidden for them, though they see the status card
   today (the server does not check `time:clock` on `/time/clock-in`, and the
   Zeit page is open to all).
   *Recommendation:* add `time:clock` and `time:view_own` to those three roles'
   defaults in `PERMISSIONS_BY_ROLE` (one line each, part A1; roles an admin
   has customised in the Rechte matrix keep their saved set and need the two
   ticks there). Server enforcement of `time:clock` is a separate hardening
   task, because it also changes the Zeit page.
2. **„Mein Einsatz“: personal or team?** v1 shows the user's own schedule
   (D21). A planner might expect the team's day.
   *Recommendation:* personal in v1; a separate „Team-Einsatz“ widget gated on
   `planning:manage` later if planners ask (it needs `/planning/week`, the
   heaviest call on the page).
3. **Werkstatt widgets for every role?** Werkstatt reads need only a login, as
   the nav does, so every role may add Lager-Kennzahlen and Nachbestellen.
   *Recommendation:* keep them open, matching the nav and the server. Gating
   would be a `requires` entry per widget.
4. **Edit other device sizes?** v1 edits only the layout of the device you are
   holding. A device switch in the user editor ("set up my phone from the
   desktop") reuses the admin preview frame.
   *Recommendation:* not in v1; it is a small follow-up if users ask.
5. **iPad Pro in landscape.** By the width rule an iPad Pro 13" is tablet in
   portrait (1024 px) and desktop in landscape (1366 px), so its dashboard
   changes on rotation.
   *Recommendation:* accept it, as decided; the alternative (coarse-pointer
   screens ≥ 1280 px count as tablet) is a one-line change in
   `useDashboardDevice` if it bothers anyone.

---

## 16. Review log (revision 2)

Adopted from the reviews:

- Hidden widgets survive saves via the server-side merge (§3.3), and user PUTs
  accept unavailable ids (D7) — the old strict 422 made drift unrecoverable.
- Immutable JSON write pattern, ISO-string `updated_at`, multi-device and
  Postgres lock tests (§4.1, §12).
- `POST /auth/me/mfa/disable` joins the `UserMeOut` rule; W2 owns
  `TwoFactorSection.tsx`.
- No `dashboardRevision`; `overview` joins `TASK_EVENTS_ONLY_VIEWS`; reports no
  longer reload on events (D23).
- `planning_today` is personal, from context tasks (D21, Q2).
- Werkstatt previews get `preview_limit` (D15).
- Grid columns from the device, 3 on desktop, `grid-auto-flow: row`, admin
  preview frames, container queries inside widgets, CSS file per group (§9.6).
- Per-widget size table and per-device hint (§1.1).
- P0 skeleton phase; lazy widgets and editor; module-level SWR store cleared
  at session end; 403 handling; localStorage cold start.
- Edit mode: bottom bar hidden, sticky toolbar, in-memory draft restore,
  dnd-kit sensor configuration, reset semantics, freeze test.
- `absent-today` minimised and one row per user.
- `my_vacation` balance from `/time/current`; `default_sizes` in `DashboardOut`;
  shortcut settings semantics; 422 detail contract; catalog parity pytest;
  explicit reports cleanup list; Schaltplan handoff with peek/clear and expiry.

Rejected or changed, with the reason:

- **A 4th desktop column** (≥ 1360 px content): dropped. It made one desktop
  layout look different on a 1440 and a 1920 screen and left holes; 3 is
  within the owner's "3–4".
- **Clearing layouts on a role change**: rejected; it silently destroys
  personal work. D22 keeps them and offers the new default instead.
- **Confirm before navigating away from a dirty draft**: replaced by an
  in-memory draft restore, because navigation runs through the sidebar,
  drawer and bottom bar, none of which the host controls.
- **Reading `/werkstatt/reorder/suggestions` and `/werkstatt/on-site` at M/L**:
  rejected in favour of `preview_limit`, which keeps one shared request.
- **Hiding a 403 widget outright**: it would leave a hole in the grid; the
  frame shows „Keine Berechtigung.“ and the host refetches the layouts once.
- **`PointerSensor` + `TouchSensor`**: both would react to touch; the contract
  uses `MouseSensor` + `TouchSensor` + `KeyboardSensor`.
- **"jsdom still gives desktop"**: with the two-query rule the global jsdom
  stub yields `mobile`; tests stub `matchMedia` per query.
- **„Übernehmen von…“ in the admin tab**: deferred; not needed for the
  owner's decisions.
- **Fixing the per-worker permission cache here**: out of scope; recorded in
  §13 as a separate security task.
