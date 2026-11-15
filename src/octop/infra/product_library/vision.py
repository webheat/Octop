"""LLM-generated image content descriptions for the product library.

Descriptions and tags live in ``product_library_asset_descriptions``; image
bytes stay on disk. Analysis is strictly on demand: upload and listing never
call a model, and a failed call is recorded on the row so it can be retried.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
from typing import Any

from langchain_core.messages import HumanMessage

from octop.infra.agents.providers.probe import build_probe_chat_model
from octop.infra.agents.providers.store import ProviderStore
from octop.infra.product_library.service import ProductLibraryService
from octop.infra.utils.llm_text import llm_text_content

SUPPORTED_IMAGE_TYPES = frozenset({"image/png", "image/jpeg", "image/webp", "image/gif"})
MAX_IMAGE_BYTES = 8 * 1024 * 1024
MAX_TAGS = 12
MAX_DESCRIPTION_CHARS = 2000
MAX_ERROR_CHARS = 500

_PROMPT = (
    "You are cataloguing a product image for a media asset library. "
    "Describe only what is actually visible: subject, colors, materials, "
    "composition, camera angle, background, lighting and any legible text. "
    "Never invent brand names, prices, specifications, certifications or claims. "
    "Return ONLY one JSON object with exactly two keys: "
    '"description" (2-4 plain sentences, no markdown) and '
    '"tags" (3-8 short searchable keyword strings). '
    "Use the language of any visible text, otherwise use Chinese."
)


class VisionModelUnavailable(RuntimeError):
    """No enabled provider exposes an image-capable chat model."""


def resolve_vision_model(provider_repo: Any) -> tuple[Any, str]:
    """Resolve the first enabled vision model from the configured providers."""
    ref = ProviderStore(provider_repo).resolve_multimodal_model_ref()
    if not ref:
        raise VisionModelUnavailable("no enabled vision model is configured")
    provider_name, _, model_id = ref.partition("/")
    row = provider_repo.get_by_name(provider_name)
    if row is None:
        raise VisionModelUnavailable(f"provider {provider_name!r} is unavailable")
    return build_probe_chat_model(row, model_id=model_id), ref


def parse_description_payload(raw: str) -> tuple[str, list[str]]:
    """Validate the model's JSON answer before anything is written to SQLite."""
    text = (raw or "").strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[-1].rsplit("```", 1)[0].strip()
    payload = json.loads(text)
    if not isinstance(payload, dict):
        raise ValueError("model output is not a JSON object")
    description = payload.get("description")
    if not isinstance(description, str) or not description.strip():
        raise ValueError("model output has no description")
    raw_tags = payload.get("tags", [])
    if not isinstance(raw_tags, list):
        raise ValueError("model output tags must be a list")
    tags = [
        str(tag).strip()
        for tag in raw_tags
        if isinstance(tag, (str, int, float)) and not isinstance(tag, bool)
    ]
    return description.strip()[:MAX_DESCRIPTION_CHARS], [tag for tag in tags if tag][:MAX_TAGS]


def describe_image(data: bytes, media_type: str, model: Any) -> tuple[str, list[str]]:
    """One bounded vision call; base64 never leaves this function."""
    encoded = base64.b64encode(data).decode("ascii")
    message = HumanMessage(
        content=[
            {"type": "text", "text": _PROMPT},
            {
                "type": "image_url",
                "image_url": {"url": f"data:{media_type};base64,{encoded}"},
            },
        ]
    )
    text = llm_text_content(model.invoke([message]))
    if not text.strip():
        raise ValueError("vision model returned an empty response")
    return parse_description_payload(text)


async def _resolve_model(provider_repo: Any) -> tuple[tuple[Any, str] | None, str]:
    try:
        return await asyncio.to_thread(resolve_vision_model, provider_repo), ""
    except Exception as exc:
        return None, str(exc)[:MAX_ERROR_CHARS]


