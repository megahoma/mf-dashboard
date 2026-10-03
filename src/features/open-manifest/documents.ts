import * as vscode from "vscode";
import { manifestDocumentPath } from "./text.ts";

export const MANIFEST_SCHEME = "mf-dashboard-manifest";

export class ManifestDocuments implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly text = new Map<string, string>();
  private readonly change = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.change.event;

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.text.get(uri.toString()) ?? "";
  }

  uri(name: string, url: string, body: string): vscode.Uri {
    const uri = vscode.Uri.from({
      scheme: MANIFEST_SCHEME,
      path: manifestDocumentPath(name),
      query: url,
    });
    this.text.set(uri.toString(), body);
    this.change.fire(uri);
    return uri;
  }

  dispose(): void {
    this.change.dispose();
  }
}
