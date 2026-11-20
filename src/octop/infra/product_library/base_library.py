"""Curated base image library: local quality gate, quarantine, and video handoff.

Uploaded images are screened by PIL + numpy only — no model call. Clean images
land in ``product-library/<uid>/base-library/`` and are indexed in SQLite;
corrupt, low-quality and near-duplicate images are moved to
``product-library/<uid>/quarantine/<reason>/`` for one-shot cleanup. The whole
quarantine tree can be deleted without touching good images.

This is deliberately separate from the directory-import AI grouping flow: it
builds the reusable, high-quality source pool from which product videos can be
generated in bulk later.
"""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any

from octop.infra.db.repos.product_library import ProductLibraryRepo
from octop.infra.product_library.image_quality import (
    ImageQuality,
    inspect_image,
    is_duplicate,
)
from octop.infra.product_library.video_planner import VideoPlanRequest, build_video_plan
from octop.infra.utils.paths import PathLayout
from octop.infra.utils.ulid import new_ulid

_QUARANTINE_REASONS = frozenset({"corrupt", "low_quality", "duplicate"})
_BASE_DIR = "base-library"
_QUARANTINE_DIR = "quarantine"


def _safe_name(filename: str) -> str:
    return Path(filename.replace("\\", "/")).name or "upload.bin"


def _reason_subdir(quality: ImageQuality) -> str:
    return quality.verdict()


