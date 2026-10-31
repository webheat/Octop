"""Export immutable projects as self-contained local Studio packages."""

from __future__ import annotations

import hashlib
import json
import tempfile
from pathlib import Path
from typing import Any
from zipfile import ZIP_DEFLATED, ZIP_STORED, ZipFile, ZipInfo

from octop.infra.errors import ErrorCode, OctopError
from octop.infra.product_library.audio import (
    build_package_audio,
)
from octop.infra.product_library.service import project_payload, render_script
from octop.infra.utils.paths import PathLayout

TEMPLATE_VERSION = "1"
TEMPLATE_FILES = (
    "package.json",
    "package-lock.json",
    "remotion.config.ts",
    "tsconfig.json",
    "render.mjs",
    "launch.mjs",
    "project.mjs",
    "src/index.ts",
    "src/Root.tsx",
    "src/Video.tsx",
    "src/types.ts",
    "src/scenes/index.tsx",
    "src/scenes/SceneFrame.tsx",
)
LAUNCHERS = ("preview.cmd", "preview.command", "render.cmd", "render.command")
#: Audio travels next to script.json, never inside it: the desktop client
#: verifies the semantic hash of script.json against the confirmed plan.
AUDIO_PLAN_FILE = "audio.json"
PACKAGE_README = """Octop 视频制作包 / Local video package

1. 安装 Node.js 22 或更新版本：https://nodejs.org/
2. 将整个 ZIP 解压到一个文件夹，不要在压缩包内直接运行。
3. Windows 双击 preview.cmd；macOS 双击 preview.command。
4. 首次使用会按锁定版本安装依赖，需要联网。之后在同一文件夹中直接复用。
5. Studio 打开后检查画面，在 Studio 点击 Render 导出 MP4。
   也可运行 render.cmd / render.command，用原始方案导出到 out/final.mp4。
6. macOS 如提示没有执行权限，可在终端运行：chmod +x *.command。

此制作包包含脚本、实际引用的素材和预览程序，不需要 Octop 登录令牌。
无需运行本地业务后端或同步进程。Studio 自身的预览服务只在使用时运行。
保留 renderer、assets、script.json 和 manifest.json 的相对位置。
此版本的脚本由产品资料模板编排；不包含自动 LLM 文档解析。

Install Node.js 22+, extract the whole package, then open preview.cmd (Windows)
or preview.command (macOS). The first launch installs locked dependencies.
Review and render in Studio; render.cmd / render.command exports the original
script to out/final.mp4. No Octop token or separate business backend is needed.
"""


def template_root() -> Path:
    """Use packaged wheel resources, or the canonical source checkout."""
    packaged = Path(__file__).parent / "render_template"
    if packaged.is_dir():
        return packaged
    checkout = Path(__file__).resolve().parents[4] / "remotion"
    if checkout.is_dir():
        return checkout
    raise OctopError.localized(ErrorCode.INTERNAL_ERROR)


def file_sha256(path: Path) -> str:
    checksum = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            checksum.update(chunk)
    return checksum.hexdigest()


def _write_text(archive: ZipFile, name: str, content: bytes, *, executable: bool = False) -> None:
    info = ZipInfo(name)
    info.create_system = 3
    info.external_attr = (0o100755 if executable else 0o100644) << 16
    info.compress_type = ZIP_DEFLATED
    archive.writestr(info, content)


