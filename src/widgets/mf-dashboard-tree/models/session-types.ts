import type {
  LocalApp,
  ProbeBook,
  ProbeCycleInput,
  ScanOptions,
} from "../../../entities/microfrontend/index.ts";
import type { AppConfig } from "../../../features/init-settings/index.ts";
import type { LogContext } from "../../../shared/models/logging.ts";
import type { DashboardStructure } from "./presentation.ts";

export type AppSetting = AppConfig & {
  configFile?: string;
  typesZipPath?: string;
};

export type WorkspaceRoot = {
  name: string;
  path: string;
};

export type DashboardSettings = {
  apps: Record<string, AppSetting> | undefined;
  envMode: string;
  startScript?: string;
  ignorePaths: readonly string[];
  extraManifestUrls: readonly string[];
  structure: DashboardStructure;
};

export type DashboardPorts = {
  readSettings(): DashboardSettings;
  writeApps(apps: Record<string, AppSetting>): void | Promise<void>;
  scan(root: string, options: ScanOptions): Record<string, LocalApp>;
  loadKnown(
    roots: readonly WorkspaceRoot[],
    apps: Record<string, AppSetting>,
    envMode: string,
    ignorePaths: readonly string[],
    cache?: AppParseCache,
    log?: LogContext,
    startScript?: string,
  ): LocalApp[];
  probe(book: ProbeBook, input: ProbeCycleInput): Promise<void>;
  roots(): WorkspaceRoot[];
};

export type AppParseCache = {
  lookup(key: string, folder: string, envMode: string): LocalApp | null;
  store(
    key: string,
    folder: string,
    envMode: string,
    app: LocalApp,
    dependencies?: readonly string[],
  ): void;
};

export type DiscoverySnapshot = {
  key: string;
  scans: {
    root: WorkspaceRoot;
    apps: Record<string, LocalApp>;
    dependencies: readonly string[];
    stamp: string;
  }[];
  parsed: Map<string, { app: LocalApp; stamp: string }>;
};

export type WorkspaceSettings = DashboardSettings & {
  packageManager: string;
  probeIntervalMs: number;
  typesSettleMs: number;
  terminalReveal: boolean;
  startScript: string;
  rebuildCommand: string;
  refetchCommand: string;
  typesAutoCheck: boolean;
};
