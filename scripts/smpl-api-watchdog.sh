#!/usr/bin/env bash
# v2.5.11: api container watchdog.
#
# Why this exists
# ===============
# Docker's `unless-stopped` restart policy turned out to be unreliable
# under kernel-level (system-wide) OOM kills. The chain of failure:
#
#   1. Host runs low on memory during the nightly window (~22:00 UTC,
#      when fstrim / mintupdate-automation-upgrade / dpkg-db-backup
#      / apt-daily timers stack up).
#   2. The kernel's global OOM-killer scans all processes and picks
#      the largest user-space victim. That's the api container.
#   3. The kernel SIGKILLs the api's PID 1. The container exits with
#      code 137 (= 128 + SIGKILL) and `OOMKilled=false` (because the
#      kill came from the kernel, not from the cgroup memory
#      controller).
#   4. dockerd sees the exit but the `unless-stopped` restart policy
#      sometimes refuses to fire (suspected: dockerd itself can be
#      affected by the same memory pressure and lose the event).
#   5. The container stays exited until an operator manually clicks
#      Start in Portainer.
#
# Observed on 2026-05-21: api died at 22:28 UTC, restart policy never
# fired, downtime was 6h47min until the operator noticed and clicked
# Start in Portainer. v2.5.6's mem_limit only addresses *cgroup* OOM
# (when the api itself exceeds its memory limit) — it doesn't help
# against system-wide OOM where the api gets picked as the largest
# victim while well below its cgroup ceiling.
#
# This script is the smallest hammer that actually closes the gap.
# Cron invokes it every 2 minutes; worst-case downtime drops from
# 6h47min to ~2min.
#
# Why a defensive watchdog over fixing dockerd
# ============================================
# The cgroup-OOM vs system-OOM detection asymmetry is upstream behaviour
# in dockerd + the kernel. We can't change it from this side. Adding
# system swap or RAM would also help but is hardware work. A pure
# user-space watchdog gives a reliable upper bound on downtime with
# no kernel/daemon/hardware changes.
#
# Idempotence + safety
# ====================
# - Silent no-op when the container is running (the common case).
# - Silent no-op when the container doesn't exist at all (mid-deploy
#   recreate, fresh-install before first compose up). Avoids racing
#   safe_update.sh which manages the container lifecycle itself.
# - Logs only on action (when it actually starts the container) so
#   `tail $LOG_FILE` shows just the events that matter.
# - Captures the previous exit code + OOMKilled flag + finish time
#   before restarting, so future post-mortems have data even when
#   no operator was watching.

set -euo pipefail

CONTAINER="${SMPL_API_CONTAINER:-smpl-all-api-1}"
LOG_DIR="${SMPL_WATCHDOG_LOG_DIR:-/home/mac/scripts/log}"
LOG_FILE="$LOG_DIR/api-watchdog.log"

mkdir -p "$LOG_DIR"

ts() { date -u "+%Y-%m-%dT%H:%M:%SZ"; }
log() { echo "[$(ts)] $*" >> "$LOG_FILE"; }

# Bail silently if docker isn't available (e.g., during a host reboot
# before dockerd is back up). The next watchdog tick will retry.
if ! command -v docker >/dev/null 2>&1; then
  exit 0
fi

# Bail silently if the container doesn't exist at all. This happens
# briefly during safe_update.sh deploys when the container is being
# recreated; starting a not-yet-recreated container would race the
# deploy. The next tick (2 min later) will see the recreated container
# and behave normally.
if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
  exit 0
fi

# Read the canonical running flag. docker inspect renders Go booleans
# as the strings "true" / "false".
running=$(docker inspect "$CONTAINER" --format '{{.State.Running}}')

if [[ "$running" == "true" ]]; then
  # Healthy. Don't log anything (would otherwise flood the log with
  # one no-op line every 2 minutes).
  exit 0
fi

# Container exists but is not running. Capture diagnostic state before
# the restart wipes State.ExitCode etc.
exit_code=$(docker inspect "$CONTAINER" --format '{{.State.ExitCode}}')
oom_killed=$(docker inspect "$CONTAINER" --format '{{.State.OOMKilled}}')
finished_at=$(docker inspect "$CONTAINER" --format '{{.State.FinishedAt}}')

log "─────────────────────────────"
log "$CONTAINER not running:"
log "  Running=$running ExitCode=$exit_code OOMKilled=$oom_killed"
log "  FinishedAt=$finished_at"
log "  attempting docker start..."

if docker start "$CONTAINER" >> "$LOG_FILE" 2>&1; then
  log "docker start returned 0 — container is back up"
else
  rc=$?
  log "docker start FAILED with exit code $rc — manual intervention required"
  exit $rc
fi
