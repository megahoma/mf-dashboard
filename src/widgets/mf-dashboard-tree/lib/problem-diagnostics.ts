import * as vscode from "vscode";
import { diagnosticUpdates, type ProblemDraft } from "../../../entities/status/index.ts";

export function problemDiagnostics(previous: readonly string[], drafts: readonly ProblemDraft[]) {
  const byFile = new Map<string, vscode.Diagnostic[]>();
  for (const draft of drafts) {
    const diagnostic = new vscode.Diagnostic(
      new vscode.Range(0, 0, 0, 0),
      draft.message,
      draft.severity === "warning"
        ? vscode.DiagnosticSeverity.Warning
        : vscode.DiagnosticSeverity.Information,
    );
    diagnostic.source = "MF Dashboard";
    const list = byFile.get(draft.file) ?? [];
    list.push(diagnostic);
    byFile.set(draft.file, list);
  }
  const files = [...byFile.keys()];
  const entries = diagnosticUpdates(previous, files).map(
    ({ file, present }): [vscode.Uri, vscode.Diagnostic[] | undefined] => [
      vscode.Uri.file(file),
      present ? byFile.get(file) : undefined,
    ],
  );
  return { files, entries };
}
