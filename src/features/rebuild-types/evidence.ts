import { noLog, type LogContext } from "../../shared/logging.ts";
import { appProbeId, type LocalApp, type ProbeBook } from "../../entities/microfrontend/index.ts";
import {
  sourceIdentity,
  sourceFreshness,
  type ConfirmationStore,
} from "../../entities/federated-types/index.ts";
import { chainDependencies, type ChainNode } from "./plan.ts";

export interface ProducerSnapshot extends ChainNode {
  sourceFingerprint: string;
  generationConfirmed: boolean;
  dependencyZipHashes: Record<string, string>;
}

export function dependencyEvidence(
  app: LocalApp,
  apps: readonly LocalApp[],
  book: ProbeBook,
  published: ReadonlyMap<string, string> = new Map(),
) {
  const local = new Map(apps.map((item) => [item.name, { generateTypes: item.generateTypes }]));
  const dependencies = chainDependencies(app.remotes, local);
  const dependencyZipHashes: Record<string, string> = Object.create(null);
  for (const name of dependencies) {
    const hash = published.get(name) ?? book.apps.get(appProbeId(name))?.zipHash;
    if (hash) dependencyZipHashes[name] = hash;
  }
  return { dependencies, dependencyZipHashes };
}

export function collectProducerEvidence(
  app: LocalApp,
  apps: readonly LocalApp[],
  book: ProbeBook,
  confirmations: ConfirmationStore,
  log: LogContext = noLog,
): ProducerSnapshot {
  const probe = book.apps.get(appProbeId(app.name));
  const sources = sourceIdentity(app.folder, app.tsconfig, app.typesFolder, log);
  const sourceFingerprint = sources.fingerprint;
  const { dependencies, dependencyZipHashes } = dependencyEvidence(app, apps, book);
  const generationConfirmed =
    probe?.zipHash != null &&
    confirmations.generationConfirmed(
      app.name,
      sourceFingerprint,
      probe.zipHash,
      dependencyZipHashes,
    );
  return {
    name: app.name,
    dependencies,
    dependencyZipHashes,
    sourceFingerprint,
    generationConfirmed,
    zipMtime: probe?.zipMtime ?? null,
    sourceSavedAt: sources.savedAt,
    zipReachable: probe?.zipUrl != null && probe.zipHash != null,
    sourceFreshness: sourceFreshness({
      zipMtime: probe?.zipMtime ?? null,
      sourceSavedAt: sources.savedAt,
      generationConfirmed,
    }),
    zipHash: probe?.zipHash ?? null,
    builtDependencyHashes: confirmations.generation(app.name)?.builtDependencyHashes,
  };
}
