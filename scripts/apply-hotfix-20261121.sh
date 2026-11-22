#!/usr/bin/env bash
#
# 2026-11-21 线上问题修复 —— 本机部署脚本（后端两条）。
#
# 本机就是部署机：octop.service 直接从 /opt/Octop 跑（editable 安装），
# 所以「部署」= 重启服务；补丁本身在源码树里，不需要重新安装。
#
# 三步：
#   1. 前置校验 —— 补丁必须已经在工作树里；不在就中止，绝不重启成半吊子状态
#   2. 存量收尾 —— 给已有 agent 补 legacy skills/ 目录；把遗留的占位名产品改名
#   3. 重启 octop.service 并探活
#
# 幂等，可重复执行。日志：/opt/octop-data/logs/hotfix-20261121.log
#
# 用法：
#   scripts/apply-hotfix-20261121.sh             # 正常部署
#   scripts/apply-hotfix-20261121.sh --dry-run   # 只校验，不写、不重启
#
set -uo pipefail

REPO="${OCTOP_REPO:-/opt/Octop}"
DATA="${OCTOP_HOME:-/opt/octop-data}"
LOG_DIR="$DATA/logs"
LOG="$LOG_DIR/hotfix-20261121.log"
LOCK="/tmp/octop-hotfix-20261121.lock"
SERVICE="octop.service"
HEALTH_URL="http://127.0.0.1:8088/videogen/api/health"
# cron 条目是按日期钉死的，脚本自己也认这个日期；换天再跑需要显式放开。
TARGET_DATE="${OCTOP_HOTFIX_DATE:-2026-11-21}"
DRY_RUN=0

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    *) printf '未知参数: %s\n' "$arg" >&2; exit 2 ;;
  esac
done

mkdir -p "$LOG_DIR"
exec 9>"$LOCK"
if ! flock -n 9; then
  echo "已有实例在跑，跳过" >&2
  exit 0
fi

log() { printf '%s [%s] %s\n' "$(date '+%F %T')" "$1" "$2" | tee -a "$LOG"; }
fail() { log ERROR "$1"; exit 1; }

log INFO "=== 开始（repo=$REPO target_date=$TARGET_DATE dry_run=$DRY_RUN）==="

today="$(date '+%F')"
if [ "$today" != "$TARGET_DATE" ] && [ "${OCTOP_HOTFIX_ALLOW_ANY_DATE:-0}" != "1" ]; then
  log INFO "今天不是目标日期 $TARGET_DATE，跳过（设 OCTOP_HOTFIX_ALLOW_ANY_DATE=1 可强制执行）"
  exit 0
fi

# ---------- 1. 前置校验：补丁在工作树里 ----------
VISION="$REPO/src/octop/infra/product_library/vision.py"
ENVFILE="$REPO/src/octop/infra/agents/workspace/execute_env.py"
grep -q "def is_placeholder_group" "$VISION" \
  || fail "补丁缺失：$VISION 里没有 is_placeholder_group"
grep -q "legacy_skills_dir" "$ENVFILE" \
  || fail "补丁缺失：$ENVFILE 里没有 legacy_skills_dir"
log INFO "补丁校验通过（占位名过滤 + legacy skills 目录）"

if [ "$DRY_RUN" = "1" ]; then
  log INFO "dry-run：到此为止，不写盘、不重启"
  exit 0
fi

# ---------- 2a. 存量 agent 补 legacy skills/ 目录 ----------
# 补丁只在 agent 启动时建目录；存量 agent 要等下一次重启才会自己建，
# 这里先补上，避免重启后第一轮仍然报 path_not_found。
added=0
for ws in "$DATA"/agents/*/; do
  [ -d "$ws" ] || continue
  case "$ws" in
    */.octop/) continue ;;
  esac
  if [ ! -d "${ws}skills" ]; then
    mkdir -p "${ws}skills" && added=$((added + 1))
  fi
done
log INFO "legacy skills 目录补齐：$added 个 agent 工作区"

# ---------- 2b. 遗留占位名产品改名 ----------
# 客户 10:34 那次导入落库了 4 个名为 candidates 的产品（视觉模型的占位词）。
# 用代码里同一套判定改名，不删除任何产品、不动图片。
cd "$REPO" && "$REPO/.venv/bin/python" - <<'PY' 2>&1 | tee -a "$LOG"
import os
import sqlite3
import time

from octop.infra.product_library.vision import is_placeholder_group

db_path = os.path.join(os.environ.get("OCTOP_HOME", "/opt/octop-data"), "octop.db")
conn = sqlite3.connect(db_path, timeout=30)
try:
    conn.execute("PRAGMA busy_timeout = 30000")
    rows = conn.execute(
        "SELECT id, owner_user_id, name, category FROM product_library_products"
    ).fetchall()
    renamed = []
    for pid, owner, name, category in rows:
        if not is_placeholder_group(name):
            continue
        new_name = (category or "").strip() or "未命名分组"
        conn.execute(
            "UPDATE product_library_products SET name = ?, updated_at = ? WHERE id = ?",
            (new_name, int(time.time()), pid),
        )
        renamed.append((pid, owner, name, new_name))
    conn.commit()
    for pid, owner, old, new in renamed:
        print(f"INFO renamed product id={pid} owner={owner} {old!r} -> {new!r}")
    print(f"INFO renamed {len(renamed)} placeholder-named products")
finally:
    conn.close()
PY

# ---------- 3. 重启 + 探活 ----------
log INFO "重启 $SERVICE"
systemctl restart "$SERVICE" || fail "systemctl restart 失败"

for _ in $(seq 1 30); do
  if systemctl is-active --quiet "$SERVICE"; then break; fi
  sleep 1
done
systemctl is-active --quiet "$SERVICE" || fail "$SERVICE 重启后未进入 active"
log INFO "$SERVICE 已 active"

ok=0
for _ in $(seq 1 30); do
  code="$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' --max-time 5 "$HEALTH_URL" 2>/dev/null)"
  if [ "$code" = "200" ]; then ok=1; break; fi
  sleep 2
done
[ "$ok" = "1" ] || fail "健康检查未通过：$HEALTH_URL 返回 ${code:-无响应}"
log INFO "健康检查通过：$HEALTH_URL -> 200"

log INFO "=== 完成 ==="
log INFO "前端那条（产品库页 agent 下拉为空）见 docs/product-library-agent-scope-fix.md，待前端机器处理"
