import { readFileSync } from "node:fs";
import * as vscode from "vscode";
import {
  createConfirmationStore,
  scanWorkspace,
  type ConfirmationSnapshot,
} from "../entities/microfrontend/index.ts";
import {
  defaultWorkspaceSettings,
  settingsSeed,
  startupLoad,
} from "../features/init-settings/index.ts";
import { selectTerms, type DashboardTerms } from "../shared/config/index.ts";
import { MfDashboardProvider, type DashboardNode } from "../widgets/mf-dashboard-tree/index.ts";

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
  const bundle = vscode.Uri.joinPath(context.extensionUri, "l10n", "bundle.l10n.ru.json");
  russian = JSON.parse(readFileSync(bundle.fsPath, "utf8")) as Record<string, string>;
  const store = createConfirmationStore(readConfirmations(context));
  const provider = new MfDashboardProvider(
    () => selectedTerms(),
    store,
    () => {
      return context.workspaceState.update(CONFIRMATIONS, store.snapshot());
    },
  );
  context.subscriptions.push(
    provider,
    onDidChangeTerms((next) => provider.relabel(next)),
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (document.uri.scheme !== "file") return;
      void provider
        .fileSaved(document.uri.fsPath)
        .catch((error: unknown) => console.error("MF dashboard save refresh failed", error));
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
      if (
        event.affectsConfiguration("mf-dashboard.apps") ||
        event.affectsConfiguration("mf-dashboard.envMode") ||
        event.affectsConfiguration("mf-dashboard.ignorePaths") ||
        event.affectsConfiguration("mf-dashboard.extraManifestUrls") ||
        event.affectsConfiguration("mf-dashboard.typesSettleMs")
      ) {
        void provider
          .refresh()
          .catch((error: unknown) => console.error("MF dashboard refresh failed", error));
      }
    }),
    vscode.window.registerTreeDataProvider("mf-dashboard", provider),
    vscode.commands.registerCommand("mf-dashboard.refresh", () => provider.refresh()),
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
    vscode.commands.registerCommand("mf-dashboard.refetchTypes", (node?: DashboardNode) => {
      if (!node?.linkId) return false;
      if (!provider.refetch(node.linkId)) return false;
      const linkId = node.linkId;
      return provider.finishRefetch(linkId).finally(() => provider.releaseRefetch(linkId));
    }),
  );
  void openPanel(provider).catch((error: unknown) =>
    vscode.window.showErrorMessage(`MF dashboard: ${String(error)}`),
  );
}

async function openPanel(provider: MfDashboardProvider): Promise<void> {
  try {
    await ensureWorkspaceSettings();
    const inspected = vscode.workspace.getConfiguration("mf-dashboard").inspect("apps");
    const appsDefined =
      inspected != null &&
      (inspected.workspaceFolderValue !== undefined ||
        inspected.workspaceValue !== undefined ||
        inspected.globalValue !== undefined);
    if (startupLoad(appsDefined) === "discover") await provider.discover();
    else await provider.refresh();
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

async function ensureWorkspaceSettings(): Promise<void> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) return;
  const mf = vscode.workspace.getConfiguration("mf-dashboard");
  const ignoreValue = mf.get("ignorePaths");
  const ignorePaths = Array.isArray(ignoreValue)
    ? ignoreValue.filter((item): item is string => typeof item === "string")
    : [];
  const foundNames = folders.flatMap((folder) =>
    Object.keys(
      scanWorkspace(folder.uri.fsPath, {
        envMode: mf.get<string>("envMode") ?? "development",
        ignorePaths,
      }),
    ),
  );
  const config = vscode.workspace.getConfiguration();
  const defined: string[] = [];
  for (const key of Object.keys(defaultWorkspaceSettings("auto"))) {
    const inspected = config.inspect(key);
    if (!inspected) continue;
    if (
      inspected.workspaceFolderValue !== undefined ||
      inspected.workspaceValue !== undefined ||
      inspected.globalValue !== undefined
    )
      defined.push(key);
  }
  const seed = settingsSeed(foundNames, defined);
  for (const [key, value] of Object.entries(seed)) {
    await config.update(key, value, vscode.ConfigurationTarget.Workspace);
  }
}

function readConfirmations(context: vscode.ExtensionContext): ConfirmationSnapshot | undefined {
  const value = context.workspaceState.get<ConfirmationSnapshot>(CONFIRMATIONS);
  if (!value || !Array.isArray(value.installs) || !Array.isArray(value.generations))
    return undefined;
  return value;
}
