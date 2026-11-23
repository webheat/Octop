import {
  Alert,
  Button,
  Card,
  Input,
  InputNumber,
  Select,
  Space,
  Spin,
  Tag,
  Typography,
} from "antd";
import {
  CheckCircle2,
  Circle,
  Clock3,
  Image as ImageIcon,
  RefreshCw,
} from "lucide-react";
import type {
  ProductSnapshotAsset,
  StoryboardDraft,
  StoryboardScene,
} from "../../api/modules/productLibrary";
import { exportName, mediaType } from "./sceneAssets";
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
  generate: () => Promise<void>;
  updateScene: (index: number, patch: Partial<StoryboardScene>) => void;
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
  generate,
  updateScene,
}: StoryboardStageProps) {
  const { t } = useTranslation();
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
            <Button
              icon={<RefreshCw size={15} />}
              loading={busy}
              onClick={() => void generate()}
            >
              {t("videoWizard.regenerate")}
            </Button>
          </div>
          {totalDuration > 180 && (
            <Alert
              type="error"
              message={t("videoWizard.durationTooLong", {
                seconds: totalDuration,
              })}
            />
          )}
          <div className={styles.sceneGrid}>
            {draft.script.scenes.map((scene, index) => {
              const currentAsset = scene.asset
                ? assetByExportName.get(scene.asset)
                : undefined;
              const src = currentAsset ? imageUrls[currentAsset.id] : undefined;
              const candidates = orderedSceneAssets.filter(
                (asset) => mediaType(asset) === scene.type,
              );
              return (
                <Card
                  key={`${scene.id}-${index}`}
                  className={styles.sceneCard}
                  title={
                    <Space>
                      <span className={styles.sceneNumber}>{index + 1}</span>
                      <Tag>{t(`videoWizard.sceneType.${scene.type}`)}</Tag>
                    </Space>
                  }
                  extra={
                    <InputNumber
                      aria-label={t("videoWizard.sceneDuration")}
                      min={0.25}
                      max={15}
                      step={0.25}
                      value={scene.duration}
                      onChange={(duration) =>
                        updateScene(index, {
                          duration: duration ?? 1,
                        })
                      }
                      addonAfter={t("videoWizard.seconds")}
                    />
                  }
                >
                  <div className={styles.scenePreview}>
                    {scene.type === "image" || scene.type === "video" ? (
                      src &&
                      currentAsset &&
                      mediaType(currentAsset) === "image" ? (
                        <img src={src} alt={currentAsset.filename} />
                      ) : src && currentAsset ? (
                        <video src={src} muted controls preload="metadata" />
                      ) : (
                        <div>
                          <ImageIcon size={25} />
                          <span>
                            {scene.asset
                              ? currentAsset?.filename ?? scene.asset
                              : t("videoWizard.previewPlaceholder")}
                          </span>
                        </div>
                      )
                    ) : (
                      <div className={styles.textPreview}>
                        <strong>
                          {scene.text ||
                            scene.bullets?.[0] ||
                            t("videoWizard.textCard")}
                        </strong>
                        {scene.subtitle && <span>{scene.subtitle}</span>}
                        {scene.bullets
                          ?.slice(1, 3)
                          .map((line) => <span key={line}>• {line}</span>)}
                      </div>
                    )}
                    <Tag className={styles.previewLabel}>
                      {t("videoWizard.previewOnly")}
                    </Tag>
                  </div>
                  {(scene.type === "title" ||
                    scene.type === "text" ||
                    scene.type === "endcard") && (
                    <Input
                      maxLength={400}
                      aria-label={t("videoWizard.sceneText")}
                      value={scene.text ?? ""}
                      onChange={(e) =>
                        updateScene(index, { text: e.target.value })
                      }
                      placeholder={t("videoWizard.sceneText")}
                    />
                  )}
                  {(scene.type === "title" || scene.type === "endcard") && (
                    <Input
                      maxLength={400}
                      aria-label={t("videoWizard.sceneSubtitle")}
                      value={scene.subtitle ?? ""}
                      onChange={(e) =>
                        updateScene(index, {
                          subtitle: e.target.value,
                        })
                      }
                      placeholder={t("videoWizard.sceneSubtitle")}
                    />
                  )}
                  {(scene.type === "image" || scene.type === "video") && (
                    <>
                      <Select
                        aria-label={t("videoWizard.replaceAsset")}
                        value={scene.asset}
                        onChange={(asset) => updateScene(index, { asset })}
                        placeholder={t("videoWizard.replaceAsset")}
                        options={candidates.map((asset) => ({
                          value: exportName(
                            asset,
                            orderedSceneAssets.indexOf(asset),
                          ),
                          label: asset.filename,
                        }))}
                      />
                      <Input
                        maxLength={400}
                        aria-label={t("videoWizard.caption")}
                        value={scene.caption ?? ""}
                        onChange={(e) =>
                          updateScene(index, {
                            caption: e.target.value,
                          })
                        }
                        placeholder={t("videoWizard.caption")}
                      />
                    </>
                  )}
                  {scene.type === "bullets" && (
                    <Input.TextArea
                      aria-label={t("videoWizard.bullets")}
                      rows={3}
                      value={(scene.bullets ?? []).join("\n")}
                      onChange={(e) =>
                        updateScene(index, {
                          bullets: e.target.value
                            .split("\n")
                            .slice(0, 8)
                            .map((line) => line.slice(0, 150)),
                        })
                      }
                    />
                  )}
                  {scene.type === "text" && (
                    <Input
                      maxLength={400}
                      aria-label={t("videoWizard.caption")}
                      value={scene.caption ?? ""}
                      onChange={(e) =>
                        updateScene(index, {
                          caption: e.target.value,
                        })
                      }
                      placeholder={t("videoWizard.caption")}
                    />
                  )}
                </Card>
              );
            })}
          </div>
        </section>
      )}
    </>
  );
}
