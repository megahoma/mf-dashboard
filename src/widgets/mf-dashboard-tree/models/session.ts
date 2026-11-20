import {
  createProbeBook,
  remoteLinkKey,
  type ArtifactProbe,
  type LinkProbeResult,
  type LocalApp,
  type ProbeBook,
  type ProbeResult,
  type RemoteLink,
} from "../../../entities/microfrontend/index.ts";
import type { ProblemDraft, StatusInput } from "../../../entities/status/index.ts";
import { terms, type DashboardTerms } from "../../../shared/config/index.ts";
import { noLog } from "../../../shared/config/logging.ts";
import { logDuration, resolveLogFields, safeError } from "../../../shared/lib/logging.ts";
import type { LogContext, LogFields } from "../../../shared/models/logging.ts";
import { createAppParseCache, withDiscoveryCache } from "../lib/app-parse-cache.ts";
import {
  discoveredNames,
  discoveryFilesAreCurrent,
  discoveryKey,
  planDiscovery,
  prepareDiscoverySnapshot,
} from "../lib/discovery.ts";
import { beginRefetch, endRefetch, linksOf } from "../lib/links.ts";
import { dashboardNodes, dashboardProblemDrafts } from "../lib/presentation.ts";
import { resolveRowAction } from "../lib/targets.ts";
import type { DashboardNode, DashboardStructure } from "./presentation.ts";
import type {
  AppParseCache,
  DashboardPorts,
  DiscoverySnapshot,
  KnownAppsTask,
} from "./session-types.ts";

export class DashboardSession {
  loaded: LocalApp[] = [];
  ownershipSources: ReadonlySet<string> = new Set();
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
    discovery?: KnownAppsTask["discovery"],
  ): Promise<void> {
    this.activeLog = log;
    const seenWarnings = new Set<string>();
    const loadLog: LogContext = {
      enabled: (level) => log.enabled?.(level) ?? true,
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
      let ownershipSources = new Set<string>();
      let loaded: LocalApp[] = [];
      if (roots.length && current.apps) {
        if (this.ports.loadKnownAsync && Object.keys(current.apps).length) {
          ({ apps: loaded, ownershipSources } = await this.ports.loadKnownAsync(
            roots,
            current,
            loadLog,
            discovery,
          ));
        } else {
          loaded = this.ports.loadKnown(
            roots,
            current.apps,
            current.envMode,
            current.ignorePaths,
            withDiscoveryCache(this.appCache, discovery),
            loadLog,
            current.startScript,
            ownershipSources,
          );
        }
      }
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
      for (const sources of new Set(loaded.map((app) => app.ownershipSources))) {
        if (sources) for (const file of sources) ownershipSources.add(file);
      }
      this.ownershipSources = ownershipSources;
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
    this.pruneMessages(snapshot.loaded);
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

  prepareDiscovery(log = this.log.operation("startup")): string[] | Promise<string[]> {
    this.preparedDiscovery = undefined;
    const current = this.ports.readSettings();
    const roots = this.ports.roots();
    const accept = (snapshot: DiscoverySnapshot) => {
      this.preparedDiscovery = snapshot;
      return discoveredNames(snapshot);
    };
    return this.ports.prepareDiscovery
      ? this.ports.prepareDiscovery(roots, current, log).then(accept)
      : accept(prepareDiscoverySnapshot(roots, current, this.ports.scan, log));
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
      const prepared = this.preparedDiscovery;
      this.preparedDiscovery = undefined;
      const key = discoveryKey(roots, current);
      const plan = this.ports.planDiscovery
        ? await this.ports.planDiscovery(roots, current, prepared, log)
        : planDiscovery(roots, current, prepared, this.ports.scan, log);
      if ("duplicateName" in plan) {
        failureFields = { reason: "duplicate-federation-name", app: plan.duplicateName };
        throw new Error(`duplicate federation name: ${plan.duplicateName}`);
      }
      if (key !== discoveryKey(this.ports.roots(), this.ports.readSettings()))
        throw new Error("Workspace settings changed during Discover");
      if (plan.apps && !discoveryFilesAreCurrent(plan.cache))
        throw new Error("Workspace config files changed during Discover");
      if (plan.apps) await this.ports.writeApps(plan.apps);
      await this.refresh("discovery", log, plan.cache);
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

  private pruneMessages(previous: readonly LocalApp[]): void {
    const identity = (app: LocalApp) =>
      JSON.stringify([
        app.folder,
        app.configFile,
        app.buildConfigFile,
        app.launchFolder,
        app.typesFolder,
      ]);
    const oldApps = new Map(previous.map((app) => [app.name, identity(app)]));
    const retained = new Set(
      this.loaded.filter((app) => oldApps.get(app.name) === identity(app)).map((app) => app.name),
    );
    for (const name of this.scriptGaps) if (!retained.has(name)) this.scriptGaps.delete(name);
    for (const name of this.rebuildErrors.keys())
      if (!retained.has(name)) this.rebuildErrors.delete(name);
    const oldLinks = new Map(linksOf(previous).map((link) => [remoteLinkKey(link), link.url]));
    const active = new Set(
      linksOf(this.loaded)
        .filter(
          (link) =>
            retained.has(link.consumer) &&
            oldLinks.get(remoteLinkKey(link)) === link.url &&
            (!oldApps.has(link.remoteName) || retained.has(link.remoteName)),
        )
        .map(remoteLinkKey),
    );
    for (const messages of [this.pending, this.refetchErrors]) {
      for (const id of messages) if (!active.has(id)) messages.delete(id);
    }
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
