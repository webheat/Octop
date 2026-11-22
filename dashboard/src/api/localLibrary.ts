/**
 * Client-side access to the shell's local-first product library (PRD §3.7).
 *
 * In the desktop shell the material bytes and their classification live on the
 * client machine via `window.octopDesktopLibrary`; the remote server is used
 * only for AI recognition. In a browser the bridge is absent, so callers fall
 * back to the hosted product-library API and behaviour is unchanged.
 */

import { getAuthToken, request } from "./request";

export interface LocalAsset {
  id: string;
  filename: string;
  mediaType: string;
  bytes: number;
  sha256: string;
  group?: string;
  category?: string;
  description?: string;
  tags?: string[];
  usage?: string;
  localPath?: string;
  createdAt?: number;
}

export interface PickedPath {
  path: string;
  name: string;
  bytes: number;
  mediaType: string;
}

export function isLocalLibraryAvailable(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.octopDesktopLibrary?.request === "function"
  );
}

async function call<T>(
  action: string,
  payload: Record<string, unknown> = {},
): Promise<T> {
  const bridge = window.octopDesktopLibrary;
  if (!bridge) throw new Error("LOCAL_LIBRARY_UNAVAILABLE");
  const token = getAuthToken();
  if (!token) throw new Error("AUTH_REQUIRED");
  return (await bridge.request(action, token, payload)) as T;
}

export const localLibrary = {
  /** Open a native multi-file picker; returns absolute local paths. */
  async pickFiles(): Promise<PickedPath[]> {
    const res = await call<{ items: PickedPath[] }>("pickFiles");
    return res.items ?? [];
  },

  /** Open a native directory picker; returns image paths found under it. */
  async pickDirectory(): Promise<PickedPath[]> {
    const res = await call<{ items: PickedPath[] }>("pickDirectory");
    return res.items ?? [];
  },

  /**
   * Read the chosen local files into the library. When `recognize` is true the
   * shell spends one vision call per distinct image via the server's stateless
   * recognize endpoint and stores the classification locally too.
   */
  async ingest(options: {
    paths: string[];
    recognize?: boolean;
    mode?: "categorize" | "describe";
  }): Promise<LocalAsset[]> {
    const res = await call<{ items: LocalAsset[] }>("ingest", {
      body: {
        paths: options.paths,
        recognize: options.recognize ?? true,
        mode: options.mode ?? "categorize",
      },
    });
    return res.items ?? [];
  },

  async list(): Promise<LocalAsset[]> {
    return call<LocalAsset[]>("list");
  },

  async updateMeta(
    id: string,
    meta: Record<string, unknown>,
  ): Promise<LocalAsset> {
    return call<LocalAsset>("updateMeta", { body: { id, meta } });
  },

  async remove(id: string): Promise<boolean> {
    const res = await call<{ ok: boolean }>("remove", { id });
    return Boolean(res?.ok);
  },

  async jobStatus(id: string): Promise<{
    id: string;
    state: string;
    progress?: number | null;
    errorCode?: string;
  }> {
    return call("jobStatus", { id });
  },

  /** Read one asset's bytes as a base64 data URL for local preview. */
  async previewUrl(id: string): Promise<string | null> {
    try {
      const res = await call<{ mediaType: string; data: string }>("read", {
        id,
      });
      return `data:${res.mediaType};base64,${res.data}`;
    } catch {
      return null;
    }
  },

  /**
   * Render entirely from local material. `script` is the confirmed Remotion
   * script; `assetMap` maps each scene asset basename to a local asset id.
   */
  async renderLocal(options: {
    projectId: string;
    title: string;
    script: unknown;
    assetMap: Record<string, string>;
    audioJson?: unknown;
  }): Promise<{ jobId: string; state: string }> {
    return call<{ jobId: string; state: string }>("renderLocal", {
      body: {
        projectId: options.projectId,
        title: options.title,
        script: options.script,
        assetMap: options.assetMap,
        audioJson: options.audioJson,
      },
    });
  },
};

export interface LocalPlanResult {
  script: {
    title: string;
    fps?: number;
    width: number;
    height: number;
    scenes: Array<{
      id: string;
      type: string;
      asset?: string;
      duration?: number;
      [key: string]: unknown;
    }>;
  };
  assets: Array<{ id: string; export_name: string; media_type: string }>;
  generator: string;
}

/** Stateless template plan for local material — no server-side material needed. */
export function planLocal(input: {
  product: {
    name: string;
    model?: string;
    category?: string;
    selling_points?: string[];
  };
  assets: Array<{
    id: string;
    filename: string;
    media_type: string;
    usage?: string;
    priority?: number;
  }>;
  request?: {
    instructions?: string;
    format?: "landscape" | "portrait" | "square";
    language?: "zh" | "en";
    seconds_per_asset?: number;
    include_selling_points?: boolean;
  };
}): Promise<LocalPlanResult> {
  return request<LocalPlanResult>("/product-library/plan-local", {
    method: "POST",
    body: JSON.stringify({
      product: input.product,
      assets: input.assets,
      request: {
        format: "portrait",
        language: "zh",
        seconds_per_asset: 4,
        include_selling_points: true,
        ...(input.request ?? {}),
      },
    }),
  });
}
