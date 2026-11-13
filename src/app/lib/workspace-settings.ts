import * as vscode from "vscode";
import type { ConfirmationSnapshot } from "../../entities/federated-types/index.ts";
import {
  defaultWorkspaceSettings,
  readConfiguredApps,
  settingsSeed,
} from "../../features/init-settings/index.ts";
import { logDuration } from "../../shared/lib/logging.ts";
import { dashboardConfiguration, isConfigured } from "../../shared/lib/workspace.ts";
import type { LogContext } from "../../shared/models/logging.ts";
import type { MfDashboardProvider } from "../../widgets/mf-dashboard-tree/index.ts";
import { CONFIRMATIONS } from "../config/extension.ts";

export function setStructure(structure: "flat" | "tree"): Thenable<void> {
  return dashboardConfiguration().update(
    "structure",
    structure,
    vscode.ConfigurationTarget.Workspace,
  );
}

export async function ensureWorkspaceSettings(
  session: MfDashboardProvider["session"],
  log: LogContext,
): Promise<void> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) return;
  const mf = dashboardConfiguration();
  const apps = readConfiguredApps(mf);
  const config = vscode.workspace.getConfiguration();
  const keys = Object.keys(defaultWorkspaceSettings());
  const defined = keys.filter((key) => isConfigured(config.inspect(key)));
  if (defined.length === keys.length && apps !== undefined) return;
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

export function readConfirmations(
  context: vscode.ExtensionContext,
): ConfirmationSnapshot | undefined {
  const value = context.workspaceState.get<ConfirmationSnapshot>(CONFIRMATIONS);
  if (!value || !Array.isArray(value.installs) || !Array.isArray(value.generations))
    return undefined;
  return value;
}
