"""Stateless vision recognition for remote clients (local-first libraries).

This module is the server-side counterpart of the local-first product library:
it accepts image bytes, spends one bounded vision call per distinct image and
returns the categorisation payload. It deliberately performs **no** disk writes
and **no** database writes — the caller (a remote desktop client) owns the
material bytes and persists the classification in its own local database.

The existing directory-import flow (``batch_import``) still writes a job
directory and product/asset rows for the hosted Web UI; this module is a
separate, side-effect-free entry point for clients that keep their own library.
"""

from __future__ import annotations

import asyncio
import hashlib
import re
import unicodedata
from typing import Any

from octop.infra.product_library.video_planner import VideoPlanRequest, build_video_plan
from octop.infra.product_library.vision import (
    MAX_ERROR_CHARS,
    MAX_IMAGE_BYTES,
    SUPPORTED_IMAGE_TYPES,
    categorise_image,
    describe_image,
    is_placeholder_group,
    resolve_vision_model,
)

DEFAULT_RECOGNITION_CONCURRENCY = 4


def plan_local_video(snapshot: dict[str, Any], request: VideoPlanRequest) -> dict[str, Any]:
    """Deterministic, stateless Remotion plan from client-supplied metadata.

    Uses the template planner only (no LLM, no disk, no database) so a
    local-first client can render from its own material library without ever
    asking the server to hold the bytes.
    """
    return build_video_plan(snapshot, request)


def _folder_of(rel_path: str) -> str:
    parts = [part for part in (rel_path or "").replace("\\", "/").split("/") if part]
    return parts[0] if len(parts) > 1 else ""


def _apply_folder_prior(result: dict[str, Any], folder: str) -> dict[str, Any]:
    hint = (folder or "").strip()
    current = str(result.get("group") or "").strip()
    if is_placeholder_group(current):
        current = ""
        result["group"] = ""
    if not hint:
        result["group_source"] = "vision"
        return result
    confidence = float(result.get("confidence") or 0.0)
    if not current or confidence < 0.5:
        result["group"] = hint[:80]
        result["confidence"] = max(confidence, 0.5)
        result["group_source"] = "folder"
    else:
        result["group_source"] = "vision"
    return result


async def recognise_uploads(
    files: list[tuple[str, str, bytes]],
    provider_repo: Any,
    *,
    mode: str = "categorize",
    concurrency: int = DEFAULT_RECOGNITION_CONCURRENCY,
) -> dict[str, Any]:
    """Recognise a batch of in-memory images without persisting anything.

    ``files`` is a list of ``(relative_path, media_type, bytes)`` tuples. One
    vision call is spent per distinct SHA-256; duplicates are back-filled from
    the representative result. A bad image never fails the whole batch — its
    ``error`` field is set instead.
    """
    if mode not in {"categorize", "describe"}:
        raise ValueError("mode must be 'categorize' or 'describe'")

    model_pair: tuple[Any, str] | None = None
    setup_error = ""
    try:
        model_pair = await asyncio.to_thread(resolve_vision_model, provider_repo)
    except Exception as exc:  # noqa: BLE001 - surface as a per-batch error
        setup_error = str(exc)[:MAX_ERROR_CHARS]

    model_ref = model_pair[1] if model_pair else ""
    model = model_pair[0] if model_pair else None
    semaphore = asyncio.Semaphore(max(1, concurrency))

    items: list[dict[str, Any]] = [
        {
            "path": path,
            "media_type": media_type,
            "sha256": hashlib.sha256(data).hexdigest(),
            "bytes": len(data),
        }
        for path, media_type, data in files
    ]

    # Validate before spending any model call.
    for item, (_path, media_type, data) in zip(items, files, strict=True):
        if media_type not in SUPPORTED_IMAGE_TYPES:
            item["error"] = f"unsupported image type: {media_type}"
        elif not data:
            item["error"] = "asset file is empty"
        elif len(data) > MAX_IMAGE_BYTES:
            item["error"] = "image exceeds the vision size limit"

    pending = [item for item in items if "error" not in item]
    representatives: dict[str, dict[str, Any]] = {}
    followers: dict[str, list[dict[str, Any]]] = {}
    for item in pending:
        digest = item["sha256"]
        if digest in representatives:
            followers.setdefault(digest, []).append(item)
        else:
            representatives[digest] = item

    async def recognise(item: dict[str, Any], data: bytes) -> None:
        if setup_error or model is None:
            item["error"] = setup_error or "no vision model configured"
            return
        async with semaphore:
            try:
                if mode == "categorize":
                    result = await asyncio.to_thread(
                        categorise_image,
                        data,
                        item["media_type"],
                        model,
                        _folder_of(item["path"]),
                    )
                    result = _apply_folder_prior(result, _folder_of(item["path"]))
                else:
                    description, tags = await asyncio.to_thread(
                        describe_image, data, item["media_type"], model
                    )
                    result = {
                        "group": "",
                        "category": "",
                        "description": description,
                        "tags": tags,
                        "confidence": 0.0,
                    }
            except Exception as exc:  # noqa: BLE001 - one bad image must not fail the batch
                item["error"] = str(exc)[:MAX_ERROR_CHARS]
                return
        item.update(result)
        item["reused"] = False

    # Map digest back to raw bytes for the representative call.
    data_by_digest = {hashlib.sha256(data).hexdigest(): data for _path, _mt, data in files if data}
    await asyncio.gather(
        *(recognise(item, data_by_digest[item["sha256"]]) for item in representatives.values())
    )

    for digest, dup_items in followers.items():
        rep = representatives[digest]
        for item in dup_items:
            if "error" not in rep:
                item.update({k: v for k, v in rep.items() if k not in {"path", "sha256", "bytes"}})
                item["duplicate"] = True
            elif "error" in rep:
                item["error"] = rep["error"]

    return {"items": items, "model": model_ref, "mode": mode}


def _norm(text: str) -> str:
    """NFKC + lowercase + drop all whitespace — mirrors batch_import.group_key."""
    return re.sub(r"\s+", "", unicodedata.normalize("NFKC", text).lower())


def _local_group_key(group: str, category: str) -> str:
    return f"{_norm(category)}::{_norm(group)}"


def group_local_plan(items: list[dict[str, Any]]) -> dict[str, Any]:
    """Group client-held, already-recognised assets into a review plan.

    Pure function: no model call, no disk/database write, no asset bytes. The
    client sends the asset metadata it already holds (id/group/category/
    description/tags) and gets back the same ``groups`` shape the hosted
    directory-import wizard reviews, so the local-first UI can reuse it
    verbatim before archiving into its own product store.
    """
    grouped: dict[str, dict[str, Any]] = {}
    skipped = 0
    for item in items:
        group = str(item.get("group") or "")
        category = str(item.get("category") or "")
        if is_placeholder_group(group):
            group = ""
        if not group and not category:
            skipped += 1
            continue
        key = _local_group_key(group, category)
        bucket = grouped.setdefault(
            key,
            {
                "key": key,
                "suggested_name": group or category or "",
                "category": category[:100],
                "items": [],
            },
        )
        bucket["items"].append(
            {
                "id": str(item.get("id") or ""),
                "filename": str(item.get("filename") or ""),
                "group": group,
                "category": category,
                "description": str(item.get("description") or ""),
                "tags": item.get("tags") or [],
                "confidence": float(item.get("confidence") or 0.0),
                "group_source": str(item.get("group_source") or "vision"),
            }
        )
    groups = sorted(grouped.values(), key=lambda g: (-len(g["items"]), g["key"]))
    return {"groups": groups, "skipped": skipped, "total": len(items)}
