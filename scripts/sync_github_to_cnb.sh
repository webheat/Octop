#!/usr/bin/env bash
# 同步 GitHub (origin) → CNB (cnb)：全部分支 + 全部标签。
#
# 设计要点：
#   1. 独立运行，不依赖 Claude。同步与校验全部由本脚本完成；
#      检测到异常就落盘，由人工判断，不做任何自动初判。
#   2. 只做快进推送（不带 + / --force）。CNB 端若被直接改动导致分叉，
#      推送会被拒绝 → 记为异常 → 交由人工判断，不自动覆盖。
#   3. CNB 独有的分支（origin 上没有的）保留不动，只在报告里列出。
#
# 记录目录：<repo>/.git-sync/
#   latest-report.md        最新一次运行报告（成功/失败都写）
#   anomalies/<ts>.md       异常详情 + 待人工排查的方向
#   cron.log                cron 的标准输出（由 cron 追加）
#
# 用法：
#   scripts/sync_github_to_cnb.sh              # 正常同步
#   REPO_DIR=/path/to/repo scripts/sync_github_to_cnb.sh
#
# 退出码：0 = 已对齐；1 = 有异常（已记录）；2 = 环境/网络错误

set -uo pipefail

REPO_DIR="${REPO_DIR:-/opt/Octop}"
ORIGIN_REMOTE="${ORIGIN_REMOTE:-origin}"
CNB_REMOTE="${CNB_REMOTE:-cnb}"
STATE_DIR="${STATE_DIR:-$REPO_DIR/.git-sync}"
ANOMALY_DIR="$STATE_DIR/anomalies"
REPORT="$STATE_DIR/latest-report.md"
LOCK_FILE="$STATE_DIR/sync.lock"

mkdir -p "$STATE_DIR" "$ANOMALY_DIR"

log() { printf '[%s] %s\n' "$(date '+%F %T')" "$*"; }

# 同一时刻只允许一个同步任务
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
    log "已有同步任务在运行，本次跳过"
    exit 0
fi

cd "$REPO_DIR" || { log "无法进入仓库目录 $REPO_DIR"; exit 2; }

TS="$(date '+%Y%m%d-%H%M%S')"
ANOMALY_FILE="$ANOMALY_DIR/$TS.md"
: >"$ANOMALY_FILE"

ANOMALIES=()
NOTES=()

note() { NOTES+=("$1"); }
anomaly() { ANOMALIES+=("$1"); }

log "开始同步 origin → cnb（仓库 $REPO_DIR）"

# ---------- 1. 拉取 origin ----------
if ! FETCH_OUT="$(git fetch "$ORIGIN_REMOTE" --prune --tags 2>&1)"; then
    log "fetch 失败：$FETCH_OUT"
    anomaly "无法从 $ORIGIN_REMOTE 拉取：$(tail -n 3 <<<"$FETCH_OUT" | tr '\n' ' ')"
    FETCH_OK=0
else
    FETCH_OK=1
    note "fetch $ORIGIN_REMOTE 完成"
fi

# ---------- 2. 逐分支快进推送 ----------
# 以 ls-remote 取 GitHub 的权威 SHA，不用 refs/remotes/origin/*：
# origin 配了多个 push URL 时，git push 会更新远程追踪引用，哪怕只有其中一个
# pushurl 成功，追踪引用就可能指向"仅存在于另一端"的提交。
PUSH_FAILURES=()
if [ "$FETCH_OK" = "1" ]; then
    ORIGIN_HEADS="$(git ls-remote --heads "$ORIGIN_REMOTE" 2>/dev/null)"
    if [ -z "$ORIGIN_HEADS" ]; then
        anomaly "无法读取 $ORIGIN_REMOTE 的分支列表（凭据或网络问题）"
    fi
    while IFS=$'\t' read -r sha ref; do
        [ -z "${sha:-}" ] && continue
        branch="${ref#refs/heads/}"
        # fetch 与 ls-remote 之间存在竞态：分支可能刚被创建，本地还没有该对象。
        # 先确认对象在本地，缺失则按需抓取一次再推。
        if ! git cat-file -e "$sha^{commit}" 2>/dev/null; then
            git fetch --no-tags "$ORIGIN_REMOTE" "+$ref:refs/remotes/$ORIGIN_REMOTE/$branch" >/dev/null 2>&1 || true
        fi
        if ! git cat-file -e "$sha^{commit}" 2>/dev/null; then
            anomaly "分支 $branch 的提交 $sha 本地不存在（可能刚被创建），本次跳过，下轮重试"
            continue
        fi
        if OUT="$(git push "$CNB_REMOTE" "$sha:refs/heads/$branch" 2>&1)"; then
            log "  ✓ $branch"
        else
            log "  ✗ $branch"
            PUSH_FAILURES+=("$branch")
            anomaly "分支 $branch 推送失败：$(tr '\n' ' ' <<<"$OUT" | tail -c 400)"
        fi
    done <<<"$ORIGIN_HEADS"
