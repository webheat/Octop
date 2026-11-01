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
from octop.infra.product_library.llm_video_planner import generate_model_plan
from octop.infra.product_library.narration import (
    PAID_VOICE_PRESETS,
    has_premium_narration,
    render_narration_clips,
    resolve_voice_preset,
)
from octop.infra.product_library.package_export import export_project_package
from octop.infra.product_library.service import (
    ProductLibraryService,
    project_payload,
)
from octop.infra.product_library.video_drafts import delete_draft, load_draft, save_draft
from octop.infra.product_library.video_planner import VideoPlanRequest, build_video_plan
from octop.infra.voice.manager import VoiceManager

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
