import type {
  LocalApp,
  ProbeBook,
  ProbeCycleInput,
  ScanOptions,
} from "../../../entities/microfrontend/index.ts";
import type { AppConfig } from "../../../features/init-settings/index.ts";
import type { inputsFingerprint } from "../../../features/rebuild-types/index.ts";
import type { LogContext, LogFields, LogLevel } from "../../../shared/models/logging.ts";
import type { WorkspaceGraph } from "../lib/workspace-graph.ts";
import type { resolveRebuildApps } from "../lib/rebuild-apps.ts";
import type { DashboardStructure } from "./presentation.ts";

export type AppSetting = AppConfig & {
  configFile?: string;
  typesZipPath?: string;
};

export type WorkspaceRoot = {
  name: string;
  path: string;
};

export type KnownAppsTask = {
  roots: readonly WorkspaceRoot[];
  settings: DashboardSettings;
  discovery?: DiscoveryCache;
};

export type KnownAppsResult = { apps: LocalApp[]; ownershipSources: Set<string> };

type DiscoveryTask = Pick<KnownAppsTask, "roots" | "settings">;

export type ConfigWorkerTasks = {
  load: { input: KnownAppsTask; result: KnownAppsResult };
  prepare: { input: DiscoveryTask; result: DiscoverySnapshot };
  discover: {
    input: DiscoveryTask & { previous?: DiscoverySnapshot };
    result: DiscoveryPlan;
  };
  rebuild: { input: DiscoveryTask; result: ReturnType<typeof resolveRebuildApps> };
  fingerprint: { input: Parameters<typeof inputsFingerprint>; result: string };
  rebuildConfigStamp: { input: LocalApp; result: string };
};

export type ConfigWorkerTask = {
  [K in keyof ConfigWorkerTasks]: { kind: K; input: ConfigWorkerTasks[K]["input"] };
}[keyof ConfigWorkerTasks] & { logLevels: readonly LogLevel[] };

export type ConfigWorkerReply = {
  events: { level: LogLevel; event: string; fields?: LogFields }[];
} & ({ result: ConfigWorkerTasks[keyof ConfigWorkerTasks]["result"] } | { error: string });

export type DashboardSettings = {
  probeIntervalMs?: number;
  apps: Record<string, AppSetting> | undefined;
  envMode: string;
  startScript?: string;
  ignorePaths: readonly string[];
  extraManifestUrls: readonly string[];
  structure: DashboardStructure;
};

export type DashboardPorts = {
  graph?: {
    prepare(roots: readonly WorkspaceRoot[]): Promise<void>;
    read(roots: readonly WorkspaceRoot[], log: LogContext): Promise<WorkspaceGraph>;
    publish(
      roots: readonly WorkspaceRoot[],
      settings: DashboardSettings,
      selections: Record<string, AppSetting>,
      cache: DiscoveryCache,
      stillCurrent: () => boolean,
      log: LogContext,
    ): Promise<void>;
  };
  readSettings(): DashboardSettings;
  writeApps(apps: Record<string, AppSetting>): void | Promise<void>;
  scan(
    root: string,
    options: ScanOptions,
    ownedFederationConfigs: Set<string>,
  ): Record<string, LocalApp> | (() => Record<string, LocalApp>);
  prepareDiscovery?(
    roots: readonly WorkspaceRoot[],
    settings: DashboardSettings,
    log: LogContext,
  ): Promise<DiscoverySnapshot>;
  planDiscovery?(
    roots: readonly WorkspaceRoot[],
    settings: DashboardSettings,
    previous: DiscoverySnapshot | undefined,
    log: LogContext,
  ): Promise<DiscoveryPlan>;
  loadKnown(
    roots: readonly WorkspaceRoot[],
    apps: Record<string, AppSetting>,
    envMode: string,
    ignorePaths: readonly string[],
    cache?: AppParseCache,
    log?: LogContext,
    startScript?: string,
    ownershipSources?: Set<string>,
  ): LocalApp[];
  loadKnownAsync?(
    roots: readonly WorkspaceRoot[],
    settings: DashboardSettings,
    log: LogContext,
    discovery?: KnownAppsTask["discovery"],
  ): Promise<KnownAppsResult>;
  probe(book: ProbeBook, input: ProbeCycleInput): Promise<void>;
  roots(): WorkspaceRoot[];
};

export type OwnershipSnapshot = {
  files: ReadonlySet<string>;
  sources: ReadonlySet<string>;
  dependencies: readonly string[];
  stamp: string;
};

export type AppParseCache = {
  lookup(
    key: string,
    folder: string,
    envMode: string,
    ownershipUnchanged?: (snapshot: OwnershipSnapshot) => boolean,
  ): LocalApp | null;
  lookupResult(
    key: string,
    folder: string,
    envMode: string,
    ownershipUnchanged?: (snapshot: OwnershipSnapshot) => boolean,
  ): LocalApp | null | undefined;
  store(
    key: string,
    folder: string,
    envMode: string,
    app: LocalApp | null,
    dependencies?: readonly string[],
    ownership?: OwnershipSnapshot,
    observations?: ReadonlyMap<string, string>,
  ): void;
  lookupOwnership(key: string): OwnershipSnapshot | undefined;
  storeOwnership(key: string, snapshot: OwnershipSnapshot): void;
  ownershipIsCurrent(snapshot: OwnershipSnapshot): boolean;
};

export type DiscoverySnapshot = {
  key: string;
  scans: {
    root: WorkspaceRoot;
    apps: Record<string, LocalApp>;
  }[];
  checks: { dependencies: readonly string[]; stamp: string }[];
  parsed: Map<string, { app: LocalApp; stamp: string }>;
};

type DiscoveryCache = Pick<DiscoverySnapshot, "parsed" | "checks">;

export type DiscoveryPlan =
  { cache: DiscoveryCache; apps?: Record<string, AppSetting> } | { duplicateName: string };

export type WorkspaceSettings = DashboardSettings & {
  packageManager: string;
  probeIntervalMs: number;
  typesSettleMs: number;
  terminalReveal: boolean;
  startScript: string;
  rebuildCommand: string;
  refetchCommand: string;
  typesAutoCheck: boolean;
  buildConcurrency: number;
  useBuildCache: boolean;
};
