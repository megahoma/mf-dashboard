export { describeLink, readInstalledEvidence } from "./lib/observe.ts";
export type { InstalledEvidence, ProducerEvidence } from "./models/observe.ts";
export {
  compareInstalledArchive,
  confirmInstalledArchive,
  createArchiveComparisonBatch,
  installLocalTypesArchive,
  installTypesArchive,
} from "./lib/install.ts";
export { readTree } from "./lib/types-tree.ts";
export type { ArchiveComparison, InstallTypesInput, InstallTypesResult } from "./models/install.ts";
export { installedFreshness, sourceFreshness } from "./lib/freshness.ts";
export type { InstallConfirmationView } from "./models/freshness.ts";
export { sourceContains, sourceIdentity, sourceSnapshot } from "./lib/sources.ts";
export type { SourceFile, SourceIdentity, SourceSnapshot } from "./models/sources.ts";
export { treeFingerprint } from "./lib/tree-fingerprint.ts";
export {
  disposeEvidenceWorker,
  readInstalledEvidenceAsync,
  sourceContainsAsync,
  sourceIdentityAsync,
} from "./lib/evidence-worker-client.mts";
export { typesState } from "./models/state.ts";
export type { TypesStateInput, TypesStatus } from "./models/state-types.ts";
export { createConfirmationStore } from "./models/confirmations.ts";
export type {
  ConfirmationSnapshot,
  ConfirmationStore,
  GenerationConfirmation,
  InstallConfirmation,
} from "./models/confirmations-types.ts";
export { EMPTY_TYPES_FINGERPRINT } from "./config/freshness.ts";
export { resolveTypesPath, typesPathEscape } from "./lib/destination.ts";
