"""HTTP client for the office scan station's agent — the api→Pi direction.

The Pi (``tools/label_agent``) already talks *to* the api with its station
token. This is the other way round: the Scan-Station admin page wants to
print a test label, ask the agent for a fresh ``/health``, list the count
sessions on its SQLite and, once, restart it. The api and the Pi share one
LAN (192.168.2.50 ↔ 192.168.2.235), so the api calls the agent directly.

The agent's LAN API has no authentication of its own, which is why this
client is the *only* way the api reaches it and why it is deliberately
narrow. A station token — or an admin who can edit a station — must never be
able to steer the api at something else:

* the address comes from the row (``agent_host``/``agent_port``, reported by
  the Pi and validated to a private address when stored; or the admin's
  ``agent_url_override``, validated the same way) and is re-checked here, so
  a hand-edited row cannot widen the boundary either;
* only a fixed set of agent paths can be called; there is no "GET this URL";
* every call is short (connect 3 s, read 15 s — a label feeds ~2 s of tape),
  reads at most 2 MiB (``MAX_RESPONSE_BYTES`` — enough for the largest Pi
  session the import accepts), accepts JSON only and follows no redirect;
* the client is opened per call and closed after it. No pool: the api
  container is memory-capped, and a pool that grows towards a Pi that is off
  is exactly the wrong thing to keep around.

The one dangerous route, ``/restart``, additionally carries
``X-SMPL-Station-Proof``: the sha256 of the station token, which the api
stores and the agent can compute from the token it holds. No new secret to
provision, and anybody on the LAN without the token gets a 403 from the Pi.

Nothing here ever logs a token or a hash.
"""

from __future__ import annotations

import ipaddress
import json
import re
import urllib.parse
from typing import Any

import httpx

from app.core.config import get_settings
from app.models.entities import Station

PROOF_HEADER = "X-SMPL-Station-Proof"
# Sized for the largest reply the api is willing to act on: a Pi session of
# ``station_sessions.MAX_IMPORT_ROWS`` (5000) rows at ~160 bytes each, with
# room for long article names. A cap below that would make the row cap
# decoration — the byte cap would refuse every session first, as a 502.
MAX_RESPONSE_BYTES = 2 * 1024 * 1024

# The agent routes the api is allowed to call. ``/session/<name>`` is the one
# parametrised path, and its parameter is validated against the agent's own
# rule for session names (``valid_session_name`` in server.py) before it is
# put into a URL.
FIXED_PATHS = frozenset({"/health", "/sessions", "/print", "/restart"})
SESSION_PATH_PREFIX = "/session/"
SESSION_NAME_RE = re.compile(r"^[A-Za-z0-9._ -]{1,64}$")
_LOCAL_LABEL_RE = re.compile(r"^[a-z0-9-]{1,63}$")

UNCONFIGURED_DETAIL = (
    "Die Station hat noch keine Adresse gemeldet. Agent auf dem Pi aktualisieren "
    "oder die Adresse unter „Bearbeiten“ eintragen."
)
UNREACHABLE_DETAIL = "Die Station antwortet nicht. Läuft der Agent auf dem Pi?"
INVALID_SESSION_NAME_DETAIL = (
    "Ungültiger Sitzungsname: erlaubt sind Buchstaben, Ziffern, Punkt, "
    "Unterstrich, Bindestrich und Leerzeichen (max. 64 Zeichen)."
)
TOO_LARGE_DETAIL = "Die Antwort der Station ist zu groß."
NOT_JSON_DETAIL = "Die Station hat keine gültige Antwort geliefert."
AGENT_URL_SCHEME_DETAIL = "Agent-Adresse muss mit http:// oder https:// beginnen."
AGENT_URL_SHAPE_DETAIL = "Agent-Adresse: nur http://<Host>:<Port>, ohne Pfad und ohne Zugangsdaten."
AGENT_URL_PORT_DETAIL = "Agent-Adresse braucht einen Port, z. B. http://192.168.2.235:8765."
AGENT_URL_HOST_DETAIL = "Agent-Adresse muss eine private IP-Adresse oder ein *.local-Name sein."


