import type { TypesStatus } from "./state-types.ts";

export type ProducerEvidence = {
  generateTypes: boolean;
  sourceSavedAt: number | null;
};

export type InstalledEvidence = {
  folderExists: boolean;
  filesFingerprint: string | null;
};

export type LinkTypeObservation = {
  status: TypesStatus;
  archiveMatch: "matches" | "differs" | "missing" | "unknown";
  sourceFreshness: "fresh" | "stale" | "unknown";
};
