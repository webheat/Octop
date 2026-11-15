"""LLM image descriptions for the product library: sqlite state and boundaries."""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from octop.infra.db.migrate import run_migrations
from octop.infra.db.pool import SqlitePool
from octop.infra.db.repos.product_library import ProductLibraryRepo
from octop.infra.errors import ErrorCode, OctopError
from octop.infra.product_library import vision
from octop.infra.product_library.service import ProductLibraryService
from octop.infra.utils.paths import PathLayout

_PNG = b"\x89PNG\r\n\x1a\n" + b"fake-image-bytes"
_ANSWER = json.dumps(
    {"description": "蓝色双肩背包正面照，白色背景。", "tags": ["背包", "蓝色", "正面"]},
    ensure_ascii=False,
)


class _FakeModel:
    def __init__(self, answer: str = _ANSWER) -> None:
        self.answer = answer
        self.calls = 0

    def invoke(self, messages: list[Any]) -> str:
        del messages
        self.calls += 1
        return self.answer


@pytest.fixture
def library(tmp_path: Path) -> SimpleNamespace:
    db = SqlitePool(tmp_path / "control.db")
    run_migrations(db)
    repo = ProductLibraryRepo(db)
    paths = PathLayout(tmp_path / "data")
    service = ProductLibraryService(paths, repo)
    product = repo.create_product(1, {"name": "Backpack"})
    server = SimpleNamespace(
        services=SimpleNamespace(
            paths=paths,
            product_library_repo=repo,
            provider_repo=SimpleNamespace(),
        )
    )
    return SimpleNamespace(
        db=db,
        repo=repo,
        service=service,
        product=product,
        server=server,
        model=_FakeModel(),
    )


def _image(library: SimpleNamespace, *, product_id: str | None = None, data: bytes = _PNG) -> dict:
    return library.service.store_asset(
        owner_id=1,
        product_id=product_id or library.product["id"],
        filename="front.png",
        media_type="image/png",
        data=data,
        usage="scene",
    )


def _mock_model(monkeypatch: pytest.MonkeyPatch, model: _FakeModel) -> None:
    monkeypatch.setattr(vision, "resolve_vision_model", lambda _repo: (model, "provider/vision-1"))


def test_new_assets_have_no_description(library: SimpleNamespace) -> None:
    asset = _image(library)
    row = library.repo.get_asset(1, asset["id"])
    assert row is not None
    assert row["ai_status"] == "none"
    assert row["ai_description"] == ""
    assert row["ai_tags"] == []
    assert row["ai_error"] == ""
    assert [item["ai_status"] for item in library.repo.list_assets(1, library.product["id"])] == [
        "none"
    ]


def test_parse_description_payload_handles_fences_and_rejects_junk() -> None:
    fenced = '```json\n{"description": "desc", "tags": ["a", 2]}\n```'
    assert vision.parse_description_payload(fenced) == ("desc", ["a", "2"])
    with pytest.raises(ValueError):
        vision.parse_description_payload('{"tags": []}')
    with pytest.raises(ValueError):
        vision.parse_description_payload("not json")


@pytest.mark.asyncio
async def test_describe_asset_writes_llm_content_to_sqlite(
    library: SimpleNamespace, monkeypatch: pytest.MonkeyPatch
) -> None:
    from octop.api.routers import product_library

    asset = _image(library)
    _mock_model(monkeypatch, library.model)

    result = await product_library.generate_asset_description(
        asset["id"], user=SimpleNamespace(id=1), server=library.server
    )

    assert result["ai_status"] == "ready"
    assert result["ai_description"] == "蓝色双肩背包正面照，白色背景。"
    assert result["ai_tags"] == ["背包", "蓝色", "正面"]
    assert result["ai_model"] == "provider/vision-1"
    assert result["ai_content_hash"] == asset["content_hash"]
    assert library.model.calls == 1

    stored = library.repo.get_asset(1, asset["id"])
    assert stored is not None
    assert stored["ai_description"] == result["ai_description"]
    assert stored["ai_tags"] == result["ai_tags"]


@pytest.mark.asyncio
async def test_other_user_cannot_describe_an_asset(library: SimpleNamespace) -> None:
    from octop.api.routers import product_library

    asset = _image(library)
    with pytest.raises(OctopError) as denied:
        await product_library.generate_asset_description(
            asset["id"], user=SimpleNamespace(id=2), server=library.server
        )
    assert denied.value.code is ErrorCode.NOT_FOUND
    assert library.repo.get_asset(1, asset["id"])["ai_status"] == "none"


