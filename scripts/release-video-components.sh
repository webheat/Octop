#!/usr/bin/env bash
#
# 一键发布桌面端「视频制作组件」到下载站：打包 → 上传 → 校验 → 输出构建注入变量。
#
# 背景：core.zip / browser.zip 由 scripts/pack_video_components.py 产出，
#       客户端通过 manifest.json 逐 part 下载（断点续传 + SHA256 校验）。
#       manifest URL 由构建时注入 defaultVideoComponentsURL，运行时可用
#       OCTOP_DESKTOP_VIDEO_COMPONENTS_URL 覆盖。本脚本负责「包 + URL」这一段。
#
# 用法：
#   # 1) 只打包 + 本地校验（不上传，安全；先跑这个看产物）
#   ./scripts/release-video-components.sh --base-url http://dw.mengxa.com/video-components/1.4.0/win-x64
#
#   # 2) 打包 + 上传四台 + 逐台校验（四台各自独立磁盘，文件必须放四份）
#   ./scripts/release-video-components.sh \
#       --base-url https://dw.mengxa.com/video-components/1.4.0/win-x64 \
#       --host 175.178.192.87 --host 8.134.147.195 \
#       --host 1.14.182.208 --host 175.178.33.107 \
#       --upload
#   # SSH 端口默认 13122，Web 根目录默认 /opt/dw.mengxa.com（可用环境变量覆盖）
#   # 推荐：manifest 内每个 part 的 urls[] 只写域名两档「https 域名(主) + http 域名(兜底)」，
#   # 客户端 bootstrap 逐个探测。2026-11-20 起不再写 IP 直连地址，统一走 dw.mengxa.com；
#   # 前提是 DNS 每个节点在 HTTP 上都真的出文件（1.14.182.208 已改为 80 端口直接出文件）。
#   #   ./scripts/release-video-components.sh \
#   #       --base-url https://dw.mengxa.com/video-components/1.4.0/win-x64 \
#   #       --mirror http://dw.mengxa.com/video-components/1.4.0/win-x64 \
#   #       --host ... --upload
#   # 客户端注入同样用逗号分隔多 URL：defaultVideoComponentsURL=https域名,http域名
#
#   # 3) 只校验远端已发布的包（逐台 SSH 比对 sha256；不打包不上传）
#   ./scripts/release-video-components.sh --base-url ... --verify-only --host ...
#
#   # 4) nginx server 块 + HTTPS 配好后，追加 HTTP 探活（--resolve 逐台）
#   ./scripts/release-video-components.sh --base-url https://... --verify-only \
#       --host ... --verify-http
#
#   # 5) 发布机上先重新 stage 带 headless-shell 的 runtime，再打包成 core+browser 两包
#     （必须在 Windows 主机跑；会覆盖 desktop/src/video-runtime！）
#   ./scripts/release-video-components.sh --base-url ... --build-runtime
#
#   ./scripts/release-video-components.sh --help
#
# 重要语义（踩坑点）：
#   - --base-url 是「组件目录的完整 URL」，必须带 <版本>/<target>；脚本会把它
#     原样传给 pack_video_components.py，URL 会被写死进 manifest 的每个 part。
#     换域名/换目录必须重跑本脚本重新打包，改客户端注入URL是没用的。
#   - 远端目录 = --web-root + base-url 的 path 部分（自动拼，不会重复层级）。
#   - --allow-insecure 只在确认「客户端接受明文 manifest」时才加。HTTP 明文清单
#     可被中间人替换 sha256 指向恶意 zip；长期方案必须上 HTTPS。
#   - 两包是硬要求：core.zip + browser.zip 缺一不可。若 staged runtime 是旧的
#     browserMode=system（无 headless-shell），脚本会直接失败；用 --build-runtime
#     在 Windows 发布机上重新 stage 出带 headless-shell 的 runtime。
#   - 容灾：DNS 轮询无法感知节点故障，不能自动切换。每个 part 的 urls[] 要写入
#     全部镜像地址，由客户端 bootstrap 逐个尝试 + SHA256 校验后切换。用 --mirror
#     追加镜像（第一个 --base-url 为主），全部镜像必须是同一份文件的可访问地址。
#   - 四台是各自独立磁盘（/opt 非共享挂载），文件必须逐台放四份；上传后用 SSH
#     逐台 sha256sum 比对，确保四台逐字节一致 —— 这是容灾切换的前提。DNS 轮询
#     的 HTTP 回读只能验到一台，默认不做；配好 nginx+HTTPS 后用 --verify-http 补。
#
# 可覆盖的环境变量：
#   OCTOP_VC_TARGET         架构 (默认 win-x64)
#   OCTOP_VC_VERSION        组件版本 (默认 pyproject.toml 的 version)
#   OCTOP_VC_OUT_DIR        产物目录 (默认 dist/video-components)
#   OCTOP_VC_RUNTIME_DIR    staged runtime (默认 desktop/src/video-runtime)
#   OCTOP_VC_PYTHON         Python 解释器 (默认探测 .venv 再退回 python3/python)
#   OCTOP_VC_DEPLOY_HOSTS    SSH 主机列表，逗号分隔 (推荐；与 --host 等价)
#   OCTOP_VC_DEPLOY_HOST    单个 SSH 主机 (兼容旧用法，会并入列表)
#   OCTOP_VC_DEPLOY_USER    SSH 用户 (默认 root)
#   OCTOP_VC_DEPLOY_PORT    SSH 端口 (默认 13122 —— dw 四台统一端口)
#   OCTOP_VC_DEPLOY_KEY     SSH 私钥 (默认探测 D:/.ssh/id_ed25519 或 ~/.ssh/id_ed25519)
#   OCTOP_VC_WEB_ROOT       Web 根目录 (默认 /opt/dw.mengxa.com)
#   OCTOP_VC_CURL_NOPROXY   设 1 则 curl 用 --noproxy '*' (默认 1，绕开本机代理)
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${OCTOP_VC_TARGET:-win-x64}"
# kind=component (video core/browser zips, the original behaviour) or
# kind=runtime (portable runtime tar.gz shards for slim clients).
KIND="${OCTOP_VC_KIND:-component}"
OUT_DIR="${OCTOP_VC_OUT_DIR:-$REPO_ROOT/dist/video-components}"
RUNTIME_DIR="${OCTOP_VC_RUNTIME_DIR:-$REPO_ROOT/desktop/src/video-runtime}"
DEPLOY_USER="${OCTOP_VC_DEPLOY_USER:-root}"
DEPLOY_PORT="${OCTOP_VC_DEPLOY_PORT:-13122}"
CURL_NOPROXY="${OCTOP_VC_CURL_NOPROXY:-1}"
# Parallel range requests per part. The download host throttles one connection
# to a few hundred KB/s while its nodes are independent machines, so several
# ranges are what turn a 110 MB part into a couple of minutes.
CONNECTIONS="${OCTOP_VC_CONNECTIONS:-4}"

