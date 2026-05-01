"""Unit tests for the ::SMPL_STAGE: / ::SMPL_SUMMARY: marker parser.

The parser is the contract between scripts/backup.sh and the runner: any
script can emit these markers and the runner will expose them through
``Job.stage / progress_percent / summary_*`` without further wiring.
Locking the format into tests keeps the contract stable across releases.
"""
from __future__ import annotations

from pathlib import Path

import pytest


def _make_job(runner_tmp_repo: Path):
    """Construct a fresh Job for testing without going through _start_job
    (which would try to claim the global active-job slot)."""
    from app.jobs import Job

    return Job(job_id="test123", kind="backup")


def test_stage_marker_updates_stage_label_and_percent(runner_tmp_repo: Path):
    from app.jobs import _maybe_parse_marker

    job = _make_job(runner_tmp_repo)
    _maybe_parse_marker(
        "::SMPL_STAGE: db_dump 25 Datenbank-Dump\n", job
    )

    assert job.stage == "db_dump"
    assert job.progress_percent == 25
    assert job.stage_label == "Datenbank-Dump"


def test_stage_marker_handles_multi_word_label(runner_tmp_repo: Path):
    """The third token includes spaces — labels like 'Container vorbereiten'
    must come through whole, not truncated at the first whitespace."""
    from app.jobs import _maybe_parse_marker

    job = _make_job(runner_tmp_repo)
    _maybe_parse_marker(
        "::SMPL_STAGE: ensure_containers 5 Container vorbereiten\n", job
    )

    assert job.stage_label == "Container vorbereiten"


def test_stage_marker_clamps_percent_to_0_100(runner_tmp_repo: Path):
    """A buggy script emitting 250 must not poison the progress bar."""
    from app.jobs import _maybe_parse_marker

    job = _make_job(runner_tmp_repo)
    _maybe_parse_marker("::SMPL_STAGE: weird 250 too-high\n", job)
    assert job.progress_percent == 100

    _maybe_parse_marker("::SMPL_STAGE: weirder -5 too-low\n", job)
    assert job.progress_percent == 0


def test_stage_marker_with_malformed_percent_keeps_previous(runner_tmp_repo: Path):
    """If the percent token is not an int, the stage/label still update but
    the previous progress value persists rather than going to None."""
    from app.jobs import _maybe_parse_marker

    job = _make_job(runner_tmp_repo)
    _maybe_parse_marker("::SMPL_STAGE: db_dump 25 Datenbank-Dump\n", job)
    assert job.progress_percent == 25

    _maybe_parse_marker("::SMPL_STAGE: encrypt notanumber Verschlüsselung\n", job)
    assert job.stage == "encrypt"
    assert job.stage_label == "Verschlüsselung"
    assert job.progress_percent == 25  # unchanged


def test_summary_marker_populates_all_fields(runner_tmp_repo: Path):
    from app.jobs import _maybe_parse_marker

    job = _make_job(runner_tmp_repo)
    _maybe_parse_marker(
        "::SMPL_SUMMARY: filename=backup-20260501-145012.tar.enc "
        "size_bytes=3671152672 duration_seconds=492 warnings=1\n",
        job,
    )

    assert job.summary_filename == "backup-20260501-145012.tar.enc"
    assert job.summary_size_bytes == 3671152672
    assert job.summary_duration_seconds == 492
    assert job.summary_warnings == 1


def test_summary_marker_ignores_unknown_keys(runner_tmp_repo: Path):
    """Defense in depth: a future script accidentally emitting extra keys
    must not crash the parser — they should just be ignored."""
    from app.jobs import _maybe_parse_marker

    job = _make_job(runner_tmp_repo)
    _maybe_parse_marker(
        "::SMPL_SUMMARY: filename=ok size_bytes=100 unknown_field=foo "
        "duration_seconds=10 warnings=0 another=bar\n",
        job,
    )

    assert job.summary_filename == "ok"
    assert job.summary_size_bytes == 100
    assert job.summary_duration_seconds == 10
    assert job.summary_warnings == 0


def test_summary_marker_skips_non_int_values(runner_tmp_repo: Path):
    from app.jobs import _maybe_parse_marker

    job = _make_job(runner_tmp_repo)
    _maybe_parse_marker(
        "::SMPL_SUMMARY: filename=ok size_bytes=oops duration_seconds=10 warnings=0\n",
        job,
    )

    assert job.summary_filename == "ok"
    assert job.summary_size_bytes is None  # malformed → not populated
    assert job.summary_duration_seconds == 10


def test_non_marker_lines_are_ignored(runner_tmp_repo: Path):
    """Regular log output (e.g. tar / pg_dump stdout) must not trigger any
    Job state mutation — the function must be a no-op for unrecognized lines."""
    from app.jobs import _maybe_parse_marker

    job = _make_job(runner_tmp_repo)
    _maybe_parse_marker("Creating database dump...\n", job)
    _maybe_parse_marker("tar: ./material_catalog_images: file changed\n", job)
    _maybe_parse_marker(":SMPL_STAGE: not-three-colons 50 close\n", job)

    assert job.stage is None
    assert job.progress_percent is None
    assert job.stage_label is None
    assert job.summary_filename is None
