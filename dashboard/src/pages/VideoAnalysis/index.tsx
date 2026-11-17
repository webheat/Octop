import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Input,
  Space,
  Tabs,
  Tag,
  Typography,
  Upload,
} from "antd";
import { ArrowLeft } from "lucide-react";
import PageShell from "../../layouts/PageShell";
import { useCurrentUser } from "../../hooks/useCurrentUser";
import { useDesktopMinimalMode } from "../../hooks/useDesktopMinimalMode";
import { isPaidTierUser } from "../../utils/permissions";

const { Dragger } = Upload;
const { Text } = Typography;

/**
 * Paid-tier feature shape. Until the analysis backend lands, every control is
 * inert; the page explains why the current account type cannot use it.
 */
export default function VideoAnalysisPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const user = useCurrentUser();
  const unlocked = isPaidTierUser(user);
  // In the customer-facing shell there is no navigation rail, so this page
  // needs its own way back to the landing surface.
  const desktopMinimal = useDesktopMinimalMode();

  const role = user?.role;
  const roleLabel =
    role === "admin"
      ? t("videoAnalysis.roleAdmin")
      : role === "premium"
      ? t("videoAnalysis.rolePremium")
      : role === "user"
      ? t("videoAnalysis.roleUser")
      : role ?? t("videoAnalysis.roleOther");

  const optionItems = [
    { label: t("videoAnalysis.optionShots"), value: "shots" },
    { label: t("videoAnalysis.optionSubtitle"), value: "subtitle" },
    { label: t("videoAnalysis.optionPace"), value: "pace" },
    { label: t("videoAnalysis.optionStyle"), value: "style" },
  ];

  const tabItems = [
    {
      key: "link",
      label: t("videoAnalysis.linkTab"),
      children: (
        <Space.Compact style={{ width: "100%" }}>
          <Input disabled placeholder={t("videoAnalysis.linkPlaceholder")} />
          <Button disabled>{t("videoAnalysis.linkAction")}</Button>
        </Space.Compact>
      ),
    },
    {
      key: "file",
      label: t("videoAnalysis.fileTab"),
      children: (
        <Dragger
          showUploadList={false}
          multiple={false}
          style={{ padding: 12 }}
        >
          <p style={{ margin: 0, color: "var(--fn-text-secondary)" }}>
            {t("videoAnalysis.uploadTitle")}
          </p>
          <p style={{ margin: "6px 0 12px" }}>
            <Text type="secondary">{t("videoAnalysis.uploadHint")}</Text>
          </p>
          <Button disabled>{t("videoAnalysis.uploadAction")}</Button>
        </Dragger>
      ),
    },
  ];

  return (
    <PageShell
      title={t("videoAnalysis.title")}
      subtitle={t("videoAnalysis.subtitle")}
      actions={
        <Space size={8}>
          {desktopMinimal && (
            <Button
              icon={<ArrowLeft size={14} />}
              onClick={() => navigate("/product-library")}
            >
              {t("videoAnalysis.backToLibrary")}
            </Button>
          )}
          <Tag color="gold">{t("videoAnalysis.paidBadge")}</Tag>
        </Space>
      }
    >
      <div style={{ display: "grid", gap: 16, maxWidth: 800 }}>
        {unlocked ? (
          <Alert
            type="info"
            showIcon
            message={t("videoAnalysis.paidPendingTitle")}
            description={t("videoAnalysis.paidPendingHint")}
          />
        ) : (
          <Alert
            type="warning"
            showIcon
            message={t("videoAnalysis.lockedTitle")}
            description={t("videoAnalysis.lockedHint", { role: roleLabel })}
          />
        )}
        <div style={{ opacity: 0.55, pointerEvents: "none" }}>
          <Card
            title={t("videoAnalysis.sourceTitle")}
            extra={<Tag>{t("videoAnalysis.previewTag")}</Tag>}
          >
            <Text type="secondary">{t("videoAnalysis.sourceHint")}</Text>
            <div style={{ marginTop: 12 }}>
              <Tabs items={tabItems} />
            </div>
          </Card>
          <Card
            title={t("videoAnalysis.optionsTitle")}
            style={{ marginTop: 16 }}
          >
            <Checkbox.Group
              disabled
              value={optionItems.map((option) => option.value)}
              options={optionItems}
              style={{ display: "grid", gap: 10 }}
            />
          </Card>
          <Button type="primary" disabled style={{ marginTop: 16 }}>
            {t("videoAnalysis.start")}
          </Button>
        </div>
      </div>
    </PageShell>
  );
}