class StationAgentError(RuntimeError):
    """Base class. ``http_status`` is what the admin routes answer with."""

    http_status = 502


class StationAgentUnconfigured(StationAgentError):
    """The row holds no usable address: the Pi never reported one (agent too
    old) and the admin typed none. A 409, because it is the caller's setup
    that is incomplete, not the network."""

    http_status = 409


class StationAgentUnreachable(StationAgentError):
    """Connect refused, timed out, DNS failed — the Pi is off or elsewhere."""

    http_status = 502


class StationAgentRemoteError(StationAgentError):
    """The agent answered and said no (its own ``error`` sentence), or
    answered with something that is not JSON / too large to trust."""

    http_status = 502

    def __init__(self, status_code: int, message: str) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.message = message


# ---------------------------------------------------------------------------
# Address validation — the security boundary
# ---------------------------------------------------------------------------


def is_private_host(host: str) -> bool:
    """A routable *private* address and nothing else.

    RFC 1918 / ULA only: loopback, link-local (which is where a cloud
    metadata service lives), multicast, unspecified and reserved ranges are
    all refused even though ``ipaddress`` files some of them under
    ``is_private``.
    """
    try:
        address = ipaddress.ip_address((host or "").strip())
    except ValueError:
        return False
    if (
        address.is_loopback
        or address.is_link_local
        or address.is_multicast
        or address.is_unspecified
        or address.is_reserved
    ):
        return False
    return bool(address.is_private)


def is_local_name(host: str) -> bool:
    """``smpl-station.local`` — an mDNS name the office LAN resolves itself."""
    text = (host or "").strip().lower()
    if not text.endswith(".local"):
        return False
    labels = text[: -len(".local")].split(".")
    return bool(labels) and all(_LOCAL_LABEL_RE.match(label) for label in labels)


def _host_for_url(host: str) -> str:
    return f"[{host}]" if ":" in host else host


def validate_agent_url(raw: str) -> str:
    """Normalise an admin-typed override, or raise ``ValueError`` with the
    German sentence the form should show. Returns ``scheme://host:port``."""
    text = (raw or "").strip()
    if not text:
        raise ValueError(AGENT_URL_SHAPE_DETAIL)
    parsed = urllib.parse.urlsplit(text)
    if parsed.scheme not in ("http", "https"):
        raise ValueError(AGENT_URL_SCHEME_DETAIL)
    if parsed.path not in ("", "/") or parsed.query or parsed.fragment:
        raise ValueError(AGENT_URL_SHAPE_DETAIL)
    if parsed.username is not None or parsed.password is not None:
        raise ValueError(AGENT_URL_SHAPE_DETAIL)
    host = (parsed.hostname or "").strip()
    try:
        port = parsed.port
    except ValueError as exc:
        raise ValueError(AGENT_URL_PORT_DETAIL) from exc
    if port is None:
        raise ValueError(AGENT_URL_PORT_DETAIL)
    if not (is_private_host(host) or is_local_name(host)):
        raise ValueError(AGENT_URL_HOST_DETAIL)
    return f"{parsed.scheme}://{_host_for_url(host)}:{port}"


def agent_base_url(station: Station) -> str | None:
    """Where to reach this station's agent, or ``None`` when nothing usable
    is stored. The admin override wins; the reported pair is the default.
    Both are re-validated here — the row is not trusted just for being a row."""
    override = (station.agent_url_override or "").strip()
    if override:
        try:
            return validate_agent_url(override)
        except ValueError:
            return None
    host = (station.agent_host or "").strip()
    port = station.agent_port
    if not host or port is None or not 1 <= int(port) <= 65535 or not is_private_host(host):
        return None
    return f"http://{_host_for_url(host)}:{int(port)}"


# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------


