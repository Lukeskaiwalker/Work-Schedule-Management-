#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required" >&2
  exit 1
fi

wait_for_db() {
  local retries=45
  until docker compose exec -T db sh -lc "pg_isready -U smpl -d smpl" >/dev/null 2>&1; do
    retries=$((retries - 1))
    if [[ "$retries" -le 0 ]]; then
      echo "Database did not become ready in time" >&2
      exit 1
    fi
    sleep 1
  done
}

TMP_DIR="$(mktemp -d)"
TIMESTAMP="$(date +%Y%m%d%H%M%S)"
TMP_DB="smpl_preflight_${TIMESTAMP}_$RANDOM"
TMP_DB="${TMP_DB//[^a-zA-Z0-9_]/_}"

cleanup() {
  docker compose exec -T db sh -lc "psql -U smpl -d postgres -v ON_ERROR_STOP=1 -c \"DROP DATABASE IF EXISTS ${TMP_DB} WITH (FORCE);\"" >/dev/null 2>&1 || true
  docker compose exec -T db rm -f /tmp/preflight.dump >/dev/null 2>&1 || true
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

echo "Ensuring database + api services are running..."
docker compose up -d db api >/dev/null
wait_for_db

echo "Creating source database dump for migration preflight..."
docker compose exec -T db sh -lc "pg_dump -U smpl -d smpl -F c -f /tmp/preflight.dump"
docker compose cp db:/tmp/preflight.dump "${TMP_DIR}/preflight.dump"

echo "Creating temporary preflight database: ${TMP_DB}"
docker compose exec -T db sh -lc "psql -U smpl -d postgres -v ON_ERROR_STOP=1 -c \"CREATE DATABASE ${TMP_DB};\""
docker compose cp "${TMP_DIR}/preflight.dump" db:/tmp/preflight.dump
docker compose exec -T db sh -lc "pg_restore -U smpl -d ${TMP_DB} --no-owner --no-privileges /tmp/preflight.dump"

echo "Running Alembic upgrade on temporary clone..."
docker compose run --rm -e "DATABASE_URL=postgresql+psycopg2://smpl:smpl@db:5432/${TMP_DB}" api sh -lc "cd /app && alembic upgrade head"

echo "Migration preflight passed. Real database was not modified."
