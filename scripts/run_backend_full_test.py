#!/usr/bin/env python3
"""定时对当前后端跑一次全量测试，并用子代理模型（默认 qiniu/conatus-free）分析结果。

流程：

1. **预检** —— 服务可达、仓库与 venv 就位、pytest 可用。
2. **跑测试（脚本自己跑，不经 LLM）** —— 在仓库根目录执行全量 pytest，
   后台运行 + 轮询，拿到退出码与完整日志。
   - 测试跑在**独立的沙箱数据目录**里（``TEST_ISOLATED_HOME``，默认
     ``/opt/octop-data-test-home``）：全量测试里有 ``octop clean --all`` /
     ``octop init --force`` 这类会删数据的用例，跑在生产 ``OCTOP_HOME`` 上
     会把线上 DB、配置、agent 工作区连同正在写的 pytest 日志一起删掉。
   - 跑完了但有失败用例 → 这是**结论**，不是异常：不重试，直接进分析。
   - 跑不起来（解释器缺失、依赖缺失、收集阶段崩溃、进程被杀、日志被删）→ 这是
     **不可跳过的异常**：重试，累计 3 次仍失败就终止。
3. **结果分析（子代理做）** —— 把日志路径交给一个 Octop 子代理，让它读日志、归因失败
   用例、给严重度与下一步建议，产出一份 Markdown 分析报告。分析失败按 3 次重试
   （退避 60s / 120s）。
4. **模型容灾** —— 主模型（默认 ``qiniu/conatus-free``）重试 3 次仍是 429 限流时，
   自动切到备用模型（默认 ``MiniMax-M3.1-Flash-Preview``）重跑分析；切换过程、
   命中 429 的模型、以及服务端日志里的 429 证据行都会记进脚本日志与报告。
5. **出报告** —— 测试结论 + 子代理分析 + 容灾记录一起落到报告目录，退出码区分
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
import shutil
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
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
# 备用模型：主模型连续 3 次撞 429 限流时切过去重试。留空即关闭容灾。
FALLBACK_MODEL_ID = _env("TEST_FALLBACK_MODEL", "MiniMax-M3.1-Flash-Preview")
FALLBACK_MODEL_REF = _env(
    "TEST_FALLBACK_MODEL_REF", f"{PROVIDER_NAME}/{FALLBACK_MODEL_ID}" if FALLBACK_MODEL_ID else ""
)
# 服务端日志：用来找"是哪个模型 429"的原始证据行。
SERVER_LOG = Path(_env("TEST_SERVER_LOG", str(Path(OCTOP_HOME) / "logs" / "octop.log")))
AGENT_NAME = _env("TEST_AGENT_NAME", "后端全量测试")
AGENT_USER = _env("TEST_AGENT_USER", "admin")
MAX_ATTEMPTS = int(_env("TEST_MAX_ATTEMPTS", "3"))
TEST_TIMEOUT_S = int(_env("TEST_TIMEOUT", "5400"))
ANALYSIS_TIMEOUT_S = int(_env("TEST_ANALYSIS_TIMEOUT", "1800"))
POLL_INTERVAL_S = int(_env("TEST_POLL_INTERVAL", "15"))
# 整个流程（pytest 可能跑 1 小时 + 多轮分析重试）都要用这个 token，别让它半路过期。
TOKEN_TTL_S = int(_env("TEST_TOKEN_TTL", "86400"))
REPORT_DIR = Path(_env("TEST_REPORT_DIR", str(Path(OCTOP_HOME) / "test-reports")))
# 测试进程专用的沙箱数据目录：测试必须跑在**独立的** OCTOP_HOME 里。
# 生产 OCTOP_HOME（/opt/octop-data）里跑全量测试 = 让 `octop clean --all`
# 这类用例删掉线上 DB、配置、agent 工作区，连正在写的 pytest 日志一起删。
# 默认放在生产目录**外面**（同级兄弟目录），避免误伤。
ISOLATED_HOME = Path(
    _env(
        "TEST_ISOLATED_HOME",
        str(Path(OCTOP_HOME).with_name(Path(OCTOP_HOME).name + "-test-home")),
    )
)
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


def ensure_provider_models(api: Api, model_ids: list[str]) -> None:
    """把目标模型登记进 provider 的 models_json，否则 harness 看不到它。"""
    model_ids = [mid for mid in model_ids if mid]
    if not model_ids:
        return
    providers = api.get("/api/admin/providers")
    if not isinstance(providers, list) or not providers:
        raise Fatal("GET /api/admin/providers 返回空")
    target = next((p for p in providers if p.get("name") == PROVIDER_NAME), None)
    if target is None:
        raise Fatal(f"找不到名为 {PROVIDER_NAME!r} 的 provider")
    models = target.get("models") or []
    missing = [mid for mid in model_ids if not any(str(m.get("id")) == mid for m in models)]
    if not missing:
        log(f"模型 {', '.join(model_ids)} 已在 provider {PROVIDER_NAME!r} 的模型列表里")
        return
    log(f"provider {PROVIDER_NAME!r} 里没有 {', '.join(missing)}，正在登记")
    api.patch(
        f"/api/admin/providers/{target['id']}",
        {
            "models": [
                *models,
                *[
                    {
                        "id": mid,
                        "name": mid,
                        "enabled": True,
                        "input": ["text"],
                        "visibility": "all",
                        "group_ids": [],
                    }
                    for mid in missing
                ],
            ]
        },
    )
    log(f"已登记 {', '.join(missing)}")


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


def pytest_env() -> dict[str, str]:
    """pytest 子进程的环境：**沙箱化**的 OCTOP_HOME / HOME。

    测试必须跑在自己的数据目录里。生产 OCTOP_HOME（/opt/octop-data）里跑全量
    测试会让 `octop clean --all` / `octop init --force` 这类用例删掉线上 DB、
    配置、agent 工作区，连正在写的 pytest 日志都会被删掉 —— 那样得到的
    "有失败用例" 结论和子代理分析都是假的。
    """
    env = dict(os.environ)
    env["OCTOP_HOME"] = str(ISOLATED_HOME)
    env["HOME"] = str(ISOLATED_HOME / "home")
    env["USERPROFILE"] = env["HOME"]
    # 别让外部数据库配置把测试拽到真实 PG 上。
    for key in (
        "OCTOP_DATABASE_URL",
        "OCTOP_DATABASE_DRIVER",
        "OCTOP_DATABASE_SQLITE_PATH",
        "OCTOP_DATABASE_HOST",
        "OCTOP_DATABASE_PORT",
        "OCTOP_DATABASE_NAME",
        "OCTOP_DATABASE_USER",
        "OCTOP_DATABASE_PASSWORD",
    ):
        env.pop(key, None)
    return env


def run_pytest(attempt: int) -> TestRun:
    """在仓库根目录跑全量 pytest；后台运行 + 轮询，捕获退出码与完整日志。"""
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    log_path = REPORT_DIR / f"pytest-{stamp}.log"
    args = shlex.split(PYTEST_ARGS)
    cmd = [PYTHON_BIN, "-m", "pytest", *args]
    run = TestRun(attempt=attempt, log_path=log_path)

    # 沙箱数据目录：每次跑之前清空，保证测试看到的是干净状态。
    if ISOLATED_HOME.exists():
        shutil.rmtree(ISOLATED_HOME, ignore_errors=True)
    ISOLATED_HOME.mkdir(parents=True, exist_ok=True)
    (ISOLATED_HOME / "home").mkdir(parents=True, exist_ok=True)

    log(f"第 {attempt} 次：{' '.join(cmd)}  （cwd={REPO_DIR}）")
    log(f"测试沙箱：OCTOP_HOME={ISOLATED_HOME}（生产目录 {OCTOP_HOME} 不受影响）")
    started = time.time()
    with log_path.open("wb") as fh:
        proc = subprocess.Popen(  # noqa: S603 — 参数全部来自本脚本配置
            cmd,
            cwd=str(REPO_DIR),
            stdout=fh,
            stderr=subprocess.STDOUT,
            start_new_session=True,
            env=pytest_env(),
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
    run.exception = classify_run(
        log_path=log_path,
        exit_code=run.exit_code,
        text=text,
        timed_out=run.timed_out,
    )

    log(
        f"第 {attempt} 次结束：退出码={run.exit_code} 用时={run.duration_s:.0f}s "
        f"摘要={run.summary or '(无)'}"
    )
    if run.exception:
        log(f"第 {attempt} 次判定为不可跳过的异常：{run.exception}")
    return run


def classify_run(
    *,
    log_path: Path,
    exit_code: int | None,
    text: str,
    timed_out: bool,
) -> str:
    """跑完之后判断这是「结论」还是「异常」。返回异常描述，空串 = 正常跑完。

    退出码 1（有失败用例）是**结论**，不重试；日志不见了 / 是空的 / 收集阶段崩溃
    是**异常**，因为没有证据可分析。
    """
    if timed_out:
        return f"超过 {TEST_TIMEOUT_S}s 未结束，进程被终止"
    if exit_code is None:
        return "pytest 进程没有返回退出码"
    if not log_path.exists():
        # 日志文件被人删了 —— 典型是测试把数据目录整个清了。退出码再准也没用，
        # 因为没有证据可分析；这是**异常**，不是结论。
        return f"pytest 日志 {log_path} 在运行后消失（数据目录被清空？）"
    if log_path.stat().st_size == 0:
        return f"pytest 日志 {log_path} 是空的（输出被重定向丢了？）"
    if exit_code not in (0, 1) and "error" in text.lower() and "no tests ran" in text.lower():
        # 收集阶段就崩了：不是测试失败，是跑不起来
        return f"pytest 异常退出（退出码 {exit_code}），疑似收集阶段崩溃"
    return ""


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
    model_ref: str = MODEL_REF


def run_analysis(
    api: Api,
    agent_id: str,
    cron_id: str,
    run: TestRun,
    attempt: int,
    model_ref: str = MODEL_REF,
    log_offset: int = 0,
) -> Analysis:
    """让子代理（默认模型 qiniu/conatus-free）读日志并产出分析报告。"""
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
    api.patch(
        f"/api/agents/{agent_id}/cron/{cron_id}",
        {"prompt": prompt, "model": model_ref},
    )

    before = _job_row(api, agent_id, cron_id)
    before_run_at = int(before.get("last_run_at") or 0)

    rec = Analysis(attempt=attempt, output_path=str(out_path), model_ref=model_ref)
    log(f"第 {attempt} 次分析：触发子代理（模型 {model_ref}）")
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
        evidence = rate_limit_evidence(model_ref, log_offset)
        rec.detail = (
            f"子代理没有产出分析文件；但服务端日志显示该模型命中 429：{evidence}"
            if evidence
            else "子代理没有产出分析文件"
        )
        return rec
    try:
        rec.text = out_path.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        rec.detail = f"分析文件读取失败：{exc}"
        return rec
    if analysis_saw_no_log(rec.text):
        # 子代理没看到日志（路径不可见 / 日志被删）却交了报告 —— 这种报告是空的，
        # 不能当成功，否则凌晨的结论就是"没法分析"。
        rec.detail = "子代理没能读到测试日志（报告里说日志不存在），分析无效"
        return rec
    rec.ok = True
    rec.detail = f"分析报告 {out_path.name}（{len(rec.text)} 字符）"
    return rec


def _job_row(api: Api, agent_id: str, cron_id: str) -> dict[str, Any]:
    row = api.get(f"/api/agents/{agent_id}/cron/{cron_id}")
    return row if isinstance(row, dict) else {}


# 子代理"没找到日志"时会说的字样。只在报告开头（总判断那几行）里找，
# 免得正文里引用测试输出里的同名词造成误判。
NO_LOG_MARKERS = (
    "no such file or directory",
    "path_not_found",
    "日志文件不存在",
    "在文件系统中不存在",
    "无法分析",
)


def analysis_saw_no_log(text: str) -> bool:
    """判断子代理是不是因为"看不到日志"而交了报告。"""
    head = text[:1500].lower()
    return any(marker in head for marker in NO_LOG_MARKERS)


# ── 模型容灾：429 识别 / 证据 / 切换 ─────────────────────────────────────────

# 网关限流的几种文案（litellm / openai SDK / 上游 body 都会命中）：
#   openai.RateLimitError: Error code: 429 - {... 'code': 'free_campaign_global_limit'}
#   RateLimitError: Error code: 429
#   httpx: 429 Too Many Requests
RATE_LIMIT_MARKERS = (
    "ratelimiterror",
    "rate_limit",
    "too many requests",
    "error code: 429",
    "free_campaign_global_limit",
)


def is_rate_limit(text: str | None) -> bool:
    """判断一段错误文本是不是 429 限流。"""
    if not text:
        return False
    low = text.lower()
    return any(marker in low for marker in RATE_LIMIT_MARKERS)


def server_log_offset() -> int:
    """当前服务端日志的字节位置（用来只读本次尝试之后新增的日志）。"""
    try:
        return SERVER_LOG.stat().st_size
    except OSError:
        return 0


def rate_limit_evidence(model_ref: str, since_offset: int = 0, limit: int = 400_000) -> str:
    """从服务端日志里找该模型最近一条 429 证据行 —— 回答"是哪个模型 429"。

    ``since_offset`` 之前的日志一律不看，避免把上次运行的旧 429 算到这次头上。
    """
    try:
        with SERVER_LOG.open("rb") as fh:
            fh.seek(0, os.SEEK_END)
            size = fh.tell()
            start = max(0, since_offset, size - limit)
            fh.seek(start)
            tail = fh.read().decode("utf-8", "replace")
    except OSError:
        return ""
    model_id = model_ref.split("/", 1)[1] if "/" in model_ref else model_ref
    hit = ""
    for line in tail.splitlines():
        if not is_rate_limit(line):
            continue
        if model_ref in line or model_id in line:
            hit = line.strip()
    return hit[:400]


@dataclass
class ModelAttempt:
    """一次分析尝试的记录（用于日志与报告）。"""

    model_ref: str
    attempt: int
    ok: bool
    detail: str
    rate_limited: bool
    evidence: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "model_ref": self.model_ref,
            "attempt": self.attempt,
            "ok": self.ok,
            "rate_limited": self.rate_limited,
            "detail": self.detail,
            "evidence": self.evidence,
        }


def model_chain() -> list[str]:
    """模型链：主模型在前，备用模型在后（容灾开关）。"""
    chain = [MODEL_REF]
    if FALLBACK_MODEL_REF and FALLBACK_MODEL_REF != MODEL_REF:
        chain.append(FALLBACK_MODEL_REF)
    return chain


def set_cron_model(api: Api, agent_id: str, cron_id: str, model_ref: str) -> None:
    """把分析用的 cron job 切到指定模型。"""
    api.patch(f"/api/agents/{agent_id}/cron/{cron_id}", {"model": model_ref})
    log(f"cron job 的分析模型已切换为 {model_ref}")


def analyze_with_failover(
    api: Api,
    agent_id: str,
    cron_id: str,
    run: TestRun,
) -> tuple[Analysis | None, list[ModelAttempt]]:
    """按模型链做分析：主模型重试耗尽且仍是 429 → 切到备用模型继续。

    非 429 的失败不触发切换（换模型也救不了），保持原口径：重试耗尽即终止。
    """
    chain = model_chain()
    attempts: list[ModelAttempt] = []
    analysis: Analysis | None = None

    for index, model_ref in enumerate(chain):
        for i in range(1, MAX_ATTEMPTS + 1):
            log_offset = server_log_offset()
            analysis = run_analysis(api, agent_id, cron_id, run, i, model_ref, log_offset)
            rate_limited = is_rate_limit(analysis.detail) or is_rate_limit(analysis.job_error)
            evidence = rate_limit_evidence(model_ref, log_offset) if rate_limited else ""
            attempts.append(
                ModelAttempt(model_ref, i, analysis.ok, analysis.detail, rate_limited, evidence)
            )
            if analysis.ok:
                log(f"分析成功（模型 {model_ref}，第 {i} 次）")
                return analysis, attempts
            log(
                f"分析第 {i}/{MAX_ATTEMPTS} 次失败（模型 {model_ref}）：{analysis.detail}"
                + (f" —— 命中 429 限流，证据：{evidence}" if rate_limited else "")
            )
            if i < MAX_ATTEMPTS:
                # 免费模型容易撞 429 限流，退避后再试，别把额度一次打光
                wait = 60 * i
                log(f"等待 {wait}s 后重试分析（仍用 {model_ref}）")
                time.sleep(wait)

        last = attempts[-1]
        if not last.rate_limited:
            log(f"模型 {model_ref} 重试 {MAX_ATTEMPTS} 次仍失败（非 429 限流），不切换模型")
            return analysis, attempts
        if index == len(chain) - 1:
            log(f"模型 {model_ref} 重试 {MAX_ATTEMPTS} 次仍是 429，且没有更多备用模型，终止")
            return analysis, attempts
        next_ref = chain[index + 1]
        log(f"⚠ 命中 429 的模型：{model_ref}（连续 {MAX_ATTEMPTS} 次） → 切换到备用模型 {next_ref}")
        set_cron_model(api, agent_id, cron_id, next_ref)

    return analysis, attempts


# ── 报告 ─────────────────────────────────────────────────────────────────────


def write_report(
    run: TestRun,
    analysis: Analysis | None,
    final: str,
    detail: str,
    history: list[TestRun],
    attempts: list[ModelAttempt] | None = None,
) -> Path:
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    attempts = attempts or []
    used_model = next((a.model_ref for a in reversed(attempts) if a.ok), MODEL_REF)
    switched = len({a.model_ref for a in attempts}) > 1
    payload = {
        "finished_at": time.strftime("%Y-%m-%d %H:%M:%S %Z"),
        "model_ref": MODEL_REF,
        "fallback_model_ref": FALLBACK_MODEL_REF,
        "analysis_model": used_model,
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
            "model_ref": analysis.model_ref,
        },
        "failover": {
            "chain": model_chain(),
            "switched": switched,
            "analysis_model": used_model,
            "attempts": [a.to_dict() for a in attempts],
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
        f"- 分析模型：{MODEL_REF}（备用：{FALLBACK_MODEL_REF or '无'}）",
        f"- 实际分析模型：{used_model}" + ("（已容灾切换）" if switched else ""),
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
    if attempts:
        md += [
            "",
            "## 模型容灾",
            "",
            f"- 模型链：{' → '.join(model_chain())}",
            f"- 是否切换：{'是' if switched else '否'}",
            "",
            "| 轮次 | 模型 | 结果 | 429 | 失败原因 |",
            "|---|---|---|---|---|",
        ]
        for a in attempts:
            md.append(
                f"| {a.attempt} | {a.model_ref} | {'成功' if a.ok else '失败'} "
                f"| {'是' if a.rate_limited else '否'} | {a.detail.replace('|', '/')} |"
            )
        evidence_lines = [a.evidence for a in attempts if a.evidence]
        if evidence_lines:
            md += ["", "429 证据（服务端日志）：", ""]
            md += [f"- {line}" for line in dict.fromkeys(evidence_lines)]
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
    parser.add_argument(
        "--attempts", type=int, default=MAX_ATTEMPTS, help="不可跳过异常时的最大尝试次数"
    )
    parser.add_argument("--timeout", type=int, default=TEST_TIMEOUT_S, help="单次测试超时秒数")
    parser.add_argument(
        "--analysis-timeout", type=int, default=ANALYSIS_TIMEOUT_S, help="子代理分析超时秒数"
    )
    parser.add_argument("--setup-only", action="store_true", help="只做预检与准备")
    parser.add_argument("--no-analysis", action="store_true", help="只跑测试，不做子代理分析")
    args = parser.parse_args(argv)

    TEST_TIMEOUT_S = args.timeout
    ANALYSIS_TIMEOUT_S = args.analysis_timeout
    MAX_ATTEMPTS = max(1, args.attempts)

    log(
        f"开始：model={MODEL_REF} 备用={FALLBACK_MODEL_REF or '无'} "
        f"repo={REPO_DIR} 最大尝试={MAX_ATTEMPTS}"
    )
    history: list[TestRun] = []
    analysis: Analysis | None = None
    attempts: list[ModelAttempt] = []

    try:
        token = retry(lambda: mint_admin_token(TOKEN_TTL_S), what="签发 admin token")
        api = Api(BASE_URL, token)
        preflight(api)
        retry(
            lambda: ensure_provider_models(api, [MODEL_ID, FALLBACK_MODEL_ID]),
            what="登记模型",
        )
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
            write_report(
                run or TestRun(attempt=0, log_path=REPORT_DIR / "none.log"),
                None,
                "error",
                f"不可跳过的异常，重试 {MAX_ATTEMPTS} 次后终止：{detail}",
                history,
                attempts,
            )
            return 2

        # ── 子代理分析结果（主模型撞 429 就切备用模型） ──
        if not args.no_analysis:
            try:
                analysis, attempts = analyze_with_failover(api, agent_id, cron_id, run)
            finally:
                # 无论成败都把 cron 的模型恢复成主模型，避免污染下一次手动执行
                try:
                    set_cron_model(api, agent_id, cron_id, MODEL_REF)
                except Exception as exc:  # noqa: BLE001 — 恢复失败不掩盖主结果
                    log(f"恢复 cron 模型为 {MODEL_REF} 失败：{exc}")
            if analysis is None or not analysis.ok:
                detail = analysis.detail if analysis else "未执行"
                write_report(
                    run,
                    analysis,
                    "error",
                    f"子代理分析失败（{len(attempts)} 次尝试）：{detail}",
                    history,
                    attempts,
                )
                return 2

        final = "pass" if run.passed else "fail"
        detail = "全量测试通过" if run.passed else f"全量测试完成但有失败用例：{run.summary}"
        write_report(run, analysis, final, detail, history, attempts)
        return 0 if run.passed else 1
    except Fatal as exc:
        log(f"不可跳过的异常：{exc}")
        return 2
    except Exception as exc:  # noqa: BLE001
        log(f"未预期异常：{exc!r}")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
