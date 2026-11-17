#!/usr/bin/env python3
"""Build the Gitee release notes from a GitHub release.

    python3 scripts/gitee/release_notes.py --repo TencentCloud/Octop --tag v1.4.0 --out notes.md

The upstream release body is kept as-is and one section is appended. Which
section depends on what the release carries:

* when a thin (remote) installer is present the notes are a two-step list —
  install the client, install the video components — because that is all a
  reader needs. The slim installer, the portable runtime and the Python
  packages are deliberately left out: they only add noise for the people who
  download a client;
* otherwise the older, fuller layout is rendered, which lists every Gitee
  attachment and links whatever exceeded the attachment limit.

Gitee caps one attachment at 100 MB, so the split is not a choice — see
docs/gitee-release.md.
"""

from __future__ import annotations

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from assets import GITEE_ATTACHMENT_LIMIT_MB, select  # noqa: E402
from github import fetch_release  # noqa: E402

DOWNLOAD_BASE = os.environ.get(
    "GITHUB_DOWNLOAD_BASE", "https://github.com/{repo}/releases/download/{tag}"
)
# Assets that fit a Gitee attachment are served from Gitee itself, so the
# notes link to Gitee and never send the reader to GitHub for them.
GITEE_DOWNLOAD_BASE = os.environ.get(
    "GITEE_DOWNLOAD_BASE", "https://gitee.com/{owner}/{repo}/releases/download/{tag}"
)

# How the architecture token in a file name reads to a human.
ARCH_LABELS = {
    "amd64": "Windows 10/11 x64",
    "arm64": "Windows on ARM（骁龙本等）",
}


def _is_thin(asset: dict) -> bool:
    """A remote client — everything but the self-contained slim installer."""
    name = asset.get("name", "")
    return name.startswith("Octop-desktop") and "slim" not in name


def _arch_label(name: str) -> str:
    lowered = name.lower()
    for arch, label in ARCH_LABELS.items():
        if arch in lowered:
            return label
    return "Windows"


def _link(asset: dict, base: str) -> str:
    name = asset["name"]
    return f"[{name}]({base}/{name})（{asset['size'] / 1024 / 1024:.0f} MB）"


def _thin_intro(tag: str) -> list[str]:
    """Everything a remote-client reader needs to know before the two steps."""
    return [
        f"## Octop 桌面客户端 {tag}（Windows）",
        "",
        "客户端连接已经部署好的 Octop 服务：登录、产品库、AI 分镜和方案确认都在服务器端，"
        "客户端只负责界面与本机渲染。",
        "",
        "本构建未做代码签名，Windows SmartScreen 可能提示「未知发布者」，"
        "选择「更多信息 → 仍要运行」即可。macOS 与 Linux 版本未发布。",
        "",
    ]


def _thin_section(thin: list[dict], components: list[dict], base: str) -> list[str]:
    """Two steps, nothing else: the remote client and its video components."""
    lines = [
        "## 下载",
        "",
        "装下面两步就能用。",
        "",
        "### 1. 客户端",
        "",
    ]
    for asset in thin:
        lines.append(f"- {_link(asset, base)} — {_arch_label(asset['name'])}")
    lines.append("")
    if components:
        lines += ["### 2. 视频制作组件", ""]
        for asset in components:
            lines.append(f"- {_link(asset, base)}")
        lines += [
            "",
            "视频渲染在本机完成，不装这一项就无法导出成片；登录、产品库、AI 分镜和"
            "方案编辑不受影响。安装时用默认选项，装完回到客户端点「重新检测」。",
            "",
        ]
    return lines


