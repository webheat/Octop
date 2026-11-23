import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OutputStage, type RenderTarget } from "./OutputStage";
import type { ReactNode } from "react";

type MockSelectProps = {
  options?: { value: string | number; label: ReactNode; disabled?: boolean }[];
  value?: string | number;
  placeholder?: string;
  onChange?: (value: string) => void;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
};

// The real antd Select renders a combobox that cannot be driven by
// userEvent.selectOptions, so it is replaced by a plain <select>.
vi.mock("antd", async (importOriginal) => {
  const actual = await importOriginal<typeof import("antd")>();
  return {
    ...actual,
    Select: (props: MockSelectProps) => (
      <select
        aria-label={props["aria-label"]}
        className={props.className}
        disabled={props.disabled}
        value={props.value ?? ""}
        onChange={(event) => props.onChange?.(event.currentTarget.value)}
      >
        <option value="">{props.placeholder ?? ""}</option>
        {props.options?.map((option) => (
          <option
            key={option.value}
            value={option.value}
            disabled={option.disabled}
          >
            {option.label}
          </option>
        ))}
      </select>
    ),
  };
});

const noop = async () => undefined;

// The size tag renders "{width} × {height} · 30 fps" as separate text nodes,
// so the matcher walks the rendered tree and keeps the leaf-ish elements
// whose own text describes a canvas size.
function sizeTags() {
  return Array.from(document.querySelectorAll("span, div"))
    .map((node) => (node.textContent ?? "").replace(/\s+/g, " ").trim())
    .filter((text) => /^\d+ × \d+ · 30 fps$/.test(text))
    .filter((text, index, all) => all.indexOf(text) === index);
}

function renderOutput(props: Partial<React.ComponentProps<typeof OutputStage>> = {}) {
  return render(
    <OutputStage
      isDesktop
      desktopJob={undefined}
      coverAsset={undefined}
      imageUrls={{}}
      nativeBusy={false}
      nativeSaving={false}
      environmentReady
      backToLibrary={noop}
      startNativeJob={noop}
      cancelNativeJob={noop}
      saveNativeVideo={noop}
      retryNativeJob={noop}
      // The test i18n mock returns the key itself, so the brief stores the
      // platform key the same way the picker would in that environment.
      selectedPlatforms={["douyin", "youtube"]}
      outputLanguage="zh"
      startBatch={async () => undefined}
      batchTargets={[]}
      {...props}
    />,
  );
}

describe("multi-platform output stage", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("gives each platform its own default format instead of one vertical clip", async () => {
    renderOutput();

    // A short-video app defaults to 9:16, a long-form site to 16:9.
    await waitFor(() => {
      expect(sizeTags()).toHaveLength(2);
    });
    expect(sizeTags()).toContain("1080 × 1920 · 30 fps");
    expect(sizeTags()).toContain("1920 × 1080 · 30 fps");
  });

  it("still resolves a platform saved under another locale", async () => {
    const startBatch = vi.fn(async () => undefined);
    // A draft saved while the UI was in Chinese keeps "抖音"; the output page
    // must still turn it into a variant.
    renderOutput({ selectedPlatforms: ["抖音", "B站"], startBatch });

    await waitFor(() => {
      expect(sizeTags()).toHaveLength(2);
    });
    await userEvent.click(screen.getByRole("button", { name: /Render selected versions/ }));

    await waitFor(() => {
      expect(startBatch).toHaveBeenCalledTimes(1);
    });
    const targets = startBatch.mock.calls[0][0] as RenderTarget[];
    expect(targets.find((target) => target.platform === "douyin")).toMatchObject({
      profile: "short_vertical",
      width: 1080,
      height: 1920,
    });
    expect(targets.find((target) => target.platform === "bilibili")).toMatchObject({
      profile: "landscape",
      width: 1920,
      height: 1080,
    });
  });

  it("sends one render target per platform with the matching canvas", async () => {
    const startBatch = vi.fn(async () => undefined);
    renderOutput({ startBatch });

    await waitFor(() => {
      expect(sizeTags()).toHaveLength(2);
    });
    await userEvent.click(screen.getByRole("button", { name: /Render selected versions/ }));

    await waitFor(() => {
      expect(startBatch).toHaveBeenCalledTimes(1);
    });
    const targets = startBatch.mock.calls[0][0] as RenderTarget[];
    expect(targets).toHaveLength(2);

    const douyin = targets.find((target) => target.platform === "douyin");
    const youtube = targets.find((target) => target.platform === "youtube");
    expect(douyin).toMatchObject({
      platform: "douyin",
      profile: "short_vertical",
      width: 1080,
      height: 1920,
      fps: 30,
    });
    expect(youtube).toMatchObject({
      platform: "youtube",
      profile: "landscape",
      width: 1920,
      height: 1080,
      fps: 30,
    });
    // Filenames must stay unique and end in .mp4.
    const filenames = targets.map((target) => target.filename);
    expect(new Set(filenames).size).toBe(targets.length);
    for (const filename of filenames) expect(filename).toMatch(/\.mp4$/);
  });

  it("lets the user switch a variant to another format", async () => {
    const startBatch = vi.fn(async () => undefined);
    renderOutput({ startBatch });

    await waitFor(() => {
      expect(sizeTags()).toHaveLength(2);
    });
    // The YouTube variant starts at 16:9; switch it to square.
    const selects = screen.getAllByRole("combobox", {
      name: /output format/,
    });
    await userEvent.selectOptions(selects[1], "square");

    await waitFor(() => {
      expect(sizeTags()).toContain("1080 × 1080 · 30 fps");
    });
    await userEvent.click(screen.getByRole("button", { name: /Render selected versions/ }));

    await waitFor(() => {
      expect(startBatch).toHaveBeenCalledTimes(1);
    });
    const targets = startBatch.mock.calls[0][0] as RenderTarget[];
    const youtube = targets.find((target) => target.platform === "youtube");
    expect(youtube).toMatchObject({
      profile: "square",
      width: 1080,
      height: 1080,
    });
  });

  it("keeps a failed target visible without hiding the completed ones", () => {
    renderOutput({
      batchTargets: [
        {
          id: "t1",
          platform: "douyin",
          profile: "short_vertical",
          width: 1080,
          height: 1920,
          fps: 30,
          language: "zh",
          safeArea: "standard",
          filename: "douyin-short_vertical-1-1080x1920.mp4",
          status: "completed",
        },
        {
          id: "t2",
          platform: "youtube",
          profile: "landscape",
          width: 1920,
          height: 1080,
          fps: 30,
          language: "zh",
          safeArea: "standard",
          filename: "youtube-landscape-2-1920x1080.mp4",
          status: "failed",
          error: "RENDER_FAILED",
        },
      ],
    });

    // Both targets are reported: the failure does not hide the success.
    expect(screen.getAllByText(/douyin/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/youtube/).length).toBeGreaterThan(0);
    expect(screen.getByText("RENDER_FAILED")).toBeTruthy();
    expect(screen.getByText("Completed")).toBeTruthy();
    expect(screen.getByText("Failed")).toBeTruthy();
  });
});
