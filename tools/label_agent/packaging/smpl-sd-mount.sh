#!/bin/sh
#
# Mount an inserted card read-only where the station can see it.
#
# Called by 99-smpl-sd-automount.rules; not meant to be run by hand, though
# running it by hand with a device node is a fine way to debug an automount.
#
#   smpl-sd-mount.sh /dev/sdb1
#
# Why a script instead of putting it all in the udev rule
# -------------------------------------------------------
# Three things have to be worked out at mount time and none of them can be
# expressed in a udev RUN+= line:
#
#   1. the service user's numeric uid/gid, because a vfat card has no
#      ownership of its own and needs uid=/gid= to be readable by anyone but
#      root - and hard-coding 997 in a rule file breaks on the next Pi;
#   2. whether uid=/gid= are even legal, which depends on the filesystem
#      (they are for vfat/exfat/ntfs, and a mount error for ext4);
#   3. a safe mount point, because the card's label is attacker-controlled
#      text that ends up in a path.
#
# Read-only, always
# -----------------
# The card is evidence. It is mounted 'ro' so that neither the agent nor a
# stray process nor a filesystem replay can alter what an instrument recorded,
# and 'noexec,nosuid,nodev' because nothing on a card should ever be executed.

set -eu

DEVICE="${1:?usage: smpl-sd-mount.sh /dev/sdXn}"
STATION_USER="${SMPL_STATION_USER:-smpl-station}"
MOUNT_ROOT="${SMPL_MOUNT_ROOT:-/media/smpl}"

# udev exports these; a hand-run gets sensible fallbacks.
FSTYPE="${ID_FS_TYPE:-$(blkid -o value -s TYPE "$DEVICE" 2>/dev/null || echo auto)}"
LABEL="${ID_FS_LABEL:-$(blkid -o value -s LABEL "$DEVICE" 2>/dev/null || echo '')}"

# ---------------------------------------------------------------------------
# Sanitise the label before it becomes a path component.  A card can be
# labelled "../../etc" or contain spaces, slashes and shell metacharacters;
# none of that may reach the filesystem.
# ---------------------------------------------------------------------------
# The dot is deliberately NOT in the allow-list. Keeping it looks harmless -
# a dot is not a slash, so "../../etc" collapses to the single component
# "....etc" and cannot traverse anywhere - but it leaves a mount point whose
# name contains ".." for the next person to read and have to reason about.
# Nothing is lost by dropping it: no card label needs a dot to be legible.
SAFE_LABEL=$(printf '%s' "$LABEL" | tr -cd 'A-Za-z0-9_-' | cut -c1-32)
[ -n "$SAFE_LABEL" ] || SAFE_LABEL="card"
# Distinguish two identically-labelled cards, and make the device obvious in
# `mount` output when something goes wrong.
SAFE_LABEL="${SAFE_LABEL}-$(basename "$DEVICE")"

TARGET="${MOUNT_ROOT}/${SAFE_LABEL}"

# ---------------------------------------------------------------------------
# Ownership options are filesystem-dependent.  Passing uid= to ext4 is not a
# harmless no-op, it is a mount failure, so the two cases are kept apart.
# ---------------------------------------------------------------------------
OPTIONS="ro,noexec,nosuid,nodev"
case "$FSTYPE" in
  vfat|msdos|exfat|ntfs|ntfs3|fuseblk)
    if UID_N=$(id -u "$STATION_USER" 2>/dev/null) && GID_N=$(id -g "$STATION_USER" 2>/dev/null); then
      OPTIONS="${OPTIONS},uid=${UID_N},gid=${GID_N},umask=0077"
    fi
    ;;
esac

# SMPL_SD_MOUNT_DRYRUN=1 prints the decision instead of acting on it. That is
# how the label-sanitising above is tested on a machine with no udev and no
# systemd, and it is also the fastest way to answer "why did this card mount
# there?" on the Pi itself.
if [ "${SMPL_SD_MOUNT_DRYRUN:-0}" = "1" ]; then
  printf 'device=%s\nfstype=%s\nlabel=%s\ntarget=%s\noptions=%s\n' \
    "$DEVICE" "$FSTYPE" "$LABEL" "$TARGET" "$OPTIONS"
  exit 0
fi

# systemd-mount rather than mount(8): --automount=yes means the mount unit is
# created and torn down by systemd, --collect means it cleans up after an
# unplug instead of leaving a failed unit behind, and --no-block means this
# returns immediately, which udev requires of a RUN+= program.
exec /usr/bin/systemd-mount \
  --no-block \
  --collect \
  --type="$FSTYPE" \
  --options="$OPTIONS" \
  --description="SMPL station card ${SAFE_LABEL}" \
  "$DEVICE" "$TARGET"
