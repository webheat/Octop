"""Package the desktop video runtime into CDN-friendly parts + a manifest.

The native shell used to ship a ~71 MB NSIS installer. That single archive is
unfriendly to CDN caching (one component change rebuilds the whole file) and
exceeds Gitee's 100 MB attachment limit. This script splits the staged runtime
into independently downloadable parts and writes a manifest the client can
consume part-by-part with resume + SHA-256 verification.

    # after `wails3 task windows:components:package` has staged video-runtime/
    python scripts/pack_video_components.py \
        --target win-x64 --version 1.4.0 \
        --base-url https://dw.mengxa.com/video-components/1.4.0/win-x64 \
        --base-url http://dw.mengxa.com/video-components/1.4.0/win-x64 \
        --connections 4 \
        --out-dir dist/video-components

Repeat --base-url once per independent node. The first becomes primary and all
are written into every part's urls[] in order, so the client's bootstrap fetcher
can skip a dead node (DNS round-robin alone cannot detect or route around one).
The same host may be listed twice under different schemes: the client probes
every (host, scheme) pair separately and keeps the nodes that answered, so an
HTTP-only node is not written off when its TLS setup is broken.

--connections sets how many parallel range requests the client uses per part
(written into every part). The origin throttles a single connection to a few
hundred KB/s while its nodes are independent machines, so several ranges over
several mirrors are what make a 110 MB part finish in minutes.

Outputs (under <out-dir>/<target>/):
    core.zip        node.exe + locked Remotion deps + worker/project + src
    browser.zip     Remotion headless-shell (unpacked into node_modules/.remotion)
    manifest.json   bootstrap-compatible manifest describing both parts

Notes on layout: both parts unpack into the same runtime root. `browser.zip`
carries only the `win64/...` subtree and its `target` points at
`node_modules/.remotion/chrome-headless-shell`, so the two parts never overlap.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import zipfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
RUNTIME_DIR = REPO_ROOT / "desktop" / "src" / "video-runtime"
DIST_DIR = REPO_ROOT / "dist" / "video-components"

MANIFEST_SCHEMA = "octop-desktop-video-components/1"
BROWSER_SUBTREE = Path("node_modules") / ".remotion" / "chrome-headless-shell"
# Webpack/remotion build cache left behind by `npm ci` + ensureBrowser — pure
# residue, regenerated on demand, and by far the largest slice of node_modules.
SKIP_DIRS = {".cache", "__pycache__", ".remotion", ".vite", ".parcel-cache"}
SKIP_SUFFIXES = {".pyc", ".log", ".tmp", ".map"}
SKIP_NAMES = {".DS_Store"}
FIXED_TIME = (2026, 1, 1, 0, 0, 0)


def project_version() -> str:
    text = (REPO_ROOT / "pyproject.toml").read_text(encoding="utf-8")
    match = re.search(r'^version\s*=\s*"([^"]+)"', text, re.M)
    if not match:
        raise SystemExit("could not read version from pyproject.toml")
    return match.group(1)


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def in_browser_subtree(rel: Path) -> bool:
    return rel == BROWSER_SUBTREE or BROWSER_SUBTREE in rel.parents


def is_skipped(rel: Path) -> bool:
    if any(part in SKIP_DIRS for part in rel.parts):
        # .remotion is skipped everywhere except inside the browser subtree,
        # which is handled separately by collect_browser().
        return True
    return rel.name in SKIP_NAMES or rel.suffix in SKIP_SUFFIXES


def collect_core(runtime: Path) -> list[Path]:
    files: list[Path] = []
    for path in sorted(runtime.rglob("*")):
        if not path.is_file():
            continue
        rel = path.relative_to(runtime)
        if in_browser_subtree(rel) or is_skipped(rel):
            continue
        files.append(path)
    return files


def collect_browser(runtime: Path) -> tuple[list[Path], bool]:
    base = runtime / BROWSER_SUBTREE
    if not base.is_dir():
        return [], False
    files = sorted(p for p in base.rglob("*") if p.is_file())
    return files, bool(files)


def write_zip(target: Path, files: list[Path], root: Path, arc_prefix: Path | None) -> None:
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        for path in files:
            arcname = path.relative_to(root).as_posix()
            if arc_prefix is not None:
                # Keep only the part below BROWSER_SUBTREE so it unpacks into
                # the manifest's `target` directory cleanly.
                rel_browser = path.relative_to(root / BROWSER_SUBTREE)
                arcname = rel_browser.as_posix()
            info = zipfile.ZipInfo(arcname, date_time=FIXED_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            zf.writestr(info, path.read_bytes())


def build(
    target: str,
    version: str,
    base_urls: list[str],
    out_dir: Path,
    runtime: Path,
    connections: int = 1,
) -> Path:
    """Build CDN parts. Each part lists every mirror URL for client-side failover.

    The first base URL is the primary; remaining ones are mirrors. bootstrap's
    fetcher tries them in order with retries and checksum verification, so a
    dead node is skipped without relying on DNS (which cannot detect failures).

    `connections` is written into every part as the number of parallel range
    requests the client should use. The origin throttles a single connection
    to a few hundred KB/s while its nodes are independent machines, so several
    ranges over several nodes are what make a 110 MB part finish in minutes
    instead of a quarter of an hour.
    """
    if not runtime.is_dir():
        raise SystemExit(
            f"staged runtime not found: {runtime}\n"
            "Build it first: wails3 task windows:components:package"
        )
    manifest = json.loads((runtime / "runtime.json").read_text(encoding="utf-8"))
    if manifest.get("target") not in (None, target):
        raise SystemExit(
            f"runtime.json target={manifest.get('target')!r} does not match --target {target!r}"
        )

    out = out_dir / target
    out.mkdir(parents=True, exist_ok=True)
    core_files = collect_core(runtime)
    browser_files, has_browser = collect_browser(runtime)
    if not core_files:
        raise SystemExit(f"no core files found under {runtime}")

    core_zip = out / "core.zip"
    write_zip(core_zip, core_files, runtime, None)
    parts = [
        {
            "id": "core",
            "urls": [f"{url}/core.zip" for url in base_urls],
            "size": core_zip.stat().st_size,
            "sha256": sha256_of(core_zip),
            "format": "zip",
            "target": "",
            "stripRoot": False,
            "required": True,
            "connections": connections,
        }
    ]

    if has_browser:
        browser_zip = out / "browser.zip"
        write_zip(browser_zip, browser_files, runtime, BROWSER_SUBTREE)
        parts.append(
            {
                "id": "browser",
                "urls": [f"{url}/browser.zip" for url in base_urls],
                "size": browser_zip.stat().st_size,
                "sha256": sha256_of(browser_zip),
                "format": "zip",
                "target": BROWSER_SUBTREE.as_posix(),
                "stripRoot": False,
                # Always installed: the headless shell is the pinned renderer.
                # A system Chrome/Edge remains a runtime fallback in detectBrowser().
                "required": True,
                "connections": connections,
            }
        )

    document = {
        "schema": MANIFEST_SCHEMA,
        "version": f"{version}-{target}-node{manifest.get('nodeVersion', '?')}",
        "platform": target,
        "nodeVersion": manifest.get("nodeVersion"),
        "browserMode": manifest.get("browserMode"),
        "parts": parts,
    }
    manifest_path = out / "manifest.json"
    manifest_path.write_text(
        json.dumps(document, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    return manifest_path


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Split the staged video runtime into CDN parts + manifest."
    )
    parser.add_argument("--target", choices=["win-x64", "win-arm64"], default="win-x64")
    parser.add_argument("--version", default=None, help="component version (default: pyproject version)")
    parser.add_argument(
        "--base-url",
        action="append",
        required=True,
        help=(
            "CDN base URL hosting the archives (no trailing slash). "
            "Repeat once per mirror: the first is primary, the rest are "
            "failover mirrors written into each part's urls[] in order."
        ),
    )
    parser.add_argument("--out-dir", default=str(DIST_DIR))
    parser.add_argument("--runtime-dir", default=str(RUNTIME_DIR))
    parser.add_argument(
        "--connections",
        type=int,
        default=1,
        help=(
            "Parallel range requests the client uses per part. The origin "
            "throttles one connection to a few hundred KB/s while its nodes "
            "are independent machines, so 4 turns a 110 MB part into a "
            "couple of minutes. Zero means one connection."
        ),
    )
    args = parser.parse_args(argv)

    version = args.version or project_version()
    base_urls = [url.rstrip("/") for url in args.base_url]
    manifest = build(
        args.target,
        version,
        base_urls,
        Path(args.out_dir),
        Path(args.runtime_dir),
        args.connections,
    )
    doc = json.loads(manifest.read_text(encoding="utf-8"))
    print(f"[video-components] manifest: {manifest}")
    print(f"[video-components] mirrors: {len(base_urls)} (primary: {base_urls[0]})")
    print(f"[video-components] connections per part: {args.connections}")
    for part in doc["parts"]:
        size_mb = part["size"] / (1024 * 1024)
        print(f"  - {part['id']:<8} {size_mb:8.1f} MB  required={part['required']}  urls={len(part['urls'])}  connections={part.get('connections', 1)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
