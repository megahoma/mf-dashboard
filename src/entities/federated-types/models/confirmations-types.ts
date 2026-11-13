import type { RemoteLink } from "../../microfrontend/models/probe.ts";

export type InstallConfirmation = {
  consumer: string;
  alias: string;
  remoteName: string;
  url: string;
  zipHash: string;
  filesFingerprint: string;
  fromManifest?: boolean;
};

export type GenerationConfirmation = {
  name: string;
  zipHash: string;
  sourceFingerprint: string;
  builtDependencyHashes: Record<string, string>;
  local?: { zipPath: string; inputsFingerprint: string };
};

export type ConfirmationSnapshot = {
  installs: InstallConfirmation[];
  generations: GenerationConfirmation[];
};

export type ConfirmationStore = {
  saveInstall(
    link: RemoteLink,
    filesFingerprint: string,
    zipHash: string,
    fromManifest?: boolean,
  ): void;
  install(link: Pick<RemoteLink, "consumer" | "alias" | "remoteName">): InstallConfirmation | null;
  installedAt(link: Pick<RemoteLink, "consumer" | "alias">): InstallConfirmation | null;
  generation(name: string): GenerationConfirmation | null;
  saveGeneration(
    name: string,
    sourceFingerprint: string,
    zipHash: string,
    builtDependencyHashes: Record<string, string>,
    local?: GenerationConfirmation["local"],
  ): void;
  generationConfirmed(
    name: string,
    sourceFingerprint: string,
    zipHash: string,
    builtDependencyHashes: Record<string, string>,
  ): boolean;
  snapshot(): ConfirmationSnapshot;
};
