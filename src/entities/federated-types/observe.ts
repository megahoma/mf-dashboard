import fs from "node:fs";
import { installedFreshness, sourceFreshness, type InstallConfirmationView } from "./freshness.ts";
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

export function readInstalledEvidence(destination: string | null): InstalledEvidence {
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
    return { folderExists: true, filesFingerprint: treeFingerprint(destination) };
  } catch {
    return { folderExists: true, filesFingerprint: "" };
  }
}

export function describeLink(input: {
  consumeTypes: boolean;
  producer: ProducerEvidence | null;
  producerZipMtime: number | null;
  linkZipHash: string | null;
  linkZipReachable: boolean;
  linkUrl: string | null;
  generationConfirmed: boolean;
  installConfirmation: InstallConfirmationView | null;
  checkedAt: number;
  typesSettleMs: number;
  installed: InstalledEvidence;
}): TypesStatus {
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
  });
  return typesState({
    generateTypes: producer?.generateTypes ?? false,
    consumeTypes: true,
    sourceFreshness: source,
    installedFreshness: installed,
    zipReachable: input.linkZipReachable,
    folderExists: input.installed.folderExists,
    sourceSavedAt: producer?.sourceSavedAt ?? null,
    checkedAt: input.checkedAt,
    typesSettleMs: input.typesSettleMs,
  });
}
