from __future__ import annotations
from functools import lru_cache

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# Environments where placeholder/short secrets are tolerated (local dev, CI,
# the pytest suite). Anything else is treated as production-like and must ship
# real secrets — see ``_enforce_production_secrets`` below.
_DEV_LIKE_ENVIRONMENTS = {"dev", "development", "test", "testing", "ci", "local"}

# Known-default / placeholder values that must never sign real JWTs. Compared
# case-insensitively. The empty string is included so a blank value also fails.
_WEAK_SECRET_KEYS = {"", "change-me", "dev-secret-change-me", "replace-with-long-random-secret"}
_WEAK_ADMIN_PASSWORDS = {"", "admin123", "changeme123!", "password", "admin"}
_MIN_SECRET_KEY_LENGTH = 32


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    app_name: str = "SMPL Workflow API"
    environment: str = "dev"
    database_url: str = "postgresql+psycopg2://smpl:smpl@db:5432/smpl"
    secret_key: str = "change-me"
    access_token_expire_minutes: int = 60 * 8
    # ``capacitor://localhost`` is the origin of the native iOS shell
    # (apps/mobile). It is a fixed constant of the platform rather than a
    # per-deployment value, so it belongs in the default: every deployment that
    # serves the app needs it, and leaving it out fails in a way that is hard to
    # read from the client (every request dies in a CORS preflight, with no
    # server-side log line to explain why).
    #
    # Allowing it is not a meaningful widening. The API authenticates with
    # Bearer tokens held in the shell's own origin-scoped storage, which no
    # other app can read, and CORS constrains browsers only — it was never what
    # kept a non-browser client out.
    cors_origins: str = "https://localhost,http://localhost,capacitor://localhost"

    initial_admin_email: str = "admin@example.com"
    initial_admin_password: str = "admin123"
    initial_admin_name: str = "Initial Admin"
    initial_admin_bootstrap: bool = True

    file_encryption_key: str = Field(default="", description="Fernet key")
    file_encryption_legacy_keys: str = Field(default="", description="Comma-separated read-only legacy file keys")
    uploads_dir: str = "/data/uploads"
    wiki_root_dir: str = "/data/wiki"
    material_catalog_dir: str = "/data/Datanorm_Neuanlage"
    material_catalog_image_lookup_enabled: bool = True
    material_catalog_image_lookup_retry_hours: int = 168
    material_catalog_image_lookup_max_per_request: int = 4
    report_processing_mode: str = "worker"
    report_job_max_attempts: int = 3
    report_worker_poll_seconds: float = 1.0
    api_workers: int = 2

    telegram_bot_token: str = ""
    telegram_chat_id: str = ""
    report_logo_path: str = "/app/app/assets/logo.jpeg"
    app_timezone: str = "Europe/Berlin"
    app_public_url: str = "https://localhost"
    openweather_api_key: str = ""
    # v2.5.29 — base URL of an OSRM routing service. The public demo
    # at router.project-osrm.org is sufficient for small-team usage
    # and requires no API key; admins running heavier loads can point
    # this at a self-hosted OSRM instance. Empty string disables the
    # OSRM lookup and falls back to the haversine × 1.3 heuristic.
    osrm_base_url: str = "https://router.project-osrm.org"
    # Werkstatt label printer (WAGO Smart Printer 258-5101 — a Godex OEM
    # speaking EZPL) reachable over raw TCP "port 9100" printing. Empty host
    # disables label printing; the endpoint then answers 503 instead of timing
    # out against nothing.
    werkstatt_label_printer_host: str = ""
    werkstatt_label_printer_port: int = 9100
    app_release_version: str = ""
    app_release_commit: str = ""
    update_repo_owner: str = "Lukeskaiwalker"
    update_repo_name: str = "Work-Schedule-Management-"
    update_repo_branch: str = "main"
    update_repo_path: str = ""
    github_api_token: str = ""
    # Update runner sidecar — when reachable, the install endpoint delegates
    # the full safe_update.sh flow (encrypted backup, maintenance mode, rebuild)
    # to a separate container that owns docker socket access. Empty url disables.
    update_runner_url: str = "http://update_runner:9000"
    update_runner_token: str = ""
    update_runner_timeout_seconds: float = 5.0
    # Passphrase for backup.sh / restore.sh. Forwarded to the update_runner
    # container via docker-compose.yml — the api container itself never invokes
    # the scripts, but this setting is also surfaced via the admin backups page
    # so operators can confirm one is configured before kicking off a backup.
    backup_passphrase: str = ""
    # Alternative to backup_passphrase: a path (mounted into the runner) holding
    # the passphrase. Either one being set is enough to satisfy the scripts.
    backup_passphrase_file: str = ""

    mail_from: str = "technik@smpl-energy.de"
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_username: str = ""
    smtp_password: str = ""
    smtp_starttls: bool = True
    smtp_ssl: bool = False

    secure_cookies: bool = True

    # ── Login brute-force lockout ──────────────────────────────────────────
    # Independent of the (alert-only, off-by-default) audit_alerts feature: this
    # actually BLOCKS further login attempts for an email once too many recent
    # failures accumulate. Keyed on the target account (not the client IP) so it
    # cannot be bypassed by IP rotation. Reuses the auth.login_failed audit rows.
    login_lockout_enabled: bool = True
    login_lockout_threshold: int = 10
    login_lockout_window_seconds: int = 900

    # ── Daily clocked-in summary ───────────────────────────────────────────
    # When enabled, the worker dispatches a once-per-day summary listing
    # every active clock entry plus today's worked hours per user. Used
    # by admins to spot people who forgot to clock out at end-of-day.
    # Triggered as soon as `now()` in the app timezone passes the target
    # hour:minute, exactly once per local date (idempotent — survives
    # worker restarts via an AppSetting bookmark).
    daily_clock_summary_enabled: bool = False
    daily_clock_summary_target_hour_local: int = 18
    daily_clock_summary_target_minute_local: int = 0
    daily_clock_summary_send_telegram: bool = True
    daily_clock_summary_send_email: bool = False
    daily_clock_summary_email_recipient: str = ""

    # ── Audit log retention ────────────────────────────────────────────────
    # Worker prunes audit_logs rows older than this many days, once per local
    # day at the configured hour. Set to 0 to disable pruning entirely.
    # Default 730 (≈ 2 years) — enough to cover most compliance windows
    # while keeping the table from growing forever.
    audit_log_retention_days: int = 730
    audit_log_retention_run_hour_local: int = 3  # 03:00 local — quiet window

    # ── Brute-force login alert ────────────────────────────────────────────
    # When enabled, the api raises an alert (Telegram and/or email) when
    # repeated `auth.login_failed` events cross either threshold:
    #   * ≥ N failures for the same email within `window_seconds`
    #   * ≥ M failures from the same IP within a 60-second window
    # Dedup is anchored in the audit_logs table itself (a `auth.alert_brute_force`
    # row) so multiple api workers can't double-fire and so restarts don't
    # reset the dedup state.
    # Opt-in (deliberately off by default — it sends external Telegram/email).
    # Set AUDIT_ALERTS_ENABLED=true in the server .env to turn repeated failed
    # logins into an alert + an ``auth.alert_brute_force`` audit trail. The
    # per-account lockout in the login handler protects the account regardless.
    audit_alerts_enabled: bool = False
    audit_alerts_failures_per_email_threshold: int = 5
    audit_alerts_failures_per_email_window_seconds: int = 300
    audit_alerts_failures_per_ip_threshold: int = 10
    audit_alerts_dedup_window_seconds: int = 600
    audit_alerts_send_telegram: bool = True
    audit_alerts_send_email: bool = False
    audit_alerts_email_recipient: str = ""

    @model_validator(mode="after")
    def _enforce_production_secrets(self) -> "Settings":
        """Fail closed when a production-like deployment ships insecure secrets.

        ``required: true`` on the .env file only guarantees the file exists — it
        never checked the *values*, which is how a placeholder SECRET_KEY once
        reached prod. In any non-dev environment we refuse to boot with a weak,
        default, or too-short signing key (which would make every JWT forgeable),
        a missing file-encryption key, or a default initial-admin password.
        Dev/test/CI keep using their short placeholder secrets untouched.
        """
        if self.environment.strip().lower() in _DEV_LIKE_ENVIRONMENTS:
            return self

        problems: list[str] = []
        secret = (self.secret_key or "").strip()
        if secret.lower() in _WEAK_SECRET_KEYS or len(secret) < _MIN_SECRET_KEY_LENGTH:
            problems.append(
                f"SECRET_KEY must be a strong random value of at least {_MIN_SECRET_KEY_LENGTH} characters"
            )
        if not (self.file_encryption_key or "").strip():
            problems.append("FILE_ENCRYPTION_KEY must be set")
        if (
            self.initial_admin_bootstrap
            and (self.initial_admin_password or "").strip().lower() in _WEAK_ADMIN_PASSWORDS
        ):
            problems.append("INITIAL_ADMIN_PASSWORD must not be empty or a known default")

        if problems:
            raise ValueError(
                "Refusing to start with insecure configuration in environment "
                f"'{self.environment}': " + "; ".join(problems)
            )
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
