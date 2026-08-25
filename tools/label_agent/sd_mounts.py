"""Notice that somebody put an SD card in the reader.

Three ways of asking the same question, because the station has to work on the
Pi it will live on, on the Mac it is developed on, and on neither of them when
we are testing:

* **Linux** - read ``/proc/self/mountinfo`` and keep the mounts that sit under
  a removable-media root (``/media``, ``/run/media``, ``/mnt``) with a
  filesystem a camera or a test instrument would actually use.
* **macOS** - list ``/Volumes``, minus the boot volume.
* **simulated** - treat every immediate subdirectory of ``--sd-root`` as a
  card. This is what the tests use, and what you use in the office to rehearse
  an import before the instrument is anywhere near you.

Polling, not inotify
--------------------
A mount appears as a *new mount point*, not as a file event inside a directory
we are already watching, so inotify would have to watch the parent - and on a
headless Pi the parent (``/media``) is often created by the automount itself.
A two-second poll of the mount table costs a single small read and cannot miss
a card that was inserted while we were busy printing. It also means "the
watcher is stuck" is impossible: there is no subscription to lose.

Nothing in this module ever writes to a card.
"""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional, Sequence

__all__ = ["Mount", "MountWatcher", "list_mounts"]

# Filesystems a test instrument, a camera or a card reader plausibly presents.
# Anything else under /media is almost certainly a network share or a loopback
# and is none of our business.
REMOVABLE_FILESYSTEMS = frozenset(
    {"vfat", "msdos", "exfat", "ntfs", "ntfs3", "fuseblk", "ext2", "ext3", "ext4", "hfsplus"}
)

LINUX_MEDIA_ROOTS = ("/media", "/run/media", "/mnt")

# macOS mounts everything under /Volumes, including the boot volume (as a
# symlink) and read-only system snapshots.
MACOS_MEDIA_ROOT = "/Volumes"


@dataclass(frozen=True)
class Mount:
    """One mounted filesystem that might be a card."""

    mount_point: str
    label: str
    filesystem: str
    source: str
    simulated: bool = False

    @property
    def path(self) -> Path:
        return Path(self.mount_point)

    def exists(self) -> bool:
        try:
            return self.path.is_dir()
        except OSError:
            return False

    def as_dict(self) -> dict:
        return {
            "mount_point": self.mount_point,
            "label": self.label,
            "filesystem": self.filesystem,
            "source": self.source,
            "simulated": self.simulated,
        }


# --------------------------------------------------------------------------
# Platform probes
# --------------------------------------------------------------------------


def _unescape_mountinfo(field: str) -> str:
    """mountinfo octal-escapes space, tab, newline and backslash."""
    out: List[str] = []
    index = 0
    while index < len(field):
        char = field[index]
        if char == "\\" and index + 3 < len(field):
            chunk = field[index + 1: index + 4]
            if len(chunk) == 3 and all(c in "01234567" for c in chunk):
                out.append(chr(int(chunk, 8)))
                index += 4
                continue
        out.append(char)
        index += 1
    return "".join(out)


def _linux_mounts(roots: Sequence[str], mountinfo: str = "/proc/self/mountinfo") -> List[Mount]:
    try:
        with open(mountinfo, "r", encoding="utf-8", errors="replace") as handle:
            lines = handle.readlines()
    except OSError:
        return []

    mounts: List[Mount] = []
    for line in lines:
        # "... <mount point> <options> [optional fields] - <fstype> <source> <opts>"
        head, separator, tail = line.partition(" - ")
        if not separator:
            continue
        head_fields = head.split()
        tail_fields = tail.split()
        if len(head_fields) < 5 or len(tail_fields) < 2:
            continue
        mount_point = _unescape_mountinfo(head_fields[4])
        filesystem = tail_fields[0]
        source = _unescape_mountinfo(tail_fields[1])
        if filesystem not in REMOVABLE_FILESYSTEMS:
            continue
        if not any(_under(mount_point, root) for root in roots):
            continue
        mounts.append(
            Mount(
                mount_point=mount_point,
                label=os.path.basename(mount_point.rstrip("/")) or mount_point,
                filesystem=filesystem,
                source=source,
            )
        )
    return mounts


