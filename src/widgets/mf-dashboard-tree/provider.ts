import { noLog, safeError, type LogContext } from "../../shared/logging.ts";
import {
  collectProducerEvidence,
  collectProducerEvidenceAsync,
  type ProducerSnapshot,
} from "../../features/rebuild-types/evidence.ts";
import fs, { existsSync } from "node:fs";
import path from "node:path";
import * as vscode from "vscode";
import type { DashboardTerms } from "../../shared/config/index.ts";
import { icons } from "../../shared/config/index.ts";
import { createSerialQueue } from "../../shared/queue.ts";
import { installRemoteTypes } from "../../features/refetch-types/remote.ts";
import { rebuildAllTypes, type RebuildAllReport } from "../../features/rebuild-types/all.ts";
import { rebuildTypes } from "../../features/rebuild-types/workflow.ts";
import { verifyTypeInstalls, type InstallCheck } from "../../features/observe-types/verify.ts";
import {
  appProbeId,
  createProbeBook,
  linkProbeId,
  scanWorkspace,
  type LocalApp,
  type RemoteLink,
} from "../../entities/microfrontend/index.ts";
import { diagnosticUpdates, extraManifestSettingsFile } from "../../entities/status/index.ts";
import {
  createConfirmationStore,
  type ConfirmationStore,
  describeLink,
  readInstalledEvidence,
  readInstalledEvidenceAsync,
  disposeEvidenceWorker,
  type InstalledEvidence,
  sourceContainsAsync,
} from "../../entities/federated-types/index.ts";
import { resolveStartScript } from "../../features/init-settings/index.ts";
import { refetchTarget, typesRootTarget } from "../../features/refetch-types/refetch.ts";
import { MANIFEST_SCHEME, ManifestDocuments } from "../../features/open-manifest/documents.ts";
import { manifestFailureMessage, manifestPreviewText } from "../../features/open-manifest/text.ts";
import {
  lookupScript,
  resolvePackageManager,
  startInvocation,
} from "../../features/start-app/index.ts";
import {
  linksOf,
  loadKnownApps,
  savedFileKind,
  DashboardSession,
  type AppSetting,
  type DashboardNode,
  type DashboardSettings,
  type WorkspaceRoot,
} from "./session.ts";
import { createLoopbackNet, probeWorkspace } from "../../entities/microfrontend/net.ts";

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function readWorkspaceSettings(): DashboardSettings & {
  packageManager: string;
  probeIntervalMs: number;
  typesSettleMs: number;
  terminalReveal: boolean;
  startScript: string;
  rebuildCommand: string;
  refetchCommand: string;
  typesAutoCheck: boolean;
} {
  const config = vscode.workspace.getConfiguration("mf-dashboard");
  const inspected = config.inspect<unknown>("apps");
  const raw =
    inspected?.workspaceFolderValue ?? inspected?.workspaceValue ?? inspected?.globalValue;
  const apps = raw === undefined ? undefined : isAppMap(raw) ? raw : {};
  return {
    apps,
    envMode: config.get<string>("envMode") ?? "development",
    ignorePaths: stringList(config.get("ignorePaths")),
    extraManifestUrls: stringList(config.get("extraManifestUrls")),
    structure: config.get<string>("structure") === "flat" ? "flat" : "tree",
    packageManager: config.get<string>("packageManager") ?? "auto",
    probeIntervalMs: finiteNumber(config.get("probeIntervalMs"), 5000),
    typesSettleMs: finiteNumber(config.get("typesSettleMs"), 15000),
    typesAutoCheck: config.get<boolean>("types.autoCheck") ?? true,
    terminalReveal: config.get<boolean>("terminal.reveal") ?? true,
    startScript: config.get<string>("scripts.start") ?? "dev",
    rebuildCommand: config.get<string>("commands.rebuildTypes") ?? "",
    refetchCommand: config.get<string>("commands.refetchTypes") ?? "",
  };
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function isAppMap(value: unknown): value is Record<string, AppSetting> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function writeWorkspaceApps(apps: Record<string, AppSetting>): Promise<void> {
  await vscode.workspace
    .getConfiguration("mf-dashboard")
    .update("apps", apps, vscode.ConfigurationTarget.Workspace);
}

function settingsDiagnosticFile(): string | null {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const workspaceFile = vscode.workspace.workspaceFile;
  const inspected = vscode.workspace
    .getConfiguration("mf-dashboard")
    .inspect<unknown>("extraManifestUrls");
  return extraManifestSettingsFile({
    workspaceValueDefined: inspected?.workspaceValue !== undefined,
    workspaceFile: workspaceFile ?? null,
    singleFolderPath: folders.length === 1 ? folders[0].uri.fsPath : null,
  });
}

function workspaceRoots(): WorkspaceRoot[] {
  return (vscode.workspace.workspaceFolders ?? []).map((folder) => ({
    name: folder.name,
    path: folder.uri.fsPath,
  }));
}

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
  private readonly producerCache = new Map<string, ProducerSnapshot>();
  private readonly installedCache = new Map<string, InstalledEvidence>();
  private readonly sourceErrors = new Map<string, unknown>();
  private readonly saveChecks = new Map<string, Promise<void>>();
  private readonly dirtySaves = new Set<string>();
  private readonly membershipChecks = new Map<string, Promise<boolean>>();
  private typesPreparing = false;
  private pendingEvidence:
    | {
        producers: Map<string, ProducerSnapshot>;
        installed: Map<string, InstalledEvidence>;
        errors: Map<string, unknown>;
      }
    | undefined;
  private readonly publishedZipHashes = new Map<string, string>();
  private readonly typeCache = new Map<
    string,
    {
      status: ReturnType<typeof describeLink>;
      checkedAt: number;
      signature: string;
    }
  >();
  private explicitTypeCheck = false;
  private requestedTypeLinks: ReadonlySet<string> | undefined;
  private requestedTypeNode: DashboardNode | undefined;
  private readonly installChecks = new Map<string, InstallCheck>();
  private view: { nodes: DashboardNode[]; stamp: string } | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private disposed = false;
  private readonly log: LogContext;
  private observationLog: LogContext;
  private readonly warnings = new Set<string>();
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
    this.observationLog = log;
    this.termsOf = termsOf;
    this.confirmations = confirmations;
    this.persistConfirmations = persistConfirmations;
    const book = createProbeBook();
    this.session = new DashboardSession(
      {
        readSettings: readWorkspaceSettings,
        writeApps: writeWorkspaceApps,
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
          const installed = new Map<string, InstalledEvidence>();
          if (
            checkTypes &&
            (await verifyTypeInstalls(
              input.apps,
              input.links,
              target,
              this.confirmations,
              this.installChecks,
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
          if (checkTypes && this.canCheckTypes())
            this.pendingEvidence = await this.prepareEvidence(
              input.apps,
              input.links,
              target,
              installed,
            );
        },
        roots: workspaceRoots,
      },
      book,
      () => {
        this.notify();
      },
      log,
    );
    this.session.terms = termsOf();
    this.session.typesForLink = (link) => this.cachedTypes(link);
    this.session.typesAutoCheck = readWorkspaceSettings().typesAutoCheck;
    this.session.typesCheckedAt = (link) => this.typeSnapshot(link)?.checkedAt ?? null;
    this.session.beforeRefreshChange = (log) => {
      this.observationLog = log ?? this.log;
      this.session.typesAutoCheck = readWorkspaceSettings().typesAutoCheck;
      this.typesPreparing = false;
      this.clearTypeCache();
      if (this.pendingEvidence) {
        for (const [key, value] of this.pendingEvidence.producers)
          this.producerCache.set(key, value);
        for (const [key, value] of this.pendingEvidence.installed)
          this.installedCache.set(key, value);
        for (const [key, value] of this.pendingEvidence.errors) this.sourceErrors.set(key, value);
        this.pendingEvidence = undefined;
      }
      const active = new Set(linksOf(this.session.loaded).map(linkProbeId));
      for (const key of this.typeCache.keys()) if (!active.has(key)) this.typeCache.delete(key);
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
    this.installChecks.clear();
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
          if (!next.has(key) && this.statuses.get(key) !== status)
            this.observationLog.event("info", "status.changed", {
              app: row.name,
              status,
              previous: this.statuses.get(key),
              consumer: row.linkId?.split("\0")[0],
              alias: row.linkId?.split("\0")[1],
            });
          next.set(key, status);
          visit(row.children);
        }
      };
      visit(this.viewNodes());
      this.statuses = next;
      const warningKeys = new Set(
        this.session.loaded.flatMap((app) =>
          app.remotes.flatMap((remote) => [
            `${app.name}\0${remote.alias}\0path`,
            `${app.name}\0${remote.alias}\0read`,
          ]),
        ),
      );
      for (const key of this.warnings) if (!warningKeys.has(key)) this.warnings.delete(key);
    }
    this.change.fire();
  }

  private publishProblems(): void {
    const drafts = this.session.problemDrafts(settingsDiagnosticFile());
    const byFile = new Map<string, vscode.Diagnostic[]>();
    for (const draft of drafts) {
      const diagnostic = new vscode.Diagnostic(
        new vscode.Range(0, 0, 0, 0),
        draft.message,
        draft.severity === "warning"
          ? vscode.DiagnosticSeverity.Warning
          : vscode.DiagnosticSeverity.Information,
      );
      diagnostic.source = "MF Dashboard";
      const list = byFile.get(draft.file) ?? [];
      list.push(diagnostic);
      byFile.set(draft.file, list);
    }
    const updates = diagnosticUpdates(this.publishedFiles, [...byFile.keys()]);
    this.publishedFiles = [...byFile.keys()];
    this.diagnostics.set(
      updates.map(
        ({ file, present }) =>
          [vscode.Uri.file(file), present ? byFile.get(file) : undefined] as [
            vscode.Uri,
            vscode.Diagnostic[] | undefined,
          ],
      ),
    );
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
    return this.run(() =>
      source === "manual"
        ? this.withTypeCheck(() => this.session.refresh(source))
        : this.session.refresh(source),
    );
  }

  checkTypes(node?: DashboardNode): Promise<void> {
    return this.run(async () => {
      if (node && !this.typeLinksForNode(node)) return;
      await this.withTypeCheck(() => this.session.refresh("types"), node);
    });
  }

  typesSettingsChanged(): void {
    const automatic = readWorkspaceSettings().typesAutoCheck;
    this.session.typesAutoCheck = automatic;
    this.typesPreparing = automatic;
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
    return this.run(() => this.session.discover());
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
        this.warnOnce(`${app.name}\0source`, "types.sources.unreadable", {
          producer: app.name,
          ...safeError(error),
        });
        await this.refreshLocalEvidence(app.name);
        continue;
      }
      if (!included || this.disposed || !readWorkspaceSettings().typesAutoCheck) continue;
      await this.refreshLocalEvidence(app.name);
      if (this.disposed || !readWorkspaceSettings().typesAutoCheck) continue;
      const previous = this.saveTimers.get(app.name);
      if (previous) clearTimeout(previous);
      const timer = setTimeout(() => {
        this.saveTimers.delete(app.name);
        if (this.disposed || !readWorkspaceSettings().typesAutoCheck) return;
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
    return this.run(() => this.finishRefetchNow(linkId));
  }

  private async finishRefetchNow(linkId: string): Promise<void> {
    const parsed = parseLinkId(linkId);
    const consumer = parsed
      ? this.session.loaded.find((app) => app.name === parsed.consumer)
      : undefined;
    const remote = consumer?.remotes.find(
      (item) => item.alias === parsed?.alias && item.name === parsed.remoteName,
    );
    const consumerOpen = consumer
      ? this.session.book.apps.get(appProbeId(consumer.name))?.portOpen === true
      : false;
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
    const log = this.log.operation("fetch");
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
    log.event("info", "start.started", { app: app.name });
    const portOpen = this.session.book.apps.get(appProbeId(app.name))?.portOpen === true;
    if (portOpen) {
      log.event("info", "start.skipped", { app: app.name, reason: "port-open" });
      return;
    }
    const settings = readWorkspaceSettings();
    const scriptKey = resolveStartScript(
      {
        "mf-dashboard.scripts.start": settings.startScript,
        "mf-dashboard.apps": settings.apps,
      },
      app.name,
    );
    const cwd = app.folder;
    const invocation = startInvocation({
      packageManager: resolvePackageManager(workspaceRootFor(app.folder), settings.packageManager),
      scriptKey,
      scriptBody: lookupScript(readScripts(cwd), scriptKey),
      cwd,
      portOpen,
    });
    if (!invocation) {
      log.event("warn", "start.skipped", { app: app.name, reason: "script-missing" });
      this.session.noteScriptMissing(app.name);
      return;
    }
    this.session.clearScriptMissing(app.name);
    try {
      const terminal = vscode.window.createTerminal({
        name: `MF ${app.name}`,
        cwd: invocation.cwd,
      });
      terminal.sendText(`${invocation.command} ${invocation.args.join(" ")}`);
      if (settings.terminalReveal) terminal.show();
      log.event("info", "start.completed", { app: app.name, result: "terminal-command-sent" });
    } catch (error) {
      log.event("error", "start.failed", { app: app.name, ...safeError(error) });
      throw error;
    }
  }

  async openConfig(node?: DashboardNode): Promise<void> {
    const action = this.session.actionFor(node);
    if (!action?.configFile) return;
    await this.showFile(action.configFile);
  }

  async openProducerConfig(node?: DashboardNode): Promise<void> {
    const action = this.session.actionFor(node);
    if (!action?.producerConfigFile) return;
    await this.showFile(action.producerConfigFile);
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
    const started = Date.now();
    log.event("info", "manifest.open.started", { app: node.name, url: action.manifestUrl });
    let response;
    try {
      response = await createLoopbackNet().get(action.manifestUrl);
    } catch (error) {
      log.event("error", "manifest.open.failed", { reason: "network", ...safeError(error) });
      void vscode.window.showErrorMessage(manifestFailureMessage(error));
      return;
    }
    if (!response.ok) {
      log.event("error", "manifest.open.failed", { reason: "http", status: response.status });
      void vscode.window.showErrorMessage(
        manifestFailureMessage(new Error("http"), response.status),
      );
      return;
    }
    try {
      const uri = this.manifests.uri(
        node.name,
        action.manifestUrl,
        manifestPreviewText(response.json, response.body),
      );
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document, { preview: true });
      log.event("info", "manifest.open.completed", {
        app: node.name,
        durationMs: Date.now() - started,
      });
    } catch (error) {
      log.event("error", "manifest.open.failed", { reason: "editor", ...safeError(error) });
      void vscode.window.showErrorMessage("MF dashboard: could not open manifest preview");
    }
  }

  private async showFile(file: string): Promise<void> {
    if (!existsSync(file)) {
      void vscode.window.showErrorMessage("MF dashboard: config file is missing");
      return;
    }
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    await vscode.window.showTextDocument(document, { preview: true });
  }

  rebuild(node?: DashboardNode): Promise<void> {
    return this.run(() => this.rebuildNow(node));
  }

  rebuildAll(
    progress: (name: string, index: number, total: number) => void,
  ): Promise<RebuildAllReport> {
    return this.run(async () => {
      const settings = readWorkspaceSettings();
      const log = this.log.operation("rebuild-all");
      const roots = workspaceRoots();
      const apps: LocalApp[] = [];
      const skipped: RebuildAllReport["skipped"] = [];
      const zipPaths = new Map<string, string>();
      for (const [name, setting] of Object.entries(settings.apps ?? {})) {
        try {
          const [app] = loadKnownApps(
            roots,
            { [name]: setting },
            settings.envMode,
            settings.ignorePaths,
            undefined,
            log,
          );
          if (!app) {
            skipped.push({ app: name, reason: "Could not read the microfrontend config" });
            continue;
          }
          apps.push(app);
          if (typeof setting.typesZipPath === "string")
            zipPaths.set(app.name, setting.typesZipPath);
        } catch (error) {
          skipped.push({ app: name, reason: errorText(error) });
          log.event("warn", "types.rebuild.all.config-failed", { app: name, ...safeError(error) });
        }
      }
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
        for (const link of links)
          if (
            changedProducers.has(link.remoteName) ||
            changedInstalls.has(`${link.consumer}\0${link.alias}`)
          )
            this.typeCache.delete(linkProbeId(link));
        this.clearTypeCache();
        const evidence = await this.prepareEvidence(this.session.loaded, links, this.session.book);
        for (const [name, value] of evidence.producers) this.producerCache.set(name, value);
        for (const [destination, value] of evidence.installed)
          this.installedCache.set(destination, value);
        for (const [name, value] of evidence.errors) this.sourceErrors.set(name, value);
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

  private async rebuildNow(node?: DashboardNode): Promise<void> {
    if (!node) return;
    const rootName = node.name;
    const log = this.log.operation("rebuild");
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
      this.session.noteRebuildError(rootName, errorText(error));
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
      rows.push(directoryStamp(typesRoot(app.folder, app.typesFolder)));
      if (this.session.structure === "flat") continue;
      for (const remote of app.remotes)
        rows.push(directoryStamp(linkTypes(app.folder, remote.alias, app.typesFolder)));
    }
    return rows.join("\n");
  }

  private cachedTypes(link: RemoteLink): ReturnType<typeof describeLink> {
    const consumer = this.session.loaded.find((app) => app.name === link.consumer);
    if (consumer?.consumeTypes === false) return "none";
    const cached = this.typeSnapshot(link);
    if (cached) return cached.status;
    if (!this.canCheckTypes(link) || this.typesPreparing) return "unchecked";
    const status = this.observe(link);
    this.typeCache.set(linkProbeId(link), {
      status,
      checkedAt: Date.now(),
      signature: this.typeSignature(link),
    });
    return status;
  }

  private typeSignature(link: RemoteLink): string {
    const consumer = this.session.loaded.find((app) => app.name === link.consumer);
    const producer = this.session.loaded.find((app) => app.name === link.remoteName);
    return JSON.stringify([
      consumer?.folder,
      consumer?.configFile,
      consumer?.consumeTypes,
      consumer?.typesFolder,
      producer?.folder,
      producer?.configFile,
      producer?.port,
      producer?.manifestPath,
      producer?.generateTypes,
      producer?.tsconfig,
      producer?.typesFolder,
    ]);
  }

  private typeSnapshot(link: RemoteLink) {
    const id = linkProbeId(link);
    const cached = this.typeCache.get(id);
    if (cached && cached.signature !== this.typeSignature(link)) {
      this.typeCache.delete(id);
      return undefined;
    }
    return cached;
  }

  private clearTypeCache(resetTypes = this.canCheckTypes()): void {
    if (resetTypes) {
      if (this.explicitTypeCheck && this.requestedTypeLinks)
        for (const key of this.requestedTypeLinks) this.typeCache.delete(key);
      else this.typeCache.clear();
    }
    this.producerCache.clear();
    this.installedCache.clear();
    this.sourceErrors.clear();
    this.view = null;
  }

  private async prepareEvidence(
    apps: readonly LocalApp[],
    links: readonly RemoteLink[],
    book: import("../../entities/microfrontend/index.ts").ProbeBook,
    installed = new Map<string, InstalledEvidence>(),
  ) {
    const producers = new Map<string, ProducerSnapshot>();
    const errors = new Map<string, unknown>();
    const byName = new Map(apps.map((app) => [app.name, app]));
    for (const link of links) {
      if (!this.canCheckTypes(link)) continue;
      const consumer = byName.get(link.consumer);
      if (!consumer?.consumeTypes) continue;
      const producer = byName.get(link.remoteName);
      if (!producer || producer.port == null) continue;
      if (producer.generateTypes && !producers.has(producer.name) && !errors.has(producer.name)) {
        try {
          producers.set(
            producer.name,
            await collectProducerEvidenceAsync(
              producer,
              apps,
              book,
              this.confirmations,
              this.observationLog,
            ),
          );
        } catch (error) {
          errors.set(producer.name, error);
        }
      }
      let destination: string;
      try {
        destination = path.resolve(
          refetchTarget(consumer.folder, link.alias, consumer.typesFolder),
        );
      } catch {
        continue;
      }
      if (!installed.has(destination)) {
        try {
          installed.set(
            destination,
            await readInstalledEvidenceAsync(destination, this.observationLog),
          );
        } catch {
          installed.set(destination, { folderExists: true, filesFingerprint: "" });
        }
      }
    }
    return { producers, installed, errors };
  }

  private refreshLocalEvidence(name: string): Promise<void> {
    this.dirtySaves.add(name);
    const existing = this.saveChecks.get(name);
    if (existing) return existing;
    const check = this.run(async () => {
      while (this.dirtySaves.delete(name)) {
        if (this.disposed || !readWorkspaceSettings().typesAutoCheck) return;
        const links = linksOf(this.session.loaded).filter((link) => link.remoteName === name);
        const evidence = await this.prepareEvidence(this.session.loaded, links, this.session.book);
        if (this.disposed || !readWorkspaceSettings().typesAutoCheck) return;
        for (const link of links) this.typeCache.delete(linkProbeId(link));
        this.producerCache.delete(name);
        this.sourceErrors.delete(name);
        for (const [key, value] of evidence.producers) this.producerCache.set(key, value);
        for (const [key, value] of evidence.installed) this.installedCache.set(key, value);
        for (const [key, value] of evidence.errors) this.sourceErrors.set(key, value);
        this.notify();
      }
    }).finally(() => {
      if (this.saveChecks.get(name) === check) this.saveChecks.delete(name);
    });
    this.saveChecks.set(name, check);
    return check;
  }

  private warnOnce(
    key: string,
    event: string,
    fields: import("../../shared/logging.ts").LogFields,
  ): void {
    if (this.warnings.has(key)) return;
    this.warnings.add(key);
    this.observationLog.event("warn", event, fields);
  }

  private observe(link: RemoteLink): ReturnType<typeof describeLink> {
    const consumer = this.session.loaded.find((app) => app.name === link.consumer);
    const producer = this.session.loaded.find(
      (app) => app.name === link.remoteName && app.port != null,
    );
    if (!consumer) return "unknown";
    const probe = this.session.book.links.get(linkProbeId(link));
    let evidence: ProducerSnapshot | undefined;
    if (producer && producer.generateTypes && consumer.consumeTypes) {
      if (this.sourceErrors.has(producer.name)) {
        this.warnOnce(`${producer.name}\0source`, "types.sources.unreadable", {
          producer: producer.name,
          ...safeError(this.sourceErrors.get(producer.name)),
        });
        return "unknown";
      }
      evidence = this.producerCache.get(producer.name);
      if (!evidence) {
        try {
          evidence = collectProducerEvidence(
            producer,
            this.session.loaded,
            this.session.book,
            this.confirmations,
            this.observationLog,
          );
          this.warnings.delete(`${producer.name}\0source`);
        } catch (error) {
          this.warnOnce(`${producer.name}\0source`, "types.sources.unreadable", {
            producer: producer.name,
            ...safeError(error),
          });
          return "unknown";
        }
        this.producerCache.set(producer.name, evidence);
      }
    }
    let destination: string | null = null;
    if (consumer.consumeTypes) {
      try {
        destination = refetchTarget(consumer.folder, link.alias, consumer.typesFolder);
        this.warnings.delete(`${consumer.name}\0${link.alias}\0path`);
      } catch (error) {
        this.warnOnce(`${consumer.name}\0${link.alias}\0path`, "types.path.invalid", {
          consumer: consumer.name,
          alias: link.alias,
          ...safeError(error),
        });
      }
    }
    let installed: InstalledEvidence;
    try {
      installed =
        (destination && this.installedCache.get(path.resolve(destination))) ||
        readInstalledEvidence(destination, this.observationLog);
      if (installed.filesFingerprint === "")
        this.warnOnce(`${consumer.name}\0${link.alias}\0read`, "types.installed.unreadable", {
          consumer: consumer.name,
          alias: link.alias,
        });
      if (installed.filesFingerprint !== "")
        this.warnings.delete(`${consumer.name}\0${link.alias}\0read`);
    } catch (error) {
      this.warnOnce(`${consumer.name}\0${link.alias}\0read`, "types.installed.unreadable", {
        consumer: consumer.name,
        alias: link.alias,
        ...safeError(error),
      });
      installed = { folderExists: true, filesFingerprint: "" };
    }
    const check = this.installChecks.get(linkProbeId(link));
    const archiveMatches =
      check?.zipHash === probe?.zipHash &&
      check?.url === link.url &&
      check?.filesFingerprint === installed.filesFingerprint
        ? check?.matches
        : undefined;
    return describeLink(
      {
        consumeTypes: consumer.consumeTypes,
        producer: producer
          ? {
              generateTypes: producer.generateTypes,
              sourceSavedAt: evidence?.sourceSavedAt ?? null,
            }
          : null,
        producerZipMtime: evidence?.zipMtime ?? null,
        linkZipHash: probe?.zipHash ?? null,
        linkZipReachable: probe?.zipUrl != null && probe.zipHash != null,
        linkUrl: link.url,
        generationConfirmed: evidence?.generationConfirmed ?? false,
        installConfirmation: this.confirmations.install(link),
        archiveMatches,
        checkedAt: Date.now(),
        typesSettleMs: readWorkspaceSettings().typesSettleMs,
        installed,
      },
      {
        operation: (source) => this.observationLog.operation(source),
        event: (level, event, fields) =>
          this.observationLog.event(level, event, () => ({
            consumer: link.consumer,
            alias: link.alias,
            remote: link.remoteName,
            ...(typeof fields === "function" ? fields() : fields),
          })),
      },
    );
  }
}

function typesRoot(folder: string, typesFolder: string): string | null {
  try {
    return typesRootTarget(folder, typesFolder);
  } catch {
    return null;
  }
}

function linkTypes(folder: string, alias: string, typesFolder: string): string | null {
  try {
    return refetchTarget(folder, alias, typesFolder);
  } catch {
    return null;
  }
}

function directoryStamp(target: string | null): string {
  if (target == null) return "invalid";
  try {
    return `${target}\0${fs.statSync(target).isDirectory() ? "dir" : "file"}`;
  } catch {
    return `${target}\0missing`;
  }
}

function workspaceRootFor(folder: string): string {
  const resolved = path.resolve(folder);
  return (
    workspaceRoots()
      .map((root) => path.resolve(root.path))
      .filter((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`))
      .sort((left, right) => right.length - left.length)[0] ?? resolved
  );
}

function readScripts(folder: string): Record<string, unknown> {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(folder, "package.json"), "utf8")) as {
      scripts?: unknown;
    };
    if (typeof pkg.scripts === "object" && pkg.scripts !== null && !Array.isArray(pkg.scripts)) {
      return pkg.scripts as Record<string, unknown>;
    }
  } catch {
    return {};
  }
  return {};
}

function parseLinkId(
  linkId: string,
): { consumer: string; alias: string; remoteName: string } | null {
  const [consumer, alias, remoteName] = linkId.split("\0");
  if (!consumer || alias == null || alias === "" || !remoteName) return null;
  return { consumer, alias, remoteName };
}

function errorText(error: unknown): string {
  return error instanceof Error ? String(error) : String(error);
}
