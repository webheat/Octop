import {
  Alert,
  Button,
  Card,
  InputNumber,
  Progress,
  Select,
  Space,
  Spin,
  Tag,
  Typography,
} from "antd";
import {
  ArrowRight,
  CheckCircle2,
  Circle,
  Download,
  Image as ImageIcon,
  LoaderCircle,
  Play,
  RefreshCw,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ProductSnapshotAsset } from "../../api/modules/productLibrary";
import {
  isActiveDesktopVideoJob,
  type DesktopVideoJob,
  type DesktopVideoEnvironmentStatus,
} from "../../context/DesktopVideoJobsContext";
import { useTranslation } from "react-i18next";
import styles from "./index.module.less";
import outputStyles from "./OutputStage.module.less";
import {
  PLATFORM_KEYS,
  PLATFORM_RENDER_PROFILES,
  RENDER_PROFILE_SIZES,
  platformKeyForLabel,
} from "./platforms";

function nativeStage(job: DesktopVideoJob) {
  return job.state === "downloading" ? "preparing" : job.state;
}

interface OutputStageProps {
  isDesktop: boolean;
  desktopJob: DesktopVideoJob | undefined;
  coverAsset: ProductSnapshotAsset | undefined;
  imageUrls: Record<string, string>;
  nativeBusy: boolean;
  nativeSaving: boolean;
  environmentReady: boolean;
  backToLibrary: () => void;
  startNativeJob: () => Promise<void>;
  cancelNativeJob: () => Promise<void>;
  saveNativeVideo: () => Promise<void>;
  retryNativeJob: () => Promise<void>;
  selectedPlatforms?: string[];
  outputLanguage?: string;
  startBatch?: (targets: RenderTarget[]) => Promise<void>;
  batchTargets?: RenderTargetStatus[];
  downloadStudioPackage?: () => Promise<void>;
  saveBatch?: () => Promise<void>;
}

export interface RenderTarget {
  id: string;
  platform: string;
  profile: "short_vertical" | "landscape" | "square" | "custom";
  width: number;
  height: number;
  fps: number;
  language: string;
  safeArea: "standard";
  filename: string;
}

export interface RenderTargetStatus extends RenderTarget {
  status: "queued" | "preparing" | "rendering" | "completed" | "failed";
  progress?: number | null;
  error?: string;
}

const targetProfiles = RENDER_PROFILE_SIZES;

const outputWords = {
  zh: {
    title: "多平台输出",
    intro: "每个版式都会使用独立的 Remotion 画布尺寸渲染。相同平台可选择多个版式。",
    selectAll: "选择平台",
    addVariant: "添加版式",
    vertical: "竖屏 9:16",
    landscape: "横屏 16:9",
    square: "方形 1:1",
    custom: "自定义尺寸",
    width: "宽",
    height: "高",
    language: "语言",
    safe: "字幕边距沿用模板默认值（左右约 8%，上下约 2%）；尚无平台专属安全区覆盖。",
    run: "批量渲染所选版本",
    save: "保存已完成成片",
    studio: "下载 Remotion Studio ZIP",
    unavailable: "当前运行环境无法本地渲染，可下载 Studio ZIP 后在 Remotion Studio 中渲染。",
    unsupportedAudio: "配音仅支持当前项目语言；多语言配音和配乐授权尚未提供。",
    failed: "失败",
    completed: "已完成",
    running: "渲染中",
    queued: "排队中",
  },
  en: {
    title: "Multi-platform output",
    intro: "Each format renders with its own Remotion canvas size. Add more than one format per platform.",
    selectAll: "Select platforms",
    addVariant: "Add format",
    vertical: "Vertical 9:16",
    landscape: "Landscape 16:9",
    square: "Square 1:1",
    custom: "Custom size",
    width: "Width",
    height: "Height",
    language: "Language",
    safe: "Captions use template margins (about 8% sides, 2% top and bottom); platform-specific safe-area overrides are not available yet.",
    run: "Render selected versions",
    save: "Save completed outputs",
    studio: "Download Remotion Studio ZIP",
    unavailable: "Local rendering is unavailable. Download the Studio ZIP to render in Remotion Studio.",
    unsupportedAudio: "Narration uses the project language. Multilingual narration and music licensing are not supported yet.",
    failed: "Failed",
    completed: "Completed",
    running: "Rendering",
    queued: "Queued",
  },
} as const;

