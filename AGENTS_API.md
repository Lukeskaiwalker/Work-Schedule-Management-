# SMPL API — Agent & Integration Guide

> **Status:** stable since v2.5.23
> **Audience:** AI agents, automation scripts, and integrations that need
> to talk to SMPL without going through the web UI.

This guide explains *how* to talk to the API. For the exhaustive
endpoint reference — every URL, every parameter, every response shape —
see the **auto-generated OpenAPI documentation** at
`https://<your-smpl-host>/api/docs` (Swagger UI) or
`/api/openapi.json` (machine-readable spec). Those pages are always in
sync with the running server; this document complements them with the
authentication flow and conventions an agent needs to bootstrap.

---

## 1. Enabling API access

API access is **disabled for every user by default**. Browser sessions
keep working — the gate only affects programmatic Bearer-token use.

To grant access:

1. An administrator opens the **Admin Center → Users**.
2. They find the user row and flip the **"API access"** toggle to
   *Enabled (PATs allowed)*.
3. The user can now mint and use Personal Access Tokens.

The administrator can disable the gate at any time. When they do,
**every existing token of that user is rejected at the next request**
— the tokens themselves are kept in the database, so re-enabling the
gate restores them without forcing a re-mint. This is the intended
mechanism for temporary suspension (e.g. "freeze the planning agent
during the holiday shutdown").

---

## 2. Minting a Personal Access Token

Once the gate is on, the user goes to **Profile & Settings → API
tokens**. They:

1. Enter a name (free text, max 128 chars — used to identify the
   integration later, e.g. "Planning agent" or "n8n workflow").
2. Optionally set an expiry in days (default **90**, leave blank for
   "never").
3. Click **Create token**.

The plaintext token is displayed **exactly once** in the response
panel — copy it now or revoke and re-mint. The server only stores the
SHA-256 hash; nobody, including the user, can recover the plaintext
afterwards.

Tokens look like this:

```
smpl_pat_AbCdE-FgHiJ_klmNOpQrStUvWxYz0123456789AbCdEfG
```

The leading `smpl_pat_` is the discriminator the server uses to
choose the PAT auth path; the remaining 43 characters carry ~256 bits
of CSPRNG entropy.

---

## 3. Authenticating

Send the token in the standard `Authorization` header on every
request:

```
Authorization: Bearer smpl_pat_AbCdE-FgHiJ_klmNOpQrStUvWxYz0123456789AbCdEfG
```

**You do not need to obtain a JWT first.** PATs are first-class
bearer credentials — the same `/api/auth/me`, `/api/workflow/projects`,
`/api/workflow/tasks` … endpoints accept either a JWT (used by the
web UI) or a PAT (used by you). The server distinguishes them by
prefix and validates against either the JWT signing key or the
`api_tokens` table.

**Do not** send a CSRF header. CSRF protection only applies to
cookie-authenticated browser sessions. PAT requests skip it entirely.

### Quick "who am I" check

```bash
curl -sSf https://<your-smpl-host>/api/auth/me \
  -H "Authorization: Bearer smpl_pat_…"
```

A 200 response with your user JSON means everything is wired
correctly. Common non-200s:

| Status | `detail`                                  | Meaning                                    |
|--------|--------------------------------------------|--------------------------------------------|
| 401    | `Invalid token`                            | Token unknown / revoked / wrong format     |
| 401    | `API token expired`                        | Past `expires_at` — mint a new one         |
| 401    | `Inactive user`                            | The user account is deactivated            |
| 403    | `API access disabled for this user`        | Admin turned the gate off — ask them      |
| 429    | `Too many requests`                        | Slow down; `Retry-After: 60`               |

---

## 4. Common operations

These examples use the same endpoints the web UI does. Find the full
list at `/api/docs`.

### List your active projects

```bash
curl -sSf https://<host>/api/workflow/projects \
  -H "Authorization: Bearer smpl_pat_…"
```

### Get a single project (with finance, line items, members, …)

```bash
curl -sSf https://<host>/api/workflow/projects/42 \
  -H "Authorization: Bearer smpl_pat_…"
```

### Create a task

```bash
curl -sSf -X POST https://<host>/api/workflow/tasks \
  -H "Authorization: Bearer smpl_pat_…" \
  -H "Content-Type: application/json" \
  -d '{
    "project_id": 42,
    "title": "Bewehrung verlegen",
    "due_date": "2026-06-01",
    "assigned_user_ids": [7]
  }'
```

### Mark a task done (employee path)

```bash
curl -sSf -X PATCH https://<host>/api/workflow/tasks/123 \
  -H "Authorization: Bearer smpl_pat_…" \
  -H "Content-Type: application/json" \
  -d '{"status": "done"}'
```

### Send a chat message into a thread

```bash
curl -sSf -X POST https://<host>/api/workflow/chat/threads/8/messages \
  -H "Authorization: Bearer smpl_pat_…" \
  -H "Content-Type: application/json" \
  -d '{"body": "Lieferung trifft 10:00 ein"}'
```

### Upload a file to a project

```bash
curl -sSf -X POST https://<host>/api/workflow/projects/42/files \
  -H "Authorization: Bearer smpl_pat_…" \
  -F "folder=/Bilder/Tag2" \
  -F "files=@./photo1.jpg" \
  -F "files=@./photo2.jpg"
```

### Fetch your own tokens (introspection)

```bash
curl -sSf https://<host>/api/auth/api-tokens \
  -H "Authorization: Bearer smpl_pat_…"
```

Returns a list of token rows — name, prefix, `created_at`,
`last_used_at`, `expires_at`, `revoked_at`. The plaintext value is
**not** included.

---

## 5. Conventions

### Response shapes

All endpoints return JSON. Errors use the FastAPI default:

```json
{ "detail": "Permission denied" }
```

For paginated list endpoints (currently: catalog search, audit log),
the envelope is:

```json
{
  "items": [ … ],
  "total": 1284,
  "page": 1,
  "page_size": 50
}
```

Single-resource GETs return the resource object directly. Mutations
return the updated resource (POST returns 201 + body; PATCH returns
200 + body; DELETE returns 204 + empty body).

### Permissions

Your token inherits **exactly the permissions of the user who minted
it.** There is no scoping mechanism for "this token can only read
projects." If you need least-privilege for an agent, create a
dedicated user for it with the minimal role + per-user permission
overrides in the admin center. (Recommended for any agent that
mutates state — never share a CEO token with a script.)

### Time and dates

* All timestamps are ISO-8601 UTC (`2026-05-24T12:34:56`).
* Dates without a time component are `YYYY-MM-DD`.

### Rate limits

Per-IP, 1-minute sliding window:

| Scope                            | Limit (req/min) |
|----------------------------------|-----------------|
| PAT-authenticated requests       | **1200**        |
| WebDAV (`/api/dav/*`)            | 2400            |
| Time tracking (`/api/time/*`)    | 900             |
| Default (browser sessions etc.)  | 480             |

429 responses include `Retry-After: 60`. The PAT bucket is generous
on purpose so agents that batch (e.g. "fetch all projects, then all
tasks per project") don't trip it under normal use.

### CSRF

PAT requests bypass CSRF entirely. Do not send `X-Csrf-Token`. (The
header is harmless if you do — it just isn't checked.)

### Pagination

Where supported, pass `?page=N&page_size=M`. Defaults are
`page=1, page_size=50`. Caps vary per endpoint; see `/api/docs`.

---

## 6. Token hygiene

Best practices for agents holding PATs:

* **Store the plaintext in a secret manager**, not in source control.
  The token grants the full power of its owner — treat it like a
  password.
* **Set an expiry**. Long-lived (90-day) tokens with a rotation
  reminder are usually right. Never-expires is only appropriate for
  truly persistent integrations under tight environmental control.
* **One token per integration**. Don't share a single token between
  agents — naming each one ("Planning agent", "Daily report
  exporter") makes the `last_used_at` field useful for spotting
  unused or compromised tokens.
* **Revoke promptly**. If a token might have leaked (committed to
  git, leaked in logs, leaked in a screenshot), revoke immediately
  via the UI or `DELETE /api/auth/api-tokens/{id}`. The token is
  rejected at the next request, no propagation delay.
* **Watch the audit log**. Admin Center → Audit shows every
  `api_token.create` and `api_token.revoke` event with actor + token
  prefix. Unfamiliar entries deserve a closer look.

---

## 7. OpenAPI for code generation

The full OpenAPI spec at `/api/openapi.json` is suitable input for:

* `openapi-typescript` — generate TS client types
* `openapi-python-client` / `httpx-openapi-client-generator` — Python client
* GPT/Claude function-calling — feed the relevant portions as tool
  schemas. (The endpoint groupings under `tags` give natural chunks
  to surface one domain at a time.)

The spec includes per-endpoint summaries, parameter shapes, response
schemas, and the authentication-method definitions. Re-fetch after
deploying a new SMPL version to pick up schema additions.

---

## 8. Reporting issues

If an endpoint returns 500, behaves inconsistently, or you find a
schema mismatch with `/api/docs`, please file it in the SMPL repo
with:

* Endpoint URL + method
* Token prefix (the first 12 chars — never the full token)
* Request body, headers (with the token redacted)
* Response status + body
* Time of the request

The audit log on the server retains correlatable rows for at least 30
days.
