#!/usr/bin/env bash
#
# Turn a fresh Raspberry Pi into the SMPL station.
#
#   sudo ./packaging/install-pi.sh
#   sudo ./packaging/install-pi.sh --smpl-url https://smpl.example.de
#   sudo ./packaging/install-pi.sh --with-kiosk     # + two screens at boot
#   sudo ./packaging/install-pi.sh --purge-kiosk    # take the screens away
#
# Idempotent: run it again after a `git pull` to update the code, the venv,
# the udev rules and the unit without touching the database, the token or any
# staged imports.
#
# --with-kiosk is off by default because this installer also provisions
# headless boxes, where chromium is 300 MB of nothing useful. It is additive:
# leaving it off on a re-run does not remove a kiosk that is already there.
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
WITH_KIOSK=0
PURGE_KIOSK=0
# The kiosk runs in a desktop session, so it belongs to a human's account, not
# to the service account. On Raspberry Pi OS that is 'pi'.
KIOSK_USER="${KIOSK_USER:-pi}"

while [ $# -gt 0 ]; do
  case "$1" in
    --smpl-url) SMPL_URL="${2:?--smpl-url needs a value}"; shift 2 ;;
    --smpl-url=*) SMPL_URL="${1#*=}"; shift ;;
    --user) STATION_USER="${2:?--user needs a value}"; shift 2 ;;
    --no-automount) SKIP_AUTOMOUNT=1; shift ;;
    --with-kiosk) WITH_KIOSK=1; shift ;;
    --purge-kiosk) PURGE_KIOSK=1; shift ;;
    --kiosk-user) KIOSK_USER="${2:?--kiosk-user needs a value}"; shift 2 ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

if [ "$WITH_KIOSK" -eq 1 ] && [ "$PURGE_KIOSK" -eq 1 ]; then
  echo "!! --with-kiosk and --purge-kiosk contradict each other. Pick one." >&2
  exit 2
fi

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
# Kiosk: two Chromium windows, one per HDMI output. Opt-in, and additive - a
# run without --with-kiosk leaves an existing kiosk alone rather than removing
# it, because "I forgot the flag" should not blank two screens in the
# workshop. Remove it deliberately with --purge-kiosk.
# ---------------------------------------------------------------------------
if [ "$PURGE_KIOSK" -eq 1 ]; then
  say "kiosk (removing)"
  KIOSK_HOME="$(getent passwd "$KIOSK_USER" 2>/dev/null | cut -d: -f6 || true)"
  rm -f /usr/local/bin/smpl-kiosk.sh
  if [ -n "$KIOSK_HOME" ]; then
    rm -f "$KIOSK_HOME/.config/autostart/smpl-kiosk.desktop"
  fi
  rm -f /etc/systemd/system/smpl-station.service.d/10-nowplaying.conf
  rm -f /etc/systemd/system/smpl-station.service.d/20-scanner.conf
  rmdir /etc/systemd/system/smpl-station.service.d 2>/dev/null || true
  # kiosk.env and the kanshi config are left: they are configuration somebody
  # decided on, and neither does anything on its own once the script is gone.
  echo "  removed the script, the autostart entry and both drop-ins"
  echo "  kept $CONFIG_DIR/kiosk.env and the kanshi config"
  echo "  ! the windows stay up until the desktop session restarts"
fi

