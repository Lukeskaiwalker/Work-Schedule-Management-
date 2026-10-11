# Log hygiene: no bearer secrets in request logs

Two logs record every request: the proxy's (Caddy, `docker logs smpl-all-web-1`)
and the API's (uvicorn, `docker logs smpl-all-api-1`). Both get dumped to files
on the host before deploys (`~/web-access-<date>.log`). Until 2026-10-11 they
carried live credentials.

## What was leaking

| Where in the log | Secret | Lifetime |
|---|---|---|
| `uri` `/api/events?token=…` — proxy **and** uvicorn | session JWT of every open tab (live-update stream) | 8 h (`ACCESS_TOKEN_EXPIRE_MINUTES`, default 480); no refresh, no per-token revocation |
| `resp_headers.X-Access-Token` — proxy | session JWT handed out by every login | 8 h |
| `uri` `/api/calendar/<token>/feed.ics` — both | Kalender-Abo token (`smpl_cal_…`) | **until the user rotates it** |
| `uri` and `Referer` of `/invite`, `/reset-password`, `/portal/einladung`, `/portal/passwort` `?token=` — proxy | invite / reset token | 72 h / 24 h, single use |
| `uri` and `Referer` of `/confirm/<t>`, `/api/public/customer-confirmations/<t>` | customer appointment link | until the task's date or first use |
| `uri` `/api/werkstatt/ids/handoff\|hook/<t>` | IDS-Connect hand-over | 4 h / 15 min |
| `X-Mfa-Challenge` request and response header — proxy | half-login before the second factor | 5 min |

Caddy only redacts `Cookie`, `Set-Cookie`, `Authorization` and
`Proxy-Authorization` by itself. A request the upstream fails (API down
mid-deploy) is logged a second time by `http.log.error` on Caddy's default
logger, with the same URI and headers.

## What is done now

**No JWT in the stream URL.** `/api/events` (`routers/events.py`) takes, first
match wins:

1. `?ticket=` — single use, 60 s, from `POST /api/events/ticket` (normal auth;
   a partner login gets the portal 403). Hashed in `user_action_tokens`,
   purpose `event_stream` — no migration — because mint and spend can hit
   different uvicorn workers. A spent ticket does not fall back to the cookie.
2. the `access_token` session cookie — browsers open the bare `/api/events`.
A `?token=<JWT>` is not read any more — see below.

The iOS shell cannot send its SameSite=Strict cookie from `capacitor://localhost`,
so it always uses tickets; a browser whose cookie fails to open the stream
switches to tickets (`hooks/useServerEvents.ts`). The hook now drives
reconnects itself — a ticket is spent on first use, and a non-200 such as the
maintenance page or a 502 closes an EventSource for good (per the HTML spec),
which could leave a tab without live updates after a deploy until reloaded.

**Both logs redact**, with one pattern kept identical in two places
(`tests/test_log_redaction.py` fails if they drift):

- Caddy: snippet `(log_redaction)` in `apps/web/Caddyfile`, imported by the
  access log and by the global `log default` (which carries `http.log.error`).
  Method, path shape, status and duration stay, so pre-swap quiet-window checks
  still read: `"method":"GET","uri":"/api/events?token=REDACTED",…"status":200`.
- uvicorn: `app/core/log_redaction.py`, a `logging.Filter` on `uvicorn.access`
  and `uvicorn.error`, installed when `app.main` is imported — every worker does
  that after uvicorn configured logging, so the Dockerfile `CMD` is unchanged.

Verified 2026-10-11 with `caddy:2.10.2-alpine` running this Caddyfile in front of
a dummy upstream (fake secrets of every kind above: none left in the log; the
old Caddyfile printed all of them) and with uvicorn `--workers 2`.

The calendar, confirmation and IDS URLs keep their tokens by design — a
calendar app or a customer's mail client cannot send headers. Only the logs
change for them.

## `?token=` is gone

Removed before the first deploy of this change (2026-10-11): it was kept only
for the iOS shell, and the owner confirmed the shell is not installed anywhere.
A browser tab still running the old bundle sends `?token=` once more after the
deploy, but EventSource sends the same-origin session cookie with it, and the
cookie is what lets it in. If the shell is ever rebuilt, its bundle asks for
tickets. Both logs keep redacting `token=` anyway — invite and reset links
still carry one.

