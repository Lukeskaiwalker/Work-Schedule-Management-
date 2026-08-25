#!/usr/bin/env bash
#
# Start the SMPL label agent, print its URL, and open the station page.
#
# Usage:
#   ./run.sh                 # normal operation (USB printer expected)
#   ./run.sh --no-printer    # no hardware; prints are simulated
#   AGENT_PORT=9000 ./run.sh # different port
#   NO_BROWSER=1 ./run.sh    # headless
#
# Rehearsing the SD-card import with no instrument to hand:
#   python3 server.py --make-fixtures /tmp/cards
#   ./run.sh --no-printer --sd-simulate /tmp/cards
#
# Any argument is forwarded to server.py untouched.
#
# On the office Pi this script is NOT the entry point - systemd is. See
# packaging/smpl-station.service and docs/PI_STATION.md. This is for a bench,
# a laptop, and for debugging the Pi by hand once you are on it.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

export AGENT_HOST="${AGENT_HOST:-127.0.0.1}"
export AGENT_PORT="${AGENT_PORT:-8765}"

# An explicit --port on the command line wins, so the URL we print is right.
prev=""
for arg in "$@"; do
  case "$prev" in
    --port) AGENT_PORT="$arg" ;;
    --host) AGENT_HOST="$arg" ;;
  esac
  case "$arg" in
    --port=*) AGENT_PORT="${arg#*=}" ;;
    --host=*) AGENT_HOST="${arg#*=}" ;;
  esac
  prev="$arg"
done

# --------------------------------------------------------------------------
# Interpreter: reuse whatever already has the two dependencies, and only build
# a virtualenv when nothing on the box does. Starting must stay cheap.
# --------------------------------------------------------------------------
have_deps() { "$1" -c "import usb, PIL" >/dev/null 2>&1; }

PY=""
if [ -n "${PYTHON:-}" ]; then
  PY="$PYTHON"
elif [ -x "$HERE/.venv/bin/python" ]; then
  PY="$HERE/.venv/bin/python"
elif command -v python3 >/dev/null 2>&1 && have_deps python3; then
  PY="python3"
fi

if [ -z "$PY" ]; then
  echo "==> installing dependencies into $HERE/.venv (one time)"
  python3 -m venv "$HERE/.venv"
  "$HERE/.venv/bin/python" -m pip install --quiet --upgrade pip
  "$HERE/.venv/bin/python" -m pip install --quiet -r "$HERE/requirements.txt"
  PY="$HERE/.venv/bin/python"
fi

if ! have_deps "$PY"; then
  echo "!! $PY cannot import pyusb/pillow - printing will be unavailable."
  echo "!! Scanning, counting, exporting and SD import still work. Fix with:"
  echo "!!   $PY -m pip install -r $HERE/requirements.txt"
  # pip installs pyusb but not the native library it binds to, and the package
  # name differs per platform - which is the single most common reason a fresh
  # box imports pyusb happily and then cannot find a printer.
  case "$(uname -s)" in
    Linux)  echo "!! ...and the native library: sudo apt install libusb-1.0-0" ;;
    Darwin) echo "!! ...and the native library: brew install libusb" ;;
  esac
fi

URL="http://${AGENT_HOST}:${AGENT_PORT}/"

# --------------------------------------------------------------------------
# Run
# --------------------------------------------------------------------------
"$PY" "$HERE/server.py" "$@" &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true; wait "$SERVER_PID" 2>/dev/null || true' EXIT INT TERM

# Wait for /health rather than sleeping a fixed amount - it is usually instant.
for _ in $(seq 1 50); do
  if curl -fsS --max-time 1 "${URL}health" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "!! server exited during startup"
    wait "$SERVER_PID"
    exit 1
  fi
  sleep 0.1
done

echo
echo "  Station ready: $URL"
echo "  Stop with Ctrl-C."
echo

if [ -z "${NO_BROWSER:-}" ]; then
  if command -v open >/dev/null 2>&1; then
    open "$URL" >/dev/null 2>&1 || true
  elif command -v xdg-open >/dev/null 2>&1 && [ -n "${DISPLAY:-}" ]; then
    xdg-open "$URL" >/dev/null 2>&1 || true
  fi
fi

wait "$SERVER_PID"
