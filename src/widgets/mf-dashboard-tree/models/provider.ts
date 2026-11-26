import { realpathSync } from "node:fs";
import path from "node:path";
import picomatch from "picomatch";
import * as vscode from "vscode";
import {
  createConfirmationStore,
  disposeEvidenceWorker,
  resolveTypesPath,
  sourceIdentityForFileAsync,
  type ConfirmationStore,
  type InstalledEvidence,
  type LinkTypeObservation,
  type SourceIdentity,
} from "../../../entities/federated-types/index.ts";
import {
  appProbeId,
  createProbeBook,
  indexedApps,
  linkProbeId,
  probeWorkspace,
  prepareWorkspaceScan,
  splitRemoteLinkKey,
  type LocalApp,
  type RemoteLink,
} from "../../../entities/microfrontend/index.ts";
import { verifyTypeInstalls } from "../../../features/observe-types/index.ts";
import {
  MANIFEST_SCHEME,
  ManifestDocuments,
  openManifestPreview,
} from "../../../features/open-manifest/index.ts";
import {
  createRebuildAllReport,
  rebuildAllTypes,
  rebuildTypes,
  type RebuildAllReport,
  type RebuildAppStatus,
} from "../../../features/rebuild-types/index.ts";
import { installRemoteTypes } from "../../../features/refetch-types/index.ts";
import { icons, type DashboardTerms } from "../../../shared/config/index.ts";
import { noLog } from "../../../shared/config/logging.ts";
import { logDuration, safeError } from "../../../shared/lib/logging.ts";
import { pathIsInside } from "../../../shared/lib/paths.ts";
import { createSerialQueue } from "../../../shared/lib/queue.ts";
import { isLoopbackAtPort, localManifestUrl, parseHttpUrl } from "../../../shared/lib/urls.ts";
import type { LogContext } from "../../../shared/models/logging.ts";
import { savedFileKind } from "../lib/app-parse-cache.ts";
import { KnownAppsWorker } from "../lib/known-apps-worker.mts";
import { loadKnownApps } from "../lib/known-apps.ts";
import { incomingLinks, linksOf, parseLinkId } from "../lib/links.ts";
import { showConfigFile } from "../lib/open-config.ts";
import { problemDiagnostics } from "../lib/problem-diagnostics.ts";
import { startRow } from "../lib/start-row.ts";
import { appTypesDir, directoryExists, linkTypesDir } from "../lib/targets.ts";
import {
  prepareWorkspaceGraphDirectories,
  readWorkspaceGraphs,
  writeWorkspaceGraphs,
} from "../lib/workspace-graph.ts";
import {
  readWorkspaceSettings,
  settingsDiagnosticFile,
  workspaceRoots,
  writeWorkspaceApps,
} from "../lib/workspace-settings.ts";
import type { DashboardNode, DashboardStructure } from "./presentation.ts";
import { DashboardSession } from "./session.ts";
import type { TypeEvidence } from "./type-observation-types.ts";
import { DashboardTypeObservation } from "./type-observation.ts";

type TypesDirectory = {
  app: LocalApp;
  alias?: string;
  existing: string | null;
  locations: string[];
  routes: Set<string>;
};

type TypesDirectoryChange = { consumer: string; alias?: string };

