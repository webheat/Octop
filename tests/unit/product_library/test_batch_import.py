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
    FOLDER_PRIOR_MIN_CONFIDENCE,
    analyse_upload,
    commit_import,
    folder_of,
    group_key,
    sanitize_relative_path,
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

    def fake_categorise(
        data: bytes, media_type: str, model: Any, folder_hint: str = ""
    ) -> dict[str, Any]:
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

    def fake_categorise(
        data: bytes, media_type: str, model: Any, folder_hint: str = ""
    ) -> dict[str, Any]:
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

    def flaky(data: bytes, media_type: str, model: Any, folder_hint: str = "") -> dict[str, Any]:
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


def test_sanitize_relative_path_strips_traversal_and_drive() -> None:
    # Traversal components are dropped: the value never builds a disk path.
    assert sanitize_relative_path("../../etc/passwd") == "etc/passwd"
    assert sanitize_relative_path("C:\\imgs\\a.jpg") == "imgs/a.jpg"
    assert sanitize_relative_path("/abs/path/a.jpg") == "abs/path/a.jpg"
    assert sanitize_relative_path("a//b/./c.jpg") == "a/b/c.jpg"
    assert sanitize_relative_path("") == "upload.bin"
    assert sanitize_relative_path("../..") == "upload.bin"
    assert sanitize_relative_path(None, fallback="x.jpg") == "x.jpg"  # type: ignore[arg-type]


def test_sanitize_relative_path_bounds_depth_and_length() -> None:
    deep = "/".join(f"d{i}" for i in range(20)) + "/a.jpg"
    rel = sanitize_relative_path(deep)
    assert rel.count("/") == 7  # MAX_PATH_PARTS - 1
    assert rel.endswith("a.jpg")

    long_name = "a" * 1000 + ".jpg"
    assert len(sanitize_relative_path(long_name)) == 400


def test_folder_of_returns_top_level_directory() -> None:
    assert folder_of("hiking-bag/front/01.jpg") == "hiking-bag"
    assert folder_of("hiking-bag/01.jpg") == "hiking-bag"
    assert folder_of("01.jpg") == ""
    assert folder_of("") == ""


async def test_analyse_upload_keeps_relative_path_in_manifest(
    library: SimpleNamespace,
) -> None:
    service: ProductLibraryService = library.service
    files = [
        ("hiking-bag/front/01.jpg", "image/jpeg", b"bag-a"),
        ("hiking-bag/side/02.jpg", "image/jpeg", b"bag-b"),
    ]
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
        analysis = await analyse_upload(service, MagicMock(), owner_id=1, files=files)

    job_dir = library.paths.product_library_dir / "1" / "imports" / analysis["job_id"]
    manifest = json.loads((job_dir / "manifest.json").read_text(encoding="utf-8"))
    rows = {row["filename"]: row for row in manifest["items"]}
    assert rows["01.jpg"]["relative_path"] == "hiking-bag/front/01.jpg"
    assert rows["01.jpg"]["folder"] == "hiking-bag"
    # Disk layout stays flat: the index prefix plus basename, no subdirectories.
    assert rows["01.jpg"]["storage_name"] == "0-01.jpg"

    items = analysis["groups"][0]["items"]
    assert {item["relative_path"] for item in items} == {
        "hiking-bag/front/01.jpg",
        "hiking-bag/side/02.jpg",
    }
    assert all(item["folder"] == "hiking-bag" for item in items)


async def test_analyse_upload_without_paths_falls_back_to_basename(
    library: SimpleNamespace,
) -> None:
    """A8: an old client that sends no `paths` sees today's behaviour."""
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
    item = analysis["groups"][0]["items"][0]
    assert item["relative_path"] == "a.jpg"
    assert item["folder"] == ""
    assert item["group_source"] == "vision"


async def test_folder_name_wins_when_vision_is_unsure(
    library: SimpleNamespace,
) -> None:
    """A7: an empty or low-confidence group falls back to the folder name."""
    service: ProductLibraryService = library.service
    files = [
        ("登山包/01.jpg", "image/jpeg", b"unsure"),
        ("登机箱/01.jpg", "image/jpeg", b"confident"),
    ]

    def fake_categorise(
        data: bytes, media_type: str, model: Any, folder_hint: str = ""
    ) -> dict[str, Any]:
        if data == b"unsure":
            return {
                "group": "",
                "category": "箱包",
                "description": "x",
                "tags": [],
                "confidence": 0.2,
            }
        return {
            "group": "登机箱",
            "category": "箱包",
            "description": "y",
            "tags": [],
            "confidence": 0.95,
        }

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

    assert {call.args[3] for call in categorise_mock.call_args_list} == {
        "登山包",
        "登机箱",
    }

    by_group = {group["suggested_name"]: group for group in analysis["groups"]}
    assert set(by_group) == {"登山包", "登机箱"}
    unsure = by_group["登山包"]["items"][0]
    assert unsure["group_source"] == "folder"
    assert unsure["confidence"] >= FOLDER_PRIOR_MIN_CONFIDENCE
    assert by_group["登机箱"]["items"][0]["group_source"] == "vision"


async def test_confident_vision_group_is_not_overridden_by_folder(
    library: SimpleNamespace,
) -> None:
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
                "confidence": 0.95,
            },
        ),
    ):
        analysis = await analyse_upload(
            service,
            MagicMock(),
            owner_id=1,
            files=[("新建文件夹/01.jpg", "image/jpeg", b"x")],
        )
    # A junk folder name must never become a product name.
    assert analysis["groups"][0]["suggested_name"] == "登山包"


