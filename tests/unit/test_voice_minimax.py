"""MiniMax text-to-audio adapter."""

from __future__ import annotations

import pytest

from octop.infra.db.repos.voice_providers import VoiceProviderRow
from octop.infra.errors import ErrorCode, OctopError
from octop.infra.voice import adapters


def _row(**overrides) -> VoiceProviderRow:
    base = {
        "id": 7,
        "name": "minimax",
        "kind": "minimax",
        "capability": "tts",
        "base_url": "https://api.minimaxi.com",
        "api_key": "sk-test",
        "extra_json": None,
        "note": None,
        "enabled": 1,
        "created_at": 0,
        "updated_at": 0,
    }
    base.update(overrides)
    return VoiceProviderRow(**base)


class _Response:
    def __init__(self, payload: dict, status: int = 200) -> None:
        self._payload = payload
        self.status_code = status

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise RuntimeError(f"http {self.status_code}")

    def json(self) -> dict:
        return self._payload


def _payload(audio: bytes = b"ID3audio", length_ms: int = 1500) -> dict:
    return {
        "base_resp": {"status_code": 0, "status_msg": "success"},
        "data": {"audio": audio.hex()},
        # ``extra_info`` sits at the top level, not inside ``data``.
        "extra_info": {"audio_length": length_ms, "usage_characters": 12},
        "trace_id": "trace-1",
    }


@pytest.mark.asyncio
async def test_minimax_decodes_hex_audio_and_reports_length(monkeypatch) -> None:
    payload = _payload()
    seen: dict = {}

    class _Client:
        def __init__(self, *args, **kwargs) -> None:
            pass

        async def __aenter__(self) -> _Client:
            return self

        async def __aexit__(self, *args) -> None:
            return None

        async def post(self, url: str, headers: dict, json: dict) -> _Response:
            seen["url"] = url
            seen["headers"] = headers
            seen["body"] = json
            return _Response(payload)

    monkeypatch.setattr(adapters.httpx, "AsyncClient", _Client)
    measured: list[float] = []
    chunks = [
        chunk
        async for chunk in adapters.synthesize_minimax(
            _row(), "hello", voice_id=None, speed=1.0, on_length=measured.append
        )
    ]
    assert b"".join(chunks) == b"ID3audio"
    assert seen["url"].endswith("/v1/t2a_v2")
    assert seen["headers"]["Authorization"] == "Bearer sk-test"
    assert seen["body"]["voice_setting"]["voice_id"] == adapters.MINIMAX_DEFAULT_VOICE
    assert measured == [1500.0]


@pytest.mark.asyncio
async def test_minimax_known_voice_is_kept(monkeypatch) -> None:
    captured: dict = {}

    class _Client:
        def __init__(self, *args, **kwargs) -> None:
            pass

        async def __aenter__(self) -> _Client:
            return self

        async def __aexit__(self, *args) -> None:
            return None

        async def post(self, url: str, headers: dict, json: dict) -> _Response:
            captured.update(json)
            return _Response(_payload())

    monkeypatch.setattr(adapters.httpx, "AsyncClient", _Client)
    _ = [
        chunk
        async for chunk in adapters.synthesize_minimax(
            _row(), "hello", voice_id="male-qn-daxuesheng", speed=1.0
        )
    ]
    assert captured["voice_setting"]["voice_id"] == "male-qn-daxuesheng"


@pytest.mark.asyncio
async def test_minimax_unknown_voice_falls_back_to_the_default(monkeypatch) -> None:
    captured: dict = {}

    class _Client:
        def __init__(self, *args, **kwargs) -> None:
            pass

        async def __aenter__(self) -> _Client:
            return self

        async def __aexit__(self, *args) -> None:
            return None

        async def post(self, url: str, headers: dict, json: dict) -> _Response:
            captured.update(json)
            return _Response(_payload())

    monkeypatch.setattr(adapters.httpx, "AsyncClient", _Client)
    _ = [
        chunk
        async for chunk in adapters.synthesize_minimax(
            _row(), "hello", voice_id="not-a-voice", speed=1.0
        )
    ]
    assert captured["voice_setting"]["voice_id"] == adapters.MINIMAX_DEFAULT_VOICE


@pytest.mark.asyncio
async def test_minimax_reports_an_upstream_failure(monkeypatch) -> None:
    class _Client:
        def __init__(self, *args, **kwargs) -> None:
            pass

        async def __aenter__(self) -> _Client:
            return self

        async def __aexit__(self, *args) -> None:
            return None

        async def post(self, url: str, headers: dict, json: dict) -> _Response:
            return _Response({"base_resp": {"status_code": 1004, "status_msg": "quota exceeded"}})

    monkeypatch.setattr(adapters.httpx, "AsyncClient", _Client)
    with pytest.raises(OctopError) as excinfo:
        _ = [
            chunk
            async for chunk in adapters.synthesize_minimax(
                _row(), "hello", voice_id=None, speed=1.0
            )
        ]
    assert excinfo.value.code == ErrorCode.VOICE_PROVIDER_ERROR
    assert "quota exceeded" in excinfo.value.message


@pytest.mark.asyncio
async def test_minimax_requires_an_api_key() -> None:
    with pytest.raises(ValueError):
        _ = [
            chunk
            async for chunk in adapters.synthesize_minimax(
                _row(api_key=""), "hello", voice_id=None, speed=1.0
            )
        ]


@pytest.mark.asyncio
async def test_minimax_probe_reports_missing_credentials() -> None:
    result = await adapters.test_tts(_row(api_key=""), "minimax", locale="zh")
    assert result["ok"] is False
    assert result["error"]


def test_minimax_presets_are_unique() -> None:
    assert len(set(adapters.MINIMAX_VOICE_PRESETS)) == len(adapters.MINIMAX_VOICE_PRESETS)
    assert adapters.MINIMAX_DEFAULT_VOICE in adapters.MINIMAX_VOICE_PRESETS
