"""Give a brand-new account one ready-to-render demo product.

A freshly created account used to land on a completely empty product library,
so the first thing a new user saw was a dead end: no product, no photo, no
project, and nothing to generate. Every account now starts with one demo
product, three staged photos and one project snapshot taken from a small
rotation of kits, so "make my first video" works without a single upload.

The kits are fictional on purpose: no real brand, no trademark, no text burned
into the photos. They are ordinary bag-and-luggage products because that is the
category the storyboard prompts and the renderer are tuned for.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from octop.infra.db.services import SharedServices
from octop.infra.product_library.service import ProductLibraryService
from octop.infra.utils.paths import PathLayout

logger = logging.getLogger(__name__)

_IMAGE_DIR = Path(__file__).with_name("starter_assets")
_STAGES = ("front", "side", "detail")


@dataclass(frozen=True)
class StarterKit:
    """One fictional product plus the staged photos shipped with it."""

    slug: str
    name: str
    model: str
    category: str
    selling_points: tuple[str, ...]
    parameters: dict[str, str] = field(default_factory=dict)
    expression_limits: str = ""

    def product_fields(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "model": self.model,
            "category": self.category,
            "selling_points": list(self.selling_points),
            "parameters": dict(self.parameters),
            "expression_limits": self.expression_limits,
        }


# Ordered rotation: account N gets kits[N % len(kits)] so neighbouring signups do
# not see byte-identical libraries.
STARTER_KITS: tuple[StarterKit, ...] = (
    StarterKit(
        slug="biz-trolley",
        name="铝合金静音轮商务登机箱",
        model="DEMO-2001",
        category="登机箱",
        selling_points=("航空级铝框更稳固", "静音轮推行不扰人", "万向转向灵活省力"),
        parameters={"尺寸": "20英寸", "材质": "航空级铝合金", "净重": "4.2千克", "颜色": "深空灰"},
        expression_limits="展示时应突出铝框质感与静音轮设计，避免使用绝对化性能承诺。",
    ),
    StarterKit(
        slug="kids-trolley",
        name="卡通护眼儿童拉杆箱",
        model="DEMO-2002",
        category="儿童箱",
        selling_points=("圆角箱体更显可爱", "静音轮不怕吵", "加宽拉杆好推走"),
        parameters={"尺寸": "16英寸", "材质": "ABS复合板材", "净重": "2.3千克", "颜色": "奶油黄"},
        expression_limits="仅展示卡通造型与基础功能，不使用儿童安全绝对化或恐吓式表述。",
    ),
    StarterKit(
        slug="picnic-bag",
        name="加厚保温野餐包",
        model="DEMO-2003",
        category="野餐包",
        selling_points=("双层内胆保温更久", "宽口设计方便取食", "肩带斜挎更省手"),
        parameters={
            "容量": "12升",
            "材质": "涤纶复合保温层",
            "净重": "0.9千克",
            "颜色": "鼠尾草绿",
        },
        expression_limits="保温时长应按实际测试结果表述，不使用无法验证的持续保温承诺。",
    ),
    StarterKit(
        slug="hiking-pack",
        name="轻量防撕裂登山双肩包",
        model="DEMO-2004",
        category="登山包",
        selling_points=("防撕裂面料耐造", "背负系统更稳当", "侧袋收纳随手取"),
        parameters={"容量": "30升", "材质": "高强尼龙", "净重": "1.2千克", "颜色": "岩灰色"},
        expression_limits="仅描述可见背负结构和面料性能，不夸大防水等级或极端环境适用性。",
    ),
)


def kit_for(owner_id: int) -> StarterKit:
    """Pick the kit that belongs to this account number."""
    return STARTER_KITS[owner_id % len(STARTER_KITS)]


def _stage_files(kit: StarterKit) -> list[tuple[str, Path]]:
    staged = []
    for stage in _STAGES:
        source = _IMAGE_DIR / kit.slug / f"{stage}.jpg"
        if source.is_file():
            staged.append((stage, source))
        else:  # pragma: no cover - packaging accident, keep the product usable
            logger.warning("starter kit asset missing: %s", source)
    return staged


def _marker(paths: PathLayout, owner_id: int) -> Path:
    """One-shot flag: the demo was already offered to this account."""
    return paths.product_library_dir / ".starter" / str(owner_id)


def seed_starter_library(services: SharedServices, owner_id: int) -> str | None:
    """Create the demo product, its photos and one project for ``owner_id``.

    Returns the new product id, or ``None`` when this account was already
    served. The marker file is what makes deleting the demo stick: without it a
    user who cleared the library would silently get it back on the next signup
    path that happens to run.
    """
    repo = services.product_library_repo
    marker = _marker(services.paths, owner_id)
    if marker.exists() or repo.list_products(owner_id):
        return None
    kit = kit_for(owner_id)
    service = ProductLibraryService(services.paths, repo)
    product = service.create_product(owner_id, kit.product_fields())
    asset_ids: list[str] = []
    for stage, source in _stage_files(kit):
        asset = service.store_asset(
            owner_id=owner_id,
            product_id=product["id"],
            filename=f"{kit.slug}-{stage}.jpg",
            media_type="image/jpeg",
            data=source.read_bytes(),
            usage="scene",
        )
        if not asset_ids:
            # The first photo becomes the cover the renderer opens on.
            service.update_asset(owner_id, asset["id"], priority=True)
        asset_ids.append(asset["id"])
    if asset_ids:
        service.create_snapshot(
            owner_id=owner_id,
            product_id=product["id"],
            name=f"{kit.name}·短视频",
            asset_ids=asset_ids,
        )
    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.write_text(kit.slug, encoding="utf-8")
    logger.info(
        "seeded starter product %s (%s) for user %s with %d photos",
        product["id"],
        kit.slug,
        owner_id,
        len(asset_ids),
    )
    return str(product["id"])


def seed_quietly(services: SharedServices, owner_id: int) -> None:
    """Seed without ever failing the signup that triggered it."""
    try:
        seed_starter_library(services, owner_id)
    except Exception:  # noqa: BLE001 - a demo product must not block a login
        logger.exception("failed to seed starter product for user %s", owner_id)


async def seed_quietly_async(services: SharedServices, owner_id: int) -> None:
    """Off-loop variant for the async account-creation paths."""
    import asyncio

    await asyncio.to_thread(seed_quietly, services, owner_id)
