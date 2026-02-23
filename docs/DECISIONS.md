# Architecture Decision Records

## 2026-02-17 - Monorepo + FastAPI/React + Docker Compose
- Status: accepted
- Decision: Use monorepo structure with `apps/api` (FastAPI + SQLAlchemy + Alembic), `apps/web` (React + Vite), `docker-compose.yml` orchestration.
- Tradeoffs:
  - Pros: single command bring-up, easy local self-hosting, clear separation between API and UI.
  - Cons: more container moving parts than single-binary alternatives.

## 2026-02-17 - RBAC via role-permission templates enforced server-side
- Status: accepted
- Decision: Define `admin/ceo/accountant/planning/employee` roles and permission matrix in API code. Enforce with dependency guards (`require_permission`) and project-access checks.
- Tradeoffs:
  - Pros: simple, explicit, auditable.
  - Cons: less dynamic than policy-engine approach.

## 2026-02-17 - Encrypted file storage and encrypted backups
- Status: accepted
- Decision: Encrypt uploaded file payloads using Fernet before persistence. Backups are encrypted with OpenSSL AES-256 + PBKDF2.
- Tradeoffs:
  - Pros: data at rest protected even if raw files are exfiltrated.
  - Cons: key/passphrase management responsibility stays with operator.

## 2026-02-17 - Optional Telegram integration with local stub fallback
- Status: accepted
- Decision: Construction report can trigger Telegram send if local credentials are configured; otherwise API returns stub mode.
- Tradeoffs:
  - Pros: no hard dependency on external config for MVP workflows.
  - Cons: no message delivery guarantee without configured bot.

## 2026-02-17 - Construction report payload and PDF layout aligned to legacy Telegram bot
- Status: accepted
- Decision: Reuse the legacy Telegram report field model (customer/project/workers/materials/extras/office notes) and generate PDF artifacts in the API before encrypted storage.
- Tradeoffs:
  - Pros: continuity with existing reporting process and printable outputs.
  - Cons: larger form surface area and more parsing/validation complexity in web payload mapping.

## 2026-02-17 - Docker test runner rebuild + SQLite-for-tests enforcement
- Status: accepted
- Decision: Docker test execution now rebuilds API image and tests force SQLite via env override to prevent polluting Postgres runtime data.
- Tradeoffs:
  - Pros: deterministic tests, avoids migration/runtime conflicts after test runs.
  - Cons: slightly longer Docker-based test cycle due image rebuild.

## 2026-02-17 - Time-tracking UX uses open-shift status endpoint + statutory break deduction
- Status: accepted
- Decision: Add `/time/current` and open-shift break endpoints, allow clock-out without explicit ID, and compute net time with German statutory minimum break deduction (`>6h=30m`, `>9h=45m`).
- Tradeoffs:
  - Pros: user-facing flow matches expected punch-clock behavior and reduces manual mistakes.
  - Cons: implicit break deduction can differ from explicitly entered breaks; must be explained in UI/export.

## 2026-02-17 - Construction report supports multipart uploads with encrypted image attachments
- Status: accepted
- Decision: Keep JSON report path for compatibility and add multipart path for report images. Persist images as encrypted attachments and include logo/photos in generated PDFs.
- Tradeoffs:
  - Pros: improves legacy parity and field usability without breaking existing API clients/tests.
  - Cons: endpoint handling is more complex due dual content-type parsing.

## 2026-02-18 - Compose health-gated startup + restart policy for local reliability
- Status: accepted
- Decision: Add `restart: unless-stopped` to all services, add healthchecks for `api` and `web`, and make `web`/`caddy` depend on upstream health rather than only container start order.
- Tradeoffs:
  - Pros: fewer transient "app is down" windows after restarts or service recreation; clearer operator visibility in `docker compose ps`.
  - Cons: slightly longer startup due healthcheck gating.

## 2026-02-18 - Restore smoke test verifies DB and uploads integrity, not only script completion
- Status: accepted
- Decision: Upgrade `scripts/restore_smoke_test.sh` to insert marker rows/files, back up, delete markers, restore, verify markers return, and validate HTTPS API health after restore.
- Tradeoffs:
  - Pros: catches real backup/restore regressions and validates full operational recovery.
  - Cons: smoke test is slower and temporarily mutates runtime data (cleaned up at end).

## 2026-02-18 - Host-level trust script for Caddy local CA on macOS
- Status: accepted
- Decision: Add `scripts/trust_caddy_root_macos.sh` to export Caddy local root CA and install it into macOS login keychain for Safari-compatible HTTPS on `https://localhost`.
- Tradeoffs:
  - Pros: removes recurring Safari TLS errors in local self-hosting setup.
  - Cons: macOS-specific step and local trust-store mutation required.

## 2026-02-18 - LAN demo entrypoint served on HTTP for non-localhost hosts
- Status: accepted
- Decision: Keep HTTPS for `localhost` and add a generic HTTP site block so other devices on the same LAN can access the app via `http://<LAN-IP>` without local certificate installation.
- Tradeoffs:
  - Pros: fastest way to let colleagues test on phones/tablets/laptops on local network.
  - Cons: no TLS on LAN demo path; must be limited to trusted/internal test usage.

## 2026-02-18 - Chat threads are global with optional project linkage
- Status: accepted
- Decision: Introduce global chat endpoints (`/threads`) and allow threads without `project_id`; keep project-linked threads optional for context filtering.
- Tradeoffs:
  - Pros: messaging no longer blocked by project context and supports company-wide communication.
  - Cons: requires explicit access checks for project-linked threads and slightly more complex visibility logic.

## 2026-02-18 - Weekly planning uses calendar data endpoint
- Status: accepted
- Decision: Add `GET /planning/week/{week_start}` returning day buckets for the selected week and assign tasks with explicit `due_date` per day.
- Tradeoffs:
  - Pros: planning UI can render true week calendar columns with daily task lists.
  - Cons: stronger dependency on correct `week_start`/`due_date` consistency.

## 2026-02-18 - Project files expose WebDAV endpoint for OS integration
- Status: accepted
- Decision: Add WebDAV-compatible endpoints under `/api/dav/projects/{project_id}` with Basic Auth (app email/password) for Finder/Explorer-style mounts.
- Tradeoffs:
  - Pros: practical SharePoint-like access path without external SaaS.
  - Cons: Basic Auth requires careful credential handling and is not suitable over untrusted HTTP networks.

## 2026-02-18 - Split navigation into global modules + project context modules
- Status: superseded
- Decision: Use separate global views (`Overview`, `Weekly Planning`, `Chat`, `Time`, `Admin`) and open project-specific content only after selecting a project from the sidebar, with project tabs limited to project-scoped modules (`tasks`, `tickets`, `files`, `construction`).
- Tradeoffs:
  - Pros: clearer mental model, weekly planning no longer hidden inside a project tab, and project switching is consistent from one place.
  - Cons: requires extra state transitions between overview and project context views.
- Superseded by: `2026-02-18 - Construction report is a global module with explicit project target` (construction moved out of project tabs).

## 2026-02-18 - Online file explorer UX layered on top of project attachments
- Status: accepted
- Decision: Keep existing encrypted attachment backend and WebDAV integration, and add a browser-native file explorer style UI (search + metadata + quick open/download) for mobile/on-the-go file access.
- Tradeoffs:
  - Pros: immediate usability gain without backend schema changes.
  - Cons: no folder hierarchy yet; still flat attachment listing.

## 2026-02-18 - Construction report is a global module with explicit project target
- Status: accepted
- Decision: Move construction report UI out of project tabs into a global main navigation section. Report form requires selecting the target project and writes report artifacts through the existing project-scoped API endpoint.
- Tradeoffs:
  - Pros: report flow is easier to find and use without pre-entering a project tab.
  - Cons: requires explicit project selection to avoid misfiling reports.

## 2026-02-18 - WebDAV information moved to contextual hover settings bubble in files explorer
- Status: accepted
- Decision: Keep WebDAV integration but remove dedicated full card in project files view; expose mount URL/instructions from a compact cog-triggered hover/focus bubble in the file explorer header.
- Tradeoffs:
  - Pros: prevents layout collisions and keeps file explorer primary on small screens.
  - Cons: WebDAV instructions are less visible until user interacts with the control.

## 2026-02-18 - Projects use user-defined project numbers with editable customer master data
- Status: accepted
- Decision: Keep internal numeric PK (`projects.id`) for relational integrity, and add business-facing unique `project_number` plus editable customer master fields (`customer_name/address/contact/email/phone`) on project create/update APIs and UI.
- Tradeoffs:
  - Pros: supports external numbering systems without risky FK migrations; improves operational context per project.
  - Cons: introduces dual identifiers (internal id + business number) that must be clearly separated in UI/API usage.

