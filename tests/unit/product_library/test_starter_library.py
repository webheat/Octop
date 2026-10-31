"""A brand-new account must land on a library it can render immediately."""

from __future__ import annotations

import hashlib
from pathlib import Path
from types import SimpleNamespace

import pytest

from octop.config import OctopConfig
from octop.infra.db.migrate import run_migrations
from octop.infra.db.pool import SqlitePool
from octop.infra.db.repos.product_library import ProductLibraryRepo
from octop.infra.db.services import build_shared_services
from octop.infra.product_library import starter
from octop.infra.users.identity import Role
from octop.infra.users.manager import UserManager
from octop.infra.utils.paths import PathLayout


@pytest.fixture
def services(tmp_path: Path) -> SimpleNamespace:
    db = SqlitePool(tmp_path / "octop.db")
    run_migrations(db)
    return SimpleNamespace(
        paths=PathLayout(tmp_path / "octop"),
        product_library_repo=ProductLibraryRepo(db),
    )


def test_a_new_account_can_render_without_uploading_anything(services: SimpleNamespace) -> None:
    product_id = starter.seed_starter_library(services, 1)
    assert product_id is not None

    repo: ProductLibraryRepo = services.product_library_repo
    products = repo.list_products(1)
    assert [row["id"] for row in products] == [product_id]
    product = products[0]
    assert product["name"] and product["model"] and product["selling_points"]
    assert product["expression_limits"]

    assets = repo.list_assets(1, product_id)
    assert len(assets) == 3
    assert all(asset["usage"] == "scene" for asset in assets)
    # Exactly one cover so the renderer has a deterministic opening shot.
    assert sum(asset["priority"] for asset in assets) == 1

    for asset in assets:
        stored = services.paths.product_library_dir / asset["storage_path"]
        assert stored.is_file()
        assert hashlib.sha256(stored.read_bytes()).hexdigest() == asset["content_hash"]

    projects = repo.list_projects(1)
    assert len(projects) == 1
    assert projects[0]["product_id"] == product_id


def test_the_seed_is_offered_once_and_survives_a_manual_cleanup(
    services: SimpleNamespace,
) -> None:
    assert starter.seed_starter_library(services, 1) is not None
    assert starter.seed_starter_library(services, 1) is None
    repo: ProductLibraryRepo = services.product_library_repo
    assert len(repo.list_products(1)) == 1

    # Deleting the demo must be permanent: the marker blocks a second offer.
    for product in repo.list_products(1):
        repo.delete_product(1, product["id"])
    assert starter.seed_starter_library(services, 1) is None
    assert repo.list_products(1) == []


def test_neighbouring_accounts_get_different_products(services: SimpleNamespace) -> None:
    names = set()
    for owner_id in range(1, len(starter.STARTER_KITS) + 1):
        assert starter.seed_starter_library(services, owner_id) is not None
        products = services.product_library_repo.list_products(owner_id)
        names.add(products[0]["name"])
    assert len(names) == len(starter.STARTER_KITS)


def test_every_shipped_kit_has_its_three_photos() -> None:
    for kit in starter.STARTER_KITS:
        for stage in ("front", "side", "detail"):
            assert (starter._IMAGE_DIR / kit.slug / f"{stage}.jpg").is_file()


def test_a_broken_kit_never_breaks_the_signup(services: SimpleNamespace) -> None:
    """Seeding is best-effort: a failure must not escape into the login path."""

    def _explode(*_args: object, **_kwargs: object) -> str:
        raise RuntimeError("disk full")

    original = starter.ProductLibraryService
    starter.ProductLibraryService = _explode  # type: ignore[assignment,misc]
    try:
        starter.seed_quietly(services, 1)
    finally:
        starter.ProductLibraryService = original  # type: ignore[misc]
    assert services.product_library_repo.list_products(1) == []


@pytest.fixture
async def manager(tmp_path: Path) -> UserManager:
    paths = PathLayout(tmp_path / ".octop")
    paths.ensure_root()
    db = SqlitePool(paths.db)
    run_migrations(db)
    return UserManager(build_shared_services(db=db, paths=paths, config=OctopConfig()))


def _assert_library_is_ready(manager: UserManager, user_id: int) -> None:
    repo = manager._services.product_library_repo
    products = repo.list_products(user_id)
    assert len(products) == 1
    assert len(repo.list_assets(user_id, products[0]["id"])) == 3
    assert len(repo.list_projects(user_id)) == 1


async def test_creating_an_account_seeds_its_library(manager: UserManager) -> None:
    user = await manager.create(username="newbie", password="TestPass12", role=Role.USER)
    _assert_library_is_ready(manager, user.id)


async def test_scanning_a_qr_code_seeds_the_new_account(manager: UserManager) -> None:
    with manager._services.db.transaction() as conn:
        provider_id = int(
            conn.execute(
                "INSERT INTO sso_providers(enabled, kind, created_at, updated_at)"
                " VALUES (1, 'oidc', 0, 0)"
            ).lastrowid
        )
    user = await manager.resolve_or_create_sso_user(
        provider_id=provider_id, subject="fresh-subject", claims={"name": "扫码用户"}
    )
    _assert_library_is_ready(manager, user.id)
    # A second login must not seed a second demo product.
    again = await manager.resolve_or_create_sso_user(
        provider_id=provider_id, subject="fresh-subject", claims={"name": "扫码用户"}
    )
    assert again.id == user.id
    assert len(manager._services.product_library_repo.list_products(user.id)) == 1
