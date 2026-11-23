"""Authenticated product library and Remotion project preparation endpoints."""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from starlette.background import BackgroundTask

from octop.api.common.content_disposition import content_disposition
from octop.api.common.upload_limit import read_upload_capped
from octop.api.common.workspace import require_running_workspace
from octop.api.deps import current_user, get_server
from octop.config import DEFAULT_MAX_UPLOAD_MB, upload_mb_to_bytes
from octop.infra.errors import ErrorCode, OctopError
from octop.infra.product_library.audio import load_catalog, pick_track, track_path
from octop.infra.product_library.base_library import BaseLibraryService, export_base_manifest
from octop.infra.product_library.batch_import import analyse_upload, commit_import
from octop.infra.product_library.llm_video_planner import generate_model_plan
from octop.infra.product_library.narration import (
    PAID_VOICE_PRESETS,
    has_premium_narration,
    render_narration_clips,
    resolve_voice_preset,
)
from octop.infra.product_library.package_export import export_project_package
from octop.infra.product_library.recognition import (
    group_local_plan,
    plan_local_video,
    recognise_uploads,
)
from octop.infra.product_library.service import (
    ProductLibraryService,
    project_payload,
)
from octop.infra.product_library.video_drafts import delete_draft, load_draft, save_draft
from octop.infra.product_library.video_planner import VideoPlanRequest, build_video_plan
from octop.infra.product_library.vision import (
    describe_asset as describe_asset_content,
)
from octop.infra.product_library.vision import (
    describe_missing_assets,
)
from octop.infra.voice.manager import VoiceManager

_BASE_STATUS = Literal["ready", "quarantined"]

router = APIRouter()