BASE_URL=""
MIRROR_URLS=()
SHARDS_ZIP="${OCTOP_VC_SHARDS_ZIP:-}"
VERSION="${OCTOP_VC_VERSION:-}"
WEB_ROOT="${OCTOP_VC_WEB_ROOT:-/opt/dw.mengxa.com}"
DEPLOY_HOSTS=()
# 环境变量提供默认值（逗号分隔），--host 可继续追加
if [ -n "${OCTOP_VC_DEPLOY_HOSTS:-}" ]; then
  IFS=',' read -r -a _env_hosts <<< "$OCTOP_VC_DEPLOY_HOSTS"
  for h in "${_env_hosts[@]}"; do [ -n "$h" ] && DEPLOY_HOSTS+=("$h"); done
fi
if [ -n "${OCTOP_VC_DEPLOY_HOST:-}" ]; then DEPLOY_HOSTS+=("$OCTOP_VC_DEPLOY_HOST"); fi
SSH_KEY="${OCTOP_VC_DEPLOY_KEY:-}"
DO_PACK=1
DO_UPLOAD=0
DO_VERIFY=0
VERIFY_ONLY=0
VERIFY_HTTP=0
ALLOW_INSECURE=0
BUILD_RUNTIME=0

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '\033[33m    ! %s\033[0m\n' "$*"; }
die()  { printf '\033[31m    x %s\033[0m\n' "$*" >&2; exit 1; }

