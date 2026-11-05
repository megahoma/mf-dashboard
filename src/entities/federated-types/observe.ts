import { noLog, safeError, type LogContext } from "../../shared/logging.ts";
import fs from "node:fs";
import {
  EMPTY_TYPES_FINGERPRINT,
  installedFreshness,
  sourceFreshness,
  type InstallConfirmationView,
} from "./freshness.ts";
import { treeFingerprint } from "./tree-fingerprint.ts";
import { typesState, type TypesStatus } from "./state.ts";

export interface ProducerEvidence {
  generateTypes: boolean;
  sourceSavedAt: number | null;
}

export interface InstalledEvidence {
  folderExists: boolean;
  filesFingerprint: string | null;
}

export function readInstalledEvidence(
  destination: string | null,
  log: LogContext = noLog,
  fresh = false,
): InstalledEvidence {
  let folderExists: boolean;
  try {
    folderExists = destination != null && fs.statSync(destination).isDirectory();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return { folderExists: false, filesFingerprint: null };
    throw error;
  }
  if (!folderExists || destination == null) return { folderExists: false, filesFingerprint: null };
  try {
    return { folderExists: true, filesFingerprint: treeFingerprint(destination, log, fresh) };
  } catch (error) {
    log.event("debug", "types.installed.read-failed", { path: destination, ...safeError(error) });
    return { folderExists: true, filesFingerprint: "" };
  }
}

export function describeLink(
  input: {
    consumeTypes: boolean;
    producer: ProducerEvidence | null;
    producerZipMtime: number | null;
    linkZipHash: string | null;
    linkZipReachable: boolean;
    linkUrl: string | null;
    generationConfirmed: boolean;
    installConfirmation: InstallConfirmationView | null;
    archiveMatches?: boolean;
    checkedAt: number;
    typesSettleMs: number;
    installed: InstalledEvidence;
  },
  log: LogContext = noLog,
): TypesStatus {
  const producer = input.producer;
  if (!input.consumeTypes) {
    return typesState({
      generateTypes: producer?.generateTypes ?? false,
      consumeTypes: false,
      sourceFreshness: "unknown",
      installedFreshness: "unknown",
      zipReachable: input.linkZipReachable,
      folderExists: false,
      sourceSavedAt: null,
      checkedAt: input.checkedAt,
      typesSettleMs: input.typesSettleMs,
    });
  }
  const source = sourceFreshness({
    zipMtime: input.producerZipMtime,
    sourceSavedAt: producer?.sourceSavedAt ?? null,
    generationConfirmed: input.generationConfirmed,
  });
  const installed = installedFreshness({
    folderExists: input.installed.folderExists,
    zipHash: input.linkZipHash,
    filesFingerprint: input.installed.filesFingerprint,
    url: input.linkUrl,
    confirmation: input.installConfirmation,
    archiveMatches: input.archiveMatches,
  });
  const status = typesState({
    generateTypes: producer?.generateTypes ?? false,
    consumeTypes: true,
    sourceFreshness: source,
    installedFreshness: installed,
    installedChanged:
      !input.linkZipReachable &&
      input.installed.folderExists &&
      !!input.installed.filesFingerprint &&
      input.installed.filesFingerprint !== EMPTY_TYPES_FINGERPRINT &&
      input.installConfirmation != null &&
      input.installConfirmation.url === input.linkUrl &&
      input.installConfirmation.filesFingerprint !== input.installed.filesFingerprint,
    zipReachable: input.linkZipReachable,
    folderExists: input.installed.folderExists,
    sourceSavedAt: producer?.sourceSavedAt ?? null,
    checkedAt: input.checkedAt,
    typesSettleMs: input.typesSettleMs,
  });
  log.event("debug", "types.observed", {
    status,
    sourceFreshness: source,
    installedFreshness: installed,
    generationConfirmed: input.generationConfirmed,
    installConfirmed: installed === "fresh",
    installConfirmationPresent: input.installConfirmation != null,
    zipMatches:
      input.installConfirmation != null && input.installConfirmation.zipHash === input.linkZipHash,
    filesMatch:
      input.installConfirmation != null &&
      input.installConfirmation.filesFingerprint === input.installed.filesFingerprint,
    urlMatches:
      input.installConfirmation != null && input.installConfirmation.url === input.linkUrl,
    folderExists: input.installed.folderExists,
    zipReachable: input.linkZipReachable,
    sourceSavedAt: producer?.sourceSavedAt,
    zipMtime: input.producerZipMtime,
    settleRemainingMs:
      producer?.sourceSavedAt == null
        ? 0
        : Math.max(0, producer.sourceSavedAt + input.typesSettleMs - input.checkedAt),
  });
  return status;
}
