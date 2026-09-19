# File scopes — project, customer, task

How stored files hang together after the 2026-09 restructure. Read this before
touching `attachments`, the file browsers, or the WebDAV trees.

## The hierarchy

```
Kunde (customers.id)                      ← customer-level files + folders
├── Dokumente/            (default folder)
├── Verwaltung/           (default, protected: files:view_protected)
├── Aufgaben/             (appears when a customer-anchored task gets a file)
├── 2026-0123 - Müller    (project folder = the project's own file space)
│   ├── Bilder/ Anträge/ Berichte/ Tickets/ Verwaltung/   (project defaults)
│   └── Aufgaben/         (appears when one of the project's tasks gets a file)
└── 2026-0140 - Müller
```

The hierarchy is *virtual*: nothing moved on disk. A project belongs to its
customer through `projects.customer_id` (every project created through the API
has one — a legacy `customer_name` auto-creates the customer), and the customer
folder is what the customer page's file browser and the WebDAV customers tree
show. Projects without a customer stay reachable through the project tree only.

## Storage

One table, one blob store. `attachments` rows carry exactly one *scope anchor*:

| Scope    | Columns set                                | Folder table       |
|----------|--------------------------------------------|--------------------|
| project  | `project_id`                               | `project_folders`  |
| customer | `customer_id`                              | `customer_folders` |
| task     | `task_id` **plus** `project_id` *or* `customer_id` | the scope's table |

A task file is dual-anchored on purpose: it lives in the task's project (or,
for a customer-only task, in the customer) under the folder `Aufgaben`, so the
plan an office worker attaches to a task is also just a file in the project.
Both new FKs are `SET NULL` on delete — losing the task keeps the file in its
scope; the task delete endpoint removes its rows and unlinks the bytes itself.

Bytes are encrypted at rest exactly as before (`services/files.py`,
`store_encrypted_file`). Folder paths are normalised `a/b/c` strings by
`_normalize_project_folder_path`; the protected rule
(`_folder_path_is_protected`: first segment `verwaltung`) is path-based and
therefore identical for every scope.

## Access rules

All in `routers/workflow_helpers.py`:

- **Project files** — unchanged: `assert_project_access` (global project
  authority, membership, or a task assignment on the project), protected
  folders need `files:view_protected`, delete needs `files:manage`.
- **Customer files** — `_assert_customer_files_access`: a user sees a
  customer's files when they hold global project access or `files:manage`,
  or can see at least one of the customer's projects
  (`_project_ids_visible_to_user`), or are assigned to a customer-anchored
  task of that customer. Upload and folder creation use the same rule (as
  project uploads do); delete needs `files:manage`; protected folders need
  `files:view_protected`.
- **Task files** — the assignee always sees their task's files
  (`_user_is_assigned_to_task`), everyone else goes through the project or
  customer rule above. Upload: anyone who may edit the task (the task
  endpoints' own rule). Delete: `files:manage` **or** the uploader.

`_resolve_attachment_for_access` applies these for `/files/{id}/preview`,
`/download`, `/preview-pages*`; `delete_file` applies the delete variants.

## Endpoints

Shared (any scope): `GET /files/{id}/preview`, `GET /files/{id}/download`,
`GET /files/{id}/preview-pages`, `GET /files/{id}/preview-pages/{page}`,
`DELETE /files/{id}`.

Project (unchanged): `GET|POST /projects/{id}/folders`, `GET|POST /projects/{id}/files`.

Customer (`routers/workflow_customer_files.py`): `GET|POST /customers/{id}/folders`,
`GET|POST /customers/{id}/files` — same request/response shapes as the project
ones (`ProjectFolderOut`, multipart `files[]` + `folder`, list of
`_attachment_out` dicts, which now carry `customer_id` and `task_id`).

Task (`routers/workflow_task_files.py`): `GET /tasks/{id}/files`,
`POST /tasks/{id}/files` (multipart `files[]`; folder is always `Aufgaben`).
`TaskOut.attachment_count` is batched into task lists for the paperclip badge.

## WebDAV

`/api/dav/projects/` stays exactly as it was (drives are mounted on it).
`/api/dav/customers/` (`routers/workflow_webdav_customers.py`) adds the
customer view: one collection per customer the user may see, named
`<id> - <customer name>` (the leading id is the ref; Finder shows the href's
last segment, not `displayname`), containing the customer's folders and files
plus one collection per project (ref = project number, as in the project
tree) that serves that project's files under the customer path.

## Frontend

- `components/files/FileLightbox.tsx` — the click-through viewer (images,
  PDFs incl. the paged fallback, text; everything else offers download).
  Used by the project files tab, the customer file browser and task
  attachments, so "next / previous" behaves the same everywhere.
- `components/files/FileBrowser.tsx` — the list/gallery browser extracted from
  the project files tab; scope-agnostic (it only needs rows + folders +
  callbacks). `pages/project/ProjectFilesTab.tsx` and
  `components/customers/CustomerFilesCard.tsx` both render it.
- `components/tasks/TaskAttachments.tsx` — the attachments section of the
  task modal (thumbnails → lightbox, add, remove; files picked before a new
  task exists are uploaded right after it is created).
