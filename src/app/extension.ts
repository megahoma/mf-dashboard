import { createLogger, logDuration, safeError, type LogContext } from "../shared/logging.ts";
import {
  createConfirmationStore,
  type ConfirmationSnapshot,
} from "../entities/federated-types/index.ts";
import { readFileSync } from "node:fs";
import * as vscode from "vscode";
import {
  defaultWorkspaceSettings,
  settingsSeed,
  startupLoad,
} from "../features/init-settings/index.ts";
import type { RebuildAllReport } from "../features/rebuild-types/all.ts";
import { selectTerms, type DashboardTerms } from "../shared/config/index.ts";
import {
  DashboardDetails,
  MfDashboardProvider,
  type DashboardNode,
} from "../widgets/mf-dashboard-tree/index.ts";

const termsChanged = new vscode.EventEmitter<DashboardTerms>();
const CONFIRMATIONS = "mf-dashboard.confirmations";
let russian: Readonly<Record<string, string>> = {};

export const onDidChangeTerms = termsChanged.event;

export function selectedTerms(): DashboardTerms {
  const language =
    vscode.workspace.getConfiguration("mf-dashboard").get<string>("language") ?? "auto";
  return selectTerms(language, (message) => vscode.l10n.t(message), russian);
}

export function activate(context: vscode.ExtensionContext): void {
  const channel = vscode.window.createOutputChannel("MF Dashboard", { log: true });
  context.subscriptions.push(channel);
  const levels = {
    trace: vscode.LogLevel.Trace,
    debug: vscode.LogLevel.Debug,
    info: vscode.LogLevel.Info,
    warn: vscode.LogLevel.Warning,
    error: vscode.LogLevel.Error,
  };
  const log = createLogger({
    enabled: (level) =>
      channel.logLevel !== vscode.LogLevel.Off && channel.logLevel <= levels[level],
    write: (level, message) => channel[level](message),
  });
  log.event("info", "extension.activated", {
    version: context.extension.packageJSON.version as string,
    mode: context.extensionMode,
    workspaces: vscode.workspace.workspaceFolders?.length ?? 0,
  });
  context.subscriptions.push(
    vscode.commands.registerCommand("mf-dashboard.showLogs", () => channel.show()),
  );
  const bundle = vscode.Uri.joinPath(context.extensionUri, "l10n", "bundle.l10n.ru.json");
  russian = JSON.parse(readFileSync(bundle.fsPath, "utf8")) as Record<string, string>;
  const store = createConfirmationStore(readConfirmations(context));
  const provider = new MfDashboardProvider(
    () => selectedTerms(),
    store,
    () => {
      return context.workspaceState.update(CONFIRMATIONS, store.snapshot());
    },
    log,
  );
  const tree = vscode.window.createTreeView("mf-dashboard", { treeDataProvider: provider });
  const details = new DashboardDetails(tree, provider);
  let updatingTypes = false;
  context.subscriptions.push(
    provider,
    tree,
    details,
    vscode.window.registerWebviewViewProvider("mf-dashboard.details", details),
    onDidChangeTerms((next) => provider.relabel(next)),
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (document.uri.scheme !== "file") return;
      void provider
        .fileSaved(document.uri.fsPath)
        .catch((error: unknown) => log.event("error", "save.refresh.failed", safeError(error)));
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void provider
        .discover()
        .catch((error: unknown) =>
          vscode.window.showErrorMessage(`MF dashboard: ${String(error)}`),
        );
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("mf-dashboard.language")) termsChanged.fire(selectedTerms());
      if (event.affectsConfiguration("mf-dashboard.structure")) {
        const structure = vscode.workspace
          .getConfiguration("mf-dashboard")
          .get<string>("structure");
        provider.setStructure(structure === "flat" ? "flat" : "tree");
      }
      if (event.affectsConfiguration("mf-dashboard.probeIntervalMs")) provider.armProbe();
      if (event.affectsConfiguration("mf-dashboard.types.autoCheck"))
        provider.typesSettingsChanged();
      if (
        event.affectsConfiguration("mf-dashboard.apps") ||
        event.affectsConfiguration("mf-dashboard.envMode") ||
        event.affectsConfiguration("mf-dashboard.scripts.start") ||
        event.affectsConfiguration("mf-dashboard.ignorePaths") ||
        event.affectsConfiguration("mf-dashboard.extraManifestUrls") ||
        event.affectsConfiguration("mf-dashboard.typesSettleMs") ||
        event.affectsConfiguration("mf-dashboard.types.autoCheck")
      ) {
        void provider
          .refresh("settings")
          .catch((error: unknown) =>
            log.event("error", "settings.refresh.failed", safeError(error)),
          );
      }
    }),
    vscode.commands.registerCommand("mf-dashboard.refresh", () => provider.refresh()),
    vscode.commands.registerCommand("mf-dashboard.checkTypes", (node?: DashboardNode) =>
      provider.checkTypes(node),
    ),
    vscode.commands.registerCommand("mf-dashboard.discover", async () => {
      await provider.discover();
      if (provider.session.loaded.length === 0)
        await vscode.window.showInformationMessage(selectedTerms().empty);
    }),
    vscode.commands.registerCommand("mf-dashboard.useFlat", () => setStructure("flat")),
    vscode.commands.registerCommand("mf-dashboard.useTree", () => setStructure("tree")),
    vscode.commands.registerCommand("mf-dashboard.start", (node?: DashboardNode) =>
      provider.start(node),
    ),
    vscode.commands.registerCommand("mf-dashboard.rebuildTypes", (node?: DashboardNode) =>
      provider.rebuild(node),
    ),
    vscode.commands.registerCommand("mf-dashboard.rebuildAllTypes", async () => {
      if (updatingTypes || !vscode.workspace.isTrusted) return;
      updatingTypes = true;
      try {
        const report = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: vscode.l10n.t("Updating @mf-types"),
          },
          (progress) =>
            provider.rebuildAll((name, index, total) => {
              progress.report({ message: vscode.l10n.t("{0} ({1}/{2})", name, index + 1, total) });
            }),
        );
        void showRebuildReport(report).catch((error: unknown) => {
          log.event("error", "types.rebuild.all.report-failed", safeError(error));
        });
      } catch (error) {
        log.event("error", "types.rebuild.all.command-failed", safeError(error));
        void vscode.window.showErrorMessage(
          vscode.l10n.t("Could not update @mf-types: {0}", String(error)),
        );
      } finally {
        updatingTypes = false;
      }
    }),
    vscode.commands.registerCommand("mf-dashboard.refetchTypes", (node?: DashboardNode) => {
      if (!node?.linkId) return false;
      if (!provider.refetch(node.linkId)) return false;
      const linkId = node.linkId;
      return provider.finishRefetch(linkId).finally(() => provider.releaseRefetch(linkId));
    }),
    vscode.commands.registerCommand("mf-dashboard.openConfig", (node?: DashboardNode) =>
      provider.openConfig(node),
    ),
    vscode.commands.registerCommand("mf-dashboard.openProducerConfig", (node?: DashboardNode) =>
      provider.openProducerConfig(node),
    ),
    vscode.commands.registerCommand("mf-dashboard.revealTypes", (node?: DashboardNode) =>
      provider.revealTypes(node),
    ),
    vscode.commands.registerCommand("mf-dashboard.openManifest", (node?: DashboardNode) =>
      provider.openManifest(node),
    ),
  );
  void openPanel(provider, log).catch((error: unknown) => {
    log.event("error", "startup.failed", safeError(error));
    void vscode.window.showErrorMessage(`MF dashboard: ${String(error)}`);
  });
}

