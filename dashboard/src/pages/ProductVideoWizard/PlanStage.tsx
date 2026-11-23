import { useMemo } from "react";
import {
  Button,
  Card,
  Checkbox,
  Input,
  InputNumber,
  Radio,
  Select,
  Typography,
} from "antd";
import { Play, X } from "lucide-react";
import type {
  BgmOptions,
  NarrationOptions,
  ProductProject,
  VideoPlanRequest,
} from "../../api/modules/productLibrary";
import { joinPlatforms, splitPlatforms, type VideoBrief } from "./brief";
import { useTranslation } from "react-i18next";
import styles from "./index.module.less";
import {
  PLATFORM_FORMATS,
  PLATFORM_KEYS,
  type VideoFormat,
} from "./platforms";

const FORMAT_LABELS: Record<VideoFormat, string> = {
  portrait: "9:16",
  landscape: "16:9",
  square: "1:1",
};

interface PlanStageProps {
  brief: VideoBrief;
  request: VideoPlanRequest;
  project: ProductProject | null;
  busy: boolean;
  narrationAvailable: boolean;
  narrationOptions: NarrationOptions | null;
  narrationEnabled: boolean;
  narrationVoice: string;
  bgmOptions: BgmOptions | null;
  bgmEnabled: boolean;
  bgmId: string;
  bgmPreview: string;
  toggleBgmPreview: (id: string) => void;
  changeBrief: (patch: Partial<VideoBrief>) => void;
  changeRequest: (patch: Partial<VideoPlanRequest>) => void;
  changeNarrationEnabled: (enabled: boolean) => void;
  changeNarrationVoice: (voice: string) => void;
  changeBgmEnabled: (enabled: boolean) => void;
  changeBgmId: (id: string) => void;
}

