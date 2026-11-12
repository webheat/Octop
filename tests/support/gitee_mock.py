"""A mock Gitee API (v5 subset) for exercising scripts/gitee/ end to end.

The Gitee publish path had never run in CI, so its failure modes were
untested: a progress line landing in stdout poisoned the release's
``target_commitish``, a download page still pointing at the previous release
was published silently, and a rejected token surfaced as "release not found".

``GITEE_API_BASE`` already makes the scripts talk to a configurable base, so
pointing them at this server drives the real scripts the way a release does.
"""

from __future__ import annotations

import base64
import hashlib
import json
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

REPO_RE = re.compile(r"^/api/v5/repos/(?P<owner>[^/]+)/(?P<repo>[^/]+)$")
BRANCH_RE = re.compile(r"^/api/v5/repos/[^/]+/[^/]+/branches/(?P<branch>.+)$")
CONTENT_RE = re.compile(r"^/api/v5/repos/[^/]+/[^/]+/contents/(?P<path>.+)$")
RELEASE_BY_TAG_RE = re.compile(r"^/api/v5/repos/[^/]+/[^/]+/releases/tags/(?P<tag>.+)$")
TAGS_RE = re.compile(r"^/api/v5/repos/[^/]+/[^/]+/tags$")
RELEASES_RE = re.compile(r"^/api/v5/repos/[^/]+/[^/]+/releases$")
RELEASE_ID_RE = re.compile(r"^/api/v5/repos/[^/]+/[^/]+/releases/(?P<rid>\d+)$")
ATTACH_RE = re.compile(r"^/api/v5/repos/[^/]+/[^/]+/releases/(?P<rid>\d+)/attach_files$")
# The GitHub side of the mock: the release metadata and the asset bytes.
GH_RELEASE_RE = re.compile(r"^/gh/repos/[^/]+/[^/]+/releases/tags/(?P<tag>.+)$")
GH_DOWNLOAD_RE = re.compile(r"^/gh/download/(?P<name>.+)$")


def _page(tags: list[str], path: str) -> list[dict[str, str]]:
    """One page of the tag list, honouring ``?per_page=&page=``."""
    query = path.partition("?")[2]
    params = dict(part.partition("=")[::2] for part in query.split("&") if "=" in part)
    try:
        per_page = max(1, int(params.get("per_page", "30")))
        page = max(1, int(params.get("page", "1")))
    except ValueError:
        per_page, page = 30, 1
    start = (page - 1) * per_page
    return [{"name": tag} for tag in tags[start : start + per_page]]


def _sha(seed: str) -> str:
    return hashlib.sha1(seed.encode("utf-8")).hexdigest()


