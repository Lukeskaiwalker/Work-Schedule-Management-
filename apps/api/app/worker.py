from __future__ import annotations

import asyncio
import logging
import signal
import time

from app.core.config import get_settings
from app.core.db import SessionLocal
from app.main import _initialize_runtime_data
from app.services.daily_clock_summary import dispatch_daily_clock_summary_if_due
from app.services.report_jobs import claim_next_construction_report_job, process_construction_report_job

logger = logging.getLogger("smpl.report_worker")
settings = get_settings()
_stop_requested = False

# Daily-summary check is bounded to once per minute regardless of the
# faster report poll interval. Keeps DB pressure trivial.
_daily_summary_check_interval_seconds = 60.0
_last_daily_summary_check_at: float = 0.0


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


def run_worker_loop() -> None:
    poll_seconds = max(0.2, float(settings.report_worker_poll_seconds))
    logger.info("Starting report worker (poll=%ss)", poll_seconds)
    while not _stop_requested:
        try:
            _maybe_run_daily_summary()
            with SessionLocal() as db:
                job = claim_next_construction_report_job(db)
                if not job:
                    time.sleep(poll_seconds)
                    continue
                logger.info("Processing construction report job %s", job.id)
                asyncio.run(process_construction_report_job(db, job.id))
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