def _full_section(
    small: list[dict], large: list[dict], repo: str, tag: str, base: str
) -> list[str]:
    """The previous layout: every attachment, plus what did not fit."""
    lines = ["## Gitee 上的安装包", ""]
    if small:
        lines += ["以下产物已上传到 Gitee：", ""]
        for asset in sorted(small, key=lambda a: a["name"]):
            lines.append(f"- {asset['name']}（{asset['size'] / 1024 / 1024:.0f} MB）")
        lines.append("")
    desktop = [a for a in small if a["name"].startswith("Octop-desktop")]
    if any("slim" not in a["name"] for a in desktop):
        lines += [
            "**远程版**（推荐）安装包连接已经部署好的 Octop 服务，不需要在本地安装"
            " Python 运行时，装完即用。",
            "",
        ]
    if any("slim" in a["name"] for a in desktop):
        lines += [
            "**slim 版**安装包只含桌面外壳（不含 Python 运行时），"
            "**首次启动会从 GitHub Release 下载约 213 MB 的运行时**并解包到本地，"
            "此后离线可用。首次启动需要联网；下载中断后重启客户端会从断点继续。"
            "运行时下载支持断点续传。",
            "",
        ]
    components = [a for a in small if a["name"].startswith("Octop-video-components")]
    if components:
        lines += [
            "## 视频制作组件（另需安装）",
            "",
            "桌面客户端不自带视频渲染环境，两种客户端都要单独装一次。不装不影响登录、"
            "产品库和方案编辑，只是无法在本机出片。",
            "",
        ]
        for asset in sorted(components, key=lambda a: a["name"]):
            name = asset["name"]
            lines.append(
                f"- [{name}]({base}/{name})（{asset['size'] / 1024 / 1024:.0f} MB）"
                " — 默认选项安装，回到客户端点「重新检测」"
            )
        lines.append("")
    if any(a["name"].endswith((".whl", ".tar.gz")) for a in small):
        lines += [
            "`octop-*.whl` / `octop-*.tar.gz` 是 Python 包，用 `pip install octop` 安装服务端。",
            "",
        ]

    if large:
        lines += [
            f"## 完整安装包（超过 {GITEE_ATTACHMENT_LIMIT_MB} MB，未上传到 Gitee）",
            "",
            "Gitee 单个附件上限 "
            f"{GITEE_ATTACHMENT_LIMIT_MB} MB，以下产物只在 GitHub Release 提供：",
            "",
        ]
        download_base = DOWNLOAD_BASE.format(repo=repo, tag=tag)
        for asset in sorted(large, key=lambda a: a["name"]):
            name = asset["name"]
            lines.append(
                f"- {name}（{asset['size'] / 1024 / 1024:.0f} MB）"
                f" — [GitHub]({download_base}/{name})"
            )
        lines.append("")
    return lines


def build(
    release: dict,
    repo: str,
    tag: str,
    platform: str | None,
    gitee_owner: str = "webheat",
    gitee_repo: str = "octop_client",
) -> str:
    body = (release.get("body") or "").strip()
    assets = release.get("assets") or []
    small, large = select(assets, platform)
    base = GITEE_DOWNLOAD_BASE.format(owner=gitee_owner, repo=gitee_repo, tag=tag)

    thin = sorted((a for a in small if _is_thin(a)), key=lambda a: a["name"])
    components = sorted(
        (a for a in small if a["name"].startswith("Octop-video-components")),
        key=lambda a: a["name"],
    )

    lines: list[str] = []
    if thin:
        # The remote client needs two files and nothing else, so the upstream
        # body — which enumerates every artifact — would only add noise.
        lines += _thin_intro(tag)
        lines += _thin_section(thin, components, base)
    else:
        lines += [body, ""] if body else [f"Octop {tag}", ""]
        lines += _full_section(small, large, repo, tag, base)
    return "\n".join(lines).rstrip() + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--repo", required=True, help="GitHub repo (owner/repo) holding the release"
    )
    parser.add_argument("--tag", required=True, help="release tag, e.g. v1.4.0")
    parser.add_argument("--out", required=True, help="file to write the notes to")
    parser.add_argument(
        "--platform",
        default="windows",
        help="platform this round delivers (default: windows); 'all' keeps every asset",
    )
    parser.add_argument(
        "--gitee-owner",
        default="webheat",
        help="Gitee owner the release is published under (default: webheat)",
    )
    parser.add_argument(
        "--gitee-repo",
        default="octop_client",
        help="Gitee repo the release is published under (default: octop_client)",
    )
    args = parser.parse_args()

    release = fetch_release(args.repo, args.tag)
    notes = build(
        release,
        args.repo,
        args.tag,
        args.platform,
        gitee_owner=args.gitee_owner,
        gitee_repo=args.gitee_repo,
    )
    with open(args.out, "w", encoding="utf-8") as handle:
        handle.write(notes)
    print(f"wrote {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