@pytest.mark.asyncio
async def test_missing_vision_model_records_failure(
    library: SimpleNamespace, monkeypatch: pytest.MonkeyPatch
) -> None:
    from octop.api.routers import product_library

    asset = _image(library)

    def _unavailable(_repo: Any) -> tuple[Any, str]:
        raise vision.VisionModelUnavailable("no enabled vision model is configured")

    monkeypatch.setattr(vision, "resolve_vision_model", _unavailable)
    result = await product_library.generate_asset_description(
        asset["id"], user=SimpleNamespace(id=1), server=library.server
    )
    assert result["ai_status"] == "failed"
    assert "no enabled vision model" in result["ai_error"]


@pytest.mark.asyncio
async def test_failed_reanalysis_keeps_the_previous_description(
    library: SimpleNamespace, monkeypatch: pytest.MonkeyPatch
) -> None:
    from octop.api.routers import product_library

    asset = _image(library)
    _mock_model(monkeypatch, library.model)
    await product_library.generate_asset_description(
        asset["id"], user=SimpleNamespace(id=1), server=library.server
    )

    def _bad_call(*_args: Any, **_kwargs: Any) -> tuple[str, list[str]]:
        raise ValueError("model returned malformed JSON")

    monkeypatch.setattr(vision, "describe_image", _bad_call)
    result = await product_library.generate_asset_description(
        asset["id"], user=SimpleNamespace(id=1), server=library.server
    )
    assert result["ai_status"] == "failed"
    assert result["ai_description"] == "蓝色双肩背包正面照，白色背景。"
    assert "malformed JSON" in result["ai_error"]


@pytest.mark.asyncio
async def test_identical_bytes_reuse_cached_description(
    library: SimpleNamespace, monkeypatch: pytest.MonkeyPatch
) -> None:
    from octop.api.routers import product_library

    first = _image(library)
    second_product = library.repo.create_product(1, {"name": "Second"})
    second = _image(library, product_id=second_product["id"])
    _mock_model(monkeypatch, library.model)

    await product_library.generate_asset_description(
        first["id"], user=SimpleNamespace(id=1), server=library.server
    )
    result = await product_library.generate_asset_description(
        second["id"], user=SimpleNamespace(id=1), server=library.server
    )
    assert result["ai_status"] == "ready"
    assert result["ai_description"] == "蓝色双肩背包正面照，白色背景。"
    # The owner boundary still applies: another user's cached text is never reused.
    assert library.model.calls == 1


@pytest.mark.asyncio
async def test_batch_only_processes_images_without_fresh_description(
    library: SimpleNamespace, monkeypatch: pytest.MonkeyPatch
) -> None:
    from octop.api.routers import product_library

    _image(library)
    _image(library, data=_PNG + b"-second")
    library.service.store_asset(
        owner_id=1,
        product_id=library.product["id"],
        filename="notes.txt",
        media_type="text/plain",
        data=b"documentation",
        usage="reference",
    )
    _mock_model(monkeypatch, library.model)

    first = await product_library.generate_missing_descriptions(
        library.product["id"], user=SimpleNamespace(id=1), server=library.server
    )
    assert (first["total"], first["succeeded"], first["failed"]) == (2, 2, 0)
    assert library.model.calls == 2

    second = await product_library.generate_missing_descriptions(
        library.product["id"], user=SimpleNamespace(id=1), server=library.server
    )
    assert (second["total"], second["succeeded"], second["failed"]) == (0, 0, 0)


@pytest.mark.asyncio
async def test_batch_is_owner_scoped(
    library: SimpleNamespace, monkeypatch: pytest.MonkeyPatch
) -> None:
    from octop.api.routers import product_library

    _image(library)
    _mock_model(monkeypatch, library.model)
    with pytest.raises(OctopError) as denied:
        await product_library.generate_missing_descriptions(
            library.product["id"], user=SimpleNamespace(id=2), server=library.server
        )
    assert denied.value.code is ErrorCode.NOT_FOUND
    assert library.model.calls == 0


@pytest.mark.asyncio
async def test_deleting_a_product_cascades_its_descriptions(
    library: SimpleNamespace, monkeypatch: pytest.MonkeyPatch
) -> None:
    from octop.api.routers import product_library

    asset = _image(library)
    _mock_model(monkeypatch, library.model)
    await product_library.generate_asset_description(
        asset["id"], user=SimpleNamespace(id=1), server=library.server
    )
    library.repo.delete_product(1, library.product["id"])
    with library.db.connect() as conn:
        rows = conn.execute("SELECT * FROM product_library_asset_descriptions").fetchall()
    assert rows == []
