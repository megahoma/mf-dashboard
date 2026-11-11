import {
  logDuration,
  noLog,
  safeError,
  type LogContext,
  type LogFields,
} from "../../shared/logging.ts";
import fs from "node:fs";
import path from "node:path";
import {
  createProbeBook,
  readAppFolder,
  type ArtifactProbe,
  type LinkProbeResult,
  type LocalApp,
  type ProbeBook,
  type ProbeCycleInput,
  type ProbeResult,
  type RemoteLink,
  type ScanOptions,
} from "../../entities/microfrontend/index.ts";
import { type ProblemDraft, type StatusInput } from "../../entities/status/index.ts";
import { mergeMissingApps, resolveManifestPath } from "../../features/init-settings/index.ts";
import { terms, type DashboardTerms } from "../../shared/config/index.ts";
import { resolveRowAction } from "./targets.ts";
import {
  dashboardNodes,
  dashboardProblemDrafts,
  type DashboardNode,
  type DashboardStructure,
} from "./presentation.ts";
export { linkRowId, rowContextValue } from "./presentation.ts";
export type { DashboardNode, DashboardStructure } from "./presentation.ts";

export interface AppSetting {
  path: string;
  configFile?: string;
  workspaceFolder?: string;
  manifestPath?: string;
  typesZipPath?: string;
  scripts?: { start?: string };
}

export interface WorkspaceRoot {
  name: string;
  path: string;
}

export interface DashboardSettings {
  apps: Record<string, AppSetting> | undefined;
  envMode: string;
  startScript?: string;
  ignorePaths: readonly string[];
  extraManifestUrls: readonly string[];
  structure: DashboardStructure;
}

export interface DashboardPorts {
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
}

export function beginRefetch(pending: Set<string>, linkId: string): boolean {
  if (pending.has(linkId)) return false;
  pending.add(linkId);
  return true;
}

export function endRefetch(pending: Set<string>, linkId: string): void {
  pending.delete(linkId);
}

export function savedFileKind(
  app: Pick<
    LocalApp,
    "folder" | "configFile" | "configDependencies" | "generateTypes" | "launchEnvironment"
  >,
  file: string,
  envMode: string,
): "config" | "source" | null {
  const folder = path.resolve(app.folder);
  const full = path.resolve(file);
  if (app.configDependencies?.includes(full)) return "config";
  const relative = path.relative(folder, full);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    return null;
  if (full === path.resolve(app.configFile)) return "config";
  if (path.dirname(full) === folder) {
    const name = path.basename(full);
    if (name === "package.json") return "config";
    if (/^(module-federation|webpack|rspack|rsbuild|vite)\.config\./.test(name)) return "config";
    if (
      [envMode, app.launchEnvironment?.envMode].some(
        (mode) => mode !== undefined && (name === `.env.${mode}` || name === `.env.${mode}.local`),
      )
    )
      return "config";
  }
  return app.generateTypes && /\.tsx?$/.test(full) && !full.endsWith(".d.ts") ? "source" : null;
}

export interface AppParseCache {
  lookup(key: string, folder: string, envMode: string): LocalApp | null;
  store(
    key: string,
    folder: string,
    envMode: string,
    app: LocalApp,
    dependencies?: readonly string[],
  ): void;
}

export function appConfigStamp(
  folder: string,
  envMode: string,
  configFile: string | null,
  dependencies: readonly string[] = [],
): string {
  let names: string[] = [];
  try {
    names = fs
      .readdirSync(folder)
      .filter((name) => /^(module-federation|webpack|rspack|rsbuild|vite)\.config\./.test(name))
      .sort();
  } catch {
    /* A removed folder invalidates its cached parse. */
  }
  const files = [
    ...names.map((name) => path.join(folder, name)),
    path.join(folder, `.env.${envMode}`),
    path.join(folder, `.env.${envMode}.local`),
    ...dependencies,
  ];
  if (configFile) files.push(configFile);
  return configFilesStamp(files);
}

function configFilesStamp(files: readonly string[]): string {
  return [...new Set(files)]
    .sort()
    .map((file) => {
      try {
        const stat = fs.statSync(file);
        const directory = stat.isDirectory()
          ? `\0directory\0${stat.ctimeMs}\0${stat.ino}\0${stat.mode}`
          : "";
        return `${file}\0${fs.realpathSync(file)}\0${stat.size}\0${stat.mtimeMs}${directory}`;
      } catch {
        return `${file}\0missing`;
      }
    })
    .join("\n");
}