## 2026-02-18 - Project create/edit moved to modal flow
- Status: accepted
- Decision: Replace inline sidebar creation form with an on-screen modal (`Create new`) that captures full project/customer fields and reuse the same modal for project edits.
- Tradeoffs:
  - Pros: cleaner sidebar, consistent full-field editing experience, better mobile focus.
  - Cons: extra click and modal state management complexity.

## 2026-02-18 - Tasks support multi-assignee ownership with assignment table
- Status: accepted
- Decision: Keep existing `tasks.assignee_id` as compatibility field and introduce `task_assignments` for true multi-assignee behavior. API now returns `assignee_ids` and planning/task create flows accept multiple assignees.
- Tradeoffs:
  - Pros: one task can be assigned to multiple employees without breaking existing integrations that still read `assignee_id`.
  - Cons: dual representation requires synchronization logic and migration backfill.

## 2026-02-18 - Employee task completion is constrained server-side
- Status: accepted
- Decision: Allow assigned employees to update only task status to `done`; deny non-assigned users and deny non-status edits for employees. Managers (`admin/ceo/planning`) retain full task edit rights.
- Tradeoffs:
  - Pros: enforces least-privilege completion workflow while preserving planner control.
  - Cons: stricter API behavior can reject previously-permitted employee edits beyond completion.

## 2026-02-18 - Weekly planning view is calendar-only; task creation moved to header modal
- Status: accepted
- Decision: Remove inline creation form from weekly planning page body and use a single "Add task" action near the page header that opens a modal with project/day/multi-assignee fields.
- Tradeoffs:
  - Pros: cleaner planning surface focused on schedule visibility, better mobile readability.
  - Cons: task creation is one extra step via modal.

## 2026-02-19 - Attachment responses use RFC-compliant Content-Disposition + dedicated preview route
- Status: accepted
- Decision: Replace raw filename header injection with safe `Content-Disposition` generation (`filename` ASCII fallback + `filename*` UTF-8) and add `GET /files/{id}/preview` for inline rendering.
- Tradeoffs:
  - Pros: prevents Unicode header encoding crashes (500s) and enables browser preview flows without forced downloads.
  - Cons: additional endpoint surface and UI branching by content type.

## 2026-02-19 - Add built-in global Wiki module for local technical guides
- Status: accepted
- Decision: Introduce `wiki_pages` table and `/wiki/pages` CRUD endpoints; allow all authenticated users to read and restrict create/update/delete to `admin/ceo/planning`.
- Tradeoffs:
  - Pros: keeps operational knowledge private/on-prem and searchable in the same app.
  - Cons: initial version is plain text (no rich Markdown renderer/version history yet).

## 2026-02-19 - Construction report allows project-linked or general-folder storage
- Status: accepted
- Decision: Keep existing project-scoped construction-report endpoint and add a global endpoint (`/construction-reports`) that permits reports without a project number; store these rows/files with `project_id = NULL` and expose them through `/construction-reports/files`.
- Tradeoffs:
  - Pros: supports urgent ad-hoc reports when no project exists yet, while preserving structured project filing when project context is known.
  - Cons: introduces two report paths and requires explicit permission checks for non-project report artifacts.

## 2026-02-19 - Construction report form auto-hydrates customer data from selected project
- Status: accepted
- Decision: When a project is selected in UI/API report flow, default missing report customer/project fields from project master data (`customer_*`, `project_name`, `project_number`) and keep manual override possible in the UI.
- Tradeoffs:
  - Pros: reduces duplicate data entry and improves consistency between project records and generated reports.
  - Cons: requires careful UX/state handling to avoid unintentionally overwriting manual edits.

## 2026-02-19 - Project file upload moved to compact modal trigger in file explorer
- Status: accepted
- Decision: Remove the dedicated upload form card from project files and use a compact upload icon in the explorer header that opens an upload modal.
- Tradeoffs:
  - Pros: better mobile/desktop space usage and keeps file explorer as the primary surface.
  - Cons: upload action is one extra click and less immediately visible than an always-open form.

## 2026-02-19 - Sidebar footer holds language switch + current user identity block
- Status: accepted
- Decision: Move language toggle to a compact left-bottom footer control and add a lightweight signed-in user identity block (avatar initials + name/role).
- Tradeoffs:
  - Pros: reduces top-level sidebar clutter and gives a clearer account context at a stable location.
  - Cons: language toggle is less prominent for first-time users.

## 2026-02-19 - Profile avatar opens settings; admin center is embedded there for admins
- Status: accepted
- Decision: Add a dedicated `Profile & settings` view opened from the sidebar user avatar block and embed user administration controls in that view for admin users.
- Tradeoffs:
  - Pros: user/account actions are discoverable from profile entrypoint; admin controls remain available without a separate primary-nav slot.
  - Cons: one additional click for admins compared to direct top-nav entry.

## 2026-02-19 - Sidebar/project active highlighting is mutually exclusive
- Status: accepted
- Decision: Keep only one active highlight in the left rail by showing project-item active state only when `Project` view is selected.
- Tradeoffs:
  - Pros: clearer navigation context and reduced visual ambiguity.
  - Cons: selected project is less visually persistent while browsing other modules.

## 2026-02-19 - Desktop shell uses independent sidebar/content scrolling
- Status: accepted
- Decision: On desktop, set app shell to fixed viewport height and make sidebar and main content separate vertical scroll containers.
- Tradeoffs:
  - Pros: each pane remains usable when the other overflows; supports long project lists and long work surfaces simultaneously.
  - Cons: introduces dual scrollbars which some users may need to adapt to.

## 2026-02-19 - File preview uses separate browser context, not in-page modal
- Status: accepted
- Decision: In the project files explorer, render preview actions as links to `/api/files/{id}/preview` opened in a new tab/window instead of in-app popup preview modals.
- Tradeoffs:
  - Pros: aligns with operator expectation for side-by-side viewing and avoids UI overlay collisions.
  - Cons: additional browser tabs/windows can accumulate during heavy browsing.

## 2026-02-19 - Weekly planning navigation standardized to ISO week controls
- Status: accepted
- Decision: Add visible week number (`KW/CW`) and arrow-based week navigation; normalize selected dates to Monday start.
- Tradeoffs:
  - Pros: predictable planning flow for week-based operations and fewer off-week input errors.
  - Cons: date normalization can differ from ad-hoc single-day expectations if users pick non-Monday dates.

## 2026-02-19 - Sidebar footer control row unifies language and logout actions
- Status: accepted
- Decision: Move logout into the same compact row as language selectors and relocate live date/time below the user card in sidebar footer.
- Tradeoffs:
  - Pros: tighter account control cluster and cleaner top workspace header.
  - Cons: logout is less visually prominent than a full-width action button.

## 2026-02-19 - Compact sidebar controls use fixed equal-height sizing
- Status: accepted
- Decision: Standardize compact footer control dimensions so `DE`, `EN`, and `Sign out` render with equal control height and same compact font size; center the project plus glyph with explicit flex centering and keep title-row alignment on all breakpoints.
- Tradeoffs:
  - Pros: cleaner visual rhythm and fewer alignment regressions across mobile/desktop.

## 2026-02-23 - Project classes are template-driven and assigned per project
- Status: accepted
- Decision: Introduce reusable project-class templates (materials, tools, and default task templates), importable via admin CSV template, with many-to-many assignment to projects.
- Tradeoffs:
  - Pros: consistent project bootstrap, reusable standard task/material definitions, and faster planning setup.
  - Cons: adds template lifecycle governance and extra schema/API complexity (assignment and class-aware task creation).

## 2026-02-22 - User deletion is soft-delete only; admin user actions moved into contextual menu
- Status: accepted
- Decision: In Admin Center, user-level actions (`send invite`, `send password reset`, `delete user`) are grouped into a per-user 3-dot contextual menu. `Delete user` sets `users.is_active=false` (soft delete) and invalidates open action tokens instead of removing DB rows.
- Tradeoffs:
  - Pros: cleaner admin table UX, preserves historical references (time entries, audit, assignments), and blocks deleted users from login/reset/invite.
  - Cons: inactive users remain visible in admin data and require clear inactive labeling.

## 2026-02-22 - Outbound auth/admin emails use fixed sender identity
- Status: accepted
- Decision: Enforce `technik@smpl-energy.de` as the SMTP `From` address for invite/reset emails across environments.
- Tradeoffs:
  - Pros: consistent operational sender identity and easier mailbox/rule management.
  - Cons: reduced per-environment flexibility for sender branding.

