#!/usr/bin/env python3
"""Push the download page to the Gitee repository.

    python3 scripts/gitee/push_readme.py --owner webheat --repo octop_client --token "$GITEE_TOKEN"

Updates README.md and README.en.md through the Gitee contents API and prints the
commit the default branch now points at — that commit is the one a release tag
should point at, so the Release page shows the download page instead of an
unrelated commit.

Files are only written when their content actually changed.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import urllib.error
import urllib.request

API_BASE = os.environ.get("GITEE_API_BASE", "https://gitee.com/api/v5")
HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_FILES = ["REPO_README.md", "REPO_README.en.md"]
TARGET_NAMES = ["README.md", "README.en.md"]
COMMIT_MESSAGE = "docs: 更新客户端下载页"


def request(method: str, path: str, token: str, payload: dict | None = None) -> tuple[int, object]:
    body = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(f"{API_BASE}{path}", data=body, method=method)
    req.add_header("Authorization", f"token {token}")
    req.add_header("Accept", "application/json")
    if body is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=60) as response:
            raw = response.read()
            return response.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        try:
            return exc.code, json.loads(raw)
        except json.JSONDecodeError:
            return exc.code, {"message": raw.decode(errors="replace")}


def repo_info(owner: str, repo: str, token: str) -> dict:
    status, data = request("GET", f"/repos/{owner}/{repo}", token)
    if status != 200:
        raise SystemExit(f"cannot read the repository {owner}/{repo}: HTTP {status} {data}")
    return data


def head_sha(owner: str, repo: str, token: str, branch: str) -> str:
    # Gitee has no git/refs read endpoint — the branch is the way in.
    status, data = request("GET", f"/repos/{owner}/{repo}/branches/{branch}", token)
    if status != 200:
        raise SystemExit(f"cannot read {branch} of {owner}/{repo}: HTTP {status} {data}")
    return data["commit"]["sha"]


def push_file(owner: str, repo: str, token: str, branch: str, target: str, source: str) -> str:
    """Write source to target. Returns the new commit sha, or "" when unchanged."""
    with open(source, "rb") as handle:
        content = handle.read()

    status, existing = request("GET", f"/repos/{owner}/{repo}/contents/{target}", token)
    if status == 200:
        current = base64.b64decode(existing.get("content") or "")
        if current == content:
            print(f"{target}: unchanged", file=sys.stderr)
            return ""
        payload = {
            "content": base64.b64encode(content).decode(),
            "message": COMMIT_MESSAGE,
            "branch": branch,
            "sha": existing["sha"],
        }
        # Gitee updates a file with PUT; PATCH is GitHub's verb and answers 405.
        method = "PUT"
    elif status == 404:
        payload = {
            "content": base64.b64encode(content).decode(),
            "message": COMMIT_MESSAGE,
            "branch": branch,
        }
        method = "POST"
    else:
        raise SystemExit(f"cannot read {target}: HTTP {status} {existing}")

    status, data = request(method, f"/repos/{owner}/{repo}/contents/{target}", token, payload)
    if status not in (200, 201):
        raise SystemExit(f"cannot write {target}: HTTP {status} {data}")
    print(f"{target}: updated", file=sys.stderr)
    return data.get("commit", {}).get("sha", "")


def read_token() -> str:
    """--token wins, then $GITEE_TOKEN, then ~/.gitee_token."""
    token = os.environ.get("GITEE_TOKEN", "").strip()
    if not token:
        path = os.path.expanduser("~/.gitee_token")
        if os.path.isfile(path):
            with open(path, encoding="utf-8") as handle:
                token = handle.read().strip()
    return token


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--owner", required=True, help="Gitee repository owner")
    parser.add_argument("--repo", required=True, help="Gitee repository name")
    parser.add_argument(
        "--token", default="", help="Gitee access token (default: $GITEE_TOKEN or ~/.gitee_token)"
    )
    parser.add_argument("--dir", default=HERE, help="directory holding the README sources")
    args = parser.parse_args()
    token = args.token or read_token()
    if not token:
        raise SystemExit("no token: pass --token, set GITEE_TOKEN, or write it to ~/.gitee_token")

    info = repo_info(args.owner, args.repo, token)
    branch = info.get("default_branch") or "master"

    for source_name, target in zip(DEFAULT_FILES, TARGET_NAMES, strict=True):
        source = os.path.join(args.dir, source_name)
        if not os.path.isfile(source):
            raise SystemExit(f"missing source file: {source}")
        push_file(args.owner, args.repo, token, branch, target, source)

    sha = head_sha(args.owner, args.repo, token, branch)
    print(sha)
    return 0


if __name__ == "__main__":
    sys.exit(main())
