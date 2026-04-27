"""Runtime configuration for the update runner sidecar.

All values come from environment variables so the same image works in dev and
prod. Defaults are tuned for the local Docker stack — most production
overrides happen via docker-compose.yml ``environment:`` keys.
"""
from __future__ import annotations

import os
from pathlib import Path


def _env_path(key: str, default: str) -> Path:
    return Path(os.environ.get(key, default))


def _env_str(key: str, default: str = "") -> str:
    return os.environ.get(key, default)


# Where the host's repo is bind-mounted inside this container. ``safe_update.sh``
# is invoked with this as cwd so all of its relative paths (./scripts/*,
# ./infra/*, ./backups/*) resolve correctly.
REPO_ROOT: Path = _env_path("UPDATE_RUNNER_REPO_ROOT", "/repo")

# Per-job stdout/stderr capture. Volume-mounted so logs survive runner
# restarts and remain greppable for forensic debugging.
JOB_LOG_DIR: Path = _env_path("UPDATE_RUNNER_LOG_DIR", "/var/log/update_runner")

# Shared secret between api and runner. Optional but recommended: even though
# the runner only listens on the docker-internal network, defense-in-depth
# protects against future co-located services and accidental host exposure.
EXPECTED_TOKEN: str = _env_str("UPDATE_RUNNER_TOKEN", "")

# Forced project name for ``docker compose`` invocations. Without this the
# runner would derive the project name from its bind-mount directory (/repo)
# and create a parallel ghost stack instead of touching the running one.
COMPOSE_PROJECT_NAME: str = _env_str("COMPOSE_PROJECT_NAME", "smplall")

# Cap on the log tail returned in GET /jobs/{id}. Generous enough to surface
# meaningful context, small enough that polling clients don't drown.
LOG_TAIL_BYTES: int = int(_env_str("UPDATE_RUNNER_LOG_TAIL_BYTES", "16384"))


def ensure_directories() -> None:
    """Create runtime directories that must exist before serving requests."""
    JOB_LOG_DIR.mkdir(parents=True, exist_ok=True)