function MultiPlatformOutput({
  selectedPlatforms = [],
  outputLanguage = "zh",
  startBatch,
  batchTargets = [],
  downloadStudioPackage,
  saveBatch,
  busy,
}: Pick<OutputStageProps, "selectedPlatforms" | "outputLanguage" | "startBatch" | "batchTargets" | "downloadStudioPackage" | "saveBatch"> & { busy: boolean }) {
  const { i18n, t } = useTranslation();
  const words = outputWords[i18n.resolvedLanguage?.startsWith("zh") ? "zh" : "en"];
  const platformKeys = [...PLATFORM_KEYS, "custom"] as const;
  const platformOptions = useMemo(() => platformKeys.map((key) => ({ key, label: key === "custom" ? words.custom : t(`videoWizard.platforms.${key}`) })), [t, words.custom]);
  const [variants, setVariants] = useState<Array<{ id: string; platform: string; profile: RenderTarget["profile"]; width: number; height: number }>>([]);
  const [selected, setSelected] = useState<string[]>(selectedPlatforms);
  const custom = { width: 1080, height: 1920 };
  // The brief stores translated platform labels ("抖音"), so a label has to be
  // resolved back to its key before the default profile can be looked up.
  const platformLabels = useMemo(() => Object.fromEntries(PLATFORM_KEYS.map((key) => [key, t(`videoWizard.platforms.${key}`)])) as Record<(typeof PLATFORM_KEYS)[number], string>, [t]);
  const selectedKeys = useMemo(() => {
    const resolved = selectedPlatforms
      .map((label) => platformKeyForLabel(label, platformLabels))
      .filter((key): key is (typeof PLATFORM_KEYS)[number] => key !== null);
    // "custom" is not a real platform key; it carries its own entry below.
    return resolved.length > 0
      ? resolved
      : (selectedPlatforms.filter((label) => label === words.custom) as unknown as (typeof PLATFORM_KEYS)[number][]);
  }, [selectedPlatforms.join("|"), platformLabels, words.custom]);
  useEffect(() => {
    setSelected(selectedPlatforms);
    setVariants((current) => {
      const kept = current.filter((variant) => selectedKeys.includes(variant.platform as (typeof PLATFORM_KEYS)[number]) || variant.platform === "custom");
      const existing = new Set(kept.map((variant) => variant.platform));
      const additions = selectedKeys.filter((key) => !existing.has(key)).map((key) => {
        // Each platform gets its own default profile — a YouTube deliverable
        // must not silently render as a 1080x1920 vertical clip.
        const profile = PLATFORM_RENDER_PROFILES[key];
        const dimensions = profile === "custom" ? custom : targetProfiles[profile];
        return { id: `${key}-${profile}`, platform: key, profile, ...dimensions };
      });
      const customAddition = selectedPlatforms.includes(words.custom) && !existing.has("custom")
        ? [{ id: "custom-custom", platform: "custom", profile: "custom" as const, ...custom }]
        : [];
      return [...kept, ...additions, ...customAddition];
    });
  }, [selectedKeys.join("|"), selectedPlatforms.join("|"), words.custom]);
  const available = platformOptions.filter(({ label }) => selected.includes(label));
  const addVariant = (platform: string, profile?: RenderTarget["profile"]) => {
    // A newly added variant follows the platform's own default unless the user
    // picks a format explicitly.
    const resolved = profile ?? (platform === "custom"
      ? "custom"
      : PLATFORM_RENDER_PROFILES[platform as keyof typeof PLATFORM_RENDER_PROFILES] ?? "short_vertical");
    const size = resolved === "custom" ? custom : targetProfiles[resolved as keyof typeof targetProfiles];
    const dimensions = size ?? custom;
    setVariants((current) => [...current, { id: `${platform}-${resolved}-${Date.now()}-${current.length}`, platform, profile: resolved, width: dimensions.width, height: dimensions.height }]);
  };
  const runBatch = async () => {
    if (!startBatch || variants.length === 0) return;
    await startBatch(variants.map((variant, index) => ({
      ...variant,
      fps: 30,
      language: outputLanguage,
      safeArea: "standard",
      filename: `${variant.platform}-${variant.profile}-${index + 1}-${variant.width}x${variant.height}.mp4`,
    })));
  };

  return (
    <Card title={words.title} className={outputStyles.outputBatchCard}>
      <Space direction="vertical" size="middle" style={{ width: "100%" }}>
        <Typography.Text type="secondary">{words.intro}</Typography.Text>
        <Select
          mode="multiple"
          aria-label={words.selectAll}
          placeholder={words.selectAll}
          value={selected}
          options={platformOptions.map(({ label }) => ({ label, value: label }))}
          onChange={(value: string[]) => setSelected(value)}
        />
        <Space wrap>
          {available.map(({ key, label }) => (
            <Select
              key={key}
              aria-label={`${label} ${words.addVariant}`}
              placeholder={`${label} · ${words.addVariant}`}
              style={{ minWidth: 190 }}
              value={null}
              options={[
                { value: "short_vertical", label: words.vertical },
                { value: "landscape", label: words.landscape },
                { value: "square", label: words.square },
                { value: "custom", label: words.custom },
              ]}
              onChange={(profile: RenderTarget["profile"]) => addVariant(key, profile)}
            />
          ))}
        </Space>
        {variants.map((variant, index) => (
          <Space key={variant.id} wrap>
            <Tag>{platformOptions.find(({ key }) => key === variant.platform)?.label ?? variant.platform}</Tag>
            <Select
              aria-label={`${variant.platform} output format`}
              value={variant.profile}
              options={[
                { value: "short_vertical", label: words.vertical },
                { value: "landscape", label: words.landscape },
                { value: "square", label: words.square },
                { value: "custom", label: words.custom },
              ]}
              onChange={(profile: RenderTarget["profile"]) => {
                const dimensions = profile === "custom" ? custom : targetProfiles[profile as keyof typeof targetProfiles];
                setVariants((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, profile, width: dimensions.width, height: dimensions.height } : item));
              }}
            />
            {variant.profile === "custom" ? (
              <>
                <InputNumber aria-label={words.width} min={2} max={4096} step={2} value={variant.width} onChange={(value) => setVariants((current) => current.map((item) => item.id === variant.id ? { ...item, width: value ?? item.width } : item))} />
                <InputNumber aria-label={words.height} min={2} max={4096} step={2} value={variant.height} onChange={(value) => setVariants((current) => current.map((item) => item.id === variant.id ? { ...item, height: value ?? item.height } : item))} />
              </>
            ) : <Tag>{variant.width} × {variant.height} · 30 fps</Tag>}
            <Button type="text" danger onClick={() => setVariants((current) => current.filter((item) => item.id !== variant.id))}><X size={15} /></Button>
          </Space>
        ))}
        <Typography.Text type="secondary">{words.safe}</Typography.Text>
        <Typography.Text type="secondary">{words.unsupportedAudio} ({words.language}: {outputLanguage})</Typography.Text>
        {batchTargets.map((target) => (
          <div key={target.id}>
            <Space>
              <span>{platformOptions.find(({ key }) => key === target.platform)?.label ?? target.platform} · {target.width} × {target.height}</span>
              <Tag color={target.status === "completed" ? "success" : target.status === "failed" ? "error" : "processing"}>
                {target.status === "completed" ? words.completed : target.status === "failed" ? words.failed : target.status === "queued" ? words.queued : words.running}
              </Tag>
              {target.error && <Typography.Text type="danger">{target.error}</Typography.Text>}
            </Space>
            {target.status === "rendering" && target.progress != null && <Progress percent={Math.round(target.progress * 100)} size="small" />}
          </div>
        ))}
        <Alert type={startBatch ? "info" : "warning"} showIcon message={startBatch ? words.unsupportedAudio : words.unavailable} />
        <Space wrap>
          {startBatch && <Button type="primary" icon={<Play size={15} />} loading={busy} disabled={busy || variants.length === 0} onClick={() => void runBatch()}>{words.run}</Button>}
          {downloadStudioPackage && <Button icon={<Download size={15} />} onClick={() => void downloadStudioPackage()}>{words.studio}</Button>}
          {saveBatch && batchTargets.some((target) => target.status === "completed") && <Button onClick={() => void saveBatch()}>{words.save}</Button>}
        </Space>
      </Space>
    </Card>
  );
}

