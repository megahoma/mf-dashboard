import path from "node:path";
import {
  createArchiveComparisonBatch,
  readInstalledEvidenceAsync,
  type ConfirmationStore,
  type InstalledEvidence,
} from "../../../entities/federated-types/index.ts";
import {
  appsByName,
  linkProbeId,
  type LocalApp,
  type ProbeBook,
  type RemoteLink,
} from "../../../entities/microfrontend/index.ts";
import { noLog } from "../../../shared/config/logging.ts";
import { logDuration, safeError } from "../../../shared/lib/logging.ts";
import type { LogContext } from "../../../shared/models/logging.ts";
import { refetchTarget } from "../../refetch-types/index.ts";
import type { InstallCheck } from "../models/verify.ts";

export async function verifyTypeInstalls(
  apps: readonly LocalApp[],
  links: readonly RemoteLink[],
  book: ProbeBook,
  confirmations: ConfirmationStore,
  checks: Map<string, InstallCheck>,
  log: LogContext = noLog,
  compare = createArchiveComparisonBatch(log),
  installedEvidence = new Map<string, InstalledEvidence>(),
  readInstalled = readInstalledEvidenceAsync,
  selectedLinks?: ReadonlySet<string>,
): Promise<boolean> {
  const active = new Set(links.map(linkProbeId));
  for (const key of checks.keys()) if (!active.has(key)) checks.delete(key);
  const byName = appsByName(apps);
  let changed = false;
  for (const link of links) {
    if (selectedLinks && !selectedLinks.has(linkProbeId(link))) continue;
    const consumer = byName.get(link.consumer);
    const probe = book.links.get(linkProbeId(link));
    if (!consumer?.consumeTypes) continue;
    const started = Date.now();
    try {
      const destination = refetchTarget(consumer.folder, link.alias, consumer.typesFolder);
      const key = path.resolve(destination);
      const installed = installedEvidence.get(key) ?? (await readInstalled(destination, log));
      installedEvidence.set(key, installed);
      if (!link.url || !probe?.zipHash || !probe.zipUrl) continue;
      if (!installed.folderExists || !installed.filesFingerprint) continue;
      const saved = confirmations.install(link);
      if (
        saved?.zipHash === probe.zipHash &&
        saved.filesFingerprint === installed.filesFingerprint &&
        saved.url === link.url
      ) {
        if (!saved.fromManifest) {
          confirmations.saveInstall(link, installed.filesFingerprint, probe.zipHash, true);
          changed = true;
        }
        checks.delete(linkProbeId(link));
        continue;
      }
      const previous = checks.get(linkProbeId(link));
      if (
        previous?.zipHash === probe.zipHash &&
        previous.filesFingerprint === installed.filesFingerprint &&
        previous.url === link.url
      )
        continue;
      const result = await compare({
        url: probe.zipUrl,
        destination,
        appDir: consumer.folder,
        timeoutMs: 10_000,
        expectedZipHash: probe.zipHash,
      });
      const current = await readInstalled(destination, log, true);
      installedEvidence.set(key, current);
      // The archive or watch output may change while the comparison is running.
      if (
        result.zipHash !== probe.zipHash ||
        result.filesFingerprint !== installed.filesFingerprint ||
        current.filesFingerprint !== result.filesFingerprint
      )
        continue;
      checks.set(linkProbeId(link), { ...result, url: link.url });
      if (result.matches) {
        confirmations.saveInstall(link, result.filesFingerprint, result.zipHash, true);
        changed = true;
      }
      log.event("debug", "types.install.observed", {
        consumer: link.consumer,
        alias: link.alias,
        matches: result.matches,
      });
    } catch (error) {
      log.event("debug", "types.install.check-failed", {
        consumer: link.consumer,
        alias: link.alias,
        ...safeError(error),
      });
    } finally {
      logDuration(log, "types.install.check.finished", started, {
        consumer: link.consumer,
        alias: link.alias,
        zipUrl: probe?.zipUrl,
      });
    }
  }
  return changed;
}
