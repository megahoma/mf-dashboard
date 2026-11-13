import { existsSync } from "node:fs";
import * as vscode from "vscode";

export async function showConfigFile(file: string): Promise<void> {
  if (!existsSync(file)) {
    void vscode.window.showErrorMessage("MF dashboard: config file is missing");
    return;
  }
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  await vscode.window.showTextDocument(document, { preview: true });
}
