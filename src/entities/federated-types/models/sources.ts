export type SourceFile = {
  name: string;
  bytes: Uint8Array;
};

export type SourceSnapshot = {
  savedAt: number | null;
  files: SourceFile[];
};

export type SourceIdentity = {
  savedAt: number | null;
  fingerprint: string;
  names: string[];
  tsconfigFingerprint: string;
};

export type SourceEntry = {
  name: string;
  fullPath: string;
  savedAt: number;
  size: number;
};
