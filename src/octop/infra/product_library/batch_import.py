"""Directory-image batch import: categorise, group and archive into products.

Two-phase, mirroring the dashboard wizard:

* ``analyse_upload`` stores the uploaded bytes in a per-owner temporary job
  directory, runs one bounded vision call per distinct image, groups the
  results and returns a dry-run plan. It writes **no** product/asset rows.
* ``commit_import`` reads the job back and, using the user-reviewed group
  plan, creates or reuses products, stores assets, and persists the vision
  descriptions. Every read/write is scoped to ``owner_id``.

There is no queue in Octop; job state lives in small JSON manifests on disk
under ``product-library/<uid>/imports/<job_id>/`` and is included in backups.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
import unicodedata
from pathlib import Path
from typing import Any, cast

from octop.infra.product_library.service import (
    ProductLibraryService,
    validate_asset,
)
from octop.infra.product_library.vision import (
    MAX_ERROR_CHARS,
    MAX_GROUP_CHARS,
    MAX_IMAGE_BYTES,
    categorise_image,
    is_placeholder_group,
    resolve_vision_model,
)
from octop.infra.utils.paths import PathLayout
from octop.infra.utils.ulid import new_ulid

# Only raster images can be categorised; other files are reported as skipped.
_IMAGE_EXTENSIONS = frozenset({".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".avif"})
_DEFAULT_CONCURRENCY = 3
# Relative-path metadata is display/grouping only: bound it so a hostile or
# merely absurd client path cannot bloat the manifest.
MAX_PATH_PARTS = 8
MAX_PATH_CHARS = 400
# A folder name is a weak prior: only used when vision is unsure of itself.
FOLDER_PRIOR_MIN_CONFIDENCE = 0.5
FOLDER_PRIOR_CONFIDENCE = 0.6


def _norm(text: str) -> str:
    """Normalise a grouping key: NFKC, lowercase, drop all whitespace.

    The key is only used for grouping and is never displayed, so removing every
    whitespace character makes "登 山 包", "登山包" and "Hiking  Pack" collapse
    consistently. The human-facing suggested_name keeps the original text.
    """
    return re.sub(r"\s+", "", unicodedata.normalize("NFKC", text).lower())


def group_key(group: str, category: str) -> str:
    """Stable key for images the model says belong to the same product."""
    return f"{_norm(category)}::{_norm(group)}"


def sanitize_relative_path(raw: str, fallback: str = "upload.bin") -> str:
    """Turn a client-supplied path into a safe, display-only relative path.

    Never used to build a filesystem path: callers keep using the
    index-prefixed flat storage name. This value is metadata for grouping, so
    traversal components are dropped rather than rejected.
    """
    text = (raw or "").replace("\\", "/").strip()
    # Drop Windows drive letters and any leading slashes.
    text = re.sub(r"^[A-Za-z]:", "", text).lstrip("/")
    parts = [part.strip() for part in text.split("/") if part not in ("", ".", "..")]
    parts = [part for part in parts if part]
    if not parts:
        return fallback
    rel = "/".join(parts[-MAX_PATH_PARTS:])  # keep the most specific tail
    return rel[:MAX_PATH_CHARS] or fallback


def folder_of(rel_path: str) -> str:
    """Top-level directory name of a relative path; "" for a bare filename."""
    parts = [part for part in (rel_path or "").split("/") if part]
    return parts[0] if len(parts) > 1 else ""


def _apply_folder_prior(result: dict[str, Any], folder: str) -> dict[str, Any]:
    """Fall back to the source folder name when vision is not confident.

    A folder name is cheap but noisy (``新建文件夹``, ``IMG_0002``), so it only
    wins when the model returned no group or scored below the threshold. A
    confident model answer is never overridden.
    """
    hint = (folder or "").strip()
    current = str(result.get("group") or "").strip()
    if is_placeholder_group(current):
        # A placeholder label names nothing; treat it as no answer at all so
        # the folder prior (or the category) can supply a real label.
        current = ""
        result["group"] = ""
    if not hint:
        result["group_source"] = "vision"
        return result
    confidence = float(result.get("confidence") or 0.0)
    if not current or confidence < FOLDER_PRIOR_MIN_CONFIDENCE:
        result["group"] = hint[:MAX_GROUP_CHARS]
        result["confidence"] = max(confidence, FOLDER_PRIOR_CONFIDENCE)
        result["group_source"] = "folder"
    else:
        result["group_source"] = "vision"
    return result


def _resolve_product_name(
    group: dict[str, Any],
    rows: dict[int, dict[str, Any]],
    excluded: set[int],
) -> str:
    """Product name for a reviewed group.

    The label the user typed wins. A placeholder label ("candidates") carries no
    identity, so it falls back to the folder the images came from; a group
    without either cannot be filed.
    """
    name = str(group.get("name") or "").strip()
    if name and not is_placeholder_group(name):
        return name
    for index in group.get("item_indices", []):
        if index in excluded:
            continue
        row = rows.get(index)
        if row is None:
            continue
        folder = str(row.get("folder") or "").strip()
        if folder and not is_placeholder_group(folder):
            return folder
    return ""


def _job_dir(paths: PathLayout, owner_id: int, job_id: str) -> Path:
    # job_id is a ULID minted by us, but re-validate it before using as a path.
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", job_id):
        raise ValueError("invalid job id")
    return paths.product_library_dir / str(owner_id) / "imports" / job_id


def _write_manifest(job_dir: Path, manifest: dict[str, Any]) -> None:
    job_dir.mkdir(parents=True, exist_ok=True)
    (job_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def _read_manifest(job_dir: Path, owner_id: int) -> dict[str, Any]:
    path = job_dir / "manifest.json"
    if not path.is_file():
        raise FileNotFoundError("import job not found")
    manifest = cast(dict[str, Any], json.loads(path.read_text(encoding="utf-8")))
    if manifest.get("owner_user_id") != owner_id:
        # Ownership mismatch is indistinguishable from "not found" to the caller.
        raise PermissionError("import job does not belong to this user")
    return manifest


async def analyse_upload(
    service: ProductLibraryService,
    provider_repo: Any,
    *,
    owner_id: int,
    files: list[tuple[str, str, bytes]],
    concurrency: int = _DEFAULT_CONCURRENCY,
) -> dict[str, Any]:
    """Categorise an uploaded batch and return a dry-run grouping plan.

    ``files`` is a list of ``(relative_path, media_type, data)`` tuples. The
    first element is the client-supplied relative path (e.g.
    ``hiking-bag/front/01.jpg``); its basename names the stored blob and its
    top-level folder is kept as a grouping prior. Images over the vision size
    limit or with unsupported bytes are reported in ``failed`` / ``skipped``
    rather than aborting the batch. No product or asset rows are written; the
    raw bytes and their metadata are kept in a temporary job dir.
    """
    job_id = new_ulid()
    job_dir = _job_dir(service.paths, owner_id, job_id)
    job_dir.mkdir(parents=True, exist_ok=True)

    items: list[dict[str, Any]] = []
    skipped: list[dict[str, str]] = []
    pending: list[dict[str, Any]] = []  # manifest rows that need a vision call

    for filename, media_type, data in files:
        rel_path = sanitize_relative_path(filename)
        safe_name = Path(rel_path).name or "upload.bin"
        extension = Path(safe_name).suffix.lower()
        if extension not in _IMAGE_EXTENSIONS:
            skipped.append(
                {"filename": safe_name, "relative_path": rel_path, "reason": "unsupported type"}
            )
            continue
        content_hash = hashlib.sha256(data).hexdigest()
        # Disk layout stays flat: the index prefix already prevents collisions,
        # and relative_path is metadata only.
        storage_name = f"{len(items)}-{safe_name}"
        (job_dir / storage_name).write_bytes(data)
        row: dict[str, Any] = {
            "index": len(items),
            "filename": safe_name,
            "relative_path": rel_path,
            "folder": folder_of(rel_path),
            "media_type": media_type or "image/jpeg",
            "content_hash": content_hash,
            "storage_name": storage_name,
            "byte_size": len(data),
        }
        items.append(row)
        if len(data) > MAX_IMAGE_BYTES or not data:
            row["setup_error"] = "image exceeds the vision size limit or is empty"
        else:
            pending.append(row)

    # Resolve the vision model once for the whole batch. A missing model is a
    # per-image failure, not a whole-request error, so keep the setup error.
    model_pair: tuple[Any, str] | None = None
    setup_error = ""
    try:
        model_pair = await asyncio.to_thread(resolve_vision_model, provider_repo)
    except Exception as exc:  # noqa: BLE001 - never fail the batch
        setup_error = str(exc)[:MAX_ERROR_CHARS]

    model_ref = model_pair[1] if model_pair else ""
    semaphore = asyncio.Semaphore(max(1, concurrency))

    # Pre-dedupe: only the first row for a given content_hash spends a model
    # call; the rest are back-filled from that result after the batch finishes.
    # Doing this before the concurrent gather avoids a race where two identical
    # rows both miss the cache and both call the model.
    representatives: dict[str, dict[str, Any]] = {}
    followers: dict[str, list[dict[str, Any]]] = {}
    for row in pending:
        digest = row["content_hash"]
        if digest in representatives:
            followers.setdefault(digest, []).append(row)
        else:
            representatives[digest] = row

    async def categorise(row: dict[str, Any]) -> None:
        content_hash = row["content_hash"]
        cached = await asyncio.to_thread(
            service.repo.find_ready_description_by_hash, owner_id, content_hash
        )
        if cached is not None:
            # A ready description proves the bytes were described before, but it
            # has no grouping hint. Reuse description/tags; group stays empty so
            # the user files it manually. Cheaper than another vision call.
            row["result"] = _apply_folder_prior(
                {
                    "group": "",
                    "category": "",
                    "description": cached.get("description", ""),
                    "tags": json.loads(cached.get("tags") or "[]"),
                    "confidence": 0.0,
                    "reused": True,
                },
                row.get("folder", ""),
            )
            return
        if setup_error or model_pair is None:
            row["setup_error"] = setup_error or "no vision model configured"
            return
        async with semaphore:
            try:
                data = (job_dir / row["storage_name"]).read_bytes()
                result = await asyncio.to_thread(
                    categorise_image,
                    data,
                    row["media_type"],
                    model_pair[0],
                    row.get("folder", ""),
                )
            except Exception as exc:  # noqa: BLE001 - one bad image must not fail the batch
                row["setup_error"] = str(exc)[:MAX_ERROR_CHARS]
                return
            result["reused"] = False
            row["result"] = _apply_folder_prior(result, row.get("folder", ""))

    await asyncio.gather(*(categorise(row) for row in representatives.values()))

    # Back-fill duplicate rows with their representative's outcome (or failure).
    for digest, dup_rows in followers.items():
        representative = representatives[digest]
        for dup in dup_rows:
            if "result" in representative:
                dup["result"] = dict(representative["result"])
                dup["result"]["duplicate"] = True
            elif "setup_error" in representative:
                dup["setup_error"] = representative["setup_error"]

    manifest = {
        "job_id": job_id,
        "owner_user_id": owner_id,
        "items": items,
        "model": model_ref,
    }
    _write_manifest(job_dir, manifest)

    failed = [
        {
            "filename": row["filename"],
            "relative_path": row["relative_path"],
            "reason": row["setup_error"],
        }
        for row in items
        if row.get("setup_error")
    ]

    # Assemble grouped plan from rows that produced a usable result.
    grouped: dict[str, dict[str, Any]] = {}
    for row in items:
        result = cast(dict[str, Any] | None, row.get("result"))
        if not result:
            continue
        key = group_key(result["group"], result["category"])
        bucket = grouped.setdefault(
            key,
            {
                "key": key,
                # The model's group label, else its category — never blank, so the
                # wizard always offers a label the user can edit.
                "suggested_name": result["group"] or result["category"] or "",
                "category": result["category"] or "",
                "items": [],
            },
        )
        bucket["items"].append(
            {
                "index": row["index"],
                "filename": row["filename"],
                "relative_path": row["relative_path"],
                "folder": row["folder"],
                "confidence": result["confidence"],
                "description": result["description"],
                "tags": result["tags"],
                "group_source": result.get("group_source", "vision"),
                "duplicate": bool(result.get("reused")),
            }
        )

    return {
        "job_id": job_id,
        "groups": list(grouped.values()),
        "skipped": skipped,
        "failed": failed,
        "total": len(items),
    }


def commit_import(
    service: ProductLibraryService,
    *,
    owner_id: int,
    job_id: str,
    groups: list[dict[str, Any]],
    exclude_indices: list[int],
) -> dict[str, Any]:
    """Archive the reviewed grouping plan into products and assets.

    Each group either reuses an owned ``product_id`` or creates a new product.
    ``item_indices`` refer to the manifest rows returned by ``analyse_upload``.
    Vision descriptions are persisted through the existing description table so
    imported images behave exactly like manually described ones.
    """
    job_dir = _job_dir(service.paths, owner_id, job_id)
    manifest = _read_manifest(job_dir, owner_id)
    rows = {row["index"]: row for row in manifest["items"]}
    model_ref = manifest.get("model", "")
    excluded = set(exclude_indices)

    created = 0
    reused_products = 0
    imported = 0
    duplicates = 0
    failures: list[dict[str, str]] = []

    for group in groups:
        product_id = group.get("product_id") or ""
        if product_id:
            if service.repo.get_product(owner_id, product_id) is None:
                raise PermissionError("product does not belong to this user")
            reused_products += 1
        else:
            name = _resolve_product_name(group, rows, excluded)
            if not name:
                # A group with no name and no target product cannot be filed.
                failures.append({"filename": "(group)", "reason": "missing product name"})
                continue
            product = service.create_product(
                owner_id,
                {
                    "name": name[:200],
                    "model": "",
                    "category": str(group.get("category") or "")[:100],
                    "selling_points": [],
                    "parameters": {},
                    "expression_limits": "",
                },
            )
            product_id = product["id"]
            created += 1

        for index in group.get("item_indices", []):
            if index in excluded:
                continue
            row = rows.get(index)
            if row is None:
                failures.append({"filename": f"#{index}", "reason": "unknown item index"})
                continue
            path = job_dir / row["storage_name"]
            if not path.is_file():
                failures.append({"filename": row["filename"], "reason": "import file missing"})
                continue
            data = path.read_bytes()
            try:
                safe_name, safe_type = validate_asset(row["filename"], row["media_type"], "scene")
            except Exception as exc:  # noqa: BLE001 - report, keep the batch going
                failures.append({"filename": row["filename"], "reason": str(exc)[:MAX_ERROR_CHARS]})
                continue
            # Detect a pre-existing copy before store_asset (which dedupes by
            # hash and would otherwise return the old row indistinguishably).
            already = service.repo.find_asset_by_hash(
                owner_id, product_id, hashlib.sha256(data).hexdigest()
            )
            asset = service.store_asset(
                owner_id=owner_id,
                product_id=product_id,
                filename=safe_name,
                media_type=safe_type,
                data=data,
                usage="scene",
            )
            if already is not None:
                duplicates += 1
            else:
                imported += 1

            result = row.get("result") or {}
            if result.get("description"):
                service.repo.save_description(
                    owner_id,
                    asset["id"],
                    content_hash=asset["content_hash"],
                    description=result["description"],
                    tags=result.get("tags") or [],
                    status="ready",
                    model=model_ref,
                )

    # Clean up only after a successful commit so a failed run can be retried.
    _remove_job_dir(job_dir)
    return {
        "created_products": created,
        "reused_products": reused_products,
        "imported_assets": imported,
        "skipped_duplicates": duplicates,
        "failed": failures,
    }


def _remove_job_dir(job_dir: Path) -> None:
    import shutil

    shutil.rmtree(job_dir, ignore_errors=True)