async function showRebuildReport(report: RebuildAllReport): Promise<void> {
  const { rebuilt, installed, current, skipped, failed } = report;
  if (!(rebuilt.length || installed.length || current.length || skipped.length || failed.length)) {
    await vscode.window.showInformationMessage(vscode.l10n.t("No federated types to update."));
    return;
  }
  const summary = vscode.l10n.t(
    "@mf-types: {0} rebuilt, {1} installed, {2} current, {3} skipped, {4} failed.",
    rebuilt.length,
    installed.length,
    current.length,
    skipped.length,
    failed.length,
  );
  const show = vscode.l10n.t("Show Report");
  const choice =
    skipped.length || failed.length
      ? await vscode.window.showWarningMessage(summary, show)
      : await vscode.window.showInformationMessage(summary, show);
  if (choice !== show) return;
  const document = await vscode.workspace.openTextDocument({
    language: "plaintext",
    content: [
      summary,
      ...rebuilt.map((name) => vscode.l10n.t("Rebuilt: {0}", name)),
      ...installed.map(({ consumer, alias }) =>
        vscode.l10n.t("Installed: {0} → {1}", consumer, alias),
      ),
      ...current.map((name) => vscode.l10n.t("Current: {0}", name)),
      ...skipped.map(({ app, reason }) => vscode.l10n.t("Skipped {0}: {1}", app, reason)),
      ...failed.map(({ app, reason }) => vscode.l10n.t("Failed {0}: {1}", app, reason)),
    ].join("\n"),
  });
  await vscode.window.showTextDocument(document, { preview: true });
}

