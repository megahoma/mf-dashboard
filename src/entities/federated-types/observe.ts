import fs from "node:fs";
import { filesFingerprint } from "../../shared/fingerprint.ts";
import { installedFreshness, sourceFreshness, type InstallConfirmationView } from "./freshness.ts";
import { readTree } from "./install.ts";
import { sourceSnapshot } from "./sources.ts";
import { typesState, type TypesStatus } from "./state.ts";

export interface ProducerEvidence {
  name: string;
  folder: string;
  generateTypes: boolean;
  tsconfig: string | null;
  typesFolder: string;
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
  destination?: string | null;
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
  const sources = producer
    ? sourceSnapshot(producer.folder, producer.tsconfig, producer.typesFolder)
    : { savedAt: null, files: [] };
  const source = sourceFreshness({
    zipMtime: input.producerZipMtime,
    sourceSavedAt: sources.savedAt,
    generationConfirmed: input.generationConfirmed,
  });
  const destination = input.destination ?? null;
  const folderExists =
    destination != null && fs.existsSync(destination) && fs.statSync(destination).isDirectory();
  let fingerprint: string | null = null;
  if (folderExists && destination != null) {
    try {
      fingerprint = filesFingerprint(readTree(destination));
    } catch {
      fingerprint = "";
    }
  }
  const installed = installedFreshness({
    folderExists,
    zipHash: input.linkZipHash,
    filesFingerprint: fingerprint,
    url: input.linkUrl,
    confirmation: input.installConfirmation,
  });
  return typesState({
    generateTypes: producer?.generateTypes ?? false,
    consumeTypes: true,
    sourceFreshness: source,
    installedFreshness: installed,
    zipReachable: input.linkZipReachable,
    folderExists,
    sourceSavedAt: sources.savedAt,
    checkedAt: input.checkedAt,
    typesSettleMs: input.typesSettleMs,
  });
}
