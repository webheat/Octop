-- Schema v29: curated high-quality base image library with local quality
-- metadata and an isolated quarantine for corrupt / low-quality / duplicate
-- uploads. File bytes stay on disk; only the index and measurements live here.
CREATE TABLE IF NOT EXISTS product_library_base_images (
    id BIGSERIAL PRIMARY KEY,
    image_id TEXT NOT NULL UNIQUE,
    owner_user_id INTEGER NOT NULL,
    filename TEXT NOT NULL,
    media_type TEXT NOT NULL,
    byte_size INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    phash TEXT NOT NULL DEFAULT '',
    dhash TEXT NOT NULL DEFAULT '',
    width INTEGER NOT NULL DEFAULT 0,
    height INTEGER NOT NULL DEFAULT 0,
    blur_score REAL NOT NULL DEFAULT 0,
    brightness REAL NOT NULL DEFAULT 0,
    flatness REAL NOT NULL DEFAULT 0,
    quality_score REAL NOT NULL DEFAULT 0,
    dominant_colors TEXT NOT NULL DEFAULT '[]',
    storage_path TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ready',
    reason TEXT NOT NULL DEFAULT '',
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_product_library_base_images_owner_status
    ON product_library_base_images(owner_user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_product_library_base_images_hash
    ON product_library_base_images(owner_user_id, content_hash);
CREATE INDEX IF NOT EXISTS idx_product_library_base_images_phash
    ON product_library_base_images(owner_user_id, phash);

UPDATE _schema_version SET version = 29;
