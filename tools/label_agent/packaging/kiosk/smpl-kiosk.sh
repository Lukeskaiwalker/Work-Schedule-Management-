#!/bin/sh
#
# Put one Chromium window on each of the station's two screens and keep them
# there.
#
#   /usr/local/bin/smpl-kiosk.sh
#
# Started by ~/.config/autostart/smpl-kiosk.desktop in the desktop user's
# session, not by systemd: it needs that session's WAYLAND_DISPLAY and
# DISPLAY, and it dies with the session, which is what you want.
#
# Configuration is /etc/smpl-station/kiosk.env. Every knob is documented in
# kiosk.env.example, including the two lines you edit to swap which screen
# shows which page. Nothing about the screen -> page mapping is in this file.
#
# Debug it without launching anything:
#
#   SMPL_KIOSK_DRYRUN=1 /usr/local/bin/smpl-kiosk.sh
#
# which prints the exact argv each window would get, as key=value lines.
#
#
# Why two --user-data-dir, and why that is not optional
# -----------------------------------------------------
# Chromium keeps one browser process per profile directory, guarded by
# ~/.config/chromium/SingletonLock. A second `chromium` against the same
# profile does NOT start a second browser: it hands its command line to the
# process that already holds the lock, that process opens a tab, and the
# second invocation exits 0. You get one window, on one screen, and a script
# that thinks it succeeded. So each window gets its own profile directory.
# The distinct --class is for the same reason at the window-manager level:
# two windows that are indistinguishable to a WM rule cannot be placed
# separately.
#
# Why a while loop instead of lwrespawn
# --------------------------------------
# /usr/bin/lwrespawn is what /etc/xdg/labwc/autostart uses for the panel and
# the desktop, and it is wrong here: it deduplicates with `pgrep` on the
# process *name*, so once one Chromium is up it refuses to start the second.
# A plain per-window loop has no such opinion.
#
# Why x11 is the default backend on a Wayland compositor
# -------------------------------------------------------
# Under labwc, XWayland presents a single root window spanning both outputs
# (here 5200x2160), so --window-position/--window-size address an absolute
# desktop coordinate and land where you computed. Native Wayland has no
# concept of a client choosing its output; placement has to come from a
# compositor rule instead. See KIOSK_BACKEND in kiosk.env.example.
#
# One trap worth stating out loud: under XWayland the outputs are NOT called
# HDMI-A-1/HDMI-A-2. `xrandr` calls them XWAYLAND1/XWAYLAND2, in an order
# that is not the connector order. That is why geometry is resolved from
# wlr-randr whenever a Wayland session is present, even when we then drive
# Chromium through X11 - wlr-randr is the only tool on the box that knows the
# name written in kiosk.env.

set -eu

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
KIOSK_ENV_FILE="${KIOSK_ENV_FILE:-/etc/smpl-station/kiosk.env}"
if [ -r "$KIOSK_ENV_FILE" ]; then
  # shellcheck disable=SC1090
  . "$KIOSK_ENV_FILE"
fi

DRYRUN="${SMPL_KIOSK_DRYRUN:-0}"

# A dry run never waits: it is asked what it *would* do, and "would block for
# a minute waiting for a TV" is not an answer anybody wants at a terminal.
if [ "$DRYRUN" = "1" ]; then
  : "${KIOSK_OUTPUT_TIMEOUT:=0}"
fi

: "${KIOSK_BACKEND:=x11}"
: "${KIOSK_HEALTH_URL:=http://127.0.0.1:8765/health}"
: "${KIOSK_REGAL_OUTPUT:=HDMI-A-1}"
: "${KIOSK_KISTEN_OUTPUT:=HDMI-A-2}"
: "${KIOSK_REGAL_URL:=http://127.0.0.1:8765/regal}"
: "${KIOSK_KISTEN_URL:=http://127.0.0.1:8765/kisten}"
: "${KIOSK_REGAL_SCALE:=1}"
: "${KIOSK_KISTEN_SCALE:=2}"
: "${KIOSK_CHROMIUM:=}"
: "${KIOSK_PROFILE_ROOT:=${HOME:-/home/pi}/.local/share/smpl-kiosk}"
: "${KIOSK_HEALTH_TIMEOUT:=180}"
: "${KIOSK_OUTPUT_TIMEOUT:=60}"
: "${KIOSK_RESPAWN_DELAY:=3}"
: "${KIOSK_FULLSCREEN:=kiosk}"

