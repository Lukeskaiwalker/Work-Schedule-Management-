"""Log the station into SMPL without anyone typing a password into it.

The station is a box in the corner of the office with a scanner and a printer
hanging off it. Nobody wants to find a keyboard, look up a password and type
it into a machine that has no screen - and nobody should, because a password
typed into a shared appliance is a password that now lives on a shared
appliance.

So this is the **OAuth 2.0 Device Authorization Grant** (RFC 8628), the
pattern smart TVs use for exactly this reason: the device that cannot take a
password asks for a short code, shows it, and a human approves it somewhere
they are *already* logged in.

    1. the station asks SMPL to start a pairing        -> POST .../pair/start
    2. SMPL answers with a short user_code + a URL
    3. the station displays  ABCD-1234  and waits
    4. an admin opens SMPL in a browser they are already logged into,
       types the code, sees "Werkstatt-Station, in the office", approves
    5. the station's next poll gets a long-lived token -> POST .../pair/poll
    6. the token is written 0600 and used from then on

The station never sees the password, the token can be revoked centrally
without touching the hardware, and step 4 is a thing an admin does from their
own desk.

Defensive by construction
-------------------------
The SMPL-side API is being built in parallel with this file, so nothing here
may *assume* it exists or that its field names match. Every call:

* tries a list of plausible endpoint paths and remembers the one that answers;
* accepts several spellings of every field (``token`` / ``access_token`` /
  ``station_token`` ...), because guessing wrong on a field name should not
  cost a re-implementation;
* raises :class:`PairingUnavailable` - not an error - when *no* candidate
  exists, so the agent falls straight back to ``SMPL_API_TOKEN`` or to
  unauthenticated local operation, which is exactly what it does today.

**Pairing is never required.** A station that has never been paired counts,
prints and exports exactly as it does now.
"""

from __future__ import annotations

import json
import threading
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

import agent_paths

__all__ = [
    "PairingError",
    "PairingUnavailable",
    "PairingDenied",
    "PairingExpired",
    "PairingRequest",
    "StationToken",
    "TokenStore",
    "PairingClient",
    "PairingSession",
]

# Candidate paths, most-likely first. The backend agent was briefed to build
# "/api/station/...", so those lead; the RFC-canonical spellings follow in case
# they mounted the grant verbatim.
START_PATHS = (
    "/api/station/pair/start",
    "/api/station/pair",
    "/api/station/pairing/start",
    "/api/station/device/authorize",
    "/api/station/device_authorization",
)

POLL_PATHS = (
    "/api/station/pair/poll",
    "/api/station/pair/token",
    "/api/station/pairing/poll",
    "/api/station/device/token",
    "/api/station/token",
)

DEFAULT_INTERVAL_S = 5.0
MIN_INTERVAL_S = 1.0
MAX_INTERVAL_S = 30.0
DEFAULT_EXPIRY_S = 900.0
REQUEST_TIMEOUT_S = 10.0
MAX_RESPONSE_BYTES = 256 * 1024

# Status words a backend might use, normalised to our three outcomes. The RFC
# error codes and the plain-English ones are both here because either is a
# reasonable thing for a FastAPI route to return.
_PENDING_WORDS = frozenset(
    {"pending", "authorization_pending", "waiting", "unapproved", "open", "new", "slow_down"}
)
_DENIED_WORDS = frozenset({"denied", "access_denied", "rejected", "refused", "revoked"})
_EXPIRED_WORDS = frozenset({"expired", "expired_token", "timeout", "timed_out"})
# SMPL answers "claimed" when the token for this pairing was already collected
# once and will not be reissued - the normal cause being a second agent
# process, or this one restarting after it had already stored the token.
# Terminal, and emphatically *not* pending: polling on would never end.
_SPENT_WORDS = frozenset({"claimed", "already_claimed", "consumed"})


class PairingError(Exception):
    """Pairing failed in a way the operator has to see."""


class PairingUnavailable(PairingError):
    """This SMPL server does not offer pairing. Not an error - a capability gap."""


class PairingDenied(PairingError):
    """An admin actively refused this station."""


