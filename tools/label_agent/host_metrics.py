"""What the Pi itself is doing: temperature, clock, load, memory, throttling.

Why this exists. The station runs two Chromium kiosks, one of them driving a
4K panel, on a passively cooled Pi 4 in a workshop. Measured on the office
station: 80-81 °C sitting still, `get_throttled=0xe0000` — it had already hit
frequency capping and the soft temperature limit — and libinput logging
"your system is too slow" on the mouse. None of that was visible anywhere in
SMPL. The box looked healthy right up until the cursor stopped moving.

The cost rule. This is sampled on a thermally limited machine, so measuring
must not be a reason to get hotter. Everything here is a read of a small file
in /sys or /proc, which is a page the kernel already has: the whole sample is
a few dozen microseconds. The one exception is `vcgencmd`, an 8 ms subprocess
(measured), and the only thing that needs it are the throttle flags -- which
are sticky and move slowly. So it runs at most every VCGENCMD_TTL_S and the
rest is read live. A caller polling once a second costs essentially nothing.

What it deliberately does not do. No history, no averaging window of its own,
no thread. Something else already runs on a timer (the heartbeat, /health),
and a sampler that keeps its own clock is a second thing to reason about when
the numbers disagree. `cpu_pct` is the one stateful value -- CPU time is a
counter, so a percentage needs two readings -- and it is explicitly the load
*since the previous call*, not since boot.

Every field is independently optional. A kernel that names the thermal zone
differently, a non-Pi host, a service account without /dev/vcio: each of those
removes one key and leaves the rest. Nothing here raises.
"""

from __future__ import annotations

import os
import subprocess
import time
from typing import Any, Dict, Optional, Tuple

__all__ = ["sample", "decode_throttled", "reset"]

# The Pi's SoC zone. Read by path rather than by scanning /sys/class/thermal
# for a type=="cpu-thermal": the scan is several more stats for a name that has
# been stable across every Raspberry Pi OS release this station has run.
THERMAL_PATH = "/sys/class/thermal/thermal_zone0/temp"
CPUFREQ_CUR = "/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq"
CPUFREQ_MAX = "/sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq"
LOADAVG_PATH = "/proc/loadavg"
MEMINFO_PATH = "/proc/meminfo"
STAT_PATH = "/proc/stat"
UPTIME_PATH = "/proc/uptime"
COOLING_GLOB = "/sys/class/thermal"

#: How long a `vcgencmd get_throttled` answer is reused. The flags it returns
#: are either "right now" (which a screen refreshing every few seconds does not
#: need to the second) or "since boot" (which never goes back). A minute keeps
#: the subprocess off a hot CPU while still catching an under-voltage event
#: well inside the window anybody would notice one.
VCGENCMD_TTL_S = 60.0
VCGENCMD_TIMEOUT_S = 2.0

#: Bit → name for `vcgencmd get_throttled`. The low nibble is live state, bits
#: 16-19 are the same four conditions latched since boot. The latched half is
#: the useful half in a workshop: nobody is watching the screen at the moment
#: the clock drops, but "this machine HAS been throttled" is the sentence that
#: explains a slow afternoon.
THROTTLE_BITS: Tuple[Tuple[int, str], ...] = (
    (0, "under_voltage_now"),
    (1, "freq_capped_now"),
    (2, "throttled_now"),
    (3, "soft_temp_limit_now"),
    (16, "under_voltage_since_boot"),
    (17, "freq_capped_since_boot"),
    (18, "throttled_since_boot"),
    (19, "soft_temp_limit_since_boot"),
)

# Retained between calls: the previous /proc/stat totals, so cpu_pct can be a
# delta. Module-level rather than a class because there is exactly one host.
_prev_cpu: Optional[Tuple[int, int]] = None
_vcgencmd_cache: Optional[Tuple[float, Optional[int]]] = None


def reset() -> None:
    """Forget the retained CPU sample and the throttle cache (tests use this)."""
    global _prev_cpu, _vcgencmd_cache
    _prev_cpu = None
    _vcgencmd_cache = None


