import type { WorkspaceConfiguration } from "vscode";
import { isRecord } from "../../../shared/lib/record.ts";

export function readConfiguredApps<T>(
  config: WorkspaceConfiguration,
): Record<string, T> | undefined {
  const inspected = config.inspect<Record<string, T>>("apps");
  const value =
    inspected?.workspaceFolderValue ?? inspected?.workspaceValue ?? inspected?.globalValue;
  return value === undefined ? undefined : isRecord(value) ? value : {};
}
