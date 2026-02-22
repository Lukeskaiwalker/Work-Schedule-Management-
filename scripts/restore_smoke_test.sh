#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ -z "${BACKUP_PASSPHRASE:-}" ]]; then
  export BACKUP_PASSPHRASE="smoketest-passphrase"
fi

MARKER="restore-smoke-$(date +%s)"
MARKER_NUMBER="T-RESTORE-${MARKER}"
MARKER_FILE="/data/uploads/${MARKER}.txt"

on_error() {
  echo "Restore smoke test failed. Current compose state:" >&2
  docker compose ps >&2 || true
  echo "Recent API logs:" >&2
  docker compose logs --tail=80 api >&2 || true
}
trap on_error ERR

echo "Starting db/api for smoke setup..."
docker compose up -d db api

echo "Creating smoke marker data..."
docker compose exec -T db sh -lc "psql -U smpl -d smpl -c \"INSERT INTO projects (project_number, name, description, status, created_by, created_at, extra_attributes) VALUES ('${MARKER_NUMBER}', '${MARKER}', 'restore smoke marker', 'active', NULL, NOW(), '{}'::jsonb);\""
docker compose exec -T api sh -lc "mkdir -p /data/uploads && printf '%s\n' '${MARKER}' > '${MARKER_FILE}'"

./scripts/backup.sh
LATEST_BACKUP="$(ls -1t backups/*.tar.enc | head -n1)"

echo "Removing marker data before restore..."
docker compose exec -T db sh -lc "psql -U smpl -d smpl -c \"DELETE FROM projects WHERE name = '${MARKER}';\""
docker compose exec -T api sh -lc "rm -f '${MARKER_FILE}'"

DB_COUNT_BEFORE="$(docker compose exec -T db sh -lc "psql -U smpl -d smpl -Atc \"SELECT COUNT(*) FROM projects WHERE name = '${MARKER}';\"")"
if [[ "$DB_COUNT_BEFORE" != "0" ]]; then
  echo "Expected marker project to be deleted before restore, got count=${DB_COUNT_BEFORE}" >&2
  exit 1
fi

if docker compose exec -T api sh -lc "[ -f '${MARKER_FILE}' ]"; then
  echo "Expected marker upload file to be deleted before restore" >&2
  exit 1
fi

./scripts/restore.sh "$LATEST_BACKUP"

echo "Validating marker data restored..."
DB_COUNT_AFTER="$(docker compose exec -T db sh -lc "psql -U smpl -d smpl -Atc \"SELECT COUNT(*) FROM projects WHERE name = '${MARKER}';\"")"
if [[ "$DB_COUNT_AFTER" != "1" ]]; then
  echo "Expected marker project count=1 after restore, got count=${DB_COUNT_AFTER}" >&2
  exit 1
fi

if ! docker compose exec -T api sh -lc "[ -f '${MARKER_FILE}' ]"; then
  echo "Expected marker upload file to exist after restore" >&2
  exit 1
fi

echo "Verifying HTTPS endpoint..."
HTTP_CODE="$(curl -k -sS -o /dev/null -w '%{http_code}' https://localhost/api)"
if [[ "$HTTP_CODE" != "200" ]]; then
  echo "Expected https://localhost/api to return 200 after restore, got ${HTTP_CODE}" >&2
  exit 1
fi

echo "Cleaning up smoke marker data..."
docker compose exec -T db sh -lc "psql -U smpl -d smpl -c \"DELETE FROM projects WHERE name = '${MARKER}';\""
docker compose exec -T api sh -lc "rm -f '${MARKER_FILE}'"

echo "Restore smoke test passed with ${LATEST_BACKUP}"
