#!/usr/bin/env python3
"""CNB(cnb.cool) 分支情况分析 —— 采集 git 事实 + 用大模型并行分析，出带日期的报告。

由系统 crond 触发（凌晨 01:30），不依赖 Claude 会话、不依赖交互式环境变量。

产出：
    报告  /opt/Octop/docs/cnb-branch-analysis/YYYY-MM-DD.md（按运行日期归档）
    最新  /opt/Octop/docs/cnb-branch-analysis/latest.md
    日志  /opt/Octop/scripts/logs/cnb-branch-analysis.log

用法：
    /usr/bin/python3 -I scripts/cnb_branch_analysis.py            # 正常跑（含模型分析）
    /usr/bin/python3 -I scripts/cnb_branch_analysis.py --no-llm   # 只采集 git 事实，不调模型
    /usr/bin/python3 -I scripts/cnb_branch_analysis.py --date 2026-11-19  # 指定报告日期（补跑）

退出码：0 = 报告已生成；1 = 采集阶段失败；2 = 报告已生成但模型分析整体失败（仍会写报告）
"""

from __future__ import annotations

import argparse
import concurrent.futures
import contextlib
import json
import os
import random
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta

REPO_DIR = os.environ.get("REPO_DIR", "/opt/Octop")
DOC_DIR = os.path.join(REPO_DIR, "docs", "cnb-branch-analysis")
LOG_DIR = os.path.join(REPO_DIR, "scripts", "logs")
LOCK_FILE = os.path.join(REPO_DIR, ".git", "cnb-branch-analysis.lock")

CNB_REMOTE = os.environ.get("CNB_REMOTE", "cnb")
ORIGIN_REMOTE = os.environ.get("ORIGIN_REMOTE", "origin")
BASE_BRANCHES = ("main", "develop")

SETTINGS_FILE = os.environ.get("CLAUDE_SETTINGS", "/root/.claude/settings.json")
LLM_MODEL = os.environ.get("LLM_MODEL", "qiniu/conatus-free")
LLM_TIMEOUT = int(os.environ.get("LLM_TIMEOUT", "120"))
LLM_MAX_RETRY = int(os.environ.get("LLM_MAX_RETRY", "10"))
LLM_WORKERS = int(os.environ.get("LLM_WORKERS", "3"))
# 全局请求最小间隔（秒）。免费通道同时有「全局限流」和「并发限流」两种 429，
# 单纯靠并发数压不住：错开发起时刻比少开线程更管用。
LLM_MIN_INTERVAL = float(os.environ.get("LLM_MIN_INTERVAL", "4"))
BRANCH_MAX_TOKENS = int(os.environ.get("BRANCH_MAX_TOKENS", "4000"))
SUMMARY_MAX_TOKENS = int(os.environ.get("SUMMARY_MAX_TOKENS", "6000"))
MAX_TOKENS_CEILING = int(os.environ.get("MAX_TOKENS_CEILING", "16000"))

KEEP_DAYS = int(os.environ.get("KEEP_DAYS", "90"))

TK = "8C7"


def log(msg: str) -> None:
    ts = datetime.now().astimezone().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] {msg}", flush=True)


def now_iso() -> str:
    return datetime.now().astimezone().strftime("%Y-%m-%d %H:%M:%S %Z")


# ---------------------------------------------------------------- git 采集


