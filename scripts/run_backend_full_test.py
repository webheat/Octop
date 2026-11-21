#!/usr/bin/env python3
"""定时对当前后端跑一次全量测试，并用子代理模型（默认 qiniu/conatus-free）分析结果。

流程：

1. **预检** —— 服务可达、仓库与 venv 就位、pytest 可用。
2. **跑测试（脚本自己跑，不经 LLM）** —— 在仓库根目录执行全量 pytest，
   后台运行 + 轮询，拿到退出码与完整日志。
   - 跑完了但有失败用例 → 这是**结论**，不是异常：不重试，直接进分析。
   - 跑不起来（解释器缺失、依赖缺失、收集阶段崩溃、进程被杀）→ 这是**不可跳过的
     异常**：重试，累计 3 次仍失败就终止。
3. **结果分析（子代理做）** —— 把日志路径交给一个 Octop 子代理，模型固定为
   ``qiniu/conatus-free``，让它读日志、归因失败用例、给严重度与下一步建议，
   产出一份 Markdown 分析报告。分析失败同样按 3 次重试，仍失败则终止。
4. **出报告** —— 测试结论 + 子代理分析一起落到报告目录，退出码区分
   0=全过 / 1=有失败用例 / 2=不可跳过的异常（重试耗尽）。

只做后端事务：不碰 ``dashboard/``、不构建前端（见 ``docs/deployment-boundary.md``）。

用法::

    scripts/run_backend_full_test.py                 # 正常跑（最多 3 次）
    scripts/run_backend_full_test.py --setup-only    # 只做预检与准备
    scripts/run_backend_full_test.py --no-analysis   # 只跑测试，不做子代理分析
    scripts/run_backend_full_test.py --attempts 5 --timeout 7200
"""

from __future__ import annotations

import argparse
import json
import os
import shlex
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

# ── 配置 ─────────────────────────────────────────────────────────────────────

def _env(name: str, default: str) -> str:
    value = os.environ.get(name, "").strip()
    return value or default


OCTOP_HOME = _env("OCTOP_HOME", "/opt/octop-data")
BASE_URL = _env("OCTOP_BASE_URL", "http://127.0.0.1:8088/videogen").rstrip("/")
REPO_DIR = Path(_env("OCTOP_REPO", "/opt/Octop"))
# 网关侧的模型 id（provider 的 models_json 里登记的就是它）。
MODEL_ID = _env("TEST_MODEL", "qiniu/conatus-free")
PROVIDER_NAME = _env("TEST_PROVIDER", "newapi")
# Octop 侧的模型引用是 "<provider>/<model_id>"，模型 id 本身带斜杠也没关系
# （解析按第一个斜杠切）。
MODEL_REF = _env("TEST_MODEL_REF", f"{PROVIDER_NAME}/{MODEL_ID}")
AGENT_NAME = _env("TEST_AGENT_NAME", "后端全量测试")
AGENT_USER = _env("TEST_AGENT_USER", "admin")
MAX_ATTEMPTS = int(_env("TEST_MAX_ATTEMPTS", "3"))
TEST_TIMEOUT_S = int(_env("TEST_TIMEOUT", "5400"))
ANALYSIS_TIMEOUT_S = int(_env("TEST_ANALYSIS_TIMEOUT", "1800"))
POLL_INTERVAL_S = int(_env("TEST_POLL_INTERVAL", "15"))
TOKEN_TTL_S = int(_env("TEST_TOKEN_TTL", "3600"))
REPORT_DIR = Path(_env("TEST_REPORT_DIR", str(Path(OCTOP_HOME) / "test-reports")))
PYTEST_ARGS = _env("TEST_PYTEST_ARGS", '-m "not live" -q')
PYTHON_BIN = _env("TEST_PYTHON", str(REPO_DIR / ".venv" / "bin" / "python"))
CRON_NAME = _env("TEST_CRON_NAME", "后端全量测试分析")
SCHEDULED_AT = _env("TEST_SCHEDULED_AT", "2026-11-22T02:30:00")

# ── 子代理的分析提示词（必须短：cron prompt 上限 2000 字符）────────────────