log()  { printf 'smpl-kiosk: %s\n' "$*" >&2; }
die()  { printf 'smpl-kiosk: !! %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
now_s() { date +%s; }

# ---------------------------------------------------------------------------
# Validate at the boundary. kiosk.env is hand-edited by whoever is standing
# at the Pi, and every value below ends up in an argv. A stray space would
# silently split one flag into two and produce a window with no URL, so the
# failure is made loud here instead.
# ---------------------------------------------------------------------------
check_url() {
  case "$2" in
    http://*|https://*) ;;
    *) die "$1 must be an http(s) URL, got: '$2'" ;;
  esac
  case "$2" in
    *[!!-~]*) die "$1 must be printable ASCII with no spaces, got: '$2'" ;;
  esac
}

check_token() {
  case "$2" in
    "") die "$1 must not be empty" ;;
    *[!A-Za-z0-9._:-]*) die "$1 may only contain letters, digits and .:_- , got: '$2'" ;;
  esac
}

check_scale() {
  case "$2" in
    ''|*[!0-9.]*|*.*.*) die "$1 must be a number like 1 or 1.5, got: '$2'" ;;
  esac
}

check_url   KIOSK_HEALTH_URL  "$KIOSK_HEALTH_URL"
check_url   KIOSK_REGAL_URL   "$KIOSK_REGAL_URL"
check_url   KIOSK_KISTEN_URL  "$KIOSK_KISTEN_URL"
check_token KIOSK_REGAL_OUTPUT  "$KIOSK_REGAL_OUTPUT"
check_token KIOSK_KISTEN_OUTPUT "$KIOSK_KISTEN_OUTPUT"
check_scale KIOSK_REGAL_SCALE  "$KIOSK_REGAL_SCALE"
check_scale KIOSK_KISTEN_SCALE "$KIOSK_KISTEN_SCALE"

case "$KIOSK_BACKEND" in
  x11|wayland) ;;
  *) die "KIOSK_BACKEND must be x11 or wayland, got: '$KIOSK_BACKEND'" ;;
esac

case "$KIOSK_FULLSCREEN" in
  kiosk|window) ;;
  *) die "KIOSK_FULLSCREEN must be kiosk or window, got: '$KIOSK_FULLSCREEN'" ;;
esac

if [ "$KIOSK_REGAL_OUTPUT" = "$KIOSK_KISTEN_OUTPUT" ]; then
  die "KIOSK_REGAL_OUTPUT and KIOSK_KISTEN_OUTPUT are both '$KIOSK_REGAL_OUTPUT'.
     Both pages would land on one screen, which is never what you meant."
fi

# ---------------------------------------------------------------------------
# Chromium
# ---------------------------------------------------------------------------
if [ -z "$KIOSK_CHROMIUM" ]; then
  for candidate in chromium chromium-browser google-chrome-stable; do
    if have "$candidate"; then
      KIOSK_CHROMIUM="$(command -v "$candidate")"
      break
    fi
  done
fi
[ -n "$KIOSK_CHROMIUM" ] || die "no chromium on PATH. apt install chromium"

# ---------------------------------------------------------------------------
# Output geometry
#
# Two readers, one shape: each echoes "W H X Y" for the named output, or
# nothing at all when that output is not there.
# ---------------------------------------------------------------------------

# wlr-randr, the authority on a wlroots compositor. Output blocks look like:
#
#   HDMI-A-1 "Philips ... (HDMI-A-1)"
#     Modes:
#       1360x768 px, 59.799000 Hz (preferred, current)
#     Position: 3840,0
geometry_from_wlr_randr() {
  wlr-randr 2>/dev/null | awk -v want="$1" '
    /^[^ \t]/ { cur = $1; next }
    cur != want { next }
    $2 == "px," && /current/ { split($1, d, "x"); w = d[1]; h = d[2] }
    $1 == "Position:" { split($2, p, ","); x = p[1]; y = p[2] }
    END { if (w != "" && x != "") print w, h, x, y }
  '
}

