"""缺少腾讯云 SDK 时，抛出的应是可操作错误而不是 ImportError。"""

from __future__ import annotations

import importlib.abc
import sys
import time

import pytest

from octop.infra.cloud import tencent
from octop.infra.cloud.tencent import CloudCredential, list_regions
from octop.infra.errors import ErrorCode, OctopError


class _BlockTencentCloud(importlib.abc.MetaPathFinder):
    """让 ``import tencentcloud.*`` 像没装 SDK 一样失败。"""

    def find_spec(self, fullname: str, path: object = None, target: object = None) -> None:
        if fullname == "tencentcloud" or fullname.startswith("tencentcloud."):
            raise ImportError(f"No module named {fullname!r}")
        return None


@pytest.fixture
def without_sdk(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in [n for n in sys.modules if n == "tencentcloud" or n.startswith("tencentcloud.")]:
        monkeypatch.delitem(sys.modules, name, raising=False)
    monkeypatch.setattr(sys, "meta_path", [_BlockTencentCloud(), *sys.meta_path])
    tencent._REGION_CACHE.clear()


def _credential() -> CloudCredential:
    return CloudCredential(
        secret_id="AKIDmissing0000",
        secret_key="sk",
        token="tk",
        expires_at=time.time() + 3600,
        access_token="at",
        access_expires_at=time.time() + 3600,
        refresh_token="rt",
        open_id="oid",
        site="cn",
    )


def test_missing_sdk_raises_actionable_error(without_sdk: None) -> None:
    with pytest.raises(OctopError) as excinfo:
        list_regions(_credential(), nocache=True)

    error = excinfo.value
    assert error.code is ErrorCode.FEATURE_DEPS_MISSING
    assert error.details["feature"] == "tencent"
    assert error.details["part"] == "deps-tencent"
    assert error.details["component"] == "octop[tencentcloud]"
    assert error.status == 503


def test_missing_sdk_message_is_localized(without_sdk: None) -> None:
    with pytest.raises(OctopError) as excinfo:
        list_regions(_credential(), nocache=True)

    message = excinfo.value.localized_message("zh")
    assert "octop[tencentcloud]" in message