class Git:
    """带隔离 credential store 的 git 封装。

    两个必须绕开的坑（实测于本机 /opt/Octop）：

    1. 仓库级 .git/config 设了 credential.usehttppath=true，而 ~/.git-credentials
       里 cnb.cool 只有 host 级条目（没有 mengxa.com/Octop.git 这个 path 级条目），
       照默认配置跑 `git ls-remote cnb` 会直接报 "could not read Username"。
       解法：命令行 -c credential.useHttpPath=false 覆盖（命令行优先于文件配置）。
    2. `git ls-remote` 成功后 git 会把规范化 URL 写回 ~/.git-credentials，
       同 host 的另一条 path 级条目会被折叠掉（实测 6 条变 5 条）。
       解法：复制一份凭据到临时文件，用 GIT_CREDENTIAL_STORE 指过去，真实文件全程不动。
    """

    def __init__(self, repo_dir: str):
        self.repo_dir = repo_dir
        self._tmpdir = tempfile.mkdtemp(prefix="cnb-branch-analysis-")
        self._store = os.path.join(self._tmpdir, "credentials")
        src = os.path.expanduser("~/.git-credentials")
        if os.path.exists(src):
            shutil.copyfile(src, self._store)
        else:
            open(self._store, "w").close()
        os.chmod(self._store, 0o600)
        self.env = os.environ.copy()
        self.env["GIT_CREDENTIAL_STORE"] = self._store
        self.env["GIT_TERMINAL_PROMPT"] = "0"
        self.env["GIT_ASKPASS"] = "echo"
        self.env.pop("GIT_DIR", None)

    def close(self) -> None:
        shutil.rmtree(self._tmpdir, ignore_errors=True)

    def run(self, args: list[str], timeout: int = 180) -> tuple[int, str, str]:
        cmd = ["git", "-C", self.repo_dir, "-c", "credential.useHttpPath=false"] + args
        try:
            p = subprocess.run(
                cmd,
                env=self.env,
                capture_output=True,
                text=True,
                timeout=timeout,
                check=False,
            )
        except subprocess.TimeoutExpired:
            return 124, "", f"git {args[0]} 超时（{timeout}s）"
        return p.returncode, p.stdout.strip(), p.stderr.strip()

    def ok(self, args: list[str], timeout: int = 180) -> str:
        rc, out, err = self.run(args, timeout)
        if rc != 0:
            raise RuntimeError(f"git {' '.join(args)} 失败（rc={rc}）：{err}")
        return out

    def out(self, args: list[str], timeout: int = 180) -> str:
        rc, so, se = self.run(args, timeout)
        return so if rc == 0 else ""

    def rc(self, args: list[str], timeout: int = 180) -> int:
        code, _, _ = self.run(args, timeout)
        return code


def parse_refs(text: str) -> dict[str, str]:
    refs: dict[str, str] = {}
    for line in text.splitlines():
        parts = line.split(None, 1)
        if len(parts) != 2:
            continue
        sha, ref = parts
        if ref.startswith("refs/heads/"):
            refs[ref[len("refs/heads/") :]] = sha
    return refs


def _merge_state(
    git: Git, sha: str, base_set: dict[str, str]
) -> tuple[list[str], dict[str, dict[str, int]]]:
    """算一个分支相对一组基线的合并状态。

    返回 (已并入的基线名列表, {基线名: {"ahead": n, "behind": n}})。
    """
    merged: list[str] = []
    ab: dict[str, dict[str, int]] = {}
    for b, b_sha in base_set.items():
        if git.rc(["merge-base", "--is-ancestor", sha, b_sha]) == 0:
            merged.append(b)
        cnt = git.out(["rev-list", "--left-right", "--count", f"{b_sha}...{sha}"])
        if cnt:
            left, right = cnt.split()[:2]
            ab[b] = {"behind": int(left), "ahead": int(right)}
    return merged, ab