## 2026-02-22 - Self-service profile updates + tokenized invite/reset flows
- Status: accepted
- Decision:
  - Add authenticated profile update endpoint (`PATCH /auth/me`) for name/email/password changes, with current-password verification required for sensitive changes.
  - Add one-time token table (`user_action_tokens`) and admin-driven invite/reset link flows with expiry and single-use semantics.
  - Keep SMTP optional; when SMTP is not configured, backend still generates local links for controlled/manual delivery.
- Tradeoffs:
  - Pros: removes manual DB intervention for credential updates, supports secure onboarding/recovery, preserves self-hosted/no-SaaS model.
  - Cons: invite/reset completion UI pages are not yet first-class frontend routes, and operators still need a local SMTP service for fully automatic email delivery.

## 2026-02-22 - Weekday recurrence UX switched to Mon-Fri checkbox model
- Status: accepted
- Decision: Replace single weekday dropdown with Monday-Friday multi-checkbox recurrence selection in school-absence forms; backend compatibility is preserved by creating one recurring entry per selected weekday.
- Tradeoffs:
  - Pros: matches real-world apprentice school scheduling and avoids repetitive single-day submissions.
  - Cons: recurring selections produce multiple rows internally, so list output may look more verbose.

## 2026-02-21 - Time-tracking day/week totals must use local timezone boundaries
- Status: accepted
- Decision: Compute daily/weekly time-tracking periods in configured app timezone (`APP_TIMEZONE`, default `Europe/Berlin`) and convert those ranges to UTC for overlap queries; do not derive periods from raw UTC calendar days.
- Tradeoffs:
  - Pros: correct overnight-shift totals/gauges for local operations and legal-hour interpretation.
  - Cons: introduces timezone configuration dependency and conversion complexity in reporting endpoints.

## 2026-02-21 - Work-hour gauge displays daily net hours only
- Status: accepted
- Decision: Frontend gauge source is `daily_net_hours` in both overview and time-tracking views, including during open shifts.
- Tradeoffs:
  - Pros: gauge consistently reflects progress against required daily hours and no longer shows full cross-day shift accumulation.
  - Cons: separate “net shift hours” metric remains needed when users want whole-shift totals.
  - Cons: reduced flexibility for variable button-label lengths in future localizations.

## 2026-02-19 - User avatars stored as encrypted attachments-by-path on user profile
- Status: accepted
- Decision: Add dedicated user avatar metadata fields on `users` and expose profile endpoints for avatar upload (`POST /users/me/avatar`) and retrieval (`GET /users/{id}/avatar`), storing avatar binaries through the same encrypted file service used for other file payloads.
- Tradeoffs:
  - Pros: profile photos remain private-by-default and encrypted at rest; avoids external image hosting dependencies.
  - Cons: extra profile-specific storage lifecycle handling (old avatar file cleanup, cache busting) is needed in app logic.

## 2026-02-19 - Avatar crop performed client-side before upload
- Status: accepted
- Decision: Implement image crop in frontend profile settings (zoom + X/Y framing) and upload already-cropped output rather than raw originals.
- Tradeoffs:
  - Pros: predictable avatar dimensions and lower server-side image-processing complexity.
  - Cons: crop UX depends on browser capabilities and currently uses slider controls instead of drag gestures.

## 2026-02-20 - Avatar edit trigger moved to hover overlay + drag-based framing
- Status: accepted
- Decision: Keep client-side avatar cropping but move the entrypoint to a transparent hover overlay on the profile avatar and replace X/Y sliders with direct pointer drag positioning plus zoom slider.
- Tradeoffs:
  - Pros: behavior matches common social/profile UX patterns and is faster on touch devices.
  - Cons: drag precision depends on pointer handling and requires additional stage-metric calculations.

## 2026-02-20 - Chat thread creation moved into threads header action
- Status: accepted
- Decision: Remove dedicated "create thread" card and place a compact plus action in the thread-list header, opening a modal for thread creation.
- Tradeoffs:
  - Pros: thread list becomes the primary surface and vertical space is used more efficiently.
  - Cons: creation action is less explicit for first-time users compared to an always-visible form.

## 2026-02-22 - Admin DB backup export uses uploaded key-file encryption
- Status: accepted
- Decision:
  - Add admin-only endpoint `POST /api/admin/backups/database` that generates a PostgreSQL dump and encrypts it before download.
  - Encryption key is derived from uploaded key-file content using PBKDF2; payload encryption uses AES-GCM.
  - Keep CLI full backup/restore scripts unchanged for now; this endpoint is focused on in-app DB backup export.
- Tradeoffs:
  - Pros: backup artifacts are not usable without the matching key file; no plaintext DB backup leaves the API process.
  - Cons: operator must securely manage key files and there is no in-app restore-upload flow yet.

## 2026-02-22 - Default new-user role is employee at API boundary
- Status: accepted
- Decision:
  - Set default role for `UserCreate` to `employee`.
  - Apply backend fallback to `employee` when role is blank/missing in user creation or invite creation paths.
- Tradeoffs:
  - Pros: safer least-privilege default and fewer accidental privileged accounts.
  - Cons: admins creating non-employee users must explicitly select role each time.

## 2026-02-22 - Report/image attachments are auto-routed into canonical folders
- Status: accepted
- Decision:
  - Construction report files are auto-routed to fixed folders:
    - generated report PDFs -> `Berichte`,
    - uploaded report pictures -> `Bilder`.
  - Project file uploads with empty folder input are auto-routed by type:
    - images -> `Bilder`,
    - PDFs -> `Berichte`.
- Tradeoffs:
  - Pros: consistent folder hygiene and less manual filing effort.
  - Cons: users must override folder explicitly for edge-case filing patterns.

## 2026-02-22 - WebDAV root split into active projects + archive/general collections
- Status: accepted
- Decision:
  - Add dedicated WebDAV root collections:
    - `General Projects` (`/api/dav/projects/general-projects/`) for no-project reports,
    - `Archive` (`/api/dav/projects/archive/`) for archived projects.
  - Keep active projects listed directly under `/api/dav/projects/`.
- Tradeoffs:
  - Pros: cleaner operator navigation and clearer lifecycle separation for archived vs active data.
  - Cons: additional WebDAV route surface and compatibility handling for clients expecting a flat root.

## 2026-02-20 - Chat unread tracking uses per-user read-state table
- Status: accepted
- Decision: Add `chat_thread_reads` (`thread_id`, `user_id`, `last_read_message_id`, `last_read_at`) and compute unread counts server-side as messages newer than last read (excluding own messages).
- Tradeoffs:
  - Pros: unread counters remain correct across devices/sessions and cannot be spoofed by frontend-only state.
  - Cons: thread listing incurs additional per-thread DB work without pagination/aggregation optimization.

## 2026-02-20 - Thread metadata editing restricted to creator or chat-manager roles
- Status: accepted
- Decision: Extend `chat_threads` with `created_by` and icon metadata; allow thread rename/icon updates only for the creator or roles with `chat:manage`.
- Tradeoffs:
  - Pros: ownership model is clear and prevents arbitrary thread tampering by non-owners.
  - Cons: legacy threads without explicit creator require manager intervention for edits.

## 2026-02-20 - Chat composer uses explicit messenger controls and text-driven send state
- Status: accepted
- Decision: Keep chat composer as a three-control row (`+` attachment, message input, arrow send) and gate send-button active style/state by non-empty message text.
- Tradeoffs:
  - Pros: matches requested messenger interaction pattern and gives immediate visual send readiness.
  - Cons: gray send state while attachment-only sending is allowed may be non-obvious without the selected-file visual cue.

## 2026-02-20 - Chat message pane uses fixed-height container with internal history scroll
- Status: accepted
- Decision: Make `chat-panel` fixed-height and delegate overflow to `message-list` so thread window size remains stable while older messages are accessed via inner scroll.
- Tradeoffs:
  - Pros: predictable viewport layout and better long-thread usability.
  - Cons: less vertical flexibility on very short threads where extra empty space is visible.

## 2026-02-20 - Chat auto-follow scroll tracks newest messages unless user is reading history
- Status: accepted
- Decision: Auto-scroll to bottom after sending and while user remains near the bottom; pause follow when user scrolls upward in history.
- Tradeoffs:
  - Pros: keeps latest messages visible during active conversation without constantly forcing scroll jumps.
  - Cons: adds minor state complexity for near-bottom detection in the message list.