export function createAppParseCache(log: LogContext = noLog): AppParseCache {
  const stored = new Map<
    string,
    { stamp: string; app: LocalApp; dependencies: readonly string[] }
  >();
  return {
    lookup(key, folder, envMode) {
      const hit = stored.get(key);
      const stamp = hit
        ? appConfigStamp(folder, envMode, hit.app.configFile, hit.dependencies)
        : "";
      if (!hit || hit.stamp !== stamp) {
        log.event("debug", "config.cache.miss", () => {
          const oldRows = new Set(hit?.stamp.split("\n") ?? []);
          const newRows = new Set(stamp.split("\n"));
          const changed = [...oldRows, ...newRows]
            .filter((row) => !oldRows.has(row) || !newRows.has(row))
            .map((row) => row.split("\0")[0]);
          const kinds = [
            ...new Set(
              changed.map((file) =>
                path.basename(file).startsWith(".env.")
                  ? "env-changed"
                  : /^(module-federation|webpack|rspack|rsbuild|vite)\.config\./.test(
                        path.basename(file),
                      )
                    ? "root-config-changed"
                    : "import-dependency-changed",
              ),
            ),
          ];
          return { folder, reason: hit ? kinds.join(",") : "not-cached" };
        });
        return null;
      }
      log.event("debug", "config.cache.hit", { folder });
      return hit.app;
    },
    store(key, folder, envMode, app, dependencies = []) {
      stored.set(key, {
        stamp: appConfigStamp(folder, envMode, app.configFile, dependencies),
        app,
        dependencies: [...dependencies],
      });
    },
  };
}

export function loadKnownApps(
  roots: readonly WorkspaceRoot[],
  apps: Record<string, AppSetting>,
  envMode: string,
  _ignorePaths: readonly string[] = [],
  cache: AppParseCache = createAppParseCache(),
  log: LogContext = noLog,
  startScript = "dev",
): LocalApp[] {
  return [...resolveKnownApps(roots, apps, envMode, cache, log, undefined, startScript).values()];
}

function appParseKey(
  root: string,
  folder: string,
  envMode: string,
  name: string,
  script: string,
  configFile?: string,
): string {
  return JSON.stringify([root, folder, envMode, name, script, configFile]);
}

export function resolveKnownApps(
  roots: readonly WorkspaceRoot[],
  apps: Record<string, AppSetting>,
  envMode: string,
  cache: AppParseCache = createAppParseCache(),
  log: LogContext = noLog,
  onError?: (name: string, error: unknown) => void,
  startScript = "dev",
): Map<string, LocalApp> {
  const entries: { name: string; app: LocalApp; identity: string }[] = [];
  const matches = new Map<string, number>();
  for (const [name, setting] of Object.entries(apps)) {
    if (!setting || typeof setting.path !== "string" || setting.path.trim() === "") continue;
    const candidates = setting.workspaceFolder
      ? roots.filter((root) => root.name === setting.workspaceFolder)
      : roots;
    const script = typeof setting.scripts?.start === "string" ? setting.scripts.start : startScript;
    const configFile = typeof setting.configFile === "string" ? setting.configFile : undefined;
    try {
      for (const root of candidates) {
        const confined = confinedAppPath(root.path, setting.path);
        if (!confined) {
          log.event("warn", "config.path.invalid", { app: name });
          continue;
        }
        const { absolute, canonical } = confined;
        const key = appParseKey(root.path, absolute, envMode, name, script, configFile);
        const cached = cache.lookup(key, absolute, envMode);
        const dependencies = new Set<string>();
        const parsed =
          cached ?? readAppFolder(absolute, envMode, name, dependencies, log, script, configFile);
        if (!parsed) continue;
        const app = cached ?? { ...parsed, configDependencies: [...dependencies] };
        if (!cached) cache.store(key, absolute, envMode, app, [...dependencies]);
        if (app.name !== name && candidates.length !== 1) continue;
        const identity = `${canonical}\0${app.name}`;
        matches.set(identity, (matches.get(identity) ?? 0) + 1);
        const resolved = withManifestPathOverride(app, setting.manifestPath);
        resolved.settingsKey = name;
        entries.push({ name, app: resolved, identity });
        break;
      }
    } catch (error) {
      if (!onError) throw error;
      onError(name, error);
    }
  }
  const loaded = new Map<string, LocalApp>();
  for (const { name, app, identity } of entries) {
    if (name === app.name || matches.get(identity) === 1) loaded.set(name, app);
  }
  return loaded;
}