usage() { sed -n '2,40p' "${BASH_SOURCE[0]}"; }

while (($#)); do
  case "$1" in
    --base-url)       BASE_URL="${2:-}"; shift 2 ;;
    --mirror)         MIRROR_URLS+=("${2:-}"); shift 2 ;;
    --kind)           KIND="${2:-}"; shift 2 ;;
    --shards-zip)     SHARDS_ZIP="${2:-}"; shift 2 ;;
    --version)        VERSION="${2:-}"; shift 2 ;;
    --target)         TARGET="${2:-}"; shift 2 ;;
    --connections)    CONNECTIONS="${2:-}"; shift 2 ;;
    --web-root)       WEB_ROOT="${2:-}"; shift 2 ;;
    --host)           DEPLOY_HOSTS+=("${2:-}"); shift 2 ;;
    --user)           DEPLOY_USER="${2:-}"; shift 2 ;;
    --port)           DEPLOY_PORT="${2:-}"; shift 2 ;;
    --key)            SSH_KEY="${2:-}"; shift 2 ;;
    --upload)         DO_UPLOAD=1; shift ;;
    --no-pack)        DO_PACK=0; shift ;;
    --build-runtime)  BUILD_RUNTIME=1; shift ;;
    --verify-only)    VERIFY_ONLY=1; DO_PACK=0; DO_UPLOAD=0; DO_VERIFY=1; shift ;;
    --verify-http)    VERIFY_HTTP=1; shift ;;
    --no-verify)      DO_VERIFY=0; shift ;;
    --allow-insecure) ALLOW_INSECURE=1; shift ;;
    -h|--help)        usage; exit 0 ;;
    *) die "未知参数: $1 (用 --help 看用法)" ;;
  esac
done

# --- Python 解释器 ---
PY="${OCTOP_VC_PYTHON:-}"
if [ -z "$PY" ]; then
  if [ -x "$REPO_ROOT/.venv/Scripts/python.exe" ]; then
    PY="$REPO_ROOT/.venv/Scripts/python.exe"
  elif [ -x "$REPO_ROOT/.venv/bin/python" ]; then
    PY="$REPO_ROOT/.venv/bin/python"
  elif command -v python3 >/dev/null 2>&1; then
    PY="python3"
  elif command -v python >/dev/null 2>&1; then
    PY="python"
  else
    die "找不到 Python 解释器"
  fi
fi

# --- 参数校验 ---
[ -n "$BASE_URL" ] || die "必须给 --base-url（组件目录完整 URL，含 <版本>/<target>）"
case "$BASE_URL" in
  http://*)  SCHEME=http ;;
  https://*) SCHEME=https ;;
  *) die "--base-url 必须是 http:// 或 https:// 开头" ;;
esac
if [ "$SCHEME" = http ] && [ "$ALLOW_INSECURE" -ne 1 ] && [ "$VERIFY_ONLY" -ne 1 ]; then
  die "HTTP 明文 manifest 有被篡改风险（可替换 sha256 指向恶意包）。确认接受请用 --allow-insecure，或改用 HTTPS。"
fi

if [ -z "$VERSION" ]; then
  VERSION="$("$PY" -c 'import re,pathlib,sys; t=pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"); m=re.search(r"^version\s*=\s*\"([^\"]+)\"", t, re.M); print(m.group(1) if m else "")' "$REPO_ROOT/pyproject.toml")"
fi
[ -n "$VERSION" ] || die "无法从 pyproject.toml 读版本，请用 --version 指定"

PART_DIR="$OUT_DIR/$TARGET"
MANIFEST="$PART_DIR/manifest.json"
MANIFEST_URL="${BASE_URL%/}/manifest.json"
BASE_PATH="$("$PY" -c 'import sys,urllib.parse; print(urllib.parse.urlparse(sys.argv[1]).path.strip("/"))' "$BASE_URL")"

