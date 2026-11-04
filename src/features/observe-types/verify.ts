import { noLog, safeError, type LogContext } from "../../shared/logging.ts";
import {
  linkProbeId,
  type LocalApp,
  type ProbeBook,
  type RemoteLink,
} from "../../entities/microfrontend/index.ts";
import {
  compareInstalledArchive,
  readInstalledEvidence,
  type ConfirmationStore,
} from "../../entities/federated-types/index.ts";
import { refetchTarget } from "../refetch-types/refetch.ts";

export interface InstallCheck {
  zipHash: string;
  filesFingerprint: string;
  url: string;
  matches: boolean;
}

export async function verifyTypeInstalls(
  apps: readonly LocalApp[],
  links: readonly RemoteLink[],
  book: ProbeBook,
  confirmations: ConfirmationStore,
  checks: Map<string, InstallCheck>,
  log: LogContext = noLog,
  compare = compareInstalledArchive,
): Promise<boolean> {
  const active = new Set(links.map(linkProbeId));
  for (const key of checks.keys()) if (!active.has(key)) checks.delete(key);
  const byName = new Map(apps.map((app) => [app.name, app]));
  let changed = false;
  for (const link of links) {
    const consumer = byName.get(link.consumer);
    const probe = book.links.get(linkProbeId(link));
    if (!consumer?.consumeTypes || !link.url || !probe?.zipHash || !probe.zipUrl) continue;
    try {
      const destination = refetchTarget(consumer.folder, link.alias, consumer.typesFolder);
      const installed = readInstalledEvidence(destination, log);
      if (!installed.folderExists || !installed.filesFingerprint) continue;
      const saved = confirmations.install(link);
      if (
        saved?.zipHash === probe.zipHash &&
        saved.filesFingerprint === installed.filesFingerprint &&
        saved.url === link.url
      ) {
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
      });
      // The archive or watch output may change while the comparison is running.
      if (
        result.zipHash !== probe.zipHash ||
        result.filesFingerprint !== installed.filesFingerprint ||
        readInstalledEvidence(destination, log).filesFingerprint !== result.filesFingerprint
      )
        continue;
      checks.set(linkProbeId(link), { ...result, url: link.url });
      if (result.matches) {
        confirmations.saveInstall(link, result.filesFingerprint, result.zipHash);
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
    }
  }
  return changed;
}
