import { getApiUrl } from "../config";
import { getAuthToken, request, requestBlob, requestUpload } from "../request";

export interface Product {
  id: string;
  name: string;
  model: string;
  category: string;
  selling_points: string[];
  parameters: Record<string, unknown>;
  expression_limits: string;
}

export interface ProductSnapshotAsset {
  id: string;
  product_id?: string;
  filename: string;
  media_type: string;
  byte_size: number;
  usage: "scene" | "reference" | "style";
  priority: number;
  active?: number;
  content_hash: string;
}

/** LLM-generated image content, persisted in SQLite by the backend. */
export interface AssetDescription {
  ai_description: string;
  ai_tags: string[];
  ai_status: "none" | "pending" | "ready" | "failed";
  ai_error: string;
  ai_model: string;
  ai_content_hash: string;
  ai_updated_at: number;
}

export interface ProductAsset
  extends ProductSnapshotAsset,
    Partial<AssetDescription> {
  product_id: string;
  active: number;
}

/** One image in a directory-import analysis result. */
/**
 * One file queued for import, paired with its relative path.
 *
 * Declared here rather than in the page so the API module never imports from
 * `pages/`; the page builds these and hands them straight to `analyzeImport`.
 */
export interface ImportEntry {
  file: File;
  /** Normalised with `/`, e.g. `hiking-bag/front/01.jpg`. */
  path: string;
  /** Stable de-dupe key so the same file dropped twice is queued once. */
  key: string;
}

export interface ImportItem {
  index: number;
  filename: string;
  /** Client-supplied relative path, e.g. `hiking-bag/front/01.jpg`. */
  relative_path: string;
  /** Top-level folder name, used as a grouping prior. */
  folder: string;
  confidence: number;
  description: string;
  tags: string[];
  /** Whether the group came from the vision model or the folder name. */
  group_source: "vision" | "folder";
  duplicate: boolean;
}

/** A suggested product group produced by directory import. */
export interface ImportGroup {
  key: string;
  suggested_name: string;
  category: string;
  items: ImportItem[];
}

export interface ImportNotice {
  filename: string;
  relative_path?: string;
  reason: string;
}

export interface ImportAnalysis {
  job_id: string;
  total: number;
  groups: ImportGroup[];
  skipped: ImportNotice[];
  failed: ImportNotice[];
}

export interface ImportCommitGroup {
  product_id: string | null;
  name: string;
  category: string;
  item_indices: number[];
}

export interface ImportResult {
  created_products: number;
  reused_products: number;
  imported_assets: number;
  skipped_duplicates: number;
  failed: ImportNotice[];
}

export interface ProductProject {
  id: string;
  product_id: string;
  name: string;
  snapshot: {
    product: Product;
    assets: ProductSnapshotAsset[];
    version: number;
  };
  created_at: number;
}

export interface VideoPlanRequest {
  instructions: string;
  format: "portrait" | "landscape" | "square";
  language: "zh" | "en";
  seconds_per_asset: number;
  include_selling_points: boolean;
}

export type StoryboardSceneType =
  | "title"
  | "bullets"
  | "image"
  | "video"
  | "text"
  | "endcard";

export interface StoryboardScene {
  id: string;
  type: StoryboardSceneType;
  duration: number;
  text?: string;
  subtitle?: string;
  caption?: string;
  bullets?: string[];
  asset?: string;
}

export interface StoryboardScript {
  title: string;
  fps: number;
  width: number;
  height: number;
  scenes: StoryboardScene[];
}

export interface StoryboardDraft {
  project_id: string;
  request: VideoPlanRequest;
  script: StoryboardScript;
  confirmed: boolean;
  narration_enabled?: boolean;
  narration_voice?: string;
  bgm_id?: string;
  bgm_enabled?: boolean;
}

/** Voice presets the current account may pick. */
export interface NarrationVoice {
  id: string;
  label: string;
}

/** Which narration capabilities the current account has. */
export interface NarrationOptions {
  premium: boolean;
  modes: Array<"off" | "local" | "bundled">;
  voices: NarrationVoice[];
}

/** One background track. Metadata only: the audio is never served on its own. */
export interface BgmTrack {
  id: string;
  name: string;
  category: string;
  bpm: number;
  bar: number;
  author: string;
}

/** Background-music catalogue available to every account. */
export interface BgmOptions {
  default: string;
  items: BgmTrack[];
}