# xrandr, for a station that really is running X11. Lines look like:
#
#   HDMI-1 connected primary 1920x1080+0+0 (normal left ...) 600mm x 340mm
#
# Under XWayland this will only ever match XWAYLAND1/XWAYLAND2, never the
# connector names - see the header. It is the fallback, not the default.
geometry_from_xrandr() {
  xrandr --query 2>/dev/null | awk -v want="$1" '
    $1 != want { next }
    {
      for (i = 2; i <= NF; i++) {
        if ($i ~ /^[0-9]+x[0-9]+[+-][0-9]+[+-][0-9]+$/) {
          n = split($i, a, /[+-]/)
          split(a[1], d, "x")
          print d[1], d[2], a[2], a[3]
          exit
        }
      }
    }
  '
}

geometry_for() {
  gf_geo=""
  if have wlr-randr && [ -n "${WAYLAND_DISPLAY:-}" ]; then
    gf_geo="$(geometry_from_wlr_randr "$1")"
  fi
  if [ -z "$gf_geo" ] && have xrandr && [ -n "${DISPLAY:-}" ]; then
    gf_geo="$(geometry_from_xrandr "$1")"
  fi
  printf '%s' "$gf_geo"
}

# Screens come up after the session does, especially a TV that negotiates
# HDMI for a few seconds. Retry before giving up.
wait_for_output() {
  wfo_deadline=$(( $(now_s) + KIOSK_OUTPUT_TIMEOUT ))
  while :; do
    wfo_geo="$(geometry_for "$1")"
    if [ -n "$wfo_geo" ]; then
      printf '%s' "$wfo_geo"
      return 0
    fi
    if [ "$(now_s)" -ge "$wfo_deadline" ]; then
      return 1
    fi
    sleep 2
  done
}

known_outputs() {
  if have wlr-randr && [ -n "${WAYLAND_DISPLAY:-}" ]; then
    wlr-randr 2>/dev/null | awk '/^[^ \t]/ { printf "%s ", $1 }'
  fi
  if have xrandr && [ -n "${DISPLAY:-}" ]; then
    xrandr --query 2>/dev/null | awk '/ connected/ { printf "%s ", $1 }'
  fi
}

field() { echo "$2" | awk -v i="$1" '{ print $i }'; }

# ---------------------------------------------------------------------------
# Wait for the station itself. Same shape as run.sh's wait, with a longer
# budget: at boot the venv is cold and the SD card is busy, and a kiosk that
# gives up after five seconds shows a browser error page for the rest of the
# day.
# ---------------------------------------------------------------------------
wait_for_health() {
  wfh_deadline=$(( $(now_s) + KIOSK_HEALTH_TIMEOUT ))
  while :; do
    wfh_code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "$KIOSK_HEALTH_URL" 2>/dev/null || echo 000)"
    if [ "$wfh_code" = "200" ]; then
      return 0
    fi
    if [ "$(now_s)" -ge "$wfh_deadline" ]; then
      log "station /health never answered 200 (last: $wfh_code) after ${KIOSK_HEALTH_TIMEOUT}s"
      return 1
    fi
    sleep 1
  done
}