if [ "$WITH_KIOSK" -eq 1 ]; then
  say "kiosk"
  KIOSK_SRC="$HERE/packaging/kiosk"

  if ! id -u "$KIOSK_USER" >/dev/null 2>&1; then
    echo "!! no such user '$KIOSK_USER' - the kiosk runs in a desktop session and"
    echo "!! needs one. Re-run with --kiosk-user <name>."
    exit 1
  fi
  KIOSK_HOME="$(getent passwd "$KIOSK_USER" | cut -d: -f6)"
  if [ -z "$KIOSK_HOME" ] || [ ! -d "$KIOSK_HOME" ]; then
    echo "!! user '$KIOSK_USER' has no home directory; cannot install an autostart entry."
    exit 1
  fi
  # Do not assume user 'pi' is in group 'pi'; ask.
  KIOSK_GROUP="$(id -gn "$KIOSK_USER")"

  # Only fetch what is actually missing: chromium is a ~300 MB download and
  # this script is expected to be re-run casually after a git pull.
  KIOSK_PKGS=""
  command -v chromium >/dev/null 2>&1 || command -v chromium-browser >/dev/null 2>&1 || KIOSK_PKGS="$KIOSK_PKGS chromium"
  command -v wlr-randr >/dev/null 2>&1 || KIOSK_PKGS="$KIOSK_PKGS wlr-randr"
  command -v xset >/dev/null 2>&1 || KIOSK_PKGS="$KIOSK_PKGS x11-xserver-utils"
  # Not niceties. Rootless Xwayland means Chromium cannot put its own window on
  # a chosen screen, so smpl-kiosk.sh places each one after it maps: xdotool
  # moves it, wmctrl fullscreens it. Without these two BOTH pages open on the
  # same monitor and the other shows wallpaper.
  command -v wmctrl >/dev/null 2>&1 || KIOSK_PKGS="$KIOSK_PKGS wmctrl"
  command -v xdotool >/dev/null 2>&1 || KIOSK_PKGS="$KIOSK_PKGS xdotool"
  if [ -n "$KIOSK_PKGS" ]; then
    echo "  installing:$KIOSK_PKGS"
    # Older Raspberry Pi OS calls the browser chromium-browser, newer ones
    # chromium. Try the modern name, fall back to the old one, and say so
    # rather than dying with apt's own wording.
    # shellcheck disable=SC2086
    if ! apt-get install -y --no-install-recommends $KIOSK_PKGS; then
      KIOSK_PKGS_ALT="$(printf '%s' "$KIOSK_PKGS" | sed 's/ chromium$/ chromium-browser/; s/ chromium / chromium-browser /')"
      # shellcheck disable=SC2086
      if ! apt-get install -y --no-install-recommends $KIOSK_PKGS_ALT; then
        echo "!! could not install:$KIOSK_PKGS"
        echo "!! the kiosk needs a browser and wlr-randr. Nothing else was changed."
        exit 1
      fi
    fi
  fi

  install -m 0755 "$KIOSK_SRC/smpl-kiosk.sh" /usr/local/bin/smpl-kiosk.sh

  # Autostart entry, owned by the desktop user: /etc/xdg/labwc/autostart ends
  # with lxsession-xdg-autostart, which is what reads this directory.
  install -d -o "$KIOSK_USER" -g "$KIOSK_GROUP" -m 0755 "$KIOSK_HOME/.config/autostart"
  install -o "$KIOSK_USER" -g "$KIOSK_GROUP" -m 0644 \
    "$KIOSK_SRC/smpl-kiosk.desktop" "$KIOSK_HOME/.config/autostart/smpl-kiosk.desktop"

  # kanshi pins which monitor sits where. Ours goes in only if there is not
  # already a real one - an empty file (the Raspberry Pi OS default) counts as
  # absent, a hand-written one does not.
  install -d -o "$KIOSK_USER" -g "$KIOSK_GROUP" -m 0755 "$KIOSK_HOME/.config/kanshi"
  KANSHI="$KIOSK_HOME/.config/kanshi/config"
  if [ ! -s "$KANSHI" ] || cmp -s "$KIOSK_SRC/kanshi.config" "$KANSHI"; then
    install -o "$KIOSK_USER" -g "$KIOSK_GROUP" -m 0644 "$KIOSK_SRC/kanshi.config" "$KANSHI"
  else
    install -o "$KIOSK_USER" -g "$KIOSK_GROUP" -m 0644 \
      "$KIOSK_SRC/kanshi.config" "$KANSHI.smpl-example"
    echo "  ! $KANSHI is not ours and was left alone."
    echo "  ! Ours is beside it as config.smpl-example - merge by hand."
  fi

  # Which screen shows which page is a local decision. Written once, then
  # never touched again by this installer.
  if [ ! -f "$CONFIG_DIR/kiosk.env" ]; then
    install -m 0644 "$KIOSK_SRC/kiosk.env.example" "$CONFIG_DIR/kiosk.env"
    echo "  wrote $CONFIG_DIR/kiosk.env (defaults; edit to swap the screens)"
  else
    echo "  kept $CONFIG_DIR/kiosk.env"
  fi
  install -m 0644 "$KIOSK_SRC/kiosk.env.example" "$CONFIG_DIR/kiosk.env.example"

  # Two loosenings of the service unit, each with its reason in its own file.
  install -d -m 0755 /etc/systemd/system/smpl-station.service.d
  install -m 0644 "$KIOSK_SRC/10-nowplaying.conf" \
    /etc/systemd/system/smpl-station.service.d/10-nowplaying.conf
  install -m 0644 "$KIOSK_SRC/20-scanner.conf" \
    /etc/systemd/system/smpl-station.service.d/20-scanner.conf
  echo "  drop-ins: PrivateTmp=no (AirPlay metadata), SupplementaryGroups=input (scanner)"
  echo "  ! re-test an SD-card import after this - see the unit's own header"
fi

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
  if [ "$WITH_KIOSK" -eq 1 ]; then
    echo
    echo "  Kiosk installed. It starts with the desktop session, so:"
    echo "    4. Check the mapping first (this launches nothing):"
    echo "         sudo -u $KIOSK_USER SMPL_KIOSK_DRYRUN=1 /usr/local/bin/smpl-kiosk.sh"
    echo "    5. Reboot, and check that /regal and /kisten are on the screens"
    echo "       you meant. If they are swapped, swap the two output lines in"
    echo "       $CONFIG_DIR/kiosk.env - it is a config edit, not a code change."
  fi
else
  echo "!! the service did not start. What it said:"
  journalctl -u smpl-station -n 30 --no-pager || true
  exit 1
fi
