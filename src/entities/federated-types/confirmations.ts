import type { RemoteLink } from "../microfrontend/probe.ts";

export interface InstallConfirmation {
  consumer: string;
  alias: string;
  remoteName: string;
  url: string;
  zipHash: string;
  filesFingerprint: string;
}

export interface GenerationConfirmation {
  name: string;
  zipHash: string;
  sourceFingerprint: string;
  builtDependencyHashes: Record<string, string>;
}

export interface ConfirmationSnapshot {
  installs: InstallConfirmation[];
  generations: GenerationConfirmation[];
}

export interface ConfirmationStore {
  saveInstall(link: RemoteLink, filesFingerprint: string, zipHash: string): void;
  install(link: Pick<RemoteLink, "consumer" | "alias" | "remoteName">): InstallConfirmation | null;
  generation(name: string): GenerationConfirmation | null;
  saveGeneration(
    name: string,
    sourceFingerprint: string,
    zipHash: string,
    builtDependencyHashes: Record<string, string>,
  ): void;
  generationConfirmed(
    name: string,
    sourceFingerprint: string,
    zipHash: string,
    builtDependencyHashes: Record<string, string>,
  ): boolean;
  snapshot(): ConfirmationSnapshot;
}

export function createConfirmationStore(snapshot?: ConfirmationSnapshot): ConfirmationStore {
  const installs = new Map<string, InstallConfirmation>();
  const generations = new Map<string, GenerationConfirmation>();
  for (const record of snapshot?.installs ?? []) installs.set(edgeKey(record), copyInstall(record));
  for (const record of snapshot?.generations ?? [])
    generations.set(record.name, copyGeneration(record));
  return {
    saveInstall(link, fingerprint, zipHash) {
      if (link.url == null || link.url.trim() === "") return;
      installs.set(edgeKey(link), {
        consumer: link.consumer,
        alias: link.alias,
        remoteName: link.remoteName,
        url: link.url,
        filesFingerprint: fingerprint,
        zipHash,
      });
    },
    install(link) {
      const record = installs.get(edgeKey(link));
      return record ? copyInstall(record) : null;
    },
    generation(name) {
      const record = generations.get(name);
      return record ? copyGeneration(record) : null;
    },
    saveGeneration(name, sourceFingerprint, zipHash, builtDependencyHashes) {
      generations.set(name, {
        name,
        sourceFingerprint,
        zipHash,
        builtDependencyHashes: { ...builtDependencyHashes },
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
        installs: [...installs.values()].map(copyInstall),
        generations: [...generations.values()].map(copyGeneration),
      };
    },
  };
}

function edgeKey(link: { consumer: string; alias: string; remoteName: string }): string {
  return `${link.consumer}\0${link.alias}\0${link.remoteName}`;
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
  return { ...record, builtDependencyHashes: { ...record.builtDependencyHashes } };
}
