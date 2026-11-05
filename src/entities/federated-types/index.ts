export { describeLink, readInstalledEvidence } from "./observe.ts";
export type { ProducerEvidence, InstalledEvidence } from "./observe.ts";
export {
  compareInstalledArchive,
  createArchiveComparisonBatch,
  confirmInstalledArchive,
  installLocalTypesArchive,
  installTypesArchive,
  readTree,
} from "./install.ts";
export type { ArchiveComparison, InstallTypesInput, InstallTypesResult } from "./install.ts";
export { installedFreshness, sourceFreshness } from "./freshness.ts";
export type { InstallConfirmationView } from "./freshness.ts";
export { sourceSnapshot, sourceContains, sourceIdentity } from "./sources.ts";
export type { SourceFile, SourceSnapshot, SourceIdentity } from "./sources.ts";
export { treeFingerprint } from "./tree-fingerprint.ts";
export {
  sourceIdentityAsync,
  sourceContainsAsync,
  readInstalledEvidenceAsync,
  disposeEvidenceWorker,
} from "./evidence-worker-client.mts";
export { typesState } from "./state.ts";
export type { TypesStateInput, TypesStatus } from "./state.ts";

export { createConfirmationStore } from "./confirmations.ts";
export type {
  ConfirmationStore,
  ConfirmationSnapshot,
  InstallConfirmation,
  GenerationConfirmation,
} from "./confirmations.ts";
