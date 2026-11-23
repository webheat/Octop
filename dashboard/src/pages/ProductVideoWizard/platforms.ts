import type { VideoPlanRequest } from "../../api/modules/productLibrary";

/** Platforms offered as checkboxes, in display order. */
export const PLATFORM_KEYS = [
  "douyin",
  "xiaohongshu",
  "channels",
  "kuaishou",
  "bilibili",
  "tiktok",
  "instagram",
  "youtube",
] as const;

export type PlatformKey = (typeof PLATFORM_KEYS)[number];

/** Aspect ratio a platform expects for short-form video. */
export type VideoFormat = VideoPlanRequest["format"];

/**
 * Vertical-first apps take 9:16; long-form video sites take 16:9. Kept in one
 * place so the ratio picker can follow the platform selection instead of
 * silently producing a single ratio for a mixed list.
 */
export const PLATFORM_FORMATS: Record<PlatformKey, VideoFormat> = {
  douyin: "portrait",
  xiaohongshu: "portrait",
  channels: "portrait",
  kuaishou: "portrait",
  bilibili: "landscape",
  tiktok: "portrait",
  instagram: "portrait",
  youtube: "landscape",
};

/**
 * Render profile each platform defaults to. The plan stage works in aspect
 * ratios; the output stage works in concrete canvas profiles, so the mapping
 * is explicit instead of guessing "vertical for everything" — a YouTube
 * deliverable that silently renders 1080x1920 is not a YouTube deliverable.
 */
export type RenderProfile = "short_vertical" | "landscape" | "square" | "custom";

export const PLATFORM_RENDER_PROFILES: Record<PlatformKey, RenderProfile> = {
  douyin: "short_vertical",
  xiaohongshu: "short_vertical",
  channels: "short_vertical",
  kuaishou: "short_vertical",
  bilibili: "landscape",
  tiktok: "short_vertical",
  instagram: "short_vertical",
  youtube: "landscape",
};

/** Canvas size for each render profile. */
export const RENDER_PROFILE_SIZES: Record<
  Exclude<RenderProfile, "custom">,
  { width: number; height: number }
> = {
  short_vertical: { width: 1080, height: 1920 },
  landscape: { width: 1920, height: 1080 },
  square: { width: 1080, height: 1080 },
};

/**
 * Resolves the platform key behind a stored platform name. The plan stage
 * stores whatever the picker put in the brief — a translated label ("抖音"),
 * a raw i18n key ("videoWizard.platforms.douyin") or the bare key ("douyin")
 * from an older draft. All three have to resolve, otherwise a platform
 * silently loses its output variant.
 *
 * `labels` holds the translated names; `known` holds the raw platform keys.
 * A stored name is matched against both, plus the i18n key form.
 */
export function platformKeyForLabel(
  label: string,
  labels: Record<PlatformKey, string>,
): PlatformKey | null {
  const trimmed = label.trim();
  const keys = Object.keys(labels) as PlatformKey[];
  const byLabel = keys.find((key) => labels[key] === trimmed);
  if (byLabel) return byLabel;
  // "videoWizard.platforms.douyin" or "douyin".
  const tail = trimmed.split(".").pop() ?? trimmed;
  const byKey = keys.find((key) => key === tail);
  if (byKey) return byKey;
  // The stored name may be a translated label from another locale than the
  // one currently rendered, so fall back to matching by the known labels of
  // the other bundle.
  const crossLocale = Object.keys(PLATFORM_LABELS_ZH) as PlatformKey[];
  const byCrossLabel = crossLocale.find((key) => PLATFORM_LABELS_ZH[key] === trimmed);
  if (byCrossLabel) return byCrossLabel;
  return null;
}

/**
 * Chinese platform names. The brief keeps the platform list as free text, so
 * a draft saved under one locale has to stay resolvable under the other.
 */
export const PLATFORM_LABELS_ZH: Record<PlatformKey, string> = {
  douyin: "抖音",
  xiaohongshu: "小红书",
  channels: "视频号",
  kuaishou: "快手",
  bilibili: "B站",
  tiktok: "TikTok",
  instagram: "Instagram",
  youtube: "YouTube",
};
