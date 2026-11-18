// Must be the very first import so the beforeinstallprompt listener is
// registered synchronously before Chrome fires the event (which can happen
// before React mounts and useEffect runs).
import "./pwa-prompt";

import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import { initI18n } from "./i18n";
import {
  clearChunkReloadFlag,
  installChunkLoadRecovery,
  isChunkLoadError,
  tryReloadOnStaleChunk,
} from "./utils/reloadOnStaleChunk";
import { bootNativeWindowChrome } from "./utils/nativeWindowChrome";

if (typeof window !== "undefined") {
  // Recover from post-deploy stale hashed chunks (white screen → soft reload).
  installChunkLoadRecovery();

  const originalError = console.error;
  const originalWarn = console.warn;

  console.error = function (...args: unknown[]) {
    const msg = args[0]?.toString() || "";
    if (msg.includes(":first-child") || msg.includes("pseudo class")) {
      return;
    }
    originalError.apply(console, args);
  };

  console.warn = function (...args: unknown[]) {
    const msg = args[0]?.toString() || "";
    if (
      msg.includes(":first-child") ||
      msg.includes("pseudo class") ||
      msg.includes("potentially unsafe")
    ) {
      return;
    }
    originalWarn.apply(console, args);
  };

  // Catch unhandled Promise rejections (e.g. uncaught async errors)
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    // Chunk recovery (installChunkLoadRecovery) already handles these.
    if (isChunkLoadError(reason)) return;
    // Suppress common benign errors
    const msg = reason?.message || String(reason) || "";
    if (
      msg.includes("ResizeObserver") ||
      msg.includes("AbortError") ||
      msg.includes("The operation was aborted")
    ) {
      return;
    }
    console.error("[UnhandledRejection]", reason);
  });

  // Native window buttons are drawn by the OS, so paint them in the stored
  // theme before React mounts (an effect would be one frame too late).
  bootNativeWindowChrome();
}

void initI18n()
  .then(() => {
    createRoot(document.getElementById("root")!).render(<App />);
    // Delay clearing the one-shot reload guard until after first paint / lazy
    // chunks settle. Clearing immediately let Firefox modulepreload noise and
    // aborted dynamic imports re-arm an infinite reload loop.
    window.setTimeout(() => clearChunkReloadFlag(), 4000);
  })
  .catch((err: unknown) => {
    if (tryReloadOnStaleChunk(err)) return;
    console.error("[initI18n]", err);
  });

// Register SW as early as possible so beforeinstallprompt can fire before the
// user clicks the header install button (deferring to "load" caused a race).
// DEV clears stale production workers, then registers the notification worker.
// The desktop shell must never register a Service Worker that could cache a
// stale frontend independently of the shell.
//
// `window.octopDesktop` is the Electron-style bridge and is absent in the thin
// (remote) Wails build, so the shell also sets `window.octopDesktopShell`.
// Without that marker the remote page believed it was a browser, registered
// the production worker, and the WebView2 profile kept serving a stale
// Dashboard long after the server deployed a new build.
if (typeof window !== "undefined" && !window.octopDesktop && !window.octopDesktopShell) {
  void import("./sw-register").then(({ registerSW }) => registerSW());
}

// The desktop shell serves the Dashboard from the server, so a leftover
// Service Worker can only ever pin the client to an outdated build. Drop it
// (and its caches) before the app renders the stale page.
//
// The shell injects `window.octopDesktopShell` and performs the same purge on
// its side, then reloads the document that the stale worker had rendered. The
// page only has to make sure no worker survives — reloading here as well
// would race the shell's reload.
if (typeof window !== "undefined" && window.octopDesktopShell) {
  void import("./sw-register").then(async ({ purgeStaleServiceWorker }) => {
    const purged = await purgeStaleServiceWorker();
    if (purged) {
      console.info("[SW] Removed a stale Service Worker left by an older desktop build.");
    }
  });
}
