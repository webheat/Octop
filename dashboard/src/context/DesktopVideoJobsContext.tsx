import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { getAuthToken } from "../api/request";
import { useCurrentUser } from "../hooks/useCurrentUser";

export type DesktopVideoJobState =
  | "preparing"
  | "downloading"
  | "rendering"
  | "saving"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface DesktopVideoJob {
  id: string;
  projectId: string;
  ownerId: string | number;
  name: string;
  state: DesktopVideoJobState;
  progress: number | null;
  errorCode?: string;
  videoUrl?: string;
  updatedAt: number;
  targets?: DesktopVideoOutput[];
}

export interface DesktopVideoOutput {
  id: string;
  platform?: string;
  filename: string;
  width: number;
  height: number;
  fps: number;
  status: "queued" | "rendering" | "completed" | "failed";
  errorCode?: string;
  videoUrl?: string;
}

export interface DesktopVideoTargetRequest {
  id: string;
  platform?: string;
  profile?: "short_vertical" | "landscape" | "square" | "custom";
  width: number;
  height: number;
  fps: number;
  filename: string;
}

export interface DesktopVideoBridge {
  version: number;
  outputBatchVersion?: number;
  /** Explicit opt-out for shells started with OCTOP_DESKTOP_MINIMAL=0. */
  minimalMode?: boolean;
  environmentVersion?: number;
  environmentInstallerURL?: string;
  request: <T = unknown>(
    action:
      | "start"
      | "start_variants"
      | "list"
      | "get"
      | "cancel"
      | "retry"
      | "save"
      | "save_batch"
      | "environment_check"
      | "environment_verify"
      | "environment_install"
      | "environment_status",
    payload: Record<string, unknown>,
  ) => Promise<T>;
}

export type DesktopVideoEnvironmentState =
  | "unknown"
  | "checking"
  | "installing"
  | "needs_setup"
  | "verifying"
  | "ready"
  | "failed";

export interface DesktopVideoEnvironmentStatus {
  state: DesktopVideoEnvironmentState;
  stage: "components" | "browser" | "render_test" | null;
  progress: number | null;
  errorCode?: string;
  checkedAt?: number;
  requiresInstall?: boolean;
  outputBatchSupported?: boolean;
}

declare global {
  interface Window {
    octopDesktopVideo?: DesktopVideoBridge;
  }
}

export class DesktopVideoBridgeError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "DesktopVideoBridgeError";
    this.code = code;
  }
}

interface DesktopVideoJobsContextValue {
  bridgeAvailable: boolean;
  environmentSupported: boolean;
  environmentInstallerURL?: string;
  environmentStatus: DesktopVideoEnvironmentStatus;
  jobs: DesktopVideoJob[];
  start: (projectId: string) => Promise<DesktopVideoJob>;
  startVariants: (
    projectId: string,
    targets: DesktopVideoTargetRequest[],
  ) => Promise<DesktopVideoJob>;
  cancel: (jobId: string) => Promise<DesktopVideoJob>;
  retry: (jobId: string) => Promise<DesktopVideoJob>;
  save: (jobId: string) => Promise<boolean>;
  saveBatch: (jobId: string) => Promise<boolean>;
  checkEnvironment: (force?: boolean) => Promise<DesktopVideoEnvironmentStatus>;
  verifyEnvironment: () => Promise<DesktopVideoEnvironmentStatus>;
  installEnvironment: () => Promise<DesktopVideoEnvironmentStatus>;
  refreshEnvironment: () => Promise<DesktopVideoEnvironmentStatus>;
  refresh: () => Promise<void>;
}

const missingBridge = async (): Promise<never> => {
  throw new DesktopVideoBridgeError("RUNTIME_UNAVAILABLE");
};

