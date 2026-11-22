"""Stateless recognition must return vision results without any side effects."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from octop.infra.product_library import recognition
from octop.infra.product_library.recognition import recognise_uploads


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
