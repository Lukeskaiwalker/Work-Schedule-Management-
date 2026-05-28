#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# Maintenance mode is now driven by a single sentinel file inside
# infra/maintenance/. The web container has that directory mounted read-only
# and Caddy's `file` matcher checks for the flag at *request time*, so
# creating or removing the file flips the page instantly with no reload,
# no restart, and no dropped connections.
MAINTENANCE_FLAG_FILE="$ROOT_DIR/infra/maintenance/.flag"
# Legacy env file from the older two-container layout. Cleaned up on entry
# so a stale leftover from a previous version of this script can't influence
# the new web container's env.
LEGACY_MAINTENANCE_ENV_FILE="$ROOT_DIR/infra/.maintenance.env"
MAINTENANCE_ENABLED=false

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required" >&2
  exit 1
fi

PULL_REPO=false
BRANCH="main"
CHECK_ONLY=false

usage() {
  cat <<USAGE
Usage: ./scripts/safe_update.sh [--pull] [--branch <name>] [--check-only]

Options:
  --pull         Run 'git fetch' + 'git pull --ff-only' before preflight.
  --branch       Branch to pull when --pull is used (default: main).
  --check-only   Build API image + run DB migration preflight only. No backup, no migration, no deploy.
USAGE
}

cleanup_on_error() {
  local exit_code=$?
  if [[ $exit_code -ne 0 && "$MAINTENANCE_ENABLED" == "true" ]]; then
    echo "Update interrupted. Maintenance page remains enabled." >&2
    echo "After fixing the issue, rerun ./scripts/safe_update.sh or remove $MAINTENANCE_FLAG_FILE to exit maintenance mode." >&2
  fi
  exit "$exit_code"
}

enable_maintenance_mode() {
  echo "Enabling maintenance page..."
  # Drop a stale env file from the previous two-container design if it's
  # still hanging around — otherwise it would silently keep injecting the
  # old upstream-swap variables into web's env.
  rm -f "$LEGACY_MAINTENANCE_ENV_FILE"
  # The flag file is what Caddy's `file` matcher checks at request time.
  # No container restart needed — the next incoming request will see the
  # maintenance page.
  touch "$MAINTENANCE_FLAG_FILE"
  MAINTENANCE_ENABLED=true
}

disable_maintenance_mode() {
  echo "Disabling maintenance page..."
  rm -f "$MAINTENANCE_FLAG_FILE"
  MAINTENANCE_ENABLED=false
}

wait_for_service_health() {
  local service=$1
  local timeout_seconds=${2:-120}
  local waited=0
  local container_id=""
  local status=""

  while (( waited < timeout_seconds )); do
    container_id="$(docker compose ps -q "$service" 2>/dev/null || true)"
    if [[ -n "$container_id" ]]; then
      status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_id" 2>/dev/null || true)"
      if [[ "$status" == "healthy" || "$status" == "running" ]]; then
        return 0
      fi
    fi
    sleep 2
    waited=$((waited + 2))
  done

  echo "Timed out waiting for service '$service' to become healthy (last status: ${status:-unknown})." >&2
  return 1
}

trap cleanup_on_error EXIT