ANALYSIS_PROMPT = """后端全量测试已跑完，请分析结果并写一份分析报告。

- 完整测试日志：{log}
- pytest 退出码：{exit_code}
- 摘要行：{summary}

请用 shell 读取上面那个日志文件（**只看这一个文件**，同目录下的其它报告与本次无关），重点回答：
1. 失败/错误用例清单（用例名 + 断言或异常要点）；
2. 按根因归类（环境或依赖、并发与时序、数据或夹具、后端逻辑回归、与本次改动无关的既有项等）；
3. 区分「真回归」与「不稳定/偶发」；
4. 按严重度排序，并给出建议的下一步动作。

把分析写成 Markdown 存到 {out}（UTF-8）：先给 5 行以内的总判断，再给失败用例表、归因、建议。
日志里没有失败用例时，也要写明「全部通过」并简述覆盖范围。
最后一行输出 `ANALYSIS: done`。
"""


# ── 小工具 ───────────────────────────────────────────────────────────────────

def log(msg: str) -> None:
    print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}", flush=True)


class Fatal(RuntimeError):
    """不可跳过的异常：重试也不会改变结果（配置 / 环境 / 凭证问题）。"""


class ApiError(RuntimeError):
    def __init__(self, status: int, body: str) -> None:
        super().__init__(f"HTTP {status}: {body[:400]}")
        self.status = status
        self.body = body


class Api:
    """极简 JSON HTTP 客户端（stdlib only）。"""

    def __init__(self, base_url: str, token: str, timeout: float = 60.0) -> None:
        self.base_url = base_url
        self.token = token
        self.timeout = timeout

    def request(
        self,
        method: str,
        path: str,
        payload: dict[str, Any] | None = None,
        *,
        timeout: float | None = None,
    ) -> Any:
        url = f"{self.base_url}{path}"
        data = None
        headers = {
            "Authorization": f"Bearer {self.token}",
            "Accept": "application/json",
        }
        if payload is not None:
            data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=timeout or self.timeout) as resp:
                body = resp.read().decode("utf-8", "replace")
                if not body.strip():
                    return None
                try:
                    return json.loads(body)
                except json.JSONDecodeError:
                    return body
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", "replace")
            raise ApiError(exc.code, body) from exc
        except urllib.error.URLError as exc:
            raise Fatal(f"无法访问 {url}: {exc.reason}") from exc

    def get(self, path: str, **kw: Any) -> Any:
        return self.request("GET", path, **kw)

    def post(self, path: str, payload: dict[str, Any] | None = None, **kw: Any) -> Any:
        return self.request("POST", path, payload, **kw)

    def patch(self, path: str, payload: dict[str, Any], **kw: Any) -> Any:
        return self.request("PATCH", path, payload, **kw)


def retry(fn, *, attempts: int = 3, delay: float = 5.0, what: str = "操作"):
    """带上限的重试：Fatal 直接抛出（不可跳过），其余瞬时错误重试。"""
    last: Exception | None = None
    for i in range(1, attempts + 1):
        try:
            return fn()
        except Fatal:
            raise
        except Exception as exc:  # noqa: BLE001 — 网络 / 服务端瞬时错误
            last = exc
            log(f"{what} 第 {i}/{attempts} 次失败：{exc}")
            if i < attempts:
                time.sleep(delay)
    assert last is not None
    raise last


# ── 凭证 ─────────────────────────────────────────────────────────────────────

def mint_admin_token(ttl_s: int) -> str:
    """本地签发 admin access token（读本地 DB 的 jwt secret，不落盘）。"""
    os.environ.setdefault("OCTOP_HOME", OCTOP_HOME)
    sys.path.insert(0, str(REPO_DIR / "src"))
    try:
        from octop.cli.support.db import open_cli_services
        from octop.infra.auth.tokens import PURPOSE_ACCESS, sign_token
    except ImportError as exc:  # pragma: no cover
        raise Fatal(f"无法导入 Octop 模块（{exc}）；请用 {PYTHON_BIN} 运行本脚本") from exc

    with open_cli_services() as services:
        secret = services.secret_repo.get("jwt")
        if not secret:
            raise Fatal("本地 DB 里没有 jwt secret，无法签发 token")
        row = services.user_repo.get_by_username(AGENT_USER)
        if row is None:
            raise Fatal(f"本地 DB 里没有用户 {AGENT_USER!r}")
        token = sign_token(
            secret,
            sub=int(row.id),
            uname=row.username,
            role=row.role,
            purpose=PURPOSE_ACCESS,
            ttl_seconds=ttl_s,
            mfa_version=int(getattr(row, "mfa_version", 0) or 0),
            password_version=int(getattr(row, "password_version", 0) or 0),
        )
    return token


