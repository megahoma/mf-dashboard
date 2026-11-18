import fs from "node:fs";
import path from "node:path";
import { noLog } from "../../../shared/config/logging.ts";
import { DEFAULT_ENV_MODE, DEFAULT_START_SCRIPT } from "../../../shared/config/project.ts";
import { logDuration } from "../../../shared/lib/logging.ts";
import type { LogContext } from "../../../shared/models/logging.ts";
import { ALWAYS_SKIP, CONFIG_FILE } from "../config/discover.ts";
import type { LocalApp } from "../models/config.ts";
import type { FederationOwnershipCheck, ScanOptions } from "../models/discover.ts";
import { discoverDirectory } from "./discover-directory.ts";
import { isIndependentRslibProject } from "./rslib-launcher.ts";

type DirectoryScan = { resolve: () => LocalApp[]; configDependencies: string[] };
export type ConfigSelection = {
  folder: string;
  startScript: string;
  configFile?: string;
  workspaceRoot: string;
};

export function readAppFolder(
  folder: string,
  envMode: string,
  name?: string,
  dependencies?: Set<string>,
  log: LogContext = noLog,
  startScript = DEFAULT_START_SCRIPT,
  configFile?: string,
  isWorkspaceOwnedConfig?: FederationOwnershipCheck,
  workspaceRoot?: string,
): LocalApp | null {
  return prepareAppFolder(
    folder,
    envMode,
    dependencies,
    log,
    startScript,
    configFile,
    workspaceRoot,
  )(name, isWorkspaceOwnedConfig);
}

export function prepareAppFolder(
  folder: string,
  envMode: string,
  dependencies?: Set<string>,
  log: LogContext = noLog,
  startScript = DEFAULT_START_SCRIPT,
  configFile?: string,
  workspaceRoot?: string,
): (name?: string, isWorkspaceOwnedConfig?: FederationOwnershipCheck) => LocalApp | null {
  folder = path.resolve(folder);
  dependencies?.add(folder);
  const files = readDirectoryConfigFiles(folder);
  if (!files) {
    return () => null;
  }
  const resolve = discoverDirectory(folder, files, envMode, dependencies, log, {
    startScript,
    configFile,
    workspaceRoot,
  });
  return (name, isWorkspaceOwnedConfig) => {
    const apps = resolve?.(isWorkspaceOwnedConfig) ?? [];
    if (name === undefined || apps.length === 1) return apps[0] ?? null;
    return apps.find((app) => app.name === name) ?? null;
  };
}

export function scanWorkspace(root: string, options: ScanOptions = {}): Record<string, LocalApp> {
  return prepareWorkspaceScan(root, options)();
}

export function prepareWorkspaceScan(
  root: string,
  options: ScanOptions,
  ownedFederationConfigs = new Set<string>(),
): () => Record<string, LocalApp> {
  const started = Date.now();
  const log = options.log ?? noLog;
  const stats = { directories: 0, configs: 0 };
  const directories: DirectoryScan[] = [];
  const rootAbs = path.resolve(root);
  const ownershipSources = options.ownershipSources ?? new Set<string>();
  log.event("info", "discovery.scan.started", { root: rootAbs });
  walk(
    rootAbs,
    rootAbs,
    options,
    directories,
    new Set(),
    ownedFederationConfigs,
    ownershipSources,
    stats,
  );
  return () => finishWorkspaceScan(rootAbs, directories, ownershipSources, started, stats, log);
}

function finishWorkspaceScan(
  root: string,
  directories: DirectoryScan[],
  ownershipSources: Set<string>,
  started: number,
  stats: { directories: number; configs: number },
  log: LogContext,
): Record<string, LocalApp> {
  const found = new Map<string, LocalApp>();
  for (const { resolve, configDependencies } of directories) {
    for (const app of resolve()) {
      app.configDependencies = configDependencies;
      if (ownershipSources.size) app.ownershipSources = ownershipSources;
      const previous = found.get(app.name);
      const appFolder = app.launchFolder ?? app.folder;
      const previousFolder = previous && (previous.launchFolder ?? previous.folder);
      if (previous && previousFolder !== appFolder) {
        if (isIndependentRslibProject(previous, app)) continue;
        if (isIndependentRslibProject(app, previous)) {
          found.set(app.name, app);
          continue;
        }
        log.event("error", "discovery.duplicate", {
          reason: "duplicate-federation-name",
          app: app.name,
          folder: appFolder,
          previousFolder,
        });
        throw new Error(`duplicate federation name: ${app.name} (${previousFolder}, ${appFolder})`);
      }
      found.set(app.name, app);
    }
  }
  logDuration(
    log,
    "discovery.scan.completed",
    started,
    { root, ...stats, apps: found.size },
    "info",
  );
  return Object.fromEntries(found);
}