@router.get(
    "/product-library/projects/{project_id}/package",
    response_class=FileResponse,
    summary="Download a complete local Studio package",
    description="Download the current user's project, referenced media, and Studio launcher. No running agent or local business backend is required.",
)
async def download_project_package(
    project_id: str,
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> FileResponse:
    project = _service(server).get_project(user.id, project_id)
    package = await asyncio.to_thread(export_project_package, server.services.paths, project)
    return FileResponse(
        package,
        media_type="application/zip",
        filename=f"video-project-{project_id}.zip",
        background=BackgroundTask(package.unlink, missing_ok=True),
        headers={"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"},
    )


class ProductBody(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    model: str = Field(default="", max_length=200)
    category: str = Field(default="", max_length=100)
    selling_points: list[str] = Field(default_factory=list)
    parameters: dict[str, Any] = Field(default_factory=dict)
    expression_limits: str = Field(default="", max_length=4000)


class ProjectBody(BaseModel):
    product_id: str
    name: str = Field(min_length=1, max_length=200)
    asset_ids: list[str] = Field(default_factory=list)


class PrepareRenderBody(BaseModel):
    agent_id: str


class AssetBody(BaseModel):
    usage: Literal["scene", "reference", "style"] | None = None
    priority: bool | None = None
    active: bool | None = None


class ProductResponse(ProductBody):
    id: str
    owner_user_id: int
    created_at: int
    updated_at: int


class AssetResponse(BaseModel):
    id: str
    product_id: str
    filename: str
    media_type: str
    byte_size: int
    content_hash: str
    usage: str
    priority: int
    active: int
    created_at: int
    ai_description: str = ""
    ai_tags: list[str] = []
    ai_status: str = "none"
    ai_error: str = ""
    ai_model: str = ""
    ai_content_hash: str = ""
    ai_updated_at: int = 0


class ProjectResponse(BaseModel):
    id: str
    product_id: str
    name: str
    snapshot: dict[str, Any]
    created_at: int


class ProductItemsResponse(BaseModel):
    items: list[ProductResponse]


class AssetItemsResponse(BaseModel):
    items: list[AssetResponse]


class ProjectItemsResponse(BaseModel):
    items: list[ProjectResponse]


class BaseImageResponse(BaseModel):
    image_id: str
    filename: str
    media_type: str
    byte_size: int
    content_hash: str
    phash: str = ""
    dhash: str = ""
    width: int = 0
    height: int = 0
    blur_score: float = 0.0
    brightness: float = 0.0
    flatness: float = 0.0
    quality_score: float = 0.0
    dominant_colors: list[str] = []
    storage_path: str
    status: str = "ready"
    reason: str = ""
    created_at: int = 0


class BaseIngestResponse(BaseModel):
    total: int
    ready_count: int
    isolated_count: int
    ready: list[BaseImageResponse]
    isolated: list[BaseImageResponse]


class BaseImageItemsResponse(BaseModel):
    items: list[BaseImageResponse]


class BasePurgeResponse(BaseModel):
    removed: int


class BasePreviewBody(BaseModel):
    image_ids: list[str] = Field(min_length=1)
    name: str = Field(default="", max_length=200)


class DescribeMissingResponse(BaseModel):
    total: int
    succeeded: int
    failed: int
    items: list[AssetResponse]


class ImportItem(BaseModel):
    index: int
    filename: str
    relative_path: str = Field(
        default="", description="Client-supplied path, e.g. `hiking-bag/front/01.jpg`."
    )
    folder: str = Field(default="", description="Top-level folder used as a grouping prior.")
    confidence: float = 0.0
    description: str = ""
    tags: list[str] = []
    group_source: Literal["vision", "folder"] = Field(
        default="vision", description="Whether the group came from the model or the folder name."
    )
    duplicate: bool = False


class ImportGroup(BaseModel):
    key: str
    suggested_name: str = ""
    category: str = ""
    items: list[ImportItem] = []


class ImportNotice(BaseModel):
    filename: str
    relative_path: str = ""
    reason: str


class ImportAnalysisResponse(BaseModel):
    job_id: str
    total: int
    groups: list[ImportGroup]
    skipped: list[ImportNotice]
    failed: list[ImportNotice]


class ImportCommitGroup(BaseModel):
    product_id: str | None = None
    name: str = ""
    category: str = ""
    item_indices: list[int] = []


class ImportCommitBody(BaseModel):
    job_id: str
    groups: list[ImportCommitGroup]
    exclude_indices: list[int] = []


class ImportCommitResponse(BaseModel):
    created_products: int
    reused_products: int
    imported_assets: int
    skipped_duplicates: int
    failed: list[ImportNotice] = []


class PreparedResponse(BaseModel):
    status: str
    job_id: str
    workspace_path: str
    rendered: bool


def _not_found() -> OctopError:
    return OctopError.localized(ErrorCode.NOT_FOUND)


def _service(server: Any) -> ProductLibraryService:
    return ProductLibraryService(server.services.paths, server.services.product_library_repo)


def _voice_manager(server: Any) -> VoiceManager:
    return VoiceManager(
        settings_repo=server.services.settings_repo,
        voice_provider_repo=server.services.voice_provider_repo,
    )


@router.get(
    "/product-library/narration-options",
    summary="List narration presets available to the current user",
)
async def narration_options(
    user: Any = Depends(current_user),
) -> dict[str, Any]:
    """Which voices the caller may pick, and whether narration is available.

    Free accounts use the local Windows voice on the desktop client; paid
    accounts may pick a MiniMax preset rendered by the server.
    """
    premium = has_premium_narration(user)
    return {
        "premium": premium,
        "modes": ["off", "local"] if not premium else ["off", "local", "bundled"],
        "voices": list(PAID_VOICE_PRESETS) if premium else [],
    }


@router.get(
    "/product-library/bgm-options",
    summary="List background music available for the current package",
)
async def bgm_options(
    user: Any = Depends(current_user), server: Any = Depends(get_server)
) -> dict[str, Any]:
    """Catalogue metadata only — never a preview URL.

    Mixkit's licence allows these tracks inside a finished video but forbids
    redistributing the audio files themselves, so the client picks a track by
    name and the server copies it into the package at export time.
    """
    root = server.services.paths.bgm_library_dir
    tracks = await asyncio.to_thread(load_catalog, root)
    default = await asyncio.to_thread(pick_track, root)
    return {
        "default": default.id if default else "",
        "items": [
            {
                "id": track.id,
                "name": track.name,
                "category": track.category,
                "bpm": track.bpm,
                "bar": track.bar_seconds,
                "author": track.author,
            }
            for track in tracks
        ],
    }


@router.get(
    "/product-library/bgm/{track_id}/stream",
    response_class=FileResponse,
    summary="Audition one background track",
    description=(
        "Streams a catalogue track to the signed-in account so the picker can be "
        "auditioned in place. Range requests are honoured so the browser can seek. "
        "The track is never offered as a downloadable file: it carries no "
        "Content-Disposition and is never cached publicly, because the licence "
        "covers use inside a finished video rather than redistribution."
    ),
)
async def stream_bgm(
    track_id: str,
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> FileResponse:
    root = server.services.paths.bgm_library_dir
    track = await asyncio.to_thread(pick_track, root, track_id)
    path = await asyncio.to_thread(track_path, root, track) if track else None
    if path is None:
        raise OctopError.localized(ErrorCode.NOT_FOUND)
    return FileResponse(
        path,
        media_type="audio/mpeg",
        headers={
            "Cache-Control": "private, no-store",
            "Accept-Ranges": "bytes",
        },
    )


@router.get(
    "/product-library/products", response_model=ProductItemsResponse, summary="List my products"
)
async def list_products(
    user: Any = Depends(current_user), server: Any = Depends(get_server)
) -> dict[str, Any]:
    return {"items": _service(server).list_products(user.id)}


@router.post(
    "/product-library/products",
    status_code=201,
    response_model=ProductResponse,
    summary="Create a product",
)
async def create_product(
    body: ProductBody, user: Any = Depends(current_user), server: Any = Depends(get_server)
) -> dict[str, Any]:
    return _service(server).create_product(user.id, body.model_dump())


@router.patch(
    "/product-library/products/{product_id}",
    response_model=ProductResponse,
    summary="Update a product",
)
async def update_product(
    product_id: str,
    body: ProductBody,
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> dict[str, Any]:
    return _service(server).update_product(user.id, product_id, body.model_dump())


@router.delete(
    "/product-library/products/{product_id}", status_code=204, summary="Delete a product"
)
async def delete_product(
    product_id: str, user: Any = Depends(current_user), server: Any = Depends(get_server)
) -> None:
    _service(server).delete_product(user.id, product_id)


@router.get(
    "/product-library/products/{product_id}/assets",
    response_model=AssetItemsResponse,
    summary="List product assets",
)
async def list_assets(
    product_id: str, user: Any = Depends(current_user), server: Any = Depends(get_server)
) -> dict[str, Any]:
    return {"items": _service(server).list_assets(user.id, product_id)}


@router.post(
    "/product-library/products/{product_id}/assets",
    status_code=201,
    response_model=AssetItemsResponse,
    summary="Upload product assets",
)
async def upload_assets(
    product_id: str,
    files: list[UploadFile] = File(...),
    usage: Literal["scene", "reference", "style"] = Form(default="reference"),
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> dict[str, Any]:
    service = _service(server)
    max_bytes = int(
        server.services.config.max_upload_bytes or upload_mb_to_bytes(DEFAULT_MAX_UPLOAD_MB)
    )
    stored = []
    for file in files:
        filename = Path(file.filename or "upload.bin").name
        data = await read_upload_capped(file, max_bytes=max_bytes)
        stored.append(
            await asyncio.to_thread(
                service.store_asset,
                owner_id=user.id,
                product_id=product_id,
                filename=filename,
                media_type=file.content_type or "",
                data=data,
                usage=usage,
            )
        )
    return {"items": stored}


@router.post(
    "/product-library/imports/analyze",
    response_model=ImportAnalysisResponse,
    summary="Categorise a directory of images into suggested product groups (dry run)",
    description=(
        "Accepts the files picked by the browser's file or directory selector, "
        "runs one vision call per distinct image and returns a reviewable "
        "grouping plan. `paths` is an optional parallel field carrying each "
        "file's relative path so directory structure survives the upload; when "
        "absent or shorter than `files`, the entries fall back to the bare "
        "filename. Writes no products or assets; the files are kept in a "
        "temporary job directory until commit."
    ),
)
async def analyse_import(
    files: list[UploadFile] = File(...),
    paths: list[str] = Form(default=[]),
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> dict[str, Any]:
    service = _service(server)
    max_bytes = int(
        server.services.config.max_upload_bytes or upload_mb_to_bytes(DEFAULT_MAX_UPLOAD_MB)
    )
    payload: list[tuple[str, str, bytes]] = []
    # ``paths`` arrives as a plain list through HTTP, but a direct call (tests,
    # in-process callers) can hand us the untouched ``Form`` marker, so guard
    # the shape instead of trusting the annotation.
    raw_paths = paths if isinstance(paths, list) else []
    for index, file in enumerate(files):
        filename = Path(file.filename or "upload.bin").name
        # Parallel field, not the multipart filename: parsers basename the
        # Content-Disposition name, which would silently drop the structure.
        raw_path = raw_paths[index].strip() if index < len(raw_paths) else ""
        data = await read_upload_capped(file, max_bytes=max_bytes)
        payload.append((raw_path or filename, file.content_type or "", data))
    return await analyse_upload(
        service,
        server.services.provider_repo,
        owner_id=user.id,
        files=payload,
    )


def _base_service(server: Any) -> BaseLibraryService:
    return BaseLibraryService(server.services.paths, server.services.product_library_repo)


@router.post(
    "/product-library/base-library/ingest",
    response_model=BaseIngestResponse,
    summary="Screen uploaded images locally and build the curated base library",
    description=(
        "Uses PIL + numpy only — no vision model call. Clean images are indexed "
        "as ready; corrupt, low-quality and near-duplicate images are isolated "
        "under the user's quarantine directory for cleanup."
    ),
)
async def ingest_base_images(
    files: list[UploadFile] = File(...),
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> dict[str, Any]:
    max_bytes = int(
        server.services.config.max_upload_bytes or upload_mb_to_bytes(DEFAULT_MAX_UPLOAD_MB)
    )
    payload: list[tuple[str, str, bytes]] = []
    for file in files:
        data = await read_upload_capped(file, max_bytes=max_bytes)
        payload.append((Path(file.filename or "upload.bin").name, file.content_type or "", data))
    return await asyncio.to_thread(_base_service(server).ingest, user.id, payload)


@router.get(
    "/product-library/base-library",
    response_model=BaseImageItemsResponse,
    summary="List curated base images (ready or quarantined)",
)
async def list_base_images(
    status: _BASE_STATUS | None = None,
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> dict[str, Any]:
    return {"items": _base_service(server).list_images(user.id, status=status)}


@router.get(
    "/product-library/base-library/manifest",
    summary="Export a portable manifest of the curated base library",
)
async def get_base_manifest(
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> dict[str, Any]:
    service = _base_service(server)
    return export_base_manifest(user.id, service.list_images(user.id, status="ready"))


@router.post(
    "/product-library/base-library/{image_id}/restore",
    response_model=BaseImageResponse,
    summary="Approve a quarantined image into the ready base library",
)
async def restore_base_image(
    image_id: str,
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> dict[str, Any]:
    restored = await asyncio.to_thread(_base_service(server).restore, user.id, image_id)
    if restored is None:
        raise _not_found()
    return restored


@router.delete(
    "/product-library/base-library/quarantine",
    response_model=BasePurgeResponse,
    summary="Delete isolated images after review",
)
async def purge_quarantine(
    reason: Literal["corrupt", "low_quality", "duplicate"] | None = None,
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> dict[str, Any]:
    return await asyncio.to_thread(_base_service(server).purge, user.id, reason=reason)


@router.post(
    "/product-library/base-library/preview-video",
    summary="Preview a video plan built directly from curated base images",
)
async def preview_base_video(
    body: BasePreviewBody,
    plan: VideoPlanRequest,
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> dict[str, Any]:
    result = _base_service(server).plan_from_base_images(
        user.id, body.image_ids, plan, product_name=body.name
    )
    if result is None:
        raise _not_found()
    return result


@router.post(
    "/product-library/imports/commit",
    response_model=ImportCommitResponse,
    summary="Archive a reviewed import plan into products and assets",
)
async def commit_import_plan(
    body: ImportCommitBody,
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> dict[str, Any]:
    try:
        return await asyncio.to_thread(
            commit_import,
            _service(server),
            owner_id=user.id,
            job_id=body.job_id,
            groups=[group.model_dump() for group in body.groups],
            exclude_indices=body.exclude_indices,
        )
    except (PermissionError, FileNotFoundError, ValueError) as exc:
        raise _not_found() from exc


@router.patch(
    "/product-library/assets/{asset_id}",
    response_model=AssetResponse,
    summary="Update asset usage and priority",
)
async def update_asset(
    asset_id: str,
    body: AssetBody,
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> dict[str, Any]:
    return _service(server).update_asset(
        user.id, asset_id, usage=body.usage, priority=body.priority, active=body.active
    )


@router.post(
    "/product-library/recognize",
    summary="Recognise image bytes without storing them (local-first clients)",
    description=(
        "Accepts multipart image bytes and returns the vision categorisation "
        "for each image. No bytes are written to disk and no product/asset/description "
        "rows are created — the caller keeps the material and classification locally. "
        "One vision call per distinct SHA-256 within the request."
    ),
)
async def recognize_images(
    files: list[UploadFile] = File(...),
    paths: list[str] = Form(default=[]),
    mode: Literal["categorize", "describe"] = Form(default="categorize"),
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> dict[str, Any]:
    max_bytes = int(
        server.services.config.max_upload_bytes or upload_mb_to_bytes(DEFAULT_MAX_UPLOAD_MB)
    )
    raw_paths = paths if isinstance(paths, list) else []
    payload: list[tuple[str, str, bytes]] = []
    for index, file in enumerate(files):
        filename = Path(file.filename or "upload.bin").name
        raw_path = raw_paths[index].strip() if index < len(raw_paths) else ""
        data = await read_upload_capped(file, max_bytes=max_bytes)
        payload.append((raw_path or filename, file.content_type or "", data))
    return await recognise_uploads(payload, server.services.provider_repo, mode=mode)


class LocalPlanAsset(BaseModel):
    id: str = Field(min_length=1, max_length=128)
    filename: str = Field(min_length=1, max_length=300)
    media_type: str = Field(default="image/jpeg", max_length=100)
    usage: str = Field(default="scene", max_length=32)
    priority: int = 0
    category: str = Field(default="", max_length=100)
    description: str = Field(default="", max_length=2000)
    tags: list[str] = Field(default_factory=list, max_length=12)


class LocalPlanProduct(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    model: str = Field(default="", max_length=200)
    category: str = Field(default="", max_length=100)
    selling_points: list[str] = Field(default_factory=list)


class LocalPlanBody(BaseModel):
    product: LocalPlanProduct
    assets: list[LocalPlanAsset] = Field(default_factory=list, max_length=200)
    request: VideoPlanRequest
    generator: Literal["template", "llm"] = "template"


@router.post(
    "/product-library/plan-local",
    summary="Plan a video from client-side material metadata",
    description=(
        "Builds a validated template or optional AI storyboard from product and "
        "asset metadata. Reads/writes no files and creates "
        "no database rows — for local-first clients that keep their own material."
    ),
)
async def plan_local(body: LocalPlanBody, user: Any = Depends(current_user)) -> dict[str, Any]:
    snapshot = {
        "product": body.product.model_dump(),
        "assets": [a.model_dump() for a in body.assets],
    }
    if body.generator == "llm":
        try:
            return await generate_model_plan(snapshot, body.request)
        except (ValueError, OSError, KeyError, IndexError, TypeError) as exc:
            raise HTTPException(
                status_code=502, detail="Video model unavailable or returned invalid script"
            ) from exc
    return plan_local_video(snapshot, body.request)


class LocalGroupItem(BaseModel):
    id: str = Field(min_length=1, max_length=128)
    filename: str = Field(default="", max_length=300)
    group: str = Field(default="", max_length=200)
    category: str = Field(default="", max_length=100)
    description: str = Field(default="", max_length=4000)
    tags: list[str] = Field(default_factory=list)
    confidence: float = 0.0
    group_source: str = Field(default="vision", max_length=32)


@router.post(
    "/product-library/group-plan",
    summary="Group client-held recognition metadata (no storage, no model)",
    description=(
        "Pure grouping over asset metadata the client already holds. Reuses the "
        "hosted directory-import grouping key so review plans are identical, but "
        "spends no model call, reads/writes no files and creates no database rows."
    ),
)
async def group_plan(
    items: list[LocalGroupItem], user: Any = Depends(current_user)
) -> dict[str, Any]:
    if len(items) > 2000:
        raise HTTPException(status_code=400, detail="too many items")
    return group_local_plan([item.model_dump() for item in items])


@router.post(
    "/product-library/assets/{asset_id}/describe",
    response_model=AssetResponse,
    summary="Generate an LLM content description for one image asset",
)
async def generate_asset_description(
    asset_id: str, user: Any = Depends(current_user), server: Any = Depends(get_server)
) -> dict[str, Any]:
    return await describe_asset_content(
        _service(server),
        server.services.provider_repo,
        owner_id=user.id,
        asset_id=asset_id,
    )


@router.post(
    "/product-library/products/{product_id}/describe-missing",
    response_model=DescribeMissingResponse,
    summary="Generate LLM content descriptions for all undescribed product images",
)
async def generate_missing_descriptions(
    product_id: str, user: Any = Depends(current_user), server: Any = Depends(get_server)
) -> dict[str, Any]:
    return await describe_missing_assets(
        _service(server),
        server.services.provider_repo,
        owner_id=user.id,
        product_id=product_id,
    )


@router.get("/product-library/assets/{asset_id}/download", summary="Download product asset")
async def download_asset(
    asset_id: str, user: Any = Depends(current_user), server: Any = Depends(get_server)
) -> FileResponse:
    row = _service(server).get_asset(user.id, asset_id)
    path = server.services.paths.product_library_dir / row["storage_path"]
    if not await asyncio.to_thread(path.is_file):
        raise _not_found()
    disposition = "inline" if row["media_type"].startswith("image/") else "attachment"
    return FileResponse(
        path,
        media_type=row["media_type"],
        headers={
            "Content-Disposition": content_disposition(row["filename"], disposition=disposition),
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.post(
    "/product-library/projects",
    status_code=201,
    response_model=ProjectResponse,
    summary="Create an immutable video project snapshot",
)
async def create_project(
    body: ProjectBody, user: Any = Depends(current_user), server: Any = Depends(get_server)
) -> dict[str, Any]:
    row = _service(server).create_snapshot(
        owner_id=user.id, product_id=body.product_id, name=body.name, asset_ids=body.asset_ids
    )
    return project_payload(row)


@router.get(
    "/product-library/projects",
    response_model=ProjectItemsResponse,
    summary="List my video projects",
)
async def list_projects(
    user: Any = Depends(current_user), server: Any = Depends(get_server)
) -> dict[str, Any]:
    return {"items": _service(server).list_projects(user.id)}


@router.delete(
    "/product-library/projects/{project_id}",
    status_code=204,
    summary="Delete one of my video projects",
)
async def delete_project(
    project_id: str, user: Any = Depends(current_user), server: Any = Depends(get_server)
) -> None:
    _service(server).delete_project(user.id, project_id)
    # Product assets stay because the snapshot only referenced them; the draft is ours.
    await asyncio.to_thread(delete_draft, server.services.paths.root, user.id, project_id)


@router.post(
    "/product-library/projects/{project_id}/prepare-render",
    response_model=PreparedResponse,
    summary="Prepare snapshot in an owned agent workspace",
)
async def prepare_render(
    project_id: str,
    body: PrepareRenderBody,
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> dict[str, Any]:
    row = _service(server).get_project(user.id, project_id)
    ws = await require_running_workspace(
        body.agent_id, user=user, as_user=None, server=server, owner_only=True
    )
    return await _service(server).prepare_render(project=row, workspace=ws)


@router.post(
    "/product-library/projects/{project_id}/video-plan",
    summary="Preview a validated Remotion plan for an owned product snapshot",
)
async def preview_video_plan(
    project_id: str,
    body: VideoPlanRequest,
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> dict[str, Any]:
    project = _service(server).get_project(user.id, project_id)
    return build_video_plan(project_payload(project)["snapshot"], body)


@router.post(
    "/product-library/projects/{project_id}/planned-package",
    response_class=FileResponse,
    summary="Download a local Studio package using a backend video plan",
)
async def download_planned_package(
    project_id: str,
    body: VideoPlanRequest,
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> FileResponse:
    project = _service(server).get_project(user.id, project_id)
    plan = build_video_plan(project_payload(project)["snapshot"], body)
    package = await asyncio.to_thread(
        export_project_package, server.services.paths, project, script_override=plan["script"]
    )
    return FileResponse(
        package,
        media_type="application/zip",
        filename=f"video-project-{project_id}.zip",
        background=BackgroundTask(package.unlink, missing_ok=True),
        headers={"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"},
    )


class StoryboardDraftBody(BaseModel):
    request: VideoPlanRequest
    script: dict[str, Any]
    confirmed: bool = False
    narration_enabled: bool = False
    narration_voice: str | None = None
    bgm_id: str | None = None
    bgm_enabled: bool = True


@router.post(
    "/product-library/projects/{project_id}/generate-storyboard",
    summary="Generate and persist an AI storyboard for an owned project",
)
async def generate_storyboard(
    project_id: str,
    body: VideoPlanRequest,
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> dict[str, Any]:
    project = _service(server).get_project(user.id, project_id)
    snapshot = project_payload(project)["snapshot"]
    try:
        plan = await generate_model_plan(snapshot, body)
    except (ValueError, OSError, KeyError, IndexError, TypeError) as exc:
        raise HTTPException(
            status_code=502, detail="Video model unavailable or returned invalid script"
        ) from exc
    # Regenerating the picture must not silently drop the audio settings the
    # user already picked: they live beside the script, not inside it.
    previous = await asyncio.to_thread(load_draft, server.services.paths.root, user.id, project_id)
    draft = await asyncio.to_thread(
        save_draft,
        server.services.paths.root,
        user.id,
        project_id,
        snapshot,
        body,
        plan["script"],
        narration_enabled=bool(previous.get("narration_enabled")) if previous else False,
        narration_voice=(previous.get("narration_voice") or None) if previous else None,
        bgm_id=(previous.get("bgm_id") or None) if previous else None,
        bgm_enabled=bool(previous.get("bgm_enabled", True)) if previous else True,
    )
    return {"generator": plan["generator"], "draft": draft}


@router.get(
    "/product-library/projects/{project_id}/storyboard", summary="Read my saved storyboard draft"
)
async def get_storyboard(
    project_id: str,
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> dict[str, Any]:
    _service(server).get_project(user.id, project_id)
    draft = await asyncio.to_thread(load_draft, server.services.paths.root, user.id, project_id)
    if draft is None:
        raise _not_found()
    return draft


@router.put(
    "/product-library/projects/{project_id}/storyboard",
    summary="Edit and validate storyboard, optionally confirm",
)
async def update_storyboard(
    project_id: str,
    body: StoryboardDraftBody,
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> dict[str, Any]:
    project = _service(server).get_project(user.id, project_id)
    try:
        return await asyncio.to_thread(
            save_draft,
            server.services.paths.root,
            user.id,
            project_id,
            project_payload(project)["snapshot"],
            body.request,
            body.script,
            confirmed=body.confirmed,
            narration_enabled=body.narration_enabled,
            narration_voice=resolve_voice_preset(body.narration_voice),
            bgm_id=body.bgm_id,
            bgm_enabled=body.bgm_enabled,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.get(
    "/product-library/projects/{project_id}/storyboard-package",
    response_class=FileResponse,
    summary="Download confirmed storyboard as Studio package",
)
async def download_storyboard_package(
    project_id: str,
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> FileResponse:
    project = _service(server).get_project(user.id, project_id)
    draft = await asyncio.to_thread(load_draft, server.services.paths.root, user.id, project_id)
    if not draft or not draft.get("confirmed"):
        raise HTTPException(status_code=409, detail="Storyboard must be confirmed before export")
    try:
        from octop.infra.product_library.llm_video_planner import validate_script

        script = validate_script(
            draft["script"],
            project_payload(project)["snapshot"],
            VideoPlanRequest.model_validate(draft["request"]),
        )
    except (ValueError, KeyError, TypeError) as exc:
        raise HTTPException(status_code=422, detail="Saved storyboard is invalid") from exc
    # Free tier: the desktop client synthesises the voice locally. Paid tier:
    # the server renders the clips with MiniMax and ships them in the package.
    premium = has_premium_narration(user)
    narration_enabled = bool(draft.get("narration_enabled"))
    voice_id = resolve_voice_preset(draft.get("narration_voice"))
    voice_clips: dict[str, Path] | None = None
    voice_durations: dict[str, float] | None = None
    degraded = False
    if premium and narration_enabled:
        try:
            voice_clips, voice_durations, degraded = await render_narration_clips(
                manager=_voice_manager(server), script=script, voice_id=voice_id
            )
        except OctopError as exc:
            raise HTTPException(status_code=exc.status, detail=exc.message) from exc
    package = await asyncio.to_thread(
        export_project_package,
        server.services.paths,
        project,
        script_override=script,
        narration_enabled=narration_enabled,
        # Without usable clips the desktop client synthesises the voice itself.
        premium=premium and bool(voice_clips),
        voice_id=voice_id,
        bgm_id=draft.get("bgm_id"),
        bgm_enabled=bool(draft.get("bgm_enabled", True)),
        voice_clips=voice_clips,
        voice_durations=voice_durations,
        narration_degraded=degraded,
    )
    return FileResponse(
        package,
        media_type="application/zip",
        filename=f"storyboard-{project_id}.zip",
        background=BackgroundTask(package.unlink, missing_ok=True),
        headers={"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"},
    )
