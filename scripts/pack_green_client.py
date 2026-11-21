"""Package the green desktop client (bare exe + README, no installer).

PRD S5-S6 (2026-11-20) defines the default delivery form: a *green* package
that the user unpacks anywhere and runs by double-clicking `Octop.exe`. The
baseline is "the UI opens and the user can log in" — the rendering engine
(Remotion + Chromium + node_modules, ~228 MB) is NOT bundled. It is fetched on
demand from the component manifest URL after login and unpacked straight into
`<exe dir>/video-runtime`.

Why there is no `video-runtime/` skeleton in the package: the published
`core.zip` already carries node.exe, the worker scripts and the Remotion
dependency tree, and `bootstrap.Run` unpacks it into exactly that directory.
Shipping a second copy would double the download for no benefit.

Measured sizes on windows-amd64 (2026-11-20):

    Octop.exe                    13.0 MB
    zip (deflate -mx=9)           5.3 MB   -> ~95 MB headroom under Gitee's
    7z  (-mx=9, lzma2)            4.1 MB      100 MB per-attachment cap

Usage:

    python scripts/pack_green_client.py --version 1.4.1 \
        --exe desktop/src/bin/Octop.exe \
        --out-dir desktop/src/bin

The exe must already be built with the remote shell tag and the component
manifest URL baked in (see docs/desktop-windows-build.md); this script only
assembles the archive.
"""

from __future__ import annotations

import argparse
import hashlib
import pathlib
import shutil
import subprocess
import sys
import tempfile
import zipfile

SEVENZIP_CANDIDATES = [
    r"C:\Program Files\7-Zip\7z.exe",
    r"C:\Program Files (x86)\7-Zip\7z.exe",
]

README_TEMPLATE = """Octop 桌面客户端 — 绿色版 {version}（Windows amd64）
====================================================

免安装。解压到任意可写目录，双击 Octop.exe 即可运行。

目录结构
--------
  Octop.exe              主程序（远程壳，加载线上界面）
  README.txt             本文件

本版包含什么
------------
  * 界面与后端由客户端自行连接已部署好的服务，无需手动配置，需网络连接。
  * 登录、产品库、素材库、方案编辑等功能登录后即可直接使用。
  * 本机视频渲染所需的渲染引擎（Node + Remotion + Chromium，约 228 MB）
    **未随包附带**。在界面「视频环境」页点「一键安装」即从服务端下载，
    安装到本目录的 video-runtime/ 子目录，安装后本机即可出片。
    未安装前该页面显示「需要安装」，其余功能不受影响。

重要说明
--------
  * 请解压到可写目录（不要放 C:\\Program Files）：视频环境安装会写入程序同级目录。
  * 需要 Microsoft Edge WebView2 Runtime。Windows 11 与多数 Windows 10 已自带。
  * 首次点「一键安装」需下载约 228 MB，耗时取决于网络。

版本: {version}（windows-amd64，thin 绿色版）
"""


def find_sevenzip() -> str | None:
    for candidate in SEVENZIP_CANDIDATES:
        if pathlib.Path(candidate).is_file():
            return candidate
    found = shutil.which("7z")
    return found


def run7z(exe: str, args: list[str], cwd: pathlib.Path) -> None:
    """Run 7-Zip and fail loudly.

    7-Zip writes its console output in the OEM/GBK codepage on Chinese
    Windows, so decoding stdout as UTF-8 raises. Capture bytes and decode
    leniently instead.
    """
    proc = subprocess.run([exe, *args], capture_output=True, cwd=cwd)
    if proc.returncode != 0:
        out = (proc.stdout or b"").decode("gbk", errors="replace")
        err = (proc.stderr or b"").decode("gbk", errors="replace")
        raise SystemExit(f"7z failed: {out[-500:]}\n{err[-500:]}")


def sha256_of(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Package the green (no-installer) desktop client."
    )
    parser.add_argument("--exe", required=True, help="path to the built Octop.exe")
    parser.add_argument("--out-dir", default="desktop/src/bin")
    parser.add_argument("--version", required=True)
    parser.add_argument(
        "--no-7z", action="store_true", help="skip the 7z variant (zip is always built)"
    )
    args = parser.parse_args(argv)

    exe_path = pathlib.Path(args.exe).resolve()
    out_dir = pathlib.Path(args.out_dir).resolve()
    if not exe_path.is_file():
        raise SystemExit(f"missing exe: {exe_path}")
    out_dir.mkdir(parents=True, exist_ok=True)

    readme = README_TEMPLATE.format(version=args.version)

    with tempfile.TemporaryDirectory(prefix="octop-green-") as tmp:
        stage = pathlib.Path(tmp)
        shutil.copy2(exe_path, stage / "Octop.exe")
        (stage / "README.txt").write_text(readme, encoding="utf-8")

        print(f"exe: {exe_path.stat().st_size / 1024 / 1024:.1f} MB")

        outputs: list[pathlib.Path] = []

        # zip first: Windows extracts it without any third-party tool.
        zip_out = out_dir / f"Octop-green-windows-amd64-{args.version}.zip"
        if zip_out.exists():
            zip_out.unlink()
        with zipfile.ZipFile(
            zip_out, "w", zipfile.ZIP_DEFLATED, compresslevel=9
        ) as archive:
            archive.write(stage / "Octop.exe", "Octop.exe")
            archive.write(stage / "README.txt", "README.txt")
        outputs.append(zip_out)

        seven_out = out_dir / f"Octop-green-windows-amd64-{args.version}.7z"
        if not args.no_7z:
            sevenzip = find_sevenzip()
            if not sevenzip:
                print("7-Zip not found; the zip variant is complete on its own")
            else:
                if seven_out.exists():
                    seven_out.unlink()
                # The archive must NOT live inside the directory being archived:
                # 7-Zip would pick up its own growing output file and inflate
                # without bound. cwd=stage makes the relative names resolve
                # there while the archive itself is written to out_dir.
                run7z(
                    sevenzip,
                    [
                        "a",
                        "-t7z",
                        "-mx=9",
                        "-m0=lzma2",
                        "-ms=off",
                        str(seven_out),
                        "Octop.exe",
                        "README.txt",
                    ],
                    cwd=stage,
                )
                outputs.append(seven_out)

        for out in outputs:
            size_mb = out.stat().st_size / 1024 / 1024
            print(f"\nOUT: {out.name}")
            print(f"  size: {size_mb:.1f} MB")
            print(f"  headroom vs 100MB: {100 - size_mb:.1f} MB")
            print(f"  sha256: {sha256_of(out)}")
            if out.suffix == ".zip":
                with zipfile.ZipFile(out) as archive:
                    bad = archive.testzip()
                    names = archive.namelist()
                    print(f"  crc: {'OK' if bad is None else 'FAILED ' + bad}")
                    print(f"  entries: {names}")
                    for want in ("Octop.exe", "README.txt"):
                        print(f"    {want}: {'OK' if want in names else 'MISSING'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
