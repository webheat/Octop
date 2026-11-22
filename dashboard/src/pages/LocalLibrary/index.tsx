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
  isLocalLibraryAvailable,
  localLibrary,
  planLocal,
  type LocalAsset,
  type LocalPlanResult,
} from "../../api/localLibrary";

const { Text, Paragraph, Title } = Typography;

interface JobState {
  id: string;
  state: string;
  progress?: number | null;
  errorCode?: string;
}

const ACTIVE_STATES = new Set([
  "preparing",
  "downloading",
  "rendering",
  "starting",
]);

/**
 * Local-first material library (PRD §3.7). Material bytes stay on this machine;
 * the remote server is used only for AI recognition and stateless planning.
 * Rendered entirely from the local asset store — no server-side material
 * download at any point.
 */
export default function LocalLibraryPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const available = isLocalLibraryAvailable();

  const [assets, setAssets] = useState<LocalAsset[]>([]);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const [title, setTitle] = useState("");
  const [job, setJob] = useState<JobState | null>(null);
  const [plan, setPlan] = useState<LocalPlanResult | null>(null);
  const pollRef = useRef<number | null>(null);

  const load = useCallback(async () => {
    if (!available) return;
    try {
      const list = await localLibrary.list();
      setAssets(list);
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
      await load();
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code !== "CANCELLED") message.error(t("localLibrary.importFailed"));
    } finally {
      setImporting(false);
    }
  };

  const toggle = (id: string) => {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectedAssets = assets.filter((a) => selected.has(a.id));

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
      const name = title.trim() || t("localLibrary.defaultTitle");
      const result = await planLocal({
        product: {
          name,
          selling_points: selectedAssets
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

        <Card title={t("localLibrary.materials", { count: assets.length })}>
          {assets.length === 0 ? (
            <Empty description={t("localLibrary.empty")} />
          ) : (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
              {assets.map((asset) => (
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
                    {asset.mediaType.startsWith("image/") &&
                    previews[asset.id] ? (
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
              ))}
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
                  <Progress percent={jobPercent} status="active" />
                ) : null}
                {job.errorCode ? (
                  <Text type="danger">{job.errorCode}</Text>
                ) : null}
              </div>
            ) : null}
          </Space>
        </Card>
      </Space>
    </PageShell>
  );
}
