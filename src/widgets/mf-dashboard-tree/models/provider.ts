import * as vscode from "vscode";
import {
  createConfirmationStore,
  disposeEvidenceWorker,
  sourceContainsAsync,
  type ConfirmationStore,
  type InstalledEvidence,
} from "../../../entities/federated-types/index.ts";
import {
  appPortIsOpen,
  createProbeBook,
  linkProbeId,
  probeWorkspace,
  scanWorkspace,
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
  rebuildAllTypes,
  rebuildTypes,
  type RebuildAllReport,
} from "../../../features/rebuild-types/index.ts";
import { installRemoteTypes } from "../../../features/refetch-types/index.ts";
import { icons, type DashboardTerms } from "../../../shared/config/index.ts";
import { noLog } from "../../../shared/config/logging.ts";
import { logDuration, safeError } from "../../../shared/lib/logging.ts";
import { createSerialQueue } from "../../../shared/lib/queue.ts";
import type { LogContext } from "../../../shared/models/logging.ts";
import { savedFileKind } from "../lib/app-parse-cache.ts";
import { directoryStamp } from "../lib/directory-stamp.ts";
import { loadKnownApps } from "../lib/known-apps.ts";
import { linksOf, parseLinkId } from "../lib/links.ts";
import { showConfigFile } from "../lib/open-config.ts";
import { problemDiagnostics } from "../lib/problem-diagnostics.ts";
import { resolveRebuildApps } from "../lib/rebuild-apps.ts";
import { startRow } from "../lib/start-row.ts";
import { appTypesDir, linkTypesDir } from "../lib/targets.ts";
import {
  readWorkspaceSettings,
  settingsDiagnosticFile,
  workspaceRoots,
  writeWorkspaceApps,
} from "../lib/workspace-settings.ts";
import type { DashboardNode } from "./presentation.ts";
import { DashboardSession } from "./session.ts";
import type { TypeEvidence } from "./type-observation-types.ts";
import { DashboardTypeObservation } from "./type-observation.ts";

