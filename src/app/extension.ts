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
import { createWelcomeView } from "./lib/welcome-view.ts";
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
  const syncProbeMode = () => {
    tree.message =
      dashboardConfiguration().get<number>("probeIntervalMs") === 0
        ? provider.session.terms.manualProbeMessage
        : undefined;
  };
  syncProbeMode();
  const discoveryView = vscode.window.createTreeView<vscode.TreeItem>(DISCOVERY_VIEW, {
    treeDataProvider: { getChildren: () => [], getTreeItem: (item) => item },
  });
  const details = new DashboardDetails(tree, provider);
  const lastBuildKey = "mf-dashboard.lastTypesBuild";
  const previousBuild = context.workspaceState.get<TypesBuildSnapshot>(lastBuildKey);
  let finishTypesLoading: (() => void) | undefined;
  const typesBuild = new TypesBuildView(previousBuild, buildTranslator(), () =>
    finishTypesLoading?.(),
  );
  const typesTree = vscode.window.createTreeView(TYPES_BUILD_VIEW, {
    treeDataProvider: typesBuild,
  });
  typesTree.title = provider.session.terms.typesBuildTitle;
  typesTree.message = provider.session.terms.loadingTypesTree;
  const typesLoaded = new Promise<void>((resolve) => {
    finishTypesLoading = () => {
      finishTypesLoading = undefined;
      typesTree.message = undefined;
      resolve();
    };
  });
  let typesLoadingProgressStarted = false;
  let discovering = false;
  let searching = false;
  let updatingTypes = false;
  let hadApps: boolean | undefined;
  let reportVersion = 0;
  let buildEnabled: boolean | undefined;
  let appsVisible: boolean | undefined;
  let welcomeVisible: boolean | undefined;
  const welcome = createWelcomeView(provider.onDidChangeTreeData, () => {
    const { terms, workspaceGraph } = provider.session;
    const noResults = !!workspaceGraph?.files.length && !workspaceGraph.incomplete;
    return {
      message: noResults ? terms.noMicrofrontends : terms.welcomeMessage,
      label: noResults ? terms.searchAgain : terms.discover,
    };
  });
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
    const showWelcome = !configured && provider.session.extraUrls.length === 0;
    if (showWelcome !== welcomeVisible) {
      welcomeVisible = showWelcome;
      void vscode.commands.executeCommand("setContext", "mf-dashboard.welcomeVisible", showWelcome);
    }
    const visible = configured && !searching;
    if (visible !== appsVisible) {
      appsVisible = visible;
      void vscode.commands.executeCommand("setContext", "mf-dashboard.appsVisible", visible);
    }
    const enabled = visible && canUpdateTypes();
    if (enabled !== buildEnabled) {
      buildEnabled = enabled;
      void vscode.commands.executeCommand("setContext", "mf-dashboard.canUpdateTypes", enabled);
    }
    typesBuild.setWorkspace(
      configured ? provider.session.typesApps : [],
      layout("types.structure"),
    );
  };
  const syncLayout = () => {
    const sort = context.workspaceState.get("mf-dashboard.flatSort") === "port" ? "port" : "name";
    const structure = layout("structure");
    provider.setFlatSort(sort);
    provider.setStructure(structure);
    void vscode.commands.executeCommand(
      "setContext",
      "mf-dashboard.flatSort",
      structure === "flat" ? sort : null,
    );
    void vscode.commands.executeCommand("setContext", "mf-dashboard.flat", structure === "flat");
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
  const updateFlatSort = async (sort: "name" | "port") => {
    if (layout("structure") !== "flat") return;
    await context.workspaceState.update("mf-dashboard.flatSort", sort);
    syncLayout();
  };
  const whenReady =
    <Args extends unknown[], Result>(
      command: (...args: Args) => Result,
      allowWhileProbing: boolean,
    ) =>
    (...args: Args) =>
      (allowWhileProbing ? searching : discovering) ? undefined : command(...args);
  const localizedActions = {
    "mf-dashboard.refresh": () => provider.refresh(),
    "mf-dashboard.discover": runDiscovery,
    "mf-dashboard.useFlat": () => updateLayout("structure", "flat"),
    "mf-dashboard.useTree": () => updateLayout("structure", "tree"),
    "mf-dashboard.sortByName": () => updateFlatSort("name"),
    "mf-dashboard.sortByPort": () => updateFlatSort("port"),
    "mf-dashboard.sortByNameChecked": () => updateFlatSort("name"),
    "mf-dashboard.sortByPortChecked": () => updateFlatSort("port"),
    "mf-dashboard.rebuildAppTypes": (row?: Parameters<TypesBuildView["targetFor"]>[0]) => {
      const target = typesBuild.targetFor(row);
      if (target) return runBuild(target);
    },
    "mf-dashboard.start": (node?: DashboardNode) => provider.start(node),
    "mf-dashboard.rebuildAllTypes": () => runBuild(),
    "mf-dashboard.checkTypes": (node?: DashboardNode) => provider.checkTypes(node),
    "mf-dashboard.rebuildTypes": (node?: DashboardNode) => provider.rebuild(node),
    "mf-dashboard.refetchTypes": (node?: DashboardNode) => {
      if (!node?.linkId || !provider.refetch(node.linkId)) return false;
      const linkId = node.linkId;
      return provider.finishRefetch(linkId).finally(() => provider.releaseRefetch(linkId));
    },
  };
  const readActions = {
    "mf-dashboard.typesUseFlat": () => updateLayout("types.structure", "flat"),
    "mf-dashboard.typesUseTree": () => updateLayout("types.structure", "tree"),
    "mf-dashboard.openTypesBuildReport": () => {
      if (appsVisible) return typesBuild.openReport();
    },
    "mf-dashboard.openConfig": (node?: DashboardNode) => provider.openConfig(node),
    "mf-dashboard.openProducerConfig": (node?: DashboardNode) => provider.openProducerConfig(node),
    "mf-dashboard.revealTypes": (node?: DashboardNode) => provider.revealTypes(node),
    "mf-dashboard.openManifest": (node?: DashboardNode) => provider.openManifest(node),
  };
  for (const [command, action] of Object.entries({ ...localizedActions, ...readActions })) {
    const run = whenReady(action, command in readActions);
    for (const suffix of ["", ".en", ".ru"]) {
      context.subscriptions.push(vscode.commands.registerCommand(`${command}${suffix}`, run));
    }
  }
  for (const suffix of ["", ".en", ".ru"]) {
    context.subscriptions.push(
      vscode.commands.registerCommand(`mf-dashboard.showLogs${suffix}`, () => channel.show()),
    );
  }
  function setSearching(value: boolean): void {
    if (searching === value) return;
    searching = value;
    void vscode.commands.executeCommand("setContext", "mf-dashboard.searching", value);
    provider.setDiscovering(value);
  }
  async function runDiscovery(): Promise<void> {
    if (discovering) return;
    if (!vscode.workspace.workspaceFolders?.length) {
      await vscode.window.showInformationMessage(provider.session.terms.openFolderToDiscover);
      return;
    }
    discovering = true;
    void vscode.commands.executeCommand("setContext", "mf-dashboard.discovering", true);
    const title = provider.session.terms.findingApps;
    discoveryView.message = title;
    setSearching(true);
    try {
      await vscode.window.withProgress({ location: { viewId: DISCOVERY_VIEW }, title }, () =>
        provider.discover(() => setSearching(false)),
      );
    } finally {
      discovering = false;
      setSearching(false);
      void vscode.commands.executeCommand("setContext", "mf-dashboard.discovering", false);
      syncBuildView();
    }
    const { hasConfiguredApps, extraUrls, terms } = provider.session;
    if (!hasConfiguredApps && extraUrls.length > 0)
      void vscode.window.showInformationMessage(terms.noMicrofrontends);
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
    typesTree,
    typesTree.onDidChangeVisibility(({ visible }) => {
      if (!visible || !finishTypesLoading || typesLoadingProgressStarted) return;
      typesLoadingProgressStarted = true;
      void vscode.window
        .withProgress(
          {
            location: { viewId: TYPES_BUILD_VIEW },
            title: provider.session.terms.loadingTypesTree,
          },
          () => typesLoaded,
        )
        .then(undefined, (error: unknown) =>
          log.event("warn", "types.view.progress.failed", safeError(error)),
        );
    }),
    { dispose: () => finishTypesLoading?.() },
    graphWatcher,
    graphWatcher.onDidCreate(reloadGraph),
    graphWatcher.onDidChange(reloadGraph),
    graphWatcher.onDidDelete(reloadGraph),
    provider.onDidChangeTreeData(syncBuildView),
    vscode.window.registerWebviewViewProvider("mf-dashboard.details", details),
    vscode.window.registerWebviewViewProvider("mf-dashboard.details.en", details),
    vscode.window.registerWebviewViewProvider("mf-dashboard.details.ru", details),
    vscode.window.registerWebviewViewProvider("mf-dashboard.welcome", welcome),
    onDidChangeTerms((next) => {
      provider.relabel(next);
      syncProbeMode();
      typesBuild.relabel(buildTranslator());
      typesTree.title = next.typesBuildTitle;
      if (finishTypesLoading) typesTree.message = next.loadingTypesTree;
      if (searching) discoveryView.message = next.findingApps;
      syncBuildView();
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (document.uri.scheme !== "file") return;
      void provider
        .fileSaved(document.uri.fsPath)
        .catch((error: unknown) => log.event("error", "save.refresh.failed", safeError(error)));
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      provider.typesWatcherSettingsChanged();
      reloadGraph();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("files.watcherExclude"))
        provider.typesWatcherSettingsChanged();
      if (event.affectsConfiguration("mf-dashboard.language")) termsChanged.fire(selectedTerms());
      const appsChanged = event.affectsConfiguration("mf-dashboard.apps");
      if (
        event.affectsConfiguration("mf-dashboard.types.structure") ||
        event.affectsConfiguration("mf-dashboard.structure")
      )
        syncLayout();
      const intervalChanged = event.affectsConfiguration("mf-dashboard.probeIntervalMs");
      if (intervalChanged) {
        provider.armProbe();
        syncProbeMode();
      }
      const typesAutoCheckChanged = event.affectsConfiguration("mf-dashboard.types.autoCheck");
      if (intervalChanged || typesAutoCheckChanged) provider.typesSettingsChanged();
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
  );
  void openPanel(provider, log).catch((error: unknown) => {
    log.event("error", "startup.failed", safeError(error));
    void vscode.window.showErrorMessage(
      buildTranslator()("MF Dashboard could not start: {0}", String(error)),
    );
  });
}

export function deactivate(): void {}
