import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DESKTOP_MINIMAL_LANDING,
  isDesktopMinimalPath,
  useDesktopMinimalLanding,
  useDesktopMinimalMode,
} from "./useDesktopMinimalMode";

const NATIVE_MARKER = "data-octop-minimal-native";

function setBridge(value: unknown) {
  Object.defineProperty(window, "octopDesktopVideo", {
    configurable: true,
    writable: true,
    value,
  });
}

function clearBridge() {
  Reflect.deleteProperty(window, "octopDesktopVideo");
  document.documentElement.removeAttribute(NATIVE_MARKER);
}

function pressRestoreShortcut() {
  document.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "F9",
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
    }),
  );
}

afterEach(() => {
  clearBridge();
  vi.useRealTimers();
});

describe("isDesktopMinimalPath", () => {
  it("allows the landing page and its wizard sub-route", () => {
    expect(isDesktopMinimalPath(DESKTOP_MINIMAL_LANDING)).toBe(true);
    expect(isDesktopMinimalPath("/product-library/video-wizard")).toBe(true);
  });

  it("rejects other pages and lookalike prefixes", () => {
    expect(isDesktopMinimalPath("/chat")).toBe(false);
    expect(isDesktopMinimalPath("/")).toBe(false);
    expect(isDesktopMinimalPath("/product-library-old")).toBe(false);
  });
});

describe("useDesktopMinimalMode", () => {
  it("stays off in an ordinary browser", () => {
    clearBridge();
    vi.useFakeTimers();
    const { result } = renderHook(() => useDesktopMinimalMode());
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current).toBe(false);
    expect(document.documentElement.hasAttribute(NATIVE_MARKER)).toBe(false);
  });

  it("turns on when the video bridge is present", () => {
    setBridge({ version: 1 });
    const { result } = renderHook(() => useDesktopMinimalMode());
    expect(result.current).toBe(true);
    expect(document.documentElement.getAttribute(NATIVE_MARKER)).toBe("1");
  });

  it("respects the shell's explicit OCTOP_DESKTOP_MINIMAL=0 opt-out", () => {
    setBridge({ version: 1, minimalMode: false });
    vi.useFakeTimers();
    const { result } = renderHook(() => useDesktopMinimalMode());
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current).toBe(false);
  });

  it("picks up a bridge injected after the first render", () => {
    clearBridge();
    vi.useFakeTimers();
    const { result } = renderHook(() => useDesktopMinimalMode());
    expect(result.current).toBe(false);
    act(() => {
      setBridge({ version: 1 });
      vi.advanceTimersByTime(200);
    });
    expect(result.current).toBe(true);
  });

  it("keeps the shell's Ctrl+Shift+F9 troubleshooting shortcut", () => {
    setBridge({ version: 1 });
    const { result } = renderHook(() => useDesktopMinimalMode());
    expect(result.current).toBe(true);

    act(() => pressRestoreShortcut());
    expect(result.current).toBe(false);
    // The marker must survive: the legacy injection would otherwise hide the
    // restored rail again on the next DOM mutation.
    expect(document.documentElement.getAttribute(NATIVE_MARKER)).toBe("1");

    act(() => pressRestoreShortcut());
    expect(result.current).toBe(true);
  });
});

describe("useDesktopMinimalLanding", () => {
  it("lands once and leaves later navigation alone", () => {
    setBridge({ version: 1 });
    const navigate = vi.fn();
    const { rerender } = renderHook(
      ({ path }: { path: string }) => useDesktopMinimalLanding(path, navigate),
      { initialProps: { path: "/chat" } },
    );
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith(DESKTOP_MINIMAL_LANDING, {
      replace: true,
    });

    rerender({ path: "/experts" });
    rerender({ path: "/chat" });
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it("does not redirect an ordinary browser", () => {
    clearBridge();
    vi.useFakeTimers();
    const navigate = vi.fn();
    renderHook(() => useDesktopMinimalLanding("/chat", navigate));
    act(() => vi.advanceTimersByTime(1000));
    expect(navigate).not.toHaveBeenCalled();
  });
});
