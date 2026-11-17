#!/usr/bin/env python3
"""Push the download page to the Gitee repository.

    python3 scripts/gitee/push_readme.py --owner webheat --repo octop_client \
        --tag v1.5.0-gitee.1 --token "$GITEE_TOKEN"

Updates README.md and README.en.md through the Gitee contents API and prints the
commit the default branch now points at — that commit is the one a release tag
should point at, so the Release page shows the download page instead of an
unrelated commit.

The page is a template (REPO_README*.md) with {{TAG}}, {{VERSION}}, {{OWNER}},
{{REPO}} and {{GITEE_WEB}} placeholders; they are rendered for the release being
published. The rendered page must mention this release's tag and must not carry
any other version or tag — a page still pointing at the previous release would
silently send users to old installers.

Files are only written when their content actually changed.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import sys
import urllib.error
import urllib.request

API_BASE = os.environ.get("GITEE_API_BASE", "https://gitee.com/api/v5")
HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_FILES = ["REPO_README.md", "REPO_README.en.md"]
TARGET_NAMES = ["README.md", "README.en.md"]
COMMIT_MESSAGE = "docs: 更新客户端下载页"

# A release tag (v1.5.0, v1.5.0-gitee.1) and a bare version (1.5.0).
TAG_RE = re.compile(r"v\d+\.\d+(?:\.\d+)?(?:-gitee\.\d+)?")
VERSION_RE = re.compile(r"\d+\.\d+\.\d+")
PLACEHOLDER_RE = re.compile(r"\{\{[A-Z_]+\}\}")


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
    except urllib.error.URLError as exc:
        raise SystemExit(f"cannot reach {API_BASE}: {exc.reason}") from exc


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


def version_of(tag: str) -> str:
    """``v1.5.0-gitee.1`` -> ``1.5.0``."""
    match = re.match(r"v?(\d+\.\d+(?:\.\d+)?)", tag)
    if not match:
        raise SystemExit(f"cannot derive a version from the tag {tag!r}; pass --version")
    return match.group(1)


def render(text: str, *, web: str, owner: str, repo: str, tag: str, version: str) -> str:
    """Fill the download-page template and refuse a page that still points
    somewhere else: a leftover tag or version would silently serve the
    previous release's installers."""
    rendered = (
        text.replace("{{GITEE_WEB}}", web)
        .replace("{{OWNER}}", owner)
        .replace("{{REPO}}", repo)
        .replace("{{TAG}}", tag)
        .replace("{{VERSION}}", version)
    )

    leftover = PLACEHOLDER_RE.findall(rendered)
    if leftover:
        raise SystemExit(
            f"the download page still has unfilled placeholders: {sorted(set(leftover))}"
        )
    if tag not in rendered:
        found = sorted(set(TAG_RE.findall(rendered)))
        raise SystemExit(
            f"the rendered download page does not mention {tag}"
            + (f" (it mentions: {found})" if found else "")
        )
    stale_tags = sorted({t for t in TAG_RE.findall(rendered) if t != tag})
    if stale_tags:
        raise SystemExit(
            f"the rendered download page still points at another release: {stale_tags}"
        )
    stale_versions = sorted({v for v in VERSION_RE.findall(rendered) if v != version})
    if stale_versions:
        raise SystemExit(
            f"the rendered download page still mentions another version: {stale_versions}"
        )
    return rendered


def push_file(
    owner: str,
    repo: str,
    token: str,
    branch: str,
    target: str,
    content: bytes,
) -> str:
    """Write content to target. Returns the new commit sha, or "" when unchanged."""
    status, existing = request("GET", f"/repos/{owner}/{repo}/contents/{target}", token)
    if status == 200:
        current = base64.b64decode(existing.get("content") or "")
        # Compare line endings insensitively: a Windows checkout of the template
        # would otherwise look "changed" on every run and flip the Gitee README
        # back and forth between LF and CRLF.
        if current.replace(b"\r\n", b"\n") == content.replace(b"\r\n", b"\n"):
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
        "--tag",
        required=True,
        help="release tag the download page must point at, e.g. v1.5.0-gitee.1",
    )
    parser.add_argument(
        "--version",
        default="",
        help="product version used in the asset names (default: derived from --tag)",
    )
    parser.add_argument(
        "--web-base",
        default="https://gitee.com",
        help="base URL the download links point at (default: https://gitee.com)",
    )
    parser.add_argument(
        "--token", default="", help="Gitee access token (default: $GITEE_TOKEN or ~/.gitee_token)"
    )
    parser.add_argument("--dir", default=HERE, help="directory holding the README sources")
    args = parser.parse_args()
    token = args.token or read_token()
    if not token:
        raise SystemExit("no token: pass --token, set GITEE_TOKEN, or write it to ~/.gitee_token")
    version = args.version or version_of(args.tag)

    info = repo_info(args.owner, args.repo, token)
    branch = info.get("default_branch") or "master"

    for source_name, target in zip(DEFAULT_FILES, TARGET_NAMES, strict=True):
        source = os.path.join(args.dir, source_name)
        if not os.path.isfile(source):
            raise SystemExit(f"missing source file: {source}")
        with open(source, "rb") as handle:
            # Always publish LF: the page is pushed to another repository
            # verbatim, and a CRLF checkout would otherwise write CRLF there.
            template = handle.read().decode("utf-8").replace("\r\n", "\n")
        rendered = render(
            template,
            web=args.web_base,
            owner=args.owner,
            repo=args.repo,
            tag=args.tag,
            version=version,
        )
        push_file(args.owner, args.repo, token, branch, target, rendered.encode("utf-8"))

    sha = head_sha(args.owner, args.repo, token, branch)
    print(sha)
    return 0


if __name__ == "__main__":
    sys.exit(main())
