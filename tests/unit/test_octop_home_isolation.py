"""测试进程永远不能解析到真实数据目录。

``PathLayout.from_env()`` 优先用 ``OCTOP_HOME``，其次才是 ``~/.octop``。在部署机
上跑全量测试时环境里带着 ``OCTOP_HOME=/opt/octop-data``，于是 ``octop clean --all``
/ ``octop init --force`` 这类用例会删掉线上 DB、配置、agent 工作区 —— 2026-11-22
凌晨那次事故就是这么发生的。``tests/conftest.py`` 负责把环境变量清掉。
"""

from __future__ import annotations

import os
from pathlib import Path

from octop.infra.utils.paths import PathLayout


def test_ambient_octop_home_is_dropped() -> None:
    assert "OCTOP_HOME" not in os.environ


def test_data_root_resolves_into_the_sandbox_home() -> None:
    root = PathLayout.from_env().root
    assert root == Path.home() / ".octop"
    assert root != Path("/opt/octop-data")