fi

# ---------- 3. 推送标签 ----------
# 同样按 GitHub 上的权威 SHA 推送；附注标签只推标签对象本身，
# '^{}' 解引用项随标签本体一起生效，不单独推。
if [ "$FETCH_OK" = "1" ]; then
    while IFS=$'\t' read -r sha ref; do
        [ -z "${sha:-}" ] && continue
        case "$ref" in
            refs/tags/*'^{}') continue ;;
        esac
        tag="${ref#refs/tags/}"
        if ! git cat-file -e "$sha" 2>/dev/null; then
            git fetch --no-tags "$ORIGIN_REMOTE" "+$ref:refs/tags/$tag" >/dev/null 2>&1 || true
        fi
        if ! git cat-file -e "$sha" 2>/dev/null; then
            anomaly "标签 $tag 的对象 $sha 本地不存在（可能刚被创建），本次跳过，下轮重试"
            continue
        fi
        if ! TAG_OUT="$(git push "$CNB_REMOTE" "$sha:refs/tags/$tag" 2>&1)"; then
            anomaly "标签 $tag 推送失败：$(tr '\n' ' ' <<<"$TAG_OUT" | tail -c 400)"
        fi
    done <<<"$(git ls-remote --tags "$ORIGIN_REMOTE" 2>/dev/null)"
fi

# ---------- 4. 校验：远端逐 ref 比对 ----------
MISMATCH=""
CNB_ONLY=""
if [ "$FETCH_OK" = "1" ]; then
    ORIGIN_REFS="$(git ls-remote --heads --tags "$ORIGIN_REMOTE" 2>/dev/null)"
    CNB_REFS="$(git ls-remote --heads --tags "$CNB_REMOTE" 2>/dev/null)"
    if [ -z "$CNB_REFS" ]; then
        anomaly "无法读取 $CNB_REMOTE 的远端引用（凭据或网络问题）"
    else
        while IFS= read -r line; do
            [ -z "$line" ] && continue
            sha="${line%%[[:space:]]*}"
            ref="${line#*[[:space:]]}"
            ref="${ref#*	}"
            cnb_sha="$(awk -v r="$ref" '$2 == r {print $1}' <<<"$CNB_REFS")"
            if [ -z "$cnb_sha" ]; then
                MISMATCH="${MISMATCH}missing:${ref} "
            elif [ "$cnb_sha" != "$sha" ]; then
                MISMATCH="${MISMATCH}differs:${ref} "
            fi
        done <<<"$ORIGIN_REFS"
        # CNB 独有（origin 上没有）的分支：保留，仅记录
        while IFS= read -r line; do
            [ -z "$line" ] && continue
            ref="${line#*[[:space:]]}"
            ref="${ref#*	}"
            case "$ref" in refs/tags/*) continue ;; esac
            if ! grep -qF "$ref" <<<"$ORIGIN_REFS"; then
                CNB_ONLY="${CNB_ONLY}${ref#refs/heads/} "
            fi
        done <<<"$CNB_REFS"
    fi
fi

if [ -n "$MISMATCH" ]; then
    anomaly "同步后校验仍不一致：$MISMATCH"
fi

# ---------- 4.5 清理：删除 CNB 上 GitHub 已不存在的分支 ----------
# 镜像的目标是对齐 GitHub。GitHub 侧合并 PR 后会清理分支，CNB 侧若不删就会
# 一直堆积陈旧分支，两端就不再"对齐"。
# 安全阀：只有当该分支的提交已并入 origin/main 或 origin/develop 时才删除；
# 内容独有的分支一律保留并记录，绝不因为镜像而丢代码。
DELETED_BRANCHES=""
KEPT_BRANCHES=""
if [ "$FETCH_OK" = "1" ] && [ -n "$CNB_ONLY" ]; then
    ORIGIN_MAIN_SHA="$(awk '$2 == "refs/heads/main" {print $1}' <<<"$ORIGIN_REFS")"
    ORIGIN_DEVELOP_SHA="$(awk '$2 == "refs/heads/develop" {print $1}' <<<"$ORIGIN_REFS")"
    for branch in $CNB_ONLY; do
        cnb_sha="$(git ls-remote --heads "$CNB_REMOTE" "refs/heads/$branch" 2>/dev/null | awk '{print $1}')"
        [ -z "$cnb_sha" ] && continue
        if ! git cat-file -e "$cnb_sha^{commit}" 2>/dev/null; then
            git fetch --no-tags "$CNB_REMOTE" \
                "+refs/heads/$branch:refs/remotes/$CNB_REMOTE/$branch" >/dev/null 2>&1 || true
        fi
        if ! git cat-file -e "$cnb_sha^{commit}" 2>/dev/null; then
            KEPT_BRANCHES="${KEPT_BRANCHES}${branch}(对象缺失) "
            continue
        fi
        merged=0
        for base_sha in "$ORIGIN_MAIN_SHA" "$ORIGIN_DEVELOP_SHA"; do
            [ -z "$base_sha" ] && continue
            git cat-file -e "$base_sha^{commit}" 2>/dev/null || continue
            if git merge-base --is-ancestor "$cnb_sha" "$base_sha" 2>/dev/null; then
                merged=1
                break
            fi
            # 祖先关系是 SHA 级的：被 cherry-pick / rebase 过的分支会被误判成
            # "未合并"。再用 patch-id 比对内容——git cherry 输出中若没有 "+"
            # （未出现在上游的提交），说明内容已在上游，可安全删除。
            plus_count="$(git cherry "$base_sha" "$cnb_sha" 2>/dev/null | grep -c '^+' || true)"
            if [ "$plus_count" = "0" ]; then
                merged=1
                break
            fi
        done
        if [ "$merged" = "1" ]; then
            if git push "$CNB_REMOTE" --delete "$branch" >/dev/null 2>&1; then
                DELETED_BRANCHES="${DELETED_BRANCHES}${branch} "
                log "  - 已删除陈旧分支 $branch（内容已并入主线）"
            else
                KEPT_BRANCHES="${KEPT_BRANCHES}${branch}(删除失败) "
                anomaly "删除陈旧分支 $branch 失败"
            fi
        else
            KEPT_BRANCHES="${KEPT_BRANCHES}${branch} "
            log "  = 保留 $branch（内容未并入 main/develop）"
        fi
    done
fi

# ---------- 5. 出报告 ----------
{
    echo "# GitHub → CNB 同步报告"
    echo
    echo "- 时间：$(date '+%F %T %Z')"
    echo "- 仓库：$REPO_DIR"
    echo "- 方向：$ORIGIN_REMOTE → $CNB_REMOTE"
    echo "- 状态：$(if [ ${#ANOMALIES[@]} -eq 0 ]; then echo '✅ 已对齐'; else echo "❌ ${#ANOMALIES[@]} 项异常"; fi)"
    echo
    if [ ${#NOTES[@]} -gt 0 ]; then
        echo "## 执行记录"
        echo
        for n in "${NOTES[@]}"; do echo "- $n"; done
        echo
    fi
    if [ ${#ANOMALIES[@]} -gt 0 ]; then
        echo "## 异常"
        echo
        for a in "${ANOMALIES[@]}"; do echo "- $a"; done
        echo
    fi
    if [ -n "$CNB_ONLY" ]; then
        echo "## 仅 CNB 存在"
        echo
        if [ -n "$DELETED_BRANCHES" ]; then
            echo "已删除（内容已并入主线，GitHub 上已无此分支）："
            echo
            for b in $DELETED_BRANCHES; do echo "- \`$b\`"; done
            echo
        fi
        if [ -n "$KEPT_BRANCHES" ]; then
            echo "保留（内容未并入 main/develop，删除会丢代码）："
            echo
            for b in $KEPT_BRANCHES; do echo "- \`$b\`"; done
            echo
        fi
    fi
    echo "## 引用"
    echo
    echo '```'
    echo "$ORIGIN_REFS" | awk '{print $2, $1}' | sort
    echo '```'
} >"$REPORT"

log "报告已写入 $REPORT"

# ---------- 6. 异常落盘，交人工判断 ----------
if [ ${#ANOMALIES[@]} -gt 0 ]; then
    {
        echo
        echo "## 异常详情"
        echo
        for a in "${ANOMALIES[@]}"; do echo "- $a"; done
        echo
        echo "## 待人工判断"
        echo
        echo "本任务不再自动调用大模型初判（LLM 排查在 20 轮内无法收敛，只会产出误导性结论）。"
        echo "排查方向（只读命令，人工执行）："
        echo
        echo '```'
        echo "git -C $REPO_DIR ls-remote $CNB_REMOTE                 # CNB 端现有引用"
        echo "git -C $REPO_DIR log --oneline $ORIGIN_REMOTE..$CNB_REMOTE  # CNB 端多出来的提交"
        echo "git -C $REPO_DIR log --oneline $CNB_REMOTE..$ORIGIN_REMOTE  # origin 端多出来的提交"
        echo '```'
        echo
        echo "常见根因：CNB 凭据过期 / CNB 端被直接改动导致分叉 / 网络问题 / 本地仓库状态异常。"
        echo "确认无数据风险后，人工决定是否执行 git push --force-with-lease 覆盖。"
    } >>"$ANOMALY_FILE"

    log "检测到 ${#ANOMALIES[@]} 项异常，已记录待人工处理：$ANOMALY_FILE"
    exit 1
fi

log "全部引用已对齐，GitHub → CNB 同步完成"
exit 0
