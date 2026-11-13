import * as vscode from "vscode";
import type { RebuildAllReport } from "../../features/rebuild-types/index.ts";

export async function showRebuildReport(report: RebuildAllReport): Promise<void> {
  const { rebuilt, installed, current, skipped, failed } = report;
  if (!(rebuilt.length || installed.length || current.length || skipped.length || failed.length)) {
    await vscode.window.showInformationMessage(vscode.l10n.t("No federated types to update."));
    return;
  }
  const summary = vscode.l10n.t(
    "@mf-types: {0} rebuilt, {1} installed, {2} current, {3} skipped, {4} failed.",
    rebuilt.length,
    installed.length,
    current.length,
    skipped.length,
    failed.length,
  );
  const show = vscode.l10n.t("Show Report");
  const choice =
    skipped.length || failed.length
      ? await vscode.window.showWarningMessage(summary, show)
      : await vscode.window.showInformationMessage(summary, show);
  if (choice !== show) return;
  const document = await vscode.workspace.openTextDocument({
    language: "plaintext",
    content: [
      summary,
      ...rebuilt.map((name) => vscode.l10n.t("Rebuilt: {0}", name)),
      ...installed.map(({ consumer, alias }) =>
        vscode.l10n.t("Installed: {0} → {1}", consumer, alias),
      ),
      ...current.map((name) => vscode.l10n.t("Current: {0}", name)),
      ...skipped.map(({ app, reason }) => vscode.l10n.t("Skipped {0}: {1}", app, reason)),
      ...failed.map(({ app, reason }) => vscode.l10n.t("Failed {0}: {1}", app, reason)),
    ].join("\n"),
  });
  await vscode.window.showTextDocument(document, { preview: true });
}
