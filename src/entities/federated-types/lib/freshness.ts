import { EMPTY_TYPES_FINGERPRINT } from "../config/freshness.ts";
import type { InstallConfirmationView } from "../models/freshness.ts";

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

// A content comparison takes priority over an older install confirmation.
export function installedFreshness(input: {
  folderExists: boolean;
  zipHash: string | null;
  filesFingerprint: string | null;
  url: string | null;
  confirmation: InstallConfirmationView | null;
  archiveMatches?: boolean;
}): "fresh" | "stale" | "unknown" {
  if (!input.folderExists || input.filesFingerprint === EMPTY_TYPES_FINGERPRINT) return "stale";
  if (!input.filesFingerprint) return "unknown";
  if (input.archiveMatches !== undefined) return input.archiveMatches ? "fresh" : "stale";
  if (
    input.confirmation != null &&
    (input.confirmation.filesFingerprint !== input.filesFingerprint ||
      (input.url != null && input.confirmation.url !== input.url))
  )
    return "stale";
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
