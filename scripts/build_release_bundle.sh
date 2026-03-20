#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TAG="${1:?usage: build_release_bundle.sh <tag> [output-path] [archive-prefix]}"
OUTPUT_PATH="${2:-${ROOT_DIR}/dist/SMPL-${TAG}.tar.gz}"
ARCHIVE_PREFIX="${3:-SMPL-${TAG}/}"

cd "${ROOT_DIR}"

git rev-parse "${TAG}^{commit}" >/dev/null
mkdir -p "$(dirname "${OUTPUT_PATH}")"

git archive \
  --format=tar.gz \
  --worktree-attributes \
  --prefix="${ARCHIVE_PREFIX}" \
  --output="${OUTPUT_PATH}" \
  "${TAG}"

if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "${OUTPUT_PATH}" > "${OUTPUT_PATH}.sha256"
elif command -v shasum >/dev/null 2>&1; then
  shasum -a 256 "${OUTPUT_PATH}" > "${OUTPUT_PATH}.sha256"
else
  echo "No SHA-256 tool available (expected sha256sum or shasum)." >&2
  exit 1
fi

echo "Created release bundle: ${OUTPUT_PATH}"
echo "Created checksum: ${OUTPUT_PATH}.sha256"
