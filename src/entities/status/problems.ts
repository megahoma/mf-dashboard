import path from "node:path";
import type { StatusKind } from "./classify.ts";

export type ProblemSeverity = "warning" | "information";

export interface ProblemDraft {
  file: string;
  message: string;
  severity: ProblemSeverity;
  kind: StatusKind;
}

export function extraManifestSettingsFile(input: {
  workspaceValueDefined: boolean;
  workspaceFile: { scheme: string; fsPath: string } | null;
  singleFolderPath: string | null;
}): string | null {
  if (!input.workspaceValueDefined) return null;
  if (input.workspaceFile)
    return input.workspaceFile.scheme === "file" ? input.workspaceFile.fsPath : null;
  if (input.singleFolderPath) return path.join(input.singleFolderPath, ".vscode", "settings.json");
  return null;
}

export function diagnosticUpdates(
  previous: readonly string[],
  next: readonly string[],
): { file: string; present: boolean }[] {
  const nextFiles = new Set(next);
  const updates: { file: string; present: boolean }[] = [];
  for (const file of next) updates.push({ file, present: true });
  for (const file of previous) {
    if (!nextFiles.has(file)) updates.push({ file, present: false });
  }
  return updates;
}

export function problemSeverity(kind: StatusKind): ProblemSeverity | null {
  if (kind === "invalidUrl" || kind === "otherHost" || kind === "otherPort" || kind === "noAnswer")
    return "warning";
  if (kind === "stale" || kind === "unfetched") return "information";
  return null;
}

export function problemDraft(input: {
  kind: StatusKind;
  surface: "link" | "extra";
  owner: string;
  alias: string | null;
  label: string;
  file: string | null;
}): ProblemDraft | null {
  const severity = problemSeverity(input.kind);
  const file = input.file?.trim() ?? "";
  if (!severity || file === "") return null;
  const message =
    input.surface === "link" && input.alias
      ? `${input.owner} → ${input.alias}: ${input.label}`
      : `${input.owner}: ${input.label}`;
  return { file, message, severity, kind: input.kind };
}
