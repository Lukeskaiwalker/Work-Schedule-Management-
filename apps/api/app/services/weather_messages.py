"""The notes the project weather card shows, in the UI's language.

``GET /projects/{id}/weather`` takes ``lang`` already — OpenWeather answers
in it — but its own notes were English only, so a German crew read
"OpenWeather API key is not configured". The notes are keyed here and said in
German or English.

An upstream failure carries OpenWeather's own English text ("Invalid API key.
Please see https://…"). The German note names the reason in German and leaves
that text out — it goes to the log, where whoever fixes the key reads it. The
English note keeps showing it, as it always did.

``ProjectWeatherCache.last_error`` keeps the raw text (a diagnostic, like a
log line) and is translated when it is read back, so a cache filled under one
language reads right under the other.
"""

from __future__ import annotations

from typing import Literal

WeatherLanguage = Literal["de", "en"]

# key → (German, English). The English texts are the ones the endpoint has
# always sent, so the English UI does not change.
_TEXTS: dict[str, tuple[str, str]] = {
    "address_missing": (
        "Für das Projekt ist keine Baustellen- oder Kundenadresse hinterlegt.",
        "Project construction site/customer address is missing",
    ),
    "api_key_missing": ("Kein OpenWeather-API-Schlüssel hinterlegt.", "OpenWeather API key is not configured"),
    "api_key_invalid": (
        "Der OpenWeather-API-Schlüssel ist ungültig (oder noch nicht aktiv).",
        "OpenWeather API key is invalid (or not active yet)",
    ),
    "not_subscribed": (
        "Der OpenWeather-API-Schlüssel hat keinen Zugriff auf die Wettervorhersage.",
        "OpenWeather forecast API access is not enabled for this key",
    ),
    "address_not_found": ("Die Adresse wurde vom Wetterdienst nicht gefunden.", "Address could not be geocoded"),
    "no_forecast": ("Für diesen Ort liegt keine Wettervorhersage vor.", "No weather forecast data available"),
    "fetch_failed": ("Wetterdaten konnten nicht abgerufen werden.", "Weather fetch failed"),
    "no_cache_yet": ("Noch keine Wetterdaten zwischengespeichert.", "No cached weather values yet"),
}

# Lower-cased fragments of the upstream / stored text → reason. First match
# wins; the stored sentences of earlier versions are matched as well.
_REASON_FRAGMENTS: tuple[tuple[str, str], ...] = (
    ("invalid api key", "api_key_invalid"),
    ("api key is invalid", "api_key_invalid"),
    ("not subscribed", "not_subscribed"),
    ("not enabled for this key", "not_subscribed"),
    ("geocod", "address_not_found"),
    ("no weather forecast", "no_forecast"),
    ("no daily weather forecast", "no_forecast"),
)


def weather_message(key: str, language: WeatherLanguage) -> str:
    german, english = _TEXTS[key]
    return german if language == "de" else english


def weather_error_reason(raw: str | None) -> str:
    """Which of the known failures the upstream text describes."""
    lowered = (raw or "").lower()
    for fragment, reason in _REASON_FRAGMENTS:
        if fragment in lowered:
            return reason
    return "fetch_failed"


def english_error_text(raw: str) -> str:
    """The upstream text, with the two known reasons said plainly (the
    English note has always shown it this way)."""
    reason = weather_error_reason(raw)
    if reason in ("api_key_invalid", "not_subscribed"):
        return weather_message(reason, "en")
    return raw


def weather_failure_message(raw: str | None, language: WeatherLanguage, *, cached: bool) -> str:
    """The note for a refresh that failed — over cached days or with none."""
    text = (raw or "").strip()
    if language == "de":
        reason = weather_error_reason(text)
        failed = weather_message("fetch_failed", "de")
        body = failed if reason == "fetch_failed" else f"{failed[:-1]}: {weather_message(reason, 'de')}"
        return f"Zwischengespeicherte Wetterdaten — {body}" if cached else body
    if cached:
        return f"Using cached weather values ({text[:140]})"
    return f"Weather fetch failed: {text[:180]}"


def stored_error_message(raw: str | None, language: WeatherLanguage) -> str | None:
    """``last_error`` read back with the cached days; ``None`` when there is none."""
    if not raw:
        return None
    if language == "de":
        return weather_failure_message(raw, "de", cached=True)
    return raw