async def test_router_paths_count_mismatch_is_tolerated(
    library: SimpleNamespace,
) -> None:
    """More or fewer `paths` than `files` must never fail the request."""
    from octop.api.routers import product_library as router

    def upload(name: str) -> UploadFile:
        return UploadFile(
            file=BytesIO(b"bytes-" + name.encode()),
            filename=name,
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
        # Fewer paths than files: the tail falls back to the basename.
        analysis = await router.analyse_import(
            files=[upload("a.jpg"), upload("b.jpg")],
            paths=["folder/a.jpg"],
            user=SimpleNamespace(id=1),
            server=library.server,
        )
        # More paths than files: the extra entries are ignored.
        extra = await router.analyse_import(
            files=[upload("c.jpg")],
            paths=["folder/c.jpg", "ignored/d.jpg"],
            user=SimpleNamespace(id=1),
            server=library.server,
        )

    items = analysis["groups"][0]["items"]
    assert [item["relative_path"] for item in items] == ["folder/a.jpg", "b.jpg"]
    assert extra["groups"][0]["items"][0]["relative_path"] == "folder/c.jpg"


def test_categorise_prompt_is_unchanged_without_a_folder_hint() -> None:
    """No hint must keep the prompt byte-identical to today's."""
    from octop.infra.product_library.vision import CATEGORISE_PROMPT, _categorise_prompt

    assert _categorise_prompt() == CATEGORISE_PROMPT
    assert _categorise_prompt("   ") == CATEGORISE_PROMPT
    with_hint = _categorise_prompt("登山包")
    assert with_hint.startswith(CATEGORISE_PROMPT)
    assert '"登山包"' in with_hint


# ---------------------------------------------------------------------------
# placeholder group labels never become product names
# ---------------------------------------------------------------------------


def test_parse_categorisation_payload_drops_placeholder_group() -> None:
    for label in ["candidates", "Candidates", " candidate ", "未知", "未命名"]:
        got = parse_categorisation_payload(
            json.dumps(
                {
                    "group": label,
                    "category": "玉石",
                    "description": "x",
                    "tags": [],
                    "confidence": 0.9,
                },
                ensure_ascii=False,
            )
        )
        assert got["group"] == "", label


async def test_analyse_placeholder_group_falls_back_to_folder(
    library: SimpleNamespace,
) -> None:
    """A model that answers "candidates" must not name the product that."""

    def fake_categorise(
        data: bytes, media_type: str, model: Any, folder_hint: str = ""
    ) -> dict[str, Any]:
        return {
            "group": "candidates",
            "category": "玉石",
            "description": "翡翠手镯特写",
            "tags": ["翡翠"],
            "confidence": 0.9,
        }

    model_pair = (MagicMock(), "test/vision")
    files = [("翡翠手镯/01.jpg", "image/jpeg", b"bracelet")]
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
        analysis = await analyse_upload(
            service=library.service, provider_repo=MagicMock(), owner_id=1, files=files
        )

    assert analysis["groups"][0]["suggested_name"] == "翡翠手镯"
    assert analysis["groups"][0]["category"] == "玉石"


async def test_commit_placeholder_name_falls_back_to_source_folder(
    library: SimpleNamespace,
) -> None:
    service: ProductLibraryService = library.service

    def fake_categorise(
        data: bytes, media_type: str, model: Any, folder_hint: str = ""
    ) -> dict[str, Any]:
        return {
            "group": "candidates",
            "category": "玉石",
            "description": "翡翠手镯特写",
            "tags": ["翡翠"],
            "confidence": 0.9,
        }

    model_pair = (MagicMock(), "test/vision")
    files = [("翡翠手镯/01.jpg", "image/jpeg", b"bracelet")]
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
        analysis = await analyse_upload(
            service=service, provider_repo=MagicMock(), owner_id=1, files=files
        )

    group = analysis["groups"][0]
    result = commit_import(
        service,
        owner_id=1,
        job_id=analysis["job_id"],
        groups=[
            {
                "product_id": None,
                # A stale client sends back the placeholder it was given.
                "name": "candidates",
                "category": group["category"],
                "item_indices": [item["index"] for item in group["items"]],
            }
        ],
        exclude_indices=[],
    )
    assert result["created_products"] == 1
    assert {p["name"] for p in service.list_products(1)} == {"翡翠手镯"}


async def test_commit_without_any_usable_name_reports_failure(
    library: SimpleNamespace,
) -> None:
    service: ProductLibraryService = library.service

    def fake_categorise(
        data: bytes, media_type: str, model: Any, folder_hint: str = ""
    ) -> dict[str, Any]:
        return {
            "group": "candidates",
            "category": "玉石",
            "description": "翡翠手镯特写",
            "tags": ["翡翠"],
            "confidence": 0.9,
        }

    model_pair = (MagicMock(), "test/vision")
    files = [("01.jpg", "image/jpeg", b"bracelet")]
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
        analysis = await analyse_upload(
            service=service, provider_repo=MagicMock(), owner_id=1, files=files
        )

    group = analysis["groups"][0]
    result = commit_import(
        service,
        owner_id=1,
        job_id=analysis["job_id"],
        groups=[
            {
                "product_id": None,
                "name": "candidates",
                "category": group["category"],
                "item_indices": [item["index"] for item in group["items"]],
            }
        ],
        exclude_indices=[],
    )
    assert result["created_products"] == 0
    assert result["failed"] == [{"filename": "(group)", "reason": "missing product name"}]
