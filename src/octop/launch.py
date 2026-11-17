"""Composition root — wire OctopServer, FastAPI, and uvicorn for ``octop run``."""

from __future__ import annotations

import asyncio
import logging
import sys
from contextlib import suppress
from typing import Any

from starlette.types import ASGIApp

from octop.config import OctopConfig
from octop.infra.base_path import BasePathApp, normalize_base_path, set_base_path
from octop.infra.desktop import desktop_shell_enabled
from octop.infra.server import OctopServer
from octop.infra.utils.accept_errors import coalesce_accept_errors

logger = logging.getLogger(__name__)

# uvicorn's default ping_timeout is 20s. A busy peer — demo.octop.chat runs
# dozens of agents on one event loop — often reads the pong later than that
# and then closes the socket with 1011 "keepalive ping timeout". The dialer
# redials at once, so cloud collab looks like it is flapping. Keep sending
# pings; do not drop the connection on a late pong. BridgeSession's
# application heartbeat still detects a half-open link.
_WS_PING_INTERVAL = 20.0
_WS_PING_TIMEOUT: float | None = None


def build_asgi_app(server: OctopServer, cfg: OctopConfig) -> ASGIApp:
    """Build the HTTP app, wrapped for sub-path deployment when configured.

    ``cfg.base_path`` (config.json → ``base_path``, env → ``OCTOP_BASE_PATH``)
    mounts the whole app under that prefix: ``/videogen/api/health`` is served,
    ``/api/health`` is not. An empty base path keeps the root deployment
    behaviour byte-for-byte.
    """
    from octop.api.app import build_app

    app = build_app(server)
    try:
        base_path = normalize_base_path(cfg.base_path)
    except ValueError:
        logger.error("invalid base_path %r; serving at the root path", cfg.base_path)
        base_path = ""
    set_base_path(base_path)
    if not base_path:
        return app
    return BasePathApp(app, base_path)


def _ensure_linux_bubblewrap() -> None:
    """Best-effort startup provisioning; never fail the ``octop run`` process."""
    try:
        from octop.infra.utils.bwrap import ensure_bubblewrap

        result = ensure_bubblewrap()
    except Exception:
        logger.warning("background bubblewrap provisioning failed", exc_info=True)
        return
    status = result.get("status")
    detail = result.get("detail")
    if status == "degraded":
        logger.warning("background bubblewrap provisioning degraded: %s", detail or "unknown")
    else:
        logger.info("background bubblewrap provisioning status=%s", status)


def _schedule_linux_bubblewrap_ensure() -> asyncio.Task[None] | None:
    """Run bubblewrap provisioning once in the background on Linux."""
    if not sys.platform.startswith("linux"):
        return None
    return asyncio.create_task(
        asyncio.to_thread(_ensure_linux_bubblewrap),
        name="ensure-linux-bubblewrap",
    )


async def _cancel_background_task(task: asyncio.Task[None] | None) -> None:
    """Drop a startup background task on shutdown; never raise."""
    if task is None or task.done():
        return
    task.cancel()
    with suppress(asyncio.CancelledError):
        await task


async def _serve(server: Any) -> None:
    await server.serve()


