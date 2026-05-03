"""Lazy OpenAI client wrapper.

The ``openai`` SDK is heavy and only needed at extraction time. This
module imports it on demand so:

- The api startup doesn't pay for the SDK if no extraction is configured.
- Tests don't need the real package installed — they monkeypatch this
  module to inject fake clients.
- The dev environment can boot without ``OPENAI_API_KEY`` set; only the
  worker's actual extraction call fails (with a clear error) until an
  admin saves a key in the UI.

The single public entry-point is ``get_openai_client(db)`` which reads
the runtime-stored key, instantiates the SDK, and returns it. Callers
catch ``OpenAIClientNotConfigured`` to surface a friendly message in the
job's ``error_message`` column.
"""
from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from app.services.runtime_settings import (
    OPENAI_DEFAULT_EXTRACTION_MODEL,
    get_openai_settings,
)


class OpenAIClientNotConfigured(RuntimeError):
    """Raised when extraction is requested but no API key is stored.

    The worker catches this and writes a stable, operator-readable
    error onto the job row so the UI can surface a 'Configure API key'
    nudge instead of a stack trace."""


def get_openai_client(db: Session) -> Any:
    """Return a configured ``openai.OpenAI`` client.

    Raises
    ------
    OpenAIClientNotConfigured
        If no API key is stored in runtime settings.
    """
    settings = get_openai_settings(db)
    api_key = (settings.get("api_key") or "").strip()
    if not api_key:
        raise OpenAIClientNotConfigured(
            "No OpenAI API key is configured. Save one under Admin → "
            "Settings → OpenAI before running extraction."
        )

    # Lazy import — keep SDK out of startup paths.
    from openai import OpenAI  # type: ignore[import-not-found]

    return OpenAI(api_key=api_key)


def get_extraction_model(db: Session) -> str:
    """Return the operator-configured extraction model, or the default."""
    settings = get_openai_settings(db)
    model = (settings.get("extraction_model") or "").strip()
    return model or OPENAI_DEFAULT_EXTRACTION_MODEL
