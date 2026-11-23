import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, ConfigProvider, Empty, Space, Spin } from "antd";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  Circle,
  Download,
  Sparkles,
} from "lucide-react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { isLocalLibraryAvailable } from "../../api/localLibrary";
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
} from "../../context/DesktopVideoJobsContext";
import { message } from "../../utils/antdMessage";
import {
  decodeVideoBrief,
  EMPTY_VIDEO_BRIEF,
  encodeVideoBrief,
  splitPlatforms,
  type VideoBrief,
} from "./brief";

import { ProductStage } from "./ProductStage";
import { PlanStage } from "./PlanStage";
import { StoryboardStage } from "./StoryboardStage";
import { EnvironmentPanel, OutputStage } from "./OutputStage";
import { exportName, mediaType } from "./sceneAssets";
import styles from "./index.module.less";

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
  const routeSelection = location.state as {
    productId?: string;
    assetIds?: string[];
    ownerId?: number | string;
  } | null;
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
  const urlsRef = useRef<Record<string, string>>({});
  const uploadFileIds = useRef(new WeakMap<File, string>());
  const nextUploadFileId = useRef(0);
  const requestVersion = useRef(0);
  const productIdRef = useRef<string | null>(null);
  const tRef = useRef(t);
  const generatedProjectRoute = useRef<{
    id: string;
    user: typeof userId;
  } | null>(null);
  tRef.current = t;

  // Desktop shell: the server-backed wizard is retired (PRD §3.7). Material
  // bytes and classification live on this machine, so any attempt to open the
  // hosted wizard is redirected to the local library — which never downloads
  // material from the server. Web console keeps the wizard unchanged.
  useEffect(() => {
    if (isLocalLibraryAvailable()) {
      navigate("/local-video-wizard", { replace: true });
    }
  }, [navigate]);

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
      cleanUrls();
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
    const generatedRoute = generatedProjectRoute.current;
    generatedProjectRoute.current = null;
    if (
      generatedRoute?.id === requestedProjectId &&
      generatedRoute?.user === userId
    ) {
      return;
    }
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
          const routedProduct = p.items.find(
            (item) => item.id === routeProductId,
          );
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
    };
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
          (asset) =>
            asset.product_id === id &&
            asset.active &&
            asset.usage === "scene" &&
            mediaType(asset),
        );
        const explicitIds =
          hasOwnedRouteSelection && routeSelection?.productId === id
            ? routeSelection.assetIds
            : undefined;
        setSelectedAssetIds(
          explicitIds
            ? available
                .filter((asset) => explicitIds.includes(asset.id))
                .map((asset) => asset.id)
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
  }, [
    product?.id,
    project?.id,
    assetRetry,
    hasOwnedRouteSelection,
    location.key,
  ]);

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
  const isNativeActive = Boolean(
    desktopJob && isActiveDesktopVideoJob(desktopJob),
  );

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
  const invalidateConfirmation = () => {
    setSaved(false);
    setDraft((current) =>
      current ? { ...current, confirmed: false } : current,
    );
  };

  const changeNarrationEnabled = (enabled: boolean) => {
    setNarrationEnabled(enabled);
    invalidateConfirmation();
  };

  const changeNarrationVoice = (voice: string) => {
    setNarrationVoice(voice);
    invalidateConfirmation();
  };

  const changeBgmEnabled = (enabled: boolean) => {
    setBgmEnabled(enabled);
    if (!enabled) {
      bgmPreviewRef.current?.pause();
      bgmPreviewRef.current = null;
      setBgmPreview("");
    }
    invalidateConfirmation();
  };

  const changeBgmId = (id: string) => {
    setBgmId(id);
    invalidateConfirmation();
  };

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
        if (productIdRef.current !== id || requestVersion.current !== version)
          break;
        setUploadProgress(
          t("videoWizard.uploadProgress", { done: index, total: batch.length }),
        );
        try {
          const result = await productLibraryApi.upload(id, [file], "scene");
          if (productIdRef.current !== id || requestVersion.current !== version)
            break;
          uploadedIds.push(
            ...result.items
              .filter(
                (asset) =>
                  !existingIds.has(asset.id) &&
                  asset.active &&
                  asset.usage === "scene" &&
                  mediaType(asset),
              )
              .map((asset) => asset.id),
          );
          succeeded += 1;
          setUploads((current) => current.filter((item) => item !== file));
        } catch {
          // Keep failed entries in the queue for an explicit retry.
        }
      }
      if (productIdRef.current === id && requestVersion.current === version) {
        try {
          const loaded = await productLibraryApi.assets(id);
          if (productIdRef.current !== id || requestVersion.current !== version)
            return;
          setAssets(loaded.items);
          const valid = new Set(
            loaded.items
              .filter(
                (asset) =>
                  asset.active && asset.usage === "scene" && mediaType(asset),
              )
              .map((asset) => asset.id),
          );
          setSelectedAssetIds((current) => [
            ...new Set([
              ...current.filter((assetId) => valid.has(assetId)),
              ...uploadedIds.filter((assetId) => valid.has(assetId)),
            ]),
          ]);
          if (succeeded)
            message.success(
              t("videoWizard.uploadedCount", { count: succeeded }),
            );
          if (batch.length > succeeded)
            setError(
              t("videoWizard.uploadFailedCount", {
                count: batch.length - succeeded,
              }),
            );
        } catch {
          if (productIdRef.current === id && requestVersion.current === version)
            setError(t("videoWizard.uploadFailed"));
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
      if (requestedProjectId !== activeProject.id) {
        generatedProjectRoute.current = { id: activeProject.id, user: userId };
      }
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

  const updateScenes = (scenes: StoryboardScene[]) => {
    setDraft((current) =>
      current
        ? {
            ...current,
            confirmed: false,
            script: {
              ...current.script,
              scenes,
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

  const startBatch = async (targets: import("./OutputStage").RenderTarget[]) => {
    if (!project || !environmentReady) return;
    setNativeBusy(true);
    setError("");
    try {
      await desktopVideo.startVariants(project.id, targets);
    } catch (nativeError) {
      setError(nativeErrorMessage(nativeError, t));
    } finally {
      setNativeBusy(false);
    }
  };

  const saveBatch = async () => {
    if (!desktopJob) return;
    setNativeSaving(true);
    setError("");
    try {
      const savedBatch = await desktopVideo.saveBatch(desktopJob.id);
      if (savedBatch) message.success(t("videoWizard.videoSaved"));
    } catch (nativeError) {
      setError(nativeErrorMessage(nativeError, t));
    } finally {
      setNativeSaving(false);
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

  const installEnvironment = async () => {
    setEnvironmentBusy(true);
    try {
      await desktopVideo.installEnvironment();
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
                <ProductStage
                  products={products}
                  product={product}
                  project={project}
                  sceneAssets={sceneAssets}
                  imageUrls={imageUrls}
                  busy={busy}
                  uploadBusy={uploadBusy}
                  uploadProgress={uploadProgress}
                  uploads={uploads}
                  uploadFileIds={uploadFileIds}
                  nextUploadFileId={nextUploadFileId}
                  setUploads={setUploads}
                  setError={setError}
                  uploadAssets={uploadAssets}
                  assetLoadFailed={assetLoadFailed}
                  retryAssets={() => setAssetRetry((value) => value + 1)}
                  selectedAssetIds={selectedAssetIds}
                  setSelectedAssetIds={setSelectedAssetIds}
                  pickProduct={pickProduct}
                  backToLibrary={() => navigate("/product-library")}
                />
              )}

              {step === 1 && (
                <PlanStage
                  brief={brief}
                  request={request}
                  project={project}
                  busy={busy}
                  narrationAvailable={narrationAvailable}
                  narrationOptions={narrationOptions}
                  narrationEnabled={narrationEnabled}
                  narrationVoice={narrationVoice}
                  bgmOptions={bgmOptions}
                  bgmEnabled={bgmEnabled}
                  bgmId={bgmId}
                  bgmPreview={bgmPreview}
                  toggleBgmPreview={toggleBgmPreview}
                  changeBrief={changeBrief}
                  changeRequest={changeRequest}
                  changeNarrationEnabled={changeNarrationEnabled}
                  changeNarrationVoice={changeNarrationVoice}
                  changeBgmEnabled={changeBgmEnabled}
                  changeBgmId={changeBgmId}
                />
              )}

              {step >= 2 && draft && (
                <StoryboardStage
                  key={`${userId}:${requestedProjectId}:${draft.project_id}`}
                  step={step}
                  draft={draft}
                  productName={product?.name ?? project?.snapshot.product.name}
                  totalDuration={totalDuration}
                  saved={saved}
                  busy={busy}
                  assetByExportName={assetByExportName}
                  imageUrls={imageUrls}
                  orderedSceneAssets={orderedSceneAssets}
                  updateScenes={updateScenes}
                />
              )}

              {step === 2 && !draft && (
                <div className={styles.loading}>
                  <Spin tip={t("videoWizard.generating")} />
                </div>
              )}

              {environmentSupported && (step === 3 || step === 4) && (
                <EnvironmentPanel
                  environmentStatus={environmentStatus}
                  environmentBusy={environmentBusy}
                  recheckEnvironment={recheckEnvironment}
                  installEnvironment={installEnvironment}
                  verifyEnvironment={verifyEnvironment}
                />
              )}

              {step === 4 && draft?.confirmed && (
                <OutputStage
                  isDesktop={isDesktop}
                  desktopJob={desktopJob}
                  coverAsset={coverAsset}
                  imageUrls={imageUrls}
                  nativeBusy={nativeBusy}
                  nativeSaving={nativeSaving}
                  environmentReady={environmentReady}
                  backToLibrary={() => navigate("/product-library")}
                  startNativeJob={startNativeJob}
                  cancelNativeJob={cancelNativeJob}
                  saveNativeVideo={saveNativeVideo}
                  retryNativeJob={retryNativeJob}
                  selectedPlatforms={splitPlatforms(brief.platform)}
                  outputLanguage={draft.request.language}
                  startBatch={isDesktop && environmentReady ? startBatch : undefined}
                  batchTargets={desktopJob?.targets?.map((target) => ({
                    id: target.id,
                    platform: target.filename,
                    profile: "custom" as const,
                    width: target.width,
                    height: target.height,
                    fps: target.fps,
                    language: draft.request.language,
                    safeArea: "standard" as const,
                    filename: target.filename,
                    status: target.status,
                    error: target.errorCode,
                  }))}
                  downloadStudioPackage={download}
                  saveBatch={saveBatch}
                />
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
                    disabled={
                      busy ||
                      uploadBusy ||
                      saved ||
                      !scriptValid(draft.script, assetByExportName)
                    }
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
