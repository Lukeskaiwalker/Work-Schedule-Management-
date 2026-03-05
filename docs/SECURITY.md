# Security Model

## Threat Model (MVP)
- Threats considered:
  - Unauthorized user access to projects/files/time/chat data.
  - Privilege escalation via frontend-only checks.
  - Data leakage from backup artifacts.
  - MITM on local network traffic.
- Out-of-scope for MVP:
  - Hardware compromise of the host.
  - Advanced runtime exploit hardening (WAF, IDS/IPS).

## AuthN/AuthZ
- AuthN:
  - Password-based login.
  - JWT access token returned and also set as HttpOnly cookie.
  - WebDAV file access uses Basic Auth with local app credentials (email/password) for OS mount compatibility.
- AuthZ:
  - Server-side RBAC for roles: `admin`, `ceo`, `accountant`, `planning`, `employee`.
  - Permission checks are enforced in API dependencies.
- Project-scoped access check blocks unauthorized project/file/chat operations.
- Global chat threads are allowed; project-linked chat threads still enforce project membership checks.
- Chat thread metadata updates (rename/icon) are restricted server-side to thread creator or `chat:manage` roles.
- Unread message counters are derived from server-side per-user read state (`chat_thread_reads`), not frontend-only bookkeeping.
- Task authorization is enforced server-side for multi-assignee tasks:
  - planners/managers can assign one task to multiple active users (any role).
  - managers (`admin/ceo/planning`) can edit existing task metadata/assignees.
  - assigned users can mark assigned tasks complete.
  - non-assigned users cannot complete or mutate that task.
- Wiki authorization is enforced server-side:
  - all authenticated roles can read wiki pages (`wiki:view`).
  - only `admin/ceo/planning` can create/update/delete (`wiki:manage`).
  - local wiki file-library endpoints (`/wiki/library/*`) require `wiki:view`.
- Time-entry edits are server-side restricted to own entries or time-manager roles (`admin/ceo/accountant/planning`).
- Project master-data edits (project number/customer fields) are restricted to `projects:manage` roles and validated server-side.
- Project deletion is restricted to `projects:manage` roles (`DELETE /projects/{id}`), with server-side access checks before destructive execution.
- User profile avatars:
  - Upload is authenticated and user-scoped (`POST /api/users/me/avatar`).
  - Read access requires authentication (`GET /api/users/{id}/avatar`).
  - Avatar payload type is validated as image server-side.
- Admin actions:
  - User create/update/template apply tracked in `audit_logs`.

## Encryption
- In transit:
  - `caddy` serves app over HTTPS (`tls internal`) for local deployment.
  - macOS hosts should trust the generated local CA via `./scripts/trust_caddy_root_macos.sh` to avoid browser handshake failures.
  - LAN demo access (`http://<LAN-IP>`) is intentionally HTTP-only for compatibility across unmanaged test devices; treat this as non-production and trusted-network only.
  - WebDAV over LAN HTTP is for short-lived trusted demos only; for regular use prefer `https://localhost` on the host machine.
- At rest:
  - Project/chat/report file uploads are encrypted via Fernet before write.
  - Chat thread icons are stored through the same encrypted file service and never as plain files.
  - User profile avatars are encrypted at rest through the same file-encryption service.
  - File preview endpoint (`/api/files/{id}/preview`) uses the same authZ checks as download and serves decrypted content only after access validation.
  - File preview/download responses sanitize malformed stored MIME metadata and fall back to `application/octet-stream` to avoid header-level crashes.
  - Construction reports are generated as PDF artifacts and stored encrypted in attachment storage.
- Construction report image uploads are also stored as encrypted attachments and included in PDF generation flow.
  - Imported spreadsheet columns are stored in `projects.extra_attributes` and may contain customer/operational metadata; they are protected by the same DB access controls and backup encryption scope as other project data.
  - Local wiki source files are mounted read-only into the API container (`/data/wiki`) and served only through authenticated, path-validated endpoints.
  - Construction reports can be stored either project-scoped or in a general report folder (`project_id = NULL`); both remain encrypted at rest.
  - Database at-rest encryption should be provided by host disk encryption (LUKS/FileVault/BitLocker).
- Backups:
  - `./scripts/backup.sh` creates encrypted artifact (`AES-256-CBC + PBKDF2`) using `BACKUP_PASSPHRASE`.
  - Admins can export encrypted DB backups in-app via `POST /api/admin/backups/database` using an uploaded key file; backup payload is encrypted with `AES-GCM` and a `PBKDF2`-derived key from that file.
  - `./scripts/restore_smoke_test.sh` performs a local restore drill that verifies DB and uploads integrity after restore.

