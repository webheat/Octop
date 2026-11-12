#!/usr/bin/env bash
#
# 一键把本机构建好的 Dashboard 产物同步到远端服务器。
#
#   ./scripts/deploy-dashboard.sh                 # 同步 src/octop/dashboard → 远端
#   ./scripts/deploy-dashboard.sh --build         # 先构建（BASE_URL=/videogen）再同步
#   ./scripts/deploy-dashboard.sh --dry-run       # 只看要改什么，不写远端
#   ./scripts/deploy-dashboard.sh --no-delete     # 保留远端旧 hash 文件（默认会清理）
#   ./scripts/deploy-dashboard.sh --restart       # 同步后重启 octop 服务（通常不需要）
#   ./scripts/deploy-dashboard.sh --help
#
# 传输方式：优先用本机 rsync（真增量）；本机没有 rsync 时（Windows/Git Bash 常见）
# 退化为 tar 流经同一条 ssh 通道，落到远端临时目录后由远端 rsync 做镜像。
# 两种方式的落地语义一致：默认 --delete，保留 __init__.py / .gitkeep，并自动备份上一版。
#
# 可覆盖的环境变量：
#   OCTOP_DEPLOY_HOST   (默认 ocdev.aixifs.com)
#   OCTOP_DEPLOY_PORT   (默认 13122)
#   OCTOP_DEPLOY_USER   (默认 root)
#   OCTOP_DEPLOY_DST    (默认 /opt/Octop/src/octop/dashboard)
#   OCTOP_DEPLOY_KEY    (默认自动探测 D:/.ssh/id_ed25519 或 ~/.ssh/id_ed25519)
#   OCTOP_DEPLOY_VERIFY (默认 https://ocbot.aixifs.com/videogen)
#   OCTOP_DEPLOY_BASE_PATH (默认 /videogen)
#   OCTOP_DEPLOY_KEEP_BACKUPS (默认 5)
set -uo pipefail

HOST="${OCTOP_DEPLOY_HOST:-ocdev.aixifs.com}"
PORT="${OCTOP_DEPLOY_PORT:-13122}"
REMOTE_USER="${OCTOP_DEPLOY_USER:-root}"
DST="${OCTOP_DEPLOY_DST:-/opt/Octop/src/octop/dashboard}"
VERIFY_URL="${OCTOP_DEPLOY_VERIFY:-https://ocbot.aixifs.com/videogen}"
BASE_PATH="${OCTOP_DEPLOY_BASE_PATH:-/videogen}"
KEEP_BACKUPS="${OCTOP_DEPLOY_KEEP_BACKUPS:-5}"
BACKUP_ROOT="${OCTOP_DEPLOY_BACKUP_ROOT:-/opt/octop-data/dashboard-backups}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="${OCTOP_DEPLOY_SRC:-$REPO_ROOT/src/octop/dashboard}"

# rsync 可能装在 C:\tools\rsync 但当前 shell 的 PATH 还没刷新
if ! command -v rsync >/dev/null 2>&1; then
  for cand in /c/tools/rsync /c/Program\ Files/cwRsync/bin "$HOME/bin"; do
    if [ -x "$cand/rsync.exe" ]; then PATH="$cand:$PATH"; export PATH; break; fi
    if [ -x "$cand/rsync" ]; then PATH="$cand:$PATH"; export PATH; break; fi
  done
fi

# Windows 上没有 POSIX 权限/属主概念，用 -a 会让每次比较都判定"有差异"而全量重传，
# 所以只按 大小+时间 判等，落地权限由 --chmod 统一。
RSYNC_OPTS=(-rlzt --chmod=D755,F644 --exclude=__init__.py --exclude=.gitkeep)

DO_BUILD=0
DRY_RUN=0
DO_DELETE=1
DO_BACKUP=1
DO_RESTART=0
DO_VERIFY=1

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '\033[33m    ! %s\033[0m\n' "$*"; }
die()  { printf '\n\033[31m[ERROR] %s\033[0m\n' "$*" >&2; exit 1; }

