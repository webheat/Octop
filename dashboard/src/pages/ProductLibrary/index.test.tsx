import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import ProductLibraryPage from "./index";

type UploadFileItem = { uid: string; name: string };
type UploadProps = {
  accept?: string;
  beforeUpload?: (file: File) => boolean | void;
  fileList?: UploadFileItem[];
  onRemove?: (file: UploadFileItem) => void;
  children?: ReactNode;
};

const api = vi.hoisted(() => ({
  products: vi.fn(),
  projects: vi.fn(),
  assets: vi.fn(),
  upload: vi.fn(),
  createProduct: vi.fn(),
  deleteProject: vi.fn(),
  downloadAsset: vi.fn().mockResolvedValue(new Blob()),
}));
vi.mock("../../api/modules/productLibrary", async () => {
  const actual = await vi.importActual<typeof import("../../api/modules/productLibrary")>("../../api/modules/productLibrary");
  return { ...actual, productLibraryApi: { ...actual.productLibraryApi, ...api } };
});
vi.mock("../../api/request", () => ({ request: vi.fn().mockResolvedValue([]) }));
vi.mock("../../context/DesktopVideoJobsContext", () => ({ useDesktopVideoJobs: () => ({ bridgeAvailable: false }) }));
vi.mock("../../hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ id: 7 }) }));
vi.mock("../../layouts/PageShell", () => ({ default: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock("../../utils/antdMessage", () => ({ message: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
vi.mock("antd", async (importOriginal) => {
  const actual = await importOriginal<typeof import("antd")>();
  return {
    ...actual,
    Upload: ({ accept, beforeUpload, fileList = [], onRemove, children }: UploadProps) => (
      <div>
        <input
          aria-label="asset file picker"
          type="file"
          accept={accept}
          multiple
          onChange={(event) => {
            Array.from(event.currentTarget.files ?? []).forEach((file) => beforeUpload?.(file));
            event.currentTarget.value = "";
          }}
        />
        {fileList.map((file) => (
          <div key={file.uid}>
            <span>{file.name}</span>
            <button aria-label={`remove-${file.uid}`} onClick={() => onRemove?.(file)}>remove</button>
          </div>
        ))}
        {children}
      </div>
    ),
  };
});

const product = {
  id: "product-new",
  name: "New product",
  model: "",
  category: "",
  selling_points: [],
  parameters: {},
  expression_limits: "",
};
const imageAsset = {
  id: "image-1", product_id: product.id, filename: "photo.png", media_type: "image/png", byte_size: 10,
  usage: "scene" as const, priority: 0, active: 1, content_hash: "image",
};
const documentAsset = {
  id: "document-1", product_id: product.id, filename: "brief.pdf", media_type: "application/pdf", byte_size: 10,
  usage: "reference" as const, priority: 0, active: 1, content_hash: "doc",
};

function renderPage() {
  return render(<MemoryRouter><ProductLibraryPage /></MemoryRouter>);
}

describe("product library MVP", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.products.mockResolvedValue({ items: [] });
    api.projects.mockResolvedValue({ items: [] });
    api.assets.mockResolvedValue({ items: [] });
    api.createProduct.mockResolvedValue(product);
  });

  it("selects a newly created product, classifies by extension, retains failed files for retry, and removes same-name rows independently", async () => {
    const user = userEvent.setup();
    api.products.mockResolvedValueOnce({ items: [] }).mockResolvedValue({ items: [product] });
    api.upload.mockResolvedValueOnce({ items: [imageAsset] })
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce({ items: [documentAsset] });
    api.assets.mockResolvedValueOnce({ items: [] })
      .mockResolvedValueOnce({ items: [imageAsset] })
      .mockResolvedValue({ items: [imageAsset, documentAsset] });
    renderPage();

    await user.click(screen.getByRole("button", { name: "productLibrary.addProduct" }));
    await user.type(screen.getByPlaceholderText("productLibrary.name"), "New product");
    await user.click(screen.getByRole("button", { name: "OK" }));
    await screen.findByText("productLibrary.assets");
    await waitFor(() => expect(api.assets).toHaveBeenCalledWith(product.id));

    const duplicateOne = new File(["one"], "duplicate.pdf", { type: "" });
    const duplicateTwo = new File(["two"], "duplicate.pdf", { type: "" });
    const photo = new File(["image"], "photo.png", { type: "" });
    const document = new File(["document"], "brief.pdf", { type: "" });
    const picker = screen.getByLabelText("asset file picker") as HTMLInputElement;
    await user.upload(picker, [duplicateOne, duplicateTwo]);
    const duplicateRows = screen.getAllByText("duplicate.pdf");
    expect(duplicateRows).toHaveLength(2);
    const firstUid = duplicateRows[0].parentElement?.querySelector("button")?.getAttribute("aria-label");
    await user.click(screen.getByRole("button", { name: firstUid! }));
    expect(screen.getAllByText("duplicate.pdf")).toHaveLength(1);
    const remainingDuplicate = screen.getAllByText("duplicate.pdf")[0].parentElement?.querySelector("button")?.getAttribute("aria-label");
    await user.click(screen.getByRole("button", { name: remainingDuplicate! }));

    await user.upload(picker, [photo, document]);
    await user.click(screen.getByRole("button", { name: "productLibrary.upload" }));
    await waitFor(() => expect(api.upload).toHaveBeenCalledTimes(2));
    expect(api.upload.mock.calls[0][2]).toBe("scene");
    expect(api.upload.mock.calls[1][2]).toBe("reference");
    expect(screen.getByText("brief.pdf")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "productLibrary.upload" }));
    await waitFor(() => expect(api.upload).toHaveBeenCalledTimes(3));
    expect(api.upload.mock.calls[2][2]).toBe("reference");
  });

  it("deletes a project row only after the confirmation dialog is accepted", async () => {
    const user = userEvent.setup();
    const project = {
      id: "project-1",
      product_id: product.id,
      name: "Autumn launch",
      snapshot: { product, assets: [], version: 1 },
      created_at: 0,
    };
    api.products.mockResolvedValue({ items: [product] });
    api.projects.mockResolvedValue({ items: [project] });
    api.deleteProject.mockResolvedValue(undefined);
    renderPage();

    const continueButtons = await screen.findAllByRole("button", { name: "productLibrary.continueVideo" });
    expect(continueButtons).toHaveLength(1);
    expect(api.deleteProject).not.toHaveBeenCalled();

    const deleteButtons = screen.getAllByRole("button", { name: "productLibrary.delete" });
    await user.click(deleteButtons[deleteButtons.length - 1]);
    await user.click(await screen.findByRole("button", { name: "OK" }));

    await waitFor(() => expect(api.deleteProject).toHaveBeenCalledWith("project-1"));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "productLibrary.continueVideo" })).not.toBeInTheDocument(),
    );
  });
});
