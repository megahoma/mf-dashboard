export interface InstallConfirmationView {
  zipHash: string;
  filesFingerprint: string;
  url: string;
}

// A Last-Modified date is the proof. A generation record is used only when that date is missing.
export function sourceFreshness(input: {
  zipMtime: number | null;
  sourceSavedAt: number | null;
  generationConfirmed: boolean;
}): "fresh" | "stale" | "unknown" {
  if (input.zipMtime != null && input.sourceSavedAt != null) {
    return input.sourceSavedAt > input.zipMtime ? "stale" : "fresh";
  }
  if (input.generationConfirmed) return "fresh";
  return "unknown";
}

// Directory mtime is not evidence. A saved hash that no longer matches the link zip is stale.
export function installedFreshness(input: {
  folderExists: boolean;
  zipHash: string | null;
  filesFingerprint: string | null;
  url: string | null;
  confirmation: InstallConfirmationView | null;
}): "fresh" | "stale" | "unknown" {
  if (!input.folderExists) return input.zipHash != null ? "stale" : "unknown";
  if (
    input.confirmation == null ||
    input.zipHash == null ||
    input.filesFingerprint == null ||
    input.url == null
  )
    return "unknown";
  const matches =
    input.confirmation.zipHash === input.zipHash &&
    input.confirmation.filesFingerprint === input.filesFingerprint &&
    input.confirmation.url === input.url;
  return matches ? "fresh" : "stale";
}
