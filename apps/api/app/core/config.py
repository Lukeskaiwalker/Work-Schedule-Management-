from __future__ import annotations
from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    app_name: str = "SMPL Workflow API"
    environment: str = "dev"
    database_url: str = "postgresql+psycopg2://smpl:smpl@db:5432/smpl"
    secret_key: str = "change-me"
    access_token_expire_minutes: int = 60 * 8
    cors_origins: str = "https://localhost,http://localhost"

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
    audit_alerts_enabled: bool = False
    audit_alerts_failures_per_email_threshold: int = 5
    audit_alerts_failures_per_email_window_seconds: int = 300
    audit_alerts_failures_per_ip_threshold: int = 10
    audit_alerts_dedup_window_seconds: int = 600
    audit_alerts_send_telegram: bool = True
    audit_alerts_send_email: bool = False
    audit_alerts_email_recipient: str = ""


@lru_cache
def get_settings() -> Settings:
    return Settings()
