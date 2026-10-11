"""Keep bearer secrets out of the API's own request log.

uvicorn writes one line per request — client, method, path WITH its query
string, status — to the ``uvicorn.access`` logger, and that line ends up in
``docker logs`` and in every dump someone takes of it. Some of our URLs carry
a credential:

  ``?token=`` / ``?ticket=``      the event stream (EventSource cannot send a
                                  header); invite and password-reset links
  ``/api/calendar/<t>/feed.ics``  the Kalender-Abo — a calendar app cannot log
                                  in, so the URL IS the credential
  ``/api/public/customer-confirmations/<t>`` and ``/confirm/<t>``
                                  the customer's appointment link
  ``/api/werkstatt/ids/(handoff|hook)/<t>``
                                  the IDS-Connect hand-over

Those cannot all move out of the URL, so the log line is rewritten instead.
Only the secret part goes; method, path shape and status stay, because the
log exists to answer "what happened" and still has to.

The same pattern lives in apps/web/Caddyfile (snippet ``log_redaction``) for
the proxy's log — Python ``re`` and Go RE2 read it identically. Change both
together; docs/LOG_HYGIENE.md lists what is covered and why.
"""

from __future__ import annotations

import logging
import re

REDACTED = "REDACTED"

# Three alternatives, one capture group each for what is KEPT around the
# secret, so a single substitution handles them all (an alternative that did
# not match contributes an empty group):
#   1. a credential query parameter, up to the next & or #
#   2. a path whose next segment is the credential
#   3. the calendar token, only in the feed.ics URL — /api/calendar/feed is
#      the signed-in management route and must stay readable
# ``(?:^|://[^/]+|\s)`` anchors the paths at the start of a request target,
# right after the authority of a full URL (a Referer), or after whitespace in
# a free-text message, so a path merely mentioned inside a query value is not
# mistaken for one.
_PATH_START = r"(?:^|://[^/]+|\s)"
SECRET_IN_URL = re.compile(
    r"([?&](?:access_token|token|ticket)=)[^&#]*"
    rf"|({_PATH_START}/(?:confirm|api/public/customer-confirmations|api/werkstatt/ids/(?:handoff|hook))/)[^/?#]+"
    rf"|({_PATH_START}/api/calendar/)[^/?#]+(/feed\.ics)"
)
_REPLACEMENT = rf"\g<1>\g<2>\g<3>{REDACTED}\g<4>"


def redact_secrets(text: str) -> str:
    """``text`` with every credential-bearing part of a URL replaced."""
    return SECRET_IN_URL.sub(_REPLACEMENT, text)


class SecretRedactingFilter(logging.Filter):
    """Redact secrets in a record's arguments (and its message, if it is a
    preformatted string) before any handler formats it.

    uvicorn passes the path as an ``args`` element and its AccessFormatter
    unpacks exactly five of them, so the tuple keeps its shape and its
    non-string members untouched; only strings are rewritten.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.msg, str):
            record.msg = redact_secrets(record.msg)
        if isinstance(record.args, tuple):
            record.args = tuple(redact_secrets(arg) if isinstance(arg, str) else arg for arg in record.args)
        return True


# uvicorn.error carries the WebSocket request lines and protocol warnings that
# quote a target; uvicorn.access carries every HTTP request line.
_REDACTED_LOGGERS = ("uvicorn.access", "uvicorn.error")


def install_access_log_redaction() -> None:
    """Attach the filter to uvicorn's loggers, once per process.

    Called when app.main is imported. uvicorn configures its loggers before
    it imports the app — in every worker process too — so a filter attached
    here is not undone by that configuration, and it applies whatever
    ``--workers`` or log config the CMD chooses.
    """
    for name in _REDACTED_LOGGERS:
        logger = logging.getLogger(name)
        if not any(isinstance(existing, SecretRedactingFilter) for existing in logger.filters):
            logger.addFilter(SecretRedactingFilter())
