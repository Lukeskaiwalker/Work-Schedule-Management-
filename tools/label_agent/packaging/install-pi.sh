#!/usr/bin/env bash
#
# Turn a fresh Raspberry Pi into the SMPL station.
#
#   sudo ./packaging/install-pi.sh
#   sudo ./packaging/install-pi.sh --smpl-url https://smpl.example.de
#
# Idempotent: run it again after a `git pull` to update the code, the venv,
# the udev rules and the unit without touching the database, the token or any
# staged imports.
#
# What it does NOT do
# -------------------
# It does not pair the station with SMPL - that needs a human to approve a
# code - and it does not print a test label. Both are the last two steps in
# docs/PI_STATION.md, done deliberately by a person who can see the hardware.

set -euo pipefail

STATION_USER="${STATION_USER:-smpl-station}"
INSTALL_DIR="${INSTALL_DIR:-/opt/smpl-station}"
STATE_DIR="/var/lib/smpl-station"
CONFIG_DIR="/etc/smpl-station"
SMPL_URL=""
SKIP_AUTOMOUNT=0

while [ $# -gt 0 ]; do
  case "$1" in
    --smpl-url) SMPL_URL="${2:?--smpl-url needs a value}"; shift 2 ;;
    --smpl-url=*) SMPL_URL="${1#*=}"; shift ;;
    --user) STATION_USER="${2:?--user needs a value}"; shift 2 ;;
    --no-automount) SKIP_AUTOMOUNT=1; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

if [ "$(id -u)" -ne 0 ]; then
  echo "!! run this with sudo" >&2
  exit 1
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # tools/label_agent
REPO="$(cd "$HERE/../.." && pwd)"

say() { printf '\n== %s\n' "$*"; }

# ---------------------------------------------------------------------------
say "packages"
# libusb-1.0-0  : what pyusb actually talks to
# python3-venv  : Raspberry Pi OS Lite ships python3 without it
# udisks2       : provides systemd-mount's dependencies and `blkid` behaviour
apt-get update -qq
apt-get install -y --no-install-recommends \
  python3 python3-venv python3-dev libusb-1.0-0 udisks2 rsync

# ---------------------------------------------------------------------------
say "service user"
if ! id -u "$STATION_USER" >/dev/null 2>&1; then
  # --system: no password, no ageing, no home in /home. The station user is
  # not a person and should never be able to log in.
  adduser --system --group --no-create-home --shell /usr/sbin/nologin "$STATION_USER"
fi
# 'lp' is what the Brother udev rule grants access through.
usermod -aG lp "$STATION_USER"

# ---------------------------------------------------------------------------
say "code -> $INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
if [ "$(readlink -f "$REPO")" != "$(readlink -f "$INSTALL_DIR")" ]; then
  rsync -a --delete \
    --exclude '.git' --exclude '.venv' --exclude '__pycache__' \
    "$REPO/" "$INSTALL_DIR/"
fi
AGENT_DIR="$INSTALL_DIR/tools/label_agent"

# ---------------------------------------------------------------------------
say "python environment"
if [ ! -x "$AGENT_DIR/.venv/bin/python" ]; then
  python3 -m venv "$AGENT_DIR/.venv"
fi
"$AGENT_DIR/.venv/bin/python" -m pip install --quiet --upgrade pip
"$AGENT_DIR/.venv/bin/python" -m pip install --quiet -r "$AGENT_DIR/requirements.txt"
if ! "$AGENT_DIR/.venv/bin/python" -c "import usb, PIL" 2>/dev/null; then
  echo "!! pyusb/Pillow did not install. The station will scan, count and export,"
  echo "!! but not print. Fix, then re-run this script."
fi
chown -R root:root "$INSTALL_DIR"

# ---------------------------------------------------------------------------
say "state directory"
# systemd's StateDirectory= creates this too, but doing it here means a
# hand-run of server.py before the first `systemctl start` cannot create it
# owned by root and quietly break the service afterwards.
mkdir -p "$STATE_DIR"
chown "$STATION_USER":"$STATION_USER" "$STATE_DIR"
chmod 700 "$STATE_DIR"

mkdir -p "$CONFIG_DIR"
if [ ! -f "$CONFIG_DIR/agent.env" ]; then
  cat >"$CONFIG_DIR/agent.env" <<EOF
# SMPL station configuration. Restart after editing:
#   sudo systemctl restart smpl-station

# Where SMPL lives. Without it the station still scans, counts and prints -
# it just cannot look up an article it has never seen, and cannot be paired.
SMPL_API_URL=${SMPL_URL}

# What this station calls itself when an admin approves the pairing code.
STATION_NAME=Werkstatt-Station

# Only for a SMPL that never grows the pairing endpoint. Pairing is better:
# the token it issues can be revoked centrally without touching this box.
#SMPL_API_TOKEN=
EOF
  chmod 640 "$CONFIG_DIR/agent.env"
  chown root:"$STATION_USER" "$CONFIG_DIR/agent.env"
elif [ -n "$SMPL_URL" ]; then
  sed -i "s|^SMPL_API_URL=.*|SMPL_API_URL=${SMPL_URL}|" "$CONFIG_DIR/agent.env"
fi

# ---------------------------------------------------------------------------
say "udev rules"
install -m 0644 "$HERE/packaging/99-brother-ptouch.rules" \
  /etc/udev/rules.d/99-brother-ptouch.rules

if [ "$SKIP_AUTOMOUNT" -eq 0 ]; then
  install -m 0755 "$HERE/packaging/smpl-sd-mount.sh" /usr/local/sbin/smpl-sd-mount.sh
  install -m 0644 "$HERE/packaging/99-smpl-sd-automount.rules" \
    /etc/udev/rules.d/99-smpl-sd-automount.rules
  mkdir -p /media/smpl
else
  rm -f /etc/udev/rules.d/99-smpl-sd-automount.rules
fi

udevadm control --reload-rules
udevadm trigger --subsystem-match=usb --subsystem-match=block || true

# ---------------------------------------------------------------------------
say "service"
install -m 0644 "$HERE/packaging/smpl-station.service" \
  /etc/systemd/system/smpl-station.service
# The unit hard-codes the canonical paths; rewrite them if this install moved.
if [ "$INSTALL_DIR" != "/opt/smpl-station" ] || [ "$STATION_USER" != "smpl-station" ]; then
  sed -i -e "s|/opt/smpl-station|${INSTALL_DIR}|g" \
         -e "s|^User=smpl-station|User=${STATION_USER}|" \
         -e "s|^Group=smpl-station|Group=${STATION_USER}|" \
         /etc/systemd/system/smpl-station.service
fi
systemctl daemon-reload
systemctl enable smpl-station
systemctl restart smpl-station

# ---------------------------------------------------------------------------
say "check"
sleep 2
if systemctl is-active --quiet smpl-station; then
  IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
  echo "  running: http://${IP:-<this-pi>}:8765/"
  echo
  echo "  Next, in this order:"
  echo "    1. sudo -u $STATION_USER AGENT_STATE_DIR=$STATE_DIR \\"
  echo "         $AGENT_DIR/.venv/bin/python $AGENT_DIR/server.py --pair"
  echo "       ...and approve the code in SMPL."
  echo "    2. Open the station page and scan something."
  echo "    3. Insert a test-instrument card and watch: journalctl -u smpl-station -f"
else
  echo "!! the service did not start. What it said:"
  journalctl -u smpl-station -n 30 --no-pager || true
  exit 1
fi
