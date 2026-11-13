import {
  createProbeBook,
  type ArtifactProbe,
  type LinkProbeResult,
  type LocalApp,
  type ProbeBook,
  type ProbeResult,
  type RemoteLink,
} from "../../../entities/microfrontend/index.ts";
import type { ProblemDraft, StatusInput } from "../../../entities/status/index.ts";
import { mergeMissingApps } from "../../../features/init-settings/index.ts";
import { terms, type DashboardTerms } from "../../../shared/config/index.ts";
import { noLog } from "../../../shared/config/logging.ts";
import { DEFAULT_START_SCRIPT } from "../../../shared/config/project.ts";
import { logDuration, resolveLogFields, safeError } from "../../../shared/lib/logging.ts";
import type { LogContext, LogFields } from "../../../shared/models/logging.ts";
import { appConfigStamp, configFilesStamp, createAppParseCache } from "../lib/app-parse-cache.ts";
import { appParseKey, workspaceRelative } from "../lib/known-apps.ts";
import { beginRefetch, endRefetch, linksOf } from "../lib/links.ts";
import { dashboardNodes, dashboardProblemDrafts } from "../lib/presentation.ts";
import { resolveRowAction } from "../lib/targets.ts";
import type { DashboardNode, DashboardStructure } from "./presentation.ts";
import type {
  AppParseCache,
  AppSetting,
  DashboardPorts,
  DiscoverySnapshot,
} from "./session-types.ts";

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
          const values = resolveLogFields(fields);
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
    const startScript = current.startScript ?? DEFAULT_START_SCRIPT;
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
        current.startScript ?? DEFAULT_START_SCRIPT,
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