export function OutputStage({
  isDesktop,
  desktopJob,
  coverAsset,
  imageUrls,
  nativeBusy,
  nativeSaving,
  environmentReady,
  backToLibrary,
  startNativeJob,
  cancelNativeJob,
  saveNativeVideo,
  retryNativeJob,
  selectedPlatforms,
  outputLanguage,
  startBatch,
  batchTargets,
  downloadStudioPackage,
  saveBatch,
}: OutputStageProps) {
  const { t } = useTranslation();
  const nativeTargets: RenderTargetStatus[] = batchTargets ?? (desktopJob?.targets ?? []).map((target) => {
    return {
      id: target.id,
      // The bridge reports the platform key it was given; the filename is only
      // a fallback for jobs started before the field existed.
      platform: target.platform ?? target.filename,
      profile: "custom",
      width: target.width,
      height: target.height,
      fps: target.fps,
      language: outputLanguage ?? "zh",
      safeArea: "standard",
      filename: target.filename,
      status: target.status,
      error: target.errorCode,
    };
  });
  const nativeStages = ["preparing", "rendering", "saving"] as const;
  const currentNativeStage = desktopJob
    ? nativeStages.indexOf(
        nativeStage(desktopJob) as (typeof nativeStages)[number],
      )
    : -1;
  const isNativeActive = Boolean(
    desktopJob && isActiveDesktopVideoJob(desktopJob),
  );
  const isNativeComplete = desktopJob?.state === "completed";

  return (
    <>
      <MultiPlatformOutput selectedPlatforms={selectedPlatforms} outputLanguage={outputLanguage} startBatch={startBatch} batchTargets={nativeTargets} downloadStudioPackage={downloadStudioPackage} saveBatch={saveBatch} busy={nativeBusy || nativeSaving} />
      {isDesktop ? (
        <section className={styles.exportPanel}>
          <Card
            className={styles.desktopJobCard}
            classNames={{ body: styles.desktopJobBody }}
          >
            {isNativeComplete && desktopJob?.videoUrl ? (
              <video
                className={styles.completedVideoFrame}
                src={desktopJob.videoUrl}
                controls
                preload="metadata"
              />
            ) : (
              <div className={styles.desktopCover}>
                {coverAsset && imageUrls[coverAsset.id] ? (
                  coverAsset.media_type.startsWith("video/") ? (
                    <video
                      src={imageUrls[coverAsset.id]}
                      muted
                      controls
                      preload="metadata"
                    />
                  ) : (
                    <img src={imageUrls[coverAsset.id]} alt="" />
                  )
                ) : (
                  <div className={styles.coverPlaceholder}>
                    <ImageIcon size={26} />
                  </div>
                )}
                <Tag className={styles.coverTag}>
                  {t("videoWizard.coverSample")}
                </Tag>
              </div>
            )}
            <div className={styles.desktopJobContent}>
              <div className={styles.nativeTimeline}>
                {nativeStages.map((stage, index) => {
                  const completed =
                    isNativeComplete ||
                    (isNativeActive && index < currentNativeStage);
                  const current =
                    isNativeActive && index === currentNativeStage;
                  const status = completed
                    ? "done"
                    : current
                    ? "current"
                    : "pending";
                  return (
                    <div
                      className={`${styles.nativeStage} ${
                        completed
                          ? styles.nativeStageDone
                          : current
                          ? styles.nativeStageCurrent
                          : ""
                      }`}
                      key={stage}
                    >
                      <span className={styles.nativeStageIcon}>
                        {completed ? (
                          <CheckCircle2 size={20} />
                        ) : current ? (
                          <LoaderCircle size={20} />
                        ) : (
                          <Circle size={20} />
                        )}
                      </span>
                      <div className={styles.nativeStageCopy}>
                        <strong>{t(`videoWizard.stage.${stage}`)}</strong>
                        <span>{t(`videoWizard.stageStatus.${status}`)}</span>
                        {current &&
                          desktopJob &&
                          desktopJob.progress !== null && (
                            <Progress
                              className={styles.nativeStageProgress}
                              percent={Math.round(
                                Math.max(0, Math.min(1, desktopJob.progress)) *
                                  100,
                              )}
                              status="active"
                              strokeColor="var(--fn-color-primary, #f04e70)"
                              size="small"
                            />
                          )}
                      </div>
                    </div>
                  );
                })}
              </div>
              {desktopJob && isActiveDesktopVideoJob(desktopJob) ? (
                <>
                  <Typography.Title level={4}>
                    {t("videoWizard.activeTitle")}
                  </Typography.Title>
                  <Typography.Text
                    className={styles.nativeDescription}
                    type="secondary"
                  >
                    {t("videoWizard.activeHint")}
                  </Typography.Text>
                  <Space wrap>
                    <Button
                      type="primary"
                      icon={<ArrowRight size={15} />}
                      onClick={backToLibrary}
                    >
                      {t("videoWizard.backgroundNavigate")}
                    </Button>
                    <Button
                      danger
                      icon={<X size={15} />}
                      loading={nativeBusy}
                      onClick={() => void cancelNativeJob()}
                    >
                      {t("videoWizard.cancelJob")}
                    </Button>
                  </Space>
                </>
              ) : desktopJob?.state === "completed" ? (
                <>
                  <Typography.Title level={4}>
                    {t("videoWizard.completedTitle")}
                  </Typography.Title>
                  {!desktopJob.videoUrl && (
                    <Alert
                      type="warning"
                      showIcon
                      message={t("videoWizard.videoUnavailable")}
                    />
                  )}
                  {desktopJob.videoUrl && (
                    <Button
                      type="primary"
                      icon={<Download size={15} />}
                      loading={nativeSaving}
                      disabled={nativeSaving}
                      onClick={() => void saveNativeVideo()}
                    >
                      {t("videoWizard.saveVideo")}
                    </Button>
                  )}
                </>
              ) : desktopJob &&
                ["failed", "cancelled", "interrupted"].includes(
                  desktopJob.state,
                ) ? (
                <>
                  <Alert
                    type={desktopJob.state === "failed" ? "error" : "info"}
                    showIcon
                    message={t(`videoWizard.jobState.${desktopJob.state}`)}
                    description={
                      desktopJob.errorCode
                        ? t(`videoWizard.desktopErrors.${desktopJob.errorCode}`)
                        : undefined
                    }
                  />
                  <Button
                    type="primary"
                    icon={<RefreshCw size={15} />}
                    loading={nativeBusy}
                    disabled={!environmentReady}
                    onClick={() => void retryNativeJob()}
                  >
                    {t("videoWizard.retryJob")}
                  </Button>
                </>
              ) : (
                <>
                  <Typography.Title level={4}>
                    {t("videoWizard.startReadyTitle")}
                  </Typography.Title>
                  <Typography.Paragraph type="secondary">
                    {t("videoWizard.startReadyHint")}
                  </Typography.Paragraph>
                  <Button
                    type="primary"
                    icon={<Play size={15} />}
                    loading={nativeBusy}
                    disabled={!environmentReady}
                    onClick={() => void startNativeJob()}
                  >
                    {t("videoWizard.startDesktop")}
                  </Button>
                </>
              )}
            </div>
          </Card>
        </section>
      ) : (
        <section className={styles.exportPanel}>
          <Typography.Title level={3}>
            {t("videoWizard.exportTitle")}
          </Typography.Title>
          <Alert
            type="success"
            showIcon
            message={t("videoWizard.exportReady")}
            description={
              <div>
                <p>{t("videoWizard.exportExtract")}</p>
                <p>
                  <code>preview.cmd</code> · {t("videoWizard.windowsPreview")}
                </p>
                <p>
                  <code>preview.command</code> · {t("videoWizard.macPreview")}
                </p>
                <p>{t("videoWizard.renderGuide")}</p>
                <p>{t("videoWizard.nodeGuide")}</p>
              </div>
            }
          />
        </section>
      )}
    </>
  );
}