say "组件发布配置"
info "target      = $TARGET"
info "version     = $VERSION"
info "base-url    = $BASE_URL  (primary)"
for mirror in "${MIRROR_URLS[@]}"; do info "mirror      = $mirror"; done
info "connections = $CONNECTIONS  (parallel range requests per part)"
info "manifest    = $MANIFEST_URL"
if [ "$DO_UPLOAD" -eq 1 ] || [ "$VERIFY_ONLY" -eq 1 ]; then
  info "remote dir  = ${WEB_ROOT%/}/${BASE_PATH}"
  info "ssh         = $DEPLOY_USER@<${#DEPLOY_HOSTS[@]} hosts>:$DEPLOY_PORT"
  for h in "${DEPLOY_HOSTS[@]}"; do info "  host      = $h"; done
fi

# --- 重新 stage runtime（可选）：带 headless-shell，才能打出 browser part ---
if [ "$BUILD_RUNTIME" -eq 1 ]; then
  BUILD_JS="$REPO_ROOT/remotion/build-desktop-runtime.mjs"
  [ -f "$BUILD_JS" ] || die "找不到 $BUILD_JS"
  command -v node >/dev/null 2>&1 || die "找不到 node（build-desktop-runtime.mjs 需要 Node + Windows 主机）"
  case "$(uname -s 2>/dev/null)" in
    MINGW*|MSYS*|CYGWIN*) ;;
    *) warn "当前不像 Windows 主机；build-desktop-runtime.mjs 硬要求 process.platform === win32" ;;
  esac
  warn "即将覆盖 $RUNTIME_DIR —— 这是构建脚本的硬编码输出目录，当前内容会先备份"
  if [ -d "$RUNTIME_DIR" ]; then
    BACKUP="${RUNTIME_DIR}.bak.$(date +%Y%m%d-%H%M%S)"
    mv "$RUNTIME_DIR" "$BACKUP" || die "备份 runtime 失败"
    info "已备份到 $BACKUP"
  fi
  say "重新 stage runtime (build-desktop-runtime.mjs，会下载 Node + Remotion + headless-shell，约数百 MB)"
  node "$BUILD_JS" --target "$TARGET" --output "$RUNTIME_DIR" \
    || die "stage runtime 失败（备份保留在原处，可手动还原）"
fi

# --- 打包 ---
if [ "$DO_PACK" -eq 1 ]; then
  if [ "$KIND" = "runtime" ]; then
    # 运行时分片模式：从已构建的 portable zip 切出 runtime/deps/app 分片 + manifest
    [ -n "$SHARDS_ZIP" ] || die "--kind runtime 必须给 --shards-zip（Octop-portable-*.zip 路径）"
    [ -f "$SHARDS_ZIP" ] || die "shards zip 不存在: $SHARDS_ZIP"
    SCRIPT="$REPO_ROOT/desktop/portable/pack_portable_shards.py"
    [ -f "$SCRIPT" ] || die "找不到 $SCRIPT"
    say "打包运行时分片 (pack_portable_shards.py)"
    PACK_ARGS=(--zip "$SHARDS_ZIP" --version "$VERSION" --base-url "$BASE_URL")
    for mirror in "${MIRROR_URLS[@]}"; do
      PACK_ARGS+=(--base-url "$mirror")
    done
    PACK_ARGS+=(--out-dir "$OUT_DIR")
    "$PY" "$SCRIPT" "${PACK_ARGS[@]}" || die "运行时分片打包失败"
    # pack_portable_shards.py 产物在 <out-dir>/<plat>/，plat 从 zip 名推断
    # (windows-amd64)，与 build target (win-x64) 不同 —— 从产物实际目录解析，
    # 不要假设 $TARGET。注意 --base-url 也不要带 plat：脚本会自动追加 <plat>/。
    local_plat="$("$PY" -c 'import sys,os; print([d for d in os.listdir(sys.argv[1]) if os.path.isdir(os.path.join(sys.argv[1],d)) and os.path.isfile(os.path.join(sys.argv[1],d,"manifest.json"))][0])' "$OUT_DIR" 2>/dev/null)"
    [ -n "$local_plat" ] || die "无法从产物推断 platform 目录（期望 <out-dir>/<plat>/manifest.json）"
    info "   runtime platform key = $local_plat"
    PART_DIR="$OUT_DIR/$local_plat"
    MANIFEST="$PART_DIR/manifest.json"
  else
    [ -d "$RUNTIME_DIR" ] || die "staged runtime 不存在: $RUNTIME_DIR（用 --build-runtime 或在 Windows 跑 wails3 task windows:components:package）"
    say "打包组件 (pack_video_components.py)"
    PACK_ARGS=(--target "$TARGET" --version "$VERSION" --base-url "$BASE_URL")
    for mirror in "${MIRROR_URLS[@]}"; do
      PACK_ARGS+=(--base-url "$mirror")
    done
    PACK_ARGS+=(--out-dir "$OUT_DIR" --runtime-dir "$RUNTIME_DIR" --connections "$CONNECTIONS")
    "$PY" "$REPO_ROOT/scripts/pack_video_components.py" "${PACK_ARGS[@]}" || die "打包失败"

    # 两包是硬要求：缺 browser part 说明 headless-shell 没 staged，拒绝发布不完整清单
    if ! grep -q '"id": "browser"' "$MANIFEST" 2>/dev/null; then
      die "产物缺少 browser part —— staged runtime 无 headless-shell（browserMode=system）。在 Windows 发布机加 --build-runtime 重新 stage 后再打包。"
    fi
    info "两包齐全：core + browser"
  fi