## Least Privilege
- API endpoints use role-based permission checks and project membership checks.
- Employee role is restricted to own tasks/time + permitted project resources.
- New users default to `employee` role at API boundary unless an admin explicitly assigns a higher role.
- Access to imported extra project metadata (`extra_attributes`) is governed by the same project RBAC checks as standard project fields.
- Imported project timeline fields (`last_state`, `last_status_at`) are governed by the same project RBAC checks as standard project fields.
- Project archive action in UI is status-only (`archived`) and remains API-authorized through existing `projects:manage` checks.
- UI changes (overview/project split, global weekly planning, independent chat creation) do not replace or weaken server-side authorization checks; permissions remain API-enforced.
- UI refinements (sidebar footer account/language controls and compact files upload modal) are presentation-only; file upload/download authorization remains API-enforced per project access.
- Sidebar project-list scrolling and project-header text/order updates are presentation-only and do not change authorization boundaries.
- Profile/settings entrypoint and embedded admin center are UI routing changes only; RBAC checks for `/admin/*` endpoints remain server-side and unchanged.
- File preview opening in a separate browser tab/window is presentation-only; preview route authorization (`/files/{id}/preview`) remains unchanged and server-enforced.
- Direct DB role edits are emergency-only operations:
  - they bypass normal API-level audit logging for admin actions.
  - if used, operators should record the change in operational logs/change management notes.
- Construction report is global in navigation:
  - project-linked writes must pass project authorization checks.
  - general-folder report writes/reads require report permissions (`reports:create`/`reports:view`/`reports:manage`) and are enforced server-side.
- Chat composer UI-state changes (send-button enable/disable color, compact `+` attach control) are presentation-only; message creation authorization remains server-side at `/threads/{id}/messages`.
- Attachment draft chip add/remove behavior in chat composer is presentation-only; server-side message validation still requires either text or a real uploaded file.
- Chat fixed-height/inner-scroll behavior is presentation-only and does not alter chat authorization, unread tracking, or message storage controls.
- Attachment-only chat sends (without text body) remain subject to the same authenticated, thread-access-checked server endpoint (`POST /threads/{id}/messages`).
- Spreadsheet project status values are stored as operational source labels; this does not affect authorization because RBAC decisions are role/permission based, not status-label based.
- Wiki raw-file serving enforces root-bound path normalization:
  - rejects traversal (`..`) and invalid paths,
  - serves only files under configured `WIKI_ROOT_DIR`.

## OWASP Baseline Controls (MVP)
- Password hashing using bcrypt.
- Basic request-rate limiting middleware with explicit `429` responses (`Retry-After`) and separate traffic buckets for WebDAV/time-heavy endpoints.
- CORS restricted by config.
- CSRF protection for cookie-authenticated mutating requests (`X-CSRF-Token` header must match CSRF cookie).
- No secrets committed; templates only in repo.
- Telegram credentials are optional and loaded from local env/config only; no bot secrets are committed.

## GDPR/DSGVO Notes (MVP)
- Data minimization: only workflow-related fields stored.
- Access control + audit logs support accountability.
- Operator responsibilities:
  - Define retention policy.
  - Handle data subject export/delete requests.
  - Protect encryption keys and backup passphrase.
  - Run periodic restore drills and verify restored data integrity before relying on backups operationally.

## Iteration Security Notes (2026-03-04, DATANORM material catalog parsing)
- Material catalog import now uses deterministic DATANORM field parsing instead of heuristic token extraction, reducing risk of incorrect catalog metadata being shown to users.
- Parser-signature versioning forces a controlled one-time reimport when parser logic changes, preventing stale/misparsed cached catalog data from persisting indefinitely.
- DATANORM source folder handling remains read-only mount-based (`/data/Datanorm_Neuanlage:ro`) and does not introduce new write surfaces.

## Iteration Security Notes (2026-03-04, material image lookup)
- Catalog image enrichment now performs outbound HTTP lookups by EAN. To reduce abuse surface:
  - only `http/https` URLs are accepted,
  - localhost/private/link-local IP targets are rejected,
  - manufacturer-first lookup is domain-filtered before page fetch.
- Image data is stored as URL metadata only (`image_url`), not as downloaded binary blobs, so no new file-at-rest storage path is introduced.
- Lookup attempts are cached with `image_checked_at` and throttled via retry window (`MATERIAL_CATALOG_IMAGE_LOOKUP_RETRY_HOURS`) to limit repeated outbound calls.
- Duplicate import rows continue to be ignored deterministically, and skipped counts are now surfaced to users/operators for import transparency.

## Iteration Security Notes (2026-02-22)
- Chat unread indicator uses server-derived unread counts from authenticated `/threads` responses; unread UI state is not client-authored.
- Global thread polling (slow outside chat, fast inside chat) keeps unread indicators current; this is read-only and does not alter message authorization.
- Message avatar rendering uses authenticated avatar endpoint (`/users/{id}/avatar`) plus `avatar_updated_at` metadata from assignable users; unauthorized access remains blocked server-side.
- Overview back-button and task-header toggle are presentation-only changes and do not affect RBAC boundaries.
- Task->construction-report shortcut is a UI orchestration:
  - task completion still calls authorized `PATCH /tasks/{id}` checks,
  - report write still flows through report endpoints with existing report/project permission enforcement.
