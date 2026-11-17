"""List the GitHub release assets that belong on Gitee.

    python3 scripts/gitee/list_release_assets.py --repo owner/repo --tag v1.4.0 \
        [--platform windows]

Prints one ``name<TAB>size<TAB>url`` line per asset: the ones that fit the Gitee
attachment limit and belong to the platform this round delivers. The size is
included so the caller can tell a complete download from a truncated one. The
token is read from ``$GH_TOKEN`` / ``$GITHUB_TOKEN``.
"""

from __future__ import annotations

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from assets import select  # noqa: E402
from github import fetch_release  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--repo", required=True, help="GitHub repo (owner/repo) holding the release"
    )
    parser.add_argument("--tag", required=True, help="release tag, e.g. v1.4.0")
    parser.add_argument(
        "--platform",
        default="windows",
        help="platform this round delivers (default: windows); 'all' keeps every asset",
    )
    args = parser.parse_args()

    release = fetch_release(args.repo, args.tag)
    assets = release.get("assets") or []
    small, _ = select(assets, args.platform)
    for asset in small:
        print(f"{asset['name']}\t{asset.get('size', 0)}\t{asset['browser_download_url']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