# ── 准备：模型 / agent / cron ────────────────────────────────────────────────

def ensure_provider_model(api: Api) -> None:
    """把目标模型登记进 provider 的 models_json，否则 harness 看不到它。"""
    providers = api.get("/api/admin/providers")
    if not isinstance(providers, list) or not providers:
        raise Fatal("GET /api/admin/providers 返回空")
    target = next((p for p in providers if p.get("name") == PROVIDER_NAME), None)
    if target is None:
        raise Fatal(f"找不到名为 {PROVIDER_NAME!r} 的 provider")
    models = target.get("models") or []
    if any(str(m.get("id")) == MODEL_ID for m in models):
        log(f"模型 {MODEL_ID} 已在 provider {PROVIDER_NAME!r} 的模型列表里")
        return
    log(f"provider {PROVIDER_NAME!r} 里没有 {MODEL_ID}，正在登记")
    api.patch(
        f"/api/admin/providers/{target['id']}",
        {
            "models": [
                *models,
                {
                    "id": MODEL_ID,
                    "name": MODEL_ID,
                    "enabled": True,
                    "input": ["text"],
                    "visibility": "all",
                    "group_ids": [],
                },
            ]
        },
    )
    log(f"已登记 {MODEL_ID}（引用形式 {MODEL_REF}）")


def ensure_agent(api: Api) -> str:
    """找或建专用分析 agent，返回 agent_id。需要 shell 权限去读日志。"""
    agents = api.get("/api/agents?scope=all")
    rows = agents.get("items") if isinstance(agents, dict) else agents
    if isinstance(rows, list):
        hit = next((a for a in rows if a.get("name") == AGENT_NAME), None)
        if hit and hit.get("agent_id"):
            log(f"复用已有 agent {AGENT_NAME!r}（{hit['agent_id']}）")
            return str(hit["agent_id"])

    log(f"创建分析 agent {AGENT_NAME!r}")
    created = api.post(
        "/api/agents",
        {
            "name": AGENT_NAME,
            "description": "后端全量测试结果分析（定时任务专用）",
            "default_model": MODEL_REF,
            "config": {
                "backend": {
                    "type": "local_shell",
                    "root_dir": "/",
                    "virtual_mode": True,
                }
            },
        },
    )
    agent_id = str(created.get("agent_id") or "")
    if not agent_id:
        raise Fatal(f"创建 agent 失败：{created}")
    log(f"agent 创建完成：{agent_id}")
    return agent_id


def agent_workdir(agent_id: str) -> Path:
    return Path(OCTOP_HOME) / "agents" / agent_id


def _cron_id_of(row: dict[str, Any]) -> str:
    """cron 行公开字段名是 ``id``（DB 列叫 cron_id），两种都认。"""
    return str(row.get("cron_id") or row.get("id") or "")


def ensure_cron(api: Api, agent_id: str) -> str:
    """找或建 cron job（子代理执行载体）。enabled=false：不与外部定时器重复触发。"""
    jobs = api.get(f"/api/agents/{agent_id}/cron")
    rows = jobs.get("items") if isinstance(jobs, dict) else jobs
    if isinstance(rows, list):
        hit = next((j for j in rows if j.get("name") == CRON_NAME), None)
        if hit and _cron_id_of(hit):
            log(f"复用已有 cron job {_cron_id_of(hit)}")
            return _cron_id_of(hit)

    log("创建 cron job（子代理执行载体，enabled=false）")
    created = api.post(
        f"/api/agents/{agent_id}/cron",
        {
            "name": CRON_NAME,
            "trigger": f"date:{SCHEDULED_AT}",
            "prompt": "（占位，运行前会被改写）",
            "model": MODEL_REF,
            "task_type": "agent",
            "fresh_thread": True,
            "enabled": False,
        },
    )
    cron_id = _cron_id_of(created if isinstance(created, dict) else {})
    if not cron_id:
        raise Fatal(f"创建 cron job 失败：{created}")
    log(f"cron job 创建完成：{cron_id}")
    return cron_id


# ── 第一步：脚本自己跑全量测试 ───────────────────────────────────────────────

@dataclass
class TestRun:
    attempt: int
    log_path: Path
    exit_code: int | None = None
    duration_s: float = 0.0
    summary: str = ""
    exception: str = ""  # 非空 = 不可跳过的异常（跑不起来）
    timed_out: bool = False

    @property
    def ran(self) -> bool:
        return self.exit_code is not None and not self.exception

    @property
    def passed(self) -> bool:
        return self.ran and self.exit_code == 0