- Job Ticket simplification (project default date/address, no site-create segment) is UI-only and does not reduce server-side authorization on ticket endpoints.
- Sidebar project search is client-side filtering over already authorized project data; it does not widen data exposure scope.

## Iteration Security Notes (2026-02-26, admin nickname for anonymized exports)
- Nickname management is admin-only and server-enforced:
  - non-admin users receive `403` on nickname availability/set paths.
- Nickname uniqueness is case-insensitive and validated server-side before write.
- Nickname can be set only once (immutable after first set) to prevent identity churn.
- Construction-report submitter identity now uses `display_name` (nickname fallback), reducing real-name exposure in exported/generated report artifacts.

## Iteration Security Notes (2026-02-26, restricted chat participant enforcement)
- Thread visibility now has explicit server-enforced modes:
  - `public`: visible to all users with chat permissions (existing behavior),
  - `restricted`: visible only to creator + explicit participant users + users in selected participant groups.
- Restricted access checks are enforced server-side across:
  - thread listing,
  - message reads,
  - message sends,
  - thread icon read/update and thread update operations.
- Participant-user selection endpoints return active users only; archived users are excluded from selectable lists and rejected during restricted-thread creation payload validation.
- Group memberships are persisted and auditable via admin-managed employee-group APIs; no frontend-only authorization assumptions are used.

## Iteration Security Notes (2026-02-22, archive/task-delete/task-notification update)
- Task delete is now explicit API functionality (`DELETE /tasks/{id}`):
  - server-side restricted to `tasks:manage`,
  - project access is re-validated before delete.
- Project archive page actions (`unarchive`, hard delete) still call existing project-manage endpoints; no client-side-only privilege path added.
- My-task/planning notification dots use authenticated polling of the user’s own-task endpoint and do not expose additional task data beyond existing RBAC scope.

## Iteration Security Notes (2026-02-22, thread project re-linking + navigation/layout adjustments)
- Thread project assignment is API-enforced:
  - `PATCH /threads/{id}` now accepts optional `project_id`,
  - server validates access to target project before linking,
  - site-linked threads cannot be moved to mismatching/empty project context.
- Restored project selector in thread create/edit modal is a UI convenience only; effective authorization remains on server checks.
- Project/my-task back-navigation fixes, sidebar search spacing, and chat viewport-height sizing are presentation-layer changes only and do not alter authorization or data exposure scope.

## Iteration Security Notes (2026-02-22, protected project folders + absences + CSV import)
- Protected project folder policy is now API/WebDAV enforced:
  - default folder `Verwaltung` is treated as elevated scope,
  - non-elevated users cannot list/read/write protected folder content even if they can access the project generally.
- Nested folder path handling is normalized server-side before file access:
  - path traversal and invalid path shapes are rejected before lookup.
- Admin CSV import endpoints are restricted to admin/CEO permissions and are audit-logged.
- Vacation/school absence workflows are server-authorized:
  - all authenticated users may request vacation,
  - only elevated roles can review vacation or manage school-absence entries.
- Weekly-planning absence overlays are derived from authorized server data and do not create new write paths.
- Restore smoke script was updated to current schema requirements; backup/restore integrity checks remain mandatory operational control.

## Iteration Security Notes (2026-02-22, profile credential changes + invite/reset tokens)
- Profile credential updates are server-validated:
  - `PATCH /auth/me` allows name/email/password updates.
  - Changing email or password requires current-password verification server-side.
- Invite and password-reset flows now use single-use, expiring tokens stored hashed in DB (`user_action_tokens`), with invalid/used/expired token rejection.
- Public token routes (`/invite`, `/reset-password`) are frontend entrypoints only; token validation and password change happen server-side in API endpoints.
- Admin reset-link send is restricted to active users and admin authorization.
- SMTP is optional by design:
  - if configured, email is delivered via local SMTP,
  - if not configured, link generation still works for controlled manual delivery inside trusted internal operations.

## Iteration Security Notes (2026-02-22, admin key-file DB backup export)
- New admin endpoint `POST /api/admin/backups/database` requires authenticated admin role and uploaded `key_file`.
- Endpoint never returns plaintext dump; DB dump bytes are encrypted before response.
- Backup export is audit-logged (`backup.database.export`) with artifact metadata.
- Security responsibility remains with operator:
  - key file must be stored safely and shared only with authorized restore operators,
  - losing the key file means the exported artifact cannot be decrypted.

## Iteration Security Notes (2026-02-22, report/file sorting + archive/general WebDAV separation)
- Construction report attachment routing is server-side and deterministic:
  - PDF artifacts are persisted under `Berichte`,
  - report images are persisted under `Bilder`.
- Project file auto-foldering is applied server-side only when folder is omitted; explicit user-selected folders still take precedence.
- WebDAV root segmentation (`General Projects`, `Archive`) is presentation/routing organization:
  - existing auth checks remain unchanged,
  - project access checks still gate archived project content,
  - report permission checks still gate no-project report content.