export class MfDashboardProvider
  implements vscode.TreeDataProvider<DashboardNode>, vscode.Disposable
{
  private readonly change = new vscode.EventEmitter<DashboardNode | undefined | null | void>();
  readonly onDidChangeTreeData = this.change.event;
  private readonly typesChecked = new vscode.EventEmitter<void>();
  readonly onDidCheckTypes = this.typesChecked.event;
  private readonly diagnostics = vscode.languages.createDiagnosticCollection("mf-dashboard");
  private publishedFiles: string[] = [];
  private publishedSettingsFile: string | null = null;
  readonly session: DashboardSession;
  private readonly run = createSerialQueue();
  private readonly knownAppsWorker = new KnownAppsWorker();
  private readonly termsOf: () => DashboardTerms;
  private readonly confirmations: ConfirmationStore;
  private readonly persistConfirmations: () => void | PromiseLike<void>;
  private readonly observation: DashboardTypeObservation;
  private readonly saveChecks = new Map<string, Promise<void>>();
  private readonly sourceSaves = new Map<LocalApp, Map<string, Promise<void>>>();
  private readonly dirtySaves = new Map<
    string,
    { app: LocalApp; identity: SourceIdentity } | undefined
  >();
  private pendingEvidence: TypeEvidence | undefined;
  private readonly publishedZipHashes = new Map<string, string>();
  private explicitTypeCheck = false;
  private requestedTypeLinks: ReadonlySet<string> | undefined;
  private requestedTypeNode: DashboardNode | undefined;
  private view: DashboardNode[] | null = null;
  private typesWatcher?: vscode.FileSystemWatcher;
  private typesWatchPattern?: string;
  private typesWatchTopology?: { apps: readonly LocalApp[]; structure: DashboardStructure };
  private readonly typesWatchPaths = new Map<string, Set<TypesDirectory>>();
  private readonly typesWatchNames = new Map<string, string>();
  private readonly dirtyTypesDirectories = new Set<TypesDirectory>();
  private readonly typesDirectories = new Map<string, TypesDirectory>();
  private unwatchedTypesDirectories = new Set<TypesDirectory>();
  private typesWatchRoots: {
    root: string;
    realRoot: string;
    excluded: (entry: string, relative: string) => boolean;
  }[] = [];
  private typesWatchRoutesChanged = false;
  private typesWatchPending = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private disposed = false;
  private discovering = false;
  private readonly log: LogContext;
  private statuses = new Map<string, string>();
  private readonly manifests = new ManifestDocuments();
  private readonly manifestRegistration: vscode.Disposable;

  constructor(
    termsOf: () => DashboardTerms,
    confirmations: ConfirmationStore = createConfirmationStore(),
    persistConfirmations: () => void | PromiseLike<void> = () => {},
    log: LogContext = noLog,
    graphOptions?: { structure(): DashboardStructure },
  ) {
    this.log = log;
    this.termsOf = termsOf;
    this.confirmations = confirmations;
    this.persistConfirmations = persistConfirmations;
    const book = createProbeBook();
    this.session = new DashboardSession(
      {
        ...(graphOptions && {
          graph: {
            prepare: prepareWorkspaceGraphDirectories,
            read: readWorkspaceGraphs,
            publish: async (roots, settings, selections, cache, stillCurrent, log) => {
              const { apps, ownershipSources } = await this.knownAppsWorker.load(
                {
                  roots,
                  settings: { ...settings, apps: selections },
                  discovery: cache,
                },
                log,
              );
              if (new Set(apps.map((app) => app.name)).size !== apps.length)
                throw new Error("Duplicate Module Federation name in graph");
              await writeWorkspaceGraphs(
                roots,
                settings,
                selections,
                apps,
                ownershipSources,
                stillCurrent,
              );
            },
          },
        }),
        readSettings: () => {
          const settings = readWorkspaceSettings();
          return graphOptions ? { ...settings, structure: graphOptions.structure() } : settings;
        },
        writeApps: (apps) => writeWorkspaceApps(apps, this.log),
        scan: prepareWorkspaceScan,
        prepareDiscovery: (roots, settings, log) =>
          this.knownAppsWorker.request("prepare", { roots, settings }, log),
        planDiscovery: (roots, settings, previous, log) =>
          this.knownAppsWorker.request("discover", { roots, settings, previous }, log),
        loadKnown: loadKnownApps,
        loadKnownAsync: (roots, settings, log, discovery) =>
          this.knownAppsWorker.load({ roots, settings, discovery }, log),
        probe: async (target, input) => {
          const checkTypes = this.canCheckTypes();
          if (this.requestedTypeNode)
            this.requestedTypeLinks =
              this.typeLinksForNode(this.requestedTypeNode, input.apps) ?? new Set();
          await probeWorkspace(target, {
            ...input,
            checkTypes,
            typeLinks: this.requestedTypeLinks,
          });
          const verifyStarted = Date.now();
          const installed = new Map<string, InstalledEvidence>();
          if (
            checkTypes &&
            (await verifyTypeInstalls(
              input.apps,
              input.links,
              target,
              this.confirmations,
              this.observation.installChecks,
              input.log,
              undefined,
              installed,
              undefined,
              this.requestedTypeLinks,
            ))
          ) {
            try {
              await this.persistConfirmations();
            } catch (error) {
              (input.log ?? log).event("error", "confirmations.save.failed", safeError(error));
            }
          }
          logDuration(input.log ?? log, "types.verify.completed", verifyStarted, { checkTypes });
          if (checkTypes && this.canCheckTypes()) {
            const evidenceStarted = Date.now();
            this.pendingEvidence = await this.observation.prepare(input.apps, input.links, target, {
              installed,
              log: input.log,
            });
            logDuration(input.log ?? log, "types.evidence.completed", evidenceStarted, {
              producers: this.pendingEvidence.producers.size,
              destinations: this.pendingEvidence.installed.size,
            });
          }
        },
        roots: workspaceRoots,
      },
      book,
      () => {
        this.notify();
      },
      log,
    );
    this.observation = new DashboardTypeObservation(this.session, confirmations, log, (link) =>
      this.canCheckTypes(link),
    );
    this.session.terms = termsOf();
    this.session.renderTypesDirectory = (app, alias) =>
      this.typesDirectories.get(JSON.stringify([app.name, alias]))?.existing ?? null;
    this.session.typesForLink = (link) => this.observation.detailsFor(link).status;
    this.session.typesAutoCheck = readWorkspaceSettings().typesAutoCheck;
    this.session.beforeRefreshChange = (log, probed = true) => {
      this.observation.log = log ?? this.log;
      const links = linksOf(this.session.loaded);
      this.observation.pruneLinks(new Set(links.map(linkProbeId)));
      if (!probed) return false;
      this.session.typesAutoCheck = readWorkspaceSettings().typesAutoCheck;
      const wasPreparing = this.observation.preparing;
      this.observation.preparing = false;
      this.observation.clear(false);
      if (this.pendingEvidence) {
        this.observation.apply(this.pendingEvidence);
        this.pendingEvidence = undefined;
      }
      const typesChanged =
        (this.explicitTypeCheck || this.session.typesAutoCheck) &&
        this.observation.refreshLinks(links, this.explicitTypeCheck);
      const directoriesChanged = this.explicitTypeCheck && this.refreshTypesDirectories();
      return wasPreparing || typesChanged || this.view === null || directoriesChanged;
    };
    this.session.onRefreshFailed = () => {
      this.pendingEvidence = undefined;
      this.clearTypeCache(readWorkspaceSettings().typesAutoCheck);
    };
    this.manifestRegistration = vscode.workspace.registerTextDocumentContentProvider(
      MANIFEST_SCHEME,
      this.manifests,
    );
  }

  dispose(): void {
    this.disposed = true;
    disposeEvidenceWorker();
    this.knownAppsWorker.dispose();
    if (this.timer) clearTimeout(this.timer);
    for (const timer of this.saveTimers.values()) clearTimeout(timer);
    this.saveTimers.clear();
    this.typesWatcher?.dispose();
    this.typesWatcher = undefined;
    this.view = null;
    this.observation.installChecks.clear();
    this.manifestRegistration.dispose();
    this.manifests.dispose();
    this.diagnostics.dispose();
    this.change.dispose();
    this.typesChecked.dispose();
  }

  private notify(): void {
    if (this.disposed) return;
    if (
      this.typesWatchTopology?.apps !== this.session.loaded ||
      this.typesWatchTopology.structure !== this.session.structure
    )
      this.watchTypesDirectories();
    this.view = null;
    if (!this.session.probeRunning) {
      this.publishProblems();
      const next = new Map<string, string>();
      const visit = (rows: DashboardNode[]) => {
        for (const row of rows) {
          const status = row.contextValue.split(" ")[0];
          const key = row.linkId ?? row.id;
          if (!next.has(key) && this.statuses.get(key) !== status) {
            const [consumer, alias] = row.linkId !== null ? splitRemoteLinkKey(row.linkId) : [];
            this.observation.log.event("info", "status.changed", {
              app: row.name,
              status,
              previous: this.statuses.get(key),
              consumer,
              alias,
            });
          }
          next.set(key, status);
          visit(row.children);
        }
      };
      visit(this.viewNodes());
      this.statuses = next;
      this.observation.pruneWarnings(this.session.loaded);
    }
    this.change.fire();
  }

  private publishProblems(settingsFile = settingsDiagnosticFile()): void {
    const drafts = this.session.problemDrafts(settingsFile);
    const { files, entries } = problemDiagnostics(this.publishedFiles, drafts);
    this.publishedFiles = files;
    this.diagnostics.set(entries);
    this.publishedSettingsFile = settingsFile;
  }

  armProbe(): void {
    if (this.disposed) return;
    if (this.timer) clearTimeout(this.timer);
    const ms = readWorkspaceSettings().probeIntervalMs;
    if (ms === 0) {
      this.timer = undefined;
      return;
    }
    this.timer = setTimeout(
      () => {
        void this.refresh("timer")
          .catch(() => {})
          .finally(() => this.armProbe());
      },
      Math.max(1000, ms),
    );
  }

  refresh(source = "manual"): Promise<void> {
    return this.enqueue(source, async (log) => {
      if (source === "manual") await this.withTypeCheck(() => this.session.refresh(source, log));
      else await this.session.refresh(source, log);
      if (!this.disposed && source !== "timer") {
        const settingsFile = settingsDiagnosticFile();
        if (settingsFile !== this.publishedSettingsFile) this.publishProblems(settingsFile);
      }
    });
  }

  private enqueue<T>(source: string, work: (log: LogContext) => Promise<T>): Promise<T> {
    const log = this.log.operation(source);
    const queued = Date.now();
    log.event(source === "timer" ? "debug" : "info", "action.queued");
    return this.run(async () => {
      const started = Date.now();
      const queueMs = started - queued;
      log.event(
        queueMs >= 1000 ? "warn" : source === "timer" ? "debug" : "info",
        "action.started",
        {
          queueMs,
        },
      );
      try {
        return await work(log);
      } finally {
        logDuration(log, "action.finished", started, { queueMs, totalMs: Date.now() - queued });
      }
    });
  }

  checkTypes(node?: DashboardNode): Promise<void> {
    return this.enqueue("types", async (log) => {
      if (node && !this.typeLinksForNode(node)) return;
      await this.withTypeCheck(() => this.session.refresh("types", log), node);
    });
  }

  typesSettingsChanged(): void {
    const automatic = readWorkspaceSettings().typesAutoCheck;
    if (automatic === this.session.typesAutoCheck) return;
    this.session.typesAutoCheck = automatic;
    this.observation.preparing = automatic;
    if (!automatic) {
      for (const timer of this.saveTimers.values()) clearTimeout(timer);
      this.saveTimers.clear();
    }
    this.view = null;
    this.change.fire();
  }

  typesWatcherSettingsChanged(): void {
    this.typesWatchTopology = undefined;
    if (this.view) this.notify();
  }

  private async withTypeCheck(operation: () => Promise<void>, node?: DashboardNode): Promise<void> {
    this.explicitTypeCheck = true;
    this.requestedTypeNode = node;
    this.requestedTypeLinks = node ? (this.typeLinksForNode(node) ?? new Set()) : undefined;
    try {
      await operation();
      if (!this.session.typesAutoCheck) this.typesChecked.fire();
    } finally {
      this.explicitTypeCheck = false;
      this.requestedTypeLinks = undefined;
      this.requestedTypeNode = undefined;
    }
  }

  private canCheckTypes(link?: RemoteLink): boolean {
    if (this.explicitTypeCheck)
      return !link || !this.requestedTypeLinks || this.requestedTypeLinks.has(linkProbeId(link));
    return readWorkspaceSettings().typesAutoCheck;
  }

  private typeLinksForNode(
    node: DashboardNode,
    apps: readonly LocalApp[] = this.session.loaded,
  ): ReadonlySet<string> | null {
    const parsed = node.linkId ? parseLinkId(node.linkId) : null;
    const app = indexedApps(apps).get(parsed?.consumer ?? node.name);
    if (!app?.consumeTypes) return null;
    if (!node.linkId && node.id !== `app:${app.name}`) return null;
    const links = linksOf([app]).filter(
      (link) =>
        !node.linkId ||
        (parsed?.alias === link.alias &&
          parsed.remoteName === link.remoteName &&
          node.name === link.remoteName),
    );
    return links.length > 0 ? new Set(links.map(linkProbeId)) : null;
  }

  discover(onAppsReady?: () => void): Promise<void> {
    return this.enqueue("discovery", (log) => this.session.discover(log, onAppsReady));
  }

  setDiscovering(discovering: boolean): void {
    if (this.discovering === discovering) return;
    this.discovering = discovering;
    this.change.fire();
  }

  async fileSaved(file: string): Promise<void> {
    const settings = readWorkspaceSettings();
    if (this.disposed || settings.probeIntervalMs === 0) return;
    if (this.session.ownershipSources.has(file)) {
      await this.refresh("config");
      return;
    }
    for (const app of this.session.loaded) {
      const kind = savedFileKind(app, file, settings.envMode);
      if (kind === "config") {
        await this.refresh("config");
        return;
      }
      if (
        kind !== "source" ||
        !settings.typesAutoCheck ||
        !incomingLinks(this.session.loaded, app.name).length
      )
        continue;
      let saves = this.sourceSaves.get(app);
      if (!saves) this.sourceSaves.set(app, (saves = new Map()));
      let pending = saves.get(file);
      if (!pending) {
        pending = this.checkSavedSource(app, file, settings.typesSettleMs).finally(() => {
          saves.delete(file);
          if (!saves.size) this.sourceSaves.delete(app);
        });
        saves.set(file, pending);
      }
      await pending;
    }
  }

  private async checkSavedSource(app: LocalApp, file: string, settleMs: number): Promise<void> {
    let identity: SourceIdentity | null;
    try {
      identity = await sourceIdentityForFileAsync(
        app.folder,
        app.tsconfig,
        app.typesFolder,
        file,
        this.log,
      );
    } catch (error) {
      this.observation.warnOnce(`${app.name}\0source`, "types.sources.unreadable", {
        producer: app.name,
        ...safeError(error),
      });
      await this.refreshLocalEvidence(app.name);
      return;
    }
    if (!identity || !this.canRefreshSavedTypes()) return;
    await this.refreshLocalEvidence(app.name, { app, identity });
    if (!this.canRefreshSavedTypes()) return;
    const previous = this.saveTimers.get(app.name);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      this.saveTimers.delete(app.name);
      if (!this.canRefreshSavedTypes()) return;
      void this.refreshLocalEvidence(app.name).catch((error: unknown) =>
        this.log.event("error", "types.save.check-failed", safeError(error)),
      );
    }, settleMs);
    this.saveTimers.set(app.name, timer);
  }

  private async reload(source: string, log: LogContext): Promise<void> {
    if (readWorkspaceSettings().probeIntervalMs === 0) return;
    await this.withTypeCheck(() => this.session.refresh(source, log));
  }

  relabel(next: DashboardTerms = this.termsOf()): void {
    this.session.relabel(next);
  }

  setStructure(structure: "flat" | "tree"): void {
    this.session.setStructure(structure);
  }

  setFlatSort(sort: DashboardSession["flatSort"]): void {
    this.session.setFlatSort(sort);
  }

  refetch(linkId: string): boolean {
    return this.session.refetch(linkId);
  }

  releaseRefetch(linkId: string): void {
    this.session.releaseRefetch(linkId);
  }

  finishRefetch(linkId: string): Promise<void> {
    return this.enqueue("fetch", (log) => this.finishRefetchNow(linkId, log));
  }

  private async finishRefetchNow(linkId: string, log: LogContext): Promise<void> {
    const parsed = parseLinkId(linkId);
    const consumer = parsed
      ? this.session.loaded.find((app) => app.name === parsed.consumer)
      : undefined;
    const remote = consumer?.remotes.find(
      (item) => item.alias === parsed?.alias && item.name === parsed.remoteName,
    );
    if (!parsed || !consumer?.consumeTypes || !remote || remote.url == null) {
      this.session.failRefetch(linkId);
      return;
    }
    const link: RemoteLink = {
      consumer: parsed.consumer,
      alias: parsed.alias,
      remoteName: parsed.remoteName,
      url: remote.url,
    };
    const settings = readWorkspaceSettings();
    const started = Date.now();
    log.event("info", "types.fetch.started", { app: consumer.name, alias: remote.alias });
    try {
      const installed = await installRemoteTypes(
        consumer,
        remote,
        remote.url,
        settings.refetchCommand,
        undefined,
        log,
        this.session.loaded,
      ).finally(() => {
        this.refreshChangedTypesDirectories([link]);
      });
      this.confirmations.saveInstall(link, installed.filesFingerprint, installed.zipHash, true);
      await this.persistConfirmations();
      this.clearTypeCache();
      if (readWorkspaceSettings().probeIntervalMs === 0)
        this.observation.recordInstall(link, installed.zipHash);
      log.event("info", "types.fetch.completed", {
        app: consumer.name,
        durationMs: Date.now() - started,
      });
    } catch (error) {
      log.event("error", "types.fetch.failed", { app: consumer.name, ...safeError(error) });
      this.session.failRefetch(linkId);
      return;
    }
    await this.reload("fetch", log);
  }

  async start(node?: DashboardNode): Promise<void> {
    if (!node) return;
    const app = this.session.loaded.find((item) => item.name === node.name);
    if (!app) return;
    const log = this.log.operation("start");
    await startRow(app, this.session, log);
  }

  async openConfig(node?: DashboardNode): Promise<void> {
    const action = this.session.actionFor(node);
    if (!action?.configFile) return;
    await showConfigFile(action.configFile, this.session.terms.missingConfig);
  }

  async openProducerConfig(node?: DashboardNode): Promise<void> {
    const action = this.session.actionFor(node);
    if (!action?.producerConfigFile) return;
    await showConfigFile(action.producerConfigFile, this.session.terms.missingConfig);
  }

  async revealTypes(node?: DashboardNode): Promise<void> {
    const action = this.session.actionFor(node);
    if (!action?.typesDir) return;
    await vscode.commands.executeCommand("revealInExplorer", vscode.Uri.file(action.typesDir));
  }

  async openManifest(node?: DashboardNode): Promise<void> {
    const action = this.session.actionFor(node);
    if (!node || !action?.manifestUrl) return;
    const log = this.log.operation("open-manifest");
    await openManifestPreview(
      this.manifests,
      node.name,
      action.manifestUrl,
      log,
      this.session.terms,
    );
  }

  rebuild(node?: DashboardNode): Promise<void> {
    return this.enqueue("rebuild", (log) => this.rebuildNow(node, log));
  }

  rebuildAll(
    progress: (name: string, index: number, total: number) => void,
    status?: Parameters<typeof rebuildAllTypes>[0]["status"],
    target?: Pick<RebuildAppStatus, "app" | "settingsKey">,
    onStart?: () => void,
  ): Promise<RebuildAllReport | undefined> {
    return this.enqueue("rebuild-all", async (log) => {
      const started = Date.now();
      const report = createRebuildAllReport();
      // The log includes unchanged consumers as well as cached generations.
      const currentApps = new Set<string>();
      let reason: string | undefined = "build-failed";
      let resolveMs: number | undefined;
      let refreshMs: number | undefined;
      const directoryChanges: TypesDirectoryChange[] = [];
      let directoriesChanged = false;
      try {
        const settings = readWorkspaceSettings();
        const appsToBuild = this.session.workspaceGraph?.settings ?? settings.apps;
        const roots = workspaceRoots();
        if (!roots.length || !Object.keys(appsToBuild ?? {}).length) {
          reason = "no-apps";
          return;
        }
        onStart?.();
        const resolveStarted = Date.now();
        reason = "resolve-failed";
        const resolved = await this.knownAppsWorker
          .request("rebuild", { roots, settings: { ...settings, apps: appsToBuild } }, log)
          .then(
            (result) => {
              resolveMs = Date.now() - resolveStarted;
              log.event("info", "types.rebuild.all.resolve", {
                apps: result.apps.length,
                skipped: result.skipped.length,
                target: target?.app,
                durationMs: resolveMs,
              });
              return result;
            },
            (error: unknown) => {
              resolveMs = Date.now() - resolveStarted;
              log.event("error", "types.rebuild.all.resolve", {
                ...safeError(error),
                reason,
                target: target?.app,
                durationMs: resolveMs,
              });
              throw error;
            },
          );
        const { apps, skipped: configIssues, zipPaths } = resolved;
        reason = "build-failed";
        const key = target?.settingsKey ?? target?.app;
        const skipped = target ? configIssues.filter((issue) => issue.app === key) : configIssues;
        if (
          target &&
          !apps.some((app) => app.name === target.app && (app.settingsKey ?? app.name) === key)
        ) {
          const issue = {
            ...(skipped[0] ?? { reason: "Microfrontend configuration changed" }),
            ...target,
          };
          status?.([{ ...issue, status: "skipped" }]);
          report.skipped.push(issue);
          reason = undefined;
          return report;
        }
        status?.(skipped.map((issue) => ({ ...issue, status: "skipped" })));
        log.event("info", "types.rebuild.all.started", { apps: apps.length, target: target?.app });
        await rebuildAllTypes({
          report,
          apps,
          target: target?.app,
          buildConcurrency: settings.buildConcurrency,
          useBuildCache: settings.useBuildCache,
          confirmations: this.confirmations,
          envMode: settings.envMode,
          rebuildCommand: settings.rebuildCommand,
          refetchCommand: settings.refetchCommand,
          zipPathOverride: (app) => zipPaths.get(app.name),
          rebuildConfigStamp: (app) => this.knownAppsWorker.request("rebuildConfigStamp", app, log),
          fingerprintInputs: (app, zip, tsconfig, dependencies) =>
            this.knownAppsWorker.request(
              "fingerprint",
              [
                app,
                { envMode: settings.envMode, rebuildCommand: settings.rebuildCommand },
                zip,
                tsconfig,
                dependencies,
              ],
              log,
            ),
          persist: async () => {
            reason = "persist-failed";
            await this.persistConfirmations();
            reason = "build-failed";
          },
          typesDirectoryChanged: (consumer, alias) => {
            directoryChanges.push({ consumer, alias });
          },
          progress,
          status: (updates) => {
            for (const update of updates) {
              const key = update.settingsKey ?? update.app;
              if (update.status === "current" || update.status === "cached") currentApps.add(key);
              else currentApps.delete(key);
            }
            status?.(updates);
          },
          log,
        }).finally(() => {
          report.skipped.push(...skipped);
          directoriesChanged = this.refreshChangedTypesDirectories(directoryChanges);
        });

        const changedProducers = new Set([
          ...report.rebuilt,
          ...report.failed.map(({ app }) => app),
        ]);
        for (const name of changedProducers) this.publishedZipHashes.delete(name);
        if (changedProducers.size || report.installed.length) {
          reason = "refresh-failed";
          const refreshStarted = Date.now();
          try {
            const links = linksOf(this.session.loaded);
            const changedInstalls = new Set(
              report.installed.map(({ consumer, alias }) => `${consumer}\0${alias}`),
            );
            this.observation.invalidateLinks(
              links
                .filter(
                  (link) =>
                    changedProducers.has(link.remoteName) ||
                    changedInstalls.has(`${link.consumer}\0${link.alias}`),
                )
                .map(linkProbeId),
            );
            this.clearTypeCache();
            this.observation.apply(
              await this.observation.prepare(this.session.loaded, links, this.session.book),
            );
            for (const name of report.rebuilt) this.session.rebuildErrors.delete(name);
            directoriesChanged = false;
            this.notify();
            reason = undefined;
          } finally {
            refreshMs = Date.now() - refreshStarted;
            log.event(reason ? "error" : "info", "types.rebuild.all.refresh", {
              changed: changedProducers.size,
              installed: report.installed.length,
              durationMs: refreshMs,
              reason,
            });
          }
        }
        reason = undefined;
        return report;
      } finally {
        if (directoriesChanged) this.notify();
        log.event("info", "types.rebuild.all.completed", {
          rebuilt: report.rebuilt.length,
          installed: report.installed.length,
          current: currentApps.size,
          skipped: report.skipped.length,
          failed: report.failed.length,
          reason,
          target: target?.app,
          resolveMs,
          refreshMs,
          durationMs: Date.now() - started,
        });
      }
    });
  }

  private async rebuildNow(node: DashboardNode | undefined, log: LogContext): Promise<void> {
    if (!node) return;
    const rootName = node.name;
    const started = Date.now();
    log.event("info", "types.rebuild.started", { app: rootName });
    const settings = readWorkspaceSettings();
    const rebuilt = new Set<string>();
    const directoryChanges: TypesDirectoryChange[] = [];
    let directoriesChanged = false;
    try {
      const graph = this.session.workspaceGraph;
      const appSettings = graph?.settings ?? settings.apps;
      const apps = graph
        ? (
            await this.knownAppsWorker.request(
              "rebuild",
              {
                roots: workspaceRoots(),
                settings: { ...settings, apps: appSettings },
              },
              log,
            )
          ).apps
        : this.session.loaded;
      await rebuildTypes(rootName, {
        log,
        apps,
        book: this.session.book,
        confirmations: this.confirmations,
        published: this.publishedZipHashes,
        settings: {
          "mf-dashboard.scripts.start": settings.startScript,
          "mf-dashboard.apps": appSettings,
          rebuildCommand: settings.rebuildCommand,
          envMode: settings.envMode,
        },
        refetchCommand: () => readWorkspaceSettings().refetchCommand,
        typesDirectoryChanged: (consumer, alias) => {
          directoryChanges.push({ consumer, alias });
        },
        persist: this.persistConfirmations,
        rebuilt: (name) => {
          rebuilt.add(name);
          this.session.clearRebuildError(name);
        },
      }).finally(() => {
        directoriesChanged = this.refreshChangedTypesDirectories(directoryChanges);
      });
      this.session.clearRebuildError(rootName);
      log.event("info", "types.rebuild.completed", {
        app: rootName,
        durationMs: Date.now() - started,
      });
    } catch (error) {
      log.event("error", "types.rebuild.failed", { app: rootName, ...safeError(error) });
      this.session.noteRebuildError(rootName, String(error));
      directoriesChanged = false;
      return;
    } finally {
      if (rebuilt.size && readWorkspaceSettings().probeIntervalMs === 0) {
        const affected = linksOf(this.session.loaded).filter(
          (link) => rebuilt.has(link.consumer) || rebuilt.has(link.remoteName),
        );
        this.observation.invalidateLinks(affected.map(linkProbeId));
        directoriesChanged ||= affected.length > 0;
      }
      if (directoriesChanged) this.notify();
    }
    await this.reload("rebuild", log);
  }

  getTreeItem(element: DashboardNode): vscode.TreeItem {
    const row = element;
    const item = new vscode.TreeItem(
      row.name,
      row.children.length === 0
        ? vscode.TreeItemCollapsibleState.None
        : row.linkId === null
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed,
    );
    item.id = row.id;
    item.description = row.description;
    item.contextValue = row.contextValue;
    if (!readWorkspaceSettings().typesAutoCheck && this.typeLinksForNode(row))
      item.contextValue += " check-types";
    item.iconPath = new vscode.ThemeIcon(icons[row.kind]);
    if (row.kind === "listen" || row.kind === "silent") {
      item.accessibilityInformation = {
        label: [row.name, this.session.terms[row.kind], row.description].filter(Boolean).join(", "),
      };
    }
    return item;
  }

  getChildren(element?: DashboardNode): DashboardNode[] {
    if (this.discovering) return [];
    if (!element) return this.viewNodes();
    return element.children;
  }

  findRow(id: string): DashboardNode | undefined {
    return this.findViewRow((row) => row.id === id);
  }

  findAppRow(name: string): DashboardNode | undefined {
    if (!this.session.loaded.some((app) => app.name === name)) return;
    return this.findViewRow(
      (row) => row.name === name && (row.linkId !== null || row.id === `app:${name}`),
    );
  }

  getParent(node: DashboardNode): DashboardNode | undefined {
    if (!node.linkId) return;
    return this.findViewRow((row) => row.children.some((child) => child.id === node.id));
  }

  private findViewRow(matches: (row: DashboardNode) => boolean): DashboardNode | undefined {
    if (this.discovering) return;
    const pending = [...this.viewNodes()].reverse();
    while (pending.length > 0) {
      const row = pending.pop()!;
      if (matches(row)) return row;
      for (let index = row.children.length - 1; index >= 0; index--)
        pending.push(row.children[index]);
    }
  }

  typeDetails(
    linkId: string,
  ): (LinkTypeObservation & { startToCheck?: true; checkedAt?: number }) | undefined {
    const link = parseLinkId(linkId);
    if (!link) return;
    const remote = this.session.loaded
      .find(({ name }) => name === link.consumer)
      ?.remotes.find(({ alias, name }) => alias === link.alias && name === link.remoteName);
    if (!remote) return;
    const current = { ...link, url: remote.url };
    const details = this.observation.detailsFor(current);
    const checkedAt = this.session.typesAutoCheck ? null : this.observation.checkedAt(current);
    const observation = checkedAt === null ? details : { ...details, checkedAt };
    if (
      observation.status === "none" ||
      observation.archiveMatch === "matches" ||
      observation.archiveMatch === "differs" ||
      observation.sourceFreshness !== "unknown"
    )
      return observation;

    const producer = this.session.loaded.find(({ name }) => name === link.remoteName);
    const port = producer?.port;
    const url = parseHttpUrl(remote.url);
    if (
      producer?.manifest &&
      producer.generateTypes &&
      producer.hasExposes !== false &&
      port != null &&
      url &&
      isLoopbackAtPort(url, port) &&
      this.session.book.apps.get(appProbeId(producer.name))?.portOpen === false &&
      [producer.manifestPath, producer.devManifestPath].some((route) => {
        if (route === undefined) return false;
        const manifest = parseHttpUrl(localManifestUrl(port, route));
        return manifest?.pathname === url.pathname && manifest.search === url.search;
      })
    )
      return { ...observation, startToCheck: true };
    return observation;
  }

  private viewNodes(): DashboardNode[] {
    if (
      this.typesWatchTopology?.apps !== this.session.loaded ||
      this.typesWatchTopology.structure !== this.session.structure
    ) {
      this.watchTypesDirectories();
      this.view = null;
    } else if (this.refreshTypesDirectories(this.unwatchedTypesDirectories)) {
      this.view = null;
    }
    return (this.view ??= this.session.nodes());
  }

  private refreshTypesDirectories(
    directories: Iterable<TypesDirectory> = this.typesDirectories.values(),
  ): boolean {
    let changed = false;
    for (const directory of directories) {
      const { app, alias } = directory;
      const previous = directory.existing;
      const target =
        alias === undefined
          ? appTypesDir(app.folder, app.typesFolder)
          : linkTypesDir(app.folder, alias, app.typesFolder);
      directory.existing = target && directoryExists(target) ? target : null;
      this.updateTypesWatchRoutes(directory);
      if (directory.existing !== previous) changed = true;
    }
    if (this.typesWatchRoutesChanged) this.syncTypesDirectoryWatcher();
    return changed;
  }

  private refreshChangedTypesDirectories(changes: readonly TypesDirectoryChange[]): boolean {
    if (this.disposed || changes.length === 0) return false;
    const directories = new Set<TypesDirectory>();
    const generationRoots = new Set<TypesDirectory>();
    for (const { consumer, alias } of changes) {
      const root = this.typesDirectories.get(JSON.stringify([consumer, undefined]));
      if (root) directories.add(root);
      if (alias === undefined) {
        if (root) generationRoots.add(root);
        continue;
      }
      const dependency = this.typesDirectories.get(JSON.stringify([consumer, alias]));
      if (dependency) directories.add(dependency);
    }
    const locations = new Map<string, boolean>();
    const collectLocations = () => {
      for (const directory of directories) {
        // A generator can change a whole types directory, including previously installed aliases.
        const includeDescendants = generationRoots.has(directory);
        for (const location of directory.locations)
          locations.set(location, includeDescendants || locations.get(location) === true);
      }
    };
    collectLocations();
    const changed = this.refreshTypesDirectories(directories);
    collectLocations();
    const related = new Set<TypesDirectory>();
    for (const [location, includeDescendants] of locations) {
      for (const directory of this.typesWatchPaths.get(location) ?? []) {
        if (
          !directories.has(directory) &&
          (includeDescendants || directory.locations.includes(location))
        )
          related.add(directory);
      }
    }
    return this.refreshTypesDirectories(related) || changed;
  }

  private watchTypesDirectories(): void {
    this.typesWatchTopology = { apps: this.session.loaded, structure: this.session.structure };
    this.typesWatchRoots = (vscode.workspace.workspaceFolders ?? []).map(({ uri }) => {
      const root = path.resolve(uri.fsPath);
      let realRoot = root;
      try {
        realRoot = realpathSync.native(root);
      } catch {
        // Keep the configured root when the folder no longer exists.
      }
      const excludes =
        vscode.workspace
          .getConfiguration("files", uri)
          .get<Record<string, boolean>>("watcherExclude") ?? {};
      const patterns = Object.entries(excludes)
        .filter(([pattern, enabled]) => pattern && enabled === true)
        .map(([pattern]) => {
          const glob = pattern.trim().split(path.sep).join("/").replace(/\/+$/, "");
          const parts = glob.split("/");
          const complex = parts.findIndex(
            (part) => part !== "**" && (!/^[\w.@ :?*-]*$/.test(part) || part.includes("**")),
          );
          // VS Code and Picomatch differ on complex globs. Recheck everything under the common prefix.
          const covered = complex < 0 ? glob : [...parts.slice(0, complex), "**"].join("/");
          const absolute = path.isAbsolute(pattern) || pattern.startsWith("**");
          try {
            const match = picomatch(covered, { dot: true, nocase: process.platform !== "linux" });
            return { absolute, match };
          } catch {
            return { absolute, match: () => true };
          }
        });
      return {
        root,
        realRoot,
        excluded: (entry, relative) =>
          patterns.some(({ absolute, match }) =>
            match((absolute ? entry : relative).split(path.sep).join("/")),
          ),
      };
    });
    this.typesWatchPaths.clear();
    this.typesWatchNames.clear();
    this.dirtyTypesDirectories.clear();
    this.unwatchedTypesDirectories.clear();
    this.typesWatchRoutesChanged = true;
    this.typesDirectories.clear();
    const add = (app: LocalApp, alias?: string) => {
      this.typesDirectories.set(JSON.stringify([app.name, alias]), {
        app,
        alias,
        existing: null,
        locations: [],
        routes: new Set(),
      });
    };
    for (const app of this.session.loaded) {
      add(app);
      if (this.session.structure === "tree") {
        for (const { alias } of app.remotes) add(app, alias);
      }
    }
    this.refreshTypesDirectories();
  }

  private updateTypesWatchRoutes(directory: TypesDirectory): void {
    const paths = new Map<string, string>();
    const add = (target: string) => {
      let inside = false;
      let excluded = false;
      for (const { root, realRoot, excluded: isExcluded } of this.typesWatchRoots) {
        const base = pathIsInside(root, target) ? root : realRoot;
        if (!pathIsInside(base, target)) continue;
        // Only an ancestor may be reported after a rename or deletion.
        const file = path.resolve(base, path.relative(base, target));
        inside ||= file !== base;
        for (let entry = file; ; entry = path.dirname(entry)) {
          const relative = path.relative(base, entry);
          const configured = path.join(root, relative);
          const resolved = path.join(realRoot, relative);
          paths.set(this.typesWatchPath(configured), path.basename(configured));
          if (root !== realRoot) paths.set(this.typesWatchPath(resolved), path.basename(resolved));
          if (isExcluded(configured, relative) || isExcluded(resolved, relative)) excluded = true;
          if (entry === base) break;
        }
      }
      return inside && !excluded;
    };
    const { app, alias } = directory;
    const folder = path.resolve(app.folder, app.typesFolder);
    const target = alias === undefined ? folder : path.resolve(folder, alias);
    directory.locations = [this.typesWatchPath(target)];
    let watched = false;
    if (
      this.typesWatchRoots.length &&
      pathIsInside(app.folder, folder) &&
      pathIsInside(folder, target)
    ) {
      const configured = add(target);
      const route = new Set<string>();
      try {
        const resolved = resolveTypesPath(app.folder, target, route);
        directory.locations.push(this.typesWatchPath(resolved));
        watched = add(resolved) && configured;
      } catch {
        // A failed lookup may leave the symlink route incomplete.
      }
      for (const entry of route) {
        if (!add(entry)) watched = false;
      }
    }
    for (const entry of directory.routes) {
      if (paths.has(entry)) continue;
      const targets = this.typesWatchPaths.get(entry)!;
      targets.delete(directory);
      if (!targets.size) {
        this.typesWatchPaths.delete(entry);
        this.typesWatchNames.delete(entry);
        this.typesWatchRoutesChanged = true;
      }
    }
    for (const [entry, name] of paths) {
      if (directory.routes.has(entry)) continue;
      const targets = this.typesWatchPaths.get(entry);
      if (targets) targets.add(directory);
      else {
        this.typesWatchPaths.set(entry, new Set([directory]));
        this.typesWatchNames.set(entry, name);
        this.typesWatchRoutesChanged = true;
      }
    }
    directory.routes = new Set(paths.keys());
    if (watched && paths.size) this.unwatchedTypesDirectories.delete(directory);
    else this.unwatchedTypesDirectories.add(directory);
  }

  private syncTypesDirectoryWatcher(): void {
    this.typesWatchRoutesChanged = false;
    const sorted = [...new Set(this.typesWatchNames.values())].filter(Boolean).sort();
    const pattern = !sorted.length
      ? undefined
      : sorted.some((name) => /[[\]{}*,?]/.test(name))
        ? "**"
        : sorted.length === 1
          ? `**/${sorted[0]}`
          : `**/{${sorted.join(",")}}`;
    if (pattern === this.typesWatchPattern) return;
    this.typesWatcher?.dispose();
    this.typesWatchPattern = pattern;
    this.typesWatcher = pattern ? vscode.workspace.createFileSystemWatcher(pattern) : undefined;
    this.typesWatcher?.onDidCreate(this.typesDirectoryChanged);
    this.typesWatcher?.onDidChange(this.typesDirectoryChanged);
    this.typesWatcher?.onDidDelete(this.typesDirectoryChanged);
  }

  private typesWatchPath(file: string): string {
    return process.platform === "linux" ? file : file.toLowerCase();
  }

  private readonly typesDirectoryChanged = (uri: vscode.Uri): void => {
    const targets = this.typesWatchPaths.get(this.typesWatchPath(uri.fsPath));
    if (!targets) return;
    for (const directory of targets) this.dirtyTypesDirectories.add(directory);
    if (this.typesWatchPending) return;
    this.typesWatchPending = true;
    queueMicrotask(() => {
      this.typesWatchPending = false;
      if (this.disposed) return;
      const changed = this.refreshTypesDirectories(this.dirtyTypesDirectories);
      this.dirtyTypesDirectories.clear();
      if (this.view && changed) this.notify();
    });
  };

  private clearTypeCache(resetTypes = this.canCheckTypes()): void {
    this.observation.clear(
      resetTypes,
      this.explicitTypeCheck ? this.requestedTypeLinks : undefined,
    );
    this.view = null;
  }

  private canRefreshSavedTypes(): boolean {
    return !this.disposed && readWorkspaceSettings().typesAutoCheck;
  }

  private refreshLocalEvidence(
    name: string,
    source?: { app: LocalApp; identity: SourceIdentity },
  ): Promise<void> {
    this.dirtySaves.set(name, source);
    const existing = this.saveChecks.get(name);
    if (existing) return existing;
    const check = this.run(async () => {
      while (this.dirtySaves.has(name)) {
        const source = this.dirtySaves.get(name);
        this.dirtySaves.delete(name);
        if (!this.canRefreshSavedTypes()) return;
        const links = incomingLinks(this.session.loaded, name);
        const evidence = await this.observation.prepare(
          this.session.loaded,
          links,
          this.session.book,
          { allowDownload: false, source },
        );
        if (!this.canRefreshSavedTypes()) return;
        this.observation.invalidateProducer(name);
        this.observation.apply(evidence);
        if (this.observation.refreshLinks(links, false)) this.notify();
      }
    }).finally(() => {
      if (this.saveChecks.get(name) === check) this.saveChecks.delete(name);
    });
    this.saveChecks.set(name, check);
    return check;
  }
}
