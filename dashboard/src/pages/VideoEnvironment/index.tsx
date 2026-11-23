import {
  useCallback,
  useEffect,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  Alert,
  Button,
  Card,
  Progress,
  Space,
  Spin,
  Typography,
  message,
} from "antd";
import { ArrowLeft, Copy, Download, RefreshCw } from "lucide-react";
import PageShell from "../../layouts/PageShell";
import { useDesktopVideoJobs } from "../../context/DesktopVideoJobsContext";
import { useDesktopMinimalMode } from "../../hooks/useDesktopMinimalMode";
import { copyText } from "../../utils/copyText";

const { Text } = Typography;

/**
 * Standalone counterpart of the wizard's environment panel. When no known
 * runtime exists, the primary action walks the user through installing the
 * video production components in one click.
 */
export default function VideoEnvironmentPage({
  onReturn,
}: { onReturn?: () => void } = {}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  // In the customer-facing shell there is no navigation rail, so this page
  // needs its own way back to the landing surface.
  const desktopMinimal = useDesktopMinimalMode();
  const {
    environmentSupported,
    environmentStatus,
    checkEnvironment,
    verifyEnvironment,
    installEnvironment,
  } = useDesktopVideoJobs();
  const [busy, setBusy] = useState(false);

  const { state, stage, progress, errorCode, requiresInstall } =
    environmentStatus;

  useEffect(() => {
    if (!environmentSupported || environmentStatus.state !== "unknown") return;
    void checkEnvironment().catch(() => undefined);
  }, [checkEnvironment, environmentStatus.state, environmentSupported]);

  const install = useCallback(async () => {
    setBusy(true);
    try {
      await installEnvironment();
    } catch {
      // The provider keeps the localized error code in its status snapshot.
    } finally {
      setBusy(false);
    }
  }, [installEnvironment]);

  const recheck = useCallback(async () => {
    setBusy(true);
    try {
      await checkEnvironment(true);
    } catch {
      // The provider keeps the localized error code in its status snapshot.
    } finally {
      setBusy(false);
    }
  }, [checkEnvironment]);

  const verify = useCallback(async () => {
    setBusy(true);
    try {
      await verifyEnvironment();
    } catch {
      // The provider keeps the localized error code in its status snapshot.
    } finally {
      setBusy(false);
    }
  }, [verifyEnvironment]);

  // Copy the current environment snapshot for a support report. The desktop
  // shell keeps the authoritative log on disk; this is the quick version a
  // user can paste into a ticket without hunting for the log file.
  const copyDiagnostics = useCallback(async () => {
    const payload = [
      t("videoEnvironment.diagnosticsTitle"),
      `state=${state}`,
      `stage=${stage ?? "-"}`,
      `code=${errorCode ?? "-"}`,
      `requiresInstall=${requiresInstall === true}`,
      `progress=${progress ?? "-"}`,
      `checkedAt=${environmentStatus.checkedAt ?? "-"}`,
      `bridge=${environmentSupported}`,
      `userAgent=${navigator.userAgent}`,
    ].join("\n");
    const ok = await copyText(payload);
    if (ok) message.success(t("videoEnvironment.diagnosticsCopied"));
    else message.error(t("videoEnvironment.diagnosticsCopyFailed"));
  }, [
    environmentStatus.checkedAt,
    environmentSupported,
    errorCode,
    progress,
    requiresInstall,
    stage,
    state,
    t,
  ]);

  const installing = environmentSupported && state === "installing";
  // A failed install also carries requiresInstall=true. Split it out so the
  // concrete error (DOWNLOAD_FAILED / PACKAGE_INVALID / ENV_DISK_FULL / …)
  // stays visible and the retry action installs again rather than verifies.
  const installFailed =
    environmentSupported && state === "failed" && requiresInstall === true;
  // The components are missing only when the native side says so. A
  // needs_setup without that flag means the opposite: everything is in place
  // but nobody rendered a frame yet, so the fix is a verification, not
  // another download. Showing "需要安装" there sent users into an endless
  // reinstall loop right after a perfectly good install.
  const componentsMissing =
    errorCode === "RUNTIME_MISSING" ||
    errorCode === "BROWSER_MISSING" ||
    (requiresInstall === true && !installing && !installFailed);
  const needsInstall = !environmentSupported || componentsMissing;
  const checking =
    environmentSupported &&
    (state === "checking" || state === "verifying" || state === "unknown");
  const ready = environmentSupported && state === "ready" && !needsInstall;

  let statusBody: ReactNode;
  if (needsInstall) {
    statusBody = (
      <>
        <Alert
          type="warning"
          showIcon
          message={t(
            environmentSupported
              ? "videoEnvironment.installTitle"
              : "videoEnvironment.noEnvironmentTitle",
          )}
          description={t(
            environmentSupported
              ? "videoEnvironment.installHint"
              : "videoEnvironment.noEnvironmentHint",
          )}
        />
        <h4 style={{ margin: "20px 0 8px" }}>
          {t("videoEnvironment.installStepsTitle")}
        </h4>
        <ol style={listStyle}>
          <li>{t("videoEnvironment.installStepDownload")}</li>
          <li>{t("videoEnvironment.installStepInstall")}</li>
          <li>{t("videoEnvironment.installStepRecheck")}</li>
        </ol>
        <Space wrap style={{ marginTop: 20 }}>
          <Button
            type="primary"
            icon={<Download size={15} />}
            loading={busy}
            disabled={!environmentSupported || busy}
            onClick={() => void install()}
          >
            {t("videoEnvironment.installNow")}
          </Button>
        </Space>
        {!environmentSupported && (
          <div style={{ marginTop: 10 }}>
            <Text type="secondary">
              {t("videoEnvironment.installerUnavailable")}
            </Text>
          </div>
        )}
      </>
    );
  } else if (state === "installing") {
    statusBody = (
      <Space direction="vertical" size="middle" style={{ width: "100%" }}>
        <Space align="start">
          <Spin />
          <div>
            <strong>{t("videoEnvironment.installing")}</strong>
            {stage && (
              <div style={{ marginTop: 4 }}>
                <Text type="secondary">
                  {t(`videoWizard.environment.stages.${stage}`)}
                </Text>
              </div>
            )}
          </div>
        </Space>
        {progress !== null ? (
          <Progress
            percent={Math.round(Math.max(0, Math.min(1, progress)) * 100)}
            status="active"
          />
        ) : (
          <Progress percent={99} status="active" showInfo={false} />
        )}
        <Text type="secondary">{t("videoEnvironment.installingHint")}</Text>
      </Space>
    );
  } else if (installFailed) {
    statusBody = (
      <>
        <Alert
          type="error"
          showIcon
          message={t("videoEnvironment.installFailedTitle")}
          description={
            errorCode
              ? t(`videoWizard.desktopErrors.${errorCode}`)
              : t("videoEnvironment.installFailedHint")
          }
        />
        <Space wrap style={{ marginTop: 20 }}>
          <Button
            type="primary"
            loading={busy}
            disabled={busy}
            onClick={() => void install()}
          >
            {t("videoEnvironment.retryInstall")}
          </Button>
        </Space>
      </>
    );
  } else if (ready) {
    statusBody = (
      <>
        <Alert
          type="success"
          showIcon
          message={t("videoEnvironment.readyTitle")}
          description={t("videoEnvironment.readyHint")}
        />
        <Space style={{ marginTop: 20 }}>
          <Button
            type="primary"
            onClick={() =>
              onReturn
                ? onReturn()
                : navigate(
                    desktopMinimal
                      ? "/local-video-wizard"
                      : "/product-library/video-wizard",
                  )
            }
          >
            {t("videoEnvironment.openWizard")}
          </Button>
        </Space>
      </>
    );
  } else if (state === "needs_setup" && !needsInstall) {
    // The components are installed but no successful render has been recorded
    // for this build yet. The action here is a verification, not a download.
    statusBody = (
      <>
        <Alert
          type="info"
          showIcon
          message={t("videoEnvironment.verifyTitle")}
          description={t("videoEnvironment.verifyHint")}
        />
        <Space wrap style={{ marginTop: 20 }}>
          <Button
            type="primary"
            loading={busy}
            disabled={busy}
            onClick={() => void verify()}
          >
            {t("videoEnvironment.verify")}
          </Button>
        </Space>
      </>
    );
  } else if (checking) {
    statusBody = (
      <Space direction="vertical" size="middle" style={{ width: "100%" }}>
        <Space align="start">
          <Spin />
          <div>
            <strong>
              {t(
                state === "verifying"
                  ? "videoEnvironment.verifying"
                  : "videoEnvironment.checking",
              )}
            </strong>
            {stage && (
              <div style={{ marginTop: 4 }}>
                <Text type="secondary">
                  {t(`videoWizard.environment.stages.${stage}`)}
                </Text>
              </div>
            )}
          </div>
        </Space>
        {progress !== null && (
          <Progress
            percent={Math.round(Math.max(0, Math.min(1, progress)) * 100)}
            status="active"
          />
        )}
        <Text type="secondary">{t("videoEnvironment.checkingHint")}</Text>
      </Space>
    );
  } else {
    const failed = state === "failed";
    statusBody = (
      <>
        <Alert
          type={failed ? "error" : "info"}
          showIcon
          message={t(
            failed
              ? "videoEnvironment.failedTitle"
              : "videoEnvironment.verifyTitle",
          )}
          description={
            errorCode
              ? t(`videoWizard.desktopErrors.${errorCode}`)
              : t(
                  failed
                    ? "videoEnvironment.failedHint"
                    : "videoEnvironment.verifyHint",
                )
          }
        />
        <Space wrap style={{ marginTop: 20 }}>
          <Button
            type="primary"
            loading={busy}
            disabled={busy}
            onClick={() => void verify()}
          >
            {t("videoEnvironment.verify")}
          </Button>
        </Space>
      </>
    );
  }

  return (
    <PageShell
      title={t("videoEnvironment.title")}
      subtitle={t("videoEnvironment.subtitle")}
      actions={
        <Space size={8}>
          {desktopMinimal && (
            <Button
              icon={<ArrowLeft size={14} />}
              onClick={() =>
                onReturn ? onReturn() : navigate("/product-library")
              }
            >
              {t(
                onReturn
                  ? "localVideoWizard.back"
                  : "videoEnvironment.backToLibrary",
              )}
            </Button>
          )}
          <Button
            icon={<RefreshCw size={14} />}
            loading={busy}
            disabled={busy || !environmentSupported}
            onClick={() => void recheck()}
          >
            {t("videoEnvironment.recheck")}
          </Button>
          <Button
            icon={<Copy size={14} />}
            onClick={() => void copyDiagnostics()}
          >
            {t("videoEnvironment.copyDiagnostics")}
          </Button>
        </Space>
      }
    >
      <div style={{ display: "grid", gap: 16, maxWidth: 800 }}>
        <Card title={t("videoEnvironment.statusTitle")}>{statusBody}</Card>
        <Card title={t("videoEnvironment.componentsTitle")} size="small">
          <ol style={listStyle}>
            <li>{t("videoEnvironment.componentRuntime")}</li>
            <li>{t("videoEnvironment.componentBrowser")}</li>
            <li>{t("videoEnvironment.componentWorker")}</li>
          </ol>
        </Card>
      </div>
    </PageShell>
  );
}

const listStyle: CSSProperties = {
  margin: 0,
  paddingLeft: 20,
  lineHeight: 2,
  color: "var(--fn-text-secondary)",
};