def collect(git: Git) -> dict:
    """采集 CNB 分支事实 + 与 GitHub 主干的对比。"""
    facts: dict = {"errors": []}

    rc, out, err = git.run(["ls-remote", "--heads", CNB_REMOTE])
    if rc != 0 or not out:
        facts["errors"].append(f"无法读取 {CNB_REMOTE} 的分支列表：{err or out or '空响应'}")
        return facts
    cnb_refs = parse_refs(out)

    # 拉取 cnb 与 origin 的对象，保证后面算 ahead/behind 用的是最新提交
    for remote in (CNB_REMOTE, ORIGIN_REMOTE):
        rc, _, err = git.run(["fetch", "--prune", remote], timeout=600)
        if rc != 0:
            facts["errors"].append(f"fetch {remote} 失败：{err[:300]}")

    origin_refs = parse_refs(git.out(["ls-remote", "--heads", ORIGIN_REMOTE]))

    # 把 cnb 分支落到本地 refs/cnb-analysis/*，不污染 remotes/cnb/*
    for name, sha in cnb_refs.items():
        rc, _, err = git.run(["fetch", CNB_REMOTE, f"+{sha}:refs/cnb-analysis/{name}"], timeout=600)
        if rc != 0:
            facts["errors"].append(f"拉取 cnb/{name} 对象失败：{err[:200]}")

    # 两套基线，必须分开算：
    #   cnb_bases    —— CNB 自己的 main/develop，衡量「在 CNB 上合了没有」
    #   origin_bases —— GitHub 的 main/develop，衡量「回流 GitHub 了没有」
    # 早期只用 origin 当基线，CNB 领先 GitHub 12 个提交时会把「已在 CNB 合并、
    # 只是没回流 GitHub」误判成「完全没合」（2026-11-21 实测）。
    cnb_bases = {}
    for b in BASE_BRANCHES:
        ref = f"refs/cnb-analysis/{b}"
        rc, _, _ = git.run(["rev-parse", "--verify", "--quiet", ref])
        if rc == 0:
            cnb_bases[b] = git.out(["rev-parse", ref])

    origin_bases = {}
    for b in BASE_BRANCHES:
        ref = f"refs/remotes/{ORIGIN_REMOTE}/{b}"
        rc, _, _ = git.run(["rev-parse", "--verify", "--quiet", ref])
        if rc == 0:
            origin_bases[b] = git.out(["rev-parse", ref])
    if not cnb_bases and not origin_bases:
        facts["errors"].append(
            f"在 {CNB_REMOTE}/{ORIGIN_REMOTE} 上都找不到基准分支 {'/'.join(BASE_BRANCHES)}，"
            "无法计算合并状态"
        )
        return facts

    branches = []
    for name, sha in sorted(cnb_refs.items()):
        info: dict = {"name": name, "sha": sha, "short": sha[:8]}
        info["commit"] = git.out(["log", "-1", "--format=%H%x1f%an%x1f%aI%x1f%s", sha]).split(
            "\x1f"
        )
        if len(info["commit"]) == 4:
            info["last_author"] = info["commit"][1]
            info["last_date"] = info["commit"][2]
            info["last_subject"] = info["commit"][3]
        else:
            info["last_author"] = info["last_date"] = info["last_subject"] = "?"

        on_origin = name in origin_refs
        info["on_origin"] = on_origin
        info["origin_sha"] = origin_refs.get(name, "")

        # 两套基线分别算：
        #   cnb_*    —— 相对 CNB 的 main/develop，回答「在 CNB 上合了没有」
        #   github_* —— 相对 GitHub 的 main/develop，回答「回流 GitHub 了没有」
        # 早期只算 GitHub 一套，CNB 领先 GitHub 12 个提交时会把「已在 CNB 通过
        # MR 合并、只是没回流 GitHub」误判成「完全没合」（2026-11-21 实测：
        # feat/unified-import-entry 被判成 ahead 12，实际相对 CNB main 只差 1 个提交）。
        merged_cnb, ab_cnb = _merge_state(git, sha, cnb_bases)
        merged_gh, ab_gh = _merge_state(git, sha, origin_bases)
        info["merged_into_cnb"] = merged_cnb
        info["ahead_behind_cnb"] = ab_cnb
        info["merged_into_github"] = merged_gh
        info["ahead_behind_github"] = ab_gh

        # 待合内容以 CNB main 为准（MR 的目标就是 main）：unmerged_commits 是
        # 还没进 CNB main 的提交，changed_files 是这些提交动了多少文件。
        base_for_diff = cnb_bases.get("main") or cnb_bases.get("develop")
        if base_for_diff:
            info["changed_files"] = len(
                [
                    x
                    for x in git.out(
                        ["diff", "--name-only", f"{base_for_diff}...{sha}"]
                    ).splitlines()
                    if x.strip()
                ]
            )
            uniq = git.out(
                ["log", "--format=%ad%x1f%s", "--date=short", "-15", f"{base_for_diff}..{sha}"]
            )
            rows = []
            for line in uniq.splitlines():
                if "\x1f" in line:
                    d, s = line.split("\x1f", 1)
                    rows.append({"date": d, "subject": s})
            info["unmerged_commits"] = rows
        branches.append(info)

    facts["branches"] = branches
    facts["cnb_only"] = sorted(set(cnb_refs) - set(origin_refs))
    facts["origin_only"] = sorted(set(origin_refs) - set(cnb_refs))
    facts["cnb_base_shas"] = cnb_bases
    facts["github_base_shas"] = origin_bases
    # 本地 main/develop 分支可能已陈旧（工作区里的本地引用不等于任何远端）。
    # 报告里的对比命令一律用远端引用，给模型一份显式清单，别让它写 `git log origin/main..main`。
    facts["ref_hints"] = {
        "cnb_main": f"{CNB_REMOTE}/main",
        "cnb_develop": f"{CNB_REMOTE}/develop",
        "github_main": f"{ORIGIN_REMOTE}/main",
        "github_develop": f"{ORIGIN_REMOTE}/develop",
        "note": "对比基线一律用上面四个远端引用；本地 main/develop 可能陈旧，不要拿来当基线。",
    }
    facts["generated_at"] = now_iso()
    return facts


