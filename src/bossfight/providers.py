"""Model provider layer: Gemini primary, DeepInfra failover, stub when keyless.

Behaviours: tolerant JSON parse (strip fences), pydantic validation, retry
once, 429/503 backoff x3, in-process semaphore capped at 3.
"""

from __future__ import annotations

import asyncio
import json
import os
import re

import httpx
from pydantic import BaseModel, Field

MAX_CONCURRENT = 3
SEMAPHORE = asyncio.Semaphore(MAX_CONCURRENT)

GEMINI_MODEL = "gemma-4-26b-a4b-it"
DEEPINFRA_MODEL = "gemma-4-26B-A4B-it"

GEMINI_URL = (
    f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}"
    ":generateContent"
)
DEEPINFRA_URL = "https://api.deepinfra.com/v1/openai/chat/completions"

# Last-call token accounting, overwritten on every Gemini call. Exists so
# latency can be attributed (reasoning vs queue) without a debugger.
LAST_USAGE: dict = {}


class BrainFields(BaseModel):
    tactic_id: str
    taunt: str = Field(max_length=140)
    intensity: float = Field(default=0.5, ge=0.0, le=1.0)


def keys() -> tuple[str | None, str | None]:
    return os.environ.get("GEMINI_API_KEY"), os.environ.get("DEEPINFRA_API_KEY")


def stubbed() -> bool:
    g, d = keys()
    return not (g or d)


def strip_fences(text: str) -> str:
    """Remove ```json fences and return raw JSON-ish body."""
    t = text.strip()
    t = re.sub(r"^```(?:json)?\s*", "", t)
    t = re.sub(r"\s*```$", "", t).strip()
    # tolerate leading/trailing prose: grab first {...} block
    m = re.search(r"\{.*\}", t, re.S)
    return m.group(0) if m else t


def parse_fields(payload: str) -> BrainFields:
    return BrainFields.model_validate_json(strip_fences(payload))


async def _post(url: str, headers: dict, body: dict) -> httpx.Response:
    # 429/503 backoff x3 (1s, 2s, 4s), then return last response / raise.
    delay = 1.0
    resp: httpx.Response | None = None
    async with httpx.AsyncClient(timeout=20) as client:
        for _ in range(3):
            resp = await client.post(url, headers=headers, json=body)
            if resp.status_code not in (429, 503):
                return resp
            await asyncio.sleep(delay)
            delay *= 2.0
        assert resp is not None
        return resp


async def call_gemini(prompt: str) -> BrainFields:
    key = os.environ.get("GEMINI_API_KEY", "")
    body = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {
            "responseMimeType": "application/json",
            # Gemma 4 thinks by default; undisabled, short replies take 20-40s.
            # Nested path + MINIMAL are both load-bearing: a direct
            # thinkingLevel is an unknown field, and LOW/MEDIUM are invalid
            # enum values on this model (misleading 400s either way).
            "thinkingConfig": {"thinkingLevel": "MINIMAL"},
        },
    }
    async with SEMAPHORE:
        resp = await _post(f"{GEMINI_URL}?key={key}", {}, body)
    resp.raise_for_status()
    data = resp.json()
    # Diagnostic for latency work: thoughtsTokenCount present-and-large means
    # the model is still reasoning; absent/0 means time went to queue/prefill.
    usage = data.get("usageMetadata", {})
    LAST_USAGE.update(
        {
            "thoughts": usage.get("thoughtsTokenCount", 0),
            "candidates": usage.get("candidatesTokenCount", 0),
            "prompt": usage.get("promptTokenCount", 0),
        }
    )
    text = data["candidates"][0]["content"]["parts"][0]["text"]
    return parse_fields(text)


async def call_deepinfra(prompt: str) -> BrainFields:
    key = os.environ.get("DEEPINFRA_API_KEY", "")
    body = {
        "model": DEEPINFRA_MODEL,
        "messages": [{"role": "user", "content": prompt}],
    }
    headers = {"Authorization": f"Bearer {key}"}
    async with SEMAPHORE:
        resp = await _post(DEEPINFRA_URL, headers, body)
    resp.raise_for_status()
    data = resp.json()
    text = data["choices"][0]["message"]["content"]
    return parse_fields(text)


async def generate(prompt: str) -> BrainFields:
    """Gemini primary → DeepInfra failover. Raises RuntimeError if both fail."""
    errors: list[str] = []
    g_key, d_key = keys()
    if g_key:
        try:
            return await call_gemini(prompt)
        except Exception as exc:  # noqa: BLE001 — failover path
            errors.append(f"gemini: {exc}")
    if d_key:
        try:
            return await call_deepinfra(prompt)
        except Exception as exc:  # noqa: BLE001 — surfaced to caller
            errors.append(f"deepinfra: {exc}")
    raise RuntimeError("; ".join(errors) or "no model keys configured")
