"""Which label-printer addresses an admin may enter.

The calibration reads the printer's answers back (``~S,STATUS``,
``^XGET,CONFIG``) and shows them. With a free host:port an admin could aim
that read at a service inside the deployment — the database, the update
runner, a metadata endpoint — and see its answer: a server-side request with
a read-back (commit security review, 2026-10-13).

So the address must look like a label printer on the office LAN:

* the port is a raw-print port, 9100–9109. This is the control that matters:
  nothing inside the deployment listens there, whatever host is entered —
  which is also why a host NAME is not resolved here (DNS can change after
  the check; the port cannot);
* the host is not this machine, link-local, unspecified, multicast or
  reserved, and not one of the compose service names.

Only the runtime (admin-entered) address is checked; the env fallback is the
operator's own configuration.
"""

from __future__ import annotations

import ipaddress
import re

PRINTER_PORTS = range(9100, 9110)

#: The test suite's fake printer listens on 127.0.0.1 on a random port; its
#: fixture switches this on. Never set outside tests.
ALLOW_LOCAL_TEST_PRINTER = False

_COMPOSE_SERVICES = frozenset({"api", "api_worker", "db", "web", "update_runner"})
_BLOCKED_NAMES = _COMPOSE_SERVICES | {"localhost", "metadata", "metadata.google.internal"}
_BLOCKED_SUFFIXES = (".localhost", ".internal", ".local")
_HOSTNAME = re.compile(
    r"^(?=.{1,253}$)[a-z0-9](?:[a-z0-9_-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$"
)

PORT_REFUSED = "Der Druckerport muss zwischen 9100 und 9109 liegen (Raw-Druck)."
HOST_REFUSED = "Diese Adresse ist für den Etikettendrucker nicht erlaubt – bitte die IP des Druckers im Büronetz eintragen."
HOST_INVALID = "Ungültige Druckeradresse."


def address_problem(host: str, port: int) -> str | None:
    """The German reason ``host:port`` is refused, or None if it is allowed."""
    if ALLOW_LOCAL_TEST_PRINTER:
        return None
    if port not in PRINTER_PORTS:
        return PORT_REFUSED
    candidate = host.strip()
    if candidate.startswith("[") and candidate.endswith("]"):
        candidate = candidate[1:-1]
    try:
        ip = ipaddress.ip_address(candidate)
    except ValueError:
        ip = None
    if ip is not None:
        if ip.is_loopback or ip.is_link_local or ip.is_unspecified or ip.is_multicast or ip.is_reserved:
            return HOST_REFUSED
        return None
    name = candidate.rstrip(".").lower()
    if not _HOSTNAME.match(name):
        return HOST_INVALID
    if name in _BLOCKED_NAMES or name.endswith(_BLOCKED_SUFFIXES):
        return HOST_REFUSED
    return None