## 2026-02-20 - Chat composer uses explicit attachment draft state before send
- Status: accepted
- Decision: Keep selected chat attachment in composer state, show it as a removable draft chip, and allow send with either text or attachment (including attachment-only submits).
- Tradeoffs:
  - Pros: matches messenger-style behavior and reduces send failures from empty-text but valid-file messages.
  - Cons: adds extra composer state/UI controls and edge-case handling for file input synchronization.

## 2026-02-20 - Message bubbles use flex content sizing for cross-browser consistency
- Status: accepted
- Decision: Render message list as vertical flex stack and each bubble as max-content flex column with width caps, replacing grid-based bubble sizing.
- Tradeoffs:
  - Pros: prevents intermittent oversized bubble rendering in browser-specific grid/fit-content behavior.
  - Cons: fewer grid-layout options if future message metadata needs multi-column bubble internals.

## 2026-02-20 - Daily work target is stored per employee and enforced server-side
- Status: accepted
- Decision:
  - Add `users.required_daily_hours` (default `8.0`) as authoritative server-side source for daily work targets.
  - Expose update endpoint `PATCH /api/time/required-hours/{user_id}` limited to `admin` and `ceo`.
  - Extend `/api/time/current` with `daily_net_hours` and `progress_percent_live` so clients can render consistent gauges without duplicating time math.
- Tradeoffs:
  - Pros: keeps target-hour control centralized, auditable, and role-restricted; simplifies consistent UI behavior across overview/time modules.
  - Cons: introduces an additional user-profile field and one more permissioned time-management endpoint.

## 2026-02-20 - Excel import stores unmapped project columns in JSON extra attributes
- Status: accepted
- Decision:
  - Add `projects.extra_attributes` JSON field as a flexible extension point for imported columns that are not part of the typed project model.
  - Implement Excel import tooling (`scripts/import_projects_excel.sh` -> API container script/service) that maps known core fields and preserves all source columns in `extra_attributes`.
  - Use temporary `T...` project numbers only when source rows have no usable project number.
- Tradeoffs:
  - Pros: no data loss during imports from operational spreadsheets; avoids frequent schema churn for ad-hoc columns.
  - Cons: non-standard fields are less queryable than dedicated typed DB columns and need explicit UI if operators should see/edit them easily.

## 2026-02-20 - Canonical project status normalization for Excel imports
- Status: superseded by "Excel project status stored as source vocabulary" (2026-02-20)
- Decision:
  - Normalize imported project status values to the app's canonical set: `active`, `on_hold`, `completed`.
  - Map known German operational statuses from spreadsheet flows (for example `Angebot abgeschickt`, `Kundentermin vereinbart`) to `active`.
  - Keep import note field (`Notiz`) mapped to project note storage (`description`) and surfaced in project UI.
- Tradeoffs:
  - Pros: avoids mixed status vocabularies and keeps filters/forms consistent.
  - Cons: detailed pre-sales micro-states are no longer stored as primary status (they remain available in imported source metadata).

## 2026-02-20 - Sidebar project list uses dedicated scroll region with persistent footer
- Status: accepted
- Decision:
  - Keep sidebar header/nav/user-footer stable and make only the project list scrollable when project count exceeds viewport.
  - Render project rows as `customer | project_number` plus secondary project name for faster scanning.
- Tradeoffs:
  - Pros: prevents overlap with bottom user panel, improves readability with large project sets.
  - Cons: introduces a nested scroll area and one more layout container to maintain across breakpoints.

## 2026-02-20 - Excel project status stored as source vocabulary (supersedes canonical-only normalization)
- Status: accepted
- Decision:
  - Store `Aktueller Status` as-is in `projects.status` (for example `Angebot abgeschickt`, `In Durchführung`, `Rechnung erstellen`) instead of collapsing to `active/on_hold/completed`.
  - Add dedicated project fields:
    - `last_state` (from Excel `Notiz`)
    - `last_status_at` (from Excel `Letzter Status Datum`)
  - Keep status authorization independent from project status labels (RBAC is role/permission based only).
- Tradeoffs:
  - Pros: preserves business-operational granularity from source system and removes information loss during import.
  - Cons: UI filters/forms must support a broader status vocabulary.

## 2026-02-20 - Excel import deduplication and idempotent temporary-number handling
- Status: accepted
- Decision:
  - Import all workbook sheets by default and deduplicate rows using project number first, then fallback identity (`customer`, `name`, `address`) with latest `last_status_at` preference.
  - For rows without project number, reuse existing fallback-identity matches instead of issuing a new `T...` value on every rerun.
  - Skip identity-less rows to avoid noisy duplicate placeholder projects.
- Tradeoffs:
  - Pros: repeat imports become stable (`created=0` after first pass), and multi-table spreadsheet duplicates are collapsed deterministically.
  - Cons: fallback identity matching can merge genuinely distinct records when source data quality is very low.

## 2026-02-21 - Time-period calculations must include shifts overlapping day/week boundaries
- Status: accepted
- Decision:
  - Treat a time entry as part of a day/week period when it overlaps that period (not only when `clock_in` is inside it).
  - Calculate period totals using overlap windows for both work duration and break duration.
  - Keep live gauge behavior anchored to open-shift net hours on the client while a shift is active.
- Tradeoffs:
  - Pros: fixes overnight shift accuracy for daily gauge/timesheet behavior and prevents midnight reset artifacts.
  - Cons: adds overlap-math complexity and extra per-entry break-window calculations.

## 2026-02-21 - Time tracking gauge uses circular wrapped progress
- Status: accepted
- Decision:
  - Replace the linear time-tracking gauge with a circular ring gauge in web UI.
  - Render progress modulo 100% for ring fill while preserving true percentage text and overtime metadata.
  - Track additional complete cycles (`full turns`) when work exceeds required daily hours.
- Tradeoffs:
  - Pros: avoids visual overflow for >100% progress and keeps high-overtime days readable.
  - Cons: modulo rendering can be less intuitive without explicit percentage/turn metadata.

## 2026-02-21 - Project detail keeps origin-aware back navigation
- Status: accepted
- Decision:
  - Persist origin context when entering project detail from `All projects` (`projectBackView = projects_all`).
  - Surface `Back to All Projects` in the project header tool row beside edit controls.
  - Remove duplicated subheader label from the full-list page body and rely on workspace header title.
- Tradeoffs:
  - Pros: faster navigation for list-review workflows and cleaner visual hierarchy.
  - Cons: adds one more navigation context branch to maintain.

## 2026-02-21 - Gauge color stays blue across overtime cycles
- Status: accepted
- Decision:
  - Keep the circular time gauge ring color blue for both <=100% and >100% progress.
  - Preserve wrapped overtime cycle behavior while avoiding semantic color shift on overtime.
- Tradeoffs:
  - Pros: consistent visual language and clearer user expectation from the requested UI behavior.
  - Cons: removes high-contrast overtime warning color in the gauge itself (overtime is still shown numerically).

## 2026-02-21 - Gauge visual fill clamps at 100% once target is reached
- Status: accepted
- Decision:
  - Keep circular gauge fill at 100% for `progressPercent >= 100`.
  - Preserve overtime information in numeric metadata instead of reducing ring fill after crossing target.
- Tradeoffs:
  - Pros: users immediately see target completion and avoid confusing partial-fill appearance after reaching required hours.
  - Cons: overtime progress is no longer represented by reduced ring-cycle fill in the same visual channel.

## 2026-02-21 - Time tracking required-hours editing belongs to Admin Center, not Time page
- Status: accepted
- Decision:
  - Remove required daily hours editor from `Time Tracking` view.
  - Manage employee required daily hours in `Admin Center` surfaces (admin table and dedicated required-hours card), while keeping backend authorization (`admin`/`ceo`) unchanged.
- Tradeoffs:
  - Pros: cleaner time page focused on tracking; aligns permission-sensitive settings with admin context.
  - Cons: one extra navigation step before adjusting required hours.

## 2026-02-21 - Time tracking adds monthly half-gauge + per-week linear gauges for current month
- Status: accepted
- Decision:
  - Keep daily progress in circular gauge.
  - Add monthly overview as half-circle gauge and weekly progress rows (`KW` + date range) as linear gauges.
  - Weekly totals are computed via existing `/time/timesheet?period=weekly&day=...` API per week range.
- Tradeoffs:
  - Pros: clearer day/week/month hierarchy without backend schema changes.
  - Cons: frontend performs multiple weekly timesheet calls for monthly rendering.

