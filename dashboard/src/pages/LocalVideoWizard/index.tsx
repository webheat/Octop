import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Empty,
  Image,
  Input,
  InputNumber,
  Progress,
  Select,
  Space,
  Steps,
  Switch,
  Typography,
} from "antd";
import PageShell from "../../layouts/PageShell";
import VideoEnvironmentPage from "../VideoEnvironment";
import { useDesktopVideoJobs } from "../../context/DesktopVideoJobsContext";
import {
  isLocalLibraryAvailable,
  localLibrary,
  planLocal,
  type LocalAsset,
  type LocalPlanResult,
  type LocalProduct,
} from "../../api/localLibrary";

const activeStates = new Set([
  "preparing",
  "downloading",
  "rendering",
  "starting",
  "saving",
]);
type Job = {
  id: string;
  state: string;
  progress?: number | null;
  errorCode?: string;
  videoUrl?: string;
};
type Entry = { assetIds?: string[]; productId?: string };

export default function LocalVideoWizard() {
  const { t } = useTranslation();
  const desktopVideo = useDesktopVideoJobs();
  const navigate = useNavigate();
  const location = useLocation();
  const entry = (location.state || {}) as Entry;
  const [assets, setAssets] = useState<LocalAsset[]>([]);
  const [products, setProducts] = useState<LocalProduct[]>([]);
  const [productId, setProductId] = useState(entry.productId || "");
  const [selected, setSelected] = useState<string[]>(
    (entry.assetIds || []).slice(0, 200),
  );
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [title, setTitle] = useState("");
  const [format, setFormat] = useState<"portrait" | "landscape" | "square">(
    "portrait",
  );
  const [language, setLanguage] = useState<"zh" | "en">("zh");
  const [seconds, setSeconds] = useState(4);
  const [sellingPoints, setSellingPoints] = useState(true);
  const [instructions, setInstructions] = useState("");
  const [generator, setGenerator] = useState<"template" | "llm">("template");
  const [step, setStep] = useState(0);
  const [showEnvironment, setShowEnvironment] = useState(false);
  const [plan, setPlan] = useState<LocalPlanResult | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [environmentError, setEnvironmentError] = useState(false);
  const available = isLocalLibraryAvailable();
  const environmentReady =
    !desktopVideo.environmentSupported ||
    desktopVideo.environmentStatus.state === "ready";
  const product = products.find((p) => p.id === productId);
  const visible = assets.filter((a) =>
    productId ? a.productId === productId : !a.productId,
  );
  const chosen = visible.filter((a) => selected.includes(a.id));
  const name = (
    title.trim() ||
    product?.name ||
    t("localVideoWizard.defaultTitle")
  ).slice(0, 200);

  useEffect(() => {
    if (!available) return;
    let alive = true;
    Promise.all([localLibrary.list(), localLibrary.listProducts()])
      .then(([items, prods]) => {
        if (!alive) return;
        setAssets(items);
        setProducts(prods);
        const initialProduct =
          entry.productId ||
          items.find((a) => entry.assetIds?.includes(a.id))?.productId ||
          prods[0]?.id ||
          "";
        setProductId(initialProduct);
        if (!entry.assetIds?.length)
          setSelected(
            items
              .filter((a) =>
                initialProduct ? a.productId === initialProduct : !a.productId,
              )
              .map((a) => a.id)
              .slice(0, 200),
          );
      })
      .catch(() => {
        if (alive) setError(t("localVideoWizard.loadFailed"));
      });
    return () => {
      alive = false;
    };
    // Entry state is consumed only on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [available]);
  useEffect(() => {
    let alive = true;
    visible.forEach((a) => {
      if (a.mediaType.startsWith("image/") && !previews[a.id])
        void localLibrary.previewUrl(a.id).then((url) => {
          if (alive && url) setPreviews((old) => ({ ...old, [a.id]: url }));
        });
    });
    return () => {
      alive = false;
    };
  }, [assets, productId, previews]);
  useEffect(() => {
    if (!job || !activeStates.has(job.state)) return;
    const timer = window.setInterval(() => {
      void localLibrary
        .jobStatus(job.id)
        .then(setJob)
        .catch(() => setError(t("localVideoWizard.statusFailed")));
    }, 1200);
    return () => window.clearInterval(timer);
  }, [job?.id, job?.state, t]);

  useEffect(() => {
    if (
      step !== 3 ||
      !desktopVideo.environmentSupported ||
      desktopVideo.environmentStatus.state !== "unknown"
    )
      return;
    void desktopVideo.checkEnvironment().catch(() => {
      setError(t("localVideoWizard.environmentCheckFailed"));
      setEnvironmentError(true);
    });
  }, [
    step,
    desktopVideo.environmentSupported,
    desktopVideo.environmentStatus.state,
    desktopVideo.checkEnvironment,
    t,
  ]);

  const changeProduct = (id: string) => {
    setProductId(id);
    setSelected(
      assets
        .filter((a) => (id ? a.productId === id : !a.productId))
        .map((a) => a.id)
        .slice(0, 200),
    );
    setTitle("");
  };
  const generate = async () => {
    if (!chosen.length) {
      setError(t("localVideoWizard.selectFirst"));
      return;
    }
    setBusy(true);
    setError("");
    setEnvironmentError(false);
    try {
      const result = await planLocal({
        product: {
          name,
          model: product?.model,
          category: product?.category,
          selling_points: product?.sellingPoints,
        },
        assets: chosen.map((a) => ({
          id: a.id,
          filename: a.filename,
          media_type: a.mediaType,
          ...(generator === "llm"
            ? { description: a.description, tags: a.tags, category: a.category }
            : {}),
          usage: "scene",
          priority: 0,
        })),
        generator,
        request: {
          instructions,
          format,
          language,
          seconds_per_asset: seconds,
          include_selling_points: sellingPoints,
        },
      });
      setPlan(result);
      setStep(2);
    } catch (e) {
      setError(
        `${t("localVideoWizard.planFailed")} ${String(
          (e as Error)?.message || "",
        )}`,
      );
    } finally {
      setBusy(false);
    }
  };
  const render = async () => {
    if (!plan) return;
    setBusy(true);
    setError("");
    setEnvironmentError(false);
    try {
      const assetMap = Object.fromEntries(
        plan.assets.map((a) => [a.export_name, a.id]),
      );
      const result = await localLibrary.renderLocal({
        projectId: `local-${Date.now()}`,
        title: name,
        script: plan.script,
        assetMap,
      });
      setJob({ id: result.jobId, state: result.state });
      setStep(4);
    } catch (e) {
      const err = e as { code?: string; message?: string };
      setEnvironmentError(
        /RUNTIME_MISSING|BROWSER_MISSING|ENV_/.test(
          err.code || err.message || "",
        ),
      );
      setError(
        `${t("localVideoWizard.renderFailed")} ${
          err.code || err.message || ""
        }`,
      );
    } finally {
      setBusy(false);
    }
  };
  const setDuration = (index: number, value: number | null) => {
    if (!plan || value === null) return;
    setPlan({
      ...plan,
      script: {
        ...plan.script,
        scenes: plan.script.scenes.map((scene, i) =>
          i === index ? { ...scene, duration: value } : scene,
        ),
      },
    });
  };
  const envLink = (
    <Button type="link" onClick={() => setShowEnvironment(true)}>
      {t("localVideoWizard.environment")}
    </Button>
  );
  if (showEnvironment)
    return <VideoEnvironmentPage onReturn={() => setShowEnvironment(false)} />;
  return (
    <PageShell
      title={t("localVideoWizard.title")}
      subtitle={t("localVideoWizard.subtitle")}
    >
      {!available ? (
        <Alert type="warning" message={t("localVideoWizard.desktopOnly")} />
      ) : (
        <Space direction="vertical" size="large" style={{ width: "100%" }}>
          <Steps
            current={step}
            items={[
              "materials",
              "settings",
              "storyboard",
              "confirm",
              "result",
            ].map((key) => ({ title: t(`localVideoWizard.steps.${key}`) }))}
          />
          {error && (
            <Alert
              type="error"
              showIcon
              message={error}
              action={environmentError ? envLink : undefined}
              closable
              onClose={() => setError("")}
            />
          )}
          {step === 0 && (
            <Card title={t("localVideoWizard.steps.materials")}>
              <Space direction="vertical" style={{ width: "100%" }}>
                <Select
                  value={productId}
                  onChange={changeProduct}
                  style={{ width: 300 }}
                  options={[
                    ...products.map((p) => ({ value: p.id, label: p.name })),
                    { value: "", label: t("localVideoWizard.inbox") },
                  ]}
                />
                <Typography.Text type="secondary">
                  {t("localVideoWizard.selectionLimit")}
                </Typography.Text>
                {visible.length ? (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
                    {visible.map((a) => (
                      <Card key={a.id} size="small" style={{ width: 150 }}>
                        <Checkbox
                          aria-label={a.filename}
                          disabled={
                            !selected.includes(a.id) && selected.length >= 200
                          }
                          checked={selected.includes(a.id)}
                          onChange={(e) =>
                            setSelected((old) =>
                              e.target.checked
                                ? [...old, a.id]
                                : old.filter((id) => id !== a.id),
                            )
                          }
                        />
                        {previews[a.id] && (
                          <Image
                            src={previews[a.id]}
                            alt={a.filename}
                            height={90}
                            style={{ objectFit: "contain" }}
                          />
                        )}
                        <Typography.Paragraph
                          ellipsis={{ rows: 2 }}
                          title={a.filename}
                        >
                          {a.filename}
                        </Typography.Paragraph>
                      </Card>
                    ))}
                  </div>
                ) : (
                  <Empty description={t("localVideoWizard.noMaterials")} />
                )}
                <Button onClick={() => navigate("/local-library")}>
                  {t("localVideoWizard.library")}
                </Button>
                <Button
                  type="primary"
                  disabled={!chosen.length}
                  onClick={() => {
                    setError("");
                    setStep(1);
                  }}
                >
                  {t("localVideoWizard.next")}
                </Button>
              </Space>
            </Card>
          )}
          {step === 1 && (
            <Card title={t("localVideoWizard.steps.settings")}>
              <Space direction="vertical" style={{ width: "100%" }}>
                <label>
                  {t("localVideoWizard.videoTitle")}
                  <Input
                    value={title}
                    maxLength={200}
                    placeholder={
                      product?.name || t("localVideoWizard.defaultTitle")
                    }
                    onChange={(e) => setTitle(e.target.value)}
                  />
                </label>
                <label>
                  {t("localVideoWizard.format")}{" "}
                  <Select
                    value={format}
                    onChange={setFormat}
                    options={["portrait", "landscape", "square"].map((v) => ({
                      value: v,
                      label: t(`localVideoWizard.formats.${v}`),
                    }))}
                  />
                </label>
                <label>
                  {t("localVideoWizard.generator")}{" "}
                  <Select
                    value={generator}
                    onChange={setGenerator}
                    options={[
                      {
                        value: "template",
                        label: t("localVideoWizard.template"),
                      },
                      { value: "llm", label: t("localVideoWizard.ai") },
                    ]}
                  />
                </label>
                {generator === "llm" && (
                  <Typography.Text type="secondary">
                    {t("localVideoWizard.aiHint")}
                  </Typography.Text>
                )}
                {generator === "llm" && (
                  <label>
                    {t("localVideoWizard.language")}{" "}
                    <Select
                      value={language}
                      onChange={setLanguage}
                      options={[
                        { value: "zh", label: "中文" },
                        { value: "en", label: "English" },
                      ]}
                    />
                  </label>
                )}
                <label>
                  {t("localVideoWizard.seconds")}{" "}
                  <InputNumber
                    min={1}
                    max={15}
                    value={seconds}
                    onChange={(v) => setSeconds(v ?? 4)}
                  />
                </label>
                <label>
                  {t("localVideoWizard.sellingPoints")}{" "}
                  <Switch checked={sellingPoints} onChange={setSellingPoints} />
                </label>
                {generator === "llm" && (
                  <label>
                    {t("localVideoWizard.instructions")}
                    <Input.TextArea
                      value={instructions}
                      maxLength={3000}
                      onChange={(e) => setInstructions(e.target.value)}
                    />
                  </label>
                )}
                <Space>
                  <Button onClick={() => setStep(0)}>
                    {t("localVideoWizard.back")}
                  </Button>
                  <Button
                    type="primary"
                    loading={busy}
                    onClick={() => void generate()}
                  >
                    {t("localVideoWizard.generate")}
                  </Button>
                </Space>
              </Space>
            </Card>
          )}
          {step === 2 && plan && (
            <Card title={t("localVideoWizard.steps.storyboard")}>
              <Space direction="vertical" style={{ width: "100%" }}>
                <Typography.Text>
                  {t("localVideoWizard.storyboardHint")}
                </Typography.Text>
                {plan.script.scenes.map((scene, i) => {
                  const assetId = plan.assets.find(
                    (asset) => asset.export_name === scene.asset,
                  )?.id;
                  const asset = assets.find((item) => item.id === assetId);
                  const type = [
                    "title",
                    "bullets",
                    "image",
                    "video",
                    "endcard",
                  ].includes(scene.type)
                    ? scene.type
                    : "other";
                  return (
                    <Card
                      key={scene.id}
                      size="small"
                      title={`${i + 1}. ${t(
                        `localVideoWizard.sceneTypes.${type}`,
                      )}`}
                    >
                      <Space direction="vertical">
                        {asset && (
                          <Space>
                            {previews[asset.id] && (
                              <Image
                                src={previews[asset.id]}
                                alt={asset.filename}
                                height={80}
                              />
                            )}
                            <Typography.Text>{asset.filename}</Typography.Text>
                          </Space>
                        )}
                        {typeof scene.text === "string" && (
                          <Typography.Text>{scene.text}</Typography.Text>
                        )}
                        {typeof scene.subtitle === "string" &&
                          scene.subtitle && (
                            <Typography.Text>{scene.subtitle}</Typography.Text>
                          )}
                        {Array.isArray(scene.bullets) && (
                          <ul>
                            {scene.bullets.map((bullet, index) => (
                              <li key={index}>{String(bullet)}</li>
                            ))}
                          </ul>
                        )}
                        <Space>
                          <span>{t("localVideoWizard.sceneDuration")}</span>
                          <InputNumber
                            min={0.25}
                            max={15}
                            step={0.25}
                            value={scene.duration}
                            onChange={(v) => setDuration(i, v)}
                          />
                        </Space>
                      </Space>
                    </Card>
                  );
                })}
                <Space>
                  <Button onClick={() => setStep(1)}>
                    {t("localVideoWizard.back")}
                  </Button>
                  <Button type="primary" onClick={() => setStep(3)}>
                    {t("localVideoWizard.next")}
                  </Button>
                </Space>
              </Space>
            </Card>
          )}
          {step === 3 && plan && (
            <Card title={t("localVideoWizard.steps.confirm")}>
              <Space direction="vertical">
                <Typography.Text>
                  {name} · {plan.script.width} × {plan.script.height} ·{" "}
                  {t("localVideoWizard.sceneCount", {
                    count: plan.script.scenes.length,
                  })}
                </Typography.Text>
                <Typography.Text>
                  {t("localVideoWizard.localRender")}
                </Typography.Text>
                {environmentReady && envLink}
                {!environmentReady && (
                  <Alert
                    type="warning"
                    message={t("localVideoWizard.environmentNotReady")}
                    action={envLink}
                  />
                )}
                <Space>
                  <Button onClick={() => setStep(2)}>
                    {t("localVideoWizard.back")}
                  </Button>
                  <Button
                    type="primary"
                    loading={busy}
                    disabled={!environmentReady}
                    onClick={() => void render()}
                  >
                    {t("localVideoWizard.render")}
                  </Button>
                </Space>
              </Space>
            </Card>
          )}
          {step === 4 && job && (
            <Card title={t("localVideoWizard.steps.result")}>
              <Space direction="vertical" style={{ width: "100%" }}>
                <Typography.Text>
                  {t("localVideoWizard.jobState", {
                    state: t(`localLibrary.state.${job.state}`, {
                      defaultValue: job.state,
                    }),
                  })}
                </Typography.Text>
                {job.progress != null && (
                  <Progress percent={Math.round(job.progress * 100)} />
                )}
                {job.errorCode && (
                  <Alert
                    type="error"
                    message={`${t("localVideoWizard.renderFailed")} ${
                      job.errorCode
                    }`}
                    action={
                      /RUNTIME_MISSING|BROWSER_MISSING|ENV_/.test(job.errorCode)
                        ? envLink
                        : undefined
                    }
                  />
                )}
                {job.videoUrl && (
                  <>
                    <video
                      controls
                      src={job.videoUrl}
                      style={{ maxWidth: "100%", maxHeight: 480 }}
                    />
                    <a href={job.videoUrl} download>
                      {t("localVideoWizard.download")}
                    </a>
                  </>
                )}
                {!activeStates.has(job.state) && (
                  <Button onClick={() => setStep(3)}>
                    {t("localVideoWizard.back")}
                  </Button>
                )}
              </Space>
            </Card>
          )}
        </Space>
      )}
    </PageShell>
  );
}