class PairingExpired(PairingError):
    """Nobody approved the code in time. Start again."""


# --------------------------------------------------------------------------
# Payload reading: be liberal in what we accept
# --------------------------------------------------------------------------


def _first_str(payload: Dict[str, Any], *keys: str) -> str:
    """First non-empty string among *keys*, looked up flat and one level deep."""
    for key in keys:
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    for nest in ("data", "result", "pairing", "station"):
        inner = payload.get(nest)
        if isinstance(inner, dict):
            found = _first_str(inner, *keys)
            if found:
                return found
    return ""


def _first_number(payload: Dict[str, Any], *keys: str) -> Optional[float]:
    for key in keys:
        value = payload.get(key)
        if isinstance(value, bool):
            continue
        if isinstance(value, (int, float)):
            return float(value)
        if isinstance(value, str):
            try:
                return float(value.strip())
            except ValueError:
                continue
    for nest in ("data", "result", "pairing"):
        inner = payload.get(nest)
        if isinstance(inner, dict):
            found = _first_number(inner, *keys)
            if found is not None:
                return found
    return None


def _parse_stamp(text: str) -> Optional[datetime]:
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _iso(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


# --------------------------------------------------------------------------
# Value objects
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class PairingRequest:
    """What the station shows on screen while it waits to be approved."""

    device_code: str
    user_code: str
    verification_uri: str
    verification_uri_complete: str
    expires_at: datetime
    interval: float
    poll_path: str = ""

    @property
    def expired(self) -> bool:
        return datetime.now(timezone.utc) >= self.expires_at

    @property
    def seconds_left(self) -> int:
        return max(0, int((self.expires_at - datetime.now(timezone.utc)).total_seconds()))

    def as_dict(self) -> Dict[str, Any]:
        # device_code is the *secret* half of the exchange - whoever holds it
        # collects the token - so it never leaves this process. Only the
        # user_code, which is useless without an authenticated admin, is shown.
        return {
            "user_code": self.user_code,
            "verification_uri": self.verification_uri,
            "verification_uri_complete": self.verification_uri_complete,
            "expires_at": _iso(self.expires_at),
            "seconds_left": self.seconds_left,
            "interval": self.interval,
        }


@dataclass(frozen=True)
class StationToken:
    """A long-lived SMPL token belonging to this station."""

    token: str
    base_url: str
    obtained_at: str
    expires_at: str = ""
    label: str = ""
    scopes: List[str] = field(default_factory=list)

    @property
    def expired(self) -> bool:
        if not self.expires_at:
            return False  # no expiry advertised: valid until SMPL says otherwise
        moment = _parse_stamp(self.expires_at)
        if moment is None:
            return False
        return datetime.now(timezone.utc) >= moment

    def as_dict(self) -> Dict[str, Any]:
        return {
            "token": self.token,
            "base_url": self.base_url,
            "obtained_at": self.obtained_at,
            "expires_at": self.expires_at,
            "label": self.label,
            "scopes": list(self.scopes),
        }

    def public(self) -> Dict[str, Any]:
        """The same thing minus the secret, for /health and the station page."""
        return {
            "paired": True,
            "base_url": self.base_url,
            "obtained_at": self.obtained_at,
            "expires_at": self.expires_at or None,
            "label": self.label or None,
            "scopes": list(self.scopes),
            "expired": self.expired,
        }


# --------------------------------------------------------------------------
# Token storage
# --------------------------------------------------------------------------


class TokenStore:
    """The paired token on disk, always mode 0600."""

    def __init__(self, path=None) -> None:
        self._path = path or agent_paths.token_file()
        self._lock = threading.Lock()
        self._cache: Optional[StationToken] = None
        self._loaded = False

    @property
    def path(self):
        return self._path

    def load(self) -> Optional[StationToken]:
        with self._lock:
            if self._loaded:
                return self._cache
            self._loaded = True
            self._cache = self._read()
            return self._cache

    def _read(self) -> Optional[StationToken]:
        try:
            raw = self._path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            return None
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            return None
        if not isinstance(payload, dict):
            return None
        token = str(payload.get("token") or "")
        if not token:
            return None
        scopes = payload.get("scopes")
        return StationToken(
            token=token,
            base_url=str(payload.get("base_url") or ""),
            obtained_at=str(payload.get("obtained_at") or ""),
            expires_at=str(payload.get("expires_at") or ""),
            label=str(payload.get("label") or ""),
            scopes=[str(s) for s in scopes] if isinstance(scopes, list) else [],
        )

    def save(self, token: StationToken) -> None:
        agent_paths.write_private(self._path, json.dumps(token.as_dict(), indent=2) + "\n")
        with self._lock:
            self._cache = token
            self._loaded = True

    def clear(self) -> None:
        try:
            self._path.unlink()
        except OSError:
            pass
        with self._lock:
            self._cache = None
            self._loaded = True

    def secure(self) -> bool:
        """False if the token file exists but is readable by anyone else."""
        if not self._path.exists():
            return True
        return agent_paths.is_private(self._path)


# --------------------------------------------------------------------------
# The client
# --------------------------------------------------------------------------


class PairingClient:
    """Talks the device-authorization dance to a SMPL server that may not
    implement it yet."""

    def __init__(self, base_url: str, *, timeout: float = REQUEST_TIMEOUT_S,
                 user_agent: str = "smpl-label-agent") -> None:
        self.base_url = (base_url or "").rstrip("/")
        self.timeout = timeout
        self.user_agent = user_agent
        self._start_path = ""
        self._poll_path = ""
        # SMPL answers 429 if polled faster than it asked for, and repeats its
        # preferred pace in every poll response. Honouring both is cheaper
        # than being rate-limited, and the server is entitled to change its
        # mind mid-wait.
        self.interval_hint: Optional[float] = None

    @property
    def configured(self) -> bool:
        return bool(self.base_url)

    # -- transport --------------------------------------------------------

    def _post(self, path: str, payload: Dict[str, Any]) -> "_Response":
        """POST JSON, retrying once as a form if the server rejects the media
        type. Returns status + parsed body; only transport failures raise."""
        body = json.dumps(payload).encode("utf-8")
        response = self._request(path, body, "application/json")
        if response.status in (415, 422):
            # FastAPI answers 422 when the route wants Form() fields, not JSON.
            form = urllib.parse.urlencode(
                {k: v for k, v in payload.items() if isinstance(v, (str, int, float))}
            ).encode("utf-8")
            retried = self._request(path, form, "application/x-www-form-urlencoded")
            if retried.status < 400:
                return retried
        return response

    def _request(self, path: str, body: bytes, content_type: str) -> "_Response":
        url = self.base_url + path
        request = urllib.request.Request(url, data=body, method="POST")
        request.add_header("Content-Type", content_type)
        request.add_header("Accept", "application/json")
        request.add_header("User-Agent", self.user_agent)
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as handle:  # noqa: S310
                raw = handle.read(MAX_RESPONSE_BYTES)
                return _Response(handle.status, _decode(raw), "")
        except urllib.error.HTTPError as exc:
            try:
                raw = exc.read(MAX_RESPONSE_BYTES)
            except Exception:  # noqa: BLE001 - the body is a nicety, not required
                raw = b""
            return _Response(exc.code, _decode(raw), "")
        except Exception as exc:  # noqa: BLE001 - DNS, TLS, timeout, refused
            return _Response(0, None, "%s: %s" % (type(exc).__name__, exc))

    # -- step 1: ask for a code -------------------------------------------

    def start(self, *, device_name: str, device_id: str, agent_version: str = "") -> PairingRequest:
        if not self.configured:
            raise PairingUnavailable("SMPL_API_URL is not set, so there is nothing to pair with")

        payload = {
            "device_id": device_id,
            "device_name": device_name,
            "client_id": "smpl-label-agent",
            "agent_version": agent_version,
            "scope": "werkstatt",
        }

        candidates = [self._start_path] if self._start_path else list(START_PATHS)
        transport_errors: List[str] = []
        for path in candidates:
            response = self._post(path, payload)
            if response.status == 0:
                transport_errors.append("%s: %s" % (path, response.error))
                continue
            if response.status in (404, 405, 501):
                continue  # this spelling is not the one; try the next
            if response.status in (401, 403):
                raise PairingError(
                    "SMPL refused to start pairing (HTTP %d). The pairing endpoint "
                    "exists but will not talk to an unauthenticated station."
                    % response.status
                )
            if response.status >= 400 or not isinstance(response.parsed, dict):
                transport_errors.append("%s: HTTP %d" % (path, response.status))
                continue
            request = self._read_start(response.parsed)
            self._start_path = path
            return request

        if transport_errors:
            raise PairingError(
                "could not reach SMPL to start pairing (%s)" % "; ".join(transport_errors[:3])
            )
        raise PairingUnavailable(
            "this SMPL server has no station pairing endpoint yet (tried %s)"
            % ", ".join(START_PATHS)
        )

    def _read_start(self, payload: Dict[str, Any]) -> PairingRequest:
        user_code = _first_str(payload, "user_code", "display_code", "pair_code", "pairing_code")
        device_code = _first_str(
            payload, "device_code", "poll_token", "pairing_token", "secret", "code"
        )
        if not user_code and not device_code:
            raise PairingError("SMPL answered the pairing request without a code")
        if not device_code:
            # Some designs poll with the user code itself. Workable, just weaker.
            device_code = user_code
        if not user_code:
            user_code = device_code

        verification = _first_str(
            payload, "verification_uri", "verification_url", "verify_uri", "url", "approve_url"
        )
        if not verification:
            # SMPL's web app keeps its view in React state rather than in the
            # URL, so there is no deep link to construct. Pointing at the
            # server itself and naming the menu item beats inventing a path
            # that would 404 in front of whoever is trying to help.
            verification = self.base_url or ""
        complete = _first_str(payload, "verification_uri_complete", "verification_url_complete")
        if not complete:
            complete = "%s?%s" % (verification, urllib.parse.urlencode({"code": user_code}))

        expires_at = _parse_stamp(_first_str(payload, "expires_at", "expiry", "valid_until"))
        if expires_at is None:
            seconds = _first_number(payload, "expires_in", "expires_in_seconds", "ttl")
            expires_at = datetime.now(timezone.utc) + timedelta(
                seconds=seconds if seconds and seconds > 0 else DEFAULT_EXPIRY_S
            )

        interval = _first_number(payload, "interval", "poll_interval", "interval_seconds")
        interval = _clamp(interval if interval else DEFAULT_INTERVAL_S)

        poll_path = _first_str(payload, "poll_path", "token_endpoint", "poll_url")

        return PairingRequest(
            device_code=device_code,
            user_code=user_code,
            verification_uri=verification,
            verification_uri_complete=complete,
            expires_at=expires_at,
            interval=interval,
            poll_path=_relative(poll_path, self.base_url),
        )

    # -- step 2: wait to be approved --------------------------------------

    def poll(self, request: PairingRequest) -> Optional[StationToken]:
        """One poll. Returns the token once approved, ``None`` while pending.

        Raises :class:`PairingDenied` / :class:`PairingExpired` for the two
        terminal answers, so a caller can stop looping without inspecting
        strings.
        """
        payload = {
            "device_code": request.device_code,
            "user_code": request.user_code,
            "client_id": "smpl-label-agent",
            "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
        }

        candidates: List[str] = []
        for path in (request.poll_path, self._poll_path):
            if path and path not in candidates:
                candidates.append(path)
        if not candidates:
            candidates = list(POLL_PATHS)

        last_error = ""
        for path in candidates:
            response = self._post(path, payload)
            if response.status == 0:
                last_error = response.error
                continue
            if response.status in (404, 405, 501):
                continue
            self._poll_path = path
            return self._read_poll(response)

        if last_error:
            raise PairingError("could not reach SMPL while polling (%s)" % last_error)
        raise PairingUnavailable("SMPL has no pairing poll endpoint (tried %s)" % ", ".join(POLL_PATHS))

    def _read_poll(self, response: "_Response") -> Optional[StationToken]:
        payload = response.parsed if isinstance(response.parsed, dict) else {}

        advertised = _first_number(payload, "poll_interval", "interval", "retry_after")
        if advertised and advertised > 0:
            self.interval_hint = _clamp(advertised)
        if response.status == 429:
            # Polled too fast. Back off rather than reporting an error: the
            # pairing is fine, our timing was not.
            self.interval_hint = _clamp((self.interval_hint or DEFAULT_INTERVAL_S) * 2)
            return None

        word = _first_str(payload, "status", "state", "error", "detail", "message").lower()
        # FastAPI's HTTPException nests the useful word under "detail".
        detail = payload.get("detail")
        if isinstance(detail, dict):
            word = word or _first_str(detail, "status", "error", "message").lower()

        if word in _DENIED_WORDS:
            raise PairingDenied("an administrator refused this station")
        if word in _EXPIRED_WORDS:
            raise PairingExpired("the pairing code expired before it was approved")
        if word in _SPENT_WORDS:
            raise PairingExpired(
                "this pairing was already collected once and SMPL will not reissue "
                "the token. If the station is not paired, start a new pairing; if "
                "another process took it, check for a second running agent."
            )

        token_value = _first_str(
            payload, "access_token", "token", "station_token", "api_token", "bearer_token"
        )
        if token_value:
            return self._build_token(payload, token_value)

        if word in _PENDING_WORDS:
            return None
        # 202 Accepted / 425 Too Early / 428 Precondition Required are all
        # reasonable ways to say "not yet" without a body we understand.
        if response.status in (202, 204, 400, 404, 409, 412, 425, 428):
            return None
        if word == "approved":
            # Approved, but no token in the body. SMPL issues the raw token
            # exactly once, so this is the "claimed" case arriving under a
            # different name - and retrying forever would never fix it.
            raise PairingExpired(
                "SMPL approved this station but sent no token, which means the "
                "token was already collected. Start a new pairing."
            )
        if response.status in (401, 403):
            raise PairingDenied("SMPL rejected the pairing (HTTP %d)" % response.status)
        if response.status in (410, 419):
            raise PairingExpired("the pairing code is no longer valid (HTTP %d)" % response.status)
        if response.status >= 500:
            return None  # a wobbling server is a reason to keep waiting
        if response.status == 200:
            # 200 with nothing we recognise: treat as pending rather than
            # inventing a failure. The loop has its own deadline.
            return None
        raise PairingError("unexpected pairing answer (HTTP %d)" % response.status)

    def _build_token(self, payload: Dict[str, Any], token_value: str) -> StationToken:
        expires_at = _first_str(payload, "expires_at", "token_expires_at", "valid_until")
        if not expires_at:
            seconds = _first_number(payload, "expires_in", "token_expires_in")
            if seconds and seconds > 0:
                expires_at = _iso(datetime.now(timezone.utc) + timedelta(seconds=seconds))
        label = _first_str(payload, "label", "station_name", "device_name", "name", "username")
        scopes_raw = payload.get("scopes") or payload.get("scope")
        if isinstance(scopes_raw, str):
            scopes = [s for s in scopes_raw.split() if s]
        elif isinstance(scopes_raw, list):
            scopes = [str(s) for s in scopes_raw]
        else:
            scopes = []
        return StationToken(
            token=token_value,
            base_url=self.base_url,
            obtained_at=_iso(datetime.now(timezone.utc)),
            expires_at=expires_at,
            label=label,
            scopes=scopes,
        )


def _clamp(interval: float) -> float:
    return max(MIN_INTERVAL_S, min(MAX_INTERVAL_S, float(interval)))


def _relative(url: str, base: str) -> str:
    """Reduce an absolute poll URL to a path, but only if it is on our host."""
    if not url:
        return ""
    if url.startswith("/"):
        return url
    if base and url.startswith(base):
        return url[len(base):] or "/"
    # An absolute URL pointing somewhere else is not something we will follow -
    # a redirect to another host is how a token walks out of the building.
    return ""


def _decode(raw: bytes):
    if not raw:
        return None
    try:
        return json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None


@dataclass(frozen=True)
class _Response:
    status: int
    parsed: Any
    error: str


# --------------------------------------------------------------------------
# The background session the HTTP endpoints drive
# --------------------------------------------------------------------------


class PairingSession:
    """Runs one pairing attempt on a thread and reports its state.

    The station page cannot block for the two minutes an admin takes to walk
    to their desk, so ``begin()`` returns as soon as there is a code to show
    and ``snapshot()`` is what the page polls.
    """

    def __init__(self, client: PairingClient, store: TokenStore, *,
                 device_id: str, device_name: str, agent_version: str = "") -> None:
        self._client = client
        self._store = store
        self._device_id = device_id
        self._device_name = device_name
        self._agent_version = agent_version
        self._lock = threading.Lock()
        self._thread: Optional[threading.Thread] = None
        self._stop = threading.Event()
        self._state = "idle"
        self._request: Optional[PairingRequest] = None
        self._error = ""
        self._token_label = ""

    # -- control ----------------------------------------------------------

    def begin(self, device_name: str = "") -> Dict[str, Any]:
        """Start pairing. Blocks only for step 1 - typically one round trip."""
        with self._lock:
            if self._state == "waiting" and self._request and not self._request.expired:
                return self.snapshot()  # already showing a live code
            self._stop.set()  # retire any previous loop
            self._stop = threading.Event()
            self._state = "starting"
            self._error = ""
            self._request = None

        try:
            request = self._client.start(
                device_name=device_name or self._device_name,
                device_id=self._device_id,
                agent_version=self._agent_version,
            )
        except PairingUnavailable as exc:
            with self._lock:
                self._state = "unavailable"
                self._error = str(exc)
            return self.snapshot()
        except PairingError as exc:
            with self._lock:
                self._state = "error"
                self._error = str(exc)
            return self.snapshot()

        with self._lock:
            self._request = request
            self._state = "waiting"
            stop = self._stop
            self._thread = threading.Thread(
                target=self._wait_loop, args=(request, stop), name="station-pairing", daemon=True
            )
            self._thread.start()
        return self.snapshot()

    def cancel(self) -> Dict[str, Any]:
        with self._lock:
            self._stop.set()
            if self._state in ("waiting", "starting"):
                self._state = "cancelled"
                self._request = None
        return self.snapshot()

    def _wait_loop(self, request: PairingRequest, stop: threading.Event) -> None:
        interval = request.interval
        while not stop.is_set():
            if stop.wait(interval):
                return
            if request.expired:
                self._finish("expired", "nobody approved the code in time")
                return
            try:
                token = self._client.poll(request)
            except PairingDenied as exc:
                self._finish("denied", str(exc))
                return
            except PairingExpired as exc:
                self._finish("expired", str(exc))
                return
            except PairingUnavailable as exc:
                self._finish("unavailable", str(exc))
                return
            except PairingError as exc:
                # A transient network failure mid-wait is normal on a LAN.
                # Keep polling, but back off, and show why we are waiting.
                with self._lock:
                    self._error = str(exc)
                interval = _clamp(interval * 1.5)
                continue
            hint = self._client.interval_hint
            if hint:
                interval = hint
            if token is not None:
                try:
                    self._store.save(token)
                except OSError as exc:
                    self._finish("error", "paired, but the token could not be saved: %s" % exc)
                    return
                with self._lock:
                    self._token_label = token.label
                self._finish("paired", "")
                return

    def _finish(self, state: str, error: str) -> None:
        with self._lock:
            self._state = state
            self._error = error
            if state != "waiting":
                self._request = None

    # -- reporting --------------------------------------------------------

    def snapshot(self) -> Dict[str, Any]:
        with self._lock:
            payload: Dict[str, Any] = {
                "state": self._state,
                "error": self._error or None,
                "device_id": self._device_id,
                "device_name": self._device_name,
            }
            if self._request is not None and not self._request.expired:
                payload.update(self._request.as_dict())
            if self._token_label:
                payload["label"] = self._token_label
        stored = self._store.load()
        payload["paired"] = stored is not None and not stored.expired
        if stored is not None:
            payload["token_info"] = stored.public()
        payload["token_file_secure"] = self._store.secure()
        return payload