fi

[ -f "$MANIFEST" ] || die "找不到 $MANIFEST（先不带 --no-pack 跑一次）"

# 依 kind 决定上传的文件扩展名：运行时分片是 *.tar.gz，视频组件是 *.zip
if [ "$KIND" = "runtime" ]; then
  UPLOAD_GLOB='*.tar.gz'
else
  UPLOAD_GLOB='*.zip'
fi

# --- 本地校验：manifest 里的 sha256/size 必须与实际 zip 一致 ---
say "本地校验 (manifest sha256 / size vs 实际文件)"
MANIFEST_PATH="$MANIFEST" PART_DIR="$PART_DIR" "$PY" - <<'PY' || die "本地校验失败"
import hashlib, json, os, sys
from pathlib import Path
manifest = Path(os.environ["MANIFEST_PATH"])
part_dir = Path(os.environ["PART_DIR"])
doc = json.loads(manifest.read_text(encoding="utf-8"))
print(f"    schema={doc['schema']} version={doc['version']} platform={doc['platform']}")
for part in doc["parts"]:
    name = part["urls"][0].rsplit("/", 1)[-1]
    path = part_dir / name
    if not path.is_file():
        raise SystemExit(f"  缺少 part 文件: {path}")
    size = path.stat().st_size
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    ok = size == part["size"] and digest == part["sha256"]
    print(f"    {'OK ' if ok else 'BAD'} {name:<12} {size/1048576:8.1f} MB  sha256={digest[:12]}")
    if not ok:
        raise SystemExit(f"  {name} 校验不符: size {size} vs {part['size']}, sha256 {digest[:12]} vs {part['sha256'][:12]}")
PY