def _read(path: str, limit: int = 4096) -> Optional[str]:
    """A small file's text, or None for anything at all going wrong.

    Bounded because /proc files are not ordinary files: a few are generated on
    read and a wrong path could produce a lot of text.
    """
    try:
        with open(path, "rb") as handle:
            return handle.read(limit).decode("utf-8", "replace")
    except Exception:  # noqa: BLE001 - a missing sensor is not an error here
        return None


def _read_int(path: str) -> Optional[int]:
    raw = _read(path, 64)
    if raw is None:
        return None
    try:
        return int(raw.strip())
    except ValueError:
        return None


def _temperature_c() -> Optional[float]:
    """SoC temperature. The kernel reports millidegrees."""
    milli = _read_int(THERMAL_PATH)
    if milli is None:
        return None
    # A plausibility gate, not decoration: some boards expose this zone in
    # degrees rather than millidegrees, and reporting 47 000 °C on a wall
    # display is worse than reporting nothing.
    celsius = milli / 1000.0
    return round(celsius, 1) if -40.0 <= celsius <= 150.0 else None


def _cpu_percent() -> Optional[float]:
    """Busy time since the PREVIOUS call, as a percentage of all CPU time.

    None on the first call by design. /proc/stat holds counters since boot, so
    a single reading can only ever describe the machine's whole life, which is
    never the question being asked.
    """
    global _prev_cpu
    raw = _read(STAT_PATH, 256)
    if raw is None:
        return None
    line = raw.split("\n", 1)[0].split()
    if len(line) < 5 or line[0] != "cpu":
        return None
    try:
        fields = [int(value) for value in line[1:]]
    except ValueError:
        return None
    total = sum(fields)
    # Field 3 is idle, field 4 iowait. iowait counts as not-busy: a station
    # waiting on an SD card is not a station that needs a fan.
    idle = fields[3] + (fields[4] if len(fields) > 4 else 0)

    previous, _prev_cpu = _prev_cpu, (total, idle)
    if previous is None:
        return None
    total_delta = total - previous[0]
    idle_delta = idle - previous[1]
    if total_delta <= 0:
        # Two calls inside one tick, or a counter reset. Not an error, just
        # nothing measurable yet — and 0.0 here would be a lie.
        return None
    busy = 100.0 * (total_delta - idle_delta) / total_delta
    return round(min(100.0, max(0.0, busy)), 1)


def _load() -> Optional[Dict[str, float]]:
    raw = _read(LOADAVG_PATH, 128)
    if raw is None:
        return None
    parts = raw.split()
    if len(parts) < 3:
        return None
    try:
        return {
            "1m": float(parts[0]),
            "5m": float(parts[1]),
            "15m": float(parts[2]),
        }
    except ValueError:
        return None


def _memory() -> Optional[Dict[str, int]]:
    """Total and available memory in MB.

    MemAvailable, not MemFree: the kernel's own estimate of what a new process
    could get, which on a box with 3 GB of page cache is the only one of the
    two that answers "is this machine short of memory".
    """
    raw = _read(MEMINFO_PATH, 2048)
    if raw is None:
        return None
    wanted = {"MemTotal:": None, "MemAvailable:": None}
    for line in raw.split("\n"):
        key = line.split(" ", 1)[0]
        if key in wanted and wanted[key] is None:
            parts = line.split()
            if len(parts) >= 2:
                try:
                    wanted[key] = int(parts[1])  # kB
                except ValueError:
                    return None
    total_kb, avail_kb = wanted["MemTotal:"], wanted["MemAvailable:"]
    if not total_kb or avail_kb is None:
        return None
    return {
        "total_mb": total_kb // 1024,
        "available_mb": avail_kb // 1024,
        "used_pct": round(100.0 * (total_kb - avail_kb) / total_kb, 1),
    }


def _uptime_s() -> Optional[int]:
    raw = _read(UPTIME_PATH, 64)
    if raw is None:
        return None
    try:
        return int(float(raw.split()[0]))
    except (ValueError, IndexError):
        return None


def _has_active_cooling() -> Optional[bool]:
    """Whether the kernel knows of any cooling device (a fan).

    The office station has none — purely passive — which is the fact that
    turns "81 °C" from a number into a thing somebody can act on.
    """
    try:
        names = os.listdir(COOLING_GLOB)
    except Exception:  # noqa: BLE001
        return None
    return any(name.startswith("cooling_device") for name in names)


