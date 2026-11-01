"""Small owner-scoped persistent video storyboard draft store.

Drafts live in OCTOP_HOME/product-library/video-drafts and are not source snapshots.
Production database-backed drafts may replace this implementation later.
"""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Any

from octop.infra.product_library.llm_video_planner import validate_script
from octop.infra.product_library.video_planner import VideoPlanRequest


def draft_path(home: Path, owner_id: int, project_id: str) -> Path:
    if not project_id.isalnum() or len(project_id) > 80:
        raise ValueError("invalid project id")
    return home / "product-library" / "video-drafts" / str(owner_id) / (project_id + ".json")


def save_draft(
    home: Path,
    owner_id: int,
    project_id: str,
    snapshot: dict[str, Any],
    request: VideoPlanRequest,
    script: dict[str, Any],
    *,
    confirmed: bool = False,
    narration_enabled: bool = False,
    narration_voice: str | None = None,
    bgm_id: str | None = None,
    bgm_enabled: bool = True,
) -> dict[str, Any]:
    validated = validate_script(script, snapshot, request)
    record = {
        "project_id": project_id,
        "request": request.model_dump(),
        "script": validated,
        "confirmed": confirmed,
        "narration_enabled": bool(narration_enabled),
        "narration_voice": narration_voice or "",
        "bgm_id": bgm_id or "",
        "bgm_enabled": bool(bgm_enabled),
    }
    path = draft_path(home, owner_id, project_id)
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(prefix=".draft-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(record, f, ensure_ascii=False)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(temp, 0o600)
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)
    return record


def load_draft(home: Path, owner_id: int, project_id: str) -> dict[str, Any] | None:
    path = draft_path(home, owner_id, project_id)
    try:
        with path.open(encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        return None
    if not isinstance(data, dict) or data.get("project_id") != project_id:
        raise ValueError("invalid persisted draft")
    return data


def delete_draft(home: Path, owner_id: int, project_id: str) -> None:
    """Drop the storyboard draft of a removed project; missing drafts are fine."""
    draft_path(home, owner_id, project_id).unlink(missing_ok=True)
