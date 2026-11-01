import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  Card,
  Descriptions,
  Empty,
  Input,
  Modal,
  Select,
  Space,
  Tag,
  Typography,
  Upload,
} from "antd";
import {
  Archive,
  Download,
  FilePlus2,
  Package,
  Plus,
  Sparkles,
  Upload as UploadIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { request } from "../../api/request";
import {
  productLibraryApi,
  type Product,
  type ProductAsset,
  type ProductProject,
} from "../../api/modules/productLibrary";
import type { OctopAgent } from "../../context/AgentContext";
import { useDesktopVideoJobs } from "../../context/DesktopVideoJobsContext";
import PageShell from "../../layouts/PageShell";
import { message } from "../../utils/antdMessage";
import { useCurrentUser } from "../../hooks/useCurrentUser";

const blank: Omit<Product, "id"> = {
  name: "",
  model: "",
  category: "",
  selling_points: [],
  parameters: {},
  expression_limits: "",
};

function classifyUsage(file: File): ProductAsset["usage"] {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  return ["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif", "mp4", "webm", "mov", "m4v"].includes(extension)
    ? "scene"
    : "reference";
}

function isVideoMedia(mediaType: string) {
  return mediaType.startsWith("image/") || mediaType.startsWith("video/");
}

export default function ProductLibraryPage() {
  const { t } = useTranslation();
  const tRef = useRef(t);
  tRef.current = t;
  const navigate = useNavigate();
  const currentUser = useCurrentUser();
  const ownerId = currentUser?.id;
  const { bridgeAvailable: isDesktop } = useDesktopVideoJobs();
  const [products, setProducts] = useState<Product[]>([]);
  const [projects, setProjects] = useState<ProductProject[]>([]);
  const [active, setActive] = useState<Product | null>(null);
  const [assets, setAssets] = useState<ProductAsset[]>([]);
  const [assetLoadFailed, setAssetLoadFailed] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadRetry, setLoadRetry] = useState(0);
  const [assetRetry, setAssetRetry] = useState(0);
  const [form, setForm] = useState(blank);
  const [editing, setEditing] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [usage, setUsage] = useState<ProductAsset["usage"] | "auto">("auto");
  const [projectName, setProjectName] = useState("");
  const [agentId, setAgentId] = useState("");
  const [selectedAssets, setSelectedAssets] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");
  const [assetSearch, setAssetSearch] = useState("");
  const [assetKind, setAssetKind] = useState("all");
  const [parameterRows, setParameterRows] = useState<[string, string][]>([]);
  const [agents, setAgents] = useState<OctopAgent[]>([]);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const previewUrls = useRef<Record<string, string>>({});
  const fileIds = useRef(new WeakMap<File, string>());
  const nextFileId = useRef(0);
  const previewRequested = useRef(new Set<string>());
  const previewContextVersion = useRef(0);
  const reloadVersion = useRef(0);
  const previousOwnerId = useRef(ownerId);
  const currentOwnerId = useRef(ownerId);
  currentOwnerId.current = ownerId;
  const ownerVersion = useRef(0);
  const previewProductId = useRef<string | null>(null);
  const activeProductId = useRef<string | null>(null);
  const productSelectionVersion = useRef(0);
  const [previewBusy, setPreviewBusy] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadProgress, setUploadProgress] = useState("");
  const [projectBusy, setProjectBusy] = useState(false);
  const [preparingId, setPreparingId] = useState<string | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [deletingProjectId, setDeletingProjectId] = useState<string | null>(null);

  const selectProduct = (product: Product | null) => {
    if (activeProductId.current !== product?.id) {
      activeProductId.current = product?.id ?? null;
      productSelectionVersion.current += 1;
      previewContextVersion.current += 1;
      previewProductId.current = product?.id ?? null;
      setUploadBusy(false);
      setUploadProgress("");
      setProjectBusy(false);
    }
    setActive(product);
  };
  const fileUid = (file: File) => {
    let id = fileIds.current.get(file);
    if (!id) {
      id = `upload-${nextFileId.current++}`;
      fileIds.current.set(file, id);
    }
    return id;
  };

  const reload = async () => {
    const version = ++reloadVersion.current;
    const requestedOwner = ownerId;
    let p: Awaited<ReturnType<typeof productLibraryApi.products>>;
    let pr: Awaited<ReturnType<typeof productLibraryApi.projects>>;
    try {
      [p, pr] = await Promise.all([
        productLibraryApi.products(),
        productLibraryApi.projects(),
      ]);
    } catch (error) {
      if (version === reloadVersion.current) throw error;
      return;
    }
    if (version !== reloadVersion.current || requestedOwner !== currentOwnerId.current) return;
    setProducts(p.items);
    setProjects(pr.items);
    setLoadFailed(false);
    if (activeProductId.current) {
      selectProduct(p.items.find((x) => x.id === activeProductId.current) ?? null);
    }
  };
  useEffect(() => {
    if (previousOwnerId.current === ownerId) return;
    previousOwnerId.current = ownerId;
    ownerVersion.current += 1;
    reloadVersion.current += 1;
    productSelectionVersion.current += 1;
    selectProduct(null);
    setProducts([]);
    setProjects([]);
    setAssets([]);
    setSelectedAssets([]);
    setFiles([]);
    setLoadFailed(false);
    setAssetLoadFailed(false);
    setBusy(false);
    setSaving(false);
    setUploadBusy(false);
    setUploadProgress("");
    setProjectBusy(false);
    setForm(blank);
    setEditing(false);
  }, [ownerId]);
  useEffect(() => {
    const version = ownerVersion.current;
    void reload().catch(() => { if (version === ownerVersion.current) { setLoadFailed(true); message.error(t("productLibrary.failed")); } });
    void request<OctopAgent[]>("/agents?scope=all")
      .then((rows) =>
        version === ownerVersion.current && setAgents(rows.filter((a) => a.is_owner && a.state === "running")),
      )
      .catch(() => { if (version === ownerVersion.current) setAgents([]); });
  }, [ownerId, loadRetry]);
  useEffect(() => {
    setAssets([]);
    setSelectedAssets([]);
    setFiles([]);
    if (!active) {
      return;
    }
    let current = true;
    setFiles([]);
    void productLibraryApi
      .assets(active.id)
      .then((r) => {
        if (current) {
          setAssetLoadFailed(false);
          setAssets(r.items);
          setSelectedAssets(r.items.filter((a) => a.active && a.usage === "scene" && isVideoMedia(a.media_type)).map((a) => a.id));
        }
      })
      .catch(() => {
        if (current) setAssetLoadFailed(true);
      });
    return () => {
      current = false;
    };
  }, [active?.id, ownerId, assetRetry]);
  useEffect(() => {
    previewProductId.current = active?.id ?? null;
    setPreviews({});
    return () => {
      Object.values(previewUrls.current).forEach(URL.revokeObjectURL);
      previewUrls.current = {};
    };
  }, [active?.id, ownerId]);
  useEffect(() => {
    if (active) {
      setProjectName("");
      setAgentId("");
    }
  }, [active?.id]);
  const activeCount = useMemo(
    () => assets.filter((a) => a.active).length,
    [assets],
  );
  const visibleAssets = useMemo(
    () =>
      assets.filter((a) => {
        const typeMatches =
          assetKind === "all" ||
          (assetKind === "document"
            ? !a.media_type.startsWith("image/") &&
              !a.media_type.startsWith("video/")
            : a.media_type.startsWith(`${assetKind}/`));
        return (
          typeMatches &&
          a.filename.toLowerCase().includes(assetSearch.toLowerCase())
        );
      }),
    [assets, assetKind, assetSearch],
  );

  const openCreate = () => {
    setForm(blank);
    setParameterRows([]);
    setEditing(false);
    selectProduct(null);
    setBusy(true);
  };
  const openEdit = () => {
    if (!active) return;
    setForm({
      name: active.name,
      model: active.model,
      category: active.category,
      selling_points: active.selling_points,
      parameters: active.parameters,
      expression_limits: active.expression_limits,
    });
    setParameterRows(
      Object.entries(active.parameters).map(([k, v]) => [k, String(v)]),
    );
    setEditing(true);
    setBusy(true);
  };
  const saveProduct = async () => {
    if (!form.name.trim()) return;
    setSaving(true);
    const version = ownerVersion.current;
    try {
      const payload = {
        ...form,
        name: form.name.trim(),
        selling_points: form.selling_points
          .map((point) => point.trim())
          .filter(Boolean),
        parameters: Object.fromEntries(
          parameterRows
            .filter(([key]) => key.trim())
            .map(([key, value]) => [key.trim(), value]),
        ),
      };
      let savedProduct: Product | undefined;
      if (editing && active)
        savedProduct = await productLibraryApi.updateProduct(active.id, payload);
      else savedProduct = await productLibraryApi.createProduct(payload);
      if (version !== ownerVersion.current) return;
      setBusy(false);
      if (!editing && savedProduct) selectProduct(savedProduct);
      await reload();
      if (version !== ownerVersion.current) return;
      message.success(t("productLibrary.saved"));
    } catch {
      if (version === ownerVersion.current) message.error(t("productLibrary.failed"));
    } finally {
      if (version === ownerVersion.current) setSaving(false);
    }
  };
  const upload = async () => {
    if (!active || !files.length) return;
    const productId = active.id;
    const selectionVersion = productSelectionVersion.current;
    const accountVersion = ownerVersion.current;
    setUploadBusy(true);
    let succeeded = 0;
    const uploadedIds: string[] = [];
    const batch = [...files];
    const priorIds = new Set(assets.map((asset) => asset.id));
    setUploadProgress(t("productLibrary.uploadProgress", { done: 0, total: batch.length }));
    try {
    for (const [index, file] of batch.entries()) {
      if (activeProductId.current !== productId || productSelectionVersion.current !== selectionVersion) break;
      setUploadProgress(t("productLibrary.uploadProgress", { done: index, total: batch.length }));
      try {
        const inferredUsage = usage === "auto" ? classifyUsage(file) : usage;
        const result = await productLibraryApi.upload(productId, [file], inferredUsage);
        if (activeProductId.current !== productId || productSelectionVersion.current !== selectionVersion || ownerVersion.current !== accountVersion) break;
        uploadedIds.push(...result.items.filter((asset) => !priorIds.has(asset.id) && asset.active && asset.usage === "scene" && isVideoMedia(asset.media_type)).map((asset) => asset.id));
        succeeded += 1;
        setFiles((current) => current.filter((item) => item !== file));
      } catch {
        // Keep failed entries in the queue for an explicit retry.
      }
    }
    if (activeProductId.current === productId && productSelectionVersion.current === selectionVersion && ownerVersion.current === accountVersion) {
      try {
        const r = await productLibraryApi.assets(productId);
        if (activeProductId.current === productId && productSelectionVersion.current === selectionVersion && ownerVersion.current === accountVersion) {
          setAssets(r.items);
          const validIds = new Set(r.items.filter((asset) => asset.active && asset.usage === "scene" && isVideoMedia(asset.media_type)).map((asset) => asset.id));
          setSelectedAssets((current) => [...new Set([...current.filter((id) => validIds.has(id)), ...uploadedIds.filter((id) => validIds.has(id))])]);
        }
      } catch {
        if (ownerVersion.current === accountVersion && productSelectionVersion.current === selectionVersion) message.error(t("productLibrary.failed"));
      }
    }
    if (ownerVersion.current === accountVersion && activeProductId.current === productId && productSelectionVersion.current === selectionVersion) {
      if (succeeded) message.success(t("productLibrary.uploadedCount", { count: succeeded }));
      if (batch.length > succeeded) message.error(t("productLibrary.uploadFailedCount", { count: batch.length - succeeded }));
    }
    } finally {
      if (ownerVersion.current === accountVersion && productSelectionVersion.current === selectionVersion) {
        setUploadBusy(false);
        setUploadProgress("");
      }
    }
  };
  const createProject = async () => {
    if (!active || !projectName.trim()) return;
    const accountVersion = ownerVersion.current;
    const selectionVersion = productSelectionVersion.current;
    setProjectBusy(true);
    try {
      const p = await productLibraryApi.createProject({
        product_id: active.id,
        name: projectName,
        asset_ids: selectedAssets,
      });
      if (accountVersion !== ownerVersion.current || selectionVersion !== productSelectionVersion.current) return;
      setProjects((current) => [p, ...current]);
      setProjectName("");
      message.success(t("productLibrary.snapshotCreated"));
    } catch {
      if (accountVersion === ownerVersion.current && selectionVersion === productSelectionVersion.current) message.error(t("productLibrary.failed"));
    } finally {
      if (accountVersion === ownerVersion.current && selectionVersion === productSelectionVersion.current) setProjectBusy(false);
    }
  };
  const prepare = async (project: ProductProject) => {
    if (!agentId) return message.warning(t("productLibrary.agentRequired"));
    setPreparingId(project.id);
    try {
      const result = await productLibraryApi.prepareRender(project.id, agentId);
      message.success(
        `${t("productLibrary.prepared")}: ${result.workspace_path}`,
      );
    } catch {
      message.error(t("productLibrary.prepareFailed"));
    } finally {
      setPreparingId(null);
    }
  };
  const removeProject = async (project: ProductProject) => {
    setDeletingProjectId(project.id);
    try {
      await productLibraryApi.deleteProject(project.id);
      setProjects((current) => current.filter((item) => item.id !== project.id));
      message.success(t("productLibrary.projectDeleted"));
    } catch {
      message.error(t("productLibrary.projectDeleteFailed"));
    } finally {
      setDeletingProjectId(null);
    }
  };
  const downloadPackage = async (project: ProductProject) => {
    setDownloadingId(project.id);
    try {
      const blob = await productLibraryApi.downloadPackage(project.id);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `video-project-${project.id}.zip`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
      message.success(t("productLibrary.packageDownloaded"));
    } catch {
      message.error(t("productLibrary.packageFailed"));
    } finally {
      setDownloadingId(null);
    }
  };
  const previewAsset = useCallback(async (asset: ProductAsset) => {
    if (previewUrls.current[asset.id] || previewRequested.current.has(asset.id)) return;
    const productId = active?.id;
    const contextVersion = previewContextVersion.current;
    const requestedOwner = ownerId;
    previewRequested.current.add(asset.id);
    setPreviewBusy(asset.id);
    try {
      const blob = await productLibraryApi.downloadAsset(asset.id);
      const url = URL.createObjectURL(blob);
      if (previewContextVersion.current !== contextVersion || previewProductId.current !== productId || activeProductId.current !== productId || currentOwnerId.current !== requestedOwner) {
        URL.revokeObjectURL(url);
        return;
      }
      previewUrls.current[asset.id] = url;
      setPreviews((all) => ({ ...all, [asset.id]: url }));
    } catch {
      if (previewContextVersion.current === contextVersion) message.error(tRef.current("productLibrary.failed"));
    } finally {
      if (previewContextVersion.current === contextVersion) setPreviewBusy(null);
    }
  }, [active?.id, ownerId]);
  const retryPreview = (asset: ProductAsset) => {
    previewRequested.current.delete(asset.id);
    void previewAsset(asset);
  };
  useEffect(() => {
    previewContextVersion.current += 1;
    previewRequested.current.clear();
    Object.values(previewUrls.current).forEach(URL.revokeObjectURL);
    previewUrls.current = {};
    setPreviews({});
    return () => {
      previewContextVersion.current += 1;
      Object.values(previewUrls.current).forEach(URL.revokeObjectURL);
      previewUrls.current = {};
      previewRequested.current.clear();
    };
  }, [active?.id, ownerId]);
  useEffect(() => {
    let cancelled = false;
    const images = visibleAssets.filter((asset) => asset.media_type.startsWith("image/"));
    void (async () => {
      for (let i = 0; i < images.length; i += 2) {
        if (cancelled) return;
        await Promise.all(images.slice(i, i + 2).map((asset) => previewAsset(asset)));
      }
    })();
    return () => { cancelled = true; };
  }, [visibleAssets, previewAsset]);
  const availableSelected = assets.filter((a) => selectedAssets.includes(a.id) && a.active && a.usage === "scene" && isVideoMedia(a.media_type)).length;
  const openWizard = () => {
    if (!active) {
      navigate("/product-library/video-wizard");
      return;
    }
    const assetIds = selectedAssets.filter((id) => assets.some((a) => a.id === id && a.active && a.usage === "scene" && isVideoMedia(a.media_type)));
    navigate(`/product-library/video-wizard?product=${encodeURIComponent(active.id)}`, { state: { productId: active.id, assetIds, ownerId } });
  };

  return (
    <PageShell
      title={t("productLibrary.title")}
      subtitle={t("productLibrary.subtitle")}
      actions={
        <Button
          type="primary"
          icon={<Sparkles size={16} />}
          disabled={uploadBusy || Boolean(active && !availableSelected)}
          onClick={openWizard}
        >
          {t("productLibrary.makeVideo")}
        </Button>
      }
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns:
            "repeat(auto-fit, minmax(min(100%, 300px), 1fr))",
          gap: 20,
          alignItems: "start",
        }}
      >
        <Card
          title={t("productLibrary.products")}
          extra={
            <Button
              type="primary"
              icon={<Plus size={16} />}
              onClick={openCreate}
            >
              {t("productLibrary.addProduct")}
            </Button>
          }
        >
          <Input.Search
            placeholder={t("productLibrary.searchProducts")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ marginBottom: 12 }}
          />
          <Space direction="vertical" style={{ width: "100%" }}>
            {products.filter((p) =>
              `${p.name} ${p.model} ${p.category}`
                .toLowerCase()
                .includes(search.toLowerCase()),
            ).length ? (
              products
                .filter((p) =>
                  `${p.name} ${p.model} ${p.category}`
                    .toLowerCase()
                    .includes(search.toLowerCase()),
                )
                .map((p) => (
                  <Button
                    key={p.id}
                    block
                    type={active?.id === p.id ? "primary" : "default"}
                    onClick={() => selectProduct(p)}
                    style={{ height: "auto", textAlign: "left", padding: 12 }}
                  >
                    <div>
                      <strong>{p.name}</strong>
                      <div style={{ opacity: 0.65, fontSize: 12 }}>
                        {[p.model, p.category].filter(Boolean).join(" · ")}
                      </div>
                    </div>
                  </Button>
                ))
            ) : loadFailed ? (
              <Empty description={t("productLibrary.loadFailed")}>
                <Button onClick={() => setLoadRetry((value) => value + 1)}>{t("productLibrary.retry")}</Button>
              </Empty>
            ) : (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={t("productLibrary.noProducts")}
              />
            )}
          </Space>
        </Card>
        <div style={{ display: "grid", gap: 16 }}>
          {active ? (
            <>
              <Card
                title={
                  <Space>
                    <Package size={17} />
                    {active.name}
                    <Tag>
                      {active.category || t("productLibrary.uncategorized")}
                    </Tag>
                  </Space>
                }
                extra={
                  <Space>
                    <Button onClick={openEdit}>
                      {t("productLibrary.edit")}
                    </Button>
                    <Button
                      danger
                      onClick={() =>
                        Modal.confirm({
                          title: t("productLibrary.deleteConfirm"),
                          onOk: async () => {
                                const accountVersion = ownerVersion.current;
                                const selectionVersion = productSelectionVersion.current;
                            await productLibraryApi.deleteProduct(active.id);
                                if (accountVersion !== ownerVersion.current || selectionVersion !== productSelectionVersion.current) return;
                            selectProduct(null);
                            await reload();
                          },
                        })
                      }
                    >
                      {t("productLibrary.delete")}
                    </Button>
                  </Space>
                }
              >
                <Typography.Paragraph type="secondary">
                  {active.model}
                </Typography.Paragraph>
                {active.selling_points.length > 0 && (
                  <Typography.Paragraph>
                    {active.selling_points.join(" · ")}
                  </Typography.Paragraph>
                )}
                <Typography.Paragraph type="secondary">
                  {active.expression_limits || t("productLibrary.noLimits")}
                </Typography.Paragraph>
                {Object.keys(active.parameters).length > 0 && (
                  <Descriptions
                    size="small"
                    column={1}
                    items={Object.entries(active.parameters).map(
                      ([key, value]) => ({
                        key,
                        label: key,
                        children: String(value),
                      }),
                    )}
                  />
                )}
              </Card>
              <Card
                title={t("productLibrary.assets")}
                extra={<Space><Tag color="magenta">{activeCount}</Tag><Tag>{t("productLibrary.selectedCount", { count: availableSelected })}</Tag></Space>}
              >
                <Space wrap style={{ marginBottom: 12 }}>
                  <Upload
                    multiple
                    accept=".png,.jpg,.jpeg,.gif,.webp,.bmp,.avif,.mp4,.webm,.mov,.m4v,.pdf,.txt,.md,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.csv,.rtf"
                    beforeUpload={(file) => {
                      setFiles((all) => [...all, file]);
                      return false;
                    }}
                    fileList={files.map((f) => ({
                      uid: fileUid(f),
                      name: f.name,
                      status: "done" as const,
                    }))}
                    onRemove={(file) => {
                      setFiles((all) =>
                        all.filter((f) => fileUid(f) !== file.uid),
                      );
                      return true;
                    }}
                    disabled={uploadBusy}
                  >
                    <Button icon={<FilePlus2 size={16} />} disabled={uploadBusy}>
                      {t("productLibrary.chooseFiles")}
                    </Button>
                  </Upload>
                  <Select
                    value={usage}
                    onChange={setUsage}
                    disabled={uploadBusy}
                    options={[
                      { value: "auto", label: t("productLibrary.autoClassify") },
                      { value: "scene", label: t("productLibrary.scene") },
                      {
                        value: "reference",
                        label: t("productLibrary.reference"),
                      },
                      { value: "style", label: t("productLibrary.style") },
                    ]}
                  />
                  <Button
                    type="primary"
                    icon={<UploadIcon size={15} />}
                    onClick={() => void upload()}
                    disabled={!files.length}
                    loading={uploadBusy}
                  >
                    {t("productLibrary.upload")}
                  </Button>
                  {uploadProgress && <Typography.Text>{uploadProgress}</Typography.Text>}
                </Space>
                <Space wrap style={{ marginBottom: 12 }}>
                  <Button disabled={uploadBusy || !assets.some((a) => a.active && a.usage === "scene" && isVideoMedia(a.media_type))} onClick={() => setSelectedAssets((all) => [...new Set([...all, ...assets.filter((a) => a.active && a.usage === "scene" && isVideoMedia(a.media_type)).map((a) => a.id)])])}>{t("productLibrary.selectAvailable")}</Button>
                  <Button disabled={uploadBusy} onClick={() => setSelectedAssets([])}>{t("productLibrary.clearSelection")}</Button>
                  <Button type="primary" disabled={uploadBusy || !availableSelected} onClick={openWizard}>{t("productLibrary.makeVideoSelected", { count: availableSelected })}</Button>
                  {uploadBusy && <Typography.Text type="secondary">{t("productLibrary.waitForUpload")}</Typography.Text>}
                  {!uploadBusy && !availableSelected && <Typography.Text type="secondary">{t("productLibrary.noSelectedMedia")}</Typography.Text>}
                </Space>
                <Typography.Text type="secondary" style={{ display: "block", marginBottom: 12 }}>{t("productLibrary.supportedFormats")}</Typography.Text>
                <Space wrap style={{ display: "flex", marginBottom: 12 }}>
                  <Input.Search
                    placeholder={t("productLibrary.searchAssets")}
                    value={assetSearch}
                    onChange={(e) => setAssetSearch(e.target.value)}
                    style={{ maxWidth: 260 }}
                  />
                  <Select
                    value={assetKind}
                    onChange={setAssetKind}
                    options={[
                      { value: "all", label: t("productLibrary.allTypes") },
                      { value: "image", label: t("productLibrary.images") },
                      { value: "video", label: t("productLibrary.videos") },
                      {
                        value: "document",
                        label: t("productLibrary.documents"),
                      },
                    ]}
                  />
                </Space>
                {assetLoadFailed ? (
                  <Empty description={t("productLibrary.assetsFailed")}>
                    <Button onClick={() => setAssetRetry((value) => value + 1)}>{t("productLibrary.retry")}</Button>
                  </Empty>
                ) : visibleAssets.length ? (
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 260px), 1fr))", gap: 12 }}>
                    {visibleAssets.map((a) => (
                      <Card
                        size="small"
                        key={a.id}
                        style={{ marginBottom: 8 }}
                      >
                        {a.media_type.startsWith("image/") && previews[a.id] && <img src={previews[a.id]} alt={a.filename} style={{ width: "100%", height: 150, objectFit: "contain" }} />}
                        {a.media_type.startsWith("image/") && !previews[a.id] && <Button size="small" loading={previewBusy === a.id} onClick={() => retryPreview(a)}>{t("productLibrary.previewRetry")}</Button>}
                        {previews[a.id] && a.media_type.startsWith("video/") && (
                            <video
                              src={previews[a.id]}
                              controls
                              style={{ width: "100%", maxWidth: 260, maxHeight: 170 }}
                            />
                          )}
                        <input
                          aria-label={a.filename}
                          type="checkbox"
                          checked={selectedAssets.includes(a.id)}
                          disabled={!a.active || a.usage !== "scene" || !isVideoMedia(a.media_type)}
                          onChange={(e) =>
                            setSelectedAssets((all) =>
                              e.target.checked
                                ? [...all, a.id]
                                : all.filter((id) => id !== a.id),
                            )
                          }
                        />
                        <span style={{ flex: 1 }}>
                          {a.filename}{" "}
                          <Typography.Text type="secondary">
                            ({Math.ceil(a.byte_size / 1024)} KB)
                          </Typography.Text>
                        </span>
                        {a.media_type.startsWith("video/") && (
                          <Button
                            size="small"
                            loading={previewBusy === a.id}
                            onClick={() => retryPreview(a)}
                          >
                            {previews[a.id]
                              ? t("productLibrary.previewLoaded")
                              : t("productLibrary.preview")}
                          </Button>
                        )}
                        <Select
                          size="small"
                          value={a.usage}
                          style={{ width: 130 }}
                          onChange={async (v) => {
                            const accountVersion = ownerVersion.current;
                            const selectionVersion = productSelectionVersion.current;
                            await productLibraryApi.updateAsset(a.id, {
                              usage: v,
                            });
                            if (accountVersion !== ownerVersion.current || selectionVersion !== productSelectionVersion.current) return;
                            setAssets((all) =>
                              all.map((x) =>
                                x.id === a.id ? { ...x, usage: v } : x,
                              ),
                            );
                            if (v !== "scene")
                              setSelectedAssets((all) => all.filter((id) => id !== a.id));
                          }}
                          options={[
                            {
                              value: "scene",
                              label: t("productLibrary.scene"),
                            },
                            {
                              value: "reference",
                              label: t("productLibrary.reference"),
                            },
                            {
                              value: "style",
                              label: t("productLibrary.style"),
                            },
                          ]}
                        />
                        <Button
                          size="small"
                          onClick={async () => {
                            const accountVersion = ownerVersion.current;
                            const selectionVersion = productSelectionVersion.current;
                            const blob = await productLibraryApi.downloadAsset(
                              a.id,
                            );
                            if (accountVersion !== ownerVersion.current || selectionVersion !== productSelectionVersion.current) return;
                            const url = URL.createObjectURL(blob);
                            const link = document.createElement("a");
                            link.href = url;
                            link.download = a.filename;
                            link.click();
                            window.setTimeout(
                              () => URL.revokeObjectURL(url),
                              30_000,
                            );
                          }}
                        >
                          {t("productLibrary.download")}
                        </Button>
                        <Button
                          size="small"
                          type={a.priority ? "primary" : "default"}
                          onClick={async () => {
                            const accountVersion = ownerVersion.current;
                            const selectionVersion = productSelectionVersion.current;
                            const priority = !a.priority;
                            await productLibraryApi.updateAsset(a.id, {
                              priority,
                            });
                            if (accountVersion !== ownerVersion.current || selectionVersion !== productSelectionVersion.current) return;
                            setAssets((all) =>
                              all.map((x) =>
                                x.id === a.id
                                  ? { ...x, priority: Number(priority) }
                                  : x,
                              ),
                            );
                          }}
                        >
                          {a.priority
                            ? t("productLibrary.priority")
                            : t("productLibrary.setPriority")}
                        </Button>
                        <Button
                          size="small"
                          onClick={async () => {
                            const accountVersion = ownerVersion.current;
                            const selectionVersion = productSelectionVersion.current;
                            const activeFlag = !a.active;
                            await productLibraryApi.updateAsset(a.id, {
                              active: activeFlag,
                            });
                            if (accountVersion !== ownerVersion.current || selectionVersion !== productSelectionVersion.current) return;
                            setAssets((all) =>
                              all.map((x) =>
                                x.id === a.id
                                  ? { ...x, active: Number(activeFlag) }
                                  : x,
                              ),
                            );
                            if (!activeFlag)
                              setSelectedAssets((all) =>
                                all.filter((id) => id !== a.id),
                              );
                          }}
                        >
                          {a.active
                            ? t("productLibrary.disable")
                            : t("productLibrary.enable")}
                        </Button>
                      </Card>
                    ))}
                  </div>
                ) : (
                  <Empty
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description={
                      assets.length
                        ? t("productLibrary.noMatchingAssets")
                        : t("productLibrary.noAssets")
                    }
                  />
                )}
              </Card>
              <Card
                title={
                  <Space>
                    <Sparkles size={17} />
                    {t("productLibrary.videoProjects")}
                  </Space>
                }
              >
                <Space wrap style={{ marginBottom: 16 }}>
                  <Input
                    placeholder={t("productLibrary.projectName")}
                    value={projectName}
                    onChange={(e) => setProjectName(e.target.value)}
                    style={{ width: 220 }}
                  />
                  <Button
                    type="primary"
                    onClick={() => void createProject()}
                    loading={projectBusy}
                  >
                    {t("productLibrary.createSnapshot")}
                  </Button>
                </Space>
                <Typography.Text type="secondary">
                  {t("productLibrary.snapshotHint")}
                </Typography.Text>
              </Card>
            </>
          ) : (
            <Card>
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={t("productLibrary.selectProduct")}
              />
            </Card>
          )}
        </div>
        <Card
          title={
            <Space>
              <Archive size={17} />
              {t("productLibrary.allProjects")}
            </Space>
          }
          style={{ gridColumn: "1 / -1" }}
        >
          <Typography.Paragraph type="secondary">
            {t(
              isDesktop
                ? "videoWizard.startReadyHint"
                : "productLibrary.localWorkflow",
            )}
          </Typography.Paragraph>
          {projects.length ? (
            projects.map((p) => (
              <div
                key={p.id}
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 10,
                  alignItems: "center",
                  borderBottom: "1px solid #eee",
                  padding: "10px 0",
                }}
              >
                <Archive size={16} />
                <span style={{ flex: 1 }}>
                  {p.name} · {p.snapshot.product.name}{" "}
                  <Tag>
                    {t("productLibrary.version")}
                    {p.snapshot.version}
                  </Tag>{" "}
                  · {p.snapshot.assets.length} {t("productLibrary.assetsCount")}
                </span>
                <Button
                  type={isDesktop ? "primary" : "default"}
                  onClick={() =>
                    navigate(
                      `/product-library/video-wizard?project=${encodeURIComponent(
                        p.id,
                      )}`,
                    )
                  }
                >
                  {t("productLibrary.continueVideo")}
                </Button>
                {!isDesktop && (
                  <Button
                    type="primary"
                    icon={<Download size={16} />}
                    loading={downloadingId === p.id}
                    onClick={() => void downloadPackage(p)}
                  >
                    {t("productLibrary.downloadPackage")}
                  </Button>
                )}
                <details>
                  <summary style={{ cursor: "pointer" }}>
                    {t("productLibrary.advancedAgentSync")}
                  </summary>
                  <Space wrap style={{ marginTop: 8 }}>
                    <Select
                      showSearch
                      placeholder={t("productLibrary.selectAgent")}
                      value={agentId || undefined}
                      onChange={setAgentId}
                      style={{ width: 220 }}
                      options={agents.map((a) => ({
                        value: a.agent_id,
                        label: a.name,
                      }))}
                    />
                    <Button
                      loading={preparingId === p.id}
                      disabled={!agents.length}
                      onClick={() => void prepare(p)}
                    >
                      {t("productLibrary.prepareRender")}
                    </Button>
                  </Space>
                </details>
                <Button
                  danger
                  loading={deletingProjectId === p.id}
                  onClick={() =>
                    Modal.confirm({
                      title: t("productLibrary.deleteProjectConfirm"),
                      onOk: () => removeProject(p),
                    })
                  }
                >
                  {t("productLibrary.delete")}
                </Button>
              </div>
            ))
          ) : (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={t("productLibrary.noProjects")}
            />
          )}
        </Card>
      </div>
      <Modal
        open={busy}
        title={
          editing
            ? t("productLibrary.editProduct")
            : t("productLibrary.addProduct")
        }
        onCancel={() => setBusy(false)}
        onOk={() => void saveProduct()}
        confirmLoading={saving}
      >
        <Space direction="vertical" style={{ width: "100%" }}>
          <Input
            placeholder={t("productLibrary.name")}
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <Input
            placeholder={t("productLibrary.model")}
            value={form.model}
            onChange={(e) => setForm({ ...form, model: e.target.value })}
          />
          <Input
            placeholder={t("productLibrary.category")}
            value={form.category}
            onChange={(e) => setForm({ ...form, category: e.target.value })}
          />
          <Input.TextArea
            placeholder={t("productLibrary.sellingPoints")}
            value={form.selling_points.join("\n")}
            onChange={(e) =>
              setForm({
                ...form,
                selling_points: e.target.value.split("\n"),
              })
            }
            rows={3}
          />
          <Typography.Text strong>
            {t("productLibrary.parameters")}
          </Typography.Text>
          {parameterRows.map(([key, value], index) => (
            <Space key={index} style={{ display: "flex" }}>
              <Input
                placeholder={t("productLibrary.parameterName")}
                value={key}
                onChange={(e) =>
                  setParameterRows((rows) =>
                    rows.map<[string, string]>((row, i) =>
                      i === index ? [e.target.value, row[1]] : row,
                    ),
                  )
                }
              />
              <Input
                placeholder={t("productLibrary.parameterValue")}
                value={value}
                onChange={(e) =>
                  setParameterRows((rows) =>
                    rows.map<[string, string]>((row, i) =>
                      i === index ? [row[0], e.target.value] : row,
                    ),
                  )
                }
              />
              <Button
                danger
                onClick={() =>
                  setParameterRows((rows) => rows.filter((_, i) => i !== index))
                }
              >
                ×
              </Button>
            </Space>
          ))}
          <Button
            onClick={() => setParameterRows((rows) => [...rows, ["", ""]])}
          >
            {t("productLibrary.addParameter")}
          </Button>
          <Input.TextArea
            placeholder={t("productLibrary.expressionLimits")}
            value={form.expression_limits}
            onChange={(e) =>
              setForm({ ...form, expression_limits: e.target.value })
            }
            rows={2}
          />
        </Space>
      </Modal>
    </PageShell>
  );
}