## 2026-02-21 - Keep a single Admin Center surface for required-hours editing
- Status: accepted
- Decision:
  - Remove duplicate required-hours card from profile page.
  - Keep required-hours editing embedded in the original Admin Center user table only.
- Tradeoffs:
  - Pros: less UI duplication and less operator confusion.
  - Cons: hours adjustment remains inside a dense admin table layout.

## 2026-02-21 - Weekly month view shows full intersecting weeks (Mon-Sun)
- Status: accepted
- Decision:
  - For month time overview, include all weeks intersecting the month and display full Monday-Sunday date ranges.
  - Use full-week required-hours baseline (weekday count across entire week) instead of partial in-month weekdays.
- Tradeoffs:
  - Pros: consistent weekly interpretation and easier payroll-style checking.
  - Cons: first/last displayed week includes days outside the selected month.

## 2026-02-21 - Monthly time overview uses explicit month cursor navigation in UI
- Status: accepted
- Decision:
  - Introduce a selected-month cursor with previous/next controls above the monthly gauge.
  - Compute week rows and totals from the selected month instead of always binding to system current month.
- Tradeoffs:
  - Pros: predictable retrospective review of monthly hours.
  - Cons: more frontend state and additional refresh triggers when month changes.

## 2026-02-21 - Current-shift details shown in contextual popover anchored to current-time label
- Status: accepted
- Decision:
  - Keep `Current shift` card body focused on controls and gauges.
  - Move detailed shift telemetry + legal-break explanation into a contextual popover triggered by hover/click on current-time label.
- Tradeoffs:
  - Pros: cleaner primary layout while preserving access to detailed data.
  - Cons: one extra interaction needed to see shift diagnostics.

## 2026-02-21 - Time-action controls are state-driven and non-redundant
- Status: accepted
- Decision:
  - Show one clock control at a time (`clock in` xor `clock out`).
  - Show one break control at a time (`break start` xor `break end`) only while a shift is open.
- Tradeoffs:
  - Pros: less visual noise and fewer disabled controls.
  - Cons: users cannot see all possible actions simultaneously.

## 2026-02-21 - Monthly required-hours baseline is month-bounded while weekly rows stay full-week
- Status: accepted
- Decision:
  - Keep weekly time rows as full Monday-Sunday weeks (including weeks intersecting month edges).
  - Compute monthly required hours independently from week rows, using only weekdays that fall inside the selected calendar month.
- Tradeoffs:
  - Pros: monthly requirement is no longer inflated when month starts/ends midweek.
  - Cons: monthly required baseline and edge weekly required values intentionally use different scopes (month-only vs full-week).

## 2026-02-21 - Required daily hours are configurable for all roles
- Status: accepted
- Decision:
  - Remove backend restriction that allowed required-hours updates only for users with role `employee`.
  - Show required-hours input/save controls for all users in Admin tables.
- Tradeoffs:
  - Pros: supports managerial/custom schedules for admin/ceo/accountant/planning users as requested.
  - Cons: increases need for admin discipline to avoid misconfigured targets on non-field roles.

## 2026-02-21 - Shift-info popover opens away from sidebar
- Status: accepted
- Decision:
  - Anchor current-shift info popover from the left edge of its trigger so it expands into content space rather than toward sidebar.
- Tradeoffs:
  - Pros: avoids visual collision with left navigation.
  - Cons: on very narrow screens, popover width still needs responsive clamping.

## 2026-02-21 - WebDAV root must accept trailing slash for Finder compatibility
- Status: accepted
- Decision:
  - Serve WebDAV project root on both route variants:
    - `/api/dav/projects/{project_id}`
    - `/api/dav/projects/{project_id}/`
  - Keep behavior identical for `OPTIONS` and `PROPFIND` across both.
- Tradeoffs:
  - Pros: aligns with macOS Finder/WebDAV client URL normalization and avoids `400` on mount/list operations.
  - Cons: adds duplicate route registration to maintain.

## 2026-02-21 - WebDAV tooltip prioritizes macOS Finder flow + LAN fallback guidance
- Status: accepted
- Decision:
  - In project-files tooltip, show URL with trailing slash and explicit Finder steps (`Cmd+K`).
  - Include LAN HTTP fallback pattern for devices where local HTTPS trust is not established.
- Tradeoffs:
  - Pros: practical onboarding for non-technical test users and fewer mount failures.
  - Cons: LAN HTTP guidance must remain clearly scoped to trusted local networks only.

## 2026-02-21 - WebDAV all-projects mount path exposed at collection root
- Status: accepted
- Decision:
  - Add WebDAV collection root handlers on `/api/dav/projects` and `/api/dav/projects/`.
  - Return project sub-collections in `PROPFIND` depth-1 response, each pointing to existing per-project WebDAV URLs.
  - Restrict listed projects to user-visible scope (admin-like roles: all; employees: membership-based).
- Tradeoffs:
  - Pros: one Finder mount gives access to all allowed projects; significantly simpler operator workflow.
  - Cons: large project sets can produce bigger WebDAV multistatus responses on root listing.

## 2026-02-21 - WebDAV URLs in tooltip are copy-first actions
- Status: accepted
- Decision:
  - Add explicit copy buttons beside each WebDAV URL (all-projects and current-project) in the tooltip.
  - Use browser clipboard API with textarea fallback for wider compatibility.
  - Reuse existing top-level notice/error banner for copy feedback instead of adding extra transient UI state.
- Tradeoffs:
  - Pros: faster onboarding and fewer URL entry mistakes in Finder/WebDAV clients.
  - Cons: no per-button inline “copied” indicator yet.

## 2026-02-21 - Weekly planning task creation uses same data model as project task creation
- Status: accepted
- Decision:
  - Align weekly planning task modal fields with project task creation fields (title, info, materials, optional storage box, due date, start time, multi-assignee search).
  - Keep weekly task persistence through existing `/planning/week/{week_start}` endpoint with `TaskCreate` payload.
- Tradeoffs:
  - Pros: one consistent task creation mental model across app sections.
  - Cons: weekly modal is larger and denser than the prior minimal dialog.

## 2026-02-21 - Weekly planning project selection is search-first with optional inline project creation
- Status: accepted
- Decision:
  - Replace project dropdown in weekly modal with search/select behavior (number/customer/name).
  - If no project matches and caller has project-create permissions, allow lightweight project creation directly from task modal and immediately bind the new task to it.
- Tradeoffs:
  - Pros: faster dispatch for ad-hoc work and reduced context switching.
  - Cons: introduces potential temporary/incomplete project records if operators overuse quick-create.

## 2026-02-21 - Project task header shows embedded address map panel
- Status: accepted
- Decision:
  - Add a compact right-aligned map panel in the selected project summary (tasks tab), driven by project customer address.
  - Include direct “open in maps” link and fallback text when no address exists.
- Tradeoffs:
  - Pros: field teams can verify location context without leaving task view.
  - Cons: embedded map depends on internet map provider and is not fully offline/self-hosted yet.

## 2026-02-21 - Weekly planning accepts cross-week due dates and routes tasks to computed week
- Status: accepted
- Decision:
  - Replace fixed “selected week day” dropdown with free due-date input in weekly task modal.
  - Compute task week bucket from selected due date (`Monday` normalization) and write to corresponding planning-week endpoint.
  - After save, jump planner view to the computed week to reduce “task saved but not visible” confusion.
- Tradeoffs:
  - Pros: supports real dispatch workflows that plan beyond currently visible week.
  - Cons: planner view may jump to a different week than the operator was browsing.

## 2026-02-21 - Calendar export is client-generated `.ics` and limited to assigned users
- Status: accepted
- Decision:
  - Add task-level `.ics` export buttons only when current user is assigned to the task.
  - Generate calendar file on client with task metadata and location (project address when available).
  - Provide export access in My Tasks, Project Tasks, and Weekly Planning views.
- Tradeoffs:
  - Pros: no backend contract change required; fast MVP delivery.
  - Cons: no server-side export audit trail and no signed link workflow yet.

## 2026-02-21 - Frontend login must self-heal malformed stored tokens
- Status: accepted
- Decision:
  - Validate `smpl_token` format on app bootstrap and clear malformed values automatically.
  - Validate token format before persisting a fresh login token.
- Tradeoffs:
  - Pros: prevents client-side fetch/header failures caused by corrupted local storage token values.
  - Cons: strict token-shape check assumes JWT-style token format.

## 2026-02-21 - Login retries once with absolute URL on browser “expected pattern” transport errors
- Status: accepted
- Decision:
  - Keep primary login request path as relative (`/api/auth/login`).
  - If browser throws an “expected pattern” transport error, retry once against absolute origin URL.
  - Surface explicit localized error text when this class of error persists.