## Iteration Security Notes (2026-02-22, release hardening)
- Startup migration to FastAPI lifespan is operational only and does not alter auth/authz boundaries.
- Central UTC helper adoption (`app.core.time.utcnow`) standardizes timestamp generation without changing permission checks or token semantics.
- Pydantic v2 config migration is schema-serialization-only and does not widen API data exposure.
- Added protected WebDAV folder negative-path coverage to verify `Verwaltung` access controls remain enforced for non-elevated users across additional WebDAV verbs.

## Iteration Security Notes (2026-02-22, admin user lifecycle + outbound sender identity)
- User deletion is now soft-delete only:
  - admin action sets `users.is_active=false`,
  - DB rows and historical references (time/audit/task data) remain intact,
  - login is blocked for inactive users.
- Soft-delete invalidates unused action tokens, reducing risk of stale invite/reset links being used after deactivation.
- Admin self-delete is blocked server-side to prevent accidental lockout.
- Invite/reset emails now use enforced sender identity `technik@smpl-energy.de` for consistent operational mailbox handling.

## Iteration Security Notes (2026-02-22, bootstrap login hardening on live restore)
- Removed frontend hardcoded login defaults so credentials are never prefilled in the login form.
- Added API setting `INITIAL_ADMIN_BOOTSTRAP` and set it to `false` on production host to prevent automatic recreation of bootstrap admin user.
- After restoring DB backup, verified bootstrap account was still active and then explicitly deactivated `admin@example.com` to block known default credentials.
- Validation result:
  - `admin@example.com / ChangeMe123!` login now returns `401` (`Inactive user`).

## Iteration Security Notes (2026-02-22, bootstrap lifecycle hardening)
- Added server-side persistent bootstrap completion marker (`app_settings.initial_admin_bootstrap_completed`).
- Bootstrap user auto-creation now stops permanently once initial admin credentials are changed.
- This reduces risk of default-admin credential reintroduction after restarts/restores.
- Emergency access recovery runbook was executed once on live host by resetting an existing active admin account password (no DB history deletion, no destructive reset).

## Iteration Security Notes (2026-02-22, live lockout recovery + bootstrap de-risking)
- Access was restored using an existing active admin account password reset, not by re-enabling default bootstrap credentials.
- On live DB, bootstrap completion is explicitly set and default bootstrap account remains inactive with rotated random password hash.
- Deployment process now requires excluding macOS metadata (`._*`) to avoid code execution/migration failures during container startup.

## Iteration Security Notes (2026-02-23, project finance + activity timeline)
- Added server-side finance write control:
  - `PATCH /api/projects/{id}/finance` is limited to elevated roles (`admin`, `ceo`, `accountant`) and project-access checks.
- Added immutable project activity events for operational traceability:
  - task lifecycle, project state changes, file/ticket/report updates, and finance changes are now captured in `project_activities`.
- `projects.last_updated_at` is now server-maintained from activity-producing actions, reducing frontend-derived timestamp ambiguity.
- WebDAV writes (`PUT`/`DELETE`) now also emit project activity events, so filesystem-originated updates are tracked identically to UI/API uploads.

## Iteration Security Notes (2026-02-23, map query data minimization)
- Project overview map lookup now uses only the project address field (`customer_address`).
- Customer name and project title are no longer appended to external map query strings.
- This reduces outbound metadata exposure while preserving required navigation behavior.

## Iteration Security Notes (2026-02-23, weather placeholder)
- Added UI-only weather placeholder card in project overview.
- No outbound weather API calls are performed yet.
- No changes to authN/authZ, storage, backup encryption, or secret handling in this iteration.

## Iteration Security Notes (2026-02-23, OpenWeather integration)
- Weather provider key management is server-side only:
  - key is set/read via admin-protected endpoints (`admin`/`ceo`),
  - frontend never receives raw API key values (masked value only).
- Weather API calls are executed by backend only; project clients never call external weather provider directly.
- Per-project cache + 15-minute throttle limits outbound request burst risk when users switch projects frequently.
- On weather provider outage/network failure, cached forecast is returned (`stale`) to preserve UI availability.

## Iteration Security Notes (2026-02-23, project site-access metadata)
- Added two project metadata fields (`site_access_type`, `site_access_note`) for operational access instructions.
- Validation is server-side for allowed access-type values; invalid values are rejected on project create/update.
- No permission model changes:
  - existing `projects:manage` checks still gate writes,
  - existing project access checks still gate reads.
- Data classification note:
  - `site_access_note` can contain sensitive operational details (codes/locations), so treat project exports/backups with the same handling as other internal project data.

## Iteration Security Notes (2026-02-23, avatar deletion + archived user visibility model)
- Avatar privacy control:
  - Added authenticated endpoint `DELETE /api/users/me/avatar` so users can remove stored profile images.
  - Endpoint clears avatar metadata and removes stored encrypted file path from user record.
- User archive visibility:
  - Soft-deleted users (`is_active=false`) are now separated in admin UI archive sections instead of mixed into active operational lists.
  - Authorization model is unchanged: only admin-authenticated flows can delete/restore users.