def session_path(name: str) -> str:
    """``/session/<name>`` with the name validated and URL-encoded."""
    if not SESSION_NAME_RE.match(name or ""):
        raise ValueError(INVALID_SESSION_NAME_DETAIL)
    return SESSION_PATH_PREFIX + urllib.parse.quote(name, safe="")


def _assert_allowed(path: str) -> None:
    if path in FIXED_PATHS:
        return
    if path.startswith(SESSION_PATH_PREFIX):
        name = urllib.parse.unquote(path[len(SESSION_PATH_PREFIX) :])
        if SESSION_NAME_RE.match(name):
            return
    # A programming error, not user input: no caller builds paths by hand.
    raise ValueError(f"agent path not allowed: {path}")


# ---------------------------------------------------------------------------
# Transport
# ---------------------------------------------------------------------------


def _timeouts() -> httpx.Timeout:
    settings = get_settings()
    connect = float(settings.station_agent_connect_timeout_seconds or 3.0)
    read = float(settings.station_agent_read_timeout_seconds or 15.0)
    return httpx.Timeout(connect=connect, read=read, write=connect, pool=connect)


def _open_client(timeout: httpx.Timeout) -> httpx.Client:
    """One short-lived client per call. Tests swap this for a mock transport."""
    return httpx.Client(timeout=timeout, follow_redirects=False)


def _read_capped(response: httpx.Response) -> bytes:
    chunks: list[bytes] = []
    total = 0
    for chunk in response.iter_bytes():
        total += len(chunk)
        if total > MAX_RESPONSE_BYTES:
            raise StationAgentRemoteError(response.status_code, TOO_LARGE_DETAIL)
        chunks.append(chunk)
    return b"".join(chunks)


def _decode(body: bytes, status_code: int) -> dict[str, Any]:
    try:
        payload = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as exc:
        raise StationAgentRemoteError(status_code, NOT_JSON_DETAIL) from exc
    if not isinstance(payload, dict):
        raise StationAgentRemoteError(status_code, NOT_JSON_DETAIL)
    return payload


def _remote_message(payload: dict[str, Any], status_code: int) -> str:
    """The agent's own sentence (``{"ok": false, "error": "…"}``) when it
    gave one — "printer not found on USB" is worth more than "HTTP 500"."""
    for key in ("error", "detail"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()[:500]
    return f"Die Station hat mit HTTP {status_code} geantwortet."


def _call(
    station: Station,
    method: str,
    path: str,
    *,
    json_body: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
) -> dict[str, Any]:
    base_url = agent_base_url(station)
    if base_url is None:
        raise StationAgentUnconfigured(UNCONFIGURED_DETAIL)
    _assert_allowed(path)
    request_headers = {"Accept": "application/json", **(headers or {})}
    try:
        with _open_client(_timeouts()) as client:
            with client.stream(
                method, f"{base_url}{path}", json=json_body, headers=request_headers
            ) as response:
                status_code = response.status_code
                body = _read_capped(response)
    except StationAgentError:
        raise
    except httpx.HTTPError as exc:
        raise StationAgentUnreachable(UNREACHABLE_DETAIL) from exc
    payload = _decode(body, status_code)
    if status_code >= 400:
        raise StationAgentRemoteError(status_code, _remote_message(payload, status_code))
    return payload


def agent_get(station: Station, path: str) -> dict[str, Any]:
    return _call(station, "GET", path)


def agent_post(
    station: Station,
    path: str,
    json_body: dict[str, Any],
    *,
    headers: dict[str, str] | None = None,
) -> dict[str, Any]:
    return _call(station, "POST", path, json_body=json_body, headers=headers)


def restart_proof(station: Station) -> dict[str, str]:
    """The header that lets the agent tell the api apart from anybody else on
    the LAN: sha256 of the station token, which is exactly what the api has
    stored. The raw token is never in the api's hands, so nothing here could
    leak it even by mistake."""
    return {PROOF_HEADER: station.token_hash}
