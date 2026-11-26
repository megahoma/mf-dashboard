import type {
  InstalledEvidence,
  LinkTypeObservation,
} from "../../../entities/federated-types/index.ts";
import type { ProducerSnapshot } from "../../../features/rebuild-types/index.ts";

export type TypeEvidence = {
  producers: Map<string, ProducerSnapshot>;
  installed: Map<string, InstalledEvidence>;
  errors: Map<string, unknown>;
};

export type TypeSnapshot = {
  observation: LinkTypeObservation;
  checkedAt: number;
  signature: string;
};
