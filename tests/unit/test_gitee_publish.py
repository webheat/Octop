"""The Gitee publish path, exercised end to end against a mock Gitee API.

This path had never run in CI, so its failure modes were invisible: a
progress line landing in stdout poisoned the release's ``target_commitish``,
a download page still pointing at the previous release was published
silently, and a rejected token surfaced as "release not found".

``GITEE_API_BASE`` already makes the scripts talk to a configurable base, so
pointing them at :mod:`tests.support.gitee_mock` drives the real scripts the
way a release does.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path

import pytest

from tests.support.bash import resolve_bash
from tests.support.gitee_mock import GiteeMock

REPO_ROOT = Path(__file__).resolve().parents[2]
GITEE_DIR = REPO_ROOT / "scripts" / "gitee"
PUSH_README = GITEE_DIR / "push_readme.py"
PUBLISH_RELEASE = GITEE_DIR / "publish_release.sh"

TAG = "v1.5.0-gitee.1"
OWNER = "webheat"
REPO = "octop_client"

bash = resolve_bash()
needs_bash = pytest.mark.skipif(bash is None, reason="needs a bash that can open a Windows path")


@pytest.fixture
def python3_shim(tmp_path: Path) -> Path:
    """A ``python3`` on PATH that is the interpreter running this test."""
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    shim = bin_dir / "python3"
    shim.write_text(f'#!/bin/sh\nexec "{sys.executable}" "$@"\n', encoding="utf-8")
    shim.chmod(0o755)
    return bin_dir


@pytest.fixture
def gitee() -> GiteeMock:
    with GiteeMock() as mock:
        yield mock


def _env(mock: GiteeMock, shim: Path) -> dict[str, str]:
    env = dict(os.environ)
    env["GITEE_API_BASE"] = mock.api_base
    env["GITEE_TOKEN"] = "test-token"
    env["PATH"] = f"{shim}{os.pathsep}{env.get('PATH', '')}"
    return env


def _push_readme(
    mock: GiteeMock, shim: Path, tmp_path: Path, tag: str = TAG, template_dir: Path | None = None
) -> subprocess.CompletedProcess[str]:
    args = [
        sys.executable,
        str(PUSH_README),
        "--owner",
        OWNER,
        "--repo",
        REPO,
        "--tag",
        tag,
    ]
    if template_dir is not None:
        args += ["--dir", str(template_dir)]
    return subprocess.run(
        args,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=_env(mock, shim),
        timeout=120,
        check=False,
    )


@needs_bash
def _publish_release(
    mock: GiteeMock, shim: Path, assets_dir: Path, notes: Path, base_sha: str = ""
) -> subprocess.CompletedProcess[str]:
    args = [
        bash,
        str(PUBLISH_RELEASE),
        "--tag",
        TAG,
        "--owner",
        OWNER,
        "--repo",
        REPO,
        "--assets-dir",
        str(assets_dir),
        "--body-file",
        str(notes),
    ]
    if base_sha:
        args += ["--base-sha", base_sha]
    return subprocess.run(
        args,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=_env(mock, shim),
        timeout=180,
        check=False,
    )


@pytest.fixture
def release_inputs(tmp_path: Path) -> tuple[Path, Path]:
    assets = tmp_path / "assets"
    assets.mkdir()
    (assets / "Octop-desktop-windows-amd64-1.5.0.exe").write_bytes(b"x" * 2048)
    (assets / "Octop-video-components-windows-x64-1.5.0.exe").write_bytes(b"y" * 1024)
    notes = tmp_path / "notes.md"
    notes.write_text("# 1.5.0\n\nNOTES-MARKER-42\n", encoding="utf-8")
    return assets, notes


def test_push_readme_prints_only_the_sha(gitee: GiteeMock, python3_shim: Path) -> None:
    """The caller pipes stdout into ``--base-sha``: anything else there is garbage."""
    result = _push_readme(gitee, python3_shim, Path("."))

    assert result.returncode == 0, result.stderr
    assert re.fullmatch(r"[0-9a-f]{40}", result.stdout.strip())
    assert len(result.stdout.strip().splitlines()) == 1
    # The progress belongs on stderr, not in the captured sha.
    assert "updated" in result.stderr


def test_download_page_points_at_this_release(gitee: GiteeMock, python3_shim: Path) -> None:
    """A page that still names another release would send users to old installers."""
    result = _push_readme(gitee, python3_shim, Path("."))
    assert result.returncode == 0, result.stderr

    page = gitee.page_text()
    assert TAG in page
    assert "v1.4.0-gitee.1" not in page
    assert set(re.findall(r"\d+\.\d+\.\d+", page)) == {"1.5.0"}


def test_download_page_with_a_stale_tag_is_refused(
    gitee: GiteeMock, python3_shim: Path, tmp_path: Path
) -> None:
    """A template that did not follow the release must stop the publish."""
    poisoned = tmp_path / "poisoned"
    poisoned.mkdir()
    for name in ("REPO_README.md", "REPO_README.en.md"):
        text = (GITEE_DIR / name).read_text(encoding="utf-8").replace("{{TAG}}", "v1.4.0-gitee.1")
        (poisoned / name).write_text(text, encoding="utf-8")

    result = _push_readme(gitee, python3_shim, tmp_path, template_dir=poisoned)

    assert result.returncode != 0
    assert "v1.4.0-gitee.1" in (result.stdout + result.stderr)
    # Nothing was written.
    assert not gitee.files


@needs_bash
def test_release_carries_a_clean_target_commitish(
    gitee: GiteeMock, python3_shim: Path, release_inputs: tuple[Path, Path]
) -> None:
    """The tag has to point at the download page commit — exactly that sha."""
    assets, notes = release_inputs
    sha = _push_readme(gitee, python3_shim, Path(".")).stdout.strip()

    result = _publish_release(gitee, python3_shim, assets, notes, base_sha=sha)

    assert result.returncode == 0, result.stdout + result.stderr
    created = gitee.calls("POST", "/releases")
    assert len(created) == 1
    payload = _json(created[0]["body"])
    assert payload["target_commitish"] == sha
    assert payload["tag_name"] == TAG
    # The notes are published verbatim, so they must not carry the CR of a
    # file written on Windows.
    assert "\r" not in payload["body"]
    assert payload["body"] == notes.read_text(encoding="utf-8").replace("\r\n", "\n").rstrip("\n")


@needs_bash
def test_republish_is_idempotent_and_refreshes_the_notes(
    gitee: GiteeMock, python3_shim: Path, release_inputs: tuple[Path, Path]
) -> None:
    """Re-running must not create a second release or re-upload the same files."""
    assets, notes = release_inputs
    sha = _push_readme(gitee, python3_shim, Path(".")).stdout.strip()
    assert _publish_release(gitee, python3_shim, assets, notes, base_sha=sha).returncode == 0

    notes.write_text("# 1.5.0\n\nNOTES-MARKER-43\n", encoding="utf-8")
    assert _publish_release(gitee, python3_shim, assets, notes, base_sha=sha).returncode == 0

    assert len(gitee.calls("POST", "/releases")) == 1
    assert len(gitee.calls("POST", "/attach_files")) == 2
    # The body carries the download links — a re-publish must refresh it.
    assert len(gitee.calls("PATCH", "")) == 1
    assert gitee.releases[TAG]["body"].endswith("NOTES-MARKER-43")


@needs_bash
def test_republish_reports_a_tag_that_cannot_move(
    gitee: GiteeMock, python3_shim: Path, release_inputs: tuple[Path, Path]
) -> None:
    """Gitee cannot move an existing tag — say so instead of pretending."""
    assets, notes = release_inputs
    sha = _push_readme(gitee, python3_shim, Path(".")).stdout.strip()
    assert _publish_release(gitee, python3_shim, assets, notes, base_sha=sha).returncode == 0

    other = "1" * 40
    result = _publish_release(gitee, python3_shim, assets, notes, base_sha=other)

    assert result.returncode == 0
    assert "still points at" in (result.stdout + result.stderr)


@needs_bash
def test_a_rejected_token_fails_loudly(
    python3_shim: Path, release_inputs: tuple[Path, Path]
) -> None:
    """401/403 is not "the release does not exist" — the token is the problem."""
    assets, notes = release_inputs
    with GiteeMock(fault="403:releases") as mock:
        result = _publish_release(mock, python3_shim, assets, notes, base_sha="a" * 40)

    output = result.stdout + result.stderr
    assert result.returncode != 0
    assert "rejected the token" in output
    # The real cause must not be reported as "could not create the release".
    assert "could not create the release" not in output


@needs_bash
def test_a_missing_repository_leaves_nothing_behind(
    python3_shim: Path, release_inputs: tuple[Path, Path]
) -> None:
    """A 404 must not leave a half-created release behind."""
    assets, notes = release_inputs
    with GiteeMock(fault="404:releases") as mock:
        result = _publish_release(mock, python3_shim, assets, notes, base_sha="a" * 40)

    assert result.returncode != 0
    assert not mock.releases


def _json(raw: str) -> dict:
    import json

    return json.loads(raw)
