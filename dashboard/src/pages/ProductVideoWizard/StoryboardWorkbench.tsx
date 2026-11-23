import { useState } from "react";
import {
  Button,
  Card,
  Input,
  InputNumber,
  Select,
  Space,
  Tag,
  Typography,
} from "antd";
import { ArrowDown, ArrowUp } from "lucide-react";
import type {
  ProductSnapshotAsset,
  StoryboardDraft,
  StoryboardScene,
} from "../../api/modules/productLibrary";
import { exportName, mediaType } from "./sceneAssets";
import { useTranslation } from "react-i18next";
import styles from "./index.module.less";

interface Props {
  draft: StoryboardDraft;
  assetByExportName: Map<string, ProductSnapshotAsset>;
  imageUrls: Record<string, string>;
  orderedSceneAssets: ProductSnapshotAsset[];
  updateScenes: (scenes: StoryboardScene[]) => void;
  busy: boolean;
}

export function ScenePreview({
  scene,
  assets,
  urls,
}: {
  scene: StoryboardScene;
  assets: Map<string, ProductSnapshotAsset>;
  urls: Record<string, string>;
}) {
  const { t } = useTranslation();
  const asset = scene.asset ? assets.get(scene.asset) : undefined;
  const src = asset ? urls[asset.id] : undefined;
  return (
    <div className={styles.scenePreview}>
      {src && asset && mediaType(asset) === "image" ? (
        <img src={src} alt={asset.filename} />
      ) : (
        <div className={styles.textPreview}>
          <strong>
            {scene.text ||
              scene.bullets?.[0] ||
              asset?.filename ||
              t("videoWizard.previewPlaceholder")}
          </strong>
          {scene.subtitle && <span>{scene.subtitle}</span>}
          {scene.caption && <span>{scene.caption}</span>}
          {scene.bullets
            ?.slice(1, 3)
            .map((line) => <span key={line}>• {line}</span>)}
        </div>
      )}
      <Tag className={styles.previewLabel}>{t("videoWizard.previewOnly")}</Tag>
    </div>
  );
}