function withManifestPathOverride(app: LocalApp, configuredPath: string | undefined): LocalApp {
  const override = resolveManifestPath(configuredPath, "");
  return override ? { ...app, manifestPath: override, devManifestPath: undefined } : { ...app };
}

function pathInsideRoot(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}

function confinedAppPath(
  root: string,
  settingPath: string,
): { absolute: string; canonical: string } | null {
  const base = path.resolve(root);
  const absolute = path.resolve(base, settingPath);
  if (!pathInsideRoot(base, absolute)) return null;
  try {
    if (!fs.existsSync(absolute)) return { absolute, canonical: absolute };
    const canonical = fs.realpathSync.native(absolute);
    return pathInsideRoot(fs.realpathSync.native(base), canonical) ? { absolute, canonical } : null;
  } catch {
    return null;
  }
}

function workspaceRelative(root: string, folder: string): string {
  const relative = path.relative(root, folder);
  if (relative === "") return ".";
  return relative.split(path.sep).join("/");
}

export function linksOf(apps: readonly LocalApp[]): RemoteLink[] {
  const links: RemoteLink[] = [];
  for (const app of apps) {
    for (const remote of app.remotes) {
      links.push({
        consumer: app.name,
        alias: remote.alias,
        remoteName: remote.name,
        url: remote.url,
      });
    }
  }
  return links;
}

interface DiscoverySnapshot {
  key: string;
  scans: {
    root: WorkspaceRoot;
    apps: Record<string, LocalApp>;
    dependencies: readonly string[];
    stamp: string;
  }[];
  parsed: Map<string, { app: LocalApp; stamp: string }>;
}

export class DashboardSession {
  loaded: LocalApp[] = [];
  extraUrls: string[] = [];
  structure: DashboardStructure = "tree";
  terms: DashboardTerms = terms;
  typesForLink: (link: RemoteLink) => StatusInput["typesState"] = () => "unknown";
  typesAutoCheck = true;
  typesCheckedAt: (link: RemoteLink) => number | null = () => null;
  beforeRefreshChange: (log?: LogContext) => void = () => {};
  onRefreshFailed: () => void = () => {};
  probeRunning = false;
  readonly pending = new Set<string>();
  readonly refetchErrors = new Set<string>();
  readonly scriptGaps = new Set<string>();
  readonly rebuildErrors = new Map<string, string>();
  private readonly ports: DashboardPorts;
  private readonly appCache: AppParseCache;
  private readonly log: LogContext;
  private activeLog: LogContext = noLog;
  private pathWarnings = new Set<string>();
  private preparedDiscovery: DiscoverySnapshot | undefined;
  readonly book: ProbeBook;
  private readonly onChange: () => void;

  constructor(
    ports: DashboardPorts,
    book: ProbeBook,
    onChange: () => void = () => {},
    log: LogContext = noLog,
  ) {
    this.log = log;
    this.appCache = createAppParseCache({
      event: (...args) => this.activeLog.event(...args),
      operation: (source) => this.activeLog.operation(source),
    });
    this.ports = ports;
    this.book = book;
    this.onChange = onChange;
  }