def _tail_summary(log_path: Path, limit: int = 4000) -> str:
    """取日志尾部（pytest 的汇总行通常在最后）。"""
    try:
        text = log_path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""
    return text[-limit:]


def _extract_summary(text: str) -> str:
    """从日志尾部挑出 pytest 的汇总行。"""
    for line in reversed(text.splitlines()):
        line = line.strip()
        if not line:
            continue
        if (" passed" in line or " failed" in line or " error" in line) and (
            "==" in line or "passed" in line or "failed" in line
        ):
            return line.lstrip("= ").strip()
    return text.strip().splitlines()[-1][:300] if text.strip() else ""


def run_pytest(attempt: int) -> TestRun:
    """在仓库根目录跑全量 pytest；后台运行 + 轮询，捕获退出码与完整日志。"""
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    log_path = REPORT_DIR / f"pytest-{stamp}.log"
    args = shlex.split(PYTEST_ARGS)
    cmd = [PYTHON_BIN, "-m", "pytest", *args]
    run = TestRun(attempt=attempt, log_path=log_path)

    log(f"第 {attempt} 次：{' '.join(cmd)}  （cwd={REPO_DIR}）")
    started = time.time()
    with log_path.open("wb") as fh:
        proc = subprocess.Popen(  # noqa: S603 — 参数全部来自本脚本配置
            cmd,
            cwd=str(REPO_DIR),
            stdout=fh,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
    run.log_path = log_path
    try:
        while True:
            code = proc.poll()
            if code is not None:
                run.exit_code = code
                break
            if time.time() - started > TEST_TIMEOUT_S:
                run.timed_out = True
                _kill_group(proc)
                run.exit_code = proc.poll()
                break
            time.sleep(POLL_INTERVAL_S)
    finally:
        run.duration_s = time.time() - started

    text = _tail_summary(log_path)
    run.summary = _extract_summary(text)

    if run.timed_out:
        run.exception = f"超过 {TEST_TIMEOUT_S}s 未结束，进程被终止"
    elif run.exit_code is None:
        run.exception = "pytest 进程没有返回退出码"
    elif run.exit_code not in (0, 1) and "error" in text.lower() and "no tests ran" in text.lower():
        # 收集阶段就崩了：不是测试失败，是跑不起来
        run.exception = f"pytest 异常退出（退出码 {run.exit_code}），疑似收集阶段崩溃"

    log(
        f"第 {attempt} 次结束：退出码={run.exit_code} 用时={run.duration_s:.0f}s "
        f"摘要={run.summary or '(无)'}"
    )
    if run.exception:
        log(f"第 {attempt} 次判定为不可跳过的异常：{run.exception}")
    return run


def _kill_group(proc: subprocess.Popen[bytes]) -> None:
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
        time.sleep(5)
        if proc.poll() is None:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        proc.kill()


# ── 第二步：子代理分析结果 ───────────────────────────────────────────────────

@dataclass
class Analysis:
    attempt: int
    ok: bool = False
    output_path: str = ""
    text: str = ""
    job_status: str | None = None
    job_error: str | None = None
    detail: str = ""


def run_analysis(
    api: Api,
    agent_id: str,
    cron_id: str,
    run: TestRun,
    attempt: int,
) -> Analysis:
    """让子代理（模型 qiniu/conatus-free）读日志并产出分析报告。"""
    workdir = agent_workdir(agent_id)
    workdir.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    out_path = workdir / f"analysis-{stamp}.md"
    out_path.unlink(missing_ok=True)

    prompt = ANALYSIS_PROMPT.format(
        log=run.log_path,
        exit_code=run.exit_code,
        summary=run.summary or "(日志尾部没有汇总行)",
        out=out_path,
    )
    if len(prompt) > 1900:
        prompt = prompt[:1900]
    api.patch(f"/api/agents/{agent_id}/cron/{cron_id}", {"prompt": prompt})

    before = _job_row(api, agent_id, cron_id)
    before_run_at = int(before.get("last_run_at") or 0)

    rec = Analysis(attempt=attempt, output_path=str(out_path))
    log(f"第 {attempt} 次分析：触发子代理（{MODEL_REF}）")
    api.post(f"/api/agents/{agent_id}/cron/{cron_id}/run-now")

    deadline = time.time() + ANALYSIS_TIMEOUT_S
    while True:
        time.sleep(POLL_INTERVAL_S)
        row = _job_row(api, agent_id, cron_id)
        last_run_at = int(row.get("last_run_at") or 0)
        status = row.get("last_status")
        if last_run_at > before_run_at and status in ("ok", "error"):
            rec.job_status = str(status)
            rec.job_error = row.get("last_error")
            break
        if time.time() > deadline:
            rec.job_status = "timeout"
            rec.detail = f"子代理超过 {ANALYSIS_TIMEOUT_S}s 未返回"
            break

    if rec.job_status == "error":
        rec.detail = f"子代理执行失败：{rec.job_error}"
        return rec
    if rec.job_status == "timeout":
        return rec

    if not out_path.exists():
        rec.detail = "子代理没有产出分析文件"
        return rec
    try:
        rec.text = out_path.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        rec.detail = f"分析文件读取失败：{exc}"
        return rec
    rec.ok = True
    rec.detail = f"分析报告 {out_path.name}（{len(rec.text)} 字符）"
    return rec


def _job_row(api: Api, agent_id: str, cron_id: str) -> dict[str, Any]:
    row = api.get(f"/api/agents/{agent_id}/cron/{cron_id}")
    return row if isinstance(row, dict) else {}


# ── 报告 ─────────────────────────────────────────────────────────────────────

def write_report(
    run: TestRun,
    analysis: Analysis | None,
    final: str,
    detail: str,
    history: list[TestRun],
) -> Path:
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    payload = {
        "finished_at": time.strftime("%Y-%m-%d %H:%M:%S %Z"),
        "model_ref": MODEL_REF,
        "repo": str(REPO_DIR),
        "pytest_args": PYTEST_ARGS,
        "final": final,
        "detail": detail,
        "test": {
            "exit_code": run.exit_code,
            "duration_s": round(run.duration_s, 1),
            "summary": run.summary,
            "log_path": str(run.log_path),
            "exception": run.exception,
            "timed_out": run.timed_out,
        },
        "analysis": None
        if analysis is None
        else {
            "ok": analysis.ok,
            "output_path": analysis.output_path,
            "job_status": analysis.job_status,
            "job_error": analysis.job_error,
            "detail": analysis.detail,
        },
        "history": [
            {
                "attempt": h.attempt,
                "exit_code": h.exit_code,
                "duration_s": round(h.duration_s, 1),
                "exception": h.exception,
                "log_path": str(h.log_path),
            }
            for h in history
        ],
    }
    json_path = REPORT_DIR / f"report-{stamp}.json"
    json_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    md = [
        "# 后端全量测试报告",
        "",
        f"- 时间：{payload['finished_at']}",
        f"- 仓库：{REPO_DIR}",
        f"- 命令：`{PYTHON_BIN} -m pytest {PYTEST_ARGS}`",
        f"- 分析模型：{MODEL_REF}",
        f"- 结论：**{final}**",
        f"- 说明：{detail}",
        "",
        "## 测试结果",
        "",
        f"- 退出码：{run.exit_code}",
        f"- 用时：{run.duration_s:.0f}s",
        f"- 摘要：{run.summary or '(无)'}",
        f"- 日志：`{run.log_path}`",
    ]
    if run.exception:
        md.append(f"- 异常：{run.exception}")
    if len(history) > 1:
        md += ["", "## 重试历史", "", "| 轮次 | 退出码 | 用时 | 异常 |", "|---|---|---|---|"]
        for h in history:
            md.append(
                f"| {h.attempt} | {h.exit_code} | {h.duration_s:.0f}s | {h.exception or '-'} |"
            )
    if analysis is not None:
        md += ["", "## 子代理分析", "", f"- 状态：{analysis.detail}"]
        if analysis.ok:
            md += ["", analysis.text]
    md.append("")
    md_path = REPORT_DIR / f"report-{stamp}.md"
    md_path.write_text("\n".join(md), encoding="utf-8")
    log(f"报告已写入 {md_path}")
    return md_path


# ── 预检 ─────────────────────────────────────────────────────────────────────

def preflight(api: Api) -> None:
    if not REPO_DIR.is_dir():
        raise Fatal(f"仓库目录不存在：{REPO_DIR}")
    if not Path(PYTHON_BIN).exists():
        raise Fatal(f"解释器不存在：{PYTHON_BIN}")
    try:
        proc = subprocess.run(  # noqa: S603
            [PYTHON_BIN, "-c", "import pytest; print(pytest.__version__)"],
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise Fatal(f"pytest 不可用：{exc}") from exc
    if proc.returncode != 0:
        raise Fatal(f"pytest 不可用：{proc.stderr.strip()[:200]}")
    log(f"预检通过：pytest {proc.stdout.strip()}，仓库 {REPO_DIR} 就位")
    try:
        api.get("/api/settings/timezone")
    except ApiError as exc:
        if exc.status not in (401, 403):
            raise Fatal(f"服务不可用：{exc}") from exc


# ── 入口 ─────────────────────────────────────────────────────────────────────

def main(argv: list[str] | None = None) -> int:
    global TEST_TIMEOUT_S, ANALYSIS_TIMEOUT_S, MAX_ATTEMPTS

    parser = argparse.ArgumentParser(description="定时跑一次后端全量测试并用子代理分析结果")
    parser.add_argument("--attempts", type=int, default=MAX_ATTEMPTS, help="不可跳过异常时的最大尝试次数")
    parser.add_argument("--timeout", type=int, default=TEST_TIMEOUT_S, help="单次测试超时秒数")
    parser.add_argument("--analysis-timeout", type=int, default=ANALYSIS_TIMEOUT_S, help="子代理分析超时秒数")
    parser.add_argument("--setup-only", action="store_true", help="只做预检与准备")
    parser.add_argument("--no-analysis", action="store_true", help="只跑测试，不做子代理分析")
    args = parser.parse_args(argv)

    TEST_TIMEOUT_S = args.timeout
    ANALYSIS_TIMEOUT_S = args.analysis_timeout
    MAX_ATTEMPTS = max(1, args.attempts)

    log(f"开始：model={MODEL_REF} repo={REPO_DIR} 最大尝试={MAX_ATTEMPTS}")
    history: list[TestRun] = []
    analysis: Analysis | None = None

    try:
        token = retry(lambda: mint_admin_token(TOKEN_TTL_S), what="签发 admin token")
        api = Api(BASE_URL, token)
        preflight(api)
        retry(lambda: ensure_provider_model(api), what="登记模型")
        agent_id = retry(lambda: ensure_agent(api), what="准备 agent")
        cron_id = retry(lambda: ensure_cron(api, agent_id), what="准备 cron job")
        log(f"agent={agent_id} cron={cron_id}")
        if args.setup_only:
            log("--setup-only：准备完成，不跑测试")
            return 0

        # ── 跑测试：不可跳过的异常重试，累计 3 次后终止 ──
        run: TestRun | None = None
        for i in range(1, MAX_ATTEMPTS + 1):
            run = run_pytest(i)
            history.append(run)
            if not run.exception:
                break
            if i < MAX_ATTEMPTS:
                log(f"第 {i} 次跑不起来，剩余 {MAX_ATTEMPTS - i} 次机会")
                time.sleep(30)

        if run is None or run.exception:
            detail = run.exception if run else "未知原因"
            write_report(run or TestRun(attempt=0, log_path=REPORT_DIR / "none.log"), None,
                         "error", f"不可跳过的异常，重试 {MAX_ATTEMPTS} 次后终止：{detail}", history)
            return 2

        # ── 子代理分析结果 ──
        if not args.no_analysis:
            for i in range(1, MAX_ATTEMPTS + 1):
                analysis = run_analysis(api, agent_id, cron_id, run, i)
                if analysis.ok:
                    break
                log(f"分析第 {i} 次失败：{analysis.detail}")
                if i < MAX_ATTEMPTS:
                    # 免费模型容易撞 429 限流，退避后再试，别把额度一次打光
                    wait = 60 * i
                    log(f"等待 {wait}s 后重试分析")
                    time.sleep(wait)
            if analysis is None or not analysis.ok:
                detail = analysis.detail if analysis else "未执行"
                write_report(run, analysis, "error",
                             f"子代理分析重试 {MAX_ATTEMPTS} 次仍失败：{detail}", history)
                return 2

        final = "pass" if run.passed else "fail"
        detail = (
            "全量测试通过" if run.passed else f"全量测试完成但有失败用例：{run.summary}"
        )
        write_report(run, analysis, final, detail, history)
        return 0 if run.passed else 1
    except Fatal as exc:
        log(f"不可跳过的异常：{exc}")
        return 2
    except Exception as exc:  # noqa: BLE001
        log(f"未预期异常：{exc!r}")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