export function StoryboardWorkbench({
  draft,
  assetByExportName,
  imageUrls,
  orderedSceneAssets,
  updateScenes,
  busy,
}: Props) {
  const { t } = useTranslation();
  const [selectedId, setSelectedId] = useState(
    draft.script.scenes[0]?.id ?? "",
  );
  const [mobilePanel, setMobilePanel] = useState<
    "scenes" | "assets" | "properties"
  >("scenes");
  const scenes = draft.script.scenes;
  const selectedIndex = Math.max(
    0,
    scenes.findIndex((scene) => scene.id === selectedId),
  );
  const selected = scenes[selectedIndex];
  if (!selected) return null;

  const patch = (change: Partial<StoryboardScene>) => {
    updateScenes(
      scenes.map((scene, index) =>
        index === selectedIndex ? { ...scene, ...change } : scene,
      ),
    );
  };
  const move = (offset: number) => {
    const target = selectedIndex + offset;
    if (target < 0 || target >= scenes.length) return;
    const reordered = [...scenes];
    [reordered[selectedIndex], reordered[target]] = [
      reordered[target],
      reordered[selectedIndex],
    ];
    updateScenes(reordered);
  };
  const candidates = orderedSceneAssets.filter(
    (asset) => mediaType(asset) === selected.type,
  );
  const sceneLabel = (scene: StoryboardScene, index: number) =>
    `${index + 1}. ${
      scene.text || scene.caption || t(`videoWizard.sceneType.${scene.type}`)
    }`;

  return (
    <>
      <div
        className={styles.workbenchMobileTabs}
        role="tablist"
        aria-label={t("videoWizard.workbenchPanels")}
      >
        {(["scenes", "assets", "properties"] as const).map((panel) => (
          <button
            key={panel}
            type="button"
            role="tab"
            aria-selected={mobilePanel === panel}
            onClick={() => setMobilePanel(panel)}
          >
            {t(`videoWizard.${panel}Panel`)}
          </button>
        ))}
      </div>
      <div className={styles.workbench}>
        <Card
          data-mobile-active={mobilePanel === "assets"}
          title={t("videoWizard.projectAssets")}
          className={styles.workbenchAssets}
        >
          <Typography.Text type="secondary">
            {t("videoWizard.snapshotAssets")}
          </Typography.Text>
          <div className={styles.assetList}>
            {orderedSceneAssets.map((asset, index) => {
              const value = exportName(asset, index);
              const usable = mediaType(asset) === selected.type;
              return (
                <button
                  key={asset.id}
                  type="button"
                  className={styles.workbenchAsset}
                  disabled={!usable || busy}
                  onClick={() => patch({ asset: value })}
                >
                  <span>{asset.filename}</span>
                  <Tag>
                    {usable
                      ? t("videoWizard.usable")
                      : t("videoWizard.unavailable")}
                  </Tag>
                </button>
              );
            })}
          </div>
        </Card>
        <Card
          data-mobile-active={mobilePanel === "scenes"}
          title={t("videoWizard.storyboardTitle")}
          className={styles.workbenchScenes}
        >
          <div className={styles.workbenchPreview}>
            <ScenePreview
              scene={selected}
              assets={assetByExportName}
              urls={imageUrls}
            />
          </div>
          <div
            className={styles.sceneList}
            role="list"
            aria-label={t("videoWizard.sceneList")}
          >
            {scenes.map((scene, index) => (
              <button
                key={`${scene.id}-${index}`}
                type="button"
                aria-pressed={scene.id === selected.id}
                className={styles.sceneRow}
                onClick={() => setSelectedId(scene.id)}
              >
                <span className={styles.sceneNumber}>{index + 1}</span>
                <span>{sceneLabel(scene, index)}</span>
              </button>
            ))}
          </div>
          <Space>
            <Button
              aria-label={t("videoWizard.moveUp")}
              icon={<ArrowUp size={15} />}
              disabled={selectedIndex === 0 || busy}
              onClick={() => move(-1)}
            />
            <Button
              aria-label={t("videoWizard.moveDown")}
              icon={<ArrowDown size={15} />}
              disabled={selectedIndex === scenes.length - 1 || busy}
              onClick={() => move(1)}
            />
          </Space>
        </Card>
        <Card
          data-mobile-active={mobilePanel === "properties"}
          title={t("videoWizard.sceneProperties")}
          className={styles.workbenchProperties}
        >
          <Space direction="vertical" className={styles.propertyForm}>
            {(selected.type === "image" || selected.type === "video") && (
              <label>
                {t("videoWizard.replaceAsset")}
                <Select
                  value={selected.asset}
                  onChange={(asset) => patch({ asset })}
                  options={candidates.map((asset) => ({
                    value: exportName(asset, orderedSceneAssets.indexOf(asset)),
                    label: asset.filename,
                  }))}
                />
              </label>
            )}
            {["title", "text", "endcard"].includes(selected.type) && (
              <label>
                {t("videoWizard.sceneText")}
                <Input.TextArea
                  maxLength={400}
                  value={selected.text ?? ""}
                  onChange={(event) => patch({ text: event.target.value })}
                />
              </label>
            )}
            {(selected.type === "title" || selected.type === "endcard") && (
              <label>
                {t("videoWizard.sceneSubtitle")}
                <Input
                  maxLength={400}
                  value={selected.subtitle ?? ""}
                  onChange={(event) => patch({ subtitle: event.target.value })}
                />
              </label>
            )}
            {(selected.type === "image" ||
              selected.type === "video" ||
              selected.type === "text") && (
              <label>
                {t("videoWizard.caption")}
                <Input.TextArea
                  maxLength={400}
                  value={selected.caption ?? ""}
                  onChange={(event) => patch({ caption: event.target.value })}
                />
              </label>
            )}
            {selected.type === "bullets" && (
              <label>
                {t("videoWizard.bullets")}
                <Input.TextArea
                  rows={4}
                  value={(selected.bullets ?? []).join("\n")}
                  onChange={(event) =>
                    patch({
                      bullets: event.target.value
                        .split("\n")
                        .slice(0, 8)
                        .map((line) => line.slice(0, 150)),
                    })
                  }
                />
              </label>
            )}
            <label>
              {t("videoWizard.sceneDuration")}
              <InputNumber
                min={0.25}
                max={15}
                step={0.25}
                value={selected.duration}
                onChange={(duration) => patch({ duration: duration ?? 1 })}
                addonAfter={t("videoWizard.seconds")}
              />
            </label>
            <Typography.Text type="secondary">
              {t("videoWizard.manualEditingOnly")}
            </Typography.Text>
          </Space>
        </Card>
      </div>
    </>
  );
}
