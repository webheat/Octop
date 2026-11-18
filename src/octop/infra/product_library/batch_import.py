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
    MAX_IMAGE_BYTES,
    categorise_image,
    resolve_vision_model,
)
from octop.infra.utils.paths import PathLayout
from octop.infra.utils.ulid import new_ulid

# Only raster images can be categorised; other files are reported as skipped.
_IMAGE_EXTENSIONS = frozenset({".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".avif"})
_DEFAULT_CONCURRENCY = 3


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

    ``files`` is a list of ``(filename, media_type, data)`` tuples. Images over
    the vision size limit or with unsupported bytes are reported in ``failed``
    / ``skipped`` rather than aborting the batch. No product or asset rows are
    written; the raw bytes and their metadata are kept in a temporary job dir.
    """
    job_id = new_ulid()
    job_dir = _job_dir(service.paths, owner_id, job_id)
    job_dir.mkdir(parents=True, exist_ok=True)

    items: list[dict[str, Any]] = []
    skipped: list[dict[str, str]] = []
    pending: list[dict[str, Any]] = []  # manifest rows that need a vision call

    for filename, media_type, data in files:
        safe_name = Path(filename.replace("\\", "/")).name or "upload.bin"
        extension = Path(safe_name).suffix.lower()
        if extension not in _IMAGE_EXTENSIONS:
            skipped.append({"filename": safe_name, "reason": "unsupported type"})
            continue
        content_hash = hashlib.sha256(data).hexdigest()
        storage_name = f"{len(items)}-{safe_name}"
        (job_dir / storage_name).write_bytes(data)
        row: dict[str, Any] = {
            "index": len(items),
            "filename": safe_name,
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
            row["result"] = {
                "group": "",
                "category": "",
                "description": cached.get("description", ""),
                "tags": json.loads(cached.get("tags") or "[]"),
                "confidence": 0.0,
                "reused": True,
            }
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
                )
            except Exception as exc:  # noqa: BLE001 - one bad image must not fail the batch
                row["setup_error"] = str(exc)[:MAX_ERROR_CHARS]
                return
            result["reused"] = False
            row["result"] = result

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
        {"filename": row["filename"], "reason": row["setup_error"]}
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
                "suggested_name": result["group"] or "",
                "category": result["category"] or "",
                "items": [],
            },
        )
        bucket["items"].append(
            {
                "index": row["index"],
                "filename": row["filename"],
                "confidence": result["confidence"],
                "description": result["description"],
                "tags": result["tags"],
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
            name = str(group.get("name") or "").strip()
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
