import {
  collectProducerEvidence,
  type ProducerSnapshot,
} from "../../features/rebuild-types/evidence.ts";
import fs, { existsSync } from "node:fs";
import path from "node:path";
import * as vscode from "vscode";
import type { DashboardTerms } from "../../shared/config/index.ts";
import { icons } from "../../shared/config/index.ts";
import { createSerialQueue } from "../../shared/queue.ts";
import { installRemoteTypes } from "../../features/refetch-types/remote.ts";
import { rebuildTypes } from "../../features/rebuild-types/workflow.ts";
import {
  appProbeId,
  createProbeBook,
  linkProbeId,
  scanWorkspace,
  type RemoteLink,
} from "../../entities/microfrontend/index.ts";
import { diagnosticUpdates, extraManifestSettingsFile } from "../../entities/status/index.ts";
import {
  createConfirmationStore,
  type ConfirmationStore,
  describeLink,
  readInstalledEvidence,
  sourceContains,
} from "../../entities/federated-types/index.ts";
import { resolveStartScript } from "../../features/init-settings/index.ts";
import { refetchTarget } from "../../features/refetch-types/index.ts";
import { MANIFEST_SCHEME, ManifestDocuments } from "../../features/open-manifest/documents.ts";
import { manifestFailureMessage, manifestPreviewText } from "../../features/open-manifest/text.ts";
import {
  lookupScript,
  resolvePackageManager,
  startInvocation,
} from "../../features/start-app/index.ts";
import {
  linkRowId,
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
  private readonly typeCache = new Map<string, ReturnType<typeof describeLink>>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private disposed = false;
  private readonly manifests = new ManifestDocuments();
  private readonly manifestRegistration: vscode.Disposable;

  constructor(
    termsOf: () => DashboardTerms,
    confirmations: ConfirmationStore = createConfirmationStore(),
    persistConfirmations: () => void | PromiseLike<void> = () => {},
  ) {
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
        probe: (target, input) => probeWorkspace(target, input),
        roots: workspaceRoots,
      },
      book,
      () => {
        this.notify();
      },
    );
    this.session.terms = termsOf();
    this.session.typesForLink = (link) => this.cachedTypes(link);
    this.session.beforeRefreshChange = () => {
      this.clearTypeCache();
    };
    this.session.onRefreshFailed = () => {
      this.clearTypeCache();
    };
    this.manifestRegistration = vscode.workspace.registerTextDocumentContentProvider(
      MANIFEST_SCHEME,
      this.manifests,
    );
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    for (const timer of this.saveTimers.values()) clearTimeout(timer);
    this.saveTimers.clear();
    this.manifestRegistration.dispose();
    this.manifests.dispose();
    this.diagnostics.dispose();
    this.change.dispose();
  }

  private notify(): void {
    if (this.disposed) return;
    if (!this.session.probeRunning) this.publishProblems();
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
      void this.refresh()
        .catch((error: unknown) => console.error("MF dashboard probe failed", error))
        .finally(() => this.armProbe());
    }, ms);
  }

  refresh(): Promise<void> {
    return this.run(() => this.reload());
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
        await this.refresh();
        return;
      }
      if (kind !== "source") continue;
      const included = sourceContains(app.folder, app.tsconfig, app.typesFolder, file);
      if (!included) continue;
      this.clearTypeCache();
      this.notify();
      const previous = this.saveTimers.get(app.name);
      if (previous) clearTimeout(previous);
      const timer = setTimeout(() => {
        this.saveTimers.delete(app.name);
        if (this.disposed) return;
        this.clearTypeCache();
        this.notify();
      }, settings.typesSettleMs);
      this.saveTimers.set(app.name, timer);
    }
  }

  private async reload(): Promise<void> {
    await this.session.refresh();
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
    try {
      const installed = await installRemoteTypes(
        consumer,
        remote,
        remote.url,
        settings.refetchCommand,
      );
      this.confirmations.saveInstall(link, installed.filesFingerprint, installed.zipHash);
      await this.persistConfirmations();
      this.clearTypeCache();
    } catch {
      this.session.failRefetch(linkId);
      return;
    }
    await this.reload();
  }

  async start(node?: DashboardNode): Promise<void> {
    if (!node) return;
    const app = this.session.loaded.find((item) => item.name === node.name);
    if (!app) return;
    const portOpen = this.session.book.apps.get(appProbeId(app.name))?.portOpen === true;
    if (portOpen) return;
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
      this.session.noteScriptMissing(app.name);
      return;
    }
    this.session.clearScriptMissing(app.name);
    const terminal = vscode.window.createTerminal({ name: `MF ${app.name}`, cwd: invocation.cwd });
    terminal.sendText(`${invocation.command} ${invocation.args.join(" ")}`);
    if (settings.terminalReveal) terminal.show();
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
    let response;
    try {
      response = await createLoopbackNet().get(action.manifestUrl);
    } catch (error) {
      void vscode.window.showErrorMessage(manifestFailureMessage(error));
      return;
    }
    if (!response.ok) {
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
    } catch {
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

  private async rebuildNow(node?: DashboardNode): Promise<void> {
    if (!node) return;
    const rootName = node.name;
    const settings = readWorkspaceSettings();
    try {
      await rebuildTypes(rootName, {
        apps: this.session.loaded,
        book: this.session.book,
        confirmations: this.confirmations,
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
    } catch (error) {
      this.session.noteRebuildError(rootName, errorText(error));
      return;
    }
    await this.reload();
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
    item.tooltip = row.tooltip;
    item.contextValue = row.contextValue;
    item.iconPath = new vscode.ThemeIcon(icons[row.kind]);
    return item;
  }

  getChildren(element?: DashboardNode): DashboardNode[] {
    if (!element) return this.session.nodes();
    return element.children;
  }

  private cachedTypes(link: RemoteLink): ReturnType<typeof describeLink> {
    const id = linkRowId(link);
    const cached = this.typeCache.get(id);
    if (cached) return cached;
    const status = this.observe(link);
    this.typeCache.set(id, status);
    return status;
  }

  private clearTypeCache(): void {
    this.typeCache.clear();
    this.producerCache.clear();
  }

  private observe(link: RemoteLink): ReturnType<typeof describeLink> {
    const consumer = this.session.loaded.find((app) => app.name === link.consumer);
    const producer = this.session.loaded.find(
      (app) => app.name === link.remoteName && app.port != null,
    );
    if (!consumer) return "unknown";
    const probe = this.session.book.links.get(linkProbeId(link));
    let evidence: ProducerSnapshot | undefined;
    if (producer && consumer.consumeTypes) {
      evidence = this.producerCache.get(producer.name);
      if (!evidence) {
        evidence = collectProducerEvidence(
          producer,
          this.session.loaded,
          this.session.book,
          this.confirmations,
        );
        this.producerCache.set(producer.name, evidence);
      }
    }
    let destination: string | null = null;
    if (consumer.consumeTypes) {
      try {
        destination = refetchTarget(consumer.folder, link.alias, consumer.typesFolder);
      } catch {
        /* Invalid targets carry no installed evidence. */
      }
    }
    return describeLink({
      consumeTypes: consumer.consumeTypes,
      producer: producer
        ? { generateTypes: producer.generateTypes, sourceSavedAt: evidence?.sourceSavedAt ?? null }
        : null,
      producerZipMtime: evidence?.zipMtime ?? null,
      linkZipHash: probe?.zipHash ?? null,
      linkZipReachable: probe?.zipUrl != null && probe.zipHash != null,
      linkUrl: link.url,
      generationConfirmed: evidence?.generationConfirmed ?? false,
      installConfirmation: this.confirmations.install(link),
      checkedAt: Date.now(),
      typesSettleMs: readWorkspaceSettings().typesSettleMs,
      installed: readInstalledEvidence(destination),
    });
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
