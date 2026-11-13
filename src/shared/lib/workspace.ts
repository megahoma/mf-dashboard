import { workspace, type WorkspaceConfiguration } from "vscode";
import { WORKSPACE_SECTION } from "../config/workspace.ts";

export function dashboardConfiguration(): WorkspaceConfiguration {
  return workspace.getConfiguration(WORKSPACE_SECTION);
}

export function isConfigured(inspected: ReturnType<WorkspaceConfiguration["inspect"]>): boolean {
  return (
    !!inspected &&
    (inspected.workspaceFolderValue !== undefined ||
      inspected.workspaceValue !== undefined ||
      inspected.globalValue !== undefined)
  );
}
