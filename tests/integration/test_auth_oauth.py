"""OAuth SSO HTTP route integration tests."""

from __future__ import annotations

from typing import Any
from urllib.parse import parse_qs, urlsplit

import pytest

from octop.infra.auth.sso.service import RedirectResult, SsoService
from tests.support.auth import bearer, bootstrap_admin, login


@pytest.fixture
async def client(app_client):
    yield app_client


async def test_oauth_public_routes_and_oidc_kind_share_redirect(
    client, monkeypatch: pytest.MonkeyPatch
) -> None:
    c, srv, home = client
    await bootstrap_admin(c, home)
    assert srv.user_manager is not None
    user = srv.user_manager.get("admin")
    assert user is not None

    monkeypatch.setattr(
        SsoService,
        "start_login_for_kind",
        lambda self, kind, *, redirect_after, public_base, bind_user_id=None: {
            "authorization_url": (
                "https://accounts.feishu.cn/open-apis/authen/v1/authorize"
                f"?kind={kind}&redirect={redirect_after}&state=browser-state"
            ),
            "state": "browser-state",
        },
    )

    async def callback(self: SsoService, **_: Any) -> RedirectResult:
        return RedirectResult("http://testserver/login/oidc/complete#code=one-time")

    async def exchange(self: SsoService, code: str):
        assert code == "one-time"
        return user

    monkeypatch.setattr(SsoService, "handle_callback", callback)
    monkeypatch.setattr(SsoService, "exchange_login_code", exchange)

    status = await c.get("/api/auth/oauth/status")
    assert status.status_code == 200
    kinds = {item["kind"] for item in status.json()["providers"]}
    assert kinds == {"oidc", "feishu", "dingtalk", "wecom", "wechat_open"}

    start = await c.post("/api/auth/oauth/start", json={"kind": "oidc", "redirect_after": "/chat"})
    assert start.status_code == 200
    assert start.cookies["octop_sso_state"] == "browser-state"
    assert "Path=/api/auth" in start.headers["set-cookie"]

    callback_response = await c.get(
        "/api/auth/oauth/callback", params={"code": "provider-code", "state": "browser-state"}
    )
    assert callback_response.status_code == 302
    assert callback_response.headers["location"].endswith("#code=one-time")

    via_oidc = await c.post("/api/auth/oidc/exchange", json={"code": "one-time"})
    assert via_oidc.status_code == 200
    assert via_oidc.json()["user"]["username"] == "admin"


async def test_sso_exchange_bootstraps_default_agent_once(
    client, monkeypatch: pytest.MonkeyPatch
) -> None:
    from octop.infra.agents.experts import default_agent as default_agent_module

    c, srv, home = client
    await bootstrap_admin(c, home)
    assert srv.user_manager is not None
    user = await srv.user_manager.create(username="ssouser", password="TestPass12", role="user")
    assert srv.app_runtime is not None
    registry = srv.app_runtime.agent_registry
    assert registry.list_agents(user.id) == []

    async def exchange(self: SsoService, code: str):
        return user

    # ``general-assistant`` is not bundled, the bootstrap would pull it from the
    # market. Serve it from the bundled ``default`` template instead so the test
    # never touches the network — the agent id stays ``general-assistant``.
    assert srv.expert_catalog is not None
    template = srv.expert_catalog.get("default")
    assert template is not None

    async def installed(self: Any, expert_id: str) -> bool:
        return expert_id == default_agent_module.DEFAULT_EXPERT_ID

    original_build = default_agent_module.build_create_spec_from_expert

    monkeypatch.setattr(SsoService, "exchange_login_code", exchange)
    monkeypatch.setattr(default_agent_module, "materialize_market_expert", installed)
    monkeypatch.setattr(
        default_agent_module,
        "build_create_spec_from_expert",
        # The bootstrap resolves the template itself; swap it for the bundled
        # one so no market download is needed.
        lambda *, expert_id, expert, **kwargs: original_build(
            expert_id=expert_id, expert=template, **kwargs
        ),
    )

    first = await c.post("/api/auth/oidc/exchange", json={"code": "one-time"})
    assert first.status_code == 200
    assert first.json()["access_token"]
    agents = registry.list_agents(user.id)
    # The agent id is auto-allocated; the template is what the bootstrap picks.
    assert [agent.template_name for agent in agents] == [default_agent_module.DEFAULT_EXPERT_ID]

    second = await c.post("/api/auth/oidc/exchange", json={"code": "one-time"})
    assert second.status_code == 200
    assert len(registry.list_agents(user.id)) == 1