## Iteration Security Notes (2026-02-23, materials queue from report office material need)
- Added dedicated persisted queue model for office procurement items (`project_material_needs`) to avoid mutating historical report payloads.
- Access control for material queue:
  - list endpoint (`GET /materials`) is scoped to projects visible to current user,
  - update endpoint (`PATCH /materials/{id}`) validates project visibility before status changes.
- Status updates are auditable:
  - each material-status change records a project activity event (`material.status_updated`) with `from`/`to` state and item context.
- Data handling note:
  - material entries originate from free-text `office_material_need`; treat content as internal operational data in the same scope as project notes/reports.

## Iteration Security Notes (2026-02-23, WebDAV project-number references + upload-folder semantics)
- WebDAV authentication/authorization model is unchanged:
  - still HTTP Basic with app user credentials,
  - project access enforcement still uses `assert_project_access`.
- WebDAV active project routes now resolve by project number (plus numeric-ID compatibility), reducing operator mistakes caused by mixing visible project number with internal DB ID.
- Project display labels in WebDAV no longer expose internal DB IDs by default.
- File upload folder handling now supports explicit root marker (`folder=/`) while preserving legacy auto-folder behavior (`folder=""`), with the same protected-folder permission checks applied.

## Iteration Security Notes (2026-02-23, construction report mobile upload/time resilience)
- Authorization model is unchanged:
  - report creation still requires existing report/project permissions.
- Multipart report file intake now accepts image uploads from multiple form fields (`images`, `camera_images`) and missing-filename cases by generating safe fallback names.
- File ingestion remains constrained to image-like uploads in this flow (`content_type`-based check), reducing accidental ingestion of unrelated multipart fields.
- Worker-time parsing accepts compact numeric input in addition to `HH:MM`; this changes parsing robustness only and does not expand access scope or data visibility.

## Iteration Security Notes (2026-02-23, admin update status/install controls)
- Update endpoints are admin/ceo protected (`_require_admin_or_ceo`) and are not exposed to employee roles.
- Automatic install is guarded:
  - only enabled when a valid local git repository path can be detected,
  - default container deployments without git checkout stay in manual mode.
- Install workflow uses `git pull --ff-only` to avoid implicit merge commits in production update paths.
- GitHub API auth token support is optional and server-side only (`GITHUB_API_TOKEN`); token value is never returned to the frontend.

## Iteration Security Notes (2026-02-24, optimistic edit locking for project/task/finance writes)
- Added optimistic concurrency controls to reduce silent lost-update risk in concurrent editing scenarios:
  - `PATCH /api/projects/{id}` checks `expected_last_updated_at`,
  - `PATCH /api/tasks/{id}` checks `expected_updated_at`,
  - `PATCH /api/projects/{id}/finance` checks `expected_updated_at`.
- Stale writes are rejected with `409` instead of silently overwriting newer data.
- Frontend edit flows now submit changed fields only, reducing inadvertent replacement of unrelated fields during concurrent edits.
- New `tasks.updated_at` timestamp field is used as the server-issued task edit token; authorization model remains unchanged.

## Iteration Security Notes (2026-02-24, async construction-report processing queue)
- Construction-report processing now uses a persisted background queue (`construction_report_jobs`):
  - upload requests store original encrypted images and queue processing work,
  - PDF generation + optional Telegram send run in worker context.
- Access control remains unchanged:
  - report creation still requires existing report/project permissions,
  - processing-status reads (`GET /construction-reports/{id}/processing`) re-check project/report visibility server-side.
- Data-at-rest posture remains unchanged:
  - original images and generated PDF artifacts stay encrypted through the same file-encryption service.
- Reliability control:
  - failed jobs are retried up to configured limit (`REPORT_JOB_MAX_ATTEMPTS`) and terminal failures are stored on the report (`processing_status=failed`, `processing_error`) for operator visibility.

## Iteration Security Notes (2026-02-24, empty upload guard + WebDAV metadata hardening)
- Added server-side rejection of zero-byte payloads in project-file and job-ticket attachment upload routes.
- This prevents storing empty encrypted payload records that can later appear as broken/empty files in user workflows.
- Construction-report multipart intake now whitelists known image field keys (`images`/`camera_images` variants), reducing accidental ingestion of unrelated multipart file fields.
- WebDAV `PROPFIND` now exposes best-effort real file sizes for files instead of `0`, improving client interoperability without changing authorization behavior.
- No authN/authZ model changes in this iteration.

## Iteration Security Notes (2026-02-24, optimistic tokens for quick status actions)
- No authN/authZ model changes in this iteration.
- Quick project/task status updates now include optimistic timestamps in frontend quick actions, so stale one-click writes are rejected by the API with `409`.
- Security impact:
  - reduces integrity risk from race-condition overwrites in concurrent operator sessions,
  - keeps existing permission boundaries unchanged.

## Iteration Security Notes (2026-02-24, construction-report photo queue UX)
- No authN/authZ model changes in this iteration.
- Client now validates that queued construction-report attachments are image files before upload and ignores duplicate selections by file identity.
- Per-photo remove is performed client-side before upload; server-side validation and encrypted-at-rest storage behavior are unchanged.