def export_project_package(
    paths: PathLayout,
    project: dict[str, Any],
    *,
    script_override: dict[str, Any] | None = None,
    narration_enabled: bool = False,
    premium: bool = False,
    voice_id: str | None = None,
    bgm_id: str | None = None,
    bgm_enabled: bool = True,
    voice_clips: dict[str, Path] | None = None,
    voice_durations: dict[str, float] | None = None,
    narration_degraded: bool = False,
) -> Path:
    """Return a temporary ZIP; the HTTP adapter removes it after transmission."""
    snapshot = project_payload(project)["snapshot"]
    script, assets = render_script(snapshot)
    if script_override is not None:
        # The planner returns only existing snapshot asset references. Keep the
        # canonical export asset list and reject foreign filenames at this boundary.
        known = {asset["export_name"] for asset in assets}
        if not isinstance(script_override.get("scenes"), list) or not script_override["scenes"]:
            raise OctopError.localized(ErrorCode.SLASH_BAD_ARGS)
        for scene in script_override["scenes"]:
            if not isinstance(scene, dict) or (scene.get("asset") and scene["asset"] not in known):
                raise OctopError.localized(ErrorCode.SLASH_BAD_ARGS)
        script = script_override
    root = paths.product_library_dir.resolve()
    sources: list[tuple[str, Path]] = []
    manifest_assets: list[dict[str, Any]] = []
    for asset in assets:
        source = (root / asset["storage_path"]).resolve()
        if not source.is_relative_to(root) or not source.is_file():
            raise OctopError.localized(ErrorCode.NOT_FOUND)
        if file_sha256(source) != asset["content_hash"]:
            raise OctopError.localized(ErrorCode.NOT_FOUND)
        archive_path = f"assets/{asset['export_name']}"
        sources.append((archive_path, source))
        manifest_assets.append(
            {"path": archive_path, "sha256": asset["content_hash"], "bytes": source.stat().st_size}
        )

    # Audio lives beside script.json so the picture script keeps the exact
    # bytes the user confirmed; the client verifies that hash separately.
    audio = build_package_audio(
        paths.bgm_library_dir,
        script,
        narration_enabled=narration_enabled,
        premium=premium,
        voice_id=voice_id,
        bgm_id=bgm_id,
        bgm_enabled=bgm_enabled,
        voice_clips=voice_clips,
        voice_durations=voice_durations,
        degraded=narration_degraded,
    )
    if audio is not None:
        for name, source in audio.files:
            resolved = source.resolve()
            if not resolved.is_file():
                raise OctopError.localized(ErrorCode.NOT_FOUND)
            archive_path = f"assets/{name}"
            if any(entry[0] == archive_path for entry in sources):
                continue
            sources.append((archive_path, resolved))
            manifest_assets.append(
                {
                    "path": archive_path,
                    "sha256": file_sha256(resolved),
                    "bytes": resolved.stat().st_size,
                }
            )

    renderer = template_root()
    for filename in (*TEMPLATE_FILES, *(f"launchers/{name}" for name in LAUNCHERS)):
        if not (renderer / filename).is_file():
            raise OctopError.localized(ErrorCode.INTERNAL_ERROR)

    script_bytes = json.dumps(script, ensure_ascii=False, indent=2).encode("utf-8")
    manifest = {
        "schema": "octop-remotion-package/1",
        "template_version": TEMPLATE_VERSION,
        "project_id": project["id"],
        "project_name": project["name"],
        "script_sha256": hashlib.sha256(script_bytes).hexdigest(),
        "assets": manifest_assets,
    }
    with tempfile.NamedTemporaryFile(prefix="octop-video-", suffix=".zip", delete=False) as target:
        output = Path(target.name)
    try:
        with ZipFile(output, "w", allowZip64=True) as archive:
            archive.writestr("assets/", b"")
            _write_text(archive, "script.json", script_bytes)
            if audio is not None:
                _write_text(
                    archive,
                    AUDIO_PLAN_FILE,
                    json.dumps(audio.plan, ensure_ascii=False, indent=2).encode(),
                )
            _write_text(
                archive,
                "manifest.json",
                json.dumps(manifest, ensure_ascii=False, indent=2).encode(),
            )
            _write_text(archive, "README.txt", PACKAGE_README.encode("utf-8"))
            # Reference documents are intentionally not shipped as playable scene assets.
            for archive_path, source in sources:
                archive.write(source, archive_path, compress_type=ZIP_STORED)
            for filename in TEMPLATE_FILES:
                _write_text(archive, f"renderer/{filename}", (renderer / filename).read_bytes())
            for filename in LAUNCHERS:
                _write_text(
                    archive,
                    filename,
                    (renderer / "launchers" / filename).read_bytes(),
                    executable=filename.endswith(".command"),
                )
        return output
    except BaseException:
        output.unlink(missing_ok=True)
        raise
