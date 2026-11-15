-- Schema v27: LLM-generated content descriptions for product-library images.
-- File bytes stay on disk; only the model's text output is persisted here.
CREATE TABLE IF NOT EXISTS product_library_asset_descriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_id TEXT NOT NULL UNIQUE REFERENCES product_library_assets(asset_id) ON DELETE CASCADE,
    owner_user_id INTEGER NOT NULL,
    content_hash TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'pending',
    error TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_product_library_asset_descriptions_owner
    ON product_library_asset_descriptions(owner_user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_product_library_asset_descriptions_hash
    ON product_library_asset_descriptions(owner_user_id, content_hash);
CREATE INDEX IF NOT EXISTS idx_product_library_asset_descriptions_status
    ON product_library_asset_descriptions(status);

UPDATE _schema_version SET version = 27;
