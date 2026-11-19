"""Optional runtime components that may be missing when a feature is used.

Since the runtime slimming (playwright and tencentcloud-sdk-python moved out of
the core dependencies), a feature can hit a missing optional package at call
time. These helpers turn that into one structured, actionable error:
``ErrorCode.FEATURE_DEPS_MISSING`` whose ``details`` carry

- ``feature`` — the feature id (``tencent``, ``browser``, …)
- ``part`` — the optional runtime shard the desktop shell can fetch on demand
  (matches the part ids in ``desktop/portable/pack_portable_shards.py``)
- ``component`` — the installable name, e.g. ``octop[tencentcloud]``
- ``modules`` — the importable module names that were missing
"""

from __future__ import annotations

import importlib
from typing import Any

from octop.infra.errors import ErrorCode, OctopError

__all__ = ["import_optional", "missing_feature_error"]


def missing_feature_error(
    feature: str,
    *,
    part: str,
    component: str,
    modules: tuple[str, ...] = (),
    detail: str = "",
) -> OctopError:
    """Build the error raised when an optional component is not installed."""
    details: dict[str, Any] = {
        "feature": feature,
        "part": part,
        "component": component,
        "modules": ",".join(modules),
    }
    if detail:
        details["detail"] = detail
    message = f"{component} is not installed"
    if detail:
        message = f"{message}: {detail}"
    return OctopError(ErrorCode.FEATURE_DEPS_MISSING, message, details=details)


def import_optional(
    module: str,
    *,
    feature: str,
    part: str,
    component: str,
    attr: str | None = None,
) -> Any:
    """Import *module* (or one of its attributes) or raise the missing-dep error.

    The module is imported lazily on purpose: the caller only pays for it when
    the feature is actually used, and a missing package becomes a 503 with
    actionable details instead of an opaque ``ImportError`` traceback.
    """
    try:
        imported = importlib.import_module(module)
    except ImportError as exc:
        raise missing_feature_error(
            feature,
            part=part,
            component=component,
            modules=(module.split(".", 1)[0],),
            detail=str(exc),
        ) from exc
    return getattr(imported, attr) if attr else imported
