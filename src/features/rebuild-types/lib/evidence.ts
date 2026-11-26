import {
  publishedArchiveMatchesLocal,
  sourceFreshness,
  sourceIdentity,
  sourceIdentityAsync,
  type ConfirmationStore,
  type GenerationConfirmation,
  type SourceIdentity,
} from "../../../entities/federated-types/index.ts";
import {
  appProbeId,
  indexedApps,
  type ArtifactProbe,
  type LocalApp,
  type ProbeBook,
} from "../../../entities/microfrontend/index.ts";
import { noLog } from "../../../shared/config/logging.ts";
import { safeError } from "../../../shared/lib/logging.ts";
import type { LogContext } from "../../../shared/models/logging.ts";
import type { ProducerSnapshot } from "../models/evidence.ts";
import { chainDependencies } from "./plan.ts";

export function dependencyEvidence(
  app: LocalApp,
  apps: readonly LocalApp[],
  book: ProbeBook,
  published: ReadonlyMap<string, string> = new Map(),
) {
  const dependencies = chainDependencies(app.remotes, indexedApps(apps));
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
  const sources = sourceIdentity(app.folder, app.tsconfig, app.typesFolder, log);
  return producerSnapshot(app, apps, book, confirmations, sources);
}

export async function collectProducerEvidenceAsync(
  app: LocalApp,
  apps: readonly LocalApp[],
  book: ProbeBook,
  confirmations: ConfirmationStore,
  compareZip: ReturnType<typeof createPublishedZipComparison>,
  log: LogContext = noLog,
  allowDownload = true,
  sources?: SourceIdentity,
): Promise<ProducerSnapshot> {
  sources ??= await sourceIdentityAsync(app.folder, app.tsconfig, app.typesFolder, log);
  const snapshot = producerSnapshot(app, apps, book, confirmations, sources);
  if (snapshot.sourceFreshness !== "unknown" || !snapshot.zipReachable) return snapshot;
  const saved = confirmations.generation(app.name);
  if (!saved || saved.sourceFingerprint !== sources.fingerprint) return snapshot;
  const built = Object.entries(saved.builtDependencyHashes);
  if (built.length !== Object.keys(snapshot.dependencyZipHashes).length) return snapshot;
  for (const [name, hash] of built) {
    const observed = snapshot.dependencyZipHashes[name];
    if (observed === hash) continue;
    const dependency = confirmations.generation(name);
    if (!observed || dependency?.zipHash !== hash) return snapshot;
    if (!(await compareZip(dependency, book.apps.get(appProbeId(name)), log, allowDownload)))
      return snapshot;
  }
  if (!(await compareZip(saved, book.apps.get(appProbeId(app.name)), log, allowDownload)))
    return snapshot;
  return { ...snapshot, generationConfirmed: true, sourceFreshness: "fresh" };
}

export function createPublishedZipComparison() {
  const checked = new Map<string, { key: string; result: Promise<boolean> }>();
  return (
    saved: GenerationConfirmation,
    probe: ArtifactProbe | undefined,
    log: LogContext,
    allowDownload = true,
  ): Promise<boolean> => {
    if (!probe?.zipHash) return Promise.resolve(false);
    if (saved.zipHash === probe.zipHash) return Promise.resolve(true);
    if (!saved.local || !probe.zipUrl) return Promise.resolve(false);
    const key = JSON.stringify([saved.local.zipPath, saved.zipHash, probe.zipUrl, probe.zipHash]);
    const previous = checked.get(saved.name);
    if (previous?.key === key) return previous.result;
    if (!allowDownload) return Promise.resolve(false);
    const result = publishedArchiveMatchesLocal(
      { zipPath: saved.local.zipPath, zipHash: saved.zipHash },
      { url: probe.zipUrl, expectedZipHash: probe.zipHash },
      log,
    ).catch((error: unknown) => {
      if (checked.get(saved.name)?.result === result) checked.delete(saved.name);
      log.event("debug", "types.source.zip-comparison-failed", {
        app: saved.name,
        ...safeError(error),
      });
      return false;
    });
    checked.set(saved.name, { key, result });
    return result;
  };
}

function producerSnapshot(
  app: LocalApp,
  apps: readonly LocalApp[],
  book: ProbeBook,
  confirmations: ConfirmationStore,
  sources: SourceIdentity,
): ProducerSnapshot {
  const probe = book.apps.get(appProbeId(app.name));
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
