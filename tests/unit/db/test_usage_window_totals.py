"""Windowed token totals used by ``token_quota_window`` accounting."""

from __future__ import annotations

import time
from pathlib import Path

import pytest

from octop.infra.db.migrate import run_migrations
from octop.infra.db.pool import SqlitePool
from octop.infra.db.repos.agents import AgentRepo
from octop.infra.db.repos.usage import UsageRepo
from octop.infra.db.repos.users import UserRepo

_DAY = 86_400


@pytest.fixture
def repos(tmp_path: Path) -> tuple[UsageRepo, int]:
    db = SqlitePool(tmp_path / "octop.db")
    run_migrations(db)
    uid = UserRepo(db).create(username="u", password_hash="h", role="user")
    AgentRepo(db).create(agent_id="a1", user_id=uid, name="a")
    return UsageRepo(db), uid


def test_window_total_ignores_rows_outside_window(repos: tuple[UsageRepo, int]) -> None:
    usage, uid = repos
    now = int(time.time())
    usage.record(
        agent_id="a1",
        user_id=uid,
        input_tokens=6,
        output_tokens=4,
        thread_id="t1",
        ts=now - 3 * _DAY,
    )
    usage.record(
        agent_id="a1", user_id=uid, input_tokens=2, output_tokens=1, thread_id="t1", ts=now - 60
    )

    assert usage.total_tokens_for_user(uid) == 13
    assert usage.total_tokens_for_user_window(uid, "last_7d", now=now) == 13
    assert usage.total_tokens_for_user_window(uid, "today", now=now) == 3
    assert usage.total_tokens_for_user_window(uid, "all", now=now) == 13


def test_window_total_all_matches_lifetime(repos: tuple[UsageRepo, int]) -> None:
    usage, uid = repos
    now = int(time.time())
    usage.record(
        agent_id="a1",
        user_id=uid,
        input_tokens=3,
        output_tokens=2,
        thread_id="t",
        ts=now - 40 * _DAY,
    )
    assert usage.total_tokens_for_user_window(uid, "all", now=now) == 5
    assert usage.total_tokens_for_user_window(uid, "last_7d", now=now) == 0


def test_window_total_scoped_per_user(repos: tuple[UsageRepo, int]) -> None:
    usage, uid = repos
    now = int(time.time())
    usage.record(agent_id="a1", user_id=uid, input_tokens=5, output_tokens=0, thread_id="t", ts=now)
    assert usage.total_tokens_for_user_window(uid + 1, "last_7d", now=now) == 0
