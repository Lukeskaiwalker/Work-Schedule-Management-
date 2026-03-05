#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

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

echo "Applying real migrations..."
docker compose run --rm api sh -lc "cd /app && alembic upgrade head"

echo "Rebuilding and starting services..."
docker compose up -d --build api api_worker web caddy

if [[ -n "$LATEST_BACKUP" ]]; then
  echo "Safe update completed. Latest backup: $LATEST_BACKUP"
else
  echo "Safe update completed."
fi
