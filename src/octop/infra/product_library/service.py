"""Product-library file storage and immutable project snapshots."""

from __future__ import annotations

import asyncio
import hashlib
import json
import mimetypes
import re
from pathlib import Path
from typing import Any

from octop.infra.db.repos.product_library import ProductLibraryRepo
from octop.infra.errors import ErrorCode, OctopError
from octop.infra.utils.paths import PathLayout
from octop.infra.utils.ulid import new_ulid

_SAFE_IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".avif"}
_VIDEO_TYPES = {
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".m4v": "video/mp4",
}
_DOCUMENT_EXTENSIONS = {
    ".pdf",
    ".txt",
    ".md",
    ".doc",
    ".docx",
    ".xls",
    ".xlsx",
    ".ppt",
    ".pptx",
    ".csv",
    ".rtf",
}


def validate_asset(filename: str, media_type: str, usage: str) -> tuple[str, str]:
    """Restrict uploads to known inert media/document types."""
    if usage not in {"scene", "reference", "style"}:
        raise OctopError.localized(ErrorCode.SLASH_BAD_ARGS)
    name = Path(filename.replace("\\", "/")).name
    extension = Path(name).suffix.lower()
    del media_type
    if extension in _SAFE_IMAGE_EXTENSIONS:
        expected = mimetypes.guess_type(name)[0] or "application/octet-stream"
        return name, expected
    if extension in _VIDEO_TYPES:
        return name, _VIDEO_TYPES[extension]
    if extension in _DOCUMENT_EXTENSIONS:
        guessed = mimetypes.guess_type(name)[0] or "application/octet-stream"
        return name, guessed
    raise OctopError.localized(ErrorCode.ATTACHMENT_UNSUPPORTED_TYPE)


def decode_product(row: dict[str, Any]) -> dict[str, Any]:
    return {
        **row,
        "selling_points": json.loads(row.get("selling_points") or "[]"),
        "parameters": json.loads(row.get("parameters") or "{}"),
    }


def store_asset(
    paths: PathLayout,
    repo: ProductLibraryRepo,
    *,
    owner_id: int,
    product_id: str,
    filename: str,
    media_type: str,
    data: bytes,
    usage: str,
) -> dict[str, Any]:
    safe_name = Path(filename).name.replace("\\", "_") or "upload.bin"
    content_hash = hashlib.sha256(data).hexdigest()
    existing = repo.find_asset_by_hash(owner_id, product_id, content_hash)
    if existing is not None:
        return existing
    asset_id = new_ulid()
    relative = Path(str(owner_id)) / product_id / f"{asset_id}-{safe_name}"
    destination = paths.product_library_dir / relative
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(data)
    try:
        return repo.add_asset(
            owner_id,
            product_id,
            filename=safe_name,
            media_type=media_type,
            byte_size=len(data),
            content_hash=content_hash,
            storage_path=relative.as_posix(),
            usage=usage,
        )
    except Exception:
        destination.unlink(missing_ok=True)
        raise


def snapshot_project(
    repo: ProductLibraryRepo, *, owner_id: int, product_id: str, name: str, asset_ids: list[str]
) -> dict[str, Any] | None:
    product = repo.get_product(owner_id, product_id)
    if product is None:
        return None
    asset_ids = list(dict.fromkeys(asset_ids))
    selected = {asset["id"]: asset for asset in repo.list_assets(owner_id, product_id)}
    if any(asset_id not in selected for asset_id in asset_ids):
        return None
    assets = []
    for asset_id in asset_ids:
        asset = selected[asset_id]
        if not asset["active"]:
            continue
        assets.append(
            {
                key: asset[key]
                for key in (
                    "id",
                    "filename",
                    "media_type",
                    "byte_size",
                    "content_hash",
                    "storage_path",
                    "usage",
                    "priority",
                )
            }
        )
    snapshot = {"product": decode_product(product), "assets": assets, "version": 1}
    return repo.create_project(owner_id, product_id, name, snapshot)


def project_payload(row: dict[str, Any]) -> dict[str, Any]:
    return {**row, "snapshot": json.loads(row["snapshot_json"])}


