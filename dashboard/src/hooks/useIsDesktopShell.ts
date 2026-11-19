import { useEffect, useState } from "react";

import {
  hasDesktopUrlFlag,
  isDesktopShellContext,
  resolveDesktopShellContext,
} from "../desktopShellDetection";

/**
 * Whether this page runs inside the desktop shell.
 *
 * The shell injects its bridges only after the page starts loading, so the
 * first render cannot answer the question. The hook reports the synchronous
 * signals immediately (URL flag, persisted profile marker, an already-present
 * bridge) and otherwise waits for `resolveDesktopShellContext()`, which
 * settles after the shell speaks or the detection window expires.
 *
 * Until then it returns the synchronous answer, which is `false` for a
 * browser — the full console stays the default, so a slow detection can never
 * hide console entries on the web.
 */
export function useIsDesktopShell(): boolean {
  const [isDesktopShell, setIsDesktopShell] = useState<boolean>(
    () =>
      typeof window !== "undefined" &&
      (hasDesktopUrlFlag() || isDesktopShellContext()),
  );

  useEffect(() => {
    if (isDesktopShell) return;
    let cancelled = false;
    void resolveDesktopShellContext().then((detected) => {
      if (!cancelled && detected) setIsDesktopShell(true);
    });
    return () => {
      cancelled = true;
    };
  }, [isDesktopShell]);

  return isDesktopShell;
}