async function openPanel(provider: MfDashboardProvider, log: LogContext): Promise<void> {
  log = log.operation("startup");
  const started = Date.now();
  log.event("info", "startup.started");
  try {
    await ensureWorkspaceSettings(provider.session, log);
    const inspected = vscode.workspace.getConfiguration("mf-dashboard").inspect("apps");
    const appsDefined =
      inspected != null &&
      (inspected.workspaceFolderValue !== undefined ||
        inspected.workspaceValue !== undefined ||
        inspected.globalValue !== undefined);
    if (startupLoad(appsDefined) === "discover") await provider.discover();
    else await provider.refresh("startup");
    logDuration(log, "startup.completed", started, {}, "info");
  } finally {
    provider.armProbe();
  }
}

export function deactivate(): void {}

function setStructure(structure: "flat" | "tree"): Thenable<void> {
  return vscode.workspace
    .getConfiguration("mf-dashboard")
    .update("structure", structure, vscode.ConfigurationTarget.Workspace);
}

async function ensureWorkspaceSettings(
  session: MfDashboardProvider["session"],
  log: LogContext,
): Promise<void> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) return;
  const mf = vscode.workspace.getConfiguration("mf-dashboard");
  const inspectedApps = mf.inspect<Record<string, unknown>>("apps");
  const rawApps =
    inspectedApps?.workspaceFolderValue ??
    inspectedApps?.workspaceValue ??
    inspectedApps?.globalValue;
  const apps =
    rawApps === undefined
      ? undefined
      : rawApps !== null && typeof rawApps === "object" && !Array.isArray(rawApps)
        ? rawApps
        : {};
  const config = vscode.workspace.getConfiguration();
  const defined: string[] = [];
  for (const key of Object.keys(defaultWorkspaceSettings())) {
    const inspected = config.inspect(key);
    if (!inspected) continue;
    if (
      inspected.workspaceFolderValue !== undefined ||
      inspected.workspaceValue !== undefined ||
      inspected.globalValue !== undefined
    )
      defined.push(key);
  }
  if (defined.length === Object.keys(defaultWorkspaceSettings()).length && apps !== undefined)
    return;
  const foundNames = apps === undefined ? session.prepareDiscovery(log) : Object.keys(apps);
  const seed = settingsSeed(foundNames, defined);
  const started = Date.now();
  for (const [key, value] of Object.entries(seed)) {
    const writeStarted = Date.now();
    try {
      await config.update(key, value, vscode.ConfigurationTarget.Workspace);
    } finally {
      logDuration(log, "settings.write.finished", writeStarted, { key });
    }
  }
  logDuration(log, "settings.seed.completed", started, { keys: Object.keys(seed).length }, "info");
}

function readConfirmations(context: vscode.ExtensionContext): ConfirmationSnapshot | undefined {
  const value = context.workspaceState.get<ConfirmationSnapshot>(CONFIRMATIONS);
  if (!value || !Array.isArray(value.installs) || !Array.isArray(value.generations))
    return undefined;
  return value;
}