def _under(path: str, root: str) -> bool:
    """True if *path* is strictly inside *root* (so /media itself never counts)."""
    root = root.rstrip("/")
    return path.startswith(root + "/") and path != root


def _macos_mounts(root: str = MACOS_MEDIA_ROOT) -> List[Mount]:
    try:
        entries = sorted(os.listdir(root))
    except OSError:
        return []
    boot = os.path.realpath("/")
    mounts: List[Mount] = []
    for name in entries:
        if name.startswith("."):
            continue
        full = os.path.join(root, name)
        try:
            if os.path.realpath(full) == boot:
                continue  # the symlink back to the boot volume
            if not os.path.isdir(full):
                continue
            if os.stat(full).st_dev == os.stat("/").st_dev:
                continue  # same device as the root filesystem: not a card
        except OSError:
            continue
        mounts.append(Mount(mount_point=full, label=name, filesystem="", source=""))
    return mounts


def _simulated_mounts(root: str) -> List[Mount]:
    try:
        entries = sorted(os.listdir(root))
    except OSError:
        return []
    mounts: List[Mount] = []
    for name in entries:
        if name.startswith("."):
            continue
        full = os.path.join(root, name)
        if os.path.isdir(full) and not os.path.islink(full):
            mounts.append(
                Mount(mount_point=full, label=name, filesystem="simulated",
                      source="--sd-root", simulated=True)
            )
    return mounts


def list_mounts(*, simulate_root: Optional[str] = None,
                roots: Optional[Sequence[str]] = None) -> List[Mount]:
    """Every mount that currently looks like removable media."""
    if simulate_root:
        return _simulated_mounts(simulate_root)
    if sys.platform.startswith("linux"):
        return _linux_mounts(roots or LINUX_MEDIA_ROOTS)
    if sys.platform == "darwin":
        return _macos_mounts()
    return []


# --------------------------------------------------------------------------
# Edge detection
# --------------------------------------------------------------------------


class MountWatcher:
    """Turns a repeated list of mounts into 'this one is new'.

    Deliberately edge-triggered on the *mount point*, and deliberately
    stateless about content: a card that is pulled and pushed back in is a new
    mount and gets looked at again. Whether its files were already imported is
    a question for the content fingerprint, not for this class - conflating
    the two is how you end up silently skipping a card that was genuinely
    re-recorded between insertions.
    """

    def __init__(self, *, simulate_root: Optional[str] = None,
                 roots: Optional[Sequence[str]] = None,
                 settle_polls: int = 2) -> None:
        self.simulate_root = simulate_root
        self.roots = roots
        # A card is not reported the instant it appears: an automount can be
        # visible in the mount table a moment before its directory is readable,
        # and copying half a card is worse than noticing it a second later.
        self.settle_polls = max(1, settle_polls)
        self._seen: dict = {}

    def poll(self) -> List[Mount]:
        """Return the mounts that have newly settled since the last call."""
        current = {m.mount_point: m for m in list_mounts(
            simulate_root=self.simulate_root, roots=self.roots
        )}

        for gone in [p for p in self._seen if p not in current]:
            self._seen.pop(gone, None)

        fresh: List[Mount] = []
        for point, mount in current.items():
            state = self._seen.get(point)
            if state is None:
                self._seen[point] = {"polls": 1, "reported": False}
                continue
            if state["reported"]:
                continue
            state["polls"] += 1
            if state["polls"] >= self.settle_polls and mount.exists():
                state["reported"] = True
                fresh.append(mount)
        return fresh

    def forget(self, mount_point: str) -> None:
        """Make the next poll treat *mount_point* as new again (manual rescan)."""
        self._seen.pop(mount_point, None)

    def known(self) -> List[str]:
        return sorted(self._seen)
