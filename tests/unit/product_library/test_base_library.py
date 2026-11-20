"""Curated base library: local screening, quarantine and video handoff."""

from __future__ import annotations

from io import BytesIO
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import UploadFile
from PIL import Image, ImageDraw
from starlette.datastructures import Headers

from octop.infra.db.migrate import run_migrations
from octop.infra.db.pool import SqlitePool
from octop.infra.db.repos.product_library import ProductLibraryRepo
from octop.infra.product_library.base_library import (
    BaseLibraryService,
    export_base_manifest,
)
from octop.infra.product_library.video_planner import VideoPlanRequest
from octop.infra.utils.paths import PathLayout


def _product_image(*, shift: int = 0) -> bytes:
    image = Image.new("RGB", (900, 700), (245, 245, 240))
    draw = ImageDraw.Draw(image)
    for y in range(700):
        shade = 240 - y // 30
        draw.line((0, y, 900, y), fill=(shade, shade, shade - 5))
    draw.rectangle((300 + shift, 250, 700 + shift, 600), fill=(40, 70, 130))
    buffer = BytesIO()
    image.save(buffer, "JPEG", quality=90)
    return buffer.getvalue()


def _flat_image() -> bytes:
    buffer = BytesIO()
    Image.new("RGB", (800, 600), (255, 255, 255)).save(buffer, "PNG")
    return buffer.getvalue()


@pytest.fixture
def library(tmp_path: Path) -> SimpleNamespace:
    db = SqlitePool(tmp_path / "control.db")
    run_migrations(db)
    repo = ProductLibraryRepo(db)
    paths = PathLayout(tmp_path / "data")
    service = BaseLibraryService(paths, repo)
    server = SimpleNamespace(
        services=SimpleNamespace(
            paths=paths,
            product_library_repo=repo,
            config=SimpleNamespace(max_upload_bytes=8 * 1024 * 1024),
        )
    )
    return SimpleNamespace(service=service, repo=repo, paths=paths, server=server)


def test_ingest_routes_clean_duplicate_corrupt_and_low_quality(
    library: SimpleNamespace,
) -> None:
    service: BaseLibraryService = library.service
    files = [
        ("hero.jpg", "image/jpeg", _product_image()),
        ("copy.jpg", "image/jpeg", _product_image()),
        ("broken.jpg", "image/jpeg", b"not an image"),
        ("blank.png", "image/png", _flat_image()),
    ]
    result = service.ingest(11, files)

    assert result["ready_count"] == 1
    assert result["isolated_count"] == 3
    reasons = {row["filename"]: row["reason"] for row in result["isolated"]}
    assert reasons == {
        "copy.jpg": "duplicate",
        "broken.jpg": "corrupt",
        "blank.png": "low_quality",
    }

    paths = library.paths.product_library_dir
    ready = service.list_images(11, status="ready")
    assert len(ready) == 1
    assert (paths / ready[0]["storage_path"]).is_file()
    for row in result["isolated"]:
        assert f"quarantine/{row['reason']}/" in row["storage_path"]
        assert (paths / row["storage_path"]).is_file()


def test_owner_isolation_and_manifest(library: SimpleNamespace) -> None:
    service: BaseLibraryService = library.service
    service.ingest(1, [("a.jpg", "image/jpeg", _product_image())])
    service.ingest(2, [("b.jpg", "image/jpeg", _product_image())])
    assert len(service.list_images(1)) == 1
    assert len(service.list_images(2)) == 1
    manifest = export_base_manifest(1, service.list_images(1, status="ready"))
    assert manifest["count"] == 1
    assert manifest["images"][0]["content_hash"]


def test_restore_and_purge_are_owner_scoped(library: SimpleNamespace) -> None:
    service: BaseLibraryService = library.service
    result = service.ingest(3, [("blank.png", "image/png", _flat_image())])
    quarantined = result["isolated"][0]
    image_id = quarantined["image_id"]

    assert service.restore(4, image_id) is None
    restored = service.restore(3, image_id)
    assert restored is not None and restored["status"] == "ready"
    assert "quarantine/" not in restored["storage_path"]

    service.ingest(3, [("bad.jpg", "image/jpeg", b"broken")])
    purged = service.purge(3, reason="corrupt")
    assert purged["removed"] == 1
    assert all(row["status"] == "ready" for row in service.list_images(3))


def test_video_plan_uses_only_ready_base_images(library: SimpleNamespace) -> None:
    service: BaseLibraryService = library.service
    result = service.ingest(5, [("hero.jpg", "image/jpeg", _product_image())])
    image_id = result["ready"][0]["image_id"]
    plan = service.plan_from_base_images(5, [image_id], VideoPlanRequest(), product_name="登山包")
    assert plan is not None
    assert plan["script"]["title"] == "登山包"
    assert any(scene["type"] == "image" for scene in plan["script"]["scenes"])
    assert service.plan_from_base_images(6, [image_id], VideoPlanRequest()) is None


async def test_router_ingest_and_list_are_owner_scoped(library: SimpleNamespace) -> None:
    from octop.api.routers import product_library as router

    upload = UploadFile(
        file=BytesIO(_product_image()),
        filename="a.jpg",
        headers=Headers({"content-type": "image/jpeg"}),
    )
    first = await router.ingest_base_images(
        files=[upload],
        user=SimpleNamespace(id=1),
        server=library.server,
    )
    assert first["ready_count"] == 1
    listed = await router.list_base_images(
        status="ready", user=SimpleNamespace(id=2), server=library.server
    )
    assert listed["items"] == []
