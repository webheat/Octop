#!/usr/bin/env bash
# Split an assembled portable runtime into downloadable shards + a manifest.
#
# This is the thin shell entry point next to package.sh (which still emits the
# single zip, unchanged). The actual splitting lives in
# pack_portable_shards.py; arguments are forwarded verbatim.
#
# Usage:
#   bash desktop/portable/package-shards.sh \
#     --staging desktop/portable/release/Octop-windows-amd64 \
#     --plat windows-amd64 --version 1.4.0
#
#   bash desktop/portable/package-shards.sh \
#     --zip desktop/portable/release/Octop-portable-windows-amd64-1.4.0.zip
#
# Output: desktop/portable/release/parts/<plat>/ (parts + manifest.json).
# PR-1 produces artifacts only — nothing publishes or consumes them yet.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

py=""
if command -v python3 >/dev/null 2>&1; then
  py=python3
elif command -v python >/dev/null 2>&1; then
  py=python
else
  echo "[package-shards] need python3 or python on PATH" >&2
  exit 1
fi

exec "$py" "${REPO_ROOT}/desktop/portable/pack_portable_shards.py" "$@"
