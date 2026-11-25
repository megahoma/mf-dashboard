import type * as vscode from "vscode";
import type { ConfirmationSnapshot } from "../../entities/federated-types/index.ts";
import { CONFIRMATIONS } from "../config/extension.ts";

export function readConfirmations(
  context: vscode.ExtensionContext,
): ConfirmationSnapshot | undefined {
  const value = context.workspaceState.get<ConfirmationSnapshot>(CONFIRMATIONS);
  if (!value || !Array.isArray(value.installs) || !Array.isArray(value.generations))
    return undefined;
  return value;
}