## Iteration Security Notes (2026-02-24, construction-report photo thumbnail queue)
- No authN/authZ model changes in this iteration.
- Thumbnail previews use local browser object URLs only; no additional network transfer occurs before submit.
- Object URLs are revoked on item removal, queue clear, and component unmount to limit local memory retention.

## Iteration Security Notes (2026-02-25, structured report material-entry rows)
- No authN/authZ model changes in this iteration.
- Structured material-entry inputs only alter frontend data capture; submitted payload still uses existing server-validated report schema.
- Office material need is still server-parsed into procurement queue items; parsing and access-control behavior remain unchanged.

## Iteration Security Notes (2026-02-24, finance tab layout refresh)
- No authN/authZ model changes in this iteration.
- Change is limited to frontend read-view ordering/layout for finance values.
- Finance edit permission boundaries (`admin`/`ceo`/`accountant`) and API validation paths are unchanged.

## Iteration Security Notes (2026-02-25, finance typography/spacing tune)
- No authN/authZ model changes in this iteration.
- CSS-only presentation update for finance metrics; no API, storage, or permission behavior changes.

## Iteration Security Notes (2026-02-25, materials single-indicator flow + completion status)
- No authN/authZ model changes in this iteration.
- `completed` material status extends existing server-side status normalization only; project visibility checks on material updates remain unchanged.
- Active materials endpoint now excludes `completed` rows, reducing operational noise without altering access boundaries.

## Iteration Security Notes (2026-02-25, report numbering + normalized report image filenames)
- No authN/authZ model changes in this iteration.
- Report numbering adds metadata only (`report_number`) and does not change report-access checks.
- Server-side image filename normalization removes user/device-origin filenames from stored report-photo attachment names, reducing incidental exposure of personal naming patterns.
- File encryption-at-rest behavior for report images/PDFs is unchanged.

## Iteration Security Notes (2026-02-25, update menu release-version placeholder resolution)
- No authN/authZ model changes in this iteration.
- Change is limited to metadata/reporting in admin update status (version/commit display values).
- No impact on data-access permissions, encryption, or file handling paths.

## Iteration Security Notes (2026-02-26, chat restrictions by users and roles)
- No authentication model changes in this iteration.
- Restricted chat authorization now validates server-side on list/read/send using:
  - explicit selected users,
  - selected roles,
  - thread creator,
  - and legacy group membership for backward compatibility.
- Chat participant selectors still expose active users only; archived users remain non-selectable and rejected on restricted create payload validation.

## Iteration Security Notes (2026-02-26, mutable chat access + archive lifecycle)
- No authentication model changes in this iteration.
- Authorization checks remain server-side for all new lifecycle operations:
  - only thread creator or chat managers can archive/restore/delete,
  - restricted visibility checks still gate thread list/read/send.
- Archived thread behavior:
  - archived threads are hidden from default lists to reduce accidental posting,
  - sending messages to archived chats is rejected (`409`),
  - history is preserved for authorized users.
- Archived-user handling:
  - archived users remain non-selectable for new membership assignment,
  - existing archived members can remain in restricted threads when access lists are edited, preserving historical conversation integrity.

## Iteration Security Notes (2026-02-26, chat header 3-dot actions menu)
- No authN/authZ model changes in this iteration.
- Change is frontend-only in chat header controls; action endpoints and permission enforcement remain unchanged server-side.
- Added menu-close behavior on outside click/Escape/context change to reduce accidental action invocation from stale open menus.

## Iteration Security Notes (2026-02-26, project map copy-address icon)
- No authN/authZ model changes in this iteration.
- Frontend-only clipboard convenience action; no backend data exposure or permission-path changes.
- Copies already-visible project address text and uses existing browser clipboard APIs with fallback behavior.

## Iteration Security Notes (2026-02-26, task assignee absence hint text)
- No authN/authZ model changes in this iteration.
- Frontend-only rendering of existing absence metadata already available to authorized users in time/planning views.
- No new API endpoints, permission paths, or data persistence changes introduced.

## Iteration Security Notes (2026-02-26, nickname edit/remove flow)
- No authentication model changes in this iteration.
- Nickname authorization remains server-side and admin-only for set/update/remove operations.
- Uniqueness checks remain enforced server-side before nickname assignment.
- Allowing nickname removal only clears alias fields on the current admin user; it does not broaden access or data visibility.

## Iteration Security Notes (2026-02-26, task sub-task carry-over via reports)
- No authentication model changes in this iteration.
- Report-linked follow-up creation is enforced server-side:
  - `source_task_id` is validated as positive integer,
  - must belong to the same project as the report,
  - and only runs in project-scoped reports.
- No client-only trust for sub-task carry-over logic; unresolved-item handling executes in backend transaction with activity logging.

## Iteration Security Notes (2026-02-26, DB-safe update preflight + snapshot guard)
- No authentication model changes in this iteration.
- Update safety hardening:
  - admin auto-install now creates a pre-update DB snapshot before real migration,
  - migration preflight runs against a temporary cloned DB and aborts install on failure.
