#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required" >&2
  exit 1
fi

if [[ -z "${BACKUP_PASSPHRASE:-}" ]]; then
  echo "BACKUP_PASSPHRASE must be set" >&2
  exit 1
fi

wait_for_db() {
  local retries=30
  until docker compose exec -T db sh -lc "pg_isready -U smpl -d smpl" >/dev/null 2>&1; do
    retries=$((retries - 1))
    if [[ "$retries" -le 0 ]]; then
      echo "Database did not become ready in time" >&2
      exit 1
    fi
    sleep 1
  done
}

mkdir -p backups
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
TMP_DIR="$(mktemp -d)"
ARCHIVE_RAW="${TMP_DIR}/backup-${TIMESTAMP}.tar"
ARCHIVE_ENC="${ROOT_DIR}/backups/backup-${TIMESTAMP}.tar.enc"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

echo "Ensuring database + api containers are running..."
docker compose up -d db api
wait_for_db

echo "Creating database dump..."
docker compose exec -T db sh -lc "pg_dump -U smpl -d smpl -F c -f /tmp/db.dump"
docker compose cp db:/tmp/db.dump "${TMP_DIR}/db.dump"
docker compose exec -T db rm -f /tmp/db.dump

echo "Exporting encrypted upload volume..."
docker compose exec -T api sh -lc "mkdir -p /tmp && tar czf /tmp/uploads.tar.gz -C /data/uploads . || true"
docker compose cp api:/tmp/uploads.tar.gz "${TMP_DIR}/uploads.tar.gz"
docker compose exec -T api rm -f /tmp/uploads.tar.gz

cat > "${TMP_DIR}/manifest.txt" <<MANIFEST
created_at=${TIMESTAMP}
format=smpl-backup-v1
MANIFEST

tar -cf "$ARCHIVE_RAW" -C "$TMP_DIR" db.dump uploads.tar.gz manifest.txt
openssl enc -aes-256-cbc -pbkdf2 -salt -in "$ARCHIVE_RAW" -out "$ARCHIVE_ENC" -pass env:BACKUP_PASSPHRASE

echo "Encrypted backup created: $ARCHIVE_ENC"
