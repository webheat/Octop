import {
  Alert,
  Button,
  Card,
  Progress,
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
import type { ProductSnapshotAsset } from "../../api/modules/productLibrary";
import {
  isActiveDesktopVideoJob,
  type DesktopVideoJob,
  type DesktopVideoEnvironmentStatus,
} from "../../context/DesktopVideoJobsContext";
import { useTranslation } from "react-i18next";
import styles from "./index.module.less";

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
}: OutputStageProps) {
  const { t } = useTranslation();
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
