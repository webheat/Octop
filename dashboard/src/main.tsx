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
import {
  markDesktopProfile,
  shouldSkipServiceWorker,
  whenDesktopShellDetected,
} from "./desktopShellDetection";

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
//
// The desktop shell must never keep a Service Worker: it serves the Dashboard
// from the server, so a cached worker pins the client to an outdated build
// long after the server deployed a new one (old video-environment page,
// missing sidebar entries).
//
// The decision is made from three signals, because they become available at
// different moments:
//   - `?desktop=1` in the URL — the shell appends it to the landing URL, so
//     it is already there when this first script runs. This is what actually
//     prevents the worker from being registered in the first place.
//   - the persisted profile marker — a later navigation inside the shell
//     (the flag is only on the landing URL) still knows it must not register.
//   - the injected bridges — the shell injects them after the page started
//     loading, so they only ever confirm what the first two already decided.
//
// Note there is deliberately no "purge then reload" dance here: reloading
// would re-run this code, which would register a worker again and start the
// purge/reload cycle over again. The desktop client simply never registers.
const isDesktop = shouldSkipServiceWorker();

if (typeof window !== "undefined" && !isDesktop) {
  void import("./sw-register").then(({ registerSW }) => registerSW());
}

// Desktop shell (including older shells, which only inject
// `window.octopDesktopVideo`): drop any Service Worker that an earlier
// version of the client left behind in this WebView2 profile, so the profile
// stops serving a stale build. No reload happens here — the page that is
// already on screen was rendered by the stale worker, but the next
// navigation (or the next start) picks up the fresh assets, and a reload
// during start-up would fight the shell's own navigation.
whenDesktopShellDetected(() => {
  markDesktopProfile();
  void import("./sw-register").then(async ({ purgeStaleServiceWorker }) => {
    const purged = await purgeStaleServiceWorker();
    if (purged) {
      console.info(
        "[SW] Removed a stale Service Worker left by an older desktop build.",
      );
    }
  });
});

// A profile that was marked as a desktop profile by an earlier session must
// not keep a worker either — even if this navigation lost the URL flag.
if (isDesktop) {
  markDesktopProfile();
  void import("./sw-register").then(async ({ purgeStaleServiceWorker }) => {
    await purgeStaleServiceWorker();
  });
}