class BaseLibraryService:
    def __init__(self, paths: PathLayout, repo: ProductLibraryRepo) -> None:
        self.paths = paths
        self.repo = repo

    def _owner_dir(self, owner_id: int, kind: str, reason: str = "") -> Path:
        root = self.paths.product_library_dir / str(owner_id) / kind
        return root / reason if reason else root

    def ingest(self, owner_id: int, files: list[tuple[str, str, bytes]]) -> dict[str, Any]:
        """Screen a batch locally and index it. No remote model is called."""
        ready: list[dict[str, Any]] = []
        isolated: list[dict[str, Any]] = []
        seen: list[tuple[str, ImageQuality]] = []
        # Load the existing library once; a large batch should not re-query per file.
        existing = [
            (row["image_id"], ImageQuality(phash=row["phash"], dhash=row["dhash"]))
            for row in self.repo.list_ready_hashes(owner_id)
        ]

        for filename, media_type, data in files:
            safe_name = _safe_name(filename)
            quality = inspect_image(data)
            content_hash = hashlib.sha256(data).hexdigest()
            reason = _reason_subdir(quality)
            duplicate_of = ""
            if not quality.corrupt and not quality.defects:
                for prior_id, prior_quality in [*existing, *seen]:
                    if is_duplicate(quality, prior_quality):
                        reason = "duplicate"
                        duplicate_of = prior_id
                        break

            image_id = new_ulid()
            if reason in _QUARANTINE_REASONS:
                target_dir = self._owner_dir(owner_id, _QUARANTINE_DIR, reason)
                storage_path = (
                    Path(str(owner_id)) / _QUARANTINE_DIR / reason / f"{image_id}-{safe_name}"
                )
            else:
                target_dir = self._owner_dir(owner_id, _BASE_DIR)
                storage_path = Path(str(owner_id)) / _BASE_DIR / f"{image_id}-{safe_name}"

            target_dir.mkdir(parents=True, exist_ok=True)
            (self.paths.product_library_dir / storage_path).write_bytes(data)

            fields = {
                "filename": safe_name,
                "media_type": media_type or "application/octet-stream",
                "byte_size": len(data),
                "content_hash": content_hash,
                "phash": quality.phash,
                "dhash": quality.dhash,
                "width": quality.width,
                "height": quality.height,
                "blur_score": quality.blur_score,
                "brightness": quality.brightness,
                "flatness": quality.flatness,
                "quality_score": quality.quality_score,
                "dominant_colors": list(quality.dominant_colors),
                "storage_path": storage_path.as_posix(),
                "status": "ready" if reason not in _QUARANTINE_REASONS else "quarantined",
                "reason": reason,
            }
            row = self.repo.add_base_image(owner_id, image_id=image_id, fields=fields)
            entry = {**row, "image_id": image_id, "defects": list(quality.defects)}
            if duplicate_of:
                entry["duplicate_of"] = duplicate_of
            if quality.corrupt:
                entry["corrupt_reason"] = quality.corrupt_reason
            if fields["status"] == "ready":
                ready.append(entry)
                seen.append((image_id, quality))
            else:
                isolated.append(entry)

        return {
            "total": len(files),
            "ready": ready,
            "isolated": isolated,
            "ready_count": len(ready),
            "isolated_count": len(isolated),
        }

    def list_images(self, owner_id: int, *, status: str | None = None) -> list[dict[str, Any]]:
        return self.repo.list_base_images(owner_id, status=status)

    def restore(self, owner_id: int, image_id: str) -> dict[str, Any] | None:
        """Approve an isolated image and move it into the ready library."""
        row = self.repo.get_base_image(owner_id, image_id)
        if row is None or row["status"] != "quarantined":
            return None
        source = self.paths.product_library_dir / row["storage_path"]
        if not source.is_file():
            return None
        target_dir = self._owner_dir(owner_id, _BASE_DIR)
        target_dir.mkdir(parents=True, exist_ok=True)
        target = target_dir / source.name
        source.replace(target)
        relative = target.relative_to(self.paths.product_library_dir).as_posix()
        self.repo.update_base_image(
            owner_id, image_id, status="ready", reason="", storage_path=relative
        )
        return self.repo.get_base_image(owner_id, image_id)

    def purge(self, owner_id: int, *, reason: str | None = None) -> dict[str, Any]:
        """Delete isolated files and their SQLite rows. Ready images are untouched."""
        rows = self.repo.list_base_images(owner_id, status="quarantined")
        removed = 0
        for row in rows:
            if reason and row["reason"] != reason:
                continue
            path = self.paths.product_library_dir / row["storage_path"]
            path.unlink(missing_ok=True)
            self.repo.delete_base_image(owner_id, row["image_id"])
            removed += 1
        return {"removed": removed}

    def plan_from_base_images(
        self,
        owner_id: int,
        image_ids: list[str],
        request: VideoPlanRequest,
        *,
        product_name: str = "",
    ) -> dict[str, Any] | None:
        """Build a video plan directly from curated base images.

        Produces the same snapshot contract as a product snapshot, so the
        existing render / draft pipeline can consume it without changes.
        """
        rows = [self.repo.get_base_image(owner_id, image_id) for image_id in image_ids]
        if not rows or any(row is None or row["status"] != "ready" for row in rows):
            return None
        ready_rows = [row for row in rows if row is not None]
        assets = [
            {
                "id": row["image_id"],
                "filename": row["filename"],
                "media_type": row["media_type"],
                "content_hash": row["content_hash"],
                "storage_path": row["storage_path"],
                "usage": "scene",
                "priority": index == 0,
                "active": 1,
            }
            for index, row in enumerate(ready_rows)
        ]
        snapshot = {
            "product": {
                "name": product_name or "基础图库",
                "model": "",
                "selling_points": [],
                "parameters": {},
                "expression_limits": "",
            },
            "assets": assets,
        }
        return build_video_plan(snapshot, request)


def export_base_manifest(owner_id: int, images: list[dict[str, Any]]) -> dict[str, Any]:
    """Small portable manifest describing the curated image set (paths + hashes)."""
    return {
        "owner_user_id": owner_id,
        "count": len(images),
        "images": [
            {
                "image_id": image["image_id"],
                "filename": image["filename"],
                "storage_path": image["storage_path"],
                "content_hash": image["content_hash"],
                "quality_score": image["quality_score"],
            }
            for image in images
        ],
    }
