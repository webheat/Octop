import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Empty,
  Image,
  Input,
  Progress,
  Select,
  Space,
  Spin,
  Tag,
  Typography,
} from "antd";
import {
  ArrowLeft,
  FolderOpen,
  ImagePlus,
  RefreshCw,
  Video,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import PageShell from "../../layouts/PageShell";
import { message } from "../../utils/antdMessage";
import {
  groupPlan,
  isLocalLibraryAvailable,
  localLibrary,
  planLocal,
  type LocalAsset,
  type LocalPlanResult,
  type LocalProduct,
} from "../../api/localLibrary";

const { Text, Paragraph, Title } = Typography;

interface JobState {
  id: string;
  state: string;
  progress?: number | null;
  errorCode?: string;
  videoUrl?: string;
}

interface ReviewGroup {
  key: string;
  name: string;
  category: string;
  itemIds: string[];
  allIds: string[];
  productId: string;
}

const ACTIVE_STATES = new Set([
  "preparing",
  "downloading",
  "rendering",
  "starting",
]);

/**
 * Local-first material library (PRD §3.7). Material bytes stay on this machine;
 * the remote server is used only for AI recognition and stateless grouping/
 * planning. Full archive flow: ingest → AI grouping → review → archive into
 * local products → render from local assets, no server-side material download.
 */
export default function LocalLibraryPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const available = isLocalLibraryAvailable();

  const [assets, setAssets] = useState<LocalAsset[]>([]);
  const [products, setProducts] = useState<LocalProduct[]>([]);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [grouping, setGrouping] = useState(false);
  const [title, setTitle] = useState("");
  const [job, setJob] = useState<JobState | null>(null);
  const [plan, setPlan] = useState<LocalPlanResult | null>(null);
  const [review, setReview] = useState<ReviewGroup[]>([]);
  const [activeProduct, setActiveProduct] = useState<string>("__inbox__");
  const pollRef = useRef<number | null>(null);

  const assetById = useCallback(
    (id: string) => assets.find((a) => a.id === id),
    [assets],
  );

  const load = useCallback(async () => {
    if (!available) return;
    try {
      const [list, prods] = await Promise.all([
        localLibrary.list(),
        localLibrary.listProducts(),
      ]);
      setAssets(list);
      setProducts(prods);
    } catch {
      message.error(t("localLibrary.loadFailed"));
    }
  }, [available, t]);

  useEffect(() => {
    void load();
  }, [load]);

  // Load local preview data URLs for images (bytes never hit the server).
  useEffect(() => {
    let active = true;
    assets.forEach((asset) => {
      if (!asset.mediaType.startsWith("image/") || previews[asset.id]) return;
      void localLibrary.previewUrl(asset.id).then((url) => {
        if (active && url) setPreviews((cur) => ({ ...cur, [asset.id]: url }));
      });
    });
    return () => {
      active = false;
    };
  }, [assets, previews]);

  useEffect(() => {
    return () => {
      if (pollRef.current !== null) window.clearInterval(pollRef.current);
    };
  }, []);

  const startPolling = useCallback((id: string) => {
    if (pollRef.current !== null) window.clearInterval(pollRef.current);
    pollRef.current = window.setInterval(() => {
      void localLibrary
        .jobStatus(id)
        .then((state) => {
          setJob(state);
          if (!ACTIVE_STATES.has(state.state) && pollRef.current !== null) {
            window.clearInterval(pollRef.current);
            pollRef.current = null;
          }
        })
        .catch(() => undefined);
    }, 1200);
  }, []);

  const buildReview = useCallback(
    async (source: LocalAsset[]) => {
      const unarchived = source.filter((a) => !a.productId);
      if (!unarchived.length) {
        setReview([]);
        return;
      }
      setGrouping(true);
      try {
        const result = await groupPlan({
          items: unarchived.map((a) => ({
            id: a.id,
            filename: a.filename,
            group: a.group,
            category: a.category,
            description: a.description,
            tags: a.tags,
          })),
        });
        setReview(
          result.groups.map((g) => ({
            key: g.key,
            name: g.suggested_name,
            category: g.category,
            itemIds: g.items
              .map((i) => i.id)
              .filter((id): id is string => Boolean(id)),
            allIds: g.items
              .map((i) => i.id)
              .filter((id): id is string => Boolean(id)),
            productId: "",
          })),
        );
      } catch {
        message.error(t("localLibrary.groupFailed"));
      } finally {
        setGrouping(false);
      }
    },
    [t],
  );

  const importDirectory = async () => {
    setImporting(true);
    try {
      const picked = await localLibrary.pickDirectory();
      if (!picked.length) {
        message.info(t("localLibrary.noFiles"));
        return;
      }
      const imported = await localLibrary.ingest({
        paths: picked.map((p) => p.path),
        recognize: true,
        mode: "categorize",
      });
      message.success(t("localLibrary.imported", { count: imported.length }));
      const [list, prods] = await Promise.all([
        localLibrary.list(),
        localLibrary.listProducts(),
      ]);
      setAssets(list);
      setProducts(prods);
      await buildReview(list);
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code !== "CANCELLED") message.error(t("localLibrary.importFailed"));
    } finally {
      setImporting(false);
    }
  };

  const archive = async () => {
    const groups = review
      .map((g) => ({
        productId: g.productId || undefined,
        name: g.name.trim(),
        category: g.category,
        sellingPoints: g.itemIds
          .map((id) => assetById(id)?.description)
          .filter((d): d is string => Boolean(d))
          .slice(0, 5),
        itemIds: g.itemIds,
      }))
      .filter((g) => g.itemIds.length > 0 && (g.productId || g.name));
    if (!groups.length) {
      message.warning(t("localLibrary.archiveEmpty"));
      return;
    }
    setArchiving(true);
    try {
      const result = await localLibrary.archiveGroups(groups);
      message.success(
        t("localLibrary.archived", {
          products: result.createdProducts + result.reusedProducts,
          assets: result.filedAssets,
        }),
      );
      setReview([]);
      await load();
    } catch {
      message.error(t("localLibrary.archiveFailed"));
    } finally {
      setArchiving(false);
    }
  };

  const toggleReviewItem = (key: string, id: string) => {
    setReview((cur) =>
      cur.map((g) =>
        g.key === key
          ? {
              ...g,
              itemIds: g.itemIds.includes(id)
                ? g.itemIds.filter((x) => x !== id)
                : [...g.itemIds, id],
            }
          : g,
      ),
    );
  };

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const toggle = (id: string) => {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const visibleAssets =
    activeProduct === "__inbox__"
      ? assets.filter((a) => !a.productId)
      : assets.filter((a) => a.productId === activeProduct);
  const selectedAssets = visibleAssets.filter((a) => selected.has(a.id));

  const selectProduct = async (productId: string) => {
    setActiveProduct(productId);
    setSelected(new Set());
  };

  const generate = async () => {
    if (!selectedAssets.length) {
      message.warning(t("localLibrary.selectFirst"));
      return;
    }
    setBusy(true);
    setPlan(null);
    setJob(null);
    try {
      const projectId = `local-${Date.now()}`;
      const product = products.find((p) => p.id === activeProduct);
      const name =
        title.trim() || product?.name || t("localLibrary.defaultTitle");
      const result = await planLocal({
        product: {
          name,
          model: product?.model,
          category: product?.category,
          selling_points:
            product?.sellingPoints ??
            selectedAssets
              .map((a) => a.description)
              .filter((d): d is string => Boolean(d))
              .slice(0, 5),
        },
        assets: selectedAssets.map((a) => ({
          id: a.id,
          filename: a.filename,
          media_type: a.mediaType,
          usage: "scene",
          priority: 0,
        })),
        request: { format: "portrait", language: "zh", seconds_per_asset: 4 },
      });
      setPlan(result);
      const assetMap: Record<string, string> = {};
      for (const a of result.assets) assetMap[a.export_name] = a.id;
      const started = await localLibrary.renderLocal({
        projectId,
        title: name,
        script: result.script,
        assetMap,
      });
      setJob({ id: started.jobId, state: started.state });
      startPolling(started.jobId);
      message.success(t("localLibrary.renderStarted"));
    } catch {
      message.error(t("localLibrary.renderFailed"));
    } finally {
      setBusy(false);
    }
  };

  if (!available) {
    return (
      <PageShell
        title={t("localLibrary.title")}
        subtitle={t("localLibrary.subtitle")}
        actions={
          <Button
            icon={<ArrowLeft size={14} />}
            onClick={() => navigate("/product-library")}
          >
            {t("localLibrary.back")}
          </Button>
        }
      >
        <Alert
          type="info"
          showIcon
          message={t("localLibrary.desktopOnlyTitle")}
          description={t("localLibrary.desktopOnlyDesc")}
        />
      </PageShell>
    );
  }

  const jobPercent =
    job?.progress != null ? Math.round(job.progress * 100) : undefined;

  const renderCard = (asset: LocalAsset) => (
    <Card
      key={asset.id}
      size="small"
      style={{ width: 168 }}
      styles={{ body: { padding: 10 } }}
    >
      <Checkbox
        checked={selected.has(asset.id)}
        onChange={() => toggle(asset.id)}
        style={{ marginBottom: 8 }}
      >
        <Text ellipsis style={{ maxWidth: 120 }}>
          {asset.filename}
        </Text>
      </Checkbox>
      <div
        style={{
          height: 96,
          background: "#f4f4f6",
          borderRadius: 6,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
        }}
      >
        {asset.mediaType.startsWith("image/") && previews[asset.id] ? (
          <Image
            src={previews[asset.id]}
            alt={asset.filename}
            width="100%"
            height={96}
            style={{ objectFit: "cover" }}
            preview={false}
          />
        ) : (
          <ImagePlus size={28} color="#aaa" />
        )}
      </div>
      <div style={{ marginTop: 8 }}>
        {asset.group ? <Tag color="blue">{asset.group}</Tag> : null}
        {asset.category ? <Tag>{asset.category}</Tag> : null}
      </div>
      {asset.description ? (
        <Paragraph
          ellipsis={{ rows: 2 }}
          style={{ fontSize: 12, marginTop: 6, marginBottom: 0 }}
        >
          {asset.description}
        </Paragraph>
      ) : null}
    </Card>
  );

  return (
    <PageShell
      title={t("localLibrary.title")}
      subtitle={t("localLibrary.subtitle")}
      actions={
        <Space size={8}>
          <Button icon={<RefreshCw size={14} />} onClick={() => void load()}>
            {t("localLibrary.refresh")}
          </Button>
          <Button
            type="primary"
            icon={<FolderOpen size={14} />}
            loading={importing}
            onClick={() => void importDirectory()}
          >
            {t("localLibrary.importDir")}
          </Button>
        </Space>
      }
    >
      <Space direction="vertical" size={16} style={{ width: "100%" }}>
        <Alert
          type="success"
          showIcon
          message={t("localLibrary.privacyTitle")}
          description={t("localLibrary.privacyDesc")}
        />

        <Card title={t("localLibrary.reviewTitle")}>
          {grouping ? (
            <Spin tip={t("localLibrary.grouping")} />
          ) : review.length === 0 ? (
            <Empty
              description={t("localLibrary.reviewEmpty")}
              image={Empty.PRESENTED_IMAGE_SIMPLE}
            />
          ) : (
            <Space direction="vertical" size={12} style={{ width: "100%" }}>
              <Paragraph type="secondary" style={{ marginBottom: 0 }}>
                {t("localLibrary.reviewHint")}
              </Paragraph>
              {review.map((g) => (
                <Card
                  key={g.key}
                  size="small"
                  title={t("localLibrary.groupCardTitle", {
                    count: g.allIds.length,
                  })}
                >
                  <Space
                    direction="vertical"
                    size={8}
                    style={{ width: "100%" }}
                  >
                    <Space wrap>
                      <Text>{t("localLibrary.groupName")}</Text>
                      <Input
                        value={g.name}
                        onChange={(e) =>
                          setReview((cur) =>
                            cur.map((x) =>
                              x.key === g.key
                                ? { ...x, name: e.target.value }
                                : x,
                            ),
                          )
                        }
                        style={{ width: 220 }}
                        maxLength={80}
                      />
                      <Text>{t("localLibrary.reuseProduct")}</Text>
                      <Select
                        allowClear
                        placeholder={t("localLibrary.createNew")}
                        style={{ width: 200 }}
                        value={g.productId || undefined}
                        onChange={(value) =>
                          setReview((cur) =>
                            cur.map((x) =>
                              x.key === g.key
                                ? { ...x, productId: value ?? "" }
                                : x,
                            ),
                          )
                        }
                        options={products.map((p) => ({
                          value: p.id,
                          label: p.name,
                        }))}
                      />
                    </Space>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                      {g.allIds.map((id) => {
                        const asset = assetById(id);
                        if (!asset) return null;
                        return (
                          <Checkbox
                            key={id}
                            checked={g.itemIds.includes(id)}
                            onChange={() => toggleReviewItem(g.key, id)}
                          >
                            <Text ellipsis style={{ maxWidth: 140 }}>
                              {asset.filename}
                            </Text>
                          </Checkbox>
                        );
                      })}
                    </div>
                  </Space>
                </Card>
              ))}
              <div>
                <Button
                  type="primary"
                  loading={archiving}
                  onClick={() => void archive()}
                >
                  {t("localLibrary.archive")}
                </Button>
              </div>
            </Space>
          )}
        </Card>

        <Card title={t("localLibrary.products", { count: products.length })}>
          <Space wrap style={{ marginBottom: 12 }}>
            <Button
              type={activeProduct === "__inbox__" ? "default" : "text"}
              onClick={() => void selectProduct("__inbox__")}
            >
              {t("localLibrary.inbox", {
                count: assets.filter((a) => !a.productId).length,
              })}
            </Button>
            {products.map((p) => (
              <Button
                key={p.id}
                type={activeProduct === p.id ? "default" : "text"}
                onClick={() => void selectProduct(p.id)}
              >
                {p.name} ({p.assetCount})
              </Button>
            ))}
          </Space>
          {visibleAssets.length === 0 ? (
            <Empty description={t("localLibrary.empty")} />
          ) : (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
              {visibleAssets.map(renderCard)}
            </div>
          )}
        </Card>

        <Card title={t("localLibrary.renderTitle")}>
          <Space direction="vertical" size={12} style={{ width: "100%" }}>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("localLibrary.titlePlaceholder")}
              maxLength={60}
            />
            <div>
              <Button
                type="primary"
                icon={<Video size={14} />}
                loading={busy}
                disabled={!selectedAssets.length}
                onClick={() => void generate()}
              >
                {t("localLibrary.generate", { count: selectedAssets.length })}
              </Button>
              {busy ? <Spin style={{ marginLeft: 12 }} /> : null}
            </div>
            {plan ? (
              <Alert
                type="info"
                showIcon
                message={t("localLibrary.planReady", {
                  scenes: plan.script.scenes.length,
                  generator: plan.generator,
                })}
              />
            ) : null}
            {job ? (
              <div>
                <Title level={5}>
                  {t("localLibrary.jobState", {
                    state: t(`localLibrary.state.${job.state}`, {
                      defaultValue: job.state,
                    }),
                  })}
                </Title>
                {jobPercent !== undefined ? (
                  <Progress
                    percent={jobPercent}
                    status={job.state === "completed" ? "success" : "active"}
                  />
                ) : null}
                {job.errorCode ? (
                  <Text type="danger">{job.errorCode}</Text>
                ) : null}
                {job.state === "completed" && job.videoUrl ? (
                  <Space direction="vertical" style={{ marginTop: 12, width: "100%" }}>
                    <video
                      src={job.videoUrl}
                      controls
                      playsInline
                      style={{ width: "100%", maxWidth: 480, borderRadius: 8 }}
                    />
                    <a href={job.videoUrl} download="video.mp4">
                      {t("localLibrary.downloadVideo")}
                    </a>
                  </Space>
                ) : null}
              </div>
            ) : null}
          </Space>
        </Card>
      </Space>
    </PageShell>
  );
}
