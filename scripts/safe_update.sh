#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

MAINTENANCE_ENV_FILE="$ROOT_DIR/infra/.maintenance.env"
MAINTENANCE_PROFILE_ARGS=(--profile maintenance)
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
    echo "After fixing the issue, rerun ./scripts/safe_update.sh or remove $MAINTENANCE_ENV_FILE and run 'docker compose up -d caddy'." >&2
  fi
  exit "$exit_code"
}

enable_maintenance_mode() {
  echo "Enabling maintenance page..."
  cat > "$MAINTENANCE_ENV_FILE" <<EOF
SMPL_API_UPSTREAM=maintenance:80
SMPL_WEB_UPSTREAM=maintenance:80
EOF
  docker compose "${MAINTENANCE_PROFILE_ARGS[@]}" up -d maintenance
  wait_for_service_health maintenance 60
  docker compose "${MAINTENANCE_PROFILE_ARGS[@]}" up -d caddy
  MAINTENANCE_ENABLED=true
}

disable_maintenance_mode() {
  echo "Disabling maintenance page..."
  rm -f "$MAINTENANCE_ENV_FILE"
  docker compose up -d caddy
  docker compose "${MAINTENANCE_PROFILE_ARGS[@]}" stop maintenance >/dev/null 2>&1 || true
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
  git pull --ff-only origin "$BRANCH"
fi

echo "Refreshing release metadata..."
./scripts/update_release_metadata.sh

echo "Building API image..."
docker compose build api

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
docker compose up -d --build api api_worker web caddy

echo "Waiting for API and web services to become healthy..."
wait_for_service_health api
wait_for_service_health web

disable_maintenance_mode

if [[ -n "$LATEST_BACKUP" ]]; then
  echo "Safe update completed. Latest backup: $LATEST_BACKUP"
else
  echo "Safe update completed."
fi