while [[ $# -gt 0 ]]; do
  case "$1" in
    --pull)
      PULL_REPO=true
      shift
      ;;
    --branch)
      shift
      if [[ $# -lt 1 ]]; then
        echo "--branch requires a value" >&2
        exit 1
      fi
      BRANCH="$1"
      shift
      ;;
    --check-only)
      CHECK_ONLY=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if $PULL_REPO; then
  if ! command -v git >/dev/null 2>&1; then
    echo "git is required for --pull mode" >&2
    exit 1
  fi
  if [[ ! -d .git ]]; then
    echo "No .git directory found in $ROOT_DIR" >&2
    exit 1
  fi
  echo "Fetching latest code and pulling branch '${BRANCH}'..."
  git fetch --tags --prune origin
  # v2.5.2: tolerate host-side drift. In-place hotfixes (where the
  # operator or an SSH session has modified tracked files directly on
  # the host) used to abort the pull with "Your local changes to the
  # following files would be overwritten by merge." The next four
  # releases each hit this exact wall:
  #   - v2.4.10 ↔ docker-compose.traefik.yml (scoped buffering hotfix)
  #   - v2.4.11 ↔ apps/api/requirements.txt (openai 1.55.3 hotfix)
  # In every case the host's working-tree change had already been
  # mirrored to git as part of the corresponding release commit, so
  # the safe move is: stash → pull → pop.
  #
  # v2.5.12: extend to UNTRACKED files too. v2.5.11 hit a different
  # variant of the same wall: a new file (scripts/smpl-api-watchdog.sh)
  # was scp'd to the host before the commit landed upstream, so it
  # existed as untracked locally. The next pull tried to add the same
  # file from upstream and aborted with "The following untracked
  # working tree files would be overwritten by merge". v2.5.2's stash
  # logic explicitly excluded untracked files (--untracked-files=no);
  # this extension uses `git stash -u` so both classes of drift are
  # tolerated by the same code path.
  STASH_LABEL="safe-update-auto-$(date -u +%Y%m%dT%H%M%SZ)"
  STASH_MADE=false
  # --untracked-files=normal includes untracked files in the dirty-tree
  # check, so we stash them too when present. The previous --untracked-
  # files=no caused untracked-only drift to skip the stash step entirely
  # and abort the pull.
  if [[ -n "$(git status --porcelain --untracked-files=normal)" ]]; then
    echo "Host working tree has uncommitted changes; stashing as '${STASH_LABEL}'..."
    # `git stash push -u` includes untracked files (but not ignored ones).
    # The fallback path is kept for older git versions that handle
    # explicit-pathspec stash differently. Both branches now include
    # untracked files via the -u flag.
    if git stash push -u --message "$STASH_LABEL" >/dev/null 2>&1 \
        || git stash push -u --message "$STASH_LABEL" -- $(git status --porcelain --untracked-files=normal | awk '{print $2}') >/dev/null 2>&1; then
      STASH_MADE=true
    else
      echo "WARNING: stash failed. Continuing — pull may still abort with the original conflict." >&2
    fi
  fi
  if ! git pull --ff-only origin "$BRANCH"; then
    echo "git pull --ff-only failed." >&2
    if [[ "$STASH_MADE" == "true" ]]; then
      echo "Restoring the stashed local changes so the host returns to its pre-pull state..." >&2
      git stash pop >/dev/null 2>&1 || true
    fi
    exit 1
  fi
  if [[ "$STASH_MADE" == "true" ]]; then
    # Attempt to restore the stash. When the upstream version is
    # IDENTICAL to the local mod (most common — operator hotfixed in
    # place, then commit landed upstream with the same content), the
    # pop is a no-op or a trivial conflict we can drop. When upstream
    # genuinely differs, the pop conflicts — we leave the stash in
    # place and tell the operator how to handle it.
    #
    # v2.5.12 note: when the stash contained an untracked file whose
    # name matches a file the pull just added as tracked, `git stash
    # pop` will refuse with "already exists, no checkout". That's the
    # expected case — upstream's version is what we want; the stash
    # is informational. We surface the stash label so the operator
    # can inspect / drop it manually.
    if ! git stash pop >/dev/null 2>&1; then
      echo "Stashed changes diverged from upstream; the stash is preserved." >&2
      echo "Inspect it with 'git stash list' / 'git stash show -p ${STASH_LABEL}'." >&2
      # We do NOT abort here — the host code is at the new upstream
      # commit, which is what the deploy wants. The stash is informational.
    fi
  fi
fi

echo "Refreshing release metadata..."
./scripts/update_release_metadata.sh

# Export the freshly-written values so `docker compose build` forwards them
# to the api Dockerfile's ARGs. This is the belt-and-braces path: even on
# Compose versions < 2.24 (which silently skip env_file `path:/required:`
# long-form) the api image still ends up with /app/.release.env populated.
if [[ -f apps/api/.release.env ]]; then
  set -a
  # shellcheck disable=SC1091
  . ./apps/api/.release.env
  set +a
fi

echo "Building API + update_runner images..."
# update_runner has its own Dockerfile and requirements.txt, so any change to
# apps/update_runner/ (new endpoints, new dependencies — see v2.3.0's backup
# feature) is NOT picked up by `docker compose up -d` alone — Compose reuses
# the cached image when no build is requested. Including update_runner in the
# explicit build step here means every safe_update run produces a fresh image
# matching the pulled source, never a stale one.
docker compose build api update_runner

LATEST_BACKUP=""
if ! $CHECK_ONLY; then
  echo "Creating encrypted safety backup before preflight..."
  ./scripts/backup.sh
  LATEST_BACKUP="$(ls -1t backups/*.tar.enc 2>/dev/null | head -n1 || true)"
fi

echo "Running migration preflight..."
./scripts/preflight_migrations.sh

if $CHECK_ONLY; then
  echo "Check-only mode complete."
  exit 0
fi

enable_maintenance_mode

echo "Applying real migrations..."
docker compose run --rm api sh -lc "cd /app && alembic upgrade head"

echo "Rebuilding and starting services..."
docker compose up -d --build api api_worker web

# v2.4.8: deferred runner recreate to escape the self-replacement deadlock.
#
# Background — the v2.4.6 incident:
#   safe_update.sh runs INSIDE the update_runner container. The previous
#   in-script ``docker compose up -d --build --force-recreate update_runner``
#   asked Docker Compose to stop the very container executing this script.
#   The runner was killed mid-recreate, its name slot didn't fully release,
#   and the next "create renamed copy" step exited 128 with
#   "Error when allocating new name: Conflict. The container name
#   '/smpl-all-update_runner-1' is already in use."
#   Result: orphan ``<sha>_smpl-all-update_runner-1`` containers in
#   ``Created`` state and the runner offline until manually restarted.
#
# Fix:
#   1. Detect whether the runner's image actually changed since the
#      previous deploy. Most releases only touch api/api_worker/web code,
#      so the running runner is already on the latest image and a
#      recreate is wasteful (and risky — see above).
#   2. When the image DID change, spawn a transient "trampoline"
#      container that waits for safe_update.sh to exit, cleans up any
#      orphan ``<sha>_smpl-all-update_runner-1`` left by a prior failed
#      recreate, and runs ``docker compose up -d update_runner`` from
#      outside the runner. The trampoline lives in its own container, so
#      the runner's stop doesn't kill it.
#   3. The runner image itself was just rebuilt by ``docker compose
#      build api update_runner`` higher up, so the new image is on disk
#      regardless of whether we trigger the recreate here.

RUNNER_RUNNING_IMAGE="$(docker inspect --format '{{.Image}}' smpl-all-update_runner-1 2>/dev/null || true)"
RUNNER_LATEST_IMAGE="$(docker images --no-trunc --format '{{.ID}}' smpl-all-update_runner 2>/dev/null | head -n1 || true)"

if [[ -n "$RUNNER_LATEST_IMAGE" && -n "$RUNNER_RUNNING_IMAGE" \
      && "$RUNNER_RUNNING_IMAGE" != "$RUNNER_LATEST_IMAGE" ]]; then
  echo "update_runner image changed; scheduling deferred recreate via trampoline container..."

  # The runner has the host's repo bind-mounted at /repo. Look up the
  # *host* path of that mount so the trampoline container can run
  # ``docker compose`` against the same compose files.
  REPO_HOST_PATH="$(docker inspect \
    --format '{{range .Mounts}}{{if eq .Destination "/repo"}}{{.Source}}{{end}}{{end}}' \
    smpl-all-update_runner-1 2>/dev/null || true)"

  if [[ -z "$REPO_HOST_PATH" ]]; then
    echo "WARNING: could not resolve host path for /repo bind mount." >&2
    echo "         Recreate the runner manually after this script:" >&2
    echo "           docker compose up -d --build --force-recreate update_runner" >&2
  else
    # Detached trampoline. ``--rm -d`` runs it in the background and cleans
    # the container up after the recreate finishes. The 12s sleep gives
    # safe_update.sh time to return its exit status to the runner's HTTP
    # response (the runner reports success to the api before being stopped).
    if docker run --rm -d \
        --name smpl-update-runner-trampoline \
        -v /var/run/docker.sock:/var/run/docker.sock \
        -v "${REPO_HOST_PATH}:/repo" \
        -w /repo \
        -e COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-smpl-all}" \
        -e HOST_REPO_PATH="${REPO_HOST_PATH}" \
        docker:cli \
        sh -c '
          set -eu
          sleep 12

          # Drop any orphan renamed copies left by a prior failed recreate
          # (Docker generates a "<sha>_<original-name>" stub when stop
          # races with rename — they accumulate as zombies in Created
          # state otherwise).
          for orphan in $(docker ps -a --format "{{.Names}}" \
              | grep -E "^[0-9a-f]{12}_smpl-all-update_runner-1$" || true); do
            docker rm -f "$orphan" >/dev/null 2>&1 || true
          done

          # v2.5.3: critical detail — pass --project-directory pointing
          # at the HOST repo path. Without this, compose resolves the
          # ``- .:/repo`` volume binding relative to the trampoline''s
          # filesystem (where /repo is the bind-mounted repo), producing
          # a HOST-side bind source of "/repo". The daemon then auto-
          # creates an empty /repo dir on the host and binds THAT to the
          # new runner — which is how the v2.5.2 → v2.5.3 deploy broke
          # backups: the runner saw an empty backups dir despite the
          # host having 25+ files. --project-directory forces compose
          # to resolve "." to the actual host path, which is what the
          # daemon then sees.
          docker compose --project-directory "$HOST_REPO_PATH" up -d update_runner
        ' >/dev/null 2>&1; then
      echo "Trampoline container scheduled; runner will be recreated within ~15s of script exit."
    else
      echo "WARNING: trampoline container failed to start." >&2
      echo "         Recreate the runner manually:" >&2
      echo "           docker compose up -d --build --force-recreate update_runner" >&2
    fi
  fi