export function PlanStage({
  brief,
  request,
  project,
  busy,
  narrationAvailable,
  narrationOptions,
  narrationEnabled,
  narrationVoice,
  bgmOptions,
  bgmEnabled,
  bgmId,
  bgmPreview,
  toggleBgmPreview,
  changeBrief,
  changeRequest,
  changeNarrationEnabled,
  changeNarrationVoice,
  changeBgmEnabled,
  changeBgmId,
}: PlanStageProps) {
  const { t } = useTranslation();
  const platformOptions = useMemo(() => {
    const presets = PLATFORM_KEYS.map((key) =>
      t(`videoWizard.platforms.${key}`),
    );
    const known = new Set(presets);
    // Keep values stored by older free-text briefs selectable so nothing is lost.
    const extra = splitPlatforms(brief.platform).filter(
      (value) => !known.has(value),
    );
    return [...presets, ...extra].map((value) => ({ value, label: value }));
  }, [t, brief.platform]);

  /** Ratio buckets for the platforms currently selected. */
  const platformFormatGroups = useMemo(() => {
    const selected = new Set(splitPlatforms(brief.platform));
    const groups: Record<VideoFormat, string[]> = {
      portrait: [],
      landscape: [],
      square: [],
    };
    (Object.keys(PLATFORM_FORMATS) as (typeof PLATFORM_KEYS)[number][]).forEach(
      (key) => {
        const label = t(`videoWizard.platforms.${key}`);
        if (selected.has(label)) groups[PLATFORM_FORMATS[key]].push(label);
      },
    );
    return groups;
  }, [brief.platform, t]);

  const requiredFormats = useMemo(
    () =>
      (Object.keys(platformFormatGroups) as VideoFormat[]).filter(
        (format) => platformFormatGroups[format].length > 0,
      ),
    [platformFormatGroups],
  );

  /**
   * One ratio → tell the user it followed their platforms. Several ratios →
   * spell out which platform wants which ratio, so nobody ships a 9:16 file to
   * a 16:9 site again.
   */
  const formatNote = useMemo(() => {
    if (requiredFormats.length === 0) return "";
    if (requiredFormats.length === 1) {
      return t("videoWizard.formatAuto", {
        format: FORMAT_LABELS[requiredFormats[0]],
      });
    }
    const groups = requiredFormats
      .map((format) =>
        t("videoWizard.formatConflictGroup", {
          format: FORMAT_LABELS[format],
          platforms: platformFormatGroups[format].join(
            t("videoWizard.platformSeparator"),
          ),
        }),
      )
      .join(t("videoWizard.formatGroupSeparator"));
    return t("videoWizard.formatConflict", {
      groups,
      current: FORMAT_LABELS[request.format],
    });
  }, [requiredFormats, platformFormatGroups, request.format, t]);
  return (
    <section>
      <Typography.Title level={3}>
        {t("videoWizard.requirementsTitle")}
      </Typography.Title>
      <Card className={styles.formCard}>
        <div className={styles.formGrid}>
          <label>
            {t("videoWizard.purpose")}
            <Select
              value={brief.purpose || undefined}
              onChange={(purpose) => changeBrief({ purpose })}
              placeholder={t("videoWizard.purposeHint")}
              options={["launch", "promotion", "introduction", "brand"].map(
                (value) => ({
                  value,
                  label: t(`videoWizard.purposes.${value}`),
                }),
              )}
            />
          </label>
          <label>
            {t("videoWizard.audience")}
            <Input
              maxLength={200}
              value={brief.audience}
              onChange={(e) => changeBrief({ audience: e.target.value })}
            />
          </label>
          <div className={styles.platformField}>
            {t("videoWizard.platform")}
            <Checkbox.Group
              className={styles.platformOptions}
              value={splitPlatforms(brief.platform)}
              onChange={(values) => {
                const next = values as string[];
                changeBrief({ platform: joinPlatforms(next) });
                const selected = new Set(next);
                const formats = new Set<VideoFormat>();
                (
                  Object.keys(
                    PLATFORM_FORMATS,
                  ) as (typeof PLATFORM_KEYS)[number][]
                ).forEach((key) => {
                  if (selected.has(t(`videoWizard.platforms.${key}`))) {
                    formats.add(PLATFORM_FORMATS[key]);
                  }
                });
                // Every chosen platform agrees on one ratio: follow it.
                if (formats.size === 1 && [...formats][0] !== request.format) {
                  changeRequest({ format: [...formats][0] });
                }
              }}
              options={platformOptions}
            />
          </div>
          <label>
            {t("videoWizard.targetDuration")}
            <Select
              allowClear
              value={brief.targetDuration || undefined}
              onChange={(targetDuration) =>
                changeBrief({
                  targetDuration: targetDuration ?? "",
                })
              }
              options={[15, 30, 60].map((value) => ({
                value: String(value),
                label: `${value} ${t("videoWizard.seconds")}`,
              }))}
            />
          </label>
          <label>
            {t("videoWizard.style")}
            <Select
              allowClear
              value={brief.style || undefined}
              onChange={(style) => changeBrief({ style: style ?? "" })}
              options={["natural", "elegant", "energetic", "minimal"].map(
                (value) => ({
                  value,
                  label: t(`videoWizard.styles.${value}`),
                }),
              )}
            />
          </label>
          <label>
            {t("videoWizard.language")}
            <Select
              value={request.language}
              onChange={(language) => changeRequest({ language })}
              options={[
                { value: "zh", label: "中文" },
                { value: "en", label: "English" },
              ]}
            />
          </label>
          <label>
            {t("videoWizard.format")}
            <Radio.Group
              value={request.format}
              onChange={(e) => changeRequest({ format: e.target.value })}
              optionType="button"
              buttonStyle="solid"
              options={[
                { value: "portrait", label: "9:16" },
                { value: "landscape", label: "16:9" },
                { value: "square", label: "1:1" },
              ]}
            />
            {formatNote && (
              <span
                className={
                  requiredFormats.length > 1
                    ? styles.formatHintWarning
                    : styles.formatHint
                }
              >
                {formatNote}
              </span>
            )}
          </label>
        </div>
        <Checkbox
          checked={request.include_selling_points}
          onChange={(e) =>
            changeRequest({
              include_selling_points: e.target.checked,
            })
          }
        >
          {t("videoWizard.includeSellingPoints")}
        </Checkbox>
        <div className={styles.narrationRow}>
          <Checkbox
            checked={narrationEnabled}
            disabled={busy || !narrationAvailable}
            onChange={(e) => changeNarrationEnabled(e.target.checked)}
          >
            {t("videoWizard.narration")}
          </Checkbox>
          {narrationEnabled && narrationOptions?.voices.length ? (
            <Select
              size="small"
              aria-label={t("videoWizard.narrationVoice")}
              value={narrationVoice || undefined}
              onChange={(value) => changeNarrationVoice(value ?? "")}
              placeholder={t("videoWizard.narrationVoice")}
              options={narrationOptions.voices.map((voice) => ({
                value: voice.id,
                label: voice.label,
              }))}
            />
          ) : null}
          {narrationEnabled && !narrationOptions?.premium ? (
            <span className={styles.narrationHint}>
              {t("videoWizard.narrationLocalHint")}
            </span>
          ) : null}
        </div>
        <div className={styles.narrationRow}>
          <Checkbox
            checked={bgmEnabled}
            disabled={busy}
            onChange={(e) => changeBgmEnabled(e.target.checked)}
          >
            {t("videoWizard.bgm")}
          </Checkbox>
          {bgmEnabled && bgmOptions?.items.length ? (
            <>
              <Select
                size="small"
                showSearch
                optionFilterProp="label"
                aria-label={t("videoWizard.bgmTrack")}
                value={bgmId || bgmOptions.default || undefined}
                onChange={(value) => changeBgmId(value ?? "")}
                placeholder={t("videoWizard.bgmTrack")}
                options={bgmOptions.items.map((track) => ({
                  value: track.id,
                  label: track.bpm
                    ? `${track.name} · ${Math.round(track.bpm)} BPM`
                    : track.name,
                }))}
              />
              {(() => {
                const current = bgmId || bgmOptions.default || "";
                if (!current) return null;
                const playing = bgmPreview === current;
                return (
                  <Button
                    size="small"
                    type="text"
                    disabled={busy}
                    aria-label={
                      playing
                        ? t("videoWizard.bgmPreviewStop")
                        : t("videoWizard.bgmPreview")
                    }
                    title={
                      playing
                        ? t("videoWizard.bgmPreviewStop")
                        : t("videoWizard.bgmPreview")
                    }
                    icon={playing ? <X size={14} /> : <Play size={14} />}
                    onClick={() => toggleBgmPreview(current)}
                  />
                );
              })()}
            </>
          ) : null}
        </div>
        <Input.TextArea
          className={styles.sellingPoints}
          rows={3}
          maxLength={1200}
          disabled={Boolean(project) || busy}
          value={brief.sellingPoints}
          onChange={(e) => changeBrief({ sellingPoints: e.target.value })}
          placeholder={t("videoWizard.sellingPointsSupplement")}
        />
        <details className={styles.advanced}>
          <summary>{t("videoWizard.advanced")}</summary>
          <label className={styles.secondsPerAsset}>
            {t("videoWizard.secondsPerAsset")}
            <InputNumber
              min={1}
              max={15}
              value={request.seconds_per_asset}
              onChange={(value) =>
                changeRequest({ seconds_per_asset: value ?? 4 })
              }
            />
          </label>
          <Input.TextArea
            rows={4}
            maxLength={2400}
            showCount
            value={brief.extra}
            onChange={(e) => changeBrief({ extra: e.target.value })}
            placeholder={t("videoWizard.instructionsHint")}
          />
        </details>
        <Typography.Paragraph type="secondary">
          {t("videoWizard.durationNote")}
        </Typography.Paragraph>
      </Card>
    </section>
  );
}