def decode_throttled(value: Optional[int]) -> Optional[Dict[str, Any]]:
    """The throttle word as named booleans, plus the raw hex it came from.

    The raw value is kept because it is what every Raspberry Pi answer on the
    internet is written in, and somebody comparing this screen against a forum
    post should not have to re-derive the bits.
    """
    if value is None:
        return None
    flags = {name: bool(value & (1 << bit)) for bit, name in THROTTLE_BITS}
    flags["raw"] = "0x%x" % value
    # Two roll-ups, because they are the two questions actually asked: is it
    # bad right now, and has it ever been bad.
    flags["now"] = any(value & (1 << bit) for bit, _ in THROTTLE_BITS if bit < 4)
    flags["since_boot"] = any(value & (1 << bit) for bit, _ in THROTTLE_BITS if bit >= 16)
    return flags


def _throttled_word(now: float) -> Tuple[Optional[int], Optional[str]]:
    """`vcgencmd get_throttled`, cached. Returns (value, error).

    The error is carried rather than swallowed: the overwhelmingly likely
    reason for failure is that the service account is not in the `video` group
    and so cannot open /dev/vcio, and a screen that just omits the throttle
    flags gives nobody a way to find that out.
    """
    global _vcgencmd_cache
    if _vcgencmd_cache is not None and now - _vcgencmd_cache[0] < VCGENCMD_TTL_S:
        return _vcgencmd_cache[1], None
    try:
        completed = subprocess.run(
            ["vcgencmd", "get_throttled"],
            capture_output=True,
            text=True,
            timeout=VCGENCMD_TIMEOUT_S,
            check=False,
        )
    except FileNotFoundError:
        return None, "vcgencmd not installed"
    except Exception as exc:  # noqa: BLE001 - timeout, permissions, anything
        return None, "%s: %s" % (type(exc).__name__, exc)

    text = (completed.stdout or "").strip()
    if completed.returncode != 0 or "=" not in text:
        detail = (completed.stderr or completed.stdout or "").strip()
        if "vcio" in detail:
            detail = "cannot open /dev/vcio (is the service user in the 'video' group?)"
        return None, detail[:200] or "vcgencmd failed"
    try:
        value = int(text.split("=", 1)[1].strip(), 0)
    except ValueError:
        return None, "unparsable: %s" % text[:80]

    _vcgencmd_cache = (now, value)
    return value, None


def sample(*, now: Optional[float] = None) -> Dict[str, Any]:
    """One reading of the host. Never raises; absent facts are absent keys.

    Kept flat and small on purpose: this dict is forwarded in the station
    heartbeat, where the whole hardware blob is capped at 4 KiB server-side.
    """
    moment = time.time() if now is None else now
    out: Dict[str, Any] = {}

    temp = _temperature_c()
    if temp is not None:
        out["temp_c"] = temp

    cur_khz, max_khz = _read_int(CPUFREQ_CUR), _read_int(CPUFREQ_MAX)
    if cur_khz:
        out["cpu_mhz"] = cur_khz // 1000
    if max_khz:
        out["cpu_max_mhz"] = max_khz // 1000
    if cur_khz and max_khz and max_khz > 0:
        # The freq-vs-max ratio is the only throttle signal available without
        # /dev/vcio, so it is always reported, not just when vcgencmd is gone.
        out["cpu_freq_pct"] = round(100.0 * cur_khz / max_khz)

    busy = _cpu_percent()
    if busy is not None:
        out["cpu_pct"] = busy

    load = _load()
    if load is not None:
        out["load"] = load

    memory = _memory()
    if memory is not None:
        out["mem"] = memory

    uptime = _uptime_s()
    if uptime is not None:
        out["uptime_s"] = uptime

    cooling = _has_active_cooling()
    if cooling is not None:
        out["active_cooling"] = cooling

    value, error = _throttled_word(moment)
    decoded = decode_throttled(value)
    if decoded is not None:
        out["throttle"] = decoded
    elif error:
        out["throttle_error"] = error[:200]

    return out
