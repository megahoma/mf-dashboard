import * as vscode from "vscode";
import { createLoopbackNet } from "../../../entities/microfrontend/index.ts";
import { safeError } from "../../../shared/lib/logging.ts";
import type { LogContext } from "../../../shared/models/logging.ts";
import type { ManifestDocuments } from "../models/documents.ts";
import { manifestFailureMessage, manifestPreviewText } from "./text.ts";

export async function openManifestPreview(
  manifests: ManifestDocuments,
  name: string,
  url: string,
  log: LogContext,
): Promise<void> {
  const started = Date.now();
  log.event("info", "manifest.open.started", { app: name, url: url });
  let response;
  try {
    response = await createLoopbackNet().get(url);
  } catch (error) {
    log.event("error", "manifest.open.failed", { reason: "network", ...safeError(error) });
    void vscode.window.showErrorMessage(manifestFailureMessage(error));
    return;
  }
  if (!response.ok) {
    log.event("error", "manifest.open.failed", { reason: "http", status: response.status });
    void vscode.window.showErrorMessage(manifestFailureMessage(new Error("http"), response.status));
    return;
  }
  try {
    const uri = manifests.uri(name, url, manifestPreviewText(response.json, response.body));
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: true });
    log.event("info", "manifest.open.completed", {
      app: name,
      durationMs: Date.now() - started,
    });
  } catch (error) {
    log.event("error", "manifest.open.failed", { reason: "editor", ...safeError(error) });
    void vscode.window.showErrorMessage("MF dashboard: could not open manifest preview");
  }
}