export const productLibraryApi = {
  products: () => request<{ items: Product[] }>("/product-library/products"),
  createProduct: (body: Omit<Product, "id">) =>
    request<Product>("/product-library/products", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateProduct: (id: string, body: Omit<Product, "id">) =>
    request<Product>(`/product-library/products/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteProduct: (id: string) =>
    request<void>(`/product-library/products/${id}`, { method: "DELETE" }),
  assets: (productId: string) =>
    request<{ items: ProductAsset[] }>(
      `/product-library/products/${productId}/assets`,
    ),
  upload: (productId: string, files: File[], usage: ProductAsset["usage"]) => {
    const body = new FormData();
    body.set("usage", usage);
    files.forEach((file) => body.append("files", file));
    return requestUpload<{ items: ProductAsset[] }>(
      `/product-library/products/${productId}/assets`,
      body,
    );
  },
  analyzeImport: (entries: ImportEntry[]) => {
    const body = new FormData();
    entries.forEach((entry) => {
      // Keep the original field name so an older backend still accepts it.
      body.append("files", entry.file);
      // Parallel field, aligned by index: multipart parsers basename the
      // Content-Disposition filename, which would flatten the structure.
      body.append("paths", entry.path);
    });
    return requestUpload<ImportAnalysis>(
      "/product-library/imports/analyze",
      body,
    );
  },
  commitImport: (body: {
    job_id: string;
    groups: ImportCommitGroup[];
    exclude_indices: number[];
  }) =>
    request<ImportResult>("/product-library/imports/commit", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateAsset: (
    id: string,
    body: {
      usage?: ProductAsset["usage"];
      priority?: boolean;
      active?: boolean;
    },
  ) =>
    request<ProductAsset>(`/product-library/assets/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  describeAsset: (id: string) =>
    request<ProductAsset>(`/product-library/assets/${id}/describe`, {
      method: "POST",
    }),
  describeMissing: (productId: string) =>
    request<{
      total: number;
      succeeded: number;
      failed: number;
      items: ProductAsset[];
    }>(`/product-library/products/${productId}/describe-missing`, {
      method: "POST",
    }),
  downloadAsset: (id: string) =>
    requestBlob(`/product-library/assets/${id}/download`),
  projects: () =>
    request<{ items: ProductProject[] }>("/product-library/projects"),
  deleteProject: (projectId: string) =>
    request<void>(`/product-library/projects/${projectId}`, {
      method: "DELETE",
    }),
  downloadPackage: (projectId: string) =>
    requestBlob(`/product-library/projects/${projectId}/package`),
  createProject: (body: {
    product_id: string;
    name: string;
    asset_ids: string[];
  }) =>
    request<ProductProject>("/product-library/projects", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  prepareRender: (projectId: string, agentId: string) =>
    request<{
      status: string;
      job_id: string;
      workspace_path: string;
      rendered: boolean;
    }>(`/product-library/projects/${projectId}/prepare-render`, {
      method: "POST",
      body: JSON.stringify({ agent_id: agentId }),
    }),
  generateStoryboard: (projectId: string, body: VideoPlanRequest) =>
    request<{ generator: "llm"; draft: StoryboardDraft }>(
      `/product-library/projects/${projectId}/generate-storyboard`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  getStoryboard: (projectId: string) =>
    request<StoryboardDraft>(
      `/product-library/projects/${projectId}/storyboard`,
    ),
  saveStoryboard: (
    projectId: string,
    body: Pick<StoryboardDraft, "request" | "script" | "confirmed"> &
      Partial<
        Pick<
          StoryboardDraft,
          "narration_enabled" | "narration_voice" | "bgm_id" | "bgm_enabled"
        >
      >,
  ) =>
    request<StoryboardDraft>(
      `/product-library/projects/${projectId}/storyboard`,
      { method: "PUT", body: JSON.stringify(body) },
    ),
  narrationOptions: () =>
    request<NarrationOptions>("/product-library/narration-options"),
  bgmOptions: () => request<BgmOptions>("/product-library/bgm-options"),
  /**
   * URL for auditioning one track in a plain ``<audio>`` element.
   *
   * The JWT rides in ``access_token`` because an audio element cannot set an
   * Authorization header. Nothing is ever offered for download: the response
   * carries no Content-Disposition, so the browser can only play it in place.
   */
  bgmStreamUrl: (trackId: string) => {
    const token = getAuthToken();
    const qs = token ? `?access_token=${encodeURIComponent(token)}` : "";
    return getApiUrl(
      `/product-library/bgm/${encodeURIComponent(trackId)}/stream${qs}`,
    );
  },
  downloadStoryboardPackage: (projectId: string) =>
    requestBlob(`/product-library/projects/${projectId}/storyboard-package`),
};