class GiteeMock:
    """An in-memory Gitee API. Use it as a context manager.

    ``fault`` injects failures: ``"403:contents,404:releases"`` makes every
    request whose path contains ``contents`` answer 403 and every request
    whose path contains ``releases`` answer 404.
    """

    def __init__(self, fault: str = "") -> None:
        self.fault = fault
        self.requests: list[dict[str, Any]] = []
        self.repo: dict[str, Any] = {
            "default_branch": "master",
            "full_name": "webheat/octop_client",
        }
        self.files: dict[str, dict[str, str]] = {}
        self.releases: dict[str, dict[str, Any]] = {}
        self.tags: list[str] = []
        # GitHub side: the asset bytes the mock serves and the sizes it reports.
        self.github_assets: dict[str, bytes] = {}
        self.github_sizes: dict[str, int] = {}
        # Assets the release promises but the server does not serve (404).
        self.github_missing: set[str] = set()
        self._next_id = 1000
        self._lock = threading.Lock()
        self._server: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None

    # -- GitHub side -----------------------------------------------------------
    def set_github_asset(self, name: str, data: bytes, reported_size: int | None = None) -> None:
        """Serve ``data`` for ``name``; report ``reported_size`` bytes.

        A reported size larger than the served bytes simulates a truncated
        download.
        """
        self.github_assets[name] = data
        self.github_sizes[name] = len(data) if reported_size is None else reported_size

    def github_release(self, tag: str) -> dict[str, Any]:
        assets = [
            {
                "name": name,
                "size": self.github_sizes.get(name, len(data)),
                "browser_download_url": f"{self.web_base}/gh/download/{name}",
            }
            for name, data in sorted(self.github_assets.items())
        ]
        assets += [
            {
                "name": name,
                "size": 2048,
                "browser_download_url": f"{self.web_base}/gh/download/{name}",
            }
            for name in sorted(self.github_missing)
        ]
        return {"tag_name": tag, "body": f"Octop {tag}", "assets": assets}

    # -- lifecycle ------------------------------------------------------------
    def __enter__(self) -> GiteeMock:
        self.start()
        return self

    def __exit__(self, *_exc: object) -> None:
        self.stop()

    def start(self) -> None:
        mock = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *_args: object) -> None:
                pass

            def _read_body(self) -> bytes:
                length = int(self.headers.get("Content-Length") or 0)
                return self.rfile.read(length) if length else b""

            def _send(self, status: int, payload: Any) -> None:
                # Gitee answers 200 with the JSON literal `null` when the tag
                # exists but has no release yet — send that, not an empty body.
                body = b"null" if payload is None else json.dumps(payload).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                if body:
                    self.wfile.write(body)

            def _record(self, method: str, path: str, body: bytes) -> None:
                with mock._lock:
                    mock.requests.append(
                        {
                            "method": method,
                            "path": path,
                            "body": body[:8000].decode("utf-8", "replace"),
                        }
                    )

            def _fault(self, needle: str) -> int | None:
                for item in mock.fault.split(","):
                    if not item.strip():
                        continue
                    code, target = item.split(":", 1)
                    if target in needle:
                        return int(code)
                return None

            def do_GET(self) -> None:  # noqa: N802 - http.server API
                body = self._read_body()
                self._record("GET", self.path, body)
                path = self.path
                fault = self._fault(path)
                if fault:
                    self._send(fault, {"message": "injected fault", "path": path})
                    return

                if REPO_RE.match(path):
                    self._send(200, mock.repo)
                    return

                match = BRANCH_RE.match(path)
                if match:
                    branch = match.group("branch")
                    self._send(200, {"name": branch, "commit": {"sha": _sha(branch)}})
                    return

                match = CONTENT_RE.match(path)
                if match:
                    target = match.group("path")
                    entry = mock.files.get(target)
                    if not entry:
                        self._send(404, {"message": "Not Found", "path": target})
                        return
                    self._send(
                        200,
                        {
                            "type": "file",
                            "name": target.rsplit("/", 1)[-1],
                            "path": target,
                            "sha": entry["sha"],
                            "content": base64.b64encode(entry["content"].encode("utf-8")).decode(),
                        },
                    )
                    return

                match = RELEASE_BY_TAG_RE.match(path)
                if match:
                    self._send(200, mock.releases.get(match.group("tag")))
                    return

                if TAGS_RE.match(path):
                    self._send(200, _page(mock.tags, path))
                    return

                # GitHub side, so the whole publish script can be driven.
                match = GH_RELEASE_RE.match(path)
                if match:
                    self._send(200, mock.github_release(match.group("tag")))
                    return

                match = GH_DOWNLOAD_RE.match(path)
                if match:
                    name = match.group("name")
                    data = mock.github_assets.get(name)
                    if data is None:
                        self._send(404, {"message": "Not Found", "path": path})
                        return
                    self.send_response(200)
                    self.send_header("Content-Type", "application/octet-stream")
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                    return

                self._send(404, {"message": "Not Found", "path": path})

            def do_POST(self) -> None:  # noqa: N802 - http.server API
                body = self._read_body()
                self._record("POST", self.path, body)
                path = self.path
                fault = self._fault(path)
                if fault:
                    self._send(fault, {"message": "injected fault", "path": path})
                    return

                match = ATTACH_RE.match(path)
                if match:
                    rid = match.group("rid")
                    name = ""
                    ctype = self.headers.get("Content-Type", "")
                    if "multipart/form-data" in ctype:
                        for chunk in body.split(b"--"):
                            if b"filename=" in chunk:
                                head = chunk.split(b"\r\n\r\n", 1)[0].decode("utf-8", "replace")
                                found = re.search(r'filename="([^"]+)"', head)
                                if found:
                                    name = found.group(1)
                    for release in mock.releases.values():
                        if str(release.get("id")) == rid:
                            release.setdefault("assets", []).append(
                                {"name": name, "size": len(body)}
                            )
                    self._send(201, {"id": rid, "assets": [{"name": name}]})
                    return

                if RELEASES_RE.match(path):
                    payload = json.loads(body or b"{}")
                    tag = payload.get("tag_name", "")
                    with mock._lock:
                        mock._next_id += 1
                        release = {
                            "id": mock._next_id,
                            "tag_name": tag,
                            "name": payload.get("name", tag),
                            "target_commitish": payload.get("target_commitish", ""),
                            "body": payload.get("body", ""),
                            "assets": [],
                        }
                        mock.releases[tag] = release
                        if tag not in mock.tags:
                            mock.tags.append(tag)
                    self._send(201, release)
                    return

                match = CONTENT_RE.match(path)
                if match:
                    payload = json.loads(body or b"{}")
                    target = match.group("path")
                    content = base64.b64decode(payload.get("content", "")).decode("utf-8")
                    existed = target in mock.files
                    sha = _sha(target + content)
                    mock.files[target] = {"content": content, "sha": sha}
                    self._send(
                        200 if existed else 201,
                        {"content": {"path": target, "sha": sha}, "commit": {"sha": sha}},
                    )
                    return

                self._send(404, {"message": "Not Found", "path": path})

            def do_PUT(self) -> None:  # noqa: N802 - http.server API
                body = self._read_body()
                self._record("PUT", self.path, body)
                path = self.path
                fault = self._fault(path)
                if fault:
                    self._send(fault, {"message": "injected fault", "path": path})
                    return
                match = CONTENT_RE.match(path)
                if match:
                    payload = json.loads(body or b"{}")
                    target = match.group("path")
                    content = base64.b64decode(payload.get("content", "")).decode("utf-8")
                    sha = _sha(target + content)
                    mock.files[target] = {"content": content, "sha": sha}
                    self._send(
                        200, {"content": {"path": target, "sha": sha}, "commit": {"sha": sha}}
                    )
                    return
                self._send(404, {"message": "Not Found", "path": path})

            def do_PATCH(self) -> None:  # noqa: N802 - http.server API
                body = self._read_body()
                self._record("PATCH", self.path, body)
                path = self.path
                fault = self._fault(path)
                if fault:
                    self._send(fault, {"message": "injected fault", "path": path})
                    return
                match = RELEASE_ID_RE.match(path)
                if match:
                    rid = match.group("rid")
                    payload = json.loads(body or b"{}")
                    for release in mock.releases.values():
                        if str(release.get("id")) == rid:
                            release.update(payload)
                            self._send(200, release)
                            return
                    self._send(404, {"message": "no such release"})
                    return
                self._send(404, {"message": "Not Found", "path": path})

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()
            self._server = None
        if self._thread is not None:
            self._thread.join(timeout=5)
            self._thread = None

    # -- helpers ---------------------------------------------------------------
    @property
    def port(self) -> int:
        assert self._server is not None
        return self._server.server_address[1]

    @property
    def api_base(self) -> str:
        return f"http://127.0.0.1:{self.port}/api/v5"

    @property
    def web_base(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    @property
    def github_api_base(self) -> str:
        """The base the scripts use for the GitHub side (``GITHUB_API_BASE``)."""
        return f"{self.web_base}/gh"

    def page_text(self) -> str:
        """The download page as it now sits in the mock repository."""
        return "\n".join(
            f"--- {name} ---\n{entry['content']}" for name, entry in sorted(self.files.items())
        )

    def calls(self, method: str, suffix: str) -> list[dict[str, Any]]:
        return [r for r in self.requests if r["method"] == method and r["path"].endswith(suffix)]
