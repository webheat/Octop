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


# The description lives in its own table so AI state never changes the asset row.
# A LEFT JOIN keeps the existing list/get contract and gives callers no-row defaults.
_ASSET_SELECT = """
    SELECT a.*,
           COALESCE(d.description, '') AS ai_description,
           COALESCE(d.tags, '[]') AS ai_tags,
           COALESCE(d.status, 'none') AS ai_status,
           COALESCE(d.error, '') AS ai_error,
           COALESCE(d.model, '') AS ai_model,
           COALESCE(d.content_hash, '') AS ai_content_hash,
           COALESCE(d.updated_at, 0) AS ai_updated_at
      FROM product_library_assets a
      LEFT JOIN product_library_asset_descriptions d
        ON d.asset_id = a.asset_id AND d.owner_user_id = a.owner_user_id
"""


def _asset_row(row: Any) -> dict[str, Any] | None:
    result = _row(row, "asset_id")
    if result is None:
        return None
    result["ai_tags"] = json.loads(result.get("ai_tags") or "[]")
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
                _ASSET_SELECT + " WHERE a.owner_user_id = ? AND a.product_id = ? "
                "ORDER BY a.created_at DESC",
                (owner_id, product_id),
            ).fetchall()
        return [_asset_row(row) or {} for row in rows]

    def get_asset(self, owner_id: int, asset_id: str) -> dict[str, Any] | None:
        with self._db.connect() as conn:
            return _asset_row(
                conn.execute(
                    _ASSET_SELECT + " WHERE a.owner_user_id = ? AND a.asset_id = ?",
                    (owner_id, asset_id),
                ).fetchone()
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

    def find_ready_description_by_hash(
        self, owner_id: int, content_hash: str
    ) -> dict[str, Any] | None:
        """Reuse a description when the same image bytes were uploaded again."""
        with self._db.connect() as conn:
            row = conn.execute(
                "SELECT * FROM product_library_asset_descriptions "
                "WHERE owner_user_id = ? AND content_hash = ? AND status = 'ready' LIMIT 1",
                (owner_id, content_hash),
            ).fetchone()
        return dict(row) if row is not None else None

    def save_description(
        self,
        owner_id: int,
        asset_id: str,
        *,
        content_hash: str,
        description: str,
        tags: list[str],
        status: str,
        model: str,
    ) -> None:
        ts = now_ts()
        with self._db.transaction() as conn:
            conn.execute(
                """
                INSERT INTO product_library_asset_descriptions(
                    asset_id, owner_user_id, content_hash, description, tags,
                    status, error, model, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, ?)
                ON CONFLICT(asset_id) DO UPDATE SET
                    content_hash = excluded.content_hash,
                    description = excluded.description,
                    tags = excluded.tags,
                    status = excluded.status,
                    error = '',
                    model = excluded.model,
                    updated_at = excluded.updated_at
                """,
                (
                    asset_id,
                    owner_id,
                    content_hash,
                    description,
                    json.dumps(tags, ensure_ascii=False),
                    status,
                    model,
                    ts,
                    ts,
                ),
            )

    def mark_description_failed(
        self, owner_id: int, asset_id: str, *, error: str, model: str
    ) -> None:
        """Record a failure without discarding a previously good description."""
        ts = now_ts()
        with self._db.transaction() as conn:
            conn.execute(
                """
                INSERT INTO product_library_asset_descriptions(
                    asset_id, owner_user_id, content_hash, description, tags,
                    status, error, model, created_at, updated_at
                ) VALUES (?, ?, '', '', '[]', 'failed', ?, ?, ?, ?)
                ON CONFLICT(asset_id) DO UPDATE SET
                    status = 'failed',
                    error = excluded.error,
                    model = excluded.model,
                    updated_at = excluded.updated_at
                """,
                (asset_id, owner_id, error, model, ts, ts),
            )

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
