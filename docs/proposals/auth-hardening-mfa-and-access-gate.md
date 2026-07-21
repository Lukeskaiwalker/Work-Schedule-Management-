# Concept: Login MFA + network access gate

**Status:** proposal / concept (2026-07-12)
**Context:** The app is published to the public internet (`smpl-office.duckdns.org` via the household Traefik proxy). Password is currently the only login factor. The per-account lockout and login rate-scope added in the 2026-07 security pass stop *targeted* password guessing, but two gaps remain: (1) a stolen/reused password = full access, and (2) distributed credential-stuffing across many accounts. This concept closes both — Part A at the app layer (TOTP MFA), Part B at the network layer (shrink or remove the public attack surface).

They are complementary. If you adopt Part B option A (VPN), Part A becomes optional. If the app must stay publicly reachable, Part A is essential.

---

## Part A — TOTP two-factor authentication

Standard authenticator-app (Google Authenticator / 1Password / Aegis) TOTP. No SMS.

### Data model (new columns on `users`)
| column | type | notes |
|---|---|---|
| `mfa_enabled` | bool, default false | gate |
| `mfa_secret` | text, nullable | base32 TOTP seed, **encrypted at rest** (reuse the Fernet/`FILE_ENCRYPTION_KEY` path from `services/files.py`) |
| `mfa_enrolled_at` | datetime, nullable | |
| `mfa_recovery_codes` | JSON, nullable | list of **sha256-hashed**, single-use recovery codes |

One Alembic migration (next revision after 0057). Library: `pyotp` (verify/generate) — QR can be rendered client-side from the `otpauth://` URI, so no server-side `qrcode` dep needed.

### Enrollment (authenticated user, in profile settings)
1. `POST /api/auth/mfa/enroll` → server generates a secret, stores it encrypted but **not yet enabled**, returns the `otpauth://totp/SMPL:<email>?secret=…&issuer=SMPL` URI.
2. Frontend renders it as a QR (existing settings/modal patterns; a tiny client-side QR lib).
3. `POST /api/auth/mfa/verify {code}` → server checks the TOTP against the pending secret; on success sets `mfa_enabled=true`, generates N recovery codes, returns them **once** (stored hashed).
4. `POST /api/auth/mfa/disable {current_password, code}` → clears MFA (re-auth required).

### Login becomes two-step (only when `mfa_enabled`)
- **Step 1** `POST /api/auth/login {email,password}`: on valid credentials with MFA on, **do NOT issue a session**. Instead mint a short-lived (~5 min), single-purpose **challenge token** — a signed JWT with claim `{purpose: "mfa_challenge", sub: user_id}` (explicitly *not* a session; `get_current_user` must reject it). Respond `{mfa_required: true}`.
- **Step 2** `POST /api/auth/login/mfa {code}` (carrying the challenge token): verify TOTP **or** a recovery code; on success issue the real session cookie/token exactly as today.
- No MFA enrolled → unchanged single-step login.

### Policy & edge cases
- Config flag `mfa_required_roles` (e.g. `["admin","office"]`) — force MFA for privileged roles, optional for employees. Or require for all.
- **Rate-limit the code step** with the same per-account lockout helper (`_login_locked_out`) so codes can't be brute-forced (a 6-digit code is only ~1M space).
- **Admin MFA reset**: `POST /api/admin/users/{id}/reset-mfa` (behind `users:manage`) for lost devices → clears secret/enabled, forces re-enroll. Audit it.
- **PATs bypass interactive login**, so MFA doesn't apply to them — acceptable (they're separately gated by `api_access_enabled` + revocable). Optionally require a fresh MFA check when *minting* a PAT.
- **Sequence with the cookie migration**: since the session is only issued *after* the MFA step, this pairs naturally with the deferred "stop storing JWT in localStorage" fix — do them together so the only token that ever reaches the browser is post-MFA.

### Effort
1 migration + ~5 endpoints + `pyotp` dep + 2 frontend screens (enroll card in settings, code prompt on login). Medium.

---

## Part B — Network access gate (shrink/remove the public surface)

Three options, strongest first. These are about *who can even reach the login page*.

### Option A — VPN-only (recommended)
Put the app behind **Tailscale** (or WireGuard). Staff join the tailnet; remove the public Traefik router (or bind it to the tailnet interface only). The login page is then **not reachable from the open internet at all**.
- **Pros:** eliminates the entire public attack surface (brute-force, stuffing, 0-days in the login path all become unreachable). Tailscale is near-zero-config (MagicDNS + SSO), and it **unifies** app access with the existing Pi/SSH relay (already VPN-gated).
- **Cons:** every staff device needs the VPN client / to be signed into the tailnet.

### Option B — Identity-aware proxy (keep public, add an auth layer)
Front the app with **Authelia** / **Authentik** / **oauth2-proxy** as a Traefik `forward-auth` middleware. Users authenticate (with the proxy's own MFA) before reaching the app.
- **Pros:** adds MFA at the edge with no app changes; central SSO.
- **Cons:** another service to run; double login unless SSO-integrated.

### Option C — IP allowlist (simplest, if IPs are static)
The `ipallowlist` Traefik middleware already stubbed (commented) in `docker-compose.traefik.yml`. Restrict to office + known home/VPN egress IPs.
- **Pros:** one line, no new infra.
- **Cons:** breaks roaming/cellular users; needs static IPs.

---

## Recommendation
For a small-team internal tool, **Option B-network (Tailscale VPN) is the highest-leverage single step** — it removes the public login entirely and also covers SSH. If public access is a hard requirement (staff on cellular without VPN), then **ship Part A (TOTP MFA)** and optionally add Authelia (Option B) for defense in depth. The two parts are independent and can land in either order.