export class MfDashboardProvider
  implements vscode.TreeDataProvider<DashboardNode>, vscode.Disposable
{
  private readonly change = new vscode.EventEmitter<DashboardNode | undefined | null | void>();
  readonly onDidChangeTreeData = this.change.event;
  private readonly diagnostics = vscode.languages.createDiagnosticCollection("mf-dashboard");
  private publishedFiles: string[] = [];
  readonly session: DashboardSession;
  private readonly run = createSerialQueue();
  private readonly termsOf: () => DashboardTerms;
  private readonly confirmations: ConfirmationStore;
  private readonly persistConfirmations: () => void | PromiseLike<void>;
  private readonly observation: DashboardTypeObservation;
  private readonly saveChecks = new Map<string, Promise<void>>();
  private readonly dirtySaves = new Set<string>();
  private readonly membershipChecks = new Map<string, Promise<boolean>>();
  private pendingEvidence: TypeEvidence | undefined;
  private readonly publishedZipHashes = new Map<string, string>();
  private explicitTypeCheck = false;
  private requestedTypeLinks: ReadonlySet<string> | undefined;
  private requestedTypeNode: DashboardNode | undefined;
  private view: { nodes: DashboardNode[]; stamp: string } | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private disposed = false;
  private readonly log: LogContext;
  private statuses = new Map<string, string>();
  private readonly manifests = new ManifestDocuments();
  private readonly manifestRegistration: vscode.Disposable;

  constructor(
    termsOf: () => DashboardTerms,
    confirmations: ConfirmationStore = createConfirmationStore(),
    persistConfirmations: () => void | PromiseLike<void> = () => {},
    log: LogContext = noLog,
  ) {
    this.log = log;
    this.termsOf = termsOf;
    this.confirmations = confirmations;
    this.persistConfirmations = persistConfirmations;
    const book = createProbeBook();
    this.session = new DashboardSession(
      {
        readSettings: readWorkspaceSettings,
        writeApps: (apps) => writeWorkspaceApps(apps, this.log),
        scan: scanWorkspace,
        loadKnown: loadKnownApps,
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
            this.pendingEvidence = await this.observation.prepare(
              input.apps,
              input.links,
              target,
              installed,
              input.log,
            );
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
    this.session.typesForLink = (link) => this.observation.statusFor(link);
    this.session.typesAutoCheck = readWorkspaceSettings().typesAutoCheck;
    this.session.typesCheckedAt = (link) => this.observation.checkedAt(link);
    this.session.beforeRefreshChange = (log) => {
      this.observation.log = log ?? this.log;
      this.session.typesAutoCheck = readWorkspaceSettings().typesAutoCheck;
      this.observation.preparing = false;
      this.clearTypeCache();
      if (this.pendingEvidence) {
        this.observation.apply(this.pendingEvidence);
        this.pendingEvidence = undefined;
      }
      this.observation.pruneLinks(new Set(linksOf(this.session.loaded).map(linkProbeId)));
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
    if (this.timer) clearTimeout(this.timer);
    for (const timer of this.saveTimers.values()) clearTimeout(timer);
    this.saveTimers.clear();
    this.view = null;
    this.observation.installChecks.clear();
    this.manifestRegistration.dispose();
    this.manifests.dispose();
    this.diagnostics.dispose();
    this.change.dispose();
  }

  private notify(): void {
    if (this.disposed) return;
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

  private publishProblems(): void {
    const drafts = this.session.problemDrafts(settingsDiagnosticFile());
    const { files, entries } = problemDiagnostics(this.publishedFiles, drafts);
    this.publishedFiles = files;
    this.diagnostics.set(entries);
  }

  armProbe(): void {
    if (this.disposed) return;
    if (this.timer) clearTimeout(this.timer);
    const ms = Math.max(1000, readWorkspaceSettings().probeIntervalMs);
    this.timer = setTimeout(() => {
      void this.refresh("timer")
        .catch(() => {})
        .finally(() => this.armProbe());
    }, ms);
  }

  refresh(source = "manual"): Promise<void> {
    return this.enqueue(source, (log) =>
      source === "manual"
        ? this.withTypeCheck(() => this.session.refresh(source, log))
        : this.session.refresh(source, log),
    );
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
    this.session.typesAutoCheck = automatic;
    this.observation.preparing = automatic;
    if (!automatic) {
      for (const timer of this.saveTimers.values()) clearTimeout(timer);
      this.saveTimers.clear();
    }
    this.view = null;
    this.change.fire();
  }

  private async withTypeCheck(operation: () => Promise<void>, node?: DashboardNode): Promise<void> {
    this.explicitTypeCheck = true;
    this.requestedTypeNode = node;
    this.requestedTypeLinks = node ? (this.typeLinksForNode(node) ?? new Set()) : undefined;
    try {
      await operation();
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
    const app = apps.find((item) => item.name === (parsed?.consumer ?? node.name));
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

  discover(): Promise<void> {
    return this.enqueue("discovery", (log) => this.session.discover(log));
  }

  async fileSaved(file: string): Promise<void> {
    if (this.disposed) return;
    const settings = readWorkspaceSettings();
    for (const app of this.session.loaded) {
      const kind = savedFileKind(app, file, settings.envMode);
      if (kind === "config") {
        await this.refresh("config");
        return;
      }
      if (kind !== "source" || !settings.typesAutoCheck) continue;
      let included: boolean;
      try {
        const key = JSON.stringify([app.folder, app.tsconfig, app.typesFolder, file]);
        let membership = this.membershipChecks.get(key);
        if (!membership) {
          membership = sourceContainsAsync(app.folder, app.tsconfig, app.typesFolder, file);
          this.membershipChecks.set(key, membership);
          void membership
            .finally(() => {
              if (this.membershipChecks.get(key) === membership) this.membershipChecks.delete(key);
            })
            .catch(() => {});
        }
        included = await membership;
      } catch (error) {
        this.observation.warnOnce(`${app.name}\0source`, "types.sources.unreadable", {
          producer: app.name,
          ...safeError(error),
        });
        await this.refreshLocalEvidence(app.name);
        continue;
      }
      if (!included || !this.canRefreshSavedTypes()) continue;
      await this.refreshLocalEvidence(app.name);
      if (!this.canRefreshSavedTypes()) continue;
      const previous = this.saveTimers.get(app.name);
      if (previous) clearTimeout(previous);
      const timer = setTimeout(() => {
        this.saveTimers.delete(app.name);
        if (!this.canRefreshSavedTypes()) return;
        void this.refreshLocalEvidence(app.name).catch((error: unknown) =>
          this.log.event("error", "types.save.check-failed", safeError(error)),
        );
      }, settings.typesSettleMs);
      this.saveTimers.set(app.name, timer);
    }
  }

  private async reload(source: string, log: LogContext): Promise<void> {
    await this.withTypeCheck(() => this.session.refresh(source, log));
  }

  relabel(next: DashboardTerms = this.termsOf()): void {
    this.session.relabel(next);
  }

  setStructure(structure: "flat" | "tree"): void {
    this.session.setStructure(structure);
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
    const consumerOpen = consumer ? appPortIsOpen(this.session.book, consumer.name) : false;
    if (!parsed || !consumer || !remote || !consumerOpen || remote.url == null) {
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
      );
      this.confirmations.saveInstall(link, installed.filesFingerprint, installed.zipHash, true);
      await this.persistConfirmations();
      this.clearTypeCache();
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
    await showConfigFile(action.configFile);
  }

  async openProducerConfig(node?: DashboardNode): Promise<void> {
    const action = this.session.actionFor(node);
    if (!action?.producerConfigFile) return;
    await showConfigFile(action.producerConfigFile);
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
    await openManifestPreview(this.manifests, node.name, action.manifestUrl, log);
  }

  rebuild(node?: DashboardNode): Promise<void> {
    return this.enqueue("rebuild", (log) => this.rebuildNow(node, log));
  }

  rebuildAll(
    progress: (name: string, index: number, total: number) => void,
  ): Promise<RebuildAllReport> {
    return this.enqueue("rebuild-all", async (log) => {
      const settings = readWorkspaceSettings();
      const { apps, skipped, zipPaths } = resolveRebuildApps(settings, log);
      log.event("info", "types.rebuild.all.started", { apps: apps.length });
      const report = await rebuildAllTypes({
        apps,
        confirmations: this.confirmations,
        envMode: settings.envMode,
        rebuildCommand: settings.rebuildCommand,
        refetchCommand: settings.refetchCommand,
        zipPathOverride: (app) => zipPaths.get(app.name),
        persist: this.persistConfirmations,
        progress,
        log,
      });
      report.skipped.push(...skipped);
      const changedProducers = new Set([...report.rebuilt, ...report.failed.map(({ app }) => app)]);
      for (const name of changedProducers) this.publishedZipHashes.delete(name);
      if (changedProducers.size || report.installed.length) {
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
        this.notify();
      }
      log.event("info", "types.rebuild.all.completed", {
        rebuilt: report.rebuilt.length,
        installed: report.installed.length,
        current: report.current.length,
        skipped: report.skipped.length,
        failed: report.failed.length,
      });
      return report;
    });
  }

  private async rebuildNow(node: DashboardNode | undefined, log: LogContext): Promise<void> {
    if (!node) return;
    const rootName = node.name;
    const started = Date.now();
    log.event("info", "types.rebuild.started", { app: rootName });
    const settings = readWorkspaceSettings();
    try {
      await rebuildTypes(rootName, {
        log,
        apps: this.session.loaded,
        book: this.session.book,
        confirmations: this.confirmations,
        published: this.publishedZipHashes,
        settings: {
          "mf-dashboard.scripts.start": settings.startScript,
          "mf-dashboard.apps": settings.apps,
          rebuildCommand: settings.rebuildCommand,
          envMode: settings.envMode,
        },
        refetchCommand: () => readWorkspaceSettings().refetchCommand,
        persist: this.persistConfirmations,
        rebuilt: (name) => this.session.clearRebuildError(name),
      });
      this.session.clearRebuildError(rootName);
      log.event("info", "types.rebuild.completed", {
        app: rootName,
        durationMs: Date.now() - started,
      });
    } catch (error) {
      log.event("error", "types.rebuild.failed", { app: rootName, ...safeError(error) });
      this.session.noteRebuildError(rootName, String(error));
      return;
    }
    await this.reload("rebuild", log);
  }

  getTreeItem(element: DashboardNode): vscode.TreeItem {
    const row = element;
    const item = new vscode.TreeItem(
      row.name,
      row.children.length > 0
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None,
    );
    item.id = row.id;
    item.description = row.description;
    item.contextValue = row.contextValue;
    if (!readWorkspaceSettings().typesAutoCheck && this.typeLinksForNode(row))
      item.contextValue += " check-types";
    item.iconPath = new vscode.ThemeIcon(icons[row.kind]);
    return item;
  }

  getChildren(element?: DashboardNode): DashboardNode[] {
    if (!element) return this.viewNodes();
    return element.children;
  }

  findRow(id: string): DashboardNode | undefined {
    const pending = [...(this.view?.nodes ?? this.viewNodes())];
    while (pending.length > 0) {
      const row = pending.pop()!;
      if (row.id === id) return row;
      for (const child of row.children) pending.push(child);
    }
  }

  private viewNodes(): DashboardNode[] {
    const stamp = this.typesStamp();
    if (this.view?.stamp === stamp) return this.view.nodes;
    const nodes = this.session.nodes();
    this.view = { nodes, stamp };
    return nodes;
  }

  // The probe book does not record whether a types path is a directory.
  // Comparing that shape keeps Reveal types current without building the tree again.
  private typesStamp(): string {
    if (!readWorkspaceSettings().typesAutoCheck) return "";
    const rows: string[] = [];
    for (const app of this.session.loaded) {
      rows.push(directoryStamp(appTypesDir(app.folder, app.typesFolder)));
      if (this.session.structure === "flat") continue;
      for (const remote of app.remotes)
        rows.push(directoryStamp(linkTypesDir(app.folder, remote.alias, app.typesFolder)));
    }
    return rows.join("\n");
  }

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

  private refreshLocalEvidence(name: string): Promise<void> {
    this.dirtySaves.add(name);
    const existing = this.saveChecks.get(name);
    if (existing) return existing;
    const check = this.run(async () => {
      while (this.dirtySaves.delete(name)) {
        if (!this.canRefreshSavedTypes()) return;
        const links = linksOf(this.session.loaded).filter((link) => link.remoteName === name);
        const evidence = await this.observation.prepare(
          this.session.loaded,
          links,
          this.session.book,
        );
        if (!this.canRefreshSavedTypes()) return;
        this.observation.invalidateLinks(links.map(linkProbeId));
        this.observation.invalidateProducer(name);
        this.observation.apply(evidence);
        this.notify();
      }
    }).finally(() => {
      if (this.saveChecks.get(name) === check) this.saveChecks.delete(name);
    });
    this.saveChecks.set(name, check);
    return check;
  }
}
