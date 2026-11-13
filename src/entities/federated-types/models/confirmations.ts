import type {
  ConfirmationSnapshot,
  ConfirmationStore,
  GenerationConfirmation,
  InstallConfirmation,
} from "./confirmations-types.ts";

export function createConfirmationStore(snapshot?: ConfirmationSnapshot): ConfirmationStore {
  const installs = new Map<string, InstallConfirmation[]>();
  const generations = new Map<string, GenerationConfirmation>();
  for (const record of snapshot?.installs ?? []) {
    // Legacy snapshots can contain a confirmation for each remote behind one alias.
    const key = installKey(record);
    const records = installs.get(key) ?? [];
    records.push(copyInstall(record));
    installs.set(key, records);
  }
  for (const record of snapshot?.generations ?? [])
    generations.set(record.name, copyGeneration(record));
  return {
    saveInstall(link, fingerprint, zipHash, fromManifest) {
      if (link.url == null || link.url.trim() === "") return;
      installs.set(installKey(link), [
        {
          consumer: link.consumer,
          alias: link.alias,
          remoteName: link.remoteName,
          url: link.url,
          filesFingerprint: fingerprint,
          zipHash,
          ...(fromManifest !== undefined && { fromManifest }),
        },
      ]);
    },
    install(link) {
      const record = installs
        .get(installKey(link))
        ?.find((item) => item.remoteName === link.remoteName);
      return record ? copyInstall(record) : null;
    },
    installedAt(link) {
      const record = installs.get(installKey(link))?.[0];
      return record ? copyInstall(record) : null;
    },
    generation(name) {
      const record = generations.get(name);
      return record ? copyGeneration(record) : null;
    },
    saveGeneration(name, sourceFingerprint, zipHash, builtDependencyHashes, local) {
      generations.set(name, {
        name,
        sourceFingerprint,
        zipHash,
        builtDependencyHashes: { ...builtDependencyHashes },
        ...(local && { local: { ...local } }),
      });
    },
    generationConfirmed(name, sourceFingerprint, zipHash, builtDependencyHashes) {
      const record = generations.get(name);
      if (!record) return false;
      return (
        record.zipHash === zipHash &&
        record.sourceFingerprint === sourceFingerprint &&
        sameHashes(record.builtDependencyHashes, builtDependencyHashes)
      );
    },
    snapshot() {
      return {
        installs: [...installs.values()].flatMap((records) => records.map(copyInstall)),
        generations: [...generations.values()].map(copyGeneration),
      };
    },
  };
}

function installKey(link: { consumer: string; alias: string }): string {
  // All remote names behind an alias share this consumer's installed directory.
  return `${link.consumer}\0${link.alias}`;
}

function sameHashes(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key]);
}

function copyInstall(record: InstallConfirmation): InstallConfirmation {
  return { ...record };
}

function copyGeneration(record: GenerationConfirmation): GenerationConfirmation {
  return {
    ...record,
    builtDependencyHashes: { ...record.builtDependencyHashes },
    ...(record.local && { local: { ...record.local } }),
  };
}
