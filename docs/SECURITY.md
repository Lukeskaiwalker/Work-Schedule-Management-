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