# ---------------------------------------------------------------- 模型调用


def load_llm_config() -> tuple[str, str]:
    with open(SETTINGS_FILE, encoding="utf-8") as f:
        env = json.load(f).get("env", {})
    base = env.get("ANTHROPIC_BASE_URL", "").rstrip("/")
    token = env.get("ANTHROPIC_AUTH_TOKEN", "")
    if not base or not token:
        raise RuntimeError(f"{SETTINGS_FILE} 里缺少 ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN")
    return base, token


class RateGate:
    """全局请求闸门：保证任意两次请求发起时刻至少相隔 LLM_MIN_INTERVAL 秒。

    免费通道的两种 429（全局限流 / 并发限流）都靠错峰缓解：
    线程数压到 3 仍然会被拒，但把发起时刻拉开就能持续拿到 200。
    """

    def __init__(self, min_interval: float):
        self.min_interval = min_interval
        self._lock = threading.Lock()
        self._last = 0.0

    def wait(self) -> None:
        with self._lock:
            now = time.monotonic()
            gap = self._last + self.min_interval - now
            if gap > 0:
                time.sleep(gap)
                now = time.monotonic()
            self._last = now


GATE = RateGate(LLM_MIN_INTERVAL)


def llm_call(base: str, token: str, prompt: str, max_tokens: int) -> tuple[bool, str]:
    """调一次模型。返回 (成功, 文本)。429/5xx 走指数退避重试。

    qiniu/conatus-free 是免费通道，网关有全局限流（并发稍高就整片 429），
    所以这里必须带退避重试 + 全局错峰闸门。

    截断处理：该通道底层是 oai_chat 语义，reasoning tokens 计入
    completion_tokens，max_tokens 给小了会在正文中途断掉（实测断在
    "## 依据\\n- " 这种半截行）。stop_reason == "max_tokens" 时把预算翻倍重试，
    而不是把半截文本当成功结果写进报告。
    """
    url = f"{base}/v1/messages"
    delay = 5.0
    last_err = ""
    budget = max_tokens
    for attempt in range(1, LLM_MAX_RETRY + 1):
        payload = json.dumps(
            {
                "model": LLM_MODEL,
                "max_tokens": budget,
                "messages": [{"role": "user", "content": prompt}],
            }
        ).encode()
        GATE.wait()
        req = urllib.request.Request(url, data=payload, method="POST")
        req.add_header("Authorization", f"Bearer {token}")
        req.add_header("x-api-key", token)
        req.add_header("anthropic-version", "2023-06-01")
        req.add_header("content-type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=LLM_TIMEOUT) as resp:
                data = json.loads(resp.read().decode())
            stop = data.get("stop_reason")
            text = "".join(
                c.get("text", "") for c in data.get("content", []) if c.get("type") == "text"
            ).strip()
            if stop == "max_tokens" or (text and not _looks_complete(text)):
                last_err = f"输出被截断（stop_reason={stop}，budget={budget}）"
                if budget < MAX_TOKENS_CEILING:
                    budget = min(budget * 2, MAX_TOKENS_CEILING)
                    # 截断不是限流，不用长退避；略等一下重试即可
                    time.sleep(2)
                    continue
                return False, last_err
            if text:
                return True, text
            last_err = "返回内容为空"
        except urllib.error.HTTPError as e:
            body = ""
            with contextlib.suppress(Exception):
                body = e.read().decode()[:300]
            last_err = f"HTTP {e.code}: {body}"
            if e.code in (400, 401, 403, 404):
                # 模型名错 / 鉴权错 / 配额归零 —— 重试无意义
                return False, last_err
        except Exception as e:  # 超时、连接错误
            last_err = f"{type(e).__name__}: {e}"
        if attempt < LLM_MAX_RETRY:
            wait = delay + random.uniform(0, 5)
            time.sleep(wait)
            delay = min(delay * 2, 60.0)
    return False, last_err or "未知错误"


def _looks_complete(text: str) -> bool:
    """粗判文本是否被截断。

    只认真截断特征，避免把「合法的短回答」误判成截断而白白加倍预算：
    1. 结尾是悬空的列表符/冒号（"- "、"："）—— 实测断点就在这里；
    2. 末尾是标题但标题下正文为空；
    3. 末行是表格行且列数少于表头 —— 表格中途被砍。
    stop_reason == "max_tokens" 是权威信号，这个函数只是它的补充。
    """
    if not text:
        return False
    # 注意：这里不能用 text.rstrip() 再比对 "- "——rstrip 会把悬空的 "- "
    # 修剪成 "-"，判据就失效了（实测踩过）。改用末行精确匹配。
    last_line = ""
    for ln in reversed(text.splitlines()):
        if ln.strip():
            last_line = ln.rstrip()
            break
    if last_line in ("-", "*", "+", "- ", "* ", "+ "):
        return False
    # 悬空的有序列表项（"2. " 后面没内容）
    if re.fullmatch(r"\d+[.)]\s*", last_line):
        return False
    if last_line.endswith(("：", ": ", "、", "```")):
        return False
    lines = text.splitlines()
    last_heading_idx = None
    for i, ln in enumerate(lines):
        if ln.lstrip().startswith("#"):
            last_heading_idx = i
    if last_heading_idx is not None:
        body = "\n".join(lines[last_heading_idx + 1 :]).strip()
        if not body:
            return False

    # 表格截断：末行是表格行、但列数比表头少
    table_rows = [ln for ln in lines if ln.strip().startswith("|")]
    if len(table_rows) >= 2:
        header_cells = table_rows[0].strip().strip("|").split("|")
        last_cells = table_rows[-1].strip().strip("|").split("|")
        if len(last_cells) < len(header_cells):
            return False
    return True


BRANCH_PROMPT = """你是一名 Git 仓库治理顾问。下面是 cnb.cool 上一个分支的事实数据（机器采集，字段名保持英文）。

事实字段的口径（务必按这个理解，不要自行改写主语）：
- 该分支**在 cnb.cool 远端存在**。`on_origin: false` 表示 GitHub(origin) 上没有同名分支，
  即「只存在于 CNB、没同步到 GitHub」，**不是**「只存在于本地」。
- **两套基线必须分开看，不要混用**：
  - `ahead_behind_cnb` / `merged_into_cnb` 相对的是 **CNB 自己的 main/develop**，
    回答「这个分支在 CNB 上合了没有、还差几个提交」。
  - `ahead_behind_github` / `merged_into_github` 相对的是 **GitHub 上的 main/develop**，
    回答「内容有没有回流到 GitHub」。
  CNB 可能领先 GitHub 若干提交，所以同一分支两个口径的数字**本来就不一样**：
  `ahead_behind_cnb.main` 很小（个位数）说明**在 CNB 上已经合得差不多了**，
  这时 `ahead_behind_github` 数字大只说明**还没回流 GitHub**，
  是「同步欠账」，**不是**「分支没合并」。判断合并状态以 cnb 口径为准。
- `merged_into_cnb` 为空表示未并入 CNB 的 main/develop。
- `unmerged_commits` 是**尚未进入 CNB main 的提交**（最多列 15 条）；为空表示
  该分支的内容已全部进入 CNB main。

只依据这些事实判断，不要编造未给出的信息。输出必须是中文 Markdown，**总长度控制在 300 字以内**，
包含且仅包含四节，每节标题固定为下面这四个（不要加序号、不要加别的节）：

## 判断
一句话结论，取值只能是：可清理 / 待合并 / 进行中 / 陈旧待确认 / 分叉需人工介入。

## 依据
2-4 条，每条一行，引用具体字段值（ahead/behind 数字、最后提交日期、是否已合并进 main）。

## 风险
0-2 条，每条一行；没有就写「无明显风险」。

## 建议动作
1-3 条可执行动作，每条一行，含具体分支名与具体命令。
命令里的基线一律用 **`cnb/main` / `cnb/develop` / `origin/main` / `origin/develop`**
这四个远端引用，**不要用本地的 `main` / `develop` 分支**——本地 main 可能已经陈旧，
用它做对比会得出错误结论。

必须完整输出这四节后再结束，不要在句子中间停下。

分支数据：
```json
{branch}
```"""

SUMMARY_PROMPT = """你是一名 Git 仓库治理顾问。下面是 cnb.cool 分支的全量事实汇总，以及逐分支的模型判读结果。

事实字段的口径（务必按这个理解，不要自行改写主语）：
- `on_origin: false` 表示该分支**在 cnb.cool 远端存在，但在 GitHub(origin) 上不存在**。
  这些分支并非「本地分支」，它们有独立的远端副本。
- **两套基线必须分开看，不要混用**：
  - `ahead_behind_cnb` / `merged_into_cnb` 相对的是 **CNB 自己的 main/develop**，
    回答「这个分支在 CNB 上合了没有、还差几个提交」。
  - `ahead_behind_github` / `merged_into_github` 相对的是 **GitHub 上的 main/develop**，
    回答「内容有没有回流到 GitHub」。
  CNB 可能领先 GitHub 若干提交，所以同一分支两个口径的数字**本来就不一样**：
  `ahead_behind_cnb.main` 很小（个位数）说明**在 CNB 上已经合得差不多了**，
  这时 `ahead_behind_github` 数字大只说明**还没回流 GitHub**，
  是「同步欠账」，**不是**「分支没合并」。判断合并状态以 cnb 口径为准。
- `unmerged_commits` 是**尚未进入 CNB main 的提交**（最多列 15 条）；为空表示
  该分支的内容已全部进入 CNB main。
- **CNB 的 main 自己领先 GitHub 的 main 若干提交，这是正常的**——CNB 是开发侧，
  GitHub 是对外镜像。判断「需不需要回流」时用 `cnb_base_shas` 与
  `github_base_shas` 两组 sha 自行对比。

输出中文 Markdown，**总长度控制在 600 字以内**，包含且仅包含四节，标题固定如下（不要加序号）：

## 总览
2-4 句概括当前 CNB 分支的整体健康状况。

## 优先级清单
按「最该先处理」排序的表格，列：优先级 | 分支 | 一句话问题 | 建议动作。5 行以内。

## 镜像一致性
说明 cnb.cool 与 GitHub 之间的分支同步缺口方向、涉及哪些分支、可能成因。

## 风险提示
0-3 条，每条一行；没有就写「无明显风险」。

不要编造事实数据里没有的信息。命令里的基线一律用 **`cnb/main` / `cnb/develop` /
`origin/main` / `origin/develop`** 这四个远端引用，**不要用本地的 `main` / `develop`
分支**——本地 main 可能已经陈旧，用它做对比会得出错误结论。
必须完整输出这四节后再结束。

全量事实：
```json
{facts}
```

逐分支判读：
```json
{verdicts}
```"""


def analyze_branches(base: str, token: str, facts: dict) -> dict[str, str]:
    """对每个分支并行调模型，返回 {分支名: 判读文本}。

    两阶段：先 3 路并行跑完；并行阶段失败的分支再**串行**重试一轮。
    串行时网关侧并发为零，通过率明显高于并发状态（实测并行 6 发全 429、
    串行 3 次里有 1 次成功），所以这一轮是必要的兜底，不是冗余。
    """
    verdicts: dict[str, str] = {}
    branches = facts.get("branches", [])
    if not branches:
        return verdicts

    def build_payload(branch: dict) -> str:
        payload = {
            "name": branch["name"],
            "sha": branch["short"],
            "on_origin": branch["on_origin"],
            "merged_into_cnb": branch.get("merged_into_cnb", []),
            "ahead_behind_cnb": branch.get("ahead_behind_cnb", {}),
            "merged_into_github": branch.get("merged_into_github", []),
            "ahead_behind_github": branch.get("ahead_behind_github", {}),
            "changed_files": branch.get("changed_files"),
            "last_commit": {
                "author": branch.get("last_author"),
                "date": branch.get("last_date"),
                "subject": branch.get("last_subject"),
            },
            "unmerged_commits": branch.get("unmerged_commits", [])[:8],
        }
        return json.dumps(payload, ensure_ascii=False, indent=2)

    def one(branch: dict) -> tuple[str, bool, str]:
        prompt = BRANCH_PROMPT.replace("{branch}", build_payload(branch))
        ok, text = llm_call(base, token, prompt, BRANCH_MAX_TOKENS)
        return branch["name"], ok, text

    failed: list[dict] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=LLM_WORKERS) as pool:
        for name, ok, text in pool.map(one, branches):
            if ok:
                verdicts[name] = text
                log(f"  分支判读完成：{name}")
            else:
                failed.append({"name": name, "text": text})
                log(f"  分支判读失败（并行阶段）：{name}")

    # 串行兜底：并发降到 1 再试一次
    for item in failed:
        name = item["name"]
        branch = next(b for b in branches if b["name"] == name)
        prompt = BRANCH_PROMPT.replace("{branch}", build_payload(branch))
        ok, text = llm_call(base, token, prompt, BRANCH_MAX_TOKENS)
        if ok:
            verdicts[name] = text
            log(f"  分支判读完成（串行重试）：{name}")
        else:
            verdicts[name] = f"> 模型分析不可用（{text}）"
            log(f"  分支判读失败（串行重试后仍失败）：{name}")

    return verdicts


