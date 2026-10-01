import fs from "node:fs";
import path from "node:path";
import * as vscode from "vscode";
import type { DashboardTerms } from "../../shared/config/index.ts";
import { icons } from "../../shared/config/index.ts";
import { createSerialQueue } from "../../shared/queue.ts";
import { fillTemplate, runShell } from "../../shared/shell.ts";
import {
  appProbeId,
  createConfirmationStore,
  createProbeBook,
  filesFingerprint,
  linkProbeId,
  scanWorkspace,
  type ConfirmationStore,
  type LocalApp,
  type RemoteLink,
} from "../../entities/microfrontend/index.ts";
import {
  describeLink,
  sourceFreshness,
  sourceSnapshot,
} from "../../entities/federated-types/index.ts";
import { resolveManifestPath, resolveStartScript } from "../../features/init-settings/index.ts";
import {
  dependencyRefetchCommand,
  refetchInstalled,
  refetchTarget,
} from "../../features/refetch-types/index.ts";
import {
  chainDependencies,
  generateFederatedTypes,
  hashManifestZip,
  manifestZipUrl,
  rebuildPlan,
  type ChainNode,
} from "../../features/rebuild-types/index.ts";
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
import { probeWorkspace } from "./net.ts";

const REBUILD_TIMEOUT_MS = 5 * 60_000;

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
  readonly session: DashboardSession;
  private readonly run = createSerialQueue();
  private readonly termsOf: () => DashboardTerms;
  private readonly confirmations: ConfirmationStore;
  private readonly persistConfirmations: () => void | PromiseLike<void>;
  private readonly typeCache = new Map<string, ReturnType<typeof describeLink>>();
  private readonly publishedZipHashes = new Map<string, string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private disposed = false;

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
        probe: (input) => probeWorkspace(book, input),
        roots: workspaceRoots,
      },
      book,
      () => {
        this.change.fire();
      },
    );
    this.session.terms = termsOf();
    this.session.typesForLink = (link) => this.cachedTypes(link);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    for (const timer of this.saveTimers.values()) clearTimeout(timer);
    this.saveTimers.clear();
    this.change.dispose();
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
      const included = sourceSnapshot(app.folder, app.tsconfig, app.typesFolder).files.some(
        (item) => path.resolve(app.folder, item.name) === path.resolve(file),
      );
      if (!included) continue;
      this.typeCache.clear();
      this.change.fire();
      const previous = this.saveTimers.get(app.name);
      if (previous) clearTimeout(previous);
      const timer = setTimeout(() => {
        this.saveTimers.delete(app.name);
        if (this.disposed) return;
        this.typeCache.clear();
        this.change.fire();
      }, settings.typesSettleMs);
      this.saveTimers.set(app.name, timer);
    }
  }

  private async reload(): Promise<void> {
    this.typeCache.clear();
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
    let zipUrl: string;
    try {
      zipUrl = await manifestZipUrl({
        appDir: consumer.folder,
        hostName: consumer.name,
        remoteName: remote.name,
        alias: remote.alias,
        manifestUrl: remote.url,
      });
    } catch {
      this.session.failRefetch(linkId);
      return;
    }
    try {
      const installed = await refetchInstalled({
        consumerFolder: consumer.folder,
        remoteAlias: remote.alias,
        typesFolder: consumer.typesFolder,
        url: zipUrl,
        command: dependencyRefetchCommand(settings.refetchCommand, {
          folder: consumer.folder,
          name: consumer.name,
          port: consumer.port,
          tsconfig: consumer.tsconfig,
          typesFolder: consumer.typesFolder,
          alias: remote.alias,
        }),
        runCommand: runShell,
      });
      this.confirmations.saveInstall(link, installed.filesFingerprint, installed.zipHash);
      await this.persistConfirmations();
      this.typeCache.clear();
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

  rebuild(node?: DashboardNode): Promise<void> {
    return this.run(() => this.rebuildNow(node));
  }

  private async rebuildNow(node?: DashboardNode): Promise<void> {
    if (!node) return;
    const rootName = node.name;
    const settings = readWorkspaceSettings();
    const local = new Map(
      this.session.loaded.map((app) => [app.name, { generateTypes: app.generateTypes }]),
    );
    const nodes = this.session.loaded
      .filter((app) => app.generateTypes)
      .map((app) => this.chainNode(app, local));
    let plan: { name: string; action: "rebuild" | "skip" }[];
    try {
      plan = rebuildPlan(rootName, nodes);
    } catch (error) {
      this.session.noteRebuildError(rootName, errorText(error));
      return;
    }
    try {
      for (const step of plan) {
        if (step.action === "skip") continue;
        const app = this.session.loaded.find((item) => item.name === step.name);
        if (!app) throw new Error(`missing local node: ${step.name}`);
        await this.installBeforeGenerate(app);
        const zipHash = await this.generateOne(app, settings);
        await this.rememberGeneration(app, zipHash, local);
        this.session.clearRebuildError(app.name);
      }
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

  private observe(link: RemoteLink): ReturnType<typeof describeLink> {
    const consumer = this.session.loaded.find((app) => app.name === link.consumer);
    const producer = this.session.loaded.find(
      (app) => app.name === link.remoteName && app.port != null,
    );
    if (!consumer) return "unknown";
    const settings = readWorkspaceSettings();
    const producerProbe = producer
      ? this.session.book.apps.get(appProbeId(producer.name))
      : undefined;
    const linkProbe = this.session.book.links.get(linkProbeId(link));
    let destination: string | null;
    try {
      destination = refetchTarget(consumer.folder, link.alias, consumer.typesFolder);
    } catch {
      destination = null;
    }
    const dependencyZipHashes: Record<string, string> = {};
    if (producer) {
      for (const name of chainDependencies(producer.remotes, localMap(this.session.loaded))) {
        const hash = this.session.book.apps.get(appProbeId(name))?.zipHash;
        if (hash) dependencyZipHashes[name] = hash;
      }
    }
    const producerEvidence = producer
      ? {
          name: producer.name,
          folder: producer.folder,
          generateTypes: producer.generateTypes,
          tsconfig: producer.tsconfig,
          typesFolder: producer.typesFolder,
        }
      : null;
    const sources = producerEvidence
      ? sourceSnapshot(
          producerEvidence.folder,
          producerEvidence.tsconfig,
          producerEvidence.typesFolder,
        )
      : null;
    const savedInstall = this.confirmations
      .snapshot()
      .installs.find(
        (record) =>
          record.consumer === link.consumer &&
          record.alias === link.alias &&
          record.remoteName === link.remoteName,
      );
    return describeLink({
      consumeTypes: consumer.consumeTypes,
      producer: producerEvidence,
      producerZipMtime: producerProbe?.zipMtime ?? null,
      linkZipHash: linkProbe?.zipHash ?? null,
      linkZipReachable: linkProbe?.zipUrl != null && linkProbe.zipHash != null,
      linkUrl: link.url,
      generationConfirmed:
        producerEvidence != null &&
        sources != null &&
        producerProbe?.zipHash != null &&
        this.confirmations.generationConfirmed(
          producerEvidence.name,
          filesFingerprint(sources.files),
          producerProbe.zipHash,
          dependencyZipHashes,
        ),
      installConfirmation: savedInstall
        ? {
            zipHash: savedInstall.zipHash,
            filesFingerprint: savedInstall.filesFingerprint,
            url: savedInstall.url,
          }
        : null,
      checkedAt: Date.now(),
      typesSettleMs: settings.typesSettleMs,
      destination,
    });
  }

  private chainNode(
    app: LocalApp,
    local: ReadonlyMap<string, { generateTypes: boolean }>,
  ): ChainNode {
    const probe = this.session.book.apps.get(appProbeId(app.name));
    const sources = sourceSnapshot(app.folder, app.tsconfig, app.typesFolder);
    const dependencies = chainDependencies(app.remotes, local);
    const dependencyZipHashes: Record<string, string> = {};
    for (const name of dependencies) {
      const hash = this.session.book.apps.get(appProbeId(name))?.zipHash;
      if (hash) dependencyZipHashes[name] = hash;
    }
    const saved = this.confirmations
      .snapshot()
      .generations.find((record) => record.name === app.name);
    return {
      name: app.name,
      dependencies,
      zipMtime: probe?.zipMtime ?? null,
      sourceSavedAt: sources.savedAt,
      zipReachable: probe?.zipUrl != null && probe.zipHash != null,
      sourceFreshness: sourceFreshness({
        zipMtime: probe?.zipMtime ?? null,
        sourceSavedAt: sources.savedAt,
        generationConfirmed:
          probe?.zipHash != null &&
          this.confirmations.generationConfirmed(
            app.name,
            filesFingerprint(sources.files),
            probe.zipHash,
            dependencyZipHashes,
          ),
      }),
      zipHash: probe?.zipHash ?? null,
      builtDependencyHashes: saved?.builtDependencyHashes,
    };
  }

  private async installBeforeGenerate(app: LocalApp): Promise<void> {
    if (!app.consumeTypes) return;
    for (const remote of app.remotes) {
      const producer = this.session.loaded.find((item) => item.name === remote.name);
      const manifestUrl =
        producer?.generateTypes && producer.port != null
          ? localManifest(producer.port, producer.manifestPath)
          : remote.url;
      if (manifestUrl == null) throw new Error(`unreachable dependency: ${remote.name}`);
      let zipUrl: string;
      try {
        zipUrl = await manifestZipUrl({
          appDir: app.folder,
          hostName: app.name,
          remoteName: remote.name,
          alias: remote.alias,
          manifestUrl,
        });
      } catch {
        throw new Error(`unreachable dependency: ${remote.name}`);
      }
      const installed = await refetchInstalled({
        consumerFolder: app.folder,
        remoteAlias: remote.alias,
        typesFolder: app.typesFolder,
        url: zipUrl,
        command: dependencyRefetchCommand(readWorkspaceSettings().refetchCommand, {
          folder: app.folder,
          name: app.name,
          port: app.port,
          tsconfig: app.tsconfig,
          typesFolder: app.typesFolder,
          alias: remote.alias,
        }),
        runCommand: runShell,
      });
      const link: RemoteLink = {
        consumer: app.name,
        alias: remote.alias,
        remoteName: remote.name,
        url: remote.url ?? manifestUrl,
      };
      this.confirmations.saveInstall(link, installed.filesFingerprint, installed.zipHash);
    }
    await this.persistConfirmations();
  }

  private async generateOne(
    app: LocalApp,
    settings: ReturnType<typeof readWorkspaceSettings>,
  ): Promise<string> {
    const manifestPath = resolveManifestPath(
      {
        "mf-dashboard.scripts.start": settings.startScript,
        "mf-dashboard.apps": settings.apps,
      },
      app.name,
    );
    if (settings.rebuildCommand.trim() !== "") {
      const code = await runShell(
        fillTemplate(settings.rebuildCommand, {
          folder: app.folder,
          name: app.name,
          port: app.port == null ? "" : String(app.port),
          tsconfig: app.tsconfig ?? "",
        }),
        app.folder,
        REBUILD_TIMEOUT_MS,
      );
      if (code !== 0) throw new Error(`rebuild command exited ${code}`);
      if (app.port == null) throw new Error("generated zip is not published by a manifest");
      const published = await hashManifestZip({
        appDir: app.folder,
        hostName: app.name,
        remoteName: app.name,
        alias: app.name,
        manifestUrl: localManifest(app.port, manifestPath),
      });
      this.publishedZipHashes.set(app.name, published.zipHash);
      return published.zipHash;
    }
    const generated = await generateFederatedTypes({
      appDir: app.folder,
      configFile: app.configFile,
      port: app.port,
      manifestPath,
    });
    this.publishedZipHashes.set(app.name, generated.zipHash);
    return generated.zipHash;
  }

  private async rememberGeneration(
    app: LocalApp,
    zipHash: string,
    local: ReadonlyMap<string, { generateTypes: boolean }>,
  ): Promise<void> {
    const sources = sourceSnapshot(app.folder, app.tsconfig, app.typesFolder);
    const builtDependencyHashes: Record<string, string> = {};
    for (const name of chainDependencies(app.remotes, local)) {
      const hash =
        this.publishedZipHashes.get(name) ?? this.session.book.apps.get(appProbeId(name))?.zipHash;
      if (hash) builtDependencyHashes[name] = hash;
    }
    this.confirmations.saveGeneration(
      app.name,
      filesFingerprint(sources.files),
      zipHash,
      builtDependencyHashes,
    );
    await this.persistConfirmations();
  }
}

function localManifest(port: number, manifestPath: string): string {
  const pathName = manifestPath.startsWith("/") ? manifestPath : `/${manifestPath}`;
  return `http://127.0.0.1:${port}${pathName}`;
}

function localMap(apps: readonly LocalApp[]): Map<string, { generateTypes: boolean }> {
  return new Map(apps.map((app) => [app.name, { generateTypes: app.generateTypes }]));
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
