#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# ── progress markers ──────────────────────────────────────────────────────────
# These lines are parsed by apps/update_runner/app/jobs.py to populate the
# Job.stage / progress_percent / summary_* fields. They're also still written
# to the log file unchanged so an operator can see the breadcrumbs in the log
# tail. Format is intentionally simple so a human-readable grep tells the
# whole story:
#
#   ::SMPL_STAGE: <key> <percent> <human-label>
#   ::SMPL_SUMMARY: filename=<f> size_bytes=<n> duration_seconds=<n> warnings=<n>
#
# Safe to add more stages later — unknown stage keys are passed through to the
# UI verbatim, so frontend changes are decoupled from script changes.
emit_stage() {
  printf '::SMPL_STAGE: %s %d %s\n' "$1" "$2" "$3"
}

emit_summary() {
  printf '::SMPL_SUMMARY: filename=%s size_bytes=%d duration_seconds=%d warnings=%d\n' \
    "$1" "$2" "$3" "$4"
}

START_EPOCH="$(date +%s)"
WARNINGS=0

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required" >&2
  exit 1
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
  dir="$(mktemp -d)"
  chmod 700 "$dir"
  printf '%s\n' "$dir"
}

copy_from_container() {
  local service="$1"
  local source_path="$2"
  local dest_path="$3"
  docker compose exec -T "$service" sh -lc "cat '$source_path'" > "$dest_path"
}

mkdir -p backups
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
TMP_DIR="$(create_tmp_dir)"
ARCHIVE_RAW="${TMP_DIR}/backup-${TIMESTAMP}.tar"
ARCHIVE_ENC="${ROOT_DIR}/backups/backup-${TIMESTAMP}.tar.enc"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

emit_stage "ensure_containers" 5 "Container vorbereiten"
echo "Ensuring database + api containers are running..."
docker compose up -d db api
wait_for_db

emit_stage "db_dump" 25 "Datenbank-Dump"
echo "Creating database dump..."
docker compose exec -T db sh -lc "pg_dump -U smpl -d smpl -F c -f /tmp/db.dump"
copy_from_container db /tmp/db.dump "${TMP_DIR}/db.dump"
docker compose exec -T db rm -f /tmp/db.dump

emit_stage "archive_volume" 60 "Upload-Archiv"
echo "Exporting encrypted upload volume..."
# Stream tar's stderr into a temp file so we can count "file changed" warnings
# (benign — concurrent writes to /data/uploads while we read) without losing
# anything from the operator's view of the log.
TAR_STDERR="${TMP_DIR}/tar-stderr.log"
docker compose exec -T api sh -lc "mkdir -p /tmp && tar czf /tmp/uploads.tar.gz -C /data/uploads . 2>/tmp/tar-stderr.log || true"
copy_from_container api /tmp/uploads.tar.gz "${TMP_DIR}/uploads.tar.gz"
copy_from_container api /tmp/tar-stderr.log "$TAR_STDERR" 2>/dev/null || true
docker compose exec -T api rm -f /tmp/uploads.tar.gz /tmp/tar-stderr.log
if [[ -f "$TAR_STDERR" ]]; then
  cat "$TAR_STDERR"
  WARNINGS=$(grep -c -E "file changed as we read it|File removed before we read it" "$TAR_STDERR" 2>/dev/null || true)
  WARNINGS=${WARNINGS:-0}
fi

emit_stage "manifest" 80 "Manifest schreiben"
cat > "${TMP_DIR}/manifest.txt" <<MANIFEST
created_at=${TIMESTAMP}
format=smpl-backup-v1
MANIFEST

emit_stage "encrypt" 90 "Verschlüsselung"
tar -cf "$ARCHIVE_RAW" -C "$TMP_DIR" db.dump uploads.tar.gz manifest.txt
openssl enc -aes-256-cbc -pbkdf2 -salt -in "$ARCHIVE_RAW" -out "$ARCHIVE_ENC" -pass env:BACKUP_PASSPHRASE

emit_stage "done" 100 "Fertig"
echo "Encrypted backup created: $ARCHIVE_ENC"

# Final summary marker — runner uses this to populate the success card with
# size + duration so the UI can render "3.42 GB · 8m 12s · 1 warning" rather
# than just a green checkmark.
ARCHIVE_SIZE_BYTES="$(stat -c%s "$ARCHIVE_ENC" 2>/dev/null || stat -f%z "$ARCHIVE_ENC")"
DURATION_SECONDS="$(( $(date +%s) - START_EPOCH ))"
emit_summary "$(basename "$ARCHIVE_ENC")" "$ARCHIVE_SIZE_BYTES" "$DURATION_SECONDS" "$WARNINGS"
