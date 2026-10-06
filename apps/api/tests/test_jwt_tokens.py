"""The session token: what verifies, and everything that must not.

Pinned when python-jose was replaced by PyJWT (2026-10-06). python-jose
<= 3.5.0 carries CVE-2026-85394 (GHSA-3qf3-8w2g-rqmx, critical): it accepts a
DER-encoded public key as an HMAC secret, so a service that verifies RS/ES
tokens without restricting algorithms takes an HS256 token forged with its
own public key. SMPL was not exposed -- it signs with a symmetric SECRET_KEY
and pins HS256 -- but the library has no fixed release, so it was replaced.

These tests build tokens with the standard library alone (base64url + HMAC),
so they check behaviour, not whichever JWT library happens to be installed:

  * a token issued BEFORE the switch still verifies, so nobody is logged out
    by the deploy that ships it;
  * alg "none", any other algorithm, a wrong key, an expired token and a
    tampered payload are all refused.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time

from app.core.security import (
    MFA_CHALLENGE_PURPOSE,
    create_access_token,
    create_mfa_challenge_token,
    decode_token,
    settings,
)

#: Issued by python-jose 3.5.0 exactly as production did until this release,
#: with the test suite's SECRET_KEY ("test-secret"), valid until 2100.
ISSUED_BY_PYTHON_JOSE = (
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9."
    "eyJzdWIiOiIxIiwicm9sZSI6ImFkbWluIiwiaWF0IjoxNzkxMjQ0ODAwLCJleHAiOjQxMDI0NDQ4MDB9."
    "JfD0cOCQND_ukwioWOLu8zJ3azwsfP3HoZrj21ftNhw"
)


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _token(claims: dict, *, alg: str = "HS256", key: str | None = None, digest=hashlib.sha256) -> str:
    header = _b64(json.dumps({"alg": alg, "typ": "JWT"}, separators=(",", ":")).encode())
    payload = _b64(json.dumps(claims, separators=(",", ":")).encode())
    signing_input = f"{header}.{payload}".encode()
    secret = (settings.secret_key if key is None else key).encode()
    signature = _b64(hmac.new(secret, signing_input, digest).digest())
    return f"{header}.{payload}.{signature}"


def _claims(**overrides) -> dict:
    now = int(time.time())
    return {"sub": "7", "iat": now, "exp": now + 600, **overrides}


def test_a_token_issued_before_the_switch_still_verifies() -> None:
    assert decode_token(ISSUED_BY_PYTHON_JOSE) == {
        "sub": "1",
        "role": "admin",
        "iat": 1791244800,
        "exp": 4102444800,
    }


def test_a_token_we_issue_reads_back() -> None:
    claims = decode_token(create_access_token("7", extra={"role": "employee"}))
    assert claims is not None
    assert (claims["sub"], claims["role"]) == ("7", "employee")
    assert claims["exp"] > time.time()


def test_a_hand_built_hs256_token_verifies() -> None:
    """The control for every refusal below: the builder itself is right."""
    assert decode_token(_token(_claims()))["sub"] == "7"


def test_alg_none_is_refused() -> None:
    header = _b64(b'{"alg":"none","typ":"JWT"}')
    payload = _b64(json.dumps(_claims()).encode())
    assert decode_token(f"{header}.{payload}.") is None


def test_another_hmac_algorithm_is_refused() -> None:
    assert decode_token(_token(_claims(), alg="HS512", digest=hashlib.sha512)) is None


def test_an_asymmetric_algorithm_name_is_refused() -> None:
    """The algorithm-confusion vector: whatever the header claims, only HS256
    with our secret is ever accepted."""
    assert decode_token(_token(_claims(), alg="RS256")) is None


def test_a_wrong_key_is_refused() -> None:
    assert decode_token(_token(_claims(), key="not-our-secret")) is None


def test_an_expired_token_is_refused() -> None:
    now = int(time.time())
    assert decode_token(_token(_claims(iat=now - 7200, exp=now - 3600))) is None


def test_a_tampered_payload_is_refused() -> None:
    header, _payload, signature = _token(_claims()).split(".")
    forged = _b64(json.dumps(_claims(sub="1", role="admin")).encode())
    assert decode_token(f"{header}.{forged}.{signature}") is None


def test_garbage_is_refused_not_raised() -> None:
    for junk in ("", "a.b", "a.b.c", "....", "x" * 5000):
        assert decode_token(junk) is None


def test_the_mfa_challenge_keeps_its_purpose() -> None:
    claims = decode_token(create_mfa_challenge_token("7"))
    assert claims is not None
    assert claims["purpose"] == MFA_CHALLENGE_PURPOSE
