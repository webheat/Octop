"""Directory batch import: grouping, dedupe, owner scoping and failure isolation."""

from __future__ import annotations

import json
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from fastapi import UploadFile
from starlette.datastructures import Headers

from octop.infra.db.migrate import run_migrations
from octop.infra.db.pool import SqlitePool
from octop.infra.db.repos.product_library import ProductLibraryRepo
from octop.infra.product_library.batch_import import (
    analyse_upload,
    commit_import,
    group_key,
)
from octop.infra.product_library.service import ProductLibraryService
from octop.infra.product_library.vision import (
    parse_categorisation_payload,
)
from octop.infra.utils.paths import PathLayout


@pytest.fixture
def library(tmp_path: Path) -> SimpleNamespace:
    db = SqlitePool(tmp_path / "control.db")
    run_migrations(db)
    repo = ProductLibraryRepo(db)
    paths = PathLayout(tmp_path / "data")
    service = ProductLibraryService(paths, repo)
    server = SimpleNamespace(
        services=SimpleNamespace(
            paths=paths,
            product_library_repo=repo,
            provider_repo=MagicMock(),
            config=SimpleNamespace(max_upload_bytes=8 * 1024 * 1024),
        )
    )
    return SimpleNamespace(service=service, repo=repo, paths=paths, server=server)


class FakeVisionModel:
    """Minimal chat model that returns canned JSON based on image bytes."""

    def __init__(self, answers: dict[bytes, dict[str, Any]]) -> None:
        self.answers = answers

    def invoke(self, messages: Any) -> Any:
        # The image_url content carries a data:...;base64 payload; map by bytes
        # through a sentinel embedded by the test instead of decoding here.
        raise AssertionError("tests patch categorise_image, not invoke")


# ---------------------------------------------------------------------------
# payload validation
# ---------------------------------------------------------------------------


def test_parse_categorisation_payload_valid() -> None:
    got = parse_categorisation_payload(
        json.dumps(
            {
                "group": "登山包",
                "category": "箱包",
                "description": "灰色双肩包",
                "tags": ["尼龙", "登山"],
                "confidence": 0.9,
            },
            ensure_ascii=False,
        )
    )
    assert got["group"] == "登山包"
    assert got["category"] == "箱包"
    assert got["confidence"] == 0.9


def test_parse_categorisation_payload_rejects_garbage() -> None:
    for raw in [
        "not json",
        "[]",
        json.dumps({"description": "", "tags": []}),
        json.dumps({"description": "x", "tags": [], "confidence": "high"}),
        json.dumps({"description": "x", "tags": [], "group": 5}),
    ]:
        with pytest.raises(ValueError):
            parse_categorisation_payload(raw)


def test_parse_categorisation_payload_clamps_confidence_and_markdown() -> None:
    raw = (
        "```json\n"
        + json.dumps({"description": "x", "tags": [], "confidence": 5.0}, ensure_ascii=False)
        + "\n```"
    )
    assert parse_categorisation_payload(raw)["confidence"] == 1.0


def test_group_key_normalises_unicode_and_case() -> None:
    assert group_key("登山包", "箱包") == group_key("登 山 包 ", "箱包")


# ---------------------------------------------------------------------------
# analyse + commit
# ---------------------------------------------------------------------------


async def test_analyse_groups_images_and_commit_archives(
    library: SimpleNamespace,
) -> None:
    service: ProductLibraryService = library.service

    def fake_categorise(data: bytes, media_type: str, model: Any) -> dict[str, Any]:
        if b"backpack" in data:
            return {
                "group": "登山包",
                "category": "箱包",
                "description": "灰色登山双肩包",
                "tags": ["尼龙"],
                "confidence": 0.9,
            }
        return {
            "group": "登机箱",
            "category": "箱包",
            "description": "银色登机箱",
            "tags": ["铝框"],
            "confidence": 0.8,
        }

    model_pair = (MagicMock(), "test/vision")
    files = [
        ("front.jpg", "image/jpeg", b"backpack-front"),
        ("side.jpg", "image/jpeg", b"backpack-side"),
        ("case.jpg", "image/jpeg", b"trolley-case"),
        ("notes.txt", "text/plain", b"ignore me"),
    ]
    with (
        patch(
            "octop.infra.product_library.batch_import.resolve_vision_model",
            return_value=model_pair,
        ),
        patch(
            "octop.infra.product_library.batch_import.categorise_image",
            side_effect=fake_categorise,
        ),
    ):
        analysis = await analyse_upload(service, MagicMock(), owner_id=1, files=files)

    assert analysis["total"] == 3  # txt skipped
    assert analysis["skipped"][0]["filename"] == "notes.txt"
    assert len(analysis["groups"]) == 2
    assert all(not g["items"][0]["duplicate"] for g in analysis["groups"])

    groups = [
        {
            "product_id": None,
            "name": g["suggested_name"],
            "category": g["category"],
            "item_indices": [item["index"] for item in g["items"]],
        }
        for g in analysis["groups"]
    ]
    result = commit_import(
        service,
        owner_id=1,
        job_id=analysis["job_id"],
        groups=groups,
        exclude_indices=[],
    )
    assert result["created_products"] == 2
    assert result["imported_assets"] == 3
    products = service.list_products(1)
    assert {p["name"] for p in products} == {"登山包", "登机箱"}


