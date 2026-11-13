import path from "node:path";
import * as vscode from "vscode";
import { extraManifestSettingsFile } from "../../../entities/status/index.ts";
import { readConfiguredApps, WORKSPACE_DEFAULTS } from "../../../features/init-settings/index.ts";
import { logDuration } from "../../../shared/lib/logging.ts";
import { dashboardConfiguration } from "../../../shared/lib/workspace.ts";
import type { LogContext } from "../../../shared/models/logging.ts";
import type { AppSetting, WorkspaceRoot, WorkspaceSettings } from "../models/session-types.ts";

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

export function readWorkspaceSettings(): WorkspaceSettings {
  const config = dashboardConfiguration();
  return {
    apps: readConfiguredApps<AppSetting>(config),
    envMode: config.get<string>("envMode") ?? WORKSPACE_DEFAULTS["mf-dashboard.envMode"],
    ignorePaths: stringList(config.get("ignorePaths")),
    extraManifestUrls: stringList(config.get("extraManifestUrls")),
    structure:
      config.get<string>("structure") === "flat"
        ? "flat"
        : WORKSPACE_DEFAULTS["mf-dashboard.structure"],
    packageManager:
      config.get<string>("packageManager") ?? WORKSPACE_DEFAULTS["mf-dashboard.packageManager"],
    probeIntervalMs: finiteNumber(
      config.get("probeIntervalMs"),
      WORKSPACE_DEFAULTS["mf-dashboard.probeIntervalMs"],
    ),
    typesSettleMs: finiteNumber(
      config.get("typesSettleMs"),
      WORKSPACE_DEFAULTS["mf-dashboard.typesSettleMs"],
    ),
    typesAutoCheck:
      config.get<boolean>("types.autoCheck") ?? WORKSPACE_DEFAULTS["mf-dashboard.types.autoCheck"],
    terminalReveal:
      config.get<boolean>("terminal.reveal") ?? WORKSPACE_DEFAULTS["mf-dashboard.terminal.reveal"],
    startScript:
      config.get<string>("scripts.start") ?? WORKSPACE_DEFAULTS["mf-dashboard.scripts.start"],
    rebuildCommand:
      config.get<string>("commands.rebuildTypes") ??
      WORKSPACE_DEFAULTS["mf-dashboard.commands.rebuildTypes"],
    refetchCommand:
      config.get<string>("commands.refetchTypes") ??
      WORKSPACE_DEFAULTS["mf-dashboard.commands.refetchTypes"],
  };
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

export async function writeWorkspaceApps(
  apps: Record<string, AppSetting>,
  log: LogContext,
): Promise<void> {
  const started = Date.now();
  try {
    await dashboardConfiguration().update("apps", apps, vscode.ConfigurationTarget.Workspace);
  } finally {
    logDuration(log, "settings.write.finished", started, { key: "mf-dashboard.apps" });
  }
}

export function settingsDiagnosticFile(): string | null {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const workspaceFile = vscode.workspace.workspaceFile;
  const inspected = dashboardConfiguration().inspect<unknown>("extraManifestUrls");
  return extraManifestSettingsFile({
    workspaceValueDefined: inspected?.workspaceValue !== undefined,
    workspaceFile: workspaceFile ?? null,
    singleFolderPath: folders.length === 1 ? folders[0].uri.fsPath : null,
  });
}

export function workspaceRoots(): WorkspaceRoot[] {
  return (vscode.workspace.workspaceFolders ?? []).map((folder) => ({
    name: folder.name,
    path: folder.uri.fsPath,
  }));
}

export function workspaceRootFor(folder: string): string {
  const resolved = path.resolve(folder);
  return (
    workspaceRoots()
      .map((root) => path.resolve(root.path))
      .filter((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`))
      .sort((left, right) => right.length - left.length)[0] ?? resolved
  );
}