- Risk reduction:
  - lowers risk of destructive/partial schema updates on live DB,
  - increases rollback readiness by creating explicit pre-update snapshot artifact.
- Operational note:
  - snapshot is DB-only (uploads are still protected by regular encrypted backup flow via `scripts/backup.sh`).

## Iteration Security Notes (2026-02-26, report sub-task rendering + task-edit timestamp display)
- No authentication or authorization model changes in this iteration.
- Report change is presentation-level for already-submitted payload data (`completed_subtasks`) and does not expand report access scope.
- Task modal change is frontend-only display adjustment (`last edited` shown instead of week-start input); backend permission and optimistic-locking checks remain unchanged.

## Iteration Security Notes (2026-02-26, HEIC/HEIF upload support)
- No authentication or authorization model changes in this iteration.
- Upload validation remains server-side; the change broadens accepted image identification by extension in addition to MIME.
- Avatar/thread icon handling keeps existing max-size limits and encrypted-at-rest storage behavior unchanged.
- No new public endpoints were introduced.

## Iteration Security Notes (2026-02-26, project materials aggregation tab)
- No authentication model changes in this iteration.
- New endpoint `GET /projects/{project_id}/materials` is protected with existing `assert_project_access` checks.
- Aggregation reads existing report payload data only; no new sensitive fields or write paths introduced.
- Unit dropdown additions are frontend-only input aids; server-side authorization/validation boundaries are unchanged.

## Iteration Security Notes (2026-02-26, backup/restore script transport hardening)
- No authentication or authorization model changes in this iteration.
- Operational hardening only:
  - backup/preflight/restore scripts no longer rely on `docker compose cp`,
  - temp working directories are forced to `0700` permissions even under restrictive shell `umask`.
- Risk reduction:
  - lowers chance of failed safety backup/preflight execution due to host-specific Docker copy behavior or permission-masked temp directories.

## Iteration Security Notes (2026-02-28, release label consistency)
- No authentication or authorization model changes in this iteration.
- Change scope is metadata display and release-version inference only:
  - admin update-status endpoint now infers version tag from repository metadata when placeholder version is configured.
  - sidebar user popup now shows release label instead of frontend mode string.
- No new data-access paths, credential flows, or secret handling changes were introduced.

## Iteration Security Notes (2026-02-28, project modal drag-select close fix)
- No authentication or authorization model changes in this iteration.
- Frontend-only interaction safety update for modal dismissal.
- Security boundaries and API permission checks are unchanged.

## Iteration Security Notes (2026-02-28, workspace split toggle in sidebar)
- No authentication or authorization model changes in this iteration.
- Workspace mode is a frontend presentation preference stored in browser local storage (`smpl_workspace_mode`).
- No new API endpoints, permission paths, or sensitive data flows were introduced.

## Iteration Security Notes (2026-03-03, task/calendar labels + sorting)
- No authentication or authorization model changes in this iteration.
- Change scope is frontend display/navigation only:
  - task metadata labeling,
  - calendar row ordering,
  - project-link UI wiring.
- Server-side permission checks remain unchanged.

## Iteration Security Notes (2026-03-03, report-feed chat + recent reports endpoint)
- No authentication model changes in this iteration.
- Added report-feed chat updates are server-driven only after successful report processing.
- Attachment access now allows chat-thread authorization path for attachments bound to messages (`message_id`), enabling feed/chat file preview based on thread visibility rules.
- New endpoint `GET /construction-reports/recent` remains protected by existing report permissions (`reports:view|create|manage` path via `_assert_report_access`).

## Iteration Security Notes (2026-03-03, report-feed sync/backfill and thread ordering)
- No authentication or authorization model changes in this iteration.
- Feed backfill reuses existing attachment/report data and existing chat/report access checks.
- `GET /threads` may now trigger feed synchronization writes; visibility controls remain unchanged (public/restricted thread checks still enforced server-side).

## Iteration Security Notes (2026-03-03, protected report-feed thread)
- Added server-side protection preventing deletion of the system report-feed thread.
- No auth model changes; existing chat access checks remain unchanged.

## Iteration Security Notes (2026-03-03, project-task UI compaction)
- No authentication or authorization model changes in this iteration.
- Change scope is frontend-only task creation entrypoint UX in project tasks view.
- Existing server-side task permissions and validation paths are unchanged.

## Iteration Security Notes (2026-03-03, office tasks menu and client-side filters)
- No authentication or authorization model changes in this iteration.
- Change scope is frontend-only navigation and filtering UI:
  - added `office_tasks` view and office-mode sidebar item,
  - filter logic runs client-side against already-authorized task data.
- Existing backend task visibility/permission checks remain unchanged.

## Iteration Security Notes (2026-03-03, office project multi-filter + undated tasks)
- No authentication or authorization model changes in this iteration.
- Office project filtering changes are frontend-only and operate on already-authorized task data.
- Task creation still uses existing server-side permission checks (`tasks:manage`) and existing task payload validation.
- Allowing empty `due_date` does not broaden data access; it only changes scheduling visibility semantics.

