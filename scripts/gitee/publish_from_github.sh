#!/usr/bin/env bash
# Publish a GitHub Release to Gitee in one go.
#
#   scripts/gitee/publish_from_github.sh --tag v1.4.0 [--source-repo owner/repo]
#       [--owner webheat] [--repo octop_client] [--work-dir <dir>]
#       [--platform windows|all]
#
# Steps:
#   1. download the release assets that fit a Gitee attachment (< 100 MB)
#      and belong to the platform this round delivers
#   2. build the release notes from the GitHub release body
#   3. sync the download page into the Gitee repository
#   4. create the Gitee release (the tag points at the download page commit)
#      and upload the assets
#
# Tokens:
#   Gitee  $GITEE_TOKEN / ~/.gitee_token
#   GitHub $GH_TOKEN / ~/.github_token / ~/.git-credentials / the gh CLI
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

tag=""
source_repo=""
owner="webheat"
repo="octop_client"
work_dir=""
# This round delivers the Windows client only — see docs/desktop-windows-build.md.
platform="windows"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag) tag="$2"; shift 2 ;;
    --source-repo) source_repo="$2"; shift 2 ;;
    --owner) owner="$2"; shift 2 ;;
    --repo) repo="$2"; shift 2 ;;
    --work-dir) work_dir="$2"; shift 2 ;;
    --platform) platform="$2"; shift 2 ;;
    *) echo "usage: $0 --tag <v1.2.3> [--source-repo owner/repo] [--owner o] [--repo r] [--work-dir d] [--platform windows|all]" >&2; exit 2 ;;
  esac
done

[[ -n "$tag" ]] || { echo "usage: $0 --tag <v1.2.3> ..." >&2; exit 2; }
source_repo="${source_repo:-${GITHUB_REPOSITORY:-zhuimeng2026-hub/Octop}}"

if [[ -z "$work_dir" ]]; then
  work_dir="$(mktemp -d "${TMPDIR:-/tmp}/octop-gitee-XXXXXX")"
  trap 'rm -rf "$work_dir"' EXIT
fi
assets_dir="${work_dir}/assets"
mkdir -p "$assets_dir"

# --- the GitHub token ------------------------------------------------------
gh_token="${GH_TOKEN:-}"
if [[ -z "$gh_token" && -f "${HOME}/.github_token" ]]; then
  gh_token="$(tr -d '[:space:]' < "${HOME}/.github_token")"
fi
if [[ -z "$gh_token" && -f "${HOME}/.git-credentials" ]]; then
  gh_token="$(python3 - "${HOME}/.git-credentials" <<'PY'
import re, sys
for line in open(sys.argv[1], encoding="utf-8", errors="replace"):
    m = re.search(r"https://[^:]+:([^@]+)@github\.com", line)
    if m:
        print(m.group(1))
        break
PY
)"
fi
if [[ -z "$gh_token" ]] && command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  gh_token="$(gh auth token 2>/dev/null || true)"
fi
if [[ -z "$gh_token" ]]; then
  echo "::error::no GitHub token: set GH_TOKEN, write ~/.github_token, or log in with gh" >&2
  exit 1
fi

# --- 1. the assets that fit -------------------------------------------------
echo "Reading the release ${source_repo}@${tag} (platform: ${platform})"
GH_TOKEN="${gh_token}" python3 "${REPO_ROOT}/scripts/gitee/list_release_assets.py" \
  --repo "${source_repo}" --tag "${tag}" --platform "${platform}" > "${work_dir}/assets.tsv"

assets="$(cat "${work_dir}/assets.tsv")"

if [[ -z "$assets" ]]; then
  echo "::error::the release has no asset under 100 MB for platform ${platform}" >&2
  exit 1
fi

while IFS=$'\t' read -r name url; do
  [[ -n "$name" ]] || continue
  name="${name%$'\r'}"
  url="${url%$'\r'}"
  echo "  downloading ${name}"
  curl -sSL --max-time 1800 -H "Authorization: Bearer ${gh_token}" -o "${assets_dir}/${name}" "$url"
done <<< "$assets"

# --- 2. the release notes ---------------------------------------------------
GH_TOKEN="${gh_token}" python3 "${REPO_ROOT}/scripts/gitee/release_notes.py" \
  --repo "${source_repo}" --tag "${tag}" --platform "${platform}" \
  --gitee-owner "${owner}" --gitee-repo "${repo}" \
  --out "${work_dir}/release-notes.md"
# Windows: python text-mode writes CRLF; normalise so markdown and metadata stay clean.
sed -i 's/\r$//' "${work_dir}/release-notes.md"

# --- 3. the download page ---------------------------------------------------
sha="$(python3 "${REPO_ROOT}/scripts/gitee/push_readme.py" --owner "${owner}" --repo "${repo}" \
  --tag "${tag}" | tr -d '\r' | tail -1)"

# --- 4. the release ---------------------------------------------------------
bash "${REPO_ROOT}/scripts/gitee/publish_release.sh" \
  --tag "${tag}" --owner "${owner}" --repo "${repo}" \
  --assets-dir "${assets_dir}" \
  --body-file "${work_dir}/release-notes.md" \
  --base-sha "${sha}"
