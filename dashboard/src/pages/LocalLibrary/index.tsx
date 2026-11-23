import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Empty,
  Image,
  Input,
  Select,
  Space,
  Spin,
  Tag,
  Typography,
} from "antd";
import { ArrowLeft, FolderOpen, ImagePlus, RefreshCw } from "lucide-react";
import { useNavigate } from "react-router-dom";
import PageShell from "../../layouts/PageShell";
import { message } from "../../utils/antdMessage";
import {
  groupPlan,
  isLocalLibraryAvailable,
  localLibrary,
  type LocalAsset,
  type LocalProduct,
} from "../../api/localLibrary";

const { Text, Paragraph } = Typography;

interface ReviewGroup {
  key: string;
  name: string;
  category: string;
  itemIds: string[];
  allIds: string[];
  productId: string;
}

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
  const [importing, setImporting] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [grouping, setGrouping] = useState(false);
  const [review, setReview] = useState<ReviewGroup[]>([]);
  const [activeProduct, setActiveProduct] = useState<string>("__inbox__");
  const [recognitionErrors, setRecognitionErrors] = useState<
    Record<string, string>
  >({});
  const [batchIds, setBatchIds] = useState<string[] | null>(null);
  const [retrying, setRetrying] = useState(false);

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
      setRecognitionErrors(
        Object.fromEntries(
          list
            .filter((a) => a.recognitionError)
            .map((a) => [a.id, a.recognitionError!]),
        ),
      );
      return list;
    } catch {
      message.error(t("localLibrary.loadFailed"));
    }
  }, [available, t]);

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

  const buildReview = useCallback(
    async (source: LocalAsset[]) => {
      const unarchived = source.filter(
        (a) => !a.productId && !a.recognitionError && (a.category || a.group),
      );
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

  useEffect(() => {
    void load().then((list) => {
      if (list) void buildReview(list);
    });
  }, [load, buildReview]);

  const refresh = async () => {
    const list = await load();
    if (list && !review.length) await buildReview(list);
  };

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
      setBatchIds(imported.map((asset) => asset.id));
      setRecognitionErrors(
        Object.fromEntries(
          imported
            .filter((a) => a.recognitionError)
            .map((a) => [a.id, a.recognitionError!]),
        ),
      );
      message.success(t("localLibrary.imported", { count: imported.length }));
      const [list, prods] = await Promise.all([
        localLibrary.list(),
        localLibrary.listProducts(),
      ]);
      setAssets(list);
      setProducts(prods);
      if (!review.length) await buildReview(list);
      else message.info(t("localLibrary.regroupAfterRetry"));
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
      const list = await load();
      const filedIds = new Set(groups.flatMap((group) => group.itemIds));
      const firstFiled = list?.find(
        (asset) => filedIds.has(asset.id) && asset.productId,
      );
      if (firstFiled?.productId) setActiveProduct(firstFiled.productId);
      setSelected(new Set());
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
  const pendingIds = assets
    .filter(
      (a) =>
        a.mediaType.startsWith("image/") &&
        (!a.category || recognitionErrors[a.id]),
    )
    .map((a) => a.id);

  const selectProduct = async (productId: string) => {
    setActiveProduct(productId);
    setSelected(new Set());
  };

  const retryRecognition = async (ids: string[]) => {
    setRetrying(true);
    try {
      const results = await localLibrary.recognizeExisting(ids);
      setRecognitionErrors((current) => {
        const next = { ...current };
        for (const result of results) {
          if (result.recognitionError)
            next[result.id] = result.recognitionError;
          else delete next[result.id];
        }
        return next;
      });
      setBatchIds(results.map((asset) => asset.id));
      const list = await load();
      if (list && !review.length) await buildReview(list);
      else if (review.length) message.info(t("localLibrary.regroupAfterRetry"));
    } catch {
      message.error(t("localLibrary.recognitionFailed"));
    } finally {
      setRetrying(false);
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
      {!asset.mediaType.startsWith("image/") ? null : recognitionErrors[
          asset.id
        ] ? (
        <div>
          <Text type="danger">
            {t(`localLibrary.errors.${recognitionErrors[asset.id]}`, {
              defaultValue: t("localLibrary.recognitionFailed"),
            })}
          </Text>
          <Button
            size="small"
            loading={retrying}
            onClick={() => void retryRecognition([asset.id])}
          >
            {t("localLibrary.retry")}
          </Button>
        </div>
      ) : asset.category ? (
        <Text type="success">{t("localLibrary.recognitionDone")}</Text>
      ) : (
        <div>
          <Text type="secondary">{t("localLibrary.notRecognized")}</Text>{" "}
          <Button
            size="small"
            loading={retrying}
            onClick={() => void retryRecognition([asset.id])}
          >
            {t("localLibrary.retry")}
          </Button>
        </div>
      )}
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
          <Button icon={<RefreshCw size={14} />} onClick={() => void refresh()}>
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
        {batchIds !== null ? (
          <Alert
            type={
              batchIds.some((id) => recognitionErrors[id])
                ? "warning"
                : "success"
            }
            showIcon
            message={t("localLibrary.batchResult", {
              count: batchIds.length,
              failed: batchIds.filter((id) => recognitionErrors[id]).length,
            })}
          />
        ) : null}
        {pendingIds.length > 0 ? (
          <Alert
            type="warning"
            showIcon
            message={t("localLibrary.pending", { count: pendingIds.length })}
            action={
              <Button
                loading={retrying}
                onClick={() => void retryRecognition(pendingIds)}
              >
                {t("localLibrary.retryPending", { count: pendingIds.length })}
              </Button>
            }
          />
        ) : null}
        <Card
          title={t("localLibrary.reviewTitle")}
          extra={
            <Button
              loading={grouping}
              disabled={!assets.some((a) => !a.productId)}
              onClick={() => void buildReview(assets)}
            >
              {t("localLibrary.regroup")}
            </Button>
          }
        >
          {grouping ? (
            <Spin tip={t("localLibrary.grouping")} />
          ) : review.length === 0 ? (
            <Text type="secondary">
              {t(
                assets.length
                  ? "localLibrary.reviewEmptyExisting"
                  : "localLibrary.reviewEmpty",
              )}
            </Text>
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

        <Card
          title={t("localLibrary.products", { count: products.length })}
          extra={
            <Button
              type="primary"
              disabled={!selectedAssets.length}
              onClick={() =>
                navigate("/local-video-wizard", {
                  state: {
                    assetIds: selectedAssets.map((a) => a.id),
                    productId:
                      activeProduct === "__inbox__" ? undefined : activeProduct,
                  },
                })
              }
            >
              {t("localLibrary.makeVideo")}
            </Button>
          }
        >
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
            <Empty
              description={t(
                assets.length
                  ? "localLibrary.emptySelection"
                  : "localLibrary.empty",
              )}
            />
          ) : (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
              {visibleAssets.map(renderCard)}
            </div>
          )}
        </Card>
      </Space>
    </PageShell>
  );
}