def analyze_summary(base: str, token: str, facts: dict, verdicts: dict) -> str:
    ok, text = llm_call(
        base,
        token,
        SUMMARY_PROMPT.replace("{facts}", json.dumps(facts, ensure_ascii=False, indent=2)).replace(
            "{verdicts}", json.dumps(verdicts, ensure_ascii=False, indent=2)
        ),
        SUMMARY_MAX_TOKENS,
    )
    return text if ok else f"> 模型汇总不可用（{text}）"


# ---------------------------------------------------------------- 报告渲染


def _strip_leading_heading(text: str) -> str:
    """去掉模型输出开头的第一个标题行。

    报告外层已经有「## 一、总览」，模型再输出一个「## 总览」就重复了。
    只去开头那一个标题，后面的「## 优先级清单」等小节标题要保留。
    """
    lines = text.splitlines()
    for i, ln in enumerate(lines):
        if ln.strip():
            if ln.lstrip().startswith("#"):
                lines = lines[i + 1 :]
            break
    return "\n".join(lines).strip()


def render(facts: dict, verdicts: dict[str, str], summary: str, report_date: str) -> str:
    L: list[str] = []
    L.append(f"# CNB(cnb.cool) 分支情况分析 — {report_date}")
    L.append("")
    L.append("> 状态：机器生成的每日快照。事实部分由 git 直接采集，判读部分由大模型生成。")
    L.append("> 采集时间：{}".format(facts.get("generated_at", "?")))
    L.append(f"> 模型：`{LLM_MODEL}`（免费通道，有全局限流，失败时重试）")
    L.append("> 复现：`/usr/bin/python3 -I scripts/cnb_branch_analysis.py`")
    L.append("")

    L.append("## 一、总览")
    L.append("")
    L.append(_strip_leading_heading(summary) if summary.strip() else "> 无总览内容")
    L.append("")

    L.append("## 二、分支事实表")
    L.append("")
    L.append(
        "| 分支 | SHA | 最后提交 | 并入 CNB | 并入 GitHub | vs CNB main | vs GitHub main | GitHub 同名分支 | 改动文件 |"
    )
    L.append("|---|---|---|---|---|---|---|---|---|")
    for b in facts.get("branches", []):
        ab_cnb = b.get("ahead_behind_cnb", {}).get("main") or {}
        ab_gh = b.get("ahead_behind_github", {}).get("main") or {}
        ab_cnb_txt = f"+{ab_cnb.get('ahead', 0)} / -{ab_cnb.get('behind', 0)}" if ab_cnb else "—"
        ab_gh_txt = f"+{ab_gh.get('ahead', 0)} / -{ab_gh.get('behind', 0)}" if ab_gh else "—"
        L.append(
            "| `{}` | `{}` | {} · {} | {} | {} | {} | {} | {} | {} |".format(
                b["name"],
                b["short"],
                b.get("last_date", "?")[:10],
                b.get("last_subject", "?")[:40],
                "、".join(b.get("merged_into_cnb", [])) or "—",
                "、".join(b.get("merged_into_github", [])) or "—",
                ab_cnb_txt,
                ab_gh_txt,
                "有" if b["on_origin"] else "**无**",
                b.get("changed_files", "—"),
            )
        )
    L.append("")
    L.append(
        "> `vs CNB main` 相对 CNB 自己的 main（衡量「在 CNB 上合了没有」）；"
        "`vs GitHub main` 相对 GitHub 的 main（衡量「回流了没有」）。"
        "两者数字不同是正常的——CNB 是开发侧，GitHub 是对外镜像。"
    )
    L.append("")

    if facts.get("cnb_only"):
        L.append("### 仅 CNB 存在（GitHub 无同名分支）")
        L.append("")
        for n in facts["cnb_only"]:
            L.append(f"- `{n}`")
        L.append("")
    if facts.get("origin_only"):
        L.append("### 仅 GitHub 存在（CNB 无同名分支）")
        L.append("")
        for n in facts["origin_only"]:
            L.append(f"- `{n}`")
        L.append("")

    L.append("## 三、逐分支判读")
    L.append("")
    for b in facts.get("branches", []):
        L.append(f"### `{b['name']}`")
        L.append("")
        L.append(verdicts.get(b["name"], "> 无判读结果"))
        L.append("")

    if facts.get("errors"):
        L.append("## 四、采集过程中的异常")
        L.append("")
        for e in facts["errors"]:
            L.append(f"- {e}")
        L.append("")

    L.append("---")
    L.append("")
    L.append(f"生成于 {now_iso()} ｜ 模型 `{LLM_MODEL}`")
    return "\n".join(L) + "\n"