  async refresh(
    source = "manual",
    log = this.log.operation(source),
    cache = this.appCache,
  ): Promise<void> {
    this.activeLog = log;
    const seenWarnings = new Set<string>();
    const loadLog: LogContext = {
      operation: (source) => log.operation(source),
      event: (level, event, fields) => {
        if (level === "warn" && event === "config.path.invalid") {
          const values = typeof fields === "function" ? fields() : fields;
          const key = String(values?.app);
          seenWarnings.add(key);
          if (this.pathWarnings.has(key)) return;
          log.event(level, event, values);
        } else log.event(level, event, fields);
      },
    };
    const started = Date.now();
    log.event(source === "timer" ? "debug" : "info", "refresh.started");
    const snapshot = this.captureRefreshState();
    let failureFields: LogFields = {};
    this.probeRunning = true;
    let structureAtProbe = this.structure;
    try {
      const current = this.ports.readSettings();
      const roots = this.ports.roots();
      const extraUrls = [...current.extraManifestUrls];
      // A flat/tree toggle during the probe updates this.structure in place.
      this.structure = current.structure === "flat" ? "flat" : "tree";
      structureAtProbe = this.structure;
      const loaded =
        roots.length === 0 || current.apps === undefined
          ? []
          : this.ports.loadKnown(
              roots,
              current.apps,
              current.envMode,
              current.ignorePaths,
              cache,
              loadLog,
              current.startScript,
            );
      logDuration(log, "config.loaded", started, {
        configured: Object.keys(current.apps ?? {}).length,
        loaded: loaded.length,
      });
      const names = new Set<string>();
      for (const app of loaded) {
        if (names.has(app.name)) {
          failureFields = { reason: "duplicate-federation-name", app: app.name };
          throw new Error(`duplicate federation name: ${app.name}`);
        }
        names.add(app.name);
      }
      // The probe writes `staged`. The visible book stays put until the swap below.
      const staged = createProbeBook();
      staged.zips = new Map(this.book.zips);
      await this.ports.probe(staged, {
        apps: loaded,
        links: linksOf(loaded),
        extraManifestUrls: extraUrls,
        log,
      });
      this.applyRefreshState({
        apps: staged.apps,
        links: staged.links,
        extras: staged.extras,
        loaded,
        extraUrls,
        structure: this.structure,
      });
      this.book.zips.clear();
      for (const [url, fact] of staged.zips) this.book.zips.set(url, fact);
    } catch (error) {
      const toggledDuringProbe = this.structure !== structureAtProbe;
      this.applyRefreshState({
        ...snapshot,
        structure: toggledDuringProbe ? this.structure : snapshot.structure,
      });
      this.probeRunning = false;
      log.event("error", "refresh.failed", {
        ...safeError(error),
        ...failureFields,
        rolledBack: true,
        durationMs: Date.now() - started,
      });
      this.pathWarnings = seenWarnings;
      this.onRefreshFailed();
      if (toggledDuringProbe) this.onChange();
      throw error;
    }
    this.pathWarnings = seenWarnings;
    this.probeRunning = false;
    const renderStarted = Date.now();
    this.beforeRefreshChange(log);
    this.onChange();
    logDuration(
      log,
      "refresh.completed",
      started,
      {
        apps: this.loaded.length,
        links: this.book.links.size,
        extras: this.extraUrls.length,
        renderMs: Date.now() - renderStarted,
      },
      source === "timer" ? "debug" : "info",
    );
  }

  prepareDiscovery(log = this.log.operation("startup")): string[] {
    const started = Date.now();
    this.preparedDiscovery = undefined;
    const current = this.ports.readSettings();
    const roots = this.ports.roots();
    const startScript = current.startScript ?? "dev";
    const scans = roots.map((root) => {
      const dependencies = new Set<string>();
      const apps = this.ports.scan(root.path, {
        envMode: current.envMode,
        ignorePaths: current.ignorePaths,
        startScript,
        dependencies,
        log,
      });
      return {
        root,
        apps,
        dependencies: [...dependencies],
        stamp: configFilesStamp([...dependencies]),
      };
    });
    const parsed: DiscoverySnapshot["parsed"] = new Map();
    for (const { root, apps } of scans) {
      for (const [name, app] of Object.entries(apps)) {
        const key = appParseKey(root.path, app.folder, current.envMode, name, startScript);
        parsed.set(key, {
          app,
          stamp: appConfigStamp(app.folder, current.envMode, app.configFile),
        });
      }
    }
    this.preparedDiscovery = {
      key: JSON.stringify([roots, current.envMode, current.ignorePaths, startScript]),
      scans,
      parsed,
    };
    logDuration(
      log,
      "discovery.prepare.completed",
      started,
      { roots: roots.length, apps: parsed.size },
      "info",
    );
    return scans.flatMap(({ apps }) => Object.keys(apps));
  }

