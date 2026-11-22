import { readFileSync } from "node:fs";
import * as vscode from "vscode";
import { createConfirmationStore } from "../entities/federated-types/index.ts";
import { readConfiguredApps, WORKSPACE_DEFAULTS } from "../features/init-settings/index.ts";
import { selectTerms, type DashboardTerms } from "../shared/config/index.ts";
import { createLogger, safeError } from "../shared/lib/logging.ts";
import { dashboardConfiguration } from "../shared/lib/workspace.ts";
import {
  DashboardDetails,
  MfDashboardProvider,
  type DashboardNode,
} from "../widgets/mf-dashboard-tree/index.ts";
import { CONFIRMATIONS } from "./config/extension.ts";
import { openPanel } from "./lib/open-panel.ts";
import {
  TYPES_BUILD_VIEW,
  TypesBuildView,
  type TypesBuildSnapshot,
} from "./lib/types-build-view.ts";
import { readConfirmations, setStructure } from "./lib/workspace-settings.ts";

const termsChanged = new vscode.EventEmitter<DashboardTerms>();

let russian: Readonly<Record<string, string>> = {};

export const onDidChangeTerms = termsChanged.event;

function selectedLanguage(): string {
  return (
    dashboardConfiguration().get<string>("language") ?? WORKSPACE_DEFAULTS["mf-dashboard.language"]
  );
}

export function selectedTerms(): DashboardTerms {
  return selectTerms(selectedLanguage(), (message) => vscode.l10n.t(message), russian);
}