def prune_old(dirpath: str) -> None:
    """只保留最近 KEEP_DAYS 天按日期命名的报告。"""
    cutoff = (datetime.now() - timedelta(days=KEEP_DAYS)).strftime("%Y-%m-%d")
    for fn in os.listdir(dirpath):
        if not fn.endswith(".md"):
            continue
        stem = fn[:-3]
        if stem == "latest":
            continue
        try:
            datetime.strptime(stem, "%Y-%m-%d")
        except ValueError:
            continue
        if stem < cutoff:
            with contextlib.suppress(OSError):
                os.remove(os.path.join(dirpath, fn))


# ---------------------------------------------------------------- main


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-llm", action="store_true", help="只采集 git 事实，不调模型")
    ap.add_argument("--date", default="", help="报告日期 YYYY-MM-DD，默认取运行当天")
    args = ap.parse_args()

    report_date = args.date or datetime.now().astimezone().strftime("%Y-%m-%d")
    os.makedirs(DOC_DIR, exist_ok=True)
    os.makedirs(LOG_DIR, exist_ok=True)

    # 单实例锁
    lock_fd = None
    try:
        import fcntl

        # 锁文件要活到主流程结束才释放，不能用 with 提前关闭
        lock_fd = open(LOCK_FILE, "w")  # noqa: SIM115
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except ImportError:
        pass
    except OSError:
        log("已有分析任务在运行，本次跳过")
        return 0

    git = Git(REPO_DIR)
    try:
        log(f"开始采集 CNB 分支事实（remote={CNB_REMOTE}，仓库 {REPO_DIR}）")
        facts = collect(git)
        if not facts.get("branches"):
            log("采集失败，未取得分支数据")
            for e in facts.get("errors", []):
                log(f"  错误：{e}")
            # 采集失败也要留痕，写一份只含异常的报告
            facts["generated_at"] = now_iso()
            content = render(facts, {}, "> 采集失败，未进行模型分析", report_date)
            path = os.path.join(DOC_DIR, f"{report_date}.md")
            with open(path, "w", encoding="utf-8") as f:
                f.write(content)
            log(f"异常报告已写入 {path}")
            return 1

        log(
            f"采集完成：CNB {len(facts['branches'])} 个分支，"
            f"仅 CNB {len(facts['cnb_only'])} 个，仅 GitHub {len(facts['origin_only'])} 个"
        )

        verdicts: dict[str, str] = {}
        summary = "> 本次未做模型分析（--no-llm）"
        llm_failed = False
        if not args.no_llm:
            try:
                base, token = load_llm_config()
            except Exception as e:
                base, token = "", ""
                llm_failed = True
                log(f"读取模型配置失败：{e}")
            if base:
                log(
                    f"并行分析 {len(facts['branches'])} 个分支（模型 {LLM_MODEL}，并发 {LLM_WORKERS}）"
                )
                verdicts = analyze_branches(base, token, facts)
                log("生成总览")
                summary = analyze_summary(base, token, facts, verdicts)
                if summary.startswith("> 模型汇总不可用"):
                    llm_failed = True

        content = render(facts, verdicts, summary, report_date)
        path = os.path.join(DOC_DIR, f"{report_date}.md")
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(content)
        os.replace(tmp, path)
        with open(os.path.join(DOC_DIR, "latest.md"), "w", encoding="utf-8") as f:
            f.write(content)
        prune_old(DOC_DIR)
        log(f"报告已写入 {path}")
        return 2 if llm_failed else 0
    finally:
        git.close()
        if lock_fd is not None:
            with contextlib.suppress(Exception):
                lock_fd.close()


if __name__ == "__main__":
    sys.exit(main())
