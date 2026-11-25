import { readFileSync } from "node:fs";
import * as vscode from "vscode";
import { createConfirmationStore } from "../entities/federated-types/index.ts";
import { WORKSPACE_DEFAULTS } from "../features/init-settings/index.ts";
import { selectTerms, type DashboardTerms } from "../shared/config/index.ts";
import { createLogger, safeError } from "../shared/lib/logging.ts";
import { dashboardConfiguration } from "../shared/lib/workspace.ts";
import {
  DashboardDetails,
  MfDashboardProvider,
  type DashboardNode,
} from "../widgets/mf-dashboard-tree/index.ts";
import { CONFIRMATIONS } from "./config/extension.ts";
import { GRAPH_FILE } from "../widgets/mf-dashboard-tree/lib/workspace-graph.ts";
import { openPanel } from "./lib/open-panel.ts";
import {
  TYPES_BUILD_VIEW,
  TypesBuildView,
  type TypesBuildSnapshot,
} from "./lib/types-build-view.ts";
import { readConfirmations } from "./lib/workspace-settings.ts";

const termsChanged = new vscode.EventEmitter<DashboardTerms>();
const DISCOVERY_VIEW = "mf-dashboard.discovery";

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
  type LayoutKey = "structure" | "types.structure";
  const layout = (key: LayoutKey) => {
    const value =
      context.workspaceState.get<string>(`mf-dashboard.${key}`) ??
      dashboardConfiguration().get<string>(key);
    return value === "flat" ? "flat" : "tree";
  };
  const provider = new MfDashboardProvider(
    () => selectedTerms(),
    store,
    () => {
      return context.workspaceState.update(CONFIRMATIONS, store.snapshot());
    },
    log,
    { structure: () => layout("structure") },
  );
  const tree = vscode.window.createTreeView("mf-dashboard", { treeDataProvider: provider });
  const discoveryView = vscode.window.createTreeView<vscode.TreeItem>(DISCOVERY_VIEW, {
    treeDataProvider: { getChildren: () => [], getTreeItem: (item) => item },
  });
  const details = new DashboardDetails(tree, provider);
  const lastBuildKey = "mf-dashboard.lastTypesBuild";
  const previousBuild = context.workspaceState.get<TypesBuildSnapshot>(lastBuildKey);
  const typesBuild = new TypesBuildView(previousBuild, buildTranslator());
  let discovering = false;
  let updatingTypes = false;
  let hadApps: boolean | undefined;
  let reportVersion = 0;
  let buildEnabled: boolean | undefined;
  let typesVisible: boolean | undefined;
  const canUpdateTypes = () => !discovering && !updatingTypes && provider.session.hasConfiguredApps;
  const syncBuildView = () => {
    const configured = provider.session.hasConfiguredApps;
    if (provider.session.workspaceGraph && !configured && hadApps !== false) {
      reportVersion++;
      typesBuild.reset();
      if (hadApps || previousBuild)
        void context.workspaceState
          .update(lastBuildKey, undefined)
          .then(undefined, (error: unknown) =>
            log.event("warn", "types.rebuild.all.report-clear-failed", safeError(error)),
          );
    }
    if (provider.session.workspaceGraph) hadApps = configured;
    const visible = configured && !discovering;
    if (visible !== typesVisible) {
      typesVisible = visible;
      void vscode.commands.executeCommand("setContext", "mf-dashboard.typesVisible", visible);
    }
    const enabled = visible && !updatingTypes;
    if (enabled !== buildEnabled) {
      buildEnabled = enabled;
      void vscode.commands.executeCommand("setContext", "mf-dashboard.canUpdateTypes", enabled);
    }
    typesBuild.setWorkspace(
      configured ? provider.session.typesApps : [],
      layout("types.structure"),
    );
    tree.message = provider.session.graphStale
      ? buildTranslator()(
          "The microfrontend graph is outdated. Run Find microfrontends to update it.",
        )
      : undefined;
  };
  const syncLayout = () => {
    provider.setStructure(layout("structure"));
    void vscode.commands.executeCommand(
      "setContext",
      "mf-dashboard.flat",
      layout("structure") === "flat",
    );
    void vscode.commands.executeCommand(
      "setContext",
      "mf-dashboard.typesFlat",
      layout("types.structure") === "flat",
    );
    syncBuildView();
  };
  const updateLayout = async (key: LayoutKey, value: "flat" | "tree") => {
    await context.workspaceState.update(`mf-dashboard.${key}`, value);
    syncLayout();
  };
  const whenReady =
    <Args extends unknown[], Result>(command: (...args: Args) => Result) =>
    (...args: Args) =>
      discovering ? undefined : command(...args);
  async function runDiscovery(operation: () => Promise<void>): Promise<void> {
    if (discovering) return;
    discovering = true;
    void vscode.commands.executeCommand("setContext", "mf-dashboard.discovering", true);
    const title = buildTranslator()("Finding microfrontends…");
    discoveryView.message = title;
    provider.setDiscovering(true);
    try {
      await vscode.window.withProgress({ location: { viewId: DISCOVERY_VIEW }, title }, operation);
    } finally {
      discovering = false;
      provider.setDiscovering(false);
      void vscode.commands.executeCommand("setContext", "mf-dashboard.discovering", false);
    }
  }
  async function runBuild(target?: ReturnType<TypesBuildView["targetFor"]>): Promise<void> {
    if (!canUpdateTypes() || !vscode.workspace.isTrusted) return;
    updatingTypes = true;
    const version = reportVersion;
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
            (updates) => {
              if (version === reportVersion) typesBuild.update(updates);
            },
            target,
            () => {
              started = true;
              if (version === reportVersion) typesBuild.start(target);
            },
          ),
      );
    } catch (error) {
      log.event("error", "types.rebuild.all.command-failed", safeError(error));
      failure = String(error);
    } finally {
      try {
        if (started && version === reportVersion)
          await context.workspaceState.update(lastBuildKey, typesBuild.finish(failure));
      } catch (error) {
        log.event("warn", "types.rebuild.all.report-save-failed", safeError(error));
      } finally {
        updatingTypes = false;
        syncBuildView();
      }
    }
  }
  syncLayout();
  const graphWatcher = vscode.workspace.createFileSystemWatcher(`**/${GRAPH_FILE}`);
  const reloadGraph = () => {
    void provider
      .refresh("graph")
      .catch((error: unknown) => log.event("error", "graph.refresh.failed", safeError(error)));
  };
  context.subscriptions.push(
    provider,
    tree,
    discoveryView,
    details,
    typesBuild,
    graphWatcher,
    graphWatcher.onDidCreate(reloadGraph),
    graphWatcher.onDidChange(reloadGraph),
    graphWatcher.onDidDelete(reloadGraph),
    provider.onDidChangeTreeData(syncBuildView),
    vscode.window.createTreeView(TYPES_BUILD_VIEW, { treeDataProvider: typesBuild }),
    vscode.window.registerWebviewViewProvider("mf-dashboard.details", details),
    onDidChangeTerms((next) => {
      provider.relabel(next);
      typesBuild.relabel(buildTranslator());
      syncBuildView();
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (document.uri.scheme !== "file") return;
      void provider
        .fileSaved(document.uri.fsPath)
        .catch((error: unknown) => log.event("error", "save.refresh.failed", safeError(error)));
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      reloadGraph();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("mf-dashboard.language")) termsChanged.fire(selectedTerms());
      const appsChanged = event.affectsConfiguration("mf-dashboard.apps");
      if (
        event.affectsConfiguration("mf-dashboard.types.structure") ||
        event.affectsConfiguration("mf-dashboard.structure")
      )
        syncLayout();
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
    vscode.commands.registerCommand(
      "mf-dashboard.refresh",
      whenReady(() => provider.refresh()),
    ),
    vscode.commands.registerCommand(
      "mf-dashboard.checkTypes",
      whenReady((node?: DashboardNode) => provider.checkTypes(node)),
    ),
    vscode.commands.registerCommand("mf-dashboard.discover", async () => {
      if (discovering) return;
      await runDiscovery(() => provider.discover());
      if (provider.session.loaded.length === 0)
        await vscode.window.showInformationMessage(selectedTerms().empty);
    }),
    vscode.commands.registerCommand(
      "mf-dashboard.useFlat",
      whenReady(() => updateLayout("structure", "flat")),
    ),
    vscode.commands.registerCommand(
      "mf-dashboard.useTree",
      whenReady(() => updateLayout("structure", "tree")),
    ),
    vscode.commands.registerCommand(
      "mf-dashboard.typesUseFlat",
      whenReady(() => updateLayout("types.structure", "flat")),
    ),
    vscode.commands.registerCommand(
      "mf-dashboard.typesUseTree",
      whenReady(() => updateLayout("types.structure", "tree")),
    ),
    vscode.commands.registerCommand(
      "mf-dashboard.start",
      whenReady((node?: DashboardNode) => provider.start(node)),
    ),
    vscode.commands.registerCommand(
      "mf-dashboard.rebuildTypes",
      whenReady((node?: DashboardNode) => provider.rebuild(node)),
    ),
    vscode.commands.registerCommand(
      "mf-dashboard.openTypesBuildReport",
      whenReady(() => {
        if (typesVisible) return typesBuild.openReport();
      }),
    ),
    vscode.commands.registerCommand("mf-dashboard.rebuildAllTypes", () => runBuild()),
    vscode.commands.registerCommand(
      "mf-dashboard.rebuildAppTypes",
      (row?: Parameters<TypesBuildView["targetFor"]>[0]) => {
        const target = typesBuild.targetFor(row);
        if (target) return runBuild(target);
      },
    ),
    vscode.commands.registerCommand(
      "mf-dashboard.refetchTypes",
      whenReady((node?: DashboardNode) => {
        if (!node?.linkId) return false;
        if (!provider.refetch(node.linkId)) return false;
        const linkId = node.linkId;
        return provider.finishRefetch(linkId).finally(() => provider.releaseRefetch(linkId));
      }),
    ),
    vscode.commands.registerCommand(
      "mf-dashboard.openConfig",
      whenReady((node?: DashboardNode) => provider.openConfig(node)),
    ),
    vscode.commands.registerCommand(
      "mf-dashboard.openProducerConfig",
      whenReady((node?: DashboardNode) => provider.openProducerConfig(node)),
    ),
    vscode.commands.registerCommand(
      "mf-dashboard.revealTypes",
      whenReady((node?: DashboardNode) => provider.revealTypes(node)),
    ),
    vscode.commands.registerCommand(
      "mf-dashboard.openManifest",
      whenReady((node?: DashboardNode) => provider.openManifest(node)),
    ),
  );
  void openPanel(provider, log).catch((error: unknown) => {
    log.event("error", "startup.failed", safeError(error));
    void vscode.window.showErrorMessage(`MF dashboard: ${String(error)}`);
  });
}

export function deactivate(): void {}