## Iteration Security Notes (2026-03-03, office filter UX cleanup)
- No authentication or authorization model changes in this iteration.
- Changes are frontend-only filter behavior updates over already-authorized task data.
- No new API endpoints, permissions, or data exposure paths were introduced.

## Iteration Security Notes (2026-03-03, centered add-task plus icon)
- No auth/authz or data-flow changes.
- Frontend styling-only adjustment.

## Iteration Security Notes (2026-03-03, overview shift/report layout update)
- No authentication or authorization changes.
- Change scope is frontend-only structure/styling of overview cards and status action row.
- No API, permissions, or data-access path changes.

## Iteration Security Notes (2026-03-03, optional due date + derived overdue + image format handling)
- No authentication or authorization model changes.
- Overdue state is derived from existing task fields; no new data-access paths or privilege checks.
- Task creation with `due_date = null` changes scheduling semantics only and does not expand visibility scope.
- Image handling update keeps existing upload authorization and encrypted-at-rest storage behavior unchanged.

## Iteration Security Notes (2026-03-03, frontend startup crash fix)
- No authentication or authorization model changes.
- No API surface change.
- Change is frontend runtime stability only (hook initialization/order safety).

## Iteration Security Notes (2026-03-04, material catalog import + manual material creation)
- No authentication model changes in this iteration.
- New endpoints:
  - `GET /materials/catalog` requires authenticated user context.
  - `POST /materials` enforces existing project visibility checks (`_project_ids_visible_to_user`) before creating material-needs entries.
- Import scope:
  - Catalog importer reads from configured filesystem directory (`MATERIAL_CATALOG_DIR`) and stores parsed text metadata only.
  - No secrets/credentials are read from catalog content; importer writes normalized searchable data into DB tables.
- Existing server-side status update permission boundaries for materials remain unchanged.

## Iteration Security Notes (2026-03-05, task modal accidental-close guard)
- No authentication or authorization model changes.
- Change scope is frontend-only interaction handling (modal backdrop pointer event logic).
- No API, permission, or data-access path changes.

## Iteration Security Notes (2026-03-05, project overview office follow-up card)
- No authentication or authorization model changes.
- `office_notes` in project overview is derived from existing construction report payload data already protected by project access checks.
- No new write endpoint or privilege model introduced.

## Iteration Security Notes (2026-03-05, office-only visibility for overview office notes card)
- No authentication or authorization model changes.
- Change scope is frontend-only conditional rendering by workspace mode.
- No API, permission, or data-access path changes.

## Iteration Security Notes (2026-03-05, materials catalog search cap and project picker UX)
- No authentication or authorization model changes.
- `GET /materials/catalog` remains authenticated-only; this iteration only reduces max result size (limit clamped to 10).
- Frontend stale-search guards and searchable project picker are UI-state changes only and do not alter server-side permission checks.

## Iteration Security Notes (2026-03-05, materials project search-bar persistence/alignment)
- No authentication or authorization model changes.
- Change scope is frontend-only materials catalog input/selection UI.
- No API endpoint, permission boundary, or data-access path changes.

## Iteration Security Notes (2026-03-05, materials combobox overflow fix)
- No authentication or authorization model changes.
- Frontend-only CSS layout hardening for long selected-project labels.
- No API/permission/data-exposure changes.

## Iteration Security Notes (2026-03-05, materials selected project plain-text input display)
- No authentication or authorization model changes.
- Frontend-only rendering/interaction update in materials project search field.
- No API, permission, or data-access changes.

## Iteration Security Notes (2026-03-05, materials project search overwrite loop fix)
- No authentication or authorization model changes.
- Frontend-only state/interaction fix in materials project input.
- No API, permission, or data-access changes.

## Iteration Security Notes (2026-03-05, office material comma-splitting fix)
- No authentication or authorization model changes.
- Change is scoped to server-side parsing semantics of existing `office_material_need` text.
- No new endpoint, permission boundary, or additional data exposure path introduced.

## Iteration Security Notes (2026-03-05, task/report material ID autofill + project materials layout)
- No authentication or authorization model changes.
- Frontend uses existing authenticated `GET /materials/catalog` endpoint for row autofill lookups; no new endpoint introduced.
- Project materials readability change is CSS/markup only with no permission or data-path impact.

## Iteration Security Notes (2026-03-05, automatic zero-padding for time inputs)
- No authentication or authorization model changes.
- Frontend-only input-formatting update for existing task/report time fields.
- No API, permission, or data-access path changes.

## Iteration Security Notes (2026-03-05, release metadata automation + local catalog sync deploy)
- No authentication or authorization model changes.
- Release metadata automation is operational only (`scripts/update_release_metadata.sh`, compose env wiring) and does not introduce new API permissions.
- Material catalog sync on server uses existing authenticated/authorized backend data model and existing DATANORM mount path; no new external trust boundary was added.