async def test_duplicate_bytes_reuse_description_and_dedupe_asset(
    library: SimpleNamespace,
) -> None:
    service: ProductLibraryService = library.service

    def fake_categorise(data: bytes, media_type: str, model: Any) -> dict[str, Any]:
        return {
            "group": "登山包",
            "category": "箱包",
            "description": "灰色登山包",
            "tags": [],
            "confidence": 0.9,
        }

    files = [
        ("a.jpg", "image/jpeg", b"same-bytes"),
        ("b.jpg", "image/jpeg", b"same-bytes"),
    ]
    with (
        patch(
            "octop.infra.product_library.batch_import.resolve_vision_model",
            return_value=(MagicMock(), "test/vision"),
        ),
        patch(
            "octop.infra.product_library.batch_import.categorise_image",
            side_effect=fake_categorise,
        ) as categorise_mock,
    ):
        analysis = await analyse_upload(service, MagicMock(), owner_id=1, files=files)
    # Identical bytes within the batch must only spend one vision call.
    assert categorise_mock.call_count == 1

    group = analysis["groups"][0]
    result = commit_import(
        service,
        owner_id=1,
        job_id=analysis["job_id"],
        groups=[
            {
                "product_id": None,
                "name": "登山包",
                "category": "箱包",
                "item_indices": [item["index"] for item in group["items"]],
            }
        ],
        exclude_indices=[],
    )
    assert result["imported_assets"] == 1
    assert result["skipped_duplicates"] == 1


async def test_other_owner_cannot_commit(library: SimpleNamespace) -> None:
    service: ProductLibraryService = library.service
    with (
        patch(
            "octop.infra.product_library.batch_import.resolve_vision_model",
            return_value=(MagicMock(), "test/vision"),
        ),
        patch(
            "octop.infra.product_library.batch_import.categorise_image",
            return_value={
                "group": "登山包",
                "category": "箱包",
                "description": "x",
                "tags": [],
                "confidence": 0.9,
            },
        ),
    ):
        analysis = await analyse_upload(
            service, MagicMock(), owner_id=1, files=[("a.jpg", "image/jpeg", b"x")]
        )
    # A foreign job id resolves into owner 2's own directory, which has no such
    # job -> FileNotFoundError; a tampered manifest would raise PermissionError.
    # Either way the other owner cannot archive the batch.
    with pytest.raises((PermissionError, FileNotFoundError)):
        commit_import(
            service,
            owner_id=2,
            job_id=analysis["job_id"],
            groups=[],
            exclude_indices=[],
        )


async def test_vision_failure_does_not_block_batch(library: SimpleNamespace) -> None:
    service: ProductLibraryService = library.service

    def flaky(data: bytes, media_type: str, model: Any) -> dict[str, Any]:
        if b"bad" in data:
            raise RuntimeError("model exploded")
        return {
            "group": "登山包",
            "category": "箱包",
            "description": "ok",
            "tags": [],
            "confidence": 0.9,
        }

    with (
        patch(
            "octop.infra.product_library.batch_import.resolve_vision_model",
            return_value=(MagicMock(), "test/vision"),
        ),
        patch(
            "octop.infra.product_library.batch_import.categorise_image",
            side_effect=flaky,
        ),
    ):
        analysis = await analyse_upload(
            service,
            MagicMock(),
            owner_id=1,
            files=[("ok.jpg", "image/jpeg", b"good"), ("bad.jpg", "image/jpeg", b"bad")],
        )
    assert len(analysis["groups"]) == 1
    assert analysis["failed"][0]["filename"] == "bad.jpg"


async def test_router_analyze_and_commit_are_owner_scoped(
    library: SimpleNamespace,
) -> None:
    from octop.api.routers import product_library as router
    from octop.infra.errors import ErrorCode, OctopError

    upload = UploadFile(
        file=BytesIO(b"backpack-front"),
        filename="a.jpg",
        headers=Headers({"content-type": "image/jpeg"}),
    )
    with (
        patch(
            "octop.infra.product_library.batch_import.resolve_vision_model",
            return_value=(MagicMock(), "test/vision"),
        ),
        patch(
            "octop.infra.product_library.batch_import.categorise_image",
            return_value={
                "group": "登山包",
                "category": "箱包",
                "description": "x",
                "tags": [],
                "confidence": 0.9,
            },
        ),
    ):
        analysis = await router.analyse_import(
            files=[upload],
            user=SimpleNamespace(id=1),
            server=library.server,
        )
    assert analysis["job_id"]
    assert len(analysis["groups"]) == 1

    body = router.ImportCommitBody(
        job_id=analysis["job_id"],
        groups=[
            router.ImportCommitGroup(
                product_id=None,
                name="登山包",
                category="箱包",
                item_indices=[0],
            )
        ],
        exclude_indices=[],
    )
    # Another owner's commit must map to NOT_FOUND, never a raw 500.
    with pytest.raises(OctopError) as denied:
        await router.commit_import_plan(
            body=body, user=SimpleNamespace(id=2), server=library.server
        )
    assert denied.value.code is ErrorCode.NOT_FOUND

    # The rightful owner can commit successfully.
    result = await router.commit_import_plan(
        body=body, user=SimpleNamespace(id=1), server=library.server
    )
    assert result["created_products"] == 1
    assert result["imported_assets"] == 1
