#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

run_local_api_tests() {
  local py_bin
  if command -v python3.12 >/dev/null 2>&1; then
    py_bin="python3.12"
  else
    py_bin="python3"
  fi

  if [[ ! -d .venv ]]; then
    "$py_bin" -m venv .venv
  fi
  source .venv/bin/activate
  pip install -q -r apps/api/requirements.txt
  (cd apps/api && PYTHONPATH=. pytest -q)
}

if docker info >/dev/null 2>&1; then
  docker compose run --build --rm api sh -lc 'cd /app && PYTHONPATH=. pytest -q'
else
  echo "Docker daemon unavailable. Running API tests locally."
  run_local_api_tests
fi

(cd apps/web && npm install --silent && npm run build)

echo "All tests/build checks passed."