usage() {
  sed -n '2,24p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    --build)     DO_BUILD=1 ;;
    --dry-run|-n) DRY_RUN=1 ;;
    --no-delete) DO_DELETE=0 ;;
    --no-backup) DO_BACKUP=0 ;;
    --restart)   DO_RESTART=1 ;;
    --no-verify) DO_VERIFY=0 ;;
    --host)      HOST="$2"; shift ;;
    --port)      PORT="$2"; shift ;;
    --user)      REMOTE_USER="$2"; shift ;;
    --help|-h)   usage ;;
    *) die "未知参数: $1（--help 看用法）" ;;
  esac
  shift
done

# ---------- 0. 本地前置检查 ----------
say "本地检查"
command -v ssh >/dev/null || die "找不到 ssh"
[ -d "$SRC" ] || die "产物目录不存在: $SRC"

if [ "$DO_BUILD" = 1 ]; then
  command -v npm >/dev/null || die "找不到 npm，无法构建"
  info "构建前端（BASE_URL=$BASE_PATH）…"
  ( cd "$REPO_ROOT/dashboard" && MSYS_NO_PATHCONV=1 BASE_URL="$BASE_PATH" npm run build ) \
    || die "构建失败"
fi

[ -f "$SRC/index.html" ] || die "$SRC 里没有 index.html，先跑 --build 或 make build-frontend"
LOCAL_ENTRY="$(grep -oE 'assets/index\.[A-Za-z0-9_-]+\.js' "$SRC/index.html" | head -1)"
LOCAL_FILES="$(find "$SRC" -type f | wc -l | tr -d ' ')"
LOCAL_SIZE="$(du -sh "$SRC" | cut -f1)"
info "源目录   : $SRC"
info "文件数   : $LOCAL_FILES（$LOCAL_SIZE）"
info "入口 hash: ${LOCAL_ENTRY:-未识别}"
info "目标     : ${REMOTE_USER}@${HOST}:${PORT} → ${DST}"