# ---------------------------------------------------------------------------
# Chromium argv for one window.
#
# Every flag below was checked against the strings of this box's own
# /usr/lib/chromium/chromium (136.0.7103.92). Notably ABSENT from that binary,
# and therefore not used here even though the internet is full of them:
#   --disable-session-crashed-bubble   (superseded by --hide-crash-restore-bubble)
#   --disable-translate                (superseded by --disable-features=Translate)
# ---------------------------------------------------------------------------
chromium_argv() {
  ca_label="$1"; ca_url="$2"; ca_scale="$3"
  ca_w="$4"; ca_h="$5"; ca_x="$6"; ca_y="$7"

  ca_args="$KIOSK_CHROMIUM"
  case "$KIOSK_BACKEND" in
    x11)     ca_args="$ca_args --ozone-platform=x11" ;;
    wayland) ca_args="$ca_args --ozone-platform=wayland" ;;
  esac

  # Identity: the two things that make this a second browser and not a second
  # tab of the first one.
  ca_args="$ca_args --user-data-dir=$KIOSK_PROFILE_ROOT/$ca_label"
  ca_args="$ca_args --class=smpl-kiosk-$ca_label"

  # Placement. Under Wayland these are advisory at best - the compositor
  # decides - which is exactly why x11 is the default backend.
  ca_args="$ca_args --window-position=$ca_x,$ca_y"
  ca_args="$ca_args --window-size=$ca_w,$ca_h"
  if [ "$KIOSK_FULLSCREEN" = "kiosk" ]; then
    ca_args="$ca_args --kiosk"
  fi

  ca_args="$ca_args --app=$ca_url"
  ca_args="$ca_args --force-device-scale-factor=$ca_scale"

  # Nothing may appear over the page and nothing may ask a question: there is
  # no keyboard at either screen and nobody to answer.
  ca_args="$ca_args --noerrdialogs"
  ca_args="$ca_args --disable-infobars"
  ca_args="$ca_args --hide-crash-restore-bubble"
  ca_args="$ca_args --no-first-run"
  ca_args="$ca_args --no-default-browser-check"
  ca_args="$ca_args --password-store=basic"
  ca_args="$ca_args --disable-sync"
  ca_args="$ca_args --disable-features=Translate,TranslateUI,MediaRouter,OptimizationHints,AutofillServerCommunication"

  # A station is not a browser: it must never decide to update itself, and it
  # must never phone home. --disable-background-networking is already added by
  # Debian's /usr/bin/chromium wrapper.
  ca_args="$ca_args --disable-component-update"
  ca_args="$ca_args --check-for-update-interval=31536000"

  # Touch behaviour: no pinch-zoom out of the layout, no swipe-back off the
  # page. Both are one stray sleeve away on a screen nobody is watching.
  ca_args="$ca_args --disable-pinch"
  ca_args="$ca_args --overscroll-history-navigation=0"

  # A kiosk window is frequently occluded by the other one, or unfocused for
  # hours. Chromium throttles those to near-zero, which stops a polling page
  # updating. Not an optimisation - a correctness flag here.
  ca_args="$ca_args --disable-background-timer-throttling"
  ca_args="$ca_args --disable-backgrounding-occluded-windows"
  ca_args="$ca_args --disable-renderer-backgrounding"

  printf '%s' "$ca_args"
}

# ---------------------------------------------------------------------------
# Respawn
# ---------------------------------------------------------------------------
CHILD_PIDS=""

spawn_window() {
  sw_label="$1"; shift
  (
    while :; do
      # shellcheck disable=SC2048,SC2086
      $* >/dev/null 2>&1 || true
      printf 'smpl-kiosk: %s window exited; respawning in %ss\n' "$sw_label" "$KIOSK_RESPAWN_DELAY" >&2
      sleep "$KIOSK_RESPAWN_DELAY"
    done
  ) &
  CHILD_PIDS="$CHILD_PIDS $!"
}

shutdown_windows() {
  for sp in $CHILD_PIDS; do
    kill "$sp" 2>/dev/null || true
  done
  # Killing the loop does not kill the browser it is currently waiting on.
  # Match on our own profile root, which no other Chromium on this box uses.
  pkill -u "$(id -u)" -f -- "--user-data-dir=$KIOSK_PROFILE_ROOT/" 2>/dev/null || true
  exit 0
}

# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------
if [ "$DRYRUN" = "1" ]; then
  printf 'backend=%s\n' "$KIOSK_BACKEND"
  printf 'fullscreen=%s\n' "$KIOSK_FULLSCREEN"
  printf 'chromium=%s\n' "$KIOSK_CHROMIUM"
  printf 'health_url=%s\n' "$KIOSK_HEALTH_URL"
  printf 'profile_root=%s\n' "$KIOSK_PROFILE_ROOT"
else
  wait_for_health || log "starting the windows anyway; the page will retry itself"
fi

# Both geometries are resolved before either window starts. A station with one
# screen missing must say so and stop, not open both pages on the screen that
# happens to be there - two identical-looking windows stacked on one monitor
# is the single hardest failure of this kind to diagnose from across a room.
REGAL_GEO="$(wait_for_output "$KIOSK_REGAL_OUTPUT" || true)"
if [ -z "$REGAL_GEO" ]; then
  die "output '$KIOSK_REGAL_OUTPUT' (KIOSK_REGAL_OUTPUT) is not connected.
     Known outputs right now: $(known_outputs)
     Nothing was launched. Fix the cable, or the name in $KIOSK_ENV_FILE."
fi

