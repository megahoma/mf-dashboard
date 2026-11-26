import { existsSync } from "node:fs";
import * as vscode from "vscode";

export async function showConfigFile(file: string, missingMessage: string): Promise<void> {
  if (!existsSync(file)) {
    void vscode.window.showErrorMessage(missingMessage);
    return;
  }
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  await vscode.window.showTextDocument(document, { preview: true });
}
