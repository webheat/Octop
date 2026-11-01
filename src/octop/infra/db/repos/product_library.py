"""Per-user product library metadata. File contents stay on disk."""

from __future__ import annotations

import json
from typing import Any

from octop.infra.db.pool import DatabasePool
from octop.infra.db.repos._base import now_ts
from octop.infra.utils.ulid import new_ulid


def _row(row: Any, public_id: str) -> dict[str, Any] | None:
    if row is None:
        return None
    result = dict(row)
    result["pk"] = result.pop("id")
    result["id"] = result.pop(public_id)
    return result


class ProductLibraryRepo:
    def __init__(self, db: DatabasePool) -> None:
        self._db = db

    def list_products(self, owner_id: int) -> list[dict[str, Any]]:
        with self._db.connect() as conn:
            rows = conn.execute(
                "SELECT * FROM product_library_products WHERE owner_user_id = ? ORDER BY updated_at DESC",
                (owner_id,),
            ).fetchall()
        return [_row(row, "product_id") or {} for row in rows]

    def get_product(self, owner_id: int, product_id: str) -> dict[str, Any] | None:
        with self._db.connect() as conn:
            return _row(
                conn.execute(
                    "SELECT * FROM product_library_products WHERE owner_user_id = ? AND product_id = ?",
                    (owner_id, product_id),
                ).fetchone(),
                "product_id",
            )

    def create_product(self, owner_id: int, fields: dict[str, Any]) -> dict[str, Any]:
        product_id, ts = new_ulid(), now_ts()
        with self._db.transaction() as conn:
            conn.execute(
                "INSERT INTO product_library_products(product_id, owner_user_id, name, model, category, selling_points, parameters, expression_limits, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    product_id,
                    owner_id,
                    fields["name"],
                    fields.get("model", ""),
                    fields.get("category", ""),
                    json.dumps(fields.get("selling_points", []), ensure_ascii=False),
                    json.dumps(fields.get("parameters", {}), ensure_ascii=False),
                    fields.get("expression_limits", ""),
                    ts,
                    ts,
                ),
            )
        return self.get_product(owner_id, product_id) or {}

    def update_product(self, owner_id: int, product_id: str, fields: dict[str, Any]) -> bool:
        columns = {"name", "model", "category", "selling_points", "parameters", "expression_limits"}
        values = {
            key: json.dumps(value, ensure_ascii=False)
            if key in {"selling_points", "parameters"}
            else value
            for key, value in fields.items()
            if key in columns
        }
        if not values:
            return self.get_product(owner_id, product_id) is not None
        values["updated_at"] = now_ts()
        assignments = ", ".join(f"{key} = ?" for key in values)
        with self._db.transaction() as conn:
            cur = conn.execute(
                f"UPDATE product_library_products SET {assignments} WHERE owner_user_id = ? AND product_id = ?",
                (*values.values(), owner_id, product_id),
            )
        return bool(cur.rowcount > 0)

    def delete_product(self, owner_id: int, product_id: str) -> bool:
        with self._db.transaction() as conn:
            # Projects retain their own metadata snapshots and immutable file paths.
            cur = conn.execute(
                "DELETE FROM product_library_products WHERE owner_user_id = ? AND product_id = ?",
                (owner_id, product_id),
            )
        return bool(cur.rowcount > 0)

    def add_asset(
        self,
        owner_id: int,
        product_id: str,
        *,
        filename: str,
        media_type: str,
        byte_size: int,
        content_hash: str,
        storage_path: str,
        usage: str,
    ) -> dict[str, Any]:
        asset_id, ts = new_ulid(), now_ts()
        with self._db.transaction() as conn:
            conn.execute(
                "INSERT INTO product_library_assets(asset_id, owner_user_id, product_id, filename, media_type, byte_size, content_hash, storage_path, usage, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    asset_id,
                    owner_id,
                    product_id,
                    filename,
                    media_type,
                    byte_size,
                    content_hash,
                    storage_path,
                    usage,
                    ts,
                ),
            )
        return self.get_asset(owner_id, asset_id) or {}

    def list_assets(self, owner_id: int, product_id: str) -> list[dict[str, Any]]:
        with self._db.connect() as conn:
            rows = conn.execute(
                "SELECT * FROM product_library_assets WHERE owner_user_id = ? AND product_id = ? ORDER BY created_at DESC",
                (owner_id, product_id),
            ).fetchall()
        return [_row(row, "asset_id") or {} for row in rows]

    def get_asset(self, owner_id: int, asset_id: str) -> dict[str, Any] | None:
        with self._db.connect() as conn:
            return _row(
                conn.execute(
                    "SELECT * FROM product_library_assets WHERE owner_user_id = ? AND asset_id = ?",
                    (owner_id, asset_id),
                ).fetchone(),
                "asset_id",
            )

    def find_asset_by_hash(
        self, owner_id: int, product_id: str, content_hash: str
    ) -> dict[str, Any] | None:
        with self._db.connect() as conn:
            return _row(
                conn.execute(
                    "SELECT * FROM product_library_assets WHERE owner_user_id = ? "
                    "AND product_id = ? AND content_hash = ? LIMIT 1",
                    (owner_id, product_id, content_hash),
                ).fetchone(),
                "asset_id",
            )

    def update_asset(
        self,
        owner_id: int,
        asset_id: str,
        *,
        usage: str | None = None,
        priority: bool | None = None,
        active: bool | None = None,
    ) -> bool:
        sets, params = [], []
        for key, value in (("usage", usage), ("priority", priority), ("active", active)):
            if value is not None:
                sets.append(f"{key} = ?")
                params.append(int(value) if isinstance(value, bool) else value)
        if not sets:
            return self.get_asset(owner_id, asset_id) is not None
        with self._db.transaction() as conn:
            cur = conn.execute(
                f"UPDATE product_library_assets SET {', '.join(sets)} WHERE owner_user_id = ? AND asset_id = ?",
                (*params, owner_id, asset_id),
            )
        return bool(cur.rowcount > 0)

    def create_project(
        self, owner_id: int, product_id: str, name: str, snapshot: dict[str, Any]
    ) -> dict[str, Any]:
        project_id, ts = new_ulid(), now_ts()
        serialized = json.dumps(snapshot, ensure_ascii=False)
        with self._db.transaction() as conn:
            conn.execute(
                "INSERT INTO product_library_projects(project_id, owner_user_id, product_id, name, snapshot_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                (project_id, owner_id, product_id, name, serialized, ts),
            )
        return {
            "id": project_id,
            "pk": 0,
            "owner_user_id": owner_id,
            "product_id": product_id,
            "name": name,
            "snapshot_json": serialized,
            "created_at": ts,
        }

    def list_projects(self, owner_id: int) -> list[dict[str, Any]]:
        with self._db.connect() as conn:
            rows = conn.execute(
                "SELECT * FROM product_library_projects WHERE owner_user_id = ? ORDER BY created_at DESC",
                (owner_id,),
            ).fetchall()
        return [_row(row, "project_id") or {} for row in rows]

    def get_project(self, owner_id: int, project_id: str) -> dict[str, Any] | None:
        with self._db.connect() as conn:
            return _row(
                conn.execute(
                    "SELECT * FROM product_library_projects WHERE owner_user_id = ? AND project_id = ?",
                    (owner_id, project_id),
                ).fetchone(),
                "project_id",
            )

    def delete_project(self, owner_id: int, project_id: str) -> bool:
        with self._db.transaction() as conn:
            # Snapshot assets are references to the product's files, so removing a
            # project must not touch storage shared with the product.
            cur = conn.execute(
                "DELETE FROM product_library_projects WHERE owner_user_id = ? AND project_id = ?",
                (owner_id, project_id),
            )
        return bool(cur.rowcount > 0)
