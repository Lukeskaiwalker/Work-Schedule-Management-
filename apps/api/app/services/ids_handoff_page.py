"""The two HTML pages the punchout needs, and the headers that make them safe.

Everything else in this application answers JSON to our own frontend. These
two are different: they are rendered into the user's browser as part of a
hand-over to a third-party site, so they get their own hardening rather than
inheriting whatever the SPA happens to have.

## Why a page at all

A punchout hand-over is an HTTP POST carrying credentials to the wholesaler.
A browser cannot be *navigated* into a POST — `window.open` and `location =`
both issue a GET — so the only way to produce one is to render a form and
submit it. This page is that form, and nothing else.

## Why the credentials are not in the SPA

The obvious implementation is to hand the frontend the field values and let it
build the form. That would put a live wholesale ordering password into
JavaScript, into React state, into any error reporter that serialises state,
and into the browser devtools of every user who knows where to look.

Rendering server-side means the password exists only in the HTML of a document
that submits itself immediately and is never cached. That is not perfect — a
determined user can read their own page source, and IDS gives us no way around
that because the protocol itself is a browser form POST — but it removes every
accidental route.
"""

from __future__ import annotations

import base64
import hashlib
from typing import Mapping
from urllib.parse import urlsplit
from xml.sax.saxutils import escape, quoteattr

# Submitting from script rather than leaving the user a button keeps the
# hand-over to one click on our side. The <noscript> path and the visible
# button below are the fallback when script is blocked.
_AUTOSUBMIT_SCRIPT = "document.getElementById('ids').submit();"


def _script_hash() -> str:
    """CSP source expression for the inline script above.

    A hash rather than `'unsafe-inline'`: the script is a fixed constant, so
    pinning it costs nothing and keeps the page from being a place where
    injected script would run even if something upstream went wrong.
    """

    digest = hashlib.sha256(_AUTOSUBMIT_SCRIPT.encode("utf-8")).digest()
    return f"'sha256-{base64.b64encode(digest).decode('ascii')}'"


def _origin_of(url: str) -> str:
    parts = urlsplit(url)
    if not parts.scheme or not parts.netloc:
        return ""
    return f"{parts.scheme}://{parts.netloc}"


def handoff_headers(action_url: str) -> dict[str, str]:
    """Response headers for the credential-bearing hand-over page.

    - `no-store` so the password never reaches a disk cache or the back button.
    - `no-referrer` so the wholesaler's server is not handed our hook URL (and
      with it the session token) in a `Referer` header.
    - a CSP that permits exactly one destination for the form and exactly one
      script, and nothing else at all — no images, no styles from anywhere, no
      frames. The page needs none of them.
    """

    origin = _origin_of(action_url)
    form_action = f"form-action {origin}" if origin else "form-action 'none'"
    return {
        "Cache-Control": "no-store, no-cache, must-revalidate, private",
        "Pragma": "no-cache",
        "Referrer-Policy": "no-referrer",
        "X-Robots-Tag": "noindex, nofollow",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "Content-Security-Policy": (
            "default-src 'none'; "
            "style-src 'unsafe-inline'; "
            f"script-src {_script_hash()}; "
            f"{form_action}; "
            "base-uri 'none'; "
            "frame-ancestors 'none'"
        ),
    }


_STYLE = (
    "body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;"
    "background:#0f1115;color:#e6e8ee;display:flex;align-items:center;"
    "justify-content:center;min-height:100vh;margin:0}"
    ".card{max-width:26rem;padding:2rem;text-align:center;line-height:1.5}"
    "h1{font-size:1.15rem;margin:0 0 .5rem}"
    "p{color:#9aa1b1;font-size:.9rem;margin:0 0 1.25rem}"
    "button,a.btn{background:#3b82f6;color:#fff;border:0;border-radius:.5rem;"
    "padding:.6rem 1.1rem;font-size:.95rem;cursor:pointer;text-decoration:none;"
    "display:inline-block}"
    ".err{color:#f87171}"
)


def render_handoff_page(
    *,
    action_url: str,
    method: str,
    fields: Mapping[str, str],
    supplier_name: str,
) -> str:
    """The self-submitting form that carries the browser to the wholesaler."""

    inputs = "\n".join(
        f"    <input type=hidden name={quoteattr(name)} value={quoteattr(value)}>"
        for name, value in fields.items()
    )
    safe_supplier = escape(supplier_name)
    safe_method = "GET" if method.upper() == "GET" else "POST"
    return f"""<!doctype html>
<html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Weiterleitung zu {safe_supplier}</title>
<style>{_STYLE}</style></head>
<body><div class=card>
  <h1>Weiterleitung zu {safe_supplier}</h1>
  <p>Der Warenkorb wird im Shop zusammengestellt. Nach dem Absenden
     kehrt er automatisch in die Bestellung zurück.</p>
  <form id=ids method="{safe_method}" action={quoteattr(action_url)}>
{inputs}
    <button type=submit>Weiter zum Shop</button>
  </form>
</div>
<script>{_AUTOSUBMIT_SCRIPT}</script>
</body></html>"""


def result_headers() -> dict[str, str]:
    """Headers for the page the shop lands the user on after the cart returns."""

    return {
        "Cache-Control": "no-store, no-cache, must-revalidate, private",
        "Referrer-Policy": "no-referrer",
        "X-Robots-Tag": "noindex, nofollow",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "Content-Security-Policy": (
            "default-src 'none'; style-src 'unsafe-inline'; "
            "base-uri 'none'; frame-ancestors 'none'"
        ),
    }


def render_result_page(
    *, heading: str, message: str, return_url: str, is_error: bool = False
) -> str:
    """Where the user ends up when the cart comes back.

    A plain link rather than an automatic redirect: the user has just left a
    third-party site and this is the one moment they get to read whether their
    basket actually arrived. Bouncing them onward would hide exactly the
    message they need — especially the failure one, which tells them the cart
    is recoverable from the import log rather than lost.
    """

    css_class = "err" if is_error else ""
    return f"""<!doctype html>
<html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>{escape(heading)}</title>
<style>{_STYLE}</style></head>
<body><div class=card>
  <h1 class="{css_class}">{escape(heading)}</h1>
  <p>{escape(message)}</p>
  <a class=btn href={quoteattr(return_url)}>Zurück zu SMPL</a>
</div></body></html>"""
