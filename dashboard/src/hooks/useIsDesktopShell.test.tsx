import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";

import { useIsDesktopShell } from "./useIsDesktopShell";

const MARKER = "octop.desktopShell";

function setLocation(search: string) {
  window.history.replaceState({}, "", `/${search}`);
}

describe("useIsDesktopShell", () => {
  beforeEach(() => {
    localStorage.clear();
    setLocation("");
    delete (window as { octopDesktop?: unknown }).octopDesktop;
    delete (window as { octopDesktopVideo?: unknown }).octopDesktopVideo;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is false in a plain browser", async () => {
    const { result } = renderHook(() => useIsDesktopShell());
    expect(result.current).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(result.current).toBe(false);
  });

  it("is true immediately when the shell appended ?desktop=1", () => {
    setLocation("?desktop=1");
    const { result } = renderHook(() => useIsDesktopShell());
    expect(result.current).toBe(true);
  });

  it("is true from the persisted profile marker", () => {
    localStorage.setItem(MARKER, "1");
    const { result } = renderHook(() => useIsDesktopShell());
    expect(result.current).toBe(true);
  });

  it("turns true once the shell injects its bridge", async () => {
    const { result } = renderHook(() => useIsDesktopShell());
    expect(result.current).toBe(false);
    (window as { octopDesktop?: unknown }).octopDesktop = {};
    await waitFor(() => expect(result.current).toBe(true));
  });
});
