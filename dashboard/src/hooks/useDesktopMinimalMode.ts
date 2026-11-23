import { useEffect, useRef, useState } from "react";

/** Landing page of the customer-facing desktop shell. */
export const DESKTOP_MINIMAL_LANDING = "/local-video-wizard";

/**
 * Marker telling the shell's legacy DOM-based injection that this build
 * handles minimal mode natively. The shell then stops hiding the rail and
 * rewriting history; older shells ignore it and harmlessly no-op.
 */
const NATIVE_MARKER = "data-octop-minimal-native";

/**
 * The shell injects `window.octopDesktopVideo` after the page starts loading
 * (every 250ms for ~10s), so the first render can legitimately see no bridge.
 *
 * `minimalMode: false` is the explicit opt-out a shell sets when started with
 * OCTOP_DESKTOP_MINIMAL=0. Shells that predate the field omit it and are
 * treated as customer-facing; their DOM injection stays as a fallback.
 */
function desktopMinimalBridge(): boolean {
  const bridge = window.octopDesktopVideo;
  return bridge?.version === 1 && bridge.minimalMode !== false;
}

/** True for the entry points supported by the customer-facing desktop shell. */
export function isDesktopMinimalPath(pathname: string): boolean {
  return (
    pathname === DESKTOP_MINIMAL_LANDING ||
    pathname === "/local-library" ||
    pathname === "/video-environment" ||
    pathname === "/product-library/video-wizard"
  );
}

/**
 * Customer-facing desktop shells use the dashboard's compact video navigation.
 *
 * Ctrl+Shift+F9 keeps the shell's troubleshooting shortcut: restore the full
 * navigation for this page session. The marker stays in place so the shell's
 * own (now disabled) injection cannot hide the restored rail again.
 */
export function useDesktopMinimalMode(): boolean {
  const [bridgeReady, setBridgeReady] = useState(desktopMinimalBridge);
  const [navRestored, setNavRestored] = useState(false);

  useEffect(() => {
    if (desktopMinimalBridge()) {
      setBridgeReady(true);
      return;
    }
    const poll = window.setInterval(() => {
      if (desktopMinimalBridge()) {
        setBridgeReady(true);
        window.clearInterval(poll);
      }
    }, 200);
    const stop = window.setTimeout(() => window.clearInterval(poll), 12_000);
    return () => {
      window.clearInterval(poll);
      window.clearTimeout(stop);
    };
  }, []);

  useEffect(() => {
    if (!bridgeReady) return;
    document.documentElement.setAttribute(NATIVE_MARKER, "1");
  }, [bridgeReady]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.shiftKey && event.key === "F9") {
        setNavRestored((restored) => !restored);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  return bridgeReady && !navRestored;
}

/**
 * Land on the local video wizard once when the shell starts (this also covers
 * the post-login redirect to /chat). Later navigation is left alone: the
 * shell must not keep forcing the user back to the landing page.
 */
export function useDesktopMinimalLanding(
  currentPath: string,
  navigate: (to: string, options?: { replace?: boolean }) => void,
): boolean {
  const desktopMinimal = useDesktopMinimalMode();
  const landed = useRef(false);

  useEffect(() => {
    if (!desktopMinimal || landed.current) return;
    landed.current = true;
    if (!isDesktopMinimalPath(currentPath)) {
      navigate(DESKTOP_MINIMAL_LANDING, { replace: true });
    }
  }, [desktopMinimal, currentPath, navigate]);

  return desktopMinimal;
}