function buildTranslator() {
  const language = selectedLanguage();
  return (message: string, ...args: (string | number)[]) => {
    if (language !== "en" && language !== "ru") return vscode.l10n.t(message, ...args);
    const translation = language === "ru" ? (russian[message] ?? message) : message;
    return translation.replace(/\{(\d+)\}/g, (match, index: string) =>
      String(args[Number(index)] ?? match),
    );
  };
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
  const lastBuildKey = "mf-dashboard.lastTypesBuild";
  const typesBuild = new TypesBuildView(
    context.workspaceState.get<TypesBuildSnapshot>(lastBuildKey),
    buildTranslator(),
  );
  let discovering = false;
  let updatingTypes = false;
  let buildEnabled: boolean | undefined;
  const canUpdateTypes = () =>
    !discovering &&
    !updatingTypes &&
    provider.session.hasConfiguredApps &&
    !!vscode.workspace.workspaceFolders?.length &&
    Object.keys(readConfiguredApps(dashboardConfiguration()) ?? {}).length > 0;
  const syncBuildView = () => {
    const enabled = canUpdateTypes();
    if (enabled !== buildEnabled) {
      buildEnabled = enabled;
      void vscode.commands.executeCommand("setContext", "mf-dashboard.canUpdateTypes", enabled);
    }
    const flat = dashboardConfiguration().get<string>("types.structure") === "flat";
    typesBuild.setWorkspace(provider.session.typesApps, flat ? "flat" : "tree");
  };
  async function runBuild(target?: ReturnType<TypesBuildView["targetFor"]>): Promise<void> {
    if (!canUpdateTypes() || !vscode.workspace.isTrusted) return;
    updatingTypes = true;
    syncBuildView();
    void vscode.commands
      .executeCommand(`${TYPES_BUILD_VIEW}.focus`)
      .then(undefined, (error: unknown) =>
        log.event("warn", "types.rebuild.all.view-failed", safeError(error)),
      );
    let failure: string | undefined;
    let started = false;
    try {
      await vscode.window.withProgress(
        {
          location: { viewId: TYPES_BUILD_VIEW },
          title: buildTranslator()("Updating @mf-types"),
        },
        (progress) =>
          provider.rebuildAll(
            (name, index, total) => {
              progress.report({
                message: buildTranslator()("{0} ({1}/{2})", name, index + 1, total),
              });
            },
            (updates) => typesBuild.update(updates),
            target,
            () => {
              started = true;
              typesBuild.start(target);
            },
          ),
      );
    } catch (error) {
      log.event("error", "types.rebuild.all.command-failed", safeError(error));
      failure = String(error);
    } finally {
      try {
        if (started) await context.workspaceState.update(lastBuildKey, typesBuild.finish(failure));
      } catch (error) {
        log.event("warn", "types.rebuild.all.report-save-failed", safeError(error));
      } finally {
        updatingTypes = false;
        syncBuildView();
      }
    }
  }
  syncBuildView();
  context.subscriptions.push(
    provider,
    tree,
    details,
    typesBuild,
    provider.onDidChangeTreeData(syncBuildView),
    vscode.window.createTreeView(TYPES_BUILD_VIEW, { treeDataProvider: typesBuild }),
    vscode.window.registerWebviewViewProvider("mf-dashboard.details", details),
    onDidChangeTerms((next) => {
      provider.relabel(next);
      typesBuild.relabel(buildTranslator());
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (document.uri.scheme !== "file") return;
      void provider
        .fileSaved(document.uri.fsPath)
        .catch((error: unknown) => log.event("error", "save.refresh.failed", safeError(error)));
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      syncBuildView();
      void provider
        .discover()
        .catch((error: unknown) =>
          vscode.window.showErrorMessage(`MF dashboard: ${String(error)}`),
        );
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("mf-dashboard.language")) termsChanged.fire(selectedTerms());
      const appsChanged = event.affectsConfiguration("mf-dashboard.apps");
      if (appsChanged || event.affectsConfiguration("mf-dashboard.types.structure"))
        syncBuildView();
      if (event.affectsConfiguration("mf-dashboard.structure")) {
        const structure = dashboardConfiguration().get<string>("structure");
        provider.setStructure(structure === "flat" ? "flat" : "tree");
      }
      if (event.affectsConfiguration("mf-dashboard.probeIntervalMs")) provider.armProbe();
      const typesAutoCheckChanged = event.affectsConfiguration("mf-dashboard.types.autoCheck");
      if (typesAutoCheckChanged) provider.typesSettingsChanged();
      if (
        appsChanged ||
        event.affectsConfiguration("mf-dashboard.envMode") ||
        event.affectsConfiguration("mf-dashboard.scripts.start") ||
        event.affectsConfiguration("mf-dashboard.ignorePaths") ||
        event.affectsConfiguration("mf-dashboard.extraManifestUrls") ||
        event.affectsConfiguration("mf-dashboard.typesSettleMs") ||
        typesAutoCheckChanged
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
      if (discovering) return;
      discovering = true;
      syncBuildView();
      const title = buildTranslator()("Finding microfrontends…");
      tree.message = title;
      try {
        await vscode.window.withProgress({ location: { viewId: "mf-dashboard" }, title }, () =>
          provider.discover(),
        );
      } finally {
        tree.message = undefined;
        discovering = false;
        syncBuildView();
      }
      if (provider.session.loaded.length === 0)
        await vscode.window.showInformationMessage(selectedTerms().empty);
    }),
    vscode.commands.registerCommand("mf-dashboard.useFlat", () => setStructure("flat")),
    vscode.commands.registerCommand("mf-dashboard.useTree", () => setStructure("tree")),
    vscode.commands.registerCommand("mf-dashboard.typesUseFlat", () =>
      setStructure("flat", "types.structure"),
    ),
    vscode.commands.registerCommand("mf-dashboard.typesUseTree", () =>
      setStructure("tree", "types.structure"),
    ),
    vscode.commands.registerCommand("mf-dashboard.start", (node?: DashboardNode) =>
      provider.start(node),
    ),
    vscode.commands.registerCommand("mf-dashboard.rebuildTypes", (node?: DashboardNode) =>
      provider.rebuild(node),
    ),
    vscode.commands.registerCommand("mf-dashboard.openTypesBuildReport", () =>
      typesBuild.openReport(),
    ),
    vscode.commands.registerCommand("mf-dashboard.rebuildAllTypes", () => runBuild()),
    vscode.commands.registerCommand(
      "mf-dashboard.rebuildAppTypes",
      (row?: Parameters<TypesBuildView["targetFor"]>[0]) => {
        const target = typesBuild.targetFor(row);
        if (target) return runBuild(target);
      },
    ),
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

export function deactivate(): void {}