## Production cleanup — for the owner to decide

Nothing here has been run. On the prod host (`ssh -i ~/.ssh/smpl_prod
mac@192.168.2.50`); every command prints counts or e-mail addresses, never a token.

**1. Token lifetime production really uses** (a duration, not a secret):

```bash
grep '^ACCESS_TOKEN_EXPIRE_MINUTES=' ~/SMPL-all/apps/api/.env || echo "unset: 480 min (8 h)"
```

**2. Count what the dumps hold** (distinct values):

```bash
cd ~ && ls -l web-access-*.log
JWT='eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,}'
echo "session JWTs, any field:      $(grep -ohE "$JWT" web-access-*.log | sort -u | wc -l)"
echo "  ...in ?token= URLs:         $(grep -ohE "[?&]token=$JWT" web-access-*.log | sort -u | wc -l)"
echo "  ...in X-Access-Token:       $(grep -ohE "\"X-Access-Token\":\[\"$JWT" web-access-*.log | sort -u | wc -l)"
echo "calendar feed tokens:         $(grep -ohE '/api/calendar/smpl_cal_[A-Za-z0-9_-]+/feed\.ics' web-access-*.log | sort -u | wc -l)"
echo "invite / reset tokens:        $(grep -ohE '(invite|reset-password|einladung|passwort)\?token=[A-Za-z0-9_-]+' web-access-*.log | sort -u | wc -l)"
echo "customer confirmation tokens: $(grep -ohE '(/confirm|customer-confirmations)/[A-Za-z0-9_-]+' web-access-*.log | sort -u | wc -l)"
```

The running containers' logs hold the same kinds for their lifetime
(`docker logs smpl-all-web-1 2>&1 | grep -ohE "$JWT" | sort -u | wc -l`, same
for `smpl-all-api-1`); they go when the deploy of this change recreates the
containers. For that deploy, skip the runbook's "dump the proxy log before
swapping" unless something needs investigating — such a dump holds JWTs valid
for up to 8 more hours.

**3. Find whose calendar feeds leaked** — before deleting the dumps. The
database stores only each token's SHA-256, so compare hashes:

```bash
cd ~/SMPL-all
HASHES=$(grep -ohE '/api/calendar/smpl_cal_[A-Za-z0-9_-]+/feed\.ics' ~/web-access-*.log \
  | sed -E 's#^/api/calendar/##; s#/feed\.ics$##' | sort -u \
  | while read -r t; do printf '%s' "$t" | sha256sum | cut -d' ' -f1; done \
  | sed "s/.*/'&'/" | paste -sd, -)   # macOS: shasum -a 256 instead of sha256sum
[ -n "$HASHES" ] && docker compose exec -T db psql -U smpl -d smpl -tAc \
  "select u.email from calendar_feeds f join users u on u.id = f.user_id where f.token_hash in ($HASHES)"
```

**4. Delete the dumps** (and any copy pulled to a workstation for analysis):

```bash
shred -u ~/web-access-*.log 2>/dev/null || rm -f ~/web-access-*.log
```

On an SSD or a copy-on-write filesystem overwriting is no guarantee; disk
encryption is what protects freed blocks. Check no backup job copied them.

**5. Rotation**

- **`SECRET_KEY` (the JWT signing key): not needed for the dumps.** A JWT dies
  8 h after login (unless step 1 says otherwise), so a dump whose `ls -l` time
  is more than 8 h old holds only expired ones. Rotation signs out every
  session at once — office, phones, partner logins — mid-shift; PATs, station
  tokens and calendar tokens are database-backed and unaffected. Worth it only
  if a dump or a live container log left the host within 8 h of being taken,
  or misuse is suspected. Deactivating one user ends that user's sessions at
  once (`is_active` is checked on every request) and is the narrower tool.
- **Calendar tokens: rotate every feed step 3 lists.** They never expire; a
  leaked one stays a read-only view of that person's tasks, vacation and school
  days. The user does it on the profile page (Kalender-Abo, new link) and
  re-subscribes on the phone.
- **Invite, reset, IDS, MFA tokens: nothing to do** — expired (72 h at most) or
  spent.
- **Customer confirmation tokens:** a leaked one can confirm or decline that
  one appointment until its date. Low impact; deleting the dumps is enough.
