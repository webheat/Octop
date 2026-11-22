#!/bin/bash
# CNB 分支情况每日分析（凌晨 01:30 跑）
#
# 由系统 crond 触发，不依赖 Claude 会话、不依赖交互式环境变量。
# 做的事：采集 cnb.cool 分支事实 → 用 qiniu/conatus-free 并行分析 → 写带日期的报告到 docs/。
#
# 产出：
#   报告  /opt/Octop/docs/cnb-branch-analysis/YYYY-MM-DD.md（按运行日期归档）
#   最新  /opt/Octop/docs/cnb-branch-analysis/latest.md
#   日志  /opt/Octop/scripts/logs/cnb-branch-analysis.log
#
# 退出码：0 = 报告已生成；1 = 采集失败；2 = 报告已生成但模型分析整体失败
#
# 卸载：crontab -e 删掉 `30 1 * * * /opt/Octop/scripts/run_cnb_branch_analysis.sh ...` 那一行
set -uo pipefail

export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export LC_ALL=C.UTF-8
export LANG=C.UTF-8
# HOME 要给 git 用（凭据在 ~/.git-credentials）；cron 默认就有，显式写死更稳
export HOME=/root

REPO_DIR=/opt/Octop
SCRIPT="$REPO_DIR/scripts/cnb_branch_analysis.py"
LOG_DIR="$REPO_DIR/scripts/logs"
LOG="$LOG_DIR/cnb-branch-analysis.log"

mkdir -p "$LOG_DIR"

if [ ! -f "$SCRIPT" ]; then
    echo "[$(date '+%F %T')] 脚本不存在：$SCRIPT" >>"$LOG"
    exit 1
fi

{
    echo "===== $(date '+%F %T') 开始 ====="
    /usr/bin/python3 -I "$SCRIPT" "$@"
    rc=$?
    echo "===== $(date '+%F %T') 结束（rc=$rc） ====="
    exit $rc
} >>"$LOG" 2>&1
