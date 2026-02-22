#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: ./scripts/import_projects_excel.sh <path-to-xlsx> [sheet-name]" >&2
  exit 1
fi

FILE_PATH="$1"
SHEET_NAME="${2:-}"

if [[ ! -f "$FILE_PATH" ]]; then
  echo "File not found: $FILE_PATH" >&2
  exit 1
fi

TMP_PATH="/tmp/projects_import.xlsx"
docker compose cp "$FILE_PATH" api:"$TMP_PATH"

if [[ -n "$SHEET_NAME" ]]; then
  docker compose exec -T api sh -lc "cd /app && PYTHONPATH=. python scripts/import_projects_excel.py --file '$TMP_PATH' --sheet '$SHEET_NAME' --source-label '$(basename "$FILE_PATH")'"
else
  docker compose exec -T api sh -lc "cd /app && PYTHONPATH=. python scripts/import_projects_excel.py --file '$TMP_PATH' --source-label '$(basename "$FILE_PATH")'"
fi
