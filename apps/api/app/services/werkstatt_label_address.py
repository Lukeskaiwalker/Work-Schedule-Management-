"""Which label-printer addresses an admin may enter.

The calibration reads the printer's answers back (``~S,STATUS``,
``^XGET,CONFIG``) and shows them. With a free host:port an admin could aim
that read at a service inside the deployment — the database, the update
runner, a metadata endpoint — and see its answer: a server-side request with
a read-back (commit security review, 2026-10-13).

So the address must look like a label printer on the office LAN:

* the port is a raw-print port, 9100–9109. This is the control that matters:
  nothing inside the deployment listens there, whatever host is entered;
* the host is not this machine, link-local, unspecified, multicast or
  reserved, and not one of the compose service names.

The check and the connection must read the address the same way (review:
validator differential). The resolver accepts spellings ``ipaddress`` does
not — "127.1", "2130706433", "0x7f000001" all mean 127.0.0.1 — and a name can
resolve anywhere. So a numeric-looking name is refused outright, and every
connection goes through ``open_checked``: it resolves the host itself, checks
each address and dials the checked address, never the name.

The port rule applies to the runtime (admin-entered) address; the address
check at connect time applies to every address, the env fallback included.
"""

from __future__ import annotations

import ipaddress
import logging
import re
import socket

logger = logging.getLogger(__name__)

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

# Every dot-separated part decimal, octal or hex: the resolver reads such a
# name as an IPv4 address in inet_aton notation ("127.1", "0x7f.1").
_NUMERIC_NAME = re.compile(r"^(?:0x[0-9a-f]*|[0-9]+)(?:\.(?:0x[0-9a-f]*|[0-9]+))*$")

PORT_REFUSED = "Der Druckerport muss zwischen 9100 und 9109 liegen (Raw-Druck)."
HOST_REFUSED = "Diese Adresse ist für den Etikettendrucker nicht erlaubt – bitte die IP des Druckers im Büronetz eintragen."
HOST_INVALID = "Ungültige Druckeradresse."
HOST_NUMERIC = "Bitte die IP-Adresse des Druckers in der üblichen Schreibweise eintragen, z. B. 192.168.2.158."


def _ip_refused(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    if isinstance(ip, ipaddress.IPv6Address):
        inner = ip.ipv4_mapped or ip.sixtofour
        if inner is not None and _ip_refused(inner):
            return True
    return ip.is_loopback or ip.is_link_local or ip.is_unspecified or ip.is_multicast or ip.is_reserved


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
        return HOST_REFUSED if _ip_refused(ip) else None
    name = candidate.rstrip(".").lower()
    if _NUMERIC_NAME.match(name):
        return HOST_NUMERIC
    if not _HOSTNAME.match(name):
        return HOST_INVALID
    if name in _BLOCKED_NAMES or name.endswith(_BLOCKED_SUFFIXES):
        return HOST_REFUSED
    return None


def open_checked(host: str, port: int, *, timeout: float) -> socket.socket:
    """Connect to the printer at an address checked here, not at the name.

    Resolves ``host`` once, skips every address the policy refuses and dials
    the first allowed one — so what was checked is what is dialled, whatever
    the resolver or DNS would make of the name later. Raises ``OSError``
    (callers already turn that into "Drucker nicht erreichbar"): a refused
    address answers exactly like an unreachable printer, nothing more.
    """
    infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    last_error: OSError | None = None
    for family, socktype, proto, _canon, sockaddr in infos:
        ip = ipaddress.ip_address(str(sockaddr[0]).split("%", 1)[0])
        if not ALLOW_LOCAL_TEST_PRINTER and _ip_refused(ip):
            logger.warning("label printer: %s resolves to a refused address; not dialled", host)
            last_error = OSError(f"{host}: address refused by the printer address policy")
            continue
        sock = socket.socket(family, socktype, proto)
        sock.settimeout(timeout)
        try:
            sock.connect(sockaddr)
        except OSError as exc:
            sock.close()
            last_error = exc
            continue
        return sock
    raise last_error or OSError(f"{host}: no address")
