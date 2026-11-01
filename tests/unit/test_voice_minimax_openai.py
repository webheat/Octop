"""MiniMax adapter over the OpenAI-compatible gateway protocol."""

from __future__ import annotations

import pytest

from octop.infra.db.repos.voice_providers import VoiceProviderRow
from octop.infra.errors import ErrorCode, OctopError
from octop.infra.voice import adapters


@pytest.fixture(autouse=True)
def _allow_example_host(monkeypatch) -> None:
    """The fake gateway host must not be resolved for real."""

    async def _allow(_url: str) -> None:
        return None

    monkeypatch.setattr(adapters, "_guard_minimax_base_url", _allow)


def _row(**overrides) -> VoiceProviderRow:
    base = {
        "id": 9,
        "name": "minimax",
        "kind": "minimax",
        "capability": "tts",
        "base_url": "https://gateway.example/v1",
        "api_key": "sk-gateway",
        "extra_json": '{"protocol": "openai", "model": "speech-2.5-hd-preview"}',
        "note": None,
        "enabled": 1,
        "created_at": 0,
        "updated_at": 0,
    }
    base.update(overrides)
    return VoiceProviderRow(**base)


class _Response:
    def __init__(self, content: bytes, status: int = 200) -> None:
        self.content = content
        self.status_code = status

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise RuntimeError(f"http {self.status_code}")


def _mp3_bytes() -> bytes:
    """A single MPEG-1 Layer III frame at 32 kHz — 36 ms of audio."""
    header = (
        0xFFE00000
        | (3 << 19)  # MPEG 1
        | (1 << 17)  # Layer III
        | (9 << 12)  # 128 kbit/s
        | (2 << 10)  # 32 kHz
    )
    length = (144 * 128000) // 32000
    return header.to_bytes(4, "big") + b"\x00" * (length - 4)


@pytest.mark.asyncio
async def test_openai_protocol_posts_to_audio_speech(monkeypatch) -> None:
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
            return _Response(_mp3_bytes())

    monkeypatch.setattr(adapters.httpx, "AsyncClient", _Client)
    measured: list[float] = []
    chunks = [
        chunk
        async for chunk in adapters.synthesize_minimax(
            _row(), "你好", voice_id="female-yujie", speed=1.0, on_length=measured.append
        )
    ]
    assert b"".join(chunks) == _mp3_bytes()
    assert seen["url"] == "https://gateway.example/v1/audio/speech"
    assert seen["headers"]["Authorization"] == "Bearer sk-gateway"
    body = seen["body"]
    assert body["model"] == "speech-2.5-hd-preview"
    assert body["input"] == "你好"
    assert body["voice"] == "female-yujie"
    # The gateway maps this onto MiniMax's own output format.
    assert body["output_format"] == "hex"
    # ``response_format`` must not be sent: the gateway forwards it as the
    # output format, and MiniMax only accepts "hex" and "url".
    assert "response_format" not in body
    # The length is recovered from the file because the gateway reports none.
    assert measured and measured[0] == pytest.approx(36.0)


@pytest.mark.asyncio
async def test_openai_protocol_sends_speed_only_when_changed(monkeypatch) -> None:
    seen: dict = {}

    class _Client:
        def __init__(self, *args, **kwargs) -> None:
            pass

        async def __aenter__(self) -> _Client:
            return self

        async def __aexit__(self, *args) -> None:
            return None

        async def post(self, url: str, headers: dict, json: dict) -> _Response:
            seen["body"] = json
            return _Response(_mp3_bytes())

    monkeypatch.setattr(adapters.httpx, "AsyncClient", _Client)
    _ = [
        chunk
        async for chunk in adapters.synthesize_minimax(_row(), "你好", voice_id=None, speed=1.0)
    ]
    assert "speed" not in seen["body"]

    _ = [
        chunk
        async for chunk in adapters.synthesize_minimax(_row(), "你好", voice_id=None, speed=1.2)
    ]
    assert seen["body"]["speed"] == pytest.approx(1.2)


@pytest.mark.asyncio
async def test_openai_protocol_rejects_an_empty_body(monkeypatch) -> None:
    class _Client:
        def __init__(self, *args, **kwargs) -> None:
            pass

        async def __aenter__(self) -> _Client:
            return self

        async def __aexit__(self, *args) -> None:
            return None

        async def post(self, url: str, headers: dict, json: dict) -> _Response:
            return _Response(b"")

    monkeypatch.setattr(adapters.httpx, "AsyncClient", _Client)
    with pytest.raises(OctopError) as excinfo:
        _ = [
            chunk
            async for chunk in adapters.synthesize_minimax(_row(), "你好", voice_id=None, speed=1.0)
        ]
    assert excinfo.value.code == ErrorCode.VOICE_PROVIDER_ERROR


def test_native_protocol_is_the_default() -> None:
    row = _row(extra_json=None)
    assert adapters._minimax_protocol(row) == adapters.MINIMAX_PROTOCOL_NATIVE
    assert adapters._minimax_model(row) == "speech-02-hd"


def test_unknown_model_falls_back_to_the_default() -> None:
    row = _row(extra_json='{"model": "speech-99"}')
    assert adapters._minimax_model(row) == "speech-02-hd"


def test_every_preset_voice_is_a_real_minimax_id() -> None:
    """The ids must match MiniMax's own catalogue, or the pick is ignored."""
    assert set(adapters.MINIMAX_VOICE_PRESETS) <= {
        "female-shaonv",
        "female-yujie",
        "female-chengshu",
        "female-tianmei",
        "male-qn-qingse",
        "male-qn-jingying",
        "male-qn-badao",
        "male-qn-daxuesheng",
        "presenter_female",
        "presenter_male",
    }


def test_endpoint_joins_do_not_duplicate_the_v1_prefix() -> None:
    """Gateways advertise their base URL with ``/v1`` already attached."""
    assert (
        adapters._minimax_endpoint("https://host:8443/v1", "/v1/audio/speech")
        == "https://host:8443/v1/audio/speech"
    )
    assert (
        adapters._minimax_endpoint("https://host:8443/v1/", "/v1/audio/speech")
        == "https://host:8443/v1/audio/speech"
    )
    assert (
        adapters._minimax_endpoint("https://api.minimaxi.com", "/v1/t2a_v2")
        == "https://api.minimaxi.com/v1/t2a_v2"
    )
    assert (
        adapters._minimax_endpoint("https://api.minimaxi.com/", "/v1/t2a_v2")
        == "https://api.minimaxi.com/v1/t2a_v2"
    )
