#!/usr/bin/env bash
# Octop 引导器 (macOS / Linux) —— 极轻量下载引导器
#
# 本体只有本文件 + bootstrap.conf（几十 KB），不携带 Python 运行时和应用包。
# 有 zenity 时显示图形进度条，否则退化为终端输出；步骤与 Windows 版一致：
#
#   1. 基础工具     下载 uv（已存在则复用）
#   2. Python 环境  uv venv → 拉取 CPython
#   3. Octop 主程序 本地 wheel（payload/ 或 ../dist/）优先，否则从 PyPI 下载
#   4. 可选组件     Playwright Chromium（--browser 才下载）
#   5. 启动         后台拉起 octop run，就绪后自动打开浏览器
#
# 用法：
#   bash bootstrap.sh                 # 图形界面（zenity 可用时）
#   bash bootstrap.sh --no-gui        # 纯终端
#   bash bootstrap.sh --mirror        # 国内镜像加速
#   bash bootstrap.sh --browser       # 同时下载浏览器组件
#   bash bootstrap.sh --dir ~/octop   # 指定安装目录
#   bash bootstrap.sh --version 1.1.0
#   bash bootstrap.sh --launch        # 装完直接启动（不询问）
#   bash bootstrap.sh --plan          # 只打印将要执行的计划
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

DIR=""
VERSION=""
USE_MIRROR=0
WANT_BROWSER=0
NO_GUI=0
AUTO_LAUNCH=0
PLAN_ONLY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) DIR="${2:-}"; shift 2 ;;
    --version) VERSION="${2:-}"; shift 2 ;;
    --mirror) USE_MIRROR=1; shift ;;
    --browser) WANT_BROWSER=1; shift ;;
    --no-gui) NO_GUI=1; shift ;;
    --launch) AUTO_LAUNCH=1; shift ;;
    --plan) PLAN_ONLY=1; shift ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

# ── 配置 ────────────────────────────────────────────────────────────────────
conf_get() {
  local key="$1" fallback="$2" line
  while IFS= read -r line; do
    line="${line%%#*}"
    line="$(printf '%s' "$line" | tr -d '[:space:]')"
    [[ "$line" == "$key="* ]] && { printf '%s' "${line#*=}"; return 0; }
  done <"$SCRIPT_DIR/bootstrap.conf"
  printf '%s' "$fallback"
}

UV_VERSION="$(conf_get UV_VERSION 0.12.22)"
PYTHON_VERSION="$(conf_get PYTHON_VERSION 3.12)"
PACKAGE="$(conf_get PYPI_PACKAGE octop)"
PORT="$(conf_get LAUNCH_PORT 8088)"
UV_MIRROR_BASE="$(conf_get UV_MIRROR_BASE https://registry.npmmirror.com/-/binary/uv)"
PIP_INDEX_URL="$(conf_get PIP_INDEX_URL '')"
APP_VERSION="${VERSION:-$(conf_get OCTOP_VERSION '')}"

HOME_DIR="${DIR:-${OCTOP_HOME:-$HOME/.octop}}"
VENV="$HOME_DIR/venv"
VENV_PY="$VENV/bin/python3"
VENV_OCTOP="$VENV/bin/octop"
TOOL_DIR="$HOME_DIR/bootstrap/uv"

# ── 平台 ────────────────────────────────────────────────────────────────────
OS="$(uname -s)"
MACH="$(uname -m)"
case "$OS" in
  Darwin) TARGET_OS=apple-darwin ;;
  Linux) TARGET_OS=unknown-linux-gnu ;;
  MINGW*|MSYS*|CYGWIN*)
    echo "Windows detected ($OS) — run Octop-Bootstrap.cmd or Octop-Bootstrap.ps1 instead." >&2
    exit 1
    ;;
  *) echo "unsupported OS: $OS" >&2; exit 1 ;;