case "$LOCAL_ENTRY" in
  assets/*) ;;
  *) die "index.html 里没识别到入口 chunk（assets/index.*.js），产物可能不是本次构建的；先跑 --build 重新构建再同步" ;;
esac

# 产物新鲜度：$SRC 是构建产物，源码在 dashboard/。
# 产物比源码旧 = 这次同步会把线上更新的界面回滚成旧版本，必须先重新构建。
if [ -d "$REPO_ROOT/dashboard/src" ]; then
  NEWEST_SRC="$(find "$REPO_ROOT/dashboard/src" -type f -newer "$SRC/index.html" -print -quit 2>/dev/null)"
  if [ -n "$NEWEST_SRC" ]; then
    MSG="产物已过期：$SRC/index.html 早于前端源码 $NEWEST_SRC；直接同步会把线上更新的界面回滚成旧版本"
    if [ "${OCTOP_DEPLOY_ALLOW_STALE:-}" = "1" ]; then
      warn "$MSG（已按 OCTOP_DEPLOY_ALLOW_STALE=1 放行）"
    else
      die "$MSG
先用 --build 重新构建；确认要部署现成产物再设 OCTOP_DEPLOY_ALLOW_STALE=1"
    fi
  fi
fi

# ---------- 1. 组装 ssh 参数 ----------
KEYFILE="${OCTOP_DEPLOY_KEY:-}"
if [ -z "$KEYFILE" ]; then
  for cand in /d/.ssh/id_ed25519 "$HOME/.ssh/id_ed25519" /c/Users/"${USERNAME:-$USER}"/.ssh/id_ed25519; do
    [ -f "$cand" ] && { KEYFILE="$cand"; break; }
  done
fi

SSH_ARGS=(-p "$PORT"
  -o StrictHostKeyChecking=accept-new
  -o ConnectTimeout=15
  -o ServerAliveInterval=15
  -o ServerAliveCountMax=4)
if [ -n "$KEYFILE" ] && [ -f "$KEYFILE" ]; then
  SSH_ARGS+=(-i "$KEYFILE" -o IdentitiesOnly=yes)
  info "密钥     : $KEYFILE"
else
  warn "没找到私钥，会提示输入密码"
fi

# 始终复用单条 SSH 连接：既省握手，也避免 sshd MaxStartups 限流把多次探活打断
CTRL_DIR="$(mktemp -d 2>/dev/null || echo /tmp)"
SSH_ARGS+=(-o ControlMaster=auto -o ControlPath="$CTRL_DIR/octop-deploy-%r@%h:%p" -o ControlPersist=180)

# 先用 BatchMode 探一次，决定后面是否可能多次要密码
say "连接探测"
if ssh "${SSH_ARGS[@]}" -o BatchMode=yes "${REMOTE_USER}@${HOST}" true 2>/dev/null; then
  AUTH_MODE="免密"
  info "免密登录可用 ✅"
else
  AUTH_MODE="密码"
  warn "免密不可用，下面会提示输入密码（只输一次，脚本会复用连接）"
fi

REMOTE_INFO="$(ssh "${SSH_ARGS[@]}" "${REMOTE_USER}@${HOST}" \
  "set -e; echo \"dir=\$(test -d '$DST' && echo yes || echo no)\"; echo \"files=\$(find '$DST' -type f 2>/dev/null | wc -l)\"; echo \"entry=\$(grep -oE 'assets/index\\.[A-Za-z0-9_-]+\\.js' '$DST/index.html' 2>/dev/null | head -1)\"; UNITS=\$(systemctl list-units --type=service --no-legend 2>/dev/null | awk '{print \$1}'); SVC=\$(echo \"\$UNITS\" | grep -m1 '^octop\\.service\$' || true); if [ -z \"\$SVC\" ]; then SVC=\$(echo \"\$UNITS\" | grep -m1 '^octop' || true); fi; echo \"svc=\$SVC\"" \
  )" || die "无法连接 ${REMOTE_USER}@${HOST}:${PORT}"
eval "$REMOTE_INFO"

say "远端现状"
info "目录     : $DST（存在=$dir）"
info "文件数   : $files"
info "入口 hash: ${entry:-无}"
info "服务单元 : ${svc:-未识别}"
if [ "${entry:-}" = "$LOCAL_ENTRY" ]; then
  info "状态     : 入口已一致（本次大概率无变化）"
else
  info "状态     : 需求同步 $LOCAL_ENTRY → $entry"
fi

if [ "$DRY_RUN" = 1 ]; then
  say "DRY-RUN"
  if command -v rsync >/dev/null; then
    info "本机有 rsync（$(rsync --version | head -1 | awk '{print $3}')），逐文件差异如下："
    DRY_DELETE_FLAG=""
    [ "$DO_DELETE" = 1 ] && DRY_DELETE_FLAG="--delete"
    rsync "${RSYNC_OPTS[@]}" -n $DRY_DELETE_FLAG --itemize-changes -e "ssh ${SSH_ARGS[*]}" \
      "$SRC/" "${REMOTE_USER}@${HOST}:${DST}/" \
      | sed 's/^/    /' | head -60
  else
    warn "本机没有 rsync，无法逐文件预览"
    info "将传输 $LOCAL_FILES 个文件（$LOCAL_SIZE），远端现有 $files 个文件"
    [ "$DO_DELETE" = 1 ] && info "将删除远端多余文件（保留 __init__.py / .gitkeep）"
    info "不写入任何内容（dry-run）"
  fi
  exit 0
fi

# ---------- 2. 备份（远端，rsync 之前） ----------
if [ "$DO_BACKUP" = 1 ] && [ "$dir" = "yes" ]; then
  say "远端备份上一版"
  ssh "${SSH_ARGS[@]}" "${REMOTE_USER}@${HOST}" "
    set -e
    if [ -f '$DST/index.html' ]; then
      mkdir -p '$BACKUP_ROOT'
      TS=\$(date +%Y%m%d-%H%M%S)
      cp -a '$DST' '$BACKUP_ROOT/'\$TS
      # 只保留最近 $KEEP_BACKUPS 份
      ls -1dt '$BACKUP_ROOT'/* 2>/dev/null | tail -n +\$(( $KEEP_BACKUPS + 1 )) | xargs -r rm -rf
      echo \"    backup=$BACKUP_ROOT/\$TS\"
    else
      echo '    目录为空，跳过备份'
    fi
  " || warn "备份失败（不阻断部署）"
fi

# ---------- 3. 同步 ----------
say "同步产物"
START_TS=$(date +%s)

if command -v rsync >/dev/null; then
  MODE="rsync 增量"
  DELETE_FLAG=""
  [ "$DO_DELETE" = 1 ] && DELETE_FLAG="--delete"
  rsync "${RSYNC_OPTS[@]}" $DELETE_FLAG --info=stats1 \
    -e "ssh ${SSH_ARGS[*]}" \
    "$SRC/" "${REMOTE_USER}@${HOST}:${DST}/" \
    || die "rsync 失败"
else
  MODE="tar→远端 rsync"
  # 远端脚本走位置参数，stdin 留给 tar 流，避免 here-doc 冲突
  REMOTE_CMD='set -e
DST="$1"; DO_DELETE="$2"
STAGE=$(mktemp -d /tmp/octop-dash.XXXXXX)
trap "rm -rf \"$STAGE\"" EXIT
tar xzf - -C "$STAGE"
[ -f "$STAGE/index.html" ] || { echo "STAGE_MISSING_INDEX" >&2; exit 3; }
mkdir -p "$DST"
if [ "$DO_DELETE" = "1" ]; then
  rsync -a --delete --exclude=__init__.py --exclude=.gitkeep "$STAGE/" "$DST/"
else
  rsync -a --exclude=__init__.py --exclude=.gitkeep "$STAGE/" "$DST/"
fi
echo "runtime_files=$(find "$DST" -type f | wc -l)"'
  tar czf - -C "$SRC" . \
    | ssh "${SSH_ARGS[@]}" "${REMOTE_USER}@${HOST}" "$REMOTE_CMD" _ "$DST" "$DO_DELETE" \
    || die "同步失败"
fi

END_TS=$(date +%s)
info "方式: $MODE，耗时 $((END_TS - START_TS))s"

# ---------- 4. 远端落地校验 ----------
say "远端校验"
REMOTE_ENTRY="$(ssh "${SSH_ARGS[@]}" "${REMOTE_USER}@${HOST}" \
  "grep -oE 'assets/index\\.[A-Za-z0-9_-]+\\.js' '$DST/index.html' 2>/dev/null | head -1; echo \"files=\$(find '$DST' -type f | wc -l)\"")"
info "$REMOTE_ENTRY"
if [ "${REMOTE_ENTRY%%$'\n'*}" = "$LOCAL_ENTRY" ]; then
  info "入口一致 ✅"
else
  warn "入口不一致，检查是否同步到了正确的目录"
fi

# ---------- 5. 重启服务（可选） ----------
if [ "$DO_RESTART" = 1 ]; then
  if [ -z "${svc:-}" ]; then
    warn "没识别到 octop 服务单元，跳过重启"
  else
    say "重启 $svc"
    ssh "${SSH_ARGS[@]}" "${REMOTE_USER}@${HOST}" \
      "systemctl restart '$svc' && sleep 2 && systemctl is-active '$svc'" || die "重启失败"
  fi
fi

# ---------- 6. 线上探活 ----------
if [ "$DO_VERIFY" = 1 ]; then
  say "线上探活 $VERIFY_URL"
  LIVE_ENTRY="$(curl --noproxy '*' -fsS --max-time 20 "$VERIFY_URL/" 2>/dev/null \
    | grep -oE 'assets/index\.[A-Za-z0-9_-]+\.js' | head -1 || true)"
  HEALTH="$(curl --noproxy '*' -fsS --max-time 20 "$VERIFY_URL/api/health" 2>/dev/null || true)"
  info "线上入口 : ${LIVE_ENTRY:-未取到}"
  info "健康检查 : ${HEALTH:-失败}"
  if [ -n "$LIVE_ENTRY" ] && [ "$LIVE_ENTRY" = "$LOCAL_ENTRY" ]; then
    info "线上已生效 ✅（浏览器硬刷新一次即可看到新界面）"
  else
    warn "线上入口与本地不一致：可能域名指向另一台机器 / CDN 缓存 / service worker 尚未更新"
  fi
fi

say "完成"
info "回滚：ssh -p $PORT ${REMOTE_USER}@${HOST} \"cp -a $BACKUP_ROOT/<时间戳>/. $DST/\""
