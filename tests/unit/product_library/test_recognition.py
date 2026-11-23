"""Stateless recognition must return vision results without any side effects."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from octop.infra.product_library import recognition
from octop.infra.product_library.recognition import group_local_plan, recognise_uploads


def _model(payload: str) -> Any:
    """A stand-in chat model returning a fixed structured answer."""
    from langchain_core.messages import AIMessage

    class FakeModel:
        def invoke(self, _messages: Any) -> AIMessage:
            return AIMessage(content=payload)

    return FakeModel()


@pytest.mark.asyncio
async def test_recognise_categorizes_without_writing_files(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    answer = (
        '{"description": "a blue bag", "tags": ["bag"], "group": "Trolley", '
        '"category": "bag", "confidence": 0.9}'
    )
    monkeypatch.setattr(
        recognition,
        "resolve_vision_model",
        lambda _repo: (_model(answer), "mock/vision"),
    )

    result = await recognise_uploads(
        [("Trolley/front.jpg", "image/jpeg", b"fake-jpeg")],
        provider_repo=SimpleNamespace(),
        mode="categorize",
    )

    item = result["items"][0]
    assert result["model"] == "mock/vision"
    assert item["group"] == "Trolley"
    assert item["category"] == "bag"
    assert item["description"] == "a blue bag"
    assert item["tags"] == ["bag"]
    assert item["group_source"] == "vision"
    # No job dir / data dir was created under the temp root.
    assert list(tmp_path.iterdir()) == []


@pytest.mark.asyncio
async def test_recognise_dedupes_by_sha256_and_returns_one_call_per_distinct_image(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = {"n": 0}

    def counted_model(_payload: str) -> Any:
        from langchain_core.messages import AIMessage

        class FakeModel:
            def invoke(self, _messages: Any) -> AIMessage:
                calls["n"] += 1
                return AIMessage(
                    content='{"description": "x", "tags": [], "group": "G", '
                    '"category": "c", "confidence": 0.8}'
                )

        return FakeModel()

    monkeypatch.setattr(
        recognition,
        "resolve_vision_model",
        lambda _repo: (counted_model(""), "mock/vision"),
    )

    image = b"same-bytes"
    result = await recognise_uploads(
        [
            ("a/one.jpg", "image/jpeg", image),
            ("a/two.jpg", "image/jpeg", image),
        ],
        provider_repo=SimpleNamespace(),
        mode="categorize",
    )

    assert calls["n"] == 1
    assert result["items"][0]["group"] == "G"
    assert result["items"][1].get("duplicate") is True
    assert result["items"][1]["description"] == result["items"][0]["description"]


@pytest.mark.asyncio
async def test_recognise_reports_unsupported_type_without_model(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def fail_resolve(_repo: Any) -> None:
        raise AssertionError("model must not be resolved for invalid input")

    monkeypatch.setattr(recognition, "resolve_vision_model", fail_resolve)

    result = await recognise_uploads(
        [("notes.txt", "text/plain", b"not an image")],
        provider_repo=SimpleNamespace(),
    )
    assert "error" in result["items"][0]
    assert "unsupported" in result["items"][0]["error"]


def test_plan_local_video_is_stateless_and_maps_assets() -> None:
    from octop.infra.product_library.video_planner import VideoPlanRequest

    snapshot = {
        "product": {
            "name": "旅行箱",
            "model": "Trolley Pro",
            "selling_points": ["轻量", "万向轮"],
        },
        "assets": [
            {
                "id": "Labc123",
                "filename": "front.jpg",
                "media_type": "image/jpeg",
                "usage": "scene",
                "priority": 0,
            }
        ],
    }
    result = recognition.plan_local_video(
        snapshot, VideoPlanRequest(format="landscape", seconds_per_asset=3)
    )
    script = result["script"]
    assert script["title"] == "旅行箱"
    assert script["width"] == 1920
    image_scenes = [s for s in script["scenes"] if s["type"] == "image"]
    assert len(image_scenes) == 1
    assert image_scenes[0]["duration"] == 3
    # export_name uses the local asset id so the client can map it back.
    assert result["assets"][0]["export_name"].startswith("Labc123-")
    assert result["generator"] == "template-v1"


def test_group_local_plan_groups_by_normalised_key() -> None:
    items = [
        {
            "id": "L1",
            "filename": "a.jpg",
            "group": "登 山 包",
            "category": "箱包",
            "description": "front view",
            "tags": ["bag"],
        },
        {
            "id": "L2",
            "filename": "b.jpg",
            "group": "登山包",
            "category": "箱包",
            "description": "side view",
            "tags": [],
        },
        {
            "id": "L3",
            "filename": "c.jpg",
            "group": "",
            "category": "",
            "description": "no classification",
        },
    ]
    plan = group_local_plan(items)
    assert plan["total"] == 3
    assert plan["skipped"] == 1
    assert len(plan["groups"]) == 1
    group = plan["groups"][0]
    assert group["suggested_name"] == "登 山 包"
    assert group["category"] == "箱包"
    assert {i["id"] for i in group["items"]} == {"L1", "L2"}


def test_group_local_plan_uses_category_when_group_placeholder() -> None:
    items = [
        {"id": "L1", "group": "unknown", "category": "鞋履", "description": ""},
        {"id": "L2", "group": "unknown", "category": "鞋履", "description": ""},
    ]
    plan = group_local_plan(items)
    assert plan["skipped"] == 0
    assert len(plan["groups"]) == 1
    assert plan["groups"][0]["suggested_name"] == "鞋履"
    assert len(plan["groups"][0]["items"]) == 2


@pytest.mark.asyncio
async def test_local_ai_plan_uses_recognized_metadata_and_validates_assets(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import json

    from fastapi import HTTPException

    from octop.api.routers.product_library import LocalPlanBody, plan_local
    from octop.infra.product_library import llm_video_planner

    body = LocalPlanBody.model_validate(
        {
            "generator": "llm",
            "product": {"name": "chair"},
            "assets": [
                {
                    "id": "L1",
                    "filename": "chair.png",
                    "description": "wooden chair",
                    "category": "furniture",
                    "tags": ["wood"],
                }
            ],
            "request": {},
        }
    )
    captured: dict[str, Any] = {}

    class Response:
        status = 200

        def __enter__(self) -> Response:
            return self

        def __exit__(self, *args: Any) -> None:
            pass

        def read(self, _limit: int) -> bytes:
            return json.dumps(
                {
                    "choices": [
                        {
                            "message": {
                                "content": json.dumps(
                                    {
                                        "scenes": [
                                            {
                                                "id": "one",
                                                "type": "image",
                                                "duration": 4,
                                                "asset": "L1-chair.png",
                                            }
                                        ]
                                    }
                                )
                            }
                        }
                    ]
                }
            ).encode()

    def fake_open(req: Any, timeout: int) -> Response:
        captured.update(json.loads(req.data))
        return Response()

    monkeypatch.setenv("OCTOP_VIDEO_LLM_API_KEY", "test")
    monkeypatch.setenv("OCTOP_VIDEO_LLM_BASE_URL", "https://example.invalid")
    monkeypatch.setenv("OCTOP_VIDEO_LLM_MODEL", "cheap-test-model")
    monkeypatch.setattr(llm_video_planner.urllib.request, "urlopen", fake_open)
    result = await plan_local(body, user=None)
    assert result["generator"] == "llm"
    sent = json.loads(captured["messages"][1]["content"])["allowed_assets"][0]
    assert sent == {
        "export_name": "L1-chair.png",
        "media_type": "image/jpeg",
        "description": "wooden chair",
        "category": "furniture",
        "tags": ["wood"],
    }

    def invalid(*args: Any, **kwargs: Any) -> dict[str, Any]:
        return {"scenes": [{"id": "one", "type": "image", "duration": 4, "asset": "foreign.png"}]}

    monkeypatch.setattr(llm_video_planner, "_call_model", invalid)
    with pytest.raises(HTTPException) as exc:
        await plan_local(body, user=None)
    assert exc.value.status_code == 502