- Tradeoffs:
  - Pros: improves Safari/browser-specific robustness without backend changes.
  - Cons: adds a client-side retry branch that can mask deeper browser/network misconfiguration.

## 2026-02-22 - Rate limiting must return explicit 429 responses and use WebDAV-aware buckets
- Status: accepted
- Decision:
  - Replace middleware-thrown `HTTPException(429)` with direct JSON `429` responses (`Retry-After: 60`).
  - Split in-memory request buckets by traffic scope (`default`, `time`, `dav`) with higher limits for WebDAV-heavy clients.
- Tradeoffs:
  - Pros: prevents ASGI exception-group failures that surfaced as `500` during aggressive polling and Finder/WebDAV sync bursts.
  - Cons: higher limits for `dav` scope reduce strictness against bursty abuse from a single trusted LAN IP.

## 2026-02-22 - WebDAV folder labels must include customer and project ID
- Status: accepted
- Decision:
  - Keep stable numeric WebDAV paths (`/api/dav/projects/{id}/`) for compatibility.
  - Extend WebDAV `displayname` to include customer/project identifier plus internal ID (`... | ID <id>`).
- Tradeoffs:
  - Pros: easier project discovery in mounted file explorers without breaking existing mounts.
  - Cons: long customer names can produce wider labels in some WebDAV clients.

## 2026-02-22 - File preview/download must sanitize invalid MIME values
- Status: accepted
- Decision:
  - Normalize/sanitize stored MIME types before sending response headers and fallback to `application/octet-stream` for invalid values.
  - Treat unreadable file payload paths as controlled `404` responses.
- Tradeoffs:
  - Pros: avoids internal errors from malformed legacy upload metadata and stabilizes in-browser previews.
  - Cons: fallback MIME may reduce inline rendering hints for malformed records.

## 2026-02-22 - Wiki moved to filesystem-backed local library (brand/folder explorer)
- Status: accepted
- Decision:
  - Keep existing DB wiki-page APIs for compatibility, and add filesystem wiki APIs for local document libraries:
    - `GET /wiki/library/files`
    - `GET|HEAD /wiki/library/raw/{path}`
  - Mount host `local wiki` directory read-only into API container (`/data/wiki`) and expose that directory through authenticated API endpoints.
  - Implement strict path normalization and root-bound checks so raw reads cannot escape wiki root.
- Tradeoffs:
  - Pros: supports direct reuse of existing local wiki folders/files (HTML/PDF pairs) without manual data migration.
  - Cons: directory scans are heavier than DB lookups for very large libraries; may need caching/lazy loading later.

## 2026-02-22 - Task assignees are any active user role; task edits stay manager-only
- Status: accepted
- Decision:
  - `GET /users/assignable` now returns all active users (all roles) so planners/admins can assign tasks beyond employee-only scope.
  - Keep task mutation authorization server-side:
    - managers (`admin/ceo/planning`) can fully edit tasks,
    - assigned non-manager users can still only mark tasks done.
  - Frontend adds explicit manager task-edit modal instead of inline client-only edits.
- Tradeoffs:
  - Pros: matches real operations where non-employee roles can receive assignments; preserves least-privilege task mutation model.
  - Cons: broader assignee list can be larger/noisier in autocomplete for large organizations.

## 2026-02-22 - Weekly planning remains a fixed 7-day row with dual-axis scrolling
- Status: accepted
- Decision:
  - Keep planning calendar as a single 7-column grid at all viewport sizes.
  - On narrow screens: horizontal scroll before any day reflow/stacking.
  - Inside each day: vertical scroll for long task lists.
- Tradeoffs:
  - Pros: preserves week-at-a-glance mental model and avoids day-order wrapping confusion.
  - Cons: mobile interaction requires horizontal panning.

## 2026-02-22 - Task/report time inputs are standardized to explicit HH:MM text format
- Status: accepted
- Decision:
  - Use one explicit `HH:MM` (24h) input model for task start-time fields (project tasks, weekly planning, task edit) and construction-report worker times.
  - Validate time format client-side before submit and keep backend parsing unchanged.
- Tradeoffs:
  - Pros: consistent behavior across Safari/mobile browsers where native `type=time` inputs behaved inconsistently.
  - Cons: users lose browser-native time picker UI in exchange for predictable cross-browser entry.

## 2026-02-22 - Project edit modal includes archive and hard-delete actions
- Status: accepted
- Decision:
  - Keep archive as status-based update (`archived`) to preserve project history.
  - Add explicit hard-delete endpoint (`DELETE /projects/{id}`) restricted to `projects:manage`, with best-effort cleanup of encrypted project attachment/icon payload files.
- Tradeoffs:
  - Pros: supports both reversible lifecycle management (archive) and definitive cleanup when required.
  - Cons: hard-delete is destructive and can remove linked workflow/chat/report artifacts tied to the project.

## 2026-02-22 - Overview shortcut pages include contextual back navigation
- Status: accepted
- Decision:
  - When a user opens `construction`, `time`, or `wiki` from overview shortcut cards, persist a lightweight UI-origin flag and render a top-left header back button that returns to overview.
  - Keep existing left-nav routing unchanged; only overview-origin visits show this back affordance.
- Tradeoffs:
  - Pros: preserves user orientation and reduces navigation friction on mobile/tablet after shortcut jumps.
  - Cons: introduces small additional client-side view-origin state.

## 2026-02-22 - Chat unread indicator and message rendering follow messenger grouping
- Status: accepted
- Decision:
  - Poll threads globally (slower outside chat, faster inside chat) so unread counts remain current for sidebar indicators.
  - Show a blue unread dot on left-nav `Chat` whenever any thread has unread messages.
  - Render chat with day separators, `HH:MM` timestamps, and inbound avatar grouping by sender-run.
- Tradeoffs:
  - Pros: improves glanceable awareness and aligns chat behavior with expected messenger UX.
  - Cons: adds lightweight background polling and more frontend render-state logic.

## 2026-02-22 - Assignable users expose avatar metadata for cross-view identity rendering
- Status: accepted
- Decision:
  - Extend `AssignableUserOut` with `avatar_updated_at` to support avatar rendering in non-admin contexts (task/chat views) without depending on admin-only user listing endpoints.
- Tradeoffs:
  - Pros: consistent user identity rendering in chat/task UI for non-admin roles.
  - Cons: slightly increases assignable-user payload size.

## 2026-02-22 - Completing own task can jump directly into prefilled construction report
- Status: accepted
- Decision:
  - Add a `Report from task` action in `My Tasks`.
  - When invoked on open tasks, backend task status is first updated to `done`, then frontend routes to global Construction Report with task/project prefill (project, date, workers, work/material notes).
- Tradeoffs:
  - Pros: removes duplicate entry steps after finishing work and keeps report creation in the same flow.
  - Cons: prefill is UI-level (not persisted link metadata) until report is submitted.

## 2026-02-22 - Job Ticket MVP uses project-context defaults and hides site/location creation UI
- Status: accepted
- Decision:
  - Remove the standalone site/location creation form from current Job Ticket UI.
  - Keep ticket endpoint/model compatibility, but submit project-context date/address defaults from the selected project.
- Tradeoffs:
  - Pros: simpler UX for current operations, while preserving future extensibility of full site workflow.
  - Cons: reduced per-ticket location flexibility in current UI.

## 2026-02-22 - Sidebar project search is an explicit toggle under Projects header
- Status: accepted
- Decision:
  - Add magnifier icon next to sidebar `Projects` header.
  - Toggle an inline search input directly under the header; filter project list by customer, project number, and project name.
- Tradeoffs:
  - Pros: scales navigation with large project counts while keeping sidebar compact by default.
  - Cons: adds another small sidebar state (search open/query).

## 2026-02-22 - Task-driven construction report keeps contextual back navigation
- Status: accepted
- Decision:
  - When Construction Report is opened from `My Tasks -> Report from task`, persist the source view and show a header back button.
  - Return to the originating task view instead of forcing global navigation.
- Tradeoffs:
  - Pros: preserves operator workflow continuity after completing/reporting a task.
  - Cons: introduces one additional client-side routing context state.

## 2026-02-22 - Project archive is exposed as dedicated sidebar destination
- Status: accepted
- Decision:
  - Add `Project archive` entry at the bottom of sidebar project list (after divider).
  - Implement dedicated archive page with manager actions: unarchive + hard delete.
