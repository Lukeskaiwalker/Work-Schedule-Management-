# Partner portal — subcontractors' logins

How roofers, plumbers or groundworks crews see the jobs SMPL hands them. Read
this before touching `users.partner_id`, `project_partners`, anything under
`/api/portal`, or the fence in `app/core/deps.py`.

## Who and what

A **Partner** (`partners`) is a subcontractor company. Its people get
**portal logins**: ordinary `users` rows with `role = "external"` and
`partner_id` set. Access is per company, never per person — every login of a
partner sees the same things.

A partner sees:

| What | Comes from | Set in the office app |
|------|------------|-----------------------|
| Tasks | `task_partners` (the task's "Partner" field) | Task modal → Partner |
| Projects | `project_partners`, **plus** every project one of those tasks belongs to | Project overview → card "Partner" |
| The office's note for them | `project_partners.note` | same card, "Hinweis für den Partner" |
| Plans and documents | the project's **`Partnerportal`** folder and its subfolders | Project → Dateien, or the card's "Unterlagen hochladen" |
| Their own hours | `partner_time_entries` of their company | — (they report them) |

`app/services/partner_portal.py` is the single source of truth for that
visibility. Every miss is a **404**: the portal never confirms that something
it does not show exists.

What a partner can do: read those tasks and projects, report a task done
(`POST /portal/tasks/{id}/complete`, optional message → the project's or the
customer's note feed; a project note is permanent — nobody can delete one),
add photos/PDFs to their own tasks, open the files in
the project's `Partnerportal` folder, report their crew's hours and take a
report back within a week, change their own password. Nothing else.

What a partner never sees: customer phone/e-mail, finances, the project
description, other partners on a task (nor their hours), internal notes, any
project file outside the `Partnerportal` folder, the four-stage project
status (it is folded into "Laufend"/"Abgeschlossen" so invoicing stays
internal). The portal response shapes (`app/schemas/portal.py`) have no field
for any of it.

## The fence

`get_current_user` refuses a partner login on every route whose endpoint the
portal router did not register (`register_portal_routes`, last line of
`app/routers/portal.py`) with 403 "Partner accounts can only use the partner
portal". It keys on the **endpoint function of the matched route**, not on
the URL, so a path spelling cannot bend it and a route added later is closed
to partners by default. `tests/test_partner_portal_security.py` walks the live
route table (~420 login-protected routes) and asserts the 403 on each one.

The other doors are closed explicitly:

* the event stream (`/api/events`) — `get_current_user_from_token` and, for
  stream tickets, `get_active_user_by_id` refuse partner logins unless a
  caller opts in (only logout does, to audit); minting a ticket goes through
  `get_current_user`, so the fence refuses it first;
* WebDAV basic auth — a partner login gets the same 401 as a wrong password;
* permissions — `has_permission_for_user` and friends return nothing for the
  role, and a per-user override cannot grant it anything;
* default project membership, explicit membership, task assignees, chat
  participants, employee groups, station badges and the planning/user lists
  all exclude the role;
* the generic admin user endpoints (edit, re-invite, password reset,
  permission template, overrides read/set/reset, MFA reset, badge) answer 409
  for a partner login, and `/admin/users` does not list them. Only the
  generic deactivation (`DELETE /admin/users/{id}`) still works on one —
  locking is the safe direction; unlocking is done on the partner.

`external` is deliberately **not** in `ALL_ROLES`, so no role picker, role
filter or permission matrix can ever offer it.

## Office side

* Werkstatt → Partner → a partner → section **Partnerportal**: invite a
  person (name + e-mail; the link is also shown for handing over by phone
  when mail is not configured), send a new link (invite while unaccepted,
  password reset after), lock/unlock. Locking burns every unused link.
  Permission: `projects:manage`, same as managing partners. Everything is in
  the admin audit log (`partner.portal_user.*`).
* Archiving a partner closes the portal for all its logins without deleting
  them; unarchiving reopens it.
* Admin → Einstellungen → Firma: **Telefon/E-Mail fürs Partnerportal** is the
  "Fragen? Büro anrufen" contact partners see.
* Project overview → card **Partner** lists everybody who sees the project:
  the partners it was handed to (note, "Entfernen") and those who reach it
  only through a task on it ("über N Aufgaben"; "Hinweis hinzufügen" hands
  the project over). Each row shows the hours the partner reported, with the
  entries on demand; the card's "Unterlagen hochladen" creates the
  `Partnerportal` folder if needed and opens the upload dialog on it.
* Partner hours also show in the task modal (**Partnerstunden**, every
  partner on the task) and on the project's **Projektstunden** tab — apart
  from the planned-hours budget, which is our own labour. Removing an entry
  needs `projects:manage`, is logged in the activity feed and the audit log.

## Documents — the `Partnerportal` folder

A project's files are shown to its partners only from one place: the folder
named **`Partnerportal`** (first path segment, any case) and everything below
it. Every partner who sees the project reads the whole folder, so material
for one company only belongs on a task given to that company alone (a task's
attachments are visible to every partner on that task, labelled "von
Partner" for another company's uploads), and contracts or prices never
belong in it. Handing a project over creates the folder; the project's
file browser marks it "Im Partnerportal sichtbar" and the upload dialog says
so when it is the target. Partners only read: their uploads stay on their
tasks.

`GET /portal/documents/{file_id}` serves a file when it is a project file
(not a task attachment), sits in the `Partnerportal` tree and the partner
sees the project — otherwise 404. The list comes with the project detail and
with every task detail of that project. Bytes go through the same response
helper as the office: only images, PDF and plain text render inline, with
`nosniff` and the restrictive CSP.

## Hours

`partner_time_entries`: one day of one crew — `workers` people × `hours`
each — on a task of the partner's or on a project they see (`POST
/portal/hours` with `task_id` or `project_id`; a task may name its own
project, never another). Checked on both sides: 1–50 people, quarter hours up
to 24 per person, no future date (one day of slack for time zones), none
older than a year, at most 100 reports per company per 24 hours (a stolen
login must not flood the office). A partner sees only its own company's
entries, also on a task shared with another partner, and may take an entry
back (`DELETE /portal/hours/{id}`) for 7 days after reporting it; later only
the office can (`DELETE /partner-hours/{id}`). Task deletion keeps the hours
on the project (`task_id` SET NULL, `project_id` copied in); a customer-only
task with live partner hours cannot be deleted (409) until the office has
removed them. Taking a report back marks the row (`deleted_at`/`deleted_by`)
instead of erasing it, so it stays on record and still counts toward the
daily cap. Every report and removal writes a line to the task's or project's
activity feed.

## Web

`apps/web/src/main.tsx` decides before anything mounts: any `/partner…` URL,
or a stored session whose token says `role: external`, boots
`src/portal/PortalApp.tsx`; everything else boots the office `App`. Both are
lazy chunks, so a partner's phone never downloads the office app. An office
login typed on `/partner` is handed to `/`; a partner login typed on the
office login is handed to `/partner`.

Portal URLs: `/partner` (Aufgaben), `/partner/aufgaben/{id}`,
`/partner/projekte[/{id}]`, `/partner/konto`, and the e-mail links
`/partner/einladung?token=…` / `/partner/passwort?token=…`.

The portal has no live event stream (on purpose, see above); lists refresh
when the tab comes back into view and once a minute while visible.

## Uploads

Typed by their first bytes (JPEG, PNG, WebP, HEIC/HEIF, PDF), never by name or
client content type; at most 10 files and 25 MiB each per request; the body
is read only after the login and the task were checked. Files land on the
task through the office's own task-upload path (encrypted at rest, task's
`Aufgaben` folder, activity row).

The design is on the "Partnerportal" page of the SMPL Paper file.