# --- 上传（逐台，四台是独立磁盘） ---
if [ "$DO_UPLOAD" -eq 1 ]; then
  [ "${#DEPLOY_HOSTS[@]}" -gt 0 ] || die "上传必须给 --host（可重复）或 OCTOP_VC_DEPLOY_HOSTS"
  [ -n "$WEB_ROOT" ]    || die "上传必须给 --web-root 或 OCTOP_VC_WEB_ROOT"
  command -v ssh >/dev/null 2>&1 || die "找不到 ssh"
  command -v scp >/dev/null 2>&1 || die "找不到 scp"
  if [ -z "$SSH_KEY" ]; then
    for cand in "D:/.ssh/id_ed25519" "$HOME/.ssh/id_ed25519"; do
      [ -f "$cand" ] && { SSH_KEY="$cand"; break; }
    done
  fi
  [ -n "$SSH_KEY" ] && [ -f "$SSH_KEY" ] || die "找不到 SSH 私钥（用 --key 指定）"

  REMOTE_DIR="${WEB_ROOT%/}/${BASE_PATH}"
  SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 -o BatchMode=yes)
  [ -n "$SSH_KEY" ] && SSH_OPTS+=(-i "$SSH_KEY")
  [ -n "$DEPLOY_PORT" ] && SSH_OPTS+=(-p "$DEPLOY_PORT")
  # scp 的端口开关是大写 -P（小写 -p 是"保留时间戳"，会被误当文件名）
  SCP_OPTS=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 -o BatchMode=yes)
  [ -n "$SSH_KEY" ] && SCP_OPTS+=(-i "$SSH_KEY")
  [ -n "$DEPLOY_PORT" ] && SCP_OPTS+=(-P "$DEPLOY_PORT")

  mapfile -t UPLOAD_FILES < <(find "$PART_DIR" -maxdepth 1 -type f \( -name "$UPLOAD_GLOB" -o -name 'manifest.json' \) -print)
  [ "${#UPLOAD_FILES[@]}" -gt 0 ] || die "没有可上传的文件"
  info "待上传($(basename "$MANIFEST") 同目录): $(for f in "${UPLOAD_FILES[@]}"; do basename "$f"; done | tr '\n' ' ')"
  info "远端目录: $REMOTE_DIR  (共 ${#DEPLOY_HOSTS[@]} 台)"

  for h in "${DEPLOY_HOSTS[@]}"; do
    say "上传 → $h"
    ssh "${SSH_OPTS[@]}" "$DEPLOY_USER@$h" "mkdir -p '$REMOTE_DIR' && chmod 755 '${WEB_ROOT%/}' '$REMOTE_DIR'" \
      || die "[$h] 远端建目录失败"
    scp "${SCP_OPTS[@]}" "${UPLOAD_FILES[@]}" "$DEPLOY_USER@$h:$REMOTE_DIR/" || die "[$h] 上传失败"
    ssh "${SSH_OPTS[@]}" "$DEPLOY_USER@$h" "chmod 644 '$REMOTE_DIR/'manifest.json $REMOTE_DIR/$UPLOAD_GLOB" || die "[$h] 设权限失败"
  done
  DO_VERIFY=1
fi