esac
case "$MACH" in
  arm64|aarch64) TARGET_ARCH=aarch64 ;;
  x86_64|amd64) TARGET_ARCH=x86_64 ;;
  *) echo "unsupported architecture: $MACH" >&2; exit 1 ;;
esac

# ── 输出：zenity 图形进度条 → 终端 ──────────────────────────────────────────
GUI_FD=""
if [[ "$NO_GUI" == 0 ]]; then
  if command -v zenity >/dev/null 2>&1; then
    exec 3> >(zenity --progress --pulsate --auto-close \
      --title="Octop 安装引导器" --text="准备中…" --width=520 2>/dev/null)
    GUI_FD=3
  fi
fi
log() {
  if [[ -n "$GUI_FD" ]]; then echo "# $*" >&$GUI_FD; else echo "[$(date +%H:%M:%S)] $*"; fi
}
run_step() { # run_step <标题> <命令…>
  local title="$1"; shift
  log "$title"
  if [[ -n "$GUI_FD" ]]; then
    "$@" >>"$HOME_DIR/bootstrap.log" 2>&1
  else
    "$@" 2>&1 | while IFS= read -r line; do log "  | $line"; done
  fi
}

# ── 步骤 3：本地 wheel 优先 ─────────────────────────────────────────────────
resolve_wheel() {
  local d hit
  for d in "$SCRIPT_DIR/payload" "$SCRIPT_DIR" "$SCRIPT_DIR/../dist"; do
    [[ -d "$d" ]] || continue
    hit="$(find "$d" -maxdepth 1 -name "$PACKAGE-*.whl" -type f 2>/dev/null | head -1)"
    if [[ -n "$hit" ]]; then printf '%s' "$hit"; return 0; fi
  done
  return 0
}

if [[ "$PLAN_ONLY" == 1 ]]; then
  WHEEL="$(resolve_wheel)"
  echo "Octop 引导器 · 执行计划"
  echo "  安装目录     $HOME_DIR"
  echo "  应用版本     ${APP_VERSION:-最新稳定版}"
  echo "  基础工具     uv $UV_VERSION ($TARGET_ARCH-$TARGET_OS)"
  echo "  Python       $PYTHON_VERSION"
  echo "  应用来源     ${WHEEL:-PyPI $PACKAGE}"
  if [[ "$USE_MIRROR" == 1 ]]; then echo "  镜像加速     $PIP_INDEX_URL"; else echo "  镜像加速     关闭"; fi
  if [[ "$WANT_BROWSER" == 1 ]]; then BROWSER_PLAN="下载"; else BROWSER_PLAN="跳过"; fi
  echo "  浏览器组件   $BROWSER_PLAN"
  echo "  启动端口     $PORT"
  exit 0
fi

# ── 步骤 1：基础工具 uv ─────────────────────────────────────────────────────
UV_BIN=""
ensure_uv() {
  if command -v uv >/dev/null 2>&1; then
    UV_BIN="$(command -v uv)"
    log "复用已安装的 uv：$UV_BIN"
    return 0
  fi
  local file="uv-$TARGET_ARCH-$TARGET_OS.tar.gz" urls primary fallback
  primary="https://github.com/astral-sh/uv/releases/download/$UV_VERSION/$file"
  fallback="$UV_MIRROR_BASE/$UV_VERSION/$file"
  if [[ "$USE_MIRROR" == 1 ]]; then urls=("$fallback" "$primary"); else urls=("$primary" "$fallback"); fi
  mkdir -p "$TOOL_DIR"
  local ok=0 url
  for url in "${urls[@]}"; do
    log "下载 uv：$url"
    if curl -fsSL --retry 2 --connect-timeout 15 "$url" -o "$TOOL_DIR/uv.tgz"; then ok=1; break; fi
    log "  下载失败，尝试下一个源"
  done
  [[ "$ok" == 1 ]] || { log "无法下载 uv，请检查网络后重试。"; exit 1; }
  tar -xzf "$TOOL_DIR/uv.tgz" -C "$TOOL_DIR" --strip-components=1
  rm -f "$TOOL_DIR/uv.tgz"
  chmod +x "$TOOL_DIR/uv"
  export PATH="$TOOL_DIR:$PATH"
  UV_BIN="$TOOL_DIR/uv"
  log "uv 就绪：$UV_BIN"
}

