import type { ProductSnapshotAsset } from "../../api/modules/productLibrary";

export function mediaType(asset: ProductSnapshotAsset) {
  return asset.media_type.startsWith("image/")
    ? "image"
    : asset.media_type.startsWith("video/")
    ? "video"
    : null;
}

export function exportName(asset: ProductSnapshotAsset, index: number) {
  const safe = asset.filename
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[._]+|[._]+$/g, "");
  return `${asset.id}-${safe || `asset-${index}`}`;
}