# --- 逐台校验：SSH 比对每份文件的 sha256（DNS 轮询回读只验一台，不可靠） ---
if [ "$DO_VERIFY" -eq 1 ]; then
  [ "${#DEPLOY_HOSTS[@]}" -gt 0 ] || die "校验必须给 --host 或 OCTOP_VC_DEPLOY_HOSTS"
  # 复用上传阶段建立的 SSH 参数（--verify-only 单独跑时在此重建）
  if [ -z "${SSH_OPTS+x}" ]; then
    if [ -z "$SSH_KEY" ]; then
      for cand in "D:/.ssh/id_ed25519" "$HOME/.ssh/id_ed25519"; do
        [ -f "$cand" ] && { SSH_KEY="$cand"; break; }
      done
    fi
    [ -n "$SSH_KEY" ] && [ -f "$SSH_KEY" ] || die "找不到 SSH 私钥（用 --key 指定）"
    SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 -o BatchMode=yes -i "$SSH_KEY" -p "$DEPLOY_PORT")
  fi
  REMOTE_DIR="${WEB_ROOT%/}/${BASE_PATH}"
  # --verify-only 单独跑时没有经过上传段，需重建待校验文件清单
  if [ -z "${UPLOAD_FILES+x}" ]; then
    mapfile -t UPLOAD_FILES < <(find "$PART_DIR" -maxdepth 1 -type f \( -name "$UPLOAD_GLOB" -o -name 'manifest.json' \) -print)
    [ "${#UPLOAD_FILES[@]}" -gt 0 ] || die "本地产物目录无可校验文件: $PART_DIR"
  fi
  say "逐台校验 sha256（每台 1 次 SSH 批量比对，避免触发 sshd 连接频率限制）"
  # 本地基准：一次性算出所有文件的 sha256，格式 "sha256  filename"
  # Git Bash 的 sha256sum 输出为 "hash *file"（* 表二进制），sed 去掉 * 以对齐远端 Linux 格式
  LOCAL_SUMS="$(cd "$PART_DIR" && sha256sum "${UPLOAD_FILES[@]##*/}" 2>/dev/null | sed 's/ \*/  /')"
  for h in "${DEPLOY_HOSTS[@]}"; do
    info "--- $h ---"
    # 每台只发 1 次 SSH：远端 cwd 到目标目录后批量 sha256sum
    REMOTE_SUMS="$(ssh "${SSH_OPTS[@]}" "$DEPLOY_USER@$h" "cd '$REMOTE_DIR' && sha256sum ${UPLOAD_FILES[*]##*/}" 2>/dev/null)"
    [ -n "$REMOTE_SUMS" ] || die "[$h] SSH 校验无响应（可能被频率限制断开），稍后重跑 --verify-only"
    ok_remote=1
    while read -r lsha lname; do
      [ -n "$lsha" ] || continue
      rsha="$(printf '%s\n' "$REMOTE_SUMS" | awk -v n="$lname" '$2==n {print $1; exit}')"
      if [ "$lsha" = "$rsha" ] && [ -n "$rsha" ]; then
        info "  OK  $lname  ${lsha:0:12}"
      else
        warn "  BAD $lname  local=${lsha:0:12} remote=${rsha:-<缺失>}"
        ok_remote=0
      fi
    done <<< "$LOCAL_SUMS"
    [ "$ok_remote" -eq 1 ] || die "[$h] 文件校验不一致 —— 该台不可用于容灾，请修复后重跑 --verify-only"
  done
  info "四台文件逐字节一致 ✅"
fi

# --- 可选：HTTP 回读探活（需 nginx server 块 + HTTPS 已配好；--verify-http） ---
if [ "$VERIFY_HTTP" -eq 1 ]; then
  say "HTTP 逐台探活（--resolve 指定 IP，绕开 DNS 轮询）"
  command -v curl >/dev/null 2>&1 || die "找不到 curl"
  CURL_OPTS=(-fsS -m 30)
  [ "$CURL_NOPROXY" = 1 ] && CURL_OPTS+=(--noproxy '*')
  HOST_HEADER="$(printf '%s' "$BASE_URL" | sed -E 's#^https?://([^/]+).*#\1#')"
  SCHEME_HOST="$(printf '%s' "$BASE_URL" | sed -E 's#(^https?://[^/]+).*#\1#')"
  URL_PATH="$(printf '%s' "$BASE_URL" | sed -E 's#^https?://[^/]+##')"
  for h in "${DEPLOY_HOSTS[@]}"; do
    code=$(curl "${CURL_OPTS[@]}" -o /dev/null -w "%{http_code}" --resolve "$HOST_HEADER:$([ "$SCHEME" = https ] && echo 443 || echo 80):$h" \
      "$SCHEME_HOST$URL_PATH/manifest.json" 2>/dev/null) || code="ERR"
    if [ "$code" = "200" ]; then info "  $h  HTTP 200 ✅"; else warn "  $h  HTTP $code ❌（nginx server 块/证书未就绪时属预期）"; fi
  done
fi

# --- 输出构建注入命令 ---
say "发布完成 — 构建客户端时注入下面变量（多镜像用逗号分隔）"
ALL_URLS="$MANIFEST_URL"
for mirror in "${MIRROR_URLS[@]}"; do ALL_URLS="$ALL_URLS,$mirror"; done
info "构建时: export OCTOP_DESKTOP_VIDEO_COMPONENTS_URL='$ALL_URLS'"
info "        ./desktop/package-release.sh --platform windows-x64   # 该脚本会转成 VIDEO_COMPONENTS_URL ldflags 注入"
info "运行时覆盖(免重打包): set OCTOP_DESKTOP_VIDEO_COMPONENTS_URL=$ALL_URLS"
info "已发布主机: $(for h in "${DEPLOY_HOSTS[@]}"; do printf '%s ' "$h"; done)"
info "远端目录:   ${WEB_ROOT%/}/${BASE_PATH}"
if [ "$VERIFY_HTTP" -ne 1 ]; then
  info "提示: nginx server 块 + HTTPS 配好后，加 --verify-http 做 HTTP 逐台探活。"
fi
if [ "$SCHEME" = http ]; then
  warn "当前是 HTTP 明文 manifest；签名/HTTPS 落地前，客户端下载链路存在中间人替换风险。"
fi
