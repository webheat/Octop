/**
 * Optional runtime components the desktop shell can install on demand.
 *
 * The server answers a request whose feature misses an optional component
 * with `FEATURE_DEPS_MISSING` and names the runtime shard in `details.part`.
 * The shell knows where that shard is published and how to unpack it, so the
 * page asks the shell to install the part and repeats the request.
 *
 * Outside the desktop client there is no bridge: the server-side answer then
 * carries the install hint (`octop[tencentcloud]`) in the error message.
 */

/** Error code the server uses for a missing optional component. */
const MISSING_DEPS_CODE = "FEATURE_DEPS_MISSING";

interface RuntimeBridge {
  version: number;
  request(action: string, payload?: Record<string, unknown>): Promise<unknown>;
}

/** The shell bridge, when the page runs inside the desktop client. */
export function getRuntimeBridge(): RuntimeBridge | null {
  if (typeof window === "undefined") return null;
  const bridge = window.octopDesktopRuntime;
  if (!bridge || typeof bridge.request !== "function") return null;
  return bridge;
}

/**
 * The runtime part a failed response asks for, or null when the failure is
 * something else.
 */
export function missingRuntimePart(rawBody: string): string | null {
  const start = rawBody.indexOf("{");
  if (start < 0) return null;
  try {
    const body = JSON.parse(rawBody.slice(start)) as {
      error?: { code?: string; details?: { part?: unknown } };
    };
    const error = body?.error;
    if (!error || error.code !== MISSING_DEPS_CODE) return null;
    const part = error.details?.part;
    return typeof part === "string" && part.trim() ? part.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Ask the shell to install one optional runtime part.
 *
 * Returns false when the page runs outside the desktop client or the install
 * failed — the caller then surfaces the original error.
 */
export async function installRuntimePart(part: string): Promise<boolean> {
  const bridge = getRuntimeBridge();
  if (!bridge || !part) return false;
  try {
    await bridge.request("install_part", { part });
    return true;
  } catch {
    return false;
  }
}
