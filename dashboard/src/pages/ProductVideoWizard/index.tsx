import { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Button,
  Card,
  Checkbox,
  ConfigProvider,
  Empty,
  Input,
  InputNumber,
  Progress,
  Radio,
  Select,
  Space,
  Spin,
  Tag,
  Typography,
  Upload,
} from "antd";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  Clock3,
  Circle,
  Download,
  Image as ImageIcon,
  LoaderCircle,
  Play,
  RefreshCw,
  Sparkles,
  Upload as UploadIcon,
  X,
} from "lucide-react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  productLibraryApi,
  type BgmOptions,
  type NarrationOptions,
  type Product,
  type ProductAsset,
  type ProductProject,
  type ProductSnapshotAsset,
  type StoryboardDraft,
  type StoryboardScene,
  type StoryboardScript,
  type VideoPlanRequest,
} from "../../api/modules/productLibrary";
import { useCurrentUser } from "../../hooks/useCurrentUser";
import PageShell from "../../layouts/PageShell";
import {
  isActiveDesktopVideoJob,
  useDesktopVideoJobs,
  type DesktopVideoJob,
} from "../../context/DesktopVideoJobsContext";
import { message } from "../../utils/antdMessage";
import {
  decodeVideoBrief,
  EMPTY_VIDEO_BRIEF,
  encodeVideoBrief,
  joinPlatforms,
  splitPlatforms,
  type VideoBrief,
} from "./brief";

/** Platforms offered as checkboxes, in display order. */
const PLATFORM_KEYS = [
  "douyin",
  "xiaohongshu",
  "channels",
  "kuaishou",
  "bilibili",
  "tiktok",
  "instagram",
  "youtube",
] as const;
import styles from "./index.module.less";

/** Aspect ratio a platform expects for short-form video. */
type VideoFormat = VideoPlanRequest["format"];

/**
 * Vertical-first apps take 9:16; long-form video sites take 16:9. Kept in one
 * place so the ratio picker can follow the platform selection instead of
 * silently producing a single ratio for a mixed list.
 */
const PLATFORM_FORMATS: Record<(typeof PLATFORM_KEYS)[number], VideoFormat> = {
  douyin: "portrait",
  xiaohongshu: "portrait",
  channels: "portrait",
  kuaishou: "portrait",
  bilibili: "landscape",
  tiktok: "portrait",
  instagram: "portrait",
  youtube: "landscape",
};

const FORMAT_LABELS: Record<VideoFormat, string> = {
  portrait: "9:16",
  landscape: "16:9",
  square: "1:1",
};

const initialRequest: VideoPlanRequest = {
  instructions: "",
  format: "portrait",
  language: "zh",
  seconds_per_asset: 4,
  include_selling_points: true,
};
const steps = [
  "chooseProduct",
  "requirements",
  "storyboard",
  "confirm",
  "download",
];

function nativeErrorMessage(error: unknown, t: (key: string) => string) {
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code ?? "INTERNAL")
      : "INTERNAL";
  return t(`videoWizard.desktopErrors.${code}`);
}

function nativeStage(job: DesktopVideoJob) {
  return job.state === "downloading" ? "preparing" : job.state;
}

function mediaType(asset: ProductSnapshotAsset) {
  return asset.media_type.startsWith("image/")
    ? "image"
    : asset.media_type.startsWith("video/")
    ? "video"
    : null;
}

function exportName(asset: ProductSnapshotAsset, index: number) {
  const safe = asset.filename
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[._]+|[._]+$/g, "");
  return `${asset.id}-${safe || `asset-${index}`}`;
}

function isNotFound(error: unknown) {
  return error instanceof Error && /Request failed: 404/.test(error.message);
}