export function readWorkspaceFederationHelpers(root: string, options: ScanOptions) {
  const rootAbs = path.resolve(root);
  const files = new Set<string>();
  const sources = new Set<string>();
  walk(rootAbs, rootAbs, options, undefined, new Set(), files, sources, {
    directories: 0,
    configs: 0,
  });
  return { files, sources };
}

export function prepareConfigSelection(
  { folder, startScript, configFile, workspaceRoot }: ConfigSelection,
  envMode: string,
  dependencies: Set<string>,
  ownedFederationConfigs: Set<string>,
  ownershipSources: Set<string>,
  isWorkspaceOwnedConfig: FederationOwnershipCheck,
  resolveOwnershipFor?: { name: string; reads: Set<string> },
): (() => LocalApp[]) | undefined {
  dependencies.add(folder);
  const configs = readDirectoryConfigFiles(folder);
  if (!configs) return;
  const resolve = discoverDirectory(folder, configs, envMode, dependencies, noLog, {
    startScript,
    configFile,
    workspaceRoot,
    ownedFederationConfigs,
    ownershipSources,
    resolveOwnershipFor,
  });
  return resolve && (() => resolve(isWorkspaceOwnedConfig));
}

function readDirectoryConfigFiles(folder: string): string[] | undefined {
  try {
    return fs
      .readdirSync(folder, { withFileTypes: true })
      .filter((entry) => entry.isFile() && CONFIG_FILE.test(entry.name))
      .map((entry) => path.join(folder, entry.name))
      .sort();
  } catch {
    return;
  }
}

function walk(
  dir: string,
  root: string,
  options: ScanOptions,
  directories: DirectoryScan[] | undefined,
  claimedConfigs: Set<string>,
  ownedFederationConfigs: Set<string>,
  ownershipSources: Set<string>,
  stats: { directories: number; configs: number },
): void {
  const {
    ignorePaths = [],
    envMode = DEFAULT_ENV_MODE,
    startScript,
    log = noLog,
    dependencies,
  } = options;
  let entries: fs.Dirent[];
  stats.directories++;
  dependencies?.add(dir);
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const configs: string[] = [];
  const children: string[] = [];
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    const rel = path.relative(root, abs).split(path.sep).join("/");
    if (entry.isDirectory()) {
      if (shouldSkip(entry.name, rel, ignorePaths)) {
        log.event("trace", "discovery.skipped", { path: rel, reason: "excluded-directory" });
        continue;
      }
      children.push(abs);
      continue;
    }
    if (entry.isFile() && CONFIG_FILE.test(entry.name)) configs.push(abs);
  }
  const appDependencies = new DirectoryDependencies(dependencies);
  stats.configs += configs.length;
  const resolve =
    configs.length || entries.some((entry) => entry.name === "package.json" && entry.isFile())
      ? discoverDirectory(dir, configs, envMode, appDependencies, log, {
          startScript,
          workspaceRoot: root,
          claimedConfigs,
          ownedFederationConfigs,
          ownershipSources,
          ignoreConfig: (file) => isIgnoredDirectory(root, path.dirname(file), ignorePaths),
          ignoreDirectory: (folder) => isIgnoredDirectory(root, folder, ignorePaths),
        })
      : undefined;
  if (resolve && directories)
    directories.push({ resolve, configDependencies: [...appDependencies] });
  for (const child of children)
    walk(
      child,
      root,
      options,
      directories,
      claimedConfigs,
      ownedFederationConfigs,
      ownershipSources,
      stats,
    );
}

class DirectoryDependencies extends Set<string> {
  private readonly workspace?: Set<string>;

  constructor(workspace?: Set<string>) {
    super();
    this.workspace = workspace;
  }

  override add(file: string): this {
    this.workspace?.add(file);
    return super.add(file);
  }
}

export function isIgnoredDirectory(
  root: string,
  dir: string,
  ignorePaths: readonly string[],
): boolean {
  const segments = path.relative(root, dir).split(path.sep).filter(Boolean);
  return segments.some((segment, index) =>
    shouldSkip(segment, segments.slice(0, index + 1).join("/"), ignorePaths),
  );
}

function shouldSkip(name: string, relPosix: string, extra: readonly string[]): boolean {
  if (ALWAYS_SKIP.has(name)) return true;
  for (const raw of extra) {
    const item = raw.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
    if (item === "") continue;
    if (!item.includes("/")) {
      if (name === item) return true;
      continue;
    }
    if (relPosix === item || relPosix.startsWith(`${item}/`)) return true;
  }
  return false;
}