  async discover(log = this.log.operation("discovery")): Promise<void> {
    const started = Date.now();
    let failureFields: LogFields = {};
    log.event("info", "discovery.started");
    try {
      const current = this.ports.readSettings();
      const roots = this.ports.roots();
      if (new Set(roots.map((root) => root.name)).size !== roots.length) {
        failureFields = { reason: "duplicate-workspace-folder-name" };
        throw new Error("workspace folder names must be unique");
      }
      const key = JSON.stringify([
        roots,
        current.envMode,
        current.ignorePaths,
        current.startScript ?? "dev",
      ]);
      if (
        this.preparedDiscovery?.key !== key ||
        this.preparedDiscovery.scans.some(
          ({ dependencies, stamp }) => stamp !== configFilesStamp(dependencies),
        ) ||
        [...this.preparedDiscovery.parsed.values()].some(
          ({ app, stamp }) => stamp !== appConfigStamp(app.folder, current.envMode, app.configFile),
        )
      )
        this.prepareDiscovery(log);
      const discovered = this.preparedDiscovery!;
      this.preparedDiscovery = undefined;
      if (roots.length > 0) {
        const foundApps: Record<string, AppSetting> = Object.create(null);
        for (const { root, apps: found } of discovered.scans) {
          for (const [name, foundApp] of Object.entries(found)) {
            if (Object.hasOwn(foundApps, name)) {
              failureFields = { reason: "duplicate-federation-name", app: name };
              throw new Error(`duplicate federation name: ${name}`);
            }
            foundApps[name] = {
              path: workspaceRelative(root.path, foundApp.folder),
              ...(roots.length > 1 ? { workspaceFolder: root.name } : {}),
            };
          }
        }
        const apps = mergeMissingApps(current.apps, foundApps);
        const changed = Object.keys(foundApps).some(
          (name) => !Object.hasOwn(current.apps ?? {}, name),
        );
        if (changed) await this.ports.writeApps(apps);
      }
      const importsUnchanged = discovered.scans.every(
        ({ dependencies, stamp }) => stamp === configFilesStamp(dependencies),
      );
      // Scan results are reused once; later refreshes track imported dependencies normally.
      await this.refresh("discovery", log, {
        lookup: (key, folder, envMode) => {
          const hit = discovered.parsed.get(key);
          if (
            importsUnchanged &&
            hit &&
            hit.stamp === appConfigStamp(folder, envMode, hit.app.configFile)
          )
            return hit.app;
          return this.appCache.lookup(key, folder, envMode);
        },
        store: (...args) => this.appCache.store(...args),
      });
      log.event("info", "discovery.completed", {
        apps: this.loaded.length,
        durationMs: Date.now() - started,
      });
    } catch (error) {
      log.event("error", "discovery.failed", { ...safeError(error), ...failureFields });
      throw error;
    }
  }

  relabel(next: DashboardTerms): void {
    this.terms = next;
    this.onChange();
  }

  setStructure(next: DashboardStructure): void {
    const structure = next === "flat" ? "flat" : "tree";
    if (this.structure === structure) return;
    this.structure = structure;
    this.onChange();
  }

  refetch(linkId: string): boolean {
    const accepted = beginRefetch(this.pending, linkId);
    if (accepted) {
      this.refetchErrors.delete(linkId);
      this.onChange();
    }
    return accepted;
  }

  releaseRefetch(linkId: string): void {
    endRefetch(this.pending, linkId);
    this.onChange();
  }

  failRefetch(linkId: string): void {
    this.refetchErrors.add(linkId);
    endRefetch(this.pending, linkId);
    this.onChange();
  }

  noteScriptMissing(name: string): void {
    this.scriptGaps.add(name);
    this.onChange();
  }

  clearScriptMissing(name: string): void {
    if (this.scriptGaps.delete(name)) this.onChange();
  }

  noteRebuildError(name: string, message: string): void {
    this.rebuildErrors.set(name, message);
    this.onChange();
  }

  clearRebuildError(name: string): void {
    if (!this.rebuildErrors.delete(name)) return;
    this.onChange();
  }

  private captureRefreshState(): {
    apps: Map<string, ProbeResult>;
    links: Map<string, LinkProbeResult>;
    extras: Map<string, ArtifactProbe>;
    loaded: LocalApp[];
    extraUrls: string[];
    structure: DashboardStructure;
  } {
    return {
      apps: new Map(this.book.apps),
      links: new Map(this.book.links),
      extras: new Map(this.book.extras),
      loaded: this.loaded,
      extraUrls: [...this.extraUrls],
      structure: this.structure,
    };
  }

  private applyRefreshState(snapshot: {
    apps: Map<string, ProbeResult>;
    links: Map<string, LinkProbeResult>;
    extras: Map<string, ArtifactProbe>;
    loaded: LocalApp[];
    extraUrls: string[];
    structure: DashboardStructure;
  }): void {
    this.book.apps.clear();
    for (const [key, value] of snapshot.apps) this.book.apps.set(key, value);
    this.book.links.clear();
    for (const [key, value] of snapshot.links) this.book.links.set(key, value);
    this.book.extras.clear();
    for (const [key, value] of snapshot.extras) this.book.extras.set(key, value);
    this.loaded = snapshot.loaded;
    this.extraUrls = snapshot.extraUrls;
    this.structure = snapshot.structure;
  }

  actionFor(node: unknown) {
    return resolveRowAction(node, this.loaded, this.extraUrls);
  }

  nodes(): DashboardNode[] {
    return dashboardNodes(this);
  }

  problemDrafts(settingsFile: string | null): ProblemDraft[] {
    return dashboardProblemDrafts(this, settingsFile);
  }
}
