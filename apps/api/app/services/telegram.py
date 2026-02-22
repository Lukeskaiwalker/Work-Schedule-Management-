from __future__ import annotations
import httpx

from app.core.config import get_settings

settings = get_settings()


def telegram_enabled() -> bool:
    return bool(settings.telegram_bot_token and settings.telegram_chat_id)


async def send_telegram_message(text: str) -> bool:
    if not telegram_enabled():
        return False

    url = f"https://api.telegram.org/bot{settings.telegram_bot_token}/sendMessage"
    payload = {"chat_id": settings.telegram_chat_id, "text": text}
    async with httpx.AsyncClient(timeout=10) as client:
        response = await client.post(url, json=payload)
        return response.is_success


async def send_telegram_report(summary_text: str, pdf_bytes: bytes, pdf_filename: str) -> bool:
    if not telegram_enabled():
        return False

    base_url = f"https://api.telegram.org/bot{settings.telegram_bot_token}"
    async with httpx.AsyncClient(timeout=20) as client:
        message_resp = await client.post(
            f"{base_url}/sendMessage",
            json={"chat_id": settings.telegram_chat_id, "text": summary_text},
        )
        document_resp = await client.post(
            f"{base_url}/sendDocument",
            data={"chat_id": settings.telegram_chat_id, "caption": "Construction report PDF"},
            files={"document": (pdf_filename, pdf_bytes, "application/pdf")},
        )
    return message_resp.is_success and document_resp.is_success