async def _describe_one(
    service: ProductLibraryService,
    *,
    owner_id: int,
    asset: dict[str, Any],
    model_pair: tuple[Any, str] | None,
    setup_error: str,
) -> dict[str, Any]:
    repo = service.repo
    asset_id = asset["id"]
    content_hash = asset["content_hash"]
    model_ref = model_pair[1] if model_pair else ""

    if setup_error:
        repo.mark_description_failed(owner_id, asset_id, error=setup_error, model=model_ref)
        return repo.get_asset(owner_id, asset_id) or {}

    # Re-uploading identical bytes into another product must not spend a second call.
    cached = repo.find_ready_description_by_hash(owner_id, content_hash)
    if cached is not None and cached["asset_id"] != asset_id:
        repo.save_description(
            owner_id,
            asset_id,
            content_hash=content_hash,
            description=cached["description"],
            tags=json.loads(cached["tags"] or "[]"),
            status="ready",
            model=cached["model"],
        )
        return repo.get_asset(owner_id, asset_id) or {}

    try:
        media_type = asset["media_type"]
        if not media_type.startswith("image/"):
            raise ValueError("content descriptions are only available for image assets")
        if media_type not in SUPPORTED_IMAGE_TYPES:
            raise ValueError(f"unsupported image type: {media_type}")
        source = service.paths.product_library_dir / asset["storage_path"]
        data = await asyncio.to_thread(source.read_bytes)
        if not data:
            raise ValueError("asset file is empty")
        if len(data) > MAX_IMAGE_BYTES:
            raise ValueError("image exceeds the 8 MB vision limit")
        if hashlib.sha256(data).hexdigest() != content_hash:
            raise ValueError("asset file no longer matches its recorded hash")
        description, tags = await asyncio.to_thread(
            describe_image, data, media_type, model_pair[0] if model_pair else None
        )
        repo.save_description(
            owner_id,
            asset_id,
            content_hash=content_hash,
            description=description,
            tags=tags,
            status="ready",
            model=model_ref,
        )
    except Exception as exc:
        repo.mark_description_failed(
            owner_id, asset_id, error=str(exc)[:MAX_ERROR_CHARS], model=model_ref
        )
    return repo.get_asset(owner_id, asset_id) or {}


async def describe_asset(
    service: ProductLibraryService,
    provider_repo: Any,
    *,
    owner_id: int,
    asset_id: str,
) -> dict[str, Any]:
    """Describe one image. Ownership is checked by ``service.get_asset``."""
    asset = service.get_asset(owner_id, asset_id)
    model_pair, setup_error = await _resolve_model(provider_repo)
    return await _describe_one(
        service,
        owner_id=owner_id,
        asset=asset,
        model_pair=model_pair,
        setup_error=setup_error,
    )


async def describe_missing_assets(
    service: ProductLibraryService,
    provider_repo: Any,
    *,
    owner_id: int,
    product_id: str,
) -> dict[str, Any]:
    """Describe every image whose content is missing, failed or stale."""
    # list_assets also validates that the product belongs to this owner.
    assets = service.list_assets(owner_id, product_id)
    pending = [
        asset
        for asset in assets
        if asset["media_type"].startswith("image/")
        and (asset["ai_status"] != "ready" or asset["ai_content_hash"] != asset["content_hash"])
    ]
    if not pending:
        return {"total": 0, "succeeded": 0, "failed": 0, "items": []}
    model_pair, setup_error = await _resolve_model(provider_repo)
    items = [
        await _describe_one(
            service,
            owner_id=owner_id,
            asset=asset,
            model_pair=model_pair,
            setup_error=setup_error,
        )
        for asset in pending
    ]
    succeeded = sum(1 for item in items if item["ai_status"] == "ready")
    return {
        "total": len(items),
        "succeeded": succeeded,
        "failed": len(items) - succeeded,
        "items": items,
    }
