"""tests/unit/test_run_backend_full_test.py — 定时全量测试编排脚本的回归测试。

重点覆盖 2026-11-22 凌晨那次事故的根因：全量测试跑在**生产** ``OCTOP_HOME`` 上，
``octop clean --all`` 这类用例把线上数据目录（含正在写的 pytest 日志）整个删掉，
于是"测试失败"的结论和子代理分析都建立在不存在的证据上。
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

_SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "run_backend_full_test.py"


def _load():
    spec = importlib.util.spec_from_file_location("run_backend_full_test", _SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    # dataclass 装饰器会回查 sys.modules[cls.__module__]，必须先登记。
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_pytest_env_isolates_the_data_dir(monkeypatch: pytest.MonkeyPatch) -> None:
    """pytest 子进程必须跑在沙箱目录里，不能碰到生产 OCTOP_HOME。"""
    monkeypatch.setenv("OCTOP_HOME", "/opt/octop-data")
    monkeypatch.setenv("OCTOP_DATABASE_URL", "postgresql://prod/prod")
    mod = _load()

    env = mod.pytest_env()
    assert env["OCTOP_HOME"] == str(mod.ISOLATED_HOME)
    assert env["OCTOP_HOME"] != "/opt/octop-data"
    assert env["HOME"].startswith(str(mod.ISOLATED_HOME))
    # 外部数据库配置也不能把测试拽到真实 PG 上。
    assert "OCTOP_DATABASE_URL" not in env


def test_isolated_home_lives_outside_the_production_home(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OCTOP_HOME", "/opt/octop-data")
    mod = _load()
    assert not str(mod.ISOLATED_HOME).startswith("/opt/octop-data/")


def test_classify_run_treats_failures_as_a_result_not_an_exception(tmp_path: Path) -> None:
    """退出码 1（有失败用例）是结论，不该被当成异常重试。"""
    mod = _load()
    log = tmp_path / "pytest.log"
    log.write_text("F failed, 10 passed in 3s\n", encoding="utf-8")
    assert mod.classify_run(log_path=log, exit_code=1, text=log.read_text(), timed_out=False) == ""


def test_classify_run_flags_a_vanished_log(tmp_path: Path) -> None:
    """日志被删 = 没有证据可分析 = 异常，必须重试而不是出结论。"""
    mod = _load()
    missing = tmp_path / "pytest.log"
    reason = mod.classify_run(log_path=missing, exit_code=1, text="", timed_out=False)
    assert reason
    assert "消失" in reason


def test_classify_run_flags_an_empty_log(tmp_path: Path) -> None:
    mod = _load()
    log = tmp_path / "pytest.log"
    log.write_text("", encoding="utf-8")
    reason = mod.classify_run(log_path=log, exit_code=0, text="", timed_out=False)
    assert reason
    assert "空" in reason


def test_classify_run_flags_a_timeout(tmp_path: Path) -> None:
    mod = _load()
    log = tmp_path / "pytest.log"
    log.write_text("running\n", encoding="utf-8")
    reason = mod.classify_run(log_path=log, exit_code=None, text="running\n", timed_out=True)
    assert reason


def test_analysis_saw_no_log_detects_the_broken_report() -> None:
    """2026-11-22 那份"日志不存在"的分析不能被当成成功。"""
    mod = _load()
    broken = (
        "# 后端全量测试分析报告\n"
        "1. 无法分析：指定的日志文件在文件系统中不存在。\n"
        "- `stat ...` → `No such file or directory`\n"
    )
    assert mod.analysis_saw_no_log(broken)


def test_analysis_saw_no_log_accepts_a_real_report() -> None:
    mod = _load()
    good = (
        "# 后端全量测试分析报告\n"
        "## 总判断\n1. 全量测试有 3 个失败用例，均为断言失败。\n"
        "- `tests/unit/x.py::test_y` — assert 1 == 2\n"
    )
    assert not mod.analysis_saw_no_log(good)