interface EnvironmentPanelProps {
  environmentStatus: DesktopVideoEnvironmentStatus;
  environmentBusy: boolean;
  recheckEnvironment: () => Promise<void>;
  installEnvironment: () => Promise<void>;
  verifyEnvironment: () => Promise<void>;
}

export function EnvironmentPanel({
  environmentStatus,
  environmentBusy,
  recheckEnvironment,
  installEnvironment,
  verifyEnvironment,
}: EnvironmentPanelProps) {
  const { t } = useTranslation();
  return (
    <Card
      className={styles.environmentCard}
      classNames={{ body: styles.environmentBody }}
    >
      {environmentStatus.state === "ready" ? (
        <>
          <Alert
            type="success"
            showIcon
            message={t("videoWizard.environment.ready")}
            description={t("videoWizard.environment.readyHint")}
          />
          <Button
            loading={environmentBusy}
            disabled={environmentBusy}
            onClick={() => void recheckEnvironment()}
          >
            {t("videoWizard.environment.recheck")}
          </Button>
        </>
      ) : environmentStatus.state === "checking" ||
        environmentStatus.state === "installing" ||
        environmentStatus.state === "verifying" ||
        environmentStatus.state === "unknown" ? (
        <>
          <div className={styles.environmentLoading}>
            <Spin />
            <div>
              <strong>
                {t(
                  environmentStatus.state === "verifying"
                    ? "videoWizard.environment.verifying"
                    : environmentStatus.state === "installing"
                    ? "videoWizard.environment.installing"
                    : "videoWizard.environment.checking",
                )}
              </strong>
              {environmentStatus.stage && (
                <span>
                  {t(
                    `videoWizard.environment.stages.${environmentStatus.stage}`,
                  )}
                </span>
              )}
            </div>
          </div>
          {environmentStatus.progress !== null && (
            <Progress
              percent={Math.round(
                Math.max(0, Math.min(1, environmentStatus.progress)) * 100,
              )}
              status="active"
            />
          )}
        </>
      ) : environmentStatus.requiresInstall ||
        ["RUNTIME_MISSING", "BROWSER_MISSING"].includes(
          environmentStatus.errorCode ?? "",
        ) ? (
        <>
          <Alert
            type="warning"
            showIcon
            message={t("videoWizard.environment.installTitle")}
            description={t("videoWizard.environment.installHint")}
          />
          <ol className={styles.environmentSteps}>
            <li>{t("videoWizard.environment.installStepDownload")}</li>
            <li>{t("videoWizard.environment.installStepInstall")}</li>
            <li>{t("videoWizard.environment.installStepRecheck")}</li>
          </ol>
          <Space wrap>
            <Button
              type="primary"
              loading={environmentBusy}
              disabled={environmentBusy}
              onClick={() => void installEnvironment()}
            >
              {t("videoWizard.environment.downloadComponents")}
            </Button>
            <Button
              loading={environmentBusy}
              disabled={environmentBusy}
              onClick={() => void recheckEnvironment()}
            >
              {t("videoWizard.environment.recheck")}
            </Button>
          </Space>
        </>
      ) : (
        <>
          <Alert
            type={environmentStatus.state === "failed" ? "error" : "info"}
            showIcon
            message={t(
              environmentStatus.state === "failed"
                ? "videoWizard.environment.verifyFailed"
                : "videoWizard.environment.verifyTitle",
            )}
            description={
              environmentStatus.errorCode
                ? t(`videoWizard.desktopErrors.${environmentStatus.errorCode}`)
                : t("videoWizard.environment.verifyHint")
            }
          />
          <Space wrap>
            <Button
              type="primary"
              loading={environmentBusy}
              disabled={environmentBusy}
              onClick={() => void verifyEnvironment()}
            >
              {t("videoWizard.environment.verify")}
            </Button>
            <Button
              loading={environmentBusy}
              disabled={environmentBusy}
              onClick={() => void recheckEnvironment()}
            >
              {t("videoWizard.environment.recheck")}
            </Button>
          </Space>
        </>
      )}
    </Card>
  );
}
