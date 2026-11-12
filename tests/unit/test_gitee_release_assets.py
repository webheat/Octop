"""tests/unit/test_gitee_release_assets.py"""

from __future__ import annotations

import importlib.util
from pathlib import Path

_SCRIPTS = Path(__file__).resolve().parents[2] / "scripts" / "gitee"


def _load(name: str):
    spec = importlib.util.spec_from_file_location(name, _SCRIPTS / f"{name}.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _asset(name: str, size: int) -> dict:
    return {"name": name, "size": size, "browser_download_url": f"https://example/{name}"}


MB = 1024 * 1024


def test_platform_of_reads_the_name() -> None:
    assets = _load("assets")
    assert assets.platform_of("Octop-desktop-slim-windows-amd64-1.4.0.exe") == "windows"
    assert assets.platform_of("Octop-desktop-darwin-arm64-1.4.0.dmg") == "darwin"
    assert assets.platform_of("Octop-desktop-linux-amd64-1.4.0.tar.gz") == "linux"
    assert assets.platform_of("octop-1.4.0-py3-none-any.whl") is None
    assert assets.platform_of("Octop-fnos-docker-1.4.0.fpk") is None


def test_matches_platform_keeps_the_platform_neutral_assets() -> None:
    assets = _load("assets")
    assert assets.matches_platform("Octop-desktop-windows-amd64-1.4.0.exe", "windows")
    assert not assets.matches_platform("Octop-desktop-darwin-arm64-1.4.0.dmg", "windows")
    assert assets.matches_platform("octop-1.4.0-py3-none-any.whl", "windows")
    assert assets.matches_platform("Octop-desktop-darwin-arm64-1.4.0.dmg", "all")


def test_select_splits_by_size_and_platform() -> None:
    """Gitee carries the remote client and the video components.

    The slim installer runs a local runtime the reader fetches separately and
    the Python packages belong on PyPI — neither is distributed here, and the
    download page does not offer them, so carrying them would leave
    attachments nobody links to.
    """
    assets = _load("assets")
    release_assets = [
        _asset("Octop-desktop-windows-amd64-1.4.0.exe", 6 * MB),
        _asset("Octop-video-components-windows-x64-1.4.0.exe", 72 * MB),
        _asset("Octop-desktop-slim-windows-amd64-1.4.0.exe", 20 * MB),
        _asset("Octop-desktop-slim-darwin-arm64-1.4.0.dmg", 20 * MB),
        _asset("Octop-portable-windows-amd64-1.4.0.zip", 290 * MB),
        _asset("octop-1.4.0-py3-none-any.whl", 22 * MB),
    ]
    small, large = assets.select(release_assets, "windows")
    assert [a["name"] for a in small] == [
        "Octop-desktop-windows-amd64-1.4.0.exe",
        "Octop-video-components-windows-x64-1.4.0.exe",
    ]
    assert [a["name"] for a in large] == ["Octop-portable-windows-amd64-1.4.0.zip"]

    small_all, large_all = assets.select(release_assets, "all")
    assert len(small_all) == 2
    assert len(large_all) == 1


def test_release_notes_point_at_the_github_runtime() -> None:
    """What did not fit stays on the GitHub Release and is linked from there."""
    notes = _load("release_notes")
    release = {
        "body": "Octop 1.4.0",
        "assets": [
            _asset("Octop-portable-windows-amd64-1.4.0.zip", 290 * MB),
            _asset("octop-1.4.0-py3-none-any.whl", 22 * MB),
        ],
    }
    text = notes.build(release, "owner/repo", "v1.4.0", "windows")
    assert "Octop-portable-windows-amd64-1.4.0.zip" in text
    assert "https://github.com/owner/repo/releases/download/v1.4.0" in text
    # Nothing was uploaded to Gitee, so the notes must not claim otherwise.
    assert "以下产物已上传到 Gitee" not in text
    assert "octop-1.4.0-py3-none-any.whl" not in text


def test_release_notes_link_the_components_from_gitee() -> None:
    """组件在 Gitee 上，链接就不能把读者送到 GitHub。"""
    notes = _load("release_notes")
    release = {
        "body": "",
        "assets": [_asset("Octop-video-components-windows-x64-1.4.0.exe", 72 * MB)],
    }
    text = notes.build(release, "owner/repo", "v1.4.0", "windows")
    assert (
        "https://gitee.com/webheat/octop_client/releases/download/v1.4.0/"
        "Octop-video-components-windows-x64-1.4.0.exe"
    ) in text
    assert "github.com" not in text


def test_release_notes_leave_the_other_platforms_out() -> None:
    notes = _load("release_notes")
    release = {
        "body": "",
        "assets": [
            _asset("Octop-desktop-windows-amd64-1.4.0.exe", 6 * MB),
            _asset("Octop-desktop-darwin-arm64-1.4.0.dmg", 6 * MB),
        ],
    }
    text = notes.build(release, "owner/repo", "v1.4.0", "windows")
    assert "Octop-desktop-windows-amd64-1.4.0.exe" in text
    assert "darwin" not in text


def test_release_notes_reduce_to_two_steps_for_the_remote_client() -> None:
    """有远程版时只留两步：装客户端、装视频组件，其余一概不提。"""
    notes = _load("release_notes")
    release = {
        "body": "",
        "assets": [
            _asset("Octop-desktop-windows-amd64-1.4.0.exe", 6 * MB),
            _asset("Octop-desktop-windows-arm64-1.4.0.exe", 6 * MB),
            _asset("Octop-desktop-slim-windows-amd64-1.4.0.exe", 6 * MB),
            _asset("Octop-video-components-windows-x64-1.4.0.exe", 75 * MB),
            _asset("octop-1.4.0-py3-none-any.whl", 21 * MB),
            _asset("Octop-portable-windows-amd64-1.4.0.zip", 213 * MB),
        ],
    }
    text = notes.build(release, "owner/repo", "v1.4.0", "windows")

    assert "### 1. 客户端" in text
    assert "### 2. 视频制作组件" in text
    assert "Windows on ARM" in text

    # 远程版用户不需要的产物一律不出现，避免把清单撑长。
    assert "slim" not in text
    assert ".whl" not in text
    assert ".tar.gz" not in text
    assert "Octop-portable-windows-amd64-1.4.0.zip" not in text
    assert "github.com" not in text

    # 两个客户端都指向 Gitee 自己。
    base = "https://gitee.com/webheat/octop_client/releases/download/v1.4.0"
    assert f"{base}/Octop-desktop-windows-amd64-1.4.0.exe" in text
    assert f"{base}/Octop-desktop-windows-arm64-1.4.0.exe" in text
    assert f"{base}/Octop-video-components-windows-x64-1.4.0.exe" in text
