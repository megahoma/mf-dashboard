export type ZipEntry = {
  name: string;
  directory: boolean;
  symlink: boolean;
};

export type ZipArchive = {
  entries(): ZipEntry[];
  extractTo(dir: string): void;
};

type AdmZipEntry = {
  entryName: string;
  isDirectory: boolean;
  header?: { attr?: number };
};

export type AdmZipFile = {
  getEntries(): AdmZipEntry[];
  extractAllTo(dir: string, overwrite: boolean): void;
};

export type InstallTypesInput = {
  url: string;
  destination: string;
  appDir: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  expectedZipHash?: string;
  beforeReplace?: () => void;
};

export type InstallTypesResult = {
  zipHash: string;
  filesFingerprint: string;
};

export type ArchiveComparison = InstallTypesResult & {
  matches: boolean;
};
