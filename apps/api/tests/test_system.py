from __future__ import annotations
from datetime import datetime, time, timedelta, timezone
import json
from fastapi.testclient import TestClient
from app.main import _rate_bucket
def auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}



def test_rate_limiter_returns_429_response_without_middleware_exception(client: TestClient):
    _rate_bucket.clear()
    warmup = client.get("/api")
    assert warmup.status_code == 200
    key = next((value for value in _rate_bucket.keys() if value.endswith(":default")), None)
    assert key is not None
    bucket = _rate_bucket[key]
    bucket.clear()
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    for _ in range(480):
        bucket.append(now)

    limited = client.get("/api")
    assert limited.status_code == 429
    assert limited.json().get("detail") == "Too many requests"
    assert limited.headers.get("Retry-After") == "60"
    _rate_bucket.clear()