def render_script(snapshot: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    product = snapshot["product"]
    render_assets = sorted(
        (a for a in snapshot["assets"] if a["usage"] == "scene"),
        key=lambda asset: not bool(asset["priority"]),
    )
    scenes: list[dict[str, Any]] = [
        {
            "id": "product-title",
            "type": "title",
            "duration": 3,
            "text": product["name"],
            "subtitle": product.get("model", ""),
        }
    ]
    if product.get("selling_points"):
        scenes.append(
            {
                "id": "selling-points",
                "type": "bullets",
                "duration": 4,
                "bullets": product["selling_points"],
            }
        )
    script_assets: list[dict[str, Any]] = []
    for i, asset in enumerate(render_assets):
        if not (
            asset["media_type"].startswith("image/") or asset["media_type"].startswith("video/")
        ):
            continue
        name = re.sub(r"[^A-Za-z0-9._-]+", "_", asset["filename"]).strip("._") or f"asset-{i}"
        name = f"{asset['id']}-{name}"
        scenes.append(
            {
                "id": f"asset-{i + 1}",
                "type": "video" if asset["media_type"].startswith("video/") else "image",
                "duration": 5,
                "asset": name,
            }
        )
        script_assets.append({**asset, "export_name": name})
    scenes.append({"id": "endcard", "type": "endcard", "duration": 2, "text": product["name"]})
    return (
        {"title": product["name"], "fps": 30, "width": 1920, "height": 1080, "scenes": scenes},
        script_assets,
    )


class ProductLibraryService:
    def __init__(self, paths: PathLayout, repo: ProductLibraryRepo) -> None:
        self.paths = paths
        self.repo = repo

    def list_products(self, owner_id: int) -> list[dict[str, Any]]:
        return [decode_product(row) for row in self.repo.list_products(owner_id)]

    def create_product(self, owner_id: int, fields: dict[str, Any]) -> dict[str, Any]:
        return decode_product(self.repo.create_product(owner_id, fields))

    def update_product(
        self, owner_id: int, product_id: str, fields: dict[str, Any]
    ) -> dict[str, Any]:
        if not self.repo.update_product(owner_id, product_id, fields):
            raise OctopError.localized(ErrorCode.NOT_FOUND)
        return decode_product(self.repo.get_product(owner_id, product_id) or {})

    def delete_product(self, owner_id: int, product_id: str) -> None:
        if not self.repo.delete_product(owner_id, product_id):
            raise OctopError.localized(ErrorCode.NOT_FOUND)

    def list_assets(self, owner_id: int, product_id: str) -> list[dict[str, Any]]:
        if self.repo.get_product(owner_id, product_id) is None:
            raise OctopError.localized(ErrorCode.NOT_FOUND)
        return self.repo.list_assets(owner_id, product_id)

    def update_asset(
        self,
        owner_id: int,
        asset_id: str,
        *,
        usage: str | None = None,
        priority: bool | None = None,
        active: bool | None = None,
    ) -> dict[str, Any]:
        if usage is not None and usage not in {"scene", "reference", "style"}:
            raise OctopError.localized(ErrorCode.SLASH_BAD_ARGS)
        if not self.repo.update_asset(
            owner_id, asset_id, usage=usage, priority=priority, active=active
        ):
            raise OctopError.localized(ErrorCode.NOT_FOUND)
        return self.repo.get_asset(owner_id, asset_id) or {}

    def get_asset(self, owner_id: int, asset_id: str) -> dict[str, Any]:
        row = self.repo.get_asset(owner_id, asset_id)
        if row is None:
            raise OctopError.localized(ErrorCode.NOT_FOUND)
        return row

    def list_projects(self, owner_id: int) -> list[dict[str, Any]]:
        return [project_payload(row) for row in self.repo.list_projects(owner_id)]

    def get_project(self, owner_id: int, project_id: str) -> dict[str, Any]:
        row = self.repo.get_project(owner_id, project_id)
        if row is None:
            raise OctopError.localized(ErrorCode.NOT_FOUND)
        return row

    def delete_project(self, owner_id: int, project_id: str) -> None:
        if not self.repo.delete_project(owner_id, project_id):
            raise OctopError.localized(ErrorCode.NOT_FOUND)

    def store_asset(
        self,
        *,
        owner_id: int,
        product_id: str,
        filename: str,
        media_type: str,
        data: bytes,
        usage: str,
    ) -> dict[str, Any]:
        if self.repo.get_product(owner_id, product_id) is None:
            raise OctopError.localized(ErrorCode.NOT_FOUND)
        safe_name, safe_type = validate_asset(filename, media_type, usage)
        return store_asset(
            self.paths,
            self.repo,
            owner_id=owner_id,
            product_id=product_id,
            filename=safe_name,
            media_type=safe_type,
            data=data,
            usage=usage,
        )

    def create_snapshot(
        self, *, owner_id: int, product_id: str, name: str, asset_ids: list[str]
    ) -> dict[str, Any]:
        row = snapshot_project(
            self.repo, owner_id=owner_id, product_id=product_id, name=name, asset_ids=asset_ids
        )
        if row is None:
            raise OctopError.localized(ErrorCode.NOT_FOUND)
        return row

    async def prepare_render(self, *, project: dict[str, Any], workspace: Any) -> dict[str, Any]:
        payload = project_payload(project)
        script, assets = render_script(payload["snapshot"])
        job_path = f"render-jobs/{project['id']}"
        # Read and validate every source before publishing any job file. script.json is
        # uploaded last so the polling renderer never sees a partially prepared job.
        files = []
        for asset in assets:
            source = self.paths.product_library_dir / asset["storage_path"]
            if not await asyncio.to_thread(source.is_file):
                raise OctopError.localized(ErrorCode.NOT_FOUND)
            data = await asyncio.to_thread(source.read_bytes)
            if hashlib.sha256(data).hexdigest() != asset["content_hash"]:
                raise OctopError.localized(ErrorCode.NOT_FOUND)
            files.append((asset["export_name"], data))
        await workspace.amkdir(job_path)
        await workspace.amkdir(f"{job_path}/assets")
        for filename, data in files:
            await workspace.aupload_bytes(f"{job_path}/assets/{filename}", data)
        await workspace.aupload_bytes(
            f"{job_path}/script.json",
            json.dumps(script, ensure_ascii=False, indent=2).encode("utf-8"),
        )
        return {
            "status": "prepared",
            "job_id": project["id"],
            "workspace_path": job_path,
            "rendered": False,
        }
