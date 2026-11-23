import { useState } from "react";
import { Alert, Button, Card, Space, Spin, Tag, Typography } from "antd";
import { CheckCircle2, Circle, Clock3 } from "lucide-react";
import type {
  ProductSnapshotAsset,
  StoryboardDraft,
  StoryboardScene,
} from "../../api/modules/productLibrary";
import { StoryboardWorkbench, ScenePreview } from "./StoryboardWorkbench";
import { useTranslation } from "react-i18next";
import styles from "./index.module.less";

interface StoryboardStageProps {
  step: number;
  draft: StoryboardDraft;
  productName: string | undefined;
  totalDuration: number;
  saved: boolean;
  busy: boolean;
  assetByExportName: Map<string, ProductSnapshotAsset>;
  imageUrls: Record<string, string>;
  orderedSceneAssets: ProductSnapshotAsset[];
  updateScenes: (scenes: StoryboardScene[]) => void;
}

export function StoryboardStage({
  step,
  draft,
  productName,
  totalDuration,
  saved,
  busy,
  assetByExportName,
  imageUrls,
  orderedSceneAssets,
  updateScenes,
}: StoryboardStageProps) {
  const { t } = useTranslation();
  const [advanced, setAdvanced] = useState(false);
  return (
    <>
      <Card className={styles.summary}>
        <Space wrap>
          <strong>{productName}</strong>
          <span className={styles.metaItem}>
            <Clock3 size={15} />
            {t("videoWizard.estimatedDuration", {
              seconds: totalDuration,
            })}
          </span>
          <span>
            {draft.script.width === draft.script.height
              ? "1:1"
              : draft.script.width > draft.script.height
              ? "16:9"
              : "9:16"}
          </span>
          <span>
            {draft.request.language === "zh"
              ? t("videoWizard.chinese")
              : "English"}
          </span>
          <Tag
            color={
              draft.confirmed && saved ? "green" : !saved ? "orange" : "gold"
            }
            icon={
              draft.confirmed && saved ? (
                <CheckCircle2 size={14} />
              ) : (
                <Circle size={14} />
              )
            }
          >
            {draft.confirmed && saved
              ? t("videoWizard.confirmed")
              : !saved
              ? t("videoWizard.unsaved")
              : t("videoWizard.pendingConfirmation")}
          </Tag>
        </Space>
      </Card>
      {step === 2 && (
        <div className={styles.loading}>
          <Spin tip={t("videoWizard.generating")}>
            <div className={styles.spinArea} />
          </Spin>
        </div>
      )}
      {step === 3 && (
        <section>
          <div className={styles.sectionHeader}>
            <div>
              <Typography.Title level={3}>
                {t("videoWizard.storyboardTitle")}
              </Typography.Title>
              <Typography.Text type="secondary">
                {t("videoWizard.storyboardHint")}
              </Typography.Text>
            </div>
            <Space wrap>
              <Button
                aria-expanded={advanced}
                onClick={() => setAdvanced(!advanced)}
              >
                {t(
                  advanced
                    ? "videoWizard.guidedView"
                    : "videoWizard.advancedEdit",
                )}
              </Button>
            </Space>
          </div>
          {totalDuration > 180 && (
            <Alert
              type="error"
              message={t("videoWizard.durationTooLong", {
                seconds: totalDuration,
              })}
            />
          )}
          {advanced ? (
            <StoryboardWorkbench
              draft={draft}
              assetByExportName={assetByExportName}
              imageUrls={imageUrls}
              orderedSceneAssets={orderedSceneAssets}
              updateScenes={updateScenes}
              busy={busy}
            />
          ) : (
            <div className={styles.sceneGrid}>
              {draft.script.scenes.map((scene, index) => (
                <Card
                  key={`${scene.id}-${index}`}
                  className={styles.sceneCard}
                  title={
                    <Space>
                      <span className={styles.sceneNumber}>{index + 1}</span>
                      <Tag>{t(`videoWizard.sceneType.${scene.type}`)}</Tag>
                    </Space>
                  }
                  extra={`${scene.duration} ${t("videoWizard.seconds")}`}
                >
                  <ScenePreview
                    scene={scene}
                    assets={assetByExportName}
                    urls={imageUrls}
                  />
                  {scene.caption && (
                    <Typography.Text>{scene.caption}</Typography.Text>
                  )}
                </Card>
              ))}
            </div>
          )}
        </section>
      )}
    </>
  );
}
