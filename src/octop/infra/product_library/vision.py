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
import re
import unicodedata
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
MAX_GROUP_CHARS = 120
MAX_CATEGORY_CHARS = 60

# Labels that carry no product identity. A model asked for "a short product
# name" sometimes answers with a generic word — most often the name of its own
# output field ("candidates"). Such an answer must never reach the library as
# a product name, so it is treated as "no name at all" and the caller falls
# back to a weaker signal (the source folder) instead.
_PLACEHOLDER_GROUP_LABELS = frozenset(
    {
        "candidates",
        "candidate",
        "group",
        "name",
        "unknown",
        "unspecified",
        "unnamed",
        "noname",
        "notapplicable",
        "na",
        "n/a",
        "none",
        "null",
        "nil",
        "todo",
        "tbd",
        "misc",
        "miscellaneous",
        "default",
        "默认",
        "默认名称",
        "未知",
        "未命名",
        "无名称",
        "待定",
        "候选",
        "候选品",
        "其他",
    }
)


def is_placeholder_group(text: str) -> bool:
    """True when *text* names no product.

    An empty string counts: it carries no identity either. Matching ignores
    case, width, spaces, dashes and underscores so "Candidates", "candidates"
    and "CANDIDATES " are all the same placeholder.
    """
    normalised = re.sub(r"[\s_\-]+", "", unicodedata.normalize("NFKC", text or "").casefold())
    if not normalised:
        return True
    return normalised in _PLACEHOLDER_GROUP_LABELS


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

# Structured variant used by directory import. It asks for a grouping hint so
# images can be archived under a product. Kept separate from _PROMPT so the
# existing "batch describe" behaviour never changes.
CATEGORISE_PROMPT = (
    "You are cataloguing product photos for a media asset library. "
    "Look only at what is actually visible; never invent brands, prices, "
    "specifications or certifications. Return ONLY one JSON object with exactly "
    "five keys: "
    '"group" (a short product name inferred from the visible subject, or an '
    "empty string if the product cannot be identified), "
    '"category" (one concise category word, or an empty string if unclear), '
    '"description" (2-4 plain sentences of only what is visible, no markdown), '
    '"tags" (3-8 short searchable keyword strings), and '
    '"confidence" (a float from 0 to 1 for how sure you are of the grouping). '
    "Use Chinese unless the visible text is in another language."
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


def parse_categorisation_payload(raw: str) -> dict[str, Any]:
    """Validate a categorise_image answer before anything is persisted.

    Mirrors ``parse_description_payload`` but additionally accepts a grouping
    hint and a confidence score. Model output is untrusted: every field is
    type-checked and bounded, and malformed answers raise ``ValueError``.
    """
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

    group = payload.get("group", "")
    if not isinstance(group, str):
        raise ValueError("model output group must be a string")
    category = payload.get("category", "")
    if not isinstance(category, str):
        raise ValueError("model output category must be a string")

    raw_confidence = payload.get("confidence", 0.0)
    if isinstance(raw_confidence, bool) or not isinstance(raw_confidence, (int, float)):
        raise ValueError("model output confidence must be a number")
    confidence = max(0.0, min(1.0, float(raw_confidence)))

    group = group.strip()[:MAX_GROUP_CHARS]
    if is_placeholder_group(group):
        # The model named nothing worth naming; keep the field empty so the
        # folder prior (or the user) supplies a label instead.
        group = ""

    return {
        "group": group,
        "category": category.strip()[:MAX_CATEGORY_CHARS],
        "description": description.strip()[:MAX_DESCRIPTION_CHARS],
        "tags": [tag for tag in tags if tag][:MAX_TAGS],
        "confidence": confidence,
    }


def _categorise_prompt(folder_hint: str = "") -> str:
    """Base categorisation prompt, optionally seeded with a folder-name prior.

    Kept byte-identical to ``CATEGORISE_PROMPT`` when no hint is given so
    existing imports see no prompt change.
    """
    hint = (folder_hint or "").strip()
    if not hint:
        return CATEGORISE_PROMPT
    return (
        CATEGORISE_PROMPT + f'\nThe image comes from a folder named "{hint[:MAX_GROUP_CHARS]}". '
        'If that name plausibly matches the visible subject, use it as "group"; '
        "ignore it when it contradicts what you actually see."
    )


def categorise_image(
    data: bytes, media_type: str, model: Any, folder_hint: str = ""
) -> dict[str, Any]:
    """One bounded vision call returning a validated categorisation payload.

    Uses the same base64 image channel as ``describe_image`` but a dedicated
    structured prompt. The caller owns provider resolution and concurrency.
    ``folder_hint`` is the source folder name, passed as a weak grouping prior;
    an empty hint leaves the prompt untouched.
    """
    if model is None:
        raise ValueError("categorise_image requires a model")
    encoded = base64.b64encode(data).decode("ascii")
    message = HumanMessage(
        content=[
            {"type": "text", "text": _categorise_prompt(folder_hint)},
            {
                "type": "image_url",
                "image_url": {"url": f"data:{media_type};base64,{encoded}"},
            },
        ]
    )
    text = llm_text_content(model.invoke([message]))
    if not text.strip():
        raise ValueError("vision model returned an empty response")
    return parse_categorisation_payload(text)


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