- Tradeoffs:
  - Pros: makes archive lifecycle explicit and discoverable without overloading project edit modal.
  - Cons: adds another non-primary view and supporting UI state.

## 2026-02-22 - Task change indicators for My Tasks/Planning use lightweight polling digest
- Status: accepted
- Decision:
  - Poll `/tasks?view=my` in background and compare digest snapshots.
  - Show left-nav blue dot on `My Tasks` and `Weekly Planning` when assigned-task data changes outside those views.
- Tradeoffs:
  - Pros: immediate user-visible signal without backend event infrastructure.
  - Cons: polling overhead and eventual-consistency behavior versus push notifications.

## 2026-02-22 - Task deletion is manager-only and API-enforced
- Status: accepted
- Decision:
  - Add `DELETE /tasks/{task_id}` protected by `tasks:manage` and project-access checks.
  - Surface delete action only in manager task-edit modal.
- Tradeoffs:
  - Pros: keeps destructive action server-authorized and role-scoped.
  - Cons: irreversible action requires clear confirmation and operator discipline.

## 2026-02-22 - Project/My-Tasks drilldown back navigation is single-hop
- Status: accepted
- Decision:
  - When a user opens `My Tasks` by clicking an assigned task inside a project, the return button in `My Tasks` sends the user back to that project without setting a reciprocal project-level back link.
  - Keep project-level `Back to My Tasks` only for direct `My Tasks -> Go to project` navigation, not drilldown-return paths.
- Tradeoffs:
  - Pros: removes confusing back-loop and aligns back behavior with user origin.
  - Cons: adds slightly more client-side navigation context branching.

## 2026-02-22 - Chat thread project linking restored in create/edit modal and API patch
- Status: accepted
- Decision:
  - Reintroduce optional project selection in thread create/edit modal.
  - Extend `PATCH /threads/{id}` payload handling to support `project_id` updates (including explicit clear to global thread), with project access checks and site/project consistency validation.
- Tradeoffs:
  - Pros: restores operational thread grouping by project while keeping independent/global chat supported.
  - Cons: adds one more editable thread attribute and validation path.

## 2026-02-22 - Chat pane height uses viewport-based sizing
- Status: accepted
- Decision:
  - Replace fixed short chat-pane heights with viewport-based sizing variables to keep the message panel usable across screen sizes.
- Tradeoffs:
  - Pros: improves readability and history visibility, especially on larger displays.
  - Cons: introduces responsive height tuning values that may need future calibration.

## 2026-02-22 - Project files use managed folder metadata with protected Verwaltung scope
- Status: accepted
- Decision:
  - Introduce `project_folders` metadata and default folder bootstrap on project creation (`Bilder`, `Anträge`, `Berichte`, `Tickets`, `Verwaltung`).
  - Enforce `Verwaltung` visibility/access server-side for elevated roles only; filtering applies to API listings and WebDAV traversal/download.
  - Support nested folder paths and `MKCOL` in WebDAV to keep OS-mounted file workflows viable.
- Tradeoffs:
  - Pros: predictable folder structure, role-safe sensitive folder, and better compatibility with SharePoint/WebDAV-style usage.
  - Cons: added folder-path normalization/authorization complexity in workflow and WebDAV code paths.

## 2026-02-22 - Absence domain integrated into time tracking and weekly planning
- Status: accepted
- Decision:
  - Add first-class absence entities:
    - vacation requests (user-created, admin/ceo/accountant/planning review),
    - school absences (accountant+ managed, recurring weekday or date range).
  - Expose approved absences in weekly planning day payload so planning can see workforce constraints in the calendar.
- Tradeoffs:
  - Pros: unifies workforce availability signals with scheduling UI.
  - Cons: recurring-rule handling adds date-expansion logic and more test surface.

## 2026-02-22 - Admin CSV import template + upload endpoint for bulk project onboarding
- Status: accepted
- Decision:
  - Provide authenticated admin endpoints for downloading a CSV template and importing CSV project rows.
  - Reuse existing import mapping logic so unknown columns remain preserved in `extra_attributes`, consistent with Excel import behavior.
- Tradeoffs:
  - Pros: faster operational bulk onboarding and consistent data mapping across Excel/CSV sources.
  - Cons: bulk import expands data-quality risk; depends on validation and operator discipline.

## 2026-02-22 - Deprecation hardening: lifespan startup + UTC helper + Pydantic v2 config style
- Status: accepted
- Decision:
  - Replace `@app.on_event("startup")` with FastAPI lifespan initialization.
  - Standardize UTC timestamp creation through `app.core.time.utcnow()` (timezone-aware source, stored as naive UTC for DB compatibility).
  - Replace schema `class Config` usage with `ConfigDict(from_attributes=True)`.
- Tradeoffs:
  - Pros: removes core framework/runtime deprecations, reduces upgrade risk, and centralizes timestamp behavior.
  - Cons: test bootstrap and monkeypatch paths needed small updates due changed initialization/time callsites.

## 2026-02-22 - Production bootstrap-admin creation must be explicitly disabled after first setup
- Status: accepted
- Decision:
  - Introduce `INITIAL_ADMIN_BOOTSTRAP` setting (default `true` for bootstrap/test convenience).
  - In production runtime `.env`, set `INITIAL_ADMIN_BOOTSTRAP=false` after first admin provisioning.
  - Keep startup behavior as "create bootstrap admin only when enabled and missing".
- Tradeoffs:
  - Pros: prevents accidental recreation of predictable bootstrap credentials in restored/fresh environments.
  - Cons: a fresh environment with bootstrap disabled and no active admin requires manual DB/API admin provisioning.

## 2026-02-22 - Bootstrap admin completion persisted in DB runtime settings
- Status: accepted
- Decision:
  - Added `app_settings` table for runtime flags.
  - Added `initial_admin_bootstrap_completed` flag used during startup bootstrap checks.
  - Startup now avoids creating/recreating default bootstrap admin once completion flag is set.
  - Changing initial admin credentials through `PATCH /auth/me` auto-marks bootstrap completion.
- Tradeoffs:
  - Pros: prevents default credential resurrection after restore/restart without requiring manual env edits each time.
  - Cons: introduces a small new persistence surface (`app_settings`) and migration dependency.

## 2026-02-23 - Project overview uses server-side activity log + finance domain model
- Status: accepted
- Decision:
  - Added dedicated backend entities for project observability and finance:
    - `project_activities` for immutable project-level change events,
    - `project_finances` for structured financial fields,
    - `projects.last_updated_at` as canonical "last edited" timestamp.
  - Added `GET /projects/{id}/overview` to provide a single server-validated snapshot for project overview UI (open tasks, my tasks, finance, recent changes).
  - Kept task/ticket/files/report workflows as event producers that append activity rows and touch `last_updated_at`.
- Tradeoffs:
  - Pros: deterministic project timeline, consistent "last update" semantics, and cleaner UI composition with one overview payload.
  - Cons: additional write operations on common project actions and one extra schema/migration surface.

## 2026-02-23 - Project page tab model normalized to Overview/Tasks/Tickets/Files/Finances
- Status: accepted
- Decision:
  - Standardized selected-project navigation to five tabs: `overview`, `tasks`, `tickets`, `files`, `finances`.
  - Moved map preview, contact/meta glance, internal note editing, and recent change feed into `Overview`.
  - Restricted `Tasks` tab scope to task creation + task lists (my/open) only.
- Tradeoffs:
  - Pros: clearer IA per project and reduced cross-tab clutter.
  - Cons: users coming from older flows need one click to reach map/context now located in `Overview`.

## 2026-02-23 - Project overview map uses address-only query and map-as-link interaction
- Status: accepted
- Decision:
  - Build map query only from `project.customer_address` to keep map lookup deterministic and reduce unnecessary context leakage.
  - Remove standalone "open in maps" button and make the map area itself the single navigation target.
  - Show open tasks as a scrollable list in overview instead of counter-only summary for better operational scanning.
- Tradeoffs:
  - Pros: cleaner UI, fewer controls, better privacy by data minimization in map query, and more useful task-at-a-glance visibility.
  - Cons: embedded map is no longer interactive for panning/zoom before opening external maps.

## 2026-02-23 - Open-task card simplified and weather slot reserved in project overview
- Status: accepted
- Decision:
  - Keep the project overview task glance card list-focused (no counters in the card body).
  - Add dedicated two-column weather placeholder card in overview grid to reserve layout for future weather feature.
- Tradeoffs:
  - Pros: less visual noise, clearer scanning of real tasks, and stable layout target for upcoming weather integration.
  - Cons: task totals are no longer visible in that card and must be inferred from list content or other views.