export default function ProductVideoWizardPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const currentUser = useCurrentUser();
  const userId = currentUser?.id;
  const desktopVideo = useDesktopVideoJobs();
  const isDesktop =
    desktopVideo.bridgeAvailable || window.octopDesktopVideo?.version === 1;
  const requestedProjectId = params.get("project");
  const requestedProductId = params.get("product");
  const routeSelection = location.state as { productId?: string; assetIds?: string[]; ownerId?: number | string } | null;
  const hasOwnedRouteSelection = Boolean(
    routeSelection &&
      userId != null &&
      routeSelection.productId &&
      Array.isArray(routeSelection.assetIds) &&
      String(routeSelection.ownerId) === String(userId),
  );
  const [step, setStep] = useState(0);
  const [products, setProducts] = useState<Product[]>([]);
  const [product, setProduct] = useState<Product | null>(null);
  const [assets, setAssets] = useState<ProductAsset[]>([]);
  const [selectedAssetIds, setSelectedAssetIds] = useState<string[]>([]);
  const [project, setProject] = useState<ProductProject | null>(null);
  const [request, setRequest] = useState<VideoPlanRequest>({
    ...initialRequest,
  });
  const [draft, setDraft] = useState<StoryboardDraft | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [nativeBusy, setNativeBusy] = useState(false);
  const [environmentBusy, setEnvironmentBusy] = useState(false);
  const [nativeSaving, setNativeSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [loadFailed, setLoadFailed] = useState(false);
  const [assetLoadFailed, setAssetLoadFailed] = useState(false);
  const [assetRetry, setAssetRetry] = useState(0);
  const [previewRetry, setPreviewRetry] = useState(0);
  const [uploads, setUploads] = useState<File[]>([]);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadProgress, setUploadProgress] = useState("");
  const [brief, setBrief] = useState<VideoBrief>({ ...EMPTY_VIDEO_BRIEF });
  const [narrationOptions, setNarrationOptions] =
    useState<NarrationOptions | null>(null);
  const [narrationEnabled, setNarrationEnabled] = useState(false);
  const [narrationVoice, setNarrationVoice] = useState("");
  const [bgmOptions, setBgmOptions] = useState<BgmOptions | null>(null);
  const [bgmEnabled, setBgmEnabled] = useState(true);
  const [bgmId, setBgmId] = useState("");
  // Auditioning is single-track on purpose: starting a second preview stops the
  // first, so the wizard never plays two soundtracks over each other.
  const [bgmPreview, setBgmPreview] = useState("");
  const bgmPreviewRef = useRef<HTMLAudioElement | null>(null);
  const environmentSupported = desktopVideo.environmentSupported === true;
  const environmentStatus = desktopVideo.environmentStatus;
  const environmentReady =
    !environmentSupported || environmentStatus.state === "ready";
  // Narration needs the desktop client: the browser cannot hand an audio file
  // to the renderer, and the local voice only exists on Windows. When the
  // account capabilities are still unknown the free tier is assumed, so the
  // toggle stays usable instead of flickering.
  const narrationAvailable = isDesktop;
  const environmentInstallerURL =
    desktopVideo.environmentInstallerURL &&
    /^https?:\/\//i.test(desktopVideo.environmentInstallerURL)
      ? desktopVideo.environmentInstallerURL
      : undefined;
  const urlsRef = useRef<Record<string, string>>({});
  const uploadFileIds = useRef(new WeakMap<File, string>());
  const nextUploadFileId = useRef(0);
  const requestVersion = useRef(0);
  const productIdRef = useRef<string | null>(null);
  const tRef = useRef(t);
  tRef.current = t;

  useEffect(() => {
    if (!environmentSupported || environmentStatus.state !== "unknown") return;
    void desktopVideo.checkEnvironment().catch(() => undefined);
  }, [
    desktopVideo.checkEnvironment,
    environmentStatus.state,
    environmentSupported,
  ]);

  // Narration capabilities depend on the account tier, so they are fetched
  // once and cached for the wizard session.
  useEffect(() => {
    let active = true;
    void productLibraryApi
      .narrationOptions()
      .then((options) => {
        if (active) setNarrationOptions(options);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  // The BGM catalogue is static per deployment, so one fetch per wizard visit
  // is enough. An empty list simply hides the picker and the export keeps the
  // server's default track.
  useEffect(() => {
    let active = true;
    void productLibraryApi
      .bgmOptions()
      .then((options) => {
        if (active) setBgmOptions(options);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  const cleanUrls = () => {
    Object.values(urlsRef.current).forEach(URL.revokeObjectURL);
    urlsRef.current = {};
  };

  // Leaving the wizard must not leave a soundtrack playing behind it.
  useEffect(
    () => () => {
      bgmPreviewRef.current?.pause();
      bgmPreviewRef.current = null;
    },
    [],
  );

  const toggleBgmPreview = (trackId: string) => {
    const playing = bgmPreviewRef.current;
    if (bgmPreview === trackId && playing) {
      playing.pause();
      bgmPreviewRef.current = null;
      setBgmPreview("");
      return;
    }
    playing?.pause();
    const audio = new Audio(productLibraryApi.bgmStreamUrl(trackId));
    audio.onended = () => setBgmPreview("");
    audio.onerror = () => {
      setBgmPreview("");
      message.error(t("videoWizard.bgmPreviewFailed"));
    };
    bgmPreviewRef.current = audio;
    setBgmPreview(trackId);
    void audio.play().catch(() => setBgmPreview(""));
  };

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadFailed(false);
    setProducts([]);
    setProduct(null);
    productIdRef.current = null;
    setAssets([]);
    setSelectedAssetIds([]);
    setProject(null);
    setDraft(null);
    setSaved(false);
    setStep(0);
    setRequest({ ...initialRequest });
    setBrief({ ...EMPTY_VIDEO_BRIEF });
    setUploads([]);
    setUploadBusy(false);
    setUploadProgress("");
    setError("");
    setBusy(false);
    setNativeBusy(false);
    setEnvironmentBusy(false);
    setNativeSaving(false);
    cleanUrls();
    setImageUrls({});
    const version = ++requestVersion.current;
    Promise.all([productLibraryApi.products(), productLibraryApi.projects()])
      .then(async ([p, pr]) => {
        if (!active || version !== requestVersion.current) return;
        setProducts(p.items);
        if (requestedProjectId) {
          const found = pr.items.find((item) => item.id === requestedProjectId);
          if (found) {
            setProject(found);
            setProduct(found.snapshot.product);
            productIdRef.current = found.product_id;
            setSelectedAssetIds(
              found.snapshot.assets
                .filter((a) => a.usage === "scene" && mediaType(a))
                .map((a) => a.id),
            );
            await productLibraryApi
              .getStoryboard(found.id)
              .then((loaded) => {
                if (!active || version !== requestVersion.current) return;
                setDraft(loaded);
                setRequest(loaded.request);
                setNarrationEnabled(loaded.narration_enabled === true);
                setNarrationVoice(loaded.narration_voice || "");
                setBgmEnabled(loaded.bgm_enabled !== false);
                setBgmId(loaded.bgm_id || "");
                const restoredBrief = decodeVideoBrief(
                  loaded.request.instructions,
                );
                setBrief({
                  ...restoredBrief,
                  sellingPoints:
                    restoredBrief.sellingPoints ||
                    found.snapshot.product.selling_points.join("\n"),
                });
                setSaved(true);
                setStep(loaded.confirmed ? 4 : 3);
              })
              .catch((err: unknown) => {
                if (!active || version !== requestVersion.current) return;
                if (isNotFound(err)) {
                  setStep(1);
                  setRequest({ ...initialRequest });
                  setBrief((current) => ({ ...current, extra: "" }));
                } else setError(tRef.current("videoWizard.loadFailed"));
              });
          } else {
            setError(tRef.current("videoWizard.unknownProject"));
          }
        } else {
          const routeProductId = hasOwnedRouteSelection
            ? routeSelection?.productId
            : requestedProductId;
          const routedProduct = p.items.find((item) => item.id === routeProductId);
          if (routedProduct) {
            setProduct(routedProduct);
            productIdRef.current = routedProduct.id;
            setBrief({
              ...EMPTY_VIDEO_BRIEF,
              sellingPoints: routedProduct.selling_points.join("\n"),
            });
          } else if (routeProductId) {
            setError(tRef.current("videoWizard.unknownProduct"));
          }
        }
      })
      .catch(() => {
        if (active && version === requestVersion.current) {
          setError(tRef.current("videoWizard.loadFailed"));
          setLoadFailed(true);
        }
      })
      .finally(() => {
        if (active && version === requestVersion.current) setLoading(false);
      });
    return () => {
      active = false;
      cleanUrls();
    };
    // ``location.key`` is deliberately absent: it changes on every
    // navigation, including the one that puts the freshly generated project
    // into the URL. Depending on it would tear the whole wizard down and
    // rebuild it right after the picture was generated.
  }, [userId, requestedProjectId, requestedProductId]);

  useEffect(() => {
    if (!product || project) return;
    let current = true;
    const id = product.id;
    productIdRef.current = id;
    setAssets([]);
    setSelectedAssetIds([]);
    cleanUrls();
    setImageUrls({});
    void productLibraryApi
      .assets(id)
      .then(({ items }) => {
        if (!current) return;
        setAssetLoadFailed(false);
        setAssets(items);
        const available = items.filter(
          (asset) => asset.product_id === id && asset.active && asset.usage === "scene" && mediaType(asset),
        );
        const explicitIds = hasOwnedRouteSelection && routeSelection?.productId === id
          ? routeSelection.assetIds
          : undefined;
        setSelectedAssetIds(
          explicitIds
            ? available.filter((asset) => explicitIds.includes(asset.id)).map((asset) => asset.id)
            : available.map((asset) => asset.id),
        );
      })
      .catch(() => {
        if (current) {
          setError(tRef.current("videoWizard.assetsFailed"));
          setAssetLoadFailed(true);
        }
      });
    return () => {
      current = false;
    };
  }, [product?.id, project?.id, assetRetry, hasOwnedRouteSelection, location.key]);

  const allSnapshotSceneAssets = useMemo(
    () =>
      project
        ? project.snapshot.assets.filter((asset) => asset.usage === "scene")
        : assets.filter(
            (asset) =>
              asset.product_id === product?.id &&
              asset.active &&
              asset.usage === "scene",
          ),
    [assets, product?.id, project],
  );
  const orderedSceneAssets = useMemo(
    () =>
      [...allSnapshotSceneAssets].sort(
        (a, b) => Number(b.priority) - Number(a.priority),
      ),
    [allSnapshotSceneAssets],
  );
  const sceneAssets = useMemo(
    () => orderedSceneAssets.filter((asset) => mediaType(asset)),
    [orderedSceneAssets],
  );
  const assetByExportName = useMemo(() => {
    const result = new Map<string, ProductSnapshotAsset>();
    orderedSceneAssets.forEach((asset, index) =>
      result.set(exportName(asset, index), asset),
    );
    return result;
  }, [orderedSceneAssets]);
  const totalDuration =
    draft?.script.scenes.reduce((sum, scene) => sum + scene.duration, 0) ?? 0;
  const [imageUrls, setImageUrls] = useState<Record<string, string>>({});
  const desktopJob = desktopVideo.jobs.find(
    (job) => job.projectId === project?.id,
  );
  const coverScene = draft?.script.scenes.find(
    (scene) => scene.type === "image" || scene.type === "video",
  );
  const coverAsset = coverScene?.asset
    ? assetByExportName.get(coverScene.asset)
    : undefined;
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

  const pickProduct = (id: string) => {
    requestVersion.current += 1;
    const next = products.find((item) => item.id === id) ?? null;
    setProject(null);
    setDraft(null);
    setSaved(false);
    setUploads([]);
    setUploadBusy(false);
    setUploadProgress("");
    setProduct(next);
    productIdRef.current = next?.id ?? null;
    setBrief({
      ...EMPTY_VIDEO_BRIEF,
      sellingPoints: next?.selling_points.join("\n") ?? "",
    });
    setError("");
  };

  const changeBrief = (patch: Partial<typeof brief>) => {
    if (patch.sellingPoints !== undefined) {
      patch = {
        ...patch,
        sellingPoints: patch.sellingPoints
          .split("\n")
          .slice(0, 8)
          .map((line) => line.slice(0, 150))
          .join("\n"),
      };
    }
    setBrief((current) => ({ ...current, ...patch }));
    setSaved(false);
    setDraft((current) =>
      current ? { ...current, confirmed: false } : current,
    );
  };
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
  const changeRequest = (patch: Partial<VideoPlanRequest>) => {
    setRequest((current) => ({ ...current, ...patch }));
    setSaved(false);
    setDraft((current) =>
      current ? { ...current, confirmed: false } : current,
    );
  };

  const uploadAssets = async () => {
    if (!product || !uploads.length) return;
    const id = product.id;
    const version = requestVersion.current;
    const batch = [...uploads];
    const existingIds = new Set(assets.map((asset) => asset.id));
    const uploadedIds: string[] = [];
    let succeeded = 0;
    setUploadBusy(true);
    setError("");
    try {
    for (const [index, file] of batch.entries()) {
      if (productIdRef.current !== id || requestVersion.current !== version) break;
      setUploadProgress(t("videoWizard.uploadProgress", { done: index, total: batch.length }));
      try {
        const result = await productLibraryApi.upload(id, [file], "scene");
        if (productIdRef.current !== id || requestVersion.current !== version) break;
        uploadedIds.push(...result.items.filter((asset) => !existingIds.has(asset.id) && asset.active && asset.usage === "scene" && mediaType(asset)).map((asset) => asset.id));
        succeeded += 1;
        setUploads((current) => current.filter((item) => item !== file));
      } catch {
        // Keep failed entries in the queue for an explicit retry.
      }
    }
    if (productIdRef.current === id && requestVersion.current === version) {
      try {
        const loaded = await productLibraryApi.assets(id);
        if (productIdRef.current !== id || requestVersion.current !== version) return;
        setAssets(loaded.items);
        const valid = new Set(loaded.items.filter((asset) => asset.active && asset.usage === "scene" && mediaType(asset)).map((asset) => asset.id));
        setSelectedAssetIds((current) => [...new Set([...current.filter((assetId) => valid.has(assetId)), ...uploadedIds.filter((assetId) => valid.has(assetId))])]);
        if (succeeded) message.success(t("videoWizard.uploadedCount", { count: succeeded }));
        if (batch.length > succeeded) setError(t("videoWizard.uploadFailedCount", { count: batch.length - succeeded }));
      } catch {
        if (productIdRef.current === id && requestVersion.current === version) setError(t("videoWizard.uploadFailed"));
      }
    }
    } finally {
      if (productIdRef.current === id && requestVersion.current === version) {
        setUploadBusy(false);
        setUploadProgress("");
      }
    }
  };

  const buildPlanRequest = (): VideoPlanRequest => {
    return { ...request, instructions: encodeVideoBrief(brief) };
  };

  const generate = async () => {
    if (!product || (!project && !selectedAssetIds.length)) return;
    let planRequest: VideoPlanRequest;
    try {
      planRequest = buildPlanRequest();
    } catch {
      setError(t("videoWizard.briefTooLong"));
      return;
    }
    const version = ++requestVersion.current;
    setBusy(true);
    setError("");
    setStep(2);
    try {
      let currentProduct = product;
      if (
        !project &&
        currentProduct &&
        brief.sellingPoints !== currentProduct.selling_points.join("\n")
      ) {
        currentProduct = await productLibraryApi.updateProduct(
          currentProduct.id,
          {
            name: currentProduct.name,
            model: currentProduct.model,
            category: currentProduct.category,
            selling_points: brief.sellingPoints
              .split("\n")
              .map((value) => value.trim().slice(0, 150))
              .filter(Boolean)
              .slice(0, 8),
            parameters: currentProduct.parameters,
            expression_limits: currentProduct.expression_limits,
          },
        );
        if (version !== requestVersion.current) return;
        setProduct(currentProduct);
      }
      let activeProject = project;
      if (!activeProject) {
        activeProject = await productLibraryApi.createProject({
          product_id: currentProduct!.id,
          name: `${currentProduct!.name} · ${t("videoWizard.projectSuffix")}`,
          asset_ids: selectedAssetIds,
        });
        if (version !== requestVersion.current) return;
        setProject(activeProject);
      }
      const result = await productLibraryApi.generateStoryboard(
        activeProject.id,
        planRequest,
      );
      if (version !== requestVersion.current) return;
      setRequest(planRequest);
      setDraft(result.draft);
      // The narration settings live beside the script, so regenerating the
      // picture leaves them alone; keep the local copy as the source of truth.
      setSaved(true);
      setStep(3);
      navigate(
        `/product-library/video-wizard?project=${encodeURIComponent(
          activeProject.id,
        )}`,
        { replace: true },
      );
    } catch {
      if (version === requestVersion.current) {
        setError(t("videoWizard.generateFailed"));
        setStep(draft ? 3 : 1);
      }
    } finally {
      if (version === requestVersion.current) setBusy(false);
    }
  };

  const updateScene = (index: number, patch: Partial<StoryboardScene>) => {
    setDraft((current) =>
      current
        ? {
            ...current,
            confirmed: false,
            script: {
              ...current.script,
              scenes: current.script.scenes.map((scene, i) =>
                i === index ? { ...scene, ...patch } : scene,
              ),
            },
          }
        : current,
    );
    setSaved(false);
  };

  const persist = async (confirmed: boolean) => {
    if (!project || !draft || (confirmed && !environmentReady)) return;
    let saveRequest: VideoPlanRequest;
    try {
      saveRequest = buildPlanRequest();
    } catch {
      setError(t("videoWizard.briefTooLong"));
      return;
    }
    const version = requestVersion.current;
    setBusy(true);
    setError("");
    try {
      const updated = await productLibraryApi.saveStoryboard(project.id, {
        request: saveRequest,
        script: draft.script,
        confirmed,
        narration_enabled: narrationEnabled,
        narration_voice: narrationVoice,
        bgm_enabled: bgmEnabled,
        bgm_id: bgmId || undefined,
      });
      if (version !== requestVersion.current) return;
      setDraft(updated);
      setSaved(true);
      if (confirmed) {
        setStep(4);
        if (isDesktop) {
          try {
            setNativeBusy(true);
            await desktopVideo.start(project.id);
          } catch (error) {
            if (version === requestVersion.current)
              setError(nativeErrorMessage(error, t));
          } finally {
            if (version === requestVersion.current) setNativeBusy(false);
          }
        }
      }
    } catch {
      if (version === requestVersion.current) {
        setError(t("videoWizard.saveFailed"));
        setSaved(false);
      }
    } finally {
      setBusy(false);
    }
  };

  const startNativeJob = async () => {
    if (!project || !environmentReady) return;
    setNativeBusy(true);
    setError("");
    try {
      await desktopVideo.start(project.id);
    } catch (nativeError) {
      setError(nativeErrorMessage(nativeError, t));
    } finally {
      setNativeBusy(false);
    }
  };

  const cancelNativeJob = async () => {
    if (!desktopJob) return;
    setNativeBusy(true);
    setError("");
    try {
      await desktopVideo.cancel(desktopJob.id);
    } catch (nativeError) {
      setError(nativeErrorMessage(nativeError, t));
    } finally {
      setNativeBusy(false);
    }
  };

  const retryNativeJob = async () => {
    if (!desktopJob || !environmentReady) return;
    setNativeBusy(true);
    setError("");
    try {
      await desktopVideo.retry(desktopJob.id);
    } catch (nativeError) {
      setError(nativeErrorMessage(nativeError, t));
    } finally {
      setNativeBusy(false);
    }
  };

  const saveNativeVideo = async () => {
    if (!desktopJob) return;
    setNativeSaving(true);
    setError("");
    try {
      const savedVideo = await desktopVideo.save(desktopJob.id);
      if (savedVideo) message.success(t("videoWizard.videoSaved"));
    } catch (nativeError) {
      setError(nativeErrorMessage(nativeError, t));
    } finally {
      setNativeSaving(false);
    }
  };

  const recheckEnvironment = async () => {
    setEnvironmentBusy(true);
    try {
      await desktopVideo.checkEnvironment(true);
    } catch {
      // The provider retains the localized error code in its status snapshot.
    } finally {
      setEnvironmentBusy(false);
    }
  };

  const verifyEnvironment = async () => {
    setEnvironmentBusy(true);
    try {
      await desktopVideo.verifyEnvironment();
    } catch {
      // The provider retains the localized error code in its status snapshot.
    } finally {
      setEnvironmentBusy(false);
    }
  };

  const download = async () => {
    if (!project || !draft?.confirmed || !saved) return;
    const version = requestVersion.current;
    setBusy(true);
    setError("");
    try {
      const blob = await productLibraryApi.downloadStoryboardPackage(
        project.id,
      );
      if (version !== requestVersion.current) return;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `storyboard-${project.id}.zip`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch {
      if (version === requestVersion.current)
        setError(t("videoWizard.exportFailed"));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!draft || (step !== 3 && !(step === 4 && isDesktop))) return;
    let active = true;
    const targets = [
      ...new Set(
        draft.script.scenes
          .filter((scene) => scene.type === "image" || scene.type === "video")
          .map((scene) =>
            scene.asset ? assetByExportName.get(scene.asset)?.id : undefined,
          )
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    targets.forEach((id) => {
      if (urlsRef.current[id]) return;
      void productLibraryApi
        .downloadAsset(id)
        .then((blob) => {
          const url = URL.createObjectURL(blob);
          if (!active) {
            URL.revokeObjectURL(url);
            return;
          }
          urlsRef.current[id] = url;
          setImageUrls((current) => ({ ...current, [id]: url }));
        })
        .catch(() => {
          if (active) setError(tRef.current("videoWizard.previewFailed"));
        });
    });
    return () => {
      active = false;
    };
  }, [draft?.script.scenes, step, isDesktop, assetByExportName, previewRetry]);

  useEffect(() => {
    if (step !== 0 || !selectedAssetIds.length) return;
    let active = true;
    selectedAssetIds.forEach((id) => {
      if (urlsRef.current[id]) return;
      void productLibraryApi
        .downloadAsset(id)
        .then((blob) => {
          const url = URL.createObjectURL(blob);
          if (!active) {
            URL.revokeObjectURL(url);
            return;
          }
          urlsRef.current[id] = url;
          setImageUrls((current) => ({ ...current, [id]: url }));
        })
        .catch(() => {
          if (active) setError(tRef.current("videoWizard.previewFailed"));
        });
    });
    return () => {
      active = false;
    };
  }, [step, selectedAssetIds]);

  const setStepSafe = (next: number) => {
    if ((isNativeActive || nativeBusy) && next <= 3) return;
    if (next > 0 && !product) return;
    if (next === 2 && !busy) return;
    if (next === 3 && !draft) return;
    if (next === 4 && !draft?.confirmed) return;
    setStep(next);
  };

  const environmentPanel = environmentSupported && (
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
            <li>{t("videoWizard.environment.installStepRun")}</li>
            <li>{t("videoWizard.environment.installStepRecheck")}</li>
          </ol>
          <Space wrap>
            {environmentInstallerURL ? (
              <Button
                type="primary"
                href={environmentInstallerURL}
                target="_blank"
                rel="noreferrer"
              >
                {t("videoWizard.environment.downloadComponents")}
              </Button>
            ) : (
              <Typography.Text type="secondary">
                {t("videoWizard.environment.contactAdmin")}
              </Typography.Text>
            )}
            <Button
              type={environmentInstallerURL ? "default" : "primary"}
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

  return (
    <PageShell
      title={t("videoWizard.title")}
      subtitle={t(
        isDesktop ? "videoWizard.desktopSubtitle" : "videoWizard.subtitle",
      )}
      fill
    >
      <ConfigProvider componentDisabled={busy || uploadBusy}>
        <div className={styles.wizard} data-busy={busy || uploadBusy}>
          <nav
            className={styles.steps}
            aria-label={t("videoWizard.stepsLabel")}
          >
            {steps.map((key, index) => (
              <button
                key={key}
                type="button"
                className={`${styles.step} ${
                  index <= step ? styles.stepActive : ""
                }`}
                onClick={() => setStepSafe(index === 2 && draft ? 3 : index)}
                disabled={
                  busy ||
                  uploadBusy ||
                  nativeBusy ||
                  (isNativeActive && index <= 3) ||
                  (index === 1 && !product) ||
                  (index === 2 && !draft && !busy) ||
                  (index === 3 && !draft) ||
                  (index === 4 && !draft?.confirmed)
                }
              >
                <span className={styles.stepCircle}>
                  {index < step ? <Check size={15} /> : index + 1}
                </span>
                <span className={styles.stepLabel}>
                  {t(
                    `videoWizard.${
                      index === 4 && isDesktop ? "makeVideo" : key
                    }`,
                  )}
                </span>
              </button>
            ))}
          </nav>

          {error && (
            <Alert
              type="error"
              showIcon
              message={error}
              closable
              onClose={() => setError("")}
              action={
                <Button
                  size="small"
                  onClick={() => {
                    setError("");
                    if (loadFailed) window.location.reload();
                    else if (assetLoadFailed)
                      setAssetRetry((value) => value + 1);
                    else if (error === t("videoWizard.previewFailed"))
                      setPreviewRetry((value) => value + 1);
                  }}
                >
                  {loadFailed ||
                  assetLoadFailed ||
                  error === t("videoWizard.previewFailed")
                    ? t("videoWizard.loadRetry")
                    : t("videoWizard.dismiss")}
                </Button>
              }
            />
          )}
          {loading ? (
            <div className={styles.loading}>
              <Spin />
            </div>
          ) : loadFailed ? null : products.length === 0 && !project ? (
            <Empty description={t("videoWizard.emptyProducts")}>
              <Button onClick={() => navigate("/product-library")}>
                {t("videoWizard.backToLibrary")}
              </Button>
            </Empty>
          ) : (
            <>
              {step === 0 && (
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
                          label: `${item.name}${
                            item.model ? ` · ${item.model}` : ""
                          }`,
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
                      <Button onClick={() => navigate("/product-library")}>
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
                              if (!/\.(png|jpe?g|gif|webp|bmp|avif|mp4|webm|mov|m4v)$/i.test(file.name)) {
                                setError(t("videoWizard.unsupportedMedia"));
                                return Upload.LIST_IGNORE;
                              }
                              setUploads((list) => [...list, file]);
                              return false;
                            }}
                            fileList={uploads.map((file) => ({
                              uid: (() => {
                                let id = uploadFileIds.current.get(file);
                                if (!id) { id = `wizard-upload-${nextUploadFileId.current++}`; uploadFileIds.current.set(file, id); }
                                return id;
                              })(),
                              name: file.name,
                              status: "done" as const,
                            }))}
                            onRemove={(file) => {
                              setUploads((list) =>
                                list.filter((item) => uploadFileIds.current.get(item) !== file.uid),
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
                          {uploadProgress && <Typography.Text>{uploadProgress}</Typography.Text>}
                          <Typography.Text type="secondary">{t("videoWizard.supportedFormats")}</Typography.Text>
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
                          <Button
                            onClick={() => setAssetRetry((value) => value + 1)}
                          >
                            {t("videoWizard.loadRetry")}
                          </Button>
                        </Empty>
                      ) : sceneAssets.length ? (
                        <div className={styles.assetGrid}>
                          {sceneAssets.map((asset) => {
                            const checked = project
                              ? selectedAssetIds.includes(asset.id)
                              : selectedAssetIds.includes(asset.id);
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
                                disabled={
                                  Boolean(project) || busy || uploadBusy
                                }
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
                                <Checkbox
                                  checked={checked}
                                  disabled={Boolean(project)}
                                />
                              </button>
                            );
                          })}
                        </div>
                      ) : (
                        <Empty description={t("videoWizard.noSceneAssets")} />
                      )}
                      {product.selling_points.length > 0 && (
                        <Typography.Paragraph
                          type="secondary"
                          className={styles.points}
                        >
                          {t("videoWizard.productPoints", {
                            points: product.selling_points.join(" · "),
                          })}
                        </Typography.Paragraph>
                      )}
                    </>
                  )}
                </section>
              )}

              {step === 1 && (
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
                          options={[
                            "launch",
                            "promotion",
                            "introduction",
                            "brand",
                          ].map((value) => ({
                            value,
                            label: t(`videoWizard.purposes.${value}`),
                          }))}
                        />
                      </label>
                      <label>
                        {t("videoWizard.audience")}
                        <Input
                          maxLength={200}
                          value={brief.audience}
                          onChange={(e) =>
                            changeBrief({ audience: e.target.value })
                          }
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
                              if (
                                selected.has(t(`videoWizard.platforms.${key}`))
                              ) {
                                formats.add(PLATFORM_FORMATS[key]);
                              }
                            });
                            // Every chosen platform agrees on one ratio: follow it.
                            if (
                              formats.size === 1 &&
                              [...formats][0] !== request.format
                            ) {
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
                          onChange={(style) =>
                            changeBrief({ style: style ?? "" })
                          }
                          options={[
                            "natural",
                            "elegant",
                            "energetic",
                            "minimal",
                          ].map((value) => ({
                            value,
                            label: t(`videoWizard.styles.${value}`),
                          }))}
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
                          onChange={(e) =>
                            changeRequest({ format: e.target.value })
                          }
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
                        onChange={(e) => {
                          setNarrationEnabled(e.target.checked);
                          setSaved(false);
                          setDraft((current) =>
                            current ? { ...current, confirmed: false } : current,
                          );
                        }}
                      >
                        {t("videoWizard.narration")}
                      </Checkbox>
                      {narrationEnabled && narrationOptions?.voices.length ? (
                        <Select
                          size="small"
                          aria-label={t("videoWizard.narrationVoice")}
                          value={narrationVoice || undefined}
                          onChange={(value) => {
                            setNarrationVoice(value ?? "");
                            setSaved(false);
                            setDraft((current) =>
                              current
                                ? { ...current, confirmed: false }
                                : current,
                            );
                          }}
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
                        onChange={(e) => {
                          setBgmEnabled(e.target.checked);
                          if (!e.target.checked) {
                            bgmPreviewRef.current?.pause();
                            bgmPreviewRef.current = null;
                            setBgmPreview("");
                          }
                          setSaved(false);
                          setDraft((current) =>
                            current ? { ...current, confirmed: false } : current,
                          );
                        }}
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
                            onChange={(value) => {
                              setBgmId(value ?? "");
                              setSaved(false);
                              setDraft((current) =>
                                current
                                  ? { ...current, confirmed: false }
                                  : current,
                              );
                            }}
                            placeholder={t("videoWizard.bgmTrack")}
                            options={bgmOptions.items.map((track) => ({
                              value: track.id,
                              label: track.bpm
                                ? `${track.name} · ${Math.round(track.bpm)} BPM`
                                : track.name,
                            }))}
                          />
                          {(() => {
                            const current =
                              bgmId || bgmOptions.default || "";
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
                                icon={
                                  playing ? (
                                    <X size={14} />
                                  ) : (
                                    <Play size={14} />
                                  )
                                }
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
                      onChange={(e) =>
                        changeBrief({ sellingPoints: e.target.value })
                      }
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
              )}

              {step >= 2 && draft && (
                <>
                  <Card className={styles.summary}>
                    <Space wrap>
                      <strong>
                        {product?.name ?? project?.snapshot.product.name}
                      </strong>
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
                          draft.confirmed && saved
                            ? "green"
                            : !saved
                            ? "orange"
                            : "gold"
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
                          const src = currentAsset
                            ? imageUrls[currentAsset.id]
                            : undefined;
                          const candidates = orderedSceneAssets.filter(
                            (asset) => mediaType(asset) === scene.type,
                          );
                          return (
                            <Card
                              key={`${scene.id}-${index}`}
                              className={styles.sceneCard}
                              title={
                                <Space>
                                  <span className={styles.sceneNumber}>
                                    {index + 1}
                                  </span>
                                  <Tag>
                                    {t(`videoWizard.sceneType.${scene.type}`)}
                                  </Tag>
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
                                {scene.type === "image" ||
                                scene.type === "video" ? (
                                  src &&
                                  currentAsset &&
                                  mediaType(currentAsset) === "image" ? (
                                    <img
                                      src={src}
                                      alt={currentAsset.filename}
                                    />
                                  ) : src && currentAsset ? (
                                    <video
                                      src={src}
                                      muted
                                      controls
                                      preload="metadata"
                                    />
                                  ) : (
                                    <div>
                                      <ImageIcon size={25} />
                                      <span>
                                        {scene.asset
                                          ? currentAsset?.filename ??
                                            scene.asset
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
                                    {scene.subtitle && (
                                      <span>{scene.subtitle}</span>
                                    )}
                                    {scene.bullets
                                      ?.slice(1, 3)
                                      .map((line) => (
                                        <span key={line}>• {line}</span>
                                      ))}
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
                              {(scene.type === "title" ||
                                scene.type === "endcard") && (
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
                              {(scene.type === "image" ||
                                scene.type === "video") && (
                                <>
                                  <Select
                                    aria-label={t("videoWizard.replaceAsset")}
                                    value={scene.asset}
                                    onChange={(asset) =>
                                      updateScene(index, { asset })
                                    }
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
              )}

              {step === 2 && !draft && (
                <div className={styles.loading}>
                  <Spin tip={t("videoWizard.generating")} />
                </div>
              )}

              {environmentSupported &&
                (step === 3 || step === 4) &&
                environmentPanel}

              {step === 4 && draft?.confirmed && isDesktop && (
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
                                <strong>
                                  {t(`videoWizard.stage.${stage}`)}
                                </strong>
                                <span>
                                  {t(`videoWizard.stageStatus.${status}`)}
                                </span>
                                {current &&
                                  desktopJob &&
                                  desktopJob.progress !== null && (
                                    <Progress
                                      className={styles.nativeStageProgress}
                                      percent={Math.round(
                                        Math.max(
                                          0,
                                          Math.min(1, desktopJob.progress),
                                        ) * 100,
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
                              onClick={() => navigate("/product-library")}
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
                            type={
                              desktopJob.state === "failed" ? "error" : "info"
                            }
                            showIcon
                            message={t(
                              `videoWizard.jobState.${desktopJob.state}`,
                            )}
                            description={
                              desktopJob.errorCode
                                ? t(
                                    `videoWizard.desktopErrors.${desktopJob.errorCode}`,
                                  )
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
              )}

              {step === 4 && draft?.confirmed && !isDesktop && (
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
                          <code>preview.cmd</code> ·{" "}
                          {t("videoWizard.windowsPreview")}
                        </p>
                        <p>
                          <code>preview.command</code> ·{" "}
                          {t("videoWizard.macPreview")}
                        </p>
                        <p>{t("videoWizard.renderGuide")}</p>
                        <p>{t("videoWizard.nodeGuide")}</p>
                      </div>
                    }
                  />
                </section>
              )}
            </>
          )}

          <footer className={styles.footer}>
            <span className={styles.footerStatus}>
              {nativeSaving ? (
                t("videoWizard.savingVideo")
              ) : nativeBusy ? (
                t("videoWizard.nativeStarting")
              ) : busy ? (
                step === 2 ? (
                  t("videoWizard.generating")
                ) : (
                  t("videoWizard.saving")
                )
              ) : draft ? (
                saved ? (
                  <>
                    <CheckCircle2 size={16} />
                    {t("videoWizard.saved")}
                  </>
                ) : (
                  <>
                    <Circle size={14} />
                    {t("videoWizard.unsaved")}
                  </>
                )
              ) : (
                t("videoWizard.footerHint")
              )}
            </span>
            <Space>
              <Button
                icon={<ArrowLeft size={15} />}
                disabled={
                  step === 0 ||
                  busy ||
                  uploadBusy ||
                  nativeBusy ||
                  isNativeActive
                }
                onClick={() =>
                  setStep(
                    step === 3 ? 1 : step === 4 ? 3 : Math.max(0, step - 1),
                  )
                }
              >
                {t("videoWizard.previous")}
              </Button>
              {step === 0 && (
                <Button
                  type="primary"
                  icon={<ArrowRight size={15} />}
                  disabled={
                    busy ||
                    uploadBusy ||
                    !product ||
                    assetLoadFailed ||
                    (!project && selectedAssetIds.length === 0)
                  }
                  onClick={() => setStep(1)}
                >
                  {t("videoWizard.next")}
                </Button>
              )}
              {step === 1 && (
                <Button
                  type="primary"
                  icon={<Sparkles size={15} />}
                  disabled={
                    busy ||
                    uploadBusy ||
                    !product ||
                    assetLoadFailed ||
                    (!project && selectedAssetIds.length === 0)
                  }
                  loading={busy}
                  onClick={() => void generate()}
                >
                  {t("videoWizard.generate")}
                </Button>
              )}
              {step === 3 && draft && (
                <>
                  <Button
                    disabled={busy || uploadBusy || saved}
                    loading={busy}
                    onClick={() => void persist(false)}
                  >
                    {t("videoWizard.saveChanges")}
                  </Button>
                  <Button
                    type="primary"
                    icon={<Check size={15} />}
                    loading={busy}
                    disabled={
                      busy ||
                      uploadBusy ||
                      !environmentReady ||
                      !scriptValid(draft.script, assetByExportName)
                    }
                    onClick={() => void persist(true)}
                  >
                    {t(
                      isDesktop
                        ? "videoWizard.confirmMake"
                        : "videoWizard.confirmContinue",
                    )}
                  </Button>
                </>
              )}
              {step === 4 && !isDesktop && (
                <Button
                  type="primary"
                  icon={<Download size={15} />}
                  disabled={busy || uploadBusy || !draft?.confirmed || !saved}
                  loading={busy}
                  onClick={() => void download()}
                >
                  {t("videoWizard.downloadPackage")}
                </Button>
              )}
            </Space>
          </footer>
        </div>
      </ConfigProvider>
    </PageShell>
  );
}

function candidatesAssetValid(
  scene: StoryboardScene,
  allowed: Map<string, ProductSnapshotAsset>,
) {
  if (scene.type !== "image" && scene.type !== "video") return true;
  const asset = scene.asset ? allowed.get(scene.asset) : undefined;
  return Boolean(asset && mediaType(asset) === scene.type);
}

function scriptValid(
  script: StoryboardScript,
  allowed: Map<string, ProductSnapshotAsset>,
) {
  const total = script.scenes.reduce((sum, scene) => sum + scene.duration, 0);
  return (
    script.scenes.length >= 1 &&
    script.scenes.length <= 24 &&
    total <= 180 &&
    script.scenes.every(
      (scene) =>
        scene.duration >= 0.25 &&
        scene.duration <= 15 &&
        (scene.type !== "bullets" || Boolean(scene.bullets?.length)) &&
        (!scene.bullets ||
          (scene.bullets.length >= 1 &&
            scene.bullets.length <= 8 &&
            scene.bullets.every((line) => line.length <= 150))) &&
        [scene.text, scene.subtitle, scene.caption].every(
          (text) => text === undefined || text.length <= 400,
        ) &&
        candidatesAssetValid(scene, allowed),
    )
  );
}
