/**
 * Detecting that this page runs inside the Octop desktop shell.
 *
 * The shell loads the Dashboard from the server inside a plain WebView2. A
 * Service Worker registered there caches the remote chunks in the WebView2
 * profile and keeps serving a stale Dashboard long after the server deployed
 * a new build — the client sees an old UI while the server is fine. The
 * desktop client must therefore never register a worker.
 *
 * Two independent signals are used, because they are available at different
 * moments:
 *
 *  1. `?desktop=1` in the URL — set by the shell on the very first navigation.
 *     This is the only signal that is already there when the page's *first*
 *     script runs, which is the moment the Service Worker would be
 *     registered. It is therefore the signal that actually prevents the
 *     problem.
 *
 *  2. The injected bridges (`window.octopDesktop`, `window.octopDesktopShell`,
 *     `window.octopDesktopVideo`) — the shell injects them *after* the page
 *     starts loading (every 250ms for ~10s), so a first render can
 *     legitimately see none of them. They identify older shells as well
 *     (`window.octopDesktopVideo` exists in every shell since v1.4.0), which
 *     lets an old client recognise itself and repair its own profile.
 */

/** Query flag the shell appends to the Dashboard URL. */
const DESKTOP_QUERY_FLAG = "desktop";

/** LocalStorage key marking this profile as a desktop profile. */
const DESKTOP_PROFILE_KEY = "octop.desktopShell";

const POLL_INTERVAL_MS = 200;

/**
 * True when the URL carries the shell's `?desktop=1` flag.
 *
 * Synchronous and available before any script runs, so the Service Worker
 * registration in `main.tsx` can consult it.
 */
export function hasDesktopUrlFlag(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return (
      new URLSearchParams(window.location.search).get(DESKTOP_QUERY_FLAG) ===
      "1"
    );
  } catch {
    return false;
  }
}

/** True when this WebView2 profile was already marked as a desktop profile. */
export function isKnownDesktopProfile(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(DESKTOP_PROFILE_KEY) === "1";
  } catch {
    // Private mode / disabled storage — fall back to the other signals.
    return false;
  }
}

/**
 * Remember that this profile belongs to the desktop client.
 *
 * Persisted so a later navigation that lost the query flag (the shell only
 * appends it to the landing URL) still knows it must not register a worker.
 */
export function markDesktopProfile(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(DESKTOP_PROFILE_KEY, "1");
  } catch {
    // Storage unavailable — the URL flag and the bridges still apply.
  }
}

/** True as soon as any shell bridge is visible. */
export function isDesktopShellPage(): boolean {
  if (typeof window === "undefined") return false;
  if (window.octopDesktop) return true;
  if (window.octopDesktopShell) return true;
  return window.octopDesktopVideo?.version === 1;
}

/**
 * True when the page runs inside the Octop desktop shell.
 *
 * The three signals become available at different moments, so all of them are
 * combined: the URL flag is there on the very first navigation, the persisted
 * profile marker survives later navigations that lost the flag, and the
 * injected bridges identify older shells as well.
 */
export function isDesktopShellContext(): boolean {
  return hasDesktopUrlFlag() || isKnownDesktopProfile() || isDesktopShellPage();
}

/**
 * True when the page must not register a Service Worker.
 *
 * This is the single decision the entry point needs, and it deliberately
 * combines the URL flag (available immediately) with the persisted profile
 * marker (available on later navigations) and the injected bridges (available
 * once the shell has spoken).
 */
export function shouldSkipServiceWorker(): boolean {
  return isDesktopShellContext();
}

/**
 * How long the shell detection waits for a bridge before giving up.
 *
 * Exposed so callers that must decide something even when no bridge ever
 * arrives (a plain browser) can use the same window.
 */
export const DESKTOP_DETECT_TIMEOUT_MS = 12_000;

/**
 * Run `onDetected` once the page is known to run inside the desktop shell.
 *
 * Resolves immediately when a bridge is already there, otherwise polls until
 * the shell injects one or the timeout expires. The callback runs at most
 * once.
 */
export function whenDesktopShellDetected(onDetected: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  if (isDesktopShellPage()) {
    onDetected();
    return () => {};
  }
  let done = false;
  const fire = () => {
    if (done) return;
    done = true;
    onDetected();
  };
  const poll = window.setInterval(() => {
    if (!isDesktopShellPage()) return;
    window.clearInterval(poll);
    fire();
  }, POLL_INTERVAL_MS);
  const stop = window.setTimeout(() => {
    window.clearInterval(poll);
  }, DESKTOP_DETECT_TIMEOUT_MS);
  return () => {
    window.clearInterval(poll);
    window.clearTimeout(stop);
  };
}

/**
 * Decide whether the page runs inside the desktop shell, waiting for the
 * shell to speak when it has not yet identified itself.
 *
 * The shell injects its bridges shortly after the page starts loading, so a
 * caller that asks too early can mistake a desktop client for a browser. This
 * helper resolves `true` as soon as a shell signal appears and `false` once
 * the detection window expires without one.
 *
 * Unlike `whenDesktopShellDetected`, the promise always settles — a plain
 * browser never gets a bridge, and that case must resolve to `false` rather
 * than hang.
 */
export function resolveDesktopShellContext(): Promise<boolean> {
  if (typeof window === "undefined") return Promise.resolve(false);
  if (isDesktopShellContext()) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    let done = false;
    const settle = (value: boolean) => {
      if (done) return;
      done = true;
      window.clearInterval(poll);
      window.clearTimeout(stop);
      resolve(value);
    };
    const poll = window.setInterval(() => {
      if (isDesktopShellContext()) settle(true);
    }, POLL_INTERVAL_MS);
    const stop = window.setTimeout(() => settle(false), DESKTOP_DETECT_TIMEOUT_MS);
  });
}