else
  echo "update_runner image unchanged; skipping recreate."
fi

echo "Waiting for API and web services to become healthy..."
wait_for_service_health api
wait_for_service_health web
# Note: update_runner health is intentionally NOT awaited here — when
# the trampoline path fires the recreate is asynchronous and would
# briefly fail healthcheck while restarting. The api falls back to
# "runner unreachable" gracefully if a request hits during the gap.

disable_maintenance_mode

# v2.5.33 — post-deploy housekeeping to stop the disk filling up.
#
# Root cause of the 2026-05-28 outage: every deploy rebuilds the api,
# api_worker and web images, which leaves the previous image layers
# DANGLING and grows the build cache. After ~12 releases the 219 GB
# disk hit 100%, which wedged Postgres (couldn't fsync WAL → unhealthy)
# and the web container (runtime couldn't write its exec FIFO → "procReady
# not received") and took the whole site down with a 404. Manual cleanup
# reclaimed ~101 GB (61 GB build cache + 40 GB unused images).
#
# Runs AFTER disable_maintenance_mode so the site is already back online
# before we spend time on cleanup. Uses the NON-destructive variants:
#   - ``docker image prune -f`` removes only DANGLING images (the
#     untagged predecessors of the images we just rebuilt). It never
#     touches tagged or in-use images, so the other stacks on this
#     host (garage, tesla-proxy, jellyfin, …) are unaffected.
#   - ``docker builder prune -f --keep-storage 10GB`` caps the build
#     cache at ~10 GB — recent layers stay for fast rebuilds, the long
#     tail is trimmed. Falls back to a plain prune if the installed
#     Docker doesn't accept --keep-storage.
# Both are wrapped with `|| true` so a cleanup hiccup can never fail a
# deploy that has already succeeded.
echo "Post-deploy cleanup: pruning dangling images + capping build cache..."
docker image prune -f 2>&1 | tail -1 || echo "  (image prune skipped)"
docker builder prune -f --keep-storage 10GB 2>&1 | tail -1 \
  || docker builder prune -f 2>&1 | tail -1 \
  || echo "  (builder prune skipped)"
echo "Disk after cleanup:"
df -h / | tail -1 || true

if [[ -n "$LATEST_BACKUP" ]]; then
  echo "Safe update completed. Latest backup: $LATEST_BACKUP"
else
  echo "Safe update completed."
fi
