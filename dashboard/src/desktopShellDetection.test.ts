import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  hasDesktopUrlFlag,
  isDesktopShellPage,
  isKnownDesktopProfile,
  markDesktopProfile,
  resolveDesktopShellContext,
  shouldSkipServiceWorker,
  whenDesktopShellDetected,
} from "./desktopShellDetection";

type BridgeHost = Window & {
  octopDesktop?: unknown;
  octopDesktopShell?: boolean;
  octopDesktopVideo?: { version: number };
};

function clearBridges(): void {
  const host = window as BridgeHost;
  delete host.octopDesktop;
  delete host.octopDesktopShell;
  delete host.octopDesktopVideo;
}

function setSearch(search: string): void {
  window.history.replaceState({}, "", `/${search}`);
}

describe("hasDesktopUrlFlag", () => {
  beforeEach(() => {
    setSearch("");
  });

  afterEach(() => {
    setSearch("");
  });

  it("is false without the flag", () => {
    expect(hasDesktopUrlFlag()).toBe(false);
  });

  it("is true with the shell flag", () => {
    setSearch("?desktop=1");
    expect(hasDesktopUrlFlag()).toBe(true);
  });

  it("ignores a different value", () => {
    setSearch("?desktop=0");
    expect(hasDesktopUrlFlag()).toBe(false);
  });
});

describe("desktop profile marker", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it("is not a desktop profile by default", () => {
    expect(isKnownDesktopProfile()).toBe(false);
  });

  it("remembers the profile after marking it", () => {
    markDesktopProfile();
    expect(isKnownDesktopProfile()).toBe(true);
  });
});

describe("isDesktopShellPage", () => {
  beforeEach(() => {
    clearBridges();
  });

  afterEach(() => {
    clearBridges();
  });

  it("is false in a plain browser", () => {
    expect(isDesktopShellPage()).toBe(false);
  });

  it("recognises the video bridge that every shell since v1.4.0 injects", () => {
    (window as BridgeHost).octopDesktopVideo = { version: 1 };
    expect(isDesktopShellPage()).toBe(true);
  });

  it("recognises the newer shell marker", () => {
    (window as BridgeHost).octopDesktopShell = true;
    expect(isDesktopShellPage()).toBe(true);
  });

  it("recognises the Electron-style bridge", () => {
    (window as BridgeHost).octopDesktop = {};
    expect(isDesktopShellPage()).toBe(true);
  });

  it("ignores a video bridge with an unknown version", () => {
    (window as BridgeHost).octopDesktopVideo = { version: 99 };
    expect(isDesktopShellPage()).toBe(false);
  });
});

describe("shouldSkipServiceWorker", () => {
  beforeEach(() => {
    clearBridges();
    window.localStorage.clear();
    setSearch("");
  });

  afterEach(() => {
    clearBridges();
    window.localStorage.clear();
    setSearch("");
  });

  it("does not skip in a plain browser", () => {
    expect(shouldSkipServiceWorker()).toBe(false);
  });

  it("skips when the shell flag is on the URL", () => {
    setSearch("?desktop=1");
    expect(shouldSkipServiceWorker()).toBe(true);
  });

  it("skips when the profile was marked earlier", () => {
    markDesktopProfile();
    expect(shouldSkipServiceWorker()).toBe(true);
  });

  it("skips when a shell bridge is present", () => {
    (window as BridgeHost).octopDesktopVideo = { version: 1 };
    expect(shouldSkipServiceWorker()).toBe(true);
  });
});

describe("whenDesktopShellDetected", () => {
  beforeEach(() => {
    clearBridges();
    vi.useFakeTimers();
  });

  afterEach(() => {
    clearBridges();
    vi.useRealTimers();
  });

  it("fires immediately when the bridge is already there", () => {
    (window as BridgeHost).octopDesktopVideo = { version: 1 };
    const onDetected = vi.fn();
    whenDesktopShellDetected(onDetected);
    expect(onDetected).toHaveBeenCalledOnce();
  });

  it("fires once the shell injects its bridge later", async () => {
    const onDetected = vi.fn();
    whenDesktopShellDetected(onDetected);
    expect(onDetected).not.toHaveBeenCalled();

    (window as BridgeHost).octopDesktopVideo = { version: 1 };
    await vi.advanceTimersByTimeAsync(400);

    expect(onDetected).toHaveBeenCalledOnce();
  });

  it("fires at most once", async () => {
    const onDetected = vi.fn();
    whenDesktopShellDetected(onDetected);
    (window as BridgeHost).octopDesktopVideo = { version: 1 };
    await vi.advanceTimersByTimeAsync(1000);
    expect(onDetected).toHaveBeenCalledOnce();
  });

  it("never fires in a plain browser", async () => {
    const onDetected = vi.fn();
    whenDesktopShellDetected(onDetected);
    await vi.advanceTimersByTimeAsync(13_000);
    expect(onDetected).not.toHaveBeenCalled();
  });
});

describe("resolveDesktopShellContext", () => {
  beforeEach(() => {
    clearBridges();
    setSearch("");
    window.localStorage.clear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    clearBridges();
    setSearch("");
    window.localStorage.clear();
    vi.useRealTimers();
  });

  it("resolves true right away when the shell flag is on the URL", async () => {
    setSearch("?desktop=1");
    await expect(resolveDesktopShellContext()).resolves.toBe(true);
  });

  it("resolves true right away for a known desktop profile", async () => {
    markDesktopProfile();
    await expect(resolveDesktopShellContext()).resolves.toBe(true);
  });

  it("resolves true once the shell injects its marker later", async () => {
    const pending = resolveDesktopShellContext();
    (window as BridgeHost).octopDesktopShell = true;
    await vi.advanceTimersByTimeAsync(400);
    await expect(pending).resolves.toBe(true);
  });

  it("resolves false in a plain browser instead of hanging", async () => {
    const pending = resolveDesktopShellContext();
    await vi.advanceTimersByTimeAsync(13_000);
    await expect(pending).resolves.toBe(false);
  });
});
