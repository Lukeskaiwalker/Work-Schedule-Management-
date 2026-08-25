#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: ./scripts/restore.sh <backup-file.tar.enc>" >&2
  exit 1
fi

BACKUP_FILE="$1"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ ! -f "$BACKUP_FILE" ]]; then
  echo "Backup file not found: $BACKUP_FILE" >&2
  exit 1
fi

# Same .env fallback as backup.sh — see the comment there. It matters more
# here: a restore is run by hand, under pressure, on a box where the operator
# may not remember which of the two passphrase settings this deployment uses.
if [[ -z "${BACKUP_PASSPHRASE:-}" && -z "${BACKUP_PASSPHRASE_FILE:-}" && -f .env ]]; then
  for _key in BACKUP_PASSPHRASE BACKUP_PASSPHRASE_FILE; do
    _value="$(sed -n "s/^${_key}=//p" .env | head -n1)"
    _value="${_value%\"}"; _value="${_value#\"}"
    _value="${_value%\'}"; _value="${_value#\'}"
    if [[ -n "${_value}" ]]; then
      export "${_key}=${_value}"
    fi
  done
  unset _key _value
fi

if [[ -z "${BACKUP_PASSPHRASE:-}" && -n "${BACKUP_PASSPHRASE_FILE:-}" ]]; then
  if [[ ! -f "${BACKUP_PASSPHRASE_FILE}" ]]; then
    echo "BACKUP_PASSPHRASE_FILE not found: ${BACKUP_PASSPHRASE_FILE}" >&2
    exit 1
  fi
  BACKUP_PASSPHRASE="$(<"${BACKUP_PASSPHRASE_FILE}")"
  export BACKUP_PASSPHRASE
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

create_tmp_dir() {
  local dir
  # Restore stages the decrypted tar AND its extracted contents — roughly 20 GB
  # for a 6.3 GB archive. /tmp is a 3.9 GB tmpfs, so a bare mktemp -d makes the
  # recovery path fail exactly when it is needed.
  mkdir -p "${RESTORE_STAGING_ROOT:-/var/tmp}"
  dir="$(mktemp -d "${RESTORE_STAGING_ROOT:-/var/tmp}/smpl-restore.XXXXXXXX")"
  chmod 700 "$dir"
  printf '%s\n' "$dir"
}

copy_to_container() {
  local source_path="$1"
  local service="$2"
  local dest_path="$3"
  cat "$source_path" | docker compose exec -T "$service" sh -lc "cat > '$dest_path'"
}

TMP_DIR="$(create_tmp_dir)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

RAW_TAR="${TMP_DIR}/restore.tar"
openssl enc -d -aes-256-cbc -pbkdf2 -in "$BACKUP_FILE" -out "$RAW_TAR" -pass env:BACKUP_PASSPHRASE

tar -xf "$RAW_TAR" -C "$TMP_DIR"

echo "Starting database + api containers..."
# --no-recreate: recreating api here would run its CMD `alembic upgrade head`
# against the database we are about to pg_restore into — re-applying the very
# migration a restore may be rolling back.
docker compose up -d --no-recreate db api
wait_for_db

echo "Restoring database..."
copy_to_container "${TMP_DIR}/db.dump" db /tmp/db.dump
docker compose exec -T db sh -lc "pg_restore -U smpl -d smpl --clean --if-exists /tmp/db.dump"
docker compose exec -T db rm -f /tmp/db.dump

echo "Restoring uploads volume..."
copy_to_container "${TMP_DIR}/uploads.tar.gz" api /tmp/uploads.tar.gz
docker compose exec -T api sh -lc "mkdir -p /data/uploads && rm -rf /data/uploads/* && tar xzf /tmp/uploads.tar.gz -C /data/uploads"
docker compose exec -T api rm -f /tmp/uploads.tar.gz

if [[ "${RESTORE_START_FULL_STACK:-true}" == "true" ]]; then
  echo "Starting full stack..."
  # `caddy` was folded into the single `web` container in ea62f63 (2026-04-27).
  # Naming it here made every restore exit non-zero after succeeding.
  docker compose up -d web
fi

echo "Restore completed from $BACKUP_FILE"