## 2026-02-23 - Project weather uses server-side OpenWeather fetch with per-project cache/throttle
- Status: accepted
- Decision:
  - Implemented weather retrieval on backend (`/projects/{id}/weather`) using OpenWeather geocoding + 5-day forecast.
  - Added persistent per-project cache (`project_weather_cache`) with 15-minute refresh cooldown per project.
  - On provider/network failure, API returns last cached values (`stale=true`) instead of failing hard.
  - Weather API key is managed through admin endpoints (`/admin/settings/weather`) and configured via Admin tools UI.
- Tradeoffs:
  - Pros: avoids frontend secret exposure, prevents call spikes when users switch projects, supports offline/stale fallback.
  - Cons: adds one more external dependency and operational key-management responsibility.

## 2026-02-23 - Weather geocoding retries multiple address candidates
- Status: accepted
- Decision:
  - Keep weather lookup source as project `customer_address`, but geocode with ordered candidates:
    - normalized base address,
    - base + `Deutschland`,
    - base + `Germany`.
  - Normalize project address input on save (comma/whitespace cleanup) and show a format hint in the project form.
- Tradeoffs:
  - Pros: fewer false geocode failures for valid German addresses and less manual reformatting for users.
  - Cons: fallback suffixes are country-biased and may be less ideal for non-DE projects until country is explicit in data model.

## 2026-02-23 - Weather geocoding falls back to ZIP for difficult street matches
- Status: accepted
- Decision:
  - Added geocode fallback to OpenWeather ZIP endpoint when direct geocoding returns empty results.
  - ZIP candidates are parsed from project `customer_address` and sent as `ZIP,DE`.
- Tradeoffs:
  - Pros: recovers forecasts for addresses not recognized at street granularity; robust for German project data.
  - Cons: ZIP geocoding is less precise than full street geocoding.

## 2026-02-23 - Task typing extended with customer appointments and UTC-naive timestamp parsing normalized in web UI
- Status: accepted
- Decision:
  - Added third task type `customer_appointment` to canonical task-type aliases in API/admin import flow and exposed it in weekly planning + task forms.
  - Weekly planning view filter now includes a dedicated customer-appointments subview beside construction and office views.
  - Frontend datetime parsing now treats server timestamps without explicit timezone as UTC to avoid local-time drift (1-hour offset in DE locale).
  - Project overview load now merges returned `project` payload into local project list state so "Last update" reacts immediately to task creation.
- Tradeoffs:
  - Pros: supports appointment planning workflow without overloading office tasks; consistent timezone rendering; improved perceived data freshness in project detail.
  - Cons: task-type taxonomy grows (more filter options) and requires users to classify tasks correctly for planning views.

## 2026-02-23 - Construction report worker times are persisted as project-level reported hours
- Status: accepted
- Decision:
  - Added `project_finances.reported_hours_total` as persistent accumulator for hours reported in construction reports.
  - On each project-bound construction report create, backend parses worker `start_time`/`end_time` rows and adds valid durations to the project total.
  - Exposed this total through existing finance/overview payloads and surfaced it in project overview as an at-a-glance metric.
- Tradeoffs:
  - Pros: stable and fast project-hour glance value without re-aggregating every report on each UI load.
  - Cons: accumulator model assumes append-only reports; if report edit/delete is introduced later, compensating adjustments must be implemented.

## 2026-02-23 - Project site access is modeled as controlled option + optional detail note
- Status: accepted
- Decision:
  - Added explicit project-level fields for site entry handling:
    - `site_access_type` (controlled set of values),
    - `site_access_note` (free-text detail).
  - `site_access_note` is used only for access types that operationally require detail (`key_pickup`, `code_access`, `key_box`).
  - Exposed the selected access option in the project overview contact card for at-a-glance dispatch context.
- Tradeoffs:
  - Pros: structured, consistent data for common access workflows while keeping flexibility for codes/pickup details.
  - Cons: single-option model does not capture multiple simultaneous access methods per project.

## 2026-02-23 - User lifecycle UX aligned with project archive pattern + self-service avatar deletion
- Status: accepted
- Decision:
  - Keep backend user soft-delete semantics (`is_active=false`) as archive state.
  - In admin UI, render only active users in main tables and move inactive users to dedicated archive sections with explicit restore action.
  - Add profile self-service avatar removal endpoint (`DELETE /users/me/avatar`) and UI action so users can fully clear profile images.
- Tradeoffs:
  - Pros: cleaner admin operational list, archive consistency with project behavior, and full user control over profile picture presence.
  - Cons: archived users still share the same table/model (no separate archive entity), so very large user sets may later need server-side filtered list endpoints.

## 2026-02-23 - Office material demand is tracked as a dedicated cross-project queue with status workflow
- Status: accepted
- Decision:
  - Added dedicated `project_material_needs` persistence model instead of deriving queue state directly from raw report payload each time.
  - On project-bound construction report creation, parse `office_material_need` text into distinct queue items and auto-create rows with default status `order`.
  - Exposed queue via `GET /materials` and mutable status via `PATCH /materials/{id}`.
  - Canonical status workflow is:
    - `order`,
    - `on_the_way`,
    - `available`.
  - Queue list is scoped to active projects visible to the current user.
- Tradeoffs:
  - Pros: status is durable and editable independently of immutable report payloads; supports shared office procurement workflow across projects.
  - Cons: free-text parsing from report field can be ambiguous; advanced quantity/article extraction remains out of scope for now.

## 2026-02-23 - WebDAV project paths are canonicalized to project number while keeping numeric-ID compatibility
- Status: accepted
- Decision:
  - Keep active WebDAV project path shape as `/api/dav/projects/{project_ref}` but resolve `project_ref` by:
    - exact `project_number`,
    - fallback numeric `id` (backward compatibility).
  - Emit project links in WebDAV root listings using `project_number` as canonical reference.
  - Remove internal DB ID from WebDAV display labels to reduce operator confusion between visible project number and technical row ID.
- Tradeoffs:
  - Pros: mounted file shares align with project identifiers users operate with; existing numeric-ID links continue to work.
  - Cons: if a legacy project has no project number, canonical path still falls back to numeric ID.

## 2026-02-23 - Root-folder uploads use explicit marker instead of empty-folder auto routing
- Status: accepted
- Decision:
  - Preserve existing upload behavior where empty `folder` means “auto route by file type”.
  - Add explicit root marker (`folder=/`) to force upload into project base folder.
  - Keep server-side folder auto-registration so inline new-folder upload does not require a separate create-folder call.
- Tradeoffs:
  - Pros: unambiguous user intent for base-folder uploads; enables one-step upload into newly specified folder paths.
  - Cons: API now has two “empty-ish” folder semantics (`""` auto, `"/"` root) that must be documented clearly.

## 2026-02-23 - Construction report mobile entry accepts numeric times and resilient photo metadata
- Status: accepted
- Decision:
  - Normalize construction report worker times from either `HH:MM` or compact numeric input (`HMM`/`HHMM`) before validation and hour accumulation.
  - Keep worker payload shape unchanged (`name`, `start_time`, `end_time`) to avoid API contract breakage.
  - Expand multipart report image intake to include both picker and camera-origin files and generate fallback file names when client metadata is incomplete.
  - Add report-form user search affordance using assignable-user suggestions instead of introducing a new worker-assignment entity.
- Tradeoffs:
  - Pros: better mobile usability (no colon requirement), fewer lost photo uploads from mobile capture flows, and backward compatibility with existing reports.
  - Cons: worker entries remain name-based free text (not user-ID-bound), so historical consistency still depends on entered names.

## 2026-02-23 - Admin update management uses release-status API with guarded auto-install and manual fallback
- Status: accepted
- Decision:
  - Added admin-protected update status endpoint (`GET /api/admin/updates/status`) that checks GitHub releases/commits for the configured repository and compares against locally configured release metadata.
  - Added admin install endpoint (`POST /api/admin/updates/install`) supporting:
    - dry run (no command execution),
    - guarded auto-install command chain (`git fetch`, `git pull --ff-only`, `alembic upgrade head`) only when a valid local git checkout is detectable,
    - manual fallback response with explicit update commands when auto-install is unavailable.
  - Exposed update controls in admin UI so update checks are discoverable without shell access.
- Tradeoffs:
  - Pros: operational visibility into update availability directly in-app; safer update execution with explicit fallback in Docker/self-hosted setups where in-container git checkout is absent.
  - Cons: automatic install is environment-dependent and typically unavailable in immutable container deployments unless explicitly configured with a repository path.