const DesktopVideoJobsContext = createContext<DesktopVideoJobsContextValue>({
  bridgeAvailable: false,
  environmentSupported: false,
  environmentInstallerURL: undefined,
  environmentStatus: { state: "unknown", stage: null, progress: null },
  jobs: [],
  start: missingBridge,
  startVariants: missingBridge,
  cancel: missingBridge,
  retry: missingBridge,
  save: missingBridge,
  saveBatch: missingBridge,
  checkEnvironment: missingBridge,
  verifyEnvironment: missingBridge,
  installEnvironment: missingBridge,
  refreshEnvironment: missingBridge,
  refresh: async () => undefined,
});

export function isActiveDesktopVideoJob(job: DesktopVideoJob): boolean {
  return ["preparing", "downloading", "rendering", "saving"].includes(
    job.state,
  );
}

function nativeErrorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z_]+$/.test(code)) return code;
  }
  return "INTERNAL";
}

export function DesktopVideoJobsProvider({
  children,
}: {
  children: ReactNode;
}) {
  const userId = useCurrentUser()?.id ?? null;
  const ownerRef = useRef<string | number | null>(userId);
  ownerRef.current = userId;
  const [bridgeAvailable, setBridgeAvailable] = useState(
    () => window.octopDesktopVideo?.version === 1,
  );
  const [jobs, setJobs] = useState<DesktopVideoJob[]>([]);
  const [jobsOwnerId, setJobsOwnerId] = useState<string | number | null>(null);
  const environmentSupported =
    window.octopDesktopVideo?.version === 1 &&
    window.octopDesktopVideo.environmentVersion === 1;
  const [environmentStatus, setEnvironmentStatus] =
    useState<DesktopVideoEnvironmentStatus>({
      state: "unknown",
      stage: null,
      progress: null,
    });
  const [environmentOwnerId, setEnvironmentOwnerId] = useState<
    string | number | null
  >(null);
  const environmentRef = useRef(environmentStatus);
  environmentRef.current = environmentStatus;
  const environmentOwnerRef = useRef<string | number | null>(
    environmentOwnerId,
  );
  environmentOwnerRef.current = environmentOwnerId;

  // Report every environment state change to the console. The desktop shell
  // keeps the authoritative log on disk, but this is the trail the user can
  // copy straight into a support report: which state the UI showed, when, and
  // which error code it carried.
  const lastEnvironmentLogRef = useRef<string>("");
  useEffect(() => {
    const key = [
      environmentStatus.state,
      environmentStatus.stage ?? "-",
      environmentStatus.errorCode ?? "-",
      environmentStatus.requiresInstall === true ? "install" : "no-install",
    ].join("|");
    if (key === lastEnvironmentLogRef.current) return;
    lastEnvironmentLogRef.current = key;
    const detail = environmentStatus.errorCode
      ? ` code=${environmentStatus.errorCode}`
      : "";
    const install = environmentStatus.requiresInstall === true ? " install" : "";
    console.info(
      `[octop:video-env] state=${environmentStatus.state} stage=${environmentStatus.stage ?? "-"}${detail}${install}`,
    );
  }, [environmentStatus]);

  useEffect(() => {
    if (window.octopDesktopVideo?.version === 1) {
      setBridgeAvailable(true);
      return;
    }
    const poll = window.setInterval(() => {
      if (window.octopDesktopVideo?.version === 1) {
        setBridgeAvailable(true);
        window.clearInterval(poll);
      }
    }, 200);
    return () => window.clearInterval(poll);
  }, []);

  const call = useCallback(
    async <T,>(
      action:
        | "start"
        | "start_variants"
        | "list"
        | "get"
        | "cancel"
        | "retry"
        | "save"
        | "save_batch"
        | "environment_check"
        | "environment_verify"
        | "environment_install"
        | "environment_status",
      payload: Record<string, unknown> = {},
    ): Promise<T> => {
      const token = getAuthToken();
      if (!userId || !token) throw new DesktopVideoBridgeError("AUTH_REQUIRED");
      const bridge = window.octopDesktopVideo;
      if (!bridge || bridge.version !== 1) {
        throw new DesktopVideoBridgeError("RUNTIME_UNAVAILABLE");
      }
      try {
        return await bridge.request<T>(action, { ...payload, token });
      } catch (error) {
        throw new DesktopVideoBridgeError(nativeErrorCode(error));
      }
    },
    [userId],
  );

  const refresh = useCallback(async () => {
    if (!userId || !getAuthToken() || !bridgeAvailable) {
      setJobs([]);
      setJobsOwnerId(null);
      return;
    }
    try {
      const listed = await call<DesktopVideoJob[]>("list");
      if (ownerRef.current !== userId) return;
      setJobsOwnerId(userId);
      setJobs(
        listed
          .filter((job) => String(job.ownerId) === String(userId))
          .sort((a, b) => b.updatedAt - a.updatedAt),
      );
    } catch (error) {
      if (ownerRef.current !== userId) return;
      if (nativeErrorCode(error) === "AUTH_REQUIRED") {
        setJobs([]);
        setJobsOwnerId(null);
      }
    }
  }, [bridgeAvailable, call, userId]);

  useEffect(() => {
    setJobs([]);
    if (!userId || !bridgeAvailable) return;
    void refresh();
    const interval = window.setInterval(() => void refresh(), 1800);
    return () => window.clearInterval(interval);
  }, [bridgeAvailable, refresh, userId]);

  const updateJob = useCallback(
    async (
      action: "start" | "start_variants" | "cancel" | "retry",
      payload: Record<string, unknown>,
    ) => {
      const job = await call<DesktopVideoJob>(action, payload);
      if (ownerRef.current !== userId) {
        throw new DesktopVideoBridgeError("AUTH_REQUIRED");
      }
      setJobsOwnerId(userId);
      setJobs((current) =>
        [job, ...current.filter((item) => item.id !== job.id)].sort(
          (a, b) => b.updatedAt - a.updatedAt,
        ),
      );
      return job;
    },
    [call, userId],
  );

  const start = useCallback(
    (projectId: string) => updateJob("start", { projectId }),
    [updateJob],
  );
  const startVariants = useCallback(
    (projectId: string, targets: DesktopVideoTargetRequest[]) =>
      updateJob("start_variants", { projectId, targets }),
    [updateJob],
  );
  const cancel = useCallback(
    (jobId: string) => updateJob("cancel", { jobId }),
    [updateJob],
  );
  const retry = useCallback(
    (jobId: string) => updateJob("retry", { jobId }),
    [updateJob],
  );
  const save = useCallback(
    async (jobId: string) => {
      const result = await call<{ saved: boolean }>("save", { jobId });
      return result.saved;
    },
    [call],
  );
  const saveBatch = useCallback(
    async (jobId: string) => {
      const result = await call<{ saved: boolean }>("save_batch", { jobId });
      return result.saved;
    },
    [call],
  );

  const readEnvironmentAction = useCallback(
    async (
      action:
        | "environment_check"
        | "environment_verify"
        | "environment_install"
        | "environment_status",
    ) => {
      if (!environmentSupported) {
        throw new DesktopVideoBridgeError("RUNTIME_UNAVAILABLE");
      }
      const status = await call<DesktopVideoEnvironmentStatus>(action);
      if (ownerRef.current !== userId || !userId) {
        throw new DesktopVideoBridgeError("AUTH_REQUIRED");
      }
      environmentOwnerRef.current = userId;
      environmentRef.current = status;
      setEnvironmentOwnerId(userId);
      setEnvironmentStatus(status);
      return status;
    },
    [call, environmentSupported, userId],
  );

  const checkEnvironment = useCallback(
    async (force = false) => {
      if (!userId) throw new DesktopVideoBridgeError("AUTH_REQUIRED");
      if (
        !force &&
        environmentOwnerRef.current === userId &&
        environmentRef.current.state !== "unknown"
      ) {
        return environmentRef.current;
      }
      try {
        return await readEnvironmentAction("environment_check");
      } catch (error) {
        if (ownerRef.current === userId) {
          const failed: DesktopVideoEnvironmentStatus = {
            state: "failed",
            stage: null,
            progress: null,
            errorCode: nativeErrorCode(error),
          };
          environmentOwnerRef.current = userId;
          environmentRef.current = failed;
          setEnvironmentOwnerId(userId);
          setEnvironmentStatus(failed);
        }
        throw error;
      }
    },
    [readEnvironmentAction, userId],
  );

  const verifyEnvironment = useCallback(async () => {
    try {
      return await readEnvironmentAction("environment_verify");
    } catch (error) {
      if (userId && ownerRef.current === userId) {
        const failed: DesktopVideoEnvironmentStatus = {
          state: "failed",
          stage: null,
          progress: null,
          errorCode: nativeErrorCode(error),
        };
        environmentOwnerRef.current = userId;
        environmentRef.current = failed;
        setEnvironmentOwnerId(userId);
        setEnvironmentStatus(failed);
      }
      throw error;
    }
  }, [readEnvironmentAction, userId]);

  const installEnvironment = useCallback(async () => {
    if (!userId) throw new DesktopVideoBridgeError("AUTH_REQUIRED");
    try {
      return await readEnvironmentAction("environment_install");
    } catch (error) {
      if (userId && ownerRef.current === userId) {
        const failed: DesktopVideoEnvironmentStatus = {
          state: "failed",
          stage: null,
          progress: null,
          errorCode: nativeErrorCode(error),
          requiresInstall: true,
        };
        environmentOwnerRef.current = userId;
        environmentRef.current = failed;
        setEnvironmentOwnerId(userId);
        setEnvironmentStatus(failed);
      }
      throw error;
    }
  }, [readEnvironmentAction, userId]);

  const refreshEnvironment = useCallback(
    () => readEnvironmentAction("environment_status"),
    [readEnvironmentAction],
  );

  useEffect(() => {
    if (environmentOwnerId === userId) return;
    environmentOwnerRef.current = null;
    environmentRef.current = { state: "unknown", stage: null, progress: null };
    setEnvironmentOwnerId(null);
    setEnvironmentStatus({ state: "unknown", stage: null, progress: null });
  }, [environmentOwnerId, userId]);

  useEffect(() => {
    if (
      environmentOwnerId !== userId ||
      !["checking", "installing", "verifying"].includes(environmentStatus.state)
    ) {
      return;
    }
    const interval = window.setInterval(() => {
      void refreshEnvironment().catch(() => undefined);
    }, 1500);
    return () => window.clearInterval(interval);
  }, [environmentOwnerId, environmentStatus.state, refreshEnvironment, userId]);

  const value = useMemo(
    () => ({
      bridgeAvailable,
      environmentSupported,
      environmentInstallerURL:
        window.octopDesktopVideo?.environmentInstallerURL,
      environmentStatus:
        environmentOwnerId === userId
          ? environmentStatus
          : { state: "unknown" as const, stage: null, progress: null },
      jobs: jobsOwnerId === userId ? jobs : [],
      start,
      startVariants,
      cancel,
      retry,
      save,
      saveBatch,
      checkEnvironment,
      verifyEnvironment,
      installEnvironment,
      refreshEnvironment,
      refresh,
    }),
    [
      bridgeAvailable,
      environmentSupported,
      window.octopDesktopVideo?.environmentInstallerURL,
      environmentStatus,
      environmentOwnerId,
      jobs,
      jobsOwnerId,
      userId,
      start,
      cancel,
      retry,
      save,
      saveBatch,
      checkEnvironment,
      verifyEnvironment,
      installEnvironment,
      refreshEnvironment,
      refresh,
    ],
  );
  return (
    <DesktopVideoJobsContext.Provider value={value}>
      {children}
    </DesktopVideoJobsContext.Provider>
  );
}

export function useDesktopVideoJobs() {
  return useContext(DesktopVideoJobsContext);
}
