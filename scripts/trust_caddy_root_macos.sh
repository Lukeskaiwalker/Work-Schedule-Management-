#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This script is for macOS only." >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

CERT_DIR="${ROOT_DIR}/output/certs"
CERT_PATH="${CERT_DIR}/caddy-local-root.crt"
KEYCHAIN="${HOME}/Library/Keychains/login.keychain-db"

mkdir -p "$CERT_DIR"

echo "Ensuring Caddy is running..."
docker compose up -d caddy

echo "Exporting Caddy local root certificate..."
docker compose exec -T caddy sh -lc "cat /data/caddy/pki/authorities/local/root.crt" > "$CERT_PATH"

echo "Installing certificate into login keychain..."
security add-trusted-cert -d -r trustRoot -k "$KEYCHAIN" "$CERT_PATH"

echo "Done. Trusted cert saved at: $CERT_PATH"
echo "You can now open: https://localhost"