async def test_sso_exchange_login_survives_agent_bootstrap_failure(
    client, monkeypatch: pytest.MonkeyPatch
) -> None:
    from octop.infra.agents.experts import default_agent as default_agent_module

    c, srv, home = client
    await bootstrap_admin(c, home)
    assert srv.user_manager is not None
    user = await srv.user_manager.create(username="ssoluckless", password="TestPass12", role="user")

    async def exchange(self: SsoService, code: str):
        return user

    async def boom(self: Any, **_: Any) -> None:
        raise RuntimeError("default assistant unavailable")

    # ``try_bootstrap_default_agent`` swallows the failure; login must still work.
    monkeypatch.setattr(SsoService, "exchange_login_code", exchange)
    monkeypatch.setattr(default_agent_module, "bootstrap_first_expert", boom)

    response = await c.post("/api/auth/oidc/exchange", json={"code": "one-time"})
    assert response.status_code == 200
    assert response.json()["user"]["username"] == "ssoluckless"


async def test_oauth_bind_requires_auth_and_providers_are_not_public(client) -> None:
    c, _srv, home = client
    await bootstrap_admin(c, home)
    assert (await c.post("/api/auth/oauth/bind/start", json={"kind": "feishu"})).status_code == 401
    assert (await c.get("/api/auth/oauth/providers/feishu")).status_code == 401
    token = await login(c)
    started = await c.post(
        "/api/auth/oauth/bind/start",
        headers=bearer(token),
        json={"kind": "feishu"},
    )
    # Provider is not configured, so start is a 400 — but it is authenticated.
    assert started.status_code == 400

    for kind in ("feishu", "dingtalk", "wecom", "wechat_open"):
        config = await c.get(f"/api/auth/oauth/providers/{kind}", headers=bearer(token))
        assert config.status_code == 200
        assert config.json()["kind"] == kind
        assert config.json()["redirect_uri"].endswith("/api/auth/oauth/callback")
        assert "client_secret" not in config.json()


async def test_oauth_callback_accepts_dingtalk_auth_code(
    client, monkeypatch: pytest.MonkeyPatch
) -> None:
    c, srv, home = client
    await bootstrap_admin(c, home)

    seen: dict[str, str | None] = {}

    async def callback(self: SsoService, **kwargs: Any) -> RedirectResult:
        seen["code"] = kwargs.get("code")
        return RedirectResult("http://testserver/login/oidc/complete#code=one-time")

    monkeypatch.setattr(SsoService, "handle_callback", callback)
    monkeypatch.setattr(
        SsoService,
        "start_login_for_kind",
        lambda self, kind, *, redirect_after, public_base, bind_user_id=None: {
            "authorization_url": "https://login.dingtalk.com/oauth2/auth?state=browser-state",
            "state": "browser-state",
        },
    )

    start = await c.post(
        "/api/auth/oauth/start", json={"kind": "dingtalk", "redirect_after": "/chat"}
    )
    assert start.status_code == 200

    response = await c.get(
        "/api/auth/oauth/callback",
        params={"authCode": "ding-auth", "state": "browser-state"},
    )
    assert response.status_code == 302
    assert seen["code"] == "ding-auth"


@pytest.mark.parametrize("kind", ["dingtalk", "feishu", "wecom"])
async def test_oauth_config_and_authorization_preserve_forwarded_port(client, kind: str) -> None:
    c, _srv, home = client
    await bootstrap_admin(c, home)
    token = await login(c)
    proxy_headers = {
        "X-Forwarded-Proto": "https",
        "X-Forwarded-Host": "octop.example",
        "X-Forwarded-Port": "8011",
    }
    admin_headers = {**bearer(token), **proxy_headers}
    callback_uri = "https://octop.example:8011/api/auth/oauth/callback"

    saved = await c.put(
        f"/api/auth/oauth/providers/{kind}",
        headers=admin_headers,
        json={
            "enabled": True,
            "client_id": "test-app-id",
            "client_secret": "test-app-secret",
            "extra": {"agent_id": "1000001"} if kind == "wecom" else {},
        },
    )
    assert saved.status_code == 200
    assert saved.json()["redirect_uri"] == callback_uri

    config = await c.get(f"/api/auth/oauth/providers/{kind}", headers=admin_headers)
    assert config.status_code == 200
    assert config.json()["redirect_uri"] == callback_uri

    started = await c.post(
        "/api/auth/oauth/start",
        headers=proxy_headers,
        json={"kind": kind, "redirect_after": "/chat"},
    )
    assert started.status_code == 200
    query = parse_qs(urlsplit(started.json()["authorization_url"]).query)
    assert query["redirect_uri"] == [callback_uri]
