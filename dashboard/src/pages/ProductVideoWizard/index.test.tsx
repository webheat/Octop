import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ProductVideoWizardPage from "./index";
import { decodeVideoBrief, encodeVideoBrief } from "./brief";
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

const api = vi.hoisted(() => ({
  products: vi.fn(),
  projects: vi.fn(),
  assets: vi.fn(),
  upload: vi.fn(),
  updateProduct: vi.fn(),
  createProject: vi.fn(),
  generateStoryboard: vi.fn(),
  getStoryboard: vi.fn(),
  saveStoryboard: vi.fn(),
  narrationOptions: vi.fn(),
  downloadStoryboardPackage: vi.fn(),
  downloadAsset: vi.fn(),
}));
const desktopJobs = vi.hoisted(() => ({
  bridgeAvailable: false,
  environmentSupported: false,
  environmentStatus: {
    state: "unknown" as string,
    stage: null as string | null,
    progress: null as number | null,
    requiresInstall: false,
  },
  environmentInstallerURL: undefined as string | undefined,
  jobs: [] as {
    id: string;
    projectId: string;
    ownerId: number;
    name: string;
    state: string;
    progress: number | null;
    updatedAt: number;
    videoUrl?: string;
  }[],
  start: vi.fn(),
  cancel: vi.fn(),
  retry: vi.fn(),
  save: vi.fn(),
  checkEnvironment: vi.fn(),
  verifyEnvironment: vi.fn(),
  refreshEnvironment: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("../../api/modules/productLibrary", () => ({ productLibraryApi: api }));
vi.mock("../../context/DesktopVideoJobsContext", () => ({
  useDesktopVideoJobs: () => desktopJobs,
  isActiveDesktopVideoJob: (job: { state: string }) =>
    ["preparing", "downloading", "rendering", "saving"].includes(job.state),
}));
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
vi.mock("../../hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ id: 7 }),
}));
vi.mock("../../layouts/PageShell", () => ({
  default: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

const product = {
  id: "p1",
  name: "Sample product",
  model: "S-1",
  category: "",
  selling_points: ["Verified point"],
  parameters: {},
  expression_limits: "",
};
const sceneAsset = {
  id: "asset1",
  product_id: "p1",
  filename: "front.jpg",
  media_type: "image/jpeg",
  byte_size: 10,
  usage: "scene" as const,
  priority: 1,
  active: 1,
  content_hash: "hash",
};
const snapshotAsset = {
  id: "asset1",
  filename: "front.jpg",
  media_type: "image/jpeg",
  byte_size: 10,
  usage: "scene" as const,
  priority: 1,
  content_hash: "hash",
};
const foreignAsset = {
  ...sceneAsset,
  id: "asset2",
  filename: "foreign.jpg",
  product_id: "p2",
};
const project = {
  id: "project1",
  product_id: "p1",
  name: "Sample project",
  snapshot: { product, assets: [snapshotAsset], version: 1 },
  created_at: 1,
};
const request = {
  instructions: "Keep the product clear",
  format: "portrait" as const,
  language: "zh" as const,
  seconds_per_asset: 4,
  include_selling_points: true,
};
const script = {
  title: product.name,
  fps: 30,
  width: 1080,
  height: 1920,
  scenes: [
    {
      id: "title",
      type: "title" as const,
      duration: 3,
      text: product.name,
      subtitle: "S-1",
    },
    {
      id: "image",
      type: "image" as const,
      duration: 4,
      asset: "asset1-front.jpg",
      caption: "A close view",
    },
    { id: "end", type: "endcard" as const, duration: 2, text: product.name },
  ],
};
const savedDraft = {
  project_id: project.id,
  request,
  script,
  confirmed: false,
};

function renderWizard(
  path = "/product-library/video-wizard",
  state?: unknown,
) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: path.split("?")[0], search: path.includes("?") ? `?${path.split("?")[1]}` : "", state }]}>
      <Routes>
        <Route
          path="/product-library/video-wizard"
          element={<ProductVideoWizardPage />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe("product video wizard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    desktopJobs.bridgeAvailable = false;
    desktopJobs.environmentSupported = false;
    desktopJobs.environmentStatus = {
      state: "unknown",
      stage: null,
      progress: null,
      requiresInstall: false,
    };
    desktopJobs.environmentInstallerURL = undefined;
    desktopJobs.jobs = [];
    api.products.mockResolvedValue({ items: [product] });
    api.projects.mockResolvedValue({ items: [] });
    api.assets.mockResolvedValue({ items: [sceneAsset] });
    api.narrationOptions.mockResolvedValue({
      premium: false,
      modes: ["off", "local"],
      voices: [],
    });
    api.downloadAsset.mockResolvedValue(new Blob(["image"]));
    api.createProject.mockResolvedValue(project);
    api.updateProduct.mockImplementation(async (_id, body) => ({
      ...product,
      ...body,
    }));
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:preview"),
      revokeObjectURL: vi.fn(),
    });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(
      () => undefined,
    );
  });

  it("keeps the project after AI failure and sends only real API plan fields", async () => {
    const user = userEvent.setup();
    api.generateStoryboard.mockRejectedValue(new Error("LLM unavailable"));
    renderWizard();
    await screen.findByText("videoWizard.chooseTitle");
    await user.selectOptions(
      screen.getByRole("combobox", { name: "videoWizard.product" }),
      "p1",
    );
    await screen.findByText("front.jpg");
    expect(screen.queryByText("foreign.jpg")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "videoWizard.next" }));
    await user.click(
      screen.getByRole("button", { name: "videoWizard.generate" }),
    );
    await screen.findByText("videoWizard.generateFailed");
    expect(api.createProject).toHaveBeenCalledWith({
      product_id: "p1",
      name: expect.stringContaining("Sample product"),
      asset_ids: ["asset1"],
    });
    expect(api.generateStoryboard).toHaveBeenCalledWith(
      "project1",
      expect.objectContaining({
        format: "portrait",
        language: "zh",
        seconds_per_asset: 4,
        include_selling_points: true,
        instructions: expect.any(String),
      }),
    );
  }, 15000);

  it("restores a saved draft, saves edits, confirms, then exports the confirmed package", async () => {
    const user = userEvent.setup();
    api.assets.mockResolvedValue({ items: [sceneAsset, foreignAsset] });
    api.projects.mockResolvedValue({ items: [project] });
    api.getStoryboard.mockResolvedValue(savedDraft);
    let resolvePendingSave: (() => void) | undefined;
    api.saveStoryboard.mockImplementationOnce(
      (_id, body) =>
        new Promise((resolve) => {
          resolvePendingSave = () => resolve({ ...savedDraft, ...body });
        }),
    );
    api.downloadStoryboardPackage.mockResolvedValue(new Blob(["zip"]));
    renderWizard("/product-library/video-wizard?project=project1");
    await screen.findByText("videoWizard.storyboardTitle");
    expect(screen.getAllByDisplayValue("Sample product")).toHaveLength(2);
    expect(screen.queryByText("foreign.jpg")).not.toBeInTheDocument();
    const subtitle = screen.getAllByRole("textbox", {
      name: "videoWizard.sceneSubtitle",
    })[0];
    await user.clear(subtitle);
    await user.type(subtitle, "Updated subtitle");
    await user.click(
      screen.getByRole("button", { name: "videoWizard.saveChanges" }),
    );
    await waitFor(() =>
      expect(api.saveStoryboard).toHaveBeenCalledWith(
        "project1",
        expect.objectContaining({ confirmed: false }),
      ),
    );
    expect(subtitle).toBeDisabled();
    await act(async () => {
      resolvePendingSave?.();
    });
    await waitFor(() => expect(subtitle).not.toBeDisabled());
    expect(api.saveStoryboard.mock.calls[0][1].script.scenes[0].subtitle).toBe(
      "Updated subtitle",
    );
    api.saveStoryboard.mockImplementation(async (_id, body) => ({
      ...savedDraft,
      ...body,
    }));
    await user.click(
      screen.getByRole("button", { name: "videoWizard.confirmContinue" }),
    );
    await screen.findByText("videoWizard.exportReady");
    await user.click(
      screen.getByRole("button", { name: "videoWizard.downloadPackage" }),
    );
    await waitFor(() =>
      expect(api.downloadStoryboardPackage).toHaveBeenCalledWith("project1"),
    );
    expect(api.saveStoryboard.mock.calls.at(-1)?.[1].confirmed).toBe(true);
  }, 15000);

  it("starts native rendering only after the user confirms, not when reopening a confirmed plan", async () => {
    const user = userEvent.setup();
    desktopJobs.bridgeAvailable = true;
    const nativeJob = {
      id: "job1",
      projectId: project.id,
      ownerId: 7,
      name: "Sample product",
      state: "preparing",
      progress: 0,
      updatedAt: 1,
    };
    desktopJobs.start.mockImplementation(async () => {
      desktopJobs.jobs = [nativeJob];
      return nativeJob;
    });
    api.projects.mockResolvedValue({ items: [project] });
    api.getStoryboard.mockResolvedValue(savedDraft);
    api.saveStoryboard.mockImplementation(async (_id, body) => ({
      ...savedDraft,
      ...body,
    }));
    const { unmount } = renderWizard(
      "/product-library/video-wizard?project=project1",
    );
    await screen.findByText("videoWizard.storyboardTitle");
    await user.click(
      screen.getByRole("button", { name: "videoWizard.confirmMake" }),
    );
    await waitFor(() =>
      expect(desktopJobs.start).toHaveBeenCalledWith("project1"),
    );
    expect(api.saveStoryboard.mock.calls[0][1].confirmed).toBe(true);
    await screen.findByText("videoWizard.activeTitle");
    expect(
      screen.getAllByText("videoWizard.stage.preparing").length,
    ).toBeGreaterThan(0);
    expect(
      screen.getByText("videoWizard.stageStatus.current"),
    ).toBeInTheDocument();
    expect(screen.getAllByText("videoWizard.stageStatus.pending")).toHaveLength(
      2,
    );
    expect(
      screen.getByRole("button", { name: "videoWizard.previous" }),
    ).toBeDisabled();
    unmount();

    desktopJobs.jobs = [];
    api.getStoryboard.mockResolvedValue({ ...savedDraft, confirmed: true });
    renderWizard("/product-library/video-wizard?project=project1");
    await screen.findByText("videoWizard.startReadyTitle");
    expect(desktopJobs.start).toHaveBeenCalledTimes(1);
  });

  it("uses only available assets from the same product in route selection, including an explicit empty selection", async () => {
    api.assets.mockResolvedValue({ items: [sceneAsset, foreignAsset, { ...sceneAsset, id: "disabled", active: 0 }, { ...sceneAsset, id: "reference", usage: "reference" }] });
    renderWizard("/product-library/video-wizard?product=p1", { productId: "p1", assetIds: ["asset1", "asset2", "disabled", "reference"], ownerId: 7 });
    await screen.findByText("front.jpg");
    expect(screen.getAllByRole("checkbox")[0]).toBeChecked();
    expect(screen.queryByText("foreign.jpg")).not.toBeInTheDocument();
    cleanup();
    renderWizard("/product-library/video-wizard?product=p1", { productId: "p1", assetIds: [], ownerId: 7 });
    await screen.findByText("front.jpg");
    expect(screen.getAllByRole("checkbox")[0]).not.toBeChecked();
  });

  it("does not inherit another owner's route selection and gives an existing project precedence", async () => {
    const secondAsset = { ...sceneAsset, id: "asset2", filename: "side.jpg" };
    api.assets.mockResolvedValue({ items: [sceneAsset, secondAsset] });
    renderWizard("/product-library/video-wizard?product=p1", { productId: "p1", assetIds: ["asset2"], ownerId: 6 });
    await screen.findByText("side.jpg");
    expect(screen.getAllByRole("checkbox")[0]).toBeChecked();
    expect(screen.getAllByRole("checkbox")[1]).toBeChecked();

    cleanup();
    api.projects.mockResolvedValue({ items: [project] });
    api.getStoryboard.mockResolvedValue(savedDraft);
    renderWizard("/product-library/video-wizard?project=project1&product=p1", { productId: "p1", assetIds: [], ownerId: 7 });
    await waitFor(() => expect(api.getStoryboard).toHaveBeenCalledWith("project1"));
  });

  it("ignores a late asset response after switching products", async () => {
    const user = userEvent.setup();
    const secondProduct = { ...product, id: "p2", name: "Second product" };
    let resolveFirst!: (value: { items: typeof sceneAsset[] }) => void;
    let resolveSecond!: (value: { items: typeof sceneAsset[] }) => void;
    api.products.mockResolvedValue({ items: [product, secondProduct] });
    api.assets.mockImplementation((id: string) => new Promise((resolve) => {
      if (id === "p1") resolveFirst = resolve;
      else resolveSecond = resolve;
    }));
    renderWizard();
    await screen.findByText("videoWizard.chooseTitle");
    const selector = screen.getByRole("combobox", { name: "videoWizard.product" });
    await user.selectOptions(selector, "p1");
    await user.selectOptions(selector, "p2");
    await act(async () => resolveFirst({ items: [sceneAsset] }));
    const secondAsset = { ...sceneAsset, id: "p2-asset", product_id: "p2", filename: "second.jpg" };
    await act(async () => resolveSecond({ items: [secondAsset] }));
    await screen.findByText("second.jpg");
    expect(screen.queryByText("front.jpg")).not.toBeInTheDocument();
  });

  it("keeps a cancelled old selection while retaining and retrying only failed uploads", async () => {
    const user = userEvent.setup();
    const added = { ...sceneAsset, id: "asset-new", filename: "new.jpg" };
    const failedFile = new File(["bad"], "failed.jpg", { type: "image/jpeg" });
    const goodFile = new File(["good"], "new.jpg", { type: "image/jpeg" });
    api.upload.mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce({ items: [added] })
      .mockResolvedValueOnce({ items: [{ ...sceneAsset, id: "asset-retry", filename: "failed.jpg" }] });
    api.assets.mockResolvedValueOnce({ items: [sceneAsset] })
      .mockResolvedValueOnce({ items: [sceneAsset, added] })
      .mockResolvedValue({ items: [sceneAsset, added, { ...sceneAsset, id: "asset-retry", filename: "failed.jpg" }] });
    renderWizard("/product-library/video-wizard?product=p1", { productId: "p1", assetIds: ["asset1"], ownerId: 7 });
    await screen.findByText("front.jpg");
    await user.click(screen.getByText("front.jpg").closest("button")!);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, [failedFile, goodFile]);
    await user.click(screen.getByRole("button", { name: "videoWizard.uploadAssets" }));
    await screen.findByText("new.jpg");
    expect(screen.getAllByRole("checkbox")[0]).not.toBeChecked();
    expect(screen.getAllByRole("checkbox")[1]).toBeChecked();
    expect(screen.getByText("failed.jpg")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "videoWizard.uploadAssets" }));
    await waitFor(() => expect(api.upload).toHaveBeenCalledTimes(3));
    expect(screen.getByText("failed.jpg")).toBeInTheDocument();
  });

  it("restores structured requirements and replaces the platform selection", async () => {
    const user = userEvent.setup();
    const instructions = encodeVideoBrief({
      purpose: "launch",
      audience: "new customers",
      platform: "Original platform",
      targetDuration: "60",
      style: "elegant",
      sellingPoints: "Verified point",
      extra: "Keep the package visible",
    });
    api.projects.mockResolvedValue({ items: [project] });
    api.getStoryboard.mockResolvedValue({
      ...savedDraft,
      request: { ...request, instructions },
    });
    api.generateStoryboard.mockResolvedValue({
      generator: "llm",
      draft: savedDraft,
    });
    renderWizard("/product-library/video-wizard?project=project1");
    await screen.findByText("videoWizard.storyboardTitle");
    await user.click(
      screen.getByRole("button", { name: "videoWizard.previous" }),
    );
    await screen.findByText("videoWizard.requirementsTitle");
    // A free-text value from an older brief stays visible and selected.
    const legacy = screen.getByRole("checkbox", { name: "Original platform" });
    expect(legacy).toBeChecked();
    expect(
      screen.getByRole("combobox", { name: "videoWizard.targetDuration" }),
    ).toHaveValue("60");
    expect(
      screen.getByRole("combobox", { name: "videoWizard.style" }),
    ).toHaveValue("elegant");
    await user.click(legacy);
    await user.click(
      screen.getByRole("checkbox", { name: "videoWizard.platforms.douyin" }),
    );
    await user.click(
      screen.getByRole("button", { name: "videoWizard.generate" }),
    );
    await waitFor(() => expect(api.generateStoryboard).toHaveBeenCalled());
    const sentBrief = decodeVideoBrief(
      api.generateStoryboard.mock.calls[0][1].instructions,
    );
    expect(sentBrief.platform).toBe("videoWizard.platforms.douyin");
    expect(sentBrief.extra).toBe("Keep the package visible");
    expect(api.generateStoryboard.mock.calls[0][1].instructions).not.toContain(
      "Original platform",
    );
  }, 15000);

  it("follows the platform selection and warns when ratios conflict", async () => {
    const user = userEvent.setup();
    api.projects.mockResolvedValue({ items: [project] });
    api.getStoryboard.mockResolvedValue(savedDraft);
    renderWizard("/product-library/video-wizard?project=project1");
    await screen.findByText("videoWizard.storyboardTitle");
    await user.click(
      screen.getByRole("button", { name: "videoWizard.previous" }),
    );
    await screen.findByText("videoWizard.requirementsTitle");

    // A long-form platform alone switches the ratio to 16:9.
    await user.click(
      screen.getByRole("checkbox", { name: "videoWizard.platforms.bilibili" }),
    );
    expect(screen.getByRole("radio", { name: "16:9" })).toBeChecked();

    // Adding a vertical platform creates a conflict; the ratio is kept and a
    // note explains which platform wants which ratio.
    await user.click(
      screen.getByRole("checkbox", { name: "videoWizard.platforms.douyin" }),
    );
    expect(screen.getByRole("radio", { name: "16:9" })).toBeChecked();
    expect(screen.getByText("videoWizard.formatConflict")).toBeInTheDocument();
  }, 15000);

  it("blocks desktop confirmation until the standalone components are installed", async () => {
    api.projects.mockResolvedValue({ items: [project] });
    api.getStoryboard.mockResolvedValue(savedDraft);
    desktopJobs.bridgeAvailable = true;
    desktopJobs.environmentSupported = true;
    desktopJobs.environmentStatus = {
      state: "needs_setup",
      stage: "components",
      progress: null,
      requiresInstall: true,
    };
    renderWizard("/product-library/video-wizard?project=project1");
    await screen.findByText("videoWizard.storyboardTitle");
    expect(
      screen.getByText("videoWizard.environment.installTitle"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("videoWizard.environment.contactAdmin"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "videoWizard.confirmMake" }),
    ).toBeDisabled();
    expect(desktopJobs.start).not.toHaveBeenCalled();
    expect(api.saveStoryboard).not.toHaveBeenCalled();
  });

  it("uses a configured installer URL without opening or running it", async () => {
    api.projects.mockResolvedValue({ items: [project] });
    api.getStoryboard.mockResolvedValue(savedDraft);
    desktopJobs.bridgeAvailable = true;
    desktopJobs.environmentSupported = true;
    desktopJobs.environmentStatus = {
      state: "needs_setup",
      stage: "components",
      progress: null,
      requiresInstall: true,
    };
    desktopJobs.environmentInstallerURL =
      "https://downloads.example.invalid/video-components.exe";
    renderWizard("/product-library/video-wizard?project=project1");
    const installer = await screen.findByRole("link", {
      name: "videoWizard.environment.downloadComponents",
    });
    expect(installer).toHaveAttribute(
      "href",
      "https://downloads.example.invalid/video-components.exe",
    );
    expect(installer).toHaveAttribute("target", "_blank");
    expect(desktopJobs.start).not.toHaveBeenCalled();
  });

  it("keeps narration unavailable outside the desktop client", async () => {
    const user = userEvent.setup();
    api.projects.mockResolvedValue({ items: [project] });
    api.getStoryboard.mockResolvedValue(savedDraft);
    api.narrationOptions.mockResolvedValue({
      premium: true,
      modes: ["off", "local", "bundled"],
      voices: [{ id: "female-shaonv", label: "少女音" }],
    });
    renderWizard("/product-library/video-wizard?project=project1");
    await screen.findByText("videoWizard.storyboardTitle");
    await user.click(
      screen.getByRole("button", { name: "videoWizard.previous" }),
    );
    await screen.findByText("videoWizard.requirementsTitle");
    expect(
      screen.getByRole("checkbox", { name: "videoWizard.narration" }),
    ).toBeDisabled();
  });

  it("saves the narration choice and the picked premium voice", async () => {
    const user = userEvent.setup();
    api.projects.mockResolvedValue({ items: [project] });
    // The server keeps the audio settings when the picture is regenerated,
    // so a reload returns whatever was last saved.
    let stored: typeof savedDraft = { ...savedDraft };
    api.getStoryboard.mockImplementation(async () => stored);
    api.saveStoryboard.mockImplementation(async (_id, body) => {
      stored = { ...stored, ...body };
      return stored;
    });
    api.narrationOptions.mockResolvedValue({
      premium: true,
      modes: ["off", "local", "bundled"],
      voices: [{ id: "female-shaonv", label: "少女音" }],
    });
    desktopJobs.bridgeAvailable = true;
    renderWizard("/product-library/video-wizard?project=project1");
    await screen.findByText("videoWizard.storyboardTitle");
    await user.click(
      screen.getByRole("button", { name: "videoWizard.previous" }),
    );
    const toggle = await screen.findByRole("checkbox", {
      name: "videoWizard.narration",
    });
    // The toggle unlocks once the account's capabilities arrive.
    await waitFor(() =>
      expect(
        screen.getByRole("checkbox", { name: "videoWizard.narration" }),
      ).not.toBeDisabled(),
    );
    // Narration starts off; the user turns it on.
    await user.click(
      screen.getByRole("checkbox", { name: "videoWizard.narration" }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("checkbox", { name: "videoWizard.narration" }),
      ).toBeChecked(),
    );
    // A paid account may pick one of the server-side voices.
    await user.selectOptions(
      await screen.findByRole("combobox", { name: "videoWizard.narrationVoice" }),
      "female-shaonv",
    );
    // Regenerating the picture keeps the audio settings.
    api.generateStoryboard.mockImplementation(async () => {
      // A slow machine answers well after the click. The wizard must keep
      // the picture it just produced instead of reloading the whole page.
      await new Promise((resolve) => setTimeout(resolve, 400));
      const draft = {
        ...stored,
        narration_enabled: true,
        narration_voice: "female-shaonv",
      };
      stored = draft;
      return { generator: "llm", draft };
    });
    await user.click(
      screen.getByRole("button", { name: "videoWizard.generate" }),
    );
    await waitFor(() => expect(api.generateStoryboard).toHaveBeenCalled());
    // The confirm button stays disabled while the regeneration is in flight.
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "videoWizard.confirmMake" }),
      ).not.toBeDisabled(),
    );
    await user.click(
      screen.getByRole("button", { name: "videoWizard.confirmMake" }),
    );
    await waitFor(() => expect(api.saveStoryboard).toHaveBeenCalled());
    const body = api.saveStoryboard.mock.calls.at(-1)?.[1];
    expect(body.narration_enabled).toBe(true);
    expect(body.narration_voice).toBe("female-shaonv");
  });
});