async def run_foreground(
    *,
    host: str | None,
    port: int | None,
    reload: bool,
    workers: int,
    log_level: str | None,
    ssl_certfile: str | None,
    ssl_keyfile: str | None,
) -> None:
    """Boot the domain server, serve the HTTP API, then shut down cleanly."""
    import uvicorn

    from octop.infra.bridge.transport import BRIDGE_WS_MAX_BYTES
    from octop.infra.setup.tls.http_companion import build_http_companion_app
    from octop.infra.setup.tls.listeners import build_listen_plan
    from octop.infra.setup.tls.store import resolve_tls_paths

    srv = OctopServer()
    await srv.start()
    bwrap_task = _schedule_linux_bubblewrap_ensure()
    # Greenfield deferral leaves services unset until /setup/database binds.
    cfg = srv.services.config if srv.services is not None else srv.config
    assert cfg is not None
    bind_host = host or cfg.bind_host
    bind_port = port or cfg.port
    if desktop_shell_enabled():
        # Desktop-hosted sidecar always serves one loopback HTTP listener; it
        # must ignore any persisted TLS / dual-port configuration.
        ssl_certfile = None
        ssl_keyfile = None
    elif ssl_certfile is None and ssl_keyfile is None:
        ssl_certfile, ssl_keyfile = resolve_tls_paths(srv.paths.root, cfg.tls)

    plan = build_listen_plan(
        cfg,
        bind_host=bind_host,
        bind_port=bind_port,
        ssl_certfile=ssl_certfile,
        ssl_keyfile=ssl_keyfile,
    )
    level = (log_level or cfg.log_level).lower()
    worker_count = 1 if plan.dual_listeners or reload else workers
    if plan.dual_listeners and (reload or workers > 1):
        logger.warning(
            "TLS dual-port mode forces workers=1 and disables reload",
        )
        reload = False

    app = build_asgi_app(srv, cfg)
    servers: list[uvicorn.Server] = []

    if plan.dual_listeners:
        assert plan.https_port is not None
        assert plan.http_port is not None
        # access_log=False: the app logs one access line per request itself
        # (api/middleware/access_log.py), without the query string.  Uvicorn's
        # own access log would only duplicate it — and it writes the query
        # string, which can carry an access token.
        https_config = uvicorn.Config(
            app,
            host=plan.bind_host,
            port=plan.https_port,
            log_level=level,
            workers=worker_count,
            reload=False,
            ssl_certfile=plan.ssl_certfile,
            ssl_keyfile=plan.ssl_keyfile,
            ws_max_size=BRIDGE_WS_MAX_BYTES,
            access_log=False,
            ws_ping_interval=_WS_PING_INTERVAL,
            ws_ping_timeout=_WS_PING_TIMEOUT,
        )
        companion = build_http_companion_app(https_port=plan.https_port)
        http_config = uvicorn.Config(
            companion,
            host=plan.bind_host,
            port=plan.http_port,
            log_level=level,
            workers=1,
            reload=False,
        )
        servers.append(uvicorn.Server(https_config))
        servers.append(uvicorn.Server(http_config))
        logger.info(
            "Listening on https://%s:%s and http://%s:%s (ACME + redirect)",
            plan.bind_host,
            plan.https_port,
            plan.bind_host,
            plan.http_port,
        )
    else:
        # See the comment above: the app writes its own access log.
        single_config = uvicorn.Config(
            app,
            host=plan.bind_host,
            port=plan.http_port or bind_port,
            log_level=level,
            workers=worker_count,
            reload=reload,
            ssl_certfile=plan.ssl_certfile,
            ssl_keyfile=plan.ssl_keyfile,
            ws_max_size=BRIDGE_WS_MAX_BYTES,
            access_log=False,
            ws_ping_interval=_WS_PING_INTERVAL,
            ws_ping_timeout=_WS_PING_TIMEOUT,
        )
        servers.append(uvicorn.Server(single_config))

    from octop.infra.agents.memory.slim_control import MemorySlimControl

    memory_control = MemorySlimControl(srv)
    with coalesce_accept_errors(asyncio.get_running_loop()):
        try:
            await memory_control.start()
            await asyncio.gather(*(_serve(s) for s in servers))
        finally:
            await memory_control.close()
            await _cancel_background_task(bwrap_task)
            await srv.stop()


def run_foreground_blocking(**kwargs: Any) -> None:
    """Sync entry for Click commands and tests."""
    try:
        asyncio.run(run_foreground(**kwargs))
    except KeyboardInterrupt:
        # uvicorn re-raises the signal it captured once the graceful shutdown
        # is done, and asyncio's runner turns that into a KeyboardInterrupt.
        # A requested stop is not a crash: letting it escape made the process
        # exit 1, so a service manager recorded every clean stop as a failed
        # unit (systemd: "Main process exited, code=exited, status=1/FAILURE").
        logger.info("shutdown signal received — exiting cleanly")
