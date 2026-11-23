"""Optional low-cost OpenAI-compatible video planner with strict render validation."""

from __future__ import annotations

import asyncio
import json
import os
import urllib.request
from typing import Any

from octop.infra.product_library.service import render_script
from octop.infra.product_library.video_planner import VideoPlanRequest, build_video_plan

SCENE_TYPES = {"title", "bullets", "image", "video", "text", "endcard"}
MAX_SCENES = 24


def validate_script(
    script: Any, snapshot: dict[str, Any], request: VideoPlanRequest
) -> dict[str, Any]:
    """Reject foreign assets, arbitrary keys, pathological durations and invalid shapes."""
    if not isinstance(script, dict) or not isinstance(script.get("scenes"), list):
        raise ValueError("invalid script")
    scenes = script["scenes"]
    if not 1 <= len(scenes) <= MAX_SCENES:
        raise ValueError("scene count must be 1..24")
    _, assets = render_script(snapshot)
    allowed = {a["export_name"]: a for a in assets}
    cleaned = []
    ids = set()
    total = 0.0
    for item in scenes:
        if not isinstance(item, dict):
            raise ValueError("invalid scene")
        kind = item.get("type")
        scene_id = item.get("id")
        duration = item.get("duration")
        if (
            kind not in SCENE_TYPES
            or not isinstance(scene_id, str)
            or not 1 <= len(scene_id) <= 64
            or scene_id in ids
        ):
            raise ValueError("invalid type or id")
        if (
            isinstance(duration, bool)
            or not isinstance(duration, (int, float))
            or not 0.25 <= duration <= 15
        ):
            raise ValueError("invalid scene duration")
        total += duration
        ids.add(scene_id)
        scene = {"id": scene_id, "type": kind, "duration": duration}
        for key in ("text", "subtitle", "caption"):
            if key in item:
                if not isinstance(item[key], str) or len(item[key]) > 400:
                    raise ValueError("invalid scene text")
                scene[key] = item[key]
        if kind == "bullets":
            bullets = item.get("bullets")
            if (
                not isinstance(bullets, list)
                or not 1 <= len(bullets) <= 8
                or any(not isinstance(v, str) or len(v) > 150 for v in bullets)
            ):
                raise ValueError("invalid bullets")
            scene["bullets"] = bullets
        if kind in ("image", "video"):
            asset = item.get("asset")
            if (
                not isinstance(asset, str)
                or asset not in allowed
                or not allowed[asset]["media_type"].startswith(kind + "/")
            ):
                raise ValueError("media asset outside snapshot or type mismatch")
            scene["asset"] = asset
        cleaned.append(scene)
    if total > 180:
        raise ValueError("video duration exceeds 180 seconds")
    width, height = {"portrait": (1080, 1920), "landscape": (1920, 1080), "square": (1080, 1080)}[
        request.format
    ]
    product = snapshot["product"]
    return {
        "title": str(product["name"])[:200],
        "fps": 30,
        "width": width,
        "height": height,
        "scenes": cleaned,
    }


def _call_model(snapshot: dict[str, Any], request: VideoPlanRequest) -> Any:
    api_key = os.getenv("OCTOP_VIDEO_LLM_API_KEY", "")
    endpoint = os.getenv("OCTOP_VIDEO_LLM_BASE_URL", "").rstrip("/")
    model = os.getenv("OCTOP_VIDEO_LLM_MODEL", "")
    if not api_key or not endpoint or not model or not endpoint.startswith("https://"):
        raise ValueError("configure OCTOP_VIDEO_LLM_API_KEY, HTTPS BASE_URL and MODEL")
    template = build_video_plan(snapshot, request)
    metadata_by_id = {asset["id"]: asset for asset in snapshot["assets"]}
    payload = {
        "model": model,
        "temperature": 0.3,
        "messages": [
            {
                "role": "system",
                "content": "You are a short commercial video storyboard planner. Output only one valid JSON object matching the sample script. Use ONLY the sample's exact media asset filenames. Never invent product claims. Obey expression limits. Keep 1-24 scenes, each 0.25-15 seconds.",
            },
            {
                "role": "user",
                "content": json.dumps(
                    {
                        "brief": request.model_dump(),
                        "product": snapshot["product"],
                        "allowed_assets": [
                            {
                                "export_name": asset["export_name"],
                                "media_type": asset["media_type"],
                                **{
                                    key: metadata_by_id[asset["id"]][key]
                                    for key in ("category", "description", "tags")
                                    if key in metadata_by_id[asset["id"]]
                                },
                            }
                            for asset in template["assets"]
                        ],
                        "example_script": template["script"],
                    },
                    ensure_ascii=False,
                    default=str,
                ),
            },
        ],
    }
    req = urllib.request.Request(
        endpoint + "/chat/completions",
        data=json.dumps(payload, ensure_ascii=False).encode(),
        headers={"Authorization": "Bearer " + api_key, "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=35) as response:
        if response.status != 200:
            raise ValueError("model service returned non-200 status")
        data = response.read(512 * 1024)
    answer = json.loads(data)["choices"][0]["message"]["content"].strip()
    if answer.startswith("```"):
        answer = answer.split("\n", 1)[1].rsplit("```", 1)[0].strip()
    return json.loads(answer)


async def generate_model_plan(
    snapshot: dict[str, Any], request: VideoPlanRequest
) -> dict[str, Any]:
    """One bounded call; errors propagate, never silently pretend template is AI."""
    raw = await asyncio.to_thread(_call_model, snapshot, request)
    script = validate_script(raw, snapshot, request)
    result = build_video_plan(snapshot, request)
    result["script"] = script
    result["generator"] = "llm"
    return result
