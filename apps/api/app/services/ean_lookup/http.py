"""The one way this package is allowed to touch the network.

Every rule that makes an outbound call from the api container safe lives here,
once: the SSRF guard from ``material_catalog_images`` (which resolves the host
and refuses anything that is not a public address), redirects handled by hand
so a public URL cannot 30x-bounce to an internal one after the check, a body
cap so a shop serving a 200 MB page cannot page out a container that is capped
at 1500 MB with swap off and has been OOM-killed before, and a deadline so the
whole cascade is bounded rather than each call being bounded separately.

Clients are created per call and closed immediately — no pool. Same reason:
a pool that grows under load is memory this container does not have.
"""

from __future__ import annotations

import time
from dataclasses import dataclass

import httpx

from app.services.material_catalog_images import USER_AGENT, is_public_http_url

# A product page is tens of kilobytes; a megabyte is already generous and
# still small enough that a hostile response cannot matter.
MAX_BODY_BYTES = 1_024 * 1_024

# One hop only. Shops answer a search URL with a 302 to the product page, so
# refusing every redirect would lose the most useful entry point — but a chain
# is how an open redirect reaches somewhere private, and each hop is re-checked
# against the SSRF guard regardless.
MAX_REDIRECTS = 1

ACCEPT_HEADER = "text/html,application/json;q=0.9,*/*;q=0.8"

# Below this a request is not worth starting, and it is also the floor for a
# timeout: httpx refuses a zero or negative one, and a budget that has just
# run out must fail the `exhausted` check rather than raise here.
MIN_REQUEST_SECONDS = 0.25


@dataclass
class Budget:
    """The wall clock the whole cascade shares.

    Per-call timeouts alone do not bound a cascade: three providers with a
    four-second read timeout make a twelve-second request. The budget is
    checked before every call and converted into that call's timeout, so the
    last provider gets whatever is left and no more.
    """

    total_seconds: float
    started_at: float

    @classmethod
    def start(cls, total_seconds: float) -> "Budget":
        return cls(total_seconds=max(0.5, float(total_seconds)), started_at=time.monotonic())

    def timeout(self) -> httpx.Timeout:
        """What is LEFT, as one request's timeout.

        Computed per request rather than once per cascade. Fixing the read
        timeout at the full budget when the client is built means a request
        begun just under the line runs its own full budget on top of what has
        already elapsed, so a single stalling host makes the whole lookup take
        roughly twice what the operator configured — which is what used to
        outlive the scan station's own timeout and leave the wall saying
        "nicht angelegt" for a delivery the server had booked.
        """
        remaining = max(MIN_REQUEST_SECONDS, min(self.remaining, self.total_seconds))
        return httpx.Timeout(
            connect=min(2.0, remaining),
            read=remaining,
            write=min(4.0, remaining),
            pool=min(2.0, remaining),
        )

    @property
    def remaining(self) -> float:
        return self.total_seconds - (time.monotonic() - self.started_at)

    @property
    def exhausted(self) -> bool:
        # Under a quarter second left is not worth a TCP handshake.
        return self.remaining <= MIN_REQUEST_SECONDS


def build_client(budget: Budget) -> httpx.Client:
    """A short-lived client for the whole cascade.

    Its timeout is only the floor: every request made through ``fetch_text``
    overrides it with what the budget has left at that moment.
    """
    return httpx.Client(
        timeout=budget.timeout(),
        follow_redirects=False,
        headers={"User-Agent": USER_AGENT, "Accept": ACCEPT_HEADER},
    )


def fetch_text(client: httpx.Client, url: str, budget: Budget) -> tuple[str, str] | None:
    """GET *url* and return ``(final_url, body)``, capped — or ``None``.

    ``None`` covers every failure a caller could possibly want to distinguish,
    because none of them change what happens next: a suggestion is simply not
    offered. Refusing to raise is the contract of this whole package.
    """
    current = url
    for _ in range(MAX_REDIRECTS + 1):
        if budget.exhausted or not is_public_http_url(current):
            return None
        try:
            # The per-request timeout, not the client's: see Budget.timeout.
            with client.stream("GET", current, timeout=budget.timeout()) as response:
                # Headers are in; the body may still be slow. A response that
                # arrived on the last of the budget is not worth reading.
                if budget.exhausted:
                    return None
                if response.status_code in (301, 302, 303, 307, 308):
                    location = response.headers.get("location") or ""
                    if not location:
                        return None
                    # str(), not human_repr(): the latter does not exist on
                    # httpx.URL in the pinned version, and a 302 is the shop's
                    # NORMAL answer to a search URL — so the one redirect this
                    # module exists to follow raised AttributeError, which is
                    # not in the except clause below and reached the client as
                    # HTTP 500 instead of a suggestion.
                    current = str(httpx.URL(current).join(location))
                    continue
                if response.status_code != 200:
                    return None
                content_type = (response.headers.get("content-type") or "").lower()
                if content_type and not (
                    "html" in content_type or "json" in content_type or "xml" in content_type
                ):
                    return None
                chunks: list[bytes] = []
                size = 0
                for chunk in response.iter_bytes():
                    chunks.append(chunk)
                    size += len(chunk)
                    if size >= MAX_BODY_BYTES:
                        break
                    if budget.exhausted:
                        break
                body = b"".join(chunks)[:MAX_BODY_BYTES]
                return str(response.url), body.decode("utf-8", errors="replace")
        except (httpx.HTTPError, httpx.InvalidURL, UnicodeError, ValueError):
            # InvalidURL is listed explicitly: it does NOT derive from
            # HTTPError or ValueError, and a shop is perfectly capable of
            # answering a 302 with a Location header that is not a URL. Since
            # the redirect above is the shop's normal answer to a search URL,
            # that would escape this package's never-raise contract.
            return None
    return None
