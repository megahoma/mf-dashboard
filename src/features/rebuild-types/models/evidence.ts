import type { ChainNode } from "./plan.ts";

export type ProducerSnapshot = ChainNode & {
  sourceFingerprint: string;
  generationConfirmed: boolean;
  dependencyZipHashes: Record<string, string>;
};