KISTEN_GEO="$(wait_for_output "$KIOSK_KISTEN_OUTPUT" || true)"
if [ -z "$KISTEN_GEO" ]; then
  die "output '$KIOSK_KISTEN_OUTPUT' (KIOSK_KISTEN_OUTPUT) is not connected.
     Known outputs right now: $(known_outputs)
     Nothing was launched. Fix the cable, or the name in $KIOSK_ENV_FILE."
fi

REGAL_ARGV="$(chromium_argv regal "$KIOSK_REGAL_URL" "$KIOSK_REGAL_SCALE" \
  "$(field 1 "$REGAL_GEO")" "$(field 2 "$REGAL_GEO")" \
  "$(field 3 "$REGAL_GEO")" "$(field 4 "$REGAL_GEO")")"

KISTEN_ARGV="$(chromium_argv kisten "$KIOSK_KISTEN_URL" "$KIOSK_KISTEN_SCALE" \
  "$(field 1 "$KISTEN_GEO")" "$(field 2 "$KISTEN_GEO")" \
  "$(field 3 "$KISTEN_GEO")" "$(field 4 "$KISTEN_GEO")")"

geo_str() {
  printf '%sx%s+%s+%s' "$(field 1 "$1")" "$(field 2 "$1")" \
                        "$(field 3 "$1")" "$(field 4 "$1")"
}

if [ "$DRYRUN" = "1" ]; then
  printf 'windows=2\n'
  printf 'window.regal.output=%s\n'         "$KIOSK_REGAL_OUTPUT"
  printf 'window.regal.geometry=%s\n'       "$(geo_str "$REGAL_GEO")"
  printf 'window.regal.url=%s\n'            "$KIOSK_REGAL_URL"
  printf 'window.regal.user_data_dir=%s\n'  "$KIOSK_PROFILE_ROOT/regal"
  printf 'window.regal.class=%s\n'          "smpl-kiosk-regal"
  printf 'window.regal.scale=%s\n'          "$KIOSK_REGAL_SCALE"
  printf 'window.regal.argv=%s\n'           "$REGAL_ARGV"
  printf 'window.kisten.output=%s\n'        "$KIOSK_KISTEN_OUTPUT"
  printf 'window.kisten.geometry=%s\n'      "$(geo_str "$KISTEN_GEO")"
  printf 'window.kisten.url=%s\n'           "$KIOSK_KISTEN_URL"
  printf 'window.kisten.user_data_dir=%s\n' "$KIOSK_PROFILE_ROOT/kisten"
  printf 'window.kisten.class=%s\n'         "smpl-kiosk-kisten"
  printf 'window.kisten.scale=%s\n'         "$KIOSK_KISTEN_SCALE"
  printf 'window.kisten.argv=%s\n'          "$KISTEN_ARGV"
  exit 0
fi

mkdir -p "$KIOSK_PROFILE_ROOT/regal" "$KIOSK_PROFILE_ROOT/kisten"

# Screen-blank insurance. Nothing on this box configures blanking today
# (consoleblank=0, no swayidle, no xset daemon), so this disables something
# that is already off. It costs one process and it means a future package
# that helpfully installs a screensaver cannot black out the workshop.
if [ -n "${DISPLAY:-}" ] && have xset; then
  xset -display "$DISPLAY" s off s noblank -dpms || true
fi

if [ "$KIOSK_BACKEND" = "wayland" ]; then
  log "backend=wayland: Chromium cannot choose its own output on Wayland."
  log "Placement needs a labwc window rule keyed on the app_id, e.g. in rc.xml:"
  log "  <windowRule identifier=\"smpl-kiosk-regal\">"
  log "    <action name=\"MoveToOutput\" output=\"$KIOSK_REGAL_OUTPUT\"/></windowRule>"
  log "  <windowRule identifier=\"smpl-kiosk-kisten\">"
  log "    <action name=\"MoveToOutput\" output=\"$KIOSK_KISTEN_OUTPUT\"/></windowRule>"
  log "This script does not write rc.xml. See docs/PI_STATION.md."
fi

trap shutdown_windows INT TERM

spawn_window regal  "$REGAL_ARGV"
spawn_window kisten "$KISTEN_ARGV"

log "regal  -> $KIOSK_REGAL_OUTPUT  $(geo_str "$REGAL_GEO")  $KIOSK_REGAL_URL"
log "kisten -> $KIOSK_KISTEN_OUTPUT $(geo_str "$KISTEN_GEO") $KIOSK_KISTEN_URL"

wait
