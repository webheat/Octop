import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./config", () => ({
  getApiUrl: (path: string) => `/api${path}`,
}));

vi.mock("../i18n", () => ({
  default: { language: "zh" },
}));

function missingPartResponse(): Response {
  return new Response(
    JSON.stringify({
      error: {
        code: "FEATURE_DEPS_MISSING",
        message: "The optional component octop[tencentcloud] is not installed.",
        details: { feature: "tencent", part: "deps-tencent" },
      },
    }),
    { status: 503, headers: { "content-type": "application/json" } },
  );
}

describe("optional runtime parts", () => {
  let mod: typeof import("./request");
  let fetchMock: ReturnType<typeof vi.fn>;
  let installPart: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    localStorage.clear();
    sessionStorage.clear();
    delete window.octopDesktopRuntime;
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    installPart = vi.fn(() => Promise.resolve({ installed: true }));
    window.octopDesktopRuntime = {
      version: 1,
      request: vi.fn((action: string, payload?: Record<string, unknown>) => {
        if (action === "install_part") return installPart(payload?.part);
        return Promise.resolve({});
      }),
    };
    mod = await import("./request");
  });

  it("installs the requested part and repeats the request", async () => {
    fetchMock
      .mockResolvedValueOnce(missingPartResponse())
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ regions: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

    await expect(mod.request("/cloud/regions")).resolves.toEqual({
      regions: [],
    });

    expect(installPart).toHaveBeenCalledWith("deps-tencent");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("repeats the request only once", async () => {
    fetchMock.mockResolvedValue(missingPartResponse());

    await expect(mod.request("/cloud/regions")).rejects.toThrow(
      /Request failed/,
    );

    expect(installPart).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("surfaces the original error when no shell bridge is present", async () => {
    delete window.octopDesktopRuntime;
    fetchMock.mockResolvedValue(missingPartResponse());

    await expect(mod.request("/cloud/regions")).rejects.toThrow(
      /Request failed/,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
