import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Empty,
  Select,
  Space,
  Tag,
  Typography,
  Upload,
} from "antd";
import { Image as ImageIcon, Upload as UploadIcon } from "lucide-react";
import type {
  Product,
  ProductProject,
  ProductSnapshotAsset,
} from "../../api/modules/productLibrary";
import { mediaType } from "./sceneAssets";
import { useTranslation } from "react-i18next";
import styles from "./index.module.less";

interface ProductStageProps {
  products: Product[];
  product: Product | null;
  project: ProductProject | null;
  sceneAssets: ProductSnapshotAsset[];
  imageUrls: Record<string, string>;
  busy: boolean;
  uploadBusy: boolean;
  uploadProgress: string;
  uploads: File[];
  uploadFileIds: MutableRefObject<WeakMap<File, string>>;
  nextUploadFileId: MutableRefObject<number>;
  setUploads: Dispatch<SetStateAction<File[]>>;
  setError: (error: string) => void;
  uploadAssets: () => Promise<void>;
  assetLoadFailed: boolean;
  retryAssets: () => void;
  selectedAssetIds: string[];
  setSelectedAssetIds: Dispatch<SetStateAction<string[]>>;
  pickProduct: (id: string) => void;
  backToLibrary: () => void;
}

export function ProductStage({
  products,
  product,
  project,
  sceneAssets,
  imageUrls,
  busy,
  uploadBusy,
  uploadProgress,
  uploads,
  uploadFileIds,
  nextUploadFileId,
  setUploads,
  setError,
  uploadAssets,
  assetLoadFailed,
  retryAssets,
  selectedAssetIds,
  setSelectedAssetIds,
  pickProduct,
  backToLibrary,
}: ProductStageProps) {
  const { t } = useTranslation();
  return (
    <section>
      <div className={styles.sectionHeader}>
        <div>
          <Typography.Title level={3}>
            {t("videoWizard.chooseTitle")}
          </Typography.Title>
          <Typography.Text type="secondary">
            {t("videoWizard.chooseHint")}
          </Typography.Text>
        </div>
      </div>
      <Card className={styles.summary}>
        <Space wrap>
          <Select
            aria-label={t("videoWizard.product")}
            placeholder={t("videoWizard.chooseProduct")}
            value={product?.id}
            onChange={pickProduct}
            disabled={busy || uploadBusy}
            options={products.map((item) => ({
              value: item.id,
              label: `${item.name}${item.model ? ` · ${item.model}` : ""}`,
            }))}
            className={styles.productSelect}
          />
          {product && (
            <Tag>
              {t("videoWizard.snapshotAssets", {
                count: sceneAssets.length,
              })}
            </Tag>
          )}
          <Button onClick={backToLibrary}>
            {t("videoWizard.backToLibrary")}
          </Button>
        </Space>
      </Card>
      {product && (
        <>
          <div className={styles.assetToolbar}>
            <Typography.Title level={4}>
              {t("videoWizard.sceneAssets")}
            </Typography.Title>
            <Space wrap>
              <Upload
                multiple
                accept=".png,.jpg,.jpeg,.gif,.webp,.bmp,.avif,.mp4,.webm,.mov,.m4v"
                beforeUpload={(file) => {
                  if (
                    !/\.(png|jpe?g|gif|webp|bmp|avif|mp4|webm|mov|m4v)$/i.test(
                      file.name,
                    )
                  ) {
                    setError(t("videoWizard.unsupportedMedia"));
                    return Upload.LIST_IGNORE;
                  }
                  setUploads((list) => [...list, file]);
                  return false;
                }}
                fileList={uploads.map((file) => ({
                  uid: (() => {
                    let id = uploadFileIds.current.get(file);
                    if (!id) {
                      id = `wizard-upload-${nextUploadFileId.current++}`;
                      uploadFileIds.current.set(file, id);
                    }
                    return id;
                  })(),
                  name: file.name,
                  status: "done" as const,
                }))}
                onRemove={(file) => {
                  setUploads((list) =>
                    list.filter(
                      (item) => uploadFileIds.current.get(item) !== file.uid,
                    ),
                  );
                  return true;
                }}
              >
                <Button
                  icon={<UploadIcon size={15} />}
                  disabled={Boolean(project) || busy || uploadBusy}
                >
                  {t("videoWizard.addAssets")}
                </Button>
              </Upload>
              {uploadProgress && (
                <Typography.Text>{uploadProgress}</Typography.Text>
              )}
              <Typography.Text type="secondary">
                {t("videoWizard.supportedFormats")}
              </Typography.Text>
              {!!uploads.length && (
                <Button
                  loading={uploadBusy}
                  disabled={uploadBusy}
                  onClick={() => void uploadAssets()}
                >
                  {t("videoWizard.uploadAssets")}
                </Button>
              )}
            </Space>
          </div>
          {project && (
            <Alert
              type="info"
              showIcon
              message={t("videoWizard.snapshotLocked")}
            />
          )}
          {assetLoadFailed ? (
            <Empty description={t("videoWizard.assetsFailed")}>
              <Button onClick={retryAssets}>
                {t("videoWizard.loadRetry")}
              </Button>
            </Empty>
          ) : sceneAssets.length ? (
            <div className={styles.assetGrid}>
              {sceneAssets.map((asset) => {
                const checked = selectedAssetIds.includes(asset.id);
                return (
                  <button
                    key={asset.id}
                    type="button"
                    className={`${styles.assetTile} ${
                      checked ? styles.assetSelected : ""
                    }`}
                    onClick={() =>
                      !project &&
                      setSelectedAssetIds((ids) =>
                        checked
                          ? ids.filter((id) => id !== asset.id)
                          : [...ids, asset.id],
                      )
                    }
                    disabled={Boolean(project) || busy || uploadBusy}
                  >
                    <div className={styles.assetThumb}>
                      {imageUrls[asset.id] ? (
                        mediaType(asset) === "image" ? (
                          <img src={imageUrls[asset.id]} alt="" />
                        ) : (
                          <video
                            src={imageUrls[asset.id]}
                            muted
                            preload="metadata"
                          />
                        )
                      ) : (
                        <ImageIcon size={25} />
                      )}
                    </div>
                    <span>{asset.filename}</span>
                    <Checkbox checked={checked} disabled={Boolean(project)} />
                  </button>
                );
              })}
            </div>
          ) : (
            <Empty description={t("videoWizard.noSceneAssets")} />
          )}
          {product.selling_points.length > 0 && (
            <Typography.Paragraph type="secondary" className={styles.points}>
              {t("videoWizard.productPoints", {
                points: product.selling_points.join(" · "),
              })}
            </Typography.Paragraph>
          )}
        </>
      )}
    </section>
  );
}