# ── 步骤 5：启动 ────────────────────────────────────────────────────────────
launch() {
  [[ -x "$VENV_OCTOP" ]] || { log "Octop 尚未安装，无法启动。"; return 1; }
  log "启动 octop run…"
  nohup "$VENV_OCTOP" run >"$HOME_DIR/octop-run.log" 2>&1 &
  local i=0 ready=0
  while (( i < 90 )); do
    sleep 1
    if (exec 3<>/dev/tcp/127.0.0.1/"$PORT") 2>/dev/null; then ready=1; break; fi
    i=$((i + 1))
  done
  if [[ "$ready" == 0 ]]; then
    log "服务在 90 秒内未就绪，请稍后手动打开 http://127.0.0.1:$PORT"
    return 0
  fi
  log "服务就绪，打开浏览器。"
  if command -v open >/dev/null 2>&1; then open "http://127.0.0.1:$PORT"
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "http://127.0.0.1:$PORT"
  fi
}

# ── 主流程 ──────────────────────────────────────────────────────────────────
mkdir -p "$HOME_DIR"
log "步骤 1/5 准备基础工具"
ensure_uv

log "步骤 2/5 准备 Python $PYTHON_VERSION 运行环境"
run_step "创建 $VENV" "$UV_BIN" venv "$VENV" --python "$PYTHON_VERSION" --quiet
[[ -x "$VENV_PY" ]] || { log "Python 运行环境创建失败。"; exit 1; }

log "步骤 3/5 下载 Octop 主程序与依赖"
pip_args=(pip install --python "$VENV_PY")
if [[ "$USE_MIRROR" == 1 && -n "$PIP_INDEX_URL" ]]; then
  pip_args+=(--index-url "$PIP_INDEX_URL")
fi
# playwright / tencentcloud-sdk-python 自运行时瘦身后不再是核心依赖，需要时
# 通过 extra 显式带上：--browser 时带 browser，always 带 tencentcloud（云工作台）。
EXTRAS="tencentcloud"
if [[ "$WANT_BROWSER" == 1 ]]; then EXTRAS="browser,tencentcloud"; fi
WHEEL="$(resolve_wheel)"
if [[ -n "$WHEEL" ]]; then
  log "使用本地构建产物：$WHEEL"
  pip_args+=("${WHEEL}[${EXTRAS}]")
else
  SPEC="$PACKAGE[${EXTRAS}]${APP_VERSION:+==$APP_VERSION}"
  log "从 PyPI 下载：$SPEC"
  pip_args+=("$SPEC")
fi
run_step "安装 Octop" "$UV_BIN" "${pip_args[@]}"
[[ -x "$VENV_OCTOP" ]] || { log "Octop 安装失败。"; exit 1; }

log "步骤 4/5 可选组件"
if [[ "$WANT_BROWSER" == 1 ]]; then
  run_step "下载 Playwright Chromium" "$VENV_PY" -m playwright install chromium
else
  log "跳过浏览器组件（--browser 启用）"
fi

if [[ -n "$GUI_FD" ]]; then exec 3>&-; fi

if [[ "$AUTO_LAUNCH" == 1 ]]; then
  log "步骤 5/5 启动 Octop"
  launch
else
  if [[ -n "$GUI_FD" ]] && command -v zenity >/dev/null 2>&1; then
    if zenity --question --title="Octop" --text="安装完成，是否现在启动 Octop？" --width=420; then
      launch
    fi
  else
    log "安装完成。启动：\"$VENV_OCTOP\" run → http://127.0.0.1:$PORT"
  fi
fi
