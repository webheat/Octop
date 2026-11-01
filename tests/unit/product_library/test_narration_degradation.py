"""The narration plan must survive a voice provider that is out of quota."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from octop.infra.errors import ErrorCode, OctopError
from octop.infra.product_library import narration
from octop.infra.product_library.audio import build_package_audio

SCRIPT: dict = {
    "title": "Camera",
    "fps": 30,
    "width": 1080,
    "height": 1920,
    "scenes": [
        {"id": "s1", "type": "title", "duration": 3, "text": "Camera", "narration": "轻量通勤女包"},
        {
            "id": "s2",
            "type": "endcard",
            "duration": 2,
            "text": "Camera",
            "narration": "防泼水大容量",
        },
    ],
}


class _Provider:
    row = object()


class _Manager:
    """A manager whose provider always fails the way an exhausted quota does."""

    def __init__(self) -> None:
        self.calls = 0

    def resolve(self, name: str) -> _Provider:
        self.calls += 1
        return _Provider()


@pytest.mark.asyncio
async def test_a_failing_provider_degrades_to_the_local_voice(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """No quota must not take the whole package down."""

    async def _fail(*_args, **_kwargs):
        raise OctopError(ErrorCode.VOICE_PROVIDER_ERROR, "quota exhausted")

    monkeypatch.setattr(narration, "_synthesize_line", _fail)
    clips, durations, degraded = await narration.render_narration_clips(
        manager=_Manager(), script=SCRIPT, voice_id="female-shaonv"
    )
    assert clips == {}
    assert durations == {}
    assert degraded is True


@pytest.mark.asyncio
async def test_a_working_provider_is_not_marked_degraded(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def _ok(*_args, **_kwargs):
        return b"audio-bytes", 1.5

    monkeypatch.setattr(narration, "_synthesize_line", _ok)
    clips, durations, degraded = await narration.render_narration_clips(
        manager=_Manager(), script=SCRIPT, voice_id="female-shaonv"
    )
    assert set(clips) == {"s1", "s2"}
    assert durations == {"s1": 1.5, "s2": 1.5}
    assert degraded is False


def test_the_degraded_marker_reaches_the_audio_plan(tmp_path: Path) -> None:
    """The package says so, so the client knows the voice is its own."""
    package = build_package_audio(
        tmp_path,
        SCRIPT,
        narration_enabled=True,
        premium=False,
        degraded=True,
    )
    assert package is not None
    narration_block = package.plan["narration"]
    assert narration_block["mode"] == "local"
    assert narration_block["degraded"] is True


def test_a_normal_plan_carries_no_degraded_marker(tmp_path: Path) -> None:
    package = build_package_audio(
        tmp_path,
        SCRIPT,
        narration_enabled=True,
        premium=False,
    )
    assert package is not None
    assert "degraded" not in package.plan["narration"]


def test_the_degraded_plan_is_still_valid_json(tmp_path: Path) -> None:
    package = build_package_audio(
        tmp_path,
        SCRIPT,
        narration_enabled=True,
        premium=False,
        degraded=True,
    )
    assert package is not None
    text = json.dumps(package.plan, ensure_ascii=False)
    assert json.loads(text)["narration"]["degraded"] is True
