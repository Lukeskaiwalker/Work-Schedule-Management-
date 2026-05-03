from __future__ import annotations

import asyncio
import logging
import signal
import time

from app.core.config import get_settings
from app.core.db import SessionLocal
from app.main import _initialize_runtime_data
from app.services.audit_retention import prune_audit_logs_if_due
from app.services.daily_clock_summary import dispatch_daily_clock_summary_if_due
from app.services.line_item_extraction import (
    claim_next_line_item_extraction_job,
    process_line_item_extraction_job,
)
from app.services.report_jobs import claim_next_construction_report_job, process_construction_report_job

logger = logging.getLogger("smpl.report_worker")
settings = get_settings()
_stop_requested = False

# Daily-summary check is bounded to once per minute regardless of the
# faster report poll interval. Keeps DB pressure trivial.
_daily_summary_check_interval_seconds = 60.0
_last_daily_summary_check_at: float = 0.0

# Audit retention prune check runs at the same cadence — once per minute is
# plenty since the prune itself is once per LOCAL DAY (gated by an
# AppSetting bookmark inside the service).
_audit_retention_check_interval_seconds = 60.0
_last_audit_retention_check_at: float = 0.0


def _request_stop(signum: int, _frame) -> None:
    global _stop_requested
    _stop_requested = True
    logger.info("Received signal %s, stopping worker loop", signum)


def _maybe_run_daily_summary() -> None:
    global _last_daily_summary_check_at
    now_monotonic = time.monotonic()
    if now_monotonic - _last_daily_summary_check_at < _daily_summary_check_interval_seconds:
        return
    _last_daily_summary_check_at = now_monotonic
    try:
        with SessionLocal() as db:
            outcome = dispatch_daily_clock_summary_if_due(db)
        if outcome is not None:
            logger.info(
                "Daily clock summary fired: telegram=%s email=%s clocked_in=%d",
                outcome.telegram_sent,
                outcome.email_sent,
                len(outcome.summary.clocked_in),
            )
    except Exception:
        logger.exception("Daily clock summary check failed; will retry next minute")


def _maybe_run_audit_retention() -> None:
    """Prune old audit_logs rows once per local day. The service does the
    once-per-day gating internally via an AppSetting bookmark; this wrapper
    just rate-limits the check itself to once per minute so we don't pay the
    cost of constructing a session every poll cycle."""
    global _last_audit_retention_check_at
    now_monotonic = time.monotonic()
    if now_monotonic - _last_audit_retention_check_at < _audit_retention_check_interval_seconds:
        return
    _last_audit_retention_check_at = now_monotonic
    try:
        with SessionLocal() as db:
            outcome = prune_audit_logs_if_due(db)
        if outcome is not None:
            logger.info(
                "Audit retention prune ran: deleted=%d cutoff=%s date=%s",
                outcome.deleted_count,
                outcome.cutoff_utc.isoformat(),
                outcome.target_local_date,
            )
    except Exception:
        logger.exception("Audit retention prune check failed; will retry next minute")


def run_worker_loop() -> None:
    poll_seconds = max(0.2, float(settings.report_worker_poll_seconds))
    logger.info("Starting report worker (poll=%ss)", poll_seconds)
    while not _stop_requested:
        try:
            _maybe_run_daily_summary()
            _maybe_run_audit_retention()
            # Drain report jobs first (existing behaviour). When none
            # are queued, fall through to the LLM-extraction queue.
            with SessionLocal() as db:
                report_job = claim_next_construction_report_job(db)
                if report_job:
                    logger.info("Processing construction report job %s", report_job.id)
                    asyncio.run(process_construction_report_job(db, report_job.id))
                    continue
                # Same session — claim and run one extraction job per
                # tick. Two queues, one worker, simplest possible
                # priority (reports > extraction).
                extraction_job = claim_next_line_item_extraction_job(db)
                if extraction_job:
                    logger.info(
                        "Processing line-item extraction job %s (project=%s, doc=%s)",
                        extraction_job.id,
                        extraction_job.project_id,
                        extraction_job.doc_type,
                    )
                    process_line_item_extraction_job(db, extraction_job.id)
                    continue
            time.sleep(poll_seconds)
        except Exception:
            logger.exception("Unhandled exception in report worker loop")
            time.sleep(poll_seconds)
    logger.info("Report worker stopped")


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )
    signal.signal(signal.SIGINT, _request_stop)
    signal.signal(signal.SIGTERM, _request_stop)
    _initialize_runtime_data()
    run_worker_loop()


if __name__ == "__main__":
    main()
