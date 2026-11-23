import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./request", () => ({ request: vi.fn(), getAuthToken: () => "token" }));

import { request } from "./request";
import { groupPlan, localLibrary } from "./localLibrary";

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, "octopDesktopLibrary");
});

describe("local library API", () => {
  it("sends the group plan as the array expected by the endpoint", async () => {
    const items = [{ id: "one", category: "shoes" }];
    await groupPlan({ items });
    expect(request).toHaveBeenCalledWith("/product-library/group-plan", {
      method: "POST",
      body: JSON.stringify(items),
    });
  });

  it("splits recognition retries into batches of at most 500", async () => {
    const requestBridge = vi.fn(
      async (
        _action: string,
        _token: string,
        payload: { body: { ids: string[] } },
      ) => ({ items: payload.body.ids.map((id) => ({ id })) }),
    );
    Object.defineProperty(window, "octopDesktopLibrary", {
      configurable: true,
      value: { request: requestBridge },
    });
    const ids = Array.from({ length: 501 }, (_, i) => String(i));
    expect(await localLibrary.recognizeExisting(ids)).toHaveLength(501);
    expect(requestBridge).toHaveBeenCalledTimes(2);
    expect(
      requestBridge.mock.calls.map((call) => call[2].body.ids.length),
    ).toEqual([500, 1]);
  });
});
