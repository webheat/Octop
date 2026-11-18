#!/usr/bin/env python3
"""Split an assembled portable runtime into downloadable shards + a manifest.

The green portable tree (``runtime/`` + ``packages/`` + launchers) is today
shipped as one ~250 MB zip. This script splits the same tree into independent
tar.gz parts so the slim installer can fetch them with resume, per-part
SHA-256 and mirror fallback (``desktop/src/bootstrap``)::

    Octop-<plat>/
      runtime/        → part ``runtime``   target ""        required
      packages/       → part ``deps-core`` target packages  required
      packages/octop  → part ``app``       target packages  required
      optional deps   → parts ``deps-*``   target packages  required=false
      manifest.json

Part ordering is not cosmetic. ``bootstrap`` installs parts in manifest order
and the root part (``target: ""``) must come first because its extraction
wipes the runtime root. Within ``packages/`` the first part (``deps-core``)
owns the directory and later parts carry ``append: true`` so they only add
files instead of replacing the tree.

Usage::

    # from an already assembled staging tree (package.sh output)
    python3 desktop/portable/pack_portable_shards.py \\
        --staging desktop/portable/release/Octop-windows-amd64 \\
        --plat windows-amd64 --version 1.4.0 \\
        --base-url https://example.com/octop-runtime/1.4.0/windows-amd64

    # or straight from the portable zip produced by package.sh
    python3 desktop/portable/pack_portable_shards.py \\
        --zip desktop/portable/release/Octop-portable-windows-amd64-1.4.0.zip

``--base-url`` may be repeated (first = primary, rest = mirrors); the file
name is appended to every entry. Without it the manifest carries an
``example.invalid`` placeholder because PR-1 produces artifacts for review
only — nothing publishes or consumes them yet.

Outputs live under ``<out-dir>/<plat>/`` (default ``release/parts/``).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import sys
import tarfile
import tempfile
import zipfile
from pathlib import Path

MANIFEST_SCHEMA = "octop-desktop-runtime-parts/1"
PLACEHOLDER_BASE_URL = "https://downloads.example.invalid/octop-runtime"

# The root part: its archive carries runtime/ plus the files that must live
# directly in the runtime root. Extracting it wipes the root, so it goes first.
ROOT_LAUNCHERS = ("launch.py", "start.sh", "start.bat", "README.txt", "VERSION.txt")

# Distribution names (PEP 503 normalised) that make up the app part.
APP_DISTS = {"octop"}

# Optional shards, keyed by part id. Names are distribution names from the
# staged .dist-info directories, not import names. Membership is provisional
# until PR-0 turns these dependencies into extras; until then the split is a
# best-effort post-hoc partition of the one packages/ tree.
OPTIONAL_GROUPS: dict[str, frozenset[str]] = {
    "deps-tencent": frozenset({"tencentcloud-sdk-python"}),
    "deps-google": frozenset(
        {
            "google-api-python-client",
            "google-auth",
            "google-auth-httplib2",
            "googleapis-common-protos",
            "httplib2",
            "uritemplate",
        }
    ),
    "deps-boto": frozenset(
        {
            "boto3",
            "botocore",
            "s3transfer",
            "jmespath",
            "aioboto3",
            "aiobotocore",
        }
    ),
    "deps-lark": frozenset({"lark-oapi"}),
}

# Fix timestamps so repeated builds of the same tree produce the same shard
# bytes (helps compare CI artifacts; 2026-01-01 UTC).
FIXED_MTIME = 1767225600


def normalise_dist(name: str) -> str:
    """PEP 503 normalise a distribution name (``Foo_Bar`` -> ``foo-bar``)."""
    return re.sub(r"[-_.]+", "-", name).strip("-").lower()


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def dist_owner_map(packages: Path) -> dict[str, str]:
    """Map each installed file (relative to packages/) to its distribution.

    ``pip``/``uv --target`` writes a RECORD per distribution. It is the only
    reliable way to tell which top-level directory belongs to which wheel
    (``google/`` is shared by google-auth, googleapis-common-protos and
    protobuf, for example).
    """
    owners: dict[str, str] = {}
    for record in sorted(packages.glob("*.dist-info/RECORD")):
        directory = record.parent.name  # <name>-<version>.dist-info
        match = re.match(r"^(?P<name>.+?)-\d", directory)
        dist = normalise_dist(match.group("name") if match else directory.split(".")[0])
        try:
            lines = record.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            continue
        for line in lines:
            rel = line.split(",", 1)[0].strip().replace("\\", "/")
            if not rel or rel.startswith(("/", "../")):
                continue
            owners.setdefault(rel, dist)
    return owners


def classify(rel: str, owners: dict[str, str]) -> str:
    """Return the part id that owns a file relative to ``packages/``."""
    owner = owners.get(rel)
    if owner in APP_DISTS:
        return "app"
    if owner:
        for part_id, dists in OPTIONAL_GROUPS.items():
            if owner in dists:
                return part_id
    return "deps-core"


def collect_package_files(packages: Path) -> dict[str, list[Path]]:
    """Partition every file under packages/ by part id."""
    owners = dist_owner_map(packages)
    buckets: dict[str, list[Path]] = {"deps-core": [], "app": []}
    for part_id in OPTIONAL_GROUPS:
        buckets[part_id] = []
    for path in sorted(packages.rglob("*")):
        if path.is_dir() and not path.is_symlink():
            continue
        rel = path.relative_to(packages).as_posix()
        buckets[classify(rel, owners)].append(path)
    return buckets


def add_one(tar: tarfile.TarFile, path: Path, arcname: str) -> None:
    info = tar.gettarinfo(str(path), arcname=arcname)
    info.uid = info.gid = 0
    info.uname = info.gname = ""
    info.mtime = FIXED_MTIME
    if info.isfile():
        with path.open("rb") as handle:
            tar.addfile(info, handle)
    else:
        tar.addfile(info)


def write_tar_gz(destination: Path, root: Path, rel_paths: list[Path], prefix: str = "") -> None:
    """Write ``rel_paths`` (all under ``root``) with optional archive prefix."""
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tarfile.open(destination, "w:gz", compresslevel=6) as tar:
        for path in rel_paths:
            rel = path.relative_to(root).as_posix()
            add_one(tar, path, f"{prefix}/{rel}" if prefix else rel)


def write_root_part(destination: Path, staging: Path) -> None:
    """Pack runtime/ plus the root launchers; target is the runtime root."""
    runtime = staging / "runtime"
    if not runtime.is_dir():
        raise SystemExit(f"runtime/ missing under {staging}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tarfile.open(destination, "w:gz", compresslevel=6) as tar:
        for path in sorted(runtime.rglob("*")):
            rel = path.relative_to(staging).as_posix()
            add_one(tar, path, rel)
        for name in ROOT_LAUNCHERS:
            path = staging / name
            if path.exists():
                add_one(tar, path, name)


def read_version_file(staging: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    version_file = staging / "VERSION.txt"
    if not version_file.is_file():
        return values
    for line in version_file.read_text(encoding="utf-8", errors="replace").splitlines():
        key, sep, value = line.partition("=")
        if sep:
            values[key.strip()] = value.strip()
    return values


def part_entry(
    part_id: str,
    archive: Path,
    base_urls: list[str],
    plat: str,
    target: str,
    required: bool,
    append: bool,
) -> dict:
    name = archive.name
    return {
        "id": part_id,
        "urls": [f"{base.rstrip('/')}/{plat}/{name}" for base in base_urls],
        "size": archive.stat().st_size,
        "sha256": sha256_of(archive),
        "format": "tar.gz",
        "target": target,
        "stripRoot": False,
        "append": append,
        "required": required,
    }


def build(staging: Path, plat: str, version: str, base_urls: list[str], out_dir: Path) -> Path:
    packages = staging / "packages"
    if not packages.is_dir():
        raise SystemExit(f"packages/ missing under {staging}")

    out = out_dir / plat
    out.mkdir(parents=True, exist_ok=True)

    runtime_tar = out / "runtime.tar.gz"
    write_root_part(runtime_tar, staging)

    buckets = collect_package_files(packages)
    if not buckets["app"]:
        raise SystemExit("no octop files found under packages/ — is the app staged?")
    if not buckets["deps-core"]:
        raise SystemExit("no dependency files found under packages/")

    archives: dict[str, Path] = {"runtime": runtime_tar}
    for part_id, files in buckets.items():
        archive = out / f"{part_id}.tar.gz"
        write_tar_gz(archive, packages, files)
        archives[part_id] = archive

    # Order matters: root first, then deps-core (wipes packages/), then app and
    # the optional shards (append into the tree deps-core created).
    parts = [
        part_entry("runtime", archives["runtime"], base_urls, plat, target="", required=True, append=False),
        part_entry("deps-core", archives["deps-core"], base_urls, plat, target="packages", required=True, append=False),
        part_entry("app", archives["app"], base_urls, plat, target="packages", required=True, append=True),
    ]
    for part_id in OPTIONAL_GROUPS:
        files = buckets.get(part_id) or []
        if not files:
            # Nothing installed for this group: omit the part instead of
            # publishing an empty archive.
            archives.pop(part_id, None)
            continue
        parts.append(
            part_entry(part_id, archives[part_id], base_urls, plat, target="packages", required=False, append=True)
        )

    meta = read_version_file(staging)
    document = {
        "schema": MANIFEST_SCHEMA,
        "version": version,
        "platform": plat,
        "python": meta.get("python"),
        "pbsTag": meta.get("pbs_tag"),
        "parts": parts,
    }
    manifest_path = out / "manifest.json"
    manifest_path.write_text(
        json.dumps(document, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    return manifest_path


def safe_zip_extract(zip_path: Path, dest: Path) -> Path:
    """Extract a portable zip, preserving Unix modes and symlinks.

    ``zipfile.extractall`` drops the mode bits the runtime's python binary
    needs, which would produce a shard that cannot be installed. The archive
    has a single top-level ``Octop-<plat>/`` directory, returned here.
    """
    dest.mkdir(parents=True, exist_ok=True)
    root: Path | None = None
    with zipfile.ZipFile(zip_path) as archive:
        for info in archive.infolist():
            rel = info.filename.replace("\\", "/")
            if rel.startswith("/") or any(part == ".." for part in rel.split("/")):
                raise SystemExit(f"illegal path in {zip_path.name}: {info.filename}")
            target = dest / rel
            mode = (info.external_attr >> 16) & 0xFFFF
            if info.is_dir():
                target.mkdir(parents=True, exist_ok=True)
                if mode:
                    os.chmod(target, mode)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            if stat.S_ISLNK(mode):
                link = archive.read(info).decode("utf-8")
                if target.exists() or target.is_symlink():
                    target.unlink()
                target.symlink_to(link)
                continue
            with archive.open(info) as source, target.open("wb") as sink:
                shutil.copyfileobj(source, sink)
            if mode:
                os.chmod(target, mode)
            if root is None:
                root = dest / rel.split("/", 1)[0]
    if root is None or not root.is_dir():
        raise SystemExit(f"{zip_path} has no top-level directory")
    return root


def infer_from_zip(zip_path: Path) -> tuple[str | None, str | None]:
    match = re.match(r"^Octop-portable-(?P<plat>.+?)-(?P<version>\d[^-]*)\.zip$", zip_path.name)
    if not match:
        return None, None
    return match.group("plat"), match.group("version")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Split an assembled portable runtime into shards + manifest."
    )
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--staging", help="assembled Octop-<plat>/ tree from package.sh")
    source.add_argument("--zip", help="Octop-portable-<plat>-<version>.zip from package.sh")
    parser.add_argument("--plat", default=None, help="platform key (inferred from --zip name)")
    parser.add_argument("--version", default=None, help="runtime version (inferred from --zip name)")
    parser.add_argument(
        "--base-url",
        action="append",
        default=[],
        help=(
            "base URL hosting <plat>/<file>; repeat once per mirror (first is "
            "primary). Defaults to a placeholder because PR-1 is artifact-only."
        ),
    )
    parser.add_argument("--out-dir", default=None, help="default: <release>/parts")
    args = parser.parse_args(argv)

    release = Path(__file__).resolve().parent / "release"
    out_dir = Path(args.out_dir) if args.out_dir else release / "parts"

    temp_dir: str | None = None
    if args.zip:
        zip_path = Path(args.zip).resolve()
        if not zip_path.is_file():
            raise SystemExit(f"zip not found: {zip_path}")
        inferred_plat, inferred_version = infer_from_zip(zip_path)
        temp_dir = tempfile.mkdtemp(prefix="octop-shards-")
        staging = safe_zip_extract(zip_path, Path(temp_dir))
        plat = args.plat or inferred_plat
        version = args.version or inferred_version
        if not plat or not version:
            raise SystemExit("cannot infer --plat/--version from the zip name; pass them explicitly")
    else:
        staging = Path(args.staging).resolve()
        if not staging.is_dir():
            raise SystemExit(f"staging tree not found: {staging}")
        plat = args.plat
        version = args.version
        if not plat or not version:
            raise SystemExit("--staging requires --plat and --version")

    base_urls = args.base_url or [f"{PLACEHOLDER_BASE_URL}/{version}"]
    if any(not base.startswith(("http://", "https://")) for base in base_urls):
        raise SystemExit("--base-url must start with http:// or https://")

    try:
        manifest = build(staging, plat, version, base_urls, out_dir)
    finally:
        if temp_dir:
            shutil.rmtree(temp_dir, ignore_errors=True)

    doc = json.loads(manifest.read_text(encoding="utf-8"))
    print(f"[runtime-shards] manifest: {manifest}")
    print(f"[runtime-shards] platform: {plat}  version: {version}  mirrors: {len(base_urls)}")
    for part in doc["parts"]:
        size_mb = part["size"] / (1024 * 1024)
        flags = f"required={part['required']} append={part['append']} target={part['target'] or '<root>'}"
        print(f"  - {part['id']:<12} {size_mb:8.1f} MB  {flags}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
